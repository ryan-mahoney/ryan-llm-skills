import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, realpathSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, basename, join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { activityRecorder } from './monitor.mjs';
import { SCOUT_MODEL } from './scout.mjs';
import { createLogSummary } from '../../../scripts/spec-facts/core.mjs';
import { checkPackage, locatePackage, setWorktree, stamp } from '../../../scripts/spec-location/index.mjs';
import { decide, collectFacts } from '../../../scripts/jev/core.mjs';
import { preparedEntry } from './startup.mjs';
import { splitModelSelector, configurationFailure, configurationAction } from './model-selector.mjs';
import { submitCompletion, completionStatus, refreshProgress, revision, recordVerification, invalidateCompletion } from './completion.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const terminal = new Set(['completed', 'failed', 'cancelled', 'stale']);
const timestamp = () => new Date().toISOString();
const read = file => JSON.parse(readFileSync(file, 'utf8'));
function atomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel);
}
export function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return true;
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}
export function event(record, name, detail = {}) {
  appendFileSync(join(record.package, 'runtime/events.jsonl'), `${JSON.stringify({ timestamp: timestamp(), event: name, run_id: record.id, ...detail })}\n`, { mode: 0o600 });
}
function save(record) {
  atomic(join(record.package, 'runtime/runs', `${record.id}.json`), record);
  atomic(join(record.package, 'runtime/run.json'), record);
}
// A spec-location refusal as an Error that keeps the machine-readable code and remedy.
export function refusalError({ code, message, remedy }) {
  return Object.assign(new Error(`${code}: ${message}${remedy ? ` ${remedy}` : ''}`), { code, remedy });
}
// The real package folder for a `workspace/slug` ref, the folder, or a file inside it.
export async function packageDirOf(ref, location = {}) {
  const found = await locatePackage(ref, location);
  if (!found.ok) throw refusalError(found);
  return realpathSync(found.packageDir);
}
// loadRun takes an already located package folder (or a file inside it).
const packageFolder = path => { const real = realpathSync(path); return statSync(real).isFile() ? dirname(real) : real; };
export function loadRun(packagePath, id) {
  if (id && !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid run_id');
  return read(join(packageFolder(packagePath), 'runtime', id ? `runs/${id}.json` : 'run.json'));
}
export function summary(record) {
  return { run_id: record.id, assignment_id: record.assignment_id, workflow_id: record.workflow_id ?? null,
    attempt_kind: record.attempt_kind ?? null, session_scope: record.session_scope ?? 'package', state: record.state, package: record.package, package_ref: record.package_ref ?? null, step: record.step,
    target: record.target ?? null, checkout: record.checkout, owner_session: record.owner_session, editor_session: record.editor_session,
    ledger: join(record.package, 'runtime/progress.json'), run_receipt: join(record.package, 'runtime/run.json'), events: join(record.package, 'runtime/events.jsonl'),
    checks: ['canonical package', 'checkout repository and target branch', 'no live coordinator already running this package'],
    owner_model: record.owner_model, editor_model: record.editor_model, routing_reason: record.routing_reason,
    environment: record.environment,
    handoff: record.handoff || completionStatus(record), progress: join(record.package, 'runtime/progress.json'),
    result: record.result, result_truncated: record.result_truncated, full_result_path: record.full_result_path, error: record.error,
    next: record.handoff?.status === 'handoff_incomplete' ? 'Repair the structured handoff only; preserve code and prior checks. Review/fix remains required.' : record.state === 'running' ? 'await completion event; do not poll' : record.state === 'blocked' ? 'resolve worker termination before another writer' : 'evaluate result; independent step review remains required' };
}
// A run holds the writer role while its own record is running (or blocked on a live
// process group) and nothing has revoked it. Revocation is a marker file so a worker
// process can revoke without rewriting the coordinator's run record.
const runFileOf = record => join(record.package, 'runtime/runs', `${record.id}.json`);
const revokedFile = record => join(record.package, 'runtime/runs', `${record.id}-revoked.json`);
export const editorSlot = record => join(record.package, 'runtime/runs', `${record.id}-editor-slot`);
export function assertLease(record) {
  let current;
  try { current = read(runFileOf(record)); } catch { /* absent */ }
  if (!['running', 'blocked'].includes(current?.state) || existsSync(revokedFile(record))) throw new Error('Writer lease is absent, replaced, or revoked; stop this assignment.');
}
export function revoke(record) {
  atomic(revokedFile(record), { revoked_at: timestamp() });
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
const processDir = record => join(record.package, 'runtime/runs', `${record.id}-processes`);
export function trackGroup(record, pid, role) {
  if (!pid) return;
  atomic(join(processDir(record), `${pid}.json`), { pid, role, active: true, started_at: timestamp() });
}
export function activeGroups(record) {
  if (!existsSync(processDir(record))) return [];
  return readdirSync(processDir(record)).filter(name => name.endsWith('.json')).map(name => read(join(processDir(record), name))).filter(entry => entry.active);
}
export function settleGroup(record, pid) {
  if (!pid || groupAlive(pid)) return false;
  const file = join(processDir(record), `${pid}.json`);
  if (existsSync(file)) atomic(file, { ...read(file), active: false, finished_at: timestamp() });
  return true;
}
async function waitGroupsGone(record, pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const alive = pids.filter(pid => !settleGroup(record, pid));
    if (!alive.length) return true;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  } while (Date.now() < deadline);
  return false;
}
function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
// Only call for a group created and tracked by this live invocation, never an
// arbitrary PID recovered from disk. Failure leaves the run blocked and still active.
export async function terminateGroup(record, pid) {
  if (settleGroup(record, pid)) return true;
  signalGroup(pid, 'SIGTERM');
  if (await waitGroupsGone(record, [pid], 1000)) return true;
  signalGroup(pid, 'SIGKILL');
  return waitGroupsGone(record, [pid], 1000);
}
// Register every detached group before it can execute useful work. If its launcher
// dies before releasing stdin, the wrapper sees EOF and exits without running a worker.
export function spawnManaged(record, role, command, args, onRegistered = () => {}) {
  const child = spawn('/bin/bash', ['-c', 'IFS= read -r gate && [ "$gate" = start ] && exec "$@"', 'spec-runtime', command, ...args], {
    cwd: record.checkout, detached: true,
    env: { ...process.env, SPEC_RUNTIME_ROLE: role, SPEC_RUNTIME_RECORD: join(record.package, 'runtime/runs', `${record.id}.json`),
      PI_INTERCOM_SCOPE_ID: record.id, PI_INTERCOM_STABLE_ID: `spec-${role}-${record.id}` },
    stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  trackGroup(record, child.pid, role);
  try {
    onRegistered(child);
    assertLease(record);
    child.stdin.end('start\n');
  } catch (error) {
    child.launchError = error.message;
    child.stdin.end();
  }
  return child;
}
// The target a step changes: its spec-steps.json `repository`, or the package's only target.
function stepTarget(locations, packagePath, step) {
  const number = /^step-(\d+)-subspec\.md$/.exec(basename(step))?.[1];
  let declared;
  try { declared = read(join(packagePath, 'spec-steps.json')).steps.find(entry => entry.step === Number(number))?.repository; } catch { /* no step list */ }
  const ids = locations.targets.map(entry => entry.id).join(', ');
  if (declared === undefined && locations.targets.length === 1) return locations.targets[0];
  if (declared === undefined) throw refusalError({ code: 'step-repository-missing', message: `${basename(step)} names no repository and ${locations.package_ref} has ${locations.targets.length} targets (${ids}).`,
    remedy: 'Set `repository` on the step in spec-steps.json.' });
  const target = locations.targets.find(entry => entry.id === declared);
  if (!target) throw refusalError({ code: 'step-repository-unknown', message: `${basename(step)} names repository ${JSON.stringify(declared)}, which is not a target of ${locations.package_ref} (${ids}).`,
    remedy: 'Set `repository` on the step in spec-steps.json to one of the package targets.' });
  return target;
}

export async function resolveInput(input, location = {}) {
  if (input.attempt_kind !== undefined && !['implementation', 'verification-continuation', 'implementation-repair', 'review-repair', 'launch-retry'].includes(input.attempt_kind))
    throw new Error('Unknown attempt_kind');
  if (input.session_scope !== undefined && !['package', 'step'].includes(input.session_scope))
    throw new Error('session_scope must be package or step');
  input = { ...input, owner_model: input.owner_override || input.owner_model,
    routing_reason: input.owner_override ? 'explicit step override' : input.routing_reason };
  const checked = await checkPackage(input.package, location);
  if (!checked.ok) throw refusalError(checked);
  const locations = checked.locations;
  const packagePath = realpathSync(locations.package_dir);
  for (const key of ['owner_model', 'editor_model']) splitModelSelector(input[key]);
  const step = realpathSync(input.step);
  if (!inside(packagePath, step)) throw new Error('step must be inside the package');
  const target = stepTarget(locations, packagePath, step);
  const primary = realpathSync(target.primary);
  const common = realpathSync(target.common);
  const worktree = target.worktree ?? resolve(join(dirname(primary), `${basename(primary)}-${basename(packagePath)}`));
  if (!existsSync(worktree)) {
    let existing = false;
    try { git(primary, 'show-ref', '--verify', `refs/heads/${target.branch}`); existing = true; } catch { /* new branch */ }
    git(primary, 'worktree', 'add', ...(existing ? [worktree, target.branch] : ['-b', target.branch, worktree, input.base || 'HEAD']));
  }
  const actual = realpathSync(worktree);
  if (realpathSync(git(actual, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== common) throw new Error('worktree is not in the target repository');
  if (git(actual, 'branch', '--show-current') !== target.branch) throw new Error(`worktree is not on the target branch ${target.branch}`);
  if (target.worktree !== actual) {
    const recorded = await setWorktree(locations.package_ref, target.id, actual, location);
    if (!recorded.ok) throw refusalError(recorded);
    // Cards written after the package was created get their Locations block on first dispatch; stamp is idempotent.
    const stamped = await stamp(locations.package_ref, location);
    if (!stamped.ok) throw refusalError(stamped);
  }
  // Other targets' recorded worktrees are read-only context for the owner and editor.
  const others = locations.targets.filter(entry => entry.id !== target.id && entry.worktree).map(({ id, worktree }) => ({ id, worktree }));
  return { ...input, scout_model: input.scout_model || SCOUT_MODEL, package: packagePath, package_ref: locations.package_ref, target: target.id, primary, step, checkout: actual, other_targets: others };
}

// Prompt lines naming the step's target and, read-only, the package's other worktrees.
const targetFacts = record => record.target ? `TARGET: ${record.target}\n${record.other_targets?.length ? `OTHER TARGETS (read-only context, never edit): ${record.other_targets.map(entry => `${entry.id}=${entry.worktree}`).join('; ')}\n` : ''}` : '';

export function environmentFacts(checkout, primary) {
  const roots = [...new Set([checkout, primary])];
  return { checkout, primary, observed_only: true,
    dependency_paths: roots.flatMap(root => ['deps', 'node_modules'].map(name => join(root, name))).filter(existsSync),
    build_paths: roots.flatMap(root => ['_build', 'dist'].map(name => join(root, name))).filter(existsSync),
    configured_paths: Object.fromEntries(['MIX_DEPS_PATH', 'MIX_BUILD_PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
    next: 'Resolve missing dependencies from these paths or repository setup instructions. Existence is not compatibility or permission to share writable build output. Do not search the filesystem root.' };
}

// Each assignment is a fresh native print process using the same retained Pi session file.
// Discovery stays disabled: no goal continuation, subagent fanout, or unrelated extension tools.
export function launch(record, role, prompt, options = {}) {
  const session = record[`${role}_session`];
  const stream = join(record.package, 'runtime/runs', `${record.id}-${role}-${randomUUID()}.jsonl`);
  const errors = `${stream}.stderr`;
  const profile = resolve(here, '../../agents', role === 'owner' ? 'spec-step-owner.md' : 'spec-step-editor.md');
  const selector = splitModelSelector(record[`${role}_model`]);
  const args = [ ...(options.prefix || []), '--print', '--mode', 'json', '--session', session,
    '--provider', selector.provider, '--model', selector.model,
    ...(selector.thinking ? ['--thinking', selector.thinking] : []), '--no-extensions', '--no-skills', '--no-prompt-templates',
    ...((record.child_extensions || []).flatMap(path => ['--extension', path])),
    ...(role === 'owner' ? ['--extension', join(homedir(), '.pi/agent/npm/node_modules/pi-subagents/index.js')] : []),
    '--extension', join(here, 'index.ts'), '--tools', role === 'owner' ? 'read,grep,find,ls,spec_editor,spec_answer,spec_verify,spec_scout,spec_search,spec_advice,spec_complete' : 'read,grep,find,ls,edit,write,bash,spec_question',
    '--append-system-prompt', profile, '--', prompt ];
  const child = spawnManaged(record, role, options.command || 'pi', args);
  const activity = activityRecorder(record, role);
  let reportLifecycleFailure;
  const lifecycleFailure = new Promise(resolveFailure => { reportLifecycleFailure = resolveFailure; });
  let pending = '', finalText = '', lastStop, failure, stderr = '';
  child.stdout.on('data', chunk => {
    appendFileSync(stream, chunk, { mode: 0o600 });
    pending += chunk.toString();
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        activity.event(value);
        // Fatal lifecycle handling is independent of observation: the cleanup
        // receipt is reported before any observer seam runs, so a hostile or
        // blocking observer can never delay mandatory cancellation.
        if (value.type === 'tool_execution_end' && value.result?.details?.requires_cancellation)
          reportLifecycleFailure(value.result.details.error);
        // A narrow observation seam: a bad observer degrades observation only.
        try { options.onEvent?.(record, value); } catch { /* Observer failure must never affect the run. */ }
        if (value.type === 'message_end' && value.message?.role === 'assistant') {
          lastStop = value.message.stopReason;
          finalText = (value.message.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
          // A later successful final response can recover a transient provider error.
          // Keep every event in the stream, but classify the final attempt's outcome.
          failure = lastStop === 'error' || lastStop === 'aborted' ? value.message.errorMessage || lastStop : undefined;
        }
      } catch { /* preserve non-JSON diagnostics on disk */ }
    }
  });
  child.stderr.on('data', chunk => { appendFileSync(errors, chunk, { mode: 0o600 }); stderr = (stderr + chunk.toString()).slice(-8000); });
  const done = new Promise(resolveDone => {
    child.on('error', error => { failure = error.message; });
    child.on('close', (code, signal) => {
      const error = child.launchError || failure || (code !== 0 ? `Pi exited ${code ?? signal}` : !finalText || lastStop === 'toolUse' ? 'Pi exited without a final assistant result' : undefined);
      activity.finish(error);
      const fullResultPath = `${stream}.result.txt`;
      try {
        writeFileSync(fullResultPath, finalText, { mode: 0o600 });
        const truncated = finalText.length > 8000;
        const notice = `\n[Result truncated. Read the needed portion of ${fullResultPath}; do not repeat the assignment.]`;
        resolveDone({ code, signal, result: truncated ? finalText.slice(0, Math.max(0, 8000 - notice.length)) + notice : finalText,
          result_truncated: truncated, full_result_path: fullResultPath, stream, errors, error, configuration_failure: configurationFailure(error) || (error ? configurationFailure(stderr) : undefined) });
      } catch (cause) {
        resolveDone({ code, signal, stream, errors, error: `Cannot preserve full result: ${cause.message}${error ? `; ${error}` : ''}` });
      }
    });
  });
  return { child, done, lifecycleFailure };
}

export class Runtime {
  constructor({ launchProcess = launch, isAlive = groupAlive, kill = (pid, signal) => process.kill(-pid, signal), notify = () => {}, indexDir = join(homedir(), '.pi/agent/spec-runtime'), onWorkerEvent = () => {}, location = {} } = {}) {
    // `location` carries spec-location options (root, env, home, hostname); tests inject them.
    this.location = location;
    this.launchProcess = launchProcess; this.isAlive = isAlive; this.kill = kill; this.notify = notify; this.indexDir = indexDir; this.active = new Map(); this.cancellations = new Map();
    this.onWorkerEvent = onWorkerEvent;
  }
  async startup(input, parentSession) {
    const requestedAt = timestamp();
    const checked = await checkPackage(input.package, this.location);
    if (!checked.ok) throw refusalError(checked);
    const packagePath = realpathSync(checked.locations.package_dir);
    const entry = await preparedEntry(packagePath, input, checked.locations);
    if (entry.state) return entry.run_id ? { ...summary(loadRun(packagePath, entry.run_id)), ...entry } : entry;
    return this.start({ ...input, ...entry, dispatch_requested_at: requestedAt }, parentSession);
  }
  async start(input, parentSession) {
    const requestedAt = input.dispatch_requested_at || timestamp();
    if (process.platform === 'win32') throw new Error('spec-runtime requires POSIX process groups');
    // A supplied workflow_id is carried, never inferred; reject a malformed one
    // before any package or run side effect.
    if (input.workflow_id !== undefined
      && (typeof input.workflow_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.workflow_id)))
      throw new Error('workflow_id must be 1-128 ASCII letters/digits/underscore/hyphen');
    // Everything after this await is synchronous, so the check-then-write below cannot interleave in this process.
    const config = await resolveInput(input, this.location);
    const key = input.assignment_id || config.step;
    const runtimeDir = join(config.package, 'runtime');
    mkdirSync(join(runtimeDir, 'runs'), { recursive: true });
    const assignmentFile = join(runtimeDir, 'assignments', `${createHash('sha256').update(key).digest('hex')}.json`);
    const contractParts = [config.step, config.target, config.checkout, config.owner_model, config.editor_model, config.scout_model, config.child_extensions || [], config.instructions || ''];
    if (config.attempt_kind !== undefined || config.session_scope === 'step')
      contractParts.push({ attempt_kind: config.attempt_kind ?? null, session_scope: config.session_scope ?? 'package' });
    // A supplied workflow_id joins the launch contract so an existing assignment
    // cannot be reused under another workflow; the legacy/no-workflow shape is
    // preserved exactly.
    const contract = JSON.stringify(config.workflow_id == null ? contractParts : [...contractParts, config.workflow_id]);
    if (existsSync(assignmentFile)) {
      const previous = read(assignmentFile);
      if (previous.contract !== contract) throw new Error('assignment_id already identifies a different launch contract; use a new explicit attempt ID for an intentional change.');
      return summary(loadRun(config.package, previous.run_id));
    }
    // No lock folders: a live coordinator pid in run.json is the writer claim. A dead
    // coordinator's run is marked stale. Two processes starting in the same instant can both pass.
    const latest = join(runtimeDir, 'run.json');
    if (existsSync(latest)) {
      const prior = read(latest);
      if (['running', 'cancelling', 'blocked'].includes(prior.state)) {
        const pid = prior.coordinator_pid ?? prior.pid;
        if (processAlive(pid)) throw refusalError({ code: 'run-active', message: `Run ${prior.id} is ${prior.state} and its coordinator (pid ${pid}) is alive.`,
          remedy: 'Await its completion or confirmed cancellation; start a new run only after it ends.' });
        prior.state = 'stale'; prior.finished_at = timestamp();
        save(prior); event(prior, 'run_stale', { coordinator_pid: pid });
      }
    }
    const id = randomUUID();
    const sessionKey = [config.target, config.checkout, config.owner_model, config.editor_model, config.child_extensions || []];
    if (config.session_scope === 'step') sessionKey.push(config.step);
    const pair = createHash('sha256').update(JSON.stringify(sessionKey)).digest('hex').slice(0, 16);
    const sessionDir = join(runtimeDir, 'sessions', pair);
    mkdirSync(sessionDir, { recursive: true });
    const record = { schema_version: 1, completion_contract: 1, id, assignment_id: key, workflow_id: config.workflow_id ?? null, package: config.package, package_ref: config.package_ref, target: config.target, primary: config.primary, other_targets: config.other_targets,
      step: config.step, checkout: config.checkout, owner_model: config.owner_model, editor_model: config.editor_model, scout_model: config.scout_model,
      dispatch_requested_at: requestedAt, routing_reason: config.routing_reason,
      attempt_kind: config.attempt_kind ?? null, session_scope: config.session_scope ?? 'package',
      environment: environmentFacts(config.checkout, config.primary),
      child_extensions: config.child_extensions || [], owner_session: join(sessionDir, 'owner.jsonl'), editor_session: join(sessionDir, 'editor.jsonl'),
      parent_session: parentSession, coordinator_pid: process.pid, state: 'running', started_at: timestamp(), timeout_ms: input.timeout_ms || 7200000 };
    save(record);
    atomic(assignmentFile, { assignment_id: key, run_id: record.id, contract });
    mkdirSync(this.indexDir, { recursive: true });
    atomic(join(this.indexDir, `${id}.json`), { run_id: id, package: config.package, package_ref: config.package_ref, manifest: join(runtimeDir, 'runs', `${id}.json`), parent_session: parentSession });
    const prompt = `Implement this prepared step as its architect/owner using spec_editor.\nPACKAGE: ${record.package}\nSTEP: ${record.step}\nCHECKOUT: ${record.checkout}\nPRIMARY: ${record.primary}\n${targetFacts(record)}Read the card and required policy. Choose the implementation approach yourself, then send a short Change/Edits/Preserve/Return packet for a bounded transformation. Name affected symbols, the chosen approach and preservation constraints; let the editor choose local implementation details and batch related edits. The editor does not run tests, compile/lint checks or other executable verification. After it returns, use spec_verify for necessary focused checks and diagnose failures before assigning bounded corrections. Do not check every packet automatically; reuse valid evidence. Read/search missing source facts directly. The editor normally reads and edits in one assignment; reserve facts-only requests for a specific blocking fact unavailable through your tools. Request compact results with artifact paths, not source inventories. Do not delegate architecture, whole-step restoration, or an entire acceptance suite with open-ended repairs. Reuse retained context. Assess each returned diff/result before the next packet; commit is a separate assignment after acceptance of the completed changes and required evidence. Use spec_scout only for a bounded discovery gap worth delegating; direct reads remain the default. Do not discover models, run startup suites, poll, or start other agents outside that scout tool. The runtime retains both sessions. Before ending, call spec_complete with decisions, introduced symbols, gaps and step-owned evidence assessments. It writes the canonical learning from verification receipts; an evidence log is not a learning. Commit via the editor first when complete. Missing handoffs remain unfinished obligations. This owner assignment ends after this step; independent review belongs to the coordinator.\n${input.instructions || ''}`;
    let task;
    try { task = this.launchProcess(record, 'owner', `${prompt}\nEnvironment paths (observations, not setup approval): ${JSON.stringify(record.environment)}`, { onEvent: this.onWorkerEvent }); }
    catch (error) { record.state = 'failed'; record.error = error.message; save(record); throw error; }
    record.pid = task.child.pid;
    save(record); refreshProgress(record.package).catch(error => { record.progress_error = error.message; }); event(record, 'run_started', { dispatch_requested_at: requestedAt, owner_session: record.owner_session, editor_session: record.editor_session, parent_session: parentSession, pid: record.pid });
    const timer = setTimeout(() => { event(record, 'deadline_reached'); this.cancel(record.package, id).then(value => this.notify(value)).catch(error => this.notify({ ...summary(record), error: error.message })); }, record.timeout_ms);
    timer.unref();
    this.active.set(id, { record, task, timer });
    task.lifecycleFailure?.then(error => {
      if (terminal.has(record.state) || record.state === 'cancelling') return;
      this.notify({ ...summary(record), error, next: 'runtime is cancelling its managed processes; do not launch another writer' });
      this.cancel(record.package, id).then(value => this.notify(value)).catch(cause => this.notify({ ...summary(record), error: cause.message }));
    });
    task.done.then(result => this.finish(record, result)).catch(error => {
      record.state = 'blocked'; record.error = error.message; save(record); this.notify(summary(record));
    });
    return summary(record);
  }
  async finish(record, result) {
    if (record.state === 'cancelling' || terminal.has(record.state)) return;
    for (const group of activeGroups(record)) settleGroup(record, group.pid);
    if (activeGroups(record).length || (record.pid && this.isAlive(record.pid))) {
      record.state = 'blocked'; record.error = 'A managed process group is still alive; the run stays active.';
    } else {
      record.state = result.error ? 'failed' : 'completed'; record.error = result.error; record.result = result.result;
      record.handoff = completionStatus(record, { checkHead: true });
      record.result_truncated = result.result_truncated; record.full_result_path = result.full_result_path; record.finished_at = timestamp();
    }
    save(record); event(record, 'run_finished', { state: record.state, error: record.error });
    if (record.state !== 'blocked') { clearTimeout(this.active.get(record.id)?.timer); this.active.delete(record.id); }
    try { await refreshProgress(record.package); } catch (error) { record.progress_error = error.message; save(record); }
    this.notify({ ...summary(record), progress_error: record.progress_error });
  }
  cancel(packagePath, id, timeoutMs = 5000) {
    const record = loadRun(packagePath, id);
    if (this.cancellations.has(record.id)) return this.cancellations.get(record.id);
    const pending = this.cancelRun(packagePath, record.id, timeoutMs).finally(() => this.cancellations.delete(record.id));
    this.cancellations.set(record.id, pending);
    return pending;
  }
  async cancelRun(packagePath, id, timeoutMs) {
    const disk = loadRun(packagePath, id);
    const active = this.active.get(disk.id);
    const record = active?.record || disk;
    if (terminal.has(record.state)) return summary(record);
    // A PID read from a previous coordinator cannot safely identify an OS process after PID reuse.
    if (!active) throw new Error('This runtime does not own the live process handle. The run stays active; recover the original coordinator or confirm termination manually.');
    revoke(record); record.state = 'cancelling'; save(record); event(record, 'cancel_requested');
    try {
      let groups = activeGroups(record).map(group => group.pid);
      for (const pid of groups.reverse()) { try { this.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      if (!(await waitGroupsGone(record, groups, timeoutMs))) {
        groups = activeGroups(record).map(group => group.pid);
        for (const pid of groups.reverse()) { try { this.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
        if (!(await waitGroupsGone(record, groups, timeoutMs))) throw new Error('Process group still alive after cancellation');
      }
      // A child launcher may have registered a gated group during the first snapshot.
      // Revocation prevents that gate opening; still join every newly registered group.
      groups = activeGroups(record).map(group => group.pid);
      for (const pid of groups) { try { this.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      if (!(await waitGroupsGone(record, groups, timeoutMs))) throw new Error('A newly registered process group has not stopped');
      record.state = 'cancelled'; record.finished_at = timestamp(); save(record); event(record, 'run_finished', { state: 'cancelled' });
      clearTimeout(active.timer); this.active.delete(record.id);
      try { await refreshProgress(record.package); } catch (error) { record.progress_error = error.message; }
      return summary(record);
    } catch (error) {
      record.state = 'blocked'; record.error = `Cancellation unconfirmed: ${error.message}`; save(record); event(record, 'cancellation_failed', { error: record.error });
      throw new Error(record.error);
    }
  }
}

export async function runEditor(record, assignment, signal, launchProcess = launch, { stopGroup = terminateGroup } = {}) {
  assertLease(record);
  const configFile = join(record.package, 'runtime/runs', `${record.id}-editor-configuration.json`);
  if (existsSync(configFile)) {
    const failure = read(configFile);
    if (failure.selector === record.editor_model) return { error: configurationAction(failure.selector, failure.cause), configuration_failure: failure, coordinator_action_required: true };
  }
  const editorLock = editorSlot(record);
  try { mkdirSync(editorLock); } catch { throw new Error('An editor assignment is already active; await its result.'); }
  let task;
  try {
    invalidateCompletion(record);
    task = launchProcess(record, 'editor', `PACKAGE: ${record.package}\nSTEP: ${record.step}\nCHECKOUT: ${record.checkout}\nPRIMARY: ${record.primary}\n${targetFacts(record)}${assignment}`);
    event(record, 'editor_started', { pid: task.child.pid, editor_session: record.editor_session });
    let stopping;
    let reportUnconfirmed;
    const unconfirmed = new Promise(resolveFailure => { reportUnconfirmed = resolveFailure; });
    const abort = () => {
      revoke(record);
      stopping ||= stopGroup(record, task.child.pid).then(stopped => {
        if (!stopped) reportUnconfirmed({ error: 'Editor termination unconfirmed', requires_cancellation: true });
      }).catch(() => reportUnconfirmed({ error: 'Editor termination unconfirmed', requires_cancellation: true }));
    };
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const fatal = task.lifecycleFailure?.then(error => ({ error, requires_cancellation: true }));
    const result = await Promise.race([task.done, unconfirmed, ...(fatal ? [fatal] : [])]);
    signal?.removeEventListener('abort', abort);
    await stopping;
    if (signal?.aborted) {
      result.error ||= 'Editor interrupted; lease revoked pending coordinator cancellation.';
      result.requires_cancellation = true;
    }
    settleGroup(record, task.child.pid);
    const surviving = activeGroups(record).filter(group => group.role !== 'owner');
    if (surviving.length) {
      revoke(record);
      result.error = 'Editor or command descendants remain alive. Lease revoked; coordinator must cancel this run before replacing the editor.';
      result.requires_cancellation = true;
    }
    const configFailure = !result.requires_cancellation && (result.configuration_failure || configurationFailure(result.error));
    if (configFailure) {
      const failure = { ...configFailure, selector: record.editor_model, run_id: record.id, timestamp: timestamp() };
      atomic(configFile, failure);
      result.configuration_failure = failure;
      result.error = configurationAction(failure.selector, failure.cause);
      result.coordinator_action_required = true;
      event(record, 'editor_configuration_failed', failure);
    }
    event(record, 'editor_finished', { state: result.error ? 'failed' : 'completed', error: result.error });
    return result;
  } finally { if (!task || !activeGroups(record).some(group => group.role !== 'owner')) rmSync(editorLock, { recursive: true, force: true }); }
}

// Share the editor slot so checks cannot race writes, even during a question pause.
export async function runCompletion(record, input) {
  return withIdleWriter(record, async () => {
    const receipt = submitCompletion(record, input);
    event(record, 'handoff_recorded', { outcome: receipt.outcome, learning_path: receipt.learning_path });
    try { await refreshProgress(record.package); }
    catch (error) { return { ...receipt, progress_error: error.message, next: 'Handoff saved; refresh derived progress, not verification.' }; }
    return receipt;
  });
}

// Fingerprints record what was verified and how complete that evidence is; the
// command and summary text themselves are never retained here.
const normalizeCommand = command => String(command).replace(/\r\n/g, '\n').trim();
const normalizeSummary = text => String(text ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n');
const sha256Hex = value => createHash('sha256').update(value).digest('hex');

async function checkoutDigest(checkout) {
  if (typeof checkout !== 'string') return { tree_digest: null, complete: false };
  try {
    const facts = await collectFacts(checkout);
    return { tree_digest: typeof facts.working_tree_digest === 'string' ? facts.working_tree_digest : null,
      complete: Boolean(facts.working_tree_digest) && facts.incomplete !== true };
  } catch { return { tree_digest: null, complete: false }; }
}

async function verificationFingerprint(record, command, reply) {
  const digest = await checkoutDigest(record?.checkout);
  const exitCode = typeof reply?.exit_code === 'number' && Number.isFinite(reply.exit_code) ? reply.exit_code : null;
  return {
    version: 1,
    command_sha256: sha256Hex(normalizeCommand(command)),
    summary_sha256: sha256Hex(normalizeSummary(reply?.output)),
    tree_digest: digest.tree_digest,
    complete: reply?.output_truncated !== true && !reply?.error && !reply?.requires_cancellation
      && digest.complete && exitCode !== null && exitCode !== 0,
    exit_code: exitCode,
  };
}

export async function runVerification(record, command, timeout = 120, signal, server) {
  return withIdleWriter(record, async () => {
    invalidateCompletion(record);
    const before = revision(record);
    const started_at = timestamp(), started = performance.now();
    const timing = () => ({ started_at, elapsed_ms: Math.round(performance.now() - started) });
    let reply;
    try {
      reply = await (server
        ? withVerificationServer(record, server, () => runCommand(record, command, timeout, signal), signal)
        : runCommand(record, command, timeout, signal));
    } catch (error) {
      const receipt = recordVerification(record, command, before, revision(record), { error: error.message, exit_code: null }, timing());
      event(record, 'verification_finished', { receipt_id: receipt.id, outcome: receipt.outcome });
      error.receipt_id = receipt.id;
      throw error;
    }
    const receipt = recordVerification(record, command, before, revision(record), reply, timing());
    event(record, 'verification_finished', { receipt_id: receipt.id, outcome: receipt.outcome });
    const facts = { receipt_id: receipt.id, observed_revision: receipt.before, verification_artifact: receipt.summary_artifact,
      started_at: receipt.started_at, observed_at: receipt.observed_at, elapsed_ms: receipt.elapsed_ms };
    if (typeof reply?.exit_code !== 'number' || reply.exit_code === 0) return { ...reply, ...facts };
    return { ...reply, ...facts, sentinel_failure: await verificationFingerprint(record, command, reply) };
  });
}

// A server belongs to one verification operation, including its readiness wait,
// capture, and cleanup. It never survives a handoff to an editor.
export async function withVerificationServer(record, server, verify, signal) {
  const url = new URL(server.ready_url);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password)
    throw new Error('Verification server readiness URL must be loopback HTTP(S) without credentials');
  if (typeof server.command !== 'string' || !server.command.trim()) throw new Error('Verification server command is required');
  const ready = async () => {
    try {
      const response = await fetch(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(500)]) : AbortSignal.timeout(500) });
      await response.body?.cancel();
      return response.ok;
    } catch { return false; }
  };
  if (signal?.aborted) throw new Error('Verification interrupted before server start');
  if (await ready()) throw new Error('Readiness URL already responds; choose an owned free port. Existing server left untouched.');
  assertLease(record);
  const output = join(record.package, 'runtime/runs', `${record.id}-server-${randomUUID()}.log`);
  writeFileSync(output, '', { mode: 0o600, flag: 'wx' });
  const child = spawnManaged(record, 'server', '/bin/bash', ['-o', 'pipefail', '-c', `export SHELLOPTS\n${server.command}`]);
  let exited = false, serverError, result;
  child.on('error', error => { serverError = error.message; exited = true; });
  child.on('exit', () => { exited = true; });
  child.stdout.on('data', chunk => appendFileSync(output, chunk));
  child.stderr.on('data', chunk => appendFileSync(output, chunk));
  event(record, 'verification_server_started', { pid: child.pid });
  try {
    const deadline = Date.now() + Math.min(600, Math.max(1, server.readiness_timeout ?? 60)) * 1000;
    while (true) {
      if (signal?.aborted) throw new Error('Verification interrupted during server readiness');
      if (exited || child.launchError) throw new Error(`Verification server exited before capture: ${serverError || child.launchError || 'inspect server log'}`);
      if (await ready()) break;
      if (Date.now() >= deadline) throw new Error('Verification server readiness timed out');
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    if (exited) throw new Error('Verification server exited at readiness');
    assertLease(record);
    result = await verify();
    if (exited && !result.error) result.error = 'Verification server exited during capture; inspect server log';
  } catch (error) { result = { exit_code: null, error: error.message }; }
  finally {
    let stopped = false;
    try { stopped = await terminateGroup(record, child.pid); } catch { /* preserve the lease below */ }
    event(record, 'verification_server_finished', { stopped });
    if (!stopped) {
      revoke(record);
      result = { ...result, error: 'Server cleanup unconfirmed; lease revoked pending coordinator cancellation.', requires_cancellation: true };
    }
  }
  return { ...result, server_output_path: output };
}

export async function runAdvice(record, task, input, { offline = false, signal, decideTask = decide } = {}) {
  return withIdleWriter(record, async () => {
    if (signal?.aborted) throw new Error('Jev request aborted');
    const reply = await decideTask(task, { repo: record.checkout, input, offline });
    assertLease(record);
    if (signal?.aborted) throw new Error('Jev request aborted; do not use its recommendation');
    return reply;
  });
}

// The smallest synchronous idle-writer assertion owned by Runtime: a valid
// run, an unclaimed editor/verification slot, and no tracked non-owner managed
// group. withIdleWriter still performs the atomic slot claim via mkdir.
export function assertIdleWriter(record) {
  assertLease(record);
  if (existsSync(editorSlot(record))) throw new Error('An editor or verification command holds the writer slot.');
  if (activeGroups(record).some(group => group.role !== 'owner')) throw new Error('Managed work remains active; resolve it before another writer.');
}

async function withIdleWriter(record, action) {
  assertIdleWriter(record);
  const slot = editorSlot(record);
  try { mkdirSync(slot); } catch { throw new Error('Wait for the active editor or verification command to finish before verifying.'); }
  try {
    return await action();
  } finally { rmSync(slot, { recursive: true, force: true }); }
}

export async function runCommand(record, command, timeout = 120, signal, { stopGroup = terminateGroup } = {}) {
  assertLease(record);
  const output = join(record.package, 'runtime/runs', `${record.id}-command-${randomUUID()}.log`);
  writeFileSync(output, '', { mode: 0o600, flag: 'wx' });
  const logSummary = createLogSummary();
  const child = spawnManaged(record, 'command', '/bin/bash', ['-o', 'pipefail', '-c', `export SHELLOPTS\n${command}`]);
  let error, stopping;
  let reportUnconfirmed;
  const unconfirmed = new Promise(resolveFailure => { reportUnconfirmed = resolveFailure; });
  const consume = chunk => { appendFileSync(output, chunk); logSummary.write(chunk); };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  const stop = () => {
    error = 'Command interrupted or timed out';
    stopping ||= stopGroup(record, child.pid).then(stopped => {
      if (!stopped) reportUnconfirmed({ exit_code: null, signal: null });
    }).catch(cause => { error = cause.message; reportUnconfirmed({ exit_code: null, signal: null }); });
  };
  const timer = setTimeout(stop, timeout * 1000);
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop, { once: true });
  const closed = new Promise(resolveDone => {
    child.on('error', cause => { error = cause.message; });
    child.on('close', (code, sig) => resolveDone({ exit_code: code, signal: sig }));
  });
  // Failed termination must return a fatal receipt even if a descendant still
  // holds stdout open; otherwise the coordinator cannot begin cancellation.
  const outcome = await Promise.race([closed, unconfirmed]);
  clearTimeout(timer); signal?.removeEventListener('abort', stop); await stopping;
  let requiresCancellation = false;
  if (!(await waitGroupsGone(record, [child.pid], 1000))) {
    let stopped = false;
    try { stopped = await stopGroup(record, child.pid); } catch { /* retain the lease if cleanup is unconfirmed */ }
    if (stopped) error ||= 'Command left background descendants; runtime stopped them. Use the managed verification server option for capture.';
    else { revoke(record); requiresCancellation = true; error = 'Command cleanup unconfirmed; lease revoked pending coordinator cancellation.'; }
    event(record, 'command_cleanup', { stopped });
  }
  return { ...outcome, ...logSummary.finish(), full_output_path: output, error: child.launchError || error,
    ...(requiresCancellation ? { requires_cancellation: true } : {}) };
}
