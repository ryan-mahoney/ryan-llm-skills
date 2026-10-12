// Operator JSON dispatch and one bounded SSE stream for /api/threads and
// /api/thread/*.
//
// createDashboardServer composes one instance per server and calls it after
// the dashboard's existing Host/Origin acceptance and after computing
// the operator endpoint authorization and expected same-origin URL. This module
// owns no storage, process or session semantics: it converts HTTP requests into
// service calls, maps typed service codes to static status text, and never copies
// an exception message, request override or filesystem path into a response.
//
// /api/thread/events is a read-only SSE projection: a fresh snapshot from
// list/history, then the service's allowed attributed envelopes. Buffered
// partial frames already reflected in the snapshot watermark are dropped while
// durable queue/state frames are kept, so snapshot plus deltas represent the
// response exactly once. The stream never replays history, never carries the
// action token and never calls a mutating service method synchronously.
//
// The handler returns true when it owned the path (including refusals) and
// false for unrelated routes so the dashboard keeps its existing dispatch.

import { Buffer } from "node:buffer";

const LIST_PATH = "/api/threads";
const HISTORY_PATH = "/api/thread/history";
const EVENTS_PATH = "/api/thread/events";
const PREFIX = "/api/thread/";
const MESSAGE_BODY_LIMIT = 64 * 1024;
const DEFAULT_BODY_LIMIT = 8 * 1024;
const MAX_ACTIVE_STREAMS = 16;
const STREAM_BYTES_LIMIT = 256 * 1024;
const KEEPALIVE_MS = 15000;
const KEEPALIVE_FRAME = ": keepalive\n\n";
const STREAM_TYPES = new Set(["delta", "tool", "message_end", "state", "notice", "settled"]);
const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
  Connection: "keep-alive",
};

// send and save-brief accept a message/brief body; every other write keeps the
// smaller administrative cap.
const LARGE_BODY_PATHS = new Set(["/api/thread/send", "/api/thread/save-brief"]);

const POST_ROUTES = new Map([
  ["/api/thread/create", "create"],
  ["/api/thread/send", "send"],
  ["/api/thread/stop", "stop"],
  ["/api/thread/resume", "resume"],
  ["/api/thread/discard", "discard"],
  ["/api/thread/save-brief", "saveBrief"],
  ["/api/thread/preview-assignment", "previewAssignment"],
  ["/api/thread/launch-assignment", "launchAssignment"],
]);

// Static status mapping. Keys are typed service codes; the response body never
// repeats the code or the exception text. Unknown failures stay unavailable.
const STATUS_BY_CODE = new Map([
  ["invalid-thread", 400],
  ["invalid-message", 400],
  ["invalid-brief", 400],
  ["invalid-handoff", 400],
  ["invalid-cursor", 400],
  ["invalid-query", 400],
  ["thread-not-found", 404],
  ["message-not-found", 404],
  ["brief-not-found", 404],
  ["thread-exists", 409],
  ["request-conflict", 409],
  ["message-not-uncertain", 409],
  ["session-mismatch", 409],
  ["stale-generation", 409],
  ["stale-preview", 409],
  ["live-owner", 409],
  ["history-only", 409],
  ["delivery-uncertain", 409],
  ["service-closed", 503],
  ["child-limit", 503],
]);

const STATUS_TEXT = new Map([
  [400, "Discussion request is invalid."],
  [403, "Discussion access requires an authorized dashboard endpoint."],
  [404, "Discussion resource was not found."],
  [405, "Method not allowed."],
  [409, "Discussion request conflicts with current state."],
  [413, "Discussion request body is too large."],
  [503, "Discussion service unavailable."],
]);

const routeFailure = (status) => Object.assign(new Error("discussion route failure"), { status });

function sendJson(response, method, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(method === "HEAD" || payload === undefined ? undefined : JSON.stringify(payload));
}

function sendStatus(response, status, headers) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...(headers ?? {}) });
  response.end(JSON.stringify({ error: STATUS_TEXT.get(status) ?? "Discussion service unavailable." }));
}

function queryValue(url, name) {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

// Transport-level integer conversion only; the service still owns range and
// semantic validation. A present but malformed value is a static 400.
function strictInteger(value) {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) throw routeFailure(400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw routeFailure(400);
  return parsed;
}

// Refuses a declared oversize before touching the stream, and stops consuming
// at most one chunk past the cap. `tooLarge`/`invalid` are static refusals; the
// caller never sees partial body content.
function readBoundedBody(request, limit) {
  return new Promise((resolve, reject) => {
    const declared = request.headers["content-length"];
    if (declared !== undefined) {
      if (typeof declared !== "string" || !/^\d+$/.test(declared)) {
        resolve({ invalid: true });
        return;
      }
      if (Number(declared) > limit) {
        resolve({ tooLarge: true });
        return;
      }
    }
    let bytes = 0;
    const chunks = [];
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) {
        request.pause();
        settle({ tooLarge: true });
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => settle({ text: Buffer.concat(chunks).toString("utf8") }));
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/**
 * Build the dashboard's thread route handler. `discussion` is the live service
 * or undefined; `actionToken` is the dashboard's per-server token.
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, url: URL, context: {remote?: boolean, expectedOrigin?: string}) => Promise<boolean>}
 */
export function createDiscussionRoutes({ discussion, actionToken } = {}) {
  let activeStreams = 0;

  // One bounded SSE connection. Capacity is claimed before any await so
  // initializing streams count against the server-wide cap, and every exit
  // path (client gone, drain overflow, service close, init failure) funnels
  // through the idempotent cleanup below.
  function serveEvents(request, response, url) {
    if (request.method !== "GET") {
      sendStatus(response, 405, { Allow: "GET" });
      return;
    }
    if (activeStreams >= MAX_ACTIVE_STREAMS) {
      sendStatus(response, 503);
      return;
    }
    activeStreams += 1;
    const workspaceId = queryValue(url, "workspace_id");
    const threadId = queryValue(url, "thread_id");
    const pending = [];
    let pendingBytes = 0;
    let paused = false;
    let initialized = false;
    let snapshotWatermark = null;
    let ended = false;
    let cleaned = false;
    let unsubscribe = null;
    let keepalive = null;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      activeStreams -= 1;
      if (keepalive !== null) {
        clearInterval(keepalive);
        keepalive = null;
      }
      if (unsubscribe !== null) {
        try {
          unsubscribe();
        } catch {
          // The subscription owns its own failure; cleanup still proceeds.
        }
        unsubscribe = null;
      }
      request.removeListener?.("aborted", onClientGone);
      response.removeListener?.("close", onClientGone);
      response.removeListener?.("error", onClientGone);
      response.removeListener?.("drain", onDrain);
    };

    const onClientGone = () => {
      ended = true;
      pending.length = 0;
      pendingBytes = 0;
      cleanup();
    };

    const onDrain = () => {
      if (ended || cleaned) return;
      paused = false;
      flushPending();
    };

    const overflow = (bytes) => pendingBytes + (response.writableLength ?? 0) + bytes > STREAM_BYTES_LIMIT;

    // A buffered partial-affecting frame whose sequence is at or below the
    // snapshot watermark is already represented by snapshot.partial and must
    // not replay. Queue/state/notice (and tool/settled) frames are always
    // retained because their durable list record may be older than the
    // snapshot. Unknown watermarks or sequences keep the previous behavior.
    const reflectsSnapshot = (frame) =>
      Number.isSafeInteger(snapshotWatermark) &&
      (frame.type === "delta" || frame.type === "message_end") &&
      Number.isSafeInteger(frame.sequence) &&
      frame.sequence <= snapshotWatermark;

    // A frame the socket accepted (even one that returned false) is never
    // retried; only frames that follow it are queued until drain.
    const flushPending = () => {
      while (!ended && !paused && pending.length > 0) {
        const frame = pending.shift();
        pendingBytes -= frame.bytes;
        if (reflectsSnapshot(frame)) continue;
        if (!response.write(frame.text)) paused = true;
      }
    };

    const writeFrame = (type, data, sequence = null) => {
      if (ended || cleaned) return;
      const text = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      const bytes = Buffer.byteLength(text);
      if (overflow(bytes)) {
        failStream();
        return;
      }
      if (!initialized || paused) {
        pending.push({ text, bytes, type, sequence });
        pendingBytes += bytes;
        return;
      }
      if (!response.write(text)) paused = true;
    };

    const endStream = () => {
      if (ended || cleaned) return;
      ended = true;
      pending.length = 0;
      pendingBytes = 0;
      if (!initialized) {
        try {
          sendStatus(response, 503);
        } catch {
          // The client may already be gone; capacity is still released.
        }
      } else {
        try {
          response.end?.();
        } catch {
          // The client may already be gone; capacity is still released.
        }
      }
      cleanup();
    };

    const failStream = () => {
      if (ended || cleaned) return;
      ended = true;
      pending.length = 0;
      pendingBytes = 0;
      try {
        response.destroy?.();
      } catch {
        // The client may already be gone; capacity is still released.
      }
      cleanup();
    };

    const onServiceEvent = (envelope) => {
      if (ended || cleaned) return;
      if (!envelope || envelope.workspace_id !== workspaceId || envelope.thread_id !== threadId) return;
      if (envelope.type === "closed") {
        endStream();
        return;
      }
      if (!STREAM_TYPES.has(envelope.type)) return;
      // `sequence` is the frame's event watermark; the snapshot carries the
      // projection watermark used to discard only already-reflected deltas.
      writeFrame(envelope.type, {
        thread_id: envelope.thread_id,
        generation: envelope.generation ?? null,
        type: envelope.type,
        event: envelope.event,
        sequence: envelope.sequence ?? null,
      }, envelope.sequence);
    };

    const endWithStatus = (status) => {
      cleanup();
      sendStatus(response, status);
    };

    const start = async () => {
      try {
        // Subscribe before the async snapshot reads: concurrent envelopes are
        // buffered so the snapshot frame always writes first without loss.
        unsubscribe = discussion.subscribe({ workspace_id: workspaceId, thread_id: threadId }, onServiceEvent);
        const listed = await discussion.list({ workspace_id: workspaceId });
        if (ended || cleaned) return;
        const thread = (listed?.threads ?? []).find((entry) => entry.thread_id === threadId);
        if (thread === undefined) {
          endWithStatus(404);
          return;
        }
        const branch = await discussion.history({ workspace_id: workspaceId, thread_id: threadId });
        if (ended || cleaned) return;
        const watermark = Number.isSafeInteger(thread.watermark) ? thread.watermark : null;
        snapshotWatermark = watermark;
        const snapshot = {
          thread_id: threadId,
          generation: thread.generation ?? null,
          state: thread.state,
          queue: thread.queue,
          partial: thread.partial,
          owns_response: thread.owns_response === true,
          queue_paused: thread.queue_paused === true,
          last_persisted_id: branch?.leaf_id ?? null,
          attention: thread.attention ?? null,
          watermark,
        };
        response.writeHead(200, SSE_HEADERS);
        initialized = true;
        writeFrame("snapshot", snapshot);
        flushPending();
        // An over-cap snapshot destroys the stream during the writes above; do
        // not recreate a keepalive over the cleaned-up connection.
        if (ended || cleaned) return;
        keepalive = setInterval(() => {
          if (ended || cleaned || paused) return;
          if (overflow(Buffer.byteLength(KEEPALIVE_FRAME))) {
            failStream();
            return;
          }
          if (!response.write(KEEPALIVE_FRAME)) paused = true;
        }, KEEPALIVE_MS);
        if (typeof keepalive?.unref === "function") keepalive.unref();
      } catch (error) {
        if (ended || cleaned) return;
        const status = STATUS_BY_CODE.get(error?.code) ?? error?.status ?? 503;
        const safe = STATUS_TEXT.has(status) ? status : 503;
        if (initialized) failStream();
        else endWithStatus(safe);
      }
    };

    // IncomingMessage 'close' also fires after a normal request is fully read,
    // so only 'aborted' marks a lost client; response close/error cover the
    // remaining disconnect paths.
    request.on("aborted", onClientGone);
    response.on("close", onClientGone);
    response.on("error", onClientGone);
    response.on("drain", onDrain);
    void start();
  }

  return async function handleDiscussionRoute(request, response, url, { remote, expectedOrigin } = {}) {
    const path = url.pathname;
    if (path !== LIST_PATH && !path.startsWith(PREFIX)) return false;
    // The dashboard authorizes loopback and its configured public host. Other
    // remote requests are refused before route, method or service handling.
    if (remote === true) {
      sendStatus(response, 403);
      return true;
    }
    if (!discussion) {
      sendStatus(response, 503);
      return true;
    }
    try {
      if (path === LIST_PATH) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          sendStatus(response, 405, { Allow: "GET, HEAD" });
          return true;
        }
        const result = await discussion.list({ workspace_id: queryValue(url, "workspace_id") });
        sendJson(response, request.method, 200, result);
        return true;
      }
      if (path === HISTORY_PATH) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          sendStatus(response, 405, { Allow: "GET, HEAD" });
          return true;
        }
        const result = await discussion.history({
          workspace_id: queryValue(url, "workspace_id"),
          thread_id: queryValue(url, "thread_id"),
          before: queryValue(url, "before"),
          limit: strictInteger(queryValue(url, "limit")),
        });
        sendJson(response, request.method, 200, result);
        return true;
      }
      if (path === EVENTS_PATH) {
        serveEvents(request, response, url);
        return true;
      }
      const method = POST_ROUTES.get(path);
      if (method === undefined) {
        sendStatus(response, 404);
        return true;
      }
      if (request.method !== "POST") {
        sendStatus(response, 405, { Allow: "POST" });
        return true;
      }
      // Authorization is static and complete before any body byte is read or
      // parsed: the operator endpoint's Origin, the dashboard token and JSON only.
      if (
        request.headers.origin?.toLowerCase() !== (expectedOrigin ?? `http://${request.headers.host}`).toLowerCase() ||
        typeof actionToken !== "string" ||
        request.headers["x-sentinel-token"] !== actionToken ||
        request.headers["content-type"] !== "application/json"
      ) {
        sendStatus(response, 403);
        return true;
      }
      const body = await readBoundedBody(request, LARGE_BODY_PATHS.has(path) ? MESSAGE_BODY_LIMIT : DEFAULT_BODY_LIMIT);
      if (body.tooLarge) {
        sendStatus(response, 413);
        return true;
      }
      if (body.invalid) {
        sendStatus(response, 400);
        return true;
      }
      let input;
      try {
        input = JSON.parse(body.text);
      } catch {
        sendStatus(response, 400);
        return true;
      }
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        sendStatus(response, 400);
        return true;
      }
      const result = await discussion[method](input);
      sendJson(response, "POST", 200, result);
      return true;
    } catch (error) {
      const status = STATUS_BY_CODE.get(error?.code) ?? error?.status ?? 503;
      sendStatus(response, STATUS_TEXT.has(status) ? status : 503);
      return true;
    }
  };
}
