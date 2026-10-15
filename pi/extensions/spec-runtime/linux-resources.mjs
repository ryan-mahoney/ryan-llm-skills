// Linux resource policy, wave deadlines and effective-user bus resolution.
//
// These are the pure foundations used by the managed systemd adapter: admission
// is computed from exact integer bytes, phase RuntimeMaxSec derives from the
// persisted wave deadline, and the effective user's runtime directory and
// session bus resolve from filesystem metadata. This module performs no OS
// setup and no provider calls. checkRuntimeHost() below performs the bounded
// argv-only host preflight, including an explicitly requested isolated
// transient-service probe; it changes no host state and never launches
// unbounded. setupRuntimeHost() composes that preflight with the owned,
// idempotent host policy/slice install and refuses any foreign or live state.
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir, totalmem } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOFTWARE_CEILING, createOwnership } from './ownership.mjs';
import { runCapabilityProbe } from './overlay.mjs';

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

export const DEFAULT_WAVE_TIMEOUT_MS = 7_200_000;
export const DEFAULT_LIFECYCLE_MEMORY_MIB = 3072;
export const DEFAULT_LIFECYCLE_TASKS = 512;
export const DEFAULT_AGGREGATE_TASKS = 4096;
export const MEMORY_RESERVE_PERCENT = 30;
export const MEMORY_RESERVE_FLOOR_BYTES = 4 * GIB;
export const MEMORY_HIGH_PERCENT = 80;
export const MEMORY_SWAP_MAX_BYTES = 0;
export const CPU_QUOTA_PER_CPU_PERCENT = 75;
export const CPU_WEIGHT = 50;
export const DEFAULT_RUNTIME_DIR_BASE = '/run/user';

// ---------------------------------------------------------------------------
// Resource policy and admission.
// ---------------------------------------------------------------------------

// Pure admission arithmetic. physicalMemoryBytes is the exact host RAM (never a
// rounded value). Held memory/tasks come from live or unknown capacity claims
// and are subtracted from the effective ceilings independently, so lowering one
// budget alone cannot exceed the other. The result reports slot floors, the
// effective free reservations, the binding constraint(s) and value provenance.
export function calculateResourcePolicy(options = {}) {
  const {
    physicalMemoryBytes,
    cpuCount = availableParallelism(),
    lifecycleMemoryMib = DEFAULT_LIFECYCLE_MEMORY_MIB,
    lifecycleTasks = DEFAULT_LIFECYCLE_TASKS,
    aggregateTasks = DEFAULT_AGGREGATE_TASKS,
    explicitCap = null,
    readyMembers = SOFTWARE_CEILING,
    held = {},
    ancestorLimits = null,
  } = options;

  requirePositiveSafeInteger(physicalMemoryBytes, 'physicalMemoryBytes');
  requirePositiveSafeInteger(cpuCount, 'cpuCount');
  requirePositiveInteger(lifecycleMemoryMib, 'lifecycleMemoryMib');
  requirePositiveInteger(lifecycleTasks, 'lifecycleTasks');
  requirePositiveInteger(aggregateTasks, 'aggregateTasks');
  requireNonNegativeInteger(readyMembers, 'readyMembers');
  if (explicitCap !== null) requirePositiveInteger(explicitCap, 'explicitCap');
  if (ancestorLimits !== null && typeof ancestorLimits !== 'object') throw new Error('ancestorLimits must be an object');

  const lifecycleMemoryBytes = lifecycleMemoryMib * MIB;
  if (!Number.isSafeInteger(lifecycleMemoryBytes)) throw new Error('lifecycleMemoryMib exceeds the safe integer range');
  const cpuQuotaPercent = CPU_QUOTA_PER_CPU_PERCENT * cpuCount;
  if (!Number.isSafeInteger(cpuQuotaPercent)) throw new Error('cpuCount exceeds the safe integer range');

  const percentReserveBytes = Math.floor((physicalMemoryBytes * MEMORY_RESERVE_PERCENT) / 100);
  const poolReserveBytes = Math.max(percentReserveBytes, MEMORY_RESERVE_FLOOR_BYTES);
  const poolMemoryBytes = physicalMemoryBytes - poolReserveBytes;
  if (poolMemoryBytes <= 0) {
    throw new Error(`host memory is insufficient: ${physicalMemoryBytes} bytes minus a ${poolReserveBytes}-byte reserve leaves no positive resource pool`);
  }
  const poolReserveSource = percentReserveBytes >= MEMORY_RESERVE_FLOOR_BYTES ? 'percent-30' : 'floor-4gib';

  const heldMemoryBytes = requireHeld(held, 'memoryBytes');
  const heldTasks = requireHeld(held, 'tasks');
  const ancestorMemoryBytes = ancestorValue(ancestorLimits, 'memoryBytes', requirePositiveSafeInteger);
  const ancestorTasks = ancestorValue(ancestorLimits, 'tasks', requirePositiveInteger);
  const memoryCeilingBytes = ancestorMemoryBytes === null ? poolMemoryBytes : Math.min(poolMemoryBytes, ancestorMemoryBytes);
  const taskCeiling = ancestorTasks === null ? aggregateTasks : Math.min(aggregateTasks, ancestorTasks);
  const freeMemoryBytes = memoryCeilingBytes - heldMemoryBytes;
  const freeTasks = taskCeiling - heldTasks;

  // An effective ceiling below one lifecycle can never admit a worker: that is
  // an invalid host, not a temporary shortage. Held claims may instead exhaust
  // an otherwise valid ceiling; that is a zero-admission state reported with
  // non-negative free and slot values instead of a refusal.
  if (memoryCeilingBytes < lifecycleMemoryBytes) {
    throw new Error(`resource policy does not fit: free memory ${freeMemoryBytes} bytes is below one lifecycle of ${lifecycleMemoryBytes} bytes`);
  }
  if (taskCeiling < lifecycleTasks) {
    throw new Error(`resource policy does not fit: free task budget ${freeTasks} is below one lifecycle of ${lifecycleTasks} tasks`);
  }

  const free = {
    memoryBytes: Math.max(0, freeMemoryBytes),
    tasks: Math.max(0, freeTasks),
  };
  const slots = {
    memory: Math.floor(free.memoryBytes / lifecycleMemoryBytes),
    tasks: Math.floor(free.tasks / lifecycleTasks),
  };

  const candidates = [
    ['memory', slots.memory],
    ['tasks', slots.tasks],
    ['software-ceiling', SOFTWARE_CEILING],
    ['ready', readyMembers],
  ];
  if (explicitCap !== null) candidates.push(['explicit-cap', explicitCap]);
  const admittedWidth = Math.min(...candidates.map(([, value]) => value));
  const bindings = candidates.filter(([, value]) => value === admittedWidth).map(([name]) => name);

  return {
    version: 1,
    host: { physicalMemoryBytes, cpuCount },
    poolMemoryBytes,
    poolReserveBytes,
    poolReserveSource,
    lifecycleMemoryBytes,
    lifecycleMemoryMib,
    lifecycleTasks,
    aggregateTasks,
    memoryHighBytes: Math.floor((lifecycleMemoryBytes * MEMORY_HIGH_PERCENT) / 100),
    memorySwapMaxBytes: MEMORY_SWAP_MAX_BYTES,
    cpuQuotaPercent,
    cpuWeight: CPU_WEIGHT,
    softwareCeiling: SOFTWARE_CEILING,
    limits: { memoryBytes: memoryCeilingBytes, tasks: taskCeiling },
    held: { memoryBytes: heldMemoryBytes, tasks: heldTasks },
    free,
    slots,
    readyMembers,
    admittedWidth,
    binding: bindings[0],
    bindings,
    provenance: {
      lifecycleMemoryMib: options.lifecycleMemoryMib === undefined ? 'default' : 'explicit',
      lifecycleTasks: options.lifecycleTasks === undefined ? 'default' : 'explicit',
      aggregateTasks: options.aggregateTasks === undefined ? 'default' : 'explicit',
      explicitCap: explicitCap === null ? 'absent' : 'explicit',
      readyMembers: options.readyMembers === undefined ? 'default' : 'explicit',
      held: options.held === undefined ? 'absent' : 'explicit',
      ancestorLimits: ancestorLimits === null ? 'absent' : 'explicit',
    },
  };
}

// ---------------------------------------------------------------------------
// Wave deadlines.
// ---------------------------------------------------------------------------

// The wave deadline is created once at startup. Every setup/member/review phase
// and restart inherits the persisted record unchanged and derives its own
// RuntimeMaxSec from it; expires_at is never recomputed from a phase start.
export function createWaveDeadline({ startedAtMs = Date.now(), timeoutMs = DEFAULT_WAVE_TIMEOUT_MS } = {}) {
  requireSafeInteger(startedAtMs, 'startedAtMs');
  requirePositiveSafeInteger(timeoutMs, 'timeoutMs');
  const expiresAtMs = startedAtMs + timeoutMs;
  if (!Number.isSafeInteger(expiresAtMs)) throw new Error('wave deadline exceeds the safe integer range');
  return { started_at: startedAtMs, timeout_ms: timeoutMs, expires_at: expiresAtMs };
}

// Validates the persisted deadline before any remaining-time arithmetic. A
// partial imported record needs only expires_at; when started_at and
// timeout_ms are present they must reproduce the same expiry.
function requireDeadlineExpiry(deadline) {
  if (deadline === null || typeof deadline !== 'object' || Array.isArray(deadline)) {
    throw new Error('deadline must be an object');
  }
  const expiresAtMs = requireSafeInteger(deadline.expires_at, 'expires_at');
  if (Object.hasOwn(deadline, 'started_at') || Object.hasOwn(deadline, 'timeout_ms')) {
    const startedAtMs = requireSafeInteger(deadline.started_at, 'started_at');
    const timeoutMs = requirePositiveSafeInteger(deadline.timeout_ms, 'timeout_ms');
    if (startedAtMs + timeoutMs !== expiresAtMs) {
      throw new Error('deadline expires_at does not match started_at + timeout_ms');
    }
  }
  return expiresAtMs;
}

export function deadlineRemainingMs(deadline, nowMs = Date.now()) {
  return requireDeadlineExpiry(deadline) - requireSafeInteger(nowMs, 'nowMs');
}

// max(1, ceil(remaining/1000)); an expired deadline refuses instead of setting
// zero or unlimited RuntimeMaxSec.
export function runtimeMaxSecFor(deadline, nowMs = Date.now()) {
  const expiresAtMs = requireDeadlineExpiry(deadline);
  const remainingMs = expiresAtMs - requireSafeInteger(nowMs, 'nowMs');
  if (remainingMs <= 0) throw new Error(`wave deadline expired at ${expiresAtMs}; phase launch refused`);
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

// ---------------------------------------------------------------------------
// Effective-user environment resolution.
// ---------------------------------------------------------------------------

// Validates explicit XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS values and derives
// the logind defaults only when they are absent. Only filesystem metadata is
// checked; a real bus/manager connection belongs to the next packet. This never
// creates a substitute directory/socket, switches users or reports credentials:
// the result carries the two environment names, resolved values and sources.
export function resolveEffectiveUserBusEnvironment(options = {}) {
  const {
    env = process.env,
    uid = typeof process.geteuid === 'function' ? process.geteuid() : undefined,
    runtimeDirBase = DEFAULT_RUNTIME_DIR_BASE,
    stat = statSync,
  } = options;

  if (!env || typeof env !== 'object') throw new Error('env must be an object');
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('effective uid must be a non-negative safe integer');
  if (typeof runtimeDirBase !== 'string' || !isAbsolute(runtimeDirBase)) throw new Error('runtimeDirBase must be an absolute path');
  if (typeof stat !== 'function') throw new Error('stat must be a function');

  const derivedRuntimeDir = join(runtimeDirBase, String(uid));
  const explicitXdg = envValue(env.XDG_RUNTIME_DIR);
  const xdgSource = explicitXdg === null ? 'derived' : 'explicit';
  const xdgPath = explicitXdg === null ? derivedRuntimeDir : explicitXdg;

  if (xdgSource === 'explicit' && !isAbsolute(xdgPath)) {
    return refusal('refused', 'not-absolute', `XDG_RUNTIME_DIR=${xdgPath} is not an absolute path; fix or unset it so ${derivedRuntimeDir} is derived`, {
      uid,
      xdgRuntimeDir: { path: xdgPath, source: xdgSource },
    });
  }
  const runtimeDir = inspectRuntimeDir(xdgPath, uid, stat);
  if (!runtimeDir.ok) {
    const status = xdgSource === 'derived' && runtimeDir.reason === 'missing' ? 'setup-required' : 'refused';
    const remedy =
      xdgSource === 'derived'
        ? `user runtime directory ${xdgPath} is ${RUNTIME_DIR_ISSUES[runtimeDir.reason]}; enable lingering and start the user manager (loginctl enable-linger) before launching contained workers`
        : `XDG_RUNTIME_DIR=${xdgPath} is ${RUNTIME_DIR_ISSUES[runtimeDir.reason]}; fix the explicit path or unset it so ${derivedRuntimeDir} is derived`;
    return refusal(status, runtimeDir.reason, remedy, { uid, xdgRuntimeDir: { path: xdgPath, source: xdgSource } });
  }

  const explicitBus = envValue(env.DBUS_SESSION_BUS_ADDRESS);
  const busSource = explicitBus === null ? 'derived' : 'explicit';
  let busPath;
  let busValue;
  if (busSource === 'derived') {
    busPath = join(xdgPath, 'bus');
    busValue = `unix:path=${busPath}`;
  } else {
    const parsed = parseUnixPathAddress(explicitBus);
    if (parsed === null) {
      return refusal('refused', 'invalid-address', `DBUS_SESSION_BUS_ADDRESS=${explicitBus} is not a supported unix:path=... address; fix or unset it so unix:path=${join(xdgPath, 'bus')} is derived`, {
        uid,
        xdgRuntimeDir: { path: xdgPath, source: xdgSource },
      });
    }
    busPath = parsed;
    busValue = explicitBus;
  }
  const socket = inspectBusSocket(busPath, uid, stat);
  if (!socket.ok) {
    const status = busSource === 'derived' && socket.reason === 'missing' ? 'setup-required' : 'refused';
    const remedy =
      busSource === 'derived'
        ? `user session bus ${busPath} is ${BUS_ISSUES[socket.reason]}; ensure the user systemd instance is running (loginctl enable-linger) before launching contained workers`
        : `DBUS_SESSION_BUS_ADDRESS=${busValue} does not resolve to a usable same-user socket (${socket.reason}); fix or unset it so unix:path=${join(xdgPath, 'bus')} is derived`;
    return refusal(status, socket.reason, remedy, {
      uid,
      xdgRuntimeDir: { path: xdgPath, source: xdgSource },
      dbusSessionBusAddress: { value: busValue, source: busSource, socketPath: busPath },
    });
  }

  return {
    ok: true,
    status: 'ready',
    uid,
    xdgRuntimeDir: { path: xdgPath, source: xdgSource },
    dbusSessionBusAddress: { value: busValue, source: busSource, socketPath: busPath },
    socket: { path: busPath },
    sources: { XDG_RUNTIME_DIR: xdgSource, DBUS_SESSION_BUS_ADDRESS: busSource },
    environment: { XDG_RUNTIME_DIR: xdgPath, DBUS_SESSION_BUS_ADDRESS: busValue },
  };
}

const RUNTIME_DIR_ISSUES = {
  missing: 'missing',
  unreadable: 'not readable',
  'not-a-directory': 'not a directory',
  'foreign-owner': 'not owned by the effective user',
  'not-private': 'not private (group or other permission bits are set)',
};

const BUS_ISSUES = {
  missing: 'missing',
  unreadable: 'not readable',
  'not-a-socket': 'not a socket',
  'foreign-owner': 'not owned by the effective user',
};

function envValue(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function inspectRuntimeDir(path, uid, stat) {
  let info;
  try {
    info = stat(path);
  } catch (error) {
    return { ok: false, reason: error && error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (!info.isDirectory()) return { ok: false, reason: 'not-a-directory' };
  if (info.uid !== uid) return { ok: false, reason: 'foreign-owner' };
  if ((info.mode & 0o077) !== 0) return { ok: false, reason: 'not-private' };
  return { ok: true };
}

function inspectBusSocket(path, uid, stat) {
  let info;
  try {
    info = stat(path);
  } catch (error) {
    return { ok: false, reason: error && error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (!info.isSocket()) return { ok: false, reason: 'not-a-socket' };
  if (info.uid !== uid) return { ok: false, reason: 'foreign-owner' };
  return { ok: true };
}

function parseUnixPathAddress(value) {
  if (typeof value !== 'string' || !value.startsWith('unix:path=')) return null;
  const rest = value.slice('unix:path='.length);
  const comma = rest.indexOf(',');
  const path = comma === -1 ? rest : rest.slice(0, comma);
  return path !== '' && isAbsolute(path) ? path : null;
}

function refusal(status, reason, remedy, extra = {}) {
  return { ok: false, status, reason, remedy, ...extra };
}

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

function requireSafeInteger(value, name) {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a finite safe integer`);
  return value;
}

function requirePositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function requireHeld(held, unit) {
  const value = held[unit];
  if (value === undefined || value === null) return 0;
  return requireNonNegativeInteger(value, `held.${unit}`);
}

function ancestorValue(ancestorLimits, unit, validate) {
  if (ancestorLimits === null || ancestorLimits[unit] === undefined || ancestorLimits[unit] === null) return null;
  return validate(ancestorLimits[unit], `ancestorLimits.${unit}`);
}

// ---------------------------------------------------------------------------
// Runtime host preflight
//
// checkRuntimeHost() reports the effective user's Linux execution host without
// changing it: platform and non-root identity, required utilities, the user
// manager and session bus, delegated cgroup v2 controllers with the effective
// ancestor memory.max/pids.max, required systemd unit properties, bubblewrap
// overlay prerequisites and the retained-layer backing statfs. External
// commands travel through one argv-only transport (execFile, shell:false,
// finite timeout); fixtures substitute only that transport and the configurable
// filesystem paths. The isolated transient user service that wraps the overlay
// capability probe runs only when the caller explicitly requests the probe
// (setup invocation or probe:true); it is --collect-managed and its disposable
// fixture directory is retained. Missing overlay support selects the visible
// worktree fallback; resource enforcement is never unbounded.
// ---------------------------------------------------------------------------

export const HOST_CHECK_TIMEOUT_MS = 20_000;
export const HOST_PROBE_TIMEOUT_MS = 120_000;
export const CGROUP_V2_ROOT = '/sys/fs/cgroup';
export const HOST_REQUIRED_UTILITIES = Object.freeze(['systemd-run', 'systemctl', 'flock']);
export const HOST_REQUIRED_CONTROLLERS = Object.freeze(['cpu', 'memory', 'pids']);
export const HOST_REQUIRED_UNIT_PROPERTIES = Object.freeze([
  'MemoryMax',
  'MemoryHigh',
  'MemorySwapMax',
  'TasksMax',
  'CPUQuota',
  'CPUWeight',
  'RuntimeMaxSec',
]);

// systemd exposes the two launch properties under different runtime property
// names; queries and unknown-property diagnostics must use these names.
export const HOST_UNIT_PROPERTY_QUERY = Object.freeze({
  MemoryMax: 'MemoryMax',
  MemoryHigh: 'MemoryHigh',
  MemorySwapMax: 'MemorySwapMax',
  TasksMax: 'TasksMax',
  CPUQuota: 'CPUQuotaPerSecUSec',
  CPUWeight: 'CPUWeight',
  RuntimeMaxSec: 'RuntimeMaxUSec',
});

// Exact package, profile, controller, bus and property remedies: distribution
// packages and the stock user-manager profile only, never a custom privileged
// installation and never an unbounded substitute.
export const HOST_REMEDIES = Object.freeze({
  'not-linux': 'run the runtime host check on Linux with cgroup v2 and a systemd user manager',
  root: 'run the runtime host check as the effective non-root wave user; root must not be substituted for the user manager',
  utilities: 'install the missing OS packages (systemd for systemd-run/systemctl, util-linux for flock) with the distribution package manager',
  'manager-unreachable': 'start the systemd user manager for this user: loginctl enable-linger "$(id -un)" and verify systemctl --user show --property=Version',
  'cgroup-v2-absent': 'boot the OS with unified cgroup v2 (systemd.unified_cgroup_hierarchy=1) so cpu, memory and pids are available',
  'controller-missing': 'enable the missing cgroup v2 controller at the host root; it is a kernel/OS default, not a custom install',
  'controller-not-delegated': 'use the distribution user-manager defaults (user@.service Delegate=yes) or loginctl enable-linger so memory, cpu and pids are delegated',
  'property-unsupported': 'upgrade systemd through the OS package manager so the launch unit properties are supported',
  'property-unverified': 'run the runtime host check with the explicitly requested isolated probe (--probe) to prove property acceptance',
  'bwrap-absent': 'install bubblewrap (>= 0.11.0, non-setuid) from the OS package manager (apt/dnf/zypper install bubblewrap)',
  'bwrap-setuid': 'replace setuid bubblewrap with the unprivileged OS package build; no custom setuid installation',
  'bwrap-unknown': 'install an OS bubblewrap package and pass its absolute path so the check can read its setuid bit',
  'overlay-options-absent': 'install bubblewrap >= 0.11.0 from the OS package manager so the overlay options are present',
  userns: 'an administrator installs the OS-approved AppArmor user-namespace profile or enables unprivileged user namespaces',
  'capacity-below-lifecycle': 'raise the effective memory/task ceiling or lower the explicit lifecycle budget; never launch without a bounded lifecycle',
  backing: 'place retained overlay layers on a local filesystem whose statfs the check can read',
  'probe-required': 'run the runtime host check with the explicitly requested isolated probe (--probe) to exercise the transient user-service boundary',
  'probe-skipped': 'resolve the earlier host refusals before probing the transient user-service boundary',
  'config-home-invalid': 'set XDG_CONFIG_HOME to an absolute directory owned by the wave user, or unset it so the default ~/.config is used',
  'foreign-target': 'move the foreign file aside and re-run runtime-host setup; the owned policy and slice are never overwritten blind',
  'invalid-target': 'remove the malformed owned host file so runtime-host setup can install the managed content',
  'unreadable-target': 'make the owned host file readable by the wave user, then re-run runtime-host setup',
  'symlink-target': 'replace the symlink with a regular owned file; runtime-host setup never writes through a symlink',
  'install-failed': 'free disk space and verify the config directory is writable by the wave user, then re-run runtime-host setup',
  'claims-unreadable': 'repair the ownership registry (readable, valid JSON) before runtime-host setup; a failed claims query blocks the install',
  'claims-active': 'wait for recorded capacity/checkout claims to finish; runtime-host setup never releases live claims',
  'claims-unknown': 'repair malformed or unrecognized claim records in the ownership registry; a policy change conservatively refuses an unknown claim shape instead of assuming no live claims',
  'services-unreadable': 'make systemctl --user list-units reachable for the wave user, then re-run runtime-host setup',
  'services-unknown': 'inspect the unrecognized spec-runtime unit rows; setup refuses to replace an unknown service state',
  'services-active': 'stop the active spec-runtime services or wait for them to finish; setup never restarts a live service',
  'daemon-reload-unreachable': 'make systemctl --user daemon-reload reachable for the wave user, then re-run runtime-host setup',
  'slice-verification-failed': 're-run runtime-host setup after fixing the user manager; every installed slice property must be observed before success',
  'properties-unverified': 'run the isolated property probe successfully before installing the host policy; setup requires proven unit properties',
  'cgroup-unreadable': 'make every ancestor memory.max and pids.max readable by the wave user; an unreadable limit is never treated as unlimited',
  'cgroup-limit-invalid': 'repair the malformed ancestor memory.max or pids.max value; an invalid limit blocks admission',
  'cgroup-path-outside-root': 'point the user manager cgroup inside the cgroup v2 root; wave resources never inspect a path outside the unified hierarchy',
});

const HOST_MODULE_PATH = fileURLToPath(import.meta.url);
const OVERLAY_MODULE_PATH = fileURLToPath(new URL('./overlay.mjs', import.meta.url));

export async function checkRuntimeHost(options = {}) {
  if (options === null || typeof options !== 'object') throw new Error('options must be an object');
  const {
    env = process.env,
    platform = process.platform,
    run = defaultHostTransport,
    timeoutMs = HOST_CHECK_TIMEOUT_MS,
    probeTimeoutMs = HOST_PROBE_TIMEOUT_MS,
    cgroupRoot = CGROUP_V2_ROOT,
    userManagerCgroup = null,
    runtimeDirBase = DEFAULT_RUNTIME_DIR_BASE,
    bwrapPath = 'bwrap',
    overlayBackingPath = null,
    probeFixtureRoot = null,
    stat = statSync,
    statfs = statfsSync,
    physicalMemoryBytes = null,
    cpuCount = null,
    lifecycleMemoryMib,
    lifecycleTasks,
    aggregateTasks,
    explicitCap = null,
    readyMembers = SOFTWARE_CEILING,
    held = {},
    ancestorLimits = null,
    probe = false,
    mode = 'check',
  } = options;

  if (typeof env !== 'object' || env === null) throw new Error('env must be an object');
  if (typeof platform !== 'string' || platform === '') throw new Error('platform must be a non-empty string');
  if (typeof run !== 'function') throw new Error('run must be a function');
  requirePositiveSafeInteger(timeoutMs, 'timeoutMs');
  requirePositiveSafeInteger(probeTimeoutMs, 'probeTimeoutMs');
  if (mode !== 'check' && mode !== 'probe' && mode !== 'setup') throw new Error('mode must be check, probe or setup');
  if (typeof probe !== 'boolean') throw new Error('probe must be a boolean');
  if (!isAbsolute(cgroupRoot)) throw new Error('cgroupRoot must be an absolute path');
  if (userManagerCgroup !== null && !isAbsolute(userManagerCgroup)) throw new Error('userManagerCgroup must be an absolute path');
  if (typeof runtimeDirBase !== 'string' || !isAbsolute(runtimeDirBase)) throw new Error('runtimeDirBase must be an absolute path');
  if (typeof bwrapPath !== 'string' || bwrapPath === '') throw new Error('bwrapPath must be a non-empty string');
  if (overlayBackingPath !== null && (typeof overlayBackingPath !== 'string' || overlayBackingPath === '')) throw new Error('overlayBackingPath must be a non-empty string');
  if (probeFixtureRoot !== null && !isAbsolute(probeFixtureRoot)) throw new Error('probeFixtureRoot must be an absolute path');
  if (typeof stat !== 'function') throw new Error('stat must be a function');
  if (typeof statfs !== 'function') throw new Error('statfs must be a function');

  const uid = options.uid ?? (typeof process.geteuid === 'function' ? process.geteuid() : null);
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('effective uid must be a non-negative safe integer');

  const probeRequested = probe === true || mode === 'probe' || mode === 'setup';
  const effectiveMode = mode === 'setup' ? 'setup' : probeRequested ? 'probe' : 'check';
  const pathValue = typeof env.PATH === 'string' && env.PATH !== ''
    ? env.PATH
    : typeof process.env.PATH === 'string'
      ? process.env.PATH
      : '';
  const commandEnv = (extra = {}) => (pathValue === '' ? { ...extra } : { PATH: pathValue, ...extra });

  const runCommand = async (command, args, extra = {}) => {
    try {
      const record = await run({ command, args, env: extra.env ?? commandEnv(), timeoutMs: extra.timeoutMs ?? timeoutMs, cwd: extra.cwd });
      return hostRecord(record, command, args);
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : null;
      return hostRecord({ errorCode: code, stderr: error && typeof error.message === 'string' ? error.message : '' }, command, args);
    }
  };

  const bus = resolveEffectiveUserBusEnvironment({ env, uid, runtimeDirBase, stat });
  const busEnvironment = bus.ok ? bus.environment : {};
  const envWithBus = commandEnv(busEnvironment);

  const utilities = {};
  for (const name of HOST_REQUIRED_UTILITIES) {
    const record = await runCommand(name, ['--version'], { env: envWithBus });
    const missing = record.errorCode === 'ENOENT';
    const usable = !missing && record.exitCode === 0 && record.signal === null;
    utilities[name] = {
      available: usable,
      version: firstLine(record.stdout) ?? firstLine(record.stderr),
      reason: missing ? 'missing' : usable ? null : 'unusable',
      remedy: missing || !usable ? HOST_REMEDIES.utilities : null,
    };
  }
  const missingUtilities = HOST_REQUIRED_UTILITIES.filter(name => !utilities[name].available);

  let userManager = {
    ok: false,
    status: bus.ok ? 'setup-required' : bus.status,
    reason: bus.ok ? 'unreachable' : `bus-${bus.reason}`,
    remedy: bus.ok ? HOST_REMEDIES['manager-unreachable'] : bus.remedy,
    version: null,
  };
  if (bus.ok) {
    const managerRecord = await runCommand('systemctl', ['--user', 'show', '--property=Version', '--value'], { env: envWithBus });
    if (managerRecord.exitCode === 0 && managerRecord.signal === null) {
      userManager = { ok: true, status: 'ready', reason: 'reachable', remedy: null, version: firstLine(managerRecord.stdout) };
    } else {
      userManager = {
        ok: false,
        status: 'setup-required',
        reason: 'unreachable',
        remedy: HOST_REMEDIES['manager-unreachable'],
        version: null,
        detail: firstLine(managerRecord.stderr),
      };
    }
  }

  const managerCgroupPath = userManagerCgroup ?? join(cgroupRoot, 'user.slice', `user-${uid}.slice`, `user@${uid}.service`);
  const managerInsideRoot = pathInside(managerCgroupPath, cgroupRoot);
  const hostControllers = parseControllerList(readTextFile(join(cgroupRoot, 'cgroup.controllers')));
  const managerControllers = managerInsideRoot
    ? parseControllerList(readTextFile(join(managerCgroupPath, 'cgroup.controllers')))
    : null;
  const managerSubtreeControl = managerInsideRoot
    ? (parseControllerList(readTextFile(join(managerCgroupPath, 'cgroup.subtree_control'))) ?? [])
      .map(name => (name.startsWith('+') ? name.slice(1) : name))
    : [];
  const ancestors = inspectAncestorLimits(managerCgroupPath, cgroupRoot);
  const missingControllers = [];
  for (const controller of HOST_REQUIRED_CONTROLLERS) {
    if (hostControllers === null || !hostControllers.includes(controller)) {
      missingControllers.push({ controller, where: 'host-root', reason: 'missing' });
      continue;
    }
    if (managerControllers === null || !managerControllers.includes(controller)) {
      missingControllers.push({ controller, where: 'user-manager', reason: 'not-delegated' });
      continue;
    }
    if (!managerSubtreeControl.includes(controller)) {
      missingControllers.push({ controller, where: 'user-manager', reason: 'not-enabled' });
    }
  }
  const cgroupReady = hostControllers !== null && missingControllers.length === 0 && ancestors.blocked === null;
  const missingHostRootController = missingControllers.some(item => item.where === 'host-root');
  const cgroupReason = hostControllers === null
    ? 'cgroup-v2-absent'
    : ancestors.blocked !== null
      ? ancestors.blocked
      : cgroupReady ? 'delegated' : missingHostRootController ? 'controller-missing' : 'controller-not-delegated';
  const cgroupRemedy = hostControllers === null
    ? HOST_REMEDIES['cgroup-v2-absent']
    : ancestors.blocked !== null
      ? HOST_REMEDIES[ancestors.blocked]
      : missingHostRootController
        ? HOST_REMEDIES['controller-missing']
        : HOST_REMEDIES['controller-not-delegated'];

  const filesystemAncestorLimits = {};
  if (ancestors.memoryBytes !== null) filesystemAncestorLimits.memoryBytes = ancestors.memoryBytes;
  if (ancestors.tasks !== null) filesystemAncestorLimits.tasks = ancestors.tasks;
  const policyAncestorLimits = ancestorLimits === null
    ? (Object.keys(filesystemAncestorLimits).length > 0 ? filesystemAncestorLimits : null)
    : { ...filesystemAncestorLimits, ...ancestorLimits };

  let policy = null;
  let admission = {
    status: 'refused',
    reason: 'capacity-below-lifecycle',
    remedy: HOST_REMEDIES['capacity-below-lifecycle'],
    detail: null,
    admittedWidth: 0,
    binding: null,
    bindings: null,
    launchable: false,
    slots: null,
    free: null,
  };
  try {
    policy = calculateResourcePolicy({
      physicalMemoryBytes: physicalMemoryBytes ?? totalmem(),
      cpuCount: cpuCount ?? availableParallelism(),
      lifecycleMemoryMib,
      lifecycleTasks,
      aggregateTasks,
      explicitCap,
      readyMembers,
      held: held ?? {},
      ancestorLimits: policyAncestorLimits,
    });
    const launchable = policy.admittedWidth > 0;
    admission = {
      status: launchable ? 'ready' : 'held',
      reason: launchable ? 'admitted' : 'held-exhausted',
      remedy: launchable ? null : 'release or wait for held capacity claims; the lifecycle ceiling is valid and admission returns to zero only temporarily',
      detail: null,
      admittedWidth: policy.admittedWidth,
      binding: policy.binding,
      bindings: policy.bindings,
      launchable,
      slots: policy.slots,
      free: policy.free,
    };
  } catch (error) {
    admission.detail = error instanceof Error ? error.message : String(error);
  }

  const properties = await readPropertySupport({ runCommand, env: envWithBus, timeoutMs });
  properties.required = [...HOST_REQUIRED_UNIT_PROPERTIES];
  properties.source = 'read';
  properties.remedy = properties.status === 'unsupported'
    ? HOST_REMEDIES['property-unsupported']
    : properties.status === 'supported'
      ? null
      : HOST_REMEDIES['property-unverified'];

  const bwrapVersionRecord = await runCommand(bwrapPath, ['--version']);
  const bwrapPresent = bwrapVersionRecord.errorCode !== 'ENOENT'
    && bwrapVersionRecord.exitCode === 0
    && bwrapVersionRecord.signal === null;
  const bwrapVersion = firstLine(bwrapVersionRecord.stdout) ?? firstLine(bwrapVersionRecord.stderr);
  let bwrapHelp = false;
  let overlayOptions = false;
  if (bwrapPresent) {
    const helpRecord = await runCommand(bwrapPath, ['--help']);
    const helpText = `${helpRecord.stdout}\n${helpRecord.stderr}`;
    bwrapHelp = helpRecord.exitCode === 0 || helpText.trim() !== '';
    overlayOptions = /--overlay(?![\w-])/.test(helpText) && /--overlay-src(?![\w-])/.test(helpText);
  }
  const bwrapFile = resolveExecutablePath(bwrapPath, pathValue, stat);
  let bwrapSetuid = null;
  if (bwrapFile !== null) {
    try {
      bwrapSetuid = (stat(bwrapFile).mode & 0o4000) !== 0;
    } catch {
      bwrapSetuid = null;
    }
  }

  let backing;
  if (typeof overlayBackingPath === 'string' && overlayBackingPath !== '') {
    try {
      const info = statfs(overlayBackingPath);
      backing = {
        path: overlayBackingPath,
        status: 'read',
        type: info.type,
        magic: `0x${(info.type >>> 0).toString(16)}`,
        remedy: null,
      };
    } catch (error) {
      backing = {
        path: overlayBackingPath,
        status: error && error.code === 'ENOENT' ? 'missing' : 'unreadable',
        type: null,
        magic: null,
        remedy: HOST_REMEDIES.backing,
      };
    }
  } else {
    backing = { path: null, status: 'unspecified', type: null, magic: null, remedy: HOST_REMEDIES.backing };
  }

  let capability;
  if (!bwrapPresent) {
    capability = { status: 'unavailable', reason: 'bwrap-absent', remedy: HOST_REMEDIES['bwrap-absent'], fallbackEligible: true };
  } else if (bwrapSetuid === true) {
    capability = { status: 'unavailable', reason: 'bwrap-setuid', remedy: HOST_REMEDIES['bwrap-setuid'], fallbackEligible: true };
  } else if (bwrapSetuid === null) {
    capability = { status: 'unavailable', reason: 'bwrap-unknown', remedy: HOST_REMEDIES['bwrap-unknown'], fallbackEligible: true };
  } else if (!overlayOptions) {
    capability = { status: 'unavailable', reason: 'overlay-options-absent', remedy: HOST_REMEDIES['overlay-options-absent'], fallbackEligible: true };
  } else {
    capability = { status: 'unprobed', reason: 'probe-not-requested', remedy: HOST_REMEDIES['probe-required'], fallbackEligible: false };
  }

  const probePrerequisitesMet = missingUtilities.length === 0 && bus.ok && userManager.ok && cgroupReady && policy !== null;
  const runtimeMaxSec = Math.max(1, Math.ceil(probeTimeoutMs / 1000));
  let overlay = {
    status: capability.status,
    reason: capability.reason,
    remedy: capability.remedy,
    fallbackEligible: capability.fallbackEligible,
    probed: false,
    probeMode: null,
    transport: run === defaultHostTransport ? 'execFile' : 'substituted',
    probeBoundary: null,
    fixtureDir: null,
    observed: null,
  };

  if (probeRequested) {
    if (!probePrerequisitesMet) {
      overlay = { ...overlay, status: 'not-probed', reason: 'probe-skipped', remedy: HOST_REMEDIES['probe-skipped'] };
    } else {
      const propertyProbeRecord = await runCommand('systemd-run', propertyProbeArgs(policy, runtimeMaxSec), {
        env: envWithBus,
        timeoutMs: probeTimeoutMs,
      });
      const propertyProbeAccepted = propertyProbeRecord.exitCode === 0 && propertyProbeRecord.signal === null;
      if (propertyProbeAccepted) {
        properties.source = 'probe';
        properties.status = 'supported';
        properties.supported = [...HOST_REQUIRED_UNIT_PROPERTIES];
        properties.unverified = [];
        properties.unsupported = [];
        properties.remedy = null;
        properties.detail = null;
        if (capability.status !== 'unprobed') {
          // Property acceptance is verified independently of overlay
          // availability: absent bubblewrap selects the worktree fallback but
          // must not mask an unsupported unit property set.
          overlay = {
            ...overlay,
            status: 'not-probed',
            reason: capability.reason,
            remedy: capability.remedy,
            fallbackEligible: capability.fallbackEligible,
          };
        } else {
          const probe = await runCapabilityProbe({
            fixtureRoot: probeFixtureRoot ?? undefined,
            runner: ({ argv }) => runProbeService({ runCommand, argv, policy, runtimeMaxSec, timeoutMs: probeTimeoutMs, env: envWithBus }),
          });
          overlay = {
            status: probe.result.status,
            reason: probe.result.reason,
            remedy: probe.result.remedy,
            fallbackEligible: probe.result.fallbackEligible,
            probed: true,
            probeMode: 'transient-user-service',
            transport: run === defaultHostTransport ? 'execFile' : 'substituted',
            probeBoundary: probe.boundary,
            fixtureDir: probe.fixtureDir,
            observed: probe.result.observed ?? null,
          };
          capability = {
            status: probe.result.status,
            reason: probe.result.reason,
            remedy: probe.result.remedy,
            fallbackEligible: probe.result.fallbackEligible,
          };
        }
      } else {
        properties.source = 'probe';
        properties.status = 'unsupported';
        properties.supported = [];
        properties.unverified = [];
        properties.unsupported = [...HOST_REQUIRED_UNIT_PROPERTIES];
        properties.remedy = HOST_REMEDIES['property-unsupported'];
        properties.detail = firstLine(propertyProbeRecord.stderr);
        capability = { status: 'blocked', reason: 'property-unsupported', remedy: HOST_REMEDIES['property-unsupported'], fallbackEligible: false };
        overlay = { ...overlay, status: 'not-probed', reason: 'property-unsupported', remedy: HOST_REMEDIES['property-unsupported'], fallbackEligible: false };
      }
    }
  }

  const preflightReady = platform === 'linux'
    && uid !== 0
    && missingUtilities.length === 0
    && bus.ok
    && userManager.ok
    && cgroupReady
    && properties.status !== 'unsupported'
    && policy !== null;

  let route = 'native';
  let fallback = null;
  if (!preflightReady) {
    route = 'refused';
  } else if (capability.status === 'unavailable' && capability.fallbackEligible) {
    route = 'worktree';
    fallback = {
      mode: 'worktree',
      reason: capability.reason,
      remedy: capability.remedy,
      bounded: true,
      note: 'worktree fallback keeps the systemd lifecycle resource bounds; only overlay isolation is unpublished',
    };
  } else if (capability.status === 'blocked') {
    route = 'blocked';
  }

  let status = 'ready';
  let reason = 'ready';
  let remedy = null;
  if (platform !== 'linux') {
    status = 'refused';
    reason = 'not-linux';
    remedy = HOST_REMEDIES['not-linux'];
  } else if (uid === 0) {
    status = 'refused';
    reason = 'root';
    remedy = HOST_REMEDIES.root;
  } else if (missingUtilities.length > 0) {
    status = 'setup-required';
    reason = 'utilities';
    remedy = HOST_REMEDIES.utilities;
  } else if (!bus.ok) {
    status = bus.status === 'setup-required' ? 'setup-required' : 'refused';
    reason = `bus-${bus.reason}`;
    remedy = bus.remedy;
  } else if (!userManager.ok) {
    status = 'setup-required';
    reason = 'manager-unreachable';
    remedy = HOST_REMEDIES['manager-unreachable'];
  } else if (ancestors.blocked !== null) {
    status = 'refused';
    reason = ancestors.blocked;
    remedy = cgroupRemedy;
  } else if (!cgroupReady) {
    status = 'setup-required';
    reason = cgroupReason;
    remedy = cgroupRemedy;
  } else if (properties.status === 'unsupported') {
    status = 'refused';
    reason = 'property-unsupported';
    remedy = properties.remedy;
  } else if (policy === null) {
    status = 'refused';
    reason = 'capacity-below-lifecycle';
    remedy = HOST_REMEDIES['capacity-below-lifecycle'];
  } else if (capability.status === 'blocked') {
    status = 'blocked';
    reason = capability.reason;
    remedy = capability.remedy;
  } else if (capability.status === 'unavailable') {
    reason = capability.reason;
    remedy = capability.remedy;
  } else if (properties.status !== 'supported' || overlay.status !== 'supported') {
    reason = 'probe-required';
    remedy = HOST_REMEDIES['probe-required'];
  }

  const nativeReady = status === 'ready'
    && route === 'native'
    && properties.status === 'supported'
    && overlay.status === 'supported'
    && admission.launchable === true;

  return {
    version: 1,
    mode: effectiveMode,
    status,
    ok: status === 'ready',
    reason,
    remedy,
    route,
    fallback,
    nativeReady,
    softwareCeiling: SOFTWARE_CEILING,
    platform: { os: platform, uid, nonroot: uid !== 0 },
    versions: {
      systemd: userManager.version,
      systemdRun: utilities['systemd-run'].version,
      systemctl: utilities.systemctl.version,
      flock: utilities.flock.version,
      bwrap: bwrapVersion,
    },
    utilities,
    userManager,
    bus: reportBus(bus),
    cgroup: {
      root: cgroupRoot,
      userManagerPath: managerCgroupPath,
      version: hostControllers === null ? 'absent' : 'v2',
      hostControllers: hostControllers ?? [],
      requiredControllers: [...HOST_REQUIRED_CONTROLLERS],
      delegated: managerControllers ?? [],
      enabled: managerSubtreeControl,
      missing: missingControllers,
      ancestorChain: ancestors.chain,
      ancestorLimits: { memoryBytes: ancestors.memoryBytes, tasks: ancestors.tasks },
      unreadableLimits: ancestors.unreadable,
      invalidLimits: ancestors.invalid,
      blocked: ancestors.blocked,
      reason: cgroupReason,
      remedy: cgroupReady ? null : cgroupRemedy,
    },
    policy: policy ?? { ok: false, reason: 'capacity-below-lifecycle', detail: admission.detail },
    admission,
    properties,
    bwrap: {
      command: bwrapPath,
      path: bwrapFile,
      present: bwrapPresent,
      version: bwrapVersion,
      help: bwrapHelp,
      overlayOptions,
      setuid: bwrapSetuid,
    },
    backing,
    overlay,
    probe: {
      requested: probeRequested,
      executed: overlay.probed,
      mode: overlay.probeMode,
      boundary: overlay.probeBoundary,
      transport: overlay.transport,
      fixtureDir: overlay.fixtureDir,
      cleanup: 'fixture-retained',
    },
    extensions: { overlay: OVERLAY_MODULE_PATH, host: HOST_MODULE_PATH },
  };
}

// argv-only command transport: no shell, explicit environment and a finite
// timeout. Fixtures replace this whole function; the host check never reaches
// around it for external commands.
function defaultHostTransport({ command, args = [], env = process.env, timeoutMs = HOST_CHECK_TIMEOUT_MS, cwd = undefined }) {
  return new Promise(resolve => {
    execFile(command, args, {
      cwd,
      env,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      shell: false,
      maxBuffer: 4 * MIB,
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
        signal: error && typeof error.signal === 'string' ? error.signal : null,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : error && typeof error.message === 'string' ? error.message : '',
        errorCode: error && typeof error.code === 'string' ? error.code : null,
      });
    });
  });
}

function hostRecord(record, command, args) {
  const value = record && typeof record === 'object' ? record : {};
  const errorCode = typeof value.errorCode === 'string'
    ? value.errorCode
    : typeof value.code === 'string'
      ? value.code
      : null;
  return {
    command,
    args,
    exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
    signal: typeof value.signal === 'string' ? value.signal : null,
    stdout: typeof value.stdout === 'string' ? value.stdout : '',
    stderr: typeof value.stderr === 'string' ? value.stderr : '',
    errorCode,
  };
}

function firstLine(text) {
  if (typeof text !== 'string') return null;
  const line = text.split('\n').map(part => part.trim()).find(part => part !== '');
  return line ?? null;
}

// The status command reports bus availability and provenance but never the
// caller's resolved environment: XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS
// may carry credentials and are stripped from the reported view.
function reportBus(bus) {
  const view = { ...bus };
  delete view.environment;
  if (view.dbusSessionBusAddress !== null && typeof view.dbusSessionBusAddress === 'object') {
    const { value, ...rest } = view.dbusSessionBusAddress;
    view.dbusSessionBusAddress = rest;
  }
  return view;
}

function parseControllerList(text) {
  if (typeof text !== 'string') return null;
  const names = text.trim().split(/\s+/).filter(Boolean);
  return names.length > 0 ? names : null;
}

function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// A cgroup v2 "max" value is no limit. A missing, unreadable or malformed
// limit file is *unknown*, never unlimited: treating it as unbounded would
// admit a wave past an ancestor ceiling that exists but cannot be read. 0 is a
// real (and unusable) limit and stays numeric so the policy refuses capacity.
function readCgroupLimit(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { status: 'unreadable' };
  }
  const value = text.trim();
  if (value === 'max') return { status: 'max' };
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed >= 0) return { status: 'limit', value: parsed };
  return { status: 'invalid' };
}

function pathInside(child, ancestor) {
  return child === ancestor || child.startsWith(ancestor.endsWith('/') ? ancestor : `${ancestor}/`);
}

// Effective ancestor limits are the minimum over the whole chain from the user
// manager cgroup up to (and including) the cgroup root. The start path must be
// inside the root; the walk never reads above the root, and any unreadable or
// malformed limit blocks admission instead of collapsing to "unlimited".
function inspectAncestorLimits(start, stopAt) {
  const chain = [];
  const unreadable = [];
  const invalid = [];
  let memoryBytes = null;
  let tasks = null;
  if (!pathInside(start, stopAt)) {
    return { chain, memoryBytes, tasks, blocked: 'cgroup-path-outside-root', unreadable, invalid };
  }
  let current = start;
  for (;;) {
    chain.push(current);
    for (const [file, unit] of [['memory.max', 'memory'], ['pids.max', 'tasks']]) {
      const limit = readCgroupLimit(join(current, file));
      if (limit.status === 'unreadable') unreadable.push(join(current, file));
      else if (limit.status === 'invalid') invalid.push(join(current, file));
      else if (limit.status === 'limit') {
        if (unit === 'memory') memoryBytes = memoryBytes === null ? limit.value : Math.min(memoryBytes, limit.value);
        else tasks = tasks === null ? limit.value : Math.min(tasks, limit.value);
      }
    }
    if (current === stopAt || dirname(current) === current) break;
    current = dirname(current);
  }
  const blocked = unreadable.length > 0 ? 'cgroup-unreadable' : invalid.length > 0 ? 'cgroup-limit-invalid' : null;
  return { chain, memoryBytes, tasks, blocked, unreadable, invalid };
}

function resolveExecutablePath(command, pathValue, stat) {
  if (typeof command !== 'string' || command === '') return null;
  if (command.includes('/')) return isAbsolute(command) ? command : null;
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, command);
    try {
      if (stat(candidate).isFile()) return candidate;
    } catch {
      // keep searching the remaining PATH entries
    }
  }
  return null;
}

// Read-only property support: properties the user manager reports are
// supported; missing lines stay explicitly unverified until the isolated
// probe accepts them (never inferred from a version string).
async function readPropertySupport({ runCommand, env, timeoutMs }) {
  const queryNames = HOST_REQUIRED_UNIT_PROPERTIES.map(name => HOST_UNIT_PROPERTY_QUERY[name]);
  const args = ['--user', 'show', '-.slice'];
  for (const name of queryNames) args.push(`--property=${name}`);
  const record = await runCommand('systemctl', args, { env, timeoutMs });
  if (record.exitCode !== 0 || record.signal !== null) {
    return {
      status: 'unreadable',
      supported: [],
      unverified: [...HOST_REQUIRED_UNIT_PROPERTIES],
      unsupported: [],
      detail: firstLine(record.stderr),
    };
  }
  const observed = new Set();
  for (const line of record.stdout.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) observed.add(line.slice(0, index).trim());
  }
  const supported = [];
  const unverified = [];
  for (let index = 0; index < HOST_REQUIRED_UNIT_PROPERTIES.length; index += 1) {
    const name = HOST_REQUIRED_UNIT_PROPERTIES[index];
    if (observed.has(queryNames[index])) supported.push(name);
    else unverified.push(name);
  }
  const unsupported = [];
  const unknownPattern = /Unknown property[ \t]+([A-Za-z0-9_]+)/g;
  for (const match of record.stderr.matchAll(unknownPattern)) {
    const required = HOST_REQUIRED_UNIT_PROPERTIES.find(name => HOST_UNIT_PROPERTY_QUERY[name] === match[1] || name === match[1]);
    if (required !== undefined && !unsupported.includes(required)) unsupported.push(required);
  }
  for (const name of unsupported) {
    const index = unverified.indexOf(name);
    if (index !== -1) unverified.splice(index, 1);
  }
  const status = unsupported.length > 0 ? 'unsupported' : unverified.length === 0 ? 'supported' : 'unverified';
  return { status, supported, unverified, unsupported, detail: null };
}

function propertyProbeArgs(policy, runtimeMaxSec) {
  return [
    '--user',
    '--pipe',
    '--wait',
    '--collect',
    '--service-type=exec',
    `--property=MemoryMax=${policy.lifecycleMemoryBytes}`,
    `--property=MemoryHigh=${policy.memoryHighBytes}`,
    `--property=MemorySwapMax=${policy.memorySwapMaxBytes}`,
    `--property=TasksMax=${policy.lifecycleTasks}`,
    `--property=CPUQuota=${policy.cpuQuotaPercent}%`,
    `--property=CPUWeight=${policy.cpuWeight}`,
    `--property=RuntimeMaxSec=${runtimeMaxSec}`,
    '--',
    process.execPath,
    '-e',
    '0',
  ];
}

function runProbeService({ runCommand, argv, policy, runtimeMaxSec, timeoutMs, env }) {
  const servicePath = typeof env.PATH === 'string' && env.PATH !== ''
    ? env.PATH
    : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return runCommand('systemd-run', [
    '--user',
    '--pipe',
    '--wait',
    '--collect',
    '--service-type=exec',
    `--property=MemoryMax=${policy.lifecycleMemoryBytes}`,
    `--property=MemoryHigh=${policy.memoryHighBytes}`,
    `--property=MemorySwapMax=${policy.memorySwapMaxBytes}`,
    `--property=TasksMax=${policy.lifecycleTasks}`,
    `--property=CPUQuota=${policy.cpuQuotaPercent}%`,
    `--property=CPUWeight=${policy.cpuWeight}`,
    `--property=RuntimeMaxSec=${runtimeMaxSec}`,
    `--setenv=PATH=${servicePath}`,
    '--',
    ...argv,
  ], { env, timeoutMs });
}

// ---------------------------------------------------------------------------
// Owned host setup
//
// setupRuntimeHost() composes the bounded preflight above with an idempotent
// install of the owned host policy and aggregate slice. It refuses foreign,
// invalid or symlinked targets, refuses any policy change while recorded
// capacity/checkout claims or active/unknown spec-runtime services exist and
// never releases live state. The install is atomic (temporary file plus
// rename; 0600 policy, 0644 slice), identical content is never rewritten, and
// a changed slice is daemon-reloaded and re-read from the user manager before
// setup reports success. runtimeHostCommand() is the shared CLI composition.
// ---------------------------------------------------------------------------

const HOST_POLICY_SCHEMA = 'spec-runtime-host-policy/v1';
const HOST_SLICE_UNIT = 'spec-runtime.slice';
const HOST_SLICE_MARKER = '# spec-runtime-host-slice/v1';
const HOST_SERVICE_UNIT_PATTERN = 'spec-runtime*';
const HOST_SLICE_PROPERTIES = Object.freeze(['MemoryMax', 'MemoryHigh', 'MemorySwapMax', 'TasksMax', 'CPUQuotaPerSecUSec', 'CPUWeight']);

function hostConfigPaths({ env = process.env, home = homedir() } = {}) {
  const explicit = env.XDG_CONFIG_HOME;
  if (explicit !== undefined && (typeof explicit !== 'string' || explicit === '' || !isAbsolute(explicit))) {
    throw new Error('XDG_CONFIG_HOME must be an absolute path');
  }
  const configHome = explicit ?? join(home, '.config');
  if (!isAbsolute(configHome)) throw new Error('home must be absolute when XDG_CONFIG_HOME is not set');
  const root = join(configHome, 'spec-runtime');
  // The policy stays in the spec-runtime config directory; the slice must sit
  // on the user manager's unit search path (configHome/systemd/user) or
  // systemd never loads it.
  return { configHome, root, policyPath: join(root, 'host-policy.json'), slicePath: join(configHome, 'systemd', 'user', HOST_SLICE_UNIT) };
}

function aggregateMemoryHighBytes(policy) {
  return Math.floor((policy.poolMemoryBytes * MEMORY_HIGH_PERCENT) / 100);
}

// The policy records exact enforcement values plus provenance; the slice
// carries the aggregate ceiling shared by every wave unit.
function buildHostPolicy(policy) {
  return {
    schema: HOST_POLICY_SCHEMA,
    owner: 'spec-runtime',
    aggregate: {
      memoryMaxBytes: policy.poolMemoryBytes,
      memoryHighBytes: aggregateMemoryHighBytes(policy),
      memorySwapMaxBytes: MEMORY_SWAP_MAX_BYTES,
      tasksMax: policy.aggregateTasks,
      cpuQuotaPercent: policy.cpuQuotaPercent,
      cpuWeight: policy.cpuWeight,
    },
    lifecycle: {
      memoryMib: policy.lifecycleMemoryMib,
      memoryBytes: policy.lifecycleMemoryBytes,
      memoryHighBytes: policy.memoryHighBytes,
      memorySwapMaxBytes: policy.memorySwapMaxBytes,
      tasksMax: policy.lifecycleTasks,
    },
    provenance: policy.provenance,
  };
}

function buildSliceUnit(policy) {
  return [
    HOST_SLICE_MARKER,
    '[Unit]',
    'Description=Spec runtime wave aggregate resource ceiling',
    '',
    '[Slice]',
    `MemoryMax=${policy.poolMemoryBytes}`,
    `MemoryHigh=${aggregateMemoryHighBytes(policy)}`,
    `MemorySwapMax=${MEMORY_SWAP_MAX_BYTES}`,
    `TasksMax=${policy.aggregateTasks}`,
    `CPUQuota=${policy.cpuQuotaPercent}%`,
    `CPUWeight=${policy.cpuWeight}`,
    '',
  ].join('\n');
}

function sliceExpectations(policy) {
  return [
    ['MemoryMax', policy.poolMemoryBytes, parseByteValue],
    ['MemoryHigh', aggregateMemoryHighBytes(policy), parseByteValue],
    ['MemorySwapMax', MEMORY_SWAP_MAX_BYTES, parseByteValue],
    ['TasksMax', policy.aggregateTasks, parsePlainInteger],
    ['CPUQuotaPerSecUSec', policy.cpuQuotaPercent * 10_000, parseTimespanUsec],
    ['CPUWeight', policy.cpuWeight, parsePlainInteger],
  ];
}

// Foreign, invalid and symlinked targets are refused before any write; only an
// owned file with the owning marker/schema may be replaced.
function inspectInstallTarget(path, kind) {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { path, kind, status: 'absent', content: null, reason: null };
    return { path, kind, status: 'unreadable', content: null, reason: 'unreadable-target' };
  }
  if (info.isSymbolicLink()) return { path, kind, status: 'symlink', content: null, reason: 'symlink-target' };
  if (!info.isFile()) return { path, kind, status: 'invalid', content: null, reason: 'invalid-target' };
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return { path, kind, status: 'unreadable', content: null, reason: 'unreadable-target' };
  }
  if (kind === 'policy') {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { path, kind, status: 'invalid', content, reason: 'invalid-target' };
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.schema !== HOST_POLICY_SCHEMA || parsed.owner !== 'spec-runtime') {
      return { path, kind, status: 'foreign', content, parsed, reason: 'foreign-target' };
    }
    return { path, kind, status: 'owned', content, parsed, reason: null };
  }
  if (!content.includes(HOST_SLICE_MARKER)) return { path, kind, status: 'foreign', content, reason: 'foreign-target' };
  return { path, kind, status: 'owned', content, reason: null };
}

// The saved policy is read before host facts are computed so a repeated setup
// or flagless check inherits the advanced values recorded by the original
// install. Only fields whose saved provenance was explicit are applied, which
// preserves default provenance for values that were never supplied. Foreign,
// invalid, symlinked or unreadable saved policy is reported for refusal and is
// never replaced with defaults.
function loadSavedHostPolicy(paths) {
  const target = inspectInstallTarget(paths.policyPath, 'policy');
  if (target.status === 'absent') return { ok: true, status: 'absent', values: {} };
  if (target.status !== 'owned') {
    return { ok: false, status: target.status, reason: target.reason ?? 'invalid-target', detail: paths.policyPath };
  }
  const lifecycle = target.parsed.lifecycle;
  const aggregate = target.parsed.aggregate;
  if (lifecycle === null || typeof lifecycle !== 'object' || Array.isArray(lifecycle)
    || aggregate === null || typeof aggregate !== 'object' || Array.isArray(aggregate)) {
    return { ok: false, status: 'invalid', reason: 'invalid-target', detail: paths.policyPath };
  }
  const provenance = target.parsed.provenance !== null && typeof target.parsed.provenance === 'object' ? target.parsed.provenance : {};
  const values = {};
  if (provenance.lifecycleMemoryMib !== 'default') values.lifecycleMemoryMib = lifecycle.memoryMib;
  if (provenance.lifecycleTasks !== 'default') values.lifecycleTasks = lifecycle.tasksMax;
  if (provenance.aggregateTasks !== 'default') values.aggregateTasks = aggregate.tasksMax;
  const validation = validateSavedHostPolicy(values);
  if (!validation.ok) {
    return { ok: false, status: 'invalid', reason: 'invalid-target', detail: `${paths.policyPath}: ${validation.detail}` };
  }
  return { ok: true, status: 'owned', values };
}

// Advanced values saved by an earlier install are validated with the same
// calculator that governs admission: a non-positive, non-integer, missing or
// out-of-range value refuses the install instead of silently falling back.
function validateSavedHostPolicy(values) {
  const explicitKeys = Object.keys(values);
  if (explicitKeys.length === 0) return { ok: true };
  for (const key of explicitKeys) {
    if (values[key] === undefined) return { ok: false, detail: `${key} is missing from the saved policy` };
  }
  try {
    calculateResourcePolicy({
      physicalMemoryBytes: Number.MAX_SAFE_INTEGER,
      cpuCount: 1,
      readyMembers: 0,
      ...values,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function applySavedHostPolicy(values, shared) {
  for (const key of RUNTIME_HOST_FLAGS) {
    if (shared[key] === undefined && values[key] !== undefined) shared[key] = values[key];
  }
}

function runtimeHostCheckRefusal(paths, reason, detail = null) {
  return {
    version: 1,
    mode: 'check',
    action: 'check',
    ok: false,
    status: 'refused',
    reason,
    remedy: HOST_REMEDIES[reason] ?? null,
    detail,
    paths,
    check: null,
  };
}

function writeTargetAtomic(path, content, mode) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best-effort temp cleanup */ }
    throw error;
  }
}

function parseHostServiceList(stdout) {
  const services = [];
  const unknown = [];
  for (const raw of String(stdout).split('\n')) {
    const line = raw.trim();
    if (line === '' || /^Legend:/i.test(line)) continue;
    const columns = line.split(/\s+/);
    if (columns.length < 4) {
      unknown.push(line);
      continue;
    }
    const [unit, load, active, sub] = columns;
    if (!unit.startsWith('spec-runtime') || !unit.endsWith('.service')) continue;
    services.push({ unit, load, active, sub });
    if (load !== 'loaded' || active === 'unknown' || sub === 'unknown') unknown.push(unit);
  }
  return { services, unknown };
}

function parseByteValue(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (value === '') return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)([KMGTP]?)(?:i?B)?$/i.exec(value);
  if (match === null) return null;
  const power = { '': 0, K: 1, M: 2, G: 3, T: 4, P: 5 }[match[2].toUpperCase()];
  const bytes = Number(match[1]) * 1024 ** power;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function parsePlainInteger(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  return /^[0-9]+$/.test(value) ? Number(value) : null;
}

function parseTimespanUsec(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (value === '') return null;
  if (/^[0-9]+$/.test(value)) return Number(value);
  const scales = { us: 1, ms: 1_000, s: 1_000_000, min: 60_000_000, h: 3_600_000_000, d: 86_400_000_000 };
  let total = 0;
  let last = 0;
  for (const match of value.matchAll(/([0-9]+(?:\.[0-9]+)?)(us|ms|min|s|h|d)/g)) {
    if (match.index !== last) return null;
    total += Number(match[1]) * scales[match[2]];
    last = match.index + match[0].length;
  }
  return last === value.length && last > 0 && Number.isFinite(total) ? Math.round(total) : null;
}

async function verifyInstalledSlice({ runCommand, expected }) {
  const args = ['--user', 'show', HOST_SLICE_UNIT];
  for (const name of HOST_SLICE_PROPERTIES) args.push(`--property=${name}`);
  const record = await runCommand('systemctl', args, {});
  if (record.exitCode !== 0 || record.signal !== null) {
    return { verified: false, detail: `systemctl show ${HOST_SLICE_UNIT}: ${firstLine(record.stderr) ?? 'unreadable'}`, mismatches: [] };
  }
  const observed = new Map();
  for (const line of record.stdout.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) observed.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const mismatches = [];
  for (const [name, expectedValue, parse] of expected) {
    const actual = parse(observed.get(name));
    if (actual !== expectedValue) mismatches.push(`${name}: expected ${expectedValue}, observed ${observed.get(name) ?? 'unset'}`);
  }
  return { verified: mismatches.length === 0, detail: mismatches.length === 0 ? null : mismatches.join('; '), mismatches };
}

function setupRefusal(check, paths, reason, detail = null) {
  return {
    version: 1,
    mode: 'setup',
    action: 'setup',
    ok: false,
    status: 'refused',
    reason,
    remedy: HOST_REMEDIES[reason] ?? null,
    detail,
    paths,
    check,
    installed: null,
  };
}

function runtimeHostUsage(action, reason, message) {
  return {
    version: 1,
    mode: 'runtime-host',
    action: typeof action === 'string' ? action : null,
    ok: false,
    status: 'usage',
    reason,
    message,
    remedy: 'run runtime-host setup or runtime-host check with only --lifecycle-memory-mib N, --lifecycle-tasks N, --aggregate-tasks N (check also accepts --probe)',
  };
}

const RUNTIME_HOST_FLAGS = Object.freeze(['lifecycleMemoryMib', 'lifecycleTasks', 'aggregateTasks']);

export async function setupRuntimeHost(options = {}) {
  if (options === null || typeof options !== 'object') throw new Error('options must be an object');
  const {
    env = process.env,
    home = homedir(),
    ownership = null,
    registryRoot = undefined,
    run = defaultHostTransport,
    timeoutMs = HOST_CHECK_TIMEOUT_MS,
    runtimeDirBase = DEFAULT_RUNTIME_DIR_BASE,
    stat = statSync,
    ...checkOverrides
  } = options;

  let paths;
  try {
    paths = hostConfigPaths({ env, home });
  } catch (error) {
    return {
      version: 1,
      mode: 'setup',
      action: 'setup',
      ok: false,
      status: 'refused',
      reason: 'config-home-invalid',
      remedy: HOST_REMEDIES['config-home-invalid'],
      detail: error instanceof Error ? error.message : String(error),
      paths: null,
      check: null,
      installed: null,
    };
  }

  // A repeated setup with no advanced flags must keep the recorded policy. The
  // saved values are applied before host facts are computed so changeRequired
  // stays false for an identical owned install; explicit caller values win.
  const savedPolicy = loadSavedHostPolicy(paths);
  if (!savedPolicy.ok) return setupRefusal(null, paths, savedPolicy.reason, savedPolicy.detail);
  applySavedHostPolicy(savedPolicy.values, checkOverrides);

  // Setup always runs the bounded property probe: proven unit properties are a
  // precondition for installing the owned policy, even when bubblewrap is
  // absent and the overlay would fall back to the worktree route.
  const check = await checkRuntimeHost({ ...checkOverrides, env, run, timeoutMs, runtimeDirBase, stat, mode: 'setup', probe: true });
  if (!check.ok) {
    return {
      version: 1,
      mode: 'setup',
      action: 'setup',
      ok: false,
      status: check.status,
      reason: check.reason,
      remedy: check.remedy,
      detail: check.admission?.detail ?? null,
      paths,
      check,
      installed: null,
    };
  }
  if (check.properties?.source !== 'probe' || check.properties?.status !== 'supported') {
    return setupRefusal(check, paths, 'properties-unverified', check.properties?.detail ?? null);
  }

  const policy = check.policy;
  const desiredPolicy = `${JSON.stringify(buildHostPolicy(policy), null, 2)}\n`;
  const desiredSlice = buildSliceUnit(policy);
  const policyTarget = inspectInstallTarget(paths.policyPath, 'policy');
  const sliceTarget = inspectInstallTarget(paths.slicePath, 'slice');
  for (const target of [policyTarget, sliceTarget]) {
    if (target.status === 'symlink') return setupRefusal(check, paths, 'symlink-target', target.path);
    if (target.status === 'invalid') return setupRefusal(check, paths, 'invalid-target', target.path);
    if (target.status === 'unreadable') return setupRefusal(check, paths, 'unreadable-target', target.path);
    if (target.status === 'foreign') return setupRefusal(check, paths, 'foreign-target', `${target.kind}: ${target.path}`);
  }
  const policyState = policyTarget.status === 'absent' ? 'absent' : policyTarget.content === desiredPolicy ? 'unchanged' : 'changed';
  const sliceState = sliceTarget.status === 'absent' ? 'absent' : sliceTarget.content === desiredSlice ? 'unchanged' : 'changed';
  const changeRequired = policyState !== 'unchanged' || sliceState !== 'unchanged';

  const bus = resolveEffectiveUserBusEnvironment({ env, uid: check.platform.uid, runtimeDirBase, stat });
  const busEnvironment = bus.ok ? bus.environment : {};
  const pathValue = typeof env.PATH === 'string' && env.PATH !== ''
    ? env.PATH
    : typeof process.env.PATH === 'string'
      ? process.env.PATH
      : '';
  const commandEnv = extra => (pathValue === '' ? { ...extra } : { PATH: pathValue, ...extra });
  const runCommand = async (command, args, extra = {}) => {
    try {
      const record = await run({ command, args, env: extra.env ?? commandEnv(busEnvironment), timeoutMs: extra.timeoutMs ?? timeoutMs, cwd: extra.cwd });
      return hostRecord(record, command, args);
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : null;
      return hostRecord({ errorCode: code, stderr: error && typeof error.message === 'string' ? error.message : '' }, command, args);
    }
  };

  // A changed policy is refused while recorded capacity/checkout claims or
  // active/unknown spec-runtime services exist. Nothing here releases claims
  // or restarts services; setup is an install, not a lifecycle adapter.
  if (changeRequired) {
    const ownershipApi = ownership ?? createOwnership(registryRoot === undefined ? {} : { registryRoot });
    let claims;
    try {
      claims = await ownershipApi.inspectClaims();
    } catch (error) {
      return setupRefusal(check, paths, 'claims-unreadable', error instanceof Error ? error.message : String(error));
    }
    // The claims envelope is never defaulted to empty: an unreadable envelope
    // refuses, and malformed or unrecognized entries conservatively block the
    // change because their held capacity cannot be verified.
    const claimList = Array.isArray(claims)
      ? claims
      : claims !== null && typeof claims === 'object' && Array.isArray(claims.claims)
        ? claims.claims
        : null;
    if (claimList === null) {
      return setupRefusal(check, paths, 'claims-unreadable', 'ownership claims envelope is not an object with a claims array');
    }
    const blocking = [];
    const unrecognized = [];
    for (const claim of claimList) {
      if (claim === null || typeof claim !== 'object' || Array.isArray(claim) || typeof claim.kind !== 'string' || claim.kind === '') {
        unrecognized.push('malformed');
      } else if (claim.kind === 'capacity' || claim.kind === 'checkout') {
        blocking.push(claim);
      } else if (claim.kind !== 'package') {
        unrecognized.push(claim.kind);
      }
    }
    if (unrecognized.length > 0) {
      return setupRefusal(check, paths, 'claims-unknown', `${unrecognized.length} malformed or unrecognized claim record(s): ${unrecognized.join(', ')}`);
    }
    if (blocking.length > 0) {
      return setupRefusal(check, paths, 'claims-active', `${blocking.length} recorded capacity/checkout claim(s); runtime-host setup never releases live claims`);
    }
    const listRecord = await runCommand('systemctl', ['--user', 'list-units', '--all', '--no-legend', '--plain', HOST_SERVICE_UNIT_PATTERN]);
    if (listRecord.exitCode !== 0 || listRecord.signal !== null) {
      return setupRefusal(check, paths, 'services-unreadable', firstLine(listRecord.stderr));
    }
    const services = parseHostServiceList(listRecord.stdout);
    if (services.unknown.length > 0) {
      return setupRefusal(check, paths, 'services-unknown', services.unknown.join(', '));
    }
    const activeServices = services.services.filter(item => ['active', 'activating', 'deactivating', 'reloading'].includes(item.active));
    if (activeServices.length > 0) {
      return setupRefusal(check, paths, 'services-active', activeServices.map(item => `${item.unit} (${item.active})`).join(', '));
    }
  }

  const written = [];
  if (policyState !== 'unchanged') {
    try {
      writeTargetAtomic(paths.policyPath, desiredPolicy, 0o600);
    } catch (error) {
      return setupRefusal(check, paths, 'install-failed', `policy: ${error instanceof Error ? error.message : String(error)}`);
    }
    written.push('policy');
  }
  if (sliceState !== 'unchanged') {
    try {
      writeTargetAtomic(paths.slicePath, desiredSlice, 0o644);
    } catch (error) {
      return setupRefusal(check, paths, 'install-failed', `slice: ${error instanceof Error ? error.message : String(error)}`);
    }
    written.push('slice');
  }

  let daemonReload = 'not-needed';
  if (written.length > 0) {
    const reloadRecord = await runCommand('systemctl', ['--user', 'daemon-reload'], {});
    if (reloadRecord.exitCode !== 0 || reloadRecord.signal !== null) {
      return setupRefusal(check, paths, 'daemon-reload-unreachable', firstLine(reloadRecord.stderr));
    }
    daemonReload = 'reloaded';
  }
  const verification = await verifyInstalledSlice({ runCommand, expected: sliceExpectations(policy) });
  if (!verification.verified) {
    return setupRefusal(check, paths, 'slice-verification-failed', verification.detail);
  }

  return {
    version: 1,
    mode: 'setup',
    action: 'setup',
    ok: true,
    status: 'ready',
    reason: changeRequired ? 'installed' : 'unchanged',
    remedy: null,
    detail: null,
    paths,
    installed: {
      policy: policyState === 'unchanged' ? 'unchanged' : 'written',
      slice: sliceState === 'unchanged' ? 'unchanged' : 'written',
      daemonReload,
      verified: true,
      properties: [...HOST_SLICE_PROPERTIES],
    },
    policy: buildHostPolicy(policy),
    check,
  };
}

export async function runtimeHostCommand(action, flags = {}, options = {}) {
  if (action !== 'setup' && action !== 'check') {
    return { exitCode: 2, result: runtimeHostUsage(action, 'unsupported-action', 'runtime-host accepts setup or check') };
  }
  if (flags === null || typeof flags !== 'object' || Array.isArray(flags)) {
    return { exitCode: 2, result: runtimeHostUsage(action, 'unsupported-flags', 'runtime-host flags must be an object') };
  }
  for (const key of Object.keys(flags)) {
    if (!RUNTIME_HOST_FLAGS.includes(key) && key !== 'probe') {
      return { exitCode: 2, result: runtimeHostUsage(action, 'unsupported-flags', `unsupported runtime-host option ${key}`) };
    }
  }
  if (flags.probe !== undefined && typeof flags.probe !== 'boolean') {
    return { exitCode: 2, result: runtimeHostUsage(action, 'unsupported-flags', '--probe takes no value') };
  }
  if (action === 'setup' && flags.probe === true) {
    return { exitCode: 2, result: runtimeHostUsage(action, 'unsupported-flags', 'setup always runs the isolated probe; --probe applies to check') };
  }
  const shared = { ...options };
  for (const key of RUNTIME_HOST_FLAGS) {
    const value = flags[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      return { exitCode: 2, result: runtimeHostUsage(action, 'invalid-value', `${key} must be a positive integer`) };
    }
    shared[key] = value;
  }
  if (action === 'setup') {
    const result = await setupRuntimeHost(shared);
    return { exitCode: result.ok ? 0 : 1, result };
  }
  // A check with no advanced flags reports the recorded advanced policy. The
  // saved values are resolved here too so both CLI actions inherit an earlier
  // install, and a foreign/invalid/symlinked policy refuses instead of being
  // silently replaced by defaults.
  let paths;
  try {
    paths = hostConfigPaths({ env: shared.env ?? process.env, home: shared.home ?? homedir() });
  } catch (error) {
    return { exitCode: 1, result: runtimeHostCheckRefusal(null, 'config-home-invalid', error instanceof Error ? error.message : String(error)) };
  }
  const savedPolicy = loadSavedHostPolicy(paths);
  if (!savedPolicy.ok) {
    return { exitCode: 1, result: runtimeHostCheckRefusal(paths, savedPolicy.reason, savedPolicy.detail) };
  }
  applySavedHostPolicy(savedPolicy.values, shared);
  if (flags.probe === true) shared.probe = true;
  const result = await checkRuntimeHost(shared);
  return { exitCode: result.ok ? 0 : 1, result };
}

// ---------------------------------------------------------------------------
// Managed systemd lifecycle adapter
//
// createSystemdServiceAdapter() launches one root lifecycle phase as a unique
// transient user service under the owned spec-runtime.slice. The service runs
// a fixed inline bootstrap as its only trusted entrypoint: the bootstrap waits
// for a private runtime-owned authorization file whose token, unit and own
// InvocationID must match exactly before it spawns the real command argv with
// inherited stdio, cwd and environment. start() persists claim/identity
// through request.register and requires explicit true before the authorization
// file is written, polls the bounded query for the exact unit
// InvocationID/ControlGroup/MainPID, and keeps the systemd-run launcher PID
// distinct from that queried MainPID. inspect()/drain() distinguish terminal
// drain from unknown state (query error, changed invocation, foreign host/boot,
// unreadable cgroup) and never equate a bus error with unit absence. stop()
// acts only on the verified same-invocation unit and never signals a PID.
// There is no POSIX fallback when the bus, unit properties or start refuse.
// ---------------------------------------------------------------------------

export const DEFAULT_SERVICE_START_TIMEOUT_MS = 20_000;
export const DEFAULT_SERVICE_DRAIN_TIMEOUT_MS = 30_000;
export const SERVICE_QUERY_TIMEOUT_MS = 5_000;
export const SERVICE_POLL_INTERVAL_MS = 50;
export const SERVICE_UNIT_PREFIX = 'spec-runtime-';
export const SERVICE_SLICE_UNIT = 'spec-runtime.slice';
export const SERVICE_GATE_FILE = 'authorize.json';
export const SERVICE_GATE_DIR_PREFIX = 'spec-runtime-gate-';
export const SERVICE_SHOW_PROPERTIES = Object.freeze([
  'LoadState',
  'ActiveState',
  'SubState',
  'InvocationID',
  'ControlGroup',
  'MainPID',
  'Result',
  'ExecMainStatus',
]);

const SERVICE_SYSTEMD_KIND = 'systemd-service';
const SERVICE_POSIX_KIND = 'posix-process-group';
const SERVICE_DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// The fixed bootstrap is the service's only trusted entrypoint. It carries no
// caller text: the real command argv travels positionally after the script and
// every gate value arrives through the service environment. Token, unit and
// own INVOCATION_ID must match the authorization file exactly; any mismatch
// never authorizes and never spawns the command.
const SERVICE_GATE_BOOTSTRAP = [
  "const fs = require('fs');",
  "const { spawn } = require('child_process');",
  'const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));',
  'const fail = code => { process.exitCode = code; process.exit(code); };',
  'async function main() {',
  '  const gateDir = process.env.SPEC_RUNTIME_GATE_DIR;',
  '  const token = process.env.SPEC_RUNTIME_GATE_TOKEN;',
  '  const unit = process.env.SPEC_RUNTIME_UNIT;',
  '  const invocation = process.env.INVOCATION_ID;',
  '  const deadlineMs = Number(process.env.SPEC_RUNTIME_GATE_DEADLINE_MS);',
  '  if (!gateDir || !token || !unit || !invocation || !Number.isFinite(deadlineMs)) return fail(70);',
  "  const authPath = gateDir + '/authorize.json';",
  '  for (;;) {',
  '    let raw = null;',
  "    try { raw = fs.readFileSync(authPath, 'utf8'); } catch (error) { if (!error || error.code !== 'ENOENT') return fail(70); }",
  '    if (raw !== null) {',
  '      let authorization;',
  '      try { authorization = JSON.parse(raw); } catch { return fail(70); }',
  '      if (!authorization || authorization.token !== token || authorization.unit !== unit || authorization.invocation_id !== invocation) return fail(71);',
  '      break;',
  '    }',
  '    if (Date.now() > deadlineMs) return fail(72);',
  '    await sleep(50);',
  '  }',
  '  if (Date.now() > deadlineMs) return fail(72);',
  '  let argv = process.argv.slice(1);',
  "  if (argv[0] === '--') argv = argv.slice(1);",
  "  if (argv.length === 0 || typeof argv[0] !== 'string' || argv[0] === '') return fail(70);",
  '  const childEnv = { ...process.env };',
  '  delete childEnv.SPEC_RUNTIME_GATE_DIR;',
  '  delete childEnv.SPEC_RUNTIME_GATE_TOKEN;',
  '  delete childEnv.SPEC_RUNTIME_UNIT;',
  '  delete childEnv.SPEC_RUNTIME_GATE_DEADLINE_MS;',
  "  const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', cwd: process.cwd(), env: childEnv });",
  "  child.on('error', () => fail(70));",
  "  child.on('exit', (code, signal) => fail(typeof code === 'number' ? code : signal === 'SIGKILL' ? 137 : signal === 'SIGTERM' ? 143 : 70));",
  '}',
  'main();',
].join('\n');

// The existing serial POSIX group record gains the tagged-union kind without
// changing any of its fields; runtime.mjs wiring stays in the next packet.
export function tagPosixProcessRecord(record, fields = {}) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('record must be an object');
  return { ...record, ...fields, kind: SERVICE_POSIX_KIND };
}

export function isSystemdServiceRecord(record) {
  return record !== null && typeof record === 'object' && record.kind === SERVICE_SYSTEMD_KIND;
}

// argv-only systemd-run launcher spawn: no shell, explicit environment and the
// launcher's pipes preserved for the caller's stream parsing. The launcher PID
// is the systemd-run client, never the queried service MainPID.
function defaultServiceSpawn({ command, args = [], env = process.env, cwd = undefined, stdio = 'pipe' }) {
  return spawnProcess(command, args, { cwd, env, stdio, shell: false, detached: false });
}

function readTrimmed(path) {
  const text = readTextFile(path);
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : null;
}

function defaultHostIdentity() {
  return {
    host_id: readTrimmed('/etc/machine-id') ?? readTrimmed('/var/lib/dbus/machine-id'),
    boot_id: readTrimmed('/proc/sys/kernel/random/boot_id'),
    uid: typeof process.geteuid === 'function' ? process.geteuid() : null,
  };
}

// identity is either an explicit object/function supplied at construction (the
// portable fixture seam) or the real machine-id/boot-id/effective-uid triple.
// A missing component refuses the start rather than guessing.
async function resolveHostIdentity(identity) {
  const provided = typeof identity === 'function' ? await identity() : identity;
  const fallback = defaultHostIdentity();
  const candidate = provided === null || provided === undefined ? fallback : provided;
  if (candidate === null || typeof candidate !== 'object') return null;
  const hostId =
    typeof candidate.host_id === 'string' && candidate.host_id.trim() !== '' ? candidate.host_id.trim() : fallback.host_id;
  const bootId =
    typeof candidate.boot_id === 'string' && candidate.boot_id.trim() !== '' ? candidate.boot_id.trim() : fallback.boot_id;
  const uid = Number.isSafeInteger(candidate.uid) && candidate.uid >= 0 ? candidate.uid : fallback.uid;
  if (hostId === null || bootId === null || !Number.isSafeInteger(uid) || uid < 0) return null;
  return { host_id: hostId, boot_id: bootId, uid };
}

// The lifecycle reservation is fixed per adapter (or per start request). The
// values come from calculateResourcePolicy() when no explicit policy is given.
function normalizeServiceLimits(source) {
  if (source === null || source === undefined) return null;
  if (typeof source !== 'object' || Array.isArray(source)) throw new Error('limits must be an object');
  const memoryBytes = source.memoryBytes ?? source.lifecycleMemoryBytes;
  const memoryHighBytes = source.memoryHighBytes;
  const tasksMax = source.tasksMax ?? source.lifecycleTasks;
  const cpuWeight = source.cpuWeight;
  const cpuQuotaPercent = source.cpuQuotaPercent ?? null;
  requirePositiveSafeInteger(memoryBytes, 'limits.memoryBytes');
  requirePositiveSafeInteger(memoryHighBytes, 'limits.memoryHighBytes');
  if (memoryHighBytes > memoryBytes) throw new Error('limits.memoryHighBytes must not exceed limits.memoryBytes');
  requirePositiveInteger(tasksMax, 'limits.tasksMax');
  requirePositiveInteger(cpuWeight, 'limits.cpuWeight');
  if (cpuQuotaPercent !== null && (!Number.isSafeInteger(cpuQuotaPercent) || cpuQuotaPercent <= 0)) {
    throw new Error('limits.cpuQuotaPercent must be a positive safe integer');
  }
  return { memoryBytes, memoryHighBytes, memorySwapMaxBytes: MEMORY_SWAP_MAX_BYTES, tasksMax, cpuWeight, cpuQuotaPercent };
}

function defaultServiceLimits() {
  const policy = calculateResourcePolicy({ physicalMemoryBytes: totalmem(), cpuCount: availableParallelism() });
  return normalizeServiceLimits(policy);
}

// The argument is the recorded cgroup directory; the events file lives at
// <group>/cgroup.events. An absent directory is distinct from a directory
// whose events file is missing or unreadable, and only 0/1 is accepted.
function readCgroupEvents(directory) {
  let text;
  try {
    text = readFileSync(join(directory, 'cgroup.events'), 'utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') return { state: 'unreadable' };
    try {
      statSync(directory);
    } catch (statError) {
      return { state: statError && statError.code === 'ENOENT' ? 'absent' : 'unreadable' };
    }
    return { state: 'unreadable' };
  }
  for (const raw of text.split('\n')) {
    const parts = raw.trim().split(/\s+/);
    if (parts[0] !== 'populated') continue;
    if (parts[1] === '1') return { state: 'populated' };
    if (parts[1] === '0') return { state: 'empty' };
    return { state: 'unreadable' };
  }
  return { state: 'unreadable' };
}

async function queryServiceUnit({ unit, runCommand, env, timeoutMs }) {
  const args = ['--user', 'show', unit];
  for (const name of SERVICE_SHOW_PROPERTIES) args.push(`--property=${name}`);
  let record;
  try {
    record = await runCommand('systemctl', args, { env, timeoutMs });
  } catch (error) {
    return { status: 'query-error', detail: { error_code: error && error.code ? String(error.code) : null } };
  }
  if (record.exitCode !== 0 || record.signal !== null) {
    return { status: 'query-error', detail: { exit_code: record.exitCode, signal: record.signal, error_code: record.errorCode } };
  }
  const values = new Map();
  for (const line of record.stdout.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const property = name => {
    const value = values.get(name);
    return typeof value === 'string' ? value : '';
  };
  return {
    status: 'ok',
    unit,
    load_state: property('LoadState'),
    active_state: property('ActiveState'),
    sub_state: property('SubState'),
    invocation_id: property('InvocationID'),
    control_group: property('ControlGroup'),
    main_pid: parsePlainInteger(property('MainPID')) ?? 0,
    result: property('Result'),
    exec_main_status: parsePlainInteger(property('ExecMainStatus')),
  };
}

function serviceTerminal(snapshot) {
  return snapshot.load_state === 'not-found' || snapshot.active_state === 'inactive' || snapshot.active_state === 'failed';
}

function serviceOutcome(result) {
  switch (result) {
    case 'timeout': return 'timeout';
    case 'oom-kill': return 'oom-kill';
    case 'success': return 'success';
    case 'exit-code': return 'exit-code';
    case 'signal': return 'signal';
    case 'core-dump': return 'core-dump';
    case 'watchdog': return 'watchdog';
    case '': return null;
    default: return result;
  }
}

async function queryServiceJobs({ runCommand, env, timeoutMs }) {
  const args = ['--user', 'list-jobs', '--no-legend', '--no-pager'];
  let record;
  try {
    record = await runCommand('systemctl', args, { env, timeoutMs });
  } catch {
    return { status: 'unreadable', count: null };
  }
  if (record.exitCode !== 0 || record.signal !== null) return { status: 'unreadable', count: null };
  const lines = record.stdout.split('\n').map(line => line.trim()).filter(line => line !== '' && !/^No jobs/i.test(line));
  return { status: 'ok', count: lines.length };
}

function buildServiceSetenv(clientEnv, busEnvironment, gate) {
  const entries = new Map();
  // The manager and the gate own INVOCATION_ID and SPEC_RUNTIME_*; caller
  // values for those names never reach the service environment.
  const reserved = name => name === 'INVOCATION_ID' || name.startsWith('SPEC_RUNTIME_');
  for (const [name, value] of Object.entries(clientEnv)) {
    if (reserved(name)) continue;
    if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) entries.set(name, value);
  }
  for (const [name, value] of Object.entries(busEnvironment)) {
    if (reserved(name)) continue;
    if (typeof value === 'string') entries.set(name, value);
  }
  if (typeof entries.get('PATH') !== 'string' || entries.get('PATH') === '') entries.set('PATH', SERVICE_DEFAULT_PATH);
  entries.set('SPEC_RUNTIME_GATE_DIR', gate.gateDir);
  entries.set('SPEC_RUNTIME_GATE_TOKEN', gate.token);
  entries.set('SPEC_RUNTIME_UNIT', gate.unit);
  entries.set('SPEC_RUNTIME_GATE_DEADLINE_MS', String(gate.deadline.expires_at));
  return [...entries].map(([name, value]) => `--setenv=${name}=${value}`);
}

function buildServiceRunArgs({ unit, cwd, limits, runtimeMaxSec, setenv, argv }) {
  const args = [
    '--user',
    '--pipe',
    '--wait',
    '--collect',
    '--service-type=exec',
    `--unit=${unit}`,
    `--slice=${SERVICE_SLICE_UNIT}`,
    '--property=KillMode=control-group',
    '--property=SendSIGKILL=yes',
    `--property=RuntimeMaxSec=${runtimeMaxSec}`,
    `--property=MemoryMax=${limits.memoryBytes}`,
    `--property=MemoryHigh=${limits.memoryHighBytes}`,
    `--property=MemorySwapMax=${limits.memorySwapMaxBytes}`,
    `--property=TasksMax=${limits.tasksMax}`,
    `--property=CPUWeight=${limits.cpuWeight}`,
  ];
  if (limits.cpuQuotaPercent !== null) args.push(`--property=CPUQuota=${limits.cpuQuotaPercent}%`);
  args.push(`--working-directory=${cwd}`);
  args.push(...setenv);
  args.push('--', process.execPath, '-e', SERVICE_GATE_BOOTSTRAP, '--', ...argv);
  return args;
}

// Gate cleanup happens only for a positively drained record whose directory is
// in this adapter's locally tracked set of gates it created with mkdtemp under
// the recorded runtime base. A recovered record's gate directory is never
// removed, even when it sits under the same root.
function cleanupServiceGate(record, createdGates) {
  if (record === null || typeof record !== 'object') return false;
  const dir = typeof record.gate_dir === 'string' && isAbsolute(record.gate_dir) ? record.gate_dir : null;
  const root = typeof record.gate_root === 'string' && isAbsolute(record.gate_root) ? record.gate_root : null;
  if (dir === null || root === null) return false;
  if (!(createdGates instanceof Set) || !createdGates.has(dir)) return false;
  if (!basename(dir).startsWith(SERVICE_GATE_DIR_PREFIX)) return false;
  const rel = relative(root, dir);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    createdGates.delete(dir);
    return true;
  } catch {
    return false;
  }
}

function delayMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function unknownServiceObservation(record, reason, extra = {}) {
  return {
    status: 'unknown',
    ok: false,
    reason,
    unit: record.unit,
    invocation_id: record.invocation_id ?? null,
    observed_invocation_id: null,
    control_group: record.control_group ?? null,
    observed_control_group: null,
    main_pid: record.main_pid ?? null,
    launcher_pid: record.launcher && Number.isSafeInteger(record.launcher.pid) ? record.launcher.pid : null,
    launcher: extra.launcher ?? null,
    jobs: null,
    cgroup: { path: null, state: null },
    service: null,
    identity: extra.identity ?? null,
    claim_released: false,
    detail: extra.detail ?? null,
    remedy: extra.remedy ?? null,
  };
}

// Failure and unknown start results expose the same convenience identity
// fields as a successful start so callers can compare the launched and
// retained record identity; identities not yet established stay null.
function serviceStartIdentity(record) {
  return {
    unit: record.unit,
    invocation_id: record.invocation_id ?? null,
    control_group: record.control_group ?? null,
    main_pid: record.main_pid ?? null,
    launcher_pid: record.launcher && Number.isSafeInteger(record.launcher.pid) ? record.launcher.pid : null,
  };
}

export function createSystemdServiceAdapter(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new Error('options must be an object');
  const {
    run = defaultHostTransport,
    spawn: spawnTransport = defaultServiceSpawn,
    identity = null,
    cgroupRoot = CGROUP_V2_ROOT,
    gateRoot = null,
    policy = null,
    limits = null,
    env = process.env,
    startTimeoutMs = DEFAULT_SERVICE_START_TIMEOUT_MS,
    drainTimeoutMs = DEFAULT_SERVICE_DRAIN_TIMEOUT_MS,
    queryTimeoutMs = SERVICE_QUERY_TIMEOUT_MS,
    pollIntervalMs = SERVICE_POLL_INTERVAL_MS,
    now = Date.now,
  } = options;
  if (typeof run !== 'function') throw new Error('run must be a function');
  if (typeof spawnTransport !== 'function') throw new Error('spawn must be a function');
  if (env === null || typeof env !== 'object' || Array.isArray(env)) throw new Error('env must be an object');
  if (!isAbsolute(cgroupRoot)) throw new Error('cgroupRoot must be an absolute path');
  if (gateRoot !== null && !isAbsolute(gateRoot)) throw new Error('gateRoot must be an absolute path');
  requirePositiveSafeInteger(startTimeoutMs, 'startTimeoutMs');
  requireNonNegativeInteger(drainTimeoutMs, 'drainTimeoutMs');
  requirePositiveSafeInteger(queryTimeoutMs, 'queryTimeoutMs');
  requirePositiveInteger(pollIntervalMs, 'pollIntervalMs');
  if (typeof now !== 'function') throw new Error('now must be a function');
  const configuredLimits = normalizeServiceLimits(limits ?? policy);
  let computedLimits = null;
  const launchers = new Map();
  // Gate directories this adapter created and may remove; recovered gates are
  // never members and are left in place.
  const createdGates = new Set();

  // Transport convention matches the host-check/overlay helpers: the injected
  // run takes one options object, this wrapper normalizes its raw record,
  // substitutes a PATH default and turns transport throws into errorCode.
  const runCommand = async (command, args, extra = {}) => {
    const baseEnv = extra.env ?? env;
    const mergedEnv = typeof baseEnv.PATH === 'string' && baseEnv.PATH !== '' ? baseEnv : { ...baseEnv, PATH: SERVICE_DEFAULT_PATH };
    try {
      const rawRecord = await run({ command, args, env: mergedEnv, timeoutMs: extra.timeoutMs ?? queryTimeoutMs, cwd: extra.cwd });
      return hostRecord(rawRecord, command, args);
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : null;
      return hostRecord({ errorCode: code, stderr: error && typeof error.message === 'string' ? error.message : '' }, command, args);
    }
  };

  function resolveLimits(requestLimits) {
    const explicit = normalizeServiceLimits(requestLimits);
    if (explicit !== null) return explicit;
    if (configuredLimits !== null) return configuredLimits;
    if (computedLimits === null) computedLimits = defaultServiceLimits();
    return computedLimits;
  }

  // Liveness of the systemd-run client only. A live or unknown launcher blocks
  // drain; for a recovered record only ESRCH proves the launcher absent. The
  // launcher PID is never used as the worker process group.
  function launcherState(record) {
    const tracked = launchers.get(record.unit);
    if (tracked) {
      const exited = tracked.exitCode !== null && tracked.exitCode !== undefined;
      const signaled = tracked.signalCode !== null && tracked.signalCode !== undefined;
      return exited || signaled ? 'settled' : 'live';
    }
    const pid = record.launcher && Number.isSafeInteger(record.launcher.pid) ? record.launcher.pid : null;
    if (pid === null || pid <= 1) return 'unknown';
    try {
      process.kill(pid, 0);
      return 'live';
    } catch (error) {
      if (error && error.code === 'ESRCH') return 'settled';
      return error && error.code === 'EPERM' ? 'live' : 'unknown';
    }
  }

  async function requestStopUnit(record, requestEnv) {
    const args = ['--user', 'stop', '--no-block', record.unit];
    try {
      const result = await runCommand('systemctl', args, { env: requestEnv, timeoutMs: queryTimeoutMs });
      return { ok: result.exitCode === 0 && result.signal === null, exit_code: result.exitCode, signal: result.signal, error_code: result.errorCode };
    } catch (error) {
      return { ok: false, exit_code: null, signal: null, error_code: error && error.code ? String(error.code) : null };
    }
  }

  // Every stop request first re-verifies the same host/user/boot and a live
  // exact invocation. A not-found unit is reported for inspect-based drain
  // evidence and is never stopped; a record without an established invocation
  // is retained rather than stopped blindly.
  async function stopVerified(record, requestEnv) {
    const currentIdentity = await resolveHostIdentity(identity);
    if (currentIdentity === null) return { ok: false, status: 'unknown', reason: 'identity-unavailable' };
    if (currentIdentity.host_id !== record.host_id) return { ok: false, status: 'unknown', reason: 'foreign-host' };
    if (currentIdentity.uid !== record.uid) return { ok: false, status: 'unknown', reason: 'foreign-user' };
    if (currentIdentity.boot_id !== record.boot_id) return { ok: false, status: 'unknown', reason: 'changed-boot' };
    if (typeof record.invocation_id !== 'string' || record.invocation_id === '') {
      return { ok: false, status: 'unknown', reason: 'identity-unestablished' };
    }
    const before = await queryServiceUnit({ unit: record.unit, runCommand, env: requestEnv, timeoutMs: queryTimeoutMs });
    if (before.status !== 'ok') return { ok: false, status: 'unknown', reason: 'query-error', detail: before.detail };
    if (before.load_state === 'not-found') return { ok: true, status: 'not-found', not_found: true };
    if (before.invocation_id !== record.invocation_id) {
      return { ok: false, status: 'unknown', reason: 'changed-invocation' };
    }
    const requested = await requestStopUnit(record, requestEnv);
    if (requested.ok !== true) return { ok: false, status: 'unknown', reason: 'stop-refused', detail: requested };
    return { ok: true, status: 'stop-requested' };
  }

  // A start failure stops the unit only when the record's own queried identity
  // is established; otherwise the gate and record are retained for later
  // inspection.
  async function stopIfEstablished(record, requestEnv) {
    if (typeof record.invocation_id !== 'string' || record.invocation_id === '') return false;
    await stopVerified(record, requestEnv);
    return true;
  }

  async function inspect(record, inspectOptions = {}) {
    if (record === null || typeof record !== 'object' || record.kind !== SERVICE_SYSTEMD_KIND) {
      throw new Error('record must be a systemd-service record');
    }
    if (typeof record.unit !== 'string' || !record.unit.startsWith(SERVICE_UNIT_PREFIX)) {
      throw new Error('record.unit must be a spec-runtime service unit');
    }
    if (typeof record.invocation_id !== 'string' || record.invocation_id === '') {
      throw new Error('record.invocation_id must be set before inspect');
    }
    const requestEnv = inspectOptions.env ?? env;
    const ownershipVerified = inspectOptions.ownershipVerified === true;
    const bus = resolveEffectiveUserBusEnvironment({ env: requestEnv });
    if (bus.ok !== true) return unknownServiceObservation(record, 'bus-unavailable', { remedy: bus.remedy });
    const currentIdentity = await resolveHostIdentity(identity);
    if (currentIdentity === null) return unknownServiceObservation(record, 'identity-unavailable');
    if (currentIdentity.host_id !== record.host_id) return unknownServiceObservation(record, 'foreign-host', { identity: currentIdentity });
    if (currentIdentity.uid !== record.uid) return unknownServiceObservation(record, 'foreign-user', { identity: currentIdentity });
    const bootChanged = currentIdentity.boot_id !== record.boot_id;
    const serviceEnv = { ...requestEnv, ...bus.environment };
    const query = await queryServiceUnit({ unit: record.unit, runCommand, env: serviceEnv, timeoutMs: queryTimeoutMs });
    if (query.status !== 'ok') return unknownServiceObservation(record, 'query-error', { detail: query.detail, identity: currentIdentity });
    const notFound = query.load_state === 'not-found';
    if (!notFound && query.invocation_id !== record.invocation_id) {
      return unknownServiceObservation(record, 'changed-invocation', { identity: currentIdentity });
    }
    if (!notFound && query.control_group !== '' && record.control_group !== null && query.control_group !== record.control_group) {
      return unknownServiceObservation(record, 'changed-cgroup', { identity: currentIdentity });
    }
    const recordedGroup = record.control_group ?? query.control_group;
    const cgroupPath = typeof recordedGroup === 'string' && recordedGroup !== '' ? join(cgroupRoot, recordedGroup) : null;
    if (cgroupPath !== null && !pathInside(cgroupPath, cgroupRoot)) {
      return unknownServiceObservation(record, 'cgroup-path-outside-root', { identity: currentIdentity });
    }
    const cgroup = cgroupPath === null ? { state: 'unreadable' } : readCgroupEvents(cgroupPath);
    const launcher = launcherState(record);
    const jobs = await queryServiceJobs({ runCommand, env: serviceEnv, timeoutMs: queryTimeoutMs });
    const service = {
      load_state: query.load_state,
      active_state: query.active_state,
      sub_state: query.sub_state,
      result: query.result === '' ? null : query.result,
      exec_main_status: query.exec_main_status,
      outcome: serviceOutcome(query.result),
      terminal: serviceTerminal(query),
    };
    const observation = {
      status: 'unknown',
      ok: false,
      reason: null,
      unit: record.unit,
      invocation_id: record.invocation_id,
      observed_invocation_id: notFound ? null : query.invocation_id,
      control_group: record.control_group,
      observed_control_group: notFound ? null : query.control_group,
      main_pid: query.main_pid,
      launcher_pid: record.launcher && Number.isSafeInteger(record.launcher.pid) ? record.launcher.pid : null,
      launcher,
      jobs: jobs.status === 'ok' ? (jobs.count === 0 ? 'none' : 'pending') : 'unreadable',
      cgroup: { path: cgroupPath, state: cgroup.state },
      service,
      identity: {
        host_id: record.host_id,
        boot_id: record.boot_id,
        uid: record.uid,
        observed: currentIdentity,
        boot_changed: bootChanged,
        ownership_verified: ownershipVerified,
      },
      claim_released: false,
      detail: null,
      remedy: null,
    };
    if (cgroup.state === 'populated') return { ...observation, status: 'populated', reason: 'cgroup-populated' };
    if (bootChanged && !ownershipVerified) return { ...observation, reason: 'changed-boot' };
    if (launcher === 'live') return { ...observation, reason: 'launcher-live' };
    if (launcher !== 'settled') return { ...observation, reason: 'launcher-unknown' };
    if (jobs.status !== 'ok') return { ...observation, reason: 'jobs-unreadable' };
    if (jobs.count !== 0) return { ...observation, reason: 'jobs-pending' };
    if (cgroup.state === 'unreadable') return { ...observation, reason: 'cgroup-unreadable' };
    // A manager not-found result proves drain only with the recorded cgroup
    // directory absent; a lingering empty cgroup is not proof.
    if (notFound && cgroup.state !== 'absent') return { ...observation, reason: 'cgroup-not-absent' };
    const drained = service.terminal && (cgroup.state === 'empty' || cgroup.state === 'absent');
    if (!drained) return { ...observation, reason: 'not-terminal' };
    return { ...observation, status: 'confirmed', ok: true, reason: notFound ? 'unit-not-found' : 'unit-terminal-drained' };
  }

  async function start(request = {}) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new Error('start request must be an object');
    const argv = request.argv;
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      typeof argv[0] !== 'string' ||
      argv[0] === '' ||
      !argv.every(part => typeof part === 'string')
    ) {
      throw new Error('request.argv must be a non-empty array of strings with a non-empty executable');
    }
    if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd)) throw new Error('request.cwd must be an absolute path');
    const callerEnv = request.env ?? env;
    if (callerEnv === null || typeof callerEnv !== 'object' || Array.isArray(callerEnv)) throw new Error('request.env must be an object');
    if (typeof request.register !== 'function') throw new Error('request.register must be a function');
    const deadline = request.deadline;
    let runtimeMaxSec;
    try {
      runtimeMaxSec = runtimeMaxSecFor(deadline, now());
    } catch (error) {
      return { ok: false, status: 'refused', reason: 'deadline-invalid', detail: error && error.message ? error.message : null, record: null };
    }
    const bus = resolveEffectiveUserBusEnvironment({ env: callerEnv });
    if (bus.ok !== true) {
      return { ok: false, status: bus.status ?? 'refused', reason: `bus-${bus.reason}`, remedy: bus.remedy, record: null };
    }
    let effectiveLimits;
    try {
      effectiveLimits = resolveLimits(request.limits);
    } catch (error) {
      return { ok: false, status: 'refused', reason: 'capacity-below-lifecycle', detail: error && error.message ? error.message : null, record: null };
    }
    const currentIdentity = await resolveHostIdentity(identity);
    if (currentIdentity === null || currentIdentity.uid === 0) {
      return {
        ok: false,
        status: 'refused',
        reason: currentIdentity === null ? 'identity-unavailable' : 'root-identity',
        remedy: currentIdentity === null
          ? 'run on Linux with readable /etc/machine-id, boot_id and effective uid'
          : 'run the managed systemd adapter as the effective non-root user',
        record: null,
      };
    }
    const effectiveGateRoot = gateRoot ?? bus.xdgRuntimeDir.path;
    let gateDir;
    try {
      gateDir = mkdtempSync(join(effectiveGateRoot, SERVICE_GATE_DIR_PREFIX));
      chmodSync(gateDir, 0o700);
      createdGates.add(gateDir);
    } catch (error) {
      return { ok: false, status: 'refused', reason: 'gate-dir-unavailable', detail: error && error.code ? String(error.code) : null, record: null };
    }
    const unit = `${SERVICE_UNIT_PREFIX}${randomBytes(12).toString('hex')}.service`;
    const token = randomBytes(32).toString('hex');
    const clientEnv = { ...callerEnv, ...bus.environment };
    if (typeof clientEnv.PATH !== 'string' || clientEnv.PATH === '') clientEnv.PATH = SERVICE_DEFAULT_PATH;
    const setenv = buildServiceSetenv(callerEnv, bus.environment, { gateDir, token, unit, deadline });
    const args = buildServiceRunArgs({ unit, cwd: request.cwd, limits: effectiveLimits, runtimeMaxSec, setenv, argv });
    let child;
    try {
      child = spawnTransport({ command: 'systemd-run', args, env: clientEnv, cwd: request.cwd, stdio: request.stdio ?? ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      cleanupServiceGate({ gate_dir: gateDir, gate_root: effectiveGateRoot }, createdGates);
      return { ok: false, status: 'refused', reason: 'launch-failed', detail: error && error.code ? String(error.code) : null, record: null };
    }
    if (child === null || child === undefined || typeof child !== 'object') {
      cleanupServiceGate({ gate_dir: gateDir, gate_root: effectiveGateRoot }, createdGates);
      return { ok: false, status: 'refused', reason: 'launch-failed', detail: null, record: null };
    }
    const launcherPid = Number.isSafeInteger(child.pid) ? child.pid : null;
    if (typeof child.once === 'function') {
      child.once('error', error => {
        child.launchError = error;
      });
    }
    const startedAt = now();
    const record = {
      kind: SERVICE_SYSTEMD_KIND,
      unit,
      invocation_id: null,
      control_group: null,
      main_pid: null,
      launcher: { pid: launcherPid, transport: 'systemd-run' },
      host_id: currentIdentity.host_id,
      boot_id: currentIdentity.boot_id,
      uid: currentIdentity.uid,
      deadline: {
        started_at: Number.isSafeInteger(deadline.started_at) ? deadline.started_at : null,
        timeout_ms: Number.isSafeInteger(deadline.timeout_ms) ? deadline.timeout_ms : null,
        expires_at: deadline.expires_at,
      },
      started_at: startedAt,
      runtime_max_sec: runtimeMaxSec,
      limits: { ...effectiveLimits },
      gate_dir: gateDir,
      gate_root: effectiveGateRoot,
    };
    launchers.set(unit, child);
    const waitDeadline = startedAt + startTimeoutMs;
    let snapshot = null;
    for (;;) {
      if (child.launchError) {
        // No queried identity yet: never stop blindly; the record and gate are
        // retained for later inspection.
        await stopIfEstablished(record, clientEnv);
        return { ok: false, status: 'refused', reason: 'launch-failed', ...serviceStartIdentity(record), record, child, gate_dir: gateDir };
      }
      const query = await queryServiceUnit({ unit, runCommand, env: clientEnv, timeoutMs: queryTimeoutMs });
      if (query.status === 'ok') {
        if (query.invocation_id !== '' && query.control_group !== '' && query.main_pid > 0) {
          snapshot = query;
          break;
        }
        if (query.active_state === 'failed') {
          if (query.invocation_id !== '' && query.control_group !== '') {
            record.invocation_id = query.invocation_id;
            record.control_group = query.control_group;
          }
          await stopIfEstablished(record, clientEnv);
          return { ok: false, status: 'unknown', reason: 'unit-failed', ...serviceStartIdentity(record), record, child, gate_dir: gateDir };
        }
      }
      if (now() >= waitDeadline) {
        await stopIfEstablished(record, clientEnv);
        return { ok: false, status: 'unknown', reason: 'start-timeout', ...serviceStartIdentity(record), record, child, gate_dir: gateDir };
      }
      await delayMs(pollIntervalMs);
    }
    record.invocation_id = snapshot.invocation_id;
    record.control_group = snapshot.control_group;
    record.main_pid = snapshot.main_pid;
    let registered;
    try {
      registered = await request.register(record);
    } catch {
      registered = false;
    }
    if (registered !== true) {
      await stopIfEstablished(record, clientEnv);
      return { ok: false, status: 'register-refused', reason: 'register-refused', ...serviceStartIdentity(record), record, child, gate_dir: gateDir };
    }
    // A register callback may change the environment: re-verify this host,
    // user and boot and the unchanged wave deadline before authorizing.
    const refreshIdentity = await resolveHostIdentity(identity);
    if (
      refreshIdentity === null ||
      refreshIdentity.host_id !== currentIdentity.host_id ||
      refreshIdentity.boot_id !== currentIdentity.boot_id ||
      refreshIdentity.uid !== currentIdentity.uid
    ) {
      await stopIfEstablished(record, clientEnv);
      return { ok: false, status: 'refused', reason: 'identity-changed', ...serviceStartIdentity(record), record, child, gate_dir: gateDir };
    }
    if (now() >= deadline.expires_at) {
      await stopIfEstablished(record, clientEnv);
      return { ok: false, status: 'refused', reason: 'deadline-expired', ...serviceStartIdentity(record), record, child, gate_dir: gateDir };
    }
    try {
      writeTargetAtomic(join(gateDir, SERVICE_GATE_FILE), `${JSON.stringify({ token, unit, invocation_id: record.invocation_id })}\n`, 0o600);
    } catch (error) {
      await stopIfEstablished(record, clientEnv);
      return { ok: false, status: 'refused', reason: 'gate-write-failed', detail: error && error.code ? String(error.code) : null, ...serviceStartIdentity(record), record, child, gate_dir: gateDir };
    }
    return {
      ok: true,
      status: 'started',
      unit,
      invocation_id: record.invocation_id,
      control_group: record.control_group,
      main_pid: record.main_pid,
      launcher_pid: launcherPid,
      child,
      record,
      gate_dir: gateDir,
    };
  }

  // stop() acts only on the verified same-host/user/boot and same-invocation
  // unit, never on a PID. A not-found unit is inspected without issuing a stop.
  // A bus refusal is reported as unknown; timeout/OOM results are reported
  // distinctly from provider errors.
  async function stop(record, stopOptions = {}) {
    if (record === null || typeof record !== 'object' || record.kind !== SERVICE_SYSTEMD_KIND) {
      throw new Error('record must be a systemd-service record');
    }
    if (typeof record.unit !== 'string' || typeof record.invocation_id !== 'string' || record.invocation_id === '') {
      throw new Error('record must carry unit and invocation_id before stop');
    }
    const requestEnv = stopOptions.env ?? env;
    const bus = resolveEffectiveUserBusEnvironment({ env: requestEnv });
    if (bus.ok !== true) return { ok: false, status: 'unknown', reason: 'bus-unavailable', remedy: bus.remedy };
    const serviceEnv = { ...requestEnv, ...bus.environment };
    const requested = await stopVerified(record, serviceEnv);
    if (requested.not_found === true) {
      // The manager cannot find the unit: gather the recorded cgroup, launcher
      // and job evidence through inspect and never issue a stop.
      return inspect(record, { env: requestEnv, ownershipVerified: stopOptions.ownershipVerified });
    }
    if (requested.ok !== true) {
      return { ok: false, status: 'unknown', reason: requested.reason, detail: requested.detail ?? null };
    }
    if (stopOptions.wait === false) return { ok: true, status: 'stop-requested' };
    return drain(record, { env: requestEnv, timeoutMs: stopOptions.timeoutMs, ownershipVerified: stopOptions.ownershipVerified });
  }

  // drain() polls the same query until the record is positively drained, a
  // populated cgroup is observed, or the bounded wait expires. Claims are never
  // released here and the gate directory is removed only on a confirmed drain.
  async function drain(record, drainOptions = {}) {
    if (record === null || typeof record !== 'object' || record.kind !== SERVICE_SYSTEMD_KIND) {
      throw new Error('record must be a systemd-service record');
    }
    const requestEnv = drainOptions.env ?? env;
    const timeoutMs = drainOptions.timeoutMs === undefined ? drainTimeoutMs : drainOptions.timeoutMs;
    requireNonNegativeInteger(timeoutMs, 'drain timeoutMs');
    const waitDeadline = now() + timeoutMs;
    let last = null;
    for (;;) {
      last = await inspect(record, { env: requestEnv, ownershipVerified: drainOptions.ownershipVerified });
      if (last.status === 'confirmed') {
        const cleaned = cleanupServiceGate(record, createdGates);
        return { ...last, gate_cleaned: cleaned };
      }
      if (last.status === 'populated') return last;
      if (now() >= waitDeadline) return { ...last, reason: 'drain-timeout' };
      await delayMs(pollIntervalMs);
    }
  }

  return Object.freeze({ start, inspect, stop, drain });
}
