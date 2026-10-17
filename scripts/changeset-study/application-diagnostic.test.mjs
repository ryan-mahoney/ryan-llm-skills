import assert from 'node:assert/strict';
import test from 'node:test';
import { transform } from '../changeset/engine.mjs';
import { applicationFailureDiagnostic } from './application-diagnostic.mjs';

const operation = { id: 'diagnostic', executor: 'simple', reads: ['target.mjs'], writes: ['target.mjs'], depends_on: [] };
function detail(diagnostic) {
  assert.ok(diagnostic?.includes('Local application diagnosis (context only):'));
  const json = diagnostic.split('Local application diagnosis (context only):\n').at(-1);
  return JSON.parse(json);
}
function rejectedError(op, files, edits) {
  try { transform({ ...op, edits }, files); }
  catch (error) { return error; }
  assert.fail('expected the edit batch to fail');
}

// Run alone: node --test scripts/changeset-study/application-diagnostic.test.mjs
test('replays prior edits privately and locates only the first failed replacement', () => {
  const files = { 'target.mjs': "const stage = 'old';\nconst tail = 'steady';\n" };
  const original = structuredClone(files);
  const edits = [
    { kind: 'replace', path: 'target.mjs', search: "const stage = 'old';", text: "const stage = 'new';" },
    { kind: 'replace', path: 'target.mjs', search: "const stage = 'new';\nconst tail = 'changed';", text: 'unreachable' },
    { kind: 'replace', path: 'target.mjs', search: 'never inspected', text: 'also unreachable' },
  ];
  const failure = rejectedError(operation, files, edits);
  const diagnostic = applicationFailureDiagnostic({ operation, files, edits, error: failure });
  const info = detail(diagnostic);
  assert.deepEqual(info.failed_edit, { index: 1, kind: 'replace', path: 'target.mjs', error: 'Replacement count mismatch: target.mjs' });
  assert.deepEqual(info.match_count, { expected: 1, actual: 0, overlapping_candidates: 0 });
  assert.equal(info.source_context.kind, 'unique_exact_prefix_not_full_match');
  assert.equal(info.source_context.source_state, 'private_replay_after_preceding_edits');
  assert.ok(info.source_context.source_window.text.includes("const stage = 'new';\n"), 'the context reflects the first private edit');
  assert.ok(Buffer.byteLength(diagnostic, 'utf8') <= 4096);
  assert.deepEqual(files, original, 'diagnosis leaves the caller snapshot unchanged');
});

test('serializes a real newline separately from a literal backslash-n in a rejected search', () => {
  const files = { 'target.mjs': String.raw`const note = 'one\nnext';` + '\n' };
  const original = structuredClone(files);
  const search = "const note = 'one\nnext';\n";
  const edits = [{ kind: 'replace', path: 'target.mjs', search, text: 'unused' }];
  const diagnostic = applicationFailureDiagnostic({ operation, files, edits, error: rejectedError(operation, files, edits) });
  const info = detail(diagnostic);
  assert.equal(info.rejected_search, search);
  assert.ok(search.includes('\n'), 'the rejected search contains a line-feed character');
  assert.ok(files['target.mjs'].includes(String.raw`\n`), 'the staged source contains the two literal characters backslash-n');
  assert.equal(info.match_count.actual, 0);
  assert.equal(Object.hasOwn(info, 'source_context'), false, 'a mismatch without a unique exact prefix gets no guessed location');
  assert.ok(Buffer.byteLength(diagnostic, 'utf8') <= 4096);
  assert.deepEqual(files, original);
});

test('shows actual staged source after a unique prefix when escape spelling diverges', () => {
  const files = { 'target.mjs': String.raw`const firstValue = 123;
const note = 'a\nb';
` };
  const search = "const firstValue = 123;\nconst note = 'a\nb';\n";
  const edits = [{ kind: 'replace', path: 'target.mjs', search, text: 'unused' }];
  const info = detail(applicationFailureDiagnostic({ operation, files, edits, error: rejectedError(operation, files, edits) }));
  assert.equal(info.source_context.kind, 'unique_exact_prefix_not_full_match');
  assert.equal(info.source_context.source_state, 'private_replay_after_preceding_edits');
  assert.ok(info.source_context.prefix_sha256);
  assert.ok(info.source_context.source_window.text.includes(String.raw`'a\nb'`),
    'the displayed source window includes the actual characters immediately after the matched prefix');
  assert.equal(info.match_count.actual, 0);
});

test('omits missing or ambiguous locations and preserves core metadata for oversized searches', () => {
  const cases = [
    { text: 'shared prefix\nshared prefix\n', search: 'shared prefix\nmissing tail\n', expectedContext: false },
    { text: 'needle=1\nneedle=1\n', search: 'needle=1', expectedContext: false },
  ];
  for (const entry of cases) {
    const files = { 'target.mjs': entry.text }, edits = [{ kind: 'replace', path: 'target.mjs', search: entry.search, text: 'unused' }];
    const info = detail(applicationFailureDiagnostic({ operation, files, edits, error: rejectedError(operation, files, edits) }));
    assert.equal(Object.hasOwn(info, 'source_context'), entry.expectedContext);
    assert.match(info.context_omitted, /no unique|ambiguous/);
  }

  const files = { 'target.mjs': 'short source\n' };
  const edits = [{ kind: 'replace', path: 'target.mjs', search: 'x'.repeat(5000), text: 'unused' }];
  const diagnostic = applicationFailureDiagnostic({ operation, files, edits, error: rejectedError(operation, files, edits) });
  const info = detail(diagnostic);
  assert.equal(info.failed_edit.index, 0);
  assert.equal(info.match_count.actual, 0);
  assert.equal(info.rejected_search_truncated, true);
  assert.equal(info.rejected_search_original_length, 5000);
  assert.match(info.rejected_search_sha256, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(diagnostic, 'utf8') <= 4096);
});

test('preserves core metadata when a replace-range anchor exceeds the diagnostic cap', () => {
  const files = { 'target.mjs': 'short source\n' };
  const edits = [{ kind: 'replace-range', path: 'target.mjs', start: 'z'.repeat(5000), end: null, text: 'unused' }];
  const diagnostic = applicationFailureDiagnostic({ operation, files, edits, error: rejectedError(operation, files, edits) });
  const info = detail(diagnostic);
  assert.equal(info.failed_edit.index, 0);
  assert.equal(info.anchors.start_matches, 0);
  assert.equal(info.anchors.start_literal_truncated, true);
  assert.equal(info.anchors.start_literal_original_length, 5000);
  assert.match(info.anchors.start_literal_sha256, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(diagnostic, 'utf8') <= 4096);
});

test('overlapping exact candidates never produce a supposedly unique source context', () => {
  const files = { 'target.mjs': 'aaa' };
  const edits = [{ kind: 'replace', path: 'target.mjs', search: 'aa', count: 2, text: 'unused' }];
  const info = detail(applicationFailureDiagnostic({ operation, files, edits, error: rejectedError(operation, files, edits) }));
  assert.deepEqual(info.match_count, { expected: 2, actual: 1, overlapping_candidates: 2 });
  assert.equal(Object.hasOwn(info, 'source_context'), false);
  assert.match(info.context_omitted, /overlapping or ambiguous/);

  const rangeFiles = { 'target.mjs': 'zaaa b' };
  const rangeEdits = [{ kind: 'replace-range', path: 'target.mjs', start: 'b', end: 'aa', text: 'unused' }];
  const rangeInfo = detail(applicationFailureDiagnostic({ operation, files: rangeFiles, edits: rangeEdits,
    error: rejectedError(operation, rangeFiles, rangeEdits) }));
  assert.equal(rangeInfo.anchors.end_matches, 1, 'engine split counting remains represented');
  assert.equal(rangeInfo.anchors.end_overlapping_candidates, 2);
  assert.equal(Object.hasOwn(rangeInfo, 'source_context'), false);
});
