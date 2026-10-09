// Read-only bounded workspace facts for the spec sentinel.
//
// Every read here is observational: regular files, allowlisted fields, explicit
// byte caps and one shared total budget. Nothing in this module writes, launches,
// controls or models anything by default. An explicit lifecycle callback belongs
// to the active reader; cold collection never supplies it. No transcript, metric or raw failure log is
// read. Observation is never acceptance (INV-2).

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, opendir, lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { applicableMerge, validateMergeCache } from './merge-reconciliation.mjs';
import { publicHint } from '../../pi/extensions/spec-runtime/monitor.mjs';
import { discoverManaged } from './core.mjs';

export const SENTINEL_LIMITS = Object.freeze({
  roots: 20,
  assignments: 50,
  packageChildren: 100,
  receiptFiles: 100,
  receiptDirectoryEntries: 5000,
  indexEntries: 1000,
  incidentEntries: 20,
  actionFiles: 64,
  directoryEntryFactor: 4,
  smallJsonBytes: 65536,
  activityBytes: 32768,
  totalBytes: 4 * 1024 * 1024,
  quietActivityMs: 120000,
  recentActivityMs: 24 * 60 * 60 * 1000,
  recentCompletionMs: 7 * 24 * 60 * 60 * 1000,
  completedPackages: 50,
  activityEntries: 10000,
});

const RECEIPT_KEYS = ['id', 'assignment_id', 'package', 'step', 'checkout', 'parent_session', 'owner_session', 'editor_session',
  'owner_model', 'editor_model', 'state', 'started_at', 'finished_at', 'dispatch_requested_at', 'lock'];
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const ROLES = ['owner', 'editor'];
const CONDITION_GENERATION = 1;
const MAX_REASONS = 50;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
// A finite epoch value can still sit outside the representable Date range;
// formatting must validate the parsed time, not only the input type.
const isoOf = value => { const time = new Date(value).getTime(); return Number.isFinite(time) ? new Date(time).toISOString() : null; };
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

// Resolve ordinary Git checkout/worktree metadata directly. Observation must
// not depend on spawning Git: a host spawn failure used to discard every repo.
// No source, config commands or hooks are executed. Unsupported/unreadable layouts
// remain unknown, and a worktree's .git file still resolves to its primary common
// directory so copied .specs packages cannot masquerade as canonical packages.
async function gitCommonDir(checkout, budget) {
  try {
    const marker = join(checkout, '.git');
    const info = await lstat(marker);
    let gitdir;
    if (info.isDirectory()) gitdir = await realpath(marker);
    else if (info.isFile()) {
      const pointer = await readBounded(marker, 8192, budget);
      const match = pointer.outcome === 'ok' && /^gitdir: (.+)\r?\n?$/.exec(pointer.text);
      if (!match) return null;
      gitdir = await realpath(resolve(checkout, match[1].trim()));
    } else return null;
    const head = await readBounded(join(gitdir, 'HEAD'), 8192, budget);
    if (head.outcome !== 'ok' || !/^(?:ref: refs\/[^\s]+|[a-f0-9]{40,64})\s*$/.test(head.text)) return null;
    const common = await readBounded(join(gitdir, 'commondir'), 8192, budget);
    if (!['ok', 'missing'].includes(common.outcome)) return null;
    const directory = common.outcome === 'ok'
      ? await realpath(resolve(gitdir, common.text.trim())) : gitdir;
    if (!(await stat(join(directory, 'objects'))).isDirectory()
      || !(await stat(join(directory, 'refs'))).isDirectory()) return null;
    return directory;
  } catch { return null; }
}

// Additive identity helper: one hash formula for workspace directories and
// condition identities. Scope separation keeps routed workspaces distinct.
export function workspaceKey({ agentDir, scope = null }) {
  return sha256(JSON.stringify([resolve(agentDir), scope ?? null]));
}

// Enrollment read failures become explicit workspace coverage reasons in
// every entrypoint; unreadable enrollment is an unknown omission, never a
// healthy empty workspace.
export function enrollmentReasons(errors) {
  const reasons = [];
  for (const error of Array.isArray(errors) ? errors : []) {
    if (!error?.path) continue;
    const code = typeof error.code === 'string' ? error.code : 'UNKNOWN';
    const kind = code === 'ENROLLMENT_INVALID' || code === 'ENROLLMENT_OVERSIZED' ? 'enrollment-invalid'
      : code === 'ENROLLMENT_CAP' ? 'enrollment-cap' : 'enrollment-unavailable';
    const reason = `${kind}: ${error.path} (${code})`;
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return reasons;
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
  if (listed.code) errors.push({ path: directory, code: listed.code });
  if (listed.truncated) errors.push({ path: directory, code: 'ENROLLMENT_CAP' });
  for (const entry of listed.entries) {
    const file = join(directory, entry.name);
    const result = await readJson(file, SENTINEL_LIMITS.smallJsonBytes, budget, {
      prefix: 'enrollment', oversize: false, within: directory,
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
  if (typeof value === 'number') { const iso = isoOf(value); if (iso) return iso; }
  return validTime(typeof value === 'string' ? value : null) ?? new Date().toISOString();
}

function makeCoverage(state, reasons, omitted, bytes_read, observed_at) {
  return { state, reasons: reasons.slice(0, MAX_REASONS), omitted, bytes_read, observed_at };
}

// Reads are bounded twice: per file cap and one shared workspace byte budget.
// A skipped read is a reported fact, never a guessed one.
function makeBudget() {
  return { bytes: 0, cap: SENTINEL_LIMITS.totalBytes };
}

// Sources are opened only as in-containment regular files: a special file or
// a foreign symlink is an explicit uncertainty, never an open or a follow.
const OPEN_REGULAR = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

async function readBounded(file, maxBytes, budget, { within = null } = {}) {
  // The budget is checked before the read and enforced again on the actual
  // bytes so coverage.bytes_read can never exceed the workspace total.
  if (budget.bytes + maxBytes > budget.cap) {
    return { outcome: 'read-budget', reason: `read-budget: ${file}`, bytes: 0 };
  }
  try {
    const real = await realpath(file);
    if (within && !insideDir(await realpath(within), real)) {
      return { outcome: 'invalid', reason: `source-outside: ${file}`, bytes: 0 };
    }
    if (!(await lstat(file)).isFile()) {
      return { outcome: 'invalid', reason: `source-not-regular: ${file}`, bytes: 0 };
    }
  } catch (error) {
    // A vanished file is a missing fact, not corrupt evidence.
    return { outcome: codeOf(error) === 'ENOENT' ? 'missing' : 'invalid', reason: `${codeOf(error)}: ${file}`, bytes: 0 };
  }
  let handle;
  try {
    handle = await open(file, OPEN_REGULAR);
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (budget.bytes + bytesRead > budget.cap) {
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
async function readJson(file, maxBytes, budget, { prefix = 'read-error', oversize = true, allow, within = null } = {}) {
  const result = await readBounded(file, maxBytes, budget, { within });
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

// Every directory walk is bounded by examined entries, not only matching
// candidates: retained non-matching names can neither stall the reader nor
// inflate the snapshot, and an examination ceiling that prevents proving
// completeness is reported as truncation.
async function listDirectory(dir, limit, matcher = () => true, examine = limit * SENTINEL_LIMITS.directoryEntryFactor) {
  let handle;
  try { handle = await opendir(dir); }
  catch (error) { return { entries: null, truncated: false, code: codeOf(error) }; }
  const entries = [];
  let truncated = false;
  let examined = 0;
  try {
    while (examined < examine) {
      const entry = await handle.read();
      if (!entry) break;
      examined++;
      if (!matcher(entry)) continue;
      if (entries.length < limit) entries.push(entry);
      else { truncated = true; break; }
    }
    if (!truncated && examined >= examine && await handle.read()) {
      // The examination ceiling prevents proving completeness.
      truncated = true;
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

// Position in the prepared index is not accepted completion. Worker exit and
// later step assignment do not establish how many earlier steps were accepted.
function specProgress(receiptStep, index) {
  const match = /(?:^|[/\\])step-(\d+)-subspec\.md$/.exec(receiptStep ?? '');
  const number = match ? Number(match[1]) : null;
  const position = index.steps.findIndex(item => item.step === number);
  return {
    basis: 'step-position',
    total_steps: index.source ? index.steps.length : null,
    current_step: number,
    current_position: position < 0 ? null : position + 1,
    current_name: position < 0 ? null : publicHint(index.steps[position].name),
    accepted_steps: null,
  };
}

function obligationForStep(progress) {
  if (progress.current_step === null) return null;
  const label = progress.current_position === null
    ? `step ${progress.current_step} (spec position unknown)`
    : `step ${progress.current_position} of ${progress.total_steps}`;
  return `${label}${progress.current_name ? `: ${progress.current_name}` : ''}`;
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
    if (has('activity-oversized') || has('activity-invalid') || has('activity-unavailable') || has('activity-cap')) add('activity-unreadable', 'attention', 'unknown');
    else if (has('activity-mismatch')) add('activity-mismatch', 'attention', 'unknown');
    else add('activity-unknown', 'info', 'unknown');
  }
  for (const incident of run.incidents ?? []) {
    if (!['open', 'resolved', 'unknown'].includes(incident.state)) continue;
    conditions.push({
      id: sha256(JSON.stringify([run.package, run.assignment_id, incident.id, incident.generation, CONDITION_GENERATION])).slice(0, 32),
      kind: 'repeated-verification-failure', severity: incident.state === 'resolved' ? 'info' : 'attention',
      state: incident.state, incident_id: incident.id, generation: incident.generation, fact_ids,
    });
  }
  for (const action of run.actions ?? []) if (action.state === 'unknown') conditions.push({
    id: sha256(JSON.stringify([run.package, action.id, 'action-outcome-unknown'])).slice(0, 32),
    kind: 'action-outcome-unknown', severity: 'attention', state: 'unknown', action_id: action.id, current: action.current === true, fact_ids,
  });
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
    for (const worker of run.workflow_workers ?? [])
      lines.push(renderDetail('    ', `Recorded worker: ${worker.kind} ${worker.id} · ${worker.state} · checkpoint ${run.workflow_observed_at ?? 'unknown'}`));
    if (run.coverage.state !== 'complete' || run.coverage.reasons.length) {
      lines.push(renderDetail('    ', `coverage ${run.coverage.state} (${run.coverage.reasons.join(', ')})`));
    }
    if (run.actions?.length) {
      lines.push(renderDetail('    ', `actions: ${run.actions.map(action => `${action.kind} [${action.state}]`).join(' · ')}`));
    }
    if (run.conditions?.length) {
      lines.push(renderDetail('    ', run.conditions.map(condition => `${condition.kind} [${condition.severity}/${condition.state}]`).join(' · ')));
    }
  }
  if (!runs.length) lines.push(['unavailable', 'stale'].includes(coverage.state)
    ? '  Workspace observation unavailable; running work is unknown.' : '  No observed runs.');
  if (snapshot.activity_filter?.window_ms) lines.push(`Activity window: last 24 hours · ${snapshot.activity_filter.hidden_packages} inactive package(s), ${snapshot.activity_filter.hidden_completed_packages ?? 0} completed package(s) hidden; status --all includes history.`);
  if (snapshot.discovery?.root) lines.push(renderLine(`Repository discovery: ${snapshot.discovery.root} (nested repositories included)`));
  if (coverage.reasons.length) lines.push(renderLine(`Coverage notes: ${coverage.reasons.join(', ')}`));
  return lines;
}

// Directory mtimes do not advance when an existing descendant is edited. Check
// bounded metadata recursively, never follow symlinks or read file contents.
// Uncertain scans stay visible instead of being classified as inactive.
async function packageRecentlyModified(directory, cutoff, scan) {
  const pending = [directory];
  while (pending.length) {
    if (++scan.entries > SENTINEL_LIMITS.activityEntries) return null;
    const current = pending.pop();
    let info;
    try { info = await lstat(current); } catch { return null; }
    if (info.isSymbolicLink()) continue;
    if (info.mtimeMs >= cutoff) return true;
    if (!info.isDirectory()) continue;
    let handle;
    try {
      handle = await opendir(current);
      for await (const entry of handle) {
        if (scan.entries + pending.length >= SENTINEL_LIMITS.activityEntries) return null;
        if (!entry.isSymbolicLink()) pending.push(join(current, entry.name));
      }
    } catch { return null; }
  }
  return false;
}

export async function collectWorkspace({ roots = [], packages = [], enrollmentErrors = [], discovery = null, indexDir = join(homedir(), '.pi/agent/spec-runtime'),
  now = Date.now, agentDir, scope, includeInactive = false, reconcileMerge = null } = {}) {
  const tick = clock(now);
  const readTime = clockIso(tick);
  const budget = makeBudget();
  const reasons = [];
  let knownOmitted = 0;
  let unknownOmission = false;
  const workspace = workspaceKey({ agentDir: agentDir ?? dirname(resolve(indexDir)), scope: scope ?? process.env.PI_INTERCOM_SCOPE_ID ?? null });
  for (const reason of enrollmentReasons(enrollmentErrors)) {
    reasons.push(reason);
    unknownOmission = true;
  }
  for (const reason of discovery?.reasons ?? []) { reasons.push(reason); unknownOmission = true; }

  // Discovered candidates and optional explicit roots share canonical validation.
  const enrolled = sortPaths(Array.isArray(roots) ? roots.filter(value => typeof value === 'string') : []);
  if (enrolled.length > SENTINEL_LIMITS.roots) {
    reasons.push(`roots-cap: selected ${SENTINEL_LIMITS.roots} of ${enrolled.length}`);
    knownOmitted += enrolled.length - SENTINEL_LIMITS.roots;
  }

  // Cache asynchronous Git metadata identity only for this read. Sibling packages
  // and duplicate index entries share bounded reads without hiding changes later.
  const identities = new Map();
  const canonicalPackage = async path => {
    const target = await realpath(path);
    const packagePath = (await stat(target)).isFile() && basename(target) === 'spec.md' ? dirname(target) : target;
    if (!(await stat(packagePath)).isDirectory()) throw new Error('package must be a feature directory or its spec.md');
    const specs = dirname(packagePath);
    if (basename(specs) !== '.specs') throw new Error('package must be a direct child of the primary checkout .specs directory');
    const primary = await realpath(dirname(specs));
    if (!identities.has(primary)) {
      const found = await gitCommonDir(primary, budget);
      identities.set(primary, found ? await realpath(found).catch(() => null) : null);
    }
    const common = identities.get(primary);
    if (common !== join(primary, '.git')) throw new Error('package must belong to the primary checkout, not a linked worktree; Git identity may be unavailable');
    return { packagePath, primary, common };
  };

  const facts = new Map();
  const addPackage = canonical => {
    let fact = facts.get(canonical.packagePath);
    if (!fact) {
      fact = { ...canonical, sources: new Map(), checkpoints: null, stepIndex: null, stepIndexNotes: [], checkpointNotes: [], checkouts: new Map() };
      facts.set(canonical.packagePath, fact);
    }
    return fact;
  };

  for (const requested of Array.isArray(packages) ? packages : []) {
    if (typeof requested !== 'string') continue;
    try { addPackage(await canonicalPackage(requested)); }
    catch (error) { reasons.push(`package-noncanonical: ${resolve(requested)} (${messageOf(error)})`); }
  }

  // Managed index pointers are discovery hints only: reading one never enrolls
  // a repository, and a pointer without its receipt stays an observed absence.
  let managed = { runs: [], discovery_errors: [], candidates_truncated: false, runs_truncated: false };
  try { managed = await discoverManaged(indexDir, { limit: SENTINEL_LIMITS.indexEntries, budget }); }
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
    try { addPackage(await canonicalPackage(pointer.package)); }
    catch (error) {
      reasons.push(`index-entry-invalid: ${pointer.run_id} (${messageOf(error)})`);
    }
  }

  // Observe indexed/current packages first; discovery supplements that fast path.
  for (const root of enrolled.slice(0, SENTINEL_LIMITS.roots)) {
    const specs = join(root, '.specs');
    const listed = await listDirectory(specs, SENTINEL_LIMITS.packageChildren, entry => entry.isDirectory());
    if (listed.entries === null) {
      // Missing .specs is reported, never guessed around.
      reasons.push(`root-unavailable: ${specs} (${listed.code})`);
      continue;
    }
    if (listed.code) {
      // A failed enumeration with partial entries cannot prove completeness.
      reasons.push(`root-unavailable: ${specs} (${listed.code})`);
      unknownOmission = true;
    }
    if (listed.truncated) {
      reasons.push(`package-cap: ${specs}`);
      unknownOmission = true;
    }
    for (const entry of listed.entries) {
      const child = join(specs, entry.name);
      try { addPackage(await canonicalPackage(child)); }
      catch (error) {
        // A throw (including linked-worktree rejection) is a fact, never a package.
        reasons.push(`package-noncanonical: ${child} (${messageOf(error)})`);
      }
    }
  }

  const activityFilter = {
    window_ms: includeInactive ? null : SENTINEL_LIMITS.recentActivityMs,
    cutoff: includeInactive ? null : new Date(Date.parse(readTime) - SENTINEL_LIMITS.recentActivityMs).toISOString(),
    hidden_packages: 0,
    hidden_completed_packages: 0,
  };
  const scan = { entries: 0 };
  const collected = [];
  const completed = [];
  const inactive = [];
  const completionCutoff = Date.parse(readTime) - SENTINEL_LIMITS.recentCompletionMs;
  let staleReceipts = false;
  const note = reason => { if (reason && !reasons.includes(reason)) reasons.push(reason); };
  const noteUnknown = reason => { if (reason && !reasons.includes(reason)) { reasons.push(reason); unknownOmission = true; } };
  const collectFact = async (fact, active = true) => {
    const candidates = await collectPackage(fact, budget, note, noteUnknown);
    // Keep the latest assignment as the package's current handoff, including
    // the interval after its worker exits and before review/next-step dispatch.
    fact.currentAssignment = [...candidates].sort((a, b) =>
      (Date.parse(b.receipt.started_at ?? b.receipt.dispatch_requested_at) || 0)
      - (Date.parse(a.receipt.started_at ?? a.receipt.dispatch_requested_at) || 0)
      || compareCandidates(a, b))[0]?.id ?? null;
    fact.candidates = candidates;
    let completion = await packageCompletion(fact, candidates, budget, noteUnknown);
    const mergeInput = await packageMergeInput(fact, candidates, budget);
    if (mergeInput) {
      let evidence;
      if (reconcileMerge) { try { evidence = await reconcileMerge(mergeInput); } catch { evidence = { state: 'unknown', reason: 'merge-check-unavailable' }; } }
      else {
        const read = await readJson(join(fact.packagePath, 'sentinel-merge.json'), SENTINEL_LIMITS.smallJsonBytes, budget, { within: fact.packagePath, allow: value => value });
        evidence = read.record;
        if (!await validateMergeCache(evidence, mergeInput)) evidence = null;
      }
      fact.merge = evidence ? { state: evidence.state, checked_at: evidence.checked_at, reason: evidence.reason, url: evidence.url, merged_at: evidence.merged_at, head: evidence.head, merge_commit: evidence.merge_commit } : { state: 'unknown', reason: 'merge-evidence-unavailable' };
      if (applicableMerge(evidence, mergeInput)) completion = { completed_at: evidence.merged_at, completion_basis: 'merged-pr', merge: fact.merge };
    }
    if (completion && Date.parse(completion.completed_at) <= Date.parse(readTime)) {
      if (Date.parse(completion.completed_at) >= completionCutoff) completed.push({ fact, completion });
      if (!includeInactive) {
        activityFilter.hidden_completed_packages++;
        return;
      }
    }
    if (active) collected.push(...candidates);
    if (fact.staleReceipts) staleReceipts = true;
  };
  for (const fact of facts.values()) {
    if (!includeInactive) {
      const recent = await packageRecentlyModified(fact.packagePath, Date.parse(activityFilter.cutoff), scan);
      if (recent === false) { activityFilter.hidden_packages++; inactive.push(fact); continue; }
      if (recent === null) noteUnknown(`activity-filter-unknown: ${fact.packagePath}`);
    }
    await collectFact(fact);
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

  // History spends only the remaining shared read budget. Old package mtimes
  // cannot stand in for completion timestamps; inspect their completion evidence.
  for (const fact of inactive) await collectFact(fact, false);
  completed.sort((a, b) => Date.parse(b.completion.completed_at) - Date.parse(a.completion.completed_at)
    || a.fact.packagePath.localeCompare(b.fact.packagePath));
  const recentlyCompleted = [];
  for (const { fact, completion } of completed.slice(0, SENTINEL_LIMITS.completedPackages)) {
    const candidate = fact.candidates.find(item => item.id === fact.currentAssignment);
    const run = candidate ? await observeRun(candidate, budget, mark, readTime)
      : { repository: fact.common, package: fact.packagePath, source_paths: [...fact.sources.values()].map(source => source.file) };
    recentlyCompleted.push({ ...run, ...completion, workflow_state: 'complete', is_current_assignment: false });
  }

  const packageRequested = enrolled.length > 0 || (Array.isArray(packages) && packages.length > 0);
  let state;
  if (!packageRequested && !facts.size && !reasons.length) {
    state = 'complete';
    if (!reasons.length) reasons.push(discovery ? 'no repositories with spec packages discovered' : 'no enrolled roots');
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
  return reduceConditions({ version: 1, workspace, coverage, activity_filter: activityFilter, runs,
    recently_completed: recentlyCompleted,
    completion_history: { window_ms: SENTINEL_LIMITS.recentCompletionMs, cutoff: new Date(completionCutoff).toISOString(),
      limit: SENTINEL_LIMITS.completedPackages, omitted: Math.max(0, completed.length - recentlyCompleted.length) },
    spec_roots: [...new Set([...facts.values()].map(f => dirname(f.packagePath)))], ...(discovery ? { discovery } : {}) });
}


// A scoped PR record permits lifecycle lookup even when planning and receipts
// lag publication. Scoped remote or fetched Git merge proof can supersede older work records.
async function packageMergeInput(fact, candidates, budget) {
  const skip = reason => { fact.merge = { state: 'unknown', reason }; return null; };
  if (fact.staleReceipts) return skip('stale-receipts');
  if (fact.receiptsIncomplete) return skip('incomplete-receipts');
  const checkpoints = await readCheckpoints(fact, budget);
  if (fact.checkpointNotes.some(reason => /^checkpoints?-/.test(reason))) return skip('checkpoint-unavailable');
  if (checkpoints.some(c => !validTime(c.observed_at))) return skip('checkpoint-time-unavailable');
  const prRead = await readJson(join(fact.packagePath, 'pr-url.json'), SENTINEL_LIMITS.smallJsonBytes, budget,
    { within: fact.packagePath, allow: value => value });
  if (prRead.outcome !== 'ok') return skip(prRead.outcome === 'missing' ? 'missing-pr-record' : 'pr-record-unavailable');
  const pr = prRead.record;
  if (pr?.package !== fact.packagePath || pr.kind !== 'pr_submission'
    || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(pr.url ?? '')) return skip('pr-record-invalid');
  const validRef = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) && !value.includes('..');
  if (pr.branch != null && !validRef(pr.branch) || pr.base != null && !validRef(pr.base)) return skip('pr-ref-invalid');
  if (candidates.some(c => !validTime(c.receipt.started_at ?? c.receipt.dispatch_requested_at))) return skip('dispatch-time-unavailable');
  return { package: fact.packagePath, primary: fact.primary,
    pr: { url: pr.url, branch: pr.branch ?? null, base: pr.base ?? null }, commits: [],
    checkpoints: checkpoints.map(c => [c.state, c.observed_at]),
    receipts: candidates.map(c => [c.id, c.receipt.state, c.receipt.started_at ?? c.receipt.dispatch_requested_at])
      .sort((a, b) => a[0].localeCompare(b[0])) };
}

// A workflow completion checkpoint is decisive; a terminal worker receipt is
// not. Older packages use matching ready-tour and PR publication records. A
// subsequent dispatch or noncomplete checkpoint keeps reopened work visible.
async function packageCompletion(fact, candidates, budget, note) {
  if (fact.staleReceipts || fact.receiptsIncomplete) return false;
  const checkpoints = await readCheckpoints(fact, budget);
  for (const reason of fact.checkpointNotes) note(reason);
  if (fact.checkpointNotes.length) return false;
  const relevant = checkpoints.filter(item => item.package === fact.packagePath);
  let completedAt, completionBasis;
  if (relevant.length) {
    if (relevant.some(item => item.state !== 'complete' || item.active_workers.length || !validTime(item.observed_at))) return false;
    completedAt = Math.max(...relevant.map(item => Date.parse(item.observed_at)));
    completionBasis = 'workflow-checkpoint';
  } else {
    const read = async (name, allow) => {
      const result = await readJson(join(fact.packagePath, name), SENTINEL_LIMITS.smallJsonBytes, budget,
        { within: fact.packagePath, prefix: 'completion', allow });
      if (result.outcome !== 'ok' && result.outcome !== 'missing') note(result.reason ?? `completion-unavailable: ${name}`);
      return result.outcome === 'ok' ? result.record : null;
    };
    const pr = await read('pr-url.json', value => value && typeof value === 'object'
      ? { package: value.package, kind: value.kind, commit: value.commit, submitted_at: value.submitted_at, draft: value.draft, url: value.url } : null);
    if (!pr || pr.package !== fact.packagePath || pr.kind !== 'pr_submission' || pr.draft === true
      || !validTime(pr.submitted_at) || !/^https:\/\//.test(pr.url ?? '') || !/^[a-f0-9]{40,64}$/.test(pr.commit ?? '')) return false;
    const tour = await read('work-tour.json', value => value && typeof value === 'object'
      ? { verdict: value.verdict, commit: value.commit } : null);
    if (tour?.verdict !== 'ready' || tour.commit !== pr.commit) return false;
    completedAt = Date.parse(pr.submitted_at);
    completionBasis = 'ready-pr';
  }
  if (fact.staleReceipts || candidates.some(({ receipt }) => {
    const started = Date.parse(receipt.started_at ?? receipt.dispatch_requested_at);
    return !TERMINAL.has(receipt.state) || !Number.isFinite(started) || started > completedAt;
  })) return false;
  return { completed_at: new Date(completedAt).toISOString(), completion_basis: completionBasis };
}

// Receipts are examined in one bounded pass: identity mismatches are stale
// evidence and the run is skipped, never re-attributed to another identity.
async function collectPackage(fact, budget, report, reportUnknown) {
  const note = reason => { fact.receiptsIncomplete = true; report(reason); };
  const noteUnknown = reason => { fact.receiptsIncomplete = true; reportUnknown(reason); };
  const runsDir = join(fact.packagePath, 'runtime', 'runs');
  const found = new Map();
  const readReceipt = async (file, expectedId = null) => {
    const result = await readJson(file, SENTINEL_LIMITS.smallJsonBytes, budget, {
      prefix: 'receipt', oversize: false, within: fact.packagePath,
      // Only these receipt fields are observable; result, error, token and
      // usage/cost never enter the snapshot.
      allow: value => value && typeof value === 'object' && typeof value.id === 'string' ? value : null,
    });
    if (result.outcome === 'read-budget') { noteUnknown(result.reason); return false; }
    if (result.outcome === 'missing') {
      if (expectedId !== null) note(`receipt-missing: ${file}`);
      return true;
    }
    if (result.outcome === 'oversized') { note(`receipt-oversized: ${file}`); return true; }
    if (result.outcome !== 'ok') { note(`receipt-invalid: ${file}`); return true; }
    const value = result.record;
    if ((expectedId !== null && value.id !== expectedId)
      || (typeof value.package === 'string' && !(await samePath(value.package, fact.packagePath)))) {
      note(`receipt-mismatch: ${file}`);
      fact.staleReceipts = true;
      return true;
    }
    const receipt = {};
    for (const key of RECEIPT_KEYS) if (typeof value[key] === 'string') receipt[key] = value[key];
    if (['implementation', 'verification-continuation', 'implementation-repair', 'review-repair', 'launch-retry'].includes(value.attempt_kind)) receipt.attempt_kind = value.attempt_kind;
    if (['as-specified', 'adapted', 'checkpoint', 'no-artifact', 'decision-required', 'needs-spec-correction'].includes(value.handoff?.outcome)) receipt.handoff = { outcome: value.handoff.outcome };
    if (!found.has(value.id)) found.set(value.id, { fact, id: value.id, receipt, source: [{ file, digest: result.digest }], bytes: result.bytes });
    return true;
  };

  // The current receipt has a stable path. Read it directly so logs and result
  // files cannot push the latest run beyond the bounded directory scan.
  if (!await readReceipt(join(fact.packagePath, 'runtime', 'run.json'))) return [...found.values()];
  const listed = await listDirectory(runsDir, SENTINEL_LIMITS.receiptFiles,
    entry => entry.isFile() && entry.name.endsWith('.json')
      && !entry.name.endsWith('-verification.json') && !entry.name.endsWith('-completion.json'),
    SENTINEL_LIMITS.receiptDirectoryEntries);
  if (listed.entries === null) {
    // A package without a runs directory has no receipts to observe.
    if (listed.code !== 'ENOENT') noteUnknown(`receipts-unavailable: ${runsDir} (${listed.code})`);
    return [...found.values()];
  }
  if (listed.code) noteUnknown(`receipts-unavailable: ${runsDir} (${listed.code})`);
  if (listed.truncated) noteUnknown(`receipts-cap: ${fact.packagePath}`);
  for (const entry of listed.entries) {
    const file = join(runsDir, entry.name);
    const id = entry.name.slice(0, -'.json'.length);
    if (!await readReceipt(file, id)) break;
  }
  return [...found.values()];
}

async function observeRun(candidate, budget, note, readTime) {
  const fact = candidate.fact;
  const receipt = candidate.receipt ?? {};
  const runReasons = [];
  const runBytes = { value: candidate.bytes ?? 0 };
  // Package-level reads are shared; this wrapper attributes them to the first
  // selected run that uses them so each run reports its own bytes_read.
  const runBudget = {
    get cap() { return budget.cap; },
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

  const steps = await readStepIndex(fact, runBudget);
  // Shared package diagnostics reach every affected run, not only the first
  // reader that populated the cache.
  for (const reason of fact.stepIndexNotes) mark(reason);
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

  const checkpoints = await readCheckpoints(fact, runBudget);
  for (const reason of fact.checkpointNotes) mark(reason);
  let workflow_id = null;
  let workflow_state = null;
  let workflow_workers = [], workflow_observed_at = null, obligation_revision = null;
  const spec_progress = specProgress(receipt.step, steps);
  let obligation = obligationForStep(spec_progress);
  for (const checkpoint of checkpoints) {
    if (checkpoint.package !== fact.packagePath) continue;
    if (!checkpoint.workers.includes(candidate.id) && !(receipt.assignment_id && checkpoint.workers.includes(receipt.assignment_id))) continue;
    workflow_id = checkpoint.workflow;
    workflow_state = typeof checkpoint.state === 'string' ? checkpoint.state : null;
    workflow_workers = checkpoint.active_workers ?? [];
    workflow_observed_at = checkpoint.observed_at;
    obligation_revision = checkpoint.obligation_revision;
    obligation = checkpoint.summary ? publicHint(checkpoint.summary) : obligation;
    const entry = fact.sources.get(`checkpoint:${checkpoint.workflow}`);
    if (entry) source.push({ file: entry.file, digest: entry.digest });
    break;
  }

  const assignment = receipt.assignment_id ?? candidate.id;
  const incidents = fact.incidents.filter(item => item.assignment_id === assignment);
  const actions = fact.actions.filter(item => item.workflow_id === workflow_id).map(item => ({...item, current: obligation_revision != null && item.subject_hash === digestOf(obligation_revision) || incidents.some(i=>digestOf(i.id) === item.subject_hash)}));
  for (const item of [...incidents, ...actions]) source.push(item.source);

  const observed_at = activity.observed ?? validTime(receipt.started_at ?? null) ?? readTime;
  // The recorded checkout is a claim, not an identity: validate its Git common
  // directory read-only against the package repository before asserting it.
  let checkout = null;
  if (typeof receipt.checkout === 'string') {
    const key = resolve(receipt.checkout);
    if (!fact.checkouts.has(key)) {
      const real = await realpath(key).catch(() => null);
      const commonDir = real ? await gitCommonDir(real, runBudget) : null;
      fact.checkouts.set(key, real && commonDir && await realpath(commonDir).catch(() => null) === fact.common
        ? { ok: true, path: real }
        : { ok: false, reason: real && commonDir ? `checkout-foreign: ${key}` : `checkout-unavailable: ${key}` });
    }
    const validated = fact.checkouts.get(key);
    if (validated.ok) checkout = validated.path;
    else mark(validated.reason, validated.reason.startsWith('checkout-foreign') ? 'stale' : undefined);
  }
  return {
    repository: fact.common,
    package: fact.packagePath,
    checkout,
    workflow_id,
    workflow_state,
    workflow_workers,
    workflow_observed_at,
    merge: fact.merge ?? { state: 'unknown' },
    is_current_assignment: fact.currentAssignment === candidate.id,
    assignment_id: typeof receipt.assignment_id === 'string' ? receipt.assignment_id : candidate.id,
    coordinator_session: typeof receipt.parent_session === 'string' ? receipt.parent_session : null,
    execution,
    obligation,
    spec_progress,
    timing: packageTiming(fact, steps, checkpoints, readTime),
    activity: activity.activity,
    incidents: incidents.map(({ source, ...item }) => item),
    actions: actions.map(({ source, ...item }) => item),
    source_paths: source.map(entry => entry.file),
    source_hashes: source.map(entry => entry.digest),
    observed_at,
    coverage: makeCoverage(stale ? 'stale' : partial ? 'partial' : 'complete', runReasons, null, runBytes.value, readTime),
    conditions: [],
  };
}

// Reuse bounded, identity-checked receipts; never read session transcripts for
// timing. Attempts remain separate so retries and overlapping work stay visible.
function packageTiming(fact, index, checkpoints, observedAt) {
  const attempts = (fact.candidates ?? []).map(({ id, receipt }) => {
    const progress = specProgress(receipt.step, index);
    return { assignment_id: receipt.assignment_id ?? id, step: progress.current_step,
      name: progress.current_name, state: receipt.state ?? 'unknown',
      attempt_kind: ['implementation', 'verification-continuation', 'implementation-repair', 'review-repair', 'launch-retry'].includes(receipt.attempt_kind) ? receipt.attempt_kind : null,
      handoff_outcome: ['as-specified', 'adapted', 'checkpoint', 'no-artifact', 'decision-required', 'needs-spec-correction'].includes(receipt.handoff?.outcome) ? receipt.handoff.outcome : null,
      started_at: validTime(receipt.dispatch_requested_at) ?? validTime(receipt.started_at),
      finished_at: TERMINAL.has(receipt.state) ? validTime(receipt.finished_at) : null };
  }).sort((a, b) => (Date.parse(a.started_at) || 0) - (Date.parse(b.started_at) || 0)
    || a.assignment_id.localeCompare(b.assignment_id));
  const starts = attempts.map(a => a.started_at).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
  const relevant = checkpoints.filter(c => c.package === fact.packagePath);
  const completion = relevant.length && relevant.every(c => c.state === 'complete' && c.observed_at)
    ? relevant.map(c => c.observed_at).sort((a, b) => Date.parse(b) - Date.parse(a))[0] : null;
  const finished = completion && attempts.every(a => TERMINAL.has(a.state) && a.started_at
    && Date.parse(a.started_at) <= Date.parse(completion)) ? completion : null;
  return { basis: 'first-recorded-dispatch', started_at: starts[0] ?? null,
    finished_at: finished, observed_at: observedAt, attempts };
}

async function readStepIndex(fact, budget) {
  if (fact.stepIndex) return fact.stepIndex;
  const file = join(fact.packagePath, 'spec-steps.json');
  const result = await readJson(file, SENTINEL_LIMITS.smallJsonBytes, budget, {
    prefix: 'step-index', within: fact.packagePath,
    allow: value => {
      if (!value || typeof value !== 'object' || !Array.isArray(value.steps)) return null;
      const steps = [];
      for (const item of value.steps) {
        if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.step) || item.step < 1
          || steps.some(existing => existing.step === item.step)) return null;
        steps.push({ step: item.step, name: typeof item.name === 'string' ? item.name : null });
      }
      return steps.sort((a, b) => a.step - b.step);
    },
  });
  if (result.outcome === 'read-budget') { fact.stepIndexNotes.push(result.reason); fact.stepIndex = { steps: [], source: null, digest: null }; return fact.stepIndex; }
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
    fact.stepIndexNotes.push(`step-index-invalid: ${fact.packagePath}`);
    fact.stepIndex = { steps: [], source: null, digest: null };
  } else {
    fact.stepIndex = { steps: [], source: null, digest: null };
  }
  return fact.stepIndex;
}

async function readActivity(fact, id, budget, mark) {
  const dir = join(fact.packagePath, 'runtime', 'runs', `${id}-activity`);
  const listed = await listDirectory(dir, ROLES.length, entry => entry.isFile() && entry.name.endsWith('.json'));
  if (listed.entries === null) {
    // An absent activity directory is ordinary until a role starts; any other
    // failure is an explicit unknown for this run.
    if (listed.code !== 'ENOENT') mark(`activity-unavailable: ${id} (${listed.code})`);
    return { activity: null, observed: null, sources: [] };
  }
  if (listed.code) mark(`activity-unavailable: ${id} (${listed.code})`);
  if (listed.truncated) mark(`activity-cap: ${id}`);
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
      prefix: 'activity', oversize: false, within: fact.packagePath,
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
    let last = validTime(typeof snapshot.last_activity === 'string' ? snapshot.last_activity : null);
    if (last === null && typeof snapshot.last_activity === 'number') {
      // A numeric time outside the representable Date range is invalid source
      // metadata for this role, never a collection abort.
      const iso = isoOf(snapshot.last_activity);
      if (iso) last = iso;
      else { mark(`activity-invalid: ${role}`); continue; }
    }
    readable = true;
    sources.push({ file, digest: result.digest });
    const hint = publicHint(snapshot.hint || snapshot.activity || snapshot.phase);
    segments.push(`${role}: ${hint}`);
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
    prefix: 'lease', oversize: false, within: fact.common,
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

async function readCheckpoints(fact, budget) {
  if (fact.checkpoints) return fact.checkpoints;
  fact.checkpoints = [];
  fact.incidents = [];
  fact.actions = [];
  const dir = join(fact.packagePath, 'runtime', 'sentinel');
  await readIncidentSummary(fact, dir, null, budget);
  const listed = await listDirectory(dir, SENTINEL_LIMITS.receiptFiles, entry => entry.isDirectory());
  if (listed.entries === null) {
    // A package without sentinel checkpoints has none to observe; any other
    // directory failure is an explicit unknown for every affected run.
    if (listed.code !== 'ENOENT') fact.checkpointNotes.push(`checkpoints-unavailable: ${dir} (${listed.code})`);
    return fact.checkpoints;
  }
  if (listed.code) fact.checkpointNotes.push(`checkpoints-unavailable: ${dir} (${listed.code})`);
  if (listed.truncated) fact.checkpointNotes.push(`checkpoints-cap: ${dir}`);
  for (const entry of listed.entries) {
    await readIncidentSummary(fact, join(dir, entry.name), entry.name, budget);
    await readActionSummaries(fact, join(dir, entry.name), entry.name, budget);
    const file = join(dir, entry.name, 'checkpoint.json');
    const result = await readJson(file, SENTINEL_LIMITS.smallJsonBytes, budget, {
      prefix: 'checkpoint', within: fact.packagePath,
      // Checkpoint observation is package, obligation summary and worker IDs.
      allow: value => {
        if (!value || typeof value !== 'object' || typeof value.package !== 'string') return null;
        return {
          package: value.package,
          obligation_revision: typeof value.obligation_revision === 'string' ? value.obligation_revision : null,
          state: value.version === 1 && value.workflow_id === entry.name ? value.state : null,
          observed_at: validTime(value.observed_at),
          summary: value.obligation && typeof value.obligation === 'object' && typeof value.obligation.summary === 'string' ? value.obligation.summary : null,
          workers: Array.isArray(value.workers) ? value.workers.filter(item => item && typeof item.id === 'string').map(item => item.id) : [],
          active_workers: value.version === 1 && value.workflow_id === entry.name && Array.isArray(value.workers)
            ? value.workers.filter(item => item && typeof item.id === 'string' && ['ready', 'working', 'waiting-external', 'decision-required', 'blocked', 'user-held', 'unknown'].includes(item.state))
              .slice(0, 64).map(item => ({ id: publicHint(item.id), kind: ['owner', 'editor', 'reviewer', 'fixer', 'scout'].includes(item.kind) ? item.kind : 'worker', state: item.state })) : [],
        };
      },
    });
    if (result.outcome === 'read-budget') { fact.checkpointNotes.push(result.reason); break; }
    if (result.outcome !== 'ok') {
      // An unreadable or oversized checkpoint is reported and ignored.
      fact.checkpointNotes.push(`checkpoint-invalid: ${entry.name}`);
      continue;
    }
    fact.sources.set(`checkpoint:${entry.name}`, { file, digest: result.digest });
    fact.checkpoints.push({ workflow: entry.name, ...result.record });
  }
  return fact.checkpoints;
}

// Observe retained projections only; never re-evaluate recovery eligibility.
const SUMMARY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SUMMARY_TOKEN = /^[a-z0-9-]{1,100}$/;
async function readIncidentSummary(fact, directory, workflow, budget) {
  const file = join(directory, 'verification-incidents.json');
  const result = await readJson(file, SENTINEL_LIMITS.smallJsonBytes, budget, {
    prefix: 'incidents', within: fact.packagePath,
    allow: value => {
      if (!value || value.version !== 1 || value.package !== fact.packagePath
          || (value.workflow_id ?? null) !== workflow || !value.assignments || typeof value.assignments !== 'object'
          || Array.isArray(value.assignments)) return null;
      const entries = Object.entries(value.assignments);
      if (entries.length > SENTINEL_LIMITS.incidentEntries) return null;
      const summaries = [];
      for (const [assignment, entry] of entries) {
        if (!assignment || !entry || entry.assignment_id !== assignment
            || !['idle', 'counting', 'open', 'resolved'].includes(entry.state)
            || !Number.isSafeInteger(entry.count) || entry.count < 0
            || !Number.isSafeInteger(entry.generation) || entry.generation < 0) return null;
        if (!entry.incident_id) continue;
        if (!/^[a-f0-9]{32}$/.test(entry.incident_id) || entry.generation < 1) return null;
        summaries.push({ id: entry.incident_id, generation: entry.generation, workflow_id: workflow,
          assignment_id: assignment, count: entry.count, state: entry.state, observed_at: validTime(entry.observed_at) });
      }
      return summaries;
    },
  });
  if (result.outcome === 'missing') return;
  if (result.outcome !== 'ok') { fact.checkpointNotes.push(result.reason ?? `incidents-invalid: ${file}`); return; }
  for (const item of result.record) fact.incidents.push({ ...item, source: { file, digest: result.digest } });
}
async function readActionSummaries(fact, directory, workflow, budget) {
  const dir = join(directory, 'intents');
  const listed = await listDirectory(dir, SENTINEL_LIMITS.actionFiles, entry => entry.isFile() && entry.name.endsWith('.json'));
  if (listed.entries === null) {
    if (listed.code !== 'ENOENT') fact.checkpointNotes.push(`actions-unavailable: ${dir} (${listed.code})`);
    return;
  }
  if (listed.code) fact.checkpointNotes.push(`actions-unavailable: ${dir} (${listed.code})`);
  if (listed.truncated) fact.checkpointNotes.push(`actions-cap: ${dir}`);
  for (const entry of listed.entries) {
    const file = join(dir, entry.name);
    const result = await readJson(file, SENTINEL_LIMITS.smallJsonBytes, budget, {
      prefix: 'action', within: fact.packagePath,
      allow: value => value && value.version === 1 && value.package === fact.packagePath
        && value.workflow_id === workflow && SUMMARY_ID.test(value.id) && entry.name === `${value.id}.json`
        && ['continue', 'cancel', 'diagnose'].includes(value.kind)
        && ['accepted', 'requested', 'applied', 'blocked', 'failed', 'unknown'].includes(value.state)
        && typeof value.subject_key === 'string' && value.subject_key.length > 0 && value.subject_key.length <= 160
        && typeof value.reason_code === 'string' && value.reason_code.trim().length > 0
        ? { id: value.id, workflow_id: workflow, kind: value.kind, subject_hash: digestOf(value.subject_key),
            state: value.state, reason_code: SUMMARY_TOKEN.test(value.reason_code) ? value.reason_code : null } : null,
    });
    if (result.outcome !== 'ok') { fact.checkpointNotes.push(result.reason ?? `action-invalid: ${file}`); if (result.outcome === 'read-budget') break; continue; }
    fact.actions.push({ ...result.record, source: { file, digest: result.digest } });
  }
}
