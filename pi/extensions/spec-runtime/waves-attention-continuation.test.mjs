// Regression for step-013 line 36: a successful active native wave dispatch
// must stop the SDK's automatic tool continuation and await genuine attention.
//
// The coordinator turn that calls spec_dispatch startup ends with a tool
// result. If the tool result does not set `terminate`, the SDK immediately
// issues a follow-up request that carries no new attention message, so the
// coordinator speaks into a silence it cannot see. The real surface for that
// decision is the returned tool receipt, so this case executes the REAL
// registered spec_dispatch tool from the installed index.ts over the real
// composed native controller and asserts `terminate === true`.
//
// The controller transport is synthetic (fixture host check, fixture owners,
// loopback members) and therefore kernel_proof=false; the installed index and
// the composed controller themselves are real, and the terminate flag is
// produced by production code, never injected into a shim.
//
// Helper functions stay local and compact on purpose: this file adds coverage
// only and does not touch existing suites or production code.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { SDK_LOADER, loadSdk } from './wave-review-fixture.mjs';
import { makeCase4Fixture, waitFor } from './waves-fixture.mjs';
import { installInstalledIndex, mutateTwoWaveIndex, twoWaveHostCheck, MODELS } from './waves-index-fixture.mjs';

const SDK_AVAILABLE = typeof loadSdk === 'function' && existsSync(SDK_LOADER);

// The installed loader registers hooks on `extension.handlers`; read them the
// same way the existing installed-index cases do.
function hooksOf(extension, name) {
  assert.ok(extension?.handlers && typeof extension.handlers.get === 'function',
    'the installed loader must expose the SDK handlers map on the extension');
  const list = extension.handlers.get(name);
  assert.ok(Array.isArray(list) && list.length > 0, `the installed extension must register a ${name} handler`);
  return list;
}

// Minimal coordinator context: a stable session identity for the composed
// index's own coordinator bindings.
function ctxOf(root, session) {
  return {
    model: { provider: 'fixture', id: 'owner' },
    sessionManager: {
      getSessionFile: () => join(root, 'session.jsonl'),
      getSessionId: () => session,
      getBranch: () => []
    },
    ui: { notify() {} },
    isIdle: () => true,
    hasPendingMessages: () => false
  };
}

// A missing installed SDK is a hard failure here, never a skip.
function requireSdk() {
  assert.ok(SDK_AVAILABLE, `the installed pi SDK loader is required for this case: ${SDK_LOADER}`);
}

test('wave native: successful active wave dispatch terminates the tool turn and awaits attention (step-013 line 36)', { timeout: 120_000 }, async (t) => {
  requireSdk();
  const { loadExtensions, createExtensionRuntime } = await loadSdk();

  // Two-wave package with held owners: steps 1/2 open wave 1 and dependent step
  // 3 opens wave 2, so a successful startup returns an active, running wave.
  const f = await makeCase4Fixture(t, {
    memberCount: 3,
    hostCheck: twoWaveHostCheck(),
    mutateIndex: mutateTwoWaveIndex,
    holdOwners: true
  });
  const composed = installInstalledIndex({ root: f.pkg.dir, deps: f.controllerDependencies() });
  t.after(() => composed.cleanup());

  // Run with no spec-runtime role so the composed index resolves its own
  // coordinator identity from the fixture session.
  const previousRole = process.env.SPEC_RUNTIME_ROLE;
  delete process.env.SPEC_RUNTIME_ROLE;
  t.after(() => {
    if (previousRole === undefined) delete process.env.SPEC_RUNTIME_ROLE;
    else process.env.SPEC_RUNTIME_ROLE = previousRole;
  });

  const runtime = createExtensionRuntime();
  runtime.getAllTools = () => [];
  runtime.getSettings = () => ({});
  runtime.setActiveTools = () => {};
  runtime.appendEntry = () => {};
  runtime.sendMessage = () => {};

  const loaded = await loadExtensions([composed.indexPath], f.pkg.dir, undefined, runtime);
  assert.deepEqual(loaded.errors, [], 'the installed loader must load the rewritten index.ts without errors');
  const extension = loaded.extensions?.[0] ?? loaded;
  const tools = extension.tools ?? loaded.tools;
  assert.ok(tools?.has?.('spec_dispatch'), 'the composed index.ts must register the native spec_dispatch tool');

  const controller = composed.controller;
  assert.ok(controller && typeof controller.routeNotification === 'function',
    'the real createNativeWaveController must run inside the installed loader and expose a live controller');
  f.bindController(controller);

  const ctx = ctxOf(f.pkg.dir, f.coordinator.session);
  for (const hook of hooksOf(extension, 'session_start')) await hook({ type: 'session_start' }, ctx);
  t.after(async () => {
    for (const hook of hooksOf(extension, 'session_shutdown')) await hook({ type: 'session_shutdown', reason: 'quit' }, ctx);
  });

  const receipt = await tools.get('spec_dispatch').definition.execute(
    `waves-attention-${process.pid}`,
    { action: 'startup', package: f.packagePath, execution: 'waves', isolation: 'worktree', ...MODELS },
    undefined, undefined, ctx
  );
  const text = JSON.stringify(receipt);
  assert.doesNotMatch(text, /is not a function|TypeError|Cannot read propert(y|ies)/i,
    `native dispatch must reach the real composed controller: ${text}`);
  assert.doesNotMatch(text, /index-unreadable/i,
    `a complete mutated index must not surface an unreadable refusal: ${text}`);

  const details = receipt?.details ?? receipt;
  assert.ok(details?.wave_id, `a successful startup must return a durable wave id: ${text}`);
  assert.equal(details.execution, 'waves', `the accepted dispatch must report execution waves: ${text}`);
  assert.equal(details.state, 'running', `an active wave dispatch must report state running: ${text}`);

  // The regression under test: an active wave dispatch must end the tool turn
  // so the SDK does not automatically issue an attention-less follow-up request.
  assert.equal(receipt?.terminate, true,
    `an active wave dispatch must terminate the tool turn so the SDK does not issue an automatic attention-less post-tool request: ${text}`);

  // Let the wave owners actually make progress, proving this is a live wave and
  // not an early refusal that happened to carry a wave id.
  await waitFor(() => f.launches.filter(launch => launch.role === 'owner').length >= 2,
    15_000, 'two wave owners launched for the terminated active dispatch');
});
