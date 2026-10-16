// Protected request HTTP boundary: GET /api/request/speech and the POST
// operations /api/request/transcribe and /api/request/interpret.
//
// createDashboardServer composes one instance per server and calls it after
// the dashboard's existing Host/Origin acceptance with the same
// remote/expectedOrigin context the discussion routes receive. This module
// owns no storage, launch or persistence semantics: it validates bounded
// typed input, runs at most one in-flight call per operation kind, maps
// typed outcomes to static status text, and never copies an exception
// message, child output or filesystem path into a response.
//
// Default services are the real adapters: speech is createSpeechAdapter over
// SENTINEL_SPEECH_CHECKOUT, and interpretation authorizes the requested kit
// per request before createInterpreter runs through the shared printReply
// runner. The optional requestServices seam overrides the speech adapter, the
// interpret function, or the spawn passed to the real speech/printReply final
// child boundary only; route authorization and validation run identically
// with overrides in place.
//
// No audio or transcript bytes are written to disk and nothing is cached or
// retained: the two feature-private slots hold only the current operation of
// each kind, and a settled operation releases its slot.

import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";

import { printReply } from "../workspaces/naming.mjs";
import { REQUEST_LIMITS } from "../workspaces/request-actions.mjs";
import { canonicalIdentifier, createInterpreter, isTypedRef } from "./request-interpret.mjs";
import { createSpeechAdapter } from "./request-speech.mjs";

const SPEECH_PATH = "/api/request/speech";
const TRANSCRIBE_PATH = "/api/request/transcribe";
const INTERPRET_PATH = "/api/request/interpret";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_BODY_LIMIT = 16 * 1024;
const AUDIO_BODY_LIMIT = REQUEST_LIMITS.maxAudioBytes;

// Static refusal table: one fixed card code and one fixed sentence per
// condition. Bodies are exactly {error:<code>,reason:<sentence>}; nothing
// derived from an exception, request field or child output is ever echoed.
const REFUSALS = new Map([
  ["locality", [403, "Request access requires an authorized dashboard endpoint."]],
  ["token", [403, "Request access requires the dashboard action token."]],
  ["origin", [403, "Request access requires the dashboard origin."]],
  ["mime", [403, "Request body type is not accepted."]],
  ["invalid-request", [400, "Request is invalid."]],
  ["input-too-long", [400, "The request transcript is too long."]],
  ["oversize", [413, "Request body is too large."]],
  ["workspace-unavailable", [404, "Workspace is unavailable."]],
  ["superseded", [409, "A newer request replaced this one."]],
  ["request-conflict", [409, "This request conflicts with an active request."]],
  ["interpretation-failed", [502, "Request interpretation failed."]],
  ["transcription-failed", [502, "Speech transcription failed."]],
  ["no-speech", [422, "No speech was detected in the provided audio."]],
  ["unavailable", [503, "Speech transcription is unavailable."]],
]);

function sendRefusal(response, code) {
  const [status, reason] = REFUSALS.get(code);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: code, reason }));
}

function sendJson(response, payload) {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

// Method mismatches keep the house static 405 with Allow; the body stays in
// the request refusal shape.
function sendMethod(response, allow) {
  response.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: allow });
  response.end(JSON.stringify({ error: "invalid-request", reason: "Method not allowed." }));
}

function writeOutcome(response, outcome) {
  if (outcome.error !== undefined) sendRefusal(response, outcome.error);
  else sendJson(response, outcome.ok);
}

// Refuses a declared oversize before touching the stream and stops consuming
// at most one chunk past the cap; `tooLarge`/`invalid` are static refusals and
// the caller never sees partial body content.
function readBody(request, limit) {
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
    const chunks = [];
    let bytes = 0;
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
    request.on("end", () => settle({ bytes: Buffer.concat(chunks) }));
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

// Deterministic JSON for interpretation fingerprints: object keys sorted,
// array order preserved. Only validated payload fields are hashed, never the
// request id (identity is the id plus this digest).
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const digest = (value) => createHash("sha256").update(value).digest("hex");

// Little-endian Float32 PCM; any nonfinite sample refuses the input.
function decodePcm(bytes) {
  const samples = new Float32Array(bytes.length / 4);
  for (let i = 0; i < samples.length; i++) {
    const sample = bytes.readFloatLE(i * 4);
    if (!Number.isFinite(sample)) return null;
    samples[i] = sample;
  }
  return samples;
}

// One active operation per kind. A matching (id, fingerprint) joins the
// in-flight response promise, a matching id with different input conflicts,
// and a new id immediately answers the current caller superseded and aborts
// its call while the replacement awaits the previous drain promise — so a
// rapid A→B→C keeps C behind A even when B never starts. Only the current
// entry may clear the slot, and only at settle; a settled slot releases and a
// retry of the same id starts a fresh call.
function createOperationSlot() {
  let current = null;

  function supersede(entry) {
    entry.superseded = true;
    entry.resolveResponse({ error: "superseded" });
    try {
      entry.controller.abort();
    } catch {
      // Abort delivery is best effort; the drain promise still bounds reuse.
    }
  }

  return function runExclusive(id, fingerprint, run, fallback) {
    const active = current;
    if (active !== null && active.id === id) {
      if (active.fingerprint === fingerprint) return active.response;
      return Promise.resolve({ error: "request-conflict" });
    }
    let previousDrain = Promise.resolve();
    if (active !== null) {
      supersede(active);
      previousDrain = active.drain;
    }
    const controller = new AbortController();
    let resolveResponse;
    const response = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    let releaseDrain;
    const drain = new Promise((resolve) => {
      releaseDrain = resolve;
    });
    const entry = { id, fingerprint, controller, response, resolveResponse, drain, superseded: false };
    current = entry;
    void (async () => {
      await previousDrain;
      // Superseded before start: never call the service and pass the inherited
      // drain straight through to whoever replaced this entry.
      if (entry.superseded) {
        releaseDrain();
        return;
      }
      let outcome;
      try {
        outcome = await run(controller.signal);
      } catch {
        outcome = { error: fallback };
      }
      if (!entry.superseded) entry.resolveResponse(outcome);
      releaseDrain();
      if (current === entry) current = null;
    })();
    return response;
  };
}

// POST authorization is static and complete before any body byte is read or
// parsed: locality, the operator endpoint's exact Origin, the dashboard token
// and then the route's exact MIME type.
function postRefusal(request, remote, expectedOrigin, actionToken, mime) {
  if (remote === true) return "locality";
  if (typeof actionToken !== "string" || request.headers["x-sentinel-token"] !== actionToken) return "token";
  // The card requires the exact origin: no case folding, so an Origin that
  // only matches after lowercasing is refused here.
  if (request.headers.origin !== (expectedOrigin ?? `http://${request.headers.host}`)) return "origin";
  if (request.headers["content-type"] !== mime) return "mime";
  return null;
}

/**
 * Build the dashboard's request route handler. `actionToken` is the
 * dashboard's per-server token, `authorizedKit` resolves a workspace id to
 * its uniquely authorized kit record, `storageRoot` feeds the default
 * interpreter, and `requestServices` optionally overrides the speech
 * adapter, the interpret function or the final-child spawn.
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, url: URL, context: {remote?: boolean, expectedOrigin?: string}) => Promise<boolean>}
 */
export function createRequestRoutes({ actionToken, authorizedKit, storageRoot, requestServices } = {}) {
  const spawn = requestServices?.spawn ?? nodeSpawn;
  const speech = requestServices?.speech ?? createSpeechAdapter({ checkout: process.env.SENTINEL_SPEECH_CHECKOUT, spawn });
  // The default interpretation authorizes the requested kit per request, then
  // constructs one interpreter over the shared printReply runner; the spawn
  // override reaches only that final child boundary.
  const interpretRequest =
    requestServices?.interpret ??
    (async (input, signal) => {
      const kit = await authorizedKit(input.workspace_id);
      const interpreter = createInterpreter({
        storageRoot,
        authorizedKit: kit,
        print: (options) => printReply({ ...options, spawn }),
      });
      return interpreter.interpret(input, signal);
    });
  const transcribeSlot = createOperationSlot();
  const interpretSlot = createOperationSlot();

  function serveSpeech(response) {
    return Promise.resolve()
      .then(() => speech.readiness())
      .then((ready) => {
        sendJson(response, {
          state: ready.status,
          host: ready.host,
          limit_seconds: REQUEST_LIMITS.recordingSeconds,
          sample_rate: REQUEST_LIMITS.sampleRateHz,
        });
      })
      .catch(() => sendRefusal(response, "unavailable"));
  }

  async function serveTranscribe(request, response, url, expectedOrigin) {
    if (request.method !== "POST") {
      sendMethod(response, "POST");
      return;
    }
    const refused = postRefusal(request, false, expectedOrigin, actionToken, "application/octet-stream");
    if (refused !== null) {
      sendRefusal(response, refused);
      return;
    }
    const requestId = url.searchParams.get("request_id");
    if (typeof requestId !== "string" || !UUID_PATTERN.test(requestId)) {
      sendRefusal(response, "invalid-request");
      return;
    }
    let body;
    try {
      body = await readBody(request, AUDIO_BODY_LIMIT);
    } catch {
      sendRefusal(response, "invalid-request");
      return;
    }
    if (body.tooLarge) {
      sendRefusal(response, "oversize");
      return;
    }
    const bytes = body.bytes;
    if (body.invalid || bytes === undefined || bytes.length === 0 || bytes.length % 4 !== 0) {
      sendRefusal(response, "invalid-request");
      return;
    }
    const samples = decodePcm(bytes);
    if (samples === null) {
      sendRefusal(response, "invalid-request");
      return;
    }
    // The fingerprint covers the original audio bytes, so identical clips
    // join one transcription and any byte difference conflicts.
    const outcome = await transcribeSlot(
      requestId,
      digest(bytes),
      async (signal) => {
        try {
          const text = await speech.transcribe(samples, signal);
          return { ok: { request_id: requestId, text, seconds: samples.length / REQUEST_LIMITS.sampleRateHz } };
        } catch (error) {
          return { error: error?.code === "unavailable" || error?.code === "no-speech" ? error.code : "transcription-failed" };
        }
      },
      "transcription-failed",
    );
    writeOutcome(response, outcome);
  }

  async function serveInterpret(request, response, expectedOrigin) {
    if (request.method !== "POST") {
      sendMethod(response, "POST");
      return;
    }
    const refused = postRefusal(request, false, expectedOrigin, actionToken, "application/json");
    if (refused !== null) {
      sendRefusal(response, refused);
      return;
    }
    let body;
    try {
      body = await readBody(request, JSON_BODY_LIMIT);
    } catch {
      sendRefusal(response, "invalid-request");
      return;
    }
    if (body.tooLarge) {
      sendRefusal(response, "oversize");
      return;
    }
    let input;
    try {
      input = JSON.parse(body.bytes.toString("utf8"));
    } catch {
      sendRefusal(response, "invalid-request");
      return;
    }
    // JSON bodies carry plain values only, so a non-null non-array object is
    // the plain-object contract the interpreter enforces again.
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      sendRefusal(response, "invalid-request");
      return;
    }
    const requestId = input.request_id;
    if (typeof requestId !== "string" || !UUID_PATTERN.test(requestId)) {
      sendRefusal(response, "invalid-request");
      return;
    }
    let workspace;
    try {
      workspace = canonicalIdentifier(input.workspace_id, "workspace");
    } catch {
      sendRefusal(response, "invalid-request");
      return;
    }
    const transcript = input.transcript;
    if (typeof transcript !== "string" || transcript.trim() === "") {
      sendRefusal(response, "invalid-request");
      return;
    }
    if (transcript.length > REQUEST_LIMITS.transcriptChars) {
      sendRefusal(response, "input-too-long");
      return;
    }
    const context = input.context;
    if (context !== undefined && (context === null || typeof context !== "object" || Array.isArray(context))) {
      sendRefusal(response, "invalid-request");
      return;
    }
    const resolvedRefs = input.resolved_refs;
    if (resolvedRefs !== undefined && (!Array.isArray(resolvedRefs) || !resolvedRefs.every(isTypedRef))) {
      sendRefusal(response, "invalid-request");
      return;
    }
    // Authorization runs at the boundary even when services are overridden.
    try {
      await authorizedKit(workspace);
    } catch {
      sendRefusal(response, "workspace-unavailable");
      return;
    }
    const serviceInput = { workspace_id: workspace, transcript, context, resolved_refs: resolvedRefs };
    const payload = {
      workspace_id: workspace,
      transcript,
      context: context ?? null,
      resolved_refs: resolvedRefs ?? null,
    };
    const outcome = await interpretSlot(
      requestId,
      digest(stableJson(payload)),
      async (signal) => {
        // Captured before the service call so the catalog observation time
        // never trails the read it reports.
        const readAt = new Date().toISOString();
        try {
          const result = await interpretRequest(serviceInput, signal);
          if (
            result === null ||
            typeof result !== "object" ||
            !["proposal", "clarification", "unsupported"].includes(result.resolution)
          ) {
            return { error: "interpretation-failed" };
          }
          return {
            ok: {
              request_id: requestId,
              resolution: result.resolution,
              candidates: Array.isArray(result.candidates) ? result.candidates : [],
              unresolved_references: [],
              clarification:
                result.resolution === "clarification" ? { question: result.question, options: result.options } : null,
              catalog: { read_at: readAt, omitted: result.omissions, errors: result.sourceErrors },
            },
          };
        } catch (error) {
          return { error: error?.code === "invalid-request" ? "invalid-request" : "interpretation-failed" };
        }
      },
      "interpretation-failed",
    );
    writeOutcome(response, outcome);
  }

  return async function handleRequestRoute(request, response, url, { remote, expectedOrigin } = {}) {
    const path = url.pathname;
    if (path !== SPEECH_PATH && path !== TRANSCRIBE_PATH && path !== INTERPRET_PATH) return false;
    // The dashboard authorizes loopback and its configured public host.
    // Other remote requests are refused before method or body handling.
    if (remote === true) {
      sendRefusal(response, "locality");
      return true;
    }
    if (path === SPEECH_PATH) {
      if (request.method !== "GET") {
        sendMethod(response, "GET");
        return true;
      }
      // Locality above is the only GET gate; no token or origin is required.
      await serveSpeech(response);
      return true;
    }
    if (path === TRANSCRIBE_PATH) {
      await serveTranscribe(request, response, url, expectedOrigin);
      return true;
    }
    await serveInterpret(request, response, expectedOrigin);
    return true;
  };
}
