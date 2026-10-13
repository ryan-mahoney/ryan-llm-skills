// Bounded, read-only preparation and decision observation for the spec sentinel.
//
// Reports are prose written by planning skills, so parsing is deliberately
// conservative: only the exact recognized outcome spellings produce a value,
// conflicting values are invalid, and every read failure stays an explicit
// unknown instead of a guess. All I/O goes through the injected within/memo
// bounded reader (the same 65,536-byte small-file reader sentinel.mjs uses);
// this module never imports fs and never stats a file to invent a display
// date. Observation is never acceptance (INV-2).

import { join } from 'node:path';

export const PREPARATION_FILE = 'spec-prepare.md';
export const DECISION_FILE = 'decision-required.md';
export const PROPOSAL_FILE = 'proposal.md';
export const CRITIQUE_FILE = 'critique.md';
// The proposal originally read the first 4 KiB; complete reports can be larger,
// so every planning artifact shares the existing 64 KiB small-file bound.
export const PREPARATION_BYTES = 65536;
export const DECISION_EXCERPT_CHARS = 500;

const OUTCOMES = new Set(['prepared', 'blocked', 'decision-required']);
const STAGES = new Set(['architecture', 'specification']);
const DECISION_KEYS = ['stage', 'question', 'recommendation', 'recorded_at'];
const DECISION_KEY_SET = new Set(DECISION_KEYS);
const PROPOSAL_KEY_SET = new Set(['critique_recommended']);
const OUTCOME_LINE = /^\s*(?:overall\s+)?outcome\s*:\s*(?:`([a-z][a-z-]*)`|([a-z][a-z-]*))(?=$|[\s.,;:!?])/i;
const DATE_HINT = /\b(?:prepared|date|review)/i;
const DATE_VALUE = /\b((?:19|20)\d\d-\d\d-\d\d)\b/;
const FRONT_MATTER_KEY = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

// Pure line-anchored report parse. Only prepared/blocked/decision-required
// count; an unrecognized label, an unknown value or conflicting recognized
// values are invalid rather than a best guess. reported_at is only an
// explicitly recorded date near a Prepared/Date/Review line, never file time.
export function parsePreparation(text, source = null) {
  const outcomes = new Set();
  let reported_at = null;
  const lines = typeof text === 'string' ? text.split(/\r?\n/) : [];
  for (const line of lines) {
    const outcome = OUTCOME_LINE.exec(line);
    if (outcome) {
      const value = (outcome[1] ?? outcome[2]).toLowerCase();
      if (OUTCOMES.has(value)) outcomes.add(value);
    }
    if (reported_at === null && DATE_HINT.test(line)) {
      const date = DATE_VALUE.exec(line);
      if (date) reported_at = date[1];
    }
  }
  if (outcomes.size === 1) return { outcome: [...outcomes][0], reported_at, source };
  return {
    outcome: 'invalid', reported_at, source,
    reason: outcomes.size === 0 ? 'outcome-unrecognized' : 'outcome-conflict',
  };
}

// YAML-ish front matter restricted to the file start: `---`, key lines, `---`.
// A missing closing marker or a non-key line makes the whole block unusable
// rather than partially trusted; the body after the closing marker is ignored.
// A repeated recognized key is conflicting malformed metadata, not a last-wins
// overwrite; repeats of unrecognized keys stay ignored.
function frontMatterFields(text, recognized = null) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const fields = new Map();
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() === '---') return fields;
    const match = FRONT_MATTER_KEY.exec(lines[index]);
    if (!match) return null;
    const key = match[1];
    if (fields.has(key)) {
      if (recognized === null || recognized.has(key)) return null;
      continue;
    }
    fields.set(key, match[2]);
  }
  return null;
}

// JSON double-quoted strings are unescaped; every other scalar is the trimmed
// plain text. No YAML lists, anchors, comments or implicit typing.
function scalarValue(raw) {
  const value = raw.trim();
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Pure decision front-matter parse. All four keys must be present, the stage
// must be architecture/specification, the question nonempty and the recorded
// timestamp parseable; the recommendation may be empty. Display excerpts are
// truncated after validation. Malformed or absent front matter returns null.
export function parseDecision(text, source = null) {
  const fields = frontMatterFields(text, DECISION_KEY_SET);
  if (!fields || DECISION_KEYS.some(key => !fields.has(key))) return null;
  const stage = scalarValue(fields.get('stage'));
  const question = scalarValue(fields.get('question'));
  const recommendation = scalarValue(fields.get('recommendation'));
  const recorded_at = scalarValue(fields.get('recorded_at'));
  if (!STAGES.has(stage) || typeof question !== 'string' || question.trim() === ''
    || typeof recommendation !== 'string' || typeof recorded_at !== 'string'
    || !Number.isFinite(Date.parse(recorded_at))) return null;
  return {
    stage,
    question: question.slice(0, DECISION_EXCERPT_CHARS),
    recommendation: recommendation.slice(0, DECISION_EXCERPT_CHARS),
    recorded_at,
    source,
  };
}

// The proposal's leading front matter is the only machine-readable stage
// selection signal. An explicit boolean is returned; no front matter, a
// missing key or an unrecognized value is unknown (null), never false.
export function parseProposalFrontMatter(text) {
  const fields = frontMatterFields(text, PROPOSAL_KEY_SET);
  if (!fields || !fields.has('critique_recommended')) return null;
  const value = scalarValue(fields.get('critique_recommended'));
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

function readArtifact(readBounded, file, budget, within, memo) {
  if (typeof readBounded !== 'function') throw new TypeError('readBounded must be injected');
  return readBounded(file, PREPARATION_BYTES, budget, { within, memo });
}

// Read spec-prepare.md through the injected package-contained reader. An absent
// file is missing, never "prepared"; oversized/source-outside reads are invalid;
// a budget refusal is unavailable. The raw read outcome and byte count stay on
// the observation for diagnostics.
export async function readPreparation(packagePath, budget, { readBounded, memo = null } = {}) {
  const source = join(packagePath, PREPARATION_FILE);
  const result = await readArtifact(readBounded, source, budget, packagePath, memo);
  if (result.outcome === 'ok') {
    return { ...parsePreparation(result.text, source), read: result.outcome, bytes: result.bytes };
  }
  const outcome = result.outcome === 'missing' ? 'missing'
    : result.outcome === 'oversized' || result.outcome === 'invalid' ? 'invalid' : 'unavailable';
  return {
    outcome, reported_at: null, source, read: result.outcome, bytes: result.bytes ?? 0,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

// Read decision-required.md. No file is no decision (null). A usable read
// yields the validated DecisionObservation; unreadable, budget-refused and
// malformed records are an explicit unavailable marker, and an oversized
// record is invalid. This never throws on malformed content.
export async function readDecision(packagePath, budget, { readBounded, memo = null } = {}) {
  const source = join(packagePath, DECISION_FILE);
  const result = await readArtifact(readBounded, source, budget, packagePath, memo);
  if (result.outcome === 'missing') return null;
  if (result.outcome !== 'ok') {
    return {
      outcome: result.outcome === 'oversized' ? 'invalid' : 'unavailable',
      source, read: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }
  const decision = parseDecision(result.text, source);
  if (decision) return decision;
  return { outcome: 'unavailable', source, read: result.outcome, reason: 'decision-front-matter-invalid' };
}

// Presence of proposal.md and critique.md plus the proposal's explicit
// critique recommendation. Presence is false when absent, true when readable
// and null when unreadable/budget-refused. A missing proposal means the
// recommendation is false; a readable proposal without a valid explicit
// boolean means unknown (null).
export async function readPlanningArtifacts(packagePath, budget, { readBounded, memo = null } = {}) {
  const proposalRead = await readArtifact(readBounded, join(packagePath, PROPOSAL_FILE), budget, packagePath, memo);
  const critiqueRead = await readArtifact(readBounded, join(packagePath, CRITIQUE_FILE), budget, packagePath, memo);
  const proposal = proposalRead.outcome === 'ok' ? true : proposalRead.outcome === 'missing' ? false : null;
  const critique = critiqueRead.outcome === 'ok' ? true : critiqueRead.outcome === 'missing' ? false : null;
  const critique_recommended = proposalRead.outcome === 'missing' ? false
    : proposalRead.outcome === 'ok' ? parseProposalFrontMatter(proposalRead.text) : null;
  return { proposal, critique, critique_recommended };
}
