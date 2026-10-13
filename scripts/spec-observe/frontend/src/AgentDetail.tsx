import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { agentGuidance } from './agent-state';
import type { AgentViewState } from './agent-state';
import { specRecordFor, specRoute, workTourRoute } from './agent-links';
import { copyText } from './clipboard';
import SessionPanel from './SessionPanel';
import { ActionBar, StateNotice, StatusText } from './primitives';
import type { StatusTone } from './primitives';
import { age, inlineMarkdown, time } from './format';
import { assignmentLabel, assignmentTone } from './observation-format';
import type { WireRecord } from './model';
import type { RouteState } from './route';

const list = (value: any): any[] => (Array.isArray(value) ? value : []);
// Null or missing projection fields stay explicit; they are never rendered as
// a fabricated state.
const text = (value: any, fallback = 'Not included in this observation'): string =>
  typeof value === 'string' && value ? value : fallback;
// Recorded/observed states read as sentence-case facts in the detail head;
// missing values keep the explicit null-field wording.
const displayState = (value: any): string =>
  typeof value === 'string' && value ? value.charAt(0).toUpperCase() + value.slice(1) : 'Not included in this observation';
const statusTone = (tone: string): StatusTone => (tone === 'good' ? 'success' : tone === 'warn' ? 'warning' : 'neutral');
// The assignment projection publishes coverage as a state string; legacy
// saved fixtures may still carry an object with a state field.
const coverageState = (value: any): string =>
  typeof value === 'string' && value
    ? value
    : typeof value?.state === 'string' && value.state
      ? value.state
      : 'unknown';

export type AgentDetailProps = {
  assignment: any;
  records: WireRecord[];
  token?: string;
  live: boolean;
  refresh: () => Promise<void>;
  onEnded: (id: string) => void;
  onNavigate: (next: RouteState) => void;
  ws?: string;
  routeQuery?: string;
  view: AgentViewState;
  sourceUnavailable: boolean;
  listPartial: boolean;
  retained?: boolean;
  selectedObservedAt: string | null;
  connectionFailed: boolean;
  observationStale: boolean;
  onRetryConnection: () => void;
  onDetailScroll?: () => void;
  detailBodyRef?: (el: HTMLDivElement) => void;
};

export default function AgentDetail(props: AgentDetailProps) {
  return (
    <Show
      when={props.assignment?.key}
      fallback={
        <div class="empty">
          <h2>Select an observed agent</h2>
          <p>Choose an assignment to inspect execution, lifecycle and declared evidence.</p>
        </div>
      }
    >
      <AgentDetailBody {...props} />
    </Show>
  );
}

function AgentDetailBody(props: AgentDetailProps) {
  let heading!: HTMLHeadingElement;
  let locateEl!: HTMLTextAreaElement;
  const [copyStatus, setCopyStatus] = createSignal('');

  const a = () => props.assignment;
  const o = () => a().observer;
  // Assignment coverage facts come from the owning observer's snapshot, then
  // the projected row; they are never re-derived from unrelated observers.
  const ac = () => o()?.snapshot?.assignment_coverage || a().assignment_coverage;
  const related = () => specRecordFor(a(), props.records);
  const run = () => related()?.record ?? null;
  // A linked run is held when it is explicitly user-held or carries an
  // unresolved hold condition; recovery-mode observers must not act then.
  const hold = () =>
    run()?.workflow_state === 'user-held' ||
    list(run()?.conditions).some(
      (c: any) => c.state !== 'resolved' && (c.kind === 'user-held' || c.kind === 'hold-active' || String(c.kind || '').includes('hold')),
    );
  const runQualifier = (): string => (related()?.match === 'package' ? ' · package-level; not this assignment' : '');
  const specTarget = (): RouteState | null => {
    const match = related();
    return match ? specRoute(match.record, props.ws) : null;
  };
  const tourTarget = (): RouteState | null => {
    const match = related();
    return match ? workTourRoute(match.record, props.ws) : null;
  };
  const guidance = () => agentGuidance(a(), related() !== null);
  const locate = (): string | null =>
    typeof a().locate_command === 'string' && a().locate_command ? a().locate_command : null;
  const recovery = (): 'Retry state' | 'Retry connection' | 'Refresh state' | null => {
    if (props.view === 'error' && props.sourceUnavailable) return 'Retry state';
    if (props.view === 'offline') return 'Retry connection';
    if (props.live && props.observationStale) return 'Refresh state';
    return null;
  };
  // A source-unavailable read retains the last-known identity but cannot
  // confirm the selected assignment; current status facts must not read as a
  // current observation.
  const sourceUnconfirmed = () => props.view === 'error' && props.sourceUnavailable;
  // A retained row is the last-known saved observation: it qualifies status
  // and facts exactly like a source-unavailable read, and no recovery copy
  // may let the saved facts read as current.
  const retained = () => props.retained === true;
  const lastKnown = () => retained() || sourceUnconfirmed();
  const safeAction = (): { headline: string; caution?: string } => {
    if (retained())
      return {
        headline: 'The latest incomplete read did not include this assignment; its retained identity is last-known.',
        caution: 'Do not start another writer while this assignment’s liveness is uncertain; the retained identity is not a current observation.',
      };
    if (sourceUnconfirmed())
      return {
        headline: 'The source cannot confirm this assignment in the latest read.',
        caution: 'Run the explicit locate command below before considering another writer; the retained identity is last-known, not a current observation.',
      };
    return { headline: guidance().headline || 'No safe action recorded', caution: guidance().caution };
  };
  const coverageReasons = (): string[] =>
    [...new Set([...list(a().coverageReasons), ...list(ac()?.reasons)].filter((value): value is string => typeof value === 'string' && value !== ''))];
  // One qualification or recovery notice at most, highest-confidence first.
  // A retained row appends the last-known qualification to whichever notice
  // is shown and never borrows freshness from the latest attempt.
  const notice = (): { title: string; body: string } | null => {
    const qualifier = retained()
      ? ' This row is the last-known retained identity, not a current observation.'
      : '';
    if (recovery() === 'Retry state')
      return {
        title: 'Source unavailable',
        body: `Assignment coverage could not be read${props.selectedObservedAt ? ` as of ${time(props.selectedObservedAt)}` : ''}. The selected assignment is retained; no process failure has been inferred.${qualifier}`,
      };
    if (recovery() === 'Retry connection')
      return {
        title: 'Connection unavailable',
        body: `Last received at ${time(props.selectedObservedAt)}. These records may have changed on the host.${qualifier}`,
      };
    if (recovery() === 'Refresh state')
      return { title: `Last checked at ${time(props.selectedObservedAt)}`, body: `Existing content is kept while the host revalidates it.${qualifier}` };
    if (a().unrecorded)
      return {
        title: 'Identity and record disagree',
        body: `The terminal is missing, but a matching process may still exist; this assignment has not been marked ended. Reconcile with the explicit locate command below.${qualifier}`,
      };
    if (a().workersUnconfirmed)
      return {
        title: 'Workers unconfirmed',
        body: `The linked run is recorded as running but its coordinator process is gone; inspect recorded workers before considering another writer.${qualifier}`,
      };
    if (props.listPartial)
      return {
        title: 'Assignment coverage incomplete',
        body: `${coverageReasons().length ? coverageReasons().join(' · ') : 'One or more observers returned an incomplete assignment read.'}${qualifier}`,
      };
    if (retained())
      return {
        title: 'Last-known observation',
        body: 'This assignment was not included in the latest incomplete read; its retained identity is last-known, not a current observation.',
      };
    return null;
  };

  const attachedCount = () => (typeof a().attachedCount === 'number' ? a().attachedCount : null);
  const quietState = () =>
    typeof a().quiet === 'boolean' ? (a().quiet ? 'Quiet' : 'Active or not observed') : 'Not included in this observation';
  const responseLabel = () => {
    const activity = a().task_activity;
    if (!activity || typeof activity.state !== 'string' || activity.state === 'unknown') return 'Not included in this observation';
    return ({ idle: 'Idle · response finished', working: 'Working', interrupted: 'Response interrupted' } as Record<string, string>)[activity.state] || activity.state;
  };

  const openSpecPrimary = () => recovery() === null && guidance().primary === 'open-spec' && specTarget() !== null;
  const copyPrimary = () => recovery() === null && guidance().primary === 'copy-locate' && locate() !== null;

  // Focus follows identity changes only; polls keep the same key and never
  // steal focus from the operator.
  createEffect(on(() => a()?.key, (key, previous) => {
    if (key && previous !== undefined && key !== previous) heading?.focus();
  }, { defer: true }));

  async function copyLocate() {
    const command = locate();
    if (!command) return;
    const result = await copyText(command, locateEl);
    setCopyStatus(result === 'copied' ? 'Locate command copied.' : 'Select and copy the command, then paste it into your terminal.');
  }

  // Confirmed end: record the ended session first, then select the same
  // observed key under the Ended filter. Filter and query are not history
  // fields, so App replaces the current entry; ws and q are preserved and
  // no reload occurs.
  function showEndedSession(id: string) {
    props.onEnded(id);
    const next: RouteState = { dest: 'agents', filter: 'ended', id: a().key };
    if (props.ws !== undefined) next.ws = props.ws;
    if (props.routeQuery) next.q = props.routeQuery;
    props.onNavigate(next);
  }

  return (
    <article class="detail agent-detail" data-key={a().key}>
      <div class="object-head">
        <div class="object-top detail-title">
          <h2 class="mono" tabindex={-1} ref={heading} title={a().assignment_id}>{a().assignment_id}</h2>
          <Show
            when={lastKnown()}
            fallback={<StatusText tone={statusTone(assignmentTone(a()))}>{assignmentLabel(a())}</StatusText>}
          >
            <StatusText tone="neutral">Not confirmed</StatusText>
          </Show>
        </div>
        <p class="subtitle mono">{text(a().spec_package, 'No spec package')} · {text(a().workflow_id, 'Workflow unknown')}</p>
      </div>
      <div class="detail-body" ref={el => props.detailBodyRef?.(el)} onScroll={() => props.onDetailScroll?.()}>
        <Show when={notice()}>
          {value => <StateNotice tone="warning" title={value().title}>{value().body}</StateNotice>}
        </Show>
        <section class="section">
          <div class="section-head"><h3>Safe next action</h3></div>
          <div class="obligation">
            {safeAction().headline}
            <Show when={safeAction().caution}><p>{safeAction().caution}</p></Show>
          </div>
        </section>
        <Show when={!lastKnown()}>
          <div class="facts">
            <div class="fact"><label>Recorded state</label><strong>{displayState(a().recordedState)}</strong><p>Saved assignment record</p></div>
            <div class="fact"><label>Observed state</label><strong>{displayState(a().observedState)}</strong><p>Presence only; no control.</p></div>
            <div class="fact"><label>Response</label><strong>{responseLabel()}</strong><p>{a().task_activity?.reason || 'No response state observed.'}</p></div>
            <div class="fact"><label>Attached clients</label><strong>{attachedCount() === null ? 'Not included in this observation' : String(attachedCount())}</strong><p>Presence only; zero clients never releases the directory.</p></div>
            <div class="fact"><label>Session activity</label><strong>{quietState()}</strong><p>Quiet is informational.</p></div>
          </div>
        </Show>
        <section class="section">
          <Show
            when={lastKnown()}
            fallback={<div class="section-head"><h3>Execution</h3><span class="small muted">Read-only observation</span></div>}
          >
            <div class="section-head"><h3>Last-known execution identity</h3><span class="small muted">Not the current observation</span></div>
          </Show>
          <div class="table-wrap">
            <table>
              <thead><tr><th scope="col">Fact</th><th scope="col">Observed value</th></tr></thead>
              <tbody>
                <tr><td>Workspace</td><td>{text(o()?.snapshot?.workspace || a().workspace)}</td></tr>
                <tr><td>Execution directory</td><td class="mono path">{text(a().execution_dir ?? a().executionDir)}</td></tr>
                <tr><td>Repository</td><td class="mono path">{text(a().repository_id)}</td></tr>
                <tr><td>Workflow</td><td class="mono">{text(a().workflow_id, 'Workflow unknown')}</td></tr>
                <tr><td>Spec package</td><td class="mono">{text(a().spec_package, 'No spec package')}</td></tr>
                <tr><td>Linked run execution</td><td class="mono">{run() ? text(run()?.execution) : 'No linked run in this snapshot'}{runQualifier()}</td></tr>
                <tr><td>Linked run workflow</td><td class="mono">{run() ? text(run()?.workflow_state) : 'No linked run in this snapshot'}{runQualifier()}</td></tr>
                <tr><td>Attached clients</td><td>{attachedCount() === null ? 'Not included in this observation' : `${attachedCount()} · presence does not grant control`}</td></tr>
              </tbody>
            </table>
          </div>
          <Show when={o()?.mode === 'recover' && !!attachedCount() && !hold()}>
            <p class="small warn">Automatic continuation can still act. Use takeover to hold it.</p>
          </Show>
          <Show when={a().unrecorded}><p class="small warn">The record differs from the observation; reconcile with the explicit locate command.</p></Show>
          <p class="small muted">Coverage {coverageState(a().coverage)} · read-only observation; the record is never rewritten here.</p>
        </section>
        <Show when={a().key} keyed={true}>
          {(key: string) => <SessionPanel assignment={a()} token={props.token} live={props.live} refresh={props.refresh} onEnded={showEndedSession} />}
        </Show>
        <Show when={!retained() && a().task_activity?.state && a().task_activity.state !== 'unknown'}>
          <section class="section">
            <div class="section-head"><h3>Response status</h3></div>
            <p>{a().task_activity.reason}</p>
            <Show when={a().task_activity.finished_at}>
              <p class="small muted">Finished {time(a().task_activity.finished_at)}. A finished response does not certify the proposed work was implemented or accepted.</p>
            </Show>
            <Show when={a().task_activity.last_reply}>
              <details>
                <summary>Last response</summary>
                <pre style={{ 'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere' }}>{a().task_activity.last_reply}</pre>
              </details>
            </Show>
          </section>
        </Show>
        <section class="section">
          <div class="section-head"><h3>Explicit operator command</h3><span class="small muted">Does not run automatically</span></div>
          <Show
            when={locate()}
            fallback={<p class="small muted" id="locate-command-help">No locate command was recorded in this observation.</p>}
          >
            <textarea class="mono locate-command" rows="2" readonly value={locate() ?? ''} ref={locateEl} aria-label={`Locate command for assignment ${a().assignment_id}`} />
            <p class="small" role="status">{copyStatus()}</p>
            <p class="small muted">Copying does not run the command or take control.</p>
          </Show>
        </section>
        <section class="section">
          <div class="section-head"><h3>Declared evidence</h3><span class={`pill ${run()?.evidence?.state === 'recorded' ? 'good' : run()?.evidence?.state === 'unavailable' ? 'warn' : 'muted'}`}>{run()?.evidence?.state || 'unknown'}</span></div>
          <Show when={related()?.match === 'package'}>
            <p class="small warn">Package-level evidence; not evidence of this assignment.</p>
          </Show>
          <Show when={run()?.evidence} fallback={<p class="small muted">No linked run evidence in this snapshot.</p>}>
            {evidence => (
              <>
                <div class="rows">
                  <div class="info-row">
                    <p>
                      <Show when={evidence().state === 'recorded'} fallback={evidence().state === 'unavailable' ? 'Declared artifact is unavailable.' : 'No declared artifact was assessed.'}>
                        Declared {evidence().verdict} at commit <span class="mono">{evidence().commit}</span>
                      </Show>
                    </p>
                    <small>{evidence().source || 'work-tour.json'} · scope {evidence().scope || 'declared-artifact'}{evidence().observed_at ? ` · ${time(evidence().observed_at)}` : ''}{evidence().reason ? ` · ${evidence().reason}` : ''}</small>
                  </div>
                </div>
                <p class="small muted">Declared artifact scope only; this never proves the current checkout, merge or deployment.</p>
              </>
            )}
          </Show>
        </section>
        <section class="section">
          <div class="section-head"><h3>Attention</h3><span class="small muted">{list(a().attention).length} observed</span></div>
          <Show when={list(a().attention).length} fallback={<p class="small muted">No attention recorded.</p>}>
            <div class="rows"><For each={list(a().attention)}>{value => <div class="info-row"><p><span innerHTML={inlineMarkdown(value)} /></p></div>}</For></div>
          </Show>
        </section>
        <section class="section">
          <div class="section-head"><h3>Assignment coverage</h3><span class="small muted">{text(ac()?.state, 'unknown')}</span></div>
          <Show when={coverageReasons().length} fallback={<p class="small muted">No assignment coverage reasons reported.</p>}>
            <For each={coverageReasons()}>{value => <p class="coverage-note"><span innerHTML={inlineMarkdown(value)} /></p>}</For>
          </Show>
        </section>
        <div class="footer">Observer {text(o()?.observer_id, 'unknown')} · {text(o()?.state, 'unknown')}<br />Snapshot observed {time(o()?.snapshot?.coverage?.observed_at)} · {age(o()?.snapshot?.coverage?.observed_at)}<br />Attach from your terminal using the command above. Ending a session requires explicit confirmation.</div>
      </div>
      <ActionBar>
        <Show when={recovery()}>
          {label => <button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryConnection}>{label()}</button>}
        </Show>
        <button
          type="button"
          class={`ds-btn${copyPrimary() ? ' ds-btn--primary' : ''}`}
          disabled={locate() === null}
          aria-describedby={locate() === null ? 'locate-command-help' : undefined}
          onClick={() => void copyLocate()}
        >
          Copy locate command
        </button>
        <button
          type="button"
          class={`ds-btn${openSpecPrimary() ? ' ds-btn--primary' : ''}`}
          disabled={specTarget() === null}
          title={specTarget() === null ? 'No linked spec record in this snapshot.' : undefined}
          onClick={() => { const target = specTarget(); if (target) props.onNavigate(target); }}
        >
          Open spec
        </button>
        <button
          type="button"
          class="ds-btn"
          disabled={tourTarget() === null}
          title={tourTarget() === null ? 'No recorded work tour in this snapshot.' : undefined}
          onClick={() => { const target = tourTarget(); if (target) props.onNavigate(target); }}
        >
          Open work tour
        </button>
      </ActionBar>
    </article>
  );
}
