// Regression tests for step-010 review findings F10-1, F10-2 and F10-3 at the
// actual index.ts composition boundary.
//
// The non-skipped seam test extracts the real Runtime/waveController binding
// block from index.ts, strips only TypeScript value annotations, and evaluates
// it against the REAL createNativeWaveController factory with an injected
// createController seam. It proves:
//   F10-1  the binding stores a synchronously callable controller (not the
//          factory Promise), and a terminal legacy notification still reaches
//          reconcileRuntimeReturn + pi.sendMessage when routeNotification
//          returns false;
//   F10-2  the coordinator supplies a stable safe-integer epoch together with
//          the real session/pid/start identity over repeated calls, startup,
//          recovery and shutdown;
//   F10-3  the controller send adapter forwards the original spec-wave
//          envelope and options by reference (barrier attention true, routine
//          next-wave false).
//
// A separate SDK-gated test loads the installed index.ts through the real
// package loader and proves native spec_dispatch reaches the controller with a
// structured receipt instead of a TypeError. It skips only when the installed
// loader is absent; the seam test never skips.
//
// These tests add coverage only. They do not edit production code or existing
// tests.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { SPEC_RUNTIME_INDEX, SDK_LOADER, loadSdk } from './wave-review-fixture.mjs';
import { createNativeWaveController, nativeWaveAction } from './waves-native.mjs';
import { makePackageFixture } from './package-fixture.mjs';

const here = dirname(fileURLToPath(new URL(import.meta.url)));
const INDEX_PATH = SPEC_RUNTIME_INDEX;
const SDK_LOADER_PATH = SDK_LOADER;
const SDK_AVAILABLE = typeof loadSdk === 'function' && existsSync(SDK_LOADER_PATH);

// -- extraction ------------------------------------------------------------

// Return the index of the closing quote of the string starting at `i`.
function skipString(source, i) {
  const quote = source[i];
  if (quote === '`') {
    i += 1;
    let depth = 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '$' && source[i + 1] === '{') { depth += 1; i += 2; continue; }
      if (ch === '}' && depth > 0) { depth -= 1; i += 1; continue; }
      if (ch === '`' && depth === 0) return i;
      i += 1;
    }
    return i;
  }
  i += 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i;
    i += 1;
  }
  return i;
}

// Extract from `let waveController` through the closing paren of the
// createNativeWaveController(...) call, swallowing only balanced parentheses.
function extractBindingBlock(source) {
  const start = source.indexOf('let waveController');
  assert.ok(start >= 0, 'index.ts must declare `let waveController`');
  const callStart = source.indexOf('createNativeWaveController(', start);
  assert.ok(callStart >= 0, 'index.ts must call createNativeWaveController after the binding');
  const open = source.indexOf('(', callStart);
  let depth = 0;
  let i = open;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(source, i); continue; }
    if (ch === '/' && source[i + 1] === '/') { const nl = source.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
    if (ch === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i); i = end < 0 ? source.length : end + 1; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) break; }
  }
  return `${source.slice(start, i + 1)};`;
}

// Strip only TypeScript value annotations (`: any`, `: string`, ...) and `as`
// casts. Everything else is retained byte-for-byte.
function stripTypeAnnotations(code) {
  return code
    .replace(/:\s*any\b/g, '')
    .replace(/\bas\s+(?:any|unknown|string|number|boolean|void|[A-Z][\w$.]*)\b/g, '');
}

// A `with` scope whose object environment resolves free identifiers to
// globalThis and whose reads/writes flow through `target` so later mutations
// (e.g. sessionCtx) are visible to closures created by the evaluated block.
function makeScope(target) {
  return new Proxy(target, {
    has: () => true,
    get: (t, prop) => (prop in t ? t[prop] : globalThis[prop]),
    set: (t, prop, value) => { t[prop] = value; return true; },
  });
}

class AlwaysGetMap extends Map {
  get(key) {
    const direct = super.get(key);
    return direct !== undefined ? direct : this._fallback;
  }
  setFallback(value) { this._fallback = value; }
}

let randomIntCalls = 0;
let uuidCalls = 0;

async function evaluateIndexBinding() {
  randomIntCalls = 0;
  uuidCalls = 0;
  const block = stripTypeAnnotations(extractBindingBlock(readFileSync(INDEX_PATH, 'utf8')));

  const calls = { sendMessage: [], reconcile: [] };
  const created = [];
  let runtimeOptions = null;
  let routeNotificationReturn = false;

  const controller = {
    routeNotification: () => routeNotificationReturn,
    startup: (input, parentSession) => ({ run_id: 'run-startup', state: 'running', input, parentSession }),
    advance: () => ({ run_id: 'run-advance', state: 'running' }),
    recover: () => ({ run_id: 'run-recover', state: 'running' }),
    status: () => ({ run_id: 'run-status', state: 'running' }),
    cancel: () => ({ run_id: 'run-cancel', state: 'cancelled' }),
    progressing: () => false,
    shutdown: async () => ({ state: 'shutdown' }),
  };

  const dispatchBindings = new AlwaysGetMap();
  const scope = makeScope({
    Runtime: class RuntimeStub {
      constructor(options) { runtimeOptions = options; this.ownership = undefined; this.serviceAdapter = undefined; this.location = undefined; }
    },
    getAgentDir: () => join(tmpdir(), 'waves-index-agent'),
    join,
    coordinatorIdentity: (ctx) => ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionId ?? 'session-fallback',
    processIdentity: (pid) => ({ pid, started_at: '2024-01-01T00:00:00.000Z' }),
    inspectProcess: (pid) => ({ pid, started_at: '2024-01-01T00:00:00.000Z' }),
    randomInt: () => (randomIntCalls += 1),
    randomUUID: () => `uuid-${(uuidCalls += 1)}`,
    sessionCtx: { sessionManager: { getSessionId: () => 'session-1' } },
    dispatchBindings,
    reconcileRuntimeReturn: (input) => { calls.reconcile.push(input); },
    readCheckpointRecord: () => ({ revision: 7, workers: [], checkout: '/tmp/checkout', coordinator_session: 'session-1' }),
    createVerificationRecorder: () => ({ observe: () => undefined }),
    verificationRecorder: { observe: () => undefined },
    diagnoseObserved: () => {},
    pi: { sendMessage: (envelope, options) => { calls.sendMessage.push({ envelope, options }); } },
    createNativeWaveController: (options) => createNativeWaveController({
      ...options,
      createController: (deps) => { created.push(deps); return controller; },
    }),
    nativeWaveAction,
  });

  const body = `with (scope) {\n${block}\nreturn { waveController, runtime };\n}`;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const evaluated = await new AsyncFunction('scope', body)(scope);
  return {
    ...evaluated,
    controller,
    deps: created[0],
    calls,
    scope,
    dispatchBindings,
    runtimeOptions: () => runtimeOptions,
    setRoute: (value) => { routeNotificationReturn = value; },
  };
}

// -- F10-1: synchronous binding -------------------------------------------

test('index.ts binds a synchronously callable native controller (F10-1)', async () => {
  const { waveController, controller, deps } = await evaluateIndexBinding();
  assert.ok(waveController, 'the binding must resolve to a controller');
  assert.equal(typeof waveController.then, 'undefined', 'the binding must not store the async factory Promise');
  assert.strictEqual(waveController, controller, 'the injected controller must be stored synchronously');
  for (const name of ['startup', 'advance', 'recover', 'routeNotification', 'progressing', 'shutdown']) {
    assert.equal(typeof waveController[name], 'function', `waveController.${name} must be immediately callable`);
  }
  assert.ok(deps, 'the factory must reach the synchronous createController seam');
  const receipt = waveController.startup({ action: 'startup' }, '/tmp/session.json');
  assert.equal(typeof receipt?.then, 'undefined', 'startup must reach the synchronous controller seam, not a Promise');
  assert.equal(receipt.run_id, 'run-startup');
  assert.equal(waveController.progressing(), false);
  await waveController.shutdown();
});

test('index.ts terminal legacy notification reconciles and notifies when routeNotification declines (F10-1)', async () => {
  const { runtimeOptions, calls, dispatchBindings, setRoute } = await evaluateIndexBinding();
  const binding = { package: '/tmp/pkg', run_id: 'run-1', workflow_id: 'wf-1', assignment_id: 'a1', checkout: '/tmp/checkout', coordinator_session: 'session-1' };
  dispatchBindings.setFallback(binding);
  const value = { package: '/tmp/pkg', run_id: 'run-1', workflow_id: 'wf-1', state: 'completed' };
  setRoute(false);
  const notify = runtimeOptions()?.notify;
  assert.equal(typeof notify, 'function', 'the Runtime must be constructed with a notify callback');
  assert.doesNotThrow(() => notify(value), 'the legacy notify callback must not hit the un-awaited factory Promise');
  assert.equal(calls.reconcile.length, 1, 'a terminal legacy notification must reach reconcileRuntimeReturn');
  assert.match(JSON.stringify(calls.reconcile[0]), /wf-1/);
  const last = calls.sendMessage.at(-1);
  assert.equal(last.envelope.customType, 'spec-runtime');
  assert.equal(last.envelope.content, JSON.stringify(value));
  assert.deepEqual(last.options, { triggerTurn: true });
});

// -- F10-2: coordinator epoch / identity -----------------------------------

test('index.ts coordinator supplies a stable safe-integer epoch and real identity over lifecycle calls (F10-2)', async () => {
  const { deps, scope, waveController } = await evaluateIndexBinding();
  const first = deps.coordinator();
  assert.ok(Number.isSafeInteger(first.epoch), `coordinator epoch must be a safe integer, got ${String(first.epoch)}`);
  assert.equal(first.session, 'session-1');
  assert.equal(first.pid, process.pid);
  assert.equal(first.started_at, '2024-01-01T00:00:00.000Z');

  // Repeated calls keep the epoch stable even when the live session changes;
  // regenerating identity per call would break package-claim/recovery fencing.
  scope.sessionCtx = { sessionManager: { getSessionId: () => 'session-2' } };
  const second = deps.coordinator();
  assert.equal(second.epoch, first.epoch, 'the coordinator epoch must not be regenerated per call');
  assert.equal(second.session, 'session-2', 'the coordinator must read the live session identity');

  // Startup, recovery and shutdown must not disturb the retained epoch.
  waveController.startup({ action: 'startup' }, '/tmp/session.json');
  waveController.recover({ action: 'recover' });
  assert.equal(deps.coordinator().epoch, first.epoch);
  await waveController.shutdown();
  assert.equal(deps.coordinator().epoch, first.epoch);
});

// -- F10-3: send forwarding -------------------------------------------------

test('index.ts forwards the original spec-wave envelope and options unchanged (F10-3)', async () => {
  const { deps, calls } = await evaluateIndexBinding();
  const attention = { customType: 'spec-wave', content: JSON.stringify({ kind: 'wave-barrier', attention: true }), display: true };
  const attentionOptions = { triggerTurn: true };
  deps.send(attention, attentionOptions);
  let last = calls.sendMessage.at(-1);
  assert.strictEqual(last.envelope, attention, 'barrier attention must forward the original envelope by reference');
  assert.strictEqual(last.options, attentionOptions, 'barrier attention must forward the original options by reference');

  const routine = { customType: 'spec-wave', content: JSON.stringify({ kind: 'next-wave', wave_id: 'w1', state: 'integrated' }), display: true };
  const routineOptions = { triggerTurn: false };
  deps.send(routine, routineOptions);
  last = calls.sendMessage.at(-1);
  assert.strictEqual(last.envelope, routine, 'routine next-wave must forward the original envelope by reference');
  assert.strictEqual(last.options, routineOptions, 'routine next-wave must forward the original options by reference');
});

// -- factory export contract ------------------------------------------------

test('createNativeWaveController passes the injected controller result through unchanged', () => {
  const syncController = { id: 'sync' };
  const syncResult = createNativeWaveController({ createController: () => syncController });
  assert.strictEqual(syncResult, syncController, 'a synchronous controller must be returned synchronously');
  assert.equal(typeof syncResult.then, 'undefined');

  const promised = Promise.resolve({ id: 'async' });
  const promiseResult = createNativeWaveController({ createController: () => promised });
  assert.strictEqual(promiseResult, promised, 'an injected Promise must be passed through unchanged');
});

// -- SDK-gated composition ---------------------------------------------------

function hooksOf(extension, name) {
  assert.ok(extension && typeof extension === 'object', 'the installed loader must expose the extension object');
  assert.ok(extension.handlers && typeof extension.handlers.get === 'function',
    'the installed loader must expose the SDK handlers map on the extension');
  const list = extension.handlers.get(name);
  assert.ok(Array.isArray(list) && list.length > 0,
    `the installed extension must register at least one ${name} handler`);
  return list;
}

test('installed loader composes index.ts native dispatch; settle and shutdown stay clean', { skip: SDK_AVAILABLE ? false : 'installed pi SDK loader not found', timeout: 60_000 }, async (t) => {
  const { loadExtensions, createExtensionRuntime } = await loadSdk();
  // A real package fixture gives the locator a valid kit.yaml, locations.json
  // and repository, so native routing reaches the controller instead of
  // refusing earlier. The package deliberately has no spec-steps.json, so the
  // controller returns its own index-unreadable refusal rather than launching.
  const f = await makePackageFixture({ prefix: 'waves-index-sdk-', slug: 'fixture' });
  const root = f.dir;
  const packageDir = f.packagePath;
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // The kit must advertise this machine's host: the native on-host check
  // compares the kit's execution_host with the running hostname.
  const kitPath = join(f.workspaceDir, 'kit.yaml');
  writeFileSync(kitPath, readFileSync(kitPath, 'utf8').replace('execution_host: box', `execution_host: ${hostname()}`));

  mkdirSync(join(root, 'runtime', 'runs'), { recursive: true });
  writeFileSync(join(root, 'runtime', 'runs', 'fixture.json'), JSON.stringify({
    id: 'fixture', state: 'running', package: packageDir, checkout: packageDir,
    step: join(packageDir, 'step-001-subspec.md'), completion_contract: 1,
  }));

  const previous = {};
  for (const key of ['SPEC_RUNTIME_ROLE', 'SPEC_RUNTIME_RECORD', 'PI_CODING_AGENT_DIR', 'ADJACENT_STORAGE_ROOT']) {
    previous[key] = process.env[key];
  }
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.ADJACENT_STORAGE_ROOT = join(root, 'storage');
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  mkdirSync(join(process.env.ADJACENT_STORAGE_ROOT, 'projects'), { recursive: true });
  delete process.env.SPEC_RUNTIME_ROLE;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const runtime = createExtensionRuntime();
  runtime.getAllTools = () => [];
  runtime.getSettings = () => ({});
  runtime.setActiveTools = () => {};
  runtime.appendEntry = () => {};
  runtime.sendMessage = () => {};

  const loaded = await loadExtensions([INDEX_PATH], root, undefined, runtime);
  assert.deepEqual(loaded.errors, [], 'the installed loader must load index.ts without errors');
  const extension = loaded.extensions?.[0] ?? loaded;
  const tools = extension.tools ?? loaded.tools;
  assert.ok(tools?.has?.('spec_dispatch'), 'coordinator mode must register the native spec_dispatch tool');
  // Assert the hooks exist up front, so a missing composition cannot pass
  // vacuously through an empty hook list below.
  const sessionStartHooks = hooksOf(extension, 'session_start');
  const settleHooks = hooksOf(extension, 'agent_before_settle');
  const shutdownHooks = hooksOf(extension, 'session_shutdown');

  const ctx = {
    model: { provider: 'fixture', id: 'owner' },
    sessionManager: {
      getSessionFile: () => join(root, 'session.jsonl'),
      getSessionId: () => 'waves-index-session',
      getBranch: () => [],
    },
    ui: { notify() {} },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
  for (const hook of sessionStartHooks) await hook({ type: 'session_start' }, ctx);

  // Shutdown always runs, even when a preceding assertion fails, so a monitor
  // started by session_start is torn down through the real hook.
  t.after(async () => {
    for (const hook of shutdownHooks) await hook({ type: 'session_shutdown', reason: 'quit' }, ctx);
  });

  const dispatchTool = tools.get('spec_dispatch');
  let receipt;
  try {
    receipt = await dispatchTool.definition.execute(
      'waves-index-call',
      { action: 'startup', package: packageDir, owner_model: 'fixture/owner', execution: 'auto' },
      undefined, undefined, ctx,
    );
  } catch (error) {
    assert.fail(`native dispatch threw instead of returning a structured receipt: ${error?.message}`);
  }
  const text = JSON.stringify(receipt);
  assert.doesNotMatch(text, /is not a function|TypeError|Cannot read propert(y|ies)/i,
    `native dispatch must reach the real binding, not the un-awaited factory Promise: ${text}`);
  assert.doesNotMatch(text, /coordinator-missing/i,
    `native dispatch must not refuse on the coordinator identity: ${text}`);
  // Reaching the controller on a real package also proves the locator accepted
  // the fixture kit; the deliberate absence of spec-steps.json then surfaces the
  // controller's own structured index-unreadable refusal.
  const expectedMissingIndex = `index-unreadable: ${join(packageDir, 'spec-steps.json')} is missing or unparseable`;
  assert.equal(receipt?.details?.error, expectedMissingIndex,
    `an absent spec-steps.json must return the controller index-unreadable refusal, got: ${text}`);

  // Settle must remain clean once the native entry is composed. Shutdown is
  // handled by the t.after cleanup above, so it still runs on failure.
  for (const hook of settleHooks) {
    await hook({ type: 'agent_before_settle', outcome: 'completed', entries: [], context: { pendingMessages: [] } }, ctx);
  }
});

test('installed loader surfaces the controller index-unreadable refusal for an absent spec-steps.json', { skip: SDK_AVAILABLE ? false : 'installed pi SDK loader not found', timeout: 60_000 }, async (t) => {
  const { loadExtensions, createExtensionRuntime } = await loadSdk();
  // A real package fixture gives the locator a valid kit.yaml, locations.json
  // and repository, so native routing reaches the controller instead of
  // refusing earlier. The package deliberately has no spec-steps.json.
  const f = await makePackageFixture({ prefix: 'waves-index-unreadable-', slug: 'fixture' });
  const root = f.dir;
  const packageDir = f.packagePath;
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // The kit must advertise this machine's host: the native on-host check
  // compares the kit's execution_host with the running hostname.
  const kitPath = join(f.workspaceDir, 'kit.yaml');
  writeFileSync(kitPath, readFileSync(kitPath, 'utf8').replace('execution_host: box', `execution_host: ${hostname()}`));

  mkdirSync(join(root, 'runtime', 'runs'), { recursive: true });
  writeFileSync(join(root, 'runtime', 'runs', 'fixture.json'), JSON.stringify({
    id: 'fixture', state: 'running', package: packageDir, checkout: packageDir,
    step: join(packageDir, 'step-001-subspec.md'), completion_contract: 1,
  }));
  assert.equal(existsSync(join(packageDir, 'spec-steps.json')), false,
    'the unreadable-index fixture must not contain spec-steps.json');

  const previous = {};
  for (const key of ['SPEC_RUNTIME_ROLE', 'SPEC_RUNTIME_RECORD', 'PI_CODING_AGENT_DIR', 'ADJACENT_STORAGE_ROOT']) {
    previous[key] = process.env[key];
  }
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.ADJACENT_STORAGE_ROOT = join(root, 'storage');
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  mkdirSync(join(process.env.ADJACENT_STORAGE_ROOT, 'projects'), { recursive: true });
  delete process.env.SPEC_RUNTIME_ROLE;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const runtime = createExtensionRuntime();
  runtime.getAllTools = () => [];
  runtime.getSettings = () => ({});
  runtime.setActiveTools = () => {};
  runtime.appendEntry = () => {};
  runtime.sendMessage = () => {};

  const loaded = await loadExtensions([INDEX_PATH], root, undefined, runtime);
  assert.deepEqual(loaded.errors, [], 'the installed loader must load index.ts without errors');
  const extension = loaded.extensions?.[0] ?? loaded;
  const tools = extension.tools ?? loaded.tools;
  assert.ok(tools?.has?.('spec_dispatch'), 'coordinator mode must register the native spec_dispatch tool');

  const ctx = {
    model: { provider: 'fixture', id: 'owner' },
    sessionManager: {
      getSessionFile: () => join(root, 'session.jsonl'),
      getSessionId: () => 'waves-index-unreadable-session',
      getBranch: () => [],
    },
    ui: { notify() {} },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
  for (const hook of hooksOf(extension, 'session_start')) await hook({ type: 'session_start' }, ctx);
  t.after(async () => {
    for (const hook of hooksOf(extension, 'session_shutdown')) await hook({ type: 'session_shutdown', reason: 'quit' }, ctx);
  });

  const dispatchTool = tools.get('spec_dispatch');
  const receipt = await dispatchTool.definition.execute(
    'waves-index-unreadable-call',
    { action: 'startup', package: packageDir, owner_model: 'fixture/owner', execution: 'auto' },
    undefined, undefined, ctx,
  );
  const text = JSON.stringify(receipt);
  // The deliberate absence of spec-steps.json must surface the controller's own
  // structured refusal: readJsonFile returns ok:false, startup throws
  // unreadable('index-unreadable', <spec-steps.json path>), and the dispatch
  // catch returns that exact message. Asserting the exact message also rules
  // out a masked absence TypeError.
  const expectedMessage = `index-unreadable: ${join(packageDir, 'spec-steps.json')} is missing or unparseable`;
  assert.equal(receipt?.details?.error, expectedMessage,
    `an absent spec-steps.json must return the controller index-unreadable refusal, got: ${text}`);
  assert.doesNotMatch(text, /is not a function|TypeError|Cannot read propert(y|ies)/i,
    `the refusal must be the controller index-unreadable error, not an absence TypeError: ${text}`);
});
