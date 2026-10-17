#!/usr/bin/env node
// Separate research control. Preparation/auditing import no model runtime.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { auditCell } from './audit.mjs';
import { comparison, hash, inside, inventory, model, prospective, read, rows, safePath, same, taskIds, validateLedger, write } from './support.mjs';

const harness = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(harness, '../../../..');
const cellName = (index, id) => `${String(index).padStart(3, '0')}-${id}`;
const sdkDist = sdk => Object.fromEntries(['pi-agent-core', 'pi-coding-agent', 'pi-ai'].map(pkg => [pkg, inventory(join(sdk, pkg, 'dist'))]));
const retained = ['job.json', 'result.json', 'raw-plan.json', 'plan-0.json', 'implementation-brief.md'];
const inputHashes = directory => Object.fromEntries(retained.map(name => [name, hash(readFileSync(join(directory, name)))]));
const cleanTask = task => { const result = structuredClone(task); delete result.gold; return result; };
function sourceInputs(source) {
  const manifest = read(join(source, 'manifest.json')), tasksBytes = readFileSync(join(source, 'tasks.json')), tasks = JSON.parse(tasksBytes);
  if (!/^18-/.test(basename(source)) || manifest.comparison !== 'deepseek-owner-sol-query-deepseek-writer' || manifest.strategy !== 'owner-query-writer' ||
      !/^80cf4f1[a-f0-9]{33}$/.test(manifest.revision ?? '') || manifest.selector !== model || !/^deepseek\/deepseek-[^:]+:off$/.test(manifest.editor_selector ?? '') || manifest.query_mode !== 'catalog-lookup' || manifest.query_granularity !== 'smaller-regions' || manifest.optimization !== 'none' ||
      !same(manifest.schedule, taskIds) || !Array.isArray(tasks) || tasks.length !== 3 || hash(tasksBytes) !== manifest.tasks_hash ||
      !same(inventory(join(source, 'frozen')), manifest.frozen_files)) throw new Error('Require exact terminal run18 smaller-regions source, tasks and frozen backend');
  const cells = taskIds.map((id, index) => {
    const name = cellName(index, id), directory = join(source, name), job = read(join(directory, 'job.json')), result = read(join(directory, 'result.json'));
    const task = tasks[index], plan = read(join(directory, 'raw-plan.json')), dispatched = read(join(directory, 'plan-0.json'));
    const brief = readFileSync(join(directory, 'implementation-brief.md'), 'utf8');
    if (task?.id !== id || !same(cleanTask(task), job.task) || result.task_hash !== hash(JSON.stringify(job.task)) ||
        job.selector !== manifest.selector || job.editorSelector !== manifest.editor_selector || result.selector !== manifest.selector || result.editor_selector !== manifest.editor_selector ||
        (job.writerRecoverySelector ?? null) !== (manifest.writer_recovery_selector ?? null) || (result.writer_recovery_selector ?? null) !== (manifest.writer_recovery_selector ?? null) ||
        result.optimization !== 'none' || result.query_mode !== 'catalog-lookup' || !Number.isFinite(result.process_elapsed_ms) || result.executions?.length !== 1 || result.executions[0].ok !== true || result.error ||
        result.executions[0].plan_sha256 !== hash(JSON.stringify(dispatched)) || result.implementation_brief_hash !== hash(brief) || job.preparedBrief !== brief ||
        job.queryGranularity !== 'smaller-regions' || result.query_granularity !== 'smaller-regions' ||
        plan.schema_version !== 1 || !Array.isArray(plan.operations) || !plan.operations.length || plan.operations.length > 200 ||
        !same(plan.operations.map(operation => operation.id).sort(), dispatched.operations.map(operation => operation.id).sort()) ||
        !Array.isArray(job.mounts) || !job.mounts.every(row => Array.isArray(row) && row.length === 2 && row.every(value => typeof value === 'string')))
      throw new Error('Donor source/plan/brief identity or application qualification failed: ' + id);
    if (!task.files || typeof task.files !== 'object' || !Array.isArray(task.protected) || typeof task.spec !== 'string' || typeof task.hidden !== 'string' ||
        typeof task.check !== 'string' || !['prepared', 'discovery'].includes(task.context)) throw new Error('Invalid donor task');
    for (const [path, text] of Object.entries(task.files)) { safePath(path); if (typeof text !== 'string') throw new Error('Non-text source'); }
    if (task.protected.some(path => !Object.hasOwn(task.files, path))) throw new Error('Missing protected source');
    for (const key of ['cell_ms', 'grade_ms', 'model_calls', 'max_output_tokens', 'call_ms', 'command_ms'])
      if (!Number.isInteger(task.limits?.[key]) || task.limits[key] < 1) throw new Error('Invalid donor task limit');
    const records = result.executions[0].operations;
    if (!Array.isArray(records) || records.length !== dispatched.operations.length || new Set(records.map(record => record.id)).size !== records.length ||
        records.some(record => record.status !== 'passed' || !dispatched.operations.some(operation => operation.id === record.id && operation.executor === record.executor)) ||
        dispatched.operations.some(operation => {
          const raw = plan.operations.find(raw => raw.id === operation.id);
          return !raw || Object.keys(raw).filter(key => !['context', 'depends_on'].includes(key)).some(key => !same(raw[key], operation[key])) ||
            !same([...new Map(raw.context.map(context => [JSON.stringify(context), context])).values()], operation.context) ||
            raw.depends_on.some(id => !operation.depends_on.includes(id));
        })) throw new Error('Donor did not complete the exact raw-plan assignments');
    const ids = new Set(plan.operations.map(operation => operation.id));
    if (ids.size !== plan.operations.length || plan.operations.some(operation => !['simple', 'involved'].includes(operation.executor) || operation.edits !== undefined ||
        typeof operation.instruction !== 'string' || typeof operation.objective !== 'string' || !Array.isArray(operation.requirements) ||
        !Array.isArray(operation.writes) || operation.writes.length !== 1 || !Array.isArray(operation.reads) || !Array.isArray(operation.depends_on) ||
        operation.depends_on.some(id => !ids.has(id)) || !Array.isArray(operation.context))) throw new Error('Invalid delegated donor plan');
    for (const operation of plan.operations) [...operation.reads, ...operation.writes].forEach(safePath);
    return { name, job, result, task_hash: hash(JSON.stringify(job.task)), artifacts: inputHashes(directory) };
  });
  if (cells.some(cell => !same(cell.job.mounts, cells[0].job.mounts))) throw new Error('Donor mounts differ');
  const metadata = manifest.models?.filter(entry => entry.selector === model);
  if (metadata?.length !== 1 || metadata[0].model?.provider !== 'openai-codex' || metadata[0].model?.id !== 'gpt-6.1-sol') throw new Error('Donor must pin the exact authorized Sol model metadata');
  return { manifest, tasksBytes, cells, metadata: metadata[0] };
}

export function reservationReadiness(metadata, cells, source, state) {
  const rates = [metadata.cost, ...(metadata.cost?.tiers ?? [])];
  const inputRate = Math.max(...rates.flatMap(rate => [rate.input, rate.cacheRead ?? 0, rate.cacheWrite ?? 0]));
  const outputRate = Math.max(...rates.map(rate => rate.output));
  const capacity = Math.max(...cells.map(cell => cell.job.task.limits.max_output_tokens), metadata.maxTokens ?? 0, metadata.contextWindow ?? 0);
  const bounds = cells.flatMap(cell => rows(join(source, cell.name, 'requests.jsonl')).filter(row => row.stage === 'editor')
    .map(row => Buffer.byteLength(JSON.stringify(row.context)) + 8192));
  if (!bounds.length || ![inputRate, outputRate, capacity].every(value => Number.isFinite(value) && value > 0)) throw new Error('Reservation metadata or retained writer packets unavailable');
  const largest = Math.max(...bounds), perCall = (largest * inputRate + capacity * outputRate) / 1e6 * 1.25;
  const exposure = state.entries.reduce((sum, entry) => sum + (entry.charged_usd ?? entry.reserved_usd), 0), headroom = state.limit_usd - exposure;
  return { output_tokens_reserved: capacity, maximum_input_rate: inputRate, maximum_output_rate: outputRate,
    largest_retained_context_plus_overhead_bytes: largest, per_call_usd: perCall, four_concurrent_usd: 4 * perCall,
    ledger_exposure_usd: exposure, headroom_usd: headroom, four_retained_packet_reservations_fit: 4 * perCall <= headroom,
    qualification: 'Largest retained packet estimate, not a bound on unseen staged inputs. Actual unchanged Client reservations remain authoritative. No serialization or reservation weakening.' };
}
export function prepare({ source, output, ledger, sdk, writer = model }) {
  if (writer !== model) throw new Error('Only openai-codex/gpt-6.1-sol:low is authorized for this control');
  for (const value of [source, output, ledger, sdk]) if (typeof value !== 'string' || !value) throw new Error('Explicit source, output, ledger and SDK root required');
  source = realpathSync(source); sdk = realpathSync(sdk); output = prospective(output); ledger = validateLedger(ledger).path;
  const input = sourceInputs(source), sdkModules = realpathSync(dirname(sdk));
  if (input.cells.some(cell => validateLedger(cell.job.ledger).path !== ledger)) throw new Error('Use the same canonical existing ledger as donor jobs');
  const mounts = input.cells[0].job.mounts;
  const protectedRoots = [realpathSync(checkout), dirname(source), sdkModules, ...mounts.map(([path]) => realpathSync(path))];
  if (existsSync(output) || protectedRoots.some(path => inside(path, output) || inside(output, path)) || inside(output, ledger))
    throw new Error('Control output must be new, outside dispatch-deepseek, checkout, SDK and dependencies');
  if (mounts.length !== 1) throw new Error('This control requires the single donor-pinned dependency mount');
  const readiness = reservationReadiness(input.metadata.model, input.cells, source, validateLedger(ledger).state);
  if (!readiness.four_retained_packet_reservations_fit) throw new Error('Four Sol reservations do not fit current shared ledger headroom; concurrency is unchanged');
  const pins = sdkDist(sdk), dependencyPins = mounts.map(([path]) => inventory(path));
  if (!same(pins, input.manifest.sdk_files) || !dependencyPins.length || hash(JSON.stringify(dependencyPins[0])) !== input.manifest.dependencies_hash)
    throw new Error('SDK/dependency pins differ from donor');
  const sourceManifestHash = hash(readFileSync(join(source, 'manifest.json'))), fullSdkPins = inventory(sdkModules);
  mkdirSync(join(output, 'harness'), { recursive: true });
  for (const name of ['runner.mjs', 'support.mjs', 'audit.mjs', 'README.md', 'PROTOCOL.md']) cpSync(join(harness, name), join(output, 'harness', name));
  cpSync(join(source, 'frozen'), join(output, 'backend'), { recursive: true });
  cpSync(sdkModules, join(output, 'sdk/node_modules'), { recursive: true, verbatimSymlinks: true });
  const dependencies = mounts.map(([path, target], index) => {
    const relative = `dependencies/${index}`; cpSync(path, join(output, relative), { recursive: true, verbatimSymlinks: true });
    return { path: relative, target, files: dependencyPins[index] };
  });
  writeFileSync(join(output, 'tasks.json'), input.tasksBytes);
  for (const cell of input.cells) {
    mkdirSync(join(output, 'inputs', cell.name), { recursive: true });
    for (const name of retained) cpSync(join(source, cell.name, name), join(output, 'inputs', cell.name, name));
  }
  const adapter = 'pi-ai/dist/api/openai-codex-responses.js', adapterHash = hash(readFileSync(join(sdk, adapter)));
  const knownUnboundedAdapter = adapterHash === '4d90da82aaac68f9f0e1fd7daec39f1aa285c111bf04c7ddefa52e920b41b2cc';
  const manifest = { schema_version: 1, comparison, status: 'prepared', created_at: new Date().toISOString(), exploratory: true,
    execution_strategy: 'owner-query-writer', model, model_metadata: input.metadata, source, source_run: basename(source), source_revision: input.manifest.revision, source_manifest_hash: sourceManifestHash,
    tasks_hash: hash(input.tasksBytes), schedule: taskIds, ledger, node_hash: hash(readFileSync(process.execPath)), backend_files: input.manifest.frozen_files,
    harness_files: inventory(join(output, 'harness')), sdk_files: fullSdkPins, sdk_dist_files: pins, sdk_root: 'sdk/node_modules/@earendil-works', dependencies,
    cells: input.cells.map(({ name, task_hash, artifacts }) => ({ name, task_hash, artifacts })),
    output_cap: { matched_requested_limits: true, matched_provider_enforcement: false, control_adapter: adapter, control_adapter_hash: adapterHash,
      control_effective_output_cap: knownUnboundedAdapter ? 'requested maxTokens omitted from serialized provider payload; no equal enforced cap established' : 'unverified for this adapter hash',
      donor_effective_output_cap: 'DeepSeek max_tokens from unchanged task output setting; control uses a different provider adapter',
      audit_basis: 'Known pinned SDK1.2.0 Sol adapter hash; no provider calls during preparation. Unknown hashes remain explicitly unverified.' },
    reservation_readiness: readiness,
    retry_policy: { exact_backend: true, control: 'legacy same-selector retry may also catch nonterminal transport/model errors', donor: 'configured off-to-low recovery restricts retries to decoded-format/application/syntax rejection', selection_rule: 'any observed control retry after transport/model failure invalidates comparison eligibility; incurred usage remains retained' },
    scope: 'Fixed-plan writer/application boundary only; no fresh owner, query or review. Downstream checks are separate. Not native-Sol end-to-end performance.',
    cost_policy: { id: 'sol-at-deepseek-rates', usd_per_million_tokens: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 }, subscription_quota_measured: false } };
  write(join(output, 'manifest.json'), manifest);
  verifyPrepared(output); return { output, manifest };
}

export function verifyPrepared(output) {
  output = realpathSync(output); const manifest = read(join(output, 'manifest.json'));
  if (manifest.comparison !== comparison || manifest.model !== model || manifest.execution_strategy !== 'owner-query-writer' || !same(manifest.schedule, taskIds)) throw new Error('Unauthorized control manifest');
  const input = sourceInputs(manifest.source);
  if (hash(readFileSync(join(manifest.source, 'manifest.json'))) !== manifest.source_manifest_hash || hash(readFileSync(process.execPath)) !== manifest.node_hash ||
      hash(readFileSync(join(output, 'tasks.json'))) !== manifest.tasks_hash || hash(input.tasksBytes) !== manifest.tasks_hash ||
      !same(inventory(join(output, 'harness')), manifest.harness_files) || !same(inventory(join(output, 'backend')), manifest.backend_files) ||
      !same(inventory(join(output, 'sdk/node_modules')), manifest.sdk_files) || !same(sdkDist(join(output, manifest.sdk_root)), manifest.sdk_dist_files) ||
      !same(input.manifest.frozen_files, manifest.backend_files) || !same(input.manifest.sdk_files, manifest.sdk_dist_files) || !same(input.metadata, manifest.model_metadata)) throw new Error('Frozen control bytes or donor identity changed');
  const canonicalLedger = validateLedger(manifest.ledger).path;
  if (canonicalLedger !== manifest.ledger || input.cells.some(cell => validateLedger(cell.job.ledger).path !== canonicalLedger)) throw new Error('Canonical shared ledger identity differs');
  for (const [index, cell] of input.cells.entries()) {
    if (!same(manifest.cells[index], { name: cell.name, task_hash: cell.task_hash, artifacts: cell.artifacts }) ||
        !same(inputHashes(join(output, 'inputs', cell.name)), cell.artifacts)) throw new Error('Frozen source/brief/plan artifacts differ');
  }
  for (const dependency of manifest.dependencies) {
    safePath(dependency.path);
    if (!inside(output, realpathSync(join(output, dependency.path))) || !same(inventory(join(output, dependency.path)), dependency.files)) throw new Error('Frozen dependency bytes changed');
  }
  if (!same(manifest.dependencies.map(dependency => [dependency.target, dependency.files]),
      input.cells[0].job.mounts.map(([path, target]) => [target, inventory(path)]))) throw new Error('Donor dependency identity changed');
  return manifest;
}

export function controlJob(output, manifest, cell) {
  const directory = join(output, cell.name), input = join(output, 'inputs', cell.name), original = read(join(input, 'job.json'));
  const brief = readFileSync(join(input, 'implementation-brief.md'), 'utf8');
  return { task: original.task, arm: 'changeset', strategy: 'owner-query-writer', selector: read(join(manifest.source, 'manifest.json')).selector,
    editorSelector: model, writerRecoverySelector: null, ledger: manifest.ledger, directory,
    mounts: manifest.dependencies.map(dependency => [join(output, dependency.path), dependency.target]),
    plannerPrompt: original.plannerPrompt, optimization: 'none', queryMode: 'catalog-lookup', queryGranularity: 'smaller-regions',
    preparedBrief: brief, preparedPlan: read(join(input, 'raw-plan.json')),
    planningSource: { run: manifest.source_run, cell: cell.name, plan_artifact: 'raw-plan.json', plan_hash: cell.artifacts['raw-plan.json'], result_hash: cell.artifacts['result.json'], query_granularity: 'smaller-regions' },
    briefSource: { run: manifest.source_run, cell: cell.name, brief_hash: hash(brief), result_hash: cell.artifacts['result.json'] } };
}
export async function auditPrepared(output) {
  output = realpathSync(output); const manifest = verifyPrepared(output);
  const cells = await Promise.all(manifest.cells.filter(cell => existsSync(join(output, cell.name, 'result.json'))).map(async cell => ({ cell: cell.name,
    ...await auditCell({ directory: join(output, cell.name), expectedJob: controlJob(output, manifest, cell),
      expectedPlan: read(join(output, 'inputs', cell.name, 'plan-0.json')), taskHash: cell.task_hash }) })));
  return { comparison, source_run: manifest.source_run, output_cap: manifest.output_cap, completed_cells: cells.length, expected: 3,
    all_qualified_application: cells.length === 3 && cells.every(cell => cell.qualified_application),
    all_delivery_checks_pass: cells.length === 3 && cells.every(cell => cell.qualified_delivery_checks_pass), cells };
}
async function childRun(args, env, timeoutMs) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); done({ code, output }); });
  });
}
export async function runPrepared(output) {
  output = realpathSync(output); const manifest = verifyPrepared(output);
  if (realpathSync(fileURLToPath(import.meta.url)) !== realpathSync(join(output, 'harness/runner.mjs'))) throw new Error('Execute the frozen control harness');
  if (manifest.status !== 'prepared' || existsSync(join(output, 'started.json'))) throw new Error('Control runs execute once; prepare a new output for repetition');
  writeFileSync(join(output, 'started.json'), JSON.stringify({ at: new Date().toISOString() }) + '\n', { flag: 'wx' });
  const sdk = join(output, manifest.sdk_root), env = { CHANGESET_STUDY_SDK_ROOT: sdk, CHANGESET_MODEL_RUNTIME: join(sdk, 'pi-coding-agent/dist/core/model-runtime.js') };
  let stopped = null;
  const inspectModel = `const {ModelRuntime}=await import(${JSON.stringify(pathToFileURL(join(sdk, 'pi-coding-agent/dist/core/model-runtime.js')).href)}); const runtime=await ModelRuntime.create({allowModelNetwork:false}); console.log(JSON.stringify(runtime.getModel('openai-codex','gpt-6.1-sol')));`;
  for (const cell of manifest.cells) {
    verifyPrepared(output);
    const inspected = await childRun(['--input-type=module', '-e', inspectModel], env, 30000);
    let effective; try { effective = JSON.parse(inspected.output); } catch {}
    if (inspected.code !== 0 || !same(effective, manifest.model_metadata.model)) { stopped = 'Effective runtime Sol model metadata differs from donor pin'; break; }
    const state = validateLedger(manifest.ledger).state;
    if (state.entries.reduce((sum, entry) => sum + (entry.charged_usd ?? entry.reserved_usd), 0) >= 49) { stopped = 'Shared budget guard'; break; }
    const readiness = reservationReadiness(manifest.model_metadata.model, sourceInputs(manifest.source).cells, manifest.source, state);
    if (!readiness.four_retained_packet_reservations_fit) { stopped = 'Four retained-packet Sol reservations no longer fit; concurrency unchanged'; break; }
    const job = controlJob(output, manifest, cell); mkdirSync(job.directory); write(join(job.directory, 'job.json'), job);
    const began = performance.now(), cap = job.task.limits.cell_ms + job.task.limits.grade_ms;
    const child = await childRun([join(output, 'backend/scripts/changeset-study/worker.mjs'), join(job.directory, 'job.json')], env, cap + 35000);
    if (!existsSync(join(job.directory, 'result.json'))) { write(join(job.directory, 'failure.json'), { code: child.code, error: child.output }); stopped = 'Worker did not retain a result'; break; }
    const result = read(join(job.directory, 'result.json'));
    result.process_elapsed_ms = performance.now() - began;
    if (result.process_elapsed_ms > cap) { result.accepted = false; result.outcome = 'timed-out'; }
    write(join(job.directory, 'result.json'), result);
    const audit = await auditCell({ directory: job.directory, expectedJob: job, expectedPlan: read(join(output, 'inputs', cell.name, 'plan-0.json')), taskHash: cell.task_hash });
    write(join(job.directory, 'writer-control-audit.json'), audit);
    if (!audit.integrity_valid) { stopped = 'Control integrity/routing audit failed'; break; }
  }
  const report = await auditPrepared(output);
  Object.assign(report, { stopped, all_qualified_application: !stopped && report.all_qualified_application, all_delivery_checks_pass: !stopped && report.all_delivery_checks_pass });
  write(join(output, 'writer-control-report.json'), report); return report;
}
export async function main(args) {
  const [command, ...rest] = args, values = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!['--source', '--output', '--ledger', '--sdk-root', '--model'].includes(rest[index]) || !rest[index + 1] || Object.hasOwn(values, rest[index])) throw new Error('Expected unique named control options');
    values[rest[index]] = rest[index + 1];
  }
  if (command === 'prepare') return prepare({ source: values['--source'], output: values['--output'], ledger: values['--ledger'], sdk: values['--sdk-root'], writer: values['--model'] ?? model });
  if (Object.keys(values).length === 1 && values['--output']) {
    if (command === 'audit') return auditPrepared(values['--output']);
    if (command === 'run') return runPrepared(values['--output']);
  }
  throw new Error('Use prepare --source RUN18 --output NEW_CONTROL --ledger EXISTING --sdk-root SDK [--model openai-codex/gpt-6.1-sol:low], or run/audit --output CONTROL');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await main(process.argv.slice(2)); console.log(JSON.stringify(result.manifest ? { output: result.output, status: result.manifest.status } : result)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
