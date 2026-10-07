// Step 6 focused integration tests: real Node CLI -> real Bun worker against
// temporary state, cheap unavailable preflight, work-before-write failures, and
// owned process-group settlement. All fixtures are isolated under mkdtemp.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { runCommand } from "./client.mjs";
import { resolveCheckout, resolvePrimaryCheckout } from "./identity.mjs";

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
  // A package-relative resolution regression would create this under the module.
  await rm(join(moduleDir, "relative-state"), { recursive: true, force: true }).catch(() => {});
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

async function initRepoAt(dir) {
  await mkdir(dir, { recursive: true });
  await execFileP("git", ["init", "-q"], { cwd: dir });
  await execFileP("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileP("git", ["config", "user.name", "Test User"], { cwd: dir });
  await writeFile(join(dir, "file.txt"), "hello world\n", "utf8");
  await execFileP("git", ["add", "file.txt"], { cwd: dir });
  await execFileP("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

async function initFixtureRepo() {
  return initRepoAt(await makeTemp("repo-search-repo-"));
}

async function addLinkedWorktree(repo, path, branch) {
  await execFileP("git", ["worktree", "add", "-q", "-b", branch, path, "HEAD"], { cwd: repo });
  return path;
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

  const partialPackage = await makeTemp("repo-search-pkg-");
  await mkdir(join(partialPackage, "node_modules", "@orama", "orama"), { recursive: true });
  let partialSpawned = false;
  const partialDeps = await runCommand("status", {
    root: repo,
    state,
    packageDir: partialPackage,
    bunPath: realBun,
    spawn: () => {
      partialSpawned = true;
      throw new Error("partial dependency preflight spawned the worker");
    },
  });
  assert.equal(partialDeps.status, "unavailable");
  assert.equal(partialDeps.reason, "dependencies-unavailable");
  assert.equal(partialDeps.exitCode, 3);
  assert.equal(partialSpawned, false);
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

test("sampled child RSS ceiling stops and settles the owned group", { timeout: 60000 }, async () => {
  const state = await makeTemp("repo-search-state-");
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

  const withinBudget = await runCommand("prune", {
    state,
    timeoutMs: 200,
    spawn: fakeSpawn,
    rssSampler: () => 1024 * 1024,
  });
  assert.equal(withinBudget.reason, "timeout");

  const overCeiling = 2 * 1024 * 1024 * 1024 + 1;
  const exceeded = await runCommand("prune", {
    state,
    timeoutMs: 10000,
    spawn: fakeSpawn,
    rssSampler: () => overCeiling,
  });
  assert.equal(exceeded.status, "unavailable");
  assert.equal(exceeded.reason, "budget-exceeded");
  assert.equal(exceeded.exitCode, 3);
  assert.equal(exceeded.observedRssBytes, overCeiling);
  assert.ok(lastSleeperPid !== null);
  assert.throws(
    () => process.kill(lastSleeperPid, 0),
    (error) => error.code === "ESRCH",
  );
});

test("CLI termination signals settle the owned worker group before exit", { timeout: 60000 }, async () => {
  const repo = await initFixtureRepo();
  const stateParent = await makeTemp("repo-search-state-parent-");
  const state = join(stateParent, "state");
  const shimDir = await makeTemp("repo-search-bin-");
  const bunShim = join(shimDir, "bun");
  await writeFile(
    bunShim,
    "#!/bin/sh\necho $$ > \"$REPO_SEARCH_TEST_PID_FILE\"\nexec sleep 300\n",
    "utf8",
  );
  await chmod(bunShim, 0o755);

  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  unrelated.unref();
  spawnedPids.push(unrelated.pid);

  try {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const pidFile = join(shimDir, `${signal}.pid`);
      const cli = spawn(
        process.execPath,
        [cliPath, "status", "--root", repo, "--state", state, "--json"],
        {
          cwd: unrelatedCwd,
          env: {
            ...process.env,
            PATH: `${shimDir}:${process.env.PATH ?? ""}`,
            REPO_SEARCH_TEST_PID_FILE: pidFile,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      cli.stdout.on("data", (chunk) => {
        stdout += chunk;
      });

      const deadline = Date.now() + 10000;
      while (!existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(existsSync(pidFile), `controlled bun shim did not start for ${signal}`);
      const childPid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
      spawnedPids.push(childPid);

      cli.kill(signal);
      const closed = await new Promise((resolve) => {
        cli.once("close", (code) => resolve(code));
      });
      assert.equal(closed, 130, stdout);
      const receipt = JSON.parse(stdout.trim());
      assert.equal(receipt.status, "unavailable");
      assert.equal(receipt.reason, "canceled");
      assert.equal(receipt.exitCode, 130);
      assert.throws(
        () => process.kill(childPid, 0),
        (error) => error.code === "ESRCH",
      );
      assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
      assert.equal(existsSync(state), false);
    }
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

test("relative root and state resolve against the caller cwd", { timeout: 60000 }, async () => {
  const workspace = await makeTemp("repo-search-workspace-");
  const repo = await initRepoAt(join(workspace, "repo"));
  const identity = await resolveCheckout(repo);

  const status = await runCli(["status", "--root", "repo", "--state", "relative-state", "--json"], {
    cwd: workspace,
  });
  assert.equal(status.code, 0, status.stderr);
  const receipt = JSON.parse(status.stdout.trim());
  assert.equal(receipt.checkoutKey, identity.checkoutKey);
  assert.equal(receipt.actualRoot, identity.root);
  assert.ok(existsSync(join(workspace, "relative-state", "state.sqlite")));
  assert.equal(existsSync(join(moduleDir, "relative-state")), false);
});

function existingModelsRoot() {
  const value = process.env.REPO_SEARCH_MODELS;
  return typeof value === "string" && value.length > 0 && existsSync(value) ? value : null;
}

test(
  "relative models resolve against the caller cwd",
  { timeout: 60000, skip: existingModelsRoot() === null ? "REPO_SEARCH_MODELS is not set" : false },
  async () => {
    const modelsRoot = existingModelsRoot();
    const workspace = await makeTemp("repo-search-workspace-");
    const repo = await initRepoAt(join(workspace, "repo"));
    await symlink(modelsRoot, join(workspace, "relative-models"), "dir");

    const build = await runCli(
      ["build", "--root", "repo", "--state", "relative-state", "--models", "relative-models", "--json"],
      { cwd: workspace },
    );
    assert.equal(build.code, 0, build.stderr);
    const receipt = JSON.parse(build.stdout.trim());
    assert.equal(receipt.status, "ok");
    assert.equal(receipt.receipt.generationKind, "full");
  },
);

test("resolvePrimaryCheckout resolves the canonical primary for a linked worktree", { timeout: 60000 }, async () => {
  const repo = await initFixtureRepo();
  const worktreeParent = await makeTemp("repo-search-wt-");
  const linked = await addLinkedWorktree(repo, join(worktreeParent, "feature"), "feature");

  const primaryIdentity = await resolveCheckout(repo);
  const linkedIdentity = await resolveCheckout(linked);
  assert.equal(linkedIdentity.primary, false);

  const resolved = await resolvePrimaryCheckout(linkedIdentity);
  assert.equal(resolved.primary, true);
  assert.equal(resolved.root, primaryIdentity.root);
  assert.equal(resolved.checkoutKey, primaryIdentity.checkoutKey);

  const self = await resolvePrimaryCheckout(primaryIdentity);
  assert.equal(self.checkoutKey, primaryIdentity.checkoutKey);
});

test(
  "public linked build reuses an eligible primary base and falls back without one",
  { timeout: 120000, skip: existingModelsRoot() === null ? "REPO_SEARCH_MODELS is not set" : false },
  async () => {
    const modelsRoot = existingModelsRoot();
    const repo = await initFixtureRepo();
    const worktreeParent = await makeTemp("repo-search-wt-");
    const linked = await addLinkedWorktree(repo, join(worktreeParent, "feature"), "feature");
    await writeFile(join(linked, "file.txt"), "hello linked world\n", "utf8");

    const state = await makeTemp("repo-search-state-");
    const primaryBuild = await runCli([
      "build", "--root", repo, "--state", state, "--models", modelsRoot, "--json",
    ]);
    assert.equal(primaryBuild.code, 0, primaryBuild.stderr);
    assert.equal(JSON.parse(primaryBuild.stdout.trim()).receipt.generationKind, "full");

    const status = await runCli(["status", "--root", repo, "--state", state, "--json"]);
    assert.equal(status.code, 0, status.stderr);
    const primaryGenerationId = JSON.parse(status.stdout.trim()).receipt.currentGenerationId;
    assert.equal(typeof primaryGenerationId, "string");

    const linkedBuild = await runCli([
      "build", "--root", linked, "--state", state, "--models", modelsRoot, "--json",
    ]);
    assert.equal(linkedBuild.code, 0, linkedBuild.stderr);
    const linkedReceipt = JSON.parse(linkedBuild.stdout.trim()).receipt;
    assert.equal(linkedReceipt.generationKind, "overlay");
    assert.equal(linkedReceipt.baseId, primaryGenerationId);

    const noBaseState = await makeTemp("repo-search-state-");
    const fallback = await runCli([
      "build", "--root", linked, "--state", noBaseState, "--models", modelsRoot, "--json",
    ]);
    assert.equal(fallback.code, 0, fallback.stderr);
    assert.equal(JSON.parse(fallback.stdout.trim()).receipt.generationKind, "full");
  },
);

test("corrupt and symlinked state return structured corrupt receipts", { timeout: 60000 }, async () => {
  const repo = await initFixtureRepo();
  const state = await makeTemp("repo-search-state-");
  const dbPath = join(state, "state.sqlite");
  await writeFile(dbPath, "not a sqlite database\n", { mode: 0o600 });
  await chmod(dbPath, 0o600);

  for (const args of [
    ["status", "--root", repo, "--state", state, "--json"],
    ["prune", "--state", state, "--json"],
  ]) {
    const result = await runCli(args);
    assert.equal(result.code, 3, result.stderr);
    const receipt = JSON.parse(result.stdout.trim());
    assert.equal(receipt.status, "unavailable");
    assert.equal(receipt.reason, "corrupt");
  }

  const symlinkState = await makeTemp("repo-search-state-");
  const target = await makeTemp("repo-search-target-");
  await writeFile(join(target, "elsewhere.sqlite"), "not a database\n", { mode: 0o600 });
  await symlink(join(target, "elsewhere.sqlite"), join(symlinkState, "state.sqlite"));
  const symlinked = await runCli(["status", "--root", repo, "--state", symlinkState, "--json"]);
  assert.equal(symlinked.code, 3, symlinked.stderr);
  const symlinkReceipt = JSON.parse(symlinked.stdout.trim());
  assert.equal(symlinkReceipt.status, "unavailable");
  assert.equal(symlinkReceipt.reason, "corrupt");
});
