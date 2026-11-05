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

export const reviewDiagnosticSchema = z.object({
  stage: z.enum(['startup', 'workflow', 'github-permissions', 'github-pr', 'github-diff', 'github-recheck',
    'agents-init', 'agent-security', 'agent-quality', 'github-summary', 'github-identity', 'github-comments', 'github-comment-write']),
  httpStatus: z.number().int().min(100).max(599).optional(),
  errorCode: z.enum(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET',
    'UND_ERR_CONNECT_TIMEOUT', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ABORTED', 'INVALID_JSON', 'INVALID_OUTPUT']).optional(),
});
export type ReviewDiagnostic = z.infer<typeof reviewDiagnosticSchema>;
export type ReviewStage = ReviewDiagnostic['stage'];

/** Retain only diagnostic fields that cannot contain credentials, URLs, or source. */
export class ReviewFailure extends Error {
  readonly diagnostic: ReviewDiagnostic;

  constructor(stage: ReviewStage, error?: unknown) {
    super(`Review failed at ${stage}`);
    this.name = 'ReviewFailure';
    const fields = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
    const cause = fields.cause !== null && typeof fields.cause === 'object' ? fields.cause as Record<string, unknown> : {};
    const httpStatus = [fields.status, fields.statusCode].find(status =>
      typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599);
    const errorCodeSchema = reviewDiagnosticSchema.shape.errorCode;
    const codes = [fields.code, cause.code,
      fields.name === 'AbortError' ? 'ABORTED' : undefined,
      fields.name === 'SyntaxError' ? 'INVALID_JSON' : undefined,
      fields.name === 'ZodError' ? 'INVALID_OUTPUT' : undefined];
    const errorCode = codes.map(code => errorCodeSchema.safeParse(code))
      .find(result => result.success && result.data !== undefined);
    this.diagnostic = reviewDiagnosticSchema.parse({ stage, httpStatus,
      errorCode: errorCode?.success ? errorCode.data : undefined });
  }
}

export function reviewFailure(stage: ReviewStage, error: unknown): ReviewFailure {
  return error instanceof ReviewFailure ? error : new ReviewFailure(stage, error);
}

export type ReviewOutcome = {
  status: 'posted' | 'skipped';
  reason?: string | undefined;
  diagnostics?: ReviewDiagnostic[] | undefined;
};
