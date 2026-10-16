// Stage submission data plane for wave review/fix: strict payload validation,
// Markdown rendering, reviewer source fingerprints and receipt-first submitStage.
// Orchestration (runStageGates, sealMember) is added in later edit-sequence items;
// this module is the only writer of stage artifacts.
// Reuses runtime.mjs for lease and refusal authority.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertLease, refusalError } from './runtime.mjs';
import { parseReviewFindings, planFixes } from '../../../skills/spec-branch-fix/scripts/fix-packets.mjs';

const WAVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SEVERITIES = new Set(['HIGH', 'MED', 'LOW']);
// Single source of truth for the canonical review categories. The reviewer
// tool schema and the submission validator both derive from this frozen list so
// they cannot drift apart.
export const REVIEW_CATEGORIES = Object.freeze(['correctness', 'security', 'perf', 'simplification', 'design', 'guardrail', 'evidence']);
const CATEGORIES = new Set(REVIEW_CATEGORIES);
const DISMISSALS = new Set(['false-positive', 'intentional', 'accepted-risk', 'deferred', 'unfixable']);
const SHA = /^[0-9a-f]{40}$/;
const MAX_BYTES = 48000;
const SHA_NOTES = 12;

function invalid(field, message) {
  return Object.assign(new Error(`stage-payload-invalid: ${field}: ${message}`), { code: 'stage-payload-invalid', field });
}
function atomic(file, value, { raw = false, mode = 0o600 } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, raw ? value : `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(tmp, file);
}
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const git = (cwd, args, opts = {}) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const gitText = (cwd, args) => git(cwd, args, { encoding: 'utf8' });

// `wave-<waveId>-step-<NNN>-review-<round>`; a candidate subject is
// `{ kind: 'candidate', repair: <n>, parents }` and yields the integration label.
export function stageLabel(waveId, step, round) {
  if (typeof waveId !== 'string' || !WAVE_ID_PATTERN.test(waveId))
    throw refusalError({ code: 'wave-id-invalid', message: `Wave id ${JSON.stringify(waveId)} does not match ${WAVE_ID_PATTERN}.` });
  if (!Number.isInteger(round) || round < 1)
    throw refusalError({ code: 'stage-label-invalid', message: `Review round ${JSON.stringify(round)} must be a positive integer.` });
  if (step && typeof step === 'object' && step.kind === 'candidate') {
    if (!Number.isInteger(step.repair) || step.repair < 1)
      throw refusalError({ code: 'stage-label-invalid', message: `Candidate repair ${JSON.stringify(step.repair)} must be a positive integer.` });
    return `wave-${waveId}-integration-${step.repair}-review-${round}`;
  }
  if (!Number.isInteger(step) || step < 1)
    throw refusalError({ code: 'stage-label-invalid', message: `Step ${JSON.stringify(step)} must be a positive integer.` });
  return `wave-${waveId}-step-${String(step).padStart(3, '0')}-review-${round}`;
}

function stepNumberOf(record) {
  if (Number.isInteger(record.wave_bindings?.step_number)) return record.wave_bindings.step_number;
  const parsed = Number(basename(record.step ?? '').match(/step-(\d+)/)?.[1]);
  return Number.isInteger(parsed) ? parsed : 0;
}

// A stage record may pin its review/fix artifact as an absolute or package-relative
// path (a confirmation names the reviewed label's fix record). Otherwise derive the
// canonical `reviews/<label>-review.md` / `-fix.md` name.
function stageArtifactPath(record, configured, fallback) {
  if (typeof configured === 'string' && configured) return isAbsolute(configured) ? configured : join(record.package, configured);
  return join(record.package, 'reviews', fallback);
}

// Review/fix artifact and receipt paths bound to the package and run id.
export function stagePaths(record) {
  const stage = record.stage ?? {};
  const waveId = record.wave_bindings?.wave_id ?? record.wave_id ?? null;
  return {
    reviewPath: stageArtifactPath(record, stage.review_path, `${stage.label}-review.md`),
    fixPath: stageArtifactPath(record, stage.fix_path, `${stage.label}-fix.md`),
    receiptPath: join(record.package, 'runtime/runs', `${record.id}-stage.json`),
    fingerprintPath: join(record.package, 'runtime/runs', `${record.id}-stage-fingerprint.json`),
    sealPath: join(record.package, 'runtime/waves', `${waveId}`, `step-${String(stepNumberOf(record)).padStart(3, '0')}-seal.json`)
  };
}

// Model policy: reviewer pins review_model; fixer uses the override or the effective
// implementation owner model. Selectors are returned verbatim (no re-parsing).
export function resolveStageModel({ role, review_model, fix_model_override, implementation_owner_model }) {
  if (role === 'reviewer') {
    if (typeof review_model !== 'string' || !review_model)
      throw refusalError({ code: 'role-model-missing', message: 'Role reviewer has no review_model selector.' });
    return review_model;
  }
  if (role === 'fixer') {
    const model = fix_model_override ?? implementation_owner_model;
    if (typeof model !== 'string' || !model)
      throw refusalError({ code: 'role-model-missing', message: 'Role fixer has no fix_model_override or implementation_owner_model selector.' });
    return model;
  }
  throw refusalError({ code: 'role-unknown', message: `Native role ${JSON.stringify(role)} is not a stage role.` });
}

function guardPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('payload', 'payload must be an object');
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_BYTES) throw invalid('payload', `payload exceeds ${MAX_BYTES} bytes`);
}

const FINDING_KEYS = ['id', 'severity', 'category', 'actionable', 'file', 'line', 'symbol', 'signature', 'explanation', 'correction', 'commit'];
function validateFinding(finding, index, seen) {
  const at = `findings[${index}]`;
  if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) throw invalid(at, 'finding must be an object');
  for (const key of Object.keys(finding)) if (!FINDING_KEYS.includes(key)) throw invalid(`${at}.${key}`, 'unknown finding key');
  if (typeof finding.id !== 'string' || !/^[A-Z][A-Za-z0-9-]*$/.test(finding.id)) throw invalid(`${at}.id`, 'id must match [A-Z][A-Za-z0-9-]*');
  if (seen.has(finding.id)) throw invalid(`${at}.id`, `duplicate finding id ${finding.id}`);
  seen.add(finding.id);
  if (!SEVERITIES.has(finding.severity)) throw invalid(`${at}.severity`, 'severity must be HIGH, MED or LOW');
  if (!CATEGORIES.has(finding.category)) throw invalid(`${at}.category`, 'category is not in the review enum');
  if (typeof finding.actionable !== 'boolean') throw invalid(`${at}.actionable`, 'actionable must be boolean');
  if (!Number.isInteger(finding.line) || finding.line < 1) throw invalid(`${at}.line`, 'line must be an integer >= 1');
  if (typeof finding.file !== 'string' || !finding.file) throw invalid(`${at}.file`, 'file must be a nonempty string');
  if (typeof finding.symbol !== 'string' || !finding.symbol) throw invalid(`${at}.symbol`, 'symbol must be a nonempty string');
  if (typeof finding.signature !== 'string' || !finding.signature.startsWith(`${finding.category}:`))
    throw invalid(`${at}.signature`, 'signature must start with <category>:');
  if (typeof finding.explanation !== 'string' || !finding.explanation) throw invalid(`${at}.explanation`, 'explanation must be a nonempty string');
  if (finding.correction !== undefined && typeof finding.correction !== 'string') throw invalid(`${at}.correction`, 'correction must be a string');
  if (typeof finding.commit !== 'string' || !SHA.test(finding.commit)) throw invalid(`${at}.commit`, 'commit must be 40 lowercase hex');
  return finding.actionable ? 1 : 0;
}

function validateFixVerdict(entry, index) {
  const at = `fix_verdicts[${index}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw invalid(at, 'fix verdict must be an object');
  for (const key of Object.keys(entry)) if (!['fix', 'id', 'verdict', 'evidence'].includes(key)) throw invalid(`${at}.${key}`, 'unknown fix verdict key');
  if (typeof entry.fix !== 'string' || !entry.fix) throw invalid(`${at}.fix`, 'fix must be a nonempty path');
  if (typeof entry.id !== 'string' || !entry.id) throw invalid(`${at}.id`, 'id must be a nonempty string');
  if (entry.verdict !== 'resolved' && entry.verdict !== 'unresolved') throw invalid(`${at}.verdict`, 'verdict must be resolved or unresolved');
  if (typeof entry.evidence !== 'string' || !entry.evidence) throw invalid(`${at}.evidence`, 'evidence must be a nonempty string');
}

function fixedDecisionIds(text) {
  const block = text.match(/```ya?ml\r?\n([\s\S]*?)\r?\n```/)?.[1] ?? '';
  const ids = new Set();
  let current = null;
  for (const line of block.split(/\r?\n/)) {
    const start = line.match(/^\s*-\s*id:\s*(\S+)/) ?? line.match(/^\s{4,}id:\s*(\S+)/);
    if (start) current = start[1];
    const decision = line.match(/^\s*decision:\s*(\S+)/);
    if (decision && current && decision[1] === 'fixed') ids.add(current);
  }
  return ids;
}

function validateConfirmation(record, payload) {
  const fixPath = stagePaths(record).fixPath;
  let text;
  try { text = readFileSync(fixPath, 'utf8'); } catch { throw invalid('fix_verdicts', `confirmation requires the fix record at ${fixPath}`); }
  const required = fixedDecisionIds(text);
  const got = new Set(payload.fix_verdicts.map(entry => entry.id));
  for (const id of required) if (!got.has(id)) throw invalid('fix_verdicts', `missing verdict for fixed decision ${id}`);
  for (const id of got) if (!required.has(id)) throw invalid('fix_verdicts', `verdict for ${id} has no fixed decision`);
}

export function validateReviewPayload(record, payload) {
  guardPayload(payload);
  const allowed = new Set(['verdict', 'findings', 'fix_verdicts', 'limitations']);
  for (const key of Object.keys(payload)) if (!allowed.has(key)) throw invalid(key, `unknown review key ${key}`);
  if (payload.verdict !== 'pass' && payload.verdict !== 'needs-fix') throw invalid('verdict', 'verdict must be pass or needs-fix');
  if (!Array.isArray(payload.findings)) throw invalid('findings', 'findings must be an array');
  const seen = new Set();
  let actionable = 0;
  payload.findings.forEach((finding, index) => { actionable += validateFinding(finding, index, seen); });
  if (!Array.isArray(payload.fix_verdicts)) throw invalid('fix_verdicts', 'fix_verdicts must be an array');
  payload.fix_verdicts.forEach((entry, index) => validateFixVerdict(entry, index));
  if (record?.stage?.round === 1 && payload.fix_verdicts.length) throw invalid('fix_verdicts', 'round 1 requires fix_verdicts: []');
  if (!Array.isArray(payload.limitations)) throw invalid('limitations', 'limitations must be a string array');
  payload.limitations.forEach((limit, index) => { if (typeof limit !== 'string') throw invalid(`limitations[${index}]`, 'limitation must be a string'); });
  const confirmation = record?.stage?.round > 1;
  if (confirmation) validateConfirmation(record, payload);
  if (actionable > 0 && payload.verdict !== 'needs-fix') throw invalid('verdict', 'actionable findings require verdict needs-fix');
  if (actionable === 0 && payload.verdict === 'needs-fix') throw invalid('verdict', 'verdict needs-fix requires an actionable finding');
}

const DECISION_KEYS = ['id', 'decision', 'signature', 'note', 'dismissal', 'approved', 'approval_source'];
function validateDecision(decision, index, packetIds, seen) {
  const at = `decisions[${index}]`;
  if (decision === null || typeof decision !== 'object' || Array.isArray(decision)) throw invalid(at, 'decision must be an object');
  for (const key of Object.keys(decision)) if (!DECISION_KEYS.includes(key)) throw invalid(`${at}.${key}`, 'unknown decision key');
  if (typeof decision.id !== 'string' || !decision.id) throw invalid(`${at}.id`, 'id must be a nonempty string');
  if (!packetIds.has(decision.id)) throw invalid(`${at}.id`, `id ${decision.id} is not in the packet`);
  if (seen.has(decision.id)) throw invalid(`${at}.id`, `duplicate decision id ${decision.id}`);
  seen.add(decision.id);
  if (decision.decision !== 'fixed' && decision.decision !== 'dismissed') throw invalid(`${at}.decision`, 'decision must be fixed or dismissed');
  if (typeof decision.signature !== 'string' || !decision.signature) throw invalid(`${at}.signature`, 'signature must be a nonempty string');
  if (typeof decision.note !== 'string' || !decision.note) throw invalid(`${at}.note`, 'note must be a nonempty string');
  if (decision.decision === 'dismissed') {
    if (!DISMISSALS.has(decision.dismissal)) throw invalid(`${at}.dismissal`, 'dismissal class is not recognized');
    if (decision.dismissal === 'accepted-risk') {
      if (decision.approved !== true) throw invalid(`${at}.approved`, 'accepted-risk requires approved: true');
      if (typeof decision.approval_source !== 'string' || !decision.approval_source) throw invalid(`${at}.approval_source`, 'accepted-risk requires approval_source');
    }
  }
}

function validateEvidence(entry, index) {
  const at = `evidence[${index}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw invalid(at, 'evidence must be an object');
  for (const key of Object.keys(entry)) if (!['gate_id', 'artifact', 'outcome', 'observed_commit'].includes(key)) throw invalid(`${at}.${key}`, 'unknown evidence key');
  if (typeof entry.artifact !== 'string' || !entry.artifact) throw invalid(`${at}.artifact`, 'artifact must be a nonempty string');
  if (entry.outcome !== 'passed' && entry.outcome !== 'failed') throw invalid(`${at}.outcome`, 'outcome must be passed or failed');
  if (typeof entry.observed_commit !== 'string' || !SHA.test(entry.observed_commit)) throw invalid(`${at}.observed_commit`, 'observed_commit must be 40 lowercase hex');
  if (entry.gate_id !== undefined && (typeof entry.gate_id !== 'string' || !entry.gate_id)) throw invalid(`${at}.gate_id`, 'gate_id must be a nonempty string');
}

export function validateFixPayload(record, payload) {
  guardPayload(payload);
  const allowed = new Set(['commits', 'decisions', 'evidence', 'unresolved', 'triage']);
  for (const key of Object.keys(payload)) if (!allowed.has(key)) throw invalid(key, `unknown fix key ${key}`);
  if (!Array.isArray(payload.commits)) throw invalid('commits', 'commits must be an array');
  payload.commits.forEach((commit, index) => { if (typeof commit !== 'string' || !SHA.test(commit)) throw invalid(`commits[${index}]`, 'commit must be 40 lowercase hex'); });
  if (!Array.isArray(payload.decisions)) throw invalid('decisions', 'decisions must be an array');
  const packet = record?.stage?.packet ?? null;
  const packetIds = new Set(packet?.ids ?? []);
  const seen = new Set();
  payload.decisions.forEach((decision, index) => validateDecision(decision, index, packetIds, seen));
  if (!Array.isArray(payload.evidence)) throw invalid('evidence', 'evidence must be an array');
  payload.evidence.forEach((entry, index) => validateEvidence(entry, index));
  if (!Array.isArray(payload.unresolved)) throw invalid('unresolved', 'unresolved must be a string array');
  payload.unresolved.forEach((item, index) => { if (typeof item !== 'string') throw invalid(`unresolved[${index}]`, 'unresolved must be a string'); });
  const packetIndex = packet?.index ?? 1;
  if (packetIndex === 1 && !payload.triage) throw invalid('triage', 'triage is required on packet 1');
  if (packetIndex !== 1 && payload.triage !== undefined) throw invalid('triage', 'triage is only accepted on packet 1');
  if (payload.triage !== undefined) {
    const triage = payload.triage;
    if (triage === null || typeof triage !== 'object' || Array.isArray(triage)) throw invalid('triage', 'triage must be an object');
    for (const key of Object.keys(triage)) if (!['summary', 'fallback'].includes(key)) throw invalid(`triage.${key}`, 'unknown triage key');
    if (typeof triage.summary !== 'string' || triage.summary.length > 4000) throw invalid('triage.summary', 'summary must be a string <= 4000 chars');
    if (typeof triage.fallback !== 'boolean') throw invalid('triage.fallback', 'fallback must be boolean');
  }
}

function folded(key, value, keyIndent) {
  const contentPad = ' '.repeat(keyIndent + 2);
  const body = String(value ?? '').split('\n').map(line => line === '' ? contentPad : `${contentPad}${line}`);
  return [`${' '.repeat(keyIndent)}${key}: >-`, ...body];
}
function foldedItem(value, itemIndent) {
  const contentPad = ' '.repeat(itemIndent + 2);
  const body = String(value ?? '').split('\n').map(line => line === '' ? contentPad : `${contentPad}${line}`);
  return [`${' '.repeat(itemIndent)}- >-`, ...body];
}
function foldedListItem(key, value, itemIndent) {
  const contentPad = ' '.repeat(itemIndent + 2);
  const body = String(value ?? '').split('\n').map(line => line === '' ? contentPad : `${contentPad}${line}`);
  return [`${' '.repeat(itemIndent)}- ${key}: >-`, ...body];
}

// One `# <label> review` heading and one fenced review: block, folded fields at
// eight spaces so parseReviewFindings reads the exact input strings back.
export function renderReviewMarkdown(record, payload) {
  const stage = record.stage ?? {};
  const lines = [
    `# ${stage.label} review`,
    '',
    '```yaml',
    'review:',
    '  kind: step',
    `  step: ${stage.label}`,
    `  target: ${stage.base}..${stage.head}`,
    '  scope: step',
    `  commit: ${stage.head}`,
    `  verdict: ${payload.verdict}`
  ];
  const findings = payload.findings ?? [];
  if (!findings.length) lines.push('  findings: []');
  else {
    lines.push('  findings:');
    for (const finding of findings) {
      lines.push(`    - id: ${finding.id}`);
      lines.push(`      severity: ${finding.severity}`);
      lines.push(`      category: ${finding.category}`);
      lines.push(`      actionable: ${finding.actionable === true}`);
      lines.push(`      line: ${finding.line}`);
      lines.push(`      commit: ${finding.commit}`);
      lines.push(...folded('file', finding.file, 6));
      lines.push(...folded('symbol', finding.symbol, 6));
      lines.push(...folded('signature', finding.signature, 6));
      lines.push(...folded('explanation', finding.explanation, 6));
      if (finding.correction !== undefined) lines.push(...folded('correction', finding.correction, 6));
    }
  }
  const verdicts = payload.fix_verdicts ?? [];
  if (!verdicts.length) lines.push('  fix_verdicts: []');
  else {
    lines.push('  fix_verdicts:');
    for (const entry of verdicts) {
      lines.push(`    - id: ${entry.id}`);
      lines.push(`      verdict: ${entry.verdict}`);
      lines.push(...folded('fix', entry.fix, 6));
      lines.push(...folded('evidence', entry.evidence, 6));
    }
  }
  const limitations = payload.limitations ?? [];
  if (!limitations.length) lines.push('  limitations: []');
  else {
    lines.push('  limitations:');
    for (const limit of limitations) lines.push(...foldedItem(limit, 4));
  }
  lines.push('```', '');
  return lines.join('\n');
}

// Prior accepted fixer receipts for this reviewed label, in packet order.
function fixGroups(record, payload) {
  const stage = record.stage ?? {};
  const current = { packetIndex: stage.packet?.index ?? 1, packet: stage.packet ?? { ids: [], pending_after: [] }, payload };
  const dir = join(record.package, 'runtime/runs');
  const waveId = record.wave_bindings?.wave_id ?? record.wave_id ?? null;
  const prior = [];
  let names = [];
  try { names = readdirSync(dir); } catch { names = []; }
  for (const name of names) {
    if (!name.endsWith('-stage.json')) continue;
    const runId = name.slice(0, -'-stage.json'.length);
    if (runId === record.id) continue;
    let receipt;
    try { receipt = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    if (receipt?.accepted !== true || receipt.role !== 'fixer' || receipt.label !== stage.label) continue;
    if (waveId !== null && receipt.wave_id !== waveId) continue;
    let packet = null;
    try { packet = JSON.parse(readFileSync(join(dir, `${runId}.json`), 'utf8'))?.stage?.packet ?? null; } catch { packet = null; }
    prior.push({ packetIndex: packet?.index ?? prior.length + 1, packet: packet ?? { ids: [], pending_after: [] }, payload: receipt.payload ?? {} });
  }
  // Rendering an earlier packet must not include later packets' decisions.
  const cutoff = current.packetIndex;
  return [current, ...prior.filter((group) => group.packetIndex <= cutoff)]
    .sort((a, b) => a.packetIndex - b.packetIndex);
}

// One `# <label> fix` heading and one fenced fix: block. Decisions from all accepted
// packets are merged in packet order; pending is runtime-computed.
export function renderFixMarkdown(record, payload) {
  const stage = record.stage ?? {};
  const groups = fixGroups(record, payload);
  const decisions = [];
  const verification = [];
  const unresolved = [];
  let commits = [];
  for (const group of groups) {
    const data = group.payload ?? {};
    const lastCommit = (data.commits ?? []).at(-1);
    const note = lastCommit ? `${lastCommit.slice(0, SHA_NOTES)}` : 'none';
    for (const decision of data.decisions ?? [])
      decisions.push({ ...decision, note: `${decision.note ?? ''} (packet ${group.packetIndex}, commit ${note})`.trim() });
    verification.push(...(data.evidence ?? []));
    unresolved.push(...(data.unresolved ?? []));
    commits = [...commits, ...(data.commits ?? [])];
  }
  const decided = new Set(decisions.map(decision => decision.id));
  const allIds = [...new Set(groups.flatMap(group => group.packet?.ids ?? []))];
  const pendingAfter = stage.packet?.pending_after ?? [];
  const pending = [...new Set([...pendingAfter, ...allIds.filter(id => !decided.has(id))])];
  const commit = commits.at(-1) ?? 'none';
  const lines = [
    `# ${stage.label} fix`,
    '',
    '```yaml',
    'fix:',
    '  kind: step',
    `  step: ${stage.label}`,
    `  consumed: ${relative(record.package, stagePaths(record).reviewPath)}`,
    `  target: ${stage.base}..${commit === 'none' ? stage.head : commit}`,
    '  decisions:'
  ];
  if (!decisions.length) lines.push('    []');
  for (const decision of decisions) {
    lines.push(`    - id: ${decision.id}`);
    lines.push(`      decision: ${decision.decision}`);
    lines.push(...folded('signature', decision.signature, 6));
    lines.push(...folded('note', decision.note, 6));
    if (decision.dismissal !== undefined) lines.push(`      dismissal: ${decision.dismissal}`);
    if (decision.approved !== undefined) lines.push(`      approved: ${decision.approved === true}`);
    if (decision.approval_source !== undefined) lines.push(...folded('approval_source', decision.approval_source, 6));
  }
  lines.push(`  material_change: ${commits.length > 0}`);
  lines.push(`  commit: ${commit}`);
  lines.push(`  pending: [${pending.join(', ')}]`);
  if (verification.length) {
    lines.push('  verification:');
    for (const entry of verification) {
      lines.push(...foldedListItem('evidence', entry.artifact, 4));
      lines.push(`      outcome: ${entry.outcome}`);
      lines.push(`      observed_commit: ${entry.observed_commit}`);
      if (entry.gate_id !== undefined) lines.push(...folded('gate_id', entry.gate_id, 6));
    }
  }
  if (unresolved.length) {
    lines.push('  unresolved:');
    for (const item of unresolved) lines.push(...foldedItem(item, 4));
  }
  lines.push('```', '');
  return lines.join('\n');
}

export function sourceFingerprint(checkout) {
  return {
    head: gitText(checkout, ['rev-parse', 'HEAD']).trim(),
    index: sha256(git(checkout, ['ls-files', '-s', '-z'])),
    tracked: sha256(git(checkout, ['diff', 'HEAD', '--binary'])),
    untracked: sha256(git(checkout, ['ls-files', '--others', '--exclude-standard', '-z']))
  };
}

export function recordStageFingerprint(record) {
  const fingerprint = sourceFingerprint(record.checkout);
  atomic(stagePaths(record).fingerprintPath, { version: 1, run_id: record.id, captured_at: new Date().toISOString(), fingerprint });
  return fingerprint;
}

const sameFingerprint = (left, right) => Boolean(left && right)
  && left.head === right.head && left.index === right.index && left.tracked === right.tracked && left.untracked === right.untracked;

function revListRange(checkout, base, head) {
  try { return new Set(gitText(checkout, ['rev-list', `${base}..${head}`]).split('\n').filter(Boolean)); }
  catch (error) { throw invalid('payload', `cannot resolve ${base}..${head}: ${error.message}`); }
}

function isAncestor(checkout, ancestor, descendant) {
  try { git(checkout, ['merge-base', '--is-ancestor', ancestor, descendant]); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}

function receiptBase(record, role, payload) {
  const stage = record.stage ?? {};
  return {
    version: 1, run_id: record.id, role,
    assignment_id: record.assignment_id ?? null,
    wave_id: record.wave_bindings?.wave_id ?? record.wave_id ?? null,
    step: record.step ?? null, label: stage.label, base: stage.base, head: stage.head,
    artifact: null, artifact_sha256: null, artifact_written: false,
    payload, fingerprint: null, accepted: false, refusal: null
  };
}

function refuse(record, role, payload, code, detail, fingerprint = null) {
  atomic(stagePaths(record).receiptPath, {
    ...receiptBase(record, role, payload), fingerprint, accepted: false,
    refusal: { code, detail }, submitted_at: new Date().toISOString()
  });
  throw refusalError({ code, message: detail });
}

// `submitStage(record, role, payload)`: lease first, then role/payload checks, then
// receipt intent, atomic Markdown, and the accepted receipt with its hash.
export function submitStage(record, role, payload) {
  assertLease(record);
  const stage = record.stage;
  if (!stage || stage.role !== role)
    throw refusalError({ code: 'stage-assignment-mismatch', message: `Stage assignment ${JSON.stringify(stage?.role)} does not match submitting role ${JSON.stringify(role)}.` });
  if (role !== 'reviewer' && role !== 'fixer')
    throw refusalError({ code: 'role-unknown', message: `Native role ${JSON.stringify(role)} is not a stage role.` });
  (role === 'reviewer' ? validateReviewPayload : validateFixPayload)(record, payload);

  const paths = stagePaths(record);
  let fingerprint = null;
  if (role === 'reviewer') {
    const after = sourceFingerprint(record.checkout);
    let before = null;
    try { before = JSON.parse(readFileSync(paths.fingerprintPath, 'utf8')).fingerprint ?? null; } catch { before = null; }
    fingerprint = { before, after };
    if (!before) refuse(record, role, payload, 'fingerprint-missing', 'No recorded reviewer source fingerprint for this run.', fingerprint);
    if (!sameFingerprint(before, after)) refuse(record, role, payload, 'reviewer-mutated-source', 'The reviewer checkout changed since session_start.', fingerprint);
    const range = revListRange(record.checkout, stage.base, stage.head);
    (payload.findings ?? []).forEach((finding, index) => {
      if (!range.has(finding.commit)) throw invalid(`findings[${index}].commit`, `commit ${finding.commit} is not in ${stage.base}..${stage.head}`);
    });
  } else {
    const head = gitText(record.checkout, ['rev-parse', 'HEAD']).trim();
    const commits = payload.commits ?? [];
    const last = commits[commits.length - 1] ?? stage.head;
    if (commits.some(commit => !isAncestor(record.checkout, stage.head, commit)))
      refuse(record, role, payload, 'fix-commit-foreign', 'A listed commit does not descend from the reviewed head.');
    if (head !== last) refuse(record, role, payload, 'fix-head-mismatch', `HEAD ${head} is not the last listed commit ${last}.`);
    if (gitText(record.checkout, ['status', '--porcelain', '--untracked-files=all']).trim() !== '')
      refuse(record, role, payload, 'fix-tree-dirty', 'The fixer checkout has uncommitted changes.');
  }

  const artifactPath = role === 'reviewer' ? paths.reviewPath : paths.fixPath;
  const markdown = role === 'reviewer' ? renderReviewMarkdown(record, payload) : renderFixMarkdown(record, payload);
  const intent = {
    ...receiptBase(record, role, payload), artifact: relative(record.package, artifactPath),
    fingerprint, accepted: true, refusal: null, submitted_at: new Date().toISOString()
  };
  atomic(paths.receiptPath, intent);
  atomic(artifactPath, markdown, { raw: true, mode: 0o644 });
  const accepted = { ...intent, artifact_written: true, artifact_sha256: sha256(Buffer.from(markdown)) };
  atomic(paths.receiptPath, accepted);
  return accepted;
}

// Item 4 (fix-packet planning, stage prompts, evidence-plan gate selection,
// readReviewState and nextReviewAction) lives in the state plane and is re-exported
// here so existing data-plane consumers keep one import surface.
export {
  planStagePackets, stagePrompt, stepGates, stepGateEvidence, readReviewState, nextReviewAction
} from './wave-review-state.mjs';

export { changedPaths, attributeWrites, checkSeal, runStageGates, sealMember, RETENTION_REF_PREFIX } from "./wave-review-seal.mjs";
