import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  "coverage",
  "tmp",
  ".specs",
  "tests",
  "test",
  "__tests__",
  "__mocks__",
  "docs",
  ".github",
]);

const IGNORED_FILES = new Set([".DS_Store", ".gitkeep", ".keep"]);
const UNASSIGNED_SAMPLE_LIMIT = 50;
const UNASSIGNED_SAMPLE_PER_TOP_LEVEL = 3;

const SOURCE_ROOTS = ["src", "lib", "app", "packages", "services", "cmd"];
const SOURCE_ROOT_SET = new Set(SOURCE_ROOTS);

const SEMANTIC_CONTAINER_DIRS = new Set([
  "areas",
  "contexts",
  "domains",
  "features",
  "flows",
  "modules",
  "plugins",
  "routes",
  "slices",
  "subsystems",
  "workflows",
]);

const BOUNDARY_MARKER_FILES = new Set([
  "Cargo.toml",
  "Gemfile",
  "go.mod",
  "mix.exs",
  "package.json",
  "pom.xml",
  "pyproject.toml",
  "setup.py",
]);

const MAX_FRONTIER_DEPTH = 5;
const LARGE_UNIT_FILE_THRESHOLD = 40;
const LARGE_UNIT_CHILD_THRESHOLD = 3;

function isDir(p) {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

// ---------------------------------------------------------------------------
// File discovery (git-aware)
//
// The repository — not the raw filesystem — defines what is source. Prefer
// `git ls-files` so every .gitignore (including nested ones like demo/.gitignore)
// decides what is noise; the script's hardcoded ignore list can never keep pace
// with a repo's own declarations. Fall back to a filesystem walk when git is
// unavailable or the path is not its own work-tree root, so non-git callers and
// the test temp repos keep working. Either way IGNORED_DIRS / IGNORED_FILES still
// drop tests, docs, and build output, and the list is sorted for stable order.
// ---------------------------------------------------------------------------

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function gitFiles(repoRoot) {
  let topLevel;
  try {
    topLevel = execFileSync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  // Only trust git when repoRoot is the root of the work tree, so a non-git
  // directory nested inside some other repo is not partitioned with that repo's
  // ignore rules.
  if (!topLevel || !samePath(topLevel, repoRoot)) return null;
  try {
    const out = execFileSync(
      "git",
      ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 }
    );
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walkFilesystem(repoRoot) {
  const files = [];
  const recurse = (absDir, relDir) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        recurse(path.join(absDir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        files.push(relDir ? `${relDir}/${entry.name}` : entry.name);
      }
    }
  };
  recurse(repoRoot, "");
  return files;
}

function withinIgnoredDir(file) {
  return file.split("/").some((segment) => IGNORED_DIRS.has(segment));
}

function discoverFiles(repoRoot) {
  const raw = gitFiles(repoRoot) ?? walkFilesystem(repoRoot);
  return raw
    .filter((file) => !IGNORED_FILES.has(path.posix.basename(file)))
    .filter((file) => !withinIgnoredDir(file))
    .sort((a, b) => a.localeCompare(b));
}

function isGitMode(repoRoot) {
  return gitFiles(repoRoot) !== null;
}

// ---------------------------------------------------------------------------
// Directory structure, derived from the discovered file set (never readdir), so
// a git-ignored directory can never form a unit or a boundary.
// ---------------------------------------------------------------------------

function basename(relPath) {
  return relPath === "." ? "." : path.posix.basename(relPath);
}

function joinRel(parent, child) {
  return parent === "." ? child : `${parent}/${child}`;
}

function fileIsUnder(file, relDir) {
  return relDir === "." || file === relDir || file.startsWith(`${relDir}/`);
}

function filesUnder(files, relDir) {
  return files.filter((file) => fileIsUnder(file, relDir));
}

function dirExists(relDir, files) {
  if (relDir === ".") return files.length > 0;
  return files.some((file) => file.startsWith(`${relDir}/`));
}

function childDirNames(relDir, files) {
  const prefix = relDir === "." ? "" : `${relDir}/`;
  const names = new Set();
  for (const file of files) {
    if (prefix && !file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) continue; // a file directly in relDir, not a child directory
    names.add(rest.slice(0, slash));
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function hasBoundaryMarker(relDir, fileSet) {
  for (const marker of BOUNDARY_MARKER_FILES) {
    if (fileSet.has(joinRel(relDir, marker))) return true;
  }
  return false;
}

function childUnitStats(relDir, files, fileSet) {
  return childDirNames(relDir, files)
    .map((name) => {
      const relPath = joinRel(relDir, name);
      return {
        name,
        relPath,
        fileCount: filesUnder(files, relPath).length,
        hasBoundaryMarker: hasBoundaryMarker(relPath, fileSet),
      };
    })
    .filter((child) => child.fileCount > 0 || child.hasBoundaryMarker);
}

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

function slugify(p) {
  if (p === ".") return "root";
  const slug = p
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "root";
}

function uniqueSlug(structuralUnit, taken) {
  let base = slugify(structuralUnit);
  if (!taken.has(base)) return base;

  const segments = structuralUnit === "." ? [] : structuralUnit.split("/");
  let candidate = base;
  for (let i = segments.length - 2; i >= 0; i--) {
    candidate = `${slugify(segments[i])}-${candidate}`;
    if (!taken.has(candidate)) return candidate;
  }
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function workspaceGlobs(repoRoot) {
  const globs = [];
  const pkgPath = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    const ws = readJson(pkgPath).workspaces;
    if (Array.isArray(ws)) globs.push(...ws);
    else if (ws && Array.isArray(ws.packages)) globs.push(...ws.packages);
  }
  const pnpmPath = path.join(repoRoot, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmPath)) globs.push(...parsePnpmPackages(pnpmPath));
  return globs;
}

function parsePnpmPackages(pnpmPath) {
  const lines = fs.readFileSync(pnpmPath, "utf8").split("\n");
  const packages = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const item = line.match(/^\s+-\s+['"]?([^'"\n]+?)['"]?\s*$/);
    if (item) packages.push(item[1]);
    else if (line.trim() !== "") break;
  }
  return packages;
}

function resolveWorkspaceUnits(globs, files, fileSet) {
  const units = new Set();
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const parent = glob.slice(0, -2) || ".";
      for (const child of childDirNames(parent, files)) {
        const rel = joinRel(parent, child);
        if (fileSet.has(joinRel(rel, "package.json"))) units.add(rel);
      }
    } else if (!glob.includes("*")) {
      if (fileSet.has(joinRel(glob, "package.json"))) units.add(glob);
    }
  }
  return [...units];
}

function sourceRootsUnder(relDir, files) {
  return SOURCE_ROOTS.map((root) => joinRel(relDir, root)).filter((candidate) =>
    dirExists(candidate, files)
  );
}

function candidateFrontier(relDir, files, fileSet, { forceSplit = false, depth = 0 } = {}) {
  if (depth >= MAX_FRONTIER_DEPTH) return [relDir];

  const children = childUnitStats(relDir, files, fileSet);
  if (children.length === 0) return [relDir];

  const totalFiles = filesUnder(files, relDir).length;
  const childFiles = children.reduce((sum, child) => sum + child.fileCount, 0);
  const relBase = basename(relDir);
  const isSourceRoot = SOURCE_ROOT_SET.has(relBase);
  const isSemanticContainer = SEMANTIC_CONTAINER_DIRS.has(relBase);
  const hasBoundaryChildren = children.filter((child) => child.hasBoundaryMarker).length >= 2;
  const isLargeUnit =
    totalFiles >= LARGE_UNIT_FILE_THRESHOLD &&
    children.length >= LARGE_UNIT_CHILD_THRESHOLD &&
    childFiles >= Math.floor(totalFiles * 0.7);

  const shouldSplit =
    forceSplit || isSourceRoot || isSemanticContainer || hasBoundaryChildren || isLargeUnit;

  if (!shouldSplit) return [relDir];

  return children.flatMap((child) =>
    candidateFrontier(child.relPath, files, fileSet, { forceSplit: false, depth: depth + 1 })
  );
}

function semanticContainerFrontiers(relDir, files, fileSet) {
  const frontiers = [];
  const stack = [{ relDir, depth: 0 }];
  const seen = new Set();

  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current.relDir) || current.depth > 3) continue;
    seen.add(current.relDir);

    if (SEMANTIC_CONTAINER_DIRS.has(basename(current.relDir))) {
      const units = candidateFrontier(current.relDir, files, fileSet, { forceSplit: true });
      if (units.length >= 2) frontiers.push(units);
      continue;
    }

    for (const child of childUnitStats(current.relDir, files, fileSet)) {
      stack.push({ relDir: child.relPath, depth: current.depth + 1 });
    }
  }

  return frontiers;
}

function refineWorkspaceUnit(unit, files, fileSet) {
  const semanticFrontiers = semanticContainerFrontiers(unit, files, fileSet);
  if (semanticFrontiers.length) {
    return [...new Set(semanticFrontiers.flat())].sort((a, b) => a.localeCompare(b));
  }

  const internalSourceRoots = sourceRootsUnder(unit, files);
  const sourceRootUnits = internalSourceRoots.flatMap((root) =>
    candidateFrontier(root, files, fileSet, { forceSplit: true })
  );
  const unitFileCount = filesUnder(files, unit).length;
  if (
    sourceRootUnits.length >= LARGE_UNIT_CHILD_THRESHOLD &&
    unitFileCount >= LARGE_UNIT_FILE_THRESHOLD
  ) {
    return sourceRootUnits;
  }

  return [unit];
}

function detectUnits(repoRoot) {
  const files = discoverFiles(repoRoot);
  const fileSet = new Set(files);
  const wsUnits = resolveWorkspaceUnits(workspaceGlobs(repoRoot), files, fileSet);
  if (wsUnits.length) {
    return {
      units: wsUnits.flatMap((unit) => refineWorkspaceUnit(unit, files, fileSet)),
      lowConfidence: false,
      files,
      fileSet,
    };
  }

  const sourceRootUnits = [];
  for (const root of SOURCE_ROOTS) {
    if (dirExists(root, files)) {
      sourceRootUnits.push(...candidateFrontier(root, files, fileSet, { forceSplit: true }));
    }
  }
  if (sourceRootUnits.length) return { units: sourceRootUnits, lowConfidence: false, files, fileSet };

  const topLevel = childUnitStats(".", files, fileSet).map((child) => child.relPath);
  if (topLevel.length) return { units: topLevel, lowConfidence: true, files, fileSet };

  return { units: ["."], lowConfidence: true, files, fileSet };
}

function buildTargets(unitPaths) {
  const sorted = [...unitPaths].sort((a, b) => a.localeCompare(b));
  const taken = new Set();
  return sorted.map((unit) => {
    const slug = uniqueSlug(unit, taken);
    taken.add(slug);
    return {
      slug,
      name: "",
      scope: "",
      origin: "derived",
      structural_unit: unit,
      source_globs: unit === "." ? ["**"] : [`${unit}/**`],
      tier2_path: `docs/specops/analysis/${slug}.md`,
      agent_path: `docs/specops/agents/${slug}.md`,
      source_hash: null,
      last_synthesized: null,
    };
  });
}

function overrideTarget(slug, structuralUnit, sourceGlobs) {
  return {
    slug,
    name: "",
    scope: "",
    origin: "override",
    structural_unit: structuralUnit,
    source_globs: sourceGlobs,
    tier2_path: `docs/specops/analysis/${slug}.md`,
    agent_path: `docs/specops/agents/${slug}.md`,
    source_hash: null,
    last_synthesized: null,
  };
}

// Guarantee every walked source file has an owner. Files sitting directly in a
// directory that the partition split into child units (or directly in the repo
// root) are owned by no `dir/**` target. Group every such orphan by its
// immediate parent directory and emit one shallow `dir/*` remainder target per
// parent, so loose top-level files in an under-organized repo are analyzed
// rather than silently dropped into coverage.unassigned. Excluded files are
// skipped so an `exclude` override is never re-captured by a remainder.
function appendRemainders(files, targets, excluded) {
  const parents = new Set();
  for (const file of files) {
    if (isExcluded(file, excluded)) continue;
    if (targets.some((t) => t.source_globs.some((g) => matches(file, g)))) continue;
    const slash = file.lastIndexOf("/");
    parents.add(slash === -1 ? "." : file.slice(0, slash));
  }

  const taken = new Set(targets.map((t) => t.slug));
  for (const parent of [...parents].sort((a, b) => a.localeCompare(b))) {
    const slug = uniqueSlug(parent, taken);
    taken.add(slug);
    targets.push({
      slug,
      name: "",
      scope: "",
      origin: "remainder",
      structural_unit: parent,
      source_globs: [parent === "." ? "*" : `${parent}/*`],
      tier2_path: `docs/specops/analysis/${slug}.md`,
      agent_path: `docs/specops/agents/${slug}.md`,
      source_hash: null,
      last_synthesized: null,
    });
  }
}

function findUnit(targets, unitPath, op) {
  const target = targets.find((t) => t.structural_unit === unitPath);
  if (!target) throw new Error(`override ${op} references unknown unit: ${unitPath}`);
  return target;
}

function applyMerge(targets, override) {
  const members = override.units.map((unit) => findUnit(targets, unit, "merge"));
  const memberSet = new Set(members);
  const union = [...new Set(members.flatMap((t) => t.source_globs))].sort((a, b) => a.localeCompare(b));
  const remaining = targets.filter((t) => !memberSet.has(t));
  return [...remaining, overrideTarget(override.into, override.into, union)];
}

function applySplit(targets, override) {
  const parent = findUnit(targets, override.unit, "split");
  const children = override.into.map((child) =>
    overrideTarget(child.slug, child.subpath, [`${child.subpath}/**`])
  );
  const remaining = targets.filter((t) => t !== parent);
  return [...remaining, ...children];
}

function applyRelabel(targets, override) {
  const target = findUnit(targets, override.unit, "relabel");
  target.name = override.name;
  target.scope = override.scope;
  target.origin = "override";
  return targets;
}

// Inverse of split: fold an over-split directory subtree into one target. Every
// target whose structural_unit is `unit` or sits under it is replaced by a
// single override target with a clean `unit/**` glob. This is the primary cure
// for the deterministic core over-splitting a loosely-organized subtree (e.g. a
// demo/config tree) into one bucket per directory.
function applyCollapse(targets, override) {
  const unit = override.unit;
  if (!isNonEmptyString(unit)) throw new Error("override collapse requires a unit path");
  const under = (t) => t.structural_unit === unit || t.structural_unit.startsWith(`${unit}/`);
  const remaining = targets.filter((t) => !under(t));
  if (remaining.length === targets.length) {
    throw new Error(`override collapse references unknown unit: ${unit}`);
  }
  const glob = unit === "." ? "**" : `${unit}/**`;
  return [...remaining, overrideTarget(override.into, unit, [glob])];
}

// Project an exclude override's unit paths and/or raw globs to supported glob
// shapes. An exclude removes its files from analysis entirely: no target owns
// them, no remainder re-captures them, and coverage reports them under
// `excluded` (with the reason) rather than `unassigned`.
function unitGlob(unitPath) {
  if (unitPath === "." || unitPath === "" || unitPath === "**" || unitPath === "*") return "**";
  if (unitPath.endsWith("/**") || unitPath.endsWith("/*")) return unitPath;
  return `${unitPath}/**`;
}

function normalizeExclude(override) {
  const reason =
    typeof override.reason === "string" && override.reason !== ""
      ? override.reason
      : "excluded by override";
  const raw = [];
  if (Array.isArray(override.units)) raw.push(...override.units);
  if (Array.isArray(override.globs)) raw.push(...override.globs);
  if (raw.length === 0) throw new Error('exclude override requires "units" or "globs"');
  const rules = raw.map((u) => ({ glob: unitGlob(u), reason }));
  for (const rule of rules) {
    if (rule.glob === "**") {
      throw new Error('exclude override cannot target the entire repository ("." or "**")');
    }
  }
  return rules;
}

function globSubsumedBy(targetGlob, exGlob) {
  const exBase = globBase(exGlob);
  if (exBase === "") return true;
  const targetBase = globBase(targetGlob);
  return targetBase === exBase || targetBase.startsWith(`${exBase}/`);
}

function applyExclude(targets, rules) {
  return targets.filter(
    (t) => !t.source_globs.every((g) => rules.some((rule) => globSubsumedBy(g, rule.glob)))
  );
}

function isExcluded(file, excluded) {
  return excluded.some((rule) => matches(file, rule.glob));
}

// Overrides apply in two phases around remainder gap-closure, because they need
// different views of the target set:
//
//   pre-remainder  (exclude, split): operate on derived units. `split` exposes
//     loose files in the split parent that the remainder pass must then catch;
//     `exclude` records globs so the remainder pass skips excluded files. Both
//     must run before remainders exist.
//   post-remainder (collapse, merge, relabel): regroup the full target set,
//     including the loose-file remainder buckets — which is the whole point of
//     curating an under-organized repo. These cannot run until remainders exist.
//
// Relative order within each phase follows the overrides array.
function applyPreRemainderOverrides(targets, overrides) {
  let current = targets;
  const excluded = [];
  for (const override of overrides) {
    if (override.op === "exclude") {
      const rules = normalizeExclude(override);
      excluded.push(...rules);
      current = applyExclude(current, rules);
    } else if (override.op === "split") {
      current = applySplit(current, override);
    }
  }
  return { targets: current, excluded };
}

function applyPostRemainderOverrides(targets, overrides) {
  let current = targets;
  for (const override of overrides) {
    if (override.op === "merge") current = applyMerge(current, override);
    else if (override.op === "collapse") current = applyCollapse(current, override);
    else if (override.op === "relabel") current = applyRelabel(current, override);
    else if (override.op !== "exclude" && override.op !== "split") {
      throw new Error(`override op unknown: ${override.op}`);
    }
  }
  return current;
}

function detectRenames(freshTargets, manifest) {
  const priorSlugs = new Set(manifest.targets.map((t) => t.slug));
  const freshSlugs = new Set(freshTargets.map((t) => t.slug));
  const newTargets = [...freshTargets]
    .filter((t) => !priorSlugs.has(t.slug))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const consumed = new Set();

  const renames = [];
  for (const prior of manifest.targets) {
    if (freshSlugs.has(prior.slug)) continue;
    const match = newTargets.find((t) => !consumed.has(t.slug) && t.source_hash === prior.source_hash);
    if (!match) continue;
    consumed.add(match.slug);
    renames.push({ old_slug: prior.slug, new_slug: match.slug });
  }
  return renames;
}

function computeCoverage(files, targets, lowConfidence, excluded) {
  const unassigned = [];
  const overlaps = [];
  const excludedFiles = [];
  for (const file of files) {
    const exRule = excluded.find((rule) => matches(file, rule.glob));
    if (exRule) {
      excludedFiles.push({ file, reason: exRule.reason });
      continue;
    }
    const owners = targets.filter((t) => t.source_globs.some((g) => matches(file, g)));
    if (owners.length === 0) unassigned.push(file);
    else if (owners.length > 1) overlaps.push({ path: file, slugs: owners.map((t) => t.slug) });
  }
  unassigned.sort((a, b) => a.localeCompare(b));
  return {
    unassigned: summarizeUnassigned(unassigned),
    overlaps,
    excluded: summarizeExcluded(excludedFiles),
    low_confidence: lowConfidence,
  };
}

function summarizeUnassigned(unassigned) {
  const byTopLevel = new Map();
  const samplesByTopLevel = new Map();

  for (const file of unassigned) {
    const [topLevel] = file.split("/");
    byTopLevel.set(topLevel, (byTopLevel.get(topLevel) ?? 0) + 1);

    const samples = samplesByTopLevel.get(topLevel) ?? [];
    if (samples.length < UNASSIGNED_SAMPLE_PER_TOP_LEVEL) {
      samples.push(file);
      samplesByTopLevel.set(topLevel, samples);
    }
  }

  const topLevelSummary = [...byTopLevel.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

  const sample = topLevelSummary
    .flatMap(({ path }) => samplesByTopLevel.get(path) ?? [])
    .slice(0, UNASSIGNED_SAMPLE_LIMIT);

  return {
    count: unassigned.length,
    by_top_level: topLevelSummary,
    sample,
    truncated: unassigned.length > UNASSIGNED_SAMPLE_LIMIT,
  };
}

function summarizeExcluded(excludedFiles) {
  const sortedFiles = excludedFiles.map((entry) => entry.file).sort((a, b) => a.localeCompare(b));
  const byReason = new Map();
  for (const { reason } of excludedFiles) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  const reasons = [...byReason.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const base = summarizeUnassigned(sortedFiles);
  return {
    count: base.count,
    reasons,
    by_top_level: base.by_top_level,
    sample: base.sample,
    truncated: base.truncated,
  };
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function globBase(glob) {
  if (glob === "**" || glob === "*") return "";
  return glob.replace(/\/\*\*?$/, "");
}

function unitRelative(file, globs) {
  for (const glob of globs) {
    if (!matches(file, glob)) continue;
    const base = globBase(glob);
    return base === "" ? file : file.slice(base.length + 1);
  }
  return file;
}

export function sourceHash(repoRoot, globs, files = discoverFiles(repoRoot)) {
  const entries = files
    .filter((file) => globs.some((g) => matches(file, g)))
    .map((file) => `${unitRelative(file, globs)}\0${sha256(fs.readFileSync(path.join(repoRoot, file)))}`)
    .sort((a, b) => a.localeCompare(b));
  return "sha256:" + sha256(entries.join("\n"));
}

function reconcile(targets, manifest) {
  const prior = new Map(manifest.targets.map((t) => [t.slug, t]));
  for (const target of targets) {
    const carry = prior.get(target.slug);
    if (!carry) continue;
    target.name = carry.name;
    target.scope = carry.scope;
    target.last_synthesized = carry.last_synthesized;
  }
}

export function derive(repoRoot, { manifest } = {}) {
  if (!repoRoot) throw new Error("repoRoot is required");
  if (!isDir(repoRoot)) throw new Error(`not a directory: ${repoRoot}`);

  const { units, lowConfidence, files } = detectUnits(repoRoot);
  const overrides = manifest?.overrides ?? [];
  const { targets, excluded } = applyPreRemainderOverrides(buildTargets(units), overrides);
  appendRemainders(files, targets, excluded);
  const grouped = applyPostRemainderOverrides(targets, overrides);
  for (const target of grouped) {
    target.source_hash = sourceHash(repoRoot, target.source_globs, files);
  }
  if (manifest) reconcile(grouped, manifest);
  const renames = manifest ? detectRenames(grouped, manifest) : [];
  const coverage = computeCoverage(files, grouped, lowConfidence, excluded);

  return {
    version: 1,
    system: { summary: "", external_dependencies: [] },
    targets: grouped,
    overrides,
    renames,
    coverage,
  };
}

// ---------------------------------------------------------------------------
// Frontier fingerprints — compact, deterministic evidence for the LLM curate
// stage so it can classify role, group, and exclude without reading every file.
// ---------------------------------------------------------------------------

const CODE_EXTS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".rb",
  ".java", ".kt", ".cs", ".php", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".m", ".scala", ".clj", ".ex", ".exs", ".vue", ".svelte", ".sh",
]);
const DATA_EXTS = new Set([
  ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml", ".csv", ".tsv",
  ".xml", ".log", ".lock", ".pid", ".sqlite", ".db", ".parquet",
]);
const DOC_EXTS = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);

const RUNTIME_OUTPUT_RE =
  /(^|\/)(logs?|artifacts?|cache|caches|coverage|recordings?|cassettes?|snapshots?|__snapshots__|fixtures?|output|outputs)(\/|$)/i;
const DEMO_RE = /(^|\/)(demo|demos|example|examples|samples?|sandbox)(\/|$)/i;

function classifyLooksLike(owned, codeN, dataN, docN) {
  if (owned.length === 0) return "empty";
  const total = owned.length;
  if (codeN / total >= 0.6) return "code";
  if (docN / total >= 0.6) return "docs";
  if (dataN / total >= 0.6) return "data";
  return "mixed";
}

function suggestDisposition(unit, owned, codeN, looksLike) {
  const signals = [];
  if (owned.some((f) => RUNTIME_OUTPUT_RE.test(f)) || /(^|\/)runs\.jsonl$/.test(unit + "/")) {
    signals.push("runtime-output");
  }
  if (owned.some((f) => /\.(log|pid)$/.test(f))) signals.push("logs-or-pids");
  if (owned.length > 0 && codeN === 0) signals.push("no-code");
  if (unit.split("/").some((s) => s.startsWith("."))) signals.push("dotfile-config");
  if (looksLike === "docs") signals.push("docs");
  if (looksLike === "data") signals.push("data");
  if (owned.length > 0 && owned.length <= 2) signals.push("tiny");
  if (DEMO_RE.test(unit + "/")) signals.push("example-or-demo");

  let suggested = "analyze";
  if (signals.includes("runtime-output") || signals.includes("logs-or-pids")) suggested = "exclude";
  else if (
    signals.includes("dotfile-config") ||
    signals.includes("docs") ||
    (signals.includes("no-code") && signals.includes("data"))
  ) {
    suggested = "summarize";
  }
  return { suggested_disposition: suggested, signals };
}

function fingerprintTarget(target, repoRoot, files) {
  const owned = files.filter((f) => target.source_globs.some((g) => matches(f, g)));
  const extensions = {};
  let totalBytes = 0;
  let codeN = 0;
  let dataN = 0;
  let docN = 0;
  for (const f of owned) {
    const ext = path.posix.extname(f).toLowerCase() || "(none)";
    extensions[ext] = (extensions[ext] ?? 0) + 1;
    if (CODE_EXTS.has(ext)) codeN++;
    else if (DATA_EXTS.has(ext)) dataN++;
    else if (DOC_EXTS.has(ext)) docN++;
    try {
      totalBytes += fs.statSync(path.join(repoRoot, f)).size;
    } catch {
      // unreadable / vanished file contributes no bytes
    }
  }
  const looks_like = classifyLooksLike(owned, codeN, dataN, docN);
  const { suggested_disposition, signals } = suggestDisposition(
    target.structural_unit,
    owned,
    codeN,
    looks_like
  );
  return {
    slug: target.slug,
    structural_unit: target.structural_unit,
    origin: target.origin,
    source_globs: target.source_globs,
    file_count: owned.length,
    total_bytes: totalBytes,
    extensions,
    sample_files: owned.slice(0, 8),
    looks_like,
    suggested_disposition,
    signals,
  };
}

export function frontier(repoRoot, { manifest } = {}) {
  if (!repoRoot) throw new Error("repoRoot is required");
  if (!isDir(repoRoot)) throw new Error(`not a directory: ${repoRoot}`);
  const files = discoverFiles(repoRoot);
  const fileSet = new Set(files);
  const result = derive(repoRoot, { manifest });
  const units = result.targets.map((target) => fingerprintTarget(target, repoRoot, files));
  const topLevel = childUnitStats(".", files, fileSet).map((child) => ({
    path: child.relPath,
    file_count: child.fileCount,
  }));
  return {
    repo_root: repoRoot,
    git_mode: isGitMode(repoRoot),
    file_count: files.length,
    units,
    top_level: topLevel,
    coverage: result.coverage,
  };
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value !== "";
}

const TARGET_FIELD_SPECS = [
  { field: "slug", type: "non-empty string", ok: isNonEmptyString },
  { field: "name", type: "string", ok: (v) => typeof v === "string" },
  { field: "scope", type: "string", ok: (v) => typeof v === "string" },
  {
    field: "origin",
    type: '"derived", "override", or "remainder"',
    ok: (v) => v === "derived" || v === "override" || v === "remainder",
  },
  { field: "structural_unit", type: "non-empty string", ok: isNonEmptyString },
  {
    field: "source_globs",
    type: "non-empty array of strings",
    ok: (v) => Array.isArray(v) && v.length >= 1 && v.every((g) => typeof g === "string"),
  },
  { field: "tier2_path", type: "string", ok: (v) => typeof v === "string" },
  { field: "agent_path", type: "string", ok: (v) => typeof v === "string" },
  { field: "source_hash", type: "string or null", ok: (v) => v === null || typeof v === "string" },
  { field: "last_synthesized", type: "string or null", ok: (v) => v === null || typeof v === "string" },
];

function validateSchema(manifest, violations) {
  if (typeof manifest.version !== "number") violations.push("version must be a number");
  if (!isObject(manifest.system)) violations.push("system must be an object");
  if (!Array.isArray(manifest.targets)) violations.push("targets must be an array");
  if (!Array.isArray(manifest.overrides)) violations.push("overrides must be an array");
  if (!Array.isArray(manifest.renames)) violations.push("renames must be an array");
  if (!isObject(manifest.coverage)) violations.push("coverage is required");

  if (!Array.isArray(manifest.targets)) return;

  manifest.targets.forEach((target, i) => {
    const label = isNonEmptyString(target?.slug) ? `slug ${target.slug}` : `target[${i}]`;
    for (const spec of TARGET_FIELD_SPECS) {
      if (!spec.ok(target?.[spec.field])) {
        violations.push(`${label} ${spec.field} must be ${spec.type}`);
      }
    }
  });

  const seen = new Set();
  const duplicates = new Set();
  for (const target of manifest.targets) {
    if (!isNonEmptyString(target?.slug)) continue;
    if (seen.has(target.slug)) duplicates.add(target.slug);
    seen.add(target.slug);
  }
  for (const slug of duplicates) violations.push(`duplicate slug: ${slug}`);
}

function validateGlobsResolve(repoRoot, manifest, violations) {
  if (!Array.isArray(manifest.targets)) return;
  const files = discoverFiles(repoRoot);
  for (const target of manifest.targets) {
    if (!Array.isArray(target?.source_globs)) continue;
    const slug = isNonEmptyString(target.slug) ? target.slug : "?";
    for (const glob of target.source_globs) {
      if (typeof glob !== "string") continue;
      let resolved;
      try {
        resolved = files.some((file) => matches(file, glob));
      } catch {
        violations.push(`unsupported glob: ${glob} (slug ${slug})`);
        continue;
      }
      if (!resolved) violations.push(`glob resolves to no files: ${glob} (slug ${slug})`);
    }
  }
}

function validateMembership(repoRoot, manifest, violations) {
  if (!Array.isArray(manifest.targets)) return;
  let fresh;
  try {
    fresh = derive(repoRoot, { manifest });
  } catch (err) {
    violations.push(`derivation failed: ${err.message}`);
    return;
  }
  const freshBySlug = new Map(fresh.targets.map((t) => [t.slug, t]));
  for (const target of manifest.targets) {
    const derived = freshBySlug.get(target?.slug);
    if (!derived) continue;
    if (target.structural_unit !== derived.structural_unit) {
      violations.push(
        `structural_unit mismatch for ${target.slug}: manifest=${target.structural_unit} derived=${derived.structural_unit}`
      );
    }
    if (JSON.stringify(target.source_globs) !== JSON.stringify(derived.source_globs)) {
      violations.push(
        `source_globs mismatch for ${target.slug}: manifest=${JSON.stringify(target.source_globs)} derived=${JSON.stringify(derived.source_globs)}`
      );
    }
  }
}

export function check(repoRoot, manifestPath) {
  if (!repoRoot) throw new Error("repoRoot is required");
  if (!isDir(repoRoot)) throw new Error(`not a directory: ${repoRoot}`);

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (err) {
    throw new Error(`cannot read manifest ${manifestPath}: ${err.message}`);
  }

  const violations = [];
  validateSchema(manifest, violations);
  validateGlobsResolve(repoRoot, manifest, violations);
  validateMembership(repoRoot, manifest, violations);

  return { ok: violations.length === 0, violations };
}

function parseArgs(argv) {
  const args = { repoRoot: argv[2], manifestPath: null, checkPath: null, frontier: false };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--manifest") {
      args.manifestPath = argv[++i];
      if (!args.manifestPath) throw new Error("--manifest requires a path");
    } else if (argv[i] === "--check") {
      args.checkPath = argv[++i];
      if (!args.checkPath) throw new Error("--check requires a path");
    } else if (argv[i] === "--frontier") {
      args.frontier = true;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function loadManifest(manifestPath) {
  if (!manifestPath) return undefined;
  if (!fs.existsSync(manifestPath)) {
    console.error(`manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  return readJson(manifestPath);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (!args.repoRoot) {
    console.error(
      "usage: node scripts/decompose-skeleton.mjs <repo-root> [--manifest <path>] [--frontier] | --check <path>"
    );
    process.exit(1);
  }

  if (args.checkPath) {
    let result;
    try {
      result = check(path.resolve(args.repoRoot), args.checkPath);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    for (const violation of result.violations) console.error(violation);
    process.exit(result.ok ? 0 : 1);
  }

  const manifest = loadManifest(args.manifestPath);

  if (args.frontier) {
    let out;
    try {
      out = frontier(path.resolve(args.repoRoot), { manifest });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const result = derive(path.resolve(args.repoRoot), { manifest });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
