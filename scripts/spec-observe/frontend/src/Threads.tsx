import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { getJson, postJson, HttpError } from './api';
import { str, time, statusMarkdown } from './format';
import BriefComposer from './BriefComposer';
import { identities, type BriefReference, type InputPreview } from './composerTypes';

type Repo = { id: string; status?: string; worktrees?: Array<{ id?: string; path?: string; name?: string }> };
type Thread = Record<string, any> & { thread_id: string; title?: string; queue?: any[] };
type Entry = Record<string, any> & { id: string };
type Preview = { requestId: string; assignmentId: string; record: Record<string, any> | null; digest: string; input?: InputPreview };
type Result = { assignment: Record<string, any> | null; observation: Record<string, any> | null };
type Props = { workspaceId: string; repositories: Repo[]; token?: string; live: boolean; refreshKey?: number };
const LIMIT = 100;
// The saved brief is attached to the assignment as its snapshot; the request text only points at it.
const BRIEF_INSTRUCTION = 'Perform the attached assignment brief.';
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
const briefSig = (title: string, content: string, refs: BriefReference[] = []) => JSON.stringify([title, content, identities(refs)]);

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
  const [briefTitle, setBriefTitle] = createSignal('');
  const [briefContent, setBriefContent] = createSignal('');
  const [briefReferences, setBriefReferences] = createSignal<BriefReference[]>([]);
  const [savedReferences, setSavedReferences] = createSignal<BriefReference[]>([]);
  const [savedTitle, setSavedTitle] = createSignal<string | null>(null);
  const [savedContent, setSavedContent] = createSignal<string | null>(null);
  const [briefRequestId, setBriefRequestId] = createSignal<string | null>(null);
  const [briefPending, setBriefPending] = createSignal<{ id: string; signature: string } | null>(null);
  const [assignmentId, setAssignmentId] = createSignal('');
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [previewStale, setPreviewStale] = createSignal(false);
  const [result, setResult] = createSignal<Result | null>(null);
  const [handoffError, setHandoffError] = createSignal('');
  const [sendPending, setSendPending] = createSignal<{ id: string; draft: string } | null>(null);
  let source: EventSource | undefined;
  let listGeneration = 0;
  let selectionGeneration = 0;
  let historyGeneration = 0;
  let opGeneration = 0;
  let createGeneration = 0;
  let listBusy = false;
  let lastWorkspace = props.workspaceId;
  let stickBottom = true;
  let draftEl: HTMLTextAreaElement | undefined;
  let transcriptEl: HTMLDivElement | undefined;
  let titleEl: HTMLInputElement | undefined;
  const [announcer, setAnnouncer] = createSignal('');
  const active = () => props.live && Boolean(props.workspaceId);
  const actionable = () => active() && Boolean(props.token);
  const thread = () => threads()?.find(t => t.thread_id === selected());
  const dirty = () => savedContent() !== null && briefSig(briefTitle(), briefContent(), briefReferences()) !== briefSig(savedTitle() ?? '', savedContent() ?? '', savedReferences());
  const announce = (value: string) => setAnnouncer(value);
  const handoffStatus = () => {
    if (pending() === 'brief') return 'Saving brief… The assignment has not started.';
    if (pending() === 'preview') return 'Preparing assignment preview… The assignment has not started.';
    if (pending() === 'launch') return 'Starting assignment… Waiting for launch confirmation.';
    if (result()) return result()?.assignment?.state === 'live'
      ? 'Assignment started. Review the launch details below.'
      : 'Assignment start is not confirmed. Review the attention details below.';
    if (dirty()) return 'The editor has unsaved changes. Save the brief again before previewing or launching.';
    if (previewStale()) return 'Assignment has not started. Preview again to review the changed inputs.';
    if (preview()) return 'Assignment has not started. Review the details below, then choose Launch assignment.';
    if (briefRequestId()) return 'Brief saved. Assignment has not started. Choose Preview assignment, then Launch assignment.';
    return 'Save a brief, preview its inputs, then launch the assignment. Enter saves only.';
  };
  const focusHandoff = (id: string) => queueMicrotask(() => {
    const el = document.getElementById(id);
    el?.focus({ preventScroll: true }); el?.scrollIntoView({ block: 'nearest' });
  });
  const resetHandoff = () => { setBriefTitle(''); setBriefContent(''); setBriefReferences([]); setSavedReferences([]); if (titleEl) titleEl.value = ''; setSavedTitle(null); setSavedContent(null); setBriefRequestId(null); setBriefPending(null); setAssignmentId(''); setPreview(null); setPreviewStale(false); setResult(null); setHandoffError(''); };
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
      if (!rows.some((t: Thread) => t.thread_id === selected())) {
        const next = rows[0]?.thread_id || '';
        setSelected(next); setDraft(''); setSendPending(null); resetSelection(); resetHandoff();
        if (next) { void loadHistory(); openEvents(); }
      }
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
    setSelected(id); setDraft(''); setSendPending(null); resetHandoff(); resetSelection(); void loadHistory(); openEvents();
  }
  async function action<T>(path: string, body: unknown, op: string): Promise<T> {
    const workspace = props.workspaceId, id = selected(), selection = selectionGeneration, generation = ++opGeneration;
    setPending(op); setRequestError(''); setHandoffError('');
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
      setThreads(prev => [record, ...(prev || []).filter(t => t.thread_id !== record.thread_id)]); setSelected(record.thread_id); setTarget(''); setDraft(''); setSendPending(null); resetHandoff(); resetSelection(); void loadHistory(); openEvents(); announce('Thread created. It is named after your first message.'); void loadList();
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
  async function saveBrief() {
    if (!actionable() || pending() || !briefTitle().trim()) return;
    if (briefRequestId() && !dirty()) {
      focusHandoff(result() ? 'thread-result' : preview() && !previewStale() ? 'thread-assignment-launch' : 'thread-brief-preview');
      return;
    }
    setHandoffError('');
    const title = briefTitle(), content = briefContent(), references = briefReferences(), signature = briefSig(title, content, references);
    let identity = briefPending(); if (!identity || identity.signature !== signature) { identity = { id: uuid(), signature }; setBriefPending(identity); }
    const id = selected(), workspace = props.workspaceId, selection = selectionGeneration;
    try {
      const data: any = await action('/api/thread/save-brief', { workspace_id: workspace, thread_id: id, request_id: identity.id, title: title.trim(), content, references: identities(references) }, 'brief');
      if (id !== selected() || workspace !== props.workspaceId || selection !== selectionGeneration) return;
      setBriefRequestId(identity.id); setBriefPending(null); setSavedTitle(title.trim()); setSavedContent(content); setSavedReferences(references); if (briefTitle() === title) setBriefTitle(title.trim()); setPreview(null); setPreviewStale(false); setResult(null); setAssignmentId(''); announce(data.duplicate ? 'Brief was already saved with this request.' : 'Brief saved. Preview the assignment before launching.'); void loadList();
      if (!dirty()) focusHandoff('thread-brief-preview');
    } catch (e) { if (id === selected() && selection === selectionGeneration) setHandoffError(routeError(e)); }
  }
  async function previewAssignment() {
    if (!actionable() || pending()) return;
    if (dirty()) return;
    setHandoffError('');
    const req = briefRequestId();
    if (!req || savedContent() === null) { setHandoffError('Save the brief before previewing the assignment.'); return; }
    if (!assignmentId()) setAssignmentId(uuid());
    const assignment = assignmentId() || crypto.randomUUID(), id = selected(), workspace = props.workspaceId, selection = selectionGeneration;
    try {
      const data: any = await action('/api/thread/preview-assignment', { workspace_id: workspace, thread_id: id, request_id: req, assignment_id: assignment, instructions: BRIEF_INSTRUCTION }, 'preview');
      if (id !== selected() || workspace !== props.workspaceId || selection !== selectionGeneration) return;
      setPreview({ requestId: req, assignmentId: assignment, record: data?.record && typeof data.record === 'object' ? data.record : null, digest: str(data?.contractDigest || ''), input: data?.inputPreview }); setPreviewStale(false); setResult(null); announce('Assignment preview ready. Review the details, then launch the assignment.');
      if (!dirty()) focusHandoff('thread-assignment-launch');
    } catch (e) { if (id === selected() && selection === selectionGeneration) setHandoffError(routeError(e)); }
  }
  async function launchAssignment() {
    const p = preview();
    if (!actionable() || pending() || dirty()) return;
    if (!p?.digest || previewStale() || savedContent() === null) { setHandoffError('Preview the assignment before launching.'); return; }
    const id = selected(), workspace = props.workspaceId, selection = selectionGeneration;
    try {
      const data: any = await action('/api/thread/launch-assignment', { workspace_id: workspace, thread_id: id, request_id: p.requestId, assignment_id: p.assignmentId, instructions: BRIEF_INSTRUCTION, expectedDigest: p.digest }, 'launch');
      if (id !== selected() || workspace !== props.workspaceId || selection !== selectionGeneration) return;
      setResult({ assignment: data?.assignment && typeof data.assignment === 'object' ? data.assignment : null, observation: data?.observation && typeof data.observation === 'object' ? data.observation : null }); setHandoffError(''); announce(data?.assignment?.state === 'live' ? 'Assignment launched.' : 'Assignment launch is not confirmed live; review the result card.'); void loadList(); focusHandoff('thread-result');
    } catch (e) {
      if (id !== selected() || selection !== selectionGeneration) return;
      if (e instanceof HttpError && e.status === 409) { setPreviewStale(true); setHandoffError(`${e.message} The reviewed contract may have changed; preview the assignment again before launching.`); }
      else setHandoffError(routeError(e));
    }
  }
  function discussResult() {
    const a = result()?.assignment; if (!a) return;
    const attention = Array.isArray(a.attention) ? a.attention.filter(Boolean) : [];
    const text = `Discuss assignment ${str(a.assignment_id || '')} (state ${str(a.state || 'unknown')}${attention.length ? `, attention ${attention.join(', ')}` : ''}). Summarize the result and recommend the next step.`;
    setDraft(text); if (draftEl) draftEl.value = text;
    announce('Result summary placed in the composer. Nothing is sent until you press Send.');
    queueMicrotask(() => draftEl?.focus());
  }
  onMount(() => { void loadList(); const timer = window.setInterval(() => { void loadList(); }, 5000); onCleanup(() => { clearInterval(timer); listGeneration++; selectionGeneration++; historyGeneration++; closeSource(); }); });
  createEffect(() => {
    const workspace = props.workspaceId;
    props.live; props.refreshKey;
    if (workspace !== lastWorkspace) {
      lastWorkspace = workspace; listGeneration++; createGeneration++; listBusy = false; setThreads(null); setSelected(''); resetSelection(); resetHandoff(); setDraft(''); setSendPending(null); setCreating(false); setCreateError('');
    }
    if (active()) void loadList(); else { listGeneration++; createGeneration++; listBusy = false; setThreads(null); setSelected(''); resetSelection(); setCreating(false); setCreateError(''); }
  });
  createEffect(() => { const value = draft(); if (draftEl && draftEl.value !== value) draftEl.value = value; });
  createEffect(() => { const value = briefTitle(); if (titleEl && titleEl.value !== value) titleEl.value = value; });
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
              <Show when={thread()} fallback={<div class="empty"><p class="small muted">Select a thread to read its transcript and compose a message.</p></div>}>
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
                <Show when={active()}><section class="thread-handoff" aria-labelledby="thread-handoff-heading"><div class="section-head"><h5 id="thread-handoff-heading">Brief and assignment</h5><span class="small muted">Save → Preview → Launch</span></div>
                  <div class="thread-field"><label for="thread-brief-title">Brief title</label><input id="thread-brief-title" type="text" maxlength="200" placeholder="Short assignment title." ref={titleEl} onInput={e => setBriefTitle(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveBrief(); } }} /></div>
                  <div class="thread-field"><label for="thread-brief-content">Brief content</label><BriefComposer id="thread-brief-content" value={briefContent()} references={briefReferences()} workspaceId={props.workspaceId} threadId={selected()} enabled={actionable()} onChange={setBriefContent} onReferencesChange={setBriefReferences} onSave={() => void saveBrief()} /></div>
                  <p class="small muted">Enter saves only · Shift+Enter adds a newline. Use Preview assignment and Launch assignment to start work.</p>
                  <div id="thread-handoff-status" class="thread-state" role="status"><p>{handoffStatus()}</p></div>
                  <Show when={briefRequestId()}><p class="small muted" role="status">Saved brief {briefRequestId()!.slice(0, 8)}{dirty() ? ' · the editor has unsaved changes; preview uses the saved brief.' : ''}</p></Show>
                  <div class="thread-actions"><button id="thread-brief-save" class={!briefRequestId() || dirty() ? "primary" : ""} data-thread-brief-save disabled={!actionable() || !!pending() || !briefTitle().trim() || (!!briefRequestId() && !dirty())} onClick={() => void saveBrief()}>{pending() === 'brief' ? 'Saving brief…' : 'Save brief'}</button><button id="thread-brief-preview" class={briefRequestId() && !dirty() && (!preview() || previewStale()) && !result() ? "primary" : ""} data-thread-preview disabled={!actionable() || !!pending() || !briefRequestId() || dirty()} onClick={() => void previewAssignment()}>{pending() === 'preview' ? 'Previewing…' : 'Preview assignment'}</button></div>
                  <Show when={handoffError()}><div class="thread-state bad" role="alert"><p>{handoffError()}</p><button onClick={() => { setHandoffError(''); if (previewStale()) void previewAssignment(); else titleEl?.focus(); }}>Retry brief editor</button></div></Show>
                  <Show when={preview()} keyed>{p => { const rec = p.record || {}; const facts: [string, string][] = [['Target', str(rec.repository_id || rec.target?.kind || '') || 'workspace'], ['Execution directory', str(rec.execution_dir || '')], ['Brief', str(rec.brief || '')], ['Model', str(rec.model || '') || 'Pi default'], ['Assignment', str(rec.assignment_id || p.assignmentId)], ['Contract digest', p.digest]]; return <div class="thread-preview" id="thread-preview"><div class="section-head"><h6>Assignment preview</h6><span class={`pill ${previewStale() ? 'warn' : 'good'}`}>{previewStale() ? 'Re-preview required' : 'Reviewed'}</span></div><dl class="thread-facts"><For each={facts}>{f => <div><dt>{f[0]}</dt><dd class="mono">{f[1]}</dd></div>}</For></dl><Show when={p.input}><div class="assignment-input"><h6>What Pi will receive</h6><p class="small muted">The saved brief and selected contents below are captured together. Changed source contents require a new preview before launch.</p><For each={p.input?.references || []}>{ref => <details><summary>{ref.kind === 'skill' ? 'Skill' : 'File'}: {ref.label} · {ref.source}</summary><p class="small mono">{ref.path}</p><p class="small mono">SHA-256 {ref.sha256}</p><pre>{ref.content}</pre></details>}</For><details><summary>Complete brief and context</summary><pre>{p.input?.brief}</pre></details><details><summary>Assignment instructions</summary><pre>{p.input?.instruction}</pre></details></div></Show><Show when={previewStale()}><p class="small warn" role="status">The resolved contract changed after this preview. Preview again before launching; the launch control stays disabled until then.</p></Show><div class="thread-actions"><button id="thread-assignment-launch" class={!dirty() && !previewStale() && !result() ? "primary" : ""} data-thread-launch disabled={!actionable() || !!pending() || previewStale() || dirty() || !!result()} onClick={() => void launchAssignment()}>{pending() === 'launch' ? 'Launching…' : 'Launch assignment'}</button></div><p class="small muted">Launching starts the assignment in its own tmux session. It never sends a thread message.</p></div>; }}</Show>
                  <Show when={result()} keyed>{r => { const a = r.assignment || {}, o = r.observation || {}, s = str(a.state || o.state || 'unknown'), attention = [...(Array.isArray(a.attention) ? a.attention : []), ...(Array.isArray(o.attention) ? o.attention : [])].filter(Boolean), id = str(a.assignment_id || ''), anchor = `thread-assignment-${id}`; return <div class="thread-result" id="thread-result" tabindex="-1"><div class="section-head"><h6>Assignment result</h6><span class={`pill ${s === 'live' ? 'good' : 'warn'}`}>{s === 'live' ? 'Live' : 'Not confirmed live'}</span></div><p class="small">Assignment <a id="thread-assignment-link" class="mono" href={`#${anchor}`}>{id}</a> is recorded read-only; this page never fetches it automatically.</p><div id={anchor}><p class="small muted">State: {s}{typeof a.tmux_session === 'string' ? ` · tmux session ${a.tmux_session}` : ''}</p><Show when={attention.length}><p class="small warn">Attention: {attention.join(', ')}</p></Show></div><div class="thread-actions"><button id="thread-discuss-result" data-thread-discuss onClick={discussResult}>Discuss result</button></div><p class="small muted">Discuss result only fills the composer. Review the text, then press Send; nothing is sent or launched automatically.</p></div>; }}</Show>
                </section></Show>
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
