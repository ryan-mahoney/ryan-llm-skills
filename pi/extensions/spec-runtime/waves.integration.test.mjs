// EV-13 native proof, walking skeleton (D-29 packet 1).
//
// Static imports stay inside the card rule: node:* modules, the shared fixture
// module, and the host remedies table. Production modules (waves.mjs,
// runtime.mjs, index.ts) are exercised through a detached coordinator child and
// never imported by this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIAG_TEXT_LIMIT,
  boundedText,
  collectRuntimeRunDiagnostics,
  collectShimStateDiagnostics,
  installPortableHostShims,
  makeWaveFixture,
  registerNativeTeardown,
  resolveInstalledPi,
  setShimMode,
  startCoordinator,
  startLoopbackProvider,
  writeLoopbackExtension,
  writeSandboxHome,
  memberCheckouts,
  memberWorkspace,
  elapsedWaveMs,
  elapsedWaveSetMs,
} from './package-fixture.mjs';
import { HOST_REMEDIES } from './linux-resources.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = join(here, '..', '..', '..');
const profilesDir = join(here, '..', '..', 'agents');
const cliPath = join(checkout, 'scripts', 'spec-observe', 'cli.mjs');

// Card case 1 requires the test file's imports to stay inside this set.
const ALLOWED_IMPORTS = [
  'node:test', 'node:assert/strict', 'node:child_process', 'node:module',
  'node:fs', 'node:path', 'node:url', './package-fixture.mjs', './linux-resources.mjs',
];

// Role profiles and tool sets as built (runtime.mjs ROLE_CONTRACT).
const ROLE_PROFILE = {
  owner: 'spec-step-owner.md',
  editor: 'spec-step-editor.md',
  reviewer: 'spec-stage-reviewer.md',
  fixer: 'spec-step-fixer.md',
};
const ROLE_TOOLS = {
  owner: ['read', 'grep', 'find', 'ls', 'spec_editor', 'spec_answer', 'spec_verify', 'spec_scout', 'spec_search', 'spec_advice', 'spec_complete'],
  editor: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'spec_question'],
  reviewer: ['read', 'grep', 'find', 'ls', 'bash', 'spec_stage_complete'],
  fixer: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'spec_stage_complete'],
};
const WAVE_ATTENTION_KINDS = ['barrier-reached', 'promotion-result'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function snapshotEnv(env = process.env) {
  const saved = new Map(Object.entries(env));
  return () => {
    for (const key of Object.keys(env)) if (!saved.has(key)) delete env[key];
    for (const [key, value] of saved) env[key] = value;
  };
}

async function waitForWaveState(readState, predicate, { timeoutMs = 120000, label = 'wave state' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = readState();
    if (last && predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last ?? null)}`);
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function pidAlive(pid) {
  return Number.isInteger(pid) && existsSync(`/proc/${pid}`);
}

// The wave record lives at <package>/runtime/waves/<wave_id>.json (waves.mjs).
function waveRecordDir(fixture) {
  return join(fixture.packagePath, 'runtime', 'waves');
}

function readWaveRecords(fixture) {
  const dir = waveRecordDir(fixture);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json'))
    .map(name => ({ path: join(dir, name), record: JSON.parse(readFileSync(join(dir, name), 'utf8')) }));
}

function readWaveRecord(fixture) {
  const records = readWaveRecords(fixture);
  assert.equal(records.length, 1, 'exactly one runtime/waves record exists');
  return records[0].record;
}

function profileFirstLine(role) {
  const lines = readFileSync(join(profilesDir, ROLE_PROFILE[role]), 'utf8').split('\n');
  let index = 0;
  if ((lines[0] ?? '').trim() === '---') {
    index = 1;
    while (index < lines.length && lines[index].trim() !== '---') index += 1;
    index += 1;
  }
  while (index < lines.length && lines[index].trim() === '') index += 1;
  assert.ok(lines[index], `${role} profile has a first body line`);
  return lines[index];
}

function requestRoute(request) {
  return request.route ?? { role: request.role, record: request.record ?? {}, pid: request.pid };
}

function requestBody(request) {
  return request.body ?? {};
}

function requestToolNames(request) {
  const tools = requestBody(request).tools ?? request.tools ?? [];
  return tools.map(tool => tool.function?.name ?? tool.name);
}

function responseToolCalls(request) {
  const response = request.response ?? {};
  return response.tool_calls ?? response.choices?.[0]?.message?.tool_calls ?? [];
}

// Pi converts a custom wave message into user content, so the attention payload
// arrives either as raw JSON text in `content` or as text blocks. Only a parsed
// object that carries the wave-kind vocabulary counts; the caller accepts solely
// `kind` plus `wave_id` from it.
function parseAttentionText(text) {
  if (typeof text !== 'string' || !text.includes('"kind"')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed.kind === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function messageTexts(message) {
  const content = message?.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.map(block => (typeof block === 'string' ? block : (block?.text ?? block?.content ?? null)))
    .filter(text => typeof text === 'string');
}

function attentionIn(request) {
  const found = [];
  for (const message of requestBody(request).messages ?? []) {
    const customType = message?.customType ?? message?.custom_type;
    if (customType === 'spec-wave') {
      const payload = parseAttentionText(message.content);
      if (payload) found.push(payload);
      continue;
    }
    for (const text of messageTexts(message)) {
      const payload = parseAttentionText(text);
      if (payload) found.push(payload);
    }
  }
  return found;
}

// The candidate checks are recorded on record.target.integration.checks; the
// fixture gate is selected by name so a differently ordered check list cannot
// silently substitute another command.
function gateReceipt(record) {
  const checks = record.target?.integration?.checks ?? [];
  return checks.find(check => check.gate === 'fixture-check')
    ?? checks.find(check => String(check.command ?? '').includes('fixture-check'))
    ?? null;
}

function findStageSessions(root) {
  const found = [];
  const walk = dir => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/-reviewer\.jsonl$|-fixer\.jsonl$/.test(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

function assertStaticImports() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const match of source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)) {
    assert.ok(ALLOWED_IMPORTS.includes(match[1]), `static import ${match[1]} is allowed`);
  }
  assert.ok(!/from\s+'([^']*)(waves|runtime)\.mjs'/.test(source), 'no production module import');
  assert.ok(!/from\s+'[^']*index\.ts'/.test(source), 'no index.ts import');
}

function makeDriverEnv({ sandbox, fixture, binDir, pi }) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^SPEC_RUNTIME_|^PI_INTERCOM_|^PI_WARDEN_/.test(key)) delete env[key];
  }
  env.PI_WARDEN_ENABLED = '1';
  env.HOME = sandbox.home;
  env.PI_CODING_AGENT_DIR = sandbox.agentDir;
  env.XDG_CONFIG_HOME = sandbox.configHome;
  env.XDG_DATA_HOME = sandbox.dataHome;
  env.ADJACENT_STORAGE_ROOT = fixture.root;
  env.PATH = [
    binDir,
    dirname(process.execPath),
    dirname(pi.bin),
    '/usr/local/bin', '/usr/bin', '/bin',
  ].join(':');
  return env;
}

function nodeAtLeast(major, minor) {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj > major || (maj === major && min >= minor);
}

const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled', 'stale']);

// Run records live at <package>/runtime/runs/<id>.json (runtime.mjs runFileOf).
function readRunRecords(fixture) {
  const dir = join(fixture.packagePath, 'runtime', 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json'))
    .map(name => { try { return JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { return null; } })
    .filter(record => record && typeof record === 'object');
}

async function waitForRunState(fixture, predicate, { timeoutMs = 120000, label = 'run state' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let records = [];
  while (Date.now() < deadline) {
    records = readRunRecords(fixture);
    if (predicate(records)) return records;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}; runs=${JSON.stringify(records.map(record => record.state))}`);
}

function coordinatorToolEvents(coordinator, toolName) {
  const events = coordinator?.events ?? [];
  return events.filter(event => event?.type === 'tool_execution_end' && event?.toolName === toolName);
}

// The driver exposes the real Pi events; the structured tool reply is either the
// event result itself or its `details` payload.
function toolResultObject(event) {
  return event?.result?.details ?? event?.result ?? {};
}

async function waitForCoordinatorToolEvents(coordinator, toolName, count = 1, { timeoutMs = 60000, label = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let events = [];
  while (events.length < count && Date.now() < deadline) {
    events = coordinatorToolEvents(coordinator, toolName);
    if (events.length < count) await sleep(100);
  }
  if (events.length < count) {
    throw new Error(`timed out waiting for ${count} ${label ?? toolName} tool result(s); saw ${events.length}`);
  }
  return events;
}

// Shared D-9/D-28 fixture boot: every native case reuses the real host shims and
// the production runtime-host setup. Cleanup is registered as soon as each
// resource exists so a later failure cannot leak the fixture.
async function bootWaveFixture(t, options = {}) {
  // D-11: installed Pi and the installed SDK are hard prerequisites.
  const pi = resolveInstalledPi();
  assert.ok(pi.ok, pi.reason);
  assert.ok(nodeAtLeast(22, 19), `Node ${process.versions.node} must be >= 22.19`);
  assertStaticImports();

  const restoreEnv = snapshotEnv(process.env);
  t.after(() => restoreEnv());

  // D-9 fixture build: this is the first red boundary of the walking skeleton.
  const fixture = await makeWaveFixture(options);
  // Cleanup is registered before any further operation so a later failure in
  // the sandbox/shim/setup phases cannot leak the fixture. Ordering lives in
  // wave-native-lifecycle.mjs; remaining boot fields are filled in later.
  const boot = { fixture, coordinators: [], providers: [], diagnostics: [] };
  registerNativeTeardown(t, boot);

  const extensionPath = join(fixture.dir, 'wave-loopback-extension.mjs');
  const sandbox = writeSandboxHome(fixture.dir, { extensionPath });
  assert.ok(sandbox.home && sandbox.agentDir && sandbox.configHome && sandbox.dataHome,
    'writeSandboxHome returns home, agentDir, configHome and dataHome');

  const binDir = join(fixture.dir, 'shim-bin');
  const shimStateDir = join(fixture.dir, 'shim-state');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(shimStateDir, { recursive: true });
  await installPortableHostShims(binDir, shimStateDir, { configHome: sandbox.configHome });
  const env = makeDriverEnv({ sandbox, fixture, binDir, pi });
  // The detached driver resolves the installed SDK from this explicit root; it
  // never falls back to the primary checkout's node_modules.
  env.SPEC_PI_SDK = pi.sdkRoot;

  // D-28: production runtime-host setup through the PATH shims, with the driver
  // environment and sandbox config. Prerequisite: exit 0 and admittedWidth >= 9.
  const setupRun = spawnSync(process.execPath,
    [cliPath, 'runtime-host', 'setup', '--lifecycle-memory-mib', '1024', '--lifecycle-tasks', '256'],
    { env, encoding: 'utf8' });
  assert.equal(setupRun.status, 0, `runtime-host setup failed: ${setupRun.stderr}`);
  const setup = JSON.parse(setupRun.stdout);
  assert.ok(setup.check?.admission?.admittedWidth >= 9, `host policy admits at least nine: ${JSON.stringify(setup)}`);

  Object.assign(boot, { pi, extensionPath, sandbox, binDir, shimStateDir, env, setup });
  return boot;
}

// Start the loopback provider, write the generated child extension and start
// the detached coordinator driver. The provider and driver are torn down before
// the fixture itself.
async function startNativeRun(t, boot, { script, tag, arm } = {}) {
  const { fixture, env } = boot;
  const provider = await startLoopbackProvider({ script });
  boot.providers.push(provider);
  await writeLoopbackExtension(fixture.dir, provider.port);
  if (typeof arm === 'function') arm(provider);
  const coordinator = startCoordinator({
    sandbox: fixture,
    env,
    script: { port: provider.port, mode: script.mode, case: script.case },
    tag,
  });
  boot.coordinators.push(coordinator);
  await coordinator.ready;
  // Bounded diagnostic for the first unproven coordinator tool-result
  // boundary: surface coordinator stderr, a concise provider request summary,
  // and the fixture run-record/shim-state evidence on teardown. Registered on
  // the shared boot callback so it runs before boot cleanup deletes the fixture.
  // Never dump images or full system prompts; last tool messages only.
  boot.diagnostics.push(() => {
    try {
      console.error(`[wave-diag ${tag}] coordinator.stderr=${JSON.stringify(boundedText(coordinator.stderr ?? null, DIAG_TEXT_LIMIT))}`);
      const requests = (provider.requests ?? []).map(request => {
        const messages = request?.body?.messages ?? [];
        const lastUser = [...messages].reverse().find(message => message?.role === 'user');
        const lastTool = [...messages].reverse().find(message => message?.role === 'tool' || message?.role === 'tool_result');
        return {
          role: request?.route?.role ?? null,
          turn: request?.turn ?? null,
          lastUser: lastUser ? { role: lastUser.role, content: lastUser.content } : null,
          lastTool: lastTool ? { role: lastTool.role, content: lastTool.content, tool_call_id: lastTool.tool_call_id ?? null } : null,
          response: request?.response ?? null,
        };
      });
      const violations = (provider.violations ?? []).map(request => ({
        role: request?.route?.role ?? null,
        turn: request?.turn ?? null,
        lastUser: [...(request?.body?.messages ?? [])].reverse().find(message => message?.role === 'user')?.content ?? null,
      }));
      console.error(`[wave-diag ${tag}] provider=${JSON.stringify({ requests, violations })}`);
      const runEvidence = collectRuntimeRunDiagnostics(fixture);
      console.error(`[wave-diag ${tag}] runtimeRuns=${JSON.stringify({ dir: runEvidence.dir, runs: runEvidence.runs, files: runEvidence.files })}`);
      const shimEvidence = collectShimStateDiagnostics(boot.shimStateDir);
      console.error(`[wave-diag ${tag}] shimState=${JSON.stringify(shimEvidence)}`);
    } catch (error) {
      console.error(`[wave-diag ${tag}] diagnostic failed: ${error?.message ?? String(error)}`);
    }
  });
  return { provider, coordinator };
}

test('wave native: width five implements, reviews, repairs and promotes through index.ts', { timeout: 240000 }, async t => {
  const boot = await bootWaveFixture(t, { members: 5, defectStep: 2 });
  const { fixture } = boot;
  const { provider, coordinator: coordinatorFromRun } = await startNativeRun(t, boot, {
    script: { fixture, members: 5, defectStep: 2, mode: 'ordinary', case: 'width-five' },
    tag: 'ordinary',
    // D-8: hold every implementing owner's first request before the coordinator
    // starts, so liveness is proved by event rather than sleep.
    arm: loopback => loopback.armBarrier('implementing', 5),
  });

  await provider.barrierReached('implementing');
  const held = provider.requests.filter(request => requestRoute(request).record?.phase === 'implementing');
  assert.equal(new Set(held.map(request => requestRoute(request).pid)).size, 5,
    'exactly 5 distinct implementing runs are held');
  const heldPids = [];
  for (const request of held) {
    const { pid, recordPath } = requestRoute(request);
    assert.ok(pidAlive(pid), `implementing url pid ${pid} is alive`);
    heldPids.push(pid);
    // Installed Pi overwrites process.title, so /proc/<pid>/cmdline cannot keep
    // the launch argv. Prove the live process is the Pi worker via the PID, and
    // prove the launch mode from the adapter-written request file the Runtime
    // itself launches with (production launch input, not a test-side spawn).
    const procCmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    assert.ok(procCmdline.includes('pi'), `pid ${pid} cmdline names Pi: ${procCmdline.trim()}`);
    assert.equal(typeof recordPath, 'string', `implementing url pid ${pid} carries a route recordPath`);
    const requestFile = join(dirname(recordPath), `${requestRoute(request).record?.id}-owner-request.json`);
    assert.ok(existsSync(requestFile), `owner request file ${requestFile} exists for pid ${pid}`);
    const launched = JSON.parse(readFileSync(requestFile, 'utf8'));
    const launchArgs = Array.isArray(launched.args) ? launched.args : [];
    const modeIndex = launchArgs.indexOf('--mode');
    assert.ok(modeIndex >= 0, `pid ${pid} launch argv carries --mode`);
    assert.equal(launchArgs[modeIndex + 1], 'json', `pid ${pid} launch argv uses --mode json`);
    assert.ok(launchArgs.includes('--print'), `pid ${pid} launch argv carries --print`);
    assert.equal(launched.env?.SPEC_RUNTIME_RECORD, recordPath,
      `pid ${pid} worker env SPEC_RUNTIME_RECORD equals the decoded route recordPath`);
  }
  t.diagnostic(`implementing barrier held url pids=${JSON.stringify(heldPids)}`);

  const beforeRelease = readWaveRecord(fixture);
  assert.equal(beforeRelease.requested_width, 5, 'wave record requested_width is 5');
  assert.equal(beforeRelease.admitted_width, 5, 'wave record admitted_width is 5');
  assert.equal(beforeRelease.software_ceiling, 16, 'wave record software_ceiling is 16');

  provider.release('implementing');
  t.diagnostic(`implementing barrier released url pids=${JSON.stringify(heldPids)} live=${JSON.stringify(heldPids.filter(pidAlive))}`);
  await waitForWaveState(() => readWaveRecord(fixture), record => record.state === 'integrated', { label: 'integrated' });
  const integratedAt = Date.now();
  const record = readWaveRecord(fixture);

  // Integration tree and file contents.
  const tree = git(fixture.integrationCheckout, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n').filter(Boolean);
  assert.deepEqual(tree, [
    '.gitignore', 'README', 'checks/fixture-check.mjs',
    'src/step-01.txt', 'src/step-02.txt', 'src/step-03.txt', 'src/step-04.txt', 'src/step-05.txt',
  ]);
  for (let step = 1; step <= 5; step += 1) {
    const nn = String(step).padStart(2, '0');
    const content = git(fixture.integrationCheckout, 'show', `HEAD:src/step-${nn}.txt`);
    assert.equal(content, step === 2 ? 'step 02 fixed\n' : `step ${nn} implemented\n`,
      `src/step-${nn}.txt content`);
  }

  // First-parent chain: five two-parent commits whose second parents are the
  // recorded sealed heads in ascending step order.
  const chain = git(fixture.integrationCheckout, 'rev-list', '--first-parent', 'HEAD').trim().split('\n').filter(Boolean);
  const baseIndex = chain.indexOf(fixture.baseCommit);
  assert.ok(baseIndex >= 0, 'frozen base is on the first-parent chain');
  const promoted = chain.slice(0, baseIndex);
  assert.equal(promoted.length, 5, 'five promote commits above the frozen base');
  const sealedHeads = [];
  for (let step = 1; step <= 5; step += 1) {
    const sealPath = join(fixture.packagePath, 'runtime', 'waves', record.wave_id, `step-${String(step).padStart(3, '0')}-seal.json`);
    sealedHeads.push(JSON.parse(readFileSync(sealPath, 'utf8')).sealed_head);
  }
  [...promoted].reverse().forEach((commit, index) => {
    const parents = git(fixture.integrationCheckout, 'rev-list', '--parents', '-n', '1', commit).trim().split(/\s+/).slice(1);
    assert.equal(parents.length, 2, `promote commit ${commit} has two parents`);
    assert.equal(parents[1], sealedHeads[index], `promote commit step ${index + 1} second parent is the sealed head`);
  });
  const step2SealedParents = git(fixture.integrationCheckout, 'rev-list', '--parents', '-n', '1', sealedHeads[1]).trim().split(/\s+/).slice(1);
  assert.equal(step2SealedParents.length, 1, 'step 2 sealed head has a single implementation parent');
  assert.equal(git(fixture.integrationCheckout, 'show', `${step2SealedParents[0]}:src/step-02.txt`), 'step 02 implemented-defect\n',
    'step 2 sealed head parent is the implementation commit');

  assert.equal(git(fixture.integrationCheckout, 'status', '--porcelain'), '', 'integration checkout is clean');

  // D-3: worktree fallback everywhere, never a userns launch. Shapes are read
  // step-013-subspec.md:38 contract reconciliation: the card names the fallback
  // reason `fallback_reason` with value `userns-denied`, while the as-built
  // durable record carries it as `workspace.backendReason`. The value is
  // identical, so the assertions below keep `userns-denied` verbatim and read
  // the field name the record actually writes; no bwrap or production change is
  // implied by this reconciliation.
  // from the as-built durable record: each member carries its provisioned
  // workspace (step-workspaces.mjs) and the candidate workspace lives at
  // record.target.integration.workspace (runtime.mjs / wave-candidate-binding).
  const memberEntries = Object.values(record.members ?? {});
  assert.equal(memberEntries.length, 5, 'the wave record has five members');
  // Each member's provisioned workspace is corroborated against the run that
  // actually implemented that step, so the canonical path comes from the run
  // record rather than a flat member field.
  const implementingRunFor = step => readRunRecords(fixture).find(run =>
    run.wave_bindings?.wave_id === record.wave_id
    && run.wave_bindings?.step_number === step
    && run.wave_bindings?.phase === 'implementing');
  for (const member of memberEntries) {
    const workspace = member.workspace ?? {};
    assert.equal(workspace.backend, 'worktree', `member step ${member.step} workspace backend is worktree`);
    assert.equal(workspace.backendReason, 'userns-denied', `member step ${member.step} workspace backendReason is userns-denied`);
    const implementingRun = implementingRunFor(member.step);
    assert.ok(implementingRun, `member step ${member.step} has an implementing run record`);
    const canonical = memberWorkspace(member, implementingRun);
    assert.equal(typeof canonical, 'string', `member step ${member.step} has a canonical workspace path`);
    assert.ok(canonical.length > 0, `member step ${member.step} canonical workspace path is non-empty`);
    assert.equal(typeof workspace.snapshotId, 'string', `member step ${member.step} workspace has a snapshotId`);
    assert.ok(workspace.snapshotId.length > 0, `member step ${member.step} snapshotId is non-empty`);
    assert.equal(typeof workspace.baseCommit, 'string', `member step ${member.step} workspace has a baseCommit`);
    assert.equal(workspace.baseCommit, fixture.baseCommit, `member step ${member.step} workspace baseCommit is the frozen base`);
  }
  const candidateWorkspace = record.target?.integration?.workspace ?? {};
  assert.equal(candidateWorkspace.backend, 'worktree', 'candidate workspace backend is worktree');
  assert.equal(candidateWorkspace.backendReason, 'userns-denied', 'candidate workspace backendReason is userns-denied');

  // Role prompts and tool sets on each role's first request.
  const firstByRole = new Map();
  for (const request of provider.requests) {
    const role = requestRoute(request).role;
    if (role && !firstByRole.has(role)) firstByRole.set(role, request);
  }
  for (const [role, expectedTools] of Object.entries(ROLE_TOOLS)) {
    const request = firstByRole.get(role);
    assert.ok(request, `role ${role} issued at least one provider request`);
    const system = (requestBody(request).messages ?? []).filter(message => message.role === 'system')
      .map(message => message.content).join('\n');
    assert.ok(system.includes(profileFirstLine(role)), `${role} first request carries its profile first line`);
    assert.deepEqual(requestToolNames(request), expectedTools, `${role} first request tools array`);
  }

  // Context budget is installed on every stage child session.
  for (const sessionPath of findStageSessions(fixture.packagePath)) {
    const text = readFileSync(sessionPath, 'utf8');
    assert.ok(/context[-_ ]?budget/i.test(text), `${sessionPath} has a context-budget request entry`);
  }

  // The step 2 reviewer's write call is refused by the tool guard.
  const step2Reviewer = provider.requests.filter(request => requestRoute(request).role === 'reviewer'
    && requestRoute(request).record?.step_number === 2);
  const blockedWrite = step2Reviewer.some(request => (requestBody(request).messages ?? []).some(message =>
    (message.role === 'tool' || message.role === 'tool_result')
    && (message.is_error === true || message.isError === true)
    && JSON.stringify(message.content ?? '').includes('write')));
  assert.ok(blockedWrite, 'step 2 reviewer write call returns an error tool result');

  for (const dir of [fixture.repo, fixture.integrationCheckout, ...memberCheckouts(record)]) {
    assert.ok(!existsSync(join(dir, 'src', 'hack.txt')), `src/hack.txt absent from ${dir}`);
  }

  // Candidate gate receipt agrees with the promoted head.
  const gate = gateReceipt(record);
  assert.ok(gate, 'candidate gate receipt exists');
  assert.equal(gate.exit_code, 0, 'candidate gate exit code is 0');
  assert.equal(gate.observed_commit, git(fixture.integrationCheckout, 'rev-parse', 'HEAD').trim(),
    'gate observedCommit equals the promoted HEAD');
  const gateOutput = JSON.parse(readFileSync(gate.output_path, 'utf8').trim().split('\n').pop());
  assert.equal(gateOutput.files, 5, 'candidate gate observed five files');

  // D-12 zero-call window: after the successful startup dispatch returns, no
  // coordinator tool call is issued; every later turn is caused by an attention
  // message. The window opens at the literal post-startup boundary: the first
  // coordinator request whose messages carry the startup tool result, matched by
  // the outer SDK event's tool call id against the provider response call ids. A
  // startup request's call id enters the window only when it is also the id of a
  // successful startup result, so a retried or failed startup cannot open it.
  // Checkpoint and workflow requests before that boundary are outside the window
  // and cannot satisfy its attention expectations.
  const coordinatorRequests = provider.requests.filter(request => requestRoute(request).role === 'coordinator');
  // Each outer tool event is retained; its structured reply is parsed separately
  // so the correlation id comes from the event, never from the reply's details.
  const successfulStartupEvents = coordinatorToolEvents(coordinatorFromRun, 'spec_dispatch')
    .filter(event => {
      const result = toolResultObject(event);
      return result && typeof result === 'object'
        && (result.state === 'started' || result.state === 'admitted' || result.state === 'opened')
        && !result.error && !result.code;
    });
  const startupResultIds = new Set();
  for (const event of successfulStartupEvents) {
    const id = event?.toolCallId ?? event?.tool_call_id;
    if (typeof id === 'string') startupResultIds.add(id);
  }
  const startupCallIds = new Set();
  for (const request of coordinatorRequests) {
    for (const call of responseToolCalls(request)) {
      if ((call.function?.name ?? call.name) !== 'spec_dispatch') continue;
      if (typeof call.id !== 'string') continue;
      if (!startupResultIds.has(call.id)) continue;
      startupCallIds.add(call.id);
    }
  }
  for (const id of startupResultIds) startupCallIds.add(id);
  const carriesStartupResult = request => (requestBody(request).messages ?? []).some(message => {
    if (message?.role !== 'tool' && message?.role !== 'tool_result') return false;
    const id = message.tool_call_id ?? message.toolCallId ?? message.call_id;
    return typeof id === 'string' && startupCallIds.has(id);
  });
  const windowStart = coordinatorRequests.findIndex(carriesStartupResult);
  assert.ok(windowStart >= 0, 'a coordinator request carries the startup tool result');
  const seenAttention = new Set();
  let obligationWhileNonterminal = 0;
  let postStartupRequests = 0;
  for (const request of coordinatorRequests.slice(windowStart)) {
    postStartupRequests += 1;
    assert.equal(responseToolCalls(request).length, 0, 'no coordinator tool call after the startup call');
    const fresh = [];
    for (const payload of attentionIn(request)) {
      const identity = `${payload.kind}:${payload.wave_id ?? ''}:${payload.step ?? ''}:${payload.transition ?? ''}`;
      if (seenAttention.has(identity)) continue;
      seenAttention.add(identity);
      fresh.push(identity);
    }
    const arrivedBeforeIntegrated = (request.at ?? request.timestamp ?? Date.now()) < integratedAt;
    if (arrivedBeforeIntegrated) {
      assert.ok(fresh.length >= 1, 'pre-integration post-startup coordinator request carries a new spec-wave attention');
      const text = JSON.stringify(requestBody(request).messages ?? []);
      if (text.includes('Current obligation:')) obligationWhileNonterminal += 1;
    }
  }
  assert.ok(postStartupRequests >= 1, 'the post-startup window holds at least one coordinator request');
  t.diagnostic(`post-startup coordinator requests=${postStartupRequests} attention identities=${JSON.stringify([...seenAttention])}`);
  assert.equal(obligationWhileNonterminal, 0, 'no Current obligation message while the wave is non-terminal');

  const identities = [...seenAttention].map(identity => identity.split(':')[0]);
  for (const kind of WAVE_ATTENTION_KINDS) {
    assert.equal(identities.filter(seen => seen === kind).length, 1, `attention ${kind} appears exactly once`);
  }
  assert.deepEqual([...new Set(identities)].sort(), [...WAVE_ATTENTION_KINDS].sort(), 'attention identities are exactly the wave-level kinds');

  assert.deepEqual(provider.violations, [], 'loopback recorded zero unscripted requests');
  assert.equal(typeof HOST_REMEDIES, 'object');
});

test('wave native: width nine overlaps and survives coordinator restart without duplicate launches', { timeout: 300000 }, async t => {
  const boot = await bootWaveFixture(t, { members: 9 });
  const { fixture, env } = boot;
  const { provider, coordinator: first } = await startNativeRun(t, boot, {
    script: { fixture, members: 9, mode: 'ordinary', case: 'width-nine' },
    tag: 'width-nine',
    arm: loopback => loopback.armBarrier('implementing', 9),
  });

  await provider.barrierReached('implementing');
  const implementing = provider.requests.filter(request => requestRoute(request).record?.phase === 'implementing');
  const ownerPids = [...new Set(implementing.map(request => requestRoute(request).pid))];
  assert.equal(ownerPids.length, 9, 'nine distinct implementing owner pids reached the barrier');
  for (const pid of ownerPids) assert.ok(pidAlive(pid), `implementing pid ${pid} is alive at the barrier`);
  const beforeRelease = readWaveRecord(fixture);
  assert.equal(beforeRelease.requested_width, 9, 'requested_width is 9');
  assert.equal(beforeRelease.admitted_width, 9, 'admitted_width is 9');
  // Event-time admission fact: the CLI setup admits nine and production
  // currently admits seven. Recorded, never bypassed below.
  t.diagnostic(`width-nine: host setup admitted ${boot.setup?.check?.admission?.admittedWidth ?? 'unknown'}, wave admits ${beforeRelease.admitted_width}`);

  provider.armBarrier('reviewing', 9);
  provider.release('implementing');
  await provider.barrierReached('reviewing');
  const reviewing = provider.requests.filter(request => requestRoute(request).record?.phase === 'reviewing');
  const orphanPids = [...new Set(reviewing.map(request => requestRoute(request).pid))];
  assert.equal(orphanPids.length, 9, 'nine distinct review-1 reviewers reached the barrier');
  for (const pid of orphanPids) assert.ok(pidAlive(pid), `reviewing pid ${pid} is alive at the barrier`);

  const generation = readWaveRecord(fixture).generation;
  // Intentional crash, not teardown: kill only the coordinator leader and leave
  // its process group alone. Draining the group here would also kill the
  // observer clients of the orphaned reviewer units, so those units would never
  // observe their own orphan exit (observed as stale active reviewer units).
  await first.crash();
  assert.equal(readWaveRecord(fixture).generation, generation, 'wave generation is unchanged while no coordinator lives');
  provider.release('reviewing');

  // Start the replacement only after every orphan leaves, then keep the exit
  // timestamp so each replacement request can be ordered after it.
  const drainDeadline = Date.now() + 30000;
  while (orphanPids.some(pid => pidAlive(pid)) && Date.now() < drainDeadline) await sleep(100);
  assert.deepEqual(orphanPids.filter(pid => pidAlive(pid)), [], 'orphaned reviewer pids exited after release');
  const orphansGoneAt = Date.now();
  const replacementAt = Date.now();

  const replacement = startCoordinator({
    sandbox: fixture,
    env,
    script: { port: provider.port, case: 'width-nine' },
    tag: 'width-nine-restart',
  });
  provider.script.mode = 'restart';
  boot.coordinators.push(replacement);
  await replacement.ready;
  await waitForWaveState(() => readWaveRecord(fixture), record => record.state === 'integrated',
    { timeoutMs: 240000, label: 'restarted integrated' });

  const replacementReviewers = provider.requests.filter(request => request.at >= replacementAt
    && requestRoute(request).role === 'reviewer' && request.turn === 0
    && requestRoute(request).record?.phase === 'reviewing');
  assert.equal(replacementReviewers.length, 9, 'the replacement driver issues one review-1 request per step');
  for (const request of replacementReviewers) {
    assert.ok(request.at >= orphansGoneAt, `replacement request at ${request.at} follows orphan exit at ${orphansGoneAt}`);
    assert.deepEqual(orphanPids.filter(pid => pidAlive(pid)), [], 'no orphaned reviewer pid survives a replacement request');
    // Event-time liveness: the reviewer PID snapshotted when this turn-0 request
    // arrived must contain no original (orphaned) review-1 pid.
    const liveAtArrival = request.liveReviewingPids ?? [];
    assert.deepEqual(orphanPids.filter(pid => liveAtArrival.includes(pid)), [],
      `replacement request at ${request.at} snapshots no orphaned reviewer pid (${JSON.stringify(liveAtArrival)})`);
  }

  const record = readWaveRecord(fixture);
  const runs = readRunRecords(fixture).filter(run => run.wave_bindings?.wave_id === record.wave_id);
  for (let step = 1; step <= 9; step += 1) {
    const stepRuns = runs.filter(run => run.wave_bindings?.step_number === step);
    assert.equal(stepRuns.filter(run => run.wave_bindings.phase === 'implementing').length, 1,
      `step ${step} has exactly one implementing run`);
    assert.equal(stepRuns.filter(run => run.wave_bindings.phase === 'reviewing').length, 2,
      `step ${step} has exactly two reviewing runs`);
  }

  const chain = git(fixture.integrationCheckout, 'rev-list', '--first-parent', 'HEAD').trim().split('\n').filter(Boolean);
  const baseIndex = chain.indexOf(fixture.baseCommit);
  assert.ok(baseIndex >= 0, 'frozen base is on the first-parent chain');
  const promoted = chain.slice(0, baseIndex);
  assert.equal(promoted.length, 9, 'nine promote commits above the frozen base');
  for (const commit of promoted) {
    const parents = git(fixture.integrationCheckout, 'rev-list', '--parents', '-n', '1', commit)
      .trim().split(/\s+/).slice(1);
    assert.equal(parents.length, 2, `promote commit ${commit} has two parents`);
  }

  const coordinatorRequests = provider.requests.filter(request => requestRoute(request).role === 'coordinator');
  const seenAttention = new Set();
  const identities = [];
  for (const request of coordinatorRequests) {
    for (const payload of attentionIn(request)) {
      const identity = `${payload.kind}:${payload.wave_id ?? ''}:${payload.step ?? ''}`;
      if (seenAttention.has(identity)) continue;
      seenAttention.add(identity);
      identities.push(identity);
    }
  }
  const kinds = identities.map(identity => identity.split(':')[0]);
  for (const kind of WAVE_ATTENTION_KINDS) {
    assert.equal(kinds.filter(seen => seen === kind).length, 1,
      `attention ${kind} appears once across both drivers`);
  }

  const assertNoCallsAfterStartup = (coordinator, requests, label) => {
    // The correlation id comes from each outer successful tool event, never from
    // the reply's `details`; a reply carrying an unrelated id cannot widen the
    // startup window.
    const successfulStartupEvents = coordinatorToolEvents(coordinator, 'spec_dispatch')
      .filter(event => {
        const result = toolResultObject(event);
        return result && typeof result === 'object'
          && (result.state === 'started' || result.state === 'admitted' || result.state === 'opened')
          && !result.error && !result.code;
      });
    const resultIds = new Set();
    for (const event of successfulStartupEvents) {
      const id = event?.toolCallId ?? event?.tool_call_id;
      if (typeof id === 'string') resultIds.add(id);
    }
    const windowStart = requests.findIndex(request => (requestBody(request).messages ?? []).some(message => {
      if (message?.role !== 'tool' && message?.role !== 'tool_result') return false;
      const id = message.tool_call_id ?? message.toolCallId ?? message.call_id;
      return typeof id === 'string' && resultIds.has(id);
    }));
    assert.ok(windowStart >= 0, `${label} request history carries its startup result`);
    for (const request of requests.slice(windowStart)) {
      assert.equal(responseToolCalls(request).length, 0, `${label} issues no tool call after startup`);
    }
  };
  assertNoCallsAfterStartup(first, coordinatorRequests.filter(request => request.at < replacementAt), 'first driver');
  assertNoCallsAfterStartup(replacement, coordinatorRequests.filter(request => request.at >= replacementAt), 'replacement driver');

  assert.deepEqual(provider.violations, [], 'loopback recorded zero unscripted requests');
});

test('wave native: blocked members preserve work and repeated entry launches nothing', { timeout: 180000 }, async t => {
  const boot = await bootWaveFixture(t, { members: 5, lengthStopStep: 3, missingReviewStep: 4 });
  const { fixture, env } = boot;
  const { provider, coordinator } = await startNativeRun(t, boot, {
    script: { fixture, members: 5, lengthStopStep: 3, missingReviewStep: 4, mode: 'ordinary', case: 'blocked' },
    tag: 'blocked',
  });

  const reviewingRuns = () => readRunRecords(fixture).filter(run => run.wave_bindings?.phase === 'reviewing'
    && run.wave_bindings?.step_number === 4);
  const blocked = await waitForWaveState(() => readWaveRecords(fixture)[0]?.record, record => {
    const byStep = new Map(Object.values(record.members ?? {}).map(member => [member.step, member]));
    return record.state === 'blocked'
      && [1, 2, 5].every(step => byStep.get(step)?.phase === 'sealed')
      && byStep.get(3)?.phase === 'blocked'
      && byStep.get(4)?.phase === 'blocked'
      && reviewingRuns().length === 2
      && reviewingRuns().every(run => TERMINAL_RUN_STATES.has(run.state));
  }, { timeoutMs: 150000, label: 'blocked wave with completed retry' });

  const member = step => Object.values(blocked.members ?? {}).find(entry => entry.step === step);
  const member3 = member(3);
  const member4 = member(4);
  // Blocked members keep their durable workspace; the canonical path is again
  // corroborated by an actual implementing run for that step.
  const implementingRunFor = step => readRunRecords(fixture).find(run =>
    run.wave_bindings?.wave_id === blocked.wave_id
    && run.wave_bindings?.step_number === step
    && run.wave_bindings?.phase === 'implementing');
  const member3Run = implementingRunFor(3);
  const member4Run = implementingRunFor(4);
  assert.ok(member3Run, 'step 3 has an implementing run record');
  assert.ok(member4Run, 'step 4 has an implementing run record');
  const member3Path = memberWorkspace(member3, member3Run);
  const member4Path = memberWorkspace(member4, member4Run);
  assert.equal(member3.blocking_reason, 'length-stop', 'step 3 blocks on the length stop');
  // `--untracked-files=all` keeps Git from collapsing the untracked directory
  // so the assertion names the actual file the implementing run left behind.
  assert.equal(git(member3Path, 'status', '--porcelain', '--untracked-files=all').trimEnd(), '?? src/step-03.txt',
    'step 3 preserves the uncommitted implementation file');
  assert.equal(member4.blocking_reason, 'review-transport-failed', 'step 4 blocks on the review transport');
  assert.equal(member4.sealed_head, null, 'step 4 has no sealed head');
  assert.equal(member4.head_commit, git(member4Path, 'rev-parse', 'HEAD').trim(),
    'step 4 checkout HEAD is its implementation commit');

  const step4Runs = reviewingRuns();
  assert.equal(step4Runs.length, 2, 'step 4 records exactly two reviewing runs');
  const reviewedModel = run => {
    const launched = JSON.parse(readFileSync(run.service_request, 'utf8'));
    const args = launched.args ?? [];
    const index = args.indexOf('--model');
    return index >= 0 ? args[index + 1] : null;
  };
  assert.equal(step4Runs[0].stage, step4Runs[1].stage, 'step 4 retry keeps the same stage label');
  assert.equal(reviewedModel(step4Runs[0]), reviewedModel(step4Runs[1]), 'step 4 retry keeps the same review model');
  assert.ok(typeof reviewedModel(step4Runs[0]) === 'string' && reviewedModel(step4Runs[0]).length > 0,
    'step 4 review runs carry a --model argument');
  assert.equal(git(fixture.integrationCheckout, 'rev-parse', 'HEAD').trim(), fixture.baseCommit,
    'integration branch ref is still the frozen base');

  await coordinator.shutdown();
  const runCount = readRunRecords(fixture).length;
  const workerRequests = provider.requests.filter(request =>
    ['owner', 'editor', 'reviewer', 'fixer'].includes(requestRoute(request).role)).length;

  const repeated = startCoordinator({
    sandbox: fixture,
    env,
    script: { port: provider.port, case: 'blocked' },
    tag: 'blocked-repeat',
  });
  provider.script.mode = 'repeated-entry';
  boot.coordinators.push(repeated);
  await repeated.ready;
  const [startup] = await waitForCoordinatorToolEvents(repeated, 'spec_dispatch', 1,
    { timeoutMs: 120000, label: 'repeated entry startup' });
  const startupResult = toolResultObject(startup);
  assert.equal(startupResult.state, 'blocked', 'the repeated startup reports blocked');
  const named = JSON.stringify(startupResult);
  assert.ok(named.includes('3') && named.includes('4'), `the repeated startup names steps 3 and 4: ${named}`);
  assert.equal(readRunRecords(fixture).length, runCount, 'the repeated startup creates no run record');
  assert.equal(provider.requests.filter(request =>
    ['owner', 'editor', 'reviewer', 'fixer'].includes(requestRoute(request).role)).length, workerRequests,
  'the repeated startup sends no worker-route request');

  const blockedIdentities = new Set();
  for (const request of provider.requests.filter(entry => requestRoute(entry).role === 'coordinator')) {
    for (const payload of attentionIn(request)) {
      if (payload.kind !== 'member-blocked') continue;
      blockedIdentities.add(`${payload.kind}:${payload.wave_id ?? ''}:${payload.step ?? ''}`);
    }
  }
  const blockedSteps = [...blockedIdentities].map(identity => Number(identity.split(':')[2])).sort((a, b) => a - b);
  assert.deepEqual(blockedSteps, [3, 4], 'member-blocked attention identities are exactly steps 3 and 4, once each');
});

test('wave native: host setup refusal launches no worker', { timeout: 60000 }, async t => {
  const boot = await bootWaveFixture(t, { members: 5 });
  const { fixture, shimStateDir } = boot;
  // D-28 setup already succeeded inside the boot helper; make the manager
  // unreachable and prove startup refuses before any worker launches.
  await setShimMode(shimStateDir, 'managerUnreachable');
  const { provider, coordinator } = await startNativeRun(t, boot, {
    script: { fixture, members: 5, mode: 'ordinary', case: 'host-refusal' },
    tag: 'host-refusal',
  });

  const [startup] = await waitForCoordinatorToolEvents(coordinator, 'spec_dispatch', 1,
    { timeoutMs: 60000, label: 'host-refusal startup' });
  const startupResult = toolResultObject(startup);
  assert.equal(startupResult.state, 'setup-required', 'refusal state is setup-required');
  assert.equal(startupResult.reason, 'manager-unreachable', 'refusal reason is manager-unreachable');
  assert.equal(startupResult.remedy, HOST_REMEDIES['manager-unreachable'], 'refusal remedy matches the host remedies table');

  const workerRequests = provider.requests.filter(request =>
    ['owner', 'editor', 'reviewer', 'fixer'].includes(requestRoute(request).role));
  assert.equal(workerRequests.length, 0, 'no worker-route request reached the loopback provider');

  assert.deepEqual(readRunRecords(fixture), [], 'no run record exists after the refusal');
  for (const { record } of readWaveRecords(fixture)) {
    for (const member of Object.values(record.members ?? {})) {
      const phase = member.phase ?? member.state;
      assert.ok(phase === undefined || phase === 'queued', `member step ${member.step} stays queued`);
    }
  }

  assert.deepEqual(readdirSync(join(shimStateDir, 'units')), [], 'the shim unit registry is empty');
  assert.equal(git(fixture.integrationCheckout, 'rev-parse', 'HEAD').trim(), fixture.baseCommit,
    'integration branch ref equals the frozen base');
});

test('wave native: multi-target package refuses waves and selects serial', { timeout: 120000 }, async t => {
  const boot = await bootWaveFixture(t, { members: 2, targets: ['repo', 'other'] });
  const { fixture } = boot;
  const wavesDir = join(fixture.packagePath, 'runtime', 'waves');
  const { coordinator } = await startNativeRun(t, boot, {
    script: { fixture, members: 2, mode: 'multi-target', case: 'multi-target' },
    tag: 'multi-target',
  });

  const [wavesEvent, autoEvent] = await waitForCoordinatorToolEvents(coordinator, 'spec_dispatch', 2,
    { timeoutMs: 120000, label: 'multi-target startup' });
  const wavesResult = toolResultObject(wavesEvent);
  const wavesError = wavesResult.error ?? wavesResult.code ?? wavesResult.reason ?? '';
  assert.ok(String(wavesError).includes('waves-multiple-targets'),
    `waves call refuses with waves-multiple-targets: ${JSON.stringify(wavesResult)}`);
  assert.ok(!existsSync(wavesDir), 'the waves call creates no runtime/waves directory');

  const autoResult = toolResultObject(autoEvent);
  assert.equal(autoResult.execution, 'serial', 'auto call selects execution serial');
  const autoReasons = autoResult.reasons ?? autoResult.check?.reasons ?? [];
  assert.ok(autoReasons.includes('multiple-targets'), `auto reasons include multiple-targets: ${JSON.stringify(autoResult)}`);
  assert.ok(!existsSync(wavesDir), 'still no runtime/waves record exists');

  await waitForRunState(fixture,
    records => records.some(record => TERMINAL_RUN_STATES.has(record.state)),
    { timeoutMs: 120000, label: 'legacy serial run terminal state' });
});

test('wave native: chain and flat waves report elapsed time with identical trees', { timeout: 300000 }, async t => {
  const flatBoot = await bootWaveFixture(t, { members: 5 });
  const flat = flatBoot.fixture;
  const { provider: flatProvider } = await startNativeRun(t, flatBoot, {
    script: { fixture: flat, members: 5, mode: 'ordinary', case: 'timing-flat' },
    tag: 'timing-flat',
    arm: loopback => loopback.armBarrier('implementing', 5),
  });
  await flatProvider.barrierReached('implementing');
  const flatHeld = flatProvider.requests.filter(request => requestRoute(request).record?.phase === 'implementing');
  const flatPids = [...new Set(flatHeld.map(request => requestRoute(request).pid))];
  assert.equal(flatPids.length, 5, 'five distinct implementing owner pids are alive at once');
  for (const pid of flatPids) assert.ok(pidAlive(pid), `flat implementing pid ${pid} is alive`);
  flatProvider.release('implementing');

  // Both timing shapes must be exercised even when one of them fails, so the
  // chain run boots before either shape is awaited and both waits run
  // concurrently. Rejections are reported per shape and rethrown, never
  // swallowed; every downstream assertion only runs if both integrated.
  const chainBoot = await bootWaveFixture(t, { members: 5, chain: true });
  const chainFixture = chainBoot.fixture;
  const { provider: chainProvider } = await startNativeRun(t, chainBoot, {
    script: { fixture: chainFixture, members: 5, chain: true, mode: 'ordinary', case: 'timing-chain' },
    tag: 'timing-chain',
  });
  const timingShapes = [
    {
      shape: 'flat',
      wait: waitForWaveState(() => readWaveRecord(flat), record => {
        if (record?.state === 'blocked') {
          throw new Error(`timing shape flat blocked: ${JSON.stringify(record)}`);
        }
        return record.state === 'integrated';
      }, { timeoutMs: 240000, label: 'flat integrated' }),
    },
    {
      shape: 'chain',
      wait: waitForWaveState(() => readWaveRecords(chainFixture), records => {
        const blocked = records.find(({ record }) => record.state === 'blocked');
        if (blocked) {
          throw new Error(`timing shape chain blocked: ${JSON.stringify(blocked.record)}`);
        }
        return records.length === 5 && records.every(({ record }) => record.state === 'integrated');
      }, { timeoutMs: 240000, label: 'chain integrated' }),
    },
  ];
  const timingResults = await Promise.allSettled(timingShapes.map(({ wait }) => wait));
  const timingFailures = timingShapes
    .map((shape, index) => ({ shape: shape.shape, result: timingResults[index] }))
    .filter(({ result }) => result.status === 'rejected');
  if (timingFailures.length > 0) {
    for (const { shape, result } of timingFailures) {
      t.diagnostic(`timing shape ${shape} failed: ${result.reason?.stack ?? result.reason}`);
    }
    throw new AggregateError(timingFailures.map(({ result }) => result.reason),
      `timing shapes failed: ${timingFailures.map(({ shape }) => shape).join(', ')}`);
  }

  // No synchronous request-arrival barrier exists for chain waves, so durable
  // width is corroborated by the event-time PID snapshot the provider records
  // when each implementing request arrives.
  const chainImplementing = chainProvider.requests.filter(request => requestRoute(request).role === 'owner'
    && requestRoute(request).record?.phase === 'implementing');
  const chainWaveIds = new Set(chainImplementing.map(request => requestRoute(request).record?.wave_id));
  const chainRecords = readWaveRecords(chainFixture).map(({ record }) => record);
  // Event-time liveness, not durable width: each chain implementing request
  // arrives with at most one other implementing owner already live, which is
  // the overlap the chain policy permits.
  for (const request of chainImplementing) {
    const liveAtArrival = request.liveImplementingPids ?? [];
    assert.ok(liveAtArrival.length <= 1,
      `chain implementing request at ${request.at} snapshots at most one live implementing owner (${JSON.stringify(liveAtArrival)})`);
  }
  const chainMaxLive = Math.max(0, ...chainImplementing.map(request => (request.liveImplementingPids ?? []).length));
  assert.equal(chainMaxLive, 1, `chain implementing requests snapshot exactly one live implementing owner, itself (max=${chainMaxLive})`);
  for (const waveId of chainWaveIds) {
    const wave = chainRecords.find(record => record.wave_id === waveId);
    assert.ok(wave, `chain implementing request carries durable wave ${waveId}`);
    assert.equal(wave.requested_width, 1, `chain wave ${waveId} requested width is 1`);
    assert.equal(wave.admitted_width, 1, `chain wave ${waveId} admitted width is 1`);
  }
  assert.equal(chainWaveIds.size, 5, 'chain implementing requests cover five distinct waves');

  const flatTree = git(flat.integrationCheckout, 'rev-parse', 'HEAD^{tree}').trim();
  const chainTree = git(chainFixture.integrationCheckout, 'rev-parse', 'HEAD^{tree}').trim();
  assert.equal(flatTree, chainTree, 'flat and chain integration trees are identical');
  assert.equal(readWaveRecords(flat).length, 1, 'flat produces exactly one wave');
  assert.equal(chainRecords.length, 5, 'chain produces exactly five waves');

  const metricsOf = packagePath => JSON.parse(execFileSync(process.execPath,
    [cliPath, 'metrics', '--package', packagePath, '--format', 'json'], { encoding: 'utf8' }));
  const flatMetrics = metricsOf(flat.packagePath);
  const chainMetrics = metricsOf(chainFixture.packagePath);
  assert.equal(flatMetrics.waves.length, 1, 'flat metrics report one wave');
  const flatWave = flatMetrics.waves[0];
  assert.equal(flatWave.requested_width, 5, 'flat metrics requested_width is 5');
  assert.equal(flatWave.admitted_width, 5, 'flat metrics admitted_width is 5');
  assert.equal(flatWave.peak_observed_overlap, 5, 'flat metrics peak overlap is 5');
  assert.equal(chainMetrics.waves.length, 5, 'chain metrics report five waves');
  for (const wave of chainMetrics.waves) {
    assert.equal(wave.requested_width, 1, `chain wave ${wave.wave_id} requested_width is 1`);
    assert.equal(wave.admitted_width, 1, `chain wave ${wave.wave_id} admitted_width is 1`);
    assert.equal(wave.peak_observed_overlap, 1, `chain wave ${wave.wave_id} peak overlap is 1`);
  }

  // Elapsed time comes from the durable open/integrated transitions through the
  // wave-native timing helper; a real record must yield a finite, non-negative
  // duration instead of a null diagnostic.
  const flatMs = elapsedWaveMs(readWaveRecord(flat));
  const chainMs = elapsedWaveSetMs(chainRecords);
  assert.ok(Number.isFinite(flatMs), 'flat wave elapsed milliseconds are finite');
  assert.ok(flatMs >= 0, 'flat wave elapsed milliseconds are non-negative');
  assert.ok(Number.isFinite(chainMs), 'chain wave elapsed milliseconds are finite');
  assert.ok(chainMs >= 0, 'chain wave elapsed milliseconds are non-negative');
  const integrationMs = [...flatMetrics.waves, ...chainMetrics.waves]
    .reduce((sum, wave) => sum + (Number(wave.integration_seconds) || 0) * 1000, 0);
  t.diagnostic(`flat_ms=${flatMs} chain_ms=${chainMs} integration_ms=${Math.round(integrationMs)}`);
});
