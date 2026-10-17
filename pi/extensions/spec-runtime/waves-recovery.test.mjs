// Wave dispatch controller tests (step 10). Case 4 is the walking-skeleton case
// and is written test-first from the canonical card. Its first boundary is the
// controller's own `startup`: the implementation does not exist yet, so the
// direct `await controller.startup(...)` rejects `not-implemented`. That is the
// red evidence for this packet; every observable assertion the card specifies is
// present after that boundary and will exercise the real controller once the
// implementation lands.
//
// Only external boundaries are substituted: the contained service transport and
// hostCheck. Everything else in the proof is real: package-fixture repositories,
// spec-location storage, the real spec-steps index and evidence plan,
// validateStepIndex, ownership.mjs, Runtime, Runtime's own notify route,
// wave-review.mjs, wave-integration.mjs and sentinel.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateStepIndex } from '../../../scripts/spec-observe/steps.mjs';
import { inspectProcess } from '../../../scripts/spec-observe/process-identity.mjs';
import { readCheckpointRecord } from './sentinel.mjs';
import { phaseLifecycle } from './waves.mjs';
import {
  CASE4_TIMEOUT_MS,
  WAVE_ID,
  COORDINATOR_SESSION,
  isAncestor,
  makeCase4Fixture,
  waitFor
} from './waves-fixture.mjs';

test('wave dispatch: phase lifecycle requires positive service or POSIX drain evidence', async t => {
  // A service-backed run must pass the run's `service` record, never the whole
  // run, and always forward `ownershipVerified`. Every service row also proves
  // the adapter was not asked to stop or drain during inspection.
  const serviceRun = service => ({ wave_bindings: { wave_id: WAVE_ID }, service, worker_identity: { pid: 123, started_at: 'opaque-start' } });
  const serviceRecord = { kind: 'systemd-service', unit: 'spec-runtime-wave.service', invocation_id: 'inv-1', main_pid: 123 };

  const serviceCase = async ({ title, service, inspectResult, ownershipVerified, expected }) => {
    const calls = { inspect: [], stop: 0, drain: 0 };
    const lifecycle = phaseLifecycle({
      serviceAdapter: {
        async inspect(record, options) {
          calls.inspect.push({ record, options });
          if (typeof inspectResult === 'function') return inspectResult(record, options);
          return inspectResult;
        },
        async stop() { calls.stop += 1; },
        async drain() { calls.drain += 1; }
      },
      processIdentity: () => { throw new Error('service runs must not probe POSIX identity'); }
    });
    const result = await lifecycle.inspect(serviceRun(service), { ownershipVerified });
    assert.deepEqual(result, expected, `${title}: classification`);
    assert.equal(calls.inspect.length, 1, `${title}: exactly one inspect call`);
    assert.equal(calls.inspect[0].record, service,
      `${title}: inspect receives the run's service record, not the whole run`);
    assert.deepEqual(calls.inspect[0].options, { ownershipVerified: ownershipVerified === true },
      `${title}: ownershipVerified is forwarded verbatim`);
    assert.equal(calls.stop, 0, `${title}: inspection never stops a service`);
    assert.equal(calls.drain, 0, `${title}: inspection never drains a service`);
  };

  await t.test('service: confirmed unit-terminal-drained is preserved', () =>
    serviceCase({
      title: 'unit-terminal-drained',
      service: serviceRecord,
      ownershipVerified: true,
      inspectResult: { status: 'confirmed', ok: true, reason: 'unit-terminal-drained', service: { terminal: true }, cgroup: { path: '/cg', state: 'empty' } },
      expected: { status: 'confirmed', ok: true, reason: 'unit-terminal-drained', service: { terminal: true }, cgroup: { path: '/cg', state: 'empty' } }
    }));

  await t.test('service: confirmed unit-not-found is preserved', () =>
    serviceCase({
      title: 'unit-not-found',
      service: serviceRecord,
      ownershipVerified: false,
      inspectResult: { status: 'confirmed', ok: true, reason: 'unit-not-found', service: { terminal: true }, cgroup: { path: '/cg', state: 'absent' } },
      expected: { status: 'confirmed', ok: true, reason: 'unit-not-found', service: { terminal: true }, cgroup: { path: '/cg', state: 'absent' } }
    }));

  await t.test('service: populated is preserved', () =>
    serviceCase({
      title: 'populated',
      service: serviceRecord,
      ownershipVerified: false,
      inspectResult: { status: 'populated', ok: false, reason: 'cgroup-populated', service: { terminal: false }, cgroup: { path: '/cg', state: 'populated' } },
      expected: { status: 'populated', ok: false, reason: 'cgroup-populated', service: { terminal: false }, cgroup: { path: '/cg', state: 'populated' } }
    }));

  await t.test('service: unknown is preserved', () =>
    serviceCase({
      title: 'unknown',
      service: serviceRecord,
      ownershipVerified: false,
      inspectResult: { status: 'unknown', ok: false, reason: 'query-error', service: { terminal: false }, cgroup: { path: null, state: 'unknown' } },
      expected: { status: 'unknown', ok: false, reason: 'query-error', service: { terminal: false }, cgroup: { path: null, state: 'unknown' } }
    }));

  await t.test('service: a changed-boot unknown cannot be overridden by ownershipVerified false', async () => {
    const calls = { inspect: [] };
    const lifecycle = phaseLifecycle({
      serviceAdapter: {
        async inspect(record, options) {
          calls.inspect.push({ record, options });
          // The as-built adapter returns unknown changed-boot unless the caller
          // positively asserts ownershipVerified; the classifier must not launder it.
          return options.ownershipVerified === true
            ? { status: 'confirmed', ok: true, reason: 'unit-terminal-drained', service: { terminal: true }, cgroup: { path: '/cg', state: 'empty' } }
            : { status: 'unknown', ok: false, reason: 'changed-boot', service: { terminal: false }, cgroup: { path: null, state: 'unknown' } };
        },
        async stop() { throw new Error('inspection must not stop'); },
        async drain() { throw new Error('inspection must not drain'); }
      },
      processIdentity: () => { throw new Error('service runs must not probe POSIX identity'); }
    });
    const result = await lifecycle.inspect(serviceRun(serviceRecord), { ownershipVerified: false });
    assert.deepEqual(result, { status: 'unknown', ok: false, reason: 'changed-boot', service: { terminal: false }, cgroup: { path: null, state: 'unknown' } },
      'ownershipVerified false must stay false, so changed-boot remains unknown');
    assert.deepEqual(calls.inspect[0].options, { ownershipVerified: false },
      'the caller-owned verification flag is never upgraded');
  });

  await t.test('service wins over a POSIX worker_identity with zero probes', async () => {
    let probes = 0;
    const lifecycle = phaseLifecycle({
      serviceAdapter: { async inspect() { return { status: 'confirmed', ok: true, reason: 'unit-terminal-drained', service: { terminal: true }, cgroup: { path: '/cg', state: 'empty' } }; } },
      processIdentity: () => { probes += 1; return { state: 'alive', pid: 123, started_at: 'opaque-start' }; }
    });
    const result = await lifecycle.inspect(
      { wave_bindings: { wave_id: WAVE_ID }, service: serviceRecord, worker_identity: { pid: 123, started_at: 'opaque-start' } },
      { ownershipVerified: true }
    );
    assert.equal(result.status, 'confirmed', 'the service record governs classification');
    assert.equal(result.reason, 'unit-terminal-drained');
    assert.equal(probes, 0, 'a service-backed run never probes the POSIX identity observer');
  });

  // POSIX runs carry no `service`; liveness comes only from the opaque identity
  // record and the observer's current observation, never from a signal.
  const posixRun = identity => ({ wave_bindings: { wave_id: WAVE_ID }, worker_identity: identity });
  const posixCase = async ({ title, identity, observation, expected, expectObserver = true }) => {
    let probes = 0;
    const lifecycle = phaseLifecycle({
      serviceAdapter: { async inspect() { throw new Error('a POSIX run must not call the service adapter'); } },
      processIdentity: pid => { probes += 1; if (typeof observation === 'function') return observation(pid); if (observation instanceof Error) throw observation; return observation; }
    });
    const result = await lifecycle.inspect(posixRun(identity), { ownershipVerified: false });
    assert.deepEqual(result, expected, `${title}: classification`);
    if (expectObserver) assert.equal(probes, 1, `${title}: exactly one identity probe`);
    else assert.equal(probes, 0, `${title}: the observer must not be called`);
  };

  await t.test('posix: matching alive identity is live', () =>
    posixCase({
      title: 'live',
      identity: { pid: 123, started_at: 'opaque-start' },
      observation: { state: 'alive', pid: 123, started_at: 'opaque-start' },
      expected: { status: 'live', reason: 'liveness-live' }
    }));

  await t.test('posix: dead identity is confirmed', () =>
    posixCase({
      title: 'dead',
      identity: { pid: 123, started_at: 'opaque-start' },
      observation: { state: 'dead', pid: 123 },
      expected: { status: 'confirmed', reason: 'process-dead' }
    }));

  await t.test('posix: unknown observation is unknown', () =>
    posixCase({
      title: 'unknown',
      identity: { pid: 123, started_at: 'opaque-start' },
      observation: { state: 'unknown', pid: 123, reason: 'probe-failed' },
      expected: { status: 'unknown', reason: 'liveness-unknown' }
    }));

  await t.test('posix: a live pid with a mismatched start is unknown, never confirmed', () =>
    posixCase({
      title: 'mismatched-start',
      identity: { pid: 123, started_at: 'opaque-start' },
      observation: { state: 'alive', pid: 123, started_at: 'a-different-start' },
      expected: { status: 'unknown', reason: 'liveness-unknown' }
    }));

  await t.test('posix: absent or malformed identity is unknown without probing', async () => {
    for (const identity of [undefined, null, {}, { pid: 123 }, { started_at: 'opaque-start' }, { pid: 0, started_at: 'opaque-start' }, { pid: 123, started_at: '' }]) {
      await posixCase({
        title: `identity ${JSON.stringify(identity)}`,
        identity,
        observation: { state: 'alive', pid: 123, started_at: 'opaque-start' },
        expected: { status: 'unknown', reason: 'liveness-unknown' },
        expectObserver: false
      });
    }
  });

  await t.test('posix: an observer throw is unknown', () =>
    posixCase({
      title: 'observer-throw',
      identity: { pid: 123, started_at: 'opaque-start' },
      observation: new Error('observation failed'),
      expected: { status: 'unknown', reason: 'liveness-unknown' }
    }));
});

// Additive recovery-ownership regression: recovery is read-only for the current
// owner and refuses a live or unknown foreign owner. A single held owner keeps
// the wave live under the real coordinator; the same coordinator's recover must
// be effect-free, while a durable record whose coordinator.session names a
// foreign session (with the real live process_identity retained) must refuse
// package-owned, and a mismatched started_at under the real pid must refuse
// package-owner-unknown. The held worker is never released during assertions.
test('wave dispatch: recovery is read-only for the current owner and refuses live or unknown foreign owners',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const f = await makeCase4Fixture(t, { memberCount: 1, holdOwners: true });

    const receipt = await f.controller.startup({
      package: f.packagePath,
      workflow_id: WAVE_ID,
      execution: 'waves',
      isolation: 'worktree',
      owner_model: 'fixture-provider/team/owner',
      strong_owner_model: 'fixture-provider/team/owner',
      editor_model: 'fixture-provider/team/owner',
      review_model: 'fixture-provider/team/reviewer:high',
      fix_model_override: 'fixture-provider/team/owner',
      scout_model: 'fixture-provider/team/scout'
    }, { session: COORDINATOR_SESSION });

    const waveFile = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id ?? WAVE_ID}.json`);

    // Wait for the held owner to start so the wave is live under the real
    // coordinator before recovery is exercised.
    await waitFor(() => {
      const lines = readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      return lines.length === 1 ? lines : false;
    }, CASE4_TIMEOUT_MS, 'one held owner started');

    // Snapshot every observable the refusal must leave untouched.
    const snapshot = async () => ({
      bytes: readFileSync(waveFile, 'utf8'),
      launches: f.launches.length,
      drains: f.drains.length,
      claims: await f.ownership.inspectClaims({ packageId: f.packageRef })
    });

    const before = await snapshot();

    // The current owner's recover is read-only: it resolves an unchanged status
    // and receipt with zero new launches, drain calls, claim mutations or wave
    // writes.
    const recovered = await f.controller.recover({ package: f.packagePath, wave_id: receipt.wave_id, expected_generation: 1 });
    assert.equal(recovered.wave_id, receipt.wave_id ?? WAVE_ID, 'recover must report the same wave');
    assert.equal(recovered.generation, 1, 'recover must report the same generation');
    assert.equal(recovered.state, 'running', 'recover must report the unchanged wave state');
    const afterOwnerRecover = await snapshot();
    assert.equal(afterOwnerRecover.bytes, before.bytes, 'recover by the current owner must not write the wave record');
    assert.equal(afterOwnerRecover.launches, before.launches, 'recover by the current owner must launch nothing');
    assert.equal(afterOwnerRecover.drains, before.drains, 'recover by the current owner must drain nothing');
    assert.deepEqual(afterOwnerRecover.claims, before.claims, 'recover by the current owner must not mutate the claim registry');

    // Change ONLY the durable coordinator.session to a foreign session while
    // retaining the real current process_identity: a live foreign owner must
    // refuse package-owned and leave every snapshot unchanged.
    const foreign = JSON.parse(readFileSync(waveFile, 'utf8'));
    foreign.coordinator = {
      ...foreign.coordinator,
      session: 'session-foreign-owner',
      process_identity: { pid: f.coordinator.pid, started_at: f.coordinator.started_at }
    };
    writeFileSync(waveFile, JSON.stringify(foreign, null, 2));

    const beforeForeign = await snapshot();
    await assert.rejects(
      () => f.controller.recover({ package: f.packagePath, wave_id: receipt.wave_id, expected_generation: 1 }),
      error => error.code === 'package-owned'
    );
    const afterForeign = await snapshot();
    assert.equal(afterForeign.bytes, beforeForeign.bytes, 'a live foreign owner refusal must not write the wave record');
    assert.equal(afterForeign.launches, beforeForeign.launches, 'a live foreign owner refusal must launch nothing');
    assert.equal(afterForeign.drains, beforeForeign.drains, 'a live foreign owner refusal must drain nothing');
    assert.deepEqual(afterForeign.claims, beforeForeign.claims, 'a live foreign owner refusal must not mutate the claim registry');

    // Now set that foreign owner's process_identity.started_at to a mismatched
    // opaque value while pid remains the live process.pid: the identity is
    // unknown, so recover must refuse package-owner-unknown with no effects.
    const unknown = JSON.parse(readFileSync(waveFile, 'utf8'));
    unknown.coordinator.process_identity = { ...unknown.coordinator.process_identity, pid: process.pid, started_at: 'mismatched-opaque-start' };
    writeFileSync(waveFile, JSON.stringify(unknown, null, 2));

    const beforeUnknown = await snapshot();
    await assert.rejects(
      () => f.controller.recover({ package: f.packagePath, wave_id: receipt.wave_id, expected_generation: 1 }),
      error => error.code === 'package-owner-unknown'
    );
    const afterUnknown = await snapshot();
    assert.equal(afterUnknown.bytes, beforeUnknown.bytes, 'an unknown owner refusal must not write the wave record');
    assert.equal(afterUnknown.launches, beforeUnknown.launches, 'an unknown owner refusal must launch nothing');
    assert.equal(afterUnknown.drains, beforeUnknown.drains, 'an unknown owner refusal must drain nothing');
    assert.deepEqual(afterUnknown.claims, beforeUnknown.claims, 'an unknown owner refusal must not mutate the claim registry');

    // The held worker is never released here: the barrier remains held and the
    // fixture cleanup drains the live owner.
    assert.equal(existsSync(f.barrierFile), true, 'the owner hold barrier must still be held');
  });

// ---------------------------------------------------------------------------
// Additive dead-owner recovery regression. A disposable child process holds the
// coordinator identity for a live, held wave; the child is killed and a fresh
// coordinator session must positively drain the contained implementing phase and
// resume the retained dirty worktree exactly once under a `/resume:1` assignment,
// rebinding the held claims without changing their epochs. This is written
// test-first: dead-owner adoption is not implemented yet, so the specified
// assertions are intentionally red on `dead-owner-adoption` until the next
// production packet.
test('wave dispatch: dead owner recovery drains the contained phase and resumes retained dirty bytes once',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    // A disposable long-lived child supplies a real, observable coordinator
    // identity. It is killed directly and never enters the fixture's own child
    // set, so cleanup cannot resurrect it.
    const coordinatorChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
    const childIdentity = await waitFor(() => {
      const identity = inspectProcess(coordinatorChild.pid);
      return identity?.state === 'alive' ? identity : false;
    }, CASE4_TIMEOUT_MS, 'disposable coordinator identity is alive');
    t.after(async () => {
      if (coordinatorChild.exitCode === null && coordinatorChild.signalCode === null) {
        try { coordinatorChild.kill('SIGKILL'); } catch { /* already gone */ }
        await new Promise(resolve => coordinatorChild.once('close', resolve));
      }
    });

    const f = await makeCase4Fixture(t, {
      memberCount: 1,
      holdOwners: true,
      coordinator: { session: COORDINATOR_SESSION, epoch: 1, pid: childIdentity.pid, started_at: childIdentity.started_at },
      // A populated classification proves the contained phase is stopped and
      // drained before the retained workspace may be resumed.
      lifecycle: { inspect: async () => ({ status: 'populated', reason: 'unit-populated' }) }
    });

    const receipt = await f.controller.startup({
      package: f.packagePath,
      workflow_id: WAVE_ID,
      execution: 'waves',
      isolation: 'worktree',
      owner_model: 'fixture-provider/team/owner',
      strong_owner_model: 'fixture-provider/team/owner',
      editor_model: 'fixture-provider/team/owner',
      review_model: 'fixture-provider/team/reviewer:high',
      fix_model_override: 'fixture-provider/team/owner',
      scout_model: 'fixture-provider/team/scout'
    }, { session: COORDINATOR_SESSION });

    const waveFile = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id ?? WAVE_ID}.json`);
    const readRecord = () => JSON.parse(readFileSync(waveFile, 'utf8'));

    // The one real owner starts and parks behind the hold barrier, so the
    // retained worktree exists and stays dirty through recovery.
    await waitFor(() => {
      const lines = readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      return lines.length === 1 ? lines : false;
    }, CASE4_TIMEOUT_MS, 'one held owner started');

    const initial = readRecord();
    const member = initial.members?.['1'];
    assert.ok(member?.workspace?.worktree, 'the member must retain a real worktree before recovery');
    const retainedWorktree = member.workspace.worktree;
    const oldRunId = member.implementation_run_id;
    assert.ok(typeof oldRunId === 'string' && oldRunId.length > 0, 'the held member must retain its implementing run id');

    // A unique untracked byte inside the retained worktree must survive every
    // recovery effect.
    const marker = `recovery-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(join(retainedWorktree, 'recovery-marker.txt'), `${marker}\n`);

    const heldClaims = (await f.ownership.inspectClaims({ packageId: f.packageRef })).claims;
    const heldEpochs = new Map(heldClaims.map(claim => [claim.token, claim.epoch]));
    const snapshot = {
      bytes: readFileSync(waveFile, 'utf8'),
      worktree: retainedWorktree,
      backend: member.workspace.backend,
      generation: initial.generation,
      deadline: initial.deadline ?? null,
      attempt: member.attempt_id,
      launches: f.launches.length,
      drains: f.drains.length
    };

    // Kill ONLY the disposable coordinator; the held owner child stays until the
    // recovery's own stop/drain positively ends it.
    coordinatorChild.kill('SIGKILL');
    await new Promise(resolve => coordinatorChild.once('close', resolve));
    assert.equal(inspectProcess(coordinatorChild.pid).state, 'dead', 'the disposable coordinator must be positively dead');

    // A fresh coordinator session (this process) takes over with the SAME epoch.
    const ownIdentity = inspectProcess(process.pid);
    f.coordinator.session = 'session-dead-owner-recovered';
    f.coordinator.pid = ownIdentity.pid;
    f.coordinator.started_at = ownIdentity.started_at;

    const recovered = await f.controller.recover({ package: f.packagePath, wave_id: receipt.wave_id ?? WAVE_ID, expected_generation: 1 });
    assert.equal(recovered.wave_id ?? WAVE_ID, receipt.wave_id ?? WAVE_ID, 'recovery must report the same wave');

    const after = readRecord();
    const resumed = after.members?.['1'];
    const newRunId = resumed?.implementation_run_id;
    assert.ok(typeof newRunId === 'string' && newRunId.length > 0, 'recovery must launch a replacement implementing run');
    assert.notEqual(newRunId, oldRunId, 'recovery must change the implementing run id');
    assert.equal(resumed.resume, 1, 'the resumed member must record resume 1');

    // The dirty retained worktree and its retained metadata are unchanged.
    assert.equal(readFileSync(join(retainedWorktree, 'recovery-marker.txt'), 'utf8'), `${marker}\n`,
      'recovery must preserve the retained dirty bytes');
    assert.equal(resumed.workspace?.worktree, snapshot.worktree, 'recovery must not move the retained worktree');
    assert.equal(resumed.workspace?.backend, snapshot.backend, 'recovery must not change the retained backend');
    assert.equal(after.generation, snapshot.generation, 'recovery must not bump the wave generation');
    assert.deepEqual(after.deadline ?? null, snapshot.deadline, 'recovery must not reset the wave deadline');
    assert.equal(resumed.attempt_id, snapshot.attempt, 'recovery must not change the member attempt');

    // The old run is durably drained BEFORE the replacement implementing owner.
    const oldRun = JSON.parse(readFileSync(join(f.packagePath, 'runtime', 'runs', `${oldRunId}.json`), 'utf8'));
    assert.equal(oldRun.phase_drain?.status, 'confirmed', 'the old run must carry a durable confirmed phase_drain before the replacement');
    const newRun = JSON.parse(readFileSync(join(f.packagePath, 'runtime', 'runs', `${newRunId}.json`), 'utf8'));
    assert.match(String(newRun.assignment_id), /\/resume:1$/, 'the replacement assignment must end /resume:1');

    // Exactly one replacement implementing launch; the original held launch is
    // the only earlier one in the retained worktree.
    const replacementLaunches = f.launches.slice(snapshot.launches).filter(launch => launch.cwd === snapshot.worktree);
    assert.equal(replacementLaunches.length, 1, 'recovery must launch exactly one replacement implementing owner');
    assert.equal(newRun.wave_bindings?.phase, 'implementing',
      'the replacement run must be bound to the implementing phase');
    assert.equal(replacementLaunches[0].cwd, snapshot.worktree,
      'the replacement implementing run must launch in the retained workspace');

    // The contained phase was positively stopped before it drained.
    assert.equal(f.drains.length, snapshot.drains + 1, 'recovery must drain the contained phase exactly once');
    assert.equal(f.drains[snapshot.drains].cancel, true, 'the drained contained phase must have been cancelled');

    // Held claims rebound to the new coordinator with unchanged epochs.
    const rebound = (await f.ownership.inspectClaims({ packageId: f.packageRef })).claims;
    for (const claim of rebound) {
      if (!heldEpochs.has(claim.token)) continue;
      assert.equal(claim.epoch, heldEpochs.get(claim.token), 'a retained claim epoch must not change');
      assert.equal(claim.coordinator?.session, 'session-dead-owner-recovered',
        'a retained claim must be rebound to the replacement coordinator');
    }

    // A repeated recover by the replacement coordinator is read-only: no new
    // launches, drains or wave writes.
    const beforeRepeat = readFileSync(waveFile, 'utf8');
    await f.controller.recover({ package: f.packagePath, wave_id: receipt.wave_id ?? WAVE_ID, expected_generation: 1 });
    assert.equal(readFileSync(waveFile, 'utf8'), beforeRepeat, 'a repeated recover must not write the wave record');
    assert.equal(f.launches.length, snapshot.launches + replacementLaunches.length, 'a repeated recover must launch nothing');
    assert.equal(f.drains.length, snapshot.drains + 1, 'a repeated recover must drain nothing');

    // The held owner chain is never released during observation.
    assert.equal(existsSync(f.barrierFile), true, 'the owner hold barrier must still be held');
  });

// ---------------------------------------------------------------------------
// Additive startup-recovery regression. The same dead-coordinator fixture as the
// dead-owner recovery case above, but the fresh coordinator re-enters through
// `startup` (not `recover`) with the identical package, workflow and model
// inputs. Startup must reuse the existing wave record and drive the same
// positive drain then one `/resume:1` replacement implementing owner in the
// retained dirty worktree. Written test-first: startup recovery is not
// implemented yet, so the specified assertions are intentionally red until the
// next production packet.
test('wave dispatch: startup recovers a dead coordinator without opening another wave',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    // A disposable long-lived child supplies a real, observable coordinator
    // identity. It is killed directly and never enters the fixture's own child
    // set, so cleanup cannot resurrect it.
    const coordinatorChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
    const childIdentity = await waitFor(() => {
      const identity = inspectProcess(coordinatorChild.pid);
      return identity?.state === 'alive' ? identity : false;
    }, CASE4_TIMEOUT_MS, 'disposable coordinator identity is alive');
    t.after(async () => {
      if (coordinatorChild.exitCode === null && coordinatorChild.signalCode === null) {
        try { coordinatorChild.kill('SIGKILL'); } catch { /* already gone */ }
        await new Promise(resolve => coordinatorChild.once('close', resolve));
      }
    });

    const f = await makeCase4Fixture(t, {
      memberCount: 1,
      holdOwners: true,
      coordinator: { session: COORDINATOR_SESSION, epoch: 1, pid: childIdentity.pid, started_at: childIdentity.started_at },
      // A populated classification proves the contained phase is stopped and
      // drained before the retained workspace may be resumed.
      lifecycle: { inspect: async () => ({ status: 'populated', reason: 'unit-populated' }) }
    });

    // The full model inputs are held so the restart passes the identical
    // package, execution, workflow and model selection back through startup.
    const startupInput = {
      package: f.packagePath,
      workflow_id: WAVE_ID,
      execution: 'waves',
      isolation: 'worktree',
      owner_model: 'fixture-provider/team/owner',
      strong_owner_model: 'fixture-provider/team/owner',
      editor_model: 'fixture-provider/team/owner',
      review_model: 'fixture-provider/team/reviewer:high',
      fix_model_override: 'fixture-provider/team/owner',
      scout_model: 'fixture-provider/team/scout'
    };

    const receipt = await f.controller.startup(startupInput, { session: COORDINATOR_SESSION });

    const waveId = receipt.wave_id ?? WAVE_ID;
    const waveFile = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${waveId}.json`);
    const readRecord = () => JSON.parse(readFileSync(waveFile, 'utf8'));

    // The one real owner starts and parks behind the hold barrier, so the
    // retained worktree exists and stays dirty through startup recovery.
    await waitFor(() => {
      const lines = readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      return lines.length === 1 ? lines : false;
    }, CASE4_TIMEOUT_MS, 'one held owner started');

    const initial = readRecord();
    const member = initial.members?.['1'];
    assert.ok(member?.workspace?.worktree, 'the member must retain a real worktree before startup recovery');
    const retainedWorktree = member.workspace.worktree;
    const oldRunId = member.implementation_run_id;
    assert.ok(typeof oldRunId === 'string' && oldRunId.length > 0, 'the held member must retain its implementing run id');

    // A unique untracked byte inside the retained worktree must survive every
    // startup-recovery effect.
    const marker = `startup-recovery-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(join(retainedWorktree, 'recovery-marker.txt'), `${marker}\n`);

    const heldClaims = (await f.ownership.inspectClaims({ packageId: f.packageRef })).claims;
    const heldEpochs = new Map(heldClaims.map(claim => [claim.token, claim.epoch]));
    const snapshot = {
      bytes: readFileSync(waveFile, 'utf8'),
      worktree: retainedWorktree,
      backend: member.workspace.backend,
      generation: initial.generation,
      deadline: initial.deadline ?? null,
      attempt: member.attempt_id,
      launches: f.launches.length,
      drains: f.drains.length
    };

    // Kill ONLY the disposable coordinator; the held owner child stays until the
    // startup's own stop/drain positively ends it.
    coordinatorChild.kill('SIGKILL');
    await new Promise(resolve => coordinatorChild.once('close', resolve));
    assert.equal(inspectProcess(coordinatorChild.pid).state, 'dead', 'the disposable coordinator must be positively dead');

    // A fresh coordinator session (this process) takes over with the SAME epoch
    // and re-enters through startup, not recover.
    const ownIdentity = inspectProcess(process.pid);
    f.coordinator.session = 'session-startup-recovered';
    f.coordinator.pid = ownIdentity.pid;
    f.coordinator.started_at = ownIdentity.started_at;

    const restarted = await f.controller.startup(startupInput, { session: 'session-startup-recovered' });
    assert.equal(restarted.wave_id ?? WAVE_ID, waveId, 'startup recovery must report the same wave id');

    const after = readRecord();
    const resumed = after.members?.['1'];
    const newRunId = resumed?.implementation_run_id;
    assert.ok(typeof newRunId === 'string' && newRunId.length > 0, 'startup recovery must launch a replacement implementing run');
    assert.notEqual(newRunId, oldRunId, 'startup recovery must change the implementing run id');
    assert.equal(resumed.resume, 1, 'the resumed member must record resume 1');

    // The dirty retained worktree and its retained metadata are unchanged.
    assert.equal(readFileSync(join(retainedWorktree, 'recovery-marker.txt'), 'utf8'), `${marker}\n`,
      'startup recovery must preserve the retained dirty bytes');
    assert.equal(resumed.workspace?.worktree, snapshot.worktree, 'startup recovery must not move the retained worktree');
    assert.equal(resumed.workspace?.backend, snapshot.backend, 'startup recovery must not change the retained backend');
    assert.equal(after.generation, snapshot.generation, 'startup recovery must not bump the wave generation');
    assert.deepEqual(after.deadline ?? null, snapshot.deadline, 'startup recovery must not reset the wave deadline');
    assert.equal(resumed.attempt_id, snapshot.attempt, 'startup recovery must not change the member attempt');

    // The old run is durably drained BEFORE the replacement implementing owner.
    const oldRun = JSON.parse(readFileSync(join(f.packagePath, 'runtime', 'runs', `${oldRunId}.json`), 'utf8'));
    assert.equal(oldRun.phase_drain?.status, 'confirmed', 'the old run must carry a durable confirmed phase_drain before the replacement');
    const newRun = JSON.parse(readFileSync(join(f.packagePath, 'runtime', 'runs', `${newRunId}.json`), 'utf8'));
    assert.match(String(newRun.assignment_id), /\/resume:1$/, 'the replacement assignment must end /resume:1');

    // Exactly one replacement implementing launch; the original held launch is
    // the only earlier one in the retained worktree.
    const replacementLaunches = f.launches.slice(snapshot.launches).filter(launch => launch.cwd === snapshot.worktree);
    assert.equal(replacementLaunches.length, 1, 'startup recovery must launch exactly one replacement implementing owner');
    assert.equal(newRun.wave_bindings?.phase, 'implementing',
      'the replacement run must be bound to the implementing phase');
    assert.equal(replacementLaunches[0].cwd, snapshot.worktree,
      'the replacement implementing run must launch in the retained workspace');

    // The contained phase was positively stopped before it drained.
    assert.equal(f.drains.length, snapshot.drains + 1, 'startup recovery must drain the contained phase exactly once');
    assert.equal(f.drains[snapshot.drains].cancel, true, 'the drained contained phase must have been cancelled');

    // Held claims rebound to the new coordinator with unchanged epochs.
    const rebound = (await f.ownership.inspectClaims({ packageId: f.packageRef })).claims;
    for (const claim of rebound) {
      if (!heldEpochs.has(claim.token)) continue;
      assert.equal(claim.epoch, heldEpochs.get(claim.token), 'a retained claim epoch must not change');
      assert.equal(claim.coordinator?.session, 'session-startup-recovered',
        'a retained claim must be rebound to the replacement coordinator');
    }

    // A repeated startup by the replacement coordinator is read-only: no new
    // launches, drains or wave writes.
    const beforeRepeat = readFileSync(waveFile, 'utf8');
    await f.controller.startup(startupInput, { session: 'session-startup-recovered' });
    assert.equal(readFileSync(waveFile, 'utf8'), beforeRepeat, 'a repeated startup must not write the wave record');
    assert.equal(f.launches.length, snapshot.launches + replacementLaunches.length, 'a repeated startup must launch nothing');
    assert.equal(f.drains.length, snapshot.drains + 1, 'a repeated startup must drain nothing');

    // The held owner chain is never released during observation.
    assert.equal(existsSync(f.barrierFile), true, 'the owner hold barrier must still be held');
  });

// ---------------------------------------------------------------------------
// Additive retained-run guard regression. A disposable coordinator child holds a
// live, held wave; the child is killed and a fresh coordinator session adopts the
// wave. While the retained implementing run's lifecycle classification is
// `unknown` or `live`, adoption must block the member and keep every claim and
// capacity token exactly as it was: no launch, no drain, no new attention. Only
// an explicit positive drain recheck (classification `confirmed`) may cancel the
// contained phase once and resume exactly one replacement implementing owner in
// the retained workspace. This is written test-first: the explicit recheck path
// is not implemented yet, so the specified assertions are intentionally red
// until the next production packet.
