// Step 7 focused tests: HTTP authorization, mapping, the real service
// boundary and the bounded SSE stream for the local /api/threads and
// /api/thread/* routes.
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
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardServer } from "../spec-observe/dashboard.mjs";
import { createDiscussionService } from "./discussion.mjs";
import { createDiscussionRoutes } from "./discussion-routes.mjs";
import { createWorkspace, setupStorage } from "./store.mjs";

const PUBLIC_HOST = "host.example.ts.net";
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
  for (const name of ["create", "list", "history", "send", "stop", "resume", "discard", "saveBrief", "previewAssignment", "launchAssignment", "subscribe"]) {
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

test("remote-classified requests are refused for every thread route before the service runs", async (t) => {
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
    ...POST_PATHS.map((path) => ({ label: path, path, write: true })),
    { label: "unknown", path: "/api/thread/bogus" },
  ];
  // Host/Origin acceptance must not be mistaken for locality: the configured
  // public host is accepted upstream, while forwarded/tailscale indicators are
  // the only remote signal for a loopback Host.
  const variants = [
    { label: "configured public Host", options: { host: PUBLIC_HOST } },
    { label: "configured public Host :443", options: { host: `${PUBLIC_HOST}:443` } },
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
  // The public-host writes carry their accepted same-origin Origin, so only the
  // remote classification can refuse them; forwarded writes keep the loopback
  // Host and Origin absent.
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
  assert.deepEqual(spy.calls.map((call) => call.name), [], "send must not run for remote requests");
});

test("local writes refuse before the service or the body when Origin, token or content type is wrong", async (t) => {
  const f = await fixtureStorage(t);
  const spy = serviceSpy();
  const server = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot, discussion: spy });
  const port = await listen(t, server);
  const origin = `http://127.0.0.1:${port}`;
  const token = await actionToken(port);
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

test("authorized local writes map one-to-one onto service methods with unchanged payloads", async (t) => {
  const f = await fixtureStorage(t);
  const spy = serviceSpy();
  const server = createDashboardServer({ agentDir: f.dir, storageRoot: f.storageRoot, discussion: spy });
  const port = await listen(t, server);
  const token = await actionToken(port);
  const origin = `http://127.0.0.1:${port}`;

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

test("the real discussion service serves create/list/history/save-brief over the dashboard seam", async (t) => {
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

  const createdResponse = await write("/api/thread/create", {
    workspace_id: "fixture",
    title: "HTTP thread",
    target: { kind: "workspace" },
  });
  assert.equal(createdResponse.status, 200);
  const created = JSON.parse(createdResponse.body);
  assert.match(created.thread_id, UUID_RE);
  assert.equal(created.workspace_id, "fixture");

  const listedResponse = await httpCall(port, `/api/threads?${new URLSearchParams({ workspace_id: "fixture" })}`);
  assert.equal(listedResponse.status, 200);
  assert.ok(JSON.parse(listedResponse.body).threads.some((thread) => thread.thread_id === created.thread_id));

  const historyResponse = await httpCall(port, `/api/thread/history?${new URLSearchParams({ workspace_id: "fixture", thread_id: created.thread_id })}`);
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
  const badUuid = await httpCall(port, `/api/thread/history?${new URLSearchParams({ workspace_id: "fixture", thread_id: "not-a-uuid" })}`);
  assert.equal(badUuid.status, 400);
  const badLimit = await httpCall(port, `/api/thread/history?${new URLSearchParams({ workspace_id: "fixture", thread_id: created.thread_id, limit: "abc" })}`);
  assert.equal(badLimit.status, 400);
  assert.equal((await write("/api/thread/create", { workspace_id: "../escape", title: "Bad workspace" })).status, 400);
  assert.equal((await write("/api/thread/create", { workspace_id: "fixture", title: "Bad path", target: { kind: "worktree", path: "relative/path" } })).status, 400);
  const missing = await httpCall(port, `/api/thread/history?${new URLSearchParams({ workspace_id: "fixture", thread_id: randomUUID() })}`);
  assert.equal(missing.status, 404);
});

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
