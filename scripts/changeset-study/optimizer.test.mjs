// node --test scripts/changeset-study/optimizer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizePlan, pruneDeclaredDependencies } from './optimizer.mjs';
import { compile } from '../changeset/engine.mjs';
import { routeContext } from './context-router.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const packet = (id, path = 'a.txt', depends_on = []) => ({ id, executor: 'simple', reads: [], writes: [path], depends_on,
  objective: `Add ${id}`, instruction: `Append ${id}.`, requirements: ['Preserve other content.'], context: [{ path, start: null, end: null }] });
const plan = operations => ({ schema_version: 1, operations });

test('contraction retains ordered instructions, external dependencies and every consumer', () => {
  const first = { ...packet('first'), requirements: ['One.', 'Two.', 'Three.'] };
  const second = { ...packet('second', 'a.txt', ['prerequisite']), requirements: ['Four.', 'Five.', 'Six.'] };
  const p = plan([packet('prerequisite', 'b.txt'), first, second, packet('consumer', 'c.txt', ['second'])]);
  const r = optimizePlan(p, { 'a.txt': 'source', 'b.txt': 'b', 'c.txt': 'c' });
  assert.equal(r.plan.operations.length, 3);
  const merged = r.plan.operations.find(op => op.id === 'first');
  assert.deepEqual(merged.members, ['first', 'second']);
  assert.match(merged.instruction, /Append first\.[\s\S]*Append second\./);
  assert.deepEqual(merged.depends_on, ['prerequisite']);
  assert.deepEqual(compile(r.plan).at(-1).depends_on, ['first']);
  assert.equal(merged.context.length, 1);
  for (const requirement of [...first.requirements, ...second.requirements]) assert.ok(merged.requirements.join('\n').includes(requirement));
  assert.equal(p.operations.length, 4);
});

test('optimizer preserves intermediate observations, packet limits and unknown future context', () => {
  const p = plan([packet('first'), packet('observer', 'b.txt', ['first']), packet('second', 'a.txt', ['observer'])]);
  assert.equal(optimizePlan(p, { 'a.txt': 'a', 'b.txt': 'b' }).plan.operations.length, 3);
  const huge = { ...packet('second'), instruction: 'x'.repeat(3940) };
  assert.equal(optimizePlan(plan([packet('first'), huge]), { 'a.txt': 'a' }).plan.operations.length, 2);
  const future = { ...packet('second'), context: [{ path: 'a.txt', start: 'future', end: null }] };
  assert.equal(optimizePlan(plan([packet('first'), future]), { 'a.txt': 'a' }).plan.operations.length, 2);
  const contextual = optimizePlan(plan([packet('first'), packet('second')]), { 'a.txt': 'a' }, { mode: 'contextual', mergeChoices: { 'first+second': 'separate' } });
  assert.equal(contextual.plan.operations.length, 2);
});

test('context decisions stay bounded and a failed judge retains the fixed policy with a budget hold', async () => {
  const root = mkdtempSync(join(tmpdir(), 'context-router-'));
  try {
    const result = await routeContext(plan([packet('first'), packet('second')]), { 'a.txt': 'source' }, {
      ledger: join(root, 'budget.json'), library: {
        choice: (instructions, criteria) => ({ instructions, criteria }),
        createTypeSafe: () => ({ getSpend: () => ({ usdPerMTok: 0.042, session: {} }) }),
        ask: async (_client, request) => {
          assert.equal(request.state.pairs.length, 1);
          assert.equal(request.state.packets.length, 0, 'Do not ask context questions for assignments that may merge');
          return { ok: false, errorCode: 'timeout' };
        },
      },
    });
    assert.equal(result.fallback, 'timeout'); assert.equal(result.attempted, true);
    assert.deepEqual(result.mergeChoices, {});
    const entry = JSON.parse(readFileSync(join(root, 'budget.json'))).entries[0];
    assert.equal(entry.status, 'unknown'); assert.ok(entry.reserved_usd > 0);
    const expanded = optimizePlan(plan([packet('first')]), { 'a.txt': 'x'.repeat(8001) }, { mode: 'contextual', contextChoices: { first: 'whole-small-files' } });
    assert.equal(expanded.metrics.changes.length, 0);
    const growing = plan([packet('grow', 'b.txt'), { ...packet('consume'), reads: ['b.txt'], depends_on: ['grow'], context: [{ path: 'a.txt', start: null, end: null }, { path: 'b.txt', start: 'stable', end: null }] }]);
    const bounded = optimizePlan(growing, { 'a.txt': 'a', 'b.txt': 'stable' }, { mode: 'contextual', contextChoices: { consume: 'whole-small-files' } });
    assert.equal(bounded.metrics.changes.length, 0, 'Earlier writes can grow a read file beyond the initial whole-file bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// node --test --test-name-pattern='non-adjacent' scripts/changeset-study/optimizer.test.mjs
test('non-adjacent packets on one file merge and the merged objective keeps both outcomes', () => {
  const p = plan([packet('first'), packet('other', 'b.txt'), packet('second')]);
  const r = optimizePlan(p, { 'a.txt': 'a', 'b.txt': 'b' });
  assert.equal(r.plan.operations.length, 2);
  const merged = r.plan.operations.find(op => op.id === 'first');
  assert.deepEqual(merged.members, ['first', 'second']);
  assert.equal(merged.objective, 'Add first; then Add second');
  const long = { ...packet('long'), objective: 'L'.repeat(240) };
  const clipped = optimizePlan(plan([long, packet('tail')]), { 'a.txt': 'a' }).plan.operations[0];
  assert.equal(clipped.objective.length, 240);
  assert.ok(clipped.objective.startsWith('L'.repeat(200)) && clipped.objective.endsWith('...'));
});

// node --test --test-name-pattern='dirty file' scripts/changeset-study/optimizer.test.mjs
test('a pair on a dirty file defers excerpt validation instead of checking stale text', () => {
  const future = { ...packet('third'), context: [{ path: 'a.txt', start: 'written-later', end: null }] };
  const p = plan([packet('first'), packet('second'), future]);
  // first+second is vetoed, so second+third is the only candidate and a.txt is dirty from first.
  const r = optimizePlan(p, { 'a.txt': 'a' }, { mode: 'contextual', mergeChoices: { 'first+second': 'separate' } });
  assert.equal(r.plan.operations.length, 2);
  assert.deepEqual(r.metrics.changes, [{ kind: 'merge', members: ['second', 'third'], into: 'second', deferred_excerpt_validation: ['a.txt'] }]);
  // On a clean file the same unknown anchor still refuses the merge.
  assert.equal(optimizePlan(plan([packet('first'), { ...future, id: 'second' }]), { 'a.txt': 'a' }).plan.operations.length, 2);
});

// node --test --test-name-pattern='every round' scripts/changeset-study/optimizer.test.mjs
test('every round recomputes candidates so pairs on several files all merge and context keys ignore field order', () => {
  const swapped = { ...packet('d'), context: [{ start: null, path: 'a.txt', end: null }, { path: 'a.txt', start: null, end: null }] };
  const p = plan([packet('a1'), packet('b1', 'b.txt'), packet('a2'), packet('b2', 'b.txt'), swapped]);
  const r = optimizePlan(p, { 'a.txt': 'a', 'b.txt': 'b' });
  assert.deepEqual(r.plan.operations.map(op => op.members ?? [op.id]), [['a1', 'a2'], ['b1', 'b2'], ['d']]);
  assert.equal(r.plan.operations.find(op => op.id === 'd').context.length, 1);
  assert.equal(r.metrics.after.assignments, 3);
});

// node --test --test-name-pattern='pruning drops' scripts/changeset-study/optimizer.test.mjs
test('pruning drops declared edges without file overlap and keeps every data dependency', () => {
  const op = (id, writes, reads, depends_on) => ({ id, executor: 'simple', writes, reads, depends_on, objective: id, instruction: id,
    requirements: ['keep'], context: [] });
  const plan = { schema_version: 1, operations: [op('a', ['x.mjs'], [], []), op('b', ['y.mjs'], [], ['a']), op('c', ['z.mjs'], ['x.mjs'], ['a']),
    op('d', ['y.mjs'], [], ['b']), op('e', ['w.mjs'], [], ['c'])] };
  const original = structuredClone(plan);
  const { plan: pruned, removed } = pruneDeclaredDependencies(plan);
  assert.deepEqual(removed, [{ from: 'b', to: 'a' }, { from: 'e', to: 'c' }]);
  assert.deepEqual(Object.fromEntries(pruned.operations.map(o => [o.id, o.depends_on])), { a: [], b: [], c: ['a'], d: ['b'], e: [] });
  assert.deepEqual(plan, original);
  // compile still orders every read/write overlap, so dropping sequencing edges never reorders file state.
  assert.deepEqual(compile(pruned).find(o => o.id === 'd').depends_on, ['b']);
  assert.deepEqual(compile(pruned).find(o => o.id === 'c').depends_on, ['a']);
});
