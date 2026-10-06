import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Local ledger aggregation only: no service requests, source reads or credentials.
export async function decisionReport({ repo, since, directory = process.env.JEV_STATE_DIR ?? join(homedir(), '.agents/scripts/jev/state') } = {}) {
  const after = since ? Date.parse(since) : Date.now() - 7 * 86400000;
  if (!Number.isFinite(after)) throw new Error('Invalid report start time.');
  const repoHash = repo ? createHash('sha256').update(repo).digest('hex') : null;
  const counts = { recommendation: 0, uncertain: 0, unavailable: 0 }, tasks = {}, reasons = {}, outcomes = {};
  let total = 0, malformed = 0, files = 0, elapsed = 0;
  const seen = new Set();
  for (const name of ['decisions.jsonl.previous', 'decisions.jsonl']) {
    let text;
    try {
      if ((await stat(join(directory, name))).size > 2 * 1024 * 1024) throw new Error('Decision ledger exceeds report limit.');
      text = await readFile(join(directory, name), 'utf8'); files++;
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { malformed++; continue; }
      if (!row || typeof row.decision_id !== 'string' || !Number.isFinite(Date.parse(row.time)) ||
          !Object.hasOwn(counts, row.status) || typeof row.task !== 'string' ||
          !Array.isArray(row.uncertainty) || !row.uncertainty.every(x => typeof x === 'string') ||
          !Number.isFinite(row.latency_ms) || row.latency_ms < 0) { malformed++; continue; }
      if (Date.parse(row.time) < after || (repoHash && row.repository_hash !== repoHash) || seen.has(row.decision_id)) continue;
      seen.add(row.decision_id); total++; counts[row.status]++; elapsed += row.latency_ms;
      tasks[row.task] = (tasks[row.task] ?? 0) + 1;
      for (const reason of new Set(row.uncertainty)) reasons[reason] = (reasons[reason] ?? 0) + 1;
      const outcome = ['pending', 'accepted', 'overridden'].includes(row.outcome) ? row.outcome : 'unknown';
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
  }
  return { schema_version: 1, status: files ? 'available' : 'unavailable', since: new Date(after).toISOString(),
    scope: repo ? 'specified_repository_path' : 'all_recorded_repositories', calls: total, statuses: counts, tasks,
    uncertainty: reasons, caller_reported_outcomes: outcomes, mean_latency_ms: total ? Math.round(elapsed / total) : null,
    malformed_rows: malformed, coverage: 'retained_local_ledgers_only', savings: 'not_measured' };
}
