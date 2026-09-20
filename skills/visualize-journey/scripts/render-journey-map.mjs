#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { buildJourneyGraph, validateCrossJourneyLinks } from "./journey-graph.mjs";

const SCHEMA = "visualize-journey/v1";
const STAGES = new Set([
  "define",
  "locate",
  "prepare",
  "confirm",
  "execute",
  "monitor",
  "modify",
  "conclude",
]);
const CTA_KINDS = new Set(["primary", "secondary", "destructive", "system"]);
const CTA_LABEL_STATUSES = new Set(["verified", "unknown"]);
const ISSUE_SOURCES = new Set(["confirmed", "inferred", "coverage"]);
const EVIDENCE_KINDS = new Set(["source", "screen", "screenshot", "test", "finding", "document"]);
const TRANSITION_TYPES = new Set([
  "in-place",
  "route",
  "seam",
  "external",
  "automatic",
  "conditional",
  "terminal",
]);
const SEVERITIES = ["critical", "high", "medium", "low", "info"];
const VISUAL_STATUSES = new Set(["captured", "missing", "external", "redirect"]);
const BEHAVIOR_EVIDENCE_STATUSES = new Set(["observed", "partial", "missing"]);

const fail = (message) => {
  console.error(`visualize-journey: ${message}`);
  process.exit(1);
};

const parseArgs = (argv) => {
  const args = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") {
      args.check = true;
      continue;
    }
    if (!["--manifest", "--collection", "--output"].includes(token)) {
      fail(`unknown argument ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${token} requires a value`);
    args[token.slice(2)] = value;
    index += 1;
  }
  if (!args.output) fail("--output is required");
  if (Boolean(args.manifest) === Boolean(args.collection)) {
    fail("provide exactly one of --manifest or --collection");
  }
  return args;
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read JSON ${path}: ${error.message}`);
  }
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const attr = escapeHtml;

const requiredString = (errors, value, path) => {
  if (typeof value !== "string" || !value.trim()) errors.push(`${path} must be a non-empty string`);
};

const ensureArray = (errors, value, path) => {
  if (!Array.isArray(value)) errors.push(`${path} must be an array`);
};

const validateManifest = (manifest) => {
  const errors = [];
  if (manifest?.$schema !== SCHEMA) errors.push(`$schema must be ${SCHEMA}`);

  const journey = manifest?.journey;
  if (!journey || typeof journey !== "object") {
    errors.push("journey must be an object");
  } else {
    for (const key of ["id", "title", "goal", "actor", "owner", "status", "source"]) {
      requiredString(errors, journey[key], `journey.${key}`);
    }
    if (journey.id && !/^JRNY-\d{3}$/.test(journey.id)) errors.push("journey.id must match JRNY-###");
    ensureArray(errors, journey.verifiedAgainst, "journey.verifiedAgainst");
    ensureArray(errors, journey.seams, "journey.seams");
    for (const [index, seam] of (journey.seams || []).entries()) {
      if (!/^SEAM-\d{3}$/.test(seam)) errors.push(`journey.seams[${index}] must match SEAM-###`);
    }
    ensureArray(errors, journey.e2e?.lanes, "journey.e2e.lanes");
    requiredString(errors, journey.e2e?.status, "journey.e2e.status");
    requiredString(errors, journey.e2e?.note, "journey.e2e.note");
  }

  for (const key of ["entry", "terminal"]) {
    const endpoint = manifest?.[key];
    if (!endpoint || typeof endpoint !== "object") {
      errors.push(`${key} must be an object`);
      continue;
    }
    for (const field of ["repo", "route", "label", "detail"]) {
      requiredString(errors, endpoint[field], `${key}.${field}`);
    }
  }

  const behaviorEvidence = manifest?.behaviorEvidence;
  if (!behaviorEvidence || typeof behaviorEvidence !== "object") {
    errors.push("behaviorEvidence must be an object");
  } else {
    if (!BEHAVIOR_EVIDENCE_STATUSES.has(behaviorEvidence.status)) errors.push("behaviorEvidence.status must be observed, partial, or missing");
    requiredString(errors, behaviorEvidence.note, "behaviorEvidence.note");
    ensureArray(errors, behaviorEvidence.sources, "behaviorEvidence.sources");
    for (const [index, source] of (behaviorEvidence.sources || []).entries()) {
      requiredString(errors, source?.label, `behaviorEvidence.sources[${index}].label`);
      requiredString(errors, source?.href, `behaviorEvidence.sources[${index}].href`);
    }
  }

  ensureArray(errors, manifest?.repositories, "repositories");
  ensureArray(errors, manifest?.upstreamSeams, "upstreamSeams");
  ensureArray(errors, manifest?.steps, "steps");
  ensureArray(errors, manifest?.exitPoints, "exitPoints");

  const repositories = Array.isArray(manifest?.repositories) ? manifest.repositories : [];
  const repoIds = new Set();
  for (const [index, repo] of repositories.entries()) {
    for (const field of ["id", "label", "host", "color"]) {
      requiredString(errors, repo?.[field], `repositories[${index}].${field}`);
    }
    if (repo?.id && repoIds.has(repo.id)) errors.push(`duplicate repository id ${repo.id}`);
    if (repo?.id) repoIds.add(repo.id);
    if (repo?.color && !/^#[0-9a-f]{6}$/i.test(repo.color)) {
      errors.push(`repositories[${index}].color must be a six-digit hex color`);
    }
  }
  if (manifest?.entry?.repo && !repoIds.has(manifest.entry.repo)) errors.push("entry.repo is not registered");
  if (manifest?.terminal?.repo && !repoIds.has(manifest.terminal.repo)) errors.push("terminal.repo is not registered");

  for (const [index, seam] of (manifest?.upstreamSeams || []).entries()) {
    const base = `upstreamSeams[${index}]`;
    for (const field of ["id", "type", "fromRepo", "toRepo", "title", "effect", "risk"]) requiredString(errors, seam?.[field], `${base}.${field}`);
    if (seam?.id && !/^SEAM-\d{3}$/.test(seam.id)) errors.push(`${base}.id must match SEAM-###`);
    if (seam?.fromRepo && !repoIds.has(seam.fromRepo)) errors.push(`${base}.fromRepo is not registered`);
    if (seam?.toRepo && !repoIds.has(seam.toRepo)) errors.push(`${base}.toRepo is not registered`);
    ensureArray(errors, seam?.carries, `${base}.carries`);
  }

  const steps = Array.isArray(manifest?.steps) ? manifest.steps : [];
  const stepIds = new Set();
  const issueIds = new Set();
  let primaryCount = 0;
  for (const [index, step] of steps.entries()) {
    const base = `steps[${index}]`;
    for (const field of ["id", "stage", "title", "repo", "host", "route", "userSees", "decision"]) {
      requiredString(errors, step?.[field], `${base}.${field}`);
    }
    if (!Number.isInteger(step?.sequence) || step.sequence !== index + 1) {
      errors.push(`${base}.sequence must equal ${index + 1}`);
    }
    if (step?.id && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(step.id)) errors.push(`${base}.id must be kebab-case`);
    if (step?.id && stepIds.has(step.id)) errors.push(`duplicate step id ${step.id}`);
    if (step?.id) stepIds.add(step.id);
    if (step?.stage && !STAGES.has(step.stage)) errors.push(`${base}.stage is invalid`);
    if (step?.repo && !repoIds.has(step.repo)) errors.push(`${base}.repo is not registered`);
    if (step?.screen != null && !/^SCRN-\d{3}$/.test(step.screen)) errors.push(`${base}.screen must match SCRN-### or be null`);
    for (const field of ["ctas", "establishes", "requires", "issues", "evidence"]) ensureArray(errors, step?.[field], `${base}.${field}`);

    const visual = step?.visual;
    if (!visual || typeof visual !== "object" || !VISUAL_STATUSES.has(visual.status)) {
      errors.push(`${base}.visual.status must be captured, missing, external, or redirect`);
    } else if (visual.status === "captured") {
      requiredString(errors, visual.src, `${base}.visual.src`);
      requiredString(errors, visual.alt, `${base}.visual.alt`);
    } else if (visual.status === "missing") {
      requiredString(errors, visual.note, `${base}.visual.note`);
    }

    for (const [ctaIndex, cta] of (step?.ctas || []).entries()) {
      requiredString(errors, cta?.label, `${base}.ctas[${ctaIndex}].label`);
      if (!CTA_KINDS.has(cta?.kind)) errors.push(`${base}.ctas[${ctaIndex}].kind is invalid`);
      if (cta?.labelStatus && !CTA_LABEL_STATUSES.has(cta.labelStatus)) errors.push(`${base}.ctas[${ctaIndex}].labelStatus is invalid`);
      if (!cta?.destination && !cta?.effect) errors.push(`${base}.ctas[${ctaIndex}] needs destination or effect`);
      if (cta?.labelStatus === "unknown" && !(step?.issues || []).some((issue) => issue.source === "coverage")) errors.push(`${base}.ctas[${ctaIndex}] with unknown label needs a coverage issue on the step`);
      if (cta?.kind === "primary") primaryCount += 1;
    }

    const transition = step?.transition;
    if (!transition || typeof transition !== "object") {
      errors.push(`${base}.transition must be an object`);
    } else {
      if (!TRANSITION_TYPES.has(transition.type)) errors.push(`${base}.transition.type is invalid`);
      requiredString(errors, transition.label, `${base}.transition.label`);
      if (transition.seam && !/^SEAM-\d{3}$/.test(transition.seam)) errors.push(`${base}.transition.seam must match SEAM-###`);
      if (transition.provisional != null && typeof transition.provisional !== "boolean") errors.push(`${base}.transition.provisional must be boolean`);
      if (transition.branches != null) ensureArray(errors, transition.branches, `${base}.transition.branches`);
      for (const [branchIndex, branch] of (transition.branches || []).entries()) {
        const branchBase = `${base}.transition.branches[${branchIndex}]`;
        for (const field of ["label", "condition", "outcome"]) requiredString(errors, branch?.[field], `${branchBase}.${field}`);
        if (!branch?.toStep && !branch?.destination) errors.push(`${branchBase} needs toStep or destination`);
      }
    }

    for (const [issueIndex, issue] of (step?.issues || []).entries()) {
      const issueBase = `${base}.issues[${issueIndex}]`;
      for (const field of ["id", "severity", "title", "consequence", "status", "source", "next"]) {
        requiredString(errors, issue?.[field], `${issueBase}.${field}`);
      }
      if (!SEVERITIES.includes(issue?.severity)) errors.push(`${issueBase}.severity is invalid`);
      if (!ISSUE_SOURCES.has(issue?.source)) errors.push(`${issueBase}.source is invalid`);
      if (issue?.id && issueIds.has(issue.id)) errors.push(`duplicate issue id ${issue.id}`);
      if (issue?.id) issueIds.add(issue.id);
    }

    for (const [evidenceIndex, evidence] of (step?.evidence || []).entries()) {
      requiredString(errors, evidence?.label, `${base}.evidence[${evidenceIndex}].label`);
      requiredString(errors, evidence?.href, `${base}.evidence[${evidenceIndex}].href`);
      requiredString(errors, evidence?.kind, `${base}.evidence[${evidenceIndex}].kind`);
      if (!EVIDENCE_KINDS.has(evidence?.kind)) errors.push(`${base}.evidence[${evidenceIndex}].kind is invalid`);
    }
    if (step?.screen == null && !["redirect", "external"].includes(step?.visual?.status) && !(step?.issues || []).some((issue) => issue.source === "coverage")) {
      errors.push(`${base} has no screen ID and needs a coverage issue`);
    }
  }

  for (const [index, step] of steps.entries()) {
    const transition = step?.transition || {};
    if (index === steps.length - 1 && transition.type !== "terminal") {
      errors.push("the final step transition must be terminal");
    }
    if (index < steps.length - 1 && transition.type === "terminal") {
      errors.push(`steps[${index}] cannot be terminal`);
    }
    if (transition.toStep) {
      const targetIndex = steps.findIndex(({ id }) => id === transition.toStep);
      if (targetIndex < 0) errors.push(`steps[${index}].transition.toStep does not exist`);
      if (targetIndex >= 0 && targetIndex <= index) errors.push(`steps[${index}].transition.toStep must name a later step`);
    }
    for (const [branchIndex, branch] of (transition.branches || []).entries()) {
      if (branch.toStep && !stepIds.has(branch.toStep)) errors.push(`steps[${index}].transition.branches[${branchIndex}].toStep does not exist`);
    }
  }

  for (const [index, exit] of (manifest?.exitPoints || []).entries()) {
    for (const field of ["atStep", "label", "result", "recovery"]) {
      requiredString(errors, exit?.[field], `exitPoints[${index}].${field}`);
    }
    if (exit?.atStep && !stepIds.has(exit.atStep)) errors.push(`exitPoints[${index}].atStep does not exist`);
  }

  if (steps.length === 0) errors.push("steps must contain at least one step");
  if (primaryCount === 0 && !journey?.fullyAutomatic) errors.push("at least one primary CTA is required unless journey.fullyAutomatic is true");
  const declaredSeams = new Set(journey?.seams || []);
  const projectedSeams = new Set([
    ...(manifest?.upstreamSeams || []).map((seam) => seam.id),
    ...steps.map((step) => step?.transition?.seam).filter(Boolean),
  ]);
  for (const seam of declaredSeams) if (!projectedSeams.has(seam)) errors.push(`journey seam ${seam} is not projected`);
  for (const seam of projectedSeams) if (!declaredSeams.has(seam)) errors.push(`projected seam ${seam} is not declared by journey.seams`);
  errors.push(...validateCrossJourneyLinks(manifest));
  return errors;
};

const isLocalReference = (value) =>
  typeof value === "string" &&
  !value.startsWith("#") &&
  !/^[a-z][a-z0-9+.-]*:/i.test(value);

const collectReferences = (manifest) => {
  const refs = [{ label: "journey.source", value: manifest.journey.source }];
  for (const source of (manifest.behaviorEvidence?.sources || [])) refs.push({ label: `behaviorEvidence.${source.label}`, value: source.href });
  for (const step of manifest.steps) {
    if (step.visual?.status === "captured") refs.push({ label: `${step.id}.visual`, value: step.visual.src });
    for (const issue of step.issues) {
      if (issue.href) refs.push({ label: `${issue.id}.href`, value: issue.href });
    }
    for (const evidence of step.evidence) refs.push({ label: `${step.id}.${evidence.label}`, value: evidence.href });
  }
  return refs;
};

const validateReferences = (manifest, outputPath) => {
  const base = dirname(resolve(outputPath));
  return collectReferences(manifest)
    .filter(({ value }) => isLocalReference(value))
    .filter(({ value }) => !existsSync(resolve(base, decodeURIComponent(value.split("#", 1)[0]))))
    .map(({ label, value }) => `${label}: ${value}`);
};

const normalizeContext = (item) =>
  typeof item === "string" ? { key: item, status: "present", note: "" } : item;

const renderContext = (items, emptyLabel) => {
  if (!items.length) return `<span class="muted">${escapeHtml(emptyLabel)}</span>`;
  return `<ul class="context-list">${items.map((raw) => {
    const item = normalizeContext(raw);
    return `<li class="context context--${attr(item.status || "present")}"><code>${escapeHtml(item.key)}</code>${item.note ? `<span>${escapeHtml(item.note)}</span>` : ""}</li>`;
  }).join("")}</ul>`;
};

const issueCounts = (manifest) => {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const step of manifest.steps) for (const issue of step.issues) counts[issue.severity] += 1;
  return counts;
};

const totalIssues = (manifest) => manifest.steps.reduce((sum, step) => sum + step.issues.length, 0);
const capturedCount = (manifest) => manifest.steps.filter((step) => step.visual.status === "captured").length;
const missingCount = (manifest) => manifest.steps.filter((step) => step.visual.status === "missing").length;
const externalCount = (manifest) => manifest.steps.filter((step) => step.visual.status === "external").length;
const redirectCount = (manifest) => manifest.steps.filter((step) => step.visual.status === "redirect").length;
const seamIds = (manifest) => new Set([
  ...(manifest.upstreamSeams || []).map((seam) => seam.id),
  ...manifest.steps.map((step) => step.transition.seam).filter(Boolean),
]);

const renderVisual = (step) => {
  const visual = step.visual;
  if (visual.status === "captured") {
    return `<figure class="visual visual--captured">
      <a href="${attr(visual.src)}" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot for ${attr(step.title)}">
        <img src="${attr(visual.src)}" alt="${attr(visual.alt)}" loading="lazy">
      </a>
      ${visual.note ? `<figcaption>${escapeHtml(visual.note)}</figcaption>` : ""}
    </figure>`;
  }
  const title = visual.status === "external" ? "External surface" : visual.status === "redirect" ? "Redirect-only step" : "Screenshot missing";
  return `<div class="visual visual--${attr(visual.status)}" role="note">
    <strong>${title}</strong>
    <p>${escapeHtml(visual.note || "No product-owned capture is available.")}</p>
    ${visual.src ? `<a href="${attr(visual.src)}" target="_blank" rel="noreferrer">Open external reference</a>` : ""}
  </div>`;
};

const renderCtas = (ctas) => {
  if (!ctas.length) return `<p class="muted">No user-operated CTA. The system advances this step.</p>`;
  return `<ul class="cta-list">${ctas.map((cta) => `<li class="cta cta--${attr(cta.kind)}">
    <span class="cta__label">${escapeHtml(cta.label)}${cta.labelStatus === "unknown" ? `<small>Label not captured</small>` : ""}</span>
    <span class="cta__kind">${escapeHtml(cta.kind)}</span>
    <span class="cta__result">${escapeHtml(cta.destination || cta.effect)}${cta.destination && cta.effect ? ` — ${escapeHtml(cta.effect)}` : ""}</span>
  </li>`).join("")}</ul>`;
};

const renderTransition = (transition) => `<div class="transition">
  <div class="transition__title">
    <span>${escapeHtml(transition.label)}</span>
    <span>${transition.seam ? `<code>${escapeHtml(transition.seam)}</code>` : `<span class="tag">${escapeHtml(transition.type)}</span>`}${transition.provisional ? `<span class="tag tag--provisional">Provisional seam</span>` : ""}</span>
  </div>
  <div class="transition__facts">
    <div><strong>Carries</strong>${renderContext(transition.carries || [], "No user context recorded")}</div>
    <div><strong>Loses</strong>${renderContext((transition.loses || []).map((key) => ({ key, status: "missing" })), "Nothing recorded as lost")}</div>
  </div>
  ${(transition.branches || []).length ? `<div class="transition__branches"><strong>Conditional paths</strong>${transition.branches.map((branch) => `<div class="branch"><b>${escapeHtml(branch.label)}</b><span>${escapeHtml(branch.condition)}</span><span>${escapeHtml(branch.outcome)}</span><code>${escapeHtml(branch.toStep || branch.destination)}</code></div>`).join("")}</div>` : ""}
</div>`;

const renderUpstreamSeams = (manifest, reposById) => {
  if (!(manifest.upstreamSeams || []).length) return "";
  return `<div class="upstream"><h3>Before the user arrives</h3><p>These registered seams determine what is true at the journey entry.</p>${manifest.upstreamSeams.map((seam) => `<article><div><code>${escapeHtml(seam.id)}</code><strong>${escapeHtml(seam.title)}</strong><span>${escapeHtml(reposById[seam.fromRepo].label)} → ${escapeHtml(reposById[seam.toRepo].label)} · ${escapeHtml(seam.type)}</span></div><p>${escapeHtml(seam.effect)}</p><p class="upstream__risk"><strong>Risk:</strong> ${escapeHtml(seam.risk)}</p><div><strong>Carries</strong>${renderContext(seam.carries, "No input recorded")}</div></article>`).join("")}</div>`;
};

const renderIssues = (issues) => {
  if (!issues.length) return `<p class="no-issues">No issue attached to this step.</p>`;
  return `<div class="issue-stack">${issues.map((issue) => `<article class="issue issue--${attr(issue.severity)}">
    <div class="issue__head">
      <span class="severity">${escapeHtml(issue.severity)}</span>
      <code>${escapeHtml(issue.id)}</code>
      <span class="issue__status">${escapeHtml(issue.status)}</span>
    </div>
    <h4>${escapeHtml(issue.title)}</h4>
    <p>${escapeHtml(issue.consequence)}</p>
    <p class="issue__next"><strong>Investigate next:</strong> ${escapeHtml(issue.next)}</p>
    <p class="issue__source">Source: ${issue.href ? `<a href="${attr(issue.href)}">${escapeHtml(issue.source)}</a>` : escapeHtml(issue.source)}</p>
  </article>`).join("")}</div>`;
};

const renderEvidence = (evidence) => {
  if (!evidence.length) return `<span class="muted">No linked evidence</span>`;
  return `<ul class="evidence-list">${evidence.map((item) => `<li><a href="${attr(item.href)}">${escapeHtml(item.label)}</a><span>${escapeHtml(item.kind)}</span></li>`).join("")}</ul>`;
};

const screenStatusLabel = (step) => {
  if (step.screen) return escapeHtml(step.screen);
  if (step.visual.status === "redirect") return "Redirect only";
  if (step.visual.status === "external") return "External surface";
  return "No SCRN";
};

const renderStep = (step, repo) => `<article id="${attr(step.id)}" class="step-card" data-repo="${attr(step.repo)}" data-has-issues="${step.issues.length ? "true" : "false"}" style="--repo:${attr(repo.color)}">
  <header class="step-card__header">
    <div class="step-number" aria-label="Step ${step.sequence}">${String(step.sequence).padStart(2, "0")}</div>
    <div>
      <p class="eyebrow">${escapeHtml(step.stage)} · ${escapeHtml(repo.label)}</p>
      <h3>${escapeHtml(step.title)}</h3>
      <p class="route"><span>${escapeHtml(step.host)}</span><code>${escapeHtml(step.route)}</code>${step.screen ? `<a href="#evidence-${attr(step.id)}">${escapeHtml(step.screen)}</a>` : `<span class="${step.visual.status === "captured" || step.visual.status === "missing" ? "inventory-gap" : "tag"}">${screenStatusLabel(step)}</span>`}</p>
    </div>
    <div class="step-status">${step.issues.length ? `<span class="issue-count">${step.issues.length} issue${step.issues.length === 1 ? "" : "s"}</span>` : `<span class="clear">No issue</span>`}</div>
  </header>
  <div class="step-card__body">
    ${renderVisual(step)}
    <div class="step-copy">
      <section><h4>User sees</h4><p>${escapeHtml(step.userSees)}</p></section>
      <section><h4>User decides</h4><p>${escapeHtml(step.decision)}</p></section>
      <section><h4>CTAs and system actions</h4>${renderCtas(step.ctas)}</section>
      <div class="context-grid">
        <section><h4>Establishes</h4>${renderContext(step.establishes, "No ledger fact")}</section>
        <section><h4>Requires</h4>${renderContext(step.requires, "No prior fact")}</section>
      </div>
    </div>
  </div>
  ${renderTransition(step.transition)}
  <section class="step-issues"><h4>Issues at this step</h4>${renderIssues(step.issues)}</section>
  <footer id="evidence-${attr(step.id)}"><strong>Evidence</strong>${renderEvidence(step.evidence)}</footer>
</article>`;

const renderSwimlane = (manifest, reposById) => {
  const columns = manifest.steps.length;
  const stageRow = manifest.steps.map((step) => `<div class="swim-stage" style="grid-column:${step.sequence + 1}"><span>${String(step.sequence).padStart(2, "0")}</span>${escapeHtml(step.stage)}</div>`).join("");
  const rows = manifest.repositories.map((repo, repoIndex) => {
    const nodes = manifest.steps.map((step) => {
      if (step.repo !== repo.id) return `<div class="swim-empty" style="grid-column:${step.sequence + 1}" aria-hidden="true"></div>`;
      const highest = SEVERITIES.find((severity) => step.issues.some((issue) => issue.severity === severity));
      return `<a href="#${attr(step.id)}" class="swim-node" data-repo="${attr(repo.id)}" data-has-issues="${step.issues.length ? "true" : "false"}" style="grid-column:${step.sequence + 1};--repo:${attr(repo.color)}">
        <strong>${escapeHtml(step.title)}</strong>
        <code>${escapeHtml(step.route)}</code>
        <span>${screenStatusLabel(step)}</span>
        ${highest ? `<em class="severity severity--${highest}">${highest}</em>` : ""}
      </a>`;
    }).join("");
    return `<div class="swim-row" style="--row:${repoIndex + 2}">
      <div class="swim-repo" style="grid-column:1;--repo:${attr(repo.color)}"><strong>${escapeHtml(repo.label)}</strong><span>${escapeHtml(repo.host)}</span></div>
      ${nodes}
    </div>`;
  }).join("");
  return `<div class="swim-scroll" tabindex="0" aria-label="Journey repository swimlane; scroll horizontally for all steps">
    <div class="swim-grid" style="--columns:${columns}">
      <div class="swim-corner">Repository</div>
      ${stageRow}
      ${rows}
    </div>
  </div>`;
};

const sharedStyles = `
  :root{color-scheme:light;--ink:#111827;--muted:#596274;--line:#cbd1da;--paper:#fff;--ground:#f3f5f7;--critical:#7f1d1d;--high:#b42318;--medium:#9a6700;--low:#175cd3;--info:#475467;--ok:#18794e;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--ground);color:var(--ink);line-height:1.5}a{color:#174ea6;text-underline-offset:3px}a:hover{text-decoration-thickness:2px}a:focus-visible,button:focus-visible,input:focus-visible,[tabindex]:focus-visible{outline:3px solid #2563eb;outline-offset:3px}.skip{position:absolute;left:-999px;top:8px;background:#fff;padding:8px;z-index:20}.skip:focus{left:8px}.shell{max-width:1480px;margin:0 auto;padding:0 28px}.topbar{background:#111827;color:#fff;border-bottom:5px solid #f2c94c}.topbar .shell{padding-top:30px;padding-bottom:30px}.kicker,.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:.74rem;font-weight:750}.kicker{color:#f2c94c;margin:0 0 8px}.topbar h1{font-size:clamp(2rem,4vw,4.25rem);line-height:1.02;letter-spacing:-.045em;margin:0;max-width:1000px}.topbar .goal{max-width:920px;color:#d7dce4;font-size:1.05rem;margin:18px 0 0}.meta-line{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:18px;color:#aeb6c4;font-size:.88rem}.meta-line a{color:#fff}.section{padding:42px 0;border-bottom:1px solid var(--line)}.section h2{font-size:1.45rem;margin:0 0 8px;letter-spacing:-.02em}.section-intro{max-width:780px;color:var(--muted);margin:0 0 22px}.overview-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);border:1px solid var(--line)}.endpoint{background:var(--paper);padding:22px;border-top:5px solid var(--repo)}.endpoint .label{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:750}.endpoint h2{font-size:1.35rem;margin:7px 0}.endpoint code,.route code,.swim-node code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#eef1f4;padding:2px 5px;color:#182230}.metrics{display:grid;grid-template-columns:repeat(5,minmax(100px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin-top:18px}.metric{background:var(--paper);padding:14px}.metric strong{display:block;font-size:1.8rem;line-height:1}.metric span{display:block;color:var(--muted);font-size:.78rem;margin-top:6px}.controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:20px 0}.controls button{min-height:44px;border:1px solid #9aa3b2;background:#fff;color:#1f2937;padding:8px 13px;font:inherit;font-weight:650;cursor:pointer}.controls button[aria-pressed="true"]{background:#111827;color:#fff;border-color:#111827}.controls .issue-toggle{margin-left:auto}.repo-key{display:flex;flex-wrap:wrap;gap:8px 16px;margin:12px 0}.repo-key span{display:inline-flex;align-items:center;gap:7px;font-size:.82rem}.repo-key i{width:12px;height:12px;background:var(--repo);display:inline-block}.swim-scroll{overflow-x:auto;border:1px solid var(--line);background:#fff}.swim-grid{display:grid;grid-template-columns:150px repeat(var(--columns),minmax(150px,1fr));min-width:calc(150px + var(--columns) * 150px)}.swim-corner,.swim-stage,.swim-repo,.swim-node,.swim-empty{border-right:1px solid #dfe3e8;border-bottom:1px solid #dfe3e8}.swim-corner,.swim-stage{padding:10px;background:#e9edf2;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;font-weight:750}.swim-stage span{display:block;color:var(--muted);font-size:.68rem}.swim-row{display:contents}.swim-repo{padding:14px 10px;border-left:5px solid var(--repo);background:#f8f9fb}.swim-repo strong,.swim-repo span{display:block}.swim-repo span{font-size:.72rem;color:var(--muted)}.swim-node{margin:8px;padding:10px;text-decoration:none;border:1px solid var(--repo);border-top:5px solid var(--repo);background:#fff;min-height:104px}.swim-node strong,.swim-node code,.swim-node span{display:block}.swim-node strong{font-size:.82rem;line-height:1.25}.swim-node code{font-size:.68rem;margin:7px 0 4px;overflow:hidden;text-overflow:ellipsis}.swim-node span{font-size:.68rem;color:var(--muted)}.swim-node em{display:inline-block;margin-top:7px}.swim-empty{background:#fafbfc}.steps{display:grid;gap:24px}.step-card{background:#fff;border:1px solid var(--line);border-top:7px solid var(--repo)}.step-card__header{display:grid;grid-template-columns:auto 1fr auto;gap:16px;align-items:start;padding:20px;border-bottom:1px solid var(--line)}.step-number{font:800 1.35rem/1 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--repo);padding-top:4px}.eyebrow{color:var(--repo);margin:0 0 5px}.step-card h3{font-size:1.55rem;line-height:1.15;margin:0}.route{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin:9px 0 0;color:var(--muted);font-size:.8rem}.inventory-gap{background:#fff3cd;color:#684d00;padding:2px 5px}.step-status span{display:inline-block;padding:5px 8px;font-size:.75rem;font-weight:750}.issue-count{background:#fee4e2;color:#912018}.clear{background:#dcfae6;color:#085d3a}.step-card__body{display:grid;grid-template-columns:minmax(300px,.9fr) minmax(360px,1.1fr);gap:0;border-bottom:1px solid var(--line)}.visual{margin:0;min-height:300px;background:#e7ebef;border-right:1px solid var(--line);display:flex;flex-direction:column;justify-content:center}.visual a{display:block}.visual img{display:block;width:100%;height:340px;object-fit:contain;background:#dde2e8}.visual figcaption{padding:9px 12px;font-size:.75rem;color:var(--muted);background:#f6f7f9}.visual--missing,.visual--external{padding:42px;text-align:center;background:#f4f5f7;border:2px dashed #98a2b3}.visual--missing strong,.visual--external strong{font-size:1.2rem}.visual--missing p,.visual--external p{max-width:420px;margin:8px auto;color:var(--muted)}.step-copy{padding:24px}.step-copy section{margin-bottom:20px}.step-copy h4,.step-issues>h4{font-size:.78rem;text-transform:uppercase;letter-spacing:.07em;margin:0 0 7px}.step-copy p{margin:0}.cta-list,.context-list,.evidence-list{list-style:none;padding:0;margin:0}.cta-list{display:grid;gap:7px}.cta{display:grid;grid-template-columns:auto auto 1fr;align-items:center;gap:8px;border:1px solid var(--line);padding:9px}.cta__label{font-weight:750}.cta__kind{text-transform:uppercase;font-size:.62rem;letter-spacing:.06em;padding:3px 5px}.cta__result{font-size:.78rem;color:var(--muted);text-align:right}.cta--primary{border-left:5px solid #111827}.cta--primary .cta__kind{background:#111827;color:#fff}.cta--secondary{border-left:5px solid #667085}.cta--secondary .cta__kind,.cta--system .cta__kind{background:#e5e7eb}.cta--destructive{border-left:5px solid var(--high)}.cta--destructive .cta__kind{background:var(--high);color:#fff}.cta--system{border-left:5px dashed #667085}.context-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.context-list{display:flex;flex-wrap:wrap;gap:6px}.context{border:1px solid #b8c0cc;padding:4px 6px;font-size:.72rem}.context span{display:block;color:var(--muted);margin-top:3px}.context--missing{border-color:#d92d20;background:#fef3f2}.context--proposed{border-style:dashed;background:#fffaeb}.transition{padding:18px 20px;background:#f7f8fa;border-bottom:1px solid var(--line)}.transition__title{display:flex;gap:10px;justify-content:space-between;align-items:center;font-weight:750}.transition__title code,.tag{font-size:.72rem;background:#dde3ea;padding:3px 6px}.transition__facts{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:12px}.transition__facts strong{display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}.step-issues{padding:20px;border-bottom:1px solid var(--line)}.issue-stack{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}.issue{border:1px solid var(--line);border-left:7px solid var(--issue);padding:13px}.issue--critical{--issue:var(--critical)}.issue--high{--issue:var(--high)}.issue--medium{--issue:var(--medium)}.issue--low{--issue:var(--low)}.issue--info{--issue:var(--info)}.issue__head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:.7rem}.severity{text-transform:uppercase;font-weight:800;color:var(--issue)}.severity--critical{--issue:var(--critical)}.severity--high{--issue:var(--high)}.severity--medium{--issue:var(--medium)}.severity--low{--issue:var(--low)}.severity--info{--issue:var(--info)}.issue__status{margin-left:auto;color:var(--muted)}.issue h4{font-size:1rem;text-transform:none;letter-spacing:0;margin:9px 0 5px}.issue p{font-size:.84rem;margin:5px 0}.issue__next{padding-top:5px;border-top:1px solid #e5e7eb}.issue__source{color:var(--muted)}.no-issues{margin:0;color:var(--ok);font-weight:650}.step-card footer{display:flex;gap:14px;align-items:flex-start;padding:14px 20px;background:#fbfcfd;font-size:.78rem}.evidence-list{display:flex;flex-wrap:wrap;gap:6px 13px}.evidence-list li{display:flex;gap:5px}.evidence-list span{color:var(--muted)}.issue-rollup{display:grid;gap:10px}.issue-rollup .issue{background:#fff}.exit-table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line)}.exit-table th,.exit-table td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:11px}.exit-table th{background:#e9edf2;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}.footer{padding:28px 0 46px;color:var(--muted);font-size:.82rem}.muted{color:var(--muted)}[hidden]{display:none!important}
  .step-card,.step-card__header>div,.step-card__body>*{min-width:0}.visual figcaption,.route,.step-copy,.transition,.step-issues,.step-card footer{overflow-wrap:anywhere}.visual--redirect{padding:42px;text-align:center;background:#f4f5f7;border:2px dashed #667085}.visual--redirect strong{font-size:1.2rem}.visual--redirect p{max-width:420px;margin:8px auto;color:var(--muted)}.cta__label small{display:block;color:var(--high);font-size:.65rem;font-weight:750}.tag--provisional{margin-left:6px;border:1px dashed #667085;background:#fff}.transition__branches{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}.transition__branches>strong{display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}.branch{display:grid;grid-template-columns:minmax(100px,.6fr) minmax(180px,1fr) minmax(240px,1.3fr) auto;gap:8px;padding:9px;border:1px solid var(--line);background:#fff}.branch+ .branch{margin-top:6px}.branch span{font-size:.78rem;color:var(--muted)}.upstream{margin-top:18px;padding:18px;border:1px solid var(--line);background:#fff}.upstream h3{margin:0;font-size:1.05rem}.upstream>p{margin:4px 0 14px;color:var(--muted)}.upstream article{display:grid;grid-template-columns:minmax(210px,.7fr) minmax(260px,1fr) minmax(260px,1fr) minmax(220px,.8fr);gap:16px;padding:14px;border-top:4px solid #667085;background:#f8f9fb}.upstream article>div:first-child strong,.upstream article>div:first-child span{display:block}.upstream article p{margin:0}.upstream__risk{color:var(--high)}
  .footer p{overflow-wrap:anywhere}
  @media(max-width:820px){.shell{padding:0 16px}.overview-grid,.step-card__body,.transition__facts,.context-grid{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}.step-card__header{grid-template-columns:auto 1fr}.step-status{grid-column:2}.visual{border-right:0;border-bottom:1px solid var(--line)}.visual img{height:auto;max-height:480px}.cta{grid-template-columns:1fr auto}.cta__result{grid-column:1/-1;text-align:left}.controls .issue-toggle{margin-left:0}.exit-table{display:block;overflow-x:auto}.topbar h1{font-size:2.35rem}.branch,.upstream article{grid-template-columns:1fr}}
  @media print{body{background:#fff}.topbar{background:#fff;color:#000;border-bottom:3px solid #000}.topbar .kicker,.topbar .goal,.meta-line{color:#222}.meta-line a{color:#000}.controls{display:none}.section{break-inside:auto;padding:24px 0}.step-card{break-inside:avoid}.swim-scroll{overflow:visible}.swim-grid{min-width:0}.visual img{max-height:250px}.shell{max-width:none;padding:0}.footer{padding-bottom:0}}
`;

const renderJourney = (manifest) => {
  const reposById = Object.fromEntries(manifest.repositories.map((repo) => [repo.id, repo]));
  const counts = issueCounts(manifest);
  const allIssues = manifest.steps.flatMap((step) => step.issues.map((issue) => ({ ...issue, step })));
  const filters = manifest.repositories.map((repo) => `<button type="button" data-repo-filter="${attr(repo.id)}" aria-pressed="false" style="border-left:5px solid ${attr(repo.color)}">${escapeHtml(repo.label)}</button>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(manifest.journey.id)} — ${escapeHtml(manifest.journey.title)} · Operator map</title>
  <style>${sharedStyles}</style>
</head>
<body>
  <a class="skip" href="#journey-steps">Skip to journey steps</a>
  <header class="topbar">
    <div class="shell">
      <p class="kicker">Journey operator map · ${escapeHtml(manifest.journey.id)}</p>
      <h1>${escapeHtml(manifest.journey.title)}</h1>
      <p class="goal">${escapeHtml(manifest.journey.goal)}</p>
      <div class="meta-line">
        <span>Actor: ${escapeHtml(manifest.journey.actor)}</span>
        <span>Owner: ${escapeHtml(manifest.journey.owner)}</span>
        <span>Status: ${escapeHtml(manifest.journey.status)}</span>
        <span>E2E: ${escapeHtml(manifest.journey.e2e.status)} · ${escapeHtml(manifest.journey.e2e.lanes.join(", "))}</span>
        <a href="${attr(manifest.journey.source)}">Canonical journey page</a>
      </div>
    </div>
  </header>
  <main>
    <section class="section"><div class="shell">
      <div class="overview-grid">
        <article class="endpoint" style="--repo:${attr(reposById[manifest.entry.repo].color)}"><span class="label">Begins in ${escapeHtml(reposById[manifest.entry.repo].label)}</span><h2>${escapeHtml(manifest.entry.label)}</h2><code>${escapeHtml(manifest.entry.route)}</code><p>${escapeHtml(manifest.entry.detail)}</p></article>
        <article class="endpoint" style="--repo:${attr(reposById[manifest.terminal.repo].color)}"><span class="label">Ends in ${escapeHtml(reposById[manifest.terminal.repo].label)}</span><h2>${escapeHtml(manifest.terminal.label)}</h2><code>${escapeHtml(manifest.terminal.route)}</code><p>${escapeHtml(manifest.terminal.detail)}</p></article>
      </div>
      <div class="metrics" aria-label="Journey summary metrics">
        <div class="metric"><strong>${manifest.steps.length}</strong><span>User-perceivable steps</span></div>
        <div class="metric"><strong>${manifest.repositories.length}</strong><span>Repositories and systems</span></div>
        <div class="metric"><strong>${seamIds(manifest).size}</strong><span>Registered seams shown</span></div>
        <div class="metric"><strong>${totalIssues(manifest)}</strong><span>Issues and gaps</span></div>
        <div class="metric"><strong>${capturedCount(manifest)}/${manifest.steps.length}</strong><span>Steps with captures</span></div>
      </div>
      ${renderUpstreamSeams(manifest, reposById)}
    </div></section>

    <section class="section"><div class="shell">
      <h2>Repository swimlane</h2>
      <p class="section-intro">Read left to right. Color identifies ownership; issue labels identify the highest severity at each step.</p>
      <div class="repo-key">${manifest.repositories.map((repo) => `<span style="--repo:${attr(repo.color)}"><i></i>${escapeHtml(repo.label)} · ${escapeHtml(repo.host)}</span>`).join("")}</div>
      ${renderSwimlane(manifest, reposById)}
    </div></section>

    <section id="journey-steps" class="section"><div class="shell">
      <h2>Step-by-step operator view</h2>
      <p class="section-intro">Inspect the visible surface, decision, CTA, context contract, handoff, and issues at the same point in the journey.</p>
      <div class="controls" aria-label="Journey filters">
        <button type="button" data-repo-filter="all" aria-pressed="true">All systems</button>
        ${filters}
        <button type="button" class="issue-toggle" data-issues-only aria-pressed="false">Show issue steps</button>
      </div>
      <div class="steps">${manifest.steps.map((step) => renderStep(step, reposById[step.repo])).join("")}</div>
      <p id="filter-empty" class="visual visual--missing" hidden>No steps match the selected filters.</p>
    </div></section>

    <section class="section"><div class="shell">
      <h2>Issue rollup</h2>
      <p class="section-intro">${counts.critical} critical · ${counts.high} high · ${counts.medium} medium · ${counts.low} low · ${counts.info} information or coverage gaps.</p>
      <div class="issue-rollup">${allIssues.length ? allIssues.map(({ step, ...issue }) => `<article class="issue issue--${attr(issue.severity)}"><div class="issue__head"><span class="severity">${escapeHtml(issue.severity)}</span><code>${escapeHtml(issue.id)}</code><a href="#${attr(step.id)}">Step ${step.sequence}: ${escapeHtml(step.title)}</a><span class="issue__status">${escapeHtml(issue.status)}</span></div><h3>${escapeHtml(issue.title)}</h3><p>${escapeHtml(issue.consequence)}</p><p class="issue__next"><strong>Investigate next:</strong> ${escapeHtml(issue.next)}</p></article>`).join("") : `<p class="no-issues">No issues are attached to this journey projection.</p>`}</div>
    </div></section>

    <section class="section"><div class="shell">
      <h2>Exit and abandonment points</h2>
      <table class="exit-table"><thead><tr><th>Where</th><th>Exit</th><th>State left behind</th><th>Recovery</th></tr></thead><tbody>${manifest.exitPoints.map((exit) => {
        const step = manifest.steps.find(({ id }) => id === exit.atStep);
        return `<tr><td><a href="#${attr(step.id)}">${String(step.sequence).padStart(2, "0")} · ${escapeHtml(step.title)}</a></td><td>${escapeHtml(exit.label)}</td><td>${escapeHtml(exit.result)}</td><td>${escapeHtml(exit.recovery)}</td></tr>`;
      }).join("")}</tbody></table>
    </div></section>
  </main>
  <footer class="footer"><div class="shell">
    <p><strong>Derived artifact.</strong> The <a href="${attr(manifest.journey.source)}">canonical journey page</a> and journey registry own the facts. Verified against ${escapeHtml(manifest.journey.verifiedAgainst.join("; "))}.</p>
    <p>${escapeHtml(manifest.journey.e2e.note)} External surfaces: ${externalCount(manifest)}. Redirect-only steps: ${redirectCount(manifest)}. Missing captures: ${missingCount(manifest)}.</p>
  </div></footer>
  <script>
    (() => {
      const buttons = [...document.querySelectorAll('[data-repo-filter]')];
      const issueButton = document.querySelector('[data-issues-only]');
      const cards = [...document.querySelectorAll('.step-card')];
      const nodes = [...document.querySelectorAll('.swim-node')];
      const empty = document.querySelector('#filter-empty');
      let repo = 'all';
      let issuesOnly = false;
      const apply = () => {
        let visible = 0;
        for (const item of [...cards, ...nodes]) {
          const showRepo = repo === 'all' || item.dataset.repo === repo;
          const showIssue = !issuesOnly || item.dataset.hasIssues === 'true';
          item.hidden = !(showRepo && showIssue);
          if (cards.includes(item) && !item.hidden) visible += 1;
        }
        empty.hidden = visible !== 0;
      };
      buttons.forEach((button) => button.addEventListener('click', () => {
        repo = button.dataset.repoFilter;
        buttons.forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate === button)));
        apply();
      }));
      issueButton.addEventListener('click', () => {
        issuesOnly = !issuesOnly;
        issueButton.setAttribute('aria-pressed', String(issuesOnly));
        issueButton.textContent = issuesOnly ? 'Show all steps' : 'Show issue steps';
        apply();
      });
    })();
  </script>
</body>
</html>`;
};

const operatorStyles = `
  :root{color-scheme:light;--ink:#17191d;--muted:#5b6472;--line:#d7dce2;--soft:#f5f6f7;--high:#b42318;--critical:#7f1d1d;--medium:#956500;--low:#175cd3;--info:#596274;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#fff;color:var(--ink);line-height:1.45}button,input,select{font:inherit}a{color:#174ea6;text-underline-offset:3px}a:hover{text-decoration-thickness:2px}button{color:inherit}.muted{color:var(--muted)}a:focus-visible,button:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid #175cd3;outline-offset:3px}.skip{position:absolute;left:-999px;top:8px;background:#fff;border:1px solid var(--ink);padding:8px;z-index:30}.skip:focus{left:8px}.shell{max-width:1500px;margin:0 auto;padding:0 28px}.operator-header{border-bottom:1px solid var(--ink)}.operator-header .shell{padding-top:22px;padding-bottom:20px}.operator-id{margin:0 0 5px;color:var(--muted);font:700 .72rem/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;text-transform:uppercase;letter-spacing:.06em}.operator-header h1{margin:0;font-size:clamp(1.85rem,3vw,2.8rem);line-height:1.08;letter-spacing:-.035em}.operator-goal{max-width:1000px;margin:9px 0 0;font-size:1rem}.operator-meta{display:flex;flex-wrap:wrap;gap:5px 18px;margin-top:12px;color:var(--muted);font-size:.78rem}.operator-route{display:flex;flex-wrap:wrap;gap:7px 12px;align-items:center;margin-top:10px;font-size:.82rem}.operator-route code,.route-line code,.node-seam,.context-chip code,.branch-target{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#eef0f2;padding:2px 5px}.operator-route .arrow{color:var(--muted)}.section{padding:28px 0;border-bottom:1px solid var(--line)}.section-heading{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:12px}.section-heading h2{margin:0;font-size:1.15rem;letter-spacing:-.015em}.section-heading p{margin:0;color:var(--muted);font-size:.8rem}.upstream-note{display:grid;grid-template-columns:auto auto minmax(180px,.7fr) minmax(260px,1fr) minmax(260px,1fr);gap:8px 12px;align-items:start;padding:9px 0;border-top:1px solid var(--line);font-size:.76rem}.upstream-note:first-of-type{border-top:0}.upstream-note__label{font-weight:750;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}.upstream-note__risk{color:var(--high)}.journey-scroll{overflow-x:auto;padding-bottom:8px}.journey-grid{display:grid;grid-template-columns:120px repeat(var(--columns),minmax(108px,1fr));grid-auto-rows:auto;min-width:calc(120px + var(--columns) * 108px);align-items:stretch}.journey-corner,.step-axis{padding:7px 6px;border-bottom:1px solid var(--line);font-size:.65rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}.step-axis b{display:block;color:var(--ink);font:700 .72rem/1.2 ui-monospace,SFMono-Regular,Consolas,monospace}.lane-label{padding:12px 10px 12px 0;border-top:2px solid var(--repo);align-self:stretch}.lane-label strong,.lane-label span{display:block}.lane-label strong{font-size:.82rem}.lane-label span{font-size:.66rem;color:var(--muted)}.lane-empty{min-height:158px;border-top:1px solid #eceff2}.journey-node{position:relative;min-width:0;min-height:158px;margin:5px 4px;padding:7px;border:1px solid var(--line);border-top:3px solid var(--repo);background:#fff;text-align:left;cursor:pointer}.journey-node:hover{border-color:#7d8794}.journey-node[aria-pressed="true"]{outline:2px solid var(--ink);outline-offset:-2px}.node-top{display:flex;justify-content:space-between;gap:4px;align-items:start}.node-number{font:750 .68rem/1 ui-monospace,SFMono-Regular,Consolas,monospace}.node-surface{color:var(--muted);font-size:.57rem;text-align:right}.node-thumb{height:50px;margin:6px 0;background:var(--soft);display:flex;align-items:center;justify-content:center;overflow:hidden;color:var(--muted);font-size:.62rem;text-align:center}.node-thumb img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}.journey-node strong{display:block;font-size:.72rem;line-height:1.22}.node-action{display:block;margin-top:5px;color:var(--muted);font-size:.61rem;line-height:1.2}.node-seam{display:inline-block;margin-top:5px;font-size:.55rem}.node-loss{display:block;margin-top:4px;color:var(--high);font-size:.56rem;line-height:1.2}.node-risk{display:block;margin-top:5px;font-size:.58rem;font-weight:800;text-transform:uppercase}.severity--critical{color:var(--critical)}.severity--high{color:var(--high)}.severity--medium{color:var(--medium)}.severity--low{color:var(--low)}.severity--info{color:var(--info)}.branch-summary{margin-top:10px;border-top:1px solid var(--line)}.branch-line{display:grid;grid-template-columns:minmax(180px,.55fr) 1fr;gap:12px;padding:8px 0;border-bottom:1px solid #eceff2;font-size:.72rem}.branch-line>strong{font-size:.72rem}.branch-options{display:flex;flex-wrap:wrap;gap:5px 14px}.branch-options span{color:var(--muted)}.branch-options b{color:var(--ink)}.analysis-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(330px,.85fr);gap:30px;align-items:start}.step-inspector{min-width:0}.inspector-panel{min-width:0}.inspector-header{padding-bottom:12px;border-bottom:1px solid var(--ink)}.inspector-kicker{margin:0 0 4px;color:var(--muted);font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;font-weight:750}.inspector-header h2{margin:0;font-size:1.65rem;letter-spacing:-.025em}.route-line{display:flex;flex-wrap:wrap;gap:5px 9px;align-items:center;margin:7px 0 0;color:var(--muted);font-size:.75rem}.surface-tag{padding:2px 5px;background:#eef0f2;color:var(--muted)}.inspector-main{display:grid;grid-template-columns:minmax(280px,.9fr) minmax(320px,1.1fr);gap:22px;padding:18px 0}.inspector-visual{margin:0;min-width:0}.inspector-visual a{display:block;border:1px solid var(--line);background:var(--soft)}.inspector-visual img{display:block;width:100%;height:300px;object-fit:contain;object-position:top}.inspector-visual figcaption{margin-top:6px;color:var(--muted);font-size:.68rem;overflow-wrap:anywhere}.visual-status{min-height:220px;border:1px dashed #8b95a5;background:var(--soft);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center}.visual-status strong{font-size:.95rem}.visual-status p{max-width:440px;margin:6px 0 0;color:var(--muted);font-size:.78rem}.inspector-copy section+section{margin-top:16px}.field-label{display:block;margin-bottom:4px;color:var(--muted);font-size:.67rem;text-transform:uppercase;letter-spacing:.06em;font-weight:750}.inspector-copy p{margin:0;font-size:.9rem}.action-list,.context-list,.evidence-list,.local-risks{list-style:none;padding:0;margin:0}.action-list{border-top:1px solid var(--line)}.action-row{display:grid;grid-template-columns:minmax(120px,.55fr) minmax(180px,1fr);gap:10px;padding:8px 0;border-bottom:1px solid var(--line)}.action-row strong{font-size:.78rem}.action-row small{display:block;color:var(--high)}.action-kind{display:inline-block;margin-left:5px;color:var(--muted);font-size:.58rem;text-transform:uppercase}.action-result{color:var(--muted);font-size:.72rem}.inspector-context{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:15px 0;border-top:1px solid var(--line)}.context-list{display:flex;flex-wrap:wrap;gap:5px}.context-chip{border:1px solid #aeb6c1;padding:4px 6px;font-size:.66rem}.context-chip span{display:block;max-width:240px;color:var(--muted);margin-top:2px}.context-chip--missing{border-color:var(--high)}.context-chip--proposed{border-style:dashed}.handoff{padding:15px 0;border-top:1px solid var(--line)}.handoff-title{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px}.handoff-title strong{font-size:.88rem}.handoff-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:10px}.handoff-list{margin:0;padding-left:18px;font-size:.72rem}.handoff-list--loss{color:var(--high)}.conditional-paths{margin-top:12px}.conditional-row{display:grid;grid-template-columns:minmax(110px,.4fr) minmax(180px,.8fr) minmax(220px,1fr);gap:8px;padding:7px 0;border-top:1px solid #eceff2;font-size:.7rem}.conditional-row span{color:var(--muted)}.local-risks{margin-top:12px;border-top:1px solid var(--line)}.local-risk{display:grid;grid-template-columns:auto minmax(160px,.7fr) 1fr;gap:8px;padding:8px 0;border-bottom:1px solid #eceff2;font-size:.7rem}.local-risk strong{font-size:.72rem}.local-risk span:last-child{color:var(--muted)}.inspector-evidence{padding-top:12px;border-top:1px solid var(--line)}.evidence-list{display:flex;flex-wrap:wrap;gap:5px 14px;font-size:.7rem}.evidence-list span{color:var(--muted);margin-left:3px}.work-queue{position:sticky;top:16px;border-top:2px solid var(--ink)}.work-queue h2{margin:11px 0 3px;font-size:1.1rem}.queue-intro{margin:0 0 10px;color:var(--muted);font-size:.74rem}.behavior-evidence{padding:9px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:.7rem}.behavior-evidence strong{display:block;text-transform:uppercase;letter-spacing:.05em}.behavior-evidence--missing strong{color:var(--high)}.behavior-evidence p{margin:3px 0 0;color:var(--muted)}.work-list{margin-top:4px}.work-item{border-bottom:1px solid var(--line)}.work-focus{display:block;width:100%;padding:10px 0;border:0;background:#fff;text-align:left;cursor:pointer}.work-focus:hover .work-title{text-decoration:underline}.work-meta{display:flex;gap:7px;align-items:center;font-size:.62rem}.work-step{color:var(--muted)}.work-title{display:block;margin-top:4px;font-size:.8rem}.work-consequence{display:block;margin-top:3px;color:var(--muted);font-size:.7rem}.work-next{display:block;margin-top:5px;font-size:.69rem}.work-source{display:inline-block;margin-bottom:9px;font-size:.64rem}.coverage-details{margin-top:10px;border-top:1px solid var(--line)}.coverage-details summary{padding:9px 0;cursor:pointer;font-size:.76rem;font-weight:700}.recovery-details summary{cursor:pointer;font-weight:750}.recovery-details>p{color:var(--muted);font-size:.76rem}.table-scroll{overflow-x:auto}.recovery-table{width:100%;border-collapse:collapse;font-size:.72rem}.recovery-table th,.recovery-table td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--line)}.recovery-table th{padding-top:12px;color:var(--muted);font-size:.64rem;text-transform:uppercase;letter-spacing:.05em}.operator-footer{padding:18px 0 36px;color:var(--muted);font-size:.68rem}.operator-footer p{margin:3px 0;overflow-wrap:anywhere}[hidden]{display:none!important}
  .journey-grid{grid-template-columns:112px repeat(var(--columns),132px);min-width:calc(112px + var(--columns) * 132px)}.journey-corner,.lane-label{position:sticky;left:0;background:#fff}.journey-corner{z-index:5}.lane-label{z-index:4;box-shadow:1px 0 0 var(--line)}.lane-empty{height:180px;min-height:0}.journey-node{height:170px;min-height:0;overflow:hidden}.node-thumb{height:42px;margin:5px 0}.journey-node strong{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-height:1.18}.node-action,.node-loss,.node-risk{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical}.node-action{margin-top:4px;line-height:1.15;-webkit-line-clamp:1}.node-seam{margin-top:4px}.node-loss{margin-top:3px;line-height:1.15;-webkit-line-clamp:1}.node-risk{margin-top:4px;line-height:1.15;-webkit-line-clamp:2}
  @media(max-width:980px){.analysis-layout{grid-template-columns:1fr}.work-queue{position:static}.inspector-main{grid-template-columns:1fr}.upstream-note{grid-template-columns:auto auto 1fr}.upstream-note__effect,.upstream-note__risk{grid-column:1/-1}.branch-line{grid-template-columns:1fr}.section-heading{align-items:start;flex-direction:column;gap:3px}}
  @media(max-width:560px){.shell{padding:0 16px}.operator-header .shell{padding-top:16px;padding-bottom:15px}.operator-header h1{font-size:1.75rem}.section{padding:22px 0}.inspector-context,.handoff-grid{grid-template-columns:1fr}.action-row,.conditional-row,.local-risk{grid-template-columns:1fr}.inspector-visual img{height:auto;max-height:360px}.operator-meta{display:grid;gap:3px}.upstream-note{grid-template-columns:1fr}.upstream-note__effect,.upstream-note__risk{grid-column:auto}}
  @media print{.shell{max-width:none;padding:0}.operator-header{border-bottom:2px solid #000}.journey-scroll{overflow:visible}.journey-grid{min-width:0;grid-template-columns:90px repeat(var(--columns),1fr)}.journey-node{margin:2px;min-height:120px}.node-thumb{display:none}.analysis-layout{display:block}.work-queue{position:static;break-before:page}.inspector-panel[hidden]{display:block!important;break-before:page}.recovery-details:not([open])>:not(summary){display:block!important}.operator-footer{padding-bottom:0}}
`;

const highestIssueSeverity = (step) => SEVERITIES.find((severity) => step.issues.some((issue) => issue.severity === severity));

const primaryStepAction = (step) => step.ctas.find((cta) => cta.kind === "primary") || step.ctas.find((cta) => cta.kind === "system") || step.ctas[0];

const renderOperatorThumbnail = (step) => {
  if (step.visual.status === "captured") return `<div class="node-thumb"><img src="${attr(step.visual.src)}" alt="" loading="lazy"></div>`;
  const label = step.visual.status === "external" ? "External" : step.visual.status === "redirect" ? "Redirect" : "No capture";
  return `<div class="node-thumb"><span>${label}</span></div>`;
};

const renderJourneyNode = (step, repo, selected) => {
  const highest = highestIssueSeverity(step);
  const action = primaryStepAction(step);
  const losses = (step.transition.loses || []).slice(0, 2);
  return `<button type="button" class="journey-node" data-step-select="${attr(step.id)}" aria-controls="panel-${attr(step.id)}" aria-pressed="${selected ? "true" : "false"}" style="grid-column:${step.sequence + 1};--repo:${attr(repo.color)}">
    <span class="node-top"><span class="node-number">${String(step.sequence).padStart(2, "0")}</span><span class="node-surface">${screenStatusLabel(step)}</span></span>
    ${renderOperatorThumbnail(step)}
    <strong>${escapeHtml(step.title)}</strong>
    ${action ? `<span class="node-action">→ ${escapeHtml(action.label)}</span>` : `<span class="node-action">→ automatic</span>`}
    ${step.transition.seam ? `<code class="node-seam">${escapeHtml(step.transition.seam)}</code>` : ""}
    ${losses.length ? `<span class="node-loss">− ${escapeHtml(losses.join(" · − "))}</span>` : ""}
    ${highest ? `<span class="node-risk severity--${attr(highest)}">${escapeHtml(highest)} · ${escapeHtml(step.issues.find((issue) => issue.severity === highest).title)}</span>` : ""}
  </button>`;
};

const renderJourneyPath = (manifest, reposById) => {
  const axes = manifest.steps.map((step) => `<div class="step-axis" style="grid-column:${step.sequence + 1}"><b>${String(step.sequence).padStart(2, "0")}</b>${escapeHtml(step.stage)}</div>`).join("");
  const rows = manifest.repositories.map((repo) => {
    const cells = manifest.steps.map((step) => step.repo === repo.id
      ? renderJourneyNode(step, repo, step.sequence === 1)
      : `<div class="lane-empty" style="grid-column:${step.sequence + 1}" aria-hidden="true"></div>`).join("");
    return `<div class="lane-label" style="--repo:${attr(repo.color)}"><strong>${escapeHtml(repo.label)}</strong><span>${escapeHtml(repo.host)}</span></div>${cells}`;
  }).join("");
  const branches = manifest.steps.filter((step) => (step.transition.branches || []).length).map((step) => `<div class="branch-line"><strong>${String(step.sequence).padStart(2, "0")} · ${escapeHtml(step.title)}</strong><div class="branch-options">${step.transition.branches.map((branch) => `<span><b>${escapeHtml(branch.label)}</b> → ${escapeHtml(branch.toStep ? manifest.steps.find((candidate) => candidate.id === branch.toStep)?.title || branch.toStep : branch.destination)}</span>`).join("")}</div></div>`).join("");
  return `<div class="journey-scroll" tabindex="0" aria-label="Journey path by repository; scroll horizontally when needed"><div class="journey-grid" style="--columns:${manifest.steps.length}"><div class="journey-corner">System</div>${axes}${rows}</div></div>${branches ? `<div class="branch-summary"><span class="field-label">Conditional paths</span>${branches}</div>` : ""}`;
};

const renderUpstreamNotes = (manifest, reposById) => (manifest.upstreamSeams || []).map((seam) => `<div class="upstream-note"><span class="upstream-note__label">Before entry</span><code>${escapeHtml(seam.id)}</code><strong>${escapeHtml(seam.title)}</strong><span class="upstream-note__effect">${escapeHtml(reposById[seam.fromRepo].label)} → ${escapeHtml(reposById[seam.toRepo].label)}. ${escapeHtml(seam.effect)}</span><span class="upstream-note__risk"><strong>Risk:</strong> ${escapeHtml(seam.risk)}</span></div>`).join("");

const renderInspectorVisual = (step) => {
  if (step.visual.status === "captured") return `<figure class="inspector-visual"><a href="${attr(step.visual.src)}" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot for ${attr(step.title)}"><img src="${attr(step.visual.src)}" alt="${attr(step.visual.alt)}" loading="lazy"></a>${step.visual.note ? `<figcaption>${escapeHtml(step.visual.note)}</figcaption>` : ""}</figure>`;
  const label = step.visual.status === "external" ? "External surface" : step.visual.status === "redirect" ? "Redirect-only step" : "Screenshot missing";
  return `<div class="visual-status"><strong>${label}</strong><p>${escapeHtml(step.visual.note || "No product-owned capture is available.")}</p></div>`;
};

const renderOperatorActions = (ctas) => {
  if (!ctas.length) return `<p class="muted">The system advances automatically.</p>`;
  return `<ul class="action-list">${ctas.map((cta) => `<li class="action-row"><strong>${escapeHtml(cta.label)}${cta.labelStatus === "unknown" ? `<small>Label not captured</small>` : ""}<span class="action-kind">${escapeHtml(cta.kind)}</span></strong><span class="action-result">${escapeHtml(cta.destination || cta.effect)}${cta.destination && cta.effect ? ` — ${escapeHtml(cta.effect)}` : ""}</span></li>`).join("")}</ul>`;
};

const renderOperatorContext = (items, empty) => {
  if (!items.length) return `<span class="muted">${escapeHtml(empty)}</span>`;
  return `<ul class="context-list">${items.map((raw) => { const item = normalizeContext(raw); return `<li class="context-chip context-chip--${attr(item.status || "present")}"><code>${escapeHtml(item.key)}</code>${item.note ? `<span>${escapeHtml(item.note)}</span>` : ""}</li>`; }).join("")}</ul>`;
};

const renderInspectorTransition = (transition) => `<section class="handoff"><div class="handoff-title"><strong>${escapeHtml(transition.label)}</strong><span>${transition.seam ? `<code>${escapeHtml(transition.seam)}</code>` : `<span class="surface-tag">${escapeHtml(transition.type)}</span>`}</span></div><div class="handoff-grid"><div><span class="field-label">Carries forward</span><ul class="handoff-list">${(transition.carries || []).map((item) => `<li>${escapeHtml(typeof item === "string" ? item : item.key)}</li>`).join("") || `<li class="muted">No context recorded</li>`}</ul></div><div><span class="field-label">Lost or hidden</span><ul class="handoff-list handoff-list--loss">${(transition.loses || []).map((item) => `<li>${escapeHtml(typeof item === "string" ? item : item.key)}</li>`).join("") || `<li class="muted">Nothing recorded as lost</li>`}</ul></div></div>${(transition.branches || []).length ? `<div class="conditional-paths"><span class="field-label">Conditional paths</span>${transition.branches.map((branch) => `<div class="conditional-row"><strong>${escapeHtml(branch.label)}</strong><span>${escapeHtml(branch.condition)}</span><span>${escapeHtml(branch.outcome)} <code class="branch-target">${escapeHtml(branch.toStep || branch.destination)}</code></span></div>`).join("")}</div>` : ""}</section>`;

const renderLocalRisks = (issues) => issues.length ? `<section><span class="field-label">Risk at this step</span><ul class="local-risks">${issues.map((issue) => `<li class="local-risk"><span class="severity--${attr(issue.severity)}"><strong>${escapeHtml(issue.severity)}</strong></span><strong>${escapeHtml(issue.title)}</strong><span><b>Investigate:</b> ${escapeHtml(issue.next)}</span></li>`).join("")}</ul></section>` : "";

const renderOperatorEvidence = (evidence) => evidence.length ? `<ul class="evidence-list">${evidence.map((item) => `<li><a href="${attr(item.href)}">${escapeHtml(item.label)}</a><span>${escapeHtml(item.kind)}</span></li>`).join("")}</ul>` : `<span class="muted">No linked evidence</span>`;

const renderInspectorPanel = (step, repo, selected) => `<article id="panel-${attr(step.id)}" class="inspector-panel" data-step-panel="${attr(step.id)}" ${selected ? "" : "hidden"}><header class="inspector-header"><p class="inspector-kicker">Step ${String(step.sequence).padStart(2, "0")} · ${escapeHtml(step.stage)} · ${escapeHtml(repo.label)}</p><h2>${escapeHtml(step.title)}</h2><p class="route-line"><span>${escapeHtml(step.host)}</span><code>${escapeHtml(step.route)}</code><span class="surface-tag">${screenStatusLabel(step)}</span></p></header><div class="inspector-main">${renderInspectorVisual(step)}<div class="inspector-copy"><section><span class="field-label">User sees</span><p>${escapeHtml(step.userSees)}</p></section><section><span class="field-label">User decides</span><p>${escapeHtml(step.decision)}</p></section><section><span class="field-label">Actions</span>${renderOperatorActions(step.ctas)}</section></div></div><div class="inspector-context"><section><span class="field-label">Established here</span>${renderOperatorContext(step.establishes, "No ledger fact established")}</section><section><span class="field-label">Required here</span>${renderOperatorContext(step.requires, "No prior fact required")}</section></div>${renderInspectorTransition(step.transition)}${renderLocalRisks(step.issues)}<footer class="inspector-evidence"><span class="field-label">Evidence</span>${renderOperatorEvidence(step.evidence)}</footer></article>`;

const renderWorkItem = ({ issue, step }) => `<article class="work-item"><button type="button" class="work-focus" data-step-select="${attr(step.id)}" aria-controls="panel-${attr(step.id)}"><span class="work-meta"><strong class="severity--${attr(issue.severity)}">${escapeHtml(issue.severity)}</strong><span class="work-step">Step ${String(step.sequence).padStart(2, "0")} · ${escapeHtml(step.title)}</span></span><strong class="work-title">${escapeHtml(issue.title)}</strong><span class="work-consequence">${escapeHtml(issue.consequence)}</span><span class="work-next"><b>Investigate next:</b> ${escapeHtml(issue.next)}</span></button>${issue.href ? `<a class="work-source" href="${attr(issue.href)}">${escapeHtml(issue.source)} evidence</a>` : ""}</article>`;

const renderPriorityWork = (manifest) => {
  const issues = manifest.steps.flatMap((step) => step.issues.map((issue) => ({ issue, step }))).sort((a, b) => SEVERITIES.indexOf(a.issue.severity) - SEVERITIES.indexOf(b.issue.severity) || a.step.sequence - b.step.sequence);
  const priority = issues.filter(({ issue }) => ["critical", "high", "medium"].includes(issue.severity));
  const coverage = issues.filter(({ issue }) => ["low", "info"].includes(issue.severity));
  return `<aside class="work-queue" aria-labelledby="priority-work-title"><h2 id="priority-work-title">Priority work</h2><p class="queue-intro">Implementation risks ordered by severity. Select an item to inspect its journey step.</p><div class="behavior-evidence behavior-evidence--${attr(manifest.behaviorEvidence.status)}"><strong>Observed behavior · ${escapeHtml(manifest.behaviorEvidence.status)}</strong><p>${escapeHtml(manifest.behaviorEvidence.note)}</p>${manifest.behaviorEvidence.sources.length ? renderOperatorEvidence(manifest.behaviorEvidence.sources.map((source) => ({ ...source, kind: "behavior" }))) : ""}</div><div class="work-list">${priority.map(renderWorkItem).join("") || `<p class="muted">No critical, high, or medium risks recorded.</p>`}</div>${coverage.length ? `<details class="coverage-details"><summary>Evidence and coverage gaps</summary>${coverage.map(renderWorkItem).join("")}</details>` : ""}</aside>`;
};

const renderRecoveryPaths = (manifest) => `<details class="recovery-details"><summary>Recovery and abandonment paths</summary><p>Exceptional paths are also encoded on the journey spine when they branch from the default flow.</p><div class="table-scroll"><table class="recovery-table"><thead><tr><th>Where</th><th>Exit</th><th>State left behind</th><th>Recovery</th></tr></thead><tbody>${manifest.exitPoints.map((exit) => { const step = manifest.steps.find(({ id }) => id === exit.atStep); return `<tr><td><button type="button" class="work-focus" data-step-select="${attr(step.id)}">${String(step.sequence).padStart(2, "0")} · ${escapeHtml(step.title)}</button></td><td>${escapeHtml(exit.label)}</td><td>${escapeHtml(exit.result)}</td><td>${escapeHtml(exit.recovery)}</td></tr>`; }).join("")}</tbody></table></div></details>`;

const renderJourneyInstrument = (manifest) => {
  const reposById = Object.fromEntries(manifest.repositories.map((repo) => [repo.id, repo]));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(manifest.journey.id)} — ${escapeHtml(manifest.journey.title)} · Operator map</title><style>${operatorStyles}</style></head><body><a class="skip" href="#journey-path">Skip to journey path</a><header class="operator-header"><div class="shell"><p class="operator-id">${escapeHtml(manifest.journey.id)} · journey analysis</p><h1>${escapeHtml(manifest.journey.title)}</h1><p class="operator-goal">${escapeHtml(manifest.journey.goal)}</p><div class="operator-meta"><span>Actor · ${escapeHtml(manifest.journey.actor)}</span><span>Owner · ${escapeHtml(manifest.journey.owner)}</span><span>Status · ${escapeHtml(manifest.journey.status)}</span><span>E2E · ${escapeHtml(manifest.journey.e2e.status)} · ${escapeHtml(manifest.journey.e2e.lanes.join(", "))}</span><a href="${attr(manifest.journey.source)}">Canonical journey</a></div><div class="operator-route"><strong>Begins</strong><span>${escapeHtml(reposById[manifest.entry.repo].label)} · ${escapeHtml(manifest.entry.label)}</span><code>${escapeHtml(manifest.entry.route)}</code><span class="arrow">→</span><strong>Ends</strong><span>${escapeHtml(reposById[manifest.terminal.repo].label)} · ${escapeHtml(manifest.terminal.label)}</span><code>${escapeHtml(manifest.terminal.route)}</code></div></div></header><main><section id="journey-path" class="section"><div class="shell"><div class="section-heading"><h2>Journey path</h2><p>Select a step to inspect its surface, decision, context, and evidence.</p></div>${renderUpstreamNotes(manifest, reposById)}${renderJourneyPath(manifest, reposById)}</div></section><section id="step-analysis" class="section"><div class="shell analysis-layout"><div class="step-inspector" aria-live="polite">${manifest.steps.map((step, index) => renderInspectorPanel(step, reposById[step.repo], index === 0)).join("")}</div>${renderPriorityWork(manifest)}</div></section><section class="section"><div class="shell">${renderRecoveryPaths(manifest)}</div></section></main><footer class="operator-footer"><div class="shell"><p>Derived from the <a href="${attr(manifest.journey.source)}">canonical journey</a>. Verified against ${escapeHtml(manifest.journey.verifiedAgainst.join("; "))}.</p><p>${escapeHtml(manifest.journey.e2e.note)}</p></div></footer><script>(()=>{const controls=[...document.querySelectorAll('[data-step-select]')];const panels=[...document.querySelectorAll('[data-step-panel]')];const select=(id,move)=>{for(const panel of panels)panel.hidden=panel.dataset.stepPanel!==id;for(const control of controls)if(control.hasAttribute('aria-pressed'))control.setAttribute('aria-pressed',String(control.dataset.stepSelect===id));history.replaceState(null,'','#step='+encodeURIComponent(id));if(move)document.querySelector('#step-analysis').scrollIntoView({block:'start'})};for(const control of controls)control.addEventListener('click',()=>select(control.dataset.stepSelect,true));const match=location.hash.match(/^#step=(.+)$/);if(match&&panels.some(panel=>panel.dataset.stepPanel===decodeURIComponent(match[1])))select(decodeURIComponent(match[1]),false)})();</script></body></html>`;
};

const findManifests = (collection) => readdirSync(collection, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(collection, entry.name, "manifest.json"))
  .filter(existsSync);

const journeyHref = (manifestPath, collectionDir) => relative(collectionDir, join(dirname(manifestPath), "index.html")).split("\\").join("/");

const renderCollection = (manifests, outputPath) => {
  const collectionDir = dirname(resolve(outputPath));
  const entryRepositories = new Map();
  const cards = manifests.map(({ manifest, path }) => {
    const counts = issueCounts(manifest);
    const href = journeyHref(path, collectionDir);
    const entryRepo = manifest.repositories.find(({ id }) => id === manifest.entry.repo);
    entryRepositories.set(entryRepo.id, entryRepo.label);
    const searchText = [manifest.journey.id, manifest.journey.title, manifest.journey.goal, manifest.journey.actor, manifest.journey.owner, entryRepo.label].join(" ").toLowerCase();
    const majorRisks = counts.critical + counts.high;
    return `<article class="journey-row" data-journey-card data-entry-repo="${attr(entryRepo.id)}" data-search="${attr(searchText)}" style="--repo:${attr(entryRepo.color)}"><div class="journey-summary"><p class="operator-id">${escapeHtml(manifest.journey.id)} · ${escapeHtml(entryRepo.label)}</p><h2><a href="${attr(href)}">${escapeHtml(manifest.journey.title)}</a></h2><p>${escapeHtml(manifest.journey.goal)}</p></div><div class="journey-route"><span><strong>Begins</strong> ${escapeHtml(manifest.entry.label)} <code>${escapeHtml(manifest.entry.route)}</code></span><span aria-hidden="true">→</span><span><strong>Ends</strong> ${escapeHtml(manifest.terminal.label)} <code>${escapeHtml(manifest.terminal.route)}</code></span></div><div class="journey-signals"><span class="${majorRisks ? "signal-risk" : ""}">${majorRisks} critical/high</span><span>${capturedCount(manifest)}/${manifest.steps.length} captures</span><span>behavior ${escapeHtml(manifest.behaviorEvidence.status)}</span><span>E2E ${escapeHtml(manifest.journey.e2e.status)}</span><a href="${attr(href)}">Open map →</a></div></article>`;
  }).join("");
  const repoOptions = [...entryRepositories].sort((a, b) => a[1].localeCompare(b[1])).map(([id, label]) => `<option value="${attr(id)}">${escapeHtml(label)}</option>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Journey operator maps</title><style>${operatorStyles}
  .portfolio-tools{display:grid;grid-template-columns:minmax(260px,2fr) minmax(190px,1fr) auto;gap:12px;align-items:end;margin-bottom:18px;padding-bottom:18px;border-bottom:1px solid var(--ink)}
  .operator-links{margin:11px 0 0;font-size:.82rem;font-weight:650}
  .portfolio-field label{display:block;margin-bottom:5px;color:var(--muted);font-size:.7rem;font-weight:750;text-transform:uppercase;letter-spacing:.05em}.portfolio-field input,.portfolio-field select{width:100%;min-height:42px;border:1px solid #8b95a5;background:#fff;color:var(--ink);padding:8px 10px;font:inherit}.portfolio-tools button{min-height:42px;border:1px solid #8b95a5;background:#fff;padding:8px 14px;font:inherit;font-weight:650;cursor:pointer}.portfolio-count{grid-column:1/-1;margin:0;color:var(--muted);font-size:.76rem}.collection{border-top:1px solid var(--line)}.journey-row{display:grid;grid-template-columns:minmax(300px,1.35fr) minmax(300px,1fr) minmax(150px,.5fr);gap:20px;align-items:start;padding:18px 0;border-bottom:1px solid var(--line);border-left:3px solid var(--repo)}.journey-summary{padding-left:14px}.journey-summary h2{margin:0;font-size:1.15rem}.journey-summary p:last-child{margin:5px 0 0;color:var(--muted);font-size:.78rem}.journey-route{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;font-size:.72rem}.journey-route span{min-width:0}.journey-route strong{display:block;font-size:.65rem;text-transform:uppercase;letter-spacing:.04em}.journey-route code{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom;background:#eef0f2;padding:2px 4px}.journey-signals{display:flex;flex-direction:column;align-items:flex-start;gap:4px;color:var(--muted);font-size:.68rem}.journey-signals .signal-risk{color:var(--high);font-weight:750}.journey-signals a{margin-top:4px;font-weight:750}.portfolio-empty{padding:24px;border-bottom:1px solid var(--line);text-align:center}
  @media(max-width:860px){.journey-row{grid-template-columns:1fr}.journey-route{grid-template-columns:1fr}.journey-route>span[aria-hidden]{display:none}.journey-signals{flex-direction:row;flex-wrap:wrap}.portfolio-tools{grid-template-columns:1fr}.portfolio-count{grid-column:1}}
</style></head><body><header class="operator-header"><div class="shell"><p class="operator-id">Journey operations</p><h1>Operator maps</h1><p class="operator-goal">Find a journey, understand its route, and open the evidence needed for the next investigation.</p><p class="operator-links"><a href="canvas.html">View canvas</a></p></div></header><main class="section"><div class="shell">
  ${manifests.length ? `<div class="portfolio-tools" role="search"><div class="portfolio-field"><label for="journey-search">Search journeys</label><input id="journey-search" type="search" autocomplete="off" placeholder="ID, title, goal, actor, or owner"></div><div class="portfolio-field"><label for="journey-repo">Entry system</label><select id="journey-repo"><option value="all">All entry systems</option>${repoOptions}</select></div><button type="button" id="journey-clear">Clear filters</button><p class="portfolio-count" id="journey-count" aria-live="polite">Showing ${manifests.length} of ${manifests.length} journeys</p></div>` : ""}
  <div class="collection">${cards || `<p>No journey manifests found.</p>`}</div>
  <p class="portfolio-empty" id="portfolio-empty" hidden>No journeys match these filters. Clear the search or choose another entry system.</p>
</div></main><footer class="operator-footer"><div class="shell"><p>Each map is derived from its canonical JRNY page.</p></div></footer>
${manifests.length ? `<script>(()=>{const search=document.querySelector('#journey-search');const repo=document.querySelector('#journey-repo');const clear=document.querySelector('#journey-clear');const count=document.querySelector('#journey-count');const empty=document.querySelector('#portfolio-empty');const cards=[...document.querySelectorAll('[data-journey-card]')];const apply=()=>{const query=search.value.trim().toLowerCase();let shown=0;for(const card of cards){const visible=(!query||card.dataset.search.includes(query))&&(repo.value==='all'||card.dataset.entryRepo===repo.value);card.hidden=!visible;if(visible)shown+=1}count.textContent='Showing '+shown+' of '+cards.length+' journeys';empty.hidden=shown!==0};search.addEventListener('input',apply);repo.addEventListener('change',apply);clear.addEventListener('click',()=>{search.value='';repo.value='all';apply();search.focus()})})();</script>` : ""}
</body></html>`;
};

const CANVAS = { nodeW: 234, journeyH: 118, surfaceH: 86, unmappedH: 80, colGap: 108, stackGap: 18, lanePad: 14, laneHead: 26, padX: 20, padY: 14, labelW: 158, labelH: 34, world: 100000 };

const canvasNodes = (graph) => [
  ...graph.journeys.map((journey) => ({ id: journey.id, kind: "journey", repo: journey.entryRepo, h: CANVAS.journeyH, journey })),
  ...graph.surfaces.map((surface) => ({ id: surface.id, kind: "surface", repo: surface.repo, h: CANVAS.surfaceH, surface })),
  ...graph.unresolved.map((target) => ({ id: target.id, kind: "unmapped", repo: null, h: CANVAS.unmappedH, target })),
];

// A continuation is declared on the terminal block, so it leaves the terminal surface node: the
// journey, the surface it ends on, and the journey that surface feeds read as one flow. Where that
// repeats the target's own entry edge — the derived case, both journeys touching one surface — the
// grey entry connector gives way to the continuation.
const canvasLinks = (graph) => {
  const terminalSurface = new Map(graph.journeys.map((journey) => [journey.id, journey.terminal]));
  const continuations = graph.edges
    .filter((edge) => edge.type === "continuation")
    .map((edge) => ({ ...edge, journey: edge.from, from: terminalSurface.get(edge.from) }));
  const replaced = new Set(continuations.map((edge) => `${edge.from}~${edge.to}`));
  const rest = graph.edges.filter((edge) => edge.type !== "continuation" && !(edge.type === "entry" && replaced.has(`${edge.from}~${edge.to}`)));
  return [...rest, ...continuations];
};

const layoutCanvas = (graph, links) => {
  const nodes = canvasNodes(graph);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const predecessors = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of links) {
    // Columns follow the entry → journey → terminal spine. Journey-to-journey branches stay out of
    // it so journeys that share an entry surface remain peers in one column.
    const spine = ["entry", "terminal", "continuation"].includes(edge.type) || (edge.type === "branch" && !edge.resolved);
    if (spine && byId.has(edge.from) && byId.has(edge.to)) predecessors.get(edge.to).push(edge.from);
  }
  const columns = new Map();
  // Longest path from the left. Ceiling: a cyclic handoff is placed as if its back edge were absent;
  // replace with a proper feedback-arc pass if journeys ever form real cycles.
  const columnOf = (id, visiting) => {
    if (columns.has(id)) return columns.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const column = predecessors.get(id).reduce((max, from) => Math.max(max, columnOf(from, visiting) + 1), 0);
    visiting.delete(id);
    columns.set(id, column);
    return column;
  };
  for (const node of nodes) node.column = columnOf(node.id, new Set());

  const lanes = [
    ...graph.repositories.filter((repo) => nodes.some((node) => node.repo === repo.id)),
    ...(graph.unresolved.length ? [{ id: null, label: "Not mapped", host: "no manifest in this folder", color: "#8b95a5" }] : []),
  ];
  for (const node of nodes) node.lane = lanes.findIndex((lane) => lane.id === node.repo);

  const relatedIds = (node) => node.kind === "surface" ? [...node.surface.entryOf, ...node.surface.terminalOf] : node.kind === "unmapped" ? node.target.referencedBy : [node.id];
  for (const node of nodes) {
    const related = relatedIds(node);
    const laneValues = related.map((id) => byId.get(id)?.lane).filter((lane) => lane >= 0);
    node.affinity = laneValues.length ? laneValues.reduce((sum, lane) => sum + lane, 0) / laneValues.length : node.lane;
    node.order = [...related].sort()[0] || node.id;
  }

  const cells = new Map();
  for (const node of nodes) {
    const key = `${node.lane}|${node.column}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(node);
  }
  for (const group of cells.values()) {
    group.sort((a, b) => a.affinity - b.affinity || a.order.localeCompare(b.order, undefined, { numeric: true }) || a.id.localeCompare(b.id));
  }

  // Two nodes stacked in the same cell are joined by a labelled edge that needs vertical room
  // between them; nodes with nothing to say to each other stay tight.
  const labelled = new Map();
  for (const edge of links) {
    if (!["branch", "continuation", "seam"].includes(edge.type)) continue;
    const key = [edge.from, edge.to].sort().join("~");
    labelled.set(key, (labelled.get(key) || 0) + 1);
  }
  const gapBetween = (above, below) => CANVAS.stackGap + (labelled.get([above.id, below.id].sort().join("~")) || 0) * CANVAS.labelH;
  const stackOf = (group) => group.reduce((sum, node, index) => sum + node.h + (index ? gapBetween(group[index - 1], node) : 0), 0);
  const laneHeights = lanes.map((lane, index) => {
    const stacks = [...cells].filter(([key]) => key.startsWith(`${index}|`)).map(([, group]) => stackOf(group));
    return CANVAS.laneHead + CANVAS.lanePad * 2 + Math.max(0, ...stacks);
  });
  const laneTops = [];
  let cursor = CANVAS.padY;
  for (const [index, height] of laneHeights.entries()) {
    laneTops[index] = cursor;
    cursor += height;
  }

  for (const [key, group] of cells) {
    const [lane, column] = key.split("|").map(Number);
    const free = laneHeights[lane] - CANVAS.laneHead - CANVAS.lanePad * 2 - stackOf(group);
    let offset = laneTops[lane] + CANVAS.laneHead + CANVAS.lanePad + free / 2;
    for (const [index, node] of group.entries()) {
      node.w = CANVAS.nodeW;
      node.x = CANVAS.padX + column * (CANVAS.nodeW + CANVAS.colGap);
      node.y = offset + (index ? gapBetween(group[index - 1], node) : 0);
      node.cx = node.x + node.w / 2;
      node.cy = node.y + node.h / 2;
      offset = node.y + node.h;
    }
  }

  const columnCount = Math.max(...nodes.map((node) => node.column)) + 1;
  return {
    nodes,
    byId,
    lanes,
    laneTops,
    laneHeights,
    width: CANVAS.padX * 2 + columnCount * CANVAS.nodeW + (columnCount - 1) * CANVAS.colGap,
    height: cursor + CANVAS.padY,
  };
};

const round = (value) => Math.round(value * 10) / 10;

const cubicPoint = (p0, c1, c2, p1, t) => {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  };
};

const edgeGeometry = (from, to, index, count, at) => {
  const centred = index - (count - 1) / 2;
  let p0;
  let p1;
  let c1;
  let c2;
  if (to.x > from.x) {
    p0 = { x: from.x + from.w, y: from.cy };
    p1 = { x: to.x, y: to.cy };
    const dx = Math.max(46, (p1.x - p0.x) * 0.45);
    c1 = { x: p0.x + dx, y: p0.y + centred * 34 };
    c2 = { x: p1.x - dx, y: p1.y + centred * 34 };
  } else if (to.x < from.x) {
    p0 = { x: from.x, y: from.cy };
    p1 = { x: to.x + to.w, y: to.cy };
    const dx = Math.max(64, (p0.x - p1.x) * 0.4) + index * 38;
    c1 = { x: p0.x - dx, y: p0.y };
    c2 = { x: p1.x + dx, y: p1.y };
  } else {
    // Same column: leave and re-enter on the right so the curve never crosses a node.
    const lead = to.cy >= from.cy ? 12 : -12;
    const bulge = 76 + index * 46;
    p0 = { x: from.x + from.w, y: from.cy };
    p1 = { x: to.x + to.w, y: to.cy };
    c1 = { x: p0.x + bulge, y: p0.y + lead };
    c2 = { x: p1.x + bulge, y: p1.y - lead };
  }
  return {
    d: `M${round(p0.x)} ${round(p0.y)}C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(p1.x)} ${round(p1.y)}`,
    anchor: cubicPoint(p0, c1, c2, p1, at),
  };
};

const canvasEdges = (links, layout) => {
  const pairs = new Map();
  const drawable = links.filter((edge) => layout.byId.has(edge.from) && layout.byId.has(edge.to));
  for (const edge of drawable) {
    const key = [edge.from, edge.to].sort().join("~");
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(edge);
  }
  return [...pairs.values()].flatMap((group) => group.map((edge, index) => {
    const from = layout.byId.get(edge.from);
    const to = layout.byId.get(edge.to);
    // Stagger labels along the pair's shared axis, not along each edge's own direction, so a
    // reversed edge between the same two nodes does not land its label on top of its sibling.
    const forward = edge.from < edge.to ? 1 : -1;
    const at = Math.min(0.84, Math.max(0.16, 0.5 + forward * (index - (group.length - 1) / 2) * 0.3));
    const { d, anchor } = edgeGeometry(from, to, index, group.length, at);
    const clear = from.x === to.x ? Math.max(from.x + from.w, to.x + to.w) + 12 : 0;
    return { ...edge, d, anchor, box: { x: Math.max(anchor.x - CANVAS.labelW / 2, clear), y: anchor.y - CANVAS.labelH / 2 } };
  }));
};

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Nudges each edge label off the nodes and off labels already placed, smallest move first, and
// leaves it on its curve when nothing clears.
const placeCanvasLabels = (labelled, nodes) => {
  const blocked = nodes.map((node) => ({ x: node.x - 5, y: node.y - 5, w: node.w + 10, h: node.h + 10 }));
  const placed = [];
  for (const edge of labelled) {
    const options = [
      edge.box,
      ...[1, 2, 3].flatMap((step) => [-1, 1].map((side) => ({ x: edge.box.x, y: edge.box.y + side * step * (CANVAS.labelH + 8) }))),
      ...[1, 2].flatMap((step) => [-1, 1].map((side) => ({ x: edge.box.x + side * step * CANVAS.labelW * 0.6, y: edge.box.y }))),
    ];
    const clear = options.find((option) => {
      const rect = { ...option, w: CANVAS.labelW, h: CANVAS.labelH };
      return !blocked.some((node) => overlaps(rect, node)) && !placed.some((other) => overlaps(rect, other));
    });
    edge.box = clear || edge.box;
    placed.push({ ...edge.box, w: CANVAS.labelW, h: CANVAS.labelH });
  }
};

const canvasJourneyCard = (node, manifest, href, repo) => {
  const counts = issueCounts(manifest);
  const major = counts.critical + counts.high;
  const captures = `${capturedCount(manifest)}/${manifest.steps.length}`;
  const label = `${manifest.journey.id}, ${manifest.journey.title}. Begins in ${repo.label}. ${major} critical or high issues, ${captures} steps captured, end-to-end coverage ${manifest.journey.e2e.status}. Opens the journey map.`;
  return `<a class="cnode cnode--journey" id="node-${attr(manifest.journey.id)}" href="${attr(href)}" aria-label="${attr(label)}" style="--repo:${attr(repo.color)}" xmlns="http://www.w3.org/1999/xhtml">
    <span class="cnode__id">${escapeHtml(manifest.journey.id)} · ${escapeHtml(repo.label)}</span>
    <strong class="cnode__title">${escapeHtml(manifest.journey.title)}</strong>
    <span class="cnode__path">${escapeHtml(node.journey.repoPath.join(" → "))}</span>
    <span class="cnode__signals"><b class="${major ? "signal-risk" : ""}">${major} critical/high</b><span>${escapeHtml(captures)} captures</span><span>E2E ${escapeHtml(manifest.journey.e2e.status)}</span></span>
  </a>`;
};

const canvasSurfaceCard = (node, repo) => {
  const { entryOf, terminalOf } = node.surface;
  const role = entryOf.length && terminalOf.length ? "Entry and terminal" : entryOf.length ? "Entry" : "Terminal";
  const shared = entryOf.length + terminalOf.length > 1;
  const relation = [terminalOf.length ? `Ends ${terminalOf.join(", ")}` : "", entryOf.length ? `Begins ${entryOf.join(", ")}` : ""].filter(Boolean).join(" · ");
  return `<div class="cnode cnode--surface${shared ? " cnode--shared" : ""}" style="--repo:${attr(repo.color)}" xmlns="http://www.w3.org/1999/xhtml">
    <span class="cnode__id">${escapeHtml(role)} · ${escapeHtml(repo.label)}</span>
    <strong class="cnode__title">${escapeHtml(node.surface.label)}</strong>
    <code class="cnode__route">${escapeHtml(node.surface.route)}</code>
    <span class="cnode__rel">${escapeHtml(relation)}</span>
  </div>`;
};

const canvasUnmappedCard = (node) => `<div class="cnode cnode--unmapped" xmlns="http://www.w3.org/1999/xhtml">
    <span class="cnode__id">Not mapped</span>
    <strong class="cnode__title">${escapeHtml(node.id)}</strong>
    <span class="cnode__rel">Named by ${escapeHtml(node.target.referencedBy.join(", "))}</span>
  </div>`;

const canvasEdgeLabel = (edge, journeyLinks) => {
  if (edge.type === "entry" || edge.type === "terminal") return "";
  const x = round(edge.box.x);
  const y = round(edge.box.y);
  const open = (body) => `<foreignObject x="${x}" y="${y}" width="${CANVAS.labelW}" height="${CANVAS.labelH}">${body}</foreignObject>`;
  if (edge.type === "branch") {
    const from = journeyLinks.get(edge.from);
    const href = `${from.href}#step=${encodeURIComponent(edge.fromStep)}`;
    const label = `Branch from ${edge.from} to ${edge.to}: ${edge.label}. Opens ${edge.from} at step ${edge.fromStep}.`;
    return open(`<a class="clabel clabel--branch" href="${attr(href)}" aria-label="${attr(label)}" xmlns="http://www.w3.org/1999/xhtml">Branch · ${escapeHtml(edge.label)}</a>`);
  }
  if (edge.type === "continuation") {
    const href = `${journeyLinks.get(edge.journey).href}#step=${encodeURIComponent(edge.fromStep)}`;
    const label = `Completing ${edge.journey} continues in ${edge.to}. Opens ${edge.journey} at its final step ${edge.fromStep}.`;
    return open(`<a class="clabel clabel--continuation" href="${attr(href)}" aria-label="${attr(label)}" xmlns="http://www.w3.org/1999/xhtml">${escapeHtml(edge.journey)} continues in ${escapeHtml(edge.to)}</a>`);
  }
  return open(`<span class="clabel clabel--seam" xmlns="http://www.w3.org/1999/xhtml">Shared seam ${escapeHtml(edge.seam)}</span>`);
};

const canvasStyles = `
  .operator-links{margin:11px 0 0;font-size:.82rem;font-weight:650}
  .canvas-app{height:100vh;height:100dvh;overflow:hidden}
  .stage{position:fixed;inset:0;background:#fff}
  .stage svg{display:block;width:100%;height:100%;touch-action:none;cursor:grab;user-select:none}
  .stage svg.is-panning{cursor:grabbing}
  .hud{position:fixed;z-index:4;border:1px solid var(--ink);background:#fff}
  .hud--id{top:12px;left:12px;max-width:min(35rem,calc(100vw - 24px));padding:8px 11px}
  .hud--id h1{display:inline;margin:0;font-size:1rem;letter-spacing:-.02em}
  .hud--id .operator-links{display:inline;margin:0 0 0 10px;font-size:.76rem}
  .canvas-counts{display:flex;flex-wrap:wrap;gap:1px 12px;margin:5px 0 0;color:var(--muted);font-size:.71rem;font-variant-numeric:tabular-nums}
  .hud--controls{top:12px;right:12px;display:flex;align-items:center;gap:6px;padding:6px}
  .hud--controls button{min-height:44px;border:1px solid #8b95a5;background:#fff;padding:8px 12px;font:inherit;font-weight:650;cursor:pointer}
  .hud--controls button:hover{border-color:var(--ink)}
  .canvas-zoom{padding:0 6px;color:var(--muted);font-size:.74rem;font-variant-numeric:tabular-nums}
  .hud--legend{bottom:12px;left:12px;max-width:calc(100vw - 24px)}
  .hud--legend summary{display:flex;align-items:center;min-height:38px;padding:6px 11px;font-size:.74rem;font-weight:700;cursor:pointer}
  .hud--legend[open] summary{border-bottom:1px solid var(--line)}
  .legend-body{padding:10px 11px}
  .legend-body p{margin:0;max-width:64ch;color:var(--muted);font-size:.7rem;line-height:1.45}
  .legend-body p+p{margin-top:7px}
  .lane-pin{position:fixed;left:0;top:0;z-index:2;display:none;align-items:baseline;gap:7px;padding:4px 9px;border:1px solid var(--line);border-left:4px solid var(--repo);background:#fff;font-size:.72rem;white-space:nowrap;pointer-events:none}
  .lane-pin strong{font-weight:750}
  .lane-pin span{color:var(--muted);font-size:.66rem}
  .lane-band{fill:#fafbfc}.lane-band--odd{fill:#fff}
  .edge{fill:none}
  .edge--entry,.edge--terminal{stroke:#a9b1bd;stroke-width:1.5}
  .edge--continuation{stroke:var(--ink);stroke-width:3}
  .edge--branch{stroke:var(--ink);stroke-width:2;stroke-dasharray:7 4}
  .label-leader{stroke:#9aa3b0;stroke-width:1}
  .edge--seam{stroke:#5b6472;stroke-width:2.5;stroke-dasharray:0.1 6;stroke-linecap:round}
  .cnode{display:flex;flex-direction:column;height:100%;padding:8px 10px;border:1px solid var(--line);border-left:4px solid var(--repo,#8b95a5);background:#fff;color:var(--ink);text-decoration:none;overflow:hidden}
  a.cnode:hover{border-color:var(--ink)}
  a.cnode:focus-visible{outline:3px solid #175cd3;outline-offset:2px}
  .cnode__id{font:750 .62rem/1.25 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted)}
  .cnode__title{margin-top:3px;font-size:.84rem;line-height:1.2;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
  a.cnode .cnode__title{text-decoration:underline;text-underline-offset:2px}
  .cnode__route{align-self:flex-start;max-width:100%;margin-top:4px;padding:2px 4px;background:#eef0f2;font:.62rem/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cnode__path,.cnode__rel{margin-top:auto;padding-top:5px;color:var(--muted);font-size:.65rem;line-height:1.25;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
  .cnode__signals{display:flex;flex-wrap:wrap;gap:1px 9px;margin-top:5px;color:var(--muted);font-size:.65rem;font-variant-numeric:tabular-nums}
  .cnode__signals .signal-risk{color:var(--high);font-weight:750}
  .cnode--shared{border-color:var(--ink)}
  .cnode--unmapped{border-style:dashed;border-left-style:dashed;background:#fbfcfd}
  .clabel{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;padding:3px 6px;border:1px solid var(--line);background:#fff;color:var(--ink);font-size:.65rem;line-height:1.25;text-align:center}
  a.clabel:focus-visible{outline:3px solid #175cd3;outline-offset:2px}
  .clabel--continuation{font-weight:650}
  .clabel--seam{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
  .canvas-key{display:flex;flex-wrap:wrap;gap:6px 22px;margin:0 0 9px;padding:0;list-style:none;color:var(--muted);font-size:.72rem}
  .canvas-key li{display:flex;align-items:center;gap:7px}
  .canvas-empty{padding:26px;border:1px solid var(--line);background:#fafbfc}
  .canvas-empty h2{margin:0 0 6px;font-size:1.05rem}
  .canvas-empty p{margin:0 0 10px;max-width:640px;color:var(--muted);font-size:.84rem}
  .canvas-empty code{padding:1px 4px;background:#eef0f2;font-size:.76rem}
  .canvas-command{display:block;margin-top:2px;padding:9px 10px;overflow-x:auto;font-size:.72rem}
  @media(max-width:820px){
    .canvas-counts{display:none}
    .hud--id{padding:6px 10px}
    .hud--id h1{font-size:.92rem}
    .hud--controls{top:auto;bottom:12px;right:12px;flex-direction:column;align-items:stretch;gap:5px}
    .canvas-zoom{padding:2px 0;text-align:center}
    .hud--legend{max-width:calc(100vw - 120px)}
  }
`;

const canvasShell = (body, script, bodyClass = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Journey canvas</title><style>${operatorStyles}${canvasStyles}</style></head><body${bodyClass ? ` class="${bodyClass}"` : ""}>${body}${script}</body></html>`;

const renderCanvas = (graph, manifests, outputPath) => {
  const collectionDir = dirname(resolve(outputPath));
  const listHref = basename(resolve(outputPath));
  if (!graph.journeys.length) {
    const header = `<header class="operator-header"><div class="shell"><p class="operator-id">Journey operations</p><h1>Journey canvas</h1><p class="operator-goal">Where the mapped journeys meet: the surfaces they share, the journeys they hand users to, and the seams they both depend on.</p><p class="operator-links"><a href="${attr(listHref)}">View list</a></p></div></header>`;
    return canvasShell(`${header}<main class="section"><div class="shell"><div class="canvas-empty"><h2>No journeys to connect yet</h2><p>This folder holds one directory per journey, each with a <code>manifest.json</code> rendered from its canonical JRNY page. Add the first one, then regenerate the list and this canvas with a single command.</p><code class="canvas-command">node ~/.agents/skills/visualize-journey/scripts/render-journey-map.mjs --collection ${escapeHtml(relative(process.cwd(), collectionDir) || ".")} --output ${escapeHtml(relative(process.cwd(), resolve(outputPath)) || listHref)}</code></div></div></main>`, "");
  }

  const journeyLinks = new Map(manifests.map(({ manifest, path }) => [manifest.journey.id, { manifest, href: journeyHref(path, collectionDir) }]));
  const repoById = new Map(graph.repositories.map((repo) => [repo.id, repo]));
  const links = canvasLinks(graph);
  const layout = layoutCanvas(graph, links);
  const edges = canvasEdges(links, layout);
  const labelled = edges.filter((edge) => !["entry", "terminal"].includes(edge.type));
  placeCanvasLabels(labelled, layout.nodes);
  layout.width = Math.max(layout.width, ...labelled.map((edge) => edge.box.x + CANVAS.labelW + CANVAS.padX));
  const counts = {
    continuation: edges.filter((edge) => edge.type === "continuation").length,
    branch: edges.filter((edge) => edge.type === "branch").length,
    seam: edges.filter((edge) => edge.type === "seam").length,
    shared: graph.surfaces.filter((surface) => surface.entryOf.length + surface.terminalOf.length > 1).length,
  };
  const plural = (count, singular, many) => `${count} ${count === 1 ? singular : many}`;
  const summary = `<p class="canvas-counts"><span>${plural(graph.journeys.length, "journey", "journeys")}</span><span>${plural(layout.lanes.length, "system lane", "system lanes")}</span><span>${plural(counts.shared, "shared surface", "shared surfaces")}</span><span>${plural(counts.continuation, "continuation", "continuations")}</span><span>${plural(counts.branch, "branch", "branches")}</span><span>${plural(counts.seam, "shared seam", "shared seams")}</span>${graph.unresolved.length ? `<span>${plural(graph.unresolved.length, "journey named but not mapped", "journeys named but not mapped")}</span>` : ""}</p>`;

  // The lane bands run far past the content so panning never reaches an edge of the world.
  const lanes = layout.lanes.map((lane, index) => `<g><rect class="lane-band${index % 2 ? " lane-band--odd" : ""}" x="${-CANVAS.world}" y="${round(layout.laneTops[index])}" width="${CANVAS.world * 2}" height="${round(layout.laneHeights[index])}"></rect><line x1="${-CANVAS.world}" y1="${round(layout.laneTops[index])}" x2="${CANVAS.world}" y2="${round(layout.laneTops[index])}" stroke="${attr(lane.color)}" stroke-width="2"></line></g>`).join("");
  // Lane names are pinned to the left of the viewport instead, so they stay readable at any pan.
  const pins = layout.lanes.map((lane, index) => `<div class="lane-pin" aria-hidden="true" style="--repo:${attr(lane.color)}" data-top="${round(layout.laneTops[index])}" data-bottom="${round(layout.laneTops[index] + layout.laneHeights[index])}"><strong>${escapeHtml(lane.label)}</strong><span>${escapeHtml(lane.host)}</span></div>`).join("");

  const order = { entry: 0, terminal: 0, seam: 1, continuation: 2, branch: 3 };
  const lines = [...edges].sort((a, b) => order[a.type] - order[b.type]).map((edge) => `<path class="edge edge--${attr(edge.type)}" d="${edge.d}" marker-end="${edge.type === "seam" ? "" : edge.type === "entry" || edge.type === "terminal" ? "url(#arrow-soft)" : "url(#arrow)"}"></path>`).join("");

  const cards = layout.nodes.map((node) => {
    const card = node.kind === "journey"
      ? canvasJourneyCard(node, journeyLinks.get(node.id).manifest, journeyLinks.get(node.id).href, repoById.get(node.repo))
      : node.kind === "surface" ? canvasSurfaceCard(node, repoById.get(node.repo)) : canvasUnmappedCard(node);
    return `<foreignObject x="${round(node.x)}" y="${round(node.y)}" width="${node.w}" height="${node.h}">${card}</foreignObject>`;
  }).join("");

  // A label the declutter pass had to move keeps a hairline back to the point on its own edge.
  const leaders = labelled.filter((edge) => Math.hypot(edge.box.x + CANVAS.labelW / 2 - edge.anchor.x, edge.box.y + CANVAS.labelH / 2 - edge.anchor.y) > 26)
    .map((edge) => `<line class="label-leader" x1="${round(edge.anchor.x)}" y1="${round(edge.anchor.y)}" x2="${round(edge.box.x + CANVAS.labelW / 2)}" y2="${round(edge.box.y + CANVAS.labelH / 2)}"></line>`).join("");
  const labels = edges.map((edge) => canvasEdgeLabel(edge, journeyLinks)).join("");

  const key = `<ul class="canvas-key"><li><svg width="34" height="8" aria-hidden="true"><line class="edge edge--entry" x1="0" y1="4" x2="34" y2="4"></line></svg>Begins or ends at a surface</li><li><svg width="34" height="8" aria-hidden="true"><line class="edge edge--continuation" x1="0" y1="4" x2="34" y2="4"></line></svg>Continuation</li><li><svg width="34" height="8" aria-hidden="true"><line class="edge edge--branch" x1="0" y1="4" x2="34" y2="4"></line></svg>Branch into another journey</li><li><svg width="34" height="8" aria-hidden="true"><line class="edge edge--seam" x1="0" y1="4" x2="34" y2="4"></line></svg>Shared seam</li></ul>`;

  // Overlay chrome comes before the canvas so the keyboard reaches the list link and the controls first.
  const body = `<a class="skip" data-skip href="#node-${attr(graph.journeys[0].id)}">Skip to the first journey</a>
  <header class="hud hud--id"><h1>Journey canvas</h1><span class="operator-links"><a href="${attr(listHref)}">View list</a></span>${summary}</header>
  <div class="hud hud--controls"><button type="button" data-zoom="in">Zoom in</button><button type="button" data-zoom="out">Zoom out</button><button type="button" data-zoom="fit">Fit to view</button><span class="canvas-zoom" id="canvas-zoom">100%</span></div>
  <details class="hud hud--legend"><summary>Map key</summary><div class="legend-body">${key}<p>Where the mapped journeys meet: the surfaces they share, the journeys they hand users to, and the seams they both depend on.</p><p>Continuations are declared in <code>terminal.continuesIn</code> or derived where one journey's terminal surface is another journey's entry. Shared surfaces match on repository and route. Branches come from <code>toJourney</code> on a step branch or exit point. Each map is derived from its canonical JRNY page.</p><p>Drag or two-finger scroll to pan, pinch or hold Ctrl while scrolling to zoom. With the canvas focused, arrow keys pan, plus and minus zoom, and 0 fits.</p></div></details>
  <div class="stage">${pins}<svg id="journey-canvas" data-content="0 0 ${round(layout.width)} ${round(layout.height)}" viewBox="0 0 ${round(layout.width)} ${round(layout.height)}" preserveAspectRatio="xMidYMid meet" aria-label="Journey canvas: ${graph.journeys.length} journeys laid out in ${layout.lanes.length} system lanes, with the surfaces they share and the journeys they hand users to."><defs><marker id="arrow" viewBox="0 0 8 8" refX="8" refY="4" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#17191d"></path></marker><marker id="arrow-soft" viewBox="0 0 8 8" refX="8" refY="4" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#a9b1bd"></path></marker></defs><g>${lanes}</g><g>${lines}</g><g>${cards}</g><g>${leaders}${labels}</g></svg></div>`;

  const script = `<script>(()=>{
    const svg=document.querySelector('#journey-canvas');const stage=svg.parentElement;const readout=document.querySelector('#canvas-zoom');
    const pins=[...document.querySelectorAll('.lane-pin')];const huds=[...document.querySelectorAll('.hud')];const legend=document.querySelector('.hud--legend');
    const content=svg.dataset.content.split(' ').map(Number);const MIN=0.1,MAX=4;
    let scale=1,cx=content[0]+content[2]/2,cy=content[1]+content[3]/2,drag=null,suppressClick=false;
    const vw=()=>stage.clientWidth;const vh=()=>stage.clientHeight;
    // The overlay panels are measured once per layout change, not per frame.
    let chrome={top:12,bottom:12};
    const measure=()=>{const h=vh();let top=0,bottom=0;for(const hud of huds){const r=hud.getBoundingClientRect();if(!r.width)continue;if(r.top<h/2)top=Math.max(top,r.bottom);else bottom=Math.max(bottom,h-r.top)}chrome={top:top+12,bottom:bottom+12}};
    const screenY=(userY)=>(userY-(cy-vh()/(2*scale)))*scale;
    const apply=()=>{
      const w=vw()/scale,h=vh()/scale;
      svg.setAttribute('viewBox',(cx-w/2)+' '+(cy-h/2)+' '+w+' '+h);
      readout.textContent=Math.round(scale*100)+'%';
      for(const pin of pins){
        const top=screenY(+pin.dataset.top),bottom=screenY(+pin.dataset.bottom),lower=chrome.top;
        if(bottom<lower+12||top>vh()-10){pin.style.display='none';continue}
        pin.style.display='flex';
        pin.style.transform='translateY('+Math.round(Math.min(Math.max(top+6,lower),Math.max(lower,Math.min(vh()-36,bottom-36))))+'px)';
      }
    };
    const toUser=(clientX,clientY)=>{const r=stage.getBoundingClientRect();return{x:cx+(clientX-r.left-vw()/2)/scale,y:cy+(clientY-r.top-vh()/2)/scale}};
    const zoomTo=(next,px,py)=>{const clamped=Math.min(MAX,Math.max(MIN,next));const k=scale/clamped;cx=px-(px-cx)*k;cy=py-(py-cy)*k;scale=clamped;apply()};
    const fit=()=>{
      const pad=20;
      const free={w:Math.max(80,vw()-pad*2),h:Math.max(80,vh()-chrome.top-chrome.bottom)};
      scale=Math.max(MIN,Math.min(1,free.w/content[2],free.h/content[3]));
      cx=content[0]+content[2]/2-(pad+free.w/2-vw()/2)/scale;
      cy=content[1]+content[3]/2-(chrome.top+free.h/2-vh()/2)/scale;
      apply();
    };
    // Two-finger scroll pans and pinch or Ctrl/Cmd with the wheel zooms, the convention for a
    // canvas that owns the whole viewport. The buttons and keys cover plain single-wheel mice.
    stage.addEventListener('wheel',(event)=>{
      event.preventDefault();
      const unit=event.deltaMode===1?16:event.deltaMode===2?vh():1;
      if(event.ctrlKey||event.metaKey){const p=toUser(event.clientX,event.clientY);const step=Math.min(1.6,Math.max(0.625,Math.exp(-event.deltaY*unit*0.0035)));zoomTo(scale*step,p.x,p.y);return}
      cx+=event.deltaX*unit/scale;cy+=event.deltaY*unit/scale;apply();
    },{passive:false});
    const move=(event)=>{if(!drag)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;drag.moved+=Math.abs(dx)+Math.abs(dy);drag.x=event.clientX;drag.y=event.clientY;cx-=dx/scale;cy-=dy/scale;apply()};
    const stop=()=>{if(!drag)return;svg.classList.remove('is-panning');suppressClick=drag.moved>6;drag=null;document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',stop);document.removeEventListener('pointercancel',stop)};
    // Pointer capture would retarget the click and stop the node links working, so the drag is
    // tracked on the document instead.
    svg.addEventListener('pointerdown',(event)=>{if(event.button!==0)return;suppressClick=false;drag={x:event.clientX,y:event.clientY,moved:0};svg.classList.add('is-panning');document.addEventListener('pointermove',move);document.addEventListener('pointerup',stop);document.addEventListener('pointercancel',stop)});
    svg.addEventListener('click',(event)=>{if(!suppressClick)return;suppressClick=false;event.preventDefault();event.stopPropagation()},true);
    svg.addEventListener('focusin',(event)=>{
      const host=event.target.closest('foreignObject');if(!host)return;
      const pad=20;
      const x=+host.getAttribute('x'),y=+host.getAttribute('y'),w=+host.getAttribute('width'),h=+host.getAttribute('height');
      const left=(x-(cx-vw()/(2*scale)))*scale,top=screenY(y),right=left+w*scale,bottom=top+h*scale;
      let dx=0,dy=0;
      if(left<pad)dx=left-pad;else if(right>vw()-pad)dx=right-(vw()-pad);
      if(top<chrome.top)dy=top-chrome.top;else if(bottom>vh()-chrome.bottom)dy=bottom-(vh()-chrome.bottom);
      if(dx||dy){cx+=dx/scale;cy+=dy/scale;apply()}
    });
    for(const button of document.querySelectorAll('[data-zoom]'))button.addEventListener('click',()=>{const action=button.dataset.zoom;if(action==='fit'){fit();return}zoomTo(scale*(action==='in'?1.25:0.8),cx,cy)});
    const skip=document.querySelector('[data-skip]');
    skip.addEventListener('click',(event)=>{const target=document.querySelector(skip.getAttribute('href'));if(!target)return;event.preventDefault();target.focus()});
    addEventListener('keydown',(event)=>{
      if(event.metaKey||event.ctrlKey||event.altKey)return;
      if(event.target.closest&&event.target.closest('a,button,summary,input,select,textarea'))return;
      const step=90/scale;let handled=true;
      if(event.key==='ArrowLeft')cx-=step;else if(event.key==='ArrowRight')cx+=step;
      else if(event.key==='ArrowUp')cy-=step;else if(event.key==='ArrowDown')cy+=step;
      else if(event.key==='+'||event.key==='=')zoomTo(scale*1.25,cx,cy);
      else if(event.key==='-'||event.key==='_')zoomTo(scale*0.8,cx,cy);
      else if(event.key==='0')fit();
      else handled=false;
      if(handled){event.preventDefault();apply()}
    });
    addEventListener('resize',()=>{measure();apply()});
    legend.addEventListener('toggle',()=>{measure();apply()});
    // Fitting a wide canvas into a phone screen leaves the node text unreadable, so the first view
    // stops at 60% and starts at the top left of the free area. Fit to view still shows everything.
    measure();fit();
    if(innerWidth<700&&scale<0.6){scale=0.6;cx=content[0]+(vw()/2-20)/scale;cy=content[1]+(vh()/2-chrome.top)/scale;apply()}
  })();</script>`;
  return canvasShell(body, script, "canvas-app");
};

const args = parseArgs(process.argv.slice(2));
const outputPath = resolve(args.output);
mkdirSync(dirname(outputPath), { recursive: true });

if (args.manifest) {
  const manifestPath = resolve(args.manifest);
  const manifest = readJson(manifestPath);
  const errors = validateManifest(manifest);
  if (errors.length) fail(`manifest validation failed:\n- ${errors.join("\n- ")}`);
  writeFileSync(outputPath, renderJourneyInstrument(manifest), "utf8");
  if (args.check) {
    const missing = validateReferences(manifest, outputPath);
    if (missing.length) fail(`missing local references:\n- ${missing.join("\n- ")}`);
    const html = readFileSync(outputPath, "utf8");
    if (!html.includes(manifest.journey.id) || !html.includes("Journey path") || !html.includes("Priority work")) fail("rendered HTML failed content checks");
  }
  console.log(`Rendered ${manifest.journey.id} with ${manifest.steps.length} steps, ${totalIssues(manifest)} issues, and ${capturedCount(manifest)}/${manifest.steps.length} captures: ${outputPath}`);
} else {
  const collectionPath = resolve(args.collection);
  if (!existsSync(collectionPath)) fail(`collection does not exist: ${collectionPath}`);
  const manifests = findManifests(collectionPath).map((path) => ({ path, manifest: readJson(path) }));
  const errors = manifests.flatMap(({ path, manifest }) => validateManifest(manifest).map((error) => `${path}: ${error}`));
  if (errors.length) fail(`collection validation failed:\n- ${errors.join("\n- ")}`);
  const duplicateIds = manifests.map(({ manifest }) => manifest.journey.id).filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateIds.length) fail(`duplicate journey IDs in collection: ${[...new Set(duplicateIds)].join(", ")}`);
  manifests.sort((a, b) => a.manifest.journey.id.localeCompare(b.manifest.journey.id, undefined, { numeric: true }));
  const graph = buildJourneyGraph(manifests.map(({ manifest }) => manifest));
  const canvasPath = join(dirname(outputPath), "canvas.html");
  writeFileSync(outputPath, renderCollection(manifests, outputPath), "utf8");
  writeFileSync(canvasPath, renderCanvas(graph, manifests, outputPath), "utf8");
  if (args.check) {
    const missingMaps = manifests.filter(({ path }) => !existsSync(join(dirname(path), "index.html"))).map(({ path }) => path);
    if (missingMaps.length) fail(`collection maps missing for:\n- ${missingMaps.join("\n- ")}`);
    if (!existsSync(canvasPath)) fail(`journey canvas was not written: ${canvasPath}`);
    const canvasHtml = readFileSync(canvasPath, "utf8");
    const missingOnCanvas = manifests.map(({ manifest }) => manifest.journey.id).filter((id) => !canvasHtml.includes(id));
    if (missingOnCanvas.length) fail(`journey canvas is missing:\n- ${missingOnCanvas.join("\n- ")}`);
  }
  const crossLinks = graph.edges.filter(({ type }) => ["continuation", "branch", "seam"].includes(type)).length;
  console.log(`Rendered collection with ${manifests.length} journey maps: ${outputPath}`);
  console.log(`Rendered canvas with ${graph.journeys.length} journeys, ${graph.surfaces.length} surfaces, and ${crossLinks} cross-journey links: ${canvasPath}`);
}
