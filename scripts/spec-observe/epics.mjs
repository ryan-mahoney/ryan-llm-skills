// Read-only epic membership for the spec sentinel (see docs/spec-epics.md).
//
// An epic record names member packages, order and dependencies. Member status
// is derived from package facts at read time and never stored. Nothing here
// writes, follows symlinks, or reads package contents.

import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, resolve } from 'node:path';

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
    // Lexical containment: the plan resolved from the epic directory stays inside .specs.
    if (typeof record.plan !== 'string' || !record.plan || isAbsolute(record.plan) || record.plan.includes('\\')
      || !posix.resolve(`/.specs/_epics/${slug}`, record.plan).startsWith('/.specs/')) return fail('plan escapes .specs');
  }
  const designs = [];
  if (record.designs !== undefined) {
    // Designs the epic implements (docs/design-packages.md). Identity is workspace/design; path is a convenience.
    if (!Array.isArray(record.designs) || record.designs.length > 20) return fail('designs must be a list of at most 20 entries');
    for (const item of record.designs) {
      if (!item || typeof item !== 'object' || typeof item.workspace !== 'string' || !item.workspace
        || typeof item.design !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(item.design)) return fail('design entries need workspace and design slug');
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
    if (item.repository !== undefined && (typeof item.repository !== 'string' || !isAbsolute(item.repository))) return fail(`repository of ${name} is not absolute`);
    if (item.requires !== undefined && (!Array.isArray(item.requires) || item.requires.some(value => typeof value !== 'string'))) return fail(`requires of ${name} is not a list of names`);
    if (!optionalString(item.note)) return fail(`note of ${name} is not a string`);
    packages.push({ package: name, repository: item.repository ?? null, requires: [...new Set(item.requires ?? [])], note: item.note ?? null });
  }
  for (const item of packages) {
    for (const required of item.requires) {
      if (required === item.package) return fail(`${item.package} requires itself`);
      if (!names.has(required)) return fail(`${item.package} requires unknown package ${required}`);
    }
  }
  return { epic: { epic: slug, title: record.title, state: record.state, plan: record.plan ?? null,
    created_at: record.created_at ?? null, note: record.note ?? null, designs, packages } };
}

// Lists <specsDir>/_epics/* (real directories only) and reads each epic.json
// through the caller's bounded reader so its bytes count against the shared budget.
export async function readEpics(specsDir, { readJson, listDirectory, budget }) {
  const root = join(specsDir, '_epics');
  const epics = [];
  const reasons = [];
  const listed = await listDirectory(root, EPIC_LIMITS.epics, entry => entry.isDirectory());
  // An absent _epics directory is the ordinary case.
  if (listed.entries === null) {
    if (listed.code !== 'ENOENT') reasons.push(`epics-unavailable: ${root} (${listed.code})`);
    return { epics, reasons };
  }
  if (listed.code) reasons.push(`epics-unavailable: ${root} (${listed.code})`);
  if (listed.truncated) reasons.push(`epics-cap: ${root}`);
  for (const entry of listed.entries) {
    const dir = join(root, entry.name);
    const file = join(dir, 'epic.json');
    const read = await readJson(file, EPIC_LIMITS.recordBytes, budget, {
      prefix: 'epic', oversize: false, within: dir, allow: value => value && typeof value === 'object' ? value : null });
    if (read.outcome === 'read-budget') { reasons.push(read.reason); break; }
    if (read.outcome !== 'ok') {
      const why = read.outcome === 'missing' ? 'epic.json missing' : read.outcome === 'oversized' ? 'record over 64 KiB' : 'unreadable or not JSON';
      reasons.push(`epic-invalid: ${file} (${why})`);
      continue;
    }
    const parsed = parseEpic(read.record, { slug: entry.name });
    if (parsed.error) reasons.push(`epic-invalid: ${file} (${parsed.error})`);
    else epics.push({ slug: entry.name, dir, file, epic: parsed.epic });
  }
  return { epics, reasons };
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

// Pure projection of collected member facts. `entries[].members` aligns with
// `epic.packages`; each carries the facts the status table needs plus `path`,
// `repository`, `run`, `incomplete`.
export function buildEpics(entries) {
  const memberships = new Map();
  const epics = entries.map(entry => {
    const { epic } = entry;
    const members = epic.packages.map((item, index) => {
      const fact = entry.members[index];
      const { status, attention } = deriveMemberStatus(fact);
      const progress = fact.run?.spec_progress;
      return { name: item.package, package: fact.path, repository: fact.repository, status, attention,
        step: status === 'in-progress' && progress?.current_position != null
          ? { position: progress.current_position, total: progress.total_steps } : null,
        waiting_on: item.requires, note: item.note,
        completed_at: fact.completion?.completed_at ?? null,
        pr_url: fact.completion?.merge?.url ?? fact.run?.merge?.url ?? null,
        assignment_id: fact.run?.assignment_id ?? null };
    });
    const byName = new Map(members.map(member => [member.name, member]));
    // A landed member owes nothing; otherwise list the requirements that have not landed.
    for (const member of members) member.waiting_on = LANDED.has(member.status) ? []
      : member.waiting_on.filter(name => !LANDED.has(byName.get(name).status));
    const count = (...statuses) => members.filter(member => statuses.includes(member.status)).length;
    const reasons = [];
    members.forEach((member, index) => {
      if (member.status === 'unobserved') reasons.push(`member-unobserved: ${member.name} (${member.repository})`);
      else if (entry.members[index].incomplete) reasons.push(`member-incomplete: ${member.name}`);
    });
    members.forEach((member, index) => {
      if (!memberships.has(member.package)) memberships.set(member.package,
        { epic: epic.epic, repository: entry.repository, position: index + 1, total: members.length });
    });
    return { epic: epic.epic, title: epic.title, state: epic.state, note: epic.note, designs: epic.designs, repository: entry.repository,
      record: entry.file, plan: epic.plan ? resolve(entry.dir, epic.plan) : null, members,
      summary: { total: members.length, merged: count('merged'), complete: count('complete'), published: count('published'),
        in_progress: count('in-progress'), prepared: count('prepared'), proposed: count('proposed'),
        missing: count('missing'), unobserved: count('unobserved'), unknown: count('unknown'), attention: members.filter(member => member.attention).length },
      next: members.find(member => ['proposed', 'prepared'].includes(member.status) && !member.waiting_on.length)?.name ?? null,
      coverage: { state: reasons.length ? 'partial' : 'complete', reasons } };
  });
  return { epics, memberships };
}

const kindOf = async path => {
  try { const info = await lstat(path); return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other'; }
  catch (error) { return error?.code === 'ENOENT' ? null : 'error'; }
};

// Reads epic records from every observed primary checkout. Call this before the
// package reads: records are small and must not lose the shared budget to history.
export async function readEpicRecords({ facts, roots = [], readJson, listDirectory, budget }) {
  const primaries = new Set([...facts.values()].map(fact => fact.primary));
  // Enrolled primary checkouts (a .git directory, not a linked-worktree file) count as observed.
  for (const root of roots) {
    try {
      const primary = await realpath(root);
      if ((await lstat(join(primary, '.git'))).isDirectory()) primaries.add(primary);
    } catch { /* an unreadable root is reported by the package enumeration */ }
  }
  const reasons = [];
  const entries = [];
  for (const primary of [...primaries].sort()) {
    const found = await readEpics(join(primary, '.specs'), { readJson, listDirectory, budget });
    reasons.push(...found.reasons);
    for (const item of found.epics) entries.push({ ...item, repository: primary });
  }
  return { entries, primaries, reasons };
}

// Joins the records with collected package facts. Beyond the sentinel's own
// package reads it performs only lstat calls on a member directory and its spec-steps.json.
export async function collectEpics({ entries, primaries, facts, runs, recentlyCompleted, runConditions, readTime }) {
  const currentRun = path => {
    const row = runs.find(item => item.package === path && item.is_current_assignment === true);
    return row ? { ...row, conditions: runConditions(row, readTime) } : recentlyCompleted.find(item => item.package === path) ?? null;
  };
  for (const entry of entries) {
    entry.members = [];
    for (const item of entry.epic.packages) {
      const repository = item.repository ? await realpath(item.repository).catch(() => resolve(item.repository)) : entry.repository;
      const path = join(repository, '.specs', item.package);
      const fact = facts.get(path);
      const base = { path, repository, observed: primaries.has(repository) };
      if (fact) {
        entry.members.push({ ...base, exists: true, prepared: await kindOf(join(path, 'spec-steps.json')) === 'file',
          hasReceipts: (fact.candidates?.length ?? 0) > 0, completion: fact.completion ?? null, run: currentRun(path),
          incomplete: !!(fact.staleReceipts || fact.receiptsIncomplete) });
      } else if (!base.observed) {
        entry.members.push({ ...base, exists: false });
      } else {
        const kind = await kindOf(path);
        entry.members.push({ ...base, observed: kind !== 'error', exists: kind === 'dir',
          prepared: kind === 'dir' && await kindOf(join(path, 'spec-steps.json')) === 'file' });
      }
    }
  }
  entries.sort((a, b) => a.repository.localeCompare(b.repository) || a.slug.localeCompare(b.slug));
  return buildEpics(entries);
}
