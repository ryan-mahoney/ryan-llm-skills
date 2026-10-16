#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { hash } from '../changeset/workspace.mjs';

const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error('Usage: iteration-report.mjs ITERATIONS_ROOT OUTPUT_PREFIX');
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const sum = values => values.reduce((a, b) => a + b, 0);
const knownSum = values => values.length && values.every(Number.isFinite) ? sum(values) : null;
const geo = values => values.length ? Math.exp(sum(values.map(Math.log)) / values.length) : null;
const compact = r => Object.fromEntries(['task', 'accepted', 'delivered', 'strategy', 'selector', 'error', 'outcome', 'process_elapsed_ms',
  'implementation_ms', 'model_calls', 'equivalent_usd', 'catalog_usd', 'accounting_complete', 'tokens', 'repairs', 'review_accepted',
  'visible_accepted', 'candidate_hash', 'task_hash'].filter(k => k in r).map(k => [k, r[k]]));
const auditPath = join(root, 'posthoc-audits.json');
const audits = existsSync(auditPath) ? read(auditPath) : { required_tasks: [], results: [] };
const rows = [];
let references;
for (const name of readdirSync(root).sort()) {
  const run = join(root, name), mp = join(run, 'manifest.json');
  if (!existsSync(mp)) continue;
  const manifest = read(mp);
  if (manifest.comparison !== 'adaptive-sol-only-development') continue;
  const refs = read(join(run, 'references.json'));
  if (references && JSON.stringify(references) !== JSON.stringify(refs)) throw new Error('References changed between iterations');
  references = refs;
  const cells = [], pending = [];
  for (const [i, task] of manifest.schedule.entries()) {
    const directory = join(run, `${String(i).padStart(3, '0')}-${task}`), path = join(directory, 'result.json');
    if (!existsSync(path) || !Number.isFinite(read(path).process_elapsed_ms)) { pending.push(task); continue; }
    const result = read(path), ref = refs.find(r => r.task === task).result;
    if (result.task !== task || result.task_hash !== ref.task_hash || result.selector !== manifest.selector) throw new Error('Trial differs from frozen task or model');
    const delivered = result.accepted && !result.error && result.review_accepted === true && result.visible_accepted === true && result.executions?.at(-1)?.ok === true;
    if (delivered !== result.delivered) throw new Error('Invalid delivery flag');
    const posthoc = audits.results.find(r => r.run === name && r.task === task) ?? null;
    if (posthoc && posthoc.candidate_hash !== result.candidate_hash) throw new Error('Posthoc audit candidate differs');
    const qualified = delivered && posthoc?.passed !== false && (!audits.required_tasks.includes(task) || posthoc?.passed === true);
    cells.push({ ...compact(result), result_hash: hash(readFileSync(path)),
      posthoc, qualified_delivery: qualified,
      speed_ratio: ref.process_elapsed_ms / (qualified ? result.process_elapsed_ms : 1500000),
      stages: result.stages, operations: result.executions?.flatMap(e => e.operations),
      reviewer_findings: result.reviews?.flatMap(r => r.review.findings),
      hidden_summary: { ok: result.hidden?.ok, output_hash: hash(result.hidden?.output ?? '') } });
  }
  const seconds = sum(cells.map(r => r.process_elapsed_ms)) / 1000;
  const cost = knownSum(cells.map(r => r.equivalent_usd));
  const baselineSeconds = sum(refs.map(r => r.result.process_elapsed_ms)) / 1000;
  const baselineCost = knownSum(refs.map(r => r.result.equivalent_usd));
  const speed = geo(cells.map(r => r.speed_ratio));
  const complete = pending.length === 0;
  const delivered = cells.filter(r => r.delivered).length;
  const qualified = cells.filter(r => r.qualified_delivery).length;
  rows.push({ run: name, strategy: manifest.strategy, replay_of: manifest.replay_of,
    manifest_hash: hash(readFileSync(mp)), freeze_hash: hash(JSON.stringify(manifest.frozen_files)),
    runtime_hash: hash(JSON.stringify(manifest.frozen_files.filter(([p]) => /\.(mjs|md)$/.test(p) && !/test\.mjs$/.test(p)))),
    complete, n: cells.length, expected: manifest.schedule.length, accepted: cells.filter(r => r.accepted).length, delivered,
    qualified_delivered: qualified,
    seconds, equivalent_usd: cost, calls: knownSum(cells.map(r => r.model_calls)), tokens: knownSum(cells.map(r => r.tokens?.totalTokens)),
    failure_adjusted_speed_ratio: speed,
    beats_reference: complete && qualified === refs.length && seconds < baselineSeconds && cost !== null && baselineCost !== null && cost < baselineCost && speed > 1,
    cells, pending });
}
if (!references) throw new Error('No iterations');
for (const task of audits.required_tasks) {
  const ref = references.find(r => r.task === task)?.result;
  const audit = audits.reference_results?.find(r => r.task === task);
  if (!audit?.passed || audit.candidate_hash !== ref?.candidate_hash) throw new Error('Required posthoc audit does not validate native reference');
}
const repeatedWins = rows.filter(r => r.beats_reference && r.replay_of && rows.some(first =>
  first.run === r.replay_of && first.beats_reference && first.strategy === r.strategy && first.freeze_hash === r.freeze_hash))
  .map(r => ({ first: r.replay_of, repeat: r.run, freeze_hash: r.freeze_hash }));
const report = { schema_version: 1, label: 'adaptive development against historical native references',
  references: references.map(r => ({ task: r.task, source_cell: r.source_cell, result_hash: r.result_hash, ...compact(r.result), stages: r.result.stages })),
  baseline: { n: references.length, seconds: sum(references.map(r => r.result.process_elapsed_ms)) / 1000,
    equivalent_usd: knownSum(references.map(r => r.result.equivalent_usd)), calls: knownSum(references.map(r => r.result.model_calls)),
    tokens: knownSum(references.map(r => r.result.tokens?.totalTokens)) }, iterations: rows, repeated_wins: repeatedWins,
    posthoc_audits: { required_tasks: audits.required_tasks, artifact_hash: existsSync(auditPath) ? hash(readFileSync(auditPath)) : null } };
writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n');
const f = (n, digits = 2) => Number.isFinite(n) ? n.toFixed(digits) : 'unknown';
writeFileSync(output + '.md', ['# Sol-only development iterations', '',
  'Three exposed historical tasks, unchanged initial source and acceptance checks. The previous native Sol runs are reference measurements, not concurrent controls. All attempts are retained. Full delivery requires external checks, visible checks, review and successful execution.', '',
  '| Strategy / run | Recorded delivery | Including required posthoc audit | Total seconds | Equivalent USD | Calls | Tokens | Beats reference |',
  '|---|---:|---:|---:|---:|---:|---:|---|',
  `| Previous native Sol | 3/3 | reference | ${f(report.baseline.seconds)} | ${f(report.baseline.equivalent_usd, 5)} | ${report.baseline.calls} | ${report.baseline.tokens} | reference |`,
  ...rows.map(r => `| ${r.run} | ${r.delivered}/${r.expected}${r.complete ? '' : ' (running)'} | ${r.qualified_delivered}/${r.expected} | ${f(r.seconds)} | ${f(r.equivalent_usd, 5)} | ${r.calls ?? 'unknown'} | ${r.tokens ?? 'unknown'} | ${r.beats_reference ? 'yes' : 'no'} |`), '',
  'A win requires all three deliveries, lower total time and equivalent cost, and a geometric mean paired speed ratio above one. It must repeat with unchanged code. Failed tasks receive 1,500 seconds in that ratio. Actual elapsed totals include failed attempts and do not imply successful throughput. Sol is priced at DeepSeek rates; equivalent costs are not invoices.', '',
  'Known posthoc defects disqualify a win. Required posthoc checks must pass; an unrun audit is not a pass. Original recorded delivery and terminal outcomes remain unchanged.', '',
  repeatedWins.length ? `Repeated development win with identical frozen files: ${repeatedWins.map(r => `${r.first} and ${r.repeat}`).join('; ')}.` : 'No repeated development win yet.', '',
  ...rows.flatMap(r => [`## ${r.run}`, '',
      '| Task | Behavior checks | Recorded delivery | Required audit | Seconds | Calls | Equivalent USD |', '|---|---|---|---|---:|---:|---:|',
    ...r.cells.map(c => `| ${c.task} | ${c.accepted ? 'pass' : 'fail'} | ${c.delivered ? 'yes' : 'no'} | ${c.posthoc ? (c.posthoc.passed ? 'pass' : 'fail') : audits.required_tasks.includes(c.task) ? 'unrun' : 'not required'} | ${f(c.process_elapsed_ms / 1000)} | ${c.model_calls ?? 'unknown'} | ${f(c.equivalent_usd, 5)} |`), '',
    `Failure-adjusted geometric speed ratio: ${f(r.failure_adjusted_speed_ratio)}; above 1 favors changesets.`, '']),
  'See [ITERATION-PROTOCOL.md](ITERATION-PROTOCOL.md) for selection, stopping rules, accounting and interpretation limits.', ''].join('\n'));
console.log(JSON.stringify({ baseline: report.baseline, iterations: rows.map(({ cells, ...r }) => r) }));
