import assert from 'node:assert/strict';
import { test } from 'node:test';
import { specRecordFor, specRoute, workTourRoute } from './agent-links';
// Namespace access keeps a missing extension export a behavior assertion
// instead of an import-time module failure.
import * as agentLinksModule from './agent-links';
import type { RouteState } from './route';
import type { WireRecord } from './model';

// The cast defers the new relationship exports to their callsites so the type
// gate stays green before those production exports land.
const agentLinks = agentLinksModule as unknown as {
  threadRoute: (a: WireRecord) => RouteState | null;
  briefRoute: (a: WireRecord) => RouteState | null;
  repositoryFilesRoute: (ws: string, repositoryId: unknown) => RouteState | null;
  launchedAgents: (
    thread: WireRecord,
    assignments: WireRecord[],
  ) => { handoff: WireRecord; row: WireRecord | null }[];
};

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

const THREAD_ID = '8f3b1a2e-4c5d-4e6f-8a9b-0c1d2e3f4a5b';

test('threadRoute: routes a nonempty workspace and thread id to conversations', () => {
  const record = frozen({ workspace_id: 'ws-a', thread_id: THREAD_ID });
  const expected: RouteState = { dest: 'conversations', ws: 'ws-a', id: '8f3b1a2e-4c5d-4e6f-8a9b-0c1d2e3f4a5b' };
  assert.deepEqual(agentLinks.threadRoute(record), expected);
});

test('threadRoute: refuses missing, empty or whitespace workspace and thread ids', () => {
  assert.equal(agentLinks.threadRoute(frozen({ thread_id: THREAD_ID })), null);
  assert.equal(agentLinks.threadRoute(frozen({ workspace_id: '', thread_id: THREAD_ID })), null);
  assert.equal(agentLinks.threadRoute(frozen({ workspace_id: '   ', thread_id: THREAD_ID })), null);
  assert.equal(agentLinks.threadRoute(frozen({ workspace_id: 'ws-a' })), null);
  assert.equal(agentLinks.threadRoute(frozen({ workspace_id: 'ws-a', thread_id: '' })), null);
  assert.equal(agentLinks.threadRoute(frozen({ workspace_id: 'ws-a', thread_id: '   ' })), null);
});

test('repositoryFilesRoute: routes a repository id to repository files', () => {
  const expected: RouteState = { dest: 'files', ws: 'ws-a', source: 'repository', id: 'repo-1' };
  assert.deepEqual(agentLinks.repositoryFilesRoute('ws-a', 'repo-1'), expected);
});

test('repositoryFilesRoute: refuses an empty workspace and a missing repository id', () => {
  assert.equal(agentLinks.repositoryFilesRoute('', 'repo-1'), null);
  assert.equal(agentLinks.repositoryFilesRoute('ws-a', ''), null);
  assert.equal(agentLinks.repositoryFilesRoute('ws-a', null), null);
  assert.equal(agentLinks.repositoryFilesRoute('ws-a', undefined), null);
  assert.equal(agentLinks.repositoryFilesRoute('ws-a', 42), null);
});

test('briefRoute: routes a safe relative brief path to workspace files', () => {
  const record = frozen({ workspace_id: 'ws-a', brief: 'briefs/id.md' });
  const expected: RouteState = { dest: 'files', ws: 'ws-a', source: 'workspace', path: 'briefs/id.md' };
  assert.deepEqual(agentLinks.briefRoute(record), expected);
});

test('briefRoute: refuses unsafe brief paths and a missing workspace', () => {
  for (const brief of ['/abs.md', 'back\\slash.md', 'nul\0char.md', '', '.', '..', 'a//b', 'a/../b', 'a/./b']) {
    assert.equal(
      agentLinks.briefRoute(frozen({ workspace_id: 'ws-a', brief })),
      null,
      `brief ${JSON.stringify(brief)} must not route`,
    );
  }
  assert.equal(agentLinks.briefRoute(frozen({ workspace_id: 'ws-a' })), null);
  assert.equal(agentLinks.briefRoute(frozen({ brief: 'briefs/id.md' })), null);
  assert.equal(agentLinks.briefRoute(frozen({ workspace_id: '', brief: 'briefs/id.md' })), null);
});

test('launchedAgents: joins a sent handoff with its exact assignment row', () => {
  const handoff = frozen({ assignment_id: 'a-1', thread_id: THREAD_ID });
  const row = frozen({ assignment_id: 'a-1', workspace: 'ws-a', state: 'live' });
  const thread = frozen({ workspace_id: 'ws-a', handoffs: [handoff] });
  assert.deepEqual(agentLinks.launchedAgents(thread, [row]), [{ handoff, row }]);
});

test('launchedAgents: keeps a sent handoff without a matching row', () => {
  const handoff = frozen({ assignment_id: 'a-1' });
  const other = frozen({ assignment_id: 'a-2', workspace: 'ws-a' });
  const thread = frozen({ workspace_id: 'ws-a', handoffs: [handoff] });
  assert.deepEqual(agentLinks.launchedAgents(thread, [other]), [{ handoff, row: null }]);
});

test('launchedAgents: omits unsent handoffs without a nonempty assignment id', () => {
  const sent = frozen({ assignment_id: 'a-1' });
  const thread = frozen({
    workspace_id: 'ws-a',
    handoffs: [
      frozen({ assignment_id: '' }),
      frozen({ thread_id: THREAD_ID }),
      sent,
      frozen({ assignment_id: null }),
    ],
  });
  assert.deepEqual(agentLinks.launchedAgents(thread, []), [{ handoff: sent, row: null }]);
});

test('launchedAgents: returns included handoffs in recorded order regardless of row order', () => {
  const first = frozen({ assignment_id: 'a-1', label: 'first' });
  const second = frozen({ assignment_id: 'a-2', label: 'second' });
  const rowFirst = frozen({ assignment_id: 'a-1', workspace: 'ws-a' });
  const rowSecond = frozen({ assignment_id: 'a-2', workspace: 'ws-a' });
  const thread = frozen({ workspace_id: 'ws-a', handoffs: [first, second] });
  assert.deepEqual(agentLinks.launchedAgents(thread, [rowSecond, rowFirst]), [
    { handoff: first, row: rowFirst },
    { handoff: second, row: rowSecond },
  ]);
});

test('launchedAgents: refuses to join an assignment row from another workspace', () => {
  const handoff = frozen({ assignment_id: 'a-1' });
  const foreign = frozen({ assignment_id: 'a-1', workspace: 'ws-b' });
  const thread = frozen({ workspace_id: 'ws-a', handoffs: [handoff] });
  assert.deepEqual(agentLinks.launchedAgents(thread, [foreign]), [{ handoff, row: null }]);
});

test('launchedAgents: matches a trimmed observed row workspace', () => {
  const handoff = frozen({ assignment_id: 'a-1' });
  const padded = frozen({ assignment_id: 'a-1', workspace: ' ws-a ' });
  const thread = frozen({ workspace_id: 'ws-a', handoffs: [handoff] });
  assert.deepEqual(agentLinks.launchedAgents(thread, [padded]), [{ handoff, row: padded }]);
});
