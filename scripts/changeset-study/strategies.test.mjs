// node --test scripts/changeset-study/strategies.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { patchEditor, validateStrategyPlan } from './strategies.mjs';
import { transform } from '../changeset/engine.mjs';

test('bounded editor edits preserve unrelated source and reject stale anchors or unowned writes', async () => {
  const files = { 'source.txt': 'preserve\nold\ntail\n', 'foreign.txt': 'private' };
  const operation = { writes: ['source.txt'], instruction: 'Change old to new' };
  const edit = { kind: 'replace', path: 'source.txt', search: 'old', text: 'new' };
  const model = edits => ({ json: async () => ({ edits }) });
  const applied = await patchEditor(model([edit]), 'editor', 'contract', { operation, files });
  assert.deepEqual({ ...applied.files }, { 'source.txt': 'preserve\nnew\ntail\n' });
  await assert.rejects(patchEditor(model([{ ...edit, search: 'stale' }]), 'editor', 'contract', { operation, files }), /count mismatch/);
  await assert.rejects(patchEditor(model([{ ...edit, path: 'foreign.txt', search: 'private' }]), 'editor', 'contract', { operation, files }), /Unowned write/);
  assert.equal(files['source.txt'], 'preserve\nold\ntail\n');
});

test('source ranges move exact bytes and refuse ambiguous or reversed boundaries', () => {
  const files = { 'old.txt': 'header\nSTART\nkeep exactly\nEND\ntail\n', 'new.txt': null };
  const operation = { writes: ['old.txt', 'new.txt'], edits: [
    { kind: 'compose', path: 'new.txt', parts: [{ text: 'prefix\n' }, { path: 'old.txt', start: 'START\n', end: 'END\n' }, { text: 'suffix\n' }] },
    { kind: 'replace-range', path: 'old.txt', start: 'START\n', end: 'END\n', text: 'delegate\n' },
  ] };
  assert.deepEqual({ ...transform(operation, files) }, { 'new.txt': 'prefix\nSTART\nkeep exactly\nsuffix\n', 'old.txt': 'header\ndelegate\nEND\ntail\n' });
  assert.throws(() => transform(operation, { ...files, 'old.txt': files['old.txt'] + 'START\n' }), /unique/);
  assert.throws(() => transform({ writes: ['old.txt'], edits: [{ kind: 'replace-range', path: 'old.txt', start: 'END\n', end: 'START\n', text: '' }] }, files), /ordering/);
  assert.equal(files['new.txt'], null);
});

test('delegated edits preserve moved source while refusing owner-written edits', async () => {
  const operation = { executor: 'involved', writes: ['old.txt', 'new.txt'], instruction: 'Extract unchanged body' };
  validateStrategyPlan('owner-editor', { operations: [operation] });
  assert.throws(() => validateStrategyPlan('owner-editor-contracts', { operations: [operation] }), /contract/);
  operation.contract = { implementation: ['Move START through END to new.txt, retaining header and tail.'], boundaries: ['Preserve moved bytes.'], verification: ['No test changes.'] };
  validateStrategyPlan('owner-editor-contracts', { operations: [operation] });
  assert.throws(() => validateStrategyPlan('owner-editor', { operations: [{ ...operation, executor: 'deterministic' }] }), /delegated/);
  assert.throws(() => validateStrategyPlan('owner-editor', { operations: [{ ...operation, edits: [] }] }), /delegated/);
  const files = { 'old.txt': 'header\nSTART\nunchanged body\nEND\ntail\n', 'new.txt': null };
  const model = { json: async (system, input) => {
    assert.match(system, /replace-range/);
    assert.match(system, /Compose the moved text before removing/);
    assert.deepEqual(input.writes, operation.writes);
    assert.deepEqual(input.packet_contract, operation.contract);
    return { edits: [
      { kind: 'compose', path: 'new.txt', parts: [{ path: 'old.txt', start: 'START\n', end: 'END\n' }] },
      { kind: 'replace-range', path: 'old.txt', start: 'START\n', end: 'END\n', text: 'delegate\n' },
    ] };
  } };
  const result = await patchEditor(model, 'editor', 'Preserve body', { operation, files }, { ranges: true });
  assert.deepEqual({ ...result.files }, { 'new.txt': 'START\nunchanged body\n', 'old.txt': 'header\ndelegate\nEND\ntail\n' });
  assert.equal(files['new.txt'], null);
});

// node --test --test-name-pattern='fidelity retry' scripts/changeset-study/strategies.test.mjs
test('a paraphrased literal fails locally and its retry goes to the fidelity retry model', async () => {
  const operation = { id: 'wire', executor: 'simple', reads: [], writes: ['runtime.mjs'], depends_on: [], objective: 'Wire the factory',
    instruction: 'Before `export class`, insert const lifecycle = create with the exact helper object below.', requirements: ['Factory object: { read, atomic, save }. Preserve everything else.'],
    context: [{ path: 'runtime.mjs', start: null, end: null }] };
  const files = { 'runtime.mjs': 'function read() {}\nfunction atomic() {}\nfunction save() {}\nexport class Runtime {}\n' };
  const edit = text => ({ edits: [{ kind: 'replace', path: 'runtime.mjs', search: 'export class', text: text + '\nexport class', count: 1 }] });
  const calls = [];
  const model = { selector: 'deepseek/deepseek-flash:off', json: async () => { calls.push('off'); return edit('const lifecycle = create({ read: readFileSync, atomic: writeFileSync, save });'); } };
  const low = { selector: 'deepseek/deepseek-flash:low', json: async (_system, payload) => { calls.push('low'); assert.match(payload.application_failure, /shorthand members read, atomic/); return edit('const lifecycle = create({ read, atomic, save });'); } };
  const result = await patchEditor(model, 'editor', 'spec', { operation, files }, { ranges: true, focused: true, fidelityRetryModel: low });
  assert.deepEqual(calls, ['off', 'low']); assert.match(result.files['runtime.mjs'], /create\(\{ read, atomic, save \}\)/);
  assert.deepEqual(result.writer_attempts.map(row => [row.applied, row.local_failure_kind, row.selector ?? null]), [[true, 'application', null], [true, null, 'deepseek/deepseek-flash:low']]);
});
