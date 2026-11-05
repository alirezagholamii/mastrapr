import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReviewAgents, parseAgentReport } from './index.js';
import { loadConfig } from '../utils/config.js';

test('accepts JSON or a single fenced JSON object, validates all fields', () => {
  assert.deepEqual(parseAgentReport('{"findings":[]}'), { findings: [] });
  assert.deepEqual(parseAgentReport('```json\n{"findings":[]}\n```'), { findings: [] });
  assert.throws(() => parseAgentReport('Everything looks fine!'));
  assert.throws(() => parseAgentReport('{"findings":[{"severity":"low"}]}'));
  assert.throws(() => parseAgentReport('{"findings":"none"}'));
});

test('Ollama uses an isolated transport and preserves cancellation while generating valid reports', async t => {
  const signals: AbortSignal[] = [];
  const dispatchers: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit & { dispatcher?: unknown }) => {
    const request = new Request(input, init);
    assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
    const body = await request.json() as { model: string; stream: boolean };
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, false);
    assert.ok(init?.dispatcher, 'Ollama must not use the default transport header deadline');
    dispatchers.push(init.dispatcher);
    signals.push(request.signal);
    return new Response(JSON.stringify({
      model: 'test-model', created_at: new Date().toISOString(),
      message: { role: 'assistant', content: '{"findings":[]}' },
      done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1, eval_duration: 1, total_duration: 1,
    }), { headers: { 'content-type': 'application/json' } });
  });
  const config = loadConfig({ GITHUB_WEBHOOK_SECRET: 's'.repeat(32), GITHUB_TOKEN: 'test',
    GITHUB_REPOSITORIES: 'owner/repo', OLLAMA_MODEL: 'test-model' });
  const agents = await createReviewAgents(config);
  const controller = new AbortController();
  assert.deepEqual(await agents.security.review('Review the test diff.', controller.signal), { findings: [] });
  assert.deepEqual(await agents.quality.review('Review the test diff.', controller.signal), { findings: [] });
  assert.equal(dispatchers[0], dispatchers[1], 'both agents should reuse one Ollama transport');
  controller.abort();
  assert.ok(signals.every(signal => signal.aborted), 'the job cancellation signal must still reach fetch');
});
