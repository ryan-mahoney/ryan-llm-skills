// Run alone: node --test scripts/changeset-study/divergent/apply-writer/apply-writer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyWriter, verifyAppliedFile, ApplyWriterInputError } from './apply-writer.mjs';

const hash = source => createHash('sha256').update(source).digest('hex');
const source = `export function first() { return 1; }\n\nexport function target() { return 'old'; }\n\nexport function last() { return 3; }\n`;
const start = source.indexOf('export function target');
const end = source.indexOf('\n\nexport function last');
const plan = { path: 'src/example.mjs', source, sourceHash: hash(source), allowedRegions: [{ start, end }], instruction: 'Change target to return new.' };
const editedRegion = `export function target() { return 'new'; }`;
const expected = source.slice(0, start) + editedRegion + source.slice(end);

test('accepts an apply result only when exact source outside its explicit range is preserved', async () => {
  let request;
  const result = await applyWriter({ ...plan, transport: async input => { request = input; return { text: expected }; } });
  assert.equal(result.ok, true);
  assert.equal(result.text, expected);
  assert.equal(request.source, source);
  assert.deepEqual(request.allowed_regions, [{ start, end, original_text: source.slice(start, end) }]);
  assert.equal(request.retry_summary, null);
  assert.equal(result.attempts, 1);
  assert.equal(result.syntax_checked, true);
});

test('retries one unchanged-region rejection with a summary, then stops after a second rejection', async () => {
  const requests = [];
  const result = await applyWriter({ ...plan, transport: async input => {
    requests.push(input);
    return input.attempt === 1 ? source.replace('first() { return 1; }', 'first() { return 9; }') : expected;
  } });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.match(requests[1].retry_summary, /prefix outside the allowed range/);

  let calls = 0;
  const rejected = await applyWriter({ ...plan, transport: async () => { calls++; return source.replace('last() { return 3; }', 'last() { return 9; }'); } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.attempts, 2);
  assert.equal(calls, 2);
});

test('rejects stale, overlapping, multi-range, and out-of-bounds plans before transport', async () => {
  let calls = 0;
  const transport = async () => { calls++; return expected; };
  await assert.rejects(applyWriter({ ...plan, sourceHash: hash(source + 'stale'), transport }), ApplyWriterInputError);
  await assert.rejects(applyWriter({ ...plan, allowedRegions: [{ start: 0, end: 10 }, { start: 8, end: 12 }], transport }), ApplyWriterInputError);
  await assert.rejects(applyWriter({ ...plan, allowedRegions: [{ start, end }, { start: 0, end: 1 }], transport }), ApplyWriterInputError);
  await assert.rejects(applyWriter({ ...plan, allowedRegions: [{ start: 0, end: source.length + 1 }], transport }), ApplyWriterInputError);
  assert.equal(calls, 0);
});

test('rejects syntax-invalid JavaScript and output-cap violations', () => {
  const syntax = verifyAppliedFile({ ...plan, merged: expected.replace("return 'new';", "return 'new'; }") });
  assert.deepEqual({ ok: syntax.ok, code: syntax.code }, { ok: false, code: 'syntax-invalid' });
  const textSource = 'before\nold body\nafter\n';
  const textRange = { start: 7, end: 16 };
  const text = verifyAppliedFile({ path: 'docs/example.txt', source: textSource, sourceHash: hash(textSource),
    allowedRegions: [textRange], merged: 'before\nnew body\nafter\n' });
  assert.equal(text.ok, true);
  assert.equal(text.syntax_checked, false);
  assert.match(text.summary, /syntax checking was skipped/);
  const capped = verifyAppliedFile({ ...plan, merged: expected + ' '.repeat(500), maxOutputCharacters: source.length + 100 });
  assert.deepEqual({ ok: capped.ok, code: capped.code }, { ok: false, code: 'output-cap' });
});

test('requires exact explicit ranges and does not infer a landing zone from snippet text', async () => {
  let calls = 0;
  await assert.rejects(applyWriter({ ...plan, allowedRegions: [], transport: async () => { calls++; return expected; } }), /exactly one explicit planner-owned source range/);
  assert.equal(calls, 0);
  const ambiguous = verifyAppliedFile({ ...plan, merged: source.slice(0, start) + editedRegion + source.slice(end) + source.slice(0, end) });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.summary, /suffix outside the allowed range/);
});
