#!/usr/bin/env node
// One explicit continuation of the stopped two-calibration observation campaign.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { hash, inventory, prospective, read, rows, same, write } from '../writer-control/support.mjs';
import { readLedger } from './guard.mjs';
import { auditTrial } from './audit.mjs';
const folder = dirname(fileURLToPath(import.meta.url)), checkout = resolve(folder, '../../../..');
const runnerPath = original => join(original, 'frozen/scripts/changeset-study/divergent/combined-dispatch/runner.mjs');
const originalAPI = original => import(pathToFileURL(runnerPath(original)));

export function remainingTrials(campaign, stopped, hasTrial) {
  if (campaign.schedule?.length !== 6 || stopped.completed !== 2 || stopped.rows?.length !== 2 || !stopped.stopped ||
    !same(stopped.rows.map(row => row.id), campaign.schedule.slice(0, 2).map(row => row.id)) || campaign.schedule.slice(2).some(hasTrial))
    throw new Error('Require exactly two stopped calibration observations and four unstarted trials');
  return campaign.schedule.slice(2);
}

export async function prepareResume({ original, output }) {
  original = realpathSync(original); output = prospective(output);
  if (existsSync(output) || dirname(output) !== original) throw new Error('Use a new resume directory directly under the original campaign');
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: checkout, encoding: 'utf8' }).trim()) throw new Error('Freeze committed clean resume code only');
  const api = await originalAPI(original), campaign = api.verify(original), stopped = read(join(original, 'results.json'));
  const remaining = remainingTrials(campaign, stopped, trial => existsSync(join(original, trial.id)));
  const observationFiles = Object.fromEntries(campaign.schedule.slice(0, 2).map(trial => [trial.id, inventory(join(original, trial.id))]));
  mkdirSync(join(output, 'harness/combined-dispatch'), { recursive: true }); mkdirSync(join(output, 'harness/writer-control'));
  for (const name of ['resume.mjs', 'audit.mjs', 'guard.mjs']) cpSync(join(folder, name), join(output, 'harness/combined-dispatch', name));
  for (const name of ['audit.mjs', 'support.mjs']) cpSync(join(folder, '../writer-control', name), join(output, 'harness/writer-control', name));
  const manifest = { schema_version: 1, protocol: 'combined-dispatch-four-trial-resume-v1', original,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(),
    original_manifest_hash: hash(readFileSync(join(original, 'manifest.json'))), stopped_results_hash: hash(readFileSync(join(original, 'results.json'))),
    observation_files: observationFiles, original_stop: stopped.stopped, original_registry_prefix: read(join(original, 'reservations.json')), completed: campaign.schedule.slice(0, 2), remaining,
    harness_files: inventory(join(output, 'harness')), node_hash: hash(readFileSync(process.execPath)),
    semantics: 'Original worker/backend/SDK/Jev/dependencies/registry and cap; fixed audit only; four remaining trials, no calibration repetition.' };
  write(join(output, 'manifest.json'), manifest); await verifyResume(output);
  return { output, revision: manifest.revision, retained_observations: 2, remaining_trials: 4, additional_provider_calls: 0 };
}

export async function verifyResume(output) {
  output = realpathSync(output); const manifest = read(join(output, 'manifest.json')), api = await originalAPI(manifest.original), campaign = api.verify(manifest.original);
  if (manifest.protocol !== 'combined-dispatch-four-trial-resume-v1' || manifest.original_manifest_hash !== hash(readFileSync(join(manifest.original, 'manifest.json'))) ||
    manifest.stopped_results_hash !== hash(readFileSync(join(manifest.original, 'results.json'))) || manifest.node_hash !== hash(readFileSync(process.execPath)) ||
    !same(inventory(join(output, 'harness')), manifest.harness_files) || !same(manifest.completed, campaign.schedule.slice(0, 2)) || !same(manifest.remaining, campaign.schedule.slice(2)) ||
    !same(read(join(manifest.original, 'reservations.json')).slice(0, manifest.original_registry_prefix.length), manifest.original_registry_prefix)) throw new Error('Resume/original identity changed');
  for (const trial of manifest.completed) if (!same(inventory(join(manifest.original, trial.id)), manifest.observation_files[trial.id])) throw new Error('Original observation changed');
  return { manifest, campaign, api };
}

async function worker(args, maxMs) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, maxMs);
    child.on('error', error => { clearTimeout(timer); reject(error); }); child.on('close', code => { clearTimeout(timer); done({ code, output }); });
  });
}
function evidence(original, schedule) {
  const ids = new Set(), orphaned = [];
  for (const trial of schedule) {
    const directory = join(original, trial.id); for (const row of rows(join(directory, 'requests.jsonl'))) ids.add(row.reservation);
    const routing = join(directory, 'routing.json'); if (existsSync(routing) && read(routing).reservation) ids.add(read(routing).reservation);
    const orphan = join(directory, 'orphaned-reservations.json'); if (existsSync(orphan)) orphaned.push(...read(orphan));
    const exit = join(directory, 'worker-exit.json'); if (existsSync(exit)) for (const line of read(exit).output.split('\n')) {
      try { const row = JSON.parse(line); if (row.orphaned_reservation) orphaned.push(row.orphaned_reservation); } catch { /* Worker diagnostic text. */ }
    }
  }
  for (const entry of orphaned) ids.add(entry.id);
  return { ids, orphaned: [...new Map(orphaned.map(entry => [entry.id, entry])).values()] };
}

export async function runResume(output) {
  output = realpathSync(output); const { manifest, campaign, api } = await verifyResume(output), original = manifest.original;
  if (realpathSync(fileURLToPath(import.meta.url)) !== realpathSync(join(output, 'harness/combined-dispatch/resume.mjs'))) throw new Error('Execute the pinned resume harness');
  if (manifest.remaining.some(trial => existsSync(join(original, trial.id)))) throw new Error('A remaining trial already exists; do not repeat it');
  writeFileSync(join(output, 'started.json'), JSON.stringify({ at: new Date().toISOString() }) + '\n', { flag: 'wx' });
  mkdirSync(join(output, 'audits')); const observed = []; let stopped = null;
  const audit = async trial => {
    const directory = join(original, trial.id), expectedJob = api.trialJob(original, campaign, trial);
    const value = await auditTrial({ directory, expectedJob, frozenRoot: join(original, 'frozen'), ledger: campaign.ledger });
    const row = { ...trial, ...value };
    write(join(output, 'audits', trial.id + '.json'), row); observed.push(row); return row;
  };
  for (const trial of manifest.completed) if (!(await audit(trial)).integrity_valid) stopped = 'Retained calibration re-audit failed';
  for (const trial of stopped ? [] : manifest.remaining) {
    await verifyResume(output); const job = api.trialJob(original, campaign, trial); mkdirSync(job.directory); write(join(job.directory, 'job.json'), job);
    const exited = await worker([join(original, 'frozen/scripts/changeset-study/divergent/combined-dispatch/worker.mjs'), original, join(job.directory, 'job.json')],
      job.task.limits.cell_ms + (job.task.limits.grade_ms ?? 0) + 30000);
    write(join(job.directory, 'worker-exit.json'), exited); const checked = await audit(trial), current = evidence(original, campaign.schedule);
    const unexpected = read(join(original, 'reservations.json')).filter(entry => !current.ids.has(entry.id)).map(entry => entry.id);
    if (unexpected.length) { checked.integrity_valid = false; checked.audited_delivered = false; checked.unattributed_reservations = unexpected; }
    write(join(output, 'audits', trial.id + '.json'), checked);
    const result = existsSync(join(job.directory, 'result.json')) ? read(join(job.directory, 'result.json')) : {};
    if (exited.code !== 0 || !checked.integrity_valid || /COMPARISON_|Budget ledger|Campaign budget/.test(JSON.stringify(result))) stopped = 'Worker, integrity or budget boundary stopped resume';
    write(join(output, 'results.json'), { protocol: manifest.protocol, revision: manifest.revision, original_revision: campaign.revision, original_stop: manifest.original_stop, completed: observed.length, planned: 6, stopped, rows: observed });
    if (stopped) break;
  }
  await verifyResume(output);
  const state = readLedger(campaign.ledger).state, tracked = evidence(original, campaign.schedule), registry = read(join(original, 'reservations.json'));
  const owned = [...new Map([...registry, ...tracked.orphaned].map(entry => [entry.id, entry])).values()];
  const entries = owned.map(entry => state.entries.find(row => row.id === entry.id) ?? { ...entry, charged_usd: null, status: 'missing' });
  const report = { protocol: manifest.protocol, revision: manifest.revision, original_revision: campaign.revision, original_stop: manifest.original_stop, completed: observed.length, planned: 6, stopped,
    retained_observations: 2, new_observations: observed.length - 2, reservations: owned.length,
    known_charged_usd: entries.reduce((sum, entry) => sum + (entry.charged_usd ?? 0), 0), exposure_usd: entries.reduce((sum, entry) => sum + (entry.charged_usd ?? entry.reserved_usd), 0),
    unknown_reservations: entries.filter(entry => entry.charged_usd == null).length, orphaned_reservations: tracked.orphaned,
    unattributed_reservations: registry.filter(entry => !tracked.ids.has(entry.id)).map(entry => entry.id), missing_ledger_reservations: entries.filter(entry => entry.status === 'missing').map(entry => entry.id), rows: observed };
  write(join(output, 'results.json'), report); return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const [command, ...args] = process.argv.slice(2), options = {};
    for (let index = 0; index < args.length; index += 2) { const key = args[index]?.slice(2); if (!['original', 'output'].includes(key) || options[key] || !args[index + 1]) throw new Error('Use unique --original/--output paths'); options[key] = args[index + 1]; }
    console.log(JSON.stringify(command === 'prepare' ? await prepareResume(options) : command === 'verify' ? { verified: Boolean(await verifyResume(options.output)) } : command === 'run' ? await runResume(options.output) : (() => { throw new Error('Use prepare/verify/run'); })()));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
