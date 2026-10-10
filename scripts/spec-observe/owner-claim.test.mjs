// Real transaction and competing-process proof for the shared keyed ownership
// claim. Focused command: node --test scripts/spec-observe/owner-claim.test.mjs
// Synthetic OS observations replace only inspectProcess boundaries that cannot
// be forced (PID reuse, unknown liveness); the claimed self identity stays the
// actual test process. Every child is owned by this test and is terminated
// before its temporary fixture is removed. No fixed sleeps are used; IPC
// barriers and exit events sequence the cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { claimOwner } from './owner-claim.mjs';
import { inspectProcess, processIdentity } from './process-identity.mjs';
import { claimHost } from '../../pi/extensions/spec-runtime/sentinel-host-owner.mjs';

const claimModuleUrl = new URL('./owner-claim.mjs', import.meta.url).href;
const OWNER_SCHEMA = 'CREATE TABLE IF NOT EXISTS owner_claims (key TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at TEXT NOT NULL, token TEXT NOT NULL) STRICT';

const CHILD_SOURCE = `
import { claimOwner } from ${JSON.stringify(claimModuleUrl)};
import { DatabaseSync } from 'node:sqlite';

const [mode, database, key] = process.argv.slice(2);
const send = (type, extra = {}) => { if (process.connected) process.send({ type, ...extra }); };
let lease = null;
let held = null;

if (mode === 'hold') {
  process.on('message', message => {
    if (!message || message.type !== 'hold') return;
    if (!held) {
      const db = new DatabaseSync(database);
      db.exec('BEGIN IMMEDIATE');
      db.exec(${JSON.stringify(OWNER_SCHEMA)});
      if (message.write) {
        db.prepare('INSERT INTO owner_claims (key, pid, started_at, token) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at, token = excluded.token')
          .run(message.write.key, message.write.pid, message.write.started_at, message.write.token);
      }
      held = db;
    }
    send('holding');
  });
} else if (mode === 'once') {
  process.on('message', message => {
    if (message && message.type === 'ack') { process.exit(0); return; }
    if (!message || message.type !== 'go') return;
    let claimed;
    try { claimed = claimOwner({ database, key }); }
    catch (error) { send('refused', { message: error.message }); return; }
    send('admitted', { pid: claimed.pid, token: claimed.token, started_at: claimed.started_at });
  });
} else {
  process.on('message', message => {
    if (!message) return;
    if (message.type === 'go') {
      try {
        lease = claimOwner({ database, key });
        send('admitted', { pid: lease.pid, token: lease.token, started_at: lease.started_at });
      } catch (error) {
        send('refused', { message: error.message });
      }
    } else if (message.type === 'release') {
      try { if (lease) lease.release(); lease = null; send('released'); }
      catch (error) { send('release-error', { message: error.message }); }
    }
  });
}
process.on('disconnect', () => process.exit(0));
send('ready');
`;

function createClient(child) {
  const queue = [];
  const waiters = [];
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    const error = new Error(`owned claim child exited (${signal ?? code})`);
    for (const waiter of waiters.splice(0)) waiter.reject(error);
    resolve({ code, signal });
  }));
  child.on('message', message => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else queue.push(message);
  });
  const next = () => {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
  const wait = async types => {
    const wanted = Array.isArray(types) ? types : [types];
    for (;;) {
      const message = await next();
      if (wanted.includes(message.type)) return message;
    }
  };
  return { child, exited, send: message => child.send(message), wait };
}

function sandbox(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'owner-claim-')));
  const database = join(directory, 'coordination.sqlite');
  const script = join(directory, 'claim-child.mjs');
  writeFileSync(script, CHILD_SOURCE);
  const children = [];
  const spawnChild = (mode, key) => {
    const child = fork(script, [mode, database, key], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [] });
    const client = createClient(child);
    children.push(client);
    return client;
  };
  t.after(async () => {
    for (const client of children) client.child.kill('SIGKILL');
    await Promise.all(children.map(client => client.exited));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, database, spawnChild };
}

function seed(database, row) {
  const db = new DatabaseSync(database);
  try {
    db.exec(OWNER_SCHEMA);
    db.prepare('INSERT INTO owner_claims (key, pid, started_at, token) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at, token = excluded.token')
      .run(row.key, row.pid, row.started_at, row.token);
  } finally {
    db.close();
  }
}

function read(database, key) {
  const db = new DatabaseSync(database);
  try {
    return db.prepare('SELECT key, pid, started_at, token FROM owner_claims WHERE key = ?').get(key);
  } finally {
    db.close();
  }
}

const rowShape = row => (row === undefined ? undefined
  : { key: row.key, pid: row.pid, started_at: row.started_at, token: row.token });

async function exitedProcessPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await once(child, 'exit');
  return pid;
}

test('two competing real child claimers admit exactly one live owner', async t => {
  const f = sandbox(t);
  const key = 'sentinel-host';
  const first = f.spawnChild('claim', key);
  const second = f.spawnChild('claim', key);
  await Promise.all([first.wait('ready'), second.wait('ready')]);
  first.send({ type: 'go' });
  second.send({ type: 'go' });
  const outcomes = await Promise.all([first.wait(['admitted', 'refused']), second.wait(['admitted', 'refused'])]);
  const admitted = outcomes.filter(outcome => outcome.type === 'admitted');
  const refused = outcomes.filter(outcome => outcome.type === 'refused');
  assert.equal(admitted.length, 1, 'exactly one child is admitted');
  assert.equal(refused.length, 1, 'the other child is refused');
  assert.match(refused[0].message, /live pid|already held/);

  const winner = outcomes[0].type === 'admitted' ? first : second;
  const loser = winner === first ? second : first;
  // The admitted child holds the lease until explicit release.
  loser.send({ type: 'go' });
  assert.equal((await loser.wait(['admitted', 'refused'])).type, 'refused', 'the held lease still refuses');
  winner.send({ type: 'release' });
  assert.equal((await winner.wait('released')).type, 'released');
  loser.send({ type: 'go' });
  assert.equal((await loser.wait(['admitted', 'refused'])).type, 'admitted', 'an explicit release admits the waiting claimant');
  loser.send({ type: 'release' });
  await loser.wait('released');
  assert.ok(statSync(f.database).isFile(), 'coordination database is retained after release');
});

test('competing reclaim of a confirmed dead prior owner admits exactly one', async t => {
  const f = sandbox(t);
  const key = 'sentinel-host';
  const deadPid = await exitedProcessPid();
  seed(f.database, { key, pid: deadPid, started_at: 'dead-prior-start', token: 'dead-prior-token' });
  const first = f.spawnChild('claim', key);
  const second = f.spawnChild('claim', key);
  await Promise.all([first.wait('ready'), second.wait('ready')]);
  first.send({ type: 'go' });
  second.send({ type: 'go' });
  const outcomes = await Promise.all([first.wait(['admitted', 'refused']), second.wait(['admitted', 'refused'])]);
  const admitted = outcomes.filter(outcome => outcome.type === 'admitted');
  const refused = outcomes.filter(outcome => outcome.type === 'refused');
  assert.equal(admitted.length, 1, 'exactly one reclaimer is admitted');
  assert.equal(refused.length, 1, 'the other reclaimer is refused');
  const winner = outcomes[0].type === 'admitted' ? first : second;
  assert.equal(rowShape(read(f.database, key)).token, admitted[0].token, 'the admitted reclaimer owns the row');
  winner.send({ type: 'release' });
  await winner.wait('released');
  assert.equal(read(f.database, key), undefined, 'the released row is deleted');
});

test('default real self claim refuses a second same-process lease', async t => {
  const f = sandbox(t);
  const key = 'sentinel-host';
  const lease = claimOwner({ database: f.database, key });
  t.after(() => { try { lease.release(); } catch { /* already released */ } });
  assert.equal(lease.pid, process.pid);
  assert.match(lease.started_at, /\S/);
  assert.throws(() => claimOwner({ database: f.database, key }), /live pid|already held/);
  assert.equal(rowShape(read(f.database, key)).token, lease.token, 'the refused call leaves the held row unchanged');
  lease.release();
  lease.release();
  const reclaim = claimOwner({ database: f.database, key });
  assert.notEqual(reclaim.token, lease.token, 'a fresh release permits a fresh token');
  reclaim.release();
});

test('distinct keys coexist and release is idempotent while the database is retained', async t => {
  const f = sandbox(t);
  const alpha = claimOwner({ database: f.database, key: 'alpha' });
  const beta = claimOwner({ database: f.database, key: 'beta' });
  t.after(() => {
    try { alpha.release(); } catch { /* already released */ }
    try { beta.release(); } catch { /* already released */ }
  });
  assert.notEqual(alpha.token, beta.token);
  assert.equal(rowShape(read(f.database, 'alpha')).token, alpha.token);
  assert.equal(rowShape(read(f.database, 'beta')).token, beta.token);
  alpha.release();
  alpha.release();
  assert.equal(read(f.database, 'alpha'), undefined, 'the released key row is deleted');
  assert.equal(rowShape(read(f.database, 'beta')).token, beta.token, 'a different key is untouched');
  assert.ok(statSync(f.database).isFile(), 'database file is retained after release');
  const reclaim = claimOwner({ database: f.database, key: 'alpha' });
  assert.notEqual(reclaim.token, alpha.token);
  reclaim.release();
  beta.release();
});

test('an alive same-pid row with a different start is replaced as a reused identity', async t => {
  const f = sandbox(t);
  const key = 'sentinel-host';
  seed(f.database, { key, pid: process.pid, started_at: 'previous-start-text', token: 'previous-token' });
  const lease = claimOwner({ database: f.database, key });
  t.after(() => { try { lease.release(); } catch { /* already released */ } });
  assert.equal(lease.pid, process.pid);
  const row = rowShape(read(f.database, key));
  assert.equal(row.started_at, lease.started_at, 'the row carries the freshly observed start');
  assert.notEqual(row.started_at, 'previous-start-text');
  assert.equal(row.token, lease.token);
});

test('a foreign identity is refused even when inspect reports it alive', async t => {
  const f = sandbox(t);
  const foreign = { pid: process.pid + 1, started_at: 'foreign-start' };
  const inspect = pid => ({ state: 'alive', pid, started_at: 'foreign-start' });
  assert.throws(() => claimOwner({ database: f.database, key: 'sentinel-host', identity: foreign, inspect }), /not this process/);
  assert.equal(existsSync(f.database), false, 'a foreign identity creates no database');
});

test('caller mutation of the supplied identity still releases the original row', async t => {
  const f = sandbox(t);
  const key = 'sentinel-host';
  const identity = { ...processIdentity(process.pid) };
  const lease = claimOwner({ database: f.database, key, identity });
  const original = { pid: lease.pid, started_at: lease.started_at };
  identity.pid = process.pid + 1;
  identity.started_at = 'mutated-start';
  lease.release();
  assert.equal(lease.pid, original.pid, 'the receipt keeps the original pid');
  assert.equal(lease.started_at, original.started_at, 'the receipt keeps the original start');
  assert.equal(read(f.database, key), undefined, 'release still deletes the originally acquired row');
});

test('unknown owner identity refuses reclaim and leaves the row unchanged', async t => {
  const f = sandbox(t);
  const key = 'sentinel-host';
  const otherPid = process.pid + 1;
  seed(f.database, { key, pid: otherPid, started_at: 'other-start', token: 'other-token' });
  const inspect = pid => (pid === process.pid ? inspectProcess(pid) : { state: 'unknown', pid, reason: 'synthetic-unknown' });
  assert.throws(() => claimOwner({ database: f.database, key, inspect }), /unknown/);
  assert.deepEqual(rowShape(read(f.database, key)),
    { key, pid: otherPid, started_at: 'other-start', token: 'other-token' });
});

test('malformed stored owner rows and schema refuse acquisition', async t => {
  const f = sandbox(t);
  seed(f.database, { key: 'zero-pid', pid: 0, started_at: 'start', token: 'token' });
  assert.throws(() => claimOwner({ database: f.database, key: 'zero-pid' }), /malformed/);
  assert.deepEqual(rowShape(read(f.database, 'zero-pid')),
    { key: 'zero-pid', pid: 0, started_at: 'start', token: 'token' });
  seed(f.database, { key: 'empty-start', pid: process.pid, started_at: '', token: 'token' });
  assert.throws(() => claimOwner({ database: f.database, key: 'empty-start' }), /malformed/);
  const wrong = join(f.directory, 'wrong.sqlite');
  const db = new DatabaseSync(wrong);
  db.exec('CREATE TABLE owner_claims (key TEXT PRIMARY KEY) STRICT');
  db.close();
  assert.throws(() => claimOwner({ database: wrong, key: 'shape' }), /ownership/);
  assert.ok(statSync(wrong).isFile(), 'the wrong-shape database is retained');

  const nonStrict = join(f.directory, 'non-strict.sqlite');
  const plain = new DatabaseSync(nonStrict);
  plain.exec('CREATE TABLE owner_claims (key TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at TEXT NOT NULL, token TEXT NOT NULL)');
  plain.prepare('INSERT INTO owner_claims (key, pid, started_at, token) VALUES (?, ?, ?, ?)')
    .run('shape', process.pid + 1, 'non-strict-start', 'non-strict-token');
  plain.close();
  assert.throws(() => claimOwner({ database: nonStrict, key: 'shape' }), /STRICT schema/);
  assert.deepEqual(rowShape(read(nonStrict, 'shape')),
    { key: 'shape', pid: process.pid + 1, started_at: 'non-strict-start', token: 'non-strict-token' },
    'non-STRICT records are intact');

  const noPk = join(f.directory, 'no-pk.sqlite');
  const unkeyed = new DatabaseSync(noPk);
  unkeyed.exec('CREATE TABLE owner_claims (key TEXT NOT NULL, pid INTEGER NOT NULL, started_at TEXT NOT NULL, token TEXT NOT NULL) STRICT');
  unkeyed.prepare('INSERT INTO owner_claims (key, pid, started_at, token) VALUES (?, ?, ?, ?)')
    .run('shape', process.pid + 1, 'no-pk-start', 'no-pk-token');
  unkeyed.close();
  assert.throws(() => claimOwner({ database: noPk, key: 'shape' }), /STRICT schema/);
  assert.deepEqual(rowShape(read(noPk, 'shape')),
    { key: 'shape', pid: process.pid + 1, started_at: 'no-pk-start', token: 'no-pk-token' },
    'STRICT no-PK records are intact');
});

test('release of a stale token leaves a synthetic successor row intact', async t => {
  const f = sandbox(t);
  const key = 'sentinel-host';
  const lease = claimOwner({ database: f.database, key });
  seed(f.database, { key, pid: process.pid + 1, started_at: 'successor-start', token: 'successor-token' });
  lease.release();
  lease.release();
  assert.deepEqual(rowShape(read(f.database, key)),
    { key, pid: process.pid + 1, started_at: 'successor-start', token: 'successor-token' });
});

test('a committed owner that exited without release permits reclaim', async t => {
  const f = sandbox(t);
  const key = 'sentinel-host';
  const child = f.spawnChild('once', key);
  await child.wait('ready');
  child.send({ type: 'go' });
  const admitted = await child.wait('admitted');
  child.send({ type: 'ack' });
  const exited = await child.exited;
  assert.equal(exited.signal, null);
  assert.equal(exited.code, 0);
  assert.equal(rowShape(read(f.database, key)).pid, admitted.pid, 'the exited owner row remains committed');
  assert.notEqual(admitted.pid, process.pid);
  const lease = claimOwner({ database: f.database, key });
  t.after(() => { try { lease.release(); } catch { /* already released */ } });
  assert.equal(lease.pid, process.pid);
  assert.equal(rowShape(read(f.database, key)).token, lease.token);
});

test('a live committed owner child crash permits reclaim after exit', async t => {
  const f = sandbox(t);
  const key = 'sentinel-host';
  const child = f.spawnChild('claim', key);
  await child.wait('ready');
  child.send({ type: 'go' });
  const admitted = await child.wait('admitted');
  child.child.kill('SIGKILL');
  const exited = await child.exited;
  assert.equal(exited.signal, 'SIGKILL');
  assert.equal(rowShape(read(f.database, key)).token, admitted.token, 'the crashed owner row is still committed');
  const lease = claimOwner({ database: f.database, key });
  t.after(() => { try { lease.release(); } catch { /* already released */ } });
  assert.equal(lease.pid, process.pid);
  assert.notEqual(lease.token, admitted.token);
});

test('an interrupted acquisition rolls back and abandons no lock', async t => {
  const f = sandbox(t);
  const key = 'sentinel-host';
  const deadPid = await exitedProcessPid();
  seed(f.database, { key, pid: deadPid, started_at: 'prior-start', token: 'prior-token' });
  const holder = f.spawnChild('hold', key);
  await holder.wait('ready');
  holder.send({ type: 'hold', write: { key, pid: holder.child.pid, started_at: 'child-start', token: 'child-token' } });
  await holder.wait('holding');
  holder.child.kill('SIGKILL');
  const exited = await holder.exited;
  assert.equal(exited.signal, 'SIGKILL');
  assert.deepEqual(rowShape(read(f.database, key)),
    { key, pid: deadPid, started_at: 'prior-start', token: 'prior-token' }, 'the uncommitted child row is rolled back');
  const lease = claimOwner({ database: f.database, key });
  t.after(() => { try { lease.release(); } catch { /* already released */ } });
  assert.equal(lease.pid, process.pid, 'the real claim succeeds without an abandoned lock');
});

test('a bounded lock timeout fails closed while a real child holds the write lock', async t => {
  const f = sandbox(t);
  const key = 'sentinel-host';
  const deadPid = await exitedProcessPid();
  seed(f.database, { key, pid: deadPid, started_at: 'prior-start', token: 'prior-token' });
  const holder = f.spawnChild('hold', key);
  await holder.wait('ready');
  holder.send({ type: 'hold' });
  await holder.wait('holding');
  assert.throws(() => claimOwner({ database: f.database, key, timeoutMs: 250 }), /locked|busy|ownership/);
  assert.deepEqual(rowShape(read(f.database, key)),
    { key, pid: deadPid, started_at: 'prior-start', token: 'prior-token' }, 'the locked row is unchanged');
  holder.child.kill('SIGKILL');
  await holder.exited;
  const lease = claimOwner({ database: f.database, key });
  t.after(() => { try { lease.release(); } catch { /* already released */ } });
  assert.equal(lease.pid, process.pid);
});

test('path and input validation rejects unsafe targets without deleting them', async t => {
  const f = sandbox(t);
  const key = 'sentinel-host';
  assert.throws(() => claimOwner({ database: 'coordination.sqlite', key }), /absolute/);
  assert.throws(() => claimOwner({ database: join(f.directory, 'missing', 'coordination.sqlite'), key }), /parent directory/);
  const alias = join(f.directory, 'alias');
  symlinkSync(f.directory, alias);
  assert.throws(() => claimOwner({ database: join(alias, 'coordination.sqlite'), key }), /not canonical/);
  assert.throws(() => claimOwner({ database: f.database, key: '' }), /key/);
  assert.throws(() => claimOwner({ database: f.database, key: 'x'.repeat(257) }), /key/);
  assert.throws(() => claimOwner({ database: f.database, key: 7 }), /key/);
  assert.throws(() => claimOwner({ database: f.database, key, timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => claimOwner({ database: f.database, key, timeoutMs: 5001 }), /timeoutMs/);
  assert.throws(() => claimOwner({ database: f.database, key, timeoutMs: 1.5 }), /timeoutMs/);

  const target = join(f.directory, 'target.sqlite');
  writeFileSync(target, 'target contents');
  const linked = join(f.directory, 'linked.sqlite');
  symlinkSync(target, linked);
  assert.throws(() => claimOwner({ database: linked, key }), /symlink/);
  assert.ok(lstatSync(linked).isSymbolicLink(), 'the database symlink is not removed');
  assert.equal(readFileSync(target, 'utf8'), 'target contents');

  const dangling = join(f.directory, 'dangling.sqlite');
  symlinkSync(join(f.directory, 'nowhere.sqlite'), dangling);
  assert.throws(() => claimOwner({ database: dangling, key }), /symlink/);
  assert.ok(lstatSync(dangling).isSymbolicLink());

  const directory = join(f.directory, 'directory.sqlite');
  mkdirSync(directory);
  assert.throws(() => claimOwner({ database: directory, key }), /not a regular file/);
  assert.ok(lstatSync(directory).isDirectory());

  const corrupt = join(f.directory, 'corrupt.sqlite');
  writeFileSync(corrupt, 'this is not a sqlite database');
  assert.throws(() => claimOwner({ database: corrupt, key }), /ownership/);
  assert.equal(readFileSync(corrupt, 'utf8'), 'this is not a sqlite database', 'the corrupt database is not deleted or rewritten');
});

test('claimHost creates owner-only state and canonical aliases refuse a duplicate', async t => {
  const f = sandbox(t);
  const nestedAgent = join(f.directory, 'nested', 'agent');
  const lease = claimHost({ agentDir: nestedAgent });
  t.after(() => { try { lease.release(); } catch { /* already released */ } });
  assert.equal(lease.key, 'sentinel-host');
  assert.equal(lease.pid, process.pid);
  const canonicalAgent = realpathSync(nestedAgent);
  const stateDir = join(canonicalAgent, 'spec-sentinel');
  assert.equal(statSync(canonicalAgent).mode & 0o777, 0o700, 'created agent directory is owner-only');
  assert.equal(statSync(stateDir).mode & 0o777, 0o700, 'state directory is owner-only');
  const ownerFile = join(stateDir, 'coordination.sqlite');
  assert.equal(statSync(ownerFile).mode & 0o777, 0o600, 'new database is owner-only');
  assert.ok(lstatSync(ownerFile).isFile());

  const alias = join(f.directory, 'agent-alias');
  symlinkSync(canonicalAgent, alias);
  assert.throws(() => claimHost({ agentDir: alias }), /live pid|already held/);
  lease.release();
  const viaAlias = claimHost({ agentDir: alias });
  t.after(() => { try { viaAlias.release(); } catch { /* already released */ } });
  assert.equal(viaAlias.pid, process.pid, 'the alias resolves to the same canonical directory');

  viaAlias.release();
  rmSync(ownerFile);
  const elsewhere = join(stateDir, 'elsewhere.sqlite');
  writeFileSync(elsewhere, 'elsewhere');
  symlinkSync(elsewhere, ownerFile);
  assert.throws(() => claimHost({ agentDir: nestedAgent }), /symlink/);
  assert.ok(lstatSync(ownerFile).isSymbolicLink(), 'the owner-file symlink is not followed or removed');
  assert.equal(readFileSync(elsewhere, 'utf8'), 'elsewhere');
  assert.throws(() => claimHost({}), /agentDir/);
});
