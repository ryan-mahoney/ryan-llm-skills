// Saved-policy / native-default boundary regression (step 13, F1).
//
// This pins the join between an installed host policy and the native wave
// controller: a policy installed with lifecycleMemoryMib 2048 / lifecycleTasks
// 384 must be the policy the controller's default host check observes. Only
// the isolated host fixture supplies the environment; the policy values and the
// host-check seam are the production defaults, so a regression that reads a
// fabricated 3 GiB policy instead of the saved 2 GiB policy is red here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runtimeHostCommand } from './linux-resources.mjs';
import { createNativeWaveController } from './waves-native.mjs';
import { isolatedHost, GIB } from './linux-resources-fix-fixture.mjs';

const SAVED = { lifecycleMemoryMib: 2048, lifecycleTasks: 384 };

test('wave native: saved lifecycle policy reaches the native controller default host check', async t => {
  const { fixture, run, calls, options } = await isolatedHost(t);

  // Install the operator policy through the production setup action with the
  // isolated host. Setup must succeed and persist the owned policy file.
  const setup = await runtimeHostCommand('setup', { ...SAVED }, {
    ...options,
    ownership: { inspectClaims: async () => ({ claims: [] }) },
  });
  assert.equal(setup.exitCode, 0, `setup failed: ${JSON.stringify(setup.result?.reason)} ${setup.result?.detail ?? ''}`);

  const policyPath = join(fixture.configHome, 'spec-runtime', 'host-policy.json');
  const saved = JSON.parse(readFileSync(policyPath, 'utf8'));
  assert.equal(saved.lifecycle.memoryMib, 2048, 'setup persists the requested lifecycle memory');
  assert.equal(saved.lifecycle.tasksMax, 384, 'setup persists the requested lifecycle tasks');
  assert.notEqual(saved.lifecycle.memoryBytes, 3 * GIB, 'the saved policy is not the default three GiB lifecycle');

  // The controller is built with the production default host check: no
  // hostCheck seam is injected. Only the fixture environment is isolated.
  const serviceAdapter = { inspect: async () => ({ status: 'confirmed' }) };
  const indexDir = join(fixture.base, 'index');
  let deps = null;
  let budgets = null;
  const ownershipFactory = ({ registryRoot, budgets: requested }) => {
    budgets = { registryRoot, ...requested };
    return { inspectClaims: async () => ({ claims: [] }) };
  };
  const createController = captured => {
    deps = captured;
    return { deps: captured };
  };
  const controller = createNativeWaveController({
    runtime: { serviceAdapter, location: { package_dir: join(fixture.base, 'package'), targets: [] } },
    coordinator: () => ({ session: 'coordinator' }),
    send: () => ({ delivered: true }),
    indexDir,
    ownershipFactory,
    createController,
  });
  assert.equal(controller.deps, deps, 'the factory returns the controller it built');

  // Drive the default check through the controller seam without lifecycle
  // overrides or env policy overrides: the only source is the saved policy.
  const result = await deps.hostCheck({ ...options, readyMembers: 9 });

  assert.ok(result.policy, `default host check produced no policy: ${JSON.stringify(result.reason)}`);
  assert.equal(result.policy.lifecycleMemoryBytes, 2147483648, 'policy carries the saved 2048 MiB lifecycle');
  assert.equal(result.policy.lifecycleTasks, 384, 'policy carries the saved 384 task lifecycle');
  assert.equal(result.policy.lifecycleMemoryMib, 2048);
  assert.equal(result.admission.admittedWidth, 9, 'nine ready members are admitted under the saved policy');

  // Absent bubblewrap selects the worktree route, not the native overlay.
  assert.equal(result.route, 'worktree');
  assert.equal(result.fallback?.reason, 'bwrap-absent');

  // The budgeted ownership backend matches the same policy, so the controller
  // and the admission math cannot drift apart.
  assert.ok(budgets, 'the ready host check replaced ownership with policy budgets');
  assert.equal(budgets.memoryBytes, result.policy.poolMemoryBytes);
  assert.equal(budgets.tasks, result.policy.aggregateTasks);

  // The check ran against the isolated host, not a fabricated environment.
  assert.ok(calls.some(call => call.command === 'systemctl' && call.args.includes('-.slice')));
});

test('wave native: an invalid saved policy refuses before ownership replacement', async t => {
  const { fixture, options } = await isolatedHost(t);

  // A foreign policy file is never replaced by defaults.
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const configDir = join(fixture.configHome, 'spec-runtime');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'host-policy.json'), JSON.stringify({ schema: 'other/1', owner: 'someone-else' }));

  const setup = await runtimeHostCommand('setup', { ...SAVED }, {
    ...options,
    ownership: { inspectClaims: async () => ({ claims: [] }) },
  });
  assert.equal(setup.exitCode, 1, 'a foreign saved policy refuses setup');
  assert.equal(setup.result.ok, false);

  let replaced = false;
  const deps = { ownership: null };
  const createController = captured => {
    deps.hostCheck = captured.hostCheck;
    deps.ownership = captured.ownership;
    return captured;
  };
  createNativeWaveController({
    runtime: { serviceAdapter: {}, location: { package_dir: fixture.base, targets: [] } },
    coordinator: () => ({}),
    send: () => ({}),
    indexDir: join(fixture.base, 'index'),
    ownershipFactory: () => {
      replaced = true;
      return { inspectClaims: async () => ({ claims: [] }) };
    },
    createController,
  });

  const result = await deps.hostCheck({ ...options, readyMembers: 9 });
  assert.notEqual(result.status, 'ready', 'the refused policy never reports ready');
  assert.equal(replaced, false, 'no ownership backend is installed when the policy refuses');
});

test('wave native: a launch reserves capacity from the saved policy, not a fabricated one', async t => {
  const { fixture, options } = await isolatedHost(t);

  // Install the same operator policy through the production setup action so the
  // launch path reads the actual saved policy file. It is not injected into the
  // child as a lifecycle value and no returned policy is faked.
  const setup = await runtimeHostCommand('setup', { ...SAVED }, {
    ...options,
    ownership: { inspectClaims: async () => ({ claims: [] }) },
  });
  assert.equal(setup.exitCode, 0, `setup failed: ${JSON.stringify(setup.result?.reason)} ${setup.result?.detail ?? ''}`);

  // The child resolves the real production launchers relative to this test file
  // and exercises their actual reservation call. Only the environment is
  // isolated (XDG_CONFIG_HOME locates the saved policy); the ownership backend
  // captures the request instead of mutating a registry, and it answers
  // 'queued' so both launches stop before any process or service starts.
  const childScript = `
import { createWaveLifecycle } from ${JSON.stringify(new URL('./wave-lifecycle.mjs', import.meta.url).href)};
import { createWaveReviewRuntime, stageCapacityRequest } from ${JSON.stringify(new URL('./wave-review-runtime.mjs', import.meta.url).href)};

const captures = {};
const readOwnershipClaimsSync = () => [];
const waveInvalid = (code, message) => Object.assign(new Error(message), { code });
const unused = () => { throw new Error('dependency not reached'); };

const lifecycle = createWaveLifecycle({
  read: unused, timestamp: unused, atomic: unused, inside: unused, refusalError: unused,
  stepTarget: unused, waveInvalid, realOrNull: unused, workspaceIdentity: unused,
  readWaveRecord: unused, waveClaimToken: unused, readOwnershipClaimsSync,
  resolveWaveMemberRequest: unused, assertWaveLease: unused, runFileOf: unused,
  waveFileOf: unused, runLockedMutation: unused, save: unused,
  nativeCommand: unused, streamTask: unused,
});

const review = createWaveReviewRuntime({
  nativeCommand: unused, streamTask: unused, save: unused, read: unused,
  runFileOf: unused, assertWaveLease: unused, loadRun: unused, runCommand: unused,
  readOwnershipClaimsSync, waveInvalid, timestamp: unused,
  runLockedMutation: unused, waveClaimToken: unused,
});

const makeReceiver = label => ({
  ownershipRoot: 'unused',
  ownership: {
    async reserveCapacity(input) {
      captures[label] = input.request;
      return { status: 'queued' };
    },
  },
  label,
});
const binding = { package_ref: 'pkg', wave_id: 'w', attempt_id: 'a', phase: 'implementing' };

for (const [label, fn, record] of [
  ['root', lifecycle.containedRoot, { wave_bindings: binding }],
  ['stage', review.containedStage, { wave_bindings: binding, stage: { role: 'reviewer' } }],
]) {
  const receiver = makeReceiver(label);
  const target = Object.create(receiver);
  try {
    await fn.call(target, record, 'prompt');
    console.log(JSON.stringify({ unexpected_launch: label }));
    process.exit(3);
  } catch (error) {
    if (error?.code !== 'wave-capacity-queued') throw error;
  }
}

console.log(JSON.stringify({ captures, expected: stageCapacityRequest([]) }));
`;

  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: fixture.base,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.equal(child.status, 0, `launch reservation child failed: ${child.stderr || child.stdout}`);
  const observed = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.equal(observed.unexpected_launch, undefined, 'a refused reservation never starts a launch');

  // Both production launchers request the saved 2 GiB / 384 task lifecycle, and
  // the stage request agrees with the shared stageCapacityRequest helper.
  for (const label of ['root', 'stage']) {
    const request = observed.captures[label];
    assert.ok(request, `no capacity request was captured for ${label}`);
    assert.equal(request.memoryBytes, 2 * GIB, `${label} reserves the saved 2 GiB lifecycle`);
    assert.equal(request.tasks, 384, `${label} reserves the saved 384 task lifecycle`);
  }
  assert.deepEqual(observed.captures.stage, observed.expected,
    'the stage reservation matches stageCapacityRequest over no held claims');

  // kernel_proof=false: this observes the production reservation at launch, not
  // kernel enforcement, and the queued answer stops before any process starts.
  assert.equal(child.signal, null, 'the bounded child exited without a timeout signal');
});

test('wave native F13-2b-4: a missing saved policy refuses the check instead of defaulting', async t => {
  const { options } = await isolatedHost(t);

  // No setup runs here, so the isolated config home has no saved policy. A
  // flagless check must refuse rather than silently falling back to the
  // fabricated defaults, and the refusal must name the missing policy.
  const result = await runtimeHostCommand('check', {}, { ...options, readyMembers: 9 });
  assert.equal(result.exitCode, 1, 'a check with no saved policy exits nonzero');
  assert.equal(result.result.reason, 'host-policy-missing', 'the refusal names the missing saved policy');
  assert.equal(result.result.status, 'refused', 'the missing policy never reports ready');
});

test('wave native F13-2b-4: a missing saved policy refuses the launch policy calculation', async t => {
  const { options } = await isolatedHost(t);
  const { calculateWaveResourcePolicy } = await import('./wave-resource-policy.mjs');
  const { resolveRuntimeHostPolicyOptions } = await import('./linux-resources.mjs');

  // The launch policy calculator shares the saved-options resolver, so the same
  // missing policy is an error there: no launch reserves fabricated capacity.
  assert.throws(
    () => calculateWaveResourcePolicy({ ...options, readyMembers: 9 }),
    error => error.code === 'host-policy-missing',
    'the launch policy calculation reports the missing saved policy',
  );

  // Provenance is preserved: the resolver records that no policy was saved
  // rather than reporting an absent policy as an installed one.
  const resolved = resolveRuntimeHostPolicyOptions({ ...options, readyMembers: 9 });
  assert.equal(resolved.ok, true, `resolving without a saved policy failed: ${resolved.reason ?? ''}`);
  assert.equal(resolved.savedPolicyStatus, 'absent', 'the resolver reports the saved policy as absent');
});

test('wave native F13-2b-4: an explicit both-flag check diagnoses an absent policy without installing it', async t => {
  const { options } = await isolatedHost(t);
  const policyPath = join(options.env.XDG_CONFIG_HOME, 'spec-runtime', 'host-policy.json');
  assert.equal(existsSync(policyPath), false, 'the diagnostic case starts with no saved policy');

  // An explicit diagnostic supplies BOTH lifecycle limits. That is the one
  // narrow exception to the fail-closed rule: the real check runs so the
  // operator can diagnose their stated policy, but it is annotated as a
  // diagnostic and never becomes launchable evidence.
  const diagnostic = await runtimeHostCommand('check', { ...SAVED }, { ...options, readyMembers: 9 });
  assert.equal(diagnostic.result.savedPolicyStatus, 'absent', 'the diagnostic still reports the saved policy as absent');
  assert.equal(diagnostic.result.policySource, 'explicit-diagnostic', 'the diagnostic names its policy source');
  assert.equal(diagnostic.result.nativeLaunchable, false, 'a diagnostic policy is never launchable');
  assert.equal(diagnostic.result.ok, true, `the real check ran: ${diagnostic.result.reason ?? ''}`);
  assert.equal(diagnostic.result.policy.lifecycleMemoryMib, 2048, 'the diagnostic reports the explicit memory limit');
  assert.equal(diagnostic.result.policy.lifecycleTasks, 384, 'the diagnostic reports the explicit task limit');
  assert.equal(existsSync(policyPath), false, 'a diagnostic check never installs a saved policy');

  // The launch path stays fail-closed on the same absent policy: the annotation
  // is a diagnostic, not a substitute for an installed policy.
  const { calculateWaveResourcePolicy } = await import('./wave-resource-policy.mjs');
  assert.throws(
    () => calculateWaveResourcePolicy({ ...options, readyMembers: 9 }),
    error => error.code === 'host-policy-missing',
    'the launch policy calculation still refuses the absent saved policy',
  );
  assert.equal(existsSync(policyPath), false, 'no launch path installed a policy either');

  // A partial explicit policy (only one of the two lifecycle limits) is still a
  // refusal: the exception is bound to both limits being supplied together.
  const partial = await runtimeHostCommand('check', { lifecycleMemoryMib: 2048 }, { ...options, readyMembers: 9 });
  assert.equal(partial.exitCode, 1, 'a partially explicit check still exits nonzero');
  assert.equal(partial.result.reason, 'host-policy-missing', 'a partial policy names the missing saved policy');
  assert.equal(partial.result.status, 'refused', 'a partial policy never reports ready');
  assert.equal(partial.result.policySource, undefined, 'a refusal carries no diagnostic provenance');
  assert.equal(existsSync(policyPath), false, 'a refused check installs nothing');
});
