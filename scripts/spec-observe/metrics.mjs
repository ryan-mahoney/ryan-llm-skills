import { createReadStream } from 'node:fs';
import { lstat, opendir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { discoverPackage, discover, TERMINAL_WAVE_STATES, ACTIVE_MEMBER_PHASES } from './core.mjs';
import { locatePackage } from '../spec-location/index.mjs';

const ms = value => typeof value === 'number' ? value : Date.parse(value);
const seconds = value => Math.round(value / 10) / 100;
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const shellTools = new Set(['bash', 'exec_command', 'spec_verify']);
const delegationTools = new Set(['spec_editor', 'spec_answer', 'spec_question', 'spec_scout', 'subagent']);

// Recognize submitted test commands, never execute them. Tokenize quotes before
// splitting shell operators so `echo "mix test"` and grep patterns don't count.
// Conditional commands, aliases and arbitrary scripts cannot prove actual tests ran.
export function testCommands(command, depth = 0) {
  if (typeof command !== 'string' || command.length > 131072 || depth > 4) return [];
  // Ignore heredoc bodies: they may contain arbitrary source/test examples.
  const body = command.split(/<<-?\s*['"]?\w+/)[0];
  const tokens = body.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;|\n]|[^\s;|&]+/g) ?? [];
  const groups = [[]];
  for (const token of tokens) {
    if (['&&', '||', ';', '|', '\n'].includes(token)) groups.push([]);
    else groups.at(-1).push(token);
  }
  const found = [];
  for (let words of groups) {
    const raw = words.filter(Boolean);
    words = raw.map(token => token.replace(/^(['"])(.*)\1$/s, '$2'));
    while (/^\w+=/.test(words[0] ?? '')) words.shift();
    if (words[0] === 'env') { words.shift(); while (/^\w+=/.test(words[0] ?? '')) words.shift(); }
    if (['timeout', 'gtimeout'].includes(words[0])) { words.shift(); if (/^[\d.]+[smhd]?$/.test(words[0] ?? '')) words.shift(); }
    // Only unwrap an explicit exec separator. Never interpret mise tasks, shell
    // expansions or commands supplied through configuration.
    if (path.basename(words[0] ?? '') === 'mise' && ['exec', 'x'].includes(words[1])) {
      const separator = words.indexOf('--', 2);
      if (separator < 0 || words.slice(2, separator).some(word => /[$`]/.test(word))) continue;
      words = words.slice(separator + 1);
      while (/^\w+=/.test(words[0] ?? '')) words.shift();
    }
    const executable = path.basename(words[0] ?? '');
    const args = words.slice(1);
    if (['bash', 'sh', 'zsh', 'dash'].includes(executable)) {
      const at = args.findIndex(arg => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
      if (at >= 0 && args[at + 1] !== undefined) {
        // Locate the original quoted payload after env/timeout prefixes. Only
        // inspect literal -c bodies; never expand variables or run a shell.
        const payload = raw[raw.length - words.length + at + 2];
        if (payload?.startsWith("'")) found.push(...testCommands(payload.slice(1, -1), depth + 1));
        else if (payload?.startsWith('"') && !/(?<!\\)[$`]/.test(payload.slice(1, -1)))
          found.push(...testCommands(payload.slice(1, -1).replace(/\\(["\\$`])/g, '$1'), depth + 1));
        else if (payload && !/["'$`\\]/.test(payload)) found.push(...testCommands(payload, depth + 1));
      }
      continue;
    }
    let runner;
    if (['pytest', 'jest', 'vitest', 'rspec', 'phpunit'].includes(executable)) runner = executable;
    else if (executable === 'mix' && args[0] === 'test') runner = 'mix test';
    else if (['cargo', 'go', 'bun', 'deno', 'dotnet'].includes(executable) && args[0] === 'test') runner = `${executable} test`;
    else if (executable === 'node' && args.includes('--test')) runner = 'node --test';
    else if (/^python[\d.]*$/.test(executable) && args[0] === '-m' && ['pytest', 'unittest'].includes(args[1])) runner = `python -m ${args[1]}`;
    else if (['npm', 'pnpm', 'yarn'].includes(executable) && /^(test|test:.*)$/.test(args[args[0] === 'run' ? 1 : 0] ?? '')) runner = `${executable} test-script`;
    else if (['npx', 'pnpm', 'bun'].includes(executable) && ['jest', 'vitest', 'playwright'].includes(args[args[0] === 'exec' || args[0] === 'x' ? 1 : 0])) runner = `${executable} test-runner`;
    if (runner) found.push(runner);
  }
  return found;
}

function blank(role, model, file) {
  return { role, model, sessions: new Set([file]), model_calls: 0, tool_calls: 0, tools: {},
    model_response_seconds: 0, timed_model_calls: 0, tool_wait_upper_bound_seconds: 0,
    delegation_wait_upper_bound_seconds: 0, timed_tool_calls: 0, tool_errors: 0,
    connection_errors: 0, timeout_errors: 0, other_provider_errors: 0, test_command_calls: 0, recognized_test_commands: 0,
    test_command_results: 0, test_command_failures: 0, test_commands_with_exit: 0, shell_calls: 0,
    reported_cost: null, priced_model_calls: 0, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, usage_model_calls: 0, last_activity_at: null };
}
const add = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
const contains = (windows, time) => !windows || windows.some(([start, end]) => time >= start && time <= end);

// Native message.timestamp is the provider message start; the envelope timestamp
// is persistence after completion. This is observed response latency, not GPU time.
export async function readMetrics(node, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const groups = new Map(), calls = new Map(), seen = new Set();
  const completionReports = [], successfulEdits = [];
  const startup = { model_calls: 0, tool_calls: 0, reads: 0, shell_calls: 0 };
  let currentModel = 'unknown', first = null, last = null, origin = null, malformed = 0;
  const metadata = await stat(node.file);
  const result = () => ({ agents: [...groups.values()], first, last, origin,
    completionReports, successfulEdits, startup, coverage: { file: node.file, truncated: metadata.size > maxBytes, malformed_lines: malformed, unresolved_tool_calls: calls.size } });
  if (!metadata.size) return result();
  for await (const line of createInterface({ input: createReadStream(node.file, { start: 0, end: Math.min(metadata.size, maxBytes) - 1 }), crlfDelay: Infinity })) {
    let row; try { row = JSON.parse(line); } catch { malformed++; continue; }
    if (row.type === 'model_change') currentModel = `${row.provider}/${row.modelId}`;
    const time = ms(row.timestamp), message = row.message;
    if (!Number.isFinite(time) || !contains(node.windows, time) || !message) continue;
    if (row.id && seen.has(row.id)) continue;
    if (row.id) seen.add(row.id);
    first = first === null ? time : Math.min(first, time); last = last === null ? time : Math.max(last, time);
    if (message.role === 'user' && origin === null) origin = time;
    if (message.role === 'assistant') {
      // Only the existing structured coordinator summary is a completion claim.
      // Thinking, tools, worker exits and conversational 'done' prose do not qualify.
      if (node.role === 'coordinator' && message.stopReason === 'stop') {
        const content = typeof message.content === 'string' ? message.content
          : (Array.isArray(message.content) ? message.content : []).filter(p => p.type === 'text').map(p => p.text).join('\n');
        for (const block of content.matchAll(/```(?:txt|text)?\n([\s\S]*?)```/g)) {
          const fields = Object.fromEntries([...block[1].matchAll(/^([a-z-]+):[ \t]*(.+)$/gm)].map(m => [m[1], m[2].trim()]));
          if (fields.outcome === 'published' && fields.blocker === 'none' && fields['spec-folder'] && /^https:\/\//.test(fields.pr ?? ''))
            completionReports.push({ timestamp: row.timestamp, package: path.resolve(fields['spec-folder']), source: 'coordinator_structured_completion_report' });
        }
      }

      const model = message.model && message.provider ? `${message.provider}/${message.model}` : currentModel;
      if (!groups.has(model)) groups.set(model, blank(node.role, model, node.file));
      const agent = groups.get(model); agent.model_calls++; agent.last_activity_at = row.timestamp;
      const beforeDispatch = node.role === 'coordinator' && Number.isFinite(node.firstDispatch) && time <= node.firstDispatch;
      if (beforeDispatch) startup.model_calls++;
      if (message.stopReason === 'error' || message.errorMessage) {
        const error = String(message.errorMessage ?? '');
        const category = /connection|websocket|ECONN|ENOTFOUND|fetch failed|network/i.test(error) ? 'connection_errors'
          : /timeout|timed out/i.test(error) ? 'timeout_errors' : 'other_provider_errors';
        agent[category]++;
      }
      const start = ms(message.timestamp);
      if (Number.isFinite(start) && start <= time && contains(node.windows, start)) {
        agent.timed_model_calls++; agent.model_response_seconds += seconds(time - start);
      }
      const usage = message.usage;
      if (usage) {
        agent.usage_model_calls++;
        for (const [field, key] of [['input_tokens', 'input'], ['output_tokens', 'output'], ['cache_read_tokens', 'cacheRead']]) if (nonnegative(usage[key])) agent[field] += usage[key];
        if (nonnegative(usage.cost?.total)) { agent.priced_model_calls++; agent.reported_cost = (agent.reported_cost ?? 0) + usage.cost.total; }
      }
      for (const call of Array.isArray(message.content) ? message.content : []) {
        if (call.type !== 'toolCall') continue;
        agent.tool_calls++; add(agent.tools, call.name);
        if (beforeDispatch) { startup.tool_calls++; if (['read', 'grep', 'find', 'ls'].includes(call.name)) startup.reads++; if (shellTools.has(call.name)) startup.shell_calls++; }
        const tests = shellTools.has(call.name) ? testCommands(call.arguments?.command ?? call.arguments?.cmd) : [];
        if (shellTools.has(call.name)) agent.shell_calls++;
        if (tests.length) { agent.test_command_calls++; agent.recognized_test_commands += tests.length; }
        if (call.id) calls.set(call.id, { time, agent, name: call.name, path: call.arguments?.path, tests: tests.length });
      }
    } else if (message.role === 'toolResult') {
      const call = calls.get(message.toolCallId);
      if (call) {
        calls.delete(message.toolCallId);
        if (time >= call.time) {
          call.agent.timed_tool_calls++;
          const key = delegationTools.has(call.name) ? 'delegation_wait_upper_bound_seconds' : 'tool_wait_upper_bound_seconds';
          call.agent[key] += seconds(time - call.time);
        }
        if (message.isError) call.agent.tool_errors++;
        if (call.tests) {
          call.agent.test_command_results++;
          let details = message.details?.result ?? message.details;
          // Native spec_verify persists its structured reply in a JSON text block.
          // Do not parse arbitrary shell output as a verification receipt.
          if (call.name === 'spec_verify' && !Number.isInteger(details?.exit_code) && !Number.isInteger(details?.exitCode)) {
            const blocks = Array.isArray(message.content) ? message.content : [];
            for (const block of blocks) {
              if (block.type !== 'text') continue;
              try {
                const value = JSON.parse(block.text);
                if (typeof value?.receipt_id === 'string' && Number.isInteger(value.exit_code)) { details = value; break; }
              } catch { /* Ordinary text is not a structured result. */ }
            }
          }
          const exit = details?.exit_code ?? details?.exitCode;
          if (Number.isInteger(exit)) call.agent.test_commands_with_exit++;
          if (message.isError || details?.error || (Number.isInteger(exit) && exit !== 0)) call.agent.test_command_failures++;
        }
        if (!message.isError && !message.details?.error && !message.details?.result?.error && ['write', 'edit'].includes(call.name) && typeof call.path === 'string' && node.checkout) {
          const relative = path.relative(node.checkout, path.resolve(node.checkout, call.path));
          if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.split(path.sep).includes('.specs')) successfulEdits.push(time);
        }
      }
    }
  }
  return result();
}

const inferredRole = item => /^(spec-stage-reviewer|reviewer):/.test(item.name ?? '') ? 'reviewer'
  : /^spec-step-fixer:/.test(item.name ?? '') ? 'fixer' : /^scout:/.test(item.name ?? '') ? 'scout' : 'worker';

// Metrics role from a wave phase. Editors stay editors; command runs carry no
// model session (handled by the caller).
const phaseRole = phase => ['reviewing', 'confirming', 'integration-review', 'integration-confirm'].includes(phase) ? 'reviewer'
  : ['fixing', 'integration-fix'].includes(phase) ? 'fixer'
  : 'owner';

const safeReason = value => typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value) ? value : 'unrecognized';
const toSeconds = (start, end) => {
  const a = ms(start), b = ms(end);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? seconds(b - a) : 0;
};
// A member phase interval runs from its transition to the next transition, the
// wave's terminal transition, or `now`.
const memberIntervals = (member, wave, now) => {
  const transitions = [...(member.transitions ?? [])].map(t => ({ ...t, time: ms(t.at) })).filter(t => Number.isFinite(t.time))
    .sort((a, b) => a.time - b.time);
  const terminalAt = wave?.transitions?.find(t => TERMINAL_WAVE_STATES.includes(t.state));
  const waveEnd = terminalAt ? ms(terminalAt.at) : now;
  return transitions.map((t, index) => ({ phase: t.phase, reason: t.reason ?? null, start: t.time,
    end: index + 1 < transitions.length ? transitions[index + 1].time : waveEnd }));
};
const addTotals = (target, key, value) => { target[key] = (target[key] ?? 0) + value; };

// Distinct member steps whose run intervals overlap another's, per wave.
// Positive-duration run intervals only: zero-duration (end === start) and
// reversed intervals (end < start) are dropped, and same-step runs are collapsed
// through a per-step multiplicity so a step never double-counts against itself.
const peakOverlap = intervals => {
  const events = [];
  for (const [step, start, end] of intervals) {
    if (!(start < end)) continue;
    events.push([start, 1, step]);
    events.push([end, -1, step]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const perStep = new Map();
  let distinct = 0, peak = 0;
  for (const [, delta, step] of events) {
    const next = (perStep.get(step) ?? 0) + delta;
    perStep.set(step, next);
    if (delta > 0) { if (next === 1) distinct++; }
    else if (next === 0) distinct--;
    if (distinct > peak) peak = distinct;
  }
  return peak;
};

// Retained layer storage. Regular files only, no symlink traversal, merged and
// work views never read, bounded entries per wave.
const STORAGE_ENTRY_LIMIT = 200000;
async function directoryBytes(root, budget) {
  if (typeof root !== 'string' || !root) return 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let handle;
    try { handle = await opendir(directory); }
    catch { budget.unreadable++; continue; }
    try {
      while (true) {
        if (budget.entries >= STORAGE_ENTRY_LIMIT) { budget.truncated = true; return bytes; }
        const entry = await handle.read();
        if (!entry) break;
        budget.entries++;
        const file = path.join(directory, entry.name);
        try {
          const info = await lstat(file);
          if (info.isSymbolicLink()) continue;
          if (info.isDirectory()) pending.push(file);
          else if (info.isFile()) bytes += info.size;
        } catch { budget.unreadable++; }
      }
    } finally { await handle.close().catch(() => {}); }
    if (budget.entries >= STORAGE_ENTRY_LIMIT) { budget.truncated = true; return bytes; }
  }
  return bytes;
}

export async function metrics(packagePath, { session, allSessions = false, maxBytes, now = Date.now() } = {}) {
  const index = await discoverPackage(packagePath);
  const records = index.runtime.records;
  const waveRecords = index.runtime.waves?.waves ?? [];
  const waveRuns = records.filter(r => typeof r.wave_id === 'string');
  const parents = [...new Set(records.map(r => r.parent_session).filter(Boolean))];
  if (!parents.length) throw new Error('No recorded coordinator session; metrics require a managed package.');
  // A wave spans coordinator restarts. Without an explicit session or allSessions,
  // wave-carrying runs select every parent_session that owns one of them.
  const explicit = session ? (parents.find(file => file === path.resolve(session) || index.sessions.find(s => s.file === file)?.id === session) ?? null) : null;
  const waveScope = !allSessions && !session && waveRuns.length > 0;
  let selectedParents;
  if (allSessions) selectedParents = parents;
  else if (session) selectedParents = [explicit];
  else if (waveScope) selectedParents = [...new Set(waveRuns.map(r => r.parent_session).filter(Boolean))];
  else selectedParents = [records.find(r => r.parent_session)?.parent_session];
  if (selectedParents.some(p => !p)) throw new Error('Coordinator session not found for this package.');
  const selectedRuns = records.filter(r => selectedParents.includes(r.parent_session));
  const nodes = new Map(), errors = [];
  for (const entry of index.runtime.waves?.invalid ?? [])
    errors.push({ path: entry.record_path, code: 'INVALID_WAVE_RECORD' });
  if (index.runtime.waves?.truncated)
    errors.push({ path: path.join(path.resolve(packagePath), 'runtime', 'waves'), code: 'WAVE_RECORDS_TRUNCATED' });
  const addNode = (file, role, windows) => {
    const existing = nodes.get(file);
    if (existing) { if (existing.windows && windows) existing.windows.push(...windows); return; }
    nodes.set(file, { file, role, windows });
  };
  for (const file of selectedParents) {
    addNode(file, 'coordinator');
    nodes.get(file).firstDispatch = Math.min(...selectedRuns.filter(r => r.parent_session === file).map(r => ms(r.started_at)).filter(Number.isFinite));
  }
  for (const record of selectedRuns) {
    // Wave-aware role assignment: a command run has no model session at all;
    // every other wave run takes its role solely from the phase, and editor role
    // is never inferred from a phase name.
    const wave = typeof record.wave_id === 'string';
    const editorFiles = Array.isArray(record.editor_sessions)
      ? record.editor_sessions
      : (record.editor_session ? [record.editor_session] : []);
    const waveRole = wave ? (record.phase === 'command' ? null : phaseRole(record.phase)) : undefined;
    if (waveRole === null) continue;
    const modelSession = record.model_session ?? record.owner_session;
    if (waveRole && modelSession) {
      if (Number.isFinite(ms(record.started_at))) {
        addNode(modelSession, waveRole, [[ms(record.started_at), Number.isFinite(ms(record.finished_at)) ? ms(record.finished_at) : now]]);
        nodes.get(modelSession).checkout = record.checkout;
      }
    }
    if (wave) {
      for (const file of editorFiles) if (file && Number.isFinite(ms(record.started_at))) {
        addNode(file, 'editor', [[ms(record.started_at), Number.isFinite(ms(record.finished_at)) ? ms(record.finished_at) : now]]);
        nodes.get(file).checkout = record.checkout;
      }
      continue;
    }
    for (const role of ['owner', 'editor']) {
      const files = role === 'editor' ? (record.editor_sessions ?? [record.editor_session]) : [record.owner_session];
      for (const file of files) if (file && Number.isFinite(ms(record.started_at)))
        {
          addNode(file, role, [[ms(record.started_at), Number.isFinite(ms(record.finished_at)) ? ms(record.finished_at) : now]]);
          nodes.get(file).checkout = record.checkout;
        }
    }
  }
  // Historical missing workers outside this selection are not coverage gaps here.
  errors.push(...index.errors.filter(e => !e.path?.endsWith('.jsonl')));
  // Follow only linked roots and retained worker descendants. This includes async
  // reviewers and scouts outside the package; it does not scan unrelated projects.
  for (const node of [...nodes.values()]) {
    const directory = node.file.replace(/\.jsonl$/, '');
    try { await stat(directory); } catch (error) { if (error.code !== 'ENOENT') errors.push({ path: directory, code: error.code }); continue; }
    const children = await discover(directory);
    errors.push(...children.errors);
    for (const child of children.sessions) addNode(child.file, inferredRole(child), node.windows ? [...node.windows] : undefined);
  }
  const agents = new Map(), coverage = [], times = [], origins = [], completionReports = [], successfulEdits = [];
  const startup = { model_calls: 0, tool_calls: 0, reads: 0, shell_calls: 0 };
  for (const node of nodes.values()) {
    let data;
    try { data = await readMetrics(node, { maxBytes }); }
    catch (error) { errors.push({ path: node.file, code: error.code ?? 'READ_FAILED' }); continue; }
    coverage.push(data.coverage);
    if (node.role === 'editor') successfulEdits.push(...data.successfulEdits);
    for (const key of Object.keys(startup)) startup[key] += data.startup[key];
    completionReports.push(...data.completionReports.filter(r => r.package === path.resolve(packagePath)));
    if (data.first !== null) times.push(data.first, data.last);
    if (selectedParents.includes(node.file) && data.origin !== null) origins.push(data.origin);
    for (const item of data.agents) {
      const key = `${item.role}\0${item.model}`;
      if (!agents.has(key)) { agents.set(key, item); continue; }
      const target = agents.get(key);
      for (const file of item.sessions) target.sessions.add(file);
      for (const [field, value] of Object.entries(item)) {
        if (typeof value === 'number') target[field] = (target[field] ?? 0) + value;
      }
      for (const [tool, count] of Object.entries(item.tools)) target.tools[tool] = (target.tools[tool] ?? 0) + count;
      if (item.last_activity_at > target.last_activity_at) target.last_activity_at = item.last_activity_at;
    }
  }
  const rows = [...agents.values()].map(a => ({ ...a, sessions: [...a.sessions],
    model_response_seconds: seconds(a.model_response_seconds * 1000),
    tool_wait_upper_bound_seconds: seconds(a.tool_wait_upper_bound_seconds * 1000),
    delegation_wait_upper_bound_seconds: seconds(a.delegation_wait_upper_bound_seconds * 1000) })).sort((a, b) => b.model_response_seconds - a.model_response_seconds);
  const start = origins.length ? Math.min(...origins) : times.length ? Math.min(...times) : null;
  const end = times.length ? Math.max(...times) : null;
  const milestones = [];
  for (const report of completionReports) milestones.push({ kind: 'coordinator_completion_reported', timestamp: report.timestamp, source: report.source });
  // pr-url.json remains a publication receipt, never proof the coordinator finished.
  try {
    const receipt = JSON.parse(await readFile(path.join(packagePath, 'pr-url.json'), 'utf8'));
    const located = await locatePackage(path.resolve(packagePath));
    // One entry per target; the earliest qualifying submission marks the milestone.
    const submitted = located.ok && receipt.package_ref === located.ref ? Object.values(receipt.targets ?? {})
      .filter(entry => (receipt.schema_version ?? entry?.schema_version) === 1 && (receipt.kind ?? entry?.kind) === 'pr_submission' && selectedParents.includes(entry.parent_session)
        && /^https:\/\//.test(entry.url ?? '') && Number.isFinite(ms(entry.submitted_at)) && start !== null && ms(entry.submitted_at) >= start
        && ms(entry.submitted_at) <= now)
      .sort((x, y) => ms(x.submitted_at) - ms(y.submitted_at))[0] : null;
    if (submitted) milestones.push({ kind: 'pr_submitted', timestamp: submitted.submitted_at, source: 'session_bound_pr_url_receipt' });
  } catch (error) { if (error.code !== 'ENOENT') errors.push({ path: path.join(packagePath, 'pr-url.json'), code: error.code ?? 'INVALID_PUBLICATION_RECEIPT' }); }
  milestones.sort((a, b) => ms(a.timestamp) - ms(b.timestamp));
  const completion = milestones.find(m => m.kind === 'coordinator_completion_reported');
  const boundary = completion ? ms(completion.timestamp) : null;
  const firstDispatch = Math.min(...selectedRuns.map(r => ms(r.started_at)).filter(Number.isFinite));
  const attempts = selectedRuns.map(r => {
    const editorStart = r.editor_assignments[0]?.started_at;
    const edit = successfulEdits.filter(t => t >= ms(r.started_at) && t <= (ms(r.finished_at) || now)).sort((a, b) => a - b)[0];
    return ({ run_id: r.id, step: r.step ? path.basename(r.step) : null,
    assignment_id: r.assignment_id, state: r.state, started_at: r.started_at, finished_at: r.finished_at ?? null,
    elapsed_seconds: Number.isFinite(ms(r.finished_at)) ? seconds(ms(r.finished_at) - ms(r.started_at)) : null,
    elapsed_to_snapshot_seconds: !Number.isFinite(ms(r.finished_at)) && Number.isFinite(ms(r.started_at)) ? seconds(now - ms(r.started_at)) : null,
    first_editor_seconds: r.first_editor_started_seconds,
    dispatch_to_owner_seconds: Number.isFinite(ms(r.dispatch_requested_at)) ? seconds(ms(r.started_at) - ms(r.dispatch_requested_at)) : null,
    editor_to_first_checkout_edit_seconds: Number.isFinite(edit) && Number.isFinite(ms(editorStart)) ? seconds(edit - ms(editorStart)) : null, editor_assignments: r.editor_assignments.length,
    editor_elapsed_seconds: r.editor_assignments.reduce((sum, a) => sum + (a.elapsed_seconds ?? 0), 0) }); });
  const { waves, barrier_waits } = await computeWaves({ packagePath, waveRecords, waveRuns, now, errors });
  const sum = field => rows.reduce((n, a) => n + a[field], 0);
  const most = field => { const sorted = rows.filter(a => field !== 'model_response_seconds' || a.timed_model_calls).sort((a, b) => b[field] - a[field]); return sorted.length ? { role: sorted[0].role, model: sorted[0].model, value: sorted[0][field] } : null; };
  return { schema_version: 1, measured_at: new Date(now).toISOString(), package: path.resolve(packagePath),
    scope: allSessions ? 'all_recorded_coordinator_sessions' : waveScope ? 'all_wave_coordinator_sessions' : 'selected_coordinator_session', coordinator_sessions: selectedParents,
    startup: { ...startup, session_to_first_owner_seconds: start !== null && Number.isFinite(firstDispatch) ? seconds(firstDispatch - start) : null },
    process: { started_at: start === null ? null : new Date(start).toISOString(), last_activity_at: end === null ? null : new Date(end).toISOString(),
      observed_span_seconds: start !== null && end !== null ? seconds(end - start) : null,
      elapsed_to_snapshot_seconds: start === null ? null : seconds(now - start), completion: completion ? 'reported_by_coordinator' : 'not_inferred_from_agent_exit',
      milestones, completion_reported_at: completion?.timestamp ?? null,
      elapsed_to_completion_report_seconds: boundary !== null ? seconds(boundary - start) : null,
      post_completion_activity_seconds: boundary !== null && end !== null ? seconds(Math.max(0, end - boundary)) : null },
    totals: { model_calls: sum('model_calls'), tool_calls: sum('tool_calls'), test_command_calls: sum('test_command_calls'),
      recognized_test_commands: sum('recognized_test_commands'), test_command_results: sum('test_command_results'), test_command_failures: sum('test_command_failures'), test_commands_with_exit: sum('test_commands_with_exit'), connection_errors: sum('connection_errors'), timeout_errors: sum('timeout_errors'), reported_cost: rows.some(a => a.reported_cost !== null) ? sum('reported_cost') : null },
    leaders: { model_calls: most('model_calls'), tool_calls: most('tool_calls'), model_response_seconds: most('model_response_seconds') },
    agents: rows, steps: attempts.sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? '')), coverage, discovery_errors: errors,
    waves, barrier_waits,
    limits: ['Startup uses the first user message in the selected coordinator session, not a proven workflow request; reused sessions can include earlier work. Checkout edits count successful native write/edit results outside .specs; shell writes and semantic correctness are not inferred.',
      'Model calls count persisted assistant responses, including errors; hidden provider retries are unavailable.',
      'Response latency uses native message start and persistence timestamps; missing timing stays unmeasured. It includes provider/network latency, not only computation.',
      'Tool waits run from call submission to result; queued/parallel calls overlap. Delegation wait is separate and includes child work. Do not add these times to wall time.',
      'Test counts recognize submissions and returned tool results, not proven suite starts or passes. Failure counts describe the containing tool/command and can include setup failures. Literal shell -c wrappers are inspected to depth 4; dynamic bodies, conditionals, custom scripts and hidden retries may be missed. Returned exit codes apply to the whole command.',
      'Step durations cover managed attempts, including verification/waits, not separate review/fix stages. Repeated attempts remain separate. Terminal worker state is not acceptance.',
      'Observed span includes user pauses. A session-bound publication receipt reports PR submission; the structured coordinator summary reports completion, not acceptance. Exits and live process state are not inferred. Reused worker transcripts are filtered to this coordinator\'s run windows.',
      'Provider-reported costs may be partial or unpriced zero; these are not billing totals. Cached tokens are repeated input.',
      'Native history predating available transcripts, external workers and missing/truncated files cannot be counted.',
      'Wave overlap, queue, barrier and integration times are observed scheduling facts for this run; synthetic or loopback providers establish no provider throughput or cost improvement.',
      'Layer storage sums regular files in retained lower, upper, private Git and fallback worktree directories; merged views and kernel work directories are never read.'] };
}

// Wave rows and barrier waits use every wave record and every wave-carrying run,
// independent of the coordinator-session selection above.
async function computeWaves({ packagePath, waveRecords, waveRuns, now, errors }) {
  const runsByWave = new Map();
  for (const run of waveRuns) {
    if (!runsByWave.has(run.wave_id)) runsByWave.set(run.wave_id, []);
    runsByWave.get(run.wave_id).push(run);
  }
  const waves = [];
  for (const wave of waveRecords) {
    const runs = runsByWave.get(wave.wave_id) ?? [];
    const transitions = [...wave.transitions].map(t => ({ ...t, time: ms(t.at) })).filter(t => Number.isFinite(t.time)).sort((a, b) => a.time - b.time);
    const phase_seconds = { setup: 0, implementation: 0, review: 0, fix: 0, queued: 0 };
    const queue = { by_reason: {} };
    const memberRows = [];
    for (const member of wave.members) {
      const intervals = memberIntervals(member, wave, now);
      let setup_seconds = 0, queued_seconds = 0, queue_reason = member.queue_reason ?? null;
      for (const interval of intervals) {
        const span = seconds(Math.max(0, interval.end - interval.start));
        if (interval.phase === 'provisioning') { phase_seconds.setup += span; setup_seconds += span; }
        else if (interval.phase === 'implementing') phase_seconds.implementation += span;
        else if (interval.phase === 'reviewing' || interval.phase === 'confirming') phase_seconds.review += span;
        else if (interval.phase === 'fixing') phase_seconds.fix += span;
        else if (interval.phase === 'queued') {
          phase_seconds.queued += span; queued_seconds += span;
          const reason = safeReason(interval.reason);
          addTotals(queue.by_reason, reason, span);
          if (queue_reason === null) queue_reason = reason;
        }
      }
      memberRows.push({ step: member.step, phase: member.phase ?? null, backend: member.backend, fallback_reason: member.fallback_reason,
        setup_seconds, queued_seconds, queue_reason });
    }
    // Peak overlap counts distinct member steps with an overlapping run interval.
    const byStep = new Map();
    for (const run of runs) {
      const step = run.step_number;
      if (!Number.isSafeInteger(step) || step <= 0) continue;
      const start = ms(run.started_at);
      if (!Number.isFinite(start)) continue;
      const finish = Number.isFinite(ms(run.finished_at)) ? ms(run.finished_at) : now;
      if (finish < start) continue;
      if (!byStep.has(step)) byStep.set(step, []);
      byStep.get(step).push([start, finish]);
    }
    const overlapIntervals = [];
    for (const [step, windows] of byStep) for (const [start, finish] of windows) overlapIntervals.push([step, start, finish]);
    const integratedAt = transitions.find(t => t.state === 'integrated');
    const terminalAt = transitions.find(t => TERMINAL_WAVE_STATES.includes(t.state));
    let integration_seconds = 0;
    for (let index = 0; index < transitions.length; index++) {
      if (!['integrating', 'verifying', 'repairing', 'promoting'].includes(transitions[index].state)) continue;
      const end = index + 1 < transitions.length ? transitions[index + 1].time : (terminalAt ? terminalAt.time : now);
      integration_seconds += seconds(Math.max(0, end - transitions[index].time));
    }
    const openedAt = ms(wave.opened_at);
    const storage = await measureStorage(wave);
    waves.push({
      wave_id: wave.wave_id, state: wave.state, record_path: wave.record_path,
      requested_width: wave.requested_width, admitted_width: wave.admitted_width,
      peak_observed_overlap: peakOverlap(overlapIntervals),
      effective_limits: jsonScalar(wave.effective_limits),
      elapsed_accepted_wave_seconds: integratedAt && Number.isFinite(openedAt) ? seconds(integratedAt.time - openedAt) : null,
      elapsed_to_snapshot_seconds: !TERMINAL_WAVE_STATES.includes(wave.state) && Number.isFinite(openedAt) ? seconds(now - openedAt) : null,
      integration_seconds, phase_seconds, queue, members: memberRows, storage });
  }
  const barrier_waits = await computeBarriers({ packagePath, waveRecords, now, errors });
  return { waves, barrier_waits };
}

const jsonScalar = value => value === undefined ? null : value;

// Retention storage: at most 200000 entries per wave, regular files only, lower
// counted once per snapshot_id, merged and work never read.
async function measureStorage(wave) {
  const budget = { entries: 0, truncated: false, unreadable: 0 };
  const seenLower = new Set();
  let lower_bytes = 0, upper_bytes = 0, git_bytes = 0, worktree_bytes = 0;
  for (const member of wave.members) {
    const retained = member.retained;
    if (!retained) continue;
    const key = member.snapshot_id ?? member.upper_id ?? null;
    if (retained.lower && !seenLower.has(key ?? retained.lower)) {
      seenLower.add(key ?? retained.lower);
      lower_bytes += await directoryBytes(retained.lower, budget);
    }
    if (retained.upper) upper_bytes += await directoryBytes(retained.upper, budget);
    if (retained.gitDir) git_bytes += await directoryBytes(retained.gitDir, budget);
    if (retained.worktree) worktree_bytes += await directoryBytes(retained.worktree, budget);
    if (budget.truncated) break;
  }
  return { lower_bytes, upper_bytes, git_bytes, worktree_bytes, truncated: budget.truncated, unreadable: budget.unreadable };
}

// For each prepared step with requires, wait from the latest dependency seal to
// the barrier wave's integrated time, or its first blocked/cancelled terminal
// time, or now when still open. Only durable recorded membership is used.
async function computeBarriers({ packagePath, waveRecords, now, errors }) {
  const stepIndex = await readSpecSteps(packagePath, errors);
  if (!stepIndex.length) return [];
  const sealedBy = new Map();
  for (const wave of waveRecords) for (const member of wave.members) {
    if (member.phase !== 'sealed') continue;
    const transition = [...(member.transitions ?? [])].filter(t => t.phase === 'sealed' && Number.isFinite(ms(t.at)))
      .sort((a, b) => ms(a.at) - ms(b.at)).pop();
    if (!transition) continue;
    const generation = wave.generation ?? 0;
    const openedAt = ms(wave.opened_at) || 0;
    const existing = sealedBy.get(member.step);
    if (!existing || generation > existing.generation || (generation === existing.generation && openedAt > existing.openedAt))
      sealedBy.set(member.step, { time: ms(transition.at), wave, generation, openedAt });
  }
  const barrier_waits = [];
  for (const step of stepIndex) {
    const requires = Array.isArray(step.requires) ? step.requires.filter(dep => Number.isSafeInteger(dep)) : [];
    if (!requires.length) continue;
    const dependencies = requires.map(dep => sealedBy.get(dep));
    if (dependencies.some(dep => !dep)) continue;
    const startedAt = Math.max(...dependencies.map(dep => dep.time));
    const barrierWaves = [...new Set(dependencies.map(dep => dep.wave.wave_id))].sort();
    const barrierRecords = dependencies.map(dep => dep.wave);
    const integratedTimes = barrierRecords.map(wave => wave.transitions.filter(t => t.state === 'integrated').map(t => ms(t.at)).filter(Number.isFinite).pop());
    let ended_at = null, end_reason = 'open';
    if (integratedTimes.every(Number.isFinite)) {
      ended_at = Math.max(...integratedTimes); end_reason = 'integrated';
    } else {
      const terminal = barrierRecords.map(wave => wave.transitions.filter(t => t.state === 'blocked' || t.state === 'cancelled')
        .map(t => ({ state: t.state, time: ms(t.at) })).filter(t => Number.isFinite(t.time)).sort((a, b) => a.time - b.time)[0]).filter(Boolean)
        .sort((a, b) => a.time - b.time)[0];
      if (terminal) { ended_at = terminal.time; end_reason = terminal.state; }
    }
    const ownWave = waveRecords.find(wave => wave.members.some(member => member.step === step.step));
    barrier_waits.push({ step: step.step, wave_id: ownWave?.wave_id ?? null, barrier_wave_ids: barrierWaves,
      started_at: new Date(startedAt).toISOString(), ended_at: ended_at === null ? null : new Date(ended_at).toISOString(),
      waiting_on_barrier_seconds: seconds((ended_at ?? now) - startedAt), end_reason });
  }
  return barrier_waits;
}

async function readSpecSteps(packagePath, errors) {
  let text;
  try { text = await readFile(path.join(packagePath, 'spec-steps.json'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') errors.push({ path: path.join(packagePath, 'spec-steps.json'), code: error.code }); return []; }
  let value;
  try { value = JSON.parse(text); }
  catch { errors.push({ path: path.join(packagePath, 'spec-steps.json'), code: 'INVALID_STEP_INDEX' }); return []; }
  return Array.isArray(value?.steps) ? value.steps.filter(step => step && Number.isSafeInteger(step.step) && step.step > 0) : [];
}

export function formatMetrics(value) {
  const duration = seconds => seconds === null ? '?' : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const lines = [`Spec metrics — ${value.scope}`, `Observed span: ${duration(value.process.observed_span_seconds)} (includes pauses; ${value.process.completion_reported_at ? 'completion reported by coordinator' : 'completion not inferred'})`,
    `Model calls: ${value.totals.model_calls} | Tool calls: ${value.totals.tool_calls} | Test-command submissions: ${value.totals.test_command_calls} (${value.totals.recognized_test_commands} recognized commands)`,
    `Test-command results: ${value.totals.test_command_results} returned; ${value.totals.test_command_failures} failures; ${value.totals.test_commands_with_exit} with structured exit codes (not suite pass counts).`,
    `Reported cost: ${value.totals.reported_cost === null ? 'unknown' : '$' + value.totals.reported_cost.toFixed(4)} (may be partial/unpriced)`, '',
    'Role / model | Model calls | Tool calls | Response time | Test submissions'];
  if (value.startup) lines.push(`Session to first owner: ${duration(value.startup.session_to_first_owner_seconds)}; startup: ${value.startup.model_calls} model responses, ${value.startup.tool_calls} tools (${value.startup.reads} reads/searches, ${value.startup.shell_calls} shell calls).`, `Connection errors: ${value.totals.connection_errors}; timeouts: ${value.totals.timeout_errors}.`);
  for (const m of value.process.milestones ?? []) lines.push(`${m.kind}: ${m.timestamp} (${m.source})`);
  if (value.process.completion_reported_at) lines.push(`Time to reported completion: ${duration(value.process.elapsed_to_completion_report_seconds)}; subsequent activity: ${duration(value.process.post_completion_activity_seconds)}.`);
  for (const a of value.agents) lines.push(`${a.role} / ${a.model} | ${a.model_calls} | ${a.tool_calls} | ${duration(a.timed_model_calls ? a.model_response_seconds : null)} (${a.timed_model_calls}/${a.model_calls} timed) | ${a.test_command_calls}`);
  lines.push('', 'Managed step attempts:');
  for (const s of value.steps) lines.push(`${s.step} / ${s.assignment_id} | ${s.state} | ${duration(s.elapsed_seconds)}${s.elapsed_seconds === null ? `; ${duration(s.elapsed_to_snapshot_seconds)} since start` : ''} | ${s.editor_assignments} editor assignments | owner→editor ${duration(s.first_editor_seconds)} | editor→checkout edit ${duration(s.editor_to_first_checkout_edit_seconds)}`);
  if (value.waves?.length) {
    lines.push('', 'Waves:');
    for (const w of value.waves) lines.push(`Wave ${w.wave_id} ${w.state}: requested ${w.requested_width ?? '?'}, admitted ${w.admitted_width ?? '?'}, peak observed ${w.peak_observed_overlap}; setup ${duration(w.phase_seconds.setup)}, review ${duration(w.phase_seconds.review)}, fix ${duration(w.phase_seconds.fix)}, integration ${duration(w.integration_seconds)}`);
  }
  if (value.barrier_waits?.length) {
    lines.push('', 'Barrier waits:');
    for (const b of value.barrier_waits) lines.push(`Barrier wait: step ${b.step} ${duration(b.waiting_on_barrier_seconds)} (${b.end_reason}; waves ${b.barrier_wave_ids.join(', ')})`);
  }
  lines.push('', `Coverage: ${value.coverage.length} transcripts, ${value.discovery_errors.length} discovery/read issues, ${value.coverage.filter(c => c.truncated).length} truncated.`,
    'Response time is observed model latency, not total agent runtime. Test detection is heuristic. JSON includes coverage and limitations.');
  return lines.join('\n');
}
