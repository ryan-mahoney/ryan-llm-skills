// Run alone: CHANGESET_TEST_PARSER=/path/to/acorn.mjs node --test scripts/changeset-study/query-source.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveSourceRequests, SourceRequestError } from './query-source.mjs';
const { parse } = await import(process.env.CHANGESET_TEST_PARSER ? pathToFileURL(process.env.CHANGESET_TEST_PARSER).href : 'acorn');
function assertExact(files, response) {
  assert.equal(response.source_characters, response.snippets.reduce((sum, snippet) => sum + snippet.text.length, 0));
  for (const snippet of response.snippets) {
    const source = files[snippet.path];
    assert.equal(snippet.source_hash, createHash('sha256').update(source).digest('hex'));
    assert.equal(snippet.text, source.slice(snippet.source_start, snippet.source_end));
    for (const [key, offset] of [['start', snippet.source_start], ['end', snippet.source_end]]) {
      if (snippet[key] === null) assert.equal(offset, key === 'start' ? 0 : source.length);
      else {
        assert.equal(source.indexOf(snippet[key]), offset);
        assert.equal(source.lastIndexOf(snippet[key]), offset);
      }
    }
  }
}

test('literal launchProcess wrapper requests return the enclosing test and its leading comments', () => {
  const source = `import test from 'node:test';
function prepare(f) { return f; }
// Run alone: node --test --test-name-pattern='captures prompt' runtime.test.mjs
test('captures prompt', async () => {
  const f = prepare({});
  f.options.launchProcess = (...args) => { captured = args[2]; return launch(...args); };
  await start(f);
});
// Keep the next test outside the excerpt.
test('unrelated', () => {});
`;
  const files = { 'runtime.test.mjs': source };
  const result = resolveSourceRequests(files, [{ path: 'runtime.test.mjs', search: 'f.options.launchProcess' }], { parse });
  assertExact(files, result);
  const snippet = result.snippets[0];
  assert.ok(snippet.text.startsWith('// Run alone:'));
  assert.ok(snippet.text.includes("test('captures prompt'"));
  assert.ok(snippet.text.includes('await start(f);'));
  assert.ok(!snippet.text.includes("test('unrelated'"));
  assert.equal(snippet.end, source.slice(snippet.source_end, snippet.source_end + snippet.end.length));
});

test('symbol requests bind named helpers, full classes, methods and constants while rejecting ambiguous local names', () => {
  const source = `// Helper signature and fixture defaults.
export function prepare({ targets = ['repo'] } = {}) { return targets; }
// Exported outcomes stay complete.
export const OUTCOMES = new Set(['done']);
class Runtime { start(value) { return value; } }
function first() { const duplicate = () => 1; return duplicate(); }
function second() { const duplicate = () => 2; return duplicate(); }
`;
  const files = { 'runtime.mjs': source };
  const result = resolveSourceRequests(files, ['prepare', 'OUTCOMES', 'Runtime.start'].map(symbol => ({ path: 'runtime.mjs', symbol })), { parse });
  assertExact(files, result);
  assert.ok(result.snippets[0].text.startsWith('// Helper signature'));
  assert.ok(result.snippets[1].text.startsWith('// Exported outcomes stay complete.\nexport const OUTCOMES'));
  assert.equal(result.snippets[2].text, 'start(value) { return value; } ');
  const classResult = resolveSourceRequests(files, [{ path: 'runtime.mjs', symbol: 'Runtime' }], { parse });
  assertExact(files, classResult);
  assert.equal(classResult.snippets[0].text, 'class Runtime { start(value) { return value; } }\n');
  assert.throws(() => resolveSourceRequests(files, [{ path: 'runtime.mjs', symbol: 'duplicate' }], { parse }), error =>
    error instanceof SourceRequestError && /ambiguous symbol/.test(error.message) && error.candidates.length === 2);
  assert.throws(() => resolveSourceRequests(files, [{ path: 'runtime.mjs', symbol: 'missing' }], { parse }), /symbol not found/);
});

test('tail and whole requests provide exact EOF bindings without parsing or changing frozen source', () => {
  const source = '// Long preamble\n' + ('unrelated line ' + 'x'.repeat(95) + '\n').repeat(700) + '// Final insertion context\nexport const final = true;\n';
  const files = Object.freeze({ 'module.mjs': source, 'small.txt': 'small\nfile\n' });
  const result = resolveSourceRequests(files, [{ path: 'module.mjs', tail: true }, { path: 'small.txt', whole: true }]);
  assertExact(files, result);
  assert.equal(result.snippets[0].end, null);
  assert.ok(result.snippets[0].text.endsWith('export const final = true;\n'));
  assert.ok(result.snippets[0].text.length <= 8000);
  assert.equal(result.snippets[1].text, 'small\nfile\n');
  assert.equal(files['module.mjs'], source);
});

test('tail selection bounds repeated-line anchor search', () => {
  const files = { 'repeated.txt': 'x\n'.repeat(20_000) };
  assert.throws(() => resolveSourceRequests(files, [{ path: 'repeated.txt', tail: true }]), /within 256 lines/);
});

test('literal ambiguity reports occurrence candidates and explicit occurrence selects the correct test', () => {
  const files = { 'test.mjs': "test('one', () => { launchProcess(); });\ntest('two', () => { launchProcess(); });\n" };
  assert.throws(() => resolveSourceRequests(files, [{ path: 'test.mjs', search: 'launchProcess' }], { parse }), error =>
    /ambiguous literal/.test(error.message) && error.matches === 2 && error.candidates[0].offset === 20 && error.candidates[1].header.includes("test('two'"));
  const selected = resolveSourceRequests(files, [{ path: 'test.mjs', search: 'launchProcess', occurrence: 1 }], { parse });
  assertExact(files, selected);
  assert.ok(selected.snippets[0].text.startsWith("test('two'"));
  assert.equal(selected.snippets[0].end, null);
  assert.throws(() => resolveSourceRequests(files, [{ path: 'test.mjs', search: 'launchProcess', occurrence: 2 }], { parse }), /out of range/);
});

test('source caps, selector validation and checkout path ownership fail closed', () => {
  const files = { 'large.mjs': 'export function large() {\n' + '  value();\n'.repeat(100) + '}\n', 'small.txt': 'small source\n' };
  assert.throws(() => resolveSourceRequests(files, [{ path: 'large.mjs', symbol: 'large' }], { parse, maxCharacters: 50 }), /exceeds 50/);
  assert.throws(() => resolveSourceRequests(files, [{ path: 'small.txt', whole: true }, { path: 'small.txt', whole: true }], { maxCharacters: 20 }), /exceeds 20/);
  assert.throws(() => resolveSourceRequests(files, [{ path: 'small.txt', tail: true }, { path: 'small.txt', whole: true }], { maxRequests: 1 }), /1\.\.1/);
  for (const path of ['../small.txt', '/small.txt', 'a/../small.txt', 'missing.txt', 'toString']) {
    assert.throws(() => resolveSourceRequests(files, [{ path, whole: true }]), /path/);
  }
  for (const request of [{ path: 'small.txt', whole: true, tail: true }, { path: 'small.txt', whole: false },
    { path: 'small.txt', search: '' }, { path: 'small.txt', search: 'small', occurrence: -1 },
    { path: 'small.txt', whole: true, occurrence: 0 }, { path: 'small.txt', whole: true, write: 'text' }]) {
    assert.throws(() => resolveSourceRequests(files, [request]), SourceRequestError);
  }
  assert.throws(() => resolveSourceRequests({ 'invalid.mjs': 'function broken(' }, [{ path: 'invalid.mjs', search: 'broken' }], { parse }), /cannot parse/);
});
