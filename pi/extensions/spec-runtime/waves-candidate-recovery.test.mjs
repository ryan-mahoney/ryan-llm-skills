// Wave dispatch candidate lost-outcome reconciliation tests (step 10).
//
// Concern-split out of waves-candidate.test.mjs, whose existing cases stay
// unchanged: this file owns only candidate *recovery* at the drive boundary.
// When a candidate owner run's outcome record is lost (crash after effect,
// before outcome record), `drive` must reconcile `implementation_run_id` from
// the durable owner run and then read review state exactly once, without
// re-launching any runtime effect. A redelivered drive must also add no launch.
//
// Every refusal case (mismatched candidate, attempt, wave, non-owner role and a
// missing run) must refuse with `candidate-binding-unknown` while writing no
// `implementation_run_id`, reading no review state and performing no effect.
//
// The fixture binds `createCandidateRepair` to a small in-memory seam at the
// exact journal boundary: `integration.readWaveRecord` / `patchRecord`,
// `loadRun` and `ownership`. No real workers are needed or started. Every case
// title starts with `wave dispatch:` so the card's test-name pattern selects it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCandidateRepair } from './waves-candidate.mjs';

const WAVE_ID = 'wave-010';
const OWNER_RUN_ID = 'owner-1';
const RECORD_PATH = '/fixture/runtime/waves/wave-010.json';
const SESSION = 'coordinator-session';
const CANDIDATE_N = 1;

// A durable wave whose candidate repair was launched but whose outcome record
// was lost: `run_id` names the owner run while `implementation_run_id` is
// absent. The durable owner run carries `stage: null` and no `role` field,
// matching the strict producer (runtime.mjs); nothing is inferred from the id
// spelling.
function makeWave(overrides = {}) {
  return {
    wave_id: WAVE_ID,
    state: 'repairing',
    generation: 4,
    claim_token: 'claim-1',
    package: '/fixture/package',
    package_ref: 'fixture-package',
    coordinator: { session: SESSION, epoch: 2 },
    after: 1,
    target: {
      repair: {
        n: CANDIDATE_N,
        step: 1,
        attempt_id: 'candidate-1',
        phase: 'integration-repair',
        run_id: OWNER_RUN_ID,
        parents: [],
        packet: { trigger: 'composition-conflict', parents: [], failed_gates: [] }
      },
      integration: { workspace: { backend: 'worktree', worktree: '/fixture/candidate' } }
    },
    ...overrides
  };
}

// The durable owner run the candidate launcher bound, with the exact
// wave_bindings the binding validation compares against the repair.
function makeOwnerRun(wave, overrides = {}) {
  const repair = wave.target.repair;
  return {
    id: OWNER_RUN_ID,
    stage: null,
    package: '/fixture/package',
    wave_bindings: {
      wave_id: WAVE_ID,
      step_number: repair.step,
      attempt_id: repair.attempt_id,
      candidate: repair.n,
      phase: repair.phase
    },
    ...overrides
  };
}

// The in-memory seam. `drive` is handed a durable entry; every read/write and
// effect passes through this fixture so each assertion can observe it.
function makeFixture({ wave = makeWave(), run = null, loadRun } = {}) {
  let record = wave;
  let currentRun = run ?? makeOwnerRun(wave);
  const calls = {
    reads: 0,
    patches: 0,
    readReviewState: 0,
    start: 0,
    remount: 0,
    startStage: 0,
    reserve: 0,
    release: 0
  };

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

  const review = {
    async readReviewState() {
      calls.readReviewState += 1;
      return { rounds: [], findings: [] };
    },
    nextReviewAction() {
      return { action: 'wait' };
    },
    stageLabel: () => 'stage'
  };

  const runtime = {
    async start() { calls.start += 1; throw new Error('drive must not start an owner'); },
    async remountWaveMember() { calls.remount += 1; throw new Error('drive must not remount'); },
    async startStage() { calls.startStage += 1; throw new Error('drive must not start a stage'); }
  };
  const ownership = {
    async reserveCapacity() { calls.reserve += 1; throw new Error('drive must not reserve'); },
    async releaseCapacity() { calls.release += 1; throw new Error('drive must not release'); }
  };

  const driver = createCandidateRepair({
    runtime,
    ownership,
    integration,
    review,
    loadRun: loadRun ?? (() => currentRun),
    patchRecord: integration.patchRecord,
    pendingInbox: () => [],
    nowMs: () => 1_700_000_000_000,
    context: () => ({ packageId: 'fixture-package', waveId: WAVE_ID })
  });

  return {
    driver,
    calls,
    entry: { packagePath: '/fixture/package', waveId: WAVE_ID, recordPath: RECORD_PATH, session: SESSION },
    getRecord: () => record,
    setRun: value => { currentRun = value; }
  };
}

const EFFECT_CALLS = ['start', 'remount', 'startStage', 'reserve', 'release'];

function assertNoEffects(calls, label) {
  for (const name of EFFECT_CALLS) {
    assert.equal(calls[name], 0, `${label} must not call runtime/ownership ${name}`);
  }
}

function assertRefused(fixture, label) {
  const outcome = fixture.driver.drive(fixture.entry);
  return Promise.resolve(outcome).then(result => {
    assert.deepEqual(result, { status: 'blocked', reason: 'candidate-binding-unknown' },
      `${label} must refuse with candidate-binding-unknown`);
    assert.equal('implementation_run_id' in (fixture.getRecord().target.repair),
      false, `${label} must not write implementation_run_id`);
    assert.equal(fixture.calls.readReviewState, 0, `${label} must not read review state`);
    assertNoEffects(fixture.calls, label);
    return result;
  });
}

// The lost-outcome case: the durable repair names the owner run (`run_id`) but
// its `implementation_run_id` was never journaled. `drive` reconciles the id
// from the loaded owner run, reads review state exactly once, and performs no
// runtime effect.
test('wave dispatch: drive reconciles a lost candidate outcome from the durable owner run', async () => {
  const wave = makeWave();
  const fixture = makeFixture({ wave });

  const result = await fixture.driver.drive(fixture.entry);

  assert.equal(result.status, 'progressing', 'a bound candidate at wait is still progressing');
  assert.equal(fixture.getRecord().target.repair.implementation_run_id, OWNER_RUN_ID,
    'drive reconciles implementation_run_id from the loaded owner run');
  assert.equal(fixture.calls.readReviewState, 1, 'review state is read exactly once');
  assertNoEffects(fixture.calls, 'lost-outcome reconciliation');
});

// Redelivery of the same event must not launch again: a second drive observes
// the reconciles id and adds no effect.
test('wave dispatch: a redelivered candidate drive adds no launch', async () => {
  const fixture = makeFixture({ wave: makeWave() });

  await fixture.driver.drive(fixture.entry);
  const effectsAfterFirst = { ...fixture.calls };
  await fixture.driver.drive(fixture.entry);

  assert.equal(fixture.getRecord().target.repair.implementation_run_id, OWNER_RUN_ID);
  assertNoEffects(fixture.calls, 'redelivered candidate drive');
  assert.equal(fixture.calls.start, effectsAfterFirst.start);
  assert.equal(fixture.calls.readReviewState, 2, 'the redrive still reads review state only');
});

// The five refusal cases: each binding mismatch/blocks before any effect.
test('wave dispatch: a mismatched candidate is refused', async () => {
  const wave = makeWave();
  wave.target.repair.n = 2;
  const fixture = makeFixture({ wave, run: makeOwnerRun(wave) });
  fixture.setRun({ ...makeOwnerRun(makeWave()), wave_bindings: { ...makeOwnerRun(makeWave()).wave_bindings, candidate: 1 } });

  await assertRefused(fixture, 'a mismatched candidate');
});

test('wave dispatch: a mismatched attempt is refused', async () => {
  const wave = makeWave();
  const fixture = makeFixture({ wave });
  const run = makeOwnerRun(wave);
  fixture.setRun({ ...run, wave_bindings: { ...run.wave_bindings, attempt_id: 'candidate-9' } });

  await assertRefused(fixture, 'a mismatched attempt');
});

test('wave dispatch: a mismatched wave is refused', async () => {
  const wave = makeWave();
  const fixture = makeFixture({ wave });
  const run = makeOwnerRun(wave);
  fixture.setRun({ ...run, wave_bindings: { ...run.wave_bindings, wave_id: 'wave-999' } });

  await assertRefused(fixture, 'a mismatched wave');
});

test('wave dispatch: a non-owner run role is refused', async () => {
  const wave = makeWave();
  const fixture = makeFixture({ wave });
  fixture.setRun({ ...makeOwnerRun(wave), role: 'reviewer', stage: { role: 'reviewer' } });

  await assertRefused(fixture, 'a non-owner role');
});

test('wave dispatch: a missing owner run is refused', async () => {
  const wave = makeWave();
  const fixture = makeFixture({ wave, loadRun: () => null });

  await assertRefused(fixture, 'a missing run');
});
