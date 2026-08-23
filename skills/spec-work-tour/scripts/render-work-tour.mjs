#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  console.error("usage: render-work-tour.mjs <work-tour.json> <work-tour.html>");
  process.exit(2);
}

const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const array = (value, name) => {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
};

const required = (value, name) => {
  if (value === undefined || value === null || value === "") throw new Error(`${name} is required`);
  return value;
};

const link = (value) => {
  const text = escapeHtml(value);
  if (!value || /^(https?:\/\/|\/)/.test(value) || value.includes("..")) return `<code>${text}</code>`;
  return `<a href="${escapeHtml(value)}">${text}</a>`;
};

const list = (items) => items.length
  ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
  : '<p class="muted">None.</p>';

const manifest = JSON.parse(await readFile(inputArg, "utf8"));
if (manifest.version !== 1) throw new Error("version must equal 1");
for (const key of ["feature", "title", "generatedAt", "branch", "base", "commit", "verdict", "summary"]) required(manifest[key], key);
if (!["ready", "blocked"].includes(manifest.verdict)) throw new Error("verdict must be ready or blocked");
const claims = array(manifest.claims, "claims");
const gates = array(manifest.gates, "gates");
const gaps = array(manifest.gaps, "gaps");
const claimIds = new Set(claims.map((claim) => required(claim.id, "claim.id")));
const gateIds = new Set(gates.map((gate) => required(gate.id, "gate.id")));
if (claimIds.size !== claims.length) throw new Error("claim ids must be unique");
if (gateIds.size !== gates.length) throw new Error("gate ids must be unique");
if (!/^[0-9a-f]{40,64}$/.test(manifest.commit)) throw new Error("commit must be a full lowercase git SHA");
for (const claim of claims) {
  if (!["proven", "partial", "unproven"].includes(claim.status)) throw new Error(`${claim.id}.status is invalid`);
  if (!array(claim.requirements, `${claim.id}.requirements`).length) throw new Error(`${claim.id} has no requirements`);
  if (!array(claim.gates, `${claim.id}.gates`).length) throw new Error(`${claim.id} has no gates`);
  for (const id of claim.gates) if (!gateIds.has(id)) throw new Error(`${claim.id} references unknown gate ${id}`);
}
for (const gate of gates) {
  if (!["passed", "failed", "blocked", "stale"].includes(gate.status)) throw new Error(`${gate.id}.status is invalid`);
  if (gate.required !== undefined && typeof gate.required !== "boolean") throw new Error(`${gate.id}.required must be boolean`);
  if (!array(gate.claims, `${gate.id}.claims`).length) throw new Error(`${gate.id} has no claims`);
  if (!array(gate.rejects, `${gate.id}.rejects`).length) throw new Error(`${gate.id} rejects no failure hypothesis`);
  required(gate.boundary, `${gate.id}.boundary`);
  required(gate.commit, `${gate.id}.commit`);
  if (gate.required !== false && gate.commit !== manifest.commit) throw new Error(`${gate.id} is not bound to the tour commit`);
  for (const id of gate.claims) if (!claimIds.has(id)) throw new Error(`${gate.id} references unknown claim ${id}`);
}
if (!manifest.deployment || manifest.deployment.ready !== (manifest.verdict === "ready")) throw new Error("deployment.ready must match verdict");
if (manifest.verdict === "ready" && (!manifest.audit || manifest.audit.verdict !== "pass" || manifest.audit.commit !== manifest.commit)) {
  throw new Error("ready verdict requires a passing audit bound to the tour commit");
}
if (manifest.verdict === "ready" && (gaps.length || claims.some((c) => c.status !== "proven") || gates.some((g) => g.required !== false && g.status !== "passed"))) {
  throw new Error("ready verdict requires no gaps, all claims proven, and all required gates passed");
}

const architecture = manifest.architecture || {};
const implementation = manifest.implementation || { steps: [] };
const qa = manifest.qa || { mode: "unspecified", entrypoints: [], scenarios: [] };
const deployment = manifest.deployment;
const audit = manifest.audit || {};
const badge = manifest.verdict === "ready" ? "ready" : "blocked";

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(manifest.title)} — Work Tour</title>
<style>
:root{color-scheme:light dark;--bg:#f5f7fb;--card:#fff;--text:#172033;--muted:#5b6578;--line:#d9deea;--accent:#3157d5;--good:#13734c;--bad:#a52b32;--code:#eef1f7}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1180px;margin:auto;padding:32px 20px 80px}header,.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;margin-bottom:18px}h1{font-size:clamp(28px,5vw,48px);line-height:1.05;margin:.25rem 0 1rem}h2{font-size:22px;margin:0 0 14px}h3{font-size:16px;margin:18px 0 6px}p{margin:.45rem 0}.eyebrow,.muted{color:var(--muted)}.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-weight:700;font-size:12px}.meta,.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.meta div,.item{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px}.badge{display:inline-block;border-radius:99px;padding:5px 10px;color:#fff;font-weight:750;text-transform:uppercase;font-size:12px}.ready{background:var(--good)}.blocked{background:var(--bad)}table{width:100%;border-collapse:collapse;display:block;overflow:auto}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:10px;min-width:130px}th{font-size:12px;text-transform:uppercase;color:var(--muted)}code{background:var(--code);color:var(--text);border-radius:5px;padding:2px 5px;overflow-wrap:anywhere}a{color:var(--accent)}ul,ol{padding-left:22px}.status-proven,.status-passed{color:var(--good);font-weight:700}.status-partial,.status-unproven,.status-failed,.status-blocked,.status-stale{color:var(--bad);font-weight:700}@media(prefers-color-scheme:dark){:root{--bg:#111827;--card:#182235;--text:#edf2ff;--muted:#aab3c4;--line:#344057;--accent:#9bb1ff;--code:#253047}}@media(max-width:560px){main{padding:16px 10px 50px}header,.card{padding:16px;border-radius:10px}th,td{min-width:120px}}
</style></head><body><main>
<header><p class="eyebrow">Executable-evidence work tour</p><h1>${escapeHtml(manifest.title)}</h1><p>${escapeHtml(manifest.summary)}</p><p><span class="badge ${badge}">${escapeHtml(manifest.verdict)}</span></p><div class="meta"><div><strong>Feature</strong><br>${escapeHtml(manifest.feature)}</div><div><strong>Commit</strong><br><code>${escapeHtml(manifest.commit)}</code></div><div><strong>Branch → base</strong><br>${escapeHtml(manifest.branch)} → ${escapeHtml(manifest.base)}</div><div><strong>Generated</strong><br>${escapeHtml(manifest.generatedAt)}</div></div></header>
<section class="card"><h2>Architecture</h2><div class="grid"><div class="item"><h3>Before</h3><p>${escapeHtml(architecture.before || "Not recorded.")}</p></div><div class="item"><h3>After</h3><p>${escapeHtml(architecture.after || "Not recorded.")}</p></div></div><h3>Boundaries</h3>${list(architecture.boundaries || [])}<h3>Decisions</h3>${(architecture.decisions || []).map((d)=>`<div class="item"><strong>${escapeHtml(d.decision)}</strong><p>${escapeHtml(d.reason)}</p><span class="muted">${escapeHtml(d.source)}</span></div>`).join("") || '<p class="muted">None recorded.</p>'}</section>
<section class="card"><h2>Implementation</h2>${(implementation.steps || []).map((s)=>`<div class="item"><strong>Step ${escapeHtml(s.step)} — ${escapeHtml(s.name)}</strong><p>${escapeHtml(s.outcome)}</p><p><code>${escapeHtml(s.commit)}</code></p>${list(s.files || [])}</div>`).join("") || '<p class="muted">No steps recorded.</p>'}</section>
<section class="card"><h2>Requirement proof</h2><table><thead><tr><th>Claim</th><th>Requirements</th><th>Status</th><th>Gates</th><th>Why this closes</th></tr></thead><tbody>${claims.map((c)=>`<tr><td><strong>${escapeHtml(c.id)}</strong><br>${escapeHtml(c.statement)}</td><td>${escapeHtml(c.requirements.join(", "))}</td><td class="status-${escapeHtml(c.status)}">${escapeHtml(c.status)}</td><td>${escapeHtml(c.gates.join(", "))}</td><td>${escapeHtml(c.explanation || "")}</td></tr>`).join("")}</tbody></table></section>
<section class="card"><h2>Executable gates</h2>${gates.map((g)=>`<div class="item"><p><strong>${escapeHtml(g.id)} — ${escapeHtml(g.kind)}</strong> · <span class="status-${escapeHtml(g.status)}">${escapeHtml(g.status)}</span> · ${g.required === false ? "optional exploration" : "required gate"}</p><p><strong>Run:</strong> <code>${escapeHtml(g.command || "deterministic inspection")}</code></p><p><strong>Observed:</strong> ${escapeHtml(g.proof || "")}</p><p><strong>Rejects:</strong> ${escapeHtml(g.rejects.join(", "))}</p><p><strong>Proof boundary:</strong> ${escapeHtml(g.boundary)}</p><p><strong>Environment:</strong> ${escapeHtml(g.environment || "unspecified")} · <strong>Commit:</strong> <code>${escapeHtml(g.commit)}</code></p><p><strong>Artifact:</strong> ${link(g.artifact || "none")}</p></div>`).join("")}</section>
<section class="card"><h2>QA tour</h2><p><strong>Mode:</strong> ${escapeHtml(qa.mode)}</p><h3>Entrypoints</h3>${(qa.entrypoints || []).map((e)=>`<div class="item"><strong>${escapeHtml(e.label)}</strong><p>${escapeHtml(e.location)}</p><p class="muted">${escapeHtml(e.setup)}</p></div>`).join("") || '<p class="muted">None recorded.</p>'}<h3>Scenarios</h3>${(qa.scenarios || []).map((s)=>`<div class="item"><strong>${escapeHtml(s.id)} — ${escapeHtml(s.title)}</strong><h3>Walkthrough</h3>${list(s.steps || [])}<h3>Expected</h3>${list(s.expected || [])}<p><strong>Automated by:</strong> ${escapeHtml((s.automatedBy || []).join(", ") || "none")}</p><p><strong>Artifacts:</strong> ${(s.artifacts || []).map(link).join(" · ") || "none"}</p></div>`).join("") || '<p class="muted">No QA scenarios recorded.</p>'}</section>
<section class="card"><h2>Deployment safety</h2><p><strong>Ready:</strong> ${deployment.ready ? "yes" : "no"}</p><div class="grid"><div class="item"><h3>Migrations</h3><p>${escapeHtml(deployment.migrations)}</p></div><div class="item"><h3>Configuration</h3><p>${escapeHtml(deployment.configuration)}</p></div><div class="item"><h3>Rollback</h3><p>${escapeHtml(deployment.rollback)}</p></div></div><h3>Observability</h3>${list(deployment.observability || [])}<h3>Residual risks</h3>${list(deployment.residualRisks || [])}</section>
<section class="card"><h2>Independent branch audit</h2><p><strong>Verdict:</strong> ${escapeHtml(audit.verdict || "missing")}</p><p><strong>Iteration:</strong> ${escapeHtml(audit.iteration ?? "n/a")} · <strong>Commit:</strong> <code>${escapeHtml(audit.commit || "unbound")}</code></p><p>${link(audit.artifact || "no audit artifact")}</p></section>
<section class="card"><h2>Evidence gaps</h2>${list(gaps)}</section>
</main></body></html>`;

await writeFile(outputArg, html, "utf8");
console.log(`rendered ${path.resolve(outputArg)} (${manifest.verdict})`);
