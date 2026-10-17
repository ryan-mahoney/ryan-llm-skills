// EV-14 host and service support (D-14, D-16, D-18).
//
// This module owns the small, shared surface the Linux rehearsal cases need:
// the installed-Pi resolver (moved out of the native test unchanged), bounded
// host commands and preconditions, and a per-case service helper that samples
// real user-unit cgroups and cleans up exactly the records it registered.
// It sets up no host policy and never removes the fixture root.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSystemdServiceAdapter, createWaveDeadline } from './linux-resources.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = join(here, '..', '..', '..');
const cliPath = join(checkout, 'scripts', 'spec-observe', 'cli.mjs');

const EV14_COMMAND_TIMEOUT_MS = 30_000;
const EV14_SAMPLE_INTERVAL_MS = 250;
const EV14_CONFIRM_TIMEOUT_MS = 30_000;
const EV14_POLL_INTERVAL_MS = 100;
const EV14_DIAGNOSTIC_LABEL = 'fixture footprint, nonrepresentative';
const EV14_CGROUP_ROOT = '/sys/fs/cgroup';
const SERVICE_SYSTEMD_KIND = 'systemd-service';
const MIB = 1024 * 1024;

// D-16 defaults: a contained 256 MiB phase unit. A start request may override
// them; the concrete adapter applies the request limits first.
const EV14_DEFAULT_LIMITS = Object.freeze({
  memoryBytes: 256 * MIB,
  memoryHighBytes: 256 * MIB,
  tasksMax: 128,
  cpuWeight: 100,
});

// D-11: resolve the installed Pi SDK exactly like sentinel.integration.test.mjs.
export function resolveInstalledPi() {
  try {
    const bin = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
    if (!bin) return { ok: false, reason: 'pi is not on PATH' };
    const realBin = execFileSync('realpath', [bin], { encoding: 'utf8' }).trim();
    let sdkRoot = process.env.SPEC_PI_SDK || null;
    if (!sdkRoot) {
      // A normal package layout keeps the SDK three directories above the bin.
      const normalCandidate = dirname(dirname(dirname(realBin)));
      if (existsSync(join(normalCandidate, 'dist', 'index.js')) && existsSync(join(normalCandidate, 'package.json'))) {
        sdkRoot = normalCandidate;
      } else {
        // The managed launcher names its own install root. Trust only a launcher
        // that carries the marker and a sanitized version below releases/.
        let launcher = '';
        try { launcher = readFileSync(realBin, 'utf8'); } catch { launcher = ''; }
        if (!launcher.includes('install/current-version')) {
          return { ok: false, reason: `installed Pi SDK not found under ${normalCandidate}` };
        }
        const agentRoot = dirname(dirname(realBin));
        let managedVersion = '';
        try { managedVersion = readFileSync(join(agentRoot, 'install', 'current-version'), 'utf8').trim(); } catch { managedVersion = ''; }
        if (!/^(?!\.\.?$)[^/\\]+$/.test(managedVersion)) {
          return { ok: false, reason: `managed Pi current-version is invalid: ${JSON.stringify(managedVersion)}` };
        }
        sdkRoot = join(agentRoot, 'install', 'releases', managedVersion, 'node_modules', '@earendil-works', 'pi-coding-agent');
      }
    }
    const entry = join(sdkRoot, 'dist', 'index.js');
    const pkg = join(sdkRoot, 'package.json');
    if (!existsSync(entry) || !existsSync(pkg)) {
      return { ok: false, reason: `installed Pi SDK not found under ${sdkRoot}` };
    }
    const aiEntry = createRequire(pkg).resolve.paths('@earendil-works/pi-ai')
      .map(root => join(root, '@earendil-works/pi-ai', 'dist', 'index.js')).find(existsSync);
    if (!aiEntry) return { ok: false, reason: 'installed @earendil-works/pi-ai not found' };
    return {
      ok: true, reason: null, sdkRoot, entry, aiEntry, bin,
      version: JSON.parse(readFileSync(pkg, 'utf8')).version,
    };
  } catch (error) {
    return { ok: false, reason: `pi resolution failed: ${error.message}` };
  }
}

// Commands keep the real user session (HOME, bus, XDG_*) and reach the Node
// that runs the suite first on PATH. Reserved SPEC_RUNTIME/PI_INTERCOM/PI_WARDEN
// variables are removed so a rehearsing owner's environment cannot leak.
export function linuxEnvironment(base = process.env) {
  const env = {};
  const nodeDir = dirname(process.execPath);
  for (const [name, value] of Object.entries(base)) {
    if (typeof value !== 'string') continue;
    if (name.startsWith('SPEC_RUNTIME_') || name.startsWith('PI_INTERCOM_') || name.startsWith('PI_WARDEN_')) continue;
    env[name] = value;
  }
  const currentPath = typeof base.PATH === 'string' && base.PATH !== '' ? base.PATH : '';
  env.PATH = currentPath === '' ? nodeDir : `${nodeDir}:${currentPath}`;
  env.PI_WARDEN_ENABLED = '1';
  return env;
}

// A bounded foreground host command: spawnSync with UTF-8 output and at most
// the EV-14 30 s ceiling. Returns the raw spawnSync result.
export function linuxCommand(command, args, options = {}) {
  const requested = Number.isFinite(options.timeoutMs) ? options.timeoutMs : EV14_COMMAND_TIMEOUT_MS;
  const timeout = Math.max(1, Math.min(requested, EV14_COMMAND_TIMEOUT_MS));
  const spawnOptions = { encoding: 'utf8', timeout, env: options.env ?? linuxEnvironment() };
  if (typeof options.cwd === 'string' && options.cwd !== '') spawnOptions.cwd = options.cwd;
  return spawnSync(command, args, spawnOptions);
}

// Require a successful status and carry the captured output into the failure.
export function assertCommand(result, label) {
  if (result.error || result.status !== 0) {
    const code = result.status === null ? 'null' : String(result.status);
    const parts = [`status=${code}`];
    if (result.signal) parts.push(`signal=${result.signal}`);
    if (result.error) parts.push(`error=${result.error.message}`);
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`${label} failed (${parts.join(' ')})${stdout ? `\nstdout: ${stdout}` : ''}${stderr ? `\nstderr: ${stderr}` : ''}`);
  }
  return result;
}

function parseJsonOutput(result, label) {
  const text = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (text !== '') {
    try {
      return JSON.parse(text);
    } catch {
      // Fall through to the last JSON-looking line.
    }
    const lines = text.split('\n').reverse();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
      try { return JSON.parse(trimmed); } catch { /* keep looking */ }
    }
  }
  throw new Error(`${label} did not print JSON; stdout was ${JSON.stringify(text)}`);
}

function versionAtLeast(version, major, minor) {
  const match = /^v?(\d+)\.(\d+)/.exec(String(version));
  if (!match) return false;
  const actualMajor = Number(match[1]);
  const actualMinor = Number(match[2]);
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}

function activeSpecRuntimeUnits() {
  const result = linuxCommand('systemctl', ['--user', 'list-units', '--state=active,failed', '--plain', '--no-legend']);
  assertCommand(result, 'systemctl --user list-units --state=active,failed');
  const units = [];
  for (const line of result.stdout.split('\n')) {
    const token = line.trim().split(/\s+/)[0] ?? '';
    if (/^spec-runtime-[^/\s]+\.service$/.test(token)) units.push(token);
  }
  return units;
}

// D-14 preconditions: every failure is a hard failure under the rehearsal
// opt-in. It reads the host and probes the runtime-host CLI; it never stops a
// unit or changes host policy.
export function linuxPreconditions(t) {
  if (process.platform !== 'linux') throw new Error('EV-14 requires Linux');
  if (typeof process.getuid === 'function' && process.getuid() === 0) throw new Error('EV-14 must run as a non-root user');
  if (!versionAtLeast(process.version, 22, 19)) throw new Error(`EV-14 requires Node 22.19 or newer; running ${process.version}`);
  const pi = resolveInstalledPi();
  if (!pi.ok) throw new Error(pi.reason || 'installed Pi is required');

  const bwrapWhich = linuxCommand('which', ['bwrap']);
  assertCommand(bwrapWhich, 'which bwrap');
  const bwrapPath = bwrapWhich.stdout.trim();
  if (bwrapPath === '') throw new Error('bubblewrap (bwrap) is not on PATH');

  const activeUnits = activeSpecRuntimeUnits();
  if (activeUnits.length > 0) {
    throw new Error(`EV-14 requires an idle host; active spec-runtime units: ${activeUnits.join(', ')}`);
  }

  const systemd = linuxCommand('systemctl', ['--version']);
  assertCommand(systemd, 'systemctl --version');
  const systemdVersion = (systemd.stdout.split('\n')[0] ?? '').trim();
  const bwrap = linuxCommand(bwrapPath, ['--version']);
  assertCommand(bwrap, 'bwrap --version');
  const bwrapVersion = `${bwrap.stdout}${bwrap.stderr}`.trim();
  const git = linuxCommand('git', ['--version']);
  assertCommand(git, 'git --version');
  const kernel = linuxCommand('uname', ['-r']);
  assertCommand(kernel, 'uname -r');

  const hostRun = linuxCommand(process.execPath, [cliPath, 'runtime-host', 'check', '--probe']);
  assertCommand(hostRun, 'runtime-host check --probe');
  const hostCheck = parseJsonOutput(hostRun, 'runtime-host check --probe');

  const facts = {
    kind: 'host-facts',
    hostname: hostname(),
    kernel: kernel.stdout.trim(),
    systemd: systemdVersion,
    bwrap: bwrapVersion,
    git: git.stdout.trim(),
    pi: pi.version,
    node: process.version,
    hostCheck,
  };
  if (t && typeof t.diagnostic === 'function') t.diagnostic(JSON.stringify(facts));
  return { pi, hostCheck, hostRun };
}

function readInteger(path) {
  const text = readFileSync(path, 'utf8').trim();
  if (text === 'max') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function parseKeyValues(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = /^(\S+)\s+(\d+)$/.exec(trimmed);
    if (match) values[match[1]] = Number(match[2]);
  }
  return values;
}

function readVmRss(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// D-16 service helper. It registers only actual adapter identities (from its
// own start result or from run record `service`/`command_service` objects),
// samples their real cgroups every 250 ms, and stops exactly those records.
export function makeLinuxServices(t, options = {}) {
  const { root, runDir = null, step = null } = options;
  if (typeof root !== 'string' || root === '') throw new Error('makeLinuxServices requires a root directory');

  const records = new Map();
  const samples = new Map();
  const outputs = new Map();
  let closed = false;
  let timer = null;
  let clean = true;
  let cleanupPromise = null;

  const adapter = createSystemdServiceAdapter({ limits: EV14_DEFAULT_LIMITS, env: linuxEnvironment() });

  const sampleStateFor = unit => {
    let state = samples.get(unit);
    if (!state) {
      state = {
        unit, samples: 0, step: null, phase: null,
        memory_peak_bytes: null, memory_current_max_bytes: 0,
        memory_stat: null, memory_events: null,
        rss_sum_max_bytes: 0, rss_coverage: '0/0', unavailable: null,
      };
      samples.set(unit, state);
    }
    return state;
  };

  const registerIdentity = (record, source = null) => {
    if (record === null || typeof record !== 'object') return false;
    if (record.kind !== SERVICE_SYSTEMD_KIND) return false;
    if (typeof record.unit !== 'string' || record.unit === '') return false;
    if (typeof record.invocation_id !== 'string' || record.invocation_id === '') return false;
    if (!records.has(record.unit)) {
      records.set(record.unit, record);
    }
    // A run record carries the phase identity the unit belongs to. Keep it on
    // the per-unit sample state even when the service was registered earlier.
    const state = sampleStateFor(record.unit);
    if (source !== null && typeof source === 'object') {
      if (source.step !== undefined && source.step !== null) state.step = source.step;
      if (typeof source.phase === 'string' && source.phase !== '') state.phase = source.phase;
    }
    return true;
  };

  const scanRunDir = () => {
    if (runDir === null || closed) return;
    let names;
    try { names = readdirSync(runDir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let record;
      try { record = JSON.parse(readFileSync(join(runDir, name), 'utf8')); } catch { continue; }
      if (record === null || typeof record !== 'object') continue;
      registerIdentity(record.service, record);
      registerIdentity(record.command_service, record);
    }
  };

  const sampleUnit = unit => {
    const record = records.get(unit);
    const state = sampleStateFor(unit);
    if (!record || record === undefined) {
      state.unavailable = 'record-missing';
      return;
    }
    const controlGroup = typeof record.control_group === 'string' && record.control_group !== '' ? record.control_group : null;
    if (controlGroup === null) {
      state.unavailable = 'cgroup-unknown';
      return;
    }
    const groupDir = join(EV14_CGROUP_ROOT, controlGroup);
    let memoryPeak;
    let memoryCurrent;
    let statText;
    let eventsText;
    let procsText;
    try {
      memoryPeak = readInteger(join(groupDir, 'memory.peak'));
      memoryCurrent = readInteger(join(groupDir, 'memory.current'));
      statText = readFileSync(join(groupDir, 'memory.stat'), 'utf8');
      eventsText = readFileSync(join(groupDir, 'memory.events'), 'utf8');
      procsText = readFileSync(join(groupDir, 'cgroup.procs'), 'utf8');
    } catch (error) {
      state.unavailable = error && error.code ? String(error.code) : 'unreadable';
      return;
    }
    const stat = parseKeyValues(statText);
    const events = parseKeyValues(eventsText);
    const pids = procsText.split('\n').map(line => line.trim()).filter(line => line !== '');
    let rssSum = 0;
    let rssRead = 0;
    for (const pid of pids) {
      const rss = readVmRss(pid);
      if (rss !== null) {
        rssSum += rss;
        rssRead += 1;
      }
    }
    state.samples += 1;
    if (memoryPeak !== null) state.memory_peak_bytes = Math.max(state.memory_peak_bytes ?? 0, memoryPeak);
    state.memory_current_max_bytes = Math.max(state.memory_current_max_bytes, memoryCurrent ?? 0);
    state.memory_stat = {
      anon: stat.anon ?? null,
      file: stat.file ?? null,
      kernel: stat.kernel ?? null,
      sock: stat.sock ?? null,
      shmem: stat.shmem ?? null,
    };
    state.memory_events = {
      high: events.high ?? null,
      max: events.max ?? null,
      oom: events.oom ?? null,
      oom_kill: events.oom_kill ?? null,
    };
    state.rss_sum_max_bytes = Math.max(state.rss_sum_max_bytes, rssSum);
    state.rss_coverage = `${rssRead}/${pids.length}`;
    state.unavailable = rssRead === pids.length ? null : 'rss-unreadable';
  };

  const sample = (phase = null) => {
    if (phase !== null) for (const state of samples.values()) state.phase = phase;
    scanRunDir();
    for (const unit of records.keys()) sampleUnit(unit);
    return diagnostics();
  };

  const diagnostics = () => [...samples.values()].map(state => ({
    ev: 'EV-14',
    kind: 'phase-memory',
    step: state.step ?? step ?? null,
    phase: state.phase,
    unit: state.unit,
    samples: state.samples,
    interval_ms: EV14_SAMPLE_INTERVAL_MS,
    memory_peak_bytes: state.memory_peak_bytes,
    memory_current_max_bytes: state.memory_current_max_bytes,
    memory_stat: state.memory_stat,
    memory_events: state.memory_events,
    rss_sum_max_bytes: state.rss_sum_max_bytes,
    rss_coverage: state.rss_coverage,
    unavailable: state.unavailable,
    label: EV14_DIAGNOSTIC_LABEL,
  }));

  const captureChild = result => {
    if (result === null || typeof result !== 'object') return result;
    const child = result.child;
    if (!child || typeof child.once !== 'function') return result;
    const output = { stdout: '', stderr: '' };
    const append = key => chunk => { output[key] += String(chunk); };
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', append('stdout'));
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', append('stderr'));
    // Resolve only; an already-exited or errored launcher settles the promise
    // instead of rejecting it, so no unhandled rejection escapes the case.
    const waitExit = new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; resolve(value); };
      child.once('error', error => finish({ exit_code: null, signal: null, error }));
      child.once('close', (code, signal) => finish({
        exit_code: Number.isInteger(code) ? code : null,
        signal: signal || null,
        error: null,
      }));
      child.once('exit', (code, signal) => finish({
        exit_code: Number.isInteger(code) ? code : null,
        signal: signal || null,
        error: null,
      }));
      if (child.exitCode !== null && child.exitCode !== undefined) {
        finish({ exit_code: Number.isInteger(child.exitCode) ? child.exitCode : null, signal: child.signalCode || null, error: null });
      } else if (child.signalCode !== null && child.signalCode !== undefined) {
        finish({ exit_code: null, signal: child.signalCode || null, error: null });
      }
    });
    if (typeof result.unit === 'string' && result.unit !== '') outputs.set(result.unit, { output, waitExit });
    return { ...result, output, waitExit };
  };

  const start = async (argv, startOptions = {}) => {
    if (closed) throw new Error('makeLinuxServices start after close');
    const {
      cwd = root,
      timeoutMs = 120000,
      limits,
      register = () => true,
      env,
    } = startOptions;
    const deadline = createWaveDeadline({ timeoutMs });
    const request = {
      argv,
      cwd,
      deadline,
      env: env ?? linuxEnvironment(),
      register: record => {
        // Register the actual identity before the caller's callback runs.
        registerIdentity(record);
        return register(record);
      },
    };
    if (limits !== undefined && limits !== null) request.limits = limits;
    const result = await adapter.start(request);
    return captureChild(result);
  };

  const waitConfirmed = async record => {
    const deadline = Date.now() + EV14_CONFIRM_TIMEOUT_MS;
    let last = null;
    for (;;) {
      try {
        last = await adapter.inspect(record);
      } catch {
        return null;
      }
      if (last && last.status === 'confirmed') return last;
      if (Date.now() >= deadline) return last;
      await delay(EV14_POLL_INTERVAL_MS);
    }
  };

  const emitDiagnostics = () => {
    if (!t || typeof t.diagnostic !== 'function') return;
    for (const record of diagnostics()) t.diagnostic(JSON.stringify(record));
  };

  const runCleanup = async () => {
    // Retain the last real observation before stopping the scan loop.
    scanRunDir();
    sample();
    closed = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    try {
      for (const [unit, record] of records) {
        try {
          const stopped = await adapter.stop(record);
          let final = stopped;
          // A populated cgroup after stop is not a drain: poll inspect until
          // the same record is positively confirmed or the bounded wait ends.
          if (stopped && stopped.status === 'populated') final = await waitConfirmed(record);
          if (!final || final.status !== 'confirmed') {
            clean = false;
            if (t && typeof t.diagnostic === 'function') {
              t.diagnostic(`EV-14 cleanup did not confirm ${unit}: ${final ? final.status : 'no-result'}`);
            }
          }
        } catch (error) {
          clean = false;
          if (t && typeof t.diagnostic === 'function') {
            t.diagnostic(`EV-14 cleanup stop failed for ${unit}: ${error && error.message ? error.message : String(error)}`);
          }
        }
      }
      const known = [...records.keys()];
      if (known.length > 0) {
        const listed = linuxCommand('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', '--no-pager']);
        if (listed.status !== 0) {
          clean = false;
          if (t && typeof t.diagnostic === 'function') {
            t.diagnostic(`EV-14 cleanup could not list units: ${(listed.stderr || '').trim()}`);
          }
        } else {
          const present = new Set(listed.stdout.split('\n').map(line => line.trim().split(/\s+/)[0]).filter(Boolean));
          for (const unit of known) {
            if (!present.has(unit)) continue;
            clean = false;
            if (t && typeof t.diagnostic === 'function') t.diagnostic(`EV-14 cleanup left ${unit} registered`);
          }
        }
      }
    } finally {
      emitDiagnostics();
    }
    if (!clean) {
      const message = `EV-14 cleanup did not confirm every unit; retain ${root} for inspection`;
      if (t && typeof t.diagnostic === 'function') t.diagnostic(message);
      else console.error(message);
      throw new Error(message);
    }
  };

  const close = () => {
    if (cleanupPromise === null) cleanupPromise = runCleanup();
    return cleanupPromise;
  };

  scanRunDir();
  timer = setInterval(() => {
    try {
      scanRunDir();
      for (const unit of records.keys()) sampleUnit(unit);
    } catch {
      // A sampling failure is recorded per unit by sampleUnit; the timer keeps
      // running so a later successful read can still be retained.
    }
  }, EV14_SAMPLE_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  if (t && typeof t.after === 'function') t.after(() => close());

  return {
    adapter,
    records,
    start,
    sample,
    diagnostics,
    close,
    get clean() { return clean; },
  };
}
