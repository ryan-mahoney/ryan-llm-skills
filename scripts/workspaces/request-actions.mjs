// Request actions and request briefs. This module owns the bounded catalog of
// request actions, the request media limits, and the deterministic brief text a
// request carries into launch. It is pure synchronous code: no I/O, no process,
// network or media calls, and no research of its own — a brief only restates
// what the caller supplied and observed.
//
// Skill and authority values come exclusively from the REQUEST_ACTIONS catalog
// below. The implement_spec action deliberately carries neither: the
// packageLaunchPresentation owner in
// scripts/spec-observe/frontend/src/launch-handoff.ts derives that launch
// presentation, so this module and its brief text never carry those strings.
// Model supplied text only ever appears as quoted request text (transcript,
// goal, constraints) or as validated canonical identifiers — never as paths,
// skill names, authority values or executable commands.
//
// Refusal style (settled here): invalid input throws an Error with
// code "invalid-request" and a static reason that never embeds the offending
// model text.

export const REQUEST_LIMITS = Object.freeze({
  transcriptChars: 2000,
  recordingSeconds: 30,
  sampleRateHz: 16000,
  maxAudioBytes: 1920000,
});

export const RESEARCH_INTENTS = Object.freeze(["requested", "suggested", "unspecified"]);

const REQUEST_SOURCES = Object.freeze(["typed", "spoken"]);

// The frozen action catalog: exactly three definitions. plan_epic and
// build_screens bind their skill and 'none' authority here; implement_spec
// carries no skill and no authority fields at all — a marker names the sole
// owner that supplies them.
export const REQUEST_ACTIONS = Object.freeze({
  plan_epic: Object.freeze({
    id: "plan_epic",
    targetType: "workspace",
    skill: "epic-plan",
    authority: "none",
  }),
  build_screens: Object.freeze({
    id: "build_screens",
    targetType: "design",
    skill: "design-run",
    authority: "none",
    prerequisites: Object.freeze(["observed-valid-design-index", "observed-valid-design-brief"]),
  }),
  implement_spec: Object.freeze({
    id: "implement_spec",
    targetType: "spec",
    presentationOwner: "scripts/spec-observe/frontend/src/launch-handoff.ts#packageLaunchPresentation",
  }),
});

const TITLE_PHRASES = Object.freeze({
  plan_epic: "Plan epic",
  build_screens: "Build screens",
  implement_spec: "Implement spec",
});

const NONLAUNCHABLE_REASON = "A design request needs an observed valid design index and design brief.";

const invalid = (message) => Object.assign(new Error(message), { code: "invalid-request" });
const quote = (value) => `"${value}"`;
const bullets = (items) => (items.length ? items.map((item) => `- ${item}`).join("\n") : "(none stated)");

// A canonical identifier is the catalog's own relative identity for a
// workspace, entity or use reference: non-empty and bounded, never a path form
// (no absolute paths, no '..', no backslash, no '~' expansion) and no control
// characters. Anything else is refused with a static typed reason.
function canonicalIdentifier(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw invalid(`A canonical ${label} is required.`);
  if (value.length > 200) throw invalid(`A canonical ${label} is too long.`);
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)) throw invalid(`A canonical ${label} must not contain control characters.`);
  if (value.startsWith("/") || value.startsWith("~") || /^[a-zA-Z]:/.test(value)) throw invalid(`A canonical ${label} must not be a path.`);
  if (value.includes("\\") || value.includes("..")) throw invalid(`A canonical ${label} must not be a path.`);
  return value;
}

function canonicalReferences(value) {
  const refs = value === undefined ? [] : value;
  if (!Array.isArray(refs)) throw invalid("Request uses must be a list.");
  return refs.map((entry) => canonicalIdentifier(entry, "reference"));
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw invalid(`A request ${label} is required.`);
  return value.trim();
}

// The request section: transcript and source, goal, constraints (always
// visible, even when empty), canonical use references, and per-source research
// intent flags restricted to requested|suggested|unspecified. Pure and
// synchronous; it validates its inputs and renders text only.
export function requestBriefSection({ transcript, source, goal, constraints, uses, research } = {}) {
  const text = requiredText(transcript, "transcript");
  const target = requiredText(goal, "goal");
  if (!REQUEST_SOURCES.includes(source)) throw invalid("A request source must be typed or spoken.");
  const limits = constraints === undefined ? [] : constraints;
  if (!Array.isArray(limits)) throw invalid("Request constraints must be a list.");
  const constraintLines = limits.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") throw invalid("A request constraint must be text.");
    return entry.trim();
  });
  const refs = canonicalReferences(uses);
  const intent = research === undefined ? {} : research;
  if (typeof intent !== "object" || intent === null || Array.isArray(intent)) throw invalid("Research intent must map sources to intents.");
  const intentLines = Object.keys(intent).sort().map((key) => {
    const flag = intent[key];
    if (!RESEARCH_INTENTS.includes(flag)) throw invalid("A research intent must be requested, suggested or unspecified.");
    return `${canonicalIdentifier(key, "research source")}: ${flag}`;
  });
  return [
    `Request (${source}):\n${text}`,
    `Goal:\n${target}`,
    `Constraints:\n${bullets(constraintLines)}`,
    `Uses:\n${bullets(refs)}`,
    `Research intent:\n${bullets(intentLines)}`,
  ].join("\n\n");
}

// The action-defined context block. Skill and authority text is interpolated
// only from the definition; implement_spec renders neither.
function actionBlock(definition, { workspaceId, entityId, refs, launchable }) {
  const skillLine = `catalog skill ${quote(definition.skill)} with publication authority ${quote(definition.authority)}`;
  if (definition.id === "plan_epic") {
    const packages = refs.length ? refs.map(quote).join(", ") : "(none stated)";
    return `Action: plan the epic in workspace ${quote(workspaceId)}, using ${skillLine}.\nDesired packages: ${packages}.`;
  }
  if (definition.id === "build_screens") {
    const design = entityId === undefined ? "(not yet identified)" : quote(entityId);
    if (launchable) return `Action: request ${skillLine} for design ${design} in workspace ${quote(workspaceId)}.`;
    return `Action: design request for design ${design} in workspace ${quote(workspaceId)} (${skillLine}).\nStatus: waiting on an observed valid design index and design brief.`;
  }
  return `Action: implement spec package ${quote(entityId)} in workspace ${quote(workspaceId)}.`;
}

// The request brief: a verb-phrase title, the request section plus the
// action-defined context, and a launchable flag. build_screens is only
// launchable when the design exists and both prerequisites were observed
// valid; otherwise the brief still renders with a static reason and its
// content makes no launchability claim. Pure and synchronous.
export function requestBrief(action, { workspace, entity, transcript, source, goal, constraints, uses, research, observed } = {}) {
  const definition = typeof action === "string" ? REQUEST_ACTIONS[action] : undefined;
  if (!definition) throw invalid("An unknown request action was named.");
  const workspaceId = canonicalIdentifier(workspace, "workspace");
  const goalText = requiredText(goal, "goal");
  const refs = canonicalReferences(uses);
  const entityId = entity === undefined || entity === null ? undefined : canonicalIdentifier(entity, "entity");
  if (definition.targetType === "spec" && entityId === undefined) throw invalid("A canonical entity is required.");
  let launchable = true;
  let reason;
  if (definition.id === "build_screens") {
    const seen = observed !== null && typeof observed === "object" ? observed : {};
    launchable = entityId !== undefined && seen.designIndex === true && seen.designBrief === true;
    if (!launchable) reason = NONLAUNCHABLE_REASON;
  }
  const section = requestBriefSection({ transcript, source, goal: goalText, constraints, uses: refs, research });
  const brief = {
    title: `${TITLE_PHRASES[definition.id]}: ${goalText}`,
    content: `${section}\n\n${actionBlock(definition, { workspaceId, entityId, refs, launchable })}`,
    launchable,
  };
  if (reason !== undefined) brief.reason = reason;
  return brief;
}
