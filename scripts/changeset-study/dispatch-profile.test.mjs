// Run: node --test scripts/changeset-study/dispatch-profile.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDispatchProfile } from './dispatch-profile.mjs';
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
    { optimization: 'none' }, { queryMode: 'discovery' }, { strategy: 'focused-dispatch' }])
    assert.throws(() => resolveDispatchProfile({ ...route, ...change }), /requires/);
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
