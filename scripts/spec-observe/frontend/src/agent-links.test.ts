import assert from 'node:assert/strict';
import { test } from 'node:test';
import { specRecordFor, specRoute, workTourRoute } from './agent-links';
import type { RouteState } from './route';

const frozen = <T>(value: T): T => Object.freeze(value) as T;

const T_EARLY = '2026-01-01T00:00:00.000Z';
const T_MID = '2026-06-01T00:00:00.000Z';
const T_LATE = '2026-12-01T00:00:00.000Z';

const assignment = frozen({
  workspace: 'ws-a',
  spec_package: 'pkg/core',
  workflow_id: 'wf-1',
  assignment_id: 'a-1',
});

test('specRecordFor: exact compatible assignment beats a newer current sibling', () => {
  const exact = frozen({
    key: 'k-exact',
    workspace: 'ws-a',
    package: 'pkg/core',
    workflow_id: 'wf-1',
    assignment_id: 'a-1',
    is_current_assignment: false,
    observed_at: T_EARLY,
  });
  const current = frozen({
    key: 'k-current',
    workspace: 'ws-a',
    package: 'pkg/core',
    workflow_id: 'wf-1',
    is_current_assignment: true,
    observed_at: T_LATE,
  });
  assert.deepEqual(specRecordFor(assignment, [current, exact]), { record: exact, match: 'assignment' });
});

test('specRecordFor: compatible assignments without an exact id sort by key ascending', () => {
  const later = frozen({
    key: 'k-b',
    workspace: 'ws-a',
    package: 'pkg/core',
    workflow_id: 'wf-1',
    is_current_assignment: true,
    observed_at: T_LATE,
  });
  const earlier = frozen({
    key: 'k-a',
    workspace: 'ws-a',
    package: 'pkg/core',
    workflow_id: 'wf-1',
    observed_at: T_EARLY,
  });
  assert.deepEqual(specRecordFor(assignment, [later, earlier]), { record: earlier, match: 'assignment' });
});

test('specRecordFor: explicit different assignment_id is never an assignment match', () => {
  const foreignAssignment = frozen({
    key: 'k-other',
    workspace: 'ws-a',
    package: 'pkg/core',
    workflow_id: 'wf-1',
    assignment_id: 'a-2',
    is_current_assignment: true,
    observed_at: T_LATE,
  });
  assert.deepEqual(specRecordFor(assignment, [foreignAssignment]), { record: foreignAssignment, match: 'package' });
});

test('specRecordFor: explicit different assignment_id yields to a compatible sibling', () => {
  const foreignAssignment = frozen({
    key: 'k-other',
    workspace: 'ws-a',
    package: 'pkg/core',
    workflow_id: 'wf-1',
    assignment_id: 'a-2',
    is_current_assignment: true,
    observed_at: T_LATE,
  });
  const compatible = frozen({
    key: 'k-compatible',
    workspace: 'ws-a',
    package: 'pkg/core',
    workflow_id: 'wf-1',
    observed_at: T_EARLY,
  });
  assert.deepEqual(specRecordFor(assignment, [foreignAssignment, compatible]), { record: compatible, match: 'assignment' });
});

test('specRecordFor: foreign normalized workspace never resolves despite a shared snapshot workspace', () => {
  const scoped = frozen({
    workspace: 'ws-a',
    spec_package: 'pkg/core',
    workflow_id: 'wf-1',
    assignment_id: 'a-1',
    observer: frozen({ observer_id: 'obs-a', snapshot: frozen({ workspace: 'ws-a' }) }),
  });
  const foreign = frozen({
    key: 'k-foreign',
    workspace: 'ws-b',
    package: 'pkg/core',
    workflow_id: 'wf-1',
    assignment_id: 'a-1',
    observer: frozen({ observer_id: 'obs-a', snapshot: frozen({ workspace: 'ws-a' }) }),
  });
  assert.equal(specRecordFor(scoped, [foreign]), null);
});

test('specRecordFor: no matching candidate yields null', () => {
  assert.equal(specRecordFor(assignment, []), null);
  assert.equal(specRecordFor(assignment, [
    frozen({ key: 'k-other-ws', workspace: 'ws-b', package: 'pkg/core' }),
    frozen({ key: 'k-other-pkg', workspace: 'ws-a', package: 'pkg/other' }),
  ]), null);
});

test('specRecordFor: empty spec_package yields null', () => {
  const empty = frozen({ workspace: 'ws-a', spec_package: '', workflow_id: 'wf-1', assignment_id: 'a-1' });
  const record = frozen({ key: 'k-empty', workspace: 'ws-a', package: '', workflow_id: 'wf-1', assignment_id: 'a-1' });
  assert.equal(specRecordFor(empty, [record]), null);
  assert.equal(specRecordFor({ workspace: 'ws-a', workflow_id: 'wf-1', assignment_id: 'a-1' }, [record]), null);
});

test('specRecordFor: normalizes workspace whitespace and trailing package slashes', () => {
  const padded = frozen({ workspace: ' ws-a ', spec_package: 'pkg/core/', workflow_id: 'wf-1', assignment_id: 'a-1' });
  const record = frozen({
    key: 'k-norm',
    workspace: 'ws-a',
    spec_package: 'pkg/core',
    workflow_id: 'wf-1',
    assignment_id: 'a-1',
    observed_at: T_EARLY,
  });
  assert.deepEqual(specRecordFor(padded, [record]), { record, match: 'assignment' });

  const viaRef = frozen({
    key: 'k-ref',
    workspace: 'ws-a',
    package_ref: 'pkg/core/',
    workflow_id: 'wf-1',
    assignment_id: 'a-1',
    observed_at: T_EARLY,
  });
  assert.deepEqual(specRecordFor(assignment, [viaRef]), { record: viaRef, match: 'assignment' });
});

test('specRecordFor: package fallback ranks current then active then planned then recent completion', () => {
  const current = frozen({
    key: 'k-current',
    workspace: 'ws-a',
    package: 'pkg/core',
    is_current_assignment: true,
    execution: 'stopped',
    observed_at: T_EARLY,
  });
  const active = frozen({ key: 'k-active', workspace: 'ws-a', package: 'pkg/core', execution: 'running', observed_at: T_EARLY });
  const planned = frozen({ key: 'k-planned', workspace: 'ws-a', package: 'pkg/core', planned: true, observed_at: T_EARLY });
  const completed = frozen({ key: 'k-completed', workspace: 'ws-a', package: 'pkg/core', recent_completion: true, completed_at: T_MID });
  const plain = frozen({ key: 'k-plain', workspace: 'ws-a', package: 'pkg/core', execution: 'stopped', observed_at: T_MID });
  const records = [plain, completed, planned, active, current];
  assert.deepEqual(specRecordFor(assignment, records), { record: current, match: 'package' });
  assert.deepEqual(specRecordFor(assignment, records.slice(0, 4)), { record: active, match: 'package' });
  assert.deepEqual(specRecordFor(assignment, records.slice(0, 3)), { record: planned, match: 'package' });
  assert.deepEqual(specRecordFor(assignment, records.slice(0, 2)), { record: completed, match: 'package' });
  assert.deepEqual(specRecordFor(assignment, records.slice(0, 1)), { record: plain, match: 'package' });
});

test('specRecordFor: package fallback prefers newer observed_at when flags tie', () => {
  const older = frozen({ key: 'k-a-older', workspace: 'ws-a', package: 'pkg/core', observed_at: T_MID });
  const newer = frozen({ key: 'k-z-newer', workspace: 'ws-a', package: 'pkg/core', observed_at: T_LATE });
  assert.deepEqual(specRecordFor(assignment, [newer, older]), { record: newer, match: 'package' });
});

test('specRecordFor: package fallback uses completed_at when observed_at ties', () => {
  const observedOnly = frozen({ key: 'k-a-observed', workspace: 'ws-a', package: 'pkg/core', observed_at: T_MID });
  const completedNewer = frozen({
    key: 'k-z-completed',
    workspace: 'ws-a',
    package: 'pkg/core',
    observed_at: T_MID,
    completed_at: T_LATE,
  });
  assert.deepEqual(specRecordFor(assignment, [observedOnly, completedNewer]), { record: completedNewer, match: 'package' });
});

test('specRecordFor: package fallback breaks timestamp ties by key ascending', () => {
  const z = frozen({ key: 'k-z', workspace: 'ws-a', package: 'pkg/core', observed_at: T_LATE });
  const a = frozen({ key: 'k-a', workspace: 'ws-a', package: 'pkg/core', observed_at: T_LATE });
  assert.deepEqual(specRecordFor(assignment, [z, a]), { record: a, match: 'package' });
});

test('specRecordFor: package fallback treats unparseable timestamps as zero', () => {
  const invalid = frozen({
    key: 'k-a-invalid',
    workspace: 'ws-a',
    package: 'pkg/core',
    observed_at: 'not-a-date',
    completed_at: 'still-not-a-date',
  });
  const valid = frozen({ key: 'k-z-valid', workspace: 'ws-a', package: 'pkg/core', observed_at: T_LATE });
  assert.deepEqual(specRecordFor(assignment, [invalid, valid]), { record: valid, match: 'package' });
});

test('specRoute: sets completed filter only for recent completion', () => {
  const record = frozen({ key: 'k-done', recent_completion: true });
  const expected: RouteState = { dest: 'specs', id: 'k-done', filter: 'completed' };
  assert.deepEqual(specRoute(record), expected);
});

test('specRoute: sets planned filter only for planned records', () => {
  const record = frozen({ key: 'k-planned', planned: true });
  const expected: RouteState = { dest: 'specs', id: 'k-planned', filter: 'planned' };
  assert.deepEqual(specRoute(record), expected);
});

test('specRoute: sets no filter when completed and planned flags are false', () => {
  const record = frozen({ key: 'k-live', recent_completion: false, planned: false });
  const expected: RouteState = { dest: 'specs', id: 'k-live' };
  assert.deepEqual(specRoute(record), expected);
});

test('specRoute: prefers completed when both flags are set', () => {
  const record = frozen({ key: 'k-both', recent_completion: true, planned: true });
  const expected: RouteState = { dest: 'specs', id: 'k-both', filter: 'completed' };
  assert.deepEqual(specRoute(record), expected);
});

test('specRoute: preserves ws verbatim and omits empty ws', () => {
  const record = frozen({ key: 'k-ws', planned: true });
  const expected: RouteState = { dest: 'specs', id: 'k-ws', filter: 'planned', ws: ' ws/one ' };
  assert.deepEqual(specRoute(record, ' ws/one '), expected);
  assert.deepEqual(specRoute(record), { dest: 'specs', id: 'k-ws', filter: 'planned' });
  assert.deepEqual(specRoute(record, ''), { dest: 'specs', id: 'k-ws', filter: 'planned' });
});

test('workTourRoute: returns null without recorded evidence', () => {
  assert.equal(workTourRoute(frozen({ key: 'k-none', package: 'pkg/core' })), null);
  assert.equal(workTourRoute(frozen({ key: 'k-pending', package: 'pkg/core', evidence: frozen({ state: 'pending' }) })), null);
});

test('workTourRoute: returns null without a nonempty canonical record.package', () => {
  assert.equal(workTourRoute(frozen({ key: 'k-empty', package: '', evidence: frozen({ state: 'recorded' }) })), null);
  assert.equal(workTourRoute(frozen({ key: 'k-ref', package_ref: 'pkg/core', evidence: frozen({ state: 'recorded' }) })), null);
});

test('workTourRoute: builds the files route from the recorded canonical package', () => {
  const record = frozen({ key: 'k-tour', package: 'pkg/core', evidence: frozen({ state: 'recorded' }) });
  const expected: RouteState = { dest: 'files', source: 'package', id: 'pkg/core', path: 'work-tour.html' };
  assert.deepEqual(workTourRoute(record), expected);
  assert.deepEqual(workTourRoute(record, ' ws-a '), { ...expected, ws: ' ws-a ' });
});
