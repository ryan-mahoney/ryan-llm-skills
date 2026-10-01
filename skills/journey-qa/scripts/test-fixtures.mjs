// A complete, valid run directory and a brief with FEAT rows, written to a
// temporary directory the tests and the visual smoke steps own. The values are
// fixed here so a rendered deck can be checked against a known source, and every
// key of C-6 and C-9 is present because the loader reads them strictly.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A 1x1 transparent PNG; the deck only needs bytes to inline as a data URI.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const session = (run) => ({
  run,
  scenario: "JRNY-001/import",
  port: 4321,
  socket: `/tmp/ux-qa-fixture.sock`,
  dbUrl: "postgres://localhost/uxqa",
  pids: { phoenix: 101, driver: 102 },
  commit: "abc1234",
  dirty: false,
  startedAt: "2026-10-01T10:00:00Z",
  maxSteps: 80,
  javaPath: "/opt/java/bin/java",
});

const result = (run) => ({
  run,
  scenario: "JRNY-001/import",
  status: "completed",
  check: { id: "import-feed", pass: true, observations: "5 files imported" },
  claim: "done",
  reason: null,
  eyes: "host-vision",
  referenceActions: 8,
  proxies: {
    actions: 10,
    observations: 3,
    scrolls: 1,
    wrongTries: 0,
    rejected: 0,
    backtracks: 0,
    errorsSeen: { banners: 0, httpErrors: 0, consoleErrors: 0, failedActions: 0, total: 0 },
    endedInError: false,
    actionsToEntryRoute: 1,
    elapsedSeconds: 92,
  },
  stubExclusions: ["/map/tiles/", "/map/buildings"],
  commit: "abc1234",
  dirty: false,
  startedAt: "2026-10-01T10:00:00Z",
  finishedAt: "2026-10-01T10:01:32Z",
});

const review = (run) => ({
  run,
  eyes: "host-vision",
  steps: [
    { n: 1, q1: 2, q2: 2, q3: 2, q4: 2, captures: ["s001.png"], note: null },
    { n: 2, q1: 2, q2: 2, q3: null, q4: 1, captures: ["s002.png"], note: "no expectation logged" },
  ],
  screens: [
    {
      route: "/versions/new",
      screen: "Upload a feed",
      heuristics: {
        H1: { score: 2, evidence: "Visible control on first viewport", capture: "s001.png" },
        H2: { score: "n/a", evidence: "No data list on this screen", capture: null },
      },
      states: { seen: ["default"], notExercised: ["uploading", "error"] },
      verify: [],
    },
  ],
  journey: { attribution: null, decidingStep: null },
  findings: [
    {
      id: "F-1",
      severity: "low",
      kind: "labelling",
      step: 2,
      capture: "s002.png",
      statement: "The progress bar has no text label.",
      consequence: "A tester cannot tell whether the upload is progressing.",
    },
  ],
});

const steps = (run) => [
  { kind: "setup", run, t: 0, action: "sign-in", ok: true },
  { kind: "step", run, n: 1, t: 4000, action: "goto", target: { path: "/versions/new" }, intent: "Open the upload screen", expected: "Upload form", urlBefore: "/", urlAfter: "/versions/new", ok: true, rejected: false, error: null, ms: 380, capture: "captures/s001.png", consoleErrors: 0, httpErrors: 0, alerts: [], downloads: [] },
  { kind: "step", run, n: 2, t: 9000, action: "upload", target: { text: "Choose a .zip file", file: "sample-feed.zip" }, intent: "Upload the feed", expected: null, urlBefore: "/versions/new", urlAfter: "/versions/new", ok: true, rejected: false, error: null, ms: 4700, capture: "captures/s002.png", consoleErrors: 0, httpErrors: 0, alerts: [], downloads: [] },
  { kind: "finish", claim: "done", reason: null, eyes: "host-vision" },
];

const brief = () => `# Import a feed

## Persona

An operator who publishes timetables and knows the GTFS format.

## Goal

Import the sample feed and see the new version listed.

## Start path

Login at http://127.0.0.1:4321/users/log_in and open the versions page.

## Files

- sample-feed.zip
`;

/**
 * Write a complete run directory at `dir`. `overrides` replace whole top-level
 * files by name, so a test can pass `{ "result.json": { status: "harness-error" } }`
 * only when it means to drop every other C-6 key.
 */
export function fixtureRun(dir, overrides = {}) {
  const run = "20261001T100000Z-JRNY-001-import";
  mkdirSync(join(dir, "captures"), { recursive: true });
  writeFileSync(join(dir, "captures", "s001.png"), PNG);
  writeFileSync(join(dir, "captures", "s002.png"), PNG);

  const files = {
    "session.json": `${JSON.stringify(session(run), null, 2)}\n`,
    "result.json": `${JSON.stringify(result(run), null, 2)}\n`,
    "review.json": `${JSON.stringify(review(run), null, 2)}\n`,
    "steps.jsonl": `${steps(run).map((step) => JSON.stringify(step)).join("\n")}\n`,
    "brief.md": brief(),
  };
  for (const [name, content] of Object.entries({ ...files, ...overrides })) {
    writeFileSync(join(dir, name), content);
  }
  return { dir, run, scenario: "JRNY-001/import" };
}

/** Write a brief with four FEAT rows, two of them naming journeys. */
export function fixtureBrief(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "product-brief.md");
  writeFileSync(
    path,
    `# Product brief

## Basis

| Input | Source | Status |
| --- | --- | --- |
| Journey registry | \`docs/journey-registry.md\`, \`docs/journeys/\` | Registry present: 58 journeys, 14 seams. |

Read at commit abc1234. Not verified behavior.

## 1 What it is and who uses it

A GTFS timetable planner. Operators import feeds, edit schedules and export them.

## 2 What you can do

| ID | Feature | Description | Actor | Screens | Journeys |
| --- | --- | --- | --- | --- | --- |
| FEAT-001 | Import a feed | Upload a zip and list it as a version. | operator | SCRN-010 | JRNY-001 |
| FEAT-002 | Edit a trip | Change a stop time and save it. | operator | SCRN-020 | JRNY-002 |
| FEAT-003 | Export a feed | Write the current version to a zip. | operator | SCRN-030 | JRNY-003 |
| FEAT-004 | Manage accounts | Add and remove operator accounts. | operator | SCRN-040 | none |

## 3 Jobs coverage

| Job | Screens | Journeys | Status |
| --- | --- | --- | --- |
| Publish a timetable | SCRN-010 | JRNY-001 | served |

## 4 Planned

Nothing planned.

## 5 Environment limits

Geocoding and routing are stubbed; the validator is the real jar.
`,
  );
  return path;
}
