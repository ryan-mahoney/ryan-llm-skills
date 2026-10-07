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
const MAX_RESPONSE_BYTES = 8192;
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

function compactHit(hit) {
  return {
    path: hit?.path,
    startLine: hit?.startLine,
    endLine: hit?.endLine,
    symbol: hit?.symbol ?? "",
    score: hit?.score ?? 0,
    excerpt: typeof hit?.excerpt === "string" ? hit.excerpt.slice(0, 240) : undefined,
  };
}

function boundResponse(value) {
  if (JSON.stringify(value).length <= MAX_RESPONSE_BYTES) return value;
  const hits = Array.isArray(value.hits) ? value.hits.slice(0, 10) : [];
  return { ...value, hits, truncated: true };
}

function mapResult(result) {
  const status = result?.status;
  const reason = result?.reason;
  if (status === "ok") {
    return boundResponse({
      status: "ok",
      hits: Array.isArray(result.hits) ? result.hits.slice(0, 20).map(compactHit) : [],
      coverage: result.coverage ?? {},
      generationId: result.generationId,
      observedHead: result.observedHead ?? null,
    });
  }
  if (status === "unavailable") {
    if (reason === "unenrolled" || reason === "disabled") return skipped(reason);
    return unavailable(reason ?? "unavailable");
  }
  if (status === "failed") return unavailable(reason ?? "failed");
  return unavailable("failed");
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
    const remaining =
      typeof deps.remainingMs === "number" ? deps.remainingMs : DEFAULT_BUDGET_MS;
    const timeoutMs = Math.max(0, Math.min(DEFAULT_BUDGET_MS, remaining));
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
