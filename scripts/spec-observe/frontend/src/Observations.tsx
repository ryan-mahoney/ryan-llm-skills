import SessionPanel from './SessionPanel';
import { For, Show } from 'solid-js';
import { PackagePreview } from './PackagePreview';
import { esc, age, attention, base, duration as sharedDuration, inlineMarkdown, pendingWorkflow, runningUnconfirmed, serverNow, stale, statusMarkdown, str, terminal, time, activeRun } from './format';
import { assignmentEnded, assignmentLabel, assignmentTone, completionLabel, duration, epicMemberTone, epicStats, packageViewUrl, runState, specProgress } from './observation-format';

type Filter = 'active' | 'attention' | 'completed';
type SelectionProps = { query: string; selected: string | null; onSelect: (key: string) => void };
const list = (v: any) => Array.isArray(v) ? v : [];
const text = (v: any, fallback = 'Unknown') => typeof v === 'string' && v ? v : fallback;
const isAttention = (r: any) => typeof attention === 'function' ? attention(r) : false;
const isActive = (r: any) => typeof activeRun === 'function' ? activeRun(r) : !r?.recent_completion && (!terminal?.has?.(r?.execution) || pendingWorkflow?.(r));
const tone = (r: any) => r?.recent_completion ? 'good' : isAttention(r) ? 'warn' : !isActive(r) || !r?.execution || r.execution === 'unknown' ? 'muted' : 'good';
const state = (r: any) => runState(r, runningUnconfirmed);
const coverageTone = (v: any) => v === 'complete' ? 'good' : v === 'partial' || v === 'unavailable' ? 'warn' : 'muted';
const rows = (items: any[], kind: string) => <Show when={items.length} fallback={<p class="small muted">No {kind.toLowerCase()} recorded in this observation.</p>}>
  <div class="rows"><For each={items}>{item => { const detail = item.summary || item.reason || item.reason_code || item.message || item.note || item.hint || ''; return <div class="info-row"><p>{text(item.kind || item.action || item.state, kind)}{item.state && item.kind ? ` · ${item.state}` : ''}{item.count != null ? ` · ${item.count} failure(s)` : ''}</p><small><span innerHTML={inlineMarkdown(detail)} />{item.observed_at ? ` · ${time(item.observed_at)}` : ''}</small><Show when={item.id}><small class="mono">{item.id}</small></Show></div>; }}</For></div>
</Show>;
const Markdown = (props: { value: any; class?: string; fallback: string }) => <div class={`status-markdown ${props.class || ''}`} innerHTML={statusMarkdown(props.value || props.fallback)} />;

export function PackageList(props: { records: any[]; filter: Filter; query: string; selected: string | null; onSelect: (key: string) => void }) {
  const all = () => list(props.records).filter(r => props.filter === 'completed' ? r.recent_completion === true : !r.recent_completion);
  const visible = () => all().filter(r => {
    const q = props.query.trim().toLowerCase();
    return (!q || [r.workspace, r.package_ref, r.package, r.activity, r.obligation, r.execution, r.workflow_state].some(v => str(v).toLowerCase().includes(q))) &&
      (props.filter === 'completed' || props.filter === 'active' && isActive(r) || props.filter === 'attention' && isAttention(r));
  });
  const sorted = () => [...visible()].sort((a, b) => props.filter === 'completed' ? Date.parse(b.completed_at || '') - Date.parse(a.completed_at || '') || str(a.package).localeCompare(str(b.package)) : str(a.workspace).localeCompare(str(b.workspace)) || str(a.package).localeCompare(str(b.package)));
  return <>
    <div class="observation-rows">
      <Show when={sorted().length} fallback={<div class="empty"><h3>{props.filter === 'completed' ? 'No recently completed specs' : all().length ? 'No matching packages' : 'No observed packages'}</h3><p class="small" style={{ 'margin-top': '8px' }}>{props.filter === 'completed' ? 'Recent completion history appears here when the snapshot includes it.' : all().length ? 'Change the search or package filter.' : 'Start an observer or import a published snapshot.'}</p></div>}>
        <For each={sorted()}>{(r, index) => <><Show when={index() === 0 || sorted()[index() - 1]?.workspace !== r.workspace}><div class="repo-heading"><span title={r.workspace}>{text(r.workspace)}</span></div></Show><button type="button" class="run-row" data-key={r.key} aria-pressed={r.key === props.selected} onClick={() => props.onSelect(r.key)}>
          <div class="flex justify-between gap-3"><span class="run-title">{base(r.package)}<Show when={r.epic}>{ref => { const epic = list(r.observer?.snapshot?.epics).find(e => e.epic === ref().epic && (ref().workspace == null || e.workspace === ref().workspace)); return <span class="pill muted" title={epic?.title || 'Epic record unavailable in this snapshot'}>{ref().epic}{epic ? ` · ${epicStats(epic).landed}/${epicStats(epic).total}` : ''}</span>; }}</Show></span><span class={`pill ${tone(r)}`}>{state(r)}</span></div>
          <p class="summary" innerHTML={r.recent_completion ? esc(completionLabel(r)) : inlineMarkdown(r.activity || r.obligation || 'No activity hint observed', false)} />
          <Show when={!r.recent_completion}><Progress record={r} /></Show>
          <span class="small muted">{r.recent_completion ? 'Completed' : 'Activity'} {age(r.recent_completion ? r.completed_at : r.observed_at)}</span>
        </button></>}</For>
      </Show>
    </div>
  </>;
}

function Progress(props: { record: any; detail?: boolean }) {
  const p = () => specProgress(props.record);
  return <div class={`spec-progress${props.detail ? ' section' : ''}`}><div class="small"><span>{p().label}{p().name ? ` · ${p().name}` : ''}</span></div>
    <progress aria-label="Spec step position" max={p().position !== null ? p().total! : 1} value={p().position ?? 0} aria-valuetext={p().label} />
    <Show when={props.detail}><p class="small muted">Position in the prepared spec. Accepted completion is not observed.</p></Show>
  </div>;
}

function StepTimings(props: { record: any; live: boolean }) {
  const attempts = () => list(props.record.timing?.attempts);
  const endFor = (a: any) => {
    if (a.finished_at || terminal?.has?.(a.state)) return a.finished_at || null;
    const r = props.record, o = r.observer, n = serverNow();
    const fresh = props.live && n != null && o?.state === 'observing' && !stale(o.published_at) && !stale(o.snapshot?.coverage?.observed_at);
    return fresh ? new Date(n).toISOString() : r.timing?.observed_at || null;
  };
  return <section class="section"><div class="section-head"><h3>Step durations</h3></div>
    <Show when={attempts().length} fallback={<p class="small muted">Step timing has not been observed yet.</p>}>
      <div class="timing-scroll"><table class="timing-table"><thead><tr><th scope="col">Step / attempt</th><th scope="col">State</th><th scope="col">Duration</th></tr></thead><tbody><For each={attempts()}>{(a, index) => { const attempt = () => attempts().slice(0, index() + 1).filter(item => item.step === a.step).length; return <tr><th scope="row">{a.step != null ? `Step ${a.step}${a.name ? ` · ${a.name}` : ''}` : 'Step unknown'}<small class="muted">Attempt {attempt()} · {a.attempt_kind || 'Reason not recorded'}</small></th><td>{a.state || 'Unknown'}<Show when={a.handoff_outcome}><small class="muted">Handoff: {a.handoff_outcome}</small></Show></td><td class="mono">{duration(a.started_at, endFor(a))}{!a.finished_at && !terminal?.has?.(a.state) ? ' elapsed' : ''}</td></tr>; }}</For></tbody></table></div>
      <p class="small muted" style={{ 'margin-top': '12px' }}>From first recorded dispatch; includes waits and verification. Each assignment is shown separately; completed execution does not imply accepted work. Missing timing stays unknown.</p>
    </Show>
  </section>;
}

function EpicMembers(props: { epic: any; current?: any; records?: any[]; onSelect?: (key: string) => void; onSelectMember?: (member: any) => void }) {
  const members = () => list(props.epic.members);
  const matchingRecord = (m: any) => list(props.records).filter(r => base(r.package) === (m.package ?? m.name) && (m.workspace == null || r.workspace === m.workspace)).sort((a, b) => Number(b.is_current_assignment === true) - Number(a.is_current_assignment === true))[0];
  return <section class="section"><div class="section-head"><h3>Epic members</h3><span class="small muted">{members().length} recorded</span></div>
    <Show when={members().length} fallback={<p class="small muted">No members recorded.</p>}>
      <div class="timing-scroll"><table class="timing-table epic-table"><caption class="sr-only">Members of {props.epic.title}</caption><thead><tr><th scope="col">Member</th><th scope="col">Status</th><th scope="col">Step</th><th scope="col">Waiting on</th><th scope="col">Note</th></tr></thead><tbody><For each={members()}>{m => {
        const here = props.current && (m.package ?? m.name) === base(props.current.package) && (m.workspace == null || m.workspace === props.current.workspace);
        const rec = !here ? matchingRecord(m) : null;
        return <tr aria-current={here ? 'true' : undefined}><th scope="row"><Show when={props.onSelectMember} fallback={<Show when={rec && props.onSelect} fallback={<>{m.name}</>}><button type="button" onClick={() => { if (rec) props.onSelect?.(rec.key); }}>{m.name}</button></Show>}><button type="button" onClick={() => props.onSelectMember?.(m)}>{m.name}</button></Show><Show when={here}><small class="muted">This package</small></Show></th><td><span class={`pill ${epicMemberTone(m)}`}>{str(m.status || 'unknown').replace(/-/g, ' ')}{m.attention === true ? ' · attention' : ''}</span></td><td>{m.step && m.step.position != null ? `${m.step.position} of ${m.step.total ?? 'unknown'}` : '—'}</td><td>{list(m.waiting_on).join(', ') || '—'}</td><td>{m.note || '—'}</td></tr>;
      }}</For></tbody></table></div>
    </Show>
    <p class="small muted" style={{ 'margin-top': '10px' }}>Status is derived from each package's files. It is lifecycle, not acceptance.</p>
  </section>;
}

export function PackageDetail(props: { record: any; live: boolean; previewToken?: string; completionToken?: string; completionLocalOnly?: boolean; onComplete: () => void; onOpenFile: (name: string) => void; onSelect: (key: string) => void; records: any[] }) {
  return <Show when={props.record} fallback={<div class="empty"><h2>Select an observed package</h2><p>Choose a package to inspect its obligation, activity, coverage and source paths.</p></div>}><PackageDetailBody record={props.record} live={props.live} previewToken={props.previewToken} completionToken={props.completionToken} completionLocalOnly={props.completionLocalOnly} onComplete={props.onComplete} onOpenFile={props.onOpenFile} onSelect={props.onSelect} records={props.records} /></Show>;
}

function PackageDetailBody(props: { record: any; live: boolean; previewToken?: string; completionToken?: string; completionLocalOnly?: boolean; onComplete: () => void; onOpenFile: (name: string) => void; onSelect: (key: string) => void; records: any[] }) {
  const record = new Proxy({}, { get: (_target, property: string | symbol) => props.record?.[property] }) as any;
  const r = () => record, o = () => r()?.observer || {}, c = () => r()?.coverage || {}, observed = () => o().snapshot?.coverage?.observed_at;
  const specElapsed = (record: any) => {
    if (!record.timing) return 'Unknown';
    const n = serverNow(), observer = record.observer;
    const liveEnd = props.live && n != null && observer?.state === 'observing' && !stale(observer.published_at) && !stale(observer.snapshot?.coverage?.observed_at) ? new Date(n).toISOString() : null;
    return sharedDuration(record.timing.started_at, record.completed_at || record.timing.finished_at || liveEnd || record.timing.observed_at);
  };
  const relatedEpic = () => r()?.epic ? list(o().snapshot?.epics).find(e => e.epic === r().epic.epic && (r().epic.workspace == null || e.workspace === r().epic.workspace)) : null;
  const completionHelp = () => props.completionToken ? 'Move this package to Recently completed.' : !props.live ? 'Completion is available on the live dashboard.' : props.completionLocalOnly ? "Mark complete is available on the host's local dashboard." : 'Reconnect to the live dashboard to enable completion.';
  return <article class="detail" data-key={record.key}>
    <div class="eyebrow">{text(record.workspace)} / Spec package</div><div class="detail-title"><div><h2>{base(record.package)}</h2><p class="subtitle mono">{text(record.workflow_id, 'Workflow unknown')} · {text(record.assignment_id, 'Assignment unknown')}</p></div><span class={`pill ${tone(record)}`}>{state(record)}</span></div>
    <PackagePreview package={record.package} live={props.live} token={props.previewToken} />
    <Show when={record.recent_completion}><section class="section activity"><h3>{completionLabel(record)}</h3><p>Completed {time(record.completed_at)} · {age(record.completed_at)}</p><p class="small muted">{record.completion_basis === 'manual' ? 'Marked complete by an operator. Step evidence and PR status remain as recorded.' : record.merge?.state === 'merged' ? 'Merge confirmed from the matching PR and branch head.' : 'Recorded workflow completion; merge status is unknown.'}</p></section></Show>
    <Show when={!record.recent_completion}><Show when={record.is_current_assignment === true}><div class="completion-control"><button type="button" disabled={!props.completionToken} aria-describedby="completion-help" onClick={props.onComplete}>Mark complete</button><p id="completion-help" class="small muted">{completionHelp()}</p></div></Show><Show when={record.execution === 'running' && (record.coverage?.reasons || []).some((v: string) => /^coordinator-gone$|^checkout-unavailable:/.test(v))}><p class="small muted section">The saved run says running, but its coordinator process or checkout is unavailable. Current activity is not confirmed.</p></Show><Progress record={record} detail /></Show>
    <div class="facts"><div><div class="fact-label">Time since spec start</div><span>{specElapsed(record)}</span><p class="small muted">{record.timing?.started_at ? time(record.timing.started_at) : 'Start not observed'}</p></div><div><div class="fact-label">Snapshot freshness</div><span class={!props.live || stale(observed()) ? 'warn' : 'good'}>{!props.live ? 'Last received' : stale(observed()) ? 'Stale' : 'Fresh'} · {age(observed())}</span><p class="small muted">{time(observed())}</p></div><div><div class="fact-label">Last activity</div><span>{age(record.observed_at)}</span><p class="small muted">{time(record.observed_at)}</p></div><div><div class="fact-label">Run coverage</div><span class={coverageTone(c().state)}>{text(c().state)}</span><p class="small muted">Workspace {text(o().snapshot?.coverage?.state, 'unknown')}</p></div><Show when={record.epic}><div><div class="fact-label">Epic</div><span>{relatedEpic()?.title || 'Epic record unavailable in this snapshot'}</span><p class="small muted">{record.epic.epic}{relatedEpic() ? ` · ${epicStats(relatedEpic()).landed} of ${epicStats(relatedEpic()).total} landed · next ${relatedEpic().next || 'none'}` : ''}</p></div></Show></div>
    <Show when={record.epic && relatedEpic()}><EpicMembers epic={relatedEpic()} current={record} records={props.records} onSelect={props.onSelect} /></Show>
    <section><div class="section-head"><h3>Implementation activity</h3><span class="small muted">Last observed hint</span></div><div class="activity"><Markdown value={record.activity} fallback="No activity hint was observed for this run." /></div></section>
    <section class="section"><div class="section-head"><h3>{record.recent_completion ? 'Final recorded obligation' : 'Current obligation'}</h3></div><div class="obligation"><Markdown value={record.obligation} fallback="No obligation summary was observed." /></div></section>
    <section class="section"><h3>Recorded unfinished workers</h3><p class="small muted">Checkpoint {time(record.workflow_observed_at)}; recorded state, not a live process check.</p><Show when={list(record.workflow_workers).length} fallback={<p class="small muted">No unfinished workers recorded in this snapshot.</p>}><For each={list(record.workflow_workers)}>{w => <p class="info-row"><strong>{w.kind}</strong> · {w.state}<br /><span class="mono small">{w.id}</span></p>}</For></Show></section>
    <StepTimings record={record} live={props.live} />
    <section class="section"><div class="section-head"><h3>Conditions</h3><span class="small muted">{list(record.conditions).length} observed</span></div>{rows(list(record.conditions), 'Conditions')}</section>
    <section class="section"><div class="section-head"><h3>Verification incidents</h3><span class="small muted">{list(record.incidents).length} recorded</span></div>{rows(list(record.incidents), 'Incidents')}</section>
    <section class="section"><div class="section-head"><h3>Recorded actions</h3><span class="small muted">Read-only</span></div>{rows(list(record.actions), 'Actions')}</section>
    <section class="section"><h3>Workspace paths</h3><dl class="paths"><dt class="small muted">Workspace</dt><dd class="mono">{text(record.workspace)}</dd><dt class="small muted">Spec package</dt><dd class="mono">{text(record.package_ref)} · {text(record.package)}</dd><dt class="small muted">Targets</dt><dd class="mono"><Show when={list(record.targets).length} fallback="Not recorded"><For each={list(record.targets)}>{(target, index) => <>{index() ? <br /> : null}{target.id} · {target.primary}</>}</For></Show></dd><dt class="small muted">Checkout</dt><dd class="mono">{text(record.checkout, 'Not observed')}</dd></dl>
      <details><summary>Source paths · {list(record.source_paths).length}</summary><For each={list(record.source_paths)}>{path => <p class="mono" style={{ margin: '8px 0' }}><button type="button" onClick={() => props.onOpenFile(path)}>{path}</button></p>}</For><Show when={!list(record.source_paths).length}><p class="small muted">No source paths recorded.</p></Show></details>
      <details><summary>Coverage reasons</summary><For each={[...list(c().reasons), ...list(o().snapshot?.coverage?.reasons)]}>{reason => <p class="coverage-note"><span innerHTML={inlineMarkdown(reason)} /></p>}</For><Show when={!list(c().reasons).length && !list(o().snapshot?.coverage?.reasons).length}><p class="small muted">No coverage reasons reported.</p></Show></details>
      <Show when={list(record.files).length}><div class="section-head"><h3>Package files</h3></div><For each={list(record.files)}>{file => <button type="button" onClick={() => props.onOpenFile(file.name || file)}>{file.name || file}</button>}</For></Show>
    </section>
    <div class="footer">Recorded worker: {text(record.execution, 'unknown')} · Workflow: {text(record.workflow_state, 'unknown')}<br />Observer {text(o().observer_id)} · {text(o().state)} · {text(o().mode, 'Mode unknown')}<br />Heartbeat {time(o().published_at)} · {age(o().published_at)}<Show when={o().source}><><br /><span class="mono">{o().source}</span></></Show><Show when={o().note}><><br /><span innerHTML={inlineMarkdown(o().note)} /></></Show><br />Snapshot freshness uses workspace observation time. Last activity and observer heartbeat are separate facts.</div>
  </article>;
}

export function AgentList(props: { assignments: any[]; query: string; selected: string | null; onSelect: (key: string) => void }) {
  const visible = () => list(props.assignments).filter(a => !props.query.trim() || [a.assignment_id, a.spec_package, a.workflow_id, a.display, a.nextAction, a.safeAction].some(v => str(v).toLowerCase().includes(props.query.trim().toLowerCase()))).sort((a, b) => Number(assignmentEnded(a)) - Number(assignmentEnded(b)) || str(a.spec_package).localeCompare(str(b.spec_package)) || str(a.assignment_id).localeCompare(str(b.assignment_id)));
  const active = () => visible().filter(a => !assignmentEnded(a)), ended = () => visible().filter(assignmentEnded);
  const row = (a: any) => <button type="button" class="run-row" data-assignment-key={a.key} aria-pressed={a.key === props.selected} onClick={() => props.onSelect(a.key)}><div class="flex justify-between gap-3"><span class="run-title mono">{a.assignment_id}</span><span class={`pill ${assignmentTone(a)}`}>{assignmentLabel(a)}</span></div><p class="summary">{a.nextAction || a.safeAction || 'No safe action recorded'}{a.quiet ? ' · Quiet' : ''}{a.attachedCount ? ` · ${a.attachedCount} attached` : ''}</p><span class="small muted">{a.spec_package ? base(a.spec_package) : 'No spec package'} · {age(a.observer?.snapshot?.coverage?.observed_at || a.observer?.published_at)}</span><Show when={list(a.attention).length}><p class="small warn">{list(a.attention).slice(0, 2).join(' · ')}</p></Show></button>;
  return <><Show when={list(props.assignments).some(a => a.assignment_coverage?.state === 'partial')}><div class="coverage-note">Assignment coverage partial</div></Show><div class="observation-rows"><Show when={visible().length} fallback={<div class="empty"><h3>{props.assignments.length ? 'No matching agents' : 'No agents observed'}</h3><p class="small" style={{ 'margin-top': '8px' }}>{props.assignments.length ? 'Change the search.' : 'An absent assignment snapshot differs from an empty one; assignment coverage explains partial reads.'}</p></div>}><For each={active()}>{row}</For><Show when={ended().length}><div class="repo-heading">Recently ended</div><For each={ended()}>{row}</For></Show></Show></div></>;
}

function linkedRun(a: any, records: any[]) {
  const pkg = str(a.spec_package || '').replace(/\/+$/, ''), workflow = str(a.workflow_id || '').trim();
  if (!pkg || !workflow) return null;
  const workspace = a.workspace || a.observer?.snapshot?.workspace || a.observer?.observer_id || a.observer?.source || 'unknown';
  return list(records).find(r => {
    const runWorkspace = r.observer?.snapshot?.workspace || r.observer?.observer_id || r.observer?.source || 'unknown';
    const runWorkflow = typeof r.workflow_id === 'string' && r.workflow_id.trim() ? r.workflow_id.trim() : null;
    const runAssignment = typeof r.assignment_id === 'string' && r.assignment_id ? r.assignment_id : null;
    return !r.recent_completion && runWorkspace === workspace &&
      [r.spec_package, r.package_ref, r.package].some(v => str(v || '').replace(/\/+$/, '') === pkg) &&
      runWorkflow === workflow && (runAssignment === null || runAssignment === a.assignment_id);
  }) || null;
}

export function AgentDetail(props: { assignment: any; records: any[]; token?:string; live:boolean; refresh:()=>Promise<void>; onEnded:(id:string)=>void }) {
  return <Show when={props.assignment?.key} fallback={<div class="empty"><h2>Select an observed agent</h2><p>Choose an assignment to inspect execution, lifecycle and declared evidence.</p></div>} keyed>{_key => {
    const a = () => props.assignment;
    const run = () => linkedRun(a(), props.records);
    const o = () => a().observer;
    const ac = () => o()?.snapshot?.assignment_coverage || a().assignment_coverage;
    const action = () => a().nextAction || a().safeAction || 'No safe action recorded';
    const hold = () => run()?.workflow_state === 'user-held' || list(run()?.conditions).some(c => c.state !== 'resolved' && (c.kind === 'user-held' || c.kind === 'hold-active' || String(c.kind || '').includes('hold')));
    return <article class="detail"><div class="eyebrow">{text(a().workspace, 'observer')} / Agent</div><div class="detail-title"><div><h2 class="mono">{a().assignment_id}</h2><p class="subtitle mono">{a().spec_package || 'No spec package'} · {text(a().workflow_id, 'Workflow unknown')}</p></div><span class={`pill ${assignmentTone(a())}`}>{assignmentLabel(a())}</span></div><p class="small muted section">Safe next action: {action()}</p>
      <SessionPanel assignment={a()} token={props.token} live={props.live} refresh={props.refresh} onEnded={props.onEnded}/>
      <Show when={a().task_activity?.state && a().task_activity.state!=='unknown'}><section class="section"><h3>Response status</h3><p>{a().task_activity.reason}</p><Show when={a().task_activity.finished_at}><p class="small muted">Finished {time(a().task_activity.finished_at)}. A finished response does not certify the proposed work was implemented or accepted.</p></Show><Show when={a().task_activity.last_reply}><details><summary>Last response</summary><pre style={{'white-space':'pre-wrap','overflow-wrap':'anywhere'}}>{a().task_activity.last_reply}</pre></details></Show></section></Show>
      <section class="section"><h3>Execution</h3><div class="rows"><div class="info-row"><p>{assignmentLabel(a())}</p><small>Recorded {text(a().recordedState, 'unknown')} · observed {text(a().observedState, 'unknown')}</small><Show when={a().unrecorded}><small class="warn">The record differs from the observation; reconcile with the explicit locate command.</small></Show></div><For each={list(a().coverageReasons)}>{v => <div class="info-row"><p>{v}</p></div>}</For></div><p class="small muted">Coverage {text(a().coverage, 'complete')} · read-only observation; the record is never rewritten here.</p></section>
      <section class="section"><h3>Lifecycle</h3><div class="rows"><div class="info-row"><p>Workflow <span class="mono">{text(a().workflow_id, 'unknown')}</span></p><small>{run() ? `Run execution ${text(run()!.execution, 'unknown')}${run()!.workflow_state ? ` · workflow ${run()!.workflow_state}` : ''}` : 'No linked run in this snapshot.'}</small></div><div class="info-row"><p>{a().quiet ? 'Quiet: no session growth beyond 120 seconds (informational).' : 'Not quiet, or session activity was not observed.'}</p></div><div class="info-row"><p>{a().attachedCount == null ? 'Attached count unknown.' : `${a().attachedCount} client(s) attached (presence only; no control).`}</p></div><Show when={a().workersUnconfirmed}><div class="info-row"><p class="warn">Workers unconfirmed</p><small>Linked run is recorded as running but its coordinator process is gone; inspect recorded workers before relaunching.</small></div></Show><div class="info-row"><p>Safe next action</p><small>{action()}</small></div><Show when={o()?.mode === 'recover' && a().attachedCount && !hold()}><div class="info-row"><p>Automatic continuation can still act. Use takeover to hold it.</p></div></Show></div></section>
      <section class="section"><div class="section-head"><h3>Declared evidence</h3><span class={`pill ${run()?.evidence?.state === 'recorded' ? 'good' : run()?.evidence?.state === 'unavailable' ? 'warn' : 'muted'}`}>{run()?.evidence?.state || 'unknown'}</span></div><Show when={run()?.evidence} fallback={<p class="small muted">No linked run evidence in this snapshot.</p>}><div class="rows"><div class="info-row"><p><Show when={run()!.evidence.state === 'recorded'} fallback={run()!.evidence.state === 'unavailable' ? 'Declared artifact is unavailable.' : 'No declared artifact was assessed.'}>Declared {run()!.evidence.verdict} at commit <span class="mono">{run()!.evidence.commit}</span></Show></p><small>{run()!.evidence.source || 'work-tour.json'} · scope {run()!.evidence.scope || 'declared-artifact'}{run()!.evidence.observed_at ? ` · ${time(run()!.evidence.observed_at)}` : ''}{run()!.evidence.reason ? ` · ${run()!.evidence.reason}` : ''}</small></div></div><p class="small muted">Declared artifact scope only; this never proves the current checkout, merge or deployment.</p></Show></section>
      <Show when={a().spec_package}><section class="section"><h3>Links</h3><p class="small"><a href={packageViewUrl(run()?.package || a().spec_package, 'work-tour.html')} target="_blank" rel="noopener noreferrer">Declared work tour</a> · package view only; nothing is fetched automatically.</p></section></Show>
      <section class="section"><div class="section-head"><h3>Attention</h3><span class="small muted">{list(a().attention).length} observed</span></div>{list(a().attention).length ? <div class="rows"><For each={list(a().attention)}>{v => <div class="info-row"><p><span innerHTML={inlineMarkdown(v)} /></p></div>}</For></div> : <p class="small muted">No attention recorded.</p>}</section>
      <section class="section"><div class="section-head"><h3>Assignment coverage</h3><span class="small muted">{text(ac()?.state, 'unknown')}</span></div>{list(ac()?.reasons).length ? <For each={list(ac().reasons)}>{v => <p class="coverage-note"><span innerHTML={inlineMarkdown(v)} /></p>}</For> : <p class="small muted">No assignment coverage reasons reported.</p>}</section>
      <div class="footer">Observer {text(o()?.observer_id)} · {text(o()?.state)}<br />Snapshot observed {time(o()?.snapshot?.coverage?.observed_at)} · {age(o()?.snapshot?.coverage?.observed_at)}<br />Attach from your terminal using the command above. Ending a session requires explicit confirmation.</div>
    </article>;
  }}</Show>;
}

export function EpicList(props: { epics: any[]; query: string; selected: string | null; onSelect: (key: string) => void }) {
  const visible = () => list(props.epics).filter(e => !props.query.trim() || [e.title, e.epic, e.workspace, ...list(e.members).map(m => m.name)].some(v => str(v).toLowerCase().includes(props.query.trim().toLowerCase()))).sort((a, b) => str(a.workspace).localeCompare(str(b.workspace)) || str(a.title).localeCompare(str(b.title)));
  return <><div class="observation-rows"><Show when={visible().length} fallback={<div class="empty"><h3>{props.epics.length ? 'No matching epics' : 'No epics recorded'}</h3><p class="small" style={{ 'margin-top': '8px' }}>{props.epics.length ? 'Change the search or clear it to see every epic.' : 'Epic records provide grouped package status, dependencies and designs.'}</p></div>}><For each={visible()}>{e => { const s = epicStats(e); return <button type="button" class="run-row" data-epic={e.key} aria-pressed={e.key === props.selected} onClick={() => props.onSelect(e.key)}><div class="flex justify-between gap-3"><span class="run-title">{e.title}</span><span class="pill muted">{e.epic}</span></div><p class="summary">{s.landed}/{s.total} landed{ s.attention > 0 ? ` · ${s.attention} attention` : ''}</p></button>; }}</For></Show></div></>;
}

export function EpicDetail(props: { epic: any; onSelectPackage?: (workspace: string, name: string) => void }) {
  return <Show when={props.epic} fallback={<div class="empty"><h2>Select an epic</h2><p>Choose an epic to see its members and derived status.</p></div>} keyed>{e => {
    const s = epicStats(e), c = e.coverage || {};
    return <article class="detail"><div class="eyebrow">{text(e.workspace)} / Epic</div><div class="detail-title"><div><h2>{e.title}</h2><p class="subtitle mono">{e.epic}</p></div><span class={`pill ${e.state === 'complete' ? 'good' : 'muted'}`}>{text(e.state, 'unknown')}</span></div>
      <Show when={c.state && c.state !== 'complete'}><p class="small warn section">Epic coverage {c.state}{list(c.reasons).length ? `: ${list(c.reasons).join('; ')}` : ''}</p></Show><p class="section">{s.landed} of {s.total} landed · next {text(e.next, 'none')}{s.attention > 0 ? ` · ${s.attention} need attention` : ''}</p><Show when={e.note}><p class="small muted" style={{ 'margin-top': '8px' }}>{e.note}</p></Show>
      <section class="section"><dl class="paths"><dt class="small muted">Workspace</dt><dd class="mono">{text(e.workspace)}</dd><dt class="small muted">Record</dt><dd class="mono">{text(e.record)}</dd><dt class="small muted">Plan</dt><dd class="mono">{text(e.plan, 'No plan recorded')}</dd><dt class="small muted">Designs</dt><dd class="mono"><Show when={list(e.designs).length} fallback="No designs recorded"><For each={list(e.designs)}>{(d, index) => <>{index() ? <br /> : null}{d.workspace}/{d.design}</>}</For></Show></dd></dl></section>
      <EpicMembers epic={e} onSelectMember={props.onSelectPackage ? ((m: any) => props.onSelectPackage?.(m.workspace || e.workspace, m.package || m.name)) : undefined} /><Show when={e.summary}><section class="section"><h3>Summary</h3><Show when={typeof e.summary === 'string' || e.summary.text}><Markdown value={typeof e.summary === 'string' ? e.summary : e.summary.text} fallback="No summary recorded." /></Show><Show when={typeof e.summary === 'object' && !e.summary.text}><div class="rows"><For each={Object.entries(e.summary)}>{([label, value]) => <div class="info-row"><p>{label.replace(/_/g, ' ')}</p><small>{str(value)}</small></div>}</For></div></Show></section></Show>
    </article>;
  }}</Show>;
}
