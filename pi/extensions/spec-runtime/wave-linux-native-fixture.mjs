// EV-14 native Linux wave fixture.
//
// The Linux rehearsal runs the real wave stack on a real user manager: no
// shims, no setup commands and no host modification. This module only composes
// the existing owners — the wave fixture, the sandbox HOME writer, the support
// environment and the service helper — with the actual loopback provider and
// coordinator driver, and owns the ordered teardown.
//
// package-fixture.mjs reexports this module, so makeWaveFixture is imported
// from its own owner and only ever called inside bootLinuxWave (never at module
// top level) to avoid a circular import at evaluation time.
import { chmodSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { makeWaveFixture } from './package-fixture.mjs';
import { writeSandboxHome } from './wave-native-fixture.mjs';
import { startLoopbackProvider, writeLoopbackExtension } from './wave-native-provider.mjs';
import { startCoordinator } from './wave-native-driver.mjs';
import {
  DIAG_TEXT_LIMIT,
  boundedText,
  collectRuntimeRunDiagnostics,
} from './wave-native-diagnostics.mjs';
import { linuxEnvironment, makeLinuxServices } from './wave-linux-support.mjs';

// A bounded, useful slice of a coordinator's stderr: enough to diagnose a
// startup failure without retaining a whole transcript.
const COORDINATOR_STDERR_LIMIT = DIAG_TEXT_LIMIT;

// Only the last tool messages and the request routes are retained; full
// prompts would be large and are not needed to diagnose a failure.
function providerRequestDiagnostics(providers) {
  const records = [];
  for (const entry of providers) {
    const requests = Array.isArray(entry.requests) ? entry.requests : [];
    records.push({
      ev: 'EV-14',
      kind: 'loopback-provider',
      tag: entry.tag ?? null,
      port: entry.port ?? null,
      violations: Array.isArray(entry.violations) ? entry.violations.length : 0,
      requests: requests.slice(-8).map(request => ({
        role: request?.route?.role ?? null,
        step: request?.route?.record?.step_number ?? request?.route?.record?.step ?? null,
        phase: request?.route?.record?.phase ?? null,
        pid: request?.route?.pid ?? null,
        turn: request?.turn ?? null,
        last_tool_messages: (request?.body?.messages ?? [])
          .filter(message => message?.role === 'tool')
          .slice(-2)
          .map(message => boundedText(typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''), COORDINATOR_STDERR_LIMIT)),
      })),
    });
  }
  return records;
}

function coordinatorDiagnostics(coordinators) {
  return coordinators.map(coordinator => ({
    ev: 'EV-14',
    kind: 'coordinator',
    tag: coordinator.tag ?? null,
    pid: coordinator.pid ?? null,
    stderr: boundedText(typeof coordinator.stderr === 'string' ? coordinator.stderr : '', COORDINATOR_STDERR_LIMIT),
  }));
}

// Delete only when the key exists, so a missing key is never reported as an
// override of the real environment.
function assignIfPresent(env, name, value) {
  if (value === undefined || value === null || value === '') return;
  env[name] = value;
}

// The kernel creates each overlay workdir's work/ subdirectory with mode 000. Node 22's
// recursive rmSync tolerated that, but Node 24's does not and fails with EACCES, so give
// the owner access to every directory before the fixture tree is removed.
function grantOwnerAccess(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return;
  if ((stat.mode & 0o700) !== 0o700) chmodSync(path, stat.mode | 0o700);
  for (const name of readdirSync(path)) grantOwnerAccess(join(path, name));
}

// Boot one real Linux wave case. Every owned identity is registered for
// teardown before the case body runs, and the fixture root is removed only
// after every service reports a positive clean result.
export async function bootLinuxWave(t, facts, options = {}) {
  const providers = [];
  const coordinators = [];
  let services = null;
  let fixture = null;
  let torndown = false;
  // Teardown is registered before any operation can fail, so a partially
  // constructed case still shuts down and cleans up everything it owns.
  if (t && typeof t.after === 'function') t.after(() => teardown());

  fixture = await makeWaveFixture(options);

  const sandbox = writeSandboxHome(fixture.dir, {
    extensionPath: join(fixture.dir, 'wave-loopback-extension.mjs'),
    livePolicy: true,
  });
  // The sandbox holds an unmodified copy of the operator's saved policy, so the
  // width the waves admit is the width the installed policy admits.

  // The sandbox and the fixture root are the only writable state: HOME, the
  // Pi agent dir, both XDG roots and the storage root all resolve inside them.
  const env = linuxEnvironment(process.env);
  assignIfPresent(env, 'HOME', sandbox.home);
  assignIfPresent(env, 'PI_CODING_AGENT_DIR', sandbox.agentDir);
  assignIfPresent(env, 'XDG_CONFIG_HOME', sandbox.configHome);
  assignIfPresent(env, 'XDG_DATA_HOME', sandbox.dataHome);
  assignIfPresent(env, 'ADJACENT_STORAGE_ROOT', fixture.root);
  assignIfPresent(env, 'SPEC_PI_SDK', facts?.pi?.sdkRoot);

  // Keep the real node and the installed Pi bin ahead of the operator PATH; the
  // rest of PATH (node, git, bwrap, systemctl) stays the operator's real one.
  const nodeDir = dirname(process.execPath);
  const piBin = facts?.pi?.bin ?? null;
  const realPath = typeof process.env.PATH === 'string' ? process.env.PATH : '';
  const pathParts = [];
  if (typeof fixture.promotionBin === 'string' && fixture.promotionBin !== '') {
    pathParts.push(fixture.promotionBin);
  }
  pathParts.push(nodeDir);
  if (piBin !== null) pathParts.push(dirname(piBin));
  if (realPath !== '') pathParts.push(realPath);
  env.PATH = [...new Set(pathParts)].join(':');

  services = makeLinuxServices(t, {
    root: fixture.dir,
    runDir: join(fixture.packagePath, 'runtime', 'runs'),
  });

  const state = { fixture, sandbox, env, services, providers, coordinators, diagnostics: [] };

  async function teardown() {
    if (torndown) return;
    torndown = true;
    const failures = [];

    // Case-registered post-mortems run first, while the fixture and the observed
    // coordinator state still exist. A diagnostic failure is reported but never
    // prevents the resource cleanup below.
    for (const callback of state.diagnostics) {
      try { await callback(); }
      catch (error) {
        if (t && typeof t.diagnostic === 'function')
          t.diagnostic(`EV-14 diagnostic callback failed: ${error && error.message ? error.message : String(error)}`);
      }
    }

    if (t && typeof t.diagnostic === 'function') {
      for (const record of coordinatorDiagnostics(coordinators)) {
        t.diagnostic(JSON.stringify(record));
      }
      for (const record of providerRequestDiagnostics(providers)) {
        t.diagnostic(JSON.stringify(record));
      }
      if (fixture !== null) {
        try {
          t.diagnostic(JSON.stringify(collectRuntimeRunDiagnostics(fixture)));
        } catch (error) {
          t.diagnostic(`EV-14 run diagnostics unavailable: ${error && error.message ? error.message : String(error)}`);
        }
      }
    }

    // Coordinators first: they are the writers whose exit releases the services.
    for (const coordinator of coordinators) {
      try {
        await coordinator.shutdown();
      } catch (error) {
        failures.push(`coordinator ${coordinator.tag ?? coordinator.pid} shutdown: ${error && error.message ? error.message : String(error)}`);
      }
    }
    for (const provider of providers) {
      try {
        await provider.close();
      } catch (error) {
        failures.push(`provider ${provider.tag ?? provider.port} close: ${error && error.message ? error.message : String(error)}`);
      }
    }
    let servicesClean = false;
    if (services !== null) {
      try {
        await services.close();
        servicesClean = services.clean === true;
      } catch (error) {
        failures.push(`services: ${error && error.message ? error.message : String(error)}`);
      }
    }
    if (servicesClean && failures.length === 0 && fixture !== null) {
      try {
        grantOwnerAccess(fixture.dir);
        await fixture.cleanup();
      } catch (error) {
        failures.push(`fixture cleanup: ${error && error.message ? error.message : String(error)}`);
      }
    } else if (t && typeof t.diagnostic === 'function') {
      t.diagnostic(`EV-14 retained ${fixture.dir} for inspection (services clean=${servicesClean})`);
    }

    if (failures.length > 0) {
      const message = `EV-14 teardown failures: ${failures.join('; ')}`;
      if (t && typeof t.diagnostic === 'function') t.diagnostic(message);
      throw new AggregateError(failures.map(detail => new Error(detail)), message);
    }
  }

  // One started phase pair: provider live and pushed immediately, then the
  // extension written, the barrier armed before the coordinator exists, and the
  // coordinator started only afterwards.
  async function start({ script, tag, arm } = {}) {
    if (typeof tag !== 'string' || tag === '') throw new Error('bootLinuxWave start requires a tag');
    const provider = await startLoopbackProvider({ script });
    providers.push(Object.assign(provider, { tag }));
    writeLoopbackExtension(fixture.dir, provider.port);
    if (typeof arm === 'function') arm(provider);
    const coordinator = await startCoordinator({
      sandbox: fixture,
      env,
      script: { ...script, port: provider.port },
      tag,
    });
    coordinators.push(Object.assign(coordinator, { tag }));
    await coordinator.ready;
    return { provider, coordinator };
  }

  return { ...state, start };
}
