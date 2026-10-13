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
  const statePrimary: ComposerPrimary =
    state === 'active' || thread.owns_response === true
      ? 'stop'
      : queued
        ? 'queue'
        : state === 'paused'
          ? 'resume'
          : state === 'uncertain'
            ? 'discard'
            : state === 'stalled'
              ? 'refresh'
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
