import ExecutionOutline from './ExecutionOutline';
import { executionSummary, recordedRuns, packageAttempts } from './execution-state';
import { For, Show } from 'solid-js';
import { inlineMarkdown, rows, statusMarkdown, str, terminal, time } from './format';
import { duration } from './observation-format';
import { observationEnd, packageRelative, type ObservationContext } from './spec-state';
import { EmptyState, StateNotice, StatusText, type StatusTone } from './primitives';
import type { WireRecord } from './model';

const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, fallback = 'Unknown'): string => str(value).trim() || fallback;

const attemptTone = (state: unknown): StatusTone => {
  const value = str(state).toLowerCase();
  if (['completed', 'complete', 'done', 'closed'].includes(value)) return 'success';
  if (['failed', 'cancelled', 'aborted', 'stale', 'stopped'].includes(value)) return 'warning';
  if (value === 'running') return 'info';
  return 'neutral';
};
const workerTone = (state: unknown): StatusTone => ['running', 'unconfirmed', 'unknown'].includes(str(state).toLowerCase()) ? 'warning' : 'neutral';
const evidenceTone = (state: unknown): StatusTone => str(state) === 'recorded' ? 'success' : str(state) === 'unavailable' ? 'warning' : 'neutral';
// A null omission count is unknown, not zero.
const omissionCount = (coverage: any): string => Number.isFinite(coverage?.omitted) ? `omitted ${coverage.omitted}` : 'omitted unknown';

const hasEvidenceFacts = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (['recorded', 'unavailable'].includes(str(item.state))) return true;
  return ['verdict', 'source', 'commit', 'reason'].some(key => Boolean(str(item[key])));
};

// The empty-activity branch is owned here so the destination can keep one
// primary action when the EmptyState already carries it.
export function hasActivityFacts(record: WireRecord): boolean {
  return Boolean(executionSummary(record)) || list(record?.run_records).some(run => list(run.timing?.attempts).length > 0) || list(record?.timing?.attempts).length > 0
    || list(record?.workflow_workers).length > 0
    || hasEvidenceFacts(record?.evidence)
    || list(record?.conditions).length > 0
    || list(record?.incidents).length > 0
    || list(record?.actions).length > 0;
}

export type SpecActivityProps = {
  record: WireRecord;
  context: ObservationContext;
  onOpenFile: (path: string) => void;
  recoveryPrimary?: boolean;
  onOpenAgent?: (assignmentId: string) => void;
};

export default function SpecActivity(props: SpecActivityProps) {
  const record = () => props.record;
  const attempts = () => packageAttempts(record());
  const workers = () => list(record().workflow_workers);
  const evidence = () => record().evidence && typeof record().evidence === 'object' ? record().evidence : null;
  const runCoverage = () => record().coverage;
  const snapshotCoverage = () => record().observer?.snapshot?.coverage;
  const completionHistory = () => record().observer?.snapshot?.completion_history;
  const scopeLabel = () => str(record().observer?.snapshot?.workspace) || str(record().observer?.observer_id) || str(record().observer?.source) || 'Workspace';
  const checkpoint = () => time(record().workflow_observed_at);
  // finished_at wins; a terminal attempt without it stays Unknown; only an
  // ongoing attempt uses the shared fixed observation endpoint.
  const attemptEnd = (attempt: any): string | null => {
    if (attempt.finished_at) return attempt.finished_at;
    if (terminal.has(attempt.state)) return null;
    return observationEnd(record(), props.context);
  };
  const attemptDuration = (attempt: any): string => {
    const span = duration(attempt.started_at, attemptEnd(attempt));
    return !attempt.finished_at && !terminal.has(attempt.state) && span !== 'Unknown' ? `${span} elapsed` : span;
  };
  const sourceLink = (path: unknown): { label: string; relative: string | null } => {
    const raw = str(path);
    const inside = packageRelative(record(), raw);
    if (inside !== null) return { label: raw, relative: inside };
    if (!raw || raw.startsWith('/') || raw.split('/').includes('..')) return { label: raw || 'Path unknown', relative: null };
    return { label: raw, relative: raw };
  };
  const evidenceSentence = (): string => {
    const item = evidence();
    if (!item) return 'No declared artifact was assessed. Accepted-step completion was not observed.';
    if (str(item.state) === 'recorded') {
      const verdict = str(item.verdict);
      const commit = str(item.commit);
      return `Declared ${verdict || 'evidence'}${commit ? ` at commit ${commit}` : ''}. Accepted-step completion was not observed.`;
    }
    return str(item.state) === 'unavailable'
      ? 'Declared artifact is unavailable. Accepted-step completion was not observed.'
      : 'No declared artifact was assessed. Accepted-step completion was not observed.';
  };
  const evidenceDetail = (item: any): string => {
    const source = text(item.source, 'Not recorded');
    const scope = text(item.scope, 'Not recorded');
    const observed = item.observed_at ? ` · ${time(item.observed_at)}` : '';
    const reason = str(item.reason);
    return `${source} · scope ${scope}${observed}${reason ? ` · ${reason}` : ''}`;
  };
  const full = () => (
    <>
      <Show when={executionSummary(record())} fallback={<>
      <section class="section">
        <div class="section-heading"><h3>Step attempts</h3></div>
        <Show when={attempts().length} fallback={<p class="small muted">Step timing has not been observed yet.</p>}>
          <div class="table-wrap">
            <table>
              <thead><tr><th scope="col">Step / attempt</th><th scope="col">State</th><th scope="col" class="numeric">Duration</th></tr></thead>
              <tbody>
                <For each={attempts()}>{(attempt, index) => {
                  const ordinal = () => attempts().slice(0, index() + 1).filter(item => item.step === attempt.step).length;
                  return <tr>
                    <td>
                      <strong>{attempt.step != null ? `Step ${attempt.step}${attempt.name ? ` · ${attempt.name}` : ''}` : 'Step unknown'}</strong>
                      <span class="muted">Attempt {ordinal()} · {text(attempt.attempt_kind, 'Reason not recorded')}</span>
                    </td>
                    <td>
                      <StatusText tone={attemptTone(attempt.state)}>{text(attempt.state)}</StatusText>
                      <Show when={attempt.handoff_outcome}><span class="muted">Handoff: {attempt.handoff_outcome}</span></Show>
                    </td>
                    <td class="numeric"><span class="mono">{attemptDuration(attempt)}</span></td>
                  </tr>;
                }}</For>
              </tbody>
            </table>
          </div>
          <p class="small muted" style={{ 'margin-top': '12px' }}>From first recorded dispatch; includes waits and verification. Each assignment is shown separately; completed execution does not imply accepted work. Missing timing stays unknown.</p>
        </Show>
      </section>
      </>}>
        <ExecutionOutline record={record()} context={props.context} activity onOpenFile={props.onOpenFile} onOpenAgent={props.onOpenAgent} />
      </Show>
      <Show when={record().package_aggregate}><section class="section"><div class="section-heading"><h3>Run history</h3></div><For each={recordedRuns(record())}>{run => <details class="execution-run-history"><summary><span class="mono">{run.run_id || run.assignment_id || 'Run identity unknown'}</span> · {str(run.execution) || 'Unknown'}</summary><p class="small muted">{str(run.activity || run.obligation) || 'No activity summary recorded.'}</p><For each={packageAttempts(record()).filter(attempt => attempt.assignment_id ? attempt.assignment_id === run.assignment_id : attempt.run_id ? attempt.run_id === run.run_id : recordedRuns(record())[0] === run)}>{attempt => <p class="small">{attempt.step != null ? `Step ${attempt.step}` : 'Package activity'} · {text(attempt.attempt_kind, 'Phase unknown')} · {text(attempt.state)} · {attemptDuration(attempt)} worker duration</p>}</For></details>}</For></section></Show>
      <section class="section">
        <div class="section-heading"><h3>Unfinished worker</h3></div>
        <Show when={workers().length} fallback={<p class="small muted">No unfinished workers recorded in this snapshot.</p>}>
          <div class="table-wrap">
            <table>
              <thead><tr><th scope="col">Worker</th><th scope="col">Recorded state</th></tr></thead>
              <tbody>
                <For each={workers()}>{worker => <tr>
                  <td>
                    <span class="mono">{text(worker.kind, 'Worker')} · {text(worker.id, 'id unknown')}</span>
                    <span class="muted">Checkpoint {checkpoint()}</span>
                  </td>
                  <td><StatusText tone={workerTone(worker.state)}>{text(worker.state)}</StatusText></td>
                </tr>}</For>
              </tbody>
            </table>
          </div>
        </Show>
        <p class="small muted" style={{ 'margin-top': '12px' }}>Recorded state, not a live process check.</p>
      </section>
      <section class="section">
        <div class="section-heading"><h3>Evidence</h3><StatusText tone={evidenceTone(evidence()?.state)}>{text(evidence()?.state, 'unknown')}</StatusText></div>
        <StateNotice tone="warning" title="Acceptance not established">{evidenceSentence()}</StateNotice>
        <Show when={evidence()} fallback={<p class="small muted">No declared evidence was observed in this snapshot.</p>}>
          {item => <p class="small muted">{evidenceDetail(item())}</p>}
        </Show>
        <p class="small muted">Declared artifact scope only; this never proves the current checkout, merge or deployment.</p>
      </section>
      <Show when={list(record().conditions).length}>
        <section class="section">
          <div class="section-heading"><h3>Conditions</h3><span class="small muted">{list(record().conditions).length} observed</span></div>
          <div innerHTML={rows(list(record().conditions), 'Conditions')} />
        </section>
      </Show>
      <section class="section">
        <div class="section-heading"><h3>Verification incidents</h3><span class="small muted">{list(record().incidents).length} recorded</span></div>
        <div innerHTML={rows(list(record().incidents), 'Incidents')} />
      </section>
      <section class="section">
        <div class="section-heading"><h3>Recorded actions</h3><span class="small muted">Read-only</span></div>
        <Show when={list(record().actions).length} fallback={<p class="small muted">No automatic recovery action was recorded for this observation.</p>}>
          <div innerHTML={rows(list(record().actions), 'Actions')} />
        </Show>
      </section>
    </>
  );
  return <>
    <Show when={hasActivityFacts(record())} fallback={<>
      <EmptyState
        symbol="◇"
        title={record().planned ? 'No run recorded' : 'No attempts recorded'}
        text={record().planned ? 'This package is planned. Implementation activity appears after the first run is observed.' : 'Attempt timing and evidence are not present in this observation. Read the canonical spec for its obligations.'}
        action={<button type="button" class={props.recoveryPrimary ? 'ds-btn' : 'ds-btn ds-btn--primary'} onClick={() => props.onOpenFile('spec.md')}>Open spec file</button>}
      />
      <section class="section">
        <div class="section-heading"><h3>{record().recent_completion ? 'Final recorded obligation' : 'Current obligation'}</h3></div>
        <div class="obligation"><div class="status-markdown" innerHTML={statusMarkdown(text(record().obligation, 'No obligation summary was observed.'))} /></div>
      </section>
    </>}>
      {full()}
    </Show>
    <details id="spec-coverage" open>
      <summary>Coverage and source paths</summary>
      <div class="coverage-detail" style={{ 'padding': '4px 0 12px' }}>
        <p class="small muted">Observation {time(snapshotCoverage()?.observed_at)}</p>
        <p><strong>Run coverage</strong> {text(runCoverage()?.state)}</p>
        <For each={list(runCoverage()?.reasons)}>{reason => <p class="coverage-note"><span innerHTML={inlineMarkdown(reason)} /></p>}</For>
        <p><strong>{scopeLabel()} coverage</strong> {text(snapshotCoverage()?.state)} · {omissionCount(snapshotCoverage())}</p>
        <For each={list(snapshotCoverage()?.reasons)}>{reason => <p class="coverage-note"><span innerHTML={inlineMarkdown(reason)} /></p>}</For>
        <p><strong>Completion history</strong> {omissionCount(completionHistory())}</p>
        <For each={list(completionHistory()?.reasons)}>{reason => <p class="coverage-note"><span innerHTML={inlineMarkdown(reason)} /></p>}</For>
        <p><strong>Canonical package</strong> <span class="mono">{text(record().package)}</span></p>
        <div class="section-heading" style={{ 'margin-top': '18px' }}>
          <h3>Source paths</h3>
          <span class="small muted">{list(record().source_paths).length} recorded</span>
        </div>
        <Show when={list(record().source_paths).length} fallback={<p class="small muted">No source paths recorded.</p>}>
          <For each={list(record().source_paths)}>{path => {
            const link = sourceLink(path);
            return <p class="mono path" style={{ margin: '8px 0' }}>{link.relative !== null
              ? <button class="ds-btn mono" style={{ 'white-space': 'normal', 'overflow-wrap': 'anywhere', 'max-width': '100%' }} type="button" onClick={() => props.onOpenFile(link.relative!)}>{link.label}</button>
              : <span>{link.label}</span>}</p>;
          }}</For>
        </Show>
      </div>
    </details>
  </>;
}
