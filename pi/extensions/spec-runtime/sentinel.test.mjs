import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reduceVerificationResult, readVerificationIncidents, writeVerificationIncidents, verificationIncidentsPath, createVerificationRecorder } from './sentinel.mjs';

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
