import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSentinelObserver } from './sentinel.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-lifecycle-'));
  const commands = new Map(), repeats = new Set(), watches = new Set();
  const calls = { reads: 0, stopped: 0, dashboards: 0, modes: [], revocations: 0, readOptions: [] };
  let pending = null, readError = null, mode = null, failStop = false;
  const reader = {
    async read(options) {
      calls.reads++;
      calls.readOptions.push(options);
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
    context: { hasUI: true, ui: {} }, agentDir: dir, storageRoot: join(dir, 'storage'), isolateReader: true, readerFactory: () => reader, dashboard,
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
  assert.equal(typeof f.calls.readOptions[0].storageRoot, 'string', 'the temp storage root crosses as a string');
  assert.equal(Object.values(f.calls.readOptions[0]).some(value => typeof value === 'function'), false,
    'no function-valued option is serialized into reader options');
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

function observeFixture(t, { headless = true, hasUI = !headless, dashboard = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-observe-'));
  const repeats = new Set(), watches = new Set();
  const calls = { reads: 0, stopped: 0, commands: 0, readOptions: [] };
  const reader = {
    async read(options) {
      calls.reads++;
      calls.readOptions.push(options);
      return { snapshot: { version: 1, workspace: 'headless-fixture', runs: [], spec_roots: [join(dir, '.specs')],
        coverage: { state: 'complete', reasons: [], observed_at: new Date().toISOString() },
        activity_filter: { window_ms: 86400000, hidden_packages: options.includeInactive ? 0 : 2 } },
      roots: [dir], discovery: { reasons: [] }, enrollmentErrors: [] };
    },
    watch(targets) { targets.forEach(target => watches.add(target)); },
    async stop() { await Promise.resolve(); calls.stopped++; watches.clear(); },
  };
  const service = dashboard ?? { url: null,
    async start() { this.url = 'http://127.0.0.1:1234/'; return { url: this.url }; },
    stop() { this.url = null; },
  };
  const observer = createSentinelObserver({
    pi: { registerCommand: () => { calls.commands++; } }, context: { hasUI }, agentDir: dir, storageRoot: join(dir, 'storage'),
    isolateReader: true, readerFactory: () => reader, dashboard: service, headless,
    repeat: callback => { callback.unref = () => { callback.unrefs = (callback.unrefs ?? 0) + 1; }; repeats.add(callback); return callback; },
    cancelRepeat: callback => repeats.delete(callback),
  });
  t.after(async () => { await observer.close(); rmSync(dir, { recursive: true, force: true }); });
  return { observer, calls, repeats, watches, dashboard: service };
}

test('headless observer with no pi or UI starts a referenced interval and dashboard and publishes twice', async t => {
  const f = observeFixture(t, { headless: true, hasUI: false });
  const receipt = await f.observer.lifecycle({ action: 'observe' });
  assert.equal(receipt.state, 'observing');
  assert.equal(receipt.dashboard_state, 'ready');
  assert.equal(receipt.dashboard_url, 'http://127.0.0.1:1234/');
  assert.equal(f.calls.commands, 0, 'headless registers no Pi commands');
  assert.equal(f.repeats.size, 1, 'headless keeps the existing reconcile interval');
  const trigger = [...f.repeats][0];
  assert.equal(trigger.unrefs, undefined, 'the headless interval stays referenced');
  const before = f.calls.reads;
  await trigger();
  assert.ok(f.calls.reads > before, 'the first timer trigger reads and publishes');
  await trigger();
  assert.ok(f.calls.reads > before + 1, 'the second timer trigger publishes again');
  assert.equal(JSON.parse(readFileSync(f.observer.snapshotPath, 'utf8')).snapshot.workspace, 'headless-fixture');
});

test('headless observe settles a truthful ready or unavailable dashboard receipt while observation continues', async t => {
  const ready = observeFixture(t, { headless: true, hasUI: false });
  assert.equal((await ready.observer.lifecycle({ action: 'observe' })).dashboard_state, 'ready');
  const starts = [];
  const failing = { url: null,
    async start() { starts.push('start'); throw new Error('fixture dashboard unavailable'); },
    stop() { this.url = null; },
  };
  const unavailable = observeFixture(t, { headless: true, hasUI: false, dashboard: failing });
  const failedReceipt = await unavailable.observer.lifecycle({ action: 'observe' });
  assert.equal(starts.length, 1);
  assert.equal(failedReceipt.state, 'observing');
  assert.equal(failedReceipt.dashboard_state, 'pending-or-unavailable');
  assert.equal(failedReceipt.dashboard_url, null);
  const before = unavailable.calls.reads;
  await [...unavailable.repeats][0]();
  assert.ok(unavailable.calls.reads > before, 'observation continues after dashboard failure');
});

test('headless observe cancelled by off during pending dashboard startup returns fenced without a forced read', async t => {
  let releaseStart;
  const gate = new Promise(resolve => { releaseStart = resolve; });
  let starts = 0;
  const deferred = { url: null,
    async start() { starts++; await gate; this.url = 'http://127.0.0.1:1234/'; return { url: this.url }; },
    stop() { this.url = null; },
  };
  const f = observeFixture(t, { headless: true, hasUI: false, dashboard: deferred });
  const observing = f.observer.lifecycle({ action: 'observe' });
  // Drain microtasks so observe parks on the pending dashboard activation.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  const off = await f.observer.lifecycle({ action: 'off' });
  assert.equal(off.state, 'off');
  releaseStart();
  const receipt = await observing;
  assert.equal(receipt.fenced, true);
  assert.equal(receipt.state, 'off');
  assert.equal(f.calls.reads, 0, 'no forced reader read/helper may fork after off cleanup');
  assert.equal(f.repeats.size, 0);
  assert.equal(f.watches.size, 0);
});

test('headless observer refuses authority callbacks and shadow or recover lifecycle actions', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-headless-authority-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { pi: { registerCommand: () => { throw new Error('headless must not register commands'); } },
    context: { hasUI: false }, agentDir: dir, storageRoot: join(dir, 'storage'), isolateReader: true,
    readerFactory: () => ({ read: async () => ({}), watch() {}, stop: async () => {} }) };
  for (const callback of [{ startMode: async () => {} }, { stopMode: async () => {} }, { enablePolicy: () => {} }, { disablePolicy: () => {} }])
    assert.throws(() => createSentinelObserver({ ...base, headless: true, ...callback }), /cannot carry authority callbacks/);
  const f = observeFixture(t, { headless: true, hasUI: false });
  assert.match((await f.observer.lifecycle({ action: 'shadow' })).error, /native/);
  assert.match((await f.observer.lifecycle({ action: 'recover' })).error, /native/);
  assert.equal(f.calls.commands, 0);
});

test('assignment reader: observer default root resolves once', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-default-root-'));
  const previous = process.env.ADJACENT_STORAGE_ROOT;
  t.after(() => {
    if (previous === undefined) delete process.env.ADJACENT_STORAGE_ROOT;
    else process.env.ADJACENT_STORAGE_ROOT = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const originalRoot = join(dir, 'original-storage');
  process.env.ADJACENT_STORAGE_ROOT = originalRoot;
  const captured = [];
  const observer = createSentinelObserver({
    pi: { registerCommand: () => {} }, context: { hasUI: true, ui: {} }, agentDir: dir, isolateReader: true,
    readerFactory: () => ({
      async read(options) {
        captured.push(options);
        return { snapshot: { version: 1, workspace: 'default-root', runs: [], assignments: [],
          assignment_coverage: { state: 'unavailable', reasons: [], observed_at: new Date().toISOString() },
          coverage: { state: 'complete', reasons: [], observed_at: new Date().toISOString() } },
        roots: [], discovery: { reasons: [] }, enrollmentErrors: [] };
      },
      watch() {}, stop: async () => {},
    }),
    repeat: () => () => {}, cancelRepeat: () => {},
  });
  t.after(() => observer.close());
  process.env.ADJACENT_STORAGE_ROOT = join(dir, 'changed-storage');
  await observer.lifecycle({ action: 'status' });
  assert.ok(captured.length > 0);
  assert.equal(captured[0].storageRoot, originalRoot, 'the construction-time root is captured once');
  assert.equal(typeof captured[0].storageRoot, 'string');
  assert.equal(Object.values(captured[0]).some(value => typeof value === 'function'), false,
    'no function-valued option crosses into reader options');
  const { resolveStorageRoot } = await import('../../../scripts/workspaces/store.mjs');
  assert.equal(resolveStorageRoot({}, join(dir, 'home')), join(dir, 'home', 'Documents', 'adjacent-storage'));
});

test('assignment reader: native inspect requires exact full id (mock presentation/plumbing only)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-inspect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fullId = '11111111-1111-4111-8111-111111111111';
  const otherId = '22222222-2222-4222-8222-222222222222';
  // Mock reader proves option plumbing and inspect presentation only; real IPC
  // parity is covered by the reader-process test.
  const rows = [
    { assignment_id: fullId, display: 'unknown', recordedState: 'live', observedState: 'live', coverage: 'partial',
      coverageReasons: ['probe-unavailable'], attention: ['terminal observation is unknown'], quiet: false,
      attachedCount: null, hasControl: false, safeAction: 'Fix probe; no relaunch', nextAction: 'Fix probe; no relaunch' },
    { assignment_id: otherId, display: 'launching', recordedState: 'launching', observedState: 'launching', coverage: 'complete',
      coverageReasons: [], attention: [], quiet: false, attachedCount: null, hasControl: false, safeAction: 'Wait', nextAction: 'Wait' },
  ];
  let handler = null;
  const notices = [];
  const observer = createSentinelObserver({
    pi: { registerCommand: (name, command) => { handler = command.handler; } },
    context: { hasUI: true, ui: { notify: message => notices.push(String(message)) } },
    agentDir: dir, storageRoot: join(dir, 'storage'), isolateReader: true,
    readerFactory: () => ({
      async read() {
        return { snapshot: { version: 1, workspace: 'inspect', runs: [], assignments: rows,
          assignment_coverage: { state: 'partial', reasons: [], omitted: 0, observed_at: new Date().toISOString() },
          coverage: { state: 'complete', reasons: [], observed_at: new Date().toISOString() } },
        roots: [], discovery: { reasons: [] }, enrollmentErrors: [] };
      },
      watch() {}, stop: async () => {},
    }),
    repeat: () => () => {}, cancelRepeat: () => {},
  });
  t.after(() => observer.close());
  notices.length = 0;
  await handler('inspect ' + fullId);
  const fullText = notices.join('\n');
  assert.ok(fullText.includes(fullId), 'the selected full-id assignment row is displayed');
  assert.equal(fullText.includes(otherId), false, 'only the selected row is displayed');
  assert.match(fullText, /control: none/);
  assert.match(fullText, /Fix probe; no relaunch/);
  notices.length = 0;
  await handler('inspect ' + fullId.slice(0, 8));
  assert.equal(notices.join('\n').includes(fullId), false, 'a short prefix never matches an assignment row');
});

// Mock-scope retention regression: this proves the stale-retention merge of
// fresh assignment facts, not real runtime reachability.
test('assignment reader: stale run retention preserves fresh assignment observations', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-retention-'));
  const fullId = '11111111-1111-4111-8111-111111111111';
  const observedAt = new Date().toISOString();
  const firstRun = { assignment_id: fullId, package: join(dir, '.specs', 'retention'),
    repository: join(dir, '.git'), checkout: dir, workflow_id: 'retention-workflow',
    execution: 'running', conditions: [], workflow_workers: [], actions: [], incidents: [],
    source_paths: [], source_hashes: [], observed_at: observedAt,
    coverage: { state: 'complete', reasons: [], observed_at: observedAt } };
  const firstRow = { assignment_id: fullId, display: 'unknown', recordedState: 'live', observedState: 'live',
    coverage: 'partial', coverageReasons: ['probe-unavailable'], attention: [], quiet: false, hasControl: false,
    safeAction: 'Fix probe; no relaunch', nextAction: 'Fix probe; no relaunch' };
  const freshRow = { assignment_id: fullId, display: 'terminal-lost', recordedState: 'live', observedState: 'live',
    coverage: 'partial', coverageReasons: ['probe-unavailable'], attention: [], quiet: false, hasControl: false,
    safeAction: 'Do not relaunch. The agent is still running without a terminal.',
    nextAction: 'Do not relaunch. The agent is still running without a terminal.' };
  const responses = [
    { snapshot: { version: 1, workspace: 'retention', runs: [firstRun], assignments: [firstRow],
      assignment_coverage: { state: 'complete', reasons: [], omitted: 0, observed_at: observedAt },
      coverage: { state: 'complete', reasons: [], observed_at: observedAt },
      activity_filter: { window_ms: null, hidden_packages: 0 } },
    roots: [dir], discovery: { reasons: [] }, enrollmentErrors: [] },
    { snapshot: { version: 1, workspace: 'retention', runs: [], assignments: [freshRow],
      assignment_coverage: { state: 'complete', reasons: [], omitted: 0, observed_at: observedAt },
      coverage: { state: 'unavailable', reasons: ['storage-missing_root'], observed_at: observedAt },
      activity_filter: { window_ms: null, hidden_packages: 0 } },
    roots: [], discovery: { reasons: [] }, enrollmentErrors: [{ path: dir, code: 'ENROLLMENT_INVALID' }] },
    () => { throw new Error('fixture read unavailable'); },
  ];
  let call = 0;
  const reader = {
    async read() {
      call += 1;
      const next = responses[call - 1];
      if (typeof next === 'function') return next();
      return next;
    },
    watch() {}, stop: async () => {},
  };
  const observer = createSentinelObserver({
    pi: { registerCommand: () => {} }, context: { hasUI: true, ui: {} }, agentDir: dir,
    storageRoot: join(dir, 'storage'), isolateReader: true, readerFactory: () => reader, headless: true,
    repeat: callback => callback, cancelRepeat: () => {},
  });
  t.after(async () => { await observer.close(); rmSync(dir, { recursive: true, force: true }); });

  const initial = await observer.lifecycle({ action: 'observe' });
  assert.equal(initial.error, undefined, `initial lifecycle failed: ${initial.error}`);
  assert.equal(initial.state, 'observing');
  assert.equal(initial.runs_count, 1);

  // The second read loses run facts but carries a fresh assignment observation:
  // run facts stay stale while the assignment row and coverage are replaced.
  const retained = await observer.lifecycle({ action: 'status' });
  const retainedText = retained.lines.join('\n');
  assert.equal(retained.coverage.state, 'stale', 'run coverage is retained as stale');
  assert.equal(retained.runs_count, 1, 'the old run row is retained');
  assert.ok(retainedText.includes(fullId));
  assert.ok(retainedText.includes('terminal-lost'), 'the fresh assignment display is used');
  assert.ok(retainedText.includes('Assignments: coverage complete'), 'fresh assignment coverage is used');

  // The third read throws: retained assignment coverage degrades to stale while
  // the retained row and its no-relaunch guidance are unchanged.
  const degraded = await observer.lifecycle({ action: 'status' });
  const degradedText = degraded.lines.join('\n');
  assert.ok(degradedText.includes('Assignments: coverage stale'), 'retained assignment coverage is marked stale');
  assert.ok(degradedText.includes(fullId));
  assert.ok(degradedText.includes('Do not relaunch'), 'the retained row keeps its no-relaunch guidance');
});

test('ordinary observer without UI stays inert and keeps the interval and dashboard gated by UI', async t => {
  const f = observeFixture(t, { headless: false, hasUI: false });
  const receipt = await f.observer.lifecycle({ action: 'observe' });
  assert.equal(receipt.state, 'observing');
  assert.equal(receipt.dashboard_state, 'inactive');
  assert.equal(receipt.dashboard_url, null);
  assert.equal(f.repeats.size, 0);
  assert.equal(f.watches.size, 1);
  assert.equal(f.dashboard.url, null);
});
