// Read-only epic membership for the spec sentinel (see docs/spec-epics.md).
//
// An epic record names member packages, order and dependencies. Member status
// is derived from package facts at read time and never stored. Nothing here
// writes, follows symlinks, or reads package contents.

import { existsSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';

import { listEpics } from '../spec-location/index.mjs';
import { DESIGN_SLUG } from '../design/schema.mjs';
import { readPreparation, readDecision, readPlanningArtifacts } from './preparation.mjs';

export const EPIC_LIMITS = Object.freeze({ epics: 50, members: 100, recordBytes: 65536 });
export const EPIC_SLUG = /^[a-z][a-z0-9-]{0,31}$/;
const STATES = ['planned', 'active', 'complete', 'abandoned'];
const LANDED = new Set(['merged', 'complete']);
const optionalString = value => value === undefined || typeof value === 'string';

// Validates one record against its directory slug. Returns { epic } with the
// allowlisted fields, or { error } naming the first violation.
export function parseEpic(record, { slug } = {}) {
  const fail = error => ({ error });
  if (!record || typeof record !== 'object' || Array.isArray(record)) return fail('record is not an object');
  if (record.schema_version !== 1) return fail('unsupported schema_version');
  if (typeof record.epic !== 'string' || !EPIC_SLUG.test(record.epic)) return fail('epic is not a valid slug');
  if (record.epic !== slug) return fail('epic does not match directory name');
  if (typeof record.title !== 'string' || !record.title.trim()) return fail('title is missing');
  if (!STATES.includes(record.state)) return fail('state is not planned, active, complete or abandoned');
  if (![record.created_at, record.note].every(optionalString)) return fail('created_at and note must be strings');
  if (record.plan !== undefined) {
    // Lexical containment: the plan resolved from the epic directory stays inside the workspace.
    if (typeof record.plan !== 'string' || !record.plan || isAbsolute(record.plan) || record.plan.includes('\\')
      || !posix.resolve(`/workspace/epics/${slug}`, record.plan).startsWith('/workspace/')) return fail('plan escapes the workspace');
  }
  const designs = [];
  if (record.designs !== undefined) {
    // Designs the epic implements (docs/design-packages.md). Identity is workspace/design; path is a convenience.
    if (!Array.isArray(record.designs) || record.designs.length > 20) return fail('designs must be a list of at most 20 entries');
    for (const item of record.designs) {
      if (!item || typeof item !== 'object' || typeof item.workspace !== 'string' || !item.workspace
        || typeof item.design !== 'string' || !DESIGN_SLUG.test(item.design)) return fail('design entries need workspace and design slug');
      if (item.path !== undefined && (typeof item.path !== 'string' || !isAbsolute(item.path))) return fail(`design path of ${item.design} is not absolute`);
      designs.push({ workspace: item.workspace, design: item.design, path: item.path ?? null });
    }
  }
  if (!Array.isArray(record.packages)) return fail('packages is not an array');
  if (record.packages.length > EPIC_LIMITS.members) return fail(`more than ${EPIC_LIMITS.members} packages`);
  const names = new Set();
  const packages = [];
  for (const item of record.packages) {
    const name = item?.package;
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/]/.test(name)) return fail('package name is invalid');
    if (names.has(name)) return fail(`duplicate package ${name}`);
    names.add(name);
    if (item.requires !== undefined && (!Array.isArray(item.requires) || item.requires.some(value => typeof value !== 'string'))) return fail(`requires of ${name} is not a list of names`);
    if (!optionalString(item.note)) return fail(`note of ${name} is not a string`);
    packages.push({ package: name, requires: [...new Set(item.requires ?? [])], note: item.note ?? null });
  }
  for (const item of packages) {
    for (const required of item.requires) {
      if (required === item.package) return fail(`${item.package} requires itself`);
      if (!names.has(required)) return fail(`${item.package} requires unknown package ${required}`);
    }
  }
  const { cycle } = epicWaves(packages);
  if (cycle) return fail(`requires form a cycle among ${cycle.join(', ')}`);
  return { epic: { epic: slug, title: record.title, state: record.state, plan: record.plan ?? null,
    created_at: record.created_at ?? null, note: record.note ?? null, designs, packages } };
}

// Groups members into dependency waves: wave 1 requires nothing and each later
// wave requires only members of earlier waves, so members of one wave can run in
// parallel. Names keep array order within a wave. Returns { waves } or, when
// requires contain a cycle, { cycle } with the members that cannot be placed.
export function epicWaves(packages) {
  const waveOf = new Map();
  let pending = packages;
  while (pending.length) {
    const placed = pending.filter(item => item.requires.every(name => waveOf.has(name)));
    if (!placed.length) return { cycle: pending.map(item => item.package) };
    for (const item of placed) waveOf.set(item.package, 1 + Math.max(0, ...item.requires.map(name => waveOf.get(name))));
    pending = pending.filter(item => !waveOf.has(item.package));
  }
  const waves = [];
  for (const item of packages) (waves[waveOf.get(item.package) - 1] ??= []).push(item.package);
  return { waves };
}

// Reads one workspace's epic records through spec-location (which resolves each
// member to its package directory) and validates them. Records are small and
// read outside the sentinel's byte budget.
export async function readWorkspaceEpics(workspace, options) {
  const entries = [];
  const reasons = [];
  const listed = await listEpics(workspace, options);
  if (!listed.ok) return { entries, reasons: [`epics-unavailable: ${workspace} (${listed.code})`] };
  if (listed.epics.length > EPIC_LIMITS.epics) reasons.push(`epics-cap: ${workspace}`);
  for (const found of listed.epics.slice(0, EPIC_LIMITS.epics)) {
    if (found.error) { reasons.push(`epic-invalid: ${found.record} (unreadable or not JSON)`); continue; }
    const parsed = parseEpic(found.epic, { slug: found.slug });
    if (parsed.error) { reasons.push(`epic-invalid: ${found.record} (${parsed.error})`); continue; }
    const dir = dirname(found.record);
    // A plan file in the epic directory wins; otherwise the name is a file under the workspace's plans/ (docs/spec-epics.md).
    const plan = parsed.epic.plan === null ? null
      : existsSync(join(dir, parsed.epic.plan)) ? resolve(dir, parsed.epic.plan)
        : join(dirname(dirname(dir)), 'plans', parsed.epic.plan);
    entries.push({ slug: found.slug, workspace, dir, file: found.record, plan, epic: parsed.epic,
      packageDirs: found.members.map(member => ({ dir: member.packageDir })) });
  }
  return { entries, reasons };
}

export const attentionOf = run => !!run
  && (['blocked', 'decision-required'].includes(run.workflow_state)
    || (run.conditions ?? []).some(item => item.severity === 'attention' && item.state !== 'resolved'));

// Lifecycle, not acceptance: a merged package has landed, not necessarily passed every gate.
// `incomplete` means the package's receipts or checkpoints could not be fully read
// (budget, stale or invalid records); without a completion that is `unknown`, never a guess.
export function deriveMemberStatus({ observed = true, exists, prepared, hasReceipts, completion, run, incomplete = false }) {
  const basis = completion?.completion_basis;
  const status = !observed ? 'unobserved' : !exists ? 'missing'
    : basis === 'merged-pr' ? 'merged' : basis === 'manual' ? 'complete' : completion ? 'published'
    : incomplete ? 'unknown' : hasReceipts ? 'in-progress' : prepared ? 'prepared' : 'proposed';
  return { status, attention: status === 'in-progress' && attentionOf(run) };
}

// The planning subset an epic member publishes. Values are the same truth as a
// planned row's readiness facts; an unobserved or unreadable member stays null
// (INV-2 observation, never acceptance).
const PLANNING_FIELDS = ['proposal', 'critique', 'critique_recommended', 'prepared', 'step_count', 'preparation', 'decision'];
function projectPlanning(facts) {
  if (!facts) return null;
  return Object.fromEntries(PLANNING_FIELDS.map(field => [field, facts[field] ?? null]));
}

// Pure projection of collected member facts. `entries[].members` aligns with
// `epic.packages`; each carries the facts the status table needs plus `path`,
// `run`, `incomplete`.
export function buildEpics(entries) {
  const memberships = new Map();
  const epics = entries.map(entry => {
    const { epic } = entry;
    const members = epic.packages.map((item, index) => {
      const fact = entry.members[index];
      const { status, attention } = deriveMemberStatus(fact);
      const progress = fact.run?.spec_progress;
      return { name: item.package, package: fact.path, workspace: entry.workspace, status, attention,
        step: status === 'in-progress' && progress?.current_position != null
          ? { position: progress.current_position, total: progress.total_steps } : null,
        requires: [...item.requires], waiting_on: item.requires, note: item.note,
        completed_at: fact.completion?.completed_at ?? null,
        pr_url: fact.completion?.merge?.url ?? fact.run?.merge?.url ?? null,
        assignment_id: fact.run?.assignment_id ?? null,
        planning: projectPlanning(fact.planning) };
    });
    const byName = new Map(members.map(member => [member.name, member]));
    // A landed member owes nothing; otherwise list the requirements that have not landed.
    for (const member of members) member.waiting_on = LANDED.has(member.status) ? []
      : member.waiting_on.filter(name => !LANDED.has(byName.get(name).status));
    const count = (...statuses) => members.filter(member => statuses.includes(member.status)).length;
    const reasons = [];
    members.forEach((member, index) => {
      if (member.status === 'unobserved') reasons.push(`member-unobserved: ${member.name} (${entry.workspace})`);
      else if (entry.members[index].incomplete) reasons.push(`member-incomplete: ${member.name}`);
    });
    members.forEach((member, index) => {
      if (!memberships.has(member.package)) memberships.set(member.package,
        { epic: epic.epic, workspace: entry.workspace, position: index + 1, total: members.length });
    });
    return { epic: epic.epic, title: epic.title, state: epic.state, note: epic.note, designs: epic.designs, workspace: entry.workspace,
      record: entry.file, plan: entry.plan ?? null, members,
      summary: { total: members.length, merged: count('merged'), complete: count('complete'), published: count('published'),
        in_progress: count('in-progress'), prepared: count('prepared'), proposed: count('proposed'),
        missing: count('missing'), unobserved: count('unobserved'), unknown: count('unknown'), attention: members.filter(member => member.attention).length },
      next: members.find(member => ['proposed', 'prepared'].includes(member.status) && !member.waiting_on.length)?.name ?? null,
      coverage: { state: reasons.length ? 'partial' : 'complete', reasons } };
  });
  return { epics, memberships };
}

// The member facts an epic coordinator acts on while it waits for launched
// packages: lifecycle status, attention, and each launched session's observed
// state. Step progress is left out so ordinary progress does not wake it.
export function epicWaitState(epic, assignments = []) {
  return Object.fromEntries(epic.members.map(member => [member.name, {
    status: member.status, attention: member.attention,
    sessions: assignments.filter(row => row.spec_package === member.package)
      .map(row => `${row.assignment_id}:${row.display}`).sort(),
  }]));
}

export const changedMembers = (before, after) =>
  Object.keys(after).filter(name => JSON.stringify(before[name]) !== JSON.stringify(after[name]));

const kindOf = async path => {
  try { const info = await lstat(path); return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other'; }
  catch (error) { return error?.code === 'ENOENT' ? null : 'error'; }
};

// Joins the records with collected package facts. Beyond the sentinel's own
// package reads it performs only lstat calls on a member directory and its
// spec-steps.json, plus bounded planning reads through the injected reader and
// the shared step-index owner for observed members that lack cached
// planned-row readiness facts.
export async function collectEpics({ entries, facts, runs, recentlyCompleted, runConditions, readTime,
  budget = null, readBounded = null, planningCache = null, readStepIndex = null }) {
  const currentRun = path => {
    const row = runs.find(item => item.package === path && item.is_current_assignment === true);
    return row ? { ...row, conditions: runConditions(row, readTime) } : recentlyCompleted.find(item => item.package === path) ?? null;
  };
  const canRead = typeof readBounded === 'function' && budget !== null && budget !== undefined;
  // The memo keeps one read per planning file when a package is a member of
  // more than one epic.
  const planningMemo = new Map();
  const planningFacts = async fact => {
    // Members excluded from planned inventory never had their step index read.
    // Obtain it through the shared bounded owner so the fallback publishes the
    // same preparation truth as a planned row; the owner's fact.stepIndex cache
    // keeps one read per package.
    const steps = fact.stepIndex
      ?? (typeof readStepIndex === 'function' ? await readStepIndex(fact, budget) : null)
      ?? { readiness_valid: null, steps: [], source: null };
    const preparation = await readPreparation(fact.packagePath, budget, { readBounded, memo: planningMemo });
    const decision = await readDecision(fact.packagePath, budget, { readBounded, memo: planningMemo });
    const artifacts = await readPlanningArtifacts(fact.packagePath, budget, { readBounded, memo: planningMemo });
    // Same readiness rule as a planned row: only a valid index plus a prepared
    // report and no unresolved decision is positively prepared. Incomplete
    // reads stay unknown instead of guessing.
    const prepared = steps.readiness_valid === null || preparation.outcome === 'unavailable' || decision?.outcome === 'unavailable'
      ? null
      : steps.readiness_valid === true && preparation.outcome === 'prepared' && decision === null;
    return { ...artifacts, prepared, step_count: steps.source ? steps.steps.length : null, preparation, decision };
  };
  for (const entry of entries) {
    entry.members = [];
    for (const item of entry.packageDirs) {
      const path = await realpath(item.dir).catch(() => item.dir);
      const fact = facts.get(path);
      const planning = planningCache?.get(path) ?? (fact && canRead ? await planningFacts(fact) : null);
      const base = { path, workspace: entry.workspace, observed: true };
      if (fact) {
        entry.members.push({ ...base, exists: true, prepared: await kindOf(join(path, 'spec-steps.json')) === 'file',
          hasReceipts: (fact.candidates?.length ?? 0) > 0, completion: fact.completion ?? null, run: currentRun(path),
          incomplete: !!(fact.staleReceipts || fact.receiptsIncomplete), planning });
      } else {
        const kind = await kindOf(path);
        entry.members.push({ ...base, observed: kind !== 'error', exists: kind === 'dir',
          prepared: kind === 'dir' && await kindOf(join(path, 'spec-steps.json')) === 'file', planning: null });
      }
    }
  }
  entries.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.slug.localeCompare(b.slug));
  return buildEpics(entries);
}
