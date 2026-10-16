// CHANGESET_TEST_PARSER="$ACORN_MODULE" node --test scripts/changeset-study/context-compact.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { compactContext } from './context-compact.mjs';
import { focusedInput, preflightFocusedPlan } from './focused-editors.mjs';
import { patchEditor } from './strategies.mjs';
const { parse } = await import(process.env.CHANGESET_TEST_PARSER || 'acorn');
const repeated = '  value += 1;\n'.repeat(2600);
const source = `export const neighbor = 1;
export function huge(value) {\n${repeated}  return value;\n}
export class Worker { run(value) {\n${repeated}  return value;\n} }
export const arrow = value => {\n${repeated}  return value;\n};
export const expression = function named(value) {\n${repeated}  return value;\n};
export function outer(value) { function inner() {\n${repeated}  return value;\n} return inner(); }
export const boundary = true;
`;
const operation = { id: 'local', executor: 'simple', reads: [], writes: ['large.mjs'], depends_on: [],
  objective: 'Update a neighboring constant', instruction: 'Set neighbor to 2.', requirements: ['Preserve every function body.'],
  context: [{ path: 'large.mjs', start: null, end: null }] };

test('oversized modules retain signatures and boundaries as exact source slices with explicit omissions', () => {
  const files = { 'large.mjs': source }, packet = focusedInput(operation, files, { parse });
  assert.ok(packet.source_compaction.source_characters <= 32000);
  assert.equal(packet.source_compaction.original_source_characters, source.length);
  assert.equal(packet.source_compaction.omitted_ranges.length, 5, 'nested inner body belongs to the outer omission');
  const visible = packet.excerpts.map(e => e.text).join('');
  for (const signature of ['export function huge(value)', 'run(value)', 'value =>', 'function named(value)', 'export function outer(value)', 'export const neighbor = 1;', 'export const boundary = true;']) assert.ok(visible.includes(signature), signature);
  assert.ok(!visible.includes(repeated));
  assert.deepEqual(packet.source_compaction.selectors, [{ selection_index: 0, path: 'large.mjs', start: null, end: null, source_start: 0, source_end: source.length }]);
  const ordered = [
    ...packet.excerpts.map(e => ({ ...e, omitted: false })),
    ...packet.source_compaction.omitted_ranges.map(e => ({ ...e, omitted: true })),
  ].sort((a, b) => a.source_start - b.source_start);
  let cursor = 0;
  for (const segment of ordered) {
    assert.equal(segment.source_start, cursor, 'segments and omissions partition the original selection exactly');
    if (!segment.omitted) assert.equal(segment.text, source.slice(segment.source_start, segment.source_end));
    else {
      assert.equal(segment.omitted_bytes, Buffer.byteLength(source.slice(segment.source_start, segment.source_end)));
      assert.ok(segment.definition.body_start < segment.source_start);
      assert.ok(segment.source_end < segment.definition.body_end);
    }
    cursor = segment.source_end;
  }
  assert.equal(cursor, source.length);
  assert.equal(files['large.mjs'], source);
  assert.deepEqual(preflightFocusedPlan({ schema_version: 1, operations: [operation] }, files, { parse }), []);
  assert.match(preflightFocusedPlan({ schema_version: 1, operations: [operation] }, files)[0], /exceeds 32000/);
});

test('compaction cannot elide partial definitions, prose, JSON, invalid modules or non-function excess', () => {
  const beginning = source.indexOf('  value += 1;'), ending = beginning + 33000;
  assert.throws(() => compactContext([{ path: 'large.mjs', start: null, end: null, source_start: beginning, source_end: ending, text: source.slice(beginning, ending) }], { 'large.mjs': source }, { parse }), /exceeds 32000/);
  for (const [path, text] of [['notes.txt', 'a'.repeat(33000)], ['data.json', JSON.stringify({ code: source })], ['invalid.mjs', 'function broken( {' + ' '.repeat(33000)], ['literal.mjs', `export const text = '${'a'.repeat(33000)}';`]]) {
    const op = { ...operation, writes: [path], context: [{ path, start: null, end: null }] };
    assert.throws(() => focusedInput(op, { [path]: text }, { parse }), /exceeds 32000|invalid module/);
  }
  const small = focusedInput(operation, { 'large.mjs': 'export const neighbor = 1;' }, { parse: () => { throw Error('must not parse bounded input'); } });
  assert.equal(small.source_compaction, undefined);
  assert.deepEqual(small.excerpts[0], { path: 'large.mjs', start: null, end: null, text: 'export const neighbor = 1;' });
});

test('the focused writer receives omission metadata and exact edits preserve every unseen source byte', async () => {
  const files = { 'large.mjs': source }, seen = [];
  const model = { json: async (system, input) => {
    seen.push(input); assert.match(system, /Omitted ranges remain/); assert.ok(input.source_compaction.omitted_bytes > 0);
    return { edits: [{ kind: 'replace', path: 'large.mjs', search: 'export const neighbor = 1;', text: 'export const neighbor = 2;' }] };
  } };
  const result = await patchEditor(model, 'editor', 'contract', { operation, files }, { focused: true, contextParse: parse });
  assert.equal(seen.length, 1); assert.equal(result.files['large.mjs'], source.replace('export const neighbor = 1;', 'export const neighbor = 2;'));
  assert.equal(files['large.mjs'], source);
});
