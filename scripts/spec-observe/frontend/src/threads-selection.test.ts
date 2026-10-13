// Step 10 focused selection cases for the thread list. Each case drives the
// pure resolveThreadListSelection() contract that Threads.tsx loadList()
// executes literally: steady refreshes must retain an explicit row/create
// selection with its typed draft and send retry identity (F1), and a new
// requested identity must invalidate the previous thread before resolving so
// a missing UUID leaves no unrelated detail or controls (F2).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveThreadListSelection } from './threads-selection';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const MISSING = '33333333-3333-4333-8333-333333333333';

const rows = [{ thread_id: A }, { thread_id: B }];

test('F1: steady refresh while another thread is selected retains it without touching draft or retry identity', () => {
  // Route id=A was applied on entry; the operator then selected thread B and
  // typed a draft with a queued send retry identity.
  const decision = resolveThreadListSelection({ rows, requested: A, appliedRequested: A, selected: B });
  assert.equal(decision.nextSelected, B);
  assert.equal(decision.requestedMissing, false);
  assert.equal(decision.invalidated, false);
  assert.equal(decision.shouldSelect, false);
  assert.equal(decision.retainExplicit, true);
  assert.equal(decision.appliedRequested, A);
});

test('F1: steady refresh on the requested thread keeps the draft and retry identity for seeding', () => {
  const decision = resolveThreadListSelection({ rows, requested: A, appliedRequested: A, selected: A });
  assert.equal(decision.nextSelected, A);
  assert.equal(decision.invalidated, false);
  assert.equal(decision.shouldSelect, false);
  assert.equal(decision.retainExplicit, false);
});

test('F1: newly created thread stays selected across the follow-up list refresh', () => {
  // createThread() selected the new thread C while the route still names A;
  // the immediate loadList() refresh must not return to A.
  const C = '44444444-4444-4444-8444-444444444444';
  const withNew = [...rows, { thread_id: C }];
  const decision = resolveThreadListSelection({ rows: withNew, requested: A, appliedRequested: A, selected: C });
  assert.equal(decision.nextSelected, C);
  assert.equal(decision.invalidated, false);
  assert.equal(decision.shouldSelect, false);
  assert.equal(decision.retainExplicit, true);
});

test('F1: initial route entry selects the requested thread exactly once', () => {
  const first = resolveThreadListSelection({ rows, requested: A, appliedRequested: '', selected: '' });
  assert.equal(first.nextSelected, A);
  assert.equal(first.routeChanged, true);
  assert.equal(first.invalidated, true);
  assert.equal(first.shouldSelect, true);
  // The follow-up steady refresh on A changes nothing.
  const steady = resolveThreadListSelection({ rows, requested: A, appliedRequested: first.appliedRequested, selected: A });
  assert.equal(steady.shouldSelect, false);
  assert.equal(steady.invalidated, false);
});

test('F2: same-destination valid-to-missing change invalidates the previous thread and selects nothing', () => {
  // Conversations stays mounted; only the hash id changes from A to an
  // absent UUID. The old selection, history, event source, draft and retry
  // identity must be dropped before resolving, leaving no active detail.
  const decision = resolveThreadListSelection({ rows, requested: MISSING, appliedRequested: A, selected: A });
  assert.equal(decision.routeChanged, true);
  assert.equal(decision.invalidated, true);
  assert.equal(decision.nextSelected, '');
  assert.equal(decision.requestedMissing, true);
  assert.equal(decision.shouldSelect, false);
});

test('F2: missing identity stays empty on refresh and never falls back to an unrelated thread', () => {
  const decision = resolveThreadListSelection({ rows, requested: MISSING, appliedRequested: MISSING, selected: '' });
  assert.equal(decision.nextSelected, '');
  assert.equal(decision.requestedMissing, true);
  assert.equal(decision.shouldSelect, false);
  assert.equal(decision.invalidated, false);
});

test('F2: missing-to-valid change on the same destination selects the requested thread fresh', () => {
  const decision = resolveThreadListSelection({ rows, requested: B, appliedRequested: MISSING, selected: '' });
  assert.equal(decision.routeChanged, true);
  assert.equal(decision.invalidated, true);
  assert.equal(decision.nextSelected, B);
  assert.equal(decision.requestedMissing, false);
  assert.equal(decision.shouldSelect, true);
});

test('F2: requested thread vanishing on refresh drops the stale selection', () => {
  const decision = resolveThreadListSelection({ rows: [{ thread_id: B }], requested: A, appliedRequested: A, selected: A });
  assert.equal(decision.nextSelected, '');
  assert.equal(decision.requestedMissing, true);
  assert.equal(decision.invalidated, true);
  assert.equal(decision.shouldSelect, false);
});

test('unrequested surface keeps first-row fallback and retains explicit selection on refresh', () => {
  const entry = resolveThreadListSelection({ rows, requested: '', appliedRequested: '', selected: '' });
  assert.equal(entry.nextSelected, A);
  assert.equal(entry.shouldSelect, true);
  const steady = resolveThreadListSelection({ rows, requested: '', appliedRequested: '', selected: B });
  assert.equal(steady.nextSelected, B);
  assert.equal(steady.invalidated, false);
  assert.equal(steady.shouldSelect, false);
  assert.equal(steady.retainExplicit, true);
});
