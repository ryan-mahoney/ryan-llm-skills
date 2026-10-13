// Step 1 independent rule-permutation cases for the Conversations-domain
// pure owners. Rows are hand-built conversation facts (own ids, titles and
// queues), not production Threads fixtures, so each assertion exercises the
// exported contract rather than a mirrored DOM harness.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acknowledgeNewThreadRequest,
  acknowledgeThreadSend,
  applyThreadPreparedText,
  beginNewThreadRequest,
  captureThreadSend,
  clearNewThreadDraft,
  clearThreadDraft,
  composerAvailability,
  consumeNewThreadDraft,
  conversationsViewState,
  failNewThreadRequest,
  getConversationReturnId,
  getNewThreadDraft,
  getNewThreadRequest,
  getThreadDraft,
  getThreadScroll,
  openNewThreadDraft,
  queueSummary,
  rememberConversationId,
  resolveSelection,
  seedNewThreadDraft,
  setNewThreadDraft,
  setThreadDraft,
  setThreadScroll,
  threadState,
} from './conversations-state';
import { consumeThreadDraft, seedThreadDraft } from './launch-state';
import type { ThreadDraftSeed } from './launch-state';
import type { ConversationRow, ConversationView, ReadError, ThreadDraft } from './conversations-state';

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

test('availability: recovery primaries outrank queued items and response ownership', () => {
  // A paused thread with a queued item keeps Resume, not Open queue.
  const pausedQueued = composerAvailability({
    view: 'ready',
    thread: idleRow(ALPHA, 'Alpha transcript', {
      queue_paused: true,
      queue: [{ id: 'm1', text: 'held', state: 'queued', queue_position: 3 }],
    }),
    actionable: true,
    draft: 'hello',
    pending: false,
  });
  assert.equal(pausedQueued.primary, 'resume');
  assert.equal(pausedQueued.sendEnabled, false);
  assert.ok(pausedQueued.reason.length > 0);

  // An uncertain head followed by a queued item keeps Discard, not Open queue.
  const uncertainQueued = composerAvailability({
    view: 'ready',
    thread: idleRow(ALPHA, 'Alpha transcript', {
      attention: 'uncertain',
      queue: [{ id: 'm1', text: 'held', state: 'queued', queue_position: 3 }],
    }),
    actionable: true,
    draft: 'hello',
    pending: false,
  });
  assert.equal(uncertainQueued.primary, 'discard');
  assert.equal(uncertainQueued.sendEnabled, false);
  assert.ok(uncertainQueued.reason.length > 0);

  // A stalled thread that still owns the response keeps Refresh, not Stop.
  // owns_response stays on the row so the surface can still offer Stop secondary.
  const stalledOwner = idleRow(ALPHA, 'Alpha transcript', {
    attention: 'stalled',
    owns_response: true,
  });
  const stalledOwned = composerAvailability({
    view: 'ready',
    thread: stalledOwner,
    actionable: true,
    draft: 'hello',
    pending: false,
  });
  assert.equal(stalledOwned.primary, 'refresh');
  assert.equal(stalledOwned.sendEnabled, false);
  assert.ok(stalledOwned.reason.length > 0);
  assert.equal(stalledOwner.owns_response, true);
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

// Step 2 retained-state cases. The step-1 permutations above stay unchanged;
// each case uses its own workspace/thread keys so the module-level maps
// cannot bleed across cases.

const seedOf = (draft: string): ThreadDraftSeed => ({
  assignmentId: 'assignment-1',
  requestId: 'request-1',
  outcome: 'launched',
  title: 'Discuss result',
  brief: 'brief body',
  executionDir: '/tmp/execution',
  draft,
});

test('draft ownership: threads and workspaces keep distinct drafts, retries, scroll and remembered ids', () => {
  const x = '/tmp/ws-draft-x';
  const y = '/tmp/ws-draft-y';
  const value: ThreadDraft = { draft: 'typed A', retry: { id: 'r-a', draft: 'typed A' } };
  setThreadDraft(x, ALPHA, value);
  setThreadDraft(y, ALPHA, { draft: 'typed Y-A', retry: null });
  setThreadDraft(x, BRAVO, { draft: 'typed B', retry: { id: 'r-b', draft: 'typed B' } });
  // Mutating the caller's object after the write does not change the store.
  value.draft = 'mutated';
  value.retry!.id = 'mutated';
  assert.deepEqual(getThreadDraft(x, ALPHA), { draft: 'typed A', retry: { id: 'r-a', draft: 'typed A' } });
  assert.deepEqual(getThreadDraft(y, ALPHA), { draft: 'typed Y-A', retry: null });
  assert.deepEqual(getThreadDraft(x, BRAVO), { draft: 'typed B', retry: { id: 'r-b', draft: 'typed B' } });
  // Reads are copies: mutating one key's value cannot discard another key.
  const read = getThreadDraft(x, ALPHA);
  read.draft = 'mutated read';
  read.retry!.draft = 'mutated retry';
  assert.deepEqual(getThreadDraft(x, ALPHA), { draft: 'typed A', retry: { id: 'r-a', draft: 'typed A' } });
  assert.deepEqual(getThreadDraft(x, BRAVO), { draft: 'typed B', retry: { id: 'r-b', draft: 'typed B' } });
  // An absent read is the empty draft without inserting an entry.
  assert.deepEqual(getThreadDraft(x, GHOST), { draft: '', retry: null });
  // Clearing one key leaves the other workspaces/threads intact.
  clearThreadDraft(x, ALPHA);
  assert.deepEqual(getThreadDraft(x, ALPHA), { draft: '', retry: null });
  assert.equal(getThreadDraft(y, ALPHA).draft, 'typed Y-A');
  assert.equal(getThreadDraft(x, BRAVO).draft, 'typed B');

  rememberConversationId(x, ALPHA);
  rememberConversationId(y, BRAVO);
  // Empty ids are ignored rather than stored as a selection.
  rememberConversationId(x, '');
  assert.equal(getConversationReturnId(x), ALPHA);
  assert.equal(getConversationReturnId(y), BRAVO);
  assert.equal(getConversationReturnId(''), undefined);
  assert.equal(getConversationReturnId('/tmp/ws-draft-unset'), undefined);
  rememberConversationId('', ALPHA);
  assert.equal(getConversationReturnId(''), undefined);

  const scroll = { scrollTop: 120, stickBottom: false };
  setThreadScroll(x, ALPHA, scroll);
  scroll.scrollTop = 999;
  assert.deepEqual(getThreadScroll(x, ALPHA), { scrollTop: 120, stickBottom: false });
  const readScroll = getThreadScroll(x, ALPHA)!;
  readScroll.scrollTop = 7;
  assert.deepEqual(getThreadScroll(x, ALPHA), { scrollTop: 120, stickBottom: false });
  assert.equal(getThreadScroll(y, ALPHA), undefined);
  assert.equal(getThreadScroll(x, BRAVO), undefined);
  setThreadScroll(x, BRAVO, { scrollTop: 4, stickBottom: true });
  assert.deepEqual(getThreadScroll(x, BRAVO), { scrollTop: 4, stickBottom: true });
  assert.deepEqual(getThreadScroll(x, ALPHA), { scrollTop: 120, stickBottom: false });
});

test('draft ownership: a late send acknowledgement clears only the exact captured text and retry', () => {
  const ws = '/tmp/ws-send-ack';
  setThreadDraft(ws, ALPHA, { draft: 'send me', retry: { id: 'r1', draft: 'send me' } });
  const captured = captureThreadSend(ws, ALPHA);
  assert.deepEqual(captured, { draft: 'send me', retry: { id: 'r1', draft: 'send me' } });
  // Newer typing (and a newer retry) survives a late acknowledgement.
  setThreadDraft(ws, ALPHA, { draft: 'send me\n\nmore', retry: { id: 'r1', draft: 'send me' } });
  assert.equal(acknowledgeThreadSend(ws, ALPHA, captured), false);
  assert.equal(getThreadDraft(ws, ALPHA).draft, 'send me\n\nmore');
  // The exact match clears the acknowledged entry.
  assert.equal(acknowledgeThreadSend(ws, ALPHA, captureThreadSend(ws, ALPHA)), true);
  assert.deepEqual(getThreadDraft(ws, ALPHA), { draft: '', retry: null });
  // A mismatched retry identity keeps the text; an absent entry has nothing to clear.
  setThreadDraft(ws, BRAVO, { draft: 'hello', retry: { id: 'r2', draft: 'hello' } });
  assert.equal(acknowledgeThreadSend(ws, BRAVO, { draft: 'hello', retry: { id: 'r9', draft: 'hello' } }), false);
  assert.deepEqual(getThreadDraft(ws, BRAVO), { draft: 'hello', retry: { id: 'r2', draft: 'hello' } });
  assert.equal(acknowledgeThreadSend(ws, GHOST, captured), false);
});

test('prepared text: one-use consume, wrong key untouched, typed plus prepared text and retry reset', () => {
  const ws = '/tmp/ws-prepared';
  seedThreadDraft(ws, ALPHA, seedOf('prepared launch text'));
  // The wrong thread consumes nothing and keeps its own text untouched.
  assert.equal(consumeThreadDraft(ws, BRAVO), undefined);
  setThreadDraft(ws, BRAVO, { draft: 'typed B', retry: { id: 'rb', draft: 'typed B' } });
  assert.deepEqual(applyThreadPreparedText(ws, ALPHA, 'prepared launch text'), {
    draft: 'prepared launch text',
    retry: null,
  });
  assert.deepEqual(getThreadDraft(ws, BRAVO), { draft: 'typed B', retry: { id: 'rb', draft: 'typed B' } });
  // The exact thread's seed is consumed once and never returns.
  assert.equal(consumeThreadDraft(ws, ALPHA)?.draft, 'prepared launch text');
  assert.equal(consumeThreadDraft(ws, ALPHA), undefined);
  // Typed text is preserved and the prepared text follows after a blank line;
  // the retry identity resets because the outgoing text changed.
  const appended = applyThreadPreparedText(ws, BRAVO, 'prepared B');
  assert.deepEqual(appended, { draft: 'typed B\n\nprepared B', retry: null });
  assert.deepEqual(applyThreadPreparedText(ws, GHOST, 'only prepared'), { draft: 'only prepared', retry: null });
});

test('prepared text: a cleared draft never replays a consumed launch seed', () => {
  const ws = '/tmp/ws-prepared-replay';
  seedThreadDraft(ws, ALPHA, seedOf('replay me'));
  const consumed = consumeThreadDraft(ws, ALPHA);
  assert.equal(consumed?.draft, 'replay me');
  applyThreadPreparedText(ws, ALPHA, consumed!.draft);
  assert.equal(getThreadDraft(ws, ALPHA).draft, 'replay me');
  clearThreadDraft(ws, ALPHA);
  assert.deepEqual(getThreadDraft(ws, ALPHA), { draft: '', retry: null });
  assert.equal(consumeThreadDraft(ws, ALPHA), undefined);
});

test('new thread draft: opening consumes one seed, appends to typed text and survives close/reopen', () => {
  const ws = '/tmp/ws-new-open';
  assert.deepEqual(getNewThreadDraft(ws), { text: '', target: null });
  seedNewThreadDraft(ws, { text: 'prepared', target: 'repo-9' });
  assert.deepEqual(openNewThreadDraft(ws), { text: 'prepared', target: 'repo-9' });
  assert.equal(consumeNewThreadDraft(ws), undefined);
  // Close/reopen: the consumed seed cannot replay, only the retained draft remains.
  assert.deepEqual(openNewThreadDraft(ws), { text: 'prepared', target: 'repo-9' });
  assert.deepEqual(getNewThreadDraft(ws), { text: 'prepared', target: 'repo-9' });
  // The latest seed wins and appends after a blank line; a seed with an
  // omitted target selects Whole workspace instead of inheriting the
  // retained repository choice.
  seedNewThreadDraft(ws, { text: 'one' });
  seedNewThreadDraft(ws, { text: 'two' });
  assert.deepEqual(openNewThreadDraft(ws), { text: 'prepared\n\ntwo', target: null });
  // An empty seed target likewise selects Whole workspace.
  setNewThreadDraft(ws, { text: 'typed', target: 'repo-9' });
  seedNewThreadDraft(ws, { text: 'prepared', target: '' });
  assert.deepEqual(openNewThreadDraft(ws), { text: 'typed\n\nprepared', target: null });
  // A seed with a repository target replaces the retained choice.
  seedNewThreadDraft(ws, { text: 'explicit', target: 'repo-3' });
  assert.deepEqual(openNewThreadDraft(ws), { text: 'typed\n\nprepared\n\nexplicit', target: 'repo-3' });
  // Seeds, writes and reads are copies.
  const seed = { text: 'copied', target: 'repo-4' };
  seedNewThreadDraft(ws, seed);
  seed.text = 'mutated';
  seed.target = 'mutated';
  const opened = openNewThreadDraft(ws);
  assert.deepEqual(opened, { text: 'typed\n\nprepared\n\nexplicit\n\ncopied', target: 'repo-4' });
  opened.text = 'mutated read';
  assert.deepEqual(getNewThreadDraft(ws), { text: 'typed\n\nprepared\n\nexplicit\n\ncopied', target: 'repo-4' });
  // Conditional clear leaves a nonmatching retained draft in place, then an
  // exact match clears it.
  clearNewThreadDraft(ws, { text: 'other', target: null });
  assert.equal(getNewThreadDraft(ws).text, 'typed\n\nprepared\n\nexplicit\n\ncopied');
  clearNewThreadDraft(ws, { text: 'typed\n\nprepared\n\nexplicit\n\ncopied', target: 'repo-4' });
  assert.deepEqual(getNewThreadDraft(ws), { text: '', target: null });
  const retained = { text: 'set me', target: 'repo-3' };
  setNewThreadDraft(ws, retained);
  retained.text = 'mutated';
  assert.deepEqual(getNewThreadDraft(ws), { text: 'set me', target: 'repo-3' });
});

test('new thread draft: acknowledgement copies captured text and clears only its exact entry', () => {
  const ws = '/tmp/ws-new-ack';
  const createdWs = '/tmp/ws-created-ack';
  setNewThreadDraft(ws, { text: 'captured text', target: 'repo-1' });
  beginNewThreadRequest(ws, 'captured text', 'repo-1', () => Promise.resolve('created'));
  const captured = getNewThreadRequest(ws)!;
  assert.equal(acknowledgeNewThreadRequest(ws, captured, createdWs, ALPHA), true);
  assert.deepEqual(getNewThreadDraft(ws), { text: '', target: null });
  assert.equal(getNewThreadRequest(ws), undefined);
  // The created thread's draft receives the text unsent even though the
  // dialog/request is gone.
  assert.deepEqual(getThreadDraft(createdWs, ALPHA), { draft: 'captured text', retry: null });
  // Observing the same completion again settles nothing: it reports not
  // owned and never transfers the text a second time.
  assert.equal(acknowledgeNewThreadRequest(ws, captured, createdWs, ALPHA), false);
  assert.deepEqual(getThreadDraft(createdWs, ALPHA), { draft: 'captured text', retry: null });
  // A settled capture cannot own a newer request, and transfers nothing
  // further to its own created thread.
  setNewThreadDraft(ws, { text: 'newer text', target: 'repo-2' });
  beginNewThreadRequest(ws, 'newer text', 'repo-2', () => Promise.resolve('created-2'));
  assert.equal(acknowledgeNewThreadRequest(ws, captured, createdWs, BRAVO), false);
  assert.deepEqual(getNewThreadDraft(ws), { text: 'newer text', target: 'repo-2' });
  assert.equal(getNewThreadRequest(ws)?.text, 'newer text');
  assert.deepEqual(getThreadDraft(createdWs, BRAVO), { draft: '', retry: null });
});

test('new thread draft: a settled capture cannot own a same-content replacement request', () => {
  const ws = '/tmp/ws-new-same-content';
  const createdWs = '/tmp/ws-created-same-content';
  setNewThreadDraft(ws, { text: 'same', target: 'repo-1' });
  beginNewThreadRequest(ws, 'same', 'repo-1', () => Promise.resolve('first'));
  const first = getNewThreadRequest(ws)!;
  assert.equal(acknowledgeNewThreadRequest(ws, first, createdWs, ALPHA), true);
  // A replacement request with identical text and target mints a fresh identity.
  setNewThreadDraft(ws, { text: 'same', target: 'repo-1' });
  beginNewThreadRequest(ws, 'same', 'repo-1', () => Promise.resolve('second'));
  const second = getNewThreadRequest(ws)!;
  assert.notEqual(second.id, first.id);
  // Settling the predecessor again owns nothing and preserves the live
  // request and retained draft.
  assert.equal(acknowledgeNewThreadRequest(ws, first, createdWs, ALPHA), false);
  assert.equal(getNewThreadRequest(ws)?.id, second.id);
  assert.deepEqual(getNewThreadDraft(ws), { text: 'same', target: 'repo-1' });
  assert.equal(acknowledgeNewThreadRequest(ws, second, createdWs, BRAVO), true);
  assert.deepEqual(getThreadDraft(createdWs, BRAVO), { draft: 'same', retry: null });
});

test('new thread draft: a replaced draft still receives its first late transfer', () => {
  const ws = '/tmp/ws-new-late';
  const createdWs = '/tmp/ws-created-late';
  seedNewThreadDraft(ws, { text: 'original', target: 'repo-1' });
  const opened = openNewThreadDraft(ws);
  beginNewThreadRequest(ws, opened.text, opened.target, () => Promise.resolve('created'));
  const capture = getNewThreadRequest(ws)!;
  // The retained draft moves on while the request is in flight.
  seedNewThreadDraft(ws, { text: 'newer', target: 'repo-2' });
  assert.deepEqual(openNewThreadDraft(ws), { text: 'original\n\nnewer', target: 'repo-2' });
  // The late acknowledgement still owns its request and transfers its own
  // text once, while the replaced draft survives.
  assert.equal(acknowledgeNewThreadRequest(ws, capture, createdWs, ALPHA), true);
  assert.deepEqual(getThreadDraft(createdWs, ALPHA), { draft: 'original', retry: null });
  assert.deepEqual(getNewThreadDraft(ws), { text: 'original\n\nnewer', target: 'repo-2' });
  assert.equal(getNewThreadRequest(ws), undefined);
});

test('new thread draft: a later seed survives an earlier acknowledgement', () => {
  const ws = '/tmp/ws-new-seed-ack';
  const createdWs = '/tmp/ws-created-seed-ack';
  seedNewThreadDraft(ws, { text: 'first' });
  const opened = openNewThreadDraft(ws);
  assert.deepEqual(opened, { text: 'first', target: null });
  beginNewThreadRequest(ws, opened.text, opened.target, () => Promise.resolve('created'));
  const first = getNewThreadRequest(ws)!;
  // A later seed is still consumable after the earlier acknowledgement.
  seedNewThreadDraft(ws, { text: 'second' });
  assert.equal(acknowledgeNewThreadRequest(ws, first, createdWs, ALPHA), true);
  assert.deepEqual(getThreadDraft(createdWs, ALPHA), { draft: 'first', retry: null });
  assert.equal(getNewThreadRequest(ws), undefined);
  assert.deepEqual(openNewThreadDraft(ws), { text: 'second', target: null });
  // Once the newer draft is retained, an earlier capture cannot clear it or
  // the newer pending entry.
  seedNewThreadDraft(ws, { text: 'third' });
  const merged = openNewThreadDraft(ws);
  assert.deepEqual(merged, { text: 'second\n\nthird', target: null });
  beginNewThreadRequest(ws, merged.text, merged.target, () => Promise.resolve('created-3'));
  assert.equal(acknowledgeNewThreadRequest(ws, first, createdWs, BRAVO), false);
  assert.deepEqual(getThreadDraft(createdWs, BRAVO), { draft: '', retry: null });
  assert.deepEqual(getNewThreadDraft(ws), { text: 'second\n\nthird', target: null });
  assert.equal(getNewThreadRequest(ws)?.text, 'second\n\nthird');
});

test('new thread draft: a failed creation retains text and target until an explicit retry', () => {
  const ws = '/tmp/ws-new-fail';
  setNewThreadDraft(ws, { text: 'keep me', target: 'repo-7' });
  const first = beginNewThreadRequest(ws, 'keep me', 'repo-7', () => Promise.resolve('created'));
  const capture = getNewThreadRequest(ws)!;
  failNewThreadRequest(ws, capture, 'create failed');
  const failed = getNewThreadRequest(ws);
  assert.equal(failed?.status, 'error');
  assert.equal(failed?.error, 'create failed');
  assert.equal(failed?.text, 'keep me');
  assert.equal(failed?.target, 'repo-7');
  assert.deepEqual(getNewThreadDraft(ws), { text: 'keep me', target: 'repo-7' });
  // A stale failure for a superseded capture does not clobber the entry.
  failNewThreadRequest(ws, { id: capture.id + 1000000, text: 'keep me', target: 'repo-7' }, 'late');
  assert.equal(getNewThreadRequest(ws)?.error, 'create failed');
  // An explicit retry starts a fresh request with a clear error, and the
  // superseded capture can no longer fail it even with identical text.
  const retry = beginNewThreadRequest(ws, 'keep me', 'repo-7', () => Promise.resolve('created-2'));
  assert.notEqual(retry, first);
  assert.notEqual(getNewThreadRequest(ws)?.id, capture.id);
  failNewThreadRequest(ws, capture, 'late stale');
  assert.equal(getNewThreadRequest(ws)?.status, 'creating');
  assert.equal(getNewThreadRequest(ws)?.error, null);
});

test('new thread draft: one pending request is reused on reopen and released only after settlement', async () => {
  const ws = '/tmp/ws-new-reuse';
  const createdWs = '/tmp/ws-created-reuse';
  let calls = 0;
  const resolvers: Array<(value: string) => void> = [];
  const create = (): Promise<string> => {
    calls += 1;
    return new Promise<string>(resolve => {
      resolvers.push(resolve);
    });
  };
  const first = beginNewThreadRequest(ws, 'draft', 'repo-5', create);
  // Close/reopen asks again; the workspace still holds its one request.
  const reopened = beginNewThreadRequest(ws, 'changed', 'repo-6', create);
  assert.equal(calls, 1);
  assert.equal(reopened, first);
  assert.equal(getNewThreadRequest(ws)?.text, 'draft');
  assert.equal(getNewThreadRequest(ws)?.target, 'repo-5');
  resolvers[0]('created');
  assert.equal(await first, 'created');
  setNewThreadDraft(ws, { text: 'draft', target: 'repo-5' });
  const capture = getNewThreadRequest(ws)!;
  assert.equal(acknowledgeNewThreadRequest(ws, capture, createdWs, ALPHA), true);
  // After the entry is released an explicit new creation starts fresh.
  const next = beginNewThreadRequest(ws, 'draft', 'repo-5', create);
  assert.equal(calls, 2);
  assert.notEqual(next, first);
  resolvers[1]('created again');
  assert.equal(await next, 'created again');
});
