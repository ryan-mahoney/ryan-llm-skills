// Step 8 seal pipeline: diff attribution, pure seal checks, gate runs and the
// accepted-head import. The module never trusts artifact existence; every
// accepted receipt is re-rendered and hashed from its own binding record.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { normalizeWrite, writeConflicts, validateStepIndex } from '../../../scripts/spec-observe/steps.mjs';
import { importSealedHead } from './step-workspaces.mjs';
import { renderReviewMarkdown, renderFixMarkdown, sha256 } from './wave-review.mjs';
import { inspectAllClaims, stageCapacityRequest, resolveDrain, releaseWorkspace, releaseCapacity } from './wave-review-runtime.mjs';
import { nextReviewAction, retainedLayers } from './wave-review-state.mjs';

export { runStageGates } from './wave-review-gates.mjs';

export const RETENTION_REF_PREFIX = 'refs/waves/retained/';

function fail(code, detail, extra = {}) {
  const error = new Error(detail);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function pad3(value) {
  return String(value).padStart(3, '0');
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

function repositoryHead(repo, ref) {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', ref], {
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf8').trim() || null;
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

function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// changedPaths: real Git name-status, never a guessed empty success.

export function changedPaths({ git_dir: gitDir, base, head } = {}) {
  if (typeof gitDir !== 'string' || !gitDir || !base || !head) {
    throw fail('diff-unknown', 'changedPaths requires git_dir, base and head');
  }
  let out;
  try {
    out = runGit(gitDir, ['diff', '--name-status', '-z', '--no-renames', base, head]);
  } catch (error) {
    throw fail('diff-unknown', `git diff ${base}..${head} failed: ${error.message}`);
  }
  const text = Buffer.isBuffer(out) ? out.toString('utf8') : String(out);
  // With -z, records are NUL-terminated; a trailing NUL is expected and a
  // missing terminator means a truncated stream. Empty tokens are never filtered
  // away: an empty status or path is malformed, not a value to skip.
  if (text.length === 0) return [];
  if (text.charAt(text.length - 1) !== '\0') {
    throw fail('diff-unknown', 'malformed git diff output (unterminated record)');
  }
  const tokens = text.split('\0');
  tokens.pop();
  if (tokens.length === 0) return [];
  if (tokens.length % 2 !== 0) throw fail('diff-unknown', 'malformed git diff output (odd field count)');
  const KNOWN = new Set(['A', 'C', 'D', 'M', 'R', 'T', 'U', 'X', 'B']);
  const changes = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index];
    const path = tokens[index + 1];
    const letter = status.charAt(0);
    if (!letter || !KNOWN.has(letter)) {
      throw fail('diff-unknown', `unknown diff status ${JSON.stringify(status)}`);
    }
    if (!path) throw fail('diff-unknown', `malformed diff entry ${JSON.stringify(status)}`);
    changes.push({ path, status: letter, deleted: letter === 'D' });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// attributeWrites: pure diff attribution against the step index.

function normWrite(entry, targets) {
  if (entry === null || entry === undefined) return null;
  try {
    const result = normalizeWrite(entry, { targets });
    if (result && result.ok === false) return null;
    return result?.write ?? result?.parsed ?? result?.value ?? result ?? null;
  } catch {
    return null;
  }
}

function segments(write) {
  return String(write?.path ?? '').split('/').filter(Boolean);
}

function owns(declared, changed) {
  let conflict = false;
  try {
    conflict = Boolean(writeConflicts(declared, changed));
  } catch {
    conflict = false;
  }
  if (!conflict) return false;
  return segments(declared).length <= segments(changed).length;
}

function indexStep(index, number) {
  const list = index?.steps ?? index?.spec_steps ?? index?.entries ?? [];
  return list.find((entry) => {
    const raw = entry?.number ?? entry?.step ?? entry?.id;
    return Number(raw) === Number(number);
  }) ?? null;
}

function declaredWrites(index, number, targets) {
  const entry = indexStep(index, number);
  if (!entry) return [];
  const raw = entry.writes ?? entry.files ?? entry.paths ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((item) => normWrite(item, targets)).filter(Boolean);
}

function normAdaptation(adaptation, targets) {
  if (!adaptation || typeof adaptation !== 'object') return null;
  if (typeof adaptation.path !== 'string' || !adaptation.path) return null;
  if (typeof adaptation.reason !== 'string' || !adaptation.reason) return null;
  if (typeof adaptation.recorded_by !== 'string' || !adaptation.recorded_by) return null;
  const write = normWrite({ path: adaptation.path, deleted: false }, targets);
  if (!write) return null;
  return { ...adaptation, target: write.target, path: write.path };
}

export function attributeWrites({ changedPaths: changed = [], index, targets, step, adaptations = [] } = {}) {
  let waves;
  try {
    const result = validateStepIndex(index, { targets });
    waves = result?.waves ?? [];
  } catch (error) {
    throw fail('diff-unknown', `step index invalid: ${error.message}`);
  }
  if (!Array.isArray(waves) || waves.length === 0) {
    throw fail('diff-unknown', 'step index exposes no waves');
  }
  const stepNumber = Number(step);
  const waveIndex = waves.findIndex((wave) => (wave ?? []).map(Number).includes(stepNumber));
  if (waveIndex < 0) throw fail('diff-unknown', `step ${step} is not present in the step index`);

  const currentWrites = declaredWrites(index, stepNumber, targets);
  const siblingWrites = waves[waveIndex]
    .map(Number)
    .filter((number) => number !== stepNumber)
    .flatMap((number) => declaredWrites(index, number, targets));
  const futureWrites = waves
    .slice(waveIndex + 1)
    .flat()
    .map(Number)
    .flatMap((number) => declaredWrites(index, number, targets));

  const adaptationList = Array.isArray(adaptations) ? adaptations : [];
  const normalizedAdaptations = adaptationList
    .map((adaptation) => normAdaptation(adaptation, targets))
    .filter(Boolean);
  const malformedAdaptation = adaptationList.length !== normalizedAdaptations.length;

  const results = [];
  for (const change of Array.isArray(changed) ? changed : []) {
    if (malformedAdaptation) {
      results.push({ path: change?.path ?? null, status: change?.status ?? null, deleted: change?.deleted === true, attribution: 'diff-unknown' });
      continue;
    }
    const write = normWrite({ path: change?.path, deleted: change?.deleted === true }, targets);
    if (!write) {
      results.push({ path: change?.path ?? null, status: change?.status ?? null, deleted: change?.deleted === true, attribution: 'diff-unknown' });
      continue;
    }
    let attribution = 'undeclared-write';
    let adaptation = null;
    if (currentWrites.some((declared) => owns(declared, write))) {
      attribution = 'owned';
    } else if (siblingWrites.some((declared) => owns(declared, write))) {
      attribution = 'sibling-conflict';
    } else {
      adaptation = normalizedAdaptations.find((a) => a.target === write.target && a.path === write.path) ?? null;
      if (adaptation) {
        const futureConflict = futureWrites.some((declared) => {
          try { return Boolean(writeConflicts(declared, write)); } catch { return false; }
        });
        attribution = futureConflict ? 'adaptation-conflict' : 'adapted';
      }
    }
    const entry = { path: write.path, target: write.target, status: change?.status ?? null, deleted: write.deleted === true, attribution };
    if (adaptation) entry.adaptation = { path: adaptation.path, reason: adaptation.reason, recorded_by: adaptation.recorded_by, recorded_at: adaptation.recorded_at ?? null };
    results.push(entry);
  }
  return results;
}

// ---------------------------------------------------------------------------
// checkSeal: pure. Every failing row is reported, never a short circuit.

const ATTRIBUTION_REASONS = ['undeclared-write', 'sibling-conflict', 'adaptation-conflict', 'diff-unknown'];

// The reviewed head is the head of the last round's accepted reviewer attempt.
// Fix packets and state.fix.head never override it: only a reviewer accepted at
// the round's head proves the reviewed revision.
function reviewedHeadFor(state) {
  if (!state || typeof state !== 'object') return null;
  const rounds = Array.isArray(state.rounds) ? state.rounds : [];
  const last = rounds.length ? rounds[rounds.length - 1] : null;
  const accepted = (Array.isArray(last?.attempts) ? last.attempts : [])
    .find((attempt) => attempt?.result === 'accepted');
  return accepted?.head ?? null;
}

function parsePorcelainZ(status) {
  const untracked = [];
  const tracked = [];
  if (typeof status !== 'string') return { untracked, tracked, unknown: true };
  for (const entry of status.split('\0')) {
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code === '??') untracked.push(path);
    else tracked.push(path);
  }
  return { untracked, tracked, unknown: false };
}

function gateEvidencePassed(entry, head) {
  if (!entry || !head) return false;
  const outcome = entry.outcome ?? entry.status;
  const observed = entry.observedCommit ?? entry.observed_commit ?? entry.commit;
  return outcome === 'passed' && observed === head;
}

// A runtime gate receipt is the receipt recordVerification wrote: success is the
// explicit recorded outcome 'pass' (never 'passed'/'unknown') and both the
// before and after commits must observe the final head.
function runtimeReceiptPassed(receipt, command, head) {
  if (!receipt || !head) return false;
  if (command && receipt.command !== command) return false;
  const before = receipt.before?.commit ?? receipt.before_commit;
  const after = receipt.after?.commit ?? receipt.after_commit;
  return receipt.outcome === 'pass' && before === head && after === head;
}

export function checkSeal(facts = {}) {
  const reasons = [];
  const push = (code, detail, paths) => {
    reasons.push(paths && paths.length ? { code, detail, paths } : { code, detail });
  };
  const state = facts.state ?? {};
  const head = typeof facts.head === 'string' ? facts.head : null;

  // Completion submission present and resolved; remaining_work must be empty.
  const implementation = state.implementation ?? facts.completion ?? null;
  const remaining = implementation?.remaining_work;
  const remainingEmpty = remaining === undefined || remaining === null
    || (Array.isArray(remaining) && remaining.length === 0);
  const completionOk = Boolean(implementation)
    && implementation.status === 'recorded'
    && (implementation.outcome === 'as-specified' || implementation.outcome === 'adapted')
    && remainingEmpty;
  if (!completionOk) {
    push('completion-missing', 'no completed step submission for the member');
  }

  // Prior phase drain. A missing drain record is unknown, not drained: only an
  // explicit confirmed/drained prior phase may proceed.
  const prior = state.previous_phase ?? facts.previous_phase ?? null;
  const drain = prior?.drain ?? prior?.status ?? null;
  if (prior && (drain === 'live' || drain === 'pending')) {
    push('drain-live', 'a prior phase token is still live');
  } else if (prior && (drain === 'confirmed' || drain === 'drained' || prior.drained === true)) {
    // prior phase positively drained
  } else {
    push('drain-unknown', 'the prior phase token drain is not confirmed');
  }

  // Review artifacts: every round needs an accepted reviewer, and every accepted
  // round entry needs its own artifact_checks entry.
  const rounds = Array.isArray(state.rounds) ? state.rounds : [];
  const checks = Array.isArray(facts.artifact_checks) ? facts.artifact_checks : [];
  const checkFor = (runId) => checks.find((check) => check && (check.run_id ?? check.runId) === runId) ?? null;
  for (const round of rounds) {
    const accepted = (round?.attempts ?? []).find((attempt) => attempt?.result === 'accepted');
    if (!accepted) {
      push('review-missing', `round ${round?.round ?? '?'} has no accepted reviewer receipt`);
      continue;
    }
    const runId = accepted.run_id ?? accepted.runId ?? null;
    if (!runId || !checkFor(runId)) {
      push('review-missing', `round ${round?.round ?? '?'} accepted reviewer has no artifact check`);
    }
  }
  if (rounds.length === 0) {
    push('review-missing', 'no review rounds were recorded for the member');
  }
  // A landed fixer packet's own artifact must be checked as well.
  const fixPackets = Array.isArray(state.fix?.packets) ? state.fix.packets : [];
  for (const packet of fixPackets) {
    if (packet?.result !== 'landed') continue;
    const runId = packet.run_id ?? packet.runId ?? null;
    if (!runId || !checkFor(runId)) {
      push('review-missing', `landed fix packet ${runId ?? '?'} has no artifact check`);
    }
  }
  for (const check of checks) {
    const label = check?.run_id ?? check?.path ?? 'unknown';
    if (check?.exists !== true) push('review-missing', `artifact for ${label} is missing`);
    else if (check?.valid !== true) push('stage-receipt-invalid', `artifact for ${label} does not match its binding`);
    else if (check?.stale === true) push('review-stale', `artifact for ${label} is stale`);
  }

  // Final reviewed head must be the private head. A missing reviewed head is
  // stale, never accepted by default.
  const reviewed = reviewedHeadFor(state);
  if (!reviewed || !head || reviewed !== head) {
    push('review-stale', `reviewed head ${reviewed ?? 'missing'} is not the private head ${head ?? 'missing'}`);
  }

  // Fix path: an accepted needs-fix round requires state.fix with an empty
  // pending array and a confirmation that seals the final head.
  const needsFix = rounds.some((round) => (round?.attempts ?? []).some((attempt) => attempt?.result === 'accepted'
    && (attempt?.receipt?.payload?.verdict ?? attempt?.payload?.verdict) === 'needs-fix'));
  if (needsFix) {
    if (!state.fix) {
      push('fix-incomplete', 'a needs-fix round has no recorded fix state');
    } else {
      if (!Array.isArray(state.pending)) {
        push('fix-incomplete', 'the fix record has no pending array');
      } else if (state.pending.length) {
        push('fix-incomplete', `${state.pending.length} fix packet(s) are still pending`);
      }
      let action = null;
      try {
        action = nextReviewAction({ ...state, seal: null });
      } catch {
        action = null;
      }
      if (!action || action.action !== 'seal') {
        push('confirmation-failed', 'the confirmation review did not seal the repaired head');
      } else if (!head || action.head !== head) {
        push('review-stale', `confirmation sealed ${action.head ?? 'missing'}, private head is ${head ?? 'missing'}`);
      }
    }
  }

  // Working tree cleanliness from the seal-phase porcelain output.
  const porcelain = parsePorcelainZ(facts.status);
  if (porcelain.unknown) {
    push('dirty-tracked', 'seal-phase status output is unavailable');
  } else {
    if (porcelain.untracked.length) push('dirty-untracked', 'untracked non-ignored paths remain', porcelain.untracked);
    if (porcelain.tracked.length) push('dirty-tracked', 'tracked modifications remain', porcelain.tracked);
  }

  // Gate evidence at the final head.
  const gates = Array.isArray(facts.gates) ? facts.gates : [];
  const evidenceGates = Array.isArray(facts.evidence_gates) ? facts.evidence_gates : [];
  const completionEvidence = Array.isArray(facts.completion_evidence) ? facts.completion_evidence : [];
  const receipts = Array.isArray(facts.gate_receipts) ? facts.gate_receipts : [];
  const fixEvidence = Array.isArray(facts.fix_evidence) ? facts.fix_evidence : [];
  if (!state.fix) {
    for (const gate of [...gates, ...evidenceGates]) {
      const evidence = completionEvidence.find((entry) => (entry?.id ?? entry?.gate_id) === (gate?.id ?? gate?.command));
      if (!gateEvidencePassed(evidence, head)) {
        push('gate-incomplete', `gate ${gate?.id ?? gate?.command ?? '?'} has no passing evidence at ${head ?? 'HEAD'}`);
      }
    }
  } else {
    for (const gate of gates) {
      const receipt = receipts.find((entry) => runtimeReceiptPassed(entry, gate?.command, head));
      if (!receipt) push('gate-incomplete', `gate ${gate?.command ?? gate?.id ?? '?'} has no runtime receipt at ${head ?? 'HEAD'}`);
    }
    for (const gate of evidenceGates) {
      const evidence = fixEvidence.find((entry) => (entry?.gate_id ?? entry?.id) === (gate?.id ?? gate?.command));
      if (!gateEvidencePassed(evidence, head)) {
        push('gate-incomplete', `gate ${gate?.id ?? '?'} has no fixer evidence at ${head ?? 'HEAD'}`);
      }
    }
  }

  // Attribution: group every blocking category with its paths.
  const changed = Array.isArray(facts.changed_paths) ? facts.changed_paths : [];
  for (const code of ATTRIBUTION_REASONS) {
    const paths = changed.filter((entry) => entry?.attribution === code).map((entry) => entry.path).filter(Boolean);
    if (paths.length) push(code, `${paths.length} path(s) attributed ${code}`, paths);
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// Receipt reconstruction: never trust existence.

function readRunRecord(packageDir, runId, suffix = '') {
  if (!runId) return null;
  return readJson(join(packageDir, 'runtime/runs', `${runId}${suffix}.json`));
}

function collectAccepted(state) {
  const accepted = [];
  for (const round of Array.isArray(state?.rounds) ? state.rounds : []) {
    for (const attempt of Array.isArray(round?.attempts) ? round.attempts : []) {
      if (attempt?.result === 'accepted' || attempt?.accepted === true) accepted.push(attempt);
    }
  }
  const fix = state?.fix ?? null;
  for (const key of ['packets', 'receipts', 'children']) {
    for (const entry of Array.isArray(fix?.[key]) ? fix[key] : []) {
      if (entry?.result === 'accepted' || entry?.result === 'landed' || entry?.accepted === true) accepted.push(entry);
    }
  }
  return accepted;
}

function artifactChecks(packageDir, state) {
  const resolved = collectAccepted(state).map((entry) => {
    const runId = entry?.run_id ?? entry?.runId ?? null;
    return { entry, runId,
      record: readRunRecord(packageDir, runId),
      receipt: readRunRecord(packageDir, runId, '-stage') };
  });

  // The shared fix artifact is rewritten by every accepted fixer packet, so only
  // the last accepted fixer receipt's bytes and hash are authoritative. Earlier
  // fixer receipts keep their bindings but their artifact hash is superseded.
  let lastFixer = null;
  for (const item of resolved) {
    const role = item.receipt?.role ?? item.record?.stage?.role ?? null;
    if (role === 'fixer') lastFixer = item;
  }
  let lastFixRendered = null;
  if (lastFixer?.record && lastFixer?.receipt) {
    try { lastFixRendered = Buffer.from(renderFixMarkdown(lastFixer.record, lastFixer.receipt.payload)); }
    catch { lastFixRendered = null; }
  }

  const checks = [];
  const seen = new Set();
  for (const { entry, runId, record, receipt } of resolved) {
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    const role = receipt?.role ?? record?.stage?.role ?? null;
    const check = { run_id: runId, role, exists: false, valid: false, stale: false };
    checks.push(check);
    // A missing run record or stage receipt refuses the check; it is never a pass.
    if (!record || !receipt) continue;
    const stage = record.stage ?? {};
    const waveId = record.wave_bindings?.wave_id ?? record.wave_id ?? null;
    const bound = receipt.accepted === true
      && receipt.artifact_written === true
      && receipt.run_id === record.id
      && (receipt.assignment_id ?? null) === (record.assignment_id ?? null)
      && receipt.wave_id === waveId
      && receipt.step === (record.step ?? null)
      && (receipt.label ?? null) === (stage.label ?? null)
      && receipt.base === stage.base
      && receipt.head === stage.head
      && receipt.role === stage.role
      && (entry?.base ?? receipt.base) === stage.base
      && (entry?.head ?? receipt.head) === stage.head;
    if (!bound) continue;
    if (typeof receipt.artifact !== 'string' || !receipt.artifact) continue;
    const path = join(packageDir, receipt.artifact);
    if (!existsSync(path)) continue;
    check.exists = true;
    try {
      const bytes = readFileSync(path);
      if (role === 'reviewer') {
        check.valid = Buffer.from(renderReviewMarkdown(record, receipt.payload)).equals(bytes)
          && receipt.artifact_sha256 === sha256(bytes);
      } else if (role === 'fixer') {
        const shared = lastFixRendered !== null && lastFixRendered.equals(bytes);
        const lastHash = !lastFixer || runId !== lastFixer.runId
          || receipt.artifact_sha256 === sha256(bytes);
        check.valid = shared && lastHash;
      }
    } catch {
      check.valid = false;
    }
  }
  return checks;
}

function completionEvidenceFrom(state) {
  const impl = state?.implementation ?? null;
  if (!impl) return [];
  return impl.evidence ?? impl.gates ?? [];
}

// Fix evidence is the accepted packets' own receipt payload, not a synthesized
// `fix.evidence` field. Each receipt's evidence is surfaced so the seal gate check
// can match it against the final head; no evidence is invented when a packet lacks
// an accepted receipt or payload.
function fixEvidenceFrom(state) {
  const fix = state?.fix ?? null;
  if (!fix) return [];
  if (Array.isArray(fix.evidence)) return fix.evidence;
  if (Array.isArray(fix.gates)) return fix.gates;
  const packets = Array.isArray(fix.packets) ? fix.packets : [];
  return packets.flatMap(packet => {
    const accepted = packet?.receipt?.accepted === true;
    const evidence = accepted ? packet.receipt.payload?.evidence : null;
    return Array.isArray(evidence) ? evidence : [];
  });
}

// ---------------------------------------------------------------------------
// sealMember.

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

const SEAL_STATUS_COMMAND = 'git status --porcelain=v1 -z --untracked-files=all';

function reviewedEntries(state) {
  const entries = [];
  for (const round of state?.rounds ?? []) {
    const accepted = (round?.attempts ?? []).find((attempt) => attempt?.result === 'accepted');
    if (!accepted) continue;
    const receipt = accepted.receipt ?? {};
    entries.push({ label: round.label ?? receipt.label ?? null, path: receipt.artifact ?? null,
      receipt: accepted.run_id ?? receipt.run_id ?? null,
      verdict: receipt.payload?.verdict ?? accepted.payload?.verdict ?? null,
      base: accepted.base ?? receipt.base ?? null, head: accepted.head ?? receipt.head ?? null });
  }
  return entries;
}

function fixEntry(state) {
  const fix = state?.fix ?? null;
  if (!fix) return null;
  const packets = Array.isArray(fix.packets) ? fix.packets : [];
  return { path: fix.path ?? packets.at(-1)?.receipt?.artifact ?? null,
    receipts: packets.map((packet) => packet.run_id ?? packet.runId).filter(Boolean),
    commits: packets.flatMap((packet) => packet.commits ?? []) };
}

// The seal card is the exact contract; every field is present on both the sealed
// and blocked forms, with the sealed-only fields null when blocked.
function sealCard({ waveId, stepNumber, attemptId, state: sealState, base, head, privateTree, retentionRef, member, reviews, fix, attribution, adaptationsApplied, drainedPhases, gateReceipts, reasons, retained }) {
  const sealed = sealState === 'sealed';
  return {
    version: 1, wave_id: waveId, step: stepNumber, attempt: attemptId, state: sealState,
    base_commit: base ?? null,
    sealed_head: sealed ? head : null, sealed_tree: sealed ? privateTree : null,
    retention_ref: sealed ? retentionRef : null,
    backend: member?.backend ?? null, fallback_reason: member?.fallback_reason ?? null,
    git_dir: member?.git_dir ?? null, source_common: member?.source_common ?? null,
    reviews: reviews ?? [], fix: fix ?? null, changed_paths: attribution ?? [],
    adaptations_applied: adaptationsApplied ?? [], drained_phases: drainedPhases ?? [],
    gate_receipts: gateReceipts ?? [], reasons, retained: retained ?? null,
    sealed_at: sealed ? iso() : null,
  };
}

function blockedCard({ waveId, stepNumber, attemptId, head, member, reasons, retained, ...rest }) {
  return sealCard({ ...rest, waveId, stepNumber, attemptId, state: 'blocked', head, member, reasons,
    retained: retained ?? retainedLayers(member, head) });
}

// The durable wave member stores its private-worktree facts under `workspace`;
// the seal pipeline consumes a flat internal view. Normalize into that flat view
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

export async function sealMember(input = {}) {
  const { runtime, ownership, identity = {}, record, index, targets, adaptations = [], state = {} } = input;
  const packageDir = record?.package ?? input.packageDir ?? null;
  const binding = record?.wave_bindings ?? {};
  const waveId = identity.wave_id ?? binding.wave_id ?? input.waveId ?? record?.wave_id ?? null;
  const stepNumber = Number(identity.step_number ?? binding.step_number ?? input.step ?? state?.number ?? 0);
  const attemptId = identity.attempt_id ?? binding.attempt_id ?? input.attempt ?? null;
  if (!packageDir || !waveId || !Number.isInteger(stepNumber) || stepNumber < 1) {
    throw fail('seal-input-invalid', 'sealMember requires a package, wave and step identity');
  }
  const wave = readJson(join(packageDir, 'runtime/waves', `${waveId}.json`)) ?? {};
  const sourceCommon = wave.target?.common ?? binding.source_common ?? null;
  const durable = (wave.members ?? {})[String(stepNumber)] ?? input.member ?? state?.member ?? {};
  const member = normalizeMember(durable, sourceCommon);
  const gitDir = member.git_dir ?? binding.git_dir ?? null;
  const base = member.base_commit ?? state?.member?.base_commit ?? null;
  const head = privateHead(gitDir);
  if (!head) throw fail('diff-unknown', 'cannot resolve the private HEAD for sealing');

  const receiptPath = join(packageDir, 'runtime/waves', waveId, `step-${pad3(stepNumber)}-seal.json`);
  const retentionRef = `${RETENTION_REF_PREFIX}${waveId}/step-${pad3(stepNumber)}`;

  const existing = readJson(receiptPath);
  if (existing?.state === 'sealed') {
    if (existing.sealed_head === head) return existing;
    // Never overwrite a sealed receipt: a conflicting head is blocked in memory.
    return blockedCard({
      waveId, stepNumber, attemptId, head, member, base,
      reasons: [{ code: 'seal-conflict', detail: `receipt records ${existing.sealed_head}, private head is ${head}` }],
    });
  }

  let attribution = [];
  try {
    const changed = changedPaths({ git_dir: gitDir, base, head });
    attribution = attributeWrites({ changedPaths: changed, index, targets, step: stepNumber, adaptations });
  } catch {
    attribution = [{ path: null, status: null, deleted: false, attribution: 'diff-unknown' }];
  }

  // The seal command's own drained phase token is appended once the command
  // completes; blocked receipts written before then only carry the prior phase.
  let sealPhaseToken = null;
  let drainConfirmed = false;
  const drainedPhases = () => {
    const phases = state?.previous_phase?.token
      ? [{ phase: state.previous_phase.phase ?? 'implementation', token: state.previous_phase.token }]
      : [];
    if (drainConfirmed && sealPhaseToken) phases.push({ phase: 'seal', token: sealPhaseToken });
    return phases;
  };
  const card = {
    waveId, stepNumber, attemptId, head, member, base,
    attribution,
    reviews: reviewedEntries(state),
    fix: fixEntry(state),
    adaptationsApplied: attribution.filter((entry) => entry?.adaptation).map((entry) => entry.adaptation),
    gateReceipts: state?.gate_receipts ?? [],
  };
  const writeBlocked = (reasons, retained) => {
    const receipt = blockedCard({ ...card, drainedPhases: drainedPhases(), reasons, ...(retained ? { retained } : {}) });
    atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  };

  const checks = artifactChecks(packageDir, state);
  const completionEvidence = completionEvidenceFrom(state);
  const fixEvidence = fixEvidenceFrom(state);
  const runCheckSeal = (status) => checkSeal({
    state,
    head,
    status,
    changed_paths: attribution,
    artifact_checks: checks,
    gate_receipts: state?.gate_receipts ?? [],
    gates: state?.gates ?? [],
    evidence_gates: state?.evidence_gates ?? [],
    completion_evidence: completionEvidence,
    fix_evidence: fixEvidence,
  });
  const preflight = runCheckSeal(null)
    .filter((reason) => reason.code !== 'dirty-tracked' && reason.code !== 'dirty-untracked');

  const drain = await resolveDrain({ ownership, state, wave });
  if (drain === 'unknown') {
    return writeBlocked([...preflight, { code: 'drain-unknown', detail: 'a prior phase token drain is unknown' }]);
  }
  if (drain === 'live') {
    return writeBlocked([...preflight, { code: 'drain-live', detail: 'a prior phase token is still live' }]);
  }

  const globalClaims = await inspectAllClaims(ownership);
  if (globalClaims === null) {
    return writeBlocked([...preflight, { code: 'drain-unknown', detail: 'the held capacity claims could not be inspected' }]);
  }
  let reservation;
  try {
    reservation = await ownership.reserveCapacity({
      packageId: wave.package_ref ?? waveId,
      attempt: `${waveId}:${attemptId}:seal`,
      request: stageCapacityRequest(globalClaims),
      coordinator: sealCoordinatorIdentity(wave.coordinator),
    });
  } catch (error) {
    return writeBlocked([...preflight, { code: 'seal-reservation-failed', detail: error.message }]);
  }
  if (reservation?.status === 'queued') {
    return { state: 'queued', constraint: reservation.constraint ?? null, wave_id: waveId, step: stepNumber };
  }
  if (reservation?.status !== 'reserved' || !reservation.claim?.token) {
    return writeBlocked([...preflight, { code: 'seal-reservation-failed', detail: `capacity reservation was not confirmed (${reservation?.status ?? 'unknown'})` }]);
  }

  let workspace = null;
  let phaseRecord = null;
  let status = null;
  let cmdError = null;
  try {
    workspace = (await runtime.remountWaveMember({ ...identity, wave_id: waveId, step_number: stepNumber, attempt_id: attemptId, phase: durable.phase }))?.workspace ?? null;
    sealPhaseToken = workspace?.claim?.token ?? null;
    phaseRecord = await runtime.commandPhase({
      packageDir,
      waveId,
      subject: { kind: 'step', step: stepNumber },
      workspace,
      capacityClaim: reservation.claim,
      purpose: 'seal',
    });
    sealPhaseToken = sealPhaseToken ?? phaseRecord?.command_phase?.claim_token ?? null;
    const statusResult = await runtime.runPhaseCommand(phaseRecord, SEAL_STATUS_COMMAND, 300);
    // Only a returned requires_cancellation === false confirms the drain; a
    // missing or true value leaves the drain unknown.
    if (statusResult?.requires_cancellation === false) {
      drainConfirmed = true;
      if (statusResult?.exit_code === 0 && !statusResult?.error
        && typeof statusResult?.full_output_path === 'string' && statusResult.full_output_path) {
        try { status = readText(statusResult.full_output_path) ?? null; } catch { status = null; }
      } else {
        cmdError = statusResult?.error?.message ?? 'the seal status command produced no readable log';
      }
    } else {
      cmdError = statusResult?.requires_cancellation === true
        ? 'the seal status command requires cancellation'
        : 'the seal status command drain was not confirmed';
    }
    await runtime.endCommandPhase(phaseRecord, { drained: drainConfirmed });
  } catch (error) {
    cmdError = error.message;
    drainConfirmed = false;
    try { if (phaseRecord) await runtime.endCommandPhase(phaseRecord, { drained: false }); } catch { /* retain */ }
  }

  if (!drainConfirmed) {
    // Retain every layer and capacity claim.
    return writeBlocked([...preflight, { code: 'drain-unknown', detail: cmdError ?? 'seal phase drain is unknown' }], retainedLayers(member, head));
  }

  // A completed command is drained even when its status log is unreadable, so
  // release the confirmed workspace and capacity before blocking on the status.
  const workspaceReleased = await releaseWorkspace({ ownership, member, workspace });
  const capacityReleased = await releaseCapacity(ownership, reservation);
  if (!workspaceReleased || !capacityReleased) {
    return writeBlocked([...preflight, { code: 'drain-unknown', detail: 'seal claim release could not be verified' }], retainedLayers(member, head));
  }
  await runtime.endCommandPhase(phaseRecord, { drained: true, released: [{ kind: 'checkout', token: workspace.claim.token, epoch: workspace.claim.epoch }] });
  if (status === null) {
    return writeBlocked([...preflight, { code: 'dirty-tracked', detail: cmdError ?? 'seal-phase status output is unavailable' }], retainedLayers(member, head));
  }

  const reasons = runCheckSeal(status);
  if (reasons.length) return writeBlocked(reasons, retainedLayers(member, head));

  const repo = member.source_common ?? binding.source_common ?? null;
  const source = member.backend === 'overlayfs' ? gitDir : repo;
  if (!repo || !source) {
    return writeBlocked([{ code: 'import-failed', detail: 'no canonical repository was provided for the sealed head import' }], retainedLayers(member, head));
  }

  let privateTree = null;
  try {
    await importSealedHead({ repo, source, sha: head, retentionRef });
    privateTree = runGit(gitDir, ['rev-parse', `${head}^{tree}`]).toString('utf8').trim();
    const canonicalTree = repositoryHead(repo, `${retentionRef}^{tree}`);
    if (!canonicalTree || canonicalTree !== privateTree) {
      throw fail('import-failed', 'imported tree does not match the private tree');
    }
    if (base) {
      try {
        execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', base, head], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        throw fail('import-failed', `base ${base} is not an ancestor of ${head}`);
      }
      execFileSync('git', ['-C', repo, 'rev-list', '--objects', `${base}..${head}`], {
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  } catch (error) {
    return writeBlocked([{ code: 'import-failed', detail: error.message }], retainedLayers(member, head));
  }

  const receipt = sealCard({
    ...card,
    state: 'sealed',
    base,
    drainedPhases: drainedPhases(),
    privateTree,
    retentionRef,
    reasons: [],
    retained: null,
  });
  atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
