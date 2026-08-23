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
if (plan.version !== 1) fail("version must equal 1");
text(plan.spec, "spec");
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
  for (const key of ["kind", "description", "command", "artifact", "environment", "independence"]) text(gate[key], `${gate.id}.${key}`);
  if (!Number.isInteger(gate.ownerStep) || gate.ownerStep < 1) fail(`${gate.id}.ownerStep must be a positive integer`);
  if (typeof gate.mergeBlocking !== "boolean") fail(`${gate.id}.mergeBlocking must be boolean`);
  if (!arr(gate.claims, `${gate.id}.claims`).length || !arr(gate.rejects, `${gate.id}.rejects`).length) fail(`${gate.id} must name claims and rejected hypotheses`);
  for (const id of gate.claims) if (!claimMap.has(id)) fail(`${gate.id} references unknown claim ${id}`);
  for (const id of gate.rejects) if (!hypothesisMap.has(id)) fail(`${gate.id} rejects unknown hypothesis ${id}`);
  for (const id of gate.claims) if (!claimMap.get(id).gates.includes(gate.id)) fail(`${gate.id}/${id} mapping is not reciprocal`);
  for (const id of gate.rejects) if (!hypothesisMap.get(id).gates.includes(gate.id)) fail(`${gate.id}/${id} rejection is not reciprocal`);
  if (owners.has(gate.id)) fail(`${gate.id} has multiple owners`);
  owners.set(gate.id, gate.ownerStep);
}
if (!requirements.size) fail("no requirements are covered");
console.log(`valid evidence plan: ${claims.length} claims, ${hypotheses.length} hypotheses, ${gates.length} gates, ${requirements.size} requirements`);
