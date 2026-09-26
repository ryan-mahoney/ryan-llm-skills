#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const dir = await mkdtemp(path.join(tmpdir(), "spec-work-tour-"));
const input = path.join(dir, "work-tour.json");
const output = path.join(dir, "work-tour.html");
const renderer = fileURLToPath(new URL("render-work-tour.mjs", import.meta.url));
const commit = "a".repeat(40);
const manifest = {
  version: 2, feature: "evidence-demo", title: "Save normalized values through the real route",
  generatedAt: "2026-09-26T12:00:00Z", repository: ".", branch: "feature/evidence-demo", base: "origin/main", commit,
  verdict: "ready", summary: "The route now persists the normalized value. An isolated integration check observed the save and subsequent read. Release observations remain pending.",
  context: { artifact: "context.md", sha256: "b".repeat(64), summary: "Customer service with retained data. Verification uses an isolated database. The existing deployment process remains in use.", decisions: ["Preserve existing records — project policy, Data section."], omissions: ["No new release flag: the established process does not use staged rollout."], burden: ["One maintained route regression test; no new configuration or services."] },
  architecture: { before: "Save accepted input without normalization.", after: "The registered route normalizes, persists, and returns the value.", boundaries: ["route -> model -> isolated database"], decisions: [] },
  implementation: { steps: [{ step: 1, name: "Persist normalized value", commit, files: ["route.js"], outcome: "Implemented and observed through application wiring." }] },
  claims: [
    { id: "CL-1", phase: "merge", statement: "The real route persists and returns the normalized value.", requirements: ["AC-1"], status: "proven", gates: ["EV-1", "EV-3"], explanation: "The isolated route test saved and reread the expected value." },
    { id: "CL-2", phase: "post-deploy", statement: "The deployed route is reachable after release.", requirements: ["DEP-1"], status: "unproven", gates: ["EV-2"], explanation: "This run has not deployed the candidate." },
  ],
  gates: [
    { id: "EV-1", phase: "merge", kind: "integration-test", required: true, status: "passed", command: "node --test route.test.js", environment: "isolated local database", effects: "Creates and removes disposable fixtures.", authorization: "isolated local execution", artifact: "route-result.txt", claims: ["CL-1"], rejects: ["FH-1"], proof: "Saved Mixed Case; read mixed case through the registered route.", boundary: "Does not establish deployment or live availability.", commit },
    { id: "EV-2", phase: "post-deploy", kind: "availability-check", required: true, status: "pending", command: "Run the established read-only availability check after authorized release.", environment: "live deployment", effects: "One read-only request; no writes or service restarts.", authorization: "not granted; decision required", artifact: "release-procedure.md", claims: ["CL-2"], rejects: ["FH-2"], proof: "Not executed.", boundary: "A prepared procedure is not an observation of live availability.", commit },
    { id: "EV-3", phase: "merge", kind: "exploration", required: false, status: "pending", command: "Explore additional fixture values.", environment: "isolated local database", effects: "Disposable fixtures only.", authorization: "isolated local execution", artifact: "route-result.txt", claims: ["CL-1"], rejects: ["FH-1"], proof: "Not run; required proof is EV-1.", boundary: "Optional exploratory evidence.", commit },
  ],
  qa: { mode: "automated-with-exploration-output", entrypoints: [{ label: "Isolated API", location: "local test route", setup: "Disposable seeded database." }], scenarios: [{ id: "QA-1", title: "Save and read a normalized value", steps: ["Run the isolated integration check."], expected: ["The returned and reread value are normalized."], automatedBy: ["EV-1"], artifacts: ["route-result.txt"] }] },
  deployment: { readiness: "ready", authorization: "not-requested", authorizationSource: "none", postDeploy: "not-run", gaps: [], migrations: "none", configuration: "none", observability: ["Existing availability check after authorized release."], rollback: "Existing application-version rollback; stored format unchanged.", residualRisks: [] },
  audit: { iteration: 1, verdict: "pass", artifact: "audit.md", commit }, gaps: []
};
for (const file of ["context.md", "route-result.txt", "release-procedure.md", "audit.md", "route.js"]) await writeFile(path.join(dir, file), `Renderer fixture: ${file}\n`);
let checks = 0;
async function check(name, mutate, error) {
  const candidate = structuredClone(manifest); mutate(candidate);
  await writeFile(input, `${JSON.stringify(candidate, null, 2)}\n`);
  const result = spawnSync(process.execPath, [renderer, input, output], { encoding: "utf8" });
  if (error) {
    assert.notEqual(result.status, 0, `${name}: accepted invalid tour`);
    assert.match(result.stderr, error, name);
  } else assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  checks++;
  return error ? "" : readFile(output, "utf8");
}
const html = await check("merge ready with unauthorized pending release", () => {});
for (const text of ["Merge evidence · ready", "Deployment authorization:", "not-requested", "post-deploy", "pending", "Project context and decisions", "No new release flag", "QA walkthrough", 'data-claim-panel="CL-1"', "Copy command", 'href="context.md"']) assert.ok(html.includes(text), `missing ${text}`);
assert.ok(!html.includes('attention-item attention-item--blocking'), "later work was rendered as a merge blocker");
await check("merge ready despite deployment gap", (m) => { m.deployment.readiness = "blocked"; m.deployment.gaps = ["Awaiting an isolated release rehearsal."]; });
await check("deployment not assessed", (m) => { m.deployment.readiness = "not-assessed"; });
await check("granted authority with source", (m) => { m.deployment.authorization = "granted"; m.deployment.authorizationSource = "User decision 2026-09-26: deploy candidate to staging only."; });
await check("merge gap cannot pass", (m) => { m.gaps = ["Required assertion absent."]; }, /no merge gaps/);
await check("required failure cannot pass via optional success", (m) => { m.gates[0].status = "failed"; m.gates[2].status = "passed"; }, /unpassed or stale required gate/);
await check("stale required proof", (m) => { m.gates[0].commit = "c".repeat(40); }, /not bound/);
await check("explicit stale proof cannot prove claim", (m) => { m.gates[0].status = "stale"; m.gates[0].commit = "c".repeat(40); }, /unpassed or stale/);
await check("cross-phase evidence cannot close merge claim", (m) => { m.gates[0].phase = "post-deploy"; }, /crosses decision phases/);
await check("pending merge gate", (m) => { m.gates[0].status = "pending"; m.claims[0].status = "unproven"; }, /required merge gates/);
await check("all claims cannot move out of merge", (m) => { m.claims[0].phase = "deploy"; m.gates[0].phase = "deploy"; m.gates[2].phase = "deploy"; }, /at least one merge claim/);
await check("missing authority source", (m) => { m.deployment.authorization = "granted"; }, /requires a source/);
await check("no observation cannot mean post-deploy passed", (m) => { m.deployment.postDeploy = "passed"; }, /observed post-deploy proof/);
await check("failed observation must surface", (m) => { m.gates[1].status = "failed"; }, /must be surfaced/);
await check("honest post-deploy failure does not automatically rewrite merge", (m) => { m.gates[1].status = "failed"; m.deployment.postDeploy = "failed"; });
await check("observed post-deploy success", (m) => { m.gates[1].status = "passed"; m.gates[1].proof = "Observed 200 after release."; m.claims[1].status = "proven"; m.deployment.postDeploy = "passed"; });
await check("deployment cannot ignore its required check", (m) => { m.claims[1].phase = "deploy"; m.gates[1].phase = "deploy"; }, /complete deploy evidence/);
await check("explicit no-deployment project", (m) => { m.claims.pop(); m.gates.splice(1, 1); m.deployment.readiness = "not-applicable"; m.deployment.authorization = "not-applicable"; m.deployment.postDeploy = "not-applicable"; });
await check("absent deployment cannot carry granted authority", (m) => { m.claims.pop(); m.gates.splice(1, 1); m.deployment.readiness = "not-applicable"; m.deployment.authorization = "granted"; m.deployment.authorizationSource = "User approved staging"; m.deployment.postDeploy = "not-applicable"; }, /absent deployment/);
await check("not-applicable cannot conceal release obligations", (m) => { m.deployment.readiness = "not-applicable"; }, /release claims/);
await check("legacy coupled readiness rejected", (m) => { m.deployment.ready = true; }, /separate deployment/);
await check("version-only downgrade is not a legacy tour", (m) => { m.version = 1; }, /legacy deployment.ready/);
await check("unsupported version", (m) => { m.version = 9; }, /version must equal 1 or 2/);
const legacyHtml = await check("existing version 1 callers retain a labeled rendering", (m) => {
  m.version = 1; delete m.context; m.claims.pop(); m.gates.splice(1, 1);
  for (const claim of m.claims) delete claim.phase;
  for (const gate of m.gates) {
    for (const key of ["phase", "effects", "authorization"]) delete gate[key];
    if (gate.status === "pending") gate.status = "blocked";
  }
  m.deployment = { ready: true, migrations: "none", configuration: "none", observability: [], rollback: "existing path", residualRisks: [] };
});
assert.ok(legacyHtml.includes("Legacy reported verdict · ready"));
assert.ok(legacyHtml.includes("Context and authority are unrecorded"));
assert.ok(!legacyHtml.includes("Merge evidence · ready"));
await writeFile(path.join(dir, "legacy.html"), legacyHtml);
await check("missing context rejected", (m) => { delete m.context; }, /context is required/);
await check("bad context hash rejected", (m) => { m.context.sha256 = "missing"; }, /SHA-256/);
await check("missing execution effects rejected", (m) => { delete m.gates[0].effects; }, /effects is required/);
const blockedHtml = await check("honest blocked tour", (m) => { m.verdict = "blocked"; m.claims[0].status = "unproven"; m.gates[0].status = "failed"; m.deployment.readiness = "blocked"; m.gaps = ["Save did not persist."]; });
assert.ok(blockedHtml.includes("Merge evidence · blocked"));
assert.ok(blockedHtml.includes('attention-item attention-item--blocking'));
await writeFile(path.join(dir, "blocked.html"), blockedHtml);
await check("restore ready fixture for browser inspection", () => {});
console.log(`work-tour renderer: ${checks} checks passed; browser fixtures: ${dir}`);
