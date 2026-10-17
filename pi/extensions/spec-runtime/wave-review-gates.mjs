// Step 8 gate runs: the bounded stage-gate phase. Split out of wave-review-seal.mjs
// without changing any behavior; the gate pipeline re-reads the durable wave,
// confirms the prior checkout claim is drained, reserves capacity and runs each
// gate command through the runtime phase transport.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { recordVerification, verificationReceipts } from './completion.mjs';
import { inspectAllClaims, stageCapacityRequest, releaseWorkspace, releaseCapacity } from './wave-review-runtime.mjs';
import { selectWaveSubject } from './wave-candidate-binding.mjs';

function fail(code, detail, extra = {}) {
  const error = new Error(detail);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function runGit(gitDir, args, options = {}) {
  return execFileSync('git', ['--git-dir', gitDir, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function privateHead(gitDir) {
  if (!gitDir) return null;
  try {
    return runGit(gitDir, ['rev-parse', 'HEAD']).toString('utf8').trim() || null;
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readJson(path) {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The durable wave record nests the coordinator process evidence under
// `process_identity`, while ownership.reserveCapacity expects a flat
// {session, epoch, pid, started_at} identity. Normalize without changing the
// persisted wave shape, and fall back to flat fields so existing fixtures work.
function sealCoordinatorIdentity(coordinator) {
  if (!coordinator || typeof coordinator !== 'object') return coordinator;
  const processIdentity = coordinator.process_identity ?? {};
  return {
    session: coordinator.session,
    epoch: coordinator.epoch,
    pid: processIdentity.pid ?? coordinator.pid ?? null,
    started_at: processIdentity.started_at ?? coordinator.started_at ?? null,
  };
}

// The durable wave member stores its private-worktree facts under `workspace`;
// the gate pipeline consumes a flat internal view. Normalize into that flat view
// (backend, fallback_reason, git_dir, base_commit, layers) while retaining the
// durable member metadata. Already-flat members pass through unchanged.
function normalizeMember(durable, sourceCommon) {
  const member = durable ?? {};
  const workspace = member.workspace ?? {};
  return {
    ...member,
    backend: workspace.backend ?? member.backend ?? null,
    fallback_reason: workspace.backendReason ?? member.fallback_reason ?? null,
    git_dir: workspace.gitDir ?? member.git_dir ?? null,
    base_commit: workspace.baseCommit ?? member.base_commit ?? null,
    source_common: sourceCommon ?? member.source_common ?? null,
    layers: {
      lower: workspace.lower ?? member.layers?.lower ?? null,
      upper: workspace.upper ?? member.layers?.upper ?? null,
      work: workspace.work ?? member.layers?.work ?? null,
      merged: workspace.merged ?? member.layers?.merged ?? null,
    },
    worktree: workspace.worktree ?? member.worktree ?? null,
    claim: workspace.claim ?? member.claim ?? null,
  };
}

// ---------------------------------------------------------------------------
// runStageGates.

export async function runStageGates(input = {}) {
  const { runtime, ownership, identity = {}, record, gates = [], head: inputHead } = input;
  if (!record || typeof record !== 'object') {
    throw fail('gate-input-invalid', 'runStageGates requires the implementation record');
  }
  const packageDir = record.package;
  const binding = record.wave_bindings ?? {};
  const waveId = identity.wave_id ?? binding.wave_id ?? record.wave_id ?? null;
  const stepNumber = Number(identity.step_number ?? binding.step_number ?? record.step ?? 0);
  const attemptId = identity.attempt_id ?? binding.attempt_id ?? null;
  if (!packageDir || !waveId || !Number.isInteger(stepNumber) || stepNumber < 1) {
    throw fail('gate-input-invalid', 'runStageGates requires a package, wave and step identity');
  }
  // The durable wave is read before the claim inspection: the package id and the
  // member's private-worktree facts both come from it, not from the run bindings.
  const wave = readJson(join(packageDir, 'runtime/waves', `${waveId}.json`));
  if (!wave) throw fail('gate-wave-missing', `no durable wave record for ${waveId}`);
  const selected = selectWaveSubject(wave, {
    ...identity,
    step_number: stepNumber,
    attempt_id: attemptId,
    ...(binding.candidate != null ? { candidate: binding.candidate } : {}),
  });
  const rawMember = selected.subject ?? null;
  if (!rawMember) throw fail('gate-member-missing', `no wave member for step ${stepNumber}`);
  const member = normalizeMember(rawMember, wave.target?.common ?? null);
  const packageId = wave.package_ref ?? waveId;

  // The prior run's checkout claim must be positively absent. A held running
  // claim blocks, an uninspectable claim is unknown and only absence confirms.
  // runtime.mjs records wave_bindings.checkout_claim as the bare token string.
  const checkoutClaim = binding.checkout_claim ?? record.checkout_claim ?? null;
  const checkoutToken = typeof checkoutClaim === 'string'
    ? checkoutClaim
    : (checkoutClaim?.token ?? null);
  if (!checkoutToken) {
    throw fail('drain-unknown', 'the run records no checkout claim token to confirm drained');
  }
  const inspected = await inspectAllClaims(ownership, packageId);
  if (inspected === null) throw fail('drain-unknown', 'the prior checkout claim could not be inspected');
  const held = inspected.find((claim) => claim?.token === checkoutToken) ?? null;
  if (held) {
    if (held.running === true) throw fail('phase-not-drained', 'the prior checkout claim is still held');
    throw fail('drain-unknown', 'the prior checkout claim is present but not confirmed drained');
  }

  const globalClaims = await inspectAllClaims(ownership);
  if (globalClaims === null) {
    throw fail('drain-unknown', 'the held capacity claims could not be inspected');
  }
  let reservation;
  try {
    reservation = await ownership.reserveCapacity({
      packageId: wave.package_ref ?? packageId,
      attempt: `${waveId}:${attemptId}:gates`,
      request: stageCapacityRequest(globalClaims),
      coordinator: sealCoordinatorIdentity(wave.coordinator),
    });
  } catch (error) {
    throw fail('gate-reservation-failed', `capacity reservation failed: ${error.message}`);
  }
  if (reservation?.status === 'queued') {
    return { state: 'queued', constraint: reservation.constraint ?? null, wave_id: waveId, step: stepNumber };
  }
  if (reservation?.status !== 'reserved' || !reservation.claim?.token) {
    throw fail('gate-reservation-failed', `capacity reservation was not confirmed (${reservation?.status ?? 'unknown'})`);
  }

  let workspace = null;
  let phaseRecord = null;
  let drained = false;
  try {
    workspace = (await runtime.remountWaveMember({ ...identity, wave_id: waveId, step_number: stepNumber, attempt_id: attemptId, phase: rawMember.phase }))?.workspace ?? null;
    const gitDir = member.git_dir ?? workspace?.gitDir ?? workspace?.retained?.gitDir ?? null;
    const head = inputHead ?? privateHead(gitDir);
    phaseRecord = await runtime.commandPhase({
      packageDir,
      waveId,
      subject: selected.candidate != null
        ? { kind: 'candidate', candidate: selected.candidate }
        : { kind: 'step', step: stepNumber },
      workspace,
      capacityClaim: reservation.claim,
      purpose: 'gates',
    });

    drained = true;
    for (const gate of gates) {
      if (!gate?.command) continue;
      const beforeHead = privateHead(gitDir);
      if (beforeHead && head && beforeHead !== head) {
        throw fail('gate-head-drift', `private head moved to ${beforeHead} before gate ${gate.command}`);
      }
      const startedAt = Date.now();
      // A drain is only confirmed by a completed command reporting
      // requires_cancellation === false; an await that throws leaves this false,
      // so the catch never releases after a thrown await.
      drained = false;
      const result = await runtime.runPhaseCommand(phaseRecord, gate.command, 300);
      drained = result?.requires_cancellation === false;
      const elapsedMs = Date.now() - startedAt;
      const afterHead = privateHead(gitDir);
      const before = { commit: beforeHead ?? head, dirty: false };
      const after = { commit: afterHead ?? beforeHead ?? head, dirty: false };
      const receipt = recordVerification(record, gate.command, before, after, {
        exit_code: result?.exit_code ?? null,
        error: result?.error ?? null,
        full_output_path: result?.full_output_path ?? null,
      }, { started_at: iso(startedAt), elapsed_ms: elapsedMs });
      if (afterHead && head && afterHead !== head) {
        throw fail('gate-head-drift', `private head moved to ${afterHead} after gate ${gate.command}`);
      }
      // A transport cancellation never confirms a drain; a completed nonzero
      // command still can.
      if (result?.requires_cancellation === true) {
        drained = false;
        break;
      }
      if (receipt.outcome !== 'pass') break;
    }
  } catch (error) {
    if (phaseRecord) {
      try { await runtime.endCommandPhase(phaseRecord, { drained }); } catch { /* retain */ }
    }
    if (drained) {
      try { await releaseWorkspace({ ownership, member, workspace }); } catch { /* retain */ }
      try { await releaseCapacity(ownership, reservation); } catch { /* retain */ }
    }
    throw error;
  }

  if (!drained) {
    if (phaseRecord) await runtime.endCommandPhase(phaseRecord, { drained: false });
    throw fail('drain-unknown', 'gate command transport drain was not confirmed');
  }
  await runtime.endCommandPhase(phaseRecord, { drained: true });
  const workspaceReleased = await releaseWorkspace({ ownership, member, workspace });
  const capacityReleased = await releaseCapacity(ownership, reservation);
  if (!workspaceReleased || !capacityReleased) {
    throw fail('drain-unknown', 'gate claim release could not be confirmed');
  }
  await runtime.endCommandPhase(phaseRecord, { drained: true, released: [{ kind: 'checkout', token: workspace.claim.token, epoch: workspace.claim.epoch }] });
  return verificationReceipts(record);
}
