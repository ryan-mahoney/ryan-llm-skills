import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activityRecorder, activityDir, createMonitor, renderMonitor } from './monitor.mjs';

const record = { id: 'test-run', package: '/repo/.specs/feature', checkout: '/repo', step: '/repo/.specs/feature/step-002-subspec.md', state: 'running', started_at: '2026-10-05T09:00:00Z' };

test('monitor exposes public focus and file targets, never reasoning, commands, replacements, or provider credentials', () => {
  const saved = [];
  const activity = activityRecorder(record, 'owner', { now: () => 1000, persist: value => saved.push(value) });
  activity.event({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE REASONING' } });
  activity.event({ type: 'tool_execution_start', toolName: 'spec_editor', args: { assignment: 'Resume step 2 in /repo.\nChange: Preserve event handlers; token=SECRET' } });
  assert.equal(saved.at(-1).phase, 'waiting for editor');
  assert.equal(saved.at(-1).hint, 'Preserve event handlers; [redacted]');
  activity.event({ type: 'tool_execution_start', toolName: 'edit', args: { path: '/repo/lib/thread.ex', edits: [{ oldText: 'PRIVATE SOURCE', newText: 'PRIVATE REPLACEMENT' }] } });
  assert.equal(saved.at(-1).activity, 'edit lib/thread.ex');
  activity.event({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'echo PRIVATE COMMAND' } });
  assert.equal(saved.at(-1).activity, 'shell command');
  activity.event({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'upstream timeout token=PRIVATE ERROR' } });
  activity.event({ type: 'tool_execution_start', toolName: 'read', args: { path: '/repo/lib/thread.ex' } });
  assert.equal(saved.at(-1).error, 'provider timeout');
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE|SECRET/);
});

test('render distinguishes waiting from absent events and freezes step duration at completion', () => {
  const now = Date.parse('2026-10-05T09:02:05Z');
  const snapshots = { owner: { run_id: record.id, last_activity: now - 65000, phase: 'waiting for editor', activity: 'spec_editor', hint: 'Restore handlers' } };
  const lines = renderMonitor(record, snapshots, now);
  assert.match(lines[0], /running · elapsed 2m 5s/);
  assert.match(lines[1], /waiting for editor · idle \(no events\) 1m 5s/);
  assert.equal(lines.at(-1), 'editor: no activity reported');
  const done = renderMonitor({ ...record, state: 'completed', finished_at: '2026-10-05T09:01:00Z' }, snapshots, now);
  assert.match(done[0], /completed · elapsed 1m 0s/);
  assert.match(done[1], /last: waiting for editor/);
});

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-monitor-'));
  const current = { ...record, package: dir };
  mkdirSync(join(dir, 'runtime/runs'), { recursive: true });
  writeFileSync(join(dir, 'runtime/runs', `${record.id}.json`), JSON.stringify(current));
  let lines, tick, cleared = 0;
  const renders = [];
  const monitor = createMonitor({ interval: fn => { tick = fn; return {}; }, clear: () => cleared++, ...options });
  const ctx = { hasUI: true, ui: { setWidget: (_key, value) => { lines = value; renders.push(value); }, setStatus() {} } };
  t.after(() => { monitor.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, current, monitor, ctx, renders, lines: () => lines, tick: () => tick(), cleared: () => cleared };
}

test('widget loads bounded role snapshots without model calls and releases timer on hide', t => {
  const f = fixture(t);
  const activity = activityRecorder(f.current, 'editor');
  activity.event({ type: 'tool_execution_start', toolName: 'write', args: { path: '/repo/lib/thread.ex', content: 'SECRET SOURCE' } });
  f.monitor.attach(f.current, f.ctx);
  assert.match(f.lines().join('\n'), /write lib\/thread.ex/);
  assert.doesNotMatch(readFileSync(join(activityDir(f.current), 'editor.json'), 'utf8'), /SECRET SOURCE/);
  f.tick();
  f.monitor.close();
  assert.equal(f.lines(), undefined);
  assert.equal(f.cleared(), 1);
});

test('coalesced directory notifications refresh completion without a filename or polling', async t => {
  const watchers = new Map();
  const f = fixture(t, { watchDirectory: (dir, callback) => {
    watchers.set(dir, callback);
    return { on() {}, close() { watchers.delete(dir); } };
  } });
  f.monitor.attach(f.current, f.ctx);
  const dir = join(f.dir, 'runtime/runs');
  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify({ ...f.current, state: 'completed', finished_at: '2026-10-05T09:01:00Z' }));
  watchers.get(dir)('change', 'runs');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.lines()[0], /completed/);
  assert.equal(f.cleared(), 1);
  assert.equal(watchers.size, 0);
});

test('legacy running streams bootstrap from a bounded tail and update on append without taking ownership', async t => {
  const f = fixture(t);
  const file = join(f.dir, 'runtime/runs', `${record.id}-editor-stream.jsonl`);
  writeFileSync(file, `${'x'.repeat(100000)}\n${JSON.stringify({ type: 'tool_execution_start', toolName: 'edit', args: { path: '/repo/lib/initial.ex' } })}\n`);
  f.monitor.attach(f.current, f.ctx);
  assert.match(f.lines().join('\n'), /edit lib\/initial.ex/);
  let resolveRendered;
  const updated = new Promise(resolve => { resolveRendered = resolve; });
  f.ctx.ui.setWidget = (_key, value) => { if (value?.join('\n').includes('read lib/next.ex')) resolveRendered(); };
  appendFileSync(file, `${JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: '/repo/lib/next.ex' } })}\n`);
  await Promise.race([updated, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('watcher did not render appended activity')), 2000); timer.unref(); })]);
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'runtime/runs', `${record.id}.json`), 'utf8')).state, 'running');
});

test('completion stops updates and labels stale worker phases as historical', async t => {
  const f = fixture(t);
  activityRecorder(f.current, 'owner').event({ type: 'tool_execution_start', toolName: 'spec_editor', args: { assignment: 'Restore handlers' } });
  f.monitor.attach(f.current, f.ctx);
  let resolveRendered;
  const completed = new Promise(resolve => { resolveRendered = resolve; });
  f.ctx.ui.setWidget = (_key, value) => { if (value?.[0].includes('completed')) resolveRendered(value); };
  const receipt = join(f.dir, 'runtime/runs', `${record.id}.json`);
  writeFileSync(`${receipt}.tmp`, JSON.stringify({ ...f.current, state: 'completed', finished_at: '2026-10-05T09:01:00Z' }));
  renameSync(`${receipt}.tmp`, receipt);
  const lines = await Promise.race([completed, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('completion not rendered')), 2000); timer.unref(); })]);
  assert.match(lines[1], /last: waiting for editor/);
  assert.equal(f.cleared(), 1);
});
