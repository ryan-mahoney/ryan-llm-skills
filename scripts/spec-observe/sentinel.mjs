// Read-only bounded workspace facts for the spec sentinel.
//
// Every read here is observational: regular files, allowlisted fields, explicit
// byte caps and one shared total budget. Nothing in this module writes, launches,
// controls or models anything, and no transcript, metric or raw failure log is
// read. Observation is never acceptance (INV-2).

import { createHash } from 'node:crypto';
import { open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { canonicalPackage } from '../../pi/extensions/spec-runtime/runtime.mjs';
import { publicHint } from '../../pi/extensions/spec-runtime/monitor.mjs';
import { discoverManaged } from './core.mjs';

export const SENTINEL_LIMITS = Object.freeze({
  roots: 20,
  assignments: 50,
  packageChildren: 100,
  receiptFiles: 100,
  indexEntries: 1000,
  smallJsonBytes: 65536,
  activityBytes: 32768,
  totalBytes: 4 * 1024 * 1024,
  quietActivityMs: 120000,
});

const RECEIPT_KEYS = ['id', 'assignment_id', 'package', 'step', 'checkout', 'parent_session', 'owner_session', 'editor_session',
  'owner_model', 'editor_model', 'state', 'started_at', 'finished_at', 'dispatch_requested_at', 'lock'];
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const ROLES = ['owner', 'editor'];
const CONDITION_GENERATION = 1;
const MAX_REASONS = 50;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const codeOf = error => error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
const messageOf = error => publicHint(error instanceof Error ? error.message : String(error));
const digestOf = value => sha256(typeof value === 'string' ? value : JSON.stringify(value));
const insideDir = (parent, child) => {
  // Real canonical paths can alias (for example /tmp vs /private/tmp), so the
  // containment check happens on resolved real paths, not on spelling.
  const root = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(root) && child !== parent;
};

const samePath = async (left, right) => {
  if (resolve(left) === right) return true;
  return await realpath(left).catch(() => null) === right;
};

// Additive identity helper: one hash formula for workspace directories and
// condition identities. Scope separation keeps routed workspaces distinct.
export function workspaceKey({ agentDir, scope = null }) {
  return sha256(JSON.stringify([resolve(agentDir), scope ?? null]));
}

// Enrollment state is written only by the owning Pi session; the reader only
// observes it. One directory per agent dir and routing scope.
export function enrollmentDirectory({ agentDir, scope = null }) {
  return join(resolve(agentDir), 'spec-sentinel', workspaceKey({ agentDir, scope }), 'enrollments');
}

// Bounded, read-only enrollment discovery. Unreadable or malformed state is a
// reported fact, never a throw: status must survive corrupt enrollment.
export async function readEnrollments({ agentDir, scope = null }, { limit = 100 } = {}) {
  const directory = enrollmentDirectory({ agentDir, scope });
  const budget = makeBudget();
  const errors = [];
  const records = [];
  const roots = [];
  const listed = await listDirectory(directory, limit, entry => entry.isFile() && entry.name.endsWith('.json'));
  if (listed.entries === null) {
    // Absent enrollment is an empty set, not an error.
    if (listed.code !== 'ENOENT') errors.push({ path: directory, code: listed.code });
    return { roots, records, errors };
  }
  if (listed.truncated) errors.push({ path: directory, code: 'ENROLLMENT_CAP' });
  for (const entry of listed.entries) {
    const file = join(directory, entry.name);
    const result = await readJson(file, SENTINEL_LIMITS.smallJsonBytes, budget, {
      prefix: 'enrollment', oversize: false,
      allow: value => value && typeof value === 'object' && value.version === 1
        && typeof value.root === 'string' && isAbsolute(value.root)
        && typeof value.common === 'string' && isAbsolute(value.common)
        ? { version: 1, root: value.root, common: value.common } : null,
    });
    if (result.outcome === 'read-budget') { errors.push({ path: file, code: 'READ_BUDGET' }); break; }
    if (result.outcome === 'oversized') { errors.push({ path: file, code: 'ENROLLMENT_OVERSIZED' }); continue; }
    if (result.outcome !== 'ok') { errors.push({ path: file, code: 'ENROLLMENT_INVALID' }); continue; }
    records.push({ path: file, ...result.record });
    if (!roots.includes(result.record.root)) roots.push(result.record.root);
  }
  return { roots, records, errors };
}

function clock(now) {
  return typeof now === 'function' ? now : () => now;
}

function clockIso(now) {
  const value = typeof now === 'function' ? now() : now;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return validTime(typeof value === 'string' ? value : null) ?? new Date().toISOString();
}

function makeCoverage(state, reasons, omitted, bytes_read, observed_at) {
  return { state, reasons: reasons.slice(0, MAX_REASONS), omitted, bytes_read, observed_at };
}

// Reads are bounded twice: per file cap and one shared workspace byte budget.
// A skipped read is a reported fact, never a guessed one.
function makeBudget() {
  return { bytes: 0 };
}

async function readBounded(file, maxBytes, budget) {
  // The budget is checked before the read and enforced again on the actual
  // bytes so coverage.bytes_read can never exceed the workspace total.
  if (budget.bytes + maxBytes > SENTINEL_LIMITS.totalBytes) {
    return { outcome: 'read-budget', reason: `read-budget: ${file}`, bytes: 0 };
  }
  let handle;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (budget.bytes + bytesRead > SENTINEL_LIMITS.totalBytes) {
      return { outcome: 'read-budget', reason: `read-budget: ${file}`, bytes: 0 };
    }
    budget.bytes += bytesRead;
    if (bytesRead > maxBytes) return { outcome: 'oversized', reason: null, bytes: bytesRead };
    return { outcome: 'ok', text: buffer.subarray(0, bytesRead).toString('utf8'), bytes: bytesRead };
  } catch (error) {
    // A vanished file is a missing fact, not corrupt evidence.
    return { outcome: codeOf(error) === 'ENOENT' ? 'missing' : 'invalid', reason: `${codeOf(error)}: ${file}`, bytes: 0 };
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Read one bounded JSON file and allowlist only what callers may keep.
async function readJson(file, maxBytes, budget, { prefix = 'read-error', oversize = true, allow } = {}) {
  const result = await readBounded(file, maxBytes, budget);
  if (result.outcome !== 'ok') {
    return { ...result, reason: result.reason ?? (oversize ? `${prefix}-oversized: ${file}` : null) };
  }
  let value;
  try { value = JSON.parse(result.text); }
  catch { return { outcome: 'invalid', reason: `${prefix}-invalid: ${file}`, bytes: result.bytes }; }
  const record = allow(value);
  if (!record) return { outcome: 'invalid', reason: `${prefix}-invalid: ${file}`, bytes: result.bytes };
  return { outcome: 'ok', record, bytes: result.bytes, digest: digestOf(result.text) };
}

// Every directory walk stops at limit+1 so an unbounded directory can neither
// stall the reader nor inflate the snapshot.
async function listDirectory(dir, limit, matcher = () => true) {
  let handle;
  try { handle = await opendir(dir); }
  catch (error) { return { entries: null, truncated: false, code: codeOf(error) }; }
  const entries = [];
  let truncated = false;
  try {
    while (entries.length < limit) {
      const entry = await handle.read();
      if (!entry) break;
      if (!matcher(entry)) continue;
      entries.push(entry);
    }
    if (entries.length >= limit) {
      // Only another matching entry is a truncation; other names are not
      // candidates this walk would have collected.
      let next;
      while ((next = await handle.read())) if (matcher(next)) { truncated = true; break; }
    }
  } catch (error) {
    return { entries, truncated, code: codeOf(error) };
  } finally {
    await handle.close().catch(() => {});
  }
  return { entries, truncated };
}

const sortPaths = values => [...new Set(values.map(value => resolve(value)))].sort();

// Selection orders live/non-terminal work ahead of recent terminal attempts,
// then newest first. It orders observed facts; it is not a priority claim.
const stateRank = state => state === 'running' ? 0 : state === 'blocked' ? 1 : state === 'cancelling' ? 2 : TERMINAL.has(state) ? 4 : 3;

function compareCandidates(a, b) {
  // Candidates carry raw receipt fields; execution and start time are read
  // from the receipt so live work actually sorts ahead of terminal attempts.
  const state = item => item.receipt?.state ?? 'unknown';
  const started = item => item.receipt?.started_at ?? '';
  return stateRank(state(a)) - stateRank(state(b))
    || String(started(b)).localeCompare(String(started(a)))
    || String(a.id).localeCompare(String(b.id));
}

const stepName = steps => step => steps.find(item => item.step === step)?.name ?? null;

function obligationForStep(receiptStep, steps) {
  const match = /(?:^|[/\\])step-(\d+)-subspec\.md$/.exec(receiptStep ?? '');
  if (!match) return null;
  const number = Number(match[1]);
  const name = stepName(steps)(number);
  return `step ${number} of ${steps.length}${name ? `: ${publicHint(name)}` : ''}`;
}

// Conditions are derived facts in memory. They describe what was observed and
// what is still owed; they never accept work, claim liveness or grant recovery.
function runConditions(run, snapshotObservedAt) {
  const reasons = run.coverage.reasons;
  const has = prefix => reasons.some(reason => reason === prefix || reason.startsWith(`${prefix}:`));
  const signature = digestOf(JSON.stringify([run.execution, run.coverage.state, run.source_hashes]));
  const fact_ids = run.source_hashes.map(value => value.slice(0, 16));
  const conditions = [];
  const add = (kind, severity, state) => conditions.push({
    id: sha256(`${run.package}\u0000${run.assignment_id}\u0000${kind}\u0000${signature}\u0000${CONDITION_GENERATION}`).slice(0, 32),
    kind, severity, state, fact_ids,
  });
  if (run.activity === null) {
    if (has('activity-oversized') || has('activity-invalid')) add('activity-unreadable', 'attention', 'unknown');
    else if (has('activity-mismatch')) add('activity-mismatch', 'attention', 'unknown');
    else add('activity-unknown', 'info', 'unknown');
  }
  if (run.execution === 'completed') add('reconciliation-pending', 'info', 'open');
  else if (run.execution === 'failed') add('execution-failed', 'attention', 'open');
  else if (run.execution === 'blocked') add('execution-blocked', 'attention', 'open');
  else if (run.execution === 'cancelled') add('execution-cancelled', 'info', 'open');
  for (const kind of ['lease-missing', 'lease-mismatch', 'lease-revoked']) if (reasons.includes(kind)) add(kind, 'attention', 'open');
  // Silence and slow starts stay informational: no spinning or stuck claim.
  const observed = Date.parse(run.observed_at);
  const snapshot = Date.parse(snapshotObservedAt);
  if (!TERMINAL.has(run.execution) && Number.isFinite(observed) && Number.isFinite(snapshot)
      && snapshot - observed > SENTINEL_LIMITS.quietActivityMs) add('quiet-activity', 'info', 'open');
  return conditions;
}

// Re-derives conditions from collected fields only: no I/O, and repeating the
// call on the same snapshot reproduces the same conditions.
export function reduceConditions(snapshot) {
  const observedAt = snapshot?.coverage?.observed_at ?? clockIso(Date.now);
  return {
    ...snapshot,
    runs: (snapshot?.runs ?? []).map(run => ({ ...run, conditions: runConditions(run, observedAt) })),
  };
}

const renderLine = value => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
  .replace(/\s+/g, ' ').trim();

// Coverage and condition lines keep their indentation while control characters
// and runs of whitespace inside the text are collapsed.
const renderDetail = (indent, value) => `${indent}${String(value ?? '')
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
  .replace(/\s+/g, ' ').trim()}`;

// Plain deterministic projection: identifiers, states and public hints only.
// Raw receipt fields, command bodies, tokens, pids and costs never appear.
export function renderWorkspace(snapshot) {
  const coverage = snapshot?.coverage ?? makeCoverage('unavailable', [], null, 0, clockIso(Date.now));
  const runs = snapshot?.runs ?? [];
  const omitted = Number.isFinite(coverage.omitted) ? ` · omitted ${coverage.omitted}` : '';
  const lines = [`Spec sentinel · workspace ${String(snapshot?.workspace ?? '').slice(0, 12)} · coverage ${coverage.state}${omitted} · ${runs.length} run(s)`];
  for (const run of runs) {
    lines.push(renderLine(`  ${basename(dirname(run.repository))}/${basename(run.package)} · ${run.assignment_id} · ${run.execution} · `
      + `${run.checkout ? basename(run.checkout) : 'checkout unknown'} · ${run.obligation || 'obligation unknown'} · ${run.activity || 'activity unknown'}`));
    if (run.coverage.state !== 'complete' || run.coverage.reasons.length) {
      lines.push(renderDetail('    ', `coverage ${run.coverage.state} (${run.coverage.reasons.join(', ')})`));
    }
    if (run.conditions?.length) {
      lines.push(renderDetail('    ', run.conditions.map(condition => `${condition.kind} [${condition.severity}/${condition.state}]`).join(' · ')));
    }
  }
  if (!runs.length) lines.push('  No observed runs.');
  if (coverage.reasons.length) lines.push(renderLine(`Coverage notes: ${coverage.reasons.join(', ')}`));
  return lines;
}

export async function collectWorkspace({ roots = [], packages = [], indexDir = join(homedir(), '.pi/agent/spec-runtime'),
  now = Date.now, agentDir, scope } = {}) {
  const tick = clock(now);
  const readTime = clockIso(tick);
  const budget = makeBudget();
  const reasons = [];
  let knownOmitted = 0;
  let unknownOmission = false;
  const workspace = workspaceKey({ agentDir: agentDir ?? dirname(resolve(indexDir)), scope: scope ?? process.env.PI_INTERCOM_SCOPE_ID ?? null });

  // Roots are explicit enrollment: strings only, resolved, deduplicated, sorted.
  const enrolled = sortPaths(Array.isArray(roots) ? roots.filter(value => typeof value === 'string') : []);
  if (enrolled.length > SENTINEL_LIMITS.roots) {
    reasons.push(`roots-cap: selected ${SENTINEL_LIMITS.roots} of ${enrolled.length}`);
    knownOmitted += enrolled.length - SENTINEL_LIMITS.roots;
  }

  const facts = new Map();
  const addPackage = canonical => {
    let fact = facts.get(canonical.packagePath);
    if (!fact) {
      fact = { ...canonical, sources: new Map(), checkpoints: null, stepIndex: null };
      facts.set(canonical.packagePath, fact);
    }
    return fact;
  };

  for (const root of enrolled.slice(0, SENTINEL_LIMITS.roots)) {
    const specs = join(root, '.specs');
    const listed = await listDirectory(specs, SENTINEL_LIMITS.packageChildren, entry => entry.isDirectory());
    if (listed.entries === null) {
      // Missing .specs is reported, never guessed around.
      reasons.push(`root-unavailable: ${specs} (${listed.code})`);
      continue;
    }
    if (listed.truncated) {
      reasons.push(`package-cap: ${specs}`);
      unknownOmission = true;
    }
    for (const entry of listed.entries) {
      const child = join(specs, entry.name);
      try { addPackage(canonicalPackage(child)); }
      catch (error) {
        // A throw (including linked-worktree rejection) is a fact, never a package.
        reasons.push(`package-noncanonical: ${child} (${messageOf(error)})`);
      }
    }
  }

  for (const requested of Array.isArray(packages) ? packages : []) {
    if (typeof requested !== 'string') continue;
    try { addPackage(canonicalPackage(requested)); }
    catch (error) { reasons.push(`package-noncanonical: ${resolve(requested)} (${messageOf(error)})`); }
  }

  // Managed index pointers are discovery hints only: reading one never enrolls
  // a repository, and a pointer without its receipt stays an observed absence.
  let managed = { runs: [], discovery_errors: [], candidates_truncated: false, runs_truncated: false };
  try { managed = await discoverManaged(indexDir, { limit: SENTINEL_LIMITS.indexEntries }); }
  catch (error) {
    reasons.push(`index-unavailable: ${indexDir} (${codeOf(error)})`);
    unknownOmission = true;
    managed = { runs: [], discovery_errors: [], candidates_truncated: false, runs_truncated: false };
  }
  for (const failure of managed.discovery_errors ?? []) {
    // ENOENT for the index directory itself is an empty index, not an error.
    if (failure.code === 'ENOENT' && resolve(failure.path) === resolve(indexDir)) continue;
    reasons.push(`index-unavailable: ${failure.path} (${failure.code})`);
    unknownOmission = true;
  }
  if (managed.candidates_truncated || managed.runs_truncated) {
    reasons.push(`index-cap: ${indexDir}`);
    unknownOmission = true;
  }
  for (const pointer of managed.runs) {
    // A pointer only names a package to observe; it never becomes a run row.
    // A noncanonical pointer is reported and dropped.
    try { addPackage(canonicalPackage(pointer.package)); }
    catch (error) {
      reasons.push(`index-entry-invalid: ${pointer.run_id} (${messageOf(error)})`);
    }
  }

  const collected = [];
  let staleReceipts = false;
  const note = reason => { if (reason) reasons.push(reason); };
  const noteUnknown = reason => { if (reason) { reasons.push(reason); unknownOmission = true; } };
  for (const fact of facts.values()) {
    collected.push(...await collectPackage(fact, budget, note, noteUnknown));
    if (fact.staleReceipts) staleReceipts = true;
  }

  collected.sort(compareCandidates);
  const chosen = collected.slice(0, SENTINEL_LIMITS.assignments);
  if (collected.length > SENTINEL_LIMITS.assignments) {
    reasons.push(`assignments-cap: selected ${SENTINEL_LIMITS.assignments} of ${collected.length}`);
    knownOmitted += collected.length - SENTINEL_LIMITS.assignments;
  }

  const runs = [];
  const mark = reason => { if (reason) reasons.push(reason); };
  for (const candidate of chosen) runs.push(await observeRun(candidate, budget, mark, readTime));

  const packageRequested = enrolled.length > 0 || (Array.isArray(packages) && packages.length > 0);
  let state;
  if (!packageRequested && !facts.size && !reasons.length) {
    state = 'complete';
    if (!reasons.length) reasons.push('no enrolled roots');
  } else if (!facts.size && (packageRequested || knownOmitted || unknownOmission || reasons.length)) {
    // Nothing could be canonicalized while something was asked for or omitted.
    state = 'unavailable';
    if (!reasons.length) reasons.push('no canonical package available');
  } else {
    // A replaced receipt makes the package set itself uncertain.
    state = (staleReceipts || runs.some(run => run.coverage.state === 'stale')) ? 'stale'
      : (knownOmitted || reasons.length || unknownOmission) ? 'partial' : 'complete';
  }
  const coverage = makeCoverage(state, reasons, unknownOmission ? null : knownOmitted, budget.bytes, readTime);
  return reduceConditions({ version: 1, workspace, coverage, runs });
}

// Receipts are examined in one bounded pass: identity mismatches are stale
// evidence and the run is skipped, never re-attributed to another identity.
async function collectPackage(fact, budget, note, noteUnknown) {
  const runsDir = join(fact.packagePath, 'runtime', 'runs');
  const listed = await listDirectory(runsDir, SENTINEL_LIMITS.receiptFiles,
    entry => entry.isFile() && entry.name.endsWith('.json') && !entry.name.includes('-activity'));
  const found = [];
  if (listed.entries === null) {
    // A package without a runs directory has no receipts to observe.
    if (listed.code !== 'ENOENT') noteUnknown(`receipts-unavailable: ${runsDir} (${listed.code})`);
    return found;
  }
  if (listed.truncated) noteUnknown(`receipts-cap: ${fact.packagePath}`);
  for (const entry of listed.entries) {
    const file = join(runsDir, entry.name);
    const id = entry.name.slice(0, -'.json'.length);
    const result = await readJson(file, SENTINEL_LIMITS.smallJsonBytes, budget, {
      prefix: 'receipt', oversize: false,
      // Only these receipt fields are observable; result, error, token and
      // usage/cost never enter the snapshot.
      allow: value => value && typeof value === 'object' && typeof value.id === 'string' ? value : null,
    });
    if (result.outcome === 'read-budget') { noteUnknown(result.reason); break; }
    if (result.outcome === 'oversized') { note(`receipt-oversized: ${file}`); continue; }
    if (result.outcome !== 'ok') { note(`receipt-invalid: ${file}`); continue; }
    const value = result.record;
    if (value.id !== id || (typeof value.package === 'string' && !(await samePath(value.package, fact.packagePath)))) {
      note(`receipt-mismatch: ${file}`);
      fact.staleReceipts = true;
      continue;
    }
    const receipt = {};
    for (const key of RECEIPT_KEYS) if (typeof value[key] === 'string') receipt[key] = value[key];
    found.push({ fact, id, receipt, source: [{ file, digest: result.digest }], bytes: result.bytes });
  }
  return found;
}

async function observeRun(candidate, budget, note, readTime) {
  const fact = candidate.fact;
  const receipt = candidate.receipt ?? {};
  const runReasons = [];
  const runBytes = { value: candidate.bytes ?? 0 };
  // Package-level reads are shared; this wrapper attributes them to the first
  // selected run that uses them so each run reports its own bytes_read.
  const runBudget = {
    get bytes() { return budget.bytes; },
    set bytes(value) { runBytes.value += value - budget.bytes; budget.bytes = value; },
  };
  let stale = false;
  let partial = false;
  const mark = (reason, kind) => {
    if (!reason) return;
    runReasons.push(reason);
    note(reason);
    // Stale dominates: replaced or foreign sources outweigh any cap or read gap.
    if (kind === 'stale') stale = true;
    else partial = true;
  };
  const source = [...(candidate.source ?? [])];

  const steps = await readStepIndex(fact, runBudget, mark);
  if (steps.source) source.push({ file: steps.source, digest: steps.digest });

  const activity = await readActivity(fact, candidate.id, runBudget, mark);
  source.push(...activity.sources);

  const execution = receipt.state ?? 'unknown';
  if (!TERMINAL.has(execution)) {
    // Lease facts are read only for live runs; terminal runs never get one
    // invented for them.
    const lease = await readLease(fact, receipt, candidate.id, runBudget, mark);
    source.push(...lease.sources);
  }

  const checkpoints = await readCheckpoints(fact, runBudget, mark);
  let workflow_id = null;
  let obligation = obligationForStep(receipt.step, steps.steps);
  for (const checkpoint of checkpoints) {
    if (checkpoint.package !== fact.packagePath) continue;
    if (!checkpoint.workers.includes(candidate.id) && !(receipt.assignment_id && checkpoint.workers.includes(receipt.assignment_id))) continue;
    workflow_id = checkpoint.workflow;
    obligation = checkpoint.summary ? publicHint(checkpoint.summary) : obligation;
    const entry = fact.sources.get(`checkpoint:${checkpoint.workflow}`);
    if (entry) source.push({ file: entry.file, digest: entry.digest });
    break;
  }

  const observed_at = activity.observed ?? validTime(receipt.started_at ?? null) ?? readTime;
  return {
    repository: fact.common,
    package: fact.packagePath,
    checkout: typeof receipt.checkout === 'string' ? receipt.checkout : null,
    workflow_id,
    assignment_id: typeof receipt.assignment_id === 'string' ? receipt.assignment_id : candidate.id,
    coordinator_session: typeof receipt.parent_session === 'string' ? receipt.parent_session : null,
    execution,
    obligation,
    activity: activity.activity,
    source_paths: source.map(entry => entry.file),
    source_hashes: source.map(entry => entry.digest),
    observed_at,
    coverage: makeCoverage(stale ? 'stale' : partial ? 'partial' : 'complete', runReasons, null, runBytes.value, readTime),
    conditions: [],
  };
}

async function readStepIndex(fact, budget, mark) {
  if (fact.stepIndex) return fact.stepIndex;
  const file = join(fact.packagePath, 'spec-steps.json');
  const result = await readJson(file, SENTINEL_LIMITS.smallJsonBytes, budget, {
    prefix: 'step-index',
    allow: value => {
      if (!value || typeof value !== 'object' || !Array.isArray(value.steps)) return null;
      const steps = [];
      for (const item of value.steps) {
        if (!item || typeof item !== 'object' || !Number.isInteger(item.step)) continue;
        steps.push({ step: item.step, name: typeof item.name === 'string' ? item.name : null });
      }
      return steps.sort((a, b) => a.step - b.step);
    },
  });
  if (result.outcome === 'read-budget') { mark(result.reason); fact.stepIndex = { steps: [], source: null, digest: null }; return fact.stepIndex; }
  if (result.outcome === 'missing') {
    // A package without a prepared step index is a legitimate absence.
    fact.stepIndex = { steps: [], source: null, digest: null };
    return fact.stepIndex;
  }
  if (result.outcome === 'ok') {
    fact.sources.set('step-index', { file, digest: result.digest });
    fact.stepIndex = { steps: result.record, source: file, digest: result.digest };
  } else if (result.outcome === 'oversized' || result.outcome === 'invalid') {
    // A missing step index is not a defect; an unreadable or oversized one is.
    mark(`step-index-invalid: ${fact.packagePath}`);
    fact.stepIndex = { steps: [], source: null, digest: null };
  } else {
    fact.stepIndex = { steps: [], source: null, digest: null };
  }
  return fact.stepIndex;
}

async function readActivity(fact, id, budget, mark) {
  const dir = join(fact.packagePath, 'runtime', 'runs', `${id}-activity`);
  const listed = await listDirectory(dir, ROLES.length, entry => entry.isFile() && entry.name.endsWith('.json'));
  if (listed.entries === null) return { activity: null, observed: null, sources: [] };
  const present = new Set(listed.entries.map(entry => entry.name.slice(0, -'.json'.length)));
  const segments = [];
  const sources = [];
  let observed = null;
  let readable = false;
  for (const role of ROLES) {
    const file = join(dir, `${role}.json`);
    if (!present.has(role)) {
      // An absent role snapshot is normal until that role starts; it is not a
      // coverage defect. Activity stays unknown only if no role was readable.
      continue;
    }
    const result = await readJson(file, SENTINEL_LIMITS.activityBytes, budget, {
      prefix: 'activity', oversize: false,
      // Role snapshots are identity plus public progress hints only.
      allow: value => value && typeof value === 'object' && (typeof value.run_id === 'undefined' || typeof value.run_id === 'string')
        ? { run_id: typeof value.run_id === 'string' ? value.run_id : null,
            hint: typeof value.hint === 'string' ? value.hint : null,
            activity: typeof value.activity === 'string' ? value.activity : null,
            phase: typeof value.phase === 'string' ? value.phase : null,
            last_activity: typeof value.last_activity === 'string' || typeof value.last_activity === 'number' ? value.last_activity : null }
        : null,
    });
    if (result.outcome === 'read-budget') { mark(result.reason); break; }
    if (result.outcome === 'oversized') { mark(`activity-oversized: ${role}`); continue; }
    if (result.outcome !== 'ok') { mark(`activity-invalid: ${role}`); continue; }
    const snapshot = result.record;
    // A replaced or foreign snapshot is a stale fact for this role only.
    if (snapshot.run_id && snapshot.run_id !== id) { mark(`activity-mismatch: ${role}`, 'stale'); continue; }
    readable = true;
    sources.push({ file, digest: result.digest });
    const hint = publicHint(snapshot.hint || snapshot.activity || snapshot.phase);
    segments.push(`${role}: ${hint}`);
    const last = validTime(typeof snapshot.last_activity === 'string' ? snapshot.last_activity : null)
      ?? (Number.isFinite(snapshot.last_activity) ? new Date(snapshot.last_activity).toISOString() : null);
    if (last && (!observed || Date.parse(last) > Date.parse(observed))) observed = last;
  }
  return { activity: readable && segments.length ? segments.join(' · ') : null, observed, sources };
}

async function readLease(fact, receipt, id, budget, mark) {
  if (typeof receipt.lock !== 'string') {
    // No recorded reservation: unknown, not a defect.
    return { sources: [] };
  }
  const lock = resolve(receipt.lock);
  const realLock = await realpath(lock).catch(() => null);
  if (!realLock) {
    // The reservation location is recorded but gone: report what the recorded
    // spelling establishes, without inventing where it might be.
    mark(insideDir(fact.common, lock) ? 'lease-missing' : 'lease-outside-repository');
    return { sources: [] };
  }
  if (!insideDir(fact.common, realLock)) {
    mark('lease-outside-repository');
    return { sources: [] };
  }
  const file = join(realLock, 'lease.json');
  const result = await readJson(file, SENTINEL_LIMITS.smallJsonBytes, budget, {
    prefix: 'lease', oversize: false,
    // Lease identity and revocation only. The token and any pid are never
    // retained, hashed or rendered.
    allow: value => value && typeof value === 'object'
      ? { id: typeof value.id === 'string' ? value.id : null, revoked: value.revoked === true } : null,
  });
  if (result.outcome === 'read-budget') { mark(result.reason); return { sources: [] }; }
  if (result.outcome !== 'ok') { mark('lease-missing'); return { sources: [] }; }
  const sources = [{ file, digest: result.digest }];
  if (result.record.id !== id) mark('lease-mismatch');
  else if (result.record.revoked) mark('lease-revoked');
  return { sources };
}

async function readCheckpoints(fact, budget, mark) {
  if (fact.checkpoints) return fact.checkpoints;
  fact.checkpoints = [];
  const dir = join(fact.packagePath, 'runtime', 'sentinel');
  const listed = await listDirectory(dir, SENTINEL_LIMITS.receiptFiles, entry => entry.isDirectory());
  if (listed.entries === null) return fact.checkpoints;
  for (const entry of listed.entries) {
    const file = join(dir, entry.name, 'checkpoint.json');
    const result = await readJson(file, SENTINEL_LIMITS.smallJsonBytes, budget, {
      prefix: 'checkpoint',
      // Checkpoint observation is package, obligation summary and worker IDs.
      allow: value => {
        if (!value || typeof value !== 'object' || typeof value.package !== 'string') return null;
        return {
          package: value.package,
          summary: value.obligation && typeof value.obligation === 'object' && typeof value.obligation.summary === 'string' ? value.obligation.summary : null,
          workers: Array.isArray(value.workers) ? value.workers.filter(item => item && typeof item.id === 'string').map(item => item.id) : [],
        };
      },
    });
    if (result.outcome === 'read-budget') { mark(result.reason); break; }
    if (result.outcome !== 'ok') {
      // Incident and action files are never read; an unreadable or oversized
      // checkpoint is reported and ignored.
      mark(`checkpoint-invalid: ${entry.name}`);
      continue;
    }
    fact.sources.set(`checkpoint:${entry.name}`, { file, digest: result.digest });
    fact.checkpoints.push({ workflow: entry.name, ...result.record });
  }
  return fact.checkpoints;
}
