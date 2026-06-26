import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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

const IGNORED_FILES = new Set([".DS_Store"]);
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

function childDirs(dir) {
  if (!isDir(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

function basename(relPath) {
  return relPath === "." ? "." : path.posix.basename(relPath);
}

function joinRel(parent, child) {
  return parent === "." ? child : `${parent}/${child}`;
}

function hasBoundaryMarker(repoRoot, relDir) {
  const absDir = path.join(repoRoot, relDir);
  for (const marker of BOUNDARY_MARKER_FILES) {
    if (fs.existsSync(path.join(absDir, marker))) return true;
  }
  return false;
}

function walkSourceFiles(repoRoot) {
  const files = [];
  const recurse = (absDir, relDir) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        recurse(path.join(absDir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        if (IGNORED_FILES.has(entry.name)) continue;
        files.push(relDir ? `${relDir}/${entry.name}` : entry.name);
      }
    }
  };
  recurse(repoRoot, "");
  return files;
}

function fileIsUnder(file, relDir) {
  return relDir === "." || file === relDir || file.startsWith(`${relDir}/`);
}

function filesUnder(files, relDir) {
  return files.filter((file) => fileIsUnder(file, relDir));
}

function childUnitStats(repoRoot, relDir, files) {
  return childDirs(path.join(repoRoot, relDir))
    .map((name) => {
      const relPath = joinRel(relDir, name);
      return {
        name,
        relPath,
        fileCount: filesUnder(files, relPath).length,
        hasBoundaryMarker: hasBoundaryMarker(repoRoot, relPath),
      };
    })
    .filter((child) => child.fileCount > 0 || child.hasBoundaryMarker);
}

function matches(relPath, glob) {
  if (glob === "**") return true;
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return relPath === prefix || relPath.startsWith(`${prefix}/`);
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

function resolveWorkspaceUnits(repoRoot, globs) {
  const units = new Set();
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const parent = glob.slice(0, -2);
      for (const child of childDirs(path.join(repoRoot, parent))) {
        const rel = parent ? `${parent}/${child}` : child;
        if (fs.existsSync(path.join(repoRoot, rel, "package.json"))) units.add(rel);
      }
    } else if (!glob.includes("*")) {
      if (fs.existsSync(path.join(repoRoot, glob, "package.json"))) units.add(glob);
    }
  }
  return [...units];
}

function sourceRootsUnder(repoRoot, relDir) {
  return SOURCE_ROOTS.map((root) => joinRel(relDir, root)).filter((candidate) =>
    isDir(path.join(repoRoot, candidate))
  );
}

function candidateFrontier(repoRoot, relDir, files, { forceSplit = false, depth = 0 } = {}) {
  if (depth >= MAX_FRONTIER_DEPTH) return [relDir];

  const children = childUnitStats(repoRoot, relDir, files);
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
    candidateFrontier(repoRoot, child.relPath, files, { forceSplit: false, depth: depth + 1 })
  );
}

function semanticContainerFrontiers(repoRoot, relDir, files) {
  const frontiers = [];
  const stack = [{ relDir, depth: 0 }];
  const seen = new Set();

  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current.relDir) || current.depth > 3) continue;
    seen.add(current.relDir);

    if (SEMANTIC_CONTAINER_DIRS.has(basename(current.relDir))) {
      const units = candidateFrontier(repoRoot, current.relDir, files, { forceSplit: true });
      if (units.length >= 2) frontiers.push(units);
      continue;
    }

    for (const child of childUnitStats(repoRoot, current.relDir, files)) {
      stack.push({ relDir: child.relPath, depth: current.depth + 1 });
    }
  }

  return frontiers;
}

function refineWorkspaceUnit(repoRoot, unit, files) {
  const semanticFrontiers = semanticContainerFrontiers(repoRoot, unit, files);
  if (semanticFrontiers.length) {
    return [...new Set(semanticFrontiers.flat())].sort((a, b) => a.localeCompare(b));
  }

  const internalSourceRoots = sourceRootsUnder(repoRoot, unit);
  const sourceRootUnits = internalSourceRoots.flatMap((root) =>
    candidateFrontier(repoRoot, root, files, { forceSplit: true })
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
  const files = walkSourceFiles(repoRoot);
  const wsUnits = resolveWorkspaceUnits(repoRoot, workspaceGlobs(repoRoot));
  if (wsUnits.length) {
    return {
      units: wsUnits.flatMap((unit) => refineWorkspaceUnit(repoRoot, unit, files)),
      lowConfidence: false,
    };
  }

  const sourceRootUnits = [];
  for (const root of SOURCE_ROOTS) {
    if (isDir(path.join(repoRoot, root))) {
      sourceRootUnits.push(...candidateFrontier(repoRoot, root, files, { forceSplit: true }));
    }
  }
  if (sourceRootUnits.length) return { units: sourceRootUnits, lowConfidence: false };

  const topLevel = childUnitStats(repoRoot, ".", files).map((child) => child.relPath);
  if (topLevel.length) return { units: topLevel, lowConfidence: true };

  return { units: ["."], lowConfidence: true };
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
    source_hash: null,
    last_synthesized: null,
  };
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

function applyOverrides(targets, overrides) {
  let current = targets;
  for (const override of overrides) {
    if (override.op === "merge") current = applyMerge(current, override);
    else if (override.op === "split") current = applySplit(current, override);
    else if (override.op === "relabel") current = applyRelabel(current, override);
    else throw new Error(`override op unknown: ${override.op}`);
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

function computeCoverage(repoRoot, targets, lowConfidence) {
  const unassigned = [];
  const overlaps = [];
  for (const file of walkSourceFiles(repoRoot)) {
    const owners = targets.filter((t) => t.source_globs.some((g) => matches(file, g)));
    if (owners.length === 0) unassigned.push(file);
    else if (owners.length > 1) overlaps.push({ path: file, slugs: owners.map((t) => t.slug) });
  }
  unassigned.sort((a, b) => a.localeCompare(b));
  return {
    unassigned: summarizeUnassigned(unassigned),
    overlaps,
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

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function globBase(glob) {
  return glob === "**" ? "" : glob.replace(/\/\*\*$/, "");
}

function unitRelative(file, globs) {
  for (const glob of globs) {
    if (!matches(file, glob)) continue;
    const base = globBase(glob);
    return base === "" ? file : file.slice(base.length + 1);
  }
  return file;
}

export function sourceHash(repoRoot, globs) {
  const entries = walkSourceFiles(repoRoot)
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

  const { units, lowConfidence } = detectUnits(repoRoot);
  const overrides = manifest?.overrides ?? [];
  const targets = applyOverrides(buildTargets(units), overrides);
  for (const target of targets) {
    target.source_hash = sourceHash(repoRoot, target.source_globs);
  }
  if (manifest) reconcile(targets, manifest);
  const renames = manifest ? detectRenames(targets, manifest) : [];
  const coverage = computeCoverage(repoRoot, targets, lowConfidence);

  return {
    version: 1,
    system: { summary: "", external_dependencies: [] },
    targets,
    overrides,
    renames,
    coverage,
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
  { field: "origin", type: '"derived" or "override"', ok: (v) => v === "derived" || v === "override" },
  { field: "structural_unit", type: "non-empty string", ok: isNonEmptyString },
  {
    field: "source_globs",
    type: "non-empty array of strings",
    ok: (v) => Array.isArray(v) && v.length >= 1 && v.every((g) => typeof g === "string"),
  },
  { field: "tier2_path", type: "string", ok: (v) => typeof v === "string" },
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
  const files = walkSourceFiles(repoRoot);
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
  const args = { repoRoot: argv[2], manifestPath: null, checkPath: null };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--manifest") {
      args.manifestPath = argv[++i];
      if (!args.manifestPath) throw new Error("--manifest requires a path");
    } else if (argv[i] === "--check") {
      args.checkPath = argv[++i];
      if (!args.checkPath) throw new Error("--check requires a path");
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
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
      "usage: node scripts/decompose-skeleton.mjs <repo-root> [--manifest <path>] | --check <path>"
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

  let manifest;
  if (args.manifestPath) {
    if (!fs.existsSync(args.manifestPath)) {
      console.error(`manifest not found: ${args.manifestPath}`);
      process.exit(1);
    }
    manifest = readJson(args.manifestPath);
  }

  const result = derive(path.resolve(args.repoRoot), { manifest });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
