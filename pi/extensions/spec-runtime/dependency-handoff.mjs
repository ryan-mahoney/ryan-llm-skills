// Dependency acceptance handoff (step 7).
//
// Builds fresh-worker context from the spec-steps.json `requires` graph and the
// durable `runtime/waves/*.json` records alone. The card's declared prerequisites
// determine which steps are carried; a worker receipt or completion outcome never
// establishes acceptance, and recency is never used to infer a dependency.
//
// This module deliberately does not import runtime.mjs (D1): runtime.mjs
// re-exports `buildDependencyHandoff` and imports `observedRuns` from here.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { validateStepIndex } from '../../../scripts/spec-observe/steps.mjs';

// Moved verbatim from runtime.mjs; only its declaration becomes `export`.
export function observedRuns(packagePath, coverageGaps = []) {
  const dir = join(packagePath, 'runtime/runs');
  let names;
  try { names = readdirSync(dir); } catch (error) { coverageGaps.push(`Run receipts unavailable: ${error.code}`); return []; }
  return names.filter(name => /^[\w-]+\.json$/.test(name)).flatMap(name => {
    try {
      const run = read(join(dir, name));
      return run && typeof run.id === 'string' && typeof run.step === 'string' && run.state ? [run] : [];
    } catch (error) {
      if (coverageGaps.length < 8) coverageGaps.push(`Unreadable observation: ${name}`);
      return [];
    }
  });
}

const read = file => JSON.parse(readFileSync(file, 'utf8'));

const DETAIL_BUDGET = 8000;
const ITEM_LIMIT = 4;
const ITEM_LENGTH = 300;
const GAP_LIMIT = 8;
const GAP_LENGTH = 300;
const ARTIFACT_LIMIT = 8;
const WAVE_NAME = /^[A-Za-z0-9_-]{1,128}\.json$/;
const SEALED_HEAD = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MEMBER_PHASES = new Set(['queued', 'provisioning', 'implementing', 'reviewing', 'fixing', 'confirming', 'sealed', 'blocked', 'cancelled']);
const WAVE_STATES = new Set(['open', 'running', 'ready-to-integrate', 'integrating', 'verifying', 'promoting', 'integrated', 'blocked', 'cancelled']);

// D3: a spec-location refusal keeps its machine-readable code and remedy. Local
// copy of runtime.mjs `refusalError` so this module stays free of runtime imports.
function refusalError({ code, message, remedy }) {
  return Object.assign(new Error(`${code}: ${message}${remedy ? ` ${remedy}` : ''}`), { code, remedy });
}

// D8: a package-relative artifact path: no leading `/` and no `..` segment.
const portablePath = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/')
  && !value.split('/').includes('..');

const strings = values => Array.isArray(values) ? values.filter(value => typeof value === 'string') : [];

// D5: classify one record naming this step into its row, first match wins.
function classifyRecord(step, record) {
  const id = record.wave_id;
  const member = record.data.members?.[String(step)];
  const phase = member?.phase;
  const state = record.data.state;
  if (!MEMBER_PHASES.has(phase) || !WAVE_STATES.has(state)) return { status: 'unknown', reason: `wave-member-malformed:${id}`, phase, state, member };
  if (phase === 'sealed') {
    if (typeof member.sealed_head !== 'string' || !SEALED_HEAD.test(member.sealed_head)
      || !Array.isArray(member.review_artifacts) || !member.review_artifacts.length
      || !member.review_artifacts.every(portablePath)) return { status: 'unknown', reason: `wave-member-malformed:${id}`, phase, state, member };
  }
  if (phase === 'blocked' || phase === 'cancelled') return { status: 'blocked', reason: `member-${phase}:${id}`, phase, state, member };
  if (state === 'blocked' || state === 'cancelled') return { status: 'blocked', reason: `wave-${state}:${id}`, phase, state, member };
  if (phase === 'sealed' && state === 'integrated') return { status: 'accepted', reason: null, phase, state, member };
  if (phase === 'sealed') return { status: 'pending', reason: `wave-not-integrated:${id}:${state}`, phase, state, member };
  return { status: 'pending', reason: `member-${phase}:${id}`, phase, state, member };
}

// D5: combine the rows for every readable record naming this step.
function classifyStep(step, records) {
  const classified = records.map(record => ({ record, ...classifyRecord(step, record) }));
  const malformed = classified.find(entry => entry.status === 'unknown');
  if (malformed) return { status: 'unknown', reason: malformed.reason, wave_id: malformed.record.wave_id, accepted: null, reviewed: true };

  const accepted = classified.filter(entry => entry.status === 'accepted');
  const pending = classified.filter(entry => entry.status === 'pending');
  const blocked = classified.find(entry => entry.status === 'blocked');
  const heads = new Set(accepted.map(entry => entry.member.sealed_head));
  if ((accepted.length > 1 && heads.size > 1) || (accepted.length > 0 && pending.length > 0)) {
    const ids = [...new Set(records.map(record => record.wave_id))].sort();
    return { status: 'conflict', reason: `conflicting-wave-records:${ids.join(',')}`, wave_id: null, accepted: null, reviewed: true };
  }
  if (accepted.length) {
    const first = accepted.sort((a, b) => (a.record.wave_id < b.record.wave_id ? -1 : 1))[0];
    return { status: 'accepted', reason: null, wave_id: first.record.wave_id, accepted: { id: first.record.wave_id, member: first.member }, reviewed: true };
  }
  if (pending.length) {
    const first = pending.sort((a, b) => (a.record.wave_id < b.record.wave_id ? -1 : 1))[0];
    return { status: 'pending', reason: first.reason, wave_id: first.record.wave_id, accepted: null, reviewed: true };
  }
  if (blocked) return { status: 'blocked', reason: blocked.reason, wave_id: blocked.record.wave_id, accepted: null, reviewed: true };
  return { status: 'unknown', reason: 'no-accepted-wave-record', wave_id: null, accepted: null, reviewed: false };
}

// D7: resolve the completion that feeds counts and details.
function completionFor(packageDir, step, classification, runs, coverageGaps) {
  const runsDir = join(packageDir, 'runtime/runs');
  let runId = null;
  if (classification.status === 'accepted' && classification.accepted) {
    runId = classification.accepted.member.implementation_run_id ?? classification.accepted.member.run_id ?? null;
  } else {
    const card = `step-${String(step).padStart(3, '0')}-subspec.md`;
    let latest = null;
    for (const run of runs) {
      if (basename(run.step || '') !== card) continue;
      if (!latest || (run.started_at || '') >= (latest.started_at || '')) latest = run;
    }
    runId = latest?.id ?? null;
  }
  let completion = null;
  if (runId) {
    const file = join(runsDir, `${runId}-completion.json`);
    try { if (existsSync(file)) completion = read(file); } catch { completion = null; }
  }
  if (!completion) coverageGaps.push(`step ${step}: no completion receipt`);
  return { runId, completion };
}

// D8: ordered, package-relative artifact pointers, first 8 kept.
function artifactsFor(packageDir, step, records, classification, runId) {
  const paths = [];
  for (const record of records) paths.push(`runtime/waves/${record.wave_id}.json`);
  const reviewer = classification.accepted?.member
    ?? (classification.reviewed ? (records.slice().sort((a, b) => (a.wave_id < b.wave_id ? -1 : a.wave_id > b.wave_id ? 1 : 0))[0]?.data.members?.[String(step)]) : null);
  const reviewPointers = Array.isArray(reviewer?.review_artifacts) ? reviewer.review_artifacts.filter(portablePath) : [];
  paths.push(...reviewPointers);
  const gatedPaths = [];
  if (runId) {
    gatedPaths.push(`runtime/runs/${runId}-completion.json`);
    gatedPaths.push(`runtime/runs/${runId}-learning.md`);
  }
  gatedPaths.push(`learnings/step-${String(step).padStart(3, '0')}-learning.md`);
  let reviews = [];
  try {
    reviews = readdirSync(join(packageDir, 'reviews'))
      .filter(name => name.startsWith(`step-${String(step).padStart(3, '0')}-`) && name.endsWith('.md'))
      .map(name => `reviews/${name}`).sort();
  } catch { reviews = []; }
  // D8: recorded wave and review pointers are listed regardless of whether the
  // file currently exists; only runtime/runs and the learning path are gated.
  const existing = gatedPaths.filter(path => existsSync(join(packageDir, path)));
  const ordered = [...paths, ...existing, ...reviews];
  const kept = ordered.slice(0, ARTIFACT_LIMIT);
  return { artifacts: kept, artifacts_omitted: ordered.length - kept.length };
}

// D9: bounded excerpt lists cut to 4 items of 300 characters.
function boundList(values) {
  const list = strings(values);
  const items = list.slice(0, ITEM_LIMIT).map(value => value.slice(0, ITEM_LENGTH));
  const truncated = list.length > ITEM_LIMIT || list.some(value => value.length > ITEM_LENGTH);
  return { items, truncated };
}

export function buildDependencyHandoff({ packageDir, step, targets }) {
  const indexFile = join(packageDir, 'spec-steps.json');
  if (!existsSync(indexFile)) return null;
  let parsed;
  try { parsed = read(indexFile); } catch (error) {
    throw refusalError({ code: 'dependency-index-unreadable', remedy: 'Fix the JSON in spec-steps.json.', message: `Cannot read ${indexFile}: ${error.message}` });
  }
  // Step 7: the witness index references evidence gates, so the dependency graph
  // can only be validated against the package's evidence plan. A legacy package
  // without one (or with an unparseable one) stays as it was: an index that
  // references gates is dependency-graph-invalid, and one that does not still
  // validates as before.
  let evidencePlan = null;
  const evidencePlanFile = join(packageDir, 'evidence-plan.json');
  if (existsSync(evidencePlanFile)) {
    try { evidencePlan = read(evidencePlanFile); } catch { evidencePlan = null; }
  }
  const validation = validateStepIndex(parsed, { targets, evidencePlan });
  if (validation.legacy) return null;
  if (!validation.ok) {
    throw refusalError({ code: 'dependency-graph-invalid', remedy: 'Fix the requires/writes declarations before starting this step.', message: validation.errors.slice(0, 3).join('; ') });
  }
  const entry = parsed.steps.find(candidate => candidate.step === step);
  if (!entry || typeof step !== 'number' || !Number.isInteger(step)) {
    throw refusalError({ code: 'dependency-step-unknown', remedy: 'Declare this step in spec-steps.json.', message: `Step ${step} is not in the step index.` });
  }
  const requires = [...entry.requires].sort((a, b) => a - b);

  // D5: scan durable wave records once.
  const waveDir = join(packageDir, 'runtime/waves');
  const coverageGaps = [];
  const recordsByStep = new Map();
  const unreadable = [];
  let names = [];
  try { names = readdirSync(waveDir); } catch { names = []; }
  for (const name of names.filter(name => WAVE_NAME.test(name)).sort()) {
    const file = join(waveDir, name);
    let data;
    try {
      data = read(file);
      if (data.version !== 1 && data.schema_version !== 1) throw new Error('unsupported version');
    } catch { unreadable.push(name); coverageGaps.push(`unreadable wave record: ${name}`); continue; }
    const waveId = name.replace(/\.json$/, '');
    const members = data.members && typeof data.members === 'object' ? data.members : {};
    for (const dependency of requires) {
      if (members[String(dependency)] === undefined) continue;
      if (!recordsByStep.has(dependency)) recordsByStep.set(dependency, []);
      recordsByStep.get(dependency).push({ wave_id: waveId, data });
    }
  }

  const runs = observedRuns(packageDir, coverageGaps);
  const index = [];
  const details = [];
  for (const dependency of requires) {
    const records = recordsByStep.get(dependency) ?? [];
    let classification = records.length ? classifyStep(dependency, records) : { status: 'unknown', reason: 'no-accepted-wave-record', wave_id: null, accepted: null, reviewed: false };
    // D5: any unreadable record file degrades a would-be acceptance to unknown.
    if (classification.status === 'accepted' && unreadable.length) {
      classification = { status: 'unknown', reason: `wave-record-unreadable:${[...unreadable].sort()[0]}`, wave_id: classification.wave_id, accepted: null, reviewed: classification.reviewed };
    }
    const { runId, completion } = completionFor(packageDir, dependency, classification, runs, coverageGaps);
    const gaps = Array.isArray(completion?.gaps) ? completion.gaps : [];
    const remaining = Array.isArray(completion?.learning?.remaining_work) ? completion.learning.remaining_work : [];
    const unresolvedCount = completion ? gaps.length + remaining.length : null;
    const artifacts = artifactsFor(packageDir, dependency, records, classification, runId);
    index.push({
      step: dependency,
      status: classification.status,
      reason: classification.reason,
      wave_id: classification.wave_id,
      accepted_commit: classification.status === 'accepted' ? classification.accepted?.member?.sealed_head ?? null : null,
      review_status: classification.status === 'accepted' ? 'closed' : (classification.reviewed ? 'open' : 'none'),
      unresolved_obligations: unresolvedCount,
      artifacts: artifacts.artifacts,
      artifacts_omitted: artifacts.artifacts_omitted,
    });
    const decisions = boundList(completion?.decisions);
    const unresolved = boundList(completion?.gaps);
    const remainingWork = boundList(completion?.learning?.remaining_work);
    const findings = boundList(completion?.findings);
    details.push({
      step: dependency,
      decisions: decisions.items,
      unresolved: unresolved.items,
      remaining_work: remainingWork.items,
      findings: findings.items,
      truncated: decisions.truncated || unresolved.truncated || remainingWork.truncated || findings.truncated,
    });
  }

  // D9: keep details in ascending order until the JSON budget is reached.
  const omitted = [];
  const keptDetails = [];
  let overflowed = false;
  for (const detail of details) {
    if (overflowed || JSON.stringify([...keptDetails, detail]).length > DETAIL_BUDGET) { overflowed = true; omitted.push(detail.step); }
    else keptDetails.push(detail);
  }

  return {
    step,
    source: 'spec-steps.json requires',
    index,
    details: keptDetails,
    omitted_details: omitted,
    coverage_gaps: coverageGaps.slice(0, GAP_LIMIT).map(gap => gap.slice(0, GAP_LENGTH)),
    obligations: 'Paths are relative to PACKAGE. Every listed step is a required prerequisite. Only status accepted means sealed, independently reviewed and integrated; a completed worker receipt is not acceptance. Before editing code that depends on a step in omitted_details or whose status is not accepted, read its artifacts. Omitted details are not evidence of no blockers.',
  };
}
