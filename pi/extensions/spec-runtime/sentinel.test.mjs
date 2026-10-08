import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync, symlinkSync, realpathSync, renameSync, chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { reduceVerificationResult, readVerificationIncidents, writeVerificationIncidents, verificationIncidentsPath, createVerificationRecorder, recordCheckpoint, readInboxGuard, checkpointPath, readCheckpointRecord, observeInput, reconcileRuntimeReturn, createSentinelAuthority, createDiagnosisController, activatePolicy, activateRuntimePolicy, disablePolicy, readPolicyGuard, reserveIntent, finishIntent, decideSettle, handleBeforeSettle, buildDiagnosisPacket, validateDiagnosisResult, diagnoseIncident, readDiagnosisAttempt, diagnosisAttemptPath } from './sentinel.mjs';

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

// --- policy / intent / budget / storage (step 5) ---

const policyFor = (packagePath, over = {}) => ({ version: 1, package: packagePath, workflow_id: 'wf-1', checkout: '/tmp/checkout-1',
  coordinator_session: 'session-1', mode: 'shadow', actions: [], expires_at: new Date(FIXED + 60 * 60 * 1000).toISOString(),
  max_effects: 2, max_diagnostics: 2, diagnosis: { model: 'test/diagnosis' }, authority_reference: 'user:enable', ...over });
const writePolicy = (base, policy) => { const file = join(base, `policy-${randomUUID()}.json`); writeFileSync(file, JSON.stringify(policy)); return file; };
const activateArgs = (packagePath, policyPath) => ({ policy_path: policyPath, coordinator_session: 'session-1', command: 'enable', now: () => FIXED });

function armFixture(packagePath, base, policyOver = {}) {
  recordCheckpoint(baseCheckpoint(packagePath));
  const authority = createSentinelAuthority();
  const file = writePolicy(base, policyFor(packagePath, policyOver));
  const receipt = activatePolicy(authority, activateArgs(packagePath, file));
  return { authority, file, receipt };
}

test('sentinel runtime mode: no policy file or expiry, with immediate controller revocation', t => {
  const { packagePath } = canonicalFixture(t);
  recordCheckpoint(baseCheckpoint(packagePath));
  const checkpoint = readCheckpointRecord(packagePath, 'wf-1');
  const authority = createSentinelAuthority();
  let active = true;
  const grant = activateRuntimePolicy(authority, { checkpoint, mode: 'shadow', model: 'openrouter/inception/mercury-2.5:high',
    coordinator_session: 'session-1', isActive: () => active, now: () => FIXED });
  assert.equal(grant.expires_at, null);
  assert.equal(readPolicyGuard(authority, { now: () => FIXED + 30 * 86400000 }).state, 'ready');
  assert.equal(readPolicyGuard(authority, { workflow_id: 'another-workflow', now: () => FIXED }).state, 'blocked');
  active = false;
  assert.equal(readPolicyGuard(authority, { now: () => FIXED }).state, 'blocked');
  assert.throws(() => activateRuntimePolicy(createSentinelAuthority(), { checkpoint, mode: 'recover', model: 'test/model',
    coordinator_session: 'session-other', isActive: () => true, now: () => FIXED }), /coordinator session|checkpoint/);
  assert.equal(readPolicyGuard(createSentinelAuthority(), { now: () => FIXED }).armed, false, 'disk receipts never reactivate a controller');
});

test('sentinel policy: validates schema, scope, expiry and arming before activating', t => {
  const { packagePath, base } = canonicalFixture(t);
  recordCheckpoint(baseCheckpoint(packagePath));
  const authority = createSentinelAuthority();
  assert.equal(readPolicyGuard(authority).armed, false);
  const attempt = over => () => activatePolicy(authority, activateArgs(packagePath, writePolicy(base, policyFor(packagePath, over))));
  assert.throws(attempt({ extra: true }), /unknown key/);
  assert.throws(attempt({ mode: 'recover-all' }), /mode is unrecognized/);
  assert.throws(attempt({ actions: ['continue', 'continue'] }), /duplicated/);
  assert.throws(attempt({ actions: ['bypass'] }), /action is unrecognized/);
  assert.throws(attempt({ expires_at: new Date(FIXED - 1000).toISOString() }), /future/);
  assert.throws(attempt({ expires_at: new Date(FIXED + 9 * 60 * 60 * 1000).toISOString() }), /eight hours/);
  assert.throws(attempt({ max_effects: 3 }), /max_effects/);
  assert.throws(attempt({ actions: ['cancel'], diagnosis: undefined }), /cancel permission requires/);
  assert.throws(attempt({ workflow_id: 'wf-other' }), /no retained checkpoint/);
  assert.throws(attempt({ coordinator_session: 'other' }), /coordinator session/);
  // Symlinked and oversized sources are refused.
  const target = writePolicy(base, policyFor(packagePath));
  const link = join(base, 'policy-link.json');
  symlinkSync(target, link);
  assert.throws(() => activatePolicy(authority, activateArgs(packagePath, link)), /non-symlink/);
  const big = join(base, 'policy-big.json');
  writeFileSync(big, `${JSON.stringify(policyFor(packagePath))}${' '.repeat(17 * 1024)}`);
  assert.throws(() => activatePolicy(authority, activateArgs(packagePath, big)), /exceeds/);
  // Every rejection leaves the capability disarmed.
  assert.equal(readPolicyGuard(authority).armed, false);

  const valid = writePolicy(base, policyFor(packagePath, { mode: 'recover', actions: ['continue'], max_effects: 1, max_diagnostics: 1 }));
  const receipt = activatePolicy(authority, activateArgs(packagePath, valid));
  assert.equal(receipt.armed, true);
  assert.equal(receipt.max_effects, 1);
  assert.equal(readPolicyGuard(authority, { now: () => FIXED }).state, 'ready');
  // A changed source hash blocks the reread; no path extends the grant.
  writeFileSync(valid, JSON.stringify(policyFor(packagePath, { max_effects: 2 })));
  assert.equal(readPolicyGuard(authority, { now: () => FIXED }).state, 'blocked');
  // A fresh authority is disarmed even though an on-disk grant now exists.
  assert.equal(readPolicyGuard(createSentinelAuthority()).armed, false);
});

test('sentinel policy: cancel requires diagnosis and the diagnosis schema is exact', t => {
  const { packagePath, base } = canonicalFixture(t);
  recordCheckpoint(baseCheckpoint(packagePath));
  const authority = createSentinelAuthority();
  const attempt = over => () => activatePolicy(authority, activateArgs(packagePath, writePolicy(base, policyFor(packagePath, over))));
  assert.throws(attempt({ actions: ['cancel'], diagnosis: undefined }), /cancel permission requires/);
  assert.throws(attempt({ diagnosis: { model: 'x', extra: true } }), /unknown key/);
  assert.throws(attempt({ diagnosis: { model: 'test/diag' }, max_diagnostics: 0 }), /nonzero diagnostic/);
  assert.throws(attempt({ diagnosis: { model: '' } }), /diagnosis.model/);
  const valid = writePolicy(base, policyFor(packagePath, { mode: 'recover', actions: ['cancel'], diagnosis: { model: 'test/diag' }, max_diagnostics: 1 }));
  const receipt = activatePolicy(authority, activateArgs(packagePath, valid));
  assert.equal(receipt.diagnosis.model, 'test/diag');
  assert.equal(receipt.actions.includes('cancel'), true);
});

test('sentinel intent: duplicate reservation returns one retained receipt and a third effect is denied', async t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armFixture(packagePath, base, { mode: 'recover', actions: ['continue'] });
  const args = { workflow_id: 'wf-1', kind: 'continue', subject_key: 'impl:s1', source_revision: 'rev-1', now: () => FIXED };
  // Two local callers scheduled together on the single-session serialization boundary.
  const results = await Promise.all([
    Promise.resolve().then(() => reserveIntent(authority, args)),
    Promise.resolve().then(() => reserveIntent(authority, args)),
  ]);
  const accepted = results.filter(result => result.accepted === true);
  const repeated = results.filter(result => result.accepted === false);
  assert.equal(accepted.length, 1);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].duplicate, true);
  assert.equal(repeated[0].intent.id, accepted[0].intent.id);
  // Exactly one intent and one effect slot exist before the distinct second.
  const sentinelDir = join(packagePath, 'runtime', 'sentinel', 'wf-1');
  assert.equal(readdirSync(join(sentinelDir, 'intents')).length, 1);
  assert.equal(readdirSync(join(sentinelDir, 'effect-slots')).length, 1);
  const second = reserveIntent(authority, { ...args, subject_key: 'impl:s2' });
  assert.equal(second.accepted, true);
  const third = reserveIntent(authority, { ...args, subject_key: 'impl:s3' });
  assert.equal(third.accepted, false);
  assert.equal(third.state, 'exhausted');
  assert.equal(readdirSync(join(sentinelDir, 'effect-slots')).length, 2);
});

test('sentinel intent: restart-observed accepted intent blocks and stays spent', t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armFixture(packagePath, base, { mode: 'recover', actions: ['continue'] });
  const reserved = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 's', source_revision: 'r', now: () => FIXED });
  assert.equal(reserved.accepted, true);
  // A fresh authority re-enables the same disk policy but never reconstructs the
  // created-intent capability, so the retained accepted intent blocks.
  const restarted = createSentinelAuthority();
  activatePolicy(restarted, activateArgs(packagePath, writePolicy(base, policyFor(packagePath, { mode: 'recover', actions: ['continue'] }))));
  const repeated = reserveIntent(restarted, { workflow_id: 'wf-1', kind: 'continue', subject_key: 's', source_revision: 'r', now: () => FIXED });
  assert.equal(repeated.accepted, false);
  assert.equal(repeated.blocking, true);
  const distinct = reserveIntent(restarted, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'other', source_revision: 'r', now: () => FIXED });
  assert.equal(distinct.accepted, false);
  assert.equal(distinct.state, 'blocked');
});

test('sentinel budget: policy caps lower the ceiling and a terminal finish never reclaims', t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armFixture(packagePath, base, { mode: 'recover', actions: ['continue'], max_effects: 1 });
  const first = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 's1', source_revision: 'r', now: () => FIXED });
  assert.equal(first.accepted, true);
  const second = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 's2', source_revision: 'r', now: () => FIXED });
  assert.equal(second.accepted, false);
  assert.equal(second.state, 'exhausted');
  const finished = finishIntent(authority, { workflow_id: 'wf-1', intent_id: first.intent.id, state: 'applied', reason_code: 'done', result_reference: 'receipt-1', now: () => FIXED });
  assert.equal(finished.state, 'applied');
  assert.equal(finished.result_reference, 'receipt-1');
  const third = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 's3', source_revision: 'r', now: () => FIXED });
  assert.equal(third.accepted, false);
  // A different live authority cannot finish another's intent.
  const other = createSentinelAuthority();
  activatePolicy(other, activateArgs(packagePath, writePolicy(base, policyFor(packagePath))));
  assert.throws(() => finishIntent(other, { workflow_id: 'wf-1', intent_id: first.intent.id, state: 'failed', reason_code: 'retry' }), /not owned by the live authority/);
});

test('sentinel storage: orphan, malformed slot and malformed intent fail closed', t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armFixture(packagePath, base, { mode: 'recover', actions: ['continue'] });
  const sentinelDir = join(packagePath, 'runtime', 'sentinel', 'wf-1');
  // Orphan slot references a missing intent.
  mkdirSync(join(sentinelDir, 'effect-slots'), { recursive: true });
  writeFileSync(join(sentinelDir, 'effect-slots', '0.json'), JSON.stringify({ version: 1, workflow_id: 'wf-1', pool: 'effect', slot: 0, intent_id: 'missing', kind: 'continue' }));
  const orphan = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 's', source_revision: 'r', now: () => FIXED });
  assert.equal(orphan.accepted, false);
  assert.equal(orphan.state, 'blocked');
  assert.ok(orphan.reasons.some(reason => reason.startsWith('intent-missing') || reason.startsWith('slot-malformed')));
  // A distinct subject cannot jump past an orphan slot's retained capacity.
  const orphanDistinct = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'different', source_revision: 'r', now: () => FIXED });
  assert.equal(orphanDistinct.accepted, false);
  assert.equal(orphanDistinct.state, 'blocked');
  // A malformed slot also blocks.
  writeFileSync(join(sentinelDir, 'effect-slots', '0.json'), '{not json');
  const malformedSlot = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 's', source_revision: 'r', now: () => FIXED });
  assert.equal(malformedSlot.accepted, false);
  assert.equal(malformedSlot.state, 'blocked');
  // A malformed retained intent blocks even without any slot.
  rmSync(join(sentinelDir, 'effect-slots'), { recursive: true, force: true });
  mkdirSync(join(sentinelDir, 'intents'), { recursive: true });
  writeFileSync(join(sentinelDir, 'intents', 'deadbeef.json'), '{not json');
  const malformedIntent = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 's', source_revision: 'r', now: () => FIXED });
  assert.equal(malformedIntent.accepted, false);
});

test('sentinel storage: disable revokes before a persistence failure and stays disarmed', t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armFixture(packagePath, base);
  assert.equal(readPolicyGuard(authority, { now: () => FIXED }).armed, true);
  // A nonregular owned destination makes revocation persistence fail deterministically.
  const grantFile = join(packagePath, 'runtime', 'sentinel', 'wf-1', 'authority', 'grant.json');
  unlinkSync(grantFile);
  symlinkSync(join(base, 'outside-grant.json'), grantFile);
  const result = disablePolicy(authority, { now: () => FIXED, reason: 'test' });
  assert.equal(result.armed, false);
  assert.equal(result.revoked, true);
  assert.equal(result.persisted, false);
  assert.ok(result.error);
  // The live capability is disarmed even though revocation persistence failed.
  assert.equal(readPolicyGuard(authority).armed, false);
});

test('sentinel policy: grant tampering blocks and a re-activation may only narrow', t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armFixture(packagePath, base, { mode: 'recover', actions: ['continue'], max_effects: 2 });
  const grantFile = join(packagePath, 'runtime', 'sentinel', 'wf-1', 'authority', 'grant.json');
  const grant = JSON.parse(readFileSync(grantFile, 'utf8'));
  assert.ok(grant.activation_id);
  // Tampering a persisted grant field blocks the reread.
  writeFileSync(grantFile, JSON.stringify({ ...grant, max_effects: 0 }));
  assert.equal(readPolicyGuard(authority, { now: () => FIXED }).state, 'blocked');
  writeFileSync(grantFile, JSON.stringify(grant));
  assert.equal(readPolicyGuard(authority, { now: () => FIXED }).state, 'ready');
  // A lower cap is a valid narrowing.
  const narrowed = activatePolicy(authority, activateArgs(packagePath, writePolicy(base, policyFor(packagePath, { mode: 'recover', actions: ['continue'], max_effects: 1 }))));
  assert.equal(narrowed.max_effects, 1);
  // Adding an action or raising a cap is refused.
  assert.throws(() => activatePolicy(authority, activateArgs(packagePath, writePolicy(base, policyFor(packagePath, { mode: 'recover', actions: ['continue', 'cancel'], max_effects: 2 })))), /cannot add action|cannot raise/);
});

test('sentinel policy: a shadow grant cannot be expanded into recover', t => {
  const { packagePath, base } = canonicalFixture(t);
  // Same action in both policies so the mode expansion is the distinguishing failure.
  const { authority } = armFixture(packagePath, base, { actions: ['continue'] });
  assert.throws(() => activatePolicy(authority, activateArgs(packagePath, writePolicy(base, policyFor(packagePath, { mode: 'recover', actions: ['continue'] })))), /cannot expand shadow/);
});

test('sentinel policy: an exact ISO timestamp and a concrete selector are required', t => {
  const { packagePath, base } = canonicalFixture(t);
  recordCheckpoint(baseCheckpoint(packagePath));
  const authority = createSentinelAuthority();
  const attempt = over => () => activatePolicy(authority, activateArgs(packagePath, writePolicy(base, policyFor(packagePath, over))));
  assert.throws(attempt({ expires_at: '2030-01-01' }), /exact ISO/);
  assert.throws(attempt({ expires_at: '2030-01-01T00:00:00+00:00' }), /exact ISO/);
  assert.throws(attempt({ diagnosis: { model: 'no-slash' } }), /provider\/model/);
  assert.throws(attempt({ diagnosis: { model: 'provider/model with space' } }), /provider\/model/);
  assert.throws(attempt({ diagnosis: { model: 'provider/model\u0000' } }), /provider\/model/);
});

test('sentinel intent: guarded permission, subject generation and diagnostic cooldown are enforced', t => {
  const shadowFixture = canonicalFixture(t);
  const shadow = armFixture(shadowFixture.packagePath, shadowFixture.base, { diagnosis: undefined });
  const deniedEffect = reserveIntent(shadow.authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 's', source_revision: 'r', now: () => FIXED });
  assert.equal(deniedEffect.accepted, false);
  assert.equal(deniedEffect.state, 'denied');
  const deniedDiagnosis = reserveIntent(shadow.authority, { workflow_id: 'wf-1', kind: 'diagnose', subject_key: 'g1', source_revision: 'r', now: () => FIXED });
  assert.equal(deniedDiagnosis.accepted, false);

  const recoverFixture = canonicalFixture(t);
  const recover = armFixture(recoverFixture.packagePath, recoverFixture.base, { mode: 'recover', actions: ['continue'], diagnosis: { model: 'test/diag' }, max_effects: 2, max_diagnostics: 2 });
  const first = reserveIntent(recover.authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'subject-a', source_revision: 'r1', now: () => FIXED });
  assert.equal(first.accepted, true);
  // A new source revision for the same subject cannot replenish the reservation.
  const sameSubject = reserveIntent(recover.authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'subject-a', source_revision: 'r2', now: () => FIXED });
  assert.equal(sameSubject.accepted, false);
  assert.equal(sameSubject.duplicate, true);
  assert.equal(sameSubject.intent.id, first.intent.id);
  // One diagnosis reserves; a distinct generation within five minutes cools down.
  const diag1 = reserveIntent(recover.authority, { workflow_id: 'wf-1', kind: 'diagnose', subject_key: 'gen-1', source_revision: 'r', now: () => FIXED });
  assert.equal(diag1.accepted, true);
  const diag2 = reserveIntent(recover.authority, { workflow_id: 'wf-1', kind: 'diagnose', subject_key: 'gen-2', source_revision: 'r', now: () => FIXED + 60 * 1000 });
  assert.equal(diag2.accepted, false);
  assert.equal(diag2.state, 'cooldown');
  const diag3 = reserveIntent(recover.authority, { workflow_id: 'wf-1', kind: 'diagnose', subject_key: 'gen-3', source_revision: 'r', now: () => FIXED + 6 * 60 * 1000 });
  assert.equal(diag3.accepted, true);
});

test('sentinel storage: a corrupted checkpoint scope blocks the live guard', t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armFixture(packagePath, base, { mode: 'recover', actions: ['continue'] });
  assert.equal(readPolicyGuard(authority, { now: () => FIXED }).state, 'ready');
  const checkpointFile = checkpointPath(packagePath, 'wf-1');
  const original = JSON.parse(readFileSync(checkpointFile, 'utf8'));
  // A null checkout or corrupted package no longer matches the live capability.
  writeFileSync(checkpointFile, JSON.stringify({ ...original, checkout: null }));
  assert.equal(readPolicyGuard(authority, { now: () => FIXED }).state, 'blocked');
  writeFileSync(checkpointFile, JSON.stringify({ ...original, package: '/tmp/elsewhere' }));
  assert.equal(readPolicyGuard(authority, { now: () => FIXED }).state, 'blocked');
  writeFileSync(checkpointFile, JSON.stringify(original));
  assert.equal(readPolicyGuard(authority, { now: () => FIXED }).state, 'ready');
});

test('sentinel intent: requested lifecycle transitions, idempotence and backward refusal', t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armFixture(packagePath, base, { mode: 'recover', actions: ['continue'], max_effects: 2 });
  const first = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'life-1', source_revision: 'r', now: () => FIXED });
  assert.equal(first.accepted, true);
  const requested = finishIntent(authority, { workflow_id: 'wf-1', intent_id: first.intent.id, state: 'requested', reason_code: 'queued', now: () => FIXED });
  assert.equal(requested.state, 'requested');
  const applied = finishIntent(authority, { workflow_id: 'wf-1', intent_id: first.intent.id, state: 'applied', reason_code: 'done', result_reference: 'receipt-1', now: () => FIXED });
  assert.equal(applied.state, 'applied');
  // An exact same terminal replay is idempotent.
  const replay = finishIntent(authority, { workflow_id: 'wf-1', intent_id: first.intent.id, state: 'applied', reason_code: 'done', result_reference: 'receipt-1', now: () => FIXED });
  assert.equal(replay.state, 'applied');
  // Conflicting and backward rewrites refuse.
  assert.throws(() => finishIntent(authority, { workflow_id: 'wf-1', intent_id: first.intent.id, state: 'failed', reason_code: 'later' }), /cannot transition/);
  assert.throws(() => finishIntent(authority, { workflow_id: 'wf-1', intent_id: first.intent.id, state: 'requested', reason_code: 'queued' }), /cannot transition/);
  // accepted -> terminal directly is allowed.
  const second = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'life-2', source_revision: 'r', now: () => FIXED });
  const direct = finishIntent(authority, { workflow_id: 'wf-1', intent_id: second.intent.id, state: 'blocked', reason_code: 'veto', now: () => FIXED });
  assert.equal(direct.state, 'blocked');
});

test('sentinel storage: a symlinked slot or intent read fails closed', t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armFixture(packagePath, base, { mode: 'recover', actions: ['continue'] });
  const sentinelDir = join(packagePath, 'runtime', 'sentinel', 'wf-1');
  mkdirSync(join(sentinelDir, 'effect-slots'), { recursive: true });
  symlinkSync(join(base, 'outside-slot.json'), join(sentinelDir, 'effect-slots', '0.json'));
  const blockedBySlot = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'sym-slot', source_revision: 'r', now: () => FIXED });
  assert.equal(blockedBySlot.accepted, false);
  assert.equal(blockedBySlot.state, 'blocked');
  rmSync(join(sentinelDir, 'effect-slots'), { recursive: true, force: true });
  // A symlinked intent under an otherwise valid deterministic ID also blocks.
  mkdirSync(join(sentinelDir, 'intents'), { recursive: true });
  const id = createHash('sha256').update(`wf-1\u0000continue\u0000sym-intent`).digest('hex').slice(0, 32);
  symlinkSync(join(base, 'outside-intent.json'), join(sentinelDir, 'intents', `${id}.json`));
  const blockedByIntent = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'sym-intent', source_revision: 'r', now: () => FIXED });
  assert.equal(blockedByIntent.accepted, false);
  assert.equal(blockedByIntent.state, 'blocked');
});

test('sentinel intent: an explicit unknown outcome blocks automation until reconciled', t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armFixture(packagePath, base, { mode: 'recover', actions: ['continue'], max_effects: 2 });
  const first = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'unknown-1', source_revision: 'r', now: () => FIXED });
  assert.equal(first.accepted, true);
  const unknown = finishIntent(authority, { workflow_id: 'wf-1', intent_id: first.intent.id, state: 'unknown', reason_code: 'outcome-uncertain', now: () => FIXED });
  assert.equal(unknown.state, 'unknown');
  // An exact unknown replay stays idempotent; a backward rewrite refuses.
  const replay = finishIntent(authority, { workflow_id: 'wf-1', intent_id: first.intent.id, state: 'unknown', reason_code: 'outcome-uncertain', now: () => FIXED });
  assert.equal(replay.state, 'unknown');
  assert.throws(() => finishIntent(authority, { workflow_id: 'wf-1', intent_id: first.intent.id, state: 'requested', reason_code: 'queued' }), /cannot transition/);
  // The same live authority cannot automate past the unresolved outcome.
  const distinct = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'unknown-2', source_revision: 'r', now: () => FIXED });
  assert.equal(distinct.accepted, false);
  assert.equal(distinct.state, 'blocked');
  assert.ok(distinct.reasons.some(reason => reason.startsWith('intent-unknown-outcome')));
  // The same subject returns the honest unknown, never duplicate permission.
  const repeat = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'unknown-1', source_revision: 'r', now: () => FIXED });
  assert.equal(repeat.accepted, false);
  assert.equal(repeat.state, 'unknown');
  assert.equal(repeat.duplicate, undefined);
  // A fresh authority re-enabling the same policy is blocked identically.
  const fresh = createSentinelAuthority();
  activatePolicy(fresh, activateArgs(packagePath, writePolicy(base, policyFor(packagePath, { mode: 'recover', actions: ['continue'], max_effects: 2 }))));
  const freshDistinct = reserveIntent(fresh, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'unknown-3', source_revision: 'r', now: () => FIXED });
  assert.equal(freshDistinct.accepted, false);
  assert.equal(freshDistinct.state, 'blocked');
  assert.ok(freshDistinct.reasons.some(reason => reason.startsWith('intent-unknown-outcome')));
  // The owning live authority's explicit reconciliation resolves the
  // uncertainty even after a fresh activation retired its grant rereads, and
  // the currently live authority may reserve again within the retained cap.
  const reconciled = finishIntent(authority, { workflow_id: 'wf-1', intent_id: first.intent.id, state: 'failed', reason_code: 'reconciled-failed', result_reference: 'receipt-1', now: () => FIXED });
  assert.equal(reconciled.state, 'failed');
  const after = reserveIntent(fresh, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'unknown-2', source_revision: 'r', now: () => FIXED });
  assert.equal(after.accepted, true);
});

test('sentinel intent: disable abandons unfinished exemptions while retaining reconciliation and spent slots', t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority, file } = armFixture(packagePath, base, { mode: 'recover', actions: ['continue'] });
  const reserve = subject => reserveIntent(authority, { kind: 'continue', subject_key: subject, source_revision: 'r', now: () => FIXED });
  const first = reserve('abandoned');
  finishIntent(authority, { intent_id: first.intent.id, state: 'requested', reason_code: 'queued' });
  disablePolicy(authority, { now: () => FIXED });
  activatePolicy(authority, activateArgs(packagePath, file));
  const blocked = reserve('next');
  assert.equal(blocked.accepted, false);
  assert.ok(blocked.reasons.some(reason => reason.startsWith('intent-unreconciled:')));
  assert.equal(reserve('abandoned').state, 'unknown');
  finishIntent(authority, { intent_id: first.intent.id, state: 'failed', reason_code: 'reconciled-veto' });
  assert.equal(reserve('next').accepted, true);
  assert.equal(reserve('third').accepted, false);
});

test('sentinel intent: reactivation in another package cannot finish a matching foreign intent ID', t => {
  const firstPackage = canonicalFixture(t);
  const secondPackage = canonicalFixture(t);
  const first = armFixture(firstPackage.packagePath, firstPackage.base, { mode: 'recover', actions: ['continue'] });
  const second = armFixture(secondPackage.packagePath, secondPackage.base, { mode: 'recover', actions: ['continue'] });
  const input = { kind: 'continue', subject_key: 'same-subject', source_revision: 'r', now: () => FIXED };
  const owned = reserveIntent(first.authority, input);
  const foreign = reserveIntent(second.authority, input);
  assert.equal(owned.intent.id, foreign.intent.id);
  disablePolicy(first.authority, { now: () => FIXED });
  activatePolicy(first.authority, activateArgs(secondPackage.packagePath, second.file));
  assert.throws(() => finishIntent(first.authority, { intent_id: foreign.intent.id, state: 'failed', reason_code: 'foreign' }), /not owned by the live authority/);
  assert.equal(reserveIntent(first.authority, input).state, 'unknown');
});

for (const failure of ['intent read', 'slot validation']) {
  test(`sentinel storage: failed ${failure} fences an owned request until terminal reconciliation`, t => {
    const { packagePath, base } = canonicalFixture(t);
    const { authority } = armFixture(packagePath, base, { mode: 'recover', actions: ['continue'] });
    const reserve = subject => reserveIntent(authority, { kind: 'continue', subject_key: subject, source_revision: 'r', now: () => FIXED });
    const first = reserve('uncertain');
    const update = (state, reason_code) => finishIntent(authority, { intent_id: first.intent.id, state, reason_code });
    update('requested', 'queued');
    const directory = join(packagePath, 'runtime', 'sentinel', 'wf-1');
    const path = failure === 'intent read'
      ? join(directory, 'intents', `${first.intent.id}.json`)
      : join(directory, 'effect-slots', '0.json');
    const retained = readFileSync(path);
    try {
      if (failure === 'intent read') writeFileSync(path, '{invalid');
      else unlinkSync(path);
      assert.throws(() => update('applied', 'delivered'));
    } finally { writeFileSync(path, retained); }
    assert.equal(reserve('next').accepted, false);
    assert.equal(reserve('uncertain').state, 'unknown');
    // Replaying the old requested receipt cannot certify an outcome.
    assert.equal(update('requested', 'queued').state, 'requested');
    assert.equal(reserve('next').accepted, false);
    assert.equal(update('failed', 'reconciled-failure').state, 'failed');
    assert.equal(update('failed', 'reconciled-failure').state, 'failed');
    assert.equal(reserve('next').accepted, true);
    assert.equal(reserve('third').accepted, false);
  });
}

test('sentinel storage: the reservation graph is validated in both directions and invalid state blocks either pool', t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armFixture(packagePath, base, { mode: 'recover', actions: ['continue'], diagnosis: { model: 'test/diag' }, max_effects: 2, max_diagnostics: 2 });
  const sentinelDir = join(packagePath, 'runtime', 'sentinel', 'wf-1');
  const first = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'graph-1', source_revision: 'r', now: () => FIXED });
  assert.equal(first.accepted, true);
  finishIntent(authority, { workflow_id: 'wf-1', intent_id: first.intent.id, state: 'applied', reason_code: 'done', now: () => FIXED });
  // A spent intent whose slot receipt was removed is missing retained history.
  unlinkSync(join(sentinelDir, 'effect-slots', `${first.slot}.json`));
  const missing = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'graph-2', source_revision: 'r', now: () => FIXED });
  assert.equal(missing.accepted, false);
  assert.equal(missing.state, 'blocked');
  assert.ok(missing.reasons.some(reason => reason.startsWith('slot-missing')));
  // A reservation in the other pool cannot bypass the corrupt effect pool.
  const bypass = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'diagnose', subject_key: 'gen-1', source_revision: 'r', now: () => FIXED });
  assert.equal(bypass.accepted, false);
  assert.equal(bypass.state, 'blocked');
  // Two slot receipts linking one intent are not exactly one slot.
  const slotBody = slot => ({ version: 1, workflow_id: 'wf-1', pool: 'effect', slot, intent_id: first.intent.id, kind: 'continue', reserved_at: new Date(FIXED).toISOString() });
  writeFileSync(join(sentinelDir, 'effect-slots', '0.json'), JSON.stringify(slotBody(0)));
  writeFileSync(join(sentinelDir, 'effect-slots', '1.json'), JSON.stringify(slotBody(1)));
  const duplicated = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'diagnose', subject_key: 'gen-2', source_revision: 'r', now: () => FIXED });
  assert.equal(duplicated.accepted, false);
  assert.ok(duplicated.reasons.some(reason => reason.startsWith('slot-duplicate')));
  // A nonregular pool directory blocks reservations in either pool.
  rmSync(join(sentinelDir, 'effect-slots'), { recursive: true, force: true });
  writeFileSync(join(sentinelDir, 'effect-slots'), 'not a directory');
  const invalidEffect = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'graph-3', source_revision: 'r', now: () => FIXED });
  assert.equal(invalidEffect.accepted, false);
  assert.ok(invalidEffect.reasons.some(reason => reason.startsWith('slot-state-invalid')));
  const invalidDiagnostic = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'diagnose', subject_key: 'gen-3', source_revision: 'r', now: () => FIXED });
  assert.equal(invalidDiagnostic.accepted, false);
  assert.ok(invalidDiagnostic.reasons.some(reason => reason.startsWith('slot-state-invalid')));
  // An invalid intents directory blocks the same way.
  rmSync(join(sentinelDir, 'intents'), { recursive: true, force: true });
  writeFileSync(join(sentinelDir, 'intents'), 'not a directory');
  const invalidIntents = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'graph-4', source_revision: 'r', now: () => FIXED });
  assert.equal(invalidIntents.accepted, false);
  assert.ok(invalidIntents.reasons.some(reason => reason.startsWith('intent-state-invalid')));
  // Legitimately absent initial directories never block a first reservation.
  const clean = canonicalFixture(t);
  const cleanArm = armFixture(clean.packagePath, clean.base, { mode: 'recover', actions: ['continue'] });
  const cleanFirst = reserveIntent(cleanArm.authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'fresh-1', source_revision: 'r', now: () => FIXED });
  assert.equal(cleanFirst.accepted, true);
  assert.equal(existsSync(join(clean.packagePath, 'runtime', 'sentinel', 'wf-1', 'diagnostic-slots')), false);
});

test('sentinel storage: newly created directories are durably linked through their parent before an effect', t => {
  const { packagePath, base } = canonicalFixture(t);
  recordCheckpoint(baseCheckpoint(packagePath));
  // The workflow directory exists but denies parent reads, so a newly created
  // authority directory cannot be durably published: creation still succeeds
  // while the linkage fsync fails, and activation must fail closed un-armed.
  const workflowDir = join(packagePath, 'runtime', 'sentinel', 'wf-1');
  const authority = createSentinelAuthority();
  chmodSync(workflowDir, 0o300);
  try {
    assert.throws(() => activatePolicy(authority, activateArgs(packagePath, writePolicy(base, policyFor(packagePath, { mode: 'recover', actions: ['continue'] })))), /durably published/);
  } finally {
    chmodSync(workflowDir, 0o700);
  }
  assert.equal(readPolicyGuard(authority).armed, false);

  // The same boundary refuses a first reservation on an armed authority.
  const armed = canonicalFixture(t);
  const armedAuthority = armFixture(armed.packagePath, armed.base, { mode: 'recover', actions: ['continue'] });
  const armedDir = join(armed.packagePath, 'runtime', 'sentinel', 'wf-1');
  chmodSync(armedDir, 0o300);
  try {
    assert.throws(() => reserveIntent(armedAuthority.authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'link-1', source_revision: 'r', now: () => FIXED }), /durably published/);
  } finally {
    chmodSync(armedDir, 0o700);
  }
  // Restoring the parent read repermits the reservation; nothing was spent.
  const after = reserveIntent(armedAuthority.authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'link-1', source_revision: 'r', now: () => FIXED });
  assert.equal(after.accepted, true);
});

// --- settle / continuation (step 6) ---

function settleFixture(t, { mode = 'recover', actions = ['continue'], checkpointOver = {}, policyOver = {} } = {}) {
  const { packagePath, base } = canonicalFixture(t);
  recordCheckpoint(baseCheckpoint(packagePath, checkpointOver));
  const authority = createSentinelAuthority();
  const file = writePolicy(base, policyFor(packagePath, { mode, actions, ...policyOver }));
  activatePolicy(authority, activateArgs(packagePath, file));
  return { packagePath, base, authority,
    options: (over = {}) => ({ authority, workflow_id: 'wf-1', package: packagePath, coordinator_session: 'session-1',
      inputGuard: () => ({ input_revision: 0, active_prompts: 0 }), activeManaged: () => false, now: () => FIXED, ...over }) };
}

test('sentinel settle: decideSettle vetoes each non-ready dimension', () => {
  const ready = { state: 'ready', package: '/p', obligation: { key: 'k', artifacts: [] }, obligation_revision: 'ob', input_revision: 0, workers: [] };
  const input = { input_revision: 0, active_prompts: 0 };
  const inbox = { blocking: false };
  const policy = { armed: true, blocking: false, allowed: ['continue'], mode: 'recover' };
  const table = (over = {}) => decideSettle({ event: over.event ?? { outcome: 'completed', context: { pendingMessages: [], canContinue: false }, entries: [] },
    checkpoint: over.checkpoint ?? ready, inputGuard: over.inputGuard ?? input, inboxGuard: over.inboxGuard ?? inbox,
    policyGuard: over.policyGuard ?? policy, activeManaged: 'activeManaged' in over ? over.activeManaged : false });
  assert.equal(table().allow, true);
  // An initial canContinue=false is deliberately not a veto.
  assert.equal(table({ event: { outcome: 'completed', context: { pendingMessages: [], canContinue: false }, entries: [] } }).allow, true);
  assert.equal(table({ event: { outcome: 'completed', continue: true, context: { pendingMessages: [] }, entries: [] } }).allow, false);
  assert.equal(table({ event: { outcome: 'aborted', context: { pendingMessages: [] }, entries: [] } }).allow, false);
  assert.equal(table({ checkpoint: { ...ready, state: 'waiting-external' } }).allow, false);
  assert.equal(table({ checkpoint: { ...ready, state: 'complete' } }).allow, false);
  assert.equal(table({ checkpoint: { ...ready, input_revision: 2 } }).allow, false);
  assert.equal(table({ inputGuard: { input_revision: 0, active_prompts: 1 } }).allow, false);
  assert.equal(table({ event: { outcome: 'completed', context: { pendingMessages: [{}] }, entries: [] } }).allow, false);
  assert.equal(table({ inboxGuard: { blocking: true } }).allow, false);
  assert.equal(table({ checkpoint: { ...ready, workers: [{ id: 'w', kind: 'owner', state: 'working' }] } }).allow, false);
  assert.equal(table({ activeManaged: true }).allow, false);
  assert.equal(table({ policyGuard: { ...policy, blocking: true } }).allow, false);
  assert.equal(table({ policyGuard: { ...policy, armed: false } }).allow, false);
  assert.equal(table({ policyGuard: { ...policy, allowed: ['cancel'] } }).allow, false);
  assert.equal(table({ policyGuard: { ...policy, mode: 'observe' } }).allow, false);
  assert.equal(table({ checkpoint: { ...ready, obligation_revision: '' } }).allow, false);
  // Missing/malformed context or guard data vetoes rather than normalizing to zero.
  assert.equal(table({ event: { outcome: 'completed', entries: [] } }).allow, false);
  assert.equal(table({ event: { outcome: 'completed', context: {}, entries: [] } }).allow, false);
  assert.equal(table({ event: { outcome: 'completed', context: { pendingMessages: 'none' }, entries: [] } }).allow, false);
  assert.equal(table({ checkpoint: { ...ready, input_revision: undefined } }).allow, false);
  assert.equal(table({ checkpoint: { ...ready, input_revision: -1 } }).allow, false);
  assert.equal(table({ inputGuard: { active_prompts: 0 } }).allow, false);
  assert.equal(table({ inputGuard: { input_revision: 0 } }).allow, false);
  assert.equal(table({ inputGuard: { input_revision: 0, active_prompts: -1 } }).allow, false);
  // Malformed entries/workers and a non-explicit active-worker status veto.
  assert.equal(table({ event: { outcome: 'completed', context: { pendingMessages: [] } } }).allow, false);
  assert.equal(table({ checkpoint: { ...ready, workers: 'bad' } }).allow, false);
  assert.equal(table({ checkpoint: { ...ready, workers: [{ id: 'w', kind: 'owner', state: 'bogus' }] } }).allow, false);
  assert.equal(table({ activeManaged: undefined }).allow, false);
});

test('sentinel settle: completed ready obligation continues once with entry preservation and requested intent', t => {
  const f = settleFixture(t);
  let requested = null;
  const event = { outcome: 'completed', context: { pendingMessages: [], canContinue: false },
    entries: [{ type: 'custom_message', customType: 'other-handler', display: true, content: 'earlier handler draft' }] };
  const result = handleBeforeSettle(event, f.options({ onRequested: intent => { requested = intent; } }));
  assert.ok(result, 'a ready obligation continues');
  assert.equal(result.continue, true);
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0], event.entries[0]);
  assert.equal(result.entries[1].type, 'custom_message');
  assert.equal(result.entries[1].customType, 'spec-sentinel');
  assert.equal(result.entries[1].display, true);
  assert.match(result.entries[1].content, /implement:step-004/);
  assert.match(result.entries[1].content, /revision/);
  assert.match(result.entries[1].content, /source digest [a-f0-9]{64}/);
  assert.match(result.entries[1].content, /artifacts 0/);
  assert.ok(requested, 'the continuation is marked requested');
  assert.equal(requested.state, 'requested');
  assert.equal(requested.kind, 'continue');
  // A second settlement with the same obligation is a duplicate, not a refill.
  assert.equal(handleBeforeSettle(event, f.options()), undefined);
});

test('sentinel settle: stop state, worker, input, prompt, inbox, active and policy vetoes abstain', t => {
  const stopped = settleFixture(t, { checkpointOver: { state: 'waiting-external' } });
  assert.equal(handleBeforeSettle({ outcome: 'completed', context: { pendingMessages: [] }, entries: [] }, stopped.options()), undefined);
  assert.equal(existsSync(join(stopped.packagePath, 'runtime', 'sentinel', 'wf-1', 'intents')), false);

  const worker = settleFixture(t);
  recordCheckpoint(baseCheckpoint(worker.packagePath, { expected_revision: 1, workers: [{ id: 'assign-1', kind: 'owner', state: 'working' }] }));
  assert.equal(handleBeforeSettle({ outcome: 'completed', context: { pendingMessages: [] }, entries: [] }, worker.options()), undefined);

  const input = settleFixture(t);
  assert.equal(handleBeforeSettle({ outcome: 'completed', context: { pendingMessages: [] }, entries: [] }, input.options({ inputGuard: () => ({ input_revision: 3, active_prompts: 0 }) })), undefined);

  const prompt = settleFixture(t);
  assert.equal(handleBeforeSettle({ outcome: 'completed', context: { pendingMessages: [] }, entries: [] }, prompt.options({ inputGuard: () => ({ input_revision: 0, active_prompts: 1 }) })), undefined);

  const inbox = settleFixture(t);
  putOriginal(inbox.packagePath, 'inbox', '20260101T000000Z-i1', original({ id: '20260101T000000Z-i1', kind: 'information' }));
  assert.equal(handleBeforeSettle({ outcome: 'completed', context: { pendingMessages: [] }, entries: [] }, inbox.options()), undefined);

  const active = settleFixture(t);
  assert.equal(handleBeforeSettle({ outcome: 'completed', context: { pendingMessages: [] }, entries: [] }, active.options({ activeManaged: () => true })), undefined);

  // An unknown active-worker status must veto, not normalize to false.
  const unknownActive = settleFixture(t);
  assert.equal(handleBeforeSettle({ outcome: 'completed', context: { pendingMessages: [] }, entries: [] }, unknownActive.options({ activeManaged: () => undefined })), undefined);

  const pending = settleFixture(t);
  assert.equal(handleBeforeSettle({ outcome: 'completed', context: { pendingMessages: [{}] }, entries: [] }, pending.options()), undefined);

  const malicious = settleFixture(t);
  assert.equal(handleBeforeSettle({ outcome: 'completed', context: {}, entries: [] }, malicious.options()), undefined);

  const disarmed = settleFixture(t);
  disablePolicy(disarmed.authority);
  assert.equal(handleBeforeSettle({ outcome: 'completed', context: { pendingMessages: [] }, entries: [] }, disarmed.options()), undefined);

  const expired = settleFixture(t);
  const expiredAt = FIXED + 2 * 60 * 60 * 1000;
  assert.equal(handleBeforeSettle({ outcome: 'completed', context: { pendingMessages: [] }, entries: [] }, expired.options({ now: () => expiredAt })), undefined);
});

test('sentinel settle: immediate recheck mutation abstains without reserving', t => {
  const f = settleFixture(t);
  let calls = 0;
  const inputGuard = () => ({ input_revision: calls++ === 0 ? 0 : 1, active_prompts: 0 });
  assert.equal(handleBeforeSettle({ outcome: 'completed', context: { pendingMessages: [] }, entries: [] }, f.options({ inputGuard })), undefined);
  assert.equal(existsSync(join(f.packagePath, 'runtime', 'sentinel', 'wf-1', 'intents')), false);
});

test('sentinel continuation: shadow records one would-continue observation and returns nothing', t => {
  const f = settleFixture(t, { mode: 'shadow' });
  const event = { outcome: 'completed', context: { pendingMessages: [] }, entries: [] };
  assert.equal(handleBeforeSettle(event, f.options()), undefined);
  const sentinelDir = join(f.packagePath, 'runtime', 'sentinel', 'wf-1');
  const names = readdirSync(join(sentinelDir, 'intents'));
  assert.equal(names.length, 1);
  const intent = JSON.parse(readFileSync(join(sentinelDir, 'intents', names[0]), 'utf8'));
  assert.equal(intent.state, 'blocked');
  assert.equal(intent.reason_code, 'shadow-would-continue');
  // A second shadow settlement is a duplicate, not a new observation.
  assert.equal(handleBeforeSettle(event, f.options()), undefined);
  assert.equal(readdirSync(join(sentinelDir, 'intents')).length, 1);
});

test('sentinel continuation: a crash-resumed unfinished reservation blocks', t => {
  const f = settleFixture(t);
  const event = { outcome: 'completed', context: { pendingMessages: [] }, entries: [] };
  assert.ok(handleBeforeSettle(event, f.options()), 'first live continuation reserves');
  // A fresh authority re-enables the same policy but never reconstructs the
  // created-intent capability, so the retained requested intent blocks.
  const restarted = createSentinelAuthority();
  activatePolicy(restarted, activateArgs(f.packagePath, writePolicy(f.base, policyFor(f.packagePath, { mode: 'recover', actions: ['continue'] }))));
  const restartedOptions = { authority: restarted, workflow_id: 'wf-1', package: f.packagePath, coordinator_session: 'session-1',
    inputGuard: () => ({ input_revision: 0, active_prompts: 0 }), activeManaged: () => false, now: () => FIXED };
  assert.equal(handleBeforeSettle(event, restartedOptions), undefined);
});

// --- bounded incident diagnosis (step 7) ---

const diagnosisIncident = (packagePath, over = {}) => ({
  id: 'd'.repeat(32), kind: 'repeated-verification-failure', assignment_id: 'assign-1', package: packagePath,
  generation: 1, linked_from: null, command_sha256: 'a'.repeat(64), summary_sha256: 'b'.repeat(64),
  tree_digest: 'c'.repeat(64), count: 3, tool_call_ids: ['call-1', 'call-2', 'call-3'],
  observed_at: new Date(FIXED).toISOString(), ...over,
});
const diagnosisRecord = (packagePath, base) => ({ id: 'run-diag', package: packagePath, checkout: base, assignment_id: 'assign-1' });
const diagnosisReply = (incident, over = {}) => JSON.stringify({
  decision: 'observe', fact_ids: [], reason_code: 'repeated-unchanged-failure',
  incident_id: incident.id, incident_generation: incident.generation, note: 'bounded note', ...over,
});
const leafHarness = replies => {
  const calls = [];
  const createLeaf = (events, options) => {
    calls.push({ events, options });
    return {
      run: async () => {
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      close() {},
    };
  };
  return { calls, createLeaf };
};
const armDiagnosis = (packagePath, base) => armFixture(packagePath, base, {
  mode: 'recover', actions: ['continue'], diagnosis: { model: 'test/diag' }, max_diagnostics: 2,
});

test('sentinel diagnosis: packet drops secrets and bounds large checkpoints', () => {
  const incident = diagnosisIncident('/pkg');
  const checkpoint = {
    revision: 4, state: 'ready', obligation_revision: 'e'.repeat(32), input_revision: 2, observed_at: new Date(FIXED).toISOString(),
    obligation: { key: 'impl:key', stage: 'implementation', summary: 'SECRET_SUMMARY_TOKEN', artifacts: [{ path: 'SECRET_PATH_TOKEN.md', sha256: 'f'.repeat(64) }] },
    workers: Array.from({ length: 8 }, (_, i) => ({ id: `w-${i}`, kind: 'owner', state: 'working' })).concat([{ id: 'SECRET_WORKER_TOKEN', kind: 'owner', state: 'working' }]),
    inbox_guard: { state: 'blocking', blocking: true, reasons: ['conflict:SECRET_REASON_TOKEN'],
      items: [{ id: 'item-1', sha256: '1'.repeat(64), state: 'held' }, { id: 'item-2', sha256: '2'.repeat(64), state: 'blocking' }] },
  };
  const built = buildDiagnosisPacket({ incident,
    record: { id: 'run-diag', checkout: '/repo', assignment_id: 'assign-1', pid: 'SECRET_PID_TOKEN' }, checkpoint,
    policy: { mode: 'recover', policy_hash: '9'.repeat(64), max_diagnostics: 2, expires_at: new Date(FIXED + 3600000).toISOString() } });
  for (const secret of ['SECRET_SUMMARY_TOKEN', 'SECRET_PATH_TOKEN', 'SECRET_WORKER_TOKEN', 'SECRET_REASON_TOKEN', 'SECRET_PID_TOKEN']) {
    assert.equal(built.json.includes(secret), false, `packet leaked ${secret}`);
  }
  for (const hash of ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]) assert.ok(built.json.includes(hash));
  assert.equal(built.packet.facts.find(fact => fact.id === 'worker.0.state').value, 'working');
  assert.equal(built.packet.facts.find(fact => fact.id === 'inbox.state').value, 'blocking');
  assert.equal(built.packet.coverage.state, 'partial');
  assert.ok(built.packet.coverage.omitted.includes('workers'));

  const manyWorkers = Array.from({ length: 60 }, (_, i) => ({ id: `worker-${i}-${'x'.repeat(80)}`, kind: 'owner', state: 'working' }));
  const manyItems = Array.from({ length: 60 }, (_, i) => ({ id: `item-${i}-${'y'.repeat(80)}`, sha256: '3'.repeat(64), state: i % 2 ? 'held' : 'blocking' }));
  const large = buildDiagnosisPacket({ incident, record: null,
    checkpoint: { ...checkpoint, workers: manyWorkers,
      inbox_guard: { state: 'blocking', blocking: true, reasons: Array.from({ length: 30 }, (_, i) => `reason-${i}:detail`), items: manyItems } },
    policy: null });
  assert.ok(large.bytes <= 16 * 1024, `packet ${large.bytes} bytes`);
  assert.ok(large.packet.facts.length <= 96, `packet ${large.packet.facts.length} facts`);
  assert.equal(large.packet.coverage.state, 'partial');
  assert.ok(large.packet.coverage.omitted.length > 0);
});

test('sentinel diagnosis: packet coverage marks each initial cap and value truncation independently', () => {
  const incident = diagnosisIncident('/pkg');
  const build = (checkpoint, record = null) => buildDiagnosisPacket({ incident, record, checkpoint, policy: null });
  const item = (id, state) => ({ id, sha256: id[0].repeat(64), state });
  // 17 supported artifacts with every other collection below its cap.
  const artifactsPacket = build({ obligation: { key: 'impl:key', stage: 'implementation',
    artifacts: Array.from({ length: 17 }, (_, i) => ({ path: `a-${i}.md`, sha256: String(i).repeat(64) })) } });
  assert.equal(artifactsPacket.packet.facts.filter(fact => fact.id.startsWith('artifact.')).length, 16);
  assert.equal(artifactsPacket.packet.facts.some(fact => fact.id === 'artifact.16.sha256'), false);
  assert.deepEqual(artifactsPacket.packet.coverage.omitted, ['artifact-hashes']);
  assert.ok(artifactsPacket.packet.coverage.reasons.includes('artifact-hashes-omitted'));
  assert.equal(artifactsPacket.packet.coverage.state, 'partial');
  // 13 reason categories with items and workers below their caps.
  const reasonsPacket = build({ inbox_guard: { state: 'blocking', blocking: true,
    reasons: Array.from({ length: 13 }, (_, i) => `cat-${i}:detail`), items: [] } });
  assert.equal(reasonsPacket.packet.facts.filter(fact => fact.id.startsWith('inbox.reason.')).length, 12);
  assert.deepEqual(reasonsPacket.packet.coverage.omitted, ['reason-categories']);
  assert.equal(reasonsPacket.packet.coverage.state, 'partial');
  // 13 held/blocking items with reasons and workers below their caps.
  const itemsPacket = build({ inbox_guard: { state: 'blocking', blocking: true, reasons: [],
    items: Array.from({ length: 13 }, (_, i) => item(`item-${i}`, i % 2 ? 'held' : 'blocking')) } });
  assert.equal(itemsPacket.packet.facts.filter(fact => fact.id.startsWith('inbox.item.')).length, 24);
  assert.deepEqual(itemsPacket.packet.coverage.omitted, ['inbox-items']);
  assert.equal(itemsPacket.packet.coverage.state, 'partial');
  // A bounded value sliced to the per-fact cap is a tracked truncation.
  const truncated = build({}, { checkout: 'c'.repeat(200) });
  assert.equal(truncated.packet.facts.find(fact => fact.id === 'record.checkout').value.length, 160);
  assert.deepEqual(truncated.packet.coverage.omitted, ['truncated-values']);
  assert.equal(truncated.packet.coverage.state, 'partial');
  // Everything below every cap stays complete with no omission markers.
  const complete = build({ obligation: { key: 'impl:key', stage: 'implementation',
      artifacts: Array.from({ length: 4 }, (_, i) => ({ path: `a-${i}.md`, sha256: String(i).repeat(64) })) },
    workers: [{ id: 'w-0', kind: 'owner', state: 'working' }, { id: 'w-1', kind: 'owner', state: 'working' }],
    inbox_guard: { state: 'blocking', blocking: true, reasons: ['c:1', 'd:2', 'e:3'],
      items: [item('item-0', 'held'), item('item-1', 'blocking'), item('item-2', 'held')] } },
    { id: 'run-diag', checkout: '/repo', assignment_id: 'assign-1' });
  assert.deepEqual(complete.packet.coverage, { state: 'complete', omitted: [], reasons: [] });
});

test('sentinel diagnosis: validator enforces the exact six-key response contract', () => {
  const incident = { id: 'd'.repeat(32), generation: 2 };
  const factIds = ['incident.id', 'incident.count'];
  const valid = { decision: 'observe', fact_ids: ['incident.id'], reason_code: 'repeated-unchanged-failure', incident_id: incident.id, incident_generation: 2, note: 'ok' };
  const ok = validateDiagnosisResult(JSON.stringify(valid), { incident, fact_ids: factIds });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.note_verified, false);
  const code = (text, options = { incident, fact_ids: factIds }) => validateDiagnosisResult(text, options).code;
  assert.equal(code('x'.repeat(8193)), 'oversize');
  assert.equal(code('not json'), 'not-json');
  assert.equal(code('[]'), 'not-object');
  assert.equal(code(JSON.stringify({ ...valid, extra: 1 })), 'unknown-field');
  assert.equal(code(JSON.stringify({ decision: 'observe', fact_ids: [], reason_code: 'repeated-unchanged-failure', incident_id: incident.id, incident_generation: 2 })), 'missing-field');
  assert.equal(code(JSON.stringify({ ...valid, decision: 'maybe' })), 'bad-enum');
  assert.equal(code(JSON.stringify({ ...valid, fact_ids: 'incident.id' })), 'bad-fact-ids');
  assert.equal(code(JSON.stringify({ ...valid, fact_ids: ['incident.id', 'incident.id'] })), 'bad-fact-ids');
  assert.equal(code(JSON.stringify({ ...valid, fact_ids: ['unknown'] })), 'unknown-fact-id');
  assert.equal(code(JSON.stringify({ ...valid, note: 'x'.repeat(501) })), 'bad-note');
  assert.equal(code(JSON.stringify({ ...valid, incident_id: 'e'.repeat(32) })), 'stale-incident');
  assert.equal(code(JSON.stringify({ ...valid, incident_generation: 3 })), 'stale-incident');
});

test('sentinel diagnosis: preconditions abstain without a leaf launch', async t => {
  const { packagePath, base } = canonicalFixture(t);
  const incident = diagnosisIncident(packagePath);
  const record = diagnosisRecord(packagePath, base);
  const disarmedHarness = leafHarness([]);
  const disarmed = await diagnoseIncident({ authority: createSentinelAuthority(), incident, record, workflow_id: 'wf-1', events: {}, createLeaf: disarmedHarness.createLeaf, now: () => FIXED });
  assert.equal(disarmed.launched, false);
  assert.equal(disarmedHarness.calls.length, 0);

  const { authority } = armDiagnosis(packagePath, base);
  unlinkSync(checkpointPath(packagePath, 'wf-1'));
  const noCheckpointHarness = leafHarness([]);
  const noCheckpoint = await diagnoseIncident({ authority, incident, record, workflow_id: 'wf-1', events: {}, createLeaf: noCheckpointHarness.createLeaf, now: () => FIXED });
  assert.equal(noCheckpoint.launched, false);
  assert.equal(noCheckpointHarness.calls.length, 0);
  assert.equal(existsSync(join(packagePath, 'runtime', 'sentinel', 'wf-1', 'diagnoses')), false);
});

test('sentinel diagnosis: a foreign package sharing the workflow ID is rejected before any reservation', async t => {
  const own = canonicalFixture(t);
  const other = canonicalFixture(t);
  const { authority } = armDiagnosis(own.packagePath, own.base);
  // The other canonical package registers and dispatches the same workflow ID
  // independently; both checkpoints are valid inside their own scope.
  recordCheckpoint(baseCheckpoint(other.packagePath));
  const foreignIncident = diagnosisIncident(other.packagePath);
  const foreignRecord = diagnosisRecord(other.packagePath, other.base);
  const ownIncident = diagnosisIncident(own.packagePath);
  const harness = leafHarness([{ result: diagnosisReply(ownIncident) }]);
  const foreign = await diagnoseIncident({ authority, incident: foreignIncident, record: foreignRecord,
    workflow_id: 'wf-1', events: {}, createLeaf: harness.createLeaf, now: () => FIXED });
  assert.equal(foreign.launched, false);
  assert.equal(foreign.state, 'blocked');
  assert.equal(foreign.error, 'package-mismatch');
  // A foreign incident attached to this package's own record is rejected too.
  const mixed = await diagnoseIncident({ authority, incident: foreignIncident, record: diagnosisRecord(own.packagePath, own.base),
    workflow_id: 'wf-1', events: {}, createLeaf: harness.createLeaf, now: () => FIXED });
  assert.equal(mixed.launched, false);
  assert.equal(mixed.state, 'blocked');
  assert.equal(mixed.error, 'incident-package-mismatch');
  // A record/incident assignment disagreement inside the canonical scope.
  const assignment = await diagnoseIncident({ authority, incident: diagnosisIncident(own.packagePath, { assignment_id: 'assign-other' }),
    record: diagnosisRecord(own.packagePath, own.base), workflow_id: 'wf-1', events: {}, createLeaf: harness.createLeaf, now: () => FIXED });
  assert.equal(assignment.launched, false);
  assert.equal(assignment.state, 'blocked');
  assert.equal(assignment.error, 'assignment-mismatch');
  assert.equal(harness.calls.length, 0, 'no rejected scope ever launches a leaf');
  // Nothing was reserved, retained or spent in either package.
  for (const pkg of [own.packagePath, other.packagePath]) {
    for (const leaf of ['intents', 'diagnoses', 'diagnostic-slots']) {
      assert.equal(existsSync(join(pkg, 'runtime', 'sentinel', 'wf-1', leaf)), false, `${leaf} must not exist in ${pkg}`);
    }
  }
  // The authority's own scope still diagnoses after the rejections.
  const applied = await diagnoseIncident({ authority, incident: ownIncident, record: diagnosisRecord(own.packagePath, own.base),
    workflow_id: 'wf-1', events: {}, createLeaf: harness.createLeaf, now: () => FIXED });
  assert.equal(applied.state, 'applied');
  assert.equal(harness.calls.length, 1);
});

test('sentinel diagnosis: a valid reply applies and retains one bounded attempt', async t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armDiagnosis(packagePath, base);
  const incident = diagnosisIncident(packagePath);
  const record = diagnosisRecord(packagePath, base);
  const harness = leafHarness([{ result: diagnosisReply(incident), usage: { input: 7, output: 3 } }]);
  const result = await diagnoseIncident({ authority, incident, record, workflow_id: 'wf-1', events: {}, createLeaf: harness.createLeaf, now: () => FIXED });
  assert.equal(result.launched, true);
  assert.equal(result.state, 'applied');
  assert.equal(result.decision, 'observe');
  assert.equal(result.reason_code, 'repeated-unchanged-failure');
  assert.equal(result.usage_available, true);
  assert.equal(result.attempt_path, diagnosisAttemptPath(packagePath, 'wf-1', incident.id));
  assert.equal(harness.calls.length, 1);
  const { options } = harness.calls[0];
  assert.equal(options.agent, 'spec-sentinel-diagnostician');
  assert.equal(options.nodeId, 'diagnostician');
  assert.equal(options.model, 'test/diag');
  assert.deepEqual(options.toolBudget, { hard: 0, block: '*' });
  assert.equal(options.skill, false);
  assert.equal(options.artifacts, false);
  assert.equal(options.cwd, base);
  assert.equal(options.label, 'Diagnosis');
  const stored = readDiagnosisAttempt(packagePath, 'wf-1', incident.id);
  assert.equal(stored.state, 'applied');
  assert.equal(stored.validation, 'valid');
  assert.equal(stored.decision, 'observe');
  assert.equal(stored.reason_code, 'repeated-unchanged-failure');
  assert.deepEqual(stored.fact_ids, []);
  assert.deepEqual(stored.usage, { input: 7, output: 3 });
  assert.equal(stored.usage_available, true);
  const duplicate = await diagnoseIncident({ authority, incident, record, workflow_id: 'wf-1', events: {}, createLeaf: harness.createLeaf, now: () => FIXED });
  assert.equal(duplicate.launched, false);
  assert.equal(duplicate.state, 'duplicate');
  assert.equal(harness.calls.length, 1);
});

test('sentinel diagnosis: failed attempt retention keeps an unknown blocking outcome and the spent slot', async t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armDiagnosis(packagePath, base);
  const incident = diagnosisIncident(packagePath);
  const record = diagnosisRecord(packagePath, base);
  // A non-directory at the diagnoses publication path leaves the intents and
  // budget directories writable, so only the retention guard can fail here.
  mkdirSync(join(packagePath, 'runtime', 'sentinel', 'wf-1'), { recursive: true });
  writeFileSync(join(packagePath, 'runtime', 'sentinel', 'wf-1', 'diagnoses'), 'not a directory');
  const harness = leafHarness([{ result: diagnosisReply(incident), usage: { input: 2 } }]);
  const result = await diagnoseIncident({ authority, incident, record, workflow_id: 'wf-1', events: {}, createLeaf: harness.createLeaf, now: () => FIXED });
  assert.equal(result.launched, true);
  assert.equal(result.state, 'unknown');
  assert.equal(result.decision, 'abstain');
  assert.equal(result.reason_code, 'attempt-retention-failed');
  assert.equal(result.note, null);
  assert.equal(result.fact_ids.length, 0);
  assert.equal(result.attempt_path, null);
  assert.ok(result.error, 'the storage failure is surfaced');
  assert.equal(readDiagnosisAttempt(packagePath, 'wf-1', incident.id), null);
  const intentsDirectory = join(packagePath, 'runtime', 'sentinel', 'wf-1', 'intents');
  const [intentFile] = readdirSync(intentsDirectory);
  const intent = JSON.parse(readFileSync(join(intentsDirectory, intentFile), 'utf8'));
  assert.equal(intent.state, 'unknown');
  assert.equal(intent.reason_code, 'attempt-retention-failed');
  assert.equal('result_reference' in intent, false);
  // The consumed diagnostic slot is retained and stays spent.
  assert.equal(readdirSync(join(packagePath, 'runtime', 'sentinel', 'wf-1', 'diagnostic-slots')).length, 1);
  // Every later reservation for this workflow stays blocked, in either pool.
  const blocked = reserveIntent(authority, { workflow_id: 'wf-1', kind: 'continue', subject_key: 'impl:s1',
    source_revision: 'rev-1', now: () => FIXED });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.state, 'blocked');
  assert.ok(blocked.reasons.some(reason => reason.startsWith('intent-unknown-outcome:')));
  const again = await diagnoseIncident({ authority, incident, record, workflow_id: 'wf-1', events: {}, createLeaf: harness.createLeaf, now: () => FIXED });
  assert.equal(again.launched, false);
  assert.equal(again.state, 'unknown');
  assert.equal(harness.calls.length, 1, 'no second launch after the retention failure');
});

test('sentinel diagnosis: missing usage stays unavailable and never zero', async t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armDiagnosis(packagePath, base);
  const incident = diagnosisIncident(packagePath);
  const record = diagnosisRecord(packagePath, base);
  const harness = leafHarness([{ result: diagnosisReply(incident) }]);
  const result = await diagnoseIncident({ authority, incident, record, workflow_id: 'wf-1', events: {}, createLeaf: harness.createLeaf, now: () => FIXED });
  assert.equal(result.state, 'applied');
  assert.equal(result.usage, null);
  assert.equal(result.usage_available, false);
  const stored = readDiagnosisAttempt(packagePath, 'wf-1', incident.id);
  assert.equal(stored.usage, null);
  assert.equal(stored.usage_available, false);
});

test('sentinel diagnosis: malformed replies fail closed and cool down without a second launch', async t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armDiagnosis(packagePath, base);
  const incident = diagnosisIncident(packagePath);
  const record = diagnosisRecord(packagePath, base);
  const harness = leafHarness([{ result: diagnosisReply(incident, { fact_ids: ['not-a-fact'] }) }]);
  const result = await diagnoseIncident({ authority, incident, record, workflow_id: 'wf-1', events: {}, createLeaf: harness.createLeaf, now: () => FIXED });
  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'unknown-fact-id');
  const stored = readDiagnosisAttempt(packagePath, 'wf-1', incident.id);
  assert.equal(stored.validation, 'invalid');
  assert.equal(stored.error, 'unknown-fact-id');
  assert.equal('result' in stored, false);
  assert.equal(JSON.stringify(stored).includes('not-a-fact'), false);
  const other = diagnosisIncident(packagePath, { id: 'e'.repeat(32), generation: 2 });
  const cooldown = await diagnoseIncident({ authority, incident: other, record, workflow_id: 'wf-1', events: {}, createLeaf: harness.createLeaf, now: () => FIXED });
  assert.equal(cooldown.launched, false);
  assert.equal(harness.calls.length, 1);
});

test('sentinel diagnosis: a stale incident reply fails closed', async t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armDiagnosis(packagePath, base);
  const incident = diagnosisIncident(packagePath);
  const record = diagnosisRecord(packagePath, base);
  const harness = leafHarness([{ result: diagnosisReply(incident, { incident_id: 'e'.repeat(32) }) }]);
  const result = await diagnoseIncident({ authority, incident, record, workflow_id: 'wf-1', events: {}, createLeaf: harness.createLeaf, now: () => FIXED });
  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'stale-incident');
  const stored = readDiagnosisAttempt(packagePath, 'wf-1', incident.id);
  assert.equal(stored.validation, 'invalid');
  assert.equal(stored.error, 'stale-incident');
});

test('sentinel diagnosis: the controller serializes attempts and reports a later duplicate', async t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armDiagnosis(packagePath, base);
  const record = diagnosisRecord(packagePath, base);
  const incidentA = diagnosisIncident(packagePath);
  const incidentB = diagnosisIncident(packagePath, { id: 'e'.repeat(32), generation: 2 });
  let clock = FIXED;
  let releaseA;
  const gateA = new Promise(resolve => { releaseA = resolve; });
  const calls = [];
  const createLeaf = (events, options) => ({
    run: async (task, signal) => {
      const index = calls.push({ options }) - 1;
      if (index === 0) await gateA;
      const packet = JSON.parse(task.slice(task.indexOf('PACKET:\n') + 'PACKET:\n'.length));
      return { result: JSON.stringify({ decision: 'observe', fact_ids: [], reason_code: 'repeated-unchanged-failure',
        incident_id: packet.incident_id, incident_generation: packet.incident_generation, note: 'ok' }), usage: { input: 1 } };
    },
    close() {},
  });
  const controller = createDiagnosisController({ authority, workflow_id: 'wf-1', events: {}, createLeaf, now: () => clock });
  const pendingA = controller.diagnose(record, incidentA);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(controller.active(), true);
  const pendingB = controller.diagnose(record, incidentB);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'a later incident waits for the active attempt');
  clock = FIXED + 6 * 60 * 1000;
  releaseA();
  const resultA = await pendingA;
  const resultB = await pendingB;
  assert.equal(resultA.state, 'applied');
  assert.equal(resultB.state, 'applied');
  assert.equal(calls.length, 2);
  const again = await controller.diagnose(record, incidentA);
  assert.equal(again.launched, false);
  assert.equal(again.state, 'duplicate');
  assert.equal(calls.length, 2);
});

test('sentinel diagnosis: cancel aborts only the owned attempt and close refuses later ones', async t => {
  const { packagePath, base } = canonicalFixture(t);
  const { authority } = armDiagnosis(packagePath, base);
  const record = diagnosisRecord(packagePath, base);
  const incident = diagnosisIncident(packagePath);
  const calls = [];
  let aborted = 0;
  const createLeaf = (events, options) => ({
    run: async (task, signal) => {
      calls.push({ options });
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { aborted += 1; reject(new Error('aborted')); }, { once: true });
      });
    },
    close() {},
  });
  const controller = createDiagnosisController({ authority, workflow_id: 'wf-1', events: {}, createLeaf, now: () => FIXED });
  const pending = controller.diagnose(record, incident);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  controller.cancel('stop');
  const result = await pending;
  assert.equal(result.state, 'failed');
  assert.equal(result.reason_code, 'cancelled');
  assert.equal(aborted, 1);
  controller.close();
  const after = await controller.diagnose(record, incident);
  assert.equal(after, null);
  assert.equal(calls.length, 1);
});

test('sentinel diagnosis: the real owned leaf deadline and an unavailable model abstain without a second launch', async t => {
  const requestEvent = 'prompt-template:subagent:request';
  const startedEvent = 'prompt-template:subagent:started';
  const responseEvent = 'prompt-template:subagent:response';
  const bus = () => {
    const listeners = new Map();
    return {
      requests: [],
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
      emit(name, value) { for (const fn of [...(listeners.get(name) || [])]) fn(value); },
    };
  };

  // A started reply clears the readiness timer, so only the owned leaf's own
  // deadline can end the wait; no response is ever emitted.
  const deadline = canonicalFixture(t);
  const deadlineArm = armDiagnosis(deadline.packagePath, deadline.base);
  const deadlineRecord = diagnosisRecord(deadline.packagePath, deadline.base);
  const deadlineIncident = diagnosisIncident(deadline.packagePath);
  const deadlineEvents = bus();
  deadlineEvents.on(requestEvent, value => {
    deadlineEvents.requests.push(value);
    deadlineEvents.emit(startedEvent, { requestId: value.requestId, ownerRunId: value.ownerRunId, nodeId: value.nodeId });
  });
  const expired = await diagnoseIncident({ authority: deadlineArm.authority, incident: deadlineIncident, record: deadlineRecord,
    workflow_id: 'wf-1', events: deadlineEvents, timeoutMs: 5, readyMs: 5000, now: () => FIXED });
  assert.equal(expired.launched, true);
  assert.equal(expired.state, 'failed');
  assert.equal(deadlineEvents.requests.length, 1);
  const noSecond = await diagnoseIncident({ authority: deadlineArm.authority, incident: deadlineIncident, record: deadlineRecord,
    workflow_id: 'wf-1', events: deadlineEvents, timeoutMs: 5, readyMs: 5000, now: () => FIXED });
  assert.equal(noSecond.launched, false);
  assert.equal(deadlineEvents.requests.length, 1, 'no second or fallback launch for the same incident');

  // An unavailable model fails the one owned request and is never retried.
  const unavailable = canonicalFixture(t);
  const unavailableArm = armDiagnosis(unavailable.packagePath, unavailable.base);
  const unavailableRecord = diagnosisRecord(unavailable.packagePath, unavailable.base);
  const unavailableIncident = diagnosisIncident(unavailable.packagePath);
  const unavailableEvents = bus();
  unavailableEvents.on(requestEvent, value => {
    unavailableEvents.requests.push(value);
    unavailableEvents.emit(responseEvent, { ...value, status: 'failed', error: 'Selected model unavailable' });
  });
  const failed = await diagnoseIncident({ authority: unavailableArm.authority, incident: unavailableIncident, record: unavailableRecord,
    workflow_id: 'wf-1', events: unavailableEvents, now: () => FIXED });
  assert.equal(failed.launched, true);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'Selected model unavailable');
  assert.equal(unavailableEvents.requests.length, 1, 'the unavailable model makes no retry or fallback request');
});
