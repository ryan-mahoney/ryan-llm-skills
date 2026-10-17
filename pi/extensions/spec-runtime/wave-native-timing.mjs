// EV-13 native wave elapsed timing (step-013-subspec.md case 6).
//
// The chain/flat metrics diagnostic needs real elapsed milliseconds, and the
// only durable source is the wave record's transitions (waves.mjs writes an
// `open` transition at admission and an `integrated` transition at promotion).
// There is no `opened_at` field on a durable wave record, so a timing helper
// that reads one silently yields null and reports nothing.
//
// Both helpers refuse to filter or invent fields, in the same spirit as the
// other wave-native helpers: a missing, unparseable, non-finite or inverted
// timestamp is a records defect the cases must surface rather than skip.
function transitionAt(record, state, label) {
  if (!record || typeof record !== 'object') {
    throw new Error(`wave timing: ${label} is not a wave record`);
  }
  const transitions = Array.isArray(record.transitions) ? record.transitions : [];
  const transition = transitions.find(entry => entry && entry.state === state);
  if (!transition) {
    throw new Error(`wave timing: ${label} has no ${state} transition`);
  }
  const at = transition.at;
  if (typeof at !== 'string' || at.length === 0) {
    throw new Error(`wave timing: ${label} ${state} transition has no timestamp`);
  }
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) {
    throw new Error(`wave timing: ${label} ${state} transition timestamp is not parseable: ${at}`);
  }
  return ms;
}

// Elapsed milliseconds of one wave: integrated transition minus open transition.
export function elapsedWaveMs(record) {
  const label = (record && record.wave_id) ? `wave ${record.wave_id}` : 'wave record';
  const open = transitionAt(record, 'open', label);
  const integrated = transitionAt(record, 'integrated', label);
  if (integrated < open) {
    throw new Error(`wave timing: ${label} integrated transition precedes its open transition`);
  }
  return integrated - open;
}

// Elapsed milliseconds of a wave set: earliest open to latest integrated, with
// every member validated so one broken record cannot be hidden by the extremes.
export function elapsedWaveSetMs(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('wave timing: a wave set needs at least one record');
  }
  const spans = records.map(record => {
    const label = (record && record.wave_id) ? `wave ${record.wave_id}` : 'wave record';
    const open = transitionAt(record, 'open', label);
    const integrated = transitionAt(record, 'integrated', label);
    if (integrated < open) {
      throw new Error(`wave timing: ${label} integrated transition precedes its open transition`);
    }
    return { open, integrated };
  });
  const firstOpen = Math.min(...spans.map(span => span.open));
  const lastIntegrated = Math.max(...spans.map(span => span.integrated));
  return lastIntegrated - firstOpen;
}
