// Notification-driven member progression for a durable wave. This module is the
// controller's only consumer of Runtime run summaries: it classifies one completed
// (or terminal) member run, advances the review/fix/confirmation sequence and, on
// a clean round, seals the member. It never touches Runtime-owned fields
// (`run_id`, `workspace`, `preparation_receipt`, `deadline`) and never advances
// beyond member progression into integration.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HOST_REMEDIES } from './linux-resources.mjs';

const REPLAY_OUTCOMES = new Set(['observed', 'blocked', 'sealed', 'refused']);
const MEMBER_BLOCKED = 'member-blocked';
const SETUP_REQUIRED = 'setup-required';

const pad3 = value => String(value).padStart(3, '0');
const iso = ms => new Date(ms).toISOString();

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function gitHead(args) {
  try {
    const out = execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'
    }).trim();
    return out || null;
  } catch { return null; }
}

function deadlineMs(deadline) {
  if (deadline == null) return null;
  const value = typeof deadline === 'object' ? deadline.expires_at : deadline;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Resolve the member's private HEAD. A durable member carries either a worktree
// git dir (workspace.gitDir / git_dir) usable via --git-dir, or-- for a plain
// backend:'worktree' workspace whose gitDir is null -- an absolute worktree path
// usable via -C. Command failures yield null; never fall back to the canonical
// repository.
function memberHead(member) {
  const gitDir = member?.workspace?.gitDir ?? member?.git_dir ?? null;
  if (typeof gitDir === 'string' && gitDir) {
    return gitHead(['--git-dir', gitDir, 'rev-parse', 'HEAD']);
  }
  const worktree = member?.workspace?.worktree ?? null;
  if (member?.workspace?.backend === 'worktree' && typeof worktree === 'string' && worktree) {
    return gitHead(['-C', worktree, 'rev-parse', 'HEAD']);
  }
  return null;
}

function capacityRequest(record) {
  const mem = record?.effective_limits?.memory?.per_lifecycle_bytes;
  const tasks = record?.effective_limits?.tasks?.per_lifecycle;
  if (!Number.isInteger(mem) || !Number.isInteger(tasks)) return null;
  return { memoryBytes: mem, tasks };
}

// The durable record stores the coordinator's process evidence nested under
// `process_identity`; ownership admission expects it flattened onto the same
// object as the session and epoch. Flatten here so the reserved claim's identity
// matches the initial admission and later ownership validation.
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

export function createMemberEvents(deps = {}) {
  const {
    runtime, ownership, review, loadRun, pendingInbox, patchRecord,
    nowMs, assignmentId, attentionKey, send
  } = deps;
  const deliver = typeof send === 'function' ? send : () => ({ delivered: false });
  const now = () => (typeof nowMs === 'function' ? nowMs() : Date.now());
  const at = () => iso(now());

  // A shutdown sets this before cancelling its own runs: a cancellation observed
  // while it is set must preserve the member phase instead of blocking it.
  let interrupted = false;

  function readRecord(loaded) { return readJson(loaded.recordPath); }

  function cardPathOf(record, step) {
    const index = readJson(join(record.package, 'spec-steps.json'));
    const row = (index?.steps ?? []).find(entry => Number(entry.step) === Number(step));
    return join(record.package, row?.path ?? `step-${pad3(step)}-subspec.md`);
  }

  function waveIdentity(loaded, record, member, step, phase) {
    return {
      package: loaded.packagePath,
      step: cardPathOf(record, step),
      wave_id: loaded.waveId,
      expected_generation: 1,
      step_number: step,
      attempt_id: member.attempt_id,
      claim_token: record.claim_token,
      coordinator_epoch: record.coordinator?.epoch ?? null,
      ...(phase ? { phase } : {})
    };
  }

  function effectFor(record, assignment) {
    if (!assignment) return null;
    for (const effect of Object.values(record?.effects ?? {})) {
      if (effect?.assignment_id === assignment) return effect;
    }
    return null;
  }

  function writeEffect(loaded, assignment, outcome, extra = {}) {
    if (!assignment) return;
    patchRecord(loaded.recordPath, loaded.session, draft => {
      for (const [key, effect] of Object.entries(draft.effects ?? {})) {
        if (effect?.assignment_id === assignment)
          draft.effects[key] = { ...effect, outcome, observed_at: at(), ...extra };
      }
    });
  }

  function mark(loaded, step, mutate) {
    patchRecord(loaded.recordPath, loaded.session, draft => {
      const member = draft.members?.[String(step)];
      if (!member) return;
      mutate(member, draft);
    });
  }

  function setQueued(loaded, step, reason) {
    mark(loaded, step, member => {
      if (member.phase === 'queued' && member.queue_reason === reason) return;
      member.phase = 'queued';
      member.queue_reason = reason;
      member.transitions.push({ phase: 'queued', at: at(), reason });
    });
  }

  function setBlocked(loaded, step, reason, detail) {
    patchRecord(loaded.recordPath, loaded.session, draft => {
      const member = draft.members?.[String(step)];
      if (!member) return;
      member.phase = 'blocked';
      member.blocking_reason = reason;
      if (detail) member.blocking_detail = detail;
      member.transitions.push({ phase: 'blocked', at: at(), reason });
      draft.state = 'blocked';
      draft.blocking_reason = 'member-blocked';
      const waveBlocked = (draft.transitions ?? []).some(transition => transition.phase === 'blocked');
      if (!waveBlocked) {
        draft.transitions = draft.transitions ?? [];
        draft.transitions.push({ phase: 'blocked', at: at(), reason: 'member-blocked' });
      }
    });
  }

  function emitAttention(loaded, step, kind, extra = {}) {
    const key = attentionKey({
      wave_id: loaded.waveId, kind, step: step ?? null, transition: extra.transition ?? 'wave'
    });
    let first = false;
    patchRecord(loaded.recordPath, loaded.session, draft => {
      draft.attention = draft.attention ?? {};
      if (draft.attention[key]) return;
      draft.attention[key] = { emitted_at: at() };
      first = true;
    });
    if (!first) return;
    const record = readRecord(loaded);
    deliver({
      customType: 'spec-wave',
      content: JSON.stringify({
        kind, wave_id: loaded.waveId, step: step ?? null,
        state: record?.state ?? null, ...extra, record_path: loaded.recordPath
      }),
      display: true
    }, { triggerTurn: true });
  }

  function blockMember(loaded, step, reason, detail) {
    const record = readRecord(loaded);
    setBlocked(loaded, step, reason, detail);
    emitAttention(loaded, step, MEMBER_BLOCKED, {
      reason, transition: `a${record?.members?.[String(step)]?.attempt_id ?? ''}`
    });
  }

  function sealArtifacts(receipt, waveId, step) {
    const paths = [];
    for (const entry of receipt?.reviews ?? []) if (entry?.path) paths.push(entry.path);
    if (receipt?.fix?.path) paths.push(receipt.fix.path);
    paths.push(join('runtime', 'waves', waveId, `step-${pad3(step)}-seal.json`));
    return paths;
  }

  function actionableFindingIds(state) {
    const round = (state.rounds ?? []).find(entry => entry.round === 1) ?? null;
    const accepted = round?.attempts?.find(attempt => attempt.result === 'accepted') ?? null;
    const findings = accepted?.receipt?.payload?.findings ?? accepted?.findings ?? state.findings ?? [];
    return findings.filter(finding => finding?.actionable === true).map(finding => finding.id);
  }

  function firstFixTriage(state) {
    const packet = (state.fix?.packets ?? []).find(entry => (entry.index ?? 1) === 1) ?? null;
    return packet?.receipt?.payload?.triage?.summary ?? null;
  }

  function launchPhase(action) {
    if (action === 'launch-confirmation') return 'confirming';
    if (action === 'launch-fix-packet') return 'fixing';
    return 'reviewing';
  }

  async function readState(loaded, record, member, step) {
    return review.readReviewState({
      packageDir: loaded.packagePath,
      waveId: loaded.waveId,
      step: cardPathOf(record, step),
      member,
      implementationRunId: member.implementation_run_id,
      ownership
    });
  }

  // Apply the review-action table for the member. Returns the durable outcome to
  // record, or null when the action is `wait`/non-terminal and must be re-observed.
  async function driveReview(loaded, step) {
    for (let guard = 0; guard < 32; guard += 1) {
      const record = readRecord(loaded);
      const member = record?.members?.[String(step)];
      if (!member) return null;
      const state = await readState(loaded, record, member, step);
      const action = review.nextReviewAction(state);

      // The receipt is already durable; the member was set to sealed when the
      // `seal` action produced it. This action is a no-op.
      if (action.action === 'sealed') return 'sealed';
      if (action.action === 'wait') return null;
      if (action.action === 'block' || action.action === 'not-eligible') {
        blockMember(loaded, step, action.reason ?? 'stage-blocked');
        return 'blocked';
      }
      if (action.action === 'run-gates') {
        const gated = await runGates(loaded, record, member, step, state, action);
        if (gated) return gated;
        continue;
      }
      if (action.action === 'seal') return seal(loaded, record, member, step, state);
      if (action.action === 'launch-review' || action.action === 'launch-confirmation' || action.action === 'launch-fix-packet')
        return launch(loaded, record, member, step, state, action);
      // A candidate repair is an integration concern, not member progression.
      if (action.action === 'accept-repair') return null;
      return null;
    }
    blockMember(loaded, step, 'progression-unbounded');
    return 'blocked';
  }

  async function runGates(loaded, record, member, step, state, action) {
    const identity = waveIdentity(loaded, record, member, step);
    let result;
    try {
      result = await review.runStageGates({
        runtime, ownership, identity,
        record: loadRun(loaded.packagePath, action.run_id ?? member.implementation_run_id),
        gates: state.gates ?? [], head: action.head ?? null
      });
    } catch (error) {
      blockMember(loaded, step, error?.code ?? 'gate-failed', { message: error?.message ?? null });
      return 'blocked';
    }
    if (result?.state === 'queued') {
      setQueued(loaded, step, result.constraint?.reason ?? 'queued');
      return 'queued';
    }
    return null;
  }

  async function seal(loaded, record, member, step, state) {
    const implementation = loadRun(loaded.packagePath, member.implementation_run_id);
    const identity = waveIdentity(loaded, record, member, step);
    let result;
    try {
      result = await review.sealMember({
        runtime, ownership, identity, record: implementation,
        index: readJson(join(loaded.packagePath, 'spec-steps.json')),
        targets: [record.target?.id].filter(Boolean),
        adaptations: member.ownership_adaptations ?? [],
        state
      });
    } catch (error) {
      blockMember(loaded, step, error?.code ?? 'seal-failed', { message: error?.message ?? null });
      return 'blocked';
    }
    if (result?.state === 'sealed') {
      mark(loaded, step, entry => {
        entry.phase = 'sealed';
        entry.transitions.push({ phase: 'sealed', at: at(), reason: null });
        entry.sealed_head = result.sealed_head ?? entry.sealed_head;
        entry.retention_ref = result.retention_ref ?? entry.retention_ref;
        entry.review_artifacts = sealArtifacts(result, loaded.waveId, step);
        // A seal retried after an undeclared-write block still carries the
        // stale block/queue annotations on the member; a successful seal is
        // terminal for this round, so clear them here.
        delete entry.blocking_reason;
        delete entry.blocking_detail;
        delete entry.queue_reason;
      });
      return 'sealed';
    }
    if (result?.state === 'queued') {
      setQueued(loaded, step, result.constraint?.reason ?? 'queued');
      return 'queued';
    }
    blockMember(loaded, step, result?.reasons?.[0]?.code ?? 'seal-blocked');
    return 'blocked';
  }

  async function launch(loaded, record, member, step, state, action) {
    // In-queue rechecks before any side effect.
    const pending = typeof pendingInbox === 'function' ? pendingInbox(loaded.packagePath) : [];
    if (Array.isArray(pending) && pending.length) {
      setQueued(loaded, step, 'input-pending');
      emitAttention(loaded, step, MEMBER_BLOCKED, { reason: 'input-pending', transition: 'input-pending' });
      return 'queued';
    }
    const expires = deadlineMs(record.deadline);
    if (expires !== null && now() > expires) { blockMember(loaded, step, 'deadline-expired'); return 'blocked'; }

    const phase = launchPhase(action.action);
    const stageAttempt = Number.isInteger(member.stage_attempt) ? member.stage_attempt + 1 : 1;
    const packet = action.packet ?? null;
    const round = action.round ?? (phase === 'fixing' ? 1 : 1);
    const label = action.label ?? review.stageLabel(loaded.waveId, step, round);
    const assignment = assignmentId({
      wave_id: loaded.waveId, step, phase, attempt: stageAttempt, packet: packet?.index
    });
    // A fix packet's base and head are both the member's current private HEAD
    // (the reviewed head for packet 1, the previous packet's commit after it).
    const fixHead = phase === 'fixing' ? memberHead(member) : null;
    const base = phase === 'fixing' ? fixHead : action.base;
    const head = phase === 'fixing' ? fixHead : action.head;
    const expectedIds = phase === 'confirming'
      ? (round === 1 ? [] : actionableFindingIds(state))
      : phase === 'fixing' ? [...(packet?.ids ?? []), ...(packet?.pending_after ?? [])]
        : [];
    const triageSummary = phase === 'fixing' && (packet?.index ?? 1) > 1
      ? (action.triage_summary ?? firstFixTriage(state))
      : null;

    // Persist the phase and the launch intent before remount/reserve/start.
    patchRecord(loaded.recordPath, loaded.session, draft => {
      const entry = draft.members[String(step)];
      entry.phase = phase;
      entry.stage_attempt = stageAttempt;
      entry.queue_reason = null;
      entry.transitions.push({ phase, at: at(), reason: action.reason ?? null });
      draft.effects[`${loaded.waveId}:${entry.attempt_id}:${phase}:${stageAttempt}`] = {
        kind: phase, assignment_id: assignment, intent_at: at(), outcome: null
      };
    });

    try {
      await runtime.remountWaveMember(waveIdentity(loaded, record, member, step, phase));
      const reservation = await ownership.reserveCapacity({
        packageId: record.package_ref ?? loaded.waveId,
        attempt: `${loaded.waveId}:${member.attempt_id}:${phase}`,
        request: capacityRequest(record),
        coordinator: coordinatorIdentity(record)
      });
      if (reservation?.status === 'queued') { setQueued(loaded, step, reservation.constraint?.reason ?? 'queued'); return 'queued'; }
      if (reservation?.status !== 'reserved') {
        blockMember(loaded, step, 'launch-failed', { message: `capacity reservation was not confirmed (${reservation?.status ?? 'unknown'})` });
        return 'blocked';
      }
      await runtime.startStage({
        package: loaded.packagePath,
        step: cardPathOf(record, step),
        wave_id: loaded.waveId,
        expected_generation: 1,
        step_number: step,
        attempt_id: member.attempt_id,
        claim_token: record.claim_token,
        coordinator_epoch: record.coordinator?.epoch ?? null,
        phase,
        implementation_run_id: member.implementation_run_id,
        stage_attempt: stageAttempt,
        review_model: record.models?.review_model,
        fix_model_override: record.models?.fix_model_override,
        editor_model: record.models?.editor_model,
        stage: {
          label, round, base, head,
          ...(packet ? { packet } : {}),
          expected_ids: expectedIds,
          ...(triageSummary ? { triage_summary: triageSummary } : {})
        }
      });
      // The successful start is this attempt's completed effect: persist the
      // launched outcome and observation time. Terminal classification (sealed,
      // blocked) is applied by the later run-summary handler, and a replay is
      // deduped by this recorded outcome.
      writeEffect(loaded, assignment, 'launched');
      return 'observed';
    } catch (error) {
      const code = error?.code ?? 'launch-failed';
      const remedy = Object.prototype.hasOwnProperty.call(HOST_REMEDIES, code);
      setBlocked(loaded, step, code, { message: error?.message ?? null });
      if (remedy) {
        emitAttention(loaded, step, SETUP_REQUIRED, {
          reason: code, remedy: error?.remedy ?? HOST_REMEDIES[code] ?? null, transition: code
        });
      } else {
        const current = readRecord(loaded);
        emitAttention(loaded, step, MEMBER_BLOCKED, {
          reason: code, transition: `a${current?.members?.[String(step)]?.attempt_id ?? ''}`
        });
      }
      return 'blocked';
    }
  }

  async function dispatch(loaded, record, member, step, summary, phase) {
    const runState = summary.state;
    if (runState === 'cancelled') {
      if (interrupted) { mark(loaded, step, entry => { entry.interrupted_at = at(); }); return null; }
      blockMember(loaded, step, 'run-cancelled');
      return 'blocked';
    }
    if (runState === 'blocked') { blockMember(loaded, step, 'drain-unconfirmed'); return 'blocked'; }
    if (runState !== 'completed' && runState !== 'failed') return null;

    if (phase === 'implementing') {
      if (runState === 'failed') {
        blockMember(loaded, step, summary.stop_reason === 'length' ? 'length-stop' : 'run-failed',
          { stop_reason: summary.stop_reason ?? null });
        return 'blocked';
      }
      const head = memberHead(member);
      if (head && head !== member.head_commit) mark(loaded, step, entry => { entry.head_commit = head; });
      return driveReview(loaded, step);
    }
    // reviewing / fixing / confirming: step 8 classifies transport failures and
    // missing receipts from the durable records.
    return driveReview(loaded, step);
  }

  async function handle(loaded, summary) {
    if (!loaded || typeof loaded !== 'object') return false;
    const binding = summary && typeof summary === 'object' ? summary.wave : null;
    if (!binding || typeof binding !== 'object') return false;
    const waveId = loaded.waveId ?? binding.wave_id;
    if (binding.wave_id !== waveId) return true;
    if (binding.generation !== undefined && binding.generation !== 1) return true;

    const record = readRecord(loaded);
    if (!record || record.wave_id !== waveId || record.generation !== 1) return true;
    if (binding.coordinator != null) {
      if (record.coordinator?.session !== loaded.session) return true;
      if (binding.coordinator.session !== loaded.session) return true;
      if (binding.coordinator.epoch !== undefined
        && binding.coordinator.epoch !== record.coordinator?.epoch) return true;
    }
    if (binding.claim_token !== undefined && binding.claim_token !== record.claim_token) return true;

    const step = Number(binding.step_number);
    if (!Number.isInteger(step) || step < 1) return true;
    const member = record.members?.[String(step)];
    if (!member) return true;
    if (binding.attempt_id !== undefined && binding.attempt_id !== member.attempt_id) return true;
    const runId = summary.id ?? summary.run_id ?? null;
    if (member.run_id && runId && member.run_id !== runId) return true;

    const phase = binding.phase ?? member.phase;
    // Only the run that produced the member's current phase may advance it; a
    // replay after the member already transitioned is inert.
    if (member.phase !== phase) return true;

    const assignment = summary.assignment_id
      ?? (phase === 'implementing'
        ? assignmentId({ wave_id: waveId, step, phase: 'implementing', attempt: member.attempt })
        : null);
    const effect = effectFor(record, assignment);
    if (effect && REPLAY_OUTCOMES.has(effect.outcome)) return true;

    const outcome = await dispatch(loaded, record, member, step, summary, phase);
    if (outcome && assignment) writeEffect(loaded, assignment, outcome);
    return true;
  }

  // Ownership-adaptive retry for a member blocked undeclared-write: the
  // caller has already persisted the normalized adaptations, cleared the block
  // and appended the running wave transition, so this re-reads the current
  // member and drives the existing seal directly. Going through driveReview
  // would re-read the still-blocked action table and loop the member blocked
  // forever instead of re-sealing with the fresh adaptations.
  async function retrySeal(loaded, step) {
    const record = readRecord(loaded);
    const member = record?.members?.[String(step)];
    if (!member) return null;
    const state = await readState(loaded, record, member, step);
    // review.sealMember owns attribution and conflict rejection, including any
    // capacity/remount decision inside the existing seal function; no shortcut
    // success is manufactured here.
    const result = await seal(loaded, record, member, step, state);
    return result;
  }

  // Step-less resume for queued members whose implementation already ran: the
  // member is past implementation (a fresh record read is required because the
  // caller's snapshot predates the earlier phases), so driving review resumes
  // its queued review/gate/seal work instead of launching implementation
  // again. A cancelled or integrated wave, or a cancellation effect, is left
  // untouched for the recovery paths that own it.
  async function retryQueued(loaded) {
    const record = readRecord(loaded);
    if (!record || record.state === 'cancelled' || record.state === 'integrated') return;
    for (const key of Object.keys(record.members ?? {}).map(Number).sort((a, b) => a - b)) {
      const member = record.members?.[String(key)];
      if (!member || member.phase !== 'queued') continue;
      if (!member.implementation_run_id) continue;
      await driveReview(loaded, key);
    }
  }

  return {
    handle,
    // Explicit member repair enters the same progression the notification
    // handler uses: the caller has already persisted the member's repair
    // record and cleared its block, so driving review re-reads the new state
    // and launches the repair's fix packet (or resumes its round).
    resumeReview(loaded, step) { return driveReview(loaded, step); },
    retrySeal,
    retryQueued,
    interrupt() { interrupted = true; }
  };
}
