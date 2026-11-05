import { Octokit } from '@octokit/rest';
import type { Config } from './config.js';
import type { ChangedFile, GitHubClient, ReviewJob } from '../types/index.js';

import { COMMENT_MARKER } from '../types/index.js';
export { COMMENT_MARKER } from '../types/index.js';

export function createGitHubClient(config: Config): GitHubClient {
  const octokit = new Octokit({
    auth: config.GITHUB_TOKEN,
    userAgent: 'mastra-pr-reviewer/0.1.0',
    request: { timeout: 15000 },
    // API errors can contain request headers; never log them or their response bodies.
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const params = (job: ReviewJob, signal: AbortSignal) => ({
    owner: job.owner, repo: job.repo, request: { signal },
  });
  return {
    async canReview(job, signal) {
      try {
        const { data } = await octokit.repos.getCollaboratorPermissionLevel({
          ...params(job, signal), username: job.requestedBy,
        });
        return ['admin', 'maintain', 'write'].includes(data.permission);
      } catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 404) return false;
        throw error;
      }
    },
    async getPullRequest(job, signal) {
      const { data } = await octokit.pulls.get({ ...params(job, signal), pull_number: job.pullNumber });
      return {
        headSha: data.head.sha, baseSha: data.base.sha, title: data.title,
        state: data.state, draft: data.draft ?? false, changedFiles: data.changed_files,
      };
    },
    async getFiles(job, signal) {
      const files: ChangedFile[] = [];
      // Scan a bounded number of pages, including extra candidates for ignored files.
      const maxPages = Math.ceil(Math.min(600, config.MAX_FILES * 3) / 100);
      for (let page = 1; page <= maxPages; page++) {
        signal.throwIfAborted();
        const { data } = await octokit.pulls.listFiles({
          ...params(job, signal), pull_number: job.pullNumber, per_page: 100, page,
        });
        files.push(...data.map(file => ({ filename: file.filename, status: file.status, patch: file.patch })));
        if (data.length < 100) break;
      }
      return files;
    },
    async postSummary(job, body, signal) {
      const { data: me } = await octokit.users.getAuthenticated({ request: { signal } });
      let existingId: number | undefined;
      for await (const { data } of octokit.paginate.iterator(octokit.issues.listComments, {
        ...params(job, signal), issue_number: job.pullNumber, per_page: 100,
      })) {
        signal.throwIfAborted();
        const existing = data.find(comment => comment.user?.id === me.id && comment.body?.startsWith(COMMENT_MARKER));
        if (existing) { existingId = existing.id; break; }
      }
      if (existingId) {
        await octokit.issues.updateComment({ ...params(job, signal), comment_id: existingId, body });
      } else {
        await octokit.issues.createComment({ ...params(job, signal), issue_number: job.pullNumber, body });
      }
    },
  };
}
