import type { Envelope, WireRecord } from '../model';
import type { StatusTone } from '../primitives';
import type { RouteState } from '../route';
import type { CatalogEntry } from '../scope';
import { base, str, stale, time } from '../format';
import {
  epicPlanningIncomplete, landedStatus, memberPlanning, nextToPlan, planningAssignmentFor, positivelyPrepared,
  specReadiness,
} from '../readiness';
import type { PrerequisiteFact } from '../readiness';

// Destinations read readiness facts from their owning state module.
export { epicPlanningIncomplete, memberPlanning, nextToPlan };
import { epicStats } from '../observation-format';
import { catalogEntryForRecord, workspaceRelativePath } from '../scope';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export function visibleEpics(epics: WireRecord[], query: string): WireRecord[] {
  const list = (epics ?? []).filter(Boolean);
  const q = (text(query) ?? '').trim().toLowerCase();
  if (!q) return list;
  return list.filter(epic => {
    const members = Array.isArray(epic.members) ? epic.members : [];
    return [epic.title, epic.epic, epic.workspace, ...members.map((member: WireRecord) => member?.name)]
      .some(value => str(value).toLowerCase().includes(q));
  });
}

const RECORDED_STATE_LABELS: Record<string, string> = {
  planned: 'Planned',
  active: 'Active',
  complete: 'Complete',
  abandoned: 'Abandoned',
};

export function epicRecordedState(epic: WireRecord): { label: string; tone: StatusTone; conflict: boolean } {
  const state = text(epic?.state);
  if (!state) return { label: 'Not recorded', tone: 'neutral', conflict: false };
  const label = Object.hasOwn(RECORDED_STATE_LABELS, state) ? RECORDED_STATE_LABELS[state] : undefined;
  if (!label) return { label: state, tone: 'neutral', conflict: false };
  if (state !== 'complete') return { label, tone: 'neutral', conflict: false };
  const { landed, total } = epicStats(epic);
  if (landed < total) return { label: 'Recorded complete', tone: 'warning', conflict: true };
  return { label, tone: 'success', conflict: false };
}

const MEMBER_STATUSES: Record<string, { label: string; tone: StatusTone }> = {
  merged: { label: 'Merged', tone: 'success' },
  complete: { label: 'Marked complete', tone: 'success' },
  published: { label: 'PR published', tone: 'info' },
  'in-progress': { label: 'In progress', tone: 'info' },
  prepared: { label: 'Prepared', tone: 'neutral' },
  proposed: { label: 'Proposed', tone: 'neutral' },
  missing: { label: 'Package missing', tone: 'warning' },
  unobserved: { label: 'Not observed', tone: 'warning' },
  unknown: { label: 'Evidence incomplete', tone: 'warning' },
};

export function epicMemberStatus(member: WireRecord): { label: string; tone: StatusTone } {
  const status = text(member?.status);
  if (!status) return { label: 'Not recorded', tone: 'neutral' };
  const known = Object.hasOwn(MEMBER_STATUSES, status) ? MEMBER_STATUSES[status] : undefined;
  if (!known) return { label: status, tone: 'neutral' };
  if (status !== 'in-progress') return known;
  const position = Number.isSafeInteger(member?.step?.position) ? member.step.position : null;
  const total = Number.isSafeInteger(member?.step?.total) ? member.step.total : null;
  const step = position !== null && total !== null ? ` · step ${position} of ${total}` : '';
  if (member?.attention === true) return { label: `${known.label}${step} · needs attention`, tone: 'warning' };
  return { label: `${known.label}${step}`, tone: known.tone };
}

export function epicMemberRequires(member: WireRecord): { names: string[]; waiting: string[]; declared: boolean } {
  const stringList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string' && Boolean(name)) : [];
  const waiting = stringList(member?.waiting_on);
  const declared = Array.isArray(member?.requires);
  return { names: declared ? stringList(member.requires) : [...waiting], waiting: [...waiting], declared };
}

export function memberRecords(records: WireRecord[], workspace: string, slug: string): WireRecord[] {
  return (records ?? []).filter(record => record?.workspace === workspace && base(record?.package) === slug);
}

export type EpicMemberActionKind = 'plan' | 'open-agent' | 'implement' | 'none';

export type EpicMemberAction = {
  kind: EpicMemberActionKind;
  label: string;
  disabled: boolean;
  reason: string | null;
  owner: WireRecord | null;
};

export type EpicMemberPlanning = {
  name: string;
  workspace: string;
  record: WireRecord | null;
  status: { label: string; tone: StatusTone };
  note: string;
  action: EpicMemberAction;
};

export type EpicPlanningSummary = {
  prepared: number;
  total: number;
  landed: number;
  planning: number;
  next: WireRecord | null;
  incomplete: boolean;
};

const epicMembers = (epic: WireRecord | null | undefined): WireRecord[] =>
  (Array.isArray(epic?.members) ? epic.members : [])
    .filter((member): member is WireRecord => Boolean(member) && typeof member.name === 'string' && Boolean(member.name));

// One observed record per member: exact workspace plus the member's canonical
// package identity (the base slug of a recorded package path), matching the
// dependency table's member-name/workspace contract for absolute paths.
export function epicMemberRecord(epic: WireRecord, member: WireRecord, records: WireRecord[]): WireRecord | null {
  const workspace = text(member?.workspace) || text(epic?.workspace) || '';
  const declared = text(member?.package);
  const slug = (declared ? base(declared) : '') || text(member?.name) || '';
  if (!workspace || !slug) return null;
  return memberRecords(records, workspace, slug)[0] ?? null;
}

export const memberIsMissing = (member: WireRecord): boolean => member?.status === 'missing' || member?.exists === false;

// Observed member owner → Agents route: the observed composite row key
// selects the exact observed row; without it a nonempty assignment UUID only
// filters the list as q, because a bare id can be replaced by an unrelated
// first row. An absent owner or missing identifier never fabricates a route.
export function memberAgentRoute(owner: WireRecord | null, fallbackWs: string): RouteState | null {
  if (!owner) return null;
  const key = text(owner.key);
  const assignmentId = text(owner.assignment_id);
  if (!key && !assignmentId) return null;
  const ws = text(owner.workspace_id) || text(owner.workspace) || fallbackWs;
  if (key) return { dest: 'agents', ws, id: key };
  return { dest: 'agents', ws, q: assignmentId };
}

// Declared prerequisites resolved against sibling planning facts: a landed
// sibling is landed, positive preparation is prepared-but-not-observed-merged,
// and anything else keeps the declaration visible without authorizing a plan.
export function epicMemberPrerequisites(epic: WireRecord, member: WireRecord): PrerequisiteFact[] {
  const names = epicMemberRequires(member).names;
  if (!names.length) return [];
  const byName = new Map(epicMembers(epic).map(item => [text(item.name) as string, item] as const));
  return names.map(name => {
    const sibling = byName.get(name);
    if (!sibling) return { name, state: 'unknown' as const };
    if (landedStatus(sibling.status)) return { name, state: 'landed' as const };
    if (positivelyPrepared(memberPlanning(sibling))) return { name, state: 'prepared' as const };
    return { name, state: 'unresolved' as const };
  });
}

const noPackageReason = 'The package directory is missing; create the package before planning.';
const unobservedReason = 'No observed package matches this member in this observation.';

// Planning display for one member: readiness tone/label from observed facts,
// a compact status subline, and exactly one action kind. Positive preparation
// derives Implement, proposed/incomplete derives Plan, a live owner derives
// Open agent, and missing packages or recorded decisions never offer a Plan
// commitment. No action is inferred from the legacy `status` field.
export function epicMemberPlanningRow(
  epic: WireRecord,
  member: WireRecord,
  records: WireRecord[],
  assignments: WireRecord[] = [],
): EpicMemberPlanning {
  const name = text(member?.name) || '';
  const workspace = text(member?.workspace) || text(epic?.workspace) || '';
  const record = epicMemberRecord(epic, member, records);
  const facts = memberPlanning(member);
  const lifecycle = text(member?.status);
  const prerequisites = epicMemberPrerequisites(epic, member);
  const readiness = specReadiness({
    ...record, ...member, workspace,
    package: record?.package || record?.package_ref || member.package,
    assignment_coverage: record?.assignment_coverage ?? record?.observer?.snapshot?.assignment_coverage
      ?? epic.observer?.snapshot?.assignment_coverage,
  }, { assignments, prerequisites, action: facts?.prepared === true ? 'implement' : 'plan' });
  const owner = readiness.owner;
  const none: EpicMemberAction = { kind: 'none', label: '', disabled: false, reason: null, owner: null };

  if (owner) {
    const started = text(owner.created_at) ? `started ${time(text(owner.created_at))}` : '';
    return {
      name, workspace, record,
      status: { label: readiness.label, tone: readiness.tone },
      note: [text(owner.skill) || text(owner.display), started].filter(Boolean).join(' · '),
      action: { kind: 'open-agent', label: 'Open agent', disabled: false, reason: null, owner },
    };
  }
  if (landedStatus(lifecycle)) {
    return { name, workspace, record, status: epicMemberStatus(member), note: '', action: none };
  }
  if (lifecycle === 'in-progress' || lifecycle === 'published') {
    return { name, workspace, record, status: epicMemberStatus(member), note: '', action: none };
  }
  if (memberIsMissing(member)) {
    return {
      name, workspace, record,
      status: { label: readiness.label, tone: readiness.tone },
      note: 'Listed in the record; no package directory',
      action: { kind: 'plan', label: 'Plan', disabled: true, reason: noPackageReason, owner: null },
    };
  }
  if (!record) {
    return {
      name, workspace, record,
      status: { label: 'Package not observed', tone: 'warning' },
      note: 'No observed package matches this member in scope.',
      action: { kind: 'plan', label: 'Plan', disabled: true, reason: unobservedReason, owner: null },
    };
  }
  if (readiness.state === 'decision') {
    return {
      name, workspace, record,
      status: { label: readiness.label, tone: readiness.tone },
      note: readiness.reason || '',
      action: none,
    };
  }
  if (facts?.prepared === true) {
    const reason = readiness.reason;
    return {
      name, workspace, record,
      status: { label: readiness.label, tone: readiness.tone },
      note: reason ?? (facts.steps === null ? 'Prepared' : `${facts.steps} prepared steps`),
      action: { kind: 'implement', label: 'Implement spec', disabled: !readiness.launchable, reason, owner: null },
    };
  }
  if (readiness.state === 'not-planned' || readiness.state === 'incomplete') {
    // Index-only preparation (steps recorded without a positive preparation
    // report) resumes planning; an unresolved prerequisite keeps Plan
    // visible but disabled with its observed reason.
    const reason = readiness.reason;
    const notPlanned = readiness.state === 'not-planned';
    return {
      name, workspace, record,
      status: { label: readiness.label, tone: readiness.tone },
      note: notPlanned ? 'Context only' : 'Resume planning to complete the preparation report and index.',
      action: { kind: 'plan', label: 'Plan', disabled: !readiness.launchable, reason, owner: null },
    };
  }
  return {
    name, workspace, record,
    status: { label: readiness.label, tone: readiness.tone },
    note: readiness.reason || '',
    action: {
      kind: 'plan', label: 'Plan', disabled: true,
      reason: readiness.reason, owner: null,
    },
  };
}

// List-row and fact summary: prepared comes only from positive preparation
// facts, landed stays epicStats, planning counts live owners, and next is the
// first member the step-7 eligibility rule can plan.
export function epicPlanningSummary(
  epic: WireRecord,
  records: WireRecord[] = [],
  assignments: WireRecord[] = [],
): EpicPlanningSummary {
  const stats = epicStats(epic);
  const members = epicMembers(epic);
  const prepared = members.filter(member => positivelyPrepared(memberPlanning(member))).length;
  const planning = members.filter(member =>
    Boolean(planningAssignmentFor(epicMemberRecord(epic, member, records) ?? member, assignments))).length;
  return {
    prepared,
    total: stats.total,
    landed: stats.landed,
    planning,
    next: nextToPlan(epic, records, assignments),
    incomplete: epicPlanningIncomplete(epic),
  };
}

export function focusMember(epic: WireRecord): { name: string; reason: 'attention' | 'evidence' | 'next' | 'in-progress' | 'published' } | null {
  const members = (Array.isArray(epic?.members) ? epic.members : []).filter((member: WireRecord) => text(member?.name));
  const first = (predicate: (member: WireRecord) => boolean) => members.find(predicate);
  const attention = first(member => member.attention === true);
  if (attention) return { name: attention.name, reason: 'attention' };
  const evidence = first(member => ['unknown', 'missing', 'unobserved'].includes(member.status));
  if (evidence) return { name: evidence.name, reason: 'evidence' };
  const next = members.find(member => member.name === epic?.next);
  if (next) return { name: next.name, reason: 'next' };
  const inProgress = first(member => member.status === 'in-progress');
  if (inProgress) return { name: inProgress.name, reason: 'in-progress' };
  const published = first(member => member.status === 'published');
  if (published) return { name: published.name, reason: 'published' };
  return null;
}

export function epicCoverageReasons(epic: WireRecord): string[] {
  const reasons = Array.isArray(epic?.coverage?.reasons) ? epic.coverage.reasons : [];
  return reasons.map((reason: unknown) => {
    const value = String(reason);
    const incomplete = /^member-incomplete:(.+)$/.exec(value);
    if (incomplete) return `${incomplete[1]}: receipts or checkpoints could not be fully read`;
    const unobserved = /^member-unobserved:(.+)$/.exec(value);
    if (unobserved) return `${unobserved[1]}: workspace not observed`;
    return value;
  });
}

export type EpicViewState = {
  read: 'loading' | 'error' | 'ready';
  empty: 'none' | 'no-epics' | 'unsupported' | 'no-snapshot' | 'no-matches';
  partial: boolean;
  offline: boolean;
  stale: boolean;
  observedAt: string | null;
};

export function epicViewState(input: {
  payload: Envelope | null;
  live: boolean;
  connectionFailed: boolean;
  imported: boolean;
  epicSupport: string | null | undefined;
  scoped: WireRecord[];
  visible: WireRecord[];
  selected: WireRecord | null;
}): EpicViewState {
  const scoped = Array.isArray(input.scoped) ? input.scoped : [];
  const visible = Array.isArray(input.visible) ? input.visible : [];
  const selected = input.selected ?? null;
  if (!input.live && !input.payload) {
    return { read: 'ready', empty: 'no-snapshot', partial: false, offline: false, stale: false, observedAt: null };
  }
  if (!input.payload) {
    return { read: input.connectionFailed ? 'error' : 'loading', empty: 'none', partial: false, offline: false, stale: false, observedAt: null };
  }
  const offline = input.live && !input.imported && input.connectionFailed;
  const evidenceIncomplete = Array.isArray(selected?.members)
    && selected.members.some((member: WireRecord) => ['unknown', 'missing', 'unobserved'].includes(member?.status));
  const partial = selected !== null
    && (selected.coverage?.state !== 'complete' || epicRecordedState(selected).conflict || evidenceIncomplete);
  const observedAt = text(selected?.observer?.snapshot?.coverage?.observed_at)
    ?? text(selected?.coverage?.observed_at)
    ?? null;
  const staleView = input.live && !input.imported && !offline && selected !== null
    && (selected.observer?.state !== 'observing' || stale(selected.observer?.snapshot?.coverage?.observed_at));
  const empty = scoped.length === 0
    ? (input.epicSupport === 'No observer snapshots' ? 'no-snapshot'
      : input.epicSupport === 'Epic data unavailable' ? 'unsupported' : 'no-epics')
    : (visible.length === 0 ? 'no-matches' : 'none');
  return { read: 'ready', empty, partial, offline, stale: staleView, observedAt };
}

export function epicDocumentLinks(epic: WireRecord, catalog: CatalogEntry[], preferredId?: string): {
  plan: { name: string; source: string; route: RouteState | null } | null;
  designs: { name: string; source: string; route: RouteState | null }[];
} {
  const entries = Array.isArray(catalog) ? catalog : [];
  const planPath = text(epic?.plan);
  let plan: { name: string; source: string; route: RouteState | null } | null = null;
  if (planPath) {
    const entry = catalogEntryForRecord(epic, 'epic', entries, preferredId);
    const relative = entry ? workspaceRelativePath(entry.directory, planPath) : null;
    plan = {
      name: base(planPath),
      source: planPath,
      route: entry && relative ? { dest: 'files', ws: entry.id, source: 'workspace', path: relative } : null,
    };
  }
  const designs: { name: string; source: string; route: RouteState | null }[] =
    (Array.isArray(epic?.designs) ? epic.designs : []).flatMap((design: WireRecord) => {
      const name = text(design?.design);
      if (!name) return [];
      const declared = text(design?.workspace);
      const idMatch = declared ? entries.find(entry => entry?.id === declared) : undefined;
      const entry = idMatch ?? (declared ? catalogEntryForRecord({ workspace: declared }, 'epic', entries, preferredId) : undefined);
      return [{
        name,
        source: text(design?.path) ?? declared ?? name,
        route: entry ? { dest: 'designs', ws: entry.id, id: name } : null,
      }];
    });
  return { plan, designs };
}
