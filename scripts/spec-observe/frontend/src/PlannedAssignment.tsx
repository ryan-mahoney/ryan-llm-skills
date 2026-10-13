import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from 'solid-js';
import { getJson, postJson, HttpError } from './api';
import { str } from './format';
import { plannedBriefContent, plannedBriefTitle, plannedTargetChoices, plannedTargetLabel, type PlannedTargetChoice } from './planned-assignment';

type Props = { record: any; live: boolean; token?: string };
type Thread = { thread_id: string; title?: string; history_only?: boolean; target?: { kind?: string; path?: string; repository_id?: string } };
type Preview = { requestId: string; assignmentId: string; digest: string; record: any; input: any; signature: string };
type Result = { assignment: any; observation: any };

const uuid = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
const BRIEF_INSTRUCTION = 'Perform the attached assignment brief.';
const SKILL = 'spec-end-to-end';
const AUTHORITY = 'pr';
const HARNESS = 'pi';
const PROVIDER = 'deepseek';
const MODEL = 'deepseek-flash';
const THINKING = 'high';

function errorText(error: unknown) {
  return error instanceof HttpError || error instanceof Error ? error.message : 'The assignment request could not be completed.';
}

export default function PlannedAssignment(props: Props) {
  const [targetId, setTargetId] = createSignal('');
  const [title, setTitle] = createSignal('');
  const [brief, setBrief] = createSignal('');
  const [threadId, setThreadId] = createSignal('');
  const [saveIdentity, setSaveIdentity] = createSignal<{ signature: string; id: string } | null>(null);
  const [assignmentIdentity, setAssignmentIdentity] = createSignal<{ signature: string; id: string } | null>(null);
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [result, setResult] = createSignal<Result | null>(null);
  const [pending, setPending] = createSignal<'preview' | 'launch' | ''>('');
  const [error, setError] = createSignal('');
  const [status, setStatus] = createSignal('');
  let operation = 0;

  const packageRef = () => str(props.record?.package_ref).trim();
  const workspaceId = () => str(props.record?.workspace).trim();
  const packageKey = createMemo(() => `${workspaceId()}\n${packageRef()}`);
  const targetTopologyKey = createMemo(() => JSON.stringify((Array.isArray(props.record?.targets) ? props.record.targets : [])
    .map((item: any) => [item?.id, item?.primary])
    .sort((a: unknown[], b: unknown[]) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
  const contextKey = createMemo(() => `${packageKey()}\n${targetTopologyKey()}`);
  const choices = createMemo<PlannedTargetChoice[]>(() => {
    targetTopologyKey();
    return plannedTargetChoices(untrack(() => props.record?.targets));
  });
  const target = () => choices().find(item => item.key === targetId()) ?? null;
  const actionable = () => props.live && Boolean(props.token);
  const signature = () => JSON.stringify([contextKey(), targetId(), title().trim(), brief(), PROVIDER, MODEL, THINKING, SKILL, AUTHORITY, HARNESS, BRIEF_INSTRUCTION]);
  const currentPreview = () => {
    const value = preview();
    return value && value.signature === signature() ? value : null;
  };
  const changed = () => Boolean(preview() && !currentPreview());
  const targetProblem = () => {
    if (!Array.isArray(props.record?.targets) || !props.record.targets.length) return 'No target is available for this spec.';
    if (!choices().length) return 'No usable target is available for this spec.';
    if (choices().length > 1 && !target()) return 'Choose where the agent should work.';
    if (!target()) return 'The selected target changed. Choose an available target.';
    return '';
  };
  const gateMessage = () => !props.live ? 'Connect to the live workspace service to preview and launch.' : !props.token ? 'The workspace action token is unavailable.' : '';

  const clearHandoff = () => {
    operation++; setThreadId(''); setSaveIdentity(null); setAssignmentIdentity(null); setPreview(null); setResult(null); setPending(''); setError(''); setStatus('');
  };

  createEffect(on(packageKey, () => {
    operation++;
    setTitle(packageRef() ? plannedBriefTitle(packageRef()) : '');
    setBrief(packageRef() ? plannedBriefContent(packageRef()) : '');
    clearHandoff();
  }));
  createEffect(on(contextKey, () => {
    const candidates = choices();
    setTargetId(candidates.length === 1 ? candidates[0].key : '');
    clearHandoff();
    if (candidates.length === 1) setStatus(`Using ${candidates[0].id} from this spec's targets.`);
  }));
  onCleanup(() => { operation++; });

  const invalidate = () => {
    const hadPreview = Boolean(preview());
    operation++; setPending(''); setError(''); setPreview(null); setResult(null);
    setStatus(hadPreview ? 'Brief changed. Preview again before launching.' : '');
  };
  const inputSignature = () => signature();
  function changeTarget(value: string) {
    if (value === targetId()) return;
    setTargetId(value); clearHandoff();
  }
  function updateBrief(setter: (value: string) => void, value: string) {
    setter(value); invalidate();
  }
  function requestIsCurrent(request: number, key: string, expectedSignature: string) {
    return request === operation && key === contextKey() && expectedSignature === inputSignature();
  }

  async function findOrCreateThread(request: number, key: string, expectedSignature: string, chosen: PlannedTargetChoice) {
    if (threadId()) return threadId();
    const titleValue = `Planned: ${packageRef()}`.slice(0, 200);
    const params = new URLSearchParams({ workspace_id: workspaceId() });
    const data: any = await getJson(`/api/threads?${params}`);
    if (!requestIsCurrent(request, key, expectedSignature)) return '';
    const rows: Thread[] = Array.isArray(data) ? data : Array.isArray(data?.threads) ? data.threads : [];
    const existing = rows.find(row => row.history_only !== true && row.title === titleValue && row.target?.kind === 'worktree' && row.target.path === chosen.path);
    if (existing?.thread_id) { setThreadId(existing.thread_id); return existing.thread_id; }
    const created = await postJson<Thread>('/api/thread/create', {
      workspace_id: workspaceId(), title: titleValue,
      target: { kind: 'worktree', path: chosen.path }, specPackage: packageRef(),
    }, props.token || '');
    if (!requestIsCurrent(request, key, expectedSignature)) return '';
    setThreadId(created.thread_id);
    return created.thread_id;
  }

  async function previewAgent() {
    const chosen = target();
    if (!actionable() || pending() || !chosen || targetProblem() || !packageRef() || !title().trim() || !brief().trim()) return;
    const key = contextKey(), expectedSignature = inputSignature(), request = ++operation;
    setPending('preview'); setError(''); setStatus('Preparing the spec worktree and assignment preview…'); setResult(null);
    try {
      const thread = await findOrCreateThread(request, key, expectedSignature, chosen);
      if (!thread || !requestIsCurrent(request, key, expectedSignature)) return;
      await postJson('/api/dispatch/prepare-spec-target', {
        workspace_id: workspaceId(), thread_id: thread, spec_package: packageRef(),
      }, props.token || '');
      if (!requestIsCurrent(request, key, expectedSignature)) return;
      let save = saveIdentity();
      if (!save || save.signature !== expectedSignature) { save = { signature: expectedSignature, id: uuid() }; setSaveIdentity(save); }
      await postJson('/api/thread/save-brief', {
        workspace_id: workspaceId(), thread_id: thread, request_id: save.id,
        title: title().trim(), content: brief(), references: [],
      }, props.token || '');
      if (!requestIsCurrent(request, key, expectedSignature)) return;
      let assignment = assignmentIdentity();
      if (!assignment || assignment.signature !== expectedSignature) {
        assignment = { signature: expectedSignature, id: uuid() };
        setAssignmentIdentity(assignment);
      }
      const handoff = {
        workspace_id: workspaceId(), thread_id: thread, request_id: save.id, assignment_id: assignment.id,
        instructions: BRIEF_INSTRUCTION, skill: SKILL, specPackage: packageRef(),
        provider: PROVIDER, model: MODEL, thinking: THINKING,
        harness: HARNESS, publication_authority: AUTHORITY,
      };
      const data: any = await postJson('/api/thread/preview-assignment', handoff, props.token || '');
      if (!requestIsCurrent(request, key, expectedSignature)) return;
      const value = { requestId: save.id, assignmentId: assignment.id, digest: str(data?.contractDigest), record: data?.record ?? null, input: data?.inputPreview ?? null, signature: expectedSignature };
      if (!value.digest) throw new Error('The preview did not return a contract digest.');
      setPreview(value); setStatus('Preview ready. Review the brief and agent settings before starting.');
    } catch (e) {
      if (request === operation && key === contextKey()) { setError(errorText(e)); setStatus('Preview failed. Your brief and settings are still available to retry.'); }
    } finally {
      if (request === operation) setPending('');
    }
  }

  async function launchAgent() {
    const value = currentPreview();
    if (!actionable() || pending() || !value?.digest || changed()) return;
    const key = contextKey(), expectedSignature = inputSignature(), request = ++operation;
    setPending('launch'); setError(''); setStatus('Starting the assignment and waiting for launch confirmation…');
    try {
      const data: any = await postJson('/api/thread/launch-assignment', {
        workspace_id: workspaceId(), thread_id: threadId(), request_id: value.requestId,
        assignment_id: value.assignmentId, instructions: BRIEF_INSTRUCTION,
        skill: SKILL, specPackage: packageRef(), provider: PROVIDER, model: MODEL,
        thinking: THINKING, harness: HARNESS, publication_authority: AUTHORITY,
        expectedDigest: value.digest,
      }, props.token || '');
      if (!requestIsCurrent(request, key, expectedSignature)) return;
      setResult({ assignment: data?.assignment ?? null, observation: data?.observation ?? null });
      const live = data?.assignment?.state === 'live';
      setStatus(live ? 'Assignment is live. Review its id and attention below.' : 'Launch is not confirmed live. Review the assignment state and attention below.');
    } catch (e) {
      if (request === operation && key === contextKey()) {
        const message = errorText(e);
        if (e instanceof HttpError && e.status === 409) setPreview(null);
        setError(message); setStatus(e instanceof HttpError && e.status === 409 ? 'The reviewed inputs changed. Preview the assignment again before launching.' : 'Launch failed. Review the error before retrying.');
      }
    } finally {
      if (request === operation) setPending('');
    }
  }

  return <section class="thread-handoff planned-assignment" id="planned-assignment" data-testid="planned-assignment" aria-labelledby="planned-assignment-heading">
    <div class="section-head"><div><h3 id="planned-assignment-heading">Start implementation</h3><p class="small muted">{packageRef()} · {SKILL} · PR access · {PROVIDER} / {MODEL}:{THINKING}</p></div></div>
    <div class="planned-assignment-fields">
      <div class="thread-field"><label for="planned-assignment-target">Target</label>
        <Show when={choices().length > 1} fallback={<p id="planned-assignment-target-summary" data-testid="planned-assignment-target-summary" class="small mono">{target() ? plannedTargetLabel(target()!) : targetProblem() || 'Loading targets…'}</p>}>
          <select id="planned-assignment-target" data-testid="planned-assignment-target" value={targetId()} onChange={event => changeTarget(event.currentTarget.value)}>
            <option value="">Choose target</option>
            <For each={choices()}>{choice => <option value={choice.key}>{plannedTargetLabel(choice)}</option>}</For>
          </select>
        </Show>
        <Show when={targetProblem()}><p class="small warn" role="status">{targetProblem()}</p></Show>
      </div>
      <div class="thread-field"><label for="planned-assignment-title">Brief title</label><input id="planned-assignment-title" data-testid="planned-assignment-title" type="text" maxlength="200" value={title()} onInput={event => updateBrief(setTitle, event.currentTarget.value)} /></div>
      <div class="thread-field planned-assignment-brief"><label for="planned-assignment-brief">Assignment brief</label><textarea id="planned-assignment-brief" data-testid="planned-assignment-brief" value={brief()} onInput={event => updateBrief(setBrief, event.currentTarget.value)} /></div>
    </div>
      <Show when={gateMessage()}><p class="small warn" role="status">{gateMessage()}</p></Show>
    <Show when={status()}><p id="planned-assignment-status" data-testid="planned-assignment-status" class="thread-state" role="status">{status()}</p></Show>
    <Show when={error()}><p class="thread-state bad" role="alert">{error()}</p></Show>
    <p class="small muted">Preview creates or reuses this spec’s own worktree. Other specs can run in their own worktrees at the same time.</p>
    <div class="thread-actions">
      <Show when={!currentPreview()}><button id="planned-assignment-preview" data-testid="planned-assignment-preview" class="primary" type="button" disabled={!actionable() || !!pending() || !!targetProblem() || !target() || !packageRef() || !title().trim() || !brief().trim()} onClick={() => void previewAgent()}>{pending() === 'preview' ? 'Preparing preview…' : changed() ? 'Preview changes' : 'Preview settings'}</button></Show>
      <Show when={currentPreview()}>{value => <button id="planned-assignment-launch" data-testid="planned-assignment-launch" class="primary" type="button" disabled={!actionable() || !!pending() || !!result()} onClick={() => void launchAgent()}>{pending() === 'launch' ? 'Starting…' : 'Start agent'}</button>}</Show>
    </div>
    <Show when={currentPreview()}>{value => <div class="thread-preview" id="planned-assignment-preview-result" data-testid="planned-assignment-preview-result">
      <div class="section-head"><h4>Review before start</h4><span class="pill good">Ready</span></div>
      <dl class="thread-facts">
        <div><dt>Target</dt><dd class="mono">{str(value().record?.repository_id || target()?.id)} · {str(value().record?.execution_dir || target()?.path)}</dd></div>
        <div><dt>Branch</dt><dd class="mono">{str(value().record?.execution_branch)}</dd></div>
        <div><dt>Package</dt><dd class="mono">{packageRef()}</dd></div>
        <div><dt>Agent settings</dt><dd class="mono">{HARNESS} · {PROVIDER} / {MODEL}:{THINKING}</dd></div>
        <div><dt>Skill · PR access</dt><dd class="mono">{SKILL} · {AUTHORITY}</dd></div>
        <div><dt>Assignment id</dt><dd class="mono">{value().assignmentId}</dd></div>
      </dl>
      <Show when={value().input}><details><summary>Full input</summary><pre>{value().input.brief}</pre><pre>{value().input.instruction}</pre></details></Show>
    </div>}</Show>
    <Show when={result()}>{value => <div id="planned-assignment-result" data-testid="planned-assignment-result" class="thread-result" aria-live="polite">
      <div class="section-head"><h4>Agent status</h4><span class={`pill ${value().assignment?.state === 'live' ? 'good' : 'warn'}`}>{str(value().assignment?.state || 'unknown')}</span></div>
      <p>Assignment <span class="mono">{str(value().assignment?.assignment_id || currentPreview()?.assignmentId)}</span></p>
      <Show when={Array.isArray(value().assignment?.attention) && value().assignment.attention.length}><p class="small warn">Attention: {value().assignment.attention.join(' · ')}</p></Show>
      <Show when={value().observation}><p class="small muted">Observed state: {str(value().observation?.state || 'unknown')}</p></Show>
    </div>}</Show>
  </section>;
}
