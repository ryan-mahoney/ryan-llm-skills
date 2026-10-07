// Bounded public search response formatter (Node standard library only).
//
// Accepts either a flat search receipt or the worker's nested response
// (`{...identity, receipt:{...}}`), never emits a query key, and returns JSON or
// human text within a byte budget by shortening excerpts and dropping whole
// trailing hits (incrementing coverage.omittedHits) before falling back to a
// parseable output-budget response when mandatory scope cannot fit.

const DEFAULT_MAX_BYTES = 4096;

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

function safeMaxBytes(maxBytes) {
  return Number.isInteger(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, DEFAULT_MAX_BYTES)
    : DEFAULT_MAX_BYTES;
}

function shortenText(value, maxCodePoints) {
  const points = [...value];
  if (points.length <= maxCodePoints) return value;
  return `${points.slice(0, maxCodePoints).join("")}\u2026`;
}

function normalizeHit(hit) {
  const record = hit && typeof hit === "object" && !Array.isArray(hit) ? hit : {};
  return {
    path: typeof record.path === "string" ? record.path : "",
    startLine: Number.isInteger(record.startLine) ? record.startLine : 1,
    endLine: Number.isInteger(record.endLine) ? record.endLine : 1,
    symbol: typeof record.symbol === "string" ? record.symbol : "",
    score: typeof record.score === "number" ? record.score : 0,
    fileHash: typeof record.fileHash === "string" ? record.fileHash : "",
    excerpt: typeof record.excerpt === "string" ? record.excerpt : "",
  };
}

function normalizeSearchResponse(response) {
  const outer = response && typeof response === "object" && !Array.isArray(response) ? response : {};
  const nested =
    outer.receipt && typeof outer.receipt === "object" && !Array.isArray(outer.receipt)
      ? outer.receipt
      : {};
  const merged = { ...outer, ...nested };
  const coverage =
    merged.coverage && typeof merged.coverage === "object" && !Array.isArray(merged.coverage)
      ? { ...merged.coverage }
      : {};
  const timing =
    merged.timing && typeof merged.timing === "object" && !Array.isArray(merged.timing)
      ? { ...merged.timing }
      : {};
  return {
    version: merged.version ?? 1,
    command: merged.command ?? "search",
    status: merged.status ?? "ok",
    reason: merged.reason,
    availability: typeof merged.availability === "string" ? merged.availability : undefined,
    freshness: typeof merged.freshness === "string" ? merged.freshness : undefined,
    operation: typeof merged.operation === "string" ? merged.operation : undefined,
    mode: typeof merged.mode === "string" ? merged.mode : undefined,
    repoKey: typeof merged.repoKey === "string" ? merged.repoKey : undefined,
    checkoutKey: typeof merged.checkoutKey === "string" ? merged.checkoutKey : undefined,
    requestedRoot: typeof merged.requestedRoot === "string" ? merged.requestedRoot : undefined,
    actualRoot: typeof merged.actualRoot === "string" ? merged.actualRoot : undefined,
    observedHead: merged.observedHead ?? null,
    generationId: typeof merged.generationId === "string" ? merged.generationId : undefined,
    baseId: merged.baseId ?? null,
    coverage,
    timing,
    hits: Array.isArray(merged.hits) ? merged.hits.map(normalizeHit) : [],
  };
}

function serializeSearch(result, coverage, omitted, hits) {
  return JSON.stringify({
    version: result.version,
    command: result.command,
    status: result.status,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.availability !== undefined ? { availability: result.availability } : {}),
    ...(result.freshness !== undefined ? { freshness: result.freshness } : {}),
    ...(result.operation !== undefined ? { operation: result.operation } : {}),
    ...(result.mode !== undefined ? { mode: result.mode } : {}),
    repoKey: result.repoKey,
    checkoutKey: result.checkoutKey,
    requestedRoot: result.requestedRoot,
    actualRoot: result.actualRoot,
    observedHead: result.observedHead,
    generationId: result.generationId,
    baseId: result.baseId,
    coverage: { ...coverage, omittedHits: omitted },
    timing: result.timing,
    hits,
  });
}

function fitSearchResponse(result, maxBytes) {
  const coverage = { ...result.coverage };
  let omitted = Number.isInteger(coverage.omittedHits) ? coverage.omittedHits : 0;
  const hits = result.hits.map((hit) => ({ ...hit }));

  // 1. Unicode-safely shorten optional excerpt/text only (never hit paths).
  for (const hit of hits) {
    hit.excerpt = shortenText(hit.excerpt, 240);
  }
  let text = serializeSearch(result, coverage, omitted, hits);
  if (byteLength(text) <= maxBytes) return JSON.parse(text);

  // 2. Drop whole trailing hits, counting each omission.
  while (hits.length > 0 && byteLength(text) > maxBytes) {
    hits.pop();
    omitted += 1;
    text = serializeSearch(result, coverage, omitted, hits);
  }
  if (byteLength(text) <= maxBytes) return JSON.parse(text);

  // 3. Shorten excerpts aggressively, then drop whole hits again. Exact hit
  // paths are never truncated or altered.
  for (const hit of hits) {
    hit.excerpt = shortenText(hit.excerpt, 80);
  }
  text = serializeSearch(result, coverage, omitted, hits);
  while (hits.length > 0 && byteLength(text) > maxBytes) {
    hits.pop();
    omitted += 1;
    text = serializeSearch(result, coverage, omitted, hits);
  }
  if (byteLength(text) <= maxBytes) return JSON.parse(text);

  // 4. Mandatory scope cannot fit: bounded parseable fallback (<=4096 bytes).
  return {
    version: 1,
    command: "search",
    status: "unavailable",
    reason: "output-budget",
    repoKey: result.repoKey,
    checkoutKey: result.checkoutKey,
    scopeOmitted: true,
  };
}

export function formatSearchJson(response, options = {}) {
  const maxBytes = safeMaxBytes(options.maxBytes);
  const result = fitSearchResponse(normalizeSearchResponse(response), maxBytes);
  return JSON.stringify(result);
}

function escapeControl(value) {
  return String(value)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/[\u0000-\u001f\u007f]/g, (character) =>
      `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
}

export function formatSearchHuman(response, options = {}) {
  const maxBytes = safeMaxBytes(options.maxBytes);
  const result = fitSearchResponse(normalizeSearchResponse(response), maxBytes);
  const lines = [`status: ${escapeControl(result.status)}`];
  if (result.reason !== undefined) lines.push(`reason: ${escapeControl(result.reason)}`);
  if (result.availability) lines.push(`availability: ${escapeControl(result.availability)}`);
  if (result.freshness) lines.push(`freshness: ${escapeControl(result.freshness)}`);
  if (result.operation) lines.push(`operation: ${escapeControl(result.operation)}`);
  if (result.mode) lines.push(`mode: ${escapeControl(result.mode)}`);
  if (result.repoKey) lines.push(`repoKey: ${escapeControl(result.repoKey)}`);
  if (result.checkoutKey) lines.push(`checkoutKey: ${escapeControl(result.checkoutKey)}`);
  if (result.generationId) lines.push(`generation: ${escapeControl(result.generationId)}`);
  if (result.baseId) lines.push(`base: ${escapeControl(result.baseId)}`);
  if (result.coverage) {
    lines.push(
      `coverage: ${escapeControl(result.coverage.completeness ?? "unknown")} omitted=${result.coverage.omittedHits ?? 0}`,
    );
  }
  for (const hit of result.hits ?? []) {
    lines.push(`${escapeControl(hit.path)}:${hit.startLine}-${hit.endLine}`);
    if (hit.excerpt) lines.push(escapeControl(hit.excerpt));
  }
  if (result.scopeOmitted) lines.push("scopeOmitted: true");

  let text = `${lines.join("\n")}\n`;
  while (byteLength(text) > maxBytes && lines.length > 1) {
    lines.pop();
    text = `${lines.join("\n")}\n`;
  }
  return text;
}
