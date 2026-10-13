// Run with: node --import tsx --test src/spec-state.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from './api';
import { classifyCompletionError, linkedAssignmentKey, observationEnd, packageFromKey, packageRelative, specViewState, visibleSpecs } from './spec-state';

const at = (value: string) => Date.parse(value);

test('Active selection orders attention before healthy rows regardless of workspace', () => {
  const blocked = { workspace: 'z', package: '/repo/z', is_current_assignment: true, execution: 'running', workflow_state: 'blocked', activity: 'Waiting on review' };
  const healthy = { workspace: 'a', package: '/repo/a', is_current_assignment: true, execution: 'running', workflow_state: 'working', activity: 'Building the dashboard' };
  assert.deepEqual(visibleSpecs([healthy, blocked], 'active', '').map(r => r.workspace), ['z', 'a']);
  assert.deepEqual(visibleSpecs([healthy, blocked], 'active', 'building').map(r => r.workspace), ['a']);
  assert.deepEqual(visibleSpecs([healthy, blocked], 'attention', '').map(r => r.workspace), ['z']);
});

test('Done orders newest valid completion first and leaves missing or invalid timestamps last', () => {
  const completed = (workspace: string, completed_at?: unknown) => ({ workspace, package: `/repo/${workspace}`, recent_completion: true, completed_at });
  const rows = [completed('m'), completed('n', 'not-a-date'), completed('a', '2026-10-01T00:00:00Z'), completed('b', '2026-10-11T00:00:00Z')];
  assert.deepEqual(visibleSpecs(rows, 'completed', '').map(r => r.workspace), ['b', 'a', 'm', 'n']);
});

test('Planned stays its own partition and keeps workspace/package order', () => {
  const planned = (workspace: string, planned_at: string) => ({ workspace, package: `/repo/${workspace}`, planned: true, planned_at });
  const active = { workspace: 'x', package: '/repo/x', is_current_assignment: true, execution: 'running', workflow_state: 'working' };
  const done = { workspace: 'y', package: '/repo/y', recent_completion: true, completed_at: '2026-10-12T00:00:00Z' };
  const rows = [planned('z', '2026-10-12T00:00:00Z'), planned('a', '2026-10-01T00:00:00Z'), active, done];
  assert.deepEqual(visibleSpecs(rows, 'planned', '').map(r => r.workspace), ['a', 'z']);
  assert.deepEqual(visibleSpecs(rows, 'active', '').map(r => r.workspace), ['x']);
  assert.deepEqual(visibleSpecs(rows, 'completed', '').map(r => r.workspace), ['y']);
});

test('packageFromKey accepts both dispatch key shapes and rejects malformed keys', () => {
  assert.equal(packageFromKey(JSON.stringify(['ws', '/repo/pkg', 'assignment-1'])), '/repo/pkg');
  assert.equal(packageFromKey(JSON.stringify(['ws', '/repo/pkg', 'recent-completion'])), '/repo/pkg');
  assert.equal(packageFromKey(JSON.stringify(['ws', '/repo/pkg', 'planned-package', null])), '/repo/pkg');
  for (const key of [undefined, '', 'not json', '[]', JSON.stringify(['ws']), JSON.stringify(['ws', 3, 'a']), JSON.stringify(['ws', '/repo/pkg', 'a', null, 'extra']), JSON.stringify(['ws', '', 'a'])]) {
    assert.equal(packageFromKey(key), null, String(key));
  }
});

test('linkedAssignmentKey resolves only a matching scoped assignment', () => {
  const record = { workspace: 'ws', package: '/repo/pkg', assignment_id: 'assignment-1' };
  const assignments = [{ workspace: 'ws', assignment_id: 'assignment-1' }, { workspace: 'other', assignment_id: 'assignment-1' }];
  assert.equal(linkedAssignmentKey(record, assignments), JSON.stringify(['ws', 'assignment-1']));
  assert.equal(linkedAssignmentKey(record, [{ workspace: 'other', assignment_id: 'assignment-1' }]), null);
  assert.equal(linkedAssignmentKey(record, [{ workspace: 'ws', assignment_id: 'assignment-2' }]), null);
  assert.equal(linkedAssignmentKey({ workspace: 'ws', package: '/repo/pkg' }, assignments), null);
});

test('packageRelative strips only the canonical package boundary', () => {
  const record = { package: '/repo/pkg' };
  assert.equal(packageRelative(record, '/repo/pkg/spec.md'), 'spec.md');
  assert.equal(packageRelative(record, '/repo/pkg/nested/spec.md'), 'nested/spec.md');
  assert.equal(packageRelative(record, '/repo/pkg-old/source.md'), null);
  assert.equal(packageRelative(record, '/repo/pkg'), null);
  assert.equal(packageRelative(record, '/repo/pkg/../other/spec.md'), null);
  assert.equal(packageRelative(record, '/other/spec.md'), null);
  assert.equal(packageRelative(record, 'spec.md'), null);
});

test('read state distinguishes pending, failed and ready payloads', () => {
  const context = { live: true, connectionFailed: false, now: at('2026-10-12T12:00:00Z') };
  assert.equal(specViewState(null, null, [], context).read, 'loading');
  const failed = specViewState(null, null, [], { ...context, connectionFailed: true });
  assert.equal(failed.read, 'error');
  assert.equal(failed.offline, true);
});

test('scope coverage failures stay partial with no selected record', () => {
  const payload = { generated_at: '2026-10-12T12:00:00Z', truncated: true, errors: [{ source: 'scope-read', message: 'unreadable receipt' }], observers: [] };
  const scoped = [{ observer_id: 'observer-1', state: 'observing', published_at: '2026-10-12T12:00:00Z', snapshot: { workspace: 'fixture', runs: [], coverage: { state: 'unavailable', observed_at: '2026-10-11T12:00:00Z', reasons: ['checkout unavailable'] } } }];
  const state = specViewState(payload, null, scoped, { live: true, connectionFailed: false, now: at('2026-10-12T12:00:00Z') });
  assert.equal(state.read, 'ready');
  assert.equal(state.partial, true);
  assert.equal(state.offline, false);
  assert.equal(state.observedAt, '2026-10-11T12:00:00Z');
  assert.equal(state.stale, true);
  assert.ok(state.reasons.some(reason => reason.includes('Snapshot read budget')));
  assert.ok(state.reasons.some(reason => reason.includes('scope-read')));
  assert.ok(state.reasons.some(reason => reason.includes('fixture') && reason.includes('unavailable')));
  assert.ok(state.reasons.some(reason => reason.includes('checkout unavailable')));
});

test('fresh heartbeat and generated_at cannot freshen an old workspace observation', () => {
  const observer = { observer_id: 'observer-1', state: 'observing', published_at: '2026-10-12T12:00:00Z', snapshot: { workspace: 'fixture', coverage: { state: 'complete', observed_at: '2026-10-12T10:00:00Z' } } };
  const record = { workspace: 'fixture', package: '/repo/pkg', observer, coverage: { state: 'complete', reasons: [] } };
  const payload = { generated_at: '2026-10-12T12:00:00Z', observers: [] };
  const view = specViewState(payload, record, [], { live: true, connectionFailed: false, now: at('2026-10-12T12:00:00Z') });
  assert.equal(view.stale, true);
  assert.equal(view.observedAt, '2026-10-12T10:00:00Z');
  assert.equal(view.partial, false);
  const freshObserver = { ...observer, snapshot: { workspace: 'fixture', coverage: { state: 'complete', observed_at: '2026-10-12T11:59:30Z' } } };
  const fresh = specViewState(payload, { ...record, observer: freshObserver }, [], { live: true, connectionFailed: false, now: at('2026-10-12T12:00:00Z') });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.observedAt, '2026-10-12T11:59:30Z');
});

test('observation endpoints keep live freshness but retain fixed imported, offline and stale ends', () => {
  const observer = { observer_id: 'observer-1', state: 'observing', published_at: '2026-10-12T12:00:00Z', snapshot: { coverage: { observed_at: '2026-10-12T12:00:00Z' } } };
  const record = { workspace: 'fixture', package: '/repo/pkg', observer, timing: { observed_at: '2026-10-12T11:00:00Z' } };
  assert.equal(observationEnd(record, { live: true, connectionFailed: false, now: at('2026-10-12T12:00:10Z') }), '2026-10-12T12:00:10.000Z');
  for (const context of [
    { live: true, connectionFailed: false, now: at('2026-10-12T12:02:00Z') },
    { live: false, connectionFailed: false, now: at('2026-10-12T12:05:00Z') },
    { live: false, connectionFailed: false, now: at('2026-10-12T13:00:00Z') },
    { live: true, connectionFailed: true, now: at('2026-10-12T12:05:00Z') },
    { live: true, connectionFailed: true, now: at('2026-10-12T13:00:00Z') },
  ]) assert.equal(observationEnd(record, context), '2026-10-12T12:00:00Z');
  const noCoverage = { workspace: 'fixture', package: '/repo/pkg', observer: { ...observer, snapshot: { coverage: {} } }, timing: { observed_at: '2026-10-12T11:00:00Z' } };
  assert.equal(observationEnd(noCoverage, { live: true, connectionFailed: false, now: at('2026-10-12T12:00:00Z') }), '2026-10-12T11:00:00Z');
  assert.equal(observationEnd({ workspace: 'fixture', package: '/repo/pkg' }, { live: true, connectionFailed: false, now: at('2026-10-12T12:00:00Z') }), null);
});

test('completion errors separate confirmed refusal from transport uncertainty', () => {
  assert.deepEqual(classifyCompletionError(new HttpError(403, 'Completion requires the local dashboard token.')), { kind: 'refused', message: 'Completion requires the local dashboard token.' });
  assert.deepEqual(classifyCompletionError({ name: 'HttpError', message: 'Refused by server.' }), { kind: 'refused', message: 'Refused by server.' });
  for (const error of [new TypeError('fetch failed'), new DOMException('The operation was aborted due to timeout', 'TimeoutError'), new DOMException('The operation was aborted', 'AbortError')]) {
    assert.equal(classifyCompletionError(error).kind, 'uncertain');
    assert.equal(classifyCompletionError(error).message, error.message);
  }
  assert.equal(classifyCompletionError(undefined).kind, 'uncertain');
});
