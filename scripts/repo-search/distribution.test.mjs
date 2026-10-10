// Distribution tests: five skills, portable copy/link installation and
// the private opt-in bundle. All fixtures live under mkdtemp(tmpdir()) with a
// synthetic HOME. The final package build and install run for real; no model or
// network acquisition occurs.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCheckout } from "./identity.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const checkoutRoot = join(moduleDir, "..", "..");
const buildScript = join(checkoutRoot, "scripts", "build-skill-bundles.sh");
const CODE_MODEL_ID = "jinaai/jina-embeddings-v2-base-code";
const SKILL_NAMES = [
  "repo-search",
  "repo-search-install",
  "repo-search-index",
  "repo-search-status",
  "repo-search-setup",
];

const tempDirs = [];
let tmpDist;
let unrelatedCwd;
let bunPath;

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

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function readHelperBlock(skillPath) {
  const text = readFileSync(skillPath, "utf8");
  const start = text.indexOf("<!-- repo-search-helper -->");
  const endMarker = "<!-- /repo-search-helper -->";
  const end = text.indexOf(endMarker);
  assert.notEqual(start, -1, `${skillPath}: missing helper marker`);
  assert.notEqual(end, -1, `${skillPath}: missing helper end marker`);
  return text.slice(start, end + endMarker.length);
}

function sourceSkillPath(name) {
  return join(checkoutRoot, "skills", name, "SKILL.md");
}

before(async () => {
  unrelatedCwd = await makeTemp("repo-search-dist-cwd-");
  bunPath = findBun();
  tmpDist = await makeTemp("repo-search-dist-");
  const built = run("bash", [buildScript], {
    cwd: checkoutRoot,
    env: { ...process.env, DIST: tmpDist, VERSION: "test", REPO_SEARCH_BUNDLE: "1" },
  });
  assert.equal(built.status, 0, built.stderr);
});

async function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(abs, base)));
    } else {
      out.push(relative(base, abs));
    }
  }
  return out;
}

async function initFixtureRepo() {
  const dir = await makeTemp("repo-search-dist-repo-");
  const git = (args) => {
    const result = run("git", args, { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  await writeFile(
    join(dir, "mod.ts"),
    "export function distFixture(): number {\n  return 41;\n}\n",
    "utf8",
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);
  return dir;
}

async function installBundle(synthHome, mode) {
  const bundleDir = join(tmpDist, "repo-search");
  const installed = run(
    "bash",
    [join(bundleDir, "install.sh"), "--target", "agents", "--mode", mode],
    { cwd: bundleDir, env: { ...process.env, HOME: synthHome } },
  );
  assert.equal(installed.status, 0, installed.stderr);
}

function installDependencies(installedHelper) {
  const result = run(bunPath, ["install", "--frozen-lockfile"], {
    cwd: installedHelper,
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr);
}

function runInstalledCli(cliPath, args, synthHome) {
  return run(process.execPath, [cliPath, ...args], {
    cwd: unrelatedCwd,
    env: { ...process.env, HOME: synthHome },
  });
}

test("copy and link layouts resolve the same helper from an unrelated cwd", { timeout: 600000 }, async () => {
  const repo = await initFixtureRepo();
  const identity = await resolveCheckout(repo);
  const blockPaths = SKILL_NAMES.map(sourceSkillPath);
  const blocks = blockPaths.map(readHelperBlock);
  for (const block of blocks) {
    assert.equal(block, blocks[0], "helper blocks must be byte-equal");
    assert.match(block, /REPO_SEARCH_HELPER/);
    assert.match(block, /~\/\.agents\/scripts\/repo-search/);
    assert.match(block, /scripts\/repo-search/);
    assert.match(block, /not\s+installed/);
    assert.match(block, /Never install, download, build, or enroll/);
  }

  for (const mode of ["copy", "link"]) {
    const synthHome = await makeTemp(`repo-search-dist-home-${mode}-`);
    await installBundle(synthHome, mode);

    for (const name of SKILL_NAMES) {
      const skillDir = join(synthHome, ".agents", "skills", name);
      assert.ok(existsSync(join(skillDir, "SKILL.md")), `${mode}: ${name} SKILL.md`);
      if (mode === "link") {
        assert.ok(lstatSync(skillDir).isSymbolicLink(), `${mode}: ${name} is a symlink`);
      }
    }

    const installedHelper = join(synthHome, ".agents", "scripts", "repo-search");
    for (const file of ["cli.mjs", "package.json", "worker.ts", "core/codeIndexRuntime.ts"]) {
      assert.ok(existsSync(join(installedHelper, file)), `${mode}: helper ${file}`);
    }

    const depDir = lstatSync(installedHelper).isSymbolicLink()
      ? readlinkSync(installedHelper)
      : installedHelper;
    installDependencies(depDir);

    const state = await makeTemp(`repo-search-dist-state-${mode}-`);
    const status = runInstalledCli(
      join(installedHelper, "cli.mjs"),
      ["status", "--root", repo, "--state", state, "--json"],
      synthHome,
    );
    assert.equal(status.status, 0, `${mode}: ${status.stderr}`);
    const receipt = JSON.parse(status.stdout.trim());
    assert.equal(receipt.checkoutKey, identity.checkoutKey);
  }

  // Link mode installed dependencies through the symlink into the shared bundle;
  // remove them so the bundle returns to exact-source composition for later tests.
  await rm(join(tmpDist, "repo-search", "scripts", "repo-search", "node_modules"), {
    recursive: true,
    force: true,
  });

  // Source layout works from an unrelated cwd.
  const sourceState = await makeTemp("repo-search-dist-source-state-");
  const sourceStatus = run(
    process.execPath,
    [join(moduleDir, "cli.mjs"), "status", "--root", repo, "--state", sourceState, "--json"],
    { cwd: unrelatedCwd, env: process.env },
  );
  assert.equal(sourceStatus.status, 0, sourceStatus.stderr);
  assert.equal(JSON.parse(sourceStatus.stdout.trim()).checkoutKey, identity.checkoutKey);
});

test("default bundle excludes the private engine; private bundle has exact sources", { timeout: 120000 }, async () => {
  const specBundle = join(tmpDist, "spec-skills");
  assert.ok(existsSync(join(specBundle, "bundle.json")));
  assert.equal(existsSync(join(specBundle, "scripts", "repo-search")), false);
  assert.equal(
    existsSync(join(specBundle, "scripts", "repo-search", "core", "codeIndexRuntime.ts")),
    false,
  );
  const specManifest = JSON.parse(readFileSync(join(specBundle, "bundle.json"), "utf8"));
  for (const name of SKILL_NAMES) {
    assert.equal(specManifest.skills.includes(name), false, `spec-skills must not list ${name}`);
  }

  const repoBundle = join(tmpDist, "repo-search");
  const required = [
    ...SKILL_NAMES.map((name) => join("skills", name, "SKILL.md")),
    "skills/repo-search-setup/scripts/setup.mjs",
    "skills/repo-search-setup/references/setup-and-recovery.md",
    "scripts/repo-search/package.json",
    "scripts/repo-search/bun.lock",
    "scripts/repo-search/README.md",
    "scripts/repo-search/SOURCE.md",
    "scripts/repo-search/NOTICE",
    "scripts/repo-search/cli.mjs",
    "scripts/repo-search/worker.ts",
    "scripts/repo-search/lifecycle.ts",
    "scripts/repo-search/state.ts",
    "scripts/repo-search/search.ts",
    "scripts/repo-search/core/codeIndexRuntime.ts",
    "scripts/repo-search/core/codeEmbeddingRuntime.ts",
  ];
  const files = await walkFiles(repoBundle);
  const fileSet = new Set(files);
  for (const rel of required) {
    assert.ok(fileSet.has(rel), `repo-search bundle missing ${rel}`);
  }
  for (const rel of files) {
    assert.equal(rel.includes("node_modules"), false, `excluded node_modules: ${rel}`);
    assert.equal(rel.endsWith(".onnx"), false, `excluded onnx: ${rel}`);
    assert.equal(rel.endsWith(".sqlite"), false, `excluded sqlite: ${rel}`);
    assert.equal(rel.includes(".test."), false, `excluded test: ${rel}`);
    assert.equal(rel.split("/").includes("models"), false, `excluded models: ${rel}`);
  }
});

test("installed lifecycle recipes preserve prior current across a failed rebuild", { timeout: 600000 }, async () => {
  const synthHome = await makeTemp("repo-search-dist-lifecycle-home-");
  await installBundle(synthHome, "copy");
  const installedHelper = join(synthHome, ".agents", "scripts", "repo-search");
  installDependencies(installedHelper);

  const repo = await initFixtureRepo();
  const identity = await resolveCheckout(repo);
  const stateRoot = await makeTemp("repo-search-dist-lifecycle-state-");
  const modelsBase = await makeTemp("repo-search-dist-lifecycle-models-");
  const modelsRoot = join(modelsBase, "models");
  const modelDir = join(modelsRoot, CODE_MODEL_ID);
  await mkdir(modelDir, { recursive: true });
  const fixtureFiles = [
    { path: "config.json", bytes: Buffer.from('{"fixture":true}\n') },
    { path: "weights.bin", bytes: Buffer.from("fixture weights\n") },
  ];
  const specs = [];
  for (const file of fixtureFiles) {
    await writeFile(join(modelDir, file.path), file.bytes);
    specs.push({
      path: file.path,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    });
  }
  const manifestPath = join(modelsBase, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(specs), "utf8");

  const fixtureScriptPath = join(installedHelper, "__fixture_build.ts");
  const fixtureScript = [
    'import { createHash } from "node:crypto";',
    'import { readFileSync } from "node:fs";',
    'import { resolveCheckout } from "./identity.mjs";',
    'import { openState } from "./state.ts";',
    'import { buildPrimary } from "./lifecycle.ts";',
    'import { CODE_INDEX_DIMENSIONS } from "./core/embeddingContract.ts";',
    'import { CODE_MODEL_ID } from "./core/codeModelAssets.ts";',
    "",
    "const [repo, stateRoot, modelsRoot, manifestPath] = process.argv.slice(2);",
    'const modelAssets = JSON.parse(readFileSync(manifestPath, "utf8"));',
    "",
    "function deterministicVector(text) {",
    '  const digest = createHash("sha256").update(text, "utf8").digest();',
    "  return Array.from({ length: CODE_INDEX_DIMENSIONS }, (_, index) => digest[index % digest.length] / 255);",
    "}",
    "",
    "const createEmbeddingRuntime = async () => ({",
    "  modelId: CODE_MODEL_ID,",
    "  dimensions: CODE_INDEX_DIMENSIONS,",
    "  async embed(text) { return deterministicVector(text); },",
    "  async embedBatch(texts) { return texts.map((text) => deterministicVector(text)); },",
    "  async dispose() {},",
    "});",
    "",
    "const identity = await resolveCheckout(repo);",
    "const state = openState(stateRoot);",
    "try {",
    '  const receipt = await buildPrimary({ identity, state, modelsRoot, kind: "build", deps: { modelAssets, createEmbeddingRuntime } });',
    '  process.stdout.write(JSON.stringify({ generationId: receipt.generationId, availability: receipt.availability }) + "\\n");',
    "} finally {",
    "  state.close();",
    "}",
  ].join("\n");
  await writeFile(fixtureScriptPath, `${fixtureScript}\n`, "utf8");

  const built = run(
    bunPath,
    ["--no-install", fixtureScriptPath, repo, stateRoot, modelsRoot, manifestPath],
    { cwd: installedHelper, env: process.env },
  );
  assert.equal(built.status, 0, built.stderr);
  const generationId = JSON.parse(built.stdout.trim().split("\n").pop()).generationId;
  assert.equal(typeof generationId, "string");

  const installedCli = join(installedHelper, "cli.mjs");
  const status = runInstalledCli(
    installedCli,
    ["status", "--root", repo, "--state", stateRoot, "--json"],
    synthHome,
  );
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout.trim()).receipt.currentGenerationId, generationId);

  const check = runInstalledCli(
    installedCli,
    ["check", "--root", repo, "--state", stateRoot, "--json"],
    synthHome,
  );
  assert.equal(check.status, 0, check.stderr);

  const enrollmentPath = join(stateRoot, "checkouts", identity.checkoutKey, "enrollment.json");
  const on = runInstalledCli(
    installedCli,
    ["configure", "--root", repo, "--state", stateRoot, "--spec-use", "on", "--json"],
    synthHome,
  );
  assert.equal(on.status, 0, on.stderr);
  assert.equal(JSON.parse(readFileSync(enrollmentPath, "utf8")).specUse, true);
  const off = runInstalledCli(
    installedCli,
    ["configure", "--root", repo, "--state", stateRoot, "--spec-use", "off", "--json"],
    synthHome,
  );
  assert.equal(off.status, 0, off.stderr);
  assert.equal(JSON.parse(readFileSync(enrollmentPath, "utf8")).specUse, false);

  const failed = runInstalledCli(
    installedCli,
    ["reindex", "--root", repo, "--state", stateRoot, "--models", modelsRoot, "--json"],
    synthHome,
  );
  assert.equal(failed.status, 3, failed.stderr);
  assert.equal(JSON.parse(failed.stdout.trim()).reason, "model-unavailable");

  const after = runInstalledCli(
    installedCli,
    ["status", "--root", repo, "--state", stateRoot, "--json"],
    synthHome,
  );
  assert.equal(after.status, 0, after.stderr);
  assert.equal(JSON.parse(after.stdout.trim()).receipt.currentGenerationId, generationId);
});

test("missing optional dependencies report unavailable without side effects", { timeout: 300000 }, async () => {
  const synthHome = await makeTemp("repo-search-dist-missing-home-");
  await installBundle(synthHome, "copy");
  const installedHelper = join(synthHome, ".agents", "scripts", "repo-search");
  assert.equal(existsSync(join(installedHelper, "node_modules")), false);

  const repo = await initFixtureRepo();
  const state = join(synthHome, "state");
  const status = runInstalledCli(
    join(installedHelper, "cli.mjs"),
    ["status", "--root", repo, "--state", state, "--json"],
    synthHome,
  );
  assert.equal(status.status, 3, status.stderr);
  const receipt = JSON.parse(status.stdout.trim());
  assert.equal(receipt.status, "unavailable");
  assert.equal(receipt.reason, "dependencies-unavailable");
  assert.equal(existsSync(state), false);

  for (const name of SKILL_NAMES) {
    const block = readHelperBlock(sourceSkillPath(name));
    assert.match(block, /not\s+installed/);
    assert.match(block, /Never install, download, build, or enroll/);
    assert.equal(block.includes("bun install"), false, `${name}: no auto-install command`);
  }

  // Ordinary tooling remains unaffected: the default bundle is still built and
  // does not reference repo-search.
  const specBundle = join(tmpDist, "spec-skills");
  assert.ok(existsSync(join(specBundle, "bundle.json")));
  const specManifest = JSON.parse(readFileSync(join(specBundle, "bundle.json"), "utf8"));
  assert.equal(specManifest.skills.some((skill) => skill.startsWith("repo-search")), false);
});
