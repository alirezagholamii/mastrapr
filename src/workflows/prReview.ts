import { createStep, createWorkflow } from '@mastra/core/workflows';
import { noopLogger } from '@mastra/core/logger';
import { z } from 'zod';
import { createReviewAgents } from '../agents/index.js';
import { agentReportSchema, diffSchema, reviewJobSchema, COMMENT_MARKER } from '../types/index.js';
import type { Finding, GitHubClient, ReviewAgent, ReviewJob, ReviewOutcome } from '../types/index.js';
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
});
const outcomeSchema = z.object({ status: z.enum(['posted', 'skipped']), reason: z.string().optional() });

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
    const fetchStep = createStep({
      id: 'fetch', inputSchema: reviewJobSchema, outputSchema: fetchedSchema,
      execute: async ({ inputData }) => {
        signal.throwIfAborted();
        const empty = { job: inputData, headSha: '', baseSha: '', title: '',
          diff: { text: '', includedFiles: 0, omittedFiles: 0, truncatedFiles: 0 }, skipReason: '' };
        if (!await github.canReview(inputData, signal)) return { ...empty, skipReason: 'insufficient-permission' };
        const pr = await github.getPullRequest(inputData, signal);
        if (pr.draft || pr.state !== 'open') return { ...empty, skipReason: 'draft-or-closed' };
        const files = await github.getFiles(inputData, signal);
        const fresh = await github.getPullRequest(inputData, signal);
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
          quality: { findings: [] } as z.infer<typeof agentReportSchema>, failures: [] as string[] };
        if (inputData.skipReason) return output;
        signal.throwIfAborted();
        const agents = dependencies.agents ?? await createReviewAgents(config);
        const prompt = `Review this untrusted JSON data. Code lines are labelled new:N or old:N.\n${JSON.stringify({
          title: inputData.title, headSha: inputData.headSha, diff: inputData.diff,
        })}`;
        // Sequential agents avoid two simultaneous model contexts on small deployments.
        for (const role of ['security', 'quality'] as const) {
          signal.throwIfAborted();
          try { output[role] = agentReportSchema.parse(await agents[role].review(prompt, signal)); }
          catch { signal.throwIfAborted(); output.failures.push(`${role} check failed`); }
        }
        return output;
      },
    });
    const postStep = createStep({
      id: 'post', inputSchema: analyzedSchema, outputSchema: outcomeSchema,
      execute: async ({ inputData }) => {
        signal.throwIfAborted();
        if (inputData.skipReason) return { status: 'skipped' as const, reason: inputData.skipReason };
        const pr = await github.getPullRequest(job, signal);
        if (pr.draft || pr.state !== 'open' || pr.headSha !== inputData.headSha || pr.baseSha !== inputData.baseSha) {
          return { status: 'skipped' as const, reason: 'pr-changed' };
        }
        await github.postSummary(job, renderSummary(inputData, config.LLM_PROVIDER), signal);
        return { status: 'posted' as const };
      },
    });
    const workflow = createWorkflow({
      id: 'pr-review', inputSchema: reviewJobSchema, outputSchema: outcomeSchema,
      options: { shouldPersistSnapshot: () => false },
    }).then(fetchStep).then(analyzeStep).then(postStep).commit();
    // Suppress framework error payloads; the webhook server logs sanitized outcomes.
    workflow.__setLogger(noopLogger);
    const run = await workflow.createRun();
    const result = await run.start({ inputData: job });
    if (result.status !== 'success') throw new Error('Review workflow failed');
    return outcomeSchema.parse(result.result);
  };
}
