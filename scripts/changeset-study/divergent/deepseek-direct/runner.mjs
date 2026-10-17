#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, realpathSync, readlinkSync, lstatSync } from 'node:fs';
import { dirname, basename, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { hash, safePath } from '../../../changeset/workspace.mjs';
import { sdkRoot } from '../../client.mjs';
import { parseSelector } from '../../../changeset/models.mjs';
import { recoverAccounting } from '../../accounting.mjs';
import { deliveredResult } from '../../strategies.mjs';
import { overlayCell } from './overlay.mjs';

export const taskIds = Object.freeze(['hard-context-calibration', 'hard-dependency-handoff', 'hard-lifecycle-extract']);
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const same = (a, b) => hash(JSON.stringify(a)) === hash(JSON.stringify(b));
const checkout = fileURLToPath(new URL('../../../..', import.meta.url));
export function inventory(root) {
  const rows = [];
  function scan(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + entry.name, absolute = join(directory, entry.name);
      if (entry.isDirectory()) scan(absolute, path + '/');
      else if (entry.isFile()) rows.push([path, hash(readFileSync(absolute))]);
      else if (entry.isSymbolicLink()) {
        const target = readlinkSync(absolute), resolved = realpathSync(absolute);
        if (!inside(realpathSync(root), resolved)) throw new Error(`Snapshot symlink leaves its root: ${path}`);
        rows.push([path, { symlink: target }]);
      } else throw new Error(`Unsupported snapshot entry: ${path}`);
    }
  }
  scan(root); return rows;
}
const inside = (base, path) => { const rel = relative(base, path); return !rel || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel)); };
function prospective(path) {
  let ancestor = resolve(path), suffix = [];
  while (!existsSync(ancestor)) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  return join(realpathSync(ancestor), ...suffix);
}
export function validateLedger(path) {
  let canonical, state;
  try { canonical = realpathSync(path); state = read(canonical); }
  catch { throw new Error('An existing valid shared budget ledger is required'); }
  if (!state || state.schema_version !== 1 || state.limit_usd !== 50 || !Array.isArray(state.entries))
    throw new Error('Shared budget ledger must use schema 1, limit 50 and an entries array');
  const ids = new Set();
  for (const entry of state.entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
        typeof entry.selector !== 'string' || !entry.selector.includes('/') ||
        !Number.isFinite(entry.reserved_usd) || entry.reserved_usd <= 0 ||
        !['reserved', 'priced', 'unknown'].includes(entry.status) ||
        !(entry.charged_usd == null || Number.isFinite(entry.charged_usd) && entry.charged_usd >= 0) ||
        entry.status === 'priced' && !(Number.isFinite(entry.charged_usd) && entry.charged_usd >= 0))
      throw new Error('Shared budget ledger has an invalid reservation entry');
    ids.add(entry.id);
  }
  return { path: canonical, state };
}

export function validateModel(model) {
  const { provider, id, reasoning } = parseSelector(model);
  if (provider !== 'deepseek' || !id.startsWith('deepseek-') || reasoning !== 'off')
    throw new Error('This arm requires a direct deepseek/deepseek-* selector with :off; model mixing is forbidden');
  return model;
}
export function validateTasks(tasks, manifest, source) {
  if (!Array.isArray(tasks) || tasks.length !== 3 || !same(manifest.schedule, taskIds) ||
      manifest.comparison !== 'deepseek-owner-sol-query-deepseek-writer') throw new Error('Use the original three-role run03 source and its exact three hard tasks');
  for (const [index, id] of taskIds.entries()) {
    const task = tasks[index];
    if (task?.id !== id || !['prepared', 'discovery'].includes(task.context) || typeof task.spec !== 'string' || !task.spec.trim() ||
        typeof task.hidden !== 'string' || !task.hidden.trim() || typeof task.check !== 'string' || !task.check.trim() ||
        !task.files || typeof task.files !== 'object' || !Object.keys(task.files).length || !Array.isArray(task.protected))
      throw new Error(`Invalid frozen task: ${id}`);
    for (const [path, text] of Object.entries(task.files)) { safePath(path); if (typeof text !== 'string') throw new Error('Task source must be text'); }
    if (task.protected.some(path => !Object.hasOwn(task.files, path))) throw new Error('Protected path absent from task');
    for (const key of ['cell_ms', 'grade_ms', 'model_calls', 'max_output_tokens', 'call_ms', 'command_ms'])
      if (!Number.isInteger(task.limits?.[key]) || task.limits[key] < 1) throw new Error(`Missing positive task limit: ${key}`);
    const donor = join(source, `${String(index).padStart(3, '0')}-${id}`), job = read(join(donor, 'job.json'));
    const clean = structuredClone(task); delete clean.gold;
    if (!same(clean, job.task) || read(join(donor, 'result.json')).task_hash !== hash(JSON.stringify(clean))) throw new Error(`Donor task bytes differ: ${id}`);
  }
}

// Preparation is offline: no runtime construction, credentials, auth checks or inference.
export function prepare({ source, output, ledger, parser, model, sdk = sdkRoot(), codeRoot = checkout }) {
  for (const [key, value] of Object.entries({ source, output, ledger, parser, model })) if (typeof value !== 'string' || !value) throw new Error(`${key} is required`);
  validateModel(model);
  source = realpathSync(source); codeRoot = realpathSync(codeRoot); parser = realpathSync(parser); sdk = realpathSync(sdk);
  output = prospective(output); ledger = validateLedger(ledger).path;
  const sdkModules = realpathSync(resolve(sdk, '..'));
  const original = read(join(source, 'manifest.json')), taskBytes = readFileSync(join(source, 'tasks.json'));
  if (hash(taskBytes) !== original.tasks_hash) throw new Error('Source tasks file changed');
  const tasks = JSON.parse(taskBytes); validateTasks(tasks, original, source);
  const jobs = taskIds.map((id, index) => read(join(source, `${String(index).padStart(3, '0')}-${id}`, 'job.json')));
  if (jobs.some(job => typeof job.ledger !== 'string' || validateLedger(job.ledger).path !== ledger))
    throw new Error('Use the same canonical shared budget ledger as the donor jobs');
  const mounts = jobs[0].mounts;
  if (!Array.isArray(mounts) || !mounts.every(row => Array.isArray(row) && row.length === 2 && row.every(v => typeof v === 'string')) || jobs.some(job => !same(job.mounts, mounts))) throw new Error('Donor dependency mounts differ');
  const protectedRoots = [source, codeRoot, sdkModules, ...mounts.map(([path]) => realpathSync(path))];
  if (existsSync(output) || protectedRoots.some(path => inside(path, output)) || inside(output, ledger)) throw new Error('Output must be new, outside checkout/source/dependencies, with a separate ledger');
  if (!lstatSync(parser).isFile()) throw new Error('Parser must be a module file');
  const sourceManifestHash = hash(readFileSync(join(source, 'manifest.json')));
  const sdkBefore = inventory(sdkModules), dependencyBefore = mounts.map(([path]) => inventory(path));
  const sdkPins = Object.fromEntries(['pi-agent-core', 'pi-coding-agent', 'pi-ai'].map(pkg => [pkg, inventory(join(sdk, pkg, 'dist'))]));
  if (!same(sdkPins, original.sdk_files) || hash(JSON.stringify(dependencyBefore[0])) !== original.dependencies_hash) throw new Error('SDK or dependency pins differ from original source');
  const codeBefore = Object.fromEntries(['changeset-study', 'changeset', 'changeset-research'].map(folder => [folder, inventory(join(codeRoot, 'scripts', folder))]));
  const cellOriginal = readFileSync(join(codeRoot, 'scripts/changeset-study/cell.mjs'), 'utf8'), overlay = overlayCell(cellOriginal);
  mkdirSync(join(output, 'frozen/scripts'), { recursive: true });
  for (const folder of Object.keys(codeBefore)) cpSync(join(codeRoot, 'scripts', folder), join(output, 'frozen/scripts', folder), { recursive: true });
  mkdirSync(join(output, 'frozen/skills/spec-changeset-plan'), { recursive: true });
  cpSync(join(codeRoot, 'skills/spec-changeset-plan/SKILL.md'), join(output, 'frozen/skills/spec-changeset-plan/SKILL.md'));
  mkdirSync(join(output, 'frozen/scripts/changeset-study/parser'), { recursive: true });
  cpSync(parser, join(output, 'frozen/scripts/changeset-study/parser/acorn.mjs'));
  writeFileSync(join(output, 'frozen/scripts/changeset-study/cell.mjs'), overlay.source);
  writeFileSync(join(output, 'original-cell.mjs'), cellOriginal); write(join(output, 'cell-overlay.json'), overlay.metadata);
  cpSync(sdkModules, join(output, 'sdk/node_modules'), { recursive: true, verbatimSymlinks: true });
  const frozenMounts = mounts.map(([path, target], index) => {
    const destination = join(output, 'dependencies', String(index)); mkdirSync(dirname(destination), { recursive: true });
    cpSync(path, destination, { recursive: true, verbatimSymlinks: true }); return [destination, target];
  });
  if (hash(readFileSync(parser)) !== hash(readFileSync(join(output, 'frozen/scripts/changeset-study/parser/acorn.mjs'))) ||
      hash(readFileSync(join(source, 'manifest.json'))) !== sourceManifestHash ||
      hash(readFileSync(join(source, 'tasks.json'))) !== hash(taskBytes) ||
      !same(inventory(sdkModules), sdkBefore) || !same(inventory(join(output, 'sdk/node_modules')), sdkBefore) ||
      !same(Object.fromEntries(Object.keys(codeBefore).map(folder => [folder, inventory(join(codeRoot, 'scripts', folder))])), codeBefore) ||
      mounts.some(([path], index) => !same(inventory(path), dependencyBefore[index]) || !same(inventory(frozenMounts[index][0]), dependencyBefore[index])))
    throw new Error('An input changed during preparation; retain the incomplete output and prepare a new run');
  if (validateLedger(ledger).path !== ledger) throw new Error('Shared budget ledger identity changed during preparation');
  writeFileSync(join(output, 'tasks.json'), taskBytes);
  const manifest = { schema_version: 1, protocol: 'deepseek-direct-boundary-review-v1', status: 'prepared',
    created_at: new Date().toISOString(), exploratory: true, model, strategy: 'boundary-review', roles: { planner: model, boundary_reviewer: model, repair_planner: model },
    source_run: basename(source), source_manifest_hash: sourceManifestHash, tasks_hash: hash(taskBytes), schedule: taskIds,
    source_task_hashes: tasks.map(task => { const clean = structuredClone(task); delete clean.gold; return [task.id, hash(JSON.stringify(clean))]; }),
    frozen_files: inventory(join(output, 'frozen')), sdk_files: sdkBefore, dependency_files: dependencyBefore, mounts: frozenMounts,
    sdk_root: 'sdk/node_modules/@earendil-works', ledger, node: process.version, node_hash: hash(readFileSync(process.execPath)),
    parser_hash: hash(readFileSync(join(output, 'frozen/scripts/changeset-study/parser/acorn.mjs'))), overlay: overlay.metadata,
    boundary: 'This separate campaign includes DeepSeek outer review and one batch repair. It is not the writing-only owner/query/writer route.',
    limitations: ['Exposed development cases, not a general performance benchmark.', 'No pre-dispatch source-range simulation beyond the existing deterministic engine checks.', 'Format retry applies once per initial or repair discovery-planning attempt; transport, budget and cancellation are never retried.'] };
  write(join(output, 'manifest.json'), manifest); return { output, manifest };
}

export function verifyPrepared(output) {
  output = realpathSync(output); const manifest = read(join(output, 'manifest.json'));
  if (manifest.protocol !== 'deepseek-direct-boundary-review-v1') throw new Error('Unknown divergent protocol');
  validateModel(manifest.model);
  if (hash(readFileSync(process.execPath)) !== manifest.node_hash || hash(readFileSync(join(output, 'tasks.json'))) !== manifest.tasks_hash ||
      !same(inventory(join(output, 'frozen')), manifest.frozen_files) || !same(inventory(join(output, 'sdk/node_modules')), manifest.sdk_files) ||
      manifest.mounts.some(([path], index) => !inside(output, realpathSync(path)) || !same(inventory(path), manifest.dependency_files[index])) ||
      hash(readFileSync(join(output, 'original-cell.mjs'))) !== manifest.overlay.original_hash || !same(read(join(output, 'cell-overlay.json')), manifest.overlay)) throw new Error('Prepared frozen bytes changed');
  const tasks = read(join(output, 'tasks.json'));
  if (!same(tasks.map(task => { const clean = structuredClone(task); delete clean.gold; return [task.id, hash(JSON.stringify(clean))]; }), manifest.source_task_hashes)) throw new Error('Frozen task identities changed');
  return manifest;
}
export function qualify(result, requests, expectedSelector, audit = null) {
  const routed = result.selector === expectedSelector && requests.length > 0 && requests.every(row => row.selector === expectedSelector);
  const auditRequired = result.task === 'hard-dependency-handoff';
  return { recorded_delivered: deliveredResult(result), routing_valid: routed,
    audited_delivered: deliveredResult(result) && routed && (!auditRequired || audit?.passed === true && audit.candidate_hash === result.candidate_hash),
    path_audit_required: auditRequired, path_audit: audit };
}

async function childRun(executable, args, { cwd, env = {}, timeoutMs }) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { text = (text + chunk).slice(-12000); });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); done({ code, output: text }); });
  });
}
export async function runPrepared(output) {
  output = realpathSync(output); const manifest = verifyPrepared(output);
  if (validateLedger(manifest.ledger).path !== manifest.ledger) throw new Error('Shared budget ledger identity changed');
  const frozenRunner = join(output, 'frozen/scripts/changeset-study/divergent/deepseek-direct/runner.mjs');
  if (realpathSync(fileURLToPath(import.meta.url)) !== realpathSync(frozenRunner))
    throw new Error(`Execute the frozen runner so orchestration and reporting are pinned: ${frozenRunner}`);
  if (manifest.status !== 'prepared' || existsSync(join(output, 'started.json'))) throw new Error('Prepared runs execute once; repetitions need a new preparation');
  writeFileSync(join(output, 'started.json'), JSON.stringify({ at: new Date().toISOString() }) + '\n', { flag: 'wx' });
  const tasks = read(join(output, 'tasks.json')), rows = [];
  const frozenSdk = join(output, manifest.sdk_root), ledger = manifest.ledger;
  const env = { CHANGESET_STUDY_SDK_ROOT: frozenSdk, CHANGESET_MODEL_RUNTIME: join(frozenSdk, 'pi-coding-agent/dist/core/model-runtime.js') };
  let stopped = null;
  for (const [index, taskInput] of tasks.entries()) {
    verifyPrepared(output);
    const budget = validateLedger(ledger);
    if (budget.path !== ledger) throw new Error('Shared budget ledger identity changed');
    if (budget.state.entries.reduce((sum, entry) => sum + (entry.charged_usd ?? entry.reserved_usd), 0) >= 49) { stopped = 'Shared budget guard'; break; }
    const directory = join(output, `${String(index).padStart(3, '0')}-${taskInput.id}`); mkdirSync(directory);
    const task = structuredClone(taskInput); delete task.gold;
    const job = { task, strategy: 'boundary-review', arm: 'changeset', selector: manifest.model,
      ledger, directory, mounts: manifest.mounts,
      plannerPrompt: readFileSync(join(output, 'frozen/skills/spec-changeset-plan/SKILL.md'), 'utf8') };
    write(join(directory, 'job.json'), job);
    const began = performance.now(), cap = task.limits.cell_ms + task.limits.grade_ms;
    const child = await childRun(process.execPath, [join(output, 'frozen/scripts/changeset-study/worker.mjs'), join(directory, 'job.json')], { cwd: output, env, timeoutMs: cap + 35000 });
    const path = join(directory, 'result.json');
    const result = existsSync(path) ? read(path) : { task: task.id, strategy: 'boundary-review', arm: 'changeset', selector: manifest.model, accepted: false, outcome: 'blocked', error: child.output };
    if (existsSync(ledger)) Object.assign(result, recoverAccounting(directory, ledger));
    result.process_elapsed_ms = performance.now() - began;
    if (result.process_elapsed_ms > cap) { result.accepted = false; result.outcome = 'timed-out'; }
    result.capped_time_to_success_ms = result.accepted ? result.process_elapsed_ms : cap;
    const requests = existsSync(join(directory, 'requests.jsonl')) ? readFileSync(join(directory, 'requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    let audit = null;
    if (task.id === 'hard-dependency-handoff' && existsSync(join(directory, 'candidate.json'))) {
      const auditPath = join(directory, 'path-audit.json');
      const auditRun = await childRun(process.execPath, [join(output, 'frozen/scripts/changeset-study/path-audit.mjs'), join(directory, 'candidate.json'),
        join(output, 'frozen/scripts/changeset-study/parser/acorn.mjs'), auditPath], { cwd: output, env, timeoutMs: 30000 });
      audit = existsSync(auditPath) ? read(auditPath) : { passed: false, error: auditRun.output };
    }
    Object.assign(result, qualify(result, requests, manifest.model, audit));
    result.audited_elapsed_ms = performance.now() - began;
    write(path, result); rows.push(result);
    write(join(output, 'results.json'), { protocol: manifest.protocol, completed_cells: rows.length, all_audited_delivered: rows.length === 3 && rows.every(row => row.audited_delivered), rows });
    if (result.selector !== manifest.model || requests.some(request => request.selector !== manifest.model)) { stopped = 'Unexpected model routing'; break; }
    if (/Campaign budget exhausted|Budget ledger locked/.test(result.error ?? '')) { stopped = 'Shared budget guard'; break; }
  }
  write(join(output, 'results.json'), { protocol: manifest.protocol, completed_cells: rows.length,
    all_audited_delivered: !stopped && rows.length === 3 && rows.every(row => row.audited_delivered), stopped,
    unrun_tasks: taskIds.filter(id => !rows.some(row => row.task === id)), rows });
  return { output, completed_cells: rows.length, stopped };
}

export async function main(args) {
  const [command, ...options] = args;
  const values = {};
  for (let index = 0; index < options.length; index += 2) {
    const key = options[index];
    if (!['--source', '--output', '--ledger', '--parser', '--model', '--sdk-root'].includes(key) || !options[index + 1] || Object.hasOwn(values, key)) throw new Error('Expected unique named runner options');
    values[key] = options[index + 1];
  }
  if (command === 'prepare') return prepare({ source: values['--source'], output: values['--output'], ledger: values['--ledger'], parser: values['--parser'], model: values['--model'], ...(values['--sdk-root'] ? { sdk: values['--sdk-root'] } : {}) });
  if (command === 'run' && Object.keys(values).length === 1 && values['--output']) return runPrepared(values['--output']);
  throw new Error('Use prepare --source RUN03 --output NEW_DIR --ledger FILE --parser MODULE --model deepseek/deepseek-flash:off [--sdk-root DIR], or run --output PREPARED_DIR');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await main(process.argv.slice(2)); console.log(JSON.stringify(result.output ? { output: result.output, status: result.manifest?.status ?? 'completed', stopped: result.stopped ?? null } : result)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
