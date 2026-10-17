// Wave dispatch candidate identity tests (step 10). Concern-split out of
// waves.test.mjs: candidate selection, candidate capacity and candidate lease
// subject. Written test-first from the canonical card against the planned
// exports of `wave-candidate-binding.mjs`, which does not exist yet, so this
// module deliberately fails at import until the implementation lands. Every
// case title starts with `wave dispatch:` so the card's test-name pattern
// selects it.
//
// Only the binding module is under test here; member lease behaviour stays with
// the existing Runtime tests (waves-*.test.mjs), which remain authoritative.
// One additive case below drives the real Runtime candidate binding end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  selectWaveSubject,
  candidateCapacityAttempt,
  candidateLeaseSubject
} from './wave-candidate-binding.mjs';
import {
  CASE4_TIMEOUT_MS,
  COORDINATOR_SESSION,
  WAVE_ID,
  makeCase4Fixture,
  waitFor
} from './waves-fixture.mjs';
import { prepareStepWorkspace } from './step-workspaces.mjs';
import { releasePacketWorkspaces } from './editor-workspaces.mjs';
import { stageLabel } from './wave-review.mjs';
import { assertLease, atomic, loadRun, resolveInput } from './runtime.mjs';

// A plain durable wave with one member (step 1, attempt s001-a1, run
// member-run, workspace memberWorkspace) and an integration-repair target.
// The wave bytes are frozen so a selection that mutates the wave can be
// detected byte-for-byte.
function makeWave() {
  return {
    wave_id: WAVE_ID,
    state: 'working',
    members: {
      '1': {
        step: 1,
        phase: 'implementing',
        attempt_id: 's001-a1',
        run_id: 'member-run',
        workspace: 'memberWorkspace'
      }
    },
    target: {
      repair: {
        n: 1,
        step: 1,
        attempt_id: 'candidate-1',
        phase: 'integration-repair',
        run_id: 'repair-run'
      },
      integration: {
        workspace: 'candidateWorkspace'
      }
    }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('wave dispatch: ordinary input without a candidate selects the actual member', () => {
  const wave = makeWave();
  const before = clone(wave);

  const result = selectWaveSubject(wave, { step_number: 1 });

  assert.deepEqual(result, {
    subject: { ...wave.members['1'] },
    candidate: null
  });
  assert.deepEqual(wave, before, 'ordinary selection must not mutate the wave');
});

test('wave dispatch: input candidate:1 selects the repair identity and candidate workspace', () => {
  const wave = makeWave();
  const before = clone(wave);

  const result = selectWaveSubject(wave, { step_number: 1, candidate: 1 });

  assert.equal(result.candidate, 1);
  assert.equal(result.subject.run_id, 'repair-run');
  assert.equal(result.subject.attempt_id, 'candidate-1');
  assert.equal(result.subject.phase, 'integration-repair');
  assert.equal(result.subject.workspace, 'candidateWorkspace');
  assert.deepEqual(wave, before, 'candidate selection must not mutate the wave');
});

test('wave dispatch: candidate mismatch and missing repair data are refused', () => {
  const base = makeWave();

  const mismatch = clone(base);
  assert.throws(() => selectWaveSubject(mismatch, { step_number: 1, candidate: 99 }),
    err => err.code === 'wave-candidate-mismatch');

  const noRepair = clone(base);
  delete noRepair.target.repair;
  assert.throws(() => selectWaveSubject(noRepair, { step_number: 1, candidate: 1 }),
    err => err.code === 'wave-candidate-missing');

  const stepMismatch = clone(base);
  stepMismatch.target.repair.step = 2;
  assert.throws(() => selectWaveSubject(stepMismatch, { step_number: 1, candidate: 1 }),
    err => err.code === 'wave-candidate-mismatch');

  const attemptMismatch = clone(base);
  attemptMismatch.target.repair.attempt_id = 'candidate-2';
  assert.throws(() => selectWaveSubject(attemptMismatch, { step_number: 1, candidate: 1 }),
    err => err.code === 'wave-candidate-mismatch');

  const phaseMismatch = clone(base);
  phaseMismatch.target.repair.phase = 'integration';
  assert.throws(() => selectWaveSubject(phaseMismatch, { step_number: 1, candidate: 1 }),
    err => err.code === 'wave-candidate-mismatch');
});

test('wave dispatch: a candidate without its workspace is refused', () => {
  const wave = makeWave();
  delete wave.target.integration.workspace;

  assert.throws(() => selectWaveSubject(wave, { step_number: 1, candidate: 1 }),
    err => err.code === 'wave-candidate-workspace');
});

test('wave dispatch: missing or invalid candidate values fail instead of falling through', () => {
  for (const candidate of [0, -1, '1', {}, []]) {
    const wave = makeWave();
    assert.throws(() => selectWaveSubject(wave, { step_number: 1, candidate }),
      err => err.code === 'wave-candidate-mismatch',
      `candidate ${JSON.stringify(candidate)} must not fall through to members`);
  }
});

test('wave dispatch: candidate capacity attempt names the candidate phase', () => {
  const binding = { wave_id: WAVE_ID, candidate: 1, attempt_id: 'candidate-1' };
  assert.equal(candidateCapacityAttempt(binding, 'integration-review'),
    `${WAVE_ID}:candidate-1:integration-review`);

  const ordinary = { wave_id: WAVE_ID, attempt_id: 's001-a1' };
  assert.equal(candidateCapacityAttempt(ordinary, 'reviewing'),
    `${WAVE_ID}:s001-a1:reviewing`);
});

test('wave dispatch: candidate lease subject accepts exactly the current repair run', () => {
  const wave = makeWave();
  const binding = {
    wave_id: WAVE_ID,
    candidate: 1,
    step_number: 1,
    attempt_id: 'candidate-1',
    phase: 'integration-repair'
  };

  const expected = selectWaveSubject(wave, { step_number: 1, candidate: 1 }).subject;
  assert.deepEqual(candidateLeaseSubject(wave, binding, 'repair-run'), expected);

  assert.throws(() => candidateLeaseSubject(wave, binding, 'other-run'),
    err => err.code === 'wave-candidate-mismatch');

  const wrongRepair = clone(wave);
  wrongRepair.target.repair.run_id = 'different-run';
  assert.throws(() => candidateLeaseSubject(wrongRepair, binding, 'repair-run'),
    err => err.code === 'wave-candidate-mismatch');

  const wrongPhase = clone(wave);
  wrongPhase.target.repair.phase = 'integration';
  assert.throws(() => candidateLeaseSubject(wrongPhase, binding, 'repair-run'),
    err => err.code === 'wave-candidate-mismatch');

  const stalePhase = clone(wave);
  stalePhase.target.repair.phase = 'integration-review';
  assert.throws(() => candidateLeaseSubject(stalePhase, binding, 'repair-run'),
    err => err.code === 'wave-candidate-mismatch');

  const wrongCandidate = { ...binding, candidate: 2 };
  assert.throws(() => candidateLeaseSubject(wave, wrongCandidate, 'repair-run'),
    err => err.code === 'wave-candidate-mismatch');

  const wrongAttemptWave = clone(wave);
  wrongAttemptWave.target.repair.attempt_id = 'candidate-2';
  assert.throws(() => candidateLeaseSubject(wrongAttemptWave, binding, 'repair-run'),
    err => err.code === 'wave-candidate-mismatch');
});

// Real-Runtime regression: a candidate binding must resolve and start in the
// provisioned candidate checkout while the original member stays byte-identical
// and unoccupied. The candidate is declared only on the durable wave target
// (`target.integration.workspace` + `target.repair`), never as a member.
test('wave dispatch: real Runtime candidate binding uses the candidate checkout without occupying a member',
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

    // The member's own implementing run stays held under the real coordinator.
    await waitFor(() => {
      const lines = readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      return lines.length === 1 ? lines : false;
    }, CASE4_TIMEOUT_MS, 'one held member implementing run started');

    const original = JSON.parse(readFileSync(waveFile, 'utf8'));
    const memberBefore = structuredClone(original.members['1']);
    assert.ok(memberBefore && memberBefore.workspace, 'the durable wave records the member workspace');
    assert.ok(typeof original.target.common === 'string' && original.target.common.length > 0,
      'the durable wave records the canonical source common dir');

    // Provision the candidate workspace through the real step provisioner.
    const candidateWaveRoot = join(f.indexDir, 'candidate-binding-fixture');
    const candidateWorkspace = await prepareStepWorkspace({
      packageId: f.packageRef,
      attemptId: 'candidate-1',
      baseCommit: f.baseCommit,
      waveRoot: candidateWaveRoot,
      target: { worktree: f.repo, gitCommonDir: original.target.common },
      setup: 'none',
      preparationReceipt: { ok: true, drain: 'confirmed', baseCommit: f.baseCommit, trackedClean: true },
      ownership: f.ownership,
      coordinator: f.coordinator,
      mode: 'worktree',
      capability: original.target.capability
    });
    const candidateCheckout = candidateWorkspace.worktree;
    let candidateClaim = candidateWorkspace.claim;
    assert.equal(candidateWorkspace.backend, 'worktree', 'the candidate binds a real worktree backend');
    assert.ok(typeof candidateCheckout === 'string' && candidateCheckout.length > 0,
      'prepareStepWorkspace returns the checked-out candidate workspace');
    assert.ok(candidateClaim && candidateClaim.token, 'the candidate workspace carries its checkout claim');

    // Release the candidate checkout exactly once, from the real positive drain,
    // and repeat as a safety net only if an earlier assertion threw first.
    let candidateReleased = false;
    const releaseCandidate = async () => {
      if (candidateReleased) return;
      candidateReleased = true;
      await releasePacketWorkspaces({
        record: { checkout: f.repo },
        members: [{ checkout: candidateCheckout, claim: candidateClaim }],
        ownership: f.ownership
      });
    };

    try {
      // Declare the candidate on the durable target only; the member clone is frozen.
      const patched = structuredClone(original);
      patched.target.integration = { ...(patched.target.integration ?? {}), workspace: candidateWorkspace };
      patched.target.repair = { n: 1, step: 1, attempt_id: 'candidate-1', phase: 'integration-repair', run_id: null };
      atomic(waveFile, patched);

      const identity = {
        package: f.packagePath,
        step: join(f.packagePath, 'step-001-subspec.md'),
        step_number: 1,
        wave_id: original.wave_id,
        expected_generation: patched.generation,
        claim_token: patched.claim_token,
        coordinator_epoch: patched.coordinator?.epoch ?? f.coordinator.epoch,
        candidate: 1,
        attempt_id: 'candidate-1',
        phase: 'integration-repair',
        owner_model: 'fixture-provider/team/owner',
        editor_model: 'fixture-provider/team/owner',
        review_model: 'fixture-provider/team/reviewer:high',
        scout_model: 'fixture-provider/team/scout'
      };

      // Resolution binds the candidate checkout without consulting the member.
      const config = await resolveInput(identity, f.pkg.location, { ownership: f.ownership, ownershipRoot: f.ownershipRoot });
      assert.equal(config.checkout, candidateCheckout, 'the candidate resolves to the provisioned candidate checkout');
      assert.notEqual(config.checkout, memberBefore.workspace.checkout, 'the candidate does not reuse the member checkout');
      assert.equal(config.wave_bindings?.candidate, 1, 'the resolved wave binding names candidate 1');
      assert.deepEqual(JSON.parse(readFileSync(waveFile, 'utf8')).members['1'], memberBefore,
        'resolving the candidate must not touch the recorded member');

      // A real Runtime start executes in the candidate checkout.
      const started = await f.runtime.start(identity);
      const boundRunId = await waitFor(() => {
        const current = JSON.parse(readFileSync(waveFile, 'utf8'));
        return current.target?.repair?.run_id || false;
      }, CASE4_TIMEOUT_MS, 'the candidate repair run is bound on the durable wave');
      assert.equal(boundRunId, started.run_id, 'the durable repair run_id is the started candidate run');

      assert.deepEqual(JSON.parse(readFileSync(waveFile, 'utf8')).members['1'], memberBefore,
        'starting the candidate must not occupy or mutate the original member');
      const run = loadRun(f.packagePath, started.run_id);
      assert.equal(run.checkout, candidateCheckout, 'the candidate run executes in the candidate checkout');
      assert.equal(run.wave_bindings?.candidate, 1, 'the candidate run records candidate 1');
      assert.deepEqual(run.revisions.checkout, { head: config.wave_bindings.base_commit, dirty: null },
        'a wave run records its frozen base, not git state found above the overlay mountpoint');
      assert.match(run.revisions.checkout.head, /^[0-9a-f]{40}$/);
      assert.equal(f.runtime.active.has(started.run_id), true, 'the candidate run is active under the Runtime');

      // The candidate lease accepts while its run is the current repair run.
      assert.doesNotThrow(() => assertLease(run), 'the active candidate run holds a valid wave lease');

      // A durable phase advance makes the stale candidate lease refuse.
      const advanced = JSON.parse(readFileSync(waveFile, 'utf8'));
      advanced.target.repair.phase = 'integration-review';
      atomic(waveFile, advanced);
      assert.throws(() => assertLease(loadRun(f.packagePath, started.run_id)),
        err => err.code === 'wave-candidate-mismatch',
        'a candidate lease whose durable repair phase advanced must refuse');

      // Restore the current phase before the positive drain.
      const restored = JSON.parse(readFileSync(waveFile, 'utf8'));
      restored.target.repair.phase = 'integration-repair';
      atomic(waveFile, restored);

      // Positive drain through the real cancellation route.
      await f.runtime.cancel(f.packagePath, started.run_id);
      assert.equal(f.runtime.active.has(started.run_id), false, 'the cancelled candidate run is drained');
      assert.deepEqual(JSON.parse(readFileSync(waveFile, 'utf8')).members['1'], memberBefore,
        'draining the candidate must not mutate the original member');

      // The positively drained candidate lets the integration-review stage start
      // even though the ordinary member still holds its run. The stage's own
      // preceding run (the started candidate) drained confirmed above, so the
      // member's held run_id must not refuse this candidate stage.
      const stageTarget = JSON.parse(readFileSync(waveFile, 'utf8'));
      stageTarget.target.repair.phase = 'integration-review';
      atomic(waveFile, stageTarget);
      assert.equal(loadRun(f.packagePath, started.run_id).phase_drain.status, 'confirmed',
        'the cancelled candidate run is positively drained before the stage starts');

      // The cancelled candidate run positively released its checkout claim, so
      // the next stage must reserve the candidate checkout before it can start.
      const priorClaims = (await f.ownership.inspectClaims()).claims;
      assert.ok(!priorClaims.some(claim => claim.token === candidateClaim.token),
        'the cancelled candidate run leaves no live checkout claim behind');
      const reserved = await f.ownership.reserveCheckout({
        packageId: f.packageRef,
        coordinator: f.coordinator,
        attempt: `${original.wave_id}:candidate-1:integration-review`,
        checkout: {
          gitCommonDir: join(dirname(candidateCheckout), 'upper'),
          worktreeGitDir: join(dirname(candidateCheckout), 'upper')
        }
      });
      assert.equal(reserved.status, 'reserved', 'the next stage reserves the candidate checkout');
      assert.ok(reserved.claim && reserved.claim.token, 'the reserved candidate checkout carries a live claim');
      candidateClaim = reserved.claim;
      // The prior candidate drain is now proven; unbind the drained run from the
      // repair slot so the new stage is a fresh phase binding, not a continuation.
      // This mirrors the required clear production remount performs after a
      // confirmed prior drain. Runtime occupancy protections are unchanged, and
      // the ordinary member's live run_id must still refuse an unauthorized
      // stage start because it remains live.
      stageTarget.target.repair.run_id = null;
      stageTarget.target.integration.workspace.claim = reserved.claim;
      atomic(waveFile, stageTarget);
      assert.ok((await f.ownership.inspectClaims()).claims.some(claim => claim.token === reserved.claim.token),
        'the next stage holds a live checkout claim on the candidate');

      const stage = await f.runtime.startStage({
        ...identity,
        phase: 'integration-review',
        implementation_run_id: started.run_id,
        stage_attempt: 1,
        stage: {
          subject: { kind: 'candidate', repair: 1, parents: [] },
          label: stageLabel(original.wave_id, { kind: 'candidate', repair: 1 }, 1),
          round: 1,
          base: f.baseCommit,
          head: f.baseCommit,
          expected_ids: []
        }
      });
      const stageBoundRunId = await waitFor(() => {
        const current = JSON.parse(readFileSync(waveFile, 'utf8'));
        return current.target?.repair?.run_id || false;
      }, CASE4_TIMEOUT_MS, 'the integration-review stage run is bound on the durable wave');
      assert.equal(stageBoundRunId, stage.run_id, 'the durable repair run_id is the started stage run');
      assert.deepEqual(JSON.parse(readFileSync(waveFile, 'utf8')).members['1'], memberBefore,
        'starting the integration-review stage must not mutate the original member');
      await f.runtime.cancel(f.packagePath, stage.run_id);
      assert.equal(f.runtime.active.has(stage.run_id), false, 'the integration-review stage run is drained');

      // Advance the durable repair phase to integration-fix while the just-drained
      // stage run remains named in the repair slot, then remount the candidate
      // member. The remount proves the retained workspace is rebound to a fresh
      // live checkout claim without mutating the original member.
      const remountTarget = JSON.parse(readFileSync(waveFile, 'utf8'));
      remountTarget.target.repair.phase = 'integration-fix';
      atomic(waveFile, remountTarget);
      const candidateWorktreeBefore = remountTarget.target.integration.workspace.worktree;
      const priorCandidateClaim = candidateClaim;
      const remount = await f.runtime.remountWaveMember({ ...identity, phase: 'integration-fix' });
      assert.equal(remount.status, 'prepared', 'the candidate member remount reports prepared');
      assert.equal(remount.remounted, true, 'the candidate member remount reports remounted');
      assert.ok(remount.workspace && remount.workspace.claim && typeof remount.workspace.claim.token === 'string',
        'the remounted candidate workspace carries a live checkout claim');
      assert.notEqual(remount.workspace.claim.token, priorCandidateClaim.token,
        'the remount binds a new live checkout claim distinct from the previous candidate claim');
      candidateClaim = remount.workspace.claim;
      const remountedDurable = JSON.parse(readFileSync(waveFile, 'utf8'));
      assert.equal(remountedDurable.target.repair.run_id, null,
        'the remount clears the drained stage run from the durable repair slot');
      assert.equal(remountedDurable.target.integration.workspace.claim.token, remount.workspace.claim.token,
        'the durable candidate workspace claim is the remounted claim');
      assert.deepEqual(remountedDurable.members['1'], memberBefore,
        'remounting the candidate must not mutate the original member');
      assert.equal(remountedDurable.target.integration.workspace.worktree, candidateWorktreeBefore,
        'the remount preserves the candidate worktree path');
      assert.equal(existsSync(candidateWorktreeBefore), true,
        'the remounted candidate worktree still exists on disk');

      // A replay of the remount is idempotent and retains the same live claim.
      const replay = await f.runtime.remountWaveMember({ ...identity, phase: 'integration-fix' });
      assert.equal(replay.remounted, true, 'the replayed candidate remount still reports remounted');
      assert.equal(replay.idempotent, true, 'the replayed candidate remount is idempotent');
      assert.equal(replay.workspace.claim.token, remount.workspace.claim.token,
        'the replayed remount retains the same live checkout claim');

      // No candidate-specific release helper exists in step-workspaces.mjs, so the
      // checkout claim is released through the packet cleanup protocol after drain.
      await releaseCandidate();
      assert.equal(existsSync(candidateCheckout), false, 'the candidate worktree is removed after release');
      const claims = (await f.ownership.inspectClaims()).claims;
      assert.ok(!claims.some(claim => claim.token === candidateClaim.token),
        'the candidate checkout claim is released');
    } finally {
      await releaseCandidate();
    }
  });

// A failed composition gate drives candidate repair review and promotion.
//
// Two independent members seal normally: their own merge-phase gate passes
// because a member checkout never contains the sibling file. The assembled
// candidate then fails that same gate until the opt-in candidate owner writes
// `src/composition-repair.txt`; the repair is reviewed and promoted. This is the
// production candidate progression regression: the controller must drive the
// repair through the durable wave bindings rather than stopping at
// `integration-repair-required`.
test('wave dispatch: a failed composition gate drives candidate repair review and promotion',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    // The merge gate passes for each independent member (only its own file is
    // present) and fails only once the two members are assembled. The candidate
    // repair file flips it to passing after repair.
    const mergeCommand = 'node -e "const fs=require(\'node:fs\');process.exit(fs.existsSync(\'src/member-1.mjs\')&&fs.existsSync(\'src/member-2.mjs\')&&!fs.existsSync(\'src/composition-repair.txt\')?1:0)"';
    const f = await makeCase4Fixture(t, {
      memberCount: 2,
      mutateIndex: (index, evidencePlan) => {
        const gate = evidencePlan.gates.find(candidateGate => candidateGate.id === 'EV-1');
        assert.ok(gate, 'the fixture evidence plan carries the wave merge gate');
        gate.command = mergeCommand;
      }
    });
    f.setScenario({
      candidateOwner: {
        mutations: { 'src/composition-repair.txt': 'composition repaired\n' },
        commit: true
      }
    });

    const startupReceipt = await f.controller.startup({
      package: f.packagePath,
      workflow_id: WAVE_ID,
      execution: 'waves',
      owner_model: 'fixture-provider/team/owner',
      strong_owner_model: 'fixture-provider/team/owner',
      editor_model: 'fixture-provider/team/owner',
      review_model: 'fixture-provider/team/reviewer:high',
      fix_model_override: 'fixture-provider/team/owner',
      scout_model: 'fixture-provider/team/scout'
    }, { session: COORDINATOR_SESSION });

    const waveFile = startupReceipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${startupReceipt.wave_id ?? WAVE_ID}.json`);
    // Snapshot the member sealed heads as soon as both members are sealed, so the
    // repair can be proven not to move them.
    let sealedHeads = null;
    const terminal = await waitFor(() => {
      const current = JSON.parse(readFileSync(waveFile, 'utf8'));
      const members = current.members ?? {};
      if (!sealedHeads && Object.keys(members).length === 2
        && Object.values(members).every(member => member?.sealed_head)) {
        sealedHeads = Object.fromEntries(Object.entries(members).map(([step, member]) => [step, member.sealed_head]));
      }
      return current.state === 'integrated' || current.state === 'blocked' ? current : false;
    }, CASE4_TIMEOUT_MS, 'the wave reaches integrated or blocked');
    assert.equal(terminal.state, 'integrated',
      `the failed composition gate must be repaired and promoted; blocked reason: ${JSON.stringify(terminal.blocking_reason ?? null)} detail: ${JSON.stringify(terminal.blocking_detail ?? null)}`);

    const record = terminal;
    const integration = record.target?.integration ?? {};

    // The candidate repair is durable and is the first (composition) repair.
    assert.equal(record.target?.repair?.n, 1, 'the durable candidate repair is repair n=1');
    const repairs = integration.repairs ?? [];
    assert.equal(repairs.length, 1, 'exactly one candidate repair is recorded');
    assert.equal(repairs[0]?.trigger, 'composition', 'the repair was triggered by the failed composition gate');
    assert.equal(repairs[0]?.reviewed, true, 'the candidate repair was reviewed before promotion');

    // The candidate owner implementation run is bound to candidate 1.
    const runsDir = join(f.packagePath, 'runtime', 'runs');
    const readJsonDir = suffix => readdirSync(runsDir)
      .filter(name => name.endsWith(suffix))
      .map(name => { try { return JSON.parse(readFileSync(join(runsDir, name), 'utf8')); } catch { return null; } })
      .filter(value => value && typeof value === 'object');
    const candidateRuns = readJsonDir('.json')
      .filter(run => run.wave_bindings && run.wave_bindings.candidate === 1);
    assert.ok(candidateRuns.length >= 1, 'the candidate implementation run records wave binding candidate 1');

    // At least the candidate owner and the candidate review launch in the
    // candidate checkout, not in the frozen member checkout.
    const candidateWorkspace = integration.workspace ?? {};
    const candidateCheckout = candidateWorkspace.worktree ?? candidateWorkspace.checkout ?? null;
    assert.ok(typeof candidateCheckout === 'string' && candidateCheckout, 'the durable candidate exposes its checkout');
    const candidateLaunches = f.launches.filter(launch => launch.cwd === candidateCheckout);
    assert.ok(candidateLaunches.some(launch => launch.role === 'owner'), 'a candidate owner launch runs in the candidate checkout');
    assert.ok(candidateLaunches.some(launch => launch.role === 'reviewer'), 'a candidate review launch runs in the candidate checkout');

    // Members stay sealed with the heads they sealed at, untouched by the repair.
    assert.ok(sealedHeads && Object.keys(sealedHeads).length === 2, 'both members sealed before integration');
    for (const [step, head] of Object.entries(sealedHeads)) {
      assert.equal(record.members?.[step]?.phase, 'sealed', `member ${step} remains sealed after the candidate repair`);
      assert.equal(record.members?.[step]?.sealed_head, head, `member ${step} keeps its original sealed head`);
    }

    // EV-1 actually failed first and passed after the repair: the durable gate
    // receipts show both outcomes and the repaired candidate records a passing
    // EV-1 on the promoted candidate commit.
    const receipts = readJsonDir('-verification.json').flatMap(record => Array.isArray(record.receipts) ? record.receipts : []);
    const ev1Receipts = receipts.filter(receipt => receipt.command === mergeCommand);
    assert.ok(ev1Receipts.some(receipt => receipt.outcome !== 'pass'), 'the composition gate actually failed first');
    assert.ok(ev1Receipts.some(receipt => receipt.outcome === 'pass'), 'the composition gate passed after the repair');
    const passingChecks = (integration.checks ?? []).filter(entry => entry.gate === 'EV-1' && entry.outcome === 'pass');
    assert.ok(passingChecks.length >= 1, 'the durable checks record a passing EV-1 after repair');
    assert.ok(passingChecks.every(entry => entry.observed_commit === record.target?.candidate_commit),
      'every passing EV-1 observed the promoted candidate commit');

    // The promoted canonical ref contains the repair file.
    const branch = record.target?.branch ?? record.target?.ref ?? record.target?.integration_branch;
    assert.ok(typeof branch === 'string' && branch, 'the wave exposes its canonical branch');
    const canonicalRef = f.git(['rev-parse', branch]).trim();
    assert.equal(record.target?.candidate_commit, canonicalRef, 'the promoted candidate is the canonical ref');
    assert.equal(f.git(['show', `${canonicalRef}:src/composition-repair.txt`]), 'composition repaired\n',
      'the canonical promoted tree contains the candidate repair file');

    // Exactly one controller entry drove the whole wave, repair included.
    assert.deepEqual(f.entry, { startup: 1, advance: 0, recover: 0, status: 0, cancel: 0 },
      'only startup may be called on the controller');

    // Replaying every routed notification is inert: no duplicate candidate launch.
    const launchesBefore = f.launches.length;
    const sendsBefore = f.sends.length;
    for (const notification of f.notifications) f.controller.routeNotification(notification.event);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.launches.length, launchesBefore, 'replaying notifications must not launch another candidate');
    assert.equal(f.sends.length, sendsBefore, 'replaying notifications must not send again');
  });

// A candidate repair whose first review needs a fix is driven through the
// candidate fix and confirmation stages before promotion. The composition gate
// fails only when both members are present and the corrected marker is still
// absent, so it reaches the candidate stage to let the real reviewer finding --
// not the gate -- require the content correction. This is the regression for the
// candidate review-repair boundary: needs-fix must launch a candidate fixer
// bound to the candidate checkout and then a confirmation round, not stop at the
// first failed review.
test('wave dispatch: a candidate needs-fix repair drives a candidate fix and confirmation before promotion',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    // The merge gate fails only once both members are assembled AND the
    // candidate repair marker is still absent: the pending marker (and
    // any member-only state) passes the gate, so it is the real reviewer finding
    // that requires the corrected content, not the gate.
    const pendingMarker = 'candidate repair pending\n';
    const correctedMarker = 'candidate repair corrected\n';
    const mergeCommand = `node -e "const fs=require('node:fs');const members=fs.existsSync('src/member-1.mjs')&&fs.existsSync('src/member-2.mjs');const marker=fs.existsSync('src/candidate-repair.txt');process.exit(members&&!marker?1:0)"`;
    const f = await makeCase4Fixture(t, {
      memberCount: 2,
      mutateIndex: (index, evidencePlan) => {
        const gate = evidencePlan.gates.find(candidateGate => candidateGate.id === 'EV-1');
        assert.ok(gate, 'the fixture evidence plan carries the wave merge gate');
        gate.command = mergeCommand;
      }
    });
    f.setScenario({
      candidateNeedsFix: true,
      candidateOwner: {
        mutations: { 'src/candidate-repair.txt': pendingMarker },
        commit: true
      },
      candidateFixer: {
        mutations: { 'src/candidate-repair.txt': correctedMarker },
        commit: true,
        amend: true
      }
    });

    const startupReceipt = await f.controller.startup({
      package: f.packagePath,
      workflow_id: WAVE_ID,
      execution: 'waves',
      owner_model: 'fixture-provider/team/owner',
      strong_owner_model: 'fixture-provider/team/owner',
      editor_model: 'fixture-provider/team/owner',
      review_model: 'fixture-provider/team/reviewer:high',
      fix_model_override: 'fixture-provider/team/owner',
      scout_model: 'fixture-provider/team/scout'
    }, { session: COORDINATOR_SESSION });

    const waveFile = startupReceipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${startupReceipt.wave_id ?? WAVE_ID}.json`);
    // Snapshot the member sealed heads as soon as both members are sealed, so the
    // candidate repair can be proven not to move them.
    let sealedHeads = null;
    const terminal = await waitFor(() => {
      const current = JSON.parse(readFileSync(waveFile, 'utf8'));
      const members = current.members ?? {};
      if (!sealedHeads && Object.keys(members).length === 2
        && Object.values(members).every(member => member?.sealed_head)) {
        sealedHeads = Object.fromEntries(Object.entries(members).map(([step, member]) => [step, member.sealed_head]));
      }
      return current.state === 'integrated' || current.state === 'blocked' ? current : false;
    }, CASE4_TIMEOUT_MS, 'the wave reaches integrated or blocked');
    assert.equal(terminal.state, 'integrated',
      `the reviewed candidate repair must be promoted; blocked reason: ${JSON.stringify(terminal.blocking_reason ?? null)} detail: ${JSON.stringify(terminal.blocking_detail ?? null)}`);

    const record = terminal;
    const integration = record.target?.integration ?? {};

    // Exactly one candidate repair, reviewed before promotion.
    assert.equal(record.target?.repair?.n, 1, 'the durable candidate repair is repair n=1');
    const repairs = integration.repairs ?? [];
    assert.equal(repairs.length, 1, 'exactly one candidate repair is recorded');
    assert.equal(repairs[0]?.trigger, 'composition', 'the repair was triggered by the failed composition gate');
    assert.equal(repairs[0]?.reviewed, true, 'the candidate repair was reviewed before promotion');

    // Owner, reviewer, fixer and confirmation all bind to candidate 1.
    const runsDir = join(f.packagePath, 'runtime', 'runs');
    const readJsonDir = suffix => readdirSync(runsDir)
      .filter(name => name.endsWith(suffix))
      .map(name => { try { return JSON.parse(readFileSync(join(runsDir, name), 'utf8')); } catch { return null; } })
      .filter(value => value && typeof value === 'object');
    const candidateRuns = readJsonDir('.json')
      .filter(run => run.wave_bindings && run.wave_bindings.candidate === 1);
    const candidatePhases = candidateRuns.map(run => run.wave_bindings.phase);
    for (const phase of ['integration-repair', 'integration-review', 'integration-fix', 'integration-confirm']) {
      assert.ok(candidatePhases.includes(phase), `a candidate run records wave binding phase ${phase}`);
    }

    // The real launches include candidate owner, reviewer and fixer in the
    // candidate checkout, never in a frozen member checkout.
    const candidateWorkspace = integration.workspace ?? {};
    const candidateCheckout = candidateWorkspace.worktree ?? candidateWorkspace.checkout ?? null;
    assert.ok(typeof candidateCheckout === 'string' && candidateCheckout, 'the durable candidate exposes its checkout');
    const candidateLaunches = f.launches.filter(launch => launch.cwd === candidateCheckout);
    for (const role of ['owner', 'reviewer', 'fixer']) {
      assert.ok(candidateLaunches.some(launch => launch.role === role), `a candidate ${role} launch runs in the candidate checkout`);
    }

    // The candidate review and fix artifacts are persisted: the round-1 review
    // recorded needs-fix, the fix record exists, and the confirmation accepted.
    const label = `wave-${record.wave_id}-integration-${record.target?.repair?.n ?? 1}-review-1`;
    const reviewArtifact = join(f.packagePath, 'reviews', `${label}-review.md`);
    const confirmationArtifact = join(f.packagePath, 'reviews', `wave-${record.wave_id}-integration-${record.target?.repair?.n ?? 1}-review-2-review.md`);
    const fixArtifact = join(f.packagePath, 'reviews', `${label}-fix.md`);
    assert.equal(existsSync(reviewArtifact), true, 'the accepted candidate review artifact is persisted');
    assert.match(readFileSync(reviewArtifact, 'utf8'), /needs-fix/, 'the persisted candidate review recorded needs-fix');
    assert.equal(existsSync(fixArtifact), true, 'the accepted candidate fix artifact is persisted');
    assert.equal(existsSync(confirmationArtifact), true, 'the accepted candidate confirmation artifact is persisted');

    // Members stay sealed with the heads they sealed at, untouched by the repair.
    assert.ok(sealedHeads && Object.keys(sealedHeads).length === 2, 'both members sealed before integration');
    for (const [step, head] of Object.entries(sealedHeads)) {
      assert.equal(record.members?.[step]?.phase, 'sealed', `member ${step} remains sealed after the candidate repair`);
      assert.equal(record.members?.[step]?.sealed_head, head, `member ${step} keeps its original sealed head`);
    }

    // The gate failed on the unrepaired candidate and passed on the fixed head:
    // the durable receipts and checks show both outcomes on the promoted
    // candidate commit.
    const receipts = readJsonDir('-verification.json').flatMap(entry => Array.isArray(entry.receipts) ? entry.receipts : []);
    const ev1Receipts = receipts.filter(receipt => receipt.command === mergeCommand);
    assert.ok(ev1Receipts.some(receipt => receipt.outcome !== 'pass'), 'the composition gate actually failed before the fix');
    assert.ok(ev1Receipts.some(receipt => receipt.outcome === 'pass'), 'the composition gate passed after the candidate fix');
    const passingChecks = (integration.checks ?? []).filter(entry => entry.gate === 'EV-1' && entry.outcome === 'pass');
    assert.ok(passingChecks.length >= 1, 'the durable checks record a passing EV-1 after the candidate fix');
    assert.ok(passingChecks.every(entry => entry.observed_commit === record.target?.candidate_commit),
      'every passing EV-1 observed the fixed candidate commit');

    // The promoted canonical tree carries the corrected marker, not the mark the
    // candidate owner first wrote.
    const branch = record.target?.branch ?? record.target?.ref ?? record.target?.integration_branch;
    assert.ok(typeof branch === 'string' && branch, 'the wave exposes its canonical branch');
    const canonicalRef = f.git(['rev-parse', branch]).trim();
    assert.equal(record.target?.candidate_commit, canonicalRef, 'the promoted candidate is the canonical ref');
    assert.equal(f.git(['show', `${canonicalRef}:src/candidate-repair.txt`]), correctedMarker,
      'the canonical promoted tree contains the corrected candidate repair marker');

    // Exactly one controller entry, startup, drove the whole wave, fix included.
    assert.deepEqual(f.entry, { startup: 1, advance: 0, recover: 0, status: 0, cancel: 0 },
      'only startup may be called on the controller');
  });
