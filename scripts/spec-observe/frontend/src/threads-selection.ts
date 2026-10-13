// Thread-list selection owner for the Conversations surface.
//
// loadList() refreshes every five seconds and on every SSE notice/settled
// event, so the requested-thread route identity must be applied once per
// route transition — never re-applied on a steady refresh. Re-applying would
// revert an explicit row/create selection back to the route id and clear the
// newly selected thread's typed draft and send retry identity. Conversely, a
// new requested identity must invalidate the previous selection, history and
// event source before resolving, so an absent UUID leaves no unrelated
// active detail or Send/Prepare controls under the missing-thread URL.
//
// This module owns that decision as a pure function so it stays testable
// without a DOM; Threads.tsx executes the returned contract literally.
export type ThreadListRow = { thread_id: string };

export type ThreadListSelectionInput = {
  rows: readonly ThreadListRow[];
  /** Normalized requestedThreadId route value ('' when the route carries none). */
  requested: string;
  /** Route identity already applied by a previous list response ('' initially). */
  appliedRequested: string;
  /** Current explicit selection held by the surface. */
  selected: string;
};

export type ThreadListSelection = {
  /** Route identity to record after this list response. */
  appliedRequested: string;
  /** True when the route identity changed since the last applied response. */
  routeChanged: boolean;
  /** Selection the surface must hold after this list response. */
  nextSelected: string;
  /** True when a requested UUID is absent from this workspace's list. */
  requestedMissing: boolean;
  /**
   * True when the caller must invalidate the previous selection, history,
   * event source, typed draft and send retry identity before resolving.
   * The caller clears first, then applies nextSelected.
   */
  invalidated: boolean;
  /**
   * True when the caller must (re)load history and reopen the event source
   * for nextSelected.
   */
  shouldSelect: boolean;
  /**
   * True when a steady refresh retains an explicit selection: the caller
   * must not touch the typed draft or the send retry identity, and must not
   * consume the requested thread's one-use result seed for another thread.
   */
  retainExplicit: boolean;
};

const inRows = (rows: readonly ThreadListRow[], id: string): boolean =>
  Boolean(id) && rows.some(row => row.thread_id === id);

export function resolveThreadListSelection(input: ThreadListSelectionInput): ThreadListSelection {
  const { rows, requested, appliedRequested, selected } = input;
  const routeChanged = requested !== appliedRequested;
  if (requested) {
    const present = inRows(rows, requested);
    if (routeChanged) {
      // New route identity: invalidate everything from the previous thread
      // before resolving, so a missing UUID cannot keep unrelated detail.
      if (present) {
        return { appliedRequested: requested, routeChanged, nextSelected: requested, requestedMissing: false, invalidated: true, shouldSelect: true, retainExplicit: false };
      }
      return { appliedRequested: requested, routeChanged, nextSelected: '', requestedMissing: true, invalidated: true, shouldSelect: false, retainExplicit: false };
    }
    // Same route identity: a steady poll/Refresh/SSE refresh must never
    // override an explicit row/create selection or clear its draft/retry.
    if (!selected) {
      // Nothing held yet (e.g. the requested thread arrived in a later
      // page): adopt the requested thread, or stay empty while missing.
      if (present) {
        return { appliedRequested, routeChanged, nextSelected: requested, requestedMissing: false, invalidated: false, shouldSelect: true, retainExplicit: false };
      }
      return { appliedRequested, routeChanged, nextSelected: '', requestedMissing: true, invalidated: false, shouldSelect: false, retainExplicit: false };
    }
    if (selected === requested) {
      // Steady state on the requested thread: keep the typed draft and the
      // send retry identity; the one-use seed may still apply exactly here.
      if (present) {
        return { appliedRequested, routeChanged, nextSelected: selected, requestedMissing: false, invalidated: false, shouldSelect: false, retainExplicit: false };
      }
      // The requested thread vanished from the list on refresh: drop the
      // stale selection so no unrelated detail or controls survive.
      return { appliedRequested, routeChanged, nextSelected: '', requestedMissing: true, invalidated: true, shouldSelect: false, retainExplicit: false };
    }
    // Explicitly selected another thread: retain the selection, typed text
    // and retry identity exactly; never reseed from the requested thread.
    if (inRows(rows, selected)) {
      return { appliedRequested, routeChanged, nextSelected: selected, requestedMissing: false, invalidated: false, shouldSelect: false, retainExplicit: true };
    }
    // The explicit selection is gone from the list: fall back to the
    // requested route anchor when present, else to no selection.
    if (present) {
      return { appliedRequested, routeChanged, nextSelected: requested, requestedMissing: false, invalidated: true, shouldSelect: true, retainExplicit: false };
    }
    return { appliedRequested, routeChanged, nextSelected: '', requestedMissing: true, invalidated: true, shouldSelect: false, retainExplicit: false };
  }
  // No requested identity: first-row fallback only when nothing usable is
  // held; a steady refresh retains the explicit selection untouched.
  if (routeChanged) {
    const next = rows[0]?.thread_id || '';
    return { appliedRequested: requested, routeChanged, nextSelected: next, requestedMissing: false, invalidated: true, shouldSelect: Boolean(next), retainExplicit: false };
  }
  if (selected && inRows(rows, selected)) {
    return { appliedRequested, routeChanged, nextSelected: selected, requestedMissing: false, invalidated: false, shouldSelect: false, retainExplicit: true };
  }
  const next = rows[0]?.thread_id || '';
  if (next === selected) {
    return { appliedRequested, routeChanged, nextSelected: next, requestedMissing: false, invalidated: false, shouldSelect: false, retainExplicit: false };
  }
  // Clearing a stale selection (or adopting the first row) starts fresh:
  // drop the old history, event source, draft and retry identity.
  if (!next) {
    return { appliedRequested, routeChanged, nextSelected: next, requestedMissing: false, invalidated: true, shouldSelect: false, retainExplicit: false };
  }
  return { appliedRequested, routeChanged, nextSelected: next, requestedMissing: false, invalidated: true, shouldSelect: true, retainExplicit: false };
}
