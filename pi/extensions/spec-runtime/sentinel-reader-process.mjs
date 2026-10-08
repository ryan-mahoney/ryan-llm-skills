// Scans and recursive watchers live outside Pi's UI process. This process is
// observation-only: no models, worker control, recovery grants or repo writes.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function createSentinelReaderProcess({ onChange = () => {}, onError = () => {},
  timeoutMs = 10000, workerFile = fileURLToPath(import.meta.url), cooldownMs = 15000 } = {}) {
  let child = null, pending = null, stopping = null, serial = 0, retryAt = 0;
  let targets = [];
  function terminate(error) {
    const old = child;
    child = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; }
    if (old) {
      // Owned read-only helper only. SIGKILL also releases blocked native watchers.
      const stopped = new Promise((resolve, reject) => {
        if (old.exitCode !== null || old.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => reject(new Error('Sentinel reader cleanup exceeded 1000 ms.')), 1000);
        old.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      // Failure paths may not await termination; stop callers still receive the
      // original promise and can confirm cleanup before returning one-shot data.
      const cleanup = stopped.finally(() => { if (stopping === cleanup) stopping = null; });
      stopping = cleanup;
      cleanup.catch(() => {});
      old.kill('SIGKILL');
      old.unref();
      return cleanup;
    }
    return stopping ?? Promise.resolve();
  }
  function start() {
    if (child) return child;
    if (Date.now() < retryAt) throw new Error('Sentinel reader cooling down after a failed scan; next reconciliation retries.');
    const spawned = fork(workerFile, ['--sentinel-observer-child'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
    });
    child = spawned;
    const failed = message => {
      if (child !== spawned) return;
      retryAt = Date.now() + cooldownMs;
      terminate(new Error(message));
      onError(message);
    };
    spawned.on('error', error => failed(`Sentinel reader unavailable: ${error.code ?? error.message}`));
    spawned.on('exit', (code, signal) => failed(`Sentinel reader exited (${signal ?? code}); last facts retained.`));
    spawned.on('message', message => {
      if (child !== spawned) return;
      if (message.type === 'change') onChange();
      else if (message.type === 'watch-error') onError(message.error);
      else if (message.id === pending?.id && message.type === 'result') {
        const request = pending; pending = null; clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.value);
      }
    });
    return spawned;
  }
  function send(message) {
    const receiver = start();
    receiver.send(message, error => {
      if (error && child === receiver) {
        retryAt = Date.now() + cooldownMs;
        terminate(error);
        onError(`Sentinel reader channel unavailable: ${error.code ?? error.message}`);
      }
    });
  }
  return {
    read(options) {
      if (pending) return pending.promise;
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const id = ++serial;
      const timer = setTimeout(() => {
        retryAt = Date.now() + cooldownMs;
        const error = new Error(`Sentinel scan exceeded ${timeoutMs} ms; reader stopped, last facts retained.`);
        terminate(error);
        onError(error.message);
      }, timeoutMs);
      pending = { id, promise, resolve, reject, timer };
      try { send({ type: 'read', id, options, targets }); }
      catch (error) { terminate(error); }
      return promise;
    },
    watch(next) {
      targets = next;
      if (child) send({ type: 'watch', targets });
    },
    stop() { targets = []; return terminate(new Error('Sentinel observation stopped.')); },
  };
}

if (process.argv[2] === '--sentinel-observer-child') {
  const { collectWorkspace, readEnrollments } = await import('../../../scripts/spec-observe/sentinel.mjs');
  const { createRepositoryDiscovery } = await import('../../../scripts/spec-observe/discovery.mjs');
  const { watchSpecTree } = await import('./spec-watcher.mjs');
  const watchers = new Map();
  let discovery, discoveryKey, changeTimer;
  const send = value => { if (process.connected) process.send(value, () => {}); };
  const changed = () => {
    if (changeTimer) return;
    changeTimer = setTimeout(() => { changeTimer = null; send({ type: 'change' }); }, 1000);
  };
  function watchTargets(targets) {
    const wanted = targets.slice(0, 60);
    for (const [path, watcher] of watchers) if (!wanted.includes(path)) {
      watchers.delete(path); Promise.resolve(watcher.close()).catch(() => {});
    }
    for (const path of wanted) {
      if (watchers.has(path)) continue;
      try {
        const watcher = watchSpecTree(path, changed);
        watchers.set(path, watcher);
        watcher.on('error', error => {
          watchers.delete(path); Promise.resolve(watcher.close()).catch(() => {});
          send({ type: 'watch-error', error: `Spec watcher unavailable (${error.code ?? 'unknown'}); periodic reconciliation continues.` });
        });
      } catch (error) { send({ type: 'watch-error', error: `Spec watcher unavailable (${error.code ?? 'unknown'}); periodic reconciliation continues.` }); }
    }
  }
  process.on('disconnect', () => process.exit(0));
  process.on('message', async message => {
    if (message.type === 'watch') { watchTargets(message.targets); return; }
    if (message.type !== 'read') return;
    try {
      const started = performance.now();
      const options = message.options;
      const key = JSON.stringify([options.agentDir, options.root]);
      if (key !== discoveryKey) {
        discoveryKey = key;
        discovery = createRepositoryDiscovery({ agentDir: options.agentDir, root: options.root });
      }
      const enrolled = await readEnrollments(options);
      const found = await discovery.read();
      const roots = [...new Set([...enrolled.roots, ...found.roots])];
      const snapshot = await collectWorkspace({ ...options, roots, discovery: found, enrollmentErrors: enrolled.errors });
      snapshot.reader = { isolated: true, pid: process.pid, runtime: process.release.name, runtime_version: process.version, scan_ms: Math.round(performance.now() - started) };
      send({ type: 'result', id: message.id, value: { snapshot, roots, discovery: found, enrollmentErrors: enrolled.errors } });
      watchTargets(message.targets);
    } catch (error) { send({ type: 'result', id: message.id, error: error.message }); }
  });
}
