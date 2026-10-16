// State plane for wave review/fix: fix-packet planning, native stage prompts,
// evidence-plan gate selection, the readReviewState builder and the pure
// nextReviewAction outcome table. It reads stage/run artifacts supplied by the
// data plane (wave-review.mjs) and writes nothing. nextReviewAction never mutates
// its input and reads only the state builder shape (or an equivalent fixture).
import { readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { refusalError } from './runtime.mjs';
import { parseReviewFindings, planFixes, renderPacket } from '../../../skills/spec-branch-fix/scripts/fix-packets.mjs';
import { completionStatus, verificationReceipts } from './completion.mjs';
import { stageLabel, stagePaths, sha256 } from './wave-review.mjs';
import { inspectProcess } from '../../../scripts/spec-observe/process-identity.mjs';

function isCandidateSubject(value) {
  return Boolean(value && typeof value === 'object' && value.kind === 'candidate');
}
function candidateOf(input) {
  if (isCandidateSubject(input.subject)) return input.subject;
  if (isCandidateSubject(input.member)) return input.member;
  if (isCandidateSubject(input.step)) return input.step;
  return null;
}
function subjectStepNumber(step) {
  if (Number.isInteger(step) && step > 0) return step;
  const parsed = Number(basename(String(step ?? '')).match(/step-(\d+)/)?.[1]);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw refusalError({ code: 'step-unknown', message: `Cannot derive a step number from ${JSON.stringify(step)}.` });
}
function subjectKey(waveId, step, candidate) {
  if (candidate) return `wave:${waveId}/candidate:${candidate.repair}/phase:`;
  return `wave:${waveId}/step:${String(subjectStepNumber(step)).padStart(3, '0')}/phase:`;
}

// Canonical label for a state built by readReviewState or an equivalent fixture.
// Candidate subjects keep their repair identity; step subjects use the step number
// (state.number) when state.step is a card path.
function labelStep(state) {
  if (state.subject?.kind === 'candidate') return state.subject;
  if (Number.isInteger(state.step)) return state.step;
  return state.number;
}
function canonicalLabel(state, round) {
  return stageLabel(state.waveId ?? state.wave_id, labelStep(state), round);
}

// One bounded fixer launch per packet. Wraps the canonical planner so ids, order,
// ranges and finding grouping stay canonical; `total` is added for rendering.
export function planStagePackets(recordOrReview, { exclude = [] } = {}) {
  let review;
  if (typeof recordOrReview === 'string') review = parseReviewFindings(recordOrReview);
  else if (Array.isArray(recordOrReview?.findings)) review = recordOrReview;
  else if (recordOrReview && typeof recordOrReview === 'object')
    review = parseReviewFindings(readFileSync(stagePaths(recordOrReview).reviewPath, 'utf8'));
  else throw refusalError({ code: 'review-invalid', message: 'planStagePackets needs a review object, review text or stage record.' });
  const plan = planFixes(review, { exclude });
  const total = plan.packets.length;
  return { ...plan, packets: plan.packets.map(packet => ({ ...packet, total })) };
}

function stageIsCandidate(record) {
  const stage = record.stage ?? {};
  return isCandidateSubject(stage.subject) || stage.kind === 'candidate' || stage.subject?.kind === 'candidate'
    || isCandidateSubject(record.subject);
}

// `stagePrompt(record)` is the reviewer/fixer stage prompt from the card's prompt
// contract; it reuses the runtime-rendered packet text unchanged.
export function stagePrompt(record) {
  const stage = record.stage ?? {};
  const paths = stagePaths(record);
  const artifact = stage.role === 'fixer' ? paths.fixPath : paths.reviewPath;
  const expected = Array.isArray(stage.expected_ids) ? stage.expected_ids.join(', ') : '';
  const lines = [
    `PACKAGE: ${record.package}`,
    `CHECKOUT: ${record.checkout}`,
    `STEP: ${record.step}`,
    `MODEL: ${record.owner_model}`,
    `NATIVE STAGE: submit with spec_stage_complete; the runtime writes ${artifact}`
  ];
  if (stage.role === 'reviewer') {
    if (stageIsCandidate(record)) {
      lines.push(`PARENTS: ${(stage.parents ?? []).join(', ')}`);
      lines.push('Compare the resolved tree with every parent.');
    }
    lines.push(`REVIEW: scope=step step=${stage.label} since=${stage.base} head=${stage.head}`);
    if (Number(stage.round) > 1)
      lines.push(`CONFIRM: verdict every fixed decision in ${paths.fixPath} under fix_verdicts; originally actionable IDs: ${expected}`);
  } else if (stage.role === 'fixer') {
    lines.push(`REVIEW: ${paths.reviewPath}`);
    lines.push(`FIX RECORD: ${paths.fixPath} (runtime-written)`);
    const packet = stage.packet ?? { index: 1, total: 1, ids: [], pending_after: [], ranges: [], findings: [] };
    lines.push(renderPacket(packet, { review: basename(paths.reviewPath), total: stage.packet?.total ?? 1 }));
    if ((stage.packet?.index ?? 1) <= 1)
      lines.push(`TRIAGE: run Jev review-triage once over ${expected} as your first call`);
    else
      lines.push(`TRIAGE (from packet 1; do not rerun): ${stage.triage_summary ?? ''}`);
  }
  return lines.join('\n');
}

// Required merge gates owned by a step. `command` gates run through runStageGates;
// gates without a command are covered by fixer evidence at the final head.
function stepOwnedRequiredMergeGates(packageDir, step) {
  const number = subjectStepNumber(step);
  const plan = readJson(join(packageDir, 'evidence-plan.json'));
  if (!plan || !Array.isArray(plan.gates))
    throw refusalError({ code: 'evidence-plan-invalid', message: 'evidence-plan.json must exist and contain a gates array.' });
  return plan.gates.filter(gate => gate && typeof gate === 'object' && Number(gate.ownerStep) === number
    && gate.phase === 'merge' && gate.required === true);
}
function hasCommand(gate) {
  return typeof gate.command === 'string' && gate.command.trim() !== '';
}
export function stepGates(packageDir, step) {
  return stepOwnedRequiredMergeGates(packageDir, step).filter(hasCommand);
}
// Required merge gates with no command are covered by fixer `evidence` at the
// final head, so the seal path consumes them separately.
export function stepGateEvidence(packageDir, step) {
  return stepOwnedRequiredMergeGates(packageDir, step).filter(gate => !hasCommand(gate));
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
function readStageReceipt(packageDir, runId) {
  return readJson(join(packageDir, 'runtime/runs', `${runId}-stage.json`));
}
function readStageArtifact(packageDir, target) {
  if (typeof target !== 'string' || !target) return null;
  const file = isAbsolute(target) ? target : join(packageDir, target);
  try {
    const text = readFileSync(file, 'utf8');
    return { path: relative(packageDir, file), bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(Buffer.from(text)), text };
  } catch { return null; }
}
function safeParseFindings(text) {
  try { return parseReviewFindings(text); } catch { return null; }
}

const STAGE_ASSIGNMENT = /^wave:([^/]+)\/(?:step:(\d+)|candidate:(\d+))\/phase:([a-z-]+)\/attempt:(\d+)(?:\/packet:(\d+))?(?:\/resume:(\d+))?$/;

// Enumerate this subject's assignment links only; unrelated runs are excluded by
// the identity prefix. For each phase/attempt/packet keep the highest resume.
function collectStageRecords(packageDir, prefix, stepNumber) {
  let names;
  try { names = readdirSync(join(packageDir, 'runtime/assignments')); } catch { names = []; }
  const selected = new Map();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const link = readJson(join(packageDir, 'runtime/assignments', name));
    const assignmentId = link?.assignment_id;
    if (typeof assignmentId !== 'string' || !assignmentId.startsWith(prefix)) continue;
    const match = STAGE_ASSIGNMENT.exec(assignmentId);
    if (!match) continue;
    const [, , assignedStep, , phase, attemptText, packetText, resumeText] = match;
    if (assignedStep && Number(assignedStep) !== stepNumber) continue;
    const attempt = Number(attemptText);
    const packet = packetText ? Number(packetText) : null;
    const resume = resumeText ? Number(resumeText) : 0;
    const key = `${phase}|${attempt}|${packet ?? ''}`;
    const previous = selected.get(key);
    if (previous && previous.resume >= resume) continue;
    const record = readJson(join(packageDir, 'runtime/runs', `${link.run_id}.json`));
    if (!record || !record.stage) continue;
    selected.set(key, { assignmentId, record, phase, attempt, packet, resume, link });
  }
  return [...selected.values()].sort((a, b) =>
    (a.record.started_at ?? '').localeCompare(b.record.started_at ?? '') || a.record.id.localeCompare(b.record.id));
}

function classifyReviewerAttempt(packageDir, entry) {
  const stage = entry.record.stage;
  const receipt = readStageReceipt(packageDir, entry.record.id);
  let result;
  if (receipt && receipt.accepted === true) result = 'accepted';
  else if (receipt && receipt.accepted === false) result = 'rejected';
  else if (entry.record.state === 'running') result = 'running';
  else result = 'transport-failed';
  // Read the canonical review artifact path; the stage record is the authority,
  // not a possibly-null stored stage.review_path.
  const artifact = readStageArtifact(packageDir, stagePaths(entry.record).reviewPath);
  const parsed = artifact ? safeParseFindings(artifact.text) : null;
  const findings = receipt?.payload?.findings ?? parsed?.findings ?? [];
  return { run_id: entry.record.id, assignment_id: entry.assignmentId, record: entry.record, result, receipt, artifact,
    base: stage.base ?? null, head: stage.head ?? null, findings, payload: receipt?.payload ?? null };
}

function classifyFixerPacket(packageDir, entry, commandGates) {
  const stage = entry.record.stage;
  const receipt = readStageReceipt(packageDir, entry.record.id);
  const accepted = receipt?.accepted === true;
  const decisions = accepted ? (receipt.payload?.decisions ?? []) : [];
  const commits = accepted ? (receipt.payload?.commits ?? []) : [];
  const evidence = accepted ? (receipt.payload?.evidence ?? []) : [];
  const lastCommit = commits.at(-1) ?? stage.head ?? null;
  const gates = verificationReceipts(entry.record);
  // Only a receipt for a required command whose revision pair is the packet's
  // last commit counts: earlier unrelated gate outcomes are ignored, and gate
  // success requires both before and after to observe that commit.
  const requiredCommands = [...new Set((commandGates ?? []).map(gate => gate.command))];
  const atLastCommit = gates.filter(item => item && requiredCommands.includes(item.command)
    && item.before?.commit === lastCommit && item.after?.commit === lastCommit);
  const passedAtLastCommit = atLastCommit.filter(item => item.outcome === 'pass');
  const gateFailed = evidence.some(item => item.outcome === 'failed') || atLastCommit.some(item => item.outcome === 'fail');
  const gated = requiredCommands.length === 0
    || requiredCommands.every(command => passedAtLastCommit.some(item => item.command === command));
  let result;
  if (!accepted && entry.record.state === 'running') result = 'running';
  else if (!accepted) result = 'empty';
  else result = commits.length || decisions.length ? 'landed' : 'empty';
  if (result === 'landed' && gateFailed) result = 'gate-failed';
  const ids = stage.packet?.ids ?? [];
  const pendingAfter = stage.packet?.pending_after ?? [];
  const pending = [...new Set([...pendingAfter, ...ids.filter(id => !decisions.some(decision => decision.id === id))])];
  return { index: stage.packet?.index ?? (entry.packet ?? 1), total: stage.packet?.total ?? 1, ids,
    pending_after: pendingAfter, pending, files: stage.packet?.files ?? [], findings: stage.packet?.findings ?? [],
    run_id: entry.record.id, record: entry.record, receipt, result, commits, decisions, gates, gated,
    split: Boolean(stage.packet?.split) };
}

function buildRounds(packageDir, records) {
  const reviewer = new Map();
  const fixer = new Map();
  for (const entry of records) {
    const round = Number(entry.record.stage.round) || 1;
    const target = entry.phase === 'fixing' || entry.phase === 'integration-fix' ? fixer : reviewer;
    const list = target.get(round) ?? [];
    list.push(entry);
    target.set(round, list);
  }
  const rounds = [];
  for (const round of [...reviewer.keys()].sort((a, b) => a - b)) {
    const entries = (reviewer.get(round) ?? []).sort((a, b) => a.attempt - b.attempt);
    const attempts = entries.map(entry => classifyReviewerAttempt(packageDir, entry));
    // The stage's assigned canonical label is the round label; never synthesize a
    // short `review-N` fallback that cannot match the stage identity.
    const sample = entries.map(entry => entry.record.stage).find(stage => typeof stage?.label === 'string' && stage.label);
    rounds.push({ round, label: sample?.label ?? null, kind: round === 1 ? 'review' : 'confirmation', attempts });
  }
  return { rounds, fixer };
}

function buildFix(packageDir, fixer, commandGates) {
  const rounds = [...fixer.keys()].sort((a, b) => a - b);
  if (!rounds.length) return null;
  const round = rounds.at(-1);
  const entries = fixer.get(round) ?? [];
  const packets = [];
  for (let n = 1; ; n += 1) {
    // For a packet index, a resumed/split attempt supersedes the original: prefer
    // any split record, then the most recent start/id, so an old empty packet is
    // never selected over its later re-launch.
    const candidates = entries.filter(item => (item.packet ?? 1) === n);
    if (!candidates.length) break;
    candidates.sort((a, b) =>
      Number(Boolean(b.record?.stage?.packet?.split)) - Number(Boolean(a.record?.stage?.packet?.split))
      || (b.record?.started_at ?? '').localeCompare(a.record?.started_at ?? '')
      || b.record.id.localeCompare(a.record.id));
    packets.push(classifyFixerPacket(packageDir, candidates[0], commandGates));
  }
  return { round, packets };
}

// `readReviewState(input)` assembles the outcome-table state from assignment
// links, run records, stage receipts and verification receipts. All reads are
// fail-closed: missing structure yields conservative `unknown`/`transport-failed`
// values and never a synthesized complete result.
export async function readReviewState(input = {}) {
  const packageDir = input.packageDir;
  if (typeof packageDir !== 'string' || !packageDir)
    throw refusalError({ code: 'state-package-missing', message: 'readReviewState needs packageDir.' });
  if (typeof input.waveId !== 'string' || !input.waveId)
    throw refusalError({ code: 'state-wave-missing', message: 'readReviewState needs waveId.' });
  const candidate = candidateOf(input);
  const number = candidate ? 0 : subjectStepNumber(input.step);
  // The durable wave member stores its base commit under `workspace.baseCommit`;
  // the range/classifier view reads the flat `base_commit`. Normalize while
  // retaining the rest of the member (including `workspace`).
  const rawMember = input.member ?? {};
  const inputMember = rawMember.workspace?.baseCommit && rawMember.base_commit == null
    ? { ...rawMember, base_commit: rawMember.workspace.baseCommit }
    : rawMember;
  const prefix = subjectKey(input.waveId, input.step, candidate);
  const records = collectStageRecords(packageDir, prefix, number);
  const gates = stepGates(packageDir, input.step);
  const evidenceGates = stepGateEvidence(packageDir, input.step);
  const { rounds, fixer } = buildRounds(packageDir, records);
  const fix = buildFix(packageDir, fixer, gates);

  const implementationRun = input.implementationRunId
    ? readJson(join(packageDir, 'runtime/runs', `${input.implementationRunId}.json`)) : null;
  const implementation = implementationRun ? completionStatus(implementationRun) : null;

  // Drain authority for the preceding phase is the checkout claim recorded on the
  // run's wave binding, not the capacity claim. Missing token, no claim reader or
  // an inspect failure is `unknown`; a matching running claim is `live`; a
  // confirmed absence is `confirmed`. Without a stage record, the implementation
  // run carries the drain authority.
  const drainOf = async run => {
    const binding = run?.wave_bindings ?? null;
    const token = binding?.checkout_claim ?? null;
    if (!token) return { token: null, drain: 'unknown' };
    try {
      if (!input.ownership) return { token, drain: 'unknown' };
      const inspected = await input.ownership.inspectClaims({ packageId: binding.package_ref });
      // A malformed inspection without a claims array is unknown, never a
      // confirmed absence: only an inspectable empty/decided list confirms drain.
      if (!Array.isArray(inspected?.claims)) return { token, drain: 'unknown' };
      const claim = inspected.claims.find(item => item.token === token) ?? null;
      // Absent claim is a confirmed drain; a present claim is live while running.
      if (!claim) return { token, drain: 'confirmed' };
      if (claim.running === true) return { token, drain: 'live' };
      // Present but not running: positively validate the recorded worker
      // identity against a fresh process observation. A matched exact pid/start
      // and alive observation is live; anything else (including an exited
      // process) stays unknown rather than inferring drain.
      const identity = run?.worker_identity ?? null;
      if (identity) {
        const fresh = inspectProcess(identity.pid);
        if (fresh.state === 'alive' && fresh.pid === identity.pid && fresh.started_at === identity.started_at) return { token, drain: 'live' };
      }
      return { token, drain: 'unknown' };
    } catch { return { token, drain: 'unknown' }; }
  };
  let previousPhase = null;
  let previousRun = null;
  const latest = records.at(-1) ?? null;
  if (latest) {
    previousRun = latest.record.id;
    previousPhase = await drainOf(latest.record);
  } else if (implementationRun) {
    previousRun = input.implementationRunId ?? implementationRun.id ?? null;
    previousPhase = await drainOf(implementationRun);
  }

  const expectedIds = [...new Set(records.flatMap(entry => entry.record.stage?.expected_ids ?? []))];
  const decided = [...new Set((fix?.packets ?? []).flatMap(packet => packet.decisions.map(decision => decision.id)))];
  const active = [...rounds].reverse().flatMap(round => round.attempts).find(attempt => attempt.findings.length)
    ?? rounds.flatMap(round => round.attempts).find(attempt => attempt.findings.length) ?? null;
  const findings = active?.findings ?? [];
  // The completion handoff file is the only evidence source for the implementation
  // run; without a recorded status no evidence is fabricated. Gate receipts are the
  // verification receipts across the accepted fix packets, keyed by the packet that
  // produced them.
  const completionReceipt = input.implementationRunId
    ? readJson(join(packageDir, 'runtime/runs', `${input.implementationRunId}-completion.json`)) : null;
  const completionEvidence = implementation?.status === 'recorded' && Array.isArray(completionReceipt?.learning?.evidence)
    ? completionReceipt.learning.evidence : null;
  const implementationState = completionEvidence ? { ...implementation, evidence: completionEvidence } : implementation;
  const gateReceipts = (fix?.packets ?? []).flatMap(packet => (packet.gates ?? []).map(receipt => ({ ...receipt, packet: packet.index })));
  // The final pending set is the latest accepted packet's own computed pending;
  // never the union of earlier packets' pending sets. An explicit pending override
  // is only consulted when there is no packet to compute from.
  const pending = (fix?.packets ?? []).at(-1)?.pending ?? input.pending ?? [];

  const sealReceipt = number
    ? readJson(join(packageDir, 'runtime/waves', input.waveId, `step-${String(number).padStart(3, '0')}-seal.json`))
    : null;
  // Preserve the seal receipt's own state and reasons; a blocked seal is never
  // converted to a success.
  const seal = sealReceipt
    ? { state: sealReceipt.state === 'blocked' ? 'blocked' : (sealReceipt.state ?? 'sealed'),
        reasons: Array.isArray(sealReceipt.reasons) ? sealReceipt.reasons : [], receipt: sealReceipt }
    : null;

  const repairInput = inputMember.repair ?? input.repair ?? null;
  const repair = repairInput?.assignment_id
    ? { assignment_id: repairInput.assignment_id,
        consumed: records.some(entry => entry.assignmentId === repairInput.assignment_id
          && (entry.phase === 'fixing' || entry.phase === 'integration-fix')) }
    : null;

  return {
    waveId: input.waveId, step: input.step, number, packageDir,
    subject: candidate ? { kind: 'candidate', repair: candidate.repair, parents: candidate.parents ?? [] } : { kind: 'step' },
    member: inputMember, implementation: implementationState, implementation_run: input.implementationRunId ?? null,
    previous_phase: previousPhase, previous_run: previousRun,
    expected_ids: expectedIds, findings, decided, pending,
    rounds, fix, repair, seal, gates, gate_receipts: gateReceipts, evidence_gates: evidenceGates
  };
}

// --- pure outcome table ----------------------------------------------------

function implementationEligible(implementation) {
  return Boolean(implementation) && implementation.status === 'recorded'
    && (implementation.outcome === 'as-specified' || implementation.outcome === 'adapted')
    && (!implementation.remaining_work || implementation.remaining_work.length === 0);
}
function roundHead(state, round) {
  const entry = (state.rounds ?? []).find(item => item.round === round);
  const attempt = entry?.attempts?.find(item => item.result === 'accepted');
  return attempt?.head ?? null;
}
function reviewedHead(state) {
  return roundHead(state, state.fix?.round ?? 1) ?? roundHead(state, 1) ?? state.implementation?.commit ?? null;
}
function baseHead(state) {
  if (state.subject?.kind === 'candidate')
    return { base: state.subject.parents?.[0] ?? state.member?.base_commit ?? null, head: state.implementation?.commit ?? null };
  return { base: state.member?.base_commit ?? null, head: state.implementation?.commit ?? null };
}
function launchForRound(state, round) {
  if (round.kind === 'confirmation') {
    const head = state.fix?.packets?.at(-1)?.commits?.at(-1) ?? reviewedHead(state);
    return { action: 'launch-confirmation', label: round.label, base: reviewedHead(state), head, round: round.round };
  }
  const expected = baseHead(state);
  const attempt = round.attempts?.find(item => item.result === 'accepted') ?? round.attempts?.[0] ?? null;
  return { action: 'launch-review', label: round.label, base: attempt?.base ?? expected.base, head: attempt?.head ?? expected.head };
}
function actionableIds(state) {
  if (state.expected_ids?.length) return state.expected_ids;
  return (state.findings ?? []).filter(finding => finding.actionable === true).map(finding => finding.id);
}
function firstPlannedPacket(state, findings) {
  const source = (findings ?? state.findings ?? []).filter(finding => finding && finding.id);
  if (!source.length) return null;
  const plan = planStagePackets({ findings: source });
  return plan.packets[0] ?? null;
}
function firstSinglePacket(state, packet) {
  const source = packet.findings?.length ? packet.findings : state.findings;
  const exclude = (packet.ids ?? []).slice(1);
  const plan = planStagePackets({ findings: source ?? [] }, { exclude });
  return plan.packets[0] ?? null;
}
function nextPendingPacket(state, pending) {
  const source = state.findings ?? [];
  if (!source.length) return null;
  const plan = planStagePackets({ findings: source });
  const pendingIds = new Set(pending ?? []);
  const decided = new Set(state.decided ?? []);
  const remaining = plan.packets.flatMap(packet => packet.ids)
    .filter(id => pendingIds.has(id) && !decided.has(id));
  for (let index = 0; index < plan.packets.length; index++) {
    const original = plan.packets[index];
    if (!original.ids.some(id => pendingIds.has(id))) continue;
    const ids = original.ids.filter(id => pendingIds.has(id));
    return {
      ...original,
      index: original.index,
      total: plan.packets.length,
      ids,
      files: [...new Set((original.findings ?? [])
        .filter(finding => ids.includes(finding.id)).map(finding => finding.file))],
      ranges: original.ranges,
      findings: (original.findings ?? []).filter(finding => ids.includes(finding.id)),
      pending_after: remaining.filter(id => !ids.includes(id))
    };
  }
  return null;
}
// Every fixed id across the reviewed round's accepted packets must be resolved by
// the confirmation verdicts, and every originally actionable id must have a
// (fixed or dismissed) decision. Optional arrays are read defensively.
function confirmationResolved(state, attempt) {
  const packets = state.fix?.packets ?? [];
  const decisions = packets.flatMap(packet => Array.isArray(packet.decisions) ? packet.decisions : []);
  const fixed = new Set(decisions.filter(decision => decision.decision === 'fixed').map(decision => decision.id));
  const decided = new Set([...(state.decided ?? []), ...decisions.map(decision => decision.id)]);
  const verdicts = attempt?.receipt?.payload?.fix_verdicts ?? [];
  const resolved = new Set(verdicts.filter(item => item.verdict === 'resolved').map(item => item.id));
  return [...fixed].every(id => resolved.has(id)) && actionableIds(state).every(id => decided.has(id));
}
export function nextReviewAction(state) {
  const s = state ?? {};
  const candidate = s.subject?.kind === 'candidate';
  if (s.seal?.state === 'sealed') return { action: 'sealed' };
  if (s.seal?.state === 'blocked') return { action: 'block', reason: s.seal.reasons?.[0]?.code ?? 'seal-blocked' };
  if (!candidate && !implementationEligible(s.implementation)) return { action: 'not-eligible', reason: 'completion-incomplete' };
  if (s.previous_phase?.drain === 'live') return { action: 'wait', reason: 'drain-pending' };
  if (s.previous_phase?.drain === 'unknown') return { action: 'block', reason: 'drain-unknown' };

  const rounds = Array.isArray(s.rounds) ? s.rounds : [];
  const latestRound = rounds.at(-1) ?? null;
  const latestAttempt = latestRound?.attempts?.at(-1) ?? null;
  const latestPacket = s.fix?.packets?.at(-1) ?? null;
  if (latestAttempt?.result === 'running' || latestPacket?.result === 'running') return { action: 'wait', reason: 'stage-running' };
  if (latestAttempt?.result === 'rejected')
    return { action: 'block', reason: latestAttempt.receipt?.refusal?.code === 'reviewer-mutated-source'
      ? 'reviewer-mutated-source' : 'stage-receipt-invalid' };

  const transportFailed = latestRound ? latestRound.attempts.filter(item => item.result === 'transport-failed').length : 0;
  const acceptedInRound = latestRound ? latestRound.attempts.some(item => item.result === 'accepted') : false;
  if (transportFailed === 1 && !acceptedInRound) return { ...launchForRound(s, latestRound), reason: 'transport-retry' };
  if (transportFailed >= 2) return { action: 'block', reason: 'review-transport-failed' };

  if (rounds.length === 0) {
    const expected = baseHead(s);
    return { action: 'launch-review', label: canonicalLabel(s, 1), base: expected.base, head: expected.head };
  }

  const round1 = rounds[0];
  const round1Accepted = round1.attempts?.find(item => item.result === 'accepted') ?? null;
  const expected = baseHead(s);
  if (round1Accepted && (round1Accepted.base !== expected.base || round1Accepted.head !== expected.head))
    return { action: 'block', reason: 'review-stale' };

  const passWithActionable = rounds.some(round => round.attempts.some(attempt => attempt.result === 'accepted'
    && attempt.receipt?.payload?.verdict === 'pass'
    && (attempt.receipt.payload.findings ?? []).some(finding => finding.actionable === true)));
  const anyNeedsFix = rounds.some(round => round.attempts.some(attempt => attempt.result === 'accepted'
    && attempt.receipt?.payload?.verdict === 'needs-fix'));
  if (passWithActionable || (s.fix && !anyNeedsFix)) return { action: 'block', reason: 'stage-receipt-invalid' };

  if (round1Accepted && round1Accepted.receipt?.payload?.verdict === 'pass'
      && !(round1Accepted.receipt.payload.findings ?? []).some(finding => finding.actionable === true))
    return candidate ? { action: 'accept-repair', head: round1Accepted.head } : { action: 'seal', head: round1Accepted.head };

  // Only launch the initial fix packet when no fix round exists yet; an explicit
  // later repair round (round 2+) owns the relaunch and round 1 is not re-run.
  if (round1Accepted && round1Accepted.receipt?.payload?.verdict === 'needs-fix' && !s.fix) {
    const packet = firstPlannedPacket(s, round1Accepted.receipt.payload.findings ?? round1Accepted.findings);
    return packet ? { action: 'launch-fix-packet', packet } : { action: 'block', reason: 'stage-receipt-invalid' };
  }

  if (latestPacket?.result === 'gate-failed') return { action: 'block', reason: 'fix-gate-failed' };
  if (latestPacket?.result === 'landed' && (latestPacket.commits ?? []).length > 0 && !latestPacket.gated)
    return { action: 'run-gates', run_id: latestPacket.run_id, head: latestPacket.commits.at(-1) };

  if (latestPacket?.result === 'empty') {
    if ((latestPacket.ids ?? []).length > 1 && !latestPacket.split) {
      const packet = firstSinglePacket(s, latestPacket);
      if (packet) return { action: 'launch-fix-packet', packet: { ...packet, split: true }, reason: 'packet-split' };
    }
    return { action: 'block', reason: 'fix-packet-empty' };
  }

  const pending = s.pending ?? latestPacket?.pending ?? [];
  if (latestPacket?.result === 'landed' && pending.length > 0) {
    const packet = nextPendingPacket(s, pending);
    if (packet) return { action: 'launch-fix-packet', packet };
  }

  const confirmationRound = s.fix ? rounds.find(round => round.round === s.fix.round + 1) ?? null : null;
  if (s.fix && pending.length === 0 && !confirmationRound) {
    const head = (latestPacket?.commits ?? []).at(-1) ?? reviewedHead(s);
    return { action: 'launch-confirmation', label: canonicalLabel(s, s.fix.round + 1), base: reviewedHead(s), head, round: s.fix.round + 1 };
  }
  if (confirmationRound) {
    const attempt = confirmationRound.attempts.find(item => item.result === 'accepted') ?? null;
    const lastPacketHead = (latestPacket?.commits ?? []).at(-1) ?? reviewedHead(s);
    if (attempt && attempt.head !== lastPacketHead) return { action: 'block', reason: 'review-stale' };
    if (attempt && attempt.receipt?.payload?.verdict === 'pass' && confirmationResolved(s, attempt))
      return candidate ? { action: 'accept-repair', head: attempt.head } : { action: 'seal', head: attempt.head };
    if (!s.repair || s.repair.consumed) return { action: 'block', reason: 'confirmation-failed' };
    const packet = firstPlannedPacket(s, attempt?.receipt?.payload?.findings ?? s.findings);
    if (packet) return { action: 'launch-fix-packet', packet, round: confirmationRound.round };
  }
  return { action: 'block', reason: 'stage-receipt-invalid' };
}

// Retention facts for a blocked member card: the layers and head a recovery must
// preserve. Pure projection shared with the seal module.
export function retainedLayers(member, head) {
  return {
    git_dir: member?.git_dir ?? null,
    upper_id: member?.upper_id ?? member?.retained?.upper_id ?? member?.upper ?? member?.layers?.upper ?? member?.workspace?.retained?.upper ?? null,
    head: head ?? null,
  };
}
