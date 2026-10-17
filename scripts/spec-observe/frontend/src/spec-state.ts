import { HttpError } from './api';
import { attention, compareReadiness, packageFilterMatches, stale, str } from './format';
import { packageSummaries } from './model';
import type { Envelope, Observer, WireRecord } from './model';

export type SpecFilter = 'active' | 'attention' | 'completed' | 'planned' | 'ready';
export type ObservationContext = { live: boolean; connectionFailed: boolean; now: number | null };
export type SpecViewState = {
  read: 'loading' | 'error' | 'ready';
  partial: boolean; offline: boolean; stale: boolean;
  reasons: string[]; observedAt: string | null;
};

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const validTime = (value: unknown): string | null => {
  const text = str(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
};
const coverageState = (coverage: WireRecord | undefined): string => str(coverage?.state) || 'unknown';
const coverageReasons = (coverage: WireRecord | undefined): string[] =>
  list(coverage?.reasons).map(reason => str(reason)).filter(Boolean);
const scopeName = (observer: Observer): string =>
  str(observer?.snapshot?.workspace) || str(observer?.observer_id) || str(observer?.source) || 'Unknown scope';
const newestScopedObservation = (observers: Observer[]): string | null => {
  let newest: string | null = null, newestAt = -Infinity;
  for (const observer of list(observers)) {
    const observedAt = validTime(observer?.snapshot?.coverage?.observed_at);
    if (!observedAt) continue;
    const at = Date.parse(observedAt);
    if (at > newestAt) {
      newest = observedAt;
      newestAt = at;
    }
  }
  return newest;
};

// One list model for the count, rows and App selection fallback. The filter
// predicate stays in format.packageFilterMatches; sorting differs by filter.
export function visibleSpecs(records: WireRecord[], filter: SpecFilter, query: string): WireRecord[] {
  const q = str(query).trim().toLowerCase();
  const matched = packageSummaries(list(records), filter).filter(record =>
    (!q || [record.workspace, record.package_ref, record.package, record.activity, record.obligation, record.execution, record.workflow_state].some(value => str(value).toLowerCase().includes(q)))
    && packageFilterMatches(record, filter));
  return matched.sort((a, b) => {
    if (filter === 'active') {
      const attentionFirst = Number(attention(b)) - Number(attention(a));
      if (attentionFirst) return attentionFirst;
    } else if (filter === 'completed') {
      const aAt = Date.parse(str(a.completed_at)), bAt = Date.parse(str(b.completed_at));
      const aValid = Number.isFinite(aAt), bValid = Number.isFinite(bAt);
      if (aValid && bValid && aAt !== bAt) return bAt - aAt;
      if (aValid !== bValid) return aValid ? -1 : 1;
    } else if (filter === 'planned' || filter === 'ready') {
      return compareReadiness(a, b);
    }
    return str(a.workspace).localeCompare(str(b.workspace)) || str(a.package).localeCompare(str(b.package));
  });
}

// Honest read state for the shared snapshot read. Freshness is the workspace
// observation time only; heartbeat and generated_at never certify freshness.
export function specViewState(payload: Envelope | null, record: WireRecord | null, scopedObservers: Observer[], context: ObservationContext): SpecViewState {
  const scoped = list(scopedObservers) as Observer[];
  const observedAt = record ? validTime(record?.observer?.snapshot?.coverage?.observed_at) : newestScopedObservation(scoped);
  const reasons: string[] = [];
  if (payload?.truncated) reasons.push('Snapshot read budget reached; some observations are unavailable.');
  for (const errorEntry of list(payload?.errors)) reasons.push(`${errorEntry?.source ? str(errorEntry.source) + ': ' : ''}${str(errorEntry?.message)}`);
  for (const observer of scoped) {
    const coverage = observer?.snapshot?.coverage;
    const state = coverageState(coverage);
    if (state !== 'complete') {
      reasons.push(`${scopeName(observer)} coverage ${state}.`);
      reasons.push(...coverageReasons(coverage));
    }
    // Freshness is per contributing scope: a fresh complete snapshot must not
    // mask another scope whose observation is stale or unavailable.
    const scopedAt = validTime(coverage?.observed_at);
    if (!scopedAt) reasons.push(`${scopeName(observer)} observation unavailable.`);
    else if (stale(scopedAt, context.now)) reasons.push(`${scopeName(observer)} observation stale.`);
  }
  if (record) {
    const coverage = record.coverage;
    const state = coverageState(coverage);
    if (state !== 'complete') reasons.push(`Selected run coverage ${state}.`);
    reasons.push(...coverageReasons(coverage));
  }
  const partial = Boolean(payload?.truncated)
    || list(payload?.errors).length > 0
    || scoped.some(observer => coverageState(observer?.snapshot?.coverage) !== 'complete')
    || Boolean(record && coverageState(record.coverage) !== 'complete');
  return {
    read: payload ? 'ready' : context.connectionFailed ? 'error' : 'loading',
    partial,
    offline: Boolean(context.connectionFailed),
    stale: stale(observedAt, context.now),
    reasons,
    observedAt,
  };
}

// Live end only while the observation is genuinely live; otherwise the fixed
// snapshot observation time, then the timing observation as fallback.
export function observationEnd(record: WireRecord, context: ObservationContext): string | null {
  const observer = record?.observer;
  if (context.live && !context.connectionFailed && observer?.state === 'observing'
    && context.now !== null && Number.isFinite(context.now)
    && !stale(observer?.published_at, context.now)
    && !stale(observer?.snapshot?.coverage?.observed_at, context.now)) return new Date(context.now).toISOString();
  return validTime(observer?.snapshot?.coverage?.observed_at) ?? validTime(record?.timing?.observed_at);
}

export function packageFromKey(key: string | undefined): string | null {
  if (typeof key !== 'string' || !key) return null;
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || (parsed.length !== 3 && parsed.length !== 4)) return null;
    const value: unknown = parsed[1];
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

export function linkedAssignmentKey(record: WireRecord, assignments: WireRecord[]): string | null {
  const workspace = str(record?.workspace);
  const assignmentId = str(record?.assignment_id);
  if (!assignmentId) return null;
  const match = list(assignments).find(assignment => str(assignment?.workspace) === workspace && str(assignment?.assignment_id) === assignmentId);
  return match ? JSON.stringify([workspace, assignmentId]) : null;
}

// Strips only the exact canonical package prefix plus one slash; outsiders,
// the package root itself and parent segments stay unlinked.
export function packageRelative(record: WireRecord, sourcePath: string): string | null {
  const root = str(record?.package).replace(/\/+$/, '');
  const value = str(sourcePath);
  if (!root || !value) return null;
  const prefix = root + '/';
  if (!value.startsWith(prefix)) return null;
  const relative = value.slice(prefix.length);
  if (!relative || relative.split('/').includes('..')) return null;
  return relative;
}

const isHttpError = (error: unknown): boolean =>
  error instanceof HttpError
  || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'HttpError');

// A response was received and refused; everything else is uncertainty, not a
// silent retry signal.
export function classifyCompletionError(error: unknown): { kind: 'refused' | 'uncertain'; message: string } {
  const message = str((error as { message?: unknown } | null | undefined)?.message) || 'Completion could not be saved. Retry.';
  return { kind: isHttpError(error) ? 'refused' : 'uncertain', message };
}
