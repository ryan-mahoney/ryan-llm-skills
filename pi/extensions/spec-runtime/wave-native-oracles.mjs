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

// Start index of the D-12 zero-call window for a coordinator request history.
//
// Card step-013-subspec.md line 37 states the window: after the startup call
// returns the coordinator issues zero tool calls, so the window opens at the
// first request that replays the successful startup tool result. A killed idle
// coordinator may leave no request that replays it — its history can end at the
// response that carried the successful startup call, whose later requests never
// happened. For that case the window falls back to the request *after* the one
// whose response carried the startup call (index + 1, which may equal
// requests.length for an empty later window), so a call in the startup request
// itself is excluded and later unexpected calls are exposed.
//
// The order is fixed: the replayed result wins even when a matching response
// call appears earlier in the history. `startupCallIds` accepts both result ids
// and response call ids because the caller gates membership on the successful
// startup event filter; this helper never infers success from a call alone.
// Returns -1 when neither a replayed result nor a matching response call exists.
export function startupWindowStart(requests, startupCallIds, { messagesFor, callsFor }) {
  if (!Array.isArray(requests)) {
    throw new Error('wave oracle: startupWindowStart needs an array of requests');
  }
  if (typeof messagesFor !== 'function' || typeof callsFor !== 'function') {
    throw new Error('wave oracle: startupWindowStart needs message and response-call accessors');
  }
  const ids = startupCallIds instanceof Set ? startupCallIds : new Set(startupCallIds ?? []);
  if (ids.size === 0) return -1;
  const replayedResult = requests.findIndex(request => (messagesFor(request) ?? [])
    .some(message => {
      if (message?.role !== 'tool' && message?.role !== 'tool_result') return false;
      const id = message.tool_call_id ?? message.toolCallId ?? message.call_id;
      return typeof id === 'string' && ids.has(id);
    }));
  if (replayedResult >= 0) return replayedResult;
  const startupCall = requests.findIndex(request => (callsFor(request) ?? [])
    .some(call => {
      if ((call?.function?.name ?? call?.name) !== 'spec_dispatch') return false;
      return typeof call.id === 'string' && ids.has(call.id);
    }));
  if (startupCall >= 0) return startupCall + 1;
  return -1;
}

// Admitted startup receipt predicate (card step-013-subspec.md line 49).
//
// A startup dispatch is admitted when the coordinator's `waveReceipt` proves the
// wave was actually launched or resumed: execution 'waves' plus durable identity
// (wave_id, record_path), generation and admitted width, with no error or code.
// The receipt's state may be 'running' (fresh admission) or 'integrated' (a
// recovered wave that was already integrated when the restart replayed it: the
// D startup returns an already-integrated recovered wave). Every other state is
// not an admitted startup, and the identity/admission/error guards stay
// mandatory for both states. Returns a boolean; it never infers success.
export function isAdmittedWaveStartupReceipt(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.execution !== 'waves') return false;
  if (result.state !== 'running' && result.state !== 'integrated') return false;
  if (typeof result.wave_id !== 'string' || result.wave_id.length === 0) return false;
  if (typeof result.record_path !== 'string' || result.record_path.length === 0) return false;
  if (!Number.isInteger(result.generation) || result.generation < 1) return false;
  if (!Number.isInteger(result.admitted_width) || result.admitted_width <= 0) return false;
  if (result.error || result.code) return false;
  return true;
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
