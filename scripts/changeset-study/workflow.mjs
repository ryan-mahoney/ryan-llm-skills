#!/usr/bin/env node
// Continue a frozen hard campaign as a six-task, one-repeat workflow comparison.
// Inference workers, prompts, tasks and limits come from the source freeze unchanged.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { hash } from '../changeset/workspace.mjs';
import { sdkRoot } from './client.mjs';
import { recoverAccounting } from './accounting.mjs';

const args = process.argv.slice(2), command = args.shift();
const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : null;
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
const required = key => { const value = option(key); if (!value) throw new Error(`${key} required`); return value; };
function files(root) {
  const result = [];
  function scan(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) scan(join(dir, entry.name), path + '/');
      else if (entry.isFile()) result.push([path, hash(readFileSync(join(dir, entry.name)))]);
    }
  }
  scan(root); return result;
}
const sdkFiles = root => Object.fromEntries(['pi-agent-core', 'pi-coding-agent', 'pi-ai'].map(pkg => [pkg, files(join(root, pkg, 'dist'))]));
const equal = (a, b) => hash(JSON.stringify(a)) === hash(JSON.stringify(b));
function verify(run, manifest, sdk) {
  if (!equal(files(join(run, 'frozen')), manifest.frozen_files)) throw new Error('Frozen study bytes changed');
  if (!equal(sdkFiles(sdk), manifest.sdk_files)) throw new Error('Pinned SDK bytes changed');
  if (!equal(files(manifest.mounts[0][0]), manifest.dependency_files)) throw new Error('Pinned dependency bytes changed');
  if (hash(readFileSync(join(run, 'tasks.json'))) !== manifest.tasks_file_hash) throw new Error('Frozen tasks changed');
}

if (command === 'prepare') {
  const source = resolve(required('--source')), run = resolve(required('--output'));
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  if (!relative(repo, run).startsWith('..') || existsSync(run)) throw new Error('Output must be a new directory outside checkout');
  const selector = required('--model'), simple = required('--simple-model'), original = read(join(source, 'manifest.json'));
  if (original.phase !== 'hard' || original.exploratory || !original.models.includes(selector) || !original.models.includes(simple)) throw new Error('Expected a frozen hard campaign containing both selected models');
  if (!equal(files(join(source, 'frozen')), original.frozen_files)) throw new Error('Source freeze changed');
  const tasks = read(join(source, 'tasks.json'));
  const schedule = original.schedule.filter(pair => pair.selector === selector && pair.repetition === 0)
    .map(pair => ({ ...pair, arms: pair.arms.map(arm => arm === 'changeset' ? 'changeset-mixed' : arm) }));
  if (schedule.length !== tasks.length || new Set(schedule.map(p => p.task)).size !== tasks.length) throw new Error('Source must schedule every task exactly once at repetition zero');
  const directories = readdirSync(source).filter(name => /^\d+-/.test(name)).sort();
  const mounts = read(join(source, directories[0], 'job.json')).mounts;
  const dependencyFiles = files(mounts[0][0]);
  if (hash(JSON.stringify(dependencyFiles)) !== original.dependencies_hash) throw new Error('Source dependencies changed');
  mkdirSync(run, { recursive: true });
  cpSync(join(source, 'frozen'), join(run, 'frozen'), { recursive: true });
  cpSync(join(source, 'tasks.json'), join(run, 'tasks.json'));
  const manifest = { ...original, created_at: new Date().toISOString(), models: [selector], repetitions: 1,
    comparison: 'sol-native-vs-sol-nemotron-workflow', exploratory: true, simple_selector: simple, schedule,
    source_run: basename(source), source_manifest_hash: hash(readFileSync(join(source, 'manifest.json'))),
    scope_note: 'Operator reduced the running 72-cell campaign for elapsed time, then selected the combined workflow. Reuse all eligible completed native cells, regardless of outcome. No prompt or worker tuning. One repetition; workflow comparison, not a pure architectural effect.',
    mounts, dependency_files: dependencyFiles, tasks_file_hash: hash(readFileSync(join(run, 'tasks.json'))),
    scheduler_hash: hash(readFileSync(fileURLToPath(import.meta.url))), reused: [] };
  let index = 0;
  for (const pair of schedule) for (const arm of pair.arms) {
    const name = `${String(index++).padStart(3, '0')}-${pair.task}-${arm}`;
    if (arm !== 'agent') continue;
    const eligible = directories.filter(name => existsSync(join(source, name, 'result.json'))).filter(name => {
      const result = read(join(source, name, 'result.json'));
      return result.selector === selector && result.task === pair.task && result.arm === arm && result.repetition === 0;
    });
    if (eligible.length > 1) throw new Error('Ambiguous source trial');
    if (eligible.length) {
      cpSync(join(source, eligible[0]), join(run, name), { recursive: true });
      manifest.reused.push({ cell: name, source_cell: eligible[0], result_hash: hash(readFileSync(join(run, name, 'result.json'))) });
    }
  }
  write(join(run, 'manifest.json'), manifest);
  verify(run, manifest, sdkRoot());
  console.log(JSON.stringify({ run, cells: schedule.length * 2, reused: manifest.reused }));
} else if (command === 'execute') {
  const run = resolve(required('--run')), ledger = resolve(required('--ledger')), manifest = read(join(run, 'manifest.json'));
  if (manifest.comparison !== 'sol-native-vs-sol-nemotron-workflow') throw new Error('Not a workflow comparison');
  if (hash(readFileSync(fileURLToPath(import.meta.url))) !== manifest.scheduler_hash) throw new Error('Scheduler changed after preparation');
  const sdk = sdkRoot(), tasks = read(join(run, 'tasks.json'));
  verify(run, manifest, sdk);
  let index = 0;
  for (const pair of manifest.schedule) for (const arm of pair.arms) {
    const name = `${String(index++).padStart(3, '0')}-${pair.task}-${arm}`, directory = join(run, name), path = join(directory, 'result.json');
    if (existsSync(path)) {
      const result = read(path);
      if (result.task !== pair.task || result.arm !== arm || result.selector !== pair.selector || result.repetition !== pair.repetition || !Number.isFinite(result.process_elapsed_ms)) throw new Error('Invalid retained result');
      console.log(JSON.stringify({ index, retained: name, accepted: result.accepted })); continue;
    }
    if (existsSync(directory)) throw new Error(`Unfinished cell requires accounting recovery before resume: ${name}`);
    verify(run, manifest, sdk);
    mkdirSync(directory);
    const job = { task: structuredClone(tasks.find(t => t.id === pair.task)), arm, selector: pair.selector, ledger, directory,
      mounts: manifest.mounts, simpleSelector: arm === 'changeset-mixed' ? manifest.simple_selector : null,
      plannerPrompt: readFileSync(join(run, 'frozen/skills/spec-changeset-plan/SKILL.md'), 'utf8') };
    write(join(directory, 'job.json'), job);
    const began = performance.now(), limits = job.task.limits, cap = limits.cell_ms + limits.grade_ms;
    const outcome = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [join(run, 'frozen/scripts/changeset-study/worker.mjs'), join(directory, 'job.json')], {
        stdio: ['ignore', 'pipe', 'pipe'], detached: true,
        env: { ...process.env, CHANGESET_STUDY_SDK_ROOT: sdk, CHANGESET_MODEL_RUNTIME: join(sdk, 'pi-coding-agent/dist/core/model-runtime.js') },
      });
      let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000); });
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, cap + 35000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); done({ code, output }); });
    });
    const result = existsSync(path) ? read(path) : { task: pair.task, arm, selector: pair.selector, outcome: 'blocked', accepted: false, error: outcome.output };
    Object.assign(result, recoverAccounting(directory, ledger), { process_elapsed_ms: performance.now() - began, repetition: pair.repetition, order_in_pair: pair.arms.indexOf(arm) });
    if (result.process_elapsed_ms > cap) { result.accepted = false; result.outcome = 'timed-out'; }
    result.capped_time_to_success_ms = result.accepted ? result.process_elapsed_ms : cap;
    write(path, result);
    console.log(JSON.stringify({ index, task: pair.task, arm, accepted: result.accepted, seconds: result.process_elapsed_ms / 1000, error: result.error ?? null }));
    if (/Campaign budget exhausted|Budget ledger locked/.test(result.error ?? '')) throw new Error('Budget refusal; remaining cells unrun');
    if (read(ledger).entries.reduce((n, e) => n + (e.charged_usd ?? e.reserved_usd), 0) >= 49) throw new Error('Conservative budget threshold reached');
  }
  console.log(JSON.stringify({ completed: run }));
} else throw new Error('Use prepare --source RUN --output NEW_RUN --model SELECTOR --simple-model SELECTOR, then execute --run NEW_RUN --ledger LEDGER');
