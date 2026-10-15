// Focused EV-4 HTTP composition coverage for the protected request boundary
// (scripts/spec-observe/request-routes.mjs) wired through the real
// createDashboardServer on loopback and the configured public host.
//
// Run all: node --test scripts/spec-observe/request-routes.test.mjs
// Selectable case: node --test --test-name-pattern="<case name>" scripts/spec-observe/request-routes.test.mjs
//
// Isolated temp agent/storage roots and a real valid kit fixture (same shape
// as request-interpret.test.mjs) back every case. Scenario 1 composes the
// DEFAULT adapters and fakes only the final child boundaries: the ASR daemon
// runs as a real child speaking the wire protocol via
// fixtures/fake-asr-daemon.mjs, and the pi print child is faked like
// request-interpret.test.mjs. Scenarios 2 and 3 inject service doubles at the
// requestServices seam. Nothing here touches live Sentinel/workspace storage,
// a real ASR engine or a model provider.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeFixture, put } from "../spec-location/fixture.mjs";
import { REQUEST_LIMITS } from "../workspaces/request-actions.mjs";
import { INTERPRET_MODEL } from "./request-interpret.mjs";
import { createDashboardServer } from "./dashboard.mjs";

const daemonFixture = fileURLToPath(new URL("./fixtures/fake-asr-daemon.mjs", import.meta.url));
const WORKER_ARGS = ["run", "server/asr/asrDaemonWorker.ts"];
const PI_FREE_FLAGS = ["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"];
const PUBLIC_HOST = "sentinel.example";
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

// Pinned static card reasons (scripts/spec-observe/request-routes.mjs REFUSALS).
const REASON = {
  locality: "Request access requires an authorized dashboard endpoint.",
  token: "Request access requires the dashboard action token.",
  origin: "Request access requires the dashboard origin.",
  mime: "Request body type is not accepted.",
  "invalid-request": "Request is invalid.",
  "input-too-long": "The request transcript is too long.",
  oversize: "Request body is too large.",
  "workspace-unavailable": "Workspace is unavailable.",
  superseded: "A newer request replaced this one.",
  "request-conflict": "This request conflicts with an active request.",
  "interpretation-failed": "Request interpretation failed.",
  "transcription-failed": "Speech transcription failed.",
  "no-speech": "No speech was detected in the provided audio.",
  unavailable: "Speech transcription is unavailable.",
};

const EPIC_RECORD = {
  schema_version: 1,
  epic: "demo-epic",
  title: "Demo epic",
  state: "planned",
  packages: [{ package: "alpha" }],
};
const DESIGN_RECORD = {
  schema_version: 1,
  design: "01-login",
  title: "Login",
  viewport: { posture: "desktop-only", widths: [1280] },
  screens: [
    { step: 1, id: "login", title: "Login", person: "a returning user", job: "sign in", kind: "decision", state: "ideal" },
  ],
};

// Fixture workspace: kit.yaml (via makeFixture), spec directories, one valid
// epic record, one valid design index, one regular plan file and one
// symlinked plan that must never enter the catalog. A second authorized
// workspace "other" supports workspace-identity conflict cases.
function populateFixture(fx) {
  const wsDir = fx.workspaceDir;
  mkdirSync(join(wsDir, "specs", "alpha"), { recursive: true });
  mkdirSync(join(wsDir, "specs", "beta"), { recursive: true });
  put(join(wsDir, "epics", "demo-epic", "epic.json"), JSON.stringify(EPIC_RECORD));
  put(join(wsDir, "designs", "01-login", "design.json"), JSON.stringify(DESIGN_RECORD));
  put(join(wsDir, "plans", "roadmap.md"), "# roadmap\n");
  symlinkSync(join(wsDir, "plans", "roadmap.md"), join(wsDir, "plans", "link.md"));
  put(join(fx.root, "projects", "other", "kit.yaml"), fx.kit("other"));
}

function pcm(...samples) {
  const bytes = Buffer.alloc(samples.length * 4);
  samples.forEach((sample, index) => bytes.writeFloatLE(sample, index * 4));
  return bytes;
}

function listen(t, server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      t.after(() => new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }));
      resolve(port);
    });
  });
}

// Raw HTTP with full Host/Origin control, mirroring
// discussion-routes.test.mjs: declared oversize sends headers only
// (uploaded 0), and a body without content-length is Transfer-Encoding chunked.
function httpCall(port, path, {
  host = `127.0.0.1:${port}`,
  origin,
  method = "GET",
  headers = {},
  body,
  headersOnly = false,
  deadline = 20000,
} = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let deadlineTimer;
    let uploaded = 0;
    const settle = (action) => {
      if (done) return;
      done = true;
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
        ...(origin !== undefined ? { origin } : {}),
        ...headers,
        host,
      },
    }, (incoming) => {
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
  const res = await httpCall(port, "/api/state");
  assert.equal(res.status, 200);
  return JSON.parse(res.body).action_token;
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeCheckout(t) {
  const dir = mkdtempSync(join(tmpdir(), "request-routes-"));
  mkdirSync(join(dir, "server", "asr"), { recursive: true });
  writeFileSync(join(dir, "server", "asr", "asrDaemonWorker.ts"), "// test worker placeholder\n");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PROPOSAL_REPLY = JSON.stringify({
  resolution: "proposal",
  candidates: [{
    action: "implement_spec",
    workspace: "demo",
    entity: "spec:alpha",
    uses: [],
    resolved_refs: [],
    research: { code: "unspecified" },
    goal: "Implement alpha",
    constraints: [],
  }],
  options: [],
  question: "",
});

// Replaces ONLY the final child boundaries: the speech daemon runs as a real
// node child of fixtures/fake-asr-daemon.mjs (asserting the bun argv/cwd), and
// the pi print child is a fake that emits one reply then closes.
function boundarySpawn({ checkout, daemonReport, daemonEnv = {}, piReply }) {
  const record = { daemon: [], piArgs: [], piCloses: 0 };
  const spawn = (command, args, options) => {
    if (command === "bun") {
      assert.deepEqual(args, WORKER_ARGS);
      assert.equal(options.cwd, checkout);
      const child = nodeSpawn(process.execPath, [daemonFixture, "happy"], {
        ...options,
        env: { ...process.env, FAKE_ASR_SCENARIO: "happy", FAKE_ASR_REPORT: daemonReport, ...daemonEnv },
      });
      record.daemon.push(child);
      return child;
    }
    assert.equal(command, "pi");
    record.piArgs.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.pid = 4242;
    child.kill = () => true;
    setImmediate(() => {
      if (piReply != null) child.stdout.emit("data", Buffer.from(piReply, "utf8"));
      record.piCloses += 1;
      child.emit("close", 0);
    });
    return child;
  };
  return { spawn, record };
}

test("default adapters over fake final children accept loopback and public-host operator requests", { timeout: 30000 }, async (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  populateFixture(fx);
  const checkout = makeCheckout(t);
  const previousCheckout = process.env.SENTINEL_SPEECH_CHECKOUT;
  process.env.SENTINEL_SPEECH_CHECKOUT = checkout;
  t.after(() => {
    if (previousCheckout === undefined) delete process.env.SENTINEL_SPEECH_CHECKOUT;
    else process.env.SENTINEL_SPEECH_CHECKOUT = previousCheckout;
  });
  const daemonReport = join(checkout, "report.json");
  // Hand-derived vector: 6 samples; the default adapter writes 1 input frame
  // plus 3.5 s of padding (56000 zero samples) before the delayed finals.
  const input = pcm(0.5, -0.25, 0.125, -1, 0.75, 2);
  const { spawn, record } = boundarySpawn({
    checkout,
    daemonReport,
    daemonEnv: {
      FAKE_ASR_FINAL_AFTER_SAMPLES: String(6 + 56000),
      FAKE_ASR_TEXT: "hello there",
      FAKE_ASR_TEXT_2: "world",
    },
    piReply: PROPOSAL_REPLY,
  });
  t.after(() => {
    for (const child of record.daemon) {
      try { child.kill("SIGKILL"); } catch { /* owned fixture cleanup is best effort */ }
    }
  });
  const agentDir = join(fx.tmp, "agent");
  mkdirSync(agentDir, { recursive: true });
  const server = createDashboardServer({ agentDir, storageRoot: fx.root, publicHost: PUBLIC_HOST, requestServices: { spawn } });
  const port = await listen(t, server);
  const token = await actionToken(port);
  const loopbackOrigin = `http://127.0.0.1:${port}`;

  // GET: speech ready state with the exact card shape, loopback and public host.
  for (const host of [`127.0.0.1:${port}`, PUBLIC_HOST]) {
    const res = await httpCall(port, "/api/request/speech", { host });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body).sort(), ["host", "limit_seconds", "sample_rate", "state"]);
    assert.equal(body.state, "ready");
    assert.equal(typeof body.host, "string");
    assert.ok(body.host.length > 0);
    assert.equal(body.limit_seconds, REQUEST_LIMITS.recordingSeconds);
    assert.equal(body.sample_rate, REQUEST_LIMITS.sampleRateHz);
  }

  // POST transcribe over loopback: the daemon receives hand-derived PCM and
  // the response carries the joined finals and sample-derived seconds.
  const transcribe = await httpCall(port, `/api/request/transcribe?request_id=${UUID_A}`, {
    method: "POST",
    origin: loopbackOrigin,
    headers: { "x-sentinel-token": token, "content-type": "application/octet-stream" },
    body: input,
  });
  assert.equal(transcribe.status, 200);
  assert.deepEqual(JSON.parse(transcribe.body), {
    request_id: UUID_A,
    text: "hello there world",
    seconds: input.length / 4 / REQUEST_LIMITS.sampleRateHz,
  });
  const report = JSON.parse(readFileSync(daemonReport, "utf8"));
  assert.equal(report.samples.length, 6 + 56000);
  assert.deepEqual(report.samples.slice(0, 6), [0.5, -0.25, 0.125, -1, 0.75, 2]);
  assert.ok(report.samples.slice(6).every((sample) => sample === 0), "padding frames are zero");
  assert.equal(report.requests.filter((entry) => entry === "audio").length, 36);
  assert.equal(report.requests[report.requests.length - 1], "shutdown");
  assert.equal(report.shutdownSeen, true);

  // POST interpret over the configured public host (exact https origin).
  const interpret = await httpCall(port, "/api/request/interpret", {
    host: PUBLIC_HOST,
    origin: `https://${PUBLIC_HOST}`,
    method: "POST",
    headers: { "x-sentinel-token": token, "content-type": "application/json" },
    body: JSON.stringify({
      request_id: UUID_B,
      workspace_id: "demo",
      transcript: "Please implement alpha",
      context: { page: "specs/alpha" },
      resolved_refs: ["spec:alpha"],
    }),
  });
  assert.equal(interpret.status, 200);
  const proposal = JSON.parse(interpret.body);
  assert.deepEqual(Object.keys(proposal).sort(), ["candidates", "catalog", "clarification", "request_id", "resolution", "unresolved_references"]);
  assert.equal(proposal.request_id, UUID_B);
  assert.equal(proposal.resolution, "proposal");
  assert.deepEqual(proposal.candidates, [{
    action: "implement_spec",
    workspace: "demo",
    entity: "spec:alpha",
    uses: [],
    resolved_refs: [],
    research: { code: "unspecified" },
    goal: "Implement alpha",
    constraints: [],
  }]);
  assert.deepEqual(proposal.unresolved_references, []);
  assert.equal(proposal.clarification, null);
  assert.deepEqual(Object.keys(proposal.catalog).sort(), ["errors", "omitted", "read_at"]);
  assert.ok(Number.isFinite(Date.parse(proposal.catalog.read_at)), "read_at is a timestamp captured before the call");
  assert.ok(Number.isInteger(proposal.catalog.omitted) && proposal.catalog.omitted >= 0);
  assert.deepEqual(proposal.catalog.errors, []);

  // Second valid interpretation over loopback with a new identity and the
  // same payload: both operator endpoints run the default interpretation path.
  const loopInterpret = await httpCall(port, "/api/request/interpret", {
    origin: loopbackOrigin,
    method: "POST",
    headers: { "x-sentinel-token": token, "content-type": "application/json" },
    body: JSON.stringify({
      request_id: UUID_C,
      workspace_id: "demo",
      transcript: "Please implement alpha",
      context: { page: "specs/alpha" },
      resolved_refs: ["spec:alpha"],
    }),
  });
  assert.equal(loopInterpret.status, 200);
  const loopProposal = JSON.parse(loopInterpret.body);
  assert.equal(loopProposal.request_id, UUID_C);
  assert.equal(loopProposal.resolution, "proposal");

  // The real printReply built the pi argv: tool-free one-shot with the model.
  assert.equal(record.piArgs.length, 2);
  for (const args of record.piArgs) {
    for (const flag of PI_FREE_FLAGS) assert.ok(args.includes(flag), `pi argv carries ${flag}`);
    assert.ok(args.includes(INTERPRET_MODEL));
    assert.ok(args.includes("--thinking") && args.includes("off"));
  }
  assert.equal(record.daemon.length, 1, "one daemon child per recording");
});

function countingServices() {
  const calls = { speech: [], interpret: [] };
  const speech = {
    readiness: async () => ({ status: "ready", host: "counting", reason: null }),
    transcribe: async (samples, signal) => {
      calls.speech.push({ samples, signal });
      return "counted text";
    },
  };
  const interpret = async (input, signal) => {
    calls.interpret.push({ input, signal });
    return { resolution: "unsupported", candidates: [], options: [], question: "", errors: [], omissions: 0, sourceErrors: [] };
  };
  return { calls, services: { speech, interpret } };
}

test("authorization, body and input refusals answer static codes without reaching services", { timeout: 20000 }, async (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  populateFixture(fx);
  const agentDir = join(fx.tmp, "agent");
  mkdirSync(agentDir, { recursive: true });
  const { calls, services } = countingServices();
  const server = createDashboardServer({ agentDir, storageRoot: fx.root, publicHost: PUBLIC_HOST, requestServices: services });
  const port = await listen(t, server);
  const token = await actionToken(port);
  const origin = `http://127.0.0.1:${port}`;
  const counts = () => [calls.speech.length, calls.interpret.length];
  const expectRefusal = (res, status, error, reason) => {
    assert.equal(res.status, status);
    assert.deepEqual(JSON.parse(res.body), { error, reason });
    assert.deepEqual(counts(), [0, 0], "refusals never reach services");
  };
  const transcribeCall = (extra = {}) => httpCall(port, `/api/request/transcribe?request_id=${UUID_A}`, {
    method: "POST",
    origin,
    headers: { "x-sentinel-token": token, "content-type": "application/octet-stream", ...extra.headers },
    ...extra.options,
  });
  const interpretCall = (payload, extra = {}) => {
    // An own `token: undefined` omits the header entirely (missing-token
    // case); an absent property keeps the real token; any other value is
    // sent as-is for the wrong-token case.
    const sentToken = Object.hasOwn(extra, "token") ? extra.token : token;
    return httpCall(port, "/api/request/interpret", {
      method: "POST",
      origin: extra.origin ?? origin,
      headers: {
        ...(sentToken === undefined ? {} : { "x-sentinel-token": sentToken }),
        "content-type": extra.contentType ?? "application/json",
        ...extra.headers,
      },
      body: extra.rawBody ?? JSON.stringify({ request_id: UUID_B, workspace_id: "demo", transcript: "Please implement alpha", ...payload }),
    });
  };
  const validPcm = pcm(1, 2, 3);

  // Locality: forwarding headers make an otherwise loopback request remote.
  expectRefusal(await transcribeCall({ headers: { "x-forwarded-for": "203.0.113.1" }, options: { body: validPcm } }), 403, "locality", REASON.locality);
  expectRefusal(await transcribeCall({ headers: { "tailscale-user-login": "someone@example.com" }, options: { body: validPcm } }), 403, "locality", REASON.locality);

  // Bad host and bad origin stop at the dashboard before any route handling.
  const badHost = await httpCall(port, "/api/request/speech", { host: "evil.example" });
  assert.equal(badHost.status, 403);
  assert.equal(badHost.body, "Local access only");
  assert.deepEqual(counts(), [0, 0]);
  const badOrigin = await interpretCall({}, { origin: "http://evil.example" });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.body, "Same-origin access only");
  assert.deepEqual(counts(), [0, 0]);

  // Token and MIME refusals carry their own static card codes.
  expectRefusal(await interpretCall({}, { token: undefined }), 403, "token", REASON.token);
  expectRefusal(await interpretCall({}, { token: "not-the-token" }), 403, "token", REASON.token);
  expectRefusal(await interpretCall({}, { contentType: "text/plain" }), 403, "mime", REASON.mime);
  expectRefusal(await interpretCall({}, { contentType: "Application/JSON" }), 403, "mime", REASON.mime);
  expectRefusal(await transcribeCall({ headers: { "content-type": "application/json" }, options: { body: validPcm } }), 403, "mime", REASON.mime);

  // Case-changed Origin passes the dashboard's lowercase acceptance and is
  // refused by the route's exact-origin comparison (public host).
  const caseChangedOrigin = await httpCall(port, "/api/request/interpret", {
    host: PUBLIC_HOST,
    origin: `https://${PUBLIC_HOST.toUpperCase()}`,
    method: "POST",
    headers: { "x-sentinel-token": token, "content-type": "application/json" },
    body: JSON.stringify({ request_id: UUID_B, workspace_id: "demo", transcript: "hi" }),
  });
  expectRefusal(caseChangedOrigin, 403, "origin", REASON.origin);

  // Transport and input validation, all pre-service.
  expectRefusal(await httpCall(port, "/api/request/transcribe?request_id=nope", {
    method: "POST", origin, headers: { "x-sentinel-token": token, "content-type": "application/octet-stream" }, body: validPcm,
  }), 400, "invalid-request", REASON["invalid-request"]);
  expectRefusal(await interpretCall({}, { rawBody: "not-json" }), 400, "invalid-request", REASON["invalid-request"]);
  expectRefusal(await interpretCall({}, { rawBody: "[1]" }), 400, "invalid-request", REASON["invalid-request"]);
  expectRefusal(await interpretCall({ request_id: "nope" }), 400, "invalid-request", REASON["invalid-request"]);
  expectRefusal(await interpretCall({ workspace_id: "a/../b" }), 400, "invalid-request", REASON["invalid-request"]);
  expectRefusal(await interpretCall({ context: [1] }), 400, "invalid-request", REASON["invalid-request"]);
  expectRefusal(await interpretCall({ resolved_refs: ["bogus"] }), 400, "invalid-request", REASON["invalid-request"]);
  expectRefusal(await interpretCall({ transcript: "x".repeat(REQUEST_LIMITS.transcriptChars + 1) }), 400, "input-too-long", REASON["input-too-long"]);
  expectRefusal(await interpretCall({ context: { pad: "x".repeat(17000) } }), 413, "oversize", REASON.oversize);
  expectRefusal(await interpretCall({ workspace_id: "absent" }), 404, "workspace-unavailable", REASON["workspace-unavailable"]);

  // PCM refusals: empty, unaligned, nonfinite and both oversize forms.
  expectRefusal(await transcribeCall({ options: { body: Buffer.alloc(0) } }), 400, "invalid-request", REASON["invalid-request"]);
  expectRefusal(await transcribeCall({ options: { body: Buffer.alloc(6) } }), 400, "invalid-request", REASON["invalid-request"]);
  const nanSample = Buffer.alloc(4);
  nanSample.writeFloatLE(NaN);
  expectRefusal(await transcribeCall({ options: { body: nanSample } }), 400, "invalid-request", REASON["invalid-request"]);
  const infiniteSample = Buffer.alloc(4);
  infiniteSample.writeFloatLE(Infinity);
  expectRefusal(await transcribeCall({ options: { body: infiniteSample } }), 400, "invalid-request", REASON["invalid-request"]);
  const declaredOversize = await httpCall(port, `/api/request/transcribe?request_id=${UUID_A}`, {
    method: "POST",
    origin,
    headers: { "x-sentinel-token": token, "content-type": "application/octet-stream", "content-length": String(REQUEST_LIMITS.maxAudioBytes + 4) },
    headersOnly: true,
  });
  expectRefusal(declaredOversize, 413, "oversize", REASON.oversize);
  assert.equal(declaredOversize.uploaded, 0);
  // No content-length: Transfer-Encoding chunked, stopped one chunk past the cap.
  const chunkedOversize = await transcribeCall({ options: { body: Buffer.alloc(REQUEST_LIMITS.maxAudioBytes + 4) } });
  expectRefusal(chunkedOversize, 413, "oversize", REASON.oversize);

  assert.deepEqual(counts(), [0, 0], "no refusal reached a service");
});

test("service failures map to static card codes and never leak detail", { timeout: 20000 }, async (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  populateFixture(fx);
  const agentDir = join(fx.tmp, "agent");
  mkdirSync(agentDir, { recursive: true });
  let speechMode = "unavailable";
  let interpretMode = "rejected";
  const calls = { speech: 0, interpret: 0 };
  const services = {
    speech: {
      readiness: async () => ({ status: "ready", host: "failing", reason: null }),
      transcribe: async () => {
        calls.speech += 1;
        if (speechMode === "unavailable") throw Object.assign(new Error("SECRET-LEAK /home/private/checkout"), { code: "unavailable" });
        if (speechMode === "no-speech") throw Object.assign(new Error("SECRET-LEAK /home/private/checkout"), { code: "no-speech" });
        throw Object.assign(new Error("SECRET-LEAK /home/private/worker"), { code: "failed" });
      },
    },
    interpret: async () => {
      calls.interpret += 1;
      if (interpretMode === "rejected") {
        return { resolution: "rejected", candidates: [], options: [], question: "", errors: ["malformed-reply"], omissions: 0, sourceErrors: [] };
      }
      throw new Error("SECRET-LEAK /home/private/pi");
    },
  };
  const server = createDashboardServer({ agentDir, storageRoot: fx.root, requestServices: services });
  const port = await listen(t, server);
  const token = await actionToken(port);
  const origin = `http://127.0.0.1:${port}`;
  const transcribe = () => httpCall(port, `/api/request/transcribe?request_id=${UUID_A}`, {
    method: "POST", origin, headers: { "x-sentinel-token": token, "content-type": "application/octet-stream" }, body: pcm(1, 2, 3),
  });
  const interpret = () => httpCall(port, "/api/request/interpret", {
    method: "POST", origin, headers: { "x-sentinel-token": token, "content-type": "application/json" },
    body: JSON.stringify({ request_id: UUID_B, workspace_id: "demo", transcript: "hi" }),
  });
  const expectStatic = (res, status, error, reason) => {
    assert.equal(res.status, status);
    assert.deepEqual(JSON.parse(res.body), { error, reason });
    assert.doesNotMatch(res.body, /SECRET-LEAK|\/home\/private/);
  };

  speechMode = "unavailable";
  expectStatic(await transcribe(), 503, "unavailable", REASON.unavailable);
  speechMode = "no-speech";
  expectStatic(await transcribe(), 422, "no-speech", REASON["no-speech"]);
  speechMode = "failed";
  expectStatic(await transcribe(), 502, "transcription-failed", REASON["transcription-failed"]);
  interpretMode = "rejected";
  expectStatic(await interpret(), 502, "interpretation-failed", REASON["interpretation-failed"]);
  interpretMode = "throw";
  expectStatic(await interpret(), 502, "interpretation-failed", REASON["interpretation-failed"]);
  assert.deepEqual(calls, { speech: 3, interpret: 2 }, "each mapped failure came from one service call");
});

test("speech state and method conventions", { timeout: 15000 }, async (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const agentDir = join(fx.tmp, "agent");
  mkdirSync(agentDir, { recursive: true });
  const { calls, services } = countingServices();
  services.speech.readiness = async () => ({ status: "unavailable", host: "counting", reason: "checkout-missing" });
  const server = createDashboardServer({ agentDir, storageRoot: fx.root, requestServices: services });
  const port = await listen(t, server);

  // Accepted convention: GET answers 200 with state "unavailable".
  const res = await httpCall(port, "/api/request/speech");
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(Object.keys(body).sort(), ["host", "limit_seconds", "sample_rate", "state"]);
  assert.equal(body.state, "unavailable");
  assert.equal(body.host, "counting");
  assert.equal(body.limit_seconds, 30);
  assert.equal(body.sample_rate, 16000);

  // Accepted convention: method mismatch is a static 405 with Allow.
  const wrongMethod = await httpCall(port, "/api/request/speech", { method: "POST" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "GET");
  assert.deepEqual(JSON.parse(wrongMethod.body), { error: "invalid-request", reason: "Method not allowed." });
  const wrongMethod2 = await httpCall(port, "/api/request/interpret");
  assert.equal(wrongMethod2.status, 405);
  assert.equal(wrongMethod2.headers.allow, "POST");
  assert.deepEqual(JSON.parse(wrongMethod2.body), { error: "invalid-request", reason: "Method not allowed." });
  assert.deepEqual([calls.speech.length, calls.interpret.length], [0, 0]);
});

// Deferred latches for scenario 3: each service call records its payload and
// signal and settles only when the test resolves or rejects it.
function deferredServices() {
  const speechCalls = [];
  const interpretCalls = [];
  const latch = (list, payload, signal) => new Promise((resolve, reject) => {
    const call = {
      payload,
      signal,
      aborted: false,
      settled: false,
      resolve: (value) => { call.settled = true; resolve(value); },
      reject: (error) => { call.settled = true; reject(error); },
    };
    signal?.addEventListener("abort", () => { call.aborted = true; }, { once: true });
    list.push(call);
  });
  const speech = {
    readiness: async () => ({ status: "ready", host: "deferred", reason: null }),
    transcribe: (samples, signal) => latch(speechCalls, samples, signal),
  };
  const interpret = (input, signal) => latch(interpretCalls, input, signal);
  return { speechCalls, interpretCalls, services: { speech, interpret } };
}

async function deferredFixture(t) {
  const fx = makeFixture();
  t.after(fx.cleanup);
  populateFixture(fx);
  const agentDir = join(fx.tmp, "agent");
  mkdirSync(agentDir, { recursive: true });
  const deferred = deferredServices();
  const server = createDashboardServer({ agentDir, storageRoot: fx.root, requestServices: deferred.services });
  const port = await listen(t, server);
  const token = await actionToken(port);
  const origin = `http://127.0.0.1:${port}`;
  const transcribeReq = (id, bytes) => httpCall(port, `/api/request/transcribe?request_id=${id}`, {
    method: "POST", origin, headers: { "x-sentinel-token": token, "content-type": "application/octet-stream" }, body: bytes,
  });
  const interpretReq = (id, payload) => httpCall(port, "/api/request/interpret", {
    method: "POST", origin, headers: { "x-sentinel-token": token, "content-type": "application/json" },
    body: JSON.stringify({ request_id: id, workspace_id: "demo", transcript: "Please implement alpha", ...payload }),
  });
  return { fx, deferred, port, token, origin, transcribeReq, interpretReq };
}

const UNSUPPORTED = { resolution: "unsupported", candidates: [], options: [], question: "", errors: [], omissions: 0, sourceErrors: [] };
const LATE_PROPOSAL = {
  resolution: "proposal",
  candidates: [{ action: "plan_epic", workspace: "demo", entity: "workspace:demo", uses: [], resolved_refs: [], research: {}, goal: "Plan demo", constraints: [] }],
  options: [],
  question: "",
  errors: [],
  omissions: 2,
  sourceErrors: ["epics-unavailable"],
};
const CLARIFY = {
  resolution: "clarification",
  candidates: [],
  options: ["spec:alpha", "spec:beta"],
  question: "Which spec?",
  errors: [],
  omissions: 5,
  sourceErrors: ["designs-unavailable"],
};

test("identical in-flight identity joins one service call per operation", { timeout: 20000 }, async (t) => {
  const { deferred, transcribeReq, interpretReq } = await deferredFixture(t);

  // Transcribe: same id and identical bytes join the running response.
  const bytes = pcm(1, 2, 3);
  const first = transcribeReq(UUID_A, bytes);
  const second = transcribeReq(UUID_A, bytes);
  await waitFor(() => deferred.speechCalls.length === 1, "first transcription invoked");
  deferred.speechCalls[0].resolve("joined text");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.deepEqual(JSON.parse(a.body), { request_id: UUID_A, text: "joined text", seconds: 3 / REQUEST_LIMITS.sampleRateHz });
  assert.deepEqual(JSON.parse(b.body), JSON.parse(a.body));
  assert.equal(deferred.speechCalls.length, 1, "identical identity joins one invocation");

  // Interpret: same id and identical validated payload join.
  const payload = { context: { page: "one" }, resolved_refs: ["spec:alpha"] };
  const third = interpretReq(UUID_B, payload);
  const fourth = interpretReq(UUID_B, payload);
  await waitFor(() => deferred.interpretCalls.length === 1, "first interpretation invoked");
  deferred.interpretCalls[0].resolve(UNSUPPORTED);
  const [c, d] = await Promise.all([third, fourth]);
  assert.equal(c.status, 200);
  assert.equal(JSON.parse(c.body).resolution, "unsupported");
  assert.deepEqual(JSON.parse(d.body), JSON.parse(c.body));
  assert.equal(deferred.interpretCalls.length, 1, "identical identity joins one invocation");
});

test("same id with changed audio, workspace, context or refs conflicts without disturbing the run", { timeout: 20000 }, async (t) => {
  const { deferred, transcribeReq, interpretReq } = await deferredFixture(t);

  // Changed audio bytes conflict against the running transcription.
  const running = transcribeReq(UUID_A, pcm(1, 2, 3));
  await waitFor(() => deferred.speechCalls.length === 1, "transcription invoked");
  const audioConflict = await transcribeReq(UUID_A, pcm(1, 2, 4));
  assert.equal(audioConflict.status, 409);
  assert.deepEqual(JSON.parse(audioConflict.body), { error: "request-conflict", reason: REASON["request-conflict"] });
  assert.equal(deferred.speechCalls.length, 1);
  deferred.speechCalls[0].resolve("a text");
  const done = await running;
  assert.equal(done.status, 200);
  assert.equal(JSON.parse(done.body).text, "a text", "the running call keeps its own result");

  // Changed workspace, context and refs each conflict against one run.
  const interpretRun = interpretReq(UUID_C, { context: { page: "one" }, resolved_refs: ["spec:alpha"] });
  await waitFor(() => deferred.interpretCalls.length === 1, "interpretation invoked");
  for (const changed of [
    { context: { page: "two" } },
    { resolved_refs: ["spec:beta"] },
    { workspace_id: "other" },
  ]) {
    const conflict = await interpretReq(UUID_C, changed);
    assert.equal(conflict.status, 409);
    assert.deepEqual(JSON.parse(conflict.body), { error: "request-conflict", reason: REASON["request-conflict"] });
    assert.equal(deferred.interpretCalls.length, 1, "conflicts never invoke the service");
  }
  deferred.interpretCalls[0].resolve(UNSUPPORTED);
  const interpretDone = await interpretRun;
  assert.equal(interpretDone.status, 200);
  assert.equal(JSON.parse(interpretDone.body).resolution, "unsupported");
});

test("a new identity supersedes, aborts and replaces only after the drain", { timeout: 20000 }, async (t) => {
  const { deferred, transcribeReq } = await deferredFixture(t);
  const original = transcribeReq(UUID_A, pcm(1, 2, 3));
  await waitFor(() => deferred.speechCalls.length === 1, "original transcription invoked");
  const replacement = transcribeReq(UUID_B, pcm(9, 9, 9));

  // The old caller is answered superseded while its call is still draining.
  const oldResponse = await original;
  assert.equal(oldResponse.status, 409);
  assert.deepEqual(JSON.parse(oldResponse.body), { error: "superseded", reason: REASON.superseded });
  assert.equal(deferred.speechCalls[0].aborted, true, "replacement aborts the old call");
  assert.equal(deferred.speechCalls[0].settled, false, "superseded answers before the drain");
  assert.equal(deferred.speechCalls.length, 1, "the replacement waits for the drain");

  // A late failure from the aborted call cannot reach the replacement.
  deferred.speechCalls[0].reject(Object.assign(new Error("SECRET-LEAK late failure"), { code: "failed" }));
  await waitFor(() => deferred.speechCalls.length === 2, "replacement starts after the drain");
  deferred.speechCalls[1].resolve("b text");
  const newResponse = await replacement;
  assert.equal(newResponse.status, 200);
  assert.deepEqual(JSON.parse(newResponse.body), { request_id: UUID_B, text: "b text", seconds: 3 / REQUEST_LIMITS.sampleRateHz });
});

test("rapid A→B→C keeps C behind A's drain and B never starts", { timeout: 20000 }, async (t) => {
  const { deferred, interpretReq } = await deferredFixture(t);
  const a = interpretReq(UUID_A, { transcript: "alpha" });
  await waitFor(() => deferred.interpretCalls.length === 1, "A invoked");
  const b = interpretReq(UUID_B, { transcript: "bravo" });
  const aResponse = await a;
  assert.equal(aResponse.status, 409);
  assert.deepEqual(JSON.parse(aResponse.body), { error: "superseded", reason: REASON.superseded });

  // C arrives while A is still draining and B has never started.
  const c = interpretReq(UUID_C, { transcript: "charlie" });
  const bResponse = await b;
  assert.equal(bResponse.status, 409);
  assert.deepEqual(JSON.parse(bResponse.body), { error: "superseded", reason: REASON.superseded });
  assert.equal(deferred.interpretCalls.length, 1, "B never starts");
  assert.equal(deferred.interpretCalls[0].payload.transcript, "alpha");
  assert.equal(deferred.interpretCalls[0].aborted, true);

  // A's late success cannot leak into C, which waits on A's drain, not B's.
  deferred.interpretCalls[0].resolve(LATE_PROPOSAL);
  await waitFor(() => deferred.interpretCalls.length === 2, "C starts only after A drains");
  assert.equal(deferred.interpretCalls[1].payload.transcript, "charlie");
  deferred.interpretCalls[1].resolve(CLARIFY);
  const cResponse = await c;
  assert.equal(cResponse.status, 200);
  const body = JSON.parse(cResponse.body);
  assert.equal(body.request_id, UUID_C);
  assert.equal(body.resolution, "clarification");
  assert.deepEqual(body.candidates, [], "A's late proposal never reaches C's response");
  assert.deepEqual(body.clarification, { question: "Which spec?", options: ["spec:alpha", "spec:beta"] });
  assert.deepEqual(body.unresolved_references, []);
  assert.deepEqual(body.catalog.errors, ["designs-unavailable"]);
  assert.equal(body.catalog.omitted, 5);
  assert.ok(Number.isFinite(Date.parse(body.catalog.read_at)));
});

test("a settled failure releases the slot and the same id retries fresh", { timeout: 20000 }, async (t) => {
  const { deferred, transcribeReq } = await deferredFixture(t);
  const bytes = pcm(1, 2, 3);
  const failed = transcribeReq(UUID_D, bytes);
  await waitFor(() => deferred.speechCalls.length === 1, "first attempt invoked");
  deferred.speechCalls[0].reject(Object.assign(new Error("SECRET-LEAK"), { code: "failed" }));
  const failure = await failed;
  assert.equal(failure.status, 502);
  assert.deepEqual(JSON.parse(failure.body), { error: "transcription-failed", reason: REASON["transcription-failed"] });

  const retry = transcribeReq(UUID_D, bytes);
  await waitFor(() => deferred.speechCalls.length === 2, "retry starts a fresh call");
  deferred.speechCalls[1].resolve("retry text");
  const retried = await retry;
  assert.equal(retried.status, 200);
  assert.equal(JSON.parse(retried.body).text, "retry text");
});

test("the two operation slots are independent", { timeout: 20000 }, async (t) => {
  const { deferred, transcribeReq, interpretReq } = await deferredFixture(t);
  const transcription = transcribeReq(UUID_A, pcm(1, 2, 3));
  await waitFor(() => deferred.speechCalls.length === 1, "transcription invoked");
  const interpretation = interpretReq(UUID_B, {});
  await waitFor(() => deferred.interpretCalls.length === 1, "interpretation runs while transcription is active");
  assert.equal(deferred.interpretCalls[0].signal.aborted, false, "the other kind's slot never aborts this call");

  deferred.interpretCalls[0].resolve(UNSUPPORTED);
  const interpreted = await interpretation;
  assert.equal(interpreted.status, 200);
  assert.equal(deferred.speechCalls[0].settled, false, "transcription is unaffected by interpretation settling");

  deferred.speechCalls[0].resolve("independent text");
  const transcribed = await transcription;
  assert.equal(transcribed.status, 200);
  assert.equal(JSON.parse(transcribed.body).text, "independent text");
});
