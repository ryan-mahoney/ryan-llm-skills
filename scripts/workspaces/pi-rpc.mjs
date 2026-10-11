// Pi RPC child transport for discussion threads (library-only).
//
// Owns exactly one bounded `pi --mode rpc` child at the final spawn boundary:
// fixed read-tool argv, startup session identity checks, correlated requests,
// ordered event envelopes and bounded confirmed shutdown. The shared
// LF-framing splitter and session reader stay owned by
// scripts/spec-observe/core.mjs; scheduling, persistence and process
// reconciliation belong to their own steps.

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createJsonlSplitter, readSessionBranch } from "../spec-observe/core.mjs";

const EXECUTABLE = "pi";
const MAX_FRAME_BYTES = 1024 * 1024;
const STARTUP_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 4_000;
const CLOSE_KILL_WAIT_MS = 1_000;
const STDERR_TAIL_BYTES = 8192;
const READ_TOOLS = ["read", "grep", "find", "ls"];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ALLOWED_COMMANDS = new Set(["prompt", "get_state", "get_messages", "get_entries", "get_commands", "clear_queue", "abort"]);
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const defaultClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

// Idempotent bounded shutdown for one owned Pi child handle. Adapter-level
// concerns (pending rejection, exit envelopes, closed flags) stay with the
// caller; this helper owns only the process handle: close stdin, wait 4s for
// exit, SIGKILL through the owned handle, wait 1s, return confirmed death or
// an unconfirmed result. Never signals a recorded numeric PID.
const ownedCloseResults = new WeakMap();

export function closeOwnedPiChild(child, { clock = defaultClock } = {}) {
  if (!child || typeof child !== "object" || typeof child.once !== "function") {
    return Promise.reject(new TypeError("child must be an owned ChildProcess-like object"));
  }
  const existing = ownedCloseResults.get(child);
  if (existing) return existing;
  const closing = (async () => {
    const exitState = () => {
      const code = child.exitCode ?? null;
      const signal = child.signalCode ?? null;
      return code === null && signal === null ? null : { code, signal };
    };
    let exited = exitState();
    let resolveExit = null;
    const exitPromise = new Promise((resolvePromise) => {
      resolveExit = resolvePromise;
    });
    const onExit = (code, signal) => {
      exited = { code: code ?? null, signal: signal ?? null };
      resolveExit();
    };
    const onClose = (code, signal) => {
      if (exited === null) onExit(code, signal);
    };
    // Observation is installed before stdin is closed so a synchronous exit
    // from an injected ChildProcess-like boundary cannot be missed.
    child.once("exit", onExit);
    child.once("close", onClose);
    const cleanup = () => {
      if (typeof child.removeListener === "function") {
        child.removeListener("exit", onExit);
        child.removeListener("close", onClose);
      }
    };
    const waitForExit = async (ms) => {
      const observed = exited ?? exitState();
      if (observed !== null) {
        exited = observed;
        cleanup();
        return true;
      }
      let timer = null;
      const timedOut = await new Promise((resolvePromise) => {
        timer = clock.setTimeout(() => resolvePromise(true), ms);
        exitPromise.then(() => resolvePromise(false));
      });
      if (timer !== null) clock.clearTimeout(timer);
      const settled = exited ?? exitState();
      if (settled !== null) {
        exited = settled;
        cleanup();
        return true;
      }
      return !timedOut;
    };
    if (child.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.end();
      } catch {
        // stdin already closed
      }
    }
    let dead = await waitForExit(CLOSE_GRACE_MS);
    if (!dead) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
      dead = await waitForExit(CLOSE_KILL_WAIT_MS);
    }
    cleanup();
    return Object.freeze({
      confirmed_death: dead,
      exit_code: exited?.code ?? null,
      signal: exited?.signal ?? null,
      pid: typeof child.pid === "number" ? child.pid : null,
    });
  })();
  ownedCloseResults.set(child, closing);
  return closing;
}

const typedError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const invalidThread = (message) => typedError("invalid-thread", message);
const sessionMismatch = (message, extra = {}) => typedError("session-mismatch", message, extra);
const isUuid = (value) => typeof value === "string" && UUID_PATTERN.test(value);
const isSafeArg = (value) =>
  typeof value === "string" && value.length > 0 && value[0] !== "-" && !/[\u0000-\u001f\u007f]/.test(value);

async function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw invalidThread(`${label} must be an absolute path`);
  let real;
  try {
    real = await realpath(value);
  } catch (error) {
    throw invalidThread(`${label} is not an existing directory: ${error.code ?? "unknown"}`);
  }
  if (real !== value) throw invalidThread(`${label} is not canonical: ${value} resolves to ${real}`);
  if (!(await stat(real)).isDirectory()) throw invalidThread(`${label} is not a directory`);
  return real;
}

function modelArguments(model) {
  if (model === undefined || model === null) return [];
  if (typeof model !== "object" || Array.isArray(model)) throw invalidThread("model must be an object");
  for (const key of ["provider", "model"]) {
    if (!isSafeArg(model[key])) {
      throw invalidThread(`model.${key} must be a non-empty string without control characters or a leading dash`);
    }
  }
  const args = ["--provider", model.provider, "--model", model.model];
  if (model.thinking !== undefined) {
    if (!THINKING_LEVELS.includes(model.thinking)) {
      throw invalidThread(`model.thinking must be one of ${THINKING_LEVELS.join(", ")}`);
    }
    args.push("--thinking", model.thinking);
  }
  return args;
}

function isContained(file, sessionDir) {
  const rel = relative(sessionDir, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function readHeader(file) {
  try {
    return await readSessionBranch(file, { limit: 1 });
  } catch (error) {
    throw sessionMismatch(`session file is unreadable: ${error.code ?? error.message}`, { cause: error });
  }
}

function assertHeaderIdentity(branch, thread, label) {
  const header = branch.header;
  if (!header || typeof header !== "object") throw sessionMismatch(`${label} has no session header`);
  if (header.id !== thread.session_id) {
    throw sessionMismatch(`${label} id ${String(header.id)} does not match thread session_id`);
  }
  if (typeof header.cwd !== "string" || resolve(header.cwd) !== thread.execution_dir) {
    throw sessionMismatch(`${label} cwd ${String(header.cwd)} does not match execution_dir`);
  }
}

// Resume accepts only an existing canonical file contained in session_dir
// whose header still identifies this thread's session and execution directory.
async function assertResumeFile(thread) {
  const file = thread.session_file;
  if (typeof file !== "string" || !isAbsolute(file)) throw sessionMismatch("session file must be an absolute path");
  if (!isContained(file, thread.session_dir)) throw sessionMismatch("session file is outside session_dir");
  let real;
  try {
    real = await realpath(file);
  } catch (error) {
    throw sessionMismatch(`session file is missing or unreadable: ${error.code ?? "unknown"}`);
  }
  if (real !== file) throw sessionMismatch("session file is not canonical (symlink escape)");
  if (!(await stat(real)).isFile()) throw sessionMismatch("session file is not a regular file");
  assertHeaderIdentity(await readHeader(file), thread, "session file");
}

// Pi 1.1.0 SessionManager creates the file lazily on the first conversation
// (dist/core/session-manager.js _persist), so ENOENT is accepted only for the
// prospective NEW file under the canonical session_dir. An existing file must
// already carry the matching session header.
async function assertProspectiveFile(file, thread) {
  if (typeof file !== "string" || !isAbsolute(file)) throw sessionMismatch("get_state did not return a session file");
  if (!isContained(file, thread.session_dir)) throw sessionMismatch("session file is outside session_dir");
  const parent = await realpath(dirname(file)).catch(() => null);
  if (parent !== thread.session_dir) throw sessionMismatch("session file parent is not the canonical session_dir");
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw sessionMismatch(`session file is unreadable: ${error.code ?? "unknown"}`);
  }
  if (info.isSymbolicLink()) throw sessionMismatch("session file is a symlink");
  if (!info.isFile()) throw sessionMismatch("session file is not a regular file");
  const real = await realpath(file).catch(() => null);
  if (real === null) throw sessionMismatch("session file is unreadable");
  if (real !== file) throw sessionMismatch("session file is not canonical (symlink escape)");
  assertHeaderIdentity(await readHeader(file), thread, "new session file");
}

export async function createPiRpc({ thread, spawn: spawnImpl = nodeSpawn, clock = defaultClock, signal = null } = {}) {
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) throw invalidThread("thread is required");
  if (!isUuid(thread.thread_id)) throw invalidThread("thread_id must be a UUID");
  if (!isUuid(thread.session_id)) throw invalidThread("session_id must be a UUID");
  if (typeof spawnImpl !== "function") throw invalidThread("spawn must be a function");
  if (!clock || typeof clock.setTimeout !== "function" || typeof clock.clearTimeout !== "function") {
    throw invalidThread("clock must provide setTimeout and clearTimeout");
  }
  if (signal !== null && signal !== undefined) {
    if (typeof signal !== "object" || typeof signal.addEventListener !== "function") {
      throw invalidThread("signal must be an AbortSignal-like object");
    }
  }
  const execution_dir = await canonicalDirectory(thread.execution_dir, "execution_dir");
  const session_dir = await canonicalDirectory(thread.session_dir, "session_dir");
  const spawnThread = Object.freeze({
    thread_id: thread.thread_id,
    session_id: thread.session_id,
    execution_dir,
    session_dir,
    session_file: thread.session_file ?? null,
  });
  const extraArguments = modelArguments(thread.model);
  const mode = spawnThread.session_file === null ? "new" : "resume";
  if (mode === "resume") await assertResumeFile(spawnThread);

  const generation = randomUUID();
  const childId = randomUUID();
  const args = [
    "--mode",
    "rpc",
    "--session-dir",
    session_dir,
    "--name",
    `discussion:${spawnThread.thread_id}`,
    "--tools",
    READ_TOOLS.join(","),
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-approve",
  ];
  if (mode === "resume") args.push("--session", spawnThread.session_file);
  else args.push("--session-id", spawnThread.session_id);
  args.push(...extraArguments);

  if (signal !== null && signal !== undefined && signal.aborted) {
    throw typedError("service-closed", "pi adapter aborted before spawn", { uncertain: true });
  }
  const child = spawnImpl(EXECUTABLE, args, { cwd: execution_dir, shell: false, stdio: ["pipe", "pipe", "pipe"] });

  const events = new EventEmitter();
  const pending = new Map();
  const usedIds = new Set();
  let startupState = null;
  let stdoutEnded = false;
  let transportBroken = null;
  let stdinBroken = false;
  let policyLatched = false;
  let stdinClosed = false;
  let adapterClosed = false;
  let closePromise = null;
  let exited = null;
  let stderrTail = "";
  let resolveExit;
  const exitPromise = new Promise((resolvePromise) => {
    resolveExit = resolvePromise;
  });

  const emitEnvelope = (event) => {
    events.emit("event", { thread_id: spawnThread.thread_id, generation, event });
  };

  const emitExit = (code, signal) => {
    exited = { code: code ?? null, signal: signal ?? null };
    emitEnvelope({ type: "exit", code: exited.code, signal: exited.signal });
    resolveExit();
    rejectPending(
      typedError("transport-error", `pi child exited (code ${String(exited.code)}, signal ${String(exited.signal)})`, {
        uncertain: true,
        reason: "child-exit",
        exit_code: exited.code,
        signal: exited.signal,
      }),
    );
  };
  child.once("exit", (code, signal) => {
    if (!exited) emitExit(code, signal);
  });
  child.once("close", (code, signal) => {
    if (!exited) emitExit(code, signal);
  });
  child.on("error", (error) => {
    surfaceTransport("child-error", { message: `pi child error: ${error.message}` });
  });
  child.stderr?.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  child.stdin?.on("error", (error) => {
    failWrite(error, "stdin");
  });

  function rejectPending(error) {
    for (const entry of pending.values()) {
      clock.clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function surfaceTransport(reason, details = {}) {
    emitEnvelope({ type: "transport_error", reason, ...details });
    rejectPending(
      typedError("transport-error", details.message ?? `pi transport error: ${reason}`, {
        uncertain: true,
        reason,
        ...details,
      }),
    );
  }

  function refuse(kind, details) {
    policyLatched = true;
    emitEnvelope({ type: "policy_refusal", kind, ...details });
    rejectPending(typedError("policy-refusal", details.message ?? "policy refusal", { kind, ...details }));
  }

  function failWrite(error, context) {
    if (adapterClosed || stdinBroken) return;
    stdinBroken = true;
    surfaceTransport("stdin-error", { message: `pi stdin ${context} write failed: ${error.message}`, context });
  }

  // Writes serialize on the stream write callback, which fires once the chunk
  // has been flushed; the next command is not issued before that, so stdin
  // backpressure is honored without dropping or reordering commands.
  let writeChain = Promise.resolve();
  function writeLine(line) {
    return new Promise((resolvePromise, rejectPromise) => {
      if (adapterClosed || stdinClosed || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
        rejectPromise(new Error("pi stdin is not writable"));
        return;
      }
      try {
        child.stdin.write(line, (error) => {
          if (error) rejectPromise(error);
          else resolvePromise();
        });
      } catch (error) {
        rejectPromise(error);
      }
    });
  }

  function enqueueWrite(message, isCurrent = () => true) {
    const attempt = writeChain.then(() => (isCurrent() ? writeLine(`${JSON.stringify(message)}\n`) : undefined));
    writeChain = attempt.catch(() => {});
    return attempt;
  }

  function refuseExtensionUi(record) {
    const method = typeof record.method === "string" ? record.method : null;
    const details = { method, message: `extension UI request ${String(method)} is not allowed` };
    if (method !== null && DIALOG_METHODS.has(method) && record.id !== undefined) {
      // Latch immediately so no new prompt can start while the cancellation is
      // in flight, then surface refusal only after the matching cancel write
      // callback completes (or fails).
      policyLatched = true;
      enqueueWrite({ type: "extension_ui_response", id: record.id, cancelled: true }).then(
        () => refuse("extension-ui", details),
        (error) => {
          refuse("extension-ui", details);
          failWrite(error, "extension_ui_response");
        },
      );
      return;
    }
    refuse("extension-ui", details);
  }

  function settle(record) {
    const entry = pending.get(record.id);
    if (!entry) return;
    pending.delete(record.id);
    clock.clearTimeout(entry.timer);
    if (record.command !== entry.command) {
      entry.reject(
        typedError("protocol-error", `response command ${String(record.command)} does not match ${entry.command}`, {
          id: record.id,
        }),
      );
      return;
    }
    if (record.success === true) entry.resolve(record);
    else {
      entry.reject(
        typedError("command-failed", typeof record.error === "string" ? record.error : `pi ${entry.command} failed`, {
          command: entry.command,
          id: record.id,
          response: record,
        }),
      );
    }
  }

  function handleLine(record) {
    if (adapterClosed || transportBroken) return;
    if (!record || typeof record !== "object") {
      transportBroken = "malformed-frame";
      surfaceTransport("malformed-frame", { message: "pi stdout line was not a JSON object" });
      return;
    }
    if (record.type === "response") {
      settle(record);
      return;
    }
    if (record.type === "extension_ui_request") {
      refuseExtensionUi(record);
      return;
    }
    if (record.type === "extension_error") {
      refuse("extension", { message: "extension activity is not allowed under --no-extensions" });
      return;
    }
    if (record.type === "tool_execution_start") {
      const name = typeof record.toolName === "string" ? record.toolName : null;
      if (name === null || !READ_TOOLS.includes(name)) {
        refuse("tool", { toolName: name, message: `unexpected tool ${String(name)} outside ${READ_TOOLS.join(", ")}` });
        return;
      }
    }
    emitEnvelope(record);
  }

  const splitter = createJsonlSplitter({
    onLine: handleLine,
    onError: () => {
      transportBroken = "malformed-frame";
      surfaceTransport("malformed-frame", { message: "pi stdout contained a malformed JSONL frame" });
    },
  });
  let frameBytes = 0;
  const writeStdout = (chunk) => {
    if (adapterClosed || transportBroken || stdoutEnded) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    // Count raw bytes per LF frame without decoding; the shared splitter keeps
    // the only UTF-8 parser. Oversize frames are dropped before they reach it.
    let scanned = frameBytes;
    for (const byte of bytes) {
      if (byte === 0x0a) {
        scanned = 0;
        continue;
      }
      scanned += 1;
      if (scanned > MAX_FRAME_BYTES) {
        transportBroken = "oversize-frame";
        surfaceTransport("oversize-frame", {
          message: `pi stdout frame exceeds ${MAX_FRAME_BYTES} bytes`,
          limit: MAX_FRAME_BYTES,
        });
        return;
      }
    }
    try {
      splitter.write(bytes);
    } catch {
      return;
    }
    for (const byte of bytes) frameBytes = byte === 0x0a ? 0 : frameBytes + 1;
  };
  child.stdout?.on("data", writeStdout);
  child.stdout?.once("end", () => {
    if (stdoutEnded || adapterClosed) return;
    stdoutEnded = true;
    let remainder = "";
    try {
      remainder = splitter.end() ?? "";
    } catch {
      remainder = "";
    }
    surfaceTransport("stdout-eof", { message: "pi stdout ended", torn: remainder.length > 0 });
  });
  child.stdout?.on("error", () => {
    if (stdoutEnded || adapterClosed) return;
    stdoutEnded = true;
    surfaceTransport("stdout-eof", { message: "pi stdout errored" });
  });

  function send(command, { timeoutMs = REQUEST_TIMEOUT_MS, phase = "request" } = {}) {
    if (adapterClosed) return Promise.reject(typedError("service-closed", "pi adapter is closed", { uncertain: true }));
    if (signal !== null && signal !== undefined && signal.aborted) {
      return Promise.reject(typedError("service-closed", "pi adapter aborted", { uncertain: true }));
    }
    if (exited || transportBroken !== null || stdoutEnded || stdinBroken) {
      const reason = exited ? "child-exit" : stdinBroken ? "stdin-error" : stdoutEnded ? "stdout-eof" : transportBroken;
      return Promise.reject(typedError("transport-error", "pi transport is not usable", { uncertain: true, reason }));
    }
    const id = command.id === undefined ? randomUUID() : command.id;
    if (typeof id !== "string" || id.length === 0) {
      return Promise.reject(typedError("invalid-command", "request id must be a non-empty string"));
    }
    if (usedIds.has(id)) {
      return Promise.reject(typedError("duplicate-request-id", `request id was already used: ${id}`, { id }));
    }
    usedIds.add(id);
    return new Promise((resolvePromise, rejectPromise) => {
      const entry = { command: command.type, id, resolve: resolvePromise, reject: rejectPromise, timer: null };
      entry.timer = clock.setTimeout(() => {
        if (pending.get(id) !== entry) return;
        pending.delete(id);
        rejectPromise(
          typedError("request-timeout", `pi did not answer ${command.type} within ${timeoutMs}ms`, {
            uncertain: true,
            command: command.type,
            id,
            phase,
          }),
        );
      }, timeoutMs);
      pending.set(id, entry);
      enqueueWrite({ ...command, id }, () => pending.get(id) === entry).catch((error) => {
        if (pending.get(id) === entry) {
          entry.reject(
            typedError("transport-error", `pi ${command.type} write failed: ${error.message}`, {
              uncertain: true,
              reason: "stdin-error",
              command: command.type,
              id,
            }),
          );
          pending.delete(id);
          clock.clearTimeout(entry.timer);
        }
        if (adapterClosed) return;
        failWrite(error, command.type);
      });
    });
  }

  async function verifyIdentityBeforePrompt() {
    try {
      const response = await send({ type: "get_state" }, { phase: "pre-prompt" });
      const state = response.data;
      if (!state || typeof state !== "object") throw sessionMismatch("get_state returned no session state before prompt");
      if (state.sessionId !== spawnThread.session_id) {
        throw sessionMismatch(`get_state sessionId ${String(state.sessionId)} does not match thread session_id`);
      }
      if (mode === "resume") {
        if (typeof state.sessionFile !== "string" || resolve(state.sessionFile) !== spawnThread.session_file) {
          throw sessionMismatch("get_state session file does not match the resumed file");
        }
        await assertResumeFile(spawnThread);
      } else {
        if (typeof state.sessionFile !== "string" || state.sessionFile !== startupState?.sessionFile) {
          throw sessionMismatch("get_state session file changed before prompt");
        }
        await assertProspectiveFile(state.sessionFile, spawnThread);
      }
    } catch (error) {
      await close().catch(() => {});
      throw error;
    }
  }

  async function request(command) {
    if (adapterClosed) throw typedError("service-closed", "pi adapter is closed", { uncertain: true });
    if (!command || typeof command !== "object" || typeof command.type !== "string" || command.type.length === 0) {
      throw typedError("invalid-command", "command must be an object with a string type");
    }
    if (!ALLOWED_COMMANDS.has(command.type)) {
      throw typedError("command-not-allowed", `command ${command.type} is not allowed on the discussion transport`, {
        command: command.type,
      });
    }
    if (policyLatched && command.type === "prompt") {
      throw typedError("policy-refusal", "transport policy is latched after a refusal", { kind: "latched" });
    }
    if (command.type === "prompt") {
      await verifyIdentityBeforePrompt();
      if (policyLatched) {
        throw typedError("policy-refusal", "transport policy is latched after a refusal", { kind: "latched" });
      }
    }
    return send(command);
  }

  const onAbort = () => {
    void close();
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  function close() {
    if (closePromise) return closePromise;
    if (signal && typeof signal.removeEventListener === "function") {
      signal.removeEventListener("abort", onAbort);
    }
    closePromise = (async () => {
      adapterClosed = true;
      rejectPending(typedError("service-closed", "pi adapter closed", { uncertain: true }));
      if (!stdinClosed && child.stdin && !child.stdin.destroyed) {
        stdinClosed = true;
        try {
          child.stdin.end();
        } catch {
          // stdin already closed
        }
      }
      return closeOwnedPiChild(child, { clock });
    })();
    return closePromise;
  }

  // One startup budget covers both handshake commands; the injected clock owns
  // the only 10s timer and it is cleared as soon as the checks settle.
  let startupTimer = null;
  const startupBudget = new Promise((resolvePromise, rejectPromise) => {
    startupTimer = clock.setTimeout(
      () =>
        rejectPromise(
          typedError("request-timeout", `pi startup did not complete within ${STARTUP_TIMEOUT_MS}ms`, {
            uncertain: true,
            phase: "startup",
          }),
        ),
      STARTUP_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([
      (async () => {
        const stateResponse = await send({ type: "get_state" }, { phase: "startup" });
        startupState = stateResponse.data ?? null;
        if (!startupState || typeof startupState !== "object") throw sessionMismatch("get_state returned no session state");
        if (startupState.sessionId !== spawnThread.session_id) {
          throw sessionMismatch(`get_state sessionId ${String(startupState.sessionId)} does not match thread session_id`);
        }
        if (mode === "resume") {
          if (typeof startupState.sessionFile !== "string" || resolve(startupState.sessionFile) !== spawnThread.session_file) {
            throw sessionMismatch("get_state session file does not match the resumed file");
          }
          await assertResumeFile(spawnThread);
        } else {
          await assertProspectiveFile(startupState.sessionFile, spawnThread);
        }
        const commandsResponse = await send({ type: "get_commands" }, { phase: "startup" });
        const commands = commandsResponse.data?.commands;
        if (!Array.isArray(commands) || commands.length !== 0) {
          throw typedError(
            "policy-refusal",
            "get_commands reported extension, skill or prompt-template commands under the fixed read-only argv",
            { commands: Array.isArray(commands) ? commands : null },
          );
        }
      })(),
      startupBudget,
    ]);
  } catch (error) {
    if (!error.stderr && stderrTail) error.stderr = stderrTail;
    await close().catch(() => {});
    throw error;
  } finally {
    clock.clearTimeout(startupTimer);
  }

  const identity = Object.freeze({
    thread_id: spawnThread.thread_id,
    session_id: spawnThread.session_id,
    generation,
    child_id: childId,
    pid: typeof child.pid === "number" ? child.pid : null,
    session_file: mode === "resume" ? spawnThread.session_file : startupState.sessionFile,
    mode,
  });
  return Object.freeze({ request, events, close, identity });
}
