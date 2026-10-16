// node --test scripts/changeset-study/focused-editors.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { focusedInput, preflightFocusedPlan } from './focused-editors.mjs';
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
  assert.doesNotThrow(() => validateStrategyPlan('focused-dispatch', { operations: [{ ...operation(), instruction: 'x'.repeat(2500) }] }));
  assert.throws(() => validateStrategyPlan('focused-dispatch', { operations: [{ ...operation(), instruction: 'x'.repeat(4000) }] }), /short objective/);
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

test('preflight rejects missing and oversized initial excerpts but leaves future source to staged execution', () => {
  const first = { ...operation(), context: [{ path: 'answer.mjs', start: 'missing', end: null }] };
  const later = { ...operation(), id: 'later', depends_on: ['answer'], context: [{ path: 'answer.mjs', start: 'future anchor', end: null }] };
  assert.deepEqual(preflightFocusedPlan({ schema_version: 1, operations: [first, later] }, files), ['answer: Excerpt anchor must be unique: answer.mjs']);
  const oversized = { ...operation(), context: [{ path: 'answer.mjs', start: null, end: null }] };
  assert.deepEqual(preflightFocusedPlan({ schema_version: 1, operations: [oversized] }, { 'answer.mjs': 'x'.repeat(32001) }), ['answer: Focused source exceeds 32000 characters: answer']);
});

for (const path of ['pi/extensions/context-budget/policy.test.mjs', 'deadline/policy.test.mjs']) {
  test(`an application failure for ${path} retries without treating its path as a request limit`, async () => {
    const original = { [path]: files['answer.mjs'] };
    const op = { ...operation(), writes: [path], context: operation().context.map(c => ({ ...c, path })) };
    const seen = [];
    const model = { json: async (_system, input) => {
      seen.push(input);
      return { edits: seen.length === 1
        ? [{ kind: 'create', path, text: 'export const answer = 2;' }]
        : [{ kind: 'replace', path, search: 'answer = 1', text: 'answer = 2' }] };
    } };
    const result = await patchEditor(model, 'editor', 'contract', { operation: op, files: original }, { focused: true });
    assert.equal(seen.length, 2);
    assert.equal(seen[1].application_failure, `Create requires absent owned path: ${path}`);
    assert.equal(result.files[path], 'export const answer = 2;\n// unrelated\nexport const untouched = 3;\n');
    assert.equal(original[path], files['answer.mjs']);
  });
}

test('request budget, deadline and cancellation failures stop without a second model request', async () => {
  const failures = [new Error('Campaign budget exhausted'), new Error('Cell deadline exceeded'),
    new Error('Cell model-call limit exceeded'), new Error('Budget ledger locked; no request submitted'),
    new DOMException('The operation was aborted', 'AbortError'), new DOMException('The operation timed out', 'TimeoutError'),
    new Error('Model stopped: aborted: request cancelled')];
  for (const failure of failures) {
    let calls = 0;
    const model = { json: async () => { calls++; throw failure; } };
    await assert.rejects(patchEditor(model, 'editor', 'contract', { operation: operation(), files }, { focused: true }), error => error === failure);
    assert.equal(calls, 1, failure.message);
  }
});
