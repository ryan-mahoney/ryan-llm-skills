import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { activeRun, attention, packageFilterMatches, setClock, statusMarkdown } from './format';
import { collectAssignments, collectEpics, collectRecords, normalizeEnvelope, type Envelope, type Observer } from './model';
import { completionLabel, epicMemberTone, epicStats, runState, specProgress } from './observation-format';
import { planningAssignmentFor, specReadiness } from './readiness';

const now = '2026-10-10T12:00:00.000Z';
const observer = (id: string, workspace: string, snapshot: Record<string, any>, overrides: Record<string, any> = {}):Observer => ({
  observer_id: id,
  state: 'observing',
  published_at: now,
  snapshot: { workspace, coverage: { state: 'complete', observed_at: now }, runs: [], ...snapshot },
  ...overrides,
});
const envelope = (...observers: Observer[]): Envelope => ({ generated_at: now, observers });

afterEach(() => setClock(undefined));

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='normalize accepts supported' src/model.test.ts
test('normalize accepts supported legacy envelopes and rejects malformed or oversized snapshots', () => {
  const snapshot = { runs: [{ package: '/repo/spec' }] };
  assert.equal(normalizeEnvelope(snapshot).observers[0].observer_id, 'imported');
  assert.equal(normalizeEnvelope({ observer_id: 'legacy', state: 'closed', snapshot }).observers[0].observer_id, 'legacy');
  assert.equal(normalizeEnvelope({ observer_id: 'pending', state: 'observing', snapshot: null }).observers.length, 1);
  assert.equal(normalizeEnvelope({ observers: [observer('wire', 'w', snapshot)] }).observers.length, 1);

  assert.throws(() => normalizeEnvelope(null), { message: 'Snapshot must be an object.' });
  assert.throws(() => normalizeEnvelope({ observers: Array.from({ length: 513 }, () => ({})) }), { message: 'Invalid observer envelope.' });
  assert.throws(() => normalizeEnvelope({ runs: Array.from({ length: 10_001 }, () => ({})) }), { message: 'Invalid snapshot.' });
  assert.throws(() => normalizeEnvelope({ runs: [], epics: 'adj' }), { message: 'Invalid epics.' });
  assert.throws(() => normalizeEnvelope({ runs: [{ workflow_workers: [null] }] }), { message: 'Invalid workflow workers.' });
  assert.throws(() => normalizeEnvelope({ runs: [{ epic: 'adj' }] }), { message: 'Invalid run epic.' });
  assert.throws(() => normalizeEnvelope({ runs: [{ epic: { epic: 3 } }] }), { message: 'Invalid run epic.' });
  assert.throws(() => normalizeEnvelope({ runs: [], recently_completed: [{ completed_at: now, completion_basis: 'merged-pr', epic: { epic: 3 } }] }), { message: 'Invalid run epic.' });
  assert.throws(() => normalizeEnvelope({ runs: [], epics: Array.from({ length: 51 }, (_, i) => ({ epic: `e${i}`, title: 'Epic', members: [] })) }), { message: 'Invalid epics.' });
  assert.throws(() => normalizeEnvelope({ runs: [], epics: [{ epic: 'e', title: 'Epic', members: Array.from({ length: 101 }, (_, i) => ({ name: `m${i}`, status: 'ready' })) }] }), { message: 'Invalid epics.' });
  assert.throws(() => normalizeEnvelope({ runs: [], epics: [{ epic: 'e', title: 'Epic', members: [{ name: 'm', status: 7 }] }] }), { message: 'Invalid epics.' });
  assert.throws(() => normalizeEnvelope({ runs: [{ actions: [null] }] }), { message: 'Invalid run entry.' });
  assert.throws(() => normalizeEnvelope({ runs: [], planned_packages: [{ workspace: 'w', package_ref: '/w/spec', package: 'spec', source_paths: ['src/a', 3] }] }), { message: 'Invalid planned packages.' });
  assert.throws(() => normalizeEnvelope({ runs: [], planned_packages: [{ workspace: 'w', package_ref: '/w/spec', package: 'spec', targets: [{ id: 'web', primary: true }] }] }), { message: 'Invalid planned packages.' });
  assert.throws(() => normalizeEnvelope({ runs: [], planned_packages: Array.from({ length: 10_001 }, (_, i) => ({ workspace: 'w', package_ref: `/w/${i}`, package: `p${i}` })) }), { message: 'Invalid planned packages.' });
});

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='authoritative workspace' src/model.test.ts
test('authoritative workspace snapshots prefer fresh coverage and do not accumulate superseded rows', () => {
  setClock(now);
  const old = observer('old', 'workspace', { coverage: { state: 'complete', observed_at: '2026-10-10T11:59:00Z' }, runs: [{ package: 'old-row' }] }, { published_at: '2026-10-10T10:00:00Z' });
  const fresh = observer('fresh', 'workspace', { coverage: { state: 'partial', observed_at: '2026-10-10T11:58:00Z' }, runs: [{ package: 'current-row', assignment_id: 'a' }] });
  const records = collectRecords(normalizeEnvelope(envelope(old, fresh)));
  assert.deepEqual(records.map(record => record.package), ['current-row']);
  assert.equal(records[0].observer.observer_id, 'fresh');

  const newerCoverage = observer('newer-coverage', 'workspace', {
    coverage: { state: 'complete', observed_at: '2026-10-10T11:59:30Z' }, runs: [{ package: 'newest-row' }],
  }, { published_at: '2026-10-10T11:59:00Z' });
  const earlierCoverage = observer('earlier-coverage', 'workspace', {
    coverage: { state: 'complete', observed_at: '2026-10-10T11:59:00Z' }, runs: [{ package: 'older-row' }],
  }, { published_at: '2026-10-10T11:58:00Z' });
  assert.deepEqual(collectRecords(normalizeEnvelope(envelope(earlierCoverage, newerCoverage))).map(record => record.package), ['newest-row']);
});

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='records preserve current' src/model.test.ts
test('records preserve current obligations and manual recent completion without implying acceptance', () => {
  const blocked = { workspace: 'w', package: 'blocked', is_current_assignment: true, execution: 'completed', workflow_state: 'blocked' };
  const superseded = { workspace: 'w', package: 'superseded', is_current_assignment: false, execution: 'running', workflow_state: 'working' };
  const genericGap = { workspace: 'w', package: 'gap', is_current_assignment: true, execution: 'running', coverage: { state: 'partial' } };
  const completed = { workspace: 'w', package: 'done', completed_at: now, completion_basis: 'manual' };
  const records = collectRecords(normalizeEnvelope(envelope(observer('live', 'w', {
    runs: [blocked, superseded, genericGap], recently_completed: [completed],
  }))));
  const byPackage = new Map(records.map(record => [record.package, record]));

  assert.equal(activeRun(byPackage.get('blocked')), true);
  assert.equal(attention(byPackage.get('blocked')), true);
  assert.equal(attention({ ...blocked, execution: 'running', workflow_state: 'working', conditions: [{ severity: 'attention', state: 'open', kind: 'action-outcome-unknown', current: true }] }), true);
  assert.equal(attention({ ...blocked, execution: 'running', workflow_state: 'working', conditions: [{ severity: 'attention', state: 'open', kind: 'action-outcome-unknown', current: false }] }), false);
  assert.equal(activeRun(byPackage.get('superseded')), false);
  assert.equal(attention(byPackage.get('gap')), false);
  assert.equal(byPackage.get('done')!.recent_completion, true);
  assert.equal(activeRun(byPackage.get('done')), false);
  assert.equal(completionLabel(byPackage.get('done')), 'Marked complete');
  assert.equal(runState(byPackage.get('done'), () => false), 'Done');
  assert.equal(runState({ ...blocked, execution: 'failed' }, () => false), 'Blocked');
  assert.equal(activeRun({ ...blocked, execution: 'failed', workflow_state: 'complete' }), false);
});

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='planned inventory records' src/model.test.ts
test('planned inventory records keep a stable package key and stay outside active filters', () => {
  const packageRecord = { workspace: 'w', package_ref: '/repo/.specs/next', package: '/repo/.specs/next', targets: [{ id: 'frontend', primary: '/repo' }, { id: 'library', primary: null }], source_paths: ['src/app.ts'], epic: { epic: 'roadmap' } };
  const records = collectRecords(normalizeEnvelope(envelope(observer('inventory', 'w', { runs: [], planned_packages: [packageRecord] }))));
  assert.equal(records.length, 1);
  assert.equal(records[0].planned, true);
  assert.equal(records[0].recent_completion, false);
  assert.equal(records[0].key, JSON.stringify(['w', packageRecord.package, 'planned-package', null]));
  assert.equal(records[0].source_paths[0], 'src/app.ts');
  assert.equal(activeRun(records[0]), false);
  assert.equal(attention(records[0]), false);
  assert.equal(packageFilterMatches(records[0], 'planned'), true);
  assert.equal(packageFilterMatches(records[0], 'active'), false);
  assert.equal(runState(records[0], () => false), 'Planned');
});

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='planned rows deduplicate' src/model.test.ts
test('planned rows deduplicate by package and yield to active or recently done sibling rows', () => {
  const historical = { workspace: 'w', package_ref: '/w/history', package: 'history', execution: 'stopped', is_current_assignment: false, observed_at: now };
  const records = collectRecords(normalizeEnvelope(envelope(observer('inventory', 'w', {
    runs: [
      historical,
      { ...historical, timing: { started_at: '2026-10-09T12:00:00Z', attempts: [] } },
      { ...historical, assignment_id: 'planned' },
      { workspace: 'w', package: 'active', assignment_id: 'current', execution: 'running', is_current_assignment: true },
      { workspace: 'w', package: 'active', assignment_id: 'history', execution: 'stopped', is_current_assignment: false },
      { workspace: 'w', package: 'done', execution: 'stopped', is_current_assignment: false },
    ],
    planned_packages: [
      { workspace: 'w', package_ref: '/w/history', package: 'history', source_paths: ['from-inventory.ts'] },
      { workspace: 'w', package_ref: '/w/active', package: 'active' },
      { workspace: 'w', package_ref: '/w/done', package: 'done' },
      { workspace: 'w', package_ref: '/w/inventory-only', package: 'inventory-only' },
    ],
    recently_completed: [{ workspace: 'w', package: 'done', completed_at: now, completion_basis: 'manual' }],
  }))));
  const planned = records.filter(record => packageFilterMatches(record, 'planned'));
  assert.deepEqual(planned.map(record => record.package).sort(), ['history', 'inventory-only']);
  assert.equal(planned.find(record => record.package === 'history')!.key, JSON.stringify(['w', 'history', 'planned-package', null]));
  assert.equal(records.find(record => record.package === 'history' && record.assignment_id === 'planned')!.key, JSON.stringify(['w', 'history', 'planned']));
  assert.equal(records.filter(record => record.package === 'history').length, 3);
  assert.equal(records.filter(record => record.package === 'done').length, 2);
  assert.equal(records.some(record => record.package === 'done' && record.recent_completion), true);
  assert.equal(records.filter(record => record.package === 'active').length, 2);
});

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='planned inventory is authoritative' src/model.test.ts
test('planned inventory is authoritative and legacy snapshots retain rows without inventing Planned records', () => {
  const completed = { workspace: 'w', package_ref: '/w/done', package: 'done', execution: 'completed', workflow_state: 'complete', is_current_assignment: false };
  const authoritative = collectRecords(normalizeEnvelope(envelope(observer('current', 'w', { runs: [completed], planned_packages: [] }))));
  assert.equal(authoritative.some(record => record.planned), false);

  const oldSnapshot = normalizeEnvelope({ workspace: 'w', runs: [
    { workspace: 'w', package_ref: '/w/legacy-planned', package: 'legacy-planned', execution: 'stopped', is_current_assignment: false },
    completed,
  ] });
  const legacy = collectRecords(oldSnapshot);
  assert.equal(legacy.some(record => record.planned), false);
  assert.deepEqual(legacy.map(record => record.package).sort(), ['done', 'legacy-planned']);
  assert.equal(legacy.find(record => record.package === 'done')!.planned, undefined);
});

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='planned inventory excludes sibling records across snapshots' src/model.test.ts
test('planned inventory excludes active and done siblings across authoritative snapshots', () => {
  const inventory = observer('inventory', 'inventory-root', { planned_packages: [
    { workspace: 'w', package_ref: '/w/active', package: 'active' },
    { workspace: 'w', package_ref: '/w/done', package: 'done' },
    { workspace: 'w', package_ref: '/w/clear', package: 'clear' },
  ] });
  const executions = observer('executions', 'execution-root', {
    runs: [{ workspace: 'w', package: 'active', assignment_id: 'current', execution: 'running', is_current_assignment: true }],
    recently_completed: [{ workspace: 'w', package: 'done', completed_at: now, completion_basis: 'manual' }],
  });
  const records = collectRecords(normalizeEnvelope(envelope(inventory, executions)));
  assert.deepEqual(records.filter(record => record.planned).map(record => record.package), ['clear']);
  assert.equal(records.some(record => record.package === 'active' && record.is_current_assignment === true), true);
  assert.equal(records.some(record => record.package === 'done' && record.recent_completion === true), true);
});

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='agent assignments deduplicate' src/model.test.ts
test('agent assignments deduplicate within workspace and epics retain their member summary', () => {
  const alpha = observer('alpha-observer', 'alpha', {
    assignments: [
      { assignment_id: 'same', spec_package: '/alpha/spec', display: 'live', brief: 'older' },
      { assignment_id: 'same', spec_package: '/alpha/spec', display: 'live', brief: 'newer' },
    ],
    epics: [{ workspace: 'alpha', epic: 'roadmap', title: 'Roadmap', members: [
      { name: 'base', status: 'merged' }, { name: 'ui', status: 'in-progress', attention: true },
    ] }],
  });
  const beta = observer('beta-observer', 'beta', {
    assignments: [{ assignment_id: 'same', spec_package: '/beta/spec', display: 'ended' }],
    epics: [{ workspace: 'beta', epic: 'roadmap', title: 'Other roadmap', members: [{ name: 'docs', status: 'complete' }] }],
  });
  const normalized = normalizeEnvelope(envelope(alpha, beta));
  const assignments = collectAssignments(normalized);
  assert.deepEqual(assignments.map(item => [item.workspace, item.assignment_id]), [['alpha', 'same'], ['beta', 'same']]);

  const epics = collectEpics(normalized);
  assert.equal(epics.length, 2);
  const roadmap = epics.find(item => item.workspace === 'alpha')!;
  assert.deepEqual(epicStats(roadmap), { total: 2, landed: 1, attention: 1 });
  assert.equal(epicMemberTone(roadmap.members[0]), 'good');
  assert.equal(epicMemberTone(roadmap.members[1]), 'warn');
});

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='agent assignments preserve recorded workspace identity' src/model.test.ts
test('agent assignments preserve recorded workspace identity', () => {
  const hash = '1590cafe00000000000000000000000000000000000000000000000000000000';
  const hashObserver = observer('hash-observer', hash, {
    assignments: [
      { assignment_id: 'same', workspace_id: 'alpha', spec_package: '/store/alpha/specs/browser', display: 'live', skill: 'spec-architect-initial' },
      { assignment_id: 'same', workspace_id: 'beta', spec_package: '/store/beta/specs/browser', display: 'live', skill: 'spec-architect-initial' },
      { assignment_id: 'fallback', spec_package: '/store/alpha/specs/other', display: 'live', skill: 'spec-architect-initial' },
    ],
  });
  const assignments = collectAssignments(normalizeEnvelope(envelope(hashObserver)));

  // One UUID recorded under two workspaces inside one hash-keyed observer stays
  // two distinct rows carrying the recorded workspace, not the collector hash.
  assert.deepEqual(assignments.map(item => [item.workspace, item.assignment_id]).sort(), [
    [hash, 'fallback'], ['alpha', 'same'], ['beta', 'same'],
  ]);
  assert.deepEqual(assignments.map(item => item.key).sort(), [
    JSON.stringify([hash, 'fallback']), JSON.stringify(['alpha', 'same']), JSON.stringify(['beta', 'same']),
  ]);

  // The planned canonical alpha package resolves its planning owner, and the
  // same UUID under beta resolves the beta owner rather than a cross-match.
  const planned = { workspace: 'alpha', package: '/store/alpha/specs/browser', package_ref: 'alpha/browser', prepared: false, step_count: 0, preparation: { outcome: 'missing' }, decision: null, receipts: [] };
  const owner = planningAssignmentFor(planned, assignments);
  assert.ok(owner);
  assert.equal(owner!.workspace, 'alpha');
  assert.equal(owner!.assignment_id, 'same');
  assert.equal(planningAssignmentFor({ ...planned, workspace: 'beta', package: '/store/beta/specs/browser', package_ref: 'beta/browser' }, assignments)!.workspace, 'beta');

  // A row without an explicit workspace still falls back to the observer workspace.
  const fallback = assignments.find(item => item.assignment_id === 'fallback')!;
  assert.equal(fallback.workspace, hash);
});

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='sparse progress' src/model.test.ts
test('sparse progress reports unknown position and never treats a prepared step as acceptance', () => {
  assert.deepEqual(specProgress({}), { total: null, position: null, label: 'Spec size unknown', name: null });
  assert.deepEqual(specProgress({ spec_progress: { total_steps: 5 } }), { total: 5, position: null, label: 'Current step unknown · 5 steps', name: null });
  assert.deepEqual(specProgress({ spec_progress: { total_steps: 2, current_position: 3, current_name: 'Imagined' } }), { total: 2, position: null, label: 'Current step unknown · 2 steps', name: null });
  assert.deepEqual(specProgress({ spec_progress: { total_steps: 2, current_position: 2, current_name: 'Review' } }), { total: 2, position: 2, label: 'Step 2 of 2', name: 'Review' });
});

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='status markdown escapes raw HTML' src/model.test.ts
test('status markdown escapes raw HTML, rejects javascript links and keeps HTTP links', () => {
  const html = statusMarkdown('<img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert(1)) [safe](https://example.com/path)');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img\b/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /<a href="https:\/\/example\.com\/path"/);
});

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='starting assignment' src/model.test.ts
test('collectRecords projects a live starting assignment without receipts and a real receipt replaces it', () => {
  const planned = {
    workspace: 'w', package_ref: 'w/browser', package: '/store/w/specs/browser', planned_at: now,
    step_count: 7, prepared: true,
    preparation: { outcome: 'prepared', reported_at: now, source: '/store/w/specs/browser/spec-prepare.md', read: 'ok', bytes: 10 },
    decision: null, receipts: [], worktree_recorded: null,
    targets: [{ id: 'main', primary: '/store/w' }], source_paths: ['spec.md'],
  };
  const start = { assignment_id: 'start-1', workspace: 'w', spec_package: '/store/w/specs/browser', display: 'live', skill: 'spec-end-to-end' };
  const inventory = (snapshot: Record<string, any> = {}) => observer('inventory', 'w', { planned_packages: [planned], assignments: [start], assignment_coverage: { state: 'complete' }, ...snapshot });

  const projected = collectRecords(normalizeEnvelope(envelope(inventory())));
  assert.equal(projected.length, 1);
  assert.equal(projected[0].implementation_starting, true);
  assert.equal(projected[0].planned, undefined);
  assert.equal(projected[0].assignment_id, 'start-1');
  assert.equal(projected[0].key, JSON.stringify(['w', '/store/w/specs/browser', 'planned-package', null]));
  assert.equal(projected[0].source_paths[0], 'spec.md');
  assert.equal(packageFilterMatches(projected[0], 'active'), true);
  assert.equal(packageFilterMatches(projected[0], 'ready'), false);
  assert.equal(packageFilterMatches(projected[0], 'planned'), false);
  assert.equal(packageFilterMatches(projected[0], 'attention'), false);
  assert.deepEqual(projected.filter(record => packageFilterMatches(record, 'ready')), []);
  assert.equal(specReadiness(projected[0]).state, 'starting');

  const planning = collectRecords(normalizeEnvelope(envelope(inventory({ assignments: [{ ...start, assignment_id: 'plan-1', skill: 'spec-architect-initial' }] }))));
  assert.equal(planning.length, 1);
  assert.equal(planning[0].planned, true);
  assert.equal(planning[0].implementation_starting, undefined);
  assert.equal(packageFilterMatches(planning[0], 'ready'), true);
  assert.equal(packageFilterMatches(planning[0], 'active'), false);
  assert.equal(specReadiness(planning[0], { assignments: planning[0].observer.snapshot.assignments }).state, 'planning');

  const receipt = { workspace: 'w', package: '/store/w/specs/browser', assignment_id: 'start-1', execution: 'running', is_current_assignment: true };
  const withReceipt = collectRecords(normalizeEnvelope(envelope(inventory({ runs: [receipt] }))));
  assert.equal(withReceipt.filter(record => record.package === '/store/w/specs/browser').length, 1);
  assert.equal(withReceipt[0].implementation_starting, undefined);
  assert.equal(withReceipt[0].assignment_id, 'start-1');
  assert.equal(packageFilterMatches(withReceipt[0], 'active'), true);
});

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='cancelled history' src/model.test.ts
test('cancelled-only history does not suppress a new live starting projection and a real receipt still replaces it', () => {
  const path = '/store/w/specs/browser';
  const planned = {
    workspace: 'w', package_ref: 'w/browser', package: path, planned_at: now,
    prepared: true, step_count: 3,
    preparation: { outcome: 'prepared', reported_at: now, source: `${path}/spec-prepare.md`, read: 'ok', bytes: 10 },
    decision: null, receipts: [{ id: 'old-1', state: 'cancelled' }],
    targets: [{ id: 'main', primary: '/store/w' }], source_paths: ['spec.md'],
  };
  const historical = { workspace: 'w', package: path, package_ref: 'w/browser', assignment_id: 'old-1', execution: 'cancelled', is_current_assignment: false, observed_at: now };
  const start = { assignment_id: 'new-1', workspace: 'w', spec_package: path, display: 'live', skill: 'spec-end-to-end' };
  const inventory = (snapshot: Record<string, any> = {}) => observer('inventory', 'w', {
    planned_packages: [planned], assignments: [start], assignment_coverage: { state: 'complete' }, runs: [historical], ...snapshot,
  });

  const projected = collectRecords(normalizeEnvelope(envelope(inventory())));
  const rows = projected.filter(record => record.package === path);
  const projection = rows.find(record => record.implementation_starting === true);
  assert.ok(projection);
  assert.equal(projection!.planned, undefined);
  assert.equal(projection!.assignment_id, 'new-1');
  assert.equal(projection!.key, JSON.stringify(['w', path, 'planned-package', null]));
  assert.deepEqual(projection!.receipts, [{ id: 'old-1', state: 'cancelled' }]);
  assert.equal(rows.some(record => record.assignment_id === 'old-1'), true, 'the cancelled history row is kept');
  assert.equal(rows.some(record => record.planned === true), false);
  assert.equal(packageFilterMatches(projection!, 'active'), true);
  assert.equal(packageFilterMatches(projection!, 'ready'), false);
  assert.deepEqual(projected.filter(record => packageFilterMatches(record, 'ready')), []);

  const receipt = { workspace: 'w', package: path, package_ref: 'w/browser', assignment_id: 'new-1', execution: 'running', is_current_assignment: true, observed_at: now };
  const withReceipt = collectRecords(normalizeEnvelope(envelope(inventory({ runs: [historical, receipt] }))));
  assert.equal(withReceipt.some(record => record.implementation_starting === true), false);
  assert.equal(withReceipt.some(record => record.assignment_id === 'old-1'), true);
  const authoritative = withReceipt.find(record => record.assignment_id === 'new-1');
  assert.ok(authoritative);
  assert.equal(authoritative!.implementation_starting, undefined);
  assert.equal(authoritative!.planned, undefined);
  assert.equal(packageFilterMatches(authoritative!, 'active'), true);
  assert.deepEqual(withReceipt.filter(record => packageFilterMatches(record, 'ready')), []);
});

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='cancelled history' src/model.test.ts
test('cancelled history is assignment-aware: the current flag never hides a superseded cancellation and the owning receipt stays authoritative', () => {
  const path = '/store/w/specs/browser';
  const planned = {
    workspace: 'w', package_ref: 'w/browser', package: path, planned_at: now,
    prepared: true, step_count: 3,
    preparation: { outcome: 'prepared', reported_at: now, source: `${path}/spec-prepare.md`, read: 'ok', bytes: 10 },
    decision: null, receipts: [{ id: 'old-1', state: 'cancelled' }],
    targets: [{ id: 'main', primary: '/store/w' }], source_paths: ['spec.md'],
  };
  const start = { assignment_id: 'new-1', workspace: 'w', spec_package: path, display: 'live', skill: 'spec-end-to-end' };
  const inventory = (snapshot: Record<string, any> = {}) => observer('inventory', 'w', {
    planned_packages: [planned], assignments: [start], assignment_coverage: { state: 'complete' }, ...snapshot,
  });

  // Sentinel marks the newest receipt as the current assignment even when it
  // was cancelled: both flag values must stay history for the prior owner and
  // must not suppress the new blocking assignment's projection.
  for (const current of [false, true]) {
    const superseded = { workspace: 'w', package: path, package_ref: 'w/browser', assignment_id: 'old-1', execution: 'cancelled', is_current_assignment: current, observed_at: now };
    const projected = collectRecords(normalizeEnvelope(envelope(inventory({ runs: [superseded] }))));
    const rows = projected.filter(record => record.package === path);
    const projection = rows.find(record => record.implementation_starting === true);
    assert.ok(projection, `cancelled history with is_current_assignment=${current} must not suppress the new projection`);
    assert.equal(projection!.assignment_id, 'new-1');
    assert.equal(projection!.key, JSON.stringify(['w', path, 'planned-package', null]));
    assert.equal(rows.some(record => record.assignment_id === 'old-1'), true, 'the cancelled history row is kept');
    assert.equal(rows.some(record => record.planned === true), false);
    assert.equal(packageFilterMatches(projection!, 'active'), true);
    assert.deepEqual(projected.filter(record => packageFilterMatches(record, 'ready')), []);
  }

  // A cancellation carrying the new owning assignment's own identity is not
  // history: the receipt row stays authoritative and replaces the projection.
  const owned = { workspace: 'w', package: path, package_ref: 'w/browser', assignment_id: 'new-1', execution: 'cancelled', is_current_assignment: true, observed_at: now };
  const withOwnerCancellation = collectRecords(normalizeEnvelope(envelope(inventory({ runs: [owned] }))));
  assert.equal(withOwnerCancellation.some(record => record.implementation_starting === true), false);
  const authoritative = withOwnerCancellation.find(record => record.assignment_id === 'new-1');
  assert.ok(authoritative);
  assert.equal(authoritative!.planned, undefined);
  assert.equal(activeRun(authoritative!), false);
  assert.equal(packageFilterMatches(authoritative!, 'active'), false);
  assert.equal(packageFilterMatches(authoritative!, 'ready'), false);
});

// Run from scripts/spec-observe/frontend: node --import tsx --test --test-name-pattern='planned alias matches Ready' src/model.test.ts
test('planned alias matches Ready; absent facts offer no launch while incomplete coverage is a concern', () => {
  const legacy = { workspace: 'w', package_ref: 'w/legacy', package: '/store/w/specs/legacy' };
  const records = collectRecords(normalizeEnvelope(envelope(observer('inventory', 'w', { planned_packages: [legacy] }))));
  const record = records.find(item => item.planned);
  assert.ok(record);
  assert.equal(packageFilterMatches(record, 'ready'), true);
  assert.equal(packageFilterMatches(record, 'ready'), packageFilterMatches(record, 'planned'));
  const unknown = specReadiness(record);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.launchable, false);

  const prepared = {
    workspace: 'w', package: '/store/w/specs/prepared', package_ref: 'w/prepared', planned: true,
    step_count: 4, prepared: true, preparation: { outcome: 'prepared' }, decision: null, receipts: [],
  };
  const concern = specReadiness(prepared, { coverage: { state: 'partial' } });
  assert.equal(concern.state, 'ready');
  assert.equal(concern.launchable, true);
  assert.match(String(concern.reason), /coverage is partial/);
  assert.equal(specReadiness(prepared, { coverage: { state: 'complete' } }).reason, null);
});
