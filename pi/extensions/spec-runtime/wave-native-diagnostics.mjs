// Bounded last-chance diagnostics over the live fixture, run before boot cleanup.
// They inspect only <package>/runtime/runs and the known shim-state directory;
// they never walk the home directory or environment. Text is bounded so a stuck
// child cannot flood the reporter.
//
// Extracted verbatim from waves.integration.test.mjs (case 1) so later native
// cases can register the same bounded evidence without duplicating it. The test
// reaches these helpers through the allowed package-fixture.mjs entry point.
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

const DIAG_TEXT_LIMIT = 8000;
const DIAG_JSON_LIMIT = 12000;
const DIAG_GROUP_LIMIT = 20;
// Bounded stdin-ownership scan: ancestor depth, fd entries per process, and the
// number of matching holders reported.
const DIAG_ANCESTOR_LIMIT = 6;
const DIAG_FD_LIMIT = 256;
const DIAG_STDIN_HOLDER_LIMIT = 20;
// Only these request env vars are surfaced; the provider token is never read.
const DIAG_ENV_KEYS = [
  'PATH',
  'HOME',
  'PI_CODING_AGENT_DIR',
  'SPEC_RUNTIME_ROLE',
  'SPEC_RUNTIME_RECORD',
  'INVOCATION_ID',
  'SPEC_RUNTIME_GATE_DIR',
  'SPEC_RUNTIME_UNIT',
  'SPEC_RUNTIME_GATE_DEADLINE_MS',
];

function boundedText(text, limit) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length > limit ? `${value.slice(value.length - limit)}\n<truncated ${value.length - limit} earlier chars>` : value;
}

// Narrow, non-fatal /proc read: an unreadable file becomes an explicit error
// field rather than disappearing.
function readProcFile(pid, name) {
  try {
    return readFileSync(join('/proc', String(pid), name), 'utf8');
  } catch (error) {
    return `<unreadable: ${error?.message ?? String(error)}>`;
  }
}

function parseProcStatus(text) {
  if (typeof text !== 'string' || text.startsWith('<unreadable:')) return null;
  const fields = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return { name: fields.Name ?? null, state: fields.State ?? null, ppid: fields.PPid ?? null, pgrp: fields.Pgrp ?? null };
}

// Selected env vars only, so the provider token in the child environ is never
// surfaced. Values are bounded and NUL-delimited entries are parsed directly.
function collectChildEnv(pid) {
  const raw = readProcFile(pid, 'environ');
  if (raw.startsWith('<unreadable:')) return { error: raw };
  const selected = {};
  for (const chunk of raw.split('\0')) {
    if (!chunk) continue;
    const eq = chunk.indexOf('=');
    if (eq <= 0) continue;
    const key = chunk.slice(0, eq);
    if (!DIAG_ENV_KEYS.includes(key)) continue;
    const value = chunk.slice(eq + 1);
    selected[key] = boundedText(value, 1000);
  }
  return { selected };
}

// Return the group members whose /proc/<pid>/stat pgrp equals the run's
// main_pid, bounded so a stuck group cannot flood the reporter.
function collectProcessGroup(mainPid) {
  const members = [];
  let numeric = [];
  try {
    numeric = readdirSync('/proc').filter(name => /^\d+$/.test(name));
  } catch (error) {
    return { error: `<unreadable: ${error?.message ?? String(error)}>`, members };
  }
  for (const name of numeric) {
    if (members.length >= DIAG_GROUP_LIMIT) break;
    const pid = Number(name);
    const stat = readProcFile(pid, 'stat');
    if (stat.startsWith('<unreadable:')) continue;
    // comm may contain spaces/parens; parse after the final ')'.
    const close = stat.lastIndexOf(')');
    if (close < 0) continue;
    const rest = stat.slice(close + 2).split(' ');
    const state = rest[0] ?? null;
    const ppid = rest[1] ?? null;
    const pgrp = rest[2] ?? null;
    if (String(pgrp) !== String(mainPid)) continue;
    const cmdline = readProcFile(pid, 'cmdline');
    // stdin target of each member: a pipe readlink is the identity later used
    // to find who still holds the other end open.
    let stdinFd = null;
    try {
      stdinFd = readlinkSync(join('/proc', String(pid), 'fd', '0'));
    } catch (error) {
      stdinFd = `<unreadable: ${error?.message ?? String(error)}>`;
    }
    members.push({
      pid,
      ppid,
      state,
      cmdline: cmdline.startsWith('<unreadable:') ? null : boundedText(cmdline.replace(/\0/g, ' ').trim(), 2000),
      stdin_fd: stdinFd === null ? null : boundedText(stdinFd, 200),
      env: collectChildEnv(pid),
      wchan: (() => {
        const wchan = readProcFile(pid, 'wchan');
        return wchan.startsWith('<unreadable:') ? null : boundedText(wchan.trim(), 200);
      })(),
    });
  }
  return { members };
}

// Report which readable processes hold an open descriptor that aliases one of
// the given pipe targets. Only descriptors whose readlink equals a target are
// reported, so no unrelated fd contents or environments are copied out.
function collectFdHolders(pid, pipeTargets) {
  const holders = [];
  let entries = [];
  try {
    entries = readdirSync(join('/proc', String(pid), 'fd'));
  } catch (error) {
    return { error: `<unreadable: ${error?.message ?? String(error)}>`, holders };
  }
  entries.sort();
  let truncated = false;
  for (const entry of entries) {
    if (holders.length >= DIAG_STDIN_HOLDER_LIMIT) { truncated = true; break; }
    if (entry === '0' || entry === '1' || entry === '2') continue;
    if (Number(entry) > DIAG_FD_LIMIT) { truncated = true; continue; }
    let target = null;
    try {
      target = readlinkSync(join('/proc', String(pid), 'fd', entry));
    } catch {
      continue;
    }
    if (!pipeTargets.includes(target)) continue;
    const fdinfo = readProcFile(pid, join('fdinfo', entry));
    holders.push({
      pid,
      fd: entry,
      target: boundedText(target, 200),
      fdinfo: fdinfo.startsWith('<unreadable:') ? { error: fdinfo } : boundedText(fdinfo.replace(/\0/g, ' ').trim(), 500),
    });
  }
  return truncated ? { holders, truncated } : { holders };
}

// Stdin ownership diagnostic for the repeatedly failing width-five launch: the
// installed SDK gateway waits for EOF on a piped stdin, so an open write end
// held anywhere upstream explains the stall without changing behaviour.
function collectStdinOwnershipDiagnostic(service, group) {
  const launcherPid = service?.launcher && Number.isSafeInteger(service.launcher.pid) ? service.launcher.pid : null;
  if (launcherPid == null) return { launcher_pid: null };
  const pipeTargets = [];
  for (const member of Array.isArray(group?.members) ? group.members : []) {
    if (typeof member?.stdin_fd === 'string' && (member.stdin_fd.startsWith('pipe:') || member.stdin_fd.startsWith('socket:')) && !pipeTargets.includes(member.stdin_fd)) {
      pipeTargets.push(member.stdin_fd);
    }
  }
  if (pipeTargets.length === 0) return { launcher_pid: launcherPid, stdin_pipe_targets: [], note: 'no pipe/socket stdin in recorded group' };
  const chain = [];
  let pid = launcherPid;
  for (let depth = 0; depth < DIAG_ANCESTOR_LIMIT; depth += 1) {
    const status = parseProcStatus(readProcFile(pid, 'status'));
    if (!status) { chain.push({ pid, status: { error: 'unreadable' } }); break; }
    const cmdline = readProcFile(pid, 'cmdline');
    const scan = collectFdHolders(pid, pipeTargets);
    chain.push({
      pid,
      ppid: status.ppid,
      cmdline: cmdline.startsWith('<unreadable:') ? { error: cmdline } : boundedText(cmdline.replace(/\0/g, ' ').trim(), 500),
      stdin_fd: (() => {
        try { return boundedText(readlinkSync(join('/proc', String(pid), 'fd', '0')), 200); } catch (error) {
          return { error: error?.message ?? String(error) };
        }
      })(),
      ...scan,
    });
    const parent = Number(status.ppid);
    if (!Number.isSafeInteger(parent) || parent <= 1 || parent === pid) break;
    pid = parent;
  }
  return { launcher_pid: launcherPid, stdin_pipe_targets: pipeTargets, ancestors: chain };
}

// Surface the service's actual runtime state from /proc keyed by main_pid,
// plus the bounded member set of its process group.
function collectServiceProcessDiagnostics(service) {
  if (!service || typeof service !== 'object') return null;
  const mainPid = service.main_pid ?? service.mainPid ?? null;
  if (mainPid == null) return { main_pid: null };
  const status = parseProcStatus(readProcFile(mainPid, 'status'));
  const cmdline = readProcFile(mainPid, 'cmdline');
  const wchan = readProcFile(mainPid, 'wchan');
  const group = collectProcessGroup(mainPid);
  return {
    main_pid: mainPid,
    cmdline: cmdline.startsWith('<unreadable:') ? { error: cmdline } : boundedText(cmdline.replace(/\0/g, ' ').trim(), 2000),
    status,
    wchan: wchan.startsWith('<unreadable:') ? { error: wchan } : boundedText(wchan.trim(), 200),
    env: collectChildEnv(mainPid),
    group,
    stdin_ownership: collectStdinOwnershipDiagnostic(service, group),
  };
}

// The extension paths a child was launched with, if the record carries them.
function collectChildExtensionsDiagnostic(value) {
  if (!Array.isArray(value)) return null;
  return value.map(entry => (typeof entry === 'string' ? boundedText(entry, DIAG_TEXT_LIMIT) : boundedText(JSON.stringify(entry), DIAG_TEXT_LIMIT)));
}

// A recorded service request: argv/args/command only. The request object may
// also carry env, a token or other secrets, so it is parsed field-by-field and
// never stringified whole.
function collectServiceRequestDiagnostic(request) {
  if (!request || typeof request !== 'object') return null;
  const args = Array.isArray(request.args) ? request.args : null;
  const argv = Array.isArray(request.argv) ? request.argv : null;
  const command = typeof request.command === 'string' ? boundedText(request.command, DIAG_TEXT_LIMIT) : null;
  // Extension paths are inferred from the argv/args the child actually got.
  const extensions = [];
  for (const entry of [...(argv ?? []), ...(args ?? [])]) {
    if (typeof entry !== 'string') continue;
    if (!entry.includes('extension')) continue;
    extensions.push(boundedText(entry, DIAG_TEXT_LIMIT));
  }
  return {
    argv: argv ? argv.map(entry => (typeof entry === 'string' ? boundedText(entry, DIAG_TEXT_LIMIT) : boundedText(JSON.stringify(entry), DIAG_TEXT_LIMIT))) : null,
    args: args ? args.map(entry => (typeof entry === 'string' ? boundedText(entry, DIAG_TEXT_LIMIT) : boundedText(JSON.stringify(entry), DIAG_TEXT_LIMIT))) : null,
    command,
    extensions,
  };
}

// Read a run's authorize.json but never echo its token: only structural fields
// and token presence are returned.
function collectGateDirDiagnostics(gateDir) {
  if (typeof gateDir !== 'string' || !gateDir) return { gate_dir: gateDir ?? null, exists: false };
  const authorizePath = join(gateDir, 'authorize.json');
  if (!existsSync(authorizePath)) return { gate_dir: gateDir, authorize: null, exists: false };
  try {
    const parsed = JSON.parse(readFileSync(authorizePath, 'utf8'));
    return {
      gate_dir: gateDir,
      exists: true,
      authorize: {
        unit: parsed.unit ?? null,
        invocation_id: parsed.invocation_id ?? parsed.invocationId ?? null,
        token_present: typeof (parsed.token ?? parsed.authorize_token) === 'string' && (parsed.token ?? parsed.authorize_token).length > 0,
      },
    };
  } catch (error) {
    return { gate_dir: gateDir, exists: true, authorize: { error: error?.message ?? String(error) } };
  }
}

function collectRuntimeRunDiagnostics(fixture) {
  const dir = join(fixture.packagePath, 'runtime', 'runs');
  if (!existsSync(dir)) return { dir, runs: [], files: [] };
  const runs = [];
  const files = [];
  const names = readdirSync(dir).sort();
  for (const name of names) {
    const full = join(dir, name);
    if (name.endsWith('.json')) {
      try {
        const record = JSON.parse(readFileSync(full, 'utf8'));
        runs.push({
          file: name,
          id: record.id ?? null,
          step: record.step ?? null,
          state: record.state ?? null,
          phase: record.phase ?? null,
          reason: record.reason ?? null,
          error: record.error ?? null,
          owner_pid: record.owner_pid ?? null,
          service: record.service ?? null,
          command_service: record.command_service ?? null,
          owner_session: record.owner_session ?? null,
          // Launch-shape proof for a failing review: the recorded argv the child
          // was launched with. Arrays are bounded copies; env/secrets never appear.
          child_extensions: collectChildExtensionsDiagnostic(record.child_extensions),
          service_request: collectServiceRequestDiagnostic(record.service_request),
          command_request: collectServiceRequestDiagnostic(record.command_service_request),
          // The owner/reviewer launch request the child recorded at the top level.
          // Only argv/args/command/extensions are copied; env and tokens never appear.
          launch_request: name.endsWith('-owner-request.json') ? collectServiceRequestDiagnostic(record) : null,
          // First-launch proof: the child's actual /proc state, not guessed
          // field names. Narrowly scoped to the recorded service pids.
          service_process: collectServiceProcessDiagnostics(record.service),
          command_service_process: collectServiceProcessDiagnostics(record.command_service),
          gate: collectGateDirDiagnostics(record.service?.gate_dir ?? record.gate_dir ?? null),
        });
      } catch (error) {
        files.push({ file: name, error: error?.message ?? String(error) });
      }
    } else if (name.endsWith('.stderr') || name.endsWith('.result.txt')) {
      let contents = null;
      try { contents = boundedText(readFileSync(full, 'utf8'), DIAG_TEXT_LIMIT); } catch (error) {
        contents = `<unreadable: ${error?.message ?? String(error)}>`;
      }
      files.push({ file: name, contents });
    }
  }
  return { dir, runs, files };
}

function collectShimStateDiagnostics(shimStateDir) {
  const unitsDir = join(shimStateDir, 'units');
  const entries = [];
  if (!existsSync(unitsDir)) return { unitsDir, units: entries };
  for (const name of readdirSync(unitsDir).sort()) {
    const full = join(unitsDir, name);
    try {
      const raw = readFileSync(full, 'utf8');
      if (raw.length > DIAG_JSON_LIMIT) {
        entries.push({ file: name, raw: boundedText(raw, DIAG_JSON_LIMIT) });
        continue;
      }
      const parsed = JSON.parse(raw);
      // Surface every parsed unit field (bounded) rather than selecting
      // possibly-absent state/pid/command names.
      entries.push({ file: name, unit: boundedText(JSON.stringify(parsed), DIAG_JSON_LIMIT) });
    } catch (error) {
      entries.push({ file: name, error: error?.message ?? String(error) });
    }
  }
  return { unitsDir, units: entries };
}

export {
  DIAG_TEXT_LIMIT,
  boundedText,
  collectRuntimeRunDiagnostics,
  collectShimStateDiagnostics,
};
