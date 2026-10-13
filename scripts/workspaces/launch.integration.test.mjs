// Step 4 foundation tests: root-scoped ownership and read-only assignment
// lookup.
//
// Every root is realpath(mkdtemp(tmpdir())) with a real `projects` catalog.
// Read-only listing/find paths must not create `.sentinel`, assignment or
// session paths; the claim path creates only the owned coordination directory
// and database. No real storage root, agent signaling or tmux action is
// touched.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, fork, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  acquireRootClaim,
  findAssignment,
  launchAssignment,
  listAssignments,
  locateAssignment,
  prepareAssignmentSpecTarget,
  resolveAssignment,
} from "./assignments.mjs";
import { newPackage } from "../spec-location/index.mjs";
import { collectAssignments } from "../spec-observe/assignments.mjs";
import { createDashboardServer } from "../spec-observe/dashboard.mjs";
import { writeFileAtomic } from "./store.mjs";
import { windowSize } from "./tmux.mjs";

const FIXTURE_PI = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "launch-fixture-pi.mjs");
const LAUNCH_WORKER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "launch-worker.mjs");

async function tempRoot(t) {
  // Short physical /tmp prefix keeps owned socket paths within the Unix-socket
  // length limit on Darwin.
  const root = await realpath(await mkdtemp(join("/tmp", "adj4-found-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function makeStorageRoot(t) {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await mkdir(join(storageRoot, "projects"), { recursive: true });
  return { root, storageRoot };
}

async function makeWorkspace(storageRoot, id) {
  const directory = join(storageRoot, "projects", id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "kit.yaml"),
    `version: 1\nid: ${JSON.stringify(id)}\nname: ${JSON.stringify(id)}\nrepositories: []\n`,
  );
  return directory;
}

async function treeSnapshot(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .map((entry) => `${entry.parentPath ?? ""}/${entry.name}:${entry.isDirectory() ? "dir" : "file"}`)
    .sort();
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function fakePi(directory) {
  await mkdir(directory, { recursive: true });
  const piPath = join(directory, "pi");
  await writeFile(piPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(piPath, 0o755);
  return realpath(piPath);
}

test("launch reservation: empty listing and missing lookup create nothing", async (t) => {
  const { storageRoot } = await makeStorageRoot(t);
  await makeWorkspace(storageRoot, "empty-workspace");
  const before = await treeSnapshot(storageRoot);

  assert.deepEqual(await listAssignments(storageRoot), []);
  await assert.rejects(
    findAssignment(storageRoot, randomUUID()),
    (error) => error.code === "ASSIGNMENT_MISSING",
  );
  assert.equal(await exists(join(storageRoot, ".sentinel")), false);
  assert.deepEqual(await treeSnapshot(storageRoot), before);
});

test("launch reservation: missing or invalid storage root refuses without creation", async (t) => {
  const { root, storageRoot } = await makeStorageRoot(t);

  const missing = join(root, "missing-root");
  await assert.rejects(listAssignments(missing), /not usable/);
  await assert.rejects(acquireRootClaim(missing), /not usable/);
  assert.equal(await exists(missing), false);

  const noProjects = join(root, "no-projects");
  await mkdir(noProjects);
  await assert.rejects(listAssignments(noProjects), /not usable/);
  await assert.rejects(acquireRootClaim(noProjects), /not usable/);
  assert.equal(await exists(join(noProjects, ".sentinel")), false);

  const fileRoot = join(root, "file-root");
  await writeFile(fileRoot, "not a directory\n");
  await assert.rejects(listAssignments(fileRoot), /not usable/);
  assert.equal(await readFile(fileRoot, "utf8"), "not a directory\n");
  assert.equal(await exists(join(storageRoot, ".sentinel")), false);
});

// Run alone: node --test --test-name-pattern='launch reservation: invalid session' scripts/workspaces/launch.integration.test.mjs
test("launch reservation: invalid session names leave the catalog and root unchanged", async (t) => {
  const { root, storageRoot } = await makeStorageRoot(t);
  const workspaceDirectory = await makeWorkspace(storageRoot, "invalid-session");
  await mkdir(join(workspaceDirectory, "briefs"));
  await writeFile(join(workspaceDirectory, "briefs", "brief.md"), "Brief.\n");
  const piPath = await fakePi(join(root, "bin"));
  const before = await treeSnapshot(storageRoot);
  for (const tmux_session of ["bad", "adj-ABCDEF123456", "adj-123456789abc:"]) {
    const input = {
      assignment_id: randomUUID(),
      workspace_id: "invalid-session",
      storageRoot,
      brief: "briefs/brief.md",
      skill: "general",
      instructions: "No launch.",
      pi_path: piPath,
      tmux_session,
    };
    await assert.rejects(resolveAssignment(input), /tmux_session/);
    await assert.rejects(
      launchAssignment(input, { expectedDigest: "0".repeat(64) }),
      /tmux_session/,
    );
    assert.deepEqual(await treeSnapshot(storageRoot), before);
    assert.deepEqual(await listAssignments(storageRoot), []);
  }
  assert.equal(await exists(join(storageRoot, ".sentinel")), false);
});

test("store preservation: root claim creates only the owned sentinel database", async (t) => {
  const { storageRoot } = await makeStorageRoot(t);
  const workspaceDirectory = await makeWorkspace(storageRoot, "claim-workspace");
  const beforeRoot = (await readdir(storageRoot)).sort();
  const beforeWorkspace = await treeSnapshot(workspaceDirectory);

  const claim = await acquireRootClaim(storageRoot);
  assert.equal(claim.key, "adjacent-launch");
  assert.equal(claim.pid, process.pid);
  assert.equal(typeof claim.token, "string");
  assert.ok(claim.token.length > 0);

  const sentinelInfo = await lstat(join(storageRoot, ".sentinel"));
  assert.equal(sentinelInfo.isDirectory(), true);
  assert.equal(sentinelInfo.isSymbolicLink(), false);
  assert.equal(sentinelInfo.mode & 0o777, 0o700);
  const databaseInfo = await lstat(join(storageRoot, ".sentinel", "coordination.sqlite"));
  assert.equal(databaseInfo.isFile(), true);
  assert.deepEqual(
    (await readdir(join(storageRoot, ".sentinel"))).sort(),
    ["coordination.sqlite"],
  );
  assert.deepEqual((await readdir(storageRoot)).sort(), [...beforeRoot, ".sentinel"].sort());
  assert.deepEqual(await treeSnapshot(workspaceDirectory), beforeWorkspace);

  claim.release();
  // A successor claim reuses the same root-derived database after release.
  const successor = await acquireRootClaim(storageRoot);
  assert.notEqual(successor.token, claim.token);
  successor.release();
  assert.deepEqual((await readdir(storageRoot)).sort(), [...beforeRoot, ".sentinel"].sort());
});

test("launch reservation: symlinked sentinel and override arguments refuse", async (t) => {
  const { root, storageRoot } = await makeStorageRoot(t);
  const target = join(root, "sentinel-target");
  await mkdir(target);
  await symlink(target, join(storageRoot, ".sentinel"));

  await assert.rejects(acquireRootClaim(storageRoot), /symlink/);
  assert.deepEqual(await readdir(target), []);

  // Override arguments cannot split the coordination domain for one root.
  const alternateDatabase = join(root, "alternate", "coordination.sqlite");
  await assert.rejects(
    acquireRootClaim(storageRoot, { database: alternateDatabase }),
    /does not accept overrides/,
  );
  await assert.rejects(
    acquireRootClaim(storageRoot, { agentDir: join(root, "agent-dir") }),
    /does not accept overrides/,
  );
  assert.equal(await exists(alternateDatabase), false);

  await rm(join(storageRoot, ".sentinel"));
  const claim = await acquireRootClaim(storageRoot);
  assert.deepEqual(
    (await readdir(join(storageRoot, ".sentinel"))).sort(),
    ["coordination.sqlite"],
  );
  claim.release();
});

test("store preservation: listing preserves a valid record and refuses malformed state", async (t) => {
  const { root, storageRoot } = await makeStorageRoot(t);
  const workspaceId = "record-workspace";
  const workspaceDirectory = await makeWorkspace(storageRoot, workspaceId);
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const piPath = await fakePi(join(root, "bin"));
  await mkdir(join(workspaceDirectory, "briefs"), { recursive: true });
  await writeFile(join(workspaceDirectory, "briefs", "brief.md"), "Foundation brief bytes.\n");

  const id = randomUUID();
  const resolved = await resolveAssignment({
    assignment_id: id,
    workspace_id: workspaceId,
    storageRoot,
    home,
    brief: "briefs/brief.md",
    skill: "general",
    instructions: "Foundation listing test.",
    publication_authority: "none",
    attempt_kind: "initial",
    pi_path: piPath,
  });
  const record = { ...resolved.record, state: "launching" };
  const assignmentsDirectory = join(workspaceDirectory, "assignments");
  await mkdir(assignmentsDirectory, { recursive: true });
  await writeFile(join(assignmentsDirectory, `${id}.json`), JSON.stringify(record));

  const listed = await listAssignments(storageRoot);
  assert.deepEqual(listed, [record]);
  assert.deepEqual(await listAssignments(storageRoot, workspaceId), [record]);
  assert.deepEqual(await listAssignments(storageRoot, "other-workspace"), []);
  assert.deepEqual(await findAssignment(storageRoot, id), record);
  assert.equal(await exists(join(storageRoot, ".sentinel")), false);

  // A malformed persisted record refuses the whole lookup instead of being
  // skipped, and no sibling lookup path repairs or removes it.
  const malformedDirectory = await makeWorkspace(storageRoot, "malformed-workspace");
  await mkdir(join(malformedDirectory, "assignments"), { recursive: true });
  const malformedPath = join(malformedDirectory, "assignments", `${randomUUID()}.json`);
  await writeFile(malformedPath, "{ not valid json\n");
  await assert.rejects(listAssignments(storageRoot), /malformed JSON/);
  assert.equal(await readFile(malformedPath, "utf8"), "{ not valid json\n");
});

// Step-4 lifecycle scenarios -------------------------------------------------

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function withTimeout(promise, label, ms = 10000) {
  return Promise.race([
    promise,
    new Promise((_resolve, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`timeout waiting for ${label}`)), ms);
      timer.unref?.();
    }),
  ]);
}

async function waitFor(predicate, label, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(50);
  }
}

function git(cwd, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", ...args],
      {
        cwd,
        timeout: 10000,
        killSignal: "SIGKILL",
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout, stderr) => {
        if (error) rejectPromise(new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`));
        else resolvePromise(stdout);
      },
    );
  });
}

async function makeRepo(parent, name) {
  const directory = join(parent, "repos", name);
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "--quiet"]);
  await git(directory, ["commit", "--allow-empty", "-m", "init"]);
  return realpath(directory);
}

async function workspaceWithRepo(storageRoot, id, repoPath) {
  const directory = join(storageRoot, "projects", id);
  await mkdir(directory, { recursive: true });
  const kit = [
    "version: 1",
    `id: ${JSON.stringify(id)}`,
    `name: ${JSON.stringify(id)}`,
    `execution_host: ${JSON.stringify(hostname().split(".")[0].toLowerCase())}`,
    "repositories:",
    '  - id: "app"',
    `    path: ${JSON.stringify(repoPath)}`,
    "",
  ].join("\n");
  await writeFile(join(directory, "kit.yaml"), kit);
  await mkdir(join(directory, "briefs"), { recursive: true });
  await writeFile(join(directory, "briefs", "brief.md"), "Integration brief bytes.\n");
  return directory;
}

async function fixturePi(root) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const piPath = join(bin, "pi");
  await writeFile(
    piPath,
    `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE_PI}" "$@"\n`,
    { mode: 0o755 },
  );
  await chmod(piPath, 0o755);
  return realpath(piPath);
}

function launchInput({
  id = randomUUID(),
  workspaceId,
  storageRoot,
  home,
  piPath,
  instructions = "Integration instructions.",
  supersedes = null,
  attempt = "initial",
  socket = null,
  specPackage = null,
}) {
  return {
    assignment_id: id,
    workspace_id: workspaceId,
    storageRoot,
    home,
    brief: "briefs/brief.md",
    skill: "general",
    instructions,
    target: "app",
    publication_authority: "none",
    attempt_kind: attempt,
    supersedes,
    pi_path: piPath,
    ...(socket === null ? {} : { tmux_socket: socket }),
    ...(specPackage === null ? {} : { specPackage }),
  };
}

function tmuxExec(socketPath, args) {
  return new Promise((resolvePromise) => {
    execFile(
      "tmux",
      ["-S", socketPath, ...args],
      { timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => resolvePromise({ ok: !error, stdout: stdout ?? "", stderr: stderr ?? "" }),
    );
  });
}

async function sessionNames(socketPath) {
  const result = await tmuxExec(socketPath, ["list-sessions", "-F", "#{session_name}"]);
  if (!result.ok) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

async function fixtureEntries(logPath) {
  try {
    const text = await readFile(logPath, "utf8");
    return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function argvSessionId(entry) {
  if (!entry || !Array.isArray(entry.argv)) return null;
  const index = entry.argv.indexOf("--session-id");
  return index === -1 ? null : entry.argv[index + 1] ?? null;
}

// Bounded readiness for the fixture's own log append: tmux session/process
// identity is ready before the fixture JS has run. On timeout the error names
// the owned socket, its current sessions and the log path.
async function waitForFixtureLog(logPath, socket, assignmentId) {
  try {
    return await waitFor(async () => {
      const entries = await fixtureEntries(logPath);
      return entries.find((entry) => argvSessionId(entry) === assignmentId) ?? null;
    }, `fixture log entry for assignment ${assignmentId}`);
  } catch (error) {
    const names = await sessionNames(socket);
    throw new Error(
      `${error.message}; socket=${socket} sessions=${JSON.stringify(names)} log=${logPath}`,
    );
  }
}

async function startWorker(root, payload, env = {}) {
  const payloadPath = join(root, `worker-${randomUUID()}.json`);
  await writeFile(payloadPath, JSON.stringify(payload));
  const child = fork(LAUNCH_WORKER, [payloadPath], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, ...env },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const waiters = new Map();
  const pending = new Map();
  // `done` settles only after the child actually exits, so dead-launcher
  // evidence is never raced by a merely delivered result payload.
  const done = new Promise((resolvePromise) => {
    let payloadMessage = null;
    let exit = null;
    let settled = false;
    const settle = () => {
      if (settled || exit === null) return;
      settled = true;
      if (payloadMessage === null) {
        resolvePromise({
          done: true,
          error: { message: `worker exited code=${exit.code} signal=${exit.signal}\n${stderr}` },
          exitCode: exit.code,
          signal: exit.signal,
        });
      } else {
        resolvePromise({ ...payloadMessage, stderr, exitCode: exit.code, signal: exit.signal });
      }
    };
    child.on("message", (message) => {
      if (message && message.marker !== undefined) {
        if (waiters.has(message.marker)) {
          const resolve = waiters.get(message.marker);
          waiters.delete(message.marker);
          resolve(message);
        } else {
          pending.set(message.marker, message);
        }
      }
      if (message && message.done === true) {
        payloadMessage = message;
        settle();
      }
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      settle();
    });
  });
  const worker = {
    child,
    done,
    waitForMarker(marker) {
      if (pending.has(marker)) {
        const value = pending.get(marker);
        pending.delete(marker);
        return Promise.resolve(value);
      }
      return new Promise((resolvePromise) => waiters.set(marker, resolvePromise));
    },
    resume() { child.send("resume"); },
    kill() { child.kill("SIGKILL"); },
  };
  const cleanup = scenarioCleanups.get(root);
  if (cleanup) cleanup.track(worker);
  return worker;
}

function seedOwnerRow(database, row) {
  const db = new DatabaseSync(database);
  try {
    db.prepare(
      "INSERT INTO owner_claims (key, pid, started_at, token) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at, token = excluded.token",
    ).run(row.key, row.pid, row.started_at, row.token);
  } finally {
    db.close();
  }
}

function readOwnerRow(database, key) {
  const db = new DatabaseSync(database);
  try {
    return db.prepare("SELECT pid, started_at, token FROM owner_claims WHERE key = ?").get(key);
  } finally {
    db.close();
  }
}

function deleteOwnerRow(database, key) {
  const db = new DatabaseSync(database);
  try {
    db.prepare("DELETE FROM owner_claims WHERE key = ?").run(key);
  } finally {
    db.close();
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function markerStatus(worker, marker, ms) {
  return Promise.race([
    worker.waitForMarker(marker).then(() => "marker"),
    delay(ms).then(() => "timeout"),
  ]);
}

const scenarioCleanups = new Map();

// One per-root cleanup routine: reap tracked test workers, let owned fixtures
// self-exit through the stop file, kill only the owned socket server and only
// then remove the temporary root. Registered as the single after hook for a
// scenario root so root removal can never run before server/fixture cleanup.
function createScenarioCleanup(t, root, socket, stopPath) {
  const workers = new Set();
  t.after(async () => {
    for (const worker of workers) {
      try { worker.kill(); } catch { /* already gone */ }
    }
    await Promise.allSettled([...workers].map((worker) => worker.done));
    try { await writeFile(stopPath, "stop\n"); } catch { /* noop */ }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const names = await sessionNames(socket);
      if (!names.some((name) => name.startsWith("adj-"))) break;
      await delay(100);
    }
    await tmuxExec(socket, ["kill-server"]);
    await rm(root, { recursive: true, force: true });
  });
  return {
    track(worker) {
      workers.add(worker);
      return worker;
    },
  };
}

async function launchScenario(t, workspaceCount) {
  const root = await realpath(await mkdtemp(join("/tmp", "adj4-runtime-")));
  const storageRoot = join(root, "storage");
  await mkdir(join(storageRoot, "projects"), { recursive: true });
  const workspaces = [];
  for (let index = 0; index < workspaceCount; index += 1) {
    const repo = await makeRepo(root, `repo-${index}`);
    workspaces.push(await workspaceWithRepo(storageRoot, `workspace-${index}`, repo));
  }
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const piPath = await fixturePi(root);
  const logPath = join(root, "fixture.jsonl");
  const stopPath = join(root, "fixture.stop");
  const socket = join(storageRoot, ".sentinel", "adjacent.sock");
  process.env.ADJ4_FIXTURE_LOG = logPath;
  process.env.ADJ4_FIXTURE_STOP = stopPath;
  const cleanup = createScenarioCleanup(t, root, socket, stopPath);
  scenarioCleanups.set(root, cleanup);
  t.after(() => scenarioCleanups.delete(root));
  return { root, storageRoot, home, piPath, logPath, stopPath, socket, workspaces };
}

test("launch reservation: concurrent cross-workspace callers admit exactly one live record", async (t) => {
  const { root, storageRoot, home, piPath, logPath, socket } = await launchScenario(t, 2);
  // Both workspaces must target the SAME physical checkout so the callers
  // share one canonical execution directory.
  await workspaceWithRepo(storageRoot, "workspace-1", join(root, "repos", "repo-0"));
  const inputA = launchInput({ workspaceId: "workspace-0", storageRoot, home, piPath });
  const inputB = launchInput({ workspaceId: "workspace-1", storageRoot, home, piPath });
  const previewA = await resolveAssignment(inputA);
  const previewB = await resolveAssignment(inputB);
  assert.equal(previewA.record.execution_dir, await realpath(join(root, "repos", "repo-0")));
  assert.equal(previewB.record.execution_dir, previewA.record.execution_dir);
  const digestA = previewA.contractDigest;
  const digestB = previewB.contractDigest;

  const workerA = await startWorker(root, { action: "launch", input: inputA, expectedDigest: digestA }, { ADJACENT_AGENT_DIR: join(root, "agent-a") });
  const workerB = await startWorker(root, { action: "launch", input: inputB, expectedDigest: digestB }, { ADJACENT_AGENT_DIR: join(root, "agent-b") });
  const [resultA, resultB] = await Promise.all([
    withTimeout(workerA.done, "worker A"),
    withTimeout(workerB.done, "worker B"),
  ]);
  const completed = [resultA, resultB].filter((result) => result.error === undefined);
  assert.equal(completed.length, 1, JSON.stringify([resultA.error, resultB.error]));

  const records = await listAssignments(storageRoot);
  assert.equal(records.length, 1);
  assert.equal(records[0].state, "live");
  await waitForFixtureLog(logPath, socket, records[0].assignment_id);
  assert.equal((await sessionNames(socket)).filter((name) => name.startsWith("adj-")).length, 1);
  assert.equal((await fixtureEntries(logPath)).length, 1);
  assert.equal(await exists(join(storageRoot, ".sentinel", "adjacent.sqlite")), false);
  await assert.rejects(
    resolveAssignment({
      ...inputA,
      assignment_id: randomUUID(),
      coordination_database: join(root, "other.sqlite"),
    }),
    /must not be supplied/,
  );
  assert.equal(await exists(join(root, "other.sqlite")), false);
});

test("launch reservation: bounded retry, release before spawn, and same-process refusal", async (t) => {
  const { root, storageRoot, home, piPath } = await launchScenario(t, 3);
  const inputLeft = launchInput({ workspaceId: "workspace-0", storageRoot, home, piPath });
  const inputRight = launchInput({ workspaceId: "workspace-1", storageRoot, home, piPath });
  const digestLeft = (await resolveAssignment(inputLeft)).contractDigest;
  const digestRight = (await resolveAssignment(inputRight)).contractDigest;

  const held = await acquireRootClaim(storageRoot);
  const left = await startWorker(root, { action: "launch", input: inputLeft, expectedDigest: digestLeft });
  const right = await startWorker(root, { action: "launch", input: inputRight, expectedDigest: digestRight });
  await delay(300);
  held.release();
  const [leftResult, rightResult] = await Promise.all([
    withTimeout(left.done, "left"),
    withTimeout(right.done, "right"),
  ]);
  assert.equal(leftResult.error, undefined, leftResult.error?.message);
  assert.equal(rightResult.error, undefined, rightResult.error?.message);

  // A second same-process claim refuses after the finite ~5 s deadline.
  const first = await acquireRootClaim(storageRoot);
  const started = Date.now();
  await assert.rejects(acquireRootClaim(storageRoot), (error) => error.name === "OwnerClaimError");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4000 && elapsed <= 9000, `elapsed=${elapsed}`);
  first.release();

  // The claim is released before tmux: pause a worker at the final command
  // seam and acquire the root claim while it waits outside tmux.
  const inputPause = launchInput({ workspaceId: "workspace-2", storageRoot, home, piPath });
  const digestPause = (await resolveAssignment(inputPause)).contractDigest;
  const paused = await startWorker(root, {
    action: "launch",
    input: inputPause,
    expectedDigest: digestPause,
    pauseMode: "before-create",
  });
  await withTimeout(paused.waitForMarker("before-create"), "pause marker");
  const probe = await acquireRootClaim(storageRoot);
  probe.release();
  paused.resume();
  const pausedResult = await withTimeout(paused.done, "paused launch");
  assert.equal(pausedResult.error, undefined, pausedResult.error?.message);
  assert.equal((await listAssignments(storageRoot)).length, 3);

  // A seeded dead holder is reclaimed by one worker and the row carries that
  // worker's token until release (adj2 row convention, no production stale
  // reclaim code).
  const database = join(storageRoot, ".sentinel", "coordination.sqlite");
  seedOwnerRow(database, {
    key: "adjacent-launch",
    pid: spawnSync(process.execPath, ["-e", ""]).pid,
    started_at: "dead-prior-start",
    token: "dead-prior-token",
  });
  const firstHolder = await startWorker(root, { action: "hold-claim", root: storageRoot });
  const holding = await withTimeout(firstHolder.waitForMarker("holding"), "first reclaim holding");
  assert.equal(readOwnerRow(database, "adjacent-launch").token, holding.token);

  // A second real holder cannot report holding until the first releases.
  const secondHolder = await startWorker(root, { action: "hold-claim", root: storageRoot });
  assert.equal(await markerStatus(secondHolder, "holding", 300), "timeout");
  firstHolder.resume();
  const firstDone = await withTimeout(firstHolder.done, "first holder release");
  assert.equal(firstDone.error, undefined, firstDone.error?.message);
  const secondHolding = await withTimeout(
    secondHolder.waitForMarker("holding"),
    "second reclaim holding",
  );
  assert.notEqual(secondHolding.token, holding.token);
  assert.equal(readOwnerRow(database, "adjacent-launch").token, secondHolding.token);
  secondHolder.resume();
  const secondDone = await withTimeout(secondHolder.done, "second holder release");
  assert.equal(secondDone.error, undefined, secondDone.error?.message);

  // A stale token-conditioned release leaves a synthetic successor row intact
  // (adj2 row convention, isolated database only).
  const staleLease = await acquireRootClaim(storageRoot);
  seedOwnerRow(database, {
    key: "adjacent-launch",
    pid: process.pid,
    started_at: "synthetic-successor-start",
    token: "synthetic-successor-token",
  });
  staleLease.release();
  assert.equal(readOwnerRow(database, "adjacent-launch").token, "synthetic-successor-token");
  deleteOwnerRow(database, "adjacent-launch");
});

test("crash recovery: durable reservation and locate recovery across the tmux seam", async (t) => {
  const { root, storageRoot, home, piPath, socket, logPath } = await launchScenario(t, 2);
  const beforeDir = join(storageRoot, "projects", "workspace-0");
  const beforeInput = launchInput({ workspaceId: "workspace-0", storageRoot, home, piPath });
  const beforeDigest = (await resolveAssignment(beforeInput)).contractDigest;
  const beforeWorker = await startWorker(root, {
    action: "launch",
    input: beforeInput,
    expectedDigest: beforeDigest,
    pauseMode: "before-create",
  });
  await withTimeout(beforeWorker.waitForMarker("before-create"), "before-create marker");
  const beforeRecord = await findAssignment(storageRoot, beforeInput.assignment_id);
  assert.equal(beforeRecord.state, "launching");
  const beforeRecordPath = join(beforeDir, "assignments", `${beforeInput.assignment_id}.json`);
  assert.ok(await exists(beforeRecordPath));
  const beforeRecordBytes = await readFile(beforeRecordPath);
  assert.ok(await exists(join(beforeDir, "assignments", `${beforeInput.assignment_id}.brief.md`)));
  assert.ok(await exists(join(beforeDir, "sessions", beforeInput.assignment_id)));
  const free = await acquireRootClaim(storageRoot);
  free.release();

  const competing = launchInput({ workspaceId: "workspace-0", storageRoot, home, piPath });
  const competingDigest = (await resolveAssignment(competing)).contractDigest;
  await assert.rejects(
    launchAssignment(competing, { expectedDigest: competingDigest }),
    (error) => {
      assert.match(error.message, /reserves/);
      assert.equal(error.code, "target-busy");
      assert.equal(error.assignment_id, beforeInput.assignment_id);
      assert.ok(error.message.includes(beforeInput.assignment_id));
      return true;
    },
  );
  assert.deepEqual(await readFile(beforeRecordPath), beforeRecordBytes);
  assert.equal(await exists(join(beforeDir, "assignments", `${competing.assignment_id}.json`)), false);

  beforeWorker.kill();
  await beforeWorker.done;
  const unknownRecord = await locateAssignment(storageRoot, beforeInput.assignment_id);
  assert.equal(unknownRecord.state, "launch_unknown");
  assert.equal((await sessionNames(socket)).filter((name) => name.startsWith("adj-")).length, 0);
  assert.equal((await fixtureEntries(logPath)).length, 0);

  const afterDir = join(storageRoot, "projects", "workspace-1");
  const afterInput = launchInput({ workspaceId: "workspace-1", storageRoot, home, piPath });
  const afterDigest = (await resolveAssignment(afterInput)).contractDigest;
  const afterWorker = await startWorker(root, {
    action: "launch",
    input: afterInput,
    expectedDigest: afterDigest,
    pauseMode: "after-create",
  });
  await withTimeout(afterWorker.waitForMarker("after-create"), "after-create marker");
  const afterRecord = await findAssignment(storageRoot, afterInput.assignment_id);
  assert.equal(afterRecord.state, "launching");
  const freeAfter = await acquireRootClaim(storageRoot);
  freeAfter.release();
  afterWorker.kill();
  await afterWorker.done;
  await waitFor(async () => {
    const entries = await fixtureEntries(logPath);
    if (entries.length < 1) return false;
    const files = await readdir(join(afterDir, "sessions", afterInput.assignment_id));
    return files.some((name) => name.endsWith(".jsonl"));
  }, "fixture header and log");
  const liveRecord = await locateAssignment(storageRoot, afterInput.assignment_id);
  assert.equal(liveRecord.state, "live");
  assert.match(liveRecord.pane_id, /^%\d+$/);
  assert.ok(liveRecord.pi_identity !== null && liveRecord.pi_identity.pid > 0);
  assert.ok(liveRecord.pi_session_file.endsWith(`${afterInput.assignment_id}.jsonl`));
  assert.equal((await fixtureEntries(logPath)).length, 1);
});

test("repeat and retry: approval boundaries and snapshot stability", async (t) => {
  const { root, storageRoot, home, piPath, socket, logPath, workspaces } = await launchScenario(t, 1);
  const workspaceDirectory = workspaces[0];
  const input = {
    ...launchInput({
      id: "ABCDEF12-3456-4789-ABCD-EF1234567890",
      workspaceId: "workspace-0", storageRoot, home, piPath,
    }),
    provider: "openai",
    model: "gpt-5",
    thinking: "high",
    project_trust: "approve",
  };
  const preview = await resolveAssignment(input);
  const approvedBytes = Buffer.from(preview.briefBytes);
  const adjacentPath = join(workspaceDirectory, ".adjacent");
  const adjacentBytes = Buffer.concat([
    Buffer.from("SQLite format 3\0", "utf8"),
    Buffer.from([0, 1, 2, 3, 4, 5]),
  ]);
  await writeFile(adjacentPath, adjacentBytes);
  await writeFile(join(workspaceDirectory, "briefs", "brief.md"), "Edited after preview.\n");

  await assert.rejects(launchAssignment(input, { resolved: preview }), /expectedDigest is required/);
  await assert.rejects(
    launchAssignment(input, { resolved: preview, expectedDigest: "0".repeat(64) }),
    /does not match/,
  );
  await assert.rejects(
    launchAssignment(input, { resolved: { ...preview }, expectedDigest: preview.contractDigest }),
    /exact result/,
  );
  const tamperedRecord = { ...preview, record: { ...preview.record, state: "live" } };
  await assert.rejects(
    launchAssignment(input, { resolved: tamperedRecord, expectedDigest: preview.contractDigest }),
    /exact result|altered after generation/,
  );
  preview.record.state = "launching";
  await assert.rejects(
    launchAssignment(input, { resolved: preview, expectedDigest: preview.contractDigest }),
    /altered after generation/,
  );
  preview.record.state = "preview";
  const originalPiArgs = [...preview.piArgs];
  preview.piArgs = [...preview.piArgs, "tampered"];
  await assert.rejects(
    launchAssignment(input, { resolved: preview, expectedDigest: preview.contractDigest }),
    /altered after generation/,
  );
  preview.piArgs = originalPiArgs;
  const originalBriefBytes = preview.briefBytes;
  preview.briefBytes = Buffer.from("tampered approved bytes", "utf8");
  await assert.rejects(
    launchAssignment(input, { resolved: preview, expectedDigest: preview.contractDigest }),
    /altered after generation/,
  );
  preview.briefBytes = originalBriefBytes;

  const launched = await launchAssignment(input, { resolved: preview, expectedDigest: preview.contractDigest });
  assert.equal(launched.state, "live");
  assert.equal(launched.tmux_session, "adj-abcdef123456");
  assert.deepEqual(await listAssignments(storageRoot), [launched]);
  const snapshotPath = join(workspaceDirectory, "assignments", `${input.assignment_id}.brief.md`);
  assert.deepEqual(await readFile(snapshotPath), approvedBytes);
  await waitForFixtureLog(logPath, socket, input.assignment_id);
  const entries = await fixtureEntries(logPath);
  assert.equal(entries.length, 1);
  const executionDirectory = await realpath(join(root, "repos", "repo-0"));
  assert.equal(entries[0].cwd, executionDirectory);
  // Independent contract oracle: do not derive expectations from preview.piArgs.
  assert.deepEqual(entries[0].argv, [
    "--session-dir", join(workspaceDirectory, "sessions", input.assignment_id),
    "--session-id", "ABCDEF12-3456-4789-ABCD-EF1234567890",
    "--name", "workspace-0:workspace-0",
    "--provider", "openai", "--model", "gpt-5",
    "--thinking", "high", "--approve",
    `@${snapshotPath}`,
    [
      "Assignment context",
      `- Assignment: ${input.assignment_id}. Its record is ${workspaceDirectory}/assignments/${input.assignment_id}.json; read it again if you lose earlier context.`,
      `- Workspace: workspace-0 (workspace-0) at ${workspaceDirectory}. Workspace storage holds the kit, briefs, spec packages and sessions; code changes belong in the working directory.`,
      `- Working directory: ${executionDirectory} (repository app checkout).`,
      "- Spec package: none.",
      `- Brief: ${workspaceDirectory}/briefs/brief.md. The launch copy is attached above (${snapshotPath}); edit the source, not the copy.`,
      "- Publication authority: none. This launch grants no push or pull request. Merge and deployment are allowed only when the request grants them.",
      "",
      "Request",
      "Perform this request:",
      "",
      "Integration instructions.",
    ].join("\n"),
  ]);
  assert.equal(entries[0].snapshotSha256, sha256Hex(approvedBytes));
  assert.deepEqual(await readFile(adjacentPath), adjacentBytes);
  assert.equal((await sessionNames(socket)).filter((name) => name.startsWith("adj-")).length, 1);

  const repeated = await launchAssignment(input, { resolved: preview, expectedDigest: preview.contractDigest });
  assert.deepEqual(repeated, await findAssignment(storageRoot, input.assignment_id));
  assert.equal((await fixtureEntries(logPath)).length, 1);
  assert.equal((await sessionNames(socket)).filter((name) => name.startsWith("adj-")).length, 1);

  const changedInput = { ...input, instructions: "Different instructions." };
  const changedDigest = (await resolveAssignment(changedInput)).contractDigest;
  assert.notEqual(changedDigest, preview.contractDigest);
  await assert.rejects(
    launchAssignment(changedInput, { expectedDigest: changedDigest }),
    /different effective contract/,
  );

  // The same UUID with a changed explicit absolute socket also refuses.
  const otherSocket = join(storageRoot, "sockets", "other.sock");
  const socketChanged = await resolveAssignment({ ...input, tmux_socket: otherSocket });
  assert.notEqual(socketChanged.contractDigest, preview.contractDigest);
  await assert.rejects(
    launchAssignment(
      { ...input, tmux_socket: otherSocket },
      { expectedDigest: socketChanged.contractDigest },
    ),
    /different effective contract/,
  );

  const recordPath = join(workspaceDirectory, "assignments", `${input.assignment_id}.json`);
  const ended = { ...(await findAssignment(storageRoot, input.assignment_id)), state: "ended" };
  await writeFileAtomic(recordPath, JSON.stringify(ended));
  const endedRepeat = await launchAssignment(input, { resolved: preview, expectedDigest: preview.contractDigest });
  assert.equal(endedRepeat.state, "ended");
  assert.deepEqual(endedRepeat, ended);
  assert.equal((await fixtureEntries(logPath)).length, 1);
});

test("repeat and retry: confirmed gone supersession", async (t) => {
  const { root, storageRoot, home, piPath, socket, logPath, stopPath } = await launchScenario(t, 1);
  const oldInput = launchInput({ workspaceId: "workspace-0", storageRoot, home, piPath });
  const oldDigest = (await resolveAssignment(oldInput)).contractDigest;
  // Create the owned sentinel before touching tmux on the owned socket.
  const sentinelClaim = await acquireRootClaim(storageRoot);
  sentinelClaim.release();
  const keepalive = await tmuxExec(socket, [
    "start-server", ";",
    "new-session", "-d", "-s", "keepalive", "--", "/bin/sleep", "300",
  ]);
  assert.equal(keepalive.ok, true, keepalive.stderr);

  const launcher = await startWorker(root, { action: "launch", input: oldInput, expectedDigest: oldDigest });
  const launched = await withTimeout(launcher.done, "child launcher");
  assert.equal(launched.error, undefined, launched.error?.message);
  await waitForFixtureLog(logPath, socket, oldInput.assignment_id);

  const retryInput = launchInput({
    workspaceId: "workspace-0",
    storageRoot,
    home,
    piPath,
    attempt: "launch-retry",
    supersedes: oldInput.assignment_id,
  });
  const retryDigest = (await resolveAssignment(retryInput)).contractDigest;

  await assert.rejects(launchAssignment(retryInput, { expectedDigest: retryDigest }), /confirmed gone/);
  await assert.rejects(
    launchAssignment(retryInput, {
      expectedDigest: retryDigest,
      adapters: {
        observationProbes: {
          inspect: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
        },
      },
    }),
    /confirmed gone/,
  );
  // A reachable server that confirms terminal absence still refuses while the
  // real shared inspector observes the original Pi process alive.
  await assert.rejects(
    launchAssignment(retryInput, {
      expectedDigest: retryDigest,
      adapters: {
        observationProbes: {
          tmuxRun: async (_socketPath, args) => {
            if (args[0] === "has-session") {
              return { ok: false, code: 1, stdout: "", stderr: "no session", message: "no session" };
            }
            if (args[0] === "list-clients") {
              return { ok: true, code: 0, stdout: "", stderr: "" };
            }
            return { ok: false, code: 1, stdout: "", stderr: "unexpected", message: "unexpected" };
          },
        },
      },
    }),
    /confirmed gone/,
  );
  await assert.rejects(
    launchAssignment(retryInput, {
      expectedDigest: retryDigest,
      adapters: {
        observationProbes: {
          tmuxRun: async () => ({ ok: false, code: 1, stdout: "", stderr: "no server" }),
        },
      },
    }),
    /confirmed gone/,
  );

  await writeFile(stopPath, "stop\n");
  await waitFor(async () => {
    const names = await sessionNames(socket);
    return !names.some((name) => name.startsWith("adj-"));
  }, "pi session exit");
  await rm(stopPath, { force: true });

  const relaunched = await launchAssignment(retryInput, { expectedDigest: retryDigest });
  assert.equal(relaunched.state, "live");
  const oldRecord = await findAssignment(storageRoot, oldInput.assignment_id);
  assert.ok(["ended", "launch_failed"].includes(oldRecord.state));
  await waitForFixtureLog(logPath, socket, retryInput.assignment_id);
  assert.equal((await sessionNames(socket)).filter((name) => name.startsWith("adj-")).length, 1);
  assert.equal((await fixtureEntries(logPath)).length, 2);

  const oldRepeat = await launchAssignment(oldInput, { expectedDigest: oldDigest });
  assert.equal(oldRepeat.assignment_id, oldInput.assignment_id);
  assert.equal((await fixtureEntries(logPath)).length, 2);
});

test("store preservation: bytes, lease refusal, scan refusals and late ownership", async (t) => {
  const { root, storageRoot, home, piPath, logPath, socket, workspaces } = await launchScenario(t, 2);
  const workspaceA = workspaces[0];
  const workspaceB = workspaces[1];
  const repo = await realpath(join(root, "repos", "repo-0"));
  const notesPath = join(workspaceA, "notes.txt");
  await writeFile(notesPath, "notes bytes\n");

  const input = launchInput({ workspaceId: "workspace-0", storageRoot, home, piPath });
  const preview = await resolveAssignment(input);
  const storedRecord = { ...preview.record, state: "ended" };
  const assignmentsA = join(workspaceA, "assignments");
  await mkdir(assignmentsA, { recursive: true });
  const recordPath = join(assignmentsA, `${input.assignment_id}.json`);
  await writeFile(recordPath, JSON.stringify(storedRecord));
  const kitBefore = await readFile(join(workspaceA, "kit.yaml"));
  const briefBefore = await readFile(join(workspaceA, "briefs", "brief.md"));

  await listAssignments(storageRoot);
  await findAssignment(storageRoot, input.assignment_id);

  // A spec package whose run has a live coordinator refuses launch without
  // touching the run record.
  const created = await newPackage({
    workspace: "workspace-0", slug: "fixture", targets: [{ id: "app" }], root: storageRoot,
  });
  assert.equal(created.ok, true);
  const packageDirectory = created.locations.package_dir;
  await mkdir(join(packageDirectory, "runtime"), { recursive: true });
  const runPath = join(packageDirectory, "runtime", "run.json");
  await writeFile(runPath, JSON.stringify({ id: "run-fixture", state: "running", coordinator_pid: process.pid }));
  const runBytes = await readFile(runPath);
  const packaged = launchInput({
    workspaceId: "workspace-0",
    storageRoot,
    home,
    piPath,
    specPackage: packageDirectory,
  });
  const packagedDigest = (await resolveAssignment(packaged)).contractDigest;
  await assert.rejects(
    launchAssignment(packaged, { expectedDigest: packagedDigest }),
    (error) => {
      assert.match(error.message, /run-active/);
      assert.equal(error.code, "run-active");
      assert.equal(error.run_id, "run-fixture");
      assert.ok(error.message.includes("run-fixture"));
      return true;
    },
  );
  assert.deepEqual(await readFile(runPath), runBytes);
  assert.equal(await exists(join(assignmentsA, `${packaged.assignment_id}.json`)), false);
  await rm(runPath, { force: true });

  // Duplicate UUID across owning workspace dirs refuses the global scan.
  const duplicate = {
    ...storedRecord,
    workspace_id: "workspace-1",
    workspace_directory: workspaceB,
    brief_snapshot: join(workspaceB, "assignments", `${input.assignment_id}.brief.md`),
    pi_session_dir: join(workspaceB, "sessions", input.assignment_id),
  };
  const assignmentsB = join(workspaceB, "assignments");
  await mkdir(assignmentsB, { recursive: true });
  const duplicatePath = join(assignmentsB, `${input.assignment_id}.json`);
  await writeFile(duplicatePath, JSON.stringify(duplicate));
  await assert.rejects(listAssignments(storageRoot), (error) => error.code === "ASSIGNMENT_AMBIGUOUS");
  assert.deepEqual(await readFile(duplicatePath), Buffer.from(JSON.stringify(duplicate)));
  await rm(duplicatePath);

  // Malformed, symlinked and wrong-schema records refuse the scan unchanged.
  const malformedPath = join(assignmentsA, `${randomUUID()}.json`);
  await writeFile(malformedPath, "{ broken\n");
  await assert.rejects(listAssignments(storageRoot), /malformed JSON/);
  assert.equal(await readFile(malformedPath, "utf8"), "{ broken\n");
  await rm(malformedPath);
  const symlinkPath = join(assignmentsA, `${randomUUID()}.json`);
  await symlink(notesPath, symlinkPath);
  await assert.rejects(listAssignments(storageRoot), /not a regular file/);
  await rm(symlinkPath);
  const schemaPath = join(assignmentsA, `${randomUUID()}.json`);
  await writeFile(schemaPath, JSON.stringify({ ...storedRecord, assignment_id: "", schema_version: 2 }));
  await assert.rejects(listAssignments(storageRoot), /UUID|schema_version/);
  await rm(schemaPath);

  // Preexisting snapshot and session directory collisions refuse and keep
  // their original bytes.
  const collision = launchInput({ workspaceId: "workspace-0", storageRoot, home, piPath });
  const collisionSnapshot = join(assignmentsA, `${collision.assignment_id}.brief.md`);
  await writeFile(collisionSnapshot, "original snapshot bytes\n");
  const collisionDigest = (await resolveAssignment(collision)).contractDigest;
  await assert.rejects(launchAssignment(collision, { expectedDigest: collisionDigest }), /already exists/);
  assert.equal(await readFile(collisionSnapshot, "utf8"), "original snapshot bytes\n");
  const sessionCollision = launchInput({ workspaceId: "workspace-0", storageRoot, home, piPath });
  const sessionDir = join(workspaceA, "sessions", sessionCollision.assignment_id);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "keep.txt"), "keep session bytes\n");
  const sessionDigest = (await resolveAssignment(sessionCollision)).contractDigest;
  await assert.rejects(launchAssignment(sessionCollision, { expectedDigest: sessionDigest }), /already exists/);
  assert.equal(await readFile(join(sessionDir, "keep.txt"), "utf8"), "keep session bytes\n");

  // A late update whose launch token changed refuses and leaves the successor
  // record unchanged.
  const late = launchInput({ workspaceId: "workspace-1", storageRoot, home, piPath });
  const lateDigest = (await resolveAssignment(late)).contractDigest;
  const lateWorker = await startWorker(root, {
    action: "launch",
    input: late,
    expectedDigest: lateDigest,
    pauseMode: "after-create",
  });
  await withTimeout(lateWorker.waitForMarker("after-create"), "late token marker");
  const replacement = randomUUID();
  const currentLate = await findAssignment(storageRoot, late.assignment_id);
  const successor = { ...currentLate, launch_token: replacement };
  const lateRecordPath = join(assignmentsB, `${late.assignment_id}.json`);
  const replacementClaim = await acquireRootClaim(storageRoot);
  await writeFileAtomic(lateRecordPath, JSON.stringify(successor));
  replacementClaim.release();
  lateWorker.resume();
  const lateResult = await withTimeout(lateWorker.done, "late worker");
  assert.notEqual(lateResult.error, undefined);
  assert.match(lateResult.error.message, /ownership changed/);
  assert.equal(await readFile(lateRecordPath, "utf8"), JSON.stringify(successor));

  await locateAssignment(storageRoot, input.assignment_id, {
    adapters: {
      tmuxRun: async () => ({ ok: false, code: 1, stdout: "", stderr: "no server" }),
    },
  });
  assert.deepEqual(await readFile(join(workspaceA, "kit.yaml")), kitBefore);
  assert.deepEqual(await readFile(join(workspaceA, "briefs", "brief.md")), briefBefore);
  assert.equal(await readFile(notesPath, "utf8"), "notes bytes\n");
  assert.equal(await exists(join(storageRoot, ".sentinel", "adjacent.sqlite")), false);
  await waitForFixtureLog(logPath, socket, late.assignment_id);
  assert.equal((await fixtureEntries(logPath)).length, 1);
});

// node --test --test-name-pattern='failed spawn from a live host' scripts/workspaces/launch.integration.test.mjs
test('launch reservation: failed spawn from a live host is unknown, not still launching', async t => {
  const { root, storageRoot } = await makeStorageRoot(t);
  const workspace = await makeWorkspace(storageRoot, 'failed-spawn');
  await mkdir(join(workspace, 'briefs'));
  await writeFile(join(workspace, 'briefs/brief.md'), 'Plan settings.');
  const input = {assignment_id:randomUUID(),workspace_id:'failed-spawn',storageRoot,brief:'briefs/brief.md',instructions:'Plan settings.',pi_path:await fakePi(join(root,'bin'))};
  const resolved = await resolveAssignment(input);
  const record = await launchAssignment(input, {expectedDigest:resolved.contractDigest, resolved, adapters:{
    tmuxRun:async()=>({ok:false,code:1,stdout:'',stderr:'invalid option: extended-keys-format'}),
    observationProbes:{tmuxRun:async()=>({ok:false,code:1,stdout:'',stderr:'no server running'}),psRun:()=>({stdout:'',complete:false})},
  }});
  assert.equal(record.state, 'launch_unknown');
  assert.match(record.attention[0], /launch spawn failed:.*extended-keys-format/);
  assert.equal((await findAssignment(storageRoot,input.assignment_id)).state,'launch_unknown');
  const failedRecordPath = join(workspace, 'assignments', `${input.assignment_id}.json`);
  const failedRecordBytes = await readFile(failedRecordPath);
  const competitor = {...input,assignment_id:randomUUID()};
  const preview = await resolveAssignment(competitor);
  await assert.rejects(
    launchAssignment(competitor, {expectedDigest:preview.contractDigest}),
    (error) => {
      assert.match(error.message, /reserves/);
      assert.equal(error.code, 'target-busy');
      assert.equal(error.assignment_id, input.assignment_id);
      assert.ok(error.message.includes(input.assignment_id));
      return true;
    },
  );
  assert.deepEqual(await readFile(failedRecordPath), failedRecordBytes);
  assert.equal(await exists(join(workspace, 'assignments', `${competitor.assignment_id}.json`)), false);
});

// node --test --test-name-pattern='session controls end only' scripts/workspaces/launch.integration.test.mjs
test('session controls end only the confirmed assignment and preserve saved evidence',async t=>{
  const {createSessionControl,verifyTerminal}=await import('./session-control.mjs');
  const {probeSession}=await import('./tmux.mjs');
  const {storageRoot,home,piPath,logPath,socket}=await launchScenario(t,2);
  const records=[];
  for(let i=0;i<2;i++){
    const input=launchInput({workspaceId:`workspace-${i}`,storageRoot,home,piPath});
    const resolved=await resolveAssignment(input);
    records.push(await launchAssignment(input,{resolved,expectedDigest:resolved.contractDigest}));
  }
  await waitForFixtureLog(logPath,socket,records[0].assignment_id);
  const located=await locateAssignment(storageRoot,records[0].assignment_id);
  assert.ok(located.pi_session_file);
  const {appendFile}=await import('node:fs/promises');
  const {collectAssignments}=await import('../spec-observe/assignments.mjs');
  await appendFile(located.pi_session_file,JSON.stringify({type:'message',timestamp:new Date().toISOString(),message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Architecture proposal complete.'}]}})+'\n');
  let observed=await collectAssignments({storageRoot});
  assert.equal(observed.assignments.find(a=>a.assignment_id===located.assignment_id).task_activity.state,'idle');
  await appendFile(located.pi_session_file,JSON.stringify({type:'message',timestamp:new Date().toISOString(),message:{role:'user',content:[{type:'text',text:'Continue.'}]}})+'\n');
  observed=await collectAssignments({storageRoot});
  assert.equal(observed.assignments.find(a=>a.assignment_id===located.assignment_id).task_activity.state,'working');
  const service=createSessionControl({storageRoot,publicHost:'host.example'});
  const preview=await service.describe(records[0].assignment_id);
  assert.equal(preview.can_end,true);
  assert.match(preview.attach_command,/ssh/);assert.match(preview.attach_command,/host.example/);
  assert.ok(preview.attach_command.includes(records[0].tmux_session));
  // A mismatched saved pane or PID describes as unverifiable, with no control
  // or attach command, and verification never rewrites durable bytes.
  const assignmentPath=join(records[0].workspace_directory,'assignments',`${records[0].assignment_id}.json`);
  const originalBytes=await readFile(assignmentPath);
  for(const mismatched of [
    {...records[0],pane_id:'%999999'},
    {...records[0],pi_identity:{...records[0].pi_identity,pid:records[1].pi_identity.pid}},
  ]){
    await writeFile(assignmentPath,JSON.stringify(mismatched));
    const bytesBefore=await readFile(assignmentPath);
    const verdict=await verifyTerminal(mismatched);
    assert.equal(verdict.exact,false);
    assert.equal(verdict.ended,false);
    const mismatchedPreview=await service.describe(records[0].assignment_id);
    assert.equal(mismatchedPreview.can_end,false);
    assert.equal(mismatchedPreview.local_command,null);
    assert.equal(mismatchedPreview.attach_command,null);
    assert.equal(mismatchedPreview.state,'unknown');
    assert.equal(mismatchedPreview.identity,verdict.identity);
    assert.deepEqual(await readFile(assignmentPath),bytesBefore,'terminal verification must not mutate the durable assignment record');
  }
  await writeFile(assignmentPath,originalBytes);
  await assert.rejects(service.end({assignment_id:records[0].assignment_id,expected_identity:'stale',confirm:true}),/changed/);
  await assert.rejects(service.end({assignment_id:records[0].assignment_id,expected_identity:preview.identity}),/Confirm/);
  assert.equal((await probeSession(records[0])).status,'present');
  const {endSession}=await import('./tmux.mjs');
  await assert.rejects(endSession(records[0],{run:async(socketPath,args)=>{
    if(args[0]==='if-shell')await tmuxExec(socketPath,['set-option','-t',`=${records[0].tmux_session}:`,'@adjacent_assignment_id',records[1].assignment_id]);
    return tmuxExec(socketPath,args);
  }}),/identity changed/);
  await tmuxExec(socket,['set-option','-t',`=${records[0].tmux_session}:`,'@adjacent_assignment_id',records[0].assignment_id]);
  assert.equal((await probeSession(records[0])).status,'present','a changed tag at the command boundary never kills the session');
  const snapshot=await readFile(records[0].brief_snapshot,'utf8');
  const result=await service.end({assignment_id:records[0].assignment_id,expected_identity:preview.identity,confirm:true});
  assert.equal(result.state,'ended');
  assert.equal((await findAssignment(storageRoot,records[0].assignment_id)).state,'ended');
  assert.equal((await probeSession(records[1])).status,'present','other assignment remains running');
  assert.equal(await readFile(records[0].brief_snapshot,'utf8'),snapshot);
  assert.equal((await service.end({assignment_id:records[0].assignment_id,expected_identity:preview.identity,confirm:true})).duplicate,true);
  // An ended-state record never exposes control of the live terminal, and the
  // ended describe shares its result with verifyTerminal.
  const endedBytes=await readFile(assignmentPath);
  const endedVerdict=await verifyTerminal({...records[0],state:'ended'});
  assert.equal(endedVerdict.ended,true);
  assert.equal(endedVerdict.exact,false);
  const endedPreview=await service.describe(records[0].assignment_id);
  assert.equal(endedPreview.can_end,false);
  assert.equal(endedPreview.local_command,null);
  assert.equal(endedPreview.attach_command,null);
  assert.equal(endedPreview.state,'ended');
  assert.deepEqual(await readFile(assignmentPath),endedBytes,'terminal verification must not mutate the durable assignment record');
});

test("store preservation: harness records", async (t) => {
  const { root, storageRoot } = await makeStorageRoot(t);
  const workspaceDirectory = await makeWorkspace(storageRoot, "harness-records");
  await mkdir(join(workspaceDirectory, "briefs"), { recursive: true });
  await writeFile(join(workspaceDirectory, "briefs", "brief.md"), "Harness record brief.\n");
  const piPath = await fakePi(join(root, "bin"));
  const assignmentsDirectory = join(workspaceDirectory, "assignments");
  await mkdir(assignmentsDirectory, { recursive: true });

  const resolveRecord = async (extra = {}) => {
    const resolved = await resolveAssignment({
      assignment_id: randomUUID(),
      workspace_id: "harness-records",
      storageRoot,
      brief: "briefs/brief.md",
      skill: "general",
      instructions: "Persist the harness record.",
      publication_authority: "none",
      attempt_kind: "initial",
      pi_path: piPath,
      ...extra,
    });
    return { ...resolved.record, state: "ended" };
  };
  const writeRecord = async (record) => {
    const path = join(assignmentsDirectory, `${record.assignment_id}.json`);
    await writeFileAtomic(path, JSON.stringify(record));
    return path;
  };

  // Legacy missing-harness bytes stay unchanged through read-only list/find,
  // and the returned record is not normalized in memory.
  const legacy = await resolveRecord();
  delete legacy.harness;
  const legacyPath = await writeRecord(legacy);
  const legacyBytes = await readFile(legacyPath);
  const listedLegacy = await listAssignments(storageRoot);
  assert.equal(listedLegacy.length, 1);
  assert.ok(!Object.hasOwn(listedLegacy[0], "harness"));
  const foundLegacy = await findAssignment(storageRoot, legacy.assignment_id);
  assert.ok(!Object.hasOwn(foundLegacy, "harness"));
  assert.deepEqual(await readFile(legacyPath), legacyBytes);
  await rm(legacyPath);

  // New Claude/Codex records with only a model or only an effort validate.
  const accepted = [
    await resolveRecord({ harness: "claude", model: "opus" }),
    await resolveRecord({ harness: "claude", thinking: "max" }),
    await resolveRecord({ harness: "codex", model: "gpt-5" }),
    await resolveRecord({ harness: "codex", thinking: "ultra" }),
  ];
  const acceptedPaths = [];
  for (const record of accepted) acceptedPaths.push(await writeRecord(record));
  const listed = await listAssignments(storageRoot);
  assert.deepEqual(
    listed.map((record) => `${record.harness}:${record.model ?? "-"}:${record.thinking ?? "-"}`).sort(),
    ["claude:-:max", "claude:opus:-", "codex:-:ultra", "codex:gpt-5:-"],
  );
  for (const path of acceptedPaths) await rm(path);

  // Unknown or null persisted harness and prohibited per-harness settings
  // refuse without normalization writes.
  const refusals = [
    ["null harness", { ...(await resolveRecord()), harness: null }, /harness/],
    ["unknown harness", { ...(await resolveRecord()), harness: "other" }, /harness/],
    ["claude provider", { ...(await resolveRecord({ harness: "claude" })), provider: "openai", model: "opus" }, /provider must be null/],
    ["codex trust", { ...(await resolveRecord({ harness: "codex" })), project_trust: "always" }, /project_trust must be null/],
    ["claude effort", { ...(await resolveRecord({ harness: "claude" })), thinking: "off" }, /Claude effort/],
  ];
  for (const [label, record, pattern] of refusals) {
    const path = await writeRecord(record);
    const bytes = await readFile(path);
    await assert.rejects(listAssignments(storageRoot), pattern, label);
    assert.deepEqual(await readFile(path), bytes, label);
    await rm(path);
  }

  assert.equal(await exists(join(storageRoot, ".sentinel")), false);
  assert.equal(await exists(join(workspaceDirectory, "sessions")), false);
});

// Step-2 harness lifecycle: only the final agent executable is substituted,
// by the same sustained fixture under the committed wrapper name. Non-Pi argv
// has no --session-dir, so the owned Pi session directory stays empty; live
// and ended state come from the real tmux/process identity path. The launcher
// is a forked worker so the recorded launcher identity is confirmed gone.
async function runHarnessLifecycle(t, { harness, wrapperName }) {
  const priorPath = process.env.PATH;
  const hadLog = Object.hasOwn(process.env, "ADJ4_FIXTURE_LOG");
  const priorLog = process.env.ADJ4_FIXTURE_LOG;
  const hadStop = Object.hasOwn(process.env, "ADJ4_FIXTURE_STOP");
  const priorStop = process.env.ADJ4_FIXTURE_STOP;
  const { root, storageRoot, home, socket, logPath, stopPath } = await launchScenario(t, 1);
  t.after(() => {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (hadLog) process.env.ADJ4_FIXTURE_LOG = priorLog; else delete process.env.ADJ4_FIXTURE_LOG;
    if (hadStop) process.env.ADJ4_FIXTURE_STOP = priorStop; else delete process.env.ADJ4_FIXTURE_STOP;
  });

  // Keep the owned tmux server reachable after the adj- session exits so
  // probeSession reports an absent terminal instead of an unreachable server;
  // the existing gone conjunction then drives locateAssignment to ended. The
  // existing scenario cleanup's kill-server reaps this keepalive session.
  const sentinelClaim = await acquireRootClaim(storageRoot);
  sentinelClaim.release();
  const keepalive = await tmuxExec(socket, [
    "start-server", ";",
    "new-session", "-d", "-s", "keepalive", "--", "/bin/sleep", "300",
  ]);
  assert.equal(keepalive.ok, true, keepalive.stderr);

  // Only the temporary wrapper bin joins PATH; the fixture wrapper keeps the
  // sustained launch-fixture-pi process under the committed wrapper name.
  const wrapperBin = join(root, "wrapper-bin");
  await mkdir(wrapperBin, { recursive: true });
  const wrapperPath = join(wrapperBin, wrapperName);
  await writeFile(
    wrapperPath,
    `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE_PI}" "$@"\n`,
    { mode: 0o755 },
  );
  await chmod(wrapperPath, 0o755);
  process.env.PATH = `${wrapperBin}:${priorPath ?? ""}`;

  const workspaceDirectory = join(storageRoot, "projects", "workspace-0");
  const input = {
    assignment_id: randomUUID(),
    workspace_id: "workspace-0",
    storageRoot,
    home,
    brief: "briefs/brief.md",
    skill: "general",
    instructions: "Harness lifecycle observation.",
    target: "app",
    publication_authority: "none",
    attempt_kind: "initial",
    harness,
    // No pi_path: the fixed wrapper name resolves through the temporary PATH.
  };
  const resolved = await resolveAssignment(input);
  assert.equal(resolved.record.pi_path, wrapperPath, harness);
  assert.equal(resolved.record.harness, harness);

  const launcher = await startWorker(root, {
    action: "launch",
    input,
    expectedDigest: resolved.contractDigest,
  });
  const launched = await withTimeout(launcher.done, `${harness} launch worker`);
  assert.equal(launched.error, undefined, launched.error?.message);
  const record = launched.value;
  assert.equal(record.state, "live");
  assert.ok(record.pi_identity !== null && record.pi_identity.pid > 0, harness);

  const snapshotPath = join(workspaceDirectory, "assignments", `${input.assignment_id}.brief.md`);
  const sessionDirectory = join(workspaceDirectory, "sessions", input.assignment_id);
  const snapshotBytes = await readFile(snapshotPath);

  // Match the fixture's own log by the saved pane process PID, because Codex
  // argv has no --session-id and no harness writes a Pi session file here.
  await waitFor(async () => {
    const entries = await fixtureEntries(logPath);
    return entries.some((entry) => entry.pid === record.pi_identity.pid);
  }, `${harness} fixture log entry for pid ${record.pi_identity.pid}`);
  const entry = (await fixtureEntries(logPath))
    .find((candidate) => candidate.pid === record.pi_identity.pid);
  assert.ok(entry, harness);
  assert.ok(!entry.argv.includes("--session-dir"), harness);
  if (harness === "claude") {
    assert.ok(entry.argv.includes("--session-id") && entry.argv.includes(input.assignment_id), harness);
  } else {
    assert.ok(!entry.argv.includes("--session-id"), harness);
  }
  assert.ok(
    entry.argv[entry.argv.length - 1].includes(`Read the launch copy at ${snapshotPath}; edit the source, not the copy.`),
    harness,
  );

  // Live location uses the owned process identity while the Pi session file
  // remains an absent, optional observation for non-Pi harnesses.
  const live = await locateAssignment(storageRoot, input.assignment_id);
  assert.equal(live.state, "live", harness);
  assert.equal(live.pi_identity.pid, record.pi_identity.pid, harness);
  assert.equal(live.pi_session_file, null, harness);
  assert.deepEqual(await readdir(sessionDirectory), [], harness);
  assert.deepEqual(await readFile(snapshotPath), snapshotBytes, harness);

  // The fixture stop file ends the owned process; confirmed terminal and
  // process absence drives the record to ended. The transition also waits for
  // the launcher/fixture process evidence to settle, so poll instead of racing
  // the first locate.
  await writeFile(stopPath, "stop\n");
  await waitFor(async () => {
    const names = await sessionNames(socket);
    return !names.some((name) => name.startsWith("adj-"));
  }, `${harness} fixture exit`);
  await rm(stopPath, { force: true });
  const ended = await waitFor(async () => {
    const record = await locateAssignment(storageRoot, input.assignment_id);
    return record.state === "ended" ? record : false;
  }, `${harness} locate ended`);
  assert.equal(ended.state, "ended", harness);
  assert.deepEqual(await readFile(snapshotPath), snapshotBytes, harness);
}

test("assignment harness lifecycle: claude fixture resolves the clauded wrapper without pi_path", async (t) => {
  await runHarnessLifecycle(t, { harness: "claude", wrapperName: "clauded" });
});

test("assignment harness lifecycle: codex fixture resolves the codexd wrapper without pi_path", async (t) => {
  await runHarnessLifecycle(t, { harness: "codex", wrapperName: "codexd" });
});

// ---------------------------------------------------------------------------
// Step 8: real terminal view streams (EV-1/EV-6).
//
// One real recorded assignment on the private launchScenario socket, the
// ordinary dashboard default server (no injected terminal views, service or
// adapters), a raw v1.alis viewer and the real bundled player through the
// same-origin proxy. Every probe file lives in the owned
// ADJ4_TERMINAL_PROBE_DIR.
// ---------------------------------------------------------------------------

// Raw WebSocket upgrade client matching the terminal-view raw contract: the
// test sends the exact v1.alis handshake and observes the proxy's first ALiS
// frames before any page attaches.
function rawUpgrade(port, path, { head = "", headers = {} } = {}) {
  const socket = createConnection({ host: "127.0.0.1", port });
  const state = { socket, data: Buffer.alloc(0), closed: false, error: null };
  socket.on("data", (chunk) => { state.data = Buffer.concat([state.data, chunk]); });
  socket.on("close", () => { state.closed = true; });
  socket.on("error", (error) => { state.error = error; state.closed = true; });
  state.ready = new Promise((resolve) => {
    socket.once("connect", () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      ];
      socket.write(`${lines.join("\r\n")}\r\n\r\n${head}`);
      resolve();
    });
  });
  state.write = (value) => socket.write(value);
  state.end = () => socket.destroy();
  return state;
}

// One masked client text frame; tmux read-only clients must discard it.
function maskedTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

test("terminal view streams: real tmux/asciinema/dashboard/player composition", { timeout: 180000 }, async (t) => {
  // launchScenario mutates the fixture env; capture the prior values first so
  // this case restores exactly what it changed.
  const hadFixtureLog = Object.hasOwn(process.env, "ADJ4_FIXTURE_LOG");
  const priorFixtureLog = process.env.ADJ4_FIXTURE_LOG;
  const hadFixtureStop = Object.hasOwn(process.env, "ADJ4_FIXTURE_STOP");
  const priorFixtureStop = process.env.ADJ4_FIXTURE_STOP;
  const { root, storageRoot, home, piPath, logPath, socket } = await launchScenario(t, 1);
  const workspaceDirectory = join(storageRoot, "projects", "workspace-0");
  const probeDir = join(root, "terminal-probe");
  const hadTerm = Object.hasOwn(process.env, "TERM");
  const priorTerm = process.env.TERM;
  const priorProbe = process.env.ADJ4_TERMINAL_PROBE_DIR;
  // Service-like spawn: the terminal manager must supply its own TERM.
  delete process.env.TERM;
  process.env.ADJ4_TERMINAL_PROBE_DIR = probeDir;
  t.after(() => {
    if (hadTerm) process.env.TERM = priorTerm; else delete process.env.TERM;
    if (priorProbe === undefined) delete process.env.ADJ4_TERMINAL_PROBE_DIR;
    else process.env.ADJ4_TERMINAL_PROBE_DIR = priorProbe;
    if (hadFixtureLog) process.env.ADJ4_FIXTURE_LOG = priorFixtureLog; else delete process.env.ADJ4_FIXTURE_LOG;
    if (hadFixtureStop) process.env.ADJ4_FIXTURE_STOP = priorFixtureStop; else delete process.env.ADJ4_FIXTURE_STOP;
  });

  // Owned spec package with a real spec document and sandbox HTML fixture.
  const created = await newPackage({
    workspace: "workspace-0",
    slug: "terminal-real",
    targets: [{ id: "app" }],
    root: storageRoot,
  });
  assert.equal(created.ok, true, created.code);
  const packageDirectory = created.locations.package_dir;
  await writeFile(join(packageDirectory, "spec.md"), "# Terminal real specification\n\nReal player proof.\n");
  await writeFile(join(packageDirectory, "sandbox.html"), "<!doctype html><html><body><h1>Sandbox fixture</h1></body></html>");

  // Establish the real spec worktree through the same owner the production
  // prepare path uses; makeRepo already created the repository commit.
  await prepareAssignmentSpecTarget({
    storageRoot,
    workspace_id: "workspace-0",
    target: "app",
    specPackage: packageDirectory,
  });

  // Real launch on the private socket with the owned probe directory.
  const input = launchInput({ workspaceId: "workspace-0", storageRoot, home, piPath, specPackage: packageDirectory });
  const resolved = await resolveAssignment(input);
  const record = await launchAssignment(input, { resolved, expectedDigest: resolved.contractDigest });
  assert.equal(record.state, "live");
  await waitForFixtureLog(logPath, socket, input.assignment_id);

  // Positive input control and baseline: the fixture prints the startup marker
  // before it observes stdin, then an owned direct tmux send-keys proves the
  // observer is live.
  const paneTarget = record.pane_id ? record.pane_id : `=${record.tmux_session}`;
  const capturePane = async () => {
    const result = await tmuxExec(socket, ["capture-pane", "-p", "-t", paneTarget]);
    if (!result.ok) {
      throw new Error(`capture-pane failed for ${paneTarget}: ${result.stderr || "unknown tmux error"}`);
    }
    return result.stdout;
  };
  try {
    await waitFor(async () => (await capturePane()).includes("INITIAL_TERMINAL_MARKER"), "initial terminal marker on the owned pane");
  } catch (error) {
    // Bounded first-unproven prerequisite diagnostic: which tmux target was
    // read, what it contained, whether the fixture saw the probe env and the
    // pane dimensions. The marker assertion itself is unchanged.
    const capture = await capturePane().catch((captureError) => `capture failed: ${captureError.message}`);
    const probeEnv = await tmuxExec(socket, ["show-environment", "-t", `=${record.tmux_session}`, "ADJ4_TERMINAL_PROBE_DIR"]);
    const paneSize = await tmuxExec(socket, ["display-message", "-p", "-t", paneTarget, "#{pane_width}x#{pane_height}"]);
    throw new Error(
      `initial terminal marker not observed: ${error.message}; ` +
      `capture=${JSON.stringify(capture)}; ` +
      `fixtureLog=${JSON.stringify(await fixtureEntries(logPath))}; ` +
      `probeDirExists=${await exists(probeDir)}; ` +
      `inputLogExists=${await exists(join(probeDir, "input.log"))}; ` +
      `probeEnv=${JSON.stringify(probeEnv)}; ` +
      `paneSize=${JSON.stringify(paneSize)}`,
    );
  }
  const positiveInput = `ADJ4-POSITIVE-${input.assignment_id.slice(0, 8)}`;
  const sent = await tmuxExec(socket, ["send-keys", "-l", "-t", paneTarget, positiveInput]);
  assert.equal(sent.ok, true, sent.stderr);
  const inputLogPath = join(probeDir, "input.log");
  await waitFor(async () => (await readFile(inputLogPath).catch(() => Buffer.alloc(0))).includes(Buffer.from(positiveInput)), "positive input observation");
  const inputBaseline = await readFile(inputLogPath);
  assert.ok(inputBaseline.length > 0);

  const snapshotPath = join(workspaceDirectory, "assignments", `${input.assignment_id}.brief.md`);
  const recordPath = join(workspaceDirectory, "assignments", `${input.assignment_id}.json`);
  const snapshotBytes = await readFile(snapshotPath);
  const recordBytes = await readFile(recordPath);
  const sizeBefore = await windowSize({ socketPath: socket, sessionName: record.tmux_session });
  assert.ok(sizeBefore && sizeBefore.cols > 0 && sizeBefore.rows > 0, JSON.stringify(sizeBefore));

  // Production-shaped observer envelope serialized inside the owned agentDir;
  // ordinary App routes then reach the real launched UUID with no private
  // registration, injection or fixture framework.
  const agentDir = join(root, "agent");
  const observersDirectory = join(agentDir, "spec-sentinel", "b".repeat(64), "observers");
  await mkdir(observersDirectory, { recursive: true });
  const collected = await collectAssignments({ storageRoot });
  const collectedRow = collected.assignments.find((row) => row.assignment_id === input.assignment_id);
  assert.ok(collectedRow, `launched assignment missing from collection: ${JSON.stringify(collected.coverage)}`);
  const publishedAt = new Date().toISOString();
  const envelope = {
    schema_version: 1,
    observer_id: "terminal-real",
    state: "observing",
    published_at: publishedAt,
    snapshot: {
      workspace: "workspace-0",
      coverage: { state: "complete", observed_at: publishedAt, reasons: [] },
      runs: [{
        workspace: "workspace-0",
        package: packageDirectory,
        package_ref: "workspace-0/terminal-real",
        assignment_id: input.assignment_id,
        workflow_id: collectedRow.workflow_id ?? record.workflow_id ?? "terminal-workflow",
        execution: "running",
        workflow_state: "waiting-worker",
        is_current_assignment: true,
        activity: "Streaming the owned terminal",
        obligation: "Render real terminal output",
        observed_at: publishedAt,
        coverage: { state: "complete", reasons: [] },
        spec_progress: { current_position: 1, total_steps: 2, current_name: "Stream" },
        timing: { started_at: publishedAt, attempts: [] },
      }],
      recently_completed: [],
      assignments: [collectedRow],
      assignment_coverage: { state: "complete", reasons: [] },
      epics: [],
    },
  };
  await writeFileAtomic(join(observersDirectory, "b.json"), JSON.stringify(envelope));

  // Ordinary createDashboardServer defaults: no terminalViews or sessionControl.
  const server = createDashboardServer({ agentDir, storageRoot });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => {
    await server.closeTerminalViews().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const openPath = "/api/assignment-terminal/open";

  // The ordinary state route exposes the launched UUID and its linked run
  // before any browser or upgrade attempt.
  const stateResponse = await fetch(`${baseUrl}/api/state`);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(typeof state.action_token, "string");
  const openHeaders = { origin: baseUrl, "x-sentinel-token": state.action_token, "content-type": "application/json" };
  const stateAssignment = state.observers.flatMap((observer) => observer.snapshot?.assignments ?? [])
    .find((row) => row.assignment_id === input.assignment_id);
  assert.ok(stateAssignment, "launched UUID is not exposed through /api/state");
  const stateRun = state.observers.flatMap((observer) => observer.snapshot?.runs ?? [])
    .find((row) => row.assignment_id === input.assignment_id);
  assert.ok(stateRun, "launched UUID has no linked run through /api/state");

  // Authenticated open from the state action token; the returned dimensions
  // come from the real tmux window.
  const openedResponse = await fetch(`${baseUrl}${openPath}`, {
    method: "POST", headers: openHeaders, body: JSON.stringify({ assignment_id: input.assignment_id }),
  });
  const openedText = await openedResponse.text();
  assert.equal(openedResponse.status, 200, openedText);
  const opened = JSON.parse(openedText);
  assert.equal(opened.state, "live");
  assert.equal(opened.cols, sizeBefore.cols);
  assert.equal(opened.rows, sizeBefore.rows);

  // Raw upgrade: real proxy negotiation, first ALiS frames with the startup
  // marker, then a masked viewer input attempt.
  const viewer = rawUpgrade(port, `/api/assignment-terminal/${input.assignment_id}/ws`, {
    headers: { "Sec-WebSocket-Protocol": "v1.alis", Origin: baseUrl },
  });
  t.after(() => viewer.end());
  await viewer.ready;
  await waitFor(() => viewer.data.includes(Buffer.from("101 Switching Protocols")), "raw viewer handshake");
  await waitFor(() => viewer.data.includes(Buffer.from("v1.alis")), "v1.alis protocol negotiation");
  await waitFor(() => viewer.data.includes(Buffer.from("INITIAL_TERMINAL_MARKER")), "initial marker in ALiS frames");
  viewer.write(maskedTextFrame("ADJ4-VIEWER-INPUT"));

  // The real tmux client attaches read-only and ignore-size and must not
  // change the agent's window dimensions.
  const clientLine = await waitFor(async () => {
    const result = await tmuxExec(socket, ["list-clients", "-t", `=${record.tmux_session}`, "-F", "#{client_readonly}|#{client_flags}"]);
    return result.ok && result.stdout.trim() !== "" ? result.stdout.trim() : false;
  }, "read-only terminal client");
  assert.match(clientLine, /^1\|/, clientLine);
  assert.match(clientLine, /read-only/, clientLine);
  assert.match(clientLine, /ignore-size/, clientLine);
  const sizeAfterAttach = await windowSize({ socketPath: socket, sessionName: record.tmux_session });
  assert.deepEqual(sizeAfterAttach, sizeBefore, "viewer attach must not resize the agent window");

  // Real browser journey: ordinary App routes, actual bundled player and both
  // markers through the same ready stream while the raw viewer stays attached.
  const frontendDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "spec-observe", "frontend");
  const browserCheck = join(frontendDirectory, "terminal-browser-check.py");
  const evidenceDirectory = process.env.SENTINEL_EVIDENCE_DIR;
  const evidencePath = join(evidenceDirectory ?? "/tmp", "ev-6-real-player.json");
  await rm(evidencePath, { force: true });
  const pythonOutput = await new Promise((resolve, reject) => {
    execFile(
      "uv",
      ["run", "--script", browserCheck, "--case", "real", "--url", baseUrl, "--assignment", input.assignment_id,
        "--probe-dir", probeDir, "--package", packageDirectory, "--workspace", "workspace-0"],
      {
        cwd: join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
        timeout: 120000,
        killSignal: "SIGKILL",
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`real terminal browser journey failed: ${stderr || stdout || error.message}`));
        else resolve(stdout);
      },
    );
  });
  assert.match(pythonOutput, /"status": "passed"/, pythonOutput);
  const receipt = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(receipt.status, "passed");
  assert.ok(receipt.captures.length >= 4, JSON.stringify(receipt.captures));
  assert.equal(receipt.viewer_input?.attempted, true);

  // The narrow browser viewport must not resize the agent window either.
  const sizeAfterBrowser = await windowSize({ socketPath: socket, sessionName: record.tmux_session });
  assert.deepEqual(sizeAfterBrowser, sizeBefore, "browser viewport must not resize the agent window");

  // Closing the viewers arms the shipping default grace (10 s), which removes
  // the read-only client without touching input, saved bytes or Pi identity.
  viewer.end();
  await waitFor(() => viewer.closed, "raw viewer closed");
  await waitFor(async () => {
    const result = await tmuxExec(socket, ["list-clients", "-t", `=${record.tmux_session}`]);
    return result.ok && result.stdout.trim() === "";
  }, "default grace removes the read-only client", 30000);
  assert.deepEqual(await readFile(inputLogPath), inputBaseline, "viewer input must not reach the observed input log");
  assert.deepEqual(await readFile(snapshotPath), snapshotBytes, "snapshot bytes changed");
  assert.deepEqual(await readFile(recordPath), recordBytes, "assignment record bytes changed");
  const survived = await locateAssignment(storageRoot, input.assignment_id);
  assert.equal(survived.state, "live");
  assert.deepEqual(survived.pi_identity, record.pi_identity);

  // Reopen, then drain only the dashboard-owned stream: the raw viewer closes,
  // the tmux client disappears and the recorded Pi identity stays alive.
  const reopenedResponse = await fetch(`${baseUrl}${openPath}`, {
    method: "POST", headers: openHeaders, body: JSON.stringify({ assignment_id: input.assignment_id }),
  });
  assert.equal(reopenedResponse.status, 200, await reopenedResponse.text());
  const viewerDrain = rawUpgrade(port, `/api/assignment-terminal/${input.assignment_id}/ws`, {
    headers: { "Sec-WebSocket-Protocol": "v1.alis", Origin: baseUrl },
  });
  t.after(() => viewerDrain.end());
  await viewerDrain.ready;
  await waitFor(() => viewerDrain.data.includes(Buffer.from("101")), "drain viewer handshake");
  await server.closeTerminalViews();
  await waitFor(() => viewerDrain.closed, "closeTerminalViews closes the raw viewer");
  await waitFor(async () => {
    const result = await tmuxExec(socket, ["list-clients", "-t", `=${record.tmux_session}`]);
    return result.ok && result.stdout.trim() === "";
  }, "closeTerminalViews drains the read-only client", 30000);
  const drained = await locateAssignment(storageRoot, input.assignment_id);
  assert.equal(drained.state, "live", "Pi identity must remain alive after the dashboard drain");
  assert.deepEqual(drained.pi_identity, record.pi_identity);
  assert.deepEqual(await readFile(inputLogPath), inputBaseline, "input log changed after the dashboard drain");
});
