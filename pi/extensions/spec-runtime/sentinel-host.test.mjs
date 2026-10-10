// Real ordinary-entry acceptance for the observe-only Sentinel host. Every
// case runs the actual sentinel-host.mjs subprocess (or the public factory for
// scenario D) against isolated canonical temporary agentDir/root fixtures with
// a sanitized environment; no live repository, credential, gh, Pi, launchd or
// Tailscale state is touched.
//
// Focused command: node --test pi/extensions/spec-runtime/sentinel-host.test.mjs
// Selectable case: node --test --test-name-pattern 'scenario A' pi/extensions/spec-runtime/sentinel-host.test.mjs
// Selectable case: node --test --test-name-pattern 'scenario B' pi/extensions/spec-runtime/sentinel-host.test.mjs
// Selectable case: node --test --test-name-pattern 'scenario C' pi/extensions/spec-runtime/sentinel-host.test.mjs
// Selectable case: node --test --test-name-pattern 'scenario D' pi/extensions/spec-runtime/sentinel-host.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as tcpConnect, createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { inspectProcess, sameProcess } from '../../../scripts/spec-observe/process-identity.mjs';
import { workspaceKey } from '../../../scripts/spec-observe/sentinel.mjs';
import { createSentinelHost } from './sentinel-host.mjs';

const HOST_FILE = fileURLToPath(new URL('./sentinel-host.mjs', import.meta.url));
const SCOPE = 'sentinel-host-test';
const READY_TIMEOUT_MS = 10000;
const PUBLICATION_TIMEOUT_MS = 25000;
const SHUTDOWN_TIMEOUT_MS = 10000;

function withDeadline(promise, milliseconds, description) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description} after ${milliseconds} ms.`)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Bounded polling only; there are no fixed readiness or shutdown sleeps.
async function waitFor(predicate, description, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description} after ${timeoutMs} ms.`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function jsonLines(text) {
  return text.split('\n').map(line => line.trim()).filter(line => line.startsWith('{'))
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(entry => entry !== null);
}

// macOS ps has no -P; read the full bounded PID/PPID table once and select
// this caller's children. Only identity checks later decide liveness.
function directChildren(pid) {
  const text = execFileSync('ps', ['-axo', 'pid=,ppid='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    timeout: 2000,
    maxBuffer: 1024 * 1024,
  });
  const children = [];
  for (const line of text.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (Number.isSafeInteger(child) && Number.isSafeInteger(parent) && parent === pid) children.push(child);
  }
  return children;
}

function describeProcess(pid) {
  const observed = inspectProcess(pid);
  return observed.state === 'alive' ? { pid, started_at: observed.started_at } : null;
}

function snapshotDirectory(agentDir, scope) {
  return join(agentDir, 'spec-sentinel', workspaceKey({ agentDir, scope }), 'observers');
}

function readSnapshotFiles(agentDir, scope) {
  const directory = snapshotDirectory(agentDir, scope);
  let names;
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter(name => name.endsWith('.json')).sort().map(name => ({
    name,
    path: join(directory, name),
    value: JSON.parse(readFileSync(join(directory, name), 'utf8')),
  }));
}

async function waitForSnapshot(agentDir, scope, predicate, description) {
  return waitFor(() => readSnapshotFiles(agentDir, scope).find(entry => predicate(entry.value)) ?? null,
    description, PUBLICATION_TIMEOUT_MS, 250);
}

function requestOnce({ port, method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let parsed = null;
        if (text) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
        resolve({ status: response.statusCode, body: parsed, text });
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function connectOnce(host, port, timeoutMs = 750) {
  return new Promise(resolve => {
    const socket = tcpConnect({ host, port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function createFixture(t, name) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `sentinel-host-${name}-`)));
  const agentDir = join(base, 'agent');
  const home = join(base, 'home');
  const root = join(base, 'root');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  const tracked = [];
  const servers = [];
  // No credential or provider environment crosses into the host: only the
  // isolated PATH/HOME, the owned agent dir/scope and a temp TMPDIR.
  const environment = () => {
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_INTERCOM_SCOPE_ID: SCOPE,
      LC_ALL: 'C',
    };
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    return env;
  };
  const spawnOwned = argv => {
    const child = spawn(process.execPath, argv, { env: environment(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const io = { stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { io.stdout += chunk; });
    child.stderr.on('data', chunk => { io.stderr += chunk; });
    const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const owned = { child, io, exit, pid: child.pid };
    tracked.push(owned);
    return owned;
  };
  const baseArgs = (extra = []) => ['--agent-dir', agentDir, '--root', root, ...extra];
  t.after(async () => {
    // Only our own spawned process groups are stopped, and only after their
    // tracked ChildProcess handles exist.
    for (const { child } of tracked) {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }
    await Promise.all(tracked.map(entry => entry.exit));
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    rmSync(base, { recursive: true, force: true });
  });
  return { base, agentDir, home, root, servers, environment, spawnOwned, spawnHost: extra => spawnOwned([HOST_FILE, ...extra]), baseArgs };
}

async function waitForReady(host, timeoutMs = READY_TIMEOUT_MS) {
  return waitFor(() => {
    const receipt = jsonLines(host.io.stdout).find(entry => entry.type === 'ready');
    if (receipt) return receipt;
    if (host.child.exitCode !== null || host.child.signalCode !== null) {
      throw new Error(`Host exited before ready (${host.child.signalCode ?? host.child.exitCode}): ${host.io.stderr.trim()}`);
    }
    return null;
  }, 'JSON ready line', timeoutMs, 50);
}

// Scenario A: port 0 + public host; real publications; remote/local HTTP
// locality; competing alias refusal; repeated-signal shutdown; successor UUID.
async function scenarioOrdinaryPublicHost(t) {
  const f = createFixture(t, 'a');
  const host = f.spawnHost(f.baseArgs(['--port', '0', '--public-host', 'dashboard.example']));
  const receipt = await waitForReady(host);
  assert.equal(receipt.type, 'ready');
  assert.equal(receipt.state, 'observing');
  assert.equal(receipt.dashboard_state, 'ready');
  assert.match(receipt.dashboard_url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.ok(receipt.snapshot_path.startsWith(`${f.agentDir}/`), 'snapshot lives in the isolated agent directory');

  const first = JSON.parse(readFileSync(receipt.snapshot_path, 'utf8'));
  assert.equal(first.state, 'observing');
  assert.match(first.observer_id, /^[0-9a-f-]{36}$/);
  assert.ok(first.snapshot, 'initial snapshot carries workspace facts');
  assert.deepEqual(first.snapshot.runs, []);
  assert.equal(first.snapshot.reader.isolated, true, 'the host reads through the isolated reader child');
  assert.notEqual(first.snapshot.reader.pid, process.pid);
  const observerId = first.observer_id;
  const port = Number(new URL(receipt.dashboard_url).port);

  // Remote GET through the accepted public Host/Origin: no token, local-only completion.
  const remoteState = await requestOnce({ port, path: '/api/state',
    headers: { Host: 'dashboard.example', Origin: 'https://dashboard.example' } });
  assert.equal(remoteState.status, 200);
  assert.equal(remoteState.body.completion, 'local-only');
  assert.equal(Object.hasOwn(remoteState.body, 'action_token'), false, 'remote state carries no action token');

  // Remote completion POST is refused before it can create a record.
  const completionPath = join(f.root, 'sentinel-completion.json');
  assert.equal(existsSync(completionPath), false);
  const remoteCompletion = await requestOnce({ port, method: 'POST', path: '/api/package-completion',
    headers: { Host: 'dashboard.example', Origin: 'https://dashboard.example', 'Content-Type': 'application/json', 'x-sentinel-token': 'remote-attempt' },
    body: JSON.stringify({ package: f.root }) });
  assert.equal(remoteCompletion.status, 403, 'a remote completion is refused');
  assert.equal(existsSync(completionPath), false, 'a refused remote completion creates no record');

  // Local loopback state retains the action token.
  const localState = await requestOnce({ port, path: '/api/state' });
  assert.equal(localState.status, 200);
  assert.match(localState.body.action_token, /^[a-f0-9]{64}$/);

  // Concrete loopback-only listener observation.
  assert.equal(await connectOnce('127.0.0.1', port), true, 'the dashboard accepts loopback connections');
  const external = Object.values(networkInterfaces()).flat()
    .find(info => info && info.family === 'IPv4' && !info.internal && info.address !== '127.0.0.1');
  if (external) assert.equal(await connectOnce(external.address, port), false, `the dashboard is not bound on ${external.address}`);

  // The real 15 s reconcile publishes a second sequence with no timer overrides.
  const second = await waitForSnapshot(f.agentDir, SCOPE,
    value => value.observer_id === observerId && value.sequence >= 2, 'second snapshot publication');
  assert.ok(second.value.sequence >= 2);

  // A competing host through a symlink alias of the same agentDir is refused
  // before it can publish.
  const alias = join(f.base, 'agent-alias');
  symlinkSync(f.agentDir, alias);
  const filenamesBefore = readSnapshotFiles(f.agentDir, SCOPE).map(entry => entry.name);
  const competitor = f.spawnHost(['--agent-dir', alias, '--root', f.root, '--port', '0']);
  const competitorExit = await withDeadline(competitor.exit, SHUTDOWN_TIMEOUT_MS, 'competing host exit');
  assert.notEqual(competitorExit.code, 0);
  assert.equal(jsonLines(competitor.io.stdout).some(entry => entry.type === 'ready'), false, 'the refused host prints no ready receipt');
  assert.match(competitor.io.stderr, /ownership|held|live pid/i);
  assert.deepEqual(readSnapshotFiles(f.agentDir, SCOPE).map(entry => entry.name), filenamesBefore,
    'the refused host publishes no snapshot');

  // Owned children are observed exactly, never assumed from numeric pids.
  const hostChildren = directChildren(host.pid).map(describeProcess).filter(identity => identity !== null);
  assert.ok(hostChildren.length >= 2, `expected owned reader and dashboard children, saw ${hostChildren.length}`);
  const sleeper = f.spawnOwned(['-e', 'setInterval(() => {}, 1000)']);
  const sleeperIdentity = describeProcess(sleeper.pid);
  assert.ok(sleeperIdentity, 'the unrelated owned process is alive');

  // Repeated SIGTERM then SIGINT share one bounded shutdown.
  host.child.kill('SIGTERM');
  host.child.kill('SIGINT');
  const hostExit = await withDeadline(host.exit, SHUTDOWN_TIMEOUT_MS, 'host shutdown');
  assert.equal(hostExit.code, 0);

  const closed = JSON.parse(readFileSync(receipt.snapshot_path, 'utf8'));
  assert.equal(closed.state, 'closed');
  assert.equal(closed.observer_id, observerId, 'the closed snapshot keeps the observer UUID');
  for (const identity of hostChildren) {
    assert.equal(sameProcess(identity), false, `owned child ${identity.pid} exited with the host`);
  }
  assert.equal(sameProcess(sleeperIdentity), true, 'an unrelated owned process is not signalled');

  // A successor lifetime admits the released claim with a distinct UUID and closes.
  const successor = f.spawnHost(f.baseArgs(['--port', '0']));
  const successorReceipt = await waitForReady(successor);
  assert.equal(successorReceipt.state, 'observing');
  const successorSnapshot = JSON.parse(readFileSync(successorReceipt.snapshot_path, 'utf8'));
  assert.notEqual(successorSnapshot.observer_id, observerId, 'a successor lifetime has a distinct UUID');
  successor.child.kill('SIGTERM');
  const successorExit = await withDeadline(successor.exit, SHUTDOWN_TIMEOUT_MS, 'successor shutdown');
  assert.equal(successorExit.code, 0);
  assert.equal(JSON.parse(readFileSync(successorReceipt.snapshot_path, 'utf8')).state, 'closed');
}

// Scenario B: an owned loopback server reserves default port 4319; the host
// still observes twice with an unavailable dashboard, then releases the claim.
async function scenarioOccupiedDefaultPort(t) {
  const f = createFixture(t, 'b');
  const blocker = createServer(socket => socket.end());
  let reservedByUs = false;
  try {
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(4319, '127.0.0.1', resolve);
    });
    reservedByUs = true;
    f.servers.push(blocker);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    // An existing listener already occupies the default port. Its observed
    // bind failure is the precondition for this journey; no traffic is sent
    // to that listener and it is never adopted, inspected or stopped.
    t.diagnostic('default port 4319 is already occupied; the observed bind failure is used as the precondition and the existing listener is left untouched.');
  }

  const host = f.spawnHost(f.baseArgs());
  const receipt = await waitForReady(host);
  assert.equal(receipt.type, 'ready');
  assert.equal(receipt.state, 'observing');
  assert.equal(receipt.dashboard_url, null, 'the occupied default port leaves no dashboard URL');
  assert.equal(receipt.dashboard_state, 'unavailable');

  const first = JSON.parse(readFileSync(receipt.snapshot_path, 'utf8'));
  assert.equal(first.state, 'observing');
  assert.deepEqual(first.snapshot.runs, []);
  const second = await waitForSnapshot(f.agentDir, SCOPE,
    value => value.observer_id === first.observer_id && value.sequence >= 2, 'second publication with an occupied default port');
  assert.ok(second.value.sequence >= 2, 'observation advances although the dashboard is unavailable');

  host.child.kill('SIGTERM');
  const hostExit = await withDeadline(host.exit, SHUTDOWN_TIMEOUT_MS, 'occupied-port host shutdown');
  assert.equal(hostExit.code, 0);
  assert.equal(JSON.parse(readFileSync(receipt.snapshot_path, 'utf8')).state, 'closed');

  // The released claim admits a successor; an owned port reservation stays up.
  if (reservedByUs) assert.ok(blocker.listening, 'the owned port reservation is still listening');
  const successor = f.spawnHost(f.baseArgs(['--port', '0']));
  const successorReceipt = await waitForReady(successor);
  assert.equal(successorReceipt.state, 'observing');
  successor.child.kill('SIGTERM');
  await withDeadline(successor.exit, SHUTDOWN_TIMEOUT_MS, 'successor shutdown');
}

// Scenario C: import-only and invalid argv/root/publicHost fail before effects.
async function scenarioInvalidInputs(t) {
  const f = createFixture(t, 'c');
  const importOnly = f.spawnOwned(['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(HOST_FILE).href)});`]);
  const importExit = await withDeadline(importOnly.exit, READY_TIMEOUT_MS, 'import-only exit');
  assert.equal(importExit.code, 0);
  assert.equal(importOnly.io.stdout, '', 'import alone prints nothing');
  assert.equal(existsSync(f.agentDir), false, 'import alone creates no agent directory');

  const rootFile = join(f.base, 'not-a-directory');
  writeFileSync(rootFile, 'file\n');
  const cases = [
    ['unknown flag', ['--agent-dir', f.agentDir, '--unknown', 'x']],
    ['duplicate flag', ['--agent-dir', f.agentDir, '--agent-dir', f.agentDir]],
    ['missing value', ['--agent-dir']],
    ['noninteger port', ['--agent-dir', f.agentDir, '--port', 'abc']],
    ['out-of-range port', ['--agent-dir', f.agentDir, '--port', '65536']],
    ['invalid public host', ['--agent-dir', f.agentDir, '--public-host', 'bad host']],
    ['missing root', ['--agent-dir', f.agentDir, '--root', join(f.base, 'missing-root')]],
    ['nondirectory root', ['--agent-dir', f.agentDir, '--root', rootFile]],
  ];
  for (const [label, argv] of cases) {
    const host = f.spawnOwned([HOST_FILE, ...argv]);
    const exit = await withDeadline(host.exit, READY_TIMEOUT_MS, `${label} exit`);
    assert.notEqual(exit.code, 0, `${label} exits nonzero`);
    assert.equal(jsonLines(host.io.stdout).some(entry => entry.type === 'ready'), false, `${label} prints no ready receipt`);
    assert.match(host.io.stderr, /Sentinel host failed/, `${label} reports the failure`);
    assert.equal(existsSync(f.agentDir), false, `${label} creates no agent directory`);
  }
}

// Scenario D: the public factory composes real resources in-process, shares one
// close promise, publishes closed output and leaves no lifetime timer.
async function scenarioPublicFactory(t) {
  const f = createFixture(t, 'd');
  const beforeChildren = new Set(directChildren(process.pid));
  const beforeTimers = process.getActiveResourcesInfo().filter(type => type === 'Timeout').length;
  const ownedChildren = [];
  let handle = null;
  try {
    handle = await createSentinelHost({ agentDir: f.agentDir, root: f.root, port: 0, scope: SCOPE });
    const receipt = handle.receipt;
    assert.equal(receipt.type, 'ready');
    assert.equal(receipt.state, 'observing');
    assert.match(receipt.dashboard_url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const snapshot = JSON.parse(readFileSync(receipt.snapshot_path, 'utf8'));
    assert.equal(snapshot.state, 'observing');

    for (const pid of directChildren(process.pid)) {
      if (beforeChildren.has(pid)) continue;
      const identity = describeProcess(pid);
      if (identity) ownedChildren.push(identity);
    }
    assert.ok(ownedChildren.length >= 2, 'the public factory owns real reader and dashboard children');

    assert.equal(handle.close(), handle.close(), 'two close callers share one promise');
    await handle.close();
    handle = null;

    assert.equal(JSON.parse(readFileSync(receipt.snapshot_path, 'utf8')).state, 'closed');
    for (const identity of ownedChildren) {
      assert.equal(sameProcess(identity), false, `owned child ${identity.pid} exited`);
    }
    const afterTimers = process.getActiveResourcesInfo().filter(type => type === 'Timeout').length;
    assert.ok(afterTimers <= beforeTimers, `no lifetime timer remains after close (before ${beforeTimers}, after ${afterTimers})`);
  } finally {
    if (handle) {
      try { await withDeadline(handle.close(), SHUTDOWN_TIMEOUT_MS, 'factory close'); } catch { /* reported by the case */ }
    }
    // Only proven identities belonging to this factory are stopped.
    for (const identity of ownedChildren) {
      if (sameProcess(identity)) { try { process.kill(identity.pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  }
}

test('scenario A and scenario B real host journeys', { concurrency: 2 }, async t => {
  await Promise.all([
    t.test('scenario A: public host preserves observation, locality and singleton ownership across signal shutdown', t => scenarioOrdinaryPublicHost(t)),
    t.test('scenario B: an occupied default port leaves observation running while ownership releases', t => scenarioOccupiedDefaultPort(t)),
  ]);
});

test('scenario C: import is inert and invalid argv/root/publicHost refuse before effects', async t => {
  await scenarioInvalidInputs(t);
});

test('scenario D: the public factory composes real resources and one shared close', async t => {
  await scenarioPublicFactory(t);
});
