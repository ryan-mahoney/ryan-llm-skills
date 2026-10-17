#!/usr/bin/env node
// Adaptive development runs; each invocation freezes one strategy on three tasks.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { hash } from '../changeset/workspace.mjs';
import { sdkRoot } from './client.mjs';
import { recoverAccounting } from './accounting.mjs';
import { strategyNames, usesCandidateChecks, usesEditor, deliveredResult } from './strategies.mjs';
import { modelRuntime, parseSelector } from '../changeset/models.mjs';
import { buildRunRoles } from './run-roles.mjs';
import { resolveQueryGranularity } from './roles.mjs';
import { resolveDispatchProfile } from './dispatch-profile.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`${name} required`); return args[i + 1]; };
const repo = fileURLToPath(new URL('../..', import.meta.url));
const source = resolve(option('--source')), run = resolve(option('--output')), ledger = resolve(option('--ledger'));
const strategy = option('--strategy');
// spec-end-to-end names: the query planner is the strong owner (hard steps route to it),
// the writer is the editor model, and an explicit owner model owns the brief for other steps.
// --model remains the historical alias of --strong-owner-model.
if (args.includes('--model') && args.includes('--strong-owner-model')) throw new Error('Use --model or --strong-owner-model, not both');
const selector = args.includes('--strong-owner-model') ? option('--strong-owner-model') : option('--model');
let optimization = args.includes('--optimization') ? option('--optimization') : null;
const plansFrom = args.includes('--plans-from') ? resolve(option('--plans-from')) : null;
const briefsFrom = args.includes('--briefs-from') ? resolve(option('--briefs-from')) : null;
let queryMode = args.includes('--query-mode') ? option('--query-mode') : null;
if (plansFrom && briefsFrom) throw new Error('--plans-from and --briefs-from are mutually exclusive');
let requestedQueryGranularity = args.includes('--query-granularity') ? option('--query-granularity') : null;
const editorSelector = args.includes('--editor-model') ? option('--editor-model') : null;
if (usesEditor(strategy) !== Boolean(editorSelector)) throw new Error('Use --editor-model only and always with an owner-editor strategy');
const writerRecoverySelector = args.includes('--writer-recovery-model') ? option('--writer-recovery-model') : null;
const dispatchProfile = args.includes('--dispatch-profile') ? option('--dispatch-profile') : null;
const ownerSelector = args.includes('--owner-model') ? option('--owner-model') : null;
const specRoles = { owner_model: ownerSelector ?? editorSelector, strong_owner_model: selector, editor_model: editorSelector };
if (ownerSelector && (strategy !== 'owner-query-writer' || plansFrom || briefsFrom)) throw new Error('--owner-model requires owner-query-writer with fresh briefs');
const dispatch = resolveDispatchProfile({ dispatchProfile, strategy, selector, editorSelector, writerRecoverySelector,
  optimization, queryMode, queryGranularity: requestedQueryGranularity });
({ optimization, queryMode, queryGranularity: requestedQueryGranularity } = dispatch);
if (!['none', 'deterministic', 'contextual'].includes(optimization)) throw new Error('Unknown optimization');
if (!['discovery', 'catalog', 'catalog-lookup'].includes(queryMode)) throw new Error('Unknown query mode');
if ((queryMode.startsWith('catalog') || briefsFrom) && strategy !== 'owner-query-writer') throw new Error('Catalog queries and shared briefs require owner-query-writer');
if (writerRecoverySelector) {
  const primary = parseSelector(editorSelector ?? ''), recovery = parseSelector(writerRecoverySelector);
  if (strategy !== 'owner-query-writer' || primary.provider !== 'deepseek' || primary.reasoning !== 'off' ||
      recovery.provider !== primary.provider || recovery.id !== primary.id || recovery.reasoning !== 'low') {
    throw new Error('--writer-recovery-model requires owner-query-writer with the same DeepSeek model :off -> :low');
  }
}
const replay = args.includes('--freeze-from') ? resolve(option('--freeze-from')) : null;
const codeRoot = replay ? join(replay, 'frozen') : repo;
if (!strategyNames.includes(strategy)) throw new Error('Unknown strategy');
if (!relative(repo, run).startsWith('..') || existsSync(run)) throw new Error('Output must be new and outside checkout');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
function files(root) {
  const rows = [];
  function scan(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) scan(join(dir, entry.name), path + '/');
      else if (entry.isFile()) rows.push([path, hash(readFileSync(join(dir, entry.name)))]);
    }
  }
  scan(root); return rows;
}
const equal = (a, b) => hash(JSON.stringify(a)) === hash(JSON.stringify(b));
const sdk = sdkRoot();
const sdkFiles = () => Object.fromEntries(['pi-agent-core', 'pi-coding-agent', 'pi-ai'].map(pkg => [pkg, files(join(sdk, pkg, 'dist'))]));
const original = read(join(source, 'manifest.json'));
if (hash(readFileSync(join(source, 'tasks.json'))) !== original.tasks_file_hash) throw new Error('Reference task bytes changed');
const replayManifest = replay ? read(join(replay, 'manifest.json')) : null;
const donorManifest = plansFrom || briefsFrom ? read(join(plansFrom ?? briefsFrom, 'manifest.json')) : null;
const queryGranularity = resolveQueryGranularity({ requested: requestedQueryGranularity,
  inherited: plansFrom ? donorManifest.query_granularity ?? 'default' : null, strategy, queryMode, optimization, dispatchProfile });
if (replayManifest && ((replayManifest.dispatch_profile ?? null) !== dispatchProfile || replayManifest.optimization !== optimization)) throw new Error('Replay dispatch profile or optimization differs');
if (replayManifest && (replayManifest.strategy !== strategy || replayManifest.selector !== selector || (replayManifest.editor_selector ?? null) !== editorSelector || (replayManifest.writer_recovery_selector ?? null) !== writerRecoverySelector || (replayManifest.query_mode ?? 'discovery') !== queryMode || (replayManifest.query_granularity ?? 'default') !== queryGranularity || !equal(files(codeRoot), replayManifest.frozen_files))) throw new Error('Replay strategy, selectors or frozen bytes differ');
const runRoles = buildRunRoles({ strategy, selector, editorSelector, ownerSelector, donorManifest });
if (original.comparison !== 'sol-native-vs-sol-nemotron-workflow' || original.models[0] !== selector) throw new Error('Use previous workflow run and identical Sol selector');
const selected = ['hard-context-calibration', 'hard-dependency-handoff', 'hard-lifecycle-extract'];
const tasks = read(join(source, 'tasks.json'));
const references = selected.map(task => {
  const name = readdirSync(source).find(name => name.endsWith(`-${task}-agent`));
  if (!name) throw new Error(`Missing native reference: ${task}`);
  const path = join(source, name, 'result.json'), result = read(path);
  if (!result.accepted || !Number.isFinite(result.process_elapsed_ms)) throw new Error('Reference is not a finalized pass');
  return { task, source_cell: name, result_hash: hash(readFileSync(path)), result };
});
// Validate every inherited brief and task before any inference can begin.
const inherited = new Map();
if (plansFrom || briefsFrom) {
  const donor = plansFrom ?? briefsFrom;
  for (const [index, id] of selected.entries()) {
    const task = structuredClone(tasks.find(t => t.id === id)); delete task.gold;
    const sourceCell = join(donor, `${String(index).padStart(3, '0')}-${id}`);
    const resultBytes = readFileSync(join(sourceCell, 'result.json'));
    const sourceResult = JSON.parse(resultBytes);
    if (sourceResult.task_hash !== hash(JSON.stringify(task))) throw new Error('Shared brief task differs');
    const briefBytes = readFileSync(join(sourceCell, 'implementation-brief.md'));
    if (hash(briefBytes) !== sourceResult.implementation_brief_hash) throw new Error('Shared brief changed');
    const preparedBrief = briefBytes.toString('utf8');
    if (!Buffer.from(preparedBrief).equals(briefBytes)) throw new Error('Shared brief is not lossless UTF-8');
    const briefSource = { run: basename(donor), cell: basename(sourceCell), brief_hash: hash(briefBytes), result_hash: hash(resultBytes) };
    let preparedPlan = null, planningSource = null;
    if (plansFrom) {
      if ((sourceResult.query_granularity ?? 'default') !== queryGranularity) throw new Error('Inherited plan granularity differs from donor manifest');
      const planArtifact = existsSync(join(sourceCell, 'raw-plan.json')) ? 'raw-plan.json'
        : readdirSync(sourceCell).filter(name => /^planning-attempt-\d+\.json$/.test(name)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
      if (!planArtifact) throw new Error('No submitted query plan available for replay');
      const planBytes = readFileSync(join(sourceCell, planArtifact));
      preparedPlan = JSON.parse(planBytes);
      planningSource = { run: basename(donor), cell: basename(sourceCell), plan_hash: hash(planBytes), plan_artifact: planArtifact, result_hash: hash(resultBytes), query_granularity: queryGranularity };
    }
    inherited.set(id, { preparedBrief, briefSource, preparedPlan, planningSource });
  }
}
if (!equal(sdkFiles(), original.sdk_files) || !equal(files(original.mounts[0][0]), original.dependency_files)) throw new Error('SDK or dependencies differ from reference');
const runtime = await modelRuntime();
const models = [...new Set([selector, editorSelector, writerRecoverySelector, ownerSelector].filter(Boolean))].map(selected => {
  const { provider, id } = parseSelector(selected), model = runtime.getModel(provider, id);
  if (!model || !runtime.hasConfiguredAuth(provider)) throw new Error(`Unavailable model: ${selected}`);
  return { selector: selected, model };
});
if (replayManifest?.models && !equal(models, replayManifest.models)) throw new Error('Replay model metadata changed');
mkdirSync(join(run, 'frozen/scripts'), { recursive: true });
for (const folder of ['changeset-study', 'changeset', 'changeset-research']) cpSync(join(codeRoot, 'scripts', folder), join(run, 'frozen/scripts', folder), { recursive: true });
mkdirSync(join(run, 'frozen/skills/spec-changeset-plan'), { recursive: true });
cpSync(join(codeRoot, 'skills/spec-changeset-plan/SKILL.md'), join(run, 'frozen/skills/spec-changeset-plan/SKILL.md'));
if (usesCandidateChecks(strategy) && !replay) {
  const parser = resolve(option('--parser'));
  mkdirSync(join(run, 'frozen/scripts/changeset-study/parser'), { recursive: true });
  cpSync(parser, join(run, 'frozen/scripts/changeset-study/parser/acorn.mjs'));
}
const frozen = files(join(run, 'frozen'));
if (replayManifest && !equal(frozen, replayManifest.frozen_files)) throw new Error('Replay freeze changed');
write(join(run, 'tasks.json'), selected.map(id => tasks.find(t => t.id === id)));
write(join(run, 'references.json'), references);
const manifest = { schema_version: 1, comparison: strategy === 'owner-query-writer' ? 'deepseek-owner-sol-query-deepseek-writer' : editorSelector ? 'sol-owner-deepseek-editor' : 'adaptive-sol-only-development', exploratory: true, strategy, selector,
  editor_selector: editorSelector, writer_recovery_selector: writerRecoverySelector, owner_selector: ownerSelector, spec_roles: specRoles, models, optimization, query_mode: queryMode, query_granularity: queryGranularity,
  ...(dispatchProfile ? { dispatch_profile: dispatchProfile, writer_format: dispatch.writerFormat } : {}),
  plans_from: plansFrom ? basename(plansFrom) : null, briefs_from: briefsFrom ? basename(briefsFrom) : null,
  ...(runRoles ? { roles: runRoles } : {}),
  replay_of: replay ? basename(replay) : null,
  created_at: new Date().toISOString(), source_run: basename(source), source_manifest_hash: hash(readFileSync(join(source, 'manifest.json'))),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), node: process.version,
  schedule: selected, frozen_files: frozen, sdk_files: original.sdk_files, dependencies_hash: original.dependencies_hash,
  tasks_hash: hash(readFileSync(join(run, 'tasks.json'))), references_hash: hash(readFileSync(join(run, 'references.json'))),
  note: 'Adaptive development on exposed tasks. Baseline is retained historical native Sol, not a contemporaneous randomized control. Each strategy is frozen before inference. All attempts retained. No hidden feedback inside a trial.' };
write(join(run, 'manifest.json'), manifest);
console.log(JSON.stringify({ run, strategy, tasks: selected }));
let index = 0;
for (const id of selected) {
  if (!equal(files(join(run, 'frozen')), frozen) || !equal(sdkFiles(), original.sdk_files) || !equal(files(original.mounts[0][0]), original.dependency_files)) throw new Error('Frozen dependencies changed');
  const directory = join(run, `${String(index++).padStart(3, '0')}-${id}`); mkdirSync(directory);
  const task = structuredClone(tasks.find(t => t.id === id)); delete task.gold;
  const { preparedPlan = null, preparedBrief = null, planningSource = null, briefSource = null } = inherited.get(id) ?? {};
  const job = { task, optimization, queryMode, queryGranularity, dispatchProfile, ownerSelector, specRoles, preparedPlan, preparedBrief, planningSource, briefSource, arm: 'changeset', strategy, selector, editorSelector, writerRecoverySelector, ledger, directory, mounts: original.mounts,
    plannerPrompt: readFileSync(join(run, 'frozen/skills/spec-changeset-plan/SKILL.md'), 'utf8') };
  write(join(directory, 'job.json'), job);
  const began = performance.now(), cap = task.limits.cell_ms + task.limits.grade_ms;
  const outcome = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(run, 'frozen/scripts/changeset-study/worker.mjs'), join(directory, 'job.json')], {
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      env: { ...process.env, CHANGESET_STUDY_SDK_ROOT: sdk, CHANGESET_MODEL_RUNTIME: join(sdk, 'pi-coding-agent/dist/core/model-runtime.js') },
    });
    write(join(directory, 'process.json'), { pid: child.pid, started_at: new Date().toISOString() });
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000); });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, cap + 35000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); done({ code, output }); });
  });
  const path = join(directory, 'result.json');
  const result = existsSync(path) ? read(path) : { task: id, arm: 'changeset', strategy, selector, accepted: false, outcome: 'blocked', error: outcome.output };
  Object.assign(result, recoverAccounting(directory, ledger), { process_elapsed_ms: performance.now() - began });
  if (result.process_elapsed_ms > cap) { result.accepted = false; result.outcome = 'timed-out'; }
  result.capped_time_to_success_ms = result.accepted ? result.process_elapsed_ms : cap;
  result.delivered = deliveredResult(result);
  write(path, result);
  console.log(JSON.stringify({ index, task: id, accepted: result.accepted, delivered: result.delivered, seconds: result.process_elapsed_ms / 1000, calls: result.model_calls, equivalent_usd: result.equivalent_usd, error: result.error ?? null }));
  if (/Campaign budget exhausted|Budget ledger locked/.test(result.error ?? '') || read(ledger).entries.reduce((n, e) => n + (e.charged_usd ?? e.reserved_usd), 0) >= 49) throw new Error('Budget guard; remaining cells unrun');
}
console.log(JSON.stringify({ completed: run }));
