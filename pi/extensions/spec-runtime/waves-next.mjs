// Automatic next-wave continuation (step 10). This module owns the promotion
// continuation boundary split out of waves.mjs: after the sealed-member barrier
// drives a wave to `integrated`, it opens the next validation wave automatically,
// reusing the one package claim and the frozen open inputs. Every guard fails
// closed, so the module only needs the controller's collaborators injected.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// `nextWaveSteps` reads the next validation wave from the frozen index, and
// `nextWaveId` derives the deterministic id the next open would produce for that
// wave on the promoted base.
function nextWaveSteps(validation, ordinal) {
  const waves = Array.isArray(validation?.waves) ? validation.waves : [];
  const steps = waves[ordinal];
  return Array.isArray(steps) && steps.length ? steps.map(Number) : null;
}

function nextWaveId(waveId, context, steps, baseCommit) {
  return waveId({
    package_ref: context.packageRef,
    index_sha256: context.index_sha256,
    evidence_plan_sha256: context.evidence_plan_sha256,
    base_commit: baseCommit,
    steps,
    after: Math.max(...steps)
  });
}

export function createWaveContinuation(deps = {}) {
  const {
    barrier, integration, patchRecord, pendingInbox, canonicalTarget, waveId,
    sha256, nowMs, timestamp, hostCheck, send, loadedWaves, retryQueued,
    openWave, isShuttingDown
  } = deps;

  // One dedup'd attention turn for a next wave that could not open. The dedup
  // key is persisted before the send through the same record guard.
  function emitNextWaveAttention(entry, intentKey, extra) {
    const key = `${entry.waveId}:next-wave:${extra.outcome}`;
    let first = false;
    try {
      patchRecord(entry.recordPath, entry.session, draft => {
        draft.attention = draft.attention ?? {};
        if (draft.attention[key]) return;
        draft.attention[key] = { emitted_at: timestamp(nowMs()) };
        first = true;
      });
    } catch {
      return false;
    }
    if (!first) return false;
    if (typeof send === 'function') {
      send({
        customType: 'spec-wave',
        content: JSON.stringify({ kind: 'next-wave', wave_id: entry.waveId, step: null, state: 'integrated', intent: intentKey, ...extra }),
        display: true
      }, { triggerTurn: false });
    }
    return true;
  }

  // The promotion-continuation: after the barrier drives a wave to
  // `integrated`, open the next validation wave automatically, reusing the one
  // package claim and the frozen open inputs. Every guard fails closed: a wave
  // that is not integrated, has no successor wave, an unreadable/changed
  // record, a pending inbox, hash drift, a coordinator shutdown, or a promoted
  // head that no longer matches the canonical HEAD opens nothing.
  async function driveAndContinue(entry) {
    const result = await barrier.drive(entry);
    if (isShuttingDown()) return result;
    if (!result || result.status !== 'integrated') return result;

    const context = entry?.openContext;
    if (!context) return result;

    const record = (() => { try { return integration.readWaveRecord(entry.recordPath); } catch { return null; } })();
    if (!record || record.wave_id !== entry.waveId) return result;
    if (record.coordinator?.session !== entry.session) return result;
    if (record.state !== 'integrated') return result;
    if (record.cancel_requested || record.interrupted) return result;

    const currentOrdinal = Number(record.ordinal ?? 1);
    const nextOrdinal = currentOrdinal + 1;
    const steps = nextWaveSteps(context.validation, currentOrdinal);
    if (!steps) return result;

    // The next wave's base is the just-promoted candidate. A wave that did not
    // publish a candidate commit cannot seed a successor.
    const promotedBase = record.target?.candidate_commit;
    if (typeof promotedBase !== 'string' || !promotedBase) return result;

    const coordinator = deps.coordinator ? deps.coordinator() : {};
    if (!coordinator || coordinator.session !== entry.session) return result;

    // Frozen input hashes and an empty inbox are the same guards the barrier
    // enforced; the automatic open repeats them because a new effect follows.
    try {
      if (pendingInbox(record.package ?? context.packagePath).length) return result;
    } catch {
      return result;
    }
    try {
      const indexRaw = readFileSync(join(context.packagePath, 'spec-steps.json'));
      const evidenceRaw = readFileSync(join(context.packagePath, 'evidence-plan.json'));
      if (sha256(indexRaw) !== context.index_sha256) return result;
      if (sha256(evidenceRaw) !== context.evidence_plan_sha256) return result;
    } catch {
      return result;
    }

    // The actual canonical HEAD must equal the promoted candidate before the
    // next wave may start from it.
    try {
      const target = (context.locations.targets ?? []).find(candidate => candidate.id === record.target?.id);
      if (!target) return result;
      const canonical = canonicalTarget(target);
      if (canonical.base_commit !== promotedBase) return result;
    } catch {
      return result;
    }

    const nextWave_id = nextWaveId(waveId, context, steps, promotedBase);
    const nextRecordPath = join(context.packagePath, 'runtime', 'waves', `${nextWave_id}.json`);
    // A next record that already exists is loaded and reused without a second
    // launch; the opening below is idempotent only through this replay check.
    if (existsSync(nextRecordPath)) {
      try {
        const loaded = integration.readWaveRecord(nextRecordPath);
        if (loaded?.wave_id === nextWave_id && loaded.coordinator?.session === entry.session) {
          loadedWaves.set(nextWave_id, {
            waveId: nextWave_id, recordPath: nextRecordPath, packagePath: context.packagePath,
            session: entry.session, admission: entry.admission, openContext: context
          });
        }
      } catch {
        // An unreadable existing record is left for reconciliation.
      }
      return result;
    }

    // The host check for the next wave names the next wave's width and cap
    // explicitly; a host that is not ready emits one setup-required attention
    // and opens nothing.
    const intentKey = `next-wave:${nextOrdinal}`;
    try {
      patchRecord(entry.recordPath, entry.session, draft => {
        draft.effects = draft.effects ?? {};
        draft.effects[intentKey] = {
          kind: 'next-wave', assignment_id: `${entry.waveId}/next-wave:${nextOrdinal}`,
          ordinal: nextOrdinal, steps, base_commit: promotedBase,
          next_wave_id: nextWave_id, intent_at: timestamp(nowMs()), outcome: null, observed_at: null
        };
      });
    } catch {
      return result;
    }

    let host = null;
    try {
      host = hostCheck ? await hostCheck({ readyMembers: steps.length, explicitCap: context.input.max_parallel ?? null }) : null;
    } catch {
      host = null;
    }
    if (!host || typeof host !== 'object' || host.status !== 'ready') {
      // Persist the observed outcome and emit one setup-required attention; the
      // next wave is not launched.
      try {
        patchRecord(entry.recordPath, entry.session, draft => {
          const existing = draft.effects?.[intentKey];
          if (existing) draft.effects[intentKey] = { ...existing, outcome: 'setup-required', observed_at: timestamp(nowMs()) };
        });
      } catch { /* leave for reconciliation */ }
      emitNextWaveAttention(entry, intentKey, { outcome: 'setup-required', reason: host?.reason ?? null, remedy: host?.remedy ?? null });
      return result;
    }
    if (!context.input.review_model) return result;

    const opening = openWave({
      ...context,
      host,
      waveSteps: steps,
      ordinal: nextOrdinal,
      inheritedClaim: { token: record.claim_token, coordinator: { session: record.coordinator?.session, epoch: record.coordinator?.epoch } }
    });
    let opened = null;
    try {
      opened = await opening;
    } catch (error) {
      try {
        patchRecord(entry.recordPath, entry.session, draft => {
          const existing = draft.effects?.[intentKey];
          if (existing) draft.effects[intentKey] = { ...existing, outcome: 'failed', observed_at: timestamp(nowMs()), error: error?.code ?? 'open-failed' };
        });
      } catch { /* leave for reconciliation */ }
      return result;
    }
    try {
      patchRecord(entry.recordPath, entry.session, draft => {
        const existing = draft.effects?.[intentKey];
        if (existing) draft.effects[intentKey] = { ...existing, outcome: 'opened', observed_at: timestamp(nowMs()), next_wave_id: opened?.wave_id ?? nextWave_id };
      });
    } catch { /* leave for reconciliation */ }
    const newEntry = opened?.wave_id ? loadedWaves.get(opened.wave_id) : null;
    if (newEntry?.admission) {
      try { await retryQueued(newEntry); } catch { /* the next release retries */ }
    }
    return opened ?? result;
  }

  return { driveAndContinue };
}
