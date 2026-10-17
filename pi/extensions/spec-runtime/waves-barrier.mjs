// Sealed-member barrier → candidate checks → promotion for a durable wave
// (step 10). Split out of `waves.mjs` at the integration boundary: the
// controller owns the FIFO and the durable wave record, this module owns the
// barrier that waits for every member to seal and then drives the step-9
// integration library (`assembleCandidate` → `runCandidateChecks` →
// `promoteWave`). Recovery, repair driving and next-wave opening are later
// packets and stay deliberately unimplemented here.
//
// Durability rules honored here:
// - The wave record is the only source of truth; every effect is guarded by a
//   fresh read and a re-check of generation, session, package claim/epoch,
//   frozen input hashes, an empty inbox and an unexpired deadline.
// - Member phases stay Runtime-owned (`sealed`); the barrier only writes the
//   wave-level `state` (`ready-to-integrate`, `integrating`, `verifying`,
//   `promoting`, `integrated`, `blocked`).
// - A blocked or cancelled sibling blocks the whole wave with no partial
//   assembly; a conflict or failed candidate check blocks with the explicit
//   `integration-repair-required` reason for a later repair driver.
// - The package claim is released only after a successful final checkpoint
//   reconcile and only for the last validation wave.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCandidateRepair } from './waves-candidate.mjs';

// Wave states that mean work is still outstanding. `progressing()` reads this
// so an idle notification during candidate checks still reports progress.
export const WAVE_PROGRESSING_STATES = new Set([
  'open', 'running', 'ready-to-integrate', 'integrating', 'verifying', 'promoting', 'repairing'
]);

// A wave that has reached one of these states is inert to the barrier: the only
// terminal publication path is `integrated`, and a blocked wave waits for the
// repair driver.
const WAVE_STOP_STATES = new Set(['integrated', 'cancelled', 'blocked']);
// Member phases that count as stopped for the barrier; anything else (queued,
// implementing, reviewing, fixing, confirming) is still progressing.
const MEMBER_STOPPED = new Set(['sealed', 'blocked', 'cancelled']);

function isoTimestamp(ms) {
  return new Date(ms).toISOString();
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function deadlineMs(deadline) {
  if (deadline == null) return null;
  const value = typeof deadline === 'object' ? deadline.expires_at : deadline;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// The durable record stores the coordinator process evidence nested under
// `process_identity`; the integration context expects it flattened. This is the
// same projection the member admission uses.
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

// The lifecycle module derives the staging root identically; the barrier
// re-derives it from the runtime index rather than trusting a caller path.
function waveRootFor(runtime, packageRef, waveId) {
  const digest = sha256Hex(String(packageRef)).slice(0, 24);
  return join(runtime.indexDir, 'wave-workspaces', digest, waveId);
}

function refuse(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code, name: 'WaveBarrierError' });
}

export function createWaveBarrier(deps = {}) {
  const {
    runtime, ownership, integration, checkpoint, patchRecord, pendingInbox, attentionKey, send, nowMs,
    review = null, loadRun = null
  } = deps;
  const now = () => (typeof nowMs === 'function' ? nowMs() : Date.now());
  const at = () => isoTimestamp(now());
  const deliver = typeof send === 'function' ? send : () => ({ delivered: false });

  function freshRecord(entry) {
    return integration.readWaveRecord(entry.recordPath);
  }

  // A guarded wave-level state write through the controller's own record guard:
  // a foreign generation/session is refused rather than overwritten.
  function transition(entry, state, extra = {}) {
    return patchRecord(entry.recordPath, entry.session, draft => {
      draft.state = state;
      if (state !== 'blocked') {
        delete draft.blocking_reason;
        delete draft.blocking_detail;
      }
      draft.transitions = Array.isArray(draft.transitions) ? draft.transitions : [];
      draft.transitions.push({ state, at: at(), ...extra });
    });
  }

  // Persist a blocked wave with an explicit machine reason and detail. Never
  // throws: a guard conflict means another writer owns the record.
  function blockWave(entry, reason, detail) {
    try {
      patchRecord(entry.recordPath, entry.session, draft => {
        if (draft.state === 'blocked' && draft.blocking_reason === reason) return;
        draft.state = 'blocked';
        draft.blocking_reason = reason;
        draft.blocking_detail = detail ?? null;
        draft.transitions = Array.isArray(draft.transitions) ? draft.transitions : [];
        draft.transitions.push({ state: 'blocked', at: at(), reason });
      });
    } catch {
      // Leave a foreign record untouched; reconciliation owns it.
    }
  }

  // One turn per kind/wave transition. The dedup is persisted before the send
  // so a replayed notification or a repeated capacity release can never emit a
  // second attention turn.
  function emitAttention(entry, kind, extra = {}) {
    const key = attentionKey({
      wave_id: entry.waveId, kind, step: null, transition: extra.transition ?? 'wave'
    });
    let first = false;
    try {
      patchRecord(entry.recordPath, entry.session, draft => {
        draft.attention = draft.attention ?? {};
        if (draft.attention[key]) return;
        draft.attention[key] = { emitted_at: at() };
        first = true;
      });
    } catch {
      return false;
    }
    if (!first) return false;
    const record = (() => { try { return freshRecord(entry); } catch { return null; } })();
    deliver({
      customType: 'spec-wave',
      content: JSON.stringify({
        kind,
        wave_id: entry.waveId,
        step: null,
        state: record?.state ?? null,
        ...extra,
        record_path: entry.recordPath
      }),
      display: true
    }, { triggerTurn: true });
    return true;
  }

  // Every effect is gated on a fresh read that still matches the owned claim:
  // generation 1, this session, a held package claim at the recorded epoch, the
  // frozen package input hashes, an empty inbox and an unexpired deadline.
  async function guardsHold(entry, record) {
    if (!record || record.generation !== 1) return false;
    if (record.coordinator?.session !== entry.session) return false;
    if (typeof record.claim_token !== 'string' || !record.claim_token) return false;
    if (record.coordinator?.epoch === undefined || record.coordinator?.epoch === null) return false;
    if (record.cancel_requested || record.interrupted) return false;
    const deadline = deadlineMs(record.deadline);
    if (deadline !== null && deadline <= now()) return false;
    try {
      if (pendingInbox(entry.packagePath ?? record.package).length) return false;
    } catch {
      return false;
    }
    try {
      const index = readFileSync(join(record.package, 'spec-steps.json'));
      const evidence = readFileSync(join(record.package, 'evidence-plan.json'));
      if (sha256Hex(index) !== record.inputs?.index_sha256) return false;
      if (sha256Hex(evidence) !== record.inputs?.evidence_plan_sha256) return false;
    } catch {
      return false;
    }
    try {
      const { claims } = await ownership.inspectClaims({ packageId: record.package_ref });
      const held = (claims ?? [])
        .find(claim => claim?.kind === 'package' && claim.token === record.claim_token);
      if (!held) return false;
      if (String(held.epoch) !== String(record.coordinator.epoch)) return false;
    } catch {
      return false;
    }
    return true;
  }

  // Build the real step-9 integration context from the freshly read record. The
  // candidate workspace config is reconstructed from the record and the
  // lifecycle-derived staging root; the integration library owns the actual
  // candidate workspace.
  function buildContext(entry, record) {
    const packageDir = entry.packagePath ?? record.package;
    const members = Object.entries(record.members ?? {})
      .map(([key, member]) => ({ step: Number(key), member }))
      .filter(entry => Number.isInteger(entry.step))
      .sort((a, b) => a.step - b.step);
    if (!members.length) throw refuse('members-missing', 'the wave has no members to integrate');
    for (const { step, member } of members) {
      if (typeof member?.sealed_head !== 'string' || !member.sealed_head)
        throw refuse('sealed-head-missing', `step ${step} has no sealed head`);
      if (typeof member?.retention_ref !== 'string' || !member.retention_ref)
        throw refuse('retention-ref-missing', `step ${step} has no retention ref`);
    }
    const first = members[0].member;
    const backend = first?.workspace?.backend ?? null;
    if (backend !== 'overlayfs' && backend !== 'worktree')
      throw refuse('backend-unspecified', 'a sealed member workspace has no concrete backend');
    const attemptId = first?.attempt_id ?? null;
    if (typeof attemptId !== 'string' || !attemptId)
      throw refuse('attempt-missing', 'a sealed member has no attempt id');
    const packageRef = record.package_ref;
    const waveRoot = waveRootFor(runtime, packageRef, entry.waveId);
    const index = readJson(join(packageDir, 'spec-steps.json'));
    const evidence = readJson(join(packageDir, 'evidence-plan.json'));
    if (!index || !evidence) throw refuse('index-unreadable', 'package metadata is missing or unparseable');
    const setup = index.setup?.[record.target?.id];
    const gateIds = Array.isArray(record.wave_check?.gates) ? record.wave_check.gates : [];
    const checks = [];
    for (const id of gateIds) {
      const gate = (evidence.gates ?? []).find(candidate => candidate?.id === id);
      if (!gate || typeof gate.command !== 'string' || !gate.command)
        throw refuse('checks-invalid', `wave gate ${id} has no evidence-plan command`);
      checks.push({ id, command: gate.command });
    }
    if (!checks.length) throw refuse('checks-invalid', 'the wave check resolves no gates');
    const branch = record.target?.branch;
    if (typeof branch !== 'string' || !branch)
      throw refuse('target-branch-missing', 'the wave record has no target branch');
    const shortBranch = branch.replace(/^refs\/heads\//, '');
    if (typeof shortBranch !== 'string' || !shortBranch)
      throw refuse('target-branch-missing', 'the wave record has no valid target branch');
    const memoryBytes = record.effective_limits?.memory?.per_lifecycle_bytes;
    const tasks = record.effective_limits?.tasks?.per_lifecycle;
    if (!Number.isInteger(memoryBytes) || !Number.isInteger(tasks))
      throw refuse('capacity-missing', 'the wave record has no per-lifecycle capacity');
    return {
      recordPath: entry.recordPath,
      revision: record.revision,
      waveId: entry.waveId,
      packageId: packageRef,
      packageClaim: { token: record.claim_token, epoch: record.coordinator?.epoch },
      coordinator: coordinatorIdentity(record),
      ownership,
      target: {
        worktree: record.target?.integration_checkout,
        gitCommonDir: record.target?.common,
        branch: shortBranch
      },
      baseCommit: record.target?.base_commit,
      members: members.map(({ step, member }) => ({
        step,
        sealedHead: member.sealed_head,
        retentionRef: member.retention_ref
      })),
      workspace: {
        waveRoot,
        mode: backend,
        capability: record.target?.capability ?? null,
        setup,
        env: process.env,
        preparationReceipt: first?.preparation_receipt ?? null,
        staging: {
          source: join(waveRoot, 'staging', attemptId, 'source'),
          dependencies: join(waveRoot, 'staging', attemptId, 'dependencies')
        }
      },
      checks,
      capacity: { memoryBytes, tasks },
      phaseRecord: (workspace, opts = {}) => runtime.commandPhase({
        packageDir,
        waveId: entry.waveId,
        subject: { kind: 'candidate', attempt: 1 },
        workspace,
        purpose: opts.purpose,
        capacityClaim: opts.capacityClaim
      }),
      runCommand: (phaseRecord_, command, timeout, options) => runtime.runPhaseCommand(phaseRecord_, command, timeout, undefined, options),
      endPhaseRecord: (phaseRecord_, options) => runtime.endCommandPhase(phaseRecord_, options)
    };
  }

  function buildContextAtFreshRevision(entry) {
    return buildContext(entry, freshRecord(entry));
  }

  // The candidate repair driver is built lazily so `buildContextAtFreshRevision`
  // (the candidate's fresh-revision context) is in scope, and so a wave with no
  // candidate repair never constructs it.
  let candidateRepairDriver = null;
  function candidateDriver() {
    if (!candidateRepairDriver) {
      candidateRepairDriver = createCandidateRepair({
        runtime, ownership, integration, review, loadRun,
        patchRecord, pendingInbox, nowMs, context: buildContextAtFreshRevision
      });
    }
    return candidateRepairDriver;
  }

  // Hand a conflict or failed composition check to the candidate repair driver.
  // The driver owns the launch decision; the barrier only relays its outcome.
  async function beginCandidate(entry) {
    let outcome;
    try { outcome = await candidateDriver().begin(entry); }
    catch (error) {
      blockWave(entry, error?.code ?? 'repair-preparation-failed', { message: error?.message ?? null });
      return { status: 'blocked', reason: error?.code ?? 'repair-preparation-failed' };
    }
    if (outcome?.status === 'blocked') return { status: 'blocked', reason: outcome.reason ?? 'repair-unresolved' };
    if (outcome?.status === 'queued') return { status: 'queued', constraint: outcome.constraint ?? null };
    return { status: 'progressing' };
  }

  // The wave is last when no package step lies after this wave's boundary; only
  // then is the package claim released. The next-wave opening is a later packet.
  function isLastWave(record) {
    const index = readJson(join(record.package, 'spec-steps.json'));
    if (!index) return false;
    const maxStep =
      (index.steps ?? []).reduce((max, row) => Math.max(max, Number(row.step) || 0), 0);
    return maxStep <= Number(record.after);
  }

  async function releasePackageClaim(entry, record) {
    if (!isLastWave(record)) return;
    try {
      await ownership.releaseClaim({
        token: record.claim_token, epoch: record.coordinator?.epoch, drain: 'confirmed'
      });
    } catch {
      // A failed release leaves the claim for reconciliation to resolve.
    }
  }

  // Diagnostic-only checkpoint-reconcile snapshot. Every write goes through the
  // same record guard as the wave itself and a diagnostic failure is swallowed:
  // reconciliation is never suppressed, retried or changed for diagnostics.
  function persistCheckpointReconcile(entry, snapshot) {
    try {
      patchRecord(entry.recordPath, entry.session, draft => {
        draft.checkpoint_reconcile = snapshot;
      });
    } catch {
      // A foreign record is not overwritten; reconciliation still proceeds.
    }
  }

  async function reconcileCheckpoint(entry, record) {
    if (!record.workflow_id) return;
    if (!checkpoint || typeof checkpoint.reconcileRuntimeReturn !== 'function')
      throw refuse('checkpoint-reconciler-missing', 'the checkpoint reconciler is unavailable');
    const existing = (() => {
      try { return checkpoint.readCheckpointRecord(record.package, record.workflow_id) ?? {}; } catch { return {}; }
    })();
    let ownershipSnapshot;
    try {
      const observed = await ownership.inspectClaims({ packageId: record.package_ref });
      ownershipSnapshot = { claims: observed?.claims ?? [] };
    } catch (error) {
      ownershipSnapshot = { error: error?.message ?? String(error) };
    }
    // Wave ownership/claim guards authorize the replacement drive; runtime
    // completion retains the checkpoint binding rather than adopting workflow
    // ownership, so the completion is submitted under the checkpoint's own
    // coordinator session when one is bound.
    const completionSession = existing.coordinator_session ?? entry.session;
    const snapshot = {
      at: at(),
      component: 'checkpoint_reconcile',
      wave_id: record.wave_id ?? entry.waveId ?? null,
      workflow_id: record.workflow_id,
      session: entry.session,
      completion_session: completionSession,
      existing: {
        coordinator_session: existing.coordinator_session ?? null,
        revision: existing.revision ?? null,
        checkout: existing.checkout ?? null
      },
      wave: { coordinator: record.coordinator ?? null },
      ownership: ownershipSnapshot
    };
    persistCheckpointReconcile(entry, { ...snapshot, status: 'attempted' });
    try {
      checkpoint.reconcileRuntimeReturn({
        package: record.package,
        workflow_id: record.workflow_id,
        expected_revision: existing.revision ?? 0,
        assignment_id: entry.waveId,
        return_state: 'completed',
        workers: Array.isArray(existing.workers) ? existing.workers : [],
        reconciles_input_revision: existing.input_revision ?? 0,
        coordinator_session: completionSession,
        checkout: record.target?.integration_checkout ?? null
      });
    } catch (error) {
      persistCheckpointReconcile(entry, {
        ...snapshot,
        at: at(),
        status: 'refused',
        reason: error?.reason ?? error?.code ?? null,
        message: error?.message ?? String(error)
      });
      throw error;
    }
    persistCheckpointReconcile(entry, { ...snapshot, at: at(), status: 'succeeded' });
  }

  // The controller-FIFO entry point. Runs only on an owned, non-terminal wave:
  // waits for every member to stop, then drives assembly → checks → promotion
  // once all of them are sealed. Idempotent under redelivery; posts at most one
  // attention turn per kind. Never throws: an unexpected error blocks the wave
  // with detail instead of reporting success.
  async function drive(entry) {
    if (!entry || typeof entry !== 'object') return { status: 'idle' };
    let record;
    try { record = freshRecord(entry); } catch { return { status: 'unreadable' }; }
    if (!record || record.wave_id !== entry.waveId) return { status: 'foreign' };
    if (WAVE_STOP_STATES.has(record.state)) return { status: record.state };
    let held = false;
    try { held = await guardsHold(entry, record); } catch { held = false; }
    if (!held) return { status: 'guard-refused' };

    // An active candidate repair owns the wave until it is accepted or blocked;
    // drive it to a terminal outcome before any member barrier work.
    for (let pass = 0; pass < 8; pass += 1) {
      const current = freshRecord(entry);
      if (WAVE_STOP_STATES.has(current.state)) return { status: current.state };
      if (!current.target?.repair || current.target.repair.phase === 'accepted') break;
      let outcome;
      try { outcome = await candidateDriver().drive(entry); }
      catch (error) {
        blockWave(entry, error?.code ?? 'candidate-drive-failed', { message: error?.message ?? null });
        return { status: 'blocked', reason: error?.code ?? 'candidate-drive-failed' };
      }
      if (outcome?.status === 'advanced') continue;
      if (outcome?.status === 'blocked') return outcome;
      return { status: 'progressing' };
    }

    const members = Object.entries(record.members ?? {})
      .map(([key, member]) => ({ step: Number(key), member }));
    const progressingMembers = members.filter(({ member }) => !MEMBER_STOPPED.has(member?.phase));
    if (progressingMembers.length) return { status: 'progressing' };
    const stoppedMembers = members.filter(({ member }) => member?.phase === 'blocked' || member?.phase === 'cancelled');
    if (stoppedMembers.length) {
      blockWave(entry, 'member-blocked', {
        steps: stoppedMembers.map(({ step }) => step),
        reasons: stoppedMembers.map(({ member }) => member?.blocking_reason ?? null)
      });
      return { status: 'blocked', reason: 'member-blocked' };
    }
    if (!members.length || members.some(({ member }) => member?.phase !== 'sealed'))
      return { status: 'progressing' };

    try {
      // Barrier reached: persist the ready marker and dedup the attention turn
      // before sending, then advance to integrating.
      transition(entry, 'ready-to-integrate');
      emitAttention(entry, 'barrier-reached', { transition: 'wave', members: members.map(({ step }) => step) });
      transition(entry, 'integrating');

      const assembled = await integration.assembleCandidate(buildContextAtFreshRevision(entry));
      // A conflict is repairable: hand the wave to the candidate repair driver
      // instead of blocking it.
      if (assembled.status === 'conflict') return await beginCandidate(entry);
      if (assembled.status !== 'assembled') {
        blockWave(entry, assembled.reason ?? 'integration-blocked', { status: assembled.status });
        return { status: 'blocked', reason: assembled.reason ?? 'integration-blocked' };
      }

      transition(entry, 'verifying');
      const checked = await integration.runCandidateChecks(buildContextAtFreshRevision(entry));
      if (checked.status === 'queued') return { status: 'queued', constraint: checked.constraint ?? null };
      if (checked.status !== 'passed') {
        // A failed composition check is the canonical candidate-repair trigger.
        return await beginCandidate(entry);
      }

      transition(entry, 'promoting');
      const promoted = await integration.promoteWave(buildContextAtFreshRevision(entry));
      if (promoted.status !== 'promoted') {
        blockWave(entry, promoted.reason ?? promoted.blocked_reason ?? 'promotion-blocked', {
          status: promoted.status
        });
        return { status: 'blocked', reason: promoted.reason ?? promoted.blocked_reason ?? 'promotion-blocked' };
      }

      transition(entry, 'integrated');
      const finalRecord = freshRecord(entry);
      await reconcileCheckpoint(entry, finalRecord);
      await releasePackageClaim(entry, finalRecord);
      emitAttention(entry, 'promotion-result', { transition: 'wave', outcome: 'integrated', ref: promoted.ref ?? null });
      return { status: 'integrated' };
    } catch (error) {
      const reason = error?.reason ?? error?.code ?? 'integration-failed';
      blockWave(entry, reason, { message: error?.message ?? null, reason: error?.reason ?? null });
      return { status: 'blocked', reason };
    }
  }

  return { drive };
}
