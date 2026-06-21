import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { derive } from "./decompose-skeleton.mjs";

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

function projection(manifest) {
  return manifest.targets.map((t) => ({
    slug: t.slug,
    structural_unit: t.structural_unit,
    source_globs: t.source_globs,
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

test("every source file is owned by exactly one target or unassigned, with no overlaps", () => {
  const repo = workspaceRepo();
  try {
    const manifest = derive(repo);
    const matchedFiles = ["packages/api/index.js", "packages/web/main.js"];

    for (const file of matchedFiles) {
      const owners = manifest.targets.filter((t) => t.source_globs.some((g) => g.endsWith("/**") && file.startsWith(g.slice(0, -3) + "/")));
      assert.equal(owners.length, 1, `${file} should have exactly one owner`);
    }
    assert.ok(manifest.coverage.unassigned.includes("README.md"));
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
