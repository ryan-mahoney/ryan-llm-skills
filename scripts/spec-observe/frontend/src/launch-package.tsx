// Bound package review composition for the plan/implement hand-offs.
//
// The resolved preview record is the only source for execution, authority and
// model facts; snapshot records and epics only supply observed package status
// and identity links. These components present facts and refusal states only:
// launch-state.ts keeps identity/approval/submission ownership, Launch keeps
// the action gates and focus/announce behavior, and launch-client.ts remains
// the only transport mapping.
import { For, Match, Show, Switch } from 'solid-js';
import { ActionBar, StateNotice, StatusText } from './primitives';
import { str, time } from './format';
import { packagePlanningPlan } from '../../../workspaces/spec-prompt.mjs';
import { landedStatus, memberPlanning, nextToPlan, planningFactsFor, specReadiness } from './readiness';
import type { PackagePlanningPlan } from './launch-handoff';
import type { LaunchPreview, LaunchResult } from './launch-state';
import type { WireRecord } from './model';

export type PackageReviewKind = 'plan' | 'implement';

const PLANNING_SKILLS: readonly string[] = ['spec-architect-initial', 'spec-architect-critics', 'spec-write'];
const IMPLEMENTATION_SKILL = 'spec-end-to-end';

// Bound detection covers exactly the package hand-off skills. Anything else
// (including a generic package skill) returns null so Launch keeps the
// ordinary assignment presentation.
export function packageReviewKind(skill: unknown): PackageReviewKind | null {
  const value = typeof skill === 'string' ? skill : '';
  if (PLANNING_SKILLS.includes(value)) return 'plan';
  return value === IMPLEMENTATION_SKILL ? 'implement' : null;
}

type ContractFact = { key: string; label: string; value: string };

const authorityLabel = (value: string): string => {
  const text = value.trim();
  if (!text || text.toLowerCase() === 'none') return 'None';
  if (text === 'draft-pr') return 'Draft pull request only';
  return text;
};

// Observed snapshot row for this package. It supplies statuses and the spec
// identity link only; it never overrides the resolved preview record's
// execution, authority or model facts.
const packageRecordOf = (records: WireRecord[] | undefined, packageRef: string): WireRecord | undefined =>
  (records ?? []).find(record => [str(record.package), str(record.package_ref)].includes(packageRef));

export type CanonicalMember = { epic: WireRecord; member: WireRecord };

// Workspace-scoped canonical member join. The resolved record's workspace
// (workspace_id first) scopes the match so an equal-named foreign member can
// never supply status; within one workspace the member slug is the canonical
// identity. Missing workspace or member data stays unknown instead of
// claiming no prerequisites.
export const canonicalMemberOf = (
  epics: WireRecord[] | undefined,
  record: WireRecord,
  packageRef: string,
): CanonicalMember | null => {
  const workspace = str(record.workspace_id) || str(record.workspace) || '';
  const candidates = [str(record.package_ref), str(record.spec_package), str(record.package), str(packageRef)].filter(Boolean);
  const identities = new Set<string>();
  for (const candidate of candidates) {
    identities.add(candidate);
    const parts = candidate.split('/').filter(Boolean);
    if (parts.length) identities.add(parts[parts.length - 1]);
  }
  for (const epic of epics ?? []) {
    const members = Array.isArray(epic.members) ? (epic.members as WireRecord[]) : [];
    for (const member of members) {
      const memberWorkspace = str(member.workspace) || str(epic.workspace) || '';
      if (workspace && memberWorkspace && memberWorkspace !== workspace) continue;
      const ids = [str(member.package), str(member.name)].filter(Boolean);
      if (ids.some(id => identities.has(id))) return { epic, member };
    }
  }
  return null;
};

// Next independent member after a confirmed planning launch. Observed
// assignments reach the shared eligibility owner so live owners are never
// re-offered, and the just-confirmed launch identity is excluded
// immediately: the observer has not caught up, so no assignment row observes
// it yet, and without exclusion the result would offer the launched member
// itself while its own assignment runs.
export const nextPlannableMember = (
  epics: WireRecord[] | undefined,
  record: WireRecord,
  packageRef: string,
  records: WireRecord[],
  assignments: WireRecord[] | undefined,
): WireRecord | null => {
  const found = canonicalMemberOf(epics, record, packageRef);
  if (!found) return null;
  const launched = new Set<string>();
  for (const candidate of [str(record.package_ref), str(record.spec_package), str(record.package), packageRef].filter(Boolean)) {
    launched.add(candidate);
    const parts = candidate.split('/').filter(Boolean);
    if (parts.length) launched.add(parts[parts.length - 1]);
  }
  const members = Array.isArray(found.epic.members) ? (found.epic.members as WireRecord[]) : [];
  const remaining = members.filter(member => !launched.has(str(member.package)) && !launched.has(str(member.name)));
  return nextToPlan({ ...found.epic, members: remaining }, records, assignments ?? []);
};

// Stage ids come from the shared spec-prompt owner: the resolved planning
// skill selects its canonical plan, never a locally re-typed stage list. The
// bound brief selects the proposal-stop variant: an explicit proposal-only
// brief stays at Proposal, while fresh architecture keeps its conditional
// critique stop instead of promising Prepared.
export const planningPlanFor = (record: WireRecord, inputPreview?: { brief?: unknown; instruction?: unknown }): PackagePlanningPlan => {
  const skill = str(record.skill);
  if (skill === 'spec-architect-critics') return packagePlanningPlan({ proposal: true, critiqueRecommended: true }) as PackagePlanningPlan;
  if (skill === 'spec-write') return packagePlanningPlan({ proposal: true }) as PackagePlanningPlan;
  if (skill === 'spec-architect-initial') {
    const briefText = `${str(inputPreview?.brief)}\n${str(inputPreview?.instruction)}`;
    if (/This launch ends at the proposal/i.test(briefText)) return packagePlanningPlan({ proposal: false, critiqueRecommended: true }) as PackagePlanningPlan;
    return packagePlanningPlan() as PackagePlanningPlan;
  }
  return packagePlanningPlan() as PackagePlanningPlan;
};

export const isConditionalInitial = (record: WireRecord, plan: PackagePlanningPlan): boolean =>
  str(record.skill) === 'spec-architect-initial'
  && plan.skill === 'spec-architect-initial'
  && plan.stop === 'prepared'
  && plan.stages.includes('spec-write');

export const planningStagesValue = (record: WireRecord, plan: PackagePlanningPlan): string => {
  const stages = plan.stages.map((stage, index) => `${index + 1} ${stage}`).join(' → ');
  if (!stages) return 'No stages recorded';
  if (isConditionalInitial(record, plan)) return `${stages} (stops at Proposal if critique is recommended)`;
  return stages;
};

export const planningStopValue = (record: WireRecord, plan: PackagePlanningPlan): string => {
  if (plan.stop === 'proposal') return 'Proposal';
  if (isConditionalInitial(record, plan)) return 'Prepared, or Proposal if critique is recommended';
  return 'Prepared';
};

// Confirmed planning result stop: the retained reviewed stop plus an honest
// planning-only bound. A prepared launch worktree may exist, so the result
// never promises no branch; the worktree/branch facts disclose it instead.
export const planningResultStopValue = (record: WireRecord, plan: PackagePlanningPlan): string =>
  `${planningStopValue(record, plan)}. Planning only \u2014 no commits or pull request.`;

// Honest execution host from recorded facts only. The resolved preview
// record carries no host field in the workspace/launch observation contract,
// and neither does the launch reply, so an absent host stays explicitly
// unrecorded instead of presenting the Host default routing preference as a
// confirmed execution fact.
export const hostValueFor = (record: WireRecord, result?: LaunchResult): string => {
  const reply = result?.assignment ?? {};
  const observation = result?.observation ?? {};
  const value = str(record.host) || str(reply.host) || str(reply.execution_host)
    || str(observation.host) || str(observation.execution_host);
  return value || 'Host not recorded for this assignment';
};

// Honest preparation from observed planning facts only. Snapshot lifecycle
// flags (planned/planned_at, recent_completion, is_current_assignment,
// execution) never establish preparation; positive, incomplete and unknown
// states reuse readiness.ts facts including observed steps and report/source
// basis.
export const preparationValueFor = (row: WireRecord | undefined, member: WireRecord | null): string => {
  const facts = planningFactsFor(row) ?? (member ? memberPlanning(member) : null);
  if (!row && !member) return 'Not observed in this snapshot';
  if (!facts) return 'Preparation not observed — readiness unknown';
  const steps = facts.steps != null ? `${facts.steps} steps` : 'steps unconfirmed';
  const preparation = (facts.preparation ?? null) as WireRecord | null;
  const outcome = preparation ? str(preparation.outcome) || 'no outcome' : 'no report';
  const reported = preparation ? str(preparation.reported_at) || str(preparation.observed_at) || '' : '';
  const source = preparation ? str(preparation.source) || '' : '';
  const basis = `${steps} · report ${outcome}${reported ? `, ${reported}` : ''}${source ? ` (${source})` : ''}`;
  if (facts.prepared === true) return `Prepared · ${basis}`;
  if (facts.prepared === false) {
    const decision = facts.decision && !('outcome' in (facts.decision as WireRecord)) ? (facts.decision as WireRecord) : null;
    if (decision) {
      const question = str(decision.question) || 'a recorded decision needs discussion';
      return `Decision needed · ${basis} · ${question}`;
    }
    const noIndex = facts.steps == null;
    const reportMissing = !preparation || preparation.outcome === 'missing';
    if (noIndex && reportMissing) return `Not planned · ${basis}`;
    return `Preparation incomplete · ${basis}`;
  }
  return `Preparation unconfirmed · ${basis}`;
};

// Declared prerequisites with shared readiness facts. The canonical member
// supplies its requires list; each requirement resolves in the same epic and
// reports its readiness label. Missing members, undeclared requirements and
// missing observations stay unknown instead of claiming none.
export const prerequisiteValueFor = (found: CanonicalMember | null): string => {
  if (!found) return 'Prerequisites not observed';
  const requires = (found.member as WireRecord).requires;
  if (!Array.isArray(requires)) return 'Prerequisites not observed';
  const names = requires.filter((name): name is string => typeof name === 'string' && Boolean(name));
  if (!names.length) return 'None declared';
  const members = Array.isArray(found.epic.members) ? (found.epic.members as WireRecord[]) : [];
  return names.map(name => {
    const prerequisite = members.find(entry => str(entry.package) === name || str(entry.name) === name) ?? null;
    if (!prerequisite) return `${name}: not observed`;
    if (landedStatus(prerequisite.status)) return `${name}: ${str(prerequisite.status)} (landed)`;
    return `${name}: ${specReadiness(prerequisite).label}`;
  }).join(' · ');
};

// Captured assignment input shared with AssignmentContract. The resolver's
// inputPreview bytes are the inspection source; nothing is reconstructed
// from editable or snapshot state.
export function CapturedInput(props: { preview: LaunchPreview }) {
  const input = () => props.preview.inputPreview;
  return (
    <Show when={input()}>
      <div id="launch-what-pi" class="launch-input">
        <h3>What Pi will receive</h3>
        <p class="small muted">The saved brief and selected contents below are captured together. Changed source contents require a new review before launch.</p>
        <For each={input()?.references ?? []}>{reference => (
          <details>
            <summary>{reference.kind === 'skill' ? 'Skill' : 'File'}: {reference.label}{reference.source ? ` · ${reference.source}` : ''}</summary>
            <p class="small mono">{reference.path}</p>
            <p class="small mono">SHA-256 {reference.sha256}</p>
            <pre>{reference.content}</pre>
          </details>
        )}</For>
        <details><summary>Complete brief and context</summary><pre>{input()?.brief}</pre></details>
        <details><summary>Assignment instructions</summary><pre>{input()?.instruction}</pre></details>
      </div>
    </Show>
  );
}

export function PackageContract(props: {
  preview: LaunchPreview;
  packageRef: string;
  kind: PackageReviewKind;
  records?: WireRecord[];
  epics?: WireRecord[];
}) {
  const record = () => props.preview.record;
  const snapshot = () => packageRecordOf(props.records, props.packageRef);
  const canonical = () => canonicalMemberOf(props.epics, record(), props.packageRef);
  const planningPlan = () => planningPlanFor(record(), props.preview.inputPreview);
  const prerequisiteValue = () => prerequisiteValueFor(canonical());
  const preparationValue = () => preparationValueFor(snapshot(), canonical()?.member ?? null);
  const modelValue = () => {
    const provider = str(record().provider);
    const model = str(record().model);
    if (provider && model) return `${provider} / ${model}`;
    return model || provider || 'Host default';
  };
  const facts = (): ContractFact[] => {
    const plan = props.kind === 'plan';
    const branch = str(record().execution_branch);
    const bound = planningPlan();
    return [
      { key: 'package', label: 'Package', value: str(record().package_ref) || props.packageRef },
      { key: 'target', label: 'Target', value: str(record().repository_id) || 'Whole workspace' },
      { key: 'execution', label: plan ? 'Planning worktree' : 'Execution worktree', value: str(record().execution_dir) || 'Unresolved' },
      ...(branch ? [{ key: 'branch', label: 'Worktree branch', value: branch }] : []),
      { key: 'prerequisite', label: 'Prerequisite', value: prerequisiteValue() },
      { key: 'preparation', label: 'Preparation', value: preparationValue() },
      plan
        ? { key: 'stages', label: 'Stages', value: planningStagesValue(record(), bound) }
        : { key: 'workflow', label: 'Workflow', value: str(record().skill) || IMPLEMENTATION_SKILL },
      { key: 'stop', label: 'Stops at', value: plan ? planningStopValue(record(), bound) : 'Draft pull request' },
      { key: 'authority', label: 'Publication authority', value: authorityLabel(str(record().publication_authority)) },
      { key: 'host', label: 'Execution host', value: hostValueFor(record()) },
      { key: 'model', label: 'Model', value: modelValue() },
      { key: 'assignment', label: 'Assignment', value: str(record().assignment_id) },
      { key: 'digest', label: 'Contract digest', value: props.preview.contractDigest },
    ];
  };
  return (
    <div class="launch-contract launch-contract--package" data-package-kind={props.kind}>
      <dl class="launch-facts" aria-label={props.kind === 'plan' ? 'Resolved planning assignment facts' : 'Resolved implementation assignment facts'}>
        <For each={facts()}>{fact => (
          <div data-fact={fact.key}>
            <dt>{fact.label}</dt>
            <dd class="mono">{fact.value}</dd>
          </div>
        )}</For>
      </dl>
      <CapturedInput preview={props.preview} />
      <p class="contract-note">
        {props.kind === 'plan'
          ? isConditionalInitial(record(), planningPlan())
            ? 'Planning stops at Prepared, or at Proposal when architecture recommends critique. A package worktree may be prepared; no commit, push or pull request is authorized.'
            : planningPlan().stop === 'proposal'
              ? 'Planning stops at the proposal; critique and specification wait for a later launch. No commit, push or pull request is authorized.'
              : 'Planning stops before implementation. A package worktree may be prepared; no commit, push or pull request is authorized.'
          : 'Implementation runs in this package worktree and may open a draft pull request. Merge stays with the operator.'}
      </p>
    </div>
  );
}

// Bound refusal presentation: target-busy links to the writer in Agents,
// run-active links to the spec that holds the package with its observed run
// identity, and every other refusal stays generic. Nothing here starts work.
export function PackageDenied(props: {
  reason?: string;
  conflictingAssignment?: string;
  agentHref: string;
  packageRef: string;
  kind: PackageReviewKind;
  ws: string;
  records?: WireRecord[];
}) {
  const snapshot = () => packageRecordOf(props.records, props.packageRef);
  const holdingRun = () => str(snapshot()?.assignment_id) || str(snapshot()?.run_id);
  const specHref = () => {
    const row = snapshot();
    const base = `#/specs?ws=${encodeURIComponent(props.ws)}`;
    return row?.key ? `${base}&id=${encodeURIComponent(str(row.key))}` : base;
  };
  const packageTitle = () => props.kind === 'plan' ? 'Planning is unavailable' : 'Implementation is unavailable';
  return (
    <div id="launch-package-denied" class="launch-package-denied" data-denied-reason={props.reason ?? 'generic'}>
      <div class="section-head">
        <StatusText tone="error">Not submitted</StatusText>
      </div>
      <Switch>
        <Match when={props.reason === 'target-busy'}>
          <StateNotice tone="error" title="This package already has a writer" announce={false}>
            <Show when={props.conflictingAssignment} fallback={<span>Another assignment is still live or unconfirmed for {props.packageRef}. Nothing new was started; inspect it before another review.</span>}>
              Assignment <span id="launch-review-busy" class="mono">{props.conflictingAssignment}</span> is still live or unconfirmed for {props.packageRef}. Nothing new was started; inspect it before another review.
            </Show>
          </StateNotice>
        </Match>
        <Match when={props.reason === 'run-active'}>
          <StateNotice tone="error" title="This spec package has an active run" announce={false}>
            <Show when={holdingRun()} fallback={<span>A spec run is still active for {props.packageRef}. Nothing new was started; open the spec to follow the run that holds the package.</span>}>
              Run <span class="mono">{holdingRun()}</span> is still active for {props.packageRef}. Nothing new was started for this review; open the spec to follow the run that holds the package.
            </Show>
          </StateNotice>
        </Match>
        <Match when={props.reason === 'service-unavailable'}>
          <StateNotice tone="error" title="Dispatch service unavailable" announce={false}>
            The dispatch service did not answer for {props.packageRef}. Nothing new was started; the saved brief and target are kept, and review can be retried.
          </StateNotice>
        </Match>
        <Match when={true}>
          <StateNotice tone="error" title={packageTitle()} announce={false}>
            This dashboard cannot start the assignment from here. Nothing new was started; the saved brief and target are kept for an authorized review.
          </StateNotice>
        </Match>
      </Switch>
      <ActionBar variant="inline">
        <Show when={props.reason === 'target-busy'}>
          <a id="launch-package-open-agent" class="ds-btn ds-btn--primary" href={props.agentHref}>Open agent</a>
        </Show>
        <Show when={props.reason === 'run-active'}>
          <a id="launch-package-open-spec" class="ds-btn ds-btn--primary" href={specHref()}>Open spec</a>
        </Show>
      </ActionBar>
    </div>
  );
}

// Confirmed bound launch result for the plan and implement hand-offs. Only the
// store's recorded live outcome reaches this composition: the resolved preview
// record supplies package, worktree, stage, stop, branch and host facts, the launch
// reply supplies only its own recorded time, and snapshots supply member status
// and return links. Planning discloses its prepared worktree/branch and stops
// planning-only; the host stays explicitly unrecorded when no recorded fact
// carries it. It never claims work completion, and a recorded result
// never offers a second submission.
export function PackageResult(props: {
  kind: PackageReviewKind;
  packageRef: string;
  preview: LaunchPreview;
  result: LaunchResult;
  agentHref: string;
  epicHref: string;
  specHref: string;
  records?: WireRecord[];
  epics?: WireRecord[];
  assignments?: WireRecord[];
}) {
  const record = () => props.preview.record;
  const plan = () => props.kind === 'plan';
  const planningPlan = () => planningPlanFor(record(), props.preview.inputPreview);
  // Next-outcome guidance from the same retained reviewed plan as facts:
  // a proposal stop never promises specification completion, and the fresh
  // architecture conditional keeps its critique branch instead of assuming
  // the Prepared stop.
  const planningCompletes = () => {
    const bound = planningPlan();
    if (bound.stop === 'proposal') return <>At the proposal. Critique and specification wait for a later launch.</>;
    if (isConditionalInitial(record(), bound)) return <>At Prepared, or at Proposal when architecture recommends critique. The member then shows <StatusText tone="info">Ready to implement</StatusText> or <StatusText tone="neutral">Prepared · waiting</StatusText>.</>;
    return <>When the package reports Prepared. The member then shows <StatusText tone="info">Ready to implement</StatusText> or <StatusText tone="neutral">Prepared · waiting</StatusText>.</>;
  };
  const startedValue = () => {
    const assignment = props.result.assignment ?? {};
    const observation = props.result.observation ?? {};
    const value = str(assignment.launch_completed_at) || str(assignment.started_at)
      || str(observation.observed_at) || str(assignment.updated_at) || str(assignment.created_at);
    return value ? time(value) : 'Not recorded';
  };
  const nextMember = (): WireRecord | null =>
    nextPlannableMember(props.epics, record(), props.packageRef, props.records ?? [], props.assignments);
  const packageValue = () => str(record().package_ref) || props.packageRef;
  const hostValue = () => hostValueFor(record(), props.result);
  const facts = (): ContractFact[] => {
    const bound = planningPlan();
    const stages = planningStagesValue(record(), bound);
    const branch = str(record().execution_branch);
    return plan()
      ? [
          { key: 'assignment', label: 'Assignment', value: props.result.assignmentId },
          { key: 'package', label: 'Member package', value: packageValue() },
          { key: 'worktree', label: 'Planning worktree', value: str(record().execution_dir) || 'Unresolved' },
          ...(branch ? [{ key: 'branch', label: 'Worktree branch', value: branch }] : []),
          { key: 'stages', label: 'Stages', value: stages },
          { key: 'stop', label: 'Stops at', value: planningResultStopValue(record(), bound) },
          { key: 'host', label: 'Execution host', value: hostValue() },
          { key: 'started', label: 'Started', value: startedValue() },
        ]
      : [
          { key: 'assignment', label: 'Assignment', value: props.result.assignmentId },
          { key: 'started', label: 'Started', value: startedValue() },
          { key: 'package', label: 'Spec package', value: packageValue() },
          ...(branch ? [{ key: 'branch', label: 'Branch', value: branch }] : []),
          { key: 'host', label: 'Execution host', value: hostValue() },
          { key: 'stop', label: 'Stops at', value: 'Draft pull request' },
        ];
  };
  return (
    <div class="launch-result launch-result--package" id="launch-result-package" data-package-kind={props.kind}>
      <StateNotice
        tone="success"
        announce={false}
        title={`Assignment ${props.result.assignmentId.slice(0, 8)} started`}
      >
        {plan()
          ? 'The host acknowledged this planning assignment as live. Planning has not finished.'
          : 'The host acknowledged this implementation assignment as live. Work completion has not been established.'}
      </StateNotice>
      <dl class="launch-facts" id="launch-result-facts" aria-label={plan() ? 'Planning result facts' : 'Implementation result facts'}>
        <For each={facts()}>{fact => (
          <div data-fact={fact.key}>
            <dt>{fact.label}</dt>
            <dd class="mono">{fact.value}</dd>
          </div>
        )}</For>
      </dl>
      <ActionBar variant="inline">
        <Show when={plan()} fallback={<a id="launch-result-open-spec" class="ds-btn ds-btn--primary" href={props.specHref}>Open spec</a>}>
          <a id="launch-result-open-epic" class="ds-btn ds-btn--primary" href={props.epicHref}>Open epic</a>
        </Show>
        <a id="launch-result-open-agent" class="ds-btn" href={props.agentHref}>Open agent</a>
      </ActionBar>
      <section class="section launch-result-next" aria-labelledby="launch-result-next-heading">
        <div class="section-heading">
          <h3 id="launch-result-next-heading">What happens next</h3>
        </div>
        <Show
          when={plan()}
          fallback={
            <ul class="launch-next-list">
              <li>The spec leaves Ready and appears under Active.</li>
              <li>The first observation can take one refresh.</li>
              <li>The run ends at a draft pull request. Merge stays with the operator.</li>
            </ul>
          }
        >
          <dl class="launch-facts" aria-label="Planning next steps">
            <div data-fact="epic-status">
              <dt>On the epic</dt>
              <dd><StatusText tone="info">Planning</StatusText><br /><span class="muted">The member shows Planning while the assignment runs.</span></dd>
            </div>
            <div data-fact="planning-completes">
              <dt>Planning completes</dt>
              <dd>{planningCompletes()}</dd>
            </div>
            <div data-fact="planner-question">
              <dt>Planner needs an answer</dt>
              <dd>The member shows <StatusText tone="warning">Decision needed</StatusText>.</dd>
            </div>
            <div data-fact="next-member">
              <dt>Next member</dt>
              <dd>
                <Show when={nextMember()} fallback="No independent member is offered in this observation.">
                  {member => `${str(member().name)} can be planned from the epic while this assignment runs.`}
                </Show>
              </dd>
            </div>
          </dl>
        </Show>
      </section>
    </div>
  );
}
