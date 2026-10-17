// Teardown ownership regression (RED until the driver owns descendant groups).
//
// This file exercises the *actual* exported `startCoordinator` from
// ./wave-native-driver.mjs with a *real* createProcessRegistry from
// ./waves-fixture-processes.mjs. It isolates process ownership only: the
// installed SDK is replaced by a synthetic ES module that satisfies exactly the
// surface runCoordinator touches (ModelRuntime, SettingsManager, SessionManager,
// DefaultResourceLoader, createAgentSession). Consequently kernel_proof is false
// for anything this file reports about SDK or Pi lifecycle integration — the
// assertion is only about who owns the process group the coordinator spawns.
//
// The defect seam: the coordinator child is spawned detached with stdio
// ['ignore', 'pipe', 'pipe']. Its `createAgentSession` hook starts a descendant
// Node interval in the SAME process group with inherited stdout/stderr, then
// returns an idle fake session so the real driver emits ready and parks. Once
// the descendant exists, `coordinator.kill()` waits for the leader's `close`
// BEFORE draining the group; the descendant keeps the inherited stdio open, so
// `close` never arrives and teardown never resolves. The RED assertion is
// therefore on the bounded teardown promise, backed by a direct liveness check
// on both recorded pids so a leaked group cannot be mistaken for a pass.
//
// The only escape hatch is the outer `finally`: it always runs
// `registry.cleanup()` (real SIGKILL plus a positive /proc drain), so a failing
// RED cannot leak processes into later fixtures. cleanup() runs strictly after
// the liveness observations have been recorded, it never feeds them, and the
// assertions read only the recorded owner observation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCoordinator } from './wave-native-driver.mjs';
import { createProcessRegistry, isLiveProcessState, parseProcStat } from './waves-fixture-processes.mjs';
import { makeWaveFixture, registerNativeTeardown } from './package-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = join(here, '..', '..', '..');

// Bounded waits. The kill regression must fail well inside the fixture's own
// 30s registry cleanup window, and the shutdown regression allows the driver's
// 10s graceful SIGTERM timeout plus the group drain.
const KILL_BOUND_MS = 2000;
const SHUTDOWN_BOUND_MS = 15000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Liveness by /proc state, so a reaped-but-not-yet-observed zombie counts as
// not running (the same classification the registry uses). Returns
// {pid, state, live}. Only ENOENT or a recognized zombie/dead state counts as
// not live; an unreadable or malformed observation is unknown and stays live so
// it fails the assertions instead of being reported as gone.
function observePid(pid) {
  let raw;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { pid, state: 'gone', live: false };
    return { pid, state: 'unknown', live: true };
  }
  const stat = parseProcStat(raw);
  if (!stat) return { pid, state: 'malformed', live: true };
  return { pid, state: stat.state, live: isLiveProcessState(stat.state) };
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(25);
  }
}

function readPidFile(path) {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// The synthetic installed SDK. Only the names runCoordinator destructures are
// exported. createAgentSession both records the descendant pid and keeps the
// coordinator alive like a real session would (ready is emitted after the
// bind/setModel/setActiveTools sequence, which every stub below no-ops).
const SYNTHETIC_SDK = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const ModelRuntime = {
  async create() {
    return {
      registerProvider() {},
      getModel(provider, model) { return { provider, id: model }; },
    };
  },
};

export const SettingsManager = { inMemory() { return { kind: 'settings' }; } };

export const SessionManager = { create(cwd, dir) { return { cwd, dir }; } };

export class DefaultResourceLoader {
  constructor(options) { this.options = options; }
  async reload() {}
  getExtensions() { return { extensions: [], errors: [] }; }
}

// Start a descendant in the SAME process group (no detached option, so it
// inherits the coordinator's group) with inherited stdout/stderr, and write its
// pid where the test can read it. The descendant itself does nothing but exist.
function startDescendant(pidFile) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30);'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  return child;
}

export async function createAgentSession() {
  const marker = process.env.WAVE_TEARDOWN_DESCENDANT_PID_FILE;
  if (marker) startDescendant(marker);
  return {
    session: {
      async bindExtensions() {},
      async setModel() {},
      subscribe() {},
      setActiveToolsByName() {},
      getActiveToolNames() { return ['spec_dispatch', 'spec_sentinel_checkpoint', 'spec_workflow']; },
      async prompt() { await sleep(60_000); },
      extensionRunner: { async emit() {} },
      dispose() {},
    },
  };
}
`;

// One sandbox with a synthetic SDK. `env` is a private copy so the fixture never
// mutates the test process environment. An optional `into` directory lets a case
// populate an already-created package fixture directory instead of a bare temp
// dir; the default remains a fresh mkdtemp.
function makeSandbox({ into } = {}) {
  const dir = into ?? mkdtempSync(join(tmpdir(), 'wave-teardown-'));
  const sdkRoot = join(dir, 'sdk');
  mkdirSync(join(sdkRoot, 'dist'), { recursive: true });
  writeFileSync(join(sdkRoot, 'dist', 'index.js'), SYNTHETIC_SDK);
  writeFileSync(join(sdkRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', type: 'module', exports: { '.': './dist/index.js' } }));
  const sandbox = {
    dir,
    sdkRoot,
    integrationCheckout: checkout,
    packagePath: dir,
    descendantPidFile: join(dir, 'descendant.pid'),
  };
  // The driver spawns createAgentSession inside the coordinator child, so the
  // descendant pid file must travel through the child environment.
  const env = {
    ...process.env,
    SPEC_PI_SDK: sdkRoot,
    PI_CODING_AGENT_DIR: join(dir, 'agent'),
    WAVE_TEARDOWN_DESCENDANT_PID_FILE: sandbox.descendantPidFile,
  };
  mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
  return { sandbox, env };
}

// Shared body for both regressions: run the real driver through the real
// startCoordinator, force an intentional caught case error, and observe whether
// the caller-owned teardown actually resolves and takes the descendants with it.
async function runTeardownCase(t, { teardownOf, boundMs, label }) {
  const { sandbox, env } = makeSandbox();
  const registry = createProcessRegistry();
  sandbox.processRegistry = registry;
  let coordinator = null;
  let driverPid = null;
  let descendantPid = null;
  let teardownOutcome = null;
  let failure = null;

  try {
    coordinator = startCoordinator({
      sandbox,
      env,
      script: { port: 1, mode: 'teardown', case: label },
      tag: `teardown-${label}`,
    });
    const ready = await coordinator.ready;
    driverPid = ready.pid;
    assert.ok(Number.isSafeInteger(driverPid) && driverPid > 0, 'driver reports a usable pid');

    // The driver reaches ready only after createAgentSession returned, so the
    // descendant pid file is written by then; wait for it to be safe.
    descendantPid = await waitFor(
      () => readPidFile(sandbox.descendantPidFile),
      10_000,
      'the coordinator descendant pid file',
    );
    assert.notEqual(descendantPid, driverPid, 'the descendant is a distinct process');

    const observed = { driver: observePid(driverPid), descendant: observePid(descendantPid) };
    assert.ok(observed.driver.live, `driver ${driverPid} is running before teardown (state=${observed.driver.state})`);
    assert.ok(observed.descendant.live, `descendant ${descendantPid} is running before teardown (state=${observed.descendant.state})`);
    t.diagnostic(`before teardown: ${JSON.stringify(observed)}`);

    // Intentional caught case error: the case body fails, the finally below is
    // the production-shaped teardown path the fixture depends on.
    try {
      throw new Error(`intentional ${label} case error`);
    } catch (caseError) {
      assert.match(caseError.message, /intentional/);
    } finally {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => teardownOf(coordinator)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} teardown did not resolve within ${boundMs}ms`)), boundMs);
          }),
        ]);
        teardownOutcome = { resolved: true };
      } catch (teardownError) {
        teardownOutcome = { resolved: false, message: String(teardownError?.message ?? teardownError) };
      } finally {
        clearTimeout(timer);
      }
    }

    // Record the post-teardown owner observation BEFORE any emergency cleanup
    // so cleanup cannot satisfy these assertions.
    const after = { driver: observePid(driverPid), descendant: observePid(descendantPid) };
    t.diagnostic(`after teardown (${label}): ${JSON.stringify({ teardownOutcome, after })}`);

    // A zombie (state Z) or dead (X/x) task is not running; both count as gone.
    assert.equal(teardownOutcome.resolved, true,
      `${label} teardown must resolve within ${boundMs}ms once the leader's close is pending on a live `
      + `descendant holding the inherited stdio; got: ${teardownOutcome.message ?? 'unresolved'}`);
    assert.equal(after.driver.live, false,
      `${label} driver ${driverPid} is not running after teardown (state=${after.driver.state})`);
    assert.equal(after.descendant.live, false,
      `${label} descendant ${descendantPid} is not running after teardown (state=${after.descendant.state})`);
  } catch (error) {
    failure = error;
  } finally {
    // Emergency reap: never let a RED leak a coordinator process group.
    try {
      await registry.cleanup();
    } catch (cleanupError) {
      if (!failure) failure = cleanupError;
      t.diagnostic(`emergency registry cleanup failed: ${cleanupError?.message ?? String(cleanupError)}`);
    }
    try {
      await waitFor(() => (!driverPid || !observePid(driverPid).live)
        && (!descendantPid || !observePid(descendantPid).live),
        5_000, 'emergency cleanup to take both recorded pids');
    } catch (verifyError) {
      t.diagnostic(`emergency cleanup verification: ${verifyError?.message ?? String(verifyError)}`);
    }
    try { rmSync(sandbox.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  if (failure) throw failure;
}

// The kill path must resolve once the caller asks for it, not once a descendant
// voluntarily closes inherited handles.
test('wave native: coordinator kill drains the owned group', { timeout: 120000 }, async t => {
  await runTeardownCase(t, {
    // startCoordinator.kill(): SIGKILL the leader, await its close, then drain
    // the owned group. Order is the defect seam.
    teardownOf: coordinator => coordinator.kill(),
    boundMs: KILL_BOUND_MS,
    label: 'kill',
  });
});

// An intentional coordinator crash and a caller-owned teardown are different
// operations. Killing only the coordinator leader (the shape of a
// systemd-run/systemd-run --scope client that survives a coordinator-only
// SIGKILL) must leave the same-process-group descendant running; the descendant
// only goes away when the fixture's own teardown drains the group. kernel_proof
// is false here: this asserts process ownership, not SDK/Pi lifecycle.
test('wave native: coordinator crash preserves descendants until final teardown', { timeout: 120000 }, async t => {
  const { sandbox, env } = makeSandbox();
  const registry = createProcessRegistry();
  sandbox.processRegistry = registry;
  let coordinator = null;
  let driverPid = null;
  let descendantPid = null;
  let failure = null;

  try {
    coordinator = startCoordinator({
      sandbox,
      env,
      script: { port: 1, mode: 'teardown', case: 'crash' },
      tag: 'teardown-crash',
    });
    const ready = await coordinator.ready;
    driverPid = ready.pid;
    assert.ok(Number.isSafeInteger(driverPid) && driverPid > 0, 'driver reports a usable pid');

    descendantPid = await waitFor(
      () => readPidFile(sandbox.descendantPidFile),
      10_000,
      'the coordinator descendant pid file',
    );
    assert.notEqual(descendantPid, driverPid, 'the descendant is a distinct process');

    const before = { driver: observePid(driverPid), descendant: observePid(descendantPid) };
    assert.ok(before.driver.live, `driver ${driverPid} is running before the crash (state=${before.driver.state})`);
    assert.ok(before.descendant.live, `descendant ${descendantPid} is running before the crash (state=${before.descendant.state})`);
    t.diagnostic(`before crash: ${JSON.stringify(before)}`);

    // Coordinator-only kill: no group drain, so the surviving client/descendant
    // models a caller that outlives the coordinator. Prefer a dedicated crash()
    // surface when the driver grows one, otherwise the leader-only SIGKILL path.
    const crashOf = coordinator.crash ?? coordinator.kill;
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => crashOf.call(coordinator)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`crash did not resolve within ${KILL_BOUND_MS}ms`)), KILL_BOUND_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }

    // The coordinator must be gone, its descendant must still be alive.
    const afterCrash = await waitFor(() => {
      const observed = { driver: observePid(driverPid), descendant: observePid(descendantPid) };
      return observed.driver.live === false ? observed : null;
    }, KILL_BOUND_MS, `coordinator ${driverPid} to stop after the crash`);
    t.diagnostic(`after crash: ${JSON.stringify(afterCrash)}`);
    assert.equal(afterCrash.driver.live, false,
      `coordinator ${driverPid} is not running after the crash (state=${afterCrash.driver.state})`);
    assert.equal(afterCrash.descendant.live, true,
      `descendant ${descendantPid} survives a coordinator-only crash (state=${afterCrash.descendant.state}); `
      + 'crash must not be mistaken for teardown');

    // Final teardown is what takes the descendant with it.
    await coordinator.shutdown();
    const afterShutdown = { driver: observePid(driverPid), descendant: observePid(descendantPid) };
    t.diagnostic(`after shutdown: ${JSON.stringify(afterShutdown)}`);
    assert.equal(afterShutdown.descendant.live, false,
      `descendant ${descendantPid} is not running after shutdown (state=${afterShutdown.descendant.state})`);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await registry.cleanup();
    } catch (cleanupError) {
      if (!failure) failure = cleanupError;
      t.diagnostic(`emergency registry cleanup failed: ${cleanupError?.message ?? String(cleanupError)}`);
    }
    try {
      await waitFor(() => (!driverPid || !observePid(driverPid).live)
        && (!descendantPid || !observePid(descendantPid).live),
        5_000, 'emergency cleanup to take both recorded pids');
    } catch (verifyError) {
      t.diagnostic(`emergency cleanup verification: ${verifyError?.message ?? String(verifyError)}`);
    }
    try { rmSync(sandbox.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  if (failure) throw failure;
});

// The shutdown path adds the driver's 10s graceful SIGTERM window on top of the
// group drain.
test('wave native: coordinator shutdown drains the owned group', { timeout: 120000 }, async t => {
  await runTeardownCase(t, {
    // startCoordinator.shutdown(): SIGTERM, bounded 10s graceful wait, SIGKILL,
    // then drain the owned group.
    teardownOf: coordinator => coordinator.shutdown(),
    boundMs: SHUTDOWN_BOUND_MS,
    label: 'shutdown',
  });
});

// Failure-path sandbox removal: the ordered teardown must still finish the
// process work and remove the sandbox even when an earlier cleanup step throws.
// This runs the *actual* makeWaveFixture and its real process registry, but the
// installed SDK is still the synthetic module above, so kernel_proof is false:
// the assertion is about cleanup ordering and sandbox removal, not Pi lifecycle.
//
// The baseline is expected RED: package-fixture's cleanup() rethrows the first
// failure before reaching rmSync, so a throwing cleanup leaves the directory on
// disk. The assertions read only the recorded observations taken BEFORE the
// emergency reap, so neither the emergency registry cleanup nor the emergency
// rm can satisfy them.
test('wave native: teardown removes the sandbox after a cleanup failure', { timeout: 120000 }, async t => {
  const fixture = await makeWaveFixture({ members: 1 });
  // Populate the synthetic SDK inside the real fixture directory.
  const { sandbox, env } = makeSandbox({ into: fixture.dir });
  sandbox.processRegistry = fixture.processRegistry;

  // The real fixture's cleanup() calls this registry method and rethrows its
  // first failure before removing the directory, so wrapping it puts the
  // deliberate error inside package-fixture.cleanup. The bound original is
  // kept so the emergency reap can restore the method before invoking it.
  const registry = fixture.processRegistry;
  const realRegistryCleanup = registry.cleanup.bind(registry);
  const DELIBERATE_CLEANUP_ERROR = 'deliberate cleanup failure';

  let coordinator = null;
  let driverPid = null;
  let descendantPid = null;
  let teardownOutcome = null;
  let failure = null;

  try {
    coordinator = startCoordinator({
      sandbox,
      env,
      script: { port: 1, mode: 'teardown', case: 'cleanup-failure' },
      tag: 'teardown-cleanup-failure',
    });
    const ready = await coordinator.ready;
    driverPid = ready.pid;
    assert.ok(Number.isSafeInteger(driverPid) && driverPid > 0, 'driver reports a usable pid');

    descendantPid = await waitFor(
      () => readPidFile(sandbox.descendantPidFile),
      10_000,
      'the coordinator descendant pid file',
    );
    assert.notEqual(descendantPid, driverPid, 'the descendant is a distinct process');
    assert.ok(observePid(driverPid).live, `driver ${driverPid} is running before teardown`);
    assert.ok(observePid(descendantPid).live, `descendant ${descendantPid} is running before teardown`);

    // Capture the registered teardown callback instead of running it through a
    // test-level t.after, so the case controls when it is invoked and can
    // observe the failure path with a bounded timeout.
    let teardownCallback = null;
    const registrationContext = { after: callback => { teardownCallback = callback; } };
    const boot = { fixture, coordinators: [coordinator], providers: [] };
    registerNativeTeardown(registrationContext, boot);
    assert.equal(typeof teardownCallback, 'function', 'registerNativeTeardown registers a teardown callback');

    // Run the real registry cleanup, then throw the deliberate error so the
    // fixture's own cleanup observes a failure and rethrows before its rmSync.
    registry.cleanup = async () => {
      await realRegistryCleanup();
      throw new Error(DELIBERATE_CLEANUP_ERROR);
    };

    // Intentional caught case error; the registered teardown runs in finally.
    try {
      throw new Error('intentional cleanup-failure case error');
    } catch (caseError) {
      assert.match(caseError.message, /intentional/);
    } finally {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => teardownCallback()),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`cleanup-failure teardown did not resolve within ${SHUTDOWN_BOUND_MS}ms`)),
              SHUTDOWN_BOUND_MS,
            );
          }),
        ]);
        teardownOutcome = { resolved: true };
      } catch (teardownError) {
        teardownOutcome = { resolved: false, message: String(teardownError?.message ?? teardownError) };
      } finally {
        clearTimeout(timer);
      }
    }

    // Record the post-teardown observation BEFORE any emergency cleanup.
    const after = {
      driver: observePid(driverPid),
      descendant: observePid(descendantPid),
      fixtureDirExists: existsSync(fixture.dir),
    };
    t.diagnostic(`after cleanup-failure teardown: ${JSON.stringify({ teardownOutcome, after })}`);

    // The deliberate cleanup error must surface to the caller...
    assert.equal(teardownOutcome.resolved, false, 'a throwing fixture cleanup surfaces to the teardown caller');
    assert.match(teardownOutcome.message, /deliberate cleanup failure/,
      `teardown surfaces the original cleanup error; got: ${teardownOutcome.message}`);
    // ...but the process work must already be done, and the sandbox must be gone.
    assert.equal(after.driver.live, false,
      `driver ${driverPid} is not running after a failed cleanup (state=${after.driver.state})`);
    assert.equal(after.descendant.live, false,
      `descendant ${descendantPid} is not running after a failed cleanup (state=${after.descendant.state})`);
    assert.equal(after.fixtureDirExists, false,
      `fixture directory ${fixture.dir} is removed even though cleanup threw`);
  } catch (error) {
    failure = error;
  } finally {
    // Emergency reap only after the observations above: restore the real
    // registry cleanup first so the emergency reap actually runs.
    registry.cleanup = realRegistryCleanup;
    try {
      await registry.cleanup();
    } catch (cleanupError) {
      t.diagnostic(`emergency registry cleanup failed: ${cleanupError?.message ?? String(cleanupError)}`);
    }
    try {
      await waitFor(() => (!driverPid || !observePid(driverPid).live)
        && (!descendantPid || !observePid(descendantPid).live),
        5_000, 'emergency cleanup to take both recorded pids');
    } catch (verifyError) {
      t.diagnostic(`emergency cleanup verification: ${verifyError?.message ?? String(verifyError)}`);
    }
    try { rmSync(fixture.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  if (failure) throw failure;
});
