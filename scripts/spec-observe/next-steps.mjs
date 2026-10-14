// Cross-workspace newest written-file scan for the Next steps destination.
//
// Read-only observation over the workspace catalog. Each catalog workspace is
// visited with bounded directory handles; watched files are lstat-only metadata
// so the global newest rows are chosen before any content read. Signal reads go
// through the shared bounded package reader (symlink- and containment-refusing)
// and a separate aggregate byte budget. Nothing is written, HTML is never read,
// and no symlinked directory or file is followed. This module observes written
// files; it never invents readiness, acceptance or lifecycle state (INV-2).

import { lstat, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { createCatalogReadBudget, listWorkspaces } from '../workspaces/store.mjs';
import { epicWaves, parseEpic } from './epics.mjs';
import { readPackageFile } from './package-files.mjs';
import { parseProposalFrontMatter, parseProposalVerdict } from './preparation.mjs';

// Local domain constants. The catalog ceilings mirror createCatalogReadBudget's
// defaults and keep the independent catalog budget visible in coverage.
export const NEXT_STEPS_LIMITS = Object.freeze({
  schemaVersion: 1,
  windowMs: 604800000,
  packages: 500,
  epics: 50,
  rows: 200,
  signalBytes: 16 * 1024 * 1024,
  markdownBytes: 65536,
  tourBytes: 512 * 1024,
  epicBytes: 65536,
  prBytes: 65536,
  excerptChars: 400,
  titles: 6,
  catalog: Object.freeze({ entries: 400, rows: 100, kitBytes: 65536, bytes: 4194304 }),
});

// Watched files in lifecycle order: an exact mtime tie favors the later stage.
const WATCHED = Object.freeze([
  { name: 'proposal.md', stage: 'proposal' },
  { name: 'critique.md', stage: 'critique' },
  { name: 'spec.md', stage: 'spec' },
  { name: 'work-tour.html', stage: 'work-tour' },
]);
const STAGE_ORDER = new Map(WATCHED.map((watched, index) => [watched.stage, index]));

// The shared GitHub pull URL shape (merge-reconciliation.mjs owns the same
// pattern): only this exact scheme/host becomes an external PR link.
const GITHUB_PULL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/;
const HEADING = /^(#{2,4})\s+(.+?)\s*#*\s*$/;
const FOURTH_HEADING = /^\s*#{4,}\s+(.+?)\s*#*\s*$/;
const NUMBERED_BOLD = /^\s*\d+[.)]\s+\*\*(.+?)\*\*/;
const LABELLED_BOLD = /^\s*\*\*([MSC]\d+)\s*(?:[—–:.-]+\s*)?(.+?)\*\*/i;
const LIST_ITEM = /^\s*(?:\d+[.)]|\*|-)\s+(.+)$/;

const excerpt = value => typeof value === 'string'
  ? value.replace(/\s+/g, ' ').trim().slice(0, NEXT_STEPS_LIMITS.excerptChars) || null
  : null;

function addReason(coverage, reason) {
  if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason);
}

// Blank every fenced code line so headings and None bodies inside examples are
// not mistaken for prose structure.
function stripFences(text) {
  const kept = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (match) { fence = match[1][0]; kept.push(''); } else kept.push(line);
    } else {
      if (match && match[1][0] === fence) fence = null;
      kept.push('');
    }
  }
  return kept;
}

function headingOf(line) {
  const match = HEADING.exec(line);
  if (!match) return null;
  return {
    level: match[1].length,
    text: match[2].replace(/[*_`]/g, '').trim().replace(/[:.]+\s*$/, '').toLowerCase(),
  };
}

// `## Verdict: COMPATIBLE WITH CAVEATS` matches the `verdict` section.
function findSection(lines, title) {
  const wanted = title.toLowerCase();
  for (let index = 0; index < lines.length; index++) {
    const heading = headingOf(lines[index]);
    if (!heading) continue;
    if (heading.text === wanted || heading.text.startsWith(`${wanted}:`)) {
      return { index, level: heading.level };
    }
  }
  return null;
}

function sectionBody(lines, heading) {
  const body = [];
  for (let index = heading.index + 1; index < lines.length; index++) {
    const nested = headingOf(lines[index]);
    if (nested && nested.level <= heading.level) break;
    body.push(lines[index]);
  }
  return body;
}

function firstParagraph(body) {
  const paragraph = [];
  for (const line of body) {
    const text = line.trim();
    if (!text) { if (paragraph.length) break; continue; }
    if (headingOf(line)) continue;
    paragraph.push(text);
  }
  return paragraph.join(' ') || null;
}

// One Must Address / Should Address body. Recognized titles are numbered bold
// items, M/S/C-labelled bold paragraphs and fourth-level headings; an explicit
// None body is zero, while empty or unrecognized nonempty content is unparsed.
function analyseCritiqueSection(body) {
  const titles = [];
  let sawNone = false;
  let unrecognized = false;
  for (const line of body) {
    if (!line.trim()) continue;
    const fourth = FOURTH_HEADING.exec(line);
    if (fourth) { titles.push(fourth[1]); continue; }
    const labelled = LABELLED_BOLD.exec(line);
    if (labelled) { titles.push(labelled[2]); continue; }
    const numbered = NUMBERED_BOLD.exec(line);
    if (numbered) { titles.push(numbered[1]); continue; }
    if (/^\s*none\.?\s*$/i.test(line)) { sawNone = true; continue; }
    unrecognized = true;
  }
  if (titles.length) {
    return { titles: titles.map(excerpt).filter(Boolean) };
  }
  if (sawNone && !unrecognized) return { titles: [] };
  return { error: unrecognized ? 'unrecognized-content' : 'empty-section' };
}

// The three observed critique generations share required Recommendations,
// Must Address and Should Address headings; their bodies may use any of the
// three title formats. An optional Consider section uses the same formats and
// explicit None handling; absent means zero, malformed means unparsed.
function parseCritique(text) {
  const lines = stripFences(text);
  const recommendations = findSection(lines, 'Recommendations');
  if (!recommendations) return { error: 'missing Recommendations section' };
  const body = sectionBody(lines, recommendations);
  const must = findSection(body, 'Must Address');
  if (!must) return { error: 'missing Must Address section' };
  const should = findSection(body, 'Should Address');
  if (!should) return { error: 'missing Should Address section' };
  const mustSection = analyseCritiqueSection(sectionBody(body, must));
  if (mustSection.error) return { error: `Must Address: ${mustSection.error}` };
  const shouldSection = analyseCritiqueSection(sectionBody(body, should));
  if (shouldSection.error) return { error: `Should Address: ${shouldSection.error}` };
  const considerSection = findSection(body, 'Consider');
  let consider = 0;
  if (considerSection) {
    const analysed = analyseCritiqueSection(sectionBody(body, considerSection));
    if (analysed.error) return { error: `Consider: ${analysed.error}` };
    consider = analysed.titles.length;
  }
  const assessment = findSection(lines, 'Assessment');
  return {
    assessment: assessment ? excerpt(firstParagraph(sectionBody(lines, assessment))) : null,
    must_address: mustSection.titles.slice(0, NEXT_STEPS_LIMITS.titles),
    should_address: shouldSection.titles.slice(0, NEXT_STEPS_LIMITS.titles),
    consider,
  };
}

// Proposal signals need both validated front-matter values; the Summary opening
// and the verdict section's caveat list or incompatible reason are excerpts.
function parseProposalSignal(text) {
  const verdict = parseProposalVerdict(text);
  const critique_recommended = parseProposalFrontMatter(text);
  if (verdict === null || critique_recommended === null) return { error: 'proposal front matter is incomplete' };
  const lines = stripFences(text);
  const summary = findSection(lines, 'Summary');
  const verdictSection = findSection(lines, 'Verdict');
  const verdictBody = verdictSection ? sectionBody(lines, verdictSection) : [];
  const caveats = verdictBody
    .map(line => LIST_ITEM.exec(line))
    .filter(Boolean)
    .map(match => excerpt(match[1]))
    .filter(Boolean)
    .slice(0, NEXT_STEPS_LIMITS.titles);
  return {
    signal: {
      state: 'ok',
      verdict,
      critique_recommended,
      summary: summary ? excerpt(firstParagraph(sectionBody(lines, summary))) : null,
      caveats,
      incompatible_reason: verdict === 'INCOMPATIBLE' ? excerpt(firstParagraph(verdictBody)) : null,
    },
  };
}

// Work-tour JSON is required and typed: known verdict, gap list, and string
// commit/title/summary when present. pr-url.json is optional.
async function projectTourSignal(text, directory, relative, workspaceName, budget) {
  const fail = reason => ({
    signal: { state: 'unreadable', reason },
    reason: `signal-unreadable: ${workspaceName}/${relative} (${reason})`,
  });
  let record;
  try { record = JSON.parse(text); } catch { return fail('work-tour.json is not JSON'); }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return fail('work-tour.json is not an object');
  if (!['ready', 'blocked', 'merged'].includes(record.verdict)) return fail('work-tour verdict is unrecognized');
  if (!Array.isArray(record.gaps)) return fail('work-tour gaps is not an array');
  for (const key of ['commit', 'title', 'summary']) {
    if (record[key] !== undefined && typeof record[key] !== 'string') return fail(`work-tour ${key} is not a string`);
  }
  const signal = {
    state: 'ok',
    verdict: record.verdict,
    gaps: record.gaps.length,
    commit: record.commit ?? null,
    title: record.title ?? null,
    summary: excerpt(record.summary),
    pr: null,
  };
  const read = await readSignal(directory, 'pr-url.json', NEXT_STEPS_LIMITS.prBytes, budget);
  if (read.outcome === 'ok') {
    const projected = projectPr(read.text);
    if (projected.error) return { signal, reason: `pr-malformed: ${workspaceName}/${relative}` };
    signal.pr = projected.pr;
    return { signal };
  }
  if (read.outcome === 'missing') return { signal };
  return { signal, reason: `pr-unreadable: ${workspaceName}/${relative} (${read.reason ?? read.outcome})` };
}

// First GitHub pull URL among the v2 targets map; every other scheme or host
// stays unlinked.
function projectPr(text) {
  let record;
  try { record = JSON.parse(text); } catch { return { error: true }; }
  const candidates = [];
  if (record && typeof record === 'object' && !Array.isArray(record)
    && record.targets && typeof record.targets === 'object' && !Array.isArray(record.targets)) {
    for (const target of Object.values(record.targets)) {
      if (target && typeof target === 'object' && typeof target.url === 'string') candidates.push(target.url);
    }
  }
  const url = candidates.find(value => GITHUB_PULL.test(value));
  return url ? { pr: { url } } : { error: true };
}

function createSignalBudget() {
  return { limit: NEXT_STEPS_LIMITS.signalBytes, used: 0 };
}

// Reserve cap+1 before each read so a refused, failed or grown read cannot
// exceed the shared aggregate limit; a successful read charges actual bytes.
async function readSignal(directory, name, capBytes, budget) {
  if (budget.used + capBytes + 1 > budget.limit) {
    return { outcome: 'budget', reason: 'signal-budget-exhausted' };
  }
  try {
    const file = await readPackageFile(directory, name, { maxBytes: capBytes });
    budget.used += file.bytes.length;
    return { outcome: 'ok', text: file.bytes.toString('utf8') };
  } catch (error) {
    const missing = error?.code === 'ENOENT';
    if (!missing) budget.used += capBytes + 1;
    return { outcome: missing ? 'missing' : 'error', reason: error?.message ?? String(error) };
  }
}

async function projectPackageSignal(candidate, budget) {
  const workspaceName = basename(candidate.workspace.directory);
  const { selected } = candidate;
  const relative = `specs/${candidate.slug}/${selected.name}`;
  // The row metadata is the spec signal; spec.md is never read. Work tours
  // read the required work-tour.json while the row keeps naming the HTML file.
  if (selected.stage === 'spec') return { signal: { state: 'ok' } };
  const name = selected.stage === 'work-tour' ? 'work-tour.json' : selected.name;
  const cap = selected.stage === 'work-tour' ? NEXT_STEPS_LIMITS.tourBytes : NEXT_STEPS_LIMITS.markdownBytes;
  const read = await readSignal(candidate.directory, name, cap, budget);
  if (read.outcome === 'budget') {
    return { signal: { state: 'unreadable', reason: 'signal-budget-exhausted' }, reason: `signal-budget: ${workspaceName}/${relative}` };
  }
  if (read.outcome !== 'ok') {
    return { signal: { state: 'unreadable', reason: read.reason }, reason: `signal-unreadable: ${workspaceName}/${relative} (${read.reason})` };
  }
  if (selected.stage === 'proposal') {
    const parsed = parseProposalSignal(read.text);
    if (parsed.error) return { signal: { state: 'unreadable', reason: parsed.error }, reason: `signal-unreadable: ${workspaceName}/${relative} (${parsed.error})` };
    return { signal: parsed.signal };
  }
  if (selected.stage === 'critique') {
    const parsed = parseCritique(read.text);
    if (parsed.error) return { signal: { state: 'unparsed', reason: parsed.error }, reason: `signal-unparsed: ${workspaceName}/${relative} (${parsed.error})` };
    return { signal: { state: 'ok', ...parsed } };
  }
  return projectTourSignal(read.text, candidate.directory, relative, workspaceName, budget);
}

// `specs` is absent, a non-directory, an unreadable directory or a skipped
// symlink; only a canonical directory yields a path for traversal.
async function childDirectory(parent, name) {
  const path = join(parent, name);
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error.code === 'ENOENT') return { absent: true };
    return { error };
  }
  if (info.isSymbolicLink()) return { skipped: true };
  if (!info.isDirectory()) return { error: new Error(`${name} is not a directory`) };
  try {
    const canonical = await realpath(path);
    if (canonical !== path) return { error: new Error(`${name} is not canonical`) };
    return { path: canonical };
  } catch (error) {
    return { error };
  }
}

async function listChildDirectories(directory, label, workspaceName, cap, coverage) {
  const names = [];
  let truncated = false;
  let handle;
  try { handle = await opendir(directory); }
  catch (error) {
    addReason(coverage, `${label}s-unreadable: ${workspaceName} (${error.message})`);
    return { error: true };
  }
  try {
    for await (const entry of handle) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (names.length >= cap) {
        addReason(coverage, `${label}s-cap: ${workspaceName} (more than ${cap})`);
        truncated = true;
        break;
      }
      names.push(entry.name);
    }
  } catch (error) {
    addReason(coverage, `${label}s-unreadable: ${workspaceName} (${error.message})`);
    return { error: true };
  }
  names.sort();
  return { names, truncated };
}

async function collectPackageCandidate(canonicalSpecs, slug, workspace, candidates, coverage) {
  const workspaceName = basename(workspace.directory);
  const path = join(canonicalSpecs, slug);
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    addReason(coverage, `package-unreadable: ${workspaceName}/specs/${slug} (${error.message})`);
    return;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  let directory;
  try { directory = await realpath(path); }
  catch (error) {
    addReason(coverage, `package-unreadable: ${workspaceName}/specs/${slug} (${error.message})`);
    return;
  }
  if (dirname(directory) !== canonicalSpecs) {
    addReason(coverage, `package-outside: ${workspaceName}/specs/${slug}`);
    return;
  }
  const observed = [];
  for (const watched of WATCHED) {
    let fileInfo;
    try { fileInfo = await lstat(join(directory, watched.name)); }
    catch (error) {
      if (error.code !== 'ENOENT') addReason(coverage, `watched-unreadable: ${workspaceName}/specs/${slug}/${watched.name} (${error.message})`);
      continue;
    }
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) continue;
    observed.push({ name: watched.name, stage: watched.stage, mtimeMs: fileInfo.mtimeMs });
  }
  if (!observed.length) return;
  const selected = observed.reduce((best, item) => item.mtimeMs > best.mtimeMs
    || (item.mtimeMs === best.mtimeMs && STAGE_ORDER.get(item.stage) > STAGE_ORDER.get(best.stage)) ? item : best);
  candidates.push({ kind: 'package', workspace, slug, directory, selected, observed,
    mtimeMs: selected.mtimeMs, key: JSON.stringify([workspace.id, 'package', slug]) });
}

// A planned epic is eligible only when every member directory was checked and
// holds no regular watched file. An unknown check omits the epic and reports a
// scoped partial reason; absent ordinary member directories are empty.
async function epicEligibility(specs, packages, workspaceName, slug, coverage) {
  if (!specs.path) {
    if (specs.absent) return true;
    addReason(coverage, `epic-member-unknown: ${workspaceName}/epics/${slug} (specs unavailable)`);
    return false;
  }
  for (const item of packages) {
    const path = join(specs.path, item.package);
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      addReason(coverage, `epic-member-unknown: ${workspaceName}/epics/${slug}/${item.package} (${error.message})`);
      return false;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      addReason(coverage, `epic-member-unknown: ${workspaceName}/epics/${slug}/${item.package} (not a canonical directory)`);
      return false;
    }
    let directory;
    try { directory = await realpath(path); }
    catch (error) {
      addReason(coverage, `epic-member-unknown: ${workspaceName}/epics/${slug}/${item.package} (${error.message})`);
      return false;
    }
    if (dirname(directory) !== specs.path) {
      addReason(coverage, `epic-member-unknown: ${workspaceName}/epics/${slug}/${item.package} (outside specs)`);
      return false;
    }
    for (const watched of WATCHED) {
      let fileInfo;
      try { fileInfo = await lstat(join(directory, watched.name)); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        addReason(coverage, `epic-member-unknown: ${workspaceName}/epics/${slug}/${item.package} (${error.message})`);
        return false;
      }
      if (!fileInfo.isSymbolicLink() && fileInfo.isFile()) return false;
    }
  }
  return true;
}

async function collectEpicCandidate(specs, canonicalEpics, slug, workspace, candidates, coverage, budget) {
  const workspaceName = basename(workspace.directory);
  const path = join(canonicalEpics, slug);
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    addReason(coverage, `epic-unreadable: ${workspaceName}/epics/${slug} (${error.message})`);
    return;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  let directory;
  try { directory = await realpath(path); }
  catch (error) {
    addReason(coverage, `epic-unreadable: ${workspaceName}/epics/${slug} (${error.message})`);
    return;
  }
  if (dirname(directory) !== canonicalEpics) {
    addReason(coverage, `epic-outside: ${workspaceName}/epics/${slug}`);
    return;
  }
  const file = join(directory, 'epic.json');
  let fileInfo;
  try { fileInfo = await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    addReason(coverage, `epic-unreadable: ${workspaceName}/epics/${slug} (${error.message})`);
    return;
  }
  // A symlinked record is skipped without following it.
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) return;
  const read = await readSignal(directory, 'epic.json', NEXT_STEPS_LIMITS.epicBytes, budget);
  if (read.outcome === 'budget') {
    addReason(coverage, `signal-budget: ${workspaceName}/epics/${slug}/epic.json`);
    return;
  }
  if (read.outcome !== 'ok') {
    addReason(coverage, `epic-unreadable: ${workspaceName}/epics/${slug} (${read.reason ?? read.outcome})`);
    return;
  }
  let record;
  try { record = JSON.parse(read.text); }
  catch { addReason(coverage, `epic-invalid: ${workspaceName}/epics/${slug} (not JSON)`); return; }
  const parsed = parseEpic(record, { slug });
  if (parsed.error) {
    addReason(coverage, `epic-invalid: ${workspaceName}/epics/${slug} (${parsed.error})`);
    return;
  }
  if (parsed.epic.state !== 'planned') return;
  if (!(await epicEligibility(specs, parsed.epic.packages, workspaceName, slug, coverage))) return;
  candidates.push({ kind: 'epic', workspace, slug, directory, epic: parsed.epic, observed: [],
    mtimeMs: fileInfo.mtimeMs, key: JSON.stringify([workspace.id, 'epic', slug]) });
}

async function visitWorkspace(workspace, candidates, coverage, budget) {
  const workspaceName = basename(workspace.directory);
  let directory;
  try { directory = await realpath(workspace.directory); }
  catch (error) { return { read: false, reason: `cannot canonicalize workspace (${error.message})` }; }
  const reasonsBefore = coverage.reasons.length;
  let read = true;
  let reason = null;
  const specs = await childDirectory(directory, 'specs');
  if (specs.error) { read = false; reason ??= specs.error.message; }
  if (specs.path) {
    const listed = await listChildDirectories(specs.path, 'package', workspaceName, NEXT_STEPS_LIMITS.packages, coverage);
    if (listed.error) { read = false; reason ??= 'specs cannot be enumerated'; }
    else {
      if (listed.truncated) { read = false; reason ??= 'specs truncated'; }
      for (const slug of listed.names) await collectPackageCandidate(specs.path, slug, workspace, candidates, coverage);
    }
  }
  const epics = await childDirectory(directory, 'epics');
  if (epics.error) { read = false; reason ??= epics.error.message; }
  if (epics.path) {
    const listed = await listChildDirectories(epics.path, 'epic', workspaceName, NEXT_STEPS_LIMITS.epics, coverage);
    if (listed.error) { read = false; reason ??= 'epics cannot be enumerated'; }
    else {
      if (listed.truncated) { read = false; reason ??= 'epics truncated'; }
      for (const slug of listed.names) await collectEpicCandidate(specs, epics.path, slug, workspace, candidates, coverage, budget);
    }
  }
  // Any scoped traversal or eligibility reason means this workspace was not
  // fully read, even when individual children survived.
  if (coverage.reasons.length > reasonsBefore) {
    read = false;
    reason ??= coverage.reasons[reasonsBefore] ?? 'traversal partial';
  }
  return { read, reason };
}

async function buildRow(candidate, budget, coverage) {
  const epic = candidate.kind === 'epic';
  const workspaceName = basename(candidate.workspace.directory);
  const row = {
    key: candidate.key,
    kind: candidate.kind,
    workspace_id: candidate.workspace.id,
    workspace: workspaceName,
    workspace_name: candidate.workspace.name,
    slug: candidate.slug,
    stage: epic ? 'epic' : candidate.selected.stage,
    file: epic ? 'epic.json' : candidate.selected.name,
    path: epic ? `epics/${candidate.slug}/epic.json` : `specs/${candidate.slug}/${candidate.selected.name}`,
    written_at: new Date(candidate.mtimeMs).toISOString(),
    observed_files: (epic
      ? [{ name: 'epic.json', stage: 'epic', mtimeMs: candidate.mtimeMs }]
      : candidate.observed)
      .slice()
      .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(item => ({ name: item.name, stage: item.stage, written_at: new Date(item.mtimeMs).toISOString() })),
    signal: { state: 'unreadable', reason: 'not-read' },
  };
  if (!epic) row.package = candidate.directory;
  if (epic) {
    row.signal = {
      state: 'ok',
      members: candidate.epic.packages.map(item => item.package),
      wave1: epicWaves(candidate.epic.packages).waves?.[0] ?? [],
    };
    return row;
  }
  const projected = await projectPackageSignal(candidate, budget);
  row.signal = projected.signal;
  if (projected.reason) addReason(coverage, projected.reason);
  return row;
}

/**
 * Scan every catalog workspace for the newest watched file per package subject
 * and every eligible planned epic, then read signals for the globally newest
 * rows. Returns the NextStepsScan shape from spec.md Architecture.
 * @param {string} storageRoot
 * @param {{now?: number|Date}} [options]
 */
export async function scanNextSteps(storageRoot, { now = Date.now() } = {}) {
  if (typeof storageRoot !== 'string' || storageRoot === '') throw new TypeError('storageRoot must be a non-empty string');
  const moment = now instanceof Date ? now.getTime() : now;
  const scannedAt = new Date(Number.isFinite(moment) ? moment : Date.now());
  const cutoff = scannedAt.getTime() - NEXT_STEPS_LIMITS.windowMs;
  const coverage = { state: 'complete', reasons: [], workspaces: { read: 0, total: null }, unread: [] };
  const catalogBudget = createCatalogReadBudget();
  let catalog;
  try { catalog = await listWorkspaces(storageRoot, { budget: catalogBudget }); }
  catch (error) {
    addReason(coverage, `storage: ${error.message}`);
    coverage.state = 'unavailable';
    return { schema_version: NEXT_STEPS_LIMITS.schemaVersion, scanned_at: scannedAt.toISOString(),
      window_ms: NEXT_STEPS_LIMITS.windowMs, coverage, rows: [] };
  }
  for (const reason of catalogBudget.reasons) addReason(coverage, `catalog: ${reason}`);
  coverage.workspaces.total = catalogBudget.omissions === 'none' ? catalog.valid.length : null;
  if (!catalog.valid.length && catalog.errors.length) {
    for (const error of catalog.errors) addReason(coverage, `storage: ${error.path} (${error.message})`);
    coverage.state = 'unavailable';
    return { schema_version: NEXT_STEPS_LIMITS.schemaVersion, scanned_at: scannedAt.toISOString(),
      window_ms: NEXT_STEPS_LIMITS.windowMs, coverage, rows: [] };
  }
  for (const error of catalog.errors) addReason(coverage, `catalog-error: ${error.path} (${error.message})`);
  for (const invalid of catalog.invalid) {
    const name = basename(invalid.directory);
    coverage.unread.push({ workspace: name, reason: invalid.errors.join('; ') });
    addReason(coverage, `workspace-invalid: ${name} (${invalid.errors.join('; ')})`);
  }
  const signalBudget = createSignalBudget();
  const candidates = [];
  // listWorkspaces charges entries and bytes but not rows; enforce the shared
  // catalog row ceiling here without touching the store owner.
  if (catalog.valid.length > catalogBudget.maxRows) {
    addReason(coverage, `catalog-workspace-row-cap: ${catalog.valid.length} valid workspaces; `
      + `first ${catalogBudget.maxRows} read`);
    coverage.workspaces.total = null;
  }
  for (const workspace of catalog.valid.slice(0, catalogBudget.maxRows)) {
    const visited = await visitWorkspace(workspace, candidates, coverage, signalBudget);
    if (visited.read) coverage.workspaces.read += 1;
    else {
      const name = basename(workspace.directory);
      coverage.unread.push({ workspace: name, reason: visited.reason ?? 'unreadable' });
      addReason(coverage, `workspace-unread: ${name} (${visited.reason ?? 'unreadable'})`);
    }
  }
  const withinWindow = candidates.filter(candidate => candidate.mtimeMs >= cutoff);
  withinWindow.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (withinWindow.length > NEXT_STEPS_LIMITS.rows) {
    addReason(coverage, `rows-truncated: ${withinWindow.length} candidates; newest ${NEXT_STEPS_LIMITS.rows} kept`);
  }
  const rows = [];
  for (const candidate of withinWindow.slice(0, NEXT_STEPS_LIMITS.rows)) {
    rows.push(await buildRow(candidate, signalBudget, coverage));
  }
  if (coverage.reasons.length) coverage.state = 'partial';
  return { schema_version: NEXT_STEPS_LIMITS.schemaVersion, scanned_at: scannedAt.toISOString(),
    window_ms: NEXT_STEPS_LIMITS.windowMs, coverage, rows };
}
