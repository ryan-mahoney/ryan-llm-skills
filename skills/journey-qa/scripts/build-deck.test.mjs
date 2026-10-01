import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRun, siblingRuns, describeTarget, observationsText } from "./build-deck.mjs";
import { fixtureBrief, fixtureRun } from "./test-fixtures.mjs";

const SCRIPT = fileURLToPath(new URL("./build-deck.mjs", import.meta.url));

const tempDirs = [];
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const editJson = (dir, name, edit) => {
  const path = join(dir, name);
  const value = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, `${JSON.stringify(edit(value), null, 2)}\n`);
};

// The deck CLI's own exit code and stderr, through a real process.
const runCli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

test("a missing key in result.json names the file and the key", () => {
  const dir = tempDir("build-deck-missing-result-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  editJson(runDir, "result.json", (result) => {
    delete result.finishedAt;
    return result;
  });

  const result = runCli(["--run", runDir, "--out", join(dir, "deck.html")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /result\.json: missing key "finishedAt"/);
});

test("a missing key in review.json names the file and the key", () => {
  const dir = tempDir("build-deck-missing-review-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  editJson(runDir, "review.json", (review) => {
    delete review.journey.decidingStep;
    return review;
  });

  const result = runCli(["--run", runDir, "--out", join(dir, "deck.html")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /review\.json journey: missing key "decidingStep"/);
});

test("an unknown key in result.json names the file and the key", () => {
  const dir = tempDir("build-deck-unknown-result-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  editJson(runDir, "result.json", (result) => ({ ...result, rating: "Direct" }));

  const result = runCli(["--run", runDir, "--out", join(dir, "deck.html")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /result\.json: unknown key "rating"/);
});

test("an unknown key in review.json names the file and the key", () => {
  const dir = tempDir("build-deck-unknown-review-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  editJson(runDir, "review.json", (review) => ({ ...review, band: "direct" }));

  const result = runCli(["--run", runDir, "--out", join(dir, "deck.html")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /review\.json: unknown key "band"/);
});

test("a missing run file names it", () => {
  const dir = tempDir("build-deck-missing-file-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  rmSync(join(runDir, "steps.jsonl"));

  const result = runCli(["--run", runDir, "--out", join(dir, "deck.html")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /steps\.jsonl: missing file/);
});

test("a harness-error run is not rated and writes no output file", () => {
  const dir = tempDir("build-deck-harness-error-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  editJson(runDir, "result.json", (result) => ({
    ...result,
    status: "harness-error",
    check: { ...result.check, pass: null },
    reason: "validator jar missing",
  }));
  const out = join(dir, "deck.html");

  const result = runCli(["--run", runDir, "--out", out]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not rated: validator jar missing/);
  assert.equal(existsSync(out), false);
});

test("an unknown flag is rejected", () => {
  const result = runCli(["--deck", "x"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown flag "--deck"/);
});

test("sibling runs list the same scenario only, sorted, and include this run", () => {
  const runsDir = tempDir("build-deck-siblings-");
  const first = join(runsDir, "20261001T100000Z-JRNY-001-import");
  const second = join(runsDir, "20261002T100000Z-JRNY-001-import");
  const other = join(runsDir, "20261003T100000Z-JRNY-002-change-times");
  fixtureRun(first);
  fixtureRun(second);
  fixtureRun(other);
  editJson(other, "session.json", (session) => ({ ...session, scenario: "JRNY-002/change-times" }));

  const siblings = siblingRuns(second);
  assert.deepEqual(siblings.map((sibling) => sibling.name), [
    "20261001T100000Z-JRNY-001-import",
    "20261002T100000Z-JRNY-001-import",
  ]);
  assert.deepEqual(siblings.map((sibling) => sibling.status), ["completed", "completed"]);
});

test("a sibling with no result reads no result recorded and gets no rating", () => {
  const runsDir = tempDir("build-deck-sibling-pending-");
  const first = join(runsDir, "20261001T100000Z-JRNY-001-import");
  const second = join(runsDir, "20261002T100000Z-JRNY-001-import");
  fixtureRun(first);
  fixtureRun(second);
  rmSync(join(second, "result.json"));
  rmSync(join(second, "review.json"));

  const siblings = siblingRuns(first);
  assert.deepEqual(siblings.map((sibling) => sibling.status), ["completed", "no result recorded"]);
  assert.equal(siblings[1].rating, null);
  assert.equal(siblings[1].claim, null);
});

test("a loaded run keeps the values the deck will print", () => {
  const dir = tempDir("build-deck-load-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  const run = loadRun(runDir);

  assert.equal(run.result.proxies.actions, 10);
  assert.equal(run.result.stubExclusions.length, 2);
  assert.equal(run.review.findings[0].severity, "low");
  assert.equal(run.steps.length, 4);
  assert.match(run.brief, /## Goal/);
});

// --- render cases (step 18) ---

const deckOf = (args) => {
  const result = runCli(args);
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(args[args.indexOf("--out") + 1], "utf8");
};

/** Every `data-source` element's text, as a map from the path it names. */
const figuresIn = (html) => {
  const figures = new Map();
  for (const match of html.matchAll(/<span class="figure" data-source="([^"]+)">([^<]*)<\/span>/g)) {
    figures.set(match[1], match[2]);
  }
  return figures;
};

test("the deck names no external reference and inlines every image", () => {
  const dir = tempDir("build-deck-self-contained-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);

  assert.equal(html.includes("http://"), false);
  assert.equal(html.includes("https://"), false);
  const images = [...html.matchAll(/<img[^>]+src="([^"]*)"/g)].map((match) => match[1]);
  assert.ok(images.length >= 2, "the filmstrip renders the run's captures");
  for (const source of images) assert.match(source, /^data:image\/png;base64,/);
  assert.match(html, /<style>/);
  assert.match(html, /<script>/);
  assert.match(html, /font-family:Inter,"Helvetica Neue",Helvetica,Arial,sans-serif/);
});

test("every data-source figure equals the fixture value at that path", () => {
  const dir = tempDir("build-deck-figures-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);
  const run = loadRun(runDir);
  const figures = figuresIn(html);

  // The sources this deck reads: the run files, the rating the deck computed
  // and the sibling listing. Nothing else may carry a data-source.
  const expected = {
    "result.run": run.result.run,
    "result.scenario": run.result.scenario,
    "result.status": run.result.status,
    "result.commit": run.result.commit,
    "result.referenceActions": run.result.referenceActions,
    "result.check.id": run.result.check.id,
    "result.check.pass": run.result.check.pass,
    "proxies.actions": run.result.proxies.actions,
    "proxies.backtracks": run.result.proxies.backtracks,
    "proxies.errorsSeen.total": run.result.proxies.errorsSeen.total,
    "proxies.elapsedSeconds": run.result.proxies.elapsedSeconds,
    "captures.count": 2,
    "steps[1].intent": run.steps[1].intent,
    "steps[2].expected": run.steps[2].expected,
    "review.findings[0].severity": run.review.findings[0].severity,
  };
  for (const [source, value] of Object.entries(expected)) {
    assert.equal(figures.get(source), String(value), `data-source="${source}"`);
  }

  const allowed = /^(result|proxies|review|siblings|steps|rating|agreement|captures)\b/;
  for (const source of figures.keys()) {
    assert.match(source, allowed, `unexpected data-source path "${source}"`);
  }
  assert.equal(figures.size >= Object.keys(expected).length, true);
});

test("a missing capture renders a labelled Not captured placeholder", () => {
  const dir = tempDir("build-deck-missing-capture-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  rmSync(join(runDir, "captures", "s002.png"));
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);

  assert.match(html, /Not captured/);
  assert.match(html, /captures\/s002\.png/);
  assert.equal(figuresIn(html).get("captures.count"), "1");
  assert.equal(html.includes("data:image/png;base64,") !== false, true, "the remaining capture is still inlined");
});

test("a two-run scenario lists both runs and says how many completed", () => {
  const dir = tempDir("build-deck-explorations-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  const second = join(dir, "sibling");
  fixtureRun(second);
  editJson(second, "session.json", (session) => ({ ...session, run: "20261002T100000Z-JRNY-001-import" }));
  editJson(second, "result.json", (result) => ({
    ...result,
    run: "20261002T100000Z-JRNY-001-import",
    status: "not-completed",
    claim: "gave-up",
    check: { ...result.check, pass: false },
  }));
  editJson(second, "review.json", (review) => ({
    ...review,
    journey: { attribution: "product", decidingStep: 2 },
  }));
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);

  assert.match(html, /Completed in 1 of 2 runs of JRNY-001\/import/);
  assert.match(html, /20261001T100000Z-JRNY-001-import/);
  assert.match(html, /20261002T100000Z-JRNY-001-import/);
  assert.match(html, /not-completed/);
});

test("a not-completed run shows the R18 attribution wording, not a rating band", () => {
  const dir = tempDir("build-deck-attribution-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  editJson(runDir, "result.json", (result) => ({
    ...result,
    status: "not-completed",
    claim: "gave-up",
    check: { ...result.check, pass: false },
  }));
  editJson(runDir, "review.json", (review) => ({
    ...review,
    journey: { attribution: "product", decidingStep: 2 },
  }));
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);

  assert.match(html, /Not completed: product/);
  assert.match(html, /decided at step/);
  assert.equal(/Not completed in this run \(tester or harness limit\)/.test(html), false);
});

test("a tester or harness attribution reads as a limit, not a product failure", () => {
  const dir = tempDir("build-deck-attribution-tester-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  editJson(runDir, "result.json", (result) => ({
    ...result,
    status: "not-completed",
    claim: "gave-up",
    check: { ...result.check, pass: false },
  }));
  editJson(runDir, "review.json", (review) => ({
    ...review,
    journey: { attribution: "tester", decidingStep: 2 },
  }));
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);

  assert.match(html, /Not completed in this run \(tester or harness limit\)/);
  assert.equal(/Not completed: product/.test(html), false);
});

test("the limits slide carries every mandatory statement and the exclusion list", () => {
  const dir = tempDir("build-deck-limits-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);

  for (const statement of [
    "instructed not to read the code",
    "nine stops and two-stop trips",
    "1,000 weeks",
    "stubbed",
    "/map/tiles/",
    "/map/buildings",
    "real jar, not a stub",
    "Explorations slide lists",
    "The reviewer is the same model as the tester",
    "Reviewer judgments are not user research",
    "The app commit under test",
  ]) {
    assert.ok(html.includes(statement), `limits slide is missing: ${statement}`);
  }
  // Vocabulary the deck may not use about a run.
  for (const banned of [/\bblind\b/i, /\beasy\b/i, /\bworks\b/i, /the app passed/i]) {
    assert.equal(banned.test(html), false, `banned deck wording: ${banned}`);
  }
});

test("--second-review adds the repeatability line and one deck is nine slides", () => {
  const dir = tempDir("build-deck-second-review-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  const secondPath = join(dir, "review-2.json");
  writeFileSync(
    secondPath,
    `${JSON.stringify(
      {
        ...JSON.parse(readFileSync(join(runDir, "review.json"), "utf8")),
        steps: [
          { n: 1, q1: 2, q2: 2, q3: 2, q4: 2, captures: ["s001.png"], note: null },
          { n: 2, q1: 2, q2: 1, q3: 1, q4: 1, captures: ["s002.png"], note: "seen a progress bar" },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const without = deckOf(["--run", runDir, "--out", join(dir, "plain.html")]);
  assert.equal(/Repeatability, not validity/.test(without), false, "one review is not a second data point");

  const withSecond = deckOf(["--run", runDir, "--out", join(dir, "deck.html"), "--second-review", secondPath]);
  assert.match(withSecond, /Repeatability, not validity/);
  assert.match(withSecond, /agree exactly on 6 of 7 compared questions/);
  assert.match(withSecond, /within one on 7 of 7/);

  const slideIds = [...withSecond.matchAll(/<section class="slide" id="(s\d)"/g)].map((match) => match[1]);
  assert.deepEqual(slideIds, ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]);
});

// --- action target and goal cases (step 18 pilot repair) ---

test("an action target object reads as the element it names", () => {
  // The shapes steps.jsonl records (C-4 action vocabulary), each rendered the
  // way a reader would say it rather than as an object literal.
  assert.equal(describeTarget({ role: "button", name: "Import feed" }), 'button "Import feed"');
  assert.equal(describeTarget({ text: "Import feed" }), 'text "Import feed"');
  assert.equal(describeTarget({ label: "Version name" }), 'label "Version name"');
  assert.equal(describeTarget({ path: "/" }), 'path "/"');
  assert.equal(describeTarget({ key: "Enter" }), 'key "Enter"');
  assert.equal(describeTarget({ role: "button", name: "Import feed", enabled: true }), 'button "Import feed" enabled=true');
  assert.equal(describeTarget({ text: "Choose a .zip file", file: "sample-feed.zip" }), 'text "Choose a .zip file" file "sample-feed.zip"');
  assert.equal(describeTarget({ label: "Version name", value: "October 2026 service" }), 'label "Version name" value "October 2026 service"');
});

test("a target shape the vocabulary does not name reads as key=value pairs", () => {
  assert.equal(describeTarget({ locator: "import-tab", nth: 2 }), "locator=import-tab nth=2");
  assert.equal(describeTarget({}), null);
  assert.equal(describeTarget(null), null);
  assert.equal(describeTarget(""), null);
});

test("a target already stored as a string is that string", () => {
  assert.equal(describeTarget("/versions/new"), "/versions/new");
  assert.equal(describeTarget(12), "12");
});

test("a quote inside a target value cannot close the phrase", () => {
  assert.equal(describeTarget({ text: 'Say "Import feed"' }), 'text "Say \'Import feed\'"');
});

test("the filmstrip renders every target from its own fields", () => {
  const dir = tempDir("build-deck-targets-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  const lines = [
    { kind: "step", n: 1, action: "click", target: { role: "button", name: "Import feed" } },
    { kind: "step", n: 2, action: "fill", target: { label: "Version name", value: "October 2026 service" } },
    { kind: "step", n: 3, action: "upload", target: { text: "Choose a .zip file", file: "sample-feed.zip" } },
    { kind: "step", n: 4, action: "goto", target: { path: "/" } },
    { kind: "step", n: 5, action: "scroll", target: { locator: "page", dy: -400 } },
  ].map((step) => JSON.stringify({ ...step, run: "r", t: 0, ok: true, rejected: false, error: null, capture: "captures/s001.png", intent: "i", expected: "e" }));
  writeFileSync(join(runDir, "steps.jsonl"), `${lines.join("\n")}\n`);
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);

  for (const rendered of [
    'click button &quot;Import feed&quot;',
    'fill label &quot;Version name&quot; value &quot;October 2026 service&quot;',
    'upload text &quot;Choose a .zip file&quot; file &quot;sample-feed.zip&quot;',
    'goto path &quot;/&quot;',
    "scroll locator=page dy=-400",
  ]) {
    assert.ok(html.includes(rendered), `the filmstrip is missing: ${rendered}`);
  }
  assert.equal(html.includes("[object Object]"), false, "no target renders as an object literal");
});

test("slide 1 states the goal in the tester's own words", () => {
  const dir = tempDir("build-deck-goal-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);
  const slide1 = /<section class="slide" id="s1".*?<\/section>/s.exec(html)[0];

  assert.match(slide1, /What the tester was trying to do:/);
  assert.ok(slide1.includes("Import the sample feed and see the new version listed."), "the goal sentence is the brief's own words");
});

test("a brief whose headings are the tester's own words still fills both slides", () => {
  const dir = tempDir("build-deck-brief-headings-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  writeFileSync(
    join(runDir, "brief.md"),
    `# Import a feed

## Who you are

An operator who publishes timetables.

## What you are trying to do

Import the sample feed and see the new version listed.

## Where you start

Open /.

## Files you can upload

- sample-feed.zip
`,
  );
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);

  assert.ok(html.includes("What the tester was trying to do: Import the sample feed and see the new version listed."), "slide 1 reads the goal under the harness's heading");
  assert.ok(html.includes("An operator who publishes timetables."), "slide 2 reads the persona");
  assert.ok(html.includes("Open /."), "slide 2 reads the start path");
  assert.ok(html.includes("sample-feed.zip</li>"), "slide 2 lists the files");
  assert.equal(/<p><\/p>/.test(html), false, "no tester-visible section renders empty");
});

test("a brief with no goal section says so instead of inventing one", () => {
  const dir = tempDir("build-deck-no-goal-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  writeFileSync(join(runDir, "brief.md"), "# Import a feed\n\n## Who you are\n\nAn operator.\n");
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);

  assert.match(html, /the brief recorded no goal for this scenario/);
});

test("check observations render as sentences whether a check wrote one or many", () => {
  assert.equal(observationsText("5 files imported"), "5 files imported");
  assert.equal(observationsText(["a", "b"]), "a b");
  assert.equal(observationsText(undefined), "none recorded");

  const dir = tempDir("build-deck-observations-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  editJson(runDir, "result.json", (result) => ({
    ...result,
    check: { ...result.check, observations: ["routes hold", "stops hold"] },
  }));
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);

  assert.ok(html.includes("routes hold stops hold"), "every observation sentence is shown");
  assert.equal(html.includes("routes hold,stops hold"), false, "observations are never comma-joined");
});

test("an empty findings array reads as a state, not an empty panel", () => {
  const dir = tempDir("build-deck-no-findings-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  editJson(runDir, "review.json", (review) => ({ ...review, findings: [] }));
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);

  assert.match(html, /No findings recorded\./);
});

test("an unscored reviewer question reads as not scored, never as zero", () => {
  const dir = tempDir("build-deck-not-scored-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);

  assert.match(html, /not scored/);
  assert.equal(figuresIn(html).has("review.steps[1].q3"), false);
});

test("a sibling with no recorded result is listed without a rating word", () => {
  const dir = tempDir("build-deck-sibling-deck-");
  const runDir = join(dir, "run");
  fixtureRun(runDir);
  const pending = join(dir, "pending");
  fixtureRun(pending);
  editJson(pending, "session.json", (session) => ({ ...session, run: "20261003T100000Z-JRNY-001-import" }));
  rmSync(join(pending, "result.json"));
  rmSync(join(pending, "review.json"));
  const html = deckOf(["--run", runDir, "--out", join(dir, "deck.html")]);

  assert.match(html, /no result recorded/);
  assert.equal(/siblings\[1\]\.rating/.test(html), false, "a run with no result gets no rating element");
});

// --- summary deck cases (step 19) ---

/**
 * A runs directory over the fixture brief's four FEAT rows: JRNY-001/import
 * explored twice (the later run is the one the deck reports), JRNY-002's
 * change-times not completed by a product limit, add-trip a harness error, and
 * JRNY-003/export never run.
 */
function fixtureCollection(dir) {
  const brief = fixtureBrief(dir);
  const runs = join(dir, "runs");
  mkdirSync(runs, { recursive: true });

  const importRun = (name, startedAt) => {
    const runDir = join(runs, name);
    fixtureRun(runDir);
    editJson(runDir, "session.json", (session) => ({ ...session, run: name, startedAt }));
    editJson(runDir, "result.json", (result) => ({ ...result, run: name }));
    editJson(runDir, "review.json", (review) => ({ ...review, run: name }));
    return runDir;
  };

  importRun("20261001T100000Z-JRNY-001-import", "2026-10-01T10:00:00Z");
  importRun("20261002T100000Z-JRNY-001-import", "2026-10-02T10:00:00Z");

  const changeTimes = importRun("20261002T090000Z-JRNY-002-change-times", "2026-10-02T09:00:00Z");
  editJson(changeTimes, "session.json", (session) => ({ ...session, scenario: "JRNY-002/change-times" }));
  editJson(changeTimes, "result.json", (result) => ({
    ...result,
    scenario: "JRNY-002/change-times",
    status: "not-completed",
    claim: "gave-up",
    check: { ...result.check, pass: false },
  }));
  editJson(changeTimes, "review.json", (review) => ({ ...review, journey: { attribution: "product", decidingStep: 2 } }));

  const addTrip = importRun("20261002T110000Z-JRNY-002-add-trip", "2026-10-02T11:00:00Z");
  editJson(addTrip, "session.json", (session) => ({ ...session, scenario: "JRNY-002/add-trip" }));
  editJson(addTrip, "result.json", (result) => ({
    ...result,
    scenario: "JRNY-002/add-trip",
    status: "harness-error",
    claim: null,
    reason: "validator jar missing",
    check: { ...result.check, pass: null },
  }));

  return { brief, runs };
}

const summaryDeckOf = (dir, brief, runs) =>
  deckOf(["--summary", "--brief", brief, "--runs", runs, "--out", join(dir, "summary.html")]);

/** Every coverage cell as a map from `FEAT-### / JRNY-###` to its text. */
const cellsIn = (html) => {
  const cells = new Map();
  for (const match of html.matchAll(/<span class="state state--\w+" data-source="features\[(\d+)\]\.coverage\.([^"]+)">([^<]*)<\/span>/g)) {
    cells.set(`${match[1]}/${match[2]}`, match[3]);
  }
  return cells;
};

test("the matrix statuses and the three counts equal the fixture", () => {
  const dir = tempDir("build-deck-summary-matrix-");
  const { brief, runs } = fixtureCollection(dir);
  const html = summaryDeckOf(dir, brief, runs);
  const figures = figuresIn(html);

  assert.equal(figures.get("counts.features"), "4");
  assert.equal(figures.get("counts.featuresWithJourney"), "3");
  assert.equal(figures.get("counts.journeysExplored"), "2");

  const cells = cellsIn(html);
  assert.equal(cells.get("0/JRNY-001"), "explored: import Direct");
  assert.equal(cells.get("1/JRNY-002"), "explored: change-times Not completed: product; add-trip registered, not yet explored");
  assert.equal(cells.get("2/JRNY-003"), "registered, not yet explored");
  // A journey this feature does not name is a dash; a feature with no journey
  // at all says so in every column.
  assert.equal(cells.get("0/JRNY-002"), "—");
  assert.equal(cells.get("3/JRNY-001"), "no registered journey");
  assert.equal(cells.get("3/JRNY-003"), "no registered journey");
  assert.equal(cells.size, 12, "four features by three registered journeys");

  // The later run of the scenario is the one reported, and both are counted.
  assert.equal(figures.get("scenarios[0].status"), "completed");
  assert.equal(figures.get("scenarios[0].explorations"), "2");
  assert.equal(figures.get("scenarios[1].status"), "not-completed");
  assert.equal(figures.get("scenarios[1].decidingStep"), "2");
  assert.match(html, /Not completed: product/);
  assert.equal(/Not completed in this run \(tester or harness limit\)/.test(html), false);
});

test("a harness-error-only scenario is registered, not yet explored", () => {
  const dir = tempDir("build-deck-summary-harness-error-");
  const { brief, runs } = fixtureCollection(dir);
  // JRNY-003/export has no run at all, and JRNY-002's second scenario has only
  // a harness error. Neither is ever given a rating word.
  const exported = join(runs, "20261003T100000Z-JRNY-003-export");
  fixtureRun(exported);
  editJson(exported, "session.json", (session) => ({ ...session, run: "20261003T100000Z-JRNY-003-export", scenario: "JRNY-003/export", startedAt: "2026-10-03T10:00:00Z" }));
  editJson(exported, "result.json", (result) => ({
    ...result,
    run: "20261003T100000Z-JRNY-003-export",
    scenario: "JRNY-003/export",
    status: "harness-error",
    claim: null,
    reason: "driver socket closed",
    check: { ...result.check, pass: null },
  }));
  const html = summaryDeckOf(dir, brief, runs);

  const cells = cellsIn(html);
  assert.equal(cells.get("2/JRNY-003"), "registered, not yet explored", "a journey whose only run is a harness error is not explored");
  assert.match(html, /20261003T100000Z-JRNY-003-export<\/span> \(driver socket closed\)/);
  assert.equal(/scenarios\[2\]\.rating/.test(html), false, "neither a harness error nor an unrated scenario gets a rating element");
  assert.equal(figuresIn(html).get("counts.journeysExplored"), "2", "the third journey is still unex");
});

test("the summary output names no external reference and every figure equals its source", () => {
  const dir = tempDir("build-deck-summary-figures-");
  const { brief, runs } = fixtureCollection(dir);
  const html = summaryDeckOf(dir, brief, runs);
  const figures = figuresIn(html);

  assert.equal(html.includes("http://"), false);
  assert.equal(html.includes("https://"), false);
  assert.equal(/<img[^>]+src="(?!data:)/.test(html), false, "the summary deck renders no image at all");
  assert.match(html, /<style>/);
  assert.match(html, /<script>/);

  // Every figure's text is the value the path names, read from the fixtures
  // rather than from the renderer's own bookkeeping.
  assert.equal(figures.get("runs.count"), "4");
  assert.equal(figures.get("runs.latest.run"), "20261002T110000Z-JRNY-002-add-trip");
  assert.equal(figures.get("runs.latest.commit"), "abc1234");
  assert.equal(figures.get("scenarios.count"), "3");
  assert.equal(figures.get("features[0].id"), "FEAT-001");
  assert.equal(figures.get("features[3].id"), "FEAT-004");
  assert.equal(figures.get("runs[0].run"), "20261001T100000Z-JRNY-001-import");
  assert.equal(figures.get("runs[0].scenario"), "JRNY-001/import");
  assert.equal(figures.get("runs[3].status"), "harness-error");
  assert.equal(figures.get("harnessErrors[0].run"), "20261002T110000Z-JRNY-002-add-trip");

  // The summary's own paths, plus `result.commit` from the shared limits slide.
  const allowed = /^(runs|scenarios|features|counts|harnessErrors|result|rating)\b/;
  for (const source of figures.keys()) {
    assert.match(source, allowed, `unexpected data-source path "${source}"`);
  }
  // A matrix cell is a figure too: its text is the state the cell carries.
  for (const [source, text] of cellsIn(html)) {
    assert.equal(text.length > 0, true, `${source} carries no text`);
  }
});

test("an empty runs directory reads as a state, not an empty panel", () => {
  const dir = tempDir("build-deck-summary-empty-");
  const brief = fixtureBrief(dir);
  const runs = join(dir, "runs");
  mkdirSync(runs, { recursive: true });
  const html = summaryDeckOf(dir, brief, runs);

  assert.match(html, /No runs recorded\./);
  const figures = figuresIn(html);
  assert.equal(figures.get("runs.count"), "0");
  assert.equal(figures.get("counts.journeysExplored"), "0");
  assert.equal(cellsIn(html).get("2/JRNY-003"), "registered, not yet explored");
  assert.deepEqual(
    [...html.matchAll(/<section class="slide" id="(s\d)"/g)].map((match) => match[1]),
    ["s1", "s2", "s3", "s4", "s5", "s6"],
  );
});

test("the summary limits slide carries the same statements and names a slide it has", () => {
  const dir = tempDir("build-deck-summary-limits-");
  const { brief, runs } = fixtureCollection(dir);
  const html = summaryDeckOf(dir, brief, runs);

  for (const statement of [
    "instructed not to read the code",
    "nine stops and two-stop trips",
    "1,000 weeks",
    "/map/tiles/",
    "real jar, not a stub",
    "Per-journey ratings slide lists",
    "The reviewer is the same model as the tester",
    "Reviewer judgments are not user research",
    "The app commit under test",
  ]) {
    assert.ok(html.includes(statement), `summary limits slide is missing: ${statement}`);
  }
  // The count inside that sentence is a figure, so it is compared as one.
  assert.equal(figuresIn(html).get("runs.count"), "4");
  assert.match(html, /explorations across 3 scenarios, each with its status and rating/);
  assert.equal(/Explorations slide lists/.test(html), false, "the summary has no Explorations slide to name");
  for (const banned of [/\bblind\b/i, /\beasy\b/i, /\bworks\b/i, /the app passed/i]) {
    assert.equal(banned.test(html), false, `banned deck wording: ${banned}`);
  }
});

test("a brief whose FEAT row disagrees with its header is rejected", () => {
  const dir = tempDir("build-deck-summary-malformed-");
  const { brief, runs } = fixtureCollection(dir);
  const rows = readFileSync(brief, "utf8").split("\n");
  writeFileSync(brief, `${rows.map((line) => (line.startsWith("| FEAT-002") ? "| FEAT-002 | Edit a trip | operator |" : line)).join("\n")}`);

  const result = runCli(["--summary", "--brief", brief, "--runs", runs, "--out", join(dir, "summary.html")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /brief: FEAT-002 row has 3 cells, the header has 6/);
  assert.equal(existsSync(join(dir, "summary.html")), false, "a rejected brief writes no deck");
});

test("a brief with no Journeys column is rejected", () => {
  const dir = tempDir("build-deck-summary-no-journeys-");
  const { brief, runs } = fixtureCollection(dir);
  writeFileSync(
    brief,
    readFileSync(brief, "utf8").replaceAll("Journeys", "Jobs"),
  );

  const result = runCli(["--summary", "--brief", brief, "--runs", runs, "--out", join(dir, "summary.html")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /brief: no table with a Journeys column/);
});

test("a run file with an unknown key fails the summary build and names the file", () => {
  const dir = tempDir("build-deck-summary-strict-");
  const { brief, runs } = fixtureCollection(dir);
  editJson(join(runs, "20261001T100000Z-JRNY-001-import"), "result.json", (result) => ({ ...result, rating: "Direct" }));

  const result = runCli(["--summary", "--brief", brief, "--runs", runs, "--out", join(dir, "summary.html")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /result\.json: unknown key "rating"/);
  assert.equal(existsSync(join(dir, "summary.html")), false);
});

