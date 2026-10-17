import type { WireRecord } from './model';
import { activeRun, attention, str } from './format';

const list = (value: unknown): WireRecord[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
export const packageKey = (record: WireRecord): string => JSON.stringify([record.workspace, record.package, 'package-execution']);
export const phaseLabel = (phase: unknown): string => str(phase).replace(/[_-]/g, ' ') || 'Unknown';
export const executionSummary = (record: WireRecord): WireRecord | null => {
  const summary = record.execution_summary;
  if (summary == null) return null;
  if (typeof summary !== 'object' || Array.isArray(summary)) return { mode: 'unknown', phase: 'unknown', coverage: { state: 'unknown', reasons: ['Execution summary could not be read.'], omitted: null }, waves: [], steps: [] };
  const malformed = !['waves', 'serial', 'unknown'].includes(summary.mode) || !Array.isArray(summary.waves) || !Array.isArray(summary.steps)
    || (summary.mode === 'waves' && (summary.waves.length === 0 || summary.waves.some((wave: unknown) => !wave || typeof wave !== 'object' || Array.isArray(wave) || !Array.isArray((wave as WireRecord).members))));
  if (!malformed) return summary;
  return { ...summary, mode: 'unknown', phase: 'unknown', waves: list(summary.waves), steps: list(summary.steps), coverage: { ...summary.coverage, state: 'unknown', reasons: [...(Array.isArray(summary.coverage?.reasons) ? summary.coverage.reasons : []), 'Execution structure is incomplete; the execution mode is unknown.'] } };
};
export const executionWaves = (record: WireRecord): WireRecord[] => list(executionSummary(record)?.waves).slice().sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
export function waveIdentity(wave: WireRecord, waves: WireRecord[]): string {
  if (wave.ordinal != null && waves.filter(item => item.ordinal === wave.ordinal).length === 1) return `ordinal:${wave.ordinal}`;
  return `record:${wave.wave_id ?? wave.record_path ?? 'unknown'}`;
}
export const executionSteps = (record: WireRecord): WireRecord[] => list(executionSummary(record)?.steps).slice().sort((a, b) => Number(a.step) - Number(b.step));
export const waveNeedsAttention = (wave: WireRecord): boolean => Boolean(wave.blocking_reason) || Number(wave.counts?.blocked) > 0 || list(wave.members).some(member => Boolean(member.blocking_reason) || ['blocked', 'failed', 'decision-required', 'conflicted'].includes(member.phase)) || ['blocked', 'conflicted', 'failed'].includes(wave.state) || ['blocked', 'failed', 'conflicted'].includes(wave.candidate?.phase);
export const waveExpanded = (wave: WireRecord): boolean => waveNeedsAttention(wave) || wave.observed !== false && !['integrated', 'complete', 'completed'].includes(wave.state);
export function waveSealedCount(wave: WireRecord): number {
  if (wave.state === 'integrated') return 0;
  return Number.isSafeInteger(wave.sealed_count) ? wave.sealed_count : list(wave.members).filter(member => member.phase === 'sealed' && !member.integrated).length;
}
export function candidateAttempts(record: WireRecord, wave: WireRecord): WireRecord[] {
  return packageAttempts(record).filter(attempt => attempt.subject_kind === 'candidate' && attempt.wave_id === wave.wave_id || Boolean(wave.candidate?.run_id) && attempt.run_id === wave.candidate.run_id);
}
export function executionCounts(record: WireRecord): string {
  const summary = executionSummary(record);
  if (!summary) return '';
  const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : '?';
  const sealed = executionWaves(record).reduce((n, wave) => n + waveSealedCount(wave), 0);
  return `${count(summary.integrated_count)} integrated · ${sealed} sealed · ${count(summary.active_count)} active · ${count(summary.blocked_count)} blocked · ${count(summary.queued_count)} queued`;
}

// Preserve every run as evidence, but give the package a selection identity that
// survives worker turnover. Attention and active phase are independent facts.
export function aggregatePackage(records: WireRecord[], representative: WireRecord): WireRecord {
  const current = records.filter(record => !record.planned && !record.recent_completion && (record.execution_record || record.is_current_assignment !== false));
  const execution = current.find(record => record.execution_record && record.execution_summary != null) ?? current.find(record => record.execution_summary != null);
  const summary = execution ? executionSummary(execution) : null;
  const runs = records.flatMap(record => Array.isArray(record.run_records) ? record.run_records : record.execution_record ? [] : [record]);
  const hasExecution = Boolean(execution);
  if (representative.planned || representative.recent_completion) {
    const source = representative.observer?.snapshot?.package_executions?.find((row: WireRecord) => row.package === representative.package && (!row.workspace || row.workspace === representative.workspace));
    return { ...representative, execution_summary: source ? executionSummary(source) : representative.execution_summary, run_records: runs };
  }
  const real = current.filter(record => !record.execution_record).sort((a,b)=>Number(activeRun(b))-Number(activeRun(a)) || Number(b.is_current_assignment===true)-Number(a.is_current_assignment===true) || (Date.parse(b.timing?.started_at)||0)-(Date.parse(a.timing?.started_at)||0));
  const detail = real[0] ?? representative;
  const needsAttention = Boolean(summary?.attention) || current.some(record => attention(record)) || (summary ? list(summary.waves).some(waveNeedsAttention) : false);
  const visibility = execution?.package_visibility ?? execution?.visibility;
  const active = visibility ? visibility === 'active' : current.some(record => !record.execution_record && activeRun(record)) || hasExecution && !['complete','planned'].includes(summary?.phase);
  return { ...representative, ...(execution ?? {}), ...detail, key: packageKey(representative), package_aggregate: true, run_records: runs,
    run_keys: records.flatMap(record => [record.key, ...(record.run_keys ?? [])]).filter(Boolean), execution_summary: summary,
    aggregate_active: active, aggregate_attention: needsAttention,
    conditions: current.flatMap(record => list(record.conditions)), incidents: current.flatMap(record => list(record.incidents)),
    source_paths: [...new Set(records.flatMap(record => Array.isArray(record.source_paths) ? record.source_paths : []))],
    coverage: summary?.coverage ?? representative.coverage,
    activity: summary ? phaseLabel(summary.phase) : detail.activity,
  };
}

export function packageMatchesKey(record: WireRecord, key: string | undefined): boolean {
  if (!key) return false;
  if (record.key === key || record.run_keys?.includes(key)) return true;
  try { const parsed = JSON.parse(key); return Array.isArray(parsed) && parsed.length >= 3 && parsed[0] === record.workspace && parsed[1] === record.package && parsed[2] !== 'recent-completion' && !record.recent_completion; } catch { return false; }
}
export function resolvePackageRecord(records: WireRecord[], key: string | undefined): WireRecord | null {
  return records.find(record => record.key === key) ?? records.find(record => packageMatchesKey(record, key)) ?? null;
}
export const recordedRuns = (record: WireRecord): WireRecord[] => Array.isArray(record.run_records) ? record.run_records : record.execution_record ? [] : [record];
// Package timing can be repeated on every receipt. Attempt ownership comes
// from the recorded attempt identity, never from whichever receipt exposed it.
export function packageAttempts(record: WireRecord): WireRecord[] {
  const unique = new Map<string, WireRecord>();
  for (const run of recordedRuns(record).length ? recordedRuns(record) : [record]) for (const attempt of list(run.timing?.attempts)) {
    const identity = JSON.stringify([attempt.run_id, attempt.assignment_id, attempt.step, attempt.wave_id, attempt.phase, attempt.subject_kind, attempt.started_at, attempt.attempt_kind, attempt.attempt ?? attempt.n]);
    if (!unique.has(identity)) unique.set(identity, attempt);
  }
  return [...unique.values()];
}
export function stepRuns(record: WireRecord, step: WireRecord): WireRecord[] {
  const attempts = stepAttempts(record, step);
  return recordedRuns(record).filter(run => Boolean(step.run_id) && (run.run_id === step.run_id || run.assignment_id === step.run_id)
    || attempts.some(attempt => Boolean(attempt.run_id) && attempt.run_id === run.run_id || Boolean(attempt.assignment_id) && attempt.assignment_id === run.assignment_id));
}
export function stepAttempts(record: WireRecord, step: WireRecord): WireRecord[] {
  return packageAttempts(record).filter(attempt => attempt.subject_kind !== 'candidate' && attempt.step != null && Number(attempt.step) === Number(step.step));
}
