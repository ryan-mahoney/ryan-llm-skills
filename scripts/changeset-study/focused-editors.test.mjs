// node --test scripts/changeset-study/focused-editors.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { focusedInput, preflightFocusedPlan } from './focused-editors.mjs';
import { patchEditor, validateStrategyPlan } from './strategies.mjs';
import { ModelJsonParseError } from './client.mjs';

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

test('writer recovery escalates one rejected off attempt to low with identical source and trusted attempt metadata', async () => {
  const operationValue = operation(), original = { ...files }, initial = [], recovery = [];
  const off = { json: async (system, input, stage, metadata) => {
    initial.push({ system, input, stage, metadata });
    return { edits: [{ kind: 'replace', path: 'answer.mjs', search: 'missing anchor', text: 'answer = 2' }] };
  } };
  const low = { json: async (system, input, stage, metadata) => {
    recovery.push({ system, input, stage, metadata });
    return { edits: [{ kind: 'replace', path: 'answer.mjs', search: 'answer = 1', text: 'answer = 2' }] };
  } };

  const result = await patchEditor(off, 'editor', 'contract', { operation: operationValue, files }, { focused: true, recoveryModel: low });
  assert.equal(initial.length, 1);
  assert.equal(recovery.length, 1);
  assert.equal(initial[0].stage, 'editor');
  assert.equal(recovery[0].stage, 'editor');
  assert.deepEqual(initial[0].metadata, { operation_id: 'answer', writer_attempt: 0 });
  assert.deepEqual(recovery[0].metadata, { operation_id: 'answer', writer_attempt: 1 });
  assert.equal(recovery[0].system, initial[0].system);
  assert.deepEqual(recovery[0].input.excerpts, initial[0].input.excerpts);
  assert.match(recovery[0].input.application_failure, /count mismatch/);
  assert.equal(result.files['answer.mjs'], 'export const answer = 2;\n// unrelated\nexport const untouched = 3;\n');
  assert.deepEqual(files, original, 'both attempts leave staged input immutable');
});

test('successful initial writer attempt never initializes a recovery request', async () => {
  let recoveryCalls = 0;
  const result = await patchEditor({ json: async () => ({ edits: [{ kind: 'replace', path: 'answer.mjs', search: 'answer = 1', text: 'answer = 2' }] }) },
    'editor', 'contract', { operation: operation(), files }, { focused: true, recoveryModel: { json: async () => { recoveryCalls++; } } });
  assert.equal(recoveryCalls, 0);
  assert.equal(result.files['answer.mjs'], 'export const answer = 2;\n// unrelated\nexport const untouched = 3;\n');
});

test('only client JSON parse errors trigger low recovery while fixed-mode retry remains unchanged', async () => {
  let lowCalls = 0;
  const parseFailure = new ModelJsonParseError(new SyntaxError('invalid JSON'), '{');
  const recovered = await patchEditor({ json: async () => { throw parseFailure; } }, 'editor', 'contract',
    { operation: operation(), files }, { focused: true, recoveryModel: { json: async () => {
      lowCalls++;
      return { edits: [{ kind: 'replace', path: 'answer.mjs', search: 'answer = 1', text: 'answer = 2' }] };
    } } });
  assert.equal(lowCalls, 1);
  assert.equal(recovered.files['answer.mjs'], 'export const answer = 2;\n// unrelated\nexport const untouched = 3;\n');

  const transportSyntaxError = new SyntaxError('provider response stream failed to parse');
  let prohibitedRecoveryCalls = 0;
  await assert.rejects(patchEditor({ json: async () => { throw transportSyntaxError; } }, 'editor', 'contract',
    { operation: operation(), files }, { focused: true, recoveryModel: { json: async () => { prohibitedRecoveryCalls++; } } }),
  error => error === transportSyntaxError);
  assert.equal(prohibitedRecoveryCalls, 0);

  let fixedModeCalls = 0;
  const fixed = await patchEditor({ json: async () => {
    fixedModeCalls++;
    if (fixedModeCalls === 1) throw transportSyntaxError;
    return { edits: [{ kind: 'replace', path: 'answer.mjs', search: 'answer = 1', text: 'answer = 2' }] };
  } }, 'editor', 'contract', { operation: operation(), files }, { focused: true });
  assert.equal(fixedModeCalls, 2, 'fixed-mode retries preserve their prior same-model policy');
  assert.equal(fixed.files['answer.mjs'], 'export const answer = 2;\n// unrelated\nexport const untouched = 3;\n');
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

test('compose syntax retry includes bounded output and exact intersecting source-part provenance', async () => {
  const source = '  first() {}\n  second() {}\n';
  const operation = { id: 'compose', executor: 'simple', reads: ['source.mjs'], writes: ['combined.mjs'], depends_on: [],
    objective: 'Move methods into an object', instruction: 'Compose the source methods into the object.', requirements: ['Preserve both methods.'],
    context: [{ path: 'source.mjs', start: '  first() {}\n', end: null }] };
  const files = { 'source.mjs': source, 'combined.mjs': null };
  const seen = [];
  const model = { json: async (system, input) => {
    seen.push({ system, input });
    return { edits: [{ kind: 'compose', path: 'combined.mjs', parts: seen.length === 1
      ? [{ text: 'export const api = {\n' }, { path: 'source.mjs', start: '  first() {}\n', end: null }, { text: '};\n' }]
      : [{ text: 'export const api = {\n' }, { path: 'source.mjs', start: '  first() {}', end: '\n  second() {}\n' },
        { text: ',\n' }, { path: 'source.mjs', start: '  second() {}\n', end: null }, { text: '};\n' }] }] };
  } };

  const result = await patchEditor(model, 'editor', 'contract', { operation, files }, { focused: true });
  assert.equal(seen.length, 2);
  assert.match(seen[0].system, /Compose concatenates parts literally and in order/);
  const failure = seen[1].input.application_failure;
  assert.match(failure, /Composed output excerpt \(combined\.mjs, line 3/);
  assert.match(failure, /> 3:   second\(\) \{\}/);
  const mappingText = failure.split('Intersecting compose parts: ')[1].split('\n')[0];
  const mappings = JSON.parse(mappingText);
  assert.deepEqual(mappings.filter(part => part.kind === 'literal').map(part => part.index), [0, 2]);
  const sourceMapping = mappings.find(part => part.kind === 'source');
  const { source_sha256, ...sourceMappingIdentity } = sourceMapping;
  assert.deepEqual(sourceMappingIdentity, { index: 1, kind: 'source', path: 'source.mjs', source_start: 0, source_end: source.length,
    output_start: 21, output_end: 21 + source.length });
  assert.match(source_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(mappings.filter(part => part.kind === 'literal').map(part => ({ index: part.index, output_start: part.output_start, output_end: part.output_end })), [
    { index: 0, output_start: 0, output_end: 21 }, { index: 2, output_start: 48, output_end: 51 },
  ]);
  const extra = failure.slice(failure.indexOf('\n\nComposed output excerpt'));
  assert.ok(Buffer.byteLength(JSON.stringify(extra), 'utf8') <= 4096, 'serialized assembled context and map stay within the extra diagnostic cap');
  assert.deepEqual({ ...files }, { 'source.mjs': source, 'combined.mjs': null }, 'rejected output never mutates staged input');
  assert.equal(result.files['combined.mjs'], 'export const api = {\n  first() {},\n  second() {}\n};\n');
});

test('compose syntax retry does not guess a location when the parser supplies none', async () => {
  const operation = { id: 'compose-json', executor: 'simple', reads: ['source.mjs'], writes: ['combined.json'], depends_on: [],
    objective: 'Compose a JSON document', instruction: 'Compose the document.', requirements: ['Return valid JSON.'],
    context: [{ path: 'source.mjs', start: 'export const source', end: null }] };
  const files = { 'source.mjs': 'export const source = 1;\n', 'combined.json': null };
  const seen = [];
  const model = { json: async (_system, input) => {
    seen.push(input);
    return { edits: [{ kind: 'compose', path: 'combined.json', parts: [{ text: '{' }] }] };
  } };

  let finalError;
  await assert.rejects(patchEditor(model, 'editor', 'contract', { operation, files }, { focused: true }), error => {
    finalError = error;
    return error instanceof SyntaxError;
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].application_failure, finalError.message, 'forward the exact parser diagnostic without inventing a source location');
  assert.ok(!seen[1].application_failure.includes('Composed output excerpt'));
  assert.ok(!seen[1].application_failure.includes('Intersecting compose parts'));
  assert.deepEqual({ ...files }, { 'source.mjs': 'export const source = 1;\n', 'combined.json': null });
});

test('compose retry keeps the final syntax excerpt but omits stale part mapping after target edits', async () => {
  const source = 'export const value = 1;\n';
  const operation = { id: 'compose-edit', executor: 'simple', reads: ['source.mjs'], writes: ['combined.mjs'], depends_on: [],
    objective: 'Compose and update a module', instruction: 'Compose the source then update its value.', requirements: ['Keep valid syntax.'],
    context: [{ path: 'source.mjs', start: 'export const value', end: null }] };
  const files = { 'source.mjs': source, 'combined.mjs': null };
  const seen = [];
  const model = { json: async (_system, input) => {
    seen.push(input);
    return { edits: [
      { kind: 'compose', path: 'combined.mjs', parts: [{ path: 'source.mjs', start: 'export const value', end: null }] },
      { kind: 'replace', path: 'combined.mjs', search: 'value = 1',
        text: seen.length === 1 ? 'value = {' : 'value = 2' },
    ] };
  } };

  const result = await patchEditor(model, 'editor', 'contract', { operation, files }, { focused: true });
  assert.equal(seen.length, 2);
  const failure = seen[1].application_failure;
  assert.match(failure, /Composed output excerpt \(combined\.mjs, line 1/);
  assert.match(failure, /Compose-part map omitted: later edits changed the composed output/);
  assert.ok(!failure.includes('Intersecting compose parts:'));
  assert.equal(result.files['combined.mjs'], 'export const value = 2;\n');
  assert.deepEqual({ ...files }, { 'source.mjs': source, 'combined.mjs': null });
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
    let calls = 0, recoveries = 0;
    const model = { json: async () => { calls++; throw failure; } };
    await assert.rejects(patchEditor(model, 'editor', 'contract', { operation: operation(), files }, {
      focused: true, recoveryModel: { json: async () => { recoveries++; } },
    }), error => error === failure);
    assert.equal(calls, 1, failure.message);
    assert.equal(recoveries, 0, failure.message);
  }
});
