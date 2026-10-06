import { mkdirSync, writeFileSync, renameSync, readFileSync, statSync, watch, readdirSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const roles = ['owner', 'editor'];
export const activityDir = record => join(record.package, 'runtime/runs', `${record.id}-activity`);

// Only public prose is eligible. Never pass reasoning, tool output, source, or shell
// arguments here. These bounded hints are observational, not acceptance evidence.
export function publicHint(value) {
  if (typeof value !== 'string') return '';
  const labeled = value.match(/(?:^|\n)\s*Change\s*:\s*([^\n]+)/i) || value.match(/(?:one|next) coherent transformation\s*:\s*([^\n]+)/i);
  let inCode = false;
  const line = labeled?.[1] || value.split(/\r?\n/).find(text => {
    if (/^\s*```/.test(text)) { inCode = !inCode; return false; }
    return !inCode && text.trim() && !/^\s*([{}<>]|(?:const|let|function|def|defmodule|import|export)\b)/.test(text);
  }) || '';
  return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/\b(?:bearer\s+\S+|(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*\S+)/gi, '[redacted]')
    .replace(/\b(?:sk-|gh[pousr]_)[\w-]+/g, '[redacted]')
    .replace(/`[^`]*`/g, '[code]').replace(/\s+/g, ' ').trim().slice(0, 160);
}
function fileHint(path, checkout) {
  if (typeof path !== 'string') return '';
  const rel = path.startsWith('/') ? relative(checkout, path) : path;
  return publicHint(rel.startsWith('..') ? basename(path) : rel);
}
function errorKind(text) {
  if (/connection|websocket|ECONN|ENOTFOUND|fetch failed|network/i.test(text || '')) return 'connection error (preserve work; transport recovery)';
  if (/timeout|timed out|idle/i.test(text || '')) return 'provider timeout';
  if (/429|rate.limit/i.test(text || '')) return 'provider rate limit';
  return 'provider/process error (details in run log)';
}

// One writer per role: the process launching that role. Throttle token-stream
// heartbeats, while retaining every tool boundary. Atomic tiny snapshots bound
// disk and resume costs regardless of assignment length.
export function activityRecorder(record, role, { now = Date.now, persist } = {}) {
  const dir = activityDir(record);
  const file = join(dir, `${role}.json`);
  const save = persist || (value => {
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
      renameSync(tmp, file);
    } catch { /* Observation must never fail or cancel code execution. */ }
  });
  let state = { run_id: record.id, role, started_at: now(), last_activity: now(), phase: 'starting', activity: 'starting worker' };
  let lastSave = 0;
  const update = (patch, force = true) => {
    state = { ...state, ...patch, last_activity: now() };
    if (force || now() - lastSave >= 1000) { save(state); lastSave = now(); }
  };
  save(state);
  return {
    event(value) {
      if (value.type === 'message_update') {
        // Even thinking deltas indicate activity, but no thinking text is read.
        update({ phase: 'responding', activity: 'generating response' }, false);
      } else if (value.type === 'message_start' && value.message?.role === 'assistant') {
        update({ phase: 'responding', activity: 'awaiting model response' });
      } else if (value.type === 'message_end' && value.message?.role === 'assistant') {
        const message = value.message;
        const hint = publicHint((message.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'));
        update({ ...(hint ? { hint } : {}), ...(message.stopReason === 'error' || message.stopReason === 'aborted' ? { error: errorKind(message.errorMessage), phase: 'error' } : {}) });
      } else if (value.type === 'tool_execution_start') {
        const tool = value.toolName;
        const args = value.args || {};
        const target = ['read', 'write', 'edit', 'grep', 'find', 'ls'].includes(tool) ? fileHint(args.path, record.checkout) : '';
        const phase = tool === 'spec_editor' || tool === 'spec_answer' ? 'waiting for editor' : tool === 'spec_question' ? 'waiting for owner' : 'using tool';
        const label = tool === 'bash' ? 'shell command' : ['read', 'write', 'edit', 'grep', 'find', 'ls', 'spec_editor', 'spec_answer', 'spec_question'].includes(tool) ? tool : 'tool';
        const hint = tool === 'spec_editor' ? publicHint(args.assignment) : tool === 'spec_answer' ? publicHint(args.answer) : tool === 'spec_question' ? publicHint(args.question) : '';
        update({ phase, activity: `${label}${target ? ` ${target}` : ''}`, ...(hint ? { hint } : {}) });
      } else if (value.type === 'tool_execution_end') {
        const details = value.result?.details;
        const error = value.isError || value.result?.isError || details?.error || details?.result?.error;
        update({ phase: details?.state === 'needs_decision' ? 'deciding editor question' : 'responding', activity: error ? 'tool failed; inspecting result' : 'assessing tool result', ...(error ? { error: 'tool error (details in run log)' } : {}) });
      } else if (value.type === 'tool_execution_update') {
        update({}, false);
      }
    },
    finish(error) { update({ phase: error ? 'failed' : 'returned', activity: error ? 'worker failed' : 'returned to coordinator', ...(error ? { error: errorKind(error) } : {}) }); },
  };
}

function boundedJson(file) {
  if (statSync(file).size > 32768) throw new Error('Oversized monitor record');
  return JSON.parse(readFileSync(file, 'utf8'));
}
const duration = ms => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
export function renderMonitor(record, snapshots, now = Date.now(), note = '') {
  const end = terminal.has(record.state) ? Date.parse(record.finished_at) || now : now;
  const lines = [`Spec ${publicHint(basename(record.step))} · ${record.state} · elapsed ${duration(end - Date.parse(record.started_at))}`];
  for (const role of roles) {
    const state = snapshots[role];
    if (!state || state.run_id !== record.id) { lines.push(`${role}: no activity reported`); continue; }
    const phase = terminal.has(record.state) ? `last: ${state.phase}` : state.phase;
    const stopped = ['returned', 'failed'].includes(state.phase) || terminal.has(record.state);
    lines.push(`${role}: ${publicHint(phase)} · ${stopped ? 'last event' : 'idle (no events)'} ${duration((stopped ? end : now) - state.last_activity)} ago · ${publicHint(state.activity)}`);
    if (state.hint) lines.push(`  ${role === 'owner' ? 'Owner focus' : 'Editor update'}: ${publicHint(state.hint)}`);
    if (state.error) lines.push(`  Last observed error: ${publicHint(state.error)}`);
  }
  if (note) lines.push(note);
  return lines;
}

// fs.watch refreshes tiny snapshots; the timer changes durations only. No model
// messages, commands, transcript polling, or process-liveness probes.
export function createMonitor({ interval = setInterval, clear = clearInterval, now = Date.now, watchDirectory = watch } = {}) {
  let ctx, record, timer, pendingRefresh, watchers = [], activityWatched = false, snapshots = {}, tails = {}, nativeRoles = new Set(), note = '';
  const render = () => {
    if (!ctx?.hasUI || !record) return;
    ctx.ui.setWidget('spec-runtime', renderMonitor(record, snapshots, now(), note));
    ctx.ui.setStatus('spec-runtime', `spec ${record.state} · ${duration((Date.parse(record.finished_at) || now()) - Date.parse(record.started_at))}`);
  };
  const close = () => { watchers.forEach(w => w.close()); watchers = []; activityWatched = false; if (timer) clear(timer); timer = undefined; clearImmediate(pendingRefresh); pendingRefresh = undefined; };
  const scheduleRefresh = () => {
    pendingRefresh ||= setImmediate(() => { pendingRefresh = undefined; refresh(); });
  };
  const addWatcher = dir => {
    const watcher = watchDirectory(dir, (event, name) => {
      // Directory watchers may coalesce writes into a directory-level notification
      // rather than naming the final receipt, especially during concurrent activity.
      if (!name || name === basename(dir) || event === 'rename' || name === `${record.id}.json` || name === `${record.id}-activity` || roles.some(role => name === `${role}.json` || (!nativeRoles.has(role) && name.startsWith(`${record.id}-${role}-`) && name.endsWith('.jsonl')))) scheduleRefresh();
    });
    watcher.on('error', () => { note = 'Activity watcher unavailable; showing last observed state.'; render(); });
    watchers.push(watcher);
  };
  const readLegacyActivity = role => {
    const dir = join(record.package, 'runtime/runs');
    const files = readdirSync(dir).filter(name => name.startsWith(`${record.id}-${role}-`) && name.endsWith('.jsonl'));
    const latest = files.map(name => ({ path: join(dir, name), stat: statSync(join(dir, name)) })).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
    if (!latest) return;
    let tail = tails[role];
    if (!tail || tail.path !== latest.path || latest.stat.size < tail.offset) {
      tail = tails[role] = { path: latest.path, offset: Math.max(0, latest.stat.size - 65536), pending: '', clock: latest.stat.mtimeMs };
      tail.skip = tail.offset > 0;
      let initialized = false;
      tail.recorder = activityRecorder(record, role, { now: () => tail.clock, persist: value => { if (initialized) snapshots[role] = value; } });
      initialized = true;
    }
    if (latest.stat.size === tail.offset) return;
    tail.clock = latest.stat.mtimeMs;
    if (latest.stat.size - tail.offset > 65536) { tail.offset = latest.stat.size - 65536; tail.pending = ''; tail.skip = true; }
    const buffer = Buffer.alloc(latest.stat.size - tail.offset);
    const fd = openSync(tail.path, 'r');
    let bytes;
    try { bytes = readSync(fd, buffer, 0, buffer.length, tail.offset); } finally { closeSync(fd); }
    tail.offset += bytes;
    tail.pending += buffer.subarray(0, bytes).toString('utf8');
    let newline;
    while ((newline = tail.pending.indexOf('\n')) >= 0) {
      const line = tail.pending.slice(0, newline); tail.pending = tail.pending.slice(newline + 1);
      if (tail.skip) { tail.skip = false; continue; }
      try { tail.recorder.event(JSON.parse(line)); } catch { /* Incomplete/oversized legacy events have no inferred content. */ }
    }
  };
  const refresh = () => {
    if (!activityWatched && existsSync(activityDir(record))) {
      try { addWatcher(activityDir(record)); activityWatched = true; } catch { note = 'Activity watcher unavailable; showing last observed state.'; }
    }
    try { const current = boundedJson(join(record.package, 'runtime/runs', `${record.id}.json`)); if (current.id === record.id) record = current; } catch { note = 'Run receipt unavailable; showing last observed state.'; }
    for (const role of roles) {
      try { const next = boundedJson(join(activityDir(record), `${role}.json`)); if (next.run_id === record.id) { snapshots[role] = next; nativeRoles.add(role); } }
      catch { try { readLegacyActivity(role); } catch { /* Unavailable logs have no inferred activity or liveness. */ } }
    }
    if (terminal.has(record.state)) close();
    render();
  };
  return {
    attach(next, context) {
      close(); ctx?.ui?.setWidget('spec-runtime', undefined); ctx?.ui?.setStatus('spec-runtime', undefined);
      ctx = context; record = next; snapshots = {}; tails = {}; nativeRoles = new Set(); note = '';
      if (!ctx?.hasUI) return;
      try {
        addWatcher(join(record.package, 'runtime/runs'));
      } catch { note = 'Activity watcher unavailable; showing last observed state.'; }
      timer = interval(render, 1000); timer.unref?.(); refresh();
    },
    close() { close(); ctx?.ui?.setWidget('spec-runtime', undefined); ctx?.ui?.setStatus('spec-runtime', undefined); record = undefined; },
    // Read-only identity of the currently displayed record, so other widgets
    // can collapse only genuinely redundant rows.
    currentRun() { return record ?? null; },
  };
}
