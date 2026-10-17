// EV-13 wave-native harness (D-29 packet 3): sandbox HOME and the portable
// external host shims. Everything here sits at the true OS boundary: the
// generated executables are the only substitutes and production code resolves
// them by name from PATH. No production module and no internal seam is patched.
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const SUPPORTED_SHIM_MODES = Object.freeze(['normal', 'managerUnreachable']);
const SHIM_MODE_FILE = 'mode.json';
const SHIM_UNITS_DIR = 'units';
const SHIM_GROUPS_DIR = 'groups';
const SHIM_RUNTIME_FILE = 'shim-runtime.cjs';

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function copyIfPresent(from, to) {
  if (!existsSync(from)) return;
  ensureDir(dirname(to));
  writeFileSync(to, readFileSync(from));
}

// D-4: an isolated HOME so index.ts and launch() resolve config, the registry
// and pi-subagents from the sandbox instead of the operator's live state. The
// installed pi-subagents package is symlinked to its real path (never copied)
// and the call fails if it is absent.
export function writeSandboxHome(root, { extensionPath, livePolicy = false } = {}) {
  if (typeof root !== 'string' || root === '') throw new Error('writeSandboxHome requires a root directory');
  const home = join(root, 'home');
  const agentDir = join(home, '.pi', 'agent');
  const configHome = join(home, '.config');
  const dataHome = join(home, '.local', 'share');
  ensureDir(agentDir);
  ensureDir(configHome);
  ensureDir(dataHome);

  writeFileSync(join(home, '.gitconfig'), [
    '[user]',
    '\tname = Wave Fixture',
    '\temail = wave@example.invalid',
    '',
  ].join('\n'));

  const specRuntime = {
    child_extensions: extensionPath ? [extensionPath] : [],
    scout_model: 'wave-loopback/scripted',
  };
  writeFileSync(join(agentDir, 'spec-runtime.json'), `${JSON.stringify(specRuntime, null, 2)}\n`);

  const installedPackage = join(homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents');
  let installed;
  try {
    installed = realpathSync(installedPackage);
  } catch (error) {
    throw new Error(`installed pi-subagents package is required at ${installedPackage}: ${error && error.code ? error.code : error}`);
  }
  const linkPath = join(agentDir, 'npm', 'node_modules', 'pi-subagents');
  ensureDir(dirname(linkPath));
  if (!existsSync(linkPath)) {
    try {
      symlinkSync(installed, linkPath, 'dir');
    } catch (error) {
      throw new Error(`failed to link installed pi-subagents: ${error && error.message ? error.message : error}`);
    }
  }

  if (livePolicy) {
    const operatorConfig = join(homedir(), '.config');
    copyIfPresent(join(operatorConfig, 'spec-runtime', 'host-policy.json'), join(configHome, 'spec-runtime', 'host-policy.json'));
    copyIfPresent(join(operatorConfig, 'systemd', 'user', 'spec-runtime.slice'), join(configHome, 'systemd', 'user', 'spec-runtime.slice'));
  }

  return { home, agentDir, configHome, dataHome };
}

function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function shimEntrypoint(node, tool) {
  return [
    `#!${node}`,
    "'use strict';",
    "const { runShim } = require('./shim-runtime.cjs');",
    `runShim(${JSON.stringify(tool)}, process.argv.slice(2)).then(value => { process.exitCode = value; }, error => {`,
    "  process.stderr.write('shim: ' + (error && error.message ? error.message : String(error)) + '\\n');",
    '  process.exitCode = 1;',
    '});',
    '',
  ].join('\n');
}

// D-2/D-3: generate the three external executables. Each one is a real node
// program that persists unit state under the supplied state directory and
// walks the real process/stdio boundary; unrecognized options fail closed.
export async function installPortableHostShims(binDir, stateDir, { configHome } = {}) {
  if (typeof binDir !== 'string' || binDir === '') throw new Error('installPortableHostShims requires binDir');
  if (typeof stateDir !== 'string' || stateDir === '') throw new Error('installPortableHostShims requires stateDir');
  if (typeof configHome !== 'string' || configHome === '') throw new Error('installPortableHostShims requires configHome');
  ensureDir(binDir);
  ensureDir(stateDir);
  ensureDir(join(stateDir, SHIM_UNITS_DIR));
  ensureDir(join(stateDir, SHIM_GROUPS_DIR));
  const modePath = join(stateDir, SHIM_MODE_FILE);
  if (!existsSync(modePath)) writeFileSync(modePath, `${JSON.stringify({ mode: 'normal' })}\n`);

  const node = process.execPath;
  writeFileSync(join(binDir, SHIM_RUNTIME_FILE), buildShimRuntime({ stateDir, configHome, node }));
  for (const name of ['systemd-run', 'systemctl', 'bwrap']) {
    writeExecutable(join(binDir, name), shimEntrypoint(node, name));
  }
  return { binDir, stateDir };
}

export async function setShimMode(stateDir, mode) {
  if (!SUPPORTED_SHIM_MODES.includes(mode)) throw new Error(`unsupported shim mode: ${mode}`);
  ensureDir(stateDir);
  writeFileSync(join(stateDir, SHIM_MODE_FILE), `${JSON.stringify({ mode })}\n`);
  return mode;
}

function readProcStat(pid) {
  let raw;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    return { status: error && error.code === 'ENOENT' ? 'gone' : 'unknown', detail: error && error.code };
  }
  const close = raw.lastIndexOf(')');
  if (close < 0) return { status: 'unknown', detail: 'malformed-stat' };
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  const state = fields[0];
  const pgrp = Number(fields[2]);
  const starttime = fields[19];
  if (typeof state !== 'string' || state === '' || !Number.isInteger(pgrp)) return { status: 'unknown', detail: 'malformed-stat' };
  if (typeof starttime !== 'string' || starttime === '') return { status: 'unknown', detail: 'missing-starttime' };
  return { status: 'live', state, pgrp, starttime };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// A group member is a live writer unless the kernel already records it as a
// zombie or dead. Those terminal states can no longer run, so they do not mask
// a drained group.
function isLiveWriterState(state) {
  return state !== 'Z' && state !== 'X' && state !== 'x';
}

// Enumerate every process whose pgrp is the registered group. An unreadable
// /proc stat is never treated as absence: it fails closed so the group is
// retained rather than reported drained.
function scanRegisteredGroup(pgid) {
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch (error) {
    return { ok: false, detail: `unreadable /proc: ${error && error.code}` };
  }
  const live = [];
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const memberPid = Number(entry);
    const stat = readProcStat(memberPid);
    if (stat.status === 'gone') continue;
    if (stat.status === 'unknown') return { ok: false, detail: `unreadable /proc/${memberPid}/stat (${stat.detail})` };
    if (stat.pgrp !== pgid) continue;
    if (isLiveWriterState(stat.state)) live.push({ pid: memberPid, state: stat.state });
  }
  return { ok: true, live };
}

async function drainRegisteredGroup(record) {
  const pid = record && Number.isInteger(record.pid) ? record.pid : null;
  const pgid = record && Number.isInteger(record.pgid) ? record.pgid : pid;
  if (pid === null || pgid === null) return { ok: false, detail: 'missing pid/pgid' };
  const observed = readProcStat(pid);
  if (observed.status === 'unknown') return { ok: false, detail: `unreadable /proc/${pid}/stat (${observed.detail})` };
  // Signal only the exact identity the harness registered. A missing leader or
  // a mismatched start time means the registered leader is no longer the
  // process we spawned, so the pgid may have been recycled; never signal it.
  const leaderOwned = observed.status === 'live' && String(record.starttime) === String(observed.starttime);
  if (leaderOwned) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch (error) {
      if (!error || error.code !== 'ESRCH') return { ok: false, detail: `kill -${pgid}: ${error && error.code}` };
    }
  }
  const deadline = Date.now() + 5000;
  for (;;) {
    const scan = scanRegisteredGroup(pgid);
    if (!scan.ok) return { ok: false, detail: scan.detail };
    if (scan.live.length === 0) return { ok: true };
    if (Date.now() > deadline) {
      const writers = scan.live.map(member => `${member.pid}(${member.state})`).join(',');
      return { ok: false, detail: leaderOwned
        ? `process group -${pgid} still has live writers after SIGKILL: ${writers}`
        : `registered leader ${pid} is gone/reused but process group -${pgid} still has live writers: ${writers}` };
    }
    await delay(25);
  }
}

// Drain only the detached groups this harness registered, proving each death
// (or PID reuse) via /proc start time. Unknown or unproven drainage throws and
// leaves the registration in place so the backing is retained.
export async function cleanupPortableHostShims(stateDir) {
  const groupsDir = join(stateDir, SHIM_GROUPS_DIR);
  if (!existsSync(groupsDir)) return { ok: true, drained: 0 };
  let drained = 0;
  const failures = [];
  for (const entry of readdirSync(groupsDir)) {
    if (!entry.endsWith('.json')) continue;
    const path = join(groupsDir, entry);
    let record;
    try {
      record = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      failures.push(`${entry}: unreadable registration`);
      continue;
    }
    const outcome = await drainRegisteredGroup(record);
    if (outcome.ok) {
      rmSync(path, { force: true });
      drained += 1;
    } else {
      failures.push(`${entry}: ${outcome.detail}`);
    }
  }
  if (failures.length > 0) throw new Error(`portable host shim cleanup retained ${failures.length} group(s): ${failures.join('; ')}`);
  return { ok: true, drained };
}

function buildShimRuntime({ stateDir, configHome, node }) {
  return `'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const STATE_DIR = ${JSON.stringify(stateDir)};
const CONFIG_HOME = ${JSON.stringify(configHome)};
const NODE = ${JSON.stringify(node)};
const UNITS_DIR = path.join(STATE_DIR, 'units');
const GROUPS_DIR = path.join(STATE_DIR, 'groups');
const MODE_FILE = path.join(STATE_DIR, 'mode.json');
const SLICE_FILE = path.join(CONFIG_HOME, 'systemd', 'user', 'spec-runtime.slice');
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const SERVICE_SLICE = 'spec-runtime.slice';
const UNIT_PREFIX = 'spec-runtime-';
const SIGNALS = os.constants.signals;

function fail(message) { process.stderr.write('shim: ' + message + '\\n'); return 1; }
function unsupported(arg) { return fail('unsupported ' + arg); }
function signalCode(signal) { const value = SIGNALS && SIGNALS[signal]; return typeof value === 'number' ? value : 1; }
function readMode() { try { const parsed = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')); return parsed && parsed.mode ? parsed.mode : 'normal'; } catch { return 'normal'; } }
function readStartTime(pid) {
  try {
    const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    const fields = raw.slice(close + 2).trim().split(/\\s+/);
    return typeof fields[19] === 'string' ? fields[19] : null;
  } catch { return null; }
}
function readProcStat(pid) {
  try {
    const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return { status: 'unknown', detail: 'malformed-stat' };
    const fields = raw.slice(close + 2).trim().split(/\\s+/);
    const state = fields[0];
    const pgrp = Number(fields[2]);
    const starttime = fields[19];
    if (typeof state !== 'string' || state === '' || !Number.isInteger(pgrp)) return { status: 'unknown', detail: 'malformed-stat' };
    if (typeof starttime !== 'string' || starttime === '') return { status: 'unknown', detail: 'missing-starttime' };
    return { status: 'live', state, pgrp, starttime };
  } catch (error) {
    return { status: error && error.code === 'ENOENT' ? 'gone' : 'unknown', detail: error && error.code };
  }
}
function isLiveWriterState(state) { return state !== 'Z' && state !== 'X' && state !== 'x'; }
function scanRegisteredGroup(pgid) {
  let entries;
  try { entries = fs.readdirSync('/proc'); }
  catch (error) { return { ok: false, detail: 'unreadable /proc: ' + (error && error.code) }; }
  const live = [];
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const memberPid = Number(entry);
    const stat = readProcStat(memberPid);
    if (stat.status === 'gone') continue;
    if (stat.status === 'unknown') return { ok: false, detail: 'unreadable /proc/' + memberPid + '/stat (' + stat.detail + ')' };
    if (stat.pgrp !== pgid) continue;
    if (isLiveWriterState(stat.state)) live.push({ pid: memberPid, state: stat.state });
  }
  return { ok: true, live };
}
function delayMs(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
// Drain the registered process group, proving no live writer survives. A
// missing or start-time-mismatched leader is never signaled: the pgid might
// have been recycled. An unreadable member or a surviving live writer fails
// closed so the caller retains the registration instead of reporting success.
async function drainGroup(pgid, recordedStarttime) {
  const observed = readProcStat(pgid);
  if (observed.status === 'unknown') return { ok: false, detail: 'unreadable /proc/' + pgid + '/stat (' + observed.detail + ')' };
  const leaderOwned = observed.status === 'live' && recordedStarttime !== null && recordedStarttime !== undefined && String(recordedStarttime) === String(observed.starttime);
  if (leaderOwned) {
    try { process.kill(-pgid, 'SIGKILL'); }
    catch (error) { if (!error || error.code !== 'ESRCH') return { ok: false, detail: 'kill -' + pgid + ': ' + (error && error.code) }; }
  }
  const deadline = Date.now() + 5000;
  for (;;) {
    const scan = scanRegisteredGroup(pgid);
    if (!scan.ok) return { ok: false, detail: scan.detail };
    if (scan.live.length === 0) return { ok: true };
    if (Date.now() > deadline) {
      const writers = scan.live.map(member => member.pid + '(' + member.state + ')').join(',');
      return { ok: false, detail: leaderOwned
        ? 'process group -' + pgid + ' still has live writers after SIGKILL: ' + writers
        : 'registered leader ' + pgid + ' is gone/reused but process group -' + pgid + ' still has live writers: ' + writers };
    }
    await delayMs(25);
  }
}
function unitFile(unit) { return path.join(UNITS_DIR, unit + '.json'); }
function readUnit(unit) { try { return JSON.parse(fs.readFileSync(unitFile(unit), 'utf8')); } catch { return null; } }
function writeUnit(unit, record) { fs.mkdirSync(UNITS_DIR, { recursive: true }); fs.writeFileSync(unitFile(unit), JSON.stringify(record) + '\\n'); }
function removeUnit(unit) { try { fs.rmSync(unitFile(unit), { force: true }); } catch (ignored) {} }
function groupFile(id) { return path.join(GROUPS_DIR, id + '.json'); }
function registerGroup(id, unit, pid) {
  fs.mkdirSync(GROUPS_DIR, { recursive: true });
  const record = { unit, invocation_id: id, pid, pgid: pid, starttime: readStartTime(pid) };
  fs.writeFileSync(groupFile(id), JSON.stringify(record) + '\\n');
  return record;
}
function readGroup(id) { try { return JSON.parse(fs.readFileSync(groupFile(id), 'utf8')); } catch { return null; } }
function removeGroup(id) { try { fs.rmSync(groupFile(id), { force: true }); } catch (ignored) {} }
function cgroupValue(file) {
  try { const value = fs.readFileSync(file, 'utf8').trim(); if (value === 'max') return 'infinity'; return value === '' ? null : value; } catch { return null; }
}
function pick(values, properties) {
  if (!properties || properties.length === 0) return Object.assign({}, values);
  const out = {};
  for (const name of properties) out[name] = values[name];
  return out;
}
function sliceValues() {
  const values = {};
  let text = '';
  try { text = fs.readFileSync(SLICE_FILE, 'utf8'); } catch { text = ''; }
  for (const raw of text.split('\\n')) {
    const line = raw.trim();
    if (line === '' || line.charAt(0) === '#' || line.charAt(0) === '[') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'CPUQuota' && value.endsWith('%')) { values.CPUQuotaPerSecUSec = String(Number(value.slice(0, -1)) * 10000); continue; }
    values[key] = value;
  }
  return values;
}
function rootSliceValues() {
  return {
    MemoryMax: cgroupValue('/sys/fs/cgroup/memory.max'),
    MemoryHigh: cgroupValue('/sys/fs/cgroup/memory.high'),
    MemorySwapMax: cgroupValue('/sys/fs/cgroup/memory.swap.max'),
    TasksMax: cgroupValue('/sys/fs/cgroup/pids.max'),
    CPUQuotaPerSecUSec: 'infinity',
    RuntimeMaxUSec: 'infinity',
    CPUWeight: cgroupValue('/sys/fs/cgroup/cpu.weight') || '100',
  };
}
function unitValues(record) {
  return {
    LoadState: record.load_state,
    ActiveState: record.active_state,
    SubState: record.sub_state,
    InvocationID: record.invocation_id,
    ControlGroup: record.control_group,
    MainPID: String(record.main_pid === undefined || record.main_pid === null ? 0 : record.main_pid),
    Result: record.result === undefined ? '' : record.result,
    ExecMainStatus: record.exec_main_status === undefined ? '' : record.exec_main_status,
  };
}
function showValues(target, properties) {
  if (target === '') return { Version: '255' };
  if (target === '-.slice') return pick(rootSliceValues(), properties);
  if (target === SERVICE_SLICE) return pick(sliceValues(), properties);
  if (target.startsWith(UNIT_PREFIX) && target.endsWith('.service')) {
    const record = readUnit(target);
    if (record === null) return { LoadState: 'not-found' };
    return pick(unitValues(record), properties);
  }
  return null;
}
function printValues(values, names, valueOnly) {
  for (const name of names) {
    const value = values[name];
    const text = value === undefined || value === null ? '' : String(value);
    process.stdout.write(valueOnly ? text + '\\n' : name + '=' + text + '\\n');
  }
}

async function systemdRun(args) {
  if (args.length === 1 && args[0] === '--version') { process.stdout.write('systemd 255 (shim)\\n'); return 0; }
  if (args.length === 1 && args[0] === '--help') { process.stdout.write('systemd-run [OPTIONS] COMMAND\\n  --expand-environment=BOOL  control environment variable expansion\\n'); return 0; }
  const run = { unit: null, cwd: null, setenv: new Map(), properties: new Map(), argv: [], collect: false, wait: false };
  let index = 0;
  let sawSeparator = false;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--') { sawSeparator = true; run.argv = args.slice(index + 1); break; }
    index += 1;
    if (arg === '--user' || arg === '--pipe') continue;
    if (arg === '--collect') { run.collect = true; continue; }
    if (arg === '--wait') { run.wait = true; continue; }
    if (arg === '--service-type=exec') continue;
    if (arg === '--expand-environment=no') continue;
    if (arg.startsWith('--unit=')) { run.unit = arg.slice('--unit='.length); continue; }
    if (arg.startsWith('--slice=')) continue;
    if (arg.startsWith('--working-directory=')) { run.cwd = arg.slice('--working-directory='.length); continue; }
    if (arg.startsWith('--property=')) {
      const pair = arg.slice('--property='.length);
      const eq = pair.indexOf('=');
      if (eq <= 0) return unsupported(arg);
      run.properties.set(pair.slice(0, eq), pair.slice(eq + 1));
      continue;
    }
    if (arg.startsWith('--setenv=')) {
      const pair = arg.slice('--setenv='.length);
      const eq = pair.indexOf('=');
      if (eq <= 0) return unsupported(arg);
      run.setenv.set(pair.slice(0, eq), pair.slice(eq + 1));
      continue;
    }
    return unsupported(arg);
  }
  if (!sawSeparator || run.argv.length === 0 || run.argv[0] === '') return unsupported('--');

  const unit = run.unit && run.unit !== '' ? run.unit : UNIT_PREFIX + crypto.randomBytes(6).toString('hex') + '.service';
  const invocation = crypto.randomBytes(16).toString('hex');
  const controlGroup = '/user.slice/user-' + UID + '.slice/user@' + UID + '.service/spec-runtime.slice/' + unit;
  const environment = new Map(run.setenv);
  const environmentFile = run.properties.get('EnvironmentFile');
  if (typeof environmentFile === 'string' && environmentFile !== '') {
    try {
      for (const raw of fs.readFileSync(environmentFile, 'utf8').split('\\n')) {
        const line = raw.trim();
        if (line === '' || line.charAt(0) === '#') continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        environment.set(line.slice(0, eq), line.slice(eq + 1));
      }
    } catch { return fail('unreadable EnvironmentFile ' + environmentFile); }
  }
  environment.set('INVOCATION_ID', invocation);
  const propertyRuntime = Number(run.properties.get('RuntimeMaxSec'));
  const runtimeMaxSec = Number.isFinite(propertyRuntime) && propertyRuntime > 0 ? propertyRuntime : null;

  let child;
  try {
    child = spawn(run.argv[0], run.argv.slice(1), {
      detached: true,
      stdio: 'inherit',
      cwd: run.cwd || process.cwd(),
      env: Object.fromEntries(environment),
    });
  } catch (error) {
    return fail('spawn failed: ' + (error && error.code ? error.code : String(error)));
  }
  const pid = child.pid;
  writeUnit(unit, { unit, invocation_id: invocation, load_state: 'loaded', active_state: 'active', sub_state: 'running', main_pid: pid, control_group: controlGroup, result: '', exec_main_status: '' });
  const group = registerGroup(invocation, unit, pid);
  process.stderr.write('Running as unit: ' + unit + '; invocation ID: ' + invocation + '\\n');
  if (!run.wait) { child.unref(); return 0; }

  let result = '';
  let timer = null;
  if (runtimeMaxSec !== null) {
    timer = setTimeout(() => {
      result = 'timeout';
      try { process.kill(-pid, 'SIGKILL'); } catch (ignored) {}
    }, runtimeMaxSec * 1000);
  }
  const outcome = await new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  if (timer !== null) clearTimeout(timer);
  let serviceCode = outcome.code === null ? 0 : outcome.code;
  if (result === '') {
    if (outcome.signal) { result = 'signal'; serviceCode = 128 + signalCode(outcome.signal); }
    else if (outcome.code === 0) result = 'success';
    else if (typeof outcome.code === 'number') result = 'exit-code';
    else { result = 'exit-code'; serviceCode = 1; }
  }
  const drain = await drainGroup(pid, group.starttime);
  if (drain.ok) {
    if (run.collect) removeUnit(unit);
    else writeUnit(unit, { unit, invocation_id: invocation, load_state: 'loaded', active_state: 'inactive', sub_state: 'dead', main_pid: 0, control_group: controlGroup, result, exec_main_status: outcome.code === null ? '' : String(outcome.code) });
    removeGroup(invocation);
  } else {
    // An unproven group keeps the unit active and the registration in place;
    // a synthetic inactive report would mask surviving writers.
    writeUnit(unit, { unit, invocation_id: invocation, load_state: 'loaded', active_state: 'active', sub_state: 'running', main_pid: pid, control_group: controlGroup, result, exec_main_status: outcome.code === null ? '' : String(outcome.code) });
    process.stderr.write('shim: retained group ' + invocation + ' (undrained: ' + drain.detail + ')\\n');
  }
  process.stderr.write('Finished with result: ' + result + '\\n');
  return serviceCode;
}

function showCommand(rest, mode) {
  if (mode === 'managerUnreachable') return fail('manager unreachable');
  const properties = [];
  let valueOnly = false;
  const targets = [];
  for (const arg of rest) {
    if (arg === '--value') { valueOnly = true; continue; }
    if (arg === '--no-pager' || arg === '--no-legend' || arg === '--plain') continue;
    if (arg.startsWith('--property=')) { properties.push(arg.slice('--property='.length)); continue; }
    if (arg === '-.slice') { targets.push(arg); continue; }
    if (arg.startsWith('-')) return unsupported(arg);
    targets.push(arg);
  }
  if (targets.length > 1) return unsupported('show');
  const target = targets.length > 0 ? targets[0] : '';
  const values = showValues(target, properties);
  if (values === null) {
    process.stdout.write(valueOnly ? 'not-found\\n' : 'LoadState=not-found\\n');
    return 0;
  }
  const names = properties.length > 0 ? properties : Object.keys(values);
  printValues(values, names, valueOnly);
  return 0;
}

function listUnits(rest, mode) {
  if (mode === 'managerUnreachable') return fail('manager unreachable');
  for (const arg of rest) {
    if (arg === '--all' || arg === '--no-legend' || arg === '--plain' || arg === '--no-pager') continue;
    if (arg.startsWith('-')) return unsupported(arg);
  }
  const lines = [];
  try {
    for (const entry of fs.readdirSync(UNITS_DIR)) {
      if (!entry.endsWith('.service.json')) continue;
      const record = readUnit(entry.slice(0, -'.json'.length));
      if (record === null) continue;
      lines.push([record.unit, record.load_state, record.active_state, record.sub_state].join(' '));
    }
  } catch (ignored) {}
  if (lines.length > 0) process.stdout.write(lines.join('\\n') + '\\n');
  return 0;
}

function listJobs(rest, mode) {
  if (mode === 'managerUnreachable') return fail('manager unreachable');
  for (const arg of rest) {
    if (arg === '--no-legend' || arg === '--no-pager' || arg === '--plain') continue;
    if (arg.startsWith('-')) return unsupported(arg);
  }
  return 0;
}

async function stopUnit(unit) {
  const record = readUnit(unit);
  if (record === null) return { ok: true };
  const pgid = record.main_pid;
  if (typeof pgid === 'number' && pgid > 0) {
    const group = readGroup(record.invocation_id);
    const recordedStarttime = group && group.starttime !== undefined && group.starttime !== null ? String(group.starttime) : null;
    const observed = readProcStat(pgid);
    if (observed.status === 'unknown') {
      record.active_state = 'active';
      record.sub_state = 'running';
      writeUnit(unit, record);
      return { ok: false, detail: 'unreadable /proc/' + pgid + '/stat (' + observed.detail + ')' };
    }
    // Signal only the recorded identity; a mismatched or gone leader is never
    // signaled because the pgid may have been recycled.
    const leaderOwned = observed.status === 'live' && recordedStarttime !== null && String(recordedStarttime) === String(observed.starttime);
    if (leaderOwned) {
      try { process.kill(-pgid, 'SIGTERM'); } catch (ignored) {}
    }
    const drain = await drainGroup(pgid, recordedStarttime);
    if (!drain.ok) {
      // Do not mask surviving writers with a synthetic inactive report.
      record.active_state = 'active';
      record.sub_state = 'running';
      writeUnit(unit, record);
      return drain;
    }
  }
  record.active_state = 'inactive';
  record.sub_state = 'dead';
  record.main_pid = 0;
  writeUnit(unit, record);
  return { ok: true };
}

async function stopCommand(rest, mode) {
  if (mode === 'managerUnreachable') return fail('manager unreachable');
  const targets = [];
  for (const arg of rest) {
    if (arg === '--no-block' || arg === '--no-pager') continue;
    if (arg.startsWith('-')) return unsupported(arg);
    targets.push(arg);
  }
  if (targets.length === 0) return unsupported('stop');
  for (const unit of targets) {
    const outcome = await stopUnit(unit);
    if (outcome && outcome.ok !== true) return fail('stop ' + unit + ': ' + outcome.detail);
  }
  return 0;
}

async function systemctl(args) {
  if (args.length === 1 && args[0] === '--version') { process.stdout.write('systemctl 255 (shim)\\n'); return 0; }
  if (args.length === 1 && args[0] === '--help') { process.stdout.write('systemctl [OPTIONS] COMMAND\\n'); return 0; }
  if (args.length === 0) return unsupported('systemctl');
  if (args[0] !== '--user') return unsupported(args[0]);
  const rest = args.slice(1);
  if (rest.length === 0) return unsupported('--user');
  const mode = readMode();
  const command = rest[0];
  if (command === 'show') return showCommand(rest.slice(1), mode);
  if (command === 'list-units') return listUnits(rest.slice(1), mode);
  if (command === 'list-jobs') return listJobs(rest.slice(1), mode);
  if (command === 'daemon-reload') return mode === 'managerUnreachable' ? fail('manager unreachable') : 0;
  if (command === 'stop') return stopCommand(rest.slice(1), mode);
  return unsupported(command);
}

function bwrap(args) {
  if (args.length === 1 && args[0] === '--version') { process.stdout.write('bubblewrap 0.12.0\\n'); return 0; }
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: bwrap [OPTIONS] [COMMAND]\\n  --overlay-src DIR  use an overlay source directory\\n  --overlay DIR      mount an overlay\\n');
    return 0;
  }
  process.stderr.write('bwrap: Creating new namespace failed: Operation not permitted (user namespace denied)\\n');
  return 1;
}

async function runShim(tool, args) {
  if (tool === 'systemd-run') return systemdRun(args);
  if (tool === 'systemctl') return systemctl(args);
  if (tool === 'bwrap') return bwrap(args);
  return fail('unknown shim ' + tool);
}

module.exports = { runShim };
`;
}
