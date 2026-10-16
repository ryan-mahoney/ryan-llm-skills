// node --test scripts/changeset-study/focused-editors.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { focusedInput } from './focused-editors.mjs';
import { patchEditor, validateStrategyPlan } from './strategies.mjs';

const operation = () => ({ id: 'answer', executor: 'simple', reads: [], writes: ['answer.mjs'], depends_on: [],
  objective: 'Change the answer', instruction: 'Set answer to 2.', requirements: ['Keep unrelated exports.'],
  context: [{ path: 'answer.mjs', start: 'export const answer', end: '\n// unrelated' }] });
const files = { 'answer.mjs': 'export const answer = 1;\n// unrelated\nexport const untouched = 3;\n' };

test('focused editor sees only selected current source and retries rejected edits without changing the input', async () => {
  const seen = [], op = operation();
  validateStrategyPlan('focused-dispatch', { operations: [op] });
  const model = { json: async (_system, input) => {
    seen.push(input);
    assert.equal(input.task_contract, undefined);
    assert.equal(input.files, undefined);
    assert.equal(input.excerpts[0].text, 'export const answer = 1;');
    return { edits: [{ kind: 'replace', path: 'answer.mjs', search: seen.length === 1 ? 'stale' : 'answer = 1', text: 'answer = 2' }] };
  } };
  const result = await patchEditor(model, 'editor', 'GLOBAL TASK MUST STAY WITH PLANNER', { operation: op, files }, { focused: true });
  assert.equal(seen.length, 2);
  assert.match(seen[1].application_failure, /count mismatch/);
  assert.equal(result.files['answer.mjs'], 'export const answer = 2;\n// unrelated\nexport const untouched = 3;\n');
  assert.equal(files['answer.mjs'], 'export const answer = 1;\n// unrelated\nexport const untouched = 3;\n');
  assert.equal(focusedInput(op, result.files).excerpts[0].text, 'export const answer = 2;');
});

test('focused packets refuse oversized context, stale anchors and multiple writable files before inference', () => {
  assert.throws(() => validateStrategyPlan('focused-dispatch', { operations: [{ ...operation(), writes: ['a', 'b'] }] }), /exactly one file/);
  assert.throws(() => focusedInput(operation(), { 'answer.mjs': 'missing' }), /unique/);
  assert.throws(() => focusedInput({ ...operation(), context: [{ path: 'answer.mjs', start: null, end: null }] }, { 'answer.mjs': 'x'.repeat(32001) }), /32000/);
  assert.throws(() => focusedInput({ ...operation(), context: [] }, files), /Missing declared file excerpt/);
});

test('editor recovery is bounded to two attempts and syntax failure is reported locally', async () => {
  let calls = 0;
  const model = { json: async (_system, input) => {
    calls++;
    if (calls === 2) assert.match(input.application_failure, /Syntax check failed/);
    return { edits: [{ kind: 'replace', path: 'answer.mjs', search: 'answer = 1', text: 'answer = {' }] };
  } };
  await assert.rejects(patchEditor(model, 'editor', 'contract', { operation: operation(), files }, { focused: true }), /Syntax check failed/);
  assert.equal(calls, 2);
  assert.equal(files['answer.mjs'], 'export const answer = 1;\n// unrelated\nexport const untouched = 3;\n');
});
