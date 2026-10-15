// Next steps destination: one MasterDetail over the live scan. The pure
// next-steps-state model owns rows, counts, filters and the nine view states;
// next-steps-store.ts is the only scan transport, and this component never
// fetches the scan itself (discuss resolves the workspace inventory only).
// Route ws/q/filter/id are authoritative, and an unmatched selection
// normalizes to the first visible row with a replace navigation and no focus
// call.
//
// Presentation freeze: while the pointer or keyboard focus is inside the
// table, the displayed key order/membership is held. A held key that leaves
// the scan keeps its original row DOM and last observed presentation, with
// actions disabled and the row marked unavailable; the same-key row is always
// looked up live, so eligibility is never frozen. Leaving both the pointer and
// focus flushes the freeze; explicit refresh flushes immediately but keeps a
// focused removed key at its prior slot until it blurs.
import { For, Index, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount } from 'solid-js';
import { getJson } from '../api';
import { seedNewThreadDraft } from '../conversations-state';
import { age, serverNow, time } from '../format';
import { discussionRepositoryTarget, startPackageHandoff } from '../launch-handoff';
import type { HandoffKind, PlannedTarget } from '../launch-handoff';
import type { WireRecord } from '../model';
import { ActionBar, EmptyState, MasterDetail, RegionalSkeleton, SectionTabs, StateNotice, StatusText } from '../primitives';
import type { StatusTone } from '../primitives';
import { busyAgentsHref, formatHash, navigate, parseHash } from '../route';
import type { RouteState } from '../route';
import { loadNextSteps, pending, scan, scanError } from '../next-steps-store';
import {
  filterCounts, freshScan, nextStepRows, nextStepsViewState, visibleRows,
  type NextStepAction, type NextStepActionId, type NextStepRow, type NextStepsFilter, type NextStepsViewState,
} from './next-steps-state';
import type { DestinationProps } from './index';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
const recordText = (record: WireRecord | null, field: string): string =>
  text((record as Record<string, unknown> | null | undefined)?.[field]);

const NEXT_STEPS_FILTERS: readonly NextStepsFilter[] = ['all', 'plan', 'critique', 'spec', 'implement', 'review'];
const routeFilter = (value: unknown): NextStepsFilter =>
  typeof value === 'string' && (NEXT_STEPS_FILTERS as readonly string[]).includes(value) ? value as NextStepsFilter : 'all';

const FILTER_TABS: readonly { key: NextStepsFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'plan', label: 'Plan' },
  { key: 'critique', label: 'Critique' },
  { key: 'spec', label: 'Spec' },
  { key: 'implement', label: 'Implement' },
  { key: 'review', label: 'Review' },
];

const STAGE_LABELS: Record<string, string> = {
  proposal: 'Proposal', critique: 'Critique', spec: 'Spec', 'work-tour': 'Work tour', epic: 'Epic',
};
const stageLabel = (stage: string): string => STAGE_LABELS[stage] ?? (stage || 'Observed');
// Compact observed wall-clock for dense list/stage/fact rows; the full
// timestamp stays available as the element title. Feature-local so the shared
// formatter keeps its existing full-date output.
const compactClock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const compactTime = (value: unknown): string => {
  const raw = text(value);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? compactClock.format(parsed) : (raw || 'Unknown');
};

// Field names follow the scan producer (scripts/spec-observe/next-steps.mjs):
// proposal {verdict, critique_recommended, summary, caveats,
// incompatible_reason}, critique {assessment, must_address, should_address,
// consider}, work-tour {verdict, gaps, commit, title, summary, pr} and epic
// {members, wave1}. No guessed aliases are read.
const humanVerdict = (verdict: string): string => verdict === 'COMPATIBLE_WITH_CAVEATS'
  ? 'Compatible with caveats'
  : verdict === 'COMPATIBLE' ? 'Compatible'
    : verdict === 'INCOMPATIBLE' ? 'Incompatible'
      : verdict === 'ready' ? 'Ready'
        : verdict === 'blocked' ? 'Blocked'
          : verdict === 'merged' ? 'Merged' : verdict;

const verdictOf = (row: NextStepRow): string => humanVerdict(text(row.signal?.verdict));
const summaryOf = (row: NextStepRow): string => text(row.signal?.summary);
const assessmentOf = (row: NextStepRow): string => text(row.signal?.assessment);
const caveatsOf = (row: NextStepRow): string[] => stringList(row.signal?.caveats);
const incompatibleReasonOf = (row: NextStepRow): string => text(row.signal?.incompatible_reason);
const signalReasonOf = (row: NextStepRow): string => incompatibleReasonOf(row) || text(row.signal?.reason);
const mustOf = (row: NextStepRow): string[] => stringList(row.signal?.must_address);
const shouldOf = (row: NextStepRow): string[] => stringList(row.signal?.should_address);
const considerOf = (row: NextStepRow): number => number(row.signal?.consider) ?? 0;
const recommendationCount = (row: NextStepRow): number => mustOf(row).length + shouldOf(row).length + considerOf(row);
const membersOf = (row: NextStepRow): string[] => stringList(row.signal?.members);
const wave1Of = (row: NextStepRow): string[] => stringList(row.signal?.wave1);
const gapsOf = (row: NextStepRow): number => number(row.signal?.gaps) ?? 0;
const commitOf = (row: NextStepRow): string => text(row.signal?.commit);

const pullRequestOf = (row: NextStepRow): string => {
  const pr = row.signal?.pr;
  if (typeof pr === 'string') return pr;
  if (pr && typeof pr === 'object' && typeof (pr as { url?: unknown }).url === 'string') return (pr as { url: string }).url;
  return '';
};

const signalState = (row: NextStepRow): { tone: StatusTone; label: string } => {
  if (row.running) return { tone: 'info', label: 'Running' };
  const signal = row.signal;
  if (!signal || signal.state !== 'ok') return { tone: 'warning', label: signal?.state === 'unparsed' ? 'Not parsed' : 'Not readable' };
  const verdict = text(signal.verdict);
  if (row.stage === 'epic') return { tone: 'neutral', label: 'Planned' };
  if (row.stage === 'work-tour') {
    if (verdict === 'blocked') return { tone: 'error', label: 'Merge evidence blocked' };
    if (verdict === 'merged') return { tone: 'success', label: 'Merged' };
    if (verdict === 'ready') return { tone: 'success', label: 'Merge evidence ready' };
  }
  if (verdict === 'INCOMPATIBLE') return { tone: 'error', label: 'Incompatible' };
  if (signal.critique_recommended === true) return { tone: 'warning', label: 'Critique recommended' };
  if (verdict === 'COMPATIBLE_WITH_CAVEATS') return { tone: 'success', label: 'Compatible with caveats' };
  if (verdict === 'COMPATIBLE') return { tone: 'neutral', label: 'Compatible' };
  const count = recommendationCount(row);
  if (row.stage === 'critique' && count > 0) return { tone: 'neutral', label: `${count} recommendation${count === 1 ? '' : 's'}` };
  return { tone: 'neutral', label: stageLabel(row.stage) };
};

const signalNote = (row: NextStepRow): string => {
  if (row.running) {
    const started = recordText(row.running, 'recorded_at') || recordText(row.running, 'started_at') || recordText(row.running, 'observed_at');
    return started ? `since ${time(started)}` : '';
  }
  const reason = signalReasonOf(row);
  if (reason) return reason;
  if (row.stage === 'epic') {
    const members = membersOf(row).length;
    const wave1 = wave1Of(row).length;
    return `${members} member${members === 1 ? '' : 's'}${wave1 > 0 ? ` · ${wave1} in wave 1` : ''}`;
  }
  if (row.stage === 'work-tour') {
    const gaps = gapsOf(row);
    const parts: string[] = [];
    if (gaps > 0) parts.push(`${gaps} gap${gaps === 1 ? '' : 's'}`);
    if (pullRequestOf(row)) parts.push('PR open');
    const commit = commitOf(row);
    if (parts.length === 0 && commit) parts.push(commit.slice(0, 12));
    return parts.join(' · ');
  }
  const must = mustOf(row).length;
  if (must > 0) return `${must} must address`;
  const count = recommendationCount(row);
  if (count > 0) return `${count} recommendation${count === 1 ? '' : 's'}`;
  if (text(row.signal?.verdict) === 'COMPATIBLE_WITH_CAVEATS') return 'Compatible with caveats';
  return '';
};

const STEP_SENTENCES: Record<NextStepActionId, string> = {
  'plan-members': 'Plan the next eligible member of this epic.',
  'critique-proposal': 'Critique this proposal before writing its spec.',
  'write-spec': 'Write the spec from the observed proposal and critique.',
  'discuss-proposal': 'Discuss this proposal before deciding the next step.',
  'implement-spec': 'Implement the prepared specification.',
  'open-spec': 'Inspect the observed specification in Specs.',
  'review-work-tour': 'Review the observed work tour evidence.',
  'open-agent': 'Follow this assignment in Agents.',
  'open-file': 'Open the observed file.',
  'open-proposal': 'Open the observed proposal.',
  'open-pull-request': 'Open the observed pull request.',
};

const stepSentence = (row: NextStepRow): string => row.step.id === 'write-spec' && row.stage === 'proposal'
  ? 'Write the spec from this proposal.'
  : STEP_SENTENCES[row.step.id] ?? row.step.label;

const stepDetail = (row: NextStepRow): string => {
  if (row.held) return row.held;
  if (row.running) return 'This assignment is already running; follow it to see progress.';
  if (row.step.id === 'open-spec' && row.step.reason) return row.step.reason;
  const parts: string[] = [];
  if (row.stage === 'epic') {
    const members = membersOf(row).length;
    const wave1 = wave1Of(row).length;
    parts.push(`The observed epic plan names ${members} member${members === 1 ? '' : 's'}${wave1 > 0 ? `; ${wave1} in its first wave` : ''}.`);
  } else if (row.stage === 'work-tour') {
    const gaps = gapsOf(row);
    parts.push(`The observed work tour reports ${gaps} gap${gaps === 1 ? '' : 's'}.`);
    const verdict = verdictOf(row);
    if (verdict) parts.push(`Its verdict is ${verdict}.`);
  } else {
    const count = recommendationCount(row);
    if (count > 0) parts.push(`The observed critique reports ${count} recommendation${count === 1 ? '' : 's'}.`);
    const verdict = verdictOf(row);
    if (verdict) parts.push(`The observed proposal verdict is ${verdict}.`);
    if (row.signal?.critique_recommended === true) parts.push('The proposal recommends a critique; writing the spec skips it.');
  }
  if (row.signal?.state !== 'ok') parts.push('The file could not be read in full, so only its observed path is available.');
  if (parts.length === 0) parts.push(`The scan observed ${row.file} at the ${stageLabel(row.stage)} stage.`);
  return parts.join(' ');
};

const observedStages = (row: NextStepRow) =>
  Array.isArray(row.observed_files) ? row.observed_files.filter(file => file && typeof file.name === 'string') : [];

type NextStepFact = { label: string; value: string; sub?: string; title?: string };

const stageFacts = (row: NextStepRow): NextStepFact[] => {
  const out: NextStepFact[] = [];
  // A running row reports its real assignment identity and start rather than
  // the proposal verdict facts of the file that started it.
  if (row.running) {
    out.push({ label: 'Assignment', value: recordText(row.running, 'assignment_id') || 'Unknown' });
    const started = recordText(row.running, 'recorded_at') || recordText(row.running, 'started_at') || recordText(row.running, 'observed_at');
    if (started) out.push({ label: 'Started', value: compactTime(started), title: time(started), sub: age(started) });
    out.push({ label: 'Workspace', value: row.workspace_name || row.workspace, sub: row.file });
    return out;
  }
  const verdict = verdictOf(row);
  if (verdict) out.push({ label: 'Verdict', value: verdict, sub: `Observed in ${row.file}` });
  if (row.stage === 'epic') {
    const members = membersOf(row).length;
    const wave1 = wave1Of(row).length;
    out.push({ label: 'Members', value: String(members), sub: wave1 > 0 ? `${wave1} in wave 1` : 'From the epic plan' });
  } else if (row.stage === 'work-tour') {
    if (number(row.signal?.gaps) !== null) {
      const gaps = gapsOf(row);
      out.push({ label: 'Gaps', value: String(gaps), sub: gaps > 0 ? 'Recorded in the work tour' : 'None recorded' });
    }
    const commit = commitOf(row);
    if (commit) out.push({ label: 'Commit', value: commit.slice(0, 12), sub: text(row.signal?.title) || undefined });
  } else {
    const must = mustOf(row).length;
    const should = shouldOf(row).length;
    const consider = considerOf(row);
    if (must + should + consider > 0) {
      out.push({
        label: 'Recommendations',
        value: String(must + should + consider),
        sub: [must ? `${must} must` : '', should ? `${should} should` : '', consider ? `${consider} consider` : ''].filter(Boolean).join(' · '),
      });
    }
    if (row.stage === 'proposal' && Array.isArray(row.signal?.caveats)) {
      const caveats = caveatsOf(row).length;
      out.push({ label: 'Caveats', value: String(caveats), sub: caveats > 0 ? 'Listed below' : 'None listed' });
    }
  }
  out.push({
    label: 'Written',
    value: compactTime(row.written_at),
    title: time(row.written_at),
    sub: [row.workspace_name || row.workspace, age(row.written_at)].filter(Boolean).join(' · '),
  });
  return out;
};

const excerptSections = (row: NextStepRow): { heading: string; body: string }[] =>
  [
    { heading: 'Summary', body: summaryOf(row) },
    { heading: 'Reason', body: incompatibleReasonOf(row) || (row.signal?.state !== 'ok' ? text(row.signal?.reason) : '') },
    { heading: 'Assessment', body: assessmentOf(row) },
  ].filter(section => section.body);

// One row per displayed key. The row prop is a live accessor: a same-key row
// updates in place (including held/launch changes on stable buttons), while a
// key that left the scan keeps its last observed presentation with actions
// disabled until the freeze flushes. No truthy-object Show wraps the row, so
// its DOM and focused control are never recreated on a scan tick.
function NextStepTableRow(props: {
  rowKey: string;
  row: NextStepRow | null;
  missing: boolean;
  href: string;
  selected: boolean;
  busy: boolean;
  onSelect: (key: string) => void;
  onStep: (row: NextStepRow, action: NextStepAction) => void;
}) {
  const row = () => props.row;
  const action = (): NextStepAction => row()?.step ?? {
    id: 'open-file', label: 'Unavailable', kind: 'held', reason: 'This file is no longer observed in the scan.',
  };
  const stepNoteId = createUniqueId();
  const unavailable = () => props.missing || action().kind === 'held' || (props.busy && action().kind === 'launch');
  const signal = () => {
    const current = row();
    return current ? signalState(current) : { tone: 'warning' as StatusTone, label: 'Unavailable' };
  };
  const stepNote = (): string => {
    if (props.missing) return 'Unavailable in this scan';
    const current = action();
    return current.kind === 'held' ? current.reason ?? '' : '';
  };
  const select = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    props.onSelect(props.rowKey);
  };
  const run = () => {
    if (unavailable()) return;
    const current = row();
    if (!current) return;
    props.onStep(current, current.step);
  };
  return (
    <tr
      class={`queue-row${props.selected ? ' selected' : ''}${props.missing ? ' unavailable' : ''}`}
      data-next-step-key={props.rowKey}
      aria-selected={props.selected ? 'true' : undefined}
      aria-disabled={props.missing ? 'true' : undefined}
    >
      <td>
        <a class="subject" href={props.href} title={row()?.slug || row()?.file || props.rowKey} aria-current={props.selected ? 'true' : undefined} onClick={select}>
          {row()?.slug || row()?.file || props.rowKey}
        </a>
        <span class="fileline" title={row() ? `${row()!.file} · ${row()!.workspace_name || row()!.workspace}` : undefined}>{row() ? `${row()!.file} · ${row()!.workspace_name || row()!.workspace}` : ''}</span>
        <span class="signal" title={row() ? `${signal().label}${signalNote(row()!) ? ` · ${signalNote(row()!)}` : ''}` : 'Unavailable in this scan'}>
          <StatusText tone={signal().tone}>{signal().label}</StatusText>
          {row() ? signalNote(row()!) : ''}
        </span>
      </td>
      <td class="numeric">
        <span class="when" title={row() ? time(row()!.written_at) : undefined}>{row() ? compactTime(row()!.written_at) : ''}</span>
        <span class="when-sub">{row() ? age(row()!.written_at) : ''}</span>
      </td>
      <td>
        <button
          type="button"
          class="step-link"
          aria-disabled={unavailable() ? 'true' : undefined}
          aria-describedby={props.missing || action().kind === 'held' ? stepNoteId : undefined}
          onClick={run}
        >
          {action().label}
        </button>
        <Show when={stepNote()}><small id={stepNoteId} class="step-note" title={stepNote()}>{stepNote()}</small></Show>
      </td>
    </tr>
  );
}

function NextStepDetail(props: { row: NextStepRow; epic: WireRecord | null }) {
  const row = () => props.row;
  const epicMembers = (): WireRecord[] => {
    const members = props.epic?.members;
    return Array.isArray(members) ? members as WireRecord[] : [];
  };
  // Only observed member fields: identity, declared requirements and the
  // planning facts already present on the epic record. Nothing is rederived.
  const memberFacts = (member: WireRecord): string => {
    const planning = member.planning as Record<string, unknown> | null | undefined;
    if (!planning) return '';
    return [
      planning.proposal === true ? 'proposal' : '',
      planning.critique === true ? 'critique' : '',
      planning.prepared === true ? 'prepared' : planning.prepared === false ? 'not prepared' : '',
      typeof planning.step_count === 'number' ? `${planning.step_count} steps` : '',
    ].filter(Boolean).join(' · ');
  };
  return (
    <>
      <section class="section">
        <div class="section-heading"><h3>Suggested next step</h3></div>
        <div class="obligation">{stepSentence(row())}<p>{stepDetail(row())}</p></div>
      </section>
      <Show when={row().stage === 'epic' && epicMembers().length > 0}>
        <section class="section">
          <div class="section-heading"><h3>Epic members</h3><span class="muted">{`${epicMembers().length}`}</span></div>
          <div class="table-wrap">
            <table class="epic-members">
              <thead>
                <tr><th scope="col">Member</th><th scope="col">Requires</th><th scope="col">Observed status</th></tr>
              </thead>
              <tbody>
                <For each={epicMembers()}>
                  {member => (
                    <tr>
                      <th scope="row">{text(member.name) || text(member.package)}</th>
                      <td>{stringList(member.requires).join(', ') || '—'}</td>
                      <td>{[text(member.status), memberFacts(member)].filter(Boolean).join(' · ') || 'Observed'}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </section>
      </Show>
      <section class="section">
        <div class="section-heading"><h3>Package stages</h3><span class="muted">{`${observedStages(row()).length} observed`}</span></div>
        <Show
          when={observedStages(row()).length > 0}
          fallback={<p class="section-note">Only the selected file is observed in this scan.</p>}
        >
          <ol class="stage-list">
            <For each={observedStages(row())}>
              {file => (
                <li class={file.name === row().file ? 'here' : ''}>
                  <strong>{file.name}</strong>
                  {`${stageLabel(file.stage)} · `}
                  <span title={time(file.written_at)}>{compactTime(file.written_at)}</span>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </section>
      <div class="facts">
        <For each={stageFacts(row())}>
          {fact => (
            <div class="fact">
              <label>{fact.label}</label>
              <strong title={fact.title}>{fact.value}</strong>
              <Show when={fact.sub}><p>{fact.sub}</p></Show>
            </div>
          )}
        </For>
      </div>
      <For each={excerptSections(row())}>
        {section => (
          <section class="section">
            <div class="section-heading"><h3>{section.heading}</h3></div>
            <p class="excerpt">{section.body}</p>
          </section>
        )}
      </For>
      <Show when={caveatsOf(row()).length > 0}>
        <section class="section">
          <div class="section-heading"><h3>Caveats</h3><span class="muted">{`${caveatsOf(row()).length}`}</span></div>
          <ol class="recs"><For each={caveatsOf(row())}>{item => <li>{item}</li>}</For></ol>
        </section>
      </Show>
      <Show when={mustOf(row()).length > 0 || shouldOf(row()).length > 0 || considerOf(row()) > 0}>
        <section class="section">
          <div class="section-heading"><h3>Recommendations</h3><span class="muted">{`${recommendationCount(row())} ranked`}</span></div>
          <Show when={mustOf(row()).length > 0}>
            <h4>Must address</h4>
            <ol class="recs"><For each={mustOf(row())}>{item => <li>{item}</li>}</For></ol>
          </Show>
          <Show when={shouldOf(row()).length > 0}>
            <h4>Should address</h4>
            <ol class="recs"><For each={shouldOf(row())}>{item => <li>{item}</li>}</For></ol>
          </Show>
          <Show when={considerOf(row()) > 0}>
            <p class="section-note">{`${considerOf(row())} more under Consider.`}</p>
          </Show>
        </section>
      </Show>
    </>
  );
}

// Primary and secondary actions render as one stable button surface: navigate
// and external actions run the model route/href through the adapter, launch
// actions go to the handoff owner, and held actions stay disabled with their
// model reason shown inline and associated through aria-describedby.
function ActionControl(props: {
  row: NextStepRow;
  action: NextStepAction;
  primary?: boolean;
  busy?: boolean;
  onRun: (row: NextStepRow, action: NextStepAction) => void;
}) {
  const noteId = createUniqueId();
  const held = () => props.action.kind === 'held';
  return (
    <>
      <button
        type="button"
        class={held() ? 'text-link' : props.primary ? 'ds-btn ds-btn--primary' : 'text-link'}
        disabled={held() || props.busy}
        aria-describedby={held() && props.action.reason ? noteId : undefined}
        onClick={() => props.onRun(props.row, props.action)}
      >
        {props.action.label}
      </button>
      <Show when={held() && Boolean(props.action.reason)}>
        <span id={noteId} class="action-note">{props.action.reason}</span>
      </Show>
    </>
  );
}

export default function NextStepsDestination(props: DestinationProps) {
  const filter = () => routeFilter(props.route.filter);
  const query = () => props.route.q ?? '';
  const rowsContext = () => ({
    records: props.records,
    assignments: props.assignments,
    epics: props.epics,
    catalog: props.catalog,
    scope: props.route.ws,
    token: props.completionToken ?? null,
    live: props.live,
    connectionFailed: props.connectionFailed,
    now: serverNow(),
  });
  const allRows = createMemo(() => nextStepRows(scan(), rowsContext()));
  const counts = createMemo(() => filterCounts(allRows()));
  const rows = createMemo(() => visibleRows(allRows(), filter(), query()));
  const rowsByKey = createMemo(() => new Map(allRows().map(row => [row.key, row] as const)));
  const view = createMemo(() => nextStepsViewState(scan(), allRows(), {
    filter: filter(),
    q: query(),
    token: props.completionToken ?? null,
    live: props.live,
    connectionFailed: props.connectionFailed,
    now: serverNow(),
  }));
  // A failed initial load is a read error, not an endless skeleton; the
  // retained-scan refresh failure stays a banner-only condition. Held/pinned
  // membership keeps the table mounted even when the live filter is empty.
  const read = (): NextStepsViewState['read'] => {
    if (displayKeys().length > 0) return 'ideal';
    const current = view().read;
    if (current === 'loading' && scan() === null && scanError() !== '' && !pending()) return 'error';
    return current;
  };

  const [frozen, setFrozen] = createSignal<string[] | null>(null);
  const [pinned, setPinned] = createSignal<{ key: string; index: number } | null>(null);
  const [actionBusy, setActionBusy] = createSignal(false);
  const [discussBusy, setDiscussBusy] = createSignal(false);
  const [actionError, setActionError] = createSignal('');
  const [arrival, setArrival] = createSignal('');
  const [delayed, setDelayed] = createSignal(false);
  const lastRows = new Map<string, NextStepRow>();
  let pointerInside = false;
  let focusInside = false;
  let discussGeneration = 0;
  let unmounted = false;
  let delayTimer: ReturnType<typeof setTimeout> | undefined;

  const visibleKeys = () => rows().map(row => row.key);

  // Skeleton delay: the initial load keeps the region quiet for 300ms before
  // showing placeholders, so a fast scan never flashes them.
  createEffect(() => {
    clearTimeout(delayTimer);
    delayTimer = undefined;
    if (read() === 'loading') delayTimer = setTimeout(() => setDelayed(true), 300);
    else setDelayed(false);
  });
  onCleanup(() => clearTimeout(delayTimer));

  // Last observed presentation per key; only consulted while a held key is
  // missing from the live rows.
  createEffect(() => {
    for (const row of allRows()) lastRows.set(row.key, row);
  });

  // Route authority: a selection that is live, held or pinned stays
  // authoritative, and while a list interaction is active no sibling is
  // selected automatically. Otherwise an absent or unmatched selection
  // normalizes to the first visible row with a replace navigation and no
  // focus call.
  createEffect(() => {
    const visible = rows();
    if (!visible.length) return;
    const id = props.route.id ?? '';
    if (id && displayKeys().includes(id)) return;
    if (frozen() !== null) return;
    navigate({ ...props.route, id: visible[0].key }, 'replace');
  });

  // Polite one-time arrival announcement: the first scan seeds the known keys
  // silently; later scans announce only the newly arrived files.
  let knownKeys: Set<string> | null = null;
  createEffect(() => {
    if (scan() === null) return;
    const keys = allRows().map(row => row.key);
    if (knownKeys === null) {
      knownKeys = new Set(keys);
      return;
    }
    const fresh = keys.filter(key => !knownKeys!.has(key));
    for (const key of keys) knownKeys.add(key);
    if (fresh.length > 0) setArrival(`${fresh.length} new file${fresh.length === 1 ? '' : 's'} waiting for a next step.`);
  });

  onMount(() => { void loadNextSteps(); });
  onCleanup(() => {
    unmounted = true;
    discussGeneration += 1;
  });

  const captureFreeze = () => {
    if (frozen() !== null) return;
    setFrozen(visibleKeys());
  };
  const releaseFreeze = () => {
    if (pointerInside || focusInside) return;
    setFrozen(null);
    setPinned(null);
  };

  // The displayed keys hold the frozen order or the live order; a pinned key
  // that the flush removed is re-inserted at its prior slot until focus exits.
  const displayKeys = createMemo(() => {
    const list = frozen() ?? visibleKeys();
    const pin = pinned();
    if (!pin || list.includes(pin.key)) return list;
    const next = [...list];
    next.splice(Math.min(Math.max(pin.index, 0), next.length), 0, pin.key);
    return next;
  });

  const selectedKey = createMemo(() => {
    const id = props.route.id ?? '';
    return id && displayKeys().includes(id) ? id : '';
  });
  const selected = createMemo(() => {
    const key = selectedKey();
    const current = rowsByKey().get(key);
    if (current) return current;
    const previous = lastRows.get(key);
    if (!previous) return null;
    const held = 'Unavailable in this scan';
    const hold = (action: NextStepAction): NextStepAction => ({ ...action, kind: 'held', reason: held });
    return { ...previous, held, step: hold(previous.step), secondary: previous.secondary.map(hold) };
  });
  // Match epic detail by exact workspace and epic identity, not slug alone.
  const selectedEpic = createMemo(() => {
    const current = selected();
    if (!current) return null;
    return props.epics.find(epic => epic
      && text(epic.workspace) === current.workspace
      && (text(epic.epic) === current.slug || text(epic.name) === current.slug)) ?? null;
  });

  const pinFocusedRow = () => {
    if (typeof document === 'undefined') return;
    const active = document.activeElement as HTMLElement | null;
    const holder = active && typeof active.closest === 'function' ? active.closest<HTMLElement>('[data-next-step-key]') : null;
    const key = holder?.dataset.nextStepKey ?? '';
    if (!key) return;
    setPinned({ key, index: Math.max(0, displayKeys().indexOf(key)) });
  };

  // Explicit refresh flushes the frozen order immediately, waits for the store
  // load, and re-arms the hold on the NEW visible membership while the pointer
  // or focus is still inside (flush then resume hold, never unbounded live
  // mode). The focused removed key stays pinned until its real blur, and only
  // the newest refresh generation may re-arm after an overlapping refresh.
  let refreshGeneration = 0;
  const refresh = () => {
    pinFocusedRow();
    setFrozen(null);
    const generation = ++refreshGeneration;
    void loadNextSteps().then(() => {
      if (unmounted || generation !== refreshGeneration) return;
      if (pointerInside || focusInside) setFrozen(visibleKeys());
    });
  };
  createEffect(on(() => props.refreshKey, () => { refresh(); }, { defer: true }));

  const rowHref = (key: string): string => {
    const next: RouteState = { dest: 'next-steps' };
    if (props.route.ws !== undefined) next.ws = props.route.ws;
    if (props.route.filter) next.filter = props.route.filter;
    if (props.route.q) next.q = props.route.q;
    next.id = key;
    return formatHash(next);
  };

  const currentReturnRoute = (): RouteState => {
    const route: RouteState = { dest: 'next-steps' };
    if (props.route.ws !== undefined) route.ws = props.route.ws;
    if (props.route.filter) route.filter = props.route.filter;
    if (props.route.q) route.q = props.route.q;
    const id = selectedKey();
    if (id) route.id = id;
    return route;
  };

  const startLaunch = async (row: NextStepRow, action: NextStepAction) => {
    if (actionBusy()) return;
    const token = props.completionToken;
    // A Plan members handoff binds the model-selected member's observed
    // package identity and targets; the row's own record is never the epic's
    // member set, and there is no inferred fallback.
    const record = action.id === 'plan-members'
      ? props.records.find(candidate => candidate
        && text(candidate.package) === text(action.route?.package)
        && text(candidate.workspace) === row.workspace) ?? null
      : row.record;
    const packageRef = text(action.route?.package) || text(record?.package) || text(record?.package_ref) || row.package || '';
    if (!token) {
      setActionError('This session has no action token; assignments are held.');
      return;
    }
    if (action.id === 'plan-members' && !record) {
      setActionError('The observed member package is unavailable in this observation; refresh files before planning.');
      return;
    }
    if (!packageRef) {
      setActionError('This file has no observed package to prepare.');
      return;
    }
    const kind: HandoffKind = action.id === 'implement-spec' ? 'implement' : 'plan';
    setActionBusy(true);
    setActionError('');
    try {
      const outcome = await startPackageHandoff(kind, {
        ws: row.workspace_id,
        packageRef,
        targets: Array.isArray(record?.targets) ? record!.targets as PlannedTarget[] : [],
        planningPlan: action.planningPlan ?? null,
        returnRoute: currentReturnRoute(),
      }, token, props.onNavigate);
      if (!outcome.ok) setActionError(outcome.reason);
    } catch (error) {
      setActionError(error instanceof Error && error.message
        ? error.message
        : 'The hand-off could not be prepared. Retry from this file.');
    } finally {
      setActionBusy(false);
    }
  };

  // Discuss resolves the canonical repository alias against the loaded
  // workspace inventory once per click, seeds the prepared observed text in
  // memory and routes to the conversations new-thread surface. A late
  // selection change or unmount ignores the response; a failed resolution
  // stays inline and never seeds or navigates.
  const discussProposal = async (row: NextStepRow) => {
    if (discussBusy()) return;
    const ws = row.workspace_id;
    if (!ws) {
      setActionError('This file has no observed workspace to discuss in.');
      return;
    }
    const generation = ++discussGeneration;
    setDiscussBusy(true);
    setActionError('');
    try {
      const workspace = await getJson<WireRecord>('/api/workspace?' + new URLSearchParams({ id: ws }));
      if (unmounted || generation !== discussGeneration || selectedKey() !== row.key) return;
      const targets = Array.isArray(row.record?.targets) ? row.record!.targets as PlannedTarget[] : [];
      const resolution = discussionRepositoryTarget(workspace, ws, targets);
      if (!resolution.ok) {
        setActionError(resolution.reason);
        return;
      }
      const prepared = [
        `Discuss ${row.file}.`,
        `Path: ${row.path}`,
        row.package ? `Package: ${row.package}` : '',
        verdictOf(row) ? `Verdict: ${verdictOf(row)}` : '',
        signalReasonOf(row) ? `Reason: ${signalReasonOf(row)}` : '',
      ].filter(Boolean).join('\n');
      seedNewThreadDraft(ws, resolution.target ? { text: prepared, target: resolution.target } : { text: prepared });
      props.onNavigate({ dest: 'conversations', ws, tab: 'new' });
    } catch {
      if (generation === discussGeneration) {
        setActionError('The workspace repository inventory could not be loaded. Retry the discussion.');
      }
    } finally {
      if (generation === discussGeneration) setDiscussBusy(false);
    }
  };

  const runAction = (row: NextStepRow, action: NextStepAction) => {
    if (action.kind === 'held') return;
    if (action.kind === 'navigate') {
      // The Agents subject is keyed by [workspace_id, assignment_id]; the pure
      // row model carries the run key, so the adapter resolves the observed
      // assignment through the route owner.
      if (action.id === 'open-agent' && row.running) {
        props.onNavigate(parseHash(busyAgentsHref(row.workspace_id, text(row.running.assignment_id), props.assignments)));
        return;
      }
      if (action.route) props.onNavigate(action.route);
      return;
    }
    if (action.kind === 'external') {
      if (action.href && typeof window !== 'undefined') window.open(action.href, '_blank', 'noopener');
      return;
    }
    if (action.kind === 'launch') {
      if (action.id === 'discuss-proposal') {
        void discussProposal(row);
        return;
      }
      void startLaunch(row, action);
    }
  };

  const workBusy = () => actionBusy() || discussBusy();

  const filterTabs = createMemo(
    () => FILTER_TABS.map(tab => ({ key: tab.key, label: `${tab.label} ${counts()[tab.key]}` })),
    undefined,
    { equals: (previous, next) => Array.isArray(previous) && previous.length === next.length && previous.every((tab, index) => tab.key === next[index]?.key && tab.label === next[index]?.label) },
  );

  const windowDays = () => {
    const windowMs = scan()?.window_ms;
    return typeof windowMs === 'number' && windowMs > 0 ? Math.max(1, Math.round(windowMs / 86400000)) : 7;
  };

  const captionLead = () => {
    const current = scan();
    if (current && !freshScan(current, serverNow())) return `Written in the ${windowDays()} days before ${compactTime(current.scanned_at)}`;
    return `Written in the last ${windowDays()} days`;
  };

  const caption = () => {
    if (read() === 'loading') {
      const total = props.catalog.length;
      return total > 0 ? `Reading ${total} workspaces…` : 'Reading workspaces…';
    }
    if (read() === 'error') return 'Scan unavailable';
    const total = allRows().length;
    const workspaces = new Set(allRows().map(row => row.workspace_id)).size;
    const running = allRows().filter(row => row.running !== null).length;
    const parts = [
      captionLead(),
      'newest first',
      `${total} file${total === 1 ? '' : 's'} in ${workspaces} workspace${workspaces === 1 ? '' : 's'}`,
    ];
    if (running > 0) parts.push(`${running} stage${running === 1 ? '' : 's'} running`);
    const coverage = scan()?.coverage;
    const readCount = coverage?.workspaces?.read;
    const readTotal = coverage?.workspaces?.total;
    if (view().partial && typeof readCount === 'number' && typeof readTotal === 'number') parts.push(`${readCount} of ${readTotal} workspaces read`);
    return parts.join(' · ');
  };

  const emptyText = () => {
    const coverage = scan()?.coverage;
    const readCount = coverage?.workspaces?.read;
    const readTotal = coverage?.workspaces?.total;
    const observed = typeof readCount === 'number' && typeof readTotal === 'number'
      ? `All ${readTotal} workspaces were read at ${compactTime(scan()!.scanned_at)}.`
      : '';
    return `Epic plans, proposals, critiques, prepared specs and work tours written in the last ${windowDays()} days appear here with the step that usually follows. ${observed}`.trim();
  };

  const scanFoot = (): string => {
    const current = scan();
    if (!current) return scanError() ? 'Scan unavailable' : 'Waiting for the first scan';
    const coverage = current.coverage;
    const readCount = coverage?.workspaces?.read;
    const readTotal = coverage?.workspaces?.total;
    const suffix = typeof readCount === 'number' && typeof readTotal === 'number'
      ? ` · ${readCount} of ${readTotal} workspaces read`
      : coverage?.state === 'complete' ? ' · all workspaces read' : '';
    return `Scan observed ${compactTime(current.scanned_at)}${suffix}`;
  };

  const unreadCoverage = () =>
    Array.isArray(scan()?.coverage?.unread)
      ? scan()!.coverage.unread.filter(entry => entry && text(entry.workspace))
      : [];

  // One prioritized regional notice: transport beats partial coverage, and a
  // retained-scan refresh failure is the last fallback. Recovery lives here,
  // and the list shows its own ordinary Refresh files control only when this
  // notice is absent.
  const notice = () => {
    const state = view();
    const refreshAction = () => (
      <button type="button" class="ds-btn ds-btn--primary" aria-busy={pending()} onClick={refresh}>Refresh files</button>
    );
    if (state.banner === 'offline') {
      return (
        <StateNotice tone="warning" title="Reconnecting" action={<button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryConnection}>Retry connection</button>}>
          {`Connection lost. Showing the scan from ${scan() ? time(scan()!.scanned_at) : 'an earlier observation'}. Stages and files need the connection.`}
        </StateNotice>
      );
    }
    if (state.banner === 'stale') {
      return (
        <StateNotice tone="warning" title="The scan is older than two minutes" action={refreshAction()}>
          {`This scan is ${scan() ? age(scan()!.scanned_at) : 'old'}. Refresh before starting a stage; a step may have started since.`}
        </StateNotice>
      );
    }
    if (state.banner === 'denied') {
      return (
        <StateNotice tone="info" title="Read only" action={refreshAction()}>
          This session has no action token; stages are held. Files still open here.
        </StateNotice>
      );
    }
    if (state.banner === 'partial') {
      const unread = unreadCoverage();
      return (
        <StateNotice tone="warning" title="Some workspaces were not read" action={refreshAction()}>
          {unread.length > 0
            ? unread.map(entry => `${entry.workspace}: ${text(entry.reason) || 'not read'}.`).join(' ')
            : 'The scan is partial; some files may be missing from this list.'}
        </StateNotice>
      );
    }
    if (scanError()) {
      return (
        <StateNotice tone="error" title="Could not refresh next steps" action={refreshAction()}>
          {scanError()}
        </StateNotice>
      );
    }
    return null;
  };

  const clearFilters = () => {
    const next: RouteState = { dest: 'next-steps' };
    if (props.route.ws !== undefined) next.ws = props.route.ws;
    const id = selectedKey();
    if (id) next.id = id;
    props.onNavigate(next);
  };

  const listPane = () => (
    <>
      <div class="list-controls">
        <label class="sr-only" for="next-steps-find">Find a file</label>
        <input
          class="ds-input"
          id="next-steps-find"
          type="search"
          placeholder="Find a file, package or workspace"
          value={query()}
          onInput={event => props.onQuery(event.currentTarget.value)}
        />
        <SectionTabs
          label="Filter by next step"
          variant="filters"
          active={filter()}
          tabs={filterTabs()}
          onSelect={key => props.onFilter(key)}
        />
      </div>
      <p class="list-caption" id="next-steps-caption">{caption()}</p>
      <p class="sr-only" role="status" aria-live="polite">{arrival()}</p>
      <div
        class="records"
        onPointerEnter={() => { pointerInside = true; captureFreeze(); }}
        onPointerLeave={() => { pointerInside = false; releaseFreeze(); }}
        onFocusIn={() => { focusInside = true; captureFreeze(); }}
        onFocusOut={event => {
          const next = event.relatedTarget as Node | null;
          if (next && event.currentTarget.contains(next)) return;
          focusInside = false;
          setPinned(null);
          releaseFreeze();
        }}
      >
        <Show when={read() === 'loading' && delayed()}>
          <RegionalSkeleton variant="table" rows={5} label="Reading files" />
        </Show>
        <Show when={read() === 'error'}>
          <EmptyState
            symbol="◇"
            title="Files could not be read"
            text="The scan did not return a usable result. Specs and Epics read their own records and may still be available."
          />
        </Show>
        <Show when={read() === 'empty'}>
          <EmptyState
            symbol="→"
            title="No new planning or review files"
            text={emptyText()}
            action={<button type="button" class="ds-btn ds-btn--primary" onClick={() => props.onNavigate({ dest: 'epics', ...(props.route.ws !== undefined ? { ws: props.route.ws } : {}) })}>Open epics</button>}
          />
        </Show>
        <Show when={read() === 'filtered-empty'}>
          <EmptyState
            symbol="⌕"
            title="No matching files"
            text="No file matches the current search and filter. Your scope is kept."
            action={<button type="button" class="ds-btn ds-btn--primary" onClick={clearFilters}>Clear filters</button>}
          />
        </Show>
        <Show when={read() === 'ideal'}>
          <table class="queue-table" aria-describedby="next-steps-caption">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col" class="numeric">Written</th>
                <th scope="col">Next step</th>
              </tr>
            </thead>
            <tbody>
              <For each={displayKeys()}>
                {key => (
                  <NextStepTableRow
                    rowKey={key}
                    row={rowsByKey().get(key) ?? lastRows.get(key) ?? null}
                    missing={!rowsByKey().has(key)}
                    href={rowHref(key)}
                    selected={key === selectedKey()}
                    busy={workBusy()}
                    onSelect={props.onSelect}
                    onStep={runAction}
                  />
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </>
  );

  const detailPath = (): string => {
    const row = selected();
    if (!row) return '';
    const workspace = row.workspace_name || row.workspace;
    return workspace && row.path && !row.path.startsWith(`${workspace}/`) ? `${workspace} / ${row.path}` : row.path;
  };

  const detailPane = () => (
    <>
      <Show when={selected() || read() !== 'loading'}>
        <div class="object-head">
          <div class="object-top">
            <h2 id="next-step-heading">{selected() ? selected()!.slug || selected()!.file : 'Next step details'}</h2>
            <Show when={selected()}>
              {current => {
                const signal = () => signalState(current());
                return <StatusText tone={signal().tone}>{signal().label}</StatusText>;
              }}
            </Show>
          </div>
          <p class="mono path">{detailPath()}</p>
        </div>
      </Show>
      <div class="detail-body">
        <Show when={notice()}>{value => value()}</Show>
        <Show when={read() === 'loading' && delayed()}>
          <RegionalSkeleton rows={3} label="Reading next step details" />
        </Show>
        <Show when={read() === 'error'}>
          <EmptyState
            symbol="◇"
            title="Next step could not be read"
            text="The scan did not return a usable result. Your selection is kept."
          />
        </Show>
        <Show when={read() === 'empty' || read() === 'filtered-empty'}>
          <EmptyState
            symbol="→"
            title="No file selected"
            text="Choose a file from the list to see its suggested next step."
          />
        </Show>
        <Show when={read() === 'ideal'}>
          <Show
            when={selected()}
            fallback={
              <EmptyState
                symbol="→"
                title="No file selected"
                text="Choose a file from the list to see its suggested next step."
              />
            }
          >
            {row => <NextStepDetail row={row()} epic={selectedEpic()} />}
          </Show>
        </Show>
      </div>
      <Show when={Boolean(selected() && actionError())}>
        <p class="next-steps-action-error" role="alert">{actionError()}</p>
      </Show>
      <Show when={selected()}>
        {current => (
          <ActionBar>
            <ActionControl
              row={current()}
              action={current().step}
              primary
              busy={workBusy() && current().step.kind === 'launch'}
              onRun={runAction}
            />
            <Index each={current().secondary}>
              {action => (
                <ActionControl
                  row={current()}
                  action={action()}
                  busy={workBusy() && action().kind === 'launch'}
                  onRun={runAction}
                />
              )}
            </Index>
          </ActionBar>
        )}
      </Show>
      <footer class="detail-foot">{scanFoot()}</footer>
    </>
  );

  return (
    <div class="next-steps-destination">
      <Show when={read() === 'empty' || read() === 'error'}>
        <div class="full-page next-steps-full-state">
          <p class="sr-only" id="next-steps-caption">{caption()}</p>
          <Show when={read() === 'empty'}>
            <section class="list-pane" aria-label="Files waiting for a next step">
              <EmptyState
                symbol="→"
                title="No new planning or review files"
                text={emptyText()}
                action={<button type="button" class="ds-btn ds-btn--primary" onClick={() => props.onNavigate({ dest: 'epics', ...(props.route.ws !== undefined ? { ws: props.route.ws } : {}) })}>Open epics</button>}
              />
            </section>
          </Show>
          <Show when={read() === 'error'}>
            <Show
              when={notice()}
              fallback={
                <StateNotice tone="error" title="Files could not be read" action={<button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryConnection}>Retry connection</button>}>
                  The scan did not return a usable result. Specs and Epics read their own records and may still be available.
                </StateNotice>
              }
            >
              {value => value()}
            </Show>
          </Show>
        </div>
      </Show>
      <Show when={read() !== 'empty' && read() !== 'error'}>
        <Show when={notice() === null && read() !== 'loading'}>
          <div class="list-refresh">
            <button type="button" class="ds-btn" aria-busy={pending()} onClick={refresh}>Refresh files</button>
          </div>
        </Show>
        <MasterDetail listLabel="Files waiting for a next step" list={listPane()}>
          {detailPane()}
        </MasterDetail>
      </Show>
    </div>
  );
}
