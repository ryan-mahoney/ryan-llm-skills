// Test-first Step 7 finite search-session contract.
//
// Production `./search` does not exist yet: these cases define the planned
// public API and are expected to fail until it is implemented. Real state,
// source capture, Orama persistence and pins are used; only final model
// inference may be substituted through the internal deps seam.
//
// Assumed public surface:
//   createSearchSession({identity,state,modelsRoot?,signal?,deps?})
//     -> { search(query,mode:"vector"|"bm25",limit), dispose() }
//   SearchResult = { hits: SearchHit[], coverage: SearchCoverage }
//   SearchHit = { path, startLine, endLine, symbol, score, fileHash, excerpt }
//   SearchCoverage = { policy, indexedFiles, excluded, completeness:
//     "unknown"|"partial", staleHits, omittedHits, candidateLimitReached }

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CODE_INDEX_DIMENSIONS } from "./core/embeddingContract";
import type { CodeEmbeddingRuntime } from "./core/codeEmbeddingRuntime";
import { CODE_MODEL_ID, type CodeModelAssetSpec } from "./core/codeModelAssets";
import { resolveCheckout } from "./identity.mjs";
import { openState } from "./state";
import { buildPrimary, buildWorktree } from "./lifecycle";
import { createSearchSession } from "./search";
import { formatSearchHuman, formatSearchJson } from "./format.mjs";

setDefaultTimeout(30_000);

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-search-search-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(repo: string, relPath: string, content: string): void {
  const absolute = join(repo, relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function hashFile(repo: string, relPath: string): string {
  return createHash("sha256").update(readFileSync(join(repo, relPath))).digest("hex");
}

function makeRepo(base: string): string {
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  return repo;
}

function commitAll(repo: string, message = "fixture"): void {
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=Search Fixture",
    "-c",
    "user.email=search@example.invalid",
    "commit",
    "-qm",
    message,
  );
}

function addWorktree(repo: string, path: string, branch: string): void {
  mkdirSync(dirname(path), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", branch, path, "HEAD");
}

function makeModelFixture(base: string): { modelsRoot: string; specs: CodeModelAssetSpec[] } {
  const modelsRoot = join(base, "models");
  const modelDir = join(modelsRoot, CODE_MODEL_ID);
  mkdirSync(modelDir, { recursive: true });
  const specs: CodeModelAssetSpec[] = [];
  for (const [path, content] of Object.entries({ "config.json": "{}\n", "vocab.json": "[]\n" })) {
    writeFileSync(join(modelDir, path), content);
    specs.push({ path, sha256: createHash("sha256").update(content, "utf8").digest("hex") });
  }
  return { modelsRoot, specs };
}

function deterministicVector(text: string): number[] {
  const digest = createHash("sha256").update(text, "utf8").digest();
  return Array.from(
    { length: CODE_INDEX_DIMENSIONS },
    (_, index) => digest[index % digest.length] / 255,
  );
}

type RuntimeSeam = {
  creations: number;
  embeds: number;
  disposes: number;
};

function runtimeSeam(): {
  state: RuntimeSeam;
  factory: (input: any) => Promise<CodeEmbeddingRuntime>;
} {
  const state: RuntimeSeam = { creations: 0, embeds: 0, disposes: 0 };
  return {
    state,
    factory: async () => {
      state.creations += 1;
      return {
        modelId: CODE_MODEL_ID,
        dimensions: CODE_INDEX_DIMENSIONS,
        async embed(text) {
          state.embeds += 1;
          return deterministicVector(text);
        },
        async embedBatch(texts) {
          return texts.map((text) => {
            state.embeds += 1;
            return deterministicVector(text);
          });
        },
        async dispose() {
          state.disposes += 1;
        },
      };
    },
  };
}

type Fixture = {
  repo: string;
  identity: any;
  state: any;
  modelsRoot: string;
  specs: CodeModelAssetSpec[];
  stateRoot: string;
};

async function buildPrimaryFixture(
  base: string,
  files: Record<string, string>,
): Promise<Fixture> {
  const repo = makeRepo(base);
  for (const [path, content] of Object.entries(files)) write(repo, path, content);
  commitAll(repo);
  const identity = await resolveCheckout(repo);
  const stateRoot = join(base, "state");
  const state = openState(stateRoot);
  const { modelsRoot, specs } = makeModelFixture(base);
  const seam = runtimeSeam();
  await buildPrimary({
    identity,
    state,
    modelsRoot,
    kind: "build",
    deps: { modelAssets: specs, createEmbeddingRuntime: seam.factory },
  });
  return { repo, identity, state, modelsRoot, specs, stateRoot };
}

const FULL_FILES: Record<string, string> = {
  "src/alpha.ts": "export const alphaBm25Token = 1;\n",
  "src/beta.ts": "export const betaBm25Token = 2;\n",
  "src/gamma.ts": "export const gammaBm25Token = 3;\n",
};

function refillFile(index: number): string {
  return `export const refillToken = ${index};\nexport const refillMarker${index} = ${index};\n`;
}

describe("BM25 full-generation search without an embedding runtime", () => {
  test("returns a hash-validated current-file excerpt", async () => {
    const base = makeTempRoot();
    const fixture = await buildPrimaryFixture(base, FULL_FILES);
    let runtimeCreations = 0;
    try {
      const session = await createSearchSession({
        identity: fixture.identity,
        state: fixture.state,
        modelsRoot: fixture.modelsRoot,
        deps: {
          modelAssets: fixture.specs,
          createEmbeddingRuntime: async () => {
            runtimeCreations += 1;
            throw new Error("BM25 must not create an embedding runtime");
          },
        },
      });
      try {
        const result = await session.search("alphaBm25Token", "bm25", 10);
        expect(result.hits.length).toBeGreaterThan(0);
        const hit = result.hits.find((entry) => entry.path === "src/alpha.ts");
        expect(hit).toBeDefined();
        expect(hit!.fileHash).toBe(hashFile(fixture.repo, "src/alpha.ts"));
        expect(hit!.excerpt).toContain("alphaBm25Token");
        expect(runtimeCreations).toBe(0);
        expect(["unknown", "partial"]).toContain(result.coverage.completeness);
      } finally {
        await session.dispose();
      }
    } finally {
      fixture.state.close();
    }
  });
});

describe("vector session runtime lifecycle", () => {
  test("two queries embed each query but construct one runtime, released on dispose", async () => {
    const base = makeTempRoot();
    const fixture = await buildPrimaryFixture(base, FULL_FILES);
    const seam = runtimeSeam();
    try {
      const session = await createSearchSession({
        identity: fixture.identity,
        state: fixture.state,
        modelsRoot: fixture.modelsRoot,
        deps: { modelAssets: fixture.specs, createEmbeddingRuntime: seam.factory },
      });
      const first = await session.search("alphaBm25Token", "vector", 10);
      const second = await session.search("betaBm25Token", "vector", 10);
      expect(first.hits.length).toBeGreaterThan(0);
      expect(second.hits.length).toBeGreaterThan(0);
      expect(seam.state.embeds).toBe(2);
      expect(seam.state.creations).toBe(1);
      await session.dispose();
      expect(seam.state.disposes).toBe(1);
    } finally {
      fixture.state.close();
    }
  });
});

describe("overlay candidate refill and exhaustion", () => {
  test("tombstoned first candidates refill to the eligible path", async () => {
    const base = makeTempRoot();
    const files: Record<string, string> = {};
    for (let index = 0; index < 24; index += 1) {
      files[`src/refill${String(index).padStart(3, "0")}.ts`] = refillFile(index);
    }
    const fixture = await buildPrimaryFixture(base, files);
    const seam = runtimeSeam();
    try {
      const worktree = join(base, "wt", "feature");
      addWorktree(fixture.repo, worktree, "wt-feature");
      // Tombstone the first 20 lexical candidates; keep refill20..refill23.
      for (let index = 0; index < 20; index += 1) {
        rmSync(join(worktree, `src/refill${String(index).padStart(3, "0")}.ts`), { force: true });
      }
      git(worktree, "add", "-A");
      const wtIdentity = await resolveCheckout(worktree);
      await buildWorktree({
        identity: wtIdentity,
        state: fixture.state,
        modelsRoot: fixture.modelsRoot,
        kind: "build",
        primaryIdentity: fixture.identity,
        deps: { modelAssets: fixture.specs, createEmbeddingRuntime: seam.factory },
      });

      const session = await createSearchSession({
        identity: wtIdentity,
        state: fixture.state,
        modelsRoot: fixture.modelsRoot,
        deps: { modelAssets: fixture.specs, createEmbeddingRuntime: seam.factory },
      });
      try {
        const result = await session.search("refillToken", "bm25", 10);
        const paths = result.hits.map((hit) => hit.path);
        expect(paths).toContain("src/refill020.ts");
        expect(paths).not.toContain("src/refill000.ts");
        expect(result.coverage.candidateLimitReached).toBe(false);
        expect(["unknown", "partial"]).toContain(result.coverage.completeness);
      } finally {
        await session.dispose();
      }
    } finally {
      fixture.state.close();
    }
  });

  test("more than 160 tombstones report candidateLimitReached", async () => {
    const base = makeTempRoot();
    const files: Record<string, string> = {};
    for (let index = 0; index < 200; index += 1) {
      files[`src/many${String(index).padStart(3, "0")}.ts`] = refillFile(index);
    }
    const fixture = await buildPrimaryFixture(base, files);
    const seam = runtimeSeam();
    try {
      const worktree = join(base, "wt", "feature");
      addWorktree(fixture.repo, worktree, "wt-feature");
      for (let index = 0; index < 170; index += 1) {
        rmSync(join(worktree, `src/many${String(index).padStart(3, "0")}.ts`), { force: true });
      }
      git(worktree, "add", "-A");
      const wtIdentity = await resolveCheckout(worktree);
      await buildWorktree({
        identity: wtIdentity,
        state: fixture.state,
        modelsRoot: fixture.modelsRoot,
        kind: "build",
        primaryIdentity: fixture.identity,
        deps: { modelAssets: fixture.specs, createEmbeddingRuntime: seam.factory },
      });

      const session = await createSearchSession({
        identity: wtIdentity,
        state: fixture.state,
        modelsRoot: fixture.modelsRoot,
        deps: { modelAssets: fixture.specs, createEmbeddingRuntime: seam.factory },
      });
      try {
        const result = await session.search("refillToken", "bm25", 10);
        expect(result.coverage.candidateLimitReached).toBe(true);
        expect(["unknown", "partial"]).toContain(result.coverage.completeness);
      } finally {
        await session.dispose();
      }
    } finally {
      fixture.state.close();
    }
  });

  test("validates the complete bounded union before selecting surviving hits", async () => {
    const base = makeTempRoot();
    const staleSource = Array.from(
      { length: 4_500 },
      (_, index) => `export const hiddenCandidateToken${index} = "hiddenCandidateToken";`,
    ).join("\n");
    const fixture = await buildPrimaryFixture(base, { "src/base.txt": staleSource });
    const seam = runtimeSeam();
    try {
      const worktree = join(base, "wt", "feature");
      addWorktree(fixture.repo, worktree, "wt-feature");
      write(worktree, "src/overlay.txt", staleSource);
      write(
        worktree,
        "src/survivor.txt",
        "surviving candidate hiddenCandidateToken\n",
      );
      git(worktree, "add", "-A");
      const wtIdentity = await resolveCheckout(worktree);
      await buildWorktree({
        identity: wtIdentity,
        state: fixture.state,
        modelsRoot: fixture.modelsRoot,
        kind: "build",
        primaryIdentity: fixture.identity,
        deps: { modelAssets: fixture.specs, createEmbeddingRuntime: seam.factory },
      });

      write(worktree, "src/base.txt", "stale base\n");
      write(worktree, "src/overlay.txt", "stale overlay\n");

      const session = await createSearchSession({
        identity: wtIdentity,
        state: fixture.state,
        modelsRoot: fixture.modelsRoot,
        deps: { modelAssets: fixture.specs, createEmbeddingRuntime: seam.factory },
      });
      try {
        const result = await session.search("hiddenCandidateToken", "bm25", 1);
        expect(result.hits.map((hit) => hit.path)).toEqual(["src/survivor.txt"]);
        expect(result.coverage.staleHits).toBe(2);
        expect(result.coverage.omittedHits).toBeGreaterThanOrEqual(160);
      } finally {
        await session.dispose();
      }
    } finally {
      fixture.state.close();
    }
  });
});

describe("stale-source hit omission", () => {
  test("mutated/deleted candidates are omitted while an unchanged hit uses current bytes", async () => {
    const base = makeTempRoot();
    const files: Record<string, string> = {
      "src/keep.ts": "export const staleSharedToken = 1;\n",
      "src/mutate.ts": "export const staleSharedToken = 2;\n",
      "src/delete.ts": "export const staleSharedToken = 3;\n",
    };
    const fixture = await buildPrimaryFixture(base, files);
    try {
      // Mutate one hit file and delete another after publication, without
      // staging, so the indexed manifest hashes no longer match current bytes.
      write(fixture.repo, "src/mutate.ts", "export const staleSharedToken = 200;\n");
      rmSync(join(fixture.repo, "src/delete.ts"), { force: true });

      const session = await createSearchSession({
        identity: fixture.identity,
        state: fixture.state,
        deps: { modelAssets: fixture.specs },
      });
      try {
        const result = await session.search("staleSharedToken", "bm25", 10);
        const paths = result.hits.map((hit) => hit.path);
        expect(paths).toContain("src/keep.ts");
        expect(paths).not.toContain("src/mutate.ts");
        expect(paths).not.toContain("src/delete.ts");
        expect(result.coverage.staleHits).toBeGreaterThanOrEqual(2);
        expect(result.coverage.omittedHits).toBeGreaterThanOrEqual(2);
        expect(result.freshness).toBe("stale");
        expect(result.coverage.completeness).toBe("partial");
        const keep = result.hits.find((hit) => hit.path === "src/keep.ts");
        expect(keep).toBeDefined();
        expect(keep!.fileHash).toBe(hashFile(fixture.repo, "src/keep.ts"));
        expect(keep!.excerpt).toContain("staleSharedToken = 1");
      } finally {
        await session.dispose();
      }
    } finally {
      fixture.state.close();
    }
  });
});

function makeSearchResponse(): any {
  const longExcerpt = "export function handler() { return '\u00fcn\u00efc\u00f6d\u00e9'; }\n".repeat(40);
  const hits = Array.from({ length: 25 }, (_, index) => ({
    path:
      index === 0
        ? "src/weird\nname\u0007.ts"
        : `src/${'deep/'.repeat(6)}file_${index}_with_a_very_long_name_${'x'.repeat(40)}.ts`,
    startLine: 1,
    endLine: 5,
    symbol: `symbol${index}`,
    score: 1 - index / 100,
    fileHash: "a".repeat(64),
    excerpt: longExcerpt,
  }));
  return {
    version: 1,
    command: "search",
    status: "ok",
    reason: "partial",
    availability: "ready",
    freshness: "unknown",
    operation: "idle",
    mode: "bm25",
    repoKey: "a".repeat(64),
    checkoutKey: "b".repeat(64),
    requestedRoot: `/Users/operator/${'very-long-root/'.repeat(20)}`,
    actualRoot: `/Users/operator/${'actual-long-root/'.repeat(20)}`,
    observedHead: "c".repeat(40),
    generationId: "11111111-1111-4111-8111-111111111111",
    baseId: "22222222-2222-4222-8222-222222222222",
    coverage: {
      policy: "tracked-source-v1",
      indexedFiles: 25,
      excluded: {},
      completeness: "partial",
      staleHits: 0,
      omittedHits: 0,
      candidateLimitReached: false,
    },
    timing: { elapsedMs: 12 },
    hits,
  };
}

describe("format: bounded public search output", () => {
  test("formatSearchJson yields parseable UTF-8 JSON <=4096 bytes and never emits a query", () => {
    const response = makeSearchResponse();
    const output = formatSearchJson(response);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(4096);
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe(1);
    expect(parsed.status).toBe("ok");
    expect(parsed.availability).toBe(response.availability);
    expect(parsed.freshness).toBe(response.freshness);
    expect(parsed.operation).toBe(response.operation);
    expect(parsed.mode).toBe(response.mode);
    expect(parsed.repoKey).toBe(response.repoKey);
    expect(parsed.checkoutKey).toBe(response.checkoutKey);
    expect(parsed.generationId).toBe(response.generationId);
    expect(parsed.baseId).toBe(response.baseId);
    expect(parsed.coverage).toBeDefined();
    expect(parsed.timing).toBeDefined();
    expect(Array.isArray(parsed.hits)).toBe(true);
    expect(parsed.coverage.omittedHits).toBeGreaterThanOrEqual(
      response.hits.length - parsed.hits.length,
    );
    expect(output.includes('"query"')).toBe(false);
  });

  test("formatSearchHuman escapes path controls and stays <=4096 bytes", () => {
    const response = makeSearchResponse();
    const output = formatSearchHuman(response);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(4096);
    expect(output.includes("weird\nname")).toBe(false);
    expect(output.includes("\\n")).toBe(true);
  });

  test("a mandatory-scope budget overflow returns a parseable output-budget response", () => {
    const response = makeSearchResponse();
    const output = formatSearchJson(response, { maxBytes: 120 });
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(4096);
    const parsed = JSON.parse(output);
    expect(parsed.reason).toBe("output-budget");
    expect(parsed.repoKey).toBe(response.repoKey);
    expect(parsed.checkoutKey).toBe(response.checkoutKey);
    expect(parsed.scopeOmitted).toBe(true);
  });
});

describe("public Node CLI composition (BM25, no models)", () => {
  test("cli.mjs search runs from an unrelated cwd without models and returns a bounded JSON receipt", async () => {
    const base = makeTempRoot();
    const fixture = await buildPrimaryFixture(base, FULL_FILES);
    const unrelatedCwd = makeTempRoot();
    try {
      const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
      const result = spawnSync(
        "node",
        [
          cliPath,
          "search",
          "--root",
          fixture.repo,
          "--state",
          fixture.stateRoot,
          "--query",
          "alphaBm25Token",
          "--mode",
          "bm25",
          "--limit",
          "10",
          "--json",
        ],
        { cwd: unrelatedCwd, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000 },
      );
      expect(result.status).toBe(0);
      const stdout = result.stdout ?? "";
      expect(Buffer.byteLength(stdout, "utf8")).toBeLessThanOrEqual(4096);
      expect(stdout.trim().split("\n").length).toBe(1);
      const parsed = JSON.parse(stdout.trim());
      const hit = parsed.hits.find((entry) => entry.path === "src/alpha.ts");
      expect(hit).toBeDefined();
      expect(hit.fileHash).toBe(hashFile(fixture.repo, "src/alpha.ts"));
      expect(hit.excerpt).toContain("alphaBm25Token");
      expect(["unknown", "partial"]).toContain(parsed.coverage.completeness);
    } finally {
      fixture.state.close();
    }
  });

  test("cli.mjs bounds a valid large search excerpt before worker transport", async () => {
    const base = makeTempRoot();
    const largeLine = `export const oversizedTransportToken = "${"x".repeat(100 * 1024)}";\n`;
    const fixture = await buildPrimaryFixture(base, { "src/large.ts": largeLine });
    try {
      const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
      const result = spawnSync(
        "node",
        [
          cliPath,
          "search",
          "--root",
          fixture.repo,
          "--state",
          fixture.stateRoot,
          "--query",
          "oversizedTransportToken",
          "--mode",
          "bm25",
          "--limit",
          "1",
          "--json",
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000 },
      );
      expect(result.status).toBe(0);
      const stdout = result.stdout ?? "";
      expect(Buffer.byteLength(stdout, "utf8")).toBeLessThanOrEqual(4096);
      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe("ok");
      expect(parsed.hits.map((hit) => hit.path)).toEqual(["src/large.ts"]);
      expect(parsed.hits[0].excerpt).toEndWith("\u2026");
    } finally {
      fixture.state.close();
    }
  });
});
