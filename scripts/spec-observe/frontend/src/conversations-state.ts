// Conversations-domain pure state owners: route selection, read/view
// availability, derived thread state, composer availability and scoped queue
// summaries. Threads.tsx delegates these decisions here; the label/help/tone
// tables carried below come from that surface verbatim so reasons stay
// consistent. Observation staleness is decided by the caller with the
// existing format.stale 45-second notion and passed as a boolean; this module
// owns no clock and introduces no new threshold.
export type ConversationQueueItem = {
  id: string;
  text?: string;
  state: string;
  queue_position?: number | null;
};

export type ConversationRow = {
  thread_id: string;
  title?: string;
  state?: string;
  history_only?: boolean;
  queue_paused?: boolean;
  attention?: string | { kind?: string };
  owns_response?: boolean;
  queue?: ConversationQueueItem[];
  target?: { kind: string; repository_id?: string; path?: string };
  updated_at?: string;
  [key: string]: unknown;
};

export type ConversationView =
  | 'denied'
  | 'loading'
  | 'error'
  | 'empty'
  | 'offline'
  | 'stale'
  | 'ready';

export type ReadError = { status?: number; message: string; network?: boolean };

export type ConversationSelection = {
  selected: ConversationRow | null;
  requestedMissing: boolean;
  normalizeId: string | null;
};

export type ComposerPrimary =
  | 'send'
  | 'stop'
  | 'resume'
  | 'discard'
  | 'refresh'
  | 'reconnect'
  | 'queue'
  | 'older'
  | 'none';

export type ComposerAvailability = {
  sendEnabled: boolean;
  reason: string;
  primary: ComposerPrimary;
};

export type QueueSummary = {
  waiting: number;
  items: NonNullable<ConversationRow['queue']>;
  ownerTitle: string | null;
  paused: boolean;
};

// Threads.tsx label/help/tone tables, carried verbatim. Unknown attention
// text is never replaced: stateReason() falls through to the raw state.
const labels: Record<string, string> = {
  active: 'Responding',
  idle: 'Ready',
  paused: 'Paused',
  'history-only': 'History only',
  uncertain: 'Delivery uncertain',
  stalled: 'Stalled',
  'start-failed': 'Start failed',
  'session-mismatch': 'Session mismatch',
  'missing-directory': 'Directory missing',
  'live-owner': 'Owner not confirmed dead',
  'missing-context': 'Context missing',
  'policy-refusal': 'Policy refusal',
};
const help: Record<string, [string, string, string]> = {
  active: [
    'Responding',
    'A response is being delivered to the head message. Stop pauses this queue first; the response slot is released only after confirmed idle or process death.',
    'good',
  ],
  paused: [
    'Queue paused',
    'Pending messages wait until Resume. Resume unpauses after identity and context checks; delivery continues in FIFO order.',
    'warn',
  ],
  'history-only': [
    'History only',
    'This record was imported without an owned process. Browsing works; send and resume are unavailable.',
    'muted',
  ],
  uncertain: [
    'Delivery uncertain',
    'A message was persisted before its acknowledgement was lost, so it may or may not have been delivered. Discard or retry under Pending messages; a retry may duplicate the response.',
    'bad',
  ],
  stalled: [
    'Stalled',
    'No child events for ten minutes. The response may still be running; nothing is released automatically. Refresh to check again, or Stop if the thread still owns the slot.',
    'warn',
  ],
  'start-failed': [
    'Start failed',
    'The discussion process failed before startup completed. Send a new message or Resume to retry the owned session.',
    'bad',
  ],
  'session-mismatch': [
    'Session mismatch',
    'The stored session file does not match this thread record. Inspect the workspace session copy, then retry.',
    'bad',
  ],
  'missing-directory': [
    'Execution directory missing',
    'The recorded execution directory is gone. Restore it or update the workspace record, then retry.',
    'bad',
  ],
  'live-owner': [
    'Owner not confirmed dead',
    'A prior discussion process is still recorded or observed. A second writer fails closed until the owner exits or Stop confirms it idle.',
    'bad',
  ],
  'missing-context': [
    'Context missing',
    'Threads no longer read earlier kit context files. Resume or send again to start.',
    'bad',
  ],
  'policy-refusal': [
    'Policy refusal',
    'The installed Pi read-tool policy refused the last request. Review the policy or context, then retry.',
    'bad',
  ],
};

const str = (value: unknown): string =>
  value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);

const stateReason = (state: string): string => {
  const entry = help[state];
  return (entry && entry[1]) || labels[state] || state;
};

// Route identity resolution. A requested id is the only identity trusted for
// fallback: present selects exactly that row, absent selects nothing and
// never falls back to the first row. First-row normalization happens only
// for a loaded, nonempty list with no requested id.
export function resolveSelection(input: {
  rows: readonly ConversationRow[];
  requestedId?: string;
  listLoaded: boolean;
}): ConversationSelection {
  const requested = typeof input.requestedId === 'string' && input.requestedId ? input.requestedId : '';
  if (requested) {
    const match = input.rows.find(row => row.thread_id === requested) ?? null;
    return { selected: match, requestedMissing: match === null, normalizeId: null };
  }
  if (!input.listLoaded) return { selected: null, requestedMissing: false, normalizeId: null };
  const first = input.rows[0] ?? null;
  return {
    selected: first,
    requestedMissing: false,
    normalizeId: first ? first.thread_id : null,
  };
}

// Read/view availability priority: denied > loading > error > empty >
// offline > stale > ready. Denied covers private-source refusals; history
// 503 stays a recoverable read error; a loaded-empty list outranks an
// unavailable stream; offline mirrors the reconnecting/stopped/unavailable
// stream states.
export function conversationsViewState(input: {
  live: boolean;
  listLoaded: boolean;
  rows: readonly ConversationRow[];
  listError: ReadError | null;
  historyError: ReadError | null;
  mutationError: boolean;
  streamState: string;
  observationStale: boolean;
}): ConversationView {
  if (
    !input.live ||
    input.listError?.status === 403 ||
    input.listError?.status === 503 ||
    input.historyError?.status === 403
  ) {
    return 'denied';
  }
  const error = input.listError != null || input.historyError != null || input.mutationError;
  if (!input.listLoaded && !error) return 'loading';
  if (error) return 'error';
  if (input.listLoaded && input.rows.length === 0) return 'empty';
  if (
    input.streamState === 'reconnecting' ||
    input.streamState === 'stopped' ||
    input.streamState === 'unavailable'
  ) {
    return 'offline';
  }
  if (input.observationStale) return 'stale';
  return 'ready';
}

// Threads.tsx derived(state) replication: history-only and paused flags
// outrank raw state; attention text/kind is returned verbatim; otherwise
// only 'active' is recognized and anything else is idle.
export function threadState(row: ConversationRow | null): string {
  if (!row) return 'unknown';
  if (row.history_only) return 'history-only';
  if (row.queue_paused) return 'paused';
  const attention =
    typeof row.attention === 'string'
      ? row.attention
      : row.attention && typeof row.attention === 'object'
        ? str(row.attention.kind || '')
        : '';
  return attention || (row.state === 'active' ? 'active' : 'idle');
}

const viewReason = (view: ConversationView): string => {
  switch (view) {
    case 'denied':
      return 'Private thread content is unavailable.';
    case 'loading':
      return 'Threads are loading.';
    case 'error':
      return 'The thread read failed. Refresh to retry.';
    case 'empty':
      return 'No threads are available yet.';
    case 'offline':
      return 'Live updates are not connected. Reconnect to continue.';
    case 'stale':
      return 'Thread data is outdated. Refresh to check again.';
    default:
      return '';
  }
};

// Composer availability keeps the surface's single primary action and the
// Send gate separate: Send is enabled only for a ready view, an actionable
// session, no pending operation, non-blank text and an idle/active thread
// (a queued message on an idle thread still counts as idle). Every disabled
// decision carries a non-empty reason; unknown attention text is preserved
// through stateReason().
export function composerAvailability(input: {
  view: ConversationView;
  thread: ConversationRow | null;
  actionable: boolean;
  draft: string;
  pending: boolean;
}): ComposerAvailability {
  const { view, thread, actionable, pending } = input;
  if (!thread) {
    return {
      sendEnabled: false,
      reason: 'Select a thread to read its transcript and compose a message.',
      primary: 'none',
    };
  }
  const state = threadState(thread);
  if (state === 'history-only') {
    return {
      sendEnabled: false,
      reason: stateReason(state),
      primary: 'older',
    };
  }
  if (view !== 'ready') {
    const primary: ComposerPrimary =
      view === 'offline' ? 'reconnect' : view === 'error' || view === 'stale' ? 'refresh' : 'none';
    return { sendEnabled: false, reason: viewReason(view), primary };
  }
  const queued = (thread.queue ?? []).some(item => item.state === 'queued');
  // Recovery primaries outrank ordinary responding/queued/idle actions: a
  // paused, uncertain or stalled thread keeps its Resume/Discard/Refresh
  // primary even with queued items or confirmed response ownership. The
  // owns_response fact stays on the row so the surface can still offer Stop
  // as a secondary action (stalled owner, responding thread).
  const statePrimary: ComposerPrimary =
    state === 'paused'
      ? 'resume'
      : state === 'uncertain'
        ? 'discard'
        : state === 'stalled'
          ? 'refresh'
          : state === 'active' || thread.owns_response === true
            ? 'stop'
            : queued
              ? 'queue'
              : state === 'idle' || state === 'active'
                ? 'send'
                : 'resume';
  const stateHoldsSend = state === 'idle' || state === 'active';
  if (stateHoldsSend && actionable && !pending && input.draft.trim() !== '') {
    return { sendEnabled: true, reason: '', primary: statePrimary };
  }
  const reason = !stateHoldsSend
    ? stateReason(state)
    : !actionable
      ? "Message controls are available on the host's live dashboard."
      : pending
        ? 'An operation is already in progress.'
        : 'Write a message before sending.';
  return { sendEnabled: false, reason, primary: statePrimary };
}

// Scoped queue summary. Items and their server-global queue_position values
// pass through untouched; the owner is the in-scope row that owns the
// response slot or, failing that, the active row; an absent owner is null.
export function queueSummary(
  rows: readonly ConversationRow[],
  selected: ConversationRow | null,
): QueueSummary {
  const items = selected?.queue ? [...selected.queue] : [];
  const waiting = items.filter(item => item.state === 'queued').length;
  const paused = selected?.queue_paused === true;
  const owner =
    rows.find(row => row.owns_response === true) ??
    rows.find(row => row.state === 'active') ??
    null;
  const ownerTitle = owner ? owner.title || `Thread ${owner.thread_id.slice(0, 8)}` : null;
  return { waiting, items, ownerTitle, paused };
}

// ---------------------------------------------------------------------------
// Retained in-memory owners (INV-2). Every store below is module-level so
// typed work survives destination/dialog unmounting, and no helper touches
// browser storage or the network. Thread-keyed entries use JSON [ws, thread]
// tuples so one workspace can never read another workspace's state.

export type ThreadDraft = { draft: string; retry: { id: string; draft: string } | null };

const threadKey = (ws: string, thread: string): string => JSON.stringify([ws, thread]);

const copyRetry = (retry: ThreadDraft['retry']): ThreadDraft['retry'] =>
  retry ? { id: retry.id, draft: retry.draft } : null;

const copyThreadDraft = (value: ThreadDraft): ThreadDraft => ({
  draft: value.draft,
  retry: copyRetry(value.retry),
});

const threadDrafts = new Map<string, ThreadDraft>();
const threadDraftListeners = new Set<(ws: string, thread: string) => void>();

// Mounted projections subscribe to owner changes, not transport epochs:
// acknowledgements from an unmounted sender still reach the current composer.
export function subscribeThreadDraft(listener: (ws: string, thread: string) => void): () => void {
  threadDraftListeners.add(listener);
  return () => { threadDraftListeners.delete(listener); };
}

function publishThreadDraft(ws: string, thread: string): void {
  for (const listener of threadDraftListeners) listener(ws, thread);
}

// A fresh absent entry is the empty draft; reading never inserts it.
export function getThreadDraft(ws: string, thread: string): ThreadDraft {
  const stored = ws && thread ? threadDrafts.get(threadKey(ws, thread)) : undefined;
  return stored ? copyThreadDraft(stored) : { draft: '', retry: null };
}

export function setThreadDraft(ws: string, thread: string, value: ThreadDraft): void {
  if (!ws || !thread) return;
  threadDrafts.set(threadKey(ws, thread), copyThreadDraft(value));
  publishThreadDraft(ws, thread);
}

export function clearThreadDraft(ws: string, thread: string): void {
  if (!ws || !thread) return;
  threadDrafts.delete(threadKey(ws, thread));
  publishThreadDraft(ws, thread);
}

// The failed-send retry identity travels with the captured draft so a late
// acknowledgement can recognize whether it still applies.
export function captureThreadSend(ws: string, thread: string): ThreadDraft {
  return getThreadDraft(ws, thread);
}

// A late acknowledgement clears the stored entry only while its text and
// retry identity still match the captured pair; newer typing survives.
export function acknowledgeThreadSend(ws: string, thread: string, captured: ThreadDraft): boolean {
  if (!ws || !thread) return false;
  const stored = threadDrafts.get(threadKey(ws, thread));
  if (!stored) return false;
  const sameRetry =
    stored.retry === null
      ? captured.retry === null
      : captured.retry !== null &&
        stored.retry.id === captured.retry.id &&
        stored.retry.draft === captured.retry.draft;
  if (stored.draft !== captured.draft || !sameRetry) return false;
  clearThreadDraft(ws, thread);
  return true;
}

// Prepared existing-thread text appends after a blank line when typed text
// exists, never replacing it, and resets the retry identity because the
// outgoing text changed. Applying a seed never sends.
export function applyThreadPreparedText(ws: string, thread: string, prepared: string): ThreadDraft {
  const current = getThreadDraft(ws, thread);
  const draft =
    current.draft === '' ? prepared : prepared === '' ? current.draft : `${current.draft}\n\n${prepared}`;
  setThreadDraft(ws, thread, { draft, retry: null });
  return getThreadDraft(ws, thread);
}

// Per-workspace remembered valid thread id used when returning through the
// rail. Empty (invalid) ids are ignored rather than stored as a selection.
const conversationReturnIds = new Map<string, string>();

export function rememberConversationId(ws: string, thread: string): void {
  if (!ws || !thread) return;
  conversationReturnIds.set(ws, thread);
}

export function getConversationReturnId(ws: string): string | undefined {
  return ws ? conversationReturnIds.get(ws) : undefined;
}

// Per-thread transcript reading position; absent means start at the bottom.
export type ThreadScroll = { scrollTop: number; stickBottom: boolean };

const threadScrolls = new Map<string, ThreadScroll>();

export function setThreadScroll(ws: string, thread: string, value: ThreadScroll): void {
  if (!ws || !thread) return;
  threadScrolls.set(threadKey(ws, thread), { scrollTop: value.scrollTop, stickBottom: value.stickBottom });
}

export function getThreadScroll(ws: string, thread: string): ThreadScroll | undefined {
  const stored = ws && thread ? threadScrolls.get(threadKey(ws, thread)) : undefined;
  return stored ? { scrollTop: stored.scrollTop, stickBottom: stored.stickBottom } : undefined;
}

// One-use workspace seed for the Start conversation dialog. Writing copies the
// seed and replaces any earlier unconsumed intent; consuming clears it so a
// reopen cannot replay prepared text.
export type NewThreadDraftSeed = { text: string; target?: string };

const newThreadSeeds = new Map<string, NewThreadDraftSeed>();

const copyNewThreadSeed = (seed: NewThreadDraftSeed): NewThreadDraftSeed => {
  const copy: NewThreadDraftSeed = { text: seed.text };
  if (seed.target !== undefined) copy.target = seed.target;
  return copy;
};

export function seedNewThreadDraft(ws: string, seed: NewThreadDraftSeed): void {
  if (!ws) return;
  newThreadSeeds.set(ws, copyNewThreadSeed(seed));
}

export function consumeNewThreadDraft(ws: string): NewThreadDraftSeed | undefined {
  const seed = ws ? newThreadSeeds.get(ws) : undefined;
  if (!seed) return undefined;
  newThreadSeeds.delete(ws);
  return copyNewThreadSeed(seed);
}

// Retained workspace new-thread draft. Opening the dialog consumes a one-use
// seed and merges it: text appends after a blank line when typed text exists,
// and a seed with a repository target replaces the retained choice.
export type NewThreadWorkspaceDraft = { text: string; target: string | null };

const newThreadDrafts = new Map<string, NewThreadWorkspaceDraft>();

export function getNewThreadDraft(ws: string): NewThreadWorkspaceDraft {
  const stored = ws ? newThreadDrafts.get(ws) : undefined;
  return stored ? { text: stored.text, target: stored.target } : { text: '', target: null };
}

export function setNewThreadDraft(ws: string, value: NewThreadWorkspaceDraft): void {
  if (!ws) return;
  newThreadDrafts.set(ws, { text: value.text, target: value.target ?? null });
}

// Without an expected value the clear is unconditional; with one it only
// clears while the retained text and target still match, so a newer seed or
// draft is never discarded by an earlier flow.
export function clearNewThreadDraft(ws: string, expected?: NewThreadWorkspaceDraft): void {
  if (!ws) return;
  if (expected !== undefined) {
    const stored = newThreadDrafts.get(ws);
    if (!stored || stored.text !== expected.text || stored.target !== expected.target) return;
  }
  newThreadDrafts.delete(ws);
}

export function openNewThreadDraft(ws: string): NewThreadWorkspaceDraft {
  const seed = consumeNewThreadDraft(ws);
  if (seed && ws) {
    const retained = getNewThreadDraft(ws);
    // A consumed seed carries an explicit target choice: an omitted or empty
    // seed target selects Whole workspace (null) rather than inheriting the
    // retained repository. A reopen without a new seed leaves the retained
    // choice untouched; repository-membership validation belongs to the
    // step-005 consumer.
    const target = seed.target === undefined || seed.target === '' ? null : seed.target;
    const text =
      seed.text === ''
        ? retained.text
        : retained.text === ''
          ? seed.text
          : `${retained.text}\n\n${seed.text}`;
    newThreadDrafts.set(ws, { text, target });
  }
  return getNewThreadDraft(ws);
}

// Workspace-scoped pending creation. The entry keeps an opaque request
// identity alongside the captured text/target and the in-flight promise; a
// closed or unmounted dialog can reopen and read the same request instead of
// starting a duplicate. Identity (not text/target equality) decides
// ownership, so a same-content replacement request is never settled by its
// predecessor's capture.
export type NewThreadRequestCapture = {
  id: number;
  text: string;
  target: string | null;
};

export type NewThreadPendingRequest = {
  id: number;
  ws: string;
  text: string;
  target: string | null;
  status: 'creating' | 'error';
  error: string | null;
  promise: Promise<unknown>;
};

const newThreadRequests = new Map<string, NewThreadPendingRequest & {
  draftEntry: NewThreadWorkspaceDraft | undefined;
}>();

let nextNewThreadRequestId = 1;

// Request ids whose captured text has already been transferred to its
// created thread. Settlement is once-only: observing the same completion
// again neither transfers nor clears.
const settledNewThreadRequestIds = new Set<number>();

export function getNewThreadRequest(ws: string): NewThreadPendingRequest | undefined {
  const stored = ws ? newThreadRequests.get(ws) : undefined;
  if (!stored) return undefined;
  const { draftEntry, ...request } = stored;
  return request;
}

export function beginNewThreadRequest<T>(
  ws: string,
  text: string,
  target: string | null,
  create: () => Promise<T>,
): Promise<T> {
  if (!ws) return create();
  const stored = newThreadRequests.get(ws);
  if (stored && stored.status === 'creating') return stored.promise as Promise<T>;
  const id = nextNewThreadRequestId++;
  const draftEntry = newThreadDrafts.get(ws);
  const promise = create();
  newThreadRequests.set(ws, { id, ws, text, target: target ?? null, status: 'creating', error: null, promise, draftEntry });
  return promise;
}

// Failure retains the captured text/target with its error so reopening the
// dialog restores the operator's input; only the matching request identity
// may fail, so a stale failure for a same-content replacement is ignored.
export function failNewThreadRequest(ws: string, captured: NewThreadRequestCapture, error?: string): void {
  const stored = ws ? newThreadRequests.get(ws) : undefined;
  if (!stored || stored.id !== captured.id) return;
  stored.status = 'error';
  stored.error = error ?? 'Creating the conversation failed.';
}

// Late acknowledgement: the captured text lands on the created thread's own
// draft at most once per request identity, even after the dialog unmounted
// or the retained draft was replaced. The pending entry and the retained
// workspace draft are cleared independently: the request must still match,
// and the draft must be the exact retained object captured at begin (even
// identical replacement text is newer intent). Returns true when the
// acknowledged request was still the workspace's current pending entry (the
// caller may publish/navigate only then).
export function acknowledgeNewThreadRequest(
  ws: string,
  captured: NewThreadRequestCapture,
  createdWs: string,
  createdThread: string,
): boolean {
  if (settledNewThreadRequestIds.has(captured.id)) return false;
  settledNewThreadRequestIds.add(captured.id);
  if (createdWs && createdThread) applyThreadPreparedText(createdWs, createdThread, captured.text);
  if (!ws) return false;
  const stored = newThreadRequests.get(ws);
  const owned = stored !== undefined && stored.id === captured.id;
  const retained = newThreadDrafts.get(ws);
  if (owned && retained && retained === stored.draftEntry) {
    newThreadDrafts.delete(ws);
  }
  if (owned) newThreadRequests.delete(ws);
  return owned;
}
