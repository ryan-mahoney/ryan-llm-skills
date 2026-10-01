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
