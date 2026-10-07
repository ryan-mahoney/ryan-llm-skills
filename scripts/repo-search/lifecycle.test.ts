// Test-first acceptance boundary for Step 4 primary lifecycle/build.
//
// Production `./lifecycle` and `./core/build.ts` do not exist yet: these cases
// define the planned public contract and are expected to fail until they are
// implemented. Only the embedding extractor is substituted; Orama, Bun SQLite,
// Git, source capture, chunking and model verification stay real.
//
// Assumed public surface:
//   buildPrimary({identity,state,modelsRoot,kind:"build"|"update"|"reindex",
//     signal?,deps?}) -> Promise<OperationReceipt>
//   checkCheckout({identity,state,signal?,deps?}) -> Promise<CheckReceipt>
//   readCheckoutStatus({identity,state,deps?}) -> StatusReceipt
//   Receipt fields used: generationId, availability, freshness, sourceMoved
//   CheckReceipt fields used: matchesGeneration, snapshotDigest
//   StatusReceipt fields used: freshness, currentGenerationId,
//     lastCheck:{at,snapshotDigest,matchesGeneration}|null
//   deps.modelAssets?: readonly CodeModelAssetSpec[] (real verifyModel input)
//   deps.createEmbeddingRuntime?: ({modelsRoot,model,compatibility}) =>
//     Promise<CodeEmbeddingRuntime>  (default: real runtime factory)

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chunkFile } from "./core/chunk";
import { resolveCodeIndexStorePaths, createCodeIndexRuntime } from "./core/codeIndexRuntime";
import { CODE_INDEX_DIMENSIONS } from "./core/embeddingContract";
import type { CodeEmbeddingRuntime } from "./core/codeEmbeddingRuntime";
import {
  CODE_MODEL_ID,
  CodeModelUnavailableError,
  verifyModel,
  type CodeModelAssetSpec,
} from "./core/codeModelAssets";
import { readFileManifest, resolveManifestPath } from "./core/fileManifest";
import { languageForPath, routeStrategy } from "./core/route";
import { resolveCheckout, resolveStateRoot } from "./identity.mjs";
import { openState } from "./state";
import { buildPrimary, checkCheckout, readCheckoutStatus } from "./lifecycle";

const tempRoots: string[] = [];

// Real Git/AST/Orama work per case; the process-level command stays at 120s.
setDefaultTimeout(30_000);

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-search-lifecycle-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Real Git fixtures ----------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepo(base: string): string {
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  return repo;
}

function commitAll(repo: string, message = "fixture"): string {
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=Lifecycle Fixture",
    "-c",
    "user.email=lifecycle@example.invalid",
    "commit",
    "-qm",
    message,
  );
  return git(repo, "rev-parse", "HEAD");
}

function write(repo: string, relPath: string, content: string): void {
  const absolute = join(repo, relPath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
}

// ---- Tiny model fixture (real verifyModel) --------------------------------

function makeModelFixture(base: string): {
  modelsRoot: string;
  specs: CodeModelAssetSpec[];
} {
  const modelsRoot = join(base, "models");
  const modelDir = join(modelsRoot, CODE_MODEL_ID);
  mkdirSync(modelDir, { recursive: true });
  const files: Record<string, string> = {
    "config.json": '{"fixture":true}\n',
    "vocab.json": '["fixture"]\n',
  };
  const specs: CodeModelAssetSpec[] = [];
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(modelDir, path), content);
    specs.push({
      path,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    });
  }
  return { modelsRoot, specs };
}

// ---- Deterministic fake embedding runtime ---------------------------------

function deterministicVector(text: string): number[] {
  const digest = createHash("sha256").update(text, "utf8").digest();
  return Array.from(
    { length: CODE_INDEX_DIMENSIONS },
    (_, index) => digest[index % digest.length] / 255,
  );
}

type FakeRuntimeState = { embeds: number; embeddedText: string[] };

function fakeRuntimeFactory(
  state: FakeRuntimeState,
  onEmbed?: (text: string) => void,
): (input: {
  modelsRoot: string;
  model: { assetDigest: string };
  compatibility: unknown;
}) => Promise<CodeEmbeddingRuntime> {
  return async () => {
    const record = (text: string): void => {
      state.embeds += 1;
      state.embeddedText.push(text);
      onEmbed?.(text);
    };
    return {
      modelId: CODE_MODEL_ID,
      dimensions: CODE_INDEX_DIMENSIONS,
      async embed(text) {
        record(text);
        return deterministicVector(text);
      },
      async embedBatch(texts) {
        return texts.map((text) => {
          record(text);
          return deterministicVector(text);
        });
      },
      async dispose() {},
    };
  };
}

// ---- Chunk oracle (real chunker) ------------------------------------------

async function expectedChunkCount(
  files: Record<string, string>,
): Promise<number> {
  let total = 0;
  for (const [path, content] of Object.entries(files)) {
    const chunks = await chunkFile({
      path,
      content,
      strategy: routeStrategy(path),
      language: languageForPath(path),
    });
    total += chunks.length;
  }
  return total;
}

async function restoreGeneration(
  stateRoot: string,
  generationId: string,
): Promise<any> {
  const storeDir = join(resolveStateRoot(stateRoot), "generations", generationId);
  return createCodeIndexRuntime(resolveCodeIndexStorePaths(storeDir), {
    open: "restore",
  });
}

async function searchPaths(runtime: any, term: string, limit = 50): Promise<string[]> {
  const hits = await runtime.search({ term, mode: "bm25", limit });
  return hits.map((hit: any) => hit.path);
}

// Fixture content. multi.ts is deliberately >60 lines so it chunks into many
// pieces and shrinking it exercises replacement chunk removal.
function multiFile(lines: number): string {
  const out: string[] = [];
  for (let index = 0; index < lines; index += 1) {
    out.push(`export const multiMarker${index} = ${index};`);
  }
  out.push("");
  return out.join("\n");
}

const BASE_FILES: Record<string, string> = {
  "src/multi.ts": multiFile(80),
  "src/emptyish.ts": "export const emptyishSymbol = 1;\n",
  "src/deletable.ts": "export const deletableSymbol = 1;\n",
  "src/renameFrom.ts": "export const renameSymbol = 1;\n",
  "src/unrelated.ts": "export const unrelatedSymbol = 1;\n",
};

function seedRepo(base: string): string {
  const repo = makeRepo(base);
  for (const [path, content] of Object.entries(BASE_FILES)) write(repo, path, content);
  commitAll(repo, "initial");
  return repo;
}

async function openFixture(base: string): Promise<{
  repo: string;
  identity: any;
  state: any;
  stateRoot: string;
  modelsRoot: string;
  specs: CodeModelAssetSpec[];
}> {
  const repo = seedRepo(base);
  const identity = await resolveCheckout(repo);
  const stateRoot = join(base, "state");
  const state = openState(stateRoot);
  const { modelsRoot, specs } = makeModelFixture(base);
  return { repo, identity, state, stateRoot, modelsRoot, specs };
}

describe("primary build and incremental update", () => {
  test("unchanged updates embed zero; one mutation embeds only replacement chunks", async () => {
    const base = makeTempRoot();
    const { repo, identity, state, stateRoot, modelsRoot, specs } =
      await openFixture(base);
    const fake: FakeRuntimeState = { embeds: 0, embeddedText: [] };
    const deps = {
      modelAssets: specs,
      createEmbeddingRuntime: fakeRuntimeFactory(fake),
    };
    try {
      // Initial build.
      const initial = await buildPrimary({
        identity,
        state,
        modelsRoot,
        kind: "build",
        deps,
      });
      expect(initial.availability).toBe("ready");
      expect(typeof initial.generationId).toBe("string");
      const initialEmbeds = fake.embeds;
      expect(initialEmbeds).toBe(await expectedChunkCount(BASE_FILES));

      const runtime1 = await restoreGeneration(stateRoot, initial.generationId);
      expect(await runtime1.count()).toBe(initialEmbeds);
      expect(await searchPaths(runtime1, "deletableSymbol")).toEqual(["src/deletable.ts"]);
      expect(await searchPaths(runtime1, "unrelatedSymbol")).toEqual(["src/unrelated.ts"]);

      // Unchanged update: compatibility/cache reuse, zero embedding work.
      fake.embeds = 0;
      fake.embeddedText = [];
      const unchanged = await buildPrimary({
        identity,
        state,
        modelsRoot,
        kind: "update",
        deps,
      });
      expect(fake.embeds).toBe(0);
      expect(unchanged.generationId).toBeTruthy();

      // One tracked working-tree mutation pass.
      write(repo, "src/multi.ts", multiFile(10));
      write(repo, "src/emptyish.ts", "");
      rmSync(join(repo, "src/deletable.ts"), { force: true });
      renameSync(join(repo, "src/renameFrom.ts"), join(repo, "src/renameTo.ts"));
      // Stage so ls-files reflects the deletion/rename instead of an unreadable
      // deleted tracked path plus an untracked addition.
      git(repo, "add", "-A");

      fake.embeds = 0;
      fake.embeddedText = [];
      const mutated = await buildPrimary({
        identity,
        state,
        modelsRoot,
        kind: "update",
        deps,
      });
      const remaining: Record<string, string> = {
        "src/multi.ts": multiFile(10),
        "src/emptyish.ts": "",
        "src/renameTo.ts": BASE_FILES["src/renameFrom.ts"],
        "src/unrelated.ts": BASE_FILES["src/unrelated.ts"],
      };
      // Only changed/added files contribute replacement chunks.
      const expectedReplacement =
        (await expectedChunkCount({ "src/multi.ts": remaining["src/multi.ts"] })) +
        (await expectedChunkCount({ "src/renameTo.ts": remaining["src/renameTo.ts"] }));
      expect(fake.embeds).toBe(expectedReplacement);
      expect(
        fake.embeddedText.some((text) => text.includes("unrelatedSymbol")),
      ).toBe(false);

      const runtime2 = await restoreGeneration(stateRoot, mutated.generationId);
      expect(await runtime2.count()).toBe(await expectedChunkCount(remaining));
      expect(await searchPaths(runtime2, "deletableSymbol")).toEqual([]);
      expect(await searchPaths(runtime2, "emptyishSymbol")).toEqual([]);
      expect(await searchPaths(runtime2, "renameSymbol")).toEqual(["src/renameTo.ts"]);
      expect(await searchPaths(runtime2, "unrelatedSymbol")).toEqual(["src/unrelated.ts"]);
      expect(await searchPaths(runtime2, "multiMarker0")).toEqual(["src/multi.ts"]);

      // A following unchanged update again embeds zero.
      fake.embeds = 0;
      await buildPrimary({ identity, state, modelsRoot, kind: "update", deps });
      expect(fake.embeds).toBe(0);
    } finally {
      state.close();
    }
  });

  test("unchanged no-work paths reject corrupt stores and reindex recovers", async () => {
    const base = makeTempRoot();
    const corruptions = [
      {
        name: "missing-dump",
        corrupt(storeDir: string) {
          unlinkSync(resolveCodeIndexStorePaths(storeDir).dumpPath);
        },
      },
      {
        name: "corrupt-meta",
        corrupt(storeDir: string) {
          writeFileSync(resolveCodeIndexStorePaths(storeDir).metaPath, "{invalid");
        },
      },
      {
        name: "corrupt-manifest",
        corrupt(storeDir: string) {
          writeFileSync(resolveManifestPath(storeDir), "{invalid");
        },
      },
    ];

    for (const corruption of corruptions) {
      const fixtureRoot = join(base, corruption.name);
      mkdirSync(fixtureRoot, { recursive: true });
      const { identity, state, stateRoot, modelsRoot, specs } =
        await openFixture(fixtureRoot);
      const fake: FakeRuntimeState = { embeds: 0, embeddedText: [] };
      const deps = {
        modelAssets: specs,
        createEmbeddingRuntime: fakeRuntimeFactory(fake),
      };
      try {
        const initial = await buildPrimary({
          identity,
          state,
          modelsRoot,
          kind: "build",
          deps,
        });
        const storeDir = join(
          resolveStateRoot(stateRoot),
          "generations",
          initial.generationId,
        );
        corruption.corrupt(storeDir);
        fake.embeds = 0;

        await expect(
          buildPrimary({ identity, state, modelsRoot, kind: "update", deps }),
        ).rejects.toThrow();
        await expect(
          buildPrimary({ identity, state, modelsRoot, kind: "build", deps }),
        ).rejects.toThrow();
        expect(fake.embeds).toBe(0);

        const recovered = await buildPrimary({
          identity,
          state,
          modelsRoot,
          kind: "reindex",
          deps,
        });
        expect(recovered.generationId).not.toBe(initial.generationId);
        const runtime = await restoreGeneration(stateRoot, recovered.generationId);
        expect(await runtime.count()).toBe(await expectedChunkCount(BASE_FILES));
      } finally {
        state.close();
      }
    }
  });

  test("publishes and updates a tracked root __proto__ file", async () => {
    const base = makeTempRoot();
    const { repo, identity, state, stateRoot, modelsRoot, specs } =
      await openFixture(base);
    const fake: FakeRuntimeState = { embeds: 0, embeddedText: [] };
    const deps = {
      modelAssets: specs,
      createEmbeddingRuntime: fakeRuntimeFactory(fake),
    };
    try {
      write(repo, "__proto__", "prototypeInitialMarker\n");
      git(repo, "add", "__proto__");
      const initial = await buildPrimary({
        identity,
        state,
        modelsRoot,
        kind: "build",
        deps,
      });
      const initialStore = join(
        resolveStateRoot(stateRoot),
        "generations",
        initial.generationId,
      );
      const initialManifest = await readFileManifest(resolveManifestPath(initialStore));
      expect(Object.prototype.hasOwnProperty.call(initialManifest?.files, "__proto__")).toBe(
        true,
      );
      const initialRuntime = await restoreGeneration(stateRoot, initial.generationId);
      expect(await searchPaths(initialRuntime, "prototypeInitialMarker")).toEqual([
        "__proto__",
      ]);

      write(repo, "__proto__", "prototypeUpdatedMarker\n");
      git(repo, "add", "__proto__");
      const updated = await buildPrimary({
        identity,
        state,
        modelsRoot,
        kind: "update",
        deps,
      });
      const updatedStore = join(
        resolveStateRoot(stateRoot),
        "generations",
        updated.generationId,
      );
      const updatedManifest = await readFileManifest(resolveManifestPath(updatedStore));
      expect(Object.prototype.hasOwnProperty.call(updatedManifest?.files, "__proto__")).toBe(
        true,
      );
      expect(updatedManifest?.files["__proto__"]?.hash).toBe(
        createHash("sha256").update("prototypeUpdatedMarker\n").digest("hex"),
      );
      const updatedRuntime = await restoreGeneration(stateRoot, updated.generationId);
      expect(await searchPaths(updatedRuntime, "prototypeUpdatedMarker")).toEqual([
        "__proto__",
      ]);
    } finally {
      state.close();
    }
  });
});

describe("freshness without HEAD changes", () => {
  test("same-HEAD byte edits with restored mtime report a stale check and status", async () => {
    const base = makeTempRoot();
    const { repo, identity, state, modelsRoot, specs } = await openFixture(base);
    const fake: FakeRuntimeState = { embeds: 0, embeddedText: [] };
    const deps = {
      modelAssets: specs,
      createEmbeddingRuntime: fakeRuntimeFactory(fake),
    };
    try {
      const initial = await buildPrimary({
        identity,
        state,
        modelsRoot,
        kind: "build",
        deps,
      });
      const head = identity.head;
      const target = join(repo, "src/unrelated.ts");
      const originalMtime = new Date(Date.now() - 120_000);

      write(repo, "src/unrelated.ts", "export const unrelatedSymbol = 2;\n");
      utimesSync(target, originalMtime, originalMtime);

      expect(await resolveCheckout(repo).then((next) => next.head)).toBe(head);

      // No runtime creation on check/status paths.
      let runtimeCreations = 0;
      const noRuntimeDeps = {
        modelAssets: specs,
        createEmbeddingRuntime: async () => {
          runtimeCreations += 1;
          throw new Error("embedding runtime must not be created");
        },
      };

      const check = await checkCheckout({ identity, state, deps: noRuntimeDeps });
      expect(check.matchesGeneration).toBe(false);
      expect(check.snapshotDigest).not.toBe(initial.snapshotDigest);

      const status = readCheckoutStatus({ identity, state, deps: noRuntimeDeps });
      expect(status.freshness).toBe("stale");
      expect(status.currentGenerationId).toBe(initial.generationId);
      expect(status.lastCheck?.matchesGeneration).toBe(false);
      expect(runtimeCreations).toBe(0);

      // A real refresh publishes a new generation and clears stale provenance.
      const updated = await buildPrimary({
        identity,
        state,
        modelsRoot,
        kind: "update",
        deps,
      });
      expect(updated.generationId).not.toBe(initial.generationId);
      const after = readCheckoutStatus({ identity, state });
      expect(after.freshness).toBe("unknown");
      expect(after.currentGenerationId).toBe(updated.generationId);
      expect(after.lastCheck).toBeNull();
    } finally {
      state.close();
    }
  });
});

describe("captured bytes under interleaving and failure", () => {
  test("a source mutation from the first embed leaves captured bytes in the generation", async () => {
    const base = makeTempRoot();
    const { repo, identity, state, stateRoot, modelsRoot, specs } =
      await openFixture(base);
    const fake: FakeRuntimeState = { embeds: 0, embeddedText: [] };
    const plainDeps = {
      modelAssets: specs,
      createEmbeddingRuntime: fakeRuntimeFactory(fake),
    };
    let mutated = false;
    const hookedDeps = {
      modelAssets: specs,
      createEmbeddingRuntime: fakeRuntimeFactory(fake, () => {
        if (mutated) return;
        mutated = true;
        write(repo, "src/unrelated.ts", "export const unrelatedSymbol = 99;\n");
      }),
    };
    try {
      const first = await buildPrimary({
        identity,
        state,
        modelsRoot,
        kind: "build",
        deps: plainDeps,
      });

      // Change a different file so the update captures before the hook fires.
      write(repo, "src/deletable.ts", "export const deletableSymbol = 2;\n");
      fake.embeds = 0;
      fake.embeddedText = [];
      const interleaved = await buildPrimary({
        identity,
        state,
        modelsRoot,
        kind: "update",
        deps: hookedDeps,
      });

      // The produced generation holds the originally captured unrelated bytes.
      const runtime = await restoreGeneration(stateRoot, interleaved.generationId);
      const capturedHit = await runtime.search({
        term: "unrelatedSymbol",
        mode: "bm25",
        limit: 10,
      });
      expect(capturedHit.length).toBeGreaterThan(0);
      expect(capturedHit.some((hit: any) => hit.content.includes("unrelatedSymbol = 1"))).toBe(
        true,
      );
      expect(capturedHit.some((hit: any) => hit.content.includes("unrelatedSymbol = 99"))).toBe(
        false,
      );

      const manifest = await readFileManifest(
        resolveManifestPath(join(resolveStateRoot(stateRoot), "generations", interleaved.generationId)),
      );
      expect(manifest?.files["src/unrelated.ts"]?.hash).toBe(
        createHash("sha256")
          .update(BASE_FILES["src/unrelated.ts"], "utf8")
          .digest("hex"),
      );

      // A moved source publishes stale and never replaces the prior current.
      expect(interleaved.freshness === "stale" || interleaved.sourceMoved === true).toBe(true);
      const status = readCheckoutStatus({ identity, state });
      expect(status.currentGenerationId).toBe(first.generationId);
    } finally {
      state.close();
    }
  });

  test("an over-cap eligible file fails the update and leaves prior current unchanged", async () => {
    const base = makeTempRoot();
    const { repo, identity, state, modelsRoot, specs } = await openFixture(base);
    const fake: FakeRuntimeState = { embeds: 0, embeddedText: [] };
    const deps = {
      modelAssets: specs,
      createEmbeddingRuntime: fakeRuntimeFactory(fake),
    };
    try {
      const first = await buildPrimary({
        identity,
        state,
        modelsRoot,
        kind: "build",
        deps,
      });
      write(repo, "src/huge.ts", "x".repeat(600 * 1024));
      git(repo, "add", "-A");
      await expect(
        buildPrimary({ identity, state, modelsRoot, kind: "update", deps }),
      ).rejects.toThrow();
      const status = readCheckoutStatus({ identity, state });
      expect(status.currentGenerationId).toBe(first.generationId);
    } finally {
      state.close();
    }
  });
});

describe("offline verification and lazy runtime", () => {
  test("missing and mismatched models fail before runtime creation", async () => {
    const base = makeTempRoot();
    const { identity, state } = await openFixture(base);

    let runtimeCreations = 0;
    const countingDeps = (specs?: readonly CodeModelAssetSpec[]) => ({
      modelAssets: specs,
      createEmbeddingRuntime: async () => {
        runtimeCreations += 1;
        throw new Error("embedding runtime must not be created");
      },
    });
    try {
      // Missing model directory.
      const missingRoot = join(base, "missing-models");
      mkdirSync(missingRoot, { recursive: true });
      const missing = await (async () => {
        try {
          await buildPrimary({
            identity,
            state,
            modelsRoot: missingRoot,
            kind: "build",
            deps: countingDeps(),
          });
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(missing).toBeInstanceOf(CodeModelUnavailableError);
      expect((missing as CodeModelUnavailableError).reason).toBe("missing");

      // Digest mismatch through the real verifier.
      const badRoot = join(base, "bad-models");
      const badDir = join(badRoot, CODE_MODEL_ID);
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, "config.json"), "not-the-expected-bytes\n");
      const badSpecs: CodeModelAssetSpec[] = [
        { path: "config.json", sha256: createHash("sha256").update("expected").digest("hex") },
      ];
      await expect(
        verifyModel(badRoot, badSpecs),
      ).rejects.toBeInstanceOf(CodeModelUnavailableError);
      const mismatched = await (async () => {
        try {
          await buildPrimary({
            identity,
            state,
            modelsRoot: badRoot,
            kind: "build",
            deps: countingDeps(badSpecs),
          });
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(mismatched).toBeInstanceOf(CodeModelUnavailableError);
      expect((mismatched as CodeModelUnavailableError).reason).toBe("digest-mismatch");
      expect(runtimeCreations).toBe(0);
    } finally {
      state.close();
    }
  });

  test("unchanged update, check and status never create the embedding runtime", async () => {
    const base = makeTempRoot();
    const { identity, state, modelsRoot, specs } = await openFixture(base);
    let runtimeCreations = 0;
    const counter: FakeRuntimeState = { embeds: 0, embeddedText: [] };
    const baseFactory = fakeRuntimeFactory(counter);
    const deps = {
      modelAssets: specs,
      createEmbeddingRuntime: async (input: any) => {
        runtimeCreations += 1;
        return baseFactory(input);
      },
    };
    try {
      // Initial build must create the runtime (fake) exactly once.
      await buildPrimary({ identity, state, modelsRoot, kind: "build", deps });
      expect(runtimeCreations).toBe(1);

      runtimeCreations = 0;
      await buildPrimary({ identity, state, modelsRoot, kind: "update", deps });
      await checkCheckout({ identity, state, deps });
      readCheckoutStatus({ identity, state, deps });
      expect(runtimeCreations).toBe(0);
    } finally {
      state.close();
    }
  });
});

describe("enrollment ancestor-symlink containment", () => {
  test("refuses a symlinked checkout direct child without touching external bytes", async () => {
    const base = makeTempRoot();
    const { identity, state, stateRoot, modelsRoot } = await openFixture(base);
    try {
      const external = join(base, "external-checkout");
      mkdirSync(external, { recursive: true, mode: 0o700 });
      const sentinelPath = join(external, "enrollment.json");
      const sentinel = Buffer.from("external sentinel bytes\n");
      writeFileSync(sentinelPath, sentinel);

      // The checkout direct child is absent until an operation creates it.
      const checkoutDir = join(stateRoot, "checkouts", identity.checkoutKey);
      symlinkSync(external, checkoutDir, "dir");

      // An enrollment-reading path must reject the symlinked ancestor.
      expect(() => readCheckoutStatus({ identity, state })).toThrow();
      expect(readFileSync(sentinelPath).equals(sentinel)).toBe(true);

      // A build enrollment path must also refuse rather than write through.
      await expect(
        buildPrimary({ identity, state, modelsRoot, kind: "build" }),
      ).rejects.toThrow();
      expect(readFileSync(sentinelPath).equals(sentinel)).toBe(true);
    } finally {
      state.close();
    }
  });
});
