import { performance } from 'node:perf_hooks';
import { compile } from '../changeset/engine.mjs';
import { hash } from '../changeset/workspace.mjs';
import { validateStrategyPlan } from './strategies.mjs';
import { preflightFocusedPlan } from './focused-editors.mjs';
import { optimizePlan, pruneDeclaredDependencies } from './optimizer.mjs';
import { routeContext } from './context-router.mjs';
import { resolveDispatchOptions } from './dispatch-profile.mjs';

// Callable preprocessing boundary for a DeepSeek owner submitting Sol's settled
// packets. This returns a plan; it does not execute writers or modify files.
export async function preprocessChangeset(plan, files, { ledger, signal, library, parse, artifactDirectory, options = null, strategy = 'owner-query-writer',
  protectedPaths = [], stage = async (_name, run) => run(), beforeRouting = () => {}, onRouting = () => {} } = {}) {
  const start = performance.now(), inputHash = hash(JSON.stringify(plan)), resolved = resolveDispatchOptions(options);
  const check = candidate => {
    validateStrategyPlan(strategy, candidate);
    for (const operation of compile(candidate)) if (operation.writes.some(path => protectedPaths.includes(path)))
      throw new Error(`Changeset writes a protected path: ${operation.id}`);
    const errors = preflightFocusedPlan(candidate, files, { parse });
    if (errors.length) throw new Error('Changeset preprocessing rejected source bindings: ' + errors.join('; '));
  };
  check(plan);
  let pruned = null;
  if (resolved.prune_dependencies) {
    ({ plan, removed: pruned } = pruneDeclaredDependencies(plan));
    check(plan);
  }
  if (signal?.aborted) throw new Error('Execution aborted');
  let routing;
  if (resolved.advice === 'none') {
    routing = { mergeChoices: {}, contextChoices: {}, attempted: false, fallback: 'advice-disabled', requests_started: 0,
      actual_model: null, reservation_attempted: false, estimated_usd: 0, charge_status: 'not-sent', elapsed_ms: 0 };
    onRouting(routing);
  } else {
    beforeRouting();
    try { routing = await stage('context-routing', () => routeContext(plan, files, { ledger, signal, library, artifactDirectory })); }
    catch (error) { if (error.routing) onRouting(error.routing); throw error; }
    onRouting(routing);
  }
  if (signal?.aborted) throw new Error('Execution aborted');
  const optimized = await stage('optimization', () => optimizePlan(plan, files, { mode: 'contextual', ...routing }));
  check(optimized.plan);
  if (pruned) optimized.metrics.pruned_dependencies = pruned;
  return { ...optimized, routing, options: resolved, input_hash: inputHash, output_hash: hash(JSON.stringify(optimized.plan)),
    elapsed_ms: performance.now() - start };
}
