// Step 2 focused tests: one bounded Pi RPC child per adapter with fixed
// read-tool argv, canonical session identity, correlated requests, ordered
// events and bounded confirmed shutdown.
//
// The fake fixture replaces only the final spawned process; the adapter's
// ordinary spawn boundary, stdin/stdout pipes and framing stay production
// code. Deadlines use an injected manual clock where timing would otherwise
// cost real seconds. The installed-Pi tests touch no provider and no prompt.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createPiRpc } from "./pi-rpc.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url));
const INSTALLED_PI = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function manualClock() {
  let next = 1;
  const timers = new Map();
  return {
    setTimeout(callback, ms) {
      const id = next++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fire(ms) {
      for (const [id, timer] of [...timers]) {
        if (timer.ms !== ms) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

async function makeRoots(label = "pi-rpc-") {
  const root = await realpath(await mkdtemp(join(tmpdir(), label)));
  const execution_dir = join(root, "exec");
  const session_dir = join(root, "sessions");
  await mkdir(execution_dir);
  await mkdir(session_dir);
  return { root, execution_dir, session_dir };
}

function threadFor({ execution_dir, session_dir, session_file = null, model, thread_id = randomUUID(), session_id = randomUUID() }) {
  return {
    schema_version: 1,
    thread_id,
    session_id,
    workspace_id: randomUUID(),
    title: "fixture thread",
    target: { kind: "workspace" },
    execution_dir,
    session_dir,
    session_file,
    history_only: false,
    queue: [],
    queue_paused: false,
    accepted_message_ids: [],
    handoffs: [],
    attention: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...(model === undefined ? {} : { model }),
  };
}

function makeHarness({ env = {}, clock } = {}) {
  const calls = [];
  const children = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = spawn(process.execPath, [FIXTURE, ...args], { ...options, env: { ...process.env, ...env } });
    children.push(child);
    return child;
  };
  return { calls, children, spawnImpl, env, clock };
}

// Minimal ChildProcess-like double for the injected spawn boundary, used only
// to exercise stdin callback errors and held/backpressured writes
// deterministically against real temp roots.
function makeFakeChildProcess({ thread, failAt = 0, holdAfter = 0 }) {
  const child = new EventEmitter();
  const sessionFile = join(thread.session_dir, `2024-01-01T00-00-00-000Z_${thread.session_id}.jsonl`);
  child.pid = 987654;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  const received = [];
  const held = [];
  let writes = 0;
  let exited = false;
  const emitExit = (code, signal) => {
    if (exited) return;
    exited = true;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  const respond = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "get_state") {
      child.stdout.write(
        `${JSON.stringify({ id: message.id, type: "response", command: "get_state", success: true, data: { sessionId: thread.session_id, sessionFile, isStreaming: false, isCompacting: false, pendingMessageCount: 0 } })}\n`,
      );
    } else if (message.type === "get_commands") {
      child.stdout.write(
        `${JSON.stringify({ id: message.id, type: "response", command: "get_commands", success: true, data: { commands: [] } })}\n`,
      );
    }
  };
  child.stdin.write = (chunk, callback) => {
    writes += 1;
    const line = chunk.toString();
    received.push(line);
    if (failAt > 0 && writes >= failAt) {
      if (typeof callback === "function") queueMicrotask(() => callback(new Error("injected stdin write failure")));
      return false;
    }
    if (holdAfter > 0 && writes > holdAfter) {
      if (typeof callback === "function") held.push(callback);
      return false;
    }
    if (typeof callback === "function") queueMicrotask(() => callback());
    respond(line);
    return true;
  };
  child.stdin.on("finish", () => emitExit(0, null));
  child.kill = (signal) => {
    emitExit(null, signal ?? "SIGTERM");
    return true;
  };
  child.releaseHeld = () => {
    for (const callback of held.splice(0)) callback();
  };
  child.received = received;
  return child;
}

function collectEvents(adapter) {
  const seen = [];
  adapter.events.on("event", (envelope) => seen.push(envelope));
  return seen;
}

async function waitForEvent(seen, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = seen.find(predicate);
    if (found) return found;
    await sleep(5);
  }
  throw new Error("expected event was not observed");
}

function waitForChildExit(child, timeoutMs = 6000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("fixture child did not exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(2);
  }
  throw new Error("condition was not met before the deadline");
}

async function withEnv(overrides, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function writeSession(file, { id, cwd, version = 3 }) {
  await writeFile(
    file,
    `${JSON.stringify({ type: "session", version, id, timestamp: new Date().toISOString(), cwd })}\n`,
  );
}

async function closeQuietly(adapter) {
  try {
    await adapter?.close();
  } catch {
    // shutdown diagnostics are asserted by their own tests
  }
}

test("new session uses --session-id with the exact fixed argv and cwd", async () => {
  const roots = await makeRoots();
  const harness = makeHarness();
  const thread = threadFor(roots);
  let adapter;
  try {
    adapter = await createPiRpc({ thread, spawn: harness.spawnImpl });
    assert.equal(harness.calls.length, 1);
    const call = harness.calls[0];
    assert.equal(call.command, "pi");
    assert.deepEqual(call.args, [
      "--mode",
      "rpc",
      "--session-dir",
      roots.session_dir,
      "--name",
      `discussion:${thread.thread_id}`,
      "--tools",
      "read,grep,find,ls",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-approve",
      "--session-id",
      thread.session_id,
    ]);
    assert.equal(call.options.cwd, roots.execution_dir);
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(adapter.identity.thread_id, thread.thread_id);
    assert.equal(adapter.identity.session_id, thread.session_id);
    assert.equal(adapter.identity.mode, "new");
    assert.equal(adapter.identity.pid, harness.children[0].pid);
    const state = await adapter.request({ type: "get_state" });
    assert.equal(state.success, true);
    assert.equal(state.data.sessionId, thread.session_id);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("validated provider, model and thinking append to the fixed argv", async () => {
  const roots = await makeRoots();
  const harness = makeHarness();
  const thread = threadFor({ ...roots, model: { provider: "anthropic", model: "claude-x", thinking: "high" } });
  let adapter;
  try {
    adapter = await createPiRpc({ thread, spawn: harness.spawnImpl });
    assert.deepEqual(harness.calls[0].args.slice(-6), ["--provider", "anthropic", "--model", "claude-x", "--thinking", "high"]);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("resume uses --session and retains the imported session id", async () => {
  const roots = await makeRoots();
  const importedId = randomUUID();
  const file = join(roots.session_dir, "imported.jsonl");
  await writeSession(file, { id: importedId, cwd: roots.execution_dir });
  const thread = threadFor({ ...roots, session_id: importedId, session_file: file });
  const harness = makeHarness();
  let adapter;
  try {
    adapter = await createPiRpc({ thread, spawn: harness.spawnImpl });
    assert.deepEqual(harness.calls[0].args.slice(-2), ["--session", file]);
    assert.ok(!harness.calls[0].args.includes("--session-id"));
    assert.equal(adapter.identity.session_id, importedId);
    assert.equal(adapter.identity.mode, "resume");
    assert.equal(adapter.identity.session_file, file);
    const state = await adapter.request({ type: "get_state" });
    assert.equal(state.data.sessionId, importedId);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("structural and model validation refuse before spawning", async () => {
  const roots = await makeRoots();
  const base = threadFor(roots);
  const never = () => {
    throw new Error("spawn must not run for a refused thread");
  };
  try {
    await assert.rejects(createPiRpc({ thread: { ...base, thread_id: "not-a-uuid" }, spawn: never }), {
      code: "invalid-thread",
    });
    for (const model of [
      { provider: "p", model: "-m" },
      { provider: "p\n", model: "m" },
      { provider: "", model: "m" },
      { provider: "p", model: "m", thinking: "turbo" },
    ]) {
      await assert.rejects(createPiRpc({ thread: { ...base, model }, spawn: never }), {
        code: "invalid-thread",
      });
    }
  } finally {
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("resume refuses missing, mismatched, escaped and unreadable session files", async () => {
  const roots = await makeRoots();
  const base = threadFor(roots);
  const never = () => {
    throw new Error("spawn must not run for a refused session file");
  };
  try {
    await assert.rejects(
      createPiRpc({ thread: { ...base, session_file: join(roots.session_dir, "missing.jsonl") }, spawn: never }),
      { code: "session-mismatch" },
    );

    const wrongId = join(roots.session_dir, "wrong-id.jsonl");
    await writeSession(wrongId, { id: randomUUID(), cwd: roots.execution_dir });
    await assert.rejects(createPiRpc({ thread: { ...base, session_file: wrongId }, spawn: never }), {
      code: "session-mismatch",
    });

    const wrongCwd = join(roots.session_dir, "wrong-cwd.jsonl");
    await writeSession(wrongCwd, { id: base.session_id, cwd: roots.root });
    await assert.rejects(createPiRpc({ thread: { ...base, session_file: wrongCwd }, spawn: never }), {
      code: "session-mismatch",
    });

    const outside = join(roots.root, "outside.jsonl");
    await writeSession(outside, { id: base.session_id, cwd: roots.execution_dir });
    const link = join(roots.session_dir, "link.jsonl");
    await symlink(outside, link);
    await assert.rejects(createPiRpc({ thread: { ...base, session_file: link }, spawn: never }), {
      code: "session-mismatch",
    });

    const unreadable = join(roots.session_dir, "unreadable.jsonl");
    await writeSession(unreadable, { id: base.session_id, cwd: roots.execution_dir });
    await chmod(unreadable, 0o000);
    try {
      if (process.getuid && process.getuid() !== 0) {
        await assert.rejects(createPiRpc({ thread: { ...base, session_file: unreadable }, spawn: never }), {
          code: "session-mismatch",
        });
      }
    } finally {
      await chmod(unreadable, 0o600);
    }
  } finally {
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("post-spawn get_state mismatch closes only the owned child", async () => {
  const roots = await makeRoots();
  const harness = makeHarness({ env: { FAKE_PI_STATE_ID: randomUUID() } });
  try {
    await assert.rejects(createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl }), {
      code: "session-mismatch",
    });
    assert.equal(harness.children.length, 1);
    await waitForChildExit(harness.children[0]);
    assert.notEqual(harness.children[0].exitCode, null);
  } finally {
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("startup refuses non-empty get_commands under the fixed argv", async () => {
  const roots = await makeRoots();
  const harness = makeHarness({ env: { FAKE_PI_COMMANDS: JSON.stringify([{ name: "ext:cmd" }]) } });
  try {
    await assert.rejects(createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl }), {
      code: "policy-refusal",
    });
    await waitForChildExit(harness.children[0]);
  } finally {
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("startup get_state is bounded at 10s by the injected clock", async () => {
  const roots = await makeRoots();
  const clock = manualClock();
  const harness = makeHarness({ env: { FAKE_PI_GET_STATE_HANG: "1" }, clock });
  try {
    const creating = createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl, clock });
    await waitFor(() => clock.pending > 0);
    clock.fire(10_000);
    await assert.rejects(creating, { code: "request-timeout", phase: "startup", uncertain: true });
    await waitForChildExit(harness.children[0]);
  } finally {
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("read tools pass but unexpected tool names are refused without settling the child", async () => {
  const rootsRead = await makeRoots();
  const harnessRead = makeHarness({ env: { FAKE_PI_TOOL_ON: "prompt", FAKE_PI_TOOL_NAME: "read" } });
  let adapterRead;
  try {
    adapterRead = await createPiRpc({ thread: threadFor(rootsRead), spawn: harnessRead.spawnImpl });
    const seen = collectEvents(adapterRead);
    const response = await adapterRead.request({ type: "prompt", message: "hello" });
    assert.equal(response.success, true);
    assert.equal(response.data.disposition, "started");
    assert.ok(!seen.some((envelope) => envelope.event?.type === "policy_refusal"));
  } finally {
    await closeQuietly(adapterRead);
    await rm(rootsRead.root, { recursive: true, force: true });
  }

  const rootsBash = await makeRoots();
  const harnessBash = makeHarness({
    env: {
      FAKE_PI_TOOL_ON: "prompt",
      FAKE_PI_TOOL_NAME: "bash",
      FAKE_PI_COMMAND_LOG: join(rootsBash.root, "commands.log"),
    },
  });
  let adapterBash;
  try {
    adapterBash = await createPiRpc({ thread: threadFor(rootsBash), spawn: harnessBash.spawnImpl });
    const seen = collectEvents(adapterBash);
    await assert.rejects(adapterBash.request({ type: "prompt", message: "hello" }), { code: "policy-refusal" });
    const refusal = await waitForEvent(seen, (envelope) => envelope.event?.type === "policy_refusal");
    assert.equal(refusal.event.kind, "tool");
    assert.equal(refusal.event.toolName, "bash");
    await assert.rejects(adapterBash.request({ type: "prompt", message: "again" }), { code: "policy-refusal" });
    const state = await adapterBash.request({ type: "get_state" });
    assert.equal(state.success, true);
    const log = await readFile(join(rootsBash.root, "commands.log"), "utf8");
    assert.equal(log.split("\n").filter((line) => line.includes('"prompt"')).length, 1);
  } finally {
    await closeQuietly(adapterBash);
    await rm(rootsBash.root, { recursive: true, force: true });
  }
});

test("extension UI is cancelled with the matching response before refusal", async () => {
  const roots = await makeRoots();
  const harness = makeHarness({ env: { FAKE_PI_EXTENSION_UI_ON: "prompt" } });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    const seen = collectEvents(adapter);
    await assert.rejects(adapter.request({ type: "prompt", message: "hello" }), { code: "policy-refusal" });
    const cancelled = await waitForEvent(seen, (envelope) => envelope.event?.type === "fake_extension_ui_response");
    assert.equal(cancelled.event.cancelled, true);
    const refusal = await waitForEvent(seen, (envelope) => envelope.event?.type === "policy_refusal");
    assert.equal(refusal.event.kind, "extension-ui");
    await assert.rejects(adapter.request({ type: "prompt", message: "again" }), { code: "policy-refusal" });
    const state = await adapter.request({ type: "get_state" });
    assert.equal(state.success, true);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("concurrent requests correlate by id across reordered responses", async () => {
  const roots = await makeRoots();
  const harness = makeHarness({ env: { FAKE_PI_DELAYS: JSON.stringify({ get_entries: 120 }) } });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    const order = [];
    const messages = adapter.request({ type: "get_messages", id: "req-messages" }).then((result) => {
      order.push("messages");
      return result;
    });
    const entries = adapter.request({ type: "get_entries", id: "req-entries" }).then((result) => {
      order.push("entries");
      return result;
    });
    const [messagesResult, entriesResult] = await Promise.all([messages, entries]);
    assert.deepEqual(order, ["messages", "entries"]);
    assert.equal(entriesResult.id, "req-entries");
    assert.equal(entriesResult.command, "get_entries");
    assert.equal(messagesResult.id, "req-messages");
    assert.equal(messagesResult.command, "get_messages");

    const held = adapter.request({ type: "get_entries", id: "dup-id" });
    await assert.rejects(adapter.request({ type: "get_messages", id: "dup-id" }), { code: "duplicate-request-id" });
    await held;

    const first = await adapter.request({ type: "get_messages" });
    const second = await adapter.request({ type: "get_messages" });
    assert.notEqual(first.id, second.id);
    assert.equal(first.command, "get_messages");
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("split writes preserve U+2028, U+2029 and emoji inside a frame", async () => {
  const roots = await makeRoots();
  const text = "before\u2028middle\u2029after \u{1F680} done";
  const harness = makeHarness({
    env: { FAKE_PI_SPLIT_WRITES: "1", FAKE_PI_MESSAGE_TEXT: text },
  });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    const response = await adapter.request({ type: "get_messages" });
    assert.equal(response.data.messages[0].content[0].text, text);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("agent_settled before the prompt ack keeps event-before-ack ordering", async () => {
  const roots = await makeRoots();
  const harness = makeHarness({
    env: { FAKE_PI_PROMPT_EVENTS: JSON.stringify([{ type: "agent_settled", aborted: false }]) },
  });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    const order = [];
    adapter.events.on("event", (envelope) => {
      if (envelope.event?.type === "agent_settled") order.push("event");
    });
    const response = await adapter.request({ type: "prompt", message: "hello" }).then((result) => {
      order.push("ack");
      return result;
    });
    assert.deepEqual(order, ["event", "ack"]);
    assert.equal(response.success, true);
    assert.equal(response.data.disposition, "started");
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("an abort timeout reports uncertainty while the child stays live", async () => {
  const roots = await makeRoots();
  const clock = manualClock();
  const harness = makeHarness({ env: { FAKE_PI_ABORT_HANG: "1" }, clock });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl, clock });
    const abort = adapter.request({ type: "abort" });
    clock.fire(30_000);
    await assert.rejects(abort, { code: "request-timeout", uncertain: true, command: "abort" });
    const state = await adapter.request({ type: "get_state" });
    assert.equal(state.success, true);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("separate adapters attribute events to their own generation", async () => {
  const rootsA = await makeRoots("pi-rpc-a-");
  const rootsB = await makeRoots("pi-rpc-b-");
  const env = { FAKE_PI_PROMPT_EVENTS: JSON.stringify([{ type: "custom_ping" }]) };
  const harnessA = makeHarness({ env });
  const harnessB = makeHarness({ env });
  let adapterA;
  let adapterB;
  try {
    adapterA = await createPiRpc({ thread: threadFor(rootsA), spawn: harnessA.spawnImpl });
    adapterB = await createPiRpc({ thread: threadFor(rootsB), spawn: harnessB.spawnImpl });
    const seenA = collectEvents(adapterA);
    const seenB = collectEvents(adapterB);
    await adapterA.request({ type: "prompt", message: "a" });
    await adapterB.request({ type: "prompt", message: "b" });
    const pingA = await waitForEvent(seenA, (envelope) => envelope.event?.type === "custom_ping");
    const pingB = await waitForEvent(seenB, (envelope) => envelope.event?.type === "custom_ping");
    assert.equal(pingA.thread_id, adapterA.identity.thread_id);
    assert.equal(pingA.generation, adapterA.identity.generation);
    assert.equal(pingB.thread_id, adapterB.identity.thread_id);
    assert.equal(pingB.generation, adapterB.identity.generation);
    assert.notEqual(pingA.generation, pingB.generation);
  } finally {
    await closeQuietly(adapterA);
    await closeQuietly(adapterB);
    await rm(rootsA.root, { recursive: true, force: true });
    await rm(rootsB.root, { recursive: true, force: true });
  }
});

test("a malformed frame surfaces transport-error without killing the child", async () => {
  const roots = await makeRoots();
  const harness = makeHarness({ env: { FAKE_PI_MALFORMED_ON: "get_entries" } });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    const seen = collectEvents(adapter);
    await assert.rejects(adapter.request({ type: "get_entries" }), { code: "transport-error", uncertain: true });
    await assert.rejects(adapter.request({ type: "get_state" }), { code: "transport-error" });
    const fault = await waitForEvent(seen, (envelope) => envelope.event?.type === "transport_error");
    assert.equal(fault.event.reason, "malformed-frame");
    assert.ok(!seen.some((envelope) => envelope.event?.type === "exit"));
    assert.equal(harness.children[0].exitCode, null);
    const closed = await adapter.close();
    assert.equal(closed.confirmed_death, true);
  } finally {
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("fresh get_state identity mismatch before prompt keeps the prompt off the wire", async () => {
  const roots = await makeRoots();
  const logPath = join(roots.root, "commands.log");
  const harness = makeHarness({
    env: { FAKE_PI_COMMAND_LOG: logPath, FAKE_PI_GET_STATE_LATER: JSON.stringify({ sessionId: randomUUID() }) },
  });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    await assert.rejects(adapter.request({ type: "prompt", message: "hello" }), { code: "session-mismatch" });
    await waitForChildExit(harness.children[0]);
    const log = await readFile(logPath, "utf8");
    assert.equal(log.split("\n").filter((line) => line.includes('"prompt"')).length, 0);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("new-session symlink replacement rejects before prompt", async () => {
  const roots = await makeRoots();
  const logPath = join(roots.root, "commands.log");
  const harness = makeHarness({ env: { FAKE_PI_COMMAND_LOG: logPath } });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    const outside = join(roots.root, "outside.jsonl");
    await writeSession(outside, { id: adapter.identity.session_id, cwd: roots.execution_dir });
    await symlink(outside, adapter.identity.session_file);
    await assert.rejects(adapter.request({ type: "prompt", message: "hello" }), { code: "session-mismatch" });
    await waitForChildExit(harness.children[0]);
    const log = await readFile(logPath, "utf8");
    assert.equal(log.split("\n").filter((line) => line.includes('"prompt"')).length, 0);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("explicit request ids stay unique for the adapter lifetime", async () => {
  const roots = await makeRoots();
  const clock = manualClock();
  const harness = makeHarness({ env: { FAKE_PI_DELAYS: JSON.stringify({ get_entries: 80 }) }, clock });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl, clock });
    const first = await adapter.request({ type: "get_messages", id: "reused-id" });
    assert.equal(first.id, "reused-id");
    await assert.rejects(adapter.request({ type: "get_messages", id: "reused-id" }), { code: "duplicate-request-id" });

    const timedOut = adapter.request({ type: "get_entries", id: "timeout-id" });
    clock.fire(30_000);
    await assert.rejects(timedOut, { code: "request-timeout", uncertain: true });
    await assert.rejects(adapter.request({ type: "get_entries", id: "timeout-id" }), { code: "duplicate-request-id" });
    await sleep(120);
    const state = await adapter.request({ type: "get_state" });
    assert.equal(state.command, "get_state");
    assert.equal(state.data.sessionId, adapter.identity.session_id);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("mismatched correlation and failed acks are typed errors", async () => {
  const roots = await makeRoots();
  const harness = makeHarness({
    env: { FAKE_PI_WRONG_COMMAND_ON: "get_entries", FAKE_PI_FAIL_ON: "get_messages", FAKE_PI_FAIL_MESSAGE: "nope" },
  });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    await assert.rejects(adapter.request({ type: "get_entries" }), { code: "protocol-error" });
    const failed = await adapter.request({ type: "get_messages" }).then(
      () => assert.fail("failed ack must reject"),
      (error) => error,
    );
    assert.equal(failed.code, "command-failed");
    assert.equal(failed.message, "nope");
    assert.equal(failed.response.success, false);
    const state = await adapter.request({ type: "get_state" });
    assert.equal(state.success, true);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("a child exit rejects pending work and refuses later sends", async () => {
  const roots = await makeRoots();
  const harness = makeHarness({ env: { FAKE_PI_EXIT_ON: "get_entries", FAKE_PI_EXIT_CODE: "3" } });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    const seen = collectEvents(adapter);
    await assert.rejects(adapter.request({ type: "get_entries" }), { code: "transport-error", uncertain: true });
    const exit = await waitForEvent(seen, (envelope) => envelope.event?.type === "exit");
    assert.equal(exit.event.code, 3);
    await assert.rejects(adapter.request({ type: "get_state" }), { code: "transport-error" });
    const closed = await adapter.close();
    assert.equal(closed.confirmed_death, true);
    assert.equal(closed.exit_code, 3);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("serialized writes deliver a burst of commands in order", async () => {
  const roots = await makeRoots();
  const logPath = join(roots.root, "commands.log");
  const harness = makeHarness({ env: { FAKE_PI_COMMAND_LOG: logPath } });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    const ids = Array.from({ length: 25 }, (_, index) => `burst-${String(index).padStart(2, "0")}`);
    const responses = await Promise.all(ids.map((id) => adapter.request({ type: "get_state", id })));
    assert.ok(responses.every((response) => response.success === true && response.command === "get_state"));
    const log = await readFile(logPath, "utf8");
    const logged = log
      .split("\n")
      .filter((line) => line.includes('"burst-'))
      .map((line) => JSON.parse(line).id);
    assert.deepEqual(logged, ids);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("an oversize frame rejects pending work and stops reading the transport", async () => {
  const roots = await makeRoots();
  const harness = makeHarness({ env: { FAKE_PI_OVERSIZE_ON: "get_entries" } });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    const seen = collectEvents(adapter);
    await assert.rejects(adapter.request({ type: "get_entries" }), { code: "transport-error", uncertain: true });
    const fault = await waitForEvent(seen, (envelope) => envelope.event?.type === "transport_error");
    assert.equal(fault.event.reason, "oversize-frame");
    await assert.rejects(adapter.request({ type: "get_state" }), { code: "transport-error" });
    const closed = await adapter.close();
    assert.equal(closed.confirmed_death, true);
  } finally {
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("stdout EOF rejects pending work and is reported as transport error, not death", async () => {
  const roots = await makeRoots();
  const harness = makeHarness({ env: { FAKE_PI_EOF_ON: "prompt" } });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    const seen = collectEvents(adapter);
    await assert.rejects(adapter.request({ type: "prompt", message: "hello" }), {
      code: "transport-error",
      uncertain: true,
    });
    const fault = await waitForEvent(seen, (envelope) => envelope.event?.type === "transport_error");
    assert.equal(fault.event.reason, "stdout-eof");
    assert.equal(fault.event.torn, true);
    assert.ok(!seen.some((envelope) => envelope.event?.type === "exit"));
    const closed = await adapter.close();
    assert.equal(closed.confirmed_death, true);
    assert.equal(closed.exit_code, 0);
  } finally {
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("close is idempotent, refuses new work and confirms cooperative death", async () => {
  const roots = await makeRoots();
  const harness = makeHarness();
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    const first = adapter.close();
    const second = adapter.close();
    const result = await first;
    assert.equal(await second, result);
    assert.equal(result.confirmed_death, true);
    assert.equal(result.exit_code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.pid, harness.children[0].pid);
    await assert.rejects(adapter.request({ type: "get_state" }), { code: "service-closed" });
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("an unresponsive child is SIGKILLed through the owned handle", async () => {
  const roots = await makeRoots();
  const clock = manualClock();
  const harness = makeHarness({ env: { FAKE_PI_HANG: "1" }, clock });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl, clock });
    const closing = adapter.close();
    await waitFor(() => clock.pending > 0);
    clock.fire(4_000);
    await waitForChildExit(harness.children[0]);
    clock.fire(1_000);
    const result = await closing;
    assert.equal(result.confirmed_death, true);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.pid, harness.children[0].pid);
  } finally {
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("stdin write callback errors reject the originating request promptly", async () => {
  const roots = await makeRoots();
  const thread = threadFor(roots);
  const child = makeFakeChildProcess({ thread, failAt: 3 });
  let adapter;
  try {
    adapter = await createPiRpc({ thread, spawn: () => child });
    const outcome = await Promise.race([
      adapter.request({ type: "get_messages" }).then(
        () => "resolved",
        (error) => error,
      ),
      sleep(2000).then(() => "timeout"),
    ]);
    assert.notEqual(outcome, "timeout", "a write failure must settle the pending request without the 30s timer");
    assert.equal(outcome.code, "transport-error");
    assert.equal(outcome.uncertain, true);
    assert.equal(outcome.reason, "stdin-error");
    await assert.rejects(adapter.request({ type: "get_state" }), { code: "transport-error", reason: "stdin-error" });
    const closed = await adapter.close();
    assert.equal(closed.confirmed_death, true);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("a timed-out queued command is never written when a held write resumes", async () => {
  const roots = await makeRoots();
  const clock = manualClock();
  const thread = threadFor(roots);
  const child = makeFakeChildProcess({ thread, holdAfter: 2 });
  let adapter;
  try {
    adapter = await createPiRpc({ thread, spawn: () => child, clock });
    const held = adapter.request({ type: "get_entries", id: "held-request" }).then(
      () => "resolved",
      (error) => error,
    );
    const queued = adapter.request({ type: "get_messages", id: "queued-request" }).then(
      () => "resolved",
      (error) => error,
    );
    await waitFor(() => child.received.length >= 3);
    clock.fire(30_000);
    assert.equal((await held).code, "request-timeout");
    assert.equal((await queued).code, "request-timeout");
    child.releaseHeld();
    await sleep(20);
    assert.ok(child.received.some((line) => line.includes("held-request")));
    assert.ok(!child.received.some((line) => line.includes("queued-request")), "a timed-out queued command must not be written");
    const closed = await adapter.close();
    assert.equal(closed.confirmed_death, true);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("a different contained session file before prompt is refused", async () => {
  const roots = await makeRoots();
  const logPath = join(roots.root, "commands.log");
  const alternate = join(roots.session_dir, "alternate.jsonl");
  const harness = makeHarness({
    env: { FAKE_PI_COMMAND_LOG: logPath, FAKE_PI_GET_STATE_LATER: JSON.stringify({ sessionFile: alternate }) },
  });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    await assert.rejects(adapter.request({ type: "prompt", message: "hello" }), { code: "session-mismatch" });
    await waitForChildExit(harness.children[0]);
    const log = await readFile(logPath, "utf8");
    assert.equal(log.split("\n").filter((line) => line.includes('"prompt"')).length, 0);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("a policy refusal during the pre-prompt probe blocks the prompt", async () => {
  const roots = await makeRoots();
  const logPath = join(roots.root, "commands.log");
  const harness = makeHarness({
    env: { FAKE_PI_COMMAND_LOG: logPath, FAKE_PI_TOOL_LATER: "get_state", FAKE_PI_TOOL_NAME: "bash" },
  });
  let adapter;
  try {
    adapter = await createPiRpc({ thread: threadFor(roots), spawn: harness.spawnImpl });
    await assert.rejects(adapter.request({ type: "prompt", message: "hello" }), { code: "policy-refusal" });
    await waitForChildExit(harness.children[0]);
    const log = await readFile(logPath, "utf8");
    assert.equal(log.split("\n").filter((line) => line.includes('"prompt"')).length, 0);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("installed Pi 1.1.0 starts a new no-provider session and reports empty commands", { timeout: 60000 }, async (t) => {
  const probe = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5000 });
  if (probe.status !== 0) {
    t.skip("installed pi is not available on PATH");
    return;
  }
  const roots = await makeRoots("pi-real-new-");
  const agentDir = join(roots.root, "agent");
  await mkdir(agentDir);
  let adapter;
  try {
    await withEnv({ PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, async () => {
      adapter = await createPiRpc({ thread: threadFor(roots) });
      assert.equal(adapter.identity.mode, "new");
      const state = await adapter.request({ type: "get_state" });
      assert.equal(state.success, true);
      assert.equal(state.data.sessionId, adapter.identity.session_id);
      assert.equal(join(state.data.sessionFile, ".."), roots.session_dir);
      const commands = await adapter.request({ type: "get_commands" });
      assert.deepEqual(commands.data.commands, []);
      const closed = await adapter.close();
      assert.equal(closed.confirmed_death, true);
    });
    const files = await readdir(roots.session_dir);
    assert.deepEqual(files.filter((file) => file.endsWith(".jsonl")), []);
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("installed Pi 1.1.0 resumes a pre-created valid v3 header with its own session id", { timeout: 60000 }, async (t) => {
  const probe = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5000 });
  if (probe.status !== 0) {
    t.skip("installed pi is not available on PATH");
    return;
  }
  const roots = await makeRoots("pi-real-resume-");
  const agentDir = join(roots.root, "agent");
  await mkdir(agentDir);
  const importedId = randomUUID();
  const file = join(roots.session_dir, "pre-created.jsonl");
  await writeSession(file, { id: importedId, cwd: roots.execution_dir });
  let adapter;
  try {
    await withEnv({ PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, async () => {
      adapter = await createPiRpc({ thread: threadFor({ ...roots, session_id: importedId, session_file: file }) });
      assert.equal(adapter.identity.mode, "resume");
      assert.equal(adapter.identity.session_id, importedId);
      const state = await adapter.request({ type: "get_state" });
      assert.equal(state.data.sessionId, importedId);
      const commands = await adapter.request({ type: "get_commands" });
      assert.deepEqual(commands.data.commands, []);
      const closed = await adapter.close();
      assert.equal(closed.confirmed_death, true);
    });
  } finally {
    await closeQuietly(adapter);
    await rm(roots.root, { recursive: true, force: true });
  }
});

test("installed 1.1.0 source keeps MCP filtering, no-extension flags and no get_active_tools RPC", async (t) => {
  try {
    await stat(join(INSTALLED_PI, "dist/core/agent-session.js"));
  } catch {
    t.skip("installed pi is not available at the fixed verifier path");
    return;
  }
  const installedPackage = JSON.parse(await readFile(join(INSTALLED_PI, "package.json"), "utf8"));
  assert.equal(installedPackage.version, "1.1.0", "the fixed argv is verified against installed pi 1.1.0");
  const agentSource = await readFile(join(INSTALLED_PI, "dist/core/agent-session.js"), "utf8");
  assert.match(agentSource, /_allowlistFiltersMcp/);
  assert.match(agentSource, /entry\.startsWith\("mcp__"\)/);
  assert.match(agentSource, /return !this\._allowlistFiltersMcp && isMcpToolName\(name\)/);

  const rpcSource = await readFile(join(INSTALLED_PI, "dist/modes/rpc/rpc-mode.js"), "utf8");
  assert.ok(!rpcSource.includes("get_active_tools"), "no get_active_tools RPC may be assumed");

  const chunksDir = join(INSTALLED_PI, "dist/bundle/chunks");
  const chunks = await readdir(chunksDir);
  const preferred = chunks.find((file) => file.includes("OIM2DMFI"));
  const ordered = preferred ? [preferred, ...chunks.filter((file) => file !== preferred)] : chunks;
  let help = null;
  for (const file of ordered) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(join(chunksDir, file), "utf8");
    if (source.includes("--no-mcp")) {
      help = source;
      break;
    }
  }
  assert.ok(help, "installed CLI help text was found");
  assert.match(help, /--no-extensions/);
  assert.match(help, /Disable built-in MCP support/);
  assert.match(help, /Keeps MCP tools unless an entry starts with mcp__/);
  assert.match(help, /--no-approve/);
  assert.match(help, /arg==="--no-mcp"\)result\.noMcp=!0/);
  assert.match(help, /arg==="--no-extensions"\|\|arg==="-ne"\)result\.noExtensions=!0/);
  assert.match(help, /arg==="--tools"\|\|arg==="-t"\)/);
  assert.match(help, /disabledBuiltinExtensions:parsed\.noMcp\?\["mcp"\]:void 0/);

  const resourceLoader = await readFile(join(INSTALLED_PI, "dist/core/resource-loader.js"), "utf8");
  assert.match(resourceLoader, /this\.noExtensions = options\.noExtensions \?\? false/);
  assert.match(resourceLoader, /this\.noExtensions \? cliEnabledExtensions/);
});
