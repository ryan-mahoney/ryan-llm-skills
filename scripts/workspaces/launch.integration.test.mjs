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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  acquireRootClaim,
  findAssignment,
  launchAssignment,
  listAssignments,
  locateAssignment,
  resolveAssignment,
} from "./assignments.mjs";
import { writeFileAtomic } from "./store.mjs";

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
  assert.ok(await exists(join(beforeDir, "assignments", `${beforeInput.assignment_id}.json`)));
  assert.ok(await exists(join(beforeDir, "assignments", `${beforeInput.assignment_id}.brief.md`)));
  assert.ok(await exists(join(beforeDir, "sessions", beforeInput.assignment_id)));
  const free = await acquireRootClaim(storageRoot);
  free.release();

  const competing = launchInput({ workspaceId: "workspace-0", storageRoot, home, piPath });
  const competingDigest = (await resolveAssignment(competing)).contractDigest;
  await assert.rejects(
    launchAssignment(competing, { expectedDigest: competingDigest }),
    /reserves/,
  );

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
  const { storageRoot, home, piPath, socket, logPath, workspaces } = await launchScenario(t, 1);
  const workspaceDirectory = workspaces[0];
  const input = launchInput({ workspaceId: "workspace-0", storageRoot, home, piPath });
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
  const snapshotPath = join(workspaceDirectory, "assignments", `${input.assignment_id}.brief.md`);
  assert.deepEqual(await readFile(snapshotPath), approvedBytes);
  await waitForFixtureLog(logPath, socket, input.assignment_id);
  const entries = await fixtureEntries(logPath);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].argv.includes(`@${snapshotPath}`));
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

  // Git-dir lease refuses launch without taking or modifying it.
  const leaseDir = join(repo, ".git", "spec-runtime.lock");
  await mkdir(leaseDir, { recursive: true });
  const leasePath = join(leaseDir, "lease.json");
  await writeFile(leasePath, "{\"id\":\"fixture\"}\n");
  const leaseBefore = await readFile(leasePath);
  const leased = launchInput({ workspaceId: "workspace-0", storageRoot, home, piPath });
  const leasedDigest = (await resolveAssignment(leased)).contractDigest;
  await assert.rejects(launchAssignment(leased, { expectedDigest: leasedDigest }), /spec_dispatch git lease/);
  assert.deepEqual(await readFile(leasePath), leaseBefore);
  assert.equal(await exists(join(assignmentsA, `${leased.assignment_id}.json`)), false);
  await rm(leaseDir, { recursive: true, force: true });

  // A supplied valid spec package's runtime package lock likewise refuses.
  const packageDirectory = join(repo, ".specs", "fixture");
  await mkdir(join(packageDirectory, "runtime", "package.lock"), { recursive: true });
  const packageLease = join(packageDirectory, "runtime", "package.lock", "lease.json");
  await writeFile(packageLease, "{\"id\":\"package-fixture\"}\n");
  const packageBytes = await readFile(packageLease);
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
    /package lease/,
  );
  assert.deepEqual(await readFile(packageLease), packageBytes);
  assert.equal(await exists(join(assignmentsA, `${packaged.assignment_id}.json`)), false);
  await rm(join(packageDirectory, "runtime", "package.lock"), { recursive: true, force: true });

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
