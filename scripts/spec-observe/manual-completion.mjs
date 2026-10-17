// Operator lifecycle decisions are separate from worker and acceptance evidence.
import { randomUUID } from 'node:crypto';
import { lstat, realpath, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedJson } from './merge-reconciliation.mjs';

export const COMPLETION_FILE = 'sentinel-completion.json';
export const readManualCompletion = root => boundedJson(join(root, COMPLETION_FILE), root);

// `package` keeps the absolute directory on the writing machine, so the reference
// identifies the package; records written before the reference existed match by path.
export function manualCompletion(record, { ref, root }, revision, now = Date.now(), dispatches = []) {
  if (![1, 2].includes(record?.schema_version) || record.kind !== 'manual_completion'
    || !(typeof ref === 'string' && record.package_ref === ref || record.package === root)
    || !Number.isFinite(Date.parse(record.completed_at)) || Date.parse(record.completed_at) > now) return null;
  // Retain old revision-bound records. New operator overrides survive checkpoint
  // and receipt updates; only a dispatch started after the decision reopens work.
  if (record.schema_version === 1 && (!revision || record.revision !== revision)) return null;
  if (record.schema_version === 2 && dispatches.some(start => Date.parse(start) > Date.parse(record.completed_at))) return null;
  return { completed_at: record.completed_at, completion_basis: 'manual' };
}

export async function writeManualCompletion(root, ref) {
  if (await realpath(root) !== root) throw Error('Invalid completion target');
  const path = join(root, COMPLETION_FILE);
  try {
    if (!(await lstat(path)).isFile()) throw Error('Completion path is not a regular file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const record = { schema_version: 2, kind: 'manual_completion', package_ref: ref, package: root,
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
  const packages = [...new Set(state.observers.flatMap(o => [...(o.snapshot?.runs ?? []), ...(o.snapshot?.package_executions ?? [])].map(r => r.package)))].slice(0, 200);
  const records = new Map();
  for (const root of packages) if (typeof root === 'string') records.set(root, await readManualCompletion(root));
  for (const observer of state.observers) {
    const snapshot = observer.snapshot;
    if (!snapshot) continue;
    const completed = new Map();
    const dispatches = new Map();
    for (const row of [...(snapshot.runs ?? []), ...(snapshot.package_executions ?? [])]) {
      const values = dispatches.get(row.package) ?? [];
      values.push(...(row.timing?.attempts ?? []).map(attempt => attempt.started_at));
      dispatches.set(row.package, values);
    }
    for (const run of [...(snapshot.runs ?? []), ...(snapshot.package_executions ?? [])]) {
      const completion = manualCompletion(records.get(run.package), { ref: run.package_ref, root: run.package }, run.completion_revision, Date.now(),
        dispatches.get(run.package) ?? []);
      if (completion && !completed.has(run.package) && (run.is_current_assignment === true || run.execution_summary && run.execution_summary.phase !== 'planned')) completed.set(run.package,
        { ...run, ...completion, workflow_state: 'complete', is_current_assignment: false });
    }
    snapshot.runs = (snapshot.runs ?? []).filter(run => !completed.has(run.package));
    for (const row of snapshot.package_executions ?? []) if (completed.has(row.package)) {
      const completion = completed.get(row.package);
      row.completed_at = completion.completed_at; row.completion_basis = completion.completion_basis;
      row.visibility = 'recently_completed';
      row.execution_summary = { ...row.execution_summary, phase: 'complete', attention: false };
    }
    for (const epic of snapshot.epics ?? []) {
      for (const member of epic.members ?? []) if (completed.has(member.package)) {
        const old = member.status === 'in-progress' ? 'in_progress' : member.status;
        if (epic.summary && member.status !== 'complete') {
          if (typeof epic.summary[old] === 'number') epic.summary[old]--;
          epic.summary.complete++;
          if (member.attention) epic.summary.attention--;
        }
        member.status = 'complete'; member.attention = false; member.waiting_on = []; member.completed_at = completed.get(member.package).completed_at;
        if (member.execution_summary) member.execution_summary = { ...member.execution_summary, phase: 'complete', attention: false };
      }
      for (const member of epic.members ?? []) member.waiting_on = (member.waiting_on ?? []).filter(name => !epic.members.some(other => other.name === name && ['complete', 'merged'].includes(other.status)));
      epic.next = epic.members?.find(member => ['proposed', 'prepared'].includes(member.status) && !member.waiting_on.length)?.name ?? null;
    }
    const history = [...(snapshot.recently_completed ?? []).filter(run => !completed.has(run.package)), ...completed.values()]
      .filter(run => Date.parse(run.completed_at) >= Date.now() - 7 * 24 * 60 * 60 * 1000)
      .sort((a,b) => Date.parse(b.completed_at) - Date.parse(a.completed_at));
    snapshot.recently_completed = history.slice(0, 50);
    if (history.length > 50) snapshot.completion_history = { ...snapshot.completion_history,
      omitted: (snapshot.completion_history?.omitted ?? 0) + history.length - 50 };
  }
  return state;
}
