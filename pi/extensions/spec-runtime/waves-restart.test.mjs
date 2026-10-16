// C10-6 regression (step 10): a restarted coordinator with a FRESH epoch must
// be able to open the next wave of a two-wave package after it adopts a wave
// that a dead coordinator had owned. Each Pi process gets a fresh random
// coordinator epoch, but adoption keeps the OLD epoch on the durable wave record
// and the package claim. Once the adopted wave integrates, the live coordinator
// (new epoch) must still be able to open the successor wave on the promoted
// base -- both when the automatic continuation drives it and when a fresh
// `startup` does.
//
// These tests are authored first: they assert the intended contract and are
// expected to fail (red) against the unfixed implementation. No production
// files are touched here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { validateStepIndex } from '../../../scripts/spec-observe/steps.mjs';
import { inspectProcess } from '../../../scripts/spec-observe/process-identity.mjs';
import { readCheckpointRecord } from './sentinel.mjs';
import { calculateResourcePolicy, MIB } from './linux-resources.mjs';
import {
  CASE4_TIMEOUT_MS,
  WAVE_ID,
  COORDINATOR_SESSION,
  isAncestor,
  makeCase4Fixture,
  waitFor
} from './waves-fixture.mjs';

// Diagnostic budget for the waits below: shorter than the per-test 120s node:test
// timeout so a wedged condition fails with a durable snapshot instead of the
// whole file being cancelled without evidence.
const WAIT_TIMEOUT_MS = 15000;

const MODELS = {
  owner_model: 'fixture-provider/team/owner',
  strong_owner_model: 'fixture-provider/team/owner',
  editor_model: 'fixture-provider/team/owner',
  review_model: 'fixture-provider/team/reviewer:high',
  fix_model_override: 'fixture-provider/team/owner',
  scout_model: 'fixture-provider/team/scout'
};

// The exact ready-host shape the fixture's default hostCheck returns. Restart
// cases reuse it for every check they do not deliberately suppress.
function readyHost({ readyMembers = 16, explicitCap = null } = {}) {
  const policy = calculateResourcePolicy({
    physicalMemoryBytes: 256 * 1024 * MIB,
    aggregateTasks: 32768,
    readyMembers,
    explicitCap
  });
  return {
    version: 1,
    status: 'ready',
    ok: true,
    reason: 'ready',
    remedy: null,
    nativeReady: true,
    softwareCeiling: policy.softwareCeiling,
    route: 'native',
    fallback: null,
    host: { host_id: 'fixture-host', boot_id: 'fixture-boot', uid: process.getuid?.() ?? 1000 },
    admission: {
      status: 'ready', reason: 'admitted', remedy: null,
      admittedWidth: policy.admittedWidth, binding: 'ready-width',
      bindings: policy.bindings, launchable: true, slots: policy.slots, free: policy.free
    },
    policy,
    overlay: { status: 'unavailable', reason: 'fixture-worktree-transport', remedy: null, fallbackEligible: true }
  };
}

function readWaveRecords(packagePath) {
  const dir = join(packagePath, 'runtime', 'waves');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      try { return { name, record: JSON.parse(readFileSync(join(dir, name), 'utf8')) }; }
      catch { return { name, record: null }; }
    })
    .filter(entry => entry.record !== null);
}

// Build a bounded, read-only snapshot of the durable fixture state for a wedged
// wait: wave records with member phases and blocked reasons, the most recent
// launch stderr, recent sends and the currently held claims. It never decides a
// result; the caller rethrows the original failure with this evidence attached.
async function diagnosticSnapshot(f) {
  let claims;
  try {
    const inspected = await f.ownership.inspectClaims({ packageId: f.packageRef });
    claims = (inspected?.claims ?? []).map(claim => ({
      kind: claim.kind,
      token: claim.token,
      epoch: claim.epoch,
      state: claim.state ?? null,
      session: claim.coordinator?.session ?? null
    }));
  } catch (error) {
    claims = [{ error: String(error?.message ?? error) }];
  }
  const waveRecords = readWaveRecords(f.packagePath).map(({ name, record }) => ({
    name,
    wave_id: record.wave_id,
    ordinal: record.ordinal ?? null,
    generation: record.generation ?? null,
    state: record.state ?? null,
    claim_token: record.claim_token ?? null,
    coordinator_epoch: record.coordinator?.epoch ?? null,
    coordinator_session: record.coordinator?.session ?? null,
    blocking_reason: record.blocking_reason ?? null,
    blocking_detail: record.blocking_detail ?? null,
    members: Object.fromEntries(Object.entries(record.members ?? {}).map(([step, member]) => [step, {
      phase: member.phase ?? null,
      attempt_id: member.attempt_id ?? null,
      blocking_reason: member.blocking_reason ?? null,
      blocking_detail: member.blocking_detail ?? null,
      queue_reason: member.queue_reason ?? null
    }])),
    effects: Object.fromEntries(Object.entries(record.effects ?? {}).map(([key, effect]) => [key, {
      kind: effect?.kind ?? null,
      outcome: effect?.outcome ?? null,
      reason: effect?.reason ?? null
    }]))
  }));
  const launches = f.launches.slice(-6).map(launch => ({
    id: launch.id,
    unit: launch.unit,
    role: launch.role,
    stage: launch.stage ?? null,
    status: launch.status,
    main_pid: launch.main_pid,
    stderr: String(launch.stderr ?? '').slice(-500)
  }));
  const sends = f.sends.slice(-6).map(sent => JSON.stringify(sent.message ?? {}).slice(0, 400));
  return `\n--- diagnostic snapshot ---\n${JSON.stringify({ waveRecords, launches, sends, heldClaims: claims }, null, 2)}`;
}

async function waitForWithDiagnostics(f, predicate, label) {
  try {
    return await waitFor(predicate, WAIT_TIMEOUT_MS, label);
  } catch (error) {
    try {
      error.message = `${error.message}${await diagnosticSnapshot(f)}`;
    } catch (snapshotError) {
      error.message = `${error.message}\n(diagnostic snapshot failed: ${snapshotError?.message ?? snapshotError})`;
    }
    throw error;
  }
}

// One shared prologue: open wave 1 with two held owners under a disposable
// coordinator identity at epoch 1, kill that coordinator, then adopt wave 1
// from a fresh session in THIS process at epoch 2 (the C10-6 restart shape).
async function startHeldTwoWaveRun(t, { hostCheck, session }) {
  // Adoption latch: before recover() the retained synthetic runs must read as
  // populated so old-phase recovery can adopt them; after recover() the fixture
  // must defer to the exact service observation or a later phase drain wedges on
  // a permanently populated classification.
  let adopted = false;
  let fixture = null;
  // Disposable coordinator identity. Register cleanup before any await so a
  // failed start still kills the child exactly once.
  const coordinatorChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
  let childCleaned = false;
  const cleanupChild = async () => {
    if (childCleaned) return;
    childCleaned = true;
    if (coordinatorChild.exitCode === null && coordinatorChild.signalCode === null) {
      try { coordinatorChild.kill('SIGKILL'); } catch { /* already gone */ }
      await new Promise(resolve => coordinatorChild.once('close', resolve));
    }
  };
  t.after(cleanupChild);

  const childIdentity = await waitFor(() => {
    const identity = inspectProcess(coordinatorChild.pid);
    return identity?.state === 'alive' ? identity : false;
  }, WAIT_TIMEOUT_MS, 'disposable coordinator identity is alive');

  const f = await makeCase4Fixture(t, {
    memberCount: 3,
    holdOwners: true,
    ...(hostCheck ? { hostCheck } : {}),
    coordinator: {
      session: COORDINATOR_SESSION,
      epoch: 1,
      pid: childIdentity.pid,
      started_at: childIdentity.started_at
    },
    lifecycle: {
      inspect: async (run, options) => {
        if (adopted && fixture && run?.service) {
          const observed = await fixture.adapter.inspect(run.service, options);
          if (observed?.status === 'confirmed') return observed;
        }
        return { status: 'populated', reason: 'unit-populated' };
      }
    },
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
  fixture = f;

  const precondition = validateStepIndex(f.index, { targets: [f.targetId], evidencePlan: f.evidencePlan });
  assert.equal(precondition.ok, true, `mutated index invalid: ${(precondition.errors ?? []).join('; ')}`);
  assert.equal(precondition.concurrency_ready, true, 'mutated index must be concurrency ready');
  assert.deepEqual(precondition.waves, [[1, 2], [3]], 'the precondition must expose waves [[1, 2], [3]]');

  const receipt = await f.controller.startup({
    package: f.packagePath,
    workflow_id: WAVE_ID,
    execution: 'waves',
    isolation: 'worktree',
    ...MODELS
  }, { session: COORDINATOR_SESSION });
  const waveFile = receipt.record_path ?? join(f.packagePath, 'runtime', 'waves', `${receipt.wave_id ?? WAVE_ID}.json`);
  const readRecord = () => JSON.parse(readFileSync(waveFile, 'utf8'));

  // Both wave-1 owners are launched and held at the owner barrier.
  await waitForWithDiagnostics(f, () => {
    const lines = readFileSync(f.startsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
    return lines.length >= 2 ? lines : false;
  }, 'two held wave-1 owners started');

  const claimBefore = (await f.ownership.inspectClaims({ packageId: f.packageRef }))
    .claims.find(claim => claim.kind === 'package');
  assert.ok(claimBefore, 'wave 1 must hold a package claim before the restart');
  const creationEpoch = String(claimBefore.epoch);
  const claimToken = claimBefore.token;
  assert.equal(creationEpoch, '1', 'the package claim must be created at the initial epoch 1');

  // Kill the coordinator that owns the claim; nothing recovers until we do.
  coordinatorChild.kill('SIGKILL');
  await new Promise(resolve => coordinatorChild.once('close', resolve));
  assert.equal(inspectProcess(coordinatorChild.pid).state, 'dead', 'the disposable coordinator must be positively dead');

  // The same coordinator session restarts in THIS process at a NEW epoch (the
  // C10-6 same-session restart shape). `session` is only a diagnostic label for
  // the caller; the durable coordinator identity stays COORDINATOR_SESSION.
  const ownIdentity = inspectProcess(process.pid);
  f.coordinator.session = COORDINATOR_SESSION;
  f.coordinator.pid = ownIdentity.pid;
  f.coordinator.started_at = ownIdentity.started_at;
  f.coordinator.epoch = 2;

  // Rebuild the controller AFTER the coordinator swap and BEFORE recover so the
  // replacement process really restarts rather than a live controller adopting.
  const replacement = f.replaceController();

  let recovered;
  try {
    recovered = await f.controller.recover({
      package: f.packagePath,
      wave_id: receipt.wave_id ?? WAVE_ID,
      expected_generation: 1
    });
  } catch (error) {
    try { error.message = `${error.message}${await diagnosticSnapshot(f)}`; }
    catch { /* keep the original recovery failure */ }
    throw error;
  }
  adopted = true;
  assert.equal(recovered.wave_id ?? WAVE_ID, receipt.wave_id ?? WAVE_ID, 'recovery must report the same wave');

  const afterRecover = readRecord();
  assert.equal(String(afterRecover.coordinator?.epoch ?? ''), creationEpoch,
    'adoption must preserve the claim-creation epoch on the durable wave record');
  assert.equal(afterRecover.coordinator?.session, COORDINATOR_SESSION,
    'adoption must preserve the coordinator session across the same-session restart');

  const claimAfter = (await f.ownership.inspectClaims({ packageId: f.packageRef }))
    .claims.find(claim => claim.kind === 'package');
  assert.ok(claimAfter, 'the package claim must survive adoption');
  assert.equal(claimAfter.token, claimToken, 'adoption must keep the same package claim token');
  assert.equal(String(claimAfter.epoch), creationEpoch, 'adoption must keep the claim-creation epoch');
  assert.equal(claimAfter.coordinator?.session, COORDINATOR_SESSION, 'adoption must preserve the coordinator session on the claim');

  // Let the held owners (and their post-recovery replacements) finish wave 1.
  f.releaseOwners();

  return { f, replacement, receipt, waveFile, readRecord, creationEpoch, claimToken };
}

// Shared tail: wave 2 integrates on wave 1's promoted base and no wave surfaces
// a package-owned refusal.
async function assertTwoWaveProgression(f, readRecord) {
  assert.ok(typeof readRecord === 'function', 'internal: readRecord is required');

  const records = await waitForWithDiagnostics(f, () => {
    const integrated = readWaveRecords(f.packagePath)
      .map(entry => entry.record)
      .filter(record => record.state === 'integrated');
    return integrated.length === 2 ? integrated : false;
  }, 'two integrated wave records');

  const sorted = records.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  assert.deepEqual(sorted.map(record => record.ordinal), [1, 2], 'the records must be wave ordinals 1 and 2');
  const [first, second] = sorted;
  assert.deepEqual(Object.keys(first.members ?? {}).sort(), ['1', '2'], 'wave 1 must hold steps 1 and 2');
  assert.deepEqual(Object.keys(second.members ?? {}).sort(), ['3'], 'wave 2 must hold the dependent step 3');

  // The terminal promotion-result send for wave 2 is the boundary for all final
  // effects (the barrier emits it only after the record is integrated).
  await waitForWithDiagnostics(f, () => f.sends.some(sent => {
    const text = JSON.stringify(sent.message ?? '');
    return text.includes('promotion-result') && text.includes(second.wave_id);
  }), `promotion-result send for wave ${second.wave_id}`);

  // No package-owned refusal may be recorded on either wave.
  for (const record of sorted) {
    const surfaced = [
      ...Object.values(record.effects ?? {}),
      ...Object.values(record.attention ?? {})
    ].map(entry => JSON.stringify(entry ?? ''));
    assert.equal(
      surfaced.some(text => text.includes('package-owned')), false,
      `wave ${record.wave_id} must not surface a package-owned refusal`
    );
    assert.notEqual(record.state, 'blocked', `wave ${record.wave_id} must not be blocked`);
  }

  assert.equal(second.target.base_commit, first.target.candidate_commit,
    "wave 2 must open on wave 1's promoted candidate commit");
  for (const [step, member] of Object.entries(second.members ?? {})) {
    assert.equal(member.base_commit, first.target.candidate_commit,
      `wave 2 member ${step} must be based on wave 1's promoted candidate`);
  }

  for (const [step, member] of Object.entries(first.members ?? {})) {
    assert.ok(member.sealed_head, `wave 1 step ${step} must expose a sealed head`);
    assert.equal(isAncestor(f.repo, member.sealed_head, first.target.candidate_commit), true,
      `wave 1 step ${step} sealed head must be an ancestor of its wave candidate`);
  }

  const finalHead = f.git(['rev-parse', 'HEAD']).trim();
  assert.equal(finalHead, second.target.candidate_commit, "the final repository HEAD must be wave 2's candidate commit");

  const checkpoint = readCheckpointRecord(f.packagePath, WAVE_ID);
  for (const record of sorted) {
    const worker = (checkpoint.workers ?? []).find(candidate => candidate.kind === 'wave' && candidate.id === record.wave_id);
    assert.equal(worker?.state, 'complete', `wave ${record.wave_id} worker must be complete`);
  }

  const inspected = await f.ownership.inspectClaims({ packageId: f.packageRef });
  const packageClaims = (inspected?.claims ?? []).filter(claim => claim.kind === 'package');
  assert.equal(packageClaims.length, 0, 'no package claim may remain after the final wave integrates');

  return { first, second, sorted };
}

test('wave dispatch: restart with a fresh epoch opens the next wave automatically', { timeout: CASE4_TIMEOUT_MS }, async t => {
  const { f, readRecord } = await startHeldTwoWaveRun(t, { session: 'session-restart-auto' });

  await assertTwoWaveProgression(f, readRecord);

  assert.deepEqual(f.entry, { startup: 1, advance: 0, recover: 1, status: 0, cancel: 0 },
    'the automatic restart must open wave 2 without any extra controller entry');
});

test('wave dispatch: restart with a fresh epoch re-enters through startup to open the next wave', { timeout: CASE4_TIMEOUT_MS }, async t => {
  const session = 'session-restart-fresh';
  const gate = { allowNext: false };
  const hostCheck = async ({ readyMembers = 16, explicitCap = null } = {}) => {
    // Suppress ONLY the automatic next-wave continuation (its check sees one
    // ready step) until the fresh coordinator re-enters. The initial wave check
    // and the fresh startup check both see the full ready width and pass.
    if (readyMembers === 1 && !gate.allowNext) {
      return {
        version: 1,
        status: 'setup-required',
        ok: false,
        reason: 'restart-next-wave-held',
        remedy: 'resume the restarted coordinator through startup',
        nativeReady: false,
        softwareCeiling: 16,
        route: 'native',
        fallback: null,
        host: { host_id: 'fixture-host', boot_id: 'fixture-boot', uid: process.getuid?.() ?? 1000 },
        admission: {
          status: 'setup-required', reason: 'restart-next-wave-held',
          remedy: 'resume the restarted coordinator through startup',
          admittedWidth: 0, binding: null, bindings: null, launchable: false, slots: null, free: null
        },
        policy: { admittedWidth: 0, binding: null, softwareCeiling: 16 },
        overlay: { status: 'unavailable', reason: 'fixture-worktree-transport', remedy: null, fallbackEligible: true }
      };
    }
    return readyHost({ readyMembers, explicitCap });
  };

  const { f, replacement, readRecord } = await startHeldTwoWaveRun(t, { hostCheck, session });

  // Wave 1 integrates, the suppressed next-wave intent records setup-required
  // attention, and no successor wave is opened.
  const suppressed = await waitForWithDiagnostics(f, () => {
    const current = readRecord();
    if (current.state !== 'integrated') return false;
    const intent = Object.values(current.effects ?? {})
      .find(effect => effect?.kind === 'next-wave' && effect.outcome === 'setup-required');
    const attention = Object.entries(current.attention ?? {})
      .find(([key]) => key.endsWith(':next-wave:setup-required'));
    return intent && attention ? { intent, attention } : false;
  }, 'wave 1 integrates with the next-wave continuation suppressed');
  assert.equal(suppressed.intent.outcome, 'setup-required', 'the next-wave intent must record setup-required');
  assert.ok(suppressed.attention, 'the suppressed continuation must emit setup-required attention');
  assert.equal(
    readWaveRecords(f.packagePath).filter(entry => (entry.record.ordinal ?? 0) >= 2).length, 0,
    'no successor wave may open while the automatic continuation is suppressed'
  );

  // The fresh coordinator re-enters through startup with full models.
  gate.allowNext = true;
  let freshReceipt;
  try {
    freshReceipt = await replacement.startup({
      package: f.packagePath,
      workflow_id: WAVE_ID,
      execution: 'waves',
      isolation: 'worktree',
      ...MODELS
    }, { session });
  } catch (error) {
    assert.fail(`fresh startup could not open wave 2: ${error?.code ?? error?.name ?? 'error'} ${error?.message ?? ''}`.trim());
  }
  assert.ok(freshReceipt, 'fresh startup must open wave 2');
  assert.notEqual(freshReceipt.state ?? freshReceipt.record?.state, 'needs_reconciliation',
    'a held integrated predecessor must resume, not be refused as needs_reconciliation');
  const successor = readWaveRecords(f.packagePath)
    .map(entry => entry.record)
    .find(record => (record.ordinal ?? 0) === 2);
  assert.ok(successor, 'the fresh restart must open a wave 2 successor record');
  assert.equal(successor.ordinal, 2, 'the resumed successor must be wave ordinal 2');
  assert.notEqual(successor.wave_id, WAVE_ID, 'the successor wave_id must be distinct from wave 1');
  assert.equal(freshReceipt.wave_id, successor.wave_id, 'the startup receipt must name the successor wave');

  await assertTwoWaveProgression(f, readRecord);

  assert.deepEqual(f.entry, { startup: 2, advance: 0, recover: 1, status: 0, cancel: 0 },
    'the fresh restart must open wave 2 through a second startup entry');
});
