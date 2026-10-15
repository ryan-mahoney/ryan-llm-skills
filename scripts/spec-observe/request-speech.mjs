// Host speech adapter: owns one Bun ASR daemon child per transcription and
// resolves the finalized transcript for a single 16 kHz mono Float32 PCM clip.
//
// Wire protocol (NDJSON over stdio) mirrors rearrange-writer's
// server/asr/asrDaemonProtocol.ts, protocol v1:
//   host  -> daemon : {type:"audio",pcm:<base64 little-endian f32>} | {type:"shutdown"}
//   daemon -> host  : {type:"ready",protocolVersion:1} | model-loading |
//                     model-ready (no fields) | backend (device) |
//                     partial/revision/final (text) | error
//
// Protocol-v1 observation limitation: the protocol has NO decode-completion
// acknowledgement for a written stream. The 250 ms text-event quiescence used
// for finalization below is a bounded adapter observation, not a protocol
// acknowledgement. A final only qualifies once every input frame has been
// submitted (trailing padding may still be in flight, as synchronous engines
// finalize early); any later nonempty text activity re-opens the wait.
//
// No durable runtime audio: PCM exists only as in-memory frames handed to the
// child's stdin. Child diagnostics (stdout/stderr content) never reach the API.

import { spawn as nodeSpawn } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PROTOCOL_VERSION = 1;
const SAMPLE_RATE = 16000;
const QUIESCENCE_MS = 250;
const KILL_GRACE_MS = 2000;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const WORKER_ARG = "server/asr/asrDaemonWorker.ts";

const ERROR_MESSAGES = {
  unavailable: "Speech transcription is unavailable.",
  "no-speech": "No speech was detected in the provided audio.",
  failed: "Speech transcription failed.",
};

function speechError(code) {
  return Object.assign(new Error(ERROR_MESSAGES[code]), { code });
}

// Silence is derived ONLY from truly zero input; nonzero input that yields no
// finals is a failure, never no-speech.
function isSilentInput(samples) {
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] !== 0) return false;
  }
  return true;
}

function isValidSamples(samples) {
  if (!(samples instanceof Float32Array)) return false;
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) return false;
  }
  return true;
}

function frameRanges(length, chunkSamples) {
  const ranges = [];
  for (let offset = 0; offset < length; offset += chunkSamples) {
    ranges.push([offset, Math.min(chunkSamples, length - offset)]);
  }
  return ranges;
}

// Await the flush callback: each frame is only written after the previous one
// was accepted downstream (async backpressure).
function writeLine(stream, line) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      if (error) reject(error);
      else resolve();
    };
    try {
      stream.write(line, finish);
    } catch (error) {
      finish(error);
    }
  });
}

export function createSpeechAdapter({
  checkout,
  spawn = nodeSpawn,
  timeoutMs = 60000,
  chunkSamples = 1600,
  padSeconds = 3.5,
  hostname = os.hostname,
} = {}) {
  const chunk = Math.max(1, Math.floor(chunkSamples));
  const padSamples = Math.max(0, Math.round(padSeconds * SAMPLE_RATE));

  // Static, non-diagnostic reasons; never interpolated with paths or output.
  async function readinessReason() {
    if (typeof checkout !== "string" || checkout.length === 0 || !path.isAbsolute(checkout)) {
      return "checkout-not-absolute";
    }
    let checkoutStat;
    try {
      checkoutStat = await stat(checkout);
    } catch {
      return "checkout-missing";
    }
    if (!checkoutStat.isDirectory()) return "checkout-missing";
    const workerPath = path.join(checkout, WORKER_ARG);
    let workerLstat;
    try {
      workerLstat = await lstat(workerPath);
    } catch {
      return "worker-missing";
    }
    if (workerLstat.isSymbolicLink()) return "worker-symlink";
    if (!workerLstat.isFile()) return "worker-not-regular";
    return null;
  }

  // Checks the configured absolute checkout and the worker file with lstat
  // (regular, non-symlink) WITHOUT spawning anything.
  async function readiness() {
    const host = hostname();
    const reason = await readinessReason();
    return { status: reason === null ? "ready" : "unavailable", host, reason };
  }

  async function transcribe(samples, signal) {
    if (!isValidSamples(samples)) throw speechError("failed");
    if (isSilentInput(samples)) throw speechError("no-speech");
    const ready = await readiness();
    if (ready.status !== "ready") throw speechError("unavailable");
    if (signal?.aborted) throw speechError("failed");
    return runSession(samples, signal);
  }

  // One owned child per session. The session settles only after the child's
  // 'close' event; failure/abort escalates TERM -> KILL (2 s) and awaits close
  // before releasing.
  function runSession(samples, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let failure = null;
      let closed = false;
      // Lifecycle: starting -> ready -> streaming -> finalizing -> shutdown.
      let phase = "starting";
      let sawModelReady = false;
      let inputComplete = false;
      let writeComplete = false;
      // Genuine final/clear state: a nonempty final observed after the last
      // input frame was submitted (finals during trailing padding qualify).
      // An earlier final never covers an outstanding pending tail, and empty
      // text never acknowledges a pending decode.
      let eligible = false;
      const finals = [];
      let quiescenceTimer = null;
      let deadlineTimer = null;
      let killTimer = null;
      let child = null;
      let stdoutBuffer = Buffer.alloc(0);
      let stdoutTotal = 0;
      let stderrTotal = 0;
      let notifyReady;
      const readyGate = new Promise((resolveReady) => {
        notifyReady = resolveReady;
      });

      function settle(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(quiescenceTimer);
        clearTimeout(deadlineTimer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value);
      }

      function maybeSettleAfterClose() {
        if (!closed || settled) return;
        if (failure) settle(speechError(failure.code));
      }

      // model-ready only classifies failures: load-time (pre-model) problems
      // are unavailable, runtime problems are failed.
      function classifyFailure() {
        return sawModelReady ? "failed" : "unavailable";
      }

      function observeFailure(code) {
        if (settled || failure) return;
        failure = { code };
        clearTimeout(quiescenceTimer);
        clearTimeout(deadlineTimer);
        notifyReady();
        if (!child) {
          // Nothing spawned (e.g. synchronous spawn throw): settle here so
          // timers and signal listeners are cleared immediately.
          settle(speechError(failure.code));
          return;
        }
        if (!closed) {
          try {
            child.kill("SIGTERM");
          } catch {}
          killTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, KILL_GRACE_MS);
        }
        maybeSettleAfterClose();
      }

      function onAbort() {
        // Abort is a failed transcription, not a distinct code.
        observeFailure("failed");
      }

      function stopQuiescence() {
        clearTimeout(quiescenceTimer);
        quiescenceTimer = null;
      }

      function restartQuiescence() {
        stopQuiescence();
        // Bounded observation window (see protocol-v1 limitation above).
        quiescenceTimer = setTimeout(() => {
          quiescenceTimer = null;
          if (settled || failure || !eligible || !writeComplete || phase !== "finalizing") return;
          phase = "shutdown";
          writeLine(child.stdin, `${JSON.stringify({ type: "shutdown" })}\n`).catch(() =>
            observeFailure("failed"),
          );
        }, QUIESCENCE_MS);
      }

      function handleText(event) {
        const text = event.text;
        if (typeof text !== "string") {
          observeFailure("failed");
          return;
        }
        if (text === "") {
          // Initially empty partial/revision (and empty "clear" finals) never
          // acknowledge a pending decode and never make text eligible or
          // complete; they only reset an already-open quiescence window.
          if (quiescenceTimer !== null) restartQuiescence();
          return;
        }
        if (event.type === "final") {
          finals.push(text);
          if (phase === "shutdown") return;
          if (inputComplete && sawModelReady) {
            // Tail-eligibility opens at submission of the last input frame AND
            // requires a post-model-ready final: a pre-model final stays in
            // ordered finals but cannot establish completion (the real
            // producer emits real text only after model-ready), so pipe
            // scheduling can never let an earlier final qualify a pending
            // tail. Finals during trailing padding remain valid for
            // synchronous engines.
            eligible = true;
            if (writeComplete) restartQuiescence();
          }
          return;
        }
        // Nonempty partial/revision is active text: after shutdown it fails the
        // session; before that it requires a subsequent genuine final and
        // resets any open quiescence window.
        if (phase === "shutdown") {
          observeFailure("failed");
          return;
        }
        eligible = false;
        stopQuiescence();
      }

      function handleEvent(event) {
        switch (event.type) {
          case "ready":
            if (event.protocolVersion !== PROTOCOL_VERSION) {
              observeFailure("unavailable");
              return;
            }
            if (phase === "starting") phase = "ready";
            notifyReady();
            return;
          case "model-ready":
            // Lazy engine start (the real worker loads on first audio):
            // model-ready only classifies errors, it never gates audio writes.
            sawModelReady = true;
            return;
          case "model-loading":
          case "status":
          case "backend":
            return;
          case "partial":
          case "revision":
          case "final":
            handleText(event);
            return;
          case "error":
            observeFailure(classifyFailure());
            return;
          default:
            observeFailure("failed");
        }
      }

      function handleLine(line) {
        if (line.trim() === "") return;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          observeFailure("failed");
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          observeFailure("failed");
          return;
        }
        if (typeof parsed.type !== "string") {
          observeFailure("failed");
          return;
        }
        handleEvent(parsed);
      }

      function handleStdoutChunk(chunkData) {
        stdoutTotal += chunkData.length;
        if (stdoutTotal > MAX_STDOUT_BYTES) {
          observeFailure("failed");
          return;
        }
        stdoutBuffer = stdoutBuffer.length === 0 ? Buffer.from(chunkData) : Buffer.concat([stdoutBuffer, chunkData]);
        for (;;) {
          const newline = stdoutBuffer.indexOf(0x0a);
          if (newline === -1) {
            if (stdoutBuffer.length > MAX_LINE_BYTES) observeFailure("failed");
            return;
          }
          const line = stdoutBuffer.subarray(0, newline);
          stdoutBuffer = stdoutBuffer.subarray(newline + 1);
          if (line.length > MAX_LINE_BYTES) {
            observeFailure("failed");
            return;
          }
          handleLine(line.toString("utf8"));
          if (settled || failure) return;
        }
      }

      function onClose(exitCode) {
        closed = true;
        clearTimeout(killTimer);
        notifyReady();
        if (settled || failure) {
          maybeSettleAfterClose();
          return;
        }
        // Nonwhitespace unterminated output is unresolved, even in shutdown.
        if (stdoutBuffer.length > 0 && stdoutBuffer.toString("utf8").trim() !== "") {
          observeFailure("failed");
          return;
        }
        if (phase === "shutdown") {
          if (exitCode === 0) {
            settle(null, finals.join(" "));
            return;
          }
          observeFailure(classifyFailure());
          return;
        }
        // Premature close never yields a transcript.
        observeFailure(classifyFailure());
      }

      async function writeFrame(source, offset, count) {
        const bytes = Buffer.allocUnsafe(count * 4);
        for (let i = 0; i < count; i++) {
          bytes.writeFloatLE(source ? source[offset + i] : 0, i * 4);
        }
        await writeLine(child.stdin, `${JSON.stringify({ type: "audio", pcm: bytes.toString("base64") })}\n`);
      }

      deadlineTimer = setTimeout(() => observeFailure(classifyFailure()), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });

      // Bun argv run server/asr/asrDaemonWorker.ts, cwd checkout.
      try {
        child = spawn("bun", ["run", WORKER_ARG], {
          cwd: checkout,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
      } catch {
        observeFailure("unavailable");
        return;
      }
      child.on("error", () => observeFailure("unavailable"));
      child.on("close", onClose);
      child.stdout.on("data", handleStdoutChunk);
      child.stderr.on("data", (chunkData) => {
        stderrTotal += chunkData.length;
        if (stderrTotal > MAX_STDERR_BYTES) observeFailure("failed");
        // Child diagnostics are discarded on purpose.
      });
      child.stdin.on("error", () => observeFailure(classifyFailure()));
      // Abort can land between the caller's check and listener installation.
      if (signal?.aborted) onAbort();

      const inputFrames = frameRanges(samples.length, chunk);
      const paddingFrames = frameRanges(padSamples, chunk);

      (async () => {
        // Audio is written as soon as the daemon is ready; the engine itself
        // loads lazily on the first audio, so model-ready never gates writes.
        await readyGate;
        if (settled || failure || closed) return;
        try {
          for (let i = 0; i < inputFrames.length; i++) {
            const [offset, count] = inputFrames[i];
            const submitted = writeFrame(samples, offset, count);
            if (i === inputFrames.length - 1) {
              // Tail-eligibility opens at submission of the last input frame.
              inputComplete = true;
            }
            await submitted;
            if (settled || failure || closed) return;
          }
          for (const [offset, count] of paddingFrames) {
            await writeFrame(null, offset, count);
            if (settled || failure || closed) return;
          }
        } catch {
          observeFailure("failed");
          return;
        }
        writeComplete = true;
        phase = "finalizing";
        // Padding is fully written: start the quiescence observation if a
        // genuine final already qualified during trailing padding.
        if (eligible) restartQuiescence();
      })();
    });
  }

  return { readiness, transcribe };
}
