// Wave-candidate subject selection (step 10). This module owns the pure
// candidate boundary used by the Runtime's dispatch, review and lease paths:
// given a durable wave record and an input, it resolves the subject a control
// acts on, distinguishing ordinary member selection from an integration
// candidate. Candidate identity comes from `target.repair` (the same contract
// member injection would otherwise fake) and is validated strictly, so a
// staged candidate attempt, capacity key and lease subject all agree on one
// run. Nothing here mutates the wave or touches the controller; the helpers
// stay independent of runtime wiring so locked-child and stage machinery can
// import them directly.

export const CANDIDATE_PHASES = Object.freeze([
  'integration-repair',
  'integration-review',
  'integration-fix',
  'integration-confirm'
]);

function mismatch(message) {
  const error = new Error(message);
  error.code = 'wave-candidate-mismatch';
  return error;
}

function missing(message) {
  const error = new Error(message);
  error.code = 'wave-candidate-missing';
  return error;
}

function workspaceMissing(message) {
  const error = new Error(message);
  error.code = 'wave-candidate-workspace';
  return error;
}

// Resolve the subject of a control for one wave. With no `input.candidate` the
// actual member reference is returned untouched (never a copy or fabricated
// record). With an explicit candidate the request must name a positive integer
// that matches `target.repair` exactly: same candidate number, step, attempt id
// and one of the candidate phases. A supplied `input.attempt_id`/`phase` must
// agree with the repair record so a caller cannot stage a different identity.
export function selectWaveSubject(wave, input = {}) {
  if (input.candidate === undefined) {
    return {
      subject: wave?.members?.[String(input.step_number)],
      candidate: null
    };
  }

  const candidate = input.candidate;
  if (!Number.isInteger(candidate) || candidate <= 0)
    throw mismatch(`candidate ${JSON.stringify(candidate)} is not a positive integer.`);

  const repair = wave?.target?.repair;
  if (!repair)
    throw missing(`wave ${wave?.wave_id} has no target.repair for candidate ${candidate}.`);

  if (repair.n !== candidate)
    throw mismatch(`candidate ${candidate} does not match repair candidate ${repair.n}.`);
  if (repair.step !== input.step_number)
    throw mismatch(`repair step ${repair.step} does not match requested step ${input.step_number}.`);
  if (repair.attempt_id !== `candidate-${candidate}`)
    throw mismatch(`repair attempt ${repair.attempt_id} is not candidate-${candidate}.`);
  if (!CANDIDATE_PHASES.includes(repair.phase))
    throw mismatch(`repair phase ${JSON.stringify(repair.phase)} is not a candidate phase.`);

  if (input.attempt_id !== undefined && input.attempt_id !== repair.attempt_id)
    throw mismatch(`input attempt ${input.attempt_id} does not match repair attempt ${repair.attempt_id}.`);
  if (input.phase !== undefined && input.phase !== repair.phase)
    throw mismatch(`input phase ${input.phase} does not match repair phase ${repair.phase}.`);

  const workspace = wave?.target?.integration?.workspace;
  if (!workspace)
    throw workspaceMissing(`wave ${wave?.wave_id} has no target.integration.workspace for candidate ${candidate}.`);

  return {
    subject: { ...repair, workspace },
    candidate
  };
}

// Capacity key for one phase. A candidate binding keys on the candidate number
// so an integration attempt cannot collide with an ordinary member attempt of
// the same wave.
export function candidateCapacityAttempt(binding, phase) {
  if (binding?.candidate !== undefined && binding?.candidate !== null)
    return `${binding.wave_id}:candidate-${binding.candidate}:${phase}`;
  return `${binding.wave_id}:${binding.attempt_id}:${phase}`;
}

// Resolve the subject a lease may be granted for a candidate binding. The
// selection must yield a candidate and its run id must equal the live run
// exactly; any disagreement refuses with wave-candidate-mismatch.
export function candidateLeaseSubject(wave, binding, runId) {
  if (wave?.wave_id !== binding?.wave_id)
    throw mismatch(`wave ${wave?.wave_id} does not match binding wave ${binding?.wave_id}.`);

  const selected = selectWaveSubject(wave, {
    step_number: binding?.step_number,
    candidate: binding?.candidate,
    attempt_id: binding?.attempt_id,
    phase: binding?.phase
  });

  if (selected.candidate === null || selected.candidate === undefined)
    throw mismatch('candidate lease requires an explicit candidate binding.');

  if (selected.subject.run_id !== runId)
    throw mismatch(`repair run ${selected.subject.run_id} does not match lease run ${runId}.`);

  return selected.subject;
}
