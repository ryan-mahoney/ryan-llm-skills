// CHANGESET_TEST_PARSER="$ACORN_MODULE" node --test scripts/changeset-study/candidate-checks.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { changedTestCommands } from './candidate-checks.mjs';

test('selected parent tests run dynamic children without selecting unrelated failures or regex calls', async () => {
  const { parse } = await import(process.env.CHANGESET_TEST_PARSER || 'acorn');
  const root = mkdtempSync(join(tmpdir(), 'candidate-test-selection-'));
  try {
    const path = "quoted'name.test.mjs";
    const original = "import test from 'node:test'; import assert from 'node:assert/strict';\ntest('old',()=>{throw Error('must be skipped')});\n";
    const updated = original + "test('new [case]', async t => { for (const name of ['a','b']) await t.test(name, () => assert.equal(/x/.test('x'), true)); });\n";
    const [selected] = changedTestCommands({ [path]: original }, { [path]: updated }, parse);
    assert.deepEqual(selected.names, ['new [case]']);
    writeFileSync(join(root, path), updated);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync('/bin/sh', ['-c', selected.command], { cwd: root, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# pass 3\b/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('helper-only changes and dynamic top-level names fall back to the complete changed file', async () => {
  const { parse } = await import(process.env.CHANGESET_TEST_PARSER || 'acorn');
  const before = "import test from 'node:test'; const value=1; test('existing',()=>value);";
  const after = before.replace('value=1', 'value=2');
  const [helper] = changedTestCommands({ 'unit.test.mjs': before }, { 'unit.test.mjs': after }, parse);
  assert.equal(helper.names, null);
  assert.equal(helper.command, "node --test 'unit.test.mjs'");
  const [dynamic] = changedTestCommands({}, { 'unit.test.mjs': "import test from 'node:test'; for(const name of ['a']) test(name,()=>{});" }, parse);
  assert.equal(dynamic.names, null);
});
