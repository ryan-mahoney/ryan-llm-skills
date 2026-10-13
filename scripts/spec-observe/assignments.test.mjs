import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectAssignment,
  QUIET_ACTIVITY_MS,
  LAUNCHING_ATTENTION_MS,
} from "./assignments.mjs";
// Namespace access keeps a missing collectAssignments export a behavior
// assertion instead of an import-time module failure.
import * as assignmentsModule from "./assignments.mjs";
import {
  findAssignment,
  listAssignments,
  resolveAssignment,
} from "../workspaces/assignments.mjs";
import {
  createCatalogReadBudget,
  createWorkspace,
  setupStorage,
} from "../workspaces/store.mjs";
import { startSession } from "../workspaces/tmux.mjs";
import { processIdentity } from "./process-identity.mjs";

const NOW = 1_800_000_000_000;
const ASSIGNMENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";
const SPEC_PACKAGE = "/repo/packages/alpha";
const WORKFLOW_ID = "workflow-alpha-1";
const PI_IDENTITY = { pid: 43210, started_at: "Thu Jan  1 00:00:00 1970" };

function makeRecord(overrides = {}) {
  return {
    assignment_id: ASSIGNMENT_ID,
    spec_package: SPEC_PACKAGE,
    workflow_id: WORKFLOW_ID,
    state: "live",
    created_at: new Date(NOW - 5000).toISOString(),
    ...overrides,
  };
}

function makeClassification(overrides = {}) {
  return {
    state: "live",
    piIdentity: PI_IDENTITY,
    sessionFile: null,
    attention: [],
    gone: false,
    ...overrides,
  };
}

function project(record, classification, options = {}) {
  return projectAssignment(record, classification, { now: NOW, ...options });
}

test("assignment projection maps a live record to live with an attach hint and no control", () => {
  const row = project(makeRecord(), makeClassification());
  assert.equal(row.display, "live");
  assert.equal(row.recordedState, "live");
  assert.equal(row.observedState, "live");
  assert.equal(row.unrecorded, false);
  assert.equal(row.nextAction, "Attach command");
  assert.equal(row.safeAction, "Attach command");
  assert.equal(row.hasControl, false);
  assert.equal(row.coverage, "complete");
  assert.equal(row.assignment_id, ASSIGNMENT_ID);
  assert.equal(row.spec_package, SPEC_PACKAGE);
  assert.equal(row.workflow_id, WORKFLOW_ID);
});

test("assignment projection shows an observed live agent over an unrecorded launch as live-unrecorded", () => {
  for (const state of ["launching", "launch_unknown"]) {
    const row = project(makeRecord({ state }), makeClassification());
    assert.equal(row.display, "live-unrecorded");
    assert.equal(row.unrecorded, true);
    assert.equal(
      row.nextAction,
      "node ~/.agents/scripts/workspaces/cli.mjs locate 11111111-1111-4111-8111-111111111111",
    );
  }
});

test("assignment projection keeps a launching record under 60 seconds waiting", () => {
  const row = project(
    makeRecord({ state: "launching" }),
    makeClassification({ state: "launching" }),
  );
  assert.equal(row.display, "launching");
  assert.equal(row.nextAction, "Wait");
  assert.equal(row.unrecorded, false);
});

test("assignment projection marks a launching record at 60 seconds or later as launch-unconfirmed", () => {
  const record = makeRecord({
    state: "launching",
    created_at: new Date(NOW - LAUNCHING_ATTENTION_MS).toISOString(),
  });
  const row = project(record, makeClassification({ state: "launching" }));
  assert.equal(row.display, "launch-unconfirmed");
  assert.equal(
    row.nextAction,
    "node ~/.agents/scripts/workspaces/cli.mjs locate 11111111-1111-4111-8111-111111111111",
  );
});

test("assignment projection marks a launch_unknown record with probes ok as launch-unconfirmed", () => {
  const row = project(
    makeRecord({ state: "launch_unknown" }),
    makeClassification({ state: "launch_unknown" }),
  );
  assert.equal(row.display, "launch-unconfirmed");
  assert.equal(
    row.nextAction,
    "node ~/.agents/scripts/workspaces/cli.mjs locate 11111111-1111-4111-8111-111111111111",
  );
});

test("assignment projection shows a confirmed gone live record as exited-unrecorded without rewriting it", () => {
  const record = Object.freeze(makeRecord());
  const row = project(
    record,
    makeClassification({ state: "ended", gone: true }),
  );
  assert.equal(row.display, "exited-unrecorded");
  assert.equal(row.unrecorded, true);
  assert.equal(
    row.nextAction,
    "node ~/.agents/scripts/workspaces/cli.mjs locate 11111111-1111-4111-8111-111111111111",
  );
  assert.equal(record.state, "live");
});

test("assignment projection shows terminal-lost for a matching orphan process without a terminal", () => {
  const classification = makeClassification({
    piIdentity: PI_IDENTITY,
    attention: [
      "matching Pi process is alive without the exact recorded terminal; retaining the reservation",
    ],
  });
  const row = project(makeRecord(), classification);
  assert.equal(row.display, "terminal-lost");
  assert.match(row.nextAction, /^Do not relaunch/);
  assert.equal(row.hasControl, false);
});

test("assignment projection keeps unavailable probes and unknown classifications unknown, never ended", () => {
  const missing = project(makeRecord(), undefined);
  assert.equal(missing.display, "unknown");
  assert.equal(missing.coverage, "partial");
  assert.equal(missing.nextAction, "Fix probe; no relaunch");

  const terminal = project(
    makeRecord(),
    makeClassification({
      state: "launching",
      attention: ["terminal observation is unknown"],
    }),
  );
  assert.equal(terminal.display, "unknown");
  assert.equal(terminal.coverage, "partial");

  const listing = project(
    makeRecord(),
    makeClassification({
      attention: [
        "process listing is incomplete; assignment UUID absence cannot be confirmed",
      ],
    }),
  );
  assert.equal(listing.display, "unknown");
});

test("assignment projection keeps ended and launch-failed records terminal when no positive process evidence exists", () => {
  const ended = project(
    makeRecord({ state: "ended" }),
    makeClassification({ state: "ended", piIdentity: null }),
  );
  assert.equal(ended.display, "ended");
  assert.equal(ended.recordedState, "ended");
  assert.equal(ended.nextAction, "History");
  assert.equal(ended.unrecorded, false);

  const failed = project(
    makeRecord({ state: "launch_failed" }),
    makeClassification({ state: "launch_failed", piIdentity: null }),
  );
  assert.equal(failed.display, "launch-failed");
  assert.equal(failed.nextAction, "History");
  assert.equal(failed.unrecorded, false);
});

test("assignment projection surfaces a terminal record contradicted by matching live evidence as unknown", () => {
  for (const state of ["ended", "launch_failed"]) {
    const classification = makeClassification({
      state,
      attention: [
        `assignment state ${state} is terminal but live evidence was observed; refusing to revive it`,
      ],
    });
    const row = project(makeRecord({ state }), classification);
    assert.equal(row.recordedState, state);
    assert.equal(row.display, "unknown");
    assert.equal(row.nextAction, "Fix probe; no relaunch");
    assert.equal(row.unrecorded, false);
    assert.equal(row.coverage, "partial");
    assert.equal(row.hasControl, false);
  }
});

test("assignment projection treats a terminal record with a classifier UUID process candidate as unknown", () => {
  for (const state of ["ended", "launch_failed"]) {
    const classification = makeClassification({
      state,
      piIdentity: null,
      attention: [
        "process listing shows a candidate for the assignment UUID; retaining the reservation",
      ],
    });
    const row = project(makeRecord({ state }), classification);
    assert.equal(row.recordedState, state);
    assert.equal(row.observedState, state);
    assert.equal(row.display, "unknown");
    assert.equal(row.nextAction, "Fix probe; no relaunch");
    assert.equal(row.unrecorded, false);
    assert.equal(row.coverage, "partial");
    assert.ok(row.coverageReasons.includes("record-process-mismatch"));
    assert.ok(
      row.attention.some((value) =>
        value.includes("process evidence was observed"),
      ),
    );
    assert.equal(row.hasControl, false);
  }
});

test("assignment projection treats a retained live classification without matching identity as unknown", () => {
  const retained = makeClassification({
    piIdentity: null,
    attention: ["recorded Pi process 43210 is confirmed dead"],
  });
  const row = project(makeRecord(), retained);
  assert.equal(row.recordedState, "live");
  assert.equal(row.observedState, "live");
  assert.equal(row.display, "unknown");
  assert.equal(row.nextAction, "Fix probe; no relaunch");
  assert.equal(row.unrecorded, false);
  assert.equal(row.coverage, "partial");
  assert.equal(row.quiet, false);

  const launching = project(makeRecord({ state: "launching" }), retained);
  assert.equal(launching.display, "unknown");
  assert.equal(launching.nextAction, "Fix probe; no relaunch");
  assert.equal(launching.unrecorded, false);
});

test("assignment projection marks quiet only from successful finite activity metadata over 120 seconds", () => {
  const row = project(makeRecord(), makeClassification(), {
    activity: { ok: true, size: 128, mtime: NOW - QUIET_ACTIVITY_MS - 1 },
  });
  assert.equal(row.quiet, true);

  const boundary = project(makeRecord(), makeClassification(), {
    activity: { ok: true, size: 128, mtime: NOW - QUIET_ACTIVITY_MS },
  });
  assert.equal(boundary.quiet, false);
});

test("assignment projection never infers quiet from absent, failed, mismatched or transcript activity", () => {
  const live = makeClassification({ sessionFile: "/sessions/one.jsonl" });
  const staleMtime = NOW - QUIET_ACTIVITY_MS - 1;
  const cases = [
    project(makeRecord(), live),
    project(makeRecord(), live, {
      activity: { ok: false, size: 1, mtime: staleMtime },
    }),
    project(makeRecord(), live, { activity: { ok: true, mtime: staleMtime } }),
    project(makeRecord(), live, {
      activity: { ok: true, size: Number.NaN, mtime: staleMtime },
    }),
    project(makeRecord(), live, {
      activity: { ok: true, size: 1, mtime: "not-a-date" },
    }),
    project(makeRecord(), live, {
      activity: {
        ok: true,
        size: 1,
        mtime: staleMtime,
        assignment_id: OTHER_ID,
      },
    }),
    project(makeRecord(), live, {
      activity: {
        ok: true,
        size: 1,
        mtime: staleMtime,
        session_file: "/sessions/other.jsonl",
      },
    }),
    project(makeRecord(), live, {
      activity: { ok: true, text: "transcript text only" },
    }),
    project(makeRecord({ state: "ended" }), makeClassification(), {
      activity: { ok: true, size: 1, mtime: staleMtime },
    }),
  ];
  for (const row of cases) assert.equal(row.quiet, false);
});

test("assignment projection exposes attached count as information that never grants control", () => {
  const fromRecord = project(makeRecord({ attached: 3 }), makeClassification());
  assert.equal(fromRecord.attachedCount, 3);
  assert.equal(fromRecord.hasControl, false);
  assert.equal(fromRecord.nextAction, "Attach command");

  const fromActivity = project(makeRecord(), makeClassification(), {
    activity: { ok: true, size: 1, mtime: NOW, clients: 2 },
  });
  assert.equal(fromActivity.attachedCount, 2);
  assert.equal(fromActivity.hasControl, false);

  // A present opt-in terminal count is current evidence for the exact
  // assignment and beats retained hints; zero still grants no control.
  const fromTerminal = project(
    makeRecord({ attached: 3 }),
    makeClassification(),
    {
      observations: {
        launcher: { status: "alive" },
        terminal: {
          status: "present",
          assignment_id: ASSIGNMENT_ID,
          pane_id: null,
          pid: PI_IDENTITY.pid,
          attached: 0,
        },
        pi: { status: "alive" },
        uuidProcesses: { status: "absent" },
        session: { status: "missing" },
      },
    },
  );
  assert.equal(fromTerminal.display, "live");
  assert.equal(fromTerminal.attachedCount, 0);
  assert.equal(fromTerminal.hasControl, false);
});

test("assignment projection links an exited coordinator run with a coordinator-gone condition to workers-unconfirmed", () => {
  const runs = [
    {
      workflow_id: WORKFLOW_ID,
      spec_package: SPEC_PACKAGE,
      assignment_id: ASSIGNMENT_ID,
      execution: "failed",
      coverage: { reasons: ["coordinator-gone"] },
    },
  ];
  const row = project(makeRecord(), makeClassification(), { runs });
  assert.equal(row.workersUnconfirmed, true);
  assert.equal(row.nextAction, "Inspect recorded workers");
  assert.ok(row.attention.includes("workers-unconfirmed"));
  assert.ok(row.attention.includes("coordinator-gone"));
});

test("assignment projection adds workers-unconfirmed when the coordinator exited while its run still shows running", () => {
  const runs = [
    {
      workflow_id: WORKFLOW_ID,
      spec_package: SPEC_PACKAGE,
      execution: "running",
      coverage: { reasons: ["coordinator-gone"] },
    },
  ];
  const row = project(
    makeRecord({ state: "ended" }),
    makeClassification({ state: "ended", piIdentity: null }),
    { runs },
  );
  assert.equal(row.display, "ended");
  assert.equal(row.workersUnconfirmed, true);
  assert.equal(row.nextAction, "Inspect recorded workers");
});

test("assignment projection joins a run by package reference as well as directory", () => {
  const run = {
    workflow_id: WORKFLOW_ID,
    package_ref: "demo/feature",
    package: "/storage/projects/demo/specs/feature",
    execution: "failed",
    coverage: { reasons: ["coordinator-gone"] },
  };
  assert.equal(
    project(
      makeRecord({ spec_package: "demo/feature" }),
      makeClassification(),
      { runs: [run] },
    ).workersUnconfirmed,
    true,
  );
  assert.equal(
    project(makeRecord({ spec_package: "demo/other" }), makeClassification(), {
      runs: [run],
    }).workersUnconfirmed,
    false,
  );
});

test("assignment projection does not claim workers-unconfirmed without a joined coordinator-gone condition", () => {
  const makeRuns = (run) => [
    { workflow_id: WORKFLOW_ID, spec_package: SPEC_PACKAGE, ...run },
  ];
  const runningLease = project(makeRecord(), makeClassification(), {
    runs: makeRuns({
      execution: "running",
      coverage: { reasons: ["coordinator-gone"] },
    }),
  });
  assert.equal(runningLease.workersUnconfirmed, false);

  const noLease = project(makeRecord(), makeClassification(), {
    runs: makeRuns({
      execution: "failed",
      coverage: { reasons: ["receipt-stale"] },
    }),
  });
  assert.equal(noLease.workersUnconfirmed, false);

  const otherWorkflow = project(makeRecord(), makeClassification(), {
    runs: [
      {
        workflow_id: "workflow-other",
        spec_package: SPEC_PACKAGE,
        execution: "failed",
        coverage: { reasons: ["coordinator-gone"] },
      },
    ],
  });
  assert.equal(otherWorkflow.workersUnconfirmed, false);

  const otherPackage = project(makeRecord(), makeClassification(), {
    runs: [
      {
        workflow_id: WORKFLOW_ID,
        spec_package: "/repo/packages/beta",
        execution: "failed",
        coverage: { reasons: ["coordinator-gone"] },
      },
    ],
  });
  assert.equal(otherPackage.workersUnconfirmed, false);

  const otherAssignment = project(makeRecord(), makeClassification(), {
    runs: makeRuns({
      assignment_id: OTHER_ID,
      execution: "failed",
      coverage: { reasons: ["coordinator-gone"] },
    }),
  });
  assert.equal(otherAssignment.workersUnconfirmed, false);
});

test("assignment projection preserves the full assignment id and never mutates its inputs", () => {
  const record = Object.freeze(makeRecord());
  const classification = Object.freeze(makeClassification());
  const activity = Object.freeze({
    ok: true,
    size: 1,
    mtime: NOW - QUIET_ACTIVITY_MS - 1,
  });
  const runs = Object.freeze([
    Object.freeze({
      workflow_id: WORKFLOW_ID,
      spec_package: SPEC_PACKAGE,
      execution: "failed",
      coverage: Object.freeze({ reasons: Object.freeze(["coordinator-gone"]) }),
    }),
  ]);
  const before = JSON.stringify(record);
  const row = project(record, classification, { activity, runs });
  assert.equal(row.assignment_id, ASSIGNMENT_ID);
  assert.equal(row.assignment_id.length, 36);
  assert.equal(row.quiet, true);
  assert.equal(JSON.stringify(record), before);
  assert.equal(record.state, "live");
});

test("assignment projection publishes execution_dir, repository_id and the literal locate command from frozen inputs", () => {
  const record = Object.freeze(
    makeRecord({
      execution_dir: "/repo/worktrees/alpha",
      repository_id: "repo-alpha",
    }),
  );
  const before = JSON.stringify(record);
  const row = project(record, makeClassification());
  assert.equal(row.execution_dir, "/repo/worktrees/alpha");
  assert.equal(row.repository_id, "repo-alpha");
  assert.equal(
    row.locate_command,
    "node ~/.agents/scripts/workspaces/cli.mjs locate 11111111-1111-4111-8111-111111111111",
  );
  assert.equal(row.hasControl, false);
  assert.equal(JSON.stringify(record), before);
});

test("assignment projection preserves a recorded execution_dir with trailing whitespace verbatim", () => {
  const record = Object.freeze(
    makeRecord({ execution_dir: "/storage/projects/alpha " }),
  );
  const before = JSON.stringify(record);
  const row = project(record, makeClassification());
  assert.equal(row.execution_dir, "/storage/projects/alpha ");
  assert.equal(JSON.stringify(record), before);
});

test("assignment projection projects missing, non-string and blank execution facts as null", () => {
  const missing = project(Object.freeze(makeRecord()), makeClassification());
  assert.equal(missing.execution_dir, null);
  assert.equal(missing.repository_id, null);

  for (const value of [
    null,
    undefined,
    42,
    ["/repo/worktrees/alpha"],
    { path: "/repo/worktrees/alpha" },
    "",
    "   ",
  ]) {
    const record = Object.freeze(
      makeRecord({ execution_dir: value, repository_id: value }),
    );
    const row = project(record, makeClassification());
    assert.equal(row.execution_dir, null);
    assert.equal(row.repository_id, null);
  }
});

test("assignment projection publishes no locate command without an assignment id", () => {
  for (const value of [null, undefined, 42, "", "   "]) {
    const record = Object.freeze(makeRecord({ assignment_id: value }));
    const row = project(record, makeClassification());
    assert.equal(row.assignment_id, null);
    assert.equal(row.locate_command, null);
  }
});

async function fixtureSignature(path) {
  const [bytes, info] = await Promise.all([readFile(path), lstat(path)]);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

// First step-3 counterexample: two concurrent read-only collections over one
// real persisted live record with only the final inspect/psRun/tmuxRun
// boundaries unavailable. Collection must degrade to unknown without relaunch
// or control, and must leave every fixture byte and mtime untouched.
test("assignment collection: concurrent collections with unavailable probes keep a live record unknown and write nothing", async (t) => {
  const collectAssignments = assignmentsModule.collectAssignments;
  assert.equal(
    typeof collectAssignments,
    "function",
    "assignments.mjs must export collectAssignments",
  );

  const root = await realpath(
    await mkdtemp(join(tmpdir(), "adj6-collection-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  await setupStorage(root);
  const workspace = await createWorkspace(root, {
    id: "ws-collection",
    name: "Collection Workspace",
  });
  await mkdir(join(workspace.directory, "briefs"), { recursive: false });
  await writeFile(
    join(workspace.directory, "briefs", "brief.md"),
    "# Collection brief\n",
  );
  const resolved = await resolveAssignment({
    assignment_id: ASSIGNMENT_ID,
    workspace_id: "ws-collection",
    brief: "briefs/brief.md",
    instructions: "Remain read-only while observed.",
    storageRoot: root,
    workflow_id: WORKFLOW_ID,
    pi_path: process.execPath,
  });

  const assignmentsDir = join(workspace.directory, "assignments");
  await mkdir(assignmentsDir, { recursive: false });
  const recordPath = join(assignmentsDir, `${ASSIGNMENT_ID}.json`);
  await writeFile(
    recordPath,
    JSON.stringify({
      ...resolved.record,
      state: "live",
      pane_id: "%1",
      launcher_identity: {
        pid: process.pid,
        started_at: new Date(0).toISOString(),
      },
      pi_identity: PI_IDENTITY,
      updated_at: new Date().toISOString(),
    }),
  );

  const checkpointPath = join(workspace.directory, "checkpoint.tmp");
  const leasePath = join(workspace.directory, "lease.tmp");
  await writeFile(checkpointPath, "checkpoint fixture bytes\n");
  await writeFile(leasePath, "lease fixture bytes\n");

  const watched = {
    record: recordPath,
    kit: workspace.kit,
    checkpoint: checkpointPath,
    lease: leasePath,
  };
  const before = {};
  for (const [label, path] of Object.entries(watched))
    before[label] = await fixtureSignature(path);

  const probes = {
    inspect: (pid) => ({
      state: "unknown",
      pid,
      reason: "synthetic-unavailable",
    }),
    psRun: async () => ({ stdout: "", complete: false }),
    tmuxRun: async () => {
      const error = new Error("synthetic tmux unavailable");
      error.code = "ENOENT";
      throw error;
    },
  };
  const collect = () =>
    collectAssignments({ storageRoot: root, runs: [], probes });
  const [first, second] = await Promise.all([collect(), collect()]);

  for (const result of [first, second]) {
    assert.ok(
      Array.isArray(result.assignments),
      "collectAssignments must return assignment rows",
    );
    const row = result.assignments.find(
      (entry) => entry.assignment_id === ASSIGNMENT_ID,
    );
    assert.ok(row, "the persisted live assignment must be collected");
    assert.equal(row.display, "unknown");
    assert.equal(row.recordedState, "live");
    assert.equal(row.hasControl, false);
    assert.match(row.nextAction, /no relaunch/i);
    assert.match(row.safeAction, /no relaunch/i);
  }

  for (const [label, path] of Object.entries(watched)) {
    assert.deepEqual(
      await fixtureSignature(path),
      before[label],
      `${label} must stay byte- and mtime-identical`,
    );
  }
  await assert.rejects(
    lstat(join(root, ".sentinel")),
    (error) => error.code === "ENOENT",
  );
});

// Shared collection fixtures. The projection tests above own their inputs;
// every collection case below builds real adj3 storage through the real
// resolveAssignment producer and only substitutes final OS boundaries.
async function collectionFixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "adj6-collection-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await setupStorage(root);
  const workspace = await createWorkspace(root, {
    id: "ws-collection",
    name: "Collection Workspace",
  });
  await mkdir(join(workspace.directory, "briefs"), { recursive: false });
  await writeFile(
    join(workspace.directory, "briefs", "brief.md"),
    "# Collection brief\n",
  );
  return { root, workspace };
}

async function resolvedRecord(root, workspace, overrides = {}) {
  const { assignment_id: assignmentId = ASSIGNMENT_ID, ...resolveOverrides } =
    overrides;
  const resolved = await resolveAssignment({
    assignment_id: assignmentId,
    workspace_id: workspace.id,
    brief: "briefs/brief.md",
    instructions: "Remain read-only while observed.",
    storageRoot: root,
    workflow_id: WORKFLOW_ID,
    pi_path: process.execPath,
    ...resolveOverrides,
  });
  return resolved.record;
}

async function persistRecord(workspace, record, overrides = {}) {
  const assignmentsDir = join(workspace.directory, "assignments");
  await mkdir(assignmentsDir, { recursive: true });
  const recordPath = join(assignmentsDir, `${record.assignment_id}.json`);
  await writeFile(recordPath, JSON.stringify({ ...record, ...overrides }));
  return recordPath;
}

const LAUNCHER_IDENTITY = { pid: 3001, started_at: "Thu Jan  1 00:00:00 1970" };
const AGENT_IDENTITY = { pid: 3002, started_at: "Thu Jan  1 00:00:00 1970" };

function okRun(stdout) {
  return {
    ok: true,
    code: 0,
    spawnCode: null,
    signal: null,
    killed: false,
    stdout,
    stderr: "",
  };
}

function exitOne() {
  return {
    ok: false,
    code: 1,
    spawnCode: null,
    signal: null,
    killed: false,
    stdout: "",
    stderr: "no session",
    message: "no session",
  };
}

function tmuxRunAbsent() {
  return async (_socketPath, args) => {
    if (args[0] === "list-clients") return okRun("");
    return exitOne();
  };
}

function tmuxRunPresent(assignmentId, paneId, panePid) {
  return async (_socketPath, args) => {
    if (args[0] === "has-session") return okRun("");
    if (args[0] === "list-clients") return okRun("");
    if (args[0] === "show-options") return okRun(`${assignmentId}\n`);
    if (args[0] === "display-message") return okRun(`${paneId} ${panePid}\n`);
    return exitOne();
  };
}

const deadInspect = (pid) => ({ state: "dead", pid });
const psAbsent = async () => ({ stdout: "", complete: true });
const psUnknown = async () => ({ stdout: "", complete: false });
const psPresent = (assignmentId) => async () => ({
  stdout: `4242 node --session-id ${assignmentId}\n`,
  complete: true,
});

function rowFor(result, assignmentId) {
  return result.assignments.find(
    (entry) => entry.assignment_id === assignmentId,
  );
}

async function childIdentity(pid) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const identity = processIdentity(pid);
    if (identity !== null) return identity;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`child ${pid} identity was never observable`);
}

function liveInspect(piIdentity) {
  return (pid) => {
    if (pid === LAUNCHER_IDENTITY.pid) {
      return { state: "alive", pid, started_at: LAUNCHER_IDENTITY.started_at };
    }
    if (pid === piIdentity.pid)
      return { state: "alive", pid, started_at: piIdentity.started_at };
    return { state: "dead", pid };
  };
}

test("assignment collection: complete absent UUID with dead launcher and Pi reaches exited-unrecorded read-only", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const record = await resolvedRecord(root, workspace);
  const recordPath = await persistRecord(workspace, record, {
    state: "live",
    launcher_identity: LAUNCHER_IDENTITY,
    pi_identity: AGENT_IDENTITY,
  });
  const before = {
    record: await fixtureSignature(recordPath),
    kit: await fixtureSignature(workspace.kit),
  };
  const result = await assignmentsModule.collectAssignments({
    storageRoot: root,
    probes: { inspect: deadInspect, psRun: psAbsent, tmuxRun: tmuxRunAbsent() },
  });
  const row = rowFor(result, ASSIGNMENT_ID);
  assert.ok(row, "the stored assignment must be collected");
  assert.equal(row.display, "exited-unrecorded");
  assert.equal(row.hasControl, false);
  assert.deepEqual(await fixtureSignature(recordPath), before.record);
  assert.deepEqual(await fixtureSignature(workspace.kit), before.kit);
});

test("assignment collection: incomplete or UUID-present final listings never produce exited-unrecorded", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const record = await resolvedRecord(root, workspace);
  await persistRecord(workspace, record, {
    state: "live",
    launcher_identity: LAUNCHER_IDENTITY,
    pi_identity: AGENT_IDENTITY,
  });
  const incomplete = await assignmentsModule.collectAssignments({
    storageRoot: root,
    probes: {
      inspect: deadInspect,
      psRun: psUnknown,
      tmuxRun: tmuxRunAbsent(),
    },
  });
  assert.equal(rowFor(incomplete, ASSIGNMENT_ID).display, "unknown");
  const orphan = await assignmentsModule.collectAssignments({
    storageRoot: root,
    probes: {
      inspect: deadInspect,
      psRun: psPresent(ASSIGNMENT_ID),
      tmuxRun: tmuxRunAbsent(),
    },
  });
  assert.equal(rowFor(orphan, ASSIGNMENT_ID).display, "unknown");
  assert.notEqual(rowFor(orphan, ASSIGNMENT_ID).display, "exited-unrecorded");
});

test("assignment collection: alive launcher with complete absence keeps launching while unknown launcher is unknown", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const record = await resolvedRecord(root, workspace);
  const overrides = {
    state: "launching",
    launcher_identity: LAUNCHER_IDENTITY,
    pi_identity: AGENT_IDENTITY,
  };
  await persistRecord(workspace, record, overrides);
  const alive = await assignmentsModule.collectAssignments({
    storageRoot: root,
    probes: {
      inspect: (pid) =>
        pid === LAUNCHER_IDENTITY.pid
          ? { state: "alive", pid, started_at: LAUNCHER_IDENTITY.started_at }
          : { state: "dead", pid },
      psRun: psAbsent,
      tmuxRun: tmuxRunAbsent(),
    },
  });
  assert.equal(rowFor(alive, ASSIGNMENT_ID).display, "launching");
  assert.equal(rowFor(alive, ASSIGNMENT_ID).nextAction, "Wait");

  await persistRecord(workspace, record, overrides);
  const unknownLauncher = await assignmentsModule.collectAssignments({
    storageRoot: root,
    probes: {
      inspect: (pid) =>
        pid === LAUNCHER_IDENTITY.pid
          ? { state: "unknown", pid, reason: "synthetic-unknown" }
          : { state: "dead", pid },
      psRun: psAbsent,
      tmuxRun: tmuxRunAbsent(),
    },
  });
  assert.equal(rowFor(unknownLauncher, ASSIGNMENT_ID).display, "unknown");
  assert.notEqual(
    rowFor(unknownLauncher, ASSIGNMENT_ID).display,
    "exited-unrecorded",
  );
});

test("assignment collection: unavailable Pi evidence under an alive launcher is unknown, never waiting", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const record = await resolvedRecord(root, workspace);
  await persistRecord(workspace, record, {
    state: "launching",
    launcher_identity: LAUNCHER_IDENTITY,
    pi_identity: AGENT_IDENTITY,
  });
  const result = await assignmentsModule.collectAssignments({
    storageRoot: root,
    probes: {
      inspect: (pid) =>
        pid === LAUNCHER_IDENTITY.pid
          ? { state: "alive", pid, started_at: LAUNCHER_IDENTITY.started_at }
          : { state: "unknown", pid, reason: "synthetic-unknown" },
      psRun: psAbsent,
      tmuxRun: tmuxRunAbsent(),
    },
  });
  const row = rowFor(result, ASSIGNMENT_ID);
  assert.equal(row.display, "unknown");
  assert.equal(row.nextAction, "Fix probe; no relaunch");
  assert.equal(row.coverage, "partial");
});

test("assignment collection: reused PID with complete absence reaches exited-unrecorded", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const record = await resolvedRecord(root, workspace);
  await persistRecord(workspace, record, {
    state: "live",
    launcher_identity: LAUNCHER_IDENTITY,
    pi_identity: AGENT_IDENTITY,
  });
  const result = await assignmentsModule.collectAssignments({
    storageRoot: root,
    probes: {
      inspect: (pid) =>
        pid === AGENT_IDENTITY.pid
          ? { state: "alive", pid, started_at: "Thu Jan  1 00:00:01 1970" }
          : { state: "dead", pid },
      psRun: psAbsent,
      tmuxRun: tmuxRunAbsent(),
    },
  });
  assert.equal(rowFor(result, ASSIGNMENT_ID).display, "exited-unrecorded");
});

test("assignment collection: malformed, symlink and oversize records stay unavailable beside a valid neighbor", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const record = await resolvedRecord(root, workspace);
  const recordPath = await persistRecord(workspace, record, { state: "live" });
  const assignmentsDir = join(workspace.directory, "assignments");
  await writeFile(join(assignmentsDir, "malformed.json"), "{not json");
  await symlink(recordPath, join(assignmentsDir, "linked.json"));
  await writeFile(
    join(assignmentsDir, "oversize.json"),
    Buffer.alloc(65537, 0x61),
  );
  const result = await assignmentsModule.collectAssignments({
    storageRoot: root,
  });
  assert.ok(
    rowFor(result, ASSIGNMENT_ID),
    "the valid neighbor must be retained",
  );
  assert.equal(result.coverage.state, "partial");
  const reasons = result.coverage.reasons.join("\n");
  assert.match(reasons, /assignment-malformed:.*malformed\.json/);
  assert.match(reasons, /assignment-unavailable:.*linked\.json:symlink/);
  assert.match(
    reasons,
    /assignment-unavailable:.*oversize\.json:oversize-file/,
  );
});

test("assignment collection: workspace directory mismatch collected from the physical directory", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const renamed = join(root, "projects", "renamed-collection");
  await rename(workspace.directory, renamed);
  const renamedWorkspace = {
    ...workspace,
    directory: renamed,
    kit: join(renamed, "kit.yaml"),
  };
  const record = await resolvedRecord(root, renamedWorkspace);
  await persistRecord(renamedWorkspace, record, { state: "live" });
  const result = await assignmentsModule.collectAssignments({
    storageRoot: root,
  });
  assert.ok(
    rowFor(result, ASSIGNMENT_ID),
    "a renamed workspace still collects its assignment",
  );
});

test("assignment collection: strict listAssignments and findAssignment still refuse malformed and duplicate records", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  await mkdir(join(workspace.directory, "assignments"), { recursive: false });
  await writeFile(
    join(workspace.directory, "assignments", "broken.json"),
    "{broken",
  );
  await assert.rejects(listAssignments(root));
  await assert.rejects(findAssignment(root, ASSIGNMENT_ID));

  const second = await createWorkspace(root, {
    id: "ws-duplicate",
    name: "Duplicate Workspace",
  });
  await mkdir(join(second.directory, "briefs"), { recursive: false });
  await writeFile(
    join(second.directory, "briefs", "brief.md"),
    "# Duplicate brief\n",
  );
  const record = await resolvedRecord(root, workspace);
  await persistRecord(workspace, record, { state: "live" });
  const secondRecord = await resolvedRecord(root, second);
  await persistRecord(second, secondRecord, { state: "live" });
  await rm(join(workspace.directory, "assignments", "broken.json"));
  await assert.rejects(listAssignments(root), /appears more than once/);
});

test("assignment collection: hard ceilings cannot be increased and only smaller limits are honored", async (t) => {
  const { root } = await collectionFixture(t);
  assert.throws(
    () => createCatalogReadBudget({ maxEntries: 401 }),
    /hard ceiling/,
  );
  assert.throws(
    () => createCatalogReadBudget({ maxRows: 0 }),
    /positive integer/,
  );
  await assert.rejects(
    assignmentsModule.collectAssignments({
      storageRoot: root,
      limits: { probeTimeoutMs: 2001 },
    }),
    /probeTimeoutMs/,
  );
  const budget = createCatalogReadBudget({
    maxEntries: 5,
    maxRows: 7,
    maxFileBytes: 9,
    maxTotalBytes: 11,
  });
  assert.equal(budget.maxEntries, 5);
  assert.equal(budget.maxRows, 7);
  assert.equal(budget.maxFileBytes, 9);
  assert.equal(budget.maxTotalBytes, 11);
});

test("assignment collection: default entry and row caps truncate with unknown omissions", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const record = await resolvedRecord(root, workspace);
  await persistRecord(workspace, record, { state: "live" });
  const assignmentsDir = join(workspace.directory, "assignments");
  for (let index = 0; index < 405; index += 1) {
    await writeFile(join(assignmentsDir, `junk-${index}.txt`), "x");
  }
  const entryCapped = await assignmentsModule.collectAssignments({
    storageRoot: root,
  });
  assert.equal(entryCapped.coverage.omitted, null);
  assert.ok(entryCapped.coverage.reasons.includes("entry-budget-exhausted"));

  const second = await collectionFixture(t);
  for (let index = 0; index < 101; index += 1) {
    const assignmentId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const rowRecord = await resolvedRecord(second.root, second.workspace, {
      assignment_id: assignmentId,
    });
    await persistRecord(second.workspace, rowRecord, { state: "live" });
  }
  const rowCapped = await assignmentsModule.collectAssignments({
    storageRoot: second.root,
  });
  assert.ok(rowCapped.assignments.length <= 100);
  assert.equal(rowCapped.coverage.omitted, null);
  assert.ok(rowCapped.coverage.reasons.includes("row-budget-exhausted"));
});

test("assignment collection: file-byte cap refuses oversized records and byte accounting matches real file lengths", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const record = await resolvedRecord(root, workspace);
  await persistRecord(workspace, record, { state: "live" });
  const assignmentsDir = join(workspace.directory, "assignments");
  await writeFile(
    join(assignmentsDir, "oversize.json"),
    Buffer.alloc(65537, 0x61),
  );
  const result = await assignmentsModule.collectAssignments({
    storageRoot: root,
  });
  assert.ok(
    result.coverage.reasons.some((reason) =>
      reason.includes("oversize.json:oversize-file"),
    ),
  );
  assert.equal(result.coverage.omitted, 0);

  const second = await collectionFixture(t);
  const sumRecord = await resolvedRecord(second.root, second.workspace);
  const sumPath = await persistRecord(second.workspace, sumRecord, {
    state: "live",
  });
  const expectedBytes =
    (await lstat(sumPath)).size + (await lstat(second.workspace.kit)).size;
  const summed = await assignmentsModule.collectAssignments({
    storageRoot: second.root,
  });
  assert.equal(summed.coverage.bytes_read, expectedBytes);
});

test("assignment collection: small entry, total-byte and file-byte limits bound real fixtures", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const record = await resolvedRecord(root, workspace);
  await persistRecord(workspace, record, { state: "live" });
  const secondRecord = await resolvedRecord(root, workspace, {
    assignment_id: OTHER_ID,
  });
  await persistRecord(workspace, secondRecord, { state: "live" });
  const assignmentsDir = join(workspace.directory, "assignments");
  for (let index = 0; index < 6; index += 1) {
    await writeFile(join(assignmentsDir, `bounded-${index}.txt`), "x");
  }

  // The real bounded listAssignments owns the entry cap and reports the
  // unknown omission directly on the shared budget.
  const entryBudget = createCatalogReadBudget({ maxEntries: 3 });
  await listAssignments(root, null, { budget: entryBudget });
  assert.ok(
    entryBudget.entries <= 3,
    `entries ${entryBudget.entries} must not exceed 3`,
  );
  assert.equal(entryBudget.omissions, "unknown");

  const entryCapped = await assignmentsModule.collectAssignments({
    storageRoot: root,
    limits: { maxEntries: 3 },
  });
  assert.equal(entryCapped.coverage.omitted, null);
  assert.ok(entryCapped.coverage.reasons.includes("entry-budget-exhausted"));

  const recordSize = (
    await lstat(join(assignmentsDir, `${ASSIGNMENT_ID}.json`))
  ).size;
  const kitSize = (await lstat(workspace.kit)).size;
  const totalCap = kitSize + recordSize + 10;
  const byteCapped = await assignmentsModule.collectAssignments({
    storageRoot: root,
    limits: { maxTotalBytes: totalCap },
  });
  assert.equal(byteCapped.coverage.omitted, null);
  assert.ok(byteCapped.coverage.bytes_read <= totalCap);
  assert.ok(byteCapped.coverage.bytes_read >= kitSize + recordSize);
  assert.ok(byteCapped.coverage.reasons.includes("byte-budget-exhausted"));

  const fileCapped = await assignmentsModule.collectAssignments({
    storageRoot: root,
    limits: { maxFileBytes: 10 },
  });
  assert.equal(fileCapped.coverage.state, "partial");
  assert.match(fileCapped.coverage.reasons.join("\n"), /oversize-file/);
});

test("assignment collection: duplicate full ids remove selected rows even beyond the row cap", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const firstRecord = await resolvedRecord(root, workspace);
  await persistRecord(workspace, firstRecord, { state: "live" });
  const second = await createWorkspace(root, {
    id: "ws-duplicate",
    name: "Duplicate Workspace",
  });
  await mkdir(join(second.directory, "briefs"), { recursive: false });
  await writeFile(
    join(second.directory, "briefs", "brief.md"),
    "# Duplicate brief\n",
  );
  const duplicateRecord = await resolvedRecord(root, second);
  await persistRecord(second, duplicateRecord, { state: "live" });
  const otherRecord = await resolvedRecord(root, second, {
    assignment_id: OTHER_ID,
  });
  await persistRecord(second, otherRecord, { state: "live" });
  const result = await assignmentsModule.collectAssignments({
    storageRoot: root,
    limits: { maxRows: 1 },
  });
  assert.ok(
    !result.assignments.some((row) => row.assignment_id === ASSIGNMENT_ID),
  );
  assert.ok(
    result.coverage.reasons.some((reason) =>
      reason.startsWith("assignment-duplicate:"),
    ),
  );
  assert.equal(result.coverage.omitted, null);
});

async function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolvePromise) =>
    child.once("exit", () => resolvePromise()),
  );
}

async function sessionFixture(t, mode = "readable") {
  const context = await collectionFixture(t);
  const record = await resolvedRecord(context.root, context.workspace);
  const sessionDir = join(
    context.workspace.directory,
    "sessions",
    record.assignment_id,
  );
  await mkdir(sessionDir, { recursive: true });
  const header = JSON.stringify({ type: "session", id: record.assignment_id });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  const baseName = `2026-10-11T00-00-00-000Z_${record.assignment_id}.jsonl`;
  const writeSession = async (name, content) => {
    const file = join(sessionDir, name);
    await writeFile(file, content);
    await utimes(file, old, old);
    return file;
  };
  if (mode === "readable") {
    await writeSession(baseName, `${header}\n`);
  } else if (mode === "malformed") {
    await writeSession(baseName, "not a session header\n");
  } else if (mode === "symlink") {
    const target = join(context.workspace.directory, "outside-session.jsonl");
    await writeFile(target, `${header}\n`);
    await symlink(target, join(sessionDir, baseName));
  } else if (mode === "multiple") {
    await writeSession(baseName, `${header}\n`);
    await writeSession(
      `2026-10-11T00-00-01-000Z_${record.assignment_id}.jsonl`,
      `${header}\n`,
    );
  } else if (mode === "oversized") {
    await writeSession(baseName, `${header}\n${"t".repeat(200 * 1024)}\n`);
  }
  return { ...context, record, sessionDir, baseName };
}

function sessionEvidence(piIdentity) {
  return {
    inspect: liveInspect(piIdentity),
    psRun: psPresent(ASSIGNMENT_ID),
    tmuxRun: tmuxRunPresent(ASSIGNMENT_ID, "%5", piIdentity.pid),
  };
}

// Focused: node --test --test-name-pattern='assignment collection: mismatched terminal PID' scripts/spec-observe/assignments.test.mjs
test("assignment collection: mismatched terminal PID cannot attach a still-live saved Pi", async (t) => {
  const context = await sessionFixture(t, "readable");
  await persistRecord(context.workspace, context.record, {
    state: "live",
    pane_id: "%5",
    launcher_identity: LAUNCHER_IDENTITY,
    pi_identity: AGENT_IDENTITY,
  });
  const result = await assignmentsModule.collectAssignments({
    storageRoot: context.root,
    probes: {
      ...sessionEvidence(AGENT_IDENTITY),
      tmuxRun: tmuxRunPresent(ASSIGNMENT_ID, "%5", AGENT_IDENTITY.pid + 1),
    },
  });
  const row = rowFor(result, ASSIGNMENT_ID);
  assert.equal(row.display, "unknown");
  assert.equal(row.nextAction, "Fix probe; no relaunch");
  assert.equal(row.coverage, "partial");
  assert.equal(result.coverage.state, "partial");
});

// Focused: node --test --test-name-pattern='assignment collection: unavailable assignments directory' scripts/spec-observe/assignments.test.mjs
test("assignment collection: unavailable assignments directory makes neighbor uniqueness unknown", async (t) => {
  for (const mode of [
    "absent",
    "symlink",
    "dangling",
    "not-directory",
    "lstat-error",
    "realpath-error",
    "opendir-error",
    "partial-walk",
  ]) {
    await t.test(mode, async (subtest) => {
      const context = await sessionFixture(subtest, "readable");
      await persistRecord(context.workspace, context.record, {
        state: "live",
        pane_id: "%5",
        launcher_identity: LAUNCHER_IDENTITY,
        pi_identity: AGENT_IDENTITY,
      });
      const second = await createWorkspace(context.root, {
        id: "ws-hidden",
        name: "Hidden",
      });
      const directory = join(second.directory, "assignments");
      if (mode === "symlink" || mode === "dangling") {
        await symlink(
          mode === "symlink"
            ? join(context.workspace.directory, "assignments")
            : join(second.directory, "missing"),
          directory,
        );
      } else if (mode === "not-directory") {
        await writeFile(directory, "not a directory");
      } else if (mode !== "absent") {
        await mkdir(directory);
      }
      const error = Object.assign(new Error("unavailable fixture directory"), {
        code: "EACCES",
      });
      const method = {
        "lstat-error": "lstat",
        "realpath-error": "realpath",
        "opendir-error": "opendir",
        "partial-walk": "opendir",
      }[mode];
      if (method) {
        const original = fs[method];
        subtest.mock.method(fs, method, async (path, ...args) => {
          if (path !== directory) return original(path, ...args);
          if (mode !== "partial-walk") throw error;
          let reads = 0;
          return {
            read: async () => {
              if (reads++ === 0) return { name: "known.txt" };
              throw error;
            },
            close: async () => {},
          };
        });
      }
      if (method === "opendir") {
        const original = fs.readdir;
        subtest.mock.method(fs, "readdir", async (path, ...args) => {
          if (path === directory) throw error;
          return original(path, ...args);
        });
      }
      const result = await assignmentsModule.collectAssignments({
        storageRoot: context.root,
        probes: sessionEvidence(AGENT_IDENTITY),
      });
      const row = rowFor(result, ASSIGNMENT_ID);
      assert.ok(row, "valid neighbor is retained");
      if (mode === "absent") {
        assert.equal(result.coverage.omitted, 0);
        assert.equal(row.display, "live");
        assert.equal(row.coverage, "complete");
      } else {
        assert.equal(result.coverage.omitted, null);
        assert.equal(row.display, "unknown");
        assert.equal(row.nextAction, "Fix probe; no relaunch");
        assert.equal(row.coverage, "partial");
        await assert.rejects(listAssignments(context.root));
        await assert.rejects(findAssignment(context.root, ASSIGNMENT_ID));
      }
    });
  }
});

test("assignment collection: quiet marks only positive live rows with old readable session metadata", async (t) => {
  const context = await sessionFixture(t, "readable");
  await persistRecord(context.workspace, context.record, {
    state: "live",
    pane_id: "%5",
    launcher_identity: LAUNCHER_IDENTITY,
    pi_identity: AGENT_IDENTITY,
  });
  const result = await assignmentsModule.collectAssignments({
    storageRoot: context.root,
    probes: sessionEvidence(AGENT_IDENTITY),
  });
  const row = rowFor(result, ASSIGNMENT_ID);
  assert.equal(row.display, "live");
  assert.equal(row.quiet, true);
  assert.equal(row.coverage, "complete");
});

// Focused: node --test --test-name-pattern='assignment collection: opt-in terminal attachment counts' scripts/spec-observe/assignments.test.mjs
test("assignment collection: opt-in terminal attachment counts reach attachedCount while record bytes stay unchanged", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const record = await resolvedRecord(root, workspace);
  const recordPath = await persistRecord(workspace, record, {
    state: "live",
    pane_id: "%5",
    launcher_identity: LAUNCHER_IDENTITY,
    pi_identity: AGENT_IDENTITY,
  });
  const before = await fixtureSignature(recordPath);
  const formats = [];
  const tmuxRunWithAttached = (field) => async (_socketPath, args) => {
    if (args[0] === "has-session") return okRun("");
    if (args[0] === "list-clients") return okRun("");
    if (args[0] === "show-options") return okRun(`${ASSIGNMENT_ID}\n`);
    if (args[0] === "display-message") {
      formats.push(args[4]);
      const suffix = field === undefined ? "" : ` ${field}`;
      return okRun(`%5 ${AGENT_IDENTITY.pid}${suffix}\n`);
    }
    return exitOne();
  };
  const cases = [
    ["0", 0],
    ["7", 7],
    [undefined, null],
    ["many", null],
  ];
  for (const [field, expected] of cases) {
    const result = await assignmentsModule.collectAssignments({
      storageRoot: root,
      probes: {
        inspect: liveInspect(AGENT_IDENTITY),
        psRun: psPresent(ASSIGNMENT_ID),
        tmuxRun: tmuxRunWithAttached(field),
      },
    });
    const row = rowFor(result, ASSIGNMENT_ID);
    assert.ok(row, `${field} must collect the stored assignment`);
    assert.equal(row.display, "live", `${field} must remain a live row`);
    assert.equal(row.attachedCount, expected, `${field} attached count`);
    assert.equal(row.hasControl, false);
  }
  assert.equal(formats.length, cases.length);
  for (const format of formats) {
    assert.equal(format, "#{pane_id} #{pane_pid} #{session_attached}");
  }
  assert.deepEqual(await fixtureSignature(recordPath), before);
});

// Focused: node --test --test-name-pattern='assignment collection: terminal records with a UUID process candidate' scripts/spec-observe/assignments.test.mjs
test("assignment collection: terminal records with a UUID process candidate are unknown, never history", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const endedRecord = await resolvedRecord(root, workspace);
  await persistRecord(workspace, endedRecord, {
    state: "ended",
    launcher_identity: LAUNCHER_IDENTITY,
    pi_identity: AGENT_IDENTITY,
  });
  const failedRecord = await resolvedRecord(root, workspace, {
    assignment_id: OTHER_ID,
  });
  await persistRecord(workspace, failedRecord, {
    state: "launch_failed",
    launcher_identity: LAUNCHER_IDENTITY,
    pi_identity: AGENT_IDENTITY,
  });
  const historyRecord = await resolvedRecord(root, workspace, {
    assignment_id: THIRD_ID,
  });
  await persistRecord(workspace, historyRecord, {
    state: "launch_failed",
    launcher_identity: LAUNCHER_IDENTITY,
    pi_identity: AGENT_IDENTITY,
  });
  const listing =
    [ASSIGNMENT_ID, OTHER_ID]
      .map((assignmentId) => `4242 node --session-id ${assignmentId}`)
      .join("\n") + "\n";
  const result = await assignmentsModule.collectAssignments({
    storageRoot: root,
    probes: {
      inspect: deadInspect,
      psRun: async () => ({ stdout: listing, complete: true }),
      tmuxRun: tmuxRunAbsent(),
    },
  });
  for (const [assignmentId, state] of [
    [ASSIGNMENT_ID, "ended"],
    [OTHER_ID, "launch_failed"],
  ]) {
    const row = rowFor(result, assignmentId);
    assert.ok(row, `terminal record ${assignmentId} must be collected`);
    assert.equal(row.recordedState, state);
    assert.equal(
      row.observedState,
      state,
      "classify keeps the persisted terminal state",
    );
    assert.equal(row.display, "unknown");
    assert.equal(row.nextAction, "Fix probe; no relaunch");
    assert.equal(row.safeAction, "Fix probe; no relaunch");
    assert.equal(row.unrecorded, false);
    assert.equal(row.coverage, "partial");
    assert.ok(row.coverageReasons.includes("record-process-mismatch"));
    assert.ok(
      row.attention.some((value) =>
        value.includes("process evidence was observed"),
      ),
    );
    assert.ok(
      row.attention.some((value) =>
        value.includes(
          "process listing shows a candidate for the assignment UUID",
        ),
      ),
    );
    assert.equal(row.hasControl, false);
  }
  const history = rowFor(result, THIRD_ID);
  assert.ok(history, "the no-candidate terminal neighbor must be collected");
  assert.equal(history.recordedState, "launch_failed");
  assert.equal(history.display, "launch-failed");
  assert.equal(history.nextAction, "History");
  assert.equal(history.unrecorded, false);
  assert.equal(history.coverage, "complete");
  assert.ok(!history.coverageReasons.includes("record-process-mismatch"));
  assert.equal(history.hasControl, false);
});

test("assignment collection: unreadable or ambiguous sessions keep live display but partial coverage", async (t) => {
  for (const mode of ["malformed", "symlink", "multiple"]) {
    const context = await sessionFixture(t, mode);
    await persistRecord(context.workspace, context.record, {
      state: "live",
      pane_id: "%5",
      launcher_identity: LAUNCHER_IDENTITY,
      pi_identity: AGENT_IDENTITY,
    });
    const result = await assignmentsModule.collectAssignments({
      storageRoot: context.root,
      probes: sessionEvidence(AGENT_IDENTITY),
    });
    const row = rowFor(result, ASSIGNMENT_ID);
    assert.equal(row.display, "live", `${mode} must keep positive liveness`);
    assert.equal(row.coverage, "partial", `${mode} must stay partial`);
    assert.ok(
      row.coverageReasons.includes("session-unavailable"),
      `${mode} must report the session gap`,
    );
  }
});

test("assignment collection: oversized transcripts allow a bounded header prefix and never mirror content", async (t) => {
  const context = await sessionFixture(t, "oversized");
  await persistRecord(context.workspace, context.record, {
    state: "live",
    pane_id: "%5",
    launcher_identity: LAUNCHER_IDENTITY,
    pi_identity: AGENT_IDENTITY,
  });
  const transcriptSize = (
    await lstat(join(context.sessionDir, context.baseName))
  ).size;
  const result = await assignmentsModule.collectAssignments({
    storageRoot: context.root,
    probes: sessionEvidence(AGENT_IDENTITY),
  });
  const row = rowFor(result, ASSIGNMENT_ID);
  assert.equal(row.display, "live");
  assert.equal(row.coverage, "complete");
  assert.ok(transcriptSize > 65536);
  assert.ok(result.coverage.bytes_read < transcriptSize);
  assert.ok(
    result.coverage.bytes_read <=
      (await lstat(context.workspace.kit)).size +
        (
          await lstat(
            join(
              context.workspace.directory,
              "assignments",
              `${ASSIGNMENT_ID}.json`,
            ),
          )
        ).size +
        65536,
  );
});

test("assignment collection: one shared deadline bounds a pending injected transport without a second call", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const first = await resolvedRecord(root, workspace);
  await persistRecord(workspace, first, { state: "live" });
  const second = await resolvedRecord(root, workspace, {
    assignment_id: OTHER_ID,
  });
  await persistRecord(workspace, second, { state: "live" });
  let calls = 0;
  const started = Date.now();
  const result = await assignmentsModule.collectAssignments({
    storageRoot: root,
    limits: { probeTimeoutMs: 30 },
    probes: {
      tmuxRun: () => {
        calls += 1;
        return new Promise(() => {});
      },
    },
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `collection returned in ${elapsed}ms`);
  assert.equal(calls, 1);
  assert.equal(result.assignments.length, 2);
  for (const row of result.assignments) assert.equal(row.display, "unknown");
  assert.ok(result.coverage.reasons.includes("probe-deadline-exceeded"));
});

test("assignment collection: a late-resolving boundary cannot start later probes or scans", async (t) => {
  const { root, workspace } = await collectionFixture(t);
  const record = await resolvedRecord(root, workspace);
  await persistRecord(workspace, record, { state: "live" });
  let release;
  const gate = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  let psCalls = 0;
  const result = await assignmentsModule.collectAssignments({
    storageRoot: root,
    limits: { probeTimeoutMs: 30 },
    probes: {
      tmuxRun: () =>
        gate.then(() => ({
          ok: false,
          code: 1,
          stdout: "",
          stderr: "late",
          message: "late",
        })),
      psRun: async () => {
        psCalls += 1;
        return { stdout: "", complete: true };
      },
    },
  });
  assert.equal(result.assignments[0].display, "unknown");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
  release();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
  assert.equal(
    psCalls,
    0,
    "no later probe may start after the shared deadline",
  );
});

test("assignment collection: real installed tmux composition for live, foreign tag, orphan, absence and unreachable states", async (t) => {
  const collectAssignments = assignmentsModule.collectAssignments;
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "adj6-collection-")),
  );
  await setupStorage(root);
  const workspace = await createWorkspace(root, {
    id: "ws-collection",
    name: "Collection Workspace",
  });
  await mkdir(join(workspace.directory, "briefs"), { recursive: false });
  await writeFile(
    join(workspace.directory, "briefs", "brief.md"),
    "# Collection brief\n",
  );
  const socketPath = join(root, "owned-tmux.sock");
  const record = await resolvedRecord(root, workspace, {
    tmux_socket: socketPath,
  });
  const keeperId = "99999999-9999-4999-8999-999999999999";
  const keeperSession = `adj-${keeperId.replace(/-/g, "").slice(0, 12)}`;
  const children = [];
  const spawnOwned = (args) => {
    const child = spawn(process.execPath, args, { stdio: "ignore" });
    children.push(child);
    return child;
  };
  const cleanup = async () => {
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }
    await Promise.all(children.map((child) => exited(child).catch(() => {})));
    try {
      execFileSync("tmux", ["-S", socketPath, "kill-server"], {
        stdio: "ignore",
      });
    } catch {
      /* no owned server */
    }
    await rm(root, { recursive: true, force: true });
  };
  t.after(cleanup);

  const launcher = spawnOwned([
    "-e",
    "setInterval(() => {}, 1000)",
    "--",
    "--session-id",
    record.assignment_id,
  ]);
  const launcherIdentity = await childIdentity(launcher.pid);

  const owned = await startSession({
    socketPath,
    sessionName: record.tmux_session,
    cwd: workspace.directory,
    piPath: process.execPath,
    piArgs: [
      "-e",
      "setInterval(() => {}, 1000)",
      "--",
      "--session-id",
      record.assignment_id,
    ],
    assignmentId: record.assignment_id,
  });
  await persistRecord(workspace, record, {
    state: "live",
    pane_id: owned.paneId,
    launcher_identity: launcherIdentity,
    pi_identity: owned.piIdentity,
  });

  const live = await collectAssignments({ storageRoot: root });
  assert.equal(rowFor(live, ASSIGNMENT_ID).display, "live");
  assert.notEqual(rowFor(live, ASSIGNMENT_ID).display, "exited-unrecorded");

  const foreignId = "11111111-1111-4111-8111-222222222222";
  execFileSync("tmux", [
    "-S",
    socketPath,
    "set-option",
    "-t",
    `=${record.tmux_session}:`,
    "@adjacent_assignment_id",
    foreignId,
  ]);
  const foreign = await collectAssignments({ storageRoot: root });
  assert.equal(rowFor(foreign, ASSIGNMENT_ID).display, "unknown");
  execFileSync("tmux", [
    "-S",
    socketPath,
    "set-option",
    "-t",
    `=${record.tmux_session}:`,
    "@adjacent_assignment_id",
    record.assignment_id,
  ]);
  const restored = await collectAssignments({ storageRoot: root });
  assert.equal(rowFor(restored, ASSIGNMENT_ID).display, "live");

  // Keep the owned server reachable while the recorded session is missing,
  // and observe an independent live process carrying the exact UUID argv.
  await startSession({
    socketPath,
    sessionName: keeperSession,
    cwd: workspace.directory,
    piPath: process.execPath,
    piArgs: ["-e", "setInterval(() => {}, 1000)"],
    assignmentId: keeperId,
  });
  execFileSync("tmux", [
    "-S",
    socketPath,
    "kill-session",
    "-t",
    `=${record.tmux_session}`,
  ]);
  const orphan = spawnOwned([
    "-e",
    "setInterval(() => {}, 1000)",
    "--",
    "--session-id",
    record.assignment_id,
  ]);
  const orphanIdentity = await childIdentity(orphan.pid);
  await persistRecord(workspace, record, {
    state: "live",
    pane_id: null,
    launcher_identity: launcherIdentity,
    pi_identity: orphanIdentity,
  });
  const terminalLost = await collectAssignments({ storageRoot: root });
  const orphanRow = rowFor(terminalLost, ASSIGNMENT_ID);
  assert.equal(orphanRow.display, "terminal-lost");
  assert.match(orphanRow.nextAction, /^Do not relaunch/);
  assert.equal(orphanRow.hasControl, false);

  // The default flattened ps cannot prove absence once the orphan and the
  // launcher exit: no exited-unrecorded without a complete listing.
  orphan.kill("SIGKILL");
  launcher.kill("SIGKILL");
  await exited(orphan);
  await exited(launcher);
  const defaultAfterExit = await collectAssignments({ storageRoot: root });
  assert.equal(rowFor(defaultAfterExit, ASSIGNMENT_ID).display, "unknown");
  assert.notEqual(
    rowFor(defaultAfterExit, ASSIGNMENT_ID).display,
    "exited-unrecorded",
  );

  const gone = await collectAssignments({
    storageRoot: root,
    probes: { psRun: psAbsent },
  });
  assert.equal(rowFor(gone, ASSIGNMENT_ID).display, "exited-unrecorded");

  execFileSync("tmux", ["-S", socketPath, "kill-server"], { stdio: "ignore" });
  const unreachable = await collectAssignments({ storageRoot: root });
  assert.equal(rowFor(unreachable, ASSIGNMENT_ID).display, "unknown");
  assert.notEqual(rowFor(unreachable, ASSIGNMENT_ID).display, "ended");
});

// node --test --test-name-pattern="launch error before" scripts/spec-observe/assignments.test.mjs
test("assignment projection shows the launch error before missing-identity diagnostics", () => {
  const error =
    "launch spawn failed: tmux start-session failed: invalid option: extended-keys-format";
  const row = project(
    makeRecord({
      state: "launch_unknown",
      attention: [
        "no Pi process identity was recorded",
        "terminal observation is unknown",
        error,
      ],
    }),
    makeClassification({ state: "launch_unknown", piIdentity: null }),
  );
  assert.equal(row.attention[0], error);
  assert.ok(row.attention.includes("terminal observation is unknown"));
  assert.notEqual(row.display, "live");
});

// node --test --test-name-pattern="recovered assignment" scripts/spec-observe/assignments.test.mjs
test("recovered assignment replaces stale startup warnings only with confirmed live evidence", () => {
  const notes = [
    "no Pi process identity was recorded; only complete UUID absence may prove gone",
    "terminal observation is unknown",
    "launch spawn failed: unsupported terminal option",
    "unrelated warning",
  ];
  const record = makeRecord({ attention: notes });
  const live = project(record, makeClassification());
  assert.equal(live.display, "live");
  assert.deepEqual(live.attention, [
    "Earlier launch attempt failed; session is now open: unsupported terminal option",
    "unrelated warning",
  ]);
  assert.deepEqual(
    record.attention,
    notes,
    "durable historical evidence is preserved",
  );
  const unknown = project(
    makeRecord({ state: "launch_unknown", attention: notes }),
    makeClassification({ state: "launch_unknown", piIdentity: null }),
  );
  assert.ok(
    unknown.attention.includes(notes[0]),
    "uncertainty never hides missing identity",
  );
});
