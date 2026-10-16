// Focused contract tests for catalog-backed interpretation
// (scripts/spec-observe/request-interpret.mjs).
//
// Run all: node --test scripts/spec-observe/request-interpret.test.mjs
// Selectable case: node --test --test-name-pattern="<case name>" scripts/spec-observe/request-interpret.test.mjs
//
// The storage readers are real (spec-location listPackages, epics.mjs
// readWorkspaceEpics, designs.mjs listWorkspaceDesigns and lstat of plans/)
// against an isolated temp fixture workspace under os.tmpdir(). The real
// printReply runs its argv, budgets and settle logic; only the final pi child
// is faked. Nothing here touches live Sentinel/workspace storage or spawns a
// real model.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeFixture, put } from "../spec-location/fixture.mjs";
import { canonicalIdentifier as domainCanonicalIdentifier, REQUEST_LIMITS } from "../workspaces/request-actions.mjs";
import { printReply } from "../workspaces/naming.mjs";
import {
  buildCatalog,
  canonicalIdentifier,
  createInterpreter,
  parseReply,
  validateReply,
  CATALOG_LIMITS,
  INTERPRET_MAX_OUTPUT_BYTES,
  INTERPRET_MODEL,
  INTERPRET_TIMEOUT_MS,
} from "./request-interpret.mjs";

const STATIC_SOURCE_ERRORS = new Set([
  "specs-unavailable",
  "epics-unavailable",
  "designs-unavailable",
  "plans-unavailable",
]);
const CATALOG_REFS = new Set([
  "workspace:demo",
  "spec:alpha",
  "spec:beta",
  "design:01-login",
  "epic:demo-epic",
  "material:plans/roadmap.md",
]);

const EPIC_RECORD = {
  schema_version: 1,
  epic: "demo-epic",
  title: "Demo epic",
  state: "planned",
  packages: [{ package: "alpha" }],
};
const DESIGN_RECORD = {
  schema_version: 1,
  design: "01-login",
  title: "Login",
  viewport: { posture: "desktop-only", widths: [1280] },
  screens: [
    { step: 1, id: "login", title: "Login", person: "a returning user", job: "sign in", kind: "decision", state: "ideal" },
  ],
};

// Fixture workspace: kit.yaml (via makeFixture), spec directories, one valid
// epic record, one valid design index, one regular plan file and one symlinked
// plan that must never enter the catalog.
function populateWorkspace(wsDir) {
  mkdirSync(join(wsDir, "specs", "alpha"), { recursive: true });
  mkdirSync(join(wsDir, "specs", "beta"), { recursive: true });
  put(join(wsDir, "epics", "demo-epic", "epic.json"), JSON.stringify(EPIC_RECORD));
  put(join(wsDir, "designs", "01-login", "design.json"), JSON.stringify(DESIGN_RECORD));
  put(join(wsDir, "plans", "roadmap.md"), "# roadmap\n");
  symlinkSync(join(wsDir, "plans", "roadmap.md"), join(wsDir, "plans", "link.md"));
}

// Fake final pi child only: an EventEmitter with stdout/kill that emits its
// reply then close. The real printReply still builds argv and settles.
function fakeChild(reply, { code = 0 } = {}) {
  const record = { spawns: 0, calls: [], kills: [], closes: [] };
  const spawn = (command, args, options) => {
    record.spawns += 1;
    record.calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.pid = 4242;
    child.kill = (sig) => {
      record.kills.push(sig ?? "SIGTERM");
      return true;
    };
    setImmediate(() => {
      if (reply !== null && reply !== undefined) child.stdout.emit("data", Buffer.from(reply, "utf8"));
      record.closes.push({ code });
      child.emit("close", code);
    });
    return child;
  };
  return { spawn, record };
}

function makeInterpreter(fx, reply, { code = 0 } = {}) {
  const fake = fakeChild(reply, { code });
  const printed = [];
  const interpreter = createInterpreter({
    storageRoot: fx.root,
    authorizedKit: { directory: fx.workspaceDir },
    print: (options) => {
      printed.push(options);
      return printReply({ ...options, spawn: fake.spawn });
    },
  });
  return { interpreter, fake, printed };
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected rejection");
}

const candidate = (extra = {}) => ({
  action: "implement_spec",
  workspace: "demo",
  entity: "spec:alpha",
  uses: [],
  resolved_refs: [],
  research: { code: "unspecified" },
  goal: "Implement alpha",
  constraints: [],
  ...extra,
});

test("fenced and prose replies propose validated candidates for all three actions", async (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  populateWorkspace(fx.workspaceDir);

  // plan_epic on the workspace, fenced ```json reply with an unknown model
  // field that must never be echoed back.
  const planReply =
    "Analysis first.\n\n```json\n" +
    JSON.stringify({
      resolution: "proposal",
      candidates: [
        {
          action: "plan_epic",
          workspace: "demo",
          entity: "workspace:demo",
          uses: ["spec:alpha", "epic:demo-epic", "material:plans/roadmap.md"],
          resolved_refs: ["spec:alpha"],
          research: { docs: "requested" },
          goal: "Plan the demo epic",
          constraints: ["Keep scope tight"],
          label: "EVIL-LABEL-MUST-NOT-ECHO",
          effect: "rm -rf / must not echo",
        },
      ],
      options: [],
      question: "",
    }) +
    "\n```\nDone.";
  const plan = makeInterpreter(fx, planReply);
  const planResult = await plan.interpreter.interpret({
    workspace_id: "demo",
    transcript: "Please plan the demo epic.",
    context: { page: "requests", note: "context-marker-xyz" },
    resolved_refs: ["epic:demo-epic"],
  });
  assert.equal(planResult.resolution, "proposal");
  assert.deepEqual(planResult.errors, []);
  assert.deepEqual(planResult.candidates, [
    {
      action: "plan_epic",
      workspace: "demo",
      entity: "workspace:demo",
      uses: ["spec:alpha", "epic:demo-epic", "material:plans/roadmap.md"],
      resolved_refs: ["spec:alpha"],
      research: { docs: "requested" },
      goal: "Plan the demo epic",
      constraints: ["Keep scope tight"],
    },
  ]);

  // The model call arguments of the success case, through the real printReply.
  assert.equal(plan.fake.record.spawns, 1);
  assert.equal(plan.fake.record.calls[0].command, "pi");
  const argv = plan.fake.record.calls[0].args;
  assert.ok(argv.includes("--print"));
  assert.equal(argv[argv.indexOf("--model") + 1], "openrouter/inception/mercury-2.5");
  const prompt = plan.printed[0];
  assert.equal(prompt.model, INTERPRET_MODEL);
  assert.equal(prompt.model, "openrouter/inception/mercury-2.5");
  assert.equal(prompt.timeoutMs, INTERPRET_TIMEOUT_MS);
  assert.equal(prompt.timeoutMs, 20000);
  assert.equal(prompt.maxOutputBytes, INTERPRET_MAX_OUTPUT_BYTES);
  assert.equal(prompt.maxOutputBytes, 8192);

  // The prompt carries transcript, navigation context, resolved refs, catalog
  // entries and the three action definitions — never skill strings.
  const promptText = `${prompt.text}\n${prompt.systemPrompt ?? ""}`;
  assert.ok(promptText.includes("Please plan the demo epic."), "transcript");
  assert.ok(promptText.includes("context-marker-xyz"), "navigation context");
  assert.ok(promptText.includes("epic:demo-epic"), "resolved ref");
  for (const id of ["plan_epic", "build_screens", "implement_spec"]) assert.ok(promptText.includes(id), id);
  for (const key of ["resolution", "candidates"]) assert.ok(promptText.includes(key), `reply schema: ${key}`);
  for (const ref of CATALOG_REFS) assert.ok(promptText.includes(ref), ref);
  assert.ok(!promptText.includes("epic-plan"), "skill strings stay out of the prompt");
  assert.ok(!promptText.includes("design-run"), "skill strings stay out of the prompt");

  // build_screens on a catalog design, prose-wrapped reply with no fence.
  const designReply =
    "Sure - here is my proposal:\n" +
    JSON.stringify({
      resolution: "proposal",
      candidates: [
        {
          action: "build_screens",
          workspace: "demo",
          entity: "design:01-login",
          uses: ["design:01-login"],
          resolved_refs: ["design:01-login"],
          research: { code: "suggested" },
          goal: "Build the login screens",
          constraints: [],
        },
      ],
    }) +
    "\nLet me know!";
  const design = makeInterpreter(fx, designReply);
  const designResult = await design.interpreter.interpret({ workspace_id: "demo", transcript: "Build the login screens." });
  assert.equal(designResult.resolution, "proposal");
  assert.deepEqual(designResult.candidates, [
    {
      action: "build_screens",
      workspace: "demo",
      entity: "design:01-login",
      uses: ["design:01-login"],
      resolved_refs: ["design:01-login"],
      research: { code: "suggested" },
      goal: "Build the login screens",
      constraints: [],
    },
  ]);
  assert.equal(design.fake.record.spawns, 1);

  // implement_spec on a catalog spec, fenced reply.
  const specReply =
    "```json\n" +
    JSON.stringify({
      resolution: "proposal",
      candidates: [
        {
          action: "implement_spec",
          workspace: "demo",
          entity: "spec:alpha",
          uses: ["spec:alpha"],
          resolved_refs: ["spec:alpha"],
          research: { code: "unspecified" },
          goal: "Implement the alpha spec",
          constraints: ["Follow the spec", "Keep tests green"],
        },
      ],
    }) +
    "\n```";
  const spec = makeInterpreter(fx, specReply);
  const specResult = await spec.interpreter.interpret({ workspace_id: "demo", transcript: "Implement alpha." });
  assert.equal(specResult.resolution, "proposal");
  assert.deepEqual(specResult.candidates, [
    {
      action: "implement_spec",
      workspace: "demo",
      entity: "spec:alpha",
      uses: ["spec:alpha"],
      resolved_refs: ["spec:alpha"],
      research: { code: "unspecified" },
      goal: "Implement the alpha spec",
      constraints: ["Follow the spec", "Keep tests green"],
    },
  ]);
  assert.equal(spec.fake.record.spawns, 1);

  // Catalog labels live only in the catalog entries, sorted by ref.
  const catalog = await buildCatalog({ storageRoot: fx.root, workspace: "demo", kit: { directory: fx.workspaceDir } });
  assert.equal(catalog.workspace, "demo");
  const refs = catalog.entries.map((entry) => entry.ref);
  assert.deepEqual(refs, [...refs].sort(), "entries sorted deterministically by ref");
  for (const ref of CATALOG_REFS) {
    const entry = catalog.entries.find((item) => item.ref === ref);
    assert.ok(entry, `catalog carries ${ref}`);
    assert.equal(typeof entry.label, "string");
    assert.ok(entry.label.length > 0);
  }
  for (const entry of catalog.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["label", "ref", "type"]);
    assert.ok(["workspace", "spec", "design", "epic", "material"].includes(entry.type), entry.type);
  }
  assert.ok(!refs.includes("material:plans/link.md"), "symlinked plan files stay out of the catalog");
});

test("invented and wrong-type refs yield clarification with catalog-only options", async (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  populateWorkspace(fx.workspaceDir);

  // Invented ref in uses; model-supplied options include a ghost that must be
  // filtered out.
  const invented = makeInterpreter(
    fx,
    JSON.stringify({
      resolution: "proposal",
      candidates: [candidate({ uses: ["spec:ghost"] })],
      options: ["spec:ghost", "design:01-login"],
      question: "Which ghost did you mean?",
    }),
  );
  const inventedResult = await invented.interpreter.interpret({ workspace_id: "demo", transcript: "Implement alpha." });
  assert.equal(inventedResult.resolution, "clarification");
  assert.deepEqual(inventedResult.candidates, []);
  assert.ok(inventedResult.options.length <= 5);
  assert.ok(inventedResult.options.length >= 1);
  for (const option of inventedResult.options) {
    assert.ok(CATALOG_REFS.has(option), `option ${option} must be a catalog ref`);
    assert.notEqual(option, "spec:ghost");
  }

  // Wrong-type entity: build_screens with a spec entity. Model options all
  // invalid -> deterministic catalog entries.
  const wrongType = makeInterpreter(
    fx,
    JSON.stringify({
      resolution: "proposal",
      candidates: [candidate({ action: "build_screens", entity: "spec:alpha" })],
      options: ["spec:ghost"],
    }),
  );
  const wrongTypeResult = await wrongType.interpreter.interpret({ workspace_id: "demo", transcript: "Build screens." });
  assert.equal(wrongTypeResult.resolution, "clarification");
  assert.deepEqual(wrongTypeResult.candidates, []);
  assert.ok(wrongTypeResult.options.length <= 5);
  assert.ok(wrongTypeResult.options.length >= 1);
  for (const option of wrongTypeResult.options) assert.ok(CATALOG_REFS.has(option), `option ${option} must be a catalog ref`);
});

test("a fourth candidate is rejected as too-many-candidates", async (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  populateWorkspace(fx.workspaceDir);
  const reply = JSON.stringify({
    resolution: "proposal",
    candidates: [1, 2, 3, 4].map((n) => candidate({ goal: `Goal number ${n}` })),
    options: [],
    question: "",
  });
  const { interpreter } = makeInterpreter(fx, reply);
  const result = await interpreter.interpret({ workspace_id: "demo", transcript: "Do four things." });
  assert.equal(result.resolution, "rejected");
  assert.ok(result.errors.includes("too-many-candidates"));
  assert.deepEqual(result.candidates, []);
});

test("caps count omissions and source failures expose only static categories", async (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  populateWorkspace(fx.workspaceDir);
  assert.deepEqual(CATALOG_LIMITS, { specs: 100, designs: 50, epics: 50, materials: 50, bytes: 24576 });

  // 101 spec directories (plus the two fixture specs): the tail is dropped
  // completely and counted.
  for (let i = 0; i <= 100; i++) {
    mkdirSync(join(fx.workspaceDir, "specs", `s${String(i).padStart(3, "0")}`), { recursive: true });
  }
  const kit = { directory: fx.workspaceDir };
  const catalog = await buildCatalog({ storageRoot: fx.root, workspace: "demo", kit });
  assert.equal(catalog.entries.filter((entry) => entry.type === "spec").length, 100);
  assert.equal(typeof catalog.omissions, "number");
  assert.ok(catalog.omissions >= 1);

  // plans/ replaced by a regular file: a source-level failure yields exactly
  // one static category, never filesystem exception text or paths.
  rmSync(join(fx.workspaceDir, "plans"), { recursive: true, force: true });
  writeFileSync(join(fx.workspaceDir, "plans"), "not a directory\n");
  const broken = await buildCatalog({ storageRoot: fx.root, workspace: "demo", kit });
  assert.deepEqual(broken.sourceErrors, ["plans-unavailable"]);
  for (const category of broken.sourceErrors) {
    assert.ok(STATIC_SOURCE_ERRORS.has(category), `${category} must be a static category`);
    assert.ok(!category.includes("/"), "no path fragments");
  }
  assert.ok(!broken.entries.some((entry) => entry.type === "material"), "no plan entries from a failed source");
});

test("an over-limit transcript is refused before any spawn and never truncated", async (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  populateWorkspace(fx.workspaceDir);
  const { interpreter, fake } = makeInterpreter(fx, "unused");

  const longTranscript = "x".repeat(REQUEST_LIMITS.transcriptChars + 1);
  assert.equal(longTranscript.length, 2001);
  const error = await captureRejection(interpreter.interpret({ workspace_id: "demo", transcript: longTranscript }));
  assert.equal(error.code, "invalid-request");
  assert.ok(error.message.length < 200, "the reason is static and short");
  assert.ok(!error.message.includes("xxxx"), "the offending transcript is never echoed or truncated in");

  // The same refusal style for the other invalid inputs, all before any spawn.
  for (const input of [
    { workspace_id: "demo", transcript: "" },
    { workspace_id: "demo", transcript: "ok", resolved_refs: "not-a-list" },
    { workspace_id: "demo", transcript: "ok", resolved_refs: ["ghost"] },
    { workspace_id: "demo", transcript: "ok", context: "not-an-object" },
    { workspace_id: "bad..id", transcript: "ok" },
    { workspace_id: "~demo", transcript: "ok" },
    { workspace_id: "/abs/demo", transcript: "ok" },
  ]) {
    const refused = await captureRejection(interpreter.interpret(input));
    assert.equal(refused.code, "invalid-request", JSON.stringify(input));
  }
  assert.equal(fake.record.spawns, 0, "invalid input must never spawn");
});

test("canonical identifier validation is single-sourced from the request domain module", () => {
  // One acceptance policy for workspace identifiers: the interpreter reuses
  // request-actions.mjs's validator (re-exported for request-routes.mjs), so a
  // copy cannot drift and accept what brief composition later refuses.
  assert.equal(canonicalIdentifier, domainCanonicalIdentifier, "no second acceptance policy");
  assert.equal(canonicalIdentifier("demo", "workspace"), "demo");
  for (const bad of ["", "bad..id", "~demo", "/abs/demo", "a\u0000b", "x".repeat(201)]) {
    assert.throws(() => canonicalIdentifier(bad, "workspace"), { code: "invalid-request" }, JSON.stringify(bad));
  }
});

test("parseReply extracts the first balanced object and fails without one", () => {
  // Braces and escaped quotes inside JSON string values must not confuse the
  // scanner; prose surrounds a fenced reply and a later balanced decoy.
  const first = {
    resolution: "unsupported",
    note: 'close \\" then } { open',
    nested: { x: 1, deep: { y: "} still string }" } },
  };
  const text =
    "Preamble prose.\n\n```json\n" +
    JSON.stringify(first) +
    "\n```\n\nTrailing prose with a decoy {\"resolution\":\"proposal\"} object.";
  assert.deepEqual(parseReply(text), first);

  // A bare (unfenced) object in prose is also found.
  assert.deepEqual(parseReply(`hmm\n${JSON.stringify(first)}\nok`), first);
  assert.equal(parseReply("no object here"), null);
  assert.equal(parseReply("unbalanced { object"), null);
});

test("malformed replies and per-candidate limits reject with static errors and stripped prose", () => {
  const catalog = {
    workspace: "demo",
    entries: [
      { ref: "workspace:demo", type: "workspace", label: "demo" },
      { ref: "spec:alpha", type: "spec", label: "alpha" },
      { ref: "spec:beta", type: "spec", label: "beta" },
      { ref: "design:01-login", type: "design", label: "01-login" },
      { ref: "epic:demo-epic", type: "epic", label: "demo-epic" },
      { ref: "material:plans/roadmap.md", type: "material", label: "plans/roadmap.md" },
    ],
    omissions: 0,
    sourceErrors: [],
  };
  const proposal = (extra = {}) => ({
    resolution: "proposal",
    candidates: [candidate()],
    options: [],
    question: "",
    ...extra,
  });

  // Parse failure, non-object schema and a resolution outside the enum.
  for (const bad of [null, "a string", [1, 2], proposal({ resolution: "exploratory" }), proposal({ resolution: "PROPOSAL" })]) {
    const result = validateReply(bad, catalog);
    assert.equal(result.resolution, "rejected");
    assert.ok(result.errors.includes("malformed-reply"), JSON.stringify(bad));
    assert.deepEqual(result.candidates, []);
  }

  // Candidates must be a non-empty array.
  for (const candidates of [[], {}, "candidate"]) {
    const result = validateReply(proposal({ candidates }), catalog);
    assert.ok(result.errors.includes("malformed-reply"), JSON.stringify(candidates));
  }

  // Unknown actions are rejected, including inherited object keys.
  for (const action of ["launch_everything", "toString", "constructor", "__proto__"]) {
    const result = validateReply(proposal({ candidates: [candidate({ action })] }), catalog);
    assert.equal(result.resolution, "rejected");
    assert.ok(result.errors.includes("unknown-action"), action);
    assert.deepEqual(result.candidates, []);
  }

  // Goal is 1-120 characters after control characters are stripped.
  for (const goal of ["g".repeat(121), "", "   "]) {
    const result = validateReply(proposal({ candidates: [candidate({ goal })] }), catalog);
    assert.ok(result.errors.includes("malformed-reply"), JSON.stringify(goal));
  }

  // At most 5 constraints, each 1-160 characters.
  for (const constraints of [
    ["a", "b", "c", "d", "e", "f"],
    ["c".repeat(161)],
    [""],
  ]) {
    const result = validateReply(proposal({ candidates: [candidate({ constraints })] }), catalog);
    assert.ok(result.errors.includes("malformed-reply"), JSON.stringify(constraints));
  }

  // Research maps sources to RESEARCH_INTENTS values only.
  for (const research of [{ docs: "maybe" }, { docs: 1 }, ["requested"]]) {
    const result = validateReply(proposal({ candidates: [candidate({ research })] }), catalog);
    assert.ok(result.errors.includes("malformed-reply"), JSON.stringify(research));
  }

  // Control characters in display prose are stripped from the result.
  const stripped = validateReply(
    proposal({ candidates: [candidate({ goal: "Ship\u0007 the \u0000draft", constraints: ["No\u0007 breaks"] })] }),
    catalog,
  );
  assert.equal(stripped.resolution, "proposal");
  assert.equal(stripped.candidates[0].goal, "Ship the draft");
  assert.deepEqual(stripped.candidates[0].constraints, ["No breaks"]);

  // A wrong-type reference becomes clarification with a stripped question and
  // catalog-only options.
  const clarify = validateReply(
    proposal({ candidates: [candidate({ action: "build_screens", entity: "spec:alpha" })], question: "Which\u0007 one?" }),
    catalog,
  );
  assert.equal(clarify.resolution, "clarification");
  assert.deepEqual(clarify.candidates, []);
  assert.equal(clarify.question, "Which one?");
  assert.ok(clarify.options.length <= 5);
  assert.ok(clarify.options.length >= 1);
  for (const option of clarify.options) assert.ok(CATALOG_REFS.has(option), option);

  // Model-supplied clarification filters options to catalog members; a reply
  // with no usable option falls back to deterministic catalog entries.
  const modelClarify = validateReply(
    { resolution: "clarification", candidates: [], options: ["spec:ghost"], question: "Which one?" },
    catalog,
  );
  assert.equal(modelClarify.resolution, "clarification");
  assert.deepEqual(modelClarify.candidates, []);
  assert.ok(modelClarify.options.length >= 1 && modelClarify.options.length <= 5);
  for (const option of modelClarify.options) assert.ok(CATALOG_REFS.has(option), option);

  // Model-supplied unsupported carries no candidates and no options.
  const unsupported = validateReply(
    { resolution: "unsupported", candidates: [], options: ["design:01-login"], question: "No idea." },
    catalog,
  );
  assert.equal(unsupported.resolution, "unsupported");
  assert.deepEqual(unsupported.candidates, []);
  assert.deepEqual(unsupported.options, []);
});

test("a null model reply resolves rejected reply-unavailable", async (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  populateWorkspace(fx.workspaceDir);
  // A nonzero exit makes the real printReply resolve null.
  const { interpreter, fake } = makeInterpreter(fx, null, { code: 1 });
  const result = await interpreter.interpret({ workspace_id: "demo", transcript: "Anything." });
  assert.equal(result.resolution, "rejected");
  assert.deepEqual(result.candidates, []);
  assert.ok(result.errors.includes("reply-unavailable"));
  assert.equal(fake.record.spawns, 1);
});
