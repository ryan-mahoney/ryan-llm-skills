// An explicitly invoked monitor owns one disposable localhost dashboard service.
import { fork, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverFile = fileURLToPath(new URL('../../../scripts/spec-observe/dashboard.mjs', import.meta.url));
function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 5000 }, error => error ? reject(error) : resolve()));
}
export function createSentinelDashboard({ agentDir, launch = fork, open = openBrowser, timeoutMs = 5000 } = {}) {
  let owned = null, starting = null, address = null;
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
        child.kill('SIGKILL'); child.unref();
        reject(error);
      };
      try {
        child = launch(serverFile, ['--port', '0', '--agent-dir', agentDir], {
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
      if (child) { child.kill('SIGKILL'); child.unref(); }
    },
  };
}
