import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget } from '../../../changeset/models.mjs';
import { Client } from '../../client.mjs';
import { installReservationGuard, readLedger } from './guard.mjs';
import { schedule, trialJob } from './runner.mjs';

// node --test --test-name-pattern='reservation guard' scripts/changeset-study/divergent/combined-dispatch/runner.test.mjs
test('reservation guard counts unknown exposure and registry failure blocks transport while retaining the global hold', async () => {
  const root = mkdtempSync(join(tmpdir(), 'combined-cap-')), ledger = join(root, 'budget.json'), registry = join(root, 'reservations.json');
  let restore = () => {};
  try {
    writeFileSync(ledger, JSON.stringify({ schema_version: 1, limit_usd: 50, entries: [] })); writeFileSync(registry, '[]');
    const budget = new Budget(ledger, 50), id = budget.reserve('deepseek/deepseek-flash:off', 1.999); budget.settle(id, null);
    writeFileSync(registry, JSON.stringify([{ id, selector: 'deepseek/deepseek-flash:off', reserved_usd: 1.999 }]));
    restore = installReservationGuard({ Budget, ledger, registry, limit: 2, maxReservations: 107 });
    assert.throws(() => budget.reserve('deepseek/deepseek-flash:off', .01), /COMPARISON_BUDGET_STOP/);
    assert.equal(readLedger(ledger).state.entries.length, 1); restore();
    writeFileSync(registry, '[]');
    const orphaned = [];
    restore = installReservationGuard({ Budget, ledger, registry, maxReservations: 107, persist: () => { throw new Error('disk write failed'); }, onPersistenceFailure: entry => orphaned.push(entry) });
    let submitted = false;
    const client = new Client({ runtime: { getModel: () => ({ cost: { input: .3, output: 1.2 } }), hasConfiguredAuth: () => true,
      completeSimple: async () => { submitted = true; throw new Error('Must not submit'); } }, selector: 'deepseek/deepseek-flash:off', ledger,
      receiptPath: join(root, 'receipts.jsonl'), maxTokens: 32000 });
    await assert.rejects(client.text('system', 'input', 'editor'), /COMPARISON_REGISTRY_FATAL/);
    assert.equal(submitted, false); assert.equal(client.calls, 0);
    const held = readLedger(ledger).state.entries; assert.equal(held.length, 2); assert.equal(held[1].status, 'reserved'); assert.ok(held[1].reserved_usd > 0);
    assert.equal(orphaned[0].id, held[1].id); assert.equal(orphaned[0].reserved_usd, held[1].reserved_usd);
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

// node --test --test-name-pattern='alternating' scripts/changeset-study/divergent/combined-dispatch/runner.test.mjs
test('six alternating trial jobs preserve the exact same source plan, brief and original limits in both arms', () => {
  assert.deepEqual(schedule().map(row => row.arm), ['baseline', 'combined', 'combined', 'baseline', 'baseline', 'combined']);
  assert.equal(schedule().length, 6);
  const root = mkdtempSync(join(tmpdir(), 'combined-jobs-'));
  try {
    const [baseline, combined] = schedule(), path = join(root, 'inputs', baseline.source_cell); mkdirSync(path, { recursive: true });
    const task = { id: baseline.task, files: { 'source.mjs': 'export const value = 1;\n' }, limits: { model_calls: 96, max_output_tokens: 32000, cell_ms: 1200000 } };
    const plan = { schema_version: 1, operations: [{ id: 'original' }] };
    writeFileSync(join(path, 'job.json'), JSON.stringify({ task, plannerPrompt: 'retained prompt' }));
    writeFileSync(join(path, 'raw-plan.json'), JSON.stringify(plan)); writeFileSync(join(path, 'implementation-brief.md'), 'Exact brief bytes\n');
    const manifest = { ledger: join(root, 'budget.json'), dependencies: { path: 'dependencies/0', target: '/node_modules' }, source_run: '18-smaller-regions',
      cells: [{ name: baseline.source_cell, artifacts: { 'raw-plan.json': 'plan-hash', 'result.json': 'result-hash' } }] };
    const first = trialJob(root, manifest, baseline), second = trialJob(root, manifest, combined);
    for (const key of ['task', 'preparedPlan', 'preparedBrief', 'planningSource', 'briefSource', 'mounts', 'editorSelector', 'writerRecoverySelector']) assert.deepEqual(first[key], second[key]);
    assert.deepEqual(first.task, task); assert.deepEqual(first.preparedPlan, plan); assert.equal(first.preparedBrief, 'Exact brief bytes\n');
    assert.equal(first.optimization, 'none'); assert.equal(first.dispatchProfile, null);
    assert.equal(second.optimization, 'contextual'); assert.equal(second.dispatchProfile, 'optimized-v4a');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// node --test --test-name-pattern='ledger schema' scripts/changeset-study/divergent/combined-dispatch/runner.test.mjs
test('ledger schema rejects fake free unknown holds but accepts explicitly priced zero charges', () => {
  const root = mkdtempSync(join(tmpdir(), 'combined-ledger-')), ledger = join(root, 'budget.json');
  try {
    const entry = { id: 'hold', selector: 'typesafe/jev-latest', status: 'unknown', reserved_usd: .1, charged_usd: 0 };
    writeFileSync(ledger, JSON.stringify({ schema_version: 1, limit_usd: 50, entries: [entry] }));
    assert.throws(() => readLedger(ledger), /integrity/);
    entry.status = 'priced'; writeFileSync(ledger, JSON.stringify({ schema_version: 1, limit_usd: 50, entries: [entry] }));
    assert.equal(readLedger(ledger).state.entries[0].charged_usd, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
