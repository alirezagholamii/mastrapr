import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentReport } from './index.js';

test('accepts JSON or a single fenced JSON object, validates all fields', () => {
  assert.deepEqual(parseAgentReport('{"findings":[]}'), { findings: [] });
  assert.deepEqual(parseAgentReport('```json\n{"findings":[]}\n```'), { findings: [] });
  assert.throws(() => parseAgentReport('Everything looks fine!'));
  assert.throws(() => parseAgentReport('{"findings":[{"severity":"low"}]}'));
  assert.throws(() => parseAgentReport('{"findings":"none"}'));
});
