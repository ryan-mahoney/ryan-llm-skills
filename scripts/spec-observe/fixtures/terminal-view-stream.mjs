#!/usr/bin/env node
// Test-owned asciinema substitute for the focused terminal-view tests.
//
// The manager's argv is ignored. This script serves the two player asset
// aliases and a raw WebSocket echo over a loopback HTTP listener, prints the
// readiness announcement, and logs start/argv/TERM/exit plus asset/upgrade
// observations to TERMINAL_VIEW_LOG as JSON lines. TERMINAL_VIEW_MODE covers
// readiness splitting, malformed or foreign announcements, missing readiness,
// early exit and TERM delay/ignore; TERMINAL_VIEW_ASSET_DELAY_MS keeps an
// asset body open so the tests can observe stop/abort propagation.

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const logPath = process.env.TERMINAL_VIEW_LOG ?? null;
const mode = process.env.TERMINAL_VIEW_MODE ?? "ready";
const assetDelayMs = Number(process.env.TERMINAL_VIEW_ASSET_DELAY_MS ?? 0);
const termDelayMs = Number(process.env.TERMINAL_VIEW_TERM_DELAY_MS ?? 150);
const exitAfterMs = Number(process.env.TERMINAL_VIEW_EXIT_AFTER_MS ?? 0);

const event = (name, detail = {}) => {
  if (logPath === null) return;
  try {
    appendFileSync(logPath, `${JSON.stringify({ event: name, pid: process.pid, ...detail })}\n`);
  } catch {
    // The log is the test's oracle; a write failure only weakens that oracle.
  }
};

event("start", {
  argv: process.argv.slice(2),
  env: { TERM: process.env.TERM ?? null, TERMINAL_VIEW_MODE: mode },
});
process.on("exit", (code) => event("exit", { code }));
process.on("SIGTERM", () => {
  event("term", { signal: "SIGTERM" });
  if (mode === "ignore-term") return;
  if (mode === "delayed-term") {
    setTimeout(() => process.exit(0), termDelayMs);
    return;
  }
  process.exit(0);
});

if (mode === "exit") process.exit(3);

const server = createServer((request, response) => {
  event("asset", { path: request.url, method: request.method });
  const body = request.url === "/asciinema-player.min.js"
    ? "globalThis.__terminalViewFixture = 'player';\n"
    : request.url === "/asciinema-player.css"
      ? "body { color: #123456; }\n"
      : null;
  if (body === null) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  const contentType = request.url.endsWith(".css")
    ? "text/css; charset=utf-8"
    : "text/javascript; charset=utf-8";
  response.writeHead(200, { "Content-Type": contentType });
  if (assetDelayMs > 0) {
    response.write(body.slice(0, 4));
    setTimeout(() => response.end(body.slice(4)), assetDelayMs);
  } else {
    response.end(body);
  }
  response.on("close", () => {
    event("asset-close", { path: request.url, ended: response.writableEnded });
  });
});

server.on("upgrade", (request, socket, head) => {
  event("upgrade", {
    path: request.url,
    headLength: head.length,
    protocol: request.headers["sec-websocket-protocol"] ?? null,
    origin: request.headers.origin ?? null,
    host: request.headers.host ?? null,
  });
  const key = request.headers["sec-websocket-key"] ?? "";
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  const protocol = request.headers["sec-websocket-protocol"]
    ? `Sec-WebSocket-Protocol: ${request.headers["sec-websocket-protocol"]}\r\n`
    : "";
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    protocol +
    "\r\n",
  );
  if (head.length > 0) socket.write(head);
  socket.on("data", (chunk) => socket.write(chunk));
  socket.on("error", () => {});
});

server.on("error", (error) => event("server-error", { message: error.message }));

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const line = `::: Live streaming at http://127.0.0.1:${port}`;
  event("listening", { port });
  if (mode === "none") {
    // Readiness is intentionally never announced.
  } else if (mode === "split") {
    process.stdout.write(line.slice(0, 12));
    setTimeout(() => process.stdout.write(`${line.slice(12)}\n`), 25);
  } else if (mode === "malformed") {
    process.stdout.write(`${line}?stale=1\n`);
  } else if (mode === "foreign") {
    process.stdout.write(`::: Live streaming at http://0.0.0.0:${port}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
  if (mode === "closed-upstream") server.close();
  if (exitAfterMs > 0) setTimeout(() => process.exit(0), exitAfterMs);
});
