// Step 8 focused integration tests for explicit setup.
//
// All fixtures live under mkdtemp(tmpdir()); every state root is under a tmp
// HOME or an explicit temp path. The final package-manager spawn is faked, and
// model bytes are disposable fixtures. Owned children and temp dirs are cleaned
// up in `after`.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { runInstall } from "./setup.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));

const tempDirs = [];

async function makeTemp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
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

function runProcess(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { ...options, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function makeFakeExitChild(code) {
  const child = new EventEmitter();
  child.pid = 900000 + Math.floor(Math.random() * 1000);
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  setImmediate(() => {
    child.stdout.end();
    child.stderr.end();
    child.exitCode = code;
    child.emit("close", code, null);
  });
  return child;
}

function makeInstallSpawn(realSpawn) {
  const calls = [];
  const fake = (file, args, options) => {
    calls.push({ file, args: [...args], options });
    if (args[0] === "install") return makeFakeExitChild(0);
    return realSpawn(file, args, options);
  };
  fake.calls = calls;
  return fake;
}

async function buildFixtureModels(modelsRoot) {
  const modelDir = join(modelsRoot, "jinaai", "jina-embeddings-v2-base-code");
  await mkdir(modelDir, { recursive: true });
  const files = [
    { path: "config.json", bytes: Buffer.from('{"fixture":true}\n') },
    { path: "weights.bin", bytes: Buffer.from("fixture weights bytes\n") },
  ];
  for (const file of files) {
    await writeFile(join(modelDir, file.path), file.bytes);
  }
  return files.map((file) => ({ path: file.path, sha256: sha256Hex(file.bytes) }));
}

async function fixtureHashes(modelsRoot) {
  const modelDir = join(modelsRoot, "jinaai", "jina-embeddings-v2-base-code");
  const result = {};
  for (const name of await readdir(modelDir)) {
    result[name] = sha256Hex(await readFile(join(modelDir, name)));
  }
  return result;
}

test("install spawns exactly the frozen-lockfile package-manager argv", { timeout: 60000 }, async () => {
  const packageDir = await makeTemp("repo-search-install-pkg-");
  const fakeSpawn = makeInstallSpawn(spawn);

  const result = await runInstall({ packageDir, bunPath: realBun, spawn: fakeSpawn });
  assert.equal(result.status, "ok");
  assert.equal(result.exitCode, 0);
  assert.equal(result.receipt.install.ok, true);
  assert.equal(result.receipt.install.exitCode, 0);

  assert.equal(fakeSpawn.calls.length, 1);
  const call = fakeSpawn.calls[0];
  assert.equal(call.file, realBun);
  assert.deepEqual(call.args, ["install", "--frozen-lockfile"]);
  assert.equal(call.options.cwd, packageDir);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.shell, undefined);
  assert.equal(call.args.includes("--root"), false);
  assert.equal(call.args.some((arg) => arg.includes(packageDir)), false);

  assert.equal(existsSync(join(packageDir, "settings.json")), false);
  assert.equal(existsSync(join(packageDir, "checkouts")), false);
});

test("repeated model configuration is idempotent and preserves prior settings", { timeout: 120000 }, async () => {
  const root = await makeTemp("repo-search-models-");
  const modelsRoot = join(root, "models");
  const manifest = await buildFixtureModels(modelsRoot);
  const stateRoot = join(root, "state");
  const fakeSpawn = makeInstallSpawn(spawn);
  const canonicalRoot = realpathSync(modelsRoot);

  const first = await runInstall({
    packageDir: moduleDir,
    bunPath: realBun,
    spawn: fakeSpawn,
    modelsRoot,
    stateRoot,
    modelAssets: manifest,
  });
  assert.equal(first.status, "ok", JSON.stringify(first));
  assert.equal(first.receipt.install.ok, true);
  assert.equal(first.receipt.model.saved, true);
  assert.equal(first.receipt.model.alreadyConfigured, false);
  assert.equal(first.receipt.model.modelsRoot, canonicalRoot);
  assert.match(first.receipt.model.assetDigest, /^[0-9a-f]{64}$/);

  const settingsPath = join(stateRoot, "settings.json");
  const settingsBytes = await readFile(settingsPath);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  const settings = JSON.parse(settingsBytes.toString("utf8"));
  assert.equal(settings.version, 1);
  assert.equal(settings.modelsRoot, canonicalRoot);
  assert.equal(settings.assetDigest, first.receipt.model.assetDigest);

  const hashesBefore = await fixtureHashes(modelsRoot);

  const second = await runInstall({
    packageDir: moduleDir,
    bunPath: realBun,
    spawn: fakeSpawn,
    modelsRoot,
    stateRoot,
    modelAssets: manifest,
  });
  assert.equal(second.status, "ok");
  assert.equal(second.receipt.model.saved, false);
  assert.equal(second.receipt.model.alreadyConfigured, true);
  assert.deepEqual(await readFile(settingsPath), settingsBytes);

  const alias = join(root, "models-alias");
  await symlink(modelsRoot, alias, "dir");
  const viaAlias = await runInstall({
    packageDir: moduleDir,
    bunPath: realBun,
    spawn: fakeSpawn,
    modelsRoot: alias,
    stateRoot,
    modelAssets: manifest,
  });
  assert.equal(viaAlias.status, "ok");
  assert.equal(viaAlias.receipt.model.modelsRoot, canonicalRoot);
  assert.equal(viaAlias.receipt.model.assetDigest, first.receipt.model.assetDigest);
  assert.equal(viaAlias.receipt.model.alreadyConfigured, true);
  assert.deepEqual(await readFile(settingsPath), settingsBytes);

  await writeFile(
    join(modelsRoot, "jinaai", "jina-embeddings-v2-base-code", "config.json"),
    "truncated",
  );
  const truncated = await runInstall({
    packageDir: moduleDir,
    bunPath: realBun,
    spawn: fakeSpawn,
    modelsRoot,
    stateRoot,
    modelAssets: manifest,
  });
  assert.equal(truncated.status, "unavailable");
  assert.equal(truncated.reason, "model-unavailable");
  assert.equal(truncated.exitCode, 3);
  assert.equal(truncated.receipt.install.ok, true);
  assert.deepEqual(await readFile(settingsPath), settingsBytes);

  const hashesAfter = await fixtureHashes(modelsRoot);
  assert.notDeepEqual(hashesAfter["config.json"], hashesBefore["config.json"]);
  assert.equal(hashesAfter["weights.bin"], hashesBefore["weights.bin"]);
});

test("install without models creates no lifecycle state", { timeout: 60000 }, async () => {
  const root = await makeTemp("repo-search-effects-");
  const stateRoot = join(root, "state");
  const fakeSpawn = makeInstallSpawn(spawn);

  const result = await runInstall({
    packageDir: moduleDir,
    bunPath: realBun,
    spawn: fakeSpawn,
    stateRoot,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.exitCode, 0);
  assert.equal(result.receipt.install.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result.receipt, "model"), false);

  assert.equal(existsSync(stateRoot), false);
  assert.equal(existsSync(join(stateRoot, "settings.json")), false);
  assert.equal(existsSync(join(stateRoot, "state.sqlite")), false);
  assert.equal(existsSync(join(stateRoot, "checkouts")), false);
  assert.equal(existsSync(join(stateRoot, "generations")), false);
});

test("disposable copied package installs through the real CLI", { timeout: 300000 }, async () => {
  const copyRoot = await makeTemp("repo-search-copy-");
  const files = [
    "package.json",
    "bun.lock",
    "cli.mjs",
    "client.mjs",
    "setup.mjs",
    "worker.ts",
    "identity.mjs",
    "format.mjs",
    "lifecycle.ts",
    "state.ts",
    "source.ts",
    "search.ts",
  ];
  for (const file of files) {
    await copyFile(join(moduleDir, file), join(copyRoot, file));
  }
  await cp(join(moduleDir, "core"), join(copyRoot, "core"), { recursive: true });

  const home = await makeTemp("repo-search-home-");
  const cwd = await makeTemp("repo-search-cwd-");
  const packageBefore = await readFile(join(copyRoot, "package.json"));
  const lockBefore = await readFile(join(copyRoot, "bun.lock"));

  const result = await runProcess(
    process.execPath,
    [join(copyRoot, "cli.mjs"), "install", "--json"],
    { cwd, env: { ...process.env, HOME: home } },
  );
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.status, "ok");
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.receipt.install.exitCode, 0);
  assert.ok(existsSync(join(copyRoot, "node_modules")));
  assert.deepEqual(await readFile(join(copyRoot, "package.json")), packageBefore);
  assert.deepEqual(await readFile(join(copyRoot, "bun.lock")), lockBefore);
  assert.equal(existsSync(join(home, ".cache", "agent-repo-search")), false);
});
