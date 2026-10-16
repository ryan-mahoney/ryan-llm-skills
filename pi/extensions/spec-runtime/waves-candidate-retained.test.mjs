// Wave dispatch candidate retained-recovery tests (step 10).
//
// Concern-split out of waves-candidate-recovery.test.mjs: this file owns only
// the *retained* candidate-recovery path. After a fresh coordinator observes a
// candidate repair whose durable repair phase was interrupted, recovery must
// positively drain the retained run behind a classification, remount the
// retained workspace, reserve capacity and launch exactly one replacement
// (the owner implementation phase through `start`, every stage phase through
// `startStage`). Unknown or live classifications block with no effect.
//
// Every case title starts with `wave dispatch:` so the card's test-name
// pattern selects it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCandidateRetainedRecovery } from './waves-candidate-retained.mjs';

const WAVE_ID = 'wave-010';
const OWNER_RUN_ID = 'owner-1';
const RECORD_PATH = '/fixture/runtime/waves/wave-010.json';
const SESSION = 'replacement-coordinator-session';
const CANDIDATE_N = 1;
const PHASES = ['integration-repair', 'integration-review', 'integration-fix', 'integration-confirm'];
const STAGE_PHASES = ['integration-review', 'integration-fix', 'integration-confirm'];
const WORKSPACE = 'worktree:/fixture/candidate';

// A durable wave whose candidate repair was launched but interrupted before its
// outcome was recorded. The durable repair binds the original owner run
// (`run_id: 'old'`) and its implementation run (`implementation_run_id`), and
// retains the integration workspace as a real string marker (no mount).
function makeWave(overrides = {}) {
  return {
    wave_id: WAVE_ID,
    state: 'repairing',
    generation: 7,
    claim_token: 'claim-1',
    package: '/fixture/package',
    package_ref: 'fixture-package',
    coordinator: { session: SESSION, epoch: 3 },
    after: 1,
    deadline: { expires_at: 1_800_000_000_000 },
    models: { owner_model: 'owner-model', editor_model: 'editor-model' },
    target: {
      candidate_commit: 'candidate-head-1',
      repair: {
        n: CANDIDATE_N,
        step: 1,
        attempt_id: 'candidate-1',
        phase: 'integration-repair',
        run_id: 'old',
        implementation_run_id: 'owner',
        resume: 1,
        stage_attempt: 1,
        parents: []
      },
      integration: { workspace: WORKSPACE }
    },
    ...overrides
  };
}

// A single retained member for the candidate step carrying the exact
// implementation identity recovery must preserve byte-for-byte.
function makeMember(overrides = {}) {
  return {
    attempt_id: 'candidate-1',
    phase: 'blocked',
    blocking_reason: 'liveness-unknown',
    run_id: 'old',
    implementation_run_id: 'owner',
    resume: 1,
    stage_attempt: 1,
    workspace: WORKSPACE,
    ...overrides
  };
}

function makeWaveWithMember(memberOverrides = {}, waveOverrides = {}) {
  const wave = makeWave({ members: { 1: makeMember(memberOverrides) }, ...waveOverrides });
  // The phase-loop cases intend the candidate phase itself (target.repair.phase),
  // not just the member's phase, so carry the override into the repair binding.
  if (memberOverrides.phase !== undefined) {
    wave.target.repair.phase = memberOverrides.phase;
  }
  return wave;
}

// The durable owner run: exact wave_bindings (all identity fields including
// candidate) for the non-stage phase, plus stage metadata for stage phases so
// the stage binding validation accepts it.
function makeOwnerRun(wave, phase, overrides = {}) {
  const repair = wave.target.repair;
  const stage = phase === 'integration-repair' ? null : { label: `wave-${WAVE_ID}-step-001-${phase}`, round: 1 };
  return {
    id: 'old',
    stage,
    package: '/fixture/package',
    wave_bindings: {
      wave_id: WAVE_ID,
      step_number: repair.step,
      attempt_id: repair.attempt_id,
      candidate: repair.n,
      phase,
      generation: wave.generation,
      claim_token: wave.claim_token,
      coordinator_epoch: wave.coordinator?.epoch,
      package_ref: 'fixture-package'
    },
    ...overrides
  };
}

// The in-memory seam. Every read/write and every effect passes through this
// fixture so each assertion can observe it. A confirmed drain writes a real
// receipt file named by `phase_drain.path`.
function makeFixture({ wave = makeWaveWithMember(), run = null, classification = { status: 'confirmed' }, confirmOnCancel = true, deps = {} } = {}) {
  let record = wave;
  let currentRun = run ?? makeOwnerRun(wave, 'integration-repair');
  const receiptDir = mkdtempSync(join(tmpdir(), 'waves-candidate-retained-'));
  const receiptPath = join(receiptDir, 'drain-receipt.json');
  const calls = {
    reads: 0,
    patches: 0,
    inspect: 0,
    cancel: 0,
    remount: 0,
    reserve: 0,
    release: 0,
    start: 0,
    startStage: 0
  };
  const launches = [];

  function writeConfirmedReceipt() {
    writeFileSync(receiptPath, JSON.stringify({ status: 'confirmed' }));
    return receiptPath;
  }

  const integration = {
    readWaveRecord(path) {
      assert.equal(path, RECORD_PATH);
      calls.reads += 1;
      return JSON.parse(JSON.stringify(record));
    },
    patchRecord(path, session, mutator) {
      assert.equal(path, RECORD_PATH);
      assert.equal(session, SESSION);
      calls.patches += 1;
      const draft = JSON.parse(JSON.stringify(record));
      mutator(draft);
      record = draft;
      return record;
    }
  };

  const runtime = {
    get active() {
      return {
        get: id => (id === currentRun?.id ? { record: currentRun } : null),
        size: currentRun?.id ? 1 : 0
      };
    },
    async start(input) {
      calls.start += 1;
      launches.push({ kind: 'start', input });
      const newId = 'owner-2';
      currentRun = {
        ...makeOwnerRun(record, 'integration-repair'),
        id: newId,
        wave_bindings: { ...makeOwnerRun(record, 'integration-repair').wave_bindings }
      };
      // A real start updates the durable repair run_id and returns the new id.
      integration.patchRecord(RECORD_PATH, SESSION, draft => {
        if (draft.target?.repair) draft.target.repair = { ...draft.target.repair, run_id: newId };
      });
      return { run_id: newId };
    },
    async startStage(input) {
      calls.startStage += 1;
      launches.push({ kind: 'startStage', input });
      const newId = 'stage-2';
      currentRun = {
        ...makeOwnerRun(record, input.phase),
        id: newId,
        wave_bindings: { ...makeOwnerRun(record, input.phase).wave_bindings }
      };
      // A real startStage binds the new stage run and returns its id.
      integration.patchRecord(RECORD_PATH, SESSION, draft => {
        if (draft.target?.repair) draft.target.repair = { ...draft.target.repair, run_id: newId };
      });
      return { run_id: newId };
    },
    async remountWaveMember(input) {
      calls.remount += 1;
      launches.push({ kind: 'remount', input });
      return { status: 'remounted' };
    },
    async cancel(packageDir, runId) {
      calls.cancel += 1;
      launches.push({ kind: 'cancel', packageDir, runId });
      // Real cancellation writes a confirmed drain onto the reloaded run. A
      // case that exercises an unconfirmed drain disables this receipt.
      if (confirmOnCancel) {
        const path = writeConfirmedReceipt();
        const base = currentRun ?? makeOwnerRun(record, 'integration-repair');
        currentRun = { ...base, phase_drain: { status: 'confirmed', path } };
      }
      return { status: 'cancelled' };
    },
    async drainContainedService(run) {
      return { status: 'confirmed', path: writeConfirmedReceipt() };
    }
  };

  const ownership = {
    async reserveCapacity(input) {
      calls.reserve += 1;
      launches.push({ kind: 'reserve', input });
      return { status: 'reserved' };
    },
    async releaseCapacity(input) {
      calls.release += 1;
      launches.push({ kind: 'release', input });
      return { status: 'released' };
    }
  };

  const lifecycle = {
    async inspect(run, opts) {
      calls.inspect += 1;
      return classification;
    }
  };

  // `deps` overrides the exact seam a negative case exercises (for example a
  // denying `ownership.reserveCapacity` or a `durableConfirmedDrain` that
  // reports the real absence of a confirmed receipt).
  const recoverer = createCandidateRetainedRecovery({
    runtime,
    ownership,
    lifecycle,
    loadRun: () => currentRun,
    patchRecord: integration.patchRecord,
    durableConfirmedDrain: run => {
      const drain = run?.phase_drain;
      if (!drain || drain.status !== 'confirmed' || typeof drain.path !== 'string') return false;
      try {
        return JSON.parse(readFileSync(drain.path, 'utf8'))?.status === 'confirmed';
      } catch {
        return false;
      }
    },
    nowMs: () => 1_700_000_000_000,
    ...deps
  });

  return {
    recoverer,
    calls,
    launches,
    integration,
    receiptPath,
    entry: { packagePath: '/fixture/package', recordPath: RECORD_PATH, waveId: WAVE_ID, session: SESSION, openContext: { index: { steps: [{ step: 1, path: 'step-001-subspec.md' }] } } },
    own: { session: SESSION, epoch: 3 },
    getRecord: () => record,
    setRecord: value => { record = value; },
    setRun: value => { currentRun = value; },
    cleanup: () => rmSync(receiptDir, { recursive: true, force: true })
  };
}

const EFFECT_CALLS = ['cancel', 'remount', 'reserve', 'release', 'start', 'startStage'];

function assertNoEffects(calls, label) {
  for (const name of EFFECT_CALLS) {
    assert.equal(calls[name], 0, `${label} must not call runtime/ownership ${name}`);
  }
}

// Unknown and live classifications block for every phase, preserve the retained
// facts byte-for-byte, and never cancel, remount, reserve or launch.
for (const phase of PHASES) {
  for (const status of ['unknown', 'live']) {
    test(`wave dispatch: candidate retained recovery blocks ${phase} on a ${status} classification`, async t => {
      const member = makeMember({ phase });
      const wave = makeWaveWithMember({ phase });
      const fixture = makeFixture({ wave, run: makeOwnerRun(wave, phase), classification: { status } });
      t.after(() => fixture.cleanup());
      const before = JSON.parse(JSON.stringify(fixture.getRecord()));

      const result = await fixture.recoverer.resume(fixture.entry, fixture.getRecord(), fixture.own);

      assert.equal(result.status, 'blocked', `${phase}/${status} must block`);
      const record = fixture.getRecord();
      assert.equal(record.target.repair.recovery_blocking_reason,
        status === 'live' ? 'liveness-live' : 'liveness-unknown',
        `${phase}/${status} records the liveness block reason`);
      assert.equal(record.target.repair.phase, before.target.repair.phase);
      assert.equal(record.target.repair.run_id, before.target.repair.run_id);
      assert.equal(record.target.repair.implementation_run_id, before.target.repair.implementation_run_id);
      assert.equal(record.target.integration.workspace, before.target.integration.workspace);
      assert.equal(record.deadline.expires_at, before.deadline.expires_at);
      assert.equal(record.generation, before.generation);
      assert.deepEqual(record.members['1'], before.members['1'],
        `${phase}/${status} preserves the retained member bytes`);
      assertNoEffects(fixture.calls, `${phase}/${status}`);
    });
  }
}

// Positive classification: the retained run is drained, remounted, capacity is
// reserved and exactly one appropriate replacement is launched (owner `start`
// for the implementation phase, `startStage` for every stage phase). The new
// identity carries the candidate-1 exact bindings plus resume1.
for (const phase of PHASES) {
  test(`wave dispatch: candidate retained recovery relaunches ${phase} once after a positive drain`, async t => {
    const wave = makeWaveWithMember({ phase });
    const fixture = makeFixture({ wave, run: makeOwnerRun(wave, phase), classification: { status: 'populated' } });
    t.after(() => fixture.cleanup());
    const before = JSON.parse(JSON.stringify(fixture.getRecord()));

    const result = await fixture.recoverer.resume(fixture.entry, fixture.getRecord(), fixture.own);

    assert.equal(result.status, 'resumed', `${phase} resumes after a positive drain`);
    assert.equal(fixture.calls.cancel, 1, `${phase} cancels the owned active run`);
    assert.equal(fixture.calls.remount, 1, `${phase} remounts the retained workspace`);
    assert.equal(fixture.calls.reserve, 1, `${phase} reserves capacity`);
    const isStage = STAGE_PHASES.includes(phase);
    assert.equal(fixture.calls.start, isStage ? 0 : 1, `${phase} owner launch count`);
    assert.equal(fixture.calls.startStage, isStage ? 1 : 0, `${phase} stage launch count`);

    const launch = fixture.launches.find(item => item.kind === (isStage ? 'startStage' : 'start'));
    const input = launch.input;
    assert.equal(input.candidate, CANDIDATE_N, `${phase} carries candidate-1`);
    assert.equal(input.phase, phase, `${phase} carries the exact phase`);
    assert.equal(input.attempt_id, 'candidate-1', `${phase} carries the exact attempt`);
    assert.equal(input.expected_generation, before.generation, `${phase} carries the generation`);
    assert.equal(input.claim_token, before.claim_token, `${phase} carries the claim token`);
    assert.equal(input.coordinator_epoch, before.coordinator.epoch, `${phase} carries the coordinator epoch`);
    assert.equal(input.resume, before.members['1'].resume + 1, `${phase} carries resume1`);
    assert.equal(fixture.getRecord().target.repair.resume, before.target.repair.resume + 1,
      `${phase} increments the persisted repair resume`);

    assert.deepEqual(fixture.launches.map(item => item.kind).slice(0, 4), ['cancel', 'remount', 'reserve', isStage ? 'startStage' : 'start'],
      `${phase} applies cancel -> remount -> reserve -> launch order`);

    const stageLaunch = fixture.launches.find(item => item.kind === 'startStage' && item.input?.phase === phase);
    if (isStage) {
      assert.equal(stageLaunch.input.stage?.label, `wave-${WAVE_ID}-step-001-${phase}`,
        `${phase} launches the retained stage label`);
      assert.equal(stageLaunch.input.stage?.round, 1, `${phase} launches the retained stage round`);
    }

    const record = fixture.getRecord();
    assert.equal(record.target.repair.run_id, isStage ? 'stage-2' : 'owner-2',
      `${phase} records the new durable repair run id`);
    assert.equal(record.target.repair.recovery_blocking_reason ?? null, null, `${phase} clears any block reason`);
    if (!isStage) {
      assert.equal(record.target.repair.implementation_run_id, 'owner-2',
        'only the owner implementation id is updated to the new run id');
    } else {
      assert.equal(record.target.repair.implementation_run_id, before.target.repair.implementation_run_id,
        `${phase} leaves the implementation id unchanged`);
    }
    assert.equal(record.target.integration.workspace, before.target.integration.workspace);
    assert.equal(record.deadline.expires_at, before.deadline.expires_at);
    assert.equal(record.generation, before.generation);
    assert.deepEqual(record.members['1'].workspace, before.members['1'].workspace);
  });
}

// A completed, drain-confirmed replacement is retained: a repeated resume of the
// same recorded replacement in the same call fixture must not relaunch.
test('wave dispatch: a retained completed replacement is not relaunched', async t => {
  const phase = 'integration-repair';
  const wave = makeWaveWithMember({ phase });
  const fixture = makeFixture({ wave, run: makeOwnerRun(wave, phase), classification: { status: 'populated' } });
  t.after(() => fixture.cleanup());

  const first = await fixture.recoverer.resume(fixture.entry, fixture.getRecord(), fixture.own);
  assert.equal(first.status, 'resumed');
  const effectsAfterFirst = { ...fixture.calls };
  const launchesAfterFirst = fixture.launches.length;

  // The replacement run completed with a confirmed drain; a completed run
  // skips so a repeated resume of the same recorded replacement is a no-op.
  const record = fixture.getRecord();
  fixture.setRun({
    ...makeOwnerRun(record, phase),
    id: record.target.repair.run_id,
    state: 'completed',
    phase_drain: { status: 'confirmed', path: fixture.receiptPath }
  });

  const second = await fixture.recoverer.resume(fixture.entry, fixture.getRecord(), fixture.own);

  assert.equal(second.status, 'skipped', 'a completed retained replacement is skipped');
  assert.equal(fixture.calls.start, effectsAfterFirst.start, 'the repeated resume adds no owner launch');
  assert.equal(fixture.calls.startStage, effectsAfterFirst.startStage, 'the repeated resume adds no stage launch');
  assert.equal(fixture.launches.length, launchesAfterFirst, 'the repeated resume adds no effect');
});

// A binding mismatch blocks `stage-binding-invalid` before any inspection or
// effect.
test('wave dispatch: candidate retained recovery blocks a stage-binding-invalid binding', async t => {
  const phase = 'integration-review';
  const wave = makeWaveWithMember({ phase });
  const fixture = makeFixture({ wave, run: makeOwnerRun(wave, phase) });
  t.after(() => fixture.cleanup());
  const run = makeOwnerRun(wave, phase);
  fixture.setRun({ ...run, wave_bindings: { ...run.wave_bindings, attempt_id: 'candidate-9' } });

  const result = await fixture.recoverer.resume(fixture.entry, fixture.getRecord(), fixture.own);

  assert.equal(result.status, 'blocked');
  assert.equal(fixture.getRecord().target.repair.recovery_blocking_reason, 'stage-binding-invalid');
  assert.equal(fixture.calls.inspect, 0, 'an invalid binding is refused before inspection');
  assertNoEffects(fixture.calls, 'stage-binding-invalid');
});

// A missing durable drain after cancellation blocks `drain-unconfirmed` before
// any remount. Cancellation here writes no confirmed receipt and the durable
// run carries no confirmed `phase_drain`, so the drain is positively absent.
test('wave dispatch: candidate retained recovery blocks when the drain is unconfirmed', async t => {
  const phase = 'integration-repair';
  const wave = makeWaveWithMember({ phase });
  const fixture = makeFixture({
    wave,
    run: makeOwnerRun(wave, phase),
    classification: { status: 'populated' },
    confirmOnCancel: false,
    deps: { durableConfirmedDrain: () => false }
  });
  t.after(() => fixture.cleanup());

  const result = await fixture.recoverer.resume(fixture.entry, fixture.getRecord(), fixture.own);

  assert.equal(result.status, 'blocked');
  assert.equal(fixture.getRecord().target.repair.recovery_blocking_reason, 'drain-unconfirmed');
  assert.equal(fixture.calls.remount, 0, 'an unconfirmed drain blocks before remount');
  assert.equal(fixture.calls.start, 0);
  assert.equal(fixture.calls.startStage, 0);
});

// A capacity denial blocks without launching.
test('wave dispatch: candidate retained recovery blocks on a capacity denial', async t => {
  const phase = 'integration-repair';
  const wave = makeWaveWithMember({ phase });
  let fixture;
  fixture = makeFixture({
    wave,
    run: makeOwnerRun(wave, phase),
    classification: { status: 'populated' },
    // A denying ownership seam queues the phase slot; recovery must block
    // without launching.
    deps: { ownership: { reserveCapacity: async input => {
      fixture.calls.reserve += 1;
      fixture.launches.push({ kind: 'reserve', input });
      return { status: 'queued', constraint: { reason: 'capacity-unavailable' } };
    } } }
  });
  t.after(() => fixture.cleanup());

  const result = await fixture.recoverer.resume(fixture.entry, fixture.getRecord(), fixture.own);

  assert.equal(result.status, 'blocked');
  assert.equal(fixture.getRecord().target.repair.recovery_blocking_reason, 'capacity-unavailable');
  assert.equal(fixture.calls.reserve, 1, 'the capacity slot was attempted');
  assert.equal(fixture.calls.start, 0, 'a capacity denial never launches an owner');
  assert.equal(fixture.calls.startStage, 0, 'a capacity denial never launches a stage');
});
