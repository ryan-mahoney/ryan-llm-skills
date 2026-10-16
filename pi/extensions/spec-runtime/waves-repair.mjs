// Wave member repair (step 10). This module owns the explicit review-repair
// control: given a located wave it refuses a stale generation or foreign
// coordinator, normalizes the target step, rechecks the frozen index/evidence
// plan, drained inbox, unexpired deadline and live package claim, then persists
// the repair intent and resumes the member. Serialization stays with the
// controller, which wraps the returned `advance` in its own FIFO.

import { join } from 'node:path';

export function createMemberRepair(deps = {}) {
  const {
    locateControl, loadedWaves, readJsonFile, normalizeStep, invalid, unreadable,
    refusalError, sha256, pendingInbox, nowMs, timestamp, ownership, assignmentId,
    patchRecord, memberEvents, driveAndContinue, integration, waveReceipt, retryQueued,
    loadOwnedEntry, reconcileLaunches
  } = deps;

  async function advance(input = {}) {
    // The generation guard and loaded-entry requirement are locateControl's:
    // a stale expected_generation refuses before any effect, and a wave this
    // controller holds no entry for cannot be advanced.
    const located = await locateControl(input);
    const { packageDir, recordPath, wave_id, record } = located;
    let entry = loadedWaves.get(wave_id);
    // A missing entry may be reloaded from the same-owner recovery seam
    // (exact stored coordinator identity and matching frozen hashes) before
    // the stale/ownership guards below; recovery load never writes, rebinds
    // or launches.
    if (!entry && typeof loadOwnedEntry === 'function') {
      entry = await loadOwnedEntry(located);
    }
    if (!entry) throw invalid('wave-not-loaded', `No loaded wave entry for ${wave_id}; advance requires a wave this controller opened or adopted.`);
    // The live coordinator session must match both the durable record and
    // the loaded entry, so a second coordinator cannot advance another's wave.
    const ownSession = deps.coordinator ? deps.coordinator()?.session : null;
    if (!ownSession || record.coordinator?.session !== ownSession || entry.session !== ownSession)
      throw refusalError({ code: 'coordinator-conflict',
        message: 'advance requires the current coordinator session to own the durable wave record.',
        remedy: 'Advance through the coordinator session that opened the wave.' });

    // An explicit repair names one member step and is normalized against the
    // index rows; a step-less advance is a control nudge that resumes the wave
    // without fabricating a repair, so member and kind validation only apply
    // when a step was supplied.
    const indexRead = readJsonFile(join(packageDir, 'spec-steps.json'));
    if (!indexRead.ok) throw unreadable('index-unreadable', join(packageDir, 'spec-steps.json'));
    const step = normalizeStep(indexRead.json, packageDir, input.step);

    const member = step == null ? null : record.members?.[String(step)];
    if (step != null && !member) throw invalid('step-invalid', `step ${step} is not a member of wave ${wave_id}.`);

    // Two explicit repair kinds share this advance: a review-repair (member
    // blocked confirmation-failed) and an ownership-adaptive repair (member
    // blocked undeclared-write). The branch is chosen by the presence of an
    // `adaptations` array on the input so a caller cannot smuggle adaptation
    // entries into a review-repair and vice versa. A step-less advance carries
    // no repair kind, so its adaptation/kind checks are skipped.
    const adaptive = step != null && input.adaptations !== undefined;
    let instructions = null;
    let adaptations = null;
    if (adaptive) {
      if (member.phase !== 'blocked' || member.blocking_reason !== 'undeclared-write')
        throw refusalError({ code: 'repair-not-applicable',
          message: `step ${step} is not blocked on undeclared-write (phase ${JSON.stringify(member.phase)}, reason ${JSON.stringify(member.blocking_reason ?? null)}).`,
          remedy: 'Ownership adaptation advance is only accepted for a member blocked undeclared-write.' });
      const raw = input.adaptations;
      if (!Array.isArray(raw) || raw.length === 0)
        throw invalid('adaptations-invalid', 'advance with adaptations requires a nonempty array.');
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object'
          || typeof entry.path !== 'string' || !entry.path.trim()
          || typeof entry.reason !== 'string' || !entry.reason.trim())
          throw invalid('adaptations-invalid', 'Each adaptation requires nonempty string path and reason.');
      }
      adaptations = raw.map(entry => ({
        path: entry.path.trim(), reason: entry.reason.trim(), recorded_by: 'coordinator', recorded_at: timestamp(nowMs())
      }));
    } else if (step != null) {
      if (member.phase !== 'blocked' || member.blocking_reason !== 'confirmation-failed')
        throw refusalError({ code: 'repair-not-applicable',
          message: `step ${step} is not blocked on confidence-failed (phase ${JSON.stringify(member.phase)}, reason ${JSON.stringify(member.blocking_reason ?? null)}).`,
          remedy: 'Explicit review-repair advance is only accepted for a member blocked confirmation-failed.' });
      if (input.attempt_kind !== 'review-repair')
        throw refusalError({ code: 'repair-kind-unsupported',
          message: `attempt_kind must be 'review-repair' for an explicit repair, got ${JSON.stringify(input.attempt_kind)}.`,
          remedy: 'Pass attempt_kind: review-repair.' });
      instructions = input.instructions;
      if (typeof instructions !== 'string' || !instructions.trim())
        throw invalid('repair-instructions-required', 'advance with attempt_kind review-repair requires nonempty instructions.');
    }

    // Fail-closed rechecks before any write or launch: the frozen index and
    // evidence plan must be unchanged, the inbox drained, the deadline
    // unexpired, and the live package claim still held by this exact epoch
    // and session.
    const indexFrozen = readJsonFile(join(packageDir, 'spec-steps.json'));
    const evidenceFrozen = readJsonFile(join(packageDir, 'evidence-plan.json'));
    if (!indexFrozen.ok || !evidenceFrozen.ok || sha256(indexFrozen.raw) !== record.inputs?.index_sha256)
      throw refusalError({ code: 'index-refrozen', message: 'The frozen index inputs changed since the wave opened.',
        remedy: 'Reopen the wave against the current index.' });
    if (sha256(evidenceFrozen.raw) !== record.inputs?.evidence_plan_sha256)
      throw refusalError({ code: 'evidence-refrozen', message: 'The frozen evidence plan changed since the wave opened.',
        remedy: 'Reopen the wave against the current evidence plan.' });
    const pending = pendingInbox(packageDir);
    if (Array.isArray(pending) && pending.length)
      throw refusalError({ code: 'input-pending', message: `Inbox still holds ${pending.length} pending message(s).`,
        remedy: 'Drain the inbox before advancing a repair.' });
    const deadlineValue = record?.deadline == null
      ? null
      : (typeof record.deadline === 'object' ? record.deadline.expires_at : record.deadline);
    const expires = typeof deadlineValue === 'number' ? deadlineValue : (deadlineValue == null ? null : Date.parse(deadlineValue));
    if (expires !== null && Number.isFinite(expires) && nowMs() > expires)
      throw refusalError({ code: 'deadline-expired', message: 'The wave deadline has expired.',
        remedy: 'Extend or reopen the wave; an expired deadline is never reset.' });
    const { claims: liveClaims } = await ownership.inspectClaims({ packageId: record.package_ref ?? record.wave_id });
    const heldClaim = (liveClaims ?? []).find(claim => claim?.kind === 'package' && claim.token === record.claim_token);
    const claimOk = heldClaim
      && heldClaim.coordinator?.session === record.coordinator?.session
      && String(heldClaim.epoch) === String(record.coordinator?.epoch);
    if (!claimOk)
      throw refusalError({ code: 'claim-lost', message: 'The live package claim is no longer held by this coordinator session and epoch.',
        remedy: 'Recover the wave from a live coordinator session.' });

    // Both branches are fail-closed behind the shared index/evidence/inbox/
    // deadline/claim guards above; only now do they diverge into their own
    // mutation and (for adaptation) seal effect flow. A step-less advance is
    // the base case: after the same guards it nudges the wave's queued members
    // and continuation forward without persisting any repair or mutation.
    if (step == null) {
      // Reconcile a lost controller implementation outcome before nudging the
      // wave forward, so a run that launched but never recorded its outcome is
      // adopted instead of duplicated by the queued retry.
      if (typeof reconcileLaunches === 'function') await reconcileLaunches(entry);
      await retryQueued(entry);
      await driveAndContinue(entry);
      return waveReceipt(integration.readWaveRecord(recordPath), recordPath);
    }

    if (adaptive) {
      // Persist the normalized adaptation entries on the member, clear the
      // undeclared-write block and resume the wave. The seal retry is driven by
      // an effect intent unique to this member and adaptation count so a replay
      // observes the prior outcome instead of re-sealing.
      const adaptationCount = adaptations.length;
      patchRecord(recordPath, entry.session, draft => {
        const target = draft.members[String(step)];
        target.ownership_adaptations = adaptations;
        delete target.blocking_reason;
        delete target.blocking_detail;
        if (draft.blocking && typeof draft.blocking === 'object') delete draft.blocking.reason;
        if (draft.state !== 'running') {
          draft.state = 'running';
          draft.transitions = Array.isArray(draft.transitions) ? draft.transitions : [];
          draft.transitions.push({ state: 'running', at: timestamp(nowMs()) });
        }
      });
      const effectKey = `${wave_id}:${step}:adapt-${adaptationCount}`;
      patchRecord(recordPath, entry.session, draft => {
        draft.effects = draft.effects ?? {};
        draft.effects[effectKey] = {
          assignment_id: effectKey,
          kind: 'seal-retry',
          step,
          adaptation_count: adaptationCount,
          intent_at: timestamp(nowMs()),
          outcome: null,
          observed_at: null
        };
      });
      const outcome = await memberEvents.retrySeal(entry, step);
      patchRecord(recordPath, entry.session, draft => {
        const effect = draft.effects?.[effectKey];
        if (effect) {
          effect.outcome = outcome ?? 'unknown';
          effect.observed_at = timestamp(nowMs());
        }
      });
      await driveAndContinue(entry);
      return waveReceipt(integration.readWaveRecord(recordPath), recordPath);
    }

    // Persist the repair intent, clear the member block and resume the
    // wave; sealed siblings and the previous phase are left untouched so a
    // later review-action re-derives their state.
    const nextStageAttempt = (Number.isInteger(member.stage_attempt) ? member.stage_attempt : 0) + 1;
    const repairAssignment = assignmentId({ wave_id, step, phase: 'fixing', attempt: nextStageAttempt, packet: 1 });
    patchRecord(recordPath, entry.session, draft => {
      const target = draft.members[String(step)];
      target.repair = { assignment_id: repairAssignment, instructions, recorded_at: timestamp(nowMs()) };
      delete target.blocking_reason;
      delete target.blocking_detail;
      if (draft.blocking && typeof draft.blocking === 'object') delete draft.blocking.reason;
      if (draft.state !== 'running') {
        draft.state = 'running';
        draft.transitions = Array.isArray(draft.transitions) ? draft.transitions : [];
        draft.transitions.push({ state: 'running', at: timestamp(nowMs()) });
      }
    });

    await memberEvents.resumeReview(entry, step);
    await driveAndContinue(entry);
    return waveReceipt(integration.readWaveRecord(recordPath), recordPath);
  }

  return { advance };
}
