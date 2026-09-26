#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const dir = await mkdtemp(path.join(tmpdir(), "evidence-plan-"));
const file = path.join(dir, "evidence-plan.json");
const validator = fileURLToPath(new URL("validate-evidence-plan.mjs", import.meta.url));
const plan = {
  version: 2,
  spec: ".specs/demo/spec.md",
  context: { path: ".specs/demo/context.md", sha256: "a".repeat(64) },
  posture: {
    risk: "medium", rationale: "Changes a registered route over disposable fixtures.",
    changeTypes: ["API"], boundaries: ["controller/context"], impacts: ["user-visible behavior"],
    reversibility: "easy", uncertainty: "low", requiredLayers: ["server contract"],
    independence: ["integrated adversarial audit"], environments: ["isolated test runtime"], qaMode: "automated"
  },
  claims: [{ id: "CL-1", phase: "merge", statement: "The route returns the result.", requirements: ["AC-1"], failureHypotheses: ["FH-1"], gates: ["EV-1"] }],
  failureHypotheses: [{ id: "FH-1", statement: "The handler is never registered.", claims: ["CL-1"], gates: ["EV-1"] }],
  gates: [{ id: "EV-1", phase: "merge", required: true, kind: "integration-test", description: "Call the registered route.", claims: ["CL-1"], rejects: ["FH-1"], ownerStep: 1, command: "bun test route.test.js", artifact: "evidence/route.log", environment: "isolated test runtime", effects: "No external calls; disposable fixtures only.", authorization: "isolated local execution", independence: "real registration and externally specified response" }]
};
let checks = 0;
async function check(name, mutate, error) {
  const candidate = structuredClone(plan);
  mutate(candidate);
  await writeFile(file, `${JSON.stringify(candidate, null, 2)}\n`);
  const result = spawnSync(process.execPath, [validator, file], { encoding: "utf8" });
  if (error) {
    assert.notEqual(result.status, 0, `${name}: accepted invalid plan`);
    assert.match(result.stderr, error, name);
  } else assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  checks++;
}
try {
  await check("focused isolated proof", () => {});
  await check("shared gate covers two claims", (p) => {
    p.claims.push({ ...structuredClone(p.claims[0]), id: "CL-2", requirements: ["AC-2"] });
    p.failureHypotheses[0].claims.push("CL-2");
    p.gates[0].claims.push("CL-2");
  });
  await check("later phase is a separately owned procedure", (p) => {
    p.claims.push({ ...structuredClone(p.claims[0]), id: "CL-2", phase: "post-deploy", requirements: ["DEP-1"], failureHypotheses: ["FH-2"], gates: ["EV-2"] });
    p.failureHypotheses.push({ id: "FH-2", statement: "The deployed route is unreachable.", claims: ["CL-2"], gates: ["EV-2"] });
    p.gates.push({ ...structuredClone(p.gates[0]), id: "EV-2", phase: "post-deploy", claims: ["CL-2"], rejects: ["FH-2"], environment: "live service after authorized release", effects: "Read-only request.", authorization: "not granted; decision required" });
  });
  await check("unknown gate", (p) => { p.claims[0].gates = ["EV-404"]; }, /unknown gate/);
  await check("missing context", (p) => { delete p.context; }, /context.path/);
  await check("invalid context binding", (p) => { p.context.sha256 = "unknown"; }, /SHA-256/);
  await check("version-only downgrade is not a legacy plan", (p) => { p.version = 1; }, /mergeBlocking/);
  await check("unsupported version", (p) => { p.version = 9; }, /version must equal 1 or 2/);
  await check("existing out-of-scope callers retain version 1 validation", (p) => {
    p.version = 1; delete p.context;
    for (const claim of p.claims) delete claim.phase;
    for (const gate of p.gates) {
      gate.mergeBlocking = gate.required;
      for (const key of ["phase", "required", "effects", "authorization"]) delete gate[key];
    }
  });
  await check("missing effects", (p) => { delete p.gates[0].effects; }, /effects/);
  await check("missing authority", (p) => { delete p.gates[0].authorization; }, /authorization/);
  await check("cross-phase proof", (p) => { p.gates[0].phase = "post-deploy"; }, /crosses decision phases/);
  await check("optional proof cannot close obligation", (p) => { p.gates[0].required = false; }, /required proof gate/);
  await check("all claims cannot move out of merge", (p) => { p.claims[0].phase = "deploy"; p.gates[0].phase = "deploy"; }, /at least one merge claim/);
  await check("invalid phase", (p) => { p.claims[0].phase = "whenever"; }, /phase is invalid/);
  await check("legacy flag", (p) => { p.gates[0].mergeBlocking = true; }, /legacy mergeBlocking/);
  await check("nonreciprocal claim link", (p) => {
    p.claims.push({ ...structuredClone(p.claims[0]), id: "CL-2" });
    p.failureHypotheses[0].claims.push("CL-2");
  }, /not reciprocal/);
  await check("hypothesis without required rejection", (p) => {
    p.failureHypotheses.push({ id: "FH-2", statement: "A write is dropped.", claims: ["CL-1"], gates: ["EV-2"] });
    p.claims[0].failureHypotheses.push("FH-2"); p.claims[0].gates.push("EV-2");
    p.gates.push({ ...structuredClone(p.gates[0]), id: "EV-2", required: false, rejects: ["FH-2"] });
  }, /no required rejecting gate/);
  console.log(`evidence-plan validator: ${checks} checks passed`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
