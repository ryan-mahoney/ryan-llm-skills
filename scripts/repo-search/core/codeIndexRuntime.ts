import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  count as countDocuments,
  create,
  insertMultiple,
  load,
  removeMultiple,
  save,
  search,
  type RawData,
} from "@orama/orama";
import { decode, encode } from "@msgpack/msgpack";

import type { CodeChunk } from "./chunkContract";
import {
  CODE_INDEX_DIMENSIONS,
  CODE_INDEX_MODEL_ID,
} from "./embeddingContract";
import { resolveManifestPath } from "./fileManifest";

export const CODE_INDEX_VERSION = "code-index-runtime-v2";
const CODE_INDEX_BINARY_DUMP_FORMAT = "orama-server-msgpack-v1";
const CODE_INDEX_VECTOR_SCHEMA = `vector[${CODE_INDEX_DIMENSIONS}]` as const;
const CODE_INDEX_BINARY_MAX_DEPTH = 1_000;

export const DEFAULT_CODE_INDEX_REMOVE_BATCH_SIZE = 10_000;

export type CodeSearchMode = "hybrid" | "vector" | "bm25";

export type CodeSearchHit = {
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
  language: string;
  content: string;
  score: number;
};

export type CodeIndexStorePaths = {
  dumpPath: string;
  metaPath: string;
  manifestPath: string;
};

export type CodeIndexUpsertRow = CodeChunk & { embedding: number[] };

export type CodeSearchInput = {
  term: string;
  vector?: number[];
  mode: CodeSearchMode;
  limit: number;
};

export type CodeIndexRuntime = {
  upsert(rows: CodeIndexUpsertRow[]): Promise<void>;
  search(input: CodeSearchInput): Promise<CodeSearchHit[]>;
  count(): Promise<number>;
  persist(): Promise<void>;
  remove(ids: string[]): Promise<void>;
};

export type CodeIndexRuntimeOpenOptions = {
  open: "new" | "restore";
};

export class CodeIndexUnavailableError extends Error {
  readonly code = "code-index-unavailable";

  constructor(message = "Code index state is missing, corrupt or incompatible.", cause?: unknown) {
    super(message);
    this.name = "CodeIndexUnavailableError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

type CodeIndexPersistenceMeta = {
  version: typeof CODE_INDEX_VERSION;
  modelId: typeof CODE_INDEX_MODEL_ID;
  dimensions: typeof CODE_INDEX_DIMENSIONS;
  count: number;
  dumpFormat?: typeof CODE_INDEX_BINARY_DUMP_FORMAT;
};

const codeIndexSchema = {
  id: "string",
  embedding: CODE_INDEX_VECTOR_SCHEMA,
  path: "string",
  startLine: "number",
  endLine: "number",
  symbol: "string",
  scope: "string",
  language: "string",
  content: "string",
  contextualizedText: "string",
  chunkIndex: "number",
} as const;

type CodeIndexDatabase = Awaited<ReturnType<typeof create<typeof codeIndexSchema>>>;

type CodeIndexStoredRow = {
  id: string;
  embedding: number[];
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
  scope: string;
  language: string;
  content: string;
  contextualizedText: string;
  chunkIndex: number;
};

const searchableTextProperties: Array<
  keyof Pick<CodeIndexStoredRow, "contextualizedText" | "symbol" | "path">
> = ["contextualizedText", "symbol", "path"];

const RRF_K = 60;

export function codeSearchHitIdentity(hit: CodeSearchHit): string {
  return `${hit.path}#${hit.startLine}#${hit.endLine}`;
}

export function reciprocalRankFuse(
  lists: CodeSearchHit[][],
  limit: number,
): CodeSearchHit[] {
  const scoreMap = new Map<string, { score: number; hit: CodeSearchHit }>();

  for (const hits of lists) {
    for (let i = 0; i < hits.length; i++) {
      const key = codeSearchHitIdentity(hits[i]);
      const prev = scoreMap.get(key);
      const rrf = 1 / (RRF_K + i + 1);
      if (prev) {
        prev.score += rrf;
      } else {
        scoreMap.set(key, { score: rrf, hit: hits[i] });
      }
    }
  }

  const fused = [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return normalizeScores(fused.map((f) => ({ ...f.hit, score: f.score })));
}

function tokenizeCodeText(text: string): string {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s_\-./\\]+/)) {
    if (raw === "") continue;
    for (const word of raw.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      if (word === "") continue;
      const lower = word.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        tokens.push(word);
      }
    }
  }
  return tokens.join(" ");
}

function normalizeScores(hits: CodeSearchHit[]): CodeSearchHit[] {
  if (hits.length === 0) return hits;
  const maxScore = hits[0].score;
  if (maxScore <= 0) return hits.map((h) => ({ ...h, score: 0 }));
  return hits.map((h) => ({ ...h, score: h.score / maxScore }));
}

function fuseResults(
  bm25Hits: CodeSearchHit[],
  vectorHits: CodeSearchHit[],
  limit: number,
): CodeSearchHit[] {
  return reciprocalRankFuse([bm25Hits, vectorHits], limit);
}

export function resolveCodeIndexStorePaths(storeDir: string): CodeIndexStorePaths {
  const resolved = resolve(storeDir);
  return {
    dumpPath: join(resolved, "code-index.orama"),
    metaPath: join(resolved, "code-index-meta.json"),
    manifestPath: resolveManifestPath(resolved),
  };
}

export async function createCodeIndexRuntime(
  paths: CodeIndexStorePaths,
  options: CodeIndexRuntimeOpenOptions,
): Promise<CodeIndexRuntime> {
  let db: CodeIndexDatabase;
  if (options.open === "new") {
    db = createEmptyDatabase();
  } else if (options.open === "restore") {
    db = await restoreRuntimeStrict(paths);
  } else {
    throw new Error(`Invalid code index open mode: ${String(options.open)}.`);
  }

  const removeBatchSize = DEFAULT_CODE_INDEX_REMOVE_BATCH_SIZE;

  return {
    async upsert(rows) {
      if (rows.length === 0) return;

      const storedRows: CodeIndexStoredRow[] = rows.map((row) => normalizeRow(row));

      const ids = storedRows.map((row) => row.id);
      await removeMultiple(db, ids);
      await insertMultiple(db, storedRows);
    },

    async search(input) {
      assertSearchInput(input);

      if (input.mode === "bm25") {
        const results = await search<CodeIndexDatabase, CodeIndexStoredRow>(db, {
          mode: "fulltext" as const,
          term: input.term,
          properties: searchableTextProperties,
          limit: input.limit,
        });
        return normalizeScores(
          results.hits.map((hit) => mapSearchHit(hit.document, hit.score)),
        );
      }

      if (input.mode === "vector") {
        const results = await search<CodeIndexDatabase, CodeIndexStoredRow>(db, {
          mode: "vector" as const,
          term: input.term,
          vector: { value: input.vector ?? [], property: "embedding" },
          similarity: 0,
          limit: input.limit,
        });
        return normalizeScores(
          results.hits.map((hit) => mapSearchHit(hit.document, hit.score)),
        );
      }

      const [bm25Results, vectorResults] = await Promise.all([
        search<CodeIndexDatabase, CodeIndexStoredRow>(db, {
          mode: "fulltext" as const,
          term: input.term,
          properties: searchableTextProperties,
          limit: input.limit,
        }),
        search<CodeIndexDatabase, CodeIndexStoredRow>(db, {
          mode: "vector" as const,
          term: input.term,
          vector: { value: input.vector ?? [], property: "embedding" },
          similarity: 0,
          limit: input.limit,
        }),
      ]);

      const bm25Hits = bm25Results.hits.map((hit) =>
        mapSearchHit(hit.document, hit.score),
      );
      const vectorHits = vectorResults.hits.map((hit) =>
        mapSearchHit(hit.document, hit.score),
      );

      return fuseResults(bm25Hits, vectorHits, input.limit);
    },

    async count() {
      return await countDocuments(db);
    },

    async persist() {
      const meta = await createMeta(db);
      await writeRuntimeFilesAtomically(paths.dumpPath, paths.metaPath, db, meta);
    },

    async remove(ids) {
      if (ids.length === 0) return;
      for (let offset = 0; offset < ids.length; offset += removeBatchSize) {
        const batch = ids.slice(offset, offset + removeBatchSize);
        await removeMultiple(db, batch);
      }
    },
  };
}

function createEmptyDatabase(): CodeIndexDatabase {
  return create({ schema: codeIndexSchema });
}

function normalizeRow(row: CodeIndexUpsertRow): CodeIndexStoredRow {
  validateRow(row);

  const symbol = row.symbol ?? "";
  const subwords = tokenizeCodeText(row.contextualizedText + " " + symbol + " " + row.path);

  return {
    id: makeCodeChunkId(row.path, row.chunkIndex),
    embedding: row.embedding,
    path: row.path,
    startLine: row.startLine,
    endLine: row.endLine,
    symbol,
    scope: row.scope ?? "",
    language: row.language ?? "",
    content: row.content,
    contextualizedText: row.contextualizedText + " " + subwords,
    chunkIndex: row.chunkIndex,
  };
}

export function makeCodeChunkId(path: string, chunkIndex: number): string {
  return `${path}#${chunkIndex}`;
}

function mapSearchHit(row: CodeIndexStoredRow, score: number): CodeSearchHit {
  return {
    path: row.path,
    startLine: row.startLine,
    endLine: row.endLine,
    symbol: row.symbol,
    language: row.language,
    content: row.content,
    score: Number.isFinite(score) ? score : 0,
  };
}

function assertSearchInput(input: CodeSearchInput): void {
  assertNonEmptyString(input.term, "term");
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new Error("Invalid limit: expected a positive integer.");
  }
  if (input.mode !== "bm25" && input.mode !== "vector" && input.mode !== "hybrid") {
    throw new Error("Invalid mode: expected 'bm25', 'vector', or 'hybrid'.");
  }
  if (input.mode !== "bm25") {
    assertVector(input.vector, "vector");
  }
}

function validateRow(row: CodeIndexUpsertRow): void {
  assertNonEmptyString(row.path, "path");
  assertNonEmptyString(row.content, "content");
  assertNonEmptyString(row.contextualizedText, "contextualizedText");
  assertVector(row.embedding, "embedding");
  if (!Number.isInteger(row.startLine) || row.startLine < 1) {
    throw new Error("Invalid startLine: expected a positive integer.");
  }
  if (!Number.isInteger(row.endLine) || row.endLine < row.startLine) {
    throw new Error("Invalid endLine: expected an integer >= startLine.");
  }
  if (!Number.isInteger(row.chunkIndex) || row.chunkIndex < 0) {
    throw new Error("Invalid chunkIndex: expected a non-negative integer.");
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${field}: expected a non-empty string.`);
  }
}

function assertVector(value: unknown, field: string): asserts value is number[] {
  if (
    !Array.isArray(value) ||
    value.length !== CODE_INDEX_DIMENSIONS ||
    value.some((entry) => !Number.isFinite(entry))
  ) {
    throw new Error(
      `Invalid ${field}: expected a ${CODE_INDEX_DIMENSIONS}-dimensional vector.`,
    );
  }
}

async function writeRuntimeFilesAtomically(
  dumpPath: string,
  metaPath: string,
  db: CodeIndexDatabase,
  meta: CodeIndexPersistenceMeta,
): Promise<void> {
  await Promise.all([
    mkdir(dirname(dumpPath), { recursive: true }),
    mkdir(dirname(metaPath), { recursive: true }),
  ]);

  const dumpTempPath = `${dumpPath}.tmp-${process.pid}-${Date.now()}`;
  const metaTempPath = `${metaPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await persistBinaryDumpToFile(db, dumpTempPath);
    await writeFile(metaTempPath, JSON.stringify(meta, null, 2));
    await rename(dumpTempPath, dumpPath);
    await rename(metaTempPath, metaPath);
  } catch (error) {
    await Promise.all([
      unlink(dumpTempPath).catch(() => undefined),
      unlink(metaTempPath).catch(() => undefined),
    ]);
    throw error;
  }
}

async function persistBinaryDumpToFile(
  db: CodeIndexDatabase,
  dumpPath: string,
): Promise<void> {
  const dbExport = await save(db);
  const msgpack = encode(dbExport, { maxDepth: CODE_INDEX_BINARY_MAX_DEPTH });
  const dumpBuffer = Buffer.from(
    msgpack.buffer,
    msgpack.byteOffset,
    msgpack.byteLength,
  );
  await writeFile(dumpPath, dumpBuffer);
}

async function restoreBinaryDumpFromFile(
  dumpPath: string,
): Promise<CodeIndexDatabase> {
  const db = createEmptyDatabase();
  load(db, decode(await readFile(dumpPath)) as RawData);
  return db;
}

async function createMeta(db: CodeIndexDatabase): Promise<CodeIndexPersistenceMeta> {
  const count = await countDocuments(db);
  return {
    version: CODE_INDEX_VERSION,
    modelId: CODE_INDEX_MODEL_ID,
    dimensions: CODE_INDEX_DIMENSIONS,
    count,
    dumpFormat: CODE_INDEX_BINARY_DUMP_FORMAT,
  };
}

async function restoreRuntimeStrict(
  paths: CodeIndexStorePaths,
): Promise<CodeIndexDatabase> {
  try {
    const meta = parseMetaValue(JSON.parse(await readFile(paths.metaPath, "utf8")));
    if (meta.dumpFormat !== CODE_INDEX_BINARY_DUMP_FORMAT) {
      throw new Error("Unsupported code index dump format.");
    }

    const db = await restoreBinaryDumpFromFile(paths.dumpPath);
    const restoredCount = await countDocuments(db);
    if (restoredCount !== meta.count) {
      throw new Error(
        `Code index count mismatch: expected ${meta.count}, restored ${restoredCount}.`,
      );
    }
    return db;
  } catch (error) {
    throw new CodeIndexUnavailableError(undefined, error);
  }
}

function parseMetaValue(value: unknown): CodeIndexPersistenceMeta {
  const meta = value as Partial<CodeIndexPersistenceMeta>;
  const dumpFormat = meta.dumpFormat;
  if (
    meta.version !== CODE_INDEX_VERSION ||
    meta.modelId !== CODE_INDEX_MODEL_ID ||
    meta.dimensions !== CODE_INDEX_DIMENSIONS ||
    !Number.isInteger(meta.count) ||
    (meta.count as number) < 0 ||
    (dumpFormat !== undefined && dumpFormat !== CODE_INDEX_BINARY_DUMP_FORMAT)
  ) {
    throw new Error("Invalid code index metadata.");
  }

  return {
    version: CODE_INDEX_VERSION,
    modelId: CODE_INDEX_MODEL_ID,
    dimensions: CODE_INDEX_DIMENSIONS,
    count: meta.count as number,
    ...(dumpFormat === undefined ? {} : { dumpFormat }),
  };
}
