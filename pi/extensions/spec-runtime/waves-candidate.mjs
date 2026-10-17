// Candidate integration-repair driver (spec-dispatch step 10).
//
// A failed composition gate is not terminal: the barrier hands the wave to this
// driver, which owns the candidate subject recorded on `wave.target.repair`.
// It prepares and journals the repair packet, binds a real Runtime owner run to
// the candidate checkout, drives the candidate review rounds through the same
// review state machine members use, and hands an accepted repair back to the
// barrier for re-assembly, checks and promotion. It never touches member state.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createOverlayPhases } from './overlay.mjs';
import { remountRetainedWorkspace } from './step-workspaces.mjs';

// The candidate owner phase and its stage phases. The stage phases are the
// candidate-specific spellings of reviewing/fixing so the role map selects the
// reviewer/fixer contract without colliding with member phases.
const CANDIDATE_PHASE = 'integration-repair';
const PHASE_FOR_ACTION = Object.freeze({
  'launch-review': 'integration-review',
  'launch-fix-packet': 'integration-fix',
  'launch-confirmation': 'integration-confirm'
});
const MAX_ACTIONS = 32;
const MAX_PASSES = 8;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

const pad3 = value => String(value).padStart(3, '0');

export function createCandidateRepair(deps = {}) {
  const {
    runtime, ownership, integration, review, loadRun,
    patchRecord, pendingInbox, nowMs, context
  } = deps;
  const now = () => (typeof nowMs === 'function' ? nowMs() : Date.now());
  const at = () => new Date(now()).toISOString();

  const readRecord = entry => integration.readWaveRecord(entry.recordPath);

  function cardPathOf(record, step) {
    const index = readJson(join(record.package, 'spec-steps.json'));
    const row = (index?.steps ?? []).find(item => Number(item.step) === Number(step));
    return join(record.package, row?.path ?? `step-${pad3(step)}-subspec.md`);
  }

  // The lifecycle capacity projection. A missing/invalid effective limit means
  // no request is fabricated; the reservation call then fails closed.
  function capacityRequest(record) {
    const mem = record?.effective_limits?.memory?.per_lifecycle_bytes;
    const tasks = record?.effective_limits?.tasks?.per_lifecycle;
    if (!Number.isInteger(mem) || !Number.isInteger(tasks)) return null;
    return { memoryBytes: mem, tasks };
  }

  function coordinatorIdentity(record) {
    const coordinator = record?.coordinator ?? null;
    if (!coordinator || typeof coordinator !== 'object') return coordinator;
    const process = coordinator.process_identity ?? {};
    return {
      session: coordinator.session,
      epoch: coordinator.epoch,
      pid: process.pid ?? null,
      started_at: process.started_at ?? null
    };
  }

  // The prepared packet's candidate phase claim was released when the phase
  // drained. Before the retained workspace is re-claimed we require positive
  // absence: an uninspectable reading is unknown, and any token still present --
  // regardless of epoch -- is held and refused, never authorized on a mismatch.
  async function confirmPhaseClaimDrained(packageId, packet) {
    const claim = packet?.phase_claim ?? null;
    if (!claim || typeof claim.token !== 'string' || !claim.token) return null;
    let inspected;
    try {
      inspected = await ownership.inspectClaims({ packageId });
    } catch (error) {
      return { reason: 'phase-claim-unknown', detail: error?.message ?? 'ownership claim inspection failed' };
    }
    if (!inspected || !Array.isArray(inspected.claims)) {
      return { reason: 'phase-claim-unknown', detail: 'ownership claim inspection returned no claims' };
    }
    if (inspected.claims.some(item => item?.token === claim.token)) {
      return { reason: 'phase-not-drained', detail: `candidate phase claim ${claim.token} is still held` };
    }
    return null;
  }

  // Re-claim the retained candidate workspace for the owner run. The worktree
  // backend mirrors `enterCandidatePhase`: the upper/work pair derived from the
  // retained worktree path is claimed under the candidate-repair phase token.
  // The overlay backend remounts the retained layers through the guarded helper,
  // which validates the retained identity before taking the claim.
  async function reclaimCandidateWorkspace(record, packet, n, ctx) {
    const integration = record.target?.integration ?? {};
    const current = integration.workspace ?? null;
    if (!current || typeof current !== 'object') {
      return { status: 'blocked', reason: 'candidate-workspace-missing', detail: 'the retained candidate workspace is absent' };
    }
    const retained = current.retained ?? current;
    const backend = retained.backend ?? integration.backend ?? ctx.workspace?.mode ?? null;
    const phaseToken = `${ctx.waveId}:candidate-${n}:integration-repair`;
    if (backend === 'worktree') {
      const started = await createOverlayPhases({ ownership }).startPhase({
        packageId: ctx.packageId,
        upper: join(dirname(retained.worktree), 'upper'),
        work: join(dirname(retained.worktree), 'work'),
        phaseToken,
        coordinator: ctx.coordinator
      });
      if (started.status === 'refused') {
        return { status: 'blocked', reason: 'upper-held', detail: `worktree candidate phase ${phaseToken} is held` };
      }
      return { status: 'claimed', workspace: { ...retained, retained, claim: started.claim }, retained, claim: started.claim };
    }
    const workspace = await remountRetainedWorkspace({
      retained,
      expected: retained,
      previous: packet?.phase_claim ?? null,
      phaseToken,
      coordinator: ctx.coordinator,
      ownership,
      request: { attemptId: retained.upperId, waveRoot: ctx.workspace.waveRoot }
    });
    return { status: 'claimed', workspace, retained, claim: workspace.claim };
  }

  // The owner run's instructions carry the candidate provenance the binding
  // validates: the triggering failure, its parents and failed gates, plus the
  // exact parent requirement the repair commit must satisfy.
  function repairInstructions(repair) {
    const packet = repair?.packet ?? {};
    const parents = packet.parents ?? repair?.parents ?? [];
    const failedGates = Array.isArray(packet.failed_gates) ? packet.failed_gates : [];
    const parentsText = parents.length ? parents.join(', ') : 'none';
    const gatesText = failedGates.length ? failedGates.join(', ') : 'none';
    const exactParents = parents.length
      ? `The repair commit must have exactly these parents in order: ${parentsText}.`
      : 'The repair commit must have no parents.';
    return `Integration repair candidate ${repair.n}. Trigger: ${packet.trigger ?? repair?.trigger ?? 'unknown'}. Parents: ${parentsText}. Failed gates: ${gatesText}. ${exactParents}`;
  }

  function subjectOf(repair) {
    return { kind: 'candidate', repair: repair.n, parents: repair.parents ?? [] };
  }

  // The exact candidate owner identity Runtime.bind-wave-member validates
  // against the durable `target.repair`; no identity is invented here.
  function ownerIdentity(entry, record, repair) {
    return {
      package: entry.packagePath,
      step: cardPathOf(record, repair.step),
      step_number: repair.step,
      wave_id: entry.waveId,
      expected_generation: record.generation,
      claim_token: record.claim_token,
      coordinator_epoch: record.coordinator?.epoch ?? null,
      candidate: repair.n,
      attempt_id: repair.attempt_id,
      phase: repair.phase,
      subject: subjectOf(repair),
      owner_model: record.models?.owner_model,
      editor_model: record.models?.editor_model,
      review_model: record.models?.review_model,
      scout_model: record.models?.scout_model,
      instructions: record.instructions
        ? `${repairInstructions(repair)} ${record.instructions}`
        : repairInstructions(repair)
    };
  }

  function stageIdentity(entry, record, repair, phase) {
    return {
      package: entry.packagePath,
      step: cardPathOf(record, repair.step),
      step_number: repair.step,
      wave_id: entry.waveId,
      expected_generation: record.generation,
      claim_token: record.claim_token,
      coordinator_epoch: record.coordinator?.epoch ?? null,
      candidate: repair.n,
      attempt_id: repair.attempt_id,
      phase,
      subject: subjectOf(repair)
    };
  }

  // Reconcile a lost candidate owner outcome: the durable repair binds
  // `run_id` but no `implementation_run_id` was journaled. Adopt the run id only
  // when the loaded owner run is an exact binding for this candidate repair.
  // Stage runs and explicitly non-owner roles are refused; a missing run or any
  // mismatch blocks with `candidate-binding-unknown` before any write or launch.
  function reconcileLostOutcome(entry, repair) {
    let run;
    try { run = loadRun(entry.packagePath, repair.run_id); } catch { run = null; }
    if (!run || run.stage != null) return { status: 'blocked', reason: 'candidate-binding-unknown' };
    if (run.role != null && run.role !== 'owner')
      return { status: 'blocked', reason: 'candidate-binding-unknown' };
    const bindings = run.wave_bindings;
    const matches = run.id === repair.run_id
      && run.package === entry.packagePath
      && bindings?.wave_id === entry.waveId
      && bindings?.candidate === repair.n
      && bindings?.step_number === repair.step
      && bindings?.attempt_id === repair.attempt_id
      && bindings?.phase === repair.phase;
    if (!matches) return { status: 'blocked', reason: 'candidate-binding-unknown' };
    return { status: 'adopted', runId: run.id };
  }

  function acceptedAttempt(state, head) {
    for (const round of state?.rounds ?? []) {
      const match = (round?.attempts ?? []).find(item => item.result === 'accepted' && item.head === head);
      if (match) return match;
    }
    return null;
  }

  function actionableFindingIds(state) {
    const round = (state?.rounds ?? []).find(item => item.round === 1) ?? null;
    const accepted = round?.attempts?.find(item => item.result === 'accepted') ?? null;
    const findings = accepted?.receipt?.payload?.findings ?? accepted?.findings ?? state?.findings ?? [];
    return findings.filter(finding => finding?.actionable === true).map(finding => finding.id);
  }

  function block(entry, reason, detail) {
    patchRecord(entry.recordPath, entry.session, draft => {
      draft.state = 'blocked';
      draft.blocking_reason = reason;
      if (detail) draft.blocking_detail = detail;
      draft.transitions = Array.isArray(draft.transitions) ? draft.transitions : [];
      draft.transitions.push({ state: 'blocked', at: at(), reason });
    });
    return { status: 'blocked', reason };
  }

  async function begin(entry) {
    if (!entry || typeof entry !== 'object') return { status: 'idle' };
    let record;
    try { record = readRecord(entry); } catch { return { status: 'unreadable' }; }
    if (!record || record.wave_id !== entry.waveId) return { status: 'foreign' };
    if (record.state === 'integrated' || record.state === 'cancelled') return { status: record.state };
    // Already launched: the durable implementation run id is the binding.
    // Re-driving a bound candidate is the job of `drive`, not a second launch.
    if (record.target?.repair?.implementation_run_id || record.target?.repair?.run_id)
      return { status: 'progressing' };

    let prepared;
    try {
      prepared = await integration.prepareIntegrationRepair(context(entry));
    } catch (error) {
      return block(entry, error?.code ?? 'repair-preparation-failed', error?.message ?? null);
    }
    if (prepared.status === 'queued') return { status: 'queued', constraint: prepared.constraint ?? null };
    if (prepared.status === 'blocked') return block(entry, prepared.reason ?? prepared.blocked_reason ?? 'repair-unresolved', null);
    if (prepared.status !== 'repair-ready' || !prepared.repair) return block(entry, prepared.reason ?? 'repair-preparation-failed', null);

    const packet = prepared.repair;
    const existing = record.target?.repair ?? null;
    const replay = existing && existing.packet?.attempt === packet.attempt && existing.packet?.trigger === packet.trigger;
    const n = replay ? existing.n : ((record.target?.integration?.repairs?.length ?? 0) + 1);
    const repair = {
      n,
      step: packet.step ?? record.after,
      trigger: packet.trigger ?? null,
      attempt_id: `candidate-${n}`,
      phase: CANDIDATE_PHASE,
      run_id: null,
      implementation_run_id: replay ? existing.implementation_run_id ?? null : null,
      stage_attempt: replay ? existing.stage_attempt ?? 0 : 0,
      parents: packet.parents ?? [],
      packet
    };
    // Persist the candidate identity and the repairing state before the effect;
    // Runtime.start binds `target.repair.run_id` and the checkout claim.
    patchRecord(entry.recordPath, entry.session, draft => {
      draft.target = draft.target ?? {};
      draft.target.repair = repair;
      if (draft.state !== 'repairing') {
        draft.state = 'repairing';
        draft.transitions = Array.isArray(draft.transitions) ? draft.transitions : [];
        draft.transitions.push({ state: 'repairing', at: at(), reason: 'integration-repair' });
      }
    });

    const ctx = context(entry);

    // The packet's phase claim was released at drain. Positively confirm it is
    // absent before any re-claim; unknown or still-held refuses fail-closed.
    const drained = await confirmPhaseClaimDrained(ctx.packageId, packet);
    if (drained) return block(entry, drained.reason, drained.detail);

    const fresh = readRecord(entry);
    let remount;
    try {
      remount = await reclaimCandidateWorkspace(fresh, packet, n, ctx);
    } catch (error) {
      return block(entry, error?.code ?? 'candidate-remount-failed', error?.message ?? null);
    }
    if (remount.status !== 'claimed') return block(entry, remount.reason, remount.detail ?? null);

    // Persist the retained identity and its fresh claim before the run effect;
    // Runtime.start validates the checkout claim against this durable workspace.
    patchRecord(entry.recordPath, entry.session, draft => {
      draft.target = draft.target ?? {};
      const integration = draft.target.integration ?? {};
      draft.target.integration = {
        ...integration,
        workspace: {
          ...(integration.workspace ?? {}),
          ...remount.workspace,
          retained: remount.retained,
          claim: remount.claim
        }
      };
    });

    let reservation;
    try {
      reservation = await ownership.reserveCapacity({
        packageId: ctx.packageId,
        attempt: `${entry.waveId}:${repair.attempt_id}:integration-repair`,
        request: ctx.capacity,
        coordinator: ctx.coordinator
      });
    } catch (error) {
      return block(entry, 'launch-failed', `capacity reservation failed: ${error?.message ?? error}`);
    }
    if (reservation?.status === 'queued') return { status: 'queued', constraint: reservation.constraint ?? null };
    if (reservation?.status !== 'reserved') {
      return block(entry, 'launch-failed', `capacity reservation was not confirmed (${reservation?.status ?? 'unknown'})`);
    }

    let started;
    try {
      started = await runtime.start(ownerIdentity(entry, record, repair));
    } catch (error) {
      return block(entry, error?.code ?? 'candidate-launch-failed', error?.message ?? null);
    }
    // Runtime binds the owner run to `target.repair.run_id`; the implementation
    // run id is the durable repair identity and survives every later remount,
    // which clears only the transient stage `run_id`.
    let launched = null;
    try { launched = readRecord(entry); } catch { launched = null; }
    const implementationRunId = started?.run_id ?? launched?.target?.repair?.run_id ?? null;
    if (implementationRunId) {
      patchRecord(entry.recordPath, entry.session, draft => {
        if (draft.target?.repair) draft.target.repair.implementation_run_id = implementationRunId;
      });
    }
    return { status: 'launched', run_id: started?.run_id ?? null };
  }

  // Launch one candidate stage: remount the retained candidate workspace, take
  // real capacity, then start the role stage. The intent is persisted before
  // the effects so a redelivery is deduped by the recorded effect.
  async function launch(entry, record, repair, state, action, phase) {
    const pending = typeof pendingInbox === 'function' ? pendingInbox(entry.packagePath) : [];
    if (Array.isArray(pending) && pending.length) return { status: 'queued', constraint: { reason: 'input-pending' } };
    const expires = record.deadline == null ? null
      : (typeof record.deadline === 'object' ? record.deadline.expires_at : record.deadline);
    const expiryMs = typeof expires === 'number' ? expires : Date.parse(expires);
    if (Number.isFinite(expiryMs) && now() > expiryMs) return block(entry, 'deadline-expired', null);

    const stageAttempt = (Number.isInteger(repair.stage_attempt) ? repair.stage_attempt : 0) + 1;
    const packet = action.packet ?? null;
    const round = action.round ?? 1;
    const subject = subjectOf(repair);
    const label = action.label ?? review.stageLabel(entry.waveId, subject, round);
    const candidateHead = record.target?.candidate_commit ?? null;
    const base = phase === 'integration-fix' ? candidateHead : (action.base ?? candidateHead);
    const head = phase === 'integration-fix' ? candidateHead : (action.head ?? candidateHead);
    const expectedIds = phase === 'integration-confirm'
      ? (round === 1 ? [] : actionableFindingIds(state))
      : phase === 'integration-fix' ? [...(packet?.ids ?? []), ...(packet?.pending_after ?? [])]
        : [];

    patchRecord(entry.recordPath, entry.session, draft => {
      if (draft.target?.repair) draft.target.repair = { ...draft.target.repair, phase, stage_attempt: stageAttempt };
      draft.effects = draft.effects ?? {};
      draft.effects[`${entry.waveId}:${repair.attempt_id}:${phase}:${stageAttempt}`] = {
        kind: phase,
        assignment_id: `${entry.waveId}:candidate:${repair.n}:${phase}:${stageAttempt}`,
        intent_at: at(),
        outcome: null
      };
    });

    try {
      await runtime.remountWaveMember(stageIdentity(entry, record, repair, phase));
      const reservation = await ownership.reserveCapacity({
        packageId: record.package_ref ?? entry.waveId,
        attempt: `${entry.waveId}:${repair.attempt_id}:${phase}`,
        request: capacityRequest(record),
        coordinator: coordinatorIdentity(record)
      });
      if (reservation?.status === 'queued') return { status: 'queued', constraint: reservation.constraint ?? null };
      if (reservation?.status !== 'reserved') {
        return block(entry, 'launch-failed', `capacity reservation was not confirmed (${reservation?.status ?? 'unknown'})`);
      }
      await runtime.startStage({
        package: entry.packagePath,
        step: cardPathOf(record, repair.step),
        step_number: repair.step,
        wave_id: entry.waveId,
        expected_generation: record.generation,
        claim_token: record.claim_token,
        coordinator_epoch: record.coordinator?.epoch ?? null,
        candidate: repair.n,
        subject,
        attempt_id: repair.attempt_id,
        implementation_run_id: repair.implementation_run_id,
        stage_attempt: stageAttempt,
        owner_model: record.models?.owner_model,
        editor_model: record.models?.editor_model,
        review_model: record.models?.review_model,
        fix_model_override: record.models?.fix_model_override,
        phase,
        stage: {
          label, round, base, head,
          ...(packet ? { packet } : {}),
          expected_ids: expectedIds
        }
      });
      return { status: 'advanced' };
    } catch (error) {
      return block(entry, error?.code ?? 'launch-failed', error?.message ?? null);
    }
  }

  // Drive an already-bound candidate repair. Returns:
  //   advanced    — durable progress was made; the barrier should re-drive
  //   progressing — a stage/owner run is still live (or nothing to do yet)
  //   blocked     — a terminal refusal was recorded
  async function drive(entry) {
    if (!entry || typeof entry !== 'object') return { status: 'idle' };
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      let record;
      try { record = readRecord(entry); } catch { return { status: 'unreadable' }; }
      if (!record || record.wave_id !== entry.waveId) return { status: 'foreign' };
      if (record.state === 'integrated' || record.state === 'cancelled') return { status: record.state };
      const repair = record.target?.repair;
      if (!repair) return { status: 'progressing' };
      if (repair.recovery_blocking_reason) {
        return { status: 'blocked', reason: repair.recovery_blocking_reason };
      }

      // A candidate owner run may have produced its durable effect before its
      // outcome record was journaled, leaving `run_id` bound but
      // `implementation_run_id` unset. Reconcile from the durable owner run at
      // the binding boundary; only an exact owner binding may be adopted, and
      // only for the integration-repair phase. Anything else refuses before any
      // write or launch. A repair with no owner run id at all is unlaunched
      // intent and stays progressing.
      if (!repair.implementation_run_id) {
        if (!repair.run_id || repair.phase !== CANDIDATE_PHASE) return { status: 'progressing' };
        const reconciled = reconcileLostOutcome(entry, repair);
        if (reconciled?.status === 'blocked') return reconciled;
        if (reconciled?.runId) {
          patchRecord(entry.recordPath, entry.session, draft => {
            const current = draft.target?.repair;
            if (!current) return;
            const sameIdentity = current.n === repair.n
              && current.attempt_id === repair.attempt_id
              && current.phase === repair.phase
              && current.run_id === repair.run_id;
            if (sameIdentity) current.implementation_run_id = reconciled.runId;
          });
          record = readRecord(entry);
        }
      }
      const boundRunId = record.target?.repair?.implementation_run_id ?? null;
      if (!boundRunId) return { status: 'progressing' };

      let state;
      try {
        state = await review.readReviewState({
          packageDir: entry.packagePath,
          waveId: entry.waveId,
          step: cardPathOf(record, repair.step),
          subject: subjectOf(repair),
          member: repair,
          implementationRunId: boundRunId,
          ownership
        });
      } catch (error) {
        return block(entry, error?.code ?? 'review-state-failed', error?.message ?? null);
      }
      const action = review.nextReviewAction(state);
      if (!action || action.action === 'wait') return { status: 'progressing' };
      if (action.action === 'block' || action.action === 'not-eligible')
        return block(entry, action.reason ?? action.action, null);

      if (action.action === 'accept-repair') {
        const attempt = acceptedAttempt(state, action.head);
        let accepted;
        try {
          accepted = await integration.acceptIntegrationRepair(context(entry), {
            head: action.head,
            review: { verdict: attempt?.receipt?.payload?.verdict, head: action.head, artifact: attempt?.artifact?.path ?? null }
          });
        } catch (error) {
          return block(entry, error?.code ?? 'repair-invalid', error?.message ?? null);
        }
        if (accepted.status === 'queued') return { status: 'queued', constraint: accepted.constraint ?? null };
        if (accepted.status !== 'accepted') return block(entry, accepted.reason ?? 'repair-invalid', null);
        // Retain the accepted candidate identity (its `n` is the durable repair
        // number) but mark its phase terminal so neither this driver nor the
        // barrier re-drives it; the barrier resumes assembly on the imported head.
        patchRecord(entry.recordPath, entry.session, draft => {
          draft.target = draft.target ?? {};
          if (draft.target.repair) draft.target.repair = { ...draft.target.repair, phase: 'accepted', run_id: null };
          if (draft.state === 'repairing') {
            draft.state = 'integrating';
            draft.transitions = Array.isArray(draft.transitions) ? draft.transitions : [];
            draft.transitions.push({ state: 'integrating', at: at(), reason: 'repair-accepted' });
          }
        });
        return { status: 'advanced' };
      }

      if (action.action === 'run-gates') {
        let result;
        try {
          result = await review.runStageGates({
            runtime, ownership,
            identity: stageIdentity(entry, record, repair, repair.phase),
            record: loadRun(entry.packagePath, action.run_id ?? repair.implementation_run_id),
            gates: state.gates ?? [],
            head: action.head ?? null
          });
        } catch (error) {
          return block(entry, error?.code ?? 'gate-failed', error?.message ?? null);
        }
        if (result?.state === 'queued') return { status: 'queued', constraint: result.constraint ?? null };
        continue;
      }

      const phase = PHASE_FOR_ACTION[action.action];
      if (!phase) return { status: 'progressing' };
      const launched = await launch(entry, record, repair, state, action, phase);
      if (launched?.status === 'advanced') continue;
      return launched;
    }
    return block(entry, 'progression-unbounded', null);
  }

  return { begin, drive };
}
