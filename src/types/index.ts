import { z } from 'zod';

export const COMMENT_MARKER = '<!-- mastra-pr-reviewer:summary:v1 -->';

export const reviewJobSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
  requestedBy: z.string().min(1),
  deliveryId: z.string().min(1),
});
export type ReviewJob = z.infer<typeof reviewJobSchema>;

export interface ChangedFile {
  filename: string;
  status: string;
  patch?: string | undefined;
}

export const diffSchema = z.object({
  text: z.string(),
  includedFiles: z.number().int().nonnegative(),
  omittedFiles: z.number().int().nonnegative(),
  truncatedFiles: z.number().int().nonnegative(),
});
export type PreparedDiff = z.infer<typeof diffSchema>;

export const findingSchema = z.object({
  severity: z.enum(['high', 'medium']),
  file: z.string().min(1).max(300),
  line: z.number().int().positive().nullable(),
  title: z.string().min(1).max(160),
  explanation: z.string().min(1).max(1200),
  suggestion: z.string().min(1).max(800),
});
export const agentReportSchema = z.object({ findings: z.array(findingSchema).max(10) });
export type AgentReport = z.infer<typeof agentReportSchema>;
export type Finding = z.infer<typeof findingSchema>;

export interface ReviewAgent {
  review(prompt: string, signal: AbortSignal): Promise<AgentReport>;
}

export interface PullRequestSnapshot {
  headSha: string;
  baseSha: string;
  title: string;
  state: string;
  draft: boolean;
  changedFiles: number;
}

export interface GitHubClient {
  canReview(job: ReviewJob, signal: AbortSignal): Promise<boolean>;
  getPullRequest(job: ReviewJob, signal: AbortSignal): Promise<PullRequestSnapshot>;
  getFiles(job: ReviewJob, signal: AbortSignal): Promise<ChangedFile[]>;
  postSummary(job: ReviewJob, body: string, signal: AbortSignal): Promise<void>;
}

export type ReviewOutcome = { status: 'posted' | 'skipped'; reason?: string | undefined };
