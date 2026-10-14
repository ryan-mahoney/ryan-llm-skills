// Readiness vocabulary for prepared packages and epic members. This module is
// DOM-free and transport-free: callers pass the observed records, assignment
// rows and (for epic members) prerequisite facts they already hold. Positive
// preparation facts come only from the new planning fields; a legacy `status`
// of "prepared" is never trusted, and landed work stays merged/complete only.
import type { StatusTone } from './primitives';
import type { WireRecord } from './model';

export type ReadinessState =
  | 'ready' | 'waiting' | 'incomplete' | 'not-planned' | 'no-package'
  | 'planning' | 'decision' | 'starting' | 'unknown';

export const READINESS_ORDER: ReadinessState[] = [
  'ready', 'planning', 'decision', 'waiting', 'incomplete', 'not-planned', 'unknown',
];

export const READINESS: Record<ReadinessState, { label: string; tone: StatusTone; proposal: string }> = {
  ready: { label: 'Ready to implement', tone: 'info', proposal: 'Ready to implement' },
  waiting: { label: 'Prepared · waiting', tone: 'neutral', proposal: 'Prepared, waiting on a prerequisite' },
  incomplete: { label: 'Preparation incomplete', tone: 'warning', proposal: 'Preparation needs to be resumed' },
  'not-planned': { label: 'Not planned', tone: 'neutral', proposal: 'Planning needs to be started' },
  'no-package': { label: 'No package', tone: 'warning', proposal: 'The package is missing' },
  planning: { label: 'Planning', tone: 'info', proposal: 'Planning is in progress' },
  decision: { label: 'Decision needed', tone: 'warning', proposal: 'A recorded decision needs discussion' },
  starting: { label: 'Implementation starting', tone: 'info', proposal: 'Implementation is starting' },
  unknown: { label: 'Readiness unknown', tone: 'warning', proposal: 'Readiness is not confirmed' },
};

export type PlanningFacts = {
  proposal: boolean | null;
  critique: boolean | null;
  critiqueRecommended: boolean | null;
  prepared: boolean | null;
  steps: number | null;
  preparation: WireRecord | null;
  decision: WireRecord | null;
  receipts: WireRecord[];
  worktreeRecorded: unknown;
};

export type PrerequisiteState = 'landed' | 'prepared' | 'unresolved' | 'unknown';
export type PrerequisiteFact = { name: string; state: PrerequisiteState };

export type ReadinessContext = {
  action?: 'plan' | 'implement';
  assignments?: WireRecord[];
  coverage?: WireRecord | null;
  prerequisites?: PrerequisiteFact[];
  requires?: string[];
};

export type ReadinessFacts = {
  state: ReadinessState;
  label: string;
  tone: StatusTone;
  proposal: string;
  facts: PlanningFacts | null;
  prerequisites: PrerequisiteFact[];
  waitingOn: string[];
  reason: string | null;
  launchable: boolean;
  owner: WireRecord | null;
};

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const object = (value: unknown): value is WireRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): WireRecord[] => Array.isArray(value) ? value.filter(object) : [];
const bool = (value: unknown): boolean | null => value === true ? true : value === false ? false : null;

export type CanonicalMember = { epic: WireRecord; member: WireRecord };

// One workspace-scoped join for resolved launch records and observed inventory.
export const canonicalMemberOf = (
  epics: WireRecord[] | undefined,
  record: WireRecord,
  packageRef: string,
): CanonicalMember | null => {
  const workspace = text(record.workspace_id) || text(record.workspace);
  const candidates = [text(record.package_ref), text(record.spec_package), text(record.package), text(packageRef)].filter(Boolean);
  const identities = new Set<string>();
  for (const candidate of candidates) {
    identities.add(candidate);
    const parts = candidate.split('/').filter(Boolean);
    if (parts.length) identities.add(parts[parts.length - 1]);
  }
  for (const epic of epics ?? []) {
    for (const member of list(epic.members)) {
      const memberWorkspace = text(member.workspace) || text(epic.workspace);
      if (workspace && memberWorkspace && memberWorkspace !== workspace) continue;
      const ids = [text(member.package), text(member.name)].filter(Boolean);
      if (ids.some(id => identities.has(id))) return { epic, member };
    }
  }
  return null;
};

// Inventory rows do not carry requires: the containing epic owns them.
// All Specs presentations and list ordering consume this observed context.
export function observedSpecReadiness(record: WireRecord, epics: WireRecord[] = [], assignments: WireRecord[] = list(record.observer?.snapshot?.assignments)) {
  const found = canonicalMemberOf(
    [...list(record.observer?.snapshot?.epics), ...epics],
    record, text(record.package_ref) || text(record.package),
  );
  const epic = found?.epic ?? null;
  const member = found?.member ?? null;
  const siblings = list(epic?.members);
  const prerequisites: PrerequisiteFact[] | undefined = Array.isArray(member?.requires)
    ? member.requires.filter((name: unknown): name is string => typeof name === 'string' && Boolean(name)).map((name: string) => {
        const sibling = siblings.find(item => item.name === name);
        const state: PrerequisiteFact['state'] = !sibling || sibling.status === 'unknown' ? 'unknown'
          : landedStatus(sibling.status) ? 'landed'
          : positivelyPrepared(memberPlanning(sibling)) ? 'prepared' : 'unresolved';
        return { name, state };
      })
    : undefined;
  return {
    epic, member, prerequisites,
    facts: planningFactsFor(record) ?? memberPlanning(member),
    readiness: specReadiness(record, { assignments, prerequisites }),
  };
}

export const landedStatus = (status: unknown): boolean => status === 'merged' || status === 'complete';

// Every observed assignment state blocks a duplicate action except the two
// recorded end states; an unknown/lost/unrecorded session must never be
// silently replaced by a second dispatch.
export const blockingAssignment = (assignment: WireRecord | null | undefined): boolean => {
  const display = text(assignment?.display);
  return Boolean(display) && display !== 'ended' && display !== 'launch-failed';
};

export const implementationAssignment = (assignment: WireRecord | null | undefined): boolean =>
  text(assignment?.skill) === 'spec-end-to-end';

const segment = (value: unknown): string => {
  const parts = text(value).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
};

// Canonical package identity: exact workspace plus the canonical package path
// carried as `package`, `package_ref` or `package_path`. Basename-only matches are
// rejected: equal slugs under distinct canonical paths must never join.
const assignmentMatches = (record: WireRecord | null | undefined, assignment: WireRecord | null | undefined): boolean => {
  if (!record || !assignment) return false;
  const workspace = text(record.workspace);
  const assignmentWorkspace = text(assignment.workspace) || text(assignment.workspace_id);
  if (!workspace || workspace !== assignmentWorkspace) return false;
  const specPackage = text(assignment.spec_package);
  if (!specPackage) return false;
  const candidates = [text(record.package), text(record.package_ref), text(record.package_path)].filter(Boolean);
  return candidates.some(candidate => candidate === specPackage);
};

// The live-blocking assignment for a package, or null when there is no
// observed owner (ended/launch-failed history does not block).
export function planningAssignmentFor(record: WireRecord | null | undefined, assignments: WireRecord[] | undefined): WireRecord | null {
  for (const assignment of list(assignments)) {
    if (!blockingAssignment(assignment)) continue;
    if (assignmentMatches(record, assignment)) return assignment;
  }
  return null;
}

const hasPlanningFields = (value: WireRecord): boolean =>
  'prepared' in value || 'step_count' in value || 'preparation' in value || 'decision' in value;

function planningFactsFrom(source: WireRecord): PlanningFacts {
  return {
    proposal: bool(source.proposal),
    critique: bool(source.critique),
    critiqueRecommended: bool(source.critique_recommended),
    prepared: bool(source.prepared),
    steps: Number.isSafeInteger(source.step_count) ? source.step_count as number : null,
    preparation: object(source.preparation) ? source.preparation : null,
    decision: object(source.decision) ? source.decision : null,
    receipts: list(source.receipts),
    worktreeRecorded: source.worktree_recorded ?? null,
  };
}

// Normalize the planning subset published by planned packages and epic members.
// A null `planning` member or a value without any of the new fields is unknown
// (null), never empty-complete.
export function planningFactsFor(value: WireRecord | null | undefined): PlanningFacts | null {
  if (!object(value)) return null;
  if ('planning' in value) return object(value.planning) ? planningFactsFrom(value.planning) : null;
  if (!hasPlanningFields(value)) return null;
  return planningFactsFrom(value);
}

// Epic members carry the same planning subset under `planning`.
export function memberPlanning(member: WireRecord | null | undefined): PlanningFacts | null {
  if (!object(member) || !object(member.planning)) return null;
  return planningFactsFor(member.planning);
}

export const positivelyPrepared = (facts: PlanningFacts | null | undefined): boolean => facts?.prepared === true;

// A decision record with an explicit read marker is not a usable decision.
export const usableDecision = (decision: WireRecord | null): WireRecord | null =>
  decision && !('outcome' in decision) ? decision : null;

export const coverageStateOf = (record: WireRecord | null | undefined, context: ReadinessContext = {}): string => {
  const coverage = context.coverage ?? record?.assignment_coverage ?? record?.observer?.snapshot?.assignment_coverage ?? null;
  return text(coverage?.state) || 'unknown';
};

const prerequisiteReason = (fact: PrerequisiteFact): string => fact.state === 'prepared'
  ? `Available when ${fact.name} is merged`
  : fact.state === 'unresolved' ? `Waiting on ${fact.name}` : `${fact.name} is not observed`;

function result(state: ReadinessState, facts: PlanningFacts | null, context: ReadinessContext, extra: Partial<ReadinessFacts> = {}): ReadinessFacts {
  const meta = READINESS[state];
  return {
    state, label: meta.label, tone: meta.tone, proposal: meta.proposal,
    facts,
    prerequisites: extra.prerequisites ?? [],
    waitingOn: extra.waitingOn ?? [],
    reason: extra.reason ?? null,
    launchable: extra.launchable ?? false,
    owner: extra.owner ?? null,
  };
}

// Planning accepts positively prepared prerequisites before they land, but
// still requires a confirmed observation of package ownership.
function planningPermission(record: WireRecord, context: ReadinessContext): Partial<ReadinessFacts> {
  if (context.action !== 'plan') return {};
  const waiting = (context.prerequisites ?? []).find(fact => fact.state !== 'landed' && fact.state !== 'prepared');
  const coverage = coverageStateOf(record, context);
  const reason = waiting ? prerequisiteReason(waiting)
    : coverage !== 'complete' ? `Assignment coverage ${coverage}; the owner is not confirmed, so this package cannot start.` : null;
  return { launchable: !reason, reason };
}

// Derive one package's readiness. Live planning/implementation assignments win
// over stored preparation facts; otherwise a usable decision wins, then the
// positive/known/unknown preparation facts decide. A ready package still
// cannot launch until assignment coverage confirms the owner is observed.
export function specReadiness(record: WireRecord | null | undefined, context: ReadinessContext = {}): ReadinessFacts {
  const packagePath = text(record?.package) || text(record?.package_ref);
  if (!packagePath || record?.status === 'missing' || record?.exists === false) {
    return result('no-package', null, context, { reason: 'The package directory is missing.' });
  }
  const owner = planningAssignmentFor(record, context.assignments);
  if (owner) {
    const state: ReadinessState = implementationAssignment(owner) || record?.implementation_starting === true ? 'starting' : 'planning';
    return result(state, planningFactsFor(record), context, {
      owner, launchable: false,
      reason: state === 'starting' ? 'An implementation assignment owns this package.' : 'A planning assignment owns this package.',
    });
  }
  if (record?.implementation_starting === true) {
    return result('starting', planningFactsFor(record), context, { launchable: false, reason: 'An implementation assignment owns this package.' });
  }

  const facts = planningFactsFor(record);
  if (!facts) {
    return result('unknown', null, context, { reason: 'New preparation facts are unavailable in this observation; readiness is not confirmed.' });
  }
  const decision = usableDecision(facts.decision);
  if (decision) {
    return result('decision', facts, context, { reason: text(decision.question) || 'A recorded decision needs discussion before starting.' });
  }
  if (facts.prepared === null) {
    const unavailable = facts.preparation?.outcome === 'unavailable' || (facts.decision && 'outcome' in facts.decision);
    return result('unknown', facts, context, {
      reason: unavailable ? 'A preparation read is unavailable in this observation; readiness is not confirmed.' : 'Preparation has not been confirmed from an observed index and report.',
    });
  }
  if (facts.prepared === false) {
    const noIndex = facts.steps === null;
    const reportMissing = !facts.preparation || facts.preparation.outcome === 'missing';
    if (noIndex && reportMissing) {
      return result('not-planned', facts, context, { reason: 'No prepared specification index was observed.', ...planningPermission(record!, context) });
    }
    const outcome = text(facts.preparation?.outcome);
    const reason = outcome === 'invalid' ? 'The preparation report is invalid.'
      : outcome === 'blocked' ? 'Preparation is blocked.'
      : outcome === 'decision-required' ? 'Preparation requires a decision.'
      : noIndex ? 'The prepared specification index could not be confirmed.'
      : 'The preparation report is missing or not confirmed.';
    return result('incomplete', facts, context, { reason, ...planningPermission(record!, context) });
  }

  // Positively prepared: readiness still requires every declared prerequisite
  // to have landed (merged/complete). Observed prerequisite facts cover the
  // declared requirements; absent observations stay unknown instead of
  // authorizing implementation.
  const declared = Array.isArray(context.requires)
    ? context.requires.filter((name): name is string => typeof name === 'string' && Boolean(name))
    : Array.isArray(record?.requires)
      ? record.requires.filter((name): name is string => typeof name === 'string' && Boolean(name))
      : [];
  const observed = Array.isArray(context.prerequisites)
    ? context.prerequisites.filter(fact => object(fact) && typeof fact.name === 'string' && Boolean(fact.name))
    : null;
  const observedByName = new Map((observed ?? []).map(fact => [fact.name, fact]));
  const prerequisites = observed === null
    ? declared.map(name => ({ name, state: 'unknown' as const }))
    : [...declared.map(name => observedByName.get(name) ?? { name, state: 'unknown' as const }),
       ...observed.filter(fact => !declared.includes(fact.name))];
  const waiting = prerequisites.filter(fact => fact.state !== 'landed');
  const coverage = coverageStateOf(record, context);
  const covered = coverage === 'complete';
  if (waiting.length) {
    return result('waiting', facts, context, {
      prerequisites, waitingOn: waiting.map(fact => fact.name),
      reason: prerequisiteReason(waiting[0]),
    });
  }
  return result('ready', facts, context, {
    prerequisites, launchable: covered,
    reason: covered ? null : `Assignment coverage ${coverage}; the owner is not confirmed, so this package cannot start.`,
  });
}

// Positive preparation or landed lifecycle only: legacy `status: prepared`
// never satisfies a prerequisite.
export function epicPlanningIncomplete(epic: WireRecord | null | undefined): boolean {
  const members = list(epic?.members);
  return members.some(member => !(landedStatus(member.status) || positivelyPrepared(memberPlanning(member))));
}

const declaredRequires = (member: WireRecord): string[] =>
  Array.isArray(member.requires)
    ? member.requires.filter((name): name is string => typeof name === 'string' && Boolean(name))
    : [];

const memberRecord = (records: WireRecord[], epic: WireRecord | null | undefined, member: WireRecord): WireRecord | null => {
  const workspace = text(member.workspace) || text(epic?.workspace);
  const name = text(member.package) || text(member.name);
  for (const record of list(records)) {
    if (workspace && text(record.workspace) !== workspace) continue;
    const candidates = [text(record.package), text(record.package_ref), text(record.name), segment(record.package), segment(record.package_ref)].filter(Boolean);
    if (candidates.includes(name) || candidates.includes(text(member.name))) return record;
  }
  return null;
};

// First member in record order eligible for planning: proposed/incomplete, no
// live blocking assignment, no recorded decision, and every prerequisite
// positively prepared or landed. A receipt-free legacy `prepared` status whose
// observed planning facts establish incomplete preparation is a Resume-planning
// candidate; positive preparation, decisions, live owners and execution
// history still exclude.
export function nextToPlan(epic: WireRecord | null | undefined, records: WireRecord[] = [], assignments: WireRecord[] = []): WireRecord | null {
  const members = list(epic?.members).filter(member => typeof member.name === 'string' && member.name);
  const byName = new Map(members.map(member => [member.name, member]));
  for (const member of members) {
    const status = text(member.status);
    const facts = memberPlanning(member);
    const resumeIncomplete = status === 'prepared'
      && facts?.prepared === false
      && !facts?.decision
      && (facts?.receipts?.length ?? 0) === 0;
    if (status !== 'proposed' && status !== 'unknown' && !resumeIncomplete) continue;
    const record = memberRecord(records, epic, member);
    if (planningAssignmentFor(record ?? member, assignments)) continue;
    if (!facts || facts.prepared !== false || facts.decision) continue;
    if (Array.isArray(member.requires) && !member.requires.every((name: unknown) => typeof name === 'string')) continue;
    const satisfied = declaredRequires(member).every(name => {
      const prerequisite = byName.get(name);
      if (!prerequisite) return false;
      return landedStatus(prerequisite.status) || positivelyPrepared(memberPlanning(prerequisite));
    });
    if (satisfied) return member;
  }
  return null;
}

export const readinessRank = (state: ReadinessState): number => {
  const rank = READINESS_ORDER.indexOf(state);
  return rank === -1 ? READINESS_ORDER.length : rank;
};

// Shared row order for Ready/planned lists: readiness rank first, then
// workspace and package, so counts and selection read the same sequence.
export function compareReadiness(a: WireRecord | null | undefined, b: WireRecord | null | undefined): number {
  const rank = readinessRank(observedSpecReadiness(a ?? {}).readiness.state) - readinessRank(observedSpecReadiness(b ?? {}).readiness.state);
  if (rank) return rank;
  return text(a?.workspace).localeCompare(text(b?.workspace)) || text(a?.package).localeCompare(text(b?.package));
}
