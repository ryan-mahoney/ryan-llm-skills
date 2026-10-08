import { SQLITE_WRITE_HEADROOM, type GrowthCheck } from "./resources";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { Database } from "bun:sqlite";

import {
  CODE_INDEX_DIMENSIONS,
  type CodeSearchCompatibility,
} from "./embeddingContract";
import { openAnchoredSqlite } from "./sqliteOpen";

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
  pruneUnused(input: { maxRows: number; deadlineAt?: number }): number;
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

type CacheDirIdentity = { path: string; dev: number | bigint; ino: number | bigint };

function assertOwnerOnly(info: { uid: number; mode: number }, path: string): void {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Embedding cache path is not owned by the current user: ${path}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`Embedding cache path has group/world permissions: ${path}`);
  }
}

function ensureOwnedCacheDir(path: string): CacheDirIdentity {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Embedding cache directory is unavailable: ${path}`);
    }
    mkdirSync(path, { mode: 0o700 });
    info = lstatSync(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Embedding cache directory is not a stable directory: ${path}`);
  }
  assertOwnerOnly(info, path);
  return { path, dev: info.dev, ino: info.ino };
}

function assertCacheDirIdentity(identity: CacheDirIdentity): void {
  let info;
  try {
    info = lstatSync(identity.path);
  } catch {
    throw new Error(`Embedding cache directory changed: ${identity.path}`);
  }
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.dev !== identity.dev ||
    info.ino !== identity.ino
  ) {
    throw new Error(`Embedding cache directory changed: ${identity.path}`);
  }
}

function assertSafeSidecar(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Embedding cache sidecar is unavailable: ${path}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Embedding cache sidecar is not a safe regular file: ${path}`);
  }
}

export function openCodeEmbeddingCache(options: {
  filePath: string;
  beforeDatabaseOpen?: () => void;
  beforeWrite?: GrowthCheck;
  maxRows?: number;
}): CodeEmbeddingCache {
  const maxRows = Math.min(options.maxRows ?? DEFAULT_CODE_EMBEDDING_CACHE_MAX_ROWS, DEFAULT_CODE_EMBEDDING_CACHE_MAX_ROWS);
  validateMaxRows(maxRows);
  const beforeWrite = () => options.beforeWrite?.(0, SQLITE_WRITE_HEADROOM);
  beforeWrite();
  const dir = ensureOwnedCacheDir(dirname(options.filePath));
  const filePath = options.filePath;
  const walPath = `${filePath}-wal`;
  const shmPath = `${filePath}-shm`;

  let existing;
  try {
    existing = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Embedding cache file is unavailable: ${filePath}`);
    }
    existing = null;
  }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`Embedding cache file is not a regular file: ${filePath}`);
    }
    assertOwnerOnly(existing, filePath);
  } else {
    // Exclusive, no-follow 0600 precreation before SQLite opens the file.
    const fd = openSync(
      filePath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    closeSync(fd);
  }
  assertSafeSidecar(walPath);
  assertSafeSidecar(shmPath);

  const initial = lstatSync(filePath);
  const expectedDev = initial.dev;
  const expectedIno = initial.ino;

  const db = openAnchoredSqlite({
    directory: dir,
    file: { path: filePath, dev: expectedDev, ino: expectedIno },
    fileName: basename(filePath),
    beforeOpen: options.beforeDatabaseOpen,
    error: (message, cause) => {
      const error = new Error(message);
      if (cause !== undefined) (error as { cause?: unknown }).cause = cause;
      return error;
    },
    initialize(database) {
      // These relative checks run while the directory descriptor owns cwd.
      assertSafeSidecar(`${basename(filePath)}-wal`);
      assertSafeSidecar(`${basename(filePath)}-shm`);
      database.run("PRAGMA journal_mode = WAL;");
      database.run("PRAGMA busy_timeout = 5000;");
      createSchema(database);

      // Revalidate the public path, database identity and anchored sidecars.
      assertCacheDirIdentity(dir);
      const after = lstatSync(basename(filePath));
      if (
        after.isSymbolicLink() ||
        !after.isFile() ||
        after.dev !== expectedDev ||
        after.ino !== expectedIno
      ) {
        throw new Error(`Embedding cache file changed during initialization: ${filePath}`);
      }
      assertSafeSidecar(`${basename(filePath)}-wal`);
      assertSafeSidecar(`${basename(filePath)}-shm`);
    },
  });

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

  const prune = (limit: number, maxDeletes = 100) => {
    validateMaxRows(limit);
    const overflow = (countStmt.get() as { count: number }).count - limit;
    if (overflow <= 0) return 0;
    return db.query(`DELETE FROM code_embedding_cache WHERE rowid IN (
      SELECT rowid FROM code_embedding_cache
      ORDER BY last_used_at ASC, created_at ASC, namespace ASC, text_sha256 ASC LIMIT ?
    )`).run(Math.min(overflow, maxDeletes)).changes;
  };
  const checkpoint = () => db.run("PRAGMA wal_checkpoint(TRUNCATE)");

  return {
    getMany(input) {
      const uniqueTexts = uniqueStrings(input.texts);
      const hits = new Map<string, number[]>();
      let invalidRows = 0;

      for (const [index, text] of uniqueTexts.entries()) {
        if (index % 16 === 0) { checkpoint(); beforeWrite(); }
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

      checkpoint();
      return { hits, invalidRows };
    },

    putMany(input) {
      this.pruneUnused({ maxRows });
      // Bounded transactions constrain WAL growth; trim in the same transaction
      // so no observer can see a cache above its declared row capacity.
      for (let offset = 0; offset < input.rows.length; offset += 16) {
        checkpoint();
        beforeWrite();
        db.transaction(() => {
          for (const row of input.rows.slice(offset, offset + 16)) {
            const vectorBlob = encodeEmbeddingVector(row.embedding);
            upsertStmt.run(input.namespace, sha256Text(row.text), CODE_INDEX_DIMENSIONS,
              vectorBlob, input.nowMs, input.nowMs);
          }
          prune(maxRows);
        }).immediate();
      }
      checkpoint();
    },

    pruneUnused(input) {
      beforeWrite();
      let removed = 0;
      while (Date.now() < (input.deadlineAt ?? Infinity)) {
        const count = db.transaction(() => prune(Math.min(input.maxRows, maxRows))).immediate();
        removed += count;
        checkpoint();
        if (count === 0) break;
        beforeWrite();
      }
      return removed;
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
