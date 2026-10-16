#!/usr/bin/env node
// Report frozen owner/editor runs; never submit inference or alter trial results.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from '../changeset/workspace.mjs';
import { equivalentCost } from '../changeset-research/cost.mjs';
import { deliveredResult, dispatchOnly } from './strategies.mjs';

const [root, solReportPath, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: owner-editor-report.mjs RUN_ROOT SOL_ONLY_REPORT_JSON OUTPUT_PREFIX');
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const jsonl = p => readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const sum = xs => xs.reduce((a, b) => a + b, 0);
const knownSum = xs => xs.length && xs.every(Number.isFinite) ? sum(xs) : null;
const tokens = receipts => Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].map(k =>
  [k, receipts.every(r => Number.isFinite(r.usage?.[k])) ? sum(receipts.map(r => r.usage[k])) : null]));
const sol = read(solReportPath);
const baselines = [
  { name: 'Native Sol', ...sol.baseline, cells: sol.references },
  ...sol.iterations.filter(r => ['06-boundary-review', '07-boundary-review-repeat'].includes(r.run)).map(r => ({
    name: r.run, n: r.n, seconds: r.seconds, equivalent_usd: r.equivalent_usd, calls: r.calls, tokens: r.tokens, cells: r.cells,
  })),
];
if (baselines.length !== 3) throw new Error('Missing retained Sol-only baselines');
const auditPath = join(root, 'posthoc-audits.json');
const audits = existsSync(auditPath) ? read(auditPath) : { required_tasks: ['hard-dependency-handoff'], results: [] };
if (existsSync(auditPath)) for (const b of baselines) for (const task of audits.required_tasks) {
  const candidate = b.cells.find(c => c.task === task)?.candidate_hash;
  if (!audits.reference_results?.some(a => a.candidate_hash === candidate && a.passed === true)) throw new Error('Required audit does not validate retained baseline');
}
const runs = [];
for (const name of readdirSync(root).sort()) {
  const dir = join(root, name), mp = join(dir, 'manifest.json');
  if (!existsSync(mp)) continue;
  const m = read(mp);
  if (m.comparison !== 'sol-owner-deepseek-editor') continue;
  if (!m.editor_selector?.startsWith('deepseek/')) throw new Error('Unexpected editor provider');
  const cells = [], pending = [];
  for (const [i, task] of m.schedule.entries()) {
    const cellDir = join(dir, `${String(i).padStart(3, '0')}-${task}`), rp = join(cellDir, 'result.json');
    if (!existsSync(rp) || !Number.isFinite(read(rp).process_elapsed_ms)) { pending.push(task); continue; }
    const r = read(rp), receipts = jsonl(join(cellDir, 'receipts.jsonl')), requests = jsonl(join(cellDir, 'requests.jsonl'));
    const ref = sol.references.find(c => c.task === task);
    if (r.task_hash !== ref?.task_hash || r.selector !== m.selector || r.editor_selector !== m.editor_selector) throw new Error('Task or selectors differ');
    if (hash(readFileSync(join(cellDir, 'candidate.json'))) !== r.candidate_hash) throw new Error('Candidate changed after freeze');
    const requestIds = new Set(requests.map(r => r.reservation));
    if (requestIds.size !== requests.length || receipts.some(r => !requestIds.has(r.reservation)) || new Set(receipts.map(r => r.reservation)).size !== receipts.length) throw new Error('Invalid request/receipt identity');
    const firstEditor = requests.findIndex(r => r.stage === 'editor');
    const dispatchValid = !dispatchOnly(m.strategy) || (r.reviews.length === 0 && r.repairs === 0 &&
      requests.every((r, i) => r.stage === 'editor' || (['planning', 'discovery-planning'].includes(r.stage) && (firstEditor < 0 || i < firstEditor))));
    const routingValid = dispatchValid && receipts.every(r => r.selector === (r.stage === 'editor' ? m.editor_selector : m.selector)) &&
      r.executions.every(e => e.operations.every(o => o.status === 'blocked' || ['simple', 'involved'].includes(o.executor)));
    const completeAccounting = receipts.length === requests.length && receipts.every(r => r.usage?.cost?.total > 0);
    if (r.model_calls !== requests.length || r.accounting_complete !== completeAccounting) throw new Error('Accounting flag differs from receipts');
    if (completeAccounting && (Math.abs(equivalentCost(receipts) - r.equivalent_usd) > 1e-9 || tokens(receipts).totalTokens !== r.tokens.totalTokens)) throw new Error('Accounting totals differ');
    const delivered = deliveredResult(r);
    if (Boolean(delivered) !== r.delivered) throw new Error('Delivery differs');
    const audit = audits.results.find(a => a.run === name && a.task === task) ?? null;
    if (audit && audit.candidate_hash !== r.candidate_hash) throw new Error('Audit candidate differs');
    const qualified = Boolean(delivered && routingValid && audit?.passed !== false && (!audits.required_tasks.includes(task) || audit?.passed === true));
    const role = selector => {
      const rows = receipts.filter(r => r.selector === selector);
      const calls = requests.filter(r => r.selector === selector).length;
      const complete = calls === rows.length && rows.every(r => r.usage?.cost?.total > 0);
      return { calls, received: rows.length, accounting_complete: complete,
        tokens: complete ? tokens(rows) : Object.fromEntries(Object.keys(tokens(rows)).map(k => [k, null])),
        known_tokens: Object.fromEntries(Object.keys(tokens(rows)).map(k => [k, sum(rows.map(r => r.usage?.[k] ?? 0))])),
        reported_reasoning_tokens: sum(rows.map(r => r.usage?.reasoning ?? 0)),
        equivalent_usd: rows.length ? equivalentCost(rows) : 0,
        request_seconds: sum(rows.map(r => r.elapsed_ms)) / 1000 };
    };
    let dispatch = null;
    if (dispatchOnly(m.strategy)) {
      const planPath = join(cellDir, 'plan-0.json');
      const plan = existsSync(planPath) ? read(planPath) : null;
      if (r.executions.length && hash(JSON.stringify(plan)) !== r.executions[0].plan_sha256) throw new Error('Dispatch plan changed');
      const packets = requests.filter(r => r.stage === 'editor').map(r => ({ request: r,
        input: JSON.parse(r.context.messages[0].content) }));
      const maximum = xs => xs.length ? Math.max(...xs) : null;
      dispatch = { planned_packets: plan?.operations?.length ?? null, editor_requests: packets.length,
        application_retries: packets.filter(p => p.input.application_failure !== undefined).length,
        max_source_characters: maximum(packets.map(p => sum(p.input.excerpts.map(e => e.text.length)))),
        max_assignment_characters: maximum(packets.map(p => p.input.objective.length + p.input.instruction.length + p.input.requirements.join('').length)),
        max_request_bytes: maximum(packets.map(p => Buffer.byteLength(JSON.stringify(p.request.context)))),
        scheduler_peak_concurrency: maximum(r.executions.map(e => e.metrics.peak_concurrency)),
        owner_calls_after_dispatch: firstEditor < 0 ? 0 : requests.slice(firstEditor).filter(r => r.stage !== 'editor').length,
        packets: plan?.operations?.map(op => ({ id: op.id, objective: op.objective, writes: op.writes, depends_on: op.depends_on })) ?? [] };
    }
    cells.push({ task, accepted: r.accepted, delivered: r.delivered, qualified_delivery: qualified, routing_valid: routingValid, dispatch_valid: dispatchValid,
      outcome: r.outcome, error: r.error ?? null, seconds: r.process_elapsed_ms / 1000,
      calls: r.model_calls, tokens: r.tokens, equivalent_usd: r.equivalent_usd, accounting_complete: completeAccounting,
      owner: role(m.selector), editor: role(m.editor_selector), repairs: r.repairs,
      review_accepted: r.review_accepted, visible_accepted: r.visible_accepted,
      review_mode: r.review_mode ?? 'model-impact-review', checks: r.checks ?? [],
      dispatch,
      result_hash: hash(readFileSync(rp)), candidate_hash: r.candidate_hash, task_hash: r.task_hash,
      posthoc: audit, stages: r.stages, executions: r.executions,
      reviews: r.reviews.map(v => ({ round: v.round, accepted: v.review.accepted, findings: v.review.findings, implementation_error: v.implementation_error })),
      terminal_output_hash: hash(r.hidden?.output ?? '') });
  }
  const total = { seconds: sum(cells.map(c => c.seconds)), calls: knownSum(cells.map(c => c.calls)),
    tokens: knownSum(cells.map(c => c.tokens?.totalTokens)), equivalent_usd: knownSum(cells.map(c => c.equivalent_usd)) };
  const qualified = pending.length === 0 && cells.every(c => c.qualified_delivery);
  const comparison = baselines.map(b => {
    const speed = Math.exp(sum(cells.map(c => Math.log((b.cells.find(x => x.task === c.task).process_elapsed_ms / 1000) / (c.qualified_delivery ? c.seconds : 1500)))) / cells.length);
    return { baseline: b.name, failure_adjusted_geometric_speed_ratio: speed,
      elapsed_reduction_percent: pending.length ? null : 100 * (1 - total.seconds / b.seconds),
      equivalent_cost_reduction_percent: pending.length || total.equivalent_usd === null ? null : 100 * (1 - total.equivalent_usd / b.equivalent_usd),
      beats_reference: qualified && total.seconds < b.seconds && total.equivalent_usd !== null && total.equivalent_usd < b.equivalent_usd && speed > 1 };
  });
  runs.push({ run: name, strategy: m.strategy, owner_selector: m.selector, editor_selector: m.editor_selector,
    replay_of: m.replay_of, created_at: m.created_at, manifest_hash: hash(readFileSync(mp)), freeze_hash: hash(JSON.stringify(m.frozen_files)),
    complete: pending.length === 0, expected: m.schedule.length, delivered: cells.filter(c => c.delivered).length,
    qualified_delivered: cells.filter(c => c.qualified_delivery).length, ...total,
    owner_calls: sum(cells.map(c => c.owner.calls)), editor_calls: sum(cells.map(c => c.editor.calls)),
    owner_tokens: knownSum(cells.map(c => c.owner.tokens.totalTokens)), editor_tokens: knownSum(cells.map(c => c.editor.tokens.totalTokens)),
    known_owner_tokens: sum(cells.map(c => c.owner.known_tokens.totalTokens)), known_editor_tokens: sum(cells.map(c => c.editor.known_tokens.totalTokens)),
    comparisons: comparison, cells, pending });
}
const repeated = runs.filter(r => r.complete && r.qualified_delivered === r.expected && r.replay_of && runs.some(a =>
  a.run === r.replay_of && a.complete && a.qualified_delivered === a.expected && a.freeze_hash === r.freeze_hash &&
  a.strategy === r.strategy && a.owner_selector === r.owner_selector && a.editor_selector === r.editor_selector)).map(r => ({ first: r.replay_of, repeat: r.run }));
const report = { schema_version: 1, label: 'Sol owner / DeepSeek editor on exposed historical cases',
  sol_only_report_hash: hash(readFileSync(solReportPath)), audit_hash: existsSync(auditPath) ? hash(readFileSync(auditPath)) : null,
  baselines: baselines.map(({ cells, ...rest }) => rest), runs, repeated_delivery: repeated };
writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n');
const f = (x, n = 2) => Number.isFinite(x) ? x.toFixed(n) : 'unknown';
writeFileSync(output + '.md', ['# Sol owner / DeepSeek editor results', '',
  'Three exposed development cases against historical controls. All trial model calls, reviews, repairs and terminal grading count. Equivalent costs use the fixed comparison tariff, not invoices.', '',
  'Speed ratios are failure-adjusted: each unqualified task receives the retained 1,500-second cap. Actual elapsed totals include failed attempts. A missing required audit is not a pass.', '',
  '| Approach | Audited delivery | Seconds | Equivalent USD | Calls | Tokens |', '|---|---:|---:|---:|---:|---:|',
  ...baselines.map(b => `| ${b.name} | 3/3 | ${f(b.seconds)} | ${f(b.equivalent_usd, 6)} | ${b.calls} | ${b.tokens} |`),
  ...runs.map(r => `| ${r.run} | ${r.qualified_delivered}/${r.expected}${r.complete ? '' : ' (pending)'} | ${f(r.seconds)} | ${f(r.equivalent_usd, 6)} | ${r.calls ?? 'unknown'} | ${r.tokens ?? 'unknown'} |`), '',
  ...runs.flatMap(r => [`## ${r.run}`, '',
    `Planner: ${r.owner_calls} calls / ${r.owner_tokens ?? 'unknown'} tokens. Editor: ${r.editor_calls} calls / ${r.editor_tokens ?? 'unknown'} tokens. Recorded delivery: ${r.delivered}/${r.expected}.`, '',
    ...(dispatchOnly(r.strategy) ? ['Dispatch only: no owner impact review or batch repair. Editors may retry one application failure. Executable checks and required posthoc audits determine measured acceptance; this differs from the reviewed historical controls.', ''] : []),
    ...(r.tokens === null ? [`Known reported tokens: owner ${r.known_owner_tokens}, editor ${r.known_editor_tokens}; incomplete accounting prevents an exact total or a cost-savings claim.`, ''] : []),
    '| Task | Audited delivery | Seconds | Owner calls | Editor calls | Repairs |', '|---|---|---:|---:|---:|---:|',
    ...r.cells.map(c => `| ${c.task} | ${c.qualified_delivery ? 'yes' : 'no'} | ${f(c.seconds)} | ${c.owner.calls} | ${c.editor.calls} | ${c.repairs} |`), '',
    ...r.comparisons.map(c => `- Versus ${c.baseline}: ${c.beats_reference ? 'meets win criteria' : 'does not meet win criteria'}; geometric speed ratio ${f(c.failure_adjusted_geometric_speed_ratio)}.`), '',
  ]),
  `Identical frozen repetitions delivering all cases: ${repeated.length ? repeated.map(r => r.first + ' / ' + r.repeat).join('; ') : 'none'}.`, '',
  'See [OWNER-EDITOR-PROTOCOL.md](OWNER-EDITOR-PROTOCOL.md) and [DISPATCH-PROTOCOL.md](DISPATCH-PROTOCOL.md) for frozen roles, acceptance, budget and interpretation.', ''].join('\n'));
console.log(JSON.stringify({ runs: runs.map(({ cells, ...r }) => r), repeated_delivery: repeated }));
