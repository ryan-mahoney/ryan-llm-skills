// node --test scripts/changeset-study/optimized-report.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../changeset/workspace.mjs';
import { buildReport, markdown } from './optimized-report.mjs';
import { smallerRegionQueryRole } from './roles.mjs';

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

// Run alone: node --test --test-name-pattern='brief-only reuse' scripts/changeset-study/optimized-report.test.mjs
test('brief-only reuse preserves owner selector and allocates owner work while new query and catalog generation remain incurred', () => {
  const root = mkdtempSync(join(tmpdir(), 'optimized-report-brief-'));
  const sol = 'openai-codex/gpt-6.1-sol:low', ds = 'deepseek/deepseek-flash:off', low = 'deepseek/deepseek-flash:low';
  const plan = { operations: [{ id: 'same-plan' }] }, brief = 'Shared owner brief.\n';
  const write = (p, value) => writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  function make(name, { briefSource = null, planningSource = null, actual = 3000, query = 100, context = 2, writer = ds, owner = null } = {}) {
    const run = join(root, name), dir = join(run, '000-case'); mkdirSync(dir, { recursive: true });
    write(join(run, 'manifest.json'), { strategy: 'owner-query-writer', selector: sol, editor_selector: writer, optimization: 'none', query_mode: 'catalog',
      ...(owner ? { roles: { implementation_owner: owner, query_planner: sol, writer } } : {}),
      schedule: ['case'], plans_from: planningSource?.run ?? null, briefs_from: planningSource ? null : briefSource?.run ?? null });
    write(join(dir, 'candidate.json'), '{}'); write(join(dir, 'implementation-brief.md'), brief);
    write(join(dir, 'raw-plan.json'), plan); write(join(dir, 'plan-0.json'), plan);
    write(join(dir, 'job.json'), { briefSource, planningSource });
    const catalog = { schema_version: 1, files: [] };
    if (!planningSource) write(join(dir, 'catalog.json'), catalog);
    const stages = planningSource ? ['editor'] : briefSource ? ['planning', 'editor'] : ['implementation-planning', 'planning', 'editor'];
    const requests = stages.map((stage, i) => ({ stage, selector: stage === 'planning' ? sol : stage === 'implementation-planning' ? ds : writer, reservation: `${name}-${i}`, ...(stage === 'planning' ? { context: { messages: [{ role: 'user', content: JSON.stringify({ catalog }) }] } } : {}) }));
    const receipts = requests.map(q => ({ ...q, elapsed_ms: 1000, usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0.01 } } }));
    write(join(dir, 'requests.jsonl'), requests.map(JSON.stringify).join('\n')); write(join(dir, 'receipts.jsonl'), receipts.map(JSON.stringify).join('\n'));
    const r = { task: 'case', task_hash: 'task', selector: sol, editor_selector: writer, optimization: 'none', query_mode: 'catalog',
      ...(!planningSource ? { catalog_hash: hash(readFileSync(join(dir, 'catalog.json'))) } : {}),
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
    make('separate-original-roles', { writer: low, owner: ds });
    make('low-writer-replay', { briefSource: borrowed, planningSource: planSource, actual: 8, writer: low, owner: ds });
    make('wrong-owner-replay', { briefSource: borrowed, planningSource: planSource, actual: 8, writer: low, owner: low });
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
    const originalRoles = report.runs.find(r => r.run === 'separate-original-roles').cells[0];
    assert.equal(originalRoles.integrity_valid, true); assert.equal(originalRoles.owner_selector, ds);
    assert.equal(originalRoles.model_usage_by_stage.owner.calls, 1); assert.equal(originalRoles.owner_role_valid, true);
    const lowReplay = report.runs.find(r => r.run === 'low-writer-replay').cells[0];
    assert.equal(lowReplay.integrity_valid, true); assert.equal(lowReplay.provider_routing_valid, true);
    assert.equal(lowReplay.owner_selector, ds); assert.equal(lowReplay.editor_selector, low);
    assert.equal(lowReplay.owner_role_valid, true); assert.equal(lowReplay.brief_source_valid, true);
    assert.equal(lowReplay.allocated.seconds, 25); assert.equal(lowReplay.allocated.model_usage.calls, 3);
    const wrongOwner = report.runs.find(r => r.run === 'wrong-owner-replay').cells[0];
    assert.equal(wrongOwner.integrity_valid, false); assert.equal(wrongOwner.brief_source_valid, false);
    assert.equal(wrongOwner.owner_role_valid, false); assert.equal(wrongOwner.allocated.model_usage, null);
    assert.equal(wrongOwner.owner_selector, low);
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

// Run alone: node --test --test-name-pattern='lookup provenance' scripts/changeset-study/optimized-report.test.mjs
test('lookup provenance verifies frozen source, rejected lookups and planner call caps without promoting failed plans', () => {
  const root = mkdtempSync(join(tmpdir(), 'optimized-report-lookup-'));
  const sol = 'openai-codex/gpt-6.1-sol:low', ds = 'deepseek/deepseek-flash:off';
  const write = (path, value) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  const task = { id: 'case', spec: 'Owner contract', files: { 'support.mjs': '// Fixture header\nexport function prepare() { return 1; }\n' } };
  const brief = 'Unchanged settled owner brief.\n', plan = { schema_version: 1, operations: [{ id: 'one' }] };
  const catalog = { schema_version: 1, files: [{ path: 'support.mjs', exists: true }] };
  function make(name, mode) {
    const directory = join(root, name, '000-case'); mkdirSync(directory, { recursive: true });
    write(join(root, name, 'manifest.json'), { strategy: 'owner-query-writer', selector: sol, editor_selector: ds,
      optimization: 'none', query_mode: 'catalog-lookup', schedule: ['case'] });
    write(join(directory, 'job.json'), { task }); write(join(directory, 'candidate.json'), '{}');
    write(join(directory, 'implementation-brief.md'), brief); write(join(directory, 'catalog.json'), catalog);
    const input = { implementation_brief: brief, catalog, file_tree: Object.keys(task.files), protected_files: [] };
    const requested = [{ path: mode === 'rejected' ? 'missing.mjs' : 'support.mjs', whole: true }];
    const resolved = mode === 'rejected' ? { ok: false, error: 'needs discovery: unknown frozen source path', request_index: 0, matches: null, candidates: [] }
      : { schema_version: 1, offset_units: 'utf16-code-units', source_characters: task.files['support.mjs'].length,
        snippets: [{ request_index: 0, path: 'support.mjs', request: requested[0], source_hash: hash(task.files['support.mjs']),
          source_start: 0, source_end: task.files['support.mjs'].length, start: null, end: null, text: task.files['support.mjs'] }] };
    const requests = [], responses = [];
    function call(stage, selector, packet, response) {
      const reservation = `${name}-${requests.length}`;
      requests.push({ reservation, stage, selector, context: { systemPrompt: 'Planner', messages: [{ role: 'user', content: JSON.stringify(packet) }] } });
      if (response !== undefined) responses.push({ reservation, stage, response: { content: [{ type: 'text', text: typeof response === 'string' ? response : JSON.stringify(response) }] } });
    }
    call('implementation-planning', ds, { task: 'owner only' }, brief);
    if (mode === 'resolved') call('planning', sol, input, '{"source_requests":[]} extra text');
    call('planning', sol, input, mode === 'direct' ? plan : mode === 'malformed' ? 'invalid JSON' : { source_requests: requested });
    if (mode === 'resolved') call('planning', sol, { ...input, source_requests: requested, source_lookup: resolved }, plan);
    const completed = ['resolved', 'direct'].includes(mode);
    if (completed) call('editor', ds, {}, {});
    write(join(directory, 'requests.jsonl'), requests.map(JSON.stringify).join('\n'));
    write(join(directory, 'responses.jsonl'), responses.map(JSON.stringify).join('\n'));
    write(join(directory, 'receipts.jsonl'), requests.map(request => JSON.stringify({ reservation: request.reservation, stage: request.stage, selector: request.selector,
      elapsed_ms: 1000, usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0.01 } } })).join('\n'));
    if (completed) { write(join(directory, 'raw-plan.json'), plan); write(join(directory, 'plan-0.json'), plan); }
    const result = { task: 'case', task_hash: hash(JSON.stringify(task)), selector: sol, editor_selector: ds, query_mode: 'catalog-lookup', optimization: 'none',
      process_elapsed_ms: 5000, implementation_brief_hash: hash(brief), candidate_hash: hash('{}'), catalog_hash: hash(readFileSync(join(directory, 'catalog.json'))),
      executions: completed ? [{ ok: true, plan_sha256: hash(JSON.stringify(plan)), operations: [{ executor: 'simple', status: 'passed' }] }] : [],
      stages: [{ name: 'implementation-planning', elapsed_ms: 1000 }, { name: 'planning', elapsed_ms: 1000 }] };
    if (['resolved', 'rejected'].includes(mode)) {
      write(join(directory, 'source-requests.json'), requested); write(join(directory, 'source-lookup.json'), resolved);
      result.source_requests_hash = hash(readFileSync(join(directory, 'source-requests.json')));
      result.source_lookup_hash = hash(readFileSync(join(directory, 'source-lookup.json')));
      if (mode === 'resolved') { result.source_lookup_characters = resolved.source_characters; result.query_format_recoveries = [{ after_call: 1, error: 'Unexpected extra text' }]; }
    }
    write(join(directory, 'result.json'), result);
    return directory;
  }
  try {
    const directory = make('resolved', 'resolved'); make('rejected', 'rejected'); make('direct', 'direct'); make('malformed', 'malformed');
    const cell = name => buildReport(root).runs.find(run => run.run === name).cells[0];
    let valid = cell('resolved');
    assert.equal(valid.integrity_valid, true);
    assert.equal(valid.catalog_evidence.provenance_valid, true);
    assert.equal(valid.source_lookup_evidence.provenance_valid, true);
    assert.equal(valid.source_lookup_evidence.successful_lookup, true);
    assert.equal(valid.source_lookup_evidence.status, 'resolved');
    assert.equal(valid.source_lookup_characters, task.files['support.mjs'].length);
    assert.equal(valid.query_call_count, 3); assert.equal(valid.query_call_cap, 3);
    assert.deepEqual(valid.query_format_recoveries, [{ after_call: 1, error: 'Unexpected extra text' }]);
    const rejected = cell('rejected');
    assert.equal(rejected.source_lookup_evidence.provenance_valid, true);
    assert.equal(rejected.source_lookup_evidence.status, 'rejected');
    assert.equal(rejected.source_lookup_evidence.successful_lookup, false);
    assert.equal(rejected.application_complete, false); assert.equal(rejected.integrity_valid, false);
    assert.equal(cell('direct').source_lookup_evidence, null);
    assert.equal(cell('direct').integrity_valid, true);
    assert.equal(cell('malformed').source_lookup_evidence, null);
    assert.equal(cell('malformed').application_complete, false);

    const lookupPath = join(directory, 'source-lookup.json'), resultPath = join(directory, 'result.json');
    const originalLookup = readFileSync(lookupPath), originalResult = readFileSync(resultPath);
    const requestArtifact = join(directory, 'source-requests.json'), originalRequestArtifact = readFileSync(requestArtifact);
    const strippedLookup = JSON.parse(originalResult);
    delete strippedLookup.source_requests_hash; delete strippedLookup.source_lookup_hash; delete strippedLookup.source_lookup_characters;
    rmSync(requestArtifact); rmSync(lookupPath); write(resultPath, strippedLookup);
    assert.equal(cell('resolved').source_lookup_evidence.provenance_valid, false, 'retained lookup packets require artifacts even when result fields were removed');
    assert.equal(cell('resolved').integrity_valid, false);
    writeFileSync(requestArtifact, originalRequestArtifact); writeFileSync(lookupPath, originalLookup); writeFileSync(resultPath, originalResult);
    const catalogPath = join(directory, 'catalog.json'), originalCatalog = readFileSync(catalogPath);
    const strippedCatalog = JSON.parse(originalResult); delete strippedCatalog.catalog_hash;
    rmSync(catalogPath); write(resultPath, strippedCatalog);
    assert.equal(cell('resolved').catalog_evidence.provenance_valid, false, 'catalog query packets require catalog artifact and result hash');
    assert.equal(cell('resolved').integrity_valid, false);
    writeFileSync(catalogPath, originalCatalog); writeFileSync(resultPath, originalResult);

    const originalRequestBytes = readFileSync(join(directory, 'requests.jsonl'));
    for (const change of [
      lookup => { lookup.snippets[0].text = 'corrupted source'; },
      lookup => { lookup.snippets[0].source_hash = 'wrong'; },
      lookup => { lookup.snippets[0].source_start = 1; },
      lookup => { lookup.snippets[0].start = 'invented anchor'; },
      lookup => { lookup.snippets[0].request.path = 'other.mjs'; },
      lookup => { lookup.source_characters++; },
      lookup => { lookup.snippets[0] = null; },
    ]) {
      const bad = JSON.parse(originalLookup); change(bad); write(lookupPath, bad);
      const result = JSON.parse(originalResult); result.source_lookup_hash = hash(readFileSync(lookupPath)); write(resultPath, result);
      // Keep recorded followup input consistent with the corrupted artifact so the
      // independent frozen-source checks, rather than packet identity alone, reject it.
      const matchingPackets = originalRequestBytes.toString('utf8').split('\n').map(JSON.parse);
      for (const packet of matchingPackets) {
        const input = JSON.parse(packet.context.messages[0].content);
        if (input.source_lookup) { input.source_lookup = bad; packet.context.messages[0].content = JSON.stringify(input); }
      }
      write(join(directory, 'requests.jsonl'), matchingPackets.map(JSON.stringify).join('\n'));

      const changed = cell('resolved');
      assert.equal(changed.source_lookup_evidence.provenance_valid, false);
      assert.equal(changed.integrity_valid, false);
    }
    writeFileSync(lookupPath, originalLookup); writeFileSync(resultPath, originalResult); writeFileSync(join(directory, 'requests.jsonl'), originalRequestBytes);
    for (const field of ['source_lookup_hash', 'source_requests_hash']) {
      const badHash = JSON.parse(originalResult); badHash[field] = 'wrong'; write(resultPath, badHash);
      assert.equal(cell('resolved').source_lookup_evidence.provenance_valid, false);
    }
    writeFileSync(resultPath, originalResult);
    const responsePath = join(directory, 'responses.jsonl'), originalResponses = readFileSync(responsePath);
    write(responsePath, '{partial response');
    assert.equal(cell('resolved').source_lookup_evidence.provenance_valid, false);
    writeFileSync(responsePath, originalResponses);
    write(join(root, 'direct/000-case/responses.jsonl'), '{irrelevant historical partial response');
    assert.equal(cell('direct').integrity_valid, true, 'no lookup does not add a new response-file requirement');
    const requestsPath = join(directory, 'requests.jsonl'), receiptsPath = join(directory, 'receipts.jsonl');
    const requests = readFileSync(requestsPath, 'utf8').split('\n').map(JSON.parse), receipts = readFileSync(receiptsPath, 'utf8').split('\n').map(JSON.parse);
    const extra = { ...requests[1], reservation: 'extra-query' };
    requests.splice(4, 0, extra); receipts.splice(4, 0, { ...receipts[1], reservation: 'extra-query' });
    write(requestsPath, requests.map(JSON.stringify).join('\n')); write(receiptsPath, receipts.map(JSON.stringify).join('\n'));
    valid = cell('resolved'); assert.equal(valid.query_call_count, 4); assert.equal(valid.integrity_valid, false);
    assert.equal(valid.validation.find(check => check.check === 'catalog-lookup planning call cap and stages').ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Run alone: node --test --test-name-pattern='writer recovery audits' scripts/changeset-study/optimized-report.test.mjs
test('writer recovery audits bounded off to low attempts against dispatched operation identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'optimized-report-recovery-'));
  const sol = 'openai-codex/gpt-6.1-sol:low', off = 'deepseek/deepseek-flash:off', low = 'deepseek/deepseek-flash:low';
  const run = join(root, 'recovery'), directory = join(run, '000-case');
  mkdirSync(directory, { recursive: true });
  const assignment = { objective: 'Update one helper.', instruction: 'Owner assignment', requirements: ['Preserve the interface.'], writes: ['helper.mjs'] };
  const plan = { operations: [{ id: 'edit-one', executor: 'simple', ...assignment }] }, brief = 'Preserve the resolved owner implementation.\n';
  const packet = value => ({ messages: [{ role: 'user', content: JSON.stringify(value) }] });
  const manifest = { strategy: 'owner-query-writer', selector: sol, editor_selector: off, writer_recovery_selector: low,
    schedule: ['case'], models: [off, low].map(selector => ({ selector, model: { provider: 'deepseek', id: 'deepseek-flash' } })) };
  const requests = [
    { reservation: 'owner', stage: 'implementation-planning', selector: off },
    { reservation: 'query', stage: 'discovery-planning', selector: sol },
    { reservation: 'initial', stage: 'editor', selector: off, operation_id: 'edit-one', writer_attempt: 0, context: packet(assignment) },
    { reservation: 'retry', stage: 'editor', selector: low, operation_id: 'edit-one', writer_attempt: 1, context: packet({ ...assignment, application_failure: 'Replacement anchor was not unique' }) },
  ];
  const receipts = requests.map(request => ({ ...request, elapsed_ms: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } } }));
  const result = { selector: sol, editor_selector: off, writer_recovery_selector: low, task: 'case', task_hash: 'task',
    process_elapsed_ms: 100, implementation_brief_hash: hash(brief), candidate_hash: hash('{}'), accepted: true,
    executions: [{ ok: true, plan_sha256: hash(JSON.stringify(plan)), operations: [{ id: 'edit-one', executor: 'simple', status: 'passed' }] }] };
  const fixture = { manifest, requests, receipts, result, job: { writerRecoverySelector: low } };
  const write = (path, value) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  function audit(mutate = () => {}) {
    const data = structuredClone(fixture); mutate(data);
    write(join(run, 'manifest.json'), data.manifest);
    for (const [name, value] of Object.entries({ 'raw-plan.json': plan, 'plan-0.json': plan, 'implementation-brief.md': brief,
      'candidate.json': '{}', 'result.json': data.result, 'job.json': data.job })) write(join(directory, name), value);
    write(join(directory, 'requests.jsonl'), data.requests.map(JSON.stringify).join('\n'));
    write(join(directory, 'receipts.jsonl'), data.receipts.map(JSON.stringify).join('\n'));
    return buildReport(root).runs[0].cells[0];
  }
  try {
    const valid = audit();
    assert.equal(valid.integrity_valid, true); assert.equal(valid.provider_routing_valid, true);
    assert.equal(valid.writer_recovery_evidence.attempts.length, 2);
    const violations = [
      ['recovery without matching initial', d => { d.requests.splice(2, 1); d.receipts.splice(2, 1); }],
      ['recovery without application failure', d => { d.requests[3].context = packet(assignment); }],
      ['initial request using recovery model', d => { d.requests[2].selector = low; d.receipts[2].selector = low; }],
      ['unknown operation id in both request and receipt', d => { d.requests[3].operation_id = d.receipts[3].operation_id = 'unplanned'; }],
      ['metadata cannot disguise a different retry assignment', d => { d.requests[3].context = packet({ ...assignment, instruction: 'A different operation', application_failure: 'Syntax error' }); }],
      ['matching initial and retry packets cannot override the dispatched assignment', d => {
        d.requests[2].context = packet({ ...assignment, writes: ['other.mjs'] });
        d.requests[3].context = packet({ ...assignment, writes: ['other.mjs'], application_failure: 'Syntax error' });
      }],
      ['recovery cannot add downstream feedback to the initial packet', d => {
        d.requests[3].context = packet({ ...assignment, application_failure: 'Syntax error', visible_check_output: 'Downstream feedback' });
      }],
      ['receipt attempt mismatch', d => { d.receipts[3].writer_attempt = 0; }],
      ['missing attempt metadata', d => { delete d.requests[2].writer_attempt; delete d.receipts[2].writer_attempt; }],
      ['third operation attempt', d => { d.requests.push({ ...d.requests[3], reservation: 'third' }); d.receipts.push({ ...d.receipts[3], reservation: 'third' }); }],
      ['job recovery selector mismatch', d => { d.job.writerRecoverySelector = off; }],
      ['result recovery selector mismatch', d => { d.result.writer_recovery_selector = off; }],
      ['missing recovery model metadata', d => { d.manifest.models.pop(); }],
      ['unauthorized recovery effort', d => { d.manifest.writer_recovery_selector = d.result.writer_recovery_selector = d.job.writerRecoverySelector = 'deepseek/deepseek-flash:high'; }],
      ['Sol query after writer', d => { d.requests.push({ ...d.requests[1], reservation: 'late-query' }); d.receipts.push({ ...d.receipts[1], reservation: 'late-query' }); }],
      ['unconfigured recovery does not relax fixed selector routing', d => { delete d.manifest.writer_recovery_selector; delete d.result.writer_recovery_selector; delete d.job.writerRecoverySelector; }],
    ];
    for (const [name, mutate] of violations) assert.equal(audit(mutate).integrity_valid, false, name);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Run alone: node --test --test-name-pattern='smaller-region reporting' scripts/changeset-study/optimized-report.test.mjs
test('smaller-region reporting verifies treatment identity, planning rule, call reserve and retained partitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'optimized-report-granularity-'));
  const run = join(root, 'smaller'), directory = join(run, '000-case'); mkdirSync(directory, { recursive: true });
  const sol = 'openai-codex/gpt-6.1-sol:low', ds = 'deepseek/deepseek-flash:off';
  const budget = { max_calls: 6, calls_used: 1, query_calls_reserved: 3, writer_attempts_per_operation: 2, max_operations: 1 };
  const plan = { operations: [{ id: 'one', executor: 'simple', reads: [], writes: ['answer.mjs'], objective: 'Update answer', instruction: 'Apply settled update', requirements: ['Preserve other source.'] }] };
  const brief = 'Settled implementation.\n', catalog = { schema_version: 1, files: [] };
  const manifest = { strategy: 'owner-query-writer', selector: sol, editor_selector: ds, query_mode: 'catalog-lookup',
    optimization: 'none', query_granularity: 'smaller-regions', schedule: ['case'] };
  const requests = ['implementation-planning', 'planning', 'editor'].map((stage, index) => ({ reservation: 'request-' + index,
    stage, selector: stage === 'planning' ? sol : ds, ...(stage === 'planning' ? {
      context: { systemPrompt: smallerRegionQueryRole(budget), messages: [{ role: 'user', content: JSON.stringify({ catalog }) }] },
    } : {}) }));
  const receipts = requests.map(request => ({ ...request, elapsed_ms: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } } }));
  const result = { selector: sol, editor_selector: ds, task: 'case', task_hash: 'task', optimization: 'none', query_mode: 'catalog-lookup',
    query_granularity: 'smaller-regions', query_assignment_budget: budget, limits: { model_calls: 6 }, process_elapsed_ms: 100,
    implementation_brief_hash: hash(brief), candidate_hash: hash('{}'), catalog_hash: hash(JSON.stringify(catalog)),
    executions: [{ ok: true, plan_sha256: hash(JSON.stringify(plan)), operations: [{ id: 'one', executor: 'simple', status: 'passed' }] }] };
  const baseline = { manifest, requests, receipts, result, plan, raw: structuredClone(plan), job: { queryGranularity: 'smaller-regions', task: { limits: { model_calls: 6 } } } };
  const write = (path, value) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  function audit(mutate = () => {}) {
    const data = structuredClone(baseline); mutate(data);
    write(join(run, 'manifest.json'), data.manifest);
    for (const [name, value] of Object.entries({ 'raw-plan.json': data.raw, 'plan-0.json': data.plan, 'implementation-brief.md': brief,
      'catalog.json': catalog, 'candidate.json': '{}', 'result.json': data.result, 'job.json': data.job })) write(join(directory, name), value);
    write(join(directory, 'requests.jsonl'), data.requests.map(JSON.stringify).join('\n'));
    write(join(directory, 'receipts.jsonl'), data.receipts.map(JSON.stringify).join('\n'));
    return buildReport(root).runs[0].cells[0];
  }
  try {
    assert.equal(audit().integrity_valid, true);
    for (const [name, mutate] of [
      ['job silently relabeled', d => { delete d.job.queryGranularity; }],
      ['result silently relabeled', d => { delete d.result.query_granularity; }],
      ['regrouping enabled', d => { d.manifest.optimization = d.result.optimization = 'deterministic'; }],
      ['assignment cap inflated', d => { d.result.query_assignment_budget.max_operations = 2; }],
      ['default prompt mislabeled as smaller', d => { d.requests[1].context.systemPrompt = 'Default prompt'; }],
      ['partition assignment changed after planning', d => { d.plan.operations[0].instruction = 'Different assignment'; }],
    ]) assert.equal(audit(mutate).integrity_valid, false, name);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
