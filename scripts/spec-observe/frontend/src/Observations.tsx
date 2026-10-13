import { For, Show } from 'solid-js';
import { age, base, inlineMarkdown, statusMarkdown, str, time } from './format';
import { assignmentEnded, assignmentLabel, assignmentTone, epicMemberTone, epicStats } from './observation-format';

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
  const visible = () => list(props.assignments).filter(a => !props.query.trim() || [a.assignment_id, a.spec_package, a.workflow_id, a.display, a.nextAction, a.safeAction].some(v => str(v).toLowerCase().includes(props.query.trim().toLowerCase()))).sort((a, b) => Number(assignmentEnded(a)) - Number(assignmentEnded(b)) || str(a.spec_package).localeCompare(str(b.spec_package)) || str(a.assignment_id).localeCompare(str(b.assignment_id)));
  const active = () => visible().filter(a => !assignmentEnded(a)), ended = () => visible().filter(assignmentEnded);
  const row = (a: any) => <button type="button" class="run-row" data-assignment-key={a.key} aria-pressed={a.key === props.selected} onClick={() => props.onSelect(a.key)}><div class="flex justify-between gap-3"><span class="run-title mono">{a.assignment_id}</span><span class={`pill ${assignmentTone(a)}`}>{assignmentLabel(a)}</span></div><p class="summary">{a.nextAction || a.safeAction || 'No safe action recorded'}{a.quiet ? ' · Quiet' : ''}{a.attachedCount ? ` · ${a.attachedCount} attached` : ''}</p><span class="small muted">{a.spec_package ? base(a.spec_package) : 'No spec package'} · {age(a.observer?.snapshot?.coverage?.observed_at || a.observer?.published_at)}</span><Show when={list(a.attention).length}><p class="small warn">{list(a.attention).slice(0, 2).join(' · ')}</p></Show></button>;
  return <><Show when={list(props.assignments).some(a => a.assignment_coverage?.state === 'partial')}><div class="coverage-note">Assignment coverage partial</div></Show><div class="observation-rows"><Show when={visible().length} fallback={<div class="empty"><h3>{props.assignments.length ? 'No matching agents' : 'No agents observed'}</h3><p class="small" style={{ 'margin-top': '8px' }}>{props.assignments.length ? 'Change the search.' : 'An absent assignment snapshot differs from an empty one; assignment coverage explains partial reads.'}</p></div>}><For each={active()}>{row}</For><Show when={ended().length}><div class="repo-heading">Recently ended</div><For each={ended()}>{row}</For></Show></Show></div></>;
}
