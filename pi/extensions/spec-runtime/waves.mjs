// Wave dispatch controller (step 10). The module owns execution selection, the
// serialized startup/preparation entry, the durable wave record, the initial
// implementing admission, the member-progression barrier/continuation wiring,
// and the FIFO that serializes every public control entry. Explicit member
// repair lives in waves-repair.mjs and is invoked through that serializer;
// recovery and indexing remain deliberately unimplemented so a later packet
// observes its own first failing boundary rather than a partial effect.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { checkPackage } from '../../../scripts/spec-location/index.mjs';
import { inspectProcess } from '../../../scripts/spec-observe/process-identity.mjs';
import { validateStepIndex } from '../../../scripts/spec-observe/steps.mjs';

import { activeWaveRecords, atomic, loadRun, refusalError, serialRunActive } from './runtime.mjs';
import { createMemberEvents } from './waves-events.mjs';
import { createMemberRepair } from './waves-repair.mjs';
import { waveReceipt } from './waves-receipt.mjs';
import { createWaveRecovery } from './waves-recovery.mjs';
import { createWaveBarrier, WAVE_PROGRESSING_STATES } from './waves-barrier.mjs';
import { createWaveContinuation } from './waves-next.mjs';
import { attemptIdFor, createMemberAdmission } from './waves-admission.mjs';
import { ownerFor, pendingInbox, priorProgress } from './startup.mjs';
import { splitModelSelector } from './model-selector.mjs';
import { DEFAULT_WAVE_TIMEOUT_MS } from './linux-resources.mjs';

export const WAVE_RECORD_VERSION = 1;

function notImplemented(name) {
  return Object.assign(new Error(`not-implemented: ${name}`), { code: 'not-implemented', name: 'NotImplementedError' });
}

function invalid(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code, name: 'InvalidExecutionError' });
}

// A needs-preparation refusal is actioned by its reasons, so every throw carries
// the same list the selection would have returned as a terminal receipt.
function preparationError(reasons) {
  const error = invalid('needs-preparation', `wave execution requires concurrency-ready metadata: ${reasons.join(', ')}`);
  error.reasons = [...reasons];
  return error;
}

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const timestamp = (ms = Date.now()) => new Date(ms).toISOString();

// Read a package input once, keeping the raw bytes so `prepare` can return the
// frozen input hashes the derived wave id binds. A parse failure is the same
// index-unreadable refusal the caller-facing path already reported.
function readJsonFile(path) {
  try {
    const raw = readFileSync(path);
    return { ok: true, raw, json: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false, raw: null, json: null };
  }
}

// Wave identity is derived, not supplied: the frozen package inputs hash to a
// stable id so a replay addresses the same run across coordinators. `after` pads
// the first wave boundary; the first 12 hex of the digest disambiguates the input.
export function waveId({ package_ref, index_sha256, evidence_plan_sha256, base_commit, steps, after } = {}) {
  const digest = createHash('sha256')
    .update(JSON.stringify([package_ref, index_sha256, evidence_plan_sha256, base_commit, steps]))
    .digest('hex')
    .slice(0, 12);
  return `wave-${String(after).padStart(3, '0')}-${digest}`;
}

// The caller's stable wave name is validated locally. Derivation and validation
// are separate so a caller can address a replay by derived id or by its own name.
function localWaveId(assignment) {
  const id = assignment?.wave_id ?? assignment;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw invalid('wave-id-invalid', `wave_id must be 1-128 ASCII letters/digits/underscore/hyphen, got ${JSON.stringify(id)}`);
  return id;
}

export function assignmentId({ wave_id, step, phase, attempt, packet, resume }) {
  const parts = [`wave:${localWaveId({ wave_id })}`, `step:${String(step).padStart(3, '0')}`, `phase:${phase}`, `attempt:${attempt}`];
  if (packet != null) parts.push(`packet:${packet}`);
  if (resume != null) parts.push(`resume:${resume}`);
  return parts.join('/');
}

// The attention key dedups one turn per kind/member/transition. Later packets
// persist it durably before sending; packet 2 only fixes the shape.
export function attentionKey({ wave_id, kind, step, transition }) {
  const subject = step == null ? 'wave' : String(step).padStart(3, '0');
  return `${localWaveId({ wave_id })}:${kind}:${subject}:${transition}`;
}

const LIFENESS_UNKNOWN = { status: 'unknown', reason: 'liveness-unknown' };

function validWorkerIdentity(run) {
  const identity = run && run.worker_identity;
  if (!identity || typeof identity !== 'object') return null;
  const { pid, started_at } = identity;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof started_at !== 'string' || started_at.length === 0) return null;
  return { pid, started_at };
}

// Read-only lifecycle classification shared by the controller and the recovery
// path. It never signals, stops, drains or mutates a run: an inconclusive
// observation resolves to unknown so no caller can infer drain or death.
export function phaseLifecycle({ serviceAdapter, processIdentity = inspectProcess } = {}) {
  return {
    async inspect(run, { ownershipVerified = false } = {}) {
      const verified = ownershipVerified === true;
      if (run && run.service) {
        if (!serviceAdapter || typeof serviceAdapter.inspect !== 'function') return LIFENESS_UNKNOWN;
        try {
          return await serviceAdapter.inspect(run.service, { ownershipVerified: verified });
        } catch {
          return LIFENESS_UNKNOWN;
        }
      }
      const identity = validWorkerIdentity(run);
      if (!identity) return LIFENESS_UNKNOWN;
      let observed;
      try {
        observed = await processIdentity(identity.pid);
      } catch {
        return LIFENESS_UNKNOWN;
      }
      if (!observed || observed.pid !== identity.pid) return LIFENESS_UNKNOWN;
      if (observed.state === 'dead') return { status: 'confirmed', reason: 'process-dead' };
      if (observed.state === 'alive' && observed.started_at === identity.started_at)
        return { status: 'live', reason: 'liveness-live' };
      return LIFENESS_UNKNOWN;
    }
  };
}

// Decisions > Execution selection, pure over already-parsed metadata. The
// caller (startup) owns reading/parsing and the inbox check; this function
// classifies only. Returns a selection `{execution}`, a terminal receipt
// `{state, reasons}` or throws a stable-code refusal.
export function selectExecution({ execution = 'auto', validation, activeWaves = [], priorProgress: progressed = false, serialActive = false } = {}) {
  if (!['auto', 'serial', 'waves'].includes(execution))
    throw invalid('invalid-execution', `execution must be auto, serial or waves, got ${JSON.stringify(execution)}`);
  const reasons = Array.isArray(validation?.reasons) ? [...validation.reasons] : [];
  if (!validation?.ok) {
    const error = invalid('index-invalid', `wave metadata is invalid: ${(validation?.errors ?? []).join('; ')}`);
    error.errors = validation?.errors ?? [];
    throw error;
  }
  const ready = validation.concurrency_ready === true;

  if (execution === 'serial') {
    if (activeWaves.length) throw refusalError({ code: 'wave-active',
      message: `Package has active wave record(s) ${activeWaves.map(record => record.wave_id).join(', ')}; a serial run cannot start while a wave is running.`,
      remedy: 'Resume through spec_dispatch startup with execution auto or waves; serial cannot bypass an active wave.' });
    return { execution: 'serial', concurrency_ready: ready, reasons };
  }

  if (execution === 'waves' && reasons.includes('multiple-targets'))
    throw refusalError({ code: 'waves-multiple-targets', message: 'A wave requires one target; the package declares multiple targets.',
      remedy: 'Narrow the wave to a single target or run serially.' });

  if (!ready) {
    if (execution === 'waves') throw preparationError(reasons);
    if (reasons.includes('legacy-serial') || reasons.includes('multiple-targets')) return { execution: 'serial', concurrency_ready: false, reasons };
    return { state: 'needs_preparation', reasons };
  }

  // A prior progress ledger without an active wave is the only reconciliation
  // trigger; an active serial run is refused below.
  if (progressed && activeWaves.length === 0) return { state: 'needs_reconciliation', reasons };
  if (serialActive) throw refusalError({ code: 'serial-run-active', message: 'A serial run is active; a wave cannot start.',
    remedy: 'Await its completion or confirmed cancellation before starting a wave.' });
  return { execution: 'waves', reasons };
}

function unreadable(code, path) {
  return invalid(code, `${path} is missing or unparseable`);
}

// Every caller-supplied wave option is validated locally before any claim or
// filesystem effect: max_parallel is a real 1..16 bound, owner_override is a
// serial-only option, every nonempty selector parses, and the workflow id has
// the same shape Runtime.start enforces.
function validateWaveInputs(input = {}) {
  if (input.max_parallel !== undefined && input.max_parallel !== null
    && (!Number.isInteger(input.max_parallel) || input.max_parallel < 1 || input.max_parallel > 16))
    throw invalid('invalid-max-parallel', `max_parallel must be an integer 1..16, got ${JSON.stringify(input.max_parallel)}`);
  if (input.owner_override !== undefined && input.owner_override !== null)
    throw invalid('owner-override-serial-only', 'owner_override is a serial-only option and is not accepted for wave execution.');
  for (const key of ['owner_model', 'strong_owner_model', 'editor_model', 'review_model', 'fix_model_override', 'scout_model']) {
    const value = input[key];
    if (value === undefined || value === null || value === '') continue;
    try {
      splitModelSelector(value);
    } catch (error) {
      throw invalid('model-selector-invalid', `${key} is not a valid model selector: ${error?.message ?? error}`);
    }
  }
  if (input.workflow_id !== undefined && input.workflow_id !== null
    && (typeof input.workflow_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.workflow_id)))
    throw invalid('workflow-id-invalid', 'workflow_id must be 1-128 ASCII letters/digits/underscore/hyphen.');
}

// Canonical wave target: the integration checkout is the realpathed
// worktree-or-primary, its git common dir is absolutized, and the base is the
// symbolic branch's HEAD observed through argv Git only (never a shell).
function canonicalTarget(target) {
  const integrationCheckout = realpathSync(target.worktree || target.primary);
  const commonRaw = execFileSync('git', ['-C', integrationCheckout, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const common = isAbsolute(commonRaw) ? commonRaw : resolve(integrationCheckout, commonRaw);
  let branch = null;
  try {
    branch = execFileSync('git', ['-C', integrationCheckout, 'symbolic-ref', '--quiet', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    branch = null;
  }
  const baseCommit = execFileSync('git', ['-C', integrationCheckout, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { integration_checkout: integrationCheckout, common, branch, base_commit: baseCommit };
}

// The controller shape from the Interfaces section. `startup` resolves canonical
// locations, checks the inbox first, reads and parses spec-steps.json and
// evidence-plan.json, validates at the actual locations, selects, then opens a
// durable wave: one host check, one package claim, one atomic initial record and
// an ascending initial implementing admission.
export function createWaveController(deps = {}) {
  const { runtime, ownership, hostCheck, integration, checkpoint, location, review, send } = deps;
  // One FIFO promise chain serializes every public entry. A rejected entry does
  // not poison the queue: the tail is re-derived from a settled promise.
  let tail = Promise.resolve();
  let shuttingDown = false;
  const enqueue = task => {
    const run = tail.then(task, task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  // Loaded waves are the ones this controller opened or adopted; progressing()
  // reads their durable state so an open/running wave still reports progress
  // even when no launch is currently active.
  const loadedWaves = new Map();
  const nowMs = () => (deps.now ? deps.now() : Date.now());

  // A control entry (status/cancel/advance/recover) locates its wave from the
  // canonical package, never from a caller-supplied path: `checkPackage` resolves
  // the package_dir, the wave id is validated locally, and the durable record is
  // read through the integration owner. A record whose own `wave_id` disagrees
  // with the requested id is refused rather than trusted. A supplied
  // expected_generation that differs from the durable generation refuses
  // stale-generation BEFORE any write.
  async function locateControl(input = {}) {
    const checked = await checkPackage(input.package, location);
    if (!checked.ok) throw refusalError(checked);
    const packageDir = checked.locations.package_dir;
    const wave_id = localWaveId(input);
    const recordPath = join(packageDir, 'runtime', 'waves', `${wave_id}.json`);
    const record = integration.readWaveRecord(recordPath);
    if (record.wave_id !== wave_id)
      throw invalid('wave-id-mismatch', `Record ${recordPath} names wave ${JSON.stringify(record.wave_id)}, not ${JSON.stringify(wave_id)}.`);
    if (input.expected_generation !== undefined && input.expected_generation !== null
      && input.expected_generation !== record.generation)
      throw invalid('stale-generation', `expected_generation ${input.expected_generation} does not match record generation ${record.generation}.`);
    return { packageDir, recordPath, wave_id, record, locations: checked.locations };
  }

  // `step` for wave cancel and advance accepts a positive decimal step number or
  // the canonical card path, normalized against the index rows. Anything else is
  // refused step-invalid rather than used as a path.
  function normalizeStep(index, packageDir, step) {
    if (step === undefined || step === null) return null;
    const rows = Array.isArray(index?.steps) ? index.steps : [];
    const valid = rows.map(row => Number(row.step)).filter(value => Number.isInteger(value) && value >= 1);
    if (typeof step === 'number' || (typeof step === 'string' && /^\d+$/.test(step.trim()))) {
      const value = Number(step);
      if (!Number.isInteger(value) || value < 1 || !valid.includes(value))
        throw invalid('step-invalid', `step ${JSON.stringify(step)} names no step in the index.`);
      return value;
    }
    if (typeof step === 'string') {
      const normalized = step.replace(/\\/g, '/');
      for (const row of rows) {
        const numeric = Number(row.step);
        if (!Number.isInteger(numeric) || numeric < 1) continue;
        const canonical = row.path ?? `step-${String(numeric).padStart(3, '0')}-subspec.md`;
        const absolute = join(packageDir, canonical);
        if (normalized === canonical || normalized === absolute || normalized === `./${canonical}`) return numeric;
      }
    }
    throw invalid('step-invalid', `step ${JSON.stringify(step)} is not a positive step number or a canonical card path.`);
  }

  async function prepare(input) {
    const checked = await checkPackage(input.package, location);
    if (!checked.ok) throw refusalError(checked);
    const packagePath = checked.locations.package_dir;
    const pending = pendingInbox(packagePath);
    if (pending.length) return { state: 'needs_intake', package: packagePath,
      messages: pending.map(name => join(packagePath, 'inbox', name)),
      next: 'coordinator consumes and routes pending directions before dispatch' };
    const indexRead = readJsonFile(join(packagePath, 'spec-steps.json'));
    const evidenceRead = readJsonFile(join(packagePath, 'evidence-plan.json'));
    if (!indexRead.ok || !evidenceRead.ok) throw unreadable('index-unreadable', !indexRead.ok ? join(packagePath, 'spec-steps.json') : join(packagePath, 'evidence-plan.json'));
    const index = indexRead.json;
    const evidencePlan = evidenceRead.json;
    const validation = validateStepIndex(index, { targets: checked.locations.targets.map(target => target.id), evidencePlan });
    if (!validation.ok) {
      const error = invalid('index-invalid', `wave metadata is invalid: ${validation.errors.join('; ')}`);
      error.errors = validation.errors;
      throw error;
    }
    return {
      packagePath,
      packageRef: checked.locations.package_ref,
      locations: checked.locations,
      index,
      evidencePlan,
      validation,
      index_sha256: sha256(indexRead.raw),
      evidence_plan_sha256: sha256(evidenceRead.raw)
    };
  }

  // An automatic next wave must keep the single package claim the first wave
  // acquired. `inheritedClaim` names it by token, epoch and session; the claim
  // is reused only when the live ownership registry still holds that exact
  // claim (a known live coordinator), otherwise a held/absent claim is reported
  // as a replay or a fail-closed refusal rather than a second acquisition.
  async function reuseInheritedClaim({ packageRef, inheritedClaim, coordinator }) {
    const token = inheritedClaim.token;
    const inherited = inheritedClaim.coordinator ?? {};
    const { claims } = await ownership.inspectClaims({ packageId: packageRef });
    const held = (claims ?? []).find(claim => claim?.kind === 'package' && claim.token === token);
    if (!held) return { status: 'absent', claim: { token } };
    const heldCoordinator = held.coordinator ?? {};
    // The held claim must still be the inherited claim at the creation epoch and
    // session the predecessor record froze, and it must be bound to this live
    // coordinator process. The claim-creation epoch (not the fresh process epoch)
    // is what fences the successor; adoption preserved it on both the claim and
    // the record, so requiring the fresh epoch here would refuse every restart.
    const exactInherited = heldCoordinator.session === inherited.session
      && String(held.epoch) === String(inherited.epoch);
    const currentSession = heldCoordinator.session === coordinator.session;
    const currentProcess = heldCoordinator.pid === coordinator.pid
      && heldCoordinator.started_at === coordinator.started_at;
    if (!exactInherited || !currentSession || !currentProcess) return { status: 'held', claim: held };
    // A reused PID never authorizes the inherited claim: the recorded process
    // must still be observably alive with its exact start time.
    let observed;
    try { observed = await inspectProcess(heldCoordinator.pid); } catch { observed = null; }
    if (!observed || observed.state !== 'alive' || observed.started_at !== heldCoordinator.started_at)
      return { status: 'held', claim: held };
    return { status: 'acquired', claim: held };
  }

  // Update the durable record through the integration owner: re-read for a
  // fresh revision, then require the generation and coordinator session to be
  // unchanged before the mutation. A record owned by someone else is refused
  // rather than overwritten.
  function patchRecord(recordPath, session, mutate) {
    const current = integration.readWaveRecord(recordPath);
    if (current.generation !== 1 || current.coordinator?.session !== session)
      throw invalid('generation-conflict', 'Wave record generation or coordinator session changed underneath the controller.');
    return integration.updateWaveRecord(recordPath, { expectedRevision: current.revision }, draft => {
      if (draft.generation !== 1 || draft.coordinator?.session !== session)
        throw invalid('generation-conflict', 'Wave record generation or coordinator session changed underneath the controller.');
      mutate(draft);
    });
  }

  // Capacity-driven member admission is its own module: the controller owns the
  // durable record and the FIFO, the module owns the bounded, re-read admission
  // cycle (setup, preparation, implementing reservation and batched launch).
  const admissionController = createMemberAdmission({
    runtime, ownership, integration, patchRecord, nowMs, assignmentId, pendingInbox
  });

  // Re-admit queued members against the current record and capacity. Called
  // when a member progression releases capacity, and externally via
  // `onCapacityReleased`. Unknown capacity admits nothing.
  async function retryQueued(entry) {
    if (!entry?.admission) return;
    try {
      await memberRecovery.retryBlocked(entry);
      await memberEvents.retryQueued(entry);
      await admissionController.admit(entry.admission);
    } catch {
      // A stale guard or unreadable capacity leaves the queued members for the
      // next release; the durable record stays the source of truth.
    }
  }

  // The member-progression consumer. It owns the review/fix/seal sequence for a
  // completed run summary and the durable member updates that accompany it; the
  // controller only routes matching summaries into it here.
  const memberEvents = createMemberEvents({
    runtime, ownership, review, loadRun, pendingInbox, patchRecord,
    nowMs, assignmentId, attentionKey, send
  });

  // The sealed-member barrier owns the integration boundary: once every member
  // is sealed it persists `ready-to-integrate`, emits the one barrier attention
  // and drives assembly → candidate checks → promotion. Recovery and repair stay
  // in the controller's later packets.
  const barrier = createWaveBarrier({
    runtime, ownership, integration, checkpoint, patchRecord, pendingInbox,
    attentionKey, send, nowMs, review, loadRun
  });

  // The durable record's frozen open inputs, captured when a wave opens, are
  // what an automatic next wave reuses: the same package, index/evidence hashes
  // and resolved locations. The continuation boundary is its own module; the
  // controller instantiates it once here with wrappers for the live shutdown
  // flag and the current coordinator.
  const { driveAndContinue } = createWaveContinuation({
    barrier, integration, patchRecord, pendingInbox, canonicalTarget, waveId,
    sha256, nowMs, timestamp, hostCheck, send, loadedWaves, retryQueued, openWave,
    isShuttingDown: () => shuttingDown,
    coordinator: () => (deps.coordinator ? deps.coordinator() : {})
  });

  // Explicit member repair is its own module: it owns the locate/stale guard
  // handoff, the frozen-input, inbox, deadline and claim rechecks, and the
  // repair effect. The controller keeps serialization by wrapping its
  // `advance` in the FIFO.
  const memberRepair = createMemberRepair({
    locateControl, loadedWaves, coordinator: deps.coordinator, readJsonFile, normalizeStep,
    invalid, unreadable, refusalError, sha256, pendingInbox, nowMs, timestamp, ownership,
    assignmentId, patchRecord, memberEvents, driveAndContinue, integration, waveReceipt,
    retryQueued,
    // Safe late closures: `memberRecovery` is declared after this module and
    // only referenced when `advance` runs, so declaration order is unchanged.
    loadOwnedEntry: located => memberRecovery.loadOwnedEntry(located),
    reconcileLaunches: entry => memberRecovery.reconcileLaunches(entry)
  });

  // Recovery is its own module: it owns the locate+stale-generation handoff and
  // the coordinator owner classification. The controller keeps serialization by
  // wrapping its `recover` in the FIFO.
  const memberRecovery = createWaveRecovery({
    locateControl, coordinator: deps.coordinator, waveReceipt, invalid, notImplemented,
    ownership, runtime, integration, lifecycle: deps.lifecycle, loadRun, patchRecord,
    loadedWaves, prepare, nowMs, pendingInbox, assignmentId, driveAndContinue,
    attentionKey, send
  });

  // Open one durable wave: claim the package, freeze the initial record, join
  // the workflow checkpoint, then admit members in ascending order. Setup runs
  // as a provisioning phase; only members whose implementing capacity is
  // reserved get a launch.
  async function openWave({ input, parentSession, packagePath, packageRef, locations, index, validation, index_sha256, evidence_plan_sha256, host, waveSteps, ordinal = 1, inheritedClaim = null }) {
    const steps = (Array.isArray(waveSteps) ? waveSteps : (validation.waves?.[0] ?? [])).map(Number);
    if (!steps.length) throw invalid('wave-empty', 'The first wave has no steps.');
    if (!Number.isInteger(ordinal) || ordinal < 1) throw invalid('wave-ordinal-invalid', `Wave ordinal must be a positive integer, got ${JSON.stringify(ordinal)}.`);
    // The card filename is convention, not caller metadata: every real
    // spec-steps.json row lacks `path`, so Runtime validates the canonical
    // `step-<NNN>-subspec.md` name. A row `path` is preserved when present,
    // falling back to the canonical name derived from the step number.
    const cardPaths = new Map(index.steps.map(row => [
      Number(row.step),
      join(packagePath, row.path ?? `step-${String(Number(row.step)).padStart(3, '0')}-subspec.md`)
    ]));
    const firstRow = index.steps.find(row => Number(row.step) === steps[0]);
    const targetId = firstRow?.repository;
    const target = (locations.targets ?? []).find(entry => entry.id === targetId);
    if (!target) throw invalid('target-missing', `No canonical target for repository ${JSON.stringify(targetId)}.`);
    const canonical = canonicalTarget(target);
    const after = Math.max(...steps);
    const wave_check = (index.wave_checks ?? []).find(check => Number(check.after) === after) ?? null;
    const wave_id = waveId({ package_ref: packageRef, index_sha256, evidence_plan_sha256, base_commit: canonical.base_commit, steps, after });
    // The frozen open inputs a later automatic next-wave open reuses verbatim:
    // the same package, index and evidence hashes, and the resolved locations.
    const openContext = { input, parentSession, packagePath, packageRef, locations, index, validation, index_sha256, evidence_plan_sha256 };

    // Owner routing is the same predicate the serial path uses; the unknown
    // difficulty refusal travels with it. Resolve every selector and validate
    // routing before acquiring the package so a routing refusal leaks no claim.
    const routedOwners = new Map();
    for (const step of steps) routedOwners.set(step, ownerFor(firstRowFor(index, step), input).owner_model);

    // The host policy must carry real per-lifecycle numbers; inventing a
    // default would silently admit more than the host proved it can hold.
    const policy = host.policy ?? {};
    if (!Number.isInteger(policy.lifecycleMemoryBytes) || policy.lifecycleMemoryBytes <= 0
      || !Number.isInteger(policy.lifecycleTasks) || policy.lifecycleTasks <= 0)
      throw invalid('host-policy-invalid', 'Host check returned no valid per-lifecycle resource policy.');
    const admission = host.admission ?? {};
    if (!Number.isInteger(admission.admittedWidth) || admission.admittedWidth < 0)
      throw invalid('host-policy-invalid', 'Host check returned no valid admitted width.');

    const coordinator = deps.coordinator ? deps.coordinator() : {};
    if (!coordinator || typeof coordinator.session !== 'string' || coordinator.epoch === undefined || coordinator.epoch === null)
      throw invalid('coordinator-missing', 'Wave execution requires an observable coordinator identity.');
    const ownSession = coordinator.session;
    // Effective epoch. A native open uses the fresh process epoch; an inherited
    // automatic next-wave open replaces it below with the held claim's creation
    // epoch, which adoption preserved on both the claim and the predecessor
    // record. The record, admission context and runtime starts all fence on this
    // effective epoch.
    let epoch = coordinator.epoch;
    const startedAt = timestamp(nowMs());
    const recordPath = join(packagePath, 'runtime', 'waves', `${wave_id}.json`);

    // The admission context this controller saves on the loaded entry: rebuilt
    // identically on open and replay so a later capacity release retries the
    // same record, package and claim.
    const admissionContext = claim => ({
      recordPath, session: ownSession, parentSession,
      packagePath, packageRef, wave_id, cardPaths, input, policy, admission,
      coordinator: { ...coordinator, epoch }, targetId, claimToken: claim, epoch
    });

    // One package claim. An inherited claim is reused only when the ownership
    // registry still holds exactly this package claim at the frozen token,
    // epoch and session, so an automatic next wave keeps the one claim the
    // first wave acquired rather than acquiring a competing one. Otherwise a
    // held claim owned by another live coordinator fails closed; a held claim
    // owned by this same coordinator session is a replay that returns the
    // already-loaded receipt without a second launch.
    const acquired = inheritedClaim
      ? await reuseInheritedClaim({ packageRef, inheritedClaim, coordinator })
      : await ownership.acquirePackage({ packageId: packageRef, packagePath, coordinator });
    if (acquired.status !== 'acquired') {
      const claimCoordinator = acquired.claim?.coordinator ?? {};
      const own = claimCoordinator.session === ownSession && String(claimCoordinator.epoch) === String(epoch);
      if (own && existsSync(recordPath)) {
        const loaded = integration.readWaveRecord(recordPath);
        loadedWaves.set(wave_id, { waveId: wave_id, recordPath, packagePath, session: ownSession,
          admission: admissionContext(acquired.claim?.token ?? loaded.claim_token), openContext });
        return waveReceipt(loaded, recordPath, { loaded: true });
      }
      throw refusalError({ code: 'package-owned',
        message: `Package ${packageRef} is already claimed by another live coordinator; refusing to open a competing wave.`,
        remedy: 'Wait for the owning coordinator to finish or recover the wave before retrying.' });
    }
    // After a verified inherited claim, the successor record, admission and
    // runtime starts are fenced by the claim-creation epoch, not the fresh
    // process epoch.
    if (inheritedClaim && acquired.claim?.epoch !== undefined && acquired.claim?.epoch !== null)
      epoch = acquired.claim.epoch;
    const claimToken = acquired.claim?.token ?? null;
    if (!claimToken) throw invalid('claim-token-missing', 'Package claim carried no token.');

    const members = {};
    for (const step of steps) {
      members[String(step)] = {
        step,
        attempt: 1,
        attempt_id: attemptIdFor(step, 1),
        phase: 'queued',
        queue_reason: null,
        transitions: [{ phase: 'queued', at: startedAt, reason: null }],
        owner_model: routedOwners.get(step) ?? null,
        resume: 0,
        run_id: null,
        implementation_run_id: null,
        base_commit: canonical.base_commit,
        head_commit: null,
        sealed_head: null,
        retention_ref: null,
        review_artifacts: [],
        ownership_adaptations: [],
        repair: null,
        blocking_reason: null,
        interrupted_at: null,
        workspace: null,
        preparation_receipt: null
      };
    }

    const explicitCap = Number.isInteger(input.max_parallel) ? input.max_parallel : null;
    const effectiveLimits = {
      software_ceiling: host.softwareCeiling ?? policy.softwareCeiling ?? 16,
      explicit_cap: explicitCap === null ? null : { value: explicitCap, source: 'run' },
      memory: { pool_bytes: policy.poolMemoryBytes ?? null, per_lifecycle_bytes: policy.lifecycleMemoryBytes, slots: policy.slots?.memory ?? null },
      tasks: { pool: policy.aggregateTasks ?? policy.limits?.tasks ?? null, per_lifecycle: policy.lifecycleTasks, slots: policy.slots?.tasks ?? null },
      binding: admission.binding ?? policy.binding ?? null,
      source: 'host-policy'
    };

    const record = {
      version: WAVE_RECORD_VERSION,
      wave_id,
      generation: 1,
      revision: 0,
      state: 'open',
      transitions: [{ state: 'open', at: startedAt }],
      package_ref: packageRef,
      package: packagePath,
      claim_token: claimToken,
      workflow_id: input.workflow_id ?? null,
      execution: 'waves',
      isolation_requested: input.isolation ?? null,
      coordinator: { session: ownSession, epoch, process_identity: { pid: coordinator.pid ?? null, started_at: coordinator.started_at ?? null } },
      inputs: { index_sha256, evidence_plan_sha256 },
      ordinal,
      after,
      steps,
      wave_check,
      target: {
        id: targetId,
        common: canonical.common,
        integration_checkout: canonical.integration_checkout,
        branch: canonical.branch,
        base_commit: canonical.base_commit,
        backend: input.isolation ?? 'auto',
        capability: host.overlay ?? null,
        candidate_commit: null,
        candidate_tree: null,
        integration: null,
        promotion: null,
        repair: null
      },
      host: host.host ?? { host_id: null, boot_id: null, uid: null },
      timeout_ms: DEFAULT_WAVE_TIMEOUT_MS,
      deadline: null,
      started_at: startedAt,
      requested_width: steps.length,
      admitted_width: admission.admittedWidth,
      software_ceiling: effectiveLimits.software_ceiling,
      effective_limits: effectiveLimits,
      models: {
        owner_model: routedOwners.get(steps[0]) ?? input.owner_model ?? null,
        strong_owner_model: input.strong_owner_model ?? null,
        editor_model: input.editor_model ?? null,
        review_model: input.review_model ?? null,
        fix_model_override: input.fix_model_override ?? null,
        scout_model: input.scout_model ?? null,
        child_extensions: input.child_extensions ?? []
      },
      instructions: input.instructions ?? null,
      members,
      effects: {},
      attention: {}
    };
    // The only controller-written snapshot: later changes go through
    // updateWaveRecord so a Runtime-owned revision is never clobbered.
    atomic(recordPath, record);
    loadedWaves.set(wave_id, { waveId: wave_id, recordPath, packagePath, session: ownSession, admission: admissionContext(claimToken), openContext });

    // Join the workflow checkpoint as a working wave worker, reusing the
    // existing obligation, inbox and input revision rather than rewriting them.
    if (input.workflow_id) {
      const existing = (() => { try { return checkpoint.readCheckpointRecord(packagePath, input.workflow_id) ?? {}; } catch { return {}; } })();
      const workers = Array.isArray(existing.workers) ? existing.workers.filter(worker => worker?.id !== wave_id) : [];
      workers.push({ id: wave_id, kind: 'wave', state: 'working' });
      checkpoint.recordCheckpoint({
        package: packagePath,
        workflow_id: input.workflow_id,
        expected_revision: existing.revision ?? 0,
        state: 'waiting-worker',
        obligation: existing.obligation ?? null,
        inbox: existing.inbox ?? {},
        reconciles_input_revision: existing.input_revision ?? 0,
        workers,
        coordinator_session: ownSession,
        checkout: canonical.integration_checkout
      });
    }

    // Capacity-driven admission: the initial open and every later capacity
    // release share the same bounded, re-read routine.
    await admissionController.admit(admissionContext(claimToken));
    return waveReceipt(integration.readWaveRecord(recordPath), recordPath);
  }

  // A fresh startup with no active wave may re-enter after a predecessor
  // integrated while no continuation ran (for example the automatic next wave
  // was suppressed). Select that predecessor's highest-ordinal integrated
  // record whose frozen inputs match the prepared validation, whose successor
  // still exists there, and whose package claim is still held at the record's
  // frozen token, creation epoch and session; adopt the dead owner before
  // continuing, and only ever launch the successor wave from here.
  async function resumeIntegratedPredecessor({ packagePath, packageRef, validation, index_sha256, evidence_plan_sha256 }) {
    const dir = join(packagePath, 'runtime', 'waves');
    if (!existsSync(dir)) return null;
    const own = deps.coordinator ? deps.coordinator() : null;
    const candidates = [];
    for (const name of readdirSync(dir)) {
      if (!/^[A-Za-z0-9_-]{1,128}\.json$/.test(name)) continue;
      const recordPath = join(dir, name);
      let record;
      try { record = integration.readWaveRecord(recordPath); } catch { continue; }
      if (!record || record.state !== 'integrated') continue;
      if (record.package_ref !== packageRef) continue;
      if (record.inputs?.index_sha256 !== index_sha256) continue;
      if (record.inputs?.evidence_plan_sha256 !== evidence_plan_sha256) continue;
      const ordinal = Number(record.ordinal ?? 1);
      if (!Number.isInteger(ordinal) || ordinal < 1) continue;
      const successor = validation?.waves?.[ordinal];
      if (!Array.isArray(successor) || successor.length === 0) continue;
      candidates.push({ record, recordPath, wave_id: record.wave_id, ordinal });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.ordinal - a.ordinal);
    let claims = [];
    try { claims = (await ownership.inspectClaims({ packageId: packageRef }))?.claims ?? []; }
    catch { return null; }
    for (const candidate of candidates) {
      const held = claims.find(claim => claim?.kind === 'package' && claim.token === candidate.record.claim_token);
      if (!held) continue;
      if (String(held.epoch) !== String(candidate.record.coordinator?.epoch)) continue;
      if (held.coordinator?.session !== candidate.record.coordinator?.session) continue;
      // The stored owner is opaque evidence. It is positively dead only when a
      // live observation reports dead for the exact stored pid, and the stored
      // pid/start pair is itself valid. Anything else -- unknown, a different
      // pid, a live pid with a mismatched start, or a malformed pair -- is
      // fail-closed: never adopted.
      const stored = candidate.record.coordinator?.process_identity;
      const storedValid = Number.isSafeInteger(stored?.pid) && stored.pid > 0
        && typeof stored.started_at === 'string' && stored.started_at.length > 0;
      let observed = null;
      if (storedValid) {
        try { observed = await inspectProcess(stored.pid); } catch { observed = null; }
      }
      const positivelyDead = storedValid && observed
        && observed.state === 'dead' && observed.pid === stored.pid;
      const sessionMatches = held.coordinator?.session === candidate.record.coordinator?.session;
      const ours = !!own && sessionMatches && held.coordinator?.session === own.session;
      // A different live session may not touch the record; only a positively
      // dead owner may be adopted by a differing session. A same-session
      // candidate still requires exact live ownership checks at load time.
      if (!ours && !positivelyDead) continue;
      // A positively dead owner is adopted even in the same session, so its
      // process identity is repaired before the entry is driven.
      const requiresAdoption = positivelyDead;
      return { packageDir: packagePath, recordPath: candidate.recordPath, ...candidate, requiresAdoption };
    }
    return null;
  }

  async function startup(input = {}, parentSession) {
    return enqueue(async () => {
      const prepared = await prepare(input);
      if (prepared.state) return prepared;
      const { packagePath, packageRef, locations, index, validation, index_sha256, evidence_plan_sha256 } = prepared;
      const activeWaves = activeWaveRecords(packagePath);
      const execution = input.execution ?? 'auto';
      const serialActive = serialRunActive(packagePath);
      // A fresh startup with no active wave may be resuming an integrated
      // predecessor whose successor never opened. Verify that restart boundary
      // before selection so a genuine predecessor is not misclassified as
      // prior progress (needs_reconciliation). Only compute -- and only relax
      // priorProgress for -- the exact non-serial, no-active-wave, healthy-
      // validation case; every other input keeps selectExecution's behavior.
      const couldHoldPredecessor = execution !== 'serial' && activeWaves.length === 0 && !serialActive && validation?.concurrency_ready === true;
      const predecessor = couldHoldPredecessor
        ? await resumeIntegratedPredecessor({ packagePath, packageRef, validation, index_sha256, evidence_plan_sha256 })
        : null;
      const selection = selectExecution({
        execution, validation,
        activeWaves,
        priorProgress: priorProgress(packagePath) && !predecessor,
        serialActive
      });
      // Every terminal selection (needs_intake, needs_preparation,
      // needs_reconciliation) is a receipt, not a fall-through to the wave path.
      if (selection.state) return selection;
      if (selection.execution === 'serial') {
        // Runtime.startup owns owner routing and its own refusals; the wave layer
        // only augments the receipt with the execution decision.
        const receipt = await runtime.startup(input, parentSession);
        return { ...receipt, execution: 'serial', concurrency_ready: validation.concurrency_ready, reasons: selection.reasons };
      }
      // Wave path. Readiness ordering is retained: local validation, one host
      // check, then the review-model gate, all before any claim or launch.
      validateWaveInputs(input);
      // An existing nonterminal wave with no serial run active is recovered in
      // place: startup is already serialized by the FIFO, so the recovery path
      // is invoked directly without enqueuing and without a new claim, host
      // check or launch.
      if (activeWaves.length > 0) {
        if (activeWaves.length > 1)
          throw invalid('multiple-active-waves', `startup found ${activeWaves.length} active wave records; exactly one is recoverable.`);
        const active = activeWaves[0];
        if (!Number.isInteger(active.generation) || active.generation < 1)
          throw invalid('wave-record-unreadable', `The active wave record ${active.wave_id} has no usable generation.`);
        const recovery = await memberRecovery.recover({ package: packagePath, wave_id: active.wave_id, expected_generation: active.generation });
        return { ...recovery, loaded: true };
      }
      // No active wave: an integrated predecessor may still be waiting for its
      // successor (for example the automatic next-wave continuation was
      // suppressed). Load its owned entry -- enforcing live process identity --
      // and let the existing continuation open the successor without opening
      // wave 1 again. Every host/inbox/frozen-input guard stays in the
      // continuation; this path adds no progression logic of its own.
      if (predecessor) {
        // A live same-session predecessor may be loaded directly; a positively
        // dead owner is first adopted by the existing recovery path (which
        // rebinds claims, repairs the process identity and persists the
        // outcome) with its own continuation deferred, so exactly one
        // continuation can run below against the freshly read record.
        let loaded = predecessor;
        if (predecessor.requiresAdoption) {
          await memberRecovery.recover({
            package: packagePath,
            wave_id: predecessor.wave_id,
            expected_generation: predecessor.record.generation
          }, { deferContinuation: true });
          const fresh = integration.readWaveRecord(predecessor.recordPath);
          loaded = { ...predecessor, record: fresh };
        }
        const entry = await memberRecovery.loadOwnedEntry(loaded);
        // An adopted predecessor resumes under the explicitly supplied current
        // workflow. The original checkpoint stays untouched (it is written only
        // when a wave opens); only the continuation context's frozen input is
        // rebound so a supplied workflow_id can drive the successor.
        if (predecessor.requiresAdoption && typeof input.workflow_id === 'string' && input.workflow_id.length > 0
          && entry.openContext && entry.openContext.input) {
          entry.openContext.input = { ...entry.openContext.input, workflow_id: input.workflow_id };
        }
        const continued = await driveAndContinue(entry);
        if (continued && typeof continued === 'object' && continued.wave_id) return continued;
        return waveReceipt(loaded.record, loaded.recordPath);
      }
      const host = hostCheck ? await hostCheck({ readyMembers: deriveWaveWidth(validation), explicitCap: input.max_parallel ?? null }) : null;
      if (!host || typeof host !== 'object') throw invalid('host-check-missing', 'Wave execution requires a host check result.');
      if (host.status !== 'ready') return { state: 'setup-required', reason: host.reason, remedy: host.remedy };
      if (!input.review_model) throw refusalError({ code: 'review-model-required', message: 'A wave requires an explicit review_model.',
        remedy: 'Pass review_model to spec_dispatch startup.' });
      return openWave({ input, parentSession, packagePath, packageRef, locations, index, validation, index_sha256, evidence_plan_sha256, host });
    });
  }

  // An open or running wave is progressing even when no launch is currently
  // active (e.g. every member is provisioned and waiting to be admitted).
  function progressing() {
    for (const entry of loadedWaves.values()) {
      try {
        const record = integration.readWaveRecord(entry.recordPath);
        if (WAVE_PROGRESSING_STATES.has(record.state)) return true;
      } catch {
        // An unreadable record cannot be shown progressing; a later reconcile
        // packet owns its classification.
      }
    }
    return false;
  }

  return {
    startup,
    // `advance` (explicit member repair) and `recover` (owner classification)
    // are implemented in their own modules; the controller only serializes them.
    advance(input = {}) {
      return enqueue(() => memberRepair.advance(input));
    },
    recover(input = {}) {
      return enqueue(() => memberRecovery.recover(input));
    },
    // Cancellation: persist the intent BEFORE any signal, then cancel only the
    // Runtime-active handles this session owns. A package cancel sets the wave
    // cancelled; a step cancel marks only that member cancelled and blocks the
    // wave. Before signalling, the coordinator session must match both the
    // durable record and the loaded entry. Any throw or blocked drain leaves the
    // wave blocked with the affected members' claims retained.
    cancel(input = {}) {
      return enqueue(async () => {
        const { packageDir, recordPath, wave_id, record } = await locateControl(input);
        // Terminal cancellation is read-only and idempotent: a wave that is
        // already cancelled or integrated has no live effect to cancel, so
        // return the current receipt without touching effects, transitions,
        // members or signals.
        if (record.state === 'cancelled' || record.state === 'integrated')
          return waveReceipt(record, recordPath);
        const table = new Map(loadedWaves);
        const entry = table.get(wave_id) ?? null;
        const coordinator = deps.coordinator ? deps.coordinator() : {};
        const ownSession = coordinator?.session ?? null;
        const recordSession = record.coordinator?.session ?? null;
        const entrySession = entry?.session ?? null;
        if (!ownSession || recordSession !== ownSession || (entry && entrySession !== ownSession))
          throw invalid('coordinator-conflict', `Wave ${wave_id} is owned by a different coordinator session; refusing to cancel.`);

        const step = input.step === undefined || input.step === null
          ? null
          : normalizeStep((() => { try { return readJsonFile(join(packageDir, 'spec-steps.json')).json; } catch { return null; } })(), packageDir, input.step);
        const packageCancel = step === null;
        const cancelKey = `wave:${wave_id}/cancel${packageCancel ? '' : `:step:${String(step).padStart(3, '0')}`}`;
        const attempted = timestamp(nowMs());
        const blockedForStep = () => [String(step)];
        const selectedSteps = packageCancel
          ? Object.values(record.members ?? {}).filter(member => member?.phase !== 'sealed').map(member => String(member.step))
          : blockedForStep();

        // Patch the intent once: the ledger entry, the wave state transition
        // and the selected members' transitions. Sealed members are untouched
        // and candidate state is preserved apart from the cancel intent.
        patchRecord(recordPath, ownSession, draft => {
          draft.effects = draft.effects ?? {};
          draft.effects.cancel = { kind: 'cancel', assignment_id: cancelKey, intent_at: attempted, outcome: null, observed_at: null };
          if (packageCancel) {
            if (draft.state !== 'cancelled') {
              draft.state = 'cancelled';
              draft.transitions.push({ state: 'cancelled', at: attempted });
            }
          } else if (draft.state !== 'blocked') {
            draft.state = 'blocked';
            draft.transitions.push({ state: 'blocked', at: attempted });
          }
          for (const key of selectedSteps) {
            const member = draft.members?.[key];
            if (!member || member.phase === 'sealed') continue;
            member.phase = 'cancelled';
            member.blocking_reason = null;
            member.transitions.push({ phase: 'cancelled', at: attempted, reason: null });
          }
        });

        // Gather the live run ids for the selected members. Package cancel also
        // targets the candidate repair run. Only handles this Runtime holds are
        // signalled; no pid is ever signalled directly.
        const runIds = [];
        const current = integration.readWaveRecord(recordPath);
        for (const key of selectedSteps) {
          const id = current.members?.[key]?.run_id ?? current.members?.[key]?.implementation_run_id;
          if (typeof id === 'string' && id.length > 0) runIds.push(id);
        }
        if (packageCancel) {
          const repairRun = current.target?.repair?.run_id;
          if (typeof repairRun === 'string' && repairRun.length > 0) runIds.push(repairRun);
        }

        // A run is only counted as drained when its own runtime signal fulfilled
        // with a terminal state AND its wave-bound disk record proves a confirmed
        // phase drain. A run this Runtime does not hold is never signalled; its
        // disk record must independently show a confirmed drain to count. A
        // missing/unknown handle or drain proof is drain-unconfirmed.
        const drainConfirmedFor = (runId, signalResult) => {
          const terminalStates = ['cancelled', 'completed', 'failed'];
          let run = null;
          try { run = loadRun(packageDir, runId); } catch { run = null; }
          const drain = run?.phase_drain;
          if (!run || !run.wave_bindings || drain?.status !== 'confirmed') return false;
          if (signalResult === null) return true; // not owned/signalled: rely on disk proof only
          return signalResult.status === 'fulfilled'
            && typeof signalResult.value?.state === 'string'
            && terminalStates.includes(signalResult.value.state);
        };
        const ownedRunIds = [];
        const cancellations = [];
        for (const runId of runIds) {
          if (!runtime?.active?.has(runId)) continue;
          ownedRunIds.push(runId);
          // Collect even a synchronous orchestration throw into the settled set.
          cancellations.push(Promise.resolve().then(() => runtime.cancel(packageDir, runId)));
        }
        let drainConfirmed = true;
        if (runIds.length) {
          const settled = cancellations.length ? await Promise.allSettled(cancellations) : [];
          drainConfirmed = runIds.every(runId => {
            const index = ownedRunIds.indexOf(runId);
            const signalResult = index === -1 ? null : settled[index];
            return drainConfirmedFor(runId, signalResult);
          });
        }

        const observed = timestamp(nowMs());
        patchRecord(recordPath, ownSession, draft => {
          draft.effects = draft.effects ?? {};
          const intent = draft.effects.cancel ?? { kind: 'cancel', assignment_id: cancelKey, intent_at: attempted };
          draft.effects.cancel = { ...intent, outcome: drainConfirmed ? 'confirmed' : 'drain-unconfirmed', observed_at: observed };
          if (!drainConfirmed) {
            if (draft.state !== 'blocked') {
              draft.state = 'blocked';
              draft.transitions.push({ state: 'blocked', at: observed });
            }
            for (const key of selectedSteps) {
              const member = draft.members?.[key];
              if (!member) continue;
              member.phase = 'blocked';
              member.blocking_reason = 'drain-unconfirmed';
              member.transitions.push({ phase: 'blocked', at: observed, reason: 'drain-unconfirmed' });
            }
          }
        });
        // The package claim is retained; terminal release belongs to a later
        // packet.
        return waveReceipt(integration.readWaveRecord(recordPath), recordPath);
      });
    },
    // Status is a read-only projection of the durable record: no prepare, no
    // inbox mutation, no launch. A foreign coordinator session still observes
    // its receipt bytes.
    status(input = {}) {
      return enqueue(async () => {
        const { recordPath, record } = await locateControl(input);
        return waveReceipt(record, recordPath);
      });
    },
    // Route one run summary into member progression. Synchronous: a wave-less
    // summary returns false; a foreign wave or generation is inert (true); a
    // matching summary enqueues the durable handler behind startup. A handler
    // rejection persists a blocked phase under the patchRecord guard; a guard
    // conflict leaves a foreign record untouched.
    routeNotification(summary) {
      const binding = summary?.wave;
      if (!binding || typeof binding !== 'object' || binding.wave_id == null) return false;
      const entry = loadedWaves.get(binding.wave_id);
      if (!entry) return true;
      if (entry.waveId !== binding.wave_id) return true;
      if (binding.generation !== undefined && binding.generation !== 1) return true;
      // Once shutdown has begun, a recognized wave binding is consumed (true)
      // but never enqueued: no new durable handling, mutation or progression
      // may start while the controller is closing.
      if (shuttingDown) return true;
      enqueue(async () => {
        try {
          await memberEvents.handle(entry, summary);
        } catch (error) {
          // A handler rejection is a durable conflict, not a silent drop: locate
          // this member in the current record and persist it as a blocked phase.
          const step = Number(binding.step_number);
          if (Number.isInteger(step) && step >= 1) {
            try {
              patchRecord(entry.recordPath, entry.session, draft => {
                const member = draft.members?.[String(step)];
                if (!member) return;
                member.phase = 'blocked';
                member.blocking_reason = error?.code ?? 'progression-failed';
                member.blocking_detail = { message: error?.message ?? null };
                member.transitions.push({ phase: 'blocked', at: new Date(nowMs()).toISOString(), reason: member.blocking_reason });
              });
            } catch {
              // A guard conflict means another writer owns the record; never
              // overwrite a foreign record. Leave it for reconciliation.
            }
          }
        }
        // A completed progression may have released the member's implementing
        // capacity; admit the next queued member in ascending order. The barrier
        // then re-checks whether every member is now sealed.
        await retryQueued(entry);
        await driveAndContinue(entry);
      });
      return true;
    },
    progressing,
    // External capacity release: enqueue a retry behind the controller FIFO and
    // return synchronously so a Runtime callback invoked from inside the same
    // FIFO can never deadlock the wave.
    onCapacityReleased() {
      // Capacity released after shutdown began must not drive new retries or
      // progression; return synchronously like the wave-less/empty case.
      if (shuttingDown) return;
      const entries = [...loadedWaves.values()];
      if (!entries.length) return;
      enqueue(async () => {
        for (const entry of entries) await retryQueued(entry);
        for (const entry of entries) await driveAndContinue(entry);
      });
    },
    // Close only this controller's own view. Claims and durable records are left
    // for reconciliation; no foreign process is signalled. The current queue tail
    // drains first, then Runtime cancels only runs this session actually owns
    // (this.active), so a foreign or disk-only pid is never signalled.
    async shutdown() {
      // Setting the flag before awaiting the tail stops an in-flight drive from
      // opening the automatic next wave after this controller began closing.
      shuttingDown = true;
      try { await tail; } catch { /* a prior entry's rejection never blocks shutdown */ }
      // Mark the cancellation as shutdown-initiated so the durable handler keeps
      // the member phase (setting interrupted_at) instead of blocking it.
      memberEvents.interrupt();
      const cancellations = [];
      try {
        if (runtime && typeof runtime.cancel === 'function') {
          for (const [wave_id, loaded] of loadedWaves) {
            const record = (() => { try { return integration.readWaveRecord(loaded.recordPath); } catch { return null; } })();
            if (!record) continue;
            if (record.wave_id !== wave_id) continue;
            if (record.coordinator?.session !== loaded.session) continue;
            const runIds = new Set();
            for (const member of [...Object.values(record.members ?? {}), record.target?.repair]) {
              if (member?.run_id != null) runIds.add(member.run_id);
              if (member?.implementation_run_id != null) runIds.add(member.implementation_run_id);
            }
            for (const runId of runIds) {
              // Only Runs whose loaded identity matches this session and whose
              // active handle belongs to this Runtime are signalled; Runtime.cancel
              // itself refuses a disk-only pid it does not own.
              if (typeof runId !== 'string' || !runtime.active?.has(runId)) continue;
              cancellations.push(runtime.cancel(loaded.packagePath, runId).then(() => null, () => null));
            }
          }
        }
      } catch { /* leave disk phases/claims for reconciliation */ }
      if (cancellations.length) await Promise.allSettled(cancellations);
      loadedWaves.clear();
    }
  };
}

// The first wave's length is the readiness width the host check sees.
function deriveWaveWidth(validation) {
  return validation?.waves?.[0]?.length ?? 1;
}

function firstRowFor(index, step) {
  const row = (index.steps ?? []).find(candidate => Number(candidate.step) === Number(step));
  if (!row) throw invalid('step-missing', `The index declares no step ${step}.`);
  return row;
}
