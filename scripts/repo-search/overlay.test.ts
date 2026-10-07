// Test-first Step 5 overlay acceptance boundary.
//
// Production `buildWorktree`/`updateCheckout` (lifecycle.ts) and
// `readOverlayManifest` (core/overlayManifest.ts) do not exist yet: these cases
// define the planned contract and are expected to fail until implemented. Only
// the final embedding extractor is substituted; Git, source capture, Orama,
// SQLite/state and model verification stay real.
//
// Assumed public surface:
//   buildWorktree({identity,state,modelsRoot,kind:"build"|"update"|"reindex",
//     primaryIdentity?,signal?,deps?}) -> Promise<OperationReceipt>
//   updateCheckout({identity,state,modelsRoot,primaryIdentity?,signal?,deps?})
//     -> Promise<OperationReceipt> (kind fixed to update; routes primary to
//     buildPrimary and linked to buildWorktree)
//   readOverlayManifest(storeDir) -> Promise<OverlayManifest|undefined>
//   OverlayManifest = { version, baseId, modelId, dimensions,
//     files: Record<path,{hash,chunkCount}>, tombstones: string[] }
//   Receipt fields used: kind, baseId, generationId, availability

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { chunkFile } from "./core/chunk";
import {
  CodeIndexUnavailableError,
  createCodeIndexRuntime,
  resolveCodeIndexStorePaths,
} from "./core/codeIndexRuntime";
import { CODE_INDEX_DIMENSIONS } from "./core/embeddingContract";
import type { CodeEmbeddingRuntime } from "./core/codeEmbeddingRuntime";
import { CODE_MODEL_ID, type CodeModelAssetSpec } from "./core/codeModelAssets";
import { languageForPath, routeStrategy } from "./core/route";
import { readOverlayManifest } from "./core/overlayManifest";
import { resolveCheckout, resolveStateRoot } from "./identity.mjs";
import { openState } from "./state";
import { buildPrimary, buildWorktree, updateCheckout } from "./lifecycle";

setDefaultTimeout(30_000);

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-search-overlay-"));
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
    "user.name=Overlay Fixture",
    "-c",
    "user.email=overlay@example.invalid",
    "commit",
    "-qm",
    message,
  );
  return git(repo, "rev-parse", "HEAD");
}

function write(repo: string, relPath: string, content: string | Buffer): void {
  const absolute = join(repo, relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function addWorktree(repo: string, path: string, branch: string): void {
  mkdirSync(dirname(path), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", branch, path, "HEAD");
}

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
): (input: {
  modelsRoot: string;
  model: { assetDigest: string };
  compatibility: unknown;
}) => Promise<CodeEmbeddingRuntime> {
  return async () => ({
    modelId: CODE_MODEL_ID,
    dimensions: CODE_INDEX_DIMENSIONS,
    async embed(text) {
      state.embeds += 1;
      state.embeddedText.push(text);
      return deterministicVector(text);
    },
    async embedBatch(texts) {
      return texts.map((text) => {
        state.embeds += 1;
        state.embeddedText.push(text);
        return deterministicVector(text);
      });
    },
    async dispose() {},
  });
}

function hashOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const BASE_FILES: Record<string, string> = {
  "src/shared.ts": "export const sharedSymbol = 1;\n",
  "src/baseOnly.ts": "export const baseOnlySymbol = 1;\n",
  "src/other.ts": "export const otherSymbol = 1;\n",
};

function seedRepo(base: string): string {
  const repo = makeRepo(base);
  for (const [path, content] of Object.entries(BASE_FILES)) write(repo, path, content);
  commitAll(repo, "initial");
  return repo;
}

function overlayStoreDir(stateRoot: string, generationId: string): string {
  return join(resolveStateRoot(stateRoot), "generations", generationId);
}

async function restoreGeneration(stateRoot: string, generationId: string): Promise<any> {
  return createCodeIndexRuntime(resolveCodeIndexStorePaths(overlayStoreDir(stateRoot, generationId)), {
    open: "restore",
  });
}

async function searchPaths(runtime: any, term: string, limit = 50): Promise<string[]> {
  const hits = await runtime.search({ term, mode: "bm25", limit });
  return hits.map((hit: any) => hit.path);
}

async function searchContent(runtime: any, term: string): Promise<string[]> {
  const hits = await runtime.search({ term, mode: "bm25", limit: 50 });
  return hits.map((hit: any) => hit.content);
}

async function expectedChunkCount(path: string, content: string): Promise<number> {
  const chunks = await chunkFile({
    path,
    content,
    strategy: routeStrategy(path),
    language: languageForPath(path),
  });
  return chunks.length;
}

type Fixture = {
  repo: string;
  primaryIdentity: any;
  state: any;
  stateRoot: string;
  modelsRoot: string;
  specs: CodeModelAssetSpec[];
  deps: { modelAssets: CodeModelAssetSpec[]; createEmbeddingRuntime: any };
};

function openFixture(base: string, afterRename?: (info: any) => void): Fixture {
  const repo = seedRepo(base);
  const stateRoot = join(base, "state");
  const state = openState(stateRoot, afterRename ? { afterRename } : {});
  const { modelsRoot, specs } = makeModelFixture(base);
  const fake: FakeRuntimeState = { embeds: 0, embeddedText: [] };
  return {
    repo,
    primaryIdentity: undefined as unknown as any,
    state,
    stateRoot,
    modelsRoot,
    specs,
    deps: { modelAssets: specs, createEmbeddingRuntime: fakeRuntimeFactory(fake) },
  };
}

describe("overlay: same-basename worktrees publish independent overlays", () => {
  test("two linked worktrees with different dirty bytes share one base but stay independent", async () => {
    const base = makeTempRoot();
    const fixture = openFixture(base);
    const { repo, state, stateRoot, modelsRoot, deps } = fixture;
    try {
      const primaryIdentity = await resolveCheckout(repo);
      const g1 = await buildPrimary({ identity: primaryIdentity, state, modelsRoot, kind: "build", deps });
      expect(g1.generationId).toBeTruthy();

      const left = join(base, "left-parent", "feature");
      const right = join(base, "right-parent", "feature");
      addWorktree(repo, left, "left-feature");
      addWorktree(repo, right, "right-feature");
      write(left, "src/shared.ts", "export const sharedSymbol = 222;\n");
      write(right, "src/shared.ts", "export const sharedSymbol = 333;\n");

      const leftIdentity = await resolveCheckout(left);
      const rightIdentity = await resolveCheckout(right);
      expect(basename(left)).toBe("feature");
      expect(basename(right)).toBe("feature");
      expect(leftIdentity.checkoutKey).not.toBe(rightIdentity.checkoutKey);

      const leftReceipt = await buildWorktree({
        identity: leftIdentity, state, modelsRoot, kind: "build", primaryIdentity, deps,
      });
      const rightReceipt = await buildWorktree({
        identity: rightIdentity, state, modelsRoot, kind: "build", primaryIdentity, deps,
      });

      expect(leftReceipt.generationKind).toBe("overlay");
      expect(rightReceipt.generationKind).toBe("overlay");
      expect(leftReceipt.baseId).toBe(g1.generationId);
      expect(rightReceipt.baseId).toBe(g1.generationId);
      expect(leftReceipt.generationId).not.toBe(rightReceipt.generationId);

      const leftManifest = await readOverlayManifest(overlayStoreDir(stateRoot, leftReceipt.generationId));
      const rightManifest = await readOverlayManifest(overlayStoreDir(stateRoot, rightReceipt.generationId));
      expect(leftManifest?.baseId).toBe(g1.generationId);
      expect(rightManifest?.baseId).toBe(g1.generationId);
      for (const manifest of [leftManifest, rightManifest]) {
        expect(Object.keys(manifest!.files).sort()).toEqual([
          "src/baseOnly.ts",
          "src/other.ts",
          "src/shared.ts",
        ]);
        expect(manifest!.tombstones).toEqual(["src/shared.ts"]);
      }
      expect(leftManifest!.files["src/shared.ts"].hash).not.toBe(
        rightManifest!.files["src/shared.ts"].hash,
      );

      const leftRuntime = await restoreGeneration(stateRoot, leftReceipt.generationId);
      const rightRuntime = await restoreGeneration(stateRoot, rightReceipt.generationId);
      expect(await searchPaths(leftRuntime, "sharedSymbol")).toEqual(["src/shared.ts"]);
      expect(await searchPaths(leftRuntime, "baseOnlySymbol")).toEqual([]);
      expect(await searchPaths(leftRuntime, "otherSymbol")).toEqual([]);
      expect((await searchContent(leftRuntime, "sharedSymbol")).some((c) => c.includes("222"))).toBe(true);
      expect((await searchContent(rightRuntime, "sharedSymbol")).some((c) => c.includes("333"))).toBe(true);

      // Independent current rows.
      expect(
        state.readStatus({ checkoutKey: leftIdentity.checkoutKey }).current[0]?.generationId,
      ).toBe(leftReceipt.generationId);
      expect(
        state.readStatus({ checkoutKey: rightIdentity.checkoutKey }).current[0]?.generationId,
      ).toBe(rightReceipt.generationId);
    } finally {
      state.close();
    }
  });

  test("retains an unchanged base path named __proto__ in the complete overlay manifest", async () => {
    const base = makeTempRoot();
    const fixture = openFixture(base);
    const { repo, state, stateRoot, modelsRoot, deps } = fixture;
    try {
      write(repo, "__proto__", "prototypeBaseMarker\n");
      commitAll(repo, "add prototype-named path");
      const primaryIdentity = await resolveCheckout(repo);
      const primary = await buildPrimary({
        identity: primaryIdentity,
        state,
        modelsRoot,
        kind: "build",
        deps,
      });

      const worktree = join(base, "prototype-parent", "feature");
      addWorktree(repo, worktree, "prototype-feature");
      write(worktree, "src/shared.ts", "export const sharedSymbol = 44;\n");
      const wtIdentity = await resolveCheckout(worktree);
      const overlay = await buildWorktree({
        identity: wtIdentity,
        state,
        modelsRoot,
        kind: "build",
        primaryIdentity,
        deps,
      });

      expect(overlay.baseId).toBe(primary.generationId);
      const manifest = await readOverlayManifest(
        overlayStoreDir(stateRoot, overlay.generationId!),
      );
      expect(Object.prototype.hasOwnProperty.call(manifest?.files, "__proto__")).toBe(true);
      expect(manifest?.files["__proto__"]?.hash).toBe(hashOf("prototypeBaseMarker\n"));
      expect(manifest?.tombstones).not.toContain("__proto__");
    } finally {
      state.close();
    }
  });
});

describe("overlay: change/delete/exclude/revert recompute against an immutable base", () => {
  test("each update recomputes chunks and tombstones without accumulating stale rows", async () => {
    const base = makeTempRoot();
    const fixture = openFixture(base);
    const { repo, state, stateRoot, modelsRoot, deps } = fixture;
    try {
      const primaryIdentity = await resolveCheckout(repo);
      const g1 = await buildPrimary({ identity: primaryIdentity, state, modelsRoot, kind: "build", deps });

      const worktree = join(base, "wt-parent", "feature");
      addWorktree(repo, worktree, "wt-feature");
      const wtIdentity = await resolveCheckout(worktree);

      // Clean initial overlay on the immutable base.
      const initial = await buildWorktree({
        identity: wtIdentity, state, modelsRoot, kind: "build", primaryIdentity, deps,
      });
      const path = "src/baseOnly.ts";
      const baseHash = hashOf(BASE_FILES[path]);
      const baseChunks = await expectedChunkCount(path, BASE_FILES[path]);

      // 1. Change.
      write(worktree, path, "export const baseOnlySymbol = 2;\n");
      const changed = await updateCheckout({ identity: wtIdentity, state, modelsRoot, primaryIdentity, deps });
      const changedManifest = await readOverlayManifest(overlayStoreDir(stateRoot, changed.generationId));
      expect(changedManifest!.tombstones).toContain(path);
      expect(changedManifest!.files[path].hash).toBe(hashOf("export const baseOnlySymbol = 2;\n"));
      const changedRuntime = await restoreGeneration(stateRoot, changed.generationId);
      expect(await searchPaths(changedRuntime, "baseOnlySymbol")).toEqual([path]);
      expect((await searchContent(changedRuntime, "baseOnlySymbol")).some((c) => c.includes("= 2"))).toBe(true);

      // 2. Staged delete.
      rmSync(join(worktree, path), { force: true });
      git(worktree, "add", "-A");
      const deleted = await updateCheckout({ identity: wtIdentity, state, modelsRoot, primaryIdentity, deps });
      const deletedManifest = await readOverlayManifest(overlayStoreDir(stateRoot, deleted.generationId));
      expect(deletedManifest!.tombstones).toContain(path);
      expect(deletedManifest!.files[path]).toBeUndefined();
      const deletedRuntime = await restoreGeneration(stateRoot, deleted.generationId);
      expect(await searchPaths(deletedRuntime, "baseOnlySymbol")).toEqual([]);

      // 3. Excluded content (NUL) — tracked but not captured.
      write(worktree, path, Buffer.from([0x00, 0x01, 0x02]));
      git(worktree, "add", "-A");
      const excluded = await updateCheckout({ identity: wtIdentity, state, modelsRoot, primaryIdentity, deps });
      const excludedManifest = await readOverlayManifest(overlayStoreDir(stateRoot, excluded.generationId));
      expect(excludedManifest!.tombstones).toContain(path);
      expect(excludedManifest!.files[path]).toBeUndefined();
      const excludedRuntime = await restoreGeneration(stateRoot, excluded.generationId);
      expect(await searchPaths(excludedRuntime, "baseOnlySymbol")).toEqual([]);

      // 4. Revert exactly to base.
      write(worktree, path, BASE_FILES[path]);
      git(worktree, "add", "-A");
      const reverted = await updateCheckout({ identity: wtIdentity, state, modelsRoot, primaryIdentity, deps });
      const revertedManifest = await readOverlayManifest(overlayStoreDir(stateRoot, reverted.generationId));
      expect(revertedManifest!.tombstones).not.toContain(path);
      expect(revertedManifest!.files[path].hash).toBe(baseHash);
      expect(revertedManifest!.files[path].chunkCount).toBe(baseChunks);
      const revertedRuntime = await restoreGeneration(stateRoot, reverted.generationId);
      expect(await searchPaths(revertedRuntime, "baseOnlySymbol")).toEqual([]);

      expect(initial.baseId).toBe(g1.generationId);
      expect(reverted.baseId).toBe(g1.generationId);
    } finally {
      state.close();
    }
  });
});

describe("overlay: referenced base survives a new primary and prune", () => {
  test("prune retains a referenced old base that is no longer primary current", async () => {
    const base = makeTempRoot();
    const fixture = openFixture(base);
    const { repo, state, modelsRoot, deps } = fixture;
    try {
      const primaryIdentity = await resolveCheckout(repo);
      const g1 = await buildPrimary({ identity: primaryIdentity, state, modelsRoot, kind: "build", deps });

      const worktree = join(base, "wt-parent", "feature");
      addWorktree(repo, worktree, "wt-feature");
      write(worktree, "src/shared.ts", "export const sharedSymbol = 7;\n");
      const wtIdentity = await resolveCheckout(worktree);
      const overlay = await buildWorktree({
        identity: wtIdentity, state, modelsRoot, kind: "build", primaryIdentity, deps,
      });
      expect(overlay.baseId).toBe(g1.generationId);

      // New primary G2.
      write(repo, "src/other.ts", "export const otherSymbol = 9;\n");
      const g2 = await buildPrimary({ identity: primaryIdentity, state, modelsRoot, kind: "update", deps });
      expect(g2.generationId).not.toBe(g1.generationId);
      expect(
        state.readStatus({ checkoutKey: primaryIdentity.checkoutKey }).current[0]?.generationId,
      ).toBe(g2.generationId);

      const pruned = await state.prune({});
      expect(pruned.retained).toContain(g1.generationId);
      expect(pruned.retained).toContain(overlay.generationId);
      expect(pruned.deleted).not.toContain(g1.generationId);

      const manifest = await readOverlayManifest(overlayStoreDir(fixture.stateRoot, overlay.generationId));
      expect(manifest?.baseId).toBe(g1.generationId);
      expect(
        state.readStatus({ checkoutKey: wtIdentity.checkoutKey }).current[0]?.generationId,
      ).toBe(overlay.generationId);
    } finally {
      state.close();
    }
  });
});

describe("overlay: unavailable base and explicit isolated full generation", () => {
  test("a removed referenced base rejects overlay update while prior overlay current remains", async () => {
    const base = makeTempRoot();
    const fixture = openFixture(base);
    const { repo, state, stateRoot, modelsRoot, deps } = fixture;
    try {
      const primaryIdentity = await resolveCheckout(repo);
      const g1 = await buildPrimary({ identity: primaryIdentity, state, modelsRoot, kind: "build", deps });
      const worktree = join(base, "wt-parent", "feature");
      addWorktree(repo, worktree, "wt-feature");
      write(worktree, "src/shared.ts", "export const sharedSymbol = 4;\n");
      const wtIdentity = await resolveCheckout(worktree);
      const overlay = await buildWorktree({
        identity: wtIdentity, state, modelsRoot, kind: "build", primaryIdentity, deps,
      });

      // Remove the referenced base derived manifest.
      rmSync(join(overlayStoreDir(stateRoot, g1.generationId), "code-index-files.json"), { force: true });
      write(worktree, "src/shared.ts", "export const sharedSymbol = 5;\n");
      let corruptError: any = null;
      try {
        await updateCheckout({ identity: wtIdentity, state, modelsRoot, primaryIdentity, deps });
      } catch (error) {
        corruptError = error;
      }
      expect(corruptError).toBeInstanceOf(CodeIndexUnavailableError);
      expect(corruptError?.code).toBe("code-index-unavailable");
      expect(
        state.readStatus({ checkoutKey: wtIdentity.checkoutKey }).current[0]?.generationId,
      ).toBe(overlay.generationId);
    } finally {
      state.close();
    }
  });

  test("no primary identity yields a full isolated generation whose interrupted update keeps prior current", async () => {
    const base = makeTempRoot();
    let failAfterRename = false;
    const fixture = openFixture(base, () => {
      if (failAfterRename) throw new Error("simulated interruption after rename");
    });
    const { repo, state, modelsRoot, deps } = fixture;
    try {
      const worktree = join(base, "iso-parent", "feature");
      addWorktree(repo, worktree, "iso-feature");
      write(worktree, "src/shared.ts", "export const sharedSymbol = 11;\n");
      const wtIdentity = await resolveCheckout(worktree);

      const full = await buildWorktree({ identity: wtIdentity, state, modelsRoot, kind: "build", deps });
      expect(full.generationKind).toBe("full");
      expect(full.baseId).toBeNull();

      failAfterRename = true;
      write(worktree, "src/shared.ts", "export const sharedSymbol = 12;\n");
      await expect(
        updateCheckout({ identity: wtIdentity, state, modelsRoot, deps }),
      ).rejects.toThrow();
      expect(
        state.readStatus({ checkoutKey: wtIdentity.checkoutKey }).current[0]?.generationId,
      ).toBe(full.generationId);
    } finally {
      state.close();
    }
  });

  test("corrupt current overlay manifest or dump rejects update until explicit reindex", async () => {
    const base = makeTempRoot();
    const corruptions = [
      {
        name: "manifest",
        corrupt(storeDir: string) {
          writeFileSync(join(storeDir, "code-index-overlay.json"), "{invalid");
        },
      },
      {
        name: "dump",
        corrupt(storeDir: string) {
          rmSync(resolveCodeIndexStorePaths(storeDir).dumpPath, { force: true });
        },
      },
    ];

    for (const corruption of corruptions) {
      const fixtureRoot = join(base, corruption.name);
      mkdirSync(fixtureRoot, { recursive: true });
      const fixture = openFixture(fixtureRoot);
      const { repo, state, stateRoot, modelsRoot, deps } = fixture;
      try {
        const primaryIdentity = await resolveCheckout(repo);
        await buildPrimary({
          identity: primaryIdentity,
          state,
          modelsRoot,
          kind: "build",
          deps,
        });
        const worktree = join(fixtureRoot, "wt-parent", "feature");
        addWorktree(repo, worktree, `corrupt-${corruption.name}`);
        write(worktree, "src/shared.ts", "export const sharedSymbol = 20;\n");
        const wtIdentity = await resolveCheckout(worktree);
        const initial = await buildWorktree({
          identity: wtIdentity,
          state,
          modelsRoot,
          kind: "build",
          primaryIdentity,
          deps,
        });
        const initialStore = overlayStoreDir(stateRoot, initial.generationId!);
        corruption.corrupt(initialStore);
        write(worktree, "src/shared.ts", "export const sharedSymbol = 21;\n");

        await expect(
          updateCheckout({
            identity: wtIdentity,
            state,
            modelsRoot,
            primaryIdentity,
            deps,
          }),
        ).rejects.toMatchObject({ code: "code-index-unavailable" });
        expect(
          state.readStatus({ checkoutKey: wtIdentity.checkoutKey }).current[0]?.generationId,
        ).toBe(initial.generationId);

        const recovered = await buildWorktree({
          identity: wtIdentity,
          state,
          modelsRoot,
          kind: "reindex",
          primaryIdentity,
          deps,
        });
        expect(recovered.generationId).not.toBe(initial.generationId);
        expect(recovered.generationKind).toBe("overlay");
        const recoveredManifest = await readOverlayManifest(
          overlayStoreDir(stateRoot, recovered.generationId!),
        );
        expect(recoveredManifest?.files["src/shared.ts"].hash).toBe(
          hashOf("export const sharedSymbol = 21;\n"),
        );
      } finally {
        state.close();
      }
    }
  });
});
