// Specs Ready surface: readiness facts, related work and the per-state action
// contract for prepared package inventory and epic members. Readiness comes
// only from observed planning facts (readiness.ts); the launch entry routes
// through the step-8 bound hand-off owner (launch-handoff.ts), which never
// creates a conversation/thread of its own. Exactly one primary action is
// rendered for the state; unavailable actions stay visible with the observed
// reason so an imported/offline/unknown snapshot cannot imply a launch.
import { For, Show, createMemo, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';
import { base, str, time } from './format';
import { ActionBar, StateNotice, StatusText } from './primitives';
import {
  coverageConcern, observedSpecReadiness, planningFactsFor, specReadiness, usableDecision,
  type PrerequisiteFact,
} from './readiness';
import { discussionRepositoryTarget, plannedTargetChoices, specHandoffInput, startPackageHandoff, type PlannedTarget } from './launch-handoff';
import { seedNewThreadDraft } from './conversations-state';
import { linkedAssignmentKey, packageRelative } from './spec-state';
import { catalogEntryForRecord, type CatalogEntry } from './scope';
import { formatHash } from './route';
import type { WireRecord } from './model';
import type { RouteState } from './route';

const list = (value: unknown): WireRecord[] =>
  Array.isArray(value) ? value.filter((item): item is WireRecord => typeof item === 'object' && item !== null) : [];
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const shortId = (value: unknown): string => {
  const id = text(value);
  return id.length > 8 ? id.slice(0, 8) : id;
};
const modifiedClick = (event: MouseEvent): boolean => event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;

export type SpecReadinessProps = {
  record: WireRecord;
  records?: WireRecord[];
  assignments: WireRecord[];
  epics?: WireRecord[];
  ws?: string;
  catalog?: CatalogEntry[];
  workspace?: WireRecord | null;
  live: boolean;
  token?: string;
  onOpenAgent: (key: string) => void;
  onOpenEpic: (key: string) => void;
  onSelectPackage: (workspace: string, name: string) => void;
  onOpenPackageFiles: (record: WireRecord, path?: string) => void;
  canOpenPackageFiles: (record: WireRecord) => boolean;
  onNavigate: (next: RouteState) => void;
  // When the destination supplies a footer target, the action contract is
  // portaled there so the primary stays in the fixed action region; without a
  // target (standalone use) the inline ActionBar below remains the fallback.
  actionsMount?: HTMLElement;
};

export default function SpecReadiness(props: SpecReadinessProps) {
  const record = (): WireRecord => props.record;
  const [handoffBusy, setHandoffBusy] = createSignal<'' | 'implement' | 'plan'>('');
  const [handoffError, setHandoffError] = createSignal('');
  const [handoffStatus, setHandoffStatus] = createSignal('');

  const observed = createMemo(() => observedSpecReadiness(record(), props.epics ?? [], props.assignments));
  const epicOf = () => observed().epic;
  const memberOf = () => observed().member;
  const prerequisitesOf = () => observed().prerequisites;
  const facts = () => observed().facts;
  const readiness = () => observed().readiness;

  const obligationTitle = (): string => {
    const value = readiness();
    if (value.state === 'waiting') return value.waitingOn.length ? `Waiting on ${value.waitingOn.join(' · ')}` : 'Prepared · waiting';
    if (value.state === 'planning') return 'Planning';
    if (value.state === 'decision') return 'Decision needed';
    if (value.state === 'starting') return 'Implementation starting';
    if (value.state === 'no-package') return 'No package';
    if (value.state === 'unknown') return 'Readiness unknown';
    return value.label;
  };
  const obligationText = (): string => {
    const value = readiness();
    if (value.state === 'ready') return 'Implementation runs spec-end-to-end from the prepared package through a draft pull request.';
    if (value.state === 'waiting') return value.reason ?? 'This package waits for its declared prerequisites.';
    if (value.state === 'incomplete') return value.reason ?? 'Preparation needs to be resumed before implementation.';
    if (value.state === 'not-planned') return value.reason ?? 'Planning needs to be started for this package.';
    if (value.state === 'decision') return value.reason ?? 'A recorded decision needs discussion before starting.';
    if (value.state === 'planning') return value.reason ?? 'A planning assignment owns this package.';
    if (value.state === 'starting') return value.reason ?? 'An implementation assignment owns this package.';
    if (value.state === 'no-package') return value.reason ?? 'The package directory is missing.';
    return value.reason ?? 'Readiness is not confirmed for this package.';
  };
  const obligationNote = (): string => {
    const value = readiness();
    if (value.state === 'ready') return 'Merge stays with the operator. Nothing has been dispatched for this package.';
    if (value.state === 'waiting') return 'Implementation can start now; changes from the waiting prerequisite may be missing from this package\'s branch.';
    if (value.state === 'incomplete') return 'Resume planning to complete the preparation report and index.';
    if (value.state === 'not-planned') return 'Start planning to prepare the specification and steps.';
    if (value.state === 'decision') return 'Discuss the recorded decision and review the package files before starting.';
    if (value.state === 'starting') return 'No run receipt is observed; this package remains assigned-only until a run is reported.';
    return '';
  };

  const preparedSteps = () => {
    const steps = facts()?.steps ?? null;
    if (steps === null) return { value: 'Unknown', note: 'No prepared specification index was observed.' };
    if (steps === 0) return { value: '0', note: 'No prepared steps recorded.' };
    return { value: String(steps), note: 'Steps in spec-steps.json' };
  };
  const preparationReport = () => {
    const preparation = facts()?.preparation ?? null;
    const outcome = text(preparation?.outcome);
    if (!preparation || !outcome) return { value: 'Not recorded', note: 'No preparation report was observed for this package.' };
    // An observed missing outcome is missing, never a recorded report: the old
    // fallback note claimed a report that was never read.
    if (outcome === 'missing') return { value: 'Missing', note: 'No preparation report was observed.' };
    const label = outcome.charAt(0).toUpperCase() + outcome.slice(1);
    const source = text(preparation.source);
    const reportedAt = text(preparation.reported_at);
    return {
      value: label,
      note: [source, reportedAt ? time(reportedAt) : ''].filter(Boolean).join(' · ') || 'Preparation report recorded',
    };
  };
  const relatedAssignments = (): WireRecord[] => list(props.assignments).filter(item =>
    text(item.workspace) === text(record().workspace)
    && [str(record().package), str(record().package_ref), str(record().package_path)].filter(Boolean).includes(text(item.spec_package)),
  ).sort((a, b) => (Date.parse(text(b.created_at)) || 0) - (Date.parse(text(a.created_at)) || 0));
  const executionHistory = () => {
    const owner = readiness().owner;
    if (owner) {
      return {
        value: 'Assignment owned',
        note: `${shortId(owner.assignment_id)} · ${text(owner.display) || 'recorded'}`,
      };
    }
    const related = relatedAssignments();
    if (related.length) {
      const latest = related[0];
      return {
        value: `${related.length} recorded`,
        note: `Latest ${shortId(latest.assignment_id)} · ${text(latest.display) || 'recorded'}`,
      };
    }
    if (facts()?.worktreeRecorded) return { value: 'Recorded', note: 'A worktree was recorded for this package.' };
    return { value: 'None', note: 'No dispatch, no worktree' };
  };
  // Observed epic prerequisites stay visible on assignment-owned details: the
  // readiness result drops them for planning/starting owners, so display rows
  // fall back to the observed member facts without changing owner precedence.
  const prerequisiteRows = (): PrerequisiteFact[] =>
    readiness().prerequisites.length ? readiness().prerequisites : (prerequisitesOf() ?? []);
  const prerequisiteFact = () => {
    const rows = prerequisiteRows();
    if (!rows.length) return { value: 'None', note: 'Nothing to wait for' };
    const waiting = rows.filter(item => item.state !== 'landed');
    return {
      value: waiting.length ? `${waiting.length} waiting` : 'All landed',
      note: rows.map(item => `${item.name} · ${item.state}`).join(', '),
    };
  };

  const epicKey = (): string => {
    const epic = epicOf();
    return epic ? JSON.stringify([epic.workspace, epic.epic]) : '';
  };
  const epicTitle = (): string => {
    const epic = epicOf();
    if (!epic) return '';
    const members = list(epic.members);
    const member = memberOf();
    const index = member ? members.indexOf(member) : -1;
    const title = text(epic.title) || text(epic.epic);
    return index >= 0 ? `${title} · member ${index + 1} of ${members.length}` : title;
  };
  const prerequisiteRecord = (name: string): WireRecord | null => {
    const epic = epicOf();
    const sibling = epic ? list(epic.members).find(item => text(item.name) === name) : null;
    const workspace = text(sibling?.workspace) || text(epic?.workspace) || text(record().workspace);
    const target = text(sibling?.package) || name;
    return list(props.records).find(item =>
      text(item.workspace) === workspace
      && [str(item.package), str(item.package_ref), str(item.name)].some(value => value === target || base(value) === base(target)),
    ) ?? null;
  };
  // A prerequisite may live in its own workspace: resolve the prerequisite
  // record's own catalog entry rather than the selected spec's scope. An
  // unresolved entry leaves ws unset instead of guessing.
  const prerequisiteWs = (item: WireRecord): string | undefined => catalogEntryForRecord(item, 'run', props.catalog ?? [])?.id;
  const reportPath = (): string => {
    const source = text(facts()?.preparation?.source);
    if (!source) return '';
    if (source.startsWith('/')) return packageRelative(record(), source) ?? '';
    return source.split('/').includes('..') ? '' : source;
  };
  const ownerKey = (): string | null => {
    const owner = readiness().owner;
    if (owner) return JSON.stringify([text(owner.workspace) || text(owner.workspace_id), text(owner.assignment_id)]);
    return linkedAssignmentKey(record(), props.assignments);
  };

  const gate = (): string => {
    if (!props.live) return 'Connect to the live workspace service to prepare this hand-off.';
    if (!props.token) return 'The workspace action token is unavailable.';
    if (plannedTargetChoices(Array.isArray(record().targets) ? record().targets as PlannedTarget[] : []).length === 0) {
      return `No usable package target is available. On the execution host run: node ~/.agents/scripts/spec-location/cli.mjs materialize ${str(record().package_ref) || 'WORKSPACE/SLUG'} and refresh.`;
    }
    return '';
  };
  // Everything short of a missing target or an unreachable service is a
  // concern, not a refusal: the operator reads it in the panel and may start
  // anyway. The launch service still refuses a live owner or an unavailable
  // package at start time.
  const concerns = (): string[] => {
    const value = readiness();
    const items: string[] = [];
    if (value.state === 'waiting') {
      items.push(`${value.reason ?? 'A prerequisite has not landed'}. Its changes may be missing from this package's branch; open the prerequisite to check its state.`);
    }
    if (value.state === 'decision') items.push(`A recorded decision is unresolved: ${value.reason ?? 'see the preparation report'}. Resolve it in the package files first, or start and let the agent raise it.`);
    if (value.state === 'planning' || value.state === 'starting') {
      items.push(`${value.reason ?? 'An assignment owns this package.'} The launch service refuses a second owner while it is live; open the agent to inspect or end it.`);
    }
    if (value.state === 'unknown') items.push(value.reason ?? 'Readiness is not confirmed in this snapshot.');
    const coverage = coverageConcern(record());
    if (coverage) items.push(coverage);
    return items;
  };
  // Planning stages past an intact proposal depend on observed critique facts.
  // An unknown recommendation is never coerced into no-critique and an
  // automatic spec-write: Resume planning stays disabled until the proposal
  // and package files are inspected. An unreadable proposal presence refuses
  // every planning stage rather than deriving fresh architecture.
  const planGate = (): string => {
    const baseGate = gate();
    if (baseGate) return baseGate;
    const value = facts();
    if (!value || value.proposal === null) {
      return 'The proposal presence is not observed; inspect the package files before resuming planning.';
    }
    if (value?.proposal === true && value.critiqueRecommended === null) {
      return 'The proposal does not record whether critique is recommended; inspect the proposal and package files before resuming planning.';
    }
    if (value?.critiqueRecommended === true && value.critique === null) {
      return 'The recommended critique outcome is not observed; inspect the proposal and package files before resuming planning.';
    }
    // The shared planning readiness owns prerequisite truth: prepared or landed
    // dependencies may plan before merge, unresolved/unknown dependencies and
    // a live owner or recorded decision refuse entry.
    const permission = specReadiness(record(), {
      action: 'plan',
      assignments: props.assignments,
      prerequisites: prerequisitesOf(),
    });
    if (!permission.launchable) return permission.reason ?? 'Planning is not confirmed for this package.';
    return '';
  };
  // Only the hard gate disables Implement spec; readiness concerns stay advisory.
  const implementGate = (): string => gate();

  async function startHandoff(kind: 'implement' | 'plan') {
    if (handoffBusy() || !props.live || !props.token) return;
    // A planning launch must never coerce an unknown stage into spec-write:
    // the same gate that disables Resume planning blocks the dispatch itself.
    if (kind === 'plan' && planGate()) return;
    setHandoffBusy(kind);
    setHandoffError('');
    setHandoffStatus('');
    try {
      const outcome = await startPackageHandoff(kind, specHandoffInput(record(), kind, facts()), props.token, props.onNavigate);
      if (!outcome.ok) {
        setHandoffError(outcome.reason);
        return;
      }
      setHandoffStatus(kind === 'plan'
        ? 'Planning brief opened. Nothing has been dispatched yet.'
        : 'Assignment review opened. Nothing has been dispatched yet.');
    } catch (error) {
      setHandoffError(error instanceof Error && error.message
        ? error.message
        : 'The hand-off could not be prepared. Retry from this package.');
    } finally {
      setHandoffBusy('');
    }
  }

  const filesGate = (): string => props.canOpenPackageFiles(record()) ? '' : 'Package files are unavailable for this selection.';
  // Waiting and decision states give the prerequisite link or the read-files
  // action the state's single primary; Implement stays secondary beside it.
  const implementButton = (secondary = false) => (
    <>
      <button
        type="button"
        class={secondary ? 'ds-btn' : 'ds-btn ds-btn--primary'}
        data-action="implement"
        disabled={Boolean(implementGate()) || Boolean(handoffBusy())}
        aria-describedby={implementGate() ? 'readiness-implement-reason' : concerns().length ? 'readiness-implement-concerns' : undefined}
        onClick={() => void startHandoff('implement')}
      >{handoffBusy() === 'implement' ? 'Preparing review…' : 'Implement spec'}</button>
      <Show when={implementGate()}>
        <span class="action-note" id="readiness-implement-reason" data-action-note="implement">{implementGate()}</span>
      </Show>
      <Show when={!implementGate() && concerns().length > 0}>
        <span class="action-note" data-action-note="implement-concerns">{concerns().length === 1 ? '1 concern' : `${concerns().length} concerns`} noted above; you can still start.</span>
      </Show>
      <Show when={!implementGate() && handoffStatus()}>
        <span class="action-note" data-action-note="handoff-status" role="status">{handoffStatus()}</span>
      </Show>
      <Show when={!implementGate() && handoffError()}>
        <span class="action-note" data-action-note="implement-error" role="alert">{handoffError()} Nothing has been dispatched.</span>
      </Show>
    </>
  );
  const prerequisitePrimary = () => {
    const name = readiness().waitingOn[0] ?? readiness().prerequisites.find(item => item.state !== 'landed')?.name ?? '';
    const target = name ? prerequisiteRecord(name) : null;
    if (target) {
      const key = text(target.key);
      return (
        <a
          class="ds-btn ds-btn--primary"
          data-action="open-prerequisite"
          data-prerequisite={name}
          href={formatHash({ dest: 'specs', ws: prerequisiteWs(target), id: key })}
          onClick={event => {
            if (modifiedClick(event)) return;
            event.preventDefault();
            props.onSelectPackage(text(target.workspace), base(target.package));
          }}
        >Open prerequisite</a>
      );
    }
    return (
      <>
        <button type="button" class="ds-btn ds-btn--primary" data-action="open-prerequisite" disabled aria-describedby="readiness-prerequisite-reason">Open prerequisite</button>
        <span class="action-note" id="readiness-prerequisite-reason" data-action-note="prerequisite">
          The prerequisite {name || 'record'} is not observed in this snapshot.
        </span>
      </>
    );
  };
  const resumePlanning = () => (
    <>
      <button
        type="button"
        class="ds-btn ds-btn--primary"
        data-action="resume-planning"
        disabled={Boolean(planGate()) || Boolean(handoffBusy())}
        aria-describedby={planGate() ? 'readiness-plan-reason' : undefined}
        onClick={() => void startHandoff('plan')}
      >{handoffBusy() === 'plan' ? 'Preparing brief…' : 'Resume planning'}</button>
      <Show when={planGate()}>
        <span class="action-note" id="readiness-plan-reason" data-action-note="resume-planning">{planGate()}</span>
      </Show>
      <Show when={reportPath()}>
        <button
          type="button"
          class="ds-btn"
          data-action="open-preparation-report"
          disabled={Boolean(filesGate())}
          aria-describedby={filesGate() ? 'readiness-files-reason' : undefined}
          onClick={() => props.onOpenPackageFiles(record(), reportPath())}
        >Open preparation report</button>
      </Show>
      <button
        type="button"
        class="ds-btn"
        data-action="open-package-files"
        disabled={Boolean(filesGate())}
        aria-describedby={filesGate() ? 'readiness-files-reason' : undefined}
        onClick={() => props.onOpenPackageFiles(record())}
      >Open package files</button>
      <Show when={filesGate()}>
        <span class="action-note" id="readiness-files-reason" data-action-note="package-files">{filesGate()}</span>
      </Show>
      <Show when={handoffStatus()}>
        <span class="action-note" data-action-note="handoff-status" role="status">{handoffStatus()}</span>
      </Show>
      <Show when={handoffError()}>
        <span class="action-note" data-action-note="plan-error" role="alert">{handoffError()} Nothing has been dispatched.</span>
      </Show>
    </>
  );
  const openAgent = () => (
    <>
      <button
        type="button"
        class="ds-btn ds-btn--primary"
        data-action="open-agent"
        disabled={Boolean(ownerKey()) ? false : true}
        aria-describedby={ownerKey() ? undefined : 'readiness-agent-reason'}
        onClick={() => {
          const key = ownerKey();
          if (key) props.onOpenAgent(key);
        }}
      >Open agent</button>
      <Show when={!ownerKey()}>
        <span class="action-note" id="readiness-agent-reason" data-action-note="open-agent">The owning assignment is not observed in this snapshot.</span>
      </Show>
    </>
  );
  // Discuss hands the observed Spec decision to the real conversations seed
  // owner: prepared text (package title, question, recommendation) and the
  // resolved repository alias travel in memory only. The route carries no text
  // and no thread is created here. The workspace identity is the resolved
  // props.ws, never a directory-derived basename. A refused canonical target
  // resolution disables the action with a visible reason instead of guessing.
  const discussTarget = () => discussionRepositoryTarget(
    props.workspace ?? null,
    text(props.ws),
    Array.isArray(record().targets) ? record().targets as PlannedTarget[] : [],
  );
  const discussReason = (): string => {
    const resolution = discussTarget();
    return resolution.ok ? '' : resolution.reason;
  };
  const discussTitle = (): string =>
    text(record().title) || base(text(record().package_ref) || text(record().package)) || 'This package';
  const discussDecision = () => {
    const ws = text(props.ws);
    if (!ws) return;
    const resolution = discussTarget();
    if (!resolution.ok) return;
    const decision = usableDecision(facts()?.decision ?? null);
    const question = text(decision?.question);
    const recommendation = text(decision?.recommendation);
    const prepared = [
      `${discussTitle()} needs a decision.`,
      question ? `Question: ${question}` : '',
      recommendation ? `Recommendation: ${recommendation}` : '',
    ].filter(Boolean).join('\n');
    seedNewThreadDraft(ws, resolution.target ? { text: prepared, target: resolution.target } : { text: prepared });
    props.onNavigate({ dest: 'conversations', ws, tab: 'new' });
  };
  const decisionPrimary = () => (
    <>
      <button
        type="button"
        class="ds-btn ds-btn--primary"
        data-action="discuss-decision"
        disabled={Boolean(discussReason())}
        aria-describedby={discussReason() ? 'readiness-discuss-reason' : undefined}
        onClick={discussDecision}
      >Discuss decision</button>
      <Show when={discussReason()}>
        <span class="action-note" id="readiness-discuss-reason" data-action-note="discuss-reason">{discussReason()}</span>
      </Show>
      <button
        type="button"
        class="ds-btn"
        data-action="open-preparation"
        disabled={Boolean(filesGate())}
        aria-describedby={filesGate() ? 'readiness-files-reason' : undefined}
        onClick={() => props.onOpenPackageFiles(record(), reportPath() || undefined)}
      >{reportPath() ? 'Open preparation report' : 'Open package files'}</button>
      <Show when={filesGate()}>
        <span class="action-note" id="readiness-files-reason" data-action-note="package-files">{filesGate()}</span>
      </Show>
    </>
  );
  const actions = () => {
    const value = readiness();
    if (value.state === 'waiting') return <>{prerequisitePrimary()}{implementButton(true)}</>;
    if (value.state === 'incomplete' || value.state === 'not-planned') return resumePlanning();
    if (value.state === 'planning' || value.state === 'starting') return <>{openAgent()}{implementButton(true)}</>;
    if (value.state === 'decision') return <>{decisionPrimary()}{implementButton(true)}</>;
    return implementButton();
  };

  return (
    <section class="section spec-readiness" id="spec-readiness" data-state={readiness().state} aria-labelledby="readiness-heading">
      <div class="section-heading">
        <h3 id="readiness-heading">{obligationTitle()}</h3>
        <StatusText tone={readiness().tone}>{readiness().label}</StatusText>
      </div>
      <Show
        when={readiness().state === 'incomplete'}
        fallback={
          <div class="obligation">
            <p>{obligationText()}</p>
            <Show when={obligationNote()}>
              <p>{obligationNote()}</p>
            </Show>
          </div>
        }
      >
        <StateNotice tone="warning" title="Implementation is unavailable until preparation completes">
          {obligationText()}
        </StateNotice>
      </Show>
      <Show when={concerns().length > 0}>
        <details class="readiness-concerns" id="readiness-implement-concerns" data-concerns={concerns().length}>
          <summary>Why Implement spec might not start ({concerns().length})</summary>
          <ul><For each={concerns()}>{item => <li>{item}</li>}</For></ul>
          <p>You can still start it. The launch service checks the package and any live owner at start time and shows a refusal on the review page instead of starting an agent.</p>
        </details>
      </Show>
      <div class="facts four">
        <div class="fact" data-fact="prepared-steps">
          <label>Prepared steps</label>
          <strong class="mono">{preparedSteps().value}</strong>
          <p>{preparedSteps().note}</p>
        </div>
        <div class="fact" data-fact="preparation-report">
          <label>Preparation report</label>
          <strong>{preparationReport().value}</strong>
          <p>{preparationReport().note}</p>
        </div>
        <div class="fact" data-fact="execution-history">
          <label>Execution history</label>
          <strong>{executionHistory().value}</strong>
          <p>{executionHistory().note}</p>
        </div>
        <div class="fact" data-fact="prerequisites">
          <label>Prerequisites</label>
          <strong>{prerequisiteFact().value}</strong>
          <p>{prerequisiteFact().note}</p>
        </div>
      </div>
      <section class="section">
        <div class="section-heading"><h3>Related work</h3></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th scope="col">Object</th><th scope="col">Reference</th></tr></thead>
            <tbody>
              <tr>
                <td>Epic</td>
                <td>
                  <Show
                    when={epicOf()}
                    fallback={<span>{text(record().epic?.epic) ? `Epic ${text(record().epic?.epic)} is not in this snapshot` : 'Not recorded'}</span>}
                  >
                    <a
                      class="text-link"
                      data-related="epic"
                      href={formatHash({ dest: 'epics', ws: props.ws, id: epicKey() })}
                      onClick={event => {
                        if (modifiedClick(event)) return;
                        event.preventDefault();
                        props.onOpenEpic(epicKey());
                      }}
                    >{epicTitle()}</a>
                  </Show>
                </td>
              </tr>
              <For each={prerequisiteRows()}>{fact => {
                const target = () => prerequisiteRecord(fact.name);
                return (
                  <tr>
                    <td>Prerequisite · {fact.name}</td>
                    <td>
                      <Show when={target()} fallback={<span>{fact.name}</span>}>
                        {item => (
                          <a
                            class="text-link"
                            data-prerequisite={fact.name}
                            href={formatHash({ dest: 'specs', ws: prerequisiteWs(item()), id: text(item().key) })}
                            onClick={event => {
                              if (modifiedClick(event)) return;
                              event.preventDefault();
                              props.onSelectPackage(text(item().workspace), base(item().package));
                            }}
                          >{fact.name}</a>
                        )}
                      </Show>
                      <span class="muted"> {fact.state}</span>
                    </td>
                  </tr>
                );
              }}</For>
              <Show when={reportPath()}>
                <tr>
                  <td>Preparation report</td>
                  <td>
                    <button
                      type="button"
                      class="ds-btn"
                      data-related="preparation-report"
                      disabled={Boolean(filesGate())}
                      aria-describedby={filesGate() ? 'readiness-related-files-reason' : undefined}
                      onClick={() => props.onOpenPackageFiles(record(), reportPath())}
                    >Open preparation report</button>
                  </td>
                </tr>
              </Show>
              <Show when={facts()?.proposal === true}>
                <tr>
                  <td>Proposal</td>
                  <td>
                    <button
                      type="button"
                      class="ds-btn"
                      data-related="proposal"
                      disabled={Boolean(filesGate())}
                      aria-describedby={filesGate() ? 'readiness-related-files-reason' : undefined}
                      onClick={() => props.onOpenPackageFiles(record())}
                    >Proposal recorded · open package files</button>
                  </td>
                </tr>
              </Show>
              <tr>
                <td>Package files</td>
                <td>
                  <button
                    type="button"
                    class="ds-btn"
                    data-related="package-files"
                    disabled={Boolean(filesGate())}
                    aria-describedby={filesGate() ? 'readiness-related-files-reason' : undefined}
                    onClick={() => props.onOpenPackageFiles(record())}
                  >Open package files</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <Show when={filesGate()}>
          <p class="small muted" id="readiness-related-files-reason">{filesGate()}</p>
        </Show>
      </section>
      <Show
        when={props.actionsMount}
        fallback={<ActionBar variant="inline">{actions()}</ActionBar>}
      >
        {mount => (
          <Portal mount={mount()}>
            <div id="spec-readiness-actions" aria-label="Readiness actions">{actions()}</div>
          </Portal>
        )}
      </Show>
      <Show when={handoffError()}>
        <StateNotice tone="error" title="Hand-off not prepared">
          {handoffError()} Nothing has been dispatched; the observed package facts are retained.
        </StateNotice>
      </Show>
    </section>
  );
}

export type SpecImplementEntryProps = {
  record: WireRecord;
  live: boolean;
  token?: string;
  onOpenPackageFiles: (record: WireRecord, path?: string) => void;
  canOpenPackageFiles: (record: WireRecord) => boolean;
  onNavigate: (next: RouteState) => void;
};

// Adjacent fallback entry for packages without a prior end-to-end assignment:
// the same bound implement hand-off as the Ready primary, but secondary (the
// row's own action bar keeps the primary action) and with no thread creation.
export function SpecImplementEntry(props: SpecImplementEntryProps) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const gate = (): string => {
    if (!props.live) return 'Connect to the live workspace service to start implementation.';
    if (!props.token) return 'The workspace action token is unavailable.';
    if (plannedTargetChoices(Array.isArray(props.record.targets) ? props.record.targets as PlannedTarget[] : []).length === 0) {
      return 'No usable package target is available.';
    }
    return '';
  };
  async function start() {
    if (busy() || gate()) return;
    setBusy(true);
    setError('');
    try {
      const outcome = await startPackageHandoff('implement', specHandoffInput(props.record, 'implement', planningFactsFor(props.record)), props.token ?? '', props.onNavigate);
      if (!outcome.ok) setError(outcome.reason);
    } catch (cause) {
      setError(cause instanceof Error && cause.message
        ? cause.message
        : 'The hand-off could not be prepared. Retry from this package.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionBar variant="inline">
      <button
        type="button"
        class="ds-btn"
        data-action="implement-again"
        disabled={Boolean(gate()) || busy()}
        aria-describedby={gate() ? 'spec-implement-again-reason' : undefined}
        onClick={() => void start()}
      >{busy() ? 'Preparing review…' : 'Implement spec'}</button>
      <span class="action-note" id="spec-implement-again-reason" data-action-note="implement-again" role={gate() ? undefined : 'status'}>
        {gate() || error() || 'Opens the assignment review; nothing is dispatched until you start it.'}
      </span>
    </ActionBar>
  );
}
