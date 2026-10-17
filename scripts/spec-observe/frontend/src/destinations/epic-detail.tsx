import { executionCounts, executionSummary, phaseLabel } from '../execution-state';
import { For, Show, createSignal, type JSX } from 'solid-js';
import { ActionBar, StateNotice, StatusText } from '../primitives';
import type { WireRecord } from '../model';
import { epicStats } from '../observation-format';
import { formatHash, type RouteState } from '../route';
import type { CatalogEntry } from '../scope';
import { landedStatus, memberPlanning, planningAssignmentFor, usableDecision, type PlanningFacts } from '../readiness';
import { discussionRepositoryTarget, plannedTargetChoices, startPackageHandoff, type PackagePlanningPlan, type PlannedTarget } from '../launch-handoff';
import { seedNewThreadDraft } from '../conversations-state';
import { packageRelative } from '../spec-state';
import { time } from '../format';
import { packagePlanningPlan, planningPlanDescription } from '../../../../workspaces/spec-prompt.mjs';
import {
  epicCoverageReasons,
  epicDocumentLinks,
  epicMemberPlanningRow,
  epicMemberPrerequisites,
  epicMemberRecord,
  epicMemberRequires,
  epicPlanningSummary,
  epicRecordedState,
  memberAgentRoute,
  memberIsMissing,
  memberRecords,
  nextToPlan,
  type EpicMemberPlanning,
} from './epic-state';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): WireRecord[] => (Array.isArray(value) ? value.filter(Boolean) : []);
const memberName = (member: WireRecord): string => text(member?.name);
const memberWorkspace = (epic: WireRecord, member: WireRecord): string => text(member?.workspace) || text(epic?.workspace);
const epicTitle = (epic: WireRecord): string => text(epic?.title) || text(epic?.epic) || 'Untitled epic';
const recordedFact = (recorded: { label: string; conflict: boolean }): string => {
  if (!recorded.conflict) return recorded.label;
  const state = recorded.label.replace(/^Recorded /, '');
  return state.charAt(0).toUpperCase() + state.slice(1);
};

// First member carrying a usable recorded decision: it owns the decision
// section and the Discuss hand-off. Readability of the front matter is decided
// by the shared readiness owner; an outcome-marked record never shadows a
// later member's usable question.
const decisionMemberOf = (epic: WireRecord): WireRecord | undefined =>
  list(epic.members).find(member => usableDecision(memberPlanning(member)?.decision ?? null));

// First member whose decision artifact exists but is unreadable: it owns the
// files-inspection fallback only when no member carries a usable decision.
const unreadableDecisionMemberOf = (epic: WireRecord): WireRecord | undefined =>
  list(epic.members).find(member => {
    const raw = memberPlanning(member)?.decision;
    return Boolean(raw) && !usableDecision(raw ?? null);
  });

// The recorded decision source opens through the package-files owner: an
// absolute source inside the package becomes package-relative, a safe
// relative source passes through, and anything else stays unroutable.
const decisionSourcePath = (epic: WireRecord, member: WireRecord | undefined, records: WireRecord[]): string => {
  const record = member ? epicMemberRecord(epic, member, records) : null;
  const source = text(usableDecision(memberPlanning(member)?.decision ?? null)?.source);
  if (!record || !source) return '';
  if (source.startsWith('/')) return packageRelative(record, source) ?? '';
  return source.split('/').includes('..') ? '' : source;
};

// The proposal the recorded decision points at, only when the observation
// confirms a readable proposal.
const decisionProposalPath = (member: WireRecord | undefined): string =>
  memberPlanning(member)?.proposal === true ? 'proposal.md' : '';

export function EpicObjectHead(props: { epic: WireRecord }) {
  const recorded = () => epicRecordedState(props.epic);
  const incomplete = () => epicPlanningSummary(props.epic).incomplete;
  const trail = () => [text(props.epic.workspace), text(props.epic.epic)].filter(Boolean).join(' / ');
  return (
    <div class="object-head">
      <div class="object-top">
        <h2>{epicTitle(props.epic)}</h2>
        <Show
          when={incomplete()}
          fallback={<StatusText tone={recorded().tone}>{recorded().label}</StatusText>}
        >
          <StatusText tone="warning">Planning incomplete</StatusText>
        </Show>
      </div>
      <p>{trail() || 'Epic record'}</p>
    </div>
  );
}

export function EpicConflictNotice(props: { epic: WireRecord }) {
  const recorded = () => epicRecordedState(props.epic);
  const stats = () => epicStats(props.epic);
  return (
    <Show when={recorded().conflict}>
      <StateNotice tone="warning" title="Recorded state conflicts with member evidence">
        {`The epic is recorded as ${recordedFact(recorded())}, but landing is confirmed for ${stats().landed} of ${stats().total} members in this observation. The records have not been rewritten; the conflicting evidence is preserved.`}
      </StateNotice>
    </Show>
  );
}

// Next-to-plan fact from the step-7 eligibility rule, never from epic.next
// alone: the label is the first member that can actually be planned and the
// note keeps the reason it is first (record order, requirements or none).
function nextPlanFact(epic: WireRecord, records: WireRecord[], assignments: WireRecord[]): { label: string; note: string } {
  const candidate = nextToPlan(epic, records, assignments);
  if (candidate) {
    const requires = epicMemberRequires(candidate);
    return {
      label: memberName(candidate) || 'Unnamed member',
      note: requires.names.length ? `Requires ${requires.names.join(', ')}` : 'First unplanned member',
    };
  }
  const stats = epicStats(epic);
  if (stats.total > 0 && stats.landed >= stats.total) return { label: 'None eligible', note: 'All members landed' };
  const decision = list(epic.members).find(member => memberPlanning(member)?.decision);
  if (decision) return { label: 'None eligible', note: `${memberName(decision)} needs a decision before planning` };
  const blocked = list(epic.members).find(member => {
    const facts = memberPlanning(member);
    return Boolean(facts) && facts!.prepared === false && !facts!.decision;
  });
  if (blocked) return { label: 'None eligible', note: `${memberName(blocked)} is waiting on prerequisites` };
  return { label: 'None eligible', note: 'No unplanned member is eligible in this observation' };
}

export function EpicFacts(props: { epic: WireRecord; records?: WireRecord[]; assignments?: WireRecord[] }) {
  const recorded = () => epicRecordedState(props.epic);
  const stats = () => epicStats(props.epic);
  const summary = () => epicPlanningSummary(props.epic, props.records ?? [], props.assignments ?? []);
  const next = () => nextPlanFact(props.epic, props.records ?? [], props.assignments ?? []);
  return (
    <>
      <div class="facts facts--4">
        <div class="fact">
          <label>Recorded epic state</label>
          <strong>{recordedFact(recorded())}</strong>
          <p>Operator-managed record</p>
        </div>
        <div class="fact">
          <label>Members prepared</label>
          <strong class="mono">{`${summary().prepared} of ${summary().total}`}</strong>
          <p>Derived from package files</p>
        </div>
        <div class="fact">
          <label>Members landed</label>
          <strong class="mono">{`${stats().landed} of ${stats().total}`}</strong>
          <p>Prepared work is not landed</p>
        </div>
        <div class="fact">
          <label>Next to plan</label>
          <strong class="id mono">{next().label}</strong>
          <p>{next().note}</p>
        </div>
      </div>
      <Show when={summary().incomplete}>
        <p class="section-note">
          <StatusText tone="warning">Planning incomplete</StatusText>
          {` ${summary().prepared} of ${summary().total} members are prepared or landed; the remaining members still need planning.`}
        </p>
      </Show>
    </>
  );
}

type MemberActionHandler = (member: WireRecord) => void;

export function EpicMembersTable(props: {
  epic: WireRecord;
  records: WireRecord[];
  assignments?: WireRecord[];
  rememberedMember?: string | null;
  onSelectPackage: (workspace: string, slug: string) => void;
  onPlan: MemberActionHandler;
  onImplement: MemberActionHandler;
  onNavigate: (route: RouteState) => void;
  actionRefusal: (member: WireRecord, row: EpicMemberPlanning) => string;
  handoffBusy: '' | 'plan' | 'implement';
}) {
  const members = () => list(props.epic.members);
  const assignments = () => props.assignments ?? [];
  const unmetOnly = () => members().some(member => !epicMemberRequires(member).declared);
  const follow = (route: RouteState | null) => (event: MouseEvent) => {
    if (!route) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    props.onNavigate(route);
  };
  return (
    <section class="section">
      <div class="section-heading"><h3>Dependency order</h3><span class="muted" /></div>
      <Show when={members().length} fallback={<p class="muted">No members recorded.</p>}>
        <div class="table-wrap">
          <table class="epic-members">
            <caption class="sr-only">{`Members of ${epicTitle(props.epic)} in dependency order`}</caption>
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Requires</th>
                <th scope="col">Status</th>
                <th scope="col" class="col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              <For each={members()}>{(member, index) => {
                const name = () => memberName(member);
                const workspace = () => memberWorkspace(props.epic, member);
                const requires = () => epicMemberRequires(member);
                const observed = () => epicMemberPlanningRow(props.epic, member, props.records, assignments());
                const matched = () => memberRecords(props.records, workspace(), name()).length > 0;
                const remembered = () => Boolean(name()) && props.rememberedMember === name();
                // The refusal disables the control; the row's advisory reason
                // (coverage, unlanded prerequisite) is shown beside it and the
                // operator may still start.
                const refusal = () => props.actionRefusal(member, observed());
                const reason = () => refusal() || observed().action.reason || '';
                const reasonId = () => `epic-member-action-${index()}`;
                return (
                  <tr data-remembered-member={remembered() ? 'true' : undefined}>
                    <th scope="row">
                      <Show
                        when={matched()}
                        fallback={
                          <>
                            <span class="mono">{name() || 'Unnamed member'}</span>
                            <br />
                            <small class="muted">No observed package matches this member in scope.</small>
                          </>
                        }
                      >
                        <button
                          type="button"
                          class="text-link mono"
                          aria-current={remembered() ? 'true' : undefined}
                          onClick={() => props.onSelectPackage(workspace(), name())}
                        >
                          {name() || 'Unnamed member'}
                        </button>
                      </Show>
                    </th>
                    <td>{requires().names.length ? requires().names.map(name => requires().waiting.includes(name) ? `${name} · waiting` : name).join(', ') : '—'}</td>
                    <td>
                      <StatusText tone={observed().status.tone}>{observed().status.label}</StatusText>
                      <Show when={observed().note}><span class="muted">{observed().note}</span></Show>
                      <Show when={executionSummary(observed().record ?? member)}>{summary => <span class="small execution-member-summary">{phaseLabel(summary().phase)}{summary().attention ? ' · Needs attention' : ''} · {executionCounts(observed().record ?? member)}</span>}</Show>
                    </td>
                    <td class="col-action">
                      <Show when={observed().action.kind === 'plan'}>
                        <button
                          type="button"
                          class="text-link"
                          data-action="plan"
                          disabled={Boolean(refusal()) || props.handoffBusy === 'plan'}
                          aria-describedby={reason() ? reasonId() : undefined}
                          onClick={() => props.onPlan(member)}
                        >
                          {props.handoffBusy === 'plan' ? 'Preparing…' : 'Plan'}
                        </button>
                      </Show>
                      <Show when={observed().action.kind === 'implement'}>
                        <button
                          type="button"
                          class="text-link"
                          data-action="implement"
                          disabled={Boolean(refusal()) || props.handoffBusy === 'implement'}
                          aria-describedby={reason() ? reasonId() : undefined}
                          onClick={() => props.onImplement(member)}
                        >
                          {props.handoffBusy === 'implement' ? 'Preparing…' : 'Implement spec'}
                        </button>
                      </Show>
                      <Show when={observed().action.kind === 'open-agent'}>
                        {(() => {
                          const route = memberAgentRoute(observed().action.owner, workspace());
                          return route ? (
                            <a
                              class="text-link"
                              data-action="open-agent"
                              href={formatHash(route)}
                              aria-label={`Open agent for ${name()}`}
                              onClick={follow(route)}
                            >
                              Open agent
                            </a>
                          ) : null;
                        })()}
                      </Show>
                      <Show when={observed().action.kind === 'none'}>
                        <span class="muted">—</span>
                      </Show>
                      <Show when={reason()}>
                        <span class="action-note" id={reasonId()} data-action-note={observed().action.kind}>{reason()}</span>
                      </Show>
                    </td>
                  </tr>
                );
              }}</For>
            </tbody>
          </table>
        </div>
        <Show when={unmetOnly()}>
          <p class="section-note">This observer reports only unmet requirements.</p>
        </Show>
      </Show>
    </section>
  );
}

type DocumentEntry = { name: string; source: string; route: RouteState | null };

function DocumentRow(props: { entry: DocumentEntry; onNavigate: (route: RouteState) => void }) {
  const follow = (event: MouseEvent) => {
    const route = props.entry.route;
    if (!route) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    props.onNavigate(route);
  };
  return (
    <tr>
      <th scope="row">
        <Show when={props.entry.route} fallback={<span class="mono">{props.entry.name}</span>}>
          {route => (
            <a class="text-link mono" href={formatHash(route())} onClick={follow}>
              {props.entry.name}
            </a>
          )}
        </Show>
      </th>
      <td><span class="mono">{props.entry.source}</span></td>
    </tr>
  );
}

export function EpicDocuments(props: {
  epic: WireRecord;
  catalog: CatalogEntry[];
  preferredWs?: string;
  onNavigate: (route: RouteState) => void;
}) {
  const rows = (): DocumentEntry[] => {
    const links = epicDocumentLinks(props.epic, props.catalog, props.preferredWs);
    return links.plan ? [links.plan, ...links.designs] : links.designs;
  };
  return (
    <section class="section epic-documents">
      <div class="section-heading"><h3>Supporting documents</h3><span class="muted" /></div>
      <Show when={rows().length} fallback={<p class="section-note">No plan or designs recorded.</p>}>
        <div class="table-wrap">
          <table class="epic-documents">
            <caption class="sr-only">{`Supporting documents of ${epicTitle(props.epic)}`}</caption>
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>{entry => <DocumentRow entry={entry} onNavigate={props.onNavigate} />}</For>
            </tbody>
          </table>
        </div>
      </Show>
    </section>
  );
}

// Planning candidates follow the nextToPlan rule without requiring they come
// first in record order, so the shell can say which independent members could
// be planned at the same time.
function planningCandidates(epic: WireRecord, records: WireRecord[], assignments: WireRecord[]): WireRecord[] {
  return list(epic.members).filter(member => {
    const lifecycle = text(member.status);
    const facts = memberPlanning(member);
    const resume = lifecycle === 'prepared' && facts?.prepared === false && !facts?.decision && (facts?.receipts?.length ?? 0) === 0;
    if (lifecycle !== 'proposed' && lifecycle !== 'unknown' && !resume) return false;
    if (!facts || facts.prepared !== false || facts.decision) return false;
    const record = epicMemberRecord(epic, member, records);
    if (planningAssignmentFor(record ?? member, assignments)) return false;
    return epicMemberPrerequisites(epic, member).every(fact => fact.state === 'landed' || fact.state === 'prepared');
  });
}

export function EpicNext(props: { epic: WireRecord; records?: WireRecord[]; assignments?: WireRecord[] }) {
  const members = () => list(props.epic.members);
  const records = () => props.records ?? [];
  const assignments = () => props.assignments ?? [];
  const candidate = () => nextToPlan(props.epic, records(), assignments());
  const lead = () => {
    const next = candidate();
    if (!next) {
      const stats = epicStats(props.epic);
      if (stats.total > 0 && stats.landed >= stats.total) return 'No member needs planning; every member has landed.';
      if (members().some(member => memberPlanning(member)?.decision)) return 'No member is eligible to plan until the recorded decision is discussed.';
      return 'No unplanned member is eligible in this observation.';
    }
    const facts = memberPlanning(next);
    return `Plan ${memberName(next)}. ${planningPlanDescription(packagePlanningPlan({
      proposal: facts?.proposal === true,
      critiqueRecommended: facts?.critiqueRecommended === true,
      critique: facts?.critique === true,
    }))}`;
  };
  const detail = () => {
    const next = candidate();
    if (!next) {
      const blocked = members().find(member => {
        const facts = memberPlanning(member);
        return Boolean(facts) && facts!.prepared === false && !facts!.decision;
      });
      return blocked ? `${memberName(blocked)} is waiting on its prerequisites.` : '';
    }
    const independent = planningCandidates(props.epic, records(), assignments())
      .filter(member => member !== next && !epicMemberRequires(member).names.includes(memberName(next)));
    const parts = ['Nothing is implemented.'];
    if (independent.length) {
      const names = independent.map(memberName).join(', ');
      parts.push(`${names} ${independent.length === 1 ? 'does' : 'do'} not depend on ${memberName(next)}, so ${independent.length === 1 ? 'it' : 'they'} can be planned at the same time.`);
    }
    return parts.join(' ');
  };
  return (
    <section class="section">
      <div class="section-heading"><h3>Next to plan</h3><span class="muted" /></div>
      <div class="obligation">
        {lead()}
        <Show when={detail()}><p>{detail()}</p></Show>
      </div>
    </section>
  );
}

export function EpicNotes(props: { epic: WireRecord }) {
  const notes = () => list(props.epic.members).filter(member => text(member?.note));
  return (
    <Show when={notes().length}>
      <section class="section">
        <div class="section-heading"><h3>Member notes</h3><span class="muted" /></div>
        <For each={notes()}>
          {member => <p>{`${memberName(member) || 'Unnamed member'}: ${text(member.note)}`}</p>}
        </For>
      </section>
    </Show>
  );
}

// Decision surface for an epic member whose planning stopped on recorded front
// matter (stage/question/recommendation/source). The question and
// recommendation stay observed facts; the options and full reasoning remain in
// the package files reached from the action bar. No planning is offered here.
export function EpicDecision(props: { epic: WireRecord; records: WireRecord[] }) {
  const member = () => decisionMemberOf(props.epic);
  const decision = () => usableDecision(memberPlanning(member())?.decision ?? null);
  const stage = () => text(decision()?.stage);
  const stageLabel = () => stage() === 'architecture'
    ? 'Architecture'
    : stage() === 'specification' ? 'Specification' : 'Planning';
  const name = () => (member() ? memberName(member()!) : '');
  const question = () => text(decision()?.question);
  const recommendation = () => text(decision()?.recommendation);
  const recordedAt = () => text(decision()?.recorded_at);
  const source = () => decisionSourcePath(props.epic, member(), props.records);
  return (
    <Show when={member() && decision()}>
      <section class="section epic-decision">
        <div class="section-heading"><h3>Decision needed</h3><span class="muted" /></div>
        <StateNotice
          tone="warning"
          title={`${name() || 'This member'}: ${stageLabel().toLowerCase()} recorded a decision${recordedAt() ? ` at ${time(recordedAt())}` : ''}`}
        >
          {`The ${stageLabel().toLowerCase()} stage recorded this question: ${question() || 'the question could not be read from the observation'}.${recommendation() ? ` Recommended: ${recommendation()}.` : ''}`}
        </StateNotice>
        <p class="section-note">
          {`${name() || 'This member'} stays Not planned until planning resumes. Other members can still be planned.`}
          {source() ? ` The recorded reasoning is in ${source().split('/').pop()}.` : ''}
        </p>
      </section>
    </Show>
  );
}

export function EpicDetail(props: {
  epic: WireRecord;
  records: WireRecord[];
  workspace?: WireRecord;
  rememberedMember?: string | null;
  onSelectPackage: (workspace: string, slug: string) => void;
  catalog: CatalogEntry[];
  preferredWs?: string;
  onNavigate: (route: RouteState) => void;
  notice?: JSX.Element;
  transportPrimary?: boolean;
  route?: RouteState;
  assignments?: WireRecord[];
  token?: string;
  live?: boolean;
  onOpenPackageFiles?: (record: WireRecord, path?: string) => void;
  canOpenPackageFiles?: (record: WireRecord) => boolean;
}) {
  const [handoffBusy, setHandoffBusy] = createSignal<'' | 'plan' | 'implement'>('');
  const [handoffError, setHandoffError] = createSignal('');
  const [handoffStatus, setHandoffStatus] = createSignal('');
  const members = () => list(props.epic.members);
  const assignments = () => props.assignments ?? [];
  const summary = () => epicPlanningSummary(props.epic, props.records, assignments());
  const coverage = () => epicCoverageReasons(props.epic);
  const recorded = () => epicRecordedState(props.epic);
  const stats = () => epicStats(props.epic);

  const handoffReason = (record: WireRecord | null): string => {
    if (!props.live) return 'Connect to the live workspace service to prepare this hand-off.';
    if (!props.token) return 'The workspace action token is unavailable.';
    if (!record) return 'No observed package matches this member in this observation.';
    if (plannedTargetChoices(Array.isArray(record.targets) ? record.targets as PlannedTarget[] : []).length === 0) {
      return 'No usable package target is available.';
    }
    return '';
  };
  // A planning stage past an intact proposal depends on observed critique
  // facts; an unknown recommendation is never coerced into an automatic
  // spec-write stage. An unreadable proposal presence refuses every planning
  // stage rather than deriving fresh architecture.
  const planStageReason = (facts: PlanningFacts | null): string => {
    if (!facts || facts.proposal === null) {
      return 'The proposal presence is not observed; inspect the proposal and package files before resuming planning.';
    }
    if (facts.proposal === true && facts.critiqueRecommended === null) {
      return 'The proposal does not record whether critique is recommended; inspect the proposal and package files before resuming planning.';
    }
    if (facts?.critiqueRecommended === true && facts.critique === null) {
      return 'The recommended critique outcome is not observed; inspect the proposal and package files before resuming planning.';
    }
    return '';
  };
  const actionRefusal = (member: WireRecord, row: EpicMemberPlanning): string => {
    if (row.action.kind !== 'plan' && row.action.kind !== 'implement') return row.action.reason ?? '';
    // A missing package directory is the row's own observed reason: the record
    // gates below only see an absent record and must not replace it.
    if (row.action.kind === 'plan' && memberIsMissing(member)) return row.action.reason ?? '';
    const record = epicMemberRecord(props.epic, member, props.records);
    const handoff = handoffReason(record);
    if (handoff) return handoff;
    // Only a row the readiness model itself withholds (unavailable preparation,
    // an unresolved planning prerequisite) refuses here. An advisory reason on
    // an enabled row (coverage, an unlanded prerequisite) is displayed by the
    // row and never disables the control; the planning-stage gate adds its
    // refusal only when the row would otherwise commit.
    const stage = row.action.kind === 'plan' ? planStageReason(memberPlanning(member)) : '';
    return (row.action.disabled ? row.action.reason ?? '' : '') || stage;
  };
  async function startHandoff(kind: 'plan' | 'implement', member: WireRecord) {
    if (handoffBusy()) return;
    const record = epicMemberRecord(props.epic, member, props.records);
    if (!record || !props.token || !props.live) return;
    const facts = memberPlanning(member);
    const blocked = actionRefusal(member, epicMemberPlanningRow(props.epic, member, props.records, assignments()));
    if (blocked) {
      setHandoffError(blocked);
      return;
    }
    setHandoffBusy(kind);
    setHandoffError('');
    setHandoffStatus('');
    try {
      const outcome = await startPackageHandoff(kind, {
        ws: memberWorkspace(props.epic, member),
        packageRef: text(record.package) || text(record.package_ref),
        targets: Array.isArray(record.targets) ? record.targets as PlannedTarget[] : [],
        planningPlan: kind === 'plan'
          ? packagePlanningPlan({
              proposal: facts?.proposal === true,
              critiqueRecommended: facts?.critiqueRecommended === true,
              critique: facts?.critique === true,
            }) as PackagePlanningPlan
          : undefined,
        returnRoute: props.route,
      }, props.token, props.onNavigate);
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
        : 'The hand-off could not be prepared. Retry from this member.');
    } finally {
      setHandoffBusy('');
    }
  }

  const nextMember = () => summary().next;
  const decisionMember = () => decisionMemberOf(props.epic);
  const unreadableMember = () => decisionMember() ? undefined : unreadableDecisionMemberOf(props.epic);
  const decision = () => usableDecision(memberPlanning(decisionMember())?.decision ?? null);
  const decisionPath = () => decisionSourcePath(props.epic, decisionMember(), props.records);
  const proposalPath = () => decisionProposalPath(decisionMember());
  const pendingPlans = () => members().filter(member => {
    if (landedStatus(member.status)) return false;
    const facts = memberPlanning(member);
    if (!facts || facts.prepared !== false || facts.decision) return false;
    const record = epicMemberRecord(props.epic, member, props.records);
    return !planningAssignmentFor(record ?? member, assignments());
  });
  // When only recorded decisions remain, no Plan commitment is rendered: the
  // decision surface (Discuss plus the recorded files) carries the primary and
  // nothing is committed from this screen.
  const decisionsOnly = () => !nextMember() && (Boolean(decisionMember()) || Boolean(unreadableMember())) && pendingPlans().length === 0;
  const planPrimaryReason = (): string => {
    const next = nextMember();
    if (!next) {
      if (stats().total > 0 && stats().landed >= stats().total) return 'All members have landed; there is no member to plan.';
      return 'No unplanned member is eligible in this observation.';
    }
    return actionRefusal(next, epicMemberPlanningRow(props.epic, next, props.records, assignments()));
  };
  const planNextMember = () => {
    const next = nextMember();
    if (!next) return;
    void startHandoff('plan', next);
  };
  const planEntry = () => epicDocumentLinks(props.epic, props.catalog, props.preferredWs).plan;
  const openPlanReason = (): string => planEntry()
    ? (planEntry()!.route ? '' : 'The plan document is outside the current workspace scope.')
    : 'No epic plan is recorded in this observation.';
  const followPlan = (event: MouseEvent) => {
    const route = planEntry()?.route;
    if (!route) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    props.onNavigate(route);
  };
  const decisionRecord = () => {
    const member = decisionMember() ?? unreadableMember();
    return member ? epicMemberRecord(props.epic, member, props.records) : null;
  };
  // Discuss seeds the conversations draft with the repository the package
  // actually binds, never the package-local target id: the single canonical
  // primary is resolved against the loaded workspace inventory. Several
  // distinct targets keep the accepted no-guess seed (no repository), and an
  // absent, unhealthy, unmatched or ambiguous inventory refuses with a visible
  // reason instead of seeding or navigating.
  const discussTarget = () => {
    const member = decisionMember();
    const record = decisionRecord();
    return discussionRepositoryTarget(
      props.workspace ?? null,
      member ? memberWorkspace(props.epic, member) : '',
      record && Array.isArray(record.targets) ? record.targets as PlannedTarget[] : [],
    );
  };
  const discussReason = () => {
    const resolution = discussTarget();
    return resolution.ok ? '' : resolution.reason;
  };
  const canOpenDecisionFiles = () => Boolean(decisionRecord() && props.canOpenPackageFiles?.(decisionRecord()!));
  const decisionFilesReason = () => 'Package files are unavailable for this selection.';
  const openDecisionFile = (path: string) => {
    const record = decisionRecord();
    if (!record || !path) return;
    props.onOpenPackageFiles?.(record, path);
  };
  // Discuss hands the observed decision to the real conversations seed owner:
  // the prepared text (member, question, recommendation) and the resolved
  // repository alias travel in memory only. The route carries no text and no
  // thread is created or messaged here; the production Start conversation
  // dialog consumes the seed on open. An unresolved target refuses without
  // seeding or navigating.
  const discussDecision = () => {
    const member = decisionMember();
    const ws = member ? memberWorkspace(props.epic, member) : '';
    if (!member || !ws) return;
    const resolution = discussTarget();
    if (!resolution.ok) return;
    const question = text(decision()?.question);
    const recommendation = text(decision()?.recommendation);
    const prepared = [
      `${memberName(member) || 'This member'} needs a decision.`,
      question ? `Question: ${question}` : '',
      recommendation ? `Recommendation: ${recommendation}` : '',
    ].filter(Boolean).join('\n');
    seedNewThreadDraft(ws, resolution.target ? { text: prepared, target: resolution.target } : { text: prepared });
    props.onNavigate({ dest: 'conversations', ws, tab: 'new' });
  };
  const conflictCompact = () => {
    if (!props.transportPrimary || !recorded().conflict) return '';
    return `The epic is recorded as ${recordedFact(recorded())}, but landing is confirmed for ${stats().landed} of ${stats().total} members in this observation. The records have not been rewritten; the conflicting evidence is preserved.`;
  };
  return (
    <>
      <EpicObjectHead epic={props.epic} />
      <div class="detail-body">
        {/* Regional notice slot: epics.tsx owns offline > stale > partial as
            the single live notice. When transport wins, the completion
            conflict stays as compact non-live text beside the landed fact
            and never becomes a second live region. */}
        <Show when={props.notice}>{props.notice}</Show>
        <Show when={conflictCompact()}>{compact => <p class="section-note">{compact()}</p>}</Show>
        <EpicFacts epic={props.epic} records={props.records} assignments={assignments()} />
        <Show when={coverage().length}>
          <p class="section-note">{`Coverage ${text(props.epic.coverage?.state) || 'partial'}: ${coverage().join('; ')}`}</p>
        </Show>
        <EpicDecision epic={props.epic} records={props.records} />
        <EpicNext epic={props.epic} records={props.records} assignments={assignments()} />
        <EpicMembersTable
          epic={props.epic}
          records={props.records}
          assignments={assignments()}
          rememberedMember={props.rememberedMember}
          onSelectPackage={props.onSelectPackage}
          onPlan={member => void startHandoff('plan', member)}
          onImplement={member => void startHandoff('implement', member)}
          onNavigate={props.onNavigate}
          actionRefusal={actionRefusal}
          handoffBusy={handoffBusy()}
        />
        <EpicDocuments epic={props.epic} catalog={props.catalog} preferredWs={props.preferredWs} onNavigate={props.onNavigate} />
        <EpicNotes epic={props.epic} />
      </div>
      <ActionBar>
        <Show when={!decisionsOnly()}>
          <button
            type="button"
            class={props.transportPrimary ? 'ds-btn' : 'ds-btn ds-btn--primary'}
            data-action="plan-member"
            disabled={Boolean(planPrimaryReason()) || Boolean(handoffBusy())}
            aria-describedby={planPrimaryReason() ? 'epic-plan-member-reason' : undefined}
            onClick={planNextMember}
          >
            {handoffBusy() === 'plan' ? 'Preparing brief…' : 'Plan member'}
          </button>
          <Show when={planPrimaryReason()}>
            <span class="action-note" id="epic-plan-member-reason" data-action-note="plan-member">{planPrimaryReason()}</span>
          </Show>
          <Show when={!planPrimaryReason() && nextMember()}>
            <span class="action-note" data-action-note="plan-target">Plans {memberName(nextMember()!)}</span>
          </Show>
          <Show when={handoffStatus() && !decisionsOnly()}>
            <span class="action-note" data-action-note="handoff-status" role="status">{handoffStatus()}</span>
          </Show>
          <Show when={handoffError()}>
            <span class="action-note" data-action-note="handoff-error" role="alert">{handoffError()} Nothing has been dispatched.</span>
          </Show>
        </Show>
        <Show
          when={planEntry()}
          fallback={
            <>
              <button type="button" class="ds-btn" disabled aria-describedby="epic-open-plan-reason">Open plan</button>
              <span class="action-note" id="epic-open-plan-reason">{openPlanReason()}</span>
            </>
          }
        >
          {entry => entry().route
            ? <a class="ds-btn" href={formatHash(entry().route!)} onClick={followPlan}>Open plan</a>
            : (
              <>
                <button type="button" class="ds-btn" disabled aria-describedby="epic-open-plan-reason">Open plan</button>
                <span class="action-note" id="epic-open-plan-reason">{openPlanReason()}</span>
              </>
            )}
        </Show>
        <Show when={decisionMember() && decision()}>
          <button
            type="button"
            class={decisionsOnly() ? 'ds-btn ds-btn--primary' : 'ds-btn'}
            data-action="discuss-decision"
            disabled={Boolean(discussReason())}
            aria-describedby={discussReason() ? 'epic-discuss-decision-reason' : undefined}
            onClick={discussDecision}
          >
            Discuss decision
          </button>
          <Show when={discussReason()}>
            <span class="action-note" id="epic-discuss-decision-reason" data-action-note="discuss-reason">{discussReason()}</span>
          </Show>
          <Show when={decisionPath()}>
            <button
              type="button"
              class="ds-btn"
              data-action="open-decision"
              disabled={!canOpenDecisionFiles()}
              aria-describedby={!canOpenDecisionFiles() ? 'epic-decision-files-reason' : undefined}
              onClick={() => openDecisionFile(decisionPath())}
            >
              Open decision
            </button>
          </Show>
          <Show when={proposalPath()}>
            <button
              type="button"
              class="ds-btn"
              data-action="open-proposal"
              disabled={!canOpenDecisionFiles()}
              aria-describedby={!canOpenDecisionFiles() ? 'epic-decision-files-reason' : undefined}
              onClick={() => openDecisionFile(proposalPath())}
            >
              Open proposal
            </button>
          </Show>
          <Show when={!canOpenDecisionFiles()}>
            <span class="action-note" id="epic-decision-files-reason" data-action-note="decision-files">{decisionFilesReason()}</span>
          </Show>
          <span class="action-note" data-action-note="decision">
            {decisionsOnly()
              ? 'A recorded decision needs discussion; no planning is committed from this screen.'
              : `Opens a conversation about ${memberName(decisionMember()!) || 'the recorded decision'}; sends nothing.`}
          </span>
        </Show>
        <Show when={decisionsOnly() && !decisionMember() && unreadableMember()}>
          <Show when={decisionRecord() && props.canOpenPackageFiles?.(decisionRecord()!)}>
            <button
              type="button"
              class="ds-btn ds-btn--primary"
              data-action="open-decision-files"
              onClick={() => props.onOpenPackageFiles?.(decisionRecord()!)}
            >
              Open files
            </button>
          </Show>
          <span class="action-note" data-action-note="decision">
            A recorded decision needs discussion; no planning is committed from this screen.
          </span>
        </Show>
      </ActionBar>
    </>
  );
}
