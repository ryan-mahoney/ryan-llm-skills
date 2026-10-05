#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const temp = await mkdtemp(path.join(tmpdir(), "history-index-"));
const spec = path.join(temp, "feature with spaces");
const cli = fileURLToPath(new URL("build-history-index.mjs", import.meta.url));
const run = () => spawnSync(process.execPath, [cli, "--spec-dir", spec], { encoding: "utf8" });
let checks = 0;
try {
  await mkdir(path.join(spec, "learnings"), { recursive: true });
  await mkdir(path.join(spec, "reviews"), { recursive: true });
  await writeFile(path.join(spec, "spec.md"), "# Feature spec\n");
  await writeFile(path.join(spec, "step-001-learning.md"), "# Legacy learning\n\n## Findings for subsequent steps\nNone.\n");
  await writeFile(path.join(spec, "learnings/step-001-learning.md"), [
    "# Canonical learning", "", "```yaml", "learning:", "  outcome: checkpoint", "  introduced:",
    "    - symbol: parseHistory", "      path: src/history/parser.mjs", "      purpose: Parses feature history.", "```", "",
    "## Notes", "A schema heading precedes the useful handoff.",
    ...Array.from({ length: 15 }, (_, i) => `Routine line ${i + 1}.`), "",
    "## Findings for subsequent steps", "- Step 2: preserve unresolved migration decision and inspect src/history/parser.mjs before editing.", "",
  ].join("\n"));
  await writeFile(path.join(spec, "reviews/step-002-review.md"), [
    "# Step Review", "```yaml", "review:", "  verdict: needs-fix", "  findings:", "    - id: F1", "      file: src/foo.ts", "      signature: correctness:src/a.js:parse:malformed record", "```", "",
    "## F1 · HIGH · correctness", "What: malformed records are accepted", "Harm: corrupted data is stored.", "",
  ].join("\n"));
  await writeFile(path.join(spec, "reviews/step-002-fix.md"), [
    "# Step Fix", "```yaml", "fix:", "  consumed: reviews/step-009-review.md", "  decisions:", "    - id: F1", "      decision: dismissed", "      dismissal: deferred", "      approval_source: .specs/decisions/risk.md", "      signature: correctness:src/a.js:parse:malformed record", "```", "",
  ].join("\n"));

  let result = run();
  assert.equal(result.status, 0, result.stderr);
  const outputPath = path.join(spec, "history-index.json");
  const first = await readFile(outputPath, "utf8");
  const index = JSON.parse(first);
  assert.equal(index.version, 1);
  assert.equal(index.records.find((record) => record.kind === "learning").path, "learnings/step-001-learning.md");
  assert.equal(index.records.find((record) => record.kind === "learning").headings[0], "Canonical learning");
  const learning = index.records.find((record) => record.kind === "learning");
  assert.match(learning.introduced, /symbol: parseHistory[\s\S]*path: src\/history\/parser\.mjs[\s\S]*purpose: Parses feature history/);
  assert.match(learning.proseSections.find((section) => section.heading === "Findings for subsequent steps").text, /preserve unresolved migration decision/);
  assert.equal(learning.relevantPaths.includes("src/history/parser.mjs"), true);
  assert.match(learning.status, /^unknown/);
  checks++;

  const review = index.records.find((record) => record.kind === "review");
  const fix = index.records.find((record) => record.kind === "fix");
  assert.equal(review.verdict, "needs-fix");
  assert.deepEqual(review.signatures, ["correctness:src/a.js:parse:malformed record"]);
  assert.equal(review.status.startsWith("unknown"), true);
  assert.equal(review.relevantPaths.includes("src/foo.ts"), true);
  assert.equal(fix.decisions[0], "dismissed");
  assert.equal(fix.status.startsWith("unknown"), true);
  assert.equal(fix.relevantPaths.includes(".specs/decisions/risk.md"), true);
  assert.equal(fix.missingReferences[0].status, "missing referenced review");
  assert.match(fix.status, /^unknown/);
  checks++;

  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(outputPath, "utf8"), first, "identical inputs produce deterministic output");
  checks++;

  await rm(path.join(spec, "learnings/step-001-learning.md"));
  result = run();
  assert.equal(result.status, 0, result.stderr);
  const fallback = JSON.parse(await readFile(outputPath, "utf8")).records.find((record) => record.kind === "learning");
  assert.equal(fallback.path, "step-001-learning.md");
  checks++;

  const priorComplete = await readFile(outputPath, "utf8");
  await writeFile(path.join(spec, "reviews/branch-3-review.md"), "\n");
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Empty review input/);
  checks++;
  assert.equal(await readFile(outputPath, "utf8"), priorComplete, "failed rebuild preserves prior complete index");
  checks++;
  const missing = spawnSync(process.execPath, [cli, "--spec-dir", path.join(temp, "absent feature")], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /required spec\.md is unavailable/);
  checks++;
  console.log(`history index: ${checks} checks passed`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
