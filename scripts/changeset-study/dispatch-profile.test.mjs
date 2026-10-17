// Run: node --test scripts/changeset-study/dispatch-profile.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDispatchProfile, leanDispatchOptions } from './dispatch-profile.mjs';
import { resolveQueryGranularity, queryAssignmentBudget } from './roles.mjs';
import { preprocessChangeset } from './preprocess-changeset.mjs';

const route = { dispatchProfile: 'optimized-v4a', strategy: 'owner-query-writer',
  selector: 'openai-codex/gpt-6.1-sol:low', editorSelector: 'deepseek/deepseek-flash:off' };

test('combined profile keeps explicit roles and reserves routing without relabeling historical plans', () => {
  const profile = resolveDispatchProfile(route);
  assert.equal(profile.optimization, 'contextual');
  assert.equal(profile.writerFormat, 'v4a-fallback');
  assert.equal(resolveQueryGranularity({ ...route, ...profile }), 'default');
  assert.equal(resolveQueryGranularity({ ...route, ...profile, requested: profile.queryGranularity }), 'smaller-regions');
  assert.equal(resolveDispatchProfile({}).optimization, 'none');
  for (const change of [{ editorSelector: 'openrouter/deepseek' }, { writerRecoverySelector: 'deepseek/deepseek-flash:low' },
    { optimization: 'none' }, { queryMode: 'discovery' }, { strategy: 'boundary-review' }])
    assert.throws(() => resolveDispatchProfile({ ...route, ...change }), /requires/);
  const single = resolveDispatchProfile({ ...route, strategy: 'focused-dispatch' });
  assert.equal(single.queryMode, 'discovery'); assert.equal(single.queryGranularity, null); assert.equal(single.optimization, 'contextual');
  assert.throws(() => resolveDispatchProfile({ ...route, strategy: 'focused-dispatch', queryMode: 'catalog-lookup' }), /discovery planning/);
  assert.equal(resolveDispatchProfile({ ...route, strategy: 'focused-dispatch', selector: 'deepseek/deepseek-flash:max' }).queryMode, 'discovery');
  assert.throws(() => resolveDispatchProfile({ ...route, selector: 'deepseek/deepseek-flash:max' }), /requires/, 'a DeepSeek planner is allowed only on the single-agent strategy');
  assert.throws(() => resolveQueryGranularity({ ...route, ...profile, requested: 'smaller-regions', inherited: 'default' }), /inherited plan/);
  const budget = queryAssignmentBudget({ maxCalls: 10, callsUsed: 0, queryCallsReserved: 3, routingCallsReserved: 1 });
  assert.equal(budget.max_operations, 3); assert.equal(budget.calls_used, 0); assert.equal(budget.routing_calls_reserved, 1);
});

test('preprocessing rejects protected writes before advice and never mutates its input', async () => {
  const plan = { schema_version: 1, operations: [{ id: 'change', executor: 'simple', reads: [], writes: ['keep.txt'], depends_on: [],
    objective: 'Change', instruction: 'Change source', requirements: ['Keep other content'], context: [{ path: 'keep.txt', start: null, end: null }] }] };
  const original = structuredClone(plan), files = { 'keep.txt': 'original' };
  await assert.rejects(preprocessChangeset(plan, files, { protectedPaths: ['keep.txt'],
    beforeRouting: () => { throw new Error('Advice must not run'); } }), /protected path/);
  assert.deepEqual(plan, original); assert.deepEqual(files, { 'keep.txt': 'original' });
});

// node --test --test-name-pattern='dispatch options' scripts/changeset-study/dispatch-profile.test.mjs
test('dispatch options default to the historical profile, validate strictly and select the writer format', () => {
  assert.deepEqual(resolveDispatchProfile(route).options, { advice: 'jev', writer_routing: 'v4a', prune_dependencies: false, prompt_order: 'target-first', concurrency: 4, anti_dependencies: 'serialize', seed_moves: false, seam_retry_reasoning: 'off', repair_rounds: 0 });
  assert.equal(resolveDispatchProfile({ ...route, dispatchOptions: { writer_routing: 'json' } }).writerFormat, 'json-focused');
  assert.equal(resolveDispatchProfile({ ...route, dispatchOptions: { writer_routing: 'hybrid', concurrency: 8 } }).writerFormat, 'hybrid');
  for (const bad of [{ unknown: true }, { advice: 'maybe' }, { concurrency: 0 }, { concurrency: 1.5 }, { prune_dependencies: 'yes' }])
    assert.throws(() => resolveDispatchProfile({ ...route, dispatchOptions: bad }), /dispatch option|concurrency/);
  assert.throws(() => resolveDispatchProfile({ dispatchOptions: { advice: 'none' } }), /require an optimized dispatch profile/);
  const lean = resolveDispatchProfile({ ...route, dispatchProfile: 'optimized-lean' });
  assert.deepEqual(lean.options, { ...leanDispatchOptions }); assert.equal(lean.writerFormat, 'hybrid');
  assert.equal(resolveDispatchProfile({ ...route, dispatchProfile: 'optimized-lean', dispatchOptions: { concurrency: 4 } }).options.concurrency, 4);
  assert.throws(() => resolveDispatchProfile({ ...route, dispatchProfile: 'optimized-json' }), /Unknown dispatch profile/);
  assert.equal(resolveDispatchProfile({ ...route, dispatchProfile: 'optimized-lean-repair' }).options.repair_rounds, 1);
  assert.equal(resolveDispatchProfile({ ...route, dispatchProfile: 'optimized-lean' }).options.repair_rounds, 0);
});

// node --test --test-name-pattern='disabled advice' scripts/changeset-study/dispatch-profile.test.mjs
test('disabled advice skips the routing request and pruning is recorded in the metrics', async () => {
  const op = (id, writes, reads, depends_on) => ({ id, executor: 'simple', writes, reads, depends_on, objective: id, instruction: `edit ${id}`,
    requirements: ['keep'], context: writes.map(path => ({ path, start: null, end: null })) });
  const plan = { schema_version: 1, operations: [op('a', ['x.txt'], [], []), op('b', ['y.txt'], [], ['a'])] }, files = { 'x.txt': 'x', 'y.txt': 'y' };
  const routed = [];
  const result = await preprocessChangeset(plan, files, { options: { advice: 'none', prune_dependencies: true },
    beforeRouting: () => { throw new Error('Advice must not run'); }, onRouting: routing => routed.push(routing) });
  assert.equal(routed[0].fallback, 'advice-disabled'); assert.equal(routed[0].requests_started, 0); assert.equal(result.routing.attempted, false);
  assert.deepEqual(result.metrics.pruned_dependencies, [{ from: 'b', to: 'a' }]);
  assert.deepEqual(result.plan.operations.map(o => o.depends_on), [[], []]);
  assert.deepEqual(result.options, { advice: 'none', writer_routing: 'v4a', prune_dependencies: true, prompt_order: 'target-first', concurrency: 4, anti_dependencies: 'serialize', seed_moves: false, seam_retry_reasoning: 'off', repair_rounds: 0 });
});
