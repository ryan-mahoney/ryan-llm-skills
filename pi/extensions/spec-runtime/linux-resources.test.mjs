import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_WAVE_TIMEOUT_MS,
  GIB,
  HOST_REMEDIES,
  MIB,
  calculateResourcePolicy,
  checkRuntimeHost,
  createSystemdServiceAdapter,
  createWaveDeadline,
  deadlineRemainingMs,
  isSystemdServiceRecord,
  resolveEffectiveUserBusEnvironment,
  runtimeHostCommand,
  runtimeMaxSecFor,
  setupRuntimeHost,
  tagPosixProcessRecord,
} from './linux-resources.mjs';

const CASE_TIMEOUT_MS = 120_000;

function policy(overrides = {}) {
  return calculateResourcePolicy({ physicalMemoryBytes: 30 * GIB, cpuCount: 8, ...overrides });
}

// Disposable runtime-dir fixture: <base>/<uid> at the requested mode plus an
// optional listening unix socket named bus. Cleanup is owned by the test.
async function runtimeFixture(t, { mode = 0o700, socket = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'wave-resources-'));
  const uid = process.geteuid();
  const dir = join(base, String(uid));
  mkdirSync(dir, { mode });
  chmodSync(dir, mode);
  const socketPath = join(dir, 'bus');
  let server = null;
  if (socket) {
    server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
  }
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(() => resolve()));
    rmSync(base, { recursive: true, force: true });
  });
  return { base, uid, dir, socketPath };
}

test('wave resources: exact 30 GiB sizing admits seven memory and eight task slots', { timeout: CASE_TIMEOUT_MS }, () => {
  const result = policy();
  assert.equal(result.poolMemoryBytes, 21 * GIB);
  assert.equal(result.poolReserveBytes, 9 * GIB);
  assert.equal(result.poolReserveSource, 'percent-30');
  assert.deepEqual(result.slots, { memory: 7, tasks: 8 });
  assert.equal(result.admittedWidth, 7);
  assert.equal(result.binding, 'memory');
  assert.deepEqual(result.bindings, ['memory']);
  assert.equal(result.softwareCeiling, 16);
  assert.equal(result.lifecycleMemoryMib, 3072);
  assert.equal(result.lifecycleMemoryBytes, 3072 * MIB);
  assert.equal(result.lifecycleTasks, 512);
  assert.equal(result.aggregateTasks, 4096);
  assert.equal(result.memoryHighBytes, Math.floor((3072 * MIB * 80) / 100));
  assert.equal(result.memorySwapMaxBytes, 0);
  assert.equal(result.cpuQuotaPercent, 600);
  assert.equal(result.cpuWeight, 50);
  assert.equal(result.provenance.lifecycleMemoryMib, 'default');
  assert.equal(result.provenance.lifecycleTasks, 'default');
  assert.equal(result.provenance.aggregateTasks, 'default');
  assert.equal(result.provenance.explicitCap, 'absent');
});

test('wave resources: lowering memory alone leaves the task ceiling binding at eight', { timeout: CASE_TIMEOUT_MS }, () => {
  const result = policy({ lifecycleMemoryMib: 2048 });
  assert.deepEqual(result.slots, { memory: 10, tasks: 8 });
  assert.equal(result.admittedWidth, 8);
  assert.equal(result.binding, 'tasks');
  assert.equal(result.provenance.lifecycleMemoryMib, 'explicit');
});

test('wave resources: 2048 MiB lifecycles and 384 tasks admit ten', { timeout: CASE_TIMEOUT_MS }, () => {
  const result = policy({ lifecycleMemoryMib: 2048, lifecycleTasks: 384 });
  assert.deepEqual(result.slots, { memory: 10, tasks: 10 });
  assert.equal(result.admittedWidth, 10);
  assert.ok(result.bindings.includes('memory'));
  assert.ok(result.bindings.includes('tasks'));
});

test('wave resources: explicit cap, held reservations, ready count and ancestor limits bind admission', { timeout: CASE_TIMEOUT_MS }, () => {
  const capped = policy({ explicitCap: 5 });
  assert.equal(capped.admittedWidth, 5);
  assert.equal(capped.binding, 'explicit-cap');
  assert.equal(capped.provenance.explicitCap, 'explicit');

  const heldMemory = policy({ held: { memoryBytes: 12 * GIB, tasks: 0 } });
  assert.equal(heldMemory.free.memoryBytes, 9 * GIB);
  assert.equal(heldMemory.slots.memory, 3);
  assert.equal(heldMemory.admittedWidth, 3);
  assert.equal(heldMemory.binding, 'memory');

  const heldTasks = policy({ held: { memoryBytes: 0, tasks: 1024 } });
  assert.equal(heldTasks.free.tasks, 3072);
  assert.equal(heldTasks.slots.tasks, 6);
  assert.equal(heldTasks.admittedWidth, 6);
  assert.equal(heldTasks.binding, 'tasks');

  const ancestorMemory = policy({ ancestorLimits: { memoryBytes: 6 * GIB } });
  assert.equal(ancestorMemory.limits.memoryBytes, 6 * GIB);
  assert.equal(ancestorMemory.slots.memory, 2);
  assert.equal(ancestorMemory.admittedWidth, 2);
  assert.equal(ancestorMemory.provenance.ancestorLimits, 'explicit');

  const ancestorTasks = policy({ ancestorLimits: { tasks: 1024 } });
  assert.equal(ancestorTasks.limits.tasks, 1024);
  assert.equal(ancestorTasks.slots.tasks, 2);
  assert.equal(ancestorTasks.admittedWidth, 2);

  const ready = policy({ readyMembers: 4 });
  assert.equal(ready.admittedWidth, 4);
  assert.equal(ready.binding, 'ready');

  const spacious = policy({ physicalMemoryBytes: 96 * GIB, aggregateTasks: 12_288, readyMembers: 100 });
  assert.equal(spacious.admittedWidth, 16);
  assert.equal(spacious.binding, 'software-ceiling');

  const oversizedCap = policy({ physicalMemoryBytes: 96 * GIB, aggregateTasks: 12_288, explicitCap: 32, readyMembers: 100 });
  assert.equal(oversizedCap.admittedWidth, 16);
  assert.equal(oversizedCap.binding, 'software-ceiling');
});

test('wave resources: invalid budgets and impossible capacity refuse', { timeout: CASE_TIMEOUT_MS }, () => {
  const host = { physicalMemoryBytes: 30 * GIB, cpuCount: 8 };
  assert.throws(() => calculateResourcePolicy({ ...host, lifecycleMemoryMib: 0 }), /lifecycleMemoryMib/);
  assert.throws(() => calculateResourcePolicy({ ...host, lifecycleMemoryMib: 1.5 }), /lifecycleMemoryMib/);
  assert.throws(() => calculateResourcePolicy({ ...host, lifecycleMemoryMib: '3072' }), /lifecycleMemoryMib/);
  assert.throws(() => calculateResourcePolicy({ ...host, lifecycleTasks: -1 }), /lifecycleTasks/);
  assert.throws(() => calculateResourcePolicy({ ...host, aggregateTasks: 0 }), /aggregateTasks/);
  assert.throws(() => calculateResourcePolicy({ ...host, explicitCap: 0 }), /explicitCap/);
  assert.throws(() => calculateResourcePolicy({ ...host, readyMembers: -1 }), /readyMembers/);
  assert.throws(() => calculateResourcePolicy({ ...host, held: { memoryBytes: -1 } }), /held.memoryBytes/);
  assert.throws(() => calculateResourcePolicy({ ...host, held: { tasks: 1.5 } }), /held.tasks/);
  assert.throws(() => calculateResourcePolicy({ ...host, ancestorLimits: { memoryBytes: 0 } }), /ancestorLimits.memoryBytes/);
  assert.throws(() => calculateResourcePolicy({ physicalMemoryBytes: 4 * GIB, cpuCount: 2 }), /insufficient/);
  assert.throws(() => calculateResourcePolicy({ physicalMemoryBytes: 6 * GIB, cpuCount: 2 }), /does not fit: free memory/);
  assert.throws(() => calculateResourcePolicy({ ...host, aggregateTasks: 256 }), /does not fit: free task budget/);
  assert.throws(() => calculateResourcePolicy({ ...host, ancestorLimits: { memoryBytes: 2 * GIB } }), /does not fit: free memory/);
  assert.throws(() => calculateResourcePolicy({ ...host, ancestorLimits: { tasks: 256 } }), /does not fit: free task budget/);
  const exhausted = calculateResourcePolicy({ ...host, held: { memoryBytes: 22 * GIB } });
  assert.equal(exhausted.admittedWidth, 0);
  assert.throws(() => calculateResourcePolicy({ ...host, held: { memoryBytes: 22 * GIB }, lifecycleMemoryMib: 32768 }), /does not fit: free memory/);
});

test('wave resources: wave deadlines default, derive remaining seconds and refuse expiry', { timeout: CASE_TIMEOUT_MS }, () => {
  const startedAtMs = 1_700_000_000_000;
  const deadline = createWaveDeadline({ startedAtMs });
  assert.deepEqual(deadline, {
    started_at: startedAtMs,
    timeout_ms: DEFAULT_WAVE_TIMEOUT_MS,
    expires_at: startedAtMs + DEFAULT_WAVE_TIMEOUT_MS,
  });
  assert.equal(deadlineRemainingMs(deadline, startedAtMs + 1000), DEFAULT_WAVE_TIMEOUT_MS - 1000);
  assert.equal(runtimeMaxSecFor(deadline, startedAtMs + 1000), 7199);
  assert.equal(runtimeMaxSecFor(deadline, deadline.expires_at - 1), 1);
  assert.throws(() => runtimeMaxSecFor(deadline, deadline.expires_at), /expired|refused/);
  assert.throws(() => runtimeMaxSecFor(deadline, deadline.expires_at + 60_000), /expired|refused/);

  // A shorter explicit deadline derives its own remaining seconds; deriving a
  // phase budget never rewrites the persisted expires_at.
  const short = createWaveDeadline({ startedAtMs, timeoutMs: 30_000 });
  assert.equal(short.timeout_ms, 30_000);
  assert.equal(runtimeMaxSecFor(short, startedAtMs + 29_500), 1);
  assert.equal(short.expires_at, startedAtMs + 30_000);

  assert.throws(() => createWaveDeadline({ startedAtMs, timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => createWaveDeadline({ startedAtMs, timeoutMs: -5 }), /timeoutMs/);
  assert.throws(() => createWaveDeadline({ startedAtMs, timeoutMs: 1.5 }), /timeoutMs/);
  assert.throws(() => createWaveDeadline({ startedAtMs, timeoutMs: Number.POSITIVE_INFINITY }), /timeoutMs/);
  assert.throws(() => createWaveDeadline({ startedAtMs, timeoutMs: '7200000' }), /timeoutMs/);
  assert.throws(() => runtimeMaxSecFor({ expires_at: 1.5 }, 0), /expires_at/);
});

test('wave resources: absent variables derive the effective-user runtime dir and bus', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await runtimeFixture(t);
  const resolved = resolveEffectiveUserBusEnvironment({ env: {}, uid: fixture.uid, runtimeDirBase: fixture.base });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.status, 'ready');
  assert.equal(resolved.xdgRuntimeDir.path, fixture.dir);
  assert.equal(resolved.xdgRuntimeDir.source, 'derived');
  assert.equal(resolved.dbusSessionBusAddress.value, `unix:path=${fixture.socketPath}`);
  assert.equal(resolved.dbusSessionBusAddress.source, 'derived');
  assert.equal(resolved.environment.XDG_RUNTIME_DIR, fixture.dir);
  assert.equal(resolved.environment.DBUS_SESSION_BUS_ADDRESS, `unix:path=${fixture.socketPath}`);
  assert.deepEqual(Object.keys(resolved.environment).sort(), ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']);
});

test('wave resources: explicit runtime dir and bus values are validated and preserved', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await runtimeFixture(t);
  const both = resolveEffectiveUserBusEnvironment({
    env: { XDG_RUNTIME_DIR: fixture.dir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${fixture.socketPath}` },
    uid: fixture.uid,
    runtimeDirBase: fixture.base,
  });
  assert.equal(both.ok, true);
  assert.equal(both.xdgRuntimeDir.source, 'explicit');
  assert.equal(both.dbusSessionBusAddress.source, 'explicit');
  assert.equal(both.environment.XDG_RUNTIME_DIR, fixture.dir);
  assert.equal(both.environment.DBUS_SESSION_BUS_ADDRESS, `unix:path=${fixture.socketPath}`);

  // Explicit runtime dir with an absent bus still derives the bus inside it.
  const derivedBus = resolveEffectiveUserBusEnvironment({ env: { XDG_RUNTIME_DIR: fixture.dir }, uid: fixture.uid, runtimeDirBase: fixture.base });
  assert.equal(derivedBus.ok, true);
  assert.equal(derivedBus.sources.XDG_RUNTIME_DIR, 'explicit');
  assert.equal(derivedBus.sources.DBUS_SESSION_BUS_ADDRESS, 'derived');
  assert.equal(derivedBus.dbusSessionBusAddress.value, `unix:path=${fixture.socketPath}`);
});

test('wave resources: foreign or invalid environment refuses with an exact remedy', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await runtimeFixture(t);

  const foreignOwner = resolveEffectiveUserBusEnvironment({ env: { XDG_RUNTIME_DIR: fixture.dir }, uid: fixture.uid + 1, runtimeDirBase: fixture.base });
  assert.equal(foreignOwner.ok, false);
  assert.equal(foreignOwner.status, 'refused');
  assert.equal(foreignOwner.reason, 'foreign-owner');
  assert.match(foreignOwner.remedy, /XDG_RUNTIME_DIR/);

  chmodSync(fixture.dir, 0o755);
  const notPrivate = resolveEffectiveUserBusEnvironment({ env: { XDG_RUNTIME_DIR: fixture.dir }, uid: fixture.uid, runtimeDirBase: fixture.base });
  assert.equal(notPrivate.ok, false);
  assert.equal(notPrivate.reason, 'not-private');
  assert.match(notPrivate.remedy, /private/);
  chmodSync(fixture.dir, 0o700);

  const regularFile = join(fixture.dir, 'regular');
  writeFileSync(regularFile, '');
  const notADirectory = resolveEffectiveUserBusEnvironment({ env: { XDG_RUNTIME_DIR: regularFile }, uid: fixture.uid, runtimeDirBase: fixture.base });
  assert.equal(notADirectory.ok, false);
  assert.equal(notADirectory.reason, 'not-a-directory');

  const notASocket = resolveEffectiveUserBusEnvironment({
    env: { XDG_RUNTIME_DIR: fixture.dir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${regularFile}` },
    uid: fixture.uid,
    runtimeDirBase: fixture.base,
  });
  assert.equal(notASocket.ok, false);
  assert.equal(notASocket.reason, 'not-a-socket');
  assert.match(notASocket.remedy, /DBUS_SESSION_BUS_ADDRESS/);

  const unsupportedAddress = resolveEffectiveUserBusEnvironment({
    env: { XDG_RUNTIME_DIR: fixture.dir, DBUS_SESSION_BUS_ADDRESS: 'tcp:host=localhost' },
    uid: fixture.uid,
    runtimeDirBase: fixture.base,
  });
  assert.equal(unsupportedAddress.ok, false);
  assert.equal(unsupportedAddress.reason, 'invalid-address');

  const relativeXdg = resolveEffectiveUserBusEnvironment({ env: { XDG_RUNTIME_DIR: 'relative/runtime' }, uid: fixture.uid, runtimeDirBase: fixture.base });
  assert.equal(relativeXdg.ok, false);
  assert.equal(relativeXdg.reason, 'not-absolute');

  const missingBase = mkdtempSync(join(tmpdir(), 'wave-resources-missing-'));
  t.after(() => rmSync(missingBase, { recursive: true, force: true }));
  const missingDir = resolveEffectiveUserBusEnvironment({ env: {}, uid: fixture.uid, runtimeDirBase: missingBase });
  assert.equal(missingDir.ok, false);
  assert.equal(missingDir.status, 'setup-required');
  assert.equal(missingDir.reason, 'missing');
  assert.match(missingDir.remedy, /loginctl|user manager/);

  const noBus = await runtimeFixture(t, { socket: false });
  const missingSocket = resolveEffectiveUserBusEnvironment({ env: {}, uid: noBus.uid, runtimeDirBase: noBus.base });
  assert.equal(missingSocket.ok, false);
  assert.equal(missingSocket.status, 'setup-required');
  assert.equal(missingSocket.reason, 'missing');
  assert.match(missingSocket.remedy, /session bus|user systemd/);
});

// ---------------------------------------------------------------------------
// Host check/setup fixtures. The cgroup tree, runtime directory, unix socket
// and bwrap executable are real files; only the external command transport is
// substituted, so emitted command strings and host paths stay representative.
// ---------------------------------------------------------------------------

const HOST_POOL_BYTES = 21 * GIB; // 30 GiB physical - 9 GiB reserve
const HOST_PROPERTY_LINES = Object.freeze([
  'MemoryMax=infinity',
  'MemoryHigh=infinity',
  'MemorySwapMax=infinity',
  'TasksMax=infinity',
  'CPUQuotaPerSecUSec=infinity',
  'CPUWeight=100',
  'RuntimeMaxUSec=infinity',
]);
const HOST_SLICE_VALUES = Object.freeze({
  MemoryMax: String(HOST_POOL_BYTES),
  MemoryHigh: String(Math.floor((HOST_POOL_BYTES * 80) / 100)),
  MemorySwapMax: '0',
  TasksMax: '4096',
  CPUQuotaPerSecUSec: '6s',
  CPUWeight: '50',
});
const BWRAP_HELP = [
  'usage: bwrap [OPTIONS...] [COMMAND]',
  '  --overlay SRC DEST',
  '  --overlay-src SRC',
  '  --overlay-sock SOCKET',
  '  --ro-overlay DIR DEST',
  '  --tmp-overlay DIR DEST',
].join('\n');

// Real tree: <base>/cgroup/{user.slice/user-<uid>.slice/user@<uid>.service}
// plus <base>/run/<uid>/bus and <base>/bin/bwrap.
async function hostFixture(t, { hostControllers = 'cpu memory pids', managerControllers = 'cpu memory pids', managerSubtree = '+cpu +memory +pids', socket = true, bwrap = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'wave-host-'));
  const uid = process.geteuid();
  const cgroupRoot = join(base, 'cgroup');
  const userSlice = join(cgroupRoot, 'user.slice');
  const uidSlice = join(userSlice, `user-${uid}.slice`);
  const managerPath = join(uidSlice, `user@${uid}.service`);
  const runtimeBase = join(base, 'run');
  const runtimeDir = join(runtimeBase, String(uid));
  const binDir = join(base, 'bin');
  const configHome = join(base, 'config');
  for (const dir of [cgroupRoot, userSlice, uidSlice, managerPath, binDir]) mkdirSync(dir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
  // The cgroup-v2 hierarchy root does not expose resource-limit files.
  for (const dir of [userSlice, uidSlice, managerPath]) {
    writeFileSync(join(dir, 'memory.max'), 'max\n');
    writeFileSync(join(dir, 'pids.max'), 'max\n');
  }
  writeFileSync(join(cgroupRoot, 'cgroup.controllers'), `${hostControllers}\n`);
  writeFileSync(join(managerPath, 'cgroup.controllers'), `${managerControllers}\n`);
  writeFileSync(join(managerPath, 'cgroup.subtree_control'), `${managerSubtree}\n`);
  const socketPath = join(runtimeDir, 'bus');
  let server = null;
  if (socket) {
    server = net.createServer();
    t.after(() => new Promise(resolve => server.close(() => resolve())));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
  }
  const bwrapPath = join(binDir, 'bwrap');
  if (bwrap) writeFileSync(bwrapPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, uid, cgroupRoot, managerPath, runtimeBase, runtimeDir, socketPath, bwrapPath, configHome };
}

// Substituted transport: records every command and answers the systemctl,
// systemd-run, flock and bwrap invocations the host check composes.
function hostTransport(fixture, {
  version = 'systemd 255 (255.4-1)\n',
  propertyLines = HOST_PROPERTY_LINES,
  propertyStderr = '',
  utilityMissing = null,
  managerUnreachable = false,
  probeAccepted = true,
  sliceValues = null,
  listUnits = '',
  bwrapAvailable = true,
  daemonReloadFails = false,
} = {}) {
  const calls = [];
  const run = async ({ command, args = [], env = {} }) => {
    calls.push({ command, args: [...args], env: { ...env }, key: [command, ...args].join(' ') });
    if (utilityMissing !== null && command === utilityMissing) {
      return { exitCode: null, signal: null, errorCode: 'ENOENT', stdout: '', stderr: `${command}: not found\n` };
    }
    if (command === fixture.bwrapPath) {
      if (!bwrapAvailable) return { exitCode: null, signal: null, errorCode: 'ENOENT', stdout: '', stderr: '' };
      if (args.includes('--version')) return { exitCode: 0, signal: null, stdout: 'bubblewrap 0.11.0\n', stderr: '' };
      return { exitCode: 0, signal: null, stdout: `${BWRAP_HELP}\n`, stderr: '' };
    }
    if (command === 'systemd-run') {
      if (args.includes('--version')) return { exitCode: 0, signal: null, stdout: 'systemd 255\n', stderr: '' };
      return probeAccepted
        ? { exitCode: 0, signal: null, stdout: '', stderr: '' }
        : { exitCode: 1, signal: null, stdout: '', stderr: 'Failed to start transient service unit: Invalid argument\n' };
    }
    if (command === 'flock') return { exitCode: 0, signal: null, stdout: 'flock from util-linux 2.39\n', stderr: '' };
    if (command === 'systemctl') {
      if (args.includes('--version')) return { exitCode: 0, signal: null, stdout: 'systemd 255\n', stderr: '' };
      if (args.includes('daemon-reload')) {
        return daemonReloadFails
          ? { exitCode: 1, signal: null, stdout: '', stderr: 'Failed to connect to bus: No such file or directory\n' }
          : { exitCode: 0, signal: null, stdout: '', stderr: '' };
      }
      if (args.includes('list-units')) return { exitCode: 0, signal: null, stdout: listUnits, stderr: '' };
      if (args.includes('--property=Version')) {
        return managerUnreachable
          ? { exitCode: 1, signal: null, stdout: '', stderr: 'Failed to connect to bus: No such file or directory\n' }
          : { exitCode: 0, signal: null, stdout: version, stderr: '' };
      }
      if (args.includes('spec-runtime.slice')) {
        const values = sliceValues ?? HOST_SLICE_VALUES;
        const stdout = args
          .filter(arg => arg.startsWith('--property='))
          .map(arg => arg.slice('--property='.length))
          .filter(name => values[name] !== undefined)
          .map(name => `${name}=${values[name]}`)
          .join('\n');
        return { exitCode: 0, signal: null, stdout: `${stdout}\n`, stderr: '' };
      }
      if (args.includes('-.slice') || args.includes('--property=MemoryMax')) {
        return { exitCode: 0, signal: null, stdout: `${propertyLines.join('\n')}\n`, stderr: propertyStderr };
      }
    }
    return { exitCode: 1, signal: null, stdout: '', stderr: `unhandled test command: ${command} ${args.join(' ')}\n` };
  };
  return { run, calls };
}

function hostOptions(fixture, run, overrides = {}) {
  return {
    env: { XDG_CONFIG_HOME: fixture.configHome },
    run,
    platform: 'linux',
    cgroupRoot: fixture.cgroupRoot,
    userManagerCgroup: fixture.managerPath,
    runtimeDirBase: fixture.runtimeBase,
    bwrapPath: fixture.bwrapPath,
    physicalMemoryBytes: 30 * GIB,
    cpuCount: 8,
    timeoutMs: 20_000,
    probeTimeoutMs: 120_000,
    ...overrides,
  };
}

function setupOptions(fixture, run, overrides = {}) {
  return {
    ...hostOptions(fixture, run),
    env: { XDG_CONFIG_HOME: fixture.configHome },
    ownership: { inspectClaims: async () => ({ claims: [] }) },
    ...overrides,
  };
}

test('wave resources: host check derives the bus, stays read-only and reports the probe remedy', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const { run, calls } = hostTransport(fixture);
  const result = await checkRuntimeHost(hostOptions(fixture, run));
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.route, 'native');
  assert.equal(result.reason, 'probe-required');
  assert.equal(result.remedy, HOST_REMEDIES['probe-required']);
  assert.equal(result.properties.status, 'supported');
  assert.equal(result.properties.source, 'read');
  assert.equal(result.overlay.status, 'unprobed');
  assert.equal(result.bus.xdgRuntimeDir.path, fixture.runtimeDir);
  assert.equal(result.bus.dbusSessionBusAddress.socketPath, fixture.socketPath);
  assert.equal(Object.hasOwn(result.bus, 'environment'), false);
  assert.equal(Object.hasOwn(result.bus.dbusSessionBusAddress, 'value'), false);
  assert.equal(result.cgroup.blocked, null);
  assert.ok(!calls.some(call => call.command === 'systemd-run' && !call.args.includes('--version')), 'check must not probe without an explicit probe request');
  assert.ok(!calls.some(call => call.args.includes('daemon-reload')), 'check must not reload the manager');
  for (const call of calls.filter(item => item.command === 'systemctl')) {
    assert.equal(call.env.XDG_RUNTIME_DIR, fixture.runtimeDir);
    assert.equal(call.env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${fixture.socketPath}`);
  }
});

test('wave resources: host check refuses a missing utility with the exact remedy', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const { run } = hostTransport(fixture, { utilityMissing: 'flock' });
  const result = await checkRuntimeHost(hostOptions(fixture, run));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'utilities');
  assert.equal(result.remedy, HOST_REMEDIES.utilities);
});

test('wave resources: host check reports an unreachable user manager with the exact remedy', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const { run } = hostTransport(fixture, { managerUnreachable: true });
  const result = await checkRuntimeHost(hostOptions(fixture, run));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'manager-unreachable');
  assert.equal(result.remedy, HOST_REMEDIES['manager-unreachable']);
});

test('wave resources: host check refuses missing and undelegated controllers with exact remedies', { timeout: CASE_TIMEOUT_MS }, async t => {
  const missingFixture = await hostFixture(t, { hostControllers: 'cpu pids' });
  const missing = await checkRuntimeHost(hostOptions(missingFixture, hostTransport(missingFixture).run));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'controller-missing');
  assert.equal(missing.remedy, HOST_REMEDIES['controller-missing']);
  const undelegatedFixture = await hostFixture(t, { managerControllers: 'cpu pids', managerSubtree: '+cpu +pids' });
  const undelegated = await checkRuntimeHost(hostOptions(undelegatedFixture, hostTransport(undelegatedFixture).run));
  assert.equal(undelegated.ok, false);
  assert.equal(undelegated.reason, 'controller-not-delegated');
  assert.equal(undelegated.remedy, HOST_REMEDIES['controller-not-delegated']);
});

test('wave resources: host probe proves unit properties even when bubblewrap is absent', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const { run, calls } = hostTransport(fixture, { bwrapAvailable: false });
  const result = await checkRuntimeHost(hostOptions(fixture, run, { probe: true }));
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.reason, 'bwrap-absent');
  assert.equal(result.remedy, HOST_REMEDIES['bwrap-absent']);
  assert.equal(result.properties.source, 'probe');
  assert.equal(result.properties.status, 'supported');
  assert.equal(result.overlay.status, 'not-probed');
  assert.equal(result.bwrap.present, false);
  assert.equal(result.route, 'worktree');
  assert.ok(calls.some(call => call.command === 'systemd-run' && !call.args.includes('--version')));
});

test('wave resources: host check keeps unproven unit properties probe-required', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const propertyLines = HOST_PROPERTY_LINES.filter(line => !line.startsWith('TasksMax='));
  const { run } = hostTransport(fixture, { propertyLines });
  const result = await checkRuntimeHost(hostOptions(fixture, run));
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.reason, 'probe-required');
  assert.equal(result.remedy, HOST_REMEDIES['probe-required']);
  assert.notEqual(result.properties.status, 'supported');
  assert.ok([...(result.properties.unverified ?? []), ...(result.properties.unsupported ?? [])].includes('TasksMax'));
});

test('wave resources: a failing probe refuses the unit property set with the exact remedy', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const { run, calls } = hostTransport(fixture, { probeAccepted: false });
  const result = await checkRuntimeHost(hostOptions(fixture, run, { probe: true }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'property-unsupported');
  assert.equal(result.remedy, HOST_REMEDIES['property-unsupported']);
  assert.equal(result.properties.source, 'probe');
  assert.equal(result.properties.status, 'unsupported');
  assert.equal(result.properties.unsupported.length, 7);
  assert.ok(result.properties.unsupported.includes('CPUQuota'));
  assert.ok(calls.some(call => call.args.includes('--property=CPUQuotaPerSecUSec')), 'read phase queries the runtime property name');
  assert.ok(calls.some(call => call.args.includes('--property=RuntimeMaxUSec')));
  assert.ok(!calls.some(call => call.args.includes('--property=CPUQuota')));
  assert.ok(!calls.some(call => call.args.includes('--property=RuntimeMaxSec')));
});

test('wave resources: host check blocks unreadable and invalid ancestor limits', { timeout: CASE_TIMEOUT_MS }, async t => {
  const unreadableFixture = await hostFixture(t);
  rmSync(join(unreadableFixture.cgroupRoot, 'user.slice', `user-${unreadableFixture.uid}.slice`, 'memory.max'));
  const unreadable = await checkRuntimeHost(hostOptions(unreadableFixture, hostTransport(unreadableFixture).run));
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.status, 'refused');
  assert.equal(unreadable.reason, 'cgroup-unreadable');
  assert.equal(unreadable.remedy, HOST_REMEDIES['cgroup-unreadable']);
  assert.equal(unreadable.cgroup.blocked, 'cgroup-unreadable');
  const invalidFixture = await hostFixture(t);
  writeFileSync(join(invalidFixture.cgroupRoot, 'user.slice', `user-${invalidFixture.uid}.slice`, 'memory.max'), 'many\n');
  const invalid = await checkRuntimeHost(hostOptions(invalidFixture, hostTransport(invalidFixture).run));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, 'refused');
  assert.equal(invalid.reason, 'cgroup-limit-invalid');
  assert.equal(invalid.remedy, HOST_REMEDIES['cgroup-limit-invalid']);
  assert.equal(invalid.cgroup.blocked, 'cgroup-limit-invalid');
});

test('wave resources: host check refuses a manager path outside the cgroup root', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const outside = join(fixture.base, 'outside-service');
  mkdirSync(outside, { recursive: true });
  const result = await checkRuntimeHost(hostOptions(fixture, hostTransport(fixture).run, { userManagerCgroup: outside }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'cgroup-path-outside-root');
  assert.equal(result.remedy, HOST_REMEDIES['cgroup-path-outside-root']);
});

test('wave resources: host check never reports passed bus credentials', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const { run } = hostTransport(fixture);
  const env = { XDG_RUNTIME_DIR: fixture.runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${fixture.socketPath}` };
  const result = await checkRuntimeHost(hostOptions(fixture, run, { env }));
  assert.equal(result.bus.status, 'ready');
  assert.equal(result.bus.xdgRuntimeDir.path, fixture.runtimeDir);
  assert.equal(result.bus.dbusSessionBusAddress.socketPath, fixture.socketPath);
  assert.equal(Object.hasOwn(result.bus, 'environment'), false);
  assert.equal(Object.hasOwn(result.bus.dbusSessionBusAddress, 'value'), false);
});

test('wave resources: setup installs the owned policy and slice atomically and verifies the slice', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const { run, calls } = hostTransport(fixture, { bwrapAvailable: false });
  const first = await setupRuntimeHost(setupOptions(fixture, run));
  assert.equal(first.ok, true);
  assert.equal(first.status, 'ready');
  assert.equal(first.reason, 'installed');
  assert.equal(first.installed.policy, 'written');
  assert.equal(first.installed.slice, 'written');
  assert.equal(first.installed.daemonReload, 'reloaded');
  assert.equal(first.installed.verified, true);
  const policyStat = statSync(first.paths.policyPath);
  assert.equal(policyStat.mode & 0o777, 0o600);
  assert.equal(statSync(first.paths.slicePath).mode & 0o777, 0o644);
  const stored = JSON.parse(readFileSync(first.paths.policyPath, 'utf8'));
  assert.equal(stored.schema, 'spec-runtime-host-policy/v1');
  assert.equal(stored.owner, 'spec-runtime');
  assert.equal(stored.aggregate.memoryMaxBytes, HOST_POOL_BYTES);
  assert.equal(stored.aggregate.memoryHighBytes, Math.floor((HOST_POOL_BYTES * 80) / 100));
  assert.equal(stored.aggregate.memorySwapMaxBytes, 0);
  assert.equal(stored.aggregate.tasksMax, 4096);
  assert.equal(stored.lifecycle.memoryBytes, 3072 * MIB);
  const slice = readFileSync(first.paths.slicePath, 'utf8');
  assert.ok(slice.includes('# spec-runtime-host-slice/v1'));
  assert.ok(slice.includes(`MemoryMax=${HOST_POOL_BYTES}`));
  assert.ok(slice.includes('CPUQuota=600%'));
  assert.ok(slice.includes('CPUWeight=50'));
  assert.ok(calls.some(call => call.command === 'systemd-run' && !call.args.includes('--version')), 'setup always runs the bounded property probe');
  assert.ok(calls.some(call => call.args.includes('daemon-reload')));
  assert.ok(calls.some(call => call.args.includes('spec-runtime.slice')));
  const inode = policyStat.ino;
  const second = await setupRuntimeHost(setupOptions(fixture, run));
  assert.equal(second.ok, true);
  assert.equal(second.reason, 'unchanged');
  assert.equal(second.installed.policy, 'unchanged');
  assert.equal(second.installed.slice, 'unchanged');
  assert.equal(second.installed.daemonReload, 'not-needed');
  assert.equal(statSync(second.paths.policyPath).ino, inode, 'identical policy content is never rewritten');
});

test('wave resources: setup refuses foreign and symlinked owned targets before writing', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const { run } = hostTransport(fixture, { bwrapAvailable: false });
  const root = join(fixture.configHome, 'spec-runtime');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'host-policy.json'), '{"schema":"someone-else/v1"}\n');
  const foreign = await setupRuntimeHost(setupOptions(fixture, run));
  assert.equal(foreign.ok, false);
  assert.equal(foreign.status, 'refused');
  assert.equal(foreign.reason, 'foreign-target');
  assert.equal(foreign.remedy, HOST_REMEDIES['foreign-target']);
  assert.equal(readFileSync(join(root, 'host-policy.json'), 'utf8'), '{"schema":"someone-else/v1"}\n');
  assert.equal(statSync(foreign.paths.slicePath, { throwIfNoEntry: false }), undefined, 'nothing is installed beside a foreign target');
  rmSync(join(root, 'host-policy.json'));
  const unitDir = join(fixture.configHome, 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'target.txt'), 'x\n');
  symlinkSync(join(unitDir, 'target.txt'), join(unitDir, 'spec-runtime.slice'));
  const symlinked = await setupRuntimeHost(setupOptions(fixture, run));
  assert.equal(symlinked.ok, false);
  assert.equal(symlinked.reason, 'symlink-target');
  assert.equal(symlinked.remedy, HOST_REMEDIES['symlink-target']);
  assert.equal(readFileSync(join(unitDir, 'target.txt'), 'utf8'), 'x\n');
});

test('wave resources: setup refuses a policy change while claims or services are live', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const runWith = listUnits => hostTransport(fixture, { bwrapAvailable: false, listUnits }).run;
  const first = await setupRuntimeHost(setupOptions(fixture, runWith('')));
  assert.equal(first.ok, true);
  const before = readFileSync(first.paths.policyPath, 'utf8');
  const claimed = await setupRuntimeHost(setupOptions(fixture, runWith(''), {
    aggregateTasks: 8192,
    ownership: { inspectClaims: async () => ({ claims: [{ kind: 'capacity' }, { kind: 'checkout' }] }) },
  }));
  assert.equal(claimed.ok, false);
  assert.equal(claimed.reason, 'claims-active');
  assert.equal(claimed.remedy, HOST_REMEDIES['claims-active']);
  assert.equal(readFileSync(first.paths.policyPath, 'utf8'), before);
  const active = await setupRuntimeHost(setupOptions(fixture, runWith('spec-runtime-wave@1.service loaded active running\n'), { aggregateTasks: 8192 }));
  assert.equal(active.ok, false);
  assert.equal(active.reason, 'services-active');
  assert.equal(active.remedy, HOST_REMEDIES['services-active']);
  const unknown = await setupRuntimeHost(setupOptions(fixture, runWith('spec-runtime-mystery.service loaded unknown unknown\n'), { aggregateTasks: 8192 }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'services-unknown');
  assert.equal(unknown.remedy, HOST_REMEDIES['services-unknown']);
  const unreadable = await setupRuntimeHost(setupOptions(fixture, runWith(''), {
    aggregateTasks: 8192,
    ownership: { inspectClaims: async () => { throw new Error('registry unreadable'); } },
  }));
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.reason, 'claims-unreadable');
  assert.equal(unreadable.remedy, HOST_REMEDIES['claims-unreadable']);
});

test('wave resources: the slice installs on the user manager search path while policy stays owned', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const { run } = hostTransport(fixture, { bwrapAvailable: false });
  const result = await setupRuntimeHost(setupOptions(fixture, run));
  assert.equal(result.ok, true);
  assert.equal(result.paths.policyPath, join(fixture.configHome, 'spec-runtime', 'host-policy.json'));
  assert.equal(result.paths.slicePath, join(fixture.configHome, 'systemd', 'user', 'spec-runtime.slice'));
  assert.ok(existsSync(result.paths.slicePath), 'the slice is discoverable on the user manager unit search path');
  assert.equal(existsSync(join(fixture.configHome, 'spec-runtime', 'spec-runtime.slice')), false, 'the slice is never hidden inside the policy directory');
});

test('wave resources: a recorded advanced policy survives repeated setup and flagless checks', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const { run } = hostTransport(fixture, { bwrapAvailable: false, sliceValues: { ...HOST_SLICE_VALUES, TasksMax: 2048 } });
  const first = await setupRuntimeHost({ ...setupOptions(fixture, run), lifecycleMemoryMib: 2048, lifecycleTasks: 384, aggregateTasks: 2048 });
  assert.equal(first.ok, true);
  assert.equal(first.policy.lifecycle.memoryMib, 2048);
  const saved = readFileSync(first.paths.policyPath, 'utf8');
  const stored = JSON.parse(saved);
  assert.equal(stored.provenance.lifecycleMemoryMib, 'explicit');
  assert.equal(stored.provenance.lifecycleTasks, 'explicit');
  assert.equal(stored.provenance.aggregateTasks, 'explicit');

  const repeated = await setupRuntimeHost(setupOptions(fixture, run));
  assert.equal(repeated.ok, true);
  assert.equal(repeated.reason, 'unchanged');
  assert.equal(repeated.installed.policy, 'unchanged');
  assert.equal(readFileSync(first.paths.policyPath, 'utf8'), saved, 'a flagless repeated setup never rewrites the recorded policy');

  const checked = await runtimeHostCommand('check', {}, setupOptions(fixture, run));
  assert.equal(checked.exitCode, 0);
  assert.equal(checked.result.ok, true);
  assert.equal(checked.result.policy.lifecycleMemoryMib, 2048);
  assert.equal(checked.result.policy.lifecycleTasks, 384);
  assert.equal(checked.result.policy.aggregateTasks, 2048);
  assert.equal(checked.result.policy.provenance.lifecycleMemoryMib, 'explicit');
  assert.equal(checked.result.policy.provenance.lifecycleTasks, 'explicit');
  assert.equal(checked.result.policy.provenance.aggregateTasks, 'explicit');

  const overridden = await runtimeHostCommand('check', { lifecycleMemoryMib: 4096 }, setupOptions(fixture, run));
  assert.equal(overridden.exitCode, 0);
  assert.equal(overridden.result.policy.lifecycleMemoryMib, 4096);
  assert.equal(overridden.result.policy.lifecycleTasks, 384, 'an explicit flag overrides only its own field');
  assert.equal(overridden.result.policy.aggregateTasks, 2048);
});

test('wave resources: a default setup keeps default provenance for flagless checks', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const { run } = hostTransport(fixture, { bwrapAvailable: false });
  const first = await setupRuntimeHost(setupOptions(fixture, run));
  assert.equal(first.ok, true);
  const checked = await runtimeHostCommand('check', {}, setupOptions(fixture, run));
  assert.equal(checked.exitCode, 0);
  assert.equal(checked.result.policy.lifecycleMemoryMib, 3072);
  assert.equal(checked.result.policy.lifecycleTasks, 512);
  assert.equal(checked.result.policy.aggregateTasks, 4096);
  assert.equal(checked.result.policy.provenance.lifecycleMemoryMib, 'default');
  assert.equal(checked.result.policy.provenance.lifecycleTasks, 'default');
  assert.equal(checked.result.policy.provenance.aggregateTasks, 'default');
});

test('wave resources: a malformed claims envelope refuses every policy change without writing', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const { run } = hostTransport(fixture, { bwrapAvailable: false });
  const first = await setupRuntimeHost(setupOptions(fixture, run));
  assert.equal(first.ok, true);
  const before = readFileSync(first.paths.policyPath, 'utf8');
  const cases = [
    ['claims-unreadable', async () => ({ nope: true })],
    ['claims-unreadable', async () => ({ claims: 'capacity' })],
    ['claims-unreadable', async () => null],
    ['claims-unknown', async () => ({ claims: [{ kind: 'mystery' }] })],
    ['claims-unknown', async () => ({ claims: [null, { kind: 7 }] })],
    ['claims-unknown', async () => ({ claims: [{}, { kind: 'capacity' }] })],
  ];
  for (const [reason, inspectClaims] of cases) {
    const refused = await setupRuntimeHost(setupOptions(fixture, run, { aggregateTasks: 8192, ownership: { inspectClaims } }));
    assert.equal(refused.ok, false, reason);
    assert.equal(refused.status, 'refused');
    assert.equal(refused.reason, reason);
    assert.equal(refused.remedy, HOST_REMEDIES[reason]);
    assert.equal(readFileSync(first.paths.policyPath, 'utf8'), before, 'a refused change writes nothing');
  }
  const bare = await setupRuntimeHost(setupOptions(fixture, run, { aggregateTasks: 8192, ownership: { inspectClaims: async () => ([{ kind: 'checkout' }]) } }));
  assert.equal(bare.ok, false);
  assert.equal(bare.reason, 'claims-active');
  assert.equal(readFileSync(first.paths.policyPath, 'utf8'), before);
});

test('wave resources: runtimeHostCommand composes validated flags into the host check', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await hostFixture(t);
  const idle = hostTransport(fixture);
  const handled = await runtimeHostCommand('check', { lifecycleMemoryMib: 2048 }, hostOptions(fixture, idle.run));
  assert.equal(handled.exitCode, 0);
  assert.equal(handled.result.mode, 'check');
  assert.equal(handled.result.ok, true);
  assert.equal(handled.result.policy.lifecycleMemoryBytes, 2048 * MIB);
  assert.ok(!idle.calls.some(call => call.command === 'systemd-run' && !call.args.includes('--version')), 'check without --probe never probes');
  const absent = hostTransport(fixture, { bwrapAvailable: false });
  const probed = await runtimeHostCommand('check', { probe: true }, hostOptions(fixture, absent.run));
  assert.equal(probed.exitCode, 0);
  assert.equal(probed.result.properties.source, 'probe');
  assert.ok(absent.calls.some(call => call.command === 'systemd-run' && !call.args.includes('--version')));
  const invalid = await runtimeHostCommand('check', { lifecycleMemoryMib: 0 }, hostOptions(fixture, idle.run));
  assert.equal(invalid.exitCode, 2);
  assert.equal(invalid.result.status, 'usage');
  const unsupported = await runtimeHostCommand('check', { zzz: true }, hostOptions(fixture, idle.run));
  assert.equal(unsupported.exitCode, 2);
  assert.equal(unsupported.result.reason, 'unsupported-flags');
});

test('wave resources: runtime-host CLI rejects unsupported arguments with exit 2', { timeout: CASE_TIMEOUT_MS }, () => {
  const cliPath = fileURLToPath(new URL('../../../scripts/spec-observe/cli.mjs', import.meta.url));
  const cases = [
    ['runtime-host'],
    ['runtime-host', 'setup', '--probe'],
    ['runtime-host', 'check', '--lifecycle-memory-mib', 'abc'],
    ['runtime-host', 'check', '--bogus'],
    ['runtime-host', 'check', '--lifecycle-tasks', '0'],
    ['runtime-host', 'setup', '--lifecycle-tasks'],
    ['runtime-host', 'frobnicate'],
  ];
  for (const argv of cases) {
    const spawned = spawnSync(process.execPath, [cliPath, ...argv], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(spawned.status, 2, `${argv.join(' ')}: ${spawned.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// Step 005: bounded systemd-service lifecycle adapter. Only the systemd-run
// client boundary is substituted; the runtime dir/socket, cgroup fixture files,
// gate bootstrap and authorization file stay real.
// ---------------------------------------------------------------------------

const SERVICE_TEST_HOST_ID = 'synthetic-host-id';
const SERVICE_TEST_BOOT_ID = 'synthetic-boot-id';
const SERVICE_TEST_GROUP = '/user.slice/user-1000.slice/user@1000.service/spec-runtime-test.service';

function waitForCondition(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const check = () => {
      if (predicate()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, 5);
    };
    check();
  });
}

async function terminate(child) {
  if (child === null || child === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited.catch(() => {});
}

async function deadChildPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  return child.pid;
}

function setCgroupEvents(cgroupRoot, group, populate) {
  const dir = join(cgroupRoot, group);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cgroup.events'), `frozen 0\npopulated ${populate}\n`);
  return dir;
}

// Real fixture: private runtime dir plus listening socket, real cgroup files,
// real Node gate bootstrap executed from the adapter's argv. The fake launcher
// returns a live client stand-in PID that is deliberately distinct from the
// MainPID the manager transport reports, mirroring systemd-run --pipe.
async function serviceHarness(t) {
  const fixture = await runtimeFixture(t, { socket: true });
  const cgroupRoot = join(fixture.base, 'cgroup');
  mkdirSync(cgroupRoot, { recursive: true });
  const state = {
    calls: [],
    spawnCalls: [],
    gates: [],
    launchers: [],
    gate: null,
    gateOutput: '',
    gateError: '',
    mainPid: null,
    invocationId: `inv-${Math.random().toString(16).slice(2)}`,
    loadState: 'loaded',
    activeState: 'active',
    subState: 'running',
    result: '',
    mainPidOverride: null,
    controlGroup: SERVICE_TEST_GROUP,
    jobs: '',
    failShow: false,
    failJobs: false,
    clock: Date.now(),
  };
  const env = {
    XDG_RUNTIME_DIR: fixture.dir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${fixture.socketPath}`,
  };
  const spawnTransport = request => {
    state.spawnCalls.push({ command: request.command, args: [...request.args], env: { ...request.env }, cwd: request.cwd, stdio: request.stdio });
    const separator = request.args.indexOf('--');
    const execArgs = request.args.slice(separator + 1);
    const setenv = new Map();
    for (const argument of request.args) {
      if (!argument.startsWith('--setenv=')) continue;
      const pair = argument.slice('--setenv='.length);
      const index = pair.indexOf('=');
      setenv.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const gateEnv = { ...request.env, ...Object.fromEntries(setenv), INVOCATION_ID: state.invocationId };
    const gate = spawn(execArgs[0], execArgs.slice(1), { cwd: request.cwd, env: gateEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = { child: gate, output: '', error: '' };
    state.gates.push(entry);
    state.gate = gate;
    state.gateOutput = '';
    state.gateError = '';
    gate.stdout.on('data', chunk => { entry.output += chunk; if (state.gate === gate) state.gateOutput += chunk; });
    gate.stderr.on('data', chunk => { entry.error += chunk; if (state.gate === gate) state.gateError += chunk; });
    state.mainPid = gate.pid;
    const launcher = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    state.launchers.push(launcher);
    state.launcher = launcher;
    return launcher;
  };
  const run = async request => {
    state.calls.push({ command: request.command, args: [...request.args], env: { ...request.env } });
    const args = request.args;
    if (request.command === 'systemctl' && args.includes('show')) {
      if (state.failShow) return { exitCode: 1, signal: null, stdout: '', stderr: 'show failed' };
      const mainPid = state.mainPidOverride ?? state.mainPid ?? 0;
      const lines = [
        `LoadState=${state.loadState}`,
        `ActiveState=${state.activeState}`,
        `SubState=${state.subState}`,
        `InvocationID=${state.invocationId}`,
        `ControlGroup=${state.controlGroup}`,
        `MainPID=${mainPid}`,
        `Result=${state.result}`,
        'ExecMainStatus=0',
      ];
      return { exitCode: 0, signal: null, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }
    if (request.command === 'systemctl' && args.includes('list-jobs')) {
      if (state.failJobs) return { exitCode: 1, signal: null, stdout: '', stderr: 'jobs failed' };
      return { exitCode: 0, signal: null, stdout: state.jobs, stderr: '' };
    }
    if (request.command === 'systemctl' && args.includes('stop')) {
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    }
    return { exitCode: 1, signal: null, stdout: '', stderr: `unexpected ${request.command}` };
  };
  const adapter = createSystemdServiceAdapter({
    run,
    spawn: spawnTransport,
    identity: { host_id: SERVICE_TEST_HOST_ID, boot_id: SERVICE_TEST_BOOT_ID, uid: process.geteuid() },
    cgroupRoot,
    gateRoot: fixture.dir,
    limits: policy(),
    env,
    startTimeoutMs: 10_000,
    drainTimeoutMs: 1_000,
    queryTimeoutMs: 1_000,
    pollIntervalMs: 5,
    now: () => state.clock,
  });
  t.after(async () => {
    for (const entry of state.gates) await terminate(entry.child);
    for (const launcher of state.launchers) await terminate(launcher);
  });
  return { fixture, cgroupRoot, state, env, adapter };
}

// A persisted-shape record using the actual current uid, synthetic host/boot
// and a known child PID that already exited (settled launcher, never an
// arbitrary possibly-live PID).
async function serviceRecord(harness, overrides = {}) {
  const { launcherPid, recordId, ...rest } = overrides;
  const launcher = launcherPid ?? await deadChildPid();
  return {
    kind: 'systemd-service',
    unit: `spec-runtime-${recordId ?? 'test'}.service`,
    invocation_id: harness.state.invocationId,
    control_group: SERVICE_TEST_GROUP,
    main_pid: 4242,
    launcher: { pid: launcher, transport: 'systemd-run' },
    host_id: SERVICE_TEST_HOST_ID,
    boot_id: SERVICE_TEST_BOOT_ID,
    uid: process.geteuid(),
    gate_dir: null,
    gate_root: null,
    ...rest,
  };
}

test('wave resources: systemd start authorizes the gate only after registration and preserves cwd, env and bounds', { timeout: CASE_TIMEOUT_MS }, async t => {
  const { state, env, adapter } = await serviceHarness(t);
  const cwd = mkdtempSync(join(tmpdir(), 'wave-service-cwd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const markerPath = join(cwd, 'marker.json');
  const command = [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({`,
    '  cwd: process.cwd(),',
    '  argv: process.argv,',
    '  marker: process.env.SERVICE_TEST_MARKER,',
    '  empty: process.env.SERVICE_TEST_EMPTY,',
    '  invocation: process.env.INVOCATION_ID,',
    '  runtime: process.env.XDG_RUNTIME_DIR,',
    '  bus: process.env.DBUS_SESSION_BUS_ADDRESS,',
    '}));',
    'console.log("gate-child-ready");',
  ].join('\n');
  const startedAtMs = Date.now();
  const deadline = createWaveDeadline({ startedAtMs, timeoutMs: 120_000 });
  state.clock = startedAtMs;
  const limits = policy();
  let registered = null;
  let markerInsideRegister = null;
  let authorizationInsideRegister = null;
  let outputInsideRegister = null;
  const result = await adapter.start({
    argv: [process.execPath, '-e', command, '', 'tail-arg'],
    cwd,
    env: { ...env, SERVICE_TEST_MARKER: 'propagated', SERVICE_TEST_EMPTY: '' },
    register: async record => {
      registered = record;
      await new Promise(resolve => setImmediate(resolve));
      markerInsideRegister = existsSync(markerPath);
      authorizationInsideRegister = existsSync(join(record.gate_dir, 'authorize.json'));
      outputInsideRegister = state.gateOutput;
      return true;
    },
    deadline,
  });
  assert.equal(result.ok, true, `start refused: ${result.reason} ${result.detail ?? ''}`);
  assert.equal(result.status, 'started');
  assert.equal(result.record, registered);
  assert.match(result.unit, /^spec-runtime-[0-9a-f]{24}\.service$/);
  assert.equal(result.invocation_id, state.invocationId);
  assert.equal(result.main_pid, state.mainPid);
  assert.equal(result.launcher_pid, state.launcher.pid);
  assert.notEqual(result.main_pid, result.launcher_pid, 'the launcher client PID is distinct from the queried MainPID');
  assert.equal(markerInsideRegister, false, 'the command cannot run before registration returns true');
  assert.equal(authorizationInsideRegister, false, 'the authorization file is written only after registration');
  assert.equal(outputInsideRegister, '', 'the gate emits nothing before authorization');

  const spawnCall = state.spawnCalls[0];
  assert.equal(spawnCall.command, 'systemd-run');
  const args = spawnCall.args;
  const separator = args.indexOf('--');
  assert.notEqual(separator, -1, 'the launcher argv passes arguments after --');
  assert.deepEqual(args.slice(separator + 1, separator + 3), [process.execPath, '-e'], 'the adapter-supplied Node gate argv runs under the launcher');
  const tokenFlag = args.find(argument => argument.startsWith('--setenv=SPEC_RUNTIME_GATE_TOKEN='));
  assert.ok(tokenFlag, 'the gate credential is passed through setenv');
  const token = tokenFlag.slice('--setenv=SPEC_RUNTIME_GATE_TOKEN='.length);
  assert.ok(token.length >= 32);
  for (const flag of [
    '--user',
    '--pipe',
    '--wait',
    '--collect',
    '--service-type=exec',
    `--unit=${result.unit}`,
    '--slice=spec-runtime.slice',
    '--property=KillMode=control-group',
    '--property=SendSIGKILL=yes',
    '--property=RuntimeMaxSec=120',
    `--property=MemoryMax=${limits.lifecycleMemoryBytes}`,
    `--property=MemoryHigh=${limits.memoryHighBytes}`,
    '--property=MemorySwapMax=0',
    `--property=TasksMax=${limits.lifecycleTasks}`,
    `--property=CPUWeight=${limits.cpuWeight}`,
    `--property=CPUQuota=${limits.cpuQuotaPercent}%`,
    `--working-directory=${cwd}`,
  ]) assert.ok(args.includes(flag), `missing ${flag}`);

  assert.equal(registered.kind, 'systemd-service');
  assert.equal(registered.unit, result.unit);
  assert.equal(registered.invocation_id, state.invocationId);
  assert.equal(registered.control_group, state.controlGroup);
  assert.equal(registered.host_id, SERVICE_TEST_HOST_ID);
  assert.equal(registered.boot_id, SERVICE_TEST_BOOT_ID);
  assert.equal(registered.uid, process.geteuid());
  assert.deepEqual(registered.deadline, deadline);
  assert.equal(registered.runtime_max_sec, 120);
  assert.deepEqual(registered.limits, {
    memoryBytes: limits.lifecycleMemoryBytes,
    memoryHighBytes: limits.memoryHighBytes,
    memorySwapMaxBytes: 0,
    tasksMax: limits.lifecycleTasks,
    cpuWeight: limits.cpuWeight,
    cpuQuotaPercent: limits.cpuQuotaPercent,
  });
  assert.equal(Object.hasOwn(registered, 'token'), false);
  assert.equal(JSON.stringify(registered).includes(token), false, 'the synthetic credential never lands in the persisted record');
  assert.equal(JSON.stringify(registered).includes('SERVICE_TEST_MARKER'), false);

  assert.equal(await waitForCondition(() => existsSync(markerPath) && state.gateOutput.includes('gate-child-ready')), true, `gate never ran: ${state.gateError}`);
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  assert.equal(marker.cwd, cwd);
  assert.ok(marker.argv.includes(''), 'an empty argument propagates unchanged');
  assert.ok(marker.argv.includes('tail-arg'));
  assert.equal(marker.marker, 'propagated');
  assert.equal(marker.empty, '');
  assert.equal(marker.invocation, state.invocationId, 'the synthetic INVOCATION_ID reaches the service');
  assert.equal(marker.runtime, env.XDG_RUNTIME_DIR);
  assert.equal(marker.bus, env.DBUS_SESSION_BUS_ADDRESS);
});

test('wave resources: refused and expired systemd starts never authorize the gate and retain the record', { timeout: CASE_TIMEOUT_MS }, async t => {
  const { state, env, adapter } = await serviceHarness(t);
  const cwd = mkdtempSync(join(tmpdir(), 'wave-service-refused-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const markerPath = join(cwd, 'never-ran');
  const argv = [process.execPath, '-e', `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran")`];

  const expiredDeadline = createWaveDeadline({ startedAtMs: Date.now() - 60_000, timeoutMs: 30_000 });
  const expired = await adapter.start({ argv, cwd, env, register: async () => true, deadline: expiredDeadline });
  assert.equal(expired.ok, false);
  assert.equal(expired.status, 'refused');
  assert.equal(expired.reason, 'deadline-invalid');
  assert.equal(expired.record, null);
  assert.equal(state.spawnCalls.length, 0, 'an expired request never spawns the launcher');

  const deadline = createWaveDeadline({ startedAtMs: Date.now(), timeoutMs: 120_000 });
  state.clock = deadline.started_at;
  const refused = await adapter.start({ argv, cwd, env, register: async () => false, deadline });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 'register-refused');
  assert.equal(refused.record.invocation_id, state.invocationId);
  assert.equal(refused.record.unit, refused.unit);
  assert.equal(existsSync(join(refused.record.gate_dir, 'authorize.json')), false, 'a refused registration never writes the gate');
  assert.equal(state.gate.exitCode, null, 'the gate remains waiting for authorization');
  assert.ok(state.calls.some(call => call.args.includes('stop') && call.args.includes(refused.unit)), 'the established refused unit is stopped, never signaled');
  assert.equal(refused.launcher_pid, state.launcher.pid);
  assert.notEqual(refused.main_pid, refused.launcher_pid);

  const expiredDuring = await adapter.start({
    argv,
    cwd,
    env,
    register: async () => { state.clock = deadline.expires_at + 1; return true; },
    deadline,
  });
  assert.equal(expiredDuring.ok, false);
  assert.equal(expiredDuring.status, 'refused');
  assert.equal(expiredDuring.reason, 'deadline-expired');
  assert.equal(expiredDuring.record.invocation_id, state.invocationId);
  assert.equal(existsSync(join(expiredDuring.record.gate_dir, 'authorize.json')), false, 'an expired registration never writes the gate');
  assert.ok(state.calls.some(call => call.args.includes('stop') && call.args.includes(expiredDuring.unit)));
  state.clock = Date.now();
  assert.equal(existsSync(markerPath), false, 'the command never ran');
});

test('wave resources: systemd inspect retains populated work, confirms terminal drains and distinguishes oom-kill from provider failure', { timeout: CASE_TIMEOUT_MS }, async t => {
  const harness = await serviceHarness(t);
  const { cgroupRoot, state, env, adapter } = harness;
  const record = await serviceRecord(harness);
  setCgroupEvents(cgroupRoot, record.control_group, 1);
  state.activeState = 'failed';
  state.subState = 'dead';
  state.result = 'timeout';
  const populated = await adapter.inspect(record, { env });
  assert.equal(populated.status, 'populated');
  assert.equal(populated.ok, false);
  assert.equal(populated.reason, 'cgroup-populated');
  assert.equal(populated.claim_released, false);
  assert.equal(populated.service.outcome, 'timeout');
  assert.equal(populated.launcher, 'settled');

  const stillPopulated = await adapter.drain(record, { env, timeoutMs: 0 });
  assert.equal(stillPopulated.status, 'populated', 'a populated cgroup retains the work until a positive drain');

  setCgroupEvents(cgroupRoot, record.control_group, 0);
  const drained = await adapter.drain(record, { env, timeoutMs: 0 });
  assert.equal(drained.status, 'confirmed');
  assert.equal(drained.reason, 'unit-terminal-drained');
  assert.equal(drained.service.outcome, 'timeout');
  assert.equal(drained.gate_cleaned, false);

  state.result = 'oom-kill';
  const oom = await adapter.inspect(record, { env });
  assert.equal(oom.status, 'confirmed');
  assert.equal(oom.ok, true);
  assert.equal(oom.service.outcome, 'oom-kill');
  assert.equal(oom.service.result, 'oom-kill');

  state.failShow = true;
  const providerFailure = await adapter.inspect(record, { env });
  assert.equal(providerFailure.status, 'unknown');
  assert.equal(providerFailure.ok, false);
  assert.equal(providerFailure.reason, 'query-error');
  assert.equal(providerFailure.service, null);
  state.failShow = false;
});

test('wave resources: systemd not-found drain requires an absent cgroup, a settled launcher and no pending jobs', { timeout: CASE_TIMEOUT_MS }, async t => {
  const harness = await serviceHarness(t);
  const { cgroupRoot, state, env, adapter } = harness;
  const liveLauncher = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(async () => terminate(liveLauncher));
  const record = await serviceRecord(harness, { launcherPid: liveLauncher.pid });
  state.loadState = 'not-found';
  state.activeState = 'inactive';
  state.mainPidOverride = 0;

  const live = await adapter.inspect(record, { env });
  assert.equal(live.status, 'unknown');
  assert.equal(live.reason, 'launcher-live');

  await terminate(liveLauncher);
  state.jobs = '17 spec-runtime-other.service start running\n';
  const pending = await adapter.inspect(record, { env });
  assert.equal(pending.reason, 'jobs-pending');
  state.jobs = '';

  setCgroupEvents(cgroupRoot, record.control_group, 0);
  const lingering = await adapter.inspect(record, { env });
  assert.equal(lingering.reason, 'cgroup-not-absent', 'an empty lingering cgroup is not proof of drain');

  rmSync(join(cgroupRoot, record.control_group), { recursive: true, force: true });
  const confirmed = await adapter.inspect(record, { env });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.reason, 'unit-not-found');
  assert.equal(confirmed.service.terminal, true);

  const stopped = await adapter.stop(record, { env, wait: false });
  assert.equal(stopped.reason, 'unit-not-found');
  assert.equal(state.calls.filter(call => call.args.includes('stop')).length, 0, 'a not-found unit is never stopped');
});

test('wave resources: systemd stop requests the exact verified unit and never signals a recovered PID', { timeout: CASE_TIMEOUT_MS }, async t => {
  const harness = await serviceHarness(t);
  const { state, env, adapter } = harness;
  const recovered = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(async () => terminate(recovered));
  const record = await serviceRecord(harness, { launcherPid: recovered.pid, main_pid: recovered.pid });

  const requested = await adapter.stop(record, { env, wait: false });
  assert.equal(requested.ok, true);
  assert.equal(requested.status, 'stop-requested');
  const stopCalls = state.calls.filter(call => call.args.includes('stop'));
  assert.equal(stopCalls.length, 1);
  assert.deepEqual(stopCalls[0].args, ['--user', 'stop', '--no-block', record.unit]);
  assert.equal(recovered.exitCode, null, 'stop never signals the recovered PID');
  assert.equal(recovered.signalCode, null);

  state.invocationId = 'inv-replaced';
  const changedInvocation = await adapter.stop(record, { env, wait: false });
  assert.equal(changedInvocation.reason, 'changed-invocation');
  state.invocationId = record.invocation_id;
  const changedBoot = await adapter.stop({ ...record, boot_id: 'stale-boot' }, { env, wait: false });
  assert.equal(changedBoot.reason, 'changed-boot');
  const foreignHost = await adapter.stop({ ...record, host_id: 'elsewhere' }, { env, wait: false });
  assert.equal(foreignHost.reason, 'foreign-host');
  const foreignUser = await adapter.stop({ ...record, uid: record.uid + 1 }, { env, wait: false });
  assert.equal(foreignUser.reason, 'foreign-user');
  assert.equal(state.calls.filter(call => call.args.includes('stop')).length, 1, 'only the verified record requests a stop');
  assert.equal(recovered.exitCode, null);
  assert.equal(recovered.signalCode, null);
});

test('wave resources: systemd inspect refuses on query errors, identity changes, malformed evidence and escaped paths', { timeout: CASE_TIMEOUT_MS }, async t => {
  const harness = await serviceHarness(t);
  const { cgroupRoot, state, env, adapter } = harness;
  const record = await serviceRecord(harness);
  setCgroupEvents(cgroupRoot, record.control_group, 0);
  state.activeState = 'failed';
  state.subState = 'dead';
  state.result = 'exit-code';

  const foreignHost = await adapter.inspect({ ...record, host_id: 'foreign-host' }, { env });
  assert.equal(foreignHost.reason, 'foreign-host');
  const foreignUser = await adapter.inspect({ ...record, uid: record.uid + 1 }, { env });
  assert.equal(foreignUser.reason, 'foreign-user');

  state.invocationId = 'inv-replaced';
  const changedInvocation = await adapter.inspect(record, { env });
  assert.equal(changedInvocation.reason, 'changed-invocation');
  state.invocationId = record.invocation_id;

  state.controlGroup = '/user.slice/other.service';
  const changedCgroup = await adapter.inspect(record, { env });
  assert.equal(changedCgroup.reason, 'changed-cgroup');
  state.controlGroup = record.control_group;

  const cgroupDir = join(cgroupRoot, record.control_group);
  writeFileSync(join(cgroupDir, 'cgroup.events'), 'frozen 0\npopulated maybe\n');
  const malformed = await adapter.inspect(record, { env });
  assert.equal(malformed.reason, 'cgroup-unreadable');
  rmSync(join(cgroupDir, 'cgroup.events'));
  const missing = await adapter.inspect(record, { env });
  assert.equal(missing.reason, 'cgroup-unreadable');

  const escapedGroup = '../outside/spec-runtime-escape.service';
  state.controlGroup = escapedGroup;
  const escaped = await adapter.inspect({ ...record, control_group: escapedGroup }, { env });
  assert.equal(escaped.reason, 'cgroup-path-outside-root');
  state.controlGroup = record.control_group;

  state.failJobs = true;
  const jobsUnreadable = await adapter.inspect(record, { env });
  assert.equal(jobsUnreadable.reason, 'jobs-unreadable');
  state.failJobs = false;

  const busRefused = await adapter.inspect(record, { env: { XDG_RUNTIME_DIR: 'relative' } });
  assert.equal(busRefused.status, 'unknown');
  assert.equal(busRefused.reason, 'bus-unavailable');
  assert.ok(typeof busRefused.remedy === 'string' && busRefused.remedy !== '');

  state.result = 'success';
  setCgroupEvents(cgroupRoot, record.control_group, 0);
  const changedBoot = { ...record, boot_id: 'stale-boot-id' };
  const unverified = await adapter.inspect(changedBoot, { env });
  assert.equal(unverified.reason, 'changed-boot');
  const verified = await adapter.inspect(changedBoot, { env, ownershipVerified: true });
  assert.equal(verified.status, 'confirmed');
  assert.equal(verified.reason, 'unit-terminal-drained');

  await assert.rejects(() => adapter.inspect(tagPosixProcessRecord(record), { env }), /systemd-service record/);
});

test('wave resources: POSIX tagging forces the posix kind and preserves every prior field', { timeout: CASE_TIMEOUT_MS }, () => {
  const prior = { unit: 'spec-runtime-abc.service', invocation_id: 'inv-1', pid: 4242, pgid: 4242 };
  const tagged = tagPosixProcessRecord(prior, { kind: 'systemd-service', label: 'kept' });
  assert.equal(tagged.kind, 'posix-process-group');
  assert.equal(tagged.unit, prior.unit);
  assert.equal(tagged.invocation_id, prior.invocation_id);
  assert.equal(tagged.pid, 4242);
  assert.equal(tagged.pgid, 4242);
  assert.equal(tagged.label, 'kept');
  assert.equal(isSystemdServiceRecord(tagged), false);
});
