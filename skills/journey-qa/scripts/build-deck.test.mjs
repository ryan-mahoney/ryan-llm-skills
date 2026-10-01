import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRun, siblingRuns } from "./build-deck.mjs";
import { fixtureRun } from "./test-fixtures.mjs";

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

