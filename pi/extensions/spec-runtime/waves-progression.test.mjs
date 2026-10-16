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

test('wave dispatch: promotion opens the next dependency wave on its promoted base',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    // Wait until the durable wave records under runtime/waves describe exactly
    // two integrated waves: the first wave of members 1 and 2, and the second
    // wave holding the dependent step 3 on the promoted base.
    const readWaveRecords = packagePath => {
      const dir = join(packagePath, 'runtime', 'waves');
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter(name => name.endsWith('.json'))
        .map(name => {
          try { return { name, record: JSON.parse(readFileSync(join(dir, name), 'utf8')) }; }
          catch { return { name, record: null }; }
        })
        .filter(entry => entry.record !== null);
    };

    const f = await makeCase4Fixture(t, {
      memberCount: 3,
      mutateIndex(index, evidencePlan) {
        index.steps[2].requires = [1, 2];
        index.wave_checks = [
          { after: 2, owner_step: 2, gates: ['EV-1'] },
          { after: 3, owner_step: 3, gates: ['EV-2'] }
        ];
        evidencePlan.gates[0].ownerStep = 2;
        const ev2 = JSON.parse(JSON.stringify(evidencePlan.gates[0]));
        ev2.id = 'EV-2';
        ev2.ownerStep = 3;
        ev2.artifact = 'evidence/EV-2.txt';
        evidencePlan.gates.push(ev2);
      }
    });

    // The mutated index must itself be a valid, concurrency-ready dispatch: a
    // fixture that fails here is a fixture error, never a controller error.
    const precondition = validateStepIndex(f.index, { targets: [f.targetId], evidencePlan: f.evidencePlan });
    assert.equal(precondition.ok, true, `mutated index invalid: ${(precondition.errors ?? []).join('; ')}`);
    assert.equal(precondition.concurrency_ready, true, 'mutated index must be concurrency ready');
    assert.deepEqual((f.index.wave_checks ?? []).map(check => check.after), [2, 3], 'the fixture must declare waves [[1, 2], [3]]');
    assert.deepEqual(f.index.steps[2].requires, [1, 2], 'step 3 must depend on both members of wave 1');
    assert.deepEqual(precondition.waves, [[1, 2], [3]], 'the precondition must expose waves [[1, 2], [3]]');

    await f.controller.startup({
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

    // The terminal is awaited through the bounded integrated-record poll and the
    // second wave's promotion-result wait below; an unbounded `await f.terminal`
    // would hang because it resolves from the first wave's promotion-result,
    // while the next-wave open is driven asynchronously as a continuation.

    // Only startup may ever be called: progression from wave 1 to wave 2 arrives
    // through the Runtime notify route, not a second controller entry.
    assert.deepEqual(f.entry, { startup: 1, advance: 0, recover: 0, status: 0, cancel: 0 },
      'only startup may be called on the controller');

    // Wait until exactly two integrated wave records exist: the first wave (1, 2)
    // and the automatically opened second wave (3). This bounded poll replaces
    // the earlier unbounded `await f.terminal`, which could not resolve once the
    // next-wave open became an asynchronous continuation.
    const integratedRecords = await waitFor(() => {
      const integrated = readWaveRecords(f.packagePath)
        .map(entry => entry.record)
        .filter(record => record.state === 'integrated');
      return integrated.length === 2 ? integrated : false;
    }, CASE4_TIMEOUT_MS, 'two integrated wave records');

    const sorted = integratedRecords.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    assert.deepEqual(sorted.map(record => record.ordinal), [1, 2], 'the records must be wave ordinals 1 and 2');

    const [first, second] = sorted;
    assert.deepEqual(Object.keys(first.members ?? {}).sort(), ['1', '2'], 'wave 1 must hold steps 1 and 2');
    assert.deepEqual(Object.keys(second.members ?? {}).sort(), ['3'], 'wave 2 must hold the dependent step 3');

    // The integrated record is published before the promotion effect finishes:
    // the barrier emits the promotion-result attention only after the record is
    // transitioned to integrated, so observing `state === 'integrated'` alone
    // does not prove checkpoint reconciliation, package-claim release or the
    // promotion-result send have completed. Wait for the second wave's terminal
    // promotion-result send, which is the actual boundary for all final effects.
    await waitFor(() => f.sends.some(sent => {
      const text = JSON.stringify(sent.message ?? '');
      return text.includes('promotion-result') && text.includes(second.wave_id);
    }), CASE4_TIMEOUT_MS, `promotion-result send for wave ${second.wave_id}`);

    // The promotion of wave 1 is the base of wave 2. The promotion result names
    // wave 1's candidate commit.
    const firstPromotionTarget = first.target.promotion.candidate;
    assert.equal(firstPromotionTarget, first.target.candidate_commit,
      'the promotion result must name wave 1\'s candidate commit');

    assert.equal(second.target.base_commit, first.target.candidate_commit,
      'wave 2 must open on wave 1\'s promoted candidate commit');
    for (const [step, member] of Object.entries(second.members ?? {})) {
      assert.equal(member.base_commit, first.target.candidate_commit,
        `wave 2 member ${step} must be based on wave 1\'s promoted candidate`);
    }

    // Both waves seal every member and both sealed heads are ancestors of the
    // respective candidate commit.
    for (const record of sorted) {
      assert.equal(record.state, 'integrated', 'each opened wave must integrate');
      for (const [step, member] of Object.entries(record.members ?? {})) {
        assert.ok(member.sealed_head, `step ${step} must expose a sealed head`);
        assert.equal(isAncestor(f.repo, member.sealed_head, record.target.candidate_commit), true,
          `step ${step} sealed head must be an ancestor of its wave candidate`);
      }
    }

    // The final repository HEAD is wave 2's candidate commit: the second wave
    // promoted its own candidate onto the branch.
    const finalHead = f.git(['rev-parse', 'HEAD']).trim();
    assert.equal(finalHead, second.target.candidate_commit,
      'the final repository HEAD must be wave 2\'s candidate commit');

    // Exactly three owners launched across the whole progression (one per member),
    // and the wave workers completed their checkpoints for both waves.
    const ownerLaunches = f.launches.filter(launch => launch.role === 'owner');
    assert.equal(ownerLaunches.length, 3, `exactly three owners must launch; saw ${ownerLaunches.length}`);

    const checkpoint = readCheckpointRecord(f.packagePath, WAVE_ID);
    for (const record of sorted) {
      const worker = (checkpoint.workers ?? []).find(w => w.kind === 'wave' && w.id === record.wave_id);
      assert.equal(worker?.state, 'complete',
        `wave ${record.wave_id} worker must be complete`);
    }

    // The package claim is released once the whole progression is integrated.
    const inspected = await f.ownership.inspectClaims({ packageId: f.packageRef });
    const packageClaims = (inspected?.claims ?? []).filter(claim => claim.kind === 'package');
    assert.equal(packageClaims.length, 0, 'no package claim may remain after the final wave integrates');
  });

// ---------------------------------------------------------------------------
// Additive explicit member review-repair regression. Step 2's first review
// returns needs-fix (fixing #1) and its confirmation FAILS at rounds 2 and 3, so
// the member reblocks with confirmation-failed rather than sealing. Exactly one
// explicit advance with attempt_kind 'review-repair' must launch a second fixer
// (which has no transport assignment_id: that identity is the durable
// repair.assignment_id), relaunch a confirmation, and then reblock on the failed
// final confirmation with stage_attempt 5. Duplicate replay and an explicit
// capacity release must never launch a third fixer, and an advance with the
// wrong attempt_kind is rejected with repair-kind-unsupported leaving the record
// byte-identical. Default fixture, real Runtime and wave-review: only the fake
// worker scenario opts in.
test('wave dispatch: explicit review repair is consumed by one fix and a new confirmation',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const f = await makeCase4Fixture(t);
    // Opt in after creation so the default scenario stays byte-for-byte default
    // until this case explicitly fails step 2's confirmation at rounds 2 and 3.
    f.setScenario({ failedConfirmationRounds: [2, 3] });

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

    const recordPath = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id ?? WAVE_ID}.json`);
    const readRecord = () => JSON.parse(readFileSync(recordPath, 'utf8'));
    const fixerLaunches = () => f.launches.filter(launch => launch.role === 'fixer');

    // First boundary: step 2 blocks on its failed confirmation while its sibling
    // seals normally.
    const blocked = await waitFor(() => {
      const current = readRecord();
      const m1 = current.members?.['1'];
      const m2 = current.members?.['2'];
      const settled = m2?.phase === 'blocked' && m1?.phase === 'sealed';
      const reason = m2?.blocking_reason ?? m2?.blocking_detail ?? '';
      return settled ? { current, m1, m2, reason: JSON.stringify(reason) } : false;
    }, CASE4_TIMEOUT_MS, 'member 002 blocks on confirmation-failed and member 001 seals');

    assert.match(blocked.reason, /confirmation-failed/,
      `member 002 must block with confirmation-failed; saw: ${blocked.reason}`);
    assert.equal(blocked.current.state, 'blocked', 'the wave must be blocked while member 002 is blocked');
    assert.equal(fixerLaunches().length, 1, 'no automatic fixer may launch after a confirmation-failed block');

    // F10-4: the wave's own blocked transition must use the wave-level `state`
    // key, while the member transition keeps `phase`. The durable wave must
    // carry exactly one state-blocked entry and no wave transition written with
    // the member key.
    assert.equal((blocked.current.transitions ?? []).filter(entry => entry?.state === 'blocked').length, 1,
      'the blocked wave must record exactly one state-blocked transition');
    assert.equal((blocked.current.transitions ?? []).filter(entry => entry?.phase === 'blocked').length, 0,
      'wave transitions must not use the member phase key');
    assert.equal((blocked.m2.transitions ?? []).filter(entry => entry?.phase === 'blocked').length, 1,
      'the blocked member must still record exactly one phase-blocked transition');

    // F10-5: the status receipt projects a bounded member preview and a
    // state-specific repair route from the durable record. Blocked previews
    // first, so the blocked step 2 leads the two-member preview.
    const statusReceipt = await f.controller.status({ package: f.packagePath, wave_id: receipt.wave_id ?? WAVE_ID });
    assert.equal(statusReceipt.member_count, 2, 'the receipt must count both members');
    assert.equal(statusReceipt.omitted_count, 0, 'a two-member wave must omit no members');
    const statusPreview = statusReceipt.members ?? [];
    assert.ok(statusPreview.length >= 1, 'the receipt must preview its members');
    assert.equal(statusPreview[0]?.step, 2, 'blocked members must preview first');
    assert.equal(statusPreview[0]?.phase, 'blocked', 'the first previewed member must be the blocked step 2');
    assert.match(String(statusReceipt.next_action ?? ''), /review-repair/,
      'a confirmation-failed block must expose the review-repair route');
    assert.match(String(statusReceipt.next_action ?? ''), /step=2/,
      'the repair route must name step 2');

    // Member 002's durable repair state must not yet exist, and the failed
    // confirmation rounds must be durably recorded by the real review plane.
    const beforeRepair = readRecord();
    assert.equal(beforeRepair.members?.['2']?.repair ?? null, null,
      'no repair may be recorded before the explicit advance');
    const member1SealedHead = blocked.m1?.sealed_head;
    const member1Ref = blocked.m1?.retention_ref ?? blocked.m1?.ref ?? null;

    // Wrong attempt kind is rejected before any valid repair and leaves the
    // durable record byte-identical.
    const beforeWrong = readFileSync(recordPath, 'utf8');
    await assert.rejects(
      () => f.controller.advance({
        package: f.packagePath,
        wave_id: receipt.wave_id ?? WAVE_ID,
        step: 'step-002-subspec.md',
        attempt_kind: 'implementation',
        instructions: 'wrong kind: must be refused',
        expected_generation: beforeRepair.generation
      }),
      error => error.code === 'repair-kind-unsupported',
      'an advance with the wrong attempt_kind must reject repair-kind-unsupported');
    assert.equal(readFileSync(recordPath, 'utf8'), beforeWrong,
      'a rejected advance must leave the durable record byte-identical');
    assert.equal(fixerLaunches().length, 1, 'a rejected advance must launch no fixer');

    // The explicit repair: a nonempty instructions packet advances step 2 with
    // attempt_kind 'review-repair'. The second fixer must produce a distinct real
    // commit, so switch the fixer mutations away from the round-1 packet's
    // content before the advance; an identical tree would leave Git with nothing
    // to commit and fail the fixing stage.
    f.setScenario({ fixer: { mutations: { 'src/b.mjs': 'export const b = 2; // explicit repair\n' }, commit: true } });
    const repaired = await f.controller.advance({
      package: f.packagePath,
      wave_id: receipt.wave_id ?? WAVE_ID,
      step: 'step-002-subspec.md',
      attempt_kind: 'review-repair',
      instructions: 'repair the actionables recorded by review-2',
      expected_generation: readRecord().generation
    });
    assert.ok(repaired, 'the review-repair advance must return a receipt');

    // Second fixer runs exactly once. Its transport launch carries no
    // assignment_id; the durable repair.assignment_id is the review-plane identity
    // for the fixing stage at attempt 4, packet 1. Read the actual fixing run
    // records from runtime/runs to compare against the real bound assignment.
    const secondLaunch = await waitFor(() => {
      const launches = fixerLaunches();
      return launches.length === 2 ? launches[1] : false;
    }, CASE4_TIMEOUT_MS, 'exactly two fixer launches total');
    assert.equal(secondLaunch.assignment_id ?? null, null,
      'the fixer transport launch carries no assignment_id; the durable repair owns the identity');
    const afterFix = await waitFor(() => {
      const current = readRecord();
      const repair = current.members?.['2']?.repair;
      return repair?.assignment_id ? { current, repair } : false;
    }, CASE4_TIMEOUT_MS, 'member 002 records the repair assignment_id');

    const expectedRepairAssignment =
      `wave:${receipt.wave_id ?? WAVE_ID}/step:002/phase:fixing/attempt:4/packet:1`;
    assert.equal(afterFix.repair.assignment_id, expectedRepairAssignment,
      'member 002 repair.assignment_id must be the canonical fixing identity at attempt 4, packet 1');

    // Load every real run record under runtime/runs and keep the fixing-phase
    // wave-bound records for step 2. Non-run JSON (locks, completion logs,
    // index files, editor slots) must be skipped, never parsed as a run.
    const runsDir = join(f.packagePath, 'runtime', 'runs');
    const fixingRuns = readdirSync(runsDir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        try { return JSON.parse(readFileSync(join(runsDir, name), 'utf8')); } catch { return null; }
      })
      .filter(run => run && run.wave_bindings
        && run.wave_bindings.phase === 'fixing'
        && Number(run.wave_bindings.step_number) === 2
        // Keep only real stage worker runs: command-phase records may carry phase
        // fixing with no stage assignment, so require the fixer stage role and a
        // nonempty assignment_id.
        && run.stage?.role === 'fixer'
        && typeof run.assignment_id === 'string' && run.assignment_id.length > 0);
    // The canonical assignment string is owned by Runtime.startStage
    // (wave-review-runtime216); a durable stage_attempt counter on the member is
    // not part of the run binding. Parse the attempt from the assignment_id.
    const attemptFor = run => {
      const match = /\/phase:fixing\/attempt:(\d+)\/packet:/.exec(run.assignment_id ?? '');
      assert.ok(match, 'every fixing run assignment_id must carry the canonical /phase:fixing/attempt:N/packet: shape');
      return Number(match[1]);
    };
    const attempt4 = fixingRuns.find(run => attemptFor(run) === 4) ?? null;
    assert.ok(attempt4, 'runtime/runs must hold the attempt-4 fixing run for step 2');
    assert.equal(fixingRuns.length, 2,
      'step 2 must have exactly two fixing runs: the round-1 packet and the explicit repair');
    assert.equal(new Set(fixingRuns.map(attemptFor)).size, fixingRuns.length,
      'the two fixing runs must have unique stage attempts (4 and 2)');
    assert.ok(fixingRuns.some(run => attemptFor(run) === 2),
      'runtime/runs must hold the attempt-2 fixing run for step 2');
    assert.equal(afterFix.repair.assignment_id, attempt4.assignment_id,
      'repair.assignment_id must equal the actual attempt-4 fixing run assignment_id');
    assert.equal(fixerLaunches().length, 2, 'exactly two fixer launches total after repair');

    // The final confirmation FAILS and reblocks the member: the failed rounds 2
    // and 3 mean the repair confirmation at attempt 5 does not seal. Assert the
    // exact blocking state, the exact stage_attempt, and the fixed transition
    // count (review/fix/confirm/fix/confirm) with no optional shape probing.
    const reblocked = await waitFor(() => {
      const current = readRecord();
      const m2 = current.members?.['2'];
      const reason = m2?.blocking_reason ?? '';
      return m2?.phase === 'blocked' && /confirmation-failed/.test(JSON.stringify(reason))
        ? { current, m2 } : false;
    }, CASE4_TIMEOUT_MS, 'member 002 reblocks on the failed final confirmation');
    assert.equal(reblocked.m2.stage_attempt, 5,
      'the reblocked member must record stage_attempt 5 for the failed final confirmation');
    assert.equal(reblocked.current.state, 'blocked', 'the wave must be blocked after the failed final confirmation');
    assert.equal(reblocked.current.members?.['2']?.sealed_head ?? null, null,
      'a failed final confirmation must not seal member 002');
    const transitions = reblocked.m2.transitions ?? [];
    assert.equal(transitions.filter(entry => entry?.phase === 'reviewing').length, 1,
      'exactly one reviewing transition (round 1)');
    assert.equal(transitions.filter(entry => entry?.phase === 'fixing').length, 2,
      'exactly two fixing transitions (round 1 packet and the explicit repair)');
    assert.equal(transitions.filter(entry => entry?.phase === 'confirming').length, 2,
      'exactly two confirming transitions (the failed rounds 2 and 3)');
    assert.equal((reblocked.current.transitions ?? []).filter(entry => entry?.state === 'blocked').length, 1,
      'the reblocked wave must still record exactly one state-blocked transition');

    // Member 001's sealed head and ref survive its sibling's repair and reblock.
    assert.equal(reblocked.current.members?.['1']?.sealed_head, member1SealedHead,
      'member 001 sealed_head must be unchanged by the sibling repair');
    assert.equal(reblocked.current.members?.['1']?.retention_ref ?? reblocked.current.members?.['1']?.ref ?? null, member1Ref,
      'member 001 retention ref must be unchanged by the sibling repair');

    // Replay the member's actual completed summary through the controller's own
    // notification route, then release capacity explicitly: the repair is
    // consumed exactly once, so neither can launch a third fixer. Both are driven
    // from real recorded facts, never an optional emit or an arbitrary sleep.
    const finalRunId = reblocked.current.members?.['2']?.run_id ?? null;
    const replay = finalRunId == null
      ? null
      : [...f.notifications].reverse().find(entry =>
        (entry.event?.id ?? entry.event?.run_id) === finalRunId && entry.event?.state === 'completed') ?? null;
    assert.ok(replay,
      'the controller must have received the completed summary for the final run');
    const fixerCountAtReblock = fixerLaunches().length;
    assert.ok(f.controller.routeNotification(replay.event),
      'replaying the completed summary must be routed by the controller');
    await f.controller.onCapacityReleased();
    assert.equal(fixerLaunches().length, fixerCountAtReblock,
      'duplicate replay and capacity release must not launch a third fixer');
    assert.equal(fixerLaunches().length, 2, 'exactly two fixer launches across the whole lifecycle');
  });

// ---------------------------------------------------------------------------
// Additive ownership-adaptation regression. Default fixture with both reviews
// passing: step 2's owner writes a second, undeclared file so the real seal
// pipeline attributes it and blocks the seal with 'undeclared-write' while
// sibling step 1 seals normally. A single explicit advance carrying the missing
// file as an adaptation must record that decision on the member, re-run the
// overwrite of the blocked seal receipt to 'sealed', and integrate without
// relaunching any transport worker. Default fixture, real Runtime, seal pipeline
// and wave-review; no production path is exercised beyond what already exists.
test('wave dispatch: explicit ownership adaptation retries the blocked seal without relaunching workers',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const f = await makeCase4Fixture(t);
    // Both reviews pass so step 2 is blocked only by seal attribution: its owner
    // commits both its declared file and an undeclared additive helper.
    f.setScenario({
      step2NeedsFix: false,
      owners: {
        '1': { mutations: { 'src/a.mjs': 'export const a = 1;\n' }, commit: true },
        '2': { mutations: { 'src/b.mjs': 'export const b = 1;\n', 'src/extra.mjs': 'export const extra = 1;\n' }, commit: true }
      }
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

    const recordPath = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id ?? WAVE_ID}.json`);
    const readRecord = () => JSON.parse(readFileSync(recordPath, 'utf8'));
    const waveId = receipt.wave_id ?? WAVE_ID;
    const sealPath = join(f.packagePath, 'runtime', 'waves', waveId, 'step-002-seal.json');
    const readSeal = () => JSON.parse(readFileSync(sealPath, 'utf8'));

    // First boundary: step 2 blocks on the undeclared write while its sibling
    // seals normally, and the wave is not integrated with no candidate promoted.
    const blocked = await waitFor(() => {
      const current = readRecord();
      const m1 = current.members?.['1'];
      const m2 = current.members?.['2'];
      const settled = m2?.phase === 'blocked' && m1?.phase === 'sealed';
      const reason = m2?.blocking_reason ?? m2?.blocking_detail ?? '';
      return settled ? { current, m1, m2, reason: JSON.stringify(reason) } : false;
    }, CASE4_TIMEOUT_MS, 'member 002 blocks on undeclared-write and member 001 seals');

    assert.match(blocked.reason, /undeclared-write/,
      `member 002 must block with undeclared-write; saw: ${blocked.reason}`);
    assert.equal(blocked.current.state, 'blocked',
      'the wave must not be integrated while member 002 is blocked');
    assert.equal(blocked.current.target?.candidate_commit ?? null, null,
      'a blocked wave must not promote a candidate');

    // F10-5: an undeclared-write block points the coordinator at the ownership
    // adaptation route for the blocked step.
    const adaptationStatus = await f.controller.status({ package: f.packagePath, wave_id: waveId });
    assert.match(String(adaptationStatus.next_action ?? ''), /adaptations/,
      'an undeclared-write block must expose the adaptations route');
    assert.match(String(adaptationStatus.next_action ?? ''), /step=2/,
      'the adaptation route must name step 2');

    // The blocked seal receipt is durable, and the sibling's seal facts survive.
    const blockedSeal = readSeal();
    assert.equal(blockedSeal.state, 'blocked', 'the step 002 seal receipt must record blocked');
    assert.equal(blockedSeal.reasons?.[0]?.code, 'undeclared-write',
      'the blocked seal receipt must name undeclared-write');
    assert.deepEqual(blockedSeal.adaptations_applied, [],
      'no adaptation may be applied before the explicit advance');
    const member1SealedHead = blocked.m1?.sealed_head;
    const member1Ref = blocked.m1?.retention_ref ?? blocked.m1?.ref ?? null;
    assert.ok(member1SealedHead, 'member 001 must expose its sealed head');
    assert.ok(member1Ref, 'member 001 must expose its retention ref');

    // No adaptation is recorded before the explicit advance.
    assert.deepEqual(blocked.current.members?.['2']?.ownership_adaptations ?? [], [],
      'no member adaptation may exist before the explicit advance');

    // Snapshot the total transport launch count. The adaptation retry must reuse
    // the sealed/blocked member state and launch no additional worker.
    const launchesBefore = f.launches.length;

    // The explicit ownership adaptation: one advance naming the undeclared file
    // and its reason, at the current generation, with no attempt_kind.
    const adaptation = { path: 'src/extra.mjs', reason: 'necessary additive helper for step 2' };
    const advanced = await f.controller.advance({
      package: f.packagePath,
      wave_id: waveId,
      step: 'step-002-subspec.md',
      expected_generation: blocked.current.generation,
      adaptations: [adaptation]
    });
    assert.ok(advanced, 'the ownership-adaptation advance must return a receipt');

    // The adapted retry integrates and the terminal promotion-result send is the
    // real boundary for the final effects (mirrors the next-wave case so the
    // claim-release race cannot make the assertions flaky).
    const integrated = await waitFor(() => {
      const current = readRecord();
      return current.state === 'integrated' ? current : false;
    }, CASE4_TIMEOUT_MS, 'the adapted wave record integrates');

    await waitFor(() => f.sends.some(sent => {
      const text = JSON.stringify(sent.message ?? '');
      return text.includes('promotion-result') && text.includes(waveId);
    }), CASE4_TIMEOUT_MS, `promotion-result send for wave ${waveId}`);

    // The member records the exact adaptation, attributed to the coordinator
    // with a parseable timestamp.
    const adaptations = integrated.members?.['2']?.ownership_adaptations ?? [];
    assert.equal(adaptations.length, 1,
      'member 002 must record exactly one ownership adaptation');
    assert.equal(adaptations[0].path, adaptation.path,
      'the recorded adaptation must name the exact path');
    assert.equal(adaptations[0].reason, adaptation.reason,
      'the recorded adaptation must carry the exact reason');
    assert.equal(adaptations[0].recorded_by, 'coordinator',
      'the adaptation must be attributed to the coordinator');
    assert.equal(Number.isFinite(Date.parse(adaptations[0].recorded_at)), true,
      'the adaptation must carry a parseable recorded_at');

    // The blocked seal receipt was overwritten in place as sealed, and it now
    // lists the applied adaptation.
    const resealed = readSeal();
    assert.equal(resealed.state, 'sealed', 'the retried seal receipt must be sealed');
    assert.equal(resealed.sealed_head, integrated.members?.['2']?.sealed_head,
      'the sealed receipt head must match the durable member sealed head');
    const applied = resealed.adaptations_applied ?? [];
    assert.equal(applied.length, 1, 'the sealed receipt must apply exactly one adaptation');
    assert.equal(applied[0].path, adaptation.path,
      'the sealed receipt must apply the extra path');

    // The sibling's seal facts are untouched by the adaptation retry.
    assert.equal(integrated.members?.['1']?.sealed_head, member1SealedHead,
      'member 001 sealed_head must be unchanged by the adaptation retry');
    assert.equal(integrated.members?.['1']?.retention_ref ?? integrated.members?.['1']?.ref ?? null, member1Ref,
      'member 001 retention ref must be unchanged by the adaptation retry');

    // The adaptation retry launched no new transport worker.
    assert.equal(f.launches.length, launchesBefore,
      'the ownership adaptation must not relaunch any transport worker');

    // The final integration checkout HEAD is the promoted candidate commit.
    const finalHead = f.git(['rev-parse', 'HEAD']).trim();
    assert.equal(finalHead, integrated.target?.candidate_commit,
      'the final repository HEAD must equal the integrated candidate commit');
  });

// ---------------------------------------------------------------------------
// Additive pending-input resume regression. A held single-member wave is started
// with one real owner; before the owner mutates or submits, a coordinator
// direction is written to the package inbox, so the completion route parks the
// member as a visible 'input-pending' queue entry instead of reviewing it. No
// reviewer may launch and the branch must stay at base while the inbox holds the
// direction. Once the coordinator moves the note into inbox/processed and issues
// a step-less advance at the current generation, the parked member must resume
// through its real completion route: one reviewer launches, the member seals and
// the promotion sets the branch HEAD to the candidate.
test('wave dispatch: pending inbox holds review and an explicit advance resumes it once',
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

    const recordPath = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id ?? WAVE_ID}.json`);
    const readRecord = () => JSON.parse(readFileSync(recordPath, 'utf8'));
    const waveId = receipt.wave_id ?? WAVE_ID;
    const reviewerLaunches = () => f.launches.filter(launch => launch.role === 'reviewer');

    // First boundary: the single owner starts and records its pid while the
    // barrier still holds it, so the inbox direction lands before completion.
    await waitFor(() => {
      const lines = readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      return lines.length >= 1 ? lines : false;
    }, CASE4_TIMEOUT_MS, 'member 001 owner started');

    // A coordinator direction is pending in the package inbox. It must divert the
    // member's completion into the visible input-pending queue rather than review.
    const inboxDir = join(f.packagePath, 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, 'hold-1.md'), '# hold\n\ncoordinator direction pending\n');

    f.releaseOwners();

    // The real completion route parks the member as 'input-pending' with its
    // implementation run recorded; no reviewer may launch from that route.
    const parked = await waitFor(() => {
      const current = readRecord();
      const member = current.members?.['1'];
      return member?.phase === 'queued' && member?.queue_reason === 'input-pending' ? { current, member } : false;
    }, CASE4_TIMEOUT_MS, 'member 001 parks as input-pending');

    assert.equal(reviewerLaunches().length, 0,
      'no reviewer may launch while the inbox holds a pending direction');
    const blockedSends = f.sends.filter(sent => {
      const text = JSON.stringify(sent.message ?? '');
      return text.includes('member-blocked') && text.includes(waveId);
    });
    assert.equal(blockedSends.length, 1,
      'exactly one member-blocked send must report the input-pending block');
    assert.match(JSON.stringify(blockedSends[0].message ?? ''), /input-pending/,
      'the member-blocked send must carry the input-pending reason');
    assert.ok(typeof parked.member.implementation_run_id === 'string' && parked.member.implementation_run_id.length > 0,
      'the parked member must retain its implementation run id');
    assert.equal(f.git(['rev-parse', 'HEAD']).trim(), f.baseCommit,
      'the branch HEAD must remain at base while the direction is pending');

    // F10-5 precedence regression: while the inbox still holds the direction,
    // the durable status must remain running and surface the input-pending
    // queue ahead of any blocked classification. A blocked state here would
    // satisfy the parking assertions above without exercising the precedence
    // between the pending intake and the resume path.
    assert.equal(parked.current.state, 'running',
      'the wave must remain running while the direction is pending');
    const pendingStatus = await f.controller.status({ package: f.packagePath, wave_id: waveId });
    assert.match(String(pendingStatus.next_action ?? ''), /consume the inbox, then advance/,
      'status must direct the coordinator to consume the inbox before advancing');

    // The coordinator consumes the direction: move it into inbox/processed and
    // issue a step-less advance at the current generation. The parked member must
    // resume its real completion route exactly once.
    const processedDir = join(f.packagePath, 'inbox', 'processed');
    mkdirSync(processedDir, { recursive: true });
    writeFileSync(join(processedDir, 'hold-1.md'), readFileSync(join(inboxDir, 'hold-1.md'), 'utf8'));
    unlinkSync(join(inboxDir, 'hold-1.md'));

    const advanced = await f.controller.advance({
      package: f.packagePath,
      wave_id: waveId,
      expected_generation: parked.current.generation
    });
    assert.ok(advanced, 'the step-less resume advance must return a receipt');

    const integrated = await waitFor(() => {
      const current = readRecord();
      return current.state === 'integrated' ? current : false;
    }, CASE4_TIMEOUT_MS, 'the resumed wave record integrates');

    await waitFor(() => f.sends.some(sent => {
      const text = JSON.stringify(sent.message ?? '');
      return text.includes('promotion-result') && text.includes(waveId);
    }), CASE4_TIMEOUT_MS, `promotion-result send for wave ${waveId}`);

    // Exactly one reviewer launch and one owner launch across the whole case: the
    // resume reuses the parked member's implementation run instead of relaunching.
    assert.equal(reviewerLaunches().length, 1,
      'the resumed member must be reviewed exactly once');
    assert.equal(f.launches.filter(launch => launch.role === 'owner').length, 1,
      'the resume must not relaunch the parked owner');

    // The member sealed and the promotion moved the branch HEAD to the candidate.
    assert.equal(integrated.members?.['1']?.phase, 'sealed',
      'the resumed member must seal after its review');
    assert.ok(integrated.target?.candidate_commit, 'the integrated wave must expose a candidate commit');
    assert.equal(f.git(['rev-parse', 'HEAD']).trim(), integrated.target.candidate_commit,
      'the branch HEAD must equal the promoted candidate commit');
  });

// Step 10, edit 6: the pure `phaseLifecycle` classifier. Only the external
// boundaries are substituted (the systemd adapter's inspect and the POSIX
// process observer); classification correctness is asserted per row so a
// change in any single observation is independently visible.
