import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotatePatch, prepareDiff } from './diff.js';

test('tracks old and new line numbers across hunks', () => {
  assert.equal(annotatePatch('@@ -2,2 +4,2 @@\n same\n-old\n+new\n@@ -20 +30 @@\n+later'),
    '@@ -2,2 +4,2 @@\nnew:4  same\nold:3 -old\nnew:5 +new\n@@ -20 +30 @@\nnew:30 +later');
});

test('enforces total, per-file and file count budgets and reports omitted files', () => {
  const files = [
    { filename: 'package-lock.json', status: 'modified', patch: '+lock' },
    { filename: 'image.png', status: 'added' },
    ...Array.from({ length: 5 }, (_, i) => ({ filename: `src/${i}.ts`, status: 'modified', patch: '@@ -1 +1 @@\n' + '+x\n'.repeat(100) })),
  ];
  const result = prepareDiff(files, { maxChars: 600, maxFileChars: 200, maxFiles: 2 }, 12);
  assert.ok(result.text.length <= 600);
  assert.equal(result.includedFiles, 2);
  assert.equal(result.omittedFiles, 10);
  assert.equal(result.truncatedFiles, 2);
  assert.ok(!result.text.includes('package-lock.json'));
  assert.equal(prepareDiff(files, { maxChars: 10, maxFileChars: 200, maxFiles: 3 }).includedFiles, 0);
});

test('does not invent patches for binary or unavailable content', () => {
  const result = prepareDiff([{ filename: 'code.ts', status: 'modified' }], { maxChars: 1000, maxFileChars: 500, maxFiles: 2 });
  assert.equal(result.text, '');
  assert.equal(result.omittedFiles, 1);
});
