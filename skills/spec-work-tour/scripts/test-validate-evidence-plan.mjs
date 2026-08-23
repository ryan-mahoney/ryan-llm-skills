#!/usr/bin/env node

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dir = await mkdtemp(path.join(tmpdir(), "evidence-plan-"));
const file = path.join(dir, "evidence-plan.json");
const plan = {
  version: 1,
  spec: ".specs/demo/spec.md",
  posture: {
    risk: "medium",
    rationale: "Crosses a runtime boundary.",
    changeTypes: ["API"], boundaries: ["controller/context"], impacts: ["user-visible behavior"],
    reversibility: "easy", uncertainty: "low", requiredLayers: ["server contract", "live path"],
    independence: ["integrated adversarial audit"], environments: ["test runtime"], qaMode: "automated"
  },
  claims: [{ id: "CL-1", statement: "The route returns the result.", requirements: ["AC-1"], failureHypotheses: ["FH-1"], gates: ["EV-1"] }],
  failureHypotheses: [{ id: "FH-1", statement: "The handler is never registered.", claims: ["CL-1"], gates: ["EV-1"] }],
  gates: [{ id: "EV-1", kind: "integration-test", description: "Call the registered route.", claims: ["CL-1"], rejects: ["FH-1"], ownerStep: 1, command: "bun test route.test.js", artifact: "route.test.js", environment: "test runtime", independence: "real route registration", mergeBlocking: true }]
};
await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`);
const validator = path.join(path.dirname(new URL(import.meta.url).pathname), "validate-evidence-plan.mjs");
const valid = spawnSync(process.execPath, [validator, file], { encoding: "utf8" });
if (valid.status !== 0) throw new Error(valid.stderr || valid.stdout);
plan.claims[0].gates = ["EV-404"];
await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`);
const invalid = spawnSync(process.execPath, [validator, file], { encoding: "utf8" });
if (invalid.status === 0) throw new Error("validator accepted an unknown gate");
console.log("evidence-plan validator test passed");
