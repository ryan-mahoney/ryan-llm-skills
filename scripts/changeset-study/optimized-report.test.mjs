// node --test scripts/changeset-study/optimized-report.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../changeset/workspace.mjs';
import { buildReport, markdown } from './optimized-report.mjs';

// A costly failed donor check must never be charged to replay planning. External
// failures remain visible even when successful application qualifies writer timing.
test('replays allocate only frozen planning and compare matched completed writers', () => {
  const root = mkdtempSync(join(tmpdir(), 'optimized-report-'));
  const sol = 'openai-codex/gpt-6.1-sol:low', ds = 'deepseek/deepseek-flash';
  const plan = { operations: [{ id: 'one' }] }, brief = 'Retain all required behavior.\n';
  const write = (p, value) => writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  function trial(name, mode, source = null, extra = {}) {
    const run = join(root, name), dir = join(run, '000-case'); mkdirSync(dir, { recursive: true });
    write(join(run, 'manifest.json'), { strategy: 'owner-query-writer', selector: sol, editor_selector: ds,
      optimization: mode, schedule: ['case', 'pending'], plans_from: source?.run ?? null });
    write(join(dir, 'candidate.json'), '{}'); write(join(dir, 'raw-plan.json'), plan); write(join(dir, 'plan-0.json'), plan);
    write(join(dir, 'implementation-brief.md'), brief); write(join(dir, 'job.json'), { planningSource: source });
    const stages = source ? ['editor'] : ['implementation-planning', 'discovery-planning', 'editor'];
    const requests = stages.map((stage, i) => ({ stage, selector: stage === 'discovery-planning' ? sol : ds, reservation: `${name}-${i}` }));
    const receipts = requests.map(q => ({ ...q, elapsed_ms: 1000, usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0.01 } } }));
    write(join(dir, 'requests.jsonl'), requests.map(JSON.stringify).join('\n')); write(join(dir, 'receipts.jsonl'), receipts.map(JSON.stringify).join('\n'));
    const r = { task: 'case', task_hash: 'same-task', selector: sol, editor_selector: ds, optimization: mode, planning_source: source,
      process_elapsed_ms: source ? 50000 : 700000, implementation_brief_hash: hash(brief), candidate_hash: hash('{}'),
      accepted: false, hidden_pass: false, visible_accepted: false, checks: [{ visible: { ok: false, candidate_tests: [{ ok: true }] } }],
      executions: [{ ok: true, plan_sha256: hash(JSON.stringify(plan)), operations: [{ status: 'passed', executor: 'simple' }] }],
      stages: [{ name: 'implementation-planning', elapsed_ms: source ? 0 : 10000 }, { name: 'discovery-planning', elapsed_ms: source ? 0 : 20000 },
        { name: 'execution', elapsed_ms: source ? 30000 : 100000 }, { name: 'visible-check', elapsed_ms: source ? 1000 : 500000 }], ...extra };
    write(join(dir, 'result.json'), r);
    return { run: name, cell: '000-case', plan_hash: hash(readFileSync(join(dir, 'raw-plan.json'))), result_hash: hash(readFileSync(join(dir, 'result.json'))) };
  }
  try {
    const source = trial('donor', 'none'); trial('replay', 'deterministic', source, {
      process_elapsed_ms: 150000, stages: [{ name: 'execution', elapsed_ms: 30000 }, { name: 'optimization', elapsed_ms: 80000 }, { name: 'visible-check', elapsed_ms: 1000 }] });
    trial('contextual-failed', 'contextual', source, { executions: [{ ok: false, plan_sha256: hash(JSON.stringify(plan)), operations: [] }],
      checks: [{ visible: { ok: false, base_ok: true, candidate_tests: [{ ok: false }] } }],
      routing: { attempted: true, answer: { ok: true, usage: { input_tokens: 6, output_tokens: 1 } }, spend: { estimatedUsd: 0.002 } } });
    let report = buildReport(root), replay = report.runs.find(r => r.run === 'replay').cells[0];
    assert.equal(replay.integrity_valid, true);
    assert.equal(replay.incurred.seconds, 150); assert.equal(replay.allocated.seconds, 180);
    assert.equal(replay.incurred.model_usage.calls, 1); assert.equal(replay.allocated.model_usage.calls, 3);
    assert.equal(replay.allocated.model_usage.tokens.totalTokens, 15);
    assert.equal(replay.application_complete, true); assert.equal(replay.downstream_failures.external, true);
    const failed = report.runs.find(r => r.run === 'contextual-failed').cells[0];
    assert.equal(failed.incurred.jev.calls, 1); assert.equal(failed.incurred.jev.tokens, 7);
    assert.equal(failed.incurred.jev.estimated_usd, 0.002);
    assert.equal(failed.downstream_failures.visible, false); assert.equal(failed.downstream_failures.candidate, true);
    assert.equal(failed.application_complete, false);
    assert.equal(report.ablations[0].eligible, true); assert.deepEqual(report.runs[0].pending, ['pending']);
    assert.equal(report.recommendation.matched_comparisons.length, 0, 'pending cases prevent complete-configuration recommendation');
    for (const name of ['donor', 'replay']) { const p = join(root, name, 'manifest.json'); const m = JSON.parse(readFileSync(p)); m.schedule = ['case']; write(p, m); }
    report = buildReport(root);
    assert.equal(replay.phase_seconds.writing, 30);
    assert.equal(replay.writing_pipeline_seconds, 110);
    assert.equal(report.recommendation.matched_comparisons[0].faster_writing_pipeline, 'donor', 'optimizer overhead can reverse a pure writer speed win');
    assert.ok(!JSON.stringify(report).includes(root)); assert.match(markdown(report), /historical; unmatched/);
    write(join(root, 'replay', '000-case', 'candidate.json'), '{"tampered":true}');
    report = buildReport(root);
    assert.equal(report.runs.find(r => r.run === 'replay').cells[0].integrity_valid, false);
    assert.equal(report.recommendation.matched_comparisons.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
