// EV-13 native wave proof oracles (step-013-subspec.md).
//
// The native wave cases need two durable facts that earlier ad-hoc selection
// got wrong:
//
// 1. The terminal-state oracle. A test that stamps `Date.now()` after noticing
//    `state === 'integrated'` records its own observation time, not the moment
//    the wave integrated. Production persists the integrated transition and then
//    delivers the final promotion-result attention asynchronously, so the
//    observation can trail the real transition by an unbounded margin. Card 36
//    defines the pre-integration window as "before the RECORD reaches
//    integrated", so the oracle must be the persisted timestamp itself.
//
// 2. The stage-worker selection. A wave's run records include durable
//    `command_phase` records (seal commands and similar bound commands). They
//    are bound to the wave for drain authority, but they are not stage worker
//    launches and must not be counted as implementing/reviewing workers.
//
// Both helpers refuse to invent facts, in the same spirit as the other
// wave-native helpers: a missing, unparseable or non-finite timestamp, or a
// non-array input, is a records defect the cases must surface rather than skip.

// The integrated transition is the last one whose state is 'integrated' — a
// wave can be re-promoted after a repair, and the terminal state is the latest.
function integratedTransition(record, label) {
  if (!record || typeof record !== 'object') {
    throw new Error(`wave oracle: ${label} is not a wave record`);
  }
  const transitions = Array.isArray(record.transitions) ? record.transitions : [];
  const integrated = transitions.filter(entry => entry && entry.state === 'integrated');
  if (integrated.length === 0) {
    throw new Error(`wave oracle: ${label} has no integrated transition`);
  }
  return integrated[integrated.length - 1];
}

// Epoch milliseconds of the wave record's own integrated transition.
export function integratedWaveAt(record) {
  const label = (record && record.wave_id) ? `wave ${record.wave_id}` : 'wave record';
  const transition = integratedTransition(record, label);
  const at = transition.at;
  if (typeof at !== 'string' || at.length === 0) {
    throw new Error(`wave oracle: ${label} integrated transition has no timestamp`);
  }
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) {
    throw new Error(`wave oracle: ${label} integrated transition timestamp is not parseable: ${at}`);
  }
  return ms;
}

// Durable records bound to `waveId` that are stage worker runs. `command_phase`
// is the explicit production discriminator (runtime.mjs writes it on bound
// command records): such a record stays bound for drain authority but is not a
// stage worker launch, so it is excluded here rather than hidden downstream.
export function waveWorkerRuns(records, waveId) {
  if (!Array.isArray(records)) {
    throw new Error('wave oracle: waveWorkerRuns needs an array of run records');
  }
  if (typeof waveId !== 'string' || waveId.length === 0) {
    throw new Error('wave oracle: waveWorkerRuns needs a wave id');
  }
  return records.filter(record => record && typeof record === 'object'
    && record.wave_bindings?.wave_id === waveId
    && !record.command_phase);
}
