import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, ModelJsonParseError } from './client.mjs';
import { v4aEditor, routeWriterFormat, seedMove, seedIntegrity } from './v4a-editor.mjs';

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
  const fenced = { text: async () => '```patch\n' + patch + '\n```' };
  const accepted = await v4aEditor(fenced, 'editor', { operation: operation(), files: { 'answer.mjs': source } });
  assert.equal(accepted.writer_attempts[0].envelope, 'lenient-wrapper'); assert.equal(accepted.files['answer.mjs'], source.replace('answer = 1', 'answer = 2'));
  const model = { text: async () => 'Here is the patch:\n' + patch, json: async () => { calls++; throw new ModelJsonParseError(new SyntaxError('invalid JSON'), 'bad'); } };
  await assert.rejects(v4aEditor(model, 'editor', { operation: operation(), files: { 'answer.mjs': source } }), error => {
    assert.deepEqual(error.writer_attempts.map(row => row.local_failure_kind), ['format', 'format']); assert.equal(error.model_calls, 2); return true;
  });
  assert.equal(calls, 1);
});

// node --test --test-name-pattern='representation routing' scripts/changeset-study/v4a-editor.test.mjs
test('representation routing keeps new files literal and sends range recipes on existing files to executable JSON', () => {
  const existing = { 'answer.mjs': source }, absent = { 'new.mjs': null, 'source.mjs': source };
  assert.equal(routeWriterFormat(operation(), existing, 'hybrid'), 'v4a');
  assert.equal(routeWriterFormat(operation({ instruction: 'Delete range `// The to` through `export async`.' }), existing, 'hybrid'), 'json');
  assert.equal(routeWriterFormat(operation({ instruction: 'Rearrange the result.' }), existing, 'hybrid'), 'v4a');
  assert.equal(routeWriterFormat(operation({ writes: ['new.mjs'], reads: ['source.mjs'], instruction: 'Use source-range compose.' }), absent, 'hybrid'), 'v4a');
  assert.equal(routeWriterFormat(operation({ instruction: 'Delete range a through b.' }), existing, 'v4a'), 'v4a');
  assert.equal(routeWriterFormat(operation(), existing, 'json'), 'json');
  const wide = operation({ context: [{ path: 'answer.mjs', start: null, end: 'export' }, { path: 'answer.mjs', start: 'export', end: 'function' }, { path: 'answer.mjs', start: 'function', end: null }] });
  assert.equal(routeWriterFormat(wide, existing, 'hybrid'), 'v4a'); assert.equal(routeWriterFormat(wide, existing, 'hybrid-wide'), 'json');
  assert.equal(routeWriterFormat(operation({ members: ['a', 'b'] }), existing, 'hybrid-wide'), 'json'); assert.equal(routeWriterFormat(operation(), existing, 'hybrid-wide'), 'v4a');
  assert.throws(() => routeWriterFormat(operation(), existing, 'other'), /Unknown writer routing/);
});

// node --test --test-name-pattern='static-first' scripts/changeset-study/v4a-editor.test.mjs
test('static-first prompt order ends the system prompt with the per-packet ownership sentence', async () => {
  const systems = [];
  const model = { text: async system => { systems.push(system); return patch; } };
  await v4aEditor(model, 'editor', { operation: operation(), files: { 'answer.mjs': source } }, { promptOrder: 'static-first' });
  await v4aEditor(model, 'editor', { operation: operation(), files: { 'answer.mjs': source } });
  assert.ok(systems[0].startsWith('Return exactly ONE strict V4A patch')); assert.match(systems[0], /writable path is "answer\.mjs"\. [^\n]*$/);
  assert.ok(systems[1].startsWith('Implement only this settled focused assignment'));
  assert.equal([...systems[0]].sort().join(''), [...(systems[1] + '\n')].sort().join(''));
});

// node --test --test-name-pattern='seeded move' scripts/changeset-study/v4a-editor.test.mjs
test('seeded move pre-fills an absent destination from its declared excerpts and the writer patches only the seams', async () => {
  const sourceText = 'import x from "x";\n// helper\nfunction helper() { return 1; }\n// tail\nexport const tail = 2;\n';
  const op = operation({ writes: ['new.mjs'], reads: ['source.mjs'], instruction: 'Compose new.mjs: copy helper and export it.',
    context: [{ path: 'source.mjs', start: '// helper', end: '// tail' }] });
  const files = { 'source.mjs': sourceText, 'new.mjs': null };
  const seed = seedMove(op, files);
  assert.equal(seed.files['new.mjs'], '// helper\nfunction helper() { return 1; }\n');
  assert.deepEqual(seed.operation.context, [{ path: 'new.mjs', start: null, end: null }]);
  assert.deepEqual(seed.layout, [{ excerpt: 1, source: 'source.mjs', start_anchor: '// helper', end_anchor: '// tail', seed_lines: '1-2' }]);
  const twoPart = seedMove(operation({ writes: ['new.mjs'], reads: ['source.mjs'], instruction: 'Compose new.mjs: copy `// tail` first, then copy `// helper`.',
    context: [{ path: 'source.mjs', start: '// helper', end: '// tail' }, { path: 'source.mjs', start: '// tail', end: null }] }), files);
  assert.equal(twoPart.files['new.mjs'], '// tail\nexport const tail = 2;\n// helper\nfunction helper() { return 1; }\n', 'recipe mention order wins over planner order');
  assert.deepEqual(twoPart.layout.map(row => [row.excerpt, row.seed_lines]), [[2, '1-2'], [1, '3-4']]);
  assert.equal(seedMove(operation(), { 'answer.mjs': source }), null, 'existing destinations are never seeded');
  assert.equal(seedMove(op, { 'source.mjs': 'no anchors here', 'new.mjs': null }), null, 'unresolvable anchors leave the packet unseeded');
  assert.equal(seedMove({ ...op, instruction: 'Export a builder that calls validateStepIndex.' }, files), null, 'reference excerpts without copy intent are not seeded');
  const systems = [], payloads = [];
  const model = { text: async (system, payload) => { systems.push(system); payloads.push(payload);
    return '*** Begin Patch\n*** Update File: new.mjs\n@@\n-function helper() { return 1; }\n+export function helper() { return 1; }\n*** End Patch'; } };
  const result = await v4aEditor(model, 'editor', seed, { seed });
  assert.equal(result.files['new.mjs'], '// helper\nexport function helper() { return 1; }\n');
  assert.equal(result.seeded, true); assert.equal(result.model_calls, 1);
  assert.match(payloads[0].seeded_destination.note, /PRE-FILLED/); assert.match(systems[0], /destination exists/);
  assert.ok(!JSON.stringify(payloads[0]).includes('export const tail'), 'unselected source stays unseen');
  // Dropping or commenting out copied code is a local failure even when syntax passes.
  assert.deepEqual(seedIntegrity('// c\nfunction a() {}\nconst b = 1;\n}\n', 'export function a() {}\n  const b = 1;\n},\n'), []);
  const parse = (code, options) => { const match = /\/\*[\s\S]*?\*\//.exec(code); if (match) options.onComment.push({ type: 'Block', start: match.index, end: match.index + match[0].length }); };
  assert.deepEqual(seedIntegrity('function a() {}\nconst b = 1;\n', '/*\nfunction a() {}\n*/\nconst b = 1;\n', { parse }), ['function a() {}']);
  assert.deepEqual(seedIntegrity("const g = '/*';\nfunction a() {}\n", "const g = '/*';\nfunction a() {}\n", { parse: (code, options) => { options.onComment.push(); } }), [], 'only parser-reported comment ranges are blanked');
  assert.deepEqual(seedIntegrity('function a() {}\n', '// function a() {}\n'), ['function a() {}']);
  assert.deepEqual(seedIntegrity('  async containedRoot(record, prompt) {\n    return 1;\n  }\n', 'export async function containedRoot(record, prompt) {\n  return 1;\n}\n'), [], 'a method header may become a function header at a seam');
  assert.deepEqual(seedIntegrity('  async containedRoot(record, prompt) {\n    return 1;\n  }\n', 'export async function containedRoot(record, prompt) {\n}\n'), ['return 1;'], 'body lines must survive');
  const commenting = { text: async () => '*** Begin Patch\n*** Update File: new.mjs\n@@\n-function helper() { return 1; }\n+/* function helper() { return 1; } */\n*** End Patch', json: async () => { throw new Error('no JSON'); } };
  await assert.rejects(v4aEditor(commenting, 'editor', seed, { seed }), error => { assert.match(error.message, /missing or commented out/); assert.deepEqual(error.writer_attempts.map(row => [row.format, row.applied, row.syntax_valid]), [['v4a', true, true], ['v4a', true, true]]); return true; });
  // A failed seam patch gets one more seam attempt carrying the applier diagnostic, never a JSON rewrite.
  const retryPayloads = []; let texts = 0;
  const failing = { text: async (system, payload) => { texts++; retryPayloads.push(payload); return texts === 1
      ? '*** Begin Patch\n*** Update File: new.mjs\n@@\n-absent\n+x\n*** End Patch'
      : '*** Begin Patch\n*** Update File: new.mjs\n@@\n-function helper() { return 1; }\n+export function helper() { return 1; }\n*** End Patch'; },
    json: async () => { throw new Error('JSON fallback must not run for a seeded move'); } };
  const retryClient = { selector: 'deepseek/deepseek-flash:low', calls: 0, text: async (...args) => { retryClient.calls++; return failing.text(...args); } };
  const recovered = await v4aEditor(failing, 'editor', seed, { seed, seamRetryModel: retryClient });
  assert.equal(retryClient.calls, 1); assert.equal(recovered.writer_attempts[1].selector, 'deepseek/deepseek-flash:low');
  assert.equal(recovered.files['new.mjs'], '// helper\nexport function helper() { return 1; }\n');
  assert.deepEqual(recovered.writer_attempts.map(row => [row.format, row.applied, row.local_failure_kind]), [['v4a', false, 'application'], ['v4a', true, null]]);
  assert.equal(recovered.writer_fallback, true); assert.match(retryPayloads[1].application_failure, /locate|match|source lines/i); assert.ok(retryPayloads[1].instruction_on_retry);
  const twice = { text: async () => '*** Begin Patch\n*** Update File: new.mjs\n@@\n-absent\n+x\n*** End Patch', json: async () => { throw new Error('no JSON'); } };
  await assert.rejects(v4aEditor(twice, 'editor', seed, { seed }), error => { assert.deepEqual(error.writer_attempts.map(row => row.format), ['v4a', 'v4a']); assert.equal(error.model_calls, 2); return true; });
});
