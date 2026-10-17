// Run alone: CHANGESET_TEST_PARSER=/path/to/acorn.mjs node --test scripts/changeset-study/query-catalog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  assert.ok(runtimeClass.method_inventory.some(([kind, name]) => kind === 'method' && name === 'finish'));
  assertAnchors(runtime, runtimeClass);
  assertAnchors(runtime, runtimeClass.methods.find(method => method.name === 'start'));
  assertAnchors(runtime, runtimeFile.preamble);
  assert.equal(runtimeFile.preamble.start_anchor, runtime.slice(0, runtimeFile.preamble.start_anchor.length));

  const testFile = catalog.files.find(file => file.path === 'src/runtime.test.mjs');
  assert.ok(testFile.tests.some(item => item.name === 'seed calibration from latest usage' && item.detailed));
  assert.ok(testFile.test_inventory.includes('other behavior'));
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

// Run alone: CHANGESET_TEST_PARSER=/path/to/acorn.mjs node --test --test-name-pattern='known absolute paths' scripts/changeset-study/query-catalog.test.mjs
test('catalog treats known absolute paths under the declared root as aliases without authorizing unknown paths', async () => {
  const parse = await parser();
  const files = {
    'scripts/spec-observe/steps.mjs': 'export function validateStepIndex() {}\n',
    'pi/extensions/spec-runtime/runtime.mjs': 'export function Runtime() {}\n',
  };
  const brief = `Use the bare name steps.mjs after identifying scripts/spec-observe/steps.mjs.\n` +
    'Path resolves from /work/pi/extensions/spec-runtime/ to /work/scripts/spec-observe/steps.mjs.\n' +
    'Keep ../outside/steps.mjs and /other/scripts/spec-observe/steps.mjs unchanged. Do not create /work/new-module.mjs.';
  const catalog = buildQueryCatalog(files, brief, { parse, sourceRoot: '/work' });
  assert.deepEqual(catalog.files.map(file => file.path), ['scripts/spec-observe/steps.mjs']);
  assert.equal(catalog.files.filter(file => file.path === 'work/scripts/spec-observe/steps.mjs').length, 0);
  assert.ok(catalog.unresolved_refs.some(ref => ref.reference === '/other/scripts/spec-observe/steps.mjs'));
  assert.ok(catalog.unresolved_refs.some(ref => ref.reference === '/work/new-module.mjs'));
  assert.ok(!catalog.files.some(file => file.exists === false), 'absolute paths cannot authorize absent writable entries');

  const rootFileCatalog = buildQueryCatalog({
    'rootfile.mjs': 'export const rootFile = true;\n',
    'nested/rootfile.mjs': 'export const nestedFile = true;\n',
  }, 'Update /work/rootfile.mjs.', { parse, sourceRoot: '/work' });
  assert.deepEqual(rootFileCatalog.files.map(file => file.path), ['rootfile.mjs'],
    'an absolute reference to an exact root file must not become ambiguous with a nested basename match');
});

// Run alone: CHANGESET_TEST_PARSER=/path/to/acorn.mjs CHANGESET_QUERY_CATALOG_REPRO_DIR=/path/to/11-fresh-owner-briefs/001-hard-dependency-handoff node --test --test-name-pattern='retained run-11' scripts/changeset-study/query-catalog.test.mjs
test('catalog resolves the retained run-11 handoff brief without copying it into a test fixture', { skip: !process.env.CHANGESET_QUERY_CATALOG_REPRO_DIR }, async () => {
  const root = process.env.CHANGESET_QUERY_CATALOG_REPRO_DIR;
  const task = JSON.parse(readFileSync(join(root, 'job.json'), 'utf8')).task;
  const brief = readFileSync(join(root, 'implementation-brief.md'), 'utf8');
  const catalog = buildQueryCatalog(task.files, brief, { parse: await parser(), sourceRoot: '/work' });
  assert.ok(catalog.files.some(file => file.path === 'scripts/spec-observe/steps.mjs'));
  assert.ok(!catalog.files.some(file => file.path === 'work/scripts/spec-observe/steps.mjs'));
  assert.ok(!catalog.unresolved_refs.some(ref => ref.reference === '/work/scripts/spec-observe/steps.mjs'));
});

// Run alone: CHANGESET_TEST_PARSER=/path/to/acorn.mjs node --test --test-name-pattern='constants and local helper' scripts/changeset-study/query-catalog.test.mjs
test('constants and local helper bindings retain exact signatures and leading comments with paired boundaries', async () => {
  const source = `// Transport environment names.
const TRANSPORT_ENV_NAMES = ['A', 'B']; // belongs to transport

// Fixed bootstrap program.
const ROOT_BOOTSTRAP = 'program';

// Owner command must stay in this module.
function nativeCommand(record, role, prompt, options = {}) { return options; }

function install() {
  // One local helper.
  const nestedHelper = (value, { enabled = true } = {}) => { return enabled ? value : null; };
  return nestedHelper;
}
function one() { const duplicate = () => 1; return duplicate(); }
function two() { const duplicate = () => 2; return duplicate(); }
const unrelated = 3;
`;
  const catalog = buildQueryCatalog({ 'src/runtime.mjs': source },
    'Update src/runtime.mjs TRANSPORT_ENV_NAMES ROOT_BOOTSTRAP nativeCommand nestedHelper duplicate.', { parse: await parser() });
  const file = catalog.files[0];
  const transport = file.symbols.find(item => item.name === 'TRANSPORT_ENV_NAMES');
  const bootstrap = file.symbols.find(item => item.name === 'ROOT_BOOTSTRAP');
  const command = file.symbols.find(item => item.name === 'nativeCommand');
  const local = file.symbols.find(item => item.name === 'nestedHelper');
  for (const item of [transport, bootstrap, command, local]) assertAnchors(source, item);
  assert.equal(source.slice(transport.start_offset, transport.end_offset), "// Transport environment names.\nconst TRANSPORT_ENV_NAMES = ['A', 'B']; // belongs to transport\n\n");
  assert.equal(source.slice(bootstrap.start_offset, bootstrap.end_offset), "// Fixed bootstrap program.\nconst ROOT_BOOTSTRAP = 'program';\n\n");
  assert.equal(bootstrap.end_offset, command.start_offset);
  assert.ok(source.slice(command.start_offset).startsWith('// Owner command must stay in this module.\nfunction nativeCommand'));
  assert.equal(command.signature, 'function nativeCommand(record, role, prompt, options = {})');
  assert.equal(bootstrap.signature, 'const ROOT_BOOTSTRAP =');
  assert.equal(local.signature, 'const nestedHelper = (value, { enabled = true } = {}) =>');
  assert.equal(local.kind, 'local-variable');
  assert.ok(source.slice(local.start_offset, local.end_offset).startsWith('// One local helper.'));
  assert.ok(!file.symbols.some(item => item.name === 'duplicate'), 'a repeated local name cannot identify one source binding');
  assert.ok(file.symbol_inventory.some(([kind, name]) => kind === 'const' && name === 'unrelated'), 'compact inventory retains unselected declaration kind and name');
});

// Run alone: CHANGESET_TEST_PARSER=/path/to/acorn.mjs node --test --test-name-pattern='named imported helpers' scripts/changeset-study/query-catalog.test.mjs
test('named imported helpers add uniquely resolved source signatures without guessing missing module locations', async () => {
  const files = {
    'src/deep/runtime.test.mjs': "import { fixture } from './fixture.mjs';\nimport { ignored } from './ignored.mjs';\nexport function testRuntime() {}\n",
    'src/deep/fixture.mjs': "export async function fixture({ targets = ['repo'] } = {}) { return targets; }\n",
    'src/deep/ignored.mjs': 'export function ignored() {}',
    'scripts/steps.mjs': 'export function validateStepIndex(index, options = {}) { return index; }\n',
  };
  const brief = 'Update src/deep/runtime.test.mjs using fixture. Create src/deep/handoff.mjs. Import `validateStepIndex` from `../../scripts/steps.mjs`. Preserve ../outside/missing.mjs.';
  const catalog = buildQueryCatalog(files, brief, { parse: await parser() });
  assert.ok(!catalog.files.some(file => file.path === 'src/deep/ignored.mjs'));
  const fixture = catalog.files.find(file => file.path === 'src/deep/fixture.mjs').symbols.find(item => item.name === 'fixture');
  const validate = catalog.files.find(file => file.path === 'scripts/steps.mjs').symbols.find(item => item.name === 'validateStepIndex');
  assert.equal(fixture.signature, "export async function fixture({ targets = ['repo'] } = {})");
  assert.equal(validate.signature, 'export function validateStepIndex(index, options = {})');
  assert.deepEqual(catalog.import_refs.find(ref => ref.reference === '../../scripts/steps.mjs'), { reference: '../../scripts/steps.mjs', path: 'scripts/steps.mjs' });
  assert.ok(!catalog.unresolved_refs.some(ref => ref.reference === '../../scripts/steps.mjs'));
  assertAnchors(files['src/deep/fixture.mjs'], fixture);
  assertAnchors(files['scripts/steps.mjs'], validate);
  assert.ok(!catalog.files.some(file => file.path === 'outside/missing.mjs'));
  assert.ok(catalog.unresolved_refs.some(ref => ref.reference === '../outside/missing.mjs'));
});
