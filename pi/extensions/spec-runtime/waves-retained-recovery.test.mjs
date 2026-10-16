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

test('wave dispatch: unknown and live retained runs keep claims until an explicit positive drain recheck',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    // A disposable coordinator identity the test can kill directly; it never
    // enters the fixture's own child set, so cleanup cannot resurrect it.
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

    // The injected classification is mutable across the recovery and the three
    // advances so one test can exercise unknown, live and confirmed in order.
    const classification = { status: 'unknown', reason: 'liveness-unknown' };

    const f = await makeCase4Fixture(t, {
      memberCount: 1,
      holdOwners: true,
      coordinator: { session: COORDINATOR_SESSION, epoch: 1, pid: childIdentity.pid, started_at: childIdentity.started_at },
      lifecycle: { inspect: async () => ({ ...classification }) }
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
    // retained worktree exists and stays dirty through every adoption attempt.
    await waitFor(() => {
      const lines = readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      return lines.length === 1 ? lines : false;
    }, CASE4_TIMEOUT_MS, 'one held owner started');

    const initial = readRecord();
    const member = initial.members?.['1'];
    assert.ok(member?.workspace?.worktree, 'the member must retain a real worktree before adoption');
    const retainedWorktree = member.workspace.worktree;
    const oldRunId = member.implementation_run_id;
    assert.ok(typeof oldRunId === 'string' && oldRunId.length > 0, 'the held member must retain its implementing run id');

    // A unique untracked byte inside the retained worktree must survive every
    // recovery effect until the positive recheck resumes it.
    const marker = `recheck-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(join(retainedWorktree, 'recheck-marker.txt'), `${marker}\n`);

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
      drains: f.drains.length,
      attention: Object.keys(initial.attention ?? {}).length
    };

    // Kill ONLY the disposable coordinator; the held owner child stays until an
    // explicit positive drain recheck ends it.
    coordinatorChild.kill('SIGKILL');
    await new Promise(resolve => coordinatorChild.once('close', resolve));
    assert.equal(inspectProcess(coordinatorChild.pid).state, 'dead', 'the disposable coordinator must be positively dead');

    // A fresh coordinator session (this process) takes over with the SAME epoch.
    const ownIdentity = inspectProcess(process.pid);
    f.coordinator.session = 'session-recheck-recovered';
    f.coordinator.pid = ownIdentity.pid;
    f.coordinator.started_at = ownIdentity.started_at;

    const waveId = receipt.wave_id ?? WAVE_ID;

    // (1) The retained run is `unknown`: adoption adopts the owner but must block
    // the member and hold every claim, token and byte without launching/draining.
    const adopted = await f.controller.recover({ package: f.packagePath, wave_id: waveId, expected_generation: 1 });
    assert.equal(adopted.wave_id ?? WAVE_ID, waveId, 'adoption must report the same wave');

    const afterUnknown = readRecord();
    const unknownMember = afterUnknown.members?.['1'];
    assert.equal(unknownMember.phase, 'blocked', 'an unknown retained run must block the member');
    assert.equal(unknownMember.blocking_reason, 'liveness-unknown',
      'an unknown retained run must record blocking_reason liveness-unknown');
    assert.equal(unknownMember.implementation_run_id, oldRunId,
      'an unknown retained run must not replace the implementing run id');
    assert.equal(f.launches.length, snapshot.launches, 'an unknown retained run must launch nothing');
    assert.equal(f.drains.length, snapshot.drains, 'an unknown retained run must drain nothing');
    assert.equal(readFileSync(join(retainedWorktree, 'recheck-marker.txt'), 'utf8'), `${marker}\n`,
      'an unknown retained run must preserve the retained dirty bytes');

    // Every held claim is preserved with its exact epoch; only the coordinator
    // binding is rebound by adoption.
    const unknownClaims = (await f.ownership.inspectClaims({ packageId: f.packageRef })).claims;
    assert.deepEqual(unknownClaims.map(claim => claim.token).sort(), heldClaims.map(claim => claim.token).sort(),
      'an unknown retained run must keep every held claim token');
    for (const claim of unknownClaims) {
      if (!heldEpochs.has(claim.token)) continue;
      assert.equal(claim.epoch, heldEpochs.get(claim.token), 'a retained claim epoch must not change');
    }

    // Exactly one attention turn is recorded for this blocked transition.
    const unknownAttention = Object.keys(afterUnknown.attention ?? {});
    assert.equal(unknownAttention.length, snapshot.attention + 1,
      'an unknown retained run must record exactly one new attention key');
    assert.match(unknownAttention.at(-1), /liveness-unknown|member-blocked/, 'the attention key must name the blocked transition');

    // A stepless advance while still unknown must not duplicate the attention or
    // cause any new effect.
    const unknownAttentionKeys = [...unknownAttention].sort();
    const beforeUnknownAdvance = readFileSync(waveFile, 'utf8');
    await f.controller.advance({ package: f.packagePath, wave_id: waveId, expected_generation: 1 });
    assert.equal(f.launches.length, snapshot.launches, 'an unknown retained run must not launch on advance');
    assert.equal(f.drains.length, snapshot.drains, 'an unknown retained run must not drain on advance');
    assert.deepEqual(Object.keys(readRecord().attention ?? {}).sort(), unknownAttentionKeys,
      'advance while unknown must not duplicate the attention key');
    assert.equal(readFileSync(join(retainedWorktree, 'recheck-marker.txt'), 'utf8'), `${marker}\n`,
      'advance while unknown must preserve the retained dirty bytes');
    void beforeUnknownAdvance;

    // (2) The retained run is positively `live`: the explicit advance must block
    // with liveness-live and still keep every held claim and byte.
    classification.status = 'live';
    classification.reason = 'liveness-live';
    await f.controller.advance({ package: f.packagePath, wave_id: waveId, expected_generation: 1 });

    const afterLive = readRecord();
    const liveMember = afterLive.members?.['1'];
    assert.equal(liveMember.phase, 'blocked', 'a live retained run must block the member');
    assert.equal(liveMember.blocking_reason, 'liveness-live',
      'a live retained run must record blocking_reason liveness-live');
    assert.equal(liveMember.implementation_run_id, oldRunId,
      'a live retained run must not replace the implementing run id');
    assert.equal(f.launches.length, snapshot.launches, 'a live retained run must launch nothing');
    assert.equal(f.drains.length, snapshot.drains, 'a live retained run must not signal or drain');
    assert.equal(readFileSync(join(retainedWorktree, 'recheck-marker.txt'), 'utf8'), `${marker}\n`,
      'a live retained run must preserve the retained dirty bytes');
    const liveClaims = (await f.ownership.inspectClaims({ packageId: f.packageRef })).claims;
    for (const claim of liveClaims) {
      if (!heldEpochs.has(claim.token)) continue;
      assert.equal(claim.epoch, heldEpochs.get(claim.token), 'a live retained run must keep the claim epoch');
    }

    // (3) The classification remains positively `populated`: the explicit advance
    // recheck must cancel/drain the still-contained service once and resume exactly
    // one replacement implementing owner in the retained workspace.
    classification.status = 'populated';
    classification.reason = 'unit-populated';
    await f.controller.advance({ package: f.packagePath, wave_id: waveId, expected_generation: 1 });

    const drained = readRecord();
    const resumed = drained.members?.['1'];
    const newRunId = resumed?.implementation_run_id;
    assert.ok(typeof newRunId === 'string' && newRunId.length > 0, 'the positive recheck must launch a replacement implementing run');
    assert.notEqual(newRunId, oldRunId, 'the positive recheck must change the implementing run id');
    assert.equal(resumed.resume, 1, 'the resumed member must record resume 1');

    // Exactly one contained cancellation/drain, and it happened before the resume.
    assert.equal(f.drains.length, snapshot.drains + 1, 'the positive recheck must drain the contained phase exactly once');
    assert.equal(f.drains[snapshot.drains].cancel, true, 'the drained contained phase must have been cancelled');

    // The dirty retained worktree and its retained metadata are unchanged.
    assert.equal(readFileSync(join(retainedWorktree, 'recheck-marker.txt'), 'utf8'), `${marker}\n`,
      'the positive recheck must preserve the retained dirty bytes');
    assert.equal(resumed.workspace?.worktree, snapshot.worktree, 'the positive recheck must not move the retained worktree');
    assert.equal(resumed.workspace?.backend, snapshot.backend, 'the positive recheck must not change the retained backend');
    assert.equal(drained.generation, snapshot.generation, 'the positive recheck must not bump the wave generation');
    assert.deepEqual(drained.deadline ?? null, snapshot.deadline, 'the positive recheck must not reset the wave deadline');
    assert.equal(resumed.attempt_id, snapshot.attempt, 'the positive recheck must not change the member attempt');

    // The replacement run is bound to the implementing phase and carries the
    // canonical /resume:1 assignment suffix; the contained adapter roles are null
    // so the phase binding is verified on the run record itself.
    const newRun = JSON.parse(readFileSync(join(f.packagePath, 'runtime', 'runs', `${newRunId}.json`), 'utf8'));
    assert.match(String(newRun.assignment_id), /\/resume:1$/, 'the replacement assignment must end /resume:1');
    assert.equal(newRun.wave_bindings?.phase, 'implementing',
      'the replacement run must be bound to the implementing phase');
    const replacementLaunches = f.launches.slice(snapshot.launches).filter(launch => launch.cwd === snapshot.worktree);
    assert.equal(replacementLaunches.length, 1, 'the positive recheck must launch exactly one replacement implementing owner');
    assert.equal(replacementLaunches[0].cwd, snapshot.worktree,
      'the replacement implementing run must launch in the retained workspace');

    // A subsequent recover by the now-current coordinator is read-only.
    const beforeRepeat = readFileSync(waveFile, 'utf8');
    await f.controller.recover({ package: f.packagePath, wave_id: waveId, expected_generation: 1 });
    assert.equal(readFileSync(waveFile, 'utf8'), beforeRepeat, 'a current-owner recover must not write the wave record');
    assert.equal(f.launches.length, snapshot.launches + replacementLaunches.length, 'a current-owner recover must launch nothing');
    assert.equal(f.drains.length, snapshot.drains + 1, 'a current-owner recover must drain nothing');

    // The held owner chain is never released during observation.
    assert.equal(existsSync(f.barrierFile), true, 'the owner hold barrier must still be held');
  });

// Additive fresh-controller replay regression. The real Runtime.start launches
// the owner and binds the Runtime-owned member run before the controller records
// the launch outcome; if the outcome write is lost (a crash after the effect),
// a fresh controller over the same Runtime must reconcile the launched
// assignment from the persisted run instead of launching a second owner. This
// is written test-first: post-launch reconciliation is not implemented yet, so
// the specified assertions are intentionally red until the next production
// packet.
test('wave dispatch: a fresh controller reconciles a launched assignment after its outcome write is lost',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const f = await makeCase4Fixture(t, { memberCount: 1, holdOwners: true });
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

    // Crash window: the real Runtime.start launches the owner and writes/binds
    // its run, then the wrapper throws once so the controller never records the
    // launch outcome. The saved summary is the evidence of the launched run.
    const originalStart = f.runtime.start;
    let savedSummary = null;
    let injected = 0;
    f.runtime.start = async (...args) => {
      const summary = await originalStart.apply(f.runtime, args);
      if (injected === 0) {
        injected += 1;
        savedSummary = summary;
        const error = new Error('injected after launch: the outcome write was lost');
        error.code = 'injected-after-launch';
        throw error;
      }
      return summary;
    };

    const receipt = await f.controller.startup(startupInput, { session: COORDINATOR_SESSION });
    assert.equal(injected, 1, 'the crash window must have fired once');
    assert.ok(typeof savedSummary?.run_id === 'string' && savedSummary.run_id.length > 0,
      'the real Runtime.start must return the launched run summary before the throw');

    const waveFile = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id}.json`);
    const readRecord = () => JSON.parse(readFileSync(waveFile, 'utf8'));

    // The one real owner is live and parked behind the hold barrier.
    await waitFor(() => {
      const lines = readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      return lines.length === 1 ? lines : false;
    }, CASE4_TIMEOUT_MS, 'one held owner started');

    // The saved run is a real implementing run with the canonical assignment.
    const savedRun = JSON.parse(readFileSync(join(f.packagePath, 'runtime', 'runs', `${savedSummary.run_id}.json`), 'utf8'));
    assert.equal(savedRun.wave_bindings?.phase, 'implementing', 'the saved run must be bound to the implementing phase');
    const savedAssignment = String(savedRun.assignment_id ?? '');
    assert.ok(savedAssignment.startsWith(`wave:${receipt.wave_id}/step:001/phase:implementing/attempt:`),
      `the saved run must carry the canonical implementing assignment; got ${JSON.stringify(savedAssignment)}`);

    // The controller lost its outcome write: the member is blocked without a
    // controller implementation run id and the effect is not 'launched', but the
    // Runtime-owned member run_id already identifies the saved run.
    const crashed = readRecord();
    const crashedMember = crashed.members?.['1'];
    assert.equal(crashedMember?.run_id, savedSummary.run_id,
      'the Runtime-owned member run_id must identify the saved run');
    assert.ok(crashedMember?.implementation_run_id == null,
      'the lost outcome must not record a controller implementation run id');
    assert.equal(crashedMember.phase, 'blocked', 'the lost outcome must leave the member blocked');
    assert.equal(crashedMember.blocking_reason, 'injected-after-launch',
      'the injected crash must be recorded as the blocking reason');
    const crashEffect = Object.values(crashed.effects ?? {})
      .find(effect => effect.kind === 'implementing' && String(effect.assignment_id ?? '').includes('/step:001/'));
    assert.ok(crashEffect, 'the implementing intent must be durable');
    assert.notEqual(crashEffect.outcome, 'launched', 'the lost outcome must not be recorded as launched');
    const ownerLaunches = () => f.launches.filter(launch => launch.cwd === crashedMember.workspace.worktree);
    assert.equal(ownerLaunches().length, 1, 'exactly one owner launch must exist after the crash');

    // Restore the real start and reconcile with a fresh controller over the same
    // Runtime: no second owner may launch.
    f.runtime.start = originalStart;
    const fresh = f.replaceController();
    assert.equal(f.controller, fresh, 'the notify route must be rebound to the fresh controller');
    await f.controller.advance({ package: f.packagePath, wave_id: receipt.wave_id, expected_generation: 1 });

    const reconciled = readRecord();
    const resumed = reconciled.members?.['1'];
    assert.equal(resumed?.implementation_run_id, savedSummary.run_id,
      'reconciliation must record the saved run as the implementation run');
    assert.equal(resumed?.phase, 'implementing', 'reconciliation must return the member to implementing');
    const reconciledEffect = Object.values(reconciled.effects ?? {})
      .find(effect => effect.kind === 'implementing' && String(effect.assignment_id ?? '').includes('/step:001/'));
    assert.equal(reconciledEffect?.assignment_id, savedAssignment,
      'reconciliation must keep the same assignment');
    assert.equal(reconciledEffect?.outcome, 'launched', 'reconciliation must record the launched outcome');
    assert.equal(ownerLaunches().length, 1, 'reconciliation must not launch a second owner');

    // Exactly one run record exists for the assignment.
    const runsDir = join(f.packagePath, 'runtime', 'runs');
    const assignmentRuns = readdirSync(runsDir)
      .filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(readFileSync(join(runsDir, name), 'utf8')))
      .filter(run => run.assignment_id === savedAssignment);
    assert.equal(assignmentRuns.length, 1, 'exactly one run record may exist for the assignment');

    // A repeat advance and a replay startup are inert: no launch, same generation.
    const generation = reconciled.generation;
    await f.controller.advance({ package: f.packagePath, wave_id: receipt.wave_id, expected_generation: 1 });
    assert.equal(ownerLaunches().length, 1, 'a repeat advance must not launch');
    const replayed = await f.controller.startup(startupInput, { session: COORDINATOR_SESSION });
    assert.equal(replayed.wave_id ?? null, receipt.wave_id, 'a replay startup must report the same wave id');
    assert.equal(ownerLaunches().length, 1, 'a replay startup must not launch');
    assert.equal(readRecord().generation, generation, 'replay must not change the wave generation');

    // The held owner chain is never released during observation.
    assert.equal(existsSync(f.barrierFile), true, 'the owner hold barrier must still be held');
  });

// Additive retained-stage recovery regression. Each subcase starts a real
// two-member wave (step 2's first review returns needs-fix), holds exactly one
// non-implementing phase behind a separate stage barrier, then kills the
// disposable coordinator mid-stage. A fresh coordinator must drain the retained
// run and resume the SAME review/fix/confirmation stage exactly once in the
// retained worktree with unchanged stage metadata. Written test-first: retained
// stage recovery is not implemented yet, so the specified assertions are
// intentionally red until the next production packet.
test('wave dispatch: dead owner recovery resumes the exact retained review stage',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const startupInput = f => ({
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
    });

    // Read the current Runtime-owned run id and its durable stage metadata for a
    // member, plus the retained worktree stage record.
    const readRun = (packagePath, runId) => JSON.parse(readFileSync(join(packagePath, 'runtime', 'runs', `${runId}.json`), 'utf8'));

    for (const phase of ['reviewing', 'fixing', 'confirming']) {
      await t.test(`retains the exact ${phase} stage across dead-owner recovery`, async t2 => {
        // A disposable long-lived child supplies a real, observable coordinator
        // identity that the test kills directly; it never enters the fixture's
        // own child set, so cleanup cannot resurrect it.
        const coordinatorChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
        const childIdentity = await waitFor(() => {
          const identity = inspectProcess(coordinatorChild.pid);
          return identity?.state === 'alive' ? identity : false;
        }, CASE4_TIMEOUT_MS, 'disposable coordinator identity is alive');
        t2.after(async () => {
          if (coordinatorChild.exitCode === null && coordinatorChild.signalCode === null) {
            try { coordinatorChild.kill('SIGKILL'); } catch { /* already gone */ }
            await new Promise(resolve => coordinatorChild.once('close', resolve));
          }
        });

        // The default two-member fixture (memberCount omitted) keeps step 2's
        // first review needs-fix so reviewing, fixing and confirming all occur.
        // holdStages parks whichever single phase this subcase targets, after
        // the binding resolves and before its worker submits.
        const f = await makeCase4Fixture(t2, {
          holdStages: [phase],
          coordinator: { session: COORDINATOR_SESSION, epoch: 1, pid: childIdentity.pid, started_at: childIdentity.started_at },
          // A populated classification proves the contained phase is stopped
          // and drained before the retained stage may be resumed.
          lifecycle: { inspect: async () => ({ status: 'populated', reason: 'unit-populated' }) }
        });

        const receipt = await f.controller.startup(startupInput(f), { session: COORDINATOR_SESSION });
        const waveId = receipt.wave_id ?? WAVE_ID;
        const waveFile = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${waveId}.json`);
        const readRecord = () => JSON.parse(readFileSync(waveFile, 'utf8'));

        // The two real members start and drive through implementation and step
        // 1's review; the held phase parks its worker on the stage barrier.
        const heldRun = await waitFor(() => {
          const record = readRecord();
          const member = record.members?.['2'];
          const runId = member?.run_id;
          if (!runId) return false;
          let run;
          try { run = readRun(f.packagePath, runId); } catch { return false; }
          return run?.wave_bindings?.phase === phase ? { runId, run } : false;
        }, CASE4_TIMEOUT_MS, `member 2 ${phase} run is bound and parked`);

        // The held worker is parked BEHIND the barrier, so its service must have
        // actually registered before any snapshot or kill. Match the run's exact
        // registered unit and invocation against the observed launch for the held
        // member's workspace, rereading the run as registration lands.
        await waitFor(() => {
          const heldMember = readRecord().members?.['2'];
          const runId = heldMember?.run_id;
          if (!runId) return false;
          let run;
          try { run = readRun(f.packagePath, runId); } catch { return false; }
          if (run?.wave_bindings?.phase !== phase || !run?.service) return false;
          return f.launches.some(launch => launch.cwd === heldMember.workspace?.worktree
            && launch.unit === run.service.unit
            && launch.invocation === run.service.invocation);
        }, CASE4_TIMEOUT_MS, 'the held stage service actually launched and registered');

        const initial = readRecord();
        const member = initial.members?.['2'];
        assert.ok(member?.workspace?.worktree, 'member 2 must retain a real worktree before recovery');
        const retainedWorktree = member.workspace.worktree;
        const oldRunId = member.run_id;
        const oldImplementationRunId = member.implementation_run_id;
        assert.equal(oldRunId, heldRun.runId, 'the retained run id must be member 2 current stage run id');
        assert.ok(typeof oldImplementationRunId === 'string' && oldImplementationRunId.length > 0,
          'member 2 must retain its original implementing run id');

        // A unique untracked byte inside the retained worktree must survive every
        // recovery effect.
        const marker = `stage-recovery-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        writeFileSync(join(retainedWorktree, 'stage-recovery-marker.txt'), `${marker}\n`);

        const snapshot = {
          stage: heldRun.run.stage,
          serviceUnit: readRun(f.packagePath, oldRunId).service.unit,
          stageAttempt: member.stage_attempt ?? null,
          implementationRunId: oldImplementationRunId,
          worktree: retainedWorktree,
          backend: member.workspace.backend,
          deadline: initial.deadline ?? null,
          attempt: member.attempt_id,
          generation: initial.generation,
          launches: f.launches.length,
          drains: f.drains.length,
          bytes: readFileSync(waveFile, 'utf8')
        };

        // Kill ONLY the disposable coordinator; the held stage worker stays until
        // the recovery's own stop/drain positively ends it.
        coordinatorChild.kill('SIGKILL');
        await new Promise(resolve => coordinatorChild.once('close', resolve));
        assert.equal(inspectProcess(coordinatorChild.pid).state, 'dead', 'the disposable coordinator must be positively dead');

        // A fresh coordinator session (this process) takes over with the SAME
        // epoch, and only then is the stage barrier released so the replacement
        // stage can actually run to completion.
        const ownIdentity = inspectProcess(process.pid);
        f.coordinator.session = `session-stage-recovered-${phase}`;
        f.coordinator.pid = ownIdentity.pid;
        f.coordinator.started_at = ownIdentity.started_at;

        const recovered = await f.controller.recover({ package: f.packagePath, wave_id: waveId, expected_generation: 1 });
        assert.equal(recovered.wave_id ?? WAVE_ID, waveId, 'recovery must report the same wave');

        // Observe before releasing the barrier: the replacement stage run exists,
        // is bound to the same phase, and preserves the stage metadata.
        const after = readRecord();
        const resumed = after.members?.['2'];
        const newRunId = resumed?.run_id;
        assert.ok(typeof newRunId === 'string' && newRunId.length > 0, 'recovery must launch a replacement stage run');
        assert.notEqual(newRunId, oldRunId, 'recovery must change member 2 current stage run id');
        assert.equal(resumed.stage_attempt ?? null, snapshot.stageAttempt,
          'recovery must not change the stage attempt');
        assert.equal(resumed.implementation_run_id, snapshot.implementationRunId,
          'recovery must not replace the original implementing run id');

        const newRun = readRun(f.packagePath, newRunId);
        assert.deepEqual(newRun.stage, snapshot.stage, 'the replacement stage must deep-equal the retained stage');
        assert.match(String(newRun.assignment_id), /\/resume:1$/, 'the replacement stage assignment must end /resume:1');
        assert.equal(newRun.wave_bindings?.phase, phase, 'the replacement run must be bound to the held phase');

        // The dirty retained worktree and its retained metadata are unchanged.
        assert.equal(readFileSync(join(retainedWorktree, 'stage-recovery-marker.txt'), 'utf8'), `${marker}\n`,
          'recovery must preserve the retained dirty bytes');
        assert.equal(resumed.workspace?.worktree, snapshot.worktree, 'recovery must not move the retained worktree');
        assert.equal(resumed.workspace?.backend, snapshot.backend, 'recovery must not change the retained backend');
        assert.equal(resumed.attempt_id, snapshot.attempt, 'recovery must not change the member attempt');
        assert.equal(after.generation, snapshot.generation, 'recovery must not bump the wave generation');
        assert.deepEqual(after.deadline ?? null, snapshot.deadline, 'recovery must not reset the wave deadline');

        // The old stage run is durably phase-drain confirmed, and recovery added
        // exactly one replacement launch bound to the retained worktree; a
        // repeated recover adds none.
        const oldRun = readRun(f.packagePath, oldRunId);
        assert.equal(oldRun.phase_drain?.status, 'confirmed', 'the old stage run must carry a durable confirmed phase_drain');
        const stageLaunches = () => f.launches.slice(snapshot.launches).filter(launch => launch.cwd === snapshot.worktree);
        assert.equal(stageLaunches().length, 1, 'recovery must launch exactly one replacement stage run');
        // Count only drains of the retained step 2 stage service unit; the held
        // reviewing members legitimately drain step 1 and step 2 as well.
        const stageDrains = () => f.drains.filter(drain => drain.id === snapshot.serviceUnit);
        assert.equal(stageDrains().length, 1, 'recovery must drain the retained stage service unit exactly once');
        assert.equal(stageDrains()[0].cancel, true, 'the retained stage drain must be a cancel drain');

        const beforeRepeat = readFileSync(waveFile, 'utf8');
        await f.controller.recover({ package: f.packagePath, wave_id: waveId, expected_generation: 1 });
        assert.equal(readFileSync(waveFile, 'utf8'), beforeRepeat, 'a repeated recover must not write the wave record');
        assert.equal(stageLaunches().length, 1, 'a repeated recover must add no replacement stage launch');
        assert.equal(stageDrains().length, 1, 'a repeated recover must drain the retained stage unit no further');

        // The stage barrier is still held through every observation.
        assert.equal(existsSync(f.stagesBarrierFile), true, 'the stage hold barrier must still be held');
      });
    }
  });
