import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';

// Read summaries, never model payloads. Missing/corrupt observations stay visible
// rather than becoming zero usage or successful execution.
export async function changesetMetrics(packageDir, { runIds = null, maxEdits = 2000 } = {}) {
  const root = join(packageDir, 'runtime/runs'), edits = [], gaps = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { edits, gaps, totals: {}, coverage: 'no-edit-records' }; throw error; }
  for (const entry of entries.filter(entry => entry.name.endsWith('-edits'))) {
    const runId = entry.name.slice(0, -6);
    if (runIds && !runIds.includes(runId)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) { gaps.push({ path: entry.name, reason: 'invalid-edit-directory' }); continue; }
    for (const child of await readdir(join(root, entry.name), { withFileTypes: true })) {
      if (edits.length >= maxEdits) { gaps.push({ reason: 'edit-limit', limit: maxEdits }); break; }
      const file = join(root, entry.name, child.name, 'summary.json');
      try {
        if (!child.isDirectory() || child.isSymbolicLink()) throw new Error('Invalid edit directory');
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('Invalid edit summary file');
        const summary = JSON.parse(await readFile(file, 'utf8'));
        if (summary.schema_version !== 1 || summary.run_id !== runId || summary.edit_id !== child.name || !Array.isArray(summary.calls)) throw new Error('Invalid edit identity');
        const byStage = {};
        for (const call of summary.calls) {
          const key = `${call.stage}:${call.selector}`;
          const group = byStage[key] ??= { stage: call.stage, selector: call.selector, calls: 0, unknown_usage: 0,
            input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, known_cost_usd: 0, unknown_cost_calls: 0, failures: 0 };
          group.calls++; group.failures += ['failed', 'cancelled', 'incomplete'].includes(call.status) ? 1 : 0;
          if (!['input', 'output'].every(key => Number.isFinite(call.usage?.[key]))) group.unknown_usage++;
          for (const [field, source] of [['input_tokens', 'input'], ['output_tokens', 'output'], ['cache_read_tokens', 'cacheRead']])
            if (Number.isFinite(call.usage?.[source])) group[field] += call.usage[source];
          if (Number.isFinite(call.usage?.cost?.total)) group.known_cost_usd += call.usage.cost.total;
          else group.unknown_cost_calls++;
        }
        edits.push({ edit_id: summary.edit_id, run_id: runId, workflow_id: summary.workflow_id, wave_id: summary.wave_id,
          assignment_id: summary.assignment_id, generation: summary.generation, wave_attempt_id: summary.wave_attempt_id,
          stage: summary.stage, stage_kind: summary.stage_kind, stage_label: summary.stage_label, review_round: summary.review_round,
          status: summary.status, publication: summary.publication, failure_phase: summary.failure_phase ?? null,
          requires_reconciliation: summary.requires_reconciliation ?? false, requires_cancellation: summary.requires_cancellation ?? false,
          owner_model: summary.owner_model, planner_model: summary.planner_model, editor_model: summary.editor_model,
          started_at: summary.started_at, elapsed_ms: summary.elapsed_ms ?? null, planning_ms: summary.planning_ms ?? null,
          execution_ms: summary.execution_ms ?? null, publication_ms: summary.publication_ms ?? null,
          changed_paths: summary.changed_paths ?? [], observation_errors: summary.observation_errors ?? [],
          artifact: relative(packageDir, file), models: Object.values(byStage) });
      } catch (error) { gaps.push({ path: relative(packageDir, file), reason: error.message }); }
    }
  }
  const totals = { edits: edits.length, applied: 0, failed: 0, cancelled: 0, running: 0, published: 0,
    writer_calls: 0, planner_calls: 0, unknown_usage_calls: 0, known_cost_usd: 0, unknown_cost_calls: 0 };
  for (const edit of edits) {
    if (Object.hasOwn(totals, edit.status)) totals[edit.status]++;
    if (edit.publication === 'published') totals.published++;
    for (const model of edit.models) {
      totals[model.stage === 'planning' ? 'planner_calls' : 'writer_calls'] += model.calls;
      totals.unknown_usage_calls += model.unknown_usage; totals.known_cost_usd += model.known_cost_usd;
      totals.unknown_cost_calls += model.unknown_cost_calls;
    }
  }
  return { schema_version: 1, edits, totals, gaps, coverage: gaps.length ? 'partial' : 'recorded-summaries',
    limits: ['Applied and published describe file application, not behavioral verification or independent review.',
      'Native planner usage can overlap native session metrics; do not add these totals to native totals.',
      'Known costs can be partial; missing usage or cost is explicitly counted. Stage times overlap concurrent calls.'] };
}
