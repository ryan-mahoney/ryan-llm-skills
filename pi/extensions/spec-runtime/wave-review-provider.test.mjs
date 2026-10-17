// F2 regression: a review/fix stage launch must carry the implementation run's
// provider extensions so the native child loads the same providers the
// implementation ran with. The assertion reads the actual `this.start` argument
// produced by the production `startStage` in wave-review-runtime.mjs rather than
// recreating the propagation rule in the test.
//
// Synthetic proof only: this is a unit-level seam check (kernel_proof=false); it
// spawns no Runtime worker and makes no systemd/Linux launch claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createWaveReviewRuntime } from './wave-review-runtime.mjs';

const WAVE_ID = 'w1';
const STEP = 1;
const ATTEMPT = 'attempt-1';
const IMPLEMENTATION_RUN_ID = 'run-implementation-1';
const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const LABEL = 'wave-w1-step-001-review-1';
const OWNER_MODEL = 'fixture-provider/team/owner';
const REVIEW_MODEL = 'fixture-provider/team/reviewer:high';
const PROVIDER_A = '/opt/providers/first-provider.ts';
const PROVIDER_B = '/opt/providers/second-provider.ts';

// The wave record is read by startStage only to learn the subject run_id. A null
// member run_id means the step's implementation phase already drained positively.
const WAVE = {
  wave_id: WAVE_ID,
  members: { [String(STEP)]: { step_number: STEP, attempt_id: ATTEMPT, run_id: null } }
};

// The implementation run supplies provenance, the inherited owner model for a
// fixer and the child_extensions list the stage must inherit.
function implementationRun() {
  return {
    run_id: IMPLEMENTATION_RUN_ID,
    assignment_id: null,
    phase_drain: { status: 'confirmed' },
    owner_model: OWNER_MODEL,
    editor_model: OWNER_MODEL,
    child_extensions: [PROVIDER_A, PROVIDER_B]
  };
}

// Build the runtime with inert seams and a receiver whose start captures and
// returns its argument, so the test observes the exact object runtime.start
// would receive.
function makeRuntime({ implementation = implementationRun(), capture }) {
  const runtime = createWaveReviewRuntime({
    nativeCommand: () => { throw new Error('nativeCommand must not run'); },
    streamTask: () => { throw new Error('streamTask must not run'); },
    save: () => { throw new Error('save must not run'); },
    read: () => WAVE,
    runFileOf: () => { throw new Error('runFileOf must not run'); },
    assertWaveLease: () => { throw new Error('assertWaveLease must not run'); },
    loadRun: (_package, id) => {
      if (id !== IMPLEMENTATION_RUN_ID) throw new Error(`unexpected run lookup ${id}`);
      return implementation;
    },
    runCommand: () => { throw new Error('runCommand must not run'); },
    readOwnershipClaimsSync: () => [],
    waveInvalid: (code, message, remedy) => Object.assign(new Error(message), { code, remedy }),
    timestamp: () => '2026-01-01T00:00:00.000Z',
    runLockedMutation: () => { throw new Error('runLockedMutation must not run'); },
    waveClaimToken: () => { throw new Error('waveClaimToken must not run'); }
  });
  const receiver = {
    async start(input) { capture(input); return { run_id: 'run-stage-1', assignment_id: input.assignment_id }; }
  };
  return { runtime, receiver };
}

// Minimal valid stage input: canonical label, step-scoped identity, round 1.
function stageInput(over = {}) {
  return {
    package: '/tmp/wave-review-provider-package',
    wave_id: WAVE_ID,
    step_number: STEP,
    attempt_id: ATTEMPT,
    stage_attempt: 1,
    implementation_run_id: IMPLEMENTATION_RUN_ID,
    phase: 'reviewing',
    step: join('/tmp/wave-review-provider-package', 'step-001-subspec.md'),
    review_model: REVIEW_MODEL,
    stage: { round: 1, label: LABEL, base: BASE, head: HEAD },
    ...over
  };
}

test('wave review provider: reviewing stage inherits implementation child_extensions without caller override', async () => {
  let captured = null;
  const { runtime, receiver } = makeRuntime({ capture: input => { captured = input; } });
  const input = stageInput();
  assert.equal(input.child_extensions, undefined,
    'the caller supplied no child_extensions for this launch');
  await runtime.startStage.call(receiver, input);
  assert.ok(captured, 'the production startStage calls this.start with the launch input');
  assert.deepEqual(captured.child_extensions, [PROVIDER_A, PROVIDER_B],
    'the stage launch carries the implementation provider extension list');
  assert.equal(captured.owner_model, REVIEW_MODEL, 'the reviewer model binds as owner_model');
  assert.equal(captured.review_model, REVIEW_MODEL, 'the reviewer model binds as review_model');
  assert.equal(captured.fix_model, null, 'a reviewing stage has no fix model');
  assert.equal(captured.editor_model, OWNER_MODEL, 'the implementation editor model is inherited');
  assert.equal(captured.assignment_id, `wave:${WAVE_ID}/step:001/phase:reviewing/attempt:1`,
    'the canonical assignment identity is unchanged');
  assert.equal(captured.stage.label, LABEL, 'the canonical stage label is preserved');
});

test('wave review provider: fixing stage inherits implementation child_extensions without caller override', async () => {
  let captured = null;
  const { runtime, receiver } = makeRuntime({ capture: input => { captured = input; } });
  await runtime.startStage.call(receiver, stageInput({ phase: 'fixing', review_model: undefined }));
  assert.ok(captured, 'the production startStage calls this.start with the launch input');
  assert.deepEqual(captured.child_extensions ?? [], [PROVIDER_A, PROVIDER_B],
    'the fixing stage launch carries the implementation provider extension list');
  assert.equal(captured.owner_model, OWNER_MODEL, 'the fixer inherits the implementation owner model');
  assert.equal(captured.fix_model, OWNER_MODEL, 'the fixer model binds as fix_model');
  assert.equal(captured.review_model, null, 'a fixing stage has no review model');
  assert.equal(captured.editor_model, OWNER_MODEL, 'the implementation editor model is inherited');
});

test('wave review provider: an explicit caller child_extensions list is honored', async () => {
  const explicit = ['/opt/providers/caller-only.ts'];
  let captured = null;
  const { runtime, receiver } = makeRuntime({ capture: input => { captured = input; } });
  await runtime.startStage.call(receiver, stageInput({ child_extensions: explicit }));
  assert.ok(captured, 'the production startStage calls this.start with the launch input');
  assert.deepEqual(captured.child_extensions, explicit,
    'an explicit caller list is not replaced by the implementation list');
});
