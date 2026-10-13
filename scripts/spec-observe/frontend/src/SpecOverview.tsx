import { For, Show } from 'solid-js';
import { attention, base, runningUnconfirmed, statusMarkdown, str, time } from '../format';
import { assignmentLabel, assignmentTone, completionLabel, duration, epicStats, runState, specProgress } from '../observation-format';
import { linkedAssignmentKey, observationEnd, type ObservationContext } from '../spec-state';
import { targetRepositoryId } from '../scope';
import { StateNotice, StatusText, type StatusTone } from '../primitives';
import { formatHash } from '../route';
import type { WireRecord } from '../model';

export type SpecOverviewProps = {
  record: WireRecord;
  assignments: WireRecord[];
  context: ObservationContext;
  onOpenAgent: (key: string) => void;
  onOpenEpic: (key: string) => void;
};

const list = (value: unknown): WireRecord[] => (Array.isArray(value) ? (value as WireRecord[]) : []);
const text = (value: unknown): string => str(value).trim();
const shortId = (value: unknown): string => {
  const id = text(value);
  return id.length > 8 ? id.slice(0, 8) : id;
};
const assignmentToneFor = (assignment: WireRecord): StatusTone => {
  const tone = assignmentTone(assignment);
  return tone === 'good' ? 'success' : tone === 'warn' ? 'warning' : 'neutral';
};
const detailText = (item: WireRecord): string => str(item.summary || item.reason || item.reason_code || item.message || item.note || item.hint);

export default function SpecOverview(props: SpecOverviewProps) {
  const record = () => props.record;
  const endpoint = () => observationEnd(record(), props.context);
  const liveEnd = () => {
    const end = endpoint();
    return props.context.live && !props.context.connectionFailed && props.context.now !== null
      && end !== null && end === new Date(props.context.now!).toISOString();
  };
  const progress = () => specProgress(record());
  const progressWidth = (): number | null => {
    const value = progress();
    if (value.position === null || value.total === null || value.total <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((value.position / value.total) * 100)));
  };
  const elapsed = () => {
    const start = record().timing?.started_at;
    if (!start) return { value: 'Unknown', note: 'Start not observed' };
    const finish = record().completed_at || record().timing?.finished_at || endpoint();
    return { value: duration(start, finish), note: `Started ${time(start)}` };
  };
  const activity = () => {
    const observed = record().observed_at;
    if (!observed) return { value: 'Unknown', note: 'Observation time not recorded' };
    const span = duration(observed, endpoint());
    return { value: span === 'Unknown' ? 'Unknown' : `${span} ${liveEnd() ? 'ago' : 'before observation'}`, note: `Observed at ${time(observed)}` };
  };
  const coverageState = () => text(record().coverage?.state) || 'Unknown';
  const coverageNote = () => {
    const reason = list(record().coverage?.reasons).map(value => text(value)).find(Boolean);
    if (reason) return reason;
    const repository = targetRepositoryId(record()) ?? text(record().workspace);
    const state = text(record().observer?.snapshot?.coverage?.state) || 'unknown';
    return repository ? `${repository} · workspace ${state}` : `Workspace ${state}`;
  };
  const attentionItems = () => {
    const items: { title: string; text: string }[] = [];
    if (runningUnconfirmed(record())) items.push({ title: 'Worker activity unconfirmed', text: 'The saved run says running, but its coordinator process or checkout is unavailable. Current activity is not confirmed.' });
    for (const condition of list(record().conditions)) {
      if (condition.severity === 'attention' && condition.state !== 'resolved' && (condition.kind !== 'action-outcome-unknown' || condition.current === true)) {
        items.push({ title: text(condition.kind || condition.state) || 'Attention condition', text: detailText(condition) || 'No condition detail was recorded.' });
      }
    }
    for (const incident of list(record().incidents)) {
      if (incident.state === 'open') items.push({ title: text(incident.kind || incident.state) || 'Open incident', text: detailText(incident) || 'No incident detail was recorded.' });
    }
    if (!items.length && attention(record())) items.push({ title: runState(record(), runningUnconfirmed), text: text(record().activity || record().obligation) || 'No further detail was recorded.' });
    return items;
  };
  const linkedAssignment = () => {
    const key = linkedAssignmentKey(record(), props.assignments);
    return key ? props.assignments.find(assignment => assignment.key === key) ?? null : null;
  };
  const relatedEpic = () => {
    const reference = record().epic;
    if (!reference || !reference.epic) return null;
    return list(record().observer?.snapshot?.epics).find(epic => epic.epic === reference.epic && (reference.workspace == null || epic.workspace === reference.workspace)) ?? null;
  };
  const epicPosition = () => {
    const epic = relatedEpic();
    if (!epic) return null;
    const members = list(epic.members);
    const index = members.findIndex(member => (member.package ?? member.name) === base(record().package) && (member.workspace == null || member.workspace === record().workspace));
    return index >= 0 ? { position: index + 1, total: members.length } : null;
  };
  const epicTitle = (epic: WireRecord): string => {
    const position = epicPosition();
    return `${text(epic.title) || text(epic.epic)}${position ? ` · member ${position.position} of ${position.total}` : ''}`;
  };
  const epicKey = (epic: WireRecord): string => JSON.stringify([epic.workspace, epic.epic]);
  const evidence = () => {
    const value = record().evidence;
    if (!value || !value.state) return 'Accepted steps not observed';
    if (value.state === 'recorded') {
      const verdict = text(value.verdict);
      const commit = text(value.commit);
      return `${verdict ? `Declared ${verdict}` : 'Declared evidence'}${commit ? ` at commit ${commit}` : ''}`;
    }
    if (value.state === 'unavailable') return 'Declared artifact unavailable';
    return 'Accepted steps not observed';
  };
  return <>
    <div class="progress-head">
      <strong>{progress().label}{progress().name ? ` · ${progress().name}` : ''}</strong>
      <span class="muted">Position, not acceptance</span>
    </div>
    <div
      class="progress-track"
      role="progressbar"
      aria-label="Prepared step position"
      aria-valuemin="0"
      aria-valuemax={progress().total ?? 1}
      aria-valuenow={progress().position ?? undefined}
      aria-valuetext={progress().label}
    >
      <Show when={progressWidth() !== null}>
        <div class="progress-value" style={{ width: `${progressWidth()}%` }} />
      </Show>
    </div>
    <section class="section">
      <div class="section-heading">
        <h3>{record().recent_completion ? 'Recorded final obligation' : 'Current obligation'}</h3>
        <Show when={record().recent_completion}><span class="muted">{completionLabel(record())}</span></Show>
      </div>
      <div class="obligation"><div class="status-markdown" innerHTML={statusMarkdown(text(record().obligation) || 'No obligation summary was observed.')} /></div>
    </section>
    <Show when={record().recent_completion}>
      <p class="small muted">Completed {time(record().completed_at)}</p>
    </Show>
    <div class="facts">
      <div class="fact"><label>{liveEnd() ? 'Time since spec start' : 'Elapsed at observation'}</label><strong class="mono">{elapsed().value}</strong><p>{elapsed().note}</p></div>
      <div class="fact"><label>Last activity</label><strong class="mono">{activity().value}</strong><p>{activity().note}</p></div>
      <div class="fact"><label>Run coverage</label><strong class={coverageState() === 'complete' ? 'good' : 'warn'}>{coverageState()}</strong><p>{coverageNote()}</p></div>
    </div>
    <Show when={attentionItems().length}>
      <section class="section">
        <div class="section-heading"><h3>Needs attention</h3></div>
        <For each={attentionItems()}>{item => <StateNotice tone="warning" title={item.title}>{item.text}</StateNotice>}</For>
      </section>
    </Show>
    <section class="section">
      <div class="section-heading"><h3>Related work</h3></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th scope="col">Object</th><th scope="col">Status</th></tr></thead>
          <tbody>
            <tr>
              <td>
                <Show when={linkedAssignment()} fallback={<span>{text(record().assignment_id) ? `Assignment ${shortId(record().assignment_id)}` : 'Assignment'}</span>}>
                  {assignment => <a
                    class="text-link"
                    href={formatHash({ dest: 'agents', id: linkedAssignmentKey(record(), props.assignments) ?? undefined })}
                    onClick={event => {
                      event.preventDefault();
                      const key = linkedAssignmentKey(record(), props.assignments);
                      if (key) props.onOpenAgent(key);
                    }}
                  >Assignment {shortId(assignment().assignment_id)}</a>}
                </Show>
              </td>
              <td>
                <Show when={linkedAssignment()} fallback="Not recorded">
                  {assignment => <StatusText tone={assignmentToneFor(assignment())}>{assignmentLabel(assignment())}</StatusText>}
                </Show>
              </td>
            </tr>
            <tr>
              <td>
                <Show when={relatedEpic()} fallback={<span>{text(record().epic?.epic) ? `Epic ${text(record().epic.epic)}` : 'Epic'}</span>}>
                  {epic => <a
                    class="text-link"
                    href={formatHash({ dest: 'epics', id: epicKey(epic()) })}
                    onClick={event => {
                      event.preventDefault();
                      props.onOpenEpic(epicKey(epic()));
                    }}
                  >{epicTitle(epic())}</a>}
                </Show>
              </td>
              <td>
                <Show when={relatedEpic()} fallback={text(record().epic?.epic) ? 'Epic record unavailable in this snapshot' : 'Not recorded'}>
                  {epic => `${epicStats(epic()).landed} of ${epicStats(epic()).total} landed`}
                </Show>
              </td>
            </tr>
            <tr>
              <td>Evidence</td>
              <td>{evidence()}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </>;
}
