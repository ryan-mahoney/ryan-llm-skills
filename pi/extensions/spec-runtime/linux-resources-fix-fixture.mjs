// Shared isolated-host fixture for the step 13 Linux recovery regressions.
//
// The regression suites (waves-native-policy, linux-resources-fallback,
// linux-resources-property-read) need a host that looks like a configured
// wave host without touching the operator's real host: a private runtime bus
// socket, a temporary config home, a cgroup-v2 tree whose ancestors expose
// unlimited memory.max/pids.max, and no bubblewrap on the host. Nothing here
// mutates the actual host policy or the production fixtures; transports are
// synthetic and therefore always report `kernel_proof = false` while the
// property read itself may delegate to the real user manager.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GIB = 1024 ** 3;

// The user manager reports unlimited ancestors for the pool computation; the
// isolated slice itself is not installed here, so the aggregate/property
// values are only what the synthetic property query returns.
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
  MemoryMax: String(21 * GIB),
  MemoryHigh: String(Math.floor((21 * GIB * 80) / 100)),
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
// plus <base>/run/<uid>/bus and <base>/bin/bwrap (absent by default).
async function hostFixture(t, { hostControllers = 'cpu memory pids', managerControllers = 'cpu memory pids', managerSubtree = '+cpu +memory +pids', socket = true, bwrap = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'wave-fix-host-'));
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
  // The cgroup-v2 hierarchy root exposes no limit files; the ancestors above
  // the user manager are explicitly unlimited so they never bind admission.
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

// Synthetic transport: records every command and answers the utilities,
// version, show and probe calls the host check composes. Records are marked
// `kernelProof: false` so no consumer mistakes them for real host evidence.
function hostTransport(fixture, {
  version = 'systemd 255 (255.4-1)\n',
  propertyLines = HOST_PROPERTY_LINES,
  propertyStderr = '',
  utilityMissing = null,
  managerUnreachable = false,
  probeAccepted = true,
  sliceValues = null,
  bwrapAvailable = false,
  systemctlDelegate = null,
} = {}) {
  const calls = [];
  const run = async ({ command, args = [], env = {} }) => {
    calls.push({ command, args: [...args], env: { ...env }, key: [command, ...args].join(' '), kernelProof: false });
    if (systemctlDelegate !== null && command === 'systemctl') {
      const delegated = systemctlDelegate({ command, args: [...args], env: { ...env }, key: [command, ...args].join(' ') });
      // A delegate may decline a request (null) to keep the synthetic answer,
      // e.g. it only delegates real root-slice property reads.
      if (delegated !== null) {
        calls[calls.length - 1] = { ...delegated, kernelProof: false };
        return delegated;
      }
    }
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
      if (args.includes('daemon-reload')) return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      if (args.includes('list-units')) return { exitCode: 0, signal: null, stdout: '', stderr: '' };
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
    return { exitCode: 1, signal: null, stdout: '', stderr: `unhandled fixture command: ${command} ${args.join(' ')}\n` };
  };
  return { run, calls };
}

// 30 GiB physical with 8 CPUs: the default 3 GiB lifecycle admits 7 slots,
// while an installed 2048 MiB lifecycle admits more than the nine ready
// members this suite asks for.
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

// Isolated fixture + synthetic transport in one call. `options` is the full
// host option object (ready to spread into a production call); `calls` holds
// every recorded command; `run` is the substitutable transport.
async function isolatedHost(t, transportOverrides = {}, optionOverrides = {}) {
  const fixture = await hostFixture(t);
  const transport = hostTransport(fixture, transportOverrides);
  const options = hostOptions(fixture, transport.run, optionOverrides);
  return { fixture, run: transport.run, calls: transport.calls, options };
}

// Delegate only real root-slice property reads to the operator's user manager.
// Every other request returns null and keeps the synthetic answer. The
// production argv is forwarded verbatim and the record carries the observed
// stdout/stderr/status.
//
// Environment boundary: the *argv* comes from the synthetic isolated host
// (that is the composition under test), but the *bus* must be the operator's
// real user manager. The isolated fixture points XDG_RUNTIME_DIR and
// DBUS_SESSION_BUS_ADDRESS at a private empty socket, so spreading
// request.env would make the real binary talk to a dead socket. Only the
// nonsensitive bus identity is taken from the operator's process.env here; no
// credentials are captured.
function realSystemctlReader() {
  const reads = [];
  const realEnv = {
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  };
  const delegate = request => {
    if (!request.args.includes('-.slice')) return null;
    const env = { ...process.env };
    for (const [name, value] of Object.entries(realEnv)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    const record = spawnSync('systemctl', request.args, {
      env,
      encoding: 'utf8',
      timeout: 5000,
    });
    const result = {
      command: 'systemctl',
      args: [...request.args],
      env: { ...request.env },
      key: request.key,
      exitCode: record.status,
      signal: record.signal,
      stdout: typeof record.stdout === 'string' ? record.stdout : '',
      stderr: typeof record.stderr === 'string' ? record.stderr : '',
      real: true,
    };
    reads.push(result);
    return result;
  };
  return { delegate, reads };
}

export { GIB, HOST_PROPERTY_LINES, HOST_SLICE_VALUES, BWRAP_HELP, hostFixture, hostTransport, hostOptions, isolatedHost, realSystemctlReader };
