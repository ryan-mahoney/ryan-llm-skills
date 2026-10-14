// Pure Next steps row and view model: no DOM, no transport, no timers and no
// store access. Callers pass the scan and the snapshot facts they already
// hold. This library precursor is consumed by the step 5 destination and the
// step 7 rail; it only derives the stage table, hold gates, counts and view
// state, and reuses readiness.ts, scope.ts, launch-handoff.ts and the shared
// spec-prompt planning plan instead of restating readiness, target or
// coverage rules.
import { activeRun } from '../format';
import type { WireRecord } from '../model';
import type { RouteState } from '../route';
import {
  coverageStateOf, memberPlanning, nextToPlan, observedSpecReadiness, planningAssignmentFor, planningFactsFor, READINESS,
} from '../readiness';
import type { ReadinessFacts } from '../readiness';
import type { PackagePlanningPlan } from '../launch-handoff';
import { plannedTargetChoices } from '../launch-handoff';
import type { CatalogEntry } from '../scope';
import { inWorkspaceScope } from '../scope';
import { CRITIQUE_ONLY_PLAN, packagePlanningPlan } from '../../../../workspaces/spec-prompt.mjs';

export type NextStepsFilter = 'all' | 'plan' | 'critique' | 'spec' | 'implement' | 'review';

export type NextStepsFileRow = {
  key: string;
  kind: 'package' | 'epic';
  workspace_id: string;
  workspace: string;
  workspace_name: string;
  slug: string;
  package?: string;
  stage: 'proposal' | 'critique' | 'spec' | 'work-tour' | 'epic';
  file: string;
  path: string;
  written_at: string;
  observed_files: { name: string; stage: string; written_at: string }[];
  signal: { state: 'ok' | 'unreadable' | 'unparsed'; reason?: string; [key: string]: unknown };
};

export type NextStepsScan = {
  schema_version: 1;
  scanned_at: string;
  window_ms: number;
  coverage: {
    state: 'complete' | 'partial' | 'unavailable';
    reasons: string[];
    workspaces: { read: number; total: number | null };
    unread: { workspace: string; reason: string }[];
  };
  rows: NextStepsFileRow[];
};

export type NextStepActionId =
  | 'plan-members' | 'critique-proposal' | 'write-spec' | 'discuss-proposal'
  | 'implement-spec' | 'open-spec' | 'review-work-tour' | 'open-agent'
  | 'open-file' | 'open-proposal' | 'open-pull-request';

export type NextStepAction = {
  id: NextStepActionId;
  label: string;
  kind: 'launch' | 'navigate' | 'external' | 'held';
  filter?: Exclude<NextStepsFilter, 'all'>;
  route?: RouteState;
  href?: string;
  planningPlan?: PackagePlanningPlan;
  reason?: string;
};

export type NextStepRow = NextStepsFileRow & {
  step: NextStepAction;
  held: string | null;
  secondary: NextStepAction[];
  running: WireRecord | null;
  record: WireRecord | null;
};

export type NextStepsViewState = {
  read: 'loading' | 'error' | 'empty' | 'filtered-empty' | 'ideal';
  partial: boolean;
  denied: boolean;
  offline: boolean;
  stale: boolean;
  banner: 'offline' | 'stale' | 'denied' | 'partial' | null;
};

export type NextStepsContext = {
  records?: WireRecord[];
  assignments?: WireRecord[];
  epics?: WireRecord[];
  catalog?: CatalogEntry[];
  scope?: string;
  token?: string | null;
  live?: boolean;
  connectionFailed?: boolean;
  now?: number | null;
};

export const NEXT_STEPS_FRESH_MS = 120000;

export function freshScan(scan: NextStepsScan | null, now: number | null | undefined): boolean {
  if (!scan || typeof scan.scanned_at !== 'string') return false;
  const scannedAt = Date.parse(scan.scanned_at);
  if (!Number.isFinite(scannedAt)) return false;
  if (typeof now !== 'number' || !Number.isFinite(now)) return false;
  return now - scannedAt <= NEXT_STEPS_FRESH_MS;
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const list = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

const FILTERS: readonly NextStepsFilter[] = ['all', 'plan', 'critique', 'spec', 'implement', 'review'];
const normalizeFilter = (value: unknown): NextStepsFilter =>
  typeof value === 'string' && (FILTERS as readonly string[]).includes(value) ? value as NextStepsFilter : 'all';

const openFileAction = (row: NextStepsFileRow): NextStepAction => ({
  id: 'open-file',
  label: 'Open file',
  kind: 'navigate',
  route: { dest: 'files', ws: row.workspace_id, source: 'workspace', path: row.path },
});

const launchRoute = (row: NextStepsFileRow, packageRef: string | undefined, skill: string, stop: string): RouteState => ({
  dest: 'launch', ws: row.workspace_id, tab: 'brief',
  ...(packageRef ? { package: packageRef } : {}),
  skill,
  stop,
});

const critiqueProposalAction = (row: NextStepsFileRow): NextStepAction => ({
  id: 'critique-proposal',
  label: 'Critique proposal',
  kind: 'launch',
  filter: 'critique',
  planningPlan: CRITIQUE_ONLY_PLAN as PackagePlanningPlan,
  route: launchRoute(row, row.package, 'spec-architect-critics', 'critique'),
});

const writeSpecAction = (row: NextStepsFileRow, plan: PackagePlanningPlan): NextStepAction => ({
  id: 'write-spec',
  label: 'Write spec',
  kind: 'launch',
  filter: 'spec',
  planningPlan: plan,
  route: launchRoute(row, row.package, 'spec-write', 'prepared'),
});

const discussProposalAction = (row: NextStepsFileRow): NextStepAction => ({
  id: 'discuss-proposal',
  label: 'Discuss proposal',
  kind: 'launch',
  route: { dest: 'conversations', ws: row.workspace_id, tab: 'new' },
});

const implementSpecAction = (row: NextStepsFileRow): NextStepAction => ({
  id: 'implement-spec',
  label: 'Implement spec',
  kind: 'launch',
  filter: 'implement',
  route: { dest: 'launch', ws: row.workspace_id, tab: 'brief', package: row.package },
});

const openSpecAction = (row: NextStepsFileRow, record: WireRecord | null, label: string): NextStepAction => {
  const route: RouteState = { dest: 'specs', ws: row.workspace_id, filter: 'ready' };
  const key = text(record?.key);
  if (key) route.id = key;
  else route.q = row.slug;
  return { id: 'open-spec', label: 'Open spec', kind: 'navigate', filter: 'implement', route, reason: label };
};

const openProposalAction = (row: NextStepsFileRow): NextStepAction | null =>
  list<{ name?: unknown }>(row.observed_files).some(file => file?.name === 'proposal.md')
    ? {
        id: 'open-proposal', label: 'Open proposal', kind: 'navigate',
        route: { dest: 'files', ws: row.workspace_id, source: 'workspace', path: `specs/${row.slug}/proposal.md` },
      }
    : null;

const GITHUB_PULL_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

const pullRequestUrl = (signal: NextStepsFileRow['signal'] | undefined): string => {
  const pr = signal?.pr;
  if (typeof pr === 'string') return pr;
  if (pr && typeof pr === 'object' && typeof (pr as { url?: unknown }).url === 'string') return (pr as { url: string }).url;
  return '';
};

type LaunchGate = {
  record: WireRecord | null;
  discussOnly?: boolean;
  readiness?: ReadinessFacts | null;
};

const launchHoldReason = (
  action: NextStepAction,
  scan: NextStepsScan | null,
  context: NextStepsContext,
  gate: LaunchGate,
): string | null => {
  if (context.live !== true) return 'The live dashboard is required to start an assignment.';
  if (context.connectionFailed === true) return 'The dashboard is offline; assignments are unavailable.';
  if (gate.discussOnly === true) return null;
  if (!text(context.token)) return 'This session has no action token; assignments are held.';
  if (!freshScan(scan, context.now)) return 'The file scan is stale; refresh files before starting.';
  const record = gate.record;
  if (!record) return 'This package has not been observed in a snapshot yet.';
  if (plannedTargetChoices(record.targets).length === 0) return 'No usable package target is available.';
  const coverage = coverageStateOf(record);
  if (coverage !== 'complete') return `Assignment coverage is ${coverage}; assignments are held.`;
  if (action.id === 'implement-spec' && gate.readiness && gate.readiness.launchable !== true) {
    return gate.readiness.reason || gate.readiness.label;
  }
  return null;
};

const gateLaunch = (
  action: NextStepAction,
  scan: NextStepsScan | null,
  context: NextStepsContext,
  gate: LaunchGate,
): NextStepAction => {
  if (action.kind !== 'launch') return action;
  const reason = launchHoldReason(action, scan, context, gate);
  return reason === null ? action : { ...action, kind: 'held', reason };
};

// Kit-id-only assignment rows are compared through the catalog directory name
// so planningAssignmentFor sees the same workspace identity as the scan row;
// a conflicting identity stays unmatched instead of being renamed.
const projectedAssignments = (row: NextStepsFileRow, assignments: WireRecord[], catalog: CatalogEntry[]): WireRecord[] =>
  assignments.map(assignment => {
    if (text(assignment?.workspace)) return assignment;
    const workspaceId = text(assignment?.workspace_id);
    if (!workspaceId) return assignment;
    const entry = catalog.find(candidate => candidate?.id === workspaceId);
    const directory = entry ? String(entry.directory ?? '') : '';
    const basename = directory.split('/').filter(Boolean).pop() ?? '';
    if (basename && basename === row.workspace) return { ...assignment, workspace: basename };
    return assignment;
  });

const matchingRecords = (row: NextStepsFileRow, records: WireRecord[]): WireRecord[] => {
  if (!row.package) return [];
  return records.filter(record => record
    && text(record.workspace) === row.workspace
    && (record.package === row.package || record.package_ref === row.package));
};

const epicRecordFor = (epics: WireRecord[], row: NextStepsFileRow): WireRecord | null => {
  for (const record of epics) {
    if (!record) continue;
    const workspace = text(record.workspace);
    if (workspace && workspace !== row.workspace) continue;
    if (text(record.epic) === row.slug || text(record.name) === row.slug) return record;
  }
  return null;
};

const memberRecordFor = (
  records: WireRecord[],
  row: NextStepsFileRow,
  epicRecord: WireRecord | null,
  member: WireRecord | null,
): WireRecord | null => {
  if (!member) return null;
  const workspace = text(member.workspace) || text(epicRecord?.workspace) || row.workspace;
  const identities = [text(member.package), text(member.name)].filter(Boolean);
  if (!identities.length) return null;
  for (const record of records) {
    if (!record) continue;
    if (workspace && text(record.workspace) !== workspace) continue;
    const candidates = [text(record.package), text(record.package_ref), text(record.name)].filter(Boolean);
    if (candidates.some(candidate => identities.includes(candidate))) return record;
  }
  return null;
};

const proposalActions = (
  row: NextStepsFileRow,
  record: WireRecord | null,
  scan: NextStepsScan | null,
  context: NextStepsContext,
  open: NextStepAction,
): { primary: NextStepAction; secondary: NextStepAction[] } => {
  const verdict = text(row.signal.verdict);
  if (verdict === 'INCOMPATIBLE') {
    const primary = gateLaunch(discussProposalAction(row), scan, context, { record, discussOnly: true });
    return { primary, secondary: [open] };
  }
  if (verdict !== 'COMPATIBLE' && verdict !== 'COMPATIBLE_WITH_CAVEATS') return { primary: open, secondary: [] };
  const writeSpec = gateLaunch(writeSpecAction(row, packagePlanningPlan({ proposal: true, critiqueRecommended: false, critique: false }) as PackagePlanningPlan), scan, context, { record });
  const critique = gateLaunch(critiqueProposalAction(row), scan, context, { record });
  if (row.signal.critique_recommended === true) {
    return { primary: critique, secondary: [writeSpec, open] };
  }
  return { primary: writeSpec, secondary: [critique, open] };
};

const critiqueActions = (
  row: NextStepsFileRow,
  record: WireRecord | null,
  scan: NextStepsScan | null,
  context: NextStepsContext,
  open: NextStepAction,
): { primary: NextStepAction; secondary: NextStepAction[] } => {
  const plan = packagePlanningPlan({ proposal: true, critiqueRecommended: true, critique: true }) as PackagePlanningPlan;
  const primary = gateLaunch(writeSpecAction(row, plan), scan, context, { record });
  const secondary: NextStepAction[] = [];
  const openProposal = openProposalAction(row);
  if (openProposal) secondary.push(openProposal);
  secondary.push(open);
  return { primary, secondary };
};

const specActions = (
  row: NextStepsFileRow,
  record: WireRecord | null,
  scan: NextStepsScan | null,
  context: NextStepsContext,
  open: NextStepAction,
): { primary: NextStepAction; secondary: NextStepAction[] } => {
  const identity = record ?? { workspace: row.workspace, package: row.package ?? '' };
  const readiness = observedSpecReadiness(identity, context.epics ?? [], context.assignments ?? []).readiness;
  if (readiness.state === 'ready' && readiness.launchable === true) {
    return { primary: gateLaunch(implementSpecAction(row), scan, context, { record, readiness }), secondary: [open] };
  }
  return { primary: openSpecAction(row, record, READINESS[readiness.state].label), secondary: [open] };
};

const workTourActions = (
  row: NextStepsFileRow,
  open: NextStepAction,
): { primary: NextStepAction; secondary: NextStepAction[] } => {
  const primary: NextStepAction = {
    id: 'review-work-tour', label: 'Review work tour', kind: 'navigate', filter: 'review',
    route: { dest: 'files', ws: row.workspace_id, source: 'workspace', path: row.path },
  };
  const secondary: NextStepAction[] = [];
  const url = pullRequestUrl(row.signal);
  if (url && GITHUB_PULL_URL.test(url)) {
    secondary.push({ id: 'open-pull-request', label: 'Open pull request', kind: 'external', href: url });
  }
  secondary.push(open);
  return { primary, secondary };
};

const epicActions = (
  row: NextStepsFileRow,
  scan: NextStepsScan | null,
  context: NextStepsContext,
  open: NextStepAction,
): { primary: NextStepAction; secondary: NextStepAction[] } => {
  const epicRecord = epicRecordFor(context.epics ?? [], row);
  // The planning candidate must be selected under the same projected workspace
  // identity as buildRow: a kit-id-only assignment names the directory
  // workspace, so raw rows let nextToPlan return an already-owned member.
  const assignments = projectedAssignments(row, context.assignments ?? [], context.catalog ?? []);
  const member = nextToPlan(epicRecord, context.records ?? [], assignments);
  const memberRecord = memberRecordFor(context.records ?? [], row, epicRecord, member);
  const memberRef = text(memberRecord?.package) || text(memberRecord?.package_ref) || text(member?.package) || text(member?.name);
  const facts = memberPlanning(member);
  const plan = packagePlanningPlan({
    proposal: facts?.proposal === true,
    critiqueRecommended: facts?.critiqueRecommended === true,
    critique: facts?.critique === true,
  }) as PackagePlanningPlan;
  const base: NextStepAction = { id: 'plan-members', label: 'Plan members', kind: 'launch', filter: 'plan', planningPlan: plan };
  const primary: NextStepAction = memberRef
    ? gateLaunch(
        { ...base, route: { dest: 'launch', ws: row.workspace_id, tab: 'brief', package: memberRef, skill: plan.skill, stop: plan.stop } },
        scan,
        context,
        { record: memberRecord },
      )
    : { ...base, kind: 'held', reason: 'No eligible member is observed for planning.' };
  const openEpic: NextStepAction = {
    id: 'open-file',
    label: 'Open epic',
    kind: 'navigate',
    route: epicRecord && text(epicRecord.key)
      ? { dest: 'epics', ws: row.workspace_id, id: text(epicRecord.key) }
      : { dest: 'epics', ws: row.workspace_id, q: row.slug },
  };
  return { primary, secondary: [openEpic, open] };
};

const stageActions = (
  row: NextStepsFileRow,
  record: WireRecord | null,
  scan: NextStepsScan | null,
  context: NextStepsContext,
): { primary: NextStepAction; secondary: NextStepAction[] } => {
  const open = openFileAction(row);
  if (!row.signal || row.signal.state !== 'ok') return { primary: open, secondary: [] };
  if (row.stage === 'epic') return epicActions(row, scan, context, open);
  if (row.stage === 'proposal') return proposalActions(row, record, scan, context, open);
  if (row.stage === 'critique') return critiqueActions(row, record, scan, context, open);
  if (row.stage === 'spec') return specActions(row, record, scan, context, open);
  if (row.stage === 'work-tour') return workTourActions(row, open);
  return { primary: open, secondary: [] };
};

const buildRow = (row: NextStepsFileRow, scan: NextStepsScan | null, context: NextStepsContext): NextStepRow | null => {
  const records = context.records ?? [];
  const matches = matchingRecords(row, records);
  if (matches.some(record => record.recent_completion === true || record.workflow_state === 'complete')) return null;
  const active = matches.find(record => activeRun(record)) ?? null;
  const planned = matches.find(record => record.planned === true || planningFactsFor(record) !== null) ?? null;
  const record = active ?? planned ?? matches[0] ?? null;
  const identity = record ?? (row.package ? { workspace: row.workspace, package: row.package } : null);
  const projected = projectedAssignments(row, context.assignments ?? [], context.catalog ?? []);
  const owner = identity ? planningAssignmentFor(identity, projected) : null;
  const running = active ?? owner ?? null;
  if (running) {
    const route: RouteState = { dest: 'agents', ws: row.workspace_id };
    const key = text(running.key);
    const assignmentId = text(running.assignment_id);
    if (key) route.id = key;
    else if (assignmentId) route.q = assignmentId;
    const step: NextStepAction = { id: 'open-agent', label: 'Open agent', kind: 'navigate', route };
    return { ...row, step, held: null, secondary: [openFileAction(row)], running, record };
  }
  const { primary, secondary } = stageActions(row, record, scan, context);
  return {
    ...row,
    step: primary,
    held: primary.kind === 'held' ? primary.reason || 'Held' : null,
    secondary,
    running: null,
    record,
  };
};

export function nextStepRows(scan: NextStepsScan | null, context: NextStepsContext = {}): NextStepRow[] {
  const rows = list<NextStepsFileRow>(scan?.rows);
  const scope = context.scope;
  const catalog = context.catalog ?? [];
  const scoped = scope
    ? rows.filter(row => row && inWorkspaceScope({ workspace_id: row.workspace_id, workspace: row.workspace }, 'assignment', scope, catalog))
    : rows;
  const out: NextStepRow[] = [];
  for (const row of scoped) {
    if (!row) continue;
    const built = buildRow(row, scan, context);
    if (built) out.push(built);
  }
  return out;
}

export function filterCounts(rows: NextStepRow[]): Record<NextStepsFilter, number> {
  const counts: Record<NextStepsFilter, number> = { all: rows.length, plan: 0, critique: 0, spec: 0, implement: 0, review: 0 };
  for (const row of rows) {
    const filter = row?.step?.filter;
    if (filter) counts[filter] += 1;
  }
  return counts;
}

const signalSearchText = (signal: NextStepsFileRow['signal'] | undefined): string[] => {
  if (!signal) return [];
  const values: unknown[] = [
    signal.verdict, signal.reason, signal.summary, signal.title, signal.assessment, signal.commit,
  ];
  for (const field of ['must_address', 'should_address', 'must', 'should']) {
    const value = signal[field];
    if (Array.isArray(value)) values.push(...value);
  }
  const url = pullRequestUrl(signal);
  if (url) values.push(url);
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
};

const searchable = (row: NextStepRow): string =>
  [row.file, row.slug, row.workspace_name, row.workspace, ...signalSearchText(row.signal)]
    .map(value => typeof value === 'string' ? value : '')
    .join(' ')
    .toLowerCase();

export function visibleRows(rows: NextStepRow[], filter: NextStepsFilter, q: string): NextStepRow[] {
  const normalized = normalizeFilter(filter);
  const query = text(q).trim().toLowerCase();
  return list<NextStepRow>(rows).filter(row => {
    if (!row) return false;
    if (normalized !== 'all' && row.step?.filter !== normalized) return false;
    if (!query) return true;
    return searchable(row).includes(query);
  });
}

export function railCount(rows: NextStepRow[]): number {
  return list<NextStepRow>(rows).filter(row => row && row.running === null && row.signal?.state === 'ok').length;
}

export function nextStepsViewState(
  scan: NextStepsScan | null,
  rows: NextStepRow[],
  context: { filter?: NextStepsFilter; q?: string; token?: string | null; live?: boolean; connectionFailed?: boolean; now?: number | null } = {},
): NextStepsViewState {
  const observed = list<NextStepRow>(rows);
  const offline = context.connectionFailed === true;
  const denied = !text(context.token);
  const stale = scan !== null && !freshScan(scan, context.now);
  const coverage = text(scan?.coverage?.state);
  const partial = scan !== null && coverage !== 'complete' && !(coverage === 'unavailable' && observed.length === 0);
  let read: NextStepsViewState['read'];
  if (scan === null) read = offline ? 'error' : 'loading';
  else if (coverage === 'unavailable' && observed.length === 0) read = 'error';
  else if (observed.length === 0) read = partial ? 'ideal' : 'empty';
  else if (visibleRows(observed, context.filter ?? 'all', context.q ?? '').length === 0) read = 'filtered-empty';
  else read = 'ideal';
  const banner: NextStepsViewState['banner'] = offline ? 'offline' : stale ? 'stale' : denied ? 'denied' : partial ? 'partial' : null;
  return { read, partial, denied, offline, stale, banner };
}
