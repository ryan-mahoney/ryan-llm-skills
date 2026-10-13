// Step 1 independent rule-permutation cases for the Conversations-domain
// pure owners. Rows are hand-built conversation facts (own ids, titles and
// queues), not production Threads fixtures, so each assertion exercises the
// exported contract rather than a mirrored DOM harness.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  composerAvailability,
  conversationsViewState,
  queueSummary,
  resolveSelection,
  threadState,
} from './conversations-state';
import type { ConversationRow, ConversationView, ReadError } from './conversations-state';

const ALPHA = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const BRAVO = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const GHOST = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';

const idleRow = (
  id: string,
  title: string,
  patch: Partial<ConversationRow> = {},
): ConversationRow => ({ thread_id: id, title, state: 'idle', ...patch });

const httpError = (status: number): ReadError => ({ status, message: `HTTP ${status}` });

const baseView = {
  live: true,
  listLoaded: true,
  rows: [idleRow(ALPHA, 'Alpha transcript')],
  listError: null,
  historyError: null,
  mutationError: false,
  streamState: 'live',
  observationStale: false,
};

test('selection: a present requested id selects exactly that row and never normalizes the route', () => {
  const rows = [idleRow(ALPHA, 'Alpha transcript'), idleRow(BRAVO, 'Bravo transcript')];
  const result = resolveSelection({ rows, requestedId: BRAVO, listLoaded: true });
  assert.equal(result.selected?.thread_id, BRAVO);
  assert.equal(result.requestedMissing, false);
  assert.equal(result.normalizeId, null);
  // The first row is never substituted for the requested one.
  assert.notEqual(result.selected?.thread_id, ALPHA);
});

test('selection: an absent requested id selects nothing, never falls back and never normalizes', () => {
  const rows = [idleRow(ALPHA, 'Alpha transcript'), idleRow(BRAVO, 'Bravo transcript')];
  for (const listLoaded of [true, false]) {
    const result = resolveSelection({ rows, requestedId: GHOST, listLoaded });
    assert.equal(result.selected, null);
    assert.equal(result.requestedMissing, true);
    assert.equal(result.normalizeId, null);
  }
});

test('selection: no requested id waits for the list before selecting anything', () => {
  const rows = [idleRow(ALPHA, 'Alpha transcript'), idleRow(BRAVO, 'Bravo transcript')];
  for (const requestedId of [undefined, ''] as const) {
    const result = resolveSelection({ rows, requestedId, listLoaded: false });
    assert.equal(result.selected, null);
    assert.equal(result.requestedMissing, false);
    assert.equal(result.normalizeId, null);
  }
});

test('selection: a loaded list with no requested id normalizes the first row', () => {
  const rows = [idleRow(BRAVO, 'Bravo transcript'), idleRow(ALPHA, 'Alpha transcript')];
  for (const requestedId of [undefined, ''] as const) {
    const result = resolveSelection({ rows, requestedId, listLoaded: true });
    assert.equal(result.selected?.thread_id, BRAVO);
    assert.equal(result.normalizeId, BRAVO);
    assert.equal(result.requestedMissing, false);
  }
});

test('selection: a loaded empty list stays unselected and does not normalize', () => {
  const result = resolveSelection({ rows: [], requestedId: '', listLoaded: true });
  assert.equal(result.selected, null);
  assert.equal(result.requestedMissing, false);
  assert.equal(result.normalizeId, null);
});

test('view state: denied priority covers unavailable imports, list 403/503 and history 403', () => {
  const permutations = [
    { ...baseView, live: false },
    { ...baseView, listError: httpError(403) },
    { ...baseView, listError: httpError(503) },
    { ...baseView, historyError: httpError(403) },
  ];
  for (const input of permutations) {
    assert.equal(conversationsViewState(input), 'denied');
  }
  // Denied outranks loading: an unloaded list with a refusal is not loading.
  assert.equal(
    conversationsViewState({ ...baseView, listLoaded: false, listError: httpError(403) }),
    'denied',
  );
  assert.equal(conversationsViewState({ ...baseView, live: false, listLoaded: false }), 'denied');
});

test('view state: loading applies only before the first list and only without errors', () => {
  assert.equal(conversationsViewState({ ...baseView, listLoaded: false }), 'loading');
  // A held read or mutation error is reported instead of endless loading.
  assert.equal(
    conversationsViewState({ ...baseView, listLoaded: false, historyError: httpError(500) }),
    'error',
  );
  assert.equal(conversationsViewState({ ...baseView, listLoaded: false, mutationError: true }), 'error');
});

test('view state: history 503 and mutation errors are recoverable errors, not denied', () => {
  assert.equal(conversationsViewState({ ...baseView, historyError: httpError(503) }), 'error');
  assert.equal(conversationsViewState({ ...baseView, mutationError: true }), 'error');
  // Error outranks an empty row set.
  assert.equal(conversationsViewState({ ...baseView, rows: [], listError: httpError(500) }), 'error');
});

test('view state: reconnecting, stopped and unavailable streams read offline', () => {
  for (const streamState of ['reconnecting', 'stopped', 'unavailable']) {
    assert.equal(conversationsViewState({ ...baseView, streamState }), 'offline');
  }
  assert.equal(conversationsViewState({ ...baseView, streamState: 'connecting' }), 'ready');
});

test('view state: stale observation outranks ready but not offline or errors', () => {
  assert.equal(conversationsViewState({ ...baseView, observationStale: true }), 'stale');
  assert.equal(
    conversationsViewState({ ...baseView, observationStale: true, streamState: 'reconnecting' }),
    'offline',
  );
  assert.equal(
    conversationsViewState({ ...baseView, observationStale: true, listError: httpError(500) }),
    'error',
  );
});

test('view state: a loaded empty list is empty even while the stream is unavailable', () => {
  assert.equal(conversationsViewState({ ...baseView, rows: [], streamState: 'unavailable' }), 'empty');
  assert.equal(conversationsViewState({ ...baseView, rows: [], streamState: 'live' }), 'empty');
});

test('view state: fully loaded, connected, fresh rows are ready', () => {
  assert.equal(conversationsViewState({ ...baseView }), 'ready');
});

test('availability: thread state derives history-only and paused flags before raw attention', () => {
  assert.equal(threadState(null), 'unknown');
  assert.equal(threadState(idleRow(ALPHA, 'Alpha')), 'idle');
  assert.equal(threadState(idleRow(ALPHA, 'Alpha', { state: 'active' })), 'active');
  assert.equal(threadState(idleRow(ALPHA, 'Alpha', { state: 'uncertain' })), 'idle');
  assert.equal(threadState(idleRow(ALPHA, 'Alpha', { history_only: true })), 'history-only');
  assert.equal(threadState(idleRow(ALPHA, 'Alpha', { queue_paused: true })), 'paused');
  // Attention text and kind are returned verbatim, including unknown kinds.
  assert.equal(threadState(idleRow(ALPHA, 'Alpha', { attention: 'waiting-on-operator' })), 'waiting-on-operator');
  assert.equal(threadState(idleRow(ALPHA, 'Alpha', { attention: { kind: 'policy-refusal' } })), 'policy-refusal');
  assert.equal(threadState(idleRow(ALPHA, 'Alpha', { attention: { kind: '' } })), 'idle');
});

test('availability: a missing thread selection disables send with a reason and no primary', () => {
  const result = composerAvailability({
    view: 'ready',
    thread: null,
    actionable: true,
    draft: 'hello',
    pending: false,
  });
  assert.equal(result.sendEnabled, false);
  assert.equal(result.primary, 'none');
  assert.ok(result.reason.length > 0);
});

test('availability: missing actionability, blank drafts and pending operations keep the state primary', () => {
  const thread = idleRow(ALPHA, 'Alpha transcript');
  const permutations = [
    { input: { view: 'ready' as const, thread, actionable: false, draft: 'hello', pending: false }, primary: 'send' },
    { input: { view: 'ready' as const, thread, actionable: true, draft: '   ', pending: false }, primary: 'send' },
    { input: { view: 'ready' as const, thread, actionable: true, draft: 'hello', pending: true }, primary: 'send' },
  ];
  for (const { input, primary } of permutations) {
    const result = composerAvailability(input);
    assert.equal(result.sendEnabled, false);
    assert.equal(result.primary, primary);
    assert.ok(result.reason.length > 0);
  }
});

test('availability: a non-ready view overrides the state primary with reconnect, refresh or none', () => {
  const thread = idleRow(ALPHA, 'Alpha transcript', { owns_response: true });
  const views: ConversationView[] = ['offline', 'error', 'stale', 'loading', 'denied', 'empty'];
  assert.deepEqual(
    views.map(view =>
      composerAvailability({ view, thread, actionable: true, draft: 'hello', pending: false }),
    ).map(result => result.primary),
    ['reconnect', 'refresh', 'refresh', 'none', 'none', 'none'],
  );
  // The override wins even over a responding thread's stop primary.
  const offline = composerAvailability({
    view: 'offline',
    thread,
    actionable: true,
    draft: 'hello',
    pending: false,
  });
  assert.equal(offline.sendEnabled, false);
  assert.ok(offline.reason.length > 0);
});

test('availability: a ready, actionable idle/active thread with text enables send', () => {
  const idle = composerAvailability({
    view: 'ready',
    thread: idleRow(ALPHA, 'Alpha transcript'),
    actionable: true,
    draft: '  hello  ',
    pending: false,
  });
  assert.equal(idle.sendEnabled, true);
  assert.equal(idle.reason, '');
  assert.equal(idle.primary, 'send');
  for (const thread of [
    idleRow(ALPHA, 'Alpha transcript', { state: 'active' }),
    idleRow(ALPHA, 'Alpha transcript', { owns_response: true }),
  ]) {
    const result = composerAvailability({ view: 'ready', thread, actionable: true, draft: 'hello', pending: false });
    assert.equal(result.sendEnabled, true);
    assert.equal(result.primary, 'stop');
  }
});

test('availability: a queued message on an idle thread keeps send enabled with Open queue primary', () => {
  const thread = idleRow(ALPHA, 'Alpha transcript', {
    queue: [
      { id: 'm1', text: 'first', state: 'queued', queue_position: 7 },
      { id: 'm2', text: 'second', state: 'delivering', queue_position: 8 },
    ],
  });
  const result = composerAvailability({ view: 'ready', thread, actionable: true, draft: 'hello', pending: false });
  assert.equal(result.primary, 'queue');
  assert.equal(result.sendEnabled, true);
});

test('availability: non-idle/active states disable send and preserve unknown attention text', () => {
  const unknown = idleRow(ALPHA, 'Alpha transcript', { attention: 'waiting-on-operator' });
  const unknownResult = composerAvailability({
    view: 'ready',
    thread: unknown,
    actionable: true,
    draft: 'hello',
    pending: false,
  });
  assert.equal(unknownResult.sendEnabled, false);
  assert.equal(unknownResult.primary, 'resume');
  assert.match(unknownResult.reason, /waiting-on-operator/);

  const uncertain = idleRow(ALPHA, 'Alpha transcript', { attention: { kind: 'uncertain' } });
  const uncertainResult = composerAvailability({
    view: 'ready',
    thread: uncertain,
    actionable: true,
    draft: 'hello',
    pending: false,
  });
  assert.equal(uncertainResult.sendEnabled, false);
  assert.equal(uncertainResult.primary, 'discard');
  assert.ok(uncertainResult.reason.length > 0);

  const paused = composerAvailability({
    view: 'ready',
    thread: idleRow(ALPHA, 'Alpha transcript', { queue_paused: true }),
    actionable: true,
    draft: 'hello',
    pending: false,
  });
  assert.equal(paused.primary, 'resume');
  assert.ok(paused.reason.length > 0);

  const stalled = composerAvailability({
    view: 'ready',
    thread: idleRow(ALPHA, 'Alpha transcript', { attention: 'stalled' }),
    actionable: true,
    draft: 'hello',
    pending: false,
  });
  assert.equal(stalled.primary, 'refresh');
  assert.ok(stalled.reason.length > 0);
});

test('availability: history-only threads expose no composer or send, only older', () => {
  const thread = idleRow(ALPHA, 'Alpha transcript', { history_only: true });
  const result = composerAvailability({
    view: 'ready',
    thread,
    actionable: true,
    draft: 'hello',
    pending: false,
  });
  assert.equal(result.sendEnabled, false);
  assert.equal(result.primary, 'older');
  assert.ok(result.reason.length > 0);
  // History-only outranks a non-ready view; there is still no composer.
  assert.equal(
    composerAvailability({ view: 'offline', thread, actionable: true, draft: 'hello', pending: false }).primary,
    'older',
  );
});

test('queue summary: the in-scope owner title is reported with server queue positions untouched', () => {
  const owner = idleRow(BRAVO, 'Build recovery owner', { owns_response: true });
  const selected = idleRow(ALPHA, 'Alpha transcript', {
    queue: [
      { id: 'm1', text: 'first', state: 'queued', queue_position: 4 },
      { id: 'm2', text: 'second', state: 'delivering', queue_position: 5 },
      { id: 'm3', text: 'third', state: 'queued', queue_position: 9 },
    ],
  });
  const summary = queueSummary([selected, owner], selected);
  assert.equal(summary.ownerTitle, 'Build recovery owner');
  assert.equal(summary.waiting, 2);
  assert.equal(summary.paused, false);
  assert.deepEqual(
    summary.items.map(item => [item.id, item.queue_position]),
    [
      ['m1', 4],
      ['m2', 5],
      ['m3', 9],
    ],
  );
});

test('queue summary: an active row falls back as owner when no row owns the response', () => {
  const fallback = idleRow(BRAVO, 'Active fallback owner', { state: 'active' });
  const selected = idleRow(ALPHA, 'Alpha transcript');
  assert.equal(queueSummary([selected, fallback], selected).ownerTitle, 'Active fallback owner');
});

test('queue summary: an absent owner reports null and an untitled owner uses the short id', () => {
  const selected = idleRow(ALPHA, 'Alpha transcript', {
    queue: [{ id: 'm1', text: 'first', state: 'queued', queue_position: 3 }],
  });
  const absent = queueSummary([selected, idleRow(BRAVO, 'Bravo transcript')], selected);
  assert.equal(absent.ownerTitle, null);
  assert.equal(absent.waiting, 1);
  const untitled = idleRow(BRAVO, 'Bravo transcript', { title: undefined, owns_response: true });
  assert.equal(queueSummary([untitled, selected], selected).ownerTitle, `Thread ${BRAVO.slice(0, 8)}`);
});

test('queue summary: paused state and the absence of a selected queue come only from the selection', () => {
  const selected = idleRow(ALPHA, 'Alpha transcript', { queue_paused: true });
  const paused = queueSummary([selected], selected);
  assert.equal(paused.paused, true);
  assert.deepEqual(paused.items, []);
  assert.equal(paused.waiting, 0);
  const noSelection = queueSummary([idleRow(BRAVO, 'Bravo transcript', { owns_response: true })], null);
  assert.deepEqual(noSelection.items, []);
  assert.equal(noSelection.waiting, 0);
  assert.equal(noSelection.paused, false);
  // The owner label still comes from the in-scope rows.
  assert.equal(noSelection.ownerTitle, 'Bravo transcript');
});
