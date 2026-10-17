import { constants as fsConstants, createReadStream } from 'node:fs';
import { lstat, open, opendir, readFile, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens'];
const validTime = (value) => Number.isFinite(Date.parse(value)) ? value : null;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const strictTime = (value) => typeof value === 'string' && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));
const seconds = (start, end) => start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 10) / 100 : null;
const safeNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const WAVE_STATES = ['open', 'running', 'ready-to-integrate', 'integrating', 'verifying', 'repairing', 'promoting', 'integrated', 'blocked', 'cancelled'];
export const TERMINAL_WAVE_STATES = ['integrated', 'cancelled'];
export const MEMBER_PHASES = ['queued', 'provisioning', 'implementing', 'reviewing', 'fixing', 'confirming', 'sealed', 'blocked', 'cancelled'];
export const ACTIVE_MEMBER_PHASES = ['provisioning', 'implementing', 'reviewing', 'fixing', 'confirming'];
const WAVE_RECORD_NAME = /^[A-Za-z0-9_-]{1,128}\.json$/;
const WAVE_LIMIT = 100;
const WAVE_MAX_BYTES = 262144;

const CANDIDATE_LIMIT = 1000;
const POINTER_BUFFER = 65537;
// Enumeration is bounded by examined entries, not only matching candidates:
// retained non-matching names cannot make discovery unbounded.
const EXAMINE_LIMIT = CANDIDATE_LIMIT * 4;
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

export async function discoverManaged(directory, { limit = 10, budget = null } = {}) {
  const errors = [];
  let directory_handle;
  try { directory_handle = await opendir(directory); }
  catch (error) { return { runs: [], discovery_errors: [{ path: directory, code: error.code }], candidates_truncated: false, runs_truncated: false }; }
  const candidates = [];
  let candidates_truncated = false;
  let examined = 0;
  try {
    // Bounded enumeration: at most 4000 examined entries and 1000 candidate
    // *.json regular files; non-matching names and failed stats count against
    // the examination ceiling.
    while (examined < EXAMINE_LIMIT) {
      const entry = await directory_handle.read();
      if (!entry) break;
      examined++;
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (candidates.length >= CANDIDATE_LIMIT) { candidates_truncated = true; break; }
      const file = path.join(directory, entry.name);
      try { const metadata = await stat(file); candidates.push({ file, modified: metadata.mtimeMs }); }
      catch (error) { errors.push({ path: file, code: error.code }); }
    }
    if (!candidates_truncated && examined >= EXAMINE_LIMIT && await directory_handle.read()) {
      // The examination ceiling itself prevents proving candidate completeness.
      candidates_truncated = true;
    }
  } finally { await directory_handle.close(); }
  candidates.sort((a, b) => b.modified - a.modified);
  const runs = [];
  let runs_truncated = false;
  // Small pointer files only; never follow the manifest or session transcript here.
  for (const candidate of candidates) {
    if (runs.length >= limit) { runs_truncated = true; break; }
    // Pointer reads share the caller's reconciliation budget, including
    // invalid and oversized records, so the total cap still binds.
    if (budget && budget.bytes + POINTER_BUFFER > budget.cap) { errors.push({ path: candidate.file, code: 'READ_BUDGET' }); break; }
    let handle;
    try {
      handle = await open(candidate.file, OPEN_FLAGS);
      const buffer = Buffer.alloc(POINTER_BUFFER);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (budget) budget.bytes += bytesRead;
      if (bytesRead > POINTER_BUFFER - 1) throw new Error('OVERSIZED_INDEX_RECORD');
      const record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (typeof record.run_id !== 'string' || typeof record.package !== 'string') throw new Error('INVALID_INDEX_RECORD');
      const safe = { run_id: record.run_id, package: record.package, indexed_at: new Date(candidate.modified).toISOString() };
      for (const key of ['manifest', 'parent_session']) if (typeof record[key] === 'string') safe[key] = record[key];
      runs.push(safe);
    } catch (error) { errors.push({ path: candidate.file, code: error.code ?? (error instanceof SyntaxError ? 'INVALID_JSON' : error.message) }); }
    finally { await handle?.close(); }
  }
  return { runs, discovery_errors: errors, candidates_truncated, runs_truncated };
}

// Headers are deliberately bounded. Discovery never prints or indexes message bodies.
export async function header(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    let result;
    for (const line of lines.slice(0, 20)) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type === 'session') result = { file, id: row.id, started_at: validTime(row.timestamp), cwd: row.cwd };
      if (!result) continue;
      if (row.type === 'session_info') result.name = row.name;
      if (row.type === 'message' || row.type === 'custom_message') break;
    }
    return result;
  } finally { await handle.close(); }
}

const SESSION_MAX_BYTES = 64 * 1024 * 1024;
const HISTORY_LIMIT = { min: 1, max: 200 };
const failure = (code, message) => Object.assign(new Error(message), { code });
const emptyBranch = () => ({ header: null, entries: [], leaf_id: null, incomplete_tail: false, skipped_lines: 0, truncated: false });
const isMessageEntry = (record) => record.type === 'message' || record.type === 'custom_message';

// LF-only framing: the StringDecoder retains split multibyte sequences and only
// a literal LF ends a line, so U+2028/U+2029 inside a JSON value never split.
// onLine receives the parsed record and its raw line; onError receives malformed
// complete lines without throwing. end() returns the non-LF-terminated remainder
// instead of emitting it, so a torn final line stays visible to the caller.
export function createJsonlSplitter({ onLine = () => {}, onError = () => {} } = {}) {
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  let ended = false;
  const consume = (text) => {
    buffered += text;
    let index;
    while ((index = buffered.indexOf('\n')) !== -1) {
      let line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') continue;
      let record;
      try { record = JSON.parse(line); }
      catch (error) { onError(error, line); continue; }
      onLine(record, line);
    }
  };
  const decode = (chunk) => typeof chunk === 'string' ? chunk : decoder.write(chunk);
  return {
    write(chunk) {
      if (ended) throw new Error('splitter already ended');
      consume(decode(chunk));
    },
    end(chunk) {
      if (ended) throw new Error('splitter already ended');
      ended = true;
      if (chunk !== undefined && chunk !== null) consume(decode(chunk));
      consume(decoder.end());
      const remainder = buffered;
      buffered = '';
      return remainder;
    },
  };
}

// Bounded, read-only active-branch view. The file is read once into a snapshot
// of at most 64 MiB; v2/v3 branches walk backwards from the last valid entry
// through parentId, never through the appended lines of abandoned branches.
// Records and the header are returned as parsed, never rewritten.
export async function readSessionBranch(file, { before, limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < HISTORY_LIMIT.min || limit > HISTORY_LIMIT.max) {
    throw new RangeError(`limit must be an integer ${HISTORY_LIMIT.min}..${HISTORY_LIMIT.max}`);
  }
  let size;
  try { size = (await stat(file)).size; }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return emptyBranch();
    throw failure('unreadable-session', `session is unreadable: ${error.code ?? 'unknown'}`);
  }
  if (size > SESSION_MAX_BYTES) throw failure('session-too-large', `session exceeds ${SESSION_MAX_BYTES} bytes`);
  if (!size) return emptyBranch();
  const records = [];
  let skipped_lines = 0;
  const splitter = createJsonlSplitter({
    onLine: (record) => { if (record && typeof record === 'object') records.push(record); },
    onError: () => { skipped_lines++; },
  });
  try {
    for await (const chunk of createReadStream(file, { start: 0, end: size - 1 })) splitter.write(chunk);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return emptyBranch();
    throw failure('unreadable-session', `session is unreadable: ${error.code ?? 'unknown'}`);
  }
  const incomplete_tail = splitter.end().length > 0;
  const header = records.length && records[0].type === 'session' ? records[0] : null;
  const candidates = header ? records.slice(1) : records;
  const valid = candidates.filter(record => typeof record.id === 'string' && record.id);
  let leaf_id = valid.length ? valid[valid.length - 1].id : null;
  let chain;
  const version = header ? (header.version ?? 1) : undefined;
  if (Number.isInteger(version) && version < 2) {
    // Version 1 sessions are linear: file order is the active branch.
    // An absent header version defaults to 1 (legacy file-order contract).
    chain = candidates;
  } else {
    const byId = new Map();
    for (const record of valid) byId.set(record.id, record);
    chain = [];
    const seen = new Set();
    let current = valid.length ? valid[valid.length - 1] : undefined;
    while (current) {
      if (seen.has(current.id)) throw failure('corrupt-session', 'session entry chain is cyclic');
      seen.add(current.id);
      chain.push(current);
      if (current.parentId === undefined || current.parentId === null) break;
      if (typeof current.parentId !== 'string') throw failure('corrupt-session', 'session entry has an invalid parentId');
      const parent = byId.get(current.parentId);
      if (!parent) throw failure('corrupt-session', `session entry parent is missing: ${current.parentId}`);
      current = parent;
    }
    chain.reverse();
  }
  const messages = chain.filter(isMessageEntry);
  let entries;
  let truncated;
  if (before === undefined) {
    truncated = messages.length > limit;
    entries = truncated ? messages.slice(messages.length - limit) : messages.slice();
  } else {
    const cursor = typeof before === 'string' ? chain.findIndex(record => record.id === before) : -1;
    if (cursor === -1) throw failure('invalid-cursor', 'before must identify an entry on the active branch');
    const prior = chain.slice(0, cursor).filter(isMessageEntry);
    truncated = prior.length > limit;
    entries = truncated ? prior.slice(prior.length - limit) : prior;
  }
  return { header, entries, leaf_id, incomplete_tail, skipped_lines, truncated };
}

export async function discover(directory, { cwd, limit = 20 } = {}) {
  const files = [];
  const errors = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { errors.push({ path: dir, code: error.code }); return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
    }
  }
  await walk(path.resolve(directory));
  const sessions = [];
  for (const file of files) {
    try { const item = await header(file); if (item) sessions.push(item); }
    catch (error) { errors.push({ path: file, code: error.code }); }
  }
  const byFile = new Map(sessions.map(item => [item.file, item]));
  for (const session of sessions) {
    let dir = path.dirname(session.file);
    while (dir !== path.dirname(dir)) {
      // Pi stores descendants below the parent session's basename without .jsonl.
      const parent = byFile.get(`${dir}.jsonl`);
      if (parent && parent !== session) { session.parent_id = parent.id; session.parent_file = parent.file; break; }
      dir = path.dirname(dir);
    }
  }
  const roots = sessions.filter(item => !item.parent_file && (!cwd || item.cwd === path.resolve(cwd)))
    .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
  return { roots: roots.slice(0, limit), sessions, errors };
}

const positiveStep = value => Number.isSafeInteger(value) && value > 0 ? value : null;

const projectMember = member => ({
  step: positiveStep(member.step),
  phase: member.phase ?? null,
  run_id: member.run_id ?? null,
  implementation_run_id: member.implementation_run_id ?? null,
  checkout: member.workspace ? (member.workspace.merged ?? member.workspace.worktree ?? null) : null,
  sealed_head: member.sealed_head ?? null,
  blocking_reason: member.blocking_reason ?? null,
  queue_reason: member.queue_reason ?? null,
  backend: member.workspace?.backend ?? null,
  fallback_reason: member.workspace?.backendReason ?? null,
  snapshot_id: member.workspace?.snapshotId ?? null,
  upper_id: member.workspace?.retained?.upperId ?? null,
  retained: member.workspace?.retained ? {
    lower: member.workspace.retained.lower ?? null, upper: member.workspace.retained.upper ?? null,
    gitDir: member.workspace.retained.gitDir ?? null, worktree: member.workspace.retained.worktree ?? null }
    : null,
  transitions: Array.isArray(member.transitions)
    ? member.transitions.map(x => ({ phase: x.phase, at: x.at, reason: x.reason ?? null })) : [] });

// Normalize one on-disk wave record into the shared observer shape. The record
// owns its version, identity and enums; anything unclassifiable fails closed.
export function projectWaveRecord(value, recordPath) {
  const fail = reason => ({ ok: false, record_path: recordPath, reason });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid-shape');
  if (value.version !== 1) return fail('unsupported-version');
  if (typeof value.wave_id !== 'string' || value.wave_id !== path.basename(recordPath).replace(/\.json$/, '')) return fail('invalid-shape');
  if (!WAVE_STATES.includes(value.state)) return fail('unknown-state');
  if (!Array.isArray(value.transitions) || value.transitions.some(x => !x || !WAVE_STATES.includes(x.state) || !strictTime(x.at))) return fail('invalid-shape');
  if (!value.members || typeof value.members !== 'object' || Array.isArray(value.members)) return fail('invalid-shape');
  const members = [];
  const seenSteps = new Set();
  for (const key of Object.keys(value.members)) {
    const keyStep = /^\d+$/.test(key) ? positiveStep(Number(key)) : null;
    if (keyStep === null || seenSteps.has(keyStep)) return fail('invalid-shape');
    seenSteps.add(keyStep);
    const member = value.members[key];
    if (!member || typeof member !== 'object' || Array.isArray(member)) return fail('invalid-shape');
    if (!MEMBER_PHASES.includes(member.phase)) return fail('unknown-phase');
    if (member.step !== undefined) {
      const memberStep = positiveStep(member.step);
      if (memberStep === null || memberStep !== keyStep) return fail('invalid-shape');
    }
    if (member.transitions !== undefined) {
      if (!Array.isArray(member.transitions) || member.transitions.some(x => !x || !MEMBER_PHASES.includes(x.phase) || !strictTime(x.at))) return fail('invalid-shape');
    }
    members.push({ ...projectMember(member), step: keyStep });
  }
  members.sort((a, b) => a.step - b.step);
  const repair = value.target?.repair;
  const integration = value.target?.integration;
  const candidate = repair || integration ? {
    n: repair?.n ?? null, phase: repair?.phase ?? integration?.status ?? null, run_id: repair?.run_id ?? integration?.phase?.run_id ?? null,
    blocking_reason: repair?.recovery_blocking_reason ?? integration?.blocked_reason ?? null,
    transitions: Array.isArray(repair?.transitions) ? repair.transitions.map(x => ({ phase: x.phase, at: x.at, reason: x.reason ?? null })) : [],
    backend: integration?.backend ?? null,
    fallback_reason: integration?.workspace?.backendReason ?? null,
    checkout: integration?.workspace ? (integration.workspace.merged ?? integration.workspace.worktree ?? null) : null }
    : null;
  return { ok: true, wave: {
    record_path: recordPath,
    wave_id: value.wave_id,
    ordinal: positiveStep(value.ordinal),
    index_sha256: typeof value.inputs?.index_sha256 === 'string' ? value.inputs.index_sha256 : null,
    generation: Number.isInteger(value.generation) ? value.generation : null,
    state: value.state,
    blocking_reason: value.blocking_reason ?? null,
    requested_width: value.requested_width ?? null,
    admitted_width: value.admitted_width ?? null,
    effective_limits: value.effective_limits ?? null,
    opened_at: value.started_at ?? null,
    transitions: value.transitions.map(x => ({ state: x.state, at: x.at })),
    coordinator: { session: value.coordinator?.session ?? null, epoch: value.coordinator?.epoch ?? null,
      process_identity: value.coordinator?.process_identity ? { pid: value.coordinator.process_identity.pid, started_at: value.coordinator.process_identity.started_at } : null },
    members,
    candidate } };
}

// Tie one run record to its wave. A step 8 command phase takes precedence over
// the member-stage wave_bindings it also carries; candidate model runs carry a
// positive integer candidate and never report themselves as their member step.
export function runWaveIdentity(run) {
  if (!run || typeof run !== 'object') return null;
  const command = run.command_phase;
  if (command && typeof command === 'object' && typeof command.wave_id === 'string') {
    return { wave_id: command.wave_id, step_number: command.subject?.kind === 'step' ? command.subject.step : null,
      attempt_id: run.wave_bindings?.attempt_id ?? null, phase: 'command', candidate: null };
  }
  const bindings = run.wave_bindings;
  if (!bindings || typeof bindings !== 'object' || typeof bindings.wave_id !== 'string') return null;
  const candidate = Number.isInteger(bindings.candidate) && bindings.candidate > 0 ? bindings.candidate : null;
  return { wave_id: bindings.wave_id,
    step_number: candidate ? null : bindings.step_number ?? null,
    attempt_id: bindings.attempt_id ?? null,
    phase: bindings.phase ?? null,
    candidate };
}

// Editors listed beside a run plus the legacy anchor, deduplicated.
export function editorSessionFiles(record, listed) {
  const files = [];
  for (const file of Array.isArray(listed) ? listed : []) if (typeof file === 'string' && !files.includes(file)) files.push(file);
  const legacy = record?.editor_session;
  if (typeof legacy === 'string' && !files.includes(legacy)) files.push(legacy);
  return files;
}

// Bounded read of regular safe-basename wave records. A missing directory is an
// empty result; invalid or oversized records are retained in `invalid`.
export async function readWaveRecords(packagePath, { limit = WAVE_LIMIT, maxBytes = WAVE_MAX_BYTES } = {}) {
  const directory = path.join(path.resolve(packagePath), 'runtime', 'waves');
  const waves = [], invalid = [];
  let names;
  try { names = (await readdir(directory)).filter(name => WAVE_RECORD_NAME.test(name)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return { waves, invalid, truncated: false };
    invalid.push({ record_path: directory, reason: error.code ?? 'invalid-json' }); return { waves, invalid, truncated: false }; }
  let truncated = false;
  let count = 0;
  for (const name of names) {
    if (count >= limit) { truncated = true; break; }
    count++;
    const file = path.join(directory, name);
    let text;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) continue; // Symlinks and non-regular entries are not wave records.
      if (info.size > maxBytes) { invalid.push({ record_path: file, reason: 'oversized' }); continue; }
      const handle = await open(file, OPEN_FLAGS);
      try {
        const buffer = Buffer.alloc(maxBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > maxBytes) { invalid.push({ record_path: file, reason: 'oversized' }); continue; }
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await handle.close(); }
    } catch (error) { invalid.push({ record_path: file, reason: error.code === 'ENOENT' ? 'invalid-shape' : (error.code ?? 'invalid-json') }); continue; }
    let value;
    try { value = JSON.parse(text); }
    catch { invalid.push({ record_path: file, reason: 'invalid-json' }); continue; }
    const projected = projectWaveRecord(value, file);
    if (projected.ok) waves.push(projected.wave); else invalid.push({ record_path: file, reason: projected.reason });
  }
  return { waves, invalid, truncated };
}

export async function discoverPackage(packagePath, options = {}) {
  const runtime = path.join(path.resolve(packagePath), 'runtime');
  const index = await discover(path.join(runtime, 'sessions'), options);
  const byFile = new Map(index.sessions.map(item => [item.file, item]));
  const records = [];
  let files;
  try { files = (await readdir(path.join(runtime, 'runs'))).filter(name => name.endsWith('.json')); }
  catch (error) { index.errors.push({ path: path.join(runtime, 'runs'), code: error.code }); files = []; }
  for (const file of files) {
    let record;
    try { record = JSON.parse(await readFile(path.join(runtime, 'runs', file), 'utf8')); }
    catch { index.errors.push({ path: path.join(runtime, 'runs', file), code: 'INVALID_RUN_RECORD' }); continue; }
    if (!record || typeof record.id !== 'string') continue; // Ignore sidecar receipts.
    const safe = {};
    for (const key of ['id', 'assignment_id', 'step', 'checkout', 'owner_model', 'editor_model', 'strong_owner_model', 'planner_model', 'writing_route', 'parent_session', 'owner_session', 'editor_session', 'state', 'pid', 'started_at', 'finished_at', 'dispatch_requested_at']) {
      if (typeof record[key] === 'string' || typeof record[key] === 'number') safe[key] = record[key];
    }
    const identity = runWaveIdentity(record);
    if (identity) { safe.wave_id = identity.wave_id; safe.phase = identity.phase; safe.step_number = identity.step_number; }
    const commandRun = identity?.phase === 'command' || record.infrastructure === true;
    safe.infrastructure = record.infrastructure === true;
    if (['reviewer', 'fixer', 'decision'].includes(record.stage?.role)) {
      safe.stage_role = record.stage.role; safe.stage_kind = record.stage.kind ?? record.stage.role;
    }
    // A command run has no model session of its own; only the coordinator
    // parent is opened. Stage runs project the session for the actual role
    // (reviewer/fixer) rather than the generic owner anchor.
    let modelSession;
    if (commandRun) modelSession = undefined;
    else if (safe.stage_role)
      modelSession = record[`${record.stage.role}_session`];
    else modelSession = record.owner_session;
    if (typeof modelSession === 'string') safe.model_session = modelSession;
    let listed = [];
    try {
      listed = JSON.parse(await readFile(path.join(runtime, 'runs', `${record.id}-editor-sessions.json`), 'utf8'));
      if (!Array.isArray(listed) || listed.some(file => typeof file !== 'string')) throw new Error('Invalid editor sessions');
    } catch (error) { listed = []; if (error.code !== 'ENOENT') index.errors.push({ path: file, code: 'INVALID_EDITOR_SESSIONS' }); }
    const editorFiles = editorSessionFiles(record, listed);
    const resolvedEditorFiles = [];
    for (const editorFile of editorFiles) {
      if (byFile.has(editorFile)) { resolvedEditorFiles.push(editorFile); continue; }
      try { const item = await header(editorFile); if (item) { byFile.set(editorFile, item); index.sessions.push(item); resolvedEditorFiles.push(editorFile); } }
      catch (error) {
        // A missing unlisted legacy anchor is silent; a missing listed editor
        // session remains a discovery error so real coverage gaps stay visible.
        if (!(error.code === 'ENOENT' && !listed.includes(editorFile))) index.errors.push({ path: editorFile, code: error.code });
      }
    }
    safe.editor_sessions = resolvedEditorFiles;
    records.push(safe);
    for (const filePath of [record.parent_session, safe.model_session]) {
      if (!filePath || typeof filePath !== 'string') continue;
      if (!byFile.has(filePath)) {
        try { const item = await header(filePath); if (item) { byFile.set(filePath, item); index.sessions.push(item); } }
        catch (error) { index.errors.push({ path: filePath, code: error.code }); }
      }
    }
    for (const [childFile, parentFile] of [[safe.model_session, record.parent_session],
      ...(safe.editor_sessions ?? [record.editor_session]).map(file => [file, safe.model_session ?? record.owner_session])]) {
      const child = byFile.get(childFile);
      const parent = byFile.get(parentFile);
      if (child && parent && child !== parent) { child.parent_id = parent.id; child.parent_file = parent.file; }
    }
  }
  index.roots = index.sessions.filter(item => !item.parent_file && (!options.cwd || item.cwd === path.resolve(options.cwd)))
    .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? '')).slice(0, options.limit ?? 20);
  records.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
  const eventsFile = path.join(runtime, 'events.jsonl');
  const events = [];
  let eventsTruncated = false;
  try {
    const size = (await stat(eventsFile)).size;
    const bound = 4 * 1024 * 1024;
    eventsTruncated = size > bound;
    if (size) {
      const lines = createInterface({ input: createReadStream(eventsFile, { start: 0, end: Math.min(size, bound) - 1 }), crlfDelay: Infinity });
      for await (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (validTime(event.timestamp) && typeof event.event === 'string') events.push({ timestamp: event.timestamp, event: event.event,
            ...(typeof event.run_id === 'string' ? { run_id: event.run_id } : {}),
            ...(['running', 'completed', 'failed', 'cancelled', 'blocked'].includes(event.state) ? { state: event.state } : {}) });
        } catch { /* A live final line can be incomplete. */ }
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') index.errors.push({ path: eventsFile, code: error.code }); }
  for (const record of records) {
    const ownEvents = events.filter(event => event.run_id === record.id);
    record.event_counts = {};
    record.editor_assignments = [];
    let activeAssignment;
    for (const event of ownEvents) record.event_counts[event.event] = (record.event_counts[event.event] ?? 0) + 1;
    for (const event of ownEvents) {
      if (event.event === 'editor_started') {
        activeAssignment = { sequence: record.editor_assignments.length + 1, started_at: event.timestamp, finished_at: null, state: null, elapsed_seconds: null };
        record.editor_assignments.push(activeAssignment);
      } else if (event.event === 'editor_finished' && activeAssignment) {
        activeAssignment.finished_at = event.timestamp;
        activeAssignment.state = event.state ?? null;
        activeAssignment.elapsed_seconds = seconds(activeAssignment.started_at, event.timestamp);
        activeAssignment = undefined;
      }
    }
    record.elapsed_seconds = seconds(record.started_at, record.finished_at);
    record.first_editor_started_seconds = seconds(record.started_at, ownEvents.find(event => event.event === 'editor_started')?.timestamp);
  }
  index.runtime = { package: path.resolve(packagePath), records, events_file: eventsFile, events_truncated: eventsTruncated,
    waves: await readWaveRecords(packagePath) };
  return index;
}

export async function summarize(session, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const size = (await stat(session.file)).size;
  const result = { ...session, ended_at: null, activity_started_at: null, last_message_role: null,
    models: [], tools: {}, subagent_actions: {}, provider_errors: {}, tool_errors: 0, edit_errors: 0, editor_handoffs: 0,
    first_dispatch_attempt_at: null, first_write_tool_at: null, malformed_lines: 0,
    reported_usage: { assistant_messages: 0, messages_with_usage: 0, messages_with_cost: 0,
      tokens: Object.fromEntries(TOKEN_KEYS.map(key => [key, null])), cost: null },
    source_bytes: size, truncated: size > maxBytes };
  if (!size) return result;
  const input = createReadStream(session.file, { start: 0, end: Math.min(size, maxBytes) - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { result.malformed_lines++; continue; }
    const timestamp = validTime(row.timestamp);
    if (timestamp) result.ended_at = timestamp;
    if (row.type === 'model_change') {
      const model = `${row.provider}/${row.modelId}`;
      if (!result.models.includes(model)) result.models.push(model);
    }
    if (!result.activity_started_at && (row.type === 'custom_message' || row.message?.role === 'user')) result.activity_started_at = timestamp;
    const message = row.message;
    if (!message) continue;
    result.last_message_role = message.role;
    const content = Array.isArray(message.content) ? message.content : [];
    if (message.role === 'assistant') {
      const usage = message.usage;
      const reported = result.reported_usage;
      reported.assistant_messages++;
      if (usage) {
        reported.messages_with_usage++;
        for (const key of TOKEN_KEYS) if (safeNumber(usage[key])) reported.tokens[key] = (reported.tokens[key] ?? 0) + usage[key];
        if (safeNumber(usage.cost?.total)) { reported.messages_with_cost++; reported.cost = (reported.cost ?? 0) + usage.cost.total; }
      }
      if (message.stopReason === 'error' || message.errorMessage) {
        const text = String(message.errorMessage ?? '');
        const type = /connection|websocket|ECONN|ENOTFOUND|fetch failed|network/i.test(text) ? 'connection' : /idle.*timeout|timeout|timed out/i.test(text) ? 'timeout'
          : /rate.?limit|429/.test(text) ? 'rate_limit' : 'other';
        result.provider_errors[type] = (result.provider_errors[type] ?? 0) + 1;
      }
      for (const call of content.filter(part => part.type === 'toolCall')) {
        const name = call.name;
        result.tools[name] = (result.tools[name] ?? 0) + 1;
        if (['write', 'edit', 'apply_patch'].includes(name) && !result.first_write_tool_at) result.first_write_tool_at = timestamp;
        if (name === 'spec_dispatch' && ['start', 'startup'].includes(call.arguments?.action) && !result.first_dispatch_attempt_at) result.first_dispatch_attempt_at = timestamp;
        if (name === 'spec_editor') result.editor_handoffs++;
        if (name === 'subagent') {
          const args = call.arguments ?? {};
          const action = args.action ?? (args.workflow || args.agent || args.tasks ? 'dispatch' : 'unknown');
          result.subagent_actions[action] = (result.subagent_actions[action] ?? 0) + 1;
          if ((action === 'dispatch' || action === 'run' || action === 'spawn') && !result.first_dispatch_attempt_at) result.first_dispatch_attempt_at = timestamp;
        }
      }
    }
    if (message.role === 'toolResult' && message.isError) {
      result.tool_errors++;
      if (['edit', 'write', 'apply_patch'].includes(message.toolName)) result.edit_errors++;
    }
  }
  const start = result.activity_started_at ?? result.started_at;
  result.elapsed_observed_seconds = seconds(start, result.ended_at);
  result.dispatch_attempt_seconds = seconds(start, result.first_dispatch_attempt_at);
  result.first_write_tool_seconds = seconds(start, result.first_write_tool_at);
  return result;
}

export async function report(index, selector, options = {}) {
  const root = selector ? index.sessions.find(item => item.id === selector || item.file === path.resolve(selector)) : index.roots[0];
  if (!root) {
    if (!selector && index.runtime) return { schema_version: 1, root_id: null, measured_at: new Date().toISOString(), sessions: [], runtime: index.runtime,
      discovery_errors: index.errors, limits: ['No session header is available yet. Runtime states are recorded observations, not proof of process liveness.'] };
    throw new Error('Session not found; use list or pass a discovered session ID/path.');
  }
  const selected = new Set([root.file]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of index.sessions) if (selected.has(session.parent_file) && !selected.has(session.file)) { selected.add(session.file); changed = true; }
  }
  const sessions = [];
  for (const session of index.sessions.filter(item => selected.has(item.file))) sessions.push(await summarize(session, options));
  sessions.sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''));
  const rootReport = sessions.find(item => item.file === root.file);
  const firstChild = sessions.filter(item => item.file !== root.file).map(item => item.started_at).filter(Boolean).sort()[0] ?? null;
  const firstChildWrite = sessions.filter(item => item.file !== root.file).map(item => item.first_write_tool_at).filter(Boolean).sort()[0] ?? null;
  const start = rootReport.activity_started_at ?? rootReport.started_at;
  return { schema_version: 1, root_id: root.id, measured_at: new Date().toISOString(),
    timings: { origin_at: start, first_child_started_at: firstChild, first_child_started_seconds: seconds(start, firstChild),
      first_child_write_tool_at: firstChildWrite, first_child_write_tool_seconds: seconds(start, firstChildWrite) },
    sessions, ...(index.runtime ? { runtime: index.runtime } : {}), discovery_errors: index.errors,
    limits: ['Read-only snapshot; messages do not establish worker process liveness.',
      'Write timing counts explicit write/edit/apply_patch calls, not success or code-only edits; shell writes are not inferred.',
      'Dispatch timing records attempts; child session creation is separate and does not prove successful implementation.',
      'Costs are provider-reported, not billing totals; zero may mean unpriced. Missing values remain null.',
      'Token totals include repeated cached context; reasoning may overlap output. Do not add token fields together.',
      'Session links derive from Pi directory ancestry; externally stored children may be absent.'] };
}
