#!/usr/bin/env node
// Disposable fake ASR daemon for request-speech.test.mjs.
//
// Speaks the protocol-v1 NDJSON wire format over stdio like
// server/asr/asrDaemonWorker.ts and records what it receives to
// FAKE_ASR_REPORT. It is spawned through node so only the adapter's spawn
// executable boundary differs from production; everything else (pipes, line
// framing, process lifecycle) is a real child process.
//
// Lifecycle mirrors the real worker (server/asr/asrDaemonWorker.ts:139-177):
// `ready` (protocolVersion 1) is emitted at startup and the engine
// (model-loading/model-ready/backend) starts lazily on the FIRST audio
// request. Audio therefore always precedes model-ready.
//
// Scenario selection: argv[2] or FAKE_ASR_SCENARIO.
//   happy                     — lazy engine, empty partial, delayed finals
//                               after FAKE_ASR_FINAL_AFTER_SAMPLES samples.
//   sync-final-during-padding — final on the last input frame
//                               (FAKE_ASR_INPUT_SAMPLES) then stdin pauses so
//                               trailing padding is provably still in flight.
//   late-tail                 — real EV-5 failure replay after the full
//                               input/padding threshold: first genuine final +
//                               empty revision, pending nonempty revision at
//                               +900 ms, second genuine final at +1200 ms.
//   late-tail-unresolved      — same replay, but no second final ever arrives.
//   earlier-final-tail        — model-ready then earlier final on the first
//                               audio (stdin paused 200 ms), later frames emit
//                               a pending nonempty tail then empty clears;
//                               never a new final.
//   initially-empty-pending   — model-ready then earlier final on the first
//                               audio (stdin paused 200 ms), later frames emit
//                               only empty revision/partials; never a new
//                               final.
//   late-active-text          — final, then a nonempty partial after shutdown.
//   unterminated-output       — an unterminated stdout line at close.
//   silent                    — lazy engine only; ignores audio and shutdown.
//   nonzero-exit              — exits 3 on the first audio request.
//   pre-model-error           — load error (no model-ready) on first audio.
//   runtime-error             — error after model-ready (diagnostic string
//                               that must never surface in the API).
//   malformed                 — non-JSON stdout line on first audio.
//   overlong-line             — one stdout line above 64 KiB on first audio.
//   over-limit-total          — stdout total above 256 KiB on first audio.
//   over-limit-stderr         — stderr above 16 KiB on first audio.
//   stubborn                  — ignores shutdown and SIGTERM (needs SIGKILL).

import { writeFileSync } from "node:fs";

const scenario = process.argv[2] ?? process.env.FAKE_ASR_SCENARIO ?? "happy";
const reportPath = process.env.FAKE_ASR_REPORT ?? null;

const KNOWN_SCENARIOS = [
  "happy",
  "sync-final-during-padding",
  "late-tail",
  "late-tail-unresolved",
  "earlier-final-tail",
  "initially-empty-pending",
  "late-active-text",
  "unterminated-output",
  "silent",
  "nonzero-exit",
  "pre-model-error",
  "runtime-error",
  "malformed",
  "overlong-line",
  "over-limit-total",
  "over-limit-stderr",
  "stubborn",
];

const state = {
  scenario,
  requests: [],
  samples: [],
  events: [],
  timeline: [],
  modelStarted: false,
  shutdownSeen: false,
  partialSent: false,
  tailSent: false,
  finalSent: false,
  lastInputSeen: false,
};

function envText(name, fallback) {
  const value = process.env[name];
  return typeof value === "string" && value !== "" ? value : fallback;
}

function send(event) {
  state.events.push(event.type);
  state.timeline.push(event.type);
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitModelLifecycle() {
  send({ type: "model-loading", progress: 0 });
  send({ type: "model-ready" });
  send({ type: "backend", device: "cpu" });
}

function writeReport() {
  if (!reportPath) return;
  try {
    writeFileSync(reportPath, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Report is best-effort; killed scenarios legitimately have none.
  }
}

process.on("exit", writeReport);

function startup() {
  if (!KNOWN_SCENARIOS.includes(scenario)) {
    process.exit(2);
  }
  send({ type: "ready", protocolVersion: 1 });
}

function onAudio() {
  if (!state.modelStarted) {
    state.modelStarted = true;
    if (scenario === "pre-model-error") {
      // Load error: the engine never becomes ready.
      send({ type: "model-loading", progress: 0 });
      send({ type: "error", message: "model load failed" });
      return;
    }
    emitModelLifecycle();
  }
  switch (scenario) {
    case "happy": {
      if (!state.partialSent) {
        state.partialSent = true;
        // Initially empty partial: must not acknowledge the pending decode.
        send({ type: "partial", text: "" });
      }
      const threshold = Number(process.env.FAKE_ASR_FINAL_AFTER_SAMPLES ?? 0);
      if (!state.finalSent && threshold > 0 && state.samples.length >= threshold) {
        // Delayed final: only after every frame AND all padding arrived.
        state.finalSent = true;
        send({ type: "final", text: envText("FAKE_ASR_TEXT", "hello there") });
        setTimeout(() => {
          send({ type: "final", text: envText("FAKE_ASR_TEXT_2", "world") });
        }, 30);
      }
      return;
    }
    case "sync-final-during-padding": {
      const inputSamples = Number(process.env.FAKE_ASR_INPUT_SAMPLES ?? 0);
      if (!state.finalSent && inputSamples > 0 && state.samples.length >= inputSamples) {
        // Synchronous engine: the final lands on the last input frame while
        // trailing padding is still being written. Pausing stdin makes the
        // remaining padding writes provably block on backpressure.
        state.finalSent = true;
        send({ type: "final", text: envText("FAKE_ASR_TEXT", "padding done") });
        process.stdin.pause();
        setTimeout(() => process.stdin.resume(), 200);
      }
      return;
    }
    case "late-tail":
    case "late-tail-unresolved": {
      const threshold = Number(process.env.FAKE_ASR_FINAL_AFTER_SAMPLES ?? 0);
      if (state.finalSent || threshold <= 0 || state.samples.length < threshold) return;
      // Replay the recorded EV-5 failure AFTER the full input/padding
      // threshold: a genuine final with an empty revision in the same turn,
      // then a pending nonempty revision 900 ms later, then — in the complete
      // variant — a second genuine final at 1200 ms. The delays deliberately
      // exceed the old 250 ms observation window.
      state.finalSent = true;
      send({ type: "final", text: envText("FAKE_ASR_TEXT", "first sentence") });
      send({ type: "revision", text: "" });
      setTimeout(() => {
        send({ type: "revision", text: envText("FAKE_ASR_TEXT_2", "second sentence") });
      }, 900);
      if (scenario === "late-tail") {
        setTimeout(() => {
          send({ type: "final", text: envText("FAKE_ASR_TEXT_2", "second sentence") });
          send({ type: "revision", text: "" });
        }, 1200);
      }
      return;
    }
    case "earlier-final-tail":
    case "initially-empty-pending": {
      if (!state.finalSent) {
        // Real producer lifecycle: the earlier final arrives after model-ready
        // on the FIRST audio while most input frames are still being written.
        // Pausing stdin forces pipe backpressure so the final is provably
        // consumed before the last input frame is submitted — never an
        // impossible pre-model final.
        state.finalSent = true;
        send({ type: "final", text: envText("FAKE_ASR_TEXT", "hello") });
        process.stdin.pause();
        setTimeout(() => process.stdin.resume(), 200);
        return;
      }
      if (scenario === "initially-empty-pending") {
        // Only initially empty decode events; never a new final.
        send({ type: "partial", text: "" });
        send({ type: "revision", text: "" });
        return;
      }
      // Pending nonempty tail then empty clears; never a new final.
      if (!state.tailSent) {
        state.tailSent = true;
        send({ type: "partial", text: "world" });
      }
      send({ type: "partial", text: "" });
      send({ type: "revision", text: "" });
      return;
    }
    case "late-active-text":
    case "unterminated-output":
      if (!state.finalSent) {
        state.finalSent = true;
        send({ type: "final", text: "done" });
      }
      return;
    case "silent":
    case "stubborn":
      return;
    case "nonzero-exit":
      process.exit(3);
    case "runtime-error":
      send({ type: "error", message: "SECRET-DAEMON-DIAGNOSTIC" });
      return;
    case "malformed":
      process.stdout.write("this is not json\n");
      return;
    case "overlong-line":
      process.stdout.write(`${JSON.stringify({ type: "partial", text: "a".repeat(70 * 1024) })}\n`);
      return;
    case "over-limit-total":
      for (let i = 0; i < 40; i++) {
        process.stdout.write(`${JSON.stringify({ type: "partial", text: "b".repeat(8 * 1024) })}\n`);
      }
      return;
    case "over-limit-stderr":
      process.stderr.write("x".repeat(20 * 1024));
      return;
    default:
      return;
  }
}

function handleAudio(pcm) {
  state.requests.push("audio");
  state.timeline.push("audio");
  const bytes = Buffer.from(pcm, "base64");
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    state.samples.push(bytes.readFloatLE(offset));
  }
  const inputSamples = Number(process.env.FAKE_ASR_INPUT_SAMPLES ?? 0);
  if (inputSamples > 0 && !state.lastInputSeen && state.samples.length >= inputSamples) {
    // Timeline marker for the last INPUT audio event (padding excluded).
    state.lastInputSeen = true;
    state.timeline.push("last-input-audio");
  }
  onAudio();
}

function handleRequest(request) {
  if (request.type === "audio") {
    handleAudio(request.pcm);
    return;
  }
  if (request.type === "shutdown") {
    state.requests.push("shutdown");
    state.timeline.push("shutdown");
    state.shutdownSeen = true;
    if (scenario === "stubborn") return; // ignores shutdown on purpose
    if (scenario === "late-active-text") {
      // Active text after shutdown must fail the session, not succeed.
      process.stdout.write(`${JSON.stringify({ type: "partial", text: "late" })}\n`, () => process.exit(0));
      return;
    }
    if (scenario === "unterminated-output") {
      // Unterminated line: must be rejected at close even in shutdown phase.
      process.stdout.write('{"type":"final","text":"tail"', () => process.exit(0));
      return;
    }
    process.exit(0);
    return;
  }
  state.requests.push(String(request.type));
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() === "") continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof request !== "object" || request === null) continue;
    handleRequest(request);
  }
});

if (scenario === "stubborn") {
  // Escalation test: only SIGKILL may end this process.
  process.on("SIGTERM", () => {});
} else {
  // The report must survive deadline failures: write it on TERM, then die by
  // the signal so close observations stay unchanged.
  process.on("SIGTERM", () => {
    writeReport();
    process.removeAllListeners("SIGTERM");
    process.kill(process.pid, "SIGTERM");
  });
}

startup();
