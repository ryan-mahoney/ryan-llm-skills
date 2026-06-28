import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  START_MARKER,
  END_MARKER,
  changedTargets,
  formatIndex,
  replaceBlock,
  targetAgentPath,
  writeIndex,
} from "./agent-docs.mjs";

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-docs-"));
}

function write(repo, relPath, contents) {
  const abs = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function manifest() {
  return {
    version: 1,
    system: {
      summary: "A small service with API and worker targets.",
      external_dependencies: ["Postgres"],
    },
    targets: [
      {
        slug: "api",
        name: "API",
        scope: "Handles HTTP requests.",
        origin: "derived",
        structural_unit: "lib/api",
        source_globs: ["lib/api/**"],
        tier2_path: "docs/specops/analysis/api.md",
        agent_path: "docs/specops/agents/api.md",
        source_hash: "sha256:api",
        last_synthesized: null,
      },
      {
        slug: "worker",
        name: "Worker",
        scope: "Runs background jobs.",
        origin: "derived",
        structural_unit: "lib/worker",
        source_globs: ["lib/worker/**"],
        tier2_path: "docs/specops/analysis/worker.md",
        agent_path: "docs/specops/agents/worker.md",
        source_hash: "sha256:worker",
        last_synthesized: null,
      },
    ],
    overrides: [],
    renames: [],
    coverage: { unassigned: { count: 0, by_top_level: [], sample: [], truncated: false }, overlaps: [], low_confidence: false },
  };
}

test("changedTargets maps changed files to owning targets and reports unowned files", () => {
  const result = changedTargets(manifest(), [
    "lib/api/router.ex",
    "lib/worker/job.ex",
    "README.md",
  ]);

  assert.deepEqual(result.targets.map((target) => target.slug), ["api", "worker"]);
  assert.deepEqual(result.unowned_files, ["README.md"]);
});

test("changedTargets matches shallow remainder globs without throwing", () => {
  const remainderManifest = {
    targets: [
      { slug: "scripts", source_globs: ["scripts/*"] },
      { slug: "root", source_globs: ["*"] },
    ],
  };
  const result = changedTargets(remainderManifest, [
    "scripts/build.sh",
    "Makefile",
    "scripts/nested/deep.sh",
  ]);

  assert.deepEqual(result.targets.map((target) => target.slug), ["root", "scripts"]);
  assert.deepEqual(result.unowned_files, ["scripts/nested/deep.sh"]);
});

test("targetAgentPath falls back for older manifests without agent_path", () => {
  assert.equal(targetAgentPath({ slug: "accounts" }), "docs/specops/agents/accounts.md");
});

test("formatIndex includes manifest summary and target links", () => {
  const repo = makeTempRepo();
  try {
    write(repo, "docs/specops/analysis/api.md", "# API");
    write(repo, "docs/specops/agents/api.md", "# API Agent");

    const block = formatIndex(repo, { relPath: "docs/specops/targets.json", manifest: manifest() });

    assert.match(block, new RegExp(START_MARKER));
    assert.match(block, /A small service with API and worker targets/);
    assert.match(block, /\[agent\]\(docs\/specops\/agents\/api\.md\)/);
    assert.match(block, /agent \/ analysis/);
    assert.match(block, /missing agent \/ missing analysis/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("replaceBlock updates an existing generated block without touching surrounding text", () => {
  const existing = [
    "# AGENTS.md",
    "",
    "Human note.",
    "",
    START_MARKER,
    "old",
    END_MARKER,
    "",
    "Footer.",
    "",
  ].join("\n");

  const updated = replaceBlock(existing, `${START_MARKER}\nnew\n${END_MARKER}\n`);

  assert.match(updated, /^# AGENTS\.md\n\nHuman note\./);
  assert.match(updated, /new/);
  assert.doesNotMatch(updated, /old/);
  assert.match(updated, /Footer\./);
});

test("writeIndex writes AGENTS.md with an idempotent generated block", () => {
  const repo = makeTempRepo();
  try {
    write(repo, "docs/specops/targets.json", JSON.stringify(manifest(), null, 2));
    write(repo, "AGENTS.md", "# AGENTS.md\n\nHuman note.\n");

    const first = writeIndex(repo);
    const afterFirst = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
    const second = writeIndex(repo);
    const afterSecond = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");

    assert.equal(first.targets, 2);
    assert.equal(second.targets, 2);
    assert.equal(afterSecond, afterFirst);
    assert.match(afterSecond, new RegExp(END_MARKER));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
