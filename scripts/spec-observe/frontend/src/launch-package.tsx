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
import { str } from './format';
import { packagePlanningPlan } from '../../../workspaces/spec-prompt.mjs';
import type { PackagePlanningPlan } from './launch-handoff';
import type { LaunchPreview } from './launch-state';
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

type EpicMember = { title: string; status: string };

export function PackageContract(props: {
  preview: LaunchPreview;
  packageRef: string;
  kind: PackageReviewKind;
  records?: WireRecord[];
  epics?: WireRecord[];
}) {
  const record = () => props.preview.record;
  const snapshot = () => packageRecordOf(props.records, props.packageRef);
  const epicMember = (): EpicMember | null => {
    const slug = props.packageRef.split('/').filter(Boolean).pop() ?? props.packageRef;
    for (const epic of props.epics ?? []) {
      const members = Array.isArray(epic.members) ? epic.members as WireRecord[] : [];
      const member = members.find(entry => [str(entry.package), str(entry.name)].includes(slug));
      if (member) return { title: str(epic.title) || str(epic.epic), status: str(member.status) || str(member.state) || 'Recorded' };
    }
    return null;
  };
  // Stage ids come from the shared spec-prompt owner: the resolved planning
  // skill selects its canonical plan, never a locally re-typed stage list.
  const planningPlan = (): PackagePlanningPlan => {
    const skill = str(record().skill);
    if (skill === 'spec-architect-critics') return packagePlanningPlan({ proposal: true, critiqueRecommended: true }) as PackagePlanningPlan;
    if (skill === 'spec-write') return packagePlanningPlan({ proposal: true }) as PackagePlanningPlan;
    return packagePlanningPlan() as PackagePlanningPlan;
  };
  const prerequisiteValue = () => {
    const attention = snapshot()?.attention;
    if (Array.isArray(attention) && attention.length) return attention.filter(Boolean).map(String).join(' · ');
    const member = epicMember();
    return member ? `${member.title}: ${member.status}` : 'None declared';
  };
  const preparationValue = () => {
    const row = snapshot();
    if (!row) return 'Not observed in this snapshot';
    if (row.planned) return str(row.planned_at) ? `Planned ${str(row.planned_at)}` : 'Planned';
    if (row.recent_completion) return 'Prepared and completed';
    if (row.is_current_assignment) return 'Prepared; work in progress';
    return str(row.execution) ? `Prepared; execution ${str(row.execution)}` : 'Prepared';
  };
  const modelValue = () => {
    const provider = str(record().provider);
    const model = str(record().model);
    if (provider && model) return `${provider} / ${model}`;
    return model || provider || 'Host default';
  };
  const facts = (): ContractFact[] => {
    const plan = props.kind === 'plan';
    const branch = str(record().execution_branch);
    const stages = planningPlan().stages.map((stage, index) => `${index + 1} ${stage}`).join(' → ');
    return [
      { key: 'package', label: 'Package', value: str(record().package_ref) || props.packageRef },
      { key: 'target', label: 'Target', value: str(record().repository_id) || 'Whole workspace' },
      { key: 'execution', label: plan ? 'Planning worktree' : 'Execution worktree', value: str(record().execution_dir) || 'Unresolved' },
      ...(branch ? [{ key: 'branch', label: 'Worktree branch', value: branch }] : []),
      { key: 'prerequisite', label: 'Prerequisite', value: prerequisiteValue() },
      { key: 'preparation', label: 'Preparation', value: preparationValue() },
      plan
        ? { key: 'stages', label: 'Stages', value: stages || 'No stages recorded' }
        : { key: 'workflow', label: 'Workflow', value: str(record().skill) || IMPLEMENTATION_SKILL },
      { key: 'stop', label: 'Stops at', value: plan ? (planningPlan().stop === 'proposal' ? 'Proposal' : 'Prepared') : 'Draft pull request' },
      { key: 'authority', label: 'Publication authority', value: authorityLabel(str(record().publication_authority)) },
      { key: 'host', label: 'Execution host', value: str(record().host) || 'Host default' },
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
      <p class="contract-note">
        {props.kind === 'plan'
          ? 'Planning stops before implementation. A package worktree may be prepared; no commit, push or pull request is authorized.'
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
