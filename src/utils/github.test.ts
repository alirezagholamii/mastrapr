import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { loadConfig } from './config.js';
import { COMMENT_MARKER, createGitHubClient } from './github.js';
import type { ReviewJob } from '../types/index.js';

const config = loadConfig({
  GITHUB_WEBHOOK_SECRET: 's'.repeat(32), GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORIES: 'owner/repo',
});
const job: ReviewJob = { owner: 'owner', repo: 'repo', pullNumber: 1, requestedBy: 'alice', deliveryId: 'delivery-1' };
const signal = () => new AbortController().signal;

/** Exercise the real Octokit client and intercept only its HTTP transport. */
function intercept(t: TestContext, handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return handler(request);
  });
  return requests;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
}

test('GitHub permission checks allow writers and deny readers and unknown collaborators', async t => {
  for (const permission of ['admin', 'maintain', 'write', 'read', 'triage', 'none']) {
    await t.test(permission, async t => {
      intercept(t, request => {
        assert.equal(request.method, 'GET');
        assert.equal(new URL(request.url).pathname, '/repos/owner/repo/collaborators/alice/permission');
        assert.equal(request.headers.get('authorization'), 'token test-token');
        return json({ permission });
      });
      assert.equal(await createGitHubClient(config).canReview(job, signal()), ['admin', 'maintain', 'write'].includes(permission));
    });
  }
});

test('permission checks fail closed on 404 and propagate other API failures', async t => {
  for (const status of [404, 401, 403, 500]) {
    await t.test(String(status), async t => {
      intercept(t, () => json({ message: 'API failure' }, status));
      const check = createGitHubClient(config).canReview(job, signal());
      if (status === 404) assert.equal(await check, false);
      else await assert.rejects(check, error => error instanceof Error && 'status' in error && error.status === status);
    });
  }
});

test('PR snapshots preserve revision, draft state, and changed-file coverage', async t => {
  intercept(t, request => {
    assert.equal(new URL(request.url).pathname, '/repos/owner/repo/pulls/1');
    return json({ head: { sha: 'head' }, base: { sha: 'base' }, title: 'Fix', state: 'open', draft: true, changed_files: 123 });
  });
  assert.deepEqual(await createGitHubClient(config).getPullRequest(job, signal()), {
    headSha: 'head', baseSha: 'base', title: 'Fix', state: 'open', draft: true, changedFiles: 123,
  });
});

test('file fetching follows full pages and stops at the first short page', async t => {
  const requests = intercept(t, request => {
    const url = new URL(request.url);
    assert.equal(url.pathname, '/repos/owner/repo/pulls/1/files');
    assert.equal(url.searchParams.get('per_page'), '100');
    if (url.searchParams.get('page') === '1') {
      return json(Array.from({ length: 100 }, (_, i) => ({ filename: `src/${i}.ts`, status: 'modified', patch: '+new' })));
    }
    assert.equal(url.searchParams.get('page'), '2');
    return json([{ filename: 'image.png', status: 'added' }]);
  });
  const files = await createGitHubClient({ ...config, MAX_FILES: 100 }).getFiles(job, signal());
  assert.equal(requests.length, 2);
  assert.equal(files.length, 101);
  assert.deepEqual(files[0], { filename: 'src/0.ts', status: 'modified', patch: '+new' });
  assert.equal(files[100]?.patch, undefined);
});

test('file fetching caps pagination even when every page is full', async t => {
  const requests = intercept(t, request => {
    const page = Number(new URL(request.url).searchParams.get('page'));
    return json(Array.from({ length: 100 }, (_, i) => ({ filename: `src/${page}-${i}.ts`, status: 'modified', patch: '+new' })));
  });
  const files = await createGitHubClient({ ...config, MAX_FILES: 200 }).getFiles(job, signal());
  assert.equal(requests.length, 6);
  assert.equal(files.length, 600);
});

test('an already aborted file fetch performs no HTTP request', async t => {
  const requests = intercept(t, () => { throw new Error('Unexpected HTTP request'); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createGitHubClient(config).getFiles(job, controller.signal), { name: 'AbortError' });
  assert.equal(requests.length, 0);
});

test('cancellation reaches an in-flight Octokit request', async t => {
  const controller = new AbortController();
  intercept(t, request => new Promise<Response>((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    controller.abort();
  }));
  await assert.rejects(createGitHubClient(config).getPullRequest(job, controller.signal), { name: 'AbortError' });
});

test('summary lookup paginates and updates only a marked comment owned by the token account', async t => {
  const body = `${COMMENT_MARKER}\nNew findings`;
  const requests = intercept(t, async request => {
    const url = new URL(request.url);
    if (url.pathname === '/user') return json({ id: 7 });
    if (request.method === 'GET') {
      assert.equal(url.pathname, '/repos/owner/repo/issues/1/comments');
      if (url.searchParams.get('page') === '2') return json([{ id: 30, user: { id: 7 }, body: `${COMMENT_MARKER}\nOld review` }]);
      return json([
        { id: 10, user: { id: 99 }, body: `${COMMENT_MARKER}\nForeign review` },
        { id: 20, user: { id: 7 }, body: 'An ordinary comment' },
      ], 200, { link: '<https://api.github.com/repos/owner/repo/issues/1/comments?per_page=100&page=2>; rel="next"' });
    }
    assert.equal(request.method, 'PATCH');
    assert.equal(url.pathname, '/repos/owner/repo/issues/comments/30');
    assert.deepEqual(await request.json(), { body });
    return json({ id: 30, body });
  });
  await createGitHubClient(config).postSummary(job, body, signal());
  assert.equal(requests.length, 4);
  assert.equal(requests.filter(r => r.method === 'POST').length, 0);
});

test('summary creation preserves foreign marked comments and unrelated comments by the token account', async t => {
  const body = `${COMMENT_MARKER}\nFirst review`;
  const requests = intercept(t, async request => {
    const url = new URL(request.url);
    if (url.pathname === '/user') return json({ id: 7 });
    assert.equal(url.pathname, '/repos/owner/repo/issues/1/comments');
    if (request.method === 'GET') return json([
      { id: 10, user: { id: 99 }, body: COMMENT_MARKER },
      { id: 20, user: { id: 7 }, body: 'Ordinary comment' },
    ]);
    assert.equal(request.method, 'POST');
    assert.deepEqual(await request.json(), { body });
    return json({ id: 30, body }, 201);
  });
  await createGitHubClient(config).postSummary(job, body, signal());
  assert.equal(requests.length, 3);
  assert.equal(requests.filter(r => r.method === 'PATCH').length, 0);
});

test('summary lookup failures never fall back to creating an extra comment', async t => {
  const requests = intercept(t, request => {
    if (new URL(request.url).pathname === '/user') return json({ id: 7 });
    return json({ message: 'Forbidden' }, 403);
  });
  await assert.rejects(createGitHubClient(config).postSummary(job, COMMENT_MARKER, signal()));
  assert.equal(requests.filter(r => r.method !== 'GET').length, 0);
});
