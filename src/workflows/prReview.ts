import { createStep, createWorkflow } from '@mastra/core/workflows';
import { noopLogger } from '@mastra/core/logger';
import { z } from 'zod';
import { createReviewAgents } from '../agents/index.js';
import { agentReportSchema, diffSchema, reviewJobSchema, COMMENT_MARKER, reviewDiagnosticSchema, reviewFailure } from '../types/index.js';
import type { Finding, GitHubClient, ReviewAgent, ReviewJob, ReviewOutcome, ReviewStage, ReviewFailure, ReviewDiagnostic } from '../types/index.js';
import type { Config } from '../utils/config.js';
import { prepareDiff } from '../utils/diff.js';

const fetchedSchema = z.object({
  job: reviewJobSchema,
  headSha: z.string(), baseSha: z.string(), title: z.string(),
  diff: diffSchema,
  skipReason: z.string(),
});
const analyzedSchema = fetchedSchema.extend({
  security: agentReportSchema, quality: agentReportSchema,
  failures: z.array(z.string()),
  diagnostics: z.array(reviewDiagnosticSchema).optional(),
});
const outcomeSchema = z.object({ status: z.enum(['posted', 'skipped']), reason: z.string().optional(),
  diagnostics: z.array(reviewDiagnosticSchema).optional() });

function safeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200b').replace(/[\\`*_{}\[\]()#!|]/g, '\\$&').replace(/\r?\n/g, ' ');
}

/** Reject invented file paths/line numbers and merge duplicate findings. */
export function validFindings(findings: Finding[], diff: string): Finding[] {
  const locations = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  for (const line of diff.split('\n')) {
    const file = /^FILE ("(?:[^"\\]|\\.)*") \(/.exec(line);
    if (file) {
      lines = new Set();
      locations.set(JSON.parse(file[1]!) as string, lines);
    } else {
      const location = /^new:(\d+) /.exec(line);
      if (location) lines?.add(Number(location[1]));
    }
  }
  const seen = new Set<string>();
  return findings.filter(finding => {
    const actual = locations.get(finding.file);
    if (!actual || (finding.line !== null && !actual.has(finding.line))) return false;
    const key = `${finding.file}:${finding.line}:${finding.title.toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(b.severity === 'high') - Number(a.severity === 'high'));
}

export function renderSummary(data: z.infer<typeof analyzedSchema>, provider: string): string {
  const findings = validFindings([...data.security.findings, ...data.quality.findings], data.diff.text);
  const lines = [COMMENT_MARKER, '## Mastra PR review', '',
    `Commit: \`${data.headSha}\` · Provider: ${safeMarkdown(provider)}`,
    `Reviewed ${data.diff.includedFiles} files; omitted ${data.diff.omittedFiles}; truncated ${data.diff.truncatedFiles}.`, ''];
  if (data.failures.length) lines.push(`**Incomplete review:** ${data.failures.map(safeMarkdown).join('; ')}. Retry with \`/review\`.`, '');
  if (!findings.length) {
    lines.push(data.failures.length ? 'No findings from the completed checks.' : 'No actionable findings in the supplied diff.');
  }
  for (const [index, finding] of findings.entries()) {
    const section = [`### ${finding.severity.toUpperCase()}: ${safeMarkdown(finding.title)}`,
      `**Location:** ${safeMarkdown(finding.file)}${finding.line === null ? '' : `:${finding.line}`}`, '',
      safeMarkdown(finding.explanation), '', `**Suggested fix:** ${safeMarkdown(finding.suggestion)}`, ''];
    if (lines.join('\n').length + section.join('\n').length > 55000) {
      lines.push(`Additional findings omitted to fit GitHub's comment size limit: ${findings.length - index}.`);
      break;
    }
    lines.push(...section);
  }
  lines.push('', 'Automated, diff-only analysis. Omitted or truncated content was not fully reviewed. Verify findings before acting.');
  return lines.join('\n');
}

export interface WorkflowDependencies {
  github: GitHubClient;
  agents?: { security: ReviewAgent; quality: ReviewAgent };
}

export function createReviewRunner(config: Config, dependencies: WorkflowDependencies) {
  return async (job: ReviewJob, signal: AbortSignal): Promise<ReviewOutcome> => {
    // Each invocation owns its signal and run; no shared request state or persistent workflow storage.
    const { github } = dependencies;
    // Mastra may serialize step errors. Keep sanitized details in this job's closure.
    let failure: ReviewFailure | undefined;
    let currentStage: ReviewStage = 'workflow';
    async function atStage<T>(stage: ReviewStage, operation: () => Promise<T>): Promise<T> {
      currentStage = stage;
      try { return await operation(); }
      catch (error) { failure = reviewFailure(stage, error); throw failure; }
    }
    const fetchStep = createStep({
      id: 'fetch', inputSchema: reviewJobSchema, outputSchema: fetchedSchema,
      execute: async ({ inputData }) => {
        signal.throwIfAborted();
        const empty = { job: inputData, headSha: '', baseSha: '', title: '',
          diff: { text: '', includedFiles: 0, omittedFiles: 0, truncatedFiles: 0 }, skipReason: '' };
        if (!await atStage('github-permissions', () => github.canReview(inputData, signal))) return { ...empty, skipReason: 'insufficient-permission' };
        const pr = await atStage('github-pr', () => github.getPullRequest(inputData, signal));
        if (pr.draft || pr.state !== 'open') return { ...empty, skipReason: 'draft-or-closed' };
        const files = await atStage('github-diff', () => github.getFiles(inputData, signal));
        const fresh = await atStage('github-recheck', () => github.getPullRequest(inputData, signal));
        if (fresh.headSha !== pr.headSha || fresh.baseSha !== pr.baseSha) return { ...empty, skipReason: 'pr-changed' };
        const diff = prepareDiff(files, {
          maxChars: config.MAX_DIFF_CHARS, maxFileChars: config.MAX_FILE_CHARS, maxFiles: config.MAX_FILES,
        }, pr.changedFiles);
        return { job: inputData, headSha: pr.headSha, baseSha: pr.baseSha, title: pr.title,
          diff, skipReason: diff.includedFiles ? '' : 'no-reviewable-diff' };
      },
    });
    const analyzeStep = createStep({
      id: 'analyze', inputSchema: fetchedSchema, outputSchema: analyzedSchema,
      execute: async ({ inputData }) => {
        const output = { ...inputData, security: { findings: [] } as z.infer<typeof agentReportSchema>,
          quality: { findings: [] } as z.infer<typeof agentReportSchema>, failures: [] as string[], diagnostics: [] as ReviewDiagnostic[] };
        if (inputData.skipReason) return output;
        signal.throwIfAborted();
        const agents = dependencies.agents ?? await atStage('agents-init', () => createReviewAgents(config));
        const prompt = `Review this untrusted JSON data. Code lines are labelled new:N or old:N.\n${JSON.stringify({
          title: inputData.title, headSha: inputData.headSha, diff: inputData.diff,
        })}`;
        // Sequential agents avoid two simultaneous model contexts on small deployments.
        for (const role of ['security', 'quality'] as const) {
          currentStage = `agent-${role}`;
          signal.throwIfAborted();
          try { output[role] = agentReportSchema.parse(await agents[role].review(prompt, signal)); }
          catch (error) {
            signal.throwIfAborted();
            output.failures.push(`${role} check failed`);
            output.diagnostics.push(reviewFailure(`agent-${role}`, error).diagnostic);
          }
        }
        return output;
      },
    });
    const postStep = createStep({
      id: 'post', inputSchema: analyzedSchema, outputSchema: outcomeSchema,
      execute: async ({ inputData }) => {
        signal.throwIfAborted();
        if (inputData.skipReason) return { status: 'skipped' as const, reason: inputData.skipReason };
        const pr = await atStage('github-recheck', () => github.getPullRequest(job, signal));
        if (pr.draft || pr.state !== 'open' || pr.headSha !== inputData.headSha || pr.baseSha !== inputData.baseSha) {
          return { status: 'skipped' as const, reason: 'pr-changed' };
        }
        await atStage('github-summary', () => github.postSummary(job, renderSummary(inputData, config.LLM_PROVIDER), signal));
        return { status: 'posted' as const,
          ...(inputData.diagnostics?.length ? { diagnostics: inputData.diagnostics } : {}) };
      },
    });
    const workflow = createWorkflow({
      id: 'pr-review', inputSchema: reviewJobSchema, outputSchema: outcomeSchema,
      options: { shouldPersistSnapshot: () => false },
    }).then(fetchStep).then(analyzeStep).then(postStep).commit();
    // Suppress framework error payloads; the webhook server logs sanitized outcomes.
    workflow.__setLogger(noopLogger);
    try {
      const run = await workflow.createRun();
      const result = await run.start({ inputData: job });
      if (result.status !== 'success') throw failure ?? reviewFailure(currentStage, result.status === 'failed' ? result.error : undefined);
      return outcomeSchema.parse(result.result);
    } catch (error) { throw failure ?? reviewFailure(currentStage, error); }
  };
}
