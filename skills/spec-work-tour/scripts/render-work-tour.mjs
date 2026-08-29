#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  console.error("usage: render-work-tour.mjs <work-tour.json> <work-tour.html>");
  process.exit(2);
}

const inputPath = path.resolve(inputArg);
const outputPath = path.resolve(outputArg);
const inputDir = path.dirname(inputPath);
const outputDir = path.dirname(outputPath);
const workspaceRoots = readdirSync(process.cwd(), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(process.cwd(), entry.name, ".git")))
  .map((entry) => path.join(process.cwd(), entry.name));

const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const attr = escapeHtml;
const array = (value, name) => {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
};
const required = (value, name) => {
  if (value === undefined || value === null || value === "") throw new Error(`${name} is required`);
  return value;
};
const shortCommit = (value = "") => String(value).slice(0, 10);
const statusClass = (value) => `status--${String(value).replace(/[^a-z-]/g, "")}`;
const renderList = (items, empty = "None recorded.") => items.length
  ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
  : `<p class="muted">${escapeHtml(empty)}</p>`;

const manifest = JSON.parse(await readFile(inputPath, "utf8"));
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
for (const claim of claims) {
  if (claim.status === "proven" && !claim.gates.some((id) => gates.find((gate) => gate.id === id)?.status === "passed")) {
    throw new Error(`${claim.id} is proven but has no passed gate`);
  }
}
if (!manifest.deployment || manifest.deployment.ready !== (manifest.verdict === "ready")) throw new Error("deployment.ready must match verdict");
if (manifest.verdict === "ready" && (!manifest.audit || manifest.audit.verdict !== "pass" || manifest.audit.commit !== manifest.commit)) {
  throw new Error("ready verdict requires a passing audit bound to the tour commit");
}
if (manifest.verdict === "ready" && (gaps.length || claims.some((claim) => claim.status !== "proven") || gates.some((gate) => gate.required !== false && gate.status !== "passed"))) {
  throw new Error("ready verdict requires no gaps, all claims proven, and all required gates passed");
}

const architecture = manifest.architecture || {};
const implementation = manifest.implementation || { steps: [] };
const qa = manifest.qa || { mode: "unspecified", entrypoints: [], scenarios: [] };
const deployment = manifest.deployment;
const audit = manifest.audit || {};
const gateById = Object.fromEntries(gates.map((gate) => [gate.id, gate]));
const requiredGates = gates.filter((gate) => gate.required !== false);
const optionalGates = gates.filter((gate) => gate.required === false);
const residualRisks = deployment.residualRisks || [];
const nonPassingRequired = requiredGates.filter((gate) => gate.status !== "passed");
const nonPassingOptional = optionalGates.filter((gate) => gate.status !== "passed");
const nonProvenClaims = claims.filter((claim) => claim.status !== "proven");
const provenCount = claims.filter((claim) => claim.status === "proven").length;
const passedRequiredCount = requiredGates.filter((gate) => gate.status === "passed").length;

const resolveArtifact = (rawValue) => {
  if (!rawValue) return { label: "none", href: null, exists: false, image: false };
  const raw = String(rawValue);
  if (/^https?:\/\//.test(raw)) return { label: raw, href: raw, exists: true, image: /\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(raw) };
  if (/^[a-z]+:/i.test(raw)) return { label: raw, href: null, exists: false, image: false };
  const pathMatch = raw.match(/^(.+?\.(?:md|json|txt|log|html?|js|mjs|cjs|ts|tsx|jsx|css|ya?ml|png|jpe?g|gif|webp|svg|zip)(?:#[^\s]+)?)(?:\s+.*)?$/i);
  const linkValue = pathMatch ? pathMatch[1] : raw;
  const hashIndex = linkValue.indexOf("#");
  const filePart = hashIndex >= 0 ? linkValue.slice(0, hashIndex) : linkValue;
  const fragment = hashIndex >= 0 ? linkValue.slice(hashIndex) : "";
  const candidates = [
    path.resolve(inputDir, filePart),
    path.resolve(process.cwd(), filePart),
    filePart.startsWith("../.specs/") ? path.resolve(process.cwd(), filePart.slice(3)) : null,
    ...workspaceRoots.map((root) => path.resolve(root, filePart)),
  ].filter(Boolean);
  const target = candidates.find((candidate) => existsSync(candidate) || candidate === outputPath);
  if (!target) return { label: raw, href: null, exists: false, image: false };
  const href = `${path.relative(outputDir, target).split(path.sep).join("/") || path.basename(target)}${fragment}`;
  return { label: raw, href, exists: true, image: /\.(png|jpe?g|gif|webp)$/i.test(filePart) };
};

const artifactLink = (value, label = value) => {
  const artifact = resolveArtifact(value);
  if (!artifact.href) return `<code class="artifact--missing" title="Local artifact was not found when this tour rendered">${escapeHtml(label || "none")}</code>`;
  return `<a href="${attr(artifact.href)}">${escapeHtml(label || artifact.label)}</a>`;
};

const renderArtifactSet = (artifacts, scenarioTitle) => {
  if (!artifacts.length) return '<p class="muted">No artifacts recorded.</p>';
  return `<div class="artifact-set">${artifacts.map((value) => {
    const artifact = resolveArtifact(value);
    if (artifact.image && artifact.href) return `<figure class="qa-image"><a href="${attr(artifact.href)}" target="_blank" rel="noreferrer"><img src="${attr(artifact.href)}" alt="QA evidence for ${attr(scenarioTitle)}" loading="lazy"></a><figcaption>${escapeHtml(value)}</figcaption></figure>`;
    return `<span>${artifactLink(value)}</span>`;
  }).join("")}</div>`;
};

const attentionItems = [
  ...gaps.map((gap) => ({ level: "blocking", kind: "Evidence gap", title: gap })),
  ...nonPassingRequired.map((gate) => ({ level: "blocking", kind: `${gate.id} · required ${gate.kind}`, title: `${gate.status}: ${gate.boundary}`, claim: gate.claims[0] })),
  ...nonProvenClaims.map((claim) => ({ level: "blocking", kind: `${claim.id} · claim`, title: `${claim.status}: ${claim.statement}`, claim: claim.id })),
  ...(audit.verdict === "pass" && audit.commit === manifest.commit ? [] : [{ level: "blocking", kind: "Independent audit", title: "The audit is missing, not passing, or not bound to this commit." }]),
  ...nonPassingOptional.filter((gate) => !nonProvenClaims.some((claim) => claim.gates.includes(gate.id))).map((gate) => ({ level: "follow-up", kind: `${gate.id} · optional ${gate.kind}`, title: `${gate.status}: ${gate.boundary}`, claim: gate.claims[0] })),
  ...residualRisks.map((risk) => ({ level: "follow-up", kind: "Residual risk", title: risk })),
];

const attentionHtml = attentionItems.length
  ? `<div class="attention-list">${attentionItems.map((item) => `<article class="attention-item attention-item--${attr(item.level)}"><span class="attention-kind">${escapeHtml(item.kind)}</span><p>${escapeHtml(item.title)}</p>${item.claim ? `<button type="button" class="text-action" data-claim-select="${attr(item.claim)}">Inspect proof →</button>` : ""}</article>`).join("")}</div>`
  : '<p class="clear-state"><strong>No open attention items.</strong> Required evidence is closed and no residual risk is recorded.</p>';

const claimHasAttention = (claim) => claim.status !== "proven" || claim.gates.some((id) => gateById[id]?.status !== "passed");
const initialClaim = claims.find(claimHasAttention) || claims[0];
const initialScenario = (qa.scenarios || []).find((scenario) => (scenario.automatedBy || []).some((id) => gateById[id]?.status !== "passed")) || (qa.scenarios || [])[0];

const renderGate = (gate) => {
  const gateStatusClass = gate.required === false && gate.status !== "passed" ? "status--stale" : statusClass(gate.status);
  const copyLabel = /^(follow|inspect|review)\b/i.test(gate.command || "") ? "Copy instruction" : "Copy command";
  return `<section class="gate-proof" id="gate-${attr(gate.id)}"><header class="gate-head"><div><span class="evidence-id">${escapeHtml(gate.id)} · ${escapeHtml(gate.kind)}</span><strong class="${gateStatusClass}">${escapeHtml(gate.status)}</strong></div><span class="gate-posture">${gate.required === false ? "Optional exploration" : "Required gate"}</span></header>${gate.command ? `<div class="command"><code>${escapeHtml(gate.command)}</code><button type="button" data-copy-command="${attr(gate.command)}">${copyLabel}</button></div>` : '<p class="muted">Deterministic inspection; no command recorded.</p>'}<dl class="proof-facts"><div><dt>Observed</dt><dd>${escapeHtml(gate.proof || "No proof summary recorded.")}</dd></div><div><dt>Can reject</dt><dd>${escapeHtml(gate.rejects.join(", "))}</dd></div><div><dt>Does not prove</dt><dd>${escapeHtml(gate.boundary)}</dd></div><div><dt>Environment</dt><dd>${escapeHtml(gate.environment || "Unspecified")}</dd></div><div><dt>Commit</dt><dd><code>${escapeHtml(gate.commit)}</code></dd></div><div><dt>Artifact</dt><dd>${artifactLink(gate.artifact || "")}</dd></div></dl></section>`;
};

const claimButtons = claims.map((claim) => `<button type="button" class="claim-select" data-claim-select="${attr(claim.id)}" aria-controls="claim-${attr(claim.id)}" aria-pressed="${claim.id === initialClaim?.id}"><span><strong>${escapeHtml(claim.id)}</strong><span class="${statusClass(claim.status)}">${escapeHtml(claim.status)}</span></span><span>${escapeHtml(claim.statement)}</span><small>${escapeHtml(claim.requirements.join(", "))} · ${escapeHtml(claim.gates.join(", "))}</small></button>`).join("");

const claimPanels = claims.map((claim) => `<article id="claim-${attr(claim.id)}" class="claim-panel" data-claim-panel="${attr(claim.id)}" ${claim.id === initialClaim?.id ? "" : "hidden"}><header class="claim-head"><p class="section-kicker">${escapeHtml(claim.id)} · ${escapeHtml(claim.requirements.join(", "))}</p><h3>${escapeHtml(claim.statement)}</h3><p><span class="${statusClass(claim.status)}">${escapeHtml(claim.status)}</span>${claim.explanation ? ` · ${escapeHtml(claim.explanation)}` : ""}</p></header><div class="gate-stack">${claim.gates.map((id) => renderGate(gateById[id])).join("")}</div></article>`).join("");

const qaButtons = (qa.scenarios || []).map((scenario) => `<button type="button" class="scenario-select" data-scenario-select="${attr(scenario.id)}" aria-controls="scenario-${attr(scenario.id)}" aria-pressed="${scenario.id === initialScenario?.id}"><strong>${escapeHtml(scenario.id)}</strong><span>${escapeHtml(scenario.title)}</span><small>${escapeHtml((scenario.automatedBy || []).join(", ") || "No automated gate")}</small></button>`).join("");

const qaPanels = (qa.scenarios || []).map((scenario) => `<article id="scenario-${attr(scenario.id)}" class="scenario-panel" data-scenario-panel="${attr(scenario.id)}" ${scenario.id === initialScenario?.id ? "" : "hidden"}><header><p class="section-kicker">${escapeHtml(scenario.id)}</p><h3>${escapeHtml(scenario.title)}</h3></header><div class="scenario-columns"><section><h4>Walkthrough</h4>${renderList(scenario.steps || [])}</section><section><h4>Expected observable result</h4>${renderList(scenario.expected || [])}</section></div><div class="scenario-evidence"><span><strong>Covered by</strong> ${escapeHtml((scenario.automatedBy || []).join(", ") || "none")}</span>${renderArtifactSet(scenario.artifacts || [], scenario.title)}</div></article>`).join("");

const implementationRows = (implementation.steps || []).map((step) => `<article class="implementation-row"><span class="step-number">${String(step.step).padStart(2, "0")}</span><div><strong>${escapeHtml(step.name)}</strong><p>${escapeHtml(step.outcome)}</p>${(step.files || []).length ? `<div class="file-links">${step.files.map((file) => artifactLink(file)).join(" · ")}</div>` : '<span class="muted">No file change recorded.</span>'}</div><code>${escapeHtml(shortCommit(step.commit))}</code></article>`).join("");

const styles = `
:root{--ink:#171a21;--muted:#566174;--line:#d6dbe2;--soft:#f4f6f8;--link:#174ea6;--ready:#087443;--blocked:#b42318;--warning:#9a6700;--info:#3f4b5d}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#fff;color:var(--ink);font:15px/1.5 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button{font:inherit;color:inherit}a{color:var(--link);text-underline-offset:3px}a:hover{text-decoration-thickness:2px}a:focus-visible,button:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid #175cd3;outline-offset:3px}.skip{position:absolute;left:-999px;top:8px;background:#fff;border:1px solid var(--ink);padding:8px;z-index:30}.skip:focus{left:8px}.shell{max-width:1500px;margin:0 auto;padding:0 28px}.tour-header{border-bottom:1px solid var(--ink)}.tour-header .shell{padding-top:22px;padding-bottom:20px}.section-kicker{margin:0 0 5px;color:var(--muted);font:700 .7rem/1.25 ui-monospace,SFMono-Regular,Consolas,monospace;text-transform:uppercase;letter-spacing:.06em}.tour-header h1{max-width:1200px;margin:0;font-size:clamp(1.8rem,3.2vw,2.75rem);line-height:1.08;letter-spacing:-.035em}.verdict-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 18px;margin-top:12px}.verdict{font-weight:800;text-transform:uppercase;letter-spacing:.04em}.verdict--ready,.status--proven,.status--passed{color:var(--ready)}.verdict--blocked,.status--unproven,.status--failed,.status--blocked{color:var(--blocked)}.status--partial,.status--stale{color:var(--warning)}.commit-line{color:var(--muted);font-size:.78rem}.commit-line code,.meta-line code,.proof-facts code,.implementation-row>code{background:#eef0f2;padding:2px 5px}.rationale{max-width:1100px;margin-top:10px}.rationale summary{cursor:pointer;font-weight:700;font-size:.8rem}.rationale p{margin:8px 0 0;color:var(--muted)}.meta-line{display:flex;flex-wrap:wrap;gap:5px 18px;margin-top:12px;color:var(--muted);font-size:.74rem}.status-ledger{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));margin:18px 0 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.status-ledger div{padding:9px 12px;border-right:1px solid var(--line)}.status-ledger div:first-child{padding-left:0}.status-ledger div:last-child{border-right:0}.status-ledger dt{color:var(--muted);font-size:.63rem;text-transform:uppercase;letter-spacing:.05em}.status-ledger dd{margin:2px 0 0;font-weight:750;font-size:.8rem}.tour-nav{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.97);border-bottom:1px solid var(--line)}.tour-nav .shell{display:flex;gap:20px;overflow-x:auto}.tour-nav a{padding:10px 0;color:var(--muted);font-size:.72rem;font-weight:750;text-decoration:none;white-space:nowrap}.tour-nav a:hover{color:var(--ink)}.tour-section{padding:26px 0;border-bottom:1px solid var(--line);scroll-margin-top:44px}.section-heading{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-bottom:13px}.section-heading h2{margin:0;font-size:1.2rem;letter-spacing:-.015em}.section-heading p{max-width:720px;margin:0;color:var(--muted);font-size:.78rem}.attention-list{border-top:1px solid var(--ink)}.attention-item{display:grid;grid-template-columns:190px minmax(0,1fr) auto;gap:14px;align-items:start;padding:10px 0;border-bottom:1px solid var(--line)}.attention-item--blocking{border-left:4px solid var(--blocked);padding-left:10px}.attention-item--follow-up{border-left:4px solid var(--warning);padding-left:10px}.attention-kind{color:var(--muted);font-size:.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.04em}.attention-item p{margin:0;font-size:.8rem}.text-action{border:0;background:none;padding:0;color:var(--link);font-size:.72rem;font-weight:750;cursor:pointer}.clear-state{margin:0;border-top:1px solid var(--ready);border-bottom:1px solid var(--line);padding:12px 0}.before-after{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--ink);border-bottom:1px solid var(--line)}.architecture-cell{padding:15px 20px 15px 0}.architecture-cell+ .architecture-cell{padding-left:20px;border-left:1px solid var(--line)}.architecture-cell h3{margin:0 0 6px;font-size:.9rem}.architecture-cell p{margin:0;font-size:.82rem}.boundary-line{display:grid;grid-template-columns:120px 1fr;gap:16px;padding:10px 0;border-bottom:1px solid var(--line)}.boundary-line strong{font-size:.68rem;text-transform:uppercase;letter-spacing:.05em}.boundary-line code{white-space:normal;overflow-wrap:anywhere}.secondary-details{margin-top:12px;border-top:1px solid var(--line)}.secondary-details summary{padding:10px 0;cursor:pointer;font-weight:750;font-size:.78rem}.decision-row{display:grid;grid-template-columns:minmax(230px,.8fr) 1fr auto;gap:14px;padding:10px 0;border-top:1px solid var(--line);font-size:.76rem}.decision-row p{margin:0}.proof-layout,.qa-layout{display:grid;grid-template-columns:minmax(280px,.72fr) minmax(0,1.8fr);gap:28px;align-items:start}.claim-list,.scenario-list{position:sticky;top:56px;max-height:calc(100vh - 76px);overflow:auto;border-top:1px solid var(--ink)}.claim-select,.scenario-select{display:block;width:100%;border:0;border-bottom:1px solid var(--line);background:#fff;padding:10px 8px;text-align:left;cursor:pointer}.claim-select:hover,.scenario-select:hover{background:var(--soft)}.claim-select[aria-pressed="true"],.scenario-select[aria-pressed="true"]{background:var(--soft);box-shadow:inset 3px 0 0 var(--ink)}.claim-select>span:first-child{display:flex;justify-content:space-between;gap:8px}.claim-select>span:nth-child(2),.scenario-select span{display:block;margin-top:4px;font-size:.77rem;line-height:1.3}.claim-select small,.scenario-select small{display:block;margin-top:5px;color:var(--muted);font-size:.62rem}.claim-head{padding-bottom:12px;border-bottom:1px solid var(--ink)}.claim-head h3,.scenario-panel h3{margin:0;font-size:1.25rem;letter-spacing:-.015em}.claim-head p:last-child{margin:7px 0 0;color:var(--muted);font-size:.78rem}.gate-proof{padding:14px 0;border-bottom:1px solid var(--line)}.gate-head,.gate-head>div{display:flex;justify-content:space-between;gap:12px;align-items:center}.evidence-id{font-weight:750;font-size:.82rem}.gate-posture{color:var(--muted);font-size:.67rem}.command{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-top:10px;background:var(--soft);border-left:3px solid var(--info);padding:9px}.command code{overflow-wrap:anywhere}.command button{align-self:start;border:1px solid #8b95a5;background:#fff;padding:5px 8px;font-size:.65rem;font-weight:700;cursor:pointer}.proof-facts{margin:10px 0 0}.proof-facts div{display:grid;grid-template-columns:110px 1fr;gap:12px;padding:7px 0;border-top:1px solid #eceff2}.proof-facts dt{color:var(--muted);font-size:.65rem;text-transform:uppercase;letter-spacing:.04em}.proof-facts dd{margin:0;font-size:.75rem}.artifact--missing{color:var(--blocked);text-decoration:line-through}.entrypoints{border-top:1px solid var(--ink);margin-bottom:20px}.entrypoint{display:grid;grid-template-columns:minmax(180px,.5fr) minmax(240px,1fr) minmax(240px,1fr);gap:14px;padding:9px 0;border-bottom:1px solid var(--line);font-size:.74rem}.entrypoint p{margin:0}.scenario-panel>header{padding-bottom:12px;border-bottom:1px solid var(--ink)}.scenario-columns{display:grid;grid-template-columns:1fr 1fr;gap:22px;padding:14px 0}.scenario-columns h4,.deployment-fact h3{margin:0 0 5px;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}.scenario-columns ul{margin:0;padding-left:19px;font-size:.78rem}.scenario-evidence{border-top:1px solid var(--line);padding-top:10px;font-size:.72rem}.artifact-set{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:7px}.qa-image{width:min(100%,440px);margin:0}.qa-image img{display:block;width:100%;max-height:300px;object-fit:contain;object-position:top;border:1px solid var(--line);background:var(--soft)}.qa-image figcaption{margin-top:4px;color:var(--muted);font-size:.64rem;overflow-wrap:anywhere}.deployment-grid{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--ink);border-bottom:1px solid var(--line)}.deployment-fact{padding:13px 18px 13px 0}.deployment-fact+ .deployment-fact{padding-left:18px;border-left:1px solid var(--line)}.deployment-fact p{margin:0;font-size:.78rem}.operations-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding-top:14px}.operations-grid h3{margin:0;font-size:.82rem}.operations-grid ul{margin:6px 0 0;padding-left:19px;font-size:.76rem}.audit-line{display:grid;grid-template-columns:160px 1fr auto;gap:14px;align-items:center;margin-top:14px;padding:10px 0;border-top:1px solid var(--line);font-size:.74rem}.implementation-row{display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:12px;padding:10px 0;border-top:1px solid var(--line);font-size:.74rem}.implementation-row p{margin:3px 0;color:var(--muted)}.step-number{font:750 .72rem/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}.file-links{font-size:.68rem}.tour-footer{padding:18px 0 38px;color:var(--muted);font-size:.68rem}.tour-footer p{margin:3px 0}[hidden]{display:none!important}
.commit-line code,.proof-facts dd code{overflow-wrap:anywhere}
@media(max-width:900px){.status-ledger{grid-template-columns:repeat(2,1fr)}.status-ledger div{border-bottom:1px solid var(--line)}.proof-layout,.qa-layout{grid-template-columns:1fr}.claim-list,.scenario-list{position:static;max-height:none}.attention-item{grid-template-columns:150px 1fr}.attention-item .text-action{grid-column:2}.entrypoint{grid-template-columns:1fr}.deployment-grid{grid-template-columns:1fr}.deployment-fact,.deployment-fact+ .deployment-fact{padding:11px 0;border-left:0;border-bottom:1px solid var(--line)}.operations-grid{grid-template-columns:1fr}.decision-row{grid-template-columns:1fr}.audit-line{grid-template-columns:1fr}}
@media(max-width:560px){.shell{padding:0 16px}.tour-header .shell{padding-top:16px;padding-bottom:15px}.tour-header h1{font-size:1.7rem}.section-heading{display:block}.section-heading p{margin-top:4px}.status-ledger{grid-template-columns:1fr 1fr}.before-after,.scenario-columns{grid-template-columns:1fr}.architecture-cell,.architecture-cell+ .architecture-cell{padding:12px 0;border-left:0;border-bottom:1px solid var(--line)}.attention-item{grid-template-columns:1fr;gap:5px}.attention-item .text-action{grid-column:1}.proof-facts div{grid-template-columns:1fr;gap:2px}.gate-head,.gate-head>div{align-items:flex-start;flex-direction:column}.command{grid-template-columns:1fr}.implementation-row{grid-template-columns:30px 1fr}.implementation-row>code{grid-column:2}}
@media print{.tour-nav,.text-action,.command button{display:none}.shell{max-width:none;padding:0}.tour-section{break-inside:avoid}.claim-list,.scenario-list{display:none}.proof-layout,.qa-layout{display:block}.claim-panel[hidden],.scenario-panel[hidden]{display:block!important;break-before:page}.secondary-details:not([open])>:not(summary){display:block!important}.secondary-details summary{list-style:none}.claim-panel+ .claim-panel{break-before:page}.tour-footer{padding-bottom:0}}
`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
<title>${escapeHtml(manifest.title)} — Work Tour</title><style>${styles}</style></head><body onbeforeprint="document.querySelectorAll('details').forEach(function(d){d.dataset.printWasOpen=d.open?'1':'0';d.open=true})" onafterprint="document.querySelectorAll('details').forEach(function(d){d.open=d.dataset.printWasOpen==='1';delete d.dataset.printWasOpen})"><a class="skip" href="#attention">Skip to attention items</a>
<header class="tour-header"><div class="shell"><p class="section-kicker">${escapeHtml(manifest.feature)} · executable-evidence work tour</p><h1>${escapeHtml(manifest.title)}</h1><div class="verdict-row"><span class="verdict verdict--${attr(manifest.verdict)}">Evidence verdict · ${escapeHtml(manifest.verdict)}</span><span class="commit-line">Bound to <code>${escapeHtml(manifest.commit)}</code></span></div><details class="rationale"><summary>Why this changed</summary><p>${escapeHtml(manifest.summary)}</p></details><div class="meta-line"><span>${escapeHtml(manifest.branch)} → ${escapeHtml(manifest.base)}</span><span>Generated ${escapeHtml(manifest.generatedAt)}</span><span>Repository ${escapeHtml(manifest.repository || ".")}</span></div><dl class="status-ledger"><div><dt>Required gates</dt><dd class="${passedRequiredCount === requiredGates.length ? "status--passed" : "status--failed"}">${passedRequiredCount}/${requiredGates.length} passed</dd></div><div><dt>Claims</dt><dd class="${provenCount === claims.length ? "status--proven" : "status--partial"}">${provenCount}/${claims.length} proven</dd></div><div><dt>Independent audit</dt><dd class="${audit.verdict === "pass" ? "status--passed" : "status--failed"}">${escapeHtml(audit.verdict || "missing")}</dd></div><div><dt>Deployment</dt><dd class="${deployment.ready ? "status--passed" : "status--blocked"}">${deployment.ready ? "ready" : "not ready"}</dd></div><div><dt>Attention</dt><dd class="${attentionItems.length ? "status--stale" : "status--passed"}">${attentionItems.length} item${attentionItems.length === 1 ? "" : "s"}</dd></div></dl></div></header>
<nav class="tour-nav" aria-label="Work tour sections"><div class="shell"><a href="#attention">Attention</a><a href="#architecture">What changed</a><a href="#proof">Proof</a><a href="#qa">QA</a><a href="#deployment">Deployment</a><a href="#implementation">Implementation log</a></div></nav>
<main><section id="attention" class="tour-section"><div class="shell"><div class="section-heading"><h2>What still needs attention</h2><p>Blocking evidence first, then residual risk and optional follow-up. These items qualify the verdict.</p></div>${attentionHtml}</div></section>
<section id="architecture" class="tour-section"><div class="shell"><div class="section-heading"><h2>What changed</h2><p>The smallest useful before-and-after view of the implemented path.</p></div><div class="before-after"><article class="architecture-cell"><h3>Before</h3><p>${escapeHtml(architecture.before || "Not recorded.")}</p></article><article class="architecture-cell"><h3>After</h3><p>${escapeHtml(architecture.after || "Not recorded.")}</p></article></div>${(architecture.boundaries || []).map((boundary) => `<div class="boundary-line"><strong>System boundary</strong><code>${escapeHtml(boundary)}</code></div>`).join("")}${(architecture.decisions || []).length ? `<details class="secondary-details"><summary>${architecture.decisions.length} architecture decision${architecture.decisions.length === 1 ? "" : "s"}</summary>${architecture.decisions.map((decision) => `<article class="decision-row"><strong>${escapeHtml(decision.decision)}</strong><p>${escapeHtml(decision.reason)}</p><span>${artifactLink(decision.source, decision.source)}</span></article>`).join("")}</details>` : ""}</div></section>
<section id="proof" class="tour-section"><div class="shell"><div class="section-heading"><h2>Evidence that closes the work</h2><p>Select a claim to see the requirement, rerunnable gates, observed proof, and exact proof boundary together.</p></div><div class="proof-layout"><div class="claim-list" aria-label="Claims">${claimButtons}</div><div class="claim-inspector" aria-live="polite">${claimPanels}</div></div></div></section>
<section id="qa" class="tour-section"><div class="shell"><div class="section-heading"><h2>QA walkthrough</h2><p>${escapeHtml(qa.mode)}. Scenarios are exploration output; automated gates establish the verdict.</p></div><div class="entrypoints">${(qa.entrypoints || []).map((entry) => `<article class="entrypoint"><strong>${escapeHtml(entry.label)}</strong><p>${escapeHtml(entry.location)}</p><p class="muted">${escapeHtml(entry.setup)}</p></article>`).join("") || '<p class="muted">No entrypoints recorded.</p>'}</div>${(qa.scenarios || []).length ? `<div class="qa-layout"><div class="scenario-list" aria-label="QA scenarios">${qaButtons}</div><div class="scenario-inspector" aria-live="polite">${qaPanels}</div></div>` : '<p class="muted">No QA scenarios recorded.</p>'}</div></section>
<section id="deployment" class="tour-section"><div class="shell"><div class="section-heading"><h2>Deployment and recovery</h2><p><span class="${deployment.ready ? "status--passed" : "status--blocked"}">${deployment.ready ? "Ready" : "Not ready"}</span> at <code>${escapeHtml(shortCommit(manifest.commit))}</code>.</p></div><div class="deployment-grid"><article class="deployment-fact"><h3>Migrations</h3><p>${escapeHtml(deployment.migrations)}</p></article><article class="deployment-fact"><h3>Configuration</h3><p>${escapeHtml(deployment.configuration)}</p></article><article class="deployment-fact"><h3>Rollback or forward fix</h3><p>${escapeHtml(deployment.rollback)}</p></article></div><div class="operations-grid"><section><h3>Observe after deploy</h3>${renderList(deployment.observability || [], "No observability signal recorded.")}</section><section><h3>Residual risk</h3><p>${residualRisks.length ? `${residualRisks.length} item${residualRisks.length === 1 ? "" : "s"} surfaced in the attention queue above.` : "None recorded."}</p></section></div><div class="audit-line"><strong>Independent audit · ${escapeHtml(audit.verdict || "missing")}</strong><span>Iteration ${escapeHtml(audit.iteration ?? "n/a")} · <code>${escapeHtml(shortCommit(audit.commit || "unbound"))}</code></span>${artifactLink(audit.artifact || "", "Open audit")}</div></div></section>
<section id="implementation" class="tour-section"><div class="shell"><details class="secondary-details"><summary>Implementation log · ${(implementation.steps || []).length} step${(implementation.steps || []).length === 1 ? "" : "s"}</summary>${implementationRows || '<p class="muted">No implementation steps recorded.</p>'}</details></div></section></main>
<footer class="tour-footer"><div class="shell"><p>Commit-bound executable evidence. The HTML projects <code>work-tour.json</code>; it does not replace the underlying artifacts.</p></div></footer>
<script>(()=>{const claimControls=[...document.querySelectorAll('[data-claim-select]')];const claimPanels=[...document.querySelectorAll('[data-claim-panel]')];const scenarioControls=[...document.querySelectorAll('[data-scenario-select]')];const scenarioPanels=[...document.querySelectorAll('[data-scenario-panel]')];const selectClaim=(id,move)=>{for(const panel of claimPanels)panel.hidden=panel.dataset.claimPanel!==id;for(const control of claimControls)if(control.hasAttribute('aria-pressed'))control.setAttribute('aria-pressed',String(control.dataset.claimSelect===id));history.replaceState(null,'','#claim='+encodeURIComponent(id));if(move)document.querySelector('#proof').scrollIntoView({block:'start'})};const selectScenario=(id,move)=>{for(const panel of scenarioPanels)panel.hidden=panel.dataset.scenarioPanel!==id;for(const control of scenarioControls)control.setAttribute('aria-pressed',String(control.dataset.scenarioSelect===id));history.replaceState(null,'','#qa='+encodeURIComponent(id));if(move)document.querySelector('#qa').scrollIntoView({block:'start'})};for(const control of claimControls)control.addEventListener('click',()=>selectClaim(control.dataset.claimSelect,true));for(const control of scenarioControls)control.addEventListener('click',()=>selectScenario(control.dataset.scenarioSelect,true));for(const button of document.querySelectorAll('[data-copy-command]'))button.addEventListener('click',async()=>{const original=button.textContent;try{await navigator.clipboard.writeText(button.dataset.copyCommand);button.textContent='Copied';setTimeout(()=>button.textContent=original,1200)}catch{button.textContent='Copy failed';setTimeout(()=>button.textContent=original,1600)}});const claimMatch=location.hash.match(/^#claim=(.+)$/);const qaMatch=location.hash.match(/^#qa=(.+)$/);if(claimMatch&&claimPanels.some((panel)=>panel.dataset.claimPanel===decodeURIComponent(claimMatch[1])))selectClaim(decodeURIComponent(claimMatch[1]),false);if(qaMatch&&scenarioPanels.some((panel)=>panel.dataset.scenarioPanel===decodeURIComponent(qaMatch[1])))selectScenario(decodeURIComponent(qaMatch[1]),false)})();</script></body></html>`;

await writeFile(outputPath, html, "utf8");
console.log(`rendered ${outputPath} (${manifest.verdict})`);
