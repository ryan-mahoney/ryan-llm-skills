import SessionPanel from './SessionPanel';
import RelaunchAssignment from './RelaunchAssignment';
import { For, Show } from 'solid-js';
import { age, base, inlineMarkdown, statusMarkdown, str, time } from './format';
import { assignmentEnded, assignmentLabel, assignmentTone, epicMemberTone, epicStats, packageViewUrl } from './observation-format';

const list = (v: any) => Array.isArray(v) ? v : [];
const text = (v: any, fallback = 'Unknown') => typeof v === 'string' && v ? v : fallback;
const Markdown = (props: { value: any; class?: string; fallback: string }) => <div class={`status-markdown ${props.class || ''}`} innerHTML={statusMarkdown(props.value || props.fallback)} />;

function EpicMembers(props: { epic: any; current?: any; records?: any[]; onSelect?: (key: string) => void; onSelectMember?: (member: any) => void }) {
  const members = () => list(props.epic.members);
  const memberMatches = (m: any, packagePath: unknown, workspace: unknown) => {
    const canonical = str(m.package).trim();
    const matches = canonical ? canonical === str(packagePath).trim() : str(m.name).trim() === base(packagePath);
    return matches && (m.workspace == null || m.workspace === workspace);
  };
  const matchingRecord = (m: any) => list(props.records).filter(r => memberMatches(m, r.package, r.workspace)).sort((a, b) => Number(b.is_current_assignment === true) - Number(a.is_current_assignment === true))[0];
  return <section class="section"><div class="section-head"><h3>Epic members</h3><span class="small muted">{members().length} recorded</span></div>
    <Show when={members().length} fallback={<p class="small muted">No members recorded.</p>}>
      <div class="timing-scroll"><table class="timing-table epic-table"><caption class="sr-only">Members of {props.epic.title}</caption><thead><tr><th scope="col">Member</th><th scope="col">Status</th><th scope="col">Step</th><th scope="col">Waiting on</th><th scope="col">Note</th></tr></thead><tbody><For each={members()}>{m => {
        const here = props.current && memberMatches(m, props.current.package, props.current.workspace);
        const rec = !here ? matchingRecord(m) : null;
        return <tr aria-current={here ? 'true' : undefined}><th scope="row"><Show when={props.onSelectMember} fallback={<Show when={rec && props.onSelect} fallback={<>{m.name}</>}><button type="button" onClick={() => { if (rec) props.onSelect?.(rec.key); }}>{m.name}</button></Show>}><button type="button" onClick={() => props.onSelectMember?.(m)}>{m.name}</button></Show><Show when={here}><small class="muted">This package</small></Show></th><td><span class={`pill ${epicMemberTone(m)}`}>{str(m.status || 'unknown').replace(/-/g, ' ')}{m.attention === true ? ' · attention' : ''}</span></td><td>{m.step && m.step.position != null ? `${m.step.position} of ${m.step.total ?? 'unknown'}` : '—'}</td><td>{list(m.waiting_on).join(', ') || '—'}</td><td>{m.note || '—'}</td></tr>;
      }}</For></tbody></table></div>
    </Show>
    <p class="small muted" style={{ 'margin-top': '10px' }}>Status is derived from each package's files. It is lifecycle, not acceptance.</p>
  </section>;
}

export function AgentList(props: { assignments: any[]; query: string; selected: string | null; onSelect: (key: string) => void }) {
  // The shared visibleAgents owner settles search and order before this
  // transitional list: render the supplied rows verbatim without
  // re-filtering (execution_dir included) or re-sorting (uncertain first).
  // The group split below only preserves the ended section heading and
  // keeps supplied order within each group.
  const rows = () => list(props.assignments);
  const active = () => rows().filter(a => !assignmentEnded(a)), ended = () => rows().filter(assignmentEnded);
  const row = (a: any) => <button type="button" class="run-row" data-assignment-key={a.key} aria-pressed={a.key === props.selected} onClick={() => props.onSelect(a.key)}><div class="flex justify-between gap-3"><span class="run-title mono">{a.assignment_id}</span><span class={`pill ${assignmentTone(a)}`}>{assignmentLabel(a)}</span></div><p class="summary">{a.nextAction || a.safeAction || 'No safe action recorded'}{a.quiet ? ' · Quiet' : ''}{a.attachedCount ? ` · ${a.attachedCount} attached` : ''}</p><span class="small muted">{a.spec_package ? base(a.spec_package) : 'No spec package'} · {age(a.observer?.snapshot?.coverage?.observed_at || a.observer?.published_at)}</span><Show when={list(a.attention).length}><p class="small warn">{list(a.attention).slice(0, 2).join(' · ')}</p></Show></button>;
  return <><Show when={list(props.assignments).some(a => a.assignment_coverage?.state === 'partial')}><div class="coverage-note">Assignment coverage partial</div></Show><div class="observation-rows"><Show when={rows().length} fallback={<div class="empty"><h3>{props.assignments.length ? 'No matching agents' : 'No agents observed'}</h3><p class="small" style={{ 'margin-top': '8px' }}>{props.assignments.length ? 'Change the search.' : 'An absent assignment snapshot differs from an empty one; assignment coverage explains partial reads.'}</p></div>}><For each={active()}>{row}</For><Show when={ended().length}><div class="repo-heading">Recently ended</div><For each={ended()}>{row}</For></Show></Show></div></>;
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
      <Show when={a().spec_package && a().skill === 'spec-end-to-end'}><RelaunchAssignment assignment={a()} token={props.token} live={props.live}/></Show>
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
