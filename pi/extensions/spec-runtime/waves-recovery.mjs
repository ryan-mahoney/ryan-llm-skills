// Wave recovery (step 10). This module owns the recovery boundary: given a
// located wave it inspects the stored coordinator process identity and
// classifies the wave as still owned by this live coordinator, unknowable, or
// owned by a positively dead coordinator. Liveness is only positive when the
// observed PID matches the stored owner exactly; a reused or mismatched PID is
// unknown and never authorizes adoption.
//
// Adoption reuses the existing Runtime remount/drain/claim APIs: it rebinds the
// package's held claims to the replacement coordinator without changing tokens or
// epochs, changes only the record's coordinator session/process identity, and
// then, per retained implementing member, positively drains the contained phase
// before remounting the retained workspace and launching exactly one replacement
// run under a `/resume:N` assignment. Other phase continuations stay explicitly
// not-implemented: they are blocked with a named reason rather than fabricated.
// Serialization stays with the controller, which wraps the returned `recover` in
// its own FIFO.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectProcess } from '../../../scripts/spec-observe/process-identity.mjs';
import { createCandidateRetainedRecovery } from './waves-candidate-retained.mjs';

// The durable record stores the coordinator process evidence nested under
// `process_identity`; a malformed or absent pair is never trusted.
function storedProcessIdentity(record) {
  const identity = record?.coordinator?.process_identity;
  if (!identity || typeof identity !== 'object') return null;
  const { pid, started_at } = identity;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof started_at !== 'string' || started_at.length === 0) return null;
  return { pid, started_at };
}

function cardPathFor(index, packagePath, step) {
  const row = (index?.steps ?? []).find(entry => Number(entry.step) === Number(step));
  const relative = row?.path ?? `step-${String(Number(step)).padStart(3, '0')}-subspec.md`;
  return join(packagePath, relative);
}

export function createWaveRecovery(deps = {}) {
  const {
    locateControl, coordinator, waveReceipt, invalid, notImplemented,
    inspect = inspectProcess, ownership, runtime, integration, lifecycle,
    loadRun, patchRecord, loadedWaves, prepare, nowMs, pendingInbox,
    assignmentId, driveAndContinue, attentionKey, send
  } = deps;

  const deliver = typeof send === 'function' ? send : () => ({ delivered: false });

  // Candidate retained recovery shares the durable drain predicate with member
  // recovery, so the module is constructed with the same seam.
  const candidateRecovery = createCandidateRetainedRecovery({
    runtime,
    ownership,
    lifecycle,
    loadRun,
    patchRecord: (recordPath, session, mutator) => patchRecord(recordPath, session, mutator),
    durableConfirmedDrain,
    nowMs
  });

  const now = () => (typeof nowMs === 'function' ? nowMs() : Date.now());
  const timestamp = ms => new Date(ms).toISOString();

  // A drain is durable only when the run record carries a confirmed receipt and
  // the receipt file it names is itself readable and confirmed.
  function durableConfirmedDrain(run) {
    const drain = run?.phase_drain;
    if (!drain || drain.status !== 'confirmed' || typeof drain.path !== 'string' || !drain.path) return false;
    try {
      const receipt = JSON.parse(readFileSync(drain.path, 'utf8'));
      return receipt?.status === 'confirmed';
    } catch {
      return false;
    }
  }

  function deadlineValue(deadline) {
    if (deadline === undefined || deadline === null) return null;
    const value = typeof deadline === 'object' ? deadline.expires_at : deadline;
    if (typeof value === 'number') return value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // Block a member once per retained attempt. The phase/reason transition is
  // persisted only when it actually changes, and the matching `member-blocked`
  // attention is durable-deduped: the key is written before delivery and the
  // trigger turn is sent only for the first observation. Repeated unknown/live
  // rechecks therefore neither rewrite the record nor send again.
  function blockMember(recordPath, session, key, reason, waveId) {
    const step = Number(key);
    let changed = false;
    let attempt = null;
    patchRecord(recordPath, session, draft => {
      const target = draft?.members?.[key];
      if (!target) return;
      attempt = target.attempt_id ?? null;
      if (target.phase !== 'blocked' || target.blocking_reason !== reason) {
        target.phase = 'blocked';
        target.blocking_reason = reason;
        target.transitions = Array.isArray(target.transitions) ? target.transitions : [];
        target.transitions.push({ phase: 'blocked', at: timestamp(now()), reason });
        changed = true;
      }
    });

    if (typeof attentionKey !== 'function' || waveId == null) return;
    const transition = `a${attempt ?? ''}`;
    const dedupKey = attentionKey({ wave_id: waveId, kind: 'member-blocked', step, transition });
    let first = false;
    patchRecord(recordPath, session, draft => {
      draft.attention = draft.attention ?? {};
      if (draft.attention[dedupKey]) return;
      draft.attention[dedupKey] = { emitted_at: timestamp(now()) };
      first = true;
    });
    if (!first) return;
    const record = (() => {
      try { return JSON.parse(readFileSync(recordPath, 'utf8')); } catch { return null; }
    })();
    deliver({
      customType: 'spec-wave',
      content: JSON.stringify({
        kind: 'member-blocked', wave_id: waveId, step,
        state: record?.state ?? null, reason, transition, record_path: recordPath
      }),
      display: true
    }, { triggerTurn: true });
    void changed;
  }

  // Rebuild the loaded entry the controller and admission rely on. A prior entry
  // (same process reopened) is reused verbatim except for the coordinator session
  // and admission coordinator/session, which move to the replacement coordinator;
  // the context epoch stays the claim-creation epoch on the record. With no prior
  // entry the entry is rebuilt from the frozen prepared inputs and the persisted
  // models/isolation/limits/target.
  function rehydrateEntry({ record, recordPath, packageDir, prepared, wave_id, own }) {
    const prior = loadedWaves.get(wave_id) ?? null;
    const openContext = prior?.openContext ?? {
      input: {
        package: packageDir,
        workflow_id: record.workflow_id ?? null,
        execution: 'waves',
        isolation: record.isolation_requested ?? null,
        owner_model: record.models?.owner_model ?? null,
        strong_owner_model: record.models?.strong_owner_model ?? null,
        editor_model: record.models?.editor_model ?? null,
        review_model: record.models?.review_model ?? null,
        fix_model_override: record.models?.fix_model_override ?? null,
        scout_model: record.models?.scout_model ?? null,
        child_extensions: record.models?.child_extensions ?? [],
        instructions: record.instructions ?? null
      },
      parentSession: null,
      packagePath: packageDir,
      packageRef: record.package_ref,
      locations: prepared?.locations ?? null,
      index: prepared?.index ?? null,
      validation: prepared?.validation ?? null,
      index_sha256: prepared?.index_sha256 ?? record.inputs?.index_sha256 ?? null,
      evidence_plan_sha256: prepared?.evidence_plan_sha256 ?? record.inputs?.evidence_plan_sha256 ?? null
    };

    const cardPaths = prior?.admission?.cardPaths
      ?? new Map((prepared?.index?.steps ?? []).map(row => [
        Number(row.step),
        join(packageDir, row.path ?? `step-${String(Number(row.step)).padStart(3, '0')}-subspec.md`)
      ]));

    const admission = {
      ...(prior?.admission ?? {}),
      recordPath,
      session: own.session,
      parentSession: prior?.admission?.parentSession ?? null,
      packagePath: packageDir,
      packageRef: record.package_ref,
      wave_id,
      cardPaths,
      input: prior?.admission?.input ?? openContext.input,
      policy: prior?.admission?.policy ?? {
        lifecycleMemoryBytes: record.effective_limits?.memory?.per_lifecycle_bytes ?? null,
        lifecycleTasks: record.effective_limits?.tasks?.per_lifecycle ?? null
      },
      admission: prior?.admission?.admission ?? {
        admittedWidth: record.admitted_width ?? null,
        binding: record.effective_limits?.binding ?? null
      },
      coordinator: own,
      targetId: prior?.admission?.targetId ?? record.target?.id ?? null,
      claimToken: record.claim_token,
      epoch: record.coordinator?.epoch
    };

    return { waveId: wave_id, recordPath, packagePath: packageDir, session: own.session, admission, openContext };
  }

  // Drain the retained implementing run behind a positive classification:
  // `populated` is stopped then cancelled; `confirmed` needs at most a plain
  // drain when no durable receipt exists; `unknown` or `live` blocks and never
  // signals, remounts or launches.
  async function drainRetainedRun({ packageDir, recordPath, own, key, runId, run, classification, wave_id }) {
    const status = classification?.status;

    if (status === 'unknown' || status === 'live') {
      blockMember(recordPath, own.session, key, status === 'live' ? 'liveness-live' : 'liveness-unknown', wave_id);
      return { ok: false };
    }

    if (status === 'populated') {
      const handle = typeof runtime?.active?.get === 'function' ? runtime.active.get(runId) : null;
      if (handle?.record) {
        // This Runtime still owns the handle: cancel it so the run completes
        // through the single contained-service path instead of draining twice.
        await runtime.cancel(packageDir, runId);
      } else {
        const drained = await runtime.drainContainedService(run, { cancel: true });
        if (drained?.status !== 'confirmed') {
          blockMember(recordPath, own.session, key, drained?.reason || drained?.status || 'drain-unconfirmed');
          return { ok: false };
        }
      }
    } else if (status === 'confirmed') {
      if (!durableConfirmedDrain(run)) {
        const drained = await runtime.drainContainedService(run);
        if (drained?.status !== 'confirmed') {
          blockMember(recordPath, own.session, key, drained?.reason || drained?.status || 'drain-unconfirmed');
          return { ok: false };
        }
      }
    } else {
      blockMember(recordPath, own.session, key, 'liveness-unknown');
      return { ok: false };
    }

    // Only a durable confirmed drain permits the remount that follows.
    const durable = (() => {
      try { return loadRun(packageDir, runId); }
      catch { return run; }
    })();
    if (!durableConfirmedDrain(durable)) {
      blockMember(recordPath, own.session, key, 'drain-unconfirmed');
      return { ok: false };
    }
    return { ok: true };
  }

  // Resume one retained member: restore the retained phase when an interrupted
  // bookkeeping moved it, remount the retained workspace under the exact
  // package/wave/generation/step/attempt/phase/token/epoch, reserve the phase
  // capacity slot, persist the resume intent, and launch exactly one replacement
  // run. The implementation phase keeps its original `runtime.start` binding;
  // reviewing/fixing/confirming continue through `runtime.startStage` with the
  // retained stage metadata and models.
  async function resumeMember({ key, record, recordPath, packageDir, wave_id, entry, own }) {
    const member = record.members?.[key];
    if (!member) return 'absent';

    const CONTINUABLE = ['implementing', 'reviewing', 'fixing', 'confirming'];
    let continuation = CONTINUABLE.includes(member.phase) ? member.phase : null;
    if (!continuation && member.phase === 'blocked') {
      // A blocked member is recoverable only when its retained run is itself
      // bound to a continuable phase and the block is an unresolved liveness
      // observation. The current member run binding governs a stage block; only
      // an implementation run may fall back to `implementation_run_id`.
      const blockedReason = member.blocking_reason;
      const livenessBlock = blockedReason === 'liveness-unknown' || blockedReason === 'liveness-live';
      if (livenessBlock) {
        const retainedId = member.run_id
          ?? (typeof member.implementation_run_id === 'string' ? member.implementation_run_id : null);
        if (typeof retainedId === 'string' && retainedId.length > 0) {
          try {
            const boundPhase = loadRun(packageDir, retainedId)?.wave_bindings?.phase;
            continuation = CONTINUABLE.includes(boundPhase) ? boundPhase : null;
            if (continuation !== 'implementing') {
              // A fallback to the implementation run only ever continues the
              // implementation phase; a stage binding must come from run_id.
              continuation = retainedId === member.run_id && continuation ? continuation : null;
            }
          } catch {
            continuation = null;
          }
        }
      }
    }

    if (!continuation) {
      const terminalOrQueued = member.phase === 'queued' || member.phase === 'provisioning'
        || member.phase === 'sealed' || member.phase === 'integrated' || member.phase === 'cancelled';
      if (member.implementation_run_id == null || terminalOrQueued) return 'skipped';
      // A post-implementation phase has no tested recovery continuation. Block
      // it with an explicit not-implemented reason rather than fabricate one.
      if (member.phase !== 'blocked') {
        blockMember(recordPath, own.session, key, notImplemented(`dead-owner-phase-continuation:${member.phase}`).code, wave_id);
      }
      return 'blocked';
    }

    const phase = continuation;
    const isStage = phase !== 'implementing';
    // A stage continuation resumes the current member run; the implementation
    // phase resumes its original implementation_run_id when one was recorded.
    const runId = isStage
      ? member.run_id
      : (member.implementation_run_id ?? member.run_id);
    if (typeof runId !== 'string' || runId.length === 0) return 'skipped';

    let run;
    try { run = loadRun(packageDir, runId); }
    catch (error) {
      blockMember(recordPath, own.session, key, 'run-unreadable');
      return 'blocked';
    }

    // Before any drain, the loaded run must be bound to this exact member and
    // phase. A stage additionally requires its stage metadata and a positive
    // member stage_attempt. An invalid binding blocks with no effects.
    const bindings = run?.wave_bindings ?? null;
    const bindingValid = bindings && bindings.wave_id === wave_id
      && Number(bindings.step_number) === Number(key)
      && bindings.attempt_id === member.attempt_id
      && bindings.phase === phase
      && Number(bindings.generation) === Number(record.generation)
      && bindings.claim_token === record.claim_token
      && String(bindings.coordinator_epoch ?? '') === String(record.coordinator?.epoch ?? '')
      && bindings.package_ref === (record.package_ref ?? wave_id);
    const stageValid = !isStage
      || (run.stage && typeof run.stage === 'object' && !Array.isArray(run.stage)
        && Number.isInteger(member.stage_attempt) && member.stage_attempt >= 1);
    if (!bindingValid || !stageValid) {
      blockMember(recordPath, own.session, key, 'stage-binding-invalid', wave_id);
      return 'blocked';
    }

    const classification = lifecycle && typeof lifecycle.inspect === 'function'
      ? await lifecycle.inspect(run, { ownershipVerified: true })
      : { status: 'unknown', reason: 'liveness-unknown' };
    const drained = await drainRetainedRun({ packageDir, recordPath, own, key, runId, run, classification, wave_id });
    if (!drained.ok) return 'blocked';

    // Restore the retained phase if an interrupted bookkeeping or a resolved
    // liveness block left it elsewhere; the retained run id and workspace are
    // untouched and the block reason is cleared on resume.
    if (member.phase !== phase) {
      patchRecord(recordPath, own.session, draft => {
        const target = draft.members[key];
        target.phase = phase;
        target.blocking_reason = null;
        target.blocking_detail = null;
        target.queue_reason = null;
        target.transitions = Array.isArray(target.transitions) ? target.transitions : [];
        target.transitions.push({ phase, at: timestamp(now()), reason: 'recovery-resume' });
      });
    }

    const step = Number(key);
    const cardPath = entry?.admission?.cardPaths?.get?.(step) ?? cardPathFor(entry?.openContext?.index, packageDir, step);

    try {
      await runtime.remountWaveMember({
        package: packageDir,
        step: cardPath,
        wave_id,
        expected_generation: record.generation,
        step_number: step,
        attempt_id: member.attempt_id,
        phase,
        claim_token: record.claim_token,
        coordinator_epoch: record.coordinator?.epoch
      });
    } catch (error) {
      blockMember(recordPath, own.session, key, error?.code || 'remount-failed');
      return 'blocked';
    }

    const limits = record.effective_limits ?? {};
    let reserved;
    try {
      reserved = await ownership.reserveCapacity({
        packageId: record.package_ref,
        attempt: `${wave_id}:${member.attempt_id}:${phase}`,
        request: {
          memoryBytes: limits.memory?.per_lifecycle_bytes ?? null,
          tasks: limits.tasks?.per_lifecycle ?? null
        },
        coordinator: own
      });
    } catch (error) {
      blockMember(recordPath, own.session, key, 'capacity-error');
      return 'blocked';
    }
    if (reserved?.status !== 'reserved') {
      blockMember(recordPath, own.session, key, reserved?.constraint?.reason || reserved?.status || 'capacity-unavailable');
      return 'blocked';
    }

    const resume = (Number.isInteger(member.resume) ? member.resume : 0) + 1;
    const attempt = isStage ? member.stage_attempt : (member.attempt ?? 1);
    const packetIndex = isStage ? run.stage?.packet?.index : undefined;
    const assignment = assignmentId({
      wave_id, step, phase, attempt,
      ...(packetIndex !== undefined && packetIndex !== null ? { packet: packetIndex } : {}),
      resume
    });
    const effectKey = isStage
      ? `${wave_id}:${member.attempt_id}:${phase}:${member.stage_attempt}`
      : `${wave_id}:${member.attempt_id}:implementing`;
    const contextInput = entry?.openContext?.input ?? {};

    // Persist the resume intent and its canonical assignment id BEFORE the launch,
    // so a crash between intent and launch can never consume a second slot.
    patchRecord(recordPath, own.session, draft => {
      const target = draft.members[key];
      target.phase = phase;
      target.queue_reason = null;
      target.resume = resume;
      target.transitions = Array.isArray(target.transitions) ? target.transitions : [];
      target.transitions.push({ phase, at: timestamp(now()), reason: 'recovery-resume' });
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
            wave_id,
            expected_generation: record.generation,
            step_number: step,
            attempt_id: member.attempt_id,
            phase,
            claim_token: record.claim_token,
            coordinator_epoch: record.coordinator?.epoch,
            implementation_run_id: member.implementation_run_id,
            stage_attempt: member.stage_attempt,
            resume,
            stage: run.stage,
            review_model: record.models?.review_model,
            fix_model_override: record.models?.fix_model_override,
            editor_model: record.models?.editor_model
          })
        : await runtime.start({
            package: packageDir,
            step: cardPath,
            target: record.target?.id ?? entry?.admission?.targetId ?? null,
            wave_id,
            expected_generation: record.generation,
            step_number: step,
            attempt_id: member.attempt_id,
            phase: 'implementing',
            claim_token: record.claim_token,
            coordinator_epoch: record.coordinator?.epoch,
            assignment_id: assignment,
            workflow_id: contextInput.workflow_id ?? record.workflow_id,
            isolation: contextInput.isolation ?? record.isolation_requested,
            owner_model: member.owner_model ?? contextInput.owner_model ?? null,
            strong_owner_model: contextInput.strong_owner_model ?? null,
            editor_model: contextInput.editor_model ?? null,
            review_model: contextInput.review_model ?? null,
            fix_model_override: contextInput.fix_model_override ?? null,
            scout_model: contextInput.scout_model ?? null,
            child_extensions: contextInput.child_extensions ?? [],
            instructions: contextInput.instructions ?? null
          }, entry?.admission?.parentSession ?? entry?.openContext?.parentSession ?? null);
    } catch (error) {
      patchRecord(recordPath, own.session, draft => {
        const target = draft.members[key];
        target.phase = 'blocked';
        target.blocking_reason = error?.code || 'resume-launch-failed';
        target.transitions = Array.isArray(target.transitions) ? target.transitions : [];
        target.transitions.push({ phase: 'blocked', at: timestamp(now()), reason: target.blocking_reason });
        draft.effects = draft.effects ?? {};
        draft.effects[effectKey] = {
          ...(draft.effects[effectKey] ?? { kind: phase }),
          outcome: 'refused',
          observed_at: timestamp(now()),
          reason: target.blocking_reason
        };
      });
      return 'blocked';
    }

    // Only the implementation phase adopts the launched run as the member's
    // implementation run; Runtime owns a stage member's `run_id`.
    patchRecord(recordPath, own.session, draft => {
      const target = draft.members[key];
      if (!isStage && typeof summary?.run_id === 'string' && summary.run_id.length > 0) {
        target.implementation_run_id = summary.run_id;
      }
      draft.effects = draft.effects ?? {};
      draft.effects[effectKey] = {
        ...(draft.effects[effectKey] ?? { kind: phase }),
        outcome: 'launched',
        observed_at: timestamp(now())
      };
    });
    return 'resumed';
  }

  // Rebuild the loaded entry for a located wave this same-owner controller is
  // allowed to hold, without any durable write, claim rebinding or launch. The
  // stored owner identity and the frozen prepared hashes must match the current
  // observable identity first; a live exact match is required (a dead or
  // mismatched owner is a different controller's wave and never loaded here).
  async function loadOwnedEntry(located) {
    const { packageDir, recordPath, wave_id, record } = located ?? {};
    if (!record || !wave_id) throw invalid('wave-not-loaded', 'loadOwnedEntry requires a located wave record.');

    const stored = storedProcessIdentity(record);
    if (!stored)
      throw invalid('package-owner-unknown', 'Wave record carries no valid coordinator process identity; refusing to load its entry.');

    const own = coordinator ? coordinator() : {};
    if (!own || typeof own.session !== 'string' || own.session.length === 0)
      throw invalid('coordinator-missing', 'loadOwnedEntry requires an observable coordinator identity.');

    // Only a live process whose PID and start time exactly match the stored
    // owner, driven by the same coordinator session, may load the entry.
    let observed;
    try { observed = await inspect(stored.pid); } catch { observed = null; }
    if (!observed || observed.state !== 'alive' || observed.pid !== stored.pid || observed.started_at !== stored.started_at)
      throw invalid('package-owned', `Wave ${wave_id} is not observably owned by this live coordinator; refusing to load its entry.`);
    if (record.coordinator?.session !== own.session || own?.pid !== stored.pid || own?.started_at !== stored.started_at)
      throw invalid('package-owned', `Wave ${wave_id} is owned by a different coordinator identity; refusing to load its entry.`);

    // Frozen inputs must still match the record before the entry is trusted.
    let prepared;
    try {
      prepared = await prepare({ package: record.package ?? packageDir });
    } catch (error) {
      throw invalid('recovery-inputs-unreadable', `Frozen wave inputs could not be re-read: ${error?.message ?? error}`);
    }
    if (!prepared || prepared.state)
      throw invalid('recovery-inputs-changed', 'Frozen wave inputs require intake before the entry can be loaded.');
    const inputsMatch = prepared.index_sha256 === record.inputs?.index_sha256
      && prepared.evidence_plan_sha256 === record.inputs?.evidence_plan_sha256;
    if (!inputsMatch)
      throw invalid('recovery-inputs-changed', 'Frozen index/evidence hashes changed since the wave opened; refusing to load its entry.');

    const entry = rehydrateEntry({ record, recordPath, packageDir, prepared, wave_id, own });
    loadedWaves.set(wave_id, entry);
    return entry;
  }

  // Reconcile a retained member whose controller implementation outcome was
  // lost (a crash after the Runtime launch but before the outcome was recorded).
  // It accepts only a run that is bound to this exact package/wave/generation/
  // step/attempt/token/epoch and whose assignment_id is the persisted one, and
  // only when the member's binding phase is `implementing`. It then absorbs the
  // lost outcome into the record: the existing run id, phase `implementing`,
  // cleared launch block and effect outcome `launched`. It never starts,
  // remounts, drains or releases anything, and never recovers an unsupported
  // stage.
  async function reconcileLaunches(entry) {
    if (!entry?.recordPath || !entry?.waveId) return { outcome: 'no-entry' };
    const wave_id = entry.waveId;
    const packageDir = entry.packagePath;

    let record;
    try { record = JSON.parse(readFileSync(entry.recordPath, 'utf8')); }
    catch { return { outcome: 'unreadable' }; }

    const own = coordinator ? coordinator() : {};
    if (!own || record?.coordinator?.session !== own.session) return { outcome: 'not-owner' };
    if (record?.claim_token !== entry?.admission?.claimToken) return { outcome: 'token-mismatch' };
    if (String(record?.coordinator?.epoch ?? '') !== String(entry?.admission?.epoch ?? '')) return { outcome: 'epoch-mismatch' };

    const reconciled = [];
    for (const key of Object.keys(record.members ?? {})) {
      const member = record.members[key];
      if (!member) continue;

      // Only an absent controller implementation outcome is reconciled.
      const runId = member.implementation_run_id ?? member.run_id;
      if (member.implementation_run_id != null) continue;
      if (typeof runId !== 'string' || runId.length === 0) continue;

      let run;
      try { run = loadRun(packageDir, runId); }
      catch { continue; }

      const step = Number(key);
      const bindings = run?.wave_bindings ?? {};
      const exact = bindings.package_ref === record.package_ref
        && bindings.wave_id === wave_id
        && String(bindings.generation) === String(record.generation)
        && Number(bindings.step_number) === step
        && bindings.attempt_id === member.attempt_id
        && bindings.claim_token === record.claim_token
        && String(bindings.coordinator_epoch ?? '') === String(record.coordinator?.epoch ?? '');
      if (!exact) continue;
      if (bindings.phase !== 'implementing') continue;

      const effectKey = `${wave_id}:${member.attempt_id}:implementing`;
      const effect = record.effects?.[effectKey];
      if (effect?.outcome === 'launched') continue;

      const assignment = assignmentId({ wave_id, step, phase: 'implementing', attempt: member.attempt ?? 1, resume: member.resume > 0 ? member.resume : undefined });
      if (effect?.assignment_id !== assignment || run.assignment_id !== assignment) continue;

      patchRecord(entry.recordPath, own.session, draft => {
        const target = draft.members?.[key];
        if (!target) return;
        target.implementation_run_id = runId;
        target.phase = 'implementing';
        target.queue_reason = null;
        target.blocking_reason = null;
        target.blocking_detail = null;
        target.transitions = Array.isArray(target.transitions) ? target.transitions : [];
        target.transitions.push({ phase: 'implementing', at: timestamp(now()), reason: 'reconcile-launch' });
        draft.effects = draft.effects ?? {};
        draft.effects[effectKey] = {
          ...(draft.effects[effectKey] ?? { kind: 'implementing' }),
          assignment_id: assignment,
          outcome: 'launched',
          observed_at: timestamp(now())
        };
      });
      reconciled.push({ key, run_id: runId, assignment_id: assignment });
    }

    return { outcome: reconciled.length > 0 ? 'reconciled' : 'none', reconciled };
  }

  return {
    async recover(input = {}) {
      // The locate+stale-generation guard runs first, unchanged: a stale
      // expected_generation refuses before any identity observation.
      const { packageDir, recordPath, wave_id, record } = await locateControl(input);

      // The stored owner identity is opaque evidence, compared exactly. A
      // malformed pair cannot authorize a claim, so it is unknown.
      const stored = storedProcessIdentity(record);
      if (!stored) throw invalid('package-owner-unknown', 'Wave record carries no valid coordinator process identity; refusing to classify the owner.');

      // Only an alive, exact PID and start-time match is positive liveness; a
      // timeout, permission failure or inconclusive probe stays unknown, and a
      // differing start time for a live PID is a different process. A dead
      // observation is positive only for the same stored PID.
      let observed;
      try {
        observed = await inspect(stored.pid);
      } catch {
        observed = null;
      }
      if (!observed || (observed.state !== 'alive' && observed.state !== 'dead'))
        throw invalid('package-owner-unknown', `Coordinator process ${stored.pid} could not be observed; owner is unknown.`);
      if (observed.pid !== stored.pid)
        throw invalid('package-owner-unknown', `Observed process ${observed.pid} does not match stored owner ${stored.pid}; owner is unknown.`);
      if (observed.state === 'alive' && observed.started_at !== stored.started_at)
        throw invalid('package-owner-unknown', `Process ${stored.pid} is alive with a different start time; owner is unknown.`);

      if (observed.state === 'alive') {
        // Positive liveness: this wave is still owned. It is replayable only when
        // the current coordinator session, PID and start time all match the
        // durable owner, and then only as a read-only receipt.
        const own = coordinator ? coordinator() : {};
        const sessionMatches = record.coordinator?.session === own?.session;
        const pidMatches = own?.pid === stored.pid;
        const startMatches = own?.started_at === stored.started_at;
        if (sessionMatches && pidMatches && startMatches) return waveReceipt(record, recordPath);
        throw invalid('package-owned', `Wave ${record.wave_id} is owned by a live coordinator; refusing to recover it.`);
      }

      // Positively dead owner: adopt it.
      const own = coordinator ? coordinator() : {};
      if (!own || typeof own.session !== 'string' || own.session.length === 0)
        throw invalid('coordinator-missing', 'Wave recovery requires an observable replacement coordinator identity.');

      // Frozen inputs must still match before any claim or record effect; a
      // mismatch, a pending inbox direction or an expired deadline refuses
      // adoption outright, so no worker is ever launched on stale inputs.
      let prepared;
      try {
        prepared = await prepare({ package: record.package ?? packageDir });
      } catch (error) {
        throw invalid('recovery-inputs-unreadable', `Frozen wave inputs could not be re-read: ${error?.message ?? error}`);
      }
      if (!prepared || prepared.state)
        throw invalid('recovery-inputs-changed', 'Frozen wave inputs require intake before recovery; refusing to adopt.');
      const inputsMatch = prepared.index_sha256 === record.inputs?.index_sha256
        && prepared.evidence_plan_sha256 === record.inputs?.evidence_plan_sha256;
      if (!inputsMatch)
        throw invalid('recovery-inputs-changed', 'Frozen index/evidence hashes changed since the wave opened; refusing to adopt.');

      let pending = [];
      try { pending = pendingInbox?.(packageDir) ?? []; } catch { pending = []; }
      if (Array.isArray(pending) && pending.length > 0)
        throw invalid('recovery-blocked', 'Package has a pending inbox direction; refusing to adopt and launch workers.');
      const expires = deadlineValue(record.deadline);
      if (expires !== null && expires <= now())
        throw invalid('recovery-blocked', 'Wave deadline has expired; refusing to adopt and launch workers.');

      // Rebind every held claim for this package to the replacement coordinator,
      // preserving each token and epoch exactly. Nothing is released here.
      const held = await ownership.inspectClaims({ packageId: record.package_ref });
      for (const claim of held?.claims ?? []) {
        if (!claim || typeof claim.token !== 'string') continue;
        const recovered = await ownership.recoverClaims({ token: claim.token, epoch: claim.epoch, coordinator: own });
        if (recovered?.status !== 'recovered')
          throw invalid('recovery-claim', `Held claim ${claim.token} could not be rebound (${recovered?.status ?? 'unknown'}).`);
      }

      // Adopt: change ONLY the coordinator session and process identity. The
      // claim-creation epoch, generation, deadline and all member/workspace state
      // are preserved, and the recovery intent is persisted with the effect.
      const adoptedAt = timestamp(now());
      const adopted = integration.updateWaveRecord(recordPath, { expectedRevision: record.revision }, draft => {
        draft.coordinator = {
          ...draft.coordinator,
          session: own.session,
          process_identity: { pid: own.pid ?? null, started_at: own.started_at ?? null }
        };
        draft.effects = draft.effects ?? {};
        draft.effects[`${wave_id}:recovery`] = {
          kind: 'dead-owner-adoption',
          assignment_id: null,
          intent_at: adoptedAt,
          adopted_session: own.session,
          outcome: null
        };
      });

      const entry = rehydrateEntry({ record: adopted, recordPath, packageDir, prepared, wave_id, own });
      loadedWaves.set(wave_id, entry);

      const outcomes = [];
      for (const key of Object.keys(adopted.members ?? {})) {
        outcomes.push(await resumeMember({ key, record: adopted, recordPath, packageDir, wave_id, entry, own }));
      }

      // A retained candidate repair phase is recovered with the exact candidate
      // identity; the fresh durable read is the authority for the repair binding.
      try {
        const candidateOutcome = await candidateRecovery.resume(entry, integration.readWaveRecord(recordPath), own);
        if (candidateOutcome?.status) outcomes.push(candidateOutcome.status);
      } catch (error) {
        outcomes.push(`candidate-blocked:${error?.code ?? 'recovery-error'}`);
      }

      // Record the adoption outcome. A later continuation release is allowed to
      // drive the barrier, but this recovery never starts an unsupported phase.
      patchRecord(recordPath, own.session, draft => {
        const effect = draft.effects?.[`${wave_id}:recovery`];
        if (!effect) return;
        effect.outcome = 'adopted';
        effect.observed_at = timestamp(now());
        effect.resumed = outcomes.filter(outcome => outcome === 'resumed').length;
        effect.blocked = outcomes.filter(outcome => outcome === 'blocked').length;
      });

      if (typeof driveAndContinue === 'function') await driveAndContinue(entry);

      return waveReceipt(integration.readWaveRecord(recordPath), recordPath);
    },

    // Explicit positive-drain recheck for members previously blocked by an
    // unresolved liveness observation. The controller calls this before its
    // queued-member retry and admission, so a later populated/live/unknown
    // observation either resumes the same attempt once or leaves the block.
    // It never drives the barrier itself.
    async retryBlocked(entry) {
      if (!entry?.recordPath || !entry?.waveId) return { outcome: 'no-entry' };

      const coord = coordinator ? coordinator() : {};
      if (!coord || typeof coord.session !== 'string' || coord.session.length === 0)
        return { outcome: 'no-coordinator' };

      let record;
      try { record = JSON.parse(readFileSync(entry.recordPath, 'utf8')); }
      catch { return { outcome: 'unreadable' }; }

      // The current session, token and epoch must all still be this coordinator's.
      if (record?.coordinator?.session !== coord.session) return { outcome: 'not-owner' };
      if (record?.claim_token !== entry?.admission?.claimToken) return { outcome: 'token-mismatch' };
      if ((record?.coordinator?.epoch ?? null) !== (entry?.admission?.epoch ?? null))
        return { outcome: 'epoch-mismatch' };

      // The package claim itself must still be held at the current epoch.
      let claim;
      try { claim = await ownership.inspectClaims({ packageId: record.package_ref }); }
      catch { return { outcome: 'claims-unreadable' }; }
      const held = (claim?.claims ?? []).find(entryClaim => entryClaim?.kind === 'package' && entryClaim?.token === record.claim_token);
      if (!held || held.epoch !== record.coordinator?.epoch) return { outcome: 'package-claim-missing' };

      // A pending cancellation intent, an expired deadline or a pending/unreadable
      // inbox direction refuses the recheck without any effect.
      if (record?.cancel_intent || record?.effects?.cancel) return { outcome: 'cancel-pending' };
      const expires = deadlineValue(record.deadline);
      if (expires !== null && expires <= now()) return { outcome: 'deadline-expired' };
      let pending;
      try { pending = pendingInbox?.(entry.packagePath) ?? []; }
      catch { return { outcome: 'inbox-unreadable' }; }
      if (Array.isArray(pending) && pending.length > 0) return { outcome: 'input-pending' };

      // Frozen index/evidence hashes must still match the record's inputs.
      let prepared;
      try { prepared = await prepare({ package: record.package ?? entry.packagePath }); }
      catch { return { outcome: 'inputs-unreadable' }; }
      if (!prepared || prepared.state) return { outcome: 'inputs-changed' };
      if (prepared.index_sha256 !== record.inputs?.index_sha256
          || prepared.evidence_plan_sha256 !== record.inputs?.evidence_plan_sha256)
        return { outcome: 'inputs-changed' };

      const own = { ...coord, epoch: record.coordinator?.epoch ?? coord.epoch };
      const outcomes = [];
      for (const key of Object.keys(record.members ?? {})) {
        const member = record.members[key];
        if (member?.phase !== 'blocked') continue;
        const reason = member.blocking_reason;
        if (reason !== 'liveness-unknown' && reason !== 'liveness-live') continue;
        const outcome = await resumeMember({ key, record, recordPath: entry.recordPath, packageDir: entry.packagePath, wave_id: entry.waveId, entry, own });
        outcomes.push({ key, outcome });
      }

      // Recheck the retained candidate repair only for an unresolved liveness
      // block, using the freshest durable record.
      const candidateRepair = record.target?.repair;
      const candidateReason = candidateRepair?.recovery_blocking_reason;
      if (candidateReason === 'liveness-unknown' || candidateReason === 'liveness-live') {
        let fresh = record;
        try { fresh = JSON.parse(readFileSync(entry.recordPath, 'utf8')); } catch { fresh = record; }
        const candidateOutcome = await candidateRecovery.resume(entry, fresh, own);
        outcomes.push({ key: 'candidate', outcome: candidateOutcome?.status ?? 'skipped' });
      }

      return { outcome: 'rechecked', outcomes };
    },

    loadOwnedEntry,
    reconcileLaunches
  };
}
