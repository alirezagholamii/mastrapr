import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReviewFailure, reviewFailure } from './index.js';

test('failure diagnostics retain stage and status without retaining upstream secrets', () => {
  const upstream = Object.assign(new Error('private-source-and-token'), {
    status: 403, code: 'private-code', request: { headers: { authorization: 'private-token' } },
    response: { data: 'private-source' },
  });
  const failure = reviewFailure('github-permissions', upstream);
  assert.deepEqual(failure.diagnostic, { stage: 'github-permissions', httpStatus: 403, errorCode: undefined });
  assert.doesNotMatch(failure.message + JSON.stringify(failure), /private/);
  assert.equal('cause' in failure, false);
});

test('diagnostics recognize provider statusCode and nested network failures', () => {
  assert.equal(new ReviewFailure('agent-security', { statusCode: 401 }).diagnostic.httpStatus, 401);
  assert.equal(new ReviewFailure('agent-quality', { cause: { code: 'ECONNREFUSED' } }).diagnostic.errorCode, 'ECONNREFUSED');
  for (const status of ['403', 999, 200.5, NaN]) {
    assert.equal(new ReviewFailure('workflow', { status }).diagnostic.httpStatus, undefined);
  }
  assert.equal(new ReviewFailure('workflow', { code: 'token-like-arbitrary-value' }).diagnostic.errorCode, undefined);
});

test('failure categories distinguish cancellation and invalid model output', () => {
  assert.equal(new ReviewFailure('agent-security', new SyntaxError('source')).diagnostic.errorCode, 'INVALID_JSON');
  assert.equal(new ReviewFailure('agent-quality', { name: 'ZodError', message: 'source' }).diagnostic.errorCode, 'INVALID_OUTPUT');
  assert.equal(new ReviewFailure('github-pr', new DOMException('cancelled', 'AbortError')).diagnostic.errorCode, 'ABORTED');
  const failure = new ReviewFailure('github-comment-write', { status: 403 });
  assert.equal(reviewFailure('github-summary', failure), failure, 'outer wrappers must preserve the precise operation');
});
