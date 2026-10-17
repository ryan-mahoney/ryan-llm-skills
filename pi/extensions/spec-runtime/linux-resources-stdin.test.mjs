// Regression: operator-authorized step 13 stdin EOF blocker.
//
// A `wave` service launch must hand the launched program stdin that reaches
// EOF when no writer exists. The seam under test is the adapter-supplied
// stdio: the transport below executes the adapter's real argv after `--` with
// exactly the request.stdio that the adapter chose. The test itself never
// closes or writes stdin, and it never substitutes 'ignore'.
//
// The manager is synthetic: systemd-run --help, systemctl show/list-jobs/stop
// are answered by an in-process stand-in and the runtime dir/socket are a
// disposable temp fixture. This is NOT kernel/systemd proof. It proves only
// that the adapter's own stdio contract delivers EOF to the launched program
// without a writer.
//
// Expected before the fix: the stand-in program never sees 'end', so the
// bounded 3s wait fails with 'stdin EOF not delivered' rather than hanging.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GIB,
  calculateResourcePolicy,
  createSystemdServiceAdapter,
  createWaveDeadline,
} from './linux-resources.mjs';

const CASE_TIMEOUT_MS = 120_000;
const EOF_BOUND_MS = 3_000;

const STDIN_TEST_HOST_ID = 'synthetic-stdin-host-id';
const STDIN_TEST_BOOT_ID = 'synthetic-stdin-boot-id';
const STDIN_TEST_GROUP = '/user.slice/user-1000.slice/user@1000.service/spec-runtime-stdin-test.service';

// Stand-in launched program. It resumes stdin and reports a distinguishable
// stdout marker only on 'end', a stderr marker, and exits normally only after
// EOF. cwd and an env sentinel are echoed so the test can assert preservation.
const STDIN_PROGRAM = `
process.stdin.on('end', () => {
  process.stdout.write('STDIN-EOF\\n');
  const sentinel = process.env.WAVE_STDIN_SENTINEL === undefined
    ? 'missing'
    : process.env.WAVE_STDIN_SENTINEL;
  process.stdout.write('CWD=' + process.cwd() + '\\n');
  process.stdout.write('SENTINEL=' + sentinel + '\\n');
  process.exit(0);
});
process.stdin.on('error', error => {
  process.stderr.write('STDIN-ERROR ' + (error && error.message ? error.message : 'unknown') + '\\n');
});
process.stdin.resume();
process.stderr.write('STDIN-STDERR\\n');
`;

function waitForCondition(predicate, timeoutMs) {
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

async function terminateGroup(child) {
  if (child === null || child === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  try {
    // The gate is launched detached so the whole test-owned group can be
    // reclaimed on failure, including any grandchildren it spawned.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  await exited.catch(() => {});
}

test('wave service stdin: default launch delivers EOF without a writer', { timeout: CASE_TIMEOUT_MS }, async t => {
  // Private runtime dir plus a listening unix socket at <base>/<uid>/bus.
  const base = mkdtempSync(join(tmpdir(), 'wave-stdin-'));
  const uid = process.geteuid();
  const dir = join(base, String(uid));
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  const socketPath = join(dir, 'bus');
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  const cgroupRoot = join(base, 'cgroup');
  mkdirSync(cgroupRoot, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), 'wave-stdin-cwd-'));

  const state = {
    invocationId: `inv-${Math.random().toString(16).slice(2)}`,
    mainPid: null,
    gate: null,
    gateOutput: '',
    gateError: '',
    gateExit: null,
    gateClose: null,
    gateClosePromise: null,
  };
  const gates = [];
  let resolveClose = null;
  const closePromise = new Promise(resolve => { resolveClose = resolve; });

  t.after(async () => {
    for (const gate of gates) await terminateGroup(gate);
    await new Promise(resolve => server.close(() => resolve()));
    rmSync(base, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  const env = {
    XDG_RUNTIME_DIR: dir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${socketPath}`,
  };

  // Transport: execute the adapter's real argv after `--` with the adapter's
  // own stdio, faithfully passing request.stdio unchanged. --setenv fields and
  // INVOCATION_ID are merged into the child env; cwd is preserved.
  const spawnTransport = request => {
    assert.equal(request.command, 'systemd-run');
    const separator = request.args.indexOf('--');
    assert.ok(separator >= 0, 'systemd-run argv must contain a -- separator');
    const execArgs = request.args.slice(separator + 1);
    assert.ok(execArgs.length > 0, 'systemd-run argv must carry the launched program after --');
    const setenv = new Map();
    for (const argument of request.args) {
      if (!argument.startsWith('--setenv=')) continue;
      const pair = argument.slice('--setenv='.length);
      const index = pair.indexOf('=');
      if (index > 0) setenv.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const gateEnv = { ...request.env, ...Object.fromEntries(setenv), INVOCATION_ID: state.invocationId };
    const gate = spawn(execArgs[0], execArgs.slice(1), {
      cwd: request.cwd,
      env: gateEnv,
      stdio: request.stdio,
      detached: true,
    });
    gates.push(gate);
    state.gate = gate;
    state.mainPid = gate.pid;
    if (gate.stdout) gate.stdout.on('data', chunk => { state.gateOutput += chunk; });
    if (gate.stderr) gate.stderr.on('data', chunk => { state.gateError += chunk; });
    gate.on('exit', (code, signal) => {
      state.gateExit = { code, signal };
    });
    gate.on('close', (code, signal) => {
      state.gateClose = { code, signal };
      resolveClose(state.gateClose);
    });
    state.gateClosePromise = closePromise;
    return gate;
  };

  const run = async request => {
    const args = request.args;
    if (request.command === 'systemd-run' && args.includes('--help')) {
      return { exitCode: 0, signal: null, stdout: '--expand-environment=BOOL\n', stderr: '' };
    }
    if (request.command === 'systemctl' && args.includes('show')) {
      const lines = [
        'LoadState=loaded',
        'ActiveState=active',
        'SubState=running',
        `InvocationID=${state.invocationId}`,
        `ControlGroup=${STDIN_TEST_GROUP}`,
        `MainPID=${state.mainPid ?? 0}`,
        'Result=',
        'ExecMainStatus=0',
      ];
      return { exitCode: 0, signal: null, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }
    if (request.command === 'systemctl' && args.includes('list-jobs')) {
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    }
    if (request.command === 'systemctl' && args.includes('stop')) {
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    }
    return { exitCode: 1, signal: null, stdout: '', stderr: `unexpected ${request.command}` };
  };

  const limits = calculateResourcePolicy({ physicalMemoryBytes: 30 * GIB, cpuCount: 8 });
  const deadline = createWaveDeadline({ startedAtMs: Date.now(), timeoutMs: 120_000 });
  const adapter = createSystemdServiceAdapter({
    run,
    spawn: spawnTransport,
    identity: { host_id: STDIN_TEST_HOST_ID, boot_id: STDIN_TEST_BOOT_ID, uid },
    cgroupRoot,
    gateRoot: dir,
    limits,
    env,
    startTimeoutMs: 10_000,
    drainTimeoutMs: 1_000,
    queryTimeoutMs: 1_000,
    pollIntervalMs: 5,
  });

  let registered = null;
  const result = await adapter.start({
    argv: [process.execPath, '-e', STDIN_PROGRAM],
    cwd: workDir,
    env: { ...env, WAVE_STDIN_SENTINEL: 'stdin-sentinel' },
    limits,
    deadline,
    register: record => { registered = record; return true; },
  });

  assert.equal(result.ok, true, `start must authorize: ${JSON.stringify(result.reason ?? null)}`);
  assert.equal(registered !== null, true, 'register must be called');

  // The stand-in exits normally only after EOF; no writer ever exists. Wait
  // for 'close' rather than 'exit' so stdout/stderr are fully drained.
  const closed = await waitForCondition(() => state.gateClose !== null, EOF_BOUND_MS);
  if (!closed) {
    // Meaningful bounded failure instead of a hung Node test.
    assert.fail('stdin EOF not delivered');
  }
  const exit = await state.gateClosePromise;
  assert.equal(exit.code, 0, `stand-in must exit 0 after EOF, got ${JSON.stringify(exit)}`);
  assert.equal(exit.signal, null, `stand-in must not be signalled, got ${JSON.stringify(exit)}`);

  assert.match(state.gateOutput, /^STDIN-EOF$/m, 'stdout marker must appear only on stdin end');
  assert.match(state.gateError, /^STDIN-STDERR$/m, 'stderr must be piped');
  assert.doesNotMatch(state.gateError, /STDIN-ERROR/, 'stdin must not error');
  assert.match(state.gateOutput, new RegExp(`^CWD=${workDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), 'cwd must be preserved');
  assert.match(state.gateOutput, /^SENTINEL=stdin-sentinel$/m, 'env must be preserved');
});
