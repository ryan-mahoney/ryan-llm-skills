// Durable wave receipt projection (step 10). `waveReceipt` is the one shared
// projection of a durable wave record into the public receipt shape: the
// canonical identity fields, the bounded member preview (F10-5) and the single
// `next_action` string. It is a pure read of the record and the record path the
// caller already resolved, so a replay returns exactly what a first open
// returned. Recovery, repair and status all import this one projection rather
// than building a caller-side shape.

const MEMBER_PREVIEW_CAP = 16;

// Preview group priority: blocked first, then active (any non-queued and
// non-sealed phase), then queued, then sealed. Numeric step is the tie break
// inside and across each group so insertion order never leaks.
function previewGroup(phase) {
  if (phase === 'blocked') return 0;
  if (phase === 'queued') return 2;
  if (phase === 'sealed') return 3;
  return 1;
}

function numericStep(step, key) {
  const value = Number(step);
  return Number.isFinite(value) ? value : Number(key);
}

// Project one durable member into the public K member shape. Only the fields K
// exposes cross this boundary: the internal durable member fields (`workspace`,
// `transitions`, `claim_token` and everything else) are never copied.
function memberProjection(member, step) {
  const workspace = member?.workspace ?? {};
  const phase = member?.phase ?? null;
  return {
    step: numericStep(step, step),
    phase,
    run_id: member?.run_id ?? member?.implementation_run_id ?? null,
    checkout: workspace.merged ?? workspace.worktree ?? null,
    base_commit: member?.base_commit ?? workspace.baseCommit ?? null,
    sealed_head: member?.sealed_head ?? null,
    review_artifacts: Array.isArray(member?.review_artifacts) ? member.review_artifacts : [],
    blocking_reason: member?.blocking_reason ?? null,
    backend: workspace.backend ?? null,
    fallback_reason: workspace.backendReason ?? null,
    snapshot_id: workspace.snapshotId ?? null,
    upper_id: workspace.retained?.upperId ?? null,
    active_phase: member?.active_phase ?? phase,
    git_dir: workspace.gitDir ?? null
  };
}

// Order the durable members into the bounded preview. The full member set is
// read from the record's durable `members`; a member key and its `step` field
// are both accepted so a hand-built or a real record orders identically.
function memberPreview(record) {
  const entries = Object.entries(record?.members ?? {}).map(([key, member]) => ({
    key,
    step: numericStep(member?.step, key),
    member
  }));
  entries.sort((left, right) => {
    const group = previewGroup(left.member?.phase) - previewGroup(right.member?.phase);
    if (group !== 0) return group;
    return left.step - right.step;
  });
  return entries.slice(0, MEMBER_PREVIEW_CAP).map(entry => memberProjection(entry.member, entry.key));
}

// The first blocked member in the durable set, which is the one an actionable
// repair instruction names. The durable member keeps its transition history but
// only its reason crosses into the next action.
function firstBlocked(record) {
  const blocked = Object.entries(record?.members ?? {})
    .filter(([, member]) => member?.phase === 'blocked')
    .map(([key, member]) => ({ key, step: numericStep(member?.step, key), member }));
  blocked.sort((left, right) => left.step - right.step);
  return blocked[0] ?? null;
}

// A single actionable string per durable wave state. Every branch names the
// package and wave id and, where one exists, the concrete control entry to run;
// no branch advises polling or a blind restart.
function nextAction(record, recordPath) {
  const waveId = record?.wave_id ?? null;
  const state = record?.state ?? null;

  if (state === 'blocked' || state === 'repairing') {
    const blocked = firstBlocked(record);
    const step = blocked?.step ?? blocked?.key ?? null;
    const reason = blocked?.member?.blocking_reason ?? record?.blocking_reason ?? null;
    if (reason === 'confirmation-failed' && step !== null) {
      const repair = 'spec_dispatch advance step=' + step + ' attempt_kind=review-repair';
      return 'blocked ' + reason + ': repair with ' + repair
        + ' instructions=<repair> (package ' + (record?.package ?? '') + ', wave ' + waveId + ')';
    }
    if (reason === 'undeclared-write' && step !== null) {
      return 'blocked ' + reason + ': record adaptations with spec_dispatch advance step=' + step
        + ' adaptations=[...] (package ' + (record?.package ?? '') + ', wave ' + waveId + ')';
    }
    return 'blocked (' + (reason ?? 'unknown') + '): diagnose the blocking reason and ' + recordPath
      + ', then recover or advance step=' + (step ?? '<n>')
      + ' (package ' + (record?.package ?? '') + ', wave ' + waveId + ')';
  }

  if (state === 'open' || state === 'running')
    return 'running: await native wave events; do not poll (package ' + (record?.package ?? '')
      + ', wave ' + waveId + ')';

  if (state === 'ready-to-integrate' || state === 'integrating' || state === 'verifying' || state === 'promoting')
    return state + ': advance or recover to continue integration without a blind restart (package '
      + (record?.package ?? '') + ', wave ' + waveId + ')';

  if (state === 'integrated')
    return 'integrated: start the next wave or report status; retained evidence is complete (package '
      + (record?.package ?? '') + ', wave ' + waveId + ')';

  if (state === 'cancelled')
    return 'cancelled: report status; retained evidence is kept and is not replayed (package '
      + (record?.package ?? '') + ', wave ' + waveId + ')';

  return 'inspect ' + recordPath + ' and report status (package ' + (record?.package ?? '')
    + ', wave ' + waveId + ')';
}

// Wave receipts are projections of the durable record, so a replay returns the
// same fields a first open returned. `extra` retains caller context (for
// example `loaded: true`) and legacy override behavior; it is applied last so
// existing fields stay overridable.
export function waveReceipt(record, recordPath, extra = {}) {
  const preview = memberPreview(record);
  const memberCount = Object.keys(record?.members ?? {}).length;
  return {
    execution: 'waves',
    state: record.state,
    wave_id: record.wave_id,
    record_path: recordPath,
    generation: record.generation,
    requested_width: record.requested_width,
    admitted_width: record.admitted_width,
    software_ceiling: record.software_ceiling,
    effective_limits: record.effective_limits,
    member_count: memberCount,
    omitted_count: Math.max(0, memberCount - preview.length),
    members: preview,
    next_action: nextAction(record, recordPath),
    ...extra
  };
}
