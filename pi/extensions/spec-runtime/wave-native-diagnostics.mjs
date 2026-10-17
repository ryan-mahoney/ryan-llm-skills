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

// Seal receipts for the given steps of one wave: runtime/waves/<wave_id>/step-NNN-seal.json.
// Read-only and non-recursive; a missing or unreadable receipt is recorded as an
// explicit error so an absent file is never reported as a clean seal.
function collectSealReceiptDiagnostics(waveDirPath, waveId, steps) {
  const waveDir = join(waveDirPath, String(waveId));
  const receipts = [];
  const errors = [];
  let remaining = DIAG_GROUP_LIMIT;
  for (const step of steps) {
    if (remaining <= 0) { errors.push({ path: waveDir, error: `<truncated further seal receipts>` }); break; }
    remaining -= 1;
    const name = `step-${String(step).padStart(3, '0')}-seal.json`;
    const full = join(waveDir, name);
    if (!existsSync(full)) { errors.push({ file: name, error: 'missing seal receipt' }); continue; }
    let receipt;
    try { receipt = JSON.parse(readFileSync(full, 'utf8')); } catch (error) {
      errors.push({ file: name, error: error?.message ?? String(error) });
      continue;
    }
    const reasons = Array.isArray(receipt?.reasons) ? receipt.reasons : [];
    receipts.push({
      file: name,
      step: Number(receipt?.step ?? step),
      state: receipt?.state ?? null,
      reasons: reasons.slice(0, DIAG_GROUP_LIMIT).map(reason => (reason && typeof reason === 'object'
        ? { code: reason.code ?? null, detail: reason.detail ?? null }
        : { code: null, detail: reason ?? null })),
      head: receipt?.head ?? null,
      sealed_head: receipt?.sealed_head ?? null,
    });
  }
  return receipts.length > 0 || errors.length > 0 ? { dir: waveDir, receipts, errors } : null;
}

// Bounded summaries of the durable wave records under <package>/runtime/waves.
// Diagnostic only: records are read, never written, and only scalar identity,
// state, blocking and promotion fields are copied. Explicit read/parse errors
// stay visible instead of vanishing with the directory.
function collectWaveSummaryDiagnostics(packagePath) {
  const dir = join(packagePath, 'runtime', 'waves');
  const waves = [];
  const errors = [];
  if (!existsSync(dir)) return { dir, waves, errors };
  let names = [];
  try { names = readdirSync(dir).sort(); } catch (error) {
    return { dir, waves, errors: [{ path: dir, error: error?.message ?? String(error) }] };
  }
  const recordNames = names.filter(name => name.endsWith('.json'));
  for (const name of recordNames.slice(0, DIAG_GROUP_LIMIT)) {
    const full = join(dir, name);
    let record;
    try { record = JSON.parse(readFileSync(full, 'utf8')); } catch (error) {
      errors.push({ file: name, error: error?.message ?? String(error) });
      continue;
    }
    const integration = record?.target?.integration ?? null;
    const promotion = record?.target?.promotion ?? null;
    const members = record?.members && typeof record.members === 'object'
      ? Object.values(record.members)
      : [];
    const transitions = Array.isArray(record?.transitions) ? record.transitions : [];
    const summary = {
      file: name,
      wave_id: record?.wave_id ?? null,
      state: record?.state ?? null,
      reason: record?.reason ?? null,
      transitions: transitions.slice(-DIAG_GROUP_LIMIT).map(transition => ({
        state: transition?.state ?? null,
        at: transition?.at ?? null,
        reason: transition?.reason ?? null,
      })),
      coordinator: record?.coordinator?.session ?? null,
      members: members.slice(0, DIAG_GROUP_LIMIT).map(member => ({
        step: member?.step ?? null,
        phase: member?.phase ?? null,
        blocking_reason: member?.blocking_reason ?? null,
        blocking_detail: member?.blocking_detail ?? null,
        run_id: member?.run_id ?? null,
        implementation_run_id: member?.implementation_run_id ?? null,
      })),
      integration: integration ? {
        status: integration.status ?? null,
        blocked_reason: integration.blocked_reason ?? null,
      } : null,
      promotion: promotion ? {
        state: promotion.state ?? null,
      } : null,
    };
    // Known seal receipts for the summarized numeric steps of this wave only.
    const sealSteps = [...new Set(members
      .map(member => Number(member?.step))
      .filter(step => Number.isSafeInteger(step) && step > 0))];
    if (sealSteps.length > 0) summary.seal_receipts = collectSealReceiptDiagnostics(dir, record?.wave_id ?? name.replace(/\.json$/, ''), sealSteps);
    waves.push(JSON.parse(JSON.stringify(
      summary,
      (key, value) => (typeof value === 'string' ? boundedText(value, 1000) : value),
    )));
  }
  if (recordNames.length > DIAG_GROUP_LIMIT) errors.push({ path: dir, error: `<truncated ${recordNames.length - DIAG_GROUP_LIMIT} later entries>` });
  return { dir, waves, errors };
}

function collectRuntimeRunDiagnostics(fixture) {
  const dir = join(fixture.packagePath, 'runtime', 'runs');
  if (!existsSync(dir)) return { dir, runs: [], files: [], waves: collectWaveSummaryDiagnostics(fixture.packagePath) };
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
          // Seal-boundary proof: the phase purpose/backend/wave/subject the child
          // recorded, so a failed seal can be attributed without guessing.
          command_phase: collectCommandPhaseDiagnostic(record.command_phase),
          // First-launch proof: the child's actual /proc state, not guessed
          // field names. Narrowly scoped to the recorded service pids.
          service_process: collectServiceProcessDiagnostics(record.service),
          command_service_process: collectServiceProcessDiagnostics(record.command_service),
          gate: collectGateDirDiagnostics(record.service?.gate_dir ?? record.gate_dir ?? null),
          // The run's own command log holds the actual git-status bytes the seal
          // observed before cleanup. Bounded read of at most DIAG_GROUP_LIMIT logs.
          command_logs: collectCommandLogDiagnostics(dir, record.id, name),
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
  // Durable wave summaries are collected last and only read, so a stuck child's
  // run evidence above is never displaced by wave-record inspection.
  return { dir, runs, files, waves: collectWaveSummaryDiagnostics(fixture.packagePath) };
}

// Only the fields that attribute a failure to a phase are copied; layers,
// claim tokens and other credentials never leave the record through diagnostics.
function collectCommandPhaseDiagnostic(phase) {
  if (phase === null || typeof phase !== 'object') return null;
  const subject = phase.subject;
  return {
    purpose: typeof phase.purpose === 'string' ? boundedText(phase.purpose, 200) : null,
    backend: typeof phase.backend === 'string' ? boundedText(phase.backend, 200) : null,
    wave_id: typeof phase.wave_id === 'string' ? boundedText(phase.wave_id, 200) : null,
    subject: subject && typeof subject === 'object' ? {
      kind: typeof subject.kind === 'string' ? boundedText(subject.kind, 200) : null,
      step: subject.step ?? null,
      attempt: subject.attempt ?? null,
    } : null,
  };
}

// Command logs are named <run-id>-command-<uuid>.log in the same runs dir. They
// are read as evidence only while the run record is being summarised, so the
// bytes the seal saw survive the later boot cleanup.
function collectCommandLogDiagnostics(dir, runId, recordName) {
  if (typeof runId !== 'string' || runId === '') return [];
  const prefix = `${runId}-command-`;
  const ownerRecord = runId === recordName || recordName.startsWith(`${runId}.`);
  if (!ownerRecord) return [];
  let names;
  try {
    names = readdirSync(dir).filter(name => name.startsWith(prefix) && name.endsWith('.log')).sort();
  } catch (error) {
    return [{ error: error?.message ?? String(error) }];
  }
  return names.slice(0, DIAG_GROUP_LIMIT).map(name => {
    let contents = null;
    try { contents = boundedText(readFileSync(join(dir, name), 'utf8'), DIAG_TEXT_LIMIT); } catch (error) {
      contents = `<unreadable: ${error?.message ?? String(error)}>`;
    }
    return { file: name, contents };
  });
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
