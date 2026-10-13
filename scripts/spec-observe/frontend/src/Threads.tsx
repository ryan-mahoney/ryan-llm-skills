import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { getJson, postJson, HttpError } from './api';
import { str, time, statusMarkdown } from './format';
import { consumeThreadDraft, seedThreadDraft } from './launch-state';
import { resolveThreadListSelection } from './threads-selection';
import type { ThreadDraftSeed } from './launch-state';
import type { RouteState } from './route';

// launch-state.ts remains the single owner of the one-use result-draft Map;
// this surface re-exports its seed contract instead of copying the store.
export { seedThreadDraft };

type Repo = { id: string; status?: string; worktrees?: Array<{ id?: string; path?: string; name?: string }> };
type Thread = Record<string, any> & { thread_id: string; title?: string; queue?: any[] };
type Entry = Record<string, any> & { id: string };
type Props = { workspaceId: string; repositories: Repo[]; token?: string; live: boolean; refreshKey?: number; requestedThreadId?: string; onNavigate?: (next: RouteState) => void };
const LIMIT = 100;
const labels: Record<string, string> = { active: 'Responding', idle: 'Ready', paused: 'Paused', 'history-only': 'History only', uncertain: 'Delivery uncertain', stalled: 'Stalled', 'start-failed': 'Start failed', 'session-mismatch': 'Session mismatch', 'missing-directory': 'Directory missing', 'live-owner': 'Owner not confirmed dead', 'missing-context': 'Context missing', 'policy-refusal': 'Policy refusal' };
const tones: Record<string, string> = { active: 'good', idle: 'good', paused: 'warn', stalled: 'warn', 'history-only': 'muted', uncertain: 'bad', 'start-failed': 'bad', 'session-mismatch': 'bad', 'missing-directory': 'bad', 'live-owner': 'bad', 'missing-context': 'bad', 'policy-refusal': 'bad' };
const uuid = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
const contentText = (content: any): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: any) => typeof p === 'string' ? p : p?.text || (['toolCall', 'tool_use'].includes(p?.type) ? `[tool ${p.name || p.toolName || 'call'}]` : p?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n') : content == null ? '' : str(content);
const roleOf = (e: Entry) => { const m = e?.message && typeof e.message === 'object' ? e.message : e; return str(m?.role || e?.role || ''); };
const textOf = (e: Entry) => { const m = e?.message && typeof e.message === 'object' ? e.message : e; return contentText(m?.content ?? m?.text ?? e?.content ?? ''); };
const derived = (t?: Thread) => {
  if (!t) return 'unknown';
  if (t.history_only) return 'history-only';
  if (t.queue_paused) return 'paused';
  const attention = typeof t.attention === 'string' ? t.attention : t.attention && typeof t.attention === 'object' ? str(t.attention.kind || '') : '';
  return attention || (t.state === 'active' ? 'active' : 'idle');
};
const label = (s: string) => labels[s] || (s && s !== 'unknown' ? str(s) : 'Unknown');
const tone = (s: string) => tones[s] || 'muted';

export default function Threads(props: Props) {
  const [threads, setThreads] = createSignal<Thread[] | null>(null);
  const [invalid, setInvalid] = createSignal<any[]>([]);
  const [selected, setSelected] = createSignal('');
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [older, setOlder] = createSignal(false);
  const [loadingHistory, setLoadingHistory] = createSignal(false);
  const [incompleteTail, setIncompleteTail] = createSignal(false);
  const [partial, setPartial] = createSignal('');
  const [toolNote, setToolNote] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [stream, setStream] = createSignal('unavailable');
  const [listError, setListError] = createSignal('');
  const [requestError, setRequestError] = createSignal('');
  const [pending, setPending] = createSignal('');
  const [draft, setDraft] = createSignal('');
  const [target, setTarget] = createSignal('');
  const [creating, setCreating] = createSignal(false);
  const [createError, setCreateError] = createSignal('');
  const [requestedMissing, setRequestedMissing] = createSignal(false);
  const [sendPending, setSendPending] = createSignal<{ id: string; draft: string } | null>(null);
  let source: EventSource | undefined;
  let listGeneration = 0;
  let selectionGeneration = 0;
  let historyGeneration = 0;
  let opGeneration = 0;
  let createGeneration = 0;
  let listBusy = false;
  let lastWorkspace = props.workspaceId;
  // Route identity already applied by loadList. The requested thread is
  // selected once per identity transition; steady refreshes retain whatever
  // the operator explicitly selected (F1). A new identity invalidates the
  // previous selection/history/event source before resolving (F2).
  let appliedRequested = '';
  let stickBottom = true;
  let draftEl: HTMLTextAreaElement | undefined;
  let transcriptEl: HTMLDivElement | undefined;
  const [announcer, setAnnouncer] = createSignal('');
  const active = () => props.live && Boolean(props.workspaceId);
  const actionable = () => active() && Boolean(props.token);
  const thread = () => threads()?.find(t => t.thread_id === selected());
  const announce = (value: string) => setAnnouncer(value);
  // The one-use result-draft seed is consumed only when the selected thread is
  // the exact requested thread: a thread switch or remount cannot replay it,
  // and a missing requested thread never seeds an unrelated fallback selection.
  const consumeRequestedSeed = (id: string) => {
    if (!id || id !== props.requestedThreadId) return;
    const seed: ThreadDraftSeed | undefined = consumeThreadDraft(props.workspaceId, id);
    if (!seed) return;
    setDraft(seed.draft);
    announce('Result draft prepared. Review the message before sending.');
    queueMicrotask(() => { if (draftEl) { draftEl.value = seed.draft; draftEl.focus({ preventScroll: true }); } });
  };
  const resetSelection = () => { selectionGeneration++; historyGeneration++; closeSource(); setEntries([]); setOlder(false); setLoadingHistory(false); setIncompleteTail(false); setPartial(''); setToolNote(''); setNotice(''); setRequestError(''); setPending(''); stickBottom = true; };
  function closeSource() { source?.close(); source = undefined; setStream('unavailable'); }
  function params(extra: Record<string, string> = {}) { return new URLSearchParams({ workspace_id: props.workspaceId, ...extra }); }
  const routeError = (e: unknown) => e instanceof HttpError ? e.message : e instanceof Error ? e.message : 'The thread request could not be completed.';
  async function loadList() {
    if (!active() || listBusy) return;
    listBusy = true;
    const request = ++listGeneration, workspace = props.workspaceId;
    try {
      const data: any = await getJson(`/api/threads?${params()}`);
      if (request !== listGeneration || workspace !== props.workspaceId) return;
      const rows = Array.isArray(data) ? data : Array.isArray(data.threads) ? data.threads : [];
      setThreads(rows); setInvalid(Array.isArray(data.invalid) ? data.invalid : []); setListError('');
      const requested = typeof props.requestedThreadId === 'string' && props.requestedThreadId ? props.requestedThreadId : '';
      // Pure selection contract: steady refreshes retain an explicit row /
      // create selection with its typed draft and send retry identity (F1);
      // a new requested identity invalidates the old thread first so a
      // missing UUID leaves no unrelated detail or controls (F2).
      const decision = resolveThreadListSelection({ rows, requested, appliedRequested, selected: selected() });
      appliedRequested = decision.appliedRequested;
      setRequestedMissing(decision.requestedMissing);
      if (decision.invalidated) { setSelected(''); setDraft(''); setSendPending(null); resetSelection(); }
      if (decision.shouldSelect && decision.nextSelected) {
        if (selected() !== decision.nextSelected) setSelected(decision.nextSelected);
        if (!decision.invalidated) { setDraft(''); setSendPending(null); resetSelection(); }
        void loadHistory(); openEvents();
      } else if (selected() !== decision.nextSelected) {
        setSelected(decision.nextSelected);
        if (decision.nextSelected) { setDraft(''); setSendPending(null); resetSelection(); void loadHistory(); openEvents(); }
      }
      // The one-use result seed applies only to the exactly selected
      // requested thread; a retained explicit selection is never reseeded.
      if (decision.nextSelected && selected() === requested) consumeRequestedSeed(requested);
    } catch (e) {
      if (request === listGeneration && workspace === props.workspaceId) setListError(routeError(e) || 'Threads could not be loaded.');
    } finally { if (request === listGeneration) listBusy = false; }
  }
  async function loadHistory(before?: string, prepend = false) {
    if (!active() || !selected()) return;
    const request = ++historyGeneration, selection = selectionGeneration, id = selected(), workspace = props.workspaceId;
    const oldTop = transcriptEl?.scrollTop || 0, oldHeight = transcriptEl?.scrollHeight || 0;
    setLoadingHistory(true); if (!prepend) setRequestError('');
    try {
      const q: Record<string, string> = { thread_id: id, limit: String(LIMIT) }; if (before) q.before = before;
      const data: any = await getJson(`/api/thread/history?${params(q)}`);
      if (request !== historyGeneration || selection !== selectionGeneration || id !== selected() || workspace !== props.workspaceId) return;
      const page = Array.isArray(data.entries) ? data.entries : [];
      setEntries(prev => prepend ? [...page, ...prev] : page);
      setOlder(data.truncated === true); setIncompleteTail(data.incomplete_tail === true); setLoadingHistory(false); setRequestError(''); stickBottom = !prepend;
      if (prepend) queueMicrotask(() => { if (transcriptEl) transcriptEl.scrollTop = oldTop + transcriptEl.scrollHeight - oldHeight; });
    } catch (e) {
      if (request === historyGeneration && selection === selectionGeneration && id === selected()) { setLoadingHistory(false); setRequestError(routeError(e) || 'The transcript could not be loaded.'); }
    }
  }
  async function refreshTail() {
    const id = selected(), workspace = props.workspaceId, selection = selectionGeneration;
    if (!active() || !id) return;
    try {
      const data: any = await getJson(`/api/thread/history?${params({ thread_id: id, limit: String(LIMIT) })}`);
      if (selection !== selectionGeneration || id !== selected() || workspace !== props.workspaceId) return;
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
    if (!active() || !selected() || typeof EventSource === 'undefined') return;
    const id = selected(), workspace = props.workspaceId, generation = selectionGeneration;
    const es = new EventSource(`/api/thread/events?${params({ thread_id: id })}`); source = es; setStream('connecting');
    const current = () => source === es && generation === selectionGeneration && selected() === id && props.workspaceId === workspace;
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
        if (type === 'delta') { const d = typeof ev.delta === 'string' ? ev.delta : ev.assistantMessageEvent?.delta || ''; if (d) { setPartial(v => v + d); stickBottom = true; } }
        if (type === 'tool') setToolNote(`Running tool: ${ev.toolName || ev.tool || ev.name || 'activity'}`);
        if (type === 'message_end') { const val = contentText(ev.message?.content ?? ev.message?.text ?? ev.content ?? ev.text ?? ''); if (val) setPartial(val); setToolNote(''); setTimeout(() => { if (current()) void refreshTail(); }, 400); }
        if (type === 'state') updateSelected({ ...ev, queue: ev.queue ?? data.queue, attention: ev.attention ?? data.attention, queue_paused: ev.queue_paused });
        if (type === 'notice') { const msg = str(ev.message || ev.error || ev.attention || data.attention || 'Thread notice'); setNotice(msg); announce(`Thread notice: ${msg}`); void loadList(); }
        if (type === 'settled') { setToolNote(''); announce('Response settled; the next waiting message can deliver.'); void refreshTail(); void loadList(); }
      }
    });
  }
  function updateSelected(patch: any) {
    setThreads(prev => prev?.map(t => t.thread_id !== selected() ? t : ({ ...t, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) })) || null);
  }
  function selectThread(id: string) {
    if (!id || id === selected()) return;
    setSelected(id); setDraft(''); setSendPending(null); resetSelection(); void loadHistory(); openEvents(); consumeRequestedSeed(id);
  }
  async function action<T>(path: string, body: unknown, op: string): Promise<T> {
    const workspace = props.workspaceId, id = selected(), selection = selectionGeneration, generation = ++opGeneration;
    setPending(op); setRequestError('');
    try { return await postJson<T>(path, body, props.token || '', undefined); }
    finally { if (generation === opGeneration && workspace === props.workspaceId && id === selected() && selection === selectionGeneration) setPending(''); }
  }
  async function createThread() {
    if (!actionable() || creating()) return;
    const workspace = props.workspaceId, request = ++createGeneration;
    const dest = target() ? { kind: 'repository', repository_id: target() } : { kind: 'workspace' };
    setCreating(true); setCreateError('');
    try {
      const record = await postJson<Thread>('/api/thread/create', { workspace_id: workspace, target: dest }, props.token || '');
      if (workspace !== props.workspaceId || request !== createGeneration) return;
      setThreads(prev => [record, ...(prev || []).filter(t => t.thread_id !== record.thread_id)]); setSelected(record.thread_id); setTarget(''); setDraft(''); setSendPending(null); resetSelection(); void loadHistory(); openEvents(); announce('Thread created. It is named after your first message.'); void loadList();
    } catch (e) { if (workspace === props.workspaceId && request === createGeneration) setCreateError(routeError(e)); }
    finally { if (workspace === props.workspaceId && request === createGeneration) setCreating(false); }
  }
  async function send() {
    if (!actionable() || !selected() || !draft().trim() || pending()) return;
    const submitted = draft(); let retry = sendPending();
    if (!retry || retry.draft !== submitted) { retry = { id: uuid(), draft: submitted }; setSendPending(retry); }
    const req = retry; const workspace = props.workspaceId, id = selected(), selection = selectionGeneration;
    try {
      const data: any = await action('/api/thread/send', { workspace_id: workspace, thread_id: id, id: req.id, text: submitted.trim() }, 'send');
      if (workspace !== props.workspaceId || id !== selected() || selection !== selectionGeneration) { void loadList(); return; }
      if (sendPending()?.id === req.id) setSendPending(null);
      if (draft() === submitted) { setDraft(''); if (draftEl) draftEl.value = ''; }
      setRequestError(data.state === 'uncertain' ? 'The message may already have been delivered. Discard it or retry under Pending messages; a retry can duplicate the response.' : '');
      announce(data.duplicate ? 'Message was already queued.' : data.state === 'accepted' ? 'Message accepted.' : data.state === 'uncertain' ? 'Message delivery is uncertain.' : 'Message queued.');
      void loadList(); setTimeout(() => { if (id === selected() && selection === selectionGeneration) void refreshTail(); }, 0);
    } catch (e) { if (workspace === props.workspaceId && id === selected() && selection === selectionGeneration) setRequestError(routeError(e)); }
  }
  async function simpleAction(path: string, op: string, body: any = {}) {
    if (!actionable() || !selected()) return;
    const id = selected(), workspace = props.workspaceId, selection = selectionGeneration;
    try { await action(path, { workspace_id: workspace, thread_id: id, ...body }, op); if (id === selected() && workspace === props.workspaceId && selection === selectionGeneration) { announce(op === 'stop' ? 'Stop requested. The thread queue is paused.' : op === 'resume' ? 'Thread resumed.' : body.resend ? 'Message queued again. A duplicate response is possible.' : 'Uncertain message discarded.'); void loadList(); if (op === 'resume') void refreshTail(); } }
    catch (e) { if (id === selected() && selection === selectionGeneration) setRequestError(routeError(e)); }
  }
  // Prepare assignment hands the exact thread identity to the hidden launch
  // flow. A repository target recorded on the thread rides along as the
  // requested target; worktree threads carry no route target and stay
  // server-bound. The server remains authoritative for binding the target at
  // review, so no client-side target is invented here.
  function prepareAssignment() {
    const id = selected();
    if (!id) return;
    const target = thread()?.target;
    const repositoryId = target && target.kind === 'repository' && typeof target.repository_id === 'string' && target.repository_id ? target.repository_id : '';
    props.onNavigate?.({ dest: 'launch', ws: props.workspaceId, thread: id, ...(repositoryId ? { target: repositoryId } : {}), tab: 'brief' });
    announce('Opening the launch brief for this thread.');
  }
  onMount(() => { void loadList(); const timer = window.setInterval(() => { void loadList(); }, 5000); onCleanup(() => { clearInterval(timer); listGeneration++; selectionGeneration++; historyGeneration++; closeSource(); }); });
  createEffect(() => {
    const workspace = props.workspaceId;
    props.live; props.refreshKey; props.requestedThreadId;
    if (workspace !== lastWorkspace) {
      lastWorkspace = workspace; listGeneration++; createGeneration++; listBusy = false; appliedRequested = ''; setThreads(null); setSelected(''); resetSelection(); setRequestedMissing(false); setDraft(''); setSendPending(null); setCreating(false); setCreateError('');
    }
    if (active()) void loadList(); else { listGeneration++; createGeneration++; listBusy = false; setThreads(null); setSelected(''); resetSelection(); setCreating(false); setCreateError(''); }
  });
  createEffect(() => { const value = draft(); if (draftEl && draftEl.value !== value) draftEl.value = value; });
  createEffect(() => {
    entries(); partial(); toolNote();
    if (stickBottom && transcriptEl) queueMicrotask(() => { if (stickBottom && transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight; });
  });

  const state = () => derived(thread());
  const help = () => ({ active: ['Responding', 'A response is being delivered to the head message. Stop pauses this queue first; the response slot is released only after confirmed idle or process death.', 'good'], paused: ['Queue paused', 'Pending messages wait until Resume. Resume unpauses after identity and context checks; delivery continues in FIFO order.', 'warn'], 'history-only': ['History only', 'This record was imported without an owned process. Browsing works; send and resume are unavailable.', 'muted'], uncertain: ['Delivery uncertain', 'A message was persisted before its acknowledgement was lost, so it may or may not have been delivered. Discard or retry under Pending messages; a retry may duplicate the response.', 'bad'], stalled: ['Stalled', 'No child events for ten minutes. The response may still be running; nothing is released automatically. Refresh to check again, or Stop if the thread still owns the slot.', 'warn'], 'start-failed': ['Start failed', 'The discussion process failed before startup completed. Send a new message or Resume to retry the owned session.', 'bad'], 'session-mismatch': ['Session mismatch', 'The stored session file does not match this thread record. Inspect the workspace session copy, then retry.', 'bad'], 'missing-directory': ['Execution directory missing', 'The recorded execution directory is gone. Restore it or update the workspace record, then retry.', 'bad'], 'live-owner': ['Owner not confirmed dead', 'A prior discussion process is still recorded or observed. A second writer fails closed until the owner exits or Stop confirms it idle.', 'bad'], 'missing-context': ['Context missing', 'Threads no longer read earlier kit context files. Resume or send again to start.', 'bad'], 'policy-refusal': ['Policy refusal', 'The installed Pi read-tool policy refused the last request. Review the policy or context, then retry.', 'bad'] } as Record<string, [string, string, string]>)[state()] || ['Ready', '', 'good'] as [string, string, string];

  return <section class="section" id="threads-section" aria-labelledby="threads-heading">
    <div class="section-head"><h3 id="threads-heading">Threads</h3><span class="small muted">Local discussions · one response slot</span></div>
    <Show when={active()} fallback={<div class="empty"><h3>Threads require the live dashboard</h3><p class="small">Open the host dashboard to browse discussions. Imported snapshots and file pages cannot reach discussions.</p></div>}>
      <Show when={listError()&&threads()}><p class="warn" role="status">{listError()} <button onClick={()=>void loadList()}>Retry threads</button></p></Show>
      <Show when={!listError()||threads()!==null} fallback={<div class="empty" role="status"><h3>Threads are unavailable</h3><p class="small">{listError()}</p><button onClick={() => void loadList()}>Retry</button></div>}>
        <Show when={threads()} fallback={<p class="empty">Loading threads…</p>}>
          <div class="thread-new" role="group" aria-label="New thread">
            <div class="thread-field"><label for="thread-new-target">Runs in</label><select id="thread-new-target" value={target()} onInput={e => setTarget(e.currentTarget.value)}><option value="">Whole workspace</option><For each={props.repositories}>{r => <option value={r.id}>{r.id}{r.status && r.status !== 'ok' ? ` (${r.status})` : ''}</option>}</For></select></div>
            <button id="thread-create" data-thread-create disabled={!actionable() || creating()} onClick={() => void createThread()}>{creating() ? 'Creating…' : 'Create thread'}</button>
            <Show when={createError()}><p class="small warn" role="alert">{createError()}</p></Show>
          </div>
          <div class="threads-split">
            <div class="thread-list" role="list" aria-label="Threads">
              <Show when={(threads() || []).length} fallback={<p class="empty">No threads yet. Create one above to discuss work in this workspace.</p>}>
                <For each={threads()}>{t => { const s = derived(t); const q = t.queue || []; const waiting = q.filter((m: any) => m.state === 'queued').length; return <button class="thread-row" data-thread={t.thread_id} aria-pressed={t.thread_id === selected()} onClick={() => selectThread(t.thread_id)}><span class="flex justify-between gap-3"><span class="run-title">{t.title || `Thread ${t.thread_id.slice(0, 8)}`}</span><span class={`pill ${tone(s)}`}>{label(s)}</span></span><span class="small muted">{q.length ? `${waiting ? `${waiting} waiting` : `${q.length} pending`}${t.queue_paused ? ' · paused queue' : ''}` : 'No pending messages'}</span></button>; }}</For>
              </Show>
            </div>
            <div class="thread-detail">
              <Show when={thread()} fallback={<Show when={requestedMissing()} fallback={<div class="empty"><p class="small muted">Select a thread to read its transcript and compose a message.</p></div>}><div class="thread-state bad" id="thread-requested-unavailable" role="status"><p>Requested thread {props.requestedThreadId} is unavailable.</p><p class="small muted">It is not in this workspace's thread list, so nothing was selected, seeded or launched.</p></div></Show>}>
                <div class="thread-head"><div class="section-head"><div><h4>{thread()?.title || `Thread ${selected().slice(0, 8)}`}</h4><p class="small muted mono">{selected()}{thread()?.generation != null ? ` · generation ${thread()?.generation}` : ''}{thread()?.updated_at ? ` · updated ${time(thread()?.updated_at)} ` : ''}</p></div><span class={`pill ${tone(state())}`}>{label(state())}</span></div>
                  <Show when={help()[1]}><div class={`thread-state ${help()[2]}`} role="status"><p><strong>{help()[0]}</strong></p><p class="small">{help()[1]}</p></div></Show>
                  <Show when={requestError()}><div class="thread-state bad" role="alert"><p>{requestError()}</p><button id="thread-error-retry" onClick={() => { setRequestError(''); void loadHistory(); }}>Retry</button></div></Show>
                </div>
                <div class="thread-transcript" role="log" aria-label="Thread transcript" tabindex="0" ref={transcriptEl} onScroll={e => { const el = e.currentTarget; stickBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
                  <Show when={older() && entries().length}><p><button data-thread-older disabled={!!pending()} onClick={() => { const first = entries()[0]?.id; if (first) void loadHistory(first, true); }}>Load older messages</button></p></Show>
                  <Show when={loadingHistory()}><p class="small muted">Loading transcript…</p></Show>
                  <For each={entries()}>{entry => { const role = roleOf(entry), mine = role === 'user', text = textOf(entry); return <div class={`thread-entry ${mine ? 'user' : 'assistant'}`}><p class="small muted">{mine ? 'You' : role === 'assistant' ? 'Pi' : role || 'Entry'}{entry.timestamp && Number.isFinite(Date.parse(entry.timestamp)) ? ` · ${entry.timestamp}` : ''}</p><Show when={mine} fallback={<div class="status-markdown" innerHTML={statusMarkdown(text)} />}><p class="thread-text">{text}</p></Show></div>; }}</For>
                  <Show when={partial()}><div class="thread-entry assistant"><p class="small muted">Pi · responding</p><div class="status-markdown thread-partial" innerHTML={statusMarkdown(partial())} /></div></Show>
                  <Show when={toolNote()}><p class="small muted">{toolNote()}</p></Show>
                  <Show when={!entries().length && !partial() && !toolNote() && !loadingHistory()}><p class="small muted">No messages recorded for this thread yet.</p></Show>
                  <Show when={incompleteTail()}><p class="small warn">The session file ends with an incomplete line; it is excluded from parsed history.</p></Show>
                </div>
                <div id="thread-queue" class="rows" aria-label="Pending messages"><For each={thread()?.queue || []}>{item => { const uncertain = item.state === 'uncertain'; return <div class="info-row"><p><strong>{uncertain ? 'Delivery uncertain' : item.state === 'delivering' ? 'Delivering' : 'Queued'}</strong>{item.queue_position != null ? ` · queue position ${item.queue_position}` : ''}</p><p class="small thread-text">{item.text || ''}</p><Show when={uncertain}><small class="warn">The prompt may or may not have been delivered. Discard removes it; retrying sends it again and may duplicate the response.</small><p class="thread-actions"><button data-thread-discard={item.id} disabled={!actionable() || ['discard', 'resend'].includes(pending())} onClick={() => void simpleAction('/api/thread/discard', 'discard', { id: item.id, resend: false })}>Discard message</button><button data-thread-resend={item.id} disabled={!actionable() || ['discard', 'resend'].includes(pending())} onClick={() => void simpleAction('/api/thread/discard', 'resend', { id: item.id, resend: true })}>Retry as new message</button></p></Show></div>; }}</For></div>
                <Show when={state() === 'history-only'} fallback={<div class="thread-composer"><label for="thread-draft">Message thread</label><textarea id="thread-draft" rows="4" placeholder="Write a message. Enter sends; Shift+Enter adds a newline." ref={draftEl} onInput={e => setDraft(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} /><p class="small muted">Enter sends · Shift+Enter newline. Messages queue in order over the single local response slot.</p><div class="thread-actions"><button id="thread-send" class="primary" data-thread-send disabled={!actionable() || !!pending() || !draft().trim()} onClick={() => void send()}>{pending() === 'send' ? 'Sending…' : 'Send'}</button><Show when={state() === 'active' || thread()?.owns_response}><button id="thread-stop" data-thread-stop disabled={!actionable() || pending() === 'stop'} onClick={() => void simpleAction('/api/thread/stop', 'stop')}>{pending() === 'stop' ? 'Stopping…' : 'Stop'}</button></Show><Show when={state() === 'paused'}><button id="thread-resume" data-thread-resume disabled={!actionable() || pending() === 'resume'} onClick={() => void simpleAction('/api/thread/resume', 'resume')}>{pending() === 'resume' ? 'Resuming…' : 'Resume'}</button></Show><button data-thread-refresh onClick={() => { resetSelection(); void loadHistory(); openEvents(); void loadList(); }}>Refresh thread</button></div></div>}>
                  <div class="thread-state muted" role="status"><p>{state() === 'history-only' ? 'This thread is history only: browsing and reading work, but sending and resuming are unavailable. Source sessions are never modified.' : "Message controls are available on the host's live dashboard."}</p></div>
                </Show>
                <p class="small muted"><span class={`pill ${stream() === 'live' ? 'good' : stream() === 'reconnecting' ? 'warn' : 'muted'}`}>{stream() === 'live' ? 'Live' : stream() === 'connecting' ? 'Connecting live updates…' : stream() === 'reconnecting' ? 'Live updates reconnecting…' : stream() === 'stopped' ? 'Live updates stopped' : 'Live updates unavailable'}</span> · The local stream may stay silent for 15 seconds between keepalives.</p><Show when={notice()}><p class="small muted">{notice()}</p></Show>
                <Show when={active()}><div class="thread-actions" role="group" aria-label="Prepare assignment"><button id="thread-prepare-assignment" data-thread-prepare disabled={!actionable()} onClick={() => prepareAssignment()}>Prepare assignment</button><p class="small muted">Opens the launch brief for this thread. The server binds the worktree target at review; nothing is launched from here.</p></div></Show>
              </Show>
            </div>
          </div>
          <Show when={invalid().length}><div class="info-row"><p><strong>Invalid thread records ({invalid().length})</strong></p><For each={invalid()}>{x => <small class="warn">{x.reason || x.error || x.message || 'Invalid record'}</small>}</For></div></Show>
        </Show>
      </Show>
    </Show>
    <span class="sr-only" aria-live="polite">{announcer()}</span>
  </section>;
}
