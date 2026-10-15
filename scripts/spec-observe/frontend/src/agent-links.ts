import { packageFilterMatches } from './format';
import type { WireRecord } from './model';
import { safeRelativeFilePath, type RouteState } from './route';

export type SpecRecordMatch = { record: WireRecord; match: 'assignment' | 'package' };

const normWs = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const normPkg = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\/+$/, '') : value == null ? '' : String(value).replace(/\/+$/, '');

const keyOf = (record: WireRecord): string => String(record.key ?? '');
const keyOrder = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const assignmentId = (record: WireRecord): string | null =>
  typeof record.assignment_id === 'string' && record.assignment_id ? record.assignment_id : null;
const workflowId = (record: WireRecord): string =>
  typeof record.workflow_id === 'string' ? record.workflow_id.trim() : '';

// Workspace identity comes only from the record's own workspace field: base(),
// observer snapshot workspace, observer_id and catalog ids are never fallbacks.
const packageCandidates = (a: WireRecord, records: WireRecord[]): WireRecord[] => {
  const workspace = normWs(a.workspace);
  const specPackage = normPkg(a.spec_package);
  if (!workspace || !specPackage) return [];
  return records.filter(record =>
    normWs(record.workspace) === workspace
    && [record.package, record.package_ref, record.spec_package].some(value => {
      const candidate = normPkg(value);
      return candidate !== '' && candidate === specPackage;
    }));
};

const recency = (record: WireRecord): number => {
  const observed = Date.parse(typeof record.observed_at === 'string' ? record.observed_at : '');
  const completed = Date.parse(typeof record.completed_at === 'string' ? record.completed_at : '');
  return Math.max(Number.isFinite(observed) ? observed : 0, Number.isFinite(completed) ? completed : 0, 0);
};

const rankOf = (record: WireRecord): [number, number, number, number, number] => [
  record.is_current_assignment === true ? 1 : 0,
  packageFilterMatches(record, 'active') ? 1 : 0,
  record.planned === true ? 1 : 0,
  record.recent_completion === true ? 1 : 0,
  recency(record),
];

export function specRecordFor(a: WireRecord, records: WireRecord[]): SpecRecordMatch | null {
  const candidates = packageCandidates(a, records);
  const assignment = assignmentId(a);
  const workflow = workflowId(a);
  const assignmentCandidates = candidates.filter(record => {
    if (record.recent_completion) return false;
    if (!workflow || workflowId(record) !== workflow) return false;
    const candidate = assignmentId(record);
    return candidate === null || candidate === assignment;
  });
  if (assignmentCandidates.length) {
    const exact = (record: WireRecord): number => (assignment !== null && assignmentId(record) === assignment ? 1 : 0);
    const chosen = [...assignmentCandidates]
      .sort((left, right) => exact(right) - exact(left) || keyOrder(keyOf(left), keyOf(right)))[0];
    return { record: chosen, match: 'assignment' };
  }
  if (!candidates.length) return null;
  const chosen = [...candidates].sort((left, right) => {
    const leftRank = rankOf(left);
    const rightRank = rankOf(right);
    for (let index = 0; index < leftRank.length; index += 1) {
      if (leftRank[index] !== rightRank[index]) return rightRank[index] - leftRank[index];
    }
    return keyOrder(keyOf(left), keyOf(right));
  })[0];
  return { record: chosen, match: 'package' };
}

export function specRoute(record: WireRecord, ws?: string): RouteState {
  const route: RouteState = { dest: 'specs', id: record.key };
  if (typeof ws === 'string' && ws !== '') route.ws = ws;
  if (record.recent_completion) route.filter = 'completed';
  else if (record.planned) route.filter = 'planned';
  return route;
}

export function workTourRoute(record: WireRecord, ws?: string): RouteState | null {
  if (record.evidence?.state !== 'recorded') return null;
  if (typeof record.package !== 'string' || record.package === '') return null;
  const route: RouteState = { dest: 'files', source: 'package', id: record.package, path: 'work-tour.html' };
  if (typeof ws === 'string' && ws !== '') route.ws = ws;
  return route;
}

// Scoped relationship routes: every route below either carries an explicit
// nonempty workspace identity or returns null. Values are passed through
// verbatim; trimming is used only to decide presence.
export function threadRoute(a: WireRecord): RouteState | null {
  if (!normWs(a.workspace_id) || !normWs(a.thread_id)) return null;
  return { dest: 'conversations', ws: a.workspace_id, id: a.thread_id };
}

export function briefRoute(a: WireRecord): RouteState | null {
  if (!normWs(a.workspace_id) || !safeRelativeFilePath(a.brief)) return null;
  return { dest: 'files', ws: a.workspace_id, source: 'workspace', path: a.brief };
}

export function repositoryFilesRoute(ws: string, repositoryId: unknown): RouteState | null {
  if (typeof ws !== 'string' || !ws.trim()) return null;
  if (typeof repositoryId !== 'string' || !repositoryId.trim()) return null;
  return { dest: 'files', ws, source: 'repository', id: repositoryId };
}

// Handoff join: keep each sent handoff in recorded order and attach the
// observation row only when the assignment id matches exactly and both sides
// name the same nonempty workspace. Unsent handoffs are omitted; a missing or
// foreign row stays null rather than falling back to a guess.
export function launchedAgents(
  thread: WireRecord,
  assignments: WireRecord[],
): { handoff: WireRecord; row: WireRecord | null }[] {
  const workspace = normWs(thread.workspace_id);
  const handoffs: WireRecord[] = Array.isArray(thread.handoffs) ? thread.handoffs : [];
  const launched: { handoff: WireRecord; row: WireRecord | null }[] = [];
  for (const handoff of handoffs) {
    const id = assignmentId(handoff);
    if (id === null) continue;
    const row = workspace
      ? assignments.find(candidate => assignmentId(candidate) === id && normWs(candidate.workspace) === workspace) ?? null
      : null;
    launched.push({ handoff, row });
  }
  return launched;
}
