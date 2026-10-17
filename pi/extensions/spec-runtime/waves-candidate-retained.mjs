// Retained candidate-phase recovery (step 10). This module owns the recovery
// boundary for an interrupted candidate repair phase: given the retained
// candidate binding on a durable wave record, it validates the exact identity,
// positively drains the retained owner/stage run behind a liveness
// classification, remounts the retained integration workspace, reserves the
// phase capacity slot, persists the resume intent and launches exactly one
// replacement run. The implementation phase resumes through `runtime.start`;
// every stage phase resumes through `runtime.startStage` with the retained
// stage metadata. Unknown/live classifications, invalid bindings and
// unconfirmed drains block with a named reason and never fabricate success.

import { join } from 'node:path';

// Only these candidate phases are recoverable. A phase outside this set is not
// this module's continuation.
export const CANDIDATE_RECOVERY_PHASES = [
  'integration-repair',
  'integration-review',
  'integration-fix',
  'integration-confirm'
];

const IMPLEMENTATION_PHASE = 'integration-repair';

function cardPathFor(index, packagePath, step) {
  const row = (index?.steps ?? []).find(entry => Number(entry.step) === Number(step));
  const relative = row?.path ?? `step-${String(Number(step)).padStart(3, '0')}-subspec.md`;
  return join(packagePath, relative);
}

export function createCandidateRetainedRecovery(deps = {}) {
  const { runtime, ownership, lifecycle, loadRun, patchRecord, durableConfirmedDrain, nowMs } = deps;

  const now = () => (typeof nowMs === 'function' ? nowMs() : Date.now());
  const timestamp = ms => new Date(ms).toISOString();

  const isDrained = run =>
    typeof durableConfirmedDrain === 'function' ? !!durableConfirmedDrain(run) : false;

  // Persist a candidate-local blocking reason without disturbing the retained
  // repair run/workspace/members/deadline/generation facts.
  function block(record, own, reason) {
    patchRecord(own?.recordPath, own?.session, draft => {
      draft.target = draft.target ?? {};
      const repair = draft.target.repair;
      if (!repair) return;
      repair.recovery_blocking_reason = reason;
    });
    return { status: 'blocked', reason };
  }

  async function resume(entry, passedRecord, own) {
    const packageDir = entry?.packagePath;
    const recordPath = entry?.recordPath;
    const ownCtx = { ...(own ?? {}), recordPath };

    // Work from a clone of the caller's fresh snapshot so state mutations below
    // do not disturb the caller's record object.
    let record = passedRecord;
    try {
      record = JSON.parse(JSON.stringify(passedRecord));
    } catch {
      record = passedRecord;
    }
    if (!record || typeof record !== 'object') return { status: 'skipped' };

    const repair = record.target?.repair ?? null;
    if (!repair) return { status: 'skipped' };
    if (!CANDIDATE_RECOVERY_PHASES.includes(repair.phase)) return { status: 'skipped' };

    const phase = repair.phase;
    const isStage = phase !== IMPLEMENTATION_PHASE;
    const n = repair.n;

    const step = Number(repair.step);
    const attemptId = repair.attempt_id;

    // The durable repair run id is the recovery target. The implementation run
    // id is a fallback only for the owner implementation phase.
    let runId = typeof repair.run_id === 'string' && repair.run_id.length > 0 ? repair.run_id : null;
    if (!runId && !isStage && typeof repair.implementation_run_id === 'string' && repair.implementation_run_id.length > 0) {
      runId = repair.implementation_run_id;
    }
    if (!runId) return block(record, ownCtx, 'stage-binding-invalid');

    let run;
    try { run = loadRun(packageDir, runId); }
    catch { return block(record, ownCtx, 'run-unreadable'); }

    // Validate the exact candidate binding before any inspection or effect.
    const bindings = run?.wave_bindings ?? null;
    const bindingValid = bindings && bindings.wave_id === record.wave_id
      && Number(bindings.step_number) === step
      && bindings.attempt_id === attemptId
      && Number(bindings.candidate) === Number(n)
      && bindings.phase === phase
      && Number(bindings.generation) === Number(record.generation)
      && bindings.claim_token === record.claim_token
      && String(bindings.coordinator_epoch ?? '') === String(record.coordinator?.epoch ?? '')
      && bindings.package_ref === (record.package_ref ?? record.wave_id)
      && run.package === packageDir;
    const stageValid = !isStage
      || (run.stage && typeof run.stage === 'object' && !Array.isArray(run.stage)
        && Number.isInteger(repair.stage_attempt) && repair.stage_attempt >= 1);
    if (!bindingValid || !stageValid) {
      return block(record, ownCtx, 'stage-binding-invalid');
    }

    // Only after the exact binding and stage validation passes may an already
    // completed, drain-confirmed replacement be treated as a no-op. A foreign
    // completed run (wrong package/binding) is never skipped.
    const retainedRunId = repair.run_id ?? null;
    if (typeof retainedRunId === 'string' && retainedRunId.length > 0
      && retainedRunId === runId && run.state === 'completed' && isDrained(run)) {
      return { status: 'skipped' };
    }

    // Inspect liveness under the ownership-verified contract. Unknown/live
    // classifications block and preserve the retained repair facts.
    const classification = lifecycle && typeof lifecycle.inspect === 'function'
      ? await lifecycle.inspect(run, { ownershipVerified: true })
      : { status: 'unknown', reason: 'liveness-unknown' };
    const status = classification?.status;
    if (status === 'unknown' || status === 'live') {
      return block(record, ownCtx, status === 'live' ? 'liveness-live' : 'liveness-unknown');
    }

    // Drain the retained run: cancel an owned handle when this Runtime still
    // holds it, otherwise drain a populated contained service. A `confirmed`
    // run needs a drain only when no durable confirmed receipt exists.
    if (status === 'populated') {
      const handle = typeof runtime?.active?.get === 'function' ? runtime.active.get(runId) : null;
      if (handle?.record) {
        await runtime.cancel(packageDir, runId);
      } else {
        const drained = await runtime.drainContainedService(run, { cancel: true });
        if (drained?.status !== 'confirmed') {
          return block(record, ownCtx, drained?.reason || drained?.status || 'drain-unconfirmed');
        }
      }
    } else if (status === 'confirmed') {
      if (!isDrained(run)) {
        const drained = await runtime.drainContainedService(run);
        if (drained?.status !== 'confirmed') {
          return block(record, ownCtx, drained?.reason || drained?.status || 'drain-unconfirmed');
        }
      }
    } else {
      return block(record, ownCtx, 'liveness-unknown');
    }

    // Reload the durable run and require a positively confirmed drain before
    // remounting.
    let durableRun;
    try { durableRun = loadRun(packageDir, runId); }
    catch { durableRun = run; }
    if (!isDrained(durableRun)) {
      return block(record, ownCtx, 'drain-unconfirmed');
    }

    const cardPath = entry?.admission?.cardPaths?.get?.(step)
      ?? cardPathFor(entry?.openContext?.index, packageDir, step);

    // Remount the retained integration workspace under the exact candidate
    // identity.
    try {
      await runtime.remountWaveMember({
        package: packageDir,
        step: cardPath,
        wave_id: record.wave_id,
        expected_generation: record.generation,
        step_number: step,
        attempt_id: attemptId,
        candidate: n,
        phase,
        claim_token: record.claim_token,
        coordinator_epoch: record.coordinator?.epoch
      });
    } catch (error) {
      return block(record, ownCtx, error?.code || 'remount-failed');
    }

    // Reserve the phase capacity slot with the same limits/request structure as
    // the owner-member recovery.
    const limits = record.effective_limits ?? {};
    const attempt = isStage ? repair.stage_attempt : (repair.attempt ?? 1);
    let reserved;
    try {
      reserved = await ownership.reserveCapacity({
        packageId: record.package_ref,
        attempt: `${record.wave_id}:${attemptId}:${phase}`,
        request: {
          memoryBytes: limits.memory?.per_lifecycle_bytes ?? null,
          tasks: limits.tasks?.per_lifecycle ?? null
        },
        coordinator: own
      });
    } catch {
      return block(record, ownCtx, 'capacity-error');
    }
    if (reserved?.status !== 'reserved') {
      return block(record, ownCtx, reserved?.constraint?.reason || reserved?.status || 'capacity-unavailable');
    }

    const resume = (Number.isInteger(repair.resume) ? repair.resume : 0) + 1;
    const assignment = isStage
      ? `wave:${record.wave_id}/candidate:${n}/phase:${phase}/attempt:${attempt}/resume:${resume}`
      : `wave:${record.wave_id}/candidate:${n}/phase:${phase}/attempt:1/resume:${resume}`;
    const effectKey = isStage
      ? `${record.wave_id}:${attemptId}:${phase}:${repair.stage_attempt}`
      : `${record.wave_id}:${attemptId}:implementing`;

    // Persist the candidate-local resume increment and assignment/effect intent
    // before the launch so a crash between intent and launch cannot consume a
    // second slot.
    patchRecord(recordPath, own?.session, draft => {
      draft.target = draft.target ?? {};
      const repairDraft = draft.target.repair;
      if (repairDraft) {
        repairDraft.resume = resume;
        repairDraft.recovery_blocking_reason = null;
      }
      draft.effects = draft.effects ?? {};
      draft.effects[effectKey] = {
        ...(draft.effects[effectKey] ?? { kind: phase }),
        assignment_id: assignment,
        resume,
        resume_intent_at: timestamp(now()),
        outcome: null
      };
    });

    let summary;
    try {
      summary = isStage
        ? await runtime.startStage({
            package: packageDir,
            step: cardPath,
            wave_id: record.wave_id,
            expected_generation: record.generation,
            step_number: step,
            attempt_id: attemptId,
            candidate: n,
            phase,
            claim_token: record.claim_token,
            coordinator_epoch: record.coordinator?.epoch,
            implementation_run_id: repair.implementation_run_id,
            stage_attempt: repair.stage_attempt,
            resume,
            stage: run.stage,
            subject: { kind: 'candidate', repair: n, parents: repair.parents ?? [] },
            review_model: record.models?.review_model,
            fix_model_override: record.models?.fix_model_override,
            editor_model: record.models?.editor_model
          })
        : await runtime.start({
            package: packageDir,
            step: cardPath,
            target: record.target?.id ?? entry?.admission?.targetId ?? null,
            wave_id: record.wave_id,
            expected_generation: record.generation,
            step_number: step,
            attempt_id: attemptId,
            phase: IMPLEMENTATION_PHASE,
            candidate: n,
            claim_token: record.claim_token,
            coordinator_epoch: record.coordinator?.epoch,
            assignment_id: assignment,
            resume,
            workflow_id: entry?.openContext?.input?.workflow_id ?? record.workflow_id,
            isolation: entry?.openContext?.input?.isolation ?? record.isolation_requested,
            owner_model: entry?.openContext?.input?.owner_model ?? record.models?.owner_model ?? null,
            strong_owner_model: entry?.openContext?.input?.strong_owner_model ?? record.models?.strong_owner_model ?? null,
            writing_route: record.writing_route ?? null,
            editor_model: entry?.openContext?.input?.editor_model ?? record.models?.editor_model ?? null,
            review_model: entry?.openContext?.input?.review_model ?? record.models?.review_model ?? null,
            fix_model_override: entry?.openContext?.input?.fix_model_override ?? record.models?.fix_model_override ?? null,
            scout_model: entry?.openContext?.input?.scout_model ?? record.models?.scout_model ?? null,
            child_extensions: entry?.openContext?.input?.child_extensions ?? [],
            instructions: entry?.openContext?.input?.instructions ?? null,
            subject: { kind: 'candidate', repair: n, parents: repair.parents ?? [] }
          }, entry?.admission?.parentSession ?? entry?.openContext?.parentSession ?? null);
    } catch (error) {
      patchRecord(recordPath, own?.session, draft => {
        const repairDraft = draft.target?.repair;
        if (repairDraft) repairDraft.recovery_blocking_reason = error?.code || 'resume-launch-failed';
        draft.effects = draft.effects ?? {};
        draft.effects[effectKey] = {
          ...(draft.effects[effectKey] ?? { kind: phase }),
          outcome: 'refused',
          observed_at: timestamp(now()),
          reason: error?.code || 'resume-launch-failed'
        };
      });
      return { status: 'blocked', reason: error?.code || 'resume-launch-failed' };
    }

    // On success both paths persist the replacement as the durable repair run
    // id; only the owner implementation phase updates the implementation id.
    patchRecord(recordPath, own?.session, draft => {
      const repairDraft = draft.target?.repair;
      if (repairDraft) {
        if (typeof summary?.run_id === 'string' && summary.run_id.length > 0)
          repairDraft.run_id = summary.run_id;
        if (!isStage && typeof summary?.run_id === 'string' && summary.run_id.length > 0)
          repairDraft.implementation_run_id = summary.run_id;
        repairDraft.recovery_blocking_reason = null;
      }
      draft.state = 'repairing';
      draft.transitions = Array.isArray(draft.transitions) ? draft.transitions : [];
      draft.transitions.push({ state: 'repairing', at: timestamp(now()), reason: 'candidate-resumed' });
      draft.effects = draft.effects ?? {};
      draft.effects[effectKey] = {
        ...(draft.effects[effectKey] ?? { kind: phase }),
        outcome: 'launched',
        observed_at: timestamp(now())
      };
    });
    return { status: 'resumed' };
  }

  return { resume };
}
