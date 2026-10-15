// Real-child protocol regression cases for createSpeechAdapter.
//
// Run all: node --test scripts/spec-observe/request-speech.test.mjs
// Selectable case: node --test --test-name-pattern="<case name>" scripts/spec-observe/request-speech.test.mjs
//
// Only spawn's executable boundary is replaced (bun -> node
// fixtures/fake-asr-daemon.mjs); everything else is a real child process with
// real pipes and process lifecycle. Each case uses an isolated temp checkout
// with a worker placeholder. Expected PCM frames and padding are hand-derived
// from the input vector, chunkSamples and padSeconds; expected text comes from
// the fixture contract, not from the adapter.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSpeechAdapter } from "./request-speech.mjs";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-asr-daemon.mjs", import.meta.url));
const WORKER_ARGS = ["run", "server/asr/asrDaemonWorker.ts"];

function makeCheckout(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "request-speech-"));
  mkdirSync(path.join(dir, "server", "asr"), { recursive: true });
  writeFileSync(path.join(dir, "server", "asr", "asrDaemonWorker.ts"), "// test worker placeholder\n");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let reportCounter = 0;

// Real Node child replacing ONLY the spawn executable boundary.
function fakeDaemon(checkout, scenario, env = {}) {
  const reportPath = path.join(checkout, `report-${reportCounter++}.json`);
  const record = { children: [], kills: [], closes: [] };
  const spawn = (command, args, options) => {
    assert.equal(command, "bun");
    assert.deepEqual(args, WORKER_ARGS);
    assert.equal(options.cwd, checkout);
    const child = nodeSpawn(process.execPath, [fixturePath, scenario], {
      ...options,
      env: { ...process.env, FAKE_ASR_SCENARIO: scenario, FAKE_ASR_REPORT: reportPath, ...env },
    });
    record.children.push(child);
    const kill = child.kill.bind(child);
    child.kill = (sig) => {
      record.kills.push(sig ?? "SIGTERM");
      return kill(sig);
    };
    child.on("close", (code, signal) => record.closes.push({ code, signal }));
    return child;
  };
  return {
    spawn,
    record,
    readReport: () => JSON.parse(readFileSync(reportPath, "utf8")),
  };
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected rejection");
}

test("real child receives hand-derived PCM frames and padding in order; delayed finals join", async (t) => {
  const checkout = makeCheckout(t);
  // Hand-derived vector: 6 samples in frames of 4 -> 2 frames; padSeconds
  // 0.005 s * 16000 Hz -> exactly 80 zero samples -> 20 frames; then shutdown.
  const input = new Float32Array([0.5, -0.25, 0.125, -1, 0.75, 2]);
  const expectedSamples = [...input, ...new Array(80).fill(0)];
  const daemon = fakeDaemon(checkout, "happy", {
    FAKE_ASR_FINAL_AFTER_SAMPLES: String(expectedSamples.length),
    FAKE_ASR_TEXT: "hello there",
    FAKE_ASR_TEXT_2: "world",
  });
  const adapter = createSpeechAdapter({
    checkout,
    spawn: daemon.spawn,
    chunkSamples: 4,
    padSeconds: 0.005,
    timeoutMs: 15000,
    hostname: () => "test-host",
  });
  const text = await adapter.transcribe(input);
  // Delayed final (beyond padding) then a second final that resets quiescence.
  assert.equal(text, "hello there world");
  const report = daemon.readReport();
  assert.deepEqual(report.requests, [...new Array(22).fill("audio"), "shutdown"]);
  assert.deepEqual(report.samples, expectedSamples);
  assert.equal(report.shutdownSeen, true);
  // Audio must precede model-ready: the real engine starts lazily on first
  // audio, so waiting for model-ready before writing would deadlock.
  assert.ok(report.timeline.indexOf("audio") < report.timeline.indexOf("model-ready"));
  assert.deepEqual(daemon.record.kills, []);
  assert.deepEqual(daemon.record.closes, [{ code: 0, signal: null }]);
});

test("earlier final then pending nonempty tail with empty clear cannot release partial success", async (t) => {
  const checkout = makeCheckout(t);
  const daemon = fakeDaemon(checkout, "earlier-final-tail", {
    FAKE_ASR_INPUT_SAMPLES: "100000",
  });
  const timeoutMs = 800;
  const adapter = createSpeechAdapter({
    checkout,
    spawn: daemon.spawn,
    chunkSamples: 1600,
    padSeconds: 0.001,
    timeoutMs,
    hostname: () => "test-host",
  });
  // 100000 nonzero samples in frames of 1600 exceed the pipe buffer many times
  // over, so the fixture's 200 ms stdin pause forces backpressure: the earlier
  // final (real producer lifecycle, after model-ready on first audio) is
  // consumed before the last input frame is submitted.
  const input = new Float32Array(100000).fill(0.5);
  const started = Date.now();
  const error = await captureRejection(adapter.transcribe(input));
  const elapsed = Date.now() - started;
  // The earlier final ("hello") must not become partial success; the empty
  // clear must not acknowledge the pending tail.
  assert.equal(error.code, "failed");
  assert.ok(elapsed >= timeoutMs - 50, `deadline must govern (elapsed ${elapsed})`);
  const timeline = daemon.readReport().timeline;
  assert.ok(
    timeline.indexOf("model-ready") < timeline.indexOf("final"),
    "model-ready must precede the earlier final",
  );
  assert.ok(
    timeline.indexOf("final") < timeline.indexOf("last-input-audio"),
    "earlier final must precede the last input audio",
  );
  assert.deepEqual(daemon.record.kills, ["SIGTERM"]);
  assert.deepEqual(daemon.record.closes, [{ code: null, signal: "SIGTERM" }]);
});

test("initially empty pending decode after an earlier final fails and is never no-speech", async (t) => {
  const checkout = makeCheckout(t);
  const daemon = fakeDaemon(checkout, "initially-empty-pending", {
    FAKE_ASR_INPUT_SAMPLES: "100000",
  });
  const timeoutMs = 800;
  const adapter = createSpeechAdapter({
    checkout,
    spawn: daemon.spawn,
    chunkSamples: 1600,
    padSeconds: 0.001,
    timeoutMs,
    hostname: () => "test-host",
  });
  // Same real-lifecycle backpressure setup as the pending-tail case: the
  // earlier final arrives post-model-ready while input frames are still being
  // submitted, so only the input-boundary eligibility branch can reject it.
  const input = new Float32Array(100000).fill(0.5);
  const started = Date.now();
  const error = await captureRejection(adapter.transcribe(input));
  const elapsed = Date.now() - started;
  assert.equal(error.code, "failed");
  assert.notEqual(error.code, "no-speech");
  assert.ok(elapsed >= timeoutMs - 50, `deadline must govern (elapsed ${elapsed})`);
  const timeline = daemon.readReport().timeline;
  assert.ok(
    timeline.indexOf("model-ready") < timeline.indexOf("final"),
    "model-ready must precede the earlier final",
  );
  assert.ok(
    timeline.indexOf("final") < timeline.indexOf("last-input-audio"),
    "earlier final must precede the last input audio",
  );
  assert.equal(daemon.record.closes.length, 1);
});

test("nonzero child exit fails the transcription after close is observed", async (t) => {
  const checkout = makeCheckout(t);
  const daemon = fakeDaemon(checkout, "nonzero-exit");
  const adapter = createSpeechAdapter({
    checkout,
    spawn: daemon.spawn,
    chunkSamples: 4,
    padSeconds: 0.001,
    timeoutMs: 8000,
    hostname: () => "test-host",
  });
  const error = await captureRejection(adapter.transcribe(new Float32Array([0.5, 0.25])));
  assert.equal(error.code, "failed");
  assert.deepEqual(daemon.record.closes, [{ code: 3, signal: null }]);
});

test("pre-model load errors are unavailable; runtime errors fail without diagnostics", async (t) => {
  const checkoutA = makeCheckout(t);
  const daemonA = fakeDaemon(checkoutA, "pre-model-error");
  const adapterA = createSpeechAdapter({
    checkout: checkoutA,
    spawn: daemonA.spawn,
    timeoutMs: 8000,
    hostname: () => "test-host",
  });
  const errorA = await captureRejection(adapterA.transcribe(new Float32Array([0.5])));
  assert.equal(errorA.code, "unavailable");
  assert.equal(errorA.message.includes("model load failed"), false);

  const checkoutB = makeCheckout(t);
  const daemonB = fakeDaemon(checkoutB, "runtime-error");
  const adapterB = createSpeechAdapter({
    checkout: checkoutB,
    spawn: daemonB.spawn,
    timeoutMs: 8000,
    hostname: () => "test-host",
  });
  const errorB = await captureRejection(adapterB.transcribe(new Float32Array([0.5])));
  assert.equal(errorB.code, "failed");
  assert.equal(errorB.message.includes("SECRET-DAEMON-DIAGNOSTIC"), false);
});

test("silence derives only from truly zero input", async (t) => {
  const checkout = makeCheckout(t);
  const daemon = fakeDaemon(checkout, "silent");
  const adapter = createSpeechAdapter({
    checkout,
    spawn: daemon.spawn,
    timeoutMs: 600,
    hostname: () => "test-host",
  });
  const zeros = await captureRejection(adapter.transcribe(new Float32Array(16)));
  assert.equal(zeros.code, "no-speech");
  const empty = await captureRejection(adapter.transcribe(new Float32Array(0)));
  assert.equal(empty.code, "no-speech");
  // Derived from input alone: no child was ever spawned for silent clips.
  assert.equal(daemon.record.children.length, 0);
  // Nonzero input with no finals is a failure, never no-speech.
  const error = await captureRejection(adapter.transcribe(new Float32Array([0.5, 0.25, 0.125, 0.0625])));
  assert.equal(error.code, "failed");
  assert.notEqual(error.code, "no-speech");
});

test("abort on a well-behaved child settles after close without escalation", async (t) => {
  const checkout = makeCheckout(t);
  const daemon = fakeDaemon(checkout, "silent");
  const adapter = createSpeechAdapter({
    checkout,
    spawn: daemon.spawn,
    timeoutMs: 30000,
    hostname: () => "test-host",
  });
  const controller = new AbortController();
  const pending = adapter.transcribe(new Float32Array([0.5]), controller.signal);
  setTimeout(() => controller.abort(), 150);
  const error = await captureRejection(pending);
  assert.equal(error.code, "failed");
  assert.deepEqual(daemon.record.kills, ["SIGTERM"]);
  assert.deepEqual(daemon.record.closes, [{ code: null, signal: "SIGTERM" }]);
});

test("abort escalates TERM to KILL on a stubborn child and settles after close", async (t) => {
  const checkout = makeCheckout(t);
  const daemon = fakeDaemon(checkout, "stubborn");
  const adapter = createSpeechAdapter({
    checkout,
    spawn: daemon.spawn,
    timeoutMs: 30000,
    hostname: () => "test-host",
  });
  const controller = new AbortController();
  const started = Date.now();
  const pending = adapter.transcribe(new Float32Array([0.5, 0.25]), controller.signal);
  setTimeout(() => controller.abort(), 150);
  const error = await captureRejection(pending);
  const elapsed = Date.now() - started;
  assert.equal(error.code, "failed");
  assert.ok(elapsed >= 2000, `TERM->KILL grace must be honored (elapsed ${elapsed})`);
  assert.deepEqual(daemon.record.kills, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(daemon.record.closes, [{ code: null, signal: "SIGKILL" }]);
});

test("malformed and over-limit output fails fast and discards diagnostics", async (t) => {
  for (const scenario of ["malformed", "overlong-line", "over-limit-total", "over-limit-stderr"]) {
    const checkout = makeCheckout(t);
    const daemon = fakeDaemon(checkout, scenario);
    const timeoutMs = 8000;
    const adapter = createSpeechAdapter({
      checkout,
      spawn: daemon.spawn,
      chunkSamples: 4,
      padSeconds: 0.001,
      timeoutMs,
      hostname: () => "test-host",
    });
    const started = Date.now();
    const error = await captureRejection(adapter.transcribe(new Float32Array([0.5, 0.25])));
    const elapsed = Date.now() - started;
    assert.equal(error.code, "failed", scenario);
    assert.ok(elapsed < timeoutMs, `${scenario} must fail before the deadline (elapsed ${elapsed})`);
    assert.equal(error.message.includes("aaaa"), false, scenario);
    assert.equal(error.message.includes("bbbb"), false, scenario);
    assert.equal(error.message.includes("xxxx"), false, scenario);
    assert.equal(daemon.record.closes.length, 1, scenario);
  }
});

test("readiness spawns nothing and reports static reasons", async (t) => {
  const noSpawn = () => {
    assert.fail("readiness must not spawn a child");
  };
  const host = () => "test-host";

  const good = makeCheckout(t);
  assert.deepEqual(await createSpeechAdapter({ checkout: good, spawn: noSpawn, hostname: host }).readiness(), {
    status: "ready",
    host: "test-host",
    reason: null,
  });

  assert.deepEqual(
    await createSpeechAdapter({ checkout: "relative/checkout", spawn: noSpawn, hostname: host }).readiness(),
    { status: "unavailable", host: "test-host", reason: "checkout-not-absolute" },
  );

  assert.deepEqual(
    await createSpeechAdapter({ checkout: undefined, spawn: noSpawn, hostname: host }).readiness(),
    { status: "unavailable", host: "test-host", reason: "checkout-not-absolute" },
  );

  assert.deepEqual(
    await createSpeechAdapter({ checkout: "", spawn: noSpawn, hostname: host }).readiness(),
    { status: "unavailable", host: "test-host", reason: "checkout-not-absolute" },
  );

  assert.deepEqual(
    await createSpeechAdapter({ checkout: path.join(good, "absent"), spawn: noSpawn, hostname: host }).readiness(),
    { status: "unavailable", host: "test-host", reason: "checkout-missing" },
  );

  const noWorker = makeCheckout(t);
  rmSync(path.join(noWorker, "server", "asr", "asrDaemonWorker.ts"));
  assert.deepEqual(await createSpeechAdapter({ checkout: noWorker, spawn: noSpawn, hostname: host }).readiness(), {
    status: "unavailable",
    host: "test-host",
    reason: "worker-missing",
  });

  const linked = makeCheckout(t);
  const linkedWorker = path.join(linked, "server", "asr", "asrDaemonWorker.ts");
  rmSync(linkedWorker);
  writeFileSync(path.join(linked, "server", "asr", "real.ts"), "// real worker\n");
  symlinkSync(path.join(linked, "server", "asr", "real.ts"), linkedWorker);
  assert.deepEqual(await createSpeechAdapter({ checkout: linked, spawn: noSpawn, hostname: host }).readiness(), {
    status: "unavailable",
    host: "test-host",
    reason: "worker-symlink",
  });

  const dirWorker = makeCheckout(t);
  const dirWorkerPath = path.join(dirWorker, "server", "asr", "asrDaemonWorker.ts");
  rmSync(dirWorkerPath);
  mkdirSync(dirWorkerPath);
  assert.deepEqual(await createSpeechAdapter({ checkout: dirWorker, spawn: noSpawn, hostname: host }).readiness(), {
    status: "unavailable",
    host: "test-host",
    reason: "worker-not-regular",
  });
});

test("synchronous spawn throws and a real missing executable are unavailable", async (t) => {
  const checkout = makeCheckout(t);
  const throwing = createSpeechAdapter({
    checkout,
    spawn: () => {
      throw new Error("spawn exploded");
    },
    timeoutMs: 8000,
    hostname: () => "test-host",
  });
  const thrown = await captureRejection(throwing.transcribe(new Float32Array([0.5])));
  assert.equal(thrown.code, "unavailable");
  assert.equal(thrown.message.includes("spawn exploded"), false);

  // Real child spawn of a genuinely missing executable: ENOENT stays unavailable.
  const missing = createSpeechAdapter({
    checkout,
    spawn: (command, args, options) => nodeSpawn("/nonexistent/asr-bun", args, options),
    timeoutMs: 8000,
    hostname: () => "test-host",
  });
  const error = await captureRejection(missing.transcribe(new Float32Array([0.5])));
  assert.equal(error.code, "unavailable");
});

test("invalid samples reject with failed and never spawn", async (t) => {
  const checkout = makeCheckout(t);
  const daemon = fakeDaemon(checkout, "silent");
  const adapter = createSpeechAdapter({
    checkout,
    spawn: daemon.spawn,
    timeoutMs: 8000,
    hostname: () => "test-host",
  });
  for (const bad of [undefined, null, [0.5], new Float32Array([NaN]), new Float32Array([Infinity])]) {
    const error = await captureRejection(adapter.transcribe(bad));
    assert.equal(error.code, "failed");
  }
  assert.equal(daemon.record.children.length, 0);
});

test("nonempty text after shutdown fails instead of succeeding with active text", async (t) => {
  const checkout = makeCheckout(t);
  const daemon = fakeDaemon(checkout, "late-active-text");
  const adapter = createSpeechAdapter({
    checkout,
    spawn: daemon.spawn,
    chunkSamples: 4,
    padSeconds: 0.001,
    timeoutMs: 8000,
    hostname: () => "test-host",
  });
  const error = await captureRejection(adapter.transcribe(new Float32Array([0.5])));
  assert.equal(error.code, "failed");
  assert.equal(daemon.record.closes.length, 1);
});

test("nonwhitespace unterminated stdout at close fails even in shutdown phase", async (t) => {
  const checkout = makeCheckout(t);
  const daemon = fakeDaemon(checkout, "unterminated-output");
  const adapter = createSpeechAdapter({
    checkout,
    spawn: daemon.spawn,
    chunkSamples: 4,
    padSeconds: 0.001,
    timeoutMs: 8000,
    hostname: () => "test-host",
  });
  const error = await captureRejection(adapter.transcribe(new Float32Array([0.5])));
  assert.equal(error.code, "failed");
  assert.deepEqual(daemon.record.closes, [{ code: 0, signal: null }]);
});

test("a synchronous final during trailing padding succeeds", async (t) => {
  const checkout = makeCheckout(t);
  // Hand-derived: 2048 input samples in frames of 1024 -> 2 input frames;
  // padSeconds 4.0 -> 64000 zero samples -> 63 padding frames (62 full plus a
  // 512-sample tail); 65 audio requests then shutdown. The fixture finalizes
  // on the last input frame and pauses its stdin so trailing padding is
  // provably still in flight when the final is accepted.
  const input = new Float32Array(2048).fill(0.5);
  const daemon = fakeDaemon(checkout, "sync-final-during-padding", {
    FAKE_ASR_INPUT_SAMPLES: String(input.length),
    FAKE_ASR_TEXT: "padding done",
  });
  const adapter = createSpeechAdapter({
    checkout,
    spawn: daemon.spawn,
    chunkSamples: 1024,
    padSeconds: 4.0,
    timeoutMs: 15000,
    hostname: () => "test-host",
  });
  const text = await adapter.transcribe(input);
  assert.equal(text, "padding done");
  const report = daemon.readReport();
  assert.deepEqual(report.requests, [...new Array(65).fill("audio"), "shutdown"]);
  // The final was emitted while trailing audio was still arriving.
  assert.ok(report.timeline.lastIndexOf("audio") > report.timeline.indexOf("final"));
  assert.deepEqual(daemon.record.closes, [{ code: 0, signal: null }]);
});

test("late-tail regression: a second-utterance final outside the old 250ms window joins full text without early shutdown", async (t) => {
  const checkout = makeCheckout(t);
  // Hand-derived: 8 samples in frames of 4 -> 2 input frames; padSeconds 0.005
  // -> 80 zero samples -> 20 padding frames; 88 samples / 22 audio requests.
  // The fixture replays the real EV-5 failure AFTER that threshold: first
  // final + empty revision, pending revision at +900 ms, second final at
  // +1200 ms — delays that exceed the old 250 ms window and fit the 2000 ms
  // one. Selectable: node --test --test-name-pattern="late-tail regression:" …
  const input = new Float32Array([0.5, -0.25, 0.125, -1, 0.75, 2, 0.5, -0.5]);
  const daemon = fakeDaemon(checkout, "late-tail", {
    FAKE_ASR_FINAL_AFTER_SAMPLES: String(input.length + 80),
    FAKE_ASR_TEXT: "first sentence",
    FAKE_ASR_TEXT_2: "second sentence",
  });
  const adapter = createSpeechAdapter({
    checkout,
    spawn: daemon.spawn,
    chunkSamples: 4,
    padSeconds: 0.005,
    timeoutMs: 8000,
    hostname: () => "test-host",
  });
  const started = Date.now();
  const text = await adapter.transcribe(input);
  const elapsed = Date.now() - started;
  assert.equal(text, "first sentence second sentence");
  assert.ok(elapsed < 5000, `late-tail case must stay bounded (elapsed ${elapsed})`);
  const timeline = daemon.readReport().timeline;
  const firstFinal = timeline.indexOf("final");
  const firstRevision = timeline.indexOf("revision");
  const pendingRevision = timeline.indexOf("revision", firstRevision + 1);
  const secondFinal = timeline.lastIndexOf("final");
  const shutdown = timeline.indexOf("shutdown");
  assert.ok(firstFinal !== -1 && firstFinal < pendingRevision, "first final must precede the pending revision");
  assert.ok(pendingRevision !== -1 && pendingRevision < secondFinal, "pending revision must precede the second final");
  assert.ok(secondFinal !== -1 && secondFinal < shutdown, "second final must precede shutdown (no early shutdown)");
  assert.deepEqual(daemon.record.closes, [{ code: 0, signal: null }]);
});

test("late-tail regression unresolved: pending second utterance without a final rejects at deadline with no partial success", async (t) => {
  const checkout = makeCheckout(t);
  // Same replay, unresolved: no second final ever arrives. Deadline 2800 ms;
  // the first final must never become partial success. Selectable: node --test
  // --test-name-pattern="late-tail regression unresolved:" …
  const input = new Float32Array([0.5, -0.25, 0.125, -1, 0.75, 2, 0.5, -0.5]);
  const daemon = fakeDaemon(checkout, "late-tail-unresolved", {
    FAKE_ASR_FINAL_AFTER_SAMPLES: String(input.length + 80),
    FAKE_ASR_TEXT: "first sentence",
    FAKE_ASR_TEXT_2: "second sentence",
  });
  const adapter = createSpeechAdapter({
    checkout,
    spawn: daemon.spawn,
    chunkSamples: 4,
    padSeconds: 0.005,
    timeoutMs: 2800,
    hostname: () => "test-host",
  });
  const started = Date.now();
  const error = await captureRejection(adapter.transcribe(input));
  const elapsed = Date.now() - started;
  assert.equal(error.code, "failed");
  assert.ok(elapsed >= 2800 - 50, `deadline must govern (elapsed ${elapsed})`);
  assert.ok(elapsed < 5000, `late-tail case must stay bounded (elapsed ${elapsed})`);
  const timeline = daemon.readReport().timeline;
  const firstFinal = timeline.indexOf("final");
  const firstRevision = timeline.indexOf("revision");
  const pendingRevision = timeline.indexOf("revision", firstRevision + 1);
  assert.ok(firstFinal !== -1 && firstFinal < pendingRevision, "first final must precede the pending revision");
  assert.equal(timeline.lastIndexOf("final"), firstFinal, "no second final may exist");
  assert.equal(timeline.indexOf("shutdown"), -1, "no shutdown may be sent for unresolved text");
  assert.deepEqual(daemon.record.kills, ["SIGTERM"]);
  assert.equal(daemon.record.closes.length, 1);
});
