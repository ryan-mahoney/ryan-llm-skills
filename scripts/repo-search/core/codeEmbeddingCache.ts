import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

import {
  CODE_INDEX_DIMENSIONS,
  type CodeSearchCompatibility,
} from "./embeddingContract";

export const CODE_EMBEDDING_CACHE_SCHEMA_VERSION = "code-embedding-cache-v1";
export const DEFAULT_CODE_EMBEDDING_CACHE_MAX_ROWS = 100_000;

export type CodeEmbeddingCachePutRow = {
  text: string;
  embedding: readonly number[];
};

export type CodeEmbeddingCacheGetManyResult = {
  hits: Map<string, number[]>;
  invalidRows: number;
};

export type CodeEmbeddingCache = {
  getMany(input: {
    namespace: string;
    texts: readonly string[];
    nowMs: number;
  }): CodeEmbeddingCacheGetManyResult;
  putMany(input: {
    namespace: string;
    rows: readonly CodeEmbeddingCachePutRow[];
    nowMs: number;
  }): void;
  pruneUnused(input: { maxRows: number }): number;
  close(): void;
};

type CacheRow = {
  dimensions: number;
  vector_blob: Uint8Array;
};

export function createCodeEmbeddingCacheNamespace(
  compatibility: CodeSearchCompatibility,
): string {
  return JSON.stringify({
    schemaVersion: CODE_EMBEDDING_CACHE_SCHEMA_VERSION,
    ...compatibility,
  });
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function encodeEmbeddingVector(
  vector: readonly number[],
  dimensions: typeof CODE_INDEX_DIMENSIONS = CODE_INDEX_DIMENSIONS,
): Buffer {
  validateDimensions(dimensions);
  if (vector.length !== dimensions) {
    throw new Error(
      `Invalid embedding vector: expected ${dimensions} values, got ${vector.length}.`,
    );
  }

  const buffer = Buffer.alloc(dimensions * 4);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  vector.forEach((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `Invalid embedding vector: value at index ${index} is not a finite number.`,
      );
    }
    view.setFloat32(index * 4, value, true);
  });
  return buffer;
}

export function decodeEmbeddingVector(
  blob: Uint8Array,
  dimensions: typeof CODE_INDEX_DIMENSIONS = CODE_INDEX_DIMENSIONS,
): number[] {
  validateDimensions(dimensions);
  if (blob.byteLength !== dimensions * 4) {
    throw new Error(
      `Invalid embedding vector blob: expected ${dimensions * 4} bytes, got ${blob.byteLength}.`,
    );
  }

  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const vector: number[] = [];
  for (let index = 0; index < dimensions; index += 1) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value)) {
      throw new Error(
        `Invalid embedding vector blob: value at index ${index} is not finite.`,
      );
    }
    vector.push(value);
  }
  return vector;
}

export function openCodeEmbeddingCache(options: {
  filePath: string;
}): CodeEmbeddingCache {
  mkdirSync(dirname(options.filePath), { recursive: true });
  const db = new Database(options.filePath, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  createSchema(db);

  const selectStmt = db.prepare(
    `SELECT dimensions, vector_blob
     FROM code_embedding_cache
     WHERE namespace = ? AND text_sha256 = ?`,
  );
  const updateUsageStmt = db.prepare(
    `UPDATE code_embedding_cache
     SET last_used_at = ?, hit_count = hit_count + 1
     WHERE namespace = ? AND text_sha256 = ?`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM code_embedding_cache WHERE namespace = ? AND text_sha256 = ?`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO code_embedding_cache (
       namespace, text_sha256, dimensions, vector_blob, created_at, last_used_at
     )
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(namespace, text_sha256) DO UPDATE SET
       dimensions = excluded.dimensions,
       vector_blob = excluded.vector_blob,
       last_used_at = excluded.last_used_at`,
  );
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS count FROM code_embedding_cache`,
  );

  return {
    getMany(input) {
      const uniqueTexts = uniqueStrings(input.texts);
      const hits = new Map<string, number[]>();
      let invalidRows = 0;

      for (const text of uniqueTexts) {
        const textSha256 = sha256Text(text);
        const row = selectStmt.get(input.namespace, textSha256) as CacheRow | null;
        if (row === null) continue;

        let vector: number[];
        try {
          if (row.dimensions !== CODE_INDEX_DIMENSIONS) {
            throw new Error(
              `Invalid embedding vector dimensions: expected ${CODE_INDEX_DIMENSIONS}, got ${row.dimensions}.`,
            );
          }
          vector = decodeEmbeddingVector(row.vector_blob);
        } catch {
          // Only genuine decode/validation failures mark a row invalid. A
          // transient usage-UPDATE failure must not delete a valid row, so the
          // update is run outside this guard.
          deleteStmt.run(input.namespace, textSha256);
          invalidRows += 1;
          continue;
        }
        hits.set(text, vector);
        updateUsageStmt.run(input.nowMs, input.namespace, textSha256);
      }

      return { hits, invalidRows };
    },

    putMany(input) {
      for (const row of input.rows) {
        const vectorBlob = encodeEmbeddingVector(row.embedding);
        upsertStmt.run(
          input.namespace,
          sha256Text(row.text),
          CODE_INDEX_DIMENSIONS,
          vectorBlob,
          input.nowMs,
          input.nowMs,
        );
      }
    },

    pruneUnused(input) {
      validateMaxRows(input.maxRows);
      const row = countStmt.get() as { count: number };
      const overflow = row.count - input.maxRows;
      if (overflow <= 0) return 0;

      const result = db
        .prepare(
          `DELETE FROM code_embedding_cache
           WHERE rowid IN (
             SELECT rowid
             FROM code_embedding_cache
             ORDER BY last_used_at ASC, created_at ASC, namespace ASC, text_sha256 ASC
             LIMIT ?
           )`,
        )
        .run(overflow);
      return result.changes;
    },

    close() {
      db.close();
    },
  };
}

function createSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS code_embedding_cache (
      namespace    TEXT    NOT NULL,
      text_sha256  TEXT    NOT NULL,
      dimensions   INTEGER NOT NULL,
      vector_blob  BLOB    NOT NULL,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      hit_count    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (namespace, text_sha256)
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS code_embedding_cache_last_used_at_idx
      ON code_embedding_cache (last_used_at);
  `);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function validateDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid embedding dimensions: ${dimensions}.`);
  }
}

function validateMaxRows(maxRows: number): void {
  if (!Number.isInteger(maxRows) || maxRows < 0) {
    throw new Error("Invalid maxRows: expected a non-negative integer.");
  }
}
