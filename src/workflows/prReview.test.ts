import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../utils/config.js';
import type { GitHubClient, PullRequestSnapshot, ReviewJob } from '../types/index.js';
import { ReviewFailure } from '../types/index.js';
import { createReviewRunner, renderSummary, validFindings } from './prReview.js';

const config = loadConfig({ GITHUB_WEBHOOK_SECRET: 's'.repeat(32), GITHUB_TOKEN: 'test', GITHUB_REPOSITORIES: 'owner/repo' });
const job: ReviewJob = { owner: 'owner', repo: 'repo', pullNumber: 1, requestedBy: 'alice', deliveryId: 'delivery-1' };
const snapshot: PullRequestSnapshot = { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), title: 'Change', state: 'open', draft: false, changedFiles: 1 };
const finding = { severity: 'high' as const, file: 'src/a.ts', line: 1, title: 'Bug', explanation: 'Fails on input', suggestion: 'Validate input' };

function fixture(overrides: Partial<GitHubClient> = {}) {
  const posts: string[] = [];
  let agentCalls = 0;
  const github: GitHubClient = {
    canReview: async () => true,
    getPullRequest: async () => snapshot,
    getFiles: async () => [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }],
    postSummary: async (_job, body) => { posts.push(body); },
    ...overrides,
  };
  const agents = {
    security: { review: async () => { agentCalls++; return { findings: [finding] }; } },
    quality: { review: async () => { agentCalls++; return { findings: [] }; } },
  };
  return { github, agents, posts, calls: () => agentCalls };
}

test('real Mastra workflow fetches, analyzes, and posts one summary', async () => {
  const f = fixture();
  const result = await createReviewRunner(config, f)(job, new AbortController().signal);
  assert.equal(result.status, 'posted');
  assert.equal(f.calls(), 2);
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0]!, /HIGH: Bug/);
  assert.match(f.posts[0]!, /src\/a\.ts:1/);
});

test('skips unauthorized users, drafts, closed PRs, and unreviewable changes before agents', async () => {
  for (const overrides of [
    { canReview: async () => false },
    { getPullRequest: async () => ({ ...snapshot, draft: true }) },
    { getPullRequest: async () => ({ ...snapshot, state: 'closed' }) },
    { getFiles: async () => [] },
  ]) {
    const f = fixture(overrides);
    const result = await createReviewRunner(config, f)(job, new AbortController().signal);
    assert.equal(result.status, 'skipped');
    assert.equal(f.calls(), 0);
    assert.deepEqual(f.posts, []);
  }
});

test('does not post findings when head or base changes during review', async () => {
  for (const changed of [{ headSha: 'c'.repeat(40) }, { baseSha: 'd'.repeat(40) }]) {
    let calls = 0;
    const f = fixture({ getPullRequest: async () => (++calls >= 3 ? { ...snapshot, ...changed } : snapshot) });
    const result = await createReviewRunner(config, f)(job, new AbortController().signal);
    assert.equal(result.status, 'skipped');
    assert.deepEqual(f.posts, []);
  }
});

test('partial model failures are labelled incomplete', async () => {
  const f = fixture();
  f.agents.quality.review = async () => { throw new Error('sensitive-provider-error'); };
  await createReviewRunner(config, f)(job, new AbortController().signal);
  assert.match(f.posts[0]!, /Incomplete review/);
  assert.match(f.posts[0]!, /quality check failed/);
  assert.ok(!f.posts[0]!.includes('sensitive-provider-error'));
});

test('cancellation prevents analysis and posting', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createReviewRunner(config, f)(job, controller.signal));
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.posts, []);
});

test('a revision change during diff retrieval skips both agents', async () => {
  let snapshots = 0;
  const f = fixture({ getPullRequest: async () => ++snapshots === 1 ? snapshot : { ...snapshot, headSha: 'c'.repeat(40) } });
  const result = await createReviewRunner(config, f)(job, new AbortController().signal);
  assert.deepEqual(result, { status: 'skipped', reason: 'pr-changed' });
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.posts, []);
});

test('PRs changed to draft or closed during analysis are not updated', async () => {
  for (const changed of [{ draft: true }, { state: 'closed' }]) {
    let snapshots = 0;
    const f = fixture({ getPullRequest: async () => ++snapshots < 3 ? snapshot : { ...snapshot, ...changed } });
    const result = await createReviewRunner(config, f)(job, new AbortController().signal);
    assert.equal(result.status, 'skipped');
    assert.equal(f.calls(), 2);
    assert.deepEqual(f.posts, []);
  }
});

test('both failed checks produce an incomplete summary rather than a clean review', async () => {
  const f = fixture();
  for (const role of ['security', 'quality'] as const) {
    f.agents[role].review = async () => { throw new Error('private upstream payload'); };
  }
  assert.equal((await createReviewRunner(config, f)(job, new AbortController().signal)).status, 'posted');
  assert.match(f.posts[0]!, /Incomplete review/);
  assert.match(f.posts[0]!, /security check failed/);
  assert.match(f.posts[0]!, /quality check failed/);
  assert.doesNotMatch(f.posts[0]!, /No actionable findings|private upstream payload/);
});

test('cancellation during the first agent prevents the second agent and posting', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.agents.security.review = async () => { controller.abort(); return { findings: [] }; };
  await assert.rejects(createReviewRunner(config, f)(job, controller.signal));
  assert.equal(f.calls(), 0, 'quality agent must not run after cancellation');
  assert.deepEqual(f.posts, []);
});

test('GitHub failures stop the workflow without posting a misleading review', async () => {
  for (const overrides of [
    { canReview: async () => { throw new Error('permission API unavailable'); } },
    { getFiles: async () => { throw new Error('diff API unavailable'); } },
  ]) {
    const f = fixture(overrides);
    await assert.rejects(createReviewRunner(config, f)(job, new AbortController().signal));
    assert.equal(f.calls(), 0);
    assert.deepEqual(f.posts, []);
  }
});

test('a failed comment write rejects the run', async () => {
  const f = fixture({ postSummary: async () => { throw new Error('comment API unavailable'); } });
  await assert.rejects(createReviewRunner(config, f)(job, new AbortController().signal));
  assert.equal(f.calls(), 2);
});

test('summary rendering keeps complete findings within the GitHub comment budget', () => {
  const findings = Array.from({ length: 20 }, (_, i) => ({ ...finding,
    title: `Issue ${i} ${'*'.repeat(150)}`, explanation: '*'.repeat(1200), suggestion: '*'.repeat(800),
  }));
  const summary = renderSummary({ job, headSha: snapshot.headSha, baseSha: snapshot.baseSha, title: '', skipReason: '',
    diff: { text: '\nFILE "src/a.ts" (modified)\nnew:1 +new', includedFiles: 1, omittedFiles: 0, truncatedFiles: 0 },
    security: { findings: findings.slice(0, 10) }, quality: { findings: findings.slice(10) }, failures: [],
  }, 'ollama');
  assert.ok(summary.length < 65536);
  assert.match(summary, /Additional findings omitted/);
  assert.ok(summary.endsWith('Verify findings before acting.'));
});

test('filters invented locations, merges duplicates, and escapes untrusted output', () => {
  const diff = '\nFILE "src/a.ts" (modified)\n@@ -1 +1 @@\nnew:1 +new';
  assert.equal(validFindings([finding, finding, { ...finding, file: 'invented.ts' }, { ...finding, line: 999 }], diff).length, 1);
  const summary = renderSummary({ job, headSha: snapshot.headSha, baseSha: snapshot.baseSha, title: '', skipReason: '',
    diff: { text: diff, includedFiles: 1, omittedFiles: 2, truncatedFiles: 1 },
    security: { findings: [{ ...finding, explanation: '<img src=x> @everyone [click](https://evil.invalid)' }] },
    quality: { findings: [] }, failures: [],
  }, 'ollama');
  assert.ok(!summary.includes('<img'));
  assert.ok(!summary.includes('@everyone'));
  assert.match(summary, /omitted 2; truncated 1/);
});

test('failed workflow steps retain the GitHub operation and status across Mastra execution', async () => {
  for (const [stage, overrides] of [
    ['github-permissions', { canReview: async () => { throw { status: 403, message: 'private-token' }; } }],
    ['github-diff', { getFiles: async () => { throw { status: 401, message: 'private-token' }; } }],
    ['github-comment-write', { postSummary: async () => { throw new ReviewFailure('github-comment-write', { status: 403 }); } }],
  ] as const) {
    const f = fixture(overrides);
    await assert.rejects(createReviewRunner(config, f)(job, new AbortController().signal), error => {
      assert.ok(error instanceof ReviewFailure);
      assert.equal(error.diagnostic.stage, stage);
      assert.equal(error.diagnostic.httpStatus, stage === 'github-diff' ? 401 : 403);
      assert.doesNotMatch(error.message + JSON.stringify(error), /private-token/);
      return true;
    });
  }
});

test('partial reviews return provider diagnostics without putting upstream details in the comment', async () => {
  const f = fixture();
  f.agents.quality.review = async () => { throw { statusCode: 401, message: 'private-provider-payload' }; };
  const outcome = await createReviewRunner(config, f)(job, new AbortController().signal);
  assert.equal(outcome.status, 'posted');
  assert.equal(outcome.diagnostics?.[0]?.stage, 'agent-quality');
  assert.equal(outcome.diagnostics?.[0]?.httpStatus, 401);
  assert.doesNotMatch(f.posts[0]!, /private-provider-payload/);
});
