#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const [file] = process.argv.slice(2);
if (!file) {
  console.error("usage: validate-evidence-plan.mjs <evidence-plan.json>");
  process.exit(2);
}

const plan = JSON.parse(await readFile(file, "utf8"));
const fail = (message) => { throw new Error(message); };
const arr = (value, name) => Array.isArray(value) ? value : fail(`${name} must be an array`);
const text = (value, name) => typeof value === "string" && value.trim() ? value : fail(`${name} is required`);
const legacy = plan.version === 1;
if (!legacy && plan.version !== 2) fail("version must equal 1 or 2");
text(plan.spec, "spec");
if (!legacy) {
  text(plan.context?.path, "context.path");
  if (!/^[0-9a-f]{64}$/.test(plan.context?.sha256 || "")) fail("context.sha256 must be a SHA-256 binding");
}
const phases = new Set(["merge", "deploy", "post-deploy"]);
const posture = plan.posture || fail("posture is required");
if (!["low", "medium", "high", "critical"].includes(posture.risk)) fail("posture.risk is invalid");
text(posture.rationale, "posture.rationale");
for (const key of ["changeTypes", "boundaries", "impacts", "requiredLayers", "independence", "environments"]) arr(posture[key], `posture.${key}`);
if (!["easy", "moderate", "hard", "irreversible"].includes(posture.reversibility)) fail("posture.reversibility is invalid");
if (!["low", "medium", "high"].includes(posture.uncertainty)) fail("posture.uncertainty is invalid");
if (!["automated", "automated-with-exploration-output", "blocked-automation-gap"].includes(posture.qaMode)) fail("posture.qaMode is invalid");

const claims = arr(plan.claims, "claims");
const hypotheses = arr(plan.failureHypotheses, "failureHypotheses");
const gates = arr(plan.gates, "gates");
if (!claims.length || !hypotheses.length || !gates.length) fail("claims, failureHypotheses, and gates must be non-empty");
const uniqueMap = (items, kind) => {
  const map = new Map();
  for (const item of items) {
    const id = text(item.id, `${kind}.id`);
    if (map.has(id)) fail(`duplicate ${kind} id ${id}`);
    map.set(id, item);
  }
  return map;
};
const claimMap = uniqueMap(claims, "claim");
const hypothesisMap = uniqueMap(hypotheses, "failureHypothesis");
const gateMap = uniqueMap(gates, "gate");
for (const id of claimMap.keys()) if (!/^CL-[1-9]\d*$/.test(id)) fail(`invalid claim id ${id}`);
for (const id of hypothesisMap.keys()) if (!/^FH-[1-9]\d*$/.test(id)) fail(`invalid failure hypothesis id ${id}`);
for (const id of gateMap.keys()) if (!/^EV-[1-9]\d*$/.test(id)) fail(`invalid gate id ${id}`);
const requirements = new Set();

for (const claim of claims) {
  text(claim.statement, `${claim.id}.statement`);
  if (!legacy && !phases.has(claim.phase)) fail(`${claim.id}.phase is invalid`);
  for (const id of arr(claim.requirements, `${claim.id}.requirements`)) requirements.add(text(id, `${claim.id}.requirement`));
  if (!claim.requirements.length) fail(`${claim.id} has no requirements`);
  if (!arr(claim.failureHypotheses, `${claim.id}.failureHypotheses`).length) fail(`${claim.id} has no failure hypotheses`);
  if (!arr(claim.gates, `${claim.id}.gates`).length) fail(`${claim.id} has no gates`);
  for (const id of claim.failureHypotheses) if (!hypothesisMap.has(id)) fail(`${claim.id} references unknown hypothesis ${id}`);
  for (const id of claim.gates) if (!gateMap.has(id)) fail(`${claim.id} references unknown gate ${id}`);
}
for (const hypothesis of hypotheses) {
  text(hypothesis.statement, `${hypothesis.id}.statement`);
  if (!arr(hypothesis.claims, `${hypothesis.id}.claims`).length) fail(`${hypothesis.id} has no claims`);
  if (!arr(hypothesis.gates, `${hypothesis.id}.gates`).length) fail(`${hypothesis.id} has no rejecting gates`);
  for (const id of hypothesis.claims) if (!claimMap.has(id)) fail(`${hypothesis.id} references unknown claim ${id}`);
  for (const id of hypothesis.gates) if (!gateMap.has(id)) fail(`${hypothesis.id} references unknown gate ${id}`);
}
const owners = new Map();
for (const gate of gates) {
  for (const key of ["kind", "description", "command", "artifact", "environment", "independence", ...(legacy ? [] : ["effects", "authorization"])]) text(gate[key], `${gate.id}.${key}`);
  if (!Number.isInteger(gate.ownerStep) || gate.ownerStep < 1) fail(`${gate.id}.ownerStep must be a positive integer`);
  if (legacy) {
    if (typeof gate.mergeBlocking !== "boolean") fail(`${gate.id}.mergeBlocking must be boolean for version 1`);
  } else {
    if (!phases.has(gate.phase)) fail(`${gate.id}.phase is invalid`);
    if (typeof gate.required !== "boolean") fail(`${gate.id}.required must be boolean`);
    if ("mergeBlocking" in gate) fail(`${gate.id}: use phase and required, not legacy mergeBlocking`);
  }
  if (!arr(gate.claims, `${gate.id}.claims`).length || !arr(gate.rejects, `${gate.id}.rejects`).length) fail(`${gate.id} must name claims and rejected hypotheses`);
  for (const id of gate.claims) if (!claimMap.has(id)) fail(`${gate.id} references unknown claim ${id}`);
  for (const id of gate.rejects) if (!hypothesisMap.has(id)) fail(`${gate.id} rejects unknown hypothesis ${id}`);
  for (const id of gate.claims) if (!claimMap.get(id).gates.includes(gate.id)) fail(`${gate.id}/${id} mapping is not reciprocal`);
  for (const id of gate.rejects) if (!hypothesisMap.get(id).gates.includes(gate.id)) fail(`${gate.id}/${id} rejection is not reciprocal`);
  if (owners.has(gate.id)) fail(`${gate.id} has multiple owners`);
  owners.set(gate.id, gate.ownerStep);
}
if (!legacy) {
  // Validate both directions: an orphaned link must not appear to establish coverage.
  for (const claim of claims) {
    for (const id of claim.failureHypotheses) {
      if (!hypothesisMap.get(id).claims.includes(claim.id)) fail(`${claim.id}/${id} mapping is not reciprocal`);
    }
    for (const id of claim.gates) {
      const gate = gateMap.get(id);
      if (!gate.claims.includes(claim.id)) fail(`${claim.id}/${id} mapping is not reciprocal`);
      if (gate.phase !== claim.phase) fail(`${claim.id}/${id} crosses decision phases; split the claim`);
      if (!gate.rejects.some((failure) => claim.failureHypotheses.includes(failure))) fail(`${id} rejects no failure of ${claim.id}`);
    }
    if (!claim.gates.some((id) => gateMap.get(id).required)) fail(`${claim.id} needs a required proof gate`);
    for (const id of claim.failureHypotheses) {
      if (!claim.gates.some((gate) => gateMap.get(gate).required && gateMap.get(gate).rejects.includes(id))) {
        fail(`${claim.id}/${id} has no required rejecting gate`);
      }
    }
  }
  for (const hypothesis of hypotheses) {
    for (const id of hypothesis.claims) {
      if (!claimMap.get(id).failureHypotheses.includes(hypothesis.id)) fail(`${hypothesis.id}/${id} mapping is not reciprocal`);
    }
    for (const id of hypothesis.gates) {
      const gate = gateMap.get(id);
      if (!gate.rejects.includes(hypothesis.id)) fail(`${hypothesis.id}/${id} rejection is not reciprocal`);
      if (!gate.claims.some((claim) => hypothesis.claims.includes(claim))) fail(`${id} rejects an unrelated hypothesis ${hypothesis.id}`);
    }
  }
  if (!claims.some((claim) => claim.phase === "merge")) fail("an implementation plan needs at least one merge claim");
}
if (!requirements.size) fail("no requirements are covered");
if (legacy) console.warn("Legacy version 1: structural validation only; standalone specs must resolve context and re-prepare as version 2.");
console.log(`valid ${legacy ? "legacy " : ""}evidence plan: ${claims.length} claims, ${hypotheses.length} hypotheses, ${gates.length} gates, ${requirements.size} requirements`);
