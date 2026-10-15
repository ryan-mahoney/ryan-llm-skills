// Catalog-backed interpretation of a work request (newui-13-request-work
// step 4). A request names a workspace, a transcript, and optional navigation
// context and resolved references. The interpreter builds ONE bounded catalog
// of authorized references from the real read-only readers (spec-location
// listPackages, epics.mjs readWorkspaceEpics, designs.mjs
// listWorkspaceDesigns, and lstat of kit.directory/plans), prompts a model
// once through the shared printReply runner, and validates the reply against
// that catalog before anything becomes launchable.
//
// The catalog carries typed references only: workspace:<id>, spec:<slug>,
// design:<slug>, epic:<slug> and material:plans/<name>.md, each with a label
// derived from the reader. Complete entries are dropped from the tail to hold
// the per-type caps and the JSON byte budget; every dropped or invalid record
// is counted as an omission. A source-level reader failure exposes exactly one
// static category ("specs-unavailable", "epics-unavailable",
// "designs-unavailable", "plans-unavailable") — never filesystem exception
// text, paths or reader reason strings.
//
// Refusal style (matching workspaces/request-actions.mjs): invalid input
// throws an Error with code "invalid-request" and a static reason that never
// embeds the offending text. Input is validated before any spawn and never
// truncated. Model output is never echoed into labels or effects: candidates
// carry exactly the allowlisted fields and labels come only from the catalog
// and the action definitions. This module carries no skill or authority
// strings and touches no storage or provider beyond its injected storageRoot,
// kit and print boundaries.

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { listPackages } from "../spec-location/index.mjs";
import { printReply } from "../workspaces/naming.mjs";
import { RESEARCH_INTENTS, REQUEST_ACTIONS, REQUEST_LIMITS } from "../workspaces/request-actions.mjs";
import { listWorkspaceDesigns } from "./designs.mjs";
import { readWorkspaceEpics } from "./epics.mjs";

export const INTERPRET_MODEL = "openrouter/inception/mercury-2.5";
export const INTERPRET_TIMEOUT_MS = 20000;
export const INTERPRET_MAX_OUTPUT_BYTES = 8192;
export const CATALOG_LIMITS = Object.freeze({ specs: 100, designs: 50, epics: 50, materials: 50, bytes: 24576 });

const SOURCE_CATEGORIES = Object.freeze(["specs-unavailable", "epics-unavailable", "designs-unavailable", "plans-unavailable"]);
const REF_TYPES = Object.freeze(["workspace", "spec", "design", "epic", "material"]);
const RESOLUTIONS = Object.freeze(["proposal", "clarification", "unsupported"]);
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
const CONTROL_GLOBAL = /[\u0000-\u001f\u007f\u2028\u2029]/g;

const invalid = (message) => Object.assign(new Error(message), { code: "invalid-request" });
const byRef = (a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

// Display prose (goal, constraints, question): control characters are removed
// without replacement and the result is trimmed. Never echoes into anything
// but the candidate fields and the question.
const stripProse = (value) => (typeof value === "string" ? value.replace(CONTROL_GLOBAL, "").trim() : "");

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// A well-formed typed ref: one known type, a non-empty payload, and never a
// path form (no absolute paths, '..', backslash, '~' or drive letters).
// material: refs fix their payload to plans/<name>.md.
export function isTypedRef(value) {
  if (typeof value !== "string" || value === "" || CONTROL.test(value)) return false;
  const colon = value.indexOf(":");
  if (colon <= 0) return false;
  const type = value.slice(0, colon);
  const payload = value.slice(colon + 1);
  if (payload === "" || payload.includes("..") || payload.includes("\\") || payload.startsWith("~") || /^[a-zA-Z]:/.test(payload)) {
    return false;
  }
  if (type === "material") return /^plans\/[^/]+\.md$/.test(payload);
  return REF_TYPES.includes(type) && payload.length <= 200 && !payload.includes("/");
}

const refType = (value) => (typeof value === "string" ? value.slice(0, value.indexOf(":")) : "");

// Input validation, in request-actions.mjs refusal style: static reasons, no
// echo of the offending value, and always before any spawn.
export function canonicalIdentifier(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw invalid(`A canonical ${label} is required.`);
  if (value.length > 200) throw invalid(`A canonical ${label} is too long.`);
  if (CONTROL.test(value)) throw invalid(`A canonical ${label} must not contain control characters.`);
  if (value.startsWith("/") || value.startsWith("~") || /^[a-zA-Z]:/.test(value)) throw invalid(`A canonical ${label} must not be a path.`);
  if (value.includes("\\") || value.includes("..")) throw invalid(`A canonical ${label} must not be a path.`);
  return value;
}

function requiredTranscript(value) {
  if (typeof value !== "string" || value.trim() === "") throw invalid("A request transcript is required.");
  // Over-limit input is refused, never truncated.
  if (value.length > REQUEST_LIMITS.transcriptChars) throw invalid("A request transcript is too long.");
  return value;
}

function optionalReferences(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("Request references must be a list.");
  return value.map((entry) => {
    if (!isTypedRef(entry)) throw invalid("A request reference must be a typed ref.");
    return entry;
  });
}

// The bounded catalog: one entry per authorized typed reference, sorted by
// ref, with whole entries dropped from the tail under the per-type caps and
// the JSON byte budget. Only kit.directory is consumed from the kit. A
// source-level reader failure yields one static category for that source;
// item-level invalid records and dropped entries count as omissions.
export async function buildCatalog({ storageRoot, workspace, kit } = {}) {
  const directory = kit?.directory;
  const entries = [];
  const sourceErrors = [];
  let omissions = 0;
  const sourceFailed = (category) => {
    if (SOURCE_CATEGORIES.includes(category) && !sourceErrors.includes(category)) sourceErrors.push(category);
  };
  const cap = (list, limit) => {
    list.sort(byRef);
    if (list.length > limit) {
      omissions += list.length - limit;
      return list.slice(0, limit);
    }
    return list;
  };

  if (typeof workspace === "string" && workspace !== "") {
    entries.push({ ref: `workspace:${workspace}`, type: "workspace", label: workspace });
  }

  // Specs: spec-location listPackages.
  const specs = [];
  try {
    const listed = await listPackages(workspace, { root: storageRoot, authoring: true });
    if (!listed || listed.ok !== true || !Array.isArray(listed.packages)) {
      sourceFailed("specs-unavailable");
    } else {
      for (const pkg of listed.packages) {
        if (!pkg || typeof pkg.slug !== "string" || pkg.slug === "") {
          omissions += 1;
          continue;
        }
        specs.push({ ref: `spec:${pkg.slug}`, type: "spec", label: pkg.slug });
      }
    }
  } catch {
    sourceFailed("specs-unavailable");
  }

  // Epics: epics.mjs readWorkspaceEpics. Its reason strings are dispatch
  // signals only; none of their text is ever echoed.
  const epics = [];
  try {
    const listed = await readWorkspaceEpics(workspace, { root: storageRoot, authoring: true });
    if (!listed || !Array.isArray(listed.entries)) {
      sourceFailed("epics-unavailable");
    } else {
      for (const reason of Array.isArray(listed.reasons) ? listed.reasons : []) {
        if (typeof reason === "string" && reason.startsWith("epics-unavailable")) sourceFailed("epics-unavailable");
        else omissions += 1;
      }
      for (const entry of listed.entries) {
        if (!entry || typeof entry.slug !== "string" || entry.slug === "") {
          omissions += 1;
          continue;
        }
        epics.push({ ref: `epic:${entry.slug}`, type: "epic", label: entry.slug });
      }
    }
  } catch {
    sourceFailed("epics-unavailable");
  }

  // Designs: designs.mjs listWorkspaceDesigns. Its per-file errors are
  // item-level; a failure of the designs directory itself is source-level.
  const designs = [];
  try {
    const listed = await listWorkspaceDesigns(directory);
    if (!listed || !Array.isArray(listed.designs)) {
      sourceFailed("designs-unavailable");
    } else {
      for (const error of Array.isArray(listed.errors) ? listed.errors : []) {
        const message = typeof error?.message === "string" ? error.message : "";
        if (error?.name === "designs" && !message.startsWith("More than")) sourceFailed("designs-unavailable");
        else omissions += 1;
      }
      for (const design of listed.designs) {
        if (!design || typeof design.slug !== "string" || design.slug === "") {
          omissions += 1;
          continue;
        }
        designs.push({ ref: `design:${design.slug}`, type: "design", label: design.slug });
      }
    }
  } catch {
    sourceFailed("designs-unavailable");
  }

  // Plans: regular non-symlink *.md filenames under kit.directory/plans,
  // confirmed with lstat. An absent plans directory is the ordinary case.
  const materials = [];
  if (typeof directory === "string" && directory !== "") {
    const plansDir = join(directory, "plans");
    let plansStat = null;
    try {
      plansStat = await lstat(plansDir);
    } catch (error) {
      if (error?.code !== "ENOENT") sourceFailed("plans-unavailable");
    }
    if (plansStat !== null) {
      if (!plansStat.isDirectory()) {
        sourceFailed("plans-unavailable");
      } else {
        let names = [];
        try {
          names = (await readdir(plansDir, { withFileTypes: true }))
            .filter((entry) => entry.name.endsWith(".md"))
            .map((entry) => entry.name)
            .sort();
        } catch {
          sourceFailed("plans-unavailable");
        }
        for (const name of names) {
          try {
            const info = await lstat(join(plansDir, name));
            if (info.isFile() && !info.isSymbolicLink()) {
              materials.push({ ref: `material:plans/${name}`, type: "material", label: `plans/${name}` });
            } else {
              omissions += 1;
            }
          } catch {
            omissions += 1;
          }
        }
      }
    }
  }

  entries.push(...cap(specs, CATALOG_LIMITS.specs), ...cap(epics, CATALOG_LIMITS.epics));
  entries.push(...cap(designs, CATALOG_LIMITS.designs), ...cap(materials, CATALOG_LIMITS.materials));
  entries.sort(byRef);
  while (entries.length > 0 && Buffer.byteLength(JSON.stringify(entries), "utf8") > CATALOG_LIMITS.bytes) {
    entries.pop();
    omissions += 1;
  }
  return { workspace, entries, omissions, sourceErrors };
}

// The FIRST balanced JSON object in the reply, with string-escape-aware
// scanning: backslash escapes are honored, braces inside quoted strings are
// ignored, and nested objects stay balanced. ```json fences and prose before,
// between and after are tolerated. No balanced object yields null.
export function parseReply(reply) {
  if (typeof reply !== "string") return null;
  for (let start = 0; start < reply.length; start++) {
    if (reply[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < reply.length; index++) {
      const char = reply[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const value = JSON.parse(reply.slice(start, index + 1));
            if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
          } catch {
            // Not JSON; scan forward from the next '{'.
          }
          break;
        }
      }
    }
  }
  return null;
}

// The model reply schema: {resolution, candidates, options, question} where a
// candidate is exactly {action, workspace, entity, uses, resolved_refs,
// research, goal, constraints}. Unknown model fields are ignored and never
// echoed. Every result carries resolution, candidates, options, question,
// errors, omissions and sourceErrors; options are catalog ref strings.
export function validateReply(proposal, catalog) {
  const omissions = Number.isInteger(catalog?.omissions) && catalog.omissions >= 0 ? catalog.omissions : 0;
  const sourceErrors = Array.isArray(catalog?.sourceErrors) ? catalog.sourceErrors.filter((entry) => SOURCE_CATEGORIES.includes(entry)) : [];
  const catalogRefs = new Set(
    (Array.isArray(catalog?.entries) ? catalog.entries : [])
      .map((entry) => (entry && typeof entry.ref === "string" ? entry.ref : ""))
      .filter((ref) => ref !== ""),
  );
  const workspaceId = typeof catalog?.workspace === "string" ? catalog.workspace : "";
  const result = (resolution, candidates, options, question, errors) => ({
    resolution,
    candidates,
    options,
    question,
    errors,
    omissions,
    sourceErrors,
  });
  const rejected = (errors) => result("rejected", [], [], "", errors);
  // Options are catalog ref strings only: model-supplied options are filtered
  // to catalog members and deterministic catalog entries fill an empty set.
  const pickOptions = (modelOptions) => {
    const picked = [];
    if (Array.isArray(modelOptions)) {
      for (const option of modelOptions) {
        if (typeof option === "string" && catalogRefs.has(option) && !picked.includes(option)) picked.push(option);
        if (picked.length >= 5) break;
      }
    }
    if (picked.length === 0) {
      for (const ref of [...catalogRefs].sort()) {
        picked.push(ref);
        if (picked.length >= 5) break;
      }
    }
    return picked;
  };

  // Parse failure, non-object schema and a resolution outside the enum.
  if (!isPlainObject(proposal)) return rejected(["malformed-reply"]);
  const resolution = proposal.resolution;
  if (!RESOLUTIONS.includes(resolution)) return rejected(["malformed-reply"]);
  const question = stripProse(proposal.question);

  if (resolution === "unsupported") return result("unsupported", [], [], question, []);
  if (resolution === "clarification") return result("clarification", [], pickOptions(proposal.options), question, []);

  // resolution === "proposal": candidates must be a non-empty array, at most
  // three, and each passes the per-candidate rules before any reference check.
  const list = proposal.candidates;
  if (!Array.isArray(list) || list.length === 0) return rejected(["malformed-reply"]);
  if (list.length > 3) return rejected(["too-many-candidates"]);
  const errors = [];
  const cleaned = [];
  for (const item of list) {
    if (!isPlainObject(item)) {
      errors.push("malformed-reply");
      continue;
    }
    // An own catalog property is required: plain indexing would accept an
    // inherited key ("toString", "constructor", "__proto__").
    const action = typeof item.action === "string" && Object.hasOwn(REQUEST_ACTIONS, item.action) ? item.action : null;
    if (action === null) {
      errors.push("unknown-action");
      continue;
    }
    const goal = stripProse(item.goal);
    if (goal.length < 1 || goal.length > 120) {
      errors.push("malformed-reply");
      continue;
    }
    const rawConstraints = item.constraints === undefined ? [] : item.constraints;
    if (!Array.isArray(rawConstraints) || rawConstraints.length > 5) {
      errors.push("malformed-reply");
      continue;
    }
    const constraints = [];
    let constraintsValid = true;
    for (const entry of rawConstraints) {
      const text = stripProse(entry);
      if (text.length < 1 || text.length > 160) {
        constraintsValid = false;
        break;
      }
      constraints.push(text);
    }
    if (!constraintsValid) {
      errors.push("malformed-reply");
      continue;
    }
    const rawResearch = item.research === undefined ? {} : item.research;
    if (!isPlainObject(rawResearch)) {
      errors.push("malformed-reply");
      continue;
    }
    const research = {};
    let researchValid = true;
    for (const [source, intent] of Object.entries(rawResearch)) {
      if (typeof source !== "string" || CONTROL.test(source) || !RESEARCH_INTENTS.includes(intent)) {
        researchValid = false;
        break;
      }
      research[source] = intent;
    }
    if (!researchValid) {
      errors.push("malformed-reply");
      continue;
    }
    cleaned.push({ item, action, goal, constraints, research });
  }
  if (errors.length > 0) return rejected([...new Set(errors)]);

  // References: entity/uses/resolved_refs are typed refs present in the
  // catalog, the entity type matches the action's target type, and the
  // candidate names the request's workspace. ANY absent or wrong-type
  // reference leaves no launchable candidate: clarification with catalog-only
  // options and the stripped question.
  const candidates = [];
  for (const { item, action, goal, constraints, research } of cleaned) {
    const uses = item.uses === undefined ? [] : item.uses;
    const resolvedRefs = item.resolved_refs === undefined ? [] : item.resolved_refs;
    const refsOk = (values) => Array.isArray(values) && values.every((value) => isTypedRef(value) && catalogRefs.has(value));
    const targetType = REQUEST_ACTIONS[action].targetType;
    const entityOk =
      isTypedRef(item.entity) &&
      catalogRefs.has(item.entity) &&
      (targetType === "workspace" ? item.entity === `workspace:${workspaceId}` : refType(item.entity) === targetType);
    if (item.workspace !== workspaceId || !entityOk || !refsOk(uses) || !refsOk(resolvedRefs)) {
      return result("clarification", [], pickOptions(proposal.options), question, []);
    }
    candidates.push({
      action,
      workspace: item.workspace,
      entity: item.entity,
      uses: [...uses],
      resolved_refs: [...resolvedRefs],
      research,
      goal,
      constraints,
    });
  }
  return result("proposal", candidates, [], question, []);
}

const SYSTEM_PROMPT =
  "Map the work request to at most three candidate actions using only the catalog references supplied with it. " +
  "Ask a question when a needed reference is missing or has the wrong type, and never invent references. " +
  "Reply with exactly one JSON object matching the schema given in the request.";

// The prompt: transcript, navigation context, resolved references, the
// bounded catalog JSON, the three action definitions with their target types
// and the reply schema. Action text is derived from the definitions' ids and
// target types only.
function buildPrompt({ workspace, transcript, context, resolvedRefs, catalog }) {
  const actions = Object.values(REQUEST_ACTIONS)
    .map((definition) => `- ${definition.id}: entity type ${definition.targetType} (${definition.targetType}:<id>)`)
    .join("\n");
  return [
    "Interpret the work request below against the authorized workspace catalog.",
    "",
    "Reply schema:",
    '{"resolution":"proposal|clarification|unsupported","candidates":[{"action":"<id>","workspace":"<id>","entity":"<ref>","uses":["<ref>"],"resolved_refs":["<ref>"],"research":{"<source>":"requested|suggested|unspecified"},"goal":"<1-120 chars>","constraints":["<1-160 chars>"]}],"options":["<ref>"],"question":"<text>"}',
    "",
    "Actions (entity type per action):",
    actions,
    "",
    `Workspace: ${workspace}`,
    "",
    "Request transcript:",
    transcript,
    "",
    "Navigation context (JSON):",
    JSON.stringify(context ?? {}),
    "",
    "Resolved references (JSON):",
    JSON.stringify(resolvedRefs),
    "",
    "Catalog entries — the only valid references (JSON):",
    JSON.stringify(catalog.entries),
  ].join("\n");
}

// The public entrypoint: validate input, build ONE catalog, prompt the model
// ONCE through the injected print runner (printReply by default), then parse
// and validate. A null reply is a rejected result, never a throw.
export function createInterpreter({ storageRoot, authorizedKit, print = printReply } = {}) {
  return {
    async interpret({ workspace_id, transcript, context, resolved_refs } = {}, signal) {
      const workspace = canonicalIdentifier(workspace_id, "workspace");
      const text = requiredTranscript(transcript);
      if (context !== undefined && !isPlainObject(context)) throw invalid("Request context must be a plain object.");
      const resolvedRefs = optionalReferences(resolved_refs);
      const catalog = await buildCatalog({ storageRoot, workspace, kit: authorizedKit });
      const reply = await print({
        text: buildPrompt({ workspace, transcript: text, context, resolvedRefs, catalog }),
        systemPrompt: SYSTEM_PROMPT,
        model: INTERPRET_MODEL,
        timeoutMs: INTERPRET_TIMEOUT_MS,
        maxOutputBytes: INTERPRET_MAX_OUTPUT_BYTES,
        signal,
      });
      if (reply === null || reply === undefined) {
        return {
          resolution: "rejected",
          candidates: [],
          options: [],
          question: "",
          errors: ["reply-unavailable"],
          omissions: catalog.omissions,
          sourceErrors: catalog.sourceErrors,
        };
      }
      return validateReply(parseReply(reply), catalog);
    },
  };
}
