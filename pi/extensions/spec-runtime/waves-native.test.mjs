// Native wave-routing boundary tests (step 10, test-first).
//
// This suite pins the contract of the routing boundary split out of index.ts:
//
//   nativeWaveAction(input) -> the native wave-controller entry name
//     ('startup' | 'advance' | 'recover' | 'status' | 'cancel'), or null when
//     the action stays on the legacy per-run path.
//   createNativeWaveController(config) -> production factory that binds the
//     shared ownership handle, host policy budgets and the lifecycle seam, then
//     builds the wave controller through the injected createController seam.
//
// The implementation does not exist yet, so this suite is red at the import
// boundary: `./waves-native.mjs` cannot be resolved. The assertions below are
// the contract the implementation must satisfy; importing an absent module is
// the expected red evidence for this packet.
import test from 'node:test';
import assert from 'node:assert/strict';

import { nativeWaveAction, createNativeWaveController } from './waves-native.mjs';

test('wave dispatch: native action routing splits wave entries from the legacy step route', () => {
  const wave = { wave_id: 'wave-1', run_id: 'run-1' };

  // startup/advance/recover are native wave entries regardless of wave_id.
  assert.equal(nativeWaveAction({ action: 'startup' }), 'startup');
  assert.equal(nativeWaveAction({ action: 'startup', ...wave }), 'startup');
  assert.equal(nativeWaveAction({ action: 'advance' }), 'advance');
  assert.equal(nativeWaveAction({ action: 'advance', ...wave }), 'advance');
  assert.equal(nativeWaveAction({ action: 'recover' }), 'recover');
  assert.equal(nativeWaveAction({ action: 'recover', ...wave }), 'recover');

  // status/cancel are native only when a nonempty wave_id names a durable wave.
  assert.equal(nativeWaveAction({ action: 'status', wave_id: 'wave-1' }), 'status');
  assert.equal(nativeWaveAction({ action: 'cancel', wave_id: 'wave-1' }), 'cancel');
  assert.equal(nativeWaveAction({ action: 'status' }), null);
  assert.equal(nativeWaveAction({ action: 'status', wave_id: '' }), null);
  assert.equal(nativeWaveAction({ action: 'cancel' }), null);
  assert.equal(nativeWaveAction({ action: 'cancel', wave_id: '' }), null);

  // A run_id alone keeps status/cancel on the legacy per-run route.
  assert.equal(nativeWaveAction({ action: 'status', run_id: 'run-1' }), null);
  assert.equal(nativeWaveAction({ action: 'cancel', run_id: 'run-1' }), null);
  assert.equal(nativeWaveAction({ action: 'status', run_id: 'run-1', wave_id: 'wave-1' }), 'status');
  assert.equal(nativeWaveAction({ action: 'cancel', run_id: 'run-1', wave_id: 'wave-1' }), 'cancel');

  // start launches a prepared step, never a wave, even with a wave_id.
  assert.equal(nativeWaveAction({ action: 'start' }), null);
  assert.equal(nativeWaveAction({ action: 'start', ...wave }), null);
});

test('wave dispatch: native factory binds shared ownership, host budgets and lifecycle seams', async () => {
  const coordinatorIdentity = { session: 'coordinator-session', pid: 4242, started_at: 'opaque-start', epoch: 7 };
  const coordinator = () => coordinatorIdentity;
  const location = { package_dir: '/fixture/package', targets: [] };
  const serviceAdapter = { inspect: async () => ({ status: 'confirmed' }) };
  const review = { readReviewState() {} };
  const integration = { readWaveRecord() {} };
  const checkpoint = { readCheckpointRecord() {} };
  const send = () => ({ delivered: true });
  const indexDir = '/fixture/index';

  // The Runtime is built by the caller with an existing ownership handle; the
  // factory binds the budgets it derives from the ready host policy.
  const runtimeOwnership = {
    facade: 'runtime-ownership',
    inspectClaims: () => ({ before: true })
  };
  const runtime = { ownership: runtimeOwnership, serviceAdapter, location };

  let ownershipCalls = 0;
  let ownershipArgs = null;
  const budgetedHandle = {
    inspectClaims: () => ({ claims: [] }),
    // Delegated ownership calls are forwarded into the budgeted backend.
    probe: args => ({ backend: 'budgeted', args })
  };
  const ownershipFactory = ({ registryRoot, budgets }) => {
    ownershipCalls += 1;
    ownershipArgs = { registryRoot, budgets };
    return budgetedHandle;
  };

  const hostCalls = [];
  const hostCheck = async args => {
    hostCalls.push(args);
    return { status: 'ready', policy: { poolMemoryBytes: 4096, aggregateTasks: 100 } };
  };

  let captured = null;
  const controllerSentinel = { progressing: () => false };
  const createController = deps => { captured = deps; return controllerSentinel; };

  const controller = await createNativeWaveController({
    runtime,
    coordinator,
    send,
    indexDir,
    hostCheck,
    ownershipFactory,
    review,
    integration,
    checkpoint,
    location,
    createController
  });

  assert.equal(controller, controllerSentinel, 'the factory returns the controller it built');

  // Construction must not probe the host; the probe only runs on demand.
  assert.deepEqual(hostCalls, [], 'construction does not probe the host');
  assert.equal(captured.ownership, runtime.ownership, 'stable ownership facade is installed before a probe');
  assert.notEqual(captured.ownership, runtimeOwnership);
  assert.deepEqual(captured.ownership.inspectClaims(), { before: true }, 'the pre-probe facade delegates to the runtime ownership sentinel');

  // Every injected seam is forwarded to the wave controller factory.
  assert.equal(captured.runtime, runtime, 'the same Runtime is forwarded');
  assert.equal(captured.location, location, 'the caller location is forwarded');
  assert.equal(captured.review, review, 'the review namespace is forwarded');
  assert.equal(captured.integration, integration, 'the integration namespace is forwarded');
  assert.equal(captured.checkpoint, checkpoint, 'the checkpoint namespace is forwarded');
  assert.equal(captured.send, send, 'the send double is forwarded');

  // The lifecycle seam exposes only read-only liveness inspection.
  assert.equal(typeof captured.lifecycle?.inspect, 'function', 'lifecycle.inspect is callable');
  assert.deepEqual(
    await captured.lifecycle.inspect({ service: 'run-1' }, { ownershipVerified: true }),
    { status: 'confirmed' },
    'lifecycle.inspect forwards the service run and ownership flag to the adapter'
  );

  // The coordinator is passed through as-is.
  assert.equal(captured.coordinator, coordinator, 'the coordinator closure is forwarded directly');

  // The captured hostCheck seam forwards to the injected host probe.
  const probed = await captured.hostCheck({ readyMembers: 4, explicitCap: 2 });
  assert.equal(probed.status, 'ready');
  assert.deepEqual(hostCalls, [{ mode: 'probe', readyMembers: 4, explicitCap: 2 }], 'hostCheck is probed in probe mode');

  // After the ready host policy, the ownership factory is invoked exactly once
  // with the registry root and the policy budgets.
  assert.equal(ownershipCalls, 1, 'the ownership factory is used exactly once');
  assert.deepEqual(ownershipArgs, {
    registryRoot: '/fixture/index/ownership',
    budgets: { memoryBytes: 4096, tasks: 100 }
  });

  // The runtime and the captured deps share one stable delegating facade, and
  // the facade reaches the newly created budgeted backend.
  assert.equal(runtime.ownership, captured.ownership, 'runtime and controller share the ownership facade');
  assert.equal(typeof captured.ownership.inspectClaims, 'function', 'facade.inspectClaims is callable');
  assert.deepEqual(captured.ownership.inspectClaims(), budgetedHandle.inspectClaims());
  assert.deepEqual(captured.ownership.probe({ wave: 'wave-1' }), { backend: 'budgeted', args: { wave: 'wave-1' } });

  assert.equal(runtime.ownership, captured.ownership, 'the shared facade survives a probe');
});
