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

test('a frozen rejected planning attempt funds replay allocation without qualifying the donor dispatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'optimized-report-candidate-'));
  const sol = 'openai-codex/gpt-6.1-sol:low', ds = 'deepseek/deepseek-flash';
  const plan = { operations: [{ id: 'candidate', instruction: 'x'.repeat(2469) }] };
  const bytes = JSON.stringify(plan, null, 2), brief = 'Frozen implementation brief.\n';
  const write = (p, value) => writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  function make(name, mode, source = null) {
    const run = join(root, name), dir = join(run, '000-case'); mkdirSync(dir, { recursive: true });
    write(join(run, 'manifest.json'), { strategy: 'owner-query-writer', selector: sol, editor_selector: ds, optimization: mode,
      schedule: ['case'], plans_from: source?.run ?? null });
    write(join(dir, 'candidate.json'), '{}'); write(join(dir, 'implementation-brief.md'), brief);
    write(join(dir, 'job.json'), { planningSource: source });
    const requests = (source ? ['editor'] : ['implementation-planning', 'discovery-planning']).map((stage, i) => ({
      stage, selector: stage === 'discovery-planning' ? sol : ds, reservation: `${name}-${i}` }));
    const receipts = requests.map(q => ({ ...q, elapsed_ms: 1000, usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0.01 } } }));
    write(join(dir, 'requests.jsonl'), requests.map(JSON.stringify).join('\n'));
    write(join(dir, 'receipts.jsonl'), receipts.map(JSON.stringify).join('\n'));
    const result = { task: 'case', task_hash: 'same-task', selector: sol, editor_selector: ds, optimization: mode,
      planning_source: source, process_elapsed_ms: source ? 6000 : 50000, implementation_brief_hash: hash(brief), candidate_hash: hash('{}'),
      executions: source ? [{ ok: true, plan_sha256: hash(JSON.stringify(plan)), operations: [{ executor: 'simple', status: 'passed' }] }] : [],
      stages: source ? [{ name: 'execution', elapsed_ms: 5000 }] : [{ name: 'implementation-planning', elapsed_ms: 10000 }, { name: 'discovery-planning', elapsed_ms: 20000 }] };
    write(join(dir, 'result.json'), result);
    if (source) { write(join(dir, 'raw-plan.json'), bytes); write(join(dir, 'plan-0.json'), bytes); }
    else { write(join(dir, 'planning-attempt-0.json'), { operations: [] }); write(join(dir, 'planning-attempt-1.json'), bytes); }
    return { run: name, cell: '000-case', plan_artifact: 'planning-attempt-1.json', plan_hash: hash(bytes), result_hash: hash(readFileSync(join(dir, 'result.json'))) };
  }
  try {
    const source = make('rejected-donor', 'none');
    make('corrected-none', 'none', source); make('corrected-deterministic', 'deterministic', source);
    let report = buildReport(root);
    const donor = report.runs.find(r => r.run === 'rejected-donor').cells[0];
    const replay = report.runs.find(r => r.run === 'corrected-none').cells[0];
    assert.equal(donor.integrity_valid, false); assert.equal(donor.application_complete, false); assert.equal(donor.raw_plan_hash, null);
    assert.equal(donor.planning_origin.kind, 'undispatched-candidate-planning-attempt');
    assert.equal(donor.planning_origin.artifact, 'planning-attempt-1.json');
    assert.equal(replay.integrity_valid, true); assert.equal(replay.planning_source_valid, true);
    assert.equal(replay.planning_origin.kind, 'reused-candidate-planning-attempt');
    assert.equal(replay.planning_origin.donor_integrity_valid, false);
    assert.equal(replay.allocated.seconds, 36); assert.equal(replay.allocated.model_usage.calls, 3);
    assert.equal(report.recommendation.matched_comparisons.length, 1);
    write(join(root, 'rejected-donor', '000-case', 'planning-attempt-1.json'), '{"changed":true}');
    report = buildReport(root);
    const changed = report.runs.find(r => r.run === 'corrected-none').cells[0];
    assert.equal(changed.integrity_valid, false); assert.equal(changed.planning_source_valid, false);
    assert.equal(changed.allocated.seconds, null); assert.equal(changed.allocated.model_usage, null);
    const rp = join(root, 'corrected-none', '000-case', 'result.json'), jp = join(root, 'corrected-none', '000-case', 'job.json');
    const result = JSON.parse(readFileSync(rp)); result.planning_source.plan_artifact = '../planning-attempt-1.json';
    write(rp, result); write(jp, { planningSource: result.planning_source });
    report = buildReport(root);
    assert.equal(report.runs.find(r => r.run === 'corrected-none').cells[0].planning_source_valid, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('brief-only reuse allocates inherited owner work once while new query and catalog generation remain incurred', () => {
  const root = mkdtempSync(join(tmpdir(), 'optimized-report-brief-'));
  const sol = 'openai-codex/gpt-6.1-sol:low', ds = 'deepseek/deepseek-flash';
  const plan = { operations: [{ id: 'same-plan' }] }, brief = 'Shared owner brief.\n';
  const write = (p, value) => writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  function make(name, { briefSource = null, planningSource = null, actual = 3000, query = 100, context = 2 } = {}) {
    const run = join(root, name), dir = join(run, '000-case'); mkdirSync(dir, { recursive: true });
    write(join(run, 'manifest.json'), { strategy: 'owner-query-writer', selector: sol, editor_selector: ds, optimization: 'none', query_mode: 'catalog',
      schedule: ['case'], plans_from: planningSource?.run ?? null, briefs_from: planningSource ? null : briefSource?.run ?? null });
    write(join(dir, 'candidate.json'), '{}'); write(join(dir, 'implementation-brief.md'), brief);
    write(join(dir, 'raw-plan.json'), plan); write(join(dir, 'plan-0.json'), plan);
    write(join(dir, 'job.json'), { briefSource, planningSource });
    const stages = planningSource ? ['editor'] : briefSource ? ['planning', 'editor'] : ['implementation-planning', 'planning', 'editor'];
    const requests = stages.map((stage, i) => ({ stage, selector: stage === 'planning' ? sol : ds, reservation: `${name}-${i}` }));
    const receipts = requests.map(q => ({ ...q, elapsed_ms: 1000, usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0.01 } } }));
    write(join(dir, 'requests.jsonl'), requests.map(JSON.stringify).join('\n')); write(join(dir, 'receipts.jsonl'), receipts.map(JSON.stringify).join('\n'));
    const r = { task: 'case', task_hash: 'task', selector: sol, editor_selector: ds, optimization: 'none', query_mode: 'catalog',
      brief_source: briefSource, planning_source: planningSource, process_elapsed_ms: actual * 1000, implementation_brief_hash: hash(brief), candidate_hash: hash('{}'),
      executions: [{ ok: true, plan_sha256: hash(JSON.stringify(plan)), operations: [{ executor: 'simple', status: 'passed' }] }],
      stages: [{ name: 'implementation-planning', elapsed_ms: briefSource || planningSource ? 0 : 10000 },
        { name: 'query-context', elapsed_ms: planningSource ? 0 : context * 1000 }, { name: 'planning', elapsed_ms: planningSource ? 0 : query * 1000 },
        { name: 'execution', elapsed_ms: 5000 }, { name: 'visible-check', elapsed_ms: 6000 }] };
    write(join(dir, 'result.json'), r);
    return { run: name, cell: '000-case', brief_hash: hash(brief), result_hash: hash(readFileSync(join(dir, 'result.json'))) };
  }
  try {
    const donor = make('donor');
    const borrowed = make('catalog', { briefSource: donor, actual: 30, query: 4, context: 3 });
    make('catalog-again', { briefSource: borrowed, actual: 20, query: 2, context: 1 });
    const planSource = { run: borrowed.run, cell: borrowed.cell, result_hash: borrowed.result_hash, plan_artifact: 'raw-plan.json',
      plan_hash: hash(readFileSync(join(root, borrowed.run, borrowed.cell, 'raw-plan.json'))) };
    make('full-replay', { briefSource: borrowed, planningSource: planSource, actual: 8 });
    let report = buildReport(root), c = report.runs.find(r => r.run === 'catalog').cells[0];
    assert.equal(c.integrity_valid, true); assert.equal(c.brief_source_valid, true); assert.equal(c.owner_role_valid, true);
    assert.equal(c.borrowed_planning_scope, 'owner-only'); assert.equal(c.phase_seconds.owner, 0);
    assert.equal(c.query_context_seconds, 3); assert.equal(c.phase_seconds.query, 7);
    assert.equal(c.allocated.seconds, 40, 'only ten owner seconds are added to thirty actual seconds');
    assert.equal(c.incurred.model_usage.calls, 2); assert.equal(c.allocated.model_usage.calls, 3);
    assert.equal(c.allocated.model_usage.tokens.totalTokens, 15);
    assert.equal(c.allocated_planning.seconds, 17, 'inherited owner plus new query and context generation');
    assert.equal(c.allocated_planning.query_context_seconds, 3);
    assert.equal(c.allocated_owner.seconds, 10); assert.equal(c.allocated_owner.usage.calls, 1);
    assert.equal(c.allocated.model_usage.equivalent_usd, c.incurred.model_usage.equivalent_usd + 0.01);
    const again = report.runs.find(r => r.run === 'catalog-again').cells[0];
    assert.equal(again.allocated.seconds, 30); assert.equal(again.allocated_planning.seconds, 13);
    const replay = report.runs.find(r => r.run === 'full-replay').cells[0];
    assert.equal(replay.integrity_valid, true); assert.equal(replay.allocated.seconds, 25, 'full plan replay inherits owner plus donor query/context once');
    assert.equal(replay.allocated.model_usage.calls, 3); assert.equal(replay.allocated_planning.query_context_seconds, 3);
    const donorDir = join(root, 'donor', '000-case');
    write(join(donorDir, 'implementation-brief.md'), 'tampered');
    report = buildReport(root); c = report.runs.find(r => r.run === 'catalog').cells[0];
    assert.equal(c.brief_source_valid, false); assert.equal(c.allocated.model_usage, null);
    write(join(donorDir, 'implementation-brief.md'), brief);
    const rp = join(root, 'catalog', '000-case', 'result.json'), jp = join(root, 'catalog', '000-case', 'job.json');
    const good = JSON.parse(readFileSync(rp));
    for (const [field, value] of [['result_hash', 'wrong-result'], ['brief_hash', 'wrong-brief']]) {
      const bad = structuredClone(good); bad.brief_source[field] = value; write(rp, bad); write(jp, { briefSource: bad.brief_source });
      assert.equal(buildReport(root).runs.find(r => r.run === 'catalog').cells[0].allocated.seconds, null);
    }
    const badTask = structuredClone(good); badTask.task_hash = 'other-task'; write(rp, badTask); write(jp, { briefSource: good.brief_source });
    assert.equal(buildReport(root).runs.find(r => r.run === 'catalog').cells[0].brief_source_valid, false);
    write(rp, good);
    for (const file of ['requests.jsonl', 'receipts.jsonl']) {
      const p = join(donorDir, file), values = readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      values.find(x => x.stage === 'implementation-planning').selector = sol;
      write(p, values.map(JSON.stringify).join('\n'));
    }
    c = buildReport(root).runs.find(r => r.run === 'catalog').cells[0];
    assert.equal(c.brief_source_valid, false); assert.equal(c.allocated.seconds, null, 'a Sol request cannot be inherited as DeepSeek owner work');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
