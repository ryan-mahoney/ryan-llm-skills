import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertStateGrowth, MAX_DUMP_BYTES, measureState, ResourceBudgetError } from "./resources";
import { createCodeIndexRuntime, resolveCodeIndexStorePaths } from "./codeIndexRuntime";
import { openCodeEmbeddingCache } from "./codeEmbeddingCache";
import { CODE_INDEX_DIMENSIONS } from "./embeddingContract";
const roots: string[] = [];
function root() { const dir = mkdtempSync(join(tmpdir(), "repo-search-budget-")); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("byte accounting includes SQLite sidecars and abandoned temporary files before growth", () => {
  const dir = root();
  mkdirSync(join(dir, "generations", "orphan.tmp"), { recursive: true });
  mkdirSync(join(dir, "generations", "retained"));
  writeFileSync(join(dir, "state.sqlite"), Buffer.alloc(10));
  writeFileSync(join(dir, "state.sqlite-wal"), Buffer.alloc(11));
  writeFileSync(join(dir, "embedding-cache.sqlite-wal"), Buffer.alloc(12));
  writeFileSync(join(dir, "generations", "retained", "dump"), Buffer.alloc(13));
  writeFileSync(join(dir, "generations", "orphan.tmp", "dump.tmp"), Buffer.alloc(14));
  expect(measureState(dir)).toEqual({ committed: 46, temporary: 14 });
  expect(() => assertStateGrowth(dir, 7, 0, { committed: 50, temporary: 20 }, 100)).toThrow(ResourceBudgetError);
  expect(() => assertStateGrowth(dir, 0, 5, { committed: 50, temporary: 20 }, 100)).toThrow(ResourceBudgetError);
  expect(() => assertStateGrowth(dir, 1, 0, { committed: 50, temporary: 20 }, 0)).toThrow("available disk");
  expect(() => assertStateGrowth(dir, 0, 14, { committed: 60, temporary: 20 }, 1, 1)).not.toThrow();
});

test("restore rejects an oversized sparse dump before reading or decoding it", async () => {
  const paths = resolveCodeIndexStorePaths(root());
  const runtime = await createCodeIndexRuntime(paths, { open: "new" });
  await runtime.persist();
  const fd = openSync(paths.dumpPath, "w");
  try { ftruncateSync(fd, MAX_DUMP_BYTES + 1); } finally { closeSync(fd); }
  await expect(createCodeIndexRuntime(paths, { open: "restore" })).rejects.toMatchObject({ code: "budget-exceeded" });
});

test("cache insertion enforces row capacity and refuses budget growth before writes", () => {
  const filePath = join(root(), "embedding-cache.sqlite");
  let rejectGrowth = false;
  const cache = openCodeEmbeddingCache({ filePath, maxRows: 2,
    beforeWrite: () => { if (rejectGrowth) throw new ResourceBudgetError("quota fixture"); } });
  try {
    cache.putMany({ namespace: "fixture", nowMs: 1, rows: ["first", "second", "third"].map(text => ({ text, embedding: Array(CODE_INDEX_DIMENSIONS).fill(0.5) })) });
    const db = new Database(filePath);
    try { expect((db.query("SELECT COUNT(*) AS n FROM code_embedding_cache").get() as any).n).toBe(2); }
    finally { db.close(); }
    rejectGrowth = true;
    expect(() => cache.putMany({ namespace: "fixture", nowMs: 2, rows: [{ text: "refused", embedding: Array(CODE_INDEX_DIMENSIONS).fill(1) }] })).toThrow("quota fixture");
  } finally { cache.close(); }
});

test("model loader uses verified local configuration despite conflicting disk and custom caches", async () => {
  const { env, AutoConfig } = await import("@huggingface/transformers");
  const { configureTransformersLocalModelPath, resetTransformersLocalModelPathForTests } = await import("./transformersEnv");
  const keys = ["cacheDir", "localModelPath", "allowRemoteModels", "allowLocalModels", "useFSCache", "useBrowserCache", "useCustomCache", "customCache", "fetch"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, (env as any)[key]]));
  const dir = root();
  const modelId = "jinaai/jina-embeddings-v2-base-code";
  try {
    const local = join(dir, "models"), cache = join(dir, "cache");
    for (const [path, marker] of [[local, "verified"], [cache, "unverified"]]) {
      mkdirSync(join(path, modelId), { recursive: true });
      writeFileSync(join(path, modelId, "config.json"), JSON.stringify({ model_type: "bert", marker }));
    }
    env.cacheDir = cache;
    (env as any).fetch = async () => { throw new Error("unexpected network"); };
    configureTransformersLocalModelPath(local);
    const loaded = await AutoConfig.from_pretrained(modelId, { local_files_only: true });
    expect((loaded as any).marker).toBe("verified");
    env.localModelPath = cache;
    env.useFSCache = true;
    env.useCustomCache = true;
    env.customCache = { match: async () => new Response(JSON.stringify({ model_type: "bert", marker: "custom" })) } as any;
    configureTransformersLocalModelPath(local);
    expect(((await AutoConfig.from_pretrained(modelId, { local_files_only: true })) as any).marker).toBe("verified");
  } finally {
    for (const key of keys) (env as any)[key] = saved[key];
    resetTransformersLocalModelPathForTests();
  }
});
