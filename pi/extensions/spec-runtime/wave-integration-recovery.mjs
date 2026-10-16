// Confirmed-drain repair resumption (C9-1). A repair prepare that crashed with
// its phase transport genuinely unknown journals the stranded phase and keeps
// its claims; the conflict may also be retained. Only an operator-supplied
// `drain: 'confirmed'` lets the retry release the recorded claims and CAS the
// journal back to a repairable state, after which the ordinary repair flow
// re-detects the original trigger. This module holds the recovery in a sibling
// to wave-integration.mjs to avoid an import cycle.

// A retained conflict or any failed check is the evidence a repair was pending.
function repairEvidence(integration) {
  const checks = integration?.checks;
  const failed = Array.isArray(checks) && checks.some(entry => entry?.outcome === 'fail');
  return { conflict: Boolean(integration?.conflict), failed };
}

// Resume only a confirmed-drain retry of a stranded repair. Every other shape
// is returned unchanged so the caller's existing flow owns it.
export async function resumeIntegrationRepair(ctx, record, { drain } = {}, helpers) {
  const { releaseRecordedClaim, updateWaveRecord, refuse } = helpers;
  const integration = record?.target?.integration;
  if (!integration) return record;
  if (integration.status !== 'blocked') return record;
  if (integration.blocked_reason === 'repair-unresolved') return record;
  // An already-journaled request is replayed by the caller, not resumed here.
  if (integration.repair_request) return record;
  const evidence = repairEvidence(integration);
  if (!evidence.conflict && !evidence.failed) return record;

  // Eligible, but a release is only safe once the operator has confirmed the
  // stranded phase drained. Without that confirmation the retry refuses with
  // no journal write and no claim release.
  if (drain !== 'confirmed') refuse('drain-unknown', 'a stranded repair phase needs a confirmed drain');

  const phase = integration.phase ?? {};
  if (phase.capacity_claim) await releaseRecordedClaim(ctx, phase.capacity_claim);
  if (phase.claim) await releaseRecordedClaim(ctx, phase.claim);

  const status = evidence.conflict ? 'conflict' : 'checks-failed';
  const next = updateWaveRecord(ctx.recordPath, { expectedRevision: record.revision }, draft => {
    const current = draft.target.integration;
    // Preserve the retained conflict, merged parents, checks, workspace and the
    // prior phase identity: the released token stays as the historical overlay
    // remount identity. Only the status and block are rewritten.
    draft.target.integration = { ...current, status, blocked_reason: null };
  });
  return next;
}
