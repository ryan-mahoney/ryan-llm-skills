// Focused run: node --test --test-name-pattern='<case name>' scripts/changeset/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, hash } from './workspace.mjs';
import { compile, execute } from './engine.mjs';
const plan = operations => ({ schema_version: 1, operations });
const op = (id, path, edits, extra = {}) => ({ id, reads: [], writes: [path], depends_on: [], executor: 'deterministic', edits, ...extra });
const replace = (path, search, text) => ({ kind: 'replace', path, search, text });
const model = (id, path, extra = {}) => op(id, path, undefined, { executor: 'simple', instruction: 'Edit', ...extra });
function disk(t) { const root = mkdtempSync(join(tmpdir(), 'changeset-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test('dependent edits see current file and mechanical operations compose', async () => {
  const ws = new Workspace({ 'a.mjs': 'export const a = 1;\n', 'config.json': '{"flags":{}}', 'old.txt': 'keep' });
  const p = plan([
    op('first', 'a.mjs', [replace('a.mjs', 'a = 1', 'b = 1')]),
    op('second', 'a.mjs', [replace('a.mjs', 'b = 1', 'b = 2')]),
    op('config', 'config.json', [{ kind: 'json-set', path: 'config.json', keys: ['flags', 'enabled'], value: true }]),
    op('move', 'old.txt', [{ kind: 'rename', path: 'old.txt', to: 'new.txt' }], { writes: ['old.txt', 'new.txt'] }),
  ]);
  const r = await execute(p, ws);
  assert.equal(r.ok, true); assert.equal(ws.read('a.mjs'), 'export const b = 2;\n');
  assert.equal(ws.read('old.txt'), null); assert.equal(ws.read('new.txt'), 'keep');
  assert.deepEqual(JSON.parse(ws.read('config.json')), { flags: { enabled: true } });
  assert.equal(r.metrics.model_calls, 0);
});

test('independent model work overlaps and same-file work observes its predecessor', async () => {
  let release; const barrier = new Promise(resolve => { release = resolve; }); let entered = 0; const observations = [];
  const ws = new Workspace({ 'a': '0', 'b': '0' });
  const adapter = async ({ operation, files }) => {
    observations.push([operation.id, files.a]);
    if (operation.id !== 'third') { if (++entered === 2) release(); await barrier; }
    return { files: { [operation.writes[0]]: String(Number(files[operation.writes[0]]) + 1) } };
  };
  const r = await execute(plan([model('first', 'a'), model('second', 'b'), model('third', 'a')]), ws, { adapters: { simple: adapter }, concurrency: 2 });
  assert.equal(r.ok, true); assert.equal(r.metrics.peak_concurrency, 2); assert.equal(ws.read('a'), '2');
  assert.deepEqual(observations.find(x => x[0] === 'third'), ['third', '1']);
});

test('failed operation blocks descendants and rolls back independent staged edits', async () => {
  const ws = new Workspace({ a: 'old', b: 'old' });
  const r = await execute(plan([
    op('good', 'b', [replace('b', 'old', 'new')]),
    op('bad', 'a', [replace('a', 'missing', 'new')]),
    op('dependent', 'a', [replace('a', 'old', 'later')], { depends_on: ['bad'] }),
  ]), ws);
  assert.equal(r.ok, false); assert.equal(r.metrics.blocked, 1); assert.deepEqual(ws.snapshot(), { a: 'old', b: 'old' });
});

test('ambiguous replacement and stale precondition fail without partial writes', async () => {
  for (const edits of [[replace('a', 'x', 'y')], [{ kind: 'create', path: 'b', text: 'new' }, replace('a', 'missing', 'y')]]) {
    const ws = new Workspace({ a: 'xx' });
    const r = await execute(plan([op('edit', 'a', edits, { writes: ['a', 'b'] })]), ws);
    assert.equal(r.ok, false); assert.deepEqual(ws.snapshot(), { a: 'xx' });
  }
  const ws = new Workspace({ a: 'x' });
  const r = await execute(plan([op('edit', 'a', [replace('a', 'x', 'y')], { preconditions: { a: hash('wrong') } })]), ws);
  assert.equal(r.ok, false); assert.equal(ws.read('a'), 'x');
});

test('model output cannot write outside declared ownership', async () => {
  const ws = new Workspace({ a: 'x', b: 'private' });
  const r = await execute(plan([model('edit', 'a')]), ws, { adapters: { simple: async () => ({ files: { a: 'ok', b: 'corrupt' } }) } });
  assert.equal(r.ok, false); assert.deepEqual(ws.snapshot(), { a: 'x', b: 'private' });
});

test('behavioral verification rejects valid-looking but incorrect changes', async () => {
  const ws = new Workspace({ a: '1' });
  const r = await execute(plan([op('edit', 'a', [replace('a', '1', '2')])]), ws, { verify: staged => staged.read('a') === '3' });
  assert.equal(r.verification.status, 'failed'); assert.equal(r.ok, false); assert.equal(ws.read('a'), '1');
});

test('compile rejects dependency cycles and escaping paths before any executor runs', () => {
  assert.throws(() => compile(plan([model('one', 'a', { depends_on: ['two'] }), model('two', 'b', { depends_on: ['one'] })])), /cycle/);
  for (const path of ['../outside', '/absolute', 'a/../b', '.git/config', 'a\\b']) assert.throws(() => compile(plan([model('one', path)])), /path/);
});

test('publication detects changed read inputs and preserves external edits', async t => {
  const root = disk(t); writeFileSync(join(root, 'a'), 'old'); writeFileSync(join(root, 'read'), 'context');
  const ws = Workspace.load(root); ws.apply({ a: 'new' }); writeFileSync(join(root, 'read'), 'external');
  assert.throws(() => ws.publish(), /Stale/); assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'old');
  assert.equal(readFileSync(join(root, 'read'), 'utf8'), 'external');
});

test('publication rolls back synchronous failure and preserves executable modes', t => {
  const root = disk(t); writeFileSync(join(root, 'a'), 'old', { mode: 0o755 }); writeFileSync(join(root, 'b'), 'old');
  const ws = Workspace.load(root); ws.apply({ a: 'new', b: 'new' });
  assert.throws(() => ws.publish({ beforeWrite: p => { if (p === 'b') throw new Error('disk failure'); } }), /disk failure/);
  assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'old'); assert.equal(statSync(join(root, 'a')).mode & 0o777, 0o755);
  ws.publish(); assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'new'); assert.equal(statSync(join(root, 'a')).mode & 0o777, 0o755);
});

test('workspace rejects symlink traversal and file-directory collisions', t => {
  const root = disk(t); symlinkSync(tmpdir(), join(root, 'outside')); assert.throws(() => Workspace.load(root), /Symlink/);
  const ws = new Workspace({ a: 'x' }); assert.throws(() => ws.apply({ 'a/b': 'y' }), /collision/); assert.deepEqual(ws.snapshot(), { a: 'x' });
});

test('ancestor collision is rejected even when another name sorts between paths', () => {
  const ws = new Workspace({ a: 'file', 'a-b': 'other' });
  assert.throws(() => ws.apply({ 'a/c': 'nested' }), /collision/);
  assert.deepEqual(ws.snapshot(), { a: 'file', 'a-b': 'other' });
});

test('compiler derives mechanical deletion and rename ownership without a model retry', async () => {
  const ws = new Workspace({ old: 'preserved', obsolete: 'remove' });
  const r = await execute(plan([
    op('rename_file', 'new', [{ kind: 'rename', path: 'old', to: 'new' }], { reads: ['old'] }),
    op('delete_file', 'obsolete', [{ kind: 'delete', path: 'obsolete' }], { writes: [] }),
  ]), ws);
  assert.equal(r.ok, true); assert.deepEqual(ws.snapshot(), { new: 'preserved' });
});

test('invalid generated syntax becomes an execution exception without publication', async () => {
  const ws = new Workspace({ 'a.mjs': 'export const x = 1;' });
  const r = await execute(plan([model('edit', 'a.mjs')]), ws, { adapters: { simple: async () => ({ files: { 'a.mjs': 'const name = ypeof record;' } }) } });
  assert.equal(r.ok, false); assert.match(r.operations[0].error, /Syntax check/); assert.equal(ws.read('a.mjs'), 'export const x = 1;');
});

test('renamed executable keeps its source mode', async t => {
  const root = disk(t); writeFileSync(join(root, 'old'), '#!/bin/sh\n', { mode: 0o755 });
  const ws = Workspace.load(root);
  const r = await execute(plan([op('move', 'new', [{ kind: 'rename', path: 'old', to: 'new' }], { reads: ['old'] })]), ws);
  assert.equal(r.ok, true); ws.publish(); assert.equal(statSync(join(root, 'new')).mode & 0o777, 0o755);
});


test('publication supports file-directory transitions and restores directories on failure', t => {
  const root = disk(t); writeFileSync(join(root, 'a'), 'old');
  const ws = Workspace.load(root); ws.apply({ a: null, 'a/b': 'new', z: 'last' });
  assert.throws(() => ws.publish({ beforeWrite: p => { if (p === 'z') throw new Error('injected'); } }), /injected/);
  assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'old');
  ws.publish(); assert.equal(readFileSync(join(root, 'a/b'), 'utf8'), 'new');
  ws.apply({ 'a/b': null, a: 'restored', z: 'changed' });
  assert.throws(() => ws.publish({ beforeWrite: p => { if (p === 'z') throw new Error('injected'); } }), /injected/);
  assert.equal(readFileSync(join(root, 'a/b'), 'utf8'), 'new');
  ws.publish(); assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'restored');
});

test('rollback removes created directories and publication preserves mode despite umask', t => {
  const root = disk(t); writeFileSync(join(root, 'existing'), 'old'); chmodSync(join(root, 'existing'), 0o664);
  const ws = Workspace.load(root); ws.apply({ existing: 'changed', 'new/deep/a': 'a', z: 'z' });
  assert.throws(() => ws.publish({ beforeWrite: p => { if (p === 'z') throw new Error('injected'); } }), /injected/);
  assert.equal(existsSync(join(root, 'new')), false);
  assert.equal(readFileSync(join(root, 'existing'), 'utf8'), 'old');
  const mask = process.umask(0o077);
  try { ws.publish(); } finally { process.umask(mask); }
  assert.equal(statSync(join(root, 'existing')).mode & 0o777, 0o664);
});

test('directory transition refuses untracked files and restores earlier removals', t => {
  const root = disk(t); mkdirSync(join(root, 'a')); writeFileSync(join(root, 'a/b'), 'old');
  const ws = Workspace.load(root); ws.apply({ 'a/b': null, a: 'new' });
  writeFileSync(join(root, 'a/external'), 'preserve');
  assert.throws(() => ws.publish(), /Untracked/);
  assert.equal(readFileSync(join(root, 'a/b'), 'utf8'), 'old');
  assert.equal(readFileSync(join(root, 'a/external'), 'utf8'), 'preserve');
});


test('new files named like object properties use default modes', t => {
  const root=disk(t), ws=Workspace.load(root);
  ws.apply({constructor:'value',toString:'other'});ws.publish();
  assert.equal(readFileSync(join(root,'constructor'),'utf8'),'value');
  assert.equal(statSync(join(root,'constructor')).mode & 0o777,0o644);
  assert.equal(readFileSync(join(root,'toString'),'utf8'),'other');
});
