import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { derive, check } from "./decompose-skeleton.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./decompose-skeleton.mjs", import.meta.url));

function writeManifest(repo, manifest) {
  const manifestPath = path.join(repo, "targets.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

function apiTarget(manifest) {
  return manifest.targets.find((t) => t.structural_unit === "packages/api");
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "decompose-"));
}

function write(repo, relPath, contents) {
  const abs = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function workspaceRepo() {
  const repo = makeTempRepo();
  write(repo, "package.json", JSON.stringify({ workspaces: ["packages/*"] }));
  write(repo, "packages/api/package.json", "{}");
  write(repo, "packages/api/index.js", "export const api = 1;");
  write(repo, "packages/web/package.json", "{}");
  write(repo, "packages/web/main.js", "export const web = 1;");
  write(repo, "README.md", "# root");
  return repo;
}

// Mirror the script's matches() semantics so tests can assert ownership for
// every supported glob shape, including the shallow remainder globs.
function owns(glob, file) {
  if (glob === "**") return true;
  if (glob === "*") return !file.includes("/");
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  if (glob.endsWith("/*")) {
    const prefix = glob.slice(0, -2);
    if (!file.startsWith(`${prefix}/`)) return false;
    const rest = file.slice(prefix.length + 1);
    return rest.length > 0 && !rest.includes("/");
  }
  return false;
}

function ownersOf(manifest, file) {
  return manifest.targets.filter((t) => t.source_globs.some((g) => owns(g, file)));
}

function projection(manifest) {
  return manifest.targets.map((t) => ({
    slug: t.slug,
    structural_unit: t.structural_unit,
    source_globs: t.source_globs,
    agent_path: t.agent_path,
  }));
}

test("derive produces identical slug/structural_unit/source_globs across two runs", () => {
  const repo = workspaceRepo();
  try {
    const first = derive(repo);
    const second = derive(repo);

    assert.deepEqual(projection(first), projection(second));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("every source file is owned by exactly one target, with no overlaps and nothing unassigned", () => {
  const repo = workspaceRepo();
  try {
    const manifest = derive(repo);
    const allFiles = [
      "packages/api/index.js",
      "packages/web/main.js",
      "package.json",
      "README.md",
    ];

    for (const file of allFiles) {
      assert.equal(ownersOf(manifest, file).length, 1, `${file} should have exactly one owner`);
    }
    // Loose root files are owned by a root remainder target, not silently dropped.
    const root = manifest.targets.find((t) => t.structural_unit === ".");
    assert.equal(root.origin, "remainder");
    assert.deepEqual(root.source_globs, ["*"]);
    assert.equal(manifest.coverage.unassigned.count, 0);
    assert.deepEqual(manifest.coverage.overlaps, []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("slugs are unique, kebab-case, and stable for a fixed structural_unit path", () => {
  const repo = workspaceRepo();
  try {
    const manifest = derive(repo);
    const slugs = manifest.targets.map((t) => t.slug);

    assert.equal(new Set(slugs).size, slugs.length);
    for (const slug of slugs) assert.match(slug, KEBAB);
    for (const target of manifest.targets) {
      assert.equal(target.agent_path, `docs/specops/agents/${target.slug}.md`);
    }

    const reran = derive(repo);
    for (const target of manifest.targets) {
      const same = reran.targets.find((t) => t.structural_unit === target.structural_unit);
      assert.equal(same.slug, target.slug);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a repo with no detectable module system yields one low-confidence root unit", () => {
  const repo = makeTempRepo();
  try {
    write(repo, "notes.txt", "loose file");
    write(repo, "TODO.md", "loose file");

    const manifest = derive(repo);

    assert.equal(manifest.targets.length, 1);
    assert.equal(manifest.targets[0].structural_unit, ".");
    assert.equal(manifest.coverage.low_confidence, true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("source roots split through semantic containers to deeper units", () => {
  const repo = makeTempRepo();
  try {
    write(repo, "src/features/accounts/index.js", "export const accounts = 1;");
    write(repo, "src/features/billing/index.js", "export const billing = 1;");
    write(repo, "src/shared/format.js", "export const format = 1;");

    const manifest = derive(repo);
    const units = manifest.targets.map((t) => t.structural_unit);

    assert.deepEqual(units, [
      "src/features/accounts",
      "src/features/billing",
      "src/shared",
    ]);
    assert.equal(manifest.coverage.low_confidence, false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("loose files directly in a split source root are captured by a shallow remainder", () => {
  const repo = makeTempRepo();
  try {
    // src is a source root that splits into subdir units; the files sitting
    // directly in src/ would otherwise be orphaned.
    write(repo, "src/utils/helpers.js", "export const h = 1;");
    write(repo, "src/models/user.js", "export const u = 1;");
    write(repo, "src/index.js", "export const i = 1;");
    write(repo, "src/auth.js", "export const a = 1;");

    const manifest = derive(repo);
    const remainder = manifest.targets.find((t) => t.structural_unit === "src");

    assert.ok(remainder, "expected a remainder target for loose files in src");
    assert.equal(remainder.origin, "remainder");
    assert.deepEqual(remainder.source_globs, ["src/*"]);
    assert.equal(ownersOf(manifest, "src/index.js").length, 1);
    assert.equal(ownersOf(manifest, "src/auth.js").length, 1);
    assert.equal(manifest.coverage.unassigned.count, 0);
    assert.deepEqual(manifest.coverage.overlaps, []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a shallow remainder owns only direct children, never nested files of sibling units", () => {
  const repo = makeTempRepo();
  try {
    write(repo, "src/utils/helpers.js", "export const h = 1;");
    write(repo, "src/index.js", "export const i = 1;");

    const manifest = derive(repo);

    // src/* must not swallow src/utils/helpers.js (owned by the src/utils unit).
    assert.deepEqual(ownersOf(manifest, "src/utils/helpers.js").map((t) => t.structural_unit), [
      "src/utils",
    ]);
    assert.deepEqual(ownersOf(manifest, "src/index.js").map((t) => t.structural_unit), ["src"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a remainder hash is content-stable across an mtime-only touch", () => {
  const repo = makeTempRepo();
  try {
    write(repo, "src/utils/helpers.js", "export const h = 1;");
    write(repo, "src/index.js", "export const i = 1;");

    const before = derive(repo).targets.find((t) => t.structural_unit === "src").source_hash;
    const touched = path.join(repo, "src/index.js");
    const future = new Date("2030-01-01T00:00:00Z");
    fs.utimesSync(touched, future, future);
    const after = derive(repo).targets.find((t) => t.structural_unit === "src").source_hash;

    assert.equal(after, before);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("check passes on a manifest containing remainder targets", () => {
  const repo = makeTempRepo();
  try {
    write(repo, "src/utils/helpers.js", "export const h = 1;");
    write(repo, "src/index.js", "export const i = 1;");
    const manifestPath = writeManifest(repo, derive(repo));

    const result = check(repo, manifestPath);

    assert.equal(result.ok, true, JSON.stringify(result.violations));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("all recognizable source roots contribute units", () => {
  const repo = makeTempRepo();
  try {
    write(repo, "src/api/index.js", "export const api = 1;");
    write(repo, "services/worker/index.js", "export const worker = 1;");

    const manifest = derive(repo);
    const units = manifest.targets.map((t) => t.structural_unit);

    assert.deepEqual(units, ["services/worker", "src/api"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("workspace packages split when semantic internal frontiers are present", () => {
  const repo = makeTempRepo();
  try {
    write(repo, "package.json", JSON.stringify({ workspaces: ["packages/*"] }));
    write(repo, "packages/app/package.json", "{}");
    write(repo, "packages/app/src/domains/accounts/index.js", "export const accounts = 1;");
    write(repo, "packages/app/src/domains/billing/index.js", "export const billing = 1;");
    write(repo, "packages/app/src/domains/reports/index.js", "export const reports = 1;");
    write(repo, "packages/app/src/workflows/import/index.js", "export const importFlow = 1;");
    write(repo, "packages/app/src/workflows/export/index.js", "export const exportFlow = 1;");

    const manifest = derive(repo);
    const derivedUnits = manifest.targets
      .filter((t) => t.origin === "derived")
      .map((t) => t.structural_unit);

    assert.deepEqual(derivedUnits, [
      "packages/app/src/domains/accounts",
      "packages/app/src/domains/billing",
      "packages/app/src/domains/reports",
      "packages/app/src/workflows/export",
      "packages/app/src/workflows/import",
    ]);
    // The loose package.json files (repo root and the split package root) are
    // captured by remainder targets rather than dropped.
    const remainderUnits = manifest.targets
      .filter((t) => t.origin === "remainder")
      .map((t) => t.structural_unit)
      .sort((a, b) => a.localeCompare(b));
    assert.deepEqual(remainderUnits, [".", "packages/app"]);
    assert.equal(manifest.coverage.unassigned.count, 0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("top-level directory fallback is marked low confidence", () => {
  const repo = makeTempRepo();
  try {
    write(repo, "alpha/index.js", "export const alpha = 1;");
    write(repo, "beta/index.js", "export const beta = 1;");

    const manifest = derive(repo);

    assert.deepEqual(manifest.targets.map((t) => t.structural_unit), ["alpha", "beta"]);
    assert.equal(manifest.coverage.low_confidence, true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("source_hash is unchanged after an mtime-only touch of a matched file", () => {
  const repo = workspaceRepo();
  try {
    const before = apiTarget(derive(repo)).source_hash;

    const matched = path.join(repo, "packages/api/index.js");
    const future = new Date("2030-01-01T00:00:00Z");
    fs.utimesSync(matched, future, future);

    const after = apiTarget(derive(repo)).source_hash;

    assert.equal(after, before);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("source_hash changes after a content edit of a matched file", () => {
  const repo = workspaceRepo();
  try {
    const before = apiTarget(derive(repo)).source_hash;

    write(repo, "packages/api/index.js", "export const api = 2;");

    const after = apiTarget(derive(repo)).source_hash;

    assert.notEqual(after, before);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("reconcile preserves curated name/scope/last_synthesized and recomputes source_hash", () => {
  const repo = workspaceRepo();
  try {
    const existing = derive(repo);
    const apiSlug = apiTarget(existing).slug;
    const curated = existing.targets.find((t) => t.slug === apiSlug);
    curated.name = "API Service";
    curated.scope = "Handles inbound API requests";
    curated.last_synthesized = "2025-01-15T00:00:00Z";
    curated.source_hash = "sha256:stale";

    write(repo, "packages/api/index.js", "export const api = 3;");
    const reconciled = derive(repo, { manifest: existing });
    const result = reconciled.targets.find((t) => t.slug === apiSlug);
    const freshHash = derive(repo).targets.find((t) => t.slug === apiSlug).source_hash;

    assert.equal(result.name, "API Service");
    assert.equal(result.scope, "Handles inbound API requests");
    assert.equal(result.last_synthesized, "2025-01-15T00:00:00Z");
    assert.equal(result.source_hash, freshHash);
    assert.deepEqual(result.source_globs, ["packages/api/**"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function singleUnitRepo() {
  const repo = makeTempRepo();
  write(repo, "src/alpha/index.js", "export const alpha = 1;");
  return repo;
}

test("merge override yields one override target with union globs, surviving a second reconcile", () => {
  const repo = workspaceRepo();
  try {
    const base = derive(repo);
    base.overrides = [
      { op: "merge", units: ["packages/api", "packages/web"], into: "platform" },
    ];

    const merged = derive(repo, { manifest: base });
    const overrideTargets = merged.targets.filter((t) => t.origin === "override");

    assert.equal(overrideTargets.length, 1);
    assert.equal(overrideTargets[0].slug, "platform");
    assert.deepEqual(overrideTargets[0].source_globs, ["packages/api/**", "packages/web/**"]);
    assert.equal(merged.targets.some((t) => t.structural_unit === "packages/api"), false);
    assert.equal(merged.targets.some((t) => t.structural_unit === "packages/web"), false);

    const reconciledAgain = derive(repo, { manifest: merged });
    const survivor = reconciledAgain.targets.find((t) => t.slug === "platform");

    assert.ok(survivor);
    assert.equal(survivor.origin, "override");
    assert.deepEqual(survivor.source_globs, ["packages/api/**", "packages/web/**"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("renaming a unit dir without changing contents emits a renames entry", () => {
  const repo = singleUnitRepo();
  try {
    const base = derive(repo);
    const oldSlug = base.targets.find((t) => t.structural_unit === "src/alpha").slug;

    fs.renameSync(path.join(repo, "src/alpha"), path.join(repo, "src/beta"));

    const after = derive(repo, { manifest: base });
    const newSlug = after.targets.find((t) => t.structural_unit === "src/beta").slug;

    assert.deepEqual(after.renames, [{ old_slug: oldSlug, new_slug: newSlug }]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("renaming a unit dir with content changes yields remove+add, no renames entry", () => {
  const repo = singleUnitRepo();
  try {
    const base = derive(repo);
    const oldSlug = base.targets.find((t) => t.structural_unit === "src/alpha").slug;

    fs.renameSync(path.join(repo, "src/alpha"), path.join(repo, "src/beta"));
    write(repo, "src/beta/index.js", "export const beta = 99;");

    const after = derive(repo, { manifest: base });
    const newTarget = after.targets.find((t) => t.structural_unit === "src/beta");

    assert.deepEqual(after.renames, []);
    assert.equal(after.targets.some((t) => t.slug === oldSlug), false);
    assert.ok(newTarget);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("an unknown override op throws", () => {
  const repo = workspaceRepo();
  try {
    const base = derive(repo);
    base.overrides = [{ op: "frobnicate", unit: "packages/api" }];

    assert.throws(() => derive(repo, { manifest: base }), /unknown.*frobnicate|frobnicate/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a dangling override unit throws", () => {
  const repo = workspaceRepo();
  try {
    const base = derive(repo);
    base.overrides = [{ op: "relabel", unit: "packages/missing", name: "X", scope: "y" }];

    assert.throws(() => derive(repo, { manifest: base }), /unknown unit: packages\/missing/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("check passes on a script-produced manifest", () => {
  const repo = workspaceRepo();
  try {
    const manifestPath = writeManifest(repo, derive(repo));

    const result = check(repo, manifestPath);

    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("check fails when source_globs is hand-edited to disagree with derivation", () => {
  const repo = workspaceRepo();
  try {
    const manifest = derive(repo);
    const apiSlug = apiTarget(manifest).slug;
    apiTarget(manifest).source_globs = ["packages/web/**"];
    const manifestPath = writeManifest(repo, manifest);

    const result = check(repo, manifestPath);

    assert.equal(result.ok, false);
    assert.ok(
      result.violations.some((v) => v.includes("source_globs mismatch") && v.includes(apiSlug)),
      `expected a source_globs mismatch for ${apiSlug}, got: ${JSON.stringify(result.violations)}`
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("check fails when a required field is missing", () => {
  const repo = workspaceRepo();
  try {
    const manifest = derive(repo);
    delete manifest.coverage;
    const manifestPath = writeManifest(repo, manifest);

    const result = check(repo, manifestPath);

    assert.equal(result.ok, false);
    assert.ok(
      result.violations.some((v) => v.includes("coverage")),
      `expected a coverage violation, got: ${JSON.stringify(result.violations)}`
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("check fails when a slug is duplicated", () => {
  const repo = workspaceRepo();
  try {
    const manifest = derive(repo);
    const duplicated = manifest.targets[0];
    manifest.targets.push({ ...duplicated });
    const manifestPath = writeManifest(repo, manifest);

    const result = check(repo, manifestPath);

    assert.equal(result.ok, false);
    assert.ok(
      result.violations.some((v) => v === `duplicate slug: ${duplicated.slug}`),
      `expected a duplicate slug violation, got: ${JSON.stringify(result.violations)}`
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("check fails when a source_globs entry resolves to no files", () => {
  const repo = workspaceRepo();
  try {
    const manifest = derive(repo);
    apiTarget(manifest).source_globs = ["does/not/exist/**"];
    const manifestPath = writeManifest(repo, manifest);

    const result = check(repo, manifestPath);

    assert.equal(result.ok, false);
    assert.ok(
      result.violations.some((v) => v.includes("glob resolves to no files: does/not/exist/**")),
      `expected a no-files glob violation, got: ${JSON.stringify(result.violations)}`
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("check throws a contextual error for a missing manifest file", () => {
  const repo = workspaceRepo();
  try {
    assert.throws(
      () => check(repo, path.join(repo, "no-such.json")),
      /cannot read manifest/
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI --check exits 0 on a script-produced manifest and 1 on a tampered one", () => {
  const repo = workspaceRepo();
  try {
    const manifestPath = writeManifest(repo, derive(repo));

    const pass = spawnSync("node", [SCRIPT_PATH, repo, "--check", manifestPath], {
      encoding: "utf8",
    });
    assert.equal(pass.status, 0);

    const manifest = derive(repo);
    apiTarget(manifest).source_globs = ["does/not/exist/**"];
    const tamperedPath = writeManifest(repo, manifest);

    const fail = spawnSync("node", [SCRIPT_PATH, repo, "--check", tamperedPath], {
      encoding: "utf8",
    });
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /glob resolves to no files/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
