// Capacity-driven queued-member admission, split out of `waves.mjs` at the
// admission boundary. The controller owns the durable record and the FIFO; this
// module owns the bounded, ascending, re-read admission cycle: it admits only
// members that are still `queued` in the current record, reserves setup capacity
// and prepares their workspace (once), reserves implementing capacity, then
// writes all implementing intents before starting the launches. Setup capacity
// is released by Runtime during preparation, so each admission slot counts the
// capacity claims currently persisted on the package plus the entries this pass
// admitted whose implementing reservation is not written yet.
const SCHEDULING_STATES = new Set(['open', 'running']);

function timestamp(ms = Date.now()) { return new Date(ms).toISOString(); }

// The member attempt id convention is shared with the controller's initial
// record construction, so it lives here and is imported by `waves.mjs`.
export function attemptIdFor(step, attempt) {
  return `s${String(step).padStart(3, '0')}-a${attempt}`;
}

function provisioningAttempt({ wave_id, attemptId }) { return `${wave_id}:${attemptId}:setup`; }
function implementingAttempt({ wave_id, attemptId }) { return `${wave_id}:${attemptId}:implementing`; }

function bindingQueueReason(binding) {
  if (binding === 'memory') return 'memory-budget';
  if (binding === 'tasks') return 'task-budget';
  return 'software-ceiling';
}

function deadlineMs(deadline) {
  if (deadline == null) return null;
  const value = typeof deadline === 'object' ? deadline.expires_at : deadline;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createMemberAdmission(deps = {}) {
  const { runtime, ownership, integration, patchRecord, nowMs, assignmentId, pendingInbox } = deps;
  const now = () => (typeof nowMs === 'function' ? nowMs() : Date.now());

  // Queue a member with an explicit reason. The mutation re-reads the current
  // record through `patchRecord`, so a same-reason re-queue is a no-op.
  function setQueued(recordPath, session, step, reason, at) {
    patchRecord(recordPath, session, draft => {
      const member = draft.members?.[String(step)];
      if (!member) return;
      if (member.phase === 'queued' && member.queue_reason === reason) return;
      member.phase = 'queued';
      member.queue_reason = reason;
      member.transitions.push({ phase: 'queued', at: at ?? timestamp(now()), reason });
    });
  }

  function currentRecord(context) {
    try { return integration.readWaveRecord(context.recordPath); } catch { return null; }
  }

  // Fresh guard re-read: only the owning generation/session/claim may admit, the
  // wave must still be scheduling, its deadline must not have expired and the
  // package must have no pending inbox direction. Any unknown refuses admission.
  function guardsHold(context, record) {
    if (!record || record.generation !== 1) return false;
    if (record.coordinator?.session !== context.session) return false;
    if (record.claim_token !== context.claimToken) return false;
    if (context.epoch != null && String(record.coordinator?.epoch) !== String(context.epoch)) return false;
    if (!SCHEDULING_STATES.has(record.state)) return false;
    if (record.cancel_requested || record.interrupted) return false;
    const deadline = deadlineMs(record.deadline);
    if (deadline !== null && deadline <= now()) return false;
    try {
      if (pendingInbox(context.packagePath ?? record.package).length) return false;
    } catch {
      return false;
    }
    return true;
  }

  // Count every persisted capacity claim for the package. Package and checkout
  // claims are not lifecycles; dead/unknown liveness still holds its slot, so
  // liveness is never used to release capacity here (INV-2).
  async function capacityClaimCount(packageRef) {
    const claims = await ownership.inspectClaims({ packageId: packageRef });
    const entries = Array.isArray(claims?.claims) ? claims.claims : [];
    return entries.filter(claim => claim && claim.kind === 'capacity').length;
  }

  async function admit(context) {
    const record = currentRecord(context);
    if (!guardsHold(context, record)) return;

    const explicitCap = Number.isInteger(context.input?.max_parallel) ? context.input.max_parallel : null;
    const admittedWidth = Number.isInteger(context.admission?.admittedWidth) ? context.admission.admittedWidth : null;
    if (admittedWidth === null) return;
    const bound = explicitCap === null ? admittedWidth : Math.min(explicitCap, admittedWidth);

    const steps = (record.steps ?? []).map(Number).sort((a, b) => a - b);
    // A queued member that already has an implementation_run_id has completed
    // implementation and owns its later review/gate/seal phases through the
    // member-event progression; admission must not relaunch implementation.
    const queued = steps.filter(step => {
      const member = record.members?.[String(step)];
      return member?.phase === 'queued' && !member.implementation_run_id;
    });

    // First pass: setup reservation and preparation for members not already
    // provisioned. The package's persisted capacity claims are counted fresh
    // before every slot so an explicit cap queues once that many are already
    // claimed, on top of the admitted-width bound. Entries this pass admitted
    // hold their slot but have no implementing claim yet, so they are counted
    // via `admitted.length`; setup capacity is released by Runtime during
    // preparation and is never double-counted. A refused reservation leaves the
    // member queued with the constraint reason.
    const admitted = [];
    for (const step of queued) {
      let live;
      try {
        live = await capacityClaimCount(context.packageRef);
      } catch {
        // Unknown capacity is not zero: admit nothing further this pass.
        break;
      }
      if (live + admitted.length >= bound) {
        const reason = explicitCap !== null && live + admitted.length >= explicitCap
          ? 'explicit-cap'
          : bindingQueueReason(context.admission?.binding);
        // Capacity is exhausted for this pass: the earliest still-queued
        // member and every later queued member must stay queued with this
        // constraint reason. Stop the pass so a later step can never overtake
        // an earlier blocked step (FIFO admission order).
        const blockedIndex = queued.indexOf(step);
        for (const later of queued.slice(blockedIndex)) {
          const laterMember = currentRecord(context).members?.[String(later)];
          if (laterMember?.phase !== 'queued' || laterMember.implementation_run_id) continue;
          setQueued(context.recordPath, context.session, later, reason);
        }
        break;
      }
      // Re-read the fresh guards before the next reservation/preparation.
      const fresh = currentRecord(context);
      if (!guardsHold(context, fresh)) return;
      const member = fresh.members?.[String(step)];
      if (!member || member.phase !== 'queued') continue;
      const attempt = member.attempt ?? 1;
      const attemptId = member.attempt_id ?? attemptIdFor(step, attempt);
      // A member that already has its workspace/preparation receipt is not
      // re-prepared; it goes straight to the implementing reservation.
      const prepared = member.preparation_receipt != null || member.workspace != null;

      if (!prepared) {
        const setup = await ownership.reserveCapacity({
          packageId: context.packageRef,
          attempt: provisioningAttempt({ wave_id: context.wave_id, attemptId }),
          request: { memoryBytes: context.policy.lifecycleMemoryBytes, tasks: context.policy.lifecycleTasks },
          coordinator: context.coordinator
        });
        if (setup.status !== 'reserved') {
          setQueued(context.recordPath, context.session, step, setup.constraint?.reason ?? 'queued');
          continue;
        }
        patchRecord(context.recordPath, context.session, draft => {
          const target = draft.members[String(step)];
          target.phase = 'provisioning';
          target.transitions.push({ phase: 'provisioning', at: timestamp(now()), reason: null });
          draft.effects[`${context.wave_id}:${attemptId}:provisioning`] = {
            kind: 'provisioning', assignment_id: null, intent_at: timestamp(now()), outcome: null
          };
        });
        try {
          await runtime.prepareWaveMember({
            package: context.packagePath,
            step: context.cardPaths.get(step),
            wave_id: context.wave_id,
            expected_generation: 1,
            step_number: step,
            attempt_id: attemptId,
            phase: 'provisioning',
            claim_token: context.claimToken,
            coordinator_epoch: context.epoch
          });
          patchRecord(context.recordPath, context.session, draft => {
            draft.effects[`${context.wave_id}:${attemptId}:provisioning`] = {
              ...(draft.effects[`${context.wave_id}:${attemptId}:provisioning`] ?? { kind: 'provisioning', assignment_id: null }),
              outcome: 'prepared',
              observed_at: timestamp(now())
            };
          });
        } catch (error) {
          // Runtime preparation errors retain their details and block only the
          // implicated member; the rest of the wave keeps admitting.
          const reason = error?.reason || error?.code || 'preparation-failed';
          patchRecord(context.recordPath, context.session, draft => {
            const target = draft.members[String(step)];
            target.phase = 'blocked';
            target.blocking_reason = reason;
            target.blocking_detail = { code: error?.code ?? null, reason: error?.reason ?? null, message: error?.message ?? null };
            target.transitions.push({ phase: 'blocked', at: timestamp(now()), reason });
            draft.effects[`${context.wave_id}:${attemptId}:provisioning`] = {
              ...(draft.effects[`${context.wave_id}:${attemptId}:provisioning`] ?? { kind: 'provisioning', assignment_id: null }),
              outcome: 'refused',
              observed_at: timestamp(now()),
              code: error?.code ?? null,
              reason: error?.reason ?? null,
              message: error?.message ?? null
            };
          });
          continue;
        }
      }
      admitted.push({ step, attempt, attemptId, ownerModel: member.owner_model ?? null });
    }

    if (!admitted.length) return;
    if (!guardsHold(context, currentRecord(context))) return;

    // Second pass: reserve implementing capacity for each admitted member; the
    // remainder stays queued with the budget/admission reason. Ownership enforces
    // the aggregate limits, so every reservation here is a real launch slot.
    const launched = [];
    for (const entry of admitted) {
      const reserved = await ownership.reserveCapacity({
        packageId: context.packageRef,
        attempt: implementingAttempt({ wave_id: context.wave_id, attemptId: entry.attemptId }),
        request: { memoryBytes: context.policy.lifecycleMemoryBytes, tasks: context.policy.lifecycleTasks },
        coordinator: context.coordinator
      });
      if (reserved.status === 'reserved') launched.push(entry);
      else setQueued(context.recordPath, context.session, entry.step, reserved.constraint?.reason ?? bindingQueueReason(context.admission?.binding));
    }
    if (!launched.length) return;

    const assignmentFor = entry => assignmentId({ wave_id: context.wave_id, step: entry.step, phase: 'implementing', attempt: entry.attempt });
    // All implementing intents are written together with their assignment ids,
    // so the record and the launch contract agree before Runtime.start runs.
    patchRecord(context.recordPath, context.session, draft => {
      for (const entry of launched) {
        const member = draft.members[String(entry.step)];
        member.phase = 'implementing';
        member.queue_reason = null;
        member.transitions.push({ phase: 'implementing', at: timestamp(now()), reason: null });
        draft.effects[`${context.wave_id}:${entry.attemptId}:implementing`] = {
          kind: 'implementing', assignment_id: assignmentFor(entry), intent_at: timestamp(now()), outcome: null
        };
      }
    });

    // Launch every admitted implementer, then record all outcomes in one write.
    // The guards are re-read immediately before each launch so a session, claim,
    // deadline or inbox change under this controller drops the launch rather
    // than starting into a wave it no longer owns.
    const starts = launched.map(entry => {
      if (!guardsHold(context, currentRecord(context))) return Promise.resolve({ __skipped: 'guard-changed' });
      return runtime.start({
        package: context.packagePath,
        step: context.cardPaths.get(entry.step),
        target: context.targetId,
        wave_id: context.wave_id,
        expected_generation: 1,
        step_number: entry.step,
        attempt_id: entry.attemptId,
        phase: 'implementing',
        claim_token: context.claimToken,
        coordinator_epoch: context.epoch,
        assignment_id: assignmentFor(entry),
        workflow_id: context.input.workflow_id,
        isolation: context.input.isolation,
        owner_model: entry.ownerModel,
        strong_owner_model: context.input.strong_owner_model,
        editor_model: context.input.editor_model,
        review_model: context.input.review_model,
        fix_model_override: context.input.fix_model_override,
        scout_model: context.input.scout_model,
        child_extensions: context.input.child_extensions,
        instructions: context.input.instructions
      }, context.parentSession);
    });
    const settled = await Promise.allSettled(starts);

    patchRecord(context.recordPath, context.session, draft => {
      settled.forEach((result, index) => {
        const entry = launched[index];
        const member = draft.members[String(entry.step)];
        const effectKey = `${context.wave_id}:${entry.attemptId}:implementing`;
        if (result.status === 'fulfilled' && result.value?.__skipped) return;
        if (result.status === 'fulfilled') {
          const summary = result.value ?? {};
          // member.run_id stays Runtime-owned; only the implementation run is
          // recorded by the controller.
          if (typeof summary.run_id === 'string' && summary.run_id.length > 0) member.implementation_run_id = summary.run_id;
          draft.effects[effectKey] = { ...(draft.effects[effectKey] ?? { kind: 'implementing', assignment_id: assignmentFor(entry) }), outcome: 'launched', observed_at: timestamp(now()) };
        } else {
          const reason = result.reason?.code ?? 'launch-failed';
          member.phase = 'blocked';
          member.blocking_reason = reason;
          member.blocking_detail = { code: result.reason?.code ?? null, message: result.reason?.message ?? null };
          member.transitions.push({ phase: 'blocked', at: timestamp(now()), reason });
          draft.effects[effectKey] = { ...(draft.effects[effectKey] ?? { kind: 'implementing', assignment_id: assignmentFor(entry) }), outcome: 'refused', observed_at: timestamp(now()), reason };
        }
      });
      const started = settled.some((result, index) => result.status === 'fulfilled' && !result.value?.__skipped && launched[index] != null);
      if (started) {
        draft.state = 'running';
        if (!draft.transitions.some(transition => transition.state === 'running')) draft.transitions.push({ state: 'running', at: timestamp(now()) });
      }
    });
  }

  return { admit };
}
