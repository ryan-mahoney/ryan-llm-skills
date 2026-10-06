import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens'];
const validTime = (value) => Number.isFinite(Date.parse(value)) ? value : null;
const seconds = (start, end) => start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 10) / 100 : null;
const safeNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export async function discoverManaged(directory, { limit = 10 } = {}) {
  const errors = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { return { runs: [], discovery_errors: [{ path: directory, code: error.code }], candidates_truncated: false }; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(directory, entry.name);
    try { const metadata = await stat(file); candidates.push({ file, modified: metadata.mtimeMs }); }
    catch (error) { errors.push({ path: file, code: error.code }); }
  }
  candidates.sort((a, b) => b.modified - a.modified);
  const runs = [];
  // Small pointer files only; never follow the manifest or session transcript here.
  for (const candidate of candidates.slice(0, 1000)) {
    let handle;
    try {
      handle = await open(candidate.file, 'r');
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) throw new Error('OVERSIZED_INDEX_RECORD');
      const record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (typeof record.run_id !== 'string' || typeof record.package !== 'string') throw new Error('INVALID_INDEX_RECORD');
      const safe = { run_id: record.run_id, package: record.package, indexed_at: new Date(candidate.modified).toISOString() };
      for (const key of ['manifest', 'parent_session']) if (typeof record[key] === 'string') safe[key] = record[key];
      runs.push(safe);
      if (runs.length >= limit) break;
    } catch (error) { errors.push({ path: candidate.file, code: error.code ?? (error instanceof SyntaxError ? 'INVALID_JSON' : error.message) }); }
    finally { await handle?.close(); }
  }
  return { runs, discovery_errors: errors, candidates_truncated: candidates.length > 1000 };
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
    const safe = {};
    for (const key of ['id', 'assignment_id', 'step', 'checkout', 'owner_model', 'editor_model', 'parent_session', 'owner_session', 'editor_session', 'state', 'pid', 'started_at', 'finished_at', 'dispatch_requested_at']) {
      if (typeof record[key] === 'string' || typeof record[key] === 'number') safe[key] = record[key];
    }
    records.push(safe);
    for (const key of ['parent_session', 'owner_session', 'editor_session']) {
      const filePath = record[key];
      if (!filePath || typeof filePath !== 'string') continue;
      if (!byFile.has(filePath)) {
        try { const item = await header(filePath); if (item) { byFile.set(filePath, item); index.sessions.push(item); } }
        catch (error) { index.errors.push({ path: filePath, code: error.code }); }
      }
    }
    for (const [childKey, parentKey] of [['owner_session', 'parent_session'], ['editor_session', 'owner_session']]) {
      const child = byFile.get(record[childKey]);
      const parent = byFile.get(record[parentKey]);
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
  index.runtime = { package: path.resolve(packagePath), records, events_file: eventsFile, events_truncated: eventsTruncated };
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
