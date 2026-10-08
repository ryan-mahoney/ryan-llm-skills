// Step 10 optional spec discovery adapter (Node-only ESM).
//
// Registers the owner-only `spec_search` tool. The optional repository-search
// package and its Bun/ONNX-free client are loaded lazily inside execute; this
// module never imports Bun, ONNX, transformers, Pi runtime code, or the
// optional client at module scope, and it performs no work on import.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_BUDGET_MS = 15000;
const CLEANUP_RESERVE_MS = 1000;
const MIN_QUERY_BUDGET_MS = 500;
const FALLBACK_TEXT =
  "Use rg for exact literals or read known files directly; do not treat this as absence.";

const here = dirname(fileURLToPath(import.meta.url));

// Plain JSON-schema parameter object: the adapter must not import TypeBox/Pi at
// module scope. `root` is intentionally absent; the checkout is record-owned.
const SPEC_SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 2000 },
    mode: { type: "string", enum: ["vector", "bm25"] },
    limit: { type: "integer", minimum: 1, maximum: 20 },
    state: { type: "string" },
  },
  required: ["query"],
  additionalProperties: false,
};

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: value,
    isError,
  };
}

function withFallback(status, reason, extra = {}) {
  return { status, reason, fallback: FALLBACK_TEXT, ...extra };
}

function skipped(reason) {
  return withFallback("skipped", reason);
}

function unavailable(reason, message) {
  return withFallback("unavailable", reason, message ? { message } : {});
}

function candidateClientPaths() {
  return [
    resolve(here, "../../../scripts/repo-search/client.mjs"),
    join(homedir(), ".agents", "scripts", "repo-search", "client.mjs"),
  ];
}

async function resolveClient(deps) {
  if (typeof deps.resolveClient === "function") {
    const resolved = await deps.resolveClient();
    if (!resolved) return null;
    if (typeof resolved === "string") return await import(pathToFileURL(resolved).href);
    return resolved;
  }
  if (typeof deps.loadClient === "function") {
    return (await deps.loadClient()) ?? null;
  }
  for (const candidate of candidateClientPaths()) {
    if (!existsSync(candidate)) continue;
    try {
      const module = await import(pathToFileURL(candidate).href);
      if (module && typeof module.searchRepository === "function") return module;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// The optional client already formats its receipt through the package's
// format.mjs owner, which bounds public output and preserves mandatory scope.
// Keep that receipt intact instead of re-trimming it, and add only the
// adapter's own state markers so identity, freshness and coverage stay visible.
function mapResult(result) {
  const status = result?.status;
  const reason = result?.reason;
  if (status === "ok") {
    const receipt = { ...result, hits: Array.isArray(result.hits) ? result.hits : [] };
    if (receipt.freshness === "stale") {
      return { ...receipt, reason: "stale", fallback: FALLBACK_TEXT };
    }
    return receipt;
  }
  if (status === "unavailable") {
    if (reason === "unenrolled" || reason === "disabled") return { ...result, ...skipped(reason) };
    return { ...result, ...unavailable(reason ?? "unavailable") };
  }
  if (status === "failed") return { ...result, ...unavailable(reason ?? "failed") };
  return unavailable("failed");
}

function deadlineRemainingMs(record) {
  const startedAt = Date.parse(record?.started_at ?? "");
  const timeoutMs = record?.timeout_ms;
  if (
    !Number.isFinite(startedAt) ||
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return undefined;
  }
  return startedAt + timeoutMs - Date.now();
}

// min(15s, remaining caller budget minus the cleanup second). An unmanaged
// record without an assignment deadline keeps the default spec budget.
function queryBudgetMs(record, deps) {
  const remaining =
    typeof deps.remainingMs === "number" && Number.isFinite(deps.remainingMs)
      ? deps.remainingMs
      : deadlineRemainingMs(record);
  if (remaining === undefined) return DEFAULT_BUDGET_MS;
  return Math.max(0, Math.floor(Math.min(DEFAULT_BUDGET_MS, remaining - CLEANUP_RESERVE_MS)));
}

async function runSpecSearch(record, args, signal, deps) {
  try {
    if (!args || typeof args !== "object") {
      return unavailable("usage", "spec_search requires a query.");
    }
    if (args.root !== undefined) {
      return unavailable("root-not-allowed");
    }
    if (typeof args.query !== "string" || args.query.trim() === "") {
      return unavailable("usage", "spec_search requires a query.");
    }
    const client = await resolveClient(deps);
    if (!client || typeof client.searchRepository !== "function") {
      return unavailable("package-unavailable");
    }
    // The assignment deadline is absolute and preflight time counts against it:
    // compute the live remainder after client resolution, reserve the cleanup
    // second, and skip rather than start a worker the caller cannot own.
    const timeoutMs = queryBudgetMs(record, deps);
    if (timeoutMs < MIN_QUERY_BUDGET_MS) {
      return skipped("budget-exceeded");
    }
    const result = await client.searchRepository({
      root: record.checkout,
      query: args.query,
      mode: args.mode,
      limit: args.limit,
      stateRoot: args.state,
      timeoutMs,
      signal,
      usage: "spec",
    });
    return mapResult(result);
  } catch (error) {
    return unavailable("failed", error instanceof Error ? error.message : String(error));
  }
}

export function registerRepositorySearch(pi, record, deps = {}) {
  pi.registerTool({
    name: "spec_search",
    label: "Search repository",
    description:
      "Optional bounded semantic discovery over the owner's checkout using the optional local repo-search engine. Use one responsibility-style query for a genuine behavioral gap, then read candidate files before deciding. Never accepts a caller-supplied root; never installs, builds, refreshes or enrolls; empty or partial results are not absence. Exact literals, symbols and known files use rg/direct reads.",
    parameters: SPEC_SEARCH_PARAMETERS,
    async execute(_id, args, signal) {
      const value = await runSpecSearch(record, args, signal, deps);
      return toolResult(value, value.status === "unavailable" || value.status === "failed");
    },
  });
}
