#!/usr/bin/env node
// Serves a rendered visualize-journey collection over http://127.0.0.1 so cross-repo evidence
// links render instead of 404ing (plain static server) or refusing (file://).

import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const fail = (message) => {
  console.error(`visualize-journey: ${message}`);
  process.exit(1);
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".json": "application/json", ".pdf": "application/pdf",
};
// Anything else (.js, .md, ...) is text/plain so source evidence renders instead of downloading.
const contentTypeFor = (path) => CONTENT_TYPES[extname(path).toLowerCase()] ?? "text/plain; charset=utf-8";

// Strips a #fragment; returns null for a scheme'd (http:, mailto:, ...) or empty href.
const localHref = (href) => {
  if (typeof href !== "string" || href === "" || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const stripped = href.split("#")[0];
  return stripped === "" ? null : stripped;
};

// Every schema field that can hold a local path (references/operator-map-schema.md).
const manifestLocalHrefs = (m) => [
  m?.journey?.source,
  ...(m?.behaviorEvidence?.sources ?? []).map((s) => s?.href),
  ...(m?.steps ?? []).flatMap((s) => [
    s?.visual?.status === "captured" ? s.visual.src : null,
    ...(s?.issues ?? []).map((i) => i?.href),
    ...(s?.evidence ?? []).map((e) => e?.href),
  ]),
].filter(Boolean);

const commonAncestor = (a, b) => {
  const as = a.split(sep).filter(Boolean);
  const bs = b.split(sep).filter(Boolean);
  const common = [];
  for (let i = 0; i < Math.min(as.length, bs.length) && as[i] === bs[i]; i += 1) common.push(as[i]);
  return "/" + common.join(sep);
};

// Deepest common ancestor of the collection dir and every local href its manifests carry. Never
// lets that ancestor rise to "/" or the user's home directory; names the offending link.
export const computeRoot = (collectionDir) => {
  const home = resolve(homedir());
  let root = resolve(collectionDir);
  const guard = (dir, offender) => {
    const candidate = commonAncestor(root, dir);
    if (candidate === "/" || candidate === home) {
      throw new Error(`collection root would climb to ${candidate === home ? "the home directory" : "/"} because of ${offender}`);
    }
    root = candidate;
  };
  guard(root, `the collection directory itself (${root})`);
  for (const entry of readdirSync(collectionDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(collectionDir, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const href of manifestLocalHrefs(manifest)) {
      const stripped = localHref(href);
      if (!stripped) continue;
      guard(dirname(resolve(dirname(manifestPath), stripped)), `"${href}" in ${manifestPath}`);
    }
  }
  return root;
};

const withinRoot = (root, p) => p === root || p.startsWith(root + sep);

// realpath follows every symlink in the chain, including intermediate segments, so an escape
// anywhere in the path 403s. Directories serve index.html or 404; there is no listing.
const resolveFile = (root, target) => {
  if (!withinRoot(root, target)) return { status: 403 };
  let real;
  try {
    real = realpathSync(target);
  } catch {
    return { status: 404 };
  }
  if (!withinRoot(root, real)) return { status: 403 };
  const stat = statSync(real);
  if (stat.isDirectory()) return resolveFile(root, join(target, "index.html"));
  return stat.isFile() ? { status: 200, file: real, type: contentTypeFor(real) } : { status: 404 };
};

// Request path -> { status } or { status: 200, file, type }. Rejects any ".."/dot/node_modules
// segment before touching the filesystem (covers /../, /%2e%2e/, /.env, /.git, /node_modules).
export const resolveRequestPath = (root, rawPath) => {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath.split("?")[0]);
  } catch {
    return { status: 400 };
  }
  const parts = decoded.split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p === "." || p.startsWith(".") || p === "node_modules")) return { status: 403 };
  // Resolve root itself through any symlink (e.g. macOS /var -> /private/var) so it compares
  // consistently with the fully realpath'd target below.
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { status: 404 };
  }
  return resolveFile(realRoot, join(realRoot, ...parts));
};

// DNS-rebinding guard: only accept a Host header that names this server by IP or localhost.
export const isAllowedHost = (hostHeader, port) =>
  new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(String(hostHeader ?? "").trim().toLowerCase());

const STATUS_TEXT = { 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed" };

const main = () => {
  const argv = process.argv.slice(2);
  const positional = [];
  let port = 4173;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") {
      const value = argv[i + 1];
      if (!value || Number.isNaN(Number(value))) fail("--port requires a number");
      port = Number(value);
      i += 1;
      continue;
    }
    positional.push(argv[i]);
  }
  if (positional.length !== 1) fail("usage: node serve-journeys.mjs <collection-dir> [--port <n>]");

  const collectionDir = resolve(positional[0]);
  if (!existsSync(collectionDir)) fail(`collection dir does not exist: ${collectionDir}`);
  const hasCanvas = existsSync(join(collectionDir, "canvas.html"));
  const hasIndex = existsSync(join(collectionDir, "index.html"));
  if (!hasCanvas && !hasIndex) {
    fail(`no canvas.html or index.html in ${collectionDir} — render the collection first:\n` +
      `  node ~/.agents/skills/visualize-journey/scripts/render-journey-map.mjs --collection ${collectionDir} --output ${join(collectionDir, "index.html")}`);
  }

  let root;
  try {
    root = realpathSync(computeRoot(collectionDir));
  } catch (error) {
    fail(error.message);
  }

  const homePagePath = join(collectionDir, hasCanvas ? "canvas.html" : "index.html");
  const homePageUrlPath = "/" + relative(root, homePagePath).split(sep).join("/");
  const listUrlPath = hasIndex ? "/" + relative(root, join(collectionDir, "index.html")).split(sep).join("/") : null;

  const server = createServer((req, res) => {
    const headers = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
    const send = (status, type, body) => {
      res.writeHead(status, { ...headers, "Content-Type": type });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain; charset=utf-8", STATUS_TEXT[405]);
    if (!isAllowedHost(req.headers.host, port)) return send(403, "text/plain; charset=utf-8", "Forbidden host");
    if (req.url === "/") {
      res.writeHead(302, { ...headers, Location: homePageUrlPath });
      return res.end();
    }
    const result = resolveRequestPath(root, req.url);
    if (result.status !== 200) return send(result.status, "text/plain; charset=utf-8", STATUS_TEXT[result.status] ?? "");
    if (result.type === "image/svg+xml") headers["Content-Security-Policy"] = "sandbox";
    send(200, result.type, readFileSync(result.file));
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") fail(`port ${port} is already in use — pick another with --port <n>`);
    throw error;
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Serving ${root}`);
    console.log(`Canvas: http://127.0.0.1:${port}${homePageUrlPath}`);
    if (listUrlPath) console.log(`List:   http://127.0.0.1:${port}${listUrlPath}`);
    console.log("Press Ctrl-C to stop.");
  });
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
