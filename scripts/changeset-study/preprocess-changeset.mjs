import { performance } from 'node:perf_hooks';
import { compile } from '../changeset/engine.mjs';
import { hash } from '../changeset/workspace.mjs';
import { validateStrategyPlan } from './strategies.mjs';
import { preflightFocusedPlan } from './focused-editors.mjs';
import { optimizePlan } from './optimizer.mjs';
import { routeContext } from './context-router.mjs';

// Callable preprocessing boundary for a DeepSeek owner submitting Sol's settled
// packets. This returns a plan; it does not execute writers or modify files.
export async function preprocessChangeset(plan, files, { ledger, signal, library, parse, artifactDirectory,
  protectedPaths = [], stage = async (_name, run) => run(), beforeRouting = () => {}, onRouting = () => {} } = {}) {
  const start = performance.now(), inputHash = hash(JSON.stringify(plan));
  const check = candidate => {
    validateStrategyPlan('owner-query-writer', candidate);
    for (const operation of compile(candidate)) if (operation.writes.some(path => protectedPaths.includes(path)))
      throw new Error(`Changeset writes a protected path: ${operation.id}`);
    const errors = preflightFocusedPlan(candidate, files, { parse });
    if (errors.length) throw new Error('Changeset preprocessing rejected source bindings: ' + errors.join('; '));
  };
  check(plan);
  if (signal?.aborted) throw new Error('Execution aborted');
  beforeRouting();
  let routing;
  try { routing = await stage('context-routing', () => routeContext(plan, files, { ledger, signal, library, artifactDirectory })); }
  catch (error) { if (error.routing) onRouting(error.routing); throw error; }
  onRouting(routing);
  if (signal?.aborted) throw new Error('Execution aborted');
  const optimized = await stage('optimization', () => optimizePlan(plan, files, { mode: 'contextual', ...routing }));
  check(optimized.plan);
  return { ...optimized, routing, input_hash: inputHash, output_hash: hash(JSON.stringify(optimized.plan)),
    elapsed_ms: performance.now() - start };
}
