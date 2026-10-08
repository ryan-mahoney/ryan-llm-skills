import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSentinelObserver } from './sentinel.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-lifecycle-'));
  const commands = new Map(), repeats = new Set(), watches = new Set();
  const calls = { reads: 0, stopped: 0, dashboards: 0, modes: [], revocations: 0 };
  let pending = null, readError = null, mode = null, failStop = false;
  const reader = {
    async read(options) {
      calls.reads++;
      if (pending) await pending;
      if (readError) throw readError;
      return { snapshot: { version: 1, workspace: 'fixture', runs: [], spec_roots: [join(dir, '.specs')],
        coverage: { state: 'complete', reasons: [], observed_at: new Date().toISOString() },
        activity_filter: { window_ms: 86400000, hidden_packages: options.includeInactive ? 0 : 2 } },
      roots: [dir], discovery: { reasons: [] }, enrollmentErrors: [] };
    },
    watch(targets) { targets.forEach(target => watches.add(target)); },
    async stop() {
      await Promise.resolve(); calls.stopped++; watches.clear();
      if (failStop) { failStop = false; throw new Error('fixture cleanup failed'); }
    },
  };
  const dashboard = { url: null,
    async start() { calls.dashboards++; this.url = 'http://127.0.0.1:1234/'; return { url: this.url }; },
    stop() { this.url = null; },
  };
  const observer = createSentinelObserver({ pi: { registerCommand: (name, command) => commands.set(name, command.handler) },
    context: { hasUI: true, ui: {} }, agentDir: dir, isolateReader: true, readerFactory: () => reader, dashboard,
    repeat: callback => { repeats.add(callback); return callback; }, cancelRepeat: callback => repeats.delete(callback),
    startMode: async options => { calls.modes.push(options.mode); mode = { options }; },
    stopMode: async () => { mode = null; calls.revocations++; }, modeStatus: () => mode });
  t.after(async () => { await observer.close(); rmSync(dir, { recursive: true, force: true }); });
  return { observer, commands, calls, repeats, watches, dashboard,
    hold() { let release; pending = new Promise(resolve => { release = resolve; }); return () => { release(); pending = null; }; },
    fail() { readError = new Error('fixture read unavailable'); },
    failCleanup() { failStop = true; } };
}

test('cold and off status are bounded one-shot reads with awaited helper cleanup', async t => {
  const f = fixture(t);
  const cold = await f.commands.get('sentinel')('status');
  assert.equal(cold.state, 'inactive');
  assert.equal(cold.runs_count, 0);
  assert.equal(f.calls.reads, 1);
  assert.equal(f.calls.stopped, 1);
  assert.equal(cold.snapshot_path, null);
  assert.equal(existsSync(f.observer.snapshotPath), false);
  assert.equal(f.repeats.size, 0);
  assert.equal(f.watches.size, 0);
  assert.equal(f.calls.dashboards, 0);
  await f.observer.lifecycle({ action: 'off' });
  const stopped = f.calls.stopped;
  const off = await f.observer.lifecycle({ action: 'status' });
  assert.equal(off.state, 'off');
  assert.equal(f.calls.stopped, stopped + 1);
  assert.equal(f.repeats.size, 0);
  assert.equal(f.calls.dashboards, 0);
  assert.equal(existsSync(f.observer.snapshotPath), false);
});

test('active status and all-history preserve monitoring and the live export', async t => {
  const f = fixture(t);
  const started = await f.observer.lifecycle({ action: 'observe' });
  assert.equal(started.state, 'observing');
  assert.equal(f.repeats.size, 1);
  assert.equal(f.watches.size, 1);
  const handles = [...f.repeats];
  const stopped = f.calls.stopped;
  await f.commands.get('sentinel')('status');
  assert.deepEqual([...f.repeats], handles);
  assert.equal(f.calls.stopped, stopped);
  assert.equal(f.calls.dashboards, 1);
  const live = readFileSync(f.observer.snapshotPath, 'utf8');
  await f.observer.lifecycle({ action: 'status', include_inactive: true });
  assert.equal(readFileSync(f.observer.snapshotPath, 'utf8'), live);
  f.fail();
  const failed = await f.commands.get('spec-sentinel')('status --all');
  assert.equal(failed.coverage.state, 'stale');
  assert.equal(readFileSync(f.observer.snapshotPath, 'utf8'), live, 'failed history reads also cannot overwrite live facts');
  assert.deepEqual([...f.repeats], handles);
});

test('native aliases and tool share lifecycle while tool cannot arm recovery', async t => {
  const f = fixture(t);
  assert.equal(f.commands.get('sentinel'), f.commands.get('spec-sentinel'));
  assert.equal((await f.commands.get('sentinel')('start')).state, 'observing');
  assert.equal((await f.observer.lifecycle({ action: 'status' })).state, 'observing');
  assert.equal((await f.commands.get('spec-sentinel')('stop')).state, 'off');
  assert.equal(f.repeats.size, 0);
  assert.equal(f.watches.size, 0);
  assert.equal((await f.observer.lifecycle({ action: 'observe' })).state, 'observing');
  const forbidden = await f.observer.lifecycle({ action: 'recover' });
  assert.match(forbidden.error, /native/);
  assert.deepEqual(f.calls.modes, []);
  await f.commands.get('sentinel')('shadow');
  assert.deepEqual(f.calls.modes, ['shadow']);
  await f.commands.get('spec-sentinel')('recover');
  assert.deepEqual(f.calls.modes, ['shadow', 'recover']);
  await f.observer.lifecycle({ action: 'off' });
  assert.equal(f.repeats.size, 0);
  assert.equal(f.watches.size, 0);
  assert.equal(f.dashboard.url, null);
});

test('off during a pending cold status cannot leave a helper or activate monitoring', async t => {
  const f = fixture(t), release = f.hold();
  const status = f.observer.lifecycle({ action: 'status' });
  await f.commands.get('sentinel')('off');
  release();
  assert.equal((await status).state, 'off');
  assert.equal(f.repeats.size, 0);
  assert.equal(f.watches.size, 0);
  assert.equal(f.calls.dashboards, 0);
  assert.equal(existsSync(f.observer.snapshotPath), false);
});

test('start during a pending cold read performs a fresh active read after it settles', async t => {
  const f = fixture(t), release = f.hold();
  const status = f.observer.lifecycle({ action: 'status' });
  const starting = f.commands.get('sentinel')('start');
  release();
  await status;
  assert.equal((await starting).state, 'observing');
  assert.equal(f.calls.reads, 2);
  assert.equal(f.repeats.size, 1);
  assert.equal(f.watches.size, 1);
  assert.equal(existsSync(f.observer.snapshotPath), true);
});

test('cleanup failure remains explicit and cannot poison subsequent status reads', async t => {
  const f = fixture(t);
  f.failCleanup();
  const failed = await f.observer.lifecycle({ action: 'status' });
  assert.match(failed.error, /cleanup failed/);
  const recovered = await f.commands.get('sentinel')('status');
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.state, 'inactive');
  assert.equal(f.calls.reads, 2);
  assert.equal(f.calls.stopped, 2);
});
