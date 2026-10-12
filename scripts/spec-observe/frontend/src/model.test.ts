import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { activeRun, attention, setClock, statusMarkdown } from './format';
import { collectAssignments, collectEpics, collectRecords, normalizeEnvelope, type Envelope, type Observer } from './model';
import { completionLabel, epicMemberTone, epicStats, runState, specProgress } from './observation-format';

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
  assert.equal(runState(byPackage.get('done'), () => false), 'Completed');
  assert.equal(runState({ ...blocked, execution: 'failed' }, () => false), 'Blocked');
  assert.equal(activeRun({ ...blocked, execution: 'failed', workflow_state: 'complete' }), false);
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
