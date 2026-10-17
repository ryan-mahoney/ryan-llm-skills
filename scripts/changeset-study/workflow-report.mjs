#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { hash } from '../changeset/workspace.mjs';
import { costPolicy } from '../changeset-research/cost.mjs';

const [input, output, priorInput] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: workflow-report.mjs RUN OUTPUT_PREFIX [ORIGINAL_PARTIAL_RUN]');
const run = resolve(input), manifest = JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8'));
if (manifest.comparison !== 'sol-native-vs-sol-nemotron-workflow') throw new Error('Expected a combined-workflow manifest');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const sum = xs => xs.reduce((a, b) => a + b, 0);
const mean = xs => xs.length ? sum(xs) / xs.length : null;
const geometric = xs => xs.length ? Math.exp(mean(xs.map(Math.log))) : null;
const knownSum = xs => xs.every(Number.isFinite) ? sum(xs) : null;
const median = xs => { if (!xs.length) return null; const a = [...xs].sort((a, b) => a - b); return (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2; };
const cap = manifest.limits.cell_ms + manifest.limits.grade_ms;
const names = { agent: 'Sol native', 'changeset-mixed': 'Sol + Nemotron changeset' };

function compact(directory) {
  const result = read(join(directory, 'result.json'));
  const requests = lines(join(directory, 'requests.jsonl')), receipts = lines(join(directory, 'receipts.jsonl'));
  const role = selector => {
    const requested = requests.filter(r => r.selector === selector), received = receipts.filter(r => r.selector === selector);
    return { requests: requested.length, receipts: received.length, completed: received.filter(r => r.stop_reason === 'stop').length,
      known_output_tokens: sum(received.map(r => r.usage?.output ?? 0)),
      known_reasoning_tokens: sum(received.map(r => r.usage?.reasoning ?? 0)),
      receipt_elapsed_ms: sum(received.map(r => r.elapsed_ms)),
      errors: received.filter(r => r.error).map(r => ({ stage: r.stage, error: r.error })) };
  };
  const operations = (result.executions ?? []).flatMap(e => e.operations ?? []);
  const stages = {};
  for (const stage of result.stages ?? []) stages[stage.name] = (stages[stage.name] ?? 0) + stage.elapsed_ms;
  const completed = !result.error && result.review_accepted === true && result.visible_accepted === true &&
    result.reviews?.at(-1)?.implementation_error == null && (result.arm === 'agent' || result.executions?.at(-1)?.ok === true);
  const compact = Object.fromEntries(['task', 'family', 'context', 'arm', 'selector', 'simple_selector', 'outcome', 'accepted',
    'hidden_pass', 'review_accepted', 'visible_accepted', 'first_draft_visible_pass', 'repairs', 'implementation_ms', 'total_ms',
    'process_elapsed_ms', 'process_elapsed_ms_estimated', 'timing_note', 'capped_time_to_success_ms', 'error', 'grading_error',
    'model_calls', 'accounting_complete', 'equivalent_usd', 'catalog_usd', 'known_catalog_usd', 'retained_budget_exposure_usd',
    'tokens', 'known_tokens', 'tool_calls', 'candidate_hash', 'task_hash', 'repetition', 'order_in_pair'].filter(k => k in result).map(k => [k, result[k]]));
  return { ...compact, evidence_directory: basename(directory), result_hash: hash(readFileSync(join(directory, 'result.json'))),
    workflow_completed: completed, delivered: result.accepted && completed,
    delivery_capped_ms: result.accepted && completed ? result.process_elapsed_ms : cap,
    stages, sol: role(manifest.models[0]), nemotron: role(manifest.simple_selector),
    operations: operations.map(({ id, executor, status, elapsed_ms, error, dependencies }) => ({ id, executor, status, elapsed_ms, error, dependencies })),
    deterministic_operations: sum((result.executions ?? []).map(e => e.metrics?.deterministic_operations ?? 0)),
    peak_operation_concurrency: Math.max(0, ...(result.executions ?? []).map(e => e.metrics?.peak_concurrency ?? 0)),
    reviewer_findings: (result.reviews ?? []).flatMap(r => r.review.findings),
    implementation_errors: (result.reviews ?? []).map(r => r.implementation_error).filter(Boolean),
    hidden_summary: result.hidden ? { ok: result.hidden.ok, exit_code: result.hidden.exitCode,
      output_sha256: hash(result.hidden.output ?? '') } : null,
  };
}
const cells = [], pending = [];
let index = 0;
for (const pair of manifest.schedule) for (const arm of pair.arms) {
  const name = `${String(index++).padStart(3, '0')}-${pair.task}-${arm}`, directory = join(run, name);
  if (!existsSync(join(directory, 'result.json'))) { pending.push(name); continue; }
  const result = compact(directory);
  if (result.task !== pair.task || result.arm !== arm || result.selector !== pair.selector || result.repetition !== pair.repetition) throw new Error('Result does not match schedule');
  if (!Number.isFinite(result.process_elapsed_ms)) { pending.push(name); continue; } // Worker result not yet finalized by scheduler.
  const reuse = manifest.reused.find(r => r.cell === name);
  if (reuse && reuse.result_hash !== result.result_hash) throw new Error('Carried-over result changed');
  cells.push({ ...result, reused: Boolean(reuse) });
}
const summaries = Object.keys(names).map(arm => {
  const rows = cells.filter(r => r.arm === arm), passes = rows.filter(r => r.accepted).length;
  const cost = knownSum(rows.map(r => r.equivalent_usd));
  return { arm, label: names[arm], n: rows.length, accepted: passes,
    workflow_completed: rows.filter(r => r.workflow_completed).length,
    delivered: rows.filter(r => r.delivered).length,
    total_wall_ms: sum(rows.map(r => r.process_elapsed_ms)), median_wall_ms: median(rows.map(r => r.process_elapsed_ms)),
    mean_implementation_ms: mean(rows.map(r => r.implementation_ms).filter(Number.isFinite)),
    mean_capped_ms: mean(rows.map(r => r.capped_time_to_success_ms)),
    mean_delivery_capped_ms: mean(rows.map(r => r.delivery_capped_ms)),
    model_calls: knownSum(rows.map(r => r.model_calls)), equivalent_usd: rows.length ? cost : null,
    equivalent_usd_per_acceptance: passes && cost !== null ? cost / passes : null,
    known_equivalent_usd: sum(rows.map(r => r.equivalent_usd ?? 0)), unknown_cost_cells: rows.filter(r => r.equivalent_usd == null).length,
    repairs: rows.filter(r => r.repairs > 0).length,
    nemotron_requests: sum(rows.map(r => r.nemotron.requests)),
    nemotron_receipts: sum(rows.map(r => r.nemotron.receipts)),
    nemotron_completed: sum(rows.map(r => r.nemotron.completed)),
    trials_using_nemotron: rows.filter(r => r.nemotron.requests > 0).length,
    deterministic_operations: sum(rows.map(r => r.deterministic_operations)),
    tokens: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].map(k => [k, knownSum(rows.map(r => r.tokens?.[k]))])),
  };
});
const pairs = manifest.schedule.map(pair => {
  const agent = cells.find(c => c.task === pair.task && c.arm === 'agent');
  const mixed = cells.find(c => c.task === pair.task && c.arm === 'changeset-mixed');
  return { task: pair.task, agent: agent ?? null, mixed: mixed ?? null, complete: Boolean(agent && mixed),
    capped_speed_ratio: agent && mixed ? agent.capped_time_to_success_ms / mixed.capped_time_to_success_ms : null,
    delivery_capped_speed_ratio: agent && mixed ? agent.delivery_capped_ms / mixed.delivery_capped_ms : null,
    successful_speed_ratio: agent?.accepted && mixed?.accepted ? agent.process_elapsed_ms / mixed.process_elapsed_ms : null };
});
const matched = pairs.filter(p => p.complete), successful = matched.filter(p => p.successful_speed_ratio !== null);
function interval(rows, fn) {
  if (rows.length < 2) return [null, null];
  let seed = 16381; const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
  const samples = Array.from({ length: 10000 }, () => fn(Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]))).sort((a, b) => a - b);
  return [samples[250], samples[9749]];
}
const comparison = { complete_pairs: matched.length,
  capped_geometric_speed_ratio: geometric(matched.map(p => p.capped_speed_ratio)),
  capped_ratio_task_bootstrap_95: interval(matched, rows => geometric(rows.map(p => p.capped_speed_ratio))),
  delivery_capped_geometric_speed_ratio: geometric(matched.map(p => p.delivery_capped_speed_ratio)),
  successful_pairs: successful.length, successful_geometric_speed_ratio: geometric(successful.map(p => p.successful_speed_ratio)) };
const prior = priorInput ? readdirSync(priorInput).filter(name => /^\d+-/.test(name) && existsSync(join(priorInput, name, 'result.json')))
  .sort().map(name => ({ ...compact(join(priorInput, name)), carried_into_comparison: manifest.reused.some(r => r.source_cell === name) })) : [];
// Execution mounts are machine-specific runtime identities; shared reports retain hashes.
const { mounts, dependency_files, ...portableManifest } = manifest;
const auditPath = new URL('./hard-provider-audit.json', import.meta.url);
const audit = existsSync(auditPath) ? read(auditPath) : null;
const providerAudit = audit && manifest.sdk_files?.['pi-ai']?.some(([path, digest]) =>
  path === 'api/openai-codex-responses.js' && digest === audit.module_sha256) ? audit : null;
const report = { schema_version: 1, run_id: basename(run), complete: pending.length === 0, expected_cells: index,
  manifest: portableManifest, provider_audit: providerAudit, cost_policy: costPolicy, summaries, comparison, pairs: pairs.map(({ agent, mixed, ...p }) => p), cells, pending, prior_observations: prior };
writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n');
const f = (n, digits = 2) => Number.isFinite(n) ? n.toFixed(digits) : 'unknown';
const seconds = n => n == null ? 'unknown' : f(n / 1000);
const text = ['# Sol and Nemotron workflow comparison', '',
  `${cells.length}/${index} trials complete across six historical tasks. One trial per workflow and task. This exploratory comparison measures a complete workflow, not an isolated architectural effect.`, '',
  '| Workflow | External checks passed | Complete delivery | Median wall seconds | Model calls | Equivalent USD | Nemotron requests |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...summaries.map(s => `| ${s.label} | ${s.accepted}/${s.n} | ${s.delivered}/${s.n} | ${seconds(s.median_wall_ms)} | ${s.model_calls ?? 'unknown'} | ${f(s.equivalent_usd, 5)} | ${s.nemotron_requests} |`), '',
  `Failure-adjusted geometric speed ratio: ${f(comparison.capped_geometric_speed_ratio)} (95% task bootstrap interval ${comparison.capped_ratio_task_bootstrap_95.map(n => f(n)).join('–')}); ${matched.length} complete pairs. Ratios above 1 favor the combined workflow. Unsuccessful trials receive the ${cap / 1000}-second cap.`, '',
  `Among ${successful.length} pairs where both workflows passed, the conditional geometric speed ratio is ${f(comparison.successful_geometric_speed_ratio)}. It does not measure reliability or include failed attempts. Medians above include failed trials and must not be interpreted as time to a correct answer.`, '',
  `As a stricter descriptive measure, requiring both external acceptance and workflow completion gives a failure-adjusted speed ratio of ${f(comparison.delivery_capped_geometric_speed_ratio)}. This additional view preserves the original external-check scores.`, '',
  '| Task | Native accepted | Combined accepted | Wall seconds, native / combined | Nemotron requests |',
  '|---|---:|---:|---:|---:|',
  ...pairs.map(p => `| ${p.task} | ${p.agent ? p.agent.accepted ? 'yes' : 'no' : 'unrun'} | ${p.mixed ? p.mixed.accepted ? 'yes' : 'no' : 'unrun'} | ${seconds(p.agent?.process_elapsed_ms)} / ${seconds(p.mixed?.process_elapsed_ms)} | ${p.mixed?.nemotron.requests ?? 'unrun'} |`), '',
  'Native Sol uses standard Pi coding tools. The combined workflow uses Sol for discovery, planning, involved editor operations, review and batch repair planning; only simple editor operations use Nemotron. Plans can also apply deterministic operations. A trial with no Nemotron requests provides no evidence of Nemotron editor capability.', '',
  'Both workflows receive the same task and initial source, visible feedback, impact review and one batch repair opportunity. Terminal hidden tests run after the candidate freezes and never inform repairs. External acceptance comes from these tests, independently of reviewer opinion. Complete delivery requires external acceptance plus successful execution, visible checks and reviewer acceptance without an uncaught error. External checks can pass despite missing requested test additions or an incomplete workflow; the two counts are deliberately separate. Timing includes initialization, implementation, review, checks, repair and terminal grading.', '',
  'The original 72-trial campaign was narrowed by the operator for elapsed time after three results were observed and a fourth trial was in progress. All six tasks remain. Eligible repetition-zero native results were reused regardless of outcome; no worker, prompt or grader tuning followed those outcomes. Earlier observations appear below. The reused result contributes once to comparison totals and is not an additional charge.', '',
  'One repetition on six purposively selected historical cases is a screening result. Provider load, caching, scheduling order and model routing can affect timing. Task-bootstrap intervals describe this small sample, not population reliability. The source is an acceptance-test import closure, not a whole production checkout. Grader exclusions and deadlines are recorded in [PROTOCOL.md](PROTOCOL.md).', '',
  ...(providerAudit ? ['An offline audit of the exact pinned Sol adapter confirmed that instructions and low reasoning are forwarded, but the requested 32,000-token output limit is not. Sol therefore has no demonstrated provider-enforced limit at that value; its five-minute call deadline still applies. Nemotron receipts show length stops at 32,000 output tokens, including reasoning. The workflows do not have identical provider-enforced output budgets. The audit and module hash are included in the companion JSON.', ''] : []),
  'Equivalent costs price Sol tokens at DeepSeek rates under the subscription assumption. Unknown provider usage remains unknown; the companion JSON retains known usage and conservative budget exposure. Neither equivalent cost nor catalog estimates are invoices. The $50 reservation ledger includes previous campaigns and remains the spending guard.', '',
  '## Retained observations outside the reduced schedule', '',
  '| Model | Task | Arm | Accepted | Wall seconds | Treatment |',
  '|---|---|---|---:|---:|---|',
  ...prior.map(r => `| ${r.selector} | ${r.task} | ${r.arm} | ${r.accepted ? 'yes' : 'no'} | ${seconds(r.process_elapsed_ms)}${r.process_elapsed_ms_estimated ? ' (estimated)' : ''} | ${r.carried_into_comparison ? 'reused in comparison' : 'additional observation'} |`), '',
  'The Sol-only changeset trial finished uninterrupted while its original scheduler was stopped. Its process duration was reconstructed from process start and result completion; its worker duration remains recorded. It is outside the reduced comparison.', ''];
writeFileSync(output + '.md', text.join('\n'));
console.log(JSON.stringify({ output, complete: report.complete, completed: cells.length, expected: index, summaries, comparison }));
