// EV-14 native Linux wave cases 6, 7 and 8 (step 13, test-first).
//
// Each case runs the real wave stack through bootLinuxWave: a real user
// manager, the live (copied) host policy, real bwrap, the loopback provider and
// the coordinator driver. The only test-owned seams are the loopback transport
// and the barrier the provider already supports; no production module is
// patched.
//
// The helpers below read durable state only: runtime/waves/<id>.json,
// runtime/runs/<id>.json, the real systemctl user manager and /proc. They are
// shared with case 8, which registers its coordinator restart through the same
// entry point.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { bootLinuxWave } from './package-fixture.mjs';
import { parseUsecProperty } from './wave-linux-duration.mjs';
import { startCoordinator } from './wave-native-driver.mjs';

const GIB = 1024 ** 3;
const WAIT_INTERVAL_MS = 50;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Every wait is a bounded 50 ms poll, so a hung lifecycle fails on the label
// instead of hiding behind a fixed sleep.
async function waitFor(predicate, { timeoutMs = 30000, intervalMs = WAIT_INTERVAL_MS, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await delay(intervalMs);
  }
}

function parseJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function gitDirTree(gitDir, rev) {
  return execFileSync('git', ['--git-dir', gitDir, 'rev-parse', `${rev}^{tree}`],
    { encoding: 'utf8' }).trim();
}

function pidAlive(pid) {
  return Number.isInteger(pid) && pid > 0 && existsSync(`/proc/${pid}`);
}

function pidCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    return '';
  }
}

// The unified cgroup path of a live process, as the kernel reports it.
function pidCgroup(pid) {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n')
      .find(entry => entry.startsWith('0::'));
    if (!line) return null;
    const path = line.slice(3).trim();
    return path === '' ? null : path;
  } catch {
    return null;
  }
}

function cgroupPids(controlGroup) {
  const path = `/sys/fs/cgroup${controlGroup}/cgroup.procs`;
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(Number);
  } catch {
    return null;
  }
}

function pad3(step) {
  return String(step).padStart(3, '0');
}

function runtimeWavesDir(fixture) {
  return join(fixture.packagePath, 'runtime', 'waves');
}

function runtimeRunsDir(fixture) {
  return join(fixture.packagePath, 'runtime', 'runs');
}

// Every durable wave record; step seal receipts under the wave directory are
// not wave records and are excluded by requiring wave_id and steps.
function readWaveRecords(fixture) {
  const dir = runtimeWavesDir(fixture);
  if (!existsSync(dir)) return [];
  const records = [];
  for (const name of readdirSync(dir)) {
    if (!/^[A-Za-z0-9_-]{1,128}\.json$/.test(name)) continue;
    const record = parseJsonFile(join(dir, name));
    if (!record || typeof record.wave_id !== 'string' || !Array.isArray(record.steps)) continue;
    records.push(record);
  }
  return records;
}

function currentWaveRecord(fixture) {
  const records = readWaveRecords(fixture);
  if (records.length === 0) return null;
  records.sort((left, right) => String(left.started_at).localeCompare(String(right.started_at)));
  return records[records.length - 1];
}

async function waitForWave(fixture, predicate, { timeoutMs = 240000, label = 'wave record' } = {}) {
  return waitFor(() => {
    const record = currentWaveRecord(fixture);
    return record && predicate(record) ? record : null;
  }, { timeoutMs, label });
}

// Run records live at runtime/runs/<id>.json. Request files, verification
// receipts and command outputs are different artifacts and stay excluded.
function readRunRecords(fixture) {
  const dir = runtimeRunsDir(fixture);
  if (!existsSync(dir)) return [];
  const records = [];
  for (const name of readdirSync(dir)) {
    if (!/^[A-Za-z0-9_.-]+\.json$/.test(name)) continue;
    if (name.endsWith('-verification.json') || name.endsWith('-request.json')) continue;
    if (name.includes('-owner-') || name.includes('-reviewer-') || name.includes('-fixer-')) continue;
    const record = parseJsonFile(join(dir, name));
    if (!record || typeof record.id !== 'string' || !record.wave_bindings) continue;
    records.push(record);
  }
  return records;
}

function serviceOf(run) {
  return run?.service ?? run?.command_service ?? null;
}

function runUnit(run) {
  const service = serviceOf(run);
  return typeof service?.unit === 'string' ? service.unit : null;
}

function runCgroup(run) {
  const service = serviceOf(run);
  return typeof service?.control_group === 'string' ? service.control_group : null;
}

function runRuntimeMaxSec(run) {
  const service = serviceOf(run);
  const value = service?.runtime_max_sec ?? service?.runtimeMaxSec;
  return typeof value === 'number' ? value : null;
}

function memberRun(runs, step, phase = 'implementing') {
  return runs.find(run => run.wave_bindings?.step_number === step
    && run.wave_bindings?.phase === phase) ?? null;
}

function waveIdOf(record) {
  return record?.wave_id ?? null;
}

function heldImplementingRequests(provider) {
  return (provider.requests ?? []).filter(request => {
    const route = request?.route ?? {};
    return route.role === 'owner' && route.record?.phase === 'implementing';
  });
}

function requestPid(request) {
  return request?.route?.pid ?? null;
}

// The real user-manager properties of one unit, read as text.
function unitProperties(unit, names) {
  const result = spawnSync('systemctl', ['--user', 'show', unit, ...names.map(name => `--property=${name}`)],
    { encoding: 'utf8' });
  assert.equal(result.status, 0, `systemctl --user show ${unit}: ${result.stderr}`);
  const values = Object.create(null);
  for (const line of result.stdout.split('\n')) {
    const split = line.indexOf('=');
    if (split > 0) values[line.slice(0, split)] = line.slice(split + 1).trim();
  }
  return values;
}

function parseByteProperty(value) {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT])?$/i.exec(text);
  if (!match) return Number.NaN;
  const scale = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[String(match[2] || '').toUpperCase()] || 1;
  return Math.round(Number(match[1]) * scale);
}

function readPolicy(sandbox) {
  const path = join(sandbox.configHome, 'spec-runtime', 'host-policy.json');
  assert.ok(existsSync(path), `the copied live host policy exists at ${path}`);
  const policy = parseJsonFile(path);
  assert.ok(policy && policy.lifecycle && policy.aggregate, `saved host policy has lifecycle and aggregate values: ${path}`);
  return policy;
}

function walkJsonFiles(directory, out = []) {
  if (!existsSync(directory)) return out;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      walkJsonFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

function stepOfGateEntry(entry) {
  const step = entry.row?.step_number ?? entry.row?.step ?? entry.row?.subject?.step;
  if (Number.isInteger(step)) return step;
  const match = /step-(\d{3})/.exec(entry.file) ?? /step-(\d{2})/.exec(entry.file);
  return match ? Number(match[1]) : null;
}

function isCandidateGateEntry(entry) {
  const subject = entry.row?.subject?.kind ?? entry.row?.subject_kind ?? entry.row?.kind;
  if (subject === 'candidate') return true;
  if (entry.row?.candidate === true) return true;
  return /candidate/i.test(entry.file) && stepOfGateEntry(entry) === null;
}

// The real receipt output of one gate: a member receipt's `artifact`
// (completion.mjs recordVerification) or a candidate check's `artifact` field.
// The artifact is the actual command output; its last JSON line is the receipt
// the fixture check wrote.
function readReceiptOutput(artifact) {
  if (typeof artifact !== 'string' || artifact === '' || !existsSync(artifact)) return null;
  const text = readFileSync(artifact, 'utf8').trim();
  if (text === '') return null;
  try {
    return JSON.parse(text.split('\n').pop());
  } catch {
    return null;
  }
}

// Actual member gate receipts: runtime/runs/<run.id>-verification.json holds
// the recordVerification receipts {id,command,exit_code,artifact,summary_artifact}.
// Runs are correlated to members through wave_bindings.step_number/phase, so a
// receipt is attributed to the step that actually produced it. Each
// implementing member must carry a receipt whose exit_code is 0 and whose
// command names the fixture check that wrote evidence/fixture-check-NN.txt.
function readMemberGateReceipts(fixture, wave) {
  const runs = readRunRecords(fixture);
  const expected = new Map();
  for (const member of Object.values(wave.members ?? {})) {
    if (!Number.isInteger(member.step)) continue;
    const run = memberRun(runs, member.step, 'implementing');
    assert.ok(run, `step ${member.step} has an implementing run record to correlate its gate receipt`);
    const verificationPath = join(runtimeRunsDir(fixture), `${run.id}-verification.json`);
    assert.ok(existsSync(verificationPath), `step ${member.step} has a durable verification record at ${verificationPath}`);
    const receipts = parseJsonFile(verificationPath)?.receipts;
    assert.ok(Array.isArray(receipts), `step ${member.step} verification record carries receipts: ${verificationPath}`);
    const nn = String(member.step).padStart(2, '0');
    const receipt = receipts.find(entry => typeof entry.command === 'string'
      && entry.command.includes(fixture.packagePath)
      && entry.command.includes(`evidence/fixture-check-${nn}.txt`));
    assert.ok(receipt, `step ${member.step} implementing run ${run.id} holds the fixture-check-${nn}.txt gate receipt: ${JSON.stringify(receipts.map(entry => entry.command))}`);
    assert.equal(receipt.exit_code, 0, `step ${member.step} gate receipt exit_code is 0: ${JSON.stringify(receipt)}`);
    // The asserted receipt is the gate command itself: its stdout was
    // redirected into the package evidence file, so that file (not the raw
    // execution log the runtime keeps in receipt.artifact) is the receipt the
    // gate actually wrote.
    const evidencePath = join(fixture.packagePath, 'evidence', `fixture-check-${nn}.txt`);
    assert.ok(existsSync(evidencePath), `step ${member.step} gate wrote its evidence artifact at ${evidencePath}`);
    const output = readReceiptOutput(evidencePath);
    assert.ok(output, `step ${member.step} gate evidence carries parsed JSON: ${evidencePath}`);
    expected.set(member.step, { receipt, output, run });
  }
  return expected;
}

// Candidate gate receipts: the wave record's target.integration.checks[] carry
// the actual output_path of each candidate check. Every named output must exist,
// and each must hold the real overlay JSON the check wrote.
function readCandidateChecks(wave) {
  const checks = wave.target?.integration?.checks;
  assert.ok(Array.isArray(checks) && checks.length > 0,
    `the wave record carries target.integration.checks: ${JSON.stringify(wave.target?.integration)}`);
  return checks.map((check, index) => {
    assert.ok(check && typeof check.output_path === 'string' && check.output_path !== '',
      `candidate check ${index} names its output_path: ${JSON.stringify(check)}`);
    assert.equal(check.exit_code, 0, `candidate check ${check.gate ?? index} exit_code is 0: ${JSON.stringify(check)}`);
    const output = readReceiptOutput(check.output_path);
    assert.ok(output, `candidate check ${check.gate ?? index} output_path carries parsed JSON: ${check.output_path}`);
    return { check, output };
  });
}

function workspaceOf(member) {
  return member?.workspace ?? null;
}

function memberCheckoutPath(member) {
  const workspace = workspaceOf(member);
  return workspace?.checkout ?? workspace?.path ?? workspace?.merged ?? workspace?.merged_path ?? null;
}

function memberPrivateGitDir(member) {
  const workspace = workspaceOf(member);
  return workspace?.gitdir ?? workspace?.git_dir ?? workspace?.gitDir ?? null;
}

function fixtureOfRuns(runs) {
  const record = runs.find(run => typeof run.package === 'string');
  assert.ok(record, 'every run record names its package directory');
  return { packagePath: record.package };
}

function assertBarrierOwnerPids(provider, width, runs, waveRecord) {
  const requests = heldImplementingRequests(provider);
  const pids = [...new Set(requests.map(requestPid).filter(Number.isInteger))];
  assert.equal(pids.length, width, `held implementing requests carry ${width} distinct owner pids: ${JSON.stringify(pids)}`);
  assert.equal(runs.filter(run => run.wave_bindings?.phase === 'implementing').length, width,
    'exactly one implementing run record exists per member at the barrier');

  const units = new Set();
  for (const pid of pids) {
    assert.ok(pidAlive(pid), `owner pid ${pid} is alive at the barrier`);
    // Installed Pi rewrites process.title, so /proc/<pid>/cmdline cannot carry
    // the launch argv. Identify the live Pi process by its command line naming
    // Pi, and prove the launch mode from the durable owner-request JSON the
    // Runtime itself launches with (production launch input).
    const cmdline = pidCmdline(pid);
    assert.ok(/\bpi\b/.test(cmdline), `owner pid ${pid} is a live Pi process: ${cmdline.slice(0, 400)}`);
    const request = requests.find(entry => requestPid(entry) === pid);
    const recordId = request?.route?.record?.id;
    assert.ok(typeof recordId === 'string' && recordId !== '', `owner pid ${pid} route names its run record id`);
    const requestFile = join(runtimeRunsDir(fixtureOfRuns(runs)), `${recordId}-owner-request.json`);
    assert.ok(existsSync(requestFile), `owner pid ${pid} has its durable owner-request JSON at ${requestFile}`);
    const launched = parseJsonFile(requestFile);
    assert.ok(launched && Array.isArray(launched.args), `owner request ${requestFile} carries the launch args`);
    assert.ok(launched.args.includes('--mode') && launched.args[launched.args.indexOf('--mode') + 1] === 'json',
      `owner pid ${pid} launch argv uses --mode json: ${JSON.stringify(launched.args)}`);
    assert.ok(launched.args.includes('--print'),
      `owner pid ${pid} launch argv carries --print: ${JSON.stringify(launched.args)}`);
    const controlGroup = pidCgroup(pid);
    assert.ok(typeof controlGroup === 'string' && controlGroup.includes('spec-runtime.slice'),
      `owner pid ${pid} lives under spec-runtime.slice: ${controlGroup}`);
    const procs = cgroupPids(controlGroup);
    assert.ok(Array.isArray(procs) && procs.includes(pid),
      `owner pid ${pid} is listed in /sys/fs/cgroup${controlGroup}/cgroup.procs`);
    units.add(controlGroup);
  }
  assert.equal(units.size, width, 'every held owner lives in a distinct unit cgroup');
  assert.ok(waveRecord, 'the wave record exists at the barrier');
  return pids;
}

// The real user-manager limits of every held owner unit. TasksMax is the
// lifecycle policy's task cap and RuntimeMaxUSec stays inside the durable wave
// deadline, whose raw scalar or deadline.expires_at both parse.
function assertLifecycleLimits(policy, waveRecord, runs, pids) {
  const now = Date.now();
  for (const pid of pids) {
    const controlGroup = pidCgroup(pid);
    const unit = String(controlGroup).split('/').pop();
    const run = runs.find(entry => runCgroup(entry) === controlGroup);
    assert.ok(run, `an implementing run record names the cgroup of pid ${pid}: ${controlGroup}`);
    assert.equal(runUnit(run), unit, `run record unit equals the live unit for pid ${pid}`);
    const runtimeMaxSec = runRuntimeMaxSec(run);
    assert.ok(Number.isInteger(runtimeMaxSec) && runtimeMaxSec > 0,
      `run ${run.id} records service.runtime_max_sec: ${JSON.stringify(serviceOf(run))}`);

    const shown = unitProperties(unit, ['MemoryMax', 'MemoryHigh', 'MemorySwapMax', 'TasksMax', 'RuntimeMaxUSec']);
    assert.equal(parseByteProperty(shown.MemoryMax), policy.lifecycle.memoryBytes, `${unit} MemoryMax equals the lifecycle policy`);
    assert.equal(parseByteProperty(shown.MemoryHigh), policy.lifecycle.memoryHighBytes, `${unit} MemoryHigh equals the lifecycle policy`);
    assert.equal(parseByteProperty(shown.MemorySwapMax), policy.lifecycle.memorySwapMaxBytes, `${unit} MemorySwapMax equals the lifecycle policy`);
    assert.ok(Number.isInteger(policy.lifecycle.tasksMax) && policy.lifecycle.tasksMax > 0,
      `the saved host policy records lifecycle.tasksMax: ${JSON.stringify(policy.lifecycle)}`);
    assert.equal(parseInt(String(shown.TasksMax ?? '').trim(), 10), policy.lifecycle.tasksMax,
      `${unit} TasksMax equals the lifecycle policy task cap ${policy.lifecycle.tasksMax}: ${shown.TasksMax}`);
    assert.equal(parseUsecProperty(shown.RuntimeMaxUSec), runtimeMaxSec * 1_000_000,
      `${unit} RuntimeMaxUSec equals service.runtime_max_sec seconds`);

    // The durable deadline is either a bare scalar timestamp or an object that
    // reports deadline.expires_at.
    const toJson = value => (typeof value?.toJSON === 'function' ? value.toJSON() : value);
    const raw = toJson(waveRecord.deadline);
    const expires = typeof raw === 'string' || typeof raw === 'number' ? raw
      : (raw?.expires_at ?? raw?.expiresAt ?? null);
    const expiresMs = typeof expires === 'string' ? Date.parse(expires)
      : typeof expires === 'number' ? expires : Number.NaN;
    const deadline = typeof raw === 'object' && raw !== null ? raw : { expires_at: raw };
    assert.ok(Number.isFinite(expiresMs),
      `the wave record deadline carries a parseable expiry: ${JSON.stringify(deadline)}`);
    const remainingSec = Math.ceil((expiresMs - now) / 1000);
    assert.ok(runtimeMaxSec <= remainingSec + 1,
      `${unit} runtime_max_sec ${runtimeMaxSec} is bounded by the remaining deadline ${remainingSec} s`);
  }
}

async function bootAndHold(t, facts, { options, caseName, width, bootAndHold: beforeStart } = {}) {
  const boot = await bootLinuxWave(t, facts, options);
  // Optional pre-start hook: the installed-policy arithmetic runs before any
  // member is admitted to its barrier, so a later barrier wait cannot hide it.
  if (typeof beforeStart === 'function') await beforeStart({ boot });
  const script = { fixture: boot.fixture, members: width, ...options, mode: 'ordinary', case: caseName };
  const started = await boot.start({
    script,
    tag: caseName,
    arm: provider => provider.armBarrier('implementing', width),
  });
  await started.provider.barrierReached('implementing');
  const runs = readRunRecords(boot.fixture).filter(run => run.wave_bindings?.phase === 'implementing');
  const wave = await waitForWave(boot.fixture, record => record.state !== 'integrated'
    && Object.values(record.members ?? {}).some(member => member.phase !== 'queued'),
  { label: 'wave record with implementing members' });
  return { boot, provider: started.provider, coordinator: started.coordinator, runs, wave };
}

// The coordinator is a real live driver: it comes from boot.coordinators (or is
// the coordinator start() returned to the caller). A missing driver is a
// failure, never a silently empty mountinfo.
function assertMergedPathsEmpty(boot, wave, passedCoordinator = null) {
  const coordinator = passedCoordinator ?? (boot.coordinators ?? [])[(boot.coordinators ?? []).length - 1] ?? boot.coordinator ?? null;
  assert.ok(coordinator, 'a live coordinator driver exists to read mountinfo from');
  const coordinatorPid = coordinator.pid;
  assert.ok(Number.isInteger(coordinatorPid) && pidAlive(coordinatorPid),
    `the coordinator driver pid ${coordinatorPid} is alive`);
  const mountinfoPath = `/proc/${coordinatorPid}/mountinfo`;
  assert.ok(existsSync(mountinfoPath), `the coordinator mountinfo is readable at ${mountinfoPath}`);
  const mountinfoText = readFileSync(mountinfoPath, 'utf8');
  assert.ok(mountinfoText.trim() !== '', `the coordinator mountinfo is non-empty: ${mountinfoPath}`);
  const mountinfo = mountinfoText.split('\n');
  for (const member of Object.values(wave.members ?? {})) {
    const workspace = workspaceOf(member);
    assert.ok(workspace && typeof workspace === 'object', `step ${member.step} records a workspace: ${JSON.stringify(member)}`);
    const merged = workspace.merged ?? workspace.merged_path ?? workspace.mergedPath ?? null;
    assert.ok(typeof merged === 'string' && merged !== '', `step ${member.step} workspace names the merged path: ${JSON.stringify(workspace)}`);
    assert.deepEqual(readdirSync(merged), [], `step ${member.step} merged path is empty to the test: ${merged}`);
    const checkout = memberCheckoutPath(member);
    assert.ok(typeof checkout === 'string' && checkout !== '', `step ${member.step} workspace names its checkout`);
    assert.ok(!mountinfo.some(line => line.split(' ')[4] === checkout),
      `coordinator mountinfo has no line for step ${member.step} checkout ${checkout}`);
  }
}

function assertIntegratedTree(fixture) {
  const tree = git(fixture.integrationCheckout, 'ls-tree', '-r', '--name-only', 'HEAD')
    .trim().split('\n').filter(Boolean).sort();
  const expected = [...fixture.expected.keys()].sort();
  assert.deepEqual(tree, expected, 'integration tree equals the fixture expectation');
  for (const [path, content] of fixture.expected) {
    assert.equal(git(fixture.integrationCheckout, 'show', `HEAD:${path}`), content, `${path} content`);
  }
  assert.equal(git(fixture.integrationCheckout, 'status', '--porcelain'), '', 'integration checkout is clean');
}

function assertSealedHeads(fixture, wave) {
  const waveId = waveIdOf(wave);
  for (const member of Object.values(wave.members ?? {})) {
    assert.equal(typeof member.sealed_head, 'string', `step ${member.step} has a sealed head`);
    const ref = member.retention_ref ?? `refs/waves/retained/${waveId}/step-${pad3(member.step)}`;
    assert.equal(git(fixture.repo, 'rev-parse', ref).trim(), member.sealed_head,
      `step ${member.step} canonical retention ref ${ref} resolves to the sealed head`);
    const gitDir = memberPrivateGitDir(member);
    assert.ok(typeof gitDir === 'string' && existsSync(gitDir),
      `step ${member.step} records the private gitdir: ${JSON.stringify(workspaceOf(member))}`);
    const privateTree = gitDirTree(gitDir, member.sealed_head);
    // There is no production sealed_tree field; the exact comparison is between
    // the private gitdir's tree and the canonical retention tree.
    assert.equal(git(fixture.repo, 'rev-parse', `${ref}^{tree}`).trim(), privateTree,
      `step ${member.step} canonical tree equals the private sealed tree`);
  }
}

// Every implementing member's real gate receipt and every candidate check must
// report fstype overlay, and step 2 must still observe the untouched v1 lower
// dependency copy. The node_modules version is read under each actual member
// workspace lower directory, never the canonical repository.
function assertOverlayGates(fixture, wave) {
  const memberReceipts = readMemberGateReceipts(fixture, wave);
  const memberSteps = new Set();
  for (const [step, entry] of memberReceipts) {
    assert.equal(entry.output.fstype, 'overlay',
      `step ${step} gate observed fstype overlay: ${JSON.stringify(entry.output)}`);
    memberSteps.add(step);
  }
  const expectedSteps = Object.values(wave.members ?? {}).map(member => member.step).filter(Number.isInteger);
  assert.ok(expectedSteps.length >= 5, `at least five members carry gates: ${JSON.stringify(expectedSteps)}`);
  for (const step of expectedSteps) {
    assert.ok(memberSteps.has(step), `step ${step} gate overlay receipt is asserted, not just some five members`);
  }

  const candidateChecks = readCandidateChecks(wave);
  for (const { check, output } of candidateChecks) {
    assert.equal(output.fstype, 'overlay',
      `candidate check ${check.gate ?? 'unnamed'} observed fstype overlay: ${JSON.stringify(output)}`);
  }

  const step2 = memberReceipts.get(2);
  assert.ok(step2, 'step 2 gate receipt carries a parsed fixture-check output');
  assert.equal(step2.output.dep_version, 'v1', 'step 2 gate observed dep_version v1 after step 1 mutated its own copy');

  for (const member of Object.values(wave.members ?? {})) {
    const lower = workspaceOf(member)?.lower;
    assert.ok(typeof lower === 'string' && lower !== '',
      `step ${member.step} workspace records its lower directory: ${JSON.stringify(workspaceOf(member))}`);
    const lowerVersion = join(lower, 'node_modules', 'fixture-dep', 'version.txt');
    assert.ok(existsSync(lowerVersion), `step ${member.step} lower dependency copy exists at ${lowerVersion}`);
    assert.equal(readFileSync(lowerVersion, 'utf8').trim(), 'v1',
      `step ${member.step} lower dependency copy stays v1`);
  }
  return { memberSteps, candidateChecks, memberReceipts };
}

function assertWorkspaceBackends(wave) {
  for (const member of Object.values(wave.members ?? {})) {
    const workspace = workspaceOf(member);
    assert.equal(workspace?.backend, 'overlayfs', `step ${member.step} workspace backend is overlayfs: ${JSON.stringify(workspace)}`);
  }
  const integration = wave.target?.integration;
  assert.equal(integration?.workspace?.backend, 'overlayfs',
    'target.integration.workspace.backend is overlayfs');
}

function assertMemoryDiagnostics(services, runs, width) {
  const ownerUnits = new Set(runs.filter(run => run.wave_bindings?.phase === 'implementing').map(runUnit).filter(Boolean));
  const reviewerUnits = new Set(runs.filter(run => run.wave_bindings?.phase === 'reviewing').map(runUnit).filter(Boolean));
  assert.ok(ownerUnits.size >= width, `at least ${width} owner units carry run records: ${JSON.stringify([...ownerUnits])}`);
  assert.ok(reviewerUnits.size >= width, `at least ${width} reviewer units carry run records: ${JSON.stringify([...reviewerUnits])}`);
  const rows = services.sample('post-integrated');
  for (const unit of [...ownerUnits, ...reviewerUnits]) {
    const row = rows.find(entry => entry.unit === unit);
    assert.ok(row, `services.sample reports unit ${unit}`);
    const peak = row.memory_peak_bytes;
    const unavailable = row.unavailable;
    assert.ok((typeof peak === 'number' && peak > 0) || (typeof unavailable === 'string' && unavailable.length > 0),
      `unit ${unit} reports a non-null memory peak or an explicit unavailable reason: ${JSON.stringify({ peak, unavailable })}`);
  }
}

function assertTwoParentChain(fixture, count) {
  const chain = git(fixture.integrationCheckout, 'rev-list', '--first-parent', 'HEAD')
    .trim().split('\n').filter(Boolean);
  const index = chain.indexOf(fixture.baseCommit);
  assert.ok(index > 0, `the frozen base ${fixture.baseCommit} is on the first-parent chain`);
  const above = chain.slice(0, index);
  assert.equal(above.length, count, `${count} first-parent commits above the frozen base: ${above.length}`);
  for (const commit of above) {
    const parents = git(fixture.integrationCheckout, 'rev-list', '--parents', '-n', '1', commit).trim().split(/\s+/);
    assert.equal(parents.length, 3, `commit ${commit} has exactly two parents: ${parents.join(' ')}`);
  }
}

// Case 6: width five on overlay under the real lifecycle policy.
async function runWidthFive(t, facts) {
  const options = { members: 5, setup: 'deps', depWriter: 1 };
  const { boot, provider, coordinator, runs, wave } = await bootAndHold(t, facts, {
    options, caseName: 'width-five-linux', width: 5,
  });
  const policy = readPolicy(boot.sandbox);
  const pids = assertBarrierOwnerPids(provider, 5, runs, wave);

  assert.equal(wave.requested_width, 5, 'wave record requested_width is 5');
  assert.equal(wave.admitted_width, 5, 'wave record admitted_width is 5');
  assert.equal(wave.software_ceiling, 16, 'wave record software_ceiling is 16');
  assertMergedPathsEmpty(boot, wave, coordinator);
  assertLifecycleLimits(policy, wave, runs, pids);
  t.diagnostic(JSON.stringify({ ev: 'EV-14', case: 'width-five-linux', kernel_proof: true, held: pids }));

  provider.release('implementing');
  await waitForWave(boot.fixture, record => record.state === 'integrated', { label: 'integrated' });
  const record = currentWaveRecord(boot.fixture);
  t.diagnostic(JSON.stringify({ ev: 'EV-14', case: 'width-five-linux', released: pids, state: record.state }));

  assertWorkspaceBackends(record);
  assertOverlayGates(boot.fixture, record);
  assertSealedHeads(boot.fixture, record);
  assertIntegratedTree(boot.fixture);
  assertMemoryDiagnostics(boot.services, readRunRecords(boot.fixture), 5);
  assertNoCallsAfterStartup(coordinator, provider, 'width-five-linux');

  t.diagnostic(JSON.stringify({ ev: 'EV-14', case: 'width-five-linux', kernel_proof: true, wave_id: record.wave_id }));
}

// Case 7: width nine, admitted by the installed policy, same barriers.
async function runWidthNine(t, facts) {
  const options = { members: 9 };
  let width = null;
  // The installed policy arithmetic runs before the coordinator starts and
  // before any member is admitted to the barrier, computed from exact host
  // memory and the copied policy: no policy injection, no width reduction.
  const { boot, provider, coordinator, runs, wave } = await bootAndHold(t, facts, {
    options, caseName: 'width-nine-linux', width: 9,
    bootAndHold: ({ boot: started }) => {
      const policy = readPolicy(started.sandbox);
      const total = totalmem();
      const memorySlots = Math.floor((total - Math.max(0.3 * total, 4 * GIB)) / policy.lifecycle.memoryBytes);
      const taskSlots = Math.floor(policy.aggregate.tasksMax / policy.lifecycle.tasksMax);
      width = Math.min(9, memorySlots, taskSlots, 16);
      assert.ok(width >= 9,
        `installed policy admits nine: min(9, ${memorySlots} memory slots, ${taskSlots} task slots, 16) = ${width}`);
    },
  });

  assert.ok(Number.isInteger(width), 'the installed policy arithmetic ran before the barrier wait');
  const pids = assertBarrierOwnerPids(provider, 9, runs, wave);
  assert.equal(wave.requested_width, 9, 'wave record requested_width is 9');
  assert.equal(wave.admitted_width, 9, 'wave record admitted_width is 9');
  t.diagnostic(JSON.stringify({ ev: 'EV-14', case: 'width-nine-linux', kernel_proof: true, held: pids, width }));

  provider.release('implementing');
  await waitForWave(boot.fixture, record => record.state === 'integrated', { label: 'integrated' });
  const record = currentWaveRecord(boot.fixture);
  t.diagnostic(JSON.stringify({ ev: 'EV-14', case: 'width-nine-linux', released: pids, state: record.state }));

  assertWorkspaceBackends(record);
  // Case 7 runs with setup none: it has no dependency-copy contract, so the
  // overlay/evidence gates stay asserted by case 6 only.
  assertTwoParentChain(boot.fixture, 9);
  assertMemoryDiagnostics(boot.services, readRunRecords(boot.fixture), 9);
  assertNoCallsAfterStartup(coordinator, provider, 'width-nine-linux');

  t.diagnostic(JSON.stringify({ ev: 'EV-14', case: 'width-nine-linux', kernel_proof: true, wave_id: record.wave_id }));
}

// Case 8 support: actual delivered spec-wave messages, read from the native
// SDK event stream of each live driver. Replayed model request histories are
// never counted: only a message_start event is a real delivery.
function parseAttentionPayload(content) {
  const texts = typeof content === 'string' ? [content]
    : Array.isArray(content)
      ? content.map(block => (typeof block === 'string' ? block : block?.text)).filter(text => typeof text === 'string')
      : [];
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.kind === 'string') return parsed;
    } catch {
      // not the JSON payload envelope
    }
  }
  return null;
}

function deliveredAttention(coordinators) {
  const delivered = [];
  for (const coordinator of coordinators) {
    for (const event of coordinator.events ?? []) {
      if (event?.type !== 'message_start') continue;
      const message = event.message ?? {};
      if ((message.customType ?? message.custom_type) !== 'spec-wave') continue;
      const payload = parseAttentionPayload(message.content);
      assert.ok(payload, `delivered spec-wave attention carries a JSON kind: ${JSON.stringify(message.content)}`);
      delivered.push(payload);
    }
  }
  return delivered;
}

// A repeated delivery is a failure, not a Set dedup that quietly hides it.
function assertUniqueDeliveredAttention(coordinators) {
  const delivered = deliveredAttention(coordinators);
  assert.ok(delivered.length > 0, 'at least one spec-wave attention was actually delivered to a driver');
  const identities = delivered.map(payload => JSON.stringify({
    kind: payload.kind,
    wave_id: payload.wave_id ?? null,
    generation: payload.generation ?? null,
    revision: payload.revision ?? null,
    step: payload.step ?? null,
  }));
  for (let index = 0; index < identities.length; index += 1) {
    assert.ok(!identities.slice(0, index).includes(identities[index]),
      `delivered attention identity is unique: ${identities[index]}`);
  }
  const kinds = new Set(delivered.map(payload => payload.kind));
  for (const kind of ['barrier-reached', 'promotion-result']) {
    assert.ok(kinds.has(kind), `delivered attention includes ${kind}: ${JSON.stringify([...kinds])}`);
  }
  return delivered;
}

function toolResultEnds(coordinator, toolName) {
  return (coordinator.events ?? []).filter(event => event?.type === 'tool_execution_end'
    && (event.toolName ?? event.name) === toolName);
}

function toolResultText(event) {
  try {
    return JSON.stringify({ result: event?.result ?? null, error: event?.error ?? null, content: event?.content ?? null });
  } catch {
    return '';
  }
}

function toolResultObject(event) {
  return event?.result?.details ?? event?.result ?? {};
}

function responseToolCalls(request) {
  return request?.response?.tool_calls ?? request?.response?.choices?.[0]?.message?.tool_calls ?? [];
}

// A coordinator may issue a tool call only for its first startup dispatch;
// every later model turn is a passive attention/report turn. The window opens
// at the request that replays the successful startup tool result, correlated by
// the outer event's tool call id, so a failed or retried startup cannot open it.
function assertNoCallsAfterStartup(coordinator, provider, label) {
  const resultIds = new Set();
  for (const event of toolResultEnds(coordinator, 'spec_dispatch')) {
    const result = toolResultObject(event);
    if (!result || typeof result !== 'object') continue;
    if (result.state !== 'started' && result.state !== 'admitted' && result.state !== 'opened') continue;
    if (result.error || result.code) continue;
    const id = event?.toolCallId ?? event?.tool_call_id;
    if (typeof id === 'string') resultIds.add(id);
  }
  const requests = (provider.requests ?? []).filter(request => request?.route?.role === 'coordinator'
    && request?.route?.pid === coordinator.pid);
  const windowStart = requests.findIndex(request => (request.body?.messages ?? []).some(message => {
    if (message?.role !== 'tool' && message?.role !== 'tool_result') return false;
    const id = message.tool_call_id ?? message.toolCallId ?? message.call_id;
    return typeof id === 'string' && resultIds.has(id);
  }));
  assert.ok(windowStart >= 0, `${label} coordinator request history carries its startup result`);
  for (const request of requests.slice(windowStart)) {
    assert.equal(responseToolCalls(request).length, 0, `${label} issues no coordinator tool call after startup`);
  }
}

function trackedWorktreeMatches(cwd, rev) {
  try {
    execFileSync('git', ['-C', cwd, 'diff', '--quiet', rev], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

// Case 8: coordinator restart and interrupted promotion recover without
// duplicates. A starts the wave, B is refused while A lives, A is SIGKILLed at
// the review barrier, C is SIGKILLed by the promotion hook after the canonical
// branch update, and D replays the journaled promotion to integrated.
async function runPromotionRestart(t, facts) {
  const boot = await bootLinuxWave(t, facts, { members: 2, promotionKill: true });
  const { fixture } = boot;
  const scratchPath = join(fixture.integrationCheckout, 'scratch.log');
  writeFileSync(scratchPath, 'ignored scratch\n');
  const scratchBefore = readFileSync(scratchPath, 'utf8');
  const assertScratchUnchanged = label => assert.equal(readFileSync(scratchPath, 'utf8'), scratchBefore,
    `integration checkout scratch.log is unchanged ${label}`);

  const started = await boot.start({
    script: { fixture, members: 2, mode: 'ordinary', case: 'promotion-restart' },
    tag: 'promotion-restart-a',
    arm: provider => provider.armBarrier('implementing', 2),
  });
  const provider = started.provider;
  const a = started.coordinator;
  await provider.barrierReached('implementing');
  const implementing = provider.requests.filter(request => request?.route?.record?.phase === 'implementing');
  const ownerPids = [...new Set(implementing.map(requestPid).filter(Number.isInteger))];
  assert.equal(ownerPids.length, 2, 'two distinct implementing owner pids reached the barrier');
  const runsBefore = readRunRecords(fixture).map(run => run.id).sort();

  // B: repeated entry beside the live coordinator is refused as package-owned
  // and launches nothing.
  provider.script.mode = 'repeated-entry';
  const b = startCoordinator({
    sandbox: fixture,
    env: boot.env,
    script: { port: provider.port, case: 'promotion-restart' },
    tag: 'promotion-restart-b',
  });
  boot.coordinators.push(b);
  await b.ready;
  const [bRefusal] = await waitFor(() => {
    const ends = toolResultEnds(b, 'spec_dispatch');
    return ends.length > 0 ? ends : null;
  }, { timeoutMs: 60000, label: 'B spec_dispatch tool result' });
  const refusalText = toolResultText(bRefusal);
  assert.ok(bRefusal.isError === true || bRefusal.error != null,
    `B repeated-entry startup returns an error tool result: ${refusalText.slice(0, 400)}`);
  assert.ok(refusalText.includes('package-owned'),
    `B repeated-entry startup is refused as package-owned: ${refusalText.slice(0, 800)}`);
  assert.deepEqual(readRunRecords(fixture).map(run => run.id).sort(), runsBefore, 'B launches no new run record');
  assert.deepEqual(ownerPids.filter(pid => !pidAlive(pid)), [], 'B leaves every held owner pid running');
  await b.shutdown();

  // Review barrier: hold both review-1 reviewers, then SIGKILL A and drain its
  // driver group. The promotion hook marker is armed so C dies after its
  // canonical branch update.
  provider.armBarrier('reviewing', 2);
  provider.release('implementing');
  await provider.barrierReached('reviewing');
  const reviewRequests = provider.requests.filter(request => request?.route?.record?.phase === 'reviewing' && request?.turn === 0);
  const oldReviewerPids = [...new Set(reviewRequests.map(requestPid).filter(Number.isInteger))];
  assert.equal(oldReviewerPids.length, 2, 'two distinct review-1 reviewer pids are held at the barrier');
  const oldReviewerRuns = readRunRecords(fixture).filter(run => run.wave_bindings?.phase === 'reviewing');
  assert.equal(oldReviewerRuns.length, 2, 'two reviewing run records exist at the review barrier');
  await a.kill();
  writeFileSync(join(fixture.dir, 'kill-on-promote'), '');
  provider.release('reviewing');
  provider.script.mode = 'restart';

  // C: recover from the SIGKILLed driver. Replacement reviewers may only start
  // after the orphaned owned units are positively stopped and drained.
  const cStartedAt = Date.now();
  const c = startCoordinator({
    sandbox: fixture,
    env: boot.env,
    script: { port: provider.port, case: 'promotion-restart' },
    tag: 'promotion-restart-c',
  });
  boot.coordinators.push(c);
  await c.ready;
  const replacementReviews = await waitFor(() => {
    const found = provider.requests.filter(request => (request.at ?? 0) >= cStartedAt
      && request?.route?.role === 'reviewer' && request?.turn === 0 && request?.route?.record?.phase === 'reviewing');
    return found.length >= 2 ? found : null;
  }, { timeoutMs: 120000, label: 'replacement reviewer requests' });
  for (const request of replacementReviews) {
    assert.deepEqual((request.liveReviewingPids ?? []).filter(pid => oldReviewerPids.includes(pid)), [],
      `replacement reviewer request at ${request.at} snapshots no old reviewer pid`);
  }
  for (const run of oldReviewerRuns) {
    const inspected = await boot.services.adapter.inspect(run.service, { ownershipVerified: true });
    assert.equal(inspected.status, 'confirmed', `old reviewer unit ${runUnit(run)} is positively stopped and drained`);
  }

  const died = await Promise.race([c.exited.then(() => true), delay(180000).then(() => false)]);
  assert.ok(died, 'the promotion hook SIGKILLed coordinator C after the canonical branch update');

  const interrupted = await waitForWave(fixture, record => record.state === 'promoting'
    && record.target?.promotion?.state === 'ref-updated',
  { label: 'promoting record with a ref-updated promotion journal' });
  const promotion = interrupted.target.promotion;
  assert.ok(/^[0-9a-f]{40}$/.test(String(promotion.candidate ?? '')),
    `promotion journal names its candidate: ${JSON.stringify(promotion)}`);
  assert.equal(git(fixture.integrationCheckout, 'rev-parse', promotion.branch).trim(), promotion.candidate,
    `the canonical branch ref equals the journaled candidate ${promotion.candidate}`);
  const expectedOldTree = git(fixture.integrationCheckout, 'rev-parse', `${promotion.expected_old}^{tree}`).trim();
  assert.equal(git(fixture.integrationCheckout, 'write-tree').trim(), expectedOldTree,
    'the index still holds the expected_old tree after the interrupted promotion');
  assert.ok(trackedWorktreeMatches(fixture.integrationCheckout, promotion.expected_old),
    'the tracked worktree still matches the expected_old tree after the interrupted promotion');
  assertScratchUnchanged('after the interrupted promotion');
  t.diagnostic(JSON.stringify({ ev: 'EV-14', case: 'promotion-restart', interrupted: promotion.state, candidate: promotion.candidate }));

  // D: replay the journaled promotion to integrated.
  const d = startCoordinator({
    sandbox: fixture,
    env: boot.env,
    script: { port: provider.port, case: 'promotion-restart' },
    tag: 'promotion-restart-d',
  });
  boot.coordinators.push(d);
  await d.ready;
  const integrated = await waitForWave(fixture, record => record.state === 'integrated', { label: 'recovered integrated' });
  assert.equal(integrated.target?.promotion?.state, 'synced', 'the recovered promotion journal reaches synced');
  const hookLines = readFileSync(join(fixture.dir, 'hook.log'), 'utf8').split('\n').filter(Boolean);
  assert.equal(hookLines.length, 1, `the promotion hook records exactly one committed branch update: ${JSON.stringify(hookLines)}`);
  const [hookOld, hookNew, hookRef] = hookLines[0].split(' ');
  assert.equal(hookRef, promotion.branch, 'the hook line names the promoted branch');
  assert.equal(hookNew, promotion.candidate, 'the hook line records the candidate update');
  assert.equal(hookOld, promotion.expected_old, 'the hook line records the expected old value');
  const candidateTree = git(fixture.integrationCheckout, 'rev-parse', `${promotion.candidate}^{tree}`).trim();
  assert.equal(git(fixture.integrationCheckout, 'write-tree').trim(), candidateTree,
    'the index holds the candidate tree after recovery');
  assert.ok(trackedWorktreeMatches(fixture.integrationCheckout, promotion.candidate),
    'the tracked worktree equals the candidate tree after recovery');
  assertScratchUnchanged('after recovery');
  // B never receives a successful startup (it is refused as package-owned), so
  // only the three launched coordinators carry a post-startup window.
  for (const [label, coordinator] of [['a', a], ['c', c], ['d', d]]) assertNoCallsAfterStartup(coordinator, provider, `promotion-restart ${label}`);

  const delivered = assertUniqueDeliveredAttention([a, b, c, d]);
  t.diagnostic(JSON.stringify({ ev: 'EV-14', case: 'promotion-restart', kernel_proof: true, wave_id: integrated.wave_id,
    delivered: delivered.map(payload => ({ kind: payload.kind, wave_id: payload.wave_id, step: payload.step })) }));
}

// Register both native Linux wave cases through the caller's wrapper, which
// owns the EV-14 opt-in, skip reason and hard preconditions.
export function registerLinuxWaveCases(linuxTest) {
  linuxTest('wave linux: width five native wave runs on overlay under cgroup limits', 240000, runWidthFive);
  linuxTest('wave linux: width nine native wave admitted by the installed policy', 300000, runWidthNine);
  linuxTest('wave linux: coordinator restart and interrupted promotion recover without duplicates', 300000, runPromotionRestart);
}
