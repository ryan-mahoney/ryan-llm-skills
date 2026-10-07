import { ResourceBudgetError } from "./core/resources";
import { normalizeContent } from "./core/chunkContract";
// Finite repository search session owner.
//
// Acquires and pins current/base generations through state.ts, strictly
// restores actual Orama stores/manifests, retrieves BM25 or vector candidates
// with bounded base/overlay refill, and validates returned candidates through
// source.ts's eligible-file read before deriving hash + excerpt bytes. BM25
// never loads ONNX; the native slot and embedding runtime are acquired lazily
// on the first vector query and released by dispose.

import {
  codeSearchHitIdentity,
  createCodeIndexRuntime,
  reciprocalRankFuse,
  resolveCodeIndexStorePaths,
  type CodeIndexRuntime,
  type CodeSearchHit,
} from "./core/codeIndexRuntime";
import {
  readFileManifest,
  resolveManifestPath,
  type FileManifestEntry,
} from "./core/fileManifest";
import { readOverlayManifest } from "./core/overlayManifest";
import {
  verifyModel,
  type CodeModelAssetSpec,
  type VerifiedModel,
} from "./core/codeModelAssets";
import {
  CODE_INDEX_MODEL_ID,
  codeSearchCompatibilityEqual,
  createCodeSearchCompatibility,
  type CodeSearchCompatibility,
} from "./core/embeddingContract";
import { CODE_INDEX_MANIFEST_VERSION, type BuildEmbeddingRuntimeFactory } from "./core/build";
import type { CodeEmbeddingRuntime } from "./core/codeEmbeddingRuntime";
import {
  readEligibleFile as defaultReadEligibleFile,
  SOURCE_POLICY_VERSION,
} from "./source";
import type { openState, GenerationRecord } from "./state";

export type SearchState = ReturnType<typeof openState>;

type CheckoutIdentityLike = {
  repoKey: string;
  checkoutKey: string;
  root: string;
  commonDir: string;
  gitDir: string;
  head: string | null;
  primary: boolean;
};

export class SearchError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SearchError";
    this.code = code;
  }
}

export type ReadEligibleSeam = (
  identity: CheckoutIdentityLike,
  relPath: string,
  signal?: AbortSignal,
) => Promise<{ path: string; bytes: Buffer; sha256: string }>;

export type SearchDependencies = {
  modelAssets?: readonly CodeModelAssetSpec[];
  createEmbeddingRuntime?: BuildEmbeddingRuntimeFactory;
  readEligibleFile?: ReadEligibleSeam;
};

export type SearchHit = {
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
  score: number;
  fileHash: string;
  excerpt: string;
};

export type SearchCoverage = {
  policy: string;
  indexedFiles: number;
  excluded: Record<string, number>;
  completeness: "unknown" | "partial";
  staleHits: number;
  omittedHits: number;
  candidateLimitReached: boolean;
};

export type SearchResult = {
  version: 1;
  command: "search";
  mode: "vector" | "bm25";
  availability: "ready" | "missing" | "unavailable";
  freshness: "unknown" | "stale";
  operation: "idle" | "building" | "failed" | "interrupted";
  operationId?: string;
  repoKey: string;
  checkoutKey: string;
  requestedRoot: string;
  actualRoot: string;
  observedHead: string | null;
  generationId: string;
  baseId: string | null;
  queryMs: number;
  observedAt: string;
  timing: { elapsedMs: number; modelLoadMs?: number };
  hits: SearchHit[];
  coverage: SearchCoverage;
};

export type SearchSession = {
  search(query: string, mode: "vector" | "bm25", limit: number): Promise<SearchResult>;
  dispose(): Promise<void>;
};

const CANDIDATE_CAP_PER_SOURCE = 160;

// k means the requested hit count (not one thousand): 2k/4k/8k capped at 160,
// then a final 160, unique and ascending. No source is requested above 160.
function candidateWindows(limit: number): number[] {
  const windows = [
    Math.min(2 * limit, CANDIDATE_CAP_PER_SOURCE),
    Math.min(4 * limit, CANDIDATE_CAP_PER_SOURCE),
    Math.min(8 * limit, CANDIDATE_CAP_PER_SOURCE),
    CANDIDATE_CAP_PER_SOURCE,
  ];
  return [...new Set(windows)].sort((a, b) => a - b);
}
const MAX_EXCERPT_FILES = 40;
const MAX_EXCERPT_BYTES = 20 * 1024 * 1024;
const MAX_QUERY_CODE_POINTS = 2000;

function nowIso(): string {
  return new Date().toISOString();
}

async function defaultEmbeddingRuntime(input: {
  modelsRoot: string;
  model: VerifiedModel;
  compatibility: CodeSearchCompatibility;
}): Promise<CodeEmbeddingRuntime> {
  const { createCodeEmbeddingRuntime } = await import("./core/codeEmbeddingRuntime");
  return createCodeEmbeddingRuntime({
    manifest: {
      modelId: input.model.modelId,
      modelsRoot: input.modelsRoot,
      modelDir: input.model.modelDir,
      requiredFiles: input.model.files.map((file) => file.path),
    },
  });
}

function excerptLines(bytes: Buffer, startLine: number, endLine: number): string {
  const text = new TextDecoder("utf-8").decode(bytes);
  const lines = normalizeContent(text).split("\n");
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  return lines.slice(start, end).join("\n");
}

/**
 * Create a finite search session. Pins are retained until `dispose`; the
 * embedding runtime and native slot are acquired only on the first vector query.
 */
export async function createSearchSession(input: {
  identity: CheckoutIdentityLike;
  state: SearchState;
  modelsRoot?: string;
  signal?: AbortSignal;
  deps?: SearchDependencies;
}): Promise<SearchSession> {
  const { identity, state } = input;
  const deps = input.deps ?? {};
  const readFile: ReadEligibleSeam = deps.readEligibleFile ?? defaultReadEligibleFile;

  const operation = state.beginOperation({
    command: "search",
    kind: "search",
    checkoutKey: identity.checkoutKey,
  });

  try {
    const acquired = state.acquireCurrent({
      operationId: operation.id,
      checkoutKey: identity.checkoutKey,
    });
    const current = acquired.current as GenerationRecord | null;
    if (!current || current.status !== "ready") {
      throw new SearchError("no-current", "no ready generation for search");
    }
    const packageCompatibility = createCodeSearchCompatibility({
      modelId: CODE_INDEX_MODEL_ID,
      assetDigest: current.compatibility.assetDigest,
    });
    if (!codeSearchCompatibilityEqual(current.compatibility, packageCompatibility)) {
      throw new SearchError("incompatible", "generation package/policy compatibility mismatch; reindex required");
    }
    const isOverlay = current.kind === "overlay";
    const base = acquired.base as GenerationRecord | null;
    if (isOverlay) {
      if (!base || base.id !== current.baseId) {
        throw new SearchError("base-unavailable", "overlay base is not available");
      }
      if (base.status !== "ready" || base.kind !== "full") {
        throw new SearchError("base-unavailable", "overlay base is not a ready full generation");
      }
      if (!codeSearchCompatibilityEqual(base.compatibility, current.compatibility)) {
        throw new SearchError("incompatible", "overlay/base compatibility mismatch");
      }
    }

    let currentRuntime: CodeIndexRuntime;
    try {
      currentRuntime = await createCodeIndexRuntime(
        resolveCodeIndexStorePaths(current.finalPath),
        { open: "restore" },
      );
    } catch (error) {
      if (error instanceof ResourceBudgetError) throw error;
      throw new SearchError("corrupt", `current generation is unavailable: ${(error as Error).message}`);
    }

    let baseRuntime: CodeIndexRuntime | null = null;
    let currentManifest: Record<string, FileManifestEntry>;
    const tombstones = new Set<string>();

    if (isOverlay) {
      const overlayManifest = await readOverlayManifest(current.finalPath);
      if (overlayManifest === undefined) {
        throw new SearchError("corrupt", "overlay manifest is missing or corrupt");
      }
      if (overlayManifest.baseId !== current.baseId) {
        throw new SearchError("incompatible", "overlay manifest base id does not match the pinned current");
      }
      if (
        overlayManifest.modelId !== current.compatibility.modelId ||
        overlayManifest.dimensions !== current.compatibility.dimensions
      ) {
        throw new SearchError("incompatible", "overlay manifest compatibility mismatch");
      }
      try {
        baseRuntime = await createCodeIndexRuntime(
          resolveCodeIndexStorePaths(base!.finalPath),
          { open: "restore" },
        );
      } catch (error) {
        if (error instanceof ResourceBudgetError) throw error;
        throw new SearchError("corrupt", `overlay base is unavailable: ${(error as Error).message}`);
      }
      currentManifest = overlayManifest.files;
      for (const path of overlayManifest.tombstones) tombstones.add(path);
    } else {
      const fileManifest = await readFileManifest(resolveManifestPath(current.finalPath));
      if (fileManifest === undefined) {
        throw new SearchError("corrupt", "generation manifest is missing or corrupt");
      }
      if (
        fileManifest.version !== CODE_INDEX_MANIFEST_VERSION ||
        fileManifest.modelId !== current.compatibility.modelId ||
        fileManifest.dimensions !== current.compatibility.dimensions
      ) {
        throw new SearchError("incompatible", "generation manifest compatibility mismatch");
      }
      currentManifest = fileManifest.files;
    }

    let runtime: CodeEmbeddingRuntime | null = null;
    let runtimePromise: Promise<CodeEmbeddingRuntime> | null = null;
    let disposed = false;
    let modelLoadMs: number | undefined;

    // One cached construction promise: concurrent same-session vector queries
    // share a single runtime, and the native slot is claimed only immediately
    // before construction after models/compatibility are verified.
    function ensureVectorRuntime(): Promise<CodeEmbeddingRuntime> {
      if (runtimePromise) return runtimePromise;
      runtimePromise = (async () => {
        if (!input.modelsRoot) {
          throw new SearchError("model-unavailable", "vector search requires modelsRoot");
        }
        const verified = await verifyModel(input.modelsRoot, deps.modelAssets);
        const compatibility = createCodeSearchCompatibility({
          modelId: verified.modelId,
          assetDigest: verified.assetDigest,
        });
        if (!codeSearchCompatibilityEqual(compatibility, current.compatibility)) {
          throw new SearchError("incompatible", "model compatibility does not match the generation");
        }
        state.acquireNative(operation.id);
        const loadStart = Date.now();
        const created = deps.createEmbeddingRuntime
          ? await deps.createEmbeddingRuntime({
              modelsRoot: input.modelsRoot,
              model: verified,
              compatibility,
            })
          : await defaultEmbeddingRuntime({
              modelsRoot: input.modelsRoot,
              model: verified,
              compatibility,
            });
        modelLoadMs = Date.now() - loadStart;
        runtime = created;
        return created;
      })();
      return runtimePromise;
    }

    async function search(
      query: string,
      mode: "vector" | "bm25",
      limit: number,
    ): Promise<SearchResult> {
      if (disposed) {
        throw new SearchError("disposed", "search session has been disposed");
      }
      const queryStart = Date.now();
      const codePoints = [...(query ?? "")].length;
      if (typeof query !== "string" || codePoints === 0 || codePoints > MAX_QUERY_CODE_POINTS) {
        throw new SearchError("invalid-query", "query must be 1..2000 Unicode code points");
      }
      if (mode !== "vector" && mode !== "bm25") {
        throw new SearchError("invalid-query", "mode must be vector or bm25");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
        throw new SearchError("invalid-query", "limit must be 1..20");
      }

      let queryVector: number[] | undefined;
      if (mode === "vector") {
        const embeddingRuntime = await ensureVectorRuntime();
        queryVector = await embeddingRuntime.embed(query);
      }

      const sources: Array<{ runtime: CodeIndexRuntime; isBase: boolean }> = [];
      if (baseRuntime) sources.push({ runtime: baseRuntime, isBase: true });
      sources.push({ runtime: currentRuntime, isBase: false });

      // Reads are reused across refill rounds. Each final omitted stale or
      // unreadable candidate is counted once; scores come from the current
      // round's fused candidates rather than an earlier cached score.
      const readCache = new Map<string, { bytes: Buffer; sha256: string } | null>();
      const attemptedFiles = new Set<string>();
      const staleCounted = new Set<string>();
      const omittedCounted = new Set<string>();
      let bytesBudget = 0;
      let staleHits = 0;
      let omittedHits = 0;
      let budgetExhausted = false;

      async function validateRound(fused: CodeSearchHit[]): Promise<SearchHit[]> {
        const ordered: SearchHit[] = [];
        for (const candidate of fused) {
          const identityKey = codeSearchHitIdentity(candidate);
          const entry = currentManifest[candidate.path];
          if (!entry) {
            if (!staleCounted.has(identityKey)) {
              staleCounted.add(identityKey);
              staleHits += 1;
              omittedHits += 1;
            }
            continue;
          }
          let read = readCache.get(candidate.path);
          if (read === undefined) {
            if (attemptedFiles.size >= MAX_EXCERPT_FILES) {
              budgetExhausted = true;
              read = null;
            } else {
              attemptedFiles.add(candidate.path);
              try {
                const captured = await readFile(identity, candidate.path, input.signal);
                if (captured.sha256 !== entry.hash) {
                  read = null;
                  if (!staleCounted.has(identityKey)) {
                    staleCounted.add(identityKey);
                    staleHits += 1;
                  }
                } else if (bytesBudget + captured.bytes.length > MAX_EXCERPT_BYTES) {
                  budgetExhausted = true;
                  read = null;
                } else {
                  bytesBudget += captured.bytes.length;
                  read = { bytes: captured.bytes, sha256: captured.sha256 };
                }
              } catch {
                read = null;
                if (!staleCounted.has(identityKey)) {
                  staleCounted.add(identityKey);
                  staleHits += 1;
                }
              }
            }
            readCache.set(candidate.path, read);
          }
          if (read === null) {
            if (!omittedCounted.has(identityKey)) {
              omittedCounted.add(identityKey);
              omittedHits += 1;
            }
            continue;
          }
          ordered.push({
            path: candidate.path,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            symbol: candidate.symbol,
            score: candidate.score,
            fileHash: read.sha256,
            excerpt: excerptLines(read.bytes, candidate.startLine, candidate.endLine),
          });
        }
        return ordered;
      }

      const windows = candidateWindows(limit);
      let hits: SearchHit[] = [];
      let candidateLimitReached = false;

      for (let index = 0; index < windows.length; index += 1) {
        const window = windows[index];
        const isFinalWindow = index === windows.length - 1;
        let anySaturated = false;
        const perSource: CodeSearchHit[][] = [];
        for (const source of sources) {
          const raw = await source.runtime.search({
            term: query,
            vector: queryVector,
            mode,
            limit: window,
          });
          if (raw.length >= window) anySaturated = true;
          const collected: CodeSearchHit[] = [];
          const seen = new Set<string>();
          for (const hit of raw) {
            if (source.isBase && tombstones.has(hit.path)) continue;
            const id = codeSearchHitIdentity(hit);
            if (seen.has(id)) continue;
            seen.add(id);
            collected.push(hit);
          }
          perSource.push(collected);
        }
        const fused = reciprocalRankFuse(
          perSource,
          perSource.reduce((total, candidates) => total + candidates.length, 0),
        );
        const ordered = await validateRound(fused);
        hits = ordered.slice(0, limit);
        if (budgetExhausted) candidateLimitReached = true;
        if (hits.length >= limit) break;
        if (!anySaturated) break;
        if (isFinalWindow && anySaturated) candidateLimitReached = true;
      }

      return {
        version: 1,
        command: "search",
        mode,
        availability: "ready",
        freshness: staleHits > 0 ? "stale" : "unknown",
        ...state.readBuildOperation(identity.checkoutKey),
        repoKey: identity.repoKey,
        checkoutKey: identity.checkoutKey,
        requestedRoot: identity.root,
        actualRoot: identity.root,
        observedHead: identity.head,
        generationId: current.id,
        baseId: isOverlay && base ? base.id : null,
        queryMs: Date.now() - queryStart,
        observedAt: nowIso(),
        timing:
          modelLoadMs === undefined
            ? { elapsedMs: Date.now() - queryStart }
            : { elapsedMs: Date.now() - queryStart, modelLoadMs },
        hits,
        coverage: {
          policy: SOURCE_POLICY_VERSION,
          indexedFiles: Object.keys(currentManifest).length,
          excluded: {},
          completeness: staleHits > 0 || omittedHits > 0 ? "partial" : "unknown",
          staleHits,
          omittedHits,
          candidateLimitReached,
        },
      };
    }

    async function dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        let active = runtime;
        if (runtimePromise) {
          try {
            active = await runtimePromise;
          } catch {
            // construction failed; nothing to dispose
            active = null;
          }
        }
        // Disposal runs outside the construction catch so a disposal failure
        // propagates while state release still happens in the finally.
        if (active && typeof active.dispose === "function") {
          await active.dispose();
        }
      } finally {
        // State pins/native must always be released, even on runtime failure.
        state.finishOperation(operation.id, "finished");
      }
    }

    return { search, dispose };
  } catch (error) {
    try {
      state.finishOperation(operation.id, "failed");
    } catch {
      // release best-effort; underlying error propagates
    }
    throw error;
  }
}

/** One-shot checkout search; creates one session, queries once, always disposes. */
export async function searchCheckout(input: {
  identity: CheckoutIdentityLike;
  state: SearchState;
  query: string;
  mode?: "vector" | "bm25";
  limit?: number;
  modelsRoot?: string;
  signal?: AbortSignal;
  deps?: SearchDependencies;
}): Promise<SearchResult> {
  const session = await createSearchSession({
    identity: input.identity,
    state: input.state,
    modelsRoot: input.modelsRoot,
    signal: input.signal,
    deps: input.deps,
  });
  try {
    return await session.search(input.query, input.mode ?? "vector", input.limit ?? 10);
  } finally {
    await session.dispose();
  }
}
