// Own the OS process groups the waves fixture spawns so a leader's exit can
// never hide a live descendant. A registry entry is keyed by the detached
// leader's pid (which is also its process-group id) and it is retained after the
// leader closes. Identity is the /proc starttime, so a pgid the kernel later
// reuses for an unrelated group is never mistaken for an owned one. Only a
// positively observed dead group is reported drained; an unreadable, malformed
// or otherwise inconclusive /proc observation is unknown and is never converted
// to confirmed.
import { readFileSync, readdirSync } from 'node:fs';

const DEFAULT_PROC_ROOT = '/proc';
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// A task in state Z (zombie) or X/x (dead) holds no live process. Running,
// sleeping, disk sleep, traced, stopped and waking states are all live.
export function isLiveProcessState(state) {
  return typeof state === 'string' && state.length > 0 && state !== 'Z' && state !== 'X' && state !== 'x';
}

// Parse /proc/<pid>/stat. The parenthesized comm field may itself contain spaces
// and parentheses, so split on the final ')'. After it the fields are
// `state ppid pgrp session ... starttime(22)`: pgrp is tail index 2 and
// starttime is tail index 19. Anything malformed returns null (unknown).
export function parseProcStat(raw) {
  if (typeof raw !== 'string') return null;
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open <= 0 || close <= open) return null;
  const pid = Number(raw.slice(0, open).trim());
  const tail = raw.slice(close + 1).trim().split(/\s+/);
  const state = tail[0];
  const pgrp = Number(tail[2]);
  const starttime = tail[19];
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  // pgrp 0 is a valid kernel/non-owned task pgrp (e.g. kthreadd); it is not
  // owned by any registry group, so scan excludes it by pgid. Only a negative
  // or otherwise unsafe pgrp is malformed.
  if (!Number.isSafeInteger(pgrp) || pgrp < 0) return null;
  if (typeof state !== 'string' || state.length === 0) return null;
  if (typeof starttime !== 'string' || starttime.length === 0) return null;
  return { pid, state, pgrp, starttime };
}

// Create a registry of spawned detached child process groups. All options are
// injectable so the registry can be unit tested without touching the real /proc
// or signalling real process groups.
export function createProcessRegistry(options = {}) {
  const {
    procRoot = DEFAULT_PROC_ROOT,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    now = () => Date.now(),
    kill = (pid, signal) => process.kill(pid, signal),
    readFile = readFileSync,
    readDir = readdirSync
  } = options;

  const groups = new Map();
  let cleanupPromise = null;
  let cleaned = false;

  const readStat = pid => {
    try {
      return { state: 'read', value: parseProcStat(readFile(`${procRoot}/${pid}/stat`, 'utf8')) };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { state: 'gone' };
      return { state: 'unknown', reason: (error && error.code) || 'stat-read-failed' };
    }
  };

  // Observe every task whose /proc pgrp equals `pgid`. Unreadable tasks are
  // returned as unknown observations rather than dropped, so a caller that
  // cannot positively confirm the group must treat it as unconfirmed.
  const scan = pgid => {
    const members = [];
    const unknown = [];
    let names;
    try {
      names = readDir(procRoot);
    } catch (error) {
      return { members, unknown: [{ reason: (error && error.code) || 'proc-unreadable' }], leader: null };
    }
    let leader = null;
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      const observed = readStat(pid);
      if (observed.state === 'gone') continue;
      if (observed.state === 'unknown') { unknown.push({ pid, reason: observed.reason }); continue; }
      const stat = observed.value;
      if (!stat) { unknown.push({ pid, reason: 'malformed-stat' }); continue; }
      if (stat.pgrp !== pgid) continue;
      if (pid === pgid) leader = stat;
      members.push(stat);
    }
    return { members, unknown, leader };
  };

  // Classify one owned group into `live`, `drained` or `unknown`. When the
  // recorded leader starttime no longer matches the process now holding the
  // leader pid, the kernel has reused the pgid: our group is gone. A missing
  // leader with live members is the orphaned-descendant case and stays live.
  const classify = entry => {
    const { members, unknown, leader } = scan(entry.pgid);
    if (unknown.length) return { status: 'unknown', unknown, members };
    if (entry.startedAt && leader && leader.starttime !== entry.startedAt)
      return { status: 'drained', members: [] };
    const live = members.filter(member => isLiveProcessState(member.state));
    if (live.length) return { status: 'live', live, members };
    return { status: 'drained', members };
  };

  // Await the owned leader's close with a bounded wait. A timeout is not
  // confirmation: the caller must still poll /proc for the whole group.
  const waitForClose = child => {
    if (!child) return Promise.resolve();
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('close', finish);
        resolve();
      };
      const timer = setTimeout(finish, closeTimeoutMs);
      timer.unref?.();
      child.once('close', finish);
    });
  };

  const killGroup = entry => {
    try {
      kill(-entry.pgid, 'SIGKILL');
      return null;
    } catch (error) {
      // ESRCH is the only confirmed-dead outcome; anything else is a real
      // failure that must surface instead of becoming a confirmed drain.
      if (error && error.code === 'ESRCH') return null;
      return error;
    }
  };

  // Poll /proc until every named group is positively drained. Unknown remains
  // unknown: it is reported as an unconfirmed cleanup failure, never confirmed.
  const pollUntilDrained = async (entries, killErrors) => {
    const deadline = now() + cleanupTimeoutMs;
    for (;;) {
      const pending = [];
      const unknown = [];
      for (const entry of entries) {
        const status = classify(entry);
        if (status.status === 'live') pending.push({ pid: entry.pid, pgid: entry.pgid, members: status.live });
        else if (status.status === 'unknown') unknown.push({ pid: entry.pid, details: status.unknown });
      }
      if (!pending.length && !unknown.length) return;
      if (now() >= deadline) {
        throw new Error('fixture process registry could not positively confirm drain: '
          + JSON.stringify({ pending, unknown, killErrors: killErrors.map(error => String(error?.message ?? error)) }));
      }
      await delay(pollIntervalMs);
    }
  };

  // Record a detached child's process group. Group membership is kept even
  // after the child closes so a surviving descendant is still observed.
  const register = child => {
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0)
      throw new Error('fixture process registry requires a detached child with a valid pid');
    const existing = groups.get(child.pid);
    if (existing) return existing;
    const observed = readStat(child.pid);
    const startedAt = observed.state === 'read' && observed.value ? observed.value.starttime : null;
    const entry = { pid: child.pid, pgid: child.pid, startedAt, identityKnown: startedAt !== null, child, closed: false };
    child.once('close', () => { entry.closed = true; });
    groups.set(child.pid, entry);
    return entry;
  };

  // Resolve only when every owned group is positively confirmed drained. A live
  // non-zombie member or an inconclusive observation rejects.
  const assertDrained = async () => {
    const offenders = [];
    const unknown = [];
    for (const entry of groups.values()) {
      const status = classify(entry);
      if (status.status === 'live') offenders.push({ pid: entry.pid, pgid: entry.pgid, members: status.live });
      else if (status.status === 'unknown') unknown.push({ pid: entry.pid, details: status.unknown });
    }
    if (offenders.length || unknown.length)
      throw new Error(`fixture process registry is not drained: ${JSON.stringify({ offenders, unknown })}`);
  };

  // Positively confirm one group (no signal). Used by the adapter's drain path.
  const assertGroupDrained = async pgidOrPid => {
    const entry = groups.get(pgidOrPid);
    if (!entry) return;
    const status = classify(entry);
    if (status.status === 'live')
      throw new Error(`fixture process group ${entry.pgid} is still live: ${JSON.stringify(status.live)}`);
    if (status.status === 'unknown')
      throw new Error(`fixture process group ${entry.pgid} could not be observed: ${JSON.stringify(status.unknown)}`);
  };

  // SIGKILL one owned group and positively confirm it drained. Unknown fails.
  const drainGroup = async pgidOrPid => {
    const entry = groups.get(pgidOrPid);
    if (!entry) return;
    const initial = classify(entry);
    if (initial.status === 'drained') return assertGroupDrained(pgidOrPid);
    if (initial.status === 'unknown')
      throw new Error(`fixture process group ${entry.pgid} could not be observed before drain: ${JSON.stringify(initial.unknown)}`);
    const killError = killGroup(entry);
    await waitForClose(entry.child);
    await pollUntilDrained([entry], killError ? [killError] : []);
  };

  // Idempotently SIGKILL every owned group that is still live and confirm all
  // owned groups drained. Failure is never swallowed: an unconfirmed group
  // clears the memoized promise and rethrows so a later call can retry.
  const cleanup = () => {
    if (cleaned) return Promise.resolve();
    if (cleanupPromise) return cleanupPromise;
    const snapshot = [...groups.values()];
    cleanupPromise = (async () => {
      const killErrors = [];
      for (const entry of snapshot) {
        const status = classify(entry);
        // Signal only groups we can attribute as ours and still live. Drained
        // groups need no signal; unknown is not attributable and stays unknown.
        if (status.status !== 'live') continue;
        const killError = killGroup(entry);
        if (killError) killErrors.push(killError);
      }
      await Promise.all(snapshot.map(entry => waitForClose(entry.child)));
      await pollUntilDrained(snapshot, killErrors);
      cleaned = true;
    })().catch(error => {
      cleanupPromise = null;
      throw error;
    });
    return cleanupPromise;
  };

  return {
    register,
    assertDrained,
    assertGroupDrained,
    drainGroup,
    cleanup,
    groups,
    size: () => groups.size,
    observe: pgidOrPid => {
      const entry = groups.get(pgidOrPid);
      return entry ? classify(entry) : { status: 'unknown', unknown: [{ reason: 'unregistered' }] };
    }
  };
}
