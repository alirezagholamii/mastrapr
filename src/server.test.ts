import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { buildServer } from './server.js';
import { loadConfig } from './utils/config.js';
import type { ReviewJob } from './types/index.js';

const config = loadConfig({ GITHUB_WEBHOOK_SECRET: 's'.repeat(32), GITHUB_TOKEN: 'test', GITHUB_REPOSITORIES: 'owner/repo', MAX_QUEUE_SIZE: '1' });
function payload() {
  return { action: 'created', repository: { name: 'repo', owner: { login: 'owner' } },
    issue: { number: 1, pull_request: {} },
    comment: { body: '/review', user: { login: 'alice', type: 'User' } }, sender: { login: 'alice' } };
}
function signed(body: string, delivery = 'delivery-1', event = 'issue_comment') {
  return { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery,
    'x-hub-signature-256': `sha256=${createHmac('sha256', config.GITHUB_WEBHOOK_SECRET).update(body).digest('hex')}` };
}

test('health works without loading Mastra and unsigned webhook requests fail', async t => {
  let calls = 0;
  const app = buildServer(config, { logger: false, runner: async () => { calls++; return { status: 'posted' }; } });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  const response = await app.inject({ method: 'POST', url: '/webhook', payload: payload() });
  assert.equal(response.statusCode, 401);
  assert.equal(calls, 0);
});

test('verifies raw bytes before parsing JSON and supports signed ping', async t => {
  const app = buildServer(config, { logger: false });
  t.after(() => app.close());
  const malformed = '{';
  assert.equal((await app.inject({ method: 'POST', url: '/webhook', payload: malformed, headers: signed(malformed) })).statusCode, 400);
  const body = '{ "zen": "å 🦊" }\n';
  const response = await app.inject({ method: 'POST', url: '/webhook', payload: body, headers: signed(body, 'ping-1', 'ping') });
  assert.equal(response.json().status, 'pong');
  assert.equal((await app.inject({ method: 'POST', url: '/webhook', payload: body.trim(), headers: signed(body) })).statusCode, 401);
});

test('ignores edits, issues, bots, noncommands, and repositories outside allowlist', async t => {
  let calls = 0;
  const app = buildServer(config, { logger: false, runner: async () => { calls++; return { status: 'posted' }; } });
  t.after(() => app.close());
  const variants = [
    { ...payload(), action: 'edited' },
    { ...payload(), issue: { number: 1 } },
    { ...payload(), comment: { body: '/review', user: { login: 'alice', type: 'Bot' } } },
    { ...payload(), comment: { body: 'please /review', user: { login: 'alice', type: 'User' } } },
    { ...payload(), repository: { name: 'other', owner: { login: 'owner' } } },
    { ...payload(), sender: { login: 'someone-else' } },
  ];
  for (const data of variants) {
    const body = JSON.stringify(data);
    const response = await app.inject({ method: 'POST', url: '/webhook', payload: body, headers: signed(body) });
    assert.equal(response.json().status, 'ignored');
  }
  assert.equal(calls, 0);
});

test('rejects signed requests with unsupported content type or invalid delivery IDs', async t => {
  let calls = 0;
  const app = buildServer(config, { logger: false, runner: async () => { calls++; return { status: 'posted' }; } });
  t.after(() => app.close());
  const body = JSON.stringify(payload());
  const response = await app.inject({ method: 'POST', url: '/webhook', payload: body,
    headers: { ...signed(body), 'content-type': 'text/plain' } });
  assert.equal(response.statusCode, 415);
  for (const delivery of ['', 'contains spaces', 'x'.repeat(129)]) {
    const response = await app.inject({ method: 'POST', url: '/webhook', payload: body, headers: signed(body, delivery) });
    assert.equal(response.statusCode, 400);
  }
  const headers: Record<string, string> = signed(body);
  delete headers['x-github-delivery'];
  assert.equal((await app.inject({ method: 'POST', url: '/webhook', payload: body, headers })).statusCode, 400);
  assert.equal(calls, 0);
});

test('rejects oversized bodies without scheduling a review', async t => {
  let calls = 0;
  const app = buildServer(config, { logger: false, runner: async () => { calls++; return { status: 'posted' }; } });
  t.after(() => app.close());
  const body = JSON.stringify({ ...payload(), padding: 'x'.repeat(1024 * 1024) });
  const response = await app.inject({ method: 'POST', url: '/webhook', payload: body, headers: signed(body) });
  assert.equal(response.statusCode, 413);
  assert.equal(calls, 0);
});

test('failed deliveries can be redelivered and release queue capacity', async t => {
  let calls = 0;
  const app = buildServer(config, { logger: false, runner: async () => {
    if (++calls === 1) throw new Error('upstream failure');
    return { status: 'posted' };
  } });
  t.after(() => app.close());
  const body = JSON.stringify(payload());
  const request = { method: 'POST' as const, url: '/webhook', payload: body, headers: signed(body) };
  assert.equal((await app.inject(request)).json().status, 'queued');
  await setImmediate();
  assert.equal((await app.inject(request)).json().status, 'queued');
  await setImmediate();
  assert.equal(calls, 2);
  assert.equal((await app.inject(request)).json().status, 'duplicate');
});

test('processes queued PRs in FIFO order without overlapping runners', async t => {
  const started: number[] = [];
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const app = buildServer({ ...config, MAX_QUEUE_SIZE: 3 }, { logger: false, runner: async job => {
    started.push(job.pullNumber);
    maxActive = Math.max(maxActive, ++active);
    if (job.pullNumber === 1) await first;
    active--;
    return { status: 'posted' };
  } });
  t.after(async () => { release(); await app.close(); });
  for (const pullNumber of [1, 2, 3]) {
    const body = JSON.stringify({ ...payload(), issue: { number: pullNumber, pull_request: {} } });
    const response = await app.inject({ method: 'POST', url: '/webhook', payload: body, headers: signed(body, `delivery-${pullNumber}`) });
    assert.equal(response.json().status, 'queued');
  }
  assert.deepEqual(started, [1]);
  release();
  await setImmediate();
  assert.deepEqual(started, [1, 2, 3]);
  assert.equal(maxActive, 1);
});

test('the review deadline aborts active work and permits redelivery', async t => {
  const app = buildServer(config, { logger: false, runner: async (_job, signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return { status: 'posted' };
  } });
  t.after(() => app.close());
  await app.ready();
  // Fake only setTimeout after Fastify initialization; no wall-clock sleep is needed.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const body = JSON.stringify(payload());
  const request = { method: 'POST' as const, url: '/webhook', payload: body, headers: signed(body) };
  assert.equal((await app.inject(request)).json().status, 'queued');
  t.mock.timers.tick(config.REVIEW_TIMEOUT_MS);
  await setImmediate();
  assert.equal((await app.inject(request)).json().status, 'queued');
});

test('acknowledges immediately, deduplicates deliveries/PRs, and bounds active plus queued work', async t => {
  const jobs: ReviewJob[] = [];
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const app = buildServer(config, { logger: false, runner: async job => { jobs.push(job); await wait; return { status: 'posted' }; } });
  t.after(async () => { release(); await app.close(); });
  const body = JSON.stringify(payload());
  const request = { method: 'POST' as const, url: '/webhook', payload: body, headers: signed(body) };
  const first = await app.inject(request);
  assert.equal(first.statusCode, 202);
  assert.equal(first.json().status, 'queued');
  assert.equal((await app.inject(request)).json().status, 'duplicate');
  assert.equal((await app.inject({ ...request, headers: signed(body, 'delivery-2') })).json().status, 'duplicate');
  const next = JSON.stringify({ ...payload(), issue: { number: 2, pull_request: {} } });
  assert.equal((await app.inject({ ...request, payload: next, headers: signed(next, 'delivery-3') })).statusCode, 503);
  assert.equal(jobs.length, 1);
  release();
  await setImmediate();
  assert.equal((await app.inject(request)).json().status, 'duplicate');
});

test('shutdown aborts an active review', async () => {
  let aborted = false;
  const app = buildServer(config, { logger: false, runner: async (_job, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return { status: 'skipped' };
  } });
  const body = JSON.stringify(payload());
  await app.inject({ method: 'POST', url: '/webhook', payload: body, headers: signed(body) });
  await app.close();
  assert.equal(aborted, true);
});
