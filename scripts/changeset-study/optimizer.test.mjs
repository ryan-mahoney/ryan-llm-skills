// node --test scripts/changeset-study/optimizer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizePlan } from './optimizer.mjs';
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
