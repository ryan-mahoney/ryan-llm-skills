// Step 10 focused tests for the optional spec discovery adapter.
//
// The Pi host API is faked; the registration adapter, optional package
// resolution, client and worker stay real for the enabled case. No model
// inference or network occurs. All fixtures live under mkdtemp(tmpdir()).

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { registerRepositorySearch } from "./search.mjs";
import { resolveCheckout } from "../../../scripts/repo-search/identity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checkoutRoot = join(here, "..", "..", "..");
const repoPkg = join(checkoutRoot, "scripts", "repo-search");
const sourceCli = join(repoPkg, "cli.mjs");
const CODE_MODEL_ID = "jinaai/jina-embeddings-v2-base-code";
const TOKEN = "qsdistunique";

const tempDirs = [];
let synthHome;
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
    env: { ...process.env, HOME: synthHome },
    ...options,
  });
}

function fakePi() {
  const tools = new Map();
  return { registerTool(tool) { tools.set(tool.name, tool); }, tools };
}

function fakeClient(result) {
  const calls = [];
  return {
    calls,
    async searchRepository(input) {
      calls.push(input);
      return result;
    },
  };
}

function staticImportSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(/\bimport\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function git(cwd, args) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

before(async () => {
  synthHome = await makeTemp("spec-search-home-");
  bunPath = findBun();
});

async function initFixtureRepo() {
  const dir = await makeTemp("spec-search-repo-");
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "uniqueTokenFile.ts"), `export const marker = "${TOKEN}";\n`, "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "initial"]);
  return dir;
}

async function makeFixtureModels(base) {
  const modelsRoot = join(base, "models");
  const modelDir = join(modelsRoot, CODE_MODEL_ID);
  await mkdir(modelDir, { recursive: true });
  const files = [
    { path: "config.json", bytes: Buffer.from('{"fixture":true}\n') },
    { path: "weights.bin", bytes: Buffer.from("fixture weights\n") },
  ];
  const specs = [];
  for (const file of files) {
    await writeFile(join(modelDir, file.path), file.bytes);
    specs.push({ path: file.path, sha256: createHash("sha256").update(file.bytes).digest("hex") });
  }
  const manifestPath = join(base, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(specs), "utf8");
  return { modelsRoot, manifestPath };
}

async function buildFixtureGeneration(repo, stateRoot, modelsRoot, manifestPath) {
  const scriptPath = join(await makeTemp("spec-search-build-"), "fixture-build.ts");
  const script = [
    'import { createHash } from "node:crypto";',
    'import { readFileSync } from "node:fs";',
    `import { resolveCheckout } from ${JSON.stringify(pathToFileURL(join(repoPkg, "identity.mjs")).href)};`,
    `import { openState } from ${JSON.stringify(pathToFileURL(join(repoPkg, "state.ts")).href)};`,
    `import { buildPrimary } from ${JSON.stringify(pathToFileURL(join(repoPkg, "lifecycle.ts")).href)};`,
    `import { CODE_INDEX_DIMENSIONS } from ${JSON.stringify(pathToFileURL(join(repoPkg, "core", "embeddingContract.ts")).href)};`,
    `import { CODE_MODEL_ID } from ${JSON.stringify(pathToFileURL(join(repoPkg, "core", "codeModelAssets.ts")).href)};`,
    "",
    "const [repo, stateRoot, modelsRoot, manifestPath] = process.argv.slice(2);",
    'const modelAssets = JSON.parse(readFileSync(manifestPath, "utf8"));',
    "function deterministicVector(text) {",
    '  const digest = createHash("sha256").update(text, "utf8").digest();',
    "  return Array.from({ length: CODE_INDEX_DIMENSIONS }, (_, i) => digest[i % digest.length] / 255);",
    "}",
    "const createEmbeddingRuntime = async () => ({",
    "  modelId: CODE_MODEL_ID,",
    "  dimensions: CODE_INDEX_DIMENSIONS,",
    "  async embed(text) { return deterministicVector(text); },",
    "  async embedBatch(texts) { return texts.map((t) => deterministicVector(t)); },",
    "  async dispose() {},",
    "});",
    "const identity = await resolveCheckout(repo);",
    "const state = openState(stateRoot);",
    "try {",
    '  const receipt = await buildPrimary({ identity, state, modelsRoot, kind: "build", deps: { modelAssets, createEmbeddingRuntime } });',
    '  process.stdout.write(JSON.stringify({ generationId: receipt.generationId }) + "\\n");',
    "} finally { state.close(); }",
  ].join("\n");
  await writeFile(scriptPath, `${script}\n`, "utf8");
  const built = run(bunPath, ["--no-install", scriptPath, repo, stateRoot, modelsRoot, manifestPath], {
    cwd: repoPkg,
  });
  assert.equal(built.status, 0, built.stderr);
  return JSON.parse(built.stdout.trim().split("\n").pop()).generationId;
}

async function writeEnrollment(stateRoot, identity, specUse) {
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
    specUse,
    enrolledAt: new Date().toISOString(),
    head: identity.head,
    lastBuild: null,
    lastCheck: null,
  };
  const recordPath = join(checkoutDir, "enrollment.json");
  await writeFile(recordPath, JSON.stringify(record, null, 2), { mode: 0o600 });
  await chmod(recordPath, 0o600);
}

test("registered callback searches record.checkout and rejects a caller root", { timeout: 600000 }, async () => {
  const repo = await initFixtureRepo();
  const stateRoot = await makeTemp("spec-search-state-");
  const modelsBase = await makeTemp("spec-search-models-");
  const { modelsRoot, manifestPath } = await makeFixtureModels(modelsBase);
  await buildFixtureGeneration(repo, stateRoot, modelsRoot, manifestPath);

  const configure = run(process.execPath, [sourceCli, "configure", "--root", repo, "--state", stateRoot, "--spec-use", "on", "--json"]);
  assert.equal(configure.status, 0, configure.stderr);

  const pi = fakePi();
  registerRepositorySearch(pi, { id: "run-1", checkout: repo });
  const tool = pi.tools.get("spec_search");
  assert.ok(tool, "spec_search registered");

  const response = await tool.execute(
    "call-1",
    { query: TOKEN, mode: "bm25", state: stateRoot },
    new AbortController().signal,
  );
  assert.equal(response.details.status, "ok", JSON.stringify(response.details));
  assert.ok(
    response.details.hits.some((hit) => hit.path === "src/uniqueTokenFile.ts"),
    `expected fixture candidate, got ${JSON.stringify(response.details.hits)}`,
  );

  const otherRepo = await initFixtureRepo();
  const rejected = await tool.execute(
    "call-2",
    { query: TOKEN, mode: "bm25", root: otherRepo, state: stateRoot },
    new AbortController().signal,
  );
  assert.equal(rejected.details.status, "unavailable");
  assert.equal(rejected.details.reason, "root-not-allowed");
  assert.ok(rejected.details.fallback);
});

test("a stale-only registered result keeps identity and returns exact fallback", { timeout: 600000 }, async () => {
  const repo = await initFixtureRepo();
  const stateRoot = await makeTemp("spec-search-stale-state-");
  const modelsBase = await makeTemp("spec-search-stale-models-");
  const { modelsRoot, manifestPath } = await makeFixtureModels(modelsBase);
  const generationId = await buildFixtureGeneration(repo, stateRoot, modelsRoot, manifestPath);
  const configure = run(process.execPath, [sourceCli, "configure", "--root", repo, "--state", stateRoot, "--spec-use", "on", "--json"]);
  assert.equal(configure.status, 0, configure.stderr);

  // Change the indexed file without rebuilding: BM25 still returns the old
  // candidate, and source-hash validation must omit it as stale.
  await writeFile(join(repo, "src", "uniqueTokenFile.ts"), `export const marker = "${TOKEN}";\n// edited after build\n`, "utf8");
  const identity = await resolveCheckout(repo);

  const pi = fakePi();
  registerRepositorySearch(pi, { id: "run-stale", checkout: repo });
  const response = await pi.tools.get("spec_search").execute(
    "call-stale",
    { query: TOKEN, mode: "bm25", state: stateRoot },
    new AbortController().signal,
  );
  const details = response.details;
  assert.equal(details.status, "ok", JSON.stringify(details));
  assert.equal(details.freshness, "stale");
  assert.equal(details.reason, "stale");
  assert.ok(details.fallback);
  assert.deepEqual(details.hits, []);
  assert.equal(details.repoKey, identity.repoKey);
  assert.equal(details.checkoutKey, identity.checkoutKey);
  assert.equal(details.requestedRoot, identity.root);
  assert.equal(details.actualRoot, identity.root);
  assert.equal(details.observedHead, identity.head);
  assert.equal(details.generationId, generationId);
  assert.equal(details.baseId, null);
  assert.ok(details.coverage.staleHits >= 1, JSON.stringify(details.coverage));
  assert.ok(details.timing.elapsedMs >= 0);
});

test("disabled, unenrolled and missing-package paths fall back without state changes", { timeout: 120000 }, async () => {
  const repo = await initFixtureRepo();
  const identity = await resolveCheckout(repo);

  // Unenrolled: no enrollment record, no state directory.
  const unenrolledState = join(await makeTemp("spec-search-unenrolled-"), "state");
  const piUnenrolled = fakePi();
  registerRepositorySearch(piUnenrolled, { id: "run-u", checkout: repo });
  const unenrolled = await piUnenrolled.tools.get("spec_search").execute(
    "call-u",
    { query: TOKEN, mode: "bm25", state: unenrolledState },
    new AbortController().signal,
  );
  assert.equal(unenrolled.details.status, "skipped");
  assert.equal(unenrolled.details.reason, "unenrolled");
  assert.ok(unenrolled.details.fallback);
  assert.equal(existsSync(unenrolledState), false);

  // Disabled: a valid enrollment with specUse false.
  const disabledState = await makeTemp("spec-search-disabled-");
  await writeEnrollment(disabledState, identity, false);
  const piDisabled = fakePi();
  registerRepositorySearch(piDisabled, { id: "run-d", checkout: repo });
  const disabled = await piDisabled.tools.get("spec_search").execute(
    "call-d",
    { query: TOKEN, mode: "bm25", state: disabledState },
    new AbortController().signal,
  );
  assert.equal(disabled.details.status, "skipped");
  assert.equal(disabled.details.reason, "disabled");
  assert.ok(disabled.details.fallback);

  // Missing optional package: resolveClient returns null, nothing spawned.
  const missingState = join(await makeTemp("spec-search-missing-"), "state");
  const piMissing = fakePi();
  registerRepositorySearch(piMissing, { id: "run-m", checkout: repo }, { resolveClient: () => null });
  const missing = await piMissing.tools.get("spec_search").execute(
    "call-m",
    { query: TOKEN },
    new AbortController().signal,
  );
  assert.equal(missing.details.status, "unavailable");
  assert.equal(missing.details.reason, "package-unavailable");
  assert.ok(missing.details.fallback);
  assert.equal(existsSync(missingState), false);
});

test("timeout and busy results return fallback without build or install calls", { timeout: 60000 }, async () => {
  for (const reason of ["timeout", "busy"]) {
    const client = fakeClient({ status: "unavailable", reason });
    const pi = fakePi();
    registerRepositorySearch(pi, { id: `run-${reason}`, checkout: "/fixture" }, {
      resolveClient: () => client,
      remainingMs: 15000,
    });
    const response = await pi.tools.get("spec_search").execute(
      "call",
      { query: TOKEN },
      new AbortController().signal,
    );
    assert.equal(response.details.status, "unavailable");
    assert.equal(response.details.reason, reason);
    assert.ok(response.details.fallback);
    assert.equal(client.calls.length, 1);
    assert.ok(client.calls[0].timeoutMs <= 14000);
    assert.deepEqual(Object.keys(client).filter((key) => key !== "calls"), ["searchRepository"]);
  }
});

test("the adapter bounds the budget to 15s or remaining caller time", { timeout: 60000 }, async () => {
  const defaultClient = fakeClient({ status: "ok", hits: [], coverage: {} });
  const piDefault = fakePi();
  registerRepositorySearch(piDefault, { id: "run-b1", checkout: "/fixture" }, {
    resolveClient: () => defaultClient,
  });
  await piDefault.tools.get("spec_search").execute("call", { query: TOKEN }, new AbortController().signal);
  assert.equal(defaultClient.calls[0].timeoutMs, 15000);

  const remainingClient = fakeClient({ status: "ok", hits: [], coverage: {} });
  const piRemaining = fakePi();
  registerRepositorySearch(piRemaining, { id: "run-b2", checkout: "/fixture" }, {
    resolveClient: () => remainingClient,
    remainingMs: 5000,
  });
  await piRemaining.tools.get("spec_search").execute("call", { query: TOKEN }, new AbortController().signal);
  assert.equal(remainingClient.calls[0].timeoutMs, 4000);

  // Less than 500ms of query budget remains: skip before any worker starts.
  const skipClient = fakeClient({ status: "ok", hits: [], coverage: {} });
  const piSkip = fakePi();
  registerRepositorySearch(piSkip, { id: "run-b4", checkout: "/fixture" }, {
    resolveClient: () => skipClient,
    remainingMs: 1200,
  });
  const skipped = await piSkip.tools.get("spec_search").execute("call", { query: TOKEN }, new AbortController().signal);
  assert.equal(skipped.details.status, "skipped");
  assert.equal(skipped.details.reason, "budget-exceeded");
  assert.ok(skipped.details.fallback);
  assert.equal(skipClient.calls.length, 0);

  for (const call of [...defaultClient.calls, ...remainingClient.calls]) {
    assert.notEqual(call.timeoutMs, 120000);
  }

  // Registration alone performs no work; direct known-file reads need no search.
  const idleClient = fakeClient({ status: "ok", hits: [], coverage: {} });
  const piIdle = fakePi();
  registerRepositorySearch(piIdle, { id: "run-b3", checkout: "/fixture" }, {
    resolveClient: () => idleClient,
  });
  assert.equal(idleClient.calls.length, 0);
});

test("the adapter derives the live assignment budget from the runtime deadline", { timeout: 60000 }, async () => {
  const cappedClient = fakeClient({ status: "ok", hits: [], coverage: {} });
  const piCapped = fakePi();
  registerRepositorySearch(piCapped, {
    id: "run-capped", checkout: "/fixture",
    started_at: new Date().toISOString(), timeout_ms: 7200000,
  }, { resolveClient: () => cappedClient });
  await piCapped.tools.get("spec_search").execute("call", { query: TOKEN }, new AbortController().signal);
  assert.equal(cappedClient.calls[0].timeoutMs, 15000);

  // An exhausted assignment deadline skips before any worker is launched.
  const exhaustedClient = fakeClient({ status: "ok", hits: [], coverage: {} });
  const piExhausted = fakePi();
  registerRepositorySearch(piExhausted, {
    id: "run-exhausted", checkout: "/fixture",
    started_at: new Date(Date.now() - 20000).toISOString(), timeout_ms: 20000,
  }, { resolveClient: () => exhaustedClient });
  const exhausted = await piExhausted.tools.get("spec_search").execute("call", { query: TOKEN }, new AbortController().signal);
  assert.equal(exhausted.details.status, "skipped");
  assert.equal(exhausted.details.reason, "budget-exceeded");
  assert.ok(exhausted.details.fallback);
  assert.equal(exhaustedClient.calls.length, 0);

  // The production registration (no injected dependencies) must reach the same
  // skip from the record deadline without loading a search worker.
  const piProduction = fakePi();
  registerRepositorySearch(piProduction, {
    id: "run-production", checkout: checkoutRoot,
    started_at: new Date(Date.now() - 20000).toISOString(), timeout_ms: 20000,
  });
  const production = await piProduction.tools.get("spec_search").execute("call", { query: TOKEN }, new AbortController().signal);
  assert.equal(production.details.status, "skipped");
  assert.equal(production.details.reason, "budget-exceeded");
  assert.ok(production.details.fallback);

  // Near the deadline the query budget charges preflight elapsed time and
  // reserves the cleanup second instead of restarting at the 15s cap.
  const liveClient = fakeClient({ status: "ok", hits: [], coverage: {} });
  const piLive = fakePi();
  registerRepositorySearch(piLive, {
    id: "run-live", checkout: "/fixture",
    started_at: new Date(Date.now() - 5000).toISOString(), timeout_ms: 20000,
  }, {
    resolveClient: async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return liveClient;
    },
  });
  await piLive.tools.get("spec_search").execute("call", { query: TOKEN }, new AbortController().signal);
  assert.equal(liveClient.calls.length, 1);
  assert.ok(liveClient.calls[0].timeoutMs > 0);
  assert.ok(liveClient.calls[0].timeoutMs <= 13500, `expected a preflight-charged budget, got ${liveClient.calls[0].timeoutMs}`);
});

test("wiring parity and import hygiene", { timeout: 60000 }, async () => {
  const indexText = await readFile(join(here, "index.ts"), "utf8");
  const runtimeText = await readFile(join(here, "runtime.mjs"), "utf8");
  const searchText = await readFile(join(here, "search.mjs"), "utf8");

  assert.match(indexText, /registerRepositorySearch\(pi, record\)/);
  const allowedMatch = /const allowed = role === 'owner' \? \[([^\]]*)\] : \[([^\]]*)\];/.exec(indexText);
  assert.ok(allowedMatch, "owner/editor allowlist literals present");
  assert.match(allowedMatch[1], /'spec_search'/);
  assert.doesNotMatch(allowedMatch[2], /'spec_search'/);
  assert.match(
    runtimeText,
    /role === 'owner' \? 'read,grep,find,ls,spec_editor,spec_answer,spec_verify,spec_scout,spec_search,spec_advice,spec_complete'/,
  );
  const toolsMatch = /--tools',\s*role === 'owner' \? '([^']*)' : '([^']*)'/.exec(runtimeText);
  assert.ok(toolsMatch, "owner/editor tool lists present");
  assert.equal(toolsMatch[1].split(",").includes("spec_search"), true);
  assert.equal(toolsMatch[2].split(",").includes("spec_search"), false);

  const specifiers = staticImportSpecifiers(searchText);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    assert.equal(specifier.includes("client.mjs"), false, `module-scope client import: ${specifier}`);
    assert.equal(specifier.startsWith("bun:"), false, `bun import: ${specifier}`);
    assert.equal(specifier.includes("onnx"), false, `onnx import: ${specifier}`);
    assert.equal(specifier.includes("@huggingface"), false, `transformers import: ${specifier}`);
    assert.equal(specifier.includes("@earendil"), false, `pi import: ${specifier}`);
  }
});
