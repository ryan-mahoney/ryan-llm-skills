import { For, Show, createEffect, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { getJson, postJson, HttpError } from './api';
import { str, time, stale, statusMarkdown } from './format';
import { consumeThreadDraft, getLaunchDraft, seedLaunchDraft, seedThreadDraft } from './launch-state';
import { shouldResetAcknowledgedDraft } from './launch-picker-intent';
import {
  acknowledgeNewThreadRequest,
  acknowledgeThreadSend,
  applyThreadPreparedText,
  beginNewThreadRequest,
  captureThreadSend,
  composerAvailability,
  conversationsViewState,
  failNewThreadRequest,
  getNewThreadDraft,
  getNewThreadRequest,
  getThreadDraft,
  getThreadScroll,
  openNewThreadDraft,
  queueSummary,
  rememberConversationId,
  resolveSelection,
  setNewThreadDraft,
  setThreadDraft,
  setThreadScroll,
  subscribeThreadDraft,
  threadState,
  type NewThreadRequestCapture,
  type ReadError,
} from './conversations-state';
import { navigate } from './route';
import { ActionBar, EmptyState, MasterDetail, RegionalSkeleton, StateNotice, StatusText, type StatusTone } from './primitives';
import { scopeLabel } from './scope';
import type { DestinationProps } from './destinations';

// launch-state.ts remains the single owner of the one-use result-draft Map;
// this surface re-exports its seed contract instead of copying the store.
export { seedThreadDraft };

type Repo = { id: string; status?: string; worktrees?: Array<{ id?: string; path?: string; name?: string }> };
type Thread = Record<string, any> & { thread_id: string; title?: string; queue?: any[] };
type Entry = Record<string, any> & { id: string };
// Route identity is the only selection input; the retained per-thread owners
// (draft/retry, reading position, return id) live in conversations-state.ts.
type Props = Pick<DestinationProps, 'route' | 'workspace' | 'catalog' | 'token' | 'live' | 'refreshKey' | 'onNavigate'>;
const LIMIT = 100;
const labels: Record<string, string> = { active: 'Responding', idle: 'Ready', paused: 'Paused', 'history-only': 'History only', uncertain: 'Delivery uncertain', stalled: 'Stalled', 'start-failed': 'Start failed', 'session-mismatch': 'Session mismatch', 'missing-directory': 'Directory missing', 'live-owner': 'Owner not confirmed dead', 'missing-context': 'Context missing', 'policy-refusal': 'Policy refusal' };
const tones: Record<string, string> = { active: 'good', idle: 'good', paused: 'warn', stalled: 'warn', 'history-only': 'muted', uncertain: 'bad', 'start-failed': 'bad', 'session-mismatch': 'bad', 'missing-directory': 'bad', 'live-owner': 'bad', 'missing-context': 'bad', 'policy-refusal': 'bad' };
const uuid = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
const contentText = (content: any): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: any) => typeof p === 'string' ? p : p?.text || (['toolCall', 'tool_use'].includes(p?.type) ? `[tool ${p.name || p.toolName || 'call'}]` : p?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n') : content == null ? '' : str(content);
const roleOf = (e: Entry) => { const m = e?.message && typeof e.message === 'object' ? e.message : e; return str(m?.role || e?.role || ''); };
const textOf = (e: Entry) => { const m = e?.message && typeof e.message === 'object' ? e.message : e; return contentText(m?.content ?? m?.text ?? e?.content ?? ''); };
const label = (s: string) => labels[s] || (s && s !== 'unknown' ? str(s) : 'Unknown');
const tone = (s: string) => tones[s] || 'muted';

export default function Conversations(props: Props) {
  const [threads, setThreads] = createSignal<Thread[] | null>(null);
  const [invalid, setInvalid] = createSignal<any[]>([]);
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [older, setOlder] = createSignal(false);
  const [loadingHistory, setLoadingHistory] = createSignal(false);
  const [incompleteTail, setIncompleteTail] = createSignal(false);
  const [partial, setPartial] = createSignal('');
  const [toolNote, setToolNote] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [stream, setStream] = createSignal('unavailable');
  const [listError, setListError] = createSignal<ReadError | null>(null);
  // Read errors (list/history) and mutation errors (send/stop/resume/discard/
  // create) are separate: a history refresh can never clear a failed send.
  const [historyError, setHistoryError] = createSignal<ReadError | null>(null);
  const [mutationError, setMutationError] = createSignal('');
  // Successful /api/threads observation and the elapsed comparison share one
  // browser-local clock. nowTick advances on the existing 5s poll so the
  // stale view appears without a second timer or server-time comparison.
  const [listObservedAt, setListObservedAt] = createSignal<number | null>(null);
  const [nowTick, setNowTick] = createSignal(0);
  const [pending, setPending] = createSignal('');
  const [draft, setDraft] = createSignal('');
  const [newText, setNewText] = createSignal('');
  const [newTarget, setNewTarget] = createSignal('');
  const [newBusy, setNewBusy] = createSignal(false);
  const [newError, setNewError] = createSignal('');
  const [newEnabled, setNewEnabled] = createSignal(false);
  const [requestedMissing, setRequestedMissing] = createSignal(false);
  const [sendPending, setSendPending] = createSignal<{ id: string; draft: string } | null>(null);
  let source: EventSource | undefined;
  let listGeneration = 0;
  let projectionEpoch = 0;
  let historyGeneration = 0;
  let opGeneration = 0;
  let listBusy = false;
  let lastWorkspace = props.route.ws ?? '';
  let lastProjectionKey = '';
  // Projection identity: the exact (ws, thread) whose transcript, live stream,
  // pending display and draft are currently projected. A route transition
  // clears them synchronously, before any list/history await, so a held or
  // rejected list cannot leak the previous thread's controls or draft.
  let projectedWs = '';
  let projectedId = '';
  let stickBottom = true;
  let draftEl: HTMLTextAreaElement | undefined;
  let queueDetailsEl: HTMLDetailsElement | undefined;
  let transcriptEl: HTMLDivElement | undefined;
  let titleEl: HTMLHeadingElement | undefined;
  // Detail focus ownership: the first successful materialization (initial page
  // load) never steals focus; later id changes move focus to the selected
  // title once, unless the explicit seed composer or creation composer wins.
  let hasMaterialized = false;
  let creationPendingId = '';
  // Start conversation dialog identity. The dialog is route-owned, but its
  // request/text live in the retained workspace owner; these locals only
  // identify the current opening so a stale observer can never navigate.
  let newDialog!: HTMLDialogElement;
  let newSelectEl: HTMLSelectElement | undefined;
  let newReturnEl: HTMLButtonElement | undefined;
  let newInitKey = '';
  let newDialogEpoch = 0;
  let newDialogWs = '';
  let newDialogId = '';
  let newDialogRequestId = 0;
  let newCloseFocus = '';
  let newUnmounted = false;
  onCleanup(() => { newUnmounted = true; });
  const [announcer, setAnnouncer] = createSignal('');
  const wsId = () => props.route.ws ?? '';
  const routeId = () => props.route.id ?? '';
  const repositories = (): Repo[] => {
    const data = props.workspace;
    return data && Array.isArray(data.repositories) ? data.repositories : [];
  };
  const active = () => props.live && Boolean(wsId());
  const actionable = () => active() && Boolean(props.token);
  const thread = () => threads()?.find(t => t.thread_id === routeId());
  // Both sides of the elapsed comparison come from the same browser-local
  // clock: the recorded local instant and Date.now(). Server timestamps and
  // their clock offset never participate.
  const observationStale = () => {
    nowTick();
    const observed = listObservedAt();
    return observed !== null && stale(new Date(observed).toISOString(), Date.now());
  };
  // Connection/read view: list, history and mutation failures stay separate
  // inputs and the state owner keeps its established priority.
  const view = () => conversationsViewState({
    live: active(),
    listLoaded: threads() !== null,
    rows: threads() ?? [],
    listError: listError(),
    historyError: historyError(),
    mutationError: Boolean(mutationError()),
    streamState: stream(),
    observationStale: observationStale(),
  });
  // The read/connection view excludes the mutation failure: it reports the
  // underlying list/history/stream/stale state through the same owner, so a
  // failed send never masks reconnecting/stale. The mutation-error callout
  // and captured retry identity stay independent; explicit retry is enabled
  // only when this underlying view is usable (ready).
  const readView = () => conversationsViewState({
    live: active(),
    listLoaded: threads() !== null,
    rows: threads() ?? [],
    listError: listError(),
    historyError: historyError(),
    mutationError: false,
    streamState: stream(),
    observationStale: observationStale(),
  });
  const composer = () => composerAvailability({
    view: readView(),
    thread: thread() ?? null,
    actionable: actionable(),
    draft: draft(),
    pending: Boolean(pending()),
  });
  const announce = (value: string) => setAnnouncer(value);
  const unsubscribeDraft = subscribeThreadDraft((ws, id) => {
    if (ws !== projectedWs || id !== projectedId || ws !== wsId() || id !== routeId()) return;
    const stored = getThreadDraft(ws, id);
    setDraft(stored.draft); setSendPending(stored.retry);
  });
  onCleanup(unsubscribeDraft);
  // Denial hides every private projection and closes the live stream; the
  // retained draft owner survives so access recovery restores it.
  createEffect(() => { if (view() === 'denied') closeSource(); });
  function closeSource() { source?.close(); source = undefined; setStream('unavailable'); }
  function params(extra: Record<string, string> = {}) { return new URLSearchParams({ workspace_id: wsId(), ...extra }); }
  const routeError = (e: unknown) => e instanceof HttpError ? e.message : e instanceof Error ? e.message : 'The thread request could not be completed.';
  // Structured read failures keep the exact HTTP status so the denied/error
  // split trusts the response rather than message text.
  const readErrorOf = (e: unknown): ReadError => {
    const message = routeError(e);
    return e instanceof HttpError && Number.isFinite(e.status) ? { status: e.status, message } : { message, network: true };
  };
  function persistScroll() {
    if (!projectedWs || !projectedId || !transcriptEl) return;
    setThreadScroll(projectedWs, projectedId, { scrollTop: transcriptEl.scrollTop, stickBottom });
  }
  function restoreScroll(id: string, workspace: string) {
    if (id !== projectedId || workspace !== projectedWs || !transcriptEl) return;
    const stored = getThreadScroll(workspace, id);
    if (stored) { transcriptEl.scrollTop = stored.scrollTop; stickBottom = stored.stickBottom; return; }
    stickBottom = true;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  // Projection-scoped detail reset. The retained draft/retry owner and the
  // projection epoch survive, so Refresh and a fresh history page reuse them.
  function resetDetail() {
    closeSource();
    setEntries([]); setOlder(false); setLoadingHistory(false); setIncompleteTail(false);
    setPartial(''); setToolNote(''); setNotice(''); setPending('');
    setHistoryError(null);
  }
  // Route/projection transition: persist the outgoing reading position, then
  // drop every projection-scoped display immediately. Stored drafts survive.
  function clearProjection() {
    persistScroll();
    projectedWs = ''; projectedId = '';
    projectionEpoch++;
    resetDetail();
    setMutationError('');
    setDraft(''); setSendPending(null); setRequestedMissing(false); stickBottom = true;
  }
  function materialize(ws: string, id: string) {
    if (!ws || !id || (projectedWs === ws && projectedId === id)) return;
    const isFirst = !hasMaterialized;
    const isCreation = creationPendingId !== '' && creationPendingId === id;
    if (isCreation) creationPendingId = '';
    persistScroll();
    projectedWs = ws; projectedId = id;
    projectionEpoch++;
    resetDetail();
    setMutationError('');
    stickBottom = true;
    const stored = getThreadDraft(ws, id);
    setDraft(stored.draft); setSendPending(stored.retry);
    rememberConversationId(ws, id);
    // The one-use result seed applies only to the exact requested thread; a
    // missing thread never seeds an unrelated fallback selection.
    let seedFocused = false;
    if (id === routeId()) {
      const seed = consumeThreadDraft(ws, id);
      if (seed) {
        const prepared = applyThreadPreparedText(ws, id, seed.draft);
        setDraft(prepared.draft); setSendPending(prepared.retry);
        announce('Result draft prepared. Review the message before sending.');
        // The seed stays unsent: focus the exact rendered composer once,
        // guarded by the unchanged ws/id/epoch so an intervening projection
        // switch cannot steal focus. Seed composer focus wins over the generic
        // selected-title focus below.
        const seedEpoch = projectionEpoch;
        seedFocused = true;
        queueMicrotask(() => {
          if (draftEl && projectedWs === ws && projectedId === id && projectionEpoch === seedEpoch) draftEl.focus({ preventScroll: true });
        });
      }
    }
    if (!seedFocused && isCreation) {
      // Dialog creation owns the created id: the composer (with any prepared
      // text applied by settlement) wins over the generic selected-title focus
      // without stealing a newer route.
      const createEpoch = projectionEpoch;
      queueMicrotask(() => {
        if (draftEl && projectedWs === ws && projectedId === id && projectionEpoch === createEpoch) draftEl.focus({ preventScroll: true });
      });
    } else if (!seedFocused && !isCreation && !isFirst) {
      // Ordinary keyboard/row selection moves focus once to the selected
      // title. Steady polls never reach materialize for the same key, so they
      // cannot steal focus through this path.
      const titleEpoch = projectionEpoch;
      queueMicrotask(() => {
        if (titleEl && projectedWs === ws && projectedId === id && projectionEpoch === titleEpoch) titleEl.focus({ preventScroll: true });
      });
    }
    hasMaterialized = true;
    void loadHistory();
    openEvents();
  }
  // Post-list projection reconciliation. A present requested row selects
  // exactly that row; a loaded no-id list normalizes its first row through a
  // replace navigation; a freshly loaded absence shows requested-missing
  // without falling back. Stale rows only ever select a present row.
  function reconcile(freshList: boolean) {
    const ws = wsId(), id = routeId(), rows = threads();
    if (!ws || rows === null) return;
    const decision = resolveSelection({ rows, requestedId: id, listLoaded: true });
    if (decision.normalizeId) { navigate({ ...props.route, id: decision.normalizeId }, 'replace'); return; }
    if (decision.selected) { setRequestedMissing(false); materialize(ws, decision.selected.thread_id); return; }
    if (!decision.requestedMissing) { setRequestedMissing(false); clearProjection(); return; }
    if (freshList) { clearProjection(); setRequestedMissing(true); }
  }
  async function loadList() {
    if (!active() || listBusy) return;
    listBusy = true;
    const request = ++listGeneration, workspace = wsId();
    try {
      const data: any = await getJson(`/api/threads?${params()}`);
      if (request !== listGeneration || workspace !== wsId()) return;
      const rows: Thread[] = Array.isArray(data) ? data : Array.isArray(data.threads) ? data.threads : [];
      // Rows, selection and the observation ledger are written only by the
      // workspace-matching response; a held old-workspace list is dropped by
      // the generation/workspace guards before it can leak any of them.
      setThreads(rows); setInvalid(Array.isArray(data.invalid) ? data.invalid : []); setListError(null);
      setListObservedAt(Date.now()); setNowTick(value => value + 1);
      reconcile(true);
    } catch (e) {
      if (request === listGeneration && workspace === wsId()) setListError(readErrorOf(e));
    } finally { if (request === listGeneration) listBusy = false; }
  }
  async function loadHistory(before?: string, prepend = false) {
    if (!active() || !projectedId || projectedId !== routeId()) return;
    const request = ++historyGeneration, epoch = projectionEpoch, id = projectedId, workspace = projectedWs;
    const oldTop = transcriptEl?.scrollTop || 0, oldHeight = transcriptEl?.scrollHeight || 0;
    setLoadingHistory(true);
    try {
      const q: Record<string, string> = { thread_id: id, limit: String(LIMIT) }; if (before) q.before = before;
      const data: any = await getJson(`/api/thread/history?${params(q)}`);
      if (request !== historyGeneration || epoch !== projectionEpoch || id !== projectedId || workspace !== projectedWs || wsId() !== workspace) return;
      const page = Array.isArray(data.entries) ? data.entries : [];
      setEntries(prev => prepend ? [...page, ...prev] : page);
      setOlder(data.truncated === true); setIncompleteTail(data.incomplete_tail === true); setLoadingHistory(false); setHistoryError(null);
      if (prepend) queueMicrotask(() => { if (transcriptEl) transcriptEl.scrollTop = oldTop + transcriptEl.scrollHeight - oldHeight; });
      else queueMicrotask(() => restoreScroll(id, workspace));
    } catch (e) {
      if (request === historyGeneration && epoch === projectionEpoch && id === projectedId && wsId() === workspace) { setLoadingHistory(false); setHistoryError(readErrorOf(e)); }
    }
  }
  async function refreshTail() {
    const id = projectedId, workspace = projectedWs, epoch = projectionEpoch;
    if (!active() || !id) return;
    try {
      const data: any = await getJson(`/api/thread/history?${params({ thread_id: id, limit: String(LIMIT) })}`);
      if (epoch !== projectionEpoch || id !== projectedId || workspace !== projectedWs || wsId() !== workspace) return;
      const page: Entry[] = Array.isArray(data.entries) ? data.entries : [];
      if (!page.length) return;
      setEntries(prev => {
        const ids = new Set(prev.map(e => e.id)); const first = page.findIndex(e => ids.has(e.id));
        return first < 0 ? [...prev, ...page.filter(e => !ids.has(e.id))] : [...prev.slice(0, prev.findIndex(e => e.id === page[first].id)), ...page];
      });
      setIncompleteTail(data.incomplete_tail === true); setPartial('');
    } catch { /* Existing transcript remains readable during a temporary history failure. */ }
  }
  function openEvents() {
    closeSource();
    const id = projectedId, workspace = projectedWs, epoch = projectionEpoch;
    if (!active() || !id || id !== routeId() || typeof EventSource === 'undefined') return;
    const es = new EventSource(`/api/thread/events?${params({ thread_id: id })}`); source = es; setStream('connecting');
    const current = () => source === es && epoch === projectionEpoch && projectedId === id && projectedWs === workspace && wsId() === workspace;
    es.onopen = () => { if (current()) setStream('live'); };
    es.onerror = () => { if (current()) setStream(es.readyState === EventSource.CLOSED ? 'stopped' : 'reconnecting'); };
    for (const type of ['snapshot', 'delta', 'tool', 'message_end', 'state', 'notice', 'settled']) es.addEventListener(type, raw => {
      if (!current()) return;
      let data: any; try { data = JSON.parse((raw as MessageEvent).data); } catch { return; }
      if (type === 'snapshot') {
        if (data.thread_id !== id) return;
        setPartial(typeof data.partial === 'string' ? data.partial : '');
        updateSelected({ ...data, state: data.state });
        const tailId = entries().at(-1)?.id ?? null;
        if (!data.partial && typeof data.last_persisted_id === 'string' && data.last_persisted_id !== tailId) setTimeout(() => { if (current()) void refreshTail(); }, 0);
      } else {
        const ev = data.event && typeof data.event === 'object' ? data.event : {};
        // Live deltas append without moving the reader: stickBottom is only
        // changed by an actual transcript scroll or a fresh render.
        if (type === 'delta') { const d = typeof ev.delta === 'string' ? ev.delta : ev.assistantMessageEvent?.delta || ''; if (d) setPartial(v => v + d); }
        if (type === 'tool') setToolNote(`Running tool: ${ev.toolName || ev.tool || ev.name || 'activity'}`);
        if (type === 'message_end') { const val = contentText(ev.message?.content ?? ev.message?.text ?? ev.content ?? ev.text ?? ''); if (val) setPartial(val); setToolNote(''); setTimeout(() => { if (current()) void refreshTail(); }, 400); }
        if (type === 'state') updateSelected({ ...ev, queue: ev.queue ?? data.queue, attention: ev.attention ?? data.attention, queue_paused: ev.queue_paused });
        if (type === 'notice') { const msg = str(ev.message || ev.error || ev.attention || data.attention || 'Thread notice'); setNotice(msg); announce(`Thread notice: ${msg}`); void loadList(); }
        if (type === 'settled') { setToolNote(''); announce('Response settled; the next waiting message can deliver.'); void refreshTail(); void loadList(); }
      }
    });
  }
  function updateSelected(patch: any) {
    const id = routeId();
    setThreads(prev => prev?.map(t => t.thread_id !== id ? t : ({ ...t, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) })) || null);
  }
  function selectRow(id: string) {
    if (!id || id === routeId()) return;
    props.onNavigate({ ...props.route, dest: 'conversations', id });
  }
  // Refresh keeps the retained transcript and draft on the panel while the
  // reads run: a failed history read clears only on a later success, and the
  // stale state clears only when a matching list observation lands.
  function refreshThread() {
    if (!projectedId) return;
    historyGeneration++;
    setNotice('');
    setToolNote('');
    void loadHistory();
    openEvents();
    void loadList();
  }
  // Offline recovery reopens the live stream and reloads the list; the
  // retained draft is never sent automatically.
  function reconnectThread() {
    if (!projectedId) return;
    openEvents();
    void loadList();
    announce('Reconnecting live updates. Your draft is kept.');
  }
  async function action<T>(path: string, body: unknown, op: string): Promise<T> {
    const workspace = wsId(), id = routeId(), epoch = projectionEpoch, generation = ++opGeneration;
    setPending(op);
    try { return await postJson<T>(path, body, props.token || '', undefined); }
    finally { if (generation === opGeneration && workspace === wsId() && id === routeId() && epoch === projectionEpoch) setPending(''); }
  }
  // Start conversation dialog. Opening consumes the one-use prepared seed into
  // the workspace-retained draft and observes any pending create request;
  // closing or leaving the route only invalidates this opening's navigation,
  // never the retained request or its text.
  const newThreadAvailable = () => active() && Boolean(props.token);
  const newThreadUnavailableReason = () => !props.live
    ? 'Starting a conversation requires the live dashboard. Imported snapshots and file pages cannot reach discussions.'
    : !wsId()
      ? 'Choose a workspace before starting a conversation.'
      : 'The dashboard has not issued a thread action token. Refresh state to reconnect before starting a conversation.';
  function returnToThreads() {
    newCloseFocus = 'restore';
    const next: any = { ...props.route, dest: 'conversations' };
    delete next.tab;
    props.onNavigate(next);
  }
  // Route removal closes the native dialog. Focus returns to the New thread
  // control (or the retained title when it is gone) for Return/Escape; a
  // successful create deliberately leaves focus to the composer.
  function handleNewThreadClose() {
    const focus = newCloseFocus;
    newCloseFocus = '';
    if (newUnmounted || focus !== 'restore') return;
    const opener = document.getElementById('thread-new-action');
    if (opener instanceof HTMLElement) { opener.focus({ preventScroll: true }); return; }
    titleEl?.focus({ preventScroll: true });
  }
  // A retained repository choice is validated against the loaded workspace
  // record: an id the workspace no longer contains falls back to Whole
  // workspace without touching the prepared text.
  function validNewThreadTarget(ws: string, retained: { text: string; target: string | null }): string | null {
    const record: any = props.workspace;
    const list: Repo[] = record && Array.isArray(record.repositories) ? record.repositories : [];
    if (record && retained.target && !list.some(r => r.id === retained.target)) {
      setNewThreadDraft(ws, { text: retained.text, target: null });
      return null;
    }
    return retained.target;
  }
  // Reopening while a request is pending reuses the retained promise: this
  // observer only reflects the completion and, if this opening still owns the
  // request and route, navigates to the created thread. The once-only
  // transport settlement is attached when the request starts.
  function observeNewThreadRequest(ws: string, epoch: number) {
    const request = getNewThreadRequest(ws);
    if (!request) { newDialogRequestId = 0; setNewBusy(false); setNewError(''); return; }
    newDialogRequestId = request.id;
    if (request.status === 'error') { setNewBusy(false); setNewError(request.error || 'Creating the conversation failed.'); return; }
    setNewBusy(true); setNewError('');
    request.promise.then((record: any) => {
      if (newUnmounted || epoch !== newDialogEpoch) return;
      const createdThread = record && typeof record.thread_id === 'string' ? record.thread_id : '';
      if (!createdThread) return;
      settleCreatedThread(ws, record as Thread, epoch, request.id);
    }, (error: unknown) => {
      if (newUnmounted || epoch !== newDialogEpoch || newDialogRequestId !== request.id) return;
      setNewBusy(false);
      setNewError(getNewThreadRequest(ws)?.error || routeError(error));
    });
  }
  function initializeNewThreadDialog(ws: string, id: string, available: boolean) {
    newDialogEpoch++;
    const epoch = newDialogEpoch;
    newDialogWs = ws; newDialogId = id; newDialogRequestId = 0;
    setNewEnabled(available);
    if (!ws) { setNewText(''); setNewTarget(''); setNewBusy(false); setNewError(''); return; }
    if (!available) {
      const retained = getNewThreadDraft(ws);
      setNewText(retained.text); setNewTarget(''); setNewBusy(false); setNewError('');
      return;
    }
    const retained = openNewThreadDraft(ws);
    const target = validNewThreadTarget(ws, retained);
    setNewText(retained.text);
    setNewTarget(target ?? '');
    observeNewThreadRequest(ws, epoch);
    const pendingCreate = newBusy();
    requestAnimationFrame(() => {
      if (newUnmounted || epoch !== newDialogEpoch) return;
      (pendingCreate ? newReturnEl : newSelectEl)?.focus({ preventScroll: true });
    });
  }
  // The created record is published to the captured workspace's list owner.
  // Only the opening that still owns the request, workspace, thread id and
  // tab navigates; any other completion leaves the newer route alone and lets
  // the refreshed catalog discover the thread.
  function settleCreatedThread(ws: string, record: Thread, epoch: number, requestId: number) {
    if (newUnmounted || wsId() !== ws) return;
    const createdThread = record.thread_id;
    setThreads(prev => [record, ...(prev || []).filter(item => item.thread_id !== createdThread)]);
    announce('Thread created. It is named after your first message.');
    void loadList();
    const owns = epoch === newDialogEpoch
      && newDialogRequestId === requestId
      && props.route.tab === 'new'
      && routeId() === newDialogId
      && wsId() === newDialogWs;
    if (!owns) return;
    // Creation success owns the created id: navigate to it so the projection
    // materializes it and the composer (with any prepared text) takes focus
    // instead of the generic selected-title focus.
    creationPendingId = createdThread;
    const next: any = { ...props.route, dest: 'conversations', id: createdThread };
    delete next.tab;
    newCloseFocus = 'creation';
    props.onNavigate(next);
  }
  function createNewThread() {
    const ws = wsId(), selected = newTarget();
    if (!newThreadAvailable() || !ws || newBusy() || newError()) return;
    const dest = selected ? { kind: 'repository', repository_id: selected } : { kind: 'workspace' };
    // A cold, untouched dialog still publishes a coherent retained draft
    // before the request starts, so acknowledgement owns exactly this object
    // and the captured target/text match what the surface shows.
    setNewThreadDraft(ws, { text: newText(), target: selected || null });
    const promise = beginNewThreadRequest<Thread>(ws, newText(), selected || null, () => postJson<Thread>('/api/thread/create', { workspace_id: ws, target: dest }, props.token || ''));
    const request = getNewThreadRequest(ws);
    if (!request || request.status !== 'creating') return;
    newDialogRequestId = request.id;
    const captured: NewThreadRequestCapture = { id: request.id, text: request.text, target: request.target };
    const epoch = newDialogEpoch;
    setNewBusy(true); setNewError('');
    // The submit control becomes disabled with the rest of the fields; move
    // focus to the only enabled control (Return) without letting a later
    // opening steal it.
    requestAnimationFrame(() => {
      if (newUnmounted || epoch !== newDialogEpoch) return;
      newReturnEl?.focus({ preventScroll: true });
    });
    promise.then((record: any) => {
      const createdThread = record && typeof record.thread_id === 'string' ? record.thread_id : '';
      if (!createdThread) {
        failNewThreadRequest(ws, captured, 'The created conversation was not returned.');
        if (!newUnmounted && epoch === newDialogEpoch && newDialogRequestId === captured.id) {
          setNewBusy(false); setNewError(getNewThreadRequest(ws)?.error || 'The created conversation was not returned.');
        }
        return;
      }
      // Transport settlement lands the captured text on the exact returned
      // thread before any UI guard, so a late completion survives closed
      // dialogs, remounts and route changes.
      acknowledgeNewThreadRequest(ws, captured, ws, createdThread);
      settleCreatedThread(ws, record as Thread, epoch, captured.id);
    }, (error: unknown) => {
      failNewThreadRequest(ws, captured, routeError(error));
      if (!newUnmounted && epoch === newDialogEpoch && newDialogRequestId === captured.id) {
        setNewBusy(false);
        setNewError(getNewThreadRequest(ws)?.error || routeError(error));
      }
    });
  }
  // Native modal dialogs keep focus inside, but Tab does not wrap at the ends;
  // wrap across this dialog's own focusable controls (Specs completion-dialog
  // precedent) so focus never reaches BODY while Start conversation is open.
  function trapNewThreadTab(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(newDialog.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'));
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  async function send() {
    const id = projectedId, workspace = projectedWs;
    if (!actionable() || !id || id !== routeId() || workspace !== wsId() || !draft().trim() || pending()) return;
    // Every entrypoint (button and keyboard Enter) shares the composer's
    // availability decision: an unavailable connection/read view rejects the
    // send before any retry identity is minted. Route/key guards above stay.
    if (!composer().sendEnabled) return;
    const submitted = draft();
    // The captured retry identity travels with the submitted text so a failed
    // send retries with the same request id and a late acknowledgement only
    // clears the stored entry while both still match.
    const captured = captureThreadSend(workspace, id);
    let retry = captured.retry;
    if (!retry || retry.draft !== submitted) {
      retry = { id: uuid(), draft: submitted };
      setThreadDraft(workspace, id, { draft: submitted, retry });
    }
    const req = retry;
    const epoch = projectionEpoch;
    setSendPending(req);
    try {
      const data: any = await action('/api/thread/send', { workspace_id: workspace, thread_id: id, id: req.id, text: submitted.trim() }, 'send');
      // The retained owner is acknowledged even after a thread switch or an
      // unmount, and a late response never navigates. The owner publishes
      // matching settlement to the currently mounted key, independent of the
      // sender's epoch. Newer text/retry survives the owner's matching guard.
      acknowledgeThreadSend(workspace, id, { draft: submitted, retry: req });
      if (workspace === wsId() && id === routeId() && projectedWs === workspace && projectedId === id && epoch === projectionEpoch) {
        setMutationError(data.state === 'uncertain' ? 'The message may already have been delivered. Discard it or retry under Pending messages; a retry can duplicate the response.' : '');
        announce(data.duplicate ? 'Message was already queued.' : data.state === 'accepted' ? 'Message accepted.' : data.state === 'uncertain' ? 'Message delivery is uncertain.' : 'Message queued.');
        setTimeout(() => { if (id === projectedId && epoch === projectionEpoch) void refreshTail(); }, 0);
      }
      void loadList();
    } catch (e) {
      if (workspace === wsId() && id === routeId() && projectedId === id && epoch === projectionEpoch) setMutationError(routeError(e));
    }
  }
  async function simpleAction(path: string, op: string, body: any = {}) {
    const id = projectedId, workspace = projectedWs, epoch = projectionEpoch;
    if (!actionable() || !id || id !== routeId() || workspace !== wsId()) return;
    try {
      await action(path, { workspace_id: workspace, thread_id: id, ...body }, op);
      if (id === projectedId && workspace === projectedWs && epoch === projectionEpoch) {
        setMutationError('');
        announce(op === 'stop' ? 'Stop requested. The thread queue is paused.' : op === 'resume' ? 'Thread resumed.' : body.resend ? 'Message queued again. A duplicate response is possible.' : 'Uncertain message discarded.');
        void loadList();
        if (op === 'resume') void refreshTail();
      }
    } catch (e) {
      if (id === projectedId && workspace === projectedWs && epoch === projectionEpoch && workspace === wsId()) setMutationError(routeError(e));
    }
  }
  // Discard is confirm-gated: cancelling the native dialog records no server
  // mutation, and the exact confirmation copy states that earlier delivery is
  // not undone. Retry crosses the same endpoint with resend:true only when the
  // operator clicks it.
  function discardMessage(item: any) {
    if (!(typeof window !== 'undefined' && window.confirm('Discard this pending message? It will be removed from the queue. This does not undo any earlier delivery.'))) return;
    void simpleAction('/api/thread/discard', 'discard', { id: item.id, resend: false });
  }
  function retryMessage(item: any) {
    void simpleAction('/api/thread/discard', 'resend', { id: item.id, resend: true });
  }
  // Prepare assignment hands the exact thread identity to the hidden launch
  // flow. A repository target recorded on the thread rides along as the
  // requested target; worktree threads carry no route target and stay
  // server-bound. The server remains authoritative for binding the target at
  // review, so no client-side target is invented here. An acknowledged thread
  // launch is cleared by the existing acknowledged-success guard so explicit
  // Prepare starts an independent empty draft; pending, failed, unconfirmed
  // and editable entries stay untouched.
  function prepareAssignment() {
    const id = projectedId, workspace = projectedWs;
    if (!id || id !== routeId()) return;
    const threadTarget = thread()?.target;
    const repositoryId = threadTarget && threadTarget.kind === 'repository' && typeof threadTarget.repository_id === 'string' && threadTarget.repository_id ? threadTarget.repository_id : '';
    const context = { ws: workspace, thread: id };
    if (shouldResetAcknowledgedDraft(getLaunchDraft(context))) {
      seedLaunchDraft(context, { title: '', content: '' });
    }
    props.onNavigate({ dest: 'launch', ws: workspace, thread: id, ...(repositoryId ? { target: repositoryId } : {}), tab: 'brief' });
    announce('Opening the launch brief for this thread.');
  }
  onMount(() => {
    void loadList();
    const timer = window.setInterval(() => { setNowTick(value => value + 1); void loadList(); }, 5000);
    onCleanup(() => {
      clearInterval(timer);
      listGeneration++; projectionEpoch++; historyGeneration++;
      persistScroll(); closeSource();
    });
  });
  createEffect(() => {
    const ws = wsId();
    const id = routeId();
    props.live; props.refreshKey;
    if (!active()) {
      lastWorkspace = ws; lastProjectionKey = '';
      listGeneration++; listBusy = false;
      clearProjection();
      setThreads(null); setInvalid([]); setListError(null); setListObservedAt(null); setRequestedMissing(false);
      return;
    }
    if (ws !== lastWorkspace) {
      // A workspace change resets the held list gate so a prior held request
      // cannot starve the new scope; the old projection is persisted/cleared
      // before the new list arrives.
      lastWorkspace = ws; lastProjectionKey = '';
      listGeneration++; listBusy = false;
      clearProjection();
      setThreads(null); setInvalid([]); setListError(null); setListObservedAt(null); setRequestedMissing(false);
    } else {
      const key = ws && id ? JSON.stringify([ws, id]) : '';
      if (key !== lastProjectionKey) {
        lastProjectionKey = key;
        clearProjection();
      }
    }
    untrack(() => reconcile(false));
    void loadList();
  });
  // The uncertain view shows the persisted pending text: the retained draft
  // owner still survives underneath, but the composer displays the item the
  // server persisted so Discard/Retry decisions read the exact payload.
  createEffect(() => {
    const uncertain = state() === 'uncertain' ? (thread()?.queue || []).find(item => item.state === 'uncertain') : undefined;
    const value = uncertain && typeof uncertain.text === 'string' && uncertain.text ? uncertain.text : draft();
    if (draftEl && draftEl.value !== value) draftEl.value = value;
  });
  createEffect(() => {
    entries(); partial(); toolNote();
    if (stickBottom && transcriptEl) queueMicrotask(() => { if (stickBottom && transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight; });
  });
  // The dialog is route-addressable: tab=new opens it on mount and direct
  // entry, and removing the tab closes it. A workspace/thread/availability
  // change while open re-opens the retained draft for the new identity;
  // closing invalidates this opening's navigation only.
  createEffect(() => {
    const open = props.route.tab === 'new';
    const ws = wsId(), id = routeId();
    const available = newThreadAvailable();
    if (!open) {
      if (newDialog?.open) {
        newDialog.close();
        newInitKey = '';
        newDialogEpoch++;
      }
      return;
    }
    const key = JSON.stringify([ws, id, available]);
    if (!newDialog?.open) {
      newDialog.showModal();
      newInitKey = key;
      initializeNewThreadDialog(ws, id, available);
      return;
    }
    if (newInitKey !== key) {
      newInitKey = key;
      initializeNewThreadDialog(ws, id, available);
    }
  });
  // A retained repository target can only be validated once the workspace
  // record is available; a late load that lacks the id falls back to Whole
  // workspace without touching the prepared text.
  createEffect(() => {
    const ws = wsId();
    const record: any = props.workspace;
    if (props.route.tab !== 'new' || !newEnabled() || !ws || !record) return;
    const list: Repo[] = Array.isArray(record.repositories) ? record.repositories : [];
    const chosen = newTarget();
    if (chosen && !list.some(r => r.id === chosen)) {
      setNewTarget('');
      setNewThreadDraft(ws, { text: newText(), target: null });
    }
  });

  const state = () => threadState(thread() ?? null);
  const queue = () => queueSummary(threads() ?? [], thread() ?? null);
  const queuedItems = () => queue().items.filter(item => item.state === 'queued');
  const minimumQueuePosition = () => {
    const positions = queuedItems().map(item => Number(item.queue_position)).filter(value => Number.isFinite(value));
    return positions.length ? Math.min(...positions) : null;
  };
  // Composer-foot context copy from the reference screens: responding points
  // at the pause (never termination), paused points at Resume, and uncertain
  // names the blocked control instead of an immediate action.
  const composerHelp = () => state() === 'active'
    ? 'Response in progress · Stop response to pause delivery'
    : state() === 'paused'
      ? 'Draft retained · Resume queue to continue delivery'
      : state() === 'uncertain'
        ? 'Message controls unavailable until the thread can act.'
        : 'Enter sends · Shift+Enter adds a newline. Messages queue in order over the single local response slot.';
  const contextualHelp = () => ['active', 'paused', 'uncertain'].includes(state());
  const help = () => ({ active: ['Responding', 'A response is being delivered to the head message. Stop pauses this queue first; the response slot is released only after confirmed idle or process death.', 'good'], paused: ['Queue paused', 'Pending messages wait until Resume. Resume unpauses after identity and context checks; delivery continues in FIFO order.', 'warn'], 'history-only': ['History only', 'This record was imported without an owned process. Browsing works; send and resume are unavailable.', 'muted'], uncertain: ['Delivery uncertain', 'A message was persisted before its acknowledgement was lost, so it may or may not have been delivered. Discard or retry under Pending messages; a retry may duplicate the response.', 'bad'], stalled: ['Stalled', 'No child events for ten minutes. The response may still be running; nothing is released automatically. Refresh to check again, or Stop if the thread still owns the slot.', 'warn'], 'start-failed': ['Start failed', 'The discussion process failed before startup completed. Send a new message or Resume to retry the owned session.', 'bad'], 'session-mismatch': ['Session mismatch', 'The stored session file does not match this thread record. Inspect the workspace session copy, then retry.', 'bad'], 'missing-directory': ['Execution directory missing', 'The recorded execution directory is gone. Restore it or update the workspace record, then retry.', 'bad'], 'live-owner': ['Owner not confirmed dead', 'A prior discussion process is still recorded or observed. A second writer fails closed until the owner exits or Stop confirms it idle.', 'bad'], 'missing-context': ['Context missing', 'Threads no longer read earlier kit context files. Resume or send again to start.', 'bad'], 'policy-refusal': ['Policy refusal', 'The installed Pi read-tool policy refused the last request. Review the policy or context, then retry.', 'bad'] } as Record<string, [string, string, string]>)[state()] || ['Ready', '', 'good'] as [string, string, string];

  // Render-only derivations for the migrated surface: the workspace label is
  // owned by the catalog helper, and recorded target metadata is shown exactly
  // as stored (a worktree path is never re-bound to a repository id here).
  const noticeTone = (value: string): StatusTone => value === 'good' ? 'success' : value === 'warn' ? 'warning' : value === 'bad' ? 'error' : 'neutral';
  const statusTone = (value: string) => noticeTone(tone(value));
  const workspaceName = () => scopeLabel(props.route.ws, props.catalog);
  const targetDescription = (t?: Thread): string => {
    const target = t?.target;
    if (!target || typeof target !== 'object' || typeof target.kind !== 'string') return 'Workspace discussion';
    if (target.kind === 'repository') return typeof target.repository_id === 'string' && target.repository_id ? `Repository ${target.repository_id}` : 'Repository discussion';
    if (target.kind === 'worktree') return typeof target.path === 'string' && target.path ? `Worktree ${target.path}` : 'Worktree discussion';
    if (target.kind === 'workspace') return 'Workspace discussion';
    return `${str(target.kind)} discussion`;
  };
  const countLabel = () => {
    if (view() === 'denied') return listError()?.status === 503 ? 'Service unavailable' : 'Local access required';
    const rows = threads();
    if (rows === null) return 'Reading conversations…';
    return `${rows.length} conversation${rows.length === 1 ? '' : 's'}`;
  };
  // Denied copy follows screen 58 for the private-source refusal; the 503
  // list failure keeps the same suppressed composition with service copy.
  const deniedTitle = () => !active() || listError()?.status === 403 || historyError()?.status === 403 ? 'Local discussions unavailable' : 'Conversations are unavailable';
  const deniedText = () => !active() || listError()?.status === 403 || historyError()?.status === 403
    ? "Private threads can be read only on the host's local dashboard. This connection cannot read or send private discussions. Workspace and status documents remain available."
    : 'The discussion service is not running. Workspace and status documents remain available.';
  // Invalid-record warnings name recognized reasons and never echo arbitrary
  // server text into the list.
  const invalidReason = (raw: unknown): string => {
    const value = raw && typeof raw === 'object' ? (raw as any).reason ?? (raw as any).code : raw;
    const code = typeof value === 'string' ? value : '';
    const known: Record<string, string> = {
      'invalid-json': 'One record is not valid JSON.',
      'missing-thread-id': 'One record has no thread id.',
      'unreadable-session': 'One session file could not be read.',
      'invalid-record': 'One record is not a valid thread.',
    };
    return known[code] || 'One unreadable record is excluded from the list.';
  };

  return (
    <>
    <MasterDetail
      listLabel="Conversation threads"
      list={
        <>
          <div class="list-controls">
            <h2>Threads</h2>
            <p class="muted">{workspaceName()}</p>
          </div>
          <div class="list-caption">{countLabel()}</div>
          <div class="records">
            <Show when={view() === 'denied'}>
              <p class="empty muted">{listError()?.status === 503 ? 'The discussion service is unavailable.' : 'Local access required.'}</p>
            </Show>
            <Show when={view() !== 'denied'}>
              <Show when={readView() === 'loading'}><RegionalSkeleton rows={4} label="Reading conversations" /></Show>
              <Show when={readView() !== 'loading'}>
                <Show when={listError() && threads() !== null}>
                  <StateNotice
                    tone="warning"
                    title="Threads could not be read"
                    action={<button type="button" class="ds-btn" onClick={() => void loadList()}>Retry threads</button>}
                  >
                    Your selected thread and draft are kept.
                  </StateNotice>
                </Show>
                <Show when={listError() && threads() === null}>
                  <StateNotice tone="error" title="Threads are unavailable" action={<button type="button" class="ds-btn ds-btn--primary" onClick={() => void loadList()}>Retry</button>}>
                    {listError()?.message || 'Threads could not be loaded.'}
                  </StateNotice>
                </Show>
                <Show when={threads() !== null}>
                  <Show when={(threads() || []).length} fallback={<EmptyState title="No conversations yet" text={`Create a thread to discuss work in ${workspaceName()}.`} action={<button id="thread-empty-create" type="button" class="ds-btn ds-btn--primary" onClick={() => props.onNavigate({ ...props.route, tab: 'new' })}>Create thread</button>} />}>
                    <For each={threads()}>{t => { const s = threadState(t); const q = queueSummary(threads() ?? [], t); return <button class={`record thread-row${t.thread_id === routeId() ? ' selected' : ''}`} data-thread={t.thread_id} aria-pressed={t.thread_id === routeId()} onClick={() => selectRow(t.thread_id)}><span class="row-heading"><strong>{t.title || `Thread ${t.thread_id.slice(0, 8)}`}</strong><StatusText tone={statusTone(s)}>{label(s)}</StatusText></span><p>{workspaceName()} · {targetDescription(t)}</p><small>{q.items.length ? `${q.waiting ? `${q.waiting} waiting` : `${q.items.length} pending`}${q.paused ? ' · paused queue' : ''}` : 'No pending messages'}</small></button>; }}</For>
                  </Show>
                  <Show when={invalid().length}><StateNotice tone="warning" title={`Invalid thread records (${invalid().length})`}>{invalid().map(invalidReason).join(' ')}</StateNotice></Show>
                </Show>
              </Show>
            </Show>
          </div>
        </>
      }
    >
      <Show when={view() === 'denied'}>
        <EmptyState title={deniedTitle()} text={deniedText()} action={<button id="thread-open-workspaces" type="button" class="ds-btn ds-btn--primary" onClick={() => props.onNavigate({ dest: 'workspaces', ws: wsId() })}>Open workspaces</button>} />
      </Show>
      <Show when={view() !== 'denied'}>
        <Show when={readView() === 'loading'}><RegionalSkeleton rows={5} label="Reading the conversation" /></Show>
        <Show when={readView() === 'empty'}><EmptyState title="Start a conversation" text="Choose New thread, select where it runs, then send your first message." /></Show>
        <Show when={readView() !== 'loading' && readView() !== 'empty'}>
        <Show when={thread()} fallback={<Show when={requestedMissing()} fallback={<EmptyState title="No thread selected" text="Select a thread to read its transcript and compose a message." />}><div class="ds-callout error" id="thread-requested-unavailable" role="status"><div><p>Requested thread {routeId()} is unavailable.</p><p class="small muted">It is not in this workspace's thread list, so nothing was selected, seeded or launched.</p></div></div></Show>}>
          <div class="object-head">
            <div class="object-top detail-title"><h2 tabindex="-1" ref={el => (titleEl = el)}>{thread()?.title || `Thread ${routeId().slice(0, 8)}`}</h2><StatusText tone={statusTone(state())}>{label(state())}</StatusText></div>
            <p class="small muted mono thread-meta">Runs in {targetDescription(thread())} · {workspaceName()} · Thread {routeId()}{thread()?.generation != null ? ` · generation ${thread()?.generation}` : ''}{thread()?.updated_at ? ` · updated ${time(thread()?.updated_at)} ` : ''}</p>
          </div>
          <Show when={help()[1]}><StateNotice tone={noticeTone(help()[2])} title={help()[0]}>{help()[1]}</StateNotice></Show>
          <Show when={readView() === 'error'}>
            <StateNotice tone="error" title="Thread state could not be read" action={<button id="thread-error-retry" type="button" class="ds-btn" onClick={() => { void loadHistory(); void loadList(); }}>Retry thread</button>}>
              Your draft and earlier messages are kept. Refresh the thread before sending.
            </StateNotice>
          </Show>
          <Show when={readView() === 'offline'}>
            <StateNotice tone="warning" title={stream() === 'stopped' ? 'Live updates stopped' : 'Live updates reconnecting'} action={<button id="thread-reconnect" type="button" class="ds-btn ds-btn--primary" onClick={reconnectThread}>Reconnect thread</button>}>
              The partial answer and your unsent draft are kept. No message will be resent automatically.
            </StateNotice>
          </Show>
          <Show when={readView() === 'stale'}>
            <StateNotice tone="warning" title="Thread state needs checking" action={<button id="thread-stale-refresh" type="button" class="ds-btn ds-btn--primary" onClick={refreshThread}>Refresh thread</button>}>
              The transcript is retained, but response ownership was last checked {listObservedAt() ? time(new Date(listObservedAt()!).toISOString()) : 'recently'}. Refresh before sending.
            </StateNotice>
          </Show>
          <Show when={incompleteTail()}>
            <StateNotice tone="warning" title="Some history could not be read">The final session line is incomplete. Parsed messages remain available.</StateNotice>
          </Show>
          <Show when={mutationError()}><div id="thread-mutation-error" class="ds-callout error" role="alert"><div><p>{mutationError()}</p></div></div></Show>
          <div class="ds-transcript thread-transcript" role="log" aria-label="Thread transcript" tabindex="0" ref={transcriptEl} onScroll={e => { const el = e.currentTarget; stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
            <Show when={older() && entries().length}><p><button type="button" data-thread-older disabled={!!pending()} onClick={() => { const first = entries()[0]?.id; if (first) void loadHistory(first, true); }}>Load older messages</button></p></Show>
            <Show when={loadingHistory()}><p class="small muted">Loading transcript…</p></Show>
            <For each={entries()}>{entry => { const role = roleOf(entry), mine = role === 'user', text = textOf(entry); return <div class={`ds-turn ${mine ? 'ds-turn--user thread-entry user' : 'ds-turn--bot thread-entry assistant'}`}><div class="ds-turn__meta"><strong>{mine ? 'You' : role === 'assistant' ? 'Pi' : role || 'Entry'}</strong><Show when={entry.timestamp && Number.isFinite(Date.parse(entry.timestamp))}><span>{entry.timestamp}</span></Show></div><Show when={mine} fallback={<div class="status-markdown ds-turn__body" innerHTML={statusMarkdown(text)} />}><div class="ds-turn__body thread-text"><p>{text}</p></div></Show></div>; }}</For>
            <Show when={partial()}><div class="ds-turn ds-turn--bot thread-entry assistant"><div class="ds-turn__meta"><strong>Pi</strong><span>responding</span></div><div class="status-markdown ds-turn__body thread-partial" innerHTML={statusMarkdown(partial())} /></div></Show>
            <Show when={toolNote()}><p class="small muted ds-toolrail">{toolNote()}</p></Show>
            <Show when={!entries().length && !partial() && !toolNote() && !loadingHistory()}><p class="small muted">No messages recorded for this thread yet.</p></Show>
          </div>
          <Show when={(thread()?.queue || []).length || state() === 'active' || state() === 'stalled'}>
            <div id="thread-queue" class="rows queue" aria-label="Pending messages">
              <Show when={state() === 'active'}>
                <p>{thread()?.owns_response === true ? 'One host response slot in use · This thread owns the response' : 'One host response slot in use · Ownership is not confirmed for this thread'}</p>
              </Show>
              <Show when={state() === 'stalled'}>
                <p>{thread()?.owns_response === true ? 'Last observed ownership: this thread retains the response slot.' : 'Last observed ownership: no confirmed response owner in this workspace; silence is not proof the response stopped.'}</p>
              </Show>
              <Show when={queue().waiting}>
                <p>{queue().ownerTitle ? `Your message is saved; ${queue().ownerTitle} owns the response slot.` : 'Your message is saved. Another thread currently owns the host response slot.'}</p>
                <details id="thread-queue-details" ref={el => (queueDetailsEl = el)}>
                  <summary>{`${queue().waiting} queued message${queue().waiting === 1 ? '' : 's'}${minimumQueuePosition() !== null ? ` · position ${minimumQueuePosition()}` : ''}`}</summary>
                  <For each={queuedItems()}>{item => <p class="small thread-text">{item.queue_position != null ? `Position ${item.queue_position} · ` : ''}{item.text || ''}</p>}</For>
                </details>
              </Show>
              <For each={queue().items.filter(item => item.state === 'uncertain')}>{item => <div class="info-row"><p><strong>{item.text || 'Delivery uncertain'}</strong>{item.queue_position != null ? ` · queue position ${item.queue_position}` : ''}</p><small class="warn">Retry sends a new message and may duplicate the response.</small><p class="thread-actions"><button type="button" class={`ds-btn${composer().primary === 'discard' ? ' ds-btn--primary' : ''}`} data-thread-discard={item.id} disabled={!actionable() || readView() !== 'ready' || ['discard', 'resend'].includes(pending())} onClick={() => discardMessage(item)}>Discard message</button><button type="button" class="ds-btn" data-thread-resend={item.id} disabled={!actionable() || readView() !== 'ready' || ['discard', 'resend'].includes(pending())} onClick={() => retryMessage(item)}>Retry message</button></p></div>}</For>
            </div>
          </Show>
          <Show when={state() === 'history-only'} fallback={<div class="composer thread-composer"><label for="thread-draft">Message thread</label><textarea id="thread-draft" class="ds-input" rows="4" readonly={state() === 'uncertain'} placeholder={state() === 'uncertain' ? 'The uncertain message is retained until you discard or retry it.' : 'Write a message. Enter sends; Shift+Enter adds a newline.'} ref={draftEl} onInput={e => { const value = e.currentTarget.value; setDraft(value); if (projectedWs && projectedId) setThreadDraft(projectedWs, projectedId, { draft: value, retry: sendPending() }); }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} /><div class="composer-foot"><p class="small muted">{composerHelp()}</p><Show when={!composer().sendEnabled && composer().reason && !contextualHelp()}><p class="small warn">{composer().reason}</p></Show><ActionBar variant="inline"><Show when={composer().primary === 'queue' && queue().waiting}><button id="thread-open-queue" type="button" class="ds-btn ds-btn--primary" onClick={() => { if (queueDetailsEl) queueDetailsEl.open = true; }}>Open queue</button></Show><button id="thread-send" type="button" class={`ds-btn${composer().primary === 'send' ? ' ds-btn--primary' : ''}`} data-thread-send disabled={!composer().sendEnabled} onClick={() => void send()}>{pending() === 'send' ? 'Sending…' : 'Send message'}</button><Show when={state() === 'active' || thread()?.owns_response === true}><button id="thread-stop" type="button" class={`ds-btn${composer().primary === 'stop' ? ' ds-btn--primary' : ''}`} data-thread-stop disabled={!actionable() || readView() !== 'ready' || pending() === 'stop'} onClick={() => void simpleAction('/api/thread/stop', 'stop')}>{pending() === 'stop' ? 'Stopping…' : 'Stop response'}</button></Show><Show when={state() === 'paused'}><button id="thread-resume" type="button" class={`ds-btn${composer().primary === 'resume' ? ' ds-btn--primary' : ''}`} data-thread-resume disabled={!actionable() || readView() !== 'ready' || pending() === 'resume'} onClick={() => void simpleAction('/api/thread/resume', 'resume')}>{pending() === 'resume' ? 'Resuming…' : 'Resume queue'}</button></Show><button type="button" class={`ds-btn${composer().primary === 'refresh' ? ' ds-btn--primary' : ''}`} data-thread-refresh onClick={refreshThread}>Refresh thread</button></ActionBar></div></div>}>
            <StateNotice tone="neutral">This thread is history only: browsing and reading work, but sending and resuming are unavailable. Source sessions are never modified.</StateNotice>
          </Show>
          <ActionBar>
            <Show when={active() && state() !== 'history-only'}><button id="thread-prepare-assignment" type="button" class="ds-btn" data-thread-prepare disabled={!actionable()} onClick={() => prepareAssignment()}>Prepare assignment</button><p class="small muted">Opens the launch brief for this thread. The server binds the worktree target at review; nothing is launched from here.</p></Show>
            <StatusText tone={stream() === 'live' ? 'success' : stream() === 'reconnecting' ? 'warning' : 'neutral'}>{stream() === 'live' ? 'Live' : stream() === 'connecting' ? 'Connecting live updates…' : stream() === 'reconnecting' ? 'Live updates reconnecting…' : stream() === 'stopped' ? 'Live updates stopped' : 'Live updates unavailable'}</StatusText>
            <p class="small muted">The local stream may stay silent for 15 seconds between keepalives.</p>
            <Show when={notice()}><p class="small muted">{notice()}</p></Show>
          </ActionBar>
        </Show>
        </Show>
      </Show>
      <span class="sr-only" aria-live="polite">{announcer()}</span>
    </MasterDetail>
      <dialog
        ref={newDialog}
        id="thread-new-dialog"
        class="dialog-content"
        aria-labelledby="thread-new-title"
        aria-busy={newBusy()}
        onCancel={event => { event.preventDefault(); returnToThreads(); }}
        onClose={handleNewThreadClose}
        onKeyDown={trapNewThreadTab}
      >
        <form onSubmit={event => { event.preventDefault(); createNewThread(); }}>
          <h2 id="thread-new-title">Start conversation</h2>
          <p>Choose where the thread runs. Its title comes from your first message.</p>
          <span class="sr-only" role="status" aria-live="polite">{newBusy() ? 'Creating the conversation' : ''}</span>
          <Show when={newEnabled()} fallback={
            <>
              <div class="ds-callout error" role="alert"><div><strong>Starting a conversation is unavailable</strong><p>{newThreadUnavailableReason()}</p></div></div>
              <div class="actions"><button ref={element => (newReturnEl = element)} type="button" class="ds-btn" onClick={returnToThreads}>Return to threads</button></div>
            </>
          }>
            <div class="field thread-new-field">
              <label for="thread-new-target">Runs in</label>
              <select id="thread-new-target" class="ds-input" ref={element => (newSelectEl = element)} value={newTarget()} disabled={newBusy()} onInput={event => { const value = event.currentTarget.value; setNewTarget(value); setNewThreadDraft(wsId(), { text: newText(), target: value || null }); }}>
                <For each={repositories()}>{r => <option value={r.id}>{r.id}{r.status && r.status !== 'ok' ? ` (${r.status})` : ''}{r.worktrees?.length ? ` · ${r.worktrees.length} worktree${r.worktrees.length === 1 ? '' : 's'}` : ''}</option>}</For>
                <option value="">Whole workspace</option>
              </select>
              <small>Workspace: {workspaceName()}</small>
            </div>
            <div id="thread-new-fields" class="thread-new-fields"><Show when={newText()}><div class="thread-new-prepared"><p class="small muted">Prepared message · unsent. It opens in the composer after creation.</p><p class="thread-text">{newText()}</p></div></Show></div>
            <Show when={newError()}><div class="ds-callout error" role="alert"><div><strong>Creation could not be confirmed</strong><p>{newError()}</p><p class="small muted">Check the thread list before creating another thread; retrying could duplicate the conversation.</p></div></div></Show>
            <div class="actions">
              <button ref={element => (newReturnEl = element)} type="button" class="ds-btn" onClick={returnToThreads}>Return to threads</button>
              <Show when={!newError()} fallback={<button type="button" class="ds-btn ds-btn--primary" onClick={() => void loadList()}>Refresh threads</button>}>
                <button id="thread-create" type="submit" class="ds-btn ds-btn--primary" data-thread-create disabled={newBusy()}>{newBusy() ? 'Creating thread…' : 'Create thread'}</button>
              </Show>
            </div>
          </Show>
        </form>
      </dialog>
    </>
  );
}
