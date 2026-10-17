#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { hash, inside, inventory, prospective, read, rows, same, taskIds, write } from '../writer-control/support.mjs';
import { readLedger } from './guard.mjs';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const writer = 'deepseek/deepseek-flash:off', planner = 'openai-codex/gpt-6.1-sol:low';
const retained = ['job.json', 'result.json', 'raw-plan.json', 'plan-0.json', 'implementation-brief.md'];
const artifactHashes = path => Object.fromEntries(retained.map(name => [name, hash(readFileSync(join(path, name)))]));
const sdkDist = sdk => Object.fromEntries(['pi-agent-core', 'pi-coding-agent', 'pi-ai'].map(name => [name, inventory(join(sdk, name, 'dist'))]));
export function schedule() {
  return taskIds.flatMap((task, index) => (index % 2 ? ['combined', 'baseline'] : ['baseline', 'combined'])
    .map(arm => ({ id: `${index}-${task}-${arm}`, task, source_cell: `${String(index).padStart(3, '0')}-${task}`, arm })));
}
export function donorInputs(source) {
  const manifest = read(join(source, 'manifest.json')), tasksBytes = readFileSync(join(source, 'tasks.json')), tasks = JSON.parse(tasksBytes);
  if (basename(source) !== '18-smaller-regions' || !/^80cf4f1[a-f0-9]{33}$/.test(manifest.revision) || manifest.strategy !== 'owner-query-writer' ||
    manifest.selector !== planner || manifest.editor_selector !== writer || manifest.optimization !== 'none' || manifest.query_mode !== 'catalog-lookup' ||
    manifest.query_granularity !== 'smaller-regions' || !same(manifest.schedule, taskIds) || hash(tasksBytes) !== manifest.tasks_hash ||
    !same(inventory(join(source, 'frozen')), manifest.frozen_files)) throw new Error('Exact retained run18 source required');
  const cells = taskIds.map((id, index) => {
    const name = `${String(index).padStart(3, '0')}-${id}`, path = join(source, name), job = read(join(path, 'job.json')), result = read(join(path, 'result.json'));
    const task = structuredClone(tasks[index]); delete task.gold;
    const briefBytes = readFileSync(join(path, 'implementation-brief.md')), brief = briefBytes.toString('utf8'), raw = read(join(path, 'raw-plan.json'));
    if (task.id !== id || !same(job.task, task) || result.task_hash !== hash(JSON.stringify(task)) || !Buffer.from(brief).equals(briefBytes) ||
      job.preparedBrief !== brief || result.implementation_brief_hash !== hash(briefBytes) || result.error || result.executions?.length !== 1 ||
      !result.executions[0].ok || result.executions[0].plan_sha256 !== hash(JSON.stringify(read(join(path, 'plan-0.json')))) ||
      raw.schema_version !== 1 || !raw.operations?.length || raw.operations.some(op => !['simple', 'involved'].includes(op.executor) || op.edits !== undefined || op.writes?.length !== 1) ||
      job.mounts?.length !== 1 || Object.values(task.limits).some(value => typeof value === 'number' && !Number.isFinite(value))) throw new Error('Donor task/brief/plan identity failed: ' + name);
    return { name, job, artifacts: artifactHashes(path), operations: raw.operations.length };
  });
  if (cells.some(cell => !same(cell.job.mounts, cells[0].job.mounts))) throw new Error('Donor mounts differ');
  const selected = manifest.models.filter(row => row.selector === writer);
  if (selected.length !== 1) throw new Error('Missing exact donor DeepSeek metadata');
  return { manifest, tasksBytes, cells, writer_model: selected[0].model };
}

function retainedReservationEstimate(source, donor) {
  const packets = donor.cells.flatMap(cell => rows(join(source, cell.name, 'requests.jsonl')).filter(row => row.stage === 'editor'));
  const largest = Math.max(...packets.map(row => Buffer.byteLength(JSON.stringify(row.context)) + 8192));
  const rates = [donor.writer_model.cost, ...(donor.writer_model.cost.tiers ?? [])];
  const perCall = (largest * Math.max(...rates.flatMap(rate => [rate.input, rate.cacheRead ?? 0, rate.cacheWrite ?? 0])) +
    Math.max(...donor.cells.map(cell => cell.job.task.limits.max_output_tokens)) * Math.max(...rates.map(rate => rate.output))) / 1e6 * 1.25;
  return { largest_retained_context_plus_overhead_bytes: largest, per_request_usd: perCall,
    all_writer_requests_usd: perCall * 4 * donor.cells.reduce((sum, cell) => sum + cell.operations, 0),
    qualification: 'Retained packet estimate, not a hard bound on future staged inputs; the actual two-dollar charge+hold+proposed guard is authoritative.' };
}

export function prepare({ source, output, ledger, sdk, parser, jev, codeRoot = checkout }) {
  for (const value of [source, output, ledger, sdk, parser, jev, codeRoot]) if (typeof value !== 'string' || !value) throw new Error('Explicit source/output/ledger/sdk/parser/jev paths required');
  source = realpathSync(source); sdk = realpathSync(sdk); parser = realpathSync(parser); jev = realpathSync(jev); codeRoot = realpathSync(codeRoot);
  output = prospective(output); const canonical = readLedger(ledger); ledger = canonical.path;
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: codeRoot, encoding: 'utf8' }).trim()) throw new Error('Freeze committed clean code only');
  const donor = donorInputs(source), sdkModules = dirname(sdk), jevModules = resolve(jev, '../../..'), mounts = donor.cells[0].job.mounts;
  if (donor.cells.some(cell => realpathSync(cell.job.ledger) !== ledger)) throw new Error('Reuse canonical donor ledger');
  if (existsSync(output) || [codeRoot, dirname(source), sdkModules, jevModules, ...mounts.map(([path]) => realpathSync(path))].some(path => inside(path, output) || inside(output, path)) || inside(output, ledger)) throw new Error('New adjacent output must be outside source/code/dependencies');
  const sdkPins = inventory(sdkModules), dependencies = inventory(mounts[0][0]), jevPins = inventory(jevModules);
  if (!same(sdkDist(sdk), donor.manifest.sdk_files) || hash(JSON.stringify(dependencies)) !== donor.manifest.dependencies_hash ||
    hash(readFileSync(parser)) !== hash(readFileSync(join(source, 'frozen/scripts/changeset-study/parser/acorn.mjs')))) throw new Error('SDK/dependency/parser pins differ from donor');
  const sourcePins = Object.fromEntries(['changeset-study', 'changeset', 'changeset-research'].map(folder => [folder, inventory(join(codeRoot, 'scripts', folder))]));
  mkdirSync(join(output, 'frozen/scripts'), { recursive: true });
  for (const folder of Object.keys(sourcePins)) cpSync(join(codeRoot, 'scripts', folder), join(output, 'frozen/scripts', folder), { recursive: true });
  mkdirSync(join(output, 'frozen/scripts/changeset-study/parser'), { recursive: true });
  cpSync(parser, join(output, 'frozen/scripts/changeset-study/parser/acorn.mjs'));
  cpSync(sdkModules, join(output, 'sdk/node_modules'), { recursive: true, verbatimSymlinks: true });
  cpSync(jevModules, join(output, 'jev/node_modules'), { recursive: true, verbatimSymlinks: true });
  cpSync(mounts[0][0], join(output, 'dependencies/0'), { recursive: true, verbatimSymlinks: true });
  for (const cell of donor.cells) {
    mkdirSync(join(output, 'inputs', cell.name), { recursive: true });
    for (const name of retained) cpSync(join(source, cell.name, name), join(output, 'inputs', cell.name, name));
  }
  if (!same(inventory(sdkModules), sdkPins) || !same(inventory(jevModules), jevPins) || !same(inventory(mounts[0][0]), dependencies) ||
    !same(Object.fromEntries(Object.keys(sourcePins).map(folder => [folder, inventory(join(codeRoot, 'scripts', folder))])), sourcePins)) throw new Error('Input changed during freeze');
  const manifest = { schema_version: 1, protocol: 'matched-combined-dispatch-v1', created_at: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: codeRoot, encoding: 'utf8' }).trim(), source, source_run: basename(source),
    source_manifest_hash: hash(readFileSync(join(source, 'manifest.json'))), source_revision: donor.manifest.revision,
    cells: donor.cells.map(({ name, artifacts, operations }) => ({ name, artifacts, operations })), schedule: schedule(), ledger,
    additional_exposure_usd: 2, max_writer_requests: 4 * donor.cells.reduce((sum, cell) => sum + cell.operations, 0), max_jev_requests: 3,
    retained_reservation_estimate: retainedReservationEstimate(source, donor),
    max_reservations: 4 * donor.cells.reduce((sum, cell) => sum + cell.operations, 0) + 3,
    node: process.version, node_hash: hash(readFileSync(process.execPath)), writer_model: donor.writer_model,
    frozen_files: inventory(join(output, 'frozen')), sdk_root: 'sdk/node_modules/@earendil-works', sdk_files: sdkPins,
    jev_entry: 'jev/node_modules/pi-typesafe/dist/index.js', jev_files: jevPins,
    dependencies: { path: 'dependencies/0', target: mounts[0][1], files: dependencies }, parser_hash: hash(readFileSync(parser)),
    baseline_ledger: { entries: canonical.state.entries.length, charged_usd: canonical.state.entries.reduce((sum, row) => sum + (row.charged_usd ?? 0), 0) },
    scope: 'Six sequential fixed-plan observations; combined optimization/context/format treatment, not an isolated format comparison. No new owner/query/review calls.' };
  write(join(output, 'manifest.json'), manifest); write(join(output, 'reservations.json'), []); verify(output);
  return { output, revision: manifest.revision, trials: 6, writer_request_ceiling: manifest.max_writer_requests, jev_request_ceiling: 3, additional_exposure_cap_usd: 2 };
}

export function verify(output) {
  output = realpathSync(output); const manifest = read(join(output, 'manifest.json')), donor = donorInputs(manifest.source);
  if (manifest.protocol !== 'matched-combined-dispatch-v1' || !same(manifest.schedule, schedule()) || manifest.additional_exposure_usd !== 2 ||
    manifest.sdk_root !== 'sdk/node_modules/@earendil-works' || manifest.jev_entry !== 'jev/node_modules/pi-typesafe/dist/index.js' || manifest.dependencies.path !== 'dependencies/0' ||
    manifest.max_writer_requests !== 4 * donor.cells.reduce((sum, cell) => sum + cell.operations, 0) || manifest.max_jev_requests !== 3 || manifest.max_reservations !== manifest.max_writer_requests + 3 ||
    manifest.source_manifest_hash !== hash(readFileSync(join(manifest.source, 'manifest.json'))) || manifest.node_hash !== hash(readFileSync(process.execPath)) ||
    !same(inventory(join(output, 'frozen')), manifest.frozen_files) || !same(inventory(join(output, 'sdk/node_modules')), manifest.sdk_files) ||
    !same(inventory(join(output, 'jev/node_modules')), manifest.jev_files) || !same(inventory(join(output, manifest.dependencies.path)), manifest.dependencies.files) ||
    !same(manifest.writer_model, donor.writer_model) || !same(manifest.cells, donor.cells.map(({ name, artifacts, operations }) => ({ name, artifacts, operations })))) throw new Error('Frozen comparison identity failed');
  if (readLedger(manifest.ledger).path !== manifest.ledger || donor.cells.some(cell => realpathSync(cell.job.ledger) !== manifest.ledger)) throw new Error('Canonical ledger identity changed');
  for (const cell of manifest.cells) if (!same(artifactHashes(join(output, 'inputs', cell.name)), cell.artifacts)) throw new Error('Copied donor artifacts changed');
  return manifest;
}

export function trialJob(output, manifest, trial) {
  const input = join(output, 'inputs', trial.source_cell), original = read(join(input, 'job.json')), identity = manifest.cells.find(cell => cell.name === trial.source_cell);
  const brief = readFileSync(join(input, 'implementation-brief.md'), 'utf8');
  return { task: original.task, arm: 'changeset', strategy: 'owner-query-writer', selector: planner, editorSelector: writer, writerRecoverySelector: null,
    ledger: manifest.ledger, directory: join(output, trial.id), mounts: [[join(output, manifest.dependencies.path), manifest.dependencies.target]],
    plannerPrompt: original.plannerPrompt, optimization: trial.arm === 'baseline' ? 'none' : 'contextual', dispatchProfile: trial.arm === 'baseline' ? null : 'optimized-v4a',
    queryMode: 'catalog-lookup', queryGranularity: 'smaller-regions', preparedBrief: brief, preparedPlan: read(join(input, 'raw-plan.json')),
    planningSource: { run: manifest.source_run, cell: trial.source_cell, plan_artifact: 'raw-plan.json', plan_hash: identity.artifacts['raw-plan.json'], result_hash: identity.artifacts['result.json'], query_granularity: 'smaller-regions' },
    briefSource: { run: manifest.source_run, cell: trial.source_cell, brief_hash: hash(brief), result_hash: identity.artifacts['result.json'] } };
}

async function child(args, maxMs) {
  return new Promise((done, reject) => {
    const subprocess = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    for (const stream of [subprocess.stdout, subprocess.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
    const timer = setTimeout(() => { try { process.kill(-subprocess.pid, 'SIGKILL'); } catch {} }, maxMs);
    subprocess.on('error', error => { clearTimeout(timer); reject(error); });
    subprocess.on('close', code => { clearTimeout(timer); done({ code, output }); });
  });
}
function reservationEvidence(output, trials) {
  const referenced = new Set(), orphaned = [];
  for (const trial of trials) {
    const directory = join(output, trial.id);
    for (const row of rows(join(directory, 'requests.jsonl'))) referenced.add(row.reservation);
    const routing = join(directory, 'routing.json');
    if (existsSync(routing) && read(routing).reservation) referenced.add(read(routing).reservation);
    const file = join(directory, 'orphaned-reservations.json'), exit = join(directory, 'worker-exit.json');
    if (existsSync(file)) orphaned.push(...read(file));
    if (existsSync(exit)) for (const line of read(exit).output.split('\n')) {
      try { const value = JSON.parse(line); if (value.orphaned_reservation) orphaned.push(value.orphaned_reservation); } catch { /* Non-JSON worker diagnostics. */ }
    }
  }
  for (const entry of orphaned) referenced.add(entry.id);
  return { referenced, orphaned: [...new Map(orphaned.map(entry => [entry.id, entry])).values()] };
}
export async function run(output) {
  output = realpathSync(output); const manifest = verify(output), frozen = join(output, 'frozen');
  if (realpathSync(fileURLToPath(import.meta.url)) !== realpathSync(join(frozen, 'scripts/changeset-study/divergent/combined-dispatch/runner.mjs'))) throw new Error('Execute frozen comparison runner');
  writeFileSync(join(output, 'started.json'), JSON.stringify({ at: new Date().toISOString() }) + '\n', { flag: 'wx' });
  const { auditTrial } = await import('./audit.mjs'); const observed = []; let stopped = null;
  for (const trial of manifest.schedule) {
    verify(output); const job = trialJob(output, manifest, trial); mkdirSync(job.directory); write(join(job.directory, 'job.json'), job);
    const executed = await child([join(frozen, 'scripts/changeset-study/divergent/combined-dispatch/worker.mjs'), output, join(job.directory, 'job.json')],
      job.task.limits.cell_ms + (job.task.limits.grade_ms ?? 0) + 30000);
    write(join(job.directory, 'worker-exit.json'), executed);
    const audit = await auditTrial({ directory: job.directory, expectedJob: job, frozenRoot: frozen, ledger: manifest.ledger });
    const evidence = reservationEvidence(output, manifest.schedule), registered = read(join(output, 'reservations.json'));
    const unexpected = registered.filter(entry => !evidence.referenced.has(entry.id)).map(entry => entry.id);
    if (unexpected.length) { audit.integrity_valid = false; audit.audited_delivered = false; audit.unattributed_reservations = unexpected; }
    write(join(job.directory, 'audit.json'), audit); observed.push({ ...trial, ...audit });
    write(join(output, 'results.json'), { protocol: manifest.protocol, revision: manifest.revision, completed: observed.length, planned: 6, stopped, rows: observed });
    const result = existsSync(join(job.directory, 'result.json')) ? read(join(job.directory, 'result.json')) : {};
    if (executed.code !== 0 || !audit.integrity_valid || /COMPARISON_|Budget ledger|Campaign budget/.test(JSON.stringify(result))) { stopped = 'Worker, integrity or budget boundary stopped comparison'; break; }
  }
  verify(output);
  const registered = read(join(output, 'reservations.json')), state = readLedger(manifest.ledger).state;
  const { orphaned, referenced } = reservationEvidence(output, manifest.schedule);
  const registry = [...new Map([...registered, ...orphaned].map(entry => [entry.id, entry])).values()];
  const accounting = registry.map(entry => state.entries.find(row => row.id === entry.id) ?? { ...entry, status: 'missing', charged_usd: null });
  const report = { protocol: manifest.protocol, revision: manifest.revision, completed: observed.length, planned: 6, stopped,
    reservations: registry.length, orphaned_reservations: orphaned, unattributed_reservations: registered.filter(entry => !referenced.has(entry.id)).map(entry => entry.id),
    missing_ledger_reservations: accounting.filter(row => row.status === 'missing').map(row => row.id),
    known_charged_usd: accounting.reduce((sum, row) => sum + (row?.charged_usd ?? 0), 0),
    exposure_usd: accounting.reduce((sum, row) => sum + (row?.charged_usd ?? row?.reserved_usd ?? 0), 0), unknown_reservations: accounting.filter(row => row?.charged_usd == null).length, rows: observed };
  write(join(output, 'results.json'), report); return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2), options = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index]?.slice(2); if (!['source', 'output', 'ledger', 'sdk', 'parser', 'jev'].includes(key) || options[key] || !args[index + 1]) throw new Error('Use unique named comparison paths'); options[key] = args[index + 1];
    }
    const value = command === 'prepare' ? prepare(options) : command === 'verify' ? { verified: Boolean(verify(options.output)) } : command === 'run' ? await run(options.output) : (() => { throw new Error('Use prepare/verify/run'); })();
    console.log(JSON.stringify(value));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
