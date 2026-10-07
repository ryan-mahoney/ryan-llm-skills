// Step 6 focused integration tests: real Node CLI -> real Bun worker against
// temporary state, cheap unavailable preflight, work-before-write failures, and
// owned process-group settlement. All fixtures are isolated under mkdtemp.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { runCommand } from "./client.mjs";
import { resolveCheckout } from "./identity.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(moduleDir, "cli.mjs");
const workerPath = join(moduleDir, "worker.ts");

const tempDirs = [];
const spawnedPids = [];
let unrelatedCwd;

async function makeTemp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

before(async () => {
  unrelatedCwd = await makeTemp("repo-search-cwd-");
});

after(async () => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function findBun() {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "bun");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("bun executable not found on PATH");
}

const realBun = findBun();

function execFileP(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runProcess(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { ...options, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function runCli(args, extras = {}) {
  return runProcess(process.execPath, [cliPath, ...args], {
    cwd: extras.cwd ?? unrelatedCwd,
    env: { ...process.env, ...(extras.env ?? {}) },
  });
}

async function initFixtureRepo() {
  const dir = await makeTemp("repo-search-repo-");
  await execFileP("git", ["init", "-q"], { cwd: dir });
  await execFileP("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileP("git", ["config", "user.name", "Test User"], { cwd: dir });
  await writeFile(join(dir, "file.txt"), "hello world\n", "utf8");
  await execFileP("git", ["add", "file.txt"], { cwd: dir });
  await execFileP("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

async function writeEnrollmentFixture(stateRoot, identity) {
  const checkoutsDir = join(stateRoot, "checkouts");
  const checkoutDir = join(checkoutsDir, identity.checkoutKey);
  await mkdir(checkoutDir, { recursive: true, mode: 0o700 });
  await chmod(checkoutsDir, 0o700);
  await chmod(checkoutDir, 0o700);
  const record = {
    version: 1,
    identity: {
      repoKey: identity.repoKey,
      checkoutKey: identity.checkoutKey,
      root: identity.root,
      commonDir: identity.commonDir,
      gitDir: identity.gitDir,
      primary: identity.primary,
    },
    specUse: false,
    enrolledAt: new Date().toISOString(),
    head: identity.head,
    lastBuild: null,
    lastCheck: null,
  };
  const recordPath = join(checkoutDir, "enrollment.json");
  await writeFile(recordPath, JSON.stringify(record, null, 2), { mode: 0o600 });
  await chmod(recordPath, 0o600);
}

async function hashTree(root, skip = new Set([".git"])) {
  const hashes = {};
  async function walk(dir, rel) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const key = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(abs, key);
      } else if (entry.isFile()) {
        hashes[key] = createHash("sha256").update(await readFile(abs)).digest("hex");
      }
    }
  }
  await walk(root, "");
  return hashes;
}

function makeFakeChild(sleeper) {
  const child = new EventEmitter();
  child.pid = sleeper.pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  sleeper.on("close", (code, signal) => {
    child.exitCode = code;
    child.emit("close", code, signal);
  });
  sleeper.on("error", (error) => child.emit("error", error));
  return child;
}

test("real CLI invokes the real worker for status/check/configure/prune", { timeout: 60000 }, async () => {
  const repo = await initFixtureRepo();
  const state = await makeTemp("repo-search-state-");
  const identity = await resolveCheckout(repo);

  const status = await runCli(["status", "--root", repo, "--state", state, "--json"]);
  assert.equal(status.code, 0, status.stderr);
  const statusReceipt = JSON.parse(status.stdout.trim());
  assert.equal(statusReceipt.status, "ok");
  assert.equal(statusReceipt.command, "status");
  assert.equal(statusReceipt.checkoutKey, identity.checkoutKey);
  assert.equal(typeof statusReceipt.receipt.observedAt, "string");

  const prune = await runCli(["prune", "--state", state, "--json"]);
  assert.equal(prune.code, 0, prune.stderr);
  const pruneReceipt = JSON.parse(prune.stdout.trim());
  assert.ok(Array.isArray(pruneReceipt.receipt.deleted));
  assert.ok(Array.isArray(pruneReceipt.receipt.retained));

  await writeEnrollmentFixture(state, identity);

  const check = await runCli(["check", "--root", repo, "--state", state, "--json"]);
  assert.equal(check.code, 0, check.stderr);
  const checkReceipt = JSON.parse(check.stdout.trim());
  assert.equal(checkReceipt.status, "ok");
  assert.equal(checkReceipt.receipt.availability, "missing");
  assert.equal(checkReceipt.receipt.matchesGeneration, false);
  assert.match(checkReceipt.receipt.snapshotDigest, /^[0-9a-f]{64}$/);

  const recordPath = join(state, "checkouts", identity.checkoutKey, "enrollment.json");
  const afterCheck = JSON.parse(await readFile(recordPath, "utf8"));
  assert.ok(afterCheck.lastCheck && typeof afterCheck.lastCheck.at === "string");

  const on = await runCli(["configure", "--root", repo, "--state", state, "--spec-use", "on", "--json"]);
  assert.equal(on.code, 0, on.stderr);
  assert.equal(JSON.parse(await readFile(recordPath, "utf8")).specUse, true);

  const off = await runCli(["configure", "--root", repo, "--state", state, "--spec-use", "off", "--json"]);
  assert.equal(off.code, 0, off.stderr);
  assert.equal(JSON.parse(await readFile(recordPath, "utf8")).specUse, false);
});

test("cheap unavailable preflight leaves state and source untouched", { timeout: 60000 }, async () => {
  const repo = await initFixtureRepo();
  const stateParent = await makeTemp("repo-search-state-");
  const state = join(stateParent, "state");
  const beforeHash = await hashTree(repo);

  const missingBun = await runCommand("status", {
    root: repo,
    state,
    bunPath: "/nonexistent/bun-for-test",
  });
  assert.equal(missingBun.status, "unavailable");
  assert.equal(missingBun.reason, "runtime-unavailable");
  assert.equal(missingBun.exitCode, 3);
  assert.equal(existsSync(state), false);

  const emptyPackage = await makeTemp("repo-search-pkg-");
  const missingDeps = await runCommand("status", {
    root: repo,
    state,
    packageDir: emptyPackage,
    bunPath: realBun,
  });
  assert.equal(missingDeps.status, "unavailable");
  assert.equal(missingDeps.reason, "dependencies-unavailable");
  assert.equal(missingDeps.exitCode, 3);
  assert.equal(existsSync(state), false);

  assert.deepEqual(await hashTree(repo), beforeHash);
});

test("usage and invalid-root failures write no lifecycle state", { timeout: 60000 }, async () => {
  const repo = await initFixtureRepo();
  const stateParent = await makeTemp("repo-search-state-");
  const state = join(stateParent, "state");

  const unknownFlag = await runCli(["status", "--root", repo, "--state", state, "--nope"]);
  assert.equal(unknownFlag.code, 2);
  assert.equal(existsSync(state), false);

  const badMode = await runCli(["check", "--root", repo, "--state", state, "--mode", "vector"]);
  assert.equal(badMode.code, 2);
  assert.equal(existsSync(state), false);

  const nonGit = await makeTemp("repo-search-nongit-");
  const invalidRoot = await runCli(["status", "--root", nonGit, "--state", state, "--json"]);
  assert.equal(invalidRoot.code, 3, invalidRoot.stderr);
  const invalidRootReceipt = JSON.parse(invalidRoot.stdout.trim());
  assert.equal(invalidRootReceipt.reason, "invalid-root");
  assert.equal(existsSync(state), false);

  const malformed = await runProcess(realBun, ["--no-install", workerPath, "--request", "{"]);
  assert.equal(malformed.code, 2, malformed.stderr);
  const malformedReceipt = JSON.parse(malformed.stdout.trim());
  assert.equal(malformedReceipt.reason, "usage");
  assert.equal(existsSync(state), false);
});

test("owned timeout/abort settles only the owned group", { timeout: 60000 }, async () => {
  const state = await makeTemp("repo-search-state-");
  const models = await makeTemp("repo-search-models-");
  await writeFile(join(models, "sentinel.txt"), "sentinel\n", "utf8");
  const sentinelBefore = await readFile(join(models, "sentinel.txt"));

  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  unrelated.unref();
  spawnedPids.push(unrelated.pid);

  let lastSleeperPid = null;
  const fakeSpawn = () => {
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    lastSleeperPid = sleeper.pid;
    spawnedPids.push(sleeper.pid);
    return makeFakeChild(sleeper);
  };

  try {
    const started = Date.now();
    const timedOut = await runCommand("prune", { state, timeoutMs: 200, spawn: fakeSpawn });
    assert.equal(timedOut.reason, "timeout");
    assert.equal(timedOut.exitCode, 124);
    assert.ok(lastSleeperPid !== null);
    assert.throws(
      () => process.kill(lastSleeperPid, 0),
      (error) => error.code === "ESRCH",
    );
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    assert.ok(Date.now() - started < 5000);

    const controller = new AbortController();
    const pending = runCommand("prune", {
      state,
      timeoutMs: 10000,
      spawn: fakeSpawn,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const canceled = await pending;
    assert.equal(canceled.reason, "canceled");
    assert.equal(canceled.exitCode, 130);
    assert.ok(lastSleeperPid !== null);
    assert.throws(
      () => process.kill(lastSleeperPid, 0),
      (error) => error.code === "ESRCH",
    );
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));

    assert.deepEqual(await readFile(join(models, "sentinel.txt")), sentinelBefore);
  } finally {
    try {
      process.kill(-unrelated.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

test("root and default-state ownership", { timeout: 60000 }, async () => {
  const repo = await initFixtureRepo();
  const stateA = await makeTemp("repo-search-state-a-");
  const cwd = await makeTemp("repo-search-cwd-b-");
  const identity = await resolveCheckout(repo);

  const status = await runCli(["status", "--root", repo, "--state", stateA, "--json"], { cwd });
  assert.equal(status.code, 0, status.stderr);
  const statusReceipt = JSON.parse(status.stdout.trim());
  assert.equal(statusReceipt.checkoutKey, identity.checkoutKey);
  assert.ok(existsSync(join(stateA, "state.sqlite")));

  const home = await makeTemp("repo-search-home-");
  const defaultStatus = await runCli(["status", "--root", repo, "--json"], {
    cwd,
    env: { HOME: home },
  });
  assert.equal(defaultStatus.code, 0, defaultStatus.stderr);
  assert.ok(existsSync(join(home, ".cache", "agent-repo-search", "state.sqlite")));

  const models = await makeTemp("repo-search-models-");
  await writeFile(join(models, "sentinel.txt"), "sentinel\n", "utf8");
  const sentinelBefore = await readFile(join(models, "sentinel.txt"));
  const build = await runCli(
    ["build", "--root", repo, "--state", stateA, "--models", models, "--json"],
    { cwd },
  );
  assert.equal(build.code, 3, build.stderr);
  const buildReceipt = JSON.parse(build.stdout.trim());
  assert.equal(buildReceipt.reason, "model-unavailable");
  assert.deepEqual(await readFile(join(models, "sentinel.txt")), sentinelBefore);
  const generationsDir = join(stateA, "generations");
  assert.ok(existsSync(generationsDir));
  assert.equal((await readdir(generationsDir)).length, 0);
});
