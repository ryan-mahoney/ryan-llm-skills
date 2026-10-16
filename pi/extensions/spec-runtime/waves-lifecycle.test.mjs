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

test('wave dispatch: seal accepts the durable nested coordinator identity',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const f = await makeCase4Fixture(t, { memberCount: 1 });

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

    // The durable coordinator identity nests the live claim identity: the seal
    // boundary must accept the same process the wave was opened under.
    const recordPath = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id ?? WAVE_ID}.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.ok(Number.isSafeInteger(record.coordinator?.process_identity?.pid) && record.coordinator.process_identity.pid > 0,
      'the durable wave record must carry a live coordinator process identity');

    // Wait for the real lifecycle to reach a terminal member phase. A blocked
    // member is the failure path; the sealed phase is the success boundary.
    const readMemberPhase = () => {
      const wave = JSON.parse(readFileSync(recordPath, 'utf8'));
      return wave.members?.['1']?.phase ?? null;
    };
    const phase = await waitFor(() => {
      const current = readMemberPhase();
      return current === 'sealed' || current === 'blocked' ? current : false;
    }, 15000, 'member 001 reaches sealed or blocked');

    const sealPath = join(f.packagePath, 'runtime', 'waves', receipt.wave_id ?? WAVE_ID, 'step-001-seal.json');
    const seal = existsSync(sealPath) ? JSON.parse(readFileSync(sealPath, 'utf8')) : null;
    const sealReasons = JSON.stringify(seal?.reasons ?? record.members?.['1']?.reasons ?? []);
    assert.equal(phase, 'sealed', `member 001 must seal at the coordinator boundary; seal reasons: ${sealReasons}`);

    assert.ok(seal, 'a durable seal receipt must exist at runtime/waves/<wave_id>/step-001-seal.json');
    assert.equal(seal.state, 'sealed', `the seal receipt must record state sealed; reasons: ${sealReasons}`);
    assert.deepEqual(seal.reasons, [], 'a sealed receipt must carry no blocking reasons');
    assert.ok(typeof seal.sealed_head === 'string' && seal.sealed_head.length > 0, 'a sealed receipt must carry a nonempty sealed head');
    const sealMember = JSON.parse(readFileSync(recordPath, 'utf8')).members?.['1'];
    assert.ok(typeof sealMember?.head_commit === 'string' && /^[0-9a-f]{40}$/.test(sealMember.head_commit),
      'the sealed member must record a full SHA head_commit');
    assert.equal(sealMember.head_commit, seal.sealed_head,
      'the member head_commit must equal the seal sealed_head');
    assert.ok(typeof seal.retention_ref === 'string' && seal.retention_ref.length > 0, 'a sealed receipt must carry a nonempty retention ref');
    assert.ok(seal.drained_phases.some(entry => entry.phase === 'seal'), 'the sealed receipt must record the seal phase as drained');
  });

test('wave dispatch: a fixed member runs gates and confirmation with the durable coordinator identity',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    // The default two-member fixture: step 2's first review returns needs-fix,
    // so member 2 must traverse fixing and then a confirmation pass before it
    // can seal. This is the gate/confirmation boundary the durable coordinator
    // identity must carry through.
    const f = await makeCase4Fixture(t);

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

    // The durable coordinator identity nests the live claim identity: the same
    // process the wave was opened under must carry the gate and confirmation
    // launches for the fixed member.
    const recordPath = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id ?? WAVE_ID}.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.ok(Number.isSafeInteger(record.coordinator?.process_identity?.pid) && record.coordinator.process_identity.pid > 0,
      'the durable wave record must carry a live coordinator process identity');

    // Wait for both members to reach a terminal member phase. A blocked member is
    // the failure path; the sealed phase is the success boundary.
    const readMembers = () => JSON.parse(readFileSync(recordPath, 'utf8')).members ?? {};
    const members = await waitFor(() => {
      const current = readMembers();
      const list = ['1', '2'].map(step => current[step]);
      return list.every(member => member && (member.phase === 'sealed' || member.phase === 'blocked')) ? list : false;
    }, 15000, 'members 001 and 002 reach sealed or blocked');

    const freshRecord = JSON.parse(readFileSync(recordPath, 'utf8'));
    const sealPath2 = join(f.packagePath, 'runtime', 'waves', receipt.wave_id ?? WAVE_ID, 'step-002-seal.json');
    const seal2 = existsSync(sealPath2) ? JSON.parse(readFileSync(sealPath2, 'utf8')) : null;
    const blocking2 = `${JSON.stringify(seal2?.reasons ?? freshRecord.members?.['2']?.reasons ?? [])}${seal2?.detail ? ` ${JSON.stringify(seal2.detail)}` : ''}${freshRecord.members?.['2']?.blocking_reason ? ` ${JSON.stringify(freshRecord.members['2'].blocking_reason)}` : ''}${freshRecord.members?.['2']?.blocking_detail ? ` ${JSON.stringify(freshRecord.members['2'].blocking_detail)}` : ''}`;
    assert.ok(members.every(member => member.phase === 'sealed'),
      `both members must seal at the coordinator boundary; member 002 blocking reason/detail: ${blocking2}`);

    // Member 2 is the fixed member: it must have run a fixing launch and then a
    // confirmation launch, reaching stage_attempt 3 (review, fix, confirm).
    const member2 = freshRecord.members?.['2'];
    const phases2 = (member2?.transitions ?? []).map(entry => entry.phase);
    assert.ok(phases2.includes('fixing'), `member 002 transitions must include fixing; saw: ${phases2.join(', ')}`);
    assert.ok(phases2.includes('confirming'), `member 002 transitions must include confirming; saw: ${phases2.join(', ')}`);
    assert.equal(member2?.stage_attempt, 3, `member 002 must reach stage_attempt 3; saw: ${member2?.stage_attempt}`);

    // Both members record a full SHA head_commit for their sealed head.
    assert.ok(typeof member2?.head_commit === 'string' && /^[0-9a-f]{40}$/.test(member2.head_commit),
      'the fixed member must record a full SHA head_commit');
    const member1 = freshRecord.members?.['1'];
    assert.ok(typeof member1?.head_commit === 'string' && /^[0-9a-f]{40}$/.test(member1.head_commit),
      'the first member must record a full SHA head_commit');

    // The fixed member's durable seal receipt must record the sealed state, no
    // blocking reasons, and the drained gates and seal phases.
    assert.ok(seal2, 'a durable seal receipt must exist at runtime/waves/<wave_id>/step-002-seal.json');
    assert.equal(seal2.state, 'sealed', `the seal receipt must record state sealed; reasons: ${blocking2}`);
    assert.deepEqual(seal2.reasons, [], 'a sealed receipt must carry no blocking reasons');
    const drainedPhases2 = (seal2.drained_phases ?? []).map(entry => entry.phase);
    assert.ok(drainedPhases2.includes('seal'), `the sealed receipt must record the seal phase as drained; saw: ${drainedPhases2.join(', ')}`);
    assert.ok(seal2.gate_receipts.length > 0, 'the sealed receipt must record at least one gate receipt');
  });

// ---------------------------------------------------------------------------
// Control-entry regressions (step 10, additive only). The entries below are
// read-only or cancellation boundaries on the real controller: status must not
// mutate the durable record or launch anything, a replayed startup must load
// the same wave, and cancel must persist its intent before any signal while
// leaving sealed siblings untouched. No existing fixture or case is changed.

// status is a pure read: it reports the same wave, generation and state and
// leaves the durable record byte-identical, launching nothing. A repeated
// startup with identical inputs loads the same wave and adds no launches.
test('wave dispatch: status replay and stale generation are read only',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const f = await makeCase4Fixture(t, { memberCount: 2, holdOwners: true });

    const input = {
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

    const first = await f.controller.startup(input, { session: COORDINATOR_SESSION });
    await f.controller.startup(input, { session: COORDINATOR_SESSION });
    const recordPath = first.record_path ?? join(f.packagePath, 'runtime', 'waves', `${first.wave_id ?? WAVE_ID}.json`);

    // Wait until both held owners are live so status observes a running wave.
    await waitFor(() => {
      const lines = readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      return lines.length >= 2 ? lines : false;
    }, CASE4_TIMEOUT_MS, 'both held owners started');

    const beforeBytes = readFileSync(recordPath, 'utf8');
    const beforeRecord = JSON.parse(beforeBytes);
    const launchesBefore = f.launches.length;

    const status = await f.controller.status({ package: f.packagePath, wave_id: first.wave_id });
    assert.equal(status.wave_id, beforeRecord.wave_id, 'status must report the same wave');
    assert.equal(status.generation, beforeRecord.generation, 'status must report the same generation');
    assert.equal(status.state, beforeRecord.state, 'status must report the same state');

    // Read-only: no record revision change, no new launches.
    assert.equal(f.launches.length, launchesBefore, 'status must launch nothing');
    assert.equal(readFileSync(recordPath, 'utf8'), beforeBytes, 'status must not change the durable record bytes');
    assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).revision, beforeRecord.revision, 'status must not advance the revision');

    // Replayed startup with identical inputs loads the same wave.
    const replayed = await f.controller.startup(input, { session: COORDINATOR_SESSION });
    assert.equal(replayed.wave_id, first.wave_id, 'a replayed startup must return the same wave_id');
    assert.equal(replayed.generation, first.generation, 'a replayed startup must return the same generation');
    assert.equal(replayed.loaded, true, 'a replayed startup must report the wave as loaded');
    assert.equal(f.launches.length, launchesBefore, 'a replayed startup must add no launches');

    // advance and recover must refuse a stale expected_generation and leave the
    // durable record byte-identical.
    const afterReplayBytes = readFileSync(recordPath, 'utf8');
    for (const entry of ['advance', 'recover']) {
      await assert.rejects(
        () => f.controller[entry]({ package: f.packagePath, wave_id: first.wave_id, expected_generation: 2 }),
        error => error?.code === 'stale-generation',
        `${entry} with a stale generation must reject stale-generation`);
      assert.equal(readFileSync(recordPath, 'utf8'), afterReplayBytes,
        `${entry} with a stale generation must not change the record bytes`);
    }
  });

// cancel persists its intent durably before signalling, then cancels every
// non-sealed member while leaving sealed siblings alone, releasing all live
// runs and launching no reviewer.
test('wave dispatch: cancellation persists intent before signalling and preserves sealed siblings',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const f = await makeCase4Fixture(t, { memberCount: 2, holdOwners: true });

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

    await waitFor(() => {
      const lines = readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      return lines.length >= 2 ? lines : false;
    }, CASE4_TIMEOUT_MS, 'both held owners started');

    const recordPath = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id ?? WAVE_ID}.json`);

    // Wrap runtime.cancel (binding the original) to read the durable record on
    // every invocation: the intent must already be persisted before any signal.
    const originalCancel = f.runtime.cancel.bind(f.runtime);
    const observedIntents = [];
    f.runtime.cancel = (...args) => {
      observedIntents.push(JSON.parse(readFileSync(recordPath, 'utf8')));
      return originalCancel(...args);
    };

    const cancelled = await f.controller.cancel({
      package: f.packagePath,
      wave_id: receipt.wave_id,
      expected_generation: 1
    });

    assert.equal(cancelled.state, 'cancelled', 'cancel must return a cancelled receipt');
    const finalRecord = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(finalRecord.state, 'cancelled', 'the durable record must reach the cancelled state');

    // Every non-sealed member is cancelled; no sealed sibling exists here, so
    // both members must be cancelled.
    for (const member of Object.values(finalRecord.members ?? {})) {
      if (member.phase !== 'sealed') assert.equal(member.phase, 'cancelled', 'every non-sealed member must be cancelled');
    }

    // Teardown owns releasing the remaining runs.
    assert.equal(f.runtime.active.size, 0, 'no run may remain active after cancel returns');
    assert.ok(observedIntents.length >= 1, 'cancel must have signalled at least one live run');
    for (const snapshot of observedIntents) {
      const intent = snapshot.effects?.cancel;
      assert.ok(intent, 'a cancel intent must be persisted before the signal');
      assert.equal(intent.outcome, null, 'the cancel intent outcome must be null before signalling');
      assert.equal(snapshot.state, 'cancelled', 'the wave state must already be cancelled when signalling');
    }

    // No reviewer may be launched by cancellation; the final intent outcome is
    // recorded once the signal completes.
    assert.equal(f.launches.filter(launch => launch.role === 'reviewer').length, 0, 'cancel must launch no reviewer');
    const settled = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.notEqual(settled.effects?.cancel?.outcome ?? null, null, 'the cancel intent outcome must be recorded');

    // Nested step cancel: a fresh held fixture cancels only step 001's run.
    const g = await makeCase4Fixture(t, { memberCount: 2, holdOwners: true });
    const stepReceipt = await g.controller.startup({
      package: g.packagePath,
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

    await waitFor(() => {
      const lines = readFileSync(g.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      return lines.length >= 2 ? lines : false;
    }, CASE4_TIMEOUT_MS, 'both held owners started for step cancel');

    const stepRecordPath = stepReceipt.record_path ?? join(g.packagePath, 'runtime', 'waves', `${stepReceipt.wave_id ?? WAVE_ID}.json`);
    const secondRunId = JSON.parse(readFileSync(stepRecordPath, 'utf8')).members?.['2']?.run_id ?? null;

    await g.controller.cancel({
      package: g.packagePath,
      wave_id: stepReceipt.wave_id,
      step: 'step-001-subspec.md',
      expected_generation: 1
    });

    const afterStepCancel = JSON.parse(readFileSync(stepRecordPath, 'utf8'));
    assert.equal(afterStepCancel.members?.['1']?.phase, 'cancelled', 'only the targeted step must cancel');
    assert.equal(afterStepCancel.members?.['2']?.phase, 'implementing', 'the sibling step must keep implementing');
    assert.equal(afterStepCancel.state, 'blocked', 'a nested step cancel must leave the wave blocked');
    assert.notEqual(secondRunId, null, 'the sibling run must still be recorded');
    assert.equal(g.runtime.active.has(secondRunId), true, 'the sibling run must still be active');

    // Blocked drain: monkeypatch runtime.cancel to report a blocked state without
    // cancelling anything. The durable cancel intent must stay null before the
    // invocation, the wave must return blocked, effects.cancel must record
    // drain-unconfirmed, and no ownership claim may be released on a live run.
    const h = await makeCase4Fixture(t, { memberCount: 2, holdOwners: true });
    const blockedReceipt = await h.controller.startup({
      package: h.packagePath,
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

    await waitFor(() => {
      const lines = readFileSync(h.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      return lines.length >= 2 ? lines : false;
    }, CASE4_TIMEOUT_MS, 'both held owners started for blocked cancel');

    const blockedRecordPath = blockedReceipt.record_path ?? join(h.packagePath, 'runtime', 'waves', `${blockedReceipt.wave_id ?? WAVE_ID}.json`);
    const beforeBlocked = JSON.parse(readFileSync(blockedRecordPath, 'utf8'));
    assert.equal(beforeBlocked.effects?.cancel ?? null, null, 'no durable cancel intent may exist before invocation');

    const originalBlockedCancel = h.runtime.cancel.bind(h.runtime);
    h.runtime.cancel = () => ({ state: 'blocked' });
    t.after(() => { h.runtime.cancel = originalBlockedCancel; });

    const blockedResult = await h.controller.cancel({
      package: h.packagePath,
      wave_id: blockedReceipt.wave_id,
      expected_generation: 1
    });

    assert.equal(blockedResult.state, 'blocked', 'a blocked drain must return a blocked wave receipt');
    const afterBlocked = JSON.parse(readFileSync(blockedRecordPath, 'utf8'));
    assert.equal(afterBlocked.effects?.cancel?.outcome, 'drain-unconfirmed', 'a blocked drain must record drain-unconfirmed');
    assert.equal(afterBlocked.state, 'blocked', 'the durable record must stay blocked');
    // The live runs were never actually cancelled, so their ownership claims
    // (and the active handles) must remain intact.
    assert.ok(h.runtime.active.size > 0, 'no ownership claim may be released on a drain-unconfirmed cancel');
  });

test('wave dispatch: stale cancellation is read only and repeated cancellation preserves sealed siblings',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const f = await makeCase4Fixture(t, { memberCount: 2, holdOwners: true });

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

    await waitFor(() => {
      const lines = readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      return lines.length >= 2 ? lines : false;
    }, CASE4_TIMEOUT_MS, 'both held owners started');

    const recordPath = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id ?? WAVE_ID}.json`);

    // A stale generation is read-only: the record bytes and the launch count
    // must be identical across the rejected cancel.
    const beforeStale = readFileSync(recordPath);
    const launchesBeforeStale = f.launches.length;
    await assert.rejects(
      () => f.controller.cancel({
        package: f.packagePath,
        wave_id: receipt.wave_id,
        expected_generation: 2
      }),
      error => error?.code === 'stale-generation'
    );
    assert.ok(readFileSync(recordPath).equals(beforeStale), 'a stale cancel must leave the record bytes unchanged');
    assert.equal(f.launches.length, launchesBeforeStale, 'a stale cancel must launch nothing');

    // Release only owner 1 so member 1 seals while member 2 stays held.
    f.releaseOwner(1);
    await waitFor(() => {
      const record = JSON.parse(readFileSync(recordPath, 'utf8'));
      return record.members?.['1']?.phase === 'sealed';
    }, CASE4_TIMEOUT_MS, 'member 1 sealed while member 2 is held');

    const beforeRepeat = readFileSync(recordPath);
    const launchesBeforeRepeat = f.launches.length;

    await f.controller.cancel({
      package: f.packagePath,
      wave_id: receipt.wave_id,
      expected_generation: 1
    });

    const afterCancel = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(afterCancel.members?.['1']?.phase, 'sealed', 'the sealed sibling must keep its sealed phase');
    assert.equal(afterCancel.members?.['2']?.phase, 'cancelled', 'only the non-sealed sibling may be cancelled');
    assert.equal(f.runtime.active.size, 0, 'no run may remain active after cancel returns');

    // Repeating the same cancel must be a no-op: byte-for-byte unchanged record
    // and no further launch.
    const terminalBytes = readFileSync(recordPath);
    const launchesAtTerminal = f.launches.length;
    await f.controller.cancel({
      package: f.packagePath,
      wave_id: receipt.wave_id,
      expected_generation: 1
    });
    assert.ok(readFileSync(recordPath).equals(terminalBytes), 'a repeated cancel must leave the terminal record byte-for-byte unchanged');
    assert.equal(f.launches.length, launchesAtTerminal, 'a repeated cancel must launch nothing');
  });

test('wave dispatch: shutdown drains active candidate handles without relaunching',
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

    await waitFor(() => {
      const lines = readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
      return lines.length >= 1 ? lines : false;
    }, CASE4_TIMEOUT_MS, 'the held owner started');

    const recordPath = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id ?? WAVE_ID}.json`);

    // Move the active member-1 run identity into target.repair as a controlled
    // fixture, modelling the integration-repair candidate run. This exercises the
    // controller's own handle enumeration, not candidate launch bindings.
    const heldRunId = JSON.parse(readFileSync(recordPath, 'utf8')).members?.['1']?.run_id ?? null;
    assert.notEqual(heldRunId, null, 'the held member must have a durable run_id');
    assert.equal(f.runtime.active.has(heldRunId), true, 'the held run must be active before shutdown');

    const moved = JSON.parse(readFileSync(recordPath, 'utf8'));
    moved.target = {
      ...(moved.target ?? {}),
      repair: {
        n: 1,
        step: 1,
        attempt_id: 'candidate-1',
        phase: 'integration-repair',
        run_id: heldRunId,
        implementation_run_id: heldRunId
      }
    };
    delete moved.members['1'].run_id;
    delete moved.members['1'].implementation_run_id;
    writeFileSync(recordPath, JSON.stringify(moved));

    const launchesBeforeShutdown = f.launches.length;
    await f.controller.shutdown();

    assert.equal(f.runtime.active.has(heldRunId), false, 'shutdown must drain the active candidate handle');
    assert.equal(f.launches.length, launchesBeforeShutdown, 'shutdown must not relaunch anything');
    const afterShutdown = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(afterShutdown.target?.repair?.phase, 'integration-repair', 'the repair phase must be retained for recovery');

    // A notification for this wave after shutdown must be accepted (true) yet
    // cannot mutate the record or launch a replacement from a stale handle.
    const launchesAfterShutdown = f.launches.length;
    const recordBytesAfterShutdown = readFileSync(recordPath);
    assert.equal(f.controller.routeNotification({
      wave: { wave_id: receipt.wave_id, generation: receipt.generation ?? 1 },
      run_id: heldRunId,
      session: COORDINATOR_SESSION
    }), true, 'routeNotification must accept a summary for this wave');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.ok(readFileSync(recordPath).equals(recordBytesAfterShutdown), 'a post-shutdown notification must not mutate the record');
    assert.equal(f.launches.length, launchesAfterShutdown, 'a post-shutdown notification must launch nothing');
  });

// ---------------------------------------------------------------------------
// Automatic next-wave progression. A three-member wave is mutated so step 3
// depends on steps 1 and 2 and the wave_checks are split across two waves
// ([[1, 2], [3]]). Progression from the first wave to the second must happen
// without any extra controller entry: it arrives through notify.
