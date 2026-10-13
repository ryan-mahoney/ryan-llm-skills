// Step 11 F2 terminal coverage: mounted valid->missing navigation with held
// and rejected list responses. Drives the same synchronous guard Threads.tsx
// executes literally (normalize + shouldInvalidate synchronously before any
// await) through a minimal harness mirroring loadList's selection/history/
// event/draft/retry state. While the list is held or rejected, no
// previous-thread mutation controls or sends may survive under the new URL;
// steady refreshes with an unchanged identity preserve the selection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeRequestedThreadId,
  resolveThreadListSelection,
  shouldInvalidateThreadRouteSynchronously,
} from './threads-selection';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const MISSING = '33333333-3333-4333-8333-333333333333';

type Harness = {
  selected: string;
  draft: string;
  sendPending: { id: string; draft: string } | null;
  historyOpenedFor: string | null;
  eventsOpenedFor: string | null;
  requestedMissing: boolean;
  appliedRequested: string;
  lastSeenRequested: string;
  listError: string;
  // Mutation controls are rendered exactly when a thread is selected.
  canSend: () => boolean;
  canPrepare: () => boolean;
};

function createHarness(): Harness {
  const state: Harness = {
    selected: '',
    draft: '',
    sendPending: null,
    historyOpenedFor: null,
    eventsOpenedFor: null,
    requestedMissing: false,
    appliedRequested: '',
    lastSeenRequested: '',
    listError: '',
    canSend: () => state.selected !== '' && state.draft.trim() !== '',
    canPrepare: () => state.selected !== '',
  };
  return state;
}

function resetSelectionSync(state: Harness): void {
  state.historyOpenedFor = null;
  state.eventsOpenedFor = null;
}

function syncInvalidateIfRouteChanged(state: Harness, requestedRaw: unknown): boolean {
  const requested = normalizeRequestedThreadId(requestedRaw);
  if (!shouldInvalidateThreadRouteSynchronously(requested, state.lastSeenRequested)) return false;
  state.lastSeenRequested = requested;
  state.selected = '';
  state.draft = '';
  state.sendPending = null;
  resetSelectionSync(state);
  state.requestedMissing = false;
  return true;
}

// Mirrors Threads.tsx loadList: synchronous invalidation first, then await,
// then the pure post-response contract. fetchList is the controllable
// /api/threads response (held or rejected in these cases).
async function loadList(state: Harness, requestedRaw: unknown, fetchList: () => Promise<Array<{ thread_id: string }>>): Promise<void> {
  syncInvalidateIfRouteChanged(state, requestedRaw);
  try {
    const rows = await fetchList();
    const requested = normalizeRequestedThreadId(requestedRaw);
    const decision = resolveThreadListSelection({ rows, requested, appliedRequested: state.appliedRequested, selected: state.selected });
    state.appliedRequested = decision.appliedRequested;
    state.requestedMissing = decision.requestedMissing;
    if (decision.invalidated) {
      state.selected = '';
      state.draft = '';
      state.sendPending = null;
      resetSelectionSync(state);
    }
    if (decision.shouldSelect && decision.nextSelected) {
      if (state.selected !== decision.nextSelected) state.selected = decision.nextSelected;
      if (!decision.invalidated) {
        state.draft = '';
        state.sendPending = null;
        resetSelectionSync(state);
      }
      state.historyOpenedFor = decision.nextSelected;
      state.eventsOpenedFor = decision.nextSelected;
    } else if (state.selected !== decision.nextSelected) {
      state.selected = decision.nextSelected;
      if (decision.nextSelected) {
        state.draft = '';
        state.sendPending = null;
        resetSelectionSync(state);
        state.historyOpenedFor = decision.nextSelected;
        state.eventsOpenedFor = decision.nextSelected;
      }
    }
  } catch {
    state.listError = 'Threads could not be loaded.';
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('F2: held list during valid->missing navigation clears previous-thread controls synchronously', async () => {
  const state = createHarness();
  // Mounted on A with a populated draft and retry identity.
  state.selected = A;
  state.draft = 'typed work for A';
  state.sendPending = { id: 'retry-1', draft: 'typed work for A' };
  state.historyOpenedFor = A;
  state.eventsOpenedFor = A;
  state.appliedRequested = A;
  state.lastSeenRequested = A;
  assert.equal(state.canPrepare(), true);

  // Navigate A -> missing while the list is held: the synchronous guard
  // must drop everything before the await, so no Send/Prepare for A
  // survives under the missing URL even though the list has not answered.
  const held = deferred<Array<{ thread_id: string }>>();
  const pending = loadList(state, MISSING, () => held.promise);
  assert.equal(state.selected, '');
  assert.equal(state.draft, '');
  assert.equal(state.sendPending, null);
  assert.equal(state.historyOpenedFor, null);
  assert.equal(state.eventsOpenedFor, null);
  assert.equal(state.canSend(), false);
  assert.equal(state.canPrepare(), false);

  // A send attempted during the hold cannot target the previous thread.
  const attemptedSendThread = state.selected;
  assert.equal(attemptedSendThread, '');

  // The held list resolves without the missing UUID: stays empty, missing
  // feedback set, still no controls.
  held.resolve([{ thread_id: A }, { thread_id: B }]);
  await pending;
  assert.equal(state.selected, '');
  assert.equal(state.draft, '');
  assert.equal(state.requestedMissing, true);
  assert.equal(state.canSend(), false);
  assert.equal(state.canPrepare(), false);
  assert.equal(state.historyOpenedFor, null);
});

test('F2: rejected list during valid->missing navigation leaves no previous-thread controls', async () => {
  const state = createHarness();
  state.selected = A;
  state.draft = 'typed work for A';
  state.sendPending = { id: 'retry-1', draft: 'typed work for A' };
  state.historyOpenedFor = A;
  state.eventsOpenedFor = A;
  state.appliedRequested = A;
  state.lastSeenRequested = A;

  const failing = loadList(state, MISSING, () => Promise.reject(new Error('fetch failed')));
  // Synchronous invalidation already applied before the rejection.
  assert.equal(state.selected, '');
  assert.equal(state.draft, '');
  assert.equal(state.sendPending, null);
  assert.equal(state.canPrepare(), false);
  await failing;
  assert.equal(state.selected, '');
  assert.equal(state.draft, '');
  assert.equal(state.sendPending, null);
  assert.equal(state.canSend(), false);
  assert.equal(state.canPrepare(), false);
  assert.equal(state.historyOpenedFor, null);
  assert.equal(state.eventsOpenedFor, null);
  assert.equal(state.listError, 'Threads could not be loaded.');
});

test('F2: steady refresh with an unchanged identity preserves selection, draft and retry', async () => {
  const state = createHarness();
  state.selected = B;
  state.draft = 'typed work for B';
  state.sendPending = { id: 'retry-B', draft: 'typed work for B' };
  state.historyOpenedFor = B;
  state.eventsOpenedFor = B;
  state.appliedRequested = A;
  state.lastSeenRequested = A;
  const snapshotHistory = state.historyOpenedFor;
  await loadList(state, A, () => Promise.resolve([{ thread_id: A }, { thread_id: B }]));
  assert.equal(state.selected, B);
  assert.equal(state.draft, 'typed work for B');
  assert.equal(state.sendPending?.id, 'retry-B');
  assert.equal(state.historyOpenedFor, snapshotHistory);
  assert.equal(state.requestedMissing, false);
});

test('F2: synchronous guard only fires on a changed identity', () => {
  assert.equal(normalizeRequestedThreadId(undefined), '');
  assert.equal(normalizeRequestedThreadId(''), '');
  assert.equal(normalizeRequestedThreadId(A), A);
  assert.equal(shouldInvalidateThreadRouteSynchronously(A, A), false);
  assert.equal(shouldInvalidateThreadRouteSynchronously(MISSING, A), true);
  assert.equal(shouldInvalidateThreadRouteSynchronously('', ''), false);
  assert.equal(shouldInvalidateThreadRouteSynchronously(A, ''), true);
});
