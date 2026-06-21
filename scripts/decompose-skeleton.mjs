import fs from "node:fs";
import path from "node:path";
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

const SOURCE_ROOTS = ["src", "lib", "app", "packages", "services", "cmd"];

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

function detectUnits(repoRoot) {
  const wsUnits = resolveWorkspaceUnits(repoRoot, workspaceGlobs(repoRoot));
  if (wsUnits.length) return { units: wsUnits, lowConfidence: false };

  for (const root of SOURCE_ROOTS) {
    if (isDir(path.join(repoRoot, root))) {
      const children = childDirs(path.join(repoRoot, root));
      if (children.length) return { units: children.map((c) => `${root}/${c}`), lowConfidence: false };
    }
  }

  const topLevel = childDirs(repoRoot);
  if (topLevel.length) return { units: topLevel, lowConfidence: false };

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

function computeCoverage(repoRoot, targets, lowConfidence) {
  const unassigned = [];
  const overlaps = [];
  for (const file of walkSourceFiles(repoRoot)) {
    const owners = targets.filter((t) => t.source_globs.some((g) => matches(file, g)));
    if (owners.length === 0) unassigned.push(file);
    else if (owners.length > 1) overlaps.push({ path: file, slugs: owners.map((t) => t.slug) });
  }
  unassigned.sort((a, b) => a.localeCompare(b));
  return { unassigned, overlaps, low_confidence: lowConfidence };
}

export function derive(repoRoot, { manifest } = {}) {
  if (!repoRoot) throw new Error("repoRoot is required");
  if (!isDir(repoRoot)) throw new Error(`not a directory: ${repoRoot}`);
  void manifest;

  const { units, lowConfidence } = detectUnits(repoRoot);
  const targets = buildTargets(units);
  const coverage = computeCoverage(repoRoot, targets, lowConfidence);

  return {
    version: 1,
    system: { summary: "", external_dependencies: [] },
    targets,
    overrides: [],
    renames: [],
    coverage,
  };
}

function main() {
  const repoRoot = process.argv[2];
  if (!repoRoot) {
    console.error("usage: node scripts/decompose-skeleton.mjs <repo-root>");
    process.exit(1);
  }
  const manifest = derive(path.resolve(repoRoot));
  console.log(JSON.stringify(manifest, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
