import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  RESEARCH_INTENTS,
  REQUEST_ACTIONS,
  REQUEST_LIMITS,
  requestBrief,
  requestBriefSection,
} from "./request-actions.mjs";

// The package presentation owner's skill and authority strings are assembled
// here only to prove their absence from the domain module and its briefs; this
// file never carries the literals either.
const forbiddenSkill = ["spec", "end", "to", "end"].join("-");
const forbiddenAuthority = ["draft", "pr"].join("-");

const planInput = {
  workspace: "agent-tooling",
  transcript: "Turn the new UI notes into a package plan",
  source: "typed",
  goal: "Split the new UI work into bounded packages",
  constraints: ["Keep the browser thin", "No new dependencies"],
  uses: ["agent-tooling/newui-13-request-work"],
  research: { web: "requested", codebase: "unspecified" },
};

test("catalog binds exactly three actions with the settled target types and skills", () => {
  assert.deepEqual(Object.keys(REQUEST_ACTIONS).sort(), ["build_screens", "implement_spec", "plan_epic"]);
  assert.equal(REQUEST_ACTIONS.plan_epic.targetType, "workspace");
  assert.equal(REQUEST_ACTIONS.plan_epic.skill, "epic-plan");
  assert.equal(REQUEST_ACTIONS.plan_epic.authority, "none");
  assert.equal(REQUEST_ACTIONS.build_screens.targetType, "design");
  assert.equal(REQUEST_ACTIONS.build_screens.skill, "design-run");
  assert.equal(REQUEST_ACTIONS.build_screens.authority, "none");
  assert.deepEqual([...REQUEST_ACTIONS.build_screens.prerequisites], ["observed-valid-design-index", "observed-valid-design-brief"]);
  assert.equal(REQUEST_ACTIONS.implement_spec.targetType, "spec");
});

test("request limits hold the settled transcript and media values", () => {
  assert.deepEqual({ ...REQUEST_LIMITS }, { transcriptChars: 2000, recordingSeconds: 30, sampleRateHz: 16000, maxAudioBytes: 1920000 });
});

test("plan epic brief names the workspace, desired packages and request text with catalog skill and none authority", () => {
  const brief = requestBrief("plan_epic", planInput);
  assert.equal(brief.launchable, true);
  assert.equal(brief.reason, undefined);
  assert.equal(brief.title, "Plan epic: Split the new UI work into bounded packages");
  const { content } = brief;
  assert.ok(content.includes('workspace "agent-tooling"'), content);
  assert.ok(content.includes('Desired packages: "agent-tooling/newui-13-request-work".'), content);
  assert.ok(content.includes("Turn the new UI notes into a package plan"), content);
  assert.ok(content.includes("Split the new UI work into bounded packages"), content);
  assert.ok(content.includes("- Keep the browser thin"), content);
  assert.ok(content.includes("- No new dependencies"), content);
  assert.ok(content.includes("Request (typed):"), content);
  assert.ok(content.includes('catalog skill "epic-plan"'), content);
  assert.ok(content.includes('publication authority "none"'), content);
});

test("build screens brief names the exact workspace and design slug and requests design-run", () => {
  const brief = requestBrief("build_screens", {
    workspace: "agent-tooling",
    entity: "context-command-surfacing",
    transcript: "Mock the account switcher screens",
    source: "spoken",
    goal: "Show the account switcher states",
    constraints: ["Stay inside the current design system"],
    uses: ["agent-tooling/context-command-surfacing"],
    research: { web: "suggested" },
    observed: { designIndex: true, designBrief: true },
  });
  assert.equal(brief.launchable, true);
  assert.equal(brief.reason, undefined);
  assert.equal(brief.title, "Build screens: Show the account switcher states");
  const { content } = brief;
  assert.ok(content.includes('design "context-command-surfacing"'), content);
  assert.ok(content.includes('workspace "agent-tooling"'), content);
  assert.ok(content.includes('catalog skill "design-run"'), content);
  assert.ok(content.includes('publication authority "none"'), content);
  assert.ok(content.includes("Request (spoken):"), content);
  assert.ok(content.includes("Mock the account switcher screens"), content);
});

test("path-like or parent-traversal identifiers are refused with a static typed reason", () => {
  const refused = (bad, build) => assert.throws(build, (error) =>
    error.code === "invalid-request" && typeof error.message === "string" && !error.message.includes(bad));
  for (const bad of ["/etc/passwd", "../secrets", "design\\slug", "~root", "a\u0000b"]) {
    refused(bad, () => requestBrief("plan_epic", { ...planInput, workspace: bad }));
    refused(bad, () => requestBrief("plan_epic", { ...planInput, uses: ["ok/pkg", bad] }));
    refused(bad, () => requestBrief("implement_spec", { ...planInput, entity: bad }));
    refused(bad, () => requestBriefSection({ transcript: "x", source: "typed", goal: "y", research: { [bad]: "requested" } }));
  }
  assert.throws(() => requestBrief("plan_epic", { ...planInput, workspace: "" }), { code: "invalid-request" });
  assert.throws(() => requestBrief("plan_epic", { ...planInput, workspace: undefined }), { code: "invalid-request" });
});

test("implement spec definition and brief cannot override the package owner skill or authority", () => {
  const definition = REQUEST_ACTIONS.implement_spec;
  assert.equal("skill" in definition, false);
  assert.equal("authority" in definition, false);
  assert.equal(definition.presentationOwner, "scripts/spec-observe/frontend/src/launch-handoff.ts#packageLaunchPresentation");
  const brief = requestBrief("implement_spec", {
    workspace: "agent-tooling",
    entity: "agent-tooling/newui-13-request-work",
    transcript: "Implement the prepared request work spec",
    source: "typed",
    goal: "Land the request work packages",
    constraints: ["Follow the prepared specs"],
    uses: ["agent-tooling/newui-13-request-work"],
    research: { codebase: "suggested" },
  });
  assert.equal(brief.launchable, true);
  assert.equal(brief.title, "Implement spec: Land the request work packages");
  const { content } = brief;
  assert.ok(content.includes('spec package "agent-tooling/newui-13-request-work"'), content);
  assert.ok(content.includes('workspace "agent-tooling"'), content);
  for (const value of [forbiddenSkill, forbiddenAuthority, REQUEST_ACTIONS.plan_epic.skill, REQUEST_ACTIONS.build_screens.skill]) {
    assert.equal(content.includes(value), false, value);
  }
  assert.equal(/\bskill\b/i.test(content), false, content);
  assert.equal(/\bauthority\b/i.test(content), false, content);
  assert.equal(/\bpublication authority\b/i.test(content), false, content);
});

test("the domain module never names the package owner's skill or authority strings", () => {
  const source = readFileSync(new URL("./request-actions.mjs", import.meta.url), "utf8");
  assert.equal(source.includes(forbiddenSkill), false);
  assert.equal(source.includes(forbiddenAuthority), false);
});

test("research intents and constraints stay visible through a pure synchronous section", () => {
  const input = {
    transcript: "Compare the two onboarding flows",
    source: "typed",
    goal: "Decide the onboarding direction",
    constraints: ["Answer from the captured notes"],
    uses: ["agent-tooling/newui-13-request-work"],
    research: { web: "requested", code: "suggested", api: "unspecified" },
  };
  const snapshot = structuredClone(input);
  const first = requestBriefSection(input);
  assert.equal(first, requestBriefSection(input), "identical inputs must render identical sections");
  assert.deepEqual(input, snapshot, "the call must not mutate its inputs");
  assert.equal(typeof first, "string");
  for (const line of ["- web: requested", "- code: suggested", "- api: unspecified"]) assert.ok(first.includes(line), line);
  assert.ok(first.includes("Constraints:\n- Answer from the captured notes"), first);
  assert.ok(first.includes("Research intent:"), first);
  assert.ok(first.includes("Compare the two onboarding flows"), first);
  assert.ok(first.includes("Goal:\nDecide the onboarding direction"), first);
  // Constraints and research stay visible even when empty.
  const empty = requestBriefSection({ ...input, constraints: [], research: {} });
  assert.ok(empty.includes("Constraints:\n(none stated)"), empty);
  assert.ok(empty.includes("Research intent:\n(none stated)"), empty);
  assert.deepEqual([...RESEARCH_INTENTS], ["requested", "suggested", "unspecified"]);
  assert.throws(() => requestBriefSection({ ...input, research: { web: "maybe" } }), { code: "invalid-request" });
  assert.throws(() => requestBriefSection({ ...input, source: "yelled" }), { code: "invalid-request" });
  assert.throws(() => requestBriefSection({ ...input, goal: "" }), { code: "invalid-request" });
  assert.throws(() => requestBriefSection({ ...input, transcript: undefined }), { code: "invalid-request" });
});

test("omitted request inputs are refused rather than silently dropped", () => {
  assert.throws(() => requestBrief("plan_epic", { ...planInput, transcript: undefined }), { code: "invalid-request" });
  assert.throws(() => requestBrief("plan_epic", { ...planInput, goal: undefined }), { code: "invalid-request" });
  assert.throws(() => requestBrief("plan_epic", { ...planInput, source: undefined }), { code: "invalid-request" });
  assert.throws(() => requestBrief("plan_epic", { ...planInput, constraints: "keep it small" }), { code: "invalid-request" });
  assert.throws(() => requestBrief("unknown_action", planInput), { code: "invalid-request" });
  assert.throws(() => requestBrief("implement_spec", { ...planInput, entity: undefined }), { code: "invalid-request" });
});

test("inherited property names are refused as unknown actions with a static reason", () => {
  // Plain catalog indexing would return an inherited value for these names and
  // accept them as launchable; the brief boundary must refuse every one instead.
  const inherited = [
    "toString",
    "constructor",
    "__proto__",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "valueOf",
    "toLocaleString",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
  ];
  for (const action of inherited) {
    assert.equal(Object.hasOwn(REQUEST_ACTIONS, action), false, action);
    const refused = (build) => assert.throws(build, (error) =>
      error.code === "invalid-request" && typeof error.message === "string" && !error.message.includes(action));
    refused(() => requestBrief(action, planInput));
    refused(() => requestBrief(action, { ...planInput, entity: "agent-tooling/newui-13-request-work" }));
    refused(() => requestBrief(action, { ...planInput, entity: undefined, observed: { designIndex: true, designBrief: true } }));
  }
});

test("build screens without an observed valid design index and brief stays nonlaunchable", () => {
  const base = {
    workspace: "agent-tooling",
    entity: "context-command-surfacing",
    transcript: "Mock the account switcher screens",
    source: "typed",
    goal: "Show the account switcher states",
    constraints: ["Stay inside the current design system"],
    uses: [],
    research: {},
  };
  for (const observed of [undefined, {}, { designIndex: true }, { designBrief: true }, { designIndex: "yes", designBrief: true }]) {
    const brief = requestBrief("build_screens", { ...base, observed });
    assert.equal(brief.launchable, false);
    assert.equal(brief.reason, "A design request needs an observed valid design index and design brief.");
    assert.equal(brief.title, "Build screens: Show the account switcher states");
    const { content } = brief;
    assert.ok(content.includes('design "context-command-surfacing"'), content);
    assert.ok(content.includes('workspace "agent-tooling"'), content);
    assert.equal(/launch/i.test(content), false, "content must not claim launchability");
  }
  const missingDesign = requestBrief("build_screens", {
    ...base,
    entity: undefined,
    observed: { designIndex: true, designBrief: true },
  });
  assert.equal(missingDesign.launchable, false);
  assert.equal(missingDesign.reason, "A design request needs an observed valid design index and design brief.");
  assert.ok(missingDesign.content.includes("(not yet identified)"), missingDesign.content);
  assert.equal(/launch/i.test(missingDesign.content), false, "content must not claim launchability");
  // The same request with both observations is the happy path.
  assert.equal(requestBrief("build_screens", { ...base, observed: { designIndex: true, designBrief: true } }).launchable, true);
});
