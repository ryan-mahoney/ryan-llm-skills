// Step 7 focused tests: HTTP authorization, mapping, the real service
// boundary and the bounded SSE stream for the local /api/threads and
// /api/thread/* routes. Step 4 EV-6 adds the direct /api/dispatch/* surface:
// real save/preview/launch over local and operator HTTP, dispatch
// authorization and the fixed dispatch refusal serialization.
//
// Every fixture root is realpath(mkdtemp(tmpdir())) with the canonical
// setupStorage/createWorkspace owners. The TCP peer stays loopback while the
// wire Host/Origin are test-controlled, so the configured public host and
// remote classification can be exercised without a provider, real store or
// tmux. Requests use node:http (not fetch) with explicit socket deadlines and
// destroy-on-cleanup semantics. Only authorization and method mapping use a
// spy service; the real fixtures drive createDiscussionService for
// create/list/history/save-brief, one idle stop and the SSE snapshot, never
// resume or send.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { newPackage } from "../spec-location/index.mjs";
import { createDashboardServer } from "../spec-observe/dashboard.mjs";
import { createDiscussionService } from "./discussion.mjs";
import { createDiscussionRoutes } from "./discussion-routes.mjs";
import { createWorkspace, setupStorage } from "./store.mjs";

const PUBLIC_HOST = "host.example.ts.net";
const DISPATCH_SKILL = "spec-architect-initial";
const THREAD_ID = "3f1c9a6e-2b1d-4f5a-8c7e-9d0b1a2c3d4e";
const MESSAGE_ID = "7b2e4d08-1a3c-4e6f-9b5d-8c0a2e4f6d1b";
const REQUEST_ID = "5c8f0a2e-4d6b-4a1c-9e3f-7d5b0a2c4e6f";
const ASSIGNMENT_ID = "9e1d3c5b-7a2f-4b6d-8c0e-4f2a6b8d0c1e";
const DIGEST = "a".repeat(64);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOCKET_DEADLINE_MS = 2000;
const MESSAGE_BODY_LIMIT = 64 * 1024;
const DEFAULT_BODY_LIMIT = 8 * 1024;
const STREAM_BYTES_LIMIT = 256 * 1024;

const POST_PATHS = [
  "/api/thread/create",
  "/api/thread/send",
  "/api/thread/stop",
  "/api/thread/resume",
  "/api/thread/discard",
  "/api/thread/save-brief",
  "/api/thread/preview-assignment",
  "/api/thread/launch-assignment",
];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "discussion-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, storageRoot: join(realpathSync(dir), "storage") };
}

async function fixtureStorage(t) {
  const f = fixture(t);
  await setupStorage(f.storageRoot);
  await createWorkspace(f.storageRoot, { id: "fixture" });
  return f;
}

// Records every service call. Authorization refusals and body limits must
// return before any method runs; mapping cases assert the exact payload.
function serviceSpy() {
  const calls = [];
  const spy = { calls };
  for (const name of ["create", "list", "history", "suggestions", "send", "stop", "resume", "discard", "saveBrief", "previewAssignment", "launchAssignment", "subscribe", "dispatchSaveBrief", "dispatchPreview", "dispatchLaunch", "dispatchSuggestions"]) {
    spy[name] = (...args) => {
      calls.push({ name, args });
      return name === "subscribe" ? () => {} : Promise.resolve([]);
    };
  }
  return spy;
}

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

// Bounded node:http helper. `headersOnly` flushes the declared headers without
// uploading any body bytes, so a pre-body refusal must answer within the
// socket deadline; a route that waits for the body times out and fails.
function httpCall(port, path, {
  host = `127.0.0.1:${port}`,
  origin,
  method = "GET",
  headers = {},
  body,
  headersOnly = false,
  deadline = SOCKET_DEADLINE_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    let deadlineTimer;
    let uploaded = 0;
    const settle = (action) => {
      clearTimeout(deadlineTimer);
      action();
    };
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method,
      agent: false,
      headers: {
        ...(host !== undefined ? { host } : {}),
        ...(origin !== undefined ? { origin } : {}),
        ...headers,
      },
    }, incoming => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("error", (error) => settle(() => reject(error)));
      incoming.on("end", () => settle(() => {
        if (headersOnly) outgoing.destroy();
        resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8"), uploaded });
      }));
    });
    outgoing.on("error", (error) => settle(() => reject(error)));
    deadlineTimer = setTimeout(() => outgoing.destroy(new Error(`HTTP deadline exceeded: ${method} ${path}`)), deadline);
    if (headersOnly) outgoing.flushHeaders();
    else if (typeof body === "string" || Buffer.isBuffer(body)) {
      uploaded = Buffer.byteLength(body);
      outgoing.end(body);
    } else outgoing.end();
  });
}

async function actionToken(port) {
  const state = await httpCall(port, "/api/state");
  assert.equal(state.status, 200);
  const token = JSON.parse(state.body).action_token;
  assert.equal(typeof token, "string");
  assert.ok(token.length > 0, "the local dashboard exposes its action token");
  return token;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, waitMs = 2000) {
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(10);
  }
  assert.ok(predicate(), label);
}

// Opens a real SSE connection, collects parsed event frames and exposes a
// bounded waitFor. The caller always closes the handle before the next step.
function openSse(port, path, { deadline = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, path, agent: false }, incoming => {
      const state = { status: incoming.statusCode, headers: incoming.headers, events: [] };
      let buffer = "";
      let closed = false;
      const deadlineTimer = setTimeout(() => {
        if (closed) return;
        closed = true;
        outgoing.destroy();
        reject(new Error(`SSE deadline exceeded: ${path}`));
      }, deadline);
      state.close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(deadlineTimer);
        outgoing.destroy();
        incoming.destroy();
      };
      state.waitFor = async (predicate, waitMs = deadline) => {
        const end = Date.now() + waitMs;
        for (;;) {
          const found = state.events.find(predicate);
          if (found) return found;
          if (closed || Date.now() > end) throw new Error(`SSE event deadline exceeded: ${path}`);
          await delay(10);
        }
      };
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (block.startsWith(":") || block === "") continue;
          const lines = block.split("\n");
          const eventLine = lines.find((line) => line.startsWith("event:"));
          const dataLine = lines.find((line) => line.startsWith("data:"));
          if (eventLine && dataLine) {
            state.events.push({ event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) });
          }
        }
      });
      resolve(state);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

const sseUrl = () => new URL(`/api/thread/events?${new URLSearchParams({ workspace_id: "fixture", thread_id: THREAD_ID })}`, "http://127.0.0.1:4319");

const sseEnvelope = (type, event, overrides = {}) => ({
  workspace_id: "fixture",
  thread_id: THREAD_ID,
  generation: "gen-1",
  type,
  event,
  ...overrides,
});

function fakeSseRequest(extra = {}) {
  const request = new EventEmitter();
  request.method = "GET";
  return Object.assign(request, extra);
}

function fakeSseResponse() {
  const response = new EventEmitter();
  response.status = null;
  response.headers = null;
  response.headersSent = false;
  response.ended = false;
  response.destroyed = false;
  response.acceptWrites = true;
  response.chunks = [];
  response.writableLength = 0;
  response.setHeader = () => {};
  response.writeHead = (status, headers) => {
    response.status = status;
    response.headers = headers;
    response.headersSent = true;
  };
  response.write = (text) => {
    response.chunks.push(text);
    return response.acceptWrites;
  };
  response.end = (body) => {
    response.ended = true;
    response.endBody = body;
  };
  response.destroy = () => {
    response.destroyed = true;
  };
  return response;
}

// Controlled service for deterministic SSE tests: a summary list, one leaf
// history, and a captured listener that can be fed arbitrary envelopes. Each
// list call resolves a fresh projection so later mutations to `summary` only
// model events that arrive after the read, exactly like the real service.
function controlledDiscussion({ deferFirstList = false, deferFirstHistory = false } = {}) {
  const listeners = new Set();
  let unsubscribes = 0;
  let listCalls = 0;
  let historyCalls = 0;
  let resolveFirstList = null;
  let resolveFirstHistory = null;
  const summary = {
    thread_id: THREAD_ID,
    generation: "gen-1",
    state: "idle",
    queue: [],
    partial: "",
    attention: null,
  };
  const branch = { header: null, entries: [], leaf_id: "leaf-1", incomplete_tail: false, skipped_lines: 0, truncated: false };
  const project = () => ({ threads: [{ ...summary }], invalid: [] });
  const service = {
    list: () => {
      listCalls += 1;
      if (deferFirstList && listCalls === 1) return new Promise((resolve) => { resolveFirstList = resolve; });
      return Promise.resolve(project());
    },
    history: () => {
      historyCalls += 1;
      if (deferFirstHistory && historyCalls === 1) return new Promise((resolve) => { resolveFirstHistory = resolve; });
      return Promise.resolve({ ...branch });
    },
    subscribe: ({ workspace_id, thread_id }, listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribes += 1;
      };
    },
  };
  return {
    service,
    summary,
    listeners,
    emit: (payload) => {
      for (const listener of [...listeners]) listener(payload);
    },
    unsubscribes: () => unsubscribes,
    listCalls: () => listCalls,
    historyCalls: () => historyCalls,
    resolveFirstList: () => resolveFirstList?.(project()),
    resolveFirstHistory: () => resolveFirstHistory?.({ ...branch }),
  };
}

test("thread routes answer 503 locally when no discussion service is composed", async (t) => {
  const f = await fixtureStorage(t);
  const server = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot });
  const port = await listen(t, server);
  const response = await httpCall(port, `/api/threads?${new URLSearchParams({ workspace_id: "fixture" })}`);
  assert.equal(response.status, 503, "a local request without discussion must be unavailable, not authorized");
});

test("unconfigured remote requests are refused for every thread route before the service runs", async (t) => {
  const f = await fixtureStorage(t);
  const spy = serviceSpy();
  const server = createDashboardServer({
    agentDir: f.dir,
    publicHost: PUBLIC_HOST,
    storageRoot: f.storageRoot,
    discussion: spy,
  });
  const port = await listen(t, server);

  const threadQuery = new URLSearchParams({ workspace_id: "fixture", thread_id: THREAD_ID }).toString();
  const paths = [
    { label: "list", path: `/api/threads?${new URLSearchParams({ workspace_id: "fixture" })}` },
    { label: "history", path: `/api/thread/history?${threadQuery}` },
    { label: "events", path: `/api/thread/events?${threadQuery}` },
    { label: "suggestions", path: `/api/thread/suggestions?${threadQuery}&kind=file&query=readme` },
    ...POST_PATHS.map((path) => ({ label: path, path, write: true })),
    { label: "unknown", path: "/api/thread/bogus" },
  ];
  // A forwarding or identity header alone never grants operator access.
  const variants = [
    { label: "unconfigured Host", options: { host: "other.example.ts.net" } },
    { label: "forwarded loopback Host", options: { headers: { "x-forwarded-for": "" } } },
    { label: "empty tailscale identity", options: { headers: { "tailscale-user-login": "" } } },
  ];

  for (const variant of variants) {
    for (const entry of paths) {
      const response = await httpCall(port, entry.path, entry.write === true
        ? {
          method: "POST",
          headersOnly: true,
          ...variant.options,
          ...(variant.options.host === undefined ? {} : { origin: `https://${PUBLIC_HOST}` }),
          headers: {
            "content-type": "application/json",
            "content-length": String(MESSAGE_BODY_LIMIT + 1),
            ...(variant.options.headers ?? {}),
          },
        }
        : variant.options);
      assert.equal(response.status, 403, `${variant.label} ${entry.label}`);
    }
  }
  assert.deepEqual(spy.calls.map((call) => call.name), [], "no remote request may reach the service");
});

test("oversized remote POST /api/thread/send returns 403 before any body bytes are uploaded", async (t) => {
  const f = await fixtureStorage(t);
  const spy = serviceSpy();
  const server = createDashboardServer({
    agentDir: f.dir,
    publicHost: PUBLIC_HOST,
    storageRoot: f.storageRoot,
    discussion: spy,
  });
  const port = await listen(t, server);

  const oversizedHeaders = {
    "content-type": "application/json",
    "content-length": String(MESSAGE_BODY_LIMIT + 1),
  };
  // Even the configured public host must supply a valid action token before
  // the route consumes a body; forwarding markers alone remain insufficient.
  const variants = [
    { label: "configured public Host", options: { host: PUBLIC_HOST, origin: `https://${PUBLIC_HOST}` } },
    { label: "configured public Host :443", options: { host: `${PUBLIC_HOST}:443`, origin: `https://${PUBLIC_HOST}` } },
    { label: "forwarded loopback Host", options: { headers: { "x-forwarded-for": "" } } },
    { label: "empty tailscale identity", options: { headers: { "tailscale-user-login": "" } } },
  ];

  for (const variant of variants) {
    const response = await httpCall(port, "/api/thread/send", {
      method: "POST",
      headersOnly: true,
      ...variant.options,
      headers: { ...oversizedHeaders, ...(variant.options.headers ?? {}) },
    });
    assert.equal(response.status, 403, variant.label);
    assert.equal(response.uploaded, 0, `${variant.label}: no body bytes may be uploaded`);
  }
  assert.deepEqual(spy.calls.map((call) => call.name), [], "send must not run for unauthorized requests");
});

for (const endpoint of ["local", "tailnet"]) {
// Run alone: node --test --test-name-pattern="tailnet writes refuse" scripts/workspaces/discussion-routes.test.mjs
test(`${endpoint} writes refuse before the service or the body when Origin, token or content type is wrong`, async (t) => {
  const f = await fixtureStorage(t);
  const spy = serviceSpy();
  const server = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot, discussion: spy, publicHost: PUBLIC_HOST });
  const port = await listen(t, server);
  const host = endpoint === "tailnet" ? PUBLIC_HOST : `127.0.0.1:${port}`;
  const origin = endpoint === "tailnet" ? `https://${PUBLIC_HOST}` : `http://${host}`;
  const state = JSON.parse((await httpCall(port, "/api/state", { host })).body);
  const token = state.thread_action_token ?? state.action_token;
  const wrongToken = "0".repeat(64);

  // Origin and content-type cases carry the real token so only the named guard
  // can refuse them; missing and wrong tokens stay distinct cases underneath.
  const refusals = [
    { label: "missing Origin", origin: undefined, token, contentType: "application/json" },
    { label: "loopback alias Origin", origin: `http://localhost:${port}`, token, contentType: "application/json" },
    { label: "missing token", origin, token: undefined, contentType: "application/json" },
    { label: "wrong token", origin, token: wrongToken, contentType: "application/json" },
    { label: "wrong content type", origin, token, contentType: "text/plain" },
  ];

  for (const refusal of refusals) {
    const response = await httpCall(port, "/api/thread/send", {
      method: "POST",
      host,
      origin: refusal.origin,
      headersOnly: true,
      headers: {
        "content-type": refusal.contentType,
        "content-length": String(MESSAGE_BODY_LIMIT + 1),
        ...(refusal.token === undefined ? {} : { "x-sentinel-token": refusal.token }),
      },
    });
    assert.equal(response.status, 403, refusal.label);
    assert.equal(response.uploaded, 0, `${refusal.label}: the body must not be uploaded`);
  }
  assert.deepEqual(spy.calls.map((call) => call.name), [], "no authorization refusal may reach the service");
});
}

for (const endpoint of ["local", "tailnet"]) {
// Run alone: node --test --test-name-pattern="authorized tailnet writes" scripts/workspaces/discussion-routes.test.mjs
test(`authorized ${endpoint} writes map one-to-one onto service methods with unchanged payloads`, async (t) => {
  const f = await fixtureStorage(t);
  const spy = serviceSpy();
  const server = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot, discussion: spy, publicHost: PUBLIC_HOST });
  const port = await listen(t, server);
  const host = endpoint === "tailnet" ? `${PUBLIC_HOST}:443` : `127.0.0.1:${port}`;
  const origin = endpoint === "tailnet" ? `https://${PUBLIC_HOST}` : `http://${host}`;
  const state = JSON.parse((await httpCall(port, "/api/state", { host, headers: { "x-forwarded-for": "100.64.0.1" } })).body);
  const token = endpoint === "tailnet" ? state.thread_action_token : await actionToken(port);
  assert.match(token, /^[a-f0-9]{64}$/);
  if (endpoint === "tailnet") assert.equal(state.action_token, undefined, "completion remains local-only");

  const payloads = [
    ["/api/thread/create", { workspace_id: "fixture", title: "Created over HTTP", target: { kind: "workspace" } }],
    ["/api/thread/send", { workspace_id: "fixture", thread_id: THREAD_ID, id: MESSAGE_ID, text: "hello" }],
    ["/api/thread/stop", { workspace_id: "fixture", thread_id: THREAD_ID }],
    ["/api/thread/resume", { workspace_id: "fixture", thread_id: THREAD_ID }],
    ["/api/thread/discard", { workspace_id: "fixture", thread_id: THREAD_ID, id: MESSAGE_ID, resend: true }],
    ["/api/thread/save-brief", { workspace_id: "fixture", thread_id: THREAD_ID, request_id: REQUEST_ID, title: "Brief", content: "# Body" }],
    ["/api/thread/preview-assignment", { workspace_id: "fixture", thread_id: THREAD_ID, request_id: REQUEST_ID, assignment_id: ASSIGNMENT_ID, instructions: "do the work" }],
    ["/api/thread/launch-assignment", { workspace_id: "fixture", thread_id: THREAD_ID, request_id: REQUEST_ID, assignment_id: ASSIGNMENT_ID, instructions: "do the work", expectedDigest: DIGEST }],
  ];
  const expectedMethods = ["create", "send", "stop", "resume", "discard", "saveBrief", "previewAssignment", "launchAssignment"];

  for (const [path, payload] of payloads) {
    const response = await httpCall(port, path, {
      method: "POST",
      host,
      origin,
      headers: { "x-sentinel-token": token, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200, path);
  }
  assert.deepEqual(spy.calls.map((call) => call.name), expectedMethods);
  payloads.forEach(([, payload], index) => {
    assert.deepEqual(spy.calls[index].args, [payload], `payload for ${payloads[index][0]} must pass through unchanged`);
  });
});
}

test("authorized local writes reject malformed and non-object JSON with 400", async (t) => {
  const f = await fixtureStorage(t);
  const spy = serviceSpy();
  const server = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot, discussion: spy });
  const port = await listen(t, server);
  const token = await actionToken(port);
  const origin = `http://127.0.0.1:${port}`;

  for (const body of ["{", "", "[1]", "null", "42", "\"text\""]) {
    const response = await httpCall(port, "/api/thread/send", {
      method: "POST",
      origin,
      headers: { "x-sentinel-token": token, "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(spy.calls.map((call) => call.name), []);
});

test("declared and chunked bodies over the 64 KiB and 8 KiB caps return 413", async (t) => {
  const f = await fixtureStorage(t);
  const spy = serviceSpy();
  const server = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot, discussion: spy });
  const port = await listen(t, server);
  const token = await actionToken(port);
  const origin = `http://127.0.0.1:${port}`;
  const authorized = (extra = {}) => ({
    method: "POST",
    origin,
    headers: { "x-sentinel-token": token, "content-type": "application/json", ...extra },
  });

  const declaredMessage = await httpCall(port, "/api/thread/send", {
    ...authorized({ "content-length": String(MESSAGE_BODY_LIMIT + 1) }),
    headersOnly: true,
  });
  assert.equal(declaredMessage.status, 413);
  assert.equal(declaredMessage.uploaded, 0);

  const declaredSmall = await httpCall(port, "/api/thread/stop", {
    ...authorized({ "content-length": String(DEFAULT_BODY_LIMIT + 1) }),
    headersOnly: true,
  });
  assert.equal(declaredSmall.status, 413);
  assert.equal(declaredSmall.uploaded, 0);

  // No content-length means the client uses Transfer-Encoding: chunked.
  const chunkedMessage = await httpCall(port, "/api/thread/send", {
    ...authorized(),
    body: `{"pad":"${"x".repeat(MESSAGE_BODY_LIMIT)}"}`,
  });
  assert.equal(chunkedMessage.status, 413);

  const chunkedSmall = await httpCall(port, "/api/thread/stop", {
    ...authorized(),
    body: `{"pad":"${"x".repeat(DEFAULT_BODY_LIMIT)}"}`,
  });
  assert.equal(chunkedSmall.status, 413);
  assert.deepEqual(spy.calls.map((call) => call.name), [], "oversized bodies never reach the service");
});

test("service failure codes map to static statuses without leaking exception detail", async (t) => {
  const f = await fixtureStorage(t);
  const secret = "/private/secret/workspace/thread-record.json";
  let current = null;
  const spy = serviceSpy();
  spy.send = () => Promise.reject(Object.assign(new Error(`failed at ${secret}`), { code: current }));
  const server = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot, discussion: spy });
  const port = await listen(t, server);
  const token = await actionToken(port);
  const origin = `http://127.0.0.1:${port}`;

  const cases = [
    ["invalid-thread", 400],
    ["invalid-message", 400],
    ["invalid-brief", 400],
    ["invalid-handoff", 400],
    ["thread-not-found", 404],
    ["stale-preview", 409],
    ["spec-package-unavailable", 409],
    ["live-owner", 409],
    ["history-only", 409],
    ["delivery-uncertain", 409],
    ["service-closed", 503],
    ["unknown-code", 503],
  ];
  for (const [code, status] of cases) {
    current = code;
    const response = await httpCall(port, "/api/thread/send", {
      method: "POST",
      origin,
      headers: { "x-sentinel-token": token, "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: "fixture", thread_id: THREAD_ID, id: MESSAGE_ID, text: "hi" }),
    });
    assert.equal(response.status, status, code);
    assert.doesNotMatch(response.body, /secret|private|thread-record|failed at/, code);
    if (code === 'spec-package-unavailable') assert.match(response.body, /spec-location materialize/);
  }
});

test("unknown thread routes return 404 and unsupported methods return 405", async (t) => {
  const f = await fixtureStorage(t);
  const spy = serviceSpy();
  const server = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot, discussion: spy });
  const port = await listen(t, server);

  assert.equal((await httpCall(port, "/api/thread/bogus")).status, 404);
  assert.equal((await httpCall(port, "/api/thread/send")).status, 405);
  assert.equal((await httpCall(port, "/api/thread/events", { method: "POST" })).status, 405);
  assert.equal((await httpCall(port, "/api/threads", { method: "POST" })).status, 405);
  assert.equal((await httpCall(port, "/api/thread/bogus", { host: PUBLIC_HOST })).status, 403);
  const head = await httpCall(port, `/api/threads?${new URLSearchParams({ workspace_id: "fixture" })}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.deepEqual(spy.calls.map((call) => call.name), ["list"], "HEAD maps the read path exactly once");
});

for (const endpoint of ["local", "tailnet"]) {
// Run alone: node --test --test-name-pattern="real discussion service.*tailnet" scripts/workspaces/discussion-routes.test.mjs
test(`the real discussion service serves create/list/history/save-brief/suggestions over the ${endpoint} dashboard seam`, async (t) => {
  const f = await fixtureStorage(t);
  const spawnCalls = [];
  const service = createDiscussionService({
    root: f.storageRoot,
    agentDir: join(f.dir, "agent"),
    spawn: (...args) => {
      spawnCalls.push(args);
      throw new Error("no final process launch is authorized in this fixture");
    },
  });
  t.after(() => service.close());
  const server = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot, discussion: service, publicHost: PUBLIC_HOST });
  const port = await listen(t, server);
  const host = endpoint === "tailnet" ? PUBLIC_HOST : `127.0.0.1:${port}`;
  const origin = endpoint === "tailnet" ? `https://${PUBLIC_HOST}` : `http://${host}`;
  const state = JSON.parse((await httpCall(port, "/api/state", { host })).body);
  const token = state.thread_action_token ?? state.action_token;
  const read = path => httpCall(port, path, { host });
  const write = (path, payload) => httpCall(port, path, {
    method: "POST",
    host,
    origin,
    headers: { "x-sentinel-token": token, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const createdResponse = await write("/api/thread/create", {
    workspace_id: "fixture",
    title: "HTTP thread",
    target: { kind: "workspace" },
  });
  assert.equal(createdResponse.status, 200);
  const created = JSON.parse(createdResponse.body);
  assert.match(created.thread_id, UUID_RE);
  assert.equal(created.workspace_id, "fixture");

  const listedResponse = await read(`/api/threads?${new URLSearchParams({ workspace_id: "fixture" })}`);
  assert.equal(listedResponse.status, 200);
  assert.ok(JSON.parse(listedResponse.body).threads.some((thread) => thread.thread_id === created.thread_id));

  const historyResponse = await read(`/api/thread/history?${new URLSearchParams({ workspace_id: "fixture", thread_id: created.thread_id })}`);
  assert.equal(historyResponse.status, 200);
  assert.deepEqual(JSON.parse(historyResponse.body).entries, []);

  const briefRequestId = randomUUID();
  const briefResponse = await write("/api/thread/save-brief", {
    workspace_id: "fixture",
    thread_id: created.thread_id,
    request_id: briefRequestId,
    title: "HTTP brief",
    content: "Body text",
  });
  assert.equal(briefResponse.status, 200);
  const saved = JSON.parse(briefResponse.body);
  assert.equal(typeof saved.brief, "string");
  assert.equal(saved.handoff.request_id, briefRequestId, "the saved request_id survives the HTTP boundary");
  const suggestionsResponse = await read(`/api/thread/suggestions?${new URLSearchParams({workspace_id:'fixture',thread_id:created.thread_id,kind:'file',query:saved.brief})}`);
  assert.equal(suggestionsResponse.status, 200);
  const suggestions = JSON.parse(suggestionsResponse.body);
  assert.equal(suggestions.items[0].label, saved.brief);
  assert.equal(suggestions.items[0].description, 'HTTP brief · workspace');
  assert.match(suggestions.items[0].id, /^file:[0-9a-f]{64}$/);

  // Preview the saved handoff with fresh identity and instructions; the
  // resolved record must bind to the created thread without any launch.
  const assignmentId = randomUUID();
  const instructions = "Preview this saved handoff over HTTP.";
  const previewResponse = await write("/api/thread/preview-assignment", {
    workspace_id: "fixture",
    thread_id: created.thread_id,
    request_id: briefRequestId,
    assignment_id: assignmentId,
    instructions,
  });
  assert.equal(previewResponse.status, 200, previewResponse.body);
  const preview = JSON.parse(previewResponse.body);
  assert.equal(preview.record.assignment_id, assignmentId);
  assert.equal(preview.record.workspace_id, "fixture");
  assert.equal(preview.record.execution_dir, created.execution_dir);
  assert.equal(preview.record.brief, saved.brief);
  assert.ok(Array.isArray(preview.piArgs), "preview returns the exact argv list");
  assert.match(preview.contractDigest, /^[0-9a-f]{64}$/, "preview digest is a 64-character lowercase hex");
  assert.equal(Array.isArray(preview.briefBytes?.data), true, "brief bytes serialize as a Buffer over HTTP");
  const briefText = Buffer.from(preview.briefBytes.data).toString("utf8");
  assert.match(briefText, /HTTP brief/);
  assert.match(briefText, /Body text/);

  // A changed/stale digest must refuse with 409 before any assignment record,
  // coordination state or process launch runs: preview is authorized, launch is not.
  const staleLaunch = await write("/api/thread/launch-assignment", {
    workspace_id: "fixture",
    thread_id: created.thread_id,
    request_id: briefRequestId,
    assignment_id: assignmentId,
    instructions,
    expectedDigest: "0".repeat(64),
  });
  assert.equal(staleLaunch.status, 409, staleLaunch.body);
  assert.equal(existsSync(join(f.storageRoot, "projects", "fixture", "assignments")), false, "no assignment record is published");
  assert.equal(existsSync(join(f.storageRoot, ".sentinel")), false, "no launch coordination state is created");
  assert.deepEqual(spawnCalls, [], "no final process launch is attempted");

  // Invalid IDs and paths stay static 400s; a well-formed but absent thread is 404.
  const badUuid = await read(`/api/thread/history?${new URLSearchParams({ workspace_id: "fixture", thread_id: "not-a-uuid" })}`);
  assert.equal(badUuid.status, 400);
  const badLimit = await read(`/api/thread/history?${new URLSearchParams({ workspace_id: "fixture", thread_id: created.thread_id, limit: "abc" })}`);
  assert.equal(badLimit.status, 400);
  assert.equal((await write("/api/thread/create", { workspace_id: "../escape", title: "Bad workspace" })).status, 400);
  assert.equal((await write("/api/thread/create", { workspace_id: "fixture", title: "Bad path", target: { kind: "worktree", path: "relative/path" } })).status, 400);
  const missing = await read(`/api/thread/history?${new URLSearchParams({ workspace_id: "fixture", thread_id: randomUUID() })}`);
  assert.equal(missing.status, 404);
});
}

test("the real discussion service serves a fresh SSE snapshot without replay", async (t) => {
  const f = await fixtureStorage(t);
  const service = createDiscussionService({ root: f.storageRoot, agentDir: join(f.dir, "agent") });
  t.after(() => service.close());
  const server = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot, discussion: service });
  const port = await listen(t, server);
  const token = await actionToken(port);
  const origin = `http://127.0.0.1:${port}`;
  const write = (path, payload) => httpCall(port, path, {
    method: "POST",
    origin,
    headers: { "x-sentinel-token": token, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const created = JSON.parse((await write("/api/thread/create", {
    workspace_id: "fixture",
    title: "SSE thread",
    target: { kind: "workspace" },
  })).body);
  const path = `/api/thread/events?${new URLSearchParams({ workspace_id: "fixture", thread_id: created.thread_id })}`;

  const first = await openSse(port, path);
  const snapshot = await first.waitFor((frame) => frame.event === "snapshot");
  assert.equal(snapshot.data.thread_id, created.thread_id);
  assert.equal(snapshot.data.state, "idle");
  assert.ok(Array.isArray(snapshot.data.queue));
  assert.equal(snapshot.data.partial, "");
  assert.equal(snapshot.data.attention, null);
  assert.equal(snapshot.data.owns_response, false);
  assert.equal(snapshot.data.queue_paused, false);
  assert.equal(snapshot.data.watermark, 0, "an idle thread starts at watermark zero");
  assert.ok(Object.hasOwn(snapshot.data, "generation"));
  assert.ok(Object.hasOwn(snapshot.data, "last_persisted_id"));
  assert.equal(Object.hasOwn(snapshot.data, "action_token"), false);
  assert.deepEqual(first.events.map((frame) => frame.event), ["snapshot"], "no historical events are replayed");
  first.close();

  const history = JSON.parse((await httpCall(port, `/api/thread/history?${new URLSearchParams({ workspace_id: "fixture", thread_id: created.thread_id })}`)).body);
  assert.equal(snapshot.data.last_persisted_id, history.leaf_id);

  const second = await openSse(port, path);
  const secondSnapshot = await second.waitFor((frame) => frame.event === "snapshot");
  assert.deepEqual(secondSnapshot.data, snapshot.data, "reconnect derives a fresh equivalent snapshot");
  second.close();
});

test("a real stop emits an attributed state event and client abort removes the subscription", async (t) => {
  const f = await fixtureStorage(t);
  const service = createDiscussionService({ root: f.storageRoot, agentDir: join(f.dir, "agent") });
  t.after(() => service.close());
  // Wrap only the public subscribe to count live subscriptions; the routes
  // module still talks to the canonical implementation.
  const originalSubscribe = service.subscribe.bind(service);
  let activeSubscriptions = 0;
  service.subscribe = (input, listener) => {
    activeSubscriptions += 1;
    const unsubscribe = originalSubscribe(input, listener);
    return () => {
      activeSubscriptions -= 1;
      unsubscribe();
    };
  };
  const server = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot, discussion: service });
  const port = await listen(t, server);
  const token = await actionToken(port);
  const origin = `http://127.0.0.1:${port}`;
  const write = (path, payload) => httpCall(port, path, {
    method: "POST",
    origin,
    headers: { "x-sentinel-token": token, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const created = JSON.parse((await write("/api/thread/create", {
    workspace_id: "fixture",
    title: "Stop thread",
    target: { kind: "workspace" },
  })).body);
  const path = `/api/thread/events?${new URLSearchParams({ workspace_id: "fixture", thread_id: created.thread_id })}`;
  const handle = await openSse(port, path);
  await handle.waitFor((frame) => frame.event === "snapshot");
  assert.equal(activeSubscriptions, 1);

  const stopped = await write("/api/thread/stop", { workspace_id: "fixture", thread_id: created.thread_id });
  assert.equal(stopped.status, 200, stopped.body);
  const state = await handle.waitFor((frame) => frame.event === "state");
  assert.equal(state.data.type, "state");
  assert.equal(state.data.thread_id, created.thread_id);
  assert.equal(state.data.event.queue_paused, true);

  handle.close();
  await until(() => activeSubscriptions === 0, "client abort removes the service subscription");
});

test("the SSE stream bounds slow consumers, preserves drain order and disconnects over cap", async (t) => {
  const controlled = controlledDiscussion();
  const routes = createDiscussionRoutes({ discussion: controlled.service, actionToken: "test-token" });
  const request = fakeSseRequest();
  const response = fakeSseResponse();
  await routes(request, response, sseUrl(), { remote: false });
  await until(() => response.chunks.length === 1, "snapshot frame");
  assert.equal(response.status, 200);
  assert.match(response.chunks[0], /^event: snapshot\ndata: /);
  assert.match(response.chunks[0], /"last_persisted_id":"leaf-1"/);

  // The refused write is the frame that flipped the stream to paused; later
  // frames wait for drain and never duplicate the refused frame.
  response.acceptWrites = false;
  controlled.emit(sseEnvelope("delta", { type: "message_update", delta: "A" }));
  controlled.emit(sseEnvelope("delta", { type: "message_update", delta: "B" }));
  controlled.emit(sseEnvelope("delta", { type: "message_update", delta: "C" }));
  controlled.emit(sseEnvelope("delta", { type: "message_update", delta: "other" }, { thread_id: "other-thread" }));
  assert.equal(response.chunks.length, 2, "only A is written while paused; mismatches are filtered");

  response.acceptWrites = true;
  response.emit("drain");
  assert.equal(response.chunks.length, 4, "drain flushes the queued frames in order");
  assert.match(response.chunks[1], /"delta":"A"/);
  assert.match(response.chunks[2], /"delta":"B"/);
  assert.match(response.chunks[3], /"delta":"C"/);

  // Overcap accounting includes response.writableLength; the stream is
  // destroyed and the service subscription released.
  response.acceptWrites = false;
  controlled.emit(sseEnvelope("delta", { type: "message_update", delta: "D" }));
  assert.equal(response.chunks.length, 5);
  response.writableLength = STREAM_BYTES_LIMIT;
  controlled.emit(sseEnvelope("delta", { type: "message_update", delta: "E" }));
  assert.equal(response.destroyed, true, "an over-cap stream is destroyed");
  assert.equal(controlled.unsubscribes(), 1);
});

test("a service close ends the SSE stream and releases the subscription", async () => {
  const controlled = controlledDiscussion();
  const routes = createDiscussionRoutes({ discussion: controlled.service, actionToken: "test-token" });
  const request = fakeSseRequest();
  const response = fakeSseResponse();
  await routes(request, response, sseUrl(), { remote: false });
  await until(() => response.chunks.length === 1, "snapshot frame");

  controlled.emit({ type: "closed", workspace_id: "fixture", thread_id: THREAD_ID });
  assert.equal(response.ended, true);
  assert.equal(controlled.unsubscribes(), 1);
});

test("the SSE endpoint caps active streams at sixteen and an abort frees capacity", async (t) => {
  const controlled = controlledDiscussion();
  const routes = createDiscussionRoutes({ discussion: controlled.service, actionToken: "test-token" });
  const streams = [];
  t.after(() => {
    for (const stream of streams) stream.request.emit("aborted");
  });

  for (let index = 0; index < 16; index += 1) {
    const request = fakeSseRequest();
    const response = fakeSseResponse();
    await routes(request, response, sseUrl(), { remote: false });
    await until(() => response.headersSent, `stream ${index} initialized`);
    streams.push({ request, response });
  }
  assert.equal(controlled.listeners.size, 16);

  const refusedRequest = fakeSseRequest();
  const refusedResponse = fakeSseResponse();
  await routes(refusedRequest, refusedResponse, sseUrl(), { remote: false });
  assert.equal(refusedResponse.status, 503, "the seventeenth stream is unavailable");
  assert.equal(refusedResponse.headersSent, true);

  streams[0].request.emit("aborted");
  await until(() => controlled.listeners.size === 15, "abort releases capacity");
  const nextRequest = fakeSseRequest();
  const nextResponse = fakeSseResponse();
  await routes(nextRequest, nextResponse, sseUrl(), { remote: false });
  await until(() => nextResponse.headersSent === true, "replacement stream initializes");
  assert.equal(nextResponse.status, 200);
  streams.push({ request: nextRequest, response: nextResponse });
});

test("a disconnect during initialization releases capacity without writing headers", async (t) => {
  const controlled = controlledDiscussion({ deferFirstList: true });
  const routes = createDiscussionRoutes({ discussion: controlled.service, actionToken: "test-token" });
  const request = fakeSseRequest();
  const response = fakeSseResponse();
  const pending = routes(request, response, sseUrl(), { remote: false });
  await until(() => controlled.listeners.size === 1, "subscription is registered before list resolves");

  request.emit("aborted");
  await until(() => controlled.listeners.size === 0, "abort cleans up while list is pending");
  controlled.resolveFirstList();
  await pending;
  await delay(10);
  assert.equal(response.headersSent, false, "an aborted initialization must not write headers");
  assert.equal(controlled.unsubscribes(), 1);

  // The released capacity serves a complete stream on the same routes instance.
  const secondRequest = fakeSseRequest();
  const secondResponse = fakeSseResponse();
  t.after(() => secondRequest.emit("aborted"));
  await routes(secondRequest, secondResponse, sseUrl(), { remote: false });
  await until(() => secondResponse.headersSent, "replacement stream initializes");
  assert.equal(secondResponse.status, 200);
});

test("a delta emitted during initialization without a snapshot watermark stays ordered after the snapshot exactly once", async (t) => {
  const controlled = controlledDiscussion({ deferFirstList: true });
  const routes = createDiscussionRoutes({ discussion: controlled.service, actionToken: "test-token" });
  const request = fakeSseRequest();
  const response = fakeSseResponse();
  t.after(() => request.emit("aborted"));
  const pending = routes(request, response, sseUrl(), { remote: false });
  await until(() => controlled.listeners.size === 1, "subscription is registered before list resolves");

  controlled.emit(sseEnvelope("delta", { type: "message_update", delta: "early" }));
  controlled.resolveFirstList();
  await pending;
  await until(() => response.chunks.length === 2, "snapshot then buffered delta");
  assert.match(response.chunks[0], /^event: snapshot\ndata: /);
  assert.match(response.chunks[1], /^event: delta\ndata: /);
  assert.equal(
    response.chunks.filter((chunk) => chunk.includes('"delta":"early"')).length,
    1,
    "the buffered delta is written exactly once",
  );
});

test("buffered deltas already reflected in the snapshot watermark are deduplicated while later frames follow", async (t) => {
  const controlled = controlledDiscussion({ deferFirstList: true, deferFirstHistory: true });
  const routes = createDiscussionRoutes({ discussion: controlled.service, actionToken: "test-token" });
  const request = fakeSseRequest();
  const response = fakeSseResponse();
  t.after(() => request.emit("aborted"));
  routes(request, response, sseUrl(), { remote: false });
  await until(() => controlled.listeners.size === 1, "subscription is registered before list resolves");

  // Durable state/notice and a terminal message_end land before the snapshot
  // projection resolves, followed by the early delta already represented by
  // snapshot.partial. All four sit at or below the snapshot watermark: the
  // durable queue/state record may be older than the projection and must
  // survive, while the partial-affecting message_end and delta are already
  // represented and must not replay.
  controlled.emit(sseEnvelope("state", { type: "state", queue: [], queue_paused: false, attention: null }, { sequence: 1 }));
  controlled.emit(sseEnvelope("notice", { type: "notice", attention: "provider-retry" }, { sequence: 2 }));
  controlled.emit(sseEnvelope("message_end", { type: "message_end" }, { sequence: 3 }));
  controlled.emit(sseEnvelope("delta", { type: "message_update", delta: "early" }, { sequence: 4 }));
  controlled.summary.partial = "early";
  controlled.summary.watermark = 4;
  controlled.resolveFirstList();
  await until(() => controlled.historyCalls() === 1, "history read starts after the projection");

  // A later delta arrives after the projection but before deferred history
  // resolves, so it stays buffered behind the snapshot too.
  controlled.summary.watermark = 5;
  controlled.emit(sseEnvelope("delta", { type: "message_update", delta: " later" }, { sequence: 5 }));
  controlled.resolveFirstHistory();
  await until(() => response.chunks.length === 4, "snapshot, durable state/notice and the later delta flush");

  const dataOf = (chunk) => JSON.parse(chunk.slice(chunk.indexOf("data: ") + 6).trim());
  const types = response.chunks.map((chunk) => chunk.match(/^event: (\w+)/)[1]);
  assert.deepEqual(types, ["snapshot", "state", "notice", "delta"], "durable state/notice keep arrival order ahead of the later delta");
  const snapshot = dataOf(response.chunks[0]);
  assert.equal(snapshot.partial, "early");
  assert.equal(snapshot.watermark, 4);
  assert.equal(
    response.chunks.filter((chunk) => chunk.includes('"delta":"early"')).length,
    0,
    "a buffered delta already reflected in the snapshot is not replayed",
  );
  assert.equal(types.includes("message_end"), false, "a buffered message_end at or below the watermark is not replayed");
  const later = response.chunks.find((chunk) => chunk.includes('"delta":" later"'));
  assert.ok(later, "a later delta is retained");
  assert.equal(dataOf(later).sequence, 5);
  assert.equal(
    response.chunks.filter((chunk) => chunk.includes('"delta":" later"')).length,
    1,
    "the later delta is written exactly once",
  );
  assert.equal(snapshot.partial + dataOf(later).event.delta, "early later", "snapshot plus stream reconstructs the partial exactly once");
  assert.equal(dataOf(response.chunks[1]).sequence, 1, "the durable state frame is retained with its watermark");
  assert.equal(dataOf(response.chunks[2]).sequence, 2, "the durable notice frame is retained with its watermark");
});

test("an over-cap snapshot cleans up the stream and releases the subscription", async (t) => {
  const controlled = controlledDiscussion();
  controlled.summary.partial = "x".repeat(STREAM_BYTES_LIMIT + 1);
  const routes = createDiscussionRoutes({ discussion: controlled.service, actionToken: "test-token" });
  const request = fakeSseRequest();
  const response = fakeSseResponse();
  t.after(() => request.emit("aborted"));
  await routes(request, response, sseUrl(), { remote: false });
  await until(() => controlled.unsubscribes() === 1, "snapshot overflow releases the subscription");
  assert.equal(response.destroyed, true);
  assert.equal(response.chunks.length, 0, "the oversized snapshot is never written");
  assert.equal(response.ended, false);
});

test("a normal request close during initialization still initializes while response close cleans up", async (t) => {
  const controlled = controlledDiscussion({ deferFirstList: true });
  const routes = createDiscussionRoutes({ discussion: controlled.service, actionToken: "test-token" });
  const request = fakeSseRequest();
  const response = fakeSseResponse();
  t.after(() => response.emit("close"));
  const pending = routes(request, response, sseUrl(), { remote: false });
  await until(() => controlled.listeners.size === 1, "subscription is registered before list resolves");

  // IncomingMessage 'close' also fires after a normal request is fully read;
  // it must not abort the pending snapshot initialization.
  request.emit("close");
  controlled.resolveFirstList();
  await pending;
  await until(() => response.headersSent, "normal request close still initializes");
  assert.equal(response.status, 200);
  assert.equal(controlled.listeners.size, 1);

  response.emit("close");
  await until(() => controlled.unsubscribes() === 1, "response close cleans up the stream");
  assert.equal(controlled.listeners.size, 0);
});

// Direct dispatch HTTP acceptance (step 4, EV-6). Run alone:
//   node --test --test-name-pattern='direct dispatch HTTP|dispatch authorization|dispatch refusal mapping' scripts/workspaces/discussion-routes.test.mjs

function git(cwd, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", ...args],
      {
        cwd,
        timeout: 10000,
        killSignal: "SIGKILL",
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

async function makeRepo(directory) {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "--quiet"]);
  await git(directory, ["commit", "--allow-empty", "-m", "init"]);
  return realpathSync(directory);
}

async function setupDispatchedWorkspace(storageRoot, id, repositories) {
  await createWorkspace(storageRoot, { id, name: id });
  const directory = join(storageRoot, "projects", id);
  const lines = [
    "version: 1",
    `id: ${JSON.stringify(id)}`,
    `name: ${JSON.stringify(id)}`,
    `execution_host: ${JSON.stringify(hostname())}`,
    "repositories:",
  ];
  for (const repository of repositories) {
    lines.push(`  - id: ${JSON.stringify(repository.id)}`);
    lines.push(`    path: ${JSON.stringify(repository.path)}`);
  }
  lines.push("context: []");
  await writeFile(join(directory, "kit.yaml"), `${lines.join("\n")}\n`);
  return directory;
}

// Case-owned fake `pi` executable for resolution; PATH is restored after the
// case even on failure.
async function withFakePi(t, root) {
  const binDirectory = join(root, "bin");
  await mkdir(binDirectory, { recursive: true });
  const piPath = join(binDirectory, "pi");
  await writeFile(piPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(piPath, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDirectory}${delimiter}${savedPath ?? ""}`;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });
  return piPath;
}

// Owned inert process used as the fake tmux pane PID: processIdentity observes
// it through a real OS probe and cleanup kills exactly this child.
function dummyProcess(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  });
  return child;
}

// Final tmux transport boundary for direct launches: sessions are fake and
// tracked by name, the pane PID answers with the owned dummy process, and
// show-options returns the assignment id captured at new-session. No real
// tmux server is touched.
function tmuxHarness({ dummyPid = null } = {}) {
  const calls = [];
  const sessions = new Map();
  const targetOf = (args) => {
    const index = args.indexOf("-t");
    return index === -1 ? null : args[index + 1].replace(/^=/, "").replace(/:$/, "");
  };
  const run = (socketPath, args) => {
    calls.push({ socketPath, args: [...args] });
    if (args.includes("new-session")) {
      // The bootstrap queue sets `-s extended-keys` before new-session, so the
      // session name and assignment marker are read from the new-session
      // command alone, bounded by the queue separator.
      const newSessionIndex = args.indexOf("new-session");
      const queueEnd = args.indexOf(";", newSessionIndex);
      const newSessionArgs = args.slice(newSessionIndex, queueEnd === -1 ? args.length : queueEnd);
      const marker = newSessionArgs.find((arg) => typeof arg === "string" && arg.startsWith("ADJACENT_ASSIGNMENT_ID="));
      const nameIndex = newSessionArgs.indexOf("-s");
      sessions.set(
        nameIndex === -1 ? null : newSessionArgs[nameIndex + 1],
        marker ? marker.slice("ADJACENT_ASSIGNMENT_ID=".length) : null,
      );
      return Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" });
    }
    if (args.includes("has-session")) {
      const target = targetOf(args);
      return Promise.resolve(sessions.has(target)
        ? { ok: true, code: 0, stdout: "", stderr: "" }
        : { ok: false, code: 1, stdout: "", stderr: "can't find session" });
    }
    if (args.includes("list-clients")) return Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" });
    if (args.includes("display-message")) {
      return Promise.resolve({ ok: true, code: 0, stdout: `%1 ${dummyPid}\n`, stderr: "" });
    }
    if (args.includes("show-options")) {
      const target = targetOf(args);
      return Promise.resolve(sessions.has(target)
        ? { ok: true, code: 0, stdout: `${sessions.get(target)}\n`, stderr: "" }
        : { ok: false, code: 1, stdout: "", stderr: "can't find session" });
    }
    return Promise.reject(new Error(`unexpected tmux command: ${args.join(" ")}`));
  };
  return {
    calls,
    run,
    newSessionCount: () => calls.filter((call) => call.args.includes("new-session")).length,
    destructiveCount: () => calls.filter((call) => call.args.some((arg) => ["kill-session", "kill-server", "kill-pane", "kill-window"].includes(arg))).length,
  };
}

// Run alone: node --test --test-name-pattern="direct dispatch HTTP" scripts/workspaces/discussion-routes.test.mjs
test("direct dispatch HTTP saves, reviews and launches bound skill/package contracts over local and public hosts", { timeout: 60000 }, async (t) => {
  const f = fixture(t);
  await setupStorage(f.storageRoot);
  const localRepo = await makeRepo(join(f.dir, "repos", "app-local"));
  const publicRepo = await makeRepo(join(f.dir, "repos", "app-public"));
  const workspaceDirectory = await setupDispatchedWorkspace(f.storageRoot, "shipped", [
    { id: "app-local", path: localRepo },
    { id: "app-public", path: publicRepo },
  ]);
  for (const repository of [localRepo, publicRepo]) {
    await mkdir(join(repository, "docs"), { recursive: true });
    await writeFile(join(repository, "docs", "context.md"), "# Bound context\nExact selected source.\n");
  }
  const localPackage = await newPackage({ workspace: "shipped", slug: "local", targets: [{ id: "app-local" }], root: f.storageRoot });
  assert.equal(localPackage.ok, true, JSON.stringify(localPackage));
  const publicPackage = await newPackage({ workspace: "shipped", slug: "public", targets: [{ id: "app-public" }], root: f.storageRoot });
  assert.equal(publicPackage.ok, true, JSON.stringify(publicPackage));

  await withFakePi(t, f.dir);
  const dummy = dummyProcess(t);
  const tmux = tmuxHarness({ dummyPid: dummy.pid });
  const service = createDiscussionService({
    root: f.storageRoot,
    agentDir: join(f.dir, "agent"),
    assignmentAdapters: {
      tmuxRun: tmux.run,
      observationProbes: { tmuxRun: tmux.run, psRun: () => ({ stdout: "", complete: true }) },
    },
  });
  t.after(() => service.close());
  const server = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot, discussion: service, publicHost: PUBLIC_HOST });
  const port = await listen(t, server);
  const localHost = `127.0.0.1:${port}`;
  const localToken = await actionToken(port);
  const operatorToken = JSON.parse((await httpCall(port, "/api/state", { host: PUBLIC_HOST })).body).thread_action_token;
  assert.match(operatorToken, /^[a-f0-9]{64}$/, "the configured public host exposes the operator token");
  const endpoints = [
    { label: "local", host: localHost, origin: `http://${localHost}`, token: localToken, repository: localRepo, repositoryId: "app-local", packageRef: localPackage.locations.package_dir },
    { label: "tailnet", host: `${PUBLIC_HOST}:443`, origin: `https://${PUBLIC_HOST}`, token: operatorToken, repository: publicRepo, repositoryId: "app-public", packageRef: publicPackage.locations.package_dir },
  ];

  let launches = 0;
  for (const endpoint of endpoints) {
    const tmuxBaseline = tmux.calls.length;
    const sourcePath = join(endpoint.repository, "docs", "context.md");
    const requestId = randomUUID();
    const assignmentId = randomUUID();
    const write = (path, payload) => httpCall(port, path, {
      method: "POST",
      host: endpoint.host,
      origin: endpoint.origin,
      headers: { "x-sentinel-token": endpoint.token, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const savedResponse = await write("/api/dispatch/save-brief", {
      workspace_id: "shipped",
      request_id: requestId,
      title: `${endpoint.label} contract`,
      content: "Bound body\n",
    });
    assert.equal(savedResponse.status, 200, `${endpoint.label} save: ${savedResponse.body}`);
    const saved = JSON.parse(savedResponse.body);
    assert.match(saved.brief, /^briefs\/brief-[0-9a-f]{64}\.md$/);

    const suggestionsResponse = await httpCall(
      port,
      `/api/dispatch/suggestions?${new URLSearchParams({ workspace_id: "shipped", repository_id: endpoint.repositoryId, kind: "file", query: "context.md" })}`,
      { host: endpoint.host },
    );
    assert.equal(suggestionsResponse.status, 200, `${endpoint.label} suggestions: ${suggestionsResponse.body}`);
    const suggestion = JSON.parse(suggestionsResponse.body).items.find((item) => item.label === "docs/context.md");
    assert.ok(suggestion, `${endpoint.label}: the repository file is suggested`);
    assert.match(suggestion.id, /^file:[0-9a-f]{64}$/);

    const input = {
      workspace_id: "shipped",
      request_id: requestId,
      assignment_id: assignmentId,
      instructions: "Deliver the bound contract.",
      repository_id: endpoint.repositoryId,
      references: [{ kind: "file", id: suggestion.id }],
      skill: DISPATCH_SKILL,
      spec_package: endpoint.packageRef,
    };

    const previewResponse = await write("/api/dispatch/preview", input);
    assert.equal(previewResponse.status, 200, `${endpoint.label} preview: ${previewResponse.body}`);
    const preview = JSON.parse(previewResponse.body);
    assert.equal(preview.record.assignment_id, assignmentId);
    assert.equal(preview.record.workspace_id, "shipped");
    assert.equal(preview.record.brief, saved.brief);
    assert.equal(preview.record.execution_dir, endpoint.repository);
    assert.equal(preview.record.repository_id, endpoint.repositoryId);
    assert.equal(preview.record.skill, DISPATCH_SKILL);
    assert.match(preview.record.skill_path, new RegExp(`${DISPATCH_SKILL}/SKILL\\.md$`));
    assert.equal(realpathSync(preview.record.spec_package), realpathSync(endpoint.packageRef));
    assert.equal(preview.record.publication_authority, "none");
    assert.equal(preview.record.attempt_kind, "initial");
    assert.match(preview.contractDigest, /^[0-9a-f]{64}$/);
    const previewBytes = Buffer.from(preview.briefBytes.data);
    assert.match(previewBytes.toString("utf8"), /Bound context/);
    assert.match(previewBytes.toString("utf8"), /Bound body/);
    assert.equal(existsSync(join(workspaceDirectory, "threads")), false, `${endpoint.label}: preview creates no thread`);
    assert.equal(tmux.calls.length, tmuxBaseline, `${endpoint.label}: preview launches nothing`);

    if (endpoint.label === "local") {
      // A captured-source change after review refuses the reviewed digest with
      // the fixed stale-preview body and leaves no reservation behind.
      await writeFile(sourcePath, "# Changed context\nDifferent bytes.\n");
      const staleResponse = await write("/api/dispatch/launch", { ...input, expectedDigest: preview.contractDigest });
      assert.equal(staleResponse.status, 409, `stale launch: ${staleResponse.body}`);
      assert.deepEqual(JSON.parse(staleResponse.body), {
        error: "The reviewed assignment changed. Review it again.",
        reason: "stale-preview",
      });
      assert.equal(existsSync(join(workspaceDirectory, "assignments", `${assignmentId}.json`)), false, "stale launch publishes no record");
      assert.equal(existsSync(join(f.storageRoot, ".sentinel")), false, "stale launch publishes no reservation");
      assert.equal(tmux.calls.length, tmuxBaseline, "stale launch reaches no tmux boundary");
    }

    const freshResponse = await write("/api/dispatch/preview", input);
    assert.equal(freshResponse.status, 200, `${endpoint.label} fresh preview: ${freshResponse.body}`);
    const fresh = JSON.parse(freshResponse.body);
    if (endpoint.label === "local") assert.notEqual(fresh.contractDigest, preview.contractDigest);

    const launchResponse = await write("/api/dispatch/launch", { ...input, expectedDigest: fresh.contractDigest });
    assert.equal(launchResponse.status, 200, `${endpoint.label} launch: ${launchResponse.body}`);
    const launched = JSON.parse(launchResponse.body);
    assert.equal(launched.assignment.assignment_id, assignmentId);
    assert.equal(launched.assignment.state, "live");
    assert.equal(launched.assignment.execution_dir, endpoint.repository);
    assert.equal(launched.assignment.skill, DISPATCH_SKILL);
    assert.equal(launched.assignment.contract_digest, fresh.contractDigest);
    assert.equal(launched.observation.state, "live");
    launches += 1;
    assert.equal(tmux.newSessionCount(), launches, `${endpoint.label}: one fake session per launched contract`);

    const stored = JSON.parse(await readFile(join(workspaceDirectory, "assignments", `${assignmentId}.json`), "utf8"));
    assert.equal(stored.repository_id, endpoint.repositoryId);
    assert.equal(stored.skill, DISPATCH_SKILL);
    assert.equal(stored.contract_digest, fresh.contractDigest);
    assert.equal(stored.state, "live");
    assert.deepEqual(
      await readFile(join(workspaceDirectory, "assignments", `${assignmentId}.brief.md`)),
      Buffer.from(fresh.briefBytes.data),
      "the persisted brief snapshot is the reviewed bytes",
    );
  }
  assert.equal(existsSync(join(workspaceDirectory, "threads")), false, "direct dispatch never creates a threads directory");

  // Unknown direct fields and absolute-authority overrides are refused before
  // resolution: no record, reservation or tmux work can follow.
  const overrides = [
    ["/api/dispatch/save-brief", { workspace_id: "shipped", request_id: randomUUID(), title: "Override", content: "body", path: "briefs/x.md" }],
    ["/api/dispatch/preview", { workspace_id: "shipped", request_id: randomUUID(), assignment_id: randomUUID(), instructions: "Do it.", execution_dir: localRepo }],
    ["/api/dispatch/preview", { workspace_id: "shipped", request_id: randomUUID(), assignment_id: randomUUID(), instructions: "Do it.", pi_path: "/tmp/pi", home: "/tmp" }],
    ["/api/dispatch/launch", { workspace_id: "shipped", request_id: randomUUID(), assignment_id: randomUUID(), instructions: "Do it.", expectedDigest: "0".repeat(64), publication_authority: "pr" }],
  ];
  for (const [path, payload] of overrides) {
    const response = await httpCall(port, path, {
      method: "POST",
      host: localHost,
      origin: `http://${localHost}`,
      headers: { "x-sentinel-token": localToken, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400, `${path} ${JSON.stringify(payload)}: ${response.body}`);
    assert.deepEqual(JSON.parse(response.body), { error: "Discussion request is invalid." });
    assert.equal(existsSync(join(workspaceDirectory, "assignments", `${payload.assignment_id}.json`)), false);
  }
  assert.equal(tmux.newSessionCount(), launches, "no override refusal reaches the tmux boundary");
  assert.equal(tmux.destructiveCount(), 0);
});

// Run alone: node --test --test-name-pattern="dispatch authorization" scripts/workspaces/discussion-routes.test.mjs
test("dispatch authorization refuses wrong Origin, missing token, non-JSON and nonoperator remote before any dispatch body or service call", async (t) => {
  const f = await fixtureStorage(t);
  const spy = serviceSpy();
  const server = createDashboardServer({ agentDir: f.dir, publicHost: PUBLIC_HOST, storageRoot: f.storageRoot, discussion: spy });
  const port = await listen(t, server);
  const localHost = `127.0.0.1:${port}`;
  const localOrigin = `http://${localHost}`;
  const localToken = await actionToken(port);
  const operatorToken = JSON.parse((await httpCall(port, "/api/state", { host: PUBLIC_HOST })).body).thread_action_token;
  assert.match(operatorToken, /^[a-f0-9]{64}$/);

  // Every refusal answers from declared headers alone: headersOnly never
  // uploads the declared 64 KiB body, so a route that reads first times out.
  const refusals = [
    { label: "wrong Origin", host: localHost, origin: "https://evil.example", token: localToken, contentType: "application/json" },
    { label: "loopback alias Origin", host: localHost, origin: `http://localhost:${port}`, token: localToken, contentType: "application/json" },
    { label: "missing token", host: localHost, origin: localOrigin, token: undefined, contentType: "application/json" },
    { label: "wrong token", host: localHost, origin: localOrigin, token: "0".repeat(64), contentType: "application/json" },
    { label: "non-JSON content type", host: localHost, origin: localOrigin, token: localToken, contentType: "text/plain" },
    { label: "nonoperator remote Host", host: "other.example.ts.net", origin: "https://other.example.ts.net", token: localToken, contentType: "application/json" },
    { label: "forwarded identity on loopback", host: localHost, origin: localOrigin, token: localToken, contentType: "application/json", forwarded: true },
  ];

  for (const refusal of refusals) {
    for (const path of ["/api/dispatch/save-brief", "/api/dispatch/preview", "/api/dispatch/launch"]) {
      const response = await httpCall(port, path, {
        method: "POST",
        host: refusal.host,
        origin: refusal.origin,
        headersOnly: true,
        headers: {
          "content-type": refusal.contentType,
          "content-length": String(MESSAGE_BODY_LIMIT + 1),
          ...(refusal.token === undefined ? {} : { "x-sentinel-token": refusal.token }),
          ...(refusal.forwarded ? { "x-forwarded-for": "100.64.0.1" } : {}),
        },
      });
      assert.equal(response.status, 403, `${refusal.label} ${path}`);
      assert.equal(response.uploaded, 0, `${refusal.label} ${path}: no body byte is uploaded`);
    }
  }
  assert.deepEqual(spy.calls.map((call) => call.name), [], "no refused dispatch request reaches the service");

  const payload = { workspace_id: "fixture", request_id: REQUEST_ID, assignment_id: ASSIGNMENT_ID, instructions: "Review it." };
  const alternates = [
    { label: "local", host: localHost, origin: localOrigin, token: localToken },
    { label: "operator public host", host: `${PUBLIC_HOST}:443`, origin: `https://${PUBLIC_HOST}`, token: operatorToken },
  ];
  for (const alternate of alternates) {
    const preview = await httpCall(port, "/api/dispatch/preview", {
      method: "POST",
      host: alternate.host,
      origin: alternate.origin,
      headers: { "x-sentinel-token": alternate.token, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(preview.status, 200, `${alternate.label}: ${preview.body}`);
    const suggestions = await httpCall(
      port,
      `/api/dispatch/suggestions?${new URLSearchParams({ workspace_id: "fixture", kind: "skill", query: "spec" })}`,
      { host: alternate.host },
    );
    assert.equal(suggestions.status, 200, `${alternate.label}: ${suggestions.body}`);
  }
  assert.deepEqual(
    spy.calls.map((call) => call.name),
    ["dispatchPreview", "dispatchSuggestions", "dispatchPreview", "dispatchSuggestions"],
    "both authorizations map one-to-one onto the dispatch service methods",
  );
  assert.deepEqual(spy.calls[0].args, [payload]);
  assert.deepEqual(spy.calls[2].args, [payload]);
});

// Run alone: node --test --test-name-pattern="dispatch refusal mapping" scripts/workspaces/discussion-routes.test.mjs
test("dispatch refusal mapping fixes 409 bodies, service-unavailable and ordinary 503s without leaking internals", { timeout: 60000 }, async (t) => {
  const f = fixture(t);
  await setupStorage(f.storageRoot);
  const busyRepo = await makeRepo(join(f.dir, "repos", "busy"));
  const packagedRepo = await makeRepo(join(f.dir, "repos", "packaged"));
  const workspaceDirectory = await setupDispatchedWorkspace(f.storageRoot, "refusals", [
    { id: "busy", path: busyRepo },
    { id: "packaged", path: packagedRepo },
  ]);
  await withFakePi(t, f.dir);
  const dummy = dummyProcess(t);
  const tmux = tmuxHarness({ dummyPid: dummy.pid });
  const service = createDiscussionService({
    root: f.storageRoot,
    agentDir: join(f.dir, "agent"),
    assignmentAdapters: {
      tmuxRun: tmux.run,
      observationProbes: { tmuxRun: tmux.run, psRun: () => ({ stdout: "", complete: true }) },
    },
  });
  t.after(() => service.close());
  const server = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot, discussion: service });
  const port = await listen(t, server);
  const token = await actionToken(port);
  const origin = `http://127.0.0.1:${port}`;
  const write = (path, payload) => httpCall(port, path, {
    method: "POST",
    origin,
    headers: { "x-sentinel-token": token, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  // Writer conflict: the second launch into the same execution directory
  // refuses with the fixed target-busy body naming the conflicting writer.
  const firstRequest = randomUUID();
  const firstAssignment = randomUUID();
  await write("/api/dispatch/save-brief", { workspace_id: "refusals", request_id: firstRequest, title: "First", content: "body\n" });
  const firstPreview = JSON.parse((await write("/api/dispatch/preview", { workspace_id: "refusals", request_id: firstRequest, assignment_id: firstAssignment, instructions: "First.", repository_id: "busy" })).body);
  assert.equal((await write("/api/dispatch/launch", { workspace_id: "refusals", request_id: firstRequest, assignment_id: firstAssignment, instructions: "First.", repository_id: "busy", expectedDigest: firstPreview.contractDigest })).status, 200);

  const secondRequest = randomUUID();
  const secondAssignment = randomUUID();
  await write("/api/dispatch/save-brief", { workspace_id: "refusals", request_id: secondRequest, title: "Second", content: "body\n" });
  const secondPreview = JSON.parse((await write("/api/dispatch/preview", { workspace_id: "refusals", request_id: secondRequest, assignment_id: secondAssignment, instructions: "Second.", repository_id: "busy" })).body);
  const busyResponse = await write("/api/dispatch/launch", { workspace_id: "refusals", request_id: secondRequest, assignment_id: secondAssignment, instructions: "Second.", repository_id: "busy", expectedDigest: secondPreview.contractDigest });
  assert.equal(busyResponse.status, 409, busyResponse.body);
  const busyBody = JSON.parse(busyResponse.body);
  assert.deepEqual(busyBody, {
    error: "This execution directory already has an assignment.",
    reason: "target-busy",
    assignment_id: firstAssignment,
  });
  assert.deepEqual(Object.keys(busyBody).sort(), ["assignment_id", "error", "reason"]);
  assert.doesNotMatch(busyResponse.body, /\//);
  assert.doesNotMatch(busyResponse.body, /reserves|another|pid/i);
  assert.equal(existsSync(join(workspaceDirectory, "assignments", `${secondAssignment}.json`)), false, "the refused writer publishes no record");
  const records = (await readdir(join(workspaceDirectory, "assignments"))).filter((name) => name.endsWith(".json"));
  assert.deepEqual(records, [`${firstAssignment}.json`], "only the first writer remains recorded");

  // Active package run: the canonical owner refuses before any publication.
  const createdPackage = await newPackage({ workspace: "refusals", slug: "run", targets: [{ id: "packaged" }], root: f.storageRoot });
  assert.equal(createdPackage.ok, true, JSON.stringify(createdPackage));
  const packageDirectory = createdPackage.locations.package_dir;
  await mkdir(join(packageDirectory, "runtime"), { recursive: true });
  const runPath = join(packageDirectory, "runtime", "run.json");
  await writeFile(runPath, JSON.stringify({ id: "run-refusal", state: "running", coordinator_pid: process.pid }));
  const runBytes = await readFile(runPath);

  const runRequest = randomUUID();
  const runAssignment = randomUUID();
  await write("/api/dispatch/save-brief", { workspace_id: "refusals", request_id: runRequest, title: "Packaged", content: "body\n" });
  const runPreview = JSON.parse((await write("/api/dispatch/preview", { workspace_id: "refusals", request_id: runRequest, assignment_id: runAssignment, instructions: "Packaged.", repository_id: "packaged", spec_package: packageDirectory })).body);
  assert.equal(runPreview.record.execution_dir, packagedRepo);
  const runActive = await write("/api/dispatch/launch", { workspace_id: "refusals", request_id: runRequest, assignment_id: runAssignment, instructions: "Packaged.", repository_id: "packaged", spec_package: packageDirectory, expectedDigest: runPreview.contractDigest });
  assert.equal(runActive.status, 409, runActive.body);
  assert.deepEqual(JSON.parse(runActive.body), { error: "This spec package has an active run.", reason: "run-active" });
  assert.doesNotMatch(runActive.body, /\//);
  assert.deepEqual(await readFile(runPath), runBytes, "the active run record is untouched");
  assert.equal(existsSync(join(workspaceDirectory, "assignments", `${runAssignment}.json`)), false, "an active run publishes no assignment record");

  // Missing service: dispatch and assignment paths are distinguishable from
  // ordinary thread unavailability. The refusal precedes any body read.
  const bareServer = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot });
  const barePort = await listen(t, bareServer);
  const bareOrigin = `http://127.0.0.1:${barePort}`;
  const bareCall = (path) => httpCall(barePort, path, {
    method: "POST",
    origin: bareOrigin,
    headersOnly: true,
    headers: { "content-type": "application/json", "content-length": "2" },
  });
  for (const path of ["/api/dispatch/preview", "/api/thread/preview-assignment", "/api/thread/launch-assignment"]) {
    const response = await bareCall(path);
    assert.equal(response.status, 503, path);
    assert.deepEqual(JSON.parse(response.body), { error: "Dispatch service unavailable.", reason: "service-unavailable" }, path);
  }
  const bareSend = await bareCall("/api/thread/send");
  const bareSendBody = JSON.parse(bareSend.body);
  assert.deepEqual(bareSendBody, { error: "Discussion service unavailable." }, "an unrelated thread route keeps the static body");
  assert.equal(Object.hasOwn(bareSendBody, "reason"), false);

  // Closed service: the same fixed service-unavailable body for dispatch and
  // assignment paths, still without a reason on unrelated thread routes.
  await service.close();
  const closed = await write("/api/dispatch/preview", { workspace_id: "refusals", request_id: randomUUID(), assignment_id: randomUUID(), instructions: "Closed." });
  assert.equal(closed.status, 503, closed.body);
  assert.deepEqual(JSON.parse(closed.body), { error: "Dispatch service unavailable.", reason: "service-unavailable" });
  const closedThread = await write("/api/thread/launch-assignment", { workspace_id: "refusals", request_id: randomUUID(), assignment_id: randomUUID(), instructions: "Closed.", expectedDigest: "0".repeat(64) });
  assert.deepEqual(JSON.parse(closedThread.body), { error: "Dispatch service unavailable.", reason: "service-unavailable" });

  // An unrelated unknown preview failure stays an ordinary static 503 with no
  // reason and no exception prose or path. request-conflict stays fixed
  // error/reason on both dispatch and assignment routes: its typed request_id
  // is not part of the allow-list even when well formed, and a malformed or
  // unrelated identifier is never serialized either.
  const secret = "/private/secret/dispatch-record.json";
  const spy = serviceSpy();
  spy.dispatchPreview = () => Promise.reject(Object.assign(new Error(`failed at ${secret}`), { code: "unknown-code" }));
  const spyServer = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot, discussion: spy });
  const spyPort = await listen(t, spyServer);
  const spyToken = await actionToken(spyPort);
  const spyCall = (path, payload) => httpCall(spyPort, path, {
    method: "POST",
    origin: `http://127.0.0.1:${spyPort}`,
    headers: { "x-sentinel-token": spyToken, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const unknown = await spyCall("/api/dispatch/preview", { workspace_id: "refusals", request_id: randomUUID(), assignment_id: randomUUID(), instructions: "Unknown." });
  assert.equal(unknown.status, 503);
  const unknownBody = JSON.parse(unknown.body);
  assert.deepEqual(unknownBody, { error: "Discussion service unavailable." });
  assert.equal(Object.hasOwn(unknownBody, "reason"), false);
  assert.doesNotMatch(unknown.body, /secret|private|failed at/);

  spy.dispatchSaveBrief = () => Promise.reject(Object.assign(new Error(`conflict at ${secret}`), { code: "request-conflict", request_id: REQUEST_ID }));
  const conflict = await spyCall("/api/dispatch/save-brief", { workspace_id: "refusals", request_id: REQUEST_ID, title: "Conflict", content: "body" });
  assert.equal(conflict.status, 409, conflict.body);
  const conflictBody = JSON.parse(conflict.body);
  assert.deepEqual(conflictBody, { error: "This request conflicts with saved state.", reason: "request-conflict" });
  assert.equal(Object.hasOwn(conflictBody, "request_id"), false, "a well-formed request-conflict identifier is never serialized");
  assert.doesNotMatch(conflict.body, /secret|private|conflict at/);

  // The mapped assignment routes share the fixed refusal serializer, so the
  // same request-conflict response must drop the identifier there too.
  spy.previewAssignment = () => Promise.reject(Object.assign(new Error("thread conflict"), { code: "request-conflict", request_id: REQUEST_ID }));
  const threadConflict = await spyCall("/api/thread/preview-assignment", { workspace_id: "refusals", thread_id: randomUUID(), request_id: REQUEST_ID, assignment_id: randomUUID(), instructions: "Conflict." });
  assert.equal(threadConflict.status, 409, threadConflict.body);
  const threadConflictBody = JSON.parse(threadConflict.body);
  assert.deepEqual(threadConflictBody, { error: "This request conflicts with saved state.", reason: "request-conflict" });
  assert.equal(Object.hasOwn(threadConflictBody, "request_id"), false, "the assignment route drops the conflict identifier");

  spy.dispatchSaveBrief = () => Promise.reject(Object.assign(new Error("malformed conflict id"), { code: "request-conflict", request_id: "not-a-uuid" }));
  const malformed = await spyCall("/api/dispatch/save-brief", { workspace_id: "refusals", request_id: randomUUID(), title: "Conflict", content: "body" });
  const malformedBody = JSON.parse(malformed.body);
  assert.deepEqual(malformedBody, { error: "This request conflicts with saved state.", reason: "request-conflict" });
  assert.equal(Object.hasOwn(malformedBody, "request_id"), false, "a malformed conflict UUID is never serialized");
});
