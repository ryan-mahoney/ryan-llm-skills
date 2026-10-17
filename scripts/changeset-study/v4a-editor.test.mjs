import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, ModelJsonParseError } from './client.mjs';
import { v4aEditor } from './v4a-editor.mjs';

const operation = (overrides = {}) => ({ id: 'answer', executor: 'simple', reads: [], writes: ['answer.mjs'], depends_on: [],
  objective: 'Set the answer to two.', instruction: 'Change the answer constant from one to two.', requirements: ['Preserve unrelated source.'],
  context: [{ path: 'answer.mjs', start: null, end: 'function unrelated' }], ...overrides });
const source = 'export const answer = 1;\nfunction unrelated() { return "private unseen body"; }\n';
const patch = '*** Begin Patch\n*** Update File: answer.mjs\n@@\n-export const answer = 1;\n+export const answer = 2;\n*** End Patch';
const json = edits => ({ edits });
const replace = (search = 'answer = 1', text = 'answer = 2') => ({ kind: 'replace', path: 'answer.mjs', search, text, count: 1 });

// node --test --test-name-pattern='bounded V4A' scripts/changeset-study/v4a-editor.test.mjs
test('bounded V4A primary preserves unseen staged source and uses one accounted editor call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v4a-editor-accounting-'));
  try {
    const runtime = { getModel: () => ({ cost: { input: 1, output: 1 } }), hasConfiguredAuth: () => true,
      completeSimple: async (_model, context) => {
        assert.ok(!JSON.stringify(context).includes('private unseen body'));
        assert.ok(!JSON.stringify(context).includes('task_contract'));
        return { stopReason: 'stop', content: [{ type: 'text', text: patch }], usage: { cost: { total: .0001 } } };
      } };
    const client = new Client({ runtime, selector: 'deepseek/deepseek-flash:off', ledger: join(root, 'ledger.json'), receiptPath: join(root, 'receipts.jsonl') });
    const files = { 'answer.mjs': source }, result = await v4aEditor(client, 'editor', { operation: operation(), files });
    assert.deepEqual(result.files, { 'answer.mjs': source.replace('answer = 1', 'answer = 2') });
    assert.equal(files['answer.mjs'], source); assert.equal(result.writer_fallback, false); assert.equal(result.model_calls, 1);
    assert.equal(result.writer_attempts[0].syntax_valid, true); assert.ok(result.writer_attempts[0].elapsed_ms >= 0);
    for (const name of ['requests', 'receipts']) {
      const row = JSON.parse(readFileSync(join(root, name + '.jsonl'), 'utf8'));
      assert.equal(row.stage, 'editor'); assert.equal(row.operation_id, 'answer'); assert.equal(row.writer_attempt, 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// node --test --test-name-pattern='atomic application' scripts/changeset-study/v4a-editor.test.mjs
test('local atomic application failure gets one JSON fallback against original source with bounded diagnostics', async () => {
  const files = { 'answer.mjs': source }, seen = [];
  const rejected = patch.replace('*** End Patch', '@@\n-absent context\n+replacement\n*** End Patch');
  const model = { text: async () => rejected, json: async (_system, payload, stage, metadata) => {
    seen.push(metadata); assert.equal(stage, 'editor'); assert.equal(payload.local_failure_kind, 'application');
    assert.equal(payload.excerpts[0].text, 'export const answer = 1;\n');
    assert.ok(payload.application_failure.length <= 2000); assert.ok(payload.rejected_patch_excerpt.length <= 12000);
    return json([replace()]);
  } };
  const result = await v4aEditor(model, 'editor', { operation: operation(), files });
  assert.equal(result.files['answer.mjs'], source.replace('answer = 1', 'answer = 2'));
  assert.deepEqual(files, { 'answer.mjs': source }); assert.equal(result.model_calls, 2); assert.equal(result.writer_fallback, true);
  assert.deepEqual(seen, [{ operation_id: 'answer', writer_attempt: 1 }]);
  assert.equal(result.writer_attempts[0].local_failure_kind, 'application'); assert.equal(result.writer_attempts[0].applied, false);
});

// node --test --test-name-pattern='syntax fallback' scripts/changeset-study/v4a-editor.test.mjs
test('local syntax fallback can compose a declared unseen source range into one absent owned destination', async () => {
  const copied = 'export function keep() {\n/* body */\n return "unseen implementation";\n}\n';
  const op = operation({ writes: ['new.mjs'], reads: ['source.mjs'], context: [{ path: 'source.mjs', start: null, end: '/* body */' }] });
  const files = { 'source.mjs': copied, 'new.mjs': null };
  const model = { text: async () => '*** Begin Patch\n*** Add File: new.mjs\n+export const = ;\n*** End Patch',
    json: async (system, payload) => {
      assert.match(system, /replace-range/); assert.match(system, /compose/);
      assert.equal(payload.local_failure_kind, 'syntax'); assert.ok(!JSON.stringify(payload).includes('unseen implementation'));
      return json([{ kind: 'compose', path: 'new.mjs', parts: [{ path: 'source.mjs', start: 'export function keep()', end: null }] }]);
    } };
  const result = await v4aEditor(model, 'editor', { operation: op, files });
  assert.deepEqual(Object.keys(result.files), ['new.mjs']); assert.equal(result.files['new.mjs'], copied); assert.equal(files['new.mjs'], null);
  assert.equal(result.writer_attempts[0].applied, true); assert.equal(result.writer_attempts[0].syntax_valid, false);
  assert.equal(result.writer_attempts[1].syntax_valid, true);
});

// node --test --test-name-pattern='syntax diagnostics' scripts/changeset-study/v4a-editor.test.mjs
test('syntax diagnostics cannot disclose an unseen original source line to the fallback writer', async () => {
  const malformed = patch.replace('+export const answer = 2;', '+export const answer = 1; function');
  const model = { text: async () => malformed, json: async (_system, payload) => {
    assert.equal(payload.local_failure_kind, 'syntax'); assert.match(payload.application_failure, /Syntax validation failed/);
    assert.ok(!JSON.stringify(payload).includes('private unseen body'));
    return json([replace()]);
  } };
  const result = await v4aEditor(model, 'editor', { operation: operation(), files: { 'answer.mjs': source } });
  assert.equal(result.files['answer.mjs'], source.replace('answer = 1', 'answer = 2'));
  assert.equal(result.writer_attempts[0].local_failure_kind, 'syntax');
});

// node --test --test-name-pattern='owned path' scripts/changeset-study/v4a-editor.test.mjs
test('owned path fence rejects primary and fallback writes to readable but unowned source', async () => {
  const files = { 'answer.mjs': source, 'read.mjs': 'export const read = 1;\n' };
  const op = operation({ reads: ['read.mjs'], context: [...operation().context, { path: 'read.mjs', start: null, end: null }] });
  let fallbackCalls = 0;
  const model = { text: async () => '*** Begin Patch\n*** Delete File: read.mjs\n*** End Patch', json: async () => {
    fallbackCalls++; return json([{ kind: 'delete', path: 'read.mjs' }]);
  } };
  await assert.rejects(v4aEditor(model, 'editor', { operation: op, files }), error => {
    assert.equal(error.writer_attempts.length, 2); assert.equal(error.model_calls, 2); assert.equal(error.writer_fallback, true);
    assert.deepEqual(error.writer_attempts.map(row => row.local_failure_kind), ['path', 'path']); return true;
  });
  assert.equal(fallbackCalls, 1); assert.equal(files['read.mjs'], 'export const read = 1;\n');
});

// node --test --test-name-pattern='request failures' scripts/changeset-study/v4a-editor.test.mjs
test('transport, provider length, budget and abort request failures never trigger local fallback', async () => {
  for (const failure of [new SyntaxError('transport decoder'), new Error('Model stopped: length: truncated'), new Error('Campaign budget exhausted'), Object.assign(new Error('cancelled'), { name: 'AbortError' })]) {
    let fallbackCalls = 0;
    const model = { text: async () => { throw failure; }, json: async () => { fallbackCalls++; } };
    await assert.rejects(v4aEditor(model, 'editor', { operation: operation(), files: { 'answer.mjs': source } }), error => {
      assert.equal(error, failure); assert.equal(error.writer_attempts.length, 1); assert.equal(error.writer_fallback, false);
      assert.equal(error.writer_attempts[0].local_failure_kind, null); return true;
    });
    assert.equal(fallbackCalls, 0);
  }
});

// node --test --test-name-pattern='format fallback' scripts/changeset-study/v4a-editor.test.mjs
test('malformed primary receives one format fallback and malformed JSON terminates with both attempt metrics', async () => {
  let calls = 0;
  const model = { text: async () => '```patch\n' + patch + '\n```', json: async () => { calls++; throw new ModelJsonParseError(new SyntaxError('invalid JSON'), 'bad'); } };
  await assert.rejects(v4aEditor(model, 'editor', { operation: operation(), files: { 'answer.mjs': source } }), error => {
    assert.deepEqual(error.writer_attempts.map(row => row.local_failure_kind), ['format', 'format']); assert.equal(error.model_calls, 2); return true;
  });
  assert.equal(calls, 1);
});
