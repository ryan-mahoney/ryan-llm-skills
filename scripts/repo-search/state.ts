// Transactional immutable-generation state owner.
//
// State exclusively owns current rows, pins, writer/native claims, generation
// publication and prune. All reference-changing metadata decisions use
// synchronous immediate SQLite transactions with no async or filesystem work
// inside; owned directories are created/removed outside transactions.

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  checkoutStatePath,
  enrollmentPath,
  resolveStateRoot,
} from "./identity.mjs";
import type { CodeSearchCompatibility } from "./core/embeddingContract";

export type StateErrorCode =
  | "busy"
  | "state-unavailable"
  | "invalid-operation"
  | "invalid-generation"
  | "validation-failed"
  | "path-exists"
  | "state-mismatch"
  | "operation-live"
  | "operation-unknown";

export class StateError extends Error {
  code: StateErrorCode;
  constructor(code: StateErrorCode, message: string) {
    super(message);
    this.name = "StateError";
    this.code = code;
  }
}

const CHECKOUT_KEY_PATTERN = /^[0-9a-f]{64}$/;
const PRUNE_MAX_GENERATIONS = 100;
const PRUNE_MAX_DEADLINE_MS = 30_000;

// Liveness seam: returns alive for a live process, dead only on definitive
// ESRCH, and unknown for EPERM or any other condition. Never sends a
// terminating/nonzero signal.
export type ProcessProbe = (
  pid: number,
) => "alive" | "dead" | "unknown" | Promise<"alive" | "dead" | "unknown">;

function defaultProcessProbe(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
    return "unknown";
  }
}

type OperationInput = {
  command: string;
  kind: string;
  checkoutKey?: string;
  writer?: boolean;
  native?: boolean;
};

type GenerationInput = {
  operationId: string;
  checkoutKey: string;
  repoKey: string;
  kind: "full" | "overlay";
  baseId: string | null;
  compatibility: CodeSearchCompatibility;
  snapshotDigest: string;
  capturedAt: string;
  observedHead: string | null;
  sourceMoved: boolean;
  bytes: number;
};

export type GenerationRecord = {
  id: string;
  operationId: string;
  checkoutKey: string;
  repoKey: string;
  kind: "full" | "overlay";
  baseId: string | null;
  status: "staging" | "ready" | "deleting";
  compatibility: CodeSearchCompatibility;
  snapshotDigest: string;
  capturedAt: string;
  observedHead: string | null;
  sourceMoved: boolean;
  bytes: number;
  tempPath: string;
  finalPath: string;
};

function assertCheckoutKey(checkoutKey: string): string {
  if (typeof checkoutKey !== "string" || !CHECKOUT_KEY_PATTERN.test(checkoutKey)) {
    throw new StateError("invalid-operation", "checkoutKey must be 64 lowercase hex characters");
  }
  return checkoutKey;
}

type DirIdentity = { path: string; dev: number | bigint; ino: number | bigint };
type AfterRenameInfo = { id: string; tempPath: string; finalPath: string };
export type AfterRenameHook = (info: AfterRenameInfo) => void | Promise<void>;

function assertOwnedMode(info: { uid: number; mode: number }, dir: string): void {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new StateError("state-unavailable", `state path is not owned by the current user: ${dir}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new StateError("state-unavailable", `state path has group/world permissions: ${dir}`);
  }
}

// Create (when requested) and validate an owner-only, non-symlink directory.
function ensureOwnedDirectory(dir: string, create: boolean): DirIdentity {
  let info;
  try {
    info = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
      throw new StateError("state-unavailable", `state directory is unavailable: ${dir}`);
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    info = lstatSync(dir);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new StateError("state-unavailable", `state path is not a stable directory: ${dir}`);
  }
  assertOwnedMode(info, dir);
  return { path: dir, dev: info.dev, ino: info.ino };
}

// Fail closed when an owned path was replaced or its parent became a symlink.
function assertIdentity(identity: DirIdentity, label: string): void {
  let info;
  try {
    info = lstatSync(identity.path);
  } catch {
    throw new StateError("state-unavailable", `${label} is unavailable: ${identity.path}`);
  }
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.dev !== identity.dev ||
    info.ino !== identity.ino
  ) {
    throw new StateError("state-unavailable", `${label} changed: ${identity.path}`);
  }
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

// A pre-existing database must be an owned, owner-only regular file; a symlink
// is never followed. Returns null when the path does not exist.
function assertOwnedRegularFile(path: string, label: string): DirIdentity | null {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new StateError("state-unavailable", `${label} is unavailable: ${path}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new StateError("state-unavailable", `${label} is not a regular file: ${path}`);
  }
  assertOwnedMode(info, path);
  return { path, dev: info.dev, ino: info.ino };
}

function assertSafeSidecar(path: string, label: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new StateError("state-unavailable", `${label} is unavailable: ${path}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new StateError("state-unavailable", `${label} is not a safe regular file: ${path}`);
  }
}

const COMPATIBILITY_KEYS = [
  "format",
  "modelId",
  "assetDigest",
  "dimensions",
  "dtype",
  "pooling",
  "normalize",
  "maxChars",
  "runtimeVersion",
  "chunkVersion",
  "policyVersion",
] as const;

const HEX64_PATTERN = /^[0-9a-f]{64}$/;

function assertHex64(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEX64_PATTERN.test(value)) {
    throw new StateError("invalid-generation", `${label} must be 64 lowercase hex characters`);
  }
  return value;
}

function assertCompatibility(value: CodeSearchCompatibility): void {
  const record = value as unknown as Record<string, unknown>;
  const invalid =
    !value ||
    typeof value !== "object" ||
    typeof record.format !== "string" ||
    typeof record.modelId !== "string" ||
    typeof record.assetDigest !== "string" ||
    typeof record.dimensions !== "number" ||
    typeof record.dtype !== "string" ||
    typeof record.pooling !== "string" ||
    typeof record.normalize !== "boolean" ||
    typeof record.maxChars !== "number" ||
    typeof record.runtimeVersion !== "string" ||
    typeof record.chunkVersion !== "string" ||
    typeof record.policyVersion !== "string";
  if (invalid) {
    throw new StateError("invalid-generation", "compatibility must be a valid record");
  }
}

// Stable private key order so compatibility equality never depends on caller
// insertion order; step-1 compatibility values are unchanged.
function canonicalCompatibility(value: CodeSearchCompatibility): string {
  const record = value as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of COMPATIBILITY_KEYS) ordered[key] = record[key];
  return JSON.stringify(ordered);
}

function isDirectChild(parent: string, child: string): boolean {
  return dirname(child) === parent;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function txImmediate<T>(db: Database, fn: () => T): T {
  return db.transaction(fn).immediate() as T;
}

function all(db: Database, sql: string, ...params: unknown[]): any[] {
  return db.query(sql).all(...(params as never[])) as any[];
}

function get(db: Database, sql: string, ...params: unknown[]): any {
  return db.query(sql).get(...(params as never[])) as any;
}

function run(db: Database, sql: string, ...params: unknown[]): void {
  db.query(sql).run(...(params as never[]));
}

function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      kind TEXT NOT NULL,
      checkout_key TEXT,
      pid INTEGER NOT NULL CHECK (pid > 0),
      state TEXT NOT NULL CHECK (state IN ('active','finished','failed','interrupted')),
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES operations(id),
      checkout_key TEXT NOT NULL,
      repo_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('full','overlay')),
      base_id TEXT REFERENCES generations(id),
      status TEXT NOT NULL CHECK (status IN ('staging','ready','deleting')),
      compatibility TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      observed_head TEXT,
      source_moved INTEGER NOT NULL CHECK (source_moved IN (0,1)),
      bytes INTEGER NOT NULL CHECK (bytes >= 0),
      temp_path TEXT NOT NULL,
      final_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS current_generations (
      checkout_key TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL REFERENCES generations(id),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pins (
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (operation_id, generation_id)
    );
    CREATE TABLE IF NOT EXISTS writer_claims (
      checkout_key TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS native_claim (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS generations_status_idx ON generations(status);
    CREATE INDEX IF NOT EXISTS generations_base_idx ON generations(base_id);
    CREATE INDEX IF NOT EXISTS pins_generation_idx ON pins(generation_id);
    CREATE TRIGGER IF NOT EXISTS current_requires_ready_insert
    BEFORE INSERT ON current_generations
    BEGIN
      SELECT RAISE(ABORT, 'current generation must be ready and same checkout')
      WHERE NOT EXISTS (
        SELECT 1 FROM generations
        WHERE id = NEW.generation_id AND status = 'ready' AND checkout_key = NEW.checkout_key
      );
    END;
    CREATE TRIGGER IF NOT EXISTS current_requires_ready_update
    BEFORE UPDATE ON current_generations
    BEGIN
      SELECT RAISE(ABORT, 'current generation must be ready and same checkout')
      WHERE NOT EXISTS (
        SELECT 1 FROM generations
        WHERE id = NEW.generation_id AND status = 'ready' AND checkout_key = NEW.checkout_key
      );
    END;
    CREATE TRIGGER IF NOT EXISTS current_generation_stays_ready
    BEFORE UPDATE OF status ON generations
    WHEN NEW.status <> 'ready'
    BEGIN
      SELECT RAISE(ABORT, 'current generation cannot leave ready')
      WHERE EXISTS (SELECT 1 FROM current_generations WHERE generation_id = OLD.id);
    END;
  `);
}

function generationRecord(row: any): GenerationRecord {
  return {
    id: row.id,
    operationId: row.operation_id,
    checkoutKey: row.checkout_key,
    repoKey: row.repo_key,
    kind: row.kind,
    baseId: row.base_id ?? null,
    status: row.status,
    compatibility: JSON.parse(row.compatibility) as CodeSearchCompatibility,
    snapshotDigest: row.snapshot_digest,
    capturedAt: row.captured_at,
    observedHead: row.observed_head ?? null,
    sourceMoved: Boolean(row.source_moved),
    bytes: row.bytes,
    tempPath: row.temp_path,
    finalPath: row.final_path,
  };
}

function createState(
  root: string,
  rootIdentity: DirIdentity,
  db: Database,
  options: { processProbe?: ProcessProbe; afterRename?: AfterRenameHook } = {},
) {
  const probe: ProcessProbe = options.processProbe ?? defaultProcessProbe;
  const afterRename = options.afterRename;
  const checkoutsParent = ensureOwnedDirectory(join(root, "checkouts"), true);
  const generationsParentIdentity = ensureOwnedDirectory(join(root, "generations"), true);
  const generationsParent = generationsParentIdentity.path;
  const nowIso = () => new Date().toISOString();

  function generationPaths(id: string): { tempPath: string; finalPath: string } {
    return {
      tempPath: join(generationsParent, `${id}.tmp`),
      finalPath: join(generationsParent, id),
    };
  }

  function selectGeneration(id: string): GenerationRecord | null {
    const row = get(db, "SELECT * FROM generations WHERE id = ?", id);
    return row ? generationRecord(row) : null;
  }

  function assertActiveOperation(operationId: string): any {
    const operation = get(db, "SELECT * FROM operations WHERE id = ?", operationId);
    if (!operation) {
      throw new StateError("invalid-operation", `operation does not exist: ${operationId}`);
    }
    if (operation.state !== "active") {
      throw new StateError("invalid-operation", `operation is not active: ${operationId}`);
    }
    return operation;
  }

  function beginOperation(input: OperationInput): {
    id: string;
    command: string;
    kind: string;
    checkoutKey: string | null;
    pid: number;
    state: string;
  } {
    if (typeof input?.command !== "string" || input.command.length === 0) {
      throw new StateError("invalid-operation", "command is required");
    }
    if (typeof input?.kind !== "string" || input.kind.length === 0) {
      throw new StateError("invalid-operation", "kind is required");
    }
    if (input.writer && !input.checkoutKey) {
      throw new StateError("invalid-operation", "a writer claim requires a checkoutKey");
    }
    const checkoutKey = input.checkoutKey ? assertCheckoutKey(input.checkoutKey) : null;
    const id = randomUUID();
    const createdAt = nowIso();

    // Create the checkout structure before recording claims so a filesystem
    // failure cannot leave a claim behind.
    if (checkoutKey) {
      assertIdentity(rootIdentity, "state root");
      assertIdentity(checkoutsParent, "checkouts parent");
      const checkoutPath = checkoutStatePath(root, checkoutKey);
      if (!isDirectChild(checkoutsParent.path, checkoutPath)) {
        throw new StateError(
          "state-unavailable",
          `checkout state path escapes the owned checkouts parent: ${checkoutPath}`,
        );
      }
      ensureOwnedDirectory(checkoutPath, true);
    }

    txImmediate(db, () => {
      if (input.writer && checkoutKey) {
        const claim = get(db, "SELECT operation_id FROM writer_claims WHERE checkout_key = ?", checkoutKey);
        if (claim) throw new StateError("busy", `checkout already claimed: ${checkoutKey}`);
      }
      if (input.native) {
        const claim = get(db, "SELECT operation_id FROM native_claim WHERE id = 1");
        if (claim) throw new StateError("busy", "native slot already claimed");
      }
      run(
        db,
        "INSERT INTO operations (id, command, kind, checkout_key, pid, state, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
        id,
        input.command,
        input.kind,
        checkoutKey,
        process.pid,
        createdAt,
      );
      if (input.writer && checkoutKey) {
        run(
          db,
          "INSERT INTO writer_claims (checkout_key, operation_id, created_at) VALUES (?, ?, ?)",
          checkoutKey,
          id,
          createdAt,
        );
      }
      if (input.native) {
        run(db, "INSERT INTO native_claim (id, operation_id, created_at) VALUES (1, ?, ?)", id, createdAt);
      }
    });

    return { id, command: input.command, kind: input.kind, checkoutKey, pid: process.pid, state: "active" };
  }

  function beginGeneration(input: GenerationInput): {
    id: string;
    tempPath: string;
    finalPath: string;
  } {
    const checkoutKey = assertCheckoutKey(input.checkoutKey);
    assertHex64(input.repoKey, "repoKey");
    assertHex64(input.snapshotDigest, "snapshotDigest");
    if (!Number.isInteger(input.bytes) || input.bytes < 0) {
      throw new StateError("invalid-generation", "bytes must be a nonnegative integer");
    }
    if (typeof input.sourceMoved !== "boolean") {
      throw new StateError("invalid-generation", "sourceMoved must be a boolean");
    }
    assertCompatibility(input.compatibility);
    if (input.kind !== "full" && input.kind !== "overlay") {
      throw new StateError("invalid-generation", "kind must be full or overlay");
    }
    if (input.kind === "full" && input.baseId != null) {
      throw new StateError("invalid-generation", "a full generation must not have a base");
    }
    if (input.kind === "overlay" && (input.baseId == null || input.baseId.length === 0)) {
      throw new StateError("invalid-generation", "an overlay generation requires a base");
    }
    const compatibilityJson = canonicalCompatibility(input.compatibility);
    const id = randomUUID();
    const { tempPath, finalPath } = generationPaths(id);
    const createdAt = nowIso();

    assertIdentity(rootIdentity, "state root");
    assertIdentity(generationsParentIdentity, "generations parent");

    txImmediate(db, () => {
      assertActiveOperation(input.operationId);
      const claim = get(
        db,
        "SELECT operation_id FROM writer_claims WHERE checkout_key = ? AND operation_id = ?",
        checkoutKey,
        input.operationId,
      );
      if (!claim) {
        throw new StateError(
          "invalid-generation",
          `operation does not hold the writer claim for ${checkoutKey}`,
        );
      }
      if (input.kind === "overlay") {
        const pin = get(
          db,
          "SELECT 1 AS present FROM pins WHERE operation_id = ? AND generation_id = ?",
          input.operationId,
          input.baseId,
        );
        if (!pin) {
          throw new StateError(
            "invalid-generation",
            `operation has not pinned its overlay base: ${input.baseId}`,
          );
        }
      }
      if (input.kind === "overlay") {
        const base = get(db, "SELECT * FROM generations WHERE id = ?", input.baseId);
        if (!base) {
          throw new StateError("invalid-generation", `base generation does not exist: ${input.baseId}`);
        }
        if (base.status !== "ready") {
          throw new StateError("invalid-generation", `base generation is not ready: ${input.baseId}`);
        }
        if (base.repo_key !== input.repoKey) {
          throw new StateError("invalid-generation", `base generation is not in the same repository: ${input.baseId}`);
        }
        if (base.compatibility !== compatibilityJson) {
          throw new StateError("invalid-generation", `base generation compatibility differs: ${input.baseId}`);
        }
      }
      run(
        db,
        `INSERT INTO generations
          (id, operation_id, checkout_key, repo_key, kind, base_id, status, compatibility,
           snapshot_digest, captured_at, observed_head, source_moved, bytes, temp_path, final_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.operationId,
        checkoutKey,
        input.repoKey,
        input.kind,
        input.baseId ?? null,
        compatibilityJson,
        input.snapshotDigest,
        input.capturedAt,
        input.observedHead ?? null,
        input.sourceMoved ? 1 : 0,
        input.bytes,
        tempPath,
        finalPath,
        createdAt,
      );
    });

    assertIdentity(rootIdentity, "state root");
    assertIdentity(generationsParentIdentity, "generations parent");
    if (!isDirectChild(generationsParent, tempPath)) {
      throw new StateError(
        "state-mismatch",
        `generation temp path is not a state-owned direct child: ${tempPath}`,
      );
    }
    if (pathExists(tempPath)) {
      throw new StateError("path-exists", `generation temp path already exists: ${tempPath}`);
    }
    mkdirSync(tempPath, { recursive: false, mode: 0o700 });
    chmodSync(tempPath, 0o700);

    return { id, tempPath, finalPath };
  }

  function acquireCurrent(input: { operationId: string; checkoutKey: string }): {
    current: GenerationRecord | null;
    base: GenerationRecord | null;
  } {
    const checkoutKey = assertCheckoutKey(input.checkoutKey);
    return txImmediate(db, () => {
      assertActiveOperation(input.operationId);
      const currentRow = get(db, "SELECT generation_id FROM current_generations WHERE checkout_key = ?", checkoutKey);
      if (!currentRow) return { current: null, base: null };
      const current = selectGeneration(currentRow.generation_id);
      if (!current || current.status !== "ready") return { current: null, base: null };
      const createdAt = nowIso();
      run(
        db,
        "INSERT OR IGNORE INTO pins (operation_id, generation_id, created_at) VALUES (?, ?, ?)",
        input.operationId,
        current.id,
        createdAt,
      );
      let base: GenerationRecord | null = null;
      if (current.baseId) {
        const candidate = selectGeneration(current.baseId);
        if (candidate && candidate.status === "ready") {
          base = candidate;
          run(
            db,
            "INSERT OR IGNORE INTO pins (operation_id, generation_id, created_at) VALUES (?, ?, ?)",
            input.operationId,
            base.id,
            createdAt,
          );
        }
      }
      return { current, base };
    });
  }

  async function publish(input: {
    operationId: string;
    generationId: string;
    validate: (tempPath: string) => boolean | void | Promise<boolean | void>;
    finalize?: { sourceMoved: boolean; bytes: number };
  }): Promise<void> {
    const generation = selectGeneration(input.generationId);
    if (!generation) {
      throw new StateError("invalid-generation", `generation does not exist: ${input.generationId}`);
    }
    assertActiveOperation(input.operationId);
    if (generation.operationId !== input.operationId) {
      throw new StateError("state-mismatch", "generation is owned by a different operation");
    }
    if (generation.status !== "staging") {
      throw new StateError("invalid-generation", `generation is not staging: ${input.generationId}`);
    }
    const expected = generationPaths(generation.id);
    if (generation.tempPath !== expected.tempPath || generation.finalPath !== expected.finalPath) {
      throw new StateError("state-mismatch", "generation paths are not state-owned direct children");
    }

    // Facts learned only after writing (post-build snapshot) are validated
    // before any filesystem publication.
    if (input.finalize !== undefined) {
      if (typeof input.finalize.sourceMoved !== "boolean") {
        throw new StateError("invalid-generation", "finalize.sourceMoved must be a boolean");
      }
      if (!Number.isInteger(input.finalize.bytes) || input.finalize.bytes < 0) {
        throw new StateError("invalid-generation", "finalize.bytes must be a nonnegative integer");
      }
    }

    let tempInfo;
    try {
      tempInfo = lstatSync(generation.tempPath);
    } catch {
      throw new StateError("validation-failed", `generation temp directory is missing: ${generation.tempPath}`);
    }
    if (tempInfo.isSymbolicLink() || !tempInfo.isDirectory()) {
      throw new StateError("validation-failed", "generation temp path is not a stable directory");
    }
    const tempDev = tempInfo.dev;
    const tempIno = tempInfo.ino;

    // Validator runs outside any transaction; it must not mutate state metadata.
    const accepted = await input.validate(generation.tempPath);
    if (accepted === false) {
      throw new StateError("validation-failed", `generation failed validation: ${generation.id}`);
    }

    // Recheck the exact staging directory identity after the validator.
    const afterValidation = lstatOrNull(generation.tempPath);
    if (
      !afterValidation ||
      afterValidation.isSymbolicLink() ||
      !afterValidation.isDirectory() ||
      afterValidation.dev !== tempDev ||
      afterValidation.ino !== tempIno
    ) {
      throw new StateError("validation-failed", "generation temp path changed during validation");
    }

    assertIdentity(rootIdentity, "state root");
    assertIdentity(generationsParentIdentity, "generations parent");
    if (pathExists(generation.finalPath)) {
      throw new StateError("path-exists", `final generation path already exists: ${generation.finalPath}`);
    }

    // Recheck immediately around the rename.
    const beforeRename = lstatOrNull(generation.tempPath);
    if (
      !beforeRename ||
      beforeRename.isSymbolicLink() ||
      !beforeRename.isDirectory() ||
      beforeRename.dev !== tempDev ||
      beforeRename.ino !== tempIno
    ) {
      throw new StateError("validation-failed", "generation temp path changed before rename");
    }
    renameSync(generation.tempPath, generation.finalPath);
    if (afterRename) {
      await afterRename({
        id: generation.id,
        tempPath: generation.tempPath,
        finalPath: generation.finalPath,
      });
    }
    assertIdentity(rootIdentity, "state root");
    assertIdentity(generationsParentIdentity, "generations parent");
    const finalInfo = lstatOrNull(generation.finalPath);
    if (
      !finalInfo ||
      finalInfo.isSymbolicLink() ||
      !finalInfo.isDirectory() ||
      finalInfo.dev !== tempDev ||
      finalInfo.ino !== tempIno
    ) {
      throw new StateError("state-mismatch", "published generation directory changed after rename");
    }

    try {
      txImmediate(db, () => {
        assertActiveOperation(input.operationId);
        const row = get(db, "SELECT * FROM generations WHERE id = ?", input.generationId);
        if (!row || row.status !== "staging" || row.operation_id !== input.operationId) {
          throw new StateError("state-mismatch", "staging generation changed before publication");
        }
        const claim = get(
          db,
          "SELECT operation_id FROM writer_claims WHERE checkout_key = ? AND operation_id = ?",
          generation.checkoutKey,
          input.operationId,
        );
        if (!claim) {
          throw new StateError(
            "state-mismatch",
            "checkout writer ownership was lost before publication",
          );
        }
        const effectiveSourceMoved =
          input.finalize !== undefined ? input.finalize.sourceMoved : generation.sourceMoved;
        const effectiveBytes =
          input.finalize !== undefined ? input.finalize.bytes : generation.bytes;
        run(
          db,
          "UPDATE generations SET status = 'ready', source_moved = ?, bytes = ? WHERE id = ?",
          effectiveSourceMoved ? 1 : 0,
          effectiveBytes,
          input.generationId,
        );
        if (!effectiveSourceMoved) {
          run(
            db,
            `INSERT INTO current_generations (checkout_key, generation_id, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(checkout_key) DO UPDATE SET generation_id = excluded.generation_id, updated_at = excluded.updated_at`,
            generation.checkoutKey,
            input.generationId,
            nowIso(),
          );
        }
      });
    } catch (error) {
      // Never roll current back or delete the prior current; leave the ready
      // final orphan and its staging row for later prune.
      throw error;
    }
  }

  function finishOperation(operationId: string, outcome: "finished" | "failed" | "interrupted" = "finished"): void {
    txImmediate(db, () => {
      run(
        db,
        "UPDATE operations SET state = ?, finished_at = ? WHERE id = ? AND state = 'active'",
        outcome,
        nowIso(),
        operationId,
      );
      run(db, "DELETE FROM pins WHERE operation_id = ?", operationId);
      run(db, "DELETE FROM writer_claims WHERE operation_id = ?", operationId);
      run(db, "DELETE FROM native_claim WHERE operation_id = ?", operationId);
    });
  }

  // Conservative recovery: probe the recorded process outside any transaction,
  // refuse live/unknown owners, and only release a dead owner whose immutable
  // operation identity is unchanged and still active.
  async function recover(operationId: string): Promise<{
    id: string;
    pid: number;
    command: string;
    kind: string;
    checkoutKey: string | null;
    state: "interrupted";
    finishedAt: string;
  }> {
    if (typeof operationId !== "string" || operationId.length === 0) {
      throw new StateError("invalid-operation", "operationId is required");
    }
    const operation = get(db, "SELECT * FROM operations WHERE id = ?", operationId);
    if (!operation) {
      throw new StateError("invalid-operation", `operation does not exist: ${operationId}`);
    }
    if (operation.state !== "active") {
      throw new StateError("invalid-operation", `operation is not active: ${operationId}`);
    }

    const identity = {
      id: operation.id as string,
      pid: operation.pid as number,
      createdAt: operation.created_at as string,
    };

    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) {
      throw new StateError(
        "operation-unknown",
        `operation owner identity is not recoverable: ${operationId}`,
      );
    }

    const status = await probe(identity.pid);
    if (status === "alive") {
      throw new StateError("operation-live", `operation owner is still alive: ${operationId}`);
    }
    if (status !== "dead") {
      throw new StateError("operation-unknown", `operation owner liveness is unknown: ${operationId}`);
    }

    return txImmediate(db, () => {
      const current = get(db, "SELECT * FROM operations WHERE id = ?", operationId);
      if (
        !current ||
        current.state !== "active" ||
        current.pid !== identity.pid ||
        current.created_at !== identity.createdAt
      ) {
        throw new StateError(
          "state-mismatch",
          `operation identity changed before recovery: ${operationId}`,
        );
      }
      const finishedAt = nowIso();
      run(
        db,
        "UPDATE operations SET state = 'interrupted', finished_at = ? WHERE id = ? AND state = 'active'",
        finishedAt,
        operationId,
      );
      run(db, "DELETE FROM pins WHERE operation_id = ?", operationId);
      run(db, "DELETE FROM writer_claims WHERE operation_id = ?", operationId);
      run(db, "DELETE FROM native_claim WHERE operation_id = ?", operationId);
      return {
        id: identity.id,
        pid: identity.pid,
        command: current.command as string,
        kind: current.kind as string,
        checkoutKey: (current.checkout_key as string | null) ?? null,
        state: "interrupted" as const,
        finishedAt,
      };
    });
  }

  async function prune(input: { maxGenerations?: number; deadlineMs?: number } = {}): Promise<{
    deleted: string[];
    retained: string[];
  }> {
    const maxGenerations =
      Number.isInteger(input.maxGenerations) && (input.maxGenerations as number) > 0
        ? Math.min(input.maxGenerations as number, PRUNE_MAX_GENERATIONS)
        : PRUNE_MAX_GENERATIONS;
    const deadlineMs =
      Number.isInteger(input.deadlineMs) && (input.deadlineMs as number) > 0
        ? Math.min(input.deadlineMs as number, PRUNE_MAX_DEADLINE_MS)
        : PRUNE_MAX_DEADLINE_MS;
    const startedAt = Date.now();

    assertIdentity(rootIdentity, "state root");
    assertIdentity(generationsParentIdentity, "generations parent");

    const marked = txImmediate(db, () => {
      const rows = all(db, "SELECT id, status, operation_id FROM generations");
      const currentIds = new Set(all(db, "SELECT generation_id FROM current_generations").map((r) => r.generation_id));
      // A base is retained while any generation row, including a deleting one,
      // still references it; the referencing overlay is removed first.
      const baseIds = new Set(
        all(
          db,
          "SELECT base_id FROM generations WHERE base_id IS NOT NULL",
        ).map((r) => r.base_id),
      );
      const pinnedIds = new Set(all(db, "SELECT generation_id FROM pins").map((r) => r.generation_id));
      const activeOps = new Set(all(db, "SELECT id FROM operations WHERE state = 'active'").map((r) => r.id));

      const candidates: string[] = [];
      for (const row of rows) {
        if (baseIds.has(row.id)) continue;
        if (row.status === "deleting") {
          candidates.push(row.id);
          continue;
        }
        if (row.status === "staging") {
          if (!activeOps.has(row.operation_id)) candidates.push(row.id);
          continue;
        }
        if (row.status === "ready") {
          if (currentIds.has(row.id)) continue;
          if (baseIds.has(row.id)) continue;
          if (pinnedIds.has(row.id)) continue;
          candidates.push(row.id);
        }
      }
      candidates.sort();
      const selected: any[] = [];
      for (const id of candidates) {
        if (selected.length >= maxGenerations) break;
        if (Date.now() - startedAt > deadlineMs) break;
        selected.push(get(db, "SELECT * FROM generations WHERE id = ?", id));
      }
      for (const row of selected) {
        run(db, "UPDATE generations SET status = 'deleting' WHERE id = ?", row.id);
      }
      return selected;
    });

    const removed: string[] = [];
    for (const row of marked) {
      if (Date.now() - startedAt > deadlineMs) break;
      assertIdentity(rootIdentity, "state root");
      assertIdentity(generationsParentIdentity, "generations parent");
      const expected = generationPaths(row.id);
      if (row.temp_path !== expected.tempPath || row.final_path !== expected.finalPath) {
        throw new StateError(
          "state-mismatch",
          `generation path is not its state-owned direct child: ${row.id}`,
        );
      }
      const pathsToRemove: string[] = [];
      for (const path of [row.temp_path, row.final_path]) {
        if (!isDirectChild(generationsParent, path)) {
          throw new StateError("state-mismatch", `generation path is not a direct child: ${path}`);
        }
        if (!pathExists(path)) continue;
        const info = lstatSync(path);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new StateError("state-unavailable", `refusing to remove unsafe generation path: ${path}`);
        }
        pathsToRemove.push(path);
      }
      let removedAll = true;
      for (const path of pathsToRemove) {
        if (Date.now() - startedAt > deadlineMs) {
          removedAll = false;
          break;
        }
        rmSync(path, { recursive: true, force: true });
      }
      if (!removedAll) break;
      assertIdentity(rootIdentity, "state root");
      assertIdentity(generationsParentIdentity, "generations parent");
      removed.push(row.id);
    }

    if (removed.length > 0) {
      txImmediate(db, () => {
        for (const id of removed) {
          run(db, "DELETE FROM generations WHERE id = ?", id);
        }
      });
    }

    const retained = all(db, "SELECT id FROM generations").map((r) => r.id as string).sort();
    return { deleted: removed.slice().sort(), retained };
  }

  function forgetCheckout(checkoutKey: string): void {
    const key = assertCheckoutKey(checkoutKey);
    txImmediate(db, () => {
      const claim = get(db, "SELECT operation_id FROM writer_claims WHERE checkout_key = ?", key);
      if (claim) throw new StateError("busy", `checkout has an active writer: ${key}`);
      run(db, "DELETE FROM current_generations WHERE checkout_key = ?", key);
    });

    assertIdentity(rootIdentity, "state root");
    assertIdentity(checkoutsParent, "checkouts parent");
    const checkoutDir = checkoutStatePath(root, key);
    if (!isDirectChild(checkoutsParent.path, checkoutDir)) {
      throw new StateError(
        "state-unavailable",
        `checkout state path escapes the owned checkouts parent: ${checkoutDir}`,
      );
    }
    let dirInfo;
    try {
      dirInfo = lstatSync(checkoutDir);
    } catch {
      return;
    }
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return;
    const record = enrollmentPath(root, key);
    try {
      const recordInfo = lstatSync(record);
      if (!recordInfo.isSymbolicLink() && recordInfo.isFile()) unlinkSync(record);
    } catch {
      // no enrollment record to remove
    }
    try {
      rmdirSync(checkoutDir);
    } catch {
      // directory not empty or concurrently used; leave it in place
    }
  }

  function readStatus(input: { checkoutKey?: string } = {}): {
    stateRoot: string;
    current: Array<{ checkoutKey: string; generationId: string }>;
    generations: Array<{
      id: string;
      checkoutKey: string;
      kind: string;
      status: string;
      baseId: string | null;
      sourceMoved: boolean;
      bytes: number;
    }>;
    operations: Array<{ id: string; command: string; kind: string; state: string }>;
  } {
    const checkoutKey =
      input.checkoutKey !== undefined ? assertCheckoutKey(input.checkoutKey) : null;
    return {
      stateRoot: root,
      current: (checkoutKey
        ? all(
            db,
            "SELECT checkout_key, generation_id FROM current_generations WHERE checkout_key = ? ORDER BY checkout_key",
            checkoutKey,
          )
        : all(
            db,
            "SELECT checkout_key, generation_id FROM current_generations ORDER BY checkout_key LIMIT 1000",
          )
      ).map((r) => ({ checkoutKey: r.checkout_key, generationId: r.generation_id })),
      generations: (checkoutKey
        ? all(
            db,
            "SELECT id, checkout_key, kind, status, base_id, source_moved, bytes FROM generations WHERE checkout_key = ? ORDER BY id",
            checkoutKey,
          )
        : all(
            db,
            "SELECT id, checkout_key, kind, status, base_id, source_moved, bytes FROM generations ORDER BY id LIMIT 1000",
          )
      ).map((r) => ({
        id: r.id,
        checkoutKey: r.checkout_key,
        kind: r.kind,
        status: r.status,
        baseId: r.base_id ?? null,
        sourceMoved: Boolean(r.source_moved),
        bytes: r.bytes,
      })),
      operations: all(
        db,
        "SELECT id, command, kind, state FROM operations ORDER BY id LIMIT 1000",
      ).map((r) => ({ id: r.id, command: r.command, kind: r.kind, state: r.state })),
    };
  }

  function close(): void {
    db.close();
  }

  return {
    stateRoot: root,
    beginOperation,
    beginGeneration,
    acquireCurrent,
    publish,
    finishOperation,
    recover,
    prune,
    forgetCheckout,
    readStatus,
    close,
  };
}

export function openState(
  stateRoot?: string,
  options: { processProbe?: ProcessProbe; afterRename?: AfterRenameHook } = {},
) {
  const root = resolveStateRoot(stateRoot);
  const rootIdentity = ensureOwnedDirectory(root, true);
  const dbPath = join(root, "state.sqlite");
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;

  // Pre-open containment: never follow a symlink into an external target.
  const existingDb = assertOwnedRegularFile(dbPath, "state database");
  assertSafeSidecar(walPath, "state database WAL");
  assertSafeSidecar(shmPath, "state database shared memory");

  let expectedDbIdentity: DirIdentity;
  if (existingDb) {
    expectedDbIdentity = existingDb;
  } else {
    const fd = openSync(
      dbPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    closeSync(fd);
    const created = lstatSync(dbPath);
    expectedDbIdentity = { path: dbPath, dev: created.dev, ino: created.ino };
  }

  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    createSchema(db);
    // Owner-only database file; a failure here fails opening.
    chmodSync(dbPath, 0o600);

    // Revalidate identity and sidecars after SQLite/schema initialization.
    const dbInfo = lstatSync(dbPath);
    if (
      dbInfo.isSymbolicLink() ||
      !dbInfo.isFile() ||
      dbInfo.dev !== expectedDbIdentity.dev ||
      dbInfo.ino !== expectedDbIdentity.ino
    ) {
      throw new StateError("state-unavailable", "state database changed during initialization");
    }
    assertSafeSidecar(walPath, "state database WAL");
    assertSafeSidecar(shmPath, "state database shared memory");

    return createState(root, rootIdentity, db, options);
  } catch (error) {
    try {
      db.close();
    } catch {
      // connection already closed by the failed setup
    }
    throw error;
  }
}
