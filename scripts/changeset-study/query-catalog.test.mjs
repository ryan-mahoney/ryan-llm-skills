// Run alone: CHANGESET_TEST_PARSER=/path/to/acorn.mjs node --test scripts/changeset-study/query-catalog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { buildQueryCatalog } from './query-catalog.mjs';

async function parser() {
  assert.ok(process.env.CHANGESET_TEST_PARSER, 'Use the same Acorn module as the study');
  return (await import(pathToFileURL(process.env.CHANGESET_TEST_PARSER).href)).parse;
}

function assertAnchors(source, entry) {
  assert.ok(entry.start_offset >= 0 && entry.end_offset >= entry.start_offset);
  assert.equal(source.slice(entry.start_offset, entry.end_offset).length, entry.end_offset - entry.start_offset);
  if (entry.start_anchor !== undefined && entry.start_anchor !== null) {
    assert.ok(entry.start_anchor.length <= 160);
    assert.equal(source.indexOf(entry.start_anchor), entry.start_offset);
    assert.equal(source.lastIndexOf(entry.start_anchor), entry.start_offset);
  }
  if (entry.end_anchor !== undefined && entry.end_anchor !== null) {
    assert.ok(entry.end_anchor.length <= 160);
    assert.equal(source.indexOf(entry.end_anchor), entry.end_offset);
    assert.equal(source.lastIndexOf(entry.end_anchor), entry.end_offset);
  }
}

test('catalog keeps only named files and emits exact anchors for requested source and tests', async () => {
  const runtime = `import { test } from 'node:test';\nimport { helper as importedHelper } from './helper.mjs';\n\nexport class Runtime {\n  start() { return importedHelper(); }\n  finish() { return null; }\n}\n\nexport function localHelper() { return 1; }\n\ntest('seed calibration from latest usage', () => {});\ntest('other behavior', () => {});\n`;
  const tests = `import test from 'node:test';\n\nfunction fixture() {}\n\ntest('seed calibration from latest usage', () => {});\ntest('other behavior', () => {});\n`;
  const profile = '# Owner profile\n\nKeep behavior bounded.\n\n## Discovery\nRead named source first.\n';
  const files = { 'src/runtime.mjs': runtime, 'src/runtime.test.mjs': tests, 'pi/agents/spec-step-owner.md': profile,
    'src/elsewhere/runtime.mjs': 'export function unrelated() {}', 'src/unrelated.mjs': 'export const unrelated = 1;' };
  const brief = 'Update `src/runtime.mjs`, `src/runtime.test.mjs`, and `pi/agents/spec-step-owner.md`. Change Runtime.start to call importedHelper. Keep localHelper. Add the test `seed calibration from latest usage`. Create new module `src/new-module.mjs` (new-module.mjs); preserve `external.mjs` behavior. No `index.ts` change; it is absent from this snapshot.';
  const catalog = buildQueryCatalog(files, brief, { parse: await parser() });
  assert.deepEqual(catalog.files.map(file => file.path), ['pi/agents/spec-step-owner.md', 'src/new-module.mjs', 'src/runtime.mjs', 'src/runtime.test.mjs']);
  assert.deepEqual(catalog.files.find(file => file.path === 'src/new-module.mjs'), { path: 'src/new-module.mjs', exists: false, kind: 'absent' });
  assert.deepEqual(catalog.brief_refs.find(ref => ref.path === 'src/new-module.mjs'), { path: 'src/new-module.mjs', exists: false });
  assert.ok(!catalog.files.some(file => file.path === 'external.mjs'), 'unresolved bare names must not become writable absent paths');
  assert.deepEqual(catalog.unresolved_refs.find(ref => ref.reference === 'external.mjs'), {
    reference: 'external.mjs', reason: 'no matching path in the supplied source map and no full path identifies its location',
  });
  assert.ok(!catalog.files.some(file => file.path.endsWith('/index.ts') || file.path === 'index.ts'));
  assert.ok(catalog.unresolved_refs.some(ref => ref.reference === 'index.ts'));

  const runtimeFile = catalog.files.find(file => file.path === 'src/runtime.mjs');
  assert.ok(runtimeFile.symbols.some(symbol => symbol.name === 'localHelper' && symbol.detailed));
  assertAnchors(runtime, runtimeFile.symbols.find(symbol => symbol.name === 'localHelper'));
  const runtimeClass = runtimeFile.classes.find(item => item.name === 'Runtime');
  assert.ok(runtimeClass?.detailed);
  assert.ok(runtimeClass.methods.some(method => method.name === 'start' && method.detailed));
  assert.ok(runtimeClass.methods.some(method => method.name === 'finish' && !method.detailed));
  assertAnchors(runtime, runtimeClass);
  assertAnchors(runtime, runtimeClass.methods.find(method => method.name === 'start'));
  assertAnchors(runtime, runtimeFile.preamble);
  assert.equal(runtimeFile.preamble.start_anchor, runtime.slice(0, runtimeFile.preamble.start_anchor.length));

  const testFile = catalog.files.find(file => file.path === 'src/runtime.test.mjs');
  assert.ok(testFile.tests.some(item => item.name === 'seed calibration from latest usage' && item.detailed));
  assert.ok(testFile.tests.some(item => item.name === 'other behavior' && !item.detailed));
  assertAnchors(tests, testFile.tests.find(item => item.name === 'seed calibration from latest usage'));
  assertAnchors(tests, testFile.preamble);

  const profileFile = catalog.files.find(file => file.path === 'pi/agents/spec-step-owner.md');
  assert.deepEqual(profileFile.headings.map(item => item.text), ['Owner profile', 'Discovery']);
  for (const heading of profileFile.headings) assertAnchors(profile, heading);
});

test('catalog refuses an unresolved ambiguous basename instead of including unrelated files', async () => {
  const parse = await parser();
  assert.throws(() => buildQueryCatalog({ 'a/runtime.mjs': 'export function a() {}', 'b/runtime.mjs': 'export function b() {}' },
    'Update `runtime.mjs`.', { parse }), /needs-discovery: ambiguous basename runtime\.mjs/);
});

test('catalog fails closed when the complete catalog exceeds its byte cap', async () => {
  const parse = await parser();
  assert.throws(() => buildQueryCatalog({ 'src/runtime.mjs': 'export function target() {}' },
    'Update `src/runtime.mjs` and target.', { parse, maxBytes: 100 }), /needs-discovery: source catalog .* limit is 100/);
});

// Run alone: CHANGESET_TEST_PARSER=/path/to/acorn.mjs node --test --test-name-pattern='parent segments' scripts/changeset-study/query-catalog.test.mjs
test('catalog resolves parent segments within the checkout and leaves escaping references unresolved', async () => {
  const parse = await parser();
  const files = { 'lib/target.mjs': 'export function target() {}' };
  const catalog = buildQueryCatalog(files,
    'Update src/../lib/target.mjs target. Create src/../new.mjs. Preserve ../outside/file.mjs and src/../../escape.mjs.', { parse });
  assert.deepEqual(catalog.files.map(file => ({ path: file.path, exists: file.exists })), [
    { path: 'lib/target.mjs', exists: true }, { path: 'new.mjs', exists: false },
  ]);
  assert.deepEqual(catalog.unresolved_refs.map(ref => ref.reference), ['../outside/file.mjs', 'src/../../escape.mjs']);
  assert.ok(catalog.unresolved_refs.every(ref => ref.reason.includes('escapes the checkout')));
  assert.ok(!catalog.files.some(file => ['src/lib/target.mjs', 'outside/file.mjs', 'src/escape.mjs'].includes(file.path)));
});
