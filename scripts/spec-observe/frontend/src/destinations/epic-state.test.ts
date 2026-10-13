import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setClock } from '../format';
import type { WireRecord } from '../model';
import type { CatalogEntry } from '../scope';
import { catalogEntryForRecord, workspaceRelativePath } from '../scope';
import {
  epicCoverageReasons,
  epicDocumentLinks,
  epicMemberRequires,
  epicMemberStatus,
  epicMemberPlanningRow,
  epicPlanningIncomplete,
  epicRecordedState,
  epicViewState,
  focusMember,
  memberPlanning,
  memberRecords,
  nextToPlan,
  visibleEpics,
} from './epic-state';

test('recorded state separates a complete record from landed member evidence', () => {
  const unlanded = {
    state: 'complete',
    summary: { total: 3 },
    members: [{ name: 'a', status: 'published' }, { name: 'b', status: 'prepared' }, { name: 'c', status: 'unknown' }],
  };
  assert.deepEqual(epicRecordedState(unlanded), { label: 'Recorded complete', tone: 'warning', conflict: true });
  const landed = { state: 'complete', summary: { total: 1, merged: 1 }, members: [{ name: 'a', status: 'merged' }] };
  assert.deepEqual(epicRecordedState(landed), { label: 'Complete', tone: 'success', conflict: false });
  for (const [state, label] of [['planned', 'Planned'], ['active', 'Active'], ['abandoned', 'Abandoned']] as const) {
    assert.deepEqual(epicRecordedState({ state }), { label, tone: 'neutral', conflict: false });
  }
  assert.deepEqual(epicRecordedState({ state: 'ready' }), { label: 'ready', tone: 'neutral', conflict: false });
  assert.deepEqual(epicRecordedState({}), { label: 'Not recorded', tone: 'neutral', conflict: false });
});

test('member status keeps the recorded vocabulary and notes stay text', () => {
  assert.deepEqual(epicMemberStatus({ status: 'merged' }), { label: 'Merged', tone: 'success' });
  assert.deepEqual(epicMemberStatus({ status: 'complete' }), { label: 'Marked complete', tone: 'success' });
  assert.deepEqual(epicMemberStatus({ status: 'published' }), { label: 'PR published', tone: 'info' });
  assert.deepEqual(epicMemberStatus({ status: 'in-progress', step: { position: 2, total: 3 } }), { label: 'In progress · step 2 of 3', tone: 'info' });
  assert.deepEqual(epicMemberStatus({ status: 'in-progress', attention: true }), { label: 'In progress · needs attention', tone: 'warning' });
  assert.deepEqual(epicMemberStatus({ status: 'in-progress', step: { position: 1, total: 2 }, attention: true }), { label: 'In progress · step 1 of 2 · needs attention', tone: 'warning' });
  assert.deepEqual(epicMemberStatus({ status: 'prepared', note: 'Not undertaken' }), { label: 'Prepared', tone: 'neutral' });
  assert.deepEqual(epicMemberStatus({ status: 'proposed' }), { label: 'Proposed', tone: 'neutral' });
  assert.deepEqual(epicMemberStatus({ status: 'missing' }), { label: 'Package missing', tone: 'warning' });
  assert.deepEqual(epicMemberStatus({ status: 'unobserved' }), { label: 'Not observed', tone: 'warning' });
  assert.deepEqual(epicMemberStatus({ status: 'unknown' }), { label: 'Evidence incomplete', tone: 'warning' });
  assert.deepEqual(epicMemberStatus({ status: 'ready' }), { label: 'ready', tone: 'neutral' });
  assert.deepEqual(epicMemberStatus({}), { label: 'Not recorded', tone: 'neutral' });
});

test('declared requirements stay distinct from unmet-only reports and focus order is fixed', () => {
  const declared = epicMemberRequires({ requires: ['a'], waiting_on: [] });
  assert.deepEqual(declared, { names: ['a'], waiting: [] as string[], declared: true });
  declared.names.push('mutated');
  declared.waiting.push('mutated');
  assert.deepEqual(epicMemberRequires({ requires: ['a'], waiting_on: [] }), { names: ['a'], waiting: [], declared: true });

  const unmet = { waiting_on: ['b'] };
  const reported = epicMemberRequires(unmet);
  assert.deepEqual(reported, { names: ['b'], waiting: ['b'], declared: false });
  reported.names.push('mutated');
  reported.waiting.push('mutated');
  assert.deepEqual(unmet, { waiting_on: ['b'] });
  assert.deepEqual(epicMemberRequires({ requires: [], waiting_on: [] }), { names: [], waiting: [], declared: true });

  const members = [
    { name: 'one', status: 'published' },
    { name: 'two', status: 'unknown' },
    { name: 'three', status: 'in-progress' },
    { name: 'four', status: 'prepared' },
  ];
  assert.deepEqual(focusMember({ next: 'four', members }), { name: 'two', reason: 'evidence' });
  assert.deepEqual(focusMember({ next: 'four', members: [{ name: 'three', status: 'in-progress' }, { name: 'four', status: 'prepared' }] }), { name: 'four', reason: 'next' });
  assert.deepEqual(focusMember({ next: 'absent', members: [{ name: 'three', status: 'in-progress' }, { name: 'one', status: 'published' }] }), { name: 'three', reason: 'in-progress' });
  assert.deepEqual(focusMember({ next: null, members: [{ name: 'four', status: 'prepared' }, { name: 'one', status: 'published' }] }), { name: 'one', reason: 'published' });
  assert.deepEqual(focusMember({ next: null, members: [{ name: 'two', status: 'unknown' }, { name: 'five', status: 'in-progress', attention: true }] }), { name: 'five', reason: 'attention' });
  assert.deepEqual(focusMember({ members: [{ name: 'four', status: 'prepared' }] }), null);
});

test('member records match workspace and package slug while preserving input order', () => {
  const records = [
    { key: 'w-first', workspace: 'w', package: '/store/projects/w/specs/b' },
    { key: 'x', workspace: 'x', package: '/store/projects/x/specs/b' },
    { key: 'w-second', workspace: 'w', package: '/store/projects/w/specs/b', is_current_assignment: true },
    { key: 'other', workspace: 'w', package: '/store/projects/w/specs/c' },
  ];
  assert.deepEqual(memberRecords(records, 'w', 'b').map(record => record.key), ['w-first', 'w-second']);
  assert.deepEqual(memberRecords(records, 'x', 'b').map(record => record.key), ['x']);
  assert.deepEqual(memberRecords(records, 'w', 'missing'), []);
});

test('freshness follows observation time and imported or file reads avoid live notices', () => {
  setClock('2026-01-02T03:04:00.000Z');
  try {
    const recent = '2026-01-02T03:03:59.000Z';
    const fresh: WireRecord = {
      observer: { state: 'observing', published_at: recent, snapshot: { coverage: { observed_at: recent } } },
      coverage: { state: 'complete' },
      members: [],
    };
    const old = { ...fresh, observer: { ...fresh.observer, snapshot: { coverage: { observed_at: '2026-01-01T00:00:00.000Z' } } } };
    const missing = { ...fresh, observer: { state: 'observing', snapshot: { coverage: {} } } };
    const idle = { ...fresh, observer: { state: 'idle', snapshot: { coverage: { observed_at: recent } } } };
    const viewBase = { payload: { observers: [] }, live: true, connectionFailed: false, imported: false, epicSupport: null, scoped: [fresh], visible: [fresh] };

    const healthy = epicViewState({ ...viewBase, selected: fresh });
    assert.equal(healthy.stale, false);
    assert.equal(healthy.observedAt, recent);
    assert.equal(epicViewState({ ...viewBase, selected: old }).stale, true);
    assert.equal(epicViewState({ ...viewBase, selected: missing }).stale, true);
    assert.equal(epicViewState({ ...viewBase, selected: idle }).stale, true);

    const transport = epicViewState({ ...viewBase, selected: old, connectionFailed: true });
    assert.equal(transport.offline, true);
    assert.equal(transport.stale, false);
    const imported = epicViewState({ ...viewBase, selected: old, connectionFailed: true, imported: true });
    assert.equal(imported.offline, false);
    assert.equal(imported.stale, false);

    const coldFile = epicViewState({ payload: null, live: false, connectionFailed: true, imported: true, epicSupport: null, scoped: [], visible: [], selected: null });
    assert.equal(coldFile.read, 'ready');
    assert.equal(coldFile.empty, 'no-snapshot');
    assert.equal(coldFile.offline, false);
    assert.equal(coldFile.stale, false);
    assert.equal(epicViewState({ payload: null, live: true, connectionFailed: true, imported: false, epicSupport: null, scoped: [], visible: [], selected: null }).read, 'error');
    assert.equal(epicViewState({ payload: null, live: true, connectionFailed: false, imported: false, epicSupport: null, scoped: [], visible: [], selected: null }).read, 'loading');

    const partial = epicViewState({ ...viewBase, selected: { ...old, coverage: { state: 'partial' }, members: [{ name: 'b', status: 'unknown' }] } });
    assert.equal(partial.partial, true);
    assert.equal(partial.observedAt, '2026-01-01T00:00:00.000Z');
    const conflict = epicViewState({ ...viewBase, selected: { state: 'complete', summary: { total: 3 }, members: [{ name: 'a', status: 'published' }], coverage: { state: 'complete' } } });
    assert.equal(conflict.partial, true);
    assert.deepEqual(epicCoverageReasons({ coverage: { reasons: ['member-incomplete:b', 'member-unobserved:c', 'other reason'] } }), [
      'b: receipts or checkpoints could not be fully read',
      'c: workspace not observed',
      'other reason',
    ]);
  } finally {
    setClock(undefined);
  }
});

test('epic filter matches trimmed fields in input order and empty precedence holds', () => {
  const epics: WireRecord[] = [
    { key: 'one', title: 'Supervision', epic: 'adj', workspace: 'agents', members: [{ name: 'super1' }] },
    { key: 'two', title: 'Journey documentation', epic: 'trip', workspace: 'transitops', members: [] },
  ];
  assert.deepEqual(visibleEpics(epics, '  SUPERVISION ').map(epic => epic.key), ['one']);
  assert.deepEqual(visibleEpics(epics, 'adj').map(epic => epic.key), ['one']);
  assert.deepEqual(visibleEpics(epics, 'agents').map(epic => epic.key), ['one']);
  assert.deepEqual(visibleEpics(epics, 'super1').map(epic => epic.key), ['one']);
  assert.deepEqual(visibleEpics(epics, 'trip').map(epic => epic.key), ['two']);
  assert.deepEqual(visibleEpics(epics, '').map(epic => epic.key), ['one', 'two']);
  assert.deepEqual(visibleEpics(epics, 'nothing').map(epic => epic.key), []);

  const emptyBase = { payload: { observers: [] }, live: true, connectionFailed: false, imported: false, selected: null, scoped: [] as WireRecord[], visible: [] as WireRecord[] };
  assert.equal(epicViewState({ ...emptyBase, epicSupport: 'No observer snapshots' }).empty, 'no-snapshot');
  assert.equal(epicViewState({ ...emptyBase, epicSupport: 'Epic data unavailable' }).empty, 'unsupported');
  assert.equal(epicViewState({ ...emptyBase, epicSupport: null }).empty, 'no-epics');
  assert.equal(epicViewState({ ...emptyBase, epicSupport: null, scoped: [epics[0]] }).empty, 'no-matches');
  assert.equal(epicViewState({ ...emptyBase, epicSupport: null, scoped: [epics[0]], visible: [epics[0]] }).empty, 'none');
  assert.equal(epicViewState({ ...emptyBase, epicSupport: 'No observer snapshots' }).read, 'ready');
});

test('catalog and path helpers keep the kit boundary and reject escapes', () => {
  const catalog: CatalogEntry[] = [
    { id: 'alpha', directory: '/store/projects/physical', name: 'Physical kit' },
    { id: 'beta', directory: '/store/projects/other/physical' },
    { id: 'gamma', directory: '/store/projects/transitops' },
  ];
  const sole: CatalogEntry[] = [catalog[0]];
  const record = { workspace: 'physical', epic: 'newui' };
  assert.equal(catalogEntryForRecord(record, 'epic', sole)?.id, 'alpha');
  assert.equal(catalogEntryForRecord(record, 'epic', catalog), undefined);
  assert.equal(catalogEntryForRecord(record, 'epic', catalog, 'gamma'), undefined);
  assert.equal(catalogEntryForRecord(record, 'epic', catalog, 'alpha')?.id, 'alpha');
  assert.equal(catalogEntryForRecord({ workspace_id: 'beta' }, 'assignment', catalog, 'beta')?.id, 'beta');

  assert.equal(workspaceRelativePath('/store/projects/physical', '/store/projects/physical/plans/newui-epic.md'), 'plans/newui-epic.md');
  for (const bad of [
    '/store/projects/physical/../other/plan.md',
    '/store/projects/physical/./plan.md',
    '/store/projects/physical/plans\\evil.md',
    '/store/projects/physical/plans\u0000evil.md',
    '/store/projects/physical//plan.md',
    '/store/projects/other/plan.md',
    '/store/projects/physical2/plan.md',
    '/store/projects/physical',
  ]) assert.equal(workspaceRelativePath('/store/projects/physical', bad), null, bad);

  const epic = {
    workspace: 'physical',
    epic: 'newui',
    plan: '/store/projects/physical/plans/newui-epic.md',
    designs: [{ workspace: 'physical', design: 'app-ui', path: '/store/projects/physical/designs/app-ui' }],
  };
  const links = epicDocumentLinks(epic, sole, 'alpha');
  assert.deepEqual(links.plan, {
    name: 'newui-epic.md',
    source: '/store/projects/physical/plans/newui-epic.md',
    route: { dest: 'files', ws: 'alpha', source: 'workspace', path: 'plans/newui-epic.md' },
  });
  assert.deepEqual(links.designs, [{
    name: 'app-ui',
    source: '/store/projects/physical/designs/app-ui',
    route: { dest: 'designs', ws: 'alpha', id: 'app-ui' },
  }]);
  assert.equal(epicDocumentLinks({ workspace: 'physical', epic: 'newui' }, sole).plan, null);
  assert.deepEqual(epicDocumentLinks({ ...epic, designs: [] }, sole, 'alpha').designs, []);

  const outside = epicDocumentLinks({ ...epic, plan: '/store/projects/other/plan.md' }, sole, 'alpha');
  assert.ok(outside.plan);
  assert.equal(outside.plan.route, null);
  assert.equal(outside.plan.name, 'plan.md');

  const ambiguous = epicDocumentLinks(epic, catalog);
  assert.ok(ambiguous.plan);
  assert.equal(ambiguous.plan.route, null);
  assert.equal(ambiguous.designs[0].route, null);
  const preferred = epicDocumentLinks(epic, catalog, 'alpha');
  assert.deepEqual(preferred.plan?.route, { dest: 'files', ws: 'alpha', source: 'workspace', path: 'plans/newui-epic.md' });
  assert.deepEqual(preferred.designs, [{
    name: 'app-ui',
    source: '/store/projects/physical/designs/app-ui',
    route: { dest: 'designs', ws: 'alpha', id: 'app-ui' },
  }]);
  assert.equal(epicDocumentLinks(epic, catalog, 'gamma').designs[0].route, null);

  const idMatch = epicDocumentLinks(
    { ...epic, designs: [{ workspace: 'alpha', design: 'app-ui' }] },
    [{ id: 'beta', directory: '/store/projects/physical' }, { id: 'alpha', directory: '/store/projects/other/alpha' }],
  );
  assert.deepEqual(idMatch.designs[0].route, { dest: 'designs', ws: 'alpha', id: 'app-ui' });
});

test('prototype-name vocabulary stays literal with neutral tone', () => {
  for (const key of ['__proto__', 'constructor', 'toString'] as const) {
    assert.deepEqual(epicRecordedState({ state: key }), { label: key, tone: 'neutral', conflict: false });
    assert.deepEqual(epicMemberStatus({ status: key }), { label: key, tone: 'neutral' });
  }
});

test('epic planning readiness uses positive preparation instead of legacy statuses', () => {
  assert.equal(memberPlanning({ name: 'a', status: 'prepared' }), null);
  assert.equal(epicPlanningIncomplete({ members: [{ name: 'a', status: 'prepared' }] }), true);
  const positive = { name: 'a', status: 'proposed', planning: { prepared: true, decision: null, step_count: 2, preparation: { outcome: 'prepared' } } };
  assert.equal(epicPlanningIncomplete({ members: [positive] }), false);
  assert.equal(epicPlanningIncomplete({ members: [{ name: 'b', status: 'merged' }, positive] }), false);
  const facts = memberPlanning(positive);
  assert.equal(facts?.prepared, true);
  assert.equal(facts?.steps, 2);
  assert.equal(nextToPlan({ workspace: 'w', members: [positive] }), null);
  const proposed = {
    name: 'c', status: 'proposed', package: 'c', workspace: 'w', requires: [],
    planning: { prepared: false, decision: null, step_count: null, preparation: { outcome: 'missing' }, receipts: [], worktree_recorded: null },
  };
  assert.equal(nextToPlan({ workspace: 'w', members: [proposed] })?.name, 'c');
});

test('epic actions reuse readiness refusals for incomplete coverage and unavailable preparation', () => {
  const member = {
    name: 'a', workspace: 'w', package: 'a', status: 'prepared', requires: ['base'],
    planning: { prepared: true, step_count: 2, preparation: { outcome: 'prepared' }, decision: null },
  };
  const epic = { workspace: 'w', members: [{ name: 'base', status: 'merged' }, member] };
  const record = { workspace: 'w', package: '/store/specs/a' };
  for (const state of ['partial', 'unknown']) {
    const row = epicMemberPlanningRow(epic, member, [{ ...record, assignment_coverage: { state } }]);
    assert.equal(row.status.label, 'Ready to implement');
    assert.equal(row.action.kind, 'implement');
    assert.equal(row.action.disabled, true);
    assert.match(row.action.reason!, new RegExp(`Assignment coverage ${state}`));
  }
  assert.equal(epicMemberPlanningRow(epic, member, [{ ...record, assignment_coverage: { state: 'complete' } }]).action.disabled, false);
  const unavailable = { ...member, status: 'proposed', planning: {
    ...member.planning, prepared: null, preparation: { outcome: 'unavailable' },
  } };
  const row = epicMemberPlanningRow(epic, unavailable, [{ ...record, assignment_coverage: { state: 'complete' } }]);
  assert.equal(row.status.label, 'Readiness unknown');
  assert.equal(row.action.disabled, true);
  assert.match(row.action.reason!, /preparation read is unavailable/);
  assert.equal(nextToPlan({ ...epic, members: [unavailable] }), null);
});

test('epic planning accepts prepared prerequisites but refuses an unconfirmed owner', () => {
  const member = { name: 'a', workspace: 'w', package: 'a', status: 'proposed', requires: ['base'],
    planning: { prepared: false, step_count: null, preparation: { outcome: 'missing' }, decision: null } };
  const epic = { workspace: 'w', members: [
    { name: 'base', status: 'prepared', planning: { prepared: true } }, member,
  ] };
  const record = { workspace: 'w', package: '/store/specs/a' };
  const covered = epicMemberPlanningRow(epic, member, [{ ...record, assignment_coverage: { state: 'complete' } }]);
  assert.equal(covered.status.label, 'Not planned');
  assert.equal(covered.action.disabled, false);
  const partial = epicMemberPlanningRow(epic, member, [{ ...record, assignment_coverage: { state: 'partial' } }]);
  assert.equal(partial.action.disabled, true);
  assert.match(partial.action.reason!, /owner is not confirmed/);
});
