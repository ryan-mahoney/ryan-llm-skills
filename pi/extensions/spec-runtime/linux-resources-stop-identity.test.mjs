// F4 regression: the actual systemd-service `stop` refuses a record whose unit
// now reports a different ControlGroup than the recorded one. The pre-stop
// identity check must catch the contradiction and return unknown/changed-cgroup
// without ever issuing a stop, instead of falling through to the terminal-drain
// path that a settled launcher plus a terminal unit would otherwise produce.
//
// This drives the real production adapter (`createSystemdServiceAdapter`) over
// real files: a private runtime directory with a listening unix bus socket and a
// real cgroup.events fixture. Only the manager CLI transport (`systemctl`) is
// substituted; no worker or service process is spawned beyond the short-lived
// Node child used to settle a known launcher PID. Synthetic proof only
// (kernel_proof=false); it makes no systemd launch claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSystemdServiceAdapter } from './linux-resources.mjs';

const CASES = { timeout: 120_000 };

const HOST_ID = 'synthetic-stop-host';
const BOOT_ID = 'synthetic-stop-boot';
const RECORDED_GROUP = '/user.slice/user-1000.slice/user@1000.service/spec-runtime-stop.service';
const CONTRADICTORY_GROUP = '/user.slice/user-1000.slice/user@1000.service/spec-runtime-other.service';

// Private runtime dir plus a real listening unix socket. Cleanup is owned by the
// test and closes the socket server before removing the tree.
async function busFixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'wave-stop-identity-'));
  const dir = join(base, String(process.geteuid()));
  mkdirSync(dir, { mode: 0o700 });
  const socketPath = join(dir, 'bus');
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  t.after(async () => {
    await new Promise(resolve => server.close(() => resolve()));
    rmSync(base, { recursive: true, force: true });
  });
  return { base, dir, socketPath };
}

// A known child PID that already exited; the launcher is therefore settled
// (ESRCH) for a recovered record rather than an arbitrary possibly-live PID.
async function deadChildPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  return child.pid;
}

function writeCgroupEvents(cgroupRoot, group, populated) {
  const directory = join(cgroupRoot, group);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'cgroup.events'), `frozen 0\npopulated ${populated}\n`);
}

test('wave resources: actual systemd stop refuses a contradictory ControlGroup without stopping', CASES, async t => {
  const fixture = await busFixture(t);
  const cgroupRoot = join(fixture.base, 'cgroup');
  mkdirSync(cgroupRoot, { recursive: true });
  // The recorded group's real cgroup.events reports an empty (drained) process
  // set, so a settled launcher plus a terminal unit would look drained.
  writeCgroupEvents(cgroupRoot, RECORDED_GROUP, 0);

  const env = {
    XDG_RUNTIME_DIR: fixture.dir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${fixture.socketPath}`
  };

  const state = {
    calls: [],
    stopCalls: 0,
    invocationId: 'inv-stop-identity',
    controlGroup: CONTRADICTORY_GROUP,
    loadState: 'loaded',
    activeState: 'active',
    subState: 'running',
    result: '',
    jobs: ''
  };

  // Because inspect compares the recorded group first, the observation carries
  // the whole contradictory snapshot either way. The failure message surfaces
  // that observation so a refusal can never be read as a terminal drain.
  const run = async request => {
    const args = request.args;
    state.calls.push({ command: request.command, args: [...args] });
    if (request.command === 'systemctl' && args.includes('show')) {
      const lines = [
        `LoadState=${state.loadState}`,
        `ActiveState=${state.activeState}`,
        `SubState=${state.subState}`,
        `InvocationID=${state.invocationId}`,
        `ControlGroup=${state.controlGroup}`,
        `MainPID=${state.mainPid ?? 0}`,
        `Result=${state.result}`,
        'ExecMainStatus=0'
      ];
      return { exitCode: 0, signal: null, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }
    if (request.command === 'systemctl' && args.includes('list-jobs')) {
      return { exitCode: 0, signal: null, stdout: state.jobs, stderr: '' };
    }
    if (request.command === 'systemctl' && args.includes('stop')) {
      // A baseline that wrongly issues the stop is recorded, and the manager
      // then moves the unit to a terminal state that would read as drained:
      // the unit keeps reporting the *recorded* group, so only the pre-stop
      // identity comparison can refuse it.
      state.stopCalls += 1;
      state.controlGroup = RECORDED_GROUP;
      state.loadState = 'loaded';
      state.activeState = 'inactive';
      state.subState = 'dead';
      state.result = 'success';
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    }
    return { exitCode: 1, signal: null, stdout: '', stderr: `unexpected ${request.command}` };
  };

  const adapter = createSystemdServiceAdapter({
    run,
    spawn: () => { throw new Error('stop must not spawn a service'); },
    identity: { host_id: HOST_ID, boot_id: BOOT_ID, uid: process.geteuid() },
    cgroupRoot,
    limits: null,
    env,
    drainTimeoutMs: 0,
    queryTimeoutMs: 1_000,
    pollIntervalMs: 5
  });

  const record = {
    kind: 'systemd-service',
    unit: 'spec-runtime-stop.service',
    invocation_id: state.invocationId,
    control_group: RECORDED_GROUP,
    main_pid: 4242,
    launcher: { pid: await deadChildPid(), transport: 'systemd-run' },
    host_id: HOST_ID,
    boot_id: BOOT_ID,
    uid: process.geteuid(),
    gate_dir: null,
    gate_root: null
  };

  const refused = await adapter.stop(record, { wait: true, timeoutMs: 0 });
  assert.equal(state.stopCalls, 0,
    `the contradictory identity is refused before any stop is issued: ${JSON.stringify(refused)}`);
  assert.equal(refused.status, 'unknown', 'a contradictory ControlGroup is never a positive drain');
  assert.equal(refused.reason, 'changed-cgroup', 'the pre-stop identity comparison names changed-cgroup');
  assert.equal(refused.ok, false, 'the refusal is not ok');

  // Positive control: the same adapter and record drain positively once the
  // manager reports the recorded group and a terminal unit while the real
  // cgroup.events stays empty and the launcher PID stays settled.
  state.controlGroup = RECORDED_GROUP;
  state.loadState = 'loaded';
  state.activeState = 'inactive';
  state.subState = 'dead';
  state.result = 'success';

  const drained = await adapter.stop(record, { wait: true, timeoutMs: 0 });
  assert.equal(state.stopCalls, 1, 'the positive control issues exactly one stop request');
  assert.equal(drained.status, 'confirmed', 'the matched group and terminal unit drain positively');
  assert.equal(drained.reason, 'unit-terminal-drained', 'the drained record keeps its terminal unit identity');
  assert.equal(drained.ok, true, 'the positive control reports ok');
  assert.equal(drained.service.load_state, 'loaded', 'the terminal record retains the loaded unit, not not-found');
  assert.equal(drained.launcher, 'settled', 'the launcher PID is known absent');
});
