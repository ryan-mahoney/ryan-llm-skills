#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { auditEvidence } from './audit.mjs';
import { validateTasks } from '../deepseek-direct/runner.mjs';
import { hash, inside, inventory, prospective, read, rows, same, taskIds, validateLedger, write } from '../writer-control/support.mjs';
import { arms, muse, museModel, mimo, mimoModel, sol, deepseek, checkLedgerState } from './policy.mjs';
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const cellName = (index, id) => `${String(index).padStart(3, '0')}-${id}`;
const sdkPins = sdk => Object.fromEntries(['pi-agent-core', 'pi-coding-agent', 'pi-ai'].map(pkg => [pkg, inventory(join(sdk, pkg, 'dist'))]));
export function prepare({ source, output, ledger, parser, sdk, codeRoot = checkout }) {
  source = realpathSync(source); codeRoot = realpathSync(codeRoot); parser = realpathSync(parser); sdk = realpathSync(sdk); output = prospective(output);
  ledger = validateLedger(ledger).path; checkLedgerState(read(ledger));
  const donor = read(join(source, 'manifest.json')), taskBytes = readFileSync(join(source, 'tasks.json')), tasks = JSON.parse(taskBytes);
  if (!/^03-/.test(basename(source)) || hash(taskBytes) !== donor.tasks_hash) throw new Error('Require original unchanged run03 tasks');
  validateTasks(tasks, donor, source);
  const jobs = taskIds.map((id, index) => read(join(source, cellName(index, id), 'job.json')));
  if (jobs.some(job => validateLedger(job.ledger).path !== ledger || !same(job.mounts, jobs[0].mounts))) throw new Error('Canonical donor ledger/mount identities differ');
  const mounts = jobs[0].mounts, modules = realpathSync(resolve(sdk, '..'));
  const inputs = [source, codeRoot, modules, parser, ...mounts.map(([path]) => realpathSync(path))];
  if (existsSync(output) || inputs.some(path => inside(path, output) || inside(output, path)) || inside(output, ledger)) throw new Error('New output must be outside source/code/SDK/mounts/ledger');
  if (!same(sdkPins(sdk), donor.sdk_files)) throw new Error('SDK distribution pins differ from donor03');
  const deps = mounts.map(([path]) => inventory(path));
  if (hash(JSON.stringify(deps[0])) !== donor.dependencies_hash) throw new Error('Dependency pins differ from donor03');
  const code = Object.fromEntries(['changeset-study', 'changeset', 'changeset-research'].map(folder => [folder, inventory(join(codeRoot, 'scripts', folder))]));
  const sdkFiles = inventory(modules), manifestHash = hash(readFileSync(join(source, 'manifest.json')));
  mkdirSync(join(output, 'frozen/scripts'), { recursive: true });
  for (const folder of Object.keys(code)) cpSync(join(codeRoot, 'scripts', folder), join(output, 'frozen/scripts', folder), { recursive: true });
  mkdirSync(join(output, 'frozen/scripts/changeset-study/parser'), { recursive: true }); cpSync(parser, join(output, 'frozen/scripts/changeset-study/parser/acorn.mjs'));
  mkdirSync(join(output, 'frozen/skills/spec-changeset-plan'), { recursive: true }); cpSync(join(codeRoot, 'skills/spec-changeset-plan/SKILL.md'), join(output, 'frozen/skills/spec-changeset-plan/SKILL.md'));
  cpSync(modules, join(output, 'sdk/node_modules'), { recursive: true, verbatimSymlinks: true });
  const frozenMounts = mounts.map(([path, target], index) => { const destination = join(output, 'dependencies', String(index)); mkdirSync(dirname(destination), { recursive: true }); cpSync(path, destination, { recursive: true, verbatimSymlinks: true }); return [destination, target]; });
  if (!same(inventory(modules), sdkFiles) || !same(inventory(join(output, 'sdk/node_modules')), sdkFiles) ||
      !same(Object.fromEntries(Object.keys(code).map(folder => [folder, inventory(join(codeRoot, 'scripts', folder))])), code) ||
      !same(mounts.map(([path]) => inventory(path)), deps) || !same(frozenMounts.map(([path]) => inventory(path)), deps) ||
      hash(readFileSync(join(source, 'manifest.json'))) !== manifestHash || hash(readFileSync(join(source, 'tasks.json'))) !== hash(taskBytes)) throw new Error('Freeze input changed during copy; retain incomplete output');
  mkdirSync(join(output, 'frozen/input-provenance'), { recursive: true });
  writeFileSync(join(output, 'frozen/input-provenance/donor-manifest.json'), readFileSync(join(source, 'manifest.json')));
  write(join(output, 'frozen/input-provenance/donor-task-hashes.json'), jobs.map(job => hash(JSON.stringify(job.task))));
  const models = [{ selector: muse, model: { ...museModel, provider: 'openrouter' } }, { selector: mimo, model: { ...mimoModel, provider: 'primalabs' } }, ...[sol, deepseek].map(selector => donor.models.find(row => row.selector === selector))];
  if (models.some(row => !row?.model)) throw new Error('Donor model metadata missing');
  writeFileSync(join(output, 'tasks.json'), taskBytes);
  const requestDirectories = taskIds.flatMap((id, index) => [
    ...['muse-executable', 'muse-delegated', 'sol-delegated'].map(prep => `preparation/${prep}/${cellName(index, id)}`),
    ...arms.map(arm => `${arm.id}/${cellName(index, id)}`)]);
  const manifest = { schema_version: 1, protocol: 'model-permutations-v1', status: 'prepared', created_at: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: codeRoot, encoding: 'utf8' }).trim(), source_run: basename(source), source_manifest_hash: manifestHash,
    tasks_hash: hash(taskBytes), task_hashes: jobs.map(job => hash(JSON.stringify(job.task))), schedule: taskIds, arms, models,
    frozen_files: inventory(join(output, 'frozen')), sdk_files: sdkFiles, sdk_root: 'sdk/node_modules/@earendil-works', dependency_files: deps, mounts: frozenMounts,
    ledger, node_hash: hash(readFileSync(process.execPath)), node: process.version, request_directories: requestDirectories,
    incremental_exposure_stop_usd: 15, preparation_policy: 'One paid Sol delegated plan per task shared exactly by both Sol-led arms; actual prep once, full allocation to each route.',
    policy_differences: ['Muse self returns deterministic edits; delegated plans use focused bounded writers.', 'Sol output cap is requested but subscription adapter does not enforce it; conservative ledger reserve unchanged.', 'No model review or repair after dispatch; terminal grade remains separate.'] };
  write(join(output, 'manifest.json'), manifest); return { output, status: 'prepared' };
}
export function prepareResume({ resumeFrom, ...options }) {
  resumeFrom = realpathSync(resumeFrom);
  if (inside(resumeFrom, prospective(options.output))) throw new Error('Resume output must be outside the original run');
  const original = verify(resumeFrom), oldRows = read(join(resumeFrom, 'results.json')).rows;
  if (oldRows.length !== 12 || !existsSync(join(resumeFrom, 'started.json'))) throw new Error('Resume requires the terminal original twelve-row campaign');
  const originalManifestHash = hash(readFileSync(join(resumeFrom, 'manifest.json')));
  const originalResultsHash = hash(readFileSync(join(resumeFrom, 'results.json')));
  const result = prepare(options), output = result.output, manifest = read(join(output, 'manifest.json'));
  if (manifest.tasks_hash !== original.tasks_hash || manifest.ledger !== original.ledger || !same(manifest.models, original.models)) throw new Error('Resume source/model/ledger identity differs');
  const preparations = [];
  for (const [index, id] of taskIds.entries()) {
    const relative = `preparation/sol-delegated/${cellName(index, id)}`, directory = join(resumeFrom, relative);
    const sourceRow = oldRows.find(row => row.arm === 'sol-mimo' && row.task === id), observed = sourceRow?.result;
    if (!sourceRow) throw new Error('Missing original MiMo observation');
    if (sourceRow.preparation_failed) {
      if (!same(read(join(directory, 'result.json')), sourceRow.preparation)) throw new Error('Failed preparation differs from original retained observation');
      const files = inventory(directory), destination = join(output, relative); mkdirSync(dirname(destination), { recursive: true }); cpSync(directory, destination, { recursive: true });
      if (!same(inventory(destination), files)) throw new Error('Inherited failed preparation changed during copy');
      preparations.push({ task: id, directory: relative, eligible: false, files, reason: 'Original shared Sol preparation failed; no new planning authorized' }); continue;
    }
    const prep = read(join(directory, 'result.json')), plan = read(join(directory, 'plan.json'));
    const museRow = oldRows.find(row => row.arm === 'sol-muse' && row.task === id);
    if (!same(prep, sourceRow.allocated_preparation) || (museRow?.result?.plan_hash && museRow.result.plan_hash !== prep.plan_hash)) throw new Error('Sol preparation differs from original retained paid plan');
    if (observed?.error !== 'Existing PrimaLabs credential configuration unavailable' || observed.model_calls !== 0 ||
        rows(join(resumeFrom, 'sol-mimo', cellName(index, id), 'requests.jsonl')).length !== 0 ||
        rows(join(resumeFrom, 'sol-mimo', cellName(index, id), 'receipts.jsonl')).length !== 0 ||
        rows(join(resumeFrom, 'sol-mimo', cellName(index, id), 'responses.jsonl')).length !== 0 ||
        prep.error || prep.selector !== sol || prep.plan_hash !== hash(JSON.stringify(plan)) || prep.task_hash !== original.task_hashes[index]) throw new Error('Resume is restricted to zero-call credential blocks with exact Sol preparations');
    const files = inventory(directory), destination = join(output, relative); mkdirSync(dirname(destination), { recursive: true }); cpSync(directory, destination, { recursive: true });
    if (!same(inventory(destination), files) || !same(inventory(directory), files)) throw new Error('Inherited preparation changed during copy');
    preparations.push({ task: id, directory: relative, eligible: true, files, plan_hash: prep.plan_hash, model_calls: prep.model_calls, process_elapsed_ms: prep.process_elapsed_ms });
  }
  manifest.resume = { source: resumeFrom, original_manifest_hash: originalManifestHash, original_results_hash: originalResultsHash,
    original_revision: original.revision, active_arms: ['sol-mimo'], preparations,
    accounting: 'Copied Sol preparation is inherited, paid once in the original campaign; fully allocated to this route but excluded from new actual campaign requests.' };
  manifest.request_directories = taskIds.map((id, index) => `sol-mimo/${cellName(index, id)}`);
  if (hash(readFileSync(join(resumeFrom, 'manifest.json'))) !== originalManifestHash || hash(readFileSync(join(resumeFrom, 'results.json'))) !== originalResultsHash) throw new Error('Original campaign changed during resume preparation');
  write(join(output, 'manifest.json'), manifest); return { output, status: 'prepared-resume' };
}
export function verify(output) {
  const manifest = read(join(output, 'manifest.json'));
  checkLedgerState(validateLedger(manifest.ledger).state);
  const donor = read(join(output, 'frozen/input-provenance/donor-manifest.json'));
  const tasks = read(join(output, 'tasks.json'));
  if (manifest.source_manifest_hash !== hash(readFileSync(join(output, 'frozen/input-provenance/donor-manifest.json'))) ||
      manifest.tasks_hash !== donor.tasks_hash || !same(tasks.map(task => { const clean = structuredClone(task); delete clean.gold; return hash(JSON.stringify(clean)); }), read(join(output, 'frozen/input-provenance/donor-task-hashes.json'))) ||
      !same(manifest.models, [{ selector: muse, model: { ...museModel, provider: 'openrouter' } }, { selector: mimo, model: { ...mimoModel, provider: 'primalabs' } }, ...[sol, deepseek].map(selector => donor.models.find(row => row.selector === selector))])) throw new Error('Original source/model identities changed');
  if (manifest.protocol !== 'model-permutations-v1' || !same(manifest.arms, arms) || hash(readFileSync(process.execPath)) !== manifest.node_hash ||
      hash(readFileSync(join(output, 'tasks.json'))) !== manifest.tasks_hash || !same(inventory(join(output, 'frozen')), manifest.frozen_files) ||
      !same(inventory(join(output, 'sdk/node_modules')), manifest.sdk_files) || manifest.mounts.some(([path], index) => !inside(output, realpathSync(path)) || !same(inventory(path), manifest.dependency_files[index])) ||
      validateLedger(manifest.ledger).path !== manifest.ledger) throw new Error('Frozen snapshot or shared ledger identity changed');
  if (manifest.resume) {
    const inherited = manifest.resume;
    if (!same(inherited.active_arms, ['sol-mimo']) || hash(readFileSync(join(inherited.source, 'manifest.json'))) !== inherited.original_manifest_hash ||
        hash(readFileSync(join(inherited.source, 'results.json'))) !== inherited.original_results_hash) throw new Error('Original resume provenance changed');
    for (const prep of inherited.preparations.filter(row => row.files)) if (!same(inventory(join(output, prep.directory)), prep.files) ||
      !same(inventory(join(inherited.source, prep.directory)), prep.files)) throw new Error('Exact inherited Sol preparation changed');
  }
  return manifest;
}
async function child(args, env, timeoutMs) {
  return new Promise((done, reject) => {
    const processChild = spawn(process.execPath, args, { env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; for (const stream of [processChild.stdout, processChild.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
    const timer = setTimeout(() => { try { process.kill(-processChild.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    processChild.on('error', error => { clearTimeout(timer); reject(error); }); processChild.on('close', code => { clearTimeout(timer); done({ code, output }); });
  });
}
export async function run(output) {
  output = realpathSync(output); const m = verify(output);
  if (realpathSync(fileURLToPath(import.meta.url)) !== realpathSync(join(output, 'frozen/scripts/changeset-study/divergent/model-permutations/runner.mjs'))) throw new Error('Execute frozen runner');
  writeFileSync(join(output, 'started.json'), JSON.stringify({ at: new Date().toISOString() }) + '\n', { flag: 'wx' });
  const sdk = join(output, m.sdk_root), env = { CHANGESET_STUDY_SDK_ROOT: sdk, CHANGESET_MODEL_RUNTIME: join(sdk, 'pi-coding-agent/dist/core/model-runtime.js') };
  const worker = join(output, 'frozen/scripts/changeset-study/divergent/model-permutations/worker.mjs'), tasks = read(join(output, 'tasks.json')), summary = [];
  const invoke = async (job, allowance) => { verify(output); mkdirSync(job.directory, { recursive: true }); write(join(job.directory, 'job.json'), job); const began = performance.now(), observed = await child([worker, join(job.directory, 'job.json')], env, allowance + 35000);
    const result = existsSync(join(job.directory, 'result.json')) ? read(join(job.directory, 'result.json')) : { error: 'Worker failed without result: ' + observed.output, model_calls: rows(join(job.directory, 'requests.jsonl')).length };
    result.process_elapsed_ms = performance.now() - began;
    result.evidence = auditEvidence(job.directory, job, result);
    if (!result.evidence.valid) { result.audited_delivered = false; result.error ??= 'Evidence audit failed: ' + result.evidence.errors.join('; '); }
    write(join(job.directory, 'result.json'), result); return result; };
  for (const [index, original] of tasks.entries()) {
    const task = structuredClone(original); delete task.gold;
    const preparations = new Map();
    for (const arm of m.arms.filter(arm => !m.resume || m.resume.active_arms.includes(arm.id))) {
      if (arm.blocked) { summary.push({ arm: arm.id, task: task.id, blocked: arm.blocked }); continue; }
      let preparation = preparations.get(arm.prep), prepDirectory = join(output, 'preparation', arm.prep, cellName(index, task.id));
      if (!preparation && m.resume) {
        const inherited = m.resume.preparations.find(row => row.task === task.id);
        if (!inherited?.eligible) { summary.push({ arm: arm.id, task: task.id, preparation_failed: true, blocked: inherited?.reason ?? 'Missing inherited preparation' }); continue; }
        preparation = read(join(prepDirectory, 'result.json')); preparations.set(arm.prep, preparation);
      }
      if (!preparation) {
        preparation = await invoke({ mode: 'plan', directory: prepDirectory, task, selector: arm.planner, representation: arm.representation, ledger: m.ledger, mounts: m.mounts, campaign: output }, task.limits.cell_ms);
        preparations.set(arm.prep, preparation);
      }
      if (preparation.error) { summary.push({ arm: arm.id, task: task.id, preparation_failed: true, preparation }); continue; }
      const directory = join(output, arm.id, cellName(index, task.id));
      const observed = await invoke({ mode: 'execute', directory, task, selector: arm.writer ?? arm.planner, planner: arm.planner, representation: arm.representation,
        ledger: m.ledger, mounts: m.mounts, campaign: output, preparation_directory: prepDirectory, preparation: { model_calls: preparation.model_calls, elapsed_ms: preparation.process_elapsed_ms } }, task.limits.cell_ms - preparation.process_elapsed_ms + task.limits.grade_ms);
      if (task.id === 'hard-dependency-handoff' && existsSync(join(directory, 'candidate.json'))) {
        const began = performance.now(), auditPath = join(directory, 'path-audit.json');
        await child([join(output, 'frozen/scripts/changeset-study/path-audit.mjs'), join(directory, 'candidate.json'), join(output, 'frozen/scripts/changeset-study/parser/acorn.mjs'), auditPath], env, 30000);
        observed.path_audit = existsSync(auditPath) ? read(auditPath) : { passed: false };
        observed.path_audit_ms = performance.now() - began;
        observed.audited_delivered = observed.audited_delivered && observed.path_audit.passed && observed.path_audit.candidate_hash === observed.candidate_hash;
        write(join(directory, 'result.json'), observed);
      }
      summary.push({ arm: arm.id, task: task.id, preparation_directory: `preparation/${arm.prep}/${cellName(index, task.id)}`,
        preparation_actual_charge_once: true, allocated_preparation: preparation, result: observed });
      write(join(output, 'results.json'), { protocol: m.protocol, rows: summary });
    }
  }
  write(join(output, 'results.json'), { protocol: m.protocol, rows: summary }); return { completed_rows: summary.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const [command, ...args] = process.argv.slice(2); const options = {};
    for (let index = 0; index < args.length; index += 2) { const key = args[index], name = key === '--resume-from' ? 'resumeFrom' : key.slice(2); if (!['--source', '--output', '--ledger', '--parser', '--sdk', '--resume-from'].includes(key) || options[name] || !args[index + 1]) throw new Error('Unique named options required'); options[name] = args[index + 1]; }
    const result = command === 'prepare-resume' ? prepareResume(options) : command === 'prepare' ? prepare(options) : command === 'verify' ? verify(realpathSync(options.output)) : command === 'run' ? await run(options.output) : (() => { throw new Error('Use prepare/verify/run'); })(); console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
