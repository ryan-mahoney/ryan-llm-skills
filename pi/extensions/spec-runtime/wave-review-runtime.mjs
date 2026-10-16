// Runtime stage launch and contained command primitives for wave review/fix.
//
// The orchestrating owner (runStageGates/sealMember, later edit-sequence items)
// supplies the settled review state; this module owns exactly two host-facing
// transformations:
//   * startStage  — bind a review/fix stage to the existing wave route in
//     Runtime.start, resolving the stage model and role session.
//   * commandPhase/runPhaseCommand/endCommandPhase — a run-only command record
//     plus one contained transient unit, reusing the same adapter, overlay and
//     ownership authority as Runtime.containedRoot.
//
// Private Runtime plumbing (nativeCommand, streamTask, save, the ownership
// claim reader, runCommand, ...) is injected by runtime.mjs so this module never
// reverse-imports runtime.mjs. All methods execute with the Runtime receiver.

import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { totalmem } from 'node:os';
import { calculateResourcePolicy } from './linux-resources.mjs';
import { buildOverlayArgv, createOverlayPhases } from './overlay.mjs';
import { artifactEnvironment } from '../../../scripts/spec-location/artifact-environment.mjs';
import { stageLabel, stagePaths, resolveStageModel } from './wave-review.mjs';
import { selectWaveSubject } from './wave-candidate-binding.mjs';

// The phase → native role map. Review-shaped phases use the reviewer contract;
// fix-shaped phases use the fixer contract. Anything else is refused rather than
// guessed, so a stage never launches under the wrong role.
const ROLE_BY_PHASE = {
  reviewing: 'reviewer',
  confirming: 'reviewer',
  'integration-review': 'reviewer',
  'integration-confirm': 'reviewer',
  fixing: 'fixer',
  'integration-fix': 'fixer'
};

// A `candidate` subject may arrive as the card's field (a repair number or a full
// `{kind, repair, parents}` object) or as the explicit `input.subject`. Normalize
// both to the object shape the stage label and prompt read.
function asCandidateSubject(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && value.kind === 'candidate') return value;
  if (Number.isInteger(value)) return { kind: 'candidate', repair: value };
  return null;
}

// A confirmation round references the reviewed label's fix record, not its own:
// `wave-<id>-...-review-2` names `wave-<id>-...-review-1-fix.md`.
function precedingReviewedFixLabel(label, round) {
  if (typeof label !== 'string' || !Number.isInteger(round) || round < 2) return null;
  const suffix = `-review-${round}`;
  return label.endsWith(suffix) ? `${label.slice(0, -suffix.length)}-review-${round - 1}` : null;
}

// Sanitized transport names are the only caller environment submitted to the
// systemd unit (visible in systemd-run argv); the worker's full environment
// travels in a mode-0600 request file read by the fixed root bootstrap. Mirrors
// wave-lifecycle's immutable policy; not exported there for reuse.
const TRANSPORT_ENV_NAMES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'TERM'];
function sanitizeTransport(env) {
  return Object.fromEntries(TRANSPORT_ENV_NAMES.filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));
}

// Fixed inline bootstrap for a contained stage member. Carries no caller text:
// the request path is positional and the full environment plus native command
// arrive through a mode-0600 JSON file. It writes the overlay .git pointer when
// asked and then spawns the native command with inherited stdio.
const ROOT_BOOTSTRAP = [
  "const fs = require('fs');",
  "const { spawn } = require('child_process');",
  "const path = require('path');",
  'const requestFile = process.argv[1];',
  'let request;',
  'try { request = JSON.parse(fs.readFileSync(requestFile, "utf8")); }',
  'catch (error) { process.stderr.write("root bootstrap cannot read its request: " + error.message + "\\n"); process.exit(70); }',
  'if (request.gitDir && request.checkout) {',
  '  const pointer = path.join(request.checkout, ".git");',
  '  const expected = "gitdir: " + request.gitDir + "\\n";',
  '  let current = null;',
  '  try { current = fs.readFileSync(pointer, "utf8"); } catch { current = null; }',
  '  if (current !== expected) fs.writeFileSync(pointer, expected);',
  '}',
  'const child = spawn(request.command, request.args, { cwd: request.checkout, env: request.env, stdio: "inherit" });',
  'const forward = signal => { try { child.kill(signal); } catch {} };',
  'process.on("SIGTERM", () => forward("SIGTERM"));',
  'process.on("SIGINT", () => forward("SIGINT"));',
  'child.on("error", error => { process.stderr.write("root bootstrap spawn failed: " + error.message + "\\n"); process.exit(70); });',
  'child.on("exit", code => { process.exit(typeof code === "number" ? code : 70); });',
];

// ---------------------------------------------------------------------------
// Ownership helpers shared by the gate runner and the seal pipeline.

function claimList(inspected) {
  return inspected && Array.isArray(inspected.claims) ? inspected.claims : null;
}

export async function inspectAllClaims(ownership, packageId) {
  try {
    return claimList(await ownership.inspectClaims(packageId ? { packageId } : {}));
  } catch {
    return null;
  }
}

// The reservation must cover this process's actual lifecycle share: the policy is
// computed from total memory minus the capacity claims already held. A malformed
// claim inspection returns null so the caller fails instead of assuming empty.
export function stageCapacityRequest(claims) {
  if (!Array.isArray(claims)) return null;
  const held = claims.filter((claim) => claim?.kind === 'capacity');
  const policy = calculateResourcePolicy({
    physicalMemoryBytes: totalmem(),
    held: {
      memoryBytes: held.reduce((total, claim) => total + (claim.reservations?.memoryBytes || 0), 0),
      tasks: held.reduce((total, claim) => total + (claim.reservations?.tasks || 0), 0),
    },
  });
  return { memoryBytes: policy.lifecycleMemoryBytes, tasks: policy.lifecycleTasks };
}

// The prior drain is established from the actual ownership registry, never from a
// state string: a missing previous phase or token is unknown, a held running claim
// is live, and only an absent claim confirms drained.
export async function resolveDrain({ ownership, state, wave }) {
  const previous = state?.previous_phase ?? null;
  if (!previous) return 'unknown';
  const token = previous.token ?? null;
  if (!token) {
    const declared = previous.drain ?? previous.status ?? null;
    if (declared === 'live' || declared === 'pending') return 'live';
    return 'unknown';
  }
  const claims = await inspectAllClaims(ownership, wave?.package_ref ?? null);
  if (claims === null) return 'unknown';
  const claim = claims.find((entry) => entry?.token === token) ?? null;
  if (!claim) return 'drained';
  return claim.running === true ? 'live' : 'unknown';
}

// Release requires a positive 'released' status; a missing claim is a failure, not
// a silent success, so the caller retains the phase.
export async function releaseWorkspace({ ownership, member, workspace }) {
  const claim = workspace?.claim;
  if (!claim?.token) return false;
  const backend = member?.backend ?? workspace?.backend ?? 'overlayfs';
  if (backend === 'overlayfs') {
    try {
      const phases = createOverlayPhases({ ownership });
      const result = await phases.endPhase({ token: claim.token, epoch: claim.epoch, drain: 'confirmed' });
      return result?.status === 'released';
    } catch {
      return false;
    }
  }
  try {
    const result = await ownership.releaseClaim({ token: claim.token, epoch: claim.epoch, drain: 'confirmed' });
    return result?.status === 'released';
  } catch {
    return false;
  }
}

export async function releaseCapacity(ownership, reservation) {
  const claim = reservation?.claim ?? reservation;
  if (!claim?.token) return false;
  try {
    const result = await ownership.releaseClaim({ token: claim.token, epoch: claim.epoch, drain: 'confirmed' });
    return result?.status === 'released';
  } catch {
    return false;
  }
}

export function createWaveReviewRuntime(deps) {
  const {
    nativeCommand, streamTask, save, read, runFileOf, assertWaveLease,
    loadRun, runCommand, readOwnershipClaimsSync, waveInvalid, timestamp,
    runLockedMutation, waveClaimToken
  } = deps;

  // The canonical stage identity for one phase. Candidate stages carry the
  // integration repair number; step stages carry the padded step number. The
  // label is validated against the canonical label so a stale or malformed
  // oracle cannot silently select a different review state.
  function stageIdentity(input) {
    const phase = input.phase;
    const role = ROLE_BY_PHASE[phase];
    if (!role) throw waveInvalid('stage-phase-unknown', `Stage phase ${JSON.stringify(phase)} is not a native stage phase.`,
      `Use one of ${Object.keys(ROLE_BY_PHASE).join(', ')}.`);
    if (input.wave_id === undefined || input.wave_id === null)
      throw waveInvalid('wave-id-invalid', 'A stage run requires wave_id.', 'Prepare the wave record before starting a stage.');
    if (!Number.isInteger(input.step_number) || input.step_number < 1)
      throw waveInvalid('stage-step-invalid', 'A stage run requires a positive step_number.', 'Pass the wave member step number.');
    if (input.attempt_id === undefined || input.attempt_id === null)
      throw waveInvalid('stage-attempt-invalid', 'A stage run requires attempt_id.', 'Pass the wave member attempt id.');
    if (!Number.isInteger(input.stage_attempt) || input.stage_attempt < 1)
      throw waveInvalid('stage-attempt-invalid', 'stage_attempt must be a positive integer.', 'Increment the stage attempt for a retry.');
    const stage = input.stage;
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage))
      throw waveInvalid('stage-metadata-invalid', 'A stage run requires stage metadata.', 'Build the stage record from the review state.');
    if (!Number.isInteger(stage.round) || stage.round < 1)
      throw waveInvalid('stage-round-invalid', 'stage.round must be a positive integer.', 'Read the review state round.');
    if (typeof stage.base !== 'string' || typeof stage.head !== 'string')
      throw waveInvalid('stage-revision-invalid', 'stage.base and stage.head must be recorded revisions.', 'Record the reviewed head from the durable wave record.');
    const subject = stage.subject && typeof stage.subject === 'object' && stage.subject.kind === 'candidate'
      ? stage.subject
      : (asCandidateSubject(input.subject) ?? asCandidateSubject(input.candidate));
    const expectedLabel = subject
      ? stageLabel(input.wave_id, subject, stage.round)
      : stageLabel(input.wave_id, input.step_number, stage.round);
    if (stage.label !== expectedLabel)
      throw waveInvalid('stage-label-invalid', `stage.label ${JSON.stringify(stage.label)} does not match the canonical stage label ${JSON.stringify(expectedLabel)}.`,
        'Use the canonical stage label for the review state.');
    const packet = stage.packet ?? null;
    let assignmentId = `wave:${input.wave_id}/${subject ? `candidate:${subject.repair}` : `step:${String(input.step_number).padStart(3, '0')}`}/phase:${phase}/attempt:${input.stage_attempt}`;
    if (packet && packet.index !== undefined && packet.index !== null) assignmentId += `/packet:${packet.index}`;
    if (input.resume !== undefined && input.resume !== null) assignmentId += `/resume:${input.resume}`;
    return { role, stage, subject, packet, assignmentId };
  }

  return {
    // Bind one review/fix stage to the existing wave route. The implementation
    // run supplies provenance and the effective owner model the fixer inherits;
    // the stage model is recorded as owner_model so step 6's wave binding and
    // lease checks hold, and as review_model/fix_model for nativeCommand.
    async startStage(input) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('startStage input must be an object');
      const { role, stage, subject, packet, assignmentId } = stageIdentity(input);
      // A stage may not start until the preceding subject phase is positively
      // drained. A candidate stage's preceding subject is the candidate repair's
      // run recorded in wave.target.repair; a step stage's preceding subject is
      // the member's run. The subject's run_id is cleared by a legitimate
      // remount, so a non-null run_id means a phase is still held; Runtime.start
      // then validates whatever claim the caller newly holds. Nothing is released
      // or mutated here.
      const wavePath = join(input.package, 'runtime', 'waves', `${input.wave_id}.json`);
      let wave;
      try { wave = read(wavePath); } catch { throw waveInvalid('wave-record-unreadable', `Cannot read the durable wave record runtime/waves/${input.wave_id}.json to verify the preceding subject drain.`, 'Prepare the wave record before starting a stage.'); }
      const previousRunId = subject
        ? wave?.target?.repair?.run_id ?? null
        : wave?.members?.[String(input.step_number)]?.run_id ?? null;
      if (previousRunId !== null) {
        const previous = loadRun(input.package, previousRunId);
        // A run from this same assignment is the stage being replayed, not the
        // preceding member phase; its drain state belongs to the live stage and
        // must not refuse the replay. Runtime.start below remains authoritative
        // for the identity, lease and assignment contract/summary return.
        const sameAssignment = previous?.assignment_id === assignmentId;
        if (!sameAssignment && previous?.phase_drain?.status !== 'confirmed')
          throw waveInvalid('phase-not-drained', 'The preceding member phase has not positively drained.', 'Drain and remount the preceding phase before starting a stage.');
      }
      const implementation = loadRun(input.package, input.implementation_run_id);
      const model = resolveStageModel({ role, review_model: input.review_model,
        fix_model_override: input.fix_model_override, implementation_owner_model: implementation.owner_model });
      const editorModel = input.editor_model ?? implementation.editor_model;
      // Canonical artifact paths: the reviewer's record and every record's fix
      // record come from the public stagePaths defaults; a confirmation round
      // instead names the preceding reviewed label's fix record. Nulls would make
      // the state builder and stage prompt miss the artifact.
      const canonical = stagePaths({
        package: input.package, id: 'stage', step: input.step,
        wave_bindings: { wave_id: input.wave_id, step_number: input.step_number },
        stage: { role, label: stage.label, round: stage.round }
      });
      const precedingFix = precedingReviewedFixLabel(stage.label, stage.round);
      const reviewPath = stage.review_path ?? relative(input.package, canonical.reviewPath);
      const fixPath = stage.fix_path
        ?? (role === 'reviewer' && precedingFix ? `reviews/${precedingFix}-fix.md` : relative(input.package, canonical.fixPath));
      return this.start({
        ...input,
        assignment_id: assignmentId,
        owner_model: model,
        editor_model: editorModel,
        review_model: role === 'reviewer' ? model : null,
        fix_model: role === 'fixer' ? model : null,
        stage: {
          role,
          label: stage.label,
          round: stage.round,
          base: stage.base,
          head: stage.head,
          review_path: reviewPath,
          fix_path: fixPath,
          parents: Array.isArray(subject?.parents) ? subject.parents : Array.isArray(stage.parents) ? stage.parents : [],
          packet,
          expected_ids: Array.isArray(stage.expected_ids) ? stage.expected_ids : [],
          triage_summary: stage.triage_summary ?? null
        }
      });
    },

    // A contained stage launch mirrors the immutable wave-root launch exactly,
    // but selects the role contract and the role's own session, stream and
    // request file. Capacity, deadline, overlay, registration and drain stay the
    // shared policy; only the role identity differs.
    async containedStage(record, prompt) {
      const binding = record.wave_bindings;
      const role = record.stage?.role;
      if (role !== 'reviewer' && role !== 'fixer')
        throw waveInvalid('role-unknown', `Stage record has no reviewer/fixer role (${JSON.stringify(role)}).`, 'Start the stage through startStage.');
      const adapter = this.serviceAdapter;
      const heldClaims = readOwnershipClaimsSync(this.ownershipRoot).filter(claim => claim.kind === 'capacity');
      const policy = calculateResourcePolicy({ physicalMemoryBytes: totalmem(),
        held: { memoryBytes: heldClaims.reduce((total, claim) => total + (claim.reservations?.memoryBytes || 0), 0),
          tasks: heldClaims.reduce((total, claim) => total + (claim.reservations?.tasks || 0), 0) } });
      const reserved = await this.ownership.reserveCapacity({ packageId: binding.package_ref,
        attempt: `${binding.wave_id}:${binding.attempt_id}:${binding.phase}`,
        request: { memoryBytes: policy.lifecycleMemoryBytes, tasks: policy.lifecycleTasks },
        coordinator: binding.coordinator });
      if (reserved?.status === 'queued')
        throw waveInvalid('wave-capacity-queued', `Capacity reservation was refused (${reserved.constraint?.reason || 'queued'}); the run stays blocked and no worker started.`, 'Wait for capacity to drain or reduce the requested lifecycle budget, then relaunch.');
      const claim = reserved?.claim;
      if (reserved?.status !== 'reserved' || !claim || typeof claim.token !== 'string')
        throw waveInvalid('wave-capacity-failed', `Capacity reservation was not confirmed (${reserved?.status || 'unknown'}); the run stays blocked and no worker started.`, 'Recover the wave capacity claim and relaunch.');
      record.capacity_claim = { token: claim.token, epoch: claim.epoch, attempt: claim.attempt ?? binding.attempt_id };
      record.deadline = await this.ensureWaveDeadline(record);
      const { command, args, stream, errors } = nativeCommand(record, role, prompt);
      const workerEnv = { ...process.env, ...artifactEnvironment(record.package), SPEC_RUNTIME_ROLE: role,
        SPEC_RUNTIME_RECORD: runFileOf(record), PI_INTERCOM_SCOPE_ID: record.id, PI_INTERCOM_STABLE_ID: `spec-${role}-${record.id}` };
      // The full environment (which may hold secrets) stays in a mode-0600 file;
      // only sanitized transport names travel in the unit's argv.
      record.service_request = join(record.package, 'runtime/runs', `${record.id}-${role}-request.json`);
      writeFileSync(record.service_request, JSON.stringify({ env: workerEnv, command, args,
        checkout: record.checkout, gitDir: binding.layers?.gitDir ?? null }), { mode: 0o600 });
      const bootstrap = [process.execPath, '-e', ROOT_BOOTSTRAP.join('\n'), record.service_request];
      const argv = binding.layers ? buildOverlayArgv({ token: binding.claim_token, lower: binding.layers.lower,
        upper: binding.layers.upper, work: binding.layers.work, merged: binding.layers.merged, chdir: record.checkout, command: bootstrap }).argv : bootstrap;
      const transport = sanitizeTransport(process.env);
      const started = await adapter.start({ argv, cwd: record.checkout, env: transport, deadline: record.deadline, limits: policy,
        register: serviceRecord => { record.service = serviceRecord; save(record); assertWaveLease(record); return true; } });
      record.service = started?.record ?? record.service;
      if (!started || started.ok !== true || !started.child) {
        save(record);
        throw waveInvalid('wave-service-refused', `Contained stage launch was not confirmed (${started?.reason || started?.status || 'unknown'}); the run stays blocked and no worker started.`, 'Repair the host or wave binding and relaunch.');
      }
      save(record);
      const state = { service: record.service ?? null };
      const task = streamTask(record, role, started.child, { onEvent: this.onWorkerEvent,
        stopSettledGroup: async () => {
          if (!state.service) return false;
          // Only a confirmed stop is cleanup authority; "stop-requested" is not drain proof.
          const stopped = await adapter.stop(state.service, { env: transport, ownershipVerified: true });
          return stopped?.status === 'confirmed';
        } }, { stream, errors });
      task.service = state.service;
      const mainPid = Number.isSafeInteger(started.main_pid) ? started.main_pid
        : (Number.isSafeInteger(started.record?.main_pid) ? started.record.main_pid : null);
      task.workerPid = mainPid;
      return task;
    },

    // A command-only running run record. A step-subject phase also binds to its
    // durable member (wave_bindings) so the next phase can remount from this
    // confirmed drain; a non-step phase carries none. It inherits the wave's
    // original deadline and records the checkout, backend, layers and claim token
    // of the workspace the caller already remounted. The caller owns the claim;
    // this adds no claim beyond the member binding.
    async commandPhase({ packageDir, waveId, subject, workspace, purpose, capacityClaim } = {}) {
      if (typeof packageDir !== 'string' || !packageDir) throw new Error('commandPhase requires packageDir');
      if (typeof waveId !== 'string' || !waveId) throw new Error('commandPhase requires waveId');
      if (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace)) throw new Error('commandPhase requires a workspace');
      const wavePath = join(packageDir, 'runtime', 'waves', `${waveId}.json`);
      let wave;
      try { wave = read(wavePath); } catch { throw waveInvalid('wave-record-unreadable', `Cannot read the durable wave record runtime/waves/${waveId}.json for a command phase.`, 'Prepare the wave record before running a command.'); }
      const deadline = wave?.deadline ?? null;
      // Never renew the wave deadline per command: a command runs inside the
      // retained window or is refused before any unit is spawned.
      if (!deadline || !Number.isSafeInteger(deadline.expires_at))
        throw waveInvalid('wave-deadline-missing', `Wave ${waveId} has no retained deadline; refuse the command before spawning.`, 'Establish the wave deadline before running a command.');
      const overlay = workspace.backend === 'overlayfs';
      const retained = workspace.retained ?? workspace;
      const layers = overlay
        ? (workspace.layers ?? { lower: retained.lower, upper: retained.upper, work: retained.work, merged: retained.merged, gitDir: retained.gitDir ?? null })
        : null;
      // A step-subject command is a real member phase: bind its run to the
      // durable member so the next phase can remount from the confirmed drain.
      // A candidate gate command binds to the target.repair record instead, so
      // the next remount verifies the actual candidate gate claim/run. Any other
      // candidate command (assembly/checks) stays unbound.
      const candidateGate = subject?.kind === 'candidate' && purpose === 'gates' && subject.candidate !== undefined;
      const selected = candidateGate
        ? selectWaveSubject(wave, {
          candidate: subject.candidate,
          step_number: wave.target?.repair?.step,
          attempt_id: wave.target?.repair?.attempt_id
        })
        : null;
      const boundSubject = candidateGate ? selected.subject : subject;
      const member = (subject?.kind === 'step' || candidateGate)
        ? (candidateGate ? boundSubject : (wave?.members?.[String(subject.step)] ?? null))
        : null;
      if (subject?.kind === 'step' && (!member || typeof member !== 'object'))
        throw waveInvalid('wave-member-missing', `Wave ${waveId} has no member for step ${subject.step}.`, 'Prepare the wave member before running a command phase.');
      if (candidateGate && (!member || typeof member !== 'object'))
        throw waveInvalid('wave-candidate-missing', `Wave ${waveId} has no target.repair for candidate ${subject.candidate}.`, 'Prepare the candidate repair record before running a gate phase.');
      const checkoutToken = workspace.claim?.token ?? workspace.claim_token ?? null;
      // The checkout claim's attempt exists only on the live registry claim, so
      // the binding takes it from the claim this workspace actually holds rather
      // than rebuilding it from the workspace identity.
      const inspectedClaims = await inspectAllClaims(this.ownership, wave.package_ref ?? waveId);
      const checkoutClaim = Array.isArray(inspectedClaims)
        ? (inspectedClaims.find(claim => claim?.kind === 'checkout' && claim.token === checkoutToken) ?? null)
        : null;
      const waveBindings = member ? {
        wave_id: waveId,
        generation: wave.generation,
        step_number: boundSubject.step,
        attempt_id: member.attempt_id,
        phase: member.phase,
        ...(candidateGate ? { candidate: selected.candidate } : {}),
        package_ref: wave.package_ref ?? waveId,
        claim_token: waveClaimToken(wave),
        coordinator_epoch: wave.coordinator?.epoch,
        coordinator: wave.coordinator,
        target: wave.target?.id,
        base_commit: wave.target?.base_commit,
        ownership_root: this.ownershipRoot,
        backend: workspace.backend,
        source_common: wave.target?.common ?? null,
        git_dir: workspace.gitDir ?? retained.gitDir ?? null,
        worktree: workspace.backend === 'worktree' ? (workspace.worktree ?? workspace.checkout ?? null) : null,
        layers,
        checkout_claim: checkoutToken,
        checkout_claim_epoch: workspace.claim?.epoch ?? null,
        checkout_claim_attempt: checkoutClaim?.attempt ?? null
      } : null;
      const record = {
        schema_version: 1,
        id: randomUUID(),
        package: packageDir,
        state: 'running',
        mode: 'run-only',
        checkout: workspace.merged ?? workspace.worktree,
        service: null,
        ...(waveBindings ? { wave_bindings: waveBindings } : {}),
        command_phase: {
          wave_id: waveId,
          subject,
          purpose,
          backend: workspace.backend,
          layers,
          claim_token: checkoutToken
        },
        capacity_claim: capacityClaim ?? null,
        deadline,
        started_at: timestamp()
      };
      save(record);
      if (waveBindings) {
        const bound = await runLockedMutation(`${wavePath}.lock`, 'bind-wave-member', {
          file: wavePath, generation: waveBindings.generation, claimToken: waveBindings.claim_token,
          coordinatorEpoch: waveBindings.coordinator_epoch, stepNumber: waveBindings.step_number,
          attemptId: waveBindings.attempt_id, phase: waveBindings.phase,
          candidate: waveBindings.candidate,
          checkoutClaim: checkoutToken, runId: record.id,
        });
        if (!bound || bound.ok !== true)
          throw waveInvalid(bound?.code || 'wave-bind-failed', bound?.message || 'Could not bind the command phase to the wave member.', 'Repair the wave record and retry.');
      }
      return record;
    },

    // Run one command against a command-phase record. A worktree phase reuses
    // the shared runCommand. An overlay phase starts one transient unit with the
    // same overlay argv the wave root builds, pipes its output to a run log, and
    // drains it: an unconfirmed drain returns requires_cancellation so the caller
    // blocks and retains the claim.
    async runPhaseCommand(record, command, timeoutSeconds, signal) {
      if (record === null || typeof record !== 'object') throw new Error('runPhaseCommand requires a record');
      const phase = record.command_phase;
      if (!phase || typeof phase !== 'object') throw new Error('runPhaseCommand requires a command-phase record');
      const timeout = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 120;
      // The shared runCommand only omits the flag after a positively completed
      // cleanup; normalize its success (flag absent) to an explicit false so the
      // caller's confirmed-drain test reads the same shape for both branches.
      if (!phase.layers) {
        const result = await runCommand(record, command, timeout, signal);
        return { ...result, requires_cancellation: result.requires_cancellation === true };
      }
      // A contained command revalidates the full wave lease before the unit is
      // started, so a replaced generation/claim/attempt cannot spawn through the
      // overlay path even though the caller already held the workspace.
      assertWaveLease(record);
      const adapter = this.serviceAdapter;
      const heldClaims = readOwnershipClaimsSync(this.ownershipRoot).filter(claim => claim.kind === 'capacity');
      const policy = calculateResourcePolicy({ physicalMemoryBytes: totalmem(),
        held: { memoryBytes: heldClaims.reduce((total, claim) => total + (claim.reservations?.memoryBytes || 0), 0),
          tasks: heldClaims.reduce((total, claim) => total + (claim.reservations?.tasks || 0), 0) } });
      const deadline = record.deadline;
      const argv = buildOverlayArgv({ token: phase.claim_token, lower: phase.layers.lower, upper: phase.layers.upper,
        work: phase.layers.work, merged: phase.layers.merged, chdir: record.checkout,
        command: ['/bin/bash', '-o', 'pipefail', '-c', command] }).argv;
      const transport = sanitizeTransport(process.env);
      const outputPath = join(record.package, 'runtime', 'runs', `${record.id}-command-${randomUUID()}.log`);
      const started = await adapter.start({ argv, cwd: record.checkout, env: transport, deadline, limits: policy,
        register: serviceRecord => { record.command_service = serviceRecord; save(record); return true; } });
      if (started?.record) record.command_service = started.record;
      save(record);
      if (!started || started.ok !== true || !started.child) {
        const drained = record.command_service
          ? await adapter.drain(record.command_service, { env: transport, ownershipVerified: true }) : null;
        return { exit_code: null, signal: null, error: started?.reason || started?.status || 'command-launch-failed',
          full_output_path: outputPath, requires_cancellation: drained?.status !== 'confirmed' };
      }
      mkdirSync(dirname(outputPath), { recursive: true });
      let error = null, stopRequested = false, timedOut = false, stopResult = null;
      const output = createWriteStream(outputPath, { mode: 0o600 });
      output.on('error', cause => { error ||= cause?.message ?? 'run log write failed'; });
      // Two pipes share one log; `end: false` keeps either stream's EOF from
      // closing the file before the other has drained. The file is finished
      // explicitly after the child closes so no output is dropped.
      started.child.stdout?.pipe(output, { end: false });
      started.child.stderr?.pipe(output, { end: false });
      let reportUnconfirmed;
      const unconfirmed = new Promise(resolveFailure => { reportUnconfirmed = resolveFailure; });
      // The caller's timeout and abort are the only stop authority: the unit is
      // stopped through its owned service and its drain must confirm, or the
      // caller retains the claim for explicit cancellation.
      const stop = reason => {
        if (stopRequested) return;
        stopRequested = true;
        if (reason === 'timeout') { timedOut = true; error ||= 'Command timed out'; }
        else error ||= 'Command interrupted';
        stopResult = Promise.resolve(adapter.stop(record.command_service, { env: transport, ownershipVerified: true }))
          .then(stopped => stopped ?? null, cause => { error ||= cause?.message; return null; })
          .then(stopped => { if (stopped?.status !== 'confirmed') reportUnconfirmed({ exit_code: null, signal: null }); return stopped; });
      };
      const onAbort = () => stop('abort');
      const timer = setTimeout(() => stop('timeout'), timeout * 1000);
      if (signal?.aborted) stop('abort');
      else signal?.addEventListener('abort', onAbort, { once: true });
      const closed = new Promise(resolveDone => {
        started.child.once('error', cause => { error ||= cause?.message; });
        started.child.once('close', (code, sig) => resolveDone({ exit_code: Number.isInteger(code) ? code : null, signal: sig || null }));
        if (started.child.exitCode !== null || started.child.signalCode !== null)
          resolveDone({ exit_code: Number.isInteger(started.child.exitCode) ? started.child.exitCode : null, signal: started.child.signalCode || null });
      });
      const result = await Promise.race([closed, unconfirmed]);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      await new Promise(resolveFinish => output.end(resolveFinish));
      const stopped = stopResult ? await stopResult : null;
      const drained = await adapter.drain(record.command_service, { env: transport, ownershipVerified: true });
      const requiresCancellation = stopRequested
        ? !(stopped?.status === 'confirmed' && drained?.status === 'confirmed')
        : drained?.status !== 'confirmed';
      if (stopRequested && !stopped) error ||= 'Command stop was not confirmed';
      return { ...result, error: error ?? null, ...(timedOut ? { timed_out: true } : {}),
        full_output_path: outputPath, requires_cancellation: requiresCancellation };
    },

    // A command phase completes only on a confirmed drain; any unknown or
    // unconfirmed outcome blocks the record while leaving the unit and claim
    // retained for explicit recovery. A caller that has already returned the
    // checkout claim passes the real `released` list: only then is the confirmed
    // phase-drain proof written, so the member can be remounted later.
    async endCommandPhase(record, { drained, confirmed, released } = {}) {
      if (record === null || typeof record !== 'object') throw new Error('endCommandPhase requires a record');
      const ok = drained === true || confirmed === true;
      record.state = ok ? 'completed' : 'blocked';
      if (!ok) record.error = 'Command phase drain was not confirmed; the unit and claim are retained.';
      record.command_phase = { ...(record.command_phase ?? {}), drain_confirmed: ok };
      record.service = record.command_service ?? null;
      const phase = record.command_phase;
      const binding = record.wave_bindings ?? null;
      const returned = Array.isArray(released)
        ? released.filter(item => item && typeof item.token === 'string' && item.epoch !== undefined)
        : [];
      const checkoutToken = phase?.claim_token ?? null;
      if (ok && checkoutToken && returned.some(item => item.kind === 'checkout' && item.token === checkoutToken)) {
        const receiptFile = join(record.package, 'runtime', 'runs', `${record.id}-phase-drain.json`);
        mkdirSync(dirname(receiptFile), { recursive: true });
        writeFileSync(receiptFile, JSON.stringify({
          schema_version: 1,
          run_id: record.id,
          wave_id: binding?.wave_id ?? phase?.wave_id ?? null,
          attempt_id: binding?.attempt_id ?? null,
          phase: binding?.phase ?? null,
          status: 'confirmed',
          service: record.service,
          layers: binding?.layers ?? phase?.layers ?? null,
          released: returned,
          observed_at: timestamp()
        }, null, 2), { mode: 0o600 });
        record.phase_drain = { status: 'confirmed', path: receiptFile };
      }
      record.finished_at = timestamp();
      save(record);
      return record;
    }
  };
}
