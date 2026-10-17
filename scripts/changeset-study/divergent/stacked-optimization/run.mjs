#!/usr/bin/env node
// Replay the retained run18 plans and briefs through the current worktree code under
// named dispatch variants. One sequential cell per variant and task; every result is
// retained. This is a research loop, not the frozen matched-comparison protocol.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const here = dirname(fileURLToPath(import.meta.url)), checkout = resolve(here, '../../../..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); if (i < 0) { if (fallback !== undefined) return fallback; throw new Error(`${name} required`); } return args[i + 1]; };
const reference = resolve(option('--reference')), output = resolve(option('--output'));
const variants = JSON.parse(readFileSync(resolve(option('--variants')), 'utf8'));
const tasks = option('--tasks', 'hard-context-calibration,hard-dependency-handoff,hard-lifecycle-extract').split(',');
const repeats = Number(option('--repeat', '1')), ledgerStopUsd = Number(option('--ledger-stop-usd', '12'));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const manifestRef = read(join(reference, 'manifest.json'));
const cells = ['000-hard-context-calibration', '001-hard-dependency-handoff', '002-hard-lifecycle-extract'];

if (existsSync(output)) throw new Error('Output must be new');
mkdirSync(join(output, 'frozen/scripts'), { recursive: true });
for (const folder of ['changeset-study', 'changeset', 'changeset-research']) cpSync(join(checkout, 'scripts', folder), join(output, 'frozen/scripts', folder), { recursive: true });
cpSync(join(reference, 'frozen/scripts/changeset-study/parser/acorn.mjs'), join(output, 'frozen/scripts/changeset-study/parser/acorn.mjs'));
const git = cmd => execFileSync('git', cmd, { cwd: checkout, encoding: 'utf8' }).trim();
const manifest = { schema_version: 1, protocol: 'stacked-optimization-replay-v1', created_at: new Date().toISOString(),
  revision: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean),
  reference, reference_revision: manifestRef.revision, ledger: manifestRef.ledger, node: process.version, variants, tasks, repeats,
  sdk_root: join(reference, manifestRef.sdk_root), jev_entry: join(reference, manifestRef.jev_entry), dependencies: join(reference, manifestRef.dependencies.path),
  note: 'Replays retained Sol plans and DeepSeek briefs; no owner or planner calls. Hidden grading is the delivery oracle. Single observations per cell unless repeated.' };
write(join(output, 'manifest.json'), manifest);

const ledgerCharged = () => read(manifest.ledger).entries.reduce((n, e) => n + (e.charged_usd ?? e.reserved_usd ?? 0), 0);
const rows = [];
function summarize(directory, result) {
  const stages = Object.fromEntries((result.stages ?? []).map(s => [s.name, (s.elapsed_ms ?? 0) / 1000 + (0)]));
  const stageSum = name => (result.stages ?? []).filter(s => s.name === name).reduce((n, s) => n + s.elapsed_ms, 0) / 1000;
  const execution = result.executions?.[0];
  const attempts = result.writer_attempts ?? [];
  const flat = attempts.flatMap(a => a.attempts.map(x => ({ ...x, operation_id: a.operation_id, routed: a.format ?? 'v4a' })));
  return {
    accepted: result.accepted === true, visible: result.visible_accepted === true, application_complete: execution?.ok === true,
    error: result.error ?? null, grading_error: result.grading_error ?? null,
    writing_s: stageSum('context-routing') + stageSum('optimization') + stageSum('execution'), execution_s: stageSum('execution'),
    preprocessing_s: stageSum('context-routing') + stageSum('optimization'), visible_s: stageSum('visible-check'), hidden_s: stageSum('terminal-grading'),
    process_s: (result.process_elapsed_ms ?? result.total_ms ?? 0) / 1000,
    calls: result.model_calls ?? null, calls_including_routing: result.calls_including_routing ?? result.model_calls ?? null,
    usd: result.equivalent_usd ?? null, tokens: result.tokens ?? null,
    assignments: result.optimization_metrics ? [result.optimization_metrics.before.assignments, result.optimization_metrics.after.assignments] : null,
    dependency_depth: result.optimization_metrics ? [result.optimization_metrics.before.dependency_depth, result.optimization_metrics.after.dependency_depth] : null,
    pruned_dependencies: result.optimization_metrics?.pruned_dependencies?.length ?? 0,
    peak_concurrency: execution?.metrics?.peak_concurrency ?? null,
    operations: (execution?.operations ?? []).map(o => ({ id: o.id, status: o.status, elapsed_s: (o.elapsed_ms ?? 0) / 1000, error: o.error ?? null })),
    writer: { v4a_primary_ok: flat.filter(x => x.format === 'v4a' && x.writer_attempt === 0 && x.applied && x.syntax_valid !== false).length,
      v4a_primary: flat.filter(x => x.format === 'v4a' && x.writer_attempt === 0).length,
      json_routed: attempts.filter(a => a.format === 'json').length, json_routed_ok: attempts.filter(a => a.format === 'json' && a.attempts.every(x => x.applied)).length,
      fallbacks: existsSync(join(directory, 'requests.jsonl')) ? readFileSync(join(directory, 'requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.writer_attempt === 1).length : 0 },
    routing: result.routing ? { attempted: result.routing.attempted, fallback: result.routing.fallback ?? null, elapsed_s: (result.routing.elapsed_ms ?? 0) / 1000 } : null,
    hidden_tail: typeof result.hidden?.output === 'string' ? result.hidden.output.slice(-600) : null,
  };
}
function report() {
  const byVariant = {};
  for (const row of rows) (byVariant[row.variant] ??= []).push(row);
  const lines = ['# Stacked optimization replay', '', `Revision ${manifest.revision}${manifest.dirty.length ? ' (dirty worktree)' : ''}; reference ${basename(reference)}; node ${manifest.node}.`, '',
    '| Variant | Repeat | Task | Applied | Visible | Hidden | Writing s | Exec s | Calls | In / Out / Cache | USD | Assign | Depth | Peak | V4A ok | JSON ok | Fallbacks |', '| --- | ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | --- | ---: |'];
  for (const row of rows) { const s = row.summary; lines.push(`| ${row.variant} | ${row.repeat} | ${row.task} | ${s.application_complete ? 'pass' : 'FAIL'} | ${s.visible ? 'pass' : 'fail'} | ${s.accepted ? 'pass' : 'fail'} | ${s.writing_s.toFixed(3)} | ${s.execution_s.toFixed(3)} | ${s.calls_including_routing} | ${s.tokens ? `${s.tokens.input} / ${s.tokens.output} / ${s.tokens.cacheRead}` : ''} | ${s.usd?.toFixed(6) ?? ''} | ${s.assignments ? s.assignments.join('→') : ''} | ${s.dependency_depth ? s.dependency_depth.join('→') : ''} | ${s.peak_concurrency ?? ''} | ${s.writer.v4a_primary_ok}/${s.writer.v4a_primary} | ${s.writer.json_routed_ok}/${s.writer.json_routed} | ${s.writer.fallbacks} |`); }
  lines.push('', '| Variant | Repeat | Delivered | Applied | Writing s (sum) | Calls | Input | Output | Cache read | Total tokens | USD |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [variant, list] of Object.entries(byVariant)) for (const repeat of [...new Set(list.map(r => r.repeat))]) {
    const group = list.filter(r => r.repeat === repeat), sum = key => group.reduce((n, r) => n + (r.summary[key] ?? 0), 0), tok = key => group.reduce((n, r) => n + (r.summary.tokens?.[key] ?? 0), 0);
    lines.push(`| ${variant} | ${repeat} | ${group.filter(r => r.summary.accepted).length}/${group.length} | ${group.filter(r => r.summary.application_complete).length}/${group.length} | ${sum('writing_s').toFixed(3)} | ${sum('calls_including_routing')} | ${tok('input')} | ${tok('output')} | ${tok('cacheRead')} | ${tok('totalTokens')} | ${sum('usd').toFixed(6)} |`);
  }
  writeFileSync(join(output, 'results.md'), lines.join('\n') + '\n');
  write(join(output, 'results.json'), { manifest: { ...manifest, variants: undefined }, variants, rows });
}
for (let repeat = 1; repeat <= repeats; repeat++) for (const [variant, config] of Object.entries(variants)) for (const task of tasks) {
  const cell = cells.find(name => name.endsWith(task)), input = join(reference, 'inputs', cell);
  // The reference trial job already carries the replay provenance (plan/brief hashes and inherited granularity).
  const original = read(join(reference, `${cells.indexOf(cell)}-${task}-combined`, 'job.json'));
  const directory = join(output, repeats > 1 ? `${variant}/r${repeat}` : variant, task); mkdirSync(directory, { recursive: true });
  const profile = config.profile === null ? null : config.profile ?? 'optimized-v4a';
  const job = { task: original.task, arm: 'changeset', strategy: 'owner-query-writer', selector: original.selector, editorSelector: original.editorSelector, writerRecoverySelector: null,
    ledger: manifest.ledger, directory, mounts: [[manifest.dependencies, manifestRef.dependencies.target]], plannerPrompt: original.plannerPrompt,
    optimization: profile ? 'contextual' : 'none', dispatchProfile: profile, dispatchOptions: profile ? (config.options ?? null) : null,
    queryMode: 'catalog-lookup', queryGranularity: 'smaller-regions', preparedBrief: original.preparedBrief, preparedPlan: original.preparedPlan,
    planningSource: original.planningSource, briefSource: original.briefSource };
  write(join(directory, 'job.json'), job);
  const before = ledgerCharged();
  if (before > ledgerStopUsd) throw new Error(`Ledger charged ${before} exceeds stop ${ledgerStopUsd}`);
  const began = performance.now();
  const outcome = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(output, 'frozen/scripts/changeset-study/worker.mjs'), join(directory, 'job.json')], {
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      env: { ...process.env, CHANGESET_STUDY_SDK_ROOT: manifest.sdk_root, CHANGESET_MODEL_RUNTIME: join(manifest.sdk_root, 'pi-coding-agent/dist/core/model-runtime.js'), JEV_TYPESAFE_MODULE: manifest.jev_entry } });
    let text = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { text = (text + chunk).slice(-12000); });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, job.task.limits.cell_ms + (job.task.limits.grade_ms ?? 0) + 30000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); done({ code, output: text }); });
  });
  write(join(directory, 'worker-exit.json'), outcome);
  const path = join(directory, 'result.json');
  const result = existsSync(path) ? read(path) : { error: outcome.output };
  result.process_elapsed_ms ??= performance.now() - began;
  const summary = summarize(directory, result);
  rows.push({ variant, repeat, task, directory: relative(output, directory), summary, ledger_delta_usd: ledgerCharged() - before });
  console.log(JSON.stringify({ variant, repeat, task, applied: summary.application_complete, visible: summary.visible, hidden: summary.accepted, writing_s: Number(summary.writing_s.toFixed(3)), calls: summary.calls_including_routing, tokens: summary.tokens, usd: summary.usd, error: summary.error }));
  report();
}
console.log(JSON.stringify({ completed: output, ledger_charged_usd: ledgerCharged() }));
