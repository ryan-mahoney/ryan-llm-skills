#!/usr/bin/env node
// Loads and strictly validates stored runs, then builds the partner-facing decks
// described in references/deck.md. The formats come from references/harness-contract.md
// (C-6, C-9, C-11) and every band and rating word comes from ./rating.mjs, so this file
// states no threshold of its own.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { agreement, rate, stepMinimum } from "./rating.mjs";

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
export function loadRun(runDir) {
  const dir = resolve(runDir);
  const session = readJson(join(dir, "session.json"), "session.json");
  const result = validateResult(readJson(join(dir, "result.json"), "result.json"));
  const review = validateReview(readJson(join(dir, "review.json"), "review.json"));
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

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const attr = escapeHtml;

// The severity vocabulary of C-9 and review.json; deck.md reuses the
// visualize-journey scale so the same word means the same thing in both places.
const SEVERITIES = ["critical", "high", "medium", "low", "info"];

// One CSS class per rating word, so colour marks the rating and the text beside
// it names it (deck.md interaction rules).
const RATING_CLASSES = {
  Direct: "direct",
  Detours: "detours",
  Lost: "lost",
  "Not completed": "not-completed",
  "Not rated": "not-rated",
};

const ratingClass = (word) => RATING_CLASSES[word] ?? "not-rated";

/** A number or boolean from a run file, printed exactly as it is stored. */
const figure = (source, value) => `<span class="figure" data-source="${attr(source)}">${escapeHtml(value)}</span>`;

const CONTENT_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/**
 * A capture as a `data:` URI, or null when the file is absent. A step whose
 * capture has gone missing renders the "Not captured" placeholder; it never
 * renders as nothing and never as a broken image.
 */
function captureUri(runDir, reference) {
  if (!reference) return null;
  const path = resolve(runDir, reference);
  const type = CONTENT_TYPES[path.slice(path.lastIndexOf(".")).toLowerCase()];
  if (!type || !existsSync(path) || !statSync(path).isFile()) return null;
  return `data:${type};base64,${readFileSync(path).toString("base64")}`;
}

/** A capture or its labelled placeholder; `alt` names the step it belongs to. */
function renderCapture(runDir, reference, alt) {
  const uri = captureUri(runDir, reference);
  if (uri) return `<img class="capture" src="${uri}" alt="${attr(alt)}" loading="lazy">`;
  return `<p class="capture capture--missing" role="note"><strong>Not captured</strong><span>${escapeHtml(reference ?? "no capture recorded for this step")}</span></p>`;
}

/**
 * The `## Heading` sections of a brief. The deck shows the tester-visible ones
 * only (R5): persona, goal, start path and files. Account, Seed, Success check,
 * Reference actions and Entry route are harness-only and never reach a slide.
 */
export function briefSections(markdown) {
  const sections = new Map();
  let heading = null;
  for (const line of markdown.split("\n")) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      heading = match[1];
      sections.set(heading, []);
      continue;
    }
    if (heading) sections.get(heading).push(line);
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join("\n").trim()]));
}

// The headings a brief may carry for each tester-visible section (R5). A brief
// is written in the tester's own words, so the harness spells these
// "Who you are" and "What you are trying to do" where the deck prints
// "Persona" and "Goal"; the first spelling a brief carries wins. Harness-only
// sections are deliberately absent, so they have no deck label to look up.
const BRIEF_SECTIONS = {
  Persona: ["Persona", "Who you are"],
  Goal: ["Goal", "What you are trying to do"],
  "Start path": ["Start path", "Where you start"],
  Files: ["Files", "Files you can upload"],
};

/** The text of a brief section, under any of the headings it may carry. */
export function briefText(sections, name) {
  for (const heading of BRIEF_SECTIONS[name] ?? [name]) {
    const text = sections.get(heading);
    if (text !== undefined && text !== "") return text;
  }
  return "";
}

/** The bullet names of a brief section, in the order the tester saw them. */
const briefItems = (sections, name) =>
  briefText(sections, name)
    .split("\n")
    .map((line) => /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim() ?? null)
    .filter(Boolean);

/**
 * The keys that locate an element on a screen. A target object (C-5) carries
 * one of them plus whatever the action needs besides the location, so the
 * locator is the first of these the target carries.
 */
const TARGET_LOCATORS = ["name", "text", "label", "path", "key"];

/** A target value as one quoted phrase, with `"` inside the value neutralised. */
const quoted = (value) => `"${String(value).replaceAll('"', "'")}"`;

/** A non-string target value, printed in the compact `key=value` form. */
const compact = (key, value) =>
  typeof value === "string" ? `${key} ${quoted(value)}` : `${key}=${String(value)}`;

/**
 * A step's action target in the words a reader would say it, built from the
 * target's own fields: `button "Import feed"`, `text "Import feed"`,
 * `label "Version name"`. A role is the kind of control and reads bare, the
 * locator that follows it is quoted, and any remaining field the action needed
 * (a file, a filled value, an option) reads as its own `key "value"` phrase. A
 * target that locates nothing the vocabulary names falls back to compact
 * `key=value` pairs, so an unfamiliar shape is still readable rather than an
 * object literal. A target already stored as a string is that string.
 */
export function describeTarget(target) {
  if (target === null || target === undefined || target === "") return null;
  if (typeof target !== "object" || Array.isArray(target)) return String(target);
  const keys = Object.keys(target);
  if (keys.length === 0) return null;

  const role = target.role === undefined || target.role === null ? null : String(target.role);
  const locator = TARGET_LOCATORS.find((key) => target[key] !== undefined && target[key] !== null);
  // A shape that names no control is not something a reader can be shown as a
  // phrase, so every field prints compactly rather than one field being
  // promoted to a locator the shape does not have.
  if (role === null && locator === undefined) {
    return keys
      .filter((key) => target[key] !== null && target[key] !== undefined)
      .map((key) => `${key}=${String(target[key])}`)
      .join(" ");
  }

  const used = new Set();
  const parts = [];
  if (role !== null) {
    parts.push(role);
    used.add("role");
  }
  // A role already says which control it is, so the locator that follows it
  // reads as that control's name: `button "Import feed"`, not
  // `button name "Import feed"`. Without a role it names itself.
  if (locator !== undefined) {
    if (role === null) parts.push(locator);
    parts.push(quoted(target[locator]));
    used.add(locator);
  }
  for (const key of keys) {
    if (used.has(key) || target[key] === null || target[key] === undefined) continue;
    parts.push(compact(key, target[key]));
  }
  return parts.join(" ");
}

/**
 * The check's own `observations`, which a check records as one string or as a
 * list of sentences. Either way the deck shows every sentence it carries and
 * never joins them into a single sentence the check did not write.
 */
export function observationsText(observations) {
  if (Array.isArray(observations)) return observations.join(" ");
  return observations ?? "none recorded";
}

/** R18: only a product attribution names the product; the others are limits. */
export function attributionLine(attribution) {
  return attribution === "product"
    ? "Not completed: product"
    : "Not completed in this run (tester or harness limit)";
}

// The proxies `rate()` bands, in the order it computes them. The five
// `errorsSeen` counts share one metric, so only its total carries the label.
const PROXY_ROWS = [
  ["actions", (proxies) => proxies.actions, "efficiency"],
  ["observations", (proxies) => proxies.observations, null],
  ["scrolls", (proxies) => proxies.scrolls, null],
  ["wrongTries", (proxies) => proxies.wrongTries, null],
  ["rejected", (proxies) => proxies.rejected, null],
  ["backtracks", (proxies) => proxies.backtracks, "backtracks"],
  ["errorsSeen.banners", (proxies) => proxies.errorsSeen.banners, null],
  ["errorsSeen.httpErrors", (proxies) => proxies.errorsSeen.httpErrors, null],
  ["errorsSeen.consoleErrors", (proxies) => proxies.errorsSeen.consoleErrors, null],
  ["errorsSeen.failedActions", (proxies) => proxies.errorsSeen.failedActions, null],
  ["errorsSeen.total", (proxies) => proxies.errorsSeen.total, "errors"],
  ["endedInError", (proxies) => proxies.endedInError, null],
  ["actionsToEntryRoute", (proxies) => proxies.actionsToEntryRoute, "entryActions"],
  ["elapsedSeconds", (proxies) => proxies.elapsedSeconds, null],
];

/**
 * The six statements and two additional lines deck.md fixes for both decks.
 * Each `text` is trusted markup: every value interpolated into one is escaped
 * by `figure()` or by `escapeHtml` at the point of use, and the static wording
 * is this file's own. `explorations` names the slide that lists the runs of a
 * deck, its count and the scope that count covers, so each deck names a slide it
 * actually has.
 */
export function limitsLines({ second, agreementResult, explorations, result, run }) {
  const exclusions = (result.stubExclusions ?? []).map((prefix) => `<code>${escapeHtml(prefix)}</code>`).join(", ");
  const lines = [
    {
      key: "instructed",
      text: "The tester was instructed not to read the code. The tester received only the brief and a browser; nothing in the harness can detect a file read, so this is the honest form of the claim.",
    },
    {
      key: "data",
      text: "The data is a small demo feed: nine stops and two-stop trips, with calendars advanced by 1,000 weeks so service dates are in the future. No conclusion about real data volume or real calendar density follows from a run over this feed.",
    },
    {
      key: "stubbed",
      text: `Externals other than the validator are stubbed: geocoding, street routing, boundaries, basemap tiles and buildings, and the scripted language-model stand-in. Excluded from the error count: ${exclusions || "none"}. The validator is the real jar, not a stub.`,
    },
    {
      key: "explorations",
      text: `The ${escapeHtml(explorations.label)} lists ${figure(explorations.source, explorations.count)} ${explorations.count === 1 ? "exploration" : "explorations"} ${escapeHtml(explorations.scope)}, each with its status and rating.`,
    },
    {
      key: "reviewer",
      text: "The reviewer is the same model as the tester. The run files record the eyes mode, not a model name, so this deck cannot name a different reviewer when one was used.",
    },
  ];
  if (second && agreementResult) {
    lines.push({
      key: "repeatability",
      text: `Repeatability, not validity: the two reviews agree exactly on ${figure("agreement.exact", agreementResult.exact)} of ${figure("agreement.n", agreementResult.n)} compared questions and within one on ${figure("agreement.withinOne", agreementResult.withinOne)} of ${figure("agreement.n", agreementResult.n)}. One review is not a second data point.`,
    });
  }
  lines.push({
    key: "judgments",
    text: "Reviewer judgments are not user research. A simulated tester walking a real stack says something about whether a path is legible to one careful agent reading a written brief. It does not say what users do, want or tolerate.",
  });
  lines.push({
    key: "commit",
    text: `The app commit under test is ${figure("result.commit", result.commit)} and the working tree was ${result.dirty ? "dirty" : "clean"} at the start of run ${escapeHtml(run)}.`,
  });
  return lines;
}

// The functionalist posture of render-journey-map.mjs: white ground, one
// grotesque sans, thin rules, and colour only beside a text label.
const DECK_STYLES = `
  :root{color-scheme:light;--ink:#14171c;--muted:#5b6472;--line:#d7dce2;--soft:#f5f6f7;--direct:#146c43;--detours:#7a5300;--lost:#8a1c1c;--not-completed:#8a1c1c;--not-rated:#4b5563;--critical:#7f1d1d;--high:#a8320f;--medium:#7a5300;--low:#175cd3;--info:#4b5563;font-family:Inter,"Helvetica Neue",Helvetica,Arial,sans-serif}
  *{box-sizing:border-box}body{margin:0;background:var(--soft);color:var(--ink);line-height:1.45;font-family:inherit}
  .deck{position:relative}.slide{background:#fff;min-height:100vh;padding:34px 44px 76px;border-top:4px solid var(--ink)}
  .slide[hidden]{display:none!important}
  .kicker{margin:0 0 6px;color:var(--muted);font-size:.72rem;font-weight:750;letter-spacing:.08em;text-transform:uppercase}
  .slide h1{margin:0;font-size:2.3rem;line-height:1.08;letter-spacing:-.035em;max-width:24ch}
  .slide h1:focus{outline:none}
  .slide h1:focus-visible{outline:3px solid #175cd3;outline-offset:4px}
  .slide h2{margin:0 0 4px;font-size:1rem;letter-spacing:-.015em}
  .lede{max-width:74ch;margin:6px 0 0;color:var(--muted);font-size:.9rem}
  .rule{height:1px;margin:14px 0;background:var(--line)}
  .grid{display:grid;gap:0 26px;align-items:start}
  .grid--2{grid-template-columns:1fr 1fr}
  .matrix td,.matrix th{font-size:.8rem}
  .matrix .cell{white-space:normal}
  .state{display:block;padding:3px 6px;border:1px solid var(--line);font-size:.76rem}
  .state--explored{border-color:var(--direct);color:var(--direct)}
  .state--pending{border-color:var(--detours);color:var(--detours)}
  .state--absent{color:var(--muted);border-style:dashed}
  .counts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px;margin-top:18px}
  .count{border-top:3px solid var(--ink);padding:12px 0 0}
  .count .value{display:block;font-size:3rem;font-weight:750;line-height:1;font-variant-numeric:tabular-nums}
  .count .label{display:block;margin-top:8px;color:var(--muted);font-size:.85rem}
  .counts+.lede{margin-top:30px}
  .stack>*+*{margin-top:14px}
  .strip{overflow:auto;max-height:calc(100vh - 240px)}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}
  th{color:var(--muted);font-size:.7rem;font-weight:750;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
  tr:last-child td{border-bottom:0}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .figure{font-variant-numeric:tabular-nums}
  .muted{color:var(--muted)}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.82em}
  .figure-row{display:grid;grid-template-columns:minmax(140px,1fr) minmax(60px,auto) minmax(110px,.9fr);gap:4px 14px;padding:3px 0;border-bottom:1px solid var(--line);font-size:.8rem}
  .figure-row .label{color:var(--muted);font-size:.76rem}
  .figure-row .band{color:var(--muted);font-size:.74rem}
  .figure-row .value{text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
  .rating{display:inline-flex;align-items:center;gap:8px;padding:5px 10px;border:1px solid currentColor;font-weight:750;font-size:1.05rem}
  .rating::before{content:"";width:11px;height:11px;background:currentColor;flex:none}
  .rating--direct{color:var(--direct)}.rating--detours{color:var(--detours)}
  .rating--lost,.rating--not-completed{color:var(--not-completed)}.rating--not-rated{color:var(--not-rated)}
  .result-line{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;margin-top:16px}
  .result-line .attribution{font-size:1rem;color:var(--muted)}
  .severity{display:inline-flex;align-items:center;gap:6px;padding:2px 7px;border:1px solid currentColor;font-size:.7rem;font-weight:750;text-transform:uppercase;letter-spacing:.05em}
  .severity::before{content:"";width:9px;height:9px;background:currentColor;flex:none}
  .severity--critical{color:var(--critical)}.severity--high{color:var(--high)}
  .severity--medium{color:var(--medium)}.severity--low{color:var(--low)}.severity--info{color:var(--info)}
  .filmstrip{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
  .step-card{border:1px solid var(--line);border-top:3px solid var(--ink);padding:11px 12px;min-width:0}
  .step-card--rejected{border-style:dashed;border-top-color:var(--muted)}
  .step-card--error{border-top-color:var(--high)}
  .step-head{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline;font-size:.72rem;color:var(--muted)}
  .step-head .n{font-weight:750;color:var(--ink)}
  .step-card .capture{display:block;width:100%;height:132px;object-fit:contain;object-position:top;margin:9px 0;background:var(--soft);border:1px solid var(--line)}
  .capture--missing{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;margin:9px 0;height:132px;background:var(--soft);border:1px dashed var(--muted);text-align:center;color:var(--muted);font-size:.72rem;padding:6px}
  .capture--missing strong{color:var(--ink);font-size:.86rem}
  .step-action{font-size:.95rem;font-weight:750;overflow-wrap:anywhere}
  .step-field{margin-top:5px;font-size:.78rem;overflow-wrap:anywhere}
  .step-field b{color:var(--muted);font-weight:700}
  .flag{display:inline-block;margin-top:7px;padding:2px 6px;border:1px solid var(--high);color:var(--high);font-size:.68rem;font-weight:750;text-transform:uppercase;letter-spacing:.05em}
  .empty{padding:16px;border:1px dashed var(--muted);color:var(--muted);font-size:.9rem}
  .limits{counter-reset:limit;list-style:none;margin:0;padding:0;max-width:96ch}
  .limits li{counter-increment:limit;position:relative;padding:9px 0 9px 1.9rem;border-bottom:1px solid var(--line);font-size:.88rem}
  .limits li::before{content:counter(limit);position:absolute;left:0;top:11px;color:var(--muted);font-variant-numeric:tabular-nums;font-size:.78rem}
  .limits code{padding:1px 4px;background:#eef0f2;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em}
  .kv{display:grid;grid-template-columns:minmax(160px,.5fr) 1fr;gap:4px 16px;font-size:.86rem}
  .kv dt{color:var(--muted);font-size:.78rem}.kv dd{margin:0;overflow-wrap:anywhere}
  .deck-nav{position:fixed;left:0;right:0;bottom:0;display:flex;gap:8px;align-items:center;padding:8px 44px;background:#fff;border-top:1px solid var(--line)}
  .deck-nav button{min-height:38px;padding:6px 12px;border:1px solid #8b95a5;background:#fff;font:inherit;font-weight:650;cursor:pointer}
  .deck-nav button:hover{border-color:var(--ink)}
  .deck-nav button:focus-visible{outline:3px solid #175cd3;outline-offset:2px}
  .deck-nav .counter{margin-left:auto;color:var(--muted);font-size:.8rem;font-variant-numeric:tabular-nums}
  @media print{
    body{background:#fff}.deck-nav{display:none}
    .slide{display:block!important;min-height:0;page-break-after:always;break-after:page;padding:18px 22px;border-top:2px solid #000}
    .slide:last-child{page-break-after:auto;break-after:auto}
    .strip{overflow:visible;max-height:none}.capture{height:150px}
  }
`;

const DECK_SCRIPT = `
(() => {
  const slides = Array.from(document.querySelectorAll(".slide"));
  const counter = document.querySelector("[data-slide-counter]");
  let current = 0;
  const show = (index) => {
    const next = Math.max(0, Math.min(slides.length - 1, index));
    slides.forEach((slide, position) => { slide.hidden = position !== next; });
    current = next;
    if (counter) counter.textContent = (next + 1) + " / " + slides.length;
    if (window.history && window.history.replaceState) window.history.replaceState(null, "", "#s" + (next + 1));
    slides[next].focus();
  };
  const fromHash = () => {
    const match = /^#s(\\d+)$/.exec(window.location.hash || "");
    return match ? Number(match[1]) - 1 : 0;
  };
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const keys = {
      ArrowRight: current + 1, ArrowDown: current + 1, PageDown: current + 1,
      ArrowLeft: current - 1, ArrowUp: current - 1, PageUp: current - 1,
      Home: 0, End: slides.length - 1,
    };
    if (!(event.key in keys)) return;
    event.preventDefault();
    show(keys[event.key]);
  });
  document.querySelector("[data-slide-prev]").addEventListener("click", () => show(current - 1));
  document.querySelector("[data-slide-next]").addEventListener("click", () => show(current + 1));
  window.addEventListener("hashchange", () => show(fromHash()));
  show(fromHash());
})();
`;

const slide = (number, total, kicker, heading, body) => `
  <section class="slide" id="s${number}" aria-label="Slide ${number} of ${total}: ${attr(heading)}">
    <p class="kicker">${escapeHtml(kicker)}</p>
    <h1 tabindex="-1">${escapeHtml(heading)}</h1>
    <div class="rule"></div>
    ${body}
  </section>`;

const bandCell = (bandName, bandValue) =>
  bandValue === null
    ? `<span class="band">not banded</span>`
    : `<span class="band">band: ${figure(`rating.bands.${bandName}`, bandValue)}</span>`;

/**
 * Write the URL scheme of any string that reaches the page as a character
 * entity, so the file contains no `http://` or `https://` (AC-24) while a
 * brief's start path or a finding's evidence URL still renders as written.
 * Every value interpolated above is already escaped, so the entity is not
 * double-escaped and the visible text is unchanged.
 */
const schemeAsEntities = (html) => html.replaceAll(/(https?):\/\//g, "$1&#58;//");

/**
 * The nine journey-deck slides of references/deck.md, handed to the shared
 * `writeDeck` shell. Every displayed figure is an element whose text is the
 * value at its `data-source` path; the deck computes nothing, and every rating
 * word comes from ./rating.mjs.
 */
export function renderJourneyDeck({ run, rating, siblings, second, out }) {
  const { result, review, steps, brief } = run;
  const sections = briefSections(brief);
  const agreementResult = second ? agreement(run.review, second) : null;
  const recorded = steps.filter((step) => step.kind === "step");
  const captured = recorded.filter((step) => captureUri(run.dir, step.capture)).length;
  const completed = siblings.filter((sibling) => sibling.status === "completed").length;
  // Lowest-scoring steps first, with each step's own index in review.json kept
  // so a `data-source` path still names the record it came from.
  const reviewSteps = review.steps
    .map((step, index) => ({ step, index }))
    .sort((left, right) => scoredMin(left.step) - scoredMin(right.step));
  const scored = review.steps.filter((step) =>
    ["q1", "q2", "q3", "q4"].some((question) => step[question] !== null && step[question] !== undefined),
  ).length;

  const goal = briefText(sections, "Goal");

  const title = slide(
    1,
    9,
    `Run ${result.run}`,
    result.scenario,
    `<p class="result-line">
      <span class="rating rating--${ratingClass(rating.rating)}" data-source="rating.rating">${escapeHtml(rating.rating)}</span>
      ${rating.rating === "Not completed" ? `<span class="attribution">${escapeHtml(attributionLine(rating.attribution))} — decided at step ${figure("review.journey.decidingStep", review.journey.decidingStep)}</span>` : ""}
    </p>
    <p class="lede"><b>What the tester was trying to do:</b> ${goal ? escapeHtml(goal) : `the brief recorded no goal for this scenario, so this slide states none rather than inventing one.`}</p>
    <div class="rule"></div>
    <dl class="kv">
      <dt>Run</dt><dd>${figure("result.run", result.run)}</dd>
      <dt>Scenario</dt><dd>${figure("result.scenario", result.scenario)}</dd>
      <dt>Status</dt><dd>${figure("result.status", result.status)}</dd>
      <dt>Check</dt><dd>${figure("result.check.id", result.check.id)} — pass ${figure("result.check.pass", result.check.pass)}</dd>
      <dt>App commit</dt><dd>${figure("result.commit", result.commit)} <span class="mono">(${result.dirty ? "dirty" : "clean"})</span></dd>
      <dt>Reference actions</dt><dd>${figure("result.referenceActions", result.referenceActions)}</dd>
    </dl>`,
  );

  const given = slide(
    2,
    9,
    "What the tester was given",
    "The brief the tester read",
    `<div class="grid grid--2">
      <section>
        <h2>Persona</h2>
        <p>${escapeHtml(briefText(sections, "Persona"))}</p>
        <h2>Start path</h2>
        <p class="mono">${escapeHtml(briefText(sections, "Start path"))}</p>
      </section>
      <section>
        <h2>Goal</h2>
        <p>${escapeHtml(briefText(sections, "Goal"))}</p>
        <h2>Files the tester could upload</h2>
        <ul>${briefItems(sections, "Files").map((name) => `<li class="mono">${escapeHtml(name)}</li>`).join("") || `<li class="empty">No file was offered for this scenario.</li>`}</ul>
      </section>
    </div>`,
  );

  const filmstrip = slide(
    3,
    9,
    "Step filmstrip",
    `Every executed step, in steps.jsonl order (${recorded.length} steps)`,
    `<div class="strip"><div class="filmstrip">${steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.kind === "step")
      .map(({ step, index }) => {
        const rejected = typeof step.rejected === "string" && step.rejected !== "";
        const target = describeTarget(step.target);
        return `<article class="step-card${rejected ? " step-card--rejected" : step.ok === false ? " step-card--error" : ""}">
          <p class="step-head"><span class="n">Step ${escapeHtml(step.n)}</span><span>${escapeHtml(step.action)}</span><span>${rejected ? "not executed" : step.ok ? "ok" : "not ok"}</span></p>
          ${renderCapture(run.dir, step.capture, `Capture of step ${step.n}`)}
          <p class="step-action">${escapeHtml(step.action)}${target === null ? "" : ` ${escapeHtml(target)}`}</p>
          <p class="step-field"><b>Intent</b> ${step.intent ? figure(`steps[${index}].intent`, step.intent) : `<span class="muted">none stated</span>`}</p>
          <p class="step-field"><b>Expectation</b> ${step.expected ? figure(`steps[${index}].expected`, step.expected) : `<span class="muted">none stated</span>`}</p>
          ${rejected ? `<p class="flag">rejected: ${escapeHtml(step.rejected)}</p>` : ""}
          ${step.ok === false && step.error ? `<p class="flag">error: ${escapeHtml(step.error)}</p>` : ""}
        </article>`;
      })
      .join("") || `<p class="empty">No step was recorded in this run.</p>`}</div></div>`,
  );

  const proxies = slide(
    4,
    9,
    "Measured proxies",
    "The raw numbers first, then their bands",
    `<div class="grid grid--2">
      <div>
        ${PROXY_ROWS.map(
          ([name, read, band]) => `<p class="figure-row">
            <span class="label">${escapeHtml(name)}</span>
            <span class="value">${figure(`proxies.${name}`, read(result.proxies))}</span>
            ${bandCell(band, band ? rating.bands[band] : null)}
          </p>`,
        ).join("")}
      </div>
      <div class="stack">
        <section>
          <h2>Path efficiency</h2>
          <p class="figure-row"><span class="label">Reference actions</span><span class="value">${figure("result.referenceActions", result.referenceActions)}</span>${bandCell("efficiency", rating.bands.efficiency)}</p>
          <p class="figure-row"><span class="label">Actions taken</span><span class="value">${figure("proxies.actions", result.proxies.actions)}</span><span class="band">denominator: the reference trail's executed count</span></p>
        </section>
        <section>
          <h2>How the bands are decided</h2>
          <p class="lede">Every band and rating word on this deck comes from <span class="mono">skills/journey-qa/scripts/rating.mjs</span>, which owns the thresholds. This file states none of them.</p>
        </section>
        <section>
          <h2>Wall-clock time</h2>
          <p class="lede">${figure("proxies.elapsedSeconds", result.proxies.elapsedSeconds)} seconds is reported and never banded.</p>
        </section>
      </div>
    </div>`,
  );

  const scores = slide(
    5,
    9,
    "Reviewer scores — reviewer-assessed",
    `Per-step questions, lowest-scoring steps first (${scored} of ${review.steps.length} steps scored)`,
    `<div class="strip"><table>
      <thead><tr><th class="num">Step</th><th class="num">q1</th><th class="num">q2</th><th class="num">q3</th><th class="num">q4</th><th>Captures</th><th>Note</th></tr></thead>
      <tbody>${reviewSteps
        .map(({ step, index }) => {
          const cell = (question) => {
            const source = `review.steps[${index}].${question}`;
            return step[question] === null || step[question] === undefined
              ? `<td class="num">not scored</td>`
              : `<td class="num">${figure(source, step[question])}</td>`;
          };
          return `<tr><td class="num">${figure(`review.steps[${index}].n`, step.n)}</td>${cell("q1")}${cell("q2")}${cell("q3")}${cell("q4")}<td class="mono">${escapeHtml((step.captures ?? []).join(", ") || "none")}</td><td>${escapeHtml(step.note ?? "")}</td></tr>`;
        })
        .join("") || `<tr><td colspan="7" class="empty">The reviewer scored no steps in this run.</td></tr>`}</tbody>
    </table></div>
    <p class="lede">Heuristic scores appear on this deck only where a finding cites them; they are never averaged or totalled.</p>`,
  );

  const findings = slide(
    6,
    9,
    "Findings",
    `Every finding the reviewer recorded (${review.findings.length})`,
    review.findings.length === 0
      ? `<p class="empty">No findings recorded.</p>`
      : `<table>
          <thead><tr><th>Severity</th><th class="num">Step</th><th>Kind</th><th>Statement</th><th>Consequence</th><th>Capture</th></tr></thead>
          <tbody>${review.findings
            .map((finding, index) => {
              const severity = SEVERITIES.includes(finding.severity) ? finding.severity : "info";
              return `<tr>
                <td><span class="severity severity--${attr(severity)}" data-source="review.findings[${index}].severity">${escapeHtml(severity)}</span></td>
                <td class="num">${finding.step === null ? "—" : figure(`review.findings[${index}].step`, finding.step)}</td>
                <td>${escapeHtml(finding.kind)}</td>
                <td>${escapeHtml(finding.statement)}</td>
                <td>${escapeHtml(finding.consequence)}</td>
                <td class="mono">${escapeHtml(finding.capture ?? "—")}</td>
              </tr>`;
            })
            .join("")}</tbody>
        </table>`,
  );

  const explorations = slide(
    7,
    9,
    "Explorations of this scenario",
    `Completed in ${completed} of ${siblings.length} ${siblings.length === 1 ? "run" : "runs"} of ${result.scenario}`,
    `<table>
      <thead><tr><th>Run</th><th>Status</th><th>Claim</th><th>Rating</th></tr></thead>
      <tbody>${siblings
        .map(
          (sibling, index) => `<tr>
            <td class="mono">${figure(`siblings[${index}].run`, sibling.run)}${sibling.dir === run.dir ? " <span class=\"mono\">(this deck)</span>" : ""}</td>
            <td>${figure(`siblings[${index}].status`, sibling.status)}</td>
            <td>${sibling.claim === null ? "none recorded" : figure(`siblings[${index}].claim`, sibling.claim)}</td>
            <td>${sibling.rating === null
              ? sibling.status === "no result recorded"
                ? "no result recorded"
                : "not rated"
              : `<span class="rating rating--${ratingClass(sibling.rating)}" data-source="siblings[${index}].rating">${escapeHtml(sibling.rating)}</span>`}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table>
    <p class="lede">A run with no recorded result lists with its status and is never given a rating word.</p>`,
  );

  const limits = slide(
    8,
    9,
    "Limits",
    "What this run does not establish",
    `<ol class="limits">${limitsLines({
      second,
      agreementResult,
      explorations: { label: "Explorations slide", source: "siblings.count", count: siblings.length, scope: "of this scenario" },
      result,
      run: result.run,
    })
      .map((line) => `<li>${line.text}</li>`)
      .join("")}</ol>`,
  );

  const evidence = slide(
    9,
    9,
    "Evidence index",
    "The run files behind every number on this deck",
    `<dl class="kv">
      <dt>Run</dt><dd>${figure("result.run", result.run)}</dd>
      <dt>Scenario</dt><dd>${figure("result.scenario", result.scenario)}</dd>
      <dt>App commit</dt><dd>${figure("result.commit", result.commit)} <span class="mono">(${result.dirty ? "dirty" : "clean"})</span></dd>
      <dt>Check</dt><dd>${figure("result.check.id", result.check.id)} — pass ${figure("result.check.pass", result.check.pass)}</dd>
      <dt>Check observations</dt><dd>${escapeHtml(observationsText(result.check.observations))}</dd>
      <dt>Captures present</dt><dd>${figure("captures.count", captured)} of ${recorded.length} recorded steps</dd>
      <dt>Eyes mode, run</dt><dd>${escapeHtml(result.eyes ?? "none recorded")}</dd>
      <dt>Eyes mode, review</dt><dd>${escapeHtml(review.eyes ?? "none recorded")}</dd>
      <dt>Second review</dt><dd>${second ? "supplied; see the repeatability limit" : "not supplied"}</dd>
    </dl>`,
  );

  return writeDeck({
    title: `Journey deck — ${result.scenario} — ${result.run}`,
    slides: [title, given, filmstrip, proxies, scores, findings, explorations, limits, evidence],
    out,
  });
}

/**
 * The shell both decks of references/deck.md share: one self-contained file
 * with inline CSS and script, a `#s<N>` per slide, keyboard navigation, a
 * print stylesheet that shows every slide, and a write that is whole or not at
 * all. The deck computes nothing; the values come from the run files and from
 * ./rating.mjs.
 */
export function writeDeck({ title, slides, out }) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${DECK_STYLES}</style>
</head>
<body>
<main class="deck">
${slides.join("\n")}
</main>
<nav class="deck-nav" aria-label="Slide navigation">
  <button type="button" data-slide-prev>Previous</button>
  <button type="button" data-slide-next>Next</button>
  <span class="counter" data-slide-counter aria-live="polite">1 / ${slides.length}</span>
</nav>
<script>${DECK_SCRIPT}</script>
</body>
</html>
`;

  // A deck is a partner-facing artifact, so it is written whole or not at all.
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const temporary = `${out}.tmp`;
  writeFileSync(temporary, schemeAsEntities(html));
  renameSync(temporary, out);
  return { out, slides: slides.length };
}

/** The lowest non-null question score of a review step, or 0 when unscored. */
function scoredMin(step) {
  const values = ["q1", "q2", "q3", "q4"]
    .map((question) => step[question])
    .filter((value) => value !== null && value !== undefined);
  return values.length === 0 ? 0 : Math.min(...values);
}

// The states a coverage-matrix cell may carry (deck.md slide 3), each of them
// beside its text label rather than shown as colour alone. A journey the
// feature's Journeys column does not name is not one of the three states: the
// dash says the cell does not apply, and the slide says so.
const MATRIX_STATES = {
  none: { className: "none", text: "no registered journey" },
  absent: { className: "absent", text: "—"},
  pending: { className: "pending", text: "registered, not yet explored" },
  explored: { className: "explored", text: "explored" },
};

const splitTableRow = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

/** The `JRNY-###` tokens of a brief cell; `none` and an empty cell name none. */
function journeyTokens(cell) {
  if (cell === "" || /^(none|n\/a|—|-)$/i.test(cell)) return [];
  const tokens = [...cell.matchAll(/JRNY-\d+/g)].map((match) => match[0]);
  if (tokens.length === 0) throw new Error(`brief: FEAT Journeys cell "${cell}" names no journey`);
  return [...new Set(tokens)];
}

/**
 * The brief's FEAT table: one row per `FEAT-###` with its name and the journeys
 * its Journeys column names. A row whose cell count disagrees with the header,
 * or a table with no Journeys column, is a malformed brief and fails here rather
 * than rendering a matrix the brief does not say.
 */
export function briefFeatures(markdown) {
  const lines = markdown.split("\n");
  const header = lines.findIndex((line) => /^\s*\|/.test(line) && /\bJourneys\b/i.test(line));
  if (header === -1) throw new Error("brief: no table with a Journeys column");
  const columns = splitTableRow(lines[header]);
  const idColumn = columns.findIndex((column) => /^ID$/i.test(column));
  const journeysColumn = columns.indexOf("Journeys");
  if (idColumn === -1) throw new Error("brief: the Journeys table has no ID column");
  const features = [];
  for (const line of lines.slice(header + 1)) {
    if (!/^\s*\|/.test(line)) break;
    const cells = splitTableRow(line);
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    const id = cells[idColumn] ?? "";
    if (!/^FEAT-\d+$/.test(id)) continue;
    if (cells.length !== columns.length) {
      throw new Error(`brief: ${id} row has ${cells.length} cells, the header has ${columns.length}`);
    }
    features.push({
      id,
      name: cells[idColumn + 1] ?? "",
      journeys: journeyTokens(cells[journeysColumn] ?? ""),
    });
  }
  if (features.length === 0) throw new Error("brief: the FEAT table has no rows");
  return features;
}

/**
 * Every run directory under `runsDir`, newest last. `usable` is a run the deck
 * can rate: a result.json and a review.json, both read strictly, and a status
 * other than `harness-error`, which R18's "a harness error is not a rating"
 * keeps out of every rating word. A directory with neither file is not an error
 * here; it simply has nothing to show.
 */
export function summaryRuns(runsDir) {
  const dir = resolve(runsDir);
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isDirectory())
    .filter((path) => existsSync(join(path, "session.json")))
    .map((path) => {
      const name = basenameOf(path);
      const session = readJson(join(path, "session.json"), `${name}/session.json`);
      const resultPath = join(path, "result.json");
      const reviewPath = join(path, "review.json");
      const result = existsSync(resultPath) ? validateResult(readJson(resultPath, `${name}/result.json`)) : null;
      const review = existsSync(reviewPath) ? validateReview(readJson(reviewPath, `${name}/review.json`)) : null;
      const usable = result !== null && review !== null && result.status !== "harness-error";
      return {
        name,
        dir: path,
        run: session.run,
        scenario: session.scenario,
        startedAt: session.startedAt ?? "",
        commit: session.commit ?? "not recorded",
        result,
        review,
        rating: usable ? computeRating({ result, review }).rating : null,
        usable,
      };
    })
    .sort((left, right) => {
      if (left.startedAt !== right.startedAt) return left.startedAt < right.startedAt ? -1 : 1;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });
}

const journeyOf = (scenario) => String(scenario).split("/")[0];
const slugOf = (scenario) => String(scenario).split("/").slice(1).join("/");

/**
 * One row per scenario the runs directory holds: the latest usable run of each
 * scenario is the one the deck reports, and the count beside it is every
 * exploration of that scenario, so a second, worse run is never hidden.
 */
function scenarioRows(runs) {
  const byScenario = new Map();
  for (const run of runs) {
    if (!byScenario.has(run.scenario)) byScenario.set(run.scenario, []);
    byScenario.get(run.scenario).push(run);
  }
  return [...byScenario.entries()].map(([scenario, ofScenario]) => {
    const usable = ofScenario.filter((run) => run.usable);
    const latest = usable[usable.length - 1] ?? ofScenario[ofScenario.length - 1] ?? null;
    const rated = latest !== null && latest.usable;
    return {
      scenario,
      journey: journeyOf(scenario),
      slug: slugOf(scenario),
      latest,
      explorations: ofScenario.length,
      status: rated ? latest.result.status : "no result recorded",
      rating: rated ? latest.rating : null,
      attribution: rated && latest.review.journey.attribution,
      decidingStep: rated ? latest.review.journey.decidingStep : null,
    };
  });
}

/**
 * The one line the cell carries. A feature that names this journey reads
 * `explored: <rating>` when the journey has a usable run, `registered, not yet
 * explored` when it has none. A journey the feature does not name reads a dash:
 * the cell does not apply, and "no registered journey" there would deny a
 * journey the registry holds.
 */
function matrixCell(feature, journey, rows) {
  if (feature.journeys.length === 0) return { state: MATRIX_STATES.none, text: MATRIX_STATES.none.text };
  if (!feature.journeys.includes(journey)) return { state: MATRIX_STATES.absent, text: MATRIX_STATES.absent.text };
  const ofJourney = rows.filter((row) => row.journey === journey);
  const rated = ofJourney.filter((row) => row.rating !== null);
  if (rated.length === 0) return { state: MATRIX_STATES.pending, text: MATRIX_STATES.pending.text };
  const entries = ofJourney.map((row) =>
    row.rating === null
      ? `${row.slug} ${MATRIX_STATES.pending.text}`
      : row.rating === "Not completed"
        ? `${row.slug} ${attributionLine(row.attribution)}`
        : `${row.slug} ${row.rating}`,
  );
  return { state: MATRIX_STATES.explored, text: `${MATRIX_STATES.explored.text}: ${entries.join("; ")}` };
}

/**
 * The six summary slides of references/deck.md: the brief's title, the
 * per-scenario ratings, the brief-feature to journey coverage matrix, the three
 * counts as three numbers, the same limits wording as the journey deck, and the
 * evidence index over every run that was read. The three counts are never merged
 * into one figure, and a figure's text is always the value at its
 * `data-source` path.
 */
export function renderSummaryDeck({ brief, runs, out }) {
  const briefBody = readText(brief, "product-brief.md");
  const features = briefFeatures(briefBody);
  const briefName = briefBody.split("\n")[0].replace(/^#\s+/, "");
  const all = summaryRuns(runs);
  const rows = scenarioRows(all);
  const columns = [...new Set(features.flatMap((feature) => feature.journeys))].sort();
  const rowFor = (journey) => rows.filter((row) => row.journey === journey);
  const latest = all[all.length - 1] ?? null;
  const counts = {
    features: features.length,
    withJourney: features.filter((feature) => feature.journeys.length > 0).length,
    explored: columns.filter((journey) => rowFor(journey).some((row) => row.rating !== null)).length,
  };
  const harnessErrors = all.filter((run) => run.result !== null && run.result.status === "harness-error");

  const title = slide(
    1,
    6,
    `Summary deck — ${basenameOf(resolve(runs))}`,
    briefName,
    `<dl class="kv">
      <dt>Brief</dt><dd class="mono">${escapeHtml(basenameOf(resolve(brief)))}</dd>
      <dt>Run collection</dt><dd class="mono">${escapeHtml(basenameOf(resolve(runs)))}</dd>
      <dt>Runs read</dt><dd>${figure("runs.count", all.length)}</dd>
      <dt>Most recent run</dt><dd>${latest === null ? "No runs recorded." : `${figure("runs.latest.run", latest.run)} — commit ${figure("runs.latest.commit", latest.result?.commit ?? latest.commit)}`}</dd>
      <dt>Scenarios</dt><dd>${figure("scenarios.count", rows.length)}</dd>
    </dl>
    <p class="lede">${figure("counts.features", counts.features)} features in the brief, ${figure("counts.featuresWithJourney", counts.withJourney)} of them with a registered journey, and ${figure("counts.journeysExplored", counts.explored)} ${counts.explored === 1 ? "journey" : "journeys"} explored. The three numbers differ, and the Coverage matrix and Counts slides show why.</p>`,
  );

  const ratings = slide(
    2,
    6,
    "Per-journey ratings",
    `The latest usable run of each scenario that has a run directory (${rows.length})`,
    rows.length === 0
      ? `<p class="empty">No runs recorded.</p>`
      : `<table>
          <thead><tr><th>Journey</th><th>Scenario</th><th>Result</th><th>Rating</th><th>Attribution</th><th class="num">Explorations</th></tr></thead>
          <tbody>${rows
            .map(
              (row, index) => `<tr>
              <td class="mono">${escapeHtml(row.journey)}</td>
              <td class="mono">${escapeHtml(row.scenario)}</td>
              <td>${figure(`scenarios[${index}].status`, row.status)}</td>
              <td>${row.rating === null
                ? "no rating recorded"
                : `<span class="rating rating--${ratingClass(row.rating)}" data-source="scenarios[${index}].rating">${escapeHtml(row.rating)}</span>`}</td>
              <td>${row.rating === "Not completed"
                ? `${escapeHtml(attributionLine(row.attribution))} — decided at step ${figure(`scenarios[${index}].decidingStep`, row.decidingStep)}`
                : "—"}</td>
              <td class="num">${figure(`scenarios[${index}].explorations`, row.explorations)}</td>
            </tr>`,
            )
            .join("")}</tbody>
        </table>
        <p class="lede">The result column is the harness's own word. A run the harness could not rate lists with its status and is never given a rating word.</p>
        ${harnessErrors.length === 0
          ? ""
          : `<p class="lede">Runs that ended in a harness error and are therefore not rated: ${harnessErrors
              .map((run, index) => `${figure(`harnessErrors[${index}].run`, run.run)} (${escapeHtml(run.result.reason ?? "no reason recorded")})`)
              .join(", ")}.</p>`}`,
  );

  const matrix = slide(
    3,
    6,
    "Coverage matrix",
    `Every feature in the brief, one column per registered journey (${columns.length})`,
    `<div class="strip"><table class="matrix">
      <thead><tr><th>ID</th><th>Feature</th>${columns.map((journey) => `<th class="num">${escapeHtml(journey)}</th>`).join("")}</tr></thead>
      <tbody>${features
        .map((feature, index) => {
          const cells = columns
            .map((journey) => {
              const cell = matrixCell(feature, journey, rows);
              return `<td class="cell"><span class="state state--${attr(cell.state.className)}" data-source="features[${index}].coverage.${attr(journey)}">${escapeHtml(cell.text)}</span></td>`;
            })
            .join("");
          return `<tr><td class="mono">${figure(`features[${index}].id`, feature.id)}</td><td>${escapeHtml(feature.name)}</td>${cells}</tr>`;
        })
        .join("")}</tbody>
    </table></div>
    <p class="lede">A cell reads <span class="mono">explored: &lt;scenario&gt; &lt;rating&gt;</span> when the journey has a usable run and <span class="mono">registered, not yet explored</span> when it names a journey with none. A dash marks a journey this feature does not name; a feature whose Journeys column names no journey at all reads <span class="mono">no registered journey</span> in every column. Every rating word comes from <span class="mono">skills/journey-qa/scripts/rating.mjs</span>.</p>`,
  );

  const countsSlide = slide(
    4,
    6,
    "Counts",
    "Three numbers, deliberately not merged",
    `<div class="counts">
      <div class="count"><span class="value">${figure("counts.features", counts.features)}</span><span class="label">features in the brief's FEAT table</span></div>
      <div class="count"><span class="value">${figure("counts.featuresWithJourney", counts.withJourney)}</span><span class="label">of those, features naming a registered journey</span></div>
      <div class="count"><span class="value">${figure("counts.journeysExplored", counts.explored)}</span><span class="label">journeys explored by a usable run</span></div>
    </div>
    <p class="lede">These three differ whenever a feature has no journey, a journey has not been run, or both. A single combined figure would hide that, so the deck shows the three and the Coverage matrix shows which feature is in which state.</p>`,
  );

  const limits = slide(
    5,
    6,
    "Limits",
    "What this collection of runs does not establish",
    `<ol class="limits">${limitsLines({
      second: null,
      agreementResult: null,
      explorations: {
        label: "Per-journey ratings slide",
        source: "runs.count",
        count: all.length,
        scope: `across ${rows.length} ${rows.length === 1 ? "scenario" : "scenarios"}`,
      },
      result: latest?.result ?? { stubExclusions: [], commit: "not recorded", dirty: false },
      run: latest?.run ?? "no run",
    })
      .map((line) => `<li>${line.text}</li>`)
      .join("")}</ol>`,
  );

  const evidence = slide(
    6,
    6,
    "Evidence index",
    `Every run this summary read (${all.length})`,
    all.length === 0
      ? `<p class="empty">No runs recorded.</p>`
      : `<table>
          <thead><tr><th>Run</th><th>Scenario</th><th>Result</th><th>Commit</th><th>Eyes mode</th><th>Check observations</th></tr></thead>
          <tbody>${all
            .map(
              (run, index) => `<tr>
              <td class="mono">${figure(`runs[${index}].run`, run.run)}</td>
              <td class="mono">${figure(`runs[${index}].scenario`, run.scenario)}</td>
              <td>${run.result === null ? "no result recorded" : figure(`runs[${index}].status`, run.result.status)}</td>
              <td class="mono">${figure(`runs[${index}].commit`, run.result?.commit ?? "not recorded")}</td>
              <td>${escapeHtml(run.result?.eyes ?? "none recorded")}</td>
              <td>${escapeHtml(observationsText(run.result?.check?.observations))}</td>
            </tr>`,
            )
            .join("")}</tbody>
        </table>`,
  );

  return writeDeck({
    title: `Summary deck — ${briefName}`,
    slides: [title, ratings, matrix, countsSlide, limits, evidence],
    out,
  });
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
  // --second-review is the second reviewer only. The run's own review.json stays
  // the primary review, so the deck body and the rating come from it and the
  // repeatability figure compares two independent reviews rather than the
  // second review against itself.
  const run = loadRun(runDir);

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
