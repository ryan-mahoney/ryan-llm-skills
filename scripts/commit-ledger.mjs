import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_MANIFEST = "docs/specops/targets.json";
const HISTORY_DIR = "docs/specops/history";
const DEFAULT_LEDGER = `${HISTORY_DIR}/ledger.jsonl`;
const DEFAULT_FRONTIER = `${HISTORY_DIR}/frontier.json`;
const LENSES = ["doc", "intent", "rework"];

// ---------------------------------------------------------------------------
// Pure helpers (exported and unit-tested). No git, no filesystem, no clock.
// ---------------------------------------------------------------------------

// Glob matching mirrors scripts/decompose-skeleton.mjs: it supports the four
// shapes the decomposition core can emit ("**", "*", "dir/**", "dir/*"), unlike
// agent-docs.mjs which only handles "**" and "dir/**" and throws on remainders.
function matches(relPath, glob) {
  if (glob === "**") return true;
  if (glob === "*") return !relPath.includes("/");
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return relPath === prefix || relPath.startsWith(`${prefix}/`);
  }
  if (glob.endsWith("/*")) {
    const prefix = glob.slice(0, -2);
    if (!relPath.startsWith(`${prefix}/`)) return false;
    const rest = relPath.slice(prefix.length + 1);
    return rest.length > 0 && !rest.includes("/");
  }
  throw new Error(`unsupported glob shape: ${glob}`);
}

function targetsForFile(manifest, relPath) {
  const slugs = [];
  for (const target of manifest.targets || []) {
    if ((target.source_globs || []).some((glob) => matches(relPath, glob))) slugs.push(target.slug);
  }
  return slugs;
}

function targetsForFiles(manifest, files) {
  const slugs = new Set();
  const unowned = [];
  for (const file of files) {
    const owners = targetsForFile(manifest, file);
    if (owners.length === 0) unowned.push(file);
    else owners.forEach((slug) => slugs.add(slug));
  }
  return {
    targets: [...slugs].sort((a, b) => a.localeCompare(b)),
    unowned_files: unowned.sort((a, b) => a.localeCompare(b)),
  };
}

function isValidLens(lens) {
  return LENSES.includes(lens);
}

// Parse JSONL ledger text into records. Blank lines are tolerated.
function parseLedger(text) {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function serializeLedger(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

// SHAs covered under a lens.
function coveredShas(records, lens) {
  const set = new Set();
  for (const record of records) {
    if (record.lens === lens && record.commit) set.add(record.commit);
  }
  return set;
}

// Commits not yet covered under a lens, preserving input order (oldest-first).
function uncoveredCommits(commits, records, lens) {
  const covered = coveredShas(records, lens);
  return commits.filter((commit) => !covered.has(commit.commit));
}

// Build one ledger row for one commit under one lens. `now` is injected so the
// row is deterministic in tests; the command layer passes a real ISO timestamp.
function buildRecord(commit, lens, now, collapsedFrom = []) {
  return {
    commit: commit.commit,
    abbrev: commit.abbrev || (commit.commit ? commit.commit.slice(0, 12) : null),
    tree: commit.tree || null,
    author: commit.author || null,
    email: commit.email || null,
    date: commit.date || null,
    subject: commit.subject || null,
    targets: commit.targets || [],
    lens,
    recorded_at: now,
    collapsed_from: collapsedFrom,
  };
}

function frontierFor(frontier, lens) {
  return (frontier && frontier[lens]) || null;
}

function frontierEntry(commit) {
  return { commit: commit.commit, tree: commit.tree || null, date: commit.date || null };
}

function advanceFrontier(frontier, lens, commit) {
  return { ...(frontier || {}), [lens]: frontierEntry(commit) };
}

// Decide how to bring a lens current given the reachability of prior coverage.
// `reachableMap` maps SHA -> boolean (is the commit still reachable from HEAD).
// This is the squash-merge survival logic, kept pure so it is unit-testable.
function reconcilePlan({ lens, frontier, ledgerRecords, reachableMap, headCommit }) {
  const entry = frontierFor(frontier, lens);

  // No prior frontier: first run. Caller backfills the whole computed range.
  if (!entry) return { lens, kind: "initial", reanchorTo: null, orphaned: [], boundary: null };

  // Frontier still reachable: ordinary incremental walk from it.
  if (reachableMap[entry.commit]) {
    return { lens, kind: "walk", reanchorTo: entry.commit, orphaned: [], boundary: null };
  }

  // Frontier unreachable (history rewritten or squash-merged). Find the newest
  // lens-covered ledger commit that is still reachable and re-anchor to it.
  const lensShas = ledgerRecords.filter((record) => record.lens === lens).map((record) => record.commit);
  const newestReachable = [...lensShas].reverse().find((sha) => reachableMap[sha]);
  const orphaned = lensShas.filter((sha) => !reachableMap[sha]);

  if (newestReachable) {
    return { lens, kind: "reanchor", reanchorTo: newestReachable, orphaned, boundary: null };
  }

  // Nothing reachable: the whole covered span collapsed into a squash commit.
  // Record a single boundary row at HEAD that carries the lost SHAs forward.
  return { lens, kind: "collapse", reanchorTo: null, orphaned, boundary: headCommit || null };
}

// ---------------------------------------------------------------------------
// Churn / rework core (Part 3). Pure; consumes parsed commits.
// ---------------------------------------------------------------------------

const CONVENTIONAL_TYPE = /^(\w+)(\([^)]*\))?!?:/;

function commitType(subject) {
  const match = (subject || "").match(CONVENTIONAL_TYPE);
  return match ? match[1].toLowerCase() : "other";
}

function isRevert(commit) {
  return /^revert[\s:"]/i.test(commit.subject || "") || /this reverts commit/i.test(commit.body || "");
}

// Aggregate churn by "target" or "file". `commits` is oldest-first with
// { commit, abbrev, email, date, subject, files }.
function churnByUnit(commits, manifest, by = "target") {
  const units = new Map();

  const touch = (key, commit) => {
    if (!units.has(key)) {
      units.set(key, {
        unit: key,
        touches: 0,
        authors: new Set(),
        first_touch: commit.date || null,
        last_touch: commit.date || null,
        type_counts: {},
        reverts: 0,
      });
    }
    const unit = units.get(key);
    unit.touches += 1;
    if (commit.email) unit.authors.add(commit.email);
    if (commit.date) {
      if (!unit.first_touch || commit.date < unit.first_touch) unit.first_touch = commit.date;
      if (!unit.last_touch || commit.date > unit.last_touch) unit.last_touch = commit.date;
    }
    const type = commitType(commit.subject);
    unit.type_counts[type] = (unit.type_counts[type] || 0) + 1;
    if (isRevert(commit)) unit.reverts += 1;
  };

  for (const commit of commits) {
    if (by === "file") {
      for (const file of commit.files || []) touch(file, commit);
    } else {
      const { targets } = targetsForFiles(manifest, commit.files || []);
      for (const slug of targets) touch(slug, commit);
    }
  }

  return [...units.values()]
    .map((unit) => ({
      unit: unit.unit,
      touches: unit.touches,
      author_count: unit.authors.size,
      authors: [...unit.authors].sort((a, b) => a.localeCompare(b)),
      first_touch: unit.first_touch,
      last_touch: unit.last_touch,
      type_counts: unit.type_counts,
      reverts: unit.reverts,
      // Share of touches that are fixes or reverts — a cheap rework signal the
      // LLM interprets (high churn + high fix_ratio = candidate process gap).
      fix_ratio: unit.touches
        ? Number((((unit.type_counts.fix || 0) + unit.reverts) / unit.touches).toFixed(3))
        : 0,
    }))
    .sort((a, b) => b.touches - a.touches || a.unit.localeCompare(b.unit));
}

// ---------------------------------------------------------------------------
// git I/O boundary (thin wrappers; not unit-tested).
// ---------------------------------------------------------------------------

function git(repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 128,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

function gitOk(repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  return result.status === 0;
}

function isReachable(repoRoot, sha) {
  if (!sha) return false;
  return gitOk(repoRoot, ["merge-base", "--is-ancestor", sha, "HEAD"]);
}

function headCommitMeta(repoRoot) {
  const [commit] = logCommits(repoRoot, "-1");
  return commit || null;
}

const RS = "\x1e";
const US = "\x1f";

function parseLog(out) {
  const chunks = out
    .split(RS)
    .map((chunk) => chunk.replace(/^\n/, ""))
    .filter((chunk) => chunk.trim().length);

  return chunks.map((chunk) => {
    const newline = chunk.indexOf("\n");
    const header = newline === -1 ? chunk : chunk.slice(0, newline);
    const rest = newline === -1 ? "" : chunk.slice(newline + 1);
    const [commit, abbrev, tree, parents, author, email, date, subject] = header.split(US);
    const files = rest
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      commit,
      abbrev,
      tree,
      parents: (parents || "").split(" ").filter(Boolean),
      author,
      email,
      date,
      subject,
      files,
    };
  });
}

// Returns commits oldest-first. `range` may be a revision range, a single ref,
// or a git log limiter such as "-1". When absent, walks all history.
function logCommits(repoRoot, range) {
  const fmt = [`${RS}%H`, "%h", "%T", "%P", "%an", "%ae", "%aI", "%s"].join(US);
  const args = ["log", "--no-merges", "--reverse", `--pretty=format:${fmt}`, "--name-only"];
  if (range) args.push(range);
  const out = git(repoRoot, args);
  if (out === null) throw new Error(`git log failed for range: ${range || "(all history)"}`);
  return parseLog(out);
}

function withTargets(manifest, commits) {
  return commits.map((commit) => ({
    ...commit,
    targets: targetsForFiles(manifest, commit.files || []).targets,
  }));
}

// ---------------------------------------------------------------------------
// filesystem helpers
// ---------------------------------------------------------------------------

function resolve(repoRoot, relPath) {
  return path.isAbsolute(relPath) ? relPath : path.join(repoRoot, relPath);
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readManifest(repoRoot, manifestPath) {
  const abs = resolve(repoRoot, manifestPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`manifest not found: ${manifestPath} (run specops-decompose first)`);
  }
  return readJson(abs, null);
}

function readLedgerFile(repoRoot, ledgerPath) {
  const abs = resolve(repoRoot, ledgerPath);
  return parseLedger(fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "");
}

function readFrontierFile(repoRoot, frontierPath) {
  return readJson(resolve(repoRoot, frontierPath), {});
}

function writeFrontierFile(repoRoot, frontierPath, frontier) {
  const abs = resolve(repoRoot, frontierPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(frontier, null, 2) + "\n");
}

function appendLedgerRecords(repoRoot, ledgerPath, records) {
  const abs = resolve(repoRoot, ledgerPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Range planning: turn frontier + reachability into a concrete commit list.
// ---------------------------------------------------------------------------

function planAndCollect(repoRoot, manifest, ledger, frontier, lens, baseRef) {
  const entry = frontierFor(frontier, lens);
  const reachableMap = {};
  if (entry) reachableMap[entry.commit] = isReachable(repoRoot, entry.commit);

  // Cheap path: no frontier yet, or frontier still reachable.
  if (!entry || reachableMap[entry.commit]) {
    const plan = reconcilePlan({ lens, frontier, ledgerRecords: ledger, reachableMap, headCommit: null });
    const range = entry ? `${entry.commit}..HEAD` : baseRef ? `${baseRef}..HEAD` : undefined;
    const commits = uncoveredCommits(withTargets(manifest, logCommits(repoRoot, range)), ledger, lens);
    return { plan, range: range || "(all history)", commits };
  }

  // Frontier unreachable: probe lens-covered ledger SHAs newest-first.
  const lensShas = ledger.filter((record) => record.lens === lens).map((record) => record.commit);
  for (const sha of [...lensShas].reverse()) {
    if (!(sha in reachableMap)) reachableMap[sha] = isReachable(repoRoot, sha);
    if (reachableMap[sha]) break; // newest reachable found; no need to probe older
  }
  const headCommit = headCommitMeta(repoRoot);
  const plan = reconcilePlan({ lens, frontier, ledgerRecords: ledger, reachableMap, headCommit });

  if (plan.kind === "reanchor") {
    const commits = uncoveredCommits(
      withTargets(manifest, logCommits(repoRoot, `${plan.reanchorTo}..HEAD`)),
      ledger,
      lens
    );
    return { plan, range: `${plan.reanchorTo}..HEAD`, commits };
  }

  // collapse: granular history is gone; the boundary commit is the unit of work.
  const boundary = headCommit ? withTargets(manifest, [headCommit])[0] : null;
  return { plan, range: "(squash boundary)", commits: boundary ? [boundary] : [] };
}

function summarizeCommit(commit) {
  return {
    commit: commit.commit,
    abbrev: commit.abbrev,
    author: commit.author,
    email: commit.email,
    date: commit.date,
    subject: commit.subject,
    targets: commit.targets || [],
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInit(repoRoot, options) {
  const ledgerAbs = resolve(repoRoot, options.ledger);
  const frontierAbs = resolve(repoRoot, options.frontier);
  fs.mkdirSync(path.dirname(ledgerAbs), { recursive: true });
  if (!fs.existsSync(ledgerAbs)) fs.writeFileSync(ledgerAbs, "");
  if (!fs.existsSync(frontierAbs)) writeFrontierFile(repoRoot, options.frontier, {});
  return { ledger: options.ledger, frontier: options.frontier, created: true };
}

function cmdUncovered(repoRoot, options) {
  const manifest = readManifest(repoRoot, options.manifest);
  const ledger = readLedgerFile(repoRoot, options.ledger);
  const frontier = readFrontierFile(repoRoot, options.frontier);
  const { plan, range, commits } = planAndCollect(
    repoRoot,
    manifest,
    ledger,
    frontier,
    options.lens,
    options.base
  );
  return {
    lens: options.lens,
    frontier: frontierFor(frontier, options.lens),
    plan: plan.kind,
    reconcile_needed: plan.kind === "reanchor" || plan.kind === "collapse",
    orphaned: plan.orphaned,
    range,
    count: commits.length,
    commits: commits.map(summarizeCommit),
  };
}

function cmdRecord(repoRoot, options, now) {
  const manifest = readManifest(repoRoot, options.manifest);
  const ledger = readLedgerFile(repoRoot, options.ledger);
  const frontier = readFrontierFile(repoRoot, options.frontier);
  const { commits } = planAndCollect(repoRoot, manifest, ledger, frontier, options.lens, options.base);

  let selected = commits;
  if (options.commits.length) {
    const wanted = new Set(options.commits);
    selected = commits.filter((commit) => wanted.has(commit.commit) || wanted.has(commit.abbrev));
  } else if (!options.allUncovered) {
    throw new Error("record requires --commits <sha...> or --all-uncovered");
  }

  if (!selected.length) {
    return { lens: options.lens, recorded: 0, frontier: frontierFor(frontier, options.lens), note: "nothing to record" };
  }

  const records = selected.map((commit) => buildRecord(commit, options.lens, now));
  appendLedgerRecords(repoRoot, options.ledger, records);

  const newest = selected[selected.length - 1];
  const nextFrontier = advanceFrontier(frontier, options.lens, newest);
  writeFrontierFile(repoRoot, options.frontier, nextFrontier);

  return {
    lens: options.lens,
    recorded: records.length,
    commits: records.map((record) => record.abbrev),
    frontier: frontierFor(nextFrontier, options.lens),
  };
}

function cmdReconcile(repoRoot, options, now) {
  const ledger = readLedgerFile(repoRoot, options.ledger);
  const frontier = readFrontierFile(repoRoot, options.frontier);
  const lenses = options.lens ? [options.lens] : LENSES;
  const headCommit = headCommitMeta(repoRoot);
  const results = [];
  let nextFrontier = frontier;
  const newRecords = [];

  for (const lens of lenses) {
    const entry = frontierFor(frontier, lens);
    if (!entry) {
      results.push({ lens, kind: "initial", action: "no frontier; nothing to reconcile" });
      continue;
    }
    const reachableMap = { [entry.commit]: isReachable(repoRoot, entry.commit) };
    if (reachableMap[entry.commit]) {
      results.push({ lens, kind: "walk", action: "frontier reachable; healthy" });
      continue;
    }
    const lensShas = ledger.filter((record) => record.lens === lens).map((record) => record.commit);
    for (const sha of [...lensShas].reverse()) {
      reachableMap[sha] = isReachable(repoRoot, sha);
      if (reachableMap[sha]) break;
    }
    const plan = reconcilePlan({ lens, frontier: nextFrontier, ledgerRecords: ledger, reachableMap, headCommit });

    if (plan.kind === "reanchor") {
      const record = [...ledger].reverse().find((entry) => entry.lens === lens && entry.commit === plan.reanchorTo);
      nextFrontier = advanceFrontier(nextFrontier, lens, {
        commit: plan.reanchorTo,
        tree: record?.tree || null,
        date: record?.date || null,
      });
      results.push({
        lens,
        kind: "reanchor",
        action: `re-anchored frontier to reachable ${plan.reanchorTo.slice(0, 12)}`,
        orphaned: plan.orphaned.length,
      });
    } else if (plan.kind === "collapse" && headCommit) {
      const boundary = { ...headCommit, targets: [] };
      newRecords.push(buildRecord(boundary, lens, now, plan.orphaned));
      nextFrontier = advanceFrontier(nextFrontier, lens, headCommit);
      results.push({
        lens,
        kind: "collapse",
        action: `recorded squash boundary at HEAD; ${plan.orphaned.length} orphaned commits carried in collapsed_from`,
        granularity_lost: plan.orphaned.length,
      });
    }
  }

  if (newRecords.length) appendLedgerRecords(repoRoot, options.ledger, newRecords);
  if (nextFrontier !== frontier) writeFrontierFile(repoRoot, options.frontier, nextFrontier);

  return { results };
}

function cmdChurn(repoRoot, options) {
  const manifest = readManifest(repoRoot, options.manifest);
  const range = options.since ? `${options.since}..HEAD` : undefined;
  const commits = logCommits(repoRoot, range);
  const units = churnByUnit(commits, manifest, options.by);
  return {
    by: options.by,
    range: range || "(all history)",
    commit_count: commits.length,
    units,
  };
}

function cmdStatus(repoRoot, options) {
  const manifest = readManifest(repoRoot, options.manifest);
  const ledger = readLedgerFile(repoRoot, options.ledger);
  const frontier = readFrontierFile(repoRoot, options.frontier);
  const lenses = LENSES.map((lens) => {
    const entry = frontierFor(frontier, lens);
    const reachable = entry ? isReachable(repoRoot, entry.commit) : null;
    const { plan, commits } = planAndCollect(repoRoot, manifest, ledger, frontier, lens, null);
    return {
      lens,
      frontier: entry,
      frontier_reachable: reachable,
      covered: coveredShas(ledger, lens).size,
      uncovered: commits.length,
      plan: plan.kind,
      reconcile_needed: plan.kind === "reanchor" || plan.kind === "collapse",
    };
  });
  return { lenses };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const command = argv[2];
  const repoRoot = argv[3];
  const options = {
    manifest: DEFAULT_MANIFEST,
    ledger: DEFAULT_LEDGER,
    frontier: DEFAULT_FRONTIER,
    lens: "doc",
    base: null,
    since: null,
    by: "target",
    commits: [],
    allUncovered: false,
  };

  for (let i = 4; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manifest") options.manifest = argv[++i];
    else if (arg === "--ledger") options.ledger = argv[++i];
    else if (arg === "--frontier") options.frontier = argv[++i];
    else if (arg === "--lens") options.lens = argv[++i];
    else if (arg === "--base") options.base = argv[++i];
    else if (arg === "--since") options.since = argv[++i];
    else if (arg === "--by") options.by = argv[++i];
    else if (arg === "--all-uncovered") options.allUncovered = true;
    else if (arg === "--commits") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) options.commits.push(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { command, repoRoot, options };
}

function usage() {
  return [
    "usage:",
    "  node scripts/commit-ledger.mjs init <repo-root>",
    "  node scripts/commit-ledger.mjs uncovered <repo-root> --lens doc|intent|rework [--base <ref>]",
    "  node scripts/commit-ledger.mjs record <repo-root> --lens <lens> (--commits <sha...> | --all-uncovered)",
    "  node scripts/commit-ledger.mjs reconcile <repo-root> [--lens <lens>]",
    "  node scripts/commit-ledger.mjs churn <repo-root> [--since <ref>] [--by target|file]",
    "  node scripts/commit-ledger.mjs status <repo-root>",
  ].join("\n");
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exit(1);
  }

  const { command, repoRoot, options } = parsed;
  if (!command || !repoRoot) {
    console.error(usage());
    process.exit(1);
  }
  if (["uncovered", "record"].includes(command) && !isValidLens(options.lens)) {
    console.error(`invalid lens: ${options.lens} (expected one of ${LENSES.join(", ")})`);
    process.exit(1);
  }

  const resolvedRepo = path.resolve(repoRoot);
  const now = new Date().toISOString();

  try {
    let result;
    if (command === "init") result = cmdInit(resolvedRepo, options);
    else if (command === "uncovered") result = cmdUncovered(resolvedRepo, options);
    else if (command === "record") result = cmdRecord(resolvedRepo, options, now);
    else if (command === "reconcile") result = cmdReconcile(resolvedRepo, options, now);
    else if (command === "churn") result = cmdChurn(resolvedRepo, options);
    else if (command === "status") result = cmdStatus(resolvedRepo, options);
    else throw new Error(`unknown command: ${command}`);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

export {
  LENSES,
  matches,
  targetsForFile,
  targetsForFiles,
  isValidLens,
  parseLedger,
  serializeLedger,
  coveredShas,
  uncoveredCommits,
  buildRecord,
  frontierFor,
  frontierEntry,
  advanceFrontier,
  reconcilePlan,
  commitType,
  isRevert,
  churnByUnit,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
