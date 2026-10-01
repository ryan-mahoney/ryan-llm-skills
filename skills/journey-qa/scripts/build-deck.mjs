#!/usr/bin/env node
// Loads and strictly validates stored runs, then builds the partner-facing decks
// described in references/deck.md. The formats come from references/harness-contract.md
// (C-6, C-9, C-11) and every band and rating word comes from ./rating.mjs, so this file
// states no threshold of its own.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { rate, stepMinimum } from "./rating.mjs";

const RUN_FILES = ["session.json", "result.json", "review.json", "steps.jsonl", "brief.md"];

// C-6 result.json.
const RESULT_KEYS = [
  "run", "scenario", "status", "check", "claim", "reason", "eyes", "referenceActions",
  "proxies", "stubExclusions", "commit", "dirty", "startedAt", "finishedAt",
];
const CHECK_KEYS = ["id", "pass", "observations"];
const PROXY_KEYS = [
  "actions", "observations", "scrolls", "wrongTries", "rejected", "backtracks",
  "errorsSeen", "endedInError", "actionsToEntryRoute", "elapsedSeconds",
];
const ERRORS_SEEN_KEYS = ["banners", "httpErrors", "consoleErrors", "failedActions", "total"];

// C-9 review.json. A heuristic may be absent, but nothing outside H1..H10 is a heuristic.
const REVIEW_KEYS = ["run", "eyes", "steps", "screens", "journey", "findings"];
const REVIEW_STEP_KEYS = ["n", "q1", "q2", "q3", "q4", "captures", "note"];
const SCREEN_KEYS = ["route", "screen", "heuristics", "states", "verify"];
const HEURISTIC_KEYS = ["score", "evidence", "capture"];
const HEURISTIC_IDS = Array.from({ length: 10 }, (_, index) => `H${index + 1}`);
const STATES_KEYS = ["seen", "notExercised"];
const JOURNEY_KEYS = ["attribution", "decidingStep"];
const FINDING_KEYS = ["id", "severity", "kind", "step", "capture", "statement", "consequence"];

/**
 * Every key of `object` is required and nothing else is allowed, so a file the
 * harness or the reviewer grew a key in is a failure rather than a silent
 * omission. `where` names the file and, for nested objects, the key path.
 */
export function assertKeys(object, required, optional, where) {
  if (object === null || typeof object !== "object" || Array.isArray(object)) {
    throw new Error(`${where}: not an object`);
  }
  const keys = Object.keys(object);
  for (const key of required) {
    if (!keys.includes(key)) throw new Error(`${where}: missing key "${key}"`);
  }
  for (const key of keys) {
    if (required.includes(key) || (optional ?? []).includes(key)) continue;
    throw new Error(`${where}: unknown key "${key}"`);
  }
  return object;
}

/** Validate a parsed result.json against C-6. */
export function validateResult(result, where = "result.json") {
  assertKeys(result, RESULT_KEYS, [], where);
  assertKeys(result.check, CHECK_KEYS, [], `${where} check`);
  assertKeys(result.proxies, PROXY_KEYS, [], `${where} proxies`);
  assertKeys(result.proxies.errorsSeen, ERRORS_SEEN_KEYS, [], `${where} proxies errorsSeen`);
  return result;
}

/** Validate a parsed review.json against C-9. */
export function validateReview(review, where = "review.json") {
  assertKeys(review, REVIEW_KEYS, [], where);
  for (const step of review.steps) {
    assertKeys(step, REVIEW_STEP_KEYS, [], `${where} steps`);
  }
  for (const screen of review.screens) {
    assertKeys(screen, SCREEN_KEYS, [], `${where} screens`);
    assertKeys(screen.heuristics, [], HEURISTIC_IDS, `${where} screens heuristics`);
    for (const id of Object.keys(screen.heuristics)) {
      assertKeys(screen.heuristics[id], HEURISTIC_KEYS, [], `${where} screens heuristics ${id}`);
    }
    assertKeys(screen.states, STATES_KEYS, [], `${where} screens states`);
  }
  assertKeys(review.journey, JOURNEY_KEYS, [], `${where} journey`);
  for (const finding of review.findings) {
    assertKeys(finding, FINDING_KEYS, [], `${where} findings`);
  }
  return review;
}

const readJson = (path, where) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${where}: missing file ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${where}: not valid JSON (${error.message})`);
  }
};

const readText = (path, where) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`${where}: missing file ${path}`);
  }
};

/** One JSONL record per executed step (C-5), in execution order. */
function readSteps(path, where) {
  return readText(path, where)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${where}: line ${index + 1} is not valid JSON (${error.message})`);
      }
    });
}

/**
 * Load one run directory: the five run files of C-3 to C-6, with result.json and
 * review.json read strictly. A missing file and a malformed key are both errors
 * that name the file and the key.
 */
export function loadRun(runDir, { reviewPath } = {}) {
  const dir = resolve(runDir);
  const session = readJson(join(dir, "session.json"), "session.json");
  const result = validateResult(readJson(join(dir, "result.json"), "result.json"));
  const review = validateReview(
    readJson(reviewPath ?? join(dir, "review.json"), reviewPath ? basenameOf(reviewPath) : "review.json"),
  );
  const steps = readSteps(join(dir, "steps.jsonl"), "steps.jsonl");
  const brief = readText(join(dir, "brief.md"), "brief.md");
  return { dir, session, result, review, steps, brief };
}

const basenameOf = (path) => path.split("/").pop();

/**
 * The run's rating from rating.mjs, the module that owns the thresholds. A
 * second review only changes the repeatability the limits slide reports, never
 * the rating.
 */
export function computeRating(run, referenceActions = run.result.referenceActions) {
  return rate({
    status: run.result.status,
    checkPass: run.result.check.pass,
    proxies: run.result.proxies,
    referenceActions,
    stepMinimum: stepMinimum(run.review.steps),
    attribution: run.review.journey.attribution,
  });
}

/**
 * Every sibling run of the same scenario, this one included, sorted by run
 * directory name. A sibling with no result.json reads "no result recorded" and
 * is never given a rating word.
 */
export function siblingRuns(runDir) {
  const dir = resolve(runDir);
  const own = readJson(join(dir, "session.json"), "session.json");
  const parent = dirname(dir);
  const siblings = readdirSync(parent)
    .map((name) => join(parent, name))
    .filter((path) => existsSync(path) && statSync(path).isDirectory())
    .filter((path) => existsSync(join(path, "session.json")))
    .map((path) => {
      const session = readJson(join(path, "session.json"), "session.json");
      if (session.scenario !== own.scenario) return null;
      const resultPath = join(path, "result.json");
      if (!existsSync(resultPath)) {
        return { name: basenameOf(path), dir: path, run: session.run, scenario: session.scenario, status: "no result recorded", claim: null, rating: null };
      }
      const result = readJson(resultPath, "result.json");
      const reviewPath = join(path, "review.json");
      const review = existsSync(reviewPath) ? readJson(reviewPath, "review.json") : null;
      return {
        name: basenameOf(path),
        dir: path,
        run: session.run,
        scenario: session.scenario,
        status: result.status,
        claim: result.claim ?? null,
        rating: review ? computeRating({ result, review }).rating : null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return siblings;
}

/** Flags of C-11. `--summary` is the only switch; the rest carry a value. */
const VALUE_FLAGS = ["--run", "--out", "--second-review", "--brief", "--runs"];
const SWITCH_FLAGS = ["--summary"];

/** Parse the deck CLI of C-11; an unknown or valueless flag is an error. */
export function parseArgs(argv) {
  const args = { summary: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (SWITCH_FLAGS.includes(flag)) {
      args[flag.slice(2)] = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(flag)) throw new Error(`unknown flag "${flag}"`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  return args;
}

const requireFlag = (args, name) => {
  if (!args[name]) throw new Error(`--${name} is required`);
  return args[name];
};

// Added by the render steps; the loader is what this file establishes.
function renderJourneyDeck() {
  throw new Error("renderJourneyDeck: not implemented");
}

function renderSummaryDeck() {
  throw new Error("renderSummaryDeck: not implemented");
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const out = requireFlag(args, "out");

  if (args.summary) {
    const brief = requireFlag(args, "brief");
    const runs = requireFlag(args, "runs");
    if (!existsSync(brief)) throw new Error(`brief.md: missing file ${brief}`);
    if (!existsSync(runs) || !statSync(runs).isDirectory()) throw new Error(`runs: missing directory ${runs}`);
    renderSummaryDeck({ brief, runs, out });
    return;
  }

  const runDir = requireFlag(args, "run");
  const run = loadRun(runDir, { reviewPath: args["second-review"] });

  // A harness error is not a rating. Say so, write nothing, exit 1.
  if (run.result.status === "harness-error") {
    process.stderr.write(`not rated: ${run.result.reason ?? "harness error"}\n`);
    process.exitCode = 1;
    return;
  }

  const siblings = siblingRuns(runDir);
  const second = args["second-review"] ? validateReview(readJson(args["second-review"], "review.json")) : null;
  renderJourneyDeck({ run, rating: computeRating(run), siblings, second, out });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`build-deck: ${error.message}\n`);
    process.exit(1);
  }
}
