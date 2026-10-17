import test from 'node:test';
import assert from 'node:assert/strict';
import { v4aInput } from './v4a-context.mjs';
import { v4aEditor } from './v4a-editor.mjs';

const operation = context => ({ id: 'copy', executor: 'simple', reads: [], writes: ['source.mjs'], depends_on: [],
  objective: 'Change the selected behavior.', instruction: 'Preserve all other source.', requirements: ['Keep unrelated content.'], context });

// node --test --test-name-pattern='physical source lines' scripts/changeset-study/v4a-context.test.mjs
test('physical source lines retain leading statements, long suffixes, CRLF and original order without including the next declaration', async () => {
  const text = 'const head = 1;\r\n  try { action(); } catch { recover(); }\r\n  const prompt = `before ${old()} after`;\r\n  function privateBody() { return "not selected"; }\r\n';
  const op = operation([{ path: 'source.mjs', start: 'const prompt', end: 'function privateBody' },
    { path: 'source.mjs', start: 'catch {', end: 'const prompt' }]);
  const input = v4aInput(op, { 'source.mjs': text });
  assert.equal(input.excerpts.length, 1);
  assert.equal(input.excerpts[0].text, '  try { action(); } catch { recover(); }\r\n  const prompt = `before ${old()} after`;\r\n');
  assert.equal(input.excerpts[0].start_line, 2); assert.equal(input.excerpts[0].end_line, 3);
  assert.ok(!JSON.stringify(input).includes('not selected'));
  const patch = '*** Begin Patch\n*** Update File: source.mjs\n@@\n-  try { action(); } catch { recover(); }\n+  try { action(); } catch { recover(2); }\n-  const prompt = `before ${old()} after`;\n+  const prompt = `before ${next()} after`;\n*** End Patch';
  const result = await v4aEditor({ text: async () => patch, json: async () => { throw new Error('No fallback needed'); } }, 'editor', { operation: op, files: { 'source.mjs': text } });
  assert.equal(result.files['source.mjs'], text.replace('recover()', 'recover(2)').replace('${old()}', '${next()}'));
  assert.equal(result.writer_fallback, false);
});

// node --test --test-name-pattern='complete copied bodies' scripts/changeset-study/v4a-context.test.mjs
test('complete copied bodies survive the former 32000 character compaction threshold and overlapping selectors are delivered once', async () => {
  const body = '/*' + 'x'.repeat(33000) + '*/\n';
  const text = 'export function copied() {\n' + body + 'return 7;\n}\n';
  const op = { ...operation([{ path: 'source.mjs', start: null, end: null }, { path: 'source.mjs', start: '/*', end: 'return 7;' }]),
    reads: ['source.mjs'], writes: ['new.mjs'] };
  const files = { 'source.mjs': text, 'new.mjs': null }, input = v4aInput(op, files);
  assert.equal(input.excerpts.length, 1); assert.equal(input.excerpts[0].text, text);
  assert.equal(input.source_context.source_characters, text.length); assert.equal(input.source_context.body_omission, false);
  assert.equal(input.source_compaction, undefined);
  const result = await v4aEditor({ text: async (_system, payload) => {
    assert.equal(payload.excerpts[0].text, text);
    return '*** Begin Patch\n*** Add File: new.mjs\n' + text.trimEnd().split('\n').map(line => '+' + line).join('\n') + '\n*** End Patch';
  }, json: async () => { throw new Error('No fallback needed'); } }, 'editor', { operation: op, files });
  assert.deepEqual(result.files, { 'new.mjs': text }); assert.equal(files['new.mjs'], null);
  assert.equal(result.writer_attempts[0].syntax_valid, true);
});

// node --test --test-name-pattern='complete source bound' scripts/changeset-study/v4a-context.test.mjs
test('complete source bound and ambiguous selectors fail before any model call instead of omitting source', async () => {
  const op = operation([{ path: 'source.mjs', start: null, end: null }]);
  const model = { text: async () => { throw new Error('Unexpected model call'); } };
  await assert.rejects(v4aEditor(model, 'editor', { operation: op, files: { 'source.mjs': 'x'.repeat(64001) } }), /V4A complete source exceeds 64000/);
  assert.throws(() => v4aInput(operation([{ path: 'source.mjs', start: 'x', end: null }]), { 'source.mjs': 'xx' }), /anchor must be unique/);
});
