// Observe-only Sentinel host: the ordinary argv entry and a reusable factory
// composing the shared singleton claim, the headless observer and the owned
// dashboard. Importing this module creates no host, listener, child or claim.
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizePublicHost } from '../../../scripts/spec-observe/dashboard.mjs';
import { discoveryRoot } from '../../../scripts/spec-observe/discovery.mjs';
import { claimHost } from './sentinel-host-owner.mjs';
import { createSentinelDashboard } from './sentinel-dashboard.mjs';
import { createSentinelObserver } from './sentinel.mjs';

// Cleanup waits 8 s and the default bounded SQLite release may wait 2 s more;
// the whole shutdown stays inside 10 s.
const CLEANUP_DEADLINE_MS = 8000;
const RELEASE_DEADLINE_MS = 2000;
const SHUTDOWN_DEADLINE_MS = CLEANUP_DEADLINE_MS + RELEASE_DEADLINE_MS;
const MIN_PORT = 0;
const MAX_PORT = 65535;
const PORT_ERROR = `Sentinel host port must be an integer from ${MIN_PORT} to ${MAX_PORT}.`;
const STARTUP_CANCELLED = 'Sentinel host startup was cancelled.';

class StartupCancelledError extends Error {
  constructor() {
    super(STARTUP_CANCELLED);
    this.name = 'StartupCancelledError';
    this.code = 'SENTINEL_STARTUP_CANCELLED';
  }
}

function withDeadline(promise, milliseconds, message) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function existingRoot(root) {
  const canonical = discoveryRoot(root);
  let info;
  try {
    info = statSync(canonical);
  } catch (error) {
    throw new Error(`Sentinel observation root ${canonical} is unavailable (${error.code ?? error.message}).`);
  }
  if (!info.isDirectory()) throw new Error(`Sentinel observation root ${canonical} is not a directory.`);
  return canonical;
}

async function composeHost(options, signal) {
  const { agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'),
    port = 4319, publicHost, root, scope = process.env.PI_INTERCOM_SCOPE_ID ?? null } = options ?? {};
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) throw new Error(PORT_ERROR);
  if (typeof agentDir !== 'string' || agentDir.trim() === '') {
    throw new Error('Sentinel host requires a nonempty agentDir.');
  }
  const normalizedPublicHost = normalizePublicHost(publicHost);
  const canonicalRoot = root == null ? undefined : existingRoot(root);

  const claim = claimHost({ agentDir: resolve(agentDir) });
  let dashboard = null;
  let observer = null;
  let closing = null;
  let abortListener = null;

  const removeAbortListener = () => {
    if (abortListener && signal) signal.removeEventListener('abort', abortListener);
    abortListener = null;
  };

  async function cleanup() {
    let failure = null;
    try {
      await withDeadline((async () => {
        // Start every owned stop before awaiting any of them.
        const observerStopping = observer ? Promise.resolve(observer.close()) : Promise.resolve();
        const dashboardStopping = dashboard ? dashboard.stop() : Promise.resolve();
        const settled = await Promise.allSettled([observerStopping, dashboardStopping]);
        for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason;
      })(), CLEANUP_DEADLINE_MS, `Sentinel host cleanup timed out after ${CLEANUP_DEADLINE_MS} ms.`);
    } catch (error) {
      failure = error;
    }
    try {
      await withDeadline(claim.release(), RELEASE_DEADLINE_MS, `Sentinel ownership release timed out after ${RELEASE_DEADLINE_MS} ms.`);
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }

  const close = () => {
    if (!closing) {
      closing = cleanup().finally(removeAbortListener);
      // An abandoned close must not crash the host; awaiting callers still see it.
      closing.catch(() => {});
    }
    return closing;
  };

  try {
    if (signal?.aborted) throw new StartupCancelledError();
    const canonicalAgentDir = realpathSync(resolve(agentDir));
    dashboard = createSentinelDashboard({ agentDir: canonicalAgentDir, port, publicHost: normalizedPublicHost, open: () => {} });
    observer = createSentinelObserver({ agentDir: canonicalAgentDir, scope, headless: true, isolateReader: true, dashboard });
    // Registered once owned resources exist and before the first await, so a
    // startup signal closes what was already created.
    if (signal) {
      abortListener = () => { void close().catch(() => {}); };
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) {
        await close();
        throw new StartupCancelledError();
      }
    }
    const lifecycle = await observer.lifecycle({ action: 'observe', root: canonicalRoot });
    if (signal?.aborted) {
      await close();
      throw new StartupCancelledError();
    }
    if (!lifecycle || lifecycle.error) {
      throw new Error(`Sentinel observation failed: ${lifecycle?.error ?? 'no lifecycle receipt'}.`);
    }
    if (lifecycle.fenced) throw new Error('Sentinel observation was fenced by a newer lifecycle change.');
    if (lifecycle.state !== 'observing') {
      throw new Error(`Sentinel observation did not start (state: ${lifecycle.state ?? 'unknown'}).`);
    }
    if (!lifecycle.snapshot_path) throw new Error('Sentinel observation has no snapshot path.');
    if (!dashboard.url) process.stderr.write(`Sentinel dashboard unavailable on port ${port}; observation continues.\n`);
    const receipt = {
      type: 'ready',
      state: lifecycle.state,
      snapshot_path: lifecycle.snapshot_path,
      dashboard_url: dashboard.url ?? null,
      dashboard_state: dashboard.url ? 'ready' : 'unavailable',
    };
    return { receipt, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new Error(`${error.message} Sentinel cleanup also failed: ${cleanup.message}`, { cause: error });
    }
    throw error;
  }
}

export async function createSentinelHost(options = {}) {
  return composeHost(options, null);
}

function parseSentinelHostArguments(argv) {
  const options = {};
  const seen = new Set();
  const apply = {
    '--agent-dir': value => { options.agentDir = value; },
    '--root': value => { options.root = value; },
    '--port': value => {
      if (!/^\d+$/.test(value)) throw new Error(PORT_ERROR);
      const port = Number(value);
      if (port < MIN_PORT || port > MAX_PORT) throw new Error(PORT_ERROR);
      options.port = port;
    },
    '--public-host': value => { options.publicHost = value; },
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!Object.hasOwn(apply, flag)) throw new Error(`Unknown sentinel host argument: ${flag}.`);
    if (seen.has(flag)) throw new Error(`Duplicate sentinel host argument: ${flag}.`);
    seen.add(flag);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    apply[flag](value);
  }
  return options;
}

async function main(argv) {
  const options = parseSentinelHostArguments(argv);
  const controller = new AbortController();
  let shuttingDown = false;
  let shutdownPromise = null;
  let pending = null;
  const finish = async () => {
    shuttingDown = true;
    controller.abort();
    let failure = null;
    try {
      // The deadline covers awaiting initialization and closing the created
      // handle, so a hung startup cannot wait forever.
      await withDeadline((async () => {
        let created = null;
        let startupFailure = null;
        try {
          created = pending ? await pending : null;
        } catch (error) {
          startupFailure = error;
        }
        if (created) await created.close();
        // A cancelled startup is a clean shutdown only when composeHost
        // confirmed cleanup. Real factory errors and cancellation with a
        // cleanup failure stay visible and exit nonzero.
        if (startupFailure && !(startupFailure instanceof StartupCancelledError)) throw startupFailure;
      })(), SHUTDOWN_DEADLINE_MS, `Sentinel host shutdown timed out after ${SHUTDOWN_DEADLINE_MS} ms.`);
    } catch (error) {
      failure = error;
    }
    if (failure) {
      process.stderr.write(`Sentinel host shutdown failed: ${failure.message}\n`);
      process.exitCode = 1;
    }
    process.exit(process.exitCode ?? 0);
  };
  const shutdown = () => {
    shutdownPromise ??= finish();
    return shutdownPromise;
  };
  // Installed before initialization starts: a signal during startup aborts the
  // controller and awaits the created handle instead of printing ready.
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  pending = composeHost(options, controller.signal);
  let handle;
  try {
    handle = await pending;
  } catch (error) {
    if (shuttingDown) { await shutdown(); return; }
    throw error;
  }
  if (shuttingDown) { await shutdown(); return; }
  process.stdout.write(`${JSON.stringify(handle.receipt)}\n`);
  return handle;
}

function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`Sentinel host failed: ${error.message}\n`);
    process.exit(1);
  });
}
