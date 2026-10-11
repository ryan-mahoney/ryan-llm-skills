// An explicitly invoked monitor owns one disposable localhost dashboard service.
import { fork, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createDashboardServer } from '../../../scripts/spec-observe/dashboard.mjs';

const serverFile = fileURLToPath(new URL('../../../scripts/spec-observe/dashboard.mjs', import.meta.url));
function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 5000 }, error => error ? reject(error) : resolve()));
}
export function createSentinelDashboard({ agentDir, port = 0, publicHost, launch = fork, open = openBrowser, timeoutMs = 5000 } = {}) {
  let owned = null, starting = null, address = null, stopping = null;
  // Stop only this owned handle. The promise settles when the owned child
  // exits, and repeated stops share it instead of returning before exit.
  function terminate(child) {
    if (stopping && stopping.child === child) return stopping.promise;
    const promise = new Promise((resolve, reject) => {
      if (child.exitCode != null || child.signalCode != null) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error('Dashboard helper cleanup exceeded 1000 ms.')), 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGKILL');
      child.unref();
    });
    stopping = { child, promise };
    // An abandoned stop must not crash the host; awaiting callers still see it.
    promise.catch(() => {});
    return promise;
  }
  return {
    get url() { return address; },
    start() {
      if (starting) return starting.promise;
      if (owned && address) return Promise.resolve({ url: address });
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const pending = { promise, reject, timer: null };
      starting = pending;
      let child;
      const fail = error => {
        if (owned !== child) return;
        clearTimeout(pending.timer);
        owned = null; address = null; starting = null;
        terminate(child);
        reject(error);
      };
      try {
        const args = ['--port', String(port), '--agent-dir', agentDir];
        if (publicHost != null) args.push('--public-host', publicHost);
        child = launch(serverFile, args, {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
        });
        owned = child;
        pending.timer = setTimeout(() => fail(new Error('Dashboard startup timed out.')), timeoutMs);
        child.on('error', fail);
        child.on('exit', () => fail(new Error('Dashboard service stopped.')));
        child.on('message', message => {
          if (owned === child && message.type === 'error') { fail(new Error(`Dashboard service failed: ${message.error}`)); return; }
          if (owned !== child || message.type !== 'ready' || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(message.url) || address) return;
          clearTimeout(pending.timer);
          address = message.url;
          // Defer browser opening so a racing off/close can revoke startup first.
          Promise.resolve().then(async () => {
            if (owned !== child) return;
            let browserError = null;
            try { await open(message.url); } catch { browserError = 'Browser could not open automatically.'; }
            if (owned !== child) return;
            starting = null;
            resolve({ url: message.url, browserError });
          });
        });
      } catch (error) {
        if (child) fail(error);
        else { starting = null; reject(error); }
      }
      return promise;
    },
    stop() {
      const child = owned;
      owned = null; address = null;
      if (starting) {
        clearTimeout(starting.timer);
        starting.reject(new Error('Dashboard startup cancelled.'));
        starting = null;
      }
      if (child) return terminate(child);
      return stopping ? stopping.promise : Promise.resolve();
    },
  };
}

export function createDirectDashboard({ agentDir, port = 0, publicHost, discussion } = {}) {
  let owned = null, starting = null, address = null, stopping = null;
  // Close only this owned listener. The promise settles when the listener
  // reports close, and repeated stops of the same listener share it.
  function terminate(server) {
    if (stopping && stopping.server === server) return stopping.promise;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Dashboard cleanup exceeded 1000 ms.')), 1000);
      server.closeAllConnections();
      server.close(() => { clearTimeout(timer); resolve(); });
    });
    stopping = { server, promise };
    // An abandoned stop must not crash the host; awaiting callers still see it.
    promise.catch(() => {});
    return promise;
  }
  return {
    get url() { return address; },
    start() {
      if (starting) return starting.promise;
      if (owned && address) return Promise.resolve({ url: address, browserError: null });
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      let server;
      try { server = createDashboardServer({ agentDir, publicHost, discussion }); }
      catch (error) { reject(new Error(`Dashboard service failed: ${error.code ?? error.message}`)); return promise; }
      const record = { promise, reject };
      starting = record;
      owned = server;
      const fail = error => {
        if (starting !== record) return;
        starting = null;
        if (owned === server) owned = null;
        address = null;
        reject(new Error(`Dashboard service failed: ${error.code ?? error.message}`));
      };
      server.on('error', fail);
      server.once('listening', () => {
        // A cancelled start must not resurrect the URL; close a late binding.
        if (starting !== record) { server.close(); return; }
        starting = null;
        address = `http://127.0.0.1:${server.address().port}/`;
        resolve({ url: address, browserError: null });
      });
      try { server.listen(port, '127.0.0.1'); }
      catch (error) { fail(error); }
      return promise;
    },
    stop() {
      const server = owned, pending = starting;
      owned = null; address = null;
      if (pending) {
        starting = null;
        pending.reject(new Error('Dashboard startup cancelled.'));
      }
      if (server) return terminate(server);
      if (stopping) return stopping.promise;
      stopping = { server: null, promise: Promise.resolve() };
      return stopping.promise;
    },
  };
}
