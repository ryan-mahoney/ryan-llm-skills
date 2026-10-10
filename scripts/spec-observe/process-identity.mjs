// Shared PID/start-time identity observation. The OS start text is opaque: it
// is compared exactly and never parsed as a date. Only ESRCH is confirmed dead;
// timeout, permission failure, malformed output and inconclusive probes are
// unknown and must never authorize signalling or reclaim.
import { execFileSync } from 'node:child_process';

const defaultRun = pid => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
  env: { ...process.env, LC_ALL: 'C' },
  encoding: 'utf8',
  timeout: 2000,
  maxBuffer: 4096,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const defaultProbe = pid => process.kill(pid, 0);

function isUnknownRunFailure(error) {
  const code = error && error.code;
  return code === 'ETIMEDOUT' || code === 'EPERM' || code === 'EACCES' || Boolean(error && error.signal);
}

function probeFallback(pid, probe, reason) {
  try {
    probe(pid);
    return { state: 'unknown', pid, reason };
  } catch (error) {
    if (error && error.code === 'ESRCH') return { state: 'dead', pid };
    return { state: 'unknown', pid, reason: (error && error.code) || 'probe-failed' };
  }
}

export function inspectProcess(pid, { run = defaultRun, probe = defaultProbe } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown', pid, reason: 'invalid-pid' };
  let output;
  try {
    output = run(pid);
  } catch (error) {
    if (isUnknownRunFailure(error)) return { state: 'unknown', pid, reason: (error && error.code) || 'timeout' };
    return probeFallback(pid, probe, (error && error.code) || 'run-failed');
  }
  const started_at = typeof output === 'string' ? output.trim() : '';
  if (started_at) return { state: 'alive', pid, started_at };
  return probeFallback(pid, probe, 'empty-output');
}

export function processIdentity(pid, options = {}) {
  const observed = inspectProcess(pid, options);
  return observed.state === 'alive' ? { pid: observed.pid, started_at: observed.started_at } : null;
}

export function sameProcess(identity, options = {}) {
  if (!identity || typeof identity !== 'object') return false;
  const pid = identity.pid;
  const started_at = identity.started_at;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (typeof started_at !== 'string' || started_at.length === 0) return false;
  const fresh = processIdentity(pid, options);
  return fresh !== null && fresh.pid === pid && fresh.started_at === started_at;
}
