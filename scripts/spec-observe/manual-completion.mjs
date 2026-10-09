// Operator lifecycle decisions are separate from worker and acceptance evidence.
import { randomUUID } from 'node:crypto';
import { lstat, realpath, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedJson } from './merge-reconciliation.mjs';

export const COMPLETION_FILE = 'sentinel-completion.json';
export const readManualCompletion = root => boundedJson(join(root, COMPLETION_FILE), root);

export function manualCompletion(record, root, revision, now = Date.now(), dispatches = []) {
  if (![1, 2].includes(record?.schema_version) || record.kind !== 'manual_completion'
    || record.package !== root
    || !Number.isFinite(Date.parse(record.completed_at)) || Date.parse(record.completed_at) > now) return null;
  // Retain old revision-bound records. New operator overrides survive checkpoint
  // and receipt updates; only a dispatch started after the decision reopens work.
  if (record.schema_version === 1 && (!revision || record.revision !== revision)) return null;
  if (record.schema_version === 2 && dispatches.some(start => Date.parse(start) > Date.parse(record.completed_at))) return null;
  return { completed_at: record.completed_at, completion_basis: 'manual' };
}

export async function writeManualCompletion(root) {
  if (await realpath(root) !== root) throw Error('Invalid completion target');
  const path = join(root, COMPLETION_FILE);
  try {
    if (!(await lstat(path)).isFile()) throw Error('Completion path is not a regular file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const record = { schema_version: 2, kind: 'manual_completion', package: root,
    completed_at: new Date().toISOString() };
  const temporary = join(root, `.sentinel-completion-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record, null, 2) + '\n'); }
    finally { await file.close(); }
    if (await realpath(root) !== root) throw Error('Package changed');
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
  return record;
}

// Reflect confirmed disk writes immediately, without editing observer exports.
export async function applyManualCompletions(state) {
  const packages = [...new Set(state.observers.flatMap(o => (o.snapshot?.runs ?? []).map(r => r.package)))].slice(0, 200);
  const records = new Map();
  for (const root of packages) if (typeof root === 'string') records.set(root, await readManualCompletion(root));
  for (const observer of state.observers) {
    const snapshot = observer.snapshot;
    if (!snapshot) continue;
    const completed = new Map();
    for (const run of snapshot.runs) {
      const completion = manualCompletion(records.get(run.package), run.package, run.completion_revision, Date.now(),
        (run.timing?.attempts ?? []).map(attempt => attempt.started_at));
      if (completion && run.is_current_assignment === true) completed.set(run.package,
        { ...run, ...completion, workflow_state: 'complete', is_current_assignment: false });
    }
    snapshot.runs = snapshot.runs.filter(run => !completed.has(run.package));
    const history = [...(snapshot.recently_completed ?? []).filter(run => !completed.has(run.package)), ...completed.values()]
      .filter(run => Date.parse(run.completed_at) >= Date.now() - 7 * 24 * 60 * 60 * 1000)
      .sort((a,b) => Date.parse(b.completed_at) - Date.parse(a.completed_at));
    snapshot.recently_completed = history.slice(0, 50);
    if (history.length > 50) snapshot.completion_history = { ...snapshot.completion_history,
      omitted: (snapshot.completion_history?.omitted ?? 0) + history.length - 50 };
  }
  return state;
}
