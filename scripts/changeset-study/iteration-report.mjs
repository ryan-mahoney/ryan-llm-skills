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
    cells.push({ ...compact(result), result_hash: hash(readFileSync(path)),
      speed_ratio: ref.process_elapsed_ms / (delivered ? result.process_elapsed_ms : 1500000),
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
  rows.push({ run: name, strategy: manifest.strategy, manifest_hash: hash(readFileSync(mp)),
    runtime_hash: hash(JSON.stringify(manifest.frozen_files.filter(([p]) => /\.(mjs|md)$/.test(p) && !/test\.mjs$/.test(p)))),
    complete, n: cells.length, expected: manifest.schedule.length, accepted: cells.filter(r => r.accepted).length, delivered,
    seconds, equivalent_usd: cost, calls: knownSum(cells.map(r => r.model_calls)), tokens: knownSum(cells.map(r => r.tokens?.totalTokens)),
    failure_adjusted_speed_ratio: speed,
    beats_reference: complete && delivered === refs.length && seconds < baselineSeconds && cost !== null && baselineCost !== null && cost < baselineCost && speed > 1,
    cells, pending });
}
if (!references) throw new Error('No iterations');
const report = { schema_version: 1, label: 'adaptive development against historical native references',
  references: references.map(r => ({ task: r.task, source_cell: r.source_cell, result_hash: r.result_hash, ...compact(r.result), stages: r.result.stages })),
  baseline: { n: references.length, seconds: sum(references.map(r => r.result.process_elapsed_ms)) / 1000,
    equivalent_usd: knownSum(references.map(r => r.result.equivalent_usd)), calls: knownSum(references.map(r => r.result.model_calls)),
    tokens: knownSum(references.map(r => r.result.tokens?.totalTokens)) }, iterations: rows };
writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n');
const f = (n, digits = 2) => Number.isFinite(n) ? n.toFixed(digits) : 'unknown';
writeFileSync(output + '.md', ['# Sol-only development iterations', '',
  'Three exposed historical tasks, unchanged initial source and acceptance checks. The previous native Sol runs are reference measurements, not concurrent controls. All attempts are retained. Full delivery requires external checks, visible checks, review and successful execution.', '',
  '| Strategy / run | Complete delivery | Total seconds | Equivalent USD | Calls | Tokens | Beats reference |',
  '|---|---:|---:|---:|---:|---:|---|',
  `| Previous native Sol | 3/3 | ${f(report.baseline.seconds)} | ${f(report.baseline.equivalent_usd, 5)} | ${report.baseline.calls} | ${report.baseline.tokens} | reference |`,
  ...rows.map(r => `| ${r.run} | ${r.delivered}/${r.expected}${r.complete ? '' : ' (running)'} | ${f(r.seconds)} | ${f(r.equivalent_usd, 5)} | ${r.calls ?? 'unknown'} | ${r.tokens ?? 'unknown'} | ${r.beats_reference ? 'yes' : 'no'} |`), '',
  'A win requires all three deliveries, lower total time and equivalent cost, and a geometric mean paired speed ratio above one. It must repeat with unchanged code. Failed tasks receive 1,500 seconds in that ratio. Actual elapsed totals include failed attempts and do not imply successful throughput. Sol is priced at DeepSeek rates; equivalent costs are not invoices.', '',
  ...rows.flatMap(r => [`## ${r.run}`, '',
    '| Task | Behavior checks | Delivered | Seconds | Calls | Equivalent USD |', '|---|---|---|---:|---:|---:|',
    ...r.cells.map(c => `| ${c.task} | ${c.accepted ? 'pass' : 'fail'} | ${c.delivered ? 'yes' : 'no'} | ${f(c.process_elapsed_ms / 1000)} | ${c.model_calls ?? 'unknown'} | ${f(c.equivalent_usd, 5)} |`), '',
    `Failure-adjusted geometric speed ratio: ${f(r.failure_adjusted_speed_ratio)}; above 1 favors changesets.`, '']),
  'See [ITERATION-PROTOCOL.md](ITERATION-PROTOCOL.md) for selection, stopping rules, accounting and interpretation limits.', ''].join('\n'));
console.log(JSON.stringify({ baseline: report.baseline, iterations: rows.map(({ cells, ...r }) => r) }));
