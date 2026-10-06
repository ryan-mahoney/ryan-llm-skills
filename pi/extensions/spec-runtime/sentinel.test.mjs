import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync, symlinkSync, realpathSync, renameSync, chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { reduceVerificationResult, readVerificationIncidents, writeVerificationIncidents, verificationIncidentsPath, createVerificationRecorder, recordCheckpoint, readInboxGuard, checkpointPath, readCheckpointRecord, observeInput, reconcileRuntimeReturn } from './sentinel.mjs';

const FIXED = Date.parse('2026-10-06T12:00:00Z');
const record = { package: '/tmp/pkg', assignment_id: 'assign-1', checkout: '/tmp/repo' };
const fingerprint = (tree = 'c'.repeat(64)) => ({
  version: 1, command_sha256: 'a'.repeat(64), summary_sha256: 'b'.repeat(64), tree_digest: tree, complete: true, exit_code: 1,
});
const failureEvent = (id, value = fingerprint(), details = {}) => ({
  type: 'tool_execution_end', toolName: 'spec_verify', toolCallId: id, isError: true,
  result: { details: { exit_code: 1, sentinel_failure: value, ...details } },
});
const successEvent = (id, details = { exit_code: 0 }) => ({
  type: 'tool_execution_end', toolName: 'spec_verify', toolCallId: id, isError: false,
  result: { details },
});
const reduce = (snapshot, event) => reduceVerificationResult(snapshot, { record, event }, FIXED);
const entry = snapshot => Object.values(snapshot.assignments)[0];
const HEX = /^[a-f0-9]{32}$/;

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-repetition-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('sentinel repetition: three distinct matching failures open one incident generation', () => {
  let state = null;
  const first = reduce(state, failureEvent('call-1'));
  assert.equal(first.incident, null);
  assert.equal(first.snapshot.assignments['assign-1'].count, 1);
  assert.equal(first.snapshot.assignments['assign-1'].state, 'counting');
  state = first.snapshot;
  const second = reduce(state, failureEvent('call-2'));
  assert.equal(second.incident, null);
  assert.equal(second.snapshot.assignments['assign-1'].count, 2);
  assert.equal(second.snapshot.assignments['assign-1'].state, 'counting');
  state = second.snapshot;
  const third = reduce(state, failureEvent('call-3'));
  assert.ok(third.incident);
  assert.equal(third.incident.kind, 'repeated-verification-failure');
  assert.match(third.incident.id, HEX);
  assert.equal(third.incident.generation, 1);
  assert.equal(third.incident.linked_from, null);
  assert.equal(third.incident.count, 3);
  assert.equal(third.incident.command_sha256, 'a'.repeat(64));
  assert.equal(third.incident.summary_sha256, 'b'.repeat(64));
  assert.equal(third.incident.tree_digest, 'c'.repeat(64));
  assert.equal(entry(third.snapshot).state, 'open');
  state = third.snapshot;
  const fourth = reduce(state, failureEvent('call-4'));
  assert.equal(fourth.incident, null);
  assert.equal(entry(fourth.snapshot).generation, 1);
  assert.equal(entry(fourth.snapshot).state, 'open');
});

test('sentinel repetition: replaying a toolCallId never advances the count', () => {
  let state = null;
  for (const id of ['call-1', 'call-2', 'call-3']) state = reduce(state, failureEvent(id)).snapshot;
  assert.equal(entry(state).count, 3);
  const replay = reduce(state, failureEvent('call-2'));
  assert.equal(replay.snapshot, state);
  assert.equal(replay.incident, null);
  assert.equal(entry(replay.snapshot).count, 3);
  assert.equal(entry(replay.snapshot).generation, 1);
});

test('sentinel repetition: a replayed ID evicted from the display window never opens a new generation', () => {
  let state = null;
  // Nine distinct matching failures overflow the eight-ID display window.
  for (let i = 1; i <= 9; i += 1) state = reduce(state, failureEvent(`call-${i}`)).snapshot;
  const solved = reduce(state, successEvent('call-10'));
  assert.equal(entry(solved.snapshot).state, 'resolved');
  state = solved.snapshot;
  // The earliest failure IDs are gone from the bounded display history...
  const window = entry(state).tool_call_ids;
  assert.equal(window.includes('call-1'), false);
  assert.equal(window.includes('call-2'), false);
  // ...but replaying them after recovery must still not count as new distinct
  // failures or manufacture a repeated-failure candidate.
  const first = reduce(state, failureEvent('call-1'));
  assert.equal(first.snapshot, state);
  assert.equal(first.incident, null);
  const second = reduce(state, failureEvent('call-2'));
  assert.equal(second.snapshot, state);
  assert.equal(second.incident, null);
  assert.equal(entry(second.snapshot).count, 0);
  assert.equal(entry(second.snapshot).generation, 1);
});

test('sentinel repetition: exhausted replay coverage is marked and never manufactures new generations', () => {
  let state = null;
  // Enough distinct results to overflow the bounded assignment-wide replay
  // set; the overflow is visible on the stored entry.
  for (let i = 0; i < 200; i += 1) state = reduce(state, failureEvent(`call-${i}`)).snapshot;
  assert.equal(entry(state).replay_exhausted, true);
  state = reduce(state, successEvent('call-success')).snapshot;
  assert.equal(entry(state).state, 'resolved');
  // Genuinely new failures can no longer be distinguished from replays of the
  // forgotten IDs, so this assignment is ineligible for further generations.
  state = reduce(state, failureEvent('fresh-1')).snapshot;
  state = reduce(state, failureEvent('fresh-2')).snapshot;
  const third = reduce(state, failureEvent('fresh-3'));
  assert.equal(third.incident, null);
  assert.equal(entry(third.snapshot).generation, 1);
  assert.equal(entry(third.snapshot).state, 'counting');
});

test('sentinel repetition: changed fingerprints and unknown evidence reset the count without resolving an open incident', () => {
  let state = null;
  for (const id of ['call-1', 'call-2', 'call-3']) state = reduce(state, failureEvent(id)).snapshot;
  const firstIncident = entry(state).incident_id;

  state = reduce(state, failureEvent('call-4', fingerprint('d'.repeat(64)))).snapshot;
  assert.equal(entry(state).count, 1);
  assert.equal(entry(state).state, 'open');
  state = reduce(state, failureEvent('call-5', fingerprint('d'.repeat(64)))).snapshot;
  assert.equal(entry(state).count, 2);
  const second = reduce(state, failureEvent('call-6', fingerprint('d'.repeat(64))));
  assert.ok(second.incident);
  assert.equal(second.incident.generation, 2);
  assert.equal(second.incident.linked_from, firstIncident);
  assert.notEqual(second.incident.id, firstIncident);
  state = second.snapshot;

  const incomplete = reduce(state, failureEvent('call-7', { ...fingerprint(), complete: false }));
  assert.equal(entry(incomplete.snapshot).count, 0);
  assert.equal(entry(incomplete.snapshot).state, 'open');
  state = incomplete.snapshot;

  const legacy = reduce(state, { type: 'tool_execution_end', toolName: 'spec_verify', toolCallId: 'call-8', isError: true,
    result: { details: { exit_code: 1, error: 'legacy' } } });
  assert.equal(entry(legacy.snapshot).count, 0);
  assert.equal(entry(legacy.snapshot).state, 'open');
  state = legacy.snapshot;

  const otherTool = reduce(state, { type: 'tool_execution_end', toolName: 'bash', toolCallId: 'call-9', isError: true,
    result: { details: { output: 'AssertionError: expected 1 to equal 2' } } });
  assert.equal(otherTool.snapshot, state);
  assert.equal(otherTool.incident, null);
});

test('sentinel repetition: success resolves the open incident and a later sequence links a new generation', () => {
  let state = null;
  for (const id of ['call-1', 'call-2', 'call-3']) state = reduce(state, failureEvent(id)).snapshot;
  const firstIncident = entry(state).incident_id;
  const solved = reduce(state, successEvent('call-4'));
  assert.equal(solved.incident, null);
  assert.equal(entry(solved.snapshot).count, 0);
  assert.equal(entry(solved.snapshot).state, 'resolved');
  assert.equal(entry(solved.snapshot).generation, 1);
  assert.equal(entry(solved.snapshot).incident_id, firstIncident);
  state = solved.snapshot;

  for (const id of ['call-5', 'call-6']) state = reduce(state, failureEvent(id)).snapshot;
  assert.equal(entry(state).state, 'counting');
  const reopened = reduce(state, failureEvent('call-7'));
  assert.ok(reopened.incident);
  assert.equal(reopened.incident.generation, 2);
  assert.equal(reopened.incident.linked_from, firstIncident);
  assert.notEqual(reopened.incident.id, firstIncident);
});

test('sentinel fingerprint: malformed or incomplete fingerprints are never eligible', () => {
  const ineligible = [
    { ...fingerprint(), tree_digest: null },
    { ...fingerprint(), command_sha256: 'not-hex' },
    { ...fingerprint(), complete: false },
    { ...fingerprint(), version: 2 },
    { ...fingerprint(), exit_code: 1.5 },
  ];
  for (const value of ineligible) {
    const result = reduce(null, failureEvent('call-x', value, { exit_code: 1 }));
    assert.equal(result.incident, null);
    assert.equal(entry(result.snapshot).count, 0);
    assert.equal(entry(result.snapshot).state, 'idle');
  }
});

test('sentinel fingerprint: incident snapshots round-trip atomically at the package owner', t => {
  const dir = sandbox(t);
  const packagePath = join(dir, 'pkg');
  mkdirSync(packagePath, { recursive: true });
  const snapshot = { version: 1, package: packagePath, updated_at: '2026-10-06T12:00:00.000Z', assignments: {} };
  const file = verificationIncidentsPath(packagePath);
  assert.equal(file, join(packagePath, 'runtime', 'sentinel', 'verification-incidents.json'));
  assert.equal(readVerificationIncidents(packagePath), null);
  assert.equal(existsSync(file), false);

  writeVerificationIncidents(packagePath, snapshot);
  assert.equal((statSync(file).mode & 0o777).toString(8), '600');
  assert.deepEqual(readVerificationIncidents(packagePath), snapshot);

  writeFileSync(file, '{not json');
  assert.equal(readVerificationIncidents(packagePath), null);
  writeFileSync(file, JSON.stringify({ version: 1, package: '/somewhere/else', assignments: {} }));
  assert.equal(readVerificationIncidents(packagePath), null);
  writeFileSync(file, 'x'.repeat(65537));
  assert.equal(readVerificationIncidents(packagePath), null);
  rmSync(file);
  assert.equal(readVerificationIncidents(packagePath), null);

  const recorder = createVerificationRecorder({ now: () => FIXED });
  const observed = recorder.observe({ ...record, package: packagePath }, failureEvent('call-1'));
  assert.ok(observed);
  const stored = readVerificationIncidents(packagePath);
  assert.equal(stored.version, 1);
  assert.equal(entry(stored).count, 1);

  const throwing = createVerificationRecorder({ read: () => { throw new Error('read failed'); }, write: () => { throw new Error('write failed'); } });
  assert.equal(throwing.observe({ ...record, package: packagePath }, failureEvent('call-2')), null);
  assert.equal(throwing.observe({ assignment_id: 'no-package' }, failureEvent('call-3')), null);
});

test('sentinel fingerprint: the recorder filters irrelevant events before incident storage', () => {
  let reads = 0;
  let writes = 0;
  const recorder = createVerificationRecorder({ read: () => { reads += 1; return null; }, write: () => { writes += 1; } });
  assert.equal(recorder.observe(record, { type: 'message_end', message: { role: 'assistant' } }), null);
  assert.equal(recorder.observe({ package: '/tmp/pkg' }, failureEvent('call-1')), null);
  assert.equal(recorder.observe(record, { type: 'tool_execution_end', toolName: 'bash', toolCallId: 'call-1', isError: true }), null);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.ok(recorder.observe(record, failureEvent('call-1')));
  assert.equal(reads, 1);
  assert.equal(writes, 1);
});

test('sentinel fingerprint: incident snapshots reject nonregular and symlinked sources without blocking', t => {
  const dir = sandbox(t);
  const packagePath = join(dir, 'pkg');
  const state = join(packagePath, 'runtime', 'sentinel');
  mkdirSync(state, { recursive: true });
  const snapshotFile = join(state, 'verification-incidents.json');

  // A symlinked snapshot target is rejected before it is opened.
  const externalSnapshot = join(dir, 'external-snapshot.json');
  writeFileSync(externalSnapshot, JSON.stringify({ version: 1, package: packagePath, assignments: {} }));
  symlinkSync(externalSnapshot, snapshotFile);
  assert.equal(readVerificationIncidents(packagePath), null);
  rmSync(snapshotFile);

  // A FIFO passes a zero stat size but must never reach a blocking open: an
  // isolated subprocess with a finite deadline proves the recorder returns
  // instead of freezing the event loop, and publication refuses to replace it.
  execFileSync('mkfifo', [snapshotFile]);
  const moduleUrl = new URL('./sentinel.mjs', import.meta.url).href;
  const script = `
    const { readVerificationIncidents, createVerificationRecorder } = await import(${JSON.stringify(moduleUrl)});
    const pkg = ${JSON.stringify(packagePath)};
    const failure = { version: 1, command_sha256: 'a'.repeat(64), summary_sha256: 'b'.repeat(64), tree_digest: 'c'.repeat(64), complete: true, exit_code: 1 };
    const read = readVerificationIncidents(pkg);
    const recorder = createVerificationRecorder();
    const observed = recorder.observe({ package: pkg, assignment_id: 'assign-1' },
      { type: 'tool_execution_end', toolName: 'spec_verify', toolCallId: 'call-1', isError: true,
        result: { details: { exit_code: 1, sentinel_failure: failure } } });
    const irrelevant = recorder.observe({ package: pkg, assignment_id: 'assign-1' }, { type: 'message_end' });
    console.log(JSON.stringify({ read, observed, irrelevant }));
  `;
  const output = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10000, encoding: 'utf8' }));
  assert.equal(output.read, null);
  assert.equal(output.observed, null);
  assert.equal(output.irrelevant, null);
  assert.equal(lstatSync(snapshotFile).isFIFO(), true);
});

test('sentinel fingerprint: incident publication refuses escaped state directories and symlinked destinations', t => {
  const dir = sandbox(t);
  const packagePath = join(dir, 'pkg');
  mkdirSync(join(packagePath, 'runtime'), { recursive: true });
  const external = join(dir, 'external');
  mkdirSync(external);
  const externalFile = join(external, 'verification-incidents.json');
  writeFileSync(externalFile, 'untouched\n');
  symlinkSync(external, join(packagePath, 'runtime', 'sentinel'));

  // Reading through the symlinked ancestor is unavailable, never followed.
  assert.equal(readVerificationIncidents(packagePath), null);
  const recorder = createVerificationRecorder();
  // A refused publication degrades observation to null; it never throws into
  // the worker, and the external destination stays untouched.
  assert.equal(recorder.observe({ ...record, package: packagePath }, failureEvent('call-1')), null);
  assert.equal(readFileSync(externalFile, 'utf8'), 'untouched\n');
  assert.deepEqual(readdirSync(external), ['verification-incidents.json']);

  // A symlinked destination file is refused rather than replaced or followed.
  const realPackage = join(dir, 'pkg2');
  const realState = join(realPackage, 'runtime', 'sentinel');
  mkdirSync(realState, { recursive: true });
  const target = join(dir, 'target.json');
  const targetPayload = JSON.stringify({ version: 1, package: realPackage, assignments: {} });
  writeFileSync(target, targetPayload);
  symlinkSync(target, join(realState, 'verification-incidents.json'));
  assert.throws(() => writeVerificationIncidents(realPackage, { version: 1, package: realPackage, updated_at: null, assignments: {} }));
  assert.equal(lstatSync(join(realState, 'verification-incidents.json')).isSymbolicLink(), true);
  assert.equal(readFileSync(target, 'utf8'), targetPayload);
  assert.equal(readVerificationIncidents(realPackage), null);
});

// --- checkpoint / inbox-guard fixtures (canonical package + disposable git) ---

const sha = value => createHash('sha256').update(value).digest('hex');

// Permission helpers for the unreadable-original case. On a root-run harness
// chmod may not block reads, so the guard still reports a non-healthy result.
const chmodUnreadable = file => { try { chmodSync(file, 0o000); } catch { /* best effort */ } };
const chmodReadable = file => { try { chmodSync(file, 0o600); } catch { /* best effort */ } };

function canonicalFixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sentinel-checkpoint-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Sentinel Checkpoint');
  git('config', 'user.email', 'sentinel-checkpoint@example.invalid');
  writeFileSync(join(repo, 'README'), 'fixture\n');
  git('add', 'README');
  git('commit', '-qm', 'Initial fixture');
  const packagePath = join(repo, '.specs', 'feature');
  mkdirSync(packagePath, { recursive: true });
  return { base, repo, packagePath, git };
}

// Write a prepared artifact inside the package and return its {path, sha256}.
function artifact(packagePath, rel, body) {
  const file = join(packagePath, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return { path: rel, sha256: sha(body) };
}

// Minimal overseer original with simple frontmatter identity.
function original({ id, run = 'run-1', sender = 'overseer', audience = 'coordinator', kind = 'direction', body = 'message', frontmatter = null }) {
  const head = frontmatter ?? ['---', `id: ${id}`, `run: ${run}`, `sender: ${sender}`, `audience: ${audience}`, `kind: ${kind}`, '---'].join('\n');
  return `${head}\n\n${body}\n`;
}

function putOriginal(packagePath, dir, id, text) {
  mkdirSync(join(packagePath, dir), { recursive: true });
  writeFileSync(join(packagePath, dir, `${id}.md`), text);
}

const coordinator = { coordinator_session: 'session-1', checkout: '/tmp/checkout-1' };
const baseCheckpoint = (packagePath, over = {}) => ({
  package: packagePath,
  workflow_id: 'wf-1',
  expected_revision: 0,
  state: 'ready',
  obligation: { key: 'implement:step-004', stage: 'implementation', step: 'step-004', summary: 'do the work', artifacts: [] },
  workers: [],
  inbox: { items: [] },
  reconciles_input_revision: 0,
  ...coordinator,
  now: () => FIXED,
  ...over,
});

test('sentinel checkpoint: obligation_revision stays stable despite changed valid artifact hashes', t => {
  const { packagePath } = canonicalFixture(t);
  const a1 = artifact(packagePath, 'a.md', 'one');
  const first = recordCheckpoint(baseCheckpoint(packagePath, { obligation: { key: 'impl:s1', stage: 'implementation', summary: 'work', artifacts: [a1] } }));
  assert.equal(first.revision, 1);
  assert.equal(first.receipt, 'created');
  const stable = first.obligation_revision;
  assert.equal(stable, first.obligation_revision);
  // Recompute a fresh artifact with different content/hash, same stable key.
  const a2 = artifact(packagePath, 'a.md', 'one-changed');
  const second = recordCheckpoint(baseCheckpoint(packagePath, {
    expected_revision: 1,
    obligation: { key: 'impl:s1', stage: 'implementation', summary: 'work', artifacts: [a2] },
  }));
  assert.equal(second.revision, 2);
  assert.equal(second.obligation_revision, stable, 'obligation_revision depends only on workflow ID + key');
  // A different stable key derives a new obligation revision.
  const third = recordCheckpoint(baseCheckpoint(packagePath, {
    expected_revision: 2,
    obligation: { key: 'review:step-003', stage: 'review', summary: 'review', artifacts: [] },
  }));
  assert.notEqual(third.obligation_revision, stable);
});

test('sentinel checkpoint: stale expected_revision fails without mutation', t => {
  const { packagePath } = canonicalFixture(t);
  const created = recordCheckpoint(baseCheckpoint(packagePath));
  assert.equal(created.revision, 1);
  const before = readFileSync(checkpointPath(packagePath, 'wf-1'), 'utf8');
  assert.throws(() => recordCheckpoint(baseCheckpoint(packagePath, { expected_revision: 0 })), /stale expected_revision/);
  assert.throws(() => recordCheckpoint(baseCheckpoint(packagePath, { expected_revision: 5 })), /stale expected_revision/);
  const after = readFileSync(checkpointPath(packagePath, 'wf-1'), 'utf8');
  assert.equal(after, before, 'a stale call must not mutate the checkpoint');
  assert.equal(JSON.parse(after).revision, 1);
});

test('sentinel checkpoint: a second coordinator or conflicting checkout is an owner conflict', t => {
  const { packagePath } = canonicalFixture(t);
  recordCheckpoint(baseCheckpoint(packagePath));
  assert.throws(
    () => recordCheckpoint(baseCheckpoint(packagePath, { coordinator_session: 'session-2' })),
    /cannot overwrite workflow ownership/);
  assert.throws(
    () => recordCheckpoint(baseCheckpoint(packagePath, { expected_revision: 1, checkout: '/tmp/other-checkout' })),
    /conflicting checkout/);
  // First registration requires expected_revision 0.
  assert.throws(
    () => recordCheckpoint(baseCheckpoint(packagePath, { workflow_id: 'wf-2', expected_revision: 3 })),
    /requires expected_revision 0/);
});

test('sentinel checkpoint: artifact refusal rejects oversize, hash mismatch, symlink and outside paths', t => {
  const { packagePath, repo } = canonicalFixture(t);
  const good = artifact(packagePath, 'ok.md', 'fine');
  const badHash = { path: 'ok.md', sha256: 'f'.repeat(64) };
  assert.throws(() => recordCheckpoint(baseCheckpoint(packagePath, {
    workflow_id: 'wf-h1', obligation: { key: 'k', stage: 's', summary: 'x', artifacts: [badHash] },
  })), /sha256 mismatch/);

  const big = artifact(packagePath, 'big.md', 'x'.repeat(65 * 1024));
  assert.throws(() => recordCheckpoint(baseCheckpoint(packagePath, {
    workflow_id: 'wf-h2', obligation: { key: 'k', stage: 's', summary: 'x', artifacts: [big] },
  })), /exceeds 65536 bytes/);

  // Symlinked artifact target is refused.
  const target = join(repo, 'outside.md');
  writeFileSync(target, 'outside');
  symlinkSync(target, join(packagePath, 'link.md'));
  assert.throws(() => recordCheckpoint(baseCheckpoint(packagePath, {
    workflow_id: 'wf-h3', obligation: { key: 'k', stage: 's', summary: 'x', artifacts: [{ path: 'link.md', sha256: sha('outside') }] },
  })), /non-symlink/);

  // Artifact outside the canonical package is refused.
  assert.throws(() => recordCheckpoint(baseCheckpoint(packagePath, {
    workflow_id: 'wf-h4', obligation: { key: 'k', stage: 's', summary: 'x', artifacts: [{ path: '../README', sha256: sha('fixture\n') }] },
  })), /inside the canonical package/);

  // A refused checkpoint never creates a record.
  assert.equal(existsSync(checkpointPath(packagePath, 'wf-h1')), false);
  assert.ok(good);
});

test('sentinel checkpoint: invalid input revision and malformed workflow IDs are refused before any path read', t => {
  const { packagePath } = canonicalFixture(t);
  // A non-integer/negative reconciles_input_revision is rejected, not normalized.
  assert.throws(() => recordCheckpoint(baseCheckpoint(packagePath, { reconciles_input_revision: -1 })), /reconciles_input_revision/);
  assert.throws(() => recordCheckpoint(baseCheckpoint(packagePath, { reconciles_input_revision: 1.5 })), /reconciles_input_revision/);
  // A traversal/malformed workflow ID cannot construct or read another path.
  assert.throws(() => recordCheckpoint(baseCheckpoint(packagePath, { workflow_id: '../escape' })), /workflow_id/);
  assert.throws(() => checkpointPath(packagePath, '../escape'), /workflow_id/);
  assert.throws(() => readCheckpointRecord(packagePath, '../escape'), /workflow_id/);
  assert.equal(existsSync(join(packagePath, 'runtime', 'sentinel')), false);
});

test('sentinel checkpoint: a symlinked state directory fails closed without writing outside the package', t => {
  const { packagePath, base } = canonicalFixture(t);
  const outside = join(base, 'outside-sentinel');
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(packagePath, 'runtime', 'sentinel'), { recursive: true });
  symlinkSync(outside, join(packagePath, 'runtime', 'sentinel', 'wf-link'));
  assert.throws(() => recordCheckpoint(baseCheckpoint(packagePath, { workflow_id: 'wf-link' })), /symlink|escapes/);
  // No checkpoint or temporary file may appear outside the canonical package.
  assert.deepEqual(readdirSync(outside), []);
  // Reads treat the symlinked workflow directory as unavailable, not as history.
  assert.equal(readCheckpointRecord(packagePath, 'wf-link'), null);
});

test('sentinel checkpoint: a conflicting supplied hash never erases retained inbox history and stays blocking', t => {
  const { packagePath } = canonicalFixture(t);
  const id = '20260101T000000Z-c1';
  mkdirSync(join(packagePath, 'inbox'), { recursive: true });
  const firstText = original({ id, kind: 'information', body: 'first' });
  putOriginal(packagePath, 'inbox', id, firstText);
  const firstHash = sha(firstText);
  recordCheckpoint(baseCheckpoint(packagePath, {
    workflow_id: 'wf-conflict',
    inbox: { items: [{ id, sha256: firstHash, outcome: 'applied' }] },
  }));
  assert.equal(readCheckpointRecord(packagePath, 'wf-conflict').inbox.items.find(item => item.id === id).sha256, firstHash);

  // The original changes on disk and a new conflicting hash is supplied under the
  // same retained ID; the old hash must survive as history and the guard blocks.
  const secondText = original({ id, kind: 'information', body: 'second' });
  putOriginal(packagePath, 'inbox', id, secondText);
  const secondHash = sha(secondText);
  assert.notEqual(secondHash, firstHash);
  const updated = recordCheckpoint(baseCheckpoint(packagePath, {
    workflow_id: 'wf-conflict', expected_revision: 1,
    inbox: { items: [{ id, sha256: secondHash, outcome: 'applied' }] },
  }));
  assert.equal(updated.inbox.items.find(item => item.id === id).sha256, firstHash);
  assert.equal(updated.inbox_guard.blocking, true);
  assert.ok(updated.inbox_guard.reasons.some(reason => reason.startsWith('conflict')));
  assert.equal(readCheckpointRecord(packagePath, 'wf-conflict').inbox.items.find(item => item.id === id).sha256, firstHash);
});

test('sentinel inbox: an unread inbox file blocks and is not empty', t => {
  const { packagePath } = canonicalFixture(t);
  mkdirSync(join(packagePath, 'inbox'), { recursive: true });
  // A complete readable original plus an unreadable (permission-stripped) one.
  putOriginal(packagePath, 'inbox', '20260101T000000Z-a1', original({ id: '20260101T000000Z-a1', kind: 'direction' }));
  const unreadable = join(packagePath, 'inbox', '20260101T000001Z-b2.md');
  writeFileSync(unreadable, original({ id: '20260101T000001Z-b2', kind: 'information' }));
  chmodUnreadable(unreadable);
  const guard = readInboxGuard(packagePath);
  chmodReadable(unreadable);
  // Deterministic invariant: an unread or unprocessed inbox original never
  // yields empty/healthy; the guard blocks either way.
  assert.notEqual(guard.state, 'healthy');
  assert.notEqual(guard.state, 'empty');
  assert.equal(guard.blocking, true);
  assert.ok(guard.sources.some(source => source.directory === 'inbox')
    || guard.reasons.some(reason => reason.startsWith('unreadable') || reason.startsWith('symlink') || reason === 'missing-frontmatter'));
});

test('sentinel inbox: a hold stays held after archiving and releases only with a sourced later direction', t => {
  const { packagePath } = canonicalFixture(t);
  mkdirSync(join(packagePath, 'processed'), { recursive: true });
  const holdId = '20260101T000000Z-h1';
  const holdText = original({ id: holdId, kind: 'hold', body: 'stop dependent work' });
  // The hold is archived into processed/ (moved out of inbox).
  putOriginal(packagePath, 'processed', holdId, holdText);
  const holdSha = sha(holdText);

  // Archived hold without a release remains held/blocking.
  const stillHeld = readInboxGuard(packagePath, { items: [{ id: holdId, sha256: holdSha, outcome: 'applied' }] });
  const heldItem = stillHeld.items.find(item => item.id === holdId);
  assert.equal(heldItem.state, 'held');
  assert.equal(stillHeld.blocking, true);
  assert.notEqual(stillHeld.state, 'healthy');

  // A later direction original that names the hold ID releases only that hold.
  const dirId = '20260102T000000Z-d1';
  const dirText = original({ id: dirId, kind: 'direction', body: `release the hold ${holdId}` });
  putOriginal(packagePath, 'processed', dirId, dirText);
  const dirSha = sha(dirText);

  const released = readInboxGuard(packagePath, { items: [
    { id: holdId, sha256: holdSha, outcome: 'applied', release_source_id: dirId },
    { id: dirId, sha256: dirSha, outcome: 'applied' },
  ] });
  const releasedItem = released.items.find(item => item.id === holdId);
  assert.equal(releasedItem.state, 'released');
  // The direction is bound to its own hash in the projection.
  assert.equal(releasedItem.release_source_sha256, dirSha);

  // Without the applied outcome + release_source_id the hold persists.
  const noRelease = readInboxGuard(packagePath, { items: [
    { id: holdId, sha256: holdSha, outcome: 'held' },
    { id: dirId, sha256: dirSha, outcome: 'applied' },
  ] });
  assert.equal(noRelease.items.find(item => item.id === holdId).state, 'held');

  // A release direction whose supplied hash does not match its observed source
  // never releases the hold: the direction is not hash-bound.
  const wrongDirHash = readInboxGuard(packagePath, { items: [
    { id: holdId, sha256: holdSha, outcome: 'applied', release_source_id: dirId },
    { id: dirId, sha256: sha('not-the-direction'), outcome: 'applied' },
  ] });
  assert.equal(wrongDirHash.items.find(item => item.id === holdId).state, 'held');
  assert.notEqual(wrongDirHash.state, 'healthy');
  assert.equal(wrongDirHash.blocking, true);

  // A release direction with no recognized supplied outcome also fails closed.
  const noDirOutcome = readInboxGuard(packagePath, { items: [
    { id: holdId, sha256: holdSha, outcome: 'applied', release_source_id: dirId },
  ] });
  assert.equal(noDirOutcome.items.find(item => item.id === holdId).state, 'held');
});

test('sentinel inbox: malformed, symlink, missing-history and hash-mismatch stay blocking', t => {
  const { packagePath } = canonicalFixture(t);
  mkdirSync(join(packagePath, 'inbox'), { recursive: true });
  mkdirSync(join(packagePath, 'processed'), { recursive: true });

  // Malformed original (no frontmatter) blocks.
  writeFileSync(join(packagePath, 'inbox', '20260101T000000Z-m1.md'), 'no frontmatter here\n');
  // Duplicate identity key blocks.
  putOriginal(packagePath, 'inbox', '20260101T000001Z-m2', original({ id: '20260101T000001Z-m2',
    frontmatter: ['---', 'id: 20260101T000001Z-m2', 'id: dup', 'kind: direction', '---'].join('\n') }));
  // A frontmatter ID that differs from its `<id>.md` filename is malformed identity.
  writeFileSync(join(packagePath, 'inbox', '20260101T000009Z-misnamed.md'),
    original({ id: '20260101T000009Z-other', kind: 'information' }));
  const malformed = readInboxGuard(packagePath);
  assert.equal(malformed.blocking, true);
  assert.notEqual(malformed.state, 'healthy');
  assert.ok(malformed.reasons.some(reason => reason.startsWith('malformed')));
  assert.ok(malformed.reasons.some(reason => reason.endsWith(':id-filename-mismatch')));

  // Symlinked original makes the guard unknown.
  rmSync(join(packagePath, 'inbox'), { recursive: true, force: true });
  mkdirSync(join(packagePath, 'inbox'), { recursive: true });
  symlinkSync('/etc/hosts', join(packagePath, 'inbox', '20260101T000002Z-s1.md'));
  const symlinked = readInboxGuard(packagePath);
  assert.equal(symlinked.blocking, true);
  assert.ok(symlinked.reasons.some(reason => reason.startsWith('symlink')));

  // Missing previously referenced history stays blocking/unknown.
  const missingHistory = readInboxGuard(packagePath, {
    priorItems: [{ id: '20250101T000000Z-old', sha256: sha('old'), outcome: 'applied' }],
  });
  assert.notEqual(missingHistory.state, 'healthy');
  assert.notEqual(missingHistory.state, 'empty');
  assert.ok(missingHistory.reasons.includes('missing-history:20250101T000000Z-old') || missingHistory.blocking);

  // A retained prior ID missing from both directories, even when both dirs still
  // exist, is unresolved history and blocks with `missing-history:<id>`.
  rmSync(join(packagePath, 'inbox'), { recursive: true, force: true });
  mkdirSync(join(packagePath, 'inbox'), { recursive: true });
  const goneId = '20250102T000000Z-gone';
  const emptyHistory = readInboxGuard(packagePath, {
    priorItems: [{ id: goneId, sha256: sha('gone'), outcome: 'applied' }],
  });
  assert.equal(emptyHistory.blocking, true);
  assert.notEqual(emptyHistory.state, 'healthy');
  assert.notEqual(emptyHistory.state, 'empty');
  assert.ok(emptyHistory.reasons.includes(`missing-history:${goneId}`));

  // A source-hash mismatch against retained history blocks.
  rmSync(join(packagePath, 'inbox'), { recursive: true, force: true });
  mkdirSync(join(packagePath, 'inbox'), { recursive: true });
  const id = '20260101T000003Z-h1';
  const text = original({ id, kind: 'information' });
  putOriginal(packagePath, 'inbox', id, text);
  const mismatch = readInboxGuard(packagePath, { priorItems: [{ id, sha256: sha('different'), outcome: 'applied' }] });
  assert.equal(mismatch.blocking, true);
  assert.ok(mismatch.reasons.some(reason => reason.startsWith('conflict')));

  // A current coordinator items[] hash that disagrees with the observed original
  // is a source-hash mismatch and blocks.
  const currentMismatch = readInboxGuard(packagePath, { items: [{ id, sha256: sha('wrong-current'), outcome: 'applied' }] });
  assert.equal(currentMismatch.blocking, true);
  assert.notEqual(currentMismatch.state, 'healthy');
  assert.ok(currentMismatch.reasons.some(reason => reason.startsWith('conflict')));

  // An unprocessed original always blocks, even with a known outcome.
  const unprocessed = readInboxGuard(packagePath, { items: [{ id, sha256: sha(text), outcome: 'applied' }] });
  assert.equal(unprocessed.blocking, true);
  assert.equal(unprocessed.items.find(item => item.id === id).state, 'blocking');

  // A processed original with no supplied outcome is not nonblocking.
  rmSync(join(packagePath, 'inbox'), { recursive: true, force: true });
  const procId = '20260101T000004Z-p1';
  const procText = original({ id: procId, kind: 'information' });
  putOriginal(packagePath, 'processed', procId, procText);
  const noOutcome = readInboxGuard(packagePath);
  assert.equal(noOutcome.blocking, true);
  assert.notEqual(noOutcome.state, 'healthy');
  assert.equal(noOutcome.items.find(item => item.id === procId).state, 'blocking');
  assert.ok(noOutcome.reasons.includes(`outcome-missing:${procId}`));

  // A processed original with a wrong-hash outcome stays blocking.
  const wrongHashOutcome = readInboxGuard(packagePath, { items: [{ id: procId, sha256: sha('mismatched'), outcome: 'applied' }] });
  assert.equal(wrongHashOutcome.blocking, true);
  assert.equal(wrongHashOutcome.items.find(item => item.id === procId).state, 'blocking');
});

test('sentinel inbox: a freshly initialized empty inbox is empty and healthy', t => {
  const { packagePath } = canonicalFixture(t);
  const guard = readInboxGuard(packagePath);
  assert.equal(guard.state, 'empty');
  assert.equal(guard.blocking, false);
});

// --- native input reducer ---

test('sentinel input: interactive/RPC input increments revision before processing; extension input does not', () => {
  let state = { input_revision: 0, active_prompts: 0 };
  // Interactive input advances the monotonic revision.
  state = observeInput(state, { type: 'input', source: 'interactive' });
  assert.equal(state.input_revision, 1);
  // RPC input advances it again.
  state = observeInput(state, { type: 'input', source: 'rpc' });
  assert.equal(state.input_revision, 2);
  // Extension input does not advance the revision.
  state = observeInput(state, { type: 'input', source: 'extension' });
  assert.equal(state.input_revision, 2);
  // Unknown/other event types are inert.
  state = observeInput(state, { type: 'other' });
  assert.equal(state.input_revision, 2);
});

test('sentinel input: UI prompt start/end maintains nonnegative active prompt depth', () => {
  let state = { input_revision: 0, active_prompts: 0 };
  state = observeInput(state, { type: 'prompt_start' });
  state = observeInput(state, { type: 'prompt_start' });
  assert.equal(state.active_prompts, 2);
  state = observeInput(state, { type: 'prompt_end' });
  assert.equal(state.active_prompts, 1);
  // An unmatched end clamps at zero rather than going negative.
  state = observeInput(state, { type: 'prompt_end' });
  state = observeInput(state, { type: 'prompt_end' });
  assert.equal(state.active_prompts, 0);
  assert.ok(state.active_prompts >= 0);
});

// --- checkpoint: inbox guard binding + reconcile ---

test('sentinel checkpoint: inbox mismatch is persisted as blocking in the checkpoint guard', t => {
  const { packagePath } = canonicalFixture(t);
  mkdirSync(join(packagePath, 'inbox'), { recursive: true });
  const id = '20260101T000000Z-in1';
  const text = original({ id, kind: 'information' });
  putOriginal(packagePath, 'inbox', id, text);
  // The supplied item hash disagrees with the observed original.
  const receipt = recordCheckpoint(baseCheckpoint(packagePath, {
    workflow_id: 'wf-inbox',
    inbox: { items: [{ id, sha256: sha('wrong'), outcome: 'applied' }] },
  }));
  assert.equal(receipt.inbox_guard.blocking, true);
  assert.notEqual(receipt.inbox_guard.state, 'healthy');
  // The blocking projection is persisted in the stored checkpoint.
  const stored = readCheckpointRecord(packagePath, 'wf-inbox');
  assert.equal(stored.inbox_guard.blocking, true);
  assert.notEqual(stored.inbox_guard.state, 'healthy');
});

test('sentinel checkpoint: a completed owner return becomes a reconcile obligation, not complete', t => {
  const { packagePath } = canonicalFixture(t);
  recordCheckpoint(baseCheckpoint(packagePath, {
    workflow_id: 'wf-rec',
    workers: [{ id: 'assign-1', kind: 'owner', state: 'working' }],
    state: 'waiting-worker',
    reconciles_input_revision: 3,
  }));
  const rec = reconcileRuntimeReturn({
    package: packagePath,
    workflow_id: 'wf-rec',
    expected_revision: 1,
    assignment_id: 'assign-1',
    return_state: 'completed',
    workers: [{ id: 'assign-1', kind: 'owner', state: 'working' }],
    ...coordinator,
    now: () => FIXED,
  });
  // New stable reconcile obligation, never `complete`.
  assert.equal(rec.obligation.key, 'reconcile:assign-1');
  assert.notEqual(rec.state, 'complete');
  assert.equal(rec.state, 'ready');
  assert.equal(rec.obligation_revision, rec.obligation_revision);
  // The matching declared worker is marked terminal; owner/checkout preserved.
  assert.equal(rec.workers.find(w => w.id === 'assign-1').state, 'complete');
  assert.equal(rec.coordinator_session, coordinator.coordinator_session);
  assert.equal(rec.receipt, 'reconciled');
  // Input/inbox sources preserved.
  assert.equal(rec.input_revision, 3);
  const stored = readCheckpointRecord(packagePath, 'wf-rec');
  assert.equal(stored.obligation.key, 'reconcile:assign-1');
  assert.notEqual(stored.state, 'complete');
});

test('sentinel checkpoint: non-completed returns stay blocked/unknown and active workers remain vetoes', t => {
  const { packagePath } = canonicalFixture(t);
  recordCheckpoint(baseCheckpoint(packagePath, {
    workflow_id: 'wf-veto',
    workers: [{ id: 'assign-2', kind: 'native-reviewer', state: 'working' }],
    state: 'waiting-worker',
  }));
  // A failed return stays blocked, never ready/complete.
  const failed = reconcileRuntimeReturn({
    package: packagePath,
    workflow_id: 'wf-veto',
    expected_revision: 1,
    assignment_id: 'assign-2',
    return_state: 'failed',
    workers: [{ id: 'assign-2', kind: 'native-reviewer', state: 'working' }],
    ...coordinator,
    now: () => FIXED,
  });
  assert.equal(failed.state, 'blocked');
  assert.notEqual(failed.state, 'complete');
  assert.equal(failed.obligation.key, 'reconcile:assign-2');

  // Awaiting-external and active declared workers remain represented vetoes.
  recordCheckpoint(baseCheckpoint(packagePath, {
    workflow_id: 'wf-wait',
    expected_revision: 0,
    workers: [{ id: 'assign-3', kind: 'native-reviewer', state: 'working' }],
    state: 'waiting-external',
    ...coordinator,
    now: () => FIXED,
  }));
  const waited = readCheckpointRecord(packagePath, 'wf-wait');
  assert.equal(waited.state, 'waiting-external');
  assert.equal(waited.workers.find(w => w.id === 'assign-3').state, 'working');
  // Ordinary expected-revision and owner checks still hold for reconcile.
  assert.throws(() => reconcileRuntimeReturn({
    package: packagePath, workflow_id: 'wf-veto', expected_revision: 99,
    assignment_id: 'assign-2', return_state: 'completed', ...coordinator,
  }), /stale expected_revision/);
  assert.throws(() => reconcileRuntimeReturn({
    package: packagePath, workflow_id: 'wf-veto', expected_revision: 2,
    assignment_id: 'assign-2', return_state: 'completed', coordinator_session: 'other', checkout: '/tmp/x',
  }), /overwrite workflow ownership/);
});

test('sentinel inbox: unresolved outcomes stay blocking and only applied directions release holds', t => {
  const { packagePath } = canonicalFixture(t);
  mkdirSync(join(packagePath, 'processed'), { recursive: true });
  const procId = '20260103T000000Z-u1';
  const procText = original({ id: procId, kind: 'information' });
  putOriginal(packagePath, 'processed', procId, procText);

  // A recognized but unresolved outcome keeps a processed original blocking:
  // recognized is not resolved.
  for (const outcome of ['held', 'decision-required', 'needs-spec-correction']) {
    const guard = readInboxGuard(packagePath, { items: [{ id: procId, sha256: sha(procText), outcome }] });
    assert.equal(guard.items.find(item => item.id === procId).state, 'blocking', outcome);
    assert.equal(guard.blocking, true, outcome);
    assert.ok(guard.reasons.includes(`outcome-unresolved:${procId}`), outcome);
  }
  // A resolved non-applied outcome is genuinely nonblocking.
  const resolved = readInboxGuard(packagePath, { items: [{ id: procId, sha256: sha(procText), outcome: 'not-applicable' }] });
  assert.equal(resolved.items.find(item => item.id === procId).state, 'observed');
  assert.equal(resolved.blocking, false);

  // A hold releases only when its releasing direction itself carries an
  // applied, hash-bound outcome; a not-applicable direction never releases.
  const holdId = '20260103T000001Z-u2';
  const holdText = original({ id: holdId, kind: 'hold', body: 'stop' });
  putOriginal(packagePath, 'processed', holdId, holdText);
  const dirId = '20260104T000000Z-u3';
  const dirText = original({ id: dirId, kind: 'direction', body: `release the hold ${holdId}` });
  putOriginal(packagePath, 'processed', dirId, dirText);
  const notApplied = readInboxGuard(packagePath, { items: [
    { id: holdId, sha256: sha(holdText), outcome: 'applied', release_source_id: dirId },
    { id: dirId, sha256: sha(dirText), outcome: 'not-applicable' },
  ] });
  assert.equal(notApplied.items.find(item => item.id === holdId).state, 'held');
  assert.equal(notApplied.blocking, true);
  const applied = readInboxGuard(packagePath, { items: [
    { id: holdId, sha256: sha(holdText), outcome: 'applied', release_source_id: dirId },
    { id: dirId, sha256: sha(dirText), outcome: 'applied' },
  ] });
  assert.equal(applied.items.find(item => item.id === holdId).state, 'released');
});

test('sentinel checkpoint: observed originals and mailbox directories are retained without outcomes', t => {
  const { packagePath } = canonicalFixture(t);
  const holdId = '20260105T000000Z-r1';
  const holdText = original({ id: holdId, kind: 'hold', body: 'stop dependent work' });
  putOriginal(packagePath, 'inbox', holdId, holdText);

  // Checkpoint the unread hold with no supplied outcome: the observed original
  // is retained by identity/hash and blocks.
  const first = recordCheckpoint(baseCheckpoint(packagePath, { workflow_id: 'wf-retain', inbox: { items: [] } }));
  assert.equal(first.inbox_guard.blocking, true);
  const retained = first.inbox.items.find(item => item.id === holdId);
  assert.equal(retained.sha256, sha(holdText));
  assert.equal(retained.kind, 'hold');
  assert.equal(retained.directory, 'inbox');
  assert.equal(retained.outcome, null);
  assert.deepEqual(first.inbox.observed_directories, ['inbox']);

  // Removing the original without a sourced release is unresolved history.
  rmSync(join(packagePath, 'inbox', `${holdId}.md`));
  const second = recordCheckpoint(baseCheckpoint(packagePath, { workflow_id: 'wf-retain', expected_revision: 1, inbox: { items: [] } }));
  assert.equal(second.inbox_guard.blocking, true);
  assert.equal(second.inbox_guard.state, 'unknown');
  assert.ok(second.inbox_guard.reasons.includes(`missing-history:${holdId}`));

  // Removing the whole mailbox is still missing-history, never empty/healthy.
  rmSync(join(packagePath, 'inbox'), { recursive: true, force: true });
  const third = recordCheckpoint(baseCheckpoint(packagePath, { workflow_id: 'wf-retain', expected_revision: 2, inbox: { items: [] } }));
  assert.equal(third.inbox_guard.blocking, true);
  assert.equal(third.inbox_guard.state, 'unknown');
  assert.ok(third.inbox_guard.reasons.includes('missing-history'));
  assert.deepEqual(third.inbox.observed_directories, ['inbox']);

  // Directory observation alone (an empty mailbox) is retained too: losing a
  // previously observed mailbox without any original stays unknown.
  const other = canonicalFixture(t);
  mkdirSync(join(other.packagePath, 'inbox'), { recursive: true });
  mkdirSync(join(other.packagePath, 'processed'), { recursive: true });
  const observed = recordCheckpoint(baseCheckpoint(other.packagePath, { workflow_id: 'wf-dirs' }));
  assert.equal(observed.inbox_guard.blocking, false);
  assert.deepEqual(observed.inbox.observed_directories, ['inbox', 'processed']);
  rmSync(join(other.packagePath, 'inbox'), { recursive: true, force: true });
  rmSync(join(other.packagePath, 'processed'), { recursive: true, force: true });
  const lost = recordCheckpoint(baseCheckpoint(other.packagePath, { workflow_id: 'wf-dirs', expected_revision: 1 }));
  assert.equal(lost.inbox_guard.blocking, true);
  assert.equal(lost.inbox_guard.state, 'unknown');
  assert.notEqual(lost.inbox_guard.state, 'empty');
});

test('sentinel inbox: symlinked or nonregular mailbox directories fail closed', t => {
  const { packagePath, base } = canonicalFixture(t);
  // An external processed mailbox with a perfectly valid applied original.
  const external = join(base, 'external-processed');
  mkdirSync(external, { recursive: true });
  const extId = '20260106T000000Z-e1';
  const extText = original({ id: extId, kind: 'information' });
  writeFileSync(join(external, `${extId}.md`), extText);
  mkdirSync(join(packagePath, 'inbox'), { recursive: true });
  symlinkSync(external, join(packagePath, 'processed'));
  const guard = readInboxGuard(packagePath, {
    priorItems: [{ id: extId, sha256: sha(extText), outcome: 'applied' }],
  });
  assert.ok(guard.reasons.some(reason => reason.startsWith('symlink:processed-directory')));
  assert.equal(guard.blocking, true);
  assert.equal(guard.state, 'unknown');
  assert.deepEqual(guard.directories, ['inbox']);

  // A non-directory mailbox component is blocking, never enumerated.
  unlinkSync(join(packagePath, 'processed'));
  writeFileSync(join(packagePath, 'processed'), 'not a directory');
  const nonDir = readInboxGuard(packagePath);
  assert.ok(nonDir.reasons.some(reason => reason === 'nonregular:processed-directory'));
  assert.equal(nonDir.blocking, true);

  // A relevant nonregular .md entry is unknown rather than silently ignored.
  rmSync(join(packagePath, 'processed'));
  mkdirSync(join(packagePath, 'processed'), { recursive: true });
  mkdirSync(join(packagePath, 'inbox', '20260106T000001Z-e2.md'));  const nonregular = readInboxGuard(packagePath);
  assert.ok(nonregular.reasons.some(reason => reason.startsWith('nonregular:inbox/20260106T000001Z-e2.md')));
  assert.equal(nonregular.blocking, true);
  assert.ok(nonregular.sources.some(source => source.state === 'unknown' && source.reason === 'nonregular'));
});

test('sentinel inbox: enumeration is bounded by examined entries and reports truncation', t => {
  const { packagePath } = canonicalFixture(t);
  const inbox = join(packagePath, 'inbox');
  mkdirSync(inbox, { recursive: true });
  // Exactly at the examination ceiling the mailbox is provably complete.
  for (let i = 0; i < 800; i += 1) writeFileSync(join(inbox, `sibling-${i}`), '');
  const complete = readInboxGuard(packagePath);
  assert.equal(complete.blocking, false);
  assert.ok(complete.reasons.every(reason => !reason.startsWith('enumeration-cap')));
  // One entry beyond the ceiling prevents proving completeness: the projection
  // stays blocking instead of visiting the whole directory.
  writeFileSync(join(inbox, 'sibling-800'), '');
  const truncated = readInboxGuard(packagePath);
  assert.equal(truncated.blocking, true);
  assert.ok(truncated.reasons.includes('enumeration-cap:inbox'));
});

test('sentinel checkpoint: a terminal return never erases an explicit coordinator stop', t => {
  const { packagePath } = canonicalFixture(t);
  for (const stop of ['user-held', 'waiting-external', 'decision-required', 'blocked', 'complete']) {
    const workflowId = `wf-stop-${stop.replace(/-/g, '')}`;
    recordCheckpoint(baseCheckpoint(packagePath, {
      workflow_id: workflowId,
      state: stop,
      workers: [{ id: 'assign-9', kind: 'owner', state: 'working' }],
    }));
    const reconciled = reconcileRuntimeReturn({
      package: packagePath,
      workflow_id: workflowId,
      expected_revision: 1,
      assignment_id: 'assign-9',
      return_state: 'completed',
      workers: [{ id: 'assign-9', kind: 'owner', state: 'working' }],
      ...coordinator,
      now: () => FIXED,
    });
    // The reconciliation obligation and terminal worker state are recorded,
    // but the explicit stop survives; only a coordinator checkpoint reconciles it.
    assert.equal(reconciled.state, stop, stop);
    assert.equal(reconciled.obligation.key, 'reconcile:assign-9');
    assert.equal(reconciled.workers.find(worker => worker.id === 'assign-9').state, 'complete');
    assert.equal(reconciled.receipt, 'reconciled');
    const stored = readCheckpointRecord(packagePath, workflowId);
    assert.equal(stored.state, stop, stop);
    assert.notEqual(stored.state, 'ready');
  }
});

test('sentinel fingerprint: workflow-bound incidents retain identity and separate history', t => {
  const dir = sandbox(t);
  const packagePath = join(dir, 'pkg');
  mkdirSync(packagePath, { recursive: true });
  const recorder = createVerificationRecorder({ now: () => FIXED });

  // Two workflows fail independently: each retains its own identity, count
  // and incident history in its workflow-owned snapshot.
  for (const workflowId of ['wf-inc-a', 'wf-inc-b']) {
    for (let i = 1; i <= 3; i += 1) {
      const observed = recorder.observe({ package: packagePath, assignment_id: `assign-${workflowId}`, workflow_id: workflowId },
        failureEvent(`${workflowId}-call-${i}`));
      if (i === 3) {
        assert.ok(observed.incident);
        assert.equal(observed.incident.workflow_id, workflowId);
      }
    }
    const stored = readVerificationIncidents(packagePath, workflowId);
    assert.equal(stored.workflow_id, workflowId);
    assert.equal(stored.assignments[`assign-${workflowId}`].workflow_id, workflowId);
    assert.equal(stored.assignments[`assign-${workflowId}`].count, 3);
  }
  assert.equal(existsSync(verificationIncidentsPath(packagePath, 'wf-inc-a')), true);
  assert.equal(existsSync(verificationIncidentsPath(packagePath, 'wf-inc-b')), true);
  // A workflow-scoped read never returns another workflow's snapshot.
  assert.equal(readVerificationIncidents(packagePath, 'wf-inc-a').assignments['assign-wf-inc-b'], undefined);

  // Unbound legacy observation stays observation-only at the package root.
  assert.equal(existsSync(verificationIncidentsPath(packagePath)), false);
  recorder.observe({ package: packagePath, assignment_id: 'assign-legacy' }, failureEvent('legacy-call-1'));
  const legacy = readVerificationIncidents(packagePath);
  assert.equal(legacy.workflow_id, null);
  assert.equal(legacy.assignments['assign-legacy'].count, 1);
  assert.equal(legacy.assignments['assign-legacy'].workflow_id, null);
});
