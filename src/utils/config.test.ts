import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from './config.js';

const env = { GITHUB_WEBHOOK_SECRET: 's'.repeat(32), GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORIES: 'Owner/Repo' };

test('defaults to Ollama and normalizes repository allowlist', () => {
  const config = loadConfig(env);
  assert.equal(config.LLM_PROVIDER, 'ollama');
  assert.deepEqual(config.GITHUB_REPOSITORIES, ['owner/repo']);
});

test('rejects missing OpenAI key, unsafe limits, unsupported providers, and empty allowlist', () => {
  for (const override of [{ LLM_PROVIDER: 'openai' }, { MAX_FILES: '0' }, { PORT: 'nan' },
    { GITHUB_REPOSITORIES: '' }, { GITHUB_WEBHOOK_SECRET: 'short' }, { LLM_PROVIDER: 'unsupported' }]) {
    assert.throws(() => loadConfig({ ...env, ...override }), /Invalid configuration:/);
  }
  assert.equal(loadConfig({ ...env, LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'key' }).LLM_PROVIDER, 'openai');
});

test('configuration errors never echo secret values', () => {
  assert.throws(() => loadConfig({ ...env, LLM_PROVIDER: 'secret-do-not-print' }), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('secret-do-not-print'));
    assert.ok(!error.message.includes('test-token'));
    return true;
  });
});
