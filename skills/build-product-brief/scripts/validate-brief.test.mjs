import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./validate-brief.mjs", import.meta.url));

const INVENTORY = `# Hiring — operation screens

## 4. Screens

| ID | Screen | Route | Reached by | Status | Purpose |
|---|---|---|---|---|---|
| SCRN-001 | Job list | \`/jobs\` or \`/jobs/all\` | all roles | documented | The open roles |
| SCRN-002 | Excluded | — | all roles | documented | Not a screen |
`;

const REGISTRY = `# Journey registry

## 4. Journey table

| ID | Goal | Actor | Trigger | Terminal outcome | Status |
|---|---|---|---|---|---|
| JRNY-001 | Hire | operator | Signs in | Role published | documented |
`;

const ROUTES = `/jobs
/jobs/all
`;

const RAW_ROUTES = `   *    /jobs              JobLive.Index    GET
          /jobs/all          JobLive.All      GET
`;

// The good brief: one resolving feature row, the Basis heading, no run path.
const GOOD_BRIEF = `# Product brief

## Basis

This brief describes the behavior at \`abc1234\`, as read on 2026-10-01.

## 2. What you can do

| ID | Feature | Description | Actor | Screens | Journeys |
|---|---|---|---|---|---|
| FEAT-001 | List open roles | An operator sees the open roles. | operator | SCRN-001 | JRNY-001 |
`;

/** One feature row for the table the good brief carries. */
const briefWith = (row) => GOOD_BRIEF.replace("| FEAT-001 | List open roles | An operator sees the open roles. | operator | SCRN-001 | JRNY-001 |", row);

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A corpus plus a brief in a temporary directory; one bad fixture per failure. */
const fixture = ({ brief = GOOD_BRIEF, inventory = INVENTORY, routes = ROUTES } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "validate-brief-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "docs", "inventories"), { recursive: true });
  writeFileSync(join(dir, "docs", "inventories", "hiring-screens.md"), inventory);
  writeFileSync(join(dir, "docs", "journey-registry.md"), REGISTRY);
  writeFileSync(join(dir, "docs", "product-brief.md"), brief);
  writeFileSync(join(dir, "routes.txt"), routes);
  return dir;
};

/** The validator's own exit code, through a real process. */
const runCli = (dir, { routes = true } = {}) =>
  spawnSync(
    process.execPath,
    [
      SCRIPT,
      "docs/product-brief.md",
      "--inventories", "docs/inventories",
      "--registry", "docs/journey-registry.md",
      ...(routes ? ["--routes", "routes.txt"] : []),
    ],
    { cwd: dir, encoding: "utf8" },
  );

test("the good fixture exits 0 and prints ok", () => {
  const result = runCli(fixture());
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ok\n");
});

test("raw mix phx.routes output is accepted as the route list", () => {
  const result = runCli(fixture({ routes: RAW_ROUTES }));
  assert.equal(result.status, 0);
});

test("an unknown SCRN token fails naming the token and its line", () => {
  const result = runCli(fixture({
    brief: briefWith("| FEAT-001 | List roles | A sentence. | operator | SCRN-404 | JRNY-001 |"),
  }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /product-brief\.md:\d+: SCRN-404 is not defined/);
});

test("an unknown JRNY token fails naming the token", () => {
  const result = runCli(fixture({
    brief: briefWith("| FEAT-001 | List roles | A sentence. | operator | SCRN-001 | JRNY-777 |"),
  }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /JRNY-777 is not defined/);
});

test("a FEAT ID the brief's own table does not define fails naming the token", () => {
  const result = runCli(fixture({
    brief: `${GOOD_BRIEF}\nA retired capability is described here as FEAT-002.\n`,
  }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FEAT-002 is not defined/);
});

// The banned run-directory path, assembled so the test file contains no such path.
const RUN_PATH = `.${"specs"}/ux-qa/run-3`;

test("a cited run-directory path fails", () => {
  const result = runCli(fixture({
    brief: GOOD_BRIEF.replace("as read on", `read from ${RUN_PATH} on`),
  }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cites a local run path/);
});

test("a brief without the Basis heading fails", () => {
  const result = runCli(fixture({
    brief: GOOD_BRIEF.replace("## Basis", "## Summary"),
  }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no "## Basis" heading/);
});

test("a route absent from the route list fails naming the row's SCRN ID", () => {
  const result = runCli(fixture({
    inventory: INVENTORY.replace("`/jobs` or `/jobs/all`", "`/jobs` or `/open-roles`"),
  }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hiring-screens\.md:\d+: SCRN-001 cites route \/open-roles/);
});

test("without --routes the route check is skipped", () => {
  const result = runCli(
    fixture({ inventory: INVENTORY.replace("`/jobs` or `/jobs/all`", "`/jobs` or `/open-roles`") }),
    { routes: false },
  );
  assert.equal(result.status, 0);
});