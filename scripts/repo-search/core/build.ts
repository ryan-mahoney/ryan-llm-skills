// Captured-snapshot primary index builder.
//
// Consumes source.ts captured Snapshot buffers (never rereads checkout paths),
// a prepared plan, and a destination staging directory. Persists an Orama
// index plus a complete sorted file manifest, then strict-validates the result.
// Only the embedding extractor may be substituted in tests.

import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { chunkFile } from "./chunk";
import type { CodeChunk } from "./chunkContract";
import { languageForPath, routeStrategy } from "./route";
import {
  createCodeIndexRuntime,
  makeCodeChunkId,
  resolveCodeIndexStorePaths,
  type CodeIndexRuntime,
  type CodeIndexUpsertRow,
} from "./codeIndexRuntime";
import {
  diffManifest,
  readFileManifest,
  resolveManifestPath,
  writeFileManifest,
  type FileManifest,
  type FileManifestEntry,
} from "./fileManifest";
import {
  createCodeEmbeddingCacheNamespace,
  openCodeEmbeddingCache,
  type CodeEmbeddingCache,
} from "./codeEmbeddingCache";
import type { CodeEmbeddingRuntime } from "./codeEmbeddingRuntime";
import {
  CPU_CODE_EMBED_BATCH_SIZE,
  type CodeSearchCompatibility,
} from "./embeddingContract";
import type { VerifiedModel } from "./codeModelAssets";
import type { Snapshot } from "../source";
import {
  createBoundedBuildReporter,
  NOOP_BUILD_PROGRESS,
  type BuildProgressReporter,
} from "./buildProgress";

export const CODE_INDEX_MANIFEST_VERSION = "code-index-files-v1";
export const MAX_CHANGED_BYTES = 100 * 1024 * 1024;
export const MAX_TOTAL_CHUNKS = 250_000;

export type BuildEmbeddingRuntimeFactory = (input: {
  modelsRoot: string;
  model: VerifiedModel;
  compatibility: CodeSearchCompatibility;
}) => Promise<CodeEmbeddingRuntime>;

export type CodeIndexBuildPlan = {
  previousManifest: FileManifest | undefined;
  previousStoreDir: string | undefined;
  changed: string[];
  deleted: string[];
  unchanged: string[];
  changedBytes: number;
};

export type CodeIndexBuildResult = {
  count: number;
  embedded: number;
  cached: number;
  cacheDisabled: boolean;
  derivedBytes: number;
};

export type CodeIndexBuildValidation = {
  count: number;
  chunks: number;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("code index build aborted");
    error.name = "AbortError";
    throw error;
  }
}

function snapshotEntries(snapshot: Snapshot): Array<{ path: string; hash: string }> {
  return [...snapshot.files.values()].map((file) => ({
    path: file.path,
    hash: file.sha256,
  }));
}

async function defaultEmbeddingRuntimeFactory(input: {
  modelsRoot: string;
  model: VerifiedModel;
  compatibility: CodeSearchCompatibility;
}): Promise<CodeEmbeddingRuntime> {
  // Dynamic import keeps the optional native dependency out of the package's
  // static closure. Local files only: no provisioning, network or install.
  const { createCodeEmbeddingRuntime } = await import("./codeEmbeddingRuntime");
  return createCodeEmbeddingRuntime({
    manifest: {
      modelId: input.model.modelId,
      modelsRoot: input.modelsRoot,
      modelDir: input.model.modelDir,
      requiredFiles: input.model.files.map((file) => file.path),
    },
  });
}

/**
 * Diff a captured snapshot against an optional prior store. A supplied prior
 * store must have a readable valid manifest; missing/corrupt is unavailable and
 * never a cold fallback. Enforces the incremental changed-byte ceiling.
 */
export async function planCodeIndexBuild(input: {
  snapshot: Snapshot;
  previousStoreDir?: string;
  signal?: AbortSignal;
}): Promise<CodeIndexBuildPlan> {
  throwIfAborted(input.signal);
  const entries = snapshotEntries(input.snapshot);

  let previousManifest: FileManifest | undefined;
  if (input.previousStoreDir !== undefined) {
    previousManifest = await readFileManifest(
      resolveManifestPath(input.previousStoreDir),
    );
    if (previousManifest === undefined) {
      throw new Error(
        `Prior generation manifest is missing or corrupt: ${input.previousStoreDir}`,
      );
    }
  }

  const diff = diffManifest(previousManifest, entries);

  let changedBytes = 0;
  for (const path of diff.changed) {
    const file = input.snapshot.files.get(path);
    if (file) changedBytes += file.bytes.length;
  }

  if (previousManifest !== undefined && changedBytes > MAX_CHANGED_BYTES) {
    throw new Error(
      `Changed bytes ${changedBytes} exceed the ${MAX_CHANGED_BYTES} byte ceiling.`,
    );
  }

  return {
    previousManifest,
    previousStoreDir: input.previousStoreDir,
    changed: diff.changed,
    deleted: diff.deleted,
    unchanged: diff.unchanged,
    changedBytes,
  };
}

type ReplacementChunk = CodeChunk & { embedding: number[] };

async function copyPriorStore(
  previousStoreDir: string,
  destinationDir: string,
): Promise<void> {
  const previous = resolveCodeIndexStorePaths(previousStoreDir);
  const destination = resolveCodeIndexStorePaths(destinationDir);
  await mkdir(destinationDir, { recursive: true });
  await copyFile(previous.dumpPath, destination.dumpPath);
  await copyFile(previous.metaPath, destination.metaPath);
  await copyFile(
    resolveManifestPath(previousStoreDir),
    resolveManifestPath(destinationDir),
  );
}

async function chunkCapturedFile(path: string, bytes: Buffer): Promise<CodeChunk[]> {
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return chunkFile({
    path,
    content,
    strategy: routeStrategy(path),
    language: languageForPath(path),
  });
}

function chunkBatches<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, offset + size));
  }
  return batches;
}

async function embedReplacementChunks(input: {
  chunks: CodeChunk[];
  compatibility: CodeSearchCompatibility;
  modelsRoot: string;
  model: VerifiedModel;
  cachePath?: string;
  factory: BuildEmbeddingRuntimeFactory;
  signal?: AbortSignal;
  progress: BuildProgressReporter;
}): Promise<{ vectors: Map<string, number[]>; embedded: number; cached: number; cacheDisabled: boolean }> {
  const texts = [...new Set(input.chunks.map((chunk) => chunk.contextualizedText))];
  const vectors = new Map<string, number[]>();
  let cacheDisabled = false;
  let cache: CodeEmbeddingCache | undefined;
  const namespace = createCodeEmbeddingCacheNamespace(input.compatibility);

  if (texts.length > 0 && input.cachePath) {
    try {
      cache = openCodeEmbeddingCache({ filePath: input.cachePath });
      const { hits } = cache.getMany({ namespace, texts, nowMs: Date.now() });
      for (const [text, vector] of hits) vectors.set(text, vector);
    } catch {
      cacheDisabled = true;
      if (cache) {
        try {
          cache.close();
        } catch {
          // best-effort close before disabling the cache
        }
      }
      cache = undefined;
    }
  }

  const misses = texts.filter((text) => !vectors.has(text));
  let embedded = 0;

  try {
    if (misses.length > 0) {
      const runtime = await input.factory({
        modelsRoot: input.modelsRoot,
        model: input.model,
        compatibility: input.compatibility,
      });
      try {
        for (const batch of chunkBatches(misses, CPU_CODE_EMBED_BATCH_SIZE)) {
          throwIfAborted(input.signal);
          const batchVectors = await runtime.embedBatch(batch);
          batch.forEach((text, index) => vectors.set(text, batchVectors[index]));
          embedded += batch.length;
          input.progress({ type: "embedded", embedded, cached: texts.length - misses.length });
        }
      } finally {
        if (typeof runtime.dispose === "function") await runtime.dispose();
      }

      if (cache && !cacheDisabled) {
        try {
          cache.putMany({
            namespace,
            rows: misses.map((text) => ({ text, embedding: vectors.get(text) as number[] })),
            nowMs: Date.now(),
          });
        } catch {
          cacheDisabled = true;
        }
      }
    }
  } finally {
    if (cache) {
      try {
        cache.close();
      } catch {
        // a derived-cache close failure must not invalidate the generation
      }
    }
  }

  return { vectors, embedded, cached: texts.length - misses.length, cacheDisabled };
}

/**
 * Build a generation into `destinationDir` from captured snapshot bytes.
 */
export async function buildCodeIndex(input: {
  plan: CodeIndexBuildPlan;
  snapshot: Snapshot;
  destinationDir: string;
  compatibility: CodeSearchCompatibility;
  model: VerifiedModel;
  modelsRoot: string;
  cachePath?: string;
  signal?: AbortSignal;
  createEmbeddingRuntime?: BuildEmbeddingRuntimeFactory;
  progress?: BuildProgressReporter;
}): Promise<CodeIndexBuildResult> {
  const progress = createBoundedBuildReporter(input.progress ?? NOOP_BUILD_PROGRESS);
  const factory = input.createEmbeddingRuntime ?? defaultEmbeddingRuntimeFactory;
  const paths = resolveCodeIndexStorePaths(input.destinationDir);

  progress({ type: "phase", phase: "restoring" });
  let runtime: CodeIndexRuntime;
  if (input.plan.previousStoreDir && input.plan.previousManifest) {
    await copyPriorStore(input.plan.previousStoreDir, input.destinationDir);
    runtime = await createCodeIndexRuntime(paths, { open: "restore" });
  } else {
    await mkdir(input.destinationDir, { recursive: true });
    runtime = await createCodeIndexRuntime(paths, { open: "new" });
  }

  throwIfAborted(input.signal);
  progress({ type: "phase", phase: "chunking" });

  // Remove prior chunks for every changed/deleted path before replacements.
  const removeIds: string[] = [];
  for (const path of [...input.plan.changed, ...input.plan.deleted]) {
    const previous = input.plan.previousManifest?.files[path];
    if (!previous) continue;
    for (let index = 0; index < previous.chunkCount; index += 1) {
      removeIds.push(makeCodeChunkId(path, index));
    }
  }
  if (removeIds.length > 0) await runtime.remove(removeIds);

  const chunkCountByPath = new Map<string, number>();
  const replacementChunks: CodeChunk[] = [];
  let totalChunks = 0;
  if (input.plan.previousManifest) {
    for (const [path, entry] of Object.entries(input.plan.previousManifest.files)) {
      if (input.plan.deleted.includes(path) || input.plan.changed.includes(path)) continue;
      totalChunks += entry.chunkCount;
    }
  }
  for (const path of input.plan.changed) {
    const file = input.snapshot.files.get(path);
    if (!file) continue;
    const chunks = await chunkCapturedFile(path, file.bytes);
    chunkCountByPath.set(path, chunks.length);
    totalChunks += chunks.length;
    replacementChunks.push(...chunks);
  }
  if (totalChunks > MAX_TOTAL_CHUNKS) {
    throw new Error(`Total chunks ${totalChunks} exceed the ${MAX_TOTAL_CHUNKS} chunk ceiling.`);
  }
  progress({ type: "complete", phase: "chunking", count: totalChunks });

  throwIfAborted(input.signal);
  progress({ type: "phase", phase: "embedding" });
  const embedding = await embedReplacementChunks({
    chunks: replacementChunks,
    compatibility: input.compatibility,
    modelsRoot: input.modelsRoot,
    model: input.model,
    cachePath: input.cachePath,
    factory,
    signal: input.signal,
    progress,
  });

  throwIfAborted(input.signal);
  const rows: CodeIndexUpsertRow[] = replacementChunks.map((chunk) => ({
    ...chunk,
    embedding: embedding.vectors.get(chunk.contextualizedText) as number[],
  }));
  if (rows.length > 0) await runtime.upsert(rows);

  progress({ type: "phase", phase: "persisting" });
  await runtime.persist();

  const files: Record<string, FileManifestEntry> = {};
  if (input.plan.previousManifest) {
    for (const [path, entry] of Object.entries(input.plan.previousManifest.files)) {
      if (input.plan.deleted.includes(path) || input.plan.changed.includes(path)) continue;
      files[path] = entry;
    }
  }
  for (const path of input.plan.changed) {
    const file = input.snapshot.files.get(path);
    if (!file) continue;
    files[path] = {
      hash: file.sha256,
      chunkCount: chunkCountByPath.get(path) ?? 0,
    };
  }
  const manifest: FileManifest = {
    version: CODE_INDEX_MANIFEST_VERSION,
    modelId: input.compatibility.modelId,
    dimensions: input.compatibility.dimensions,
    files,
  };
  await writeFileManifest(resolveManifestPath(input.destinationDir), manifest);

  progress({ type: "phase", phase: "validating" });
  const validation = await validateCodeIndexBuild({
    destinationDir: input.destinationDir,
    compatibility: input.compatibility,
    snapshot: input.snapshot,
  });

  let derivedBytes = 0;
  for (const path of [paths.dumpPath, paths.metaPath, resolveManifestPath(input.destinationDir)]) {
    try {
      derivedBytes += (await stat(path)).size;
    } catch {
      // derive only from files that exist
    }
  }

  progress({ type: "complete", phase: "done", count: validation.count });
  return {
    count: validation.count,
    embedded: embedding.embedded,
    cached: embedding.cached,
    cacheDisabled: embedding.cacheDisabled,
    derivedBytes,
  };
}

/**
 * Strict-restore the destination and prove manifest/model/dimension identity,
 * exact snapshot path/hash coverage, and runtime count equals summed chunkCount.
 */
export async function validateCodeIndexBuild(input: {
  destinationDir: string;
  compatibility: CodeSearchCompatibility;
  snapshot: Snapshot;
}): Promise<CodeIndexBuildValidation> {
  const manifest = await readFileManifest(resolveManifestPath(input.destinationDir));
  if (manifest === undefined) {
    throw new Error(`Generation manifest is missing or corrupt: ${input.destinationDir}`);
  }
  if (manifest.version !== CODE_INDEX_MANIFEST_VERSION) {
    throw new Error(`Unexpected manifest version: ${manifest.version}`);
  }
  if (manifest.modelId !== input.compatibility.modelId) {
    throw new Error(`Manifest model mismatch: ${manifest.modelId}`);
  }
  if (manifest.dimensions !== input.compatibility.dimensions) {
    throw new Error(`Manifest dimensions mismatch: ${manifest.dimensions}`);
  }

  const manifestPaths = Object.keys(manifest.files).sort();
  const snapshotPaths = [...input.snapshot.files.keys()].sort();
  if (
    manifestPaths.length !== snapshotPaths.length ||
    manifestPaths.some((path, index) => path !== snapshotPaths[index])
  ) {
    throw new Error("Manifest paths do not match the captured snapshot paths.");
  }
  for (const [path, entry] of Object.entries(manifest.files)) {
    const file = input.snapshot.files.get(path);
    if (!file || file.sha256 !== entry.hash) {
      throw new Error(`Manifest hash mismatch for ${path}.`);
    }
  }

  const runtime = await createCodeIndexRuntime(
    resolveCodeIndexStorePaths(input.destinationDir),
    { open: "restore" },
  );
  const count = await runtime.count();
  const chunks = Object.values(manifest.files).reduce(
    (sum, entry) => sum + entry.chunkCount,
    0,
  );
  if (count !== chunks) {
    throw new Error(`Restored count ${count} does not match manifest chunks ${chunks}.`);
  }
  return { count, chunks };
}
