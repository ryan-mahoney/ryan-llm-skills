import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync, statSync, renameSync, unlinkSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createSentinelObserver, SENTINEL_COALESCE_MS, SENTINEL_RECONCILE_MS, SENTINEL_WIDGET_KEY, readCheckpointRecord, recordCheckpoint, createSentinelAuthority, activatePolicy, createDiagnosisController, readDiagnosisAttempt } from './sentinel.mjs';
import { canonicalPackage } from './runtime.mjs';
import { enrollmentDirectory, workspaceKey } from '../../../scripts/spec-observe/sentinel.mjs';

// workspaceKey documents the same agentDir/scope hash the enrollment directory
// uses; enrollmentDirectory alone locates the workspace records.

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, 'index.ts');
const cliPath = join(here, '../../../scripts/spec-observe/cli.mjs');

// The installed SDK is the only loader for the real index.ts; without it the
// composition cases cannot run and say so instead of guessing.
let sdk;
try {
  const bin = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
  const sdkRoot = dirname(dirname(dirname(realpathSync(bin))));
  const entry = join(sdkRoot, 'dist', 'index.js');
  const aiEntry = join(sdkRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js');
  if (existsSync(entry) && existsSync(aiEntry)) {
    sdk = {
      ...(await import(pathToFileURL(entry).href)),
      ai: await import(pathToFileURL(aiEntry).href),
    };
  }
} catch { /* No installed SDK: SDK-dependent cases skip. */ }
const sdkSkip = sdk ? false : 'Install the pi coding-agent SDK (pi on PATH) to run the composition cases';

const ENV_KEYS = ['SPEC_RUNTIME_ROLE', 'SPEC_RUNTIME_RECORD', 'PI_CODING_AGENT_DIR', 'PI_INTERCOM_SCOPE_ID'];

// The owner's verification process exports SPEC_RUNTIME_ROLE; every case needs
// a coordinator or explicit role, so the environment is snapshotted per test.
function isolatedEnv(t) {
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  delete process.env.PI_INTERCOM_SCOPE_ID;
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  return {
    delete(key) { delete process.env[key]; },
    set(key, value) { process.env[key] = value; },
  };
}

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sentinel-integration-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function primary(base, name = 'repo') {
  const repo = join(base, name);
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Sentinel Integration');
  git('config', 'user.email', 'sentinel-integration@example.invalid');
  return { repo, git };
}

function commit(repo) {
  writeFileSync(join(repo, 'README'), 'fixture\n');
  execFileSync('git', ['-C', repo, 'add', 'README'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'Initial fixture'], { stdio: 'pipe' });
}

function pack(repo, name = 'feature') {
  const packagePath = join(repo, '.specs', name);
  mkdirSync(packagePath, { recursive: true });
  return packagePath;
}

function receipt(packagePath, record) {
  const file = join(packagePath, 'runtime', 'runs', `${record.id}.json`);
  mkdirSync(join(packagePath, 'runtime', 'runs'), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...record, package: record.package ?? packagePath }));
  return file;
}

function capturedUI() {
  const widgets = [], statuses = [], notes = [];
  return {
    widgets,
    statuses,
    notes,
    ui: {
      setWidget: (key, content) => widgets.push({ key, content }),
      setStatus: (key, text) => statuses.push({ key, text }),
      setToolsExpanded: () => {},
      notify: (message, type) => notes.push({ message, type }),
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      editor: async () => undefined,
      custom: async () => undefined,
    },
  };
}

const lastNote = captured => captured.notes[captured.notes.length - 1];
const lastWidget = captured => captured.widgets[captured.widgets.length - 1];
const lastStatus = captured => captured.statuses[captured.statuses.length - 1];

// Shared fixture for the focused observer cases: one enrolled primary with one
// receipt, injectable watch/timer boundaries and a captured UI.
function observerFixture(t, { state = 'running', nativeRun = null, maxWatchers } = {}) {
  const dir = sandbox(t);
  const { repo } = primary(dir, 'focus-repo');
  const packagePath = pack(repo);
  receipt(packagePath, { id: 'run-focus', assignment_id: 'assign-focus', state, started_at: new Date(Date.now() - 60000).toISOString() });
  const directory = enrollmentDirectory({ agentDir: dir });
  const canonical = canonicalPackage(packagePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const enrollmentFile = join(directory, 'fixture.json');
  writeFileSync(enrollmentFile, JSON.stringify({ version: 1, root: canonical.primary, common: canonical.common, enrolled_at: new Date().toISOString() }));
  const watchers = [];
  const captures = capturedUI();
  const timers = new Map();
  const repeats = new Map();
  let timerId = 0;
  const registered = [];
  const observer = createSentinelObserver({
    pi: { registerCommand: (name, spec) => registered.push({ name, spec }) },
    context: { hasUI: true, ui: captures.ui },
    agentDir: dir,
    indexDir: join(dir, 'spec-runtime'),
    nativeRun,
    maxWatchers,
    watchDirectory: (target, listener) => {
      const watcher = {
        dir: target, listener, closed: false, errorCallback: null,
        close() { this.closed = true; },
        on(event, callback) { if (event === 'error') this.errorCallback = callback; return this; },
        fail(error) { this.errorCallback?.(error); },
      };
      watchers.push(watcher);
      return watcher;
    },
    setTimer: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimer: id => timers.delete(id),
    repeat: (callback, ms) => { const id = ++timerId; repeats.set(id, { callback, ms }); return id; },
    cancelRepeat: id => repeats.delete(id),
  });
  t.after(() => observer.close());
  return { dir, packagePath, enrollmentFile, observer, handler: registered[0].spec.handler, watchers, captures, timers, repeats };
}

// The scripted provider counts every request and refuses to serve one: any
// provider call would already fail the observation-only contract.
function scriptedProvider(requests) {
  return {
    name: 'Sentinel fixture',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'fixture-key',
    models: [{ id: 'scripted', name: 'Scripted fixture', input: ['text'], reasoning: false, contextWindow: 4096, cost: {} }],
    streamSimple: () => {
      requests.push(Date.now());
      if (requests.length > 8) throw new Error('Sentinel fixture provider served an unexpected request');
      throw new Error('Sentinel fixture provider must never be called');
    },
  };
}

// A deterministic provider that serves a final assistant message so the real
// settle boundary can approve exactly one continuation request.
function continuationProvider(requests) {
  return {
    name: 'Sentinel continuation fixture',
    api: 'openai-completions',
    baseUrl: 'http://unused.invalid',
    apiKey: 'fixture-key',
    models: [{ id: 'scripted', name: 'Scripted fixture', input: ['text'], reasoning: false, contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      requests.push(Date.now());
      const stream = sdk.ai.createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = { role: 'assistant', content: [{ type: 'text', text: 'Fixture response.' }], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop', timestamp: Date.now() };
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
      });
      return stream;
    },
  };
}

const piSubagentsPath = join(homedir(), '.pi/agent/npm/node_modules/pi-subagents/index.js');
const delegationSkip = sdkSkip || (existsSync(piSubagentsPath) ? false : 'Install pi-subagents to run the delegation composition case');

// A valid source-backed incident for the real delegation composition case.
function incidentFixture(packagePath, tag) {
  return {
    id: createHash('sha256').update(String(tag)).digest('hex').slice(0, 32),
    kind: 'repeated-verification-failure',
    assignment_id: 'assign-diag',
    package: packagePath,
    workflow_id: 'wf-diag',
    generation: 1,
    linked_from: null,
    command_sha256: 'a'.repeat(64),
    summary_sha256: 'b'.repeat(64),
    tree_digest: 'c'.repeat(64),
    count: 3,
    tool_call_ids: ['call-1', 'call-2', 'call-3'],
    observed_at: '2026-10-06T12:00:00.000Z',
  };
}

// Scripted final provider for the owned diagnosis: the first request is held
// until releaseFirst so the test can prove serialization; later requests finish
// deterministically. replyFor(index) supplies the bounded JSON text.
function deferredDiagnosisProvider(replyFor) {
  const calls = [];
  let firstFinish = null;
  let releaseRequested = false;
  let firstFinished = false;
  let resolveFirstCall;
  const firstCall = new Promise(resolve => { resolveFirstCall = resolve; });
  const flushFirst = () => {
    // Release is tolerant of arriving before the first provider call, and
    // idempotent: the first stream finishes exactly once.
    if (!releaseRequested || !firstFinish || firstFinished) return;
    firstFinished = true;
    firstFinish();
  };
  const provider = {
    name: 'Sentinel diagnosis fixture',
    api: 'openai-completions',
    baseUrl: 'http://unused.invalid',
    apiKey: 'fixture-key',
    models: [{ id: 'scripted', name: 'Scripted fixture', input: ['text'], reasoning: false, contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      const index = calls.length;
      calls.push(Date.now());
      const stream = sdk.ai.createAssistantMessageEventStream();
      const finish = () => {
        const message = { role: 'assistant', content: [{ type: 'text', text: replyFor(index) }], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop', timestamp: Date.now() };
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
      };
      if (index === 0) {
        firstFinish = finish;
        resolveFirstCall();
        flushFirst();
      } else queueMicrotask(finish);
      return stream;
    },
  };
  return { provider, calls, firstCall, releaseFirst: () => { releaseRequested = true; flushFirst(); } };
}

// Isolated SDK session over the real index.ts with a scripted provider that
// never serves a request: status must be observation-only.
async function loadExtension(t, { dir, role, recordFile, providerFactory = scriptedProvider, extraFactories = [], extraExtensionPaths = [] } = {}) {
  const env = isolatedEnv(t);
  if (role) {
    env.set('SPEC_RUNTIME_ROLE', role);
    env.set('SPEC_RUNTIME_RECORD', recordFile);
  } else {
    env.delete('SPEC_RUNTIME_ROLE');
    env.delete('SPEC_RUNTIME_RECORD');
  }
  const captured = capturedUI();
  const requests = [];
  const { DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession, ModelRuntime } = sdk;
  // The real index.ts resolves getAgentDir() from this variable; it must point
  // at the sandbox, never the operator's live agent state.
  env.set('PI_CODING_AGENT_DIR', dir);
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('sentinel-fixture', providerFactory(requests));
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'Isolated sentinel integration fixture.',
    additionalExtensionPaths: [indexPath, ...extraExtensionPaths],
    extensionFactories: [pi => pi.registerProvider('sentinel-fixture', providerFactory(requests)), ...extraFactories],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const errors = [];
  const sessionManager = SessionManager.inMemory(dir);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager,
    tools: [],
  });
  await session.bindExtensions({ uiContext: captured.ui, mode: 'rpc', onError: error => errors.push(error) });
  await session.setModel(modelRuntime.getModel('sentinel-fixture', 'scripted'));
  if (role) t.after(() => session.dispose());
  else t.after(async () => {
    // Always dispose observer handles first, or the open reconcile timer keeps
    // the test process alive past its deadline.
    try { await session.prompt('/spec-sentinel off'); } catch { /* Observer may already be absent. */ }
    session.dispose();
  });
  return { session, sessionManager, loader, captured, requests, errors, modelRuntime, settingsManager };
}

function cli(args, cwd) {
  return execFileSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });
}

test('sentinel status: actual index.ts serves enrolled workspace facts with zero provider calls', { skip: sdkSkip, timeout: 60000 }, async t => {
  const dir = sandbox(t);
  const { repo } = primary(dir, 'status-repo');
  const packagePath = pack(repo);
  const file = receipt(packagePath, { id: 'run-status', assignment_id: 'assign-status', state: 'running', started_at: new Date(Date.now() - 60000).toISOString() });
  const receiptBytes = readFileSync(file);
  const { session, captured, requests } = await loadExtension(t, { dir });

  await session.prompt('/spec-sentinel add ' + repo);
  const directory = enrollmentDirectory({ agentDir: dir });
  const names = readdirSync(directory).filter(name => name.endsWith('.json'));
  assert.equal(names.length, 1);
  const record = JSON.parse(readFileSync(join(directory, names[0]), 'utf8'));
  const canonical = canonicalPackage(packagePath);
  assert.equal(record.version, 1);
  assert.equal(record.root, canonical.primary);
  assert.equal(record.common, canonical.common);
  assert.equal((statSync(join(directory, names[0])).mode & 0o777).toString(8), '600');

  await session.prompt('/spec-sentinel status');
  const status = lastNote(captured);
  assert.equal(status.type, 'info');
  assert.match(status.message, /status-repo/);
  assert.match(status.message, /assign-status/);
  assert.match(status.message, /running/);
  assert.equal(lastWidget(captured).key, SENTINEL_WIDGET_KEY);
  assert.equal(lastStatus(captured).key, SENTINEL_WIDGET_KEY);
  // No native monitor is attached to this enrolled external run, so the widget
  // keeps its identity/execution detail and conditions, not only a header.
  const widget = lastWidget(captured).content.join('\n');
  assert.ok(lastWidget(captured).content.length > 1);
  assert.match(widget, /assign-status/);
  assert.match(widget, /running/);

  await session.prompt('/spec-sentinel inspect assign-status');
  const inspected = lastNote(captured);
  assert.match(inspected.message, /assign-status/);
  assert.match(inspected.message, /coverage/);

  await session.prompt('/spec-sentinel off');
  assert.deepEqual(lastWidget(captured).content, []);
  assert.equal(lastStatus(captured).text, '');

  assert.equal(requests.length, 0);
  assert.deepEqual([...readFileSync(file)], [...receiptBytes]);
  assert.deepEqual(readdirSync(packagePath).sort(), ['runtime']);
  assert.equal(existsSync(join(packagePath, 'runtime', 'package.lock')), false);
  assert.deepEqual(readdirSync(join(packagePath, 'runtime')).sort(), ['runs']);
  assert.equal(readdirSync(join(packagePath, 'runtime', 'runs')).some(name => name.includes('-processes')), false);
});

test('sentinel enrollment: add writes one canonical record and rejects linked worktrees', { skip: sdkSkip, timeout: 60000 }, async t => {
  const dir = sandbox(t);
  const { repo, git } = primary(dir, 'enroll-repo');
  commit(repo);
  const packagePath = pack(repo);
  receipt(packagePath, { id: 'run-enroll', assignment_id: 'assign-enroll', state: 'running', started_at: new Date(Date.now() - 60000).toISOString() });
  const { session, captured } = await loadExtension(t, { dir });
  const directory = enrollmentDirectory({ agentDir: dir });
  const count = () => readdirSync(directory).filter(name => name.endsWith('.json')).length;

  await session.prompt('/spec-sentinel add ' + repo);
  await session.prompt('/spec-sentinel add ' + repo);
  assert.equal(count(), 1);

  const worktree = join(dir, 'enroll-worktree');
  git('worktree', 'add', '-q', worktree);
  pack(worktree);
  await session.prompt('/spec-sentinel add ' + worktree);
  assert.match(lastNote(captured).message, /linked worktrees are not enrolled/);
  assert.equal(count(), 1);

  await session.prompt('/spec-sentinel add ' + join(dir, 'does-not-exist'));
  assert.equal(lastNote(captured).type, 'error');
  assert.equal(count(), 1);
});

test('sentinel observer: coalesced invalidation, missed-event reconciliation and clean disposal', async t => {
  const dir = sandbox(t);
  const { repo } = primary(dir, 'observer-repo');
  const packagePath = pack(repo);
  const directory = enrollmentDirectory({ agentDir: dir });
  const canonical = canonicalPackage(packagePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'fixture.json'),
    JSON.stringify({ version: 1, root: canonical.primary, common: canonical.common, enrolled_at: new Date().toISOString() }));

  const watchers = [];
  const timers = new Map();
  const repeats = new Map();
  let timerId = 0;
  const captures = capturedUI();
  const registered = [];
  const pi = { registerCommand: (name, spec) => registered.push({ name, spec }) };
  const context = { hasUI: true, ui: captures.ui };
  const observer = createSentinelObserver({
    pi,
    context,
    agentDir: dir,
    indexDir: join(dir, 'spec-runtime'),
    watchDirectory: (target, listener) => {
      const watcher = {
        dir: target, listener, closed: false, errorCallback: null,
        close() { this.closed = true; },
        on(event, callback) { if (event === 'error') this.errorCallback = callback; return this; },
        fail(error) { this.errorCallback?.(error); },
      };
      watchers.push(watcher);
      return watcher;
    },
    setTimer: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimer: id => timers.delete(id),
    repeat: (callback, ms) => { const id = ++timerId; repeats.set(id, { callback, ms }); return id; },
    cancelRepeat: id => repeats.delete(id),
  });
  t.after(() => observer.close());
  assert.deepEqual(registered.map(item => item.name), ['spec-sentinel']);

  await observer.refresh();
  assert.ok(watchers.length > 0);
  receipt(packagePath, { id: 'run-observer-1', assignment_id: 'assign-observer-1', state: 'running', started_at: new Date(Date.now() - 60000).toISOString() });
  receipt(packagePath, { id: 'run-observer-2', assignment_id: 'assign-observer-2', state: 'running', started_at: new Date(Date.now() - 50000).toISOString() });

  for (const watcher of watchers) { watcher.listener(); watcher.listener(); }
  assert.equal(timers.size, 1);
  const [pending] = [...timers.values()];
  assert.equal(pending.ms, SENTINEL_COALESCE_MS);
  timers.clear();
  await pending.callback();
  assert.match(lastWidget(captures).content[0], /2 run\(s\)/);

  receipt(packagePath, { id: 'run-observer-3', assignment_id: 'assign-observer-3', state: 'running', started_at: new Date(Date.now() - 40000).toISOString() });
  assert.equal(repeats.size, 1);
  const [reconcile] = [...repeats.values()];
  assert.equal(reconcile.ms, SENTINEL_RECONCILE_MS);
  await reconcile.callback();
  assert.match(lastWidget(captures).content[0], /3 run\(s\)/);

  // Nested activity snapshots replace atomically inside <run-id>-activity
  // directories; nonrecursive watching means those directories carry their
  // own invalidation watches.
  const activityDirectory = join(packagePath, 'runtime', 'runs', 'run-observer-1-activity');
  mkdirSync(activityDirectory, { recursive: true });
  writeFileSync(join(activityDirectory, 'owner.json'), JSON.stringify({ run_id: 'run-observer-1', role: 'owner', phase: 'working', hint: 'editing source files', last_activity: new Date().toISOString() }));
  for (const watcher of watchers) watcher.listener();
  const [activityRefresh] = [...timers.values()];
  timers.clear();
  await activityRefresh.callback();
  const activityWatcher = watchers.find(watcher => !watcher.closed && watcher.dir.endsWith('run-observer-1-activity'));
  assert.ok(activityWatcher, 'the nested activity directory is watched');

  // Replacing the role snapshot atomically, with no top-level receipt change,
  // still invalidates the workspace observer through the nested watch.
  const replacement = join(activityDirectory, 'owner.json.new');
  writeFileSync(replacement, JSON.stringify({ run_id: 'run-observer-1', role: 'owner', phase: 'working', hint: 'verifying edited files', last_activity: new Date().toISOString() }));
  renameSync(replacement, join(activityDirectory, 'owner.json'));
  activityWatcher.listener();
  const [replacedRefresh] = [...timers.values()];
  timers.clear();
  await replacedRefresh.callback();
  assert.match(lastWidget(captures).content.join('\n'), /verifying edited files/);

  // A failed watch is disposed, displayed as stale coverage and retried on
  // the next reconciliation instead of staying silently dead.
  const failed = watchers.find(watcher => !watcher.closed && watcher.dir.endsWith(join('runtime', 'runs')));
  failed.fail(new Error('watch failed'));
  assert.ok(failed.closed);
  assert.ok(lastWidget(captures).content.some(line => line.includes('Watcher unavailable')));
  assert.match(lastStatus(captures).text, /stale/);
  await reconcile.callback();
  assert.ok(watchers.some(watcher => watcher !== failed && !watcher.closed && watcher.dir === failed.dir));
  assert.ok(!lastWidget(captures).content.some(line => line.includes('Watcher unavailable')));

  assert.deepEqual(readdirSync(packagePath).sort(), ['runtime']);
  assert.deepEqual(readdirSync(join(packagePath, 'runtime')).sort(), ['runs']);
  assert.deepEqual(readdirSync(join(packagePath, 'runtime', 'runs')).sort(),
    ['run-observer-1-activity', 'run-observer-1.json', 'run-observer-2.json', 'run-observer-3.json']);
  assert.equal(readdirSync(directory).filter(name => name.endsWith('.json')).length, 1);

  observer.close();
  assert.ok(watchers.every(watcher => watcher.closed));
  assert.equal(timers.size, 0);
  assert.equal(repeats.size, 0);
  observer.close();
});

test('sentinel observer: off and close during pending reads never install disposed handles', async t => {
  // close() racing a pending read must not resurrect handles afterwards.
  const closing = observerFixture(t);
  const closingRead = closing.observer.refresh();
  closing.observer.close();
  await closingRead;
  assert.equal(closing.watchers.length, 0);

  // off() racing a pending read likewise leaves no live handles.
  const offing = observerFixture(t);
  const offingRead = offing.observer.refresh();
  await offing.handler('off');
  await offingRead;
  assert.equal(offing.watchers.length, 0);

  // One-shot status after off reads fresh facts without any handles.
  await offing.handler('status');
  const status = lastNote(offing.captures);
  assert.equal(status.type, 'info');
  assert.match(status.message, /focus-repo/);
  assert.match(status.message, /assign-focus/);
  assert.equal(offing.watchers.length, 0);
});

test('sentinel observer: unreadable enrollment retains prior facts as stale', async t => {
  const f = observerFixture(t);
  await f.observer.refresh();
  assert.match(lastWidget(f.captures).content[0], /1 run\(s\)/);
  assert.match(lastWidget(f.captures).content.join('\n'), /assign-focus/);

  // The only enrollment record becoming malformed must not turn the workspace
  // into healthy emptiness: prior facts are retained and shown stale.
  writeFileSync(f.enrollmentFile, '{not json');
  await f.observer.refresh();
  const retained = lastWidget(f.captures).content.join('\n');
  assert.match(retained, /assign-focus/);
  assert.match(retained, /coverage stale/);
  assert.match(retained, /enrollment-invalid/);
  assert.match(retained, /Enrollment unreadable/);
  assert.match(lastStatus(f.captures).text, /stale/);
});

test('sentinel observer: an external single run keeps details; only the natively displayed run collapses', async t => {
  let native = null;
  const f = observerFixture(t, { state: 'failed', nativeRun: () => native });
  await f.observer.refresh();
  // No native monitor is attached to a fresh coordinator: an enrolled external
  // failure stays fully visible in the persistent widget.
  const external = lastWidget(f.captures).content.join('\n');
  assert.ok(lastWidget(f.captures).content.length > 1);
  assert.match(external, /assign-focus/);
  assert.match(external, /failed/);
  assert.match(external, /execution-failed/);

  // When the native monitor displays the same run, only its duplicated
  // identity/execution row collapses; sentinel-only conditions remain.
  native = { id: 'run-focus', package: f.packagePath };
  await f.observer.refresh();
  const collapsed = lastWidget(f.captures).content.join('\n');
  assert.doesNotMatch(collapsed, /assign-focus/);
  assert.match(collapsed, /execution-failed/);
  assert.match(collapsed, /coverage complete/);
});

test('sentinel observer: a watcher-cap exclusion is reported, not hidden', async t => {
  const f = observerFixture(t, { maxWatchers: 1 });
  await f.observer.refresh();
  assert.match(lastWidget(f.captures).content.join('\n'), /Watcher cap reached \(1 of \d+ directories\)/);
  assert.match(lastStatus(f.captures).text, /stale/);
});

test('sentinel status: the CLI reports a disposable package and preserves runs discovery', { timeout: 60000 }, async t => {
  // A managed environment exports PI_INTERCOM_SCOPE_ID and PI_CODING_AGENT_DIR;
  // both must be gone so the fixture and the CLI resolve one workspace.
  const env = isolatedEnv(t);
  env.delete('PI_CODING_AGENT_DIR');
  const dir = sandbox(t);
  const empty = join(dir, 'empty-agent');
  const emptyIndex = join(dir, 'empty-index');
  mkdirSync(empty, { recursive: true });
  mkdirSync(emptyIndex, { recursive: true });
  const { repo } = primary(dir, 'cli-repo');
  const packagePath = pack(repo);
  receipt(packagePath, { id: 'run-cli', assignment_id: 'assign-cli', state: 'running', started_at: new Date(Date.now() - 60000).toISOString() });

  const text = cli(['sentinel', 'status', '--package', packagePath, '--agent-dir', empty], dir);
  assert.match(text, /cli-repo/);
  assert.match(text, /assign-cli/);
  assert.match(text, /running/);

  const parsed = JSON.parse(cli(['sentinel', 'status', '--package', packagePath, '--format', 'json', '--agent-dir', empty], dir));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.runs[0].package, canonicalPackage(packagePath).packagePath);
  assert.equal(parsed.runs[0].assignment_id, 'assign-cli');

  // A snapshot larger than the ~64 KiB pipe buffer must still drain intact.
  const manyRepo = primary(dir, 'many-repo').repo;
  const manyPackage = pack(manyRepo);
  for (let index = 1; index <= 50; index++) {
    receipt(manyPackage, {
      id: `run-many-${index}`,
      assignment_id: `assign-many-${index}`,
      state: 'running',
      started_at: new Date(Date.now() - 60000).toISOString(),
      // Realistic retained session paths keep the fixture above the pipe buffer.
      parent_session: join(dir, 'sessions', 'coordinator-' + 'retained-'.repeat(16) + `${index}.jsonl`),
    });
  }
  const large = cli(['sentinel', 'status', '--package', manyPackage, '--format', 'json', '--agent-dir', empty], dir);
  assert.ok(large.length > 65536, `expected a snapshot above the pipe buffer, got ${large.length} bytes`);
  const many = JSON.parse(large);
  assert.equal(many.runs.length, 50);
  assert.deepEqual(many.runs.map(run => run.assignment_id).sort(),
    Array.from({ length: 50 }, (unused, index) => `assign-many-${index + 1}`).sort());

  const emptyOut = cli(['sentinel', 'status', '--agent-dir', empty], dir);
  assert.match(emptyOut, /No enrolled roots\. Add one in Pi with \/spec-sentinel add \/absolute\/primary\./);

  // Unreadable enrollment is an explicit unknown in the CLI too, never a
  // healthy empty workspace.
  const enrollments = enrollmentDirectory({ agentDir: empty });
  mkdirSync(enrollments, { recursive: true });
  writeFileSync(join(enrollments, 'broken.json'), '{not json');
  const broken = cli(['sentinel', 'status', '--agent-dir', empty], dir);
  assert.match(broken, /coverage unavailable/);
  assert.match(broken, /enrollment-invalid/);
  assert.doesNotMatch(broken, /No enrolled roots\. Add one/);

  const runs = JSON.parse(cli(['runs', '--index-root', emptyIndex], dir));
  assert.deepEqual(runs.runs, []);
  assert.equal(runs.candidates_truncated, false);
  assert.equal(runs.runs_truncated, false);
});

test('sentinel checkpoint: sentinel role worker load has no checkpoint tool and an empty coordinator stays observe-only', { skip: sdkSkip, timeout: 60000 }, async t => {
  const dir = sandbox(t);
  const recordFile = join(dir, 'worker-record.json');
  writeFileSync(recordFile, JSON.stringify({ id: 'run-worker', package: dir, state: 'running' }));
  const worker = await loadExtension(t, { dir, role: 'owner', recordFile });
  const workerCommands = worker.loader.getExtensions().extensions.flatMap(extension => [...extension.commands.keys()]);
  assert.equal(workerCommands.includes('spec-sentinel'), false);
  const workerTools = worker.loader.getExtensions().extensions.flatMap(extension => [...extension.tools.keys()]);
  assert.deepEqual(workerTools.filter(name => /sentinel/i.test(name)), []);
  // Managed workers never receive the coordinator-only checkpoint or dispatch tools.
  assert.equal(workerTools.includes('spec_sentinel_checkpoint'), false);
  assert.equal(workerTools.includes('spec_dispatch'), false);

  const dir2 = sandbox(t);
  const coordinator = await loadExtension(t, { dir: dir2 });
  await coordinator.session.prompt('/spec-sentinel status');
  const note = lastNote(coordinator.captured);
  assert.match(note.message, /No observed runs\./);
  assert.match(note.message, /coverage complete/);
  const commands = coordinator.loader.getExtensions().extensions.flatMap(extension => [...extension.commands.keys()]);
  assert.ok(commands.includes('spec-sentinel'));
  assert.deepEqual(coordinator.loader.getExtensions().extensions.flatMap(extension => [...extension.tools.keys()]).filter(name => /sentinel/i.test(name)), []);
  assert.equal(coordinator.requests.length, 0);
});

test('sentinel checkpoint: the actual coordinator tool registers and refuses a stale native input revision', { skip: sdkSkip, timeout: 60000 }, async t => {
  const dir = sandbox(t);
  const { repo } = primary(dir, 'checkpoint-repo');
  const packagePath = pack(repo);
  const canonical = canonicalPackage(packagePath);
  const { loader } = await loadExtension(t, { dir });
  const tools = new Map(loader.getExtensions().extensions.flatMap(extension => [...extension.tools.entries()]));
  assert.ok(tools.has('spec_sentinel_checkpoint'), 'coordinator registers spec_checkpoint');
  // Identity is read from the live session manager, never the model arguments.
  const ctx = { sessionManager: { getSessionFile: () => join(dir, 'sessions', 'coord.jsonl'), getSessionId: () => 'coord-session' } };
  const checkpoint = tools.get('spec_sentinel_checkpoint');
  const args = { package: canonical.packagePath, workflow_id: 'wf-int', expected_revision: 0, state: 'ready',
    obligation: { key: 'impl:s1', stage: 'implementation', summary: 'work', artifacts: [] },
    workers: [], inbox: { items: [] }, reconciles_input_revision: 0 };
  const created = await checkpoint.definition.execute('call-1', args, undefined, undefined, ctx);
  assert.equal(created.isError, false);
  assert.equal(created.details.workflow_id, 'wf-int');
  assert.equal(created.details.revision, 1);
  assert.equal(created.details.receipt, 'created');
  const file = join(packagePath, 'runtime', 'sentinel', 'wf-int', 'checkpoint.json');
  assert.ok(existsSync(file));

  // A stale native input revision is refused without mutating the checkpoint.
  const before = readFileSync(file, 'utf8');
  const stale = await checkpoint.definition.execute('call-2', { ...args, expected_revision: 1, reconciles_input_revision: 5 }, undefined, undefined, ctx);
  assert.equal(stale.isError, true);
  assert.match(stale.details.error, /does not match the current native input revision/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('sentinel checkpoint: registered sentinel dispatch binds the receipt checkout and maps terminal returns', { skip: sdkSkip, timeout: 60000 }, async t => {
  const dir = sandbox(t);
  const { repo } = primary(dir, 'dispatch-repo');
  commit(repo);
  const packagePath = pack(repo);
  const canonical = canonicalPackage(packagePath);
  // A completed prior run lets startup resume without launching a process.
  const checkout = join(dir, 'dispatch-checkout');
  mkdirSync(checkout, { recursive: true });
  const runRecord = { schema_version: 1, id: 'run-dispatch-int', assignment_id: 'assign-dispatch-int',
    package: canonical.packagePath, step: join(packagePath, 'step-001-subspec.md'), checkout, state: 'completed', started_at: new Date().toISOString() };
  mkdirSync(join(packagePath, 'runtime', 'runs'), { recursive: true });
  writeFileSync(join(packagePath, 'runtime', 'runs', 'run-dispatch-int.json'), JSON.stringify(runRecord));
  writeFileSync(join(packagePath, 'runtime', 'run.json'), JSON.stringify(runRecord));

  const { loader } = await loadExtension(t, { dir });
  const tools = new Map(loader.getExtensions().extensions.flatMap(extension => [...extension.tools.entries()]));
  const ctx = { sessionManager: { getSessionFile: () => join(dir, 'sessions', 'coord.jsonl'), getSessionId: () => 'coord-session' } };
  // The workflow owner must be registered first; dispatch never mints it.
  await tools.get('spec_sentinel_checkpoint').definition.execute('call-1', { package: canonical.packagePath, workflow_id: 'wf-dispatch',
    expected_revision: 0, state: 'ready', obligation: { key: 'impl:step-001', stage: 'implementation', summary: 'work', artifacts: [] },
    workers: [], inbox: { items: [] }, reconciles_input_revision: 0 }, undefined, undefined, ctx);

  const receipt = await tools.get('spec_dispatch').definition.execute('call-2', { action: 'startup', package: canonical.packagePath,
    workflow_id: 'wf-dispatch', assignment_id: 'assign-dispatch-int' }, undefined, undefined, ctx);
  assert.equal(receipt.isError, false);
  assert.equal(receipt.details.workflow_id, 'wf-dispatch');
  assert.equal(receipt.details.checkpoint_revision, 3);
  const stored = readCheckpointRecord(canonical.packagePath, 'wf-dispatch');
  assert.equal(stored.checkout, checkout);
  // A terminal receipt is reconciled through the production composition: the
  // exited worker is declared terminal, never active, and no manual reducer
  // call is needed to expose the reconcile obligation.
  assert.equal(stored.state, 'ready');
  assert.equal(stored.obligation.key, 'reconcile:assign-dispatch-int');
  assert.notEqual(stored.state, 'complete');
  // The dispatch update retains the reconciled revision; it does not adopt a live one.
  assert.equal(stored.input_revision, 0);
  assert.deepEqual(stored.workers.find(worker => worker.id === 'assign-dispatch-int'), { id: 'assign-dispatch-int', kind: 'owner', state: 'complete' });
});

test('sentinel checkpoint: successive dispatches under one workflow bind sequential assignments', { skip: sdkSkip, timeout: 60000 }, async t => {
  const dir = sandbox(t);
  const { repo } = primary(dir, 'sequence-repo');
  commit(repo);
  const packagePath = pack(repo);
  const canonical = canonicalPackage(packagePath);
  const checkout = join(dir, 'sequence-checkout');
  mkdirSync(checkout, { recursive: true });
  // The run records simulate two finished steps without launching processes.
  // The defaulted runtime assignment key is the absolute prepared card path.
  const stepPath = join(packagePath, 'step-001-subspec.md');
  const runA = { schema_version: 1, id: 'run-seq-a', assignment_id: stepPath, package: canonical.packagePath,
    step: stepPath, checkout, state: 'completed', started_at: new Date().toISOString() };
  const runB = { ...runA, id: 'run-seq-b' };
  mkdirSync(join(packagePath, 'runtime', 'runs'), { recursive: true });
  writeFileSync(join(packagePath, 'runtime', 'runs', 'run-seq-a.json'), JSON.stringify(runA));
  writeFileSync(join(packagePath, 'runtime', 'runs', 'run-seq-b.json'), JSON.stringify(runB));
  writeFileSync(join(packagePath, 'runtime', 'run.json'), JSON.stringify(runA));
  // The second step's durable assignment link, as the runtime itself writes it.
  mkdirSync(join(packagePath, 'runtime', 'assignments'), { recursive: true });
  writeFileSync(join(packagePath, 'runtime', 'assignments', `${createHash('sha256').update('assign-seq-b').digest('hex')}.json`),
    JSON.stringify({ assignment_id: 'assign-seq-b', run_id: 'run-seq-b', contract: 'fixture' }));

  const { loader } = await loadExtension(t, { dir });
  const tools = new Map(loader.getExtensions().extensions.flatMap(extension => [...extension.tools.entries()]));
  const ctx = { sessionManager: { getSessionFile: () => join(dir, 'sessions', 'coord.jsonl'), getSessionId: () => 'coord-session' } };
  await tools.get('spec_checkpoint').definition.execute('call-0', { package: canonical.packagePath, workflow_id: 'wf-seq',
    expected_revision: 0, state: 'ready', obligation: { key: 'impl:step-001', stage: 'implementation', summary: 'work', artifacts: [] },
    workers: [], inbox: { items: [] }, reconciles_input_revision: 0 }, undefined, undefined, ctx);

  // First dispatch omits assignment_id: the runtime key stays the step path in
  // the receipt, while the declared checkpoint worker is the real run UUID.
  const first = await tools.get('spec_dispatch').definition.execute('call-1', { action: 'startup', package: canonical.packagePath,
    workflow_id: 'wf-seq' }, undefined, undefined, ctx);
  assert.equal(first.isError, false);
  assert.equal(first.details.run_id, 'run-seq-a');
  assert.equal(first.details.assignment_id, stepPath);
  assert.equal(first.details.checkpoint_revision, 3);
  let stored = readCheckpointRecord(canonical.packagePath, 'wf-seq');
  assert.equal(stored.checkout, checkout);
  assert.equal(stored.state, 'ready');
  assert.equal(stored.obligation.key, 'reconcile:run-seq-a');
  assert.deepEqual(stored.workers.find(worker => worker.id === 'run-seq-a'), { id: 'run-seq-a', kind: 'owner', state: 'complete' });
  assert.equal(stored.workers.some(worker => worker.id === stepPath), false);

  // The ledger now points at the next step's finished run, exactly as the
  // runtime's own dispatch would have written it.
  writeFileSync(join(packagePath, 'runtime', 'run.json'), JSON.stringify(runB));
  const second = await tools.get('spec_dispatch').definition.execute('call-2', { action: 'startup', package: canonical.packagePath,
    workflow_id: 'wf-seq', assignment_id: 'assign-seq-b' }, undefined, undefined, ctx);
  assert.equal(second.isError, false);
  assert.equal(second.details.run_id, 'run-seq-b');
  stored = readCheckpointRecord(canonical.packagePath, 'wf-seq');
  // Successive assignments accumulate terminal history under one workflow.
  assert.deepEqual(stored.workers.find(worker => worker.id === 'run-seq-a'), { id: 'run-seq-a', kind: 'owner', state: 'complete' });
  assert.deepEqual(stored.workers.find(worker => worker.id === 'assign-seq-b'), { id: 'assign-seq-b', kind: 'owner', state: 'complete' });
  assert.equal(stored.obligation.key, 'reconcile:assign-seq-b');
  assert.equal(stored.state, 'ready');
  assert.equal(second.details.checkpoint_revision, stored.revision);

  // A resume of a genuinely active ledger run is not a conflict: the same run
  // is reused and declared active while it works.
  const runC = { ...runA, id: 'run-seq-c', state: 'running' };
  writeFileSync(join(packagePath, 'runtime', 'runs', 'run-seq-c.json'), JSON.stringify(runC));
  writeFileSync(join(packagePath, 'runtime', 'run.json'), JSON.stringify(runC));
  const resume = await tools.get('spec_dispatch').definition.execute('call-3', { action: 'startup', package: canonical.packagePath,
    workflow_id: 'wf-seq' }, undefined, undefined, ctx);
  assert.equal(resume.isError, false);
  stored = readCheckpointRecord(canonical.packagePath, 'wf-seq');
  assert.equal(stored.state, 'waiting-worker');
  assert.deepEqual(stored.workers.find(worker => worker.id === 'run-seq-c'), { id: 'run-seq-c', kind: 'owner', state: 'working' });
  const beforeRefusal = stored.revision;

  // Dispatching a different assignment while that one is genuinely active is
  // refused from durable state BEFORE any launch or checkpoint mutation.
  const runD = { ...runA, id: 'run-seq-d' };
  writeFileSync(join(packagePath, 'runtime', 'runs', 'run-seq-d.json'), JSON.stringify(runD));
  writeFileSync(join(packagePath, 'runtime', 'run.json'), JSON.stringify(runD));
  const refused = await tools.get('spec_dispatch').definition.execute('call-4', { action: 'startup', package: canonical.packagePath,
    workflow_id: 'wf-seq' }, undefined, undefined, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.details.error, /still has active assignment run-seq-c/);
  const after = readCheckpointRecord(canonical.packagePath, 'wf-seq');
  assert.equal(after.revision, beforeRefusal);
  assert.deepEqual(after.workers.find(worker => worker.id === 'run-seq-c'), { id: 'run-seq-c', kind: 'owner', state: 'working' });
});

test('sentinel checkpoint: an unregistered workflow is refused before any dispatch mutation', { skip: sdkSkip, timeout: 60000 }, async t => {
  const dir = sandbox(t);
  const { repo } = primary(dir, 'unregistered-repo');
  commit(repo);
  const packagePath = pack(repo);
  const canonical = canonicalPackage(packagePath);
  const { loader } = await loadExtension(t, { dir });
  const tools = new Map(loader.getExtensions().extensions.flatMap(extension => [...extension.tools.entries()]));
  const ctx = { sessionManager: { getSessionFile: () => join(dir, 'sessions', 'coord.jsonl'), getSessionId: () => 'coord-session' } };
  // No spec_sentinel_checkpoint registration exists: dispatch must refuse before it can
  // create a run directory, lease, assignment record or worktree.
  const refused = await tools.get('spec_dispatch').definition.execute('call-1', { action: 'startup', package: canonical.packagePath,
    workflow_id: 'wf-unregistered' }, undefined, undefined, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.details.error, /no registered checkpoint/);
  assert.equal(existsSync(join(packagePath, 'runtime')), false);
});

test('sentinel checkpoint: workflow dispatch refuses an unreconciled native input revision before runtime', { skip: sdkSkip, timeout: 60000 }, async t => {
  const dir = sandbox(t);
  const { repo } = primary(dir, 'input-revision-repo');
  commit(repo);
  const packagePath = pack(repo);
  const canonical = canonicalPackage(packagePath);
  const { loader } = await loadExtension(t, { dir });
  const tools = new Map(loader.getExtensions().extensions.flatMap(extension => [...extension.tools.entries()]));
  const sessionFile = join(dir, 'sessions', 'coord.jsonl');
  const ctx = { sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => 'coord-session' } };
  // A checkpoint whose reconciled input revision is ahead of the live revision
  // means native input is unreconciled; dispatch must refuse before runtime.
  const checkpointFile = join(packagePath, 'runtime', 'sentinel', 'wf-input', 'checkpoint.json');
  mkdirSync(dirname(checkpointFile), { recursive: true });
  writeFileSync(checkpointFile, JSON.stringify({ version: 1, workflow_id: 'wf-input', package: canonical.packagePath,
    coordinator_session: sessionFile, revision: 1, input_revision: 5, checkout: null, state: 'ready',
    obligation: { key: 'k', stage: 's', summary: 'x', artifacts: [] }, workers: [], inbox: { items: [] } }));
  const refused = await tools.get('spec_dispatch').definition.execute('call-1', { action: 'startup', package: canonical.packagePath,
    workflow_id: 'wf-input' }, undefined, undefined, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.details.error, /native input revision/);
  assert.equal(existsSync(join(packagePath, 'runtime', 'runs')), false);
});

test('sentinel checkpoint: a missing native session identity is refused without checkpoint mutation', { skip: sdkSkip, timeout: 60000 }, async t => {
  const dir = sandbox(t);
  const { repo } = primary(dir, 'identity-repo');
  commit(repo);
  const packagePath = pack(repo);
  const canonical = canonicalPackage(packagePath);
  const { loader } = await loadExtension(t, { dir });
  const tools = new Map(loader.getExtensions().extensions.flatMap(extension => [...extension.tools.entries()]));
  // The SDK session provides no native identity: the coordinator-only tool must
  // refuse rather than binding the workflow to a shared placeholder.
  const ctx = { sessionManager: { getSessionFile: () => '', getSessionId: () => '' } };
  const refused = await tools.get('spec_sentinel_checkpoint').definition.execute('call-1', { package: canonical.packagePath, workflow_id: 'wf-identity',
    expected_revision: 0, state: 'ready', obligation: { key: 'k', stage: 's', summary: 'x', artifacts: [] },
    workers: [], inbox: { items: [] }, reconciles_input_revision: 0 }, undefined, undefined, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.details.error, /session identity is unavailable/);
  assert.equal(existsSync(join(packagePath, 'runtime')), false);
});

test('sentinel policy: the native SDK command arms only the live session and a copied grant cannot', { skip: sdkSkip, timeout: 15000 }, async t => {
  const dir = sandbox(t);
  const { repo } = primary(dir, 'authority-repo');
  commit(repo);
  const packagePath = pack(repo);
  const canonical = canonicalPackage(packagePath);
  const run = await loadExtension(t, { dir });
  const manager = run.sessionManager;
  // The native SDK session manager is the only identity source the command uses.
  const sessionFile = typeof manager.getSessionFile === 'function' ? manager.getSessionFile() : undefined;
  const sessionId = typeof manager.getSessionId === 'function' ? manager.getSessionId() : undefined;
  const identity = typeof sessionFile === 'string' && sessionFile ? sessionFile
    : (typeof sessionId === 'string' && sessionId ? sessionId : null);
  assert.ok(identity, 'the native SDK session exposes a nonempty identity');
  const checkout = join(dir, 'authority-checkout');
  mkdirSync(checkout, { recursive: true });
  recordCheckpoint({ package: canonical.packagePath, workflow_id: 'wf-auth', expected_revision: 0, state: 'ready',
    obligation: { key: 'impl:step-005', stage: 'implementation', summary: 'work', artifacts: [] },
    workers: [], inbox: { items: [] }, reconciles_input_revision: 0, coordinator_session: identity, checkout });
  const policyPath = join(dir, 'authority-policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, package: canonical.packagePath, workflow_id: 'wf-auth',
    checkout, coordinator_session: identity, mode: 'recover', actions: ['continue'],
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    max_effects: 1, max_diagnostics: 1, diagnosis: { model: 'test/diag' }, authority_reference: 'user:enable' }));

  await run.session.prompt(`/spec-sentinel enable ${policyPath}`);
  const armed = lastNote(run.captured);
  assert.equal(armed.type, 'info');
  assert.match(armed.message, /Sentinel authority armed/);
  assert.ok(armed.message.includes(canonical.packagePath));
  assert.ok(armed.message.includes('wf-auth'));
  assert.ok(armed.message.includes(identity));
  assert.match(armed.message, /mode: recover/);
  assert.match(armed.message, /kinds: continue, diagnose/);
  assert.match(armed.message, /caps: effects 1, diagnostics 1/);
  assert.match(armed.message, /authority: user:enable/);
  assert.match(armed.message, /source: [a-f0-9]{64}/);

  const authorityDir = join(packagePath, 'runtime', 'sentinel', 'wf-auth', 'authority');
  assert.ok(existsSync(join(authorityDir, 'grant.json')));
  assert.equal(readdirSync(join(authorityDir, 'activations')).length, 1);

  // Command-level disable persistence failure via a nonregular grant destination.
  const grantFile = join(authorityDir, 'grant.json');
  const grantBytes = readFileSync(grantFile, 'utf8');
  unlinkSync(grantFile);
  symlinkSync(join(dir, 'outside-authority-grant.json'), grantFile);
  await run.session.prompt('/spec-sentinel disable');
  const failed = lastNote(run.captured);
  assert.equal(failed.type, 'warning');
  assert.match(failed.message, /revocation persistence failed/);
  await run.session.prompt('/spec-sentinel status');
  assert.equal(lastNote(run.captured).type, 'info');
  unlinkSync(grantFile);
  writeFileSync(grantFile, grantBytes);

  // A fresh coordinator session must not reconstruct the capability from disk.
  const fresh = await loadExtension(t, { dir });
  await fresh.session.prompt('/spec-sentinel disable');
  assert.equal(lastNote(fresh.captured).type, 'info');
  assert.match(lastNote(fresh.captured).message, /No live sentinel authority was armed/);
  await fresh.session.prompt('/spec-sentinel status');
  assert.equal(lastNote(fresh.captured).type, 'info');
  assert.equal(fresh.requests.length, 0);
  assert.equal(run.requests.length, 0);
});

test('sentinel policy: disable and off revoke at command entry behind pending workflow work', { skip: sdkSkip, timeout: 30000 }, async t => {
  const dir = sandbox(t);
  const { repo } = primary(dir, 'fence-repo');
  commit(repo);
  const packagePath = pack(repo);
  const canonical = canonicalPackage(packagePath);
  // A fully prepared package so spec_dispatch startup reaches its asynchronous
  // history-index build; spec.md becomes a FIFO with no writer, so that read
  // stays pending inside the serialized workflow queue without blocking the
  // event loop: a deliberately pending workflow operation.
  writeFileSync(join(packagePath, 'context.md'), '# Context\n');
  writeFileSync(join(packagePath, 'spec-prepare.md'), '# Prepare\n');
  writeFileSync(join(packagePath, 'evidence-plan.json'), JSON.stringify({ version: 1 }));
  writeFileSync(join(packagePath, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1, difficulty: 'easy' }] }));
  writeFileSync(join(packagePath, 'step-001-subspec.md'), '# Step 1\n');
  writeFileSync(join(dirname(packagePath), 'project-context.md'), '# Project\n');
  mkdirSync(join(packagePath, 'inbox'), { recursive: true });
  mkdirSync(join(packagePath, 'processed'), { recursive: true });
  writeFileSync(join(packagePath, 'spec.md'), '# Spec\n');
  const run = await loadExtension(t, { dir, providerFactory: continuationProvider });
  const manager = run.sessionManager;
  const identity = (typeof manager.getSessionFile === 'function' && manager.getSessionFile())
    || (typeof manager.getSessionId === 'function' && manager.getSessionId()) || null;
  assert.ok(identity, 'the native SDK session exposes a nonempty identity');
  const checkout = join(dir, 'fence-checkout');
  mkdirSync(checkout, { recursive: true });
  recordCheckpoint({ package: canonical.packagePath, workflow_id: 'wf-fence', expected_revision: 0, state: 'ready',
    obligation: { key: 'impl:step-001', stage: 'implementation', summary: 'work', artifacts: [] },
    workers: [], inbox: { items: [] }, reconciles_input_revision: 0, coordinator_session: identity, checkout });
  const policyPath = join(dir, 'fence-policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, package: canonical.packagePath, workflow_id: 'wf-fence',
    checkout, coordinator_session: identity, mode: 'recover', actions: ['continue'],
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    max_effects: 2, max_diagnostics: 0, authority_reference: 'user:enable' }));
  await run.session.prompt(`/spec-sentinel enable ${policyPath}`);
  assert.match(lastNote(run.captured).message, /Sentinel authority armed/);
  const grantFile = join(packagePath, 'runtime', 'sentinel', 'wf-fence', 'authority', 'grant.json');
  assert.equal(JSON.parse(readFileSync(grantFile, 'utf8')).revoked, false);

  // The deliberately pending workflow operation: startup's history-index read
  // blocks on the FIFO spec.md inside the serialized workflow queue.
  const specFile = join(packagePath, 'spec.md');
  execFileSync('mkfifo', [`${specFile}.gate`]);
  renameSync(specFile, `${specFile}.regular`);
  renameSync(`${specFile}.gate`, specFile);
  const tools = new Map(run.loader.getExtensions().extensions.flatMap(extension => [...extension.tools.entries()]));
  let dispatchSettled = false;
  const dispatch = tools.get('spec_dispatch').definition.execute('call-fence-1', { action: 'startup',
    package: canonical.packagePath, workflow_id: 'wf-fence', owner_override: 'sentinel-fixture/scripted',
    editor_model: 'sentinel-fixture/scripted' }, undefined, undefined, { sessionManager: manager })
    .finally(() => { dispatchSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatchSettled, false, 'the workflow operation is pending');

  // Disable completes at command entry while the dispatch is still pending and
  // revokes before its disk I/O; queueing revocation behind the pending startup
  // would hang here and leave the capability armed throughout its waits.
  await run.session.prompt('/spec-sentinel disable');
  assert.match(lastNote(run.captured).message, /Sentinel authority revoked/);
  assert.equal(dispatchSettled, false, 'revocation preceded the pending workflow work');
  assert.equal(JSON.parse(readFileSync(grantFile, 'utf8')).revoked, true);

  // An activation queued behind the pending work cannot re-arm after off.
  const enablePrompt = run.session.prompt(`/spec-sentinel enable ${policyPath}`);
  await new Promise(resolve => setImmediate(resolve));
  await run.session.prompt('/spec-sentinel off');
  assert.match(lastNote(run.captured).message, /No live sentinel authority was armed/);
  assert.equal(dispatchSettled, false, 'the workflow operation is still pending');

  // Release the gate: the dispatch finishes, then the queued activation lands
  // and is fenced and re-revoked instead of re-arming the live capability.
  writeFileSync(specFile, '');
  let gateTimer;
  const gateTimeout = new Promise((_, reject) => { gateTimer = setTimeout(() => reject(new Error('the queued enable did not complete after the gate released')), 5000); });
  await Promise.race([enablePrompt, gateTimeout]).finally(() => clearTimeout(gateTimer));
  assert.match(lastNote(run.captured).message, /revoked again and stays disarmed/);
  const grant = JSON.parse(readFileSync(grantFile, 'utf8'));
  assert.equal(grant.revoked, true);
  assert.equal(grant.reason, 'disabled-during-activation');
  const dispatched = await dispatch;
  assert.equal(dispatched.isError, true, 'the gated dispatch itself fails on the empty spec read');

  // The fenced authority never arms: one extension-source turn, no sentinel
  // entry, no continuation reservation.
  await run.session.prompt('Confirm no continuation happens while disarmed.', { source: 'extension' });
  await run.session.waitForIdle();
  assert.equal(run.requests.length, 1, 'the disarmed authority adds no extra provider request');
  const branch = run.sessionManager.getBranch();
  assert.equal(branch.some(entry => entry.type === 'custom_message' && entry.customType === 'spec-sentinel'), false);
  assert.equal(existsSync(join(packagePath, 'runtime', 'sentinel', 'wf-fence', 'intents')), false);
});

// The native SDK boundary fixture: real extension hook, deterministic provider,
// canonical checkpoint/grant paths. The decisive ready checkpoint is reconciled
// through the registered production spec_checkpoint tool at native input revision
// 0, and all model prompts use {source:'extension'} so the native input guard
// stays exactly reconciled.
async function continuationFixture(t, { mode = 'recover', actions = ['continue'], factories = [] } = {}) {
  const dir = sandbox(t);
  const { repo } = primary(dir, 'continuation-repo');
  commit(repo);
  const packagePath = pack(repo);
  const canonical = canonicalPackage(packagePath);
  const run = await loadExtension(t, { dir, providerFactory: continuationProvider, extraFactories: factories });
  const manager = run.sessionManager;
  const identity = (typeof manager.getSessionFile === 'function' && manager.getSessionFile())
    || (typeof manager.getSessionId === 'function' && manager.getSessionId()) || null;
  assert.ok(identity, 'the native SDK session exposes a nonempty identity');
  const checkout = join(dir, 'continuation-checkout');
  mkdirSync(checkout, { recursive: true });
  recordCheckpoint({ package: canonical.packagePath, workflow_id: 'wf-cont', expected_revision: 0, state: 'ready',
    obligation: { key: 'impl:step-006', stage: 'implementation', summary: 'continue once', artifacts: [] },
    workers: [], inbox: { items: [] }, reconciles_input_revision: 0, coordinator_session: identity, checkout });
  const policyPath = join(dir, 'continuation-policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, package: canonical.packagePath, workflow_id: 'wf-cont',
    checkout, coordinator_session: identity, mode, actions,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    max_effects: 2, max_diagnostics: 0, authority_reference: 'user:enable' }));
  await run.session.prompt(`/spec-sentinel enable ${policyPath}`);
  // The decisive ready checkpoint comes through the registered production tool,
  // not a direct fixture write (the earlier record is checkout prebinding only).
  const tools = new Map(run.loader.getExtensions().extensions.flatMap(extension => [...extension.tools.entries()]));
  const checkpointTool = tools.get('spec_checkpoint');
  assert.ok(checkpointTool, 'the production checkpoint tool is registered');
  const ctx = { sessionManager: manager };
  const created = await checkpointTool.definition.execute('call-checkpoint-1', { package: canonical.packagePath,
    workflow_id: 'wf-cont', expected_revision: 1, state: 'ready',
    obligation: { key: 'impl:step-006', stage: 'implementation', summary: 'continue once', artifacts: [] },
    workers: [], inbox: { items: [] }, reconciles_input_revision: 0 }, undefined, undefined, ctx);
  assert.equal(created.isError, false, JSON.stringify(created.details));
  return { run, dir, packagePath, canonical, identity, checkout, checkpointTool, ctx };
}

test('sentinel continuation: recover mode adds exactly one visible request and marks it delivered', { skip: sdkSkip, timeout: 15000 }, async t => {
  const f = await continuationFixture(t, { mode: 'recover' });
  await f.run.session.prompt('Run the isolated continuation fixture.', { source: 'extension' });
  await f.run.session.waitForIdle();
  assert.equal(f.run.requests.length, 2, 'exactly one extra provider request');
  const branch = f.run.session.sessionManager.getBranch();
  assert.ok(branch.some(entry => entry.type === 'custom_message' && entry.customType === 'spec-sentinel'), 'the visible sentinel entry is retained');
  const intentsDir = join(f.packagePath, 'runtime', 'sentinel', 'wf-cont', 'intents');
  const names = readdirSync(intentsDir);
  assert.equal(names.length, 1);
  const intent = JSON.parse(readFileSync(join(intentsDir, names[0]), 'utf8'));
  // The requested continuation turn started: applied is delivery, never acceptance.
  assert.equal(intent.state, 'applied');
  assert.equal(intent.reason_code, 'delivered');
  // Reissue the unchanged obligation through the production tool, then a second
  // extension-source turn: the duplicate cannot refill the budget.
  const reissued = await f.checkpointTool.definition.execute('call-checkpoint-2', { package: f.canonical.packagePath,
    workflow_id: 'wf-cont', expected_revision: 2, state: 'ready',
    obligation: { key: 'impl:step-006', stage: 'implementation', summary: 'continue once', artifacts: [] },
    workers: [], inbox: { items: [] }, reconciles_input_revision: 0 }, undefined, undefined, f.ctx);
  assert.equal(reissued.isError, false, JSON.stringify(reissued.details));
  await f.run.session.prompt('Second turn with the same obligation.', { source: 'extension' });
  await f.run.session.waitForIdle();
  assert.equal(f.run.requests.length, 3, 'the same obligation does not refill the budget');
  assert.equal(readdirSync(intentsDir).length, 1);
});

test('sentinel continuation: shadow records would-continue with no visible entry or extra request', { skip: sdkSkip, timeout: 15000 }, async t => {
  const f = await continuationFixture(t, { mode: 'shadow' });
  await f.run.session.prompt('Run the isolated shadow fixture.', { source: 'extension' });
  await f.run.session.waitForIdle();
  assert.equal(f.run.requests.length, 1, 'shadow makes no extra provider request');
  const branch = f.run.session.sessionManager.getBranch();
  assert.equal(branch.some(entry => entry.type === 'custom_message' && entry.customType === 'spec-sentinel'), false);
  const intentsDir = join(f.packagePath, 'runtime', 'sentinel', 'wf-cont', 'intents');
  const names = readdirSync(intentsDir);
  assert.equal(names.length, 1);
  const intent = JSON.parse(readFileSync(join(intentsDir, names[0]), 'utf8'));
  assert.equal(intent.state, 'blocked');
  assert.equal(intent.reason_code, 'shadow-would-continue');
});

test('sentinel continuation: a retained disk grant does not arm a fresh session', { skip: sdkSkip, timeout: 15000 }, async t => {
  // First session persists the grant through the actual /spec-sentinel enable
  // command and the decisive checkpoint through the registered production tool.
  const f = await continuationFixture(t, { mode: 'recover' });
  assert.ok(existsSync(join(f.packagePath, 'runtime', 'sentinel', 'wf-cont', 'authority', 'grant.json')));
  // A second fresh coordinator session against the same sandbox/package never
  // enables, so its live capability stays disarmed despite the retained disk state.
  const fresh = await loadExtension(t, { dir: f.dir, providerFactory: continuationProvider });
  await fresh.session.prompt('Run the isolated fresh fixture.', { source: 'extension' });
  await fresh.session.waitForIdle();
  assert.equal(fresh.requests.length, 1, 'disk state does not arm the fresh live capability');
  const branch = fresh.session.sessionManager.getBranch();
  assert.equal(branch.some(entry => entry.type === 'custom_message' && entry.customType === 'spec-sentinel'), false);
  assert.equal(existsSync(join(f.packagePath, 'runtime', 'sentinel', 'wf-cont', 'intents')), false);
});

// Reads the single retained continuation intent from the fixture's workflow.
function readContinuationIntent(packagePath) {
  const intentsDir = join(packagePath, 'runtime', 'sentinel', 'wf-cont', 'intents');
  const names = readdirSync(intentsDir).filter(name => name.endsWith('.json'));
  assert.equal(names.length, 1, `expected exactly one retained intent, got ${names.length}`);
  return JSON.parse(readFileSync(join(intentsDir, names[0]), 'utf8'));
}

test('sentinel continuation: a later-handler veto retires the undelivered request and a later turn cannot deliver it', { skip: sdkSkip, timeout: 15000 }, async t => {
  // A later boundary handler removes the proposed draft and overrides
  // continue:false after this extension already reserved and requested its
  // continuation: the real SDK boundary composes the replacement and the
  // session settles without the continuation turn ever starting.
  const vetoFactory = pi => { pi.on('agent_before_settle', () => ({ entries: [], continue: false })); };
  const f = await continuationFixture(t, { mode: 'recover', factories: [vetoFactory] });
  await f.run.session.prompt('Run the vetoed continuation fixture.', { source: 'extension' });
  await f.run.session.waitForIdle();
  assert.equal(f.run.requests.length, 1, 'the vetoed continuation never made a provider request');
  const branch = f.run.session.sessionManager.getBranch();
  assert.equal(branch.some(entry => entry.type === 'custom_message' && entry.customType === 'spec-sentinel'), false,
    'the vetoed draft is not retained');
  // Settlement without delivery retires the still-pending request as an
  // explicitly unknown outcome: capacity stays consumed and no later turn can
  // mint a delivery receipt for a turn that never happened.
  let intent = readContinuationIntent(f.packagePath);
  assert.equal(intent.state, 'unknown');
  assert.equal(intent.reason_code, 'undelivered');
  // An unrelated later prompt must not mark the old request applied/delivered.
  await f.run.session.prompt('Unrelated later turn after the veto.', { source: 'extension' });
  await f.run.session.waitForIdle();
  assert.equal(f.run.requests.length, 2, 'one request per unrelated turn only');
  intent = readContinuationIntent(f.packagePath);
  assert.equal(intent.state, 'unknown', 'the undelivered request never becomes applied');
  assert.notEqual(intent.reason_code, 'delivered');
  assert.equal(readdirSync(join(f.packagePath, 'runtime', 'sentinel', 'wf-cont', 'intents')).length, 1,
    'the unknown outcome blocks automatic retry, so no second intent is reserved');
});

test('sentinel continuation: a post-reservation abort retires the undelivered request and a later turn cannot deliver it', { skip: sdkSkip, timeout: 15000 }, async t => {
  // A later boundary handler parks the real boundary composition on a test
  // gate, so the abort lands while agent_before_settle is still running —
  // after this extension already reserved and requested its continuation.
  let release = null;
  const gate = new Promise(resolve => { release = resolve; });
  const parkedFactory = pi => { pi.on('agent_before_settle', async () => { await gate; return undefined; }); };
  const f = await continuationFixture(t, { mode: 'recover', factories: [parkedFactory] });
  const intentsDir = join(f.packagePath, 'runtime', 'sentinel', 'wf-cont', 'intents');
  const run = f.run.session.prompt('Run the aborted continuation fixture.', { source: 'extension' });
  const deadline = Date.now() + 5000;
  let reserved = false;
  while (Date.now() < deadline) {
    const names = existsSync(intentsDir) ? readdirSync(intentsDir).filter(name => name.endsWith('.json')) : [];
    if (names.length > 0 && JSON.parse(readFileSync(join(intentsDir, names[0]), 'utf8')).state === 'requested') { reserved = true; break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(reserved, 'the continuation was reserved and requested before the abort');
  // Abort while the boundary is parked: the SDK drops the proposed
  // continuation and settles without starting its turn.
  const aborted = f.run.session.abort();
  release();
  await Promise.allSettled([run, aborted]);
  assert.equal(f.run.requests.length, 1, 'the aborted continuation never made a provider request');
  let intent = readContinuationIntent(f.packagePath);
  assert.equal(intent.state, 'unknown');
  assert.equal(intent.reason_code, 'undelivered');
  // An unrelated later prompt must not mark the old request applied/delivered.
  await f.run.session.prompt('Unrelated later turn after the abort.', { source: 'extension' });
  await f.run.session.waitForIdle();
  assert.equal(f.run.requests.length, 2, 'one request per unrelated turn only');
  intent = readContinuationIntent(f.packagePath);
  assert.equal(intent.state, 'unknown', 'the undelivered request never becomes applied');
  assert.notEqual(intent.reason_code, 'delivered');
  assert.equal(readdirSync(intentsDir).length, 1,
    'the unknown outcome blocks automatic retry, so no second intent is reserved');
});

test('sentinel delegation: the real adapter loads the profile and validates one correlated diagnosis', { skip: delegationSkip, timeout: 60000 }, async t => {
  const dir = sandbox(t);
  const { repo } = primary(dir, 'diagnosis-repo');
  commit(repo);
  const packagePath = pack(repo);
  const canonical = canonicalPackage(packagePath);
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'spec-sentinel-diagnostician.md'),
    readFileSync(join(here, '..', '..', 'agents', 'spec-sentinel-diagnostician.md')));
  const checkout = join(dir, 'diagnosis-checkout');
  mkdirSync(checkout, { recursive: true });

  recordCheckpoint({ package: canonical.packagePath, workflow_id: 'wf-diag', expected_revision: 0, state: 'ready',
    obligation: { key: 'diag:step-007', stage: 'implementation', summary: 'diagnose', artifacts: [] },
    workers: [], inbox: { items: [] }, reconciles_input_revision: 0, coordinator_session: 'session-diag', checkout });
  const policyPath = join(dir, 'diagnosis-policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, package: canonical.packagePath, workflow_id: 'wf-diag',
    checkout, coordinator_session: 'session-diag', mode: 'shadow', actions: [],
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    max_effects: 0, max_diagnostics: 2, diagnosis: { model: 'sentinel-fixture/scripted' }, authority_reference: 'user:fixture' }));
  const authority = createSentinelAuthority();
  activatePolicy(authority, { policy_path: policyPath, coordinator_session: 'session-diag', command: 'fixture' });

  const incidentA = incidentFixture(packagePath, 'a');
  const incidentB = incidentFixture(packagePath, 'b');
  const record = { id: 'run-diag-int', package: canonical.packagePath, checkout, assignment_id: 'assign-diag' };
  const { provider, calls, firstCall, releaseFirst } = deferredDiagnosisProvider(index => JSON.stringify({
    decision: 'cancel-candidate', fact_ids: ['incident.count'], reason_code: 'repeated-unchanged-failure',
    incident_id: [incidentA, incidentB][index].id, incident_generation: 1, note: 'fixture' }));
  let capturedPi;
  await loadExtension(t, { dir, providerFactory: () => provider, extraExtensionPaths: [piSubagentsPath],
    extraFactories: [pi => { capturedPi = pi; }] });

  const requests = [];
  let resolveFirstRequest;
  const firstRequest = new Promise(resolve => { resolveFirstRequest = resolve; });
  capturedPi.events.on('prompt-template:subagent:request', value => {
    requests.push(value);
    if (requests.length === 1) resolveFirstRequest(value);
  });
  const responses = [];
  capturedPi.events.on('prompt-template:subagent:response', value => { responses.push(value); });
  let clock = Date.now();
  const controller = createDiagnosisController({ authority, workflow_id: 'wf-diag', events: capturedPi.events, now: () => clock });
  const a = controller.diagnose(record, incidentA);
  const b = controller.diagnose(record, incidentB);
  await firstRequest;
  assert.equal(requests.length, 1, 'only the first diagnosis request is in flight');
  const request = requests[0];
  assert.equal(request.agent, 'spec-sentinel-diagnostician');
  assert.equal(request.nodeId, 'diagnostician');
  assert.equal(request.model, 'sentinel-fixture/scripted');
  assert.equal(request.context, 'fresh');
  assert.deepEqual(request.toolBudget, { hard: 0, block: '*' });
  assert.equal(request.skill, false);
  assert.equal(request.artifacts, false);
  assert.deepEqual(request.intercomBridge, { mode: 'off' });
  assert.deepEqual(request.result, { kind: 'text' });

  await firstCall;
  assert.equal(calls.length, 1, 'only the first provider request is in flight while the second incident waits');
  clock += 6 * 60 * 1000;
  releaseFirst();
  const [resultA, resultB] = await Promise.all([a, b]);
  assert.equal(responses.length, 2, `terminal responses: ${JSON.stringify(responses.map(r => ({ status: r.status, error: r.error })))}`);
  assert.equal(responses[0].status, 'completed', `delegation terminal status ${responses[0].status}: ${responses[0].error ?? ''}`);
  assert.equal(resultA.state, 'applied', `diagnosis A state ${resultA.state}: ${resultA.error ?? ''}`);
  assert.equal(resultB.state, 'applied', `diagnosis B state ${resultB.state}: ${resultB.error ?? ''}`);
  assert.equal(calls.length, 2, 'no extra or fallback provider request');
  assert.equal(resultA.state, 'applied');
  assert.equal(resultA.decision, 'cancel-candidate');
  assert.equal(resultA.reason_code, 'repeated-unchanged-failure');
  assert.equal(resultB.state, 'applied');
  assert.equal(resultB.decision, 'cancel-candidate');
  assert.equal(resultB.reason_code, 'repeated-unchanged-failure');
  assert.equal(requests.length, 2, 'the second diagnosis also reached the real adapter');
  const second = requests[1];
  assert.equal(second.agent, 'spec-sentinel-diagnostician');
  assert.equal(second.nodeId, 'diagnostician');
  const stored = readDiagnosisAttempt(packagePath, 'wf-diag', incidentA.id);
  assert.equal(stored.decision, 'cancel-candidate');
  assert.deepEqual(stored.fact_ids, ['incident.count']);
  assert.equal(stored.reason_code, 'repeated-unchanged-failure');
  assert.equal(typeof stored.usage_available, 'boolean');

  const duplicate = await controller.diagnose(record, incidentA);
  assert.equal(duplicate.launched, false);
  assert.equal(duplicate.state, 'duplicate');
  assert.equal(calls.length, 2);
});
