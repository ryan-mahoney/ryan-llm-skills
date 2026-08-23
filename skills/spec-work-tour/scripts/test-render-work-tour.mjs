#!/usr/bin/env node

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dir = await mkdtemp(path.join(tmpdir(), "spec-work-tour-"));
const input = path.join(dir, "work-tour.json");
const output = path.join(dir, "work-tour.html");
const commit = "a".repeat(40);
const manifest = {
  version: 1,
  feature: "evidence-demo",
  title: "Evidence demo is deployable",
  generatedAt: "2026-08-23T12:00:00Z",
  repository: ".",
  branch: "feature/evidence-demo",
  base: "origin/main",
  commit,
  verdict: "ready",
  summary: "A minimal fixture exercises the renderer contract.",
  architecture: { before: "old", after: "new", boundaries: ["entry -> result"], decisions: [] },
  implementation: { steps: [{ step: 1, name: "Render tour", commit, files: ["file.js"], outcome: "Rendered." }] },
  claims: [{ id: "CL-1", statement: "The tour renders.", requirements: ["AC-1"], status: "proven", gates: ["EV-1"], explanation: "The renderer exited zero." }],
  gates: [{ id: "EV-1", kind: "script-test", required: true, status: "passed", command: "node test-render-work-tour.mjs", environment: "Node", artifact: "work-tour.html", claims: ["CL-1"], rejects: ["FH-1"], proof: "HTML contains the title.", boundary: "Validates rendering and schema, not evidence truth.", commit }],
  qa: { mode: "automated", entrypoints: [], scenarios: [] },
  deployment: { ready: true, migrations: "none", configuration: "none", observability: [], rollback: "remove generated file", residualRisks: [] },
  audit: { iteration: 1, verdict: "pass", artifact: "reviews/branch-1-review.md", commit },
  gaps: []
};

await writeFile(input, `${JSON.stringify(manifest, null, 2)}\n`);
const renderer = path.join(path.dirname(new URL(import.meta.url).pathname), "render-work-tour.mjs");
const result = spawnSync(process.execPath, [renderer, input, output], { encoding: "utf8" });
if (result.status !== 0) throw new Error(result.stderr || result.stdout);
const html = await readFile(output, "utf8");
if (!html.includes("Evidence demo is deployable") || !html.includes("CL-1") || !html.includes("EV-1")) {
  throw new Error("rendered HTML omitted required content");
}
manifest.gaps = ["A ready verdict cannot hide this gap."];
await writeFile(input, `${JSON.stringify(manifest, null, 2)}\n`);
const invalid = spawnSync(process.execPath, [renderer, input, output], { encoding: "utf8" });
if (invalid.status === 0) throw new Error("renderer accepted a ready verdict with a gap");
console.log("spec-work-tour renderer test passed");
