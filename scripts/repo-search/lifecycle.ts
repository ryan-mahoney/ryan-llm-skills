import { ResourceBudgetError } from "./core/resources";
// Step 4 primary lifecycle orchestration.
//
// Wires captured source snapshots (source.ts), the core builder (core/build),
// state publication/pins/current (state.ts), enrollment/check metadata, and
// read-only status to the test-defined public contract. source.ts exclusively
// owns eligible bytes and state.ts exclusively owns pins/current/publication.

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  buildCodeIndex,
  buildOverlayIndex,
  planCodeIndexBuild,
  planOverlayBuild,
  validateCodeIndexBuild,
  validateCodeIndexStore,
  validateOverlayBuild,
  validateOverlayStore,
  type BuildEmbeddingRuntimeFactory,
} from "./core/build";
import { CodeIndexUnavailableError } from "./core/codeIndexRuntime";
import {
  codeSearchCompatibilityEqual,
  createCodeSearchCompatibility,
  type CodeSearchCompatibility,
} from "./core/embeddingContract";
import {
  verifyModel,
  type CodeModelAssetSpec,
  type VerifiedModel,
} from "./core/codeModelAssets";
import { checkoutStatePath, enrollmentPath, resolveStateRoot } from "./identity.mjs";
import {
  captureSnapshot as defaultCaptureSnapshot,
  SOURCE_POLICY_VERSION,
  type Snapshot,
} from "./source";
import { openState, type GenerationRecord } from "./state";

export type LifecycleState = ReturnType<typeof openState>;

export class LifecycleError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
  }
}

export type LifecycleDependencies = {
  modelAssets?: readonly CodeModelAssetSpec[];
  createEmbeddingRuntime?: BuildEmbeddingRuntimeFactory;
  captureSnapshot?: (
    identity: CheckoutIdentityLike,
    signal?: AbortSignal,
  ) => Promise<Snapshot>;
};

type CheckoutIdentityLike = {
  repoKey: string;
  checkoutKey: string;
  root: string;
  commonDir: string;
  gitDir: string;
  head: string | null;
  primary: boolean;
};

export type LifecycleAvailability = "missing" | "ready" | "unavailable";
export type LifecycleOperationState = "idle" | "building" | "failed" | "interrupted";
export type LifecycleFreshness = "unknown" | "stale";

type Coverage = {
  policy: string;
  indexedFiles: number;
  excluded: Record<string, number>;
  completeness: "unknown" | "partial";
  staleHits: number;
  omittedHits: number;
  candidateLimitReached: boolean;
};

type Timing = { elapsedMs: number };

export type OperationReceipt = {
  version: 1;
  command: "build" | "update" | "reindex";
  kind: "build" | "update" | "reindex";
  generationKind?: "full" | "overlay";
  availability: LifecycleAvailability;
  operation: LifecycleOperationState;
  freshness: LifecycleFreshness;
  reason?: string;
  repoKey: string;
  checkoutKey: string;
  requestedRoot: string;
  actualRoot: string;
  observedHead: string | null;
  generationId?: string;
  baseId: string | null;
  snapshotDigest?: string;
  sourceMoved?: boolean;
  observedAt: string;
  coverage: Coverage;
  timing: Timing;
};

export type CheckReceipt = {
  version: 1;
  command: "check";
  operationId?: string;
  availability: LifecycleAvailability;
  operation: LifecycleOperationState;
  freshness: LifecycleFreshness;
  reason?: string;
  repoKey: string;
  checkoutKey: string;
  observedHead: string | null;
  generationId?: string;
  snapshotDigest: string;
  matchesGeneration: boolean;
  observedAt: string;
  timing: Timing;
};

export type CheckoutStatusReceipt = {
  version: 1;
  command: "status";
  enrolled: boolean;
  activeOperations: Array<{ id: string; command: string; kind: string; state: string }>;
  specUse: boolean;
  operation: LifecycleOperationState;
  operationId?: string;
  availability: LifecycleAvailability;
  freshness: LifecycleFreshness;
  repoKey: string;
  checkoutKey: string;
  currentGenerationId: string | null;
  lastCheck: { at: string; snapshotDigest: string; matchesGeneration: boolean } | null;
  observedAt: string;
};

type EnrollmentIdentity = {
  repoKey: string;
  checkoutKey: string;
  root: string;
  commonDir: string;
  gitDir: string;
  primary: boolean;
};

type EnrollmentRecord = {
  version: 1;
  identity: EnrollmentIdentity;
  specUse: boolean;
  enrolledAt: string;
  head: string | null;
  lastBuild: {
    at: string;
    kind: string;
    status: string;
    generationId?: string;
    snapshotDigest?: string;
    reason?: string;
  } | null;
  lastCheck: { at: string; snapshotDigest: string; matchesGeneration: boolean } | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("lifecycle operation aborted");
    error.name = "AbortError";
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function coverageFor(snapshot: Snapshot): Coverage {
  return {
    policy: SOURCE_POLICY_VERSION,
    indexedFiles: snapshot.files.size,
    excluded: { ...snapshot.excluded },
    completeness: "unknown",
    staleHits: 0,
    omittedHits: 0,
    candidateLimitReached: false,
  };
}

// ---- Enrollment metadata (identity.enrollmentPath) ------------------------

function checkoutsParentDir(stateRoot: string): string {
  return join(resolveStateRoot(stateRoot), "checkouts");
}

function checkoutDirFor(stateRoot: string, checkoutKey: string): string {
  const parent = checkoutsParentDir(stateRoot);
  const dir = checkoutStatePath(stateRoot, checkoutKey);
  if (dirname(dir) !== parent) {
    throw new LifecycleError(
      "enrollment-path",
      `checkout state path escapes the owned checkouts parent: ${dir}`,
    );
  }
  return dir;
}

type DirIdentity = { path: string; dev: number | bigint; ino: number | bigint };

function assertOwnerOnly(info: { uid: number; mode: number }, path: string): void {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new LifecycleError("enrollment-path", `metadata path is not owned by the current user: ${path}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new LifecycleError("enrollment-path", `metadata path has group/world permissions: ${path}`);
  }
}

function assertIdentity(identity: DirIdentity, label: string): void {
  let info;
  try {
    info = lstatSync(identity.path);
  } catch {
    throw new LifecycleError("enrollment-path", `${label} is unavailable: ${identity.path}`);
  }
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.dev !== identity.dev ||
    info.ino !== identity.ino
  ) {
    throw new LifecycleError("enrollment-path", `${label} changed: ${identity.path}`);
  }
}

// Create a direct child non-recursively (parent must already be validated), or
// validate an owner-only, current-user, non-symlink directory. Never chmods or
// follows an unsafe pre-existing target.
function ensureOwnedDir(path: string): DirIdentity {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new LifecycleError("enrollment-path", `metadata directory is unavailable: ${path}`);
    }
    mkdirSync(path, { mode: 0o700 });
    info = lstatSync(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new LifecycleError("enrollment-path", `metadata path is not a stable directory: ${path}`);
  }
  assertOwnerOnly(info, path);
  return { path, dev: info.dev, ino: info.ino };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEnrollmentShape(value: unknown): EnrollmentRecord {
  if (!isPlainObject(value) || value.version !== 1) {
    throw new LifecycleError("enrollment-corrupt", "enrollment record shape is invalid");
  }
  const identity = value.identity;
  if (
    !isPlainObject(identity) ||
    typeof identity.repoKey !== "string" ||
    typeof identity.checkoutKey !== "string" ||
    typeof identity.root !== "string" ||
    typeof identity.commonDir !== "string" ||
    typeof identity.gitDir !== "string" ||
    typeof identity.primary !== "boolean"
  ) {
    throw new LifecycleError("enrollment-corrupt", "enrollment identity shape is invalid");
  }
  if (typeof value.specUse !== "boolean" || typeof value.enrolledAt !== "string") {
    throw new LifecycleError("enrollment-corrupt", "enrollment record shape is invalid");
  }
  if (value.head !== null && typeof value.head !== "string") {
    throw new LifecycleError("enrollment-corrupt", "enrollment head shape is invalid");
  }
  if (value.lastCheck !== null && value.lastCheck !== undefined) {
    const lastCheck = value.lastCheck;
    if (
      !isPlainObject(lastCheck) ||
      typeof lastCheck.at !== "string" ||
      typeof lastCheck.snapshotDigest !== "string" ||
      typeof lastCheck.matchesGeneration !== "boolean"
    ) {
      throw new LifecycleError("enrollment-corrupt", "enrollment lastCheck shape is invalid");
    }
  }
  if (value.lastBuild !== null && value.lastBuild !== undefined) {
    const lastBuild = value.lastBuild;
    if (!isPlainObject(lastBuild) || typeof lastBuild.at !== "string" || typeof lastBuild.status !== "string") {
      throw new LifecycleError("enrollment-corrupt", "enrollment lastBuild shape is invalid");
    }
  }
  return value as unknown as EnrollmentRecord;
}

function readEnrollment(stateRoot: string, checkoutKey: string): EnrollmentRecord | null {
  const parentPath = checkoutsParentDir(stateRoot);
  let parentInfo;
  try {
    parentInfo = lstatSync(parentPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LifecycleError("enrollment-unavailable", `checkouts parent is unavailable: ${parentPath}`);
  }
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new LifecycleError("enrollment-path", `checkouts parent is not a stable directory: ${parentPath}`);
  }
  assertOwnerOnly(parentInfo, parentPath);
  const parent: DirIdentity = { path: parentPath, dev: parentInfo.dev, ino: parentInfo.ino };

  const dirPath = checkoutDirFor(stateRoot, checkoutKey);
  let dirInfo;
  try {
    dirInfo = lstatSync(dirPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LifecycleError("enrollment-unavailable", `checkout state directory is unavailable: ${dirPath}`);
  }
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
    throw new LifecycleError("enrollment-path", `checkout state directory is not a stable directory: ${dirPath}`);
  }
  assertOwnerOnly(dirInfo, dirPath);
  const dir: DirIdentity = { path: dirPath, dev: dirInfo.dev, ino: dirInfo.ino };

  const file = enrollmentPath(stateRoot, checkoutKey);
  if (dirname(file) !== dirPath) {
    throw new LifecycleError("enrollment-path", `enrollment record escapes its checkout directory: ${file}`);
  }
  let fileInfo;
  try {
    fileInfo = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LifecycleError("enrollment-unavailable", `enrollment record is unavailable: ${file}`);
  }
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new LifecycleError("enrollment-corrupt", `enrollment record is not a regular file: ${file}`);
  }
  assertOwnerOnly(fileInfo, file);
  const fileDev = fileInfo.dev;
  const fileIno = fileInfo.ino;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new LifecycleError("enrollment-corrupt", `enrollment record is not valid JSON: ${file}`);
  }

  // Recheck the owned ancestors and the record identity after reading.
  assertIdentity(parent, "checkouts parent");
  assertIdentity(dir, "checkout state directory");
  let afterInfo;
  try {
    afterInfo = lstatSync(file);
  } catch {
    throw new LifecycleError("enrollment-corrupt", `enrollment record disappeared during read: ${file}`);
  }
  if (
    afterInfo.isSymbolicLink() ||
    !afterInfo.isFile() ||
    afterInfo.dev !== fileDev ||
    afterInfo.ino !== fileIno
  ) {
    throw new LifecycleError("enrollment-corrupt", `enrollment record changed during read: ${file}`);
  }
  return validateEnrollmentShape(parsed);
}

function writeEnrollment(
  stateRoot: string,
  checkoutKey: string,
  record: EnrollmentRecord,
): void {
  const parent = ensureOwnedDir(checkoutsParentDir(stateRoot));
  const dirPath = checkoutDirFor(stateRoot, checkoutKey);
  assertIdentity(parent, "checkouts parent");
  const dir = ensureOwnedDir(dirPath);
  const file = enrollmentPath(stateRoot, checkoutKey);
  if (dirname(file) !== dirPath) {
    throw new LifecycleError("enrollment-path", `enrollment record escapes its checkout directory: ${file}`);
  }
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    // Exclusive, no-follow 0600 temp record before the atomic rename.
    assertIdentity(parent, "checkouts parent");
    assertIdentity(dir, "checkout state directory");
    writeFileSync(temp, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
    assertIdentity(parent, "checkouts parent");
    assertIdentity(dir, "checkout state directory");
    renameSync(temp, file);
    assertIdentity(parent, "checkouts parent");
    assertIdentity(dir, "checkout state directory");
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // best-effort temp cleanup
    }
    throw error;
  }
}

function assertEnrollmentIdentity(record: EnrollmentRecord, identity: CheckoutIdentityLike): void {
  const current = record.identity;
  if (
    current.repoKey !== identity.repoKey ||
    current.checkoutKey !== identity.checkoutKey ||
    current.root !== identity.root ||
    current.commonDir !== identity.commonDir ||
    current.gitDir !== identity.gitDir ||
    current.primary !== identity.primary
  ) {
    throw new LifecycleError("identity-mismatch", "enrollment identity does not match this checkout");
  }
}

function createEnrollment(identity: CheckoutIdentityLike): EnrollmentRecord {
  return {
    version: 1,
    identity: {
      repoKey: identity.repoKey,
      checkoutKey: identity.checkoutKey,
      root: identity.root,
      commonDir: identity.commonDir,
      gitDir: identity.gitDir,
      primary: identity.primary,
    },
    specUse: false,
    enrolledAt: nowIso(),
    head: identity.head,
    lastBuild: null,
    lastCheck: null,
  };
}

function updateEnrollment(
  base: EnrollmentRecord,
  patch: Partial<Pick<EnrollmentRecord, "head" | "lastBuild" | "lastCheck">>,
): EnrollmentRecord {
  return { ...base, ...patch };
}

// Re-read and identity-validate the latest record, then merge the patch so
// unrelated specUse/lastCheck fields are never overwritten from a stale copy.
function mergeEnrollment(
  state: LifecycleState,
  checkoutKey: string,
  identity: CheckoutIdentityLike,
  patch: Partial<Pick<EnrollmentRecord, "head" | "lastBuild" | "lastCheck">>,
  operationId?: string,
): void {
  state.mutateEnrollment(checkoutKey, () => {
    const latest = readEnrollment(state.stateRoot, checkoutKey);
    if (!latest) throw new LifecycleError("unenrolled", "checkout is no longer enrolled");
    assertEnrollmentIdentity(latest, identity);
    writeEnrollment(state.stateRoot, checkoutKey, updateEnrollment(latest, patch));
  }, operationId);
}

async function resolveBuildInputs(
  modelsRoot: string,
  deps: LifecycleDependencies,
): Promise<{ model: VerifiedModel; compatibility: CodeSearchCompatibility }> {
  const model = await verifyModel(modelsRoot, deps.modelAssets);
  const compatibility = createCodeSearchCompatibility({
    modelId: model.modelId,
    assetDigest: model.assetDigest,
  });
  return { model, compatibility };
}

// ---- buildPrimary ---------------------------------------------------------

export async function buildPrimary(input: {
  identity: CheckoutIdentityLike;
  state: LifecycleState;
  modelsRoot: string;
  kind: "build" | "update" | "reindex";
  signal?: AbortSignal;
  deps?: LifecycleDependencies;
}): Promise<OperationReceipt> {
  const startedAt = Date.now();
  const { identity, state, modelsRoot, kind } = input;
  const deps = input.deps ?? {};
  const capture =
    deps.captureSnapshot ??
    ((target: CheckoutIdentityLike, signal?: AbortSignal) =>
      defaultCaptureSnapshot(target, {}, signal));

  if (!identity.primary) {
    throw new LifecycleError("primary-required", "primary build requires a primary checkout identity");
  }

  const operation = state.beginOperation({
    command: kind,
    kind,
    checkoutKey: identity.checkoutKey,
    writer: true,
    native: true,
  });
  let finished = false;
  try {
    state.mutateEnrollment(identity.checkoutKey, () => {
      const existing = readEnrollment(state.stateRoot, identity.checkoutKey);
      if (existing) assertEnrollmentIdentity(existing, identity);
      else if (kind !== "build") throw new LifecycleError("unenrolled", "checkout is not enrolled");
      else writeEnrollment(state.stateRoot, identity.checkoutKey, createEnrollment(identity));
    }, operation.id);
    throwIfAborted(input.signal);
    const { model, compatibility } = await resolveBuildInputs(modelsRoot, deps);
    const acquired = state.acquireCurrent({
      operationId: operation.id,
      checkoutKey: identity.checkoutKey,
    });
    const current = acquired.current as GenerationRecord | null;

    if (kind === "build" && current) {
      if (!codeSearchCompatibilityEqual(current.compatibility, compatibility)) {
        throw new LifecycleError("incompatible", "existing generation is incompatible; reindex required");
      }
      await validateCodeIndexStore({
        destinationDir: current.finalPath,
        compatibility,
      });
      state.finishOperation(operation.id, "finished");
      finished = true;
      return {
        version: 1,
        command: kind,
        kind,
        generationKind: "full",
        availability: "ready",
        operation: "idle",
        freshness: "unknown",
        reason: "already-built",
        repoKey: identity.repoKey,
        checkoutKey: identity.checkoutKey,
        requestedRoot: identity.root,
        actualRoot: identity.root,
        observedHead: identity.head,
        generationId: current.id,
        baseId: current.baseId,
        snapshotDigest: current.snapshotDigest,
        sourceMoved: current.sourceMoved,
        observedAt: nowIso(),
        coverage: coverageFor({ files: new Map(), excluded: {} } as unknown as Snapshot),
        timing: { elapsedMs: Date.now() - startedAt },
      };
    }

    if (kind === "update") {
      if (!current || current.status !== "ready" || current.kind !== "full") {
        throw new LifecycleError("no-current", "update requires a ready full current generation");
      }
      if (!codeSearchCompatibilityEqual(current.compatibility, compatibility)) {
        throw new LifecycleError("incompatible", "current generation compatibility mismatch");
      }
    }

    const captured = await capture(identity, input.signal);
    throwIfAborted(input.signal);

    // Unchanged compatible update: stop before generation/store/runtime work.
    if (kind === "update" && current && captured.digest === current.snapshotDigest) {
      await validateCodeIndexBuild({
        destinationDir: current.finalPath,
        compatibility,
        snapshot: captured,
      });
      mergeEnrollment(state, identity.checkoutKey, identity, {
        head: identity.head,
        lastCheck: null,
      }, operation.id);
      state.finishOperation(operation.id, "finished");
      finished = true;
      return {
        version: 1,
        command: kind,
        kind,
        generationKind: "full",
        availability: "ready",
        operation: "idle",
        freshness: "unknown",
        reason: "unchanged",
        repoKey: identity.repoKey,
        checkoutKey: identity.checkoutKey,
        requestedRoot: identity.root,
        actualRoot: identity.root,
        observedHead: identity.head,
        generationId: current.id,
        baseId: current.baseId,
        snapshotDigest: current.snapshotDigest,
        sourceMoved: false,
        observedAt: nowIso(),
        coverage: coverageFor(captured),
        timing: { elapsedMs: Date.now() - startedAt },
      };
    }

    const built = await performFullBuild({
      identity,
      state,
      operationId: operation.id,
      kind,
      current,
      model,
      compatibility,
      modelsRoot,
      deps,
      capture,
      signal: input.signal,
    });

    mergeEnrollment(state, identity.checkoutKey, identity, {
      head: identity.head,
      lastBuild: {
        at: nowIso(),
        kind,
        status: "ready",
        generationId: built.generationId,
        snapshotDigest: built.snapshotDigest,
      },
      // A refreshed current generation clears stale check provenance; a moved
      // generation that preserves prior current keeps that prior provenance.
      ...(built.sourceMoved ? {} : { lastCheck: null }),
    }, operation.id);
    state.finishOperation(operation.id, "finished");
    finished = true;

    return makeReceipt({
      identity,
      kind,
      generationKind: "full",
      generationId: built.generationId,
      baseId: null,
      snapshotDigest: built.snapshotDigest,
      sourceMoved: built.sourceMoved,
      availability: built.sourceMoved && current === null ? "missing" : "ready",
      freshness: built.sourceMoved ? "stale" : "unknown",
      reason: built.sourceMoved ? "source-moved" : undefined,
      startedAt,
      captured: built.captured,
    });
  } catch (error) {
    if (!finished) {
      try {
        state.finishOperation(operation.id, "failed");
      } catch {
        // release best-effort; underlying error propagates
      }
      try {
        mergeEnrollment(state, identity.checkoutKey, identity, {
          lastBuild: {
            at: nowIso(),
            kind,
            status: "failed",
            reason: errorMessage(error),
          },
        });
      } catch {
        // metadata failure must not mask the underlying error
      }
    }
    throw error;
  }
}

// ---- checkCheckout --------------------------------------------------------

export async function checkCheckout(input: {
  identity: CheckoutIdentityLike;
  state: LifecycleState;
  signal?: AbortSignal;
  deps?: LifecycleDependencies;
}): Promise<CheckReceipt> {
  const startedAt = Date.now();
  const { identity, state } = input;
  const deps = input.deps ?? {};
  const capture =
    deps.captureSnapshot ??
    ((target: CheckoutIdentityLike, signal?: AbortSignal) =>
      defaultCaptureSnapshot(target, {}, signal));

  const enrollment = readEnrollment(state.stateRoot, identity.checkoutKey);
  if (!enrollment) throw new LifecycleError("unenrolled", "checkout is not enrolled");
  assertEnrollmentIdentity(enrollment, identity);

  const operation = state.beginOperation({
    command: "check",
    kind: "check",
    checkoutKey: identity.checkoutKey,
  });
  let finished = false;
  try {
    const acquired = state.acquireCurrent({
      operationId: operation.id,
      checkoutKey: identity.checkoutKey,
    });
    const current = acquired.current as GenerationRecord | null;
    const captured = await capture(identity, input.signal);
    const matchesGeneration = current !== null && current.snapshotDigest === captured.digest;
    const at = nowIso();
    mergeEnrollment(state, identity.checkoutKey, identity, {
      lastCheck: { at, snapshotDigest: captured.digest, matchesGeneration },
    });
    state.finishOperation(operation.id, "finished");
    finished = true;
    return {
      version: 1,
      command: "check",
      availability: current ? "ready" : "missing",
      ...state.readBuildOperation(identity.checkoutKey),
      freshness: matchesGeneration ? "unknown" : "stale",
      reason: matchesGeneration ? "matches" : "changed",
      repoKey: identity.repoKey,
      checkoutKey: identity.checkoutKey,
      observedHead: identity.head,
      generationId: current?.id,
      snapshotDigest: captured.digest,
      matchesGeneration,
      observedAt: at,
      timing: { elapsedMs: Date.now() - startedAt },
    };
  } catch (error) {
    if (!finished) {
      try {
        state.finishOperation(operation.id, "failed");
      } catch {
        // release best-effort
      }
    }
    throw error;
  }
}

// ---- readCheckoutStatus ---------------------------------------------------

export function readCheckoutStatus(input: {
  identity: CheckoutIdentityLike;
  state: LifecycleState;
  deps?: LifecycleDependencies;
}): CheckoutStatusReceipt {
  const { identity, state } = input;
  const enrollment = readEnrollment(state.stateRoot, identity.checkoutKey);
  if (enrollment) assertEnrollmentIdentity(enrollment, identity);
  const status = state.readStatus({ checkoutKey: identity.checkoutKey });
  const current = status.current.find((entry) => entry.checkoutKey === identity.checkoutKey) ?? null;
  const lastCheck = enrollment?.lastCheck ?? null;
  const freshness: LifecycleFreshness =
    lastCheck && lastCheck.matchesGeneration === false ? "stale" : "unknown";
  return {
    version: 1,
    command: "status",
    enrolled: enrollment !== null,
    activeOperations: status.operations.filter((operation) => operation.state === "active"),
    specUse: enrollment?.specUse ?? false,
    ...state.readBuildOperation(identity.checkoutKey),
    availability: current ? "ready" : "missing",
    freshness,
    repoKey: identity.repoKey,
    checkoutKey: identity.checkoutKey,
    currentGenerationId: current ? current.generationId : null,
    lastCheck,
    observedAt: nowIso(),
  };
}

// ---- Shared full/overlay build helpers ------------------------------------

type CaptureFn = (
  identity: CheckoutIdentityLike,
  signal?: AbortSignal,
) => Promise<Snapshot>;

type BuiltGeneration = {
  captured: Snapshot;
  generationId: string;
  snapshotDigest: string;
  sourceMoved: boolean;
  derivedBytes: number;
  baseId: string | null;
};

function makeReceipt(input: {
  identity: CheckoutIdentityLike;
  kind: "build" | "update" | "reindex";
  generationKind: "full" | "overlay";
  generationId: string;
  baseId: string | null;
  snapshotDigest: string;
  sourceMoved?: boolean;
  availability: LifecycleAvailability;
  freshness: LifecycleFreshness;
  reason?: string;
  startedAt: number;
  captured?: Snapshot;
}): OperationReceipt {
  return {
    version: 1,
    command: input.kind,
    kind: input.kind,
    generationKind: input.generationKind,
    availability: input.availability,
    operation: "idle",
    freshness: input.freshness,
    reason: input.reason,
    repoKey: input.identity.repoKey,
    checkoutKey: input.identity.checkoutKey,
    requestedRoot: input.identity.root,
    actualRoot: input.identity.root,
    observedHead: input.identity.head,
    generationId: input.generationId,
    baseId: input.baseId,
    snapshotDigest: input.snapshotDigest,
    sourceMoved: input.sourceMoved,
    observedAt: nowIso(),
    coverage: input.captured
      ? coverageFor(input.captured)
      : coverageFor({ files: new Map(), excluded: {} } as unknown as Snapshot),
    timing: { elapsedMs: Date.now() - input.startedAt },
  };
}

// Full generation: new/reindex opens an empty store; update clones the prior
// derived store. Captured bytes and the bounded post snapshot are real.
async function performFullBuild(input: {
  identity: CheckoutIdentityLike;
  state: LifecycleState;
  operationId: string;
  kind: "build" | "update" | "reindex";
  current: GenerationRecord | null;
  model: VerifiedModel;
  compatibility: CodeSearchCompatibility;
  modelsRoot: string;
  deps: LifecycleDependencies;
  capture: CaptureFn;
  signal?: AbortSignal;
}): Promise<BuiltGeneration> {
  const { identity, state, operationId, kind, current, model, compatibility, modelsRoot, deps, capture } = input;
  const captured = await capture(identity, input.signal);
  throwIfAborted(input.signal);
  const plan = await planCodeIndexBuild({
    snapshot: captured,
    previousStoreDir: kind === "update" && current ? current.finalPath : undefined,
    signal: input.signal,
  });
  const generation = state.beginGeneration({
    operationId,
    checkoutKey: identity.checkoutKey,
    repoKey: identity.repoKey,
    kind: "full",
    baseId: null,
    compatibility,
    snapshotDigest: captured.digest,
    capturedAt: captured.observedAt,
    observedHead: identity.head,
    sourceMoved: false,
    bytes: 0,
  });
  const buildResult = await buildCodeIndex({
    plan,
    snapshot: captured,
    destinationDir: generation.tempPath,
    compatibility,
    model,
    modelsRoot,
    cachePath: join(state.stateRoot, "embedding-cache.sqlite"),
    beforeWrite: state.assertGrowth,
    signal: input.signal,
    createEmbeddingRuntime: deps.createEmbeddingRuntime,
  });
  throwIfAborted(input.signal);
  const post = await capture(identity, input.signal);
  const sourceMoved = post.digest !== captured.digest;
  await state.publish({
    operationId,
    generationId: generation.id,
    validate: async (tempPath: string) => {
      await validateCodeIndexBuild({ destinationDir: tempPath, compatibility, snapshot: captured });
      return true;
    },
    finalize: { sourceMoved, bytes: buildResult.derivedBytes },
  });
  return {
    captured,
    generationId: generation.id,
    snapshotDigest: captured.digest,
    sourceMoved,
    derivedBytes: buildResult.derivedBytes,
    baseId: null,
  };
}

// Overlay generation: always a fresh empty changed-only store; the immutable
// base is only read/validated and never cloned or mutated.
async function performOverlayBuild(input: {
  identity: CheckoutIdentityLike;
  state: LifecycleState;
  operationId: string;
  baseId: string;
  baseStoreDir: string;
  model: VerifiedModel;
  compatibility: CodeSearchCompatibility;
  modelsRoot: string;
  deps: LifecycleDependencies;
  capture: CaptureFn;
  signal?: AbortSignal;
}): Promise<BuiltGeneration> {
  const { identity, state, operationId, baseId, baseStoreDir, model, compatibility, modelsRoot, deps, capture } = input;
  const captured = await capture(identity, input.signal);
  throwIfAborted(input.signal);
  const plan = await planOverlayBuild({
    snapshot: captured,
    baseId,
    baseStoreDir,
    compatibility,
    signal: input.signal,
  });
  const generation = state.beginGeneration({
    operationId,
    checkoutKey: identity.checkoutKey,
    repoKey: identity.repoKey,
    kind: "overlay",
    baseId,
    compatibility,
    snapshotDigest: captured.digest,
    capturedAt: captured.observedAt,
    observedHead: identity.head,
    sourceMoved: false,
    bytes: 0,
  });
  const buildResult = await buildOverlayIndex({
    plan,
    destinationDir: generation.tempPath,
    compatibility,
    model,
    modelsRoot,
    cachePath: join(state.stateRoot, "embedding-cache.sqlite"),
    beforeWrite: state.assertGrowth,
    signal: input.signal,
    createEmbeddingRuntime: deps.createEmbeddingRuntime,
  });
  throwIfAborted(input.signal);
  const post = await capture(identity, input.signal);
  const sourceMoved = post.digest !== captured.digest;
  await state.publish({
    operationId,
    generationId: generation.id,
    validate: async (tempPath: string) => {
      await validateOverlayBuild({
        destinationDir: tempPath,
        baseStoreDir,
        baseId,
        compatibility,
        snapshot: captured,
        expectedTombstones: plan.tombstones,
      });
      return true;
    },
    finalize: { sourceMoved, bytes: buildResult.derivedBytes },
  });
  return {
    captured,
    generationId: generation.id,
    snapshotDigest: captured.digest,
    sourceMoved,
    derivedBytes: buildResult.derivedBytes,
    baseId,
  };
}

// ---- buildWorktree --------------------------------------------------------

export async function buildWorktree(input: {
  identity: CheckoutIdentityLike;
  state: LifecycleState;
  modelsRoot: string;
  kind: "build" | "update" | "reindex";
  primaryIdentity?: CheckoutIdentityLike;
  signal?: AbortSignal;
  deps?: LifecycleDependencies;
}): Promise<OperationReceipt> {
  const startedAt = Date.now();
  const { identity, state, modelsRoot, kind } = input;
  const deps = input.deps ?? {};
  const capture: CaptureFn =
    deps.captureSnapshot ??
    ((target, signal) => defaultCaptureSnapshot(target, {}, signal));

  if (identity.primary) {
    throw new LifecycleError("worktree-required", "buildWorktree requires a linked worktree identity");
  }

  const operation = state.beginOperation({
    command: kind,
    kind,
    checkoutKey: identity.checkoutKey,
    writer: true,
    native: true,
  });
  let finished = false;
  try {
    state.mutateEnrollment(identity.checkoutKey, () => {
      const existing = readEnrollment(state.stateRoot, identity.checkoutKey);
      if (existing) assertEnrollmentIdentity(existing, identity);
      else if (kind !== "build") throw new LifecycleError("unenrolled", "checkout is not enrolled");
      else writeEnrollment(state.stateRoot, identity.checkoutKey, createEnrollment(identity));
    }, operation.id);
    throwIfAborted(input.signal);
    const { model, compatibility } = await resolveBuildInputs(modelsRoot, deps);
    const worktreeAcq = state.acquireCurrent({
      operationId: operation.id,
      checkoutKey: identity.checkoutKey,
    });
    const current = worktreeAcq.current as GenerationRecord | null;
    const currentBase = worktreeAcq.base as GenerationRecord | null;

    if (kind === "build" && current) {
      if (!codeSearchCompatibilityEqual(current.compatibility, compatibility)) {
        throw new LifecycleError("incompatible", "existing generation is incompatible; reindex required");
      }
      if (current.kind === "full") {
        await validateCodeIndexStore({
          destinationDir: current.finalPath,
          compatibility,
        });
      } else {
        if (!currentBase || currentBase.id !== current.baseId) {
          throw new LifecycleError("base-missing", "overlay base is no longer available");
        }
        await validateOverlayStore({
          destinationDir: current.finalPath,
          baseStoreDir: currentBase.finalPath,
          baseId: currentBase.id,
          compatibility,
        });
      }
      state.finishOperation(operation.id, "finished");
      finished = true;
      return makeReceipt({
        identity,
        kind,
        generationKind: current.kind,
        generationId: current.id,
        baseId: current.baseId,
        snapshotDigest: current.snapshotDigest,
        sourceMoved: current.sourceMoved,
        availability: "ready",
        freshness: "unknown",
        reason: "already-built",
        startedAt,
      });
    }

    let built: BuiltGeneration;
    let generationKind: "full" | "overlay";

    const isExistingFull = current !== null && current.status === "ready" && current.kind === "full";
    const isExistingOverlay = current !== null && current.status === "ready" && current.kind === "overlay";

    if (kind === "update" && isExistingFull) {
      if (!codeSearchCompatibilityEqual(current!.compatibility, compatibility)) {
        throw new LifecycleError("incompatible", "current full generation compatibility mismatch");
      }
      built = await performFullBuild({
        identity, state, operationId: operation.id, kind, current, model, compatibility, modelsRoot, deps, capture, signal: input.signal,
      });
      generationKind = "full";
    } else if (kind === "update" && isExistingOverlay) {
      const base = currentBase;
      if (!base || base.id !== current!.baseId) {
        throw new LifecycleError("base-missing", "overlay base is no longer available");
      }
      if (
        base.status !== "ready" ||
        base.kind !== "full" ||
        base.repoKey !== identity.repoKey ||
        !codeSearchCompatibilityEqual(base.compatibility, compatibility)
      ) {
        throw new LifecycleError("base-missing", "overlay base is not usable or compatible");
      }
      try {
        await validateOverlayStore({
          destinationDir: current!.finalPath,
          baseStoreDir: base.finalPath,
          baseId: base.id,
          compatibility,
        });
      } catch (error) {
        if (error instanceof CodeIndexUnavailableError || error instanceof ResourceBudgetError) throw error;
        throw new CodeIndexUnavailableError(
          "Current overlay generation is unavailable.",
          error,
        );
      }
      built = await performOverlayBuild({
        identity, state, operationId: operation.id, baseId: base.id, baseStoreDir: base.finalPath, model, compatibility, modelsRoot, deps, capture, signal: input.signal,
      });
      generationKind = "overlay";
    } else if (kind === "update") {
      throw new LifecycleError("no-current", "update requires an existing ready generation");
    } else {
      let selected: GenerationRecord | null = null;
      if (input.primaryIdentity) {
        const primary = input.primaryIdentity;
        if (!primary.primary) {
          throw new LifecycleError("primary-required", "primaryIdentity must be a primary checkout");
        }
        if (primary.repoKey !== identity.repoKey) {
          throw new LifecycleError("repo-mismatch", "primaryIdentity must be from the same repository");
        }
        if (primary.checkoutKey === identity.checkoutKey) {
          throw new LifecycleError("primary-required", "primaryIdentity must differ from the worktree");
        }
        const primaryAcq = state.acquireCurrent({
          operationId: operation.id,
          checkoutKey: primary.checkoutKey,
        });
        const primaryCurrent = primaryAcq.current as GenerationRecord | null;
        if (primaryCurrent) {
          // Contradictory repo identity or a non-full primary generation fails
          // closed; an incompatible ready full base is simply not eligible and
          // falls back to an explicit full generation for build/reindex.
          if (
            primaryCurrent.status !== "ready" ||
            primaryCurrent.kind !== "full" ||
            primaryCurrent.repoKey !== identity.repoKey
          ) {
            throw new LifecycleError(
              "base-unavailable",
              "selected primary base is not a usable full primary generation",
            );
          }
          if (codeSearchCompatibilityEqual(primaryCurrent.compatibility, compatibility)) {
            selected = primaryCurrent;
          }
        }
      }
      if (selected) {
        built = await performOverlayBuild({
          identity, state, operationId: operation.id, baseId: selected.id, baseStoreDir: selected.finalPath, model, compatibility, modelsRoot, deps, capture, signal: input.signal,
        });
        generationKind = "overlay";
      } else {
        built = await performFullBuild({
          identity, state, operationId: operation.id, kind, current, model, compatibility, modelsRoot, deps, capture, signal: input.signal,
        });
        generationKind = "full";
      }
    }

    mergeEnrollment(state, identity.checkoutKey, identity, {
      head: identity.head,
      lastBuild: {
        at: nowIso(),
        kind,
        status: "ready",
        generationId: built.generationId,
        snapshotDigest: built.snapshotDigest,
      },
      ...(built.sourceMoved ? {} : { lastCheck: null }),
    }, operation.id);
    state.finishOperation(operation.id, "finished");
    finished = true;

    return makeReceipt({
      identity,
      kind,
      generationKind,
      generationId: built.generationId,
      baseId: built.baseId,
      snapshotDigest: built.snapshotDigest,
      sourceMoved: built.sourceMoved,
      availability: built.sourceMoved && current === null ? "missing" : "ready",
      freshness: built.sourceMoved ? "stale" : "unknown",
      reason: built.sourceMoved ? "source-moved" : undefined,
      startedAt,
      captured: built.captured,
    });
  } catch (error) {
    if (!finished) {
      try {
        state.finishOperation(operation.id, "failed");
      } catch {
        // release best-effort; underlying error propagates
      }
      try {
        mergeEnrollment(state, identity.checkoutKey, identity, {
          lastBuild: { at: nowIso(), kind, status: "failed", reason: errorMessage(error) },
        });
      } catch {
        // metadata failure must not mask the underlying error
      }
    }
    throw error;
  }
}

// ---- updateCheckout -------------------------------------------------------

export async function updateCheckout(input: {
  identity: CheckoutIdentityLike;
  state: LifecycleState;
  modelsRoot: string;
  primaryIdentity?: CheckoutIdentityLike;
  signal?: AbortSignal;
  deps?: LifecycleDependencies;
}): Promise<OperationReceipt> {
  if (input.identity.primary) {
    return buildPrimary({
      identity: input.identity,
      state: input.state,
      modelsRoot: input.modelsRoot,
      kind: "update",
      signal: input.signal,
      deps: input.deps,
    });
  }
  return buildWorktree({
    identity: input.identity,
    state: input.state,
    modelsRoot: input.modelsRoot,
    kind: "update",
    primaryIdentity: input.primaryIdentity,
    signal: input.signal,
    deps: input.deps,
  });
}

// ---- configureSpecUse -----------------------------------------------------

// Operator-only spec-use preference. Requires an existing enrollment, writes
// the full record atomically through the state mutation claim, and never touches
// generations or current state.
export function configureSpecUse(input: {
  identity: CheckoutIdentityLike;
  state: LifecycleState;
  specUse: boolean;
}): {
  version: 1;
  command: "configure";
  specUse: boolean;
  repoKey: string;
  checkoutKey: string;
  requestedRoot: string;
  actualRoot: string;
  observedAt: string;
} {
  const { identity, state, specUse } = input;
  state.mutateEnrollment(identity.checkoutKey, () => {
    const stateRoot = state.stateRoot;
    const enrollment = readEnrollment(stateRoot, identity.checkoutKey);
    if (!enrollment) {
      throw new LifecycleError("unenrolled", "checkout is not enrolled");
    }
    assertEnrollmentIdentity(enrollment, identity);
    writeEnrollment(stateRoot, identity.checkoutKey, { ...enrollment, specUse });
  });
  return {
    version: 1,
    command: "configure",
    specUse,
    repoKey: identity.repoKey,
    checkoutKey: identity.checkoutKey,
    requestedRoot: identity.root,
    actualRoot: identity.root,
    observedAt: nowIso(),
  };
}
