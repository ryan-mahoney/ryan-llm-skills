#!/usr/bin/env node
// Read-only main-run provenance and local-retry audit; no model/runtime imports.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditCell } from './audit.mjs';
import { hash, inventory, model as querySelector, read, same, taskIds, validateLedger } from './support.mjs';
const writerSelector = 'deepseek/deepseek-flash:off';
const role = (manifest, key) => manifest.roles?.[key] ?? (key === 'query_planner' ? manifest.selector : manifest.editor_selector);
const pins = sdk => Object.fromEntries(['pi-agent-core', 'pi-coding-agent', 'pi-ai'].map(pkg => [pkg, inventory(join(sdk, pkg, 'dist'))]));
const requireIdentity = (ok, message) => { if (!ok) throw new Error(message); };

export async function auditFixedOffRun({ run, donor, sdk }) {
  for (const value of [run, donor, sdk]) if (typeof value !== 'string' || !value) throw new Error('Explicit main run, donor18 and SDK root required');
  run = realpathSync(run); donor = realpathSync(donor); sdk = realpathSync(sdk);
  requireIdentity(run !== donor && /^18-/.test(basename(donor)), 'Use a separate fixed-off replay and original donor18');
  const manifest = read(join(run, 'manifest.json')), sourceManifest = read(join(donor, 'manifest.json'));
  for (const m of [manifest, sourceManifest]) requireIdentity(m.comparison === 'deepseek-owner-sol-query-deepseek-writer' && m.strategy === 'owner-query-writer' &&
    m.selector === querySelector && m.editor_selector === writerSelector && m.query_mode === 'catalog-lookup' && m.query_granularity === 'smaller-regions' &&
    m.optimization === 'none' && same(m.schedule, taskIds) && role(m, 'implementation_owner') === writerSelector && role(m, 'query_planner') === querySelector && role(m, 'writer') === writerSelector,
    'Unexpected source or fixed-off main treatment');
  requireIdentity(manifest.writer_recovery_selector == null && manifest.plans_from === basename(donor) && manifest.briefs_from == null,
    'Fixed-off main run must reuse donor18 plans and omit a recovery selector');
  requireIdentity(typeof sourceManifest.source_run === 'string' && sourceManifest.source_run.length > 0 && /^[a-f0-9]{64}$/.test(sourceManifest.source_manifest_hash ?? '') && manifest.source_run === sourceManifest.source_run && manifest.source_manifest_hash === sourceManifest.source_manifest_hash &&
    same(inventory(join(run, 'frozen')), manifest.frozen_files) && same(inventory(join(donor, 'frozen')), sourceManifest.frozen_files), 'Main/donor frozen code or initial source identity changed');
  requireIdentity(hash(readFileSync(join(run, 'tasks.json'))) === manifest.tasks_hash && manifest.tasks_hash === sourceManifest.tasks_hash &&
    hash(readFileSync(join(donor, 'tasks.json'))) === sourceManifest.tasks_hash, 'Main and donor task bytes differ');
  requireIdentity(same(manifest.sdk_files, sourceManifest.sdk_files) && same(pins(sdk), manifest.sdk_files) &&
    manifest.dependencies_hash === sourceManifest.dependencies_hash, 'SDK or dependency identity differs');
  requireIdentity(manifest.models?.length === 2 && [querySelector, writerSelector].every(selector => {
    const selected = manifest.models.filter(entry => entry.selector === selector), original = sourceManifest.models?.filter(entry => entry.selector === selector);
    return selected.length === 1 && original?.length === 1 && same(selected[0], original[0]);
  }), 'Fixed-off runtime model metadata differs from donor');
  if (manifest.replay_of) {
    const priorName = manifest.replay_of;
    requireIdentity(basename(priorName) === priorName, 'Invalid freeze replay name');
    const prior = read(join(dirname(run), priorName, 'manifest.json'));
    requireIdentity(prior.writer_recovery_selector == null && prior.editor_selector === writerSelector && same(prior.frozen_files, manifest.frozen_files), 'Fixed-off repeat did not retain its frozen code/selector');
  }
  const tasks = read(join(run, 'tasks.json')), cells = [];
  let ledger = null;
  for (const [index, id] of taskIds.entries()) {
    const name = `${String(index).padStart(3, '0')}-${id}`, source = join(donor, name), directory = join(run, name);
    const original = read(join(source, 'job.json')), sourceResultBytes = readFileSync(join(source, 'result.json')), sourceResult = JSON.parse(sourceResultBytes);
    const briefBytes = readFileSync(join(source, 'implementation-brief.md')), brief = briefBytes.toString('utf8');
    const rawBytes = readFileSync(join(source, 'raw-plan.json')), raw = JSON.parse(rawBytes), dispatched = read(join(source, 'plan-0.json'));
    const task = structuredClone(tasks[index]); delete task.gold;
    requireIdentity(task.id === id && same(task, original.task) && sourceResult.task_hash === hash(JSON.stringify(task)) &&
      sourceResult.implementation_brief_hash === hash(briefBytes) && Buffer.from(brief).equals(briefBytes) && original.preparedBrief === brief &&
      sourceResult.executions?.length === 1 && sourceResult.executions[0].ok === true && sourceResult.executions[0].plan_sha256 === hash(JSON.stringify(dispatched)), 'Donor source task, brief, plan or qualification differs');
    const canonical = validateLedger(original.ledger).path;
    requireIdentity(ledger === null || ledger === canonical, 'Donor ledgers differ'); ledger = canonical;
    requireIdentity(original.mounts?.length === 1 && hash(JSON.stringify(inventory(original.mounts[0][0]))) === manifest.dependencies_hash, 'Donor dependency mount changed');
    const resultPath = join(directory, 'result.json');
    requireIdentity(existsSync(resultPath), 'Fixed-off replay is not terminal across all three cases');
    const result = read(resultPath);
    requireIdentity(Number.isFinite(result.process_elapsed_ms), 'Main result has no terminal process record');
    const expectedJob = { task, optimization: 'none', queryMode: 'catalog-lookup', queryGranularity: 'smaller-regions',
      preparedPlan: raw, preparedBrief: brief,
      planningSource: { run: basename(donor), cell: name, plan_hash: hash(rawBytes), plan_artifact: 'raw-plan.json', result_hash: hash(sourceResultBytes), query_granularity: 'smaller-regions' },
      briefSource: { run: basename(donor), cell: name, brief_hash: hash(briefBytes), result_hash: hash(sourceResultBytes) },
      arm: 'changeset', strategy: 'owner-query-writer', selector: querySelector, editorSelector: writerSelector, writerRecoverySelector: null,
      ledger, directory, mounts: original.mounts, plannerPrompt: readFileSync(join(run, 'frozen/skills/spec-changeset-plan/SKILL.md'), 'utf8') };
    requireIdentity(same(result.planning_source, expectedJob.planningSource) && same(result.brief_source, expectedJob.briefSource) &&
      result.implementation_brief_hash === hash(briefBytes), 'Main result source provenance differs');
    requireIdentity(same(result.query_assignment_budget, { max_calls: task.limits.model_calls, calls_used: 0, query_calls_reserved: 0,
      writer_attempts_per_operation: 2, max_operations: Math.min(200, Math.floor(task.limits.model_calls / 2)) }), 'Replay call-reserve metadata differs');
    const audit = await auditCell({ directory, expectedJob, expectedPlan: dispatched, taskHash: hash(JSON.stringify(task)), expectedWriterSelector: writerSelector,
      frozenBackendRoot: join(run, 'frozen') });
    cells.push({ cell: name, task_hash: hash(JSON.stringify(task)), raw_plan_hash: hash(rawBytes), brief_hash: hash(briefBytes), ...audit });
  }
  return { schema_version: 1, comparison: 'fixed-off-local-retry-audit-v1', run: basename(run), donor: basename(donor), writer_selector: writerSelector,
    source_manifest_hash: hash(readFileSync(join(donor, 'manifest.json'))), main_manifest_hash: hash(readFileSync(join(run, 'manifest.json'))),
    frozen_inventory_hash: hash(JSON.stringify(manifest.frozen_files)), execution_revision: manifest.revision, sdk_dist_inventory_hash: hash(JSON.stringify(manifest.sdk_files)),
    canonical_ledger: ledger, audit_provider_calls: 0, all_integrity_valid: cells.every(cell => cell.integrity_valid), all_qualified_application: cells.every(cell => cell.qualified_application),
    all_delivery_checks_pass: cells.every(cell => cell.qualified_delivery_checks_pass),
    policy_note: 'Legacy same-selector runtime can retry transport/model exceptions; this audit disqualifies any observed retry not reproduced as a decoded-format/application/syntax rejection.',
    scope: 'Three-case fixed-plan writing boundary; no new owner/query/review. This helper neither executes writers nor changes historical main-report semantics.', cells };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), values = {};
    for (let index = 0; index < args.length; index += 2) {
      if (!['--run', '--donor', '--sdk-root'].includes(args[index]) || !args[index + 1] || Object.hasOwn(values, args[index])) throw new Error('Use unique --run, --donor and --sdk-root options');
      values[args[index]] = args[index + 1];
    }
    const report = await auditFixedOffRun({ run: values['--run'], donor: values['--donor'], sdk: values['--sdk-root'] });
    console.log(JSON.stringify(report, null, 2)); if (!report.all_integrity_valid) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
