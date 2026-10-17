import { compile, execute } from './engine.mjs';
import { hash } from './workspace.mjs';
import { validateFocusedPlan, preflightFocusedPlan } from './focused-editors.mjs';
import { pruneDeclaredDependencies } from './optimizer.mjs';
import { leanDispatchOptions, resolveDispatchOptions } from './dispatch-options.mjs';
import { routeWriterFormat, seedMove, v4aEditor } from './v4a-editor.mjs';
import { patchEditor } from './strategies.mjs';

export function validateDispatchPlan(plan, workspace, { parse, paths } = {}) {
  const operations = compile(plan);
  const modelPlan = { ...plan, operations: operations.filter(op => ['simple', 'involved'].includes(op.executor)) };
  validateFocusedPlan(modelPlan);
  if (paths && operations.some(op => op.writes.some(path => !paths.includes(path))))
    throw new Error('Plan writes outside the request ownership');
  // Preflight each still-original source. Dependencies on generated source are
  // checked against the staged bytes when their operation actually executes.
  const changed = new Set();
  for (const operation of operations) {
    if (['simple', 'involved'].includes(operation.executor)) {
      const current = workspace.snapshot([...new Set([...operation.reads, ...operation.writes])].filter(path => !changed.has(path)));
      const errors = preflightFocusedPlan({ ...plan, operations: [{ ...operation, depends_on: [], context: operation.context.filter(c => !changed.has(c.path)) }] }, current, { parse });
      if (errors.length) throw new Error(errors.join('; '));
    }
    operation.writes.forEach(path => changed.add(path));
  }
  return operations;
}

// Production boundary: no benchmark setup, behavioral verification, model review,
// commit, or source publication. The managed caller owns those responsibilities.
export async function dispatchChangeset(plan, workspace, { model, retryModel = null, signal, parse, paths,
  options = {}, trace, onDraft, generate } = {}) {
  const resolved = resolveDispatchOptions({ ...leanDispatchOptions, ...options, advice: 'none', repair_rounds: 0 });
  validateDispatchPlan(plan, workspace, { parse, paths });
  const rawHash = hash(JSON.stringify(plan));
  let removed = [];
  if (resolved.prune_dependencies) ({ plan, removed } = pruneDeclaredDependencies(plan));
  validateDispatchPlan(plan, workspace, { parse, paths });
  const original = workspace.snapshot();
  trace?.artifact('plan.json', plan);
  trace?.emit('plan_validated', { raw_plan_sha256: rawHash, plan_sha256: hash(JSON.stringify(plan)),
    operations: plan.operations.length, pruned_dependencies: removed, concurrency: resolved.concurrency });
  const writer = async ({ operation, files }) => {
    const format = operation.executor === 'generated' ? 'generator' : routeWriterFormat(operation, files, resolved.writer_routing);
    const seed = resolved.seed_moves && format === 'v4a' ? seedMove(operation, files) : null;
    const began = performance.now();
    trace?.emit('operation_started', { operation_id: operation.id, format, seeded: Boolean(seed),
      reads: operation.reads, writes: operation.writes, dependencies: operation.depends_on });
    const retain = (value, status) => {
      trace?.artifact(`operation-${operation.id}.json`, { operation_id: operation.id, status, format,
        elapsed_ms: performance.now() - began, seeded: Boolean(seed), attempts: value.writer_attempts ?? [],
        fallback: value.writer_fallback ?? false, error: status === 'failed' ? value.message : null });
      trace?.emit('operation_finished', { operation_id: operation.id, status, format, seeded: Boolean(seed),
        attempts: value.writer_attempts?.length ?? 0, fallback: value.writer_fallback ?? false, elapsed_ms: performance.now() - began });
    };
    try {
      if (format !== 'generator' && !model) throw new Error('No configured writer adapter');
      if (format === 'generator' && !generate) throw new Error('No configured staged generator');
      const result = format === 'generator' ? await generate({ operation, files, signal, trace }) : format === 'v4a'
        ? await v4aEditor(model, 'writer', seed ?? { operation, files }, { contextParse: parse, promptOrder: resolved.prompt_order,
          seed, seamRetryModel: seed ? retryModel : null, original })
        : await patchEditor(model, 'writer', null, { operation, files }, { focused: true, ranges: true,
          contextParse: parse, promptOrder: resolved.prompt_order, fidelityRetryModel: retryModel, original });
      retain(result, 'passed'); return result;
    } catch (error) { retain(error, 'failed'); throw error; }
  };
  const report = await execute(plan, workspace, { concurrency: resolved.concurrency, antiDependencies: resolved.anti_dependencies,
    signal, adapters: { simple: writer, involved: writer, generated: writer }, onDraft });
  trace?.artifact('execution.json', report);
  trace?.emit('execution_finished', { ok: report.ok, ...report.metrics });
  return report;
}
