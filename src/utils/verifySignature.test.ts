import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { verifySignature } from './verifySignature.js';

test('verifies exact bytes, including whitespace and Unicode', () => {
  const body = Buffer.from('{ "text": "å 🦊" }\n');
  const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
  assert.equal(verifySignature(body, signature, 'secret'), true);
  assert.equal(verifySignature(Buffer.from('{"text":"å 🦊"}'), signature, 'secret'), false);
  assert.equal(verifySignature(body, signature, 'other-secret'), false);
});

test('rejects missing, malformed, and incorrect signatures without throwing', () => {
  for (const signature of [undefined, '', 'sha1=abc', 'sha256=abc', `sha256=${'z'.repeat(64)}`, `sha256=${'0'.repeat(64)}`]) {
    assert.equal(verifySignature(Buffer.from('{}'), signature, 'secret'), false);
  }
});
