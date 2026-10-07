import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chunkFile } from "./chunk";
import { languageForPath, routeStrategy } from "./route";
import {
  CodeIndexUnavailableError,
  createCodeIndexRuntime,
  resolveCodeIndexStorePaths,
  type CodeIndexUpsertRow,
} from "./codeIndexRuntime";
import {
  DEFAULT_CODE_EMBEDDING_CACHE_MAX_ROWS,
  createCodeEmbeddingCacheNamespace,
  encodeEmbeddingVector,
  openCodeEmbeddingCache,
  sha256Text,
} from "./codeEmbeddingCache";
import {
  CODE_INDEX_DIMENSIONS,
  createCodeSearchCompatibility,
} from "./embeddingContract";
import { CODE_MODEL_ID } from "./codeModelAssets";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "repo-search-core-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function makeVector(seed: number): number[] {
  return Array.from(
    { length: CODE_INDEX_DIMENSIONS },
    (_, index) => ((seed * 31 + index) % 101) / 101,
  );
}

async function expectUnavailable(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CodeIndexUnavailableError);
}

describe("code index runtime", () => {
  test("persists and strictly restores msgpack Orama state", async () => {
    const dir = await makeTempDir();
    const paths = resolveCodeIndexStorePaths(dir);

    const runtime = await createCodeIndexRuntime(paths, { open: "new" });
    expect(await runtime.count()).toBe(0);

    const row: CodeIndexUpsertRow = {
      path: "src/zebra.ts",
      content: "export const zebrafishMarker = 1;",
      contextualizedText: "// src/zebra.ts\nzebrafishMarker",
      startLine: 1,
      endLine: 1,
      symbol: "zebrafishMarker",
      scope: "",
      language: "typescript",
      chunkIndex: 0,
      embedding: makeVector(7),
    };
    await runtime.upsert([row]);
    expect(await runtime.count()).toBe(1);

    const hits = await runtime.search({
      term: "zebrafishMarker",
      mode: "bm25",
      limit: 5,
    });
    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe("src/zebra.ts");

    await runtime.persist();

    const restored = await createCodeIndexRuntime(paths, { open: "restore" });
    expect(await restored.count()).toBe(1);
    const restoredHits = await restored.search({
      term: "zebrafishMarker",
      mode: "bm25",
      limit: 5,
    });
    expect(restoredHits.length).toBe(1);
    expect(restoredHits[0].path).toBe("src/zebra.ts");

    // Corrupt metadata: strict restore must refuse.
    await writeFile(paths.metaPath, "{ not valid json", "utf8");
    await expectUnavailable(createCodeIndexRuntime(paths, { open: "restore" }));

    // open: new ignores existing (corrupt) files.
    const fresh = await createCodeIndexRuntime(paths, { open: "new" });
    expect(await fresh.count()).toBe(0);
    expect(await fresh.search({ term: "zebrafishMarker", mode: "bm25", limit: 5 })).toEqual([]);

    // Rewrite good files, then corrupt the dump.
    await restored.persist();
    await writeFile(paths.dumpPath, Buffer.from("this is not a msgpack dump"));
    await expectUnavailable(createCodeIndexRuntime(paths, { open: "restore" }));
  });
});

describe("code embedding cache", () => {
  test("namespace identity and SQLite round trip", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "embeddings.sqlite");

    const compatibilityA = createCodeSearchCompatibility({
      modelId: CODE_MODEL_ID,
      assetDigest: "digest-a",
    });
    const compatibilityB = createCodeSearchCompatibility({
      modelId: CODE_MODEL_ID,
      assetDigest: "digest-b",
    });
    const namespaceA = createCodeEmbeddingCacheNamespace(compatibilityA);
    const namespaceB = createCodeEmbeddingCacheNamespace(compatibilityB);
    expect(namespaceA).not.toBe(namespaceB);
    expect(namespaceA).toContain("digest-a");
    expect(namespaceA).toContain("chunkVersion");

    const vector = makeVector(3);

    let cache = openCodeEmbeddingCache({ filePath });
    cache.putMany({
      namespace: namespaceA,
      rows: [{ text: "alpha", embedding: vector }],
      nowMs: 1,
    });
    cache.close();

    // Inject a dimension-invalid stored row directly.
    const raw = new Database(filePath);
    raw.run(
      `INSERT INTO code_embedding_cache
         (namespace, text_sha256, dimensions, vector_blob, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [namespaceA, sha256Text("broken"), 4, Buffer.alloc(4 * 4), 1, 1],
    );
    raw.close();

    cache = openCodeEmbeddingCache({ filePath });
    const got = cache.getMany({
      namespace: namespaceA,
      texts: ["alpha", "broken", "missing"],
      nowMs: 2,
    });
    expect(got.hits.size).toBe(1);
    const alpha = got.hits.get("alpha");
    expect(alpha).toBeDefined();
    expect(encodeEmbeddingVector(alpha!).equals(encodeEmbeddingVector(vector))).toBe(true);
    expect(got.invalidRows).toBe(1);

    const afterRemoval = cache.getMany({
      namespace: namespaceA,
      texts: ["broken"],
      nowMs: 3,
    });
    expect(afterRemoval.hits.size).toBe(0);
    expect(afterRemoval.invalidRows).toBe(0);

    // A different asset digest yields a different namespace with no hits.
    const otherNamespace = cache.getMany({
      namespace: namespaceB,
      texts: ["alpha"],
      nowMs: 4,
    });
    expect(otherNamespace.hits.size).toBe(0);
    cache.close();

    expect(DEFAULT_CODE_EMBEDDING_CACHE_MAX_ROWS).toBe(100_000);
  });
});

describe("chunking", () => {
  test("line window numbering, empty content, and real AST chunks", async () => {
    const source = "first line\nsecond line\nthird line";
    const expectedLines = source.split("\n");

    const windowChunks = await chunkFile({
      path: "notes.txt",
      content: source,
      strategy: "lineWindow",
      language: "",
    });
    expect(windowChunks.length).toBe(1);
    expect(windowChunks[0].startLine).toBe(1);
    expect(windowChunks[0].endLine).toBe(expectedLines.length);
    expect(windowChunks[0].content).toBe(source);
    expect(windowChunks[0].symbol).toBe("");

    expect(
      await chunkFile({ path: "empty.ts", content: "", strategy: "lineWindow", language: "typescript" }),
    ).toEqual([]);
    expect(
      await chunkFile({ path: "blank.ts", content: "   \n\t\n", strategy: "ast", language: "typescript" }),
    ).toEqual([]);

    expect(routeStrategy("sample.ts")).toBe("ast");
    expect(languageForPath("sample.ts")).toBe("typescript");

    // A real TypeScript snippet. The AST path derives a non-empty symbol from
    // code-chunk's scope tree; lineWindow always yields symbol "".
    const ts = [
      "interface Point { x: number; y: number; }",
      "",
      "export function dist(a: Point, b: Point): number {",
      "  return Math.hypot(a.x - b.x, a.y - b.y);",
      "}",
    ].join("\n");

    const astChunks = await chunkFile({
      path: "sample.ts",
      content: ts,
      strategy: "ast",
      language: "typescript",
    });
    expect(astChunks.length).toBeGreaterThan(0);
    expect(astChunks.some((chunk) => chunk.symbol === "Point")).toBe(true);
    expect(astChunks[0].path).toBe("sample.ts");
  });
});

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    // Static imports: `import x from "m"`, `import { y } from "m"`, `import "m"`.
    /\bimport\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g,
    // Dynamic imports: `import("m")`, `await import("m")`.
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    // CommonJS requires: `require("m")`.
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

describe("core independence", () => {
  test("no product or forbidden dependency import specifiers in core sources", async () => {
    const files = [
      "chunk.ts",
      "route.ts",
      "fileManifest.ts",
      "codeIndexRuntime.ts",
      "codeEmbeddingCache.ts",
      "embeddingContract.ts",
      "codeModelAssets.ts",
    ];
    const forbiddenBareModules = [
      "@orama/plugin-data-persistence",
      "@huggingface/transformers",
    ];

    let codeIndexRuntimeSpecifierCount = 0;
    for (const file of files) {
      const text = await readFile(join(import.meta.dir, file), "utf8");
      const specifiers = extractImportSpecifiers(text);
      if (file === "codeIndexRuntime.ts") {
        codeIndexRuntimeSpecifierCount = specifiers.length;
      }

      for (const specifier of specifiers) {
        expect(specifier.startsWith("..")).toBe(false);
        expect(forbiddenBareModules.includes(specifier)).toBe(false);
        expect(specifier.includes("rearrange-writer")).toBe(false);
      }
    }

    // Guard against a silently broken extraction regex.
    expect(codeIndexRuntimeSpecifierCount).toBeGreaterThanOrEqual(3);
  });
});
