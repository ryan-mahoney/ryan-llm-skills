// Step 3 focused tests: ThreadV1 validation, owned thread persistence and the
// read-only create/list/history/subscribe/close service slice.
//
// Every fixture root is realpath(mkdtemp(tmpdir())) with the real canonical
// setupStorage/createWorkspace owners and real Git repositories; no provider,
// storage database or tmux is touched. Records are written with the same
// JSON-per-line shape the service publishes so refusal cases keep their exact
// bytes.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { processIdentity } from "../spec-observe/process-identity.mjs";
import { createDiscussionService, readThread, validateThread } from "./discussion.mjs";
import { createWorkspace, setupStorage, addMaterial } from "./store.mjs";
import { findAssignment, resolveAssignment } from "./assignments.mjs";

const PI_FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function tempRoot(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "adj5-discussion-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function makeRepo(directory) {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "--quiet"]);
  await git(directory, ["commit", "--allow-empty", "-m", "init"]);
  return realpath(directory);
}

function kitYaml({ id, name, repositories = [], context = [] }) {
  const lines = ["version: 1", `id: ${JSON.stringify(id)}`, `name: ${JSON.stringify(name)}`];
  if (repositories.length === 0) {
    lines.push("repositories: []");
  } else {
    lines.push("repositories:");
    for (const repository of repositories) {
      lines.push(`  - id: ${JSON.stringify(repository.id)}`);
      lines.push(`    path: ${JSON.stringify(repository.path)}`);
    }
  }
  if (context.length === 0) {
    lines.push("context: []");
  } else {
    lines.push("context:");
    for (const entry of context) lines.push(`  - ${JSON.stringify(entry)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function setupWorkspace(storageRoot, id, repositories = [], context = []) {
  await createWorkspace(storageRoot, { id, name: id });
  const directory = join(storageRoot, "projects", id);
  if (repositories.length > 0 || context.length > 0) {
    await writeFile(join(directory, "kit.yaml"), kitYaml({ id, name: id, repositories, context }));
  }
  return directory;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("condition was not met before the deadline");
}

function psChild(output, { code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.stdout.once("end", () => {
    child.emit("exit", code);
    child.emit("close", code);
  });
  setImmediate(() => {
    if (output) child.stdout.write(output);
    child.stdout.end();
  });
  return child;
}

function piHarness({ psOutput = "  1 launchd\n", psCode = 0, env = {} } = {}) {
  const calls = [];
  const children = [];
  const spawnImpl = (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === "ps") return psChild(psOutput, { code: psCode });
    const child = spawn(process.execPath, [PI_FIXTURE, ...args], { ...options, env: { ...process.env, ...env } });
    children.push(child);
    return child;
  };
  return { calls, children, spawnImpl };
}

function manualClock() {
  let next = 1;
  let now = 0;
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
    has(ms) {
      for (const timer of timers.values()) {
        if (timer.ms === ms) return true;
      }
      return false;
    },
    now() {
      return now;
    },
    setNow(value) {
      now = value;
    },
    advance(ms) {
      now += ms;
    },
    get pending() {
      return [...timers.values()].map((timer) => timer.ms);
    },
    get size() {
      return timers.size;
    },
  };
}

// Final ChildProcess-like boundary for the unconfirmed-shutdown cases: the
// handle never emits exit on stdin end or kill, and kill only records the
// attempted signal. pid belongs to an owned live dummy process so canonical
// processIdentity runs a real OS probe.
function fakePiChildFor({ pid, record, ready }) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal ?? null);
    return true;
  };
  const sessionFile = join(record.session_dir, `2024-01-01T00-00-00-000Z_${record.session_id}.jsonl`);
  let buffered = "";
  const respond = (message) => {
    if (message.type === "get_state") {
      child.stdout.write(
        `${JSON.stringify({ id: message.id, type: "response", command: "get_state", success: true, data: { sessionId: record.session_id, sessionFile, isStreaming: false, isCompacting: false, pendingMessageCount: 0 } })}\n`,
      );
    } else if (message.type === "get_commands") {
      child.stdout.write(
        `${JSON.stringify({ id: message.id, type: "response", command: "get_commands", success: true, data: { commands: [] } })}\n`,
      );
    }
  };
  child.stdin.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let index;
    while ((index = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line.trim() === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (ready) respond(message);
    }
  });
  return child;
}

function shutdownHarness({ record, pid, ready }) {
  const calls = [];
  const child = fakePiChildFor({ pid, record, ready });
  const spawnImpl = (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === "ps") return psChild("  1 launchd\n");
    return child;
  };
  return { calls, child, spawnImpl };
}

// Owned inert process used as the real pane PID for the tmux transport
// fixture: the canonical processIdentity inspector observes it through a real
// OS probe, and cleanup kills exactly this child.
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

// Final tmux transport boundary for thread handoff launches: every command
// queue is recorded, no real session is created, has-session reports absence
// until the fixture has captured an assignment, unexpected commands refuse,
// and read-only probes for the recorded assignment answer with the owned dummy
// pane PID. `dummyPid` is supplied only by tests that expect a session.
function tmuxHarness({ dummyPid = null } = {}) {
  const calls = [];
  let assignmentId = null;
  const run = (socketPath, args) => {
    calls.push({ socketPath, args: [...args] });
    if (args.includes("new-session")) {
      const marker = args.find((arg) => typeof arg === "string" && arg.startsWith("ADJACENT_ASSIGNMENT_ID="));
      if (marker) assignmentId = marker.slice("ADJACENT_ASSIGNMENT_ID=".length);
      return Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" });
    }
    if (args.includes("has-session")) {
      return Promise.resolve(
        assignmentId === null
          ? { ok: false, code: 1, stdout: "", stderr: "can't find session" }
          : { ok: true, code: 0, stdout: "", stderr: "" },
      );
    }
    if (args.includes("list-clients")) {
      return Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" });
    }
    if (args.includes("display-message")) {
      return Promise.resolve({ ok: true, code: 0, stdout: `%1 ${dummyPid}\n`, stderr: "" });
    }
    if (args.includes("show-options")) {
      return Promise.resolve({ ok: true, code: 0, stdout: `${assignmentId}\n`, stderr: "" });
    }
    return Promise.reject(new Error(`unexpected tmux command: ${args.join(" ")}`));
  };
  return {
    calls,
    run,
    newSessionCount: () => calls.filter((call) => call.args.includes("new-session")).length,
    destructiveCount: () =>
      calls.filter((call) =>
        call.args.some((arg) =>
          ["kill-session", "kill-server", "kill-pane", "kill-window"].includes(arg),
        ),
      ).length,
  };
}

function manualRecord({ workspaceId, directory, threadId = randomUUID(), sessionId = randomUUID(), overrides = {} }) {
  return {
    schema_version: 1,
    thread_id: threadId,
    session_id: sessionId,
    workspace_id: workspaceId,
    title: "Manual thread",
    target: { kind: "workspace" },
    execution_dir: directory,
    session_dir: join(directory, "sessions", threadId),
    session_file: null,
    history_only: false,
    queue: [],
    queue_paused: false,
    accepted_message_ids: [],
    handoffs: [],
    attention: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function publishRecord(workspaceDirectory, record) {
  await mkdir(join(workspaceDirectory, "threads"), { recursive: true });
  await mkdir(record.session_dir, { recursive: true });
  const file = join(workspaceDirectory, "threads", `${record.thread_id}.json`);
  await writeFile(file, `${JSON.stringify(record)}\n`);
  return file;
}

function sessionLines(sessionId, executionDir, texts) {
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: executionDir,
    }),
  ];
  let parentId = null;
  texts.forEach((text, index) => {
    const id = `m${index + 1}`;
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] },
      }),
    );
    parentId = id;
  });
  return `${lines.join("\n")}\n`;
}

test("thread record create publishes exact ThreadV1 fields exclusively", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    const record = await service.create({ workspace_id: "alpha", title: "First thread" });
    assert.equal(record.schema_version, 1);
    assert.match(record.thread_id, UUID_RE);
    assert.equal(record.session_id, record.thread_id);
    assert.equal(record.workspace_id, "alpha");
    assert.equal(record.title, "First thread");
    assert.deepEqual(record.target, { kind: "workspace" });
    assert.equal(record.execution_dir, workspaceDirectory);
    assert.equal(record.session_dir, join(workspaceDirectory, "sessions", record.thread_id));
    assert.equal(record.session_file, null);
    assert.equal("context" in record, false);
    assert.equal(record.history_only, false);
    assert.deepEqual(record.queue, []);
    assert.equal(record.queue_paused, false);
    assert.deepEqual(record.accepted_message_ids, []);
    assert.deepEqual(record.handoffs, []);
    assert.equal(record.attention, null);
    assert.equal(record.created_at, new Date(record.created_at).toISOString());
    assert.equal(record.updated_at, record.created_at);

    const threadFile = join(workspaceDirectory, "threads", `${record.thread_id}.json`);
    const published = JSON.parse(await readFile(threadFile, "utf8"));
    assert.deepEqual(published, record);
    assert.deepEqual(validateThread(published), record);
    assert.deepEqual(await readThread(storageRoot, "alpha", record.thread_id), record);

    const second = await service.create({ workspace_id: "alpha", title: "Second thread" });
    assert.notEqual(second.thread_id, record.thread_id);
    const names = (await readdir(join(workspaceDirectory, "threads"))).sort();
    assert.deepEqual(names, [`${record.thread_id}.json`, `${second.thread_id}.json`].sort());
    assert.deepEqual(JSON.parse(await readFile(threadFile, "utf8")), record);
  } finally {
    service.close();
  }
});

test("thread record validation rejects malformed records without repairing them", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const base = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });

  const unknown = {
    extra_top: "kept",
    provenance: { nested: [1, { deep: true }] },
    import: {
      source: "adjacent",
      digest: "a".repeat(64),
      imported_at: "2026-01-01T00:00:00.000Z",
      adjacent: { authority: "none", provenance: { kept: true } },
    },
  };
  const enriched = { ...base, ...unknown };
  assert.equal(validateThread(enriched), enriched);
  assert.deepEqual(enriched.provenance.nested[1], { deep: true });

  const patches = [
    ["schema_version", { schema_version: 2 }],
    ["thread_id", { thread_id: "not-a-uuid" }],
    ["session_id", { session_id: null }],
    ["workspace_id path", { workspace_id: "../alpha" }],
    ["title empty", { title: "" }],
    ["title long", { title: "x".repeat(201) }],
    ["target null", { target: null }],
    ["target kind", { target: { kind: "bogus" } }],
    ["repository without id", { target: { kind: "repository" } }],
    ["worktree relative", { target: { kind: "worktree", path: "relative/path" } }],
    ["execution_dir relative", { execution_dir: "relative/path" }],
    ["session_dir relative", { session_dir: "relative/path" }],
    ["session_file relative", { session_file: "relative/path" }],
    ["history_only string", { history_only: "no" }],
    ["queue item id", { queue: [{ id: "x", text: "t", queued_at: "2026-01-01T00:00:00.000Z", state: "queued", attempt: 0 }] }],
    ["queue item state", { queue: [{ id: randomUUID(), text: "t", queued_at: "2026-01-01T00:00:00.000Z", state: "sending", attempt: 0 }] }],
    ["queue item attempt", { queue: [{ id: randomUUID(), text: "t", queued_at: "2026-01-01T00:00:00.000Z", state: "queued", attempt: -1 }] }],
    ["accepted uuid", { accepted_message_ids: ["not-a-uuid"] }],
    ["accepted count", { accepted_message_ids: Array.from({ length: 101 }, () => randomUUID()) }],
    ["handoff date", { handoffs: [{ request_id: randomUUID(), brief: "b", saved_at: "yesterday" }] }],
    ["attention type", { attention: 5 }],
    ["created_at", { created_at: "yesterday" }],
    ["model argv", { model: { provider: "-bad", model: "m" } }],
    ["model thinking", { model: { provider: "p", model: "m", thinking: "turbo" } }],
    ["process pid", { process: { pid: 0, started_at: null } }],
    ["process started_at", { process: { pid: 42, started_at: "" } }],
  ];
  for (const [label, patch] of patches) {
    assert.throws(() => validateThread({ ...base, ...patch }), { code: "invalid-thread" }, label);
  }

  // Malformed on-disk records are refused and never rewritten.
  const malformed = { ...base, title: null, ...unknown };
  const malformedFile = await publishRecord(workspaceDirectory, { ...base, ...unknown });
  await writeFile(malformedFile, `${JSON.stringify(malformed)}\n`);
  const bytes = await readFile(malformedFile);
  await assert.rejects(readThread(storageRoot, "alpha", base.thread_id), { code: "invalid-thread" });
  assert.deepEqual(await readFile(malformedFile), bytes);
});

test("thread preservation keeps unknown metadata and import provenance", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");

  const threadId = randomUUID();
  const importedSessionId = randomUUID();
  const record = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    threadId,
    sessionId: importedSessionId,
    overrides: {
      target: { kind: "repository", repository_id: "imported-repo" },
      attention: "missing-directory",
      import: {
        source: "adj7",
        digest: "b".repeat(64),
        imported_at: "2026-01-01T00:00:00.000Z",
        adjacent: { authority: "none", provenance: { nested: [1, 2, 3] } },
      },
      custom: { anything: [true, null] },
    },
  });
  const file = await publishRecord(workspaceDirectory, record);
  const before = await readFile(file);

  const read = await readThread(storageRoot, "alpha", threadId);
  assert.deepEqual(read, record);
  assert.equal(read.session_id, importedSessionId);
  assert.notEqual(read.session_id, read.thread_id);
  assert.deepEqual(read.import.adjacent.provenance.nested, [1, 2, 3]);
  assert.deepEqual(read.custom.anything, [true, null]);
  assert.deepEqual(await readFile(file), before);
});

test("thread preservation history reads only the owned session copy", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");

  const threadId = randomUUID();
  const sourceSessionId = randomUUID();
  const sessionDir = join(workspaceDirectory, "sessions", threadId);
  const copyFile = join(sessionDir, "copy.jsonl");
  const record = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    threadId,
    sessionId: sourceSessionId,
    overrides: { session_file: copyFile, history_only: true, queue_paused: true },
  });
  await publishRecord(workspaceDirectory, record);
  await writeFile(copyFile, sessionLines(sourceSessionId, workspaceDirectory, ["owned first", "owned second"]));
  const copyBefore = await readFile(copyFile);

  const sourceFile = join(root, "source-session.jsonl");
  await writeFile(sourceFile, sessionLines(sourceSessionId, workspaceDirectory, ["source first"]));
  const sourceBefore = await readFile(sourceFile);

  const historyService = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  let history;
  try {
    history = await historyService.history({ workspace_id: "alpha", thread_id: threadId });
  } finally {
    historyService.close();
  }
  assert.equal(history.header.id, sourceSessionId);
  assert.deepEqual(history.entries.map((entry) => entry.message.content[0].text), ["owned first", "owned second"]);
  assert.equal(history.truncated, false);
  assert.deepEqual(await readFile(copyFile), copyBefore);
  assert.deepEqual(await readFile(sourceFile), sourceBefore);

  const pagedService = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  let paged;
  try {
    paged = await pagedService.history({ workspace_id: "alpha", thread_id: threadId, limit: 1 });
  } finally {
    pagedService.close();
  }
  assert.equal(paged.truncated, true);
  assert.deepEqual(paged.entries.map((entry) => entry.message.content[0].text), ["owned second"]);

  // A missing owned copy is an empty branch, never a source read.
  const emptyThreadId = randomUUID();
  const emptyRecord = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory, threadId: emptyThreadId });
  await publishRecord(workspaceDirectory, emptyRecord);
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    const empty = await service.history({ workspace_id: "alpha", thread_id: emptyThreadId });
    assert.equal(empty.header, null);
    assert.deepEqual(empty.entries, []);
  } finally {
    service.close();
  }
});

test("thread record list surfaces invalid records beside valid records", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    const record = await service.create({ workspace_id: "alpha", title: "Valid" });
    const threadsDir = join(workspaceDirectory, "threads");
    const brokenFile = join(threadsDir, "broken.json");
    await writeFile(brokenFile, "{not json\n");
    const wrongNameFile = join(threadsDir, "wrong-name.json");
    const wrong = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
    await writeFile(wrongNameFile, `${JSON.stringify(wrong)}\n`);
    const brokenBefore = await readFile(brokenFile);
    const wrongBefore = await readFile(wrongNameFile);

    const result = await service.list({ workspace_id: "alpha" });
    assert.deepEqual(result.threads.map((entry) => entry.thread_id), [record.thread_id]);
    assert.deepEqual(result.invalid.map((entry) => entry.file).sort(), [brokenFile, wrongNameFile].sort());
    assert.ok(result.invalid.every((entry) => entry.code === "invalid-thread" && typeof entry.message === "string"));
    assert.deepEqual(await readFile(brokenFile), brokenBefore);
    assert.deepEqual(await readFile(wrongNameFile), wrongBefore);
  } finally {
    service.close();
  }
});

test("thread record isolation keeps workspace paths separate", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const alphaDirectory = await setupWorkspace(storageRoot, "alpha");
  const betaDirectory = await setupWorkspace(storageRoot, "beta");
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    const alpha = await service.create({ workspace_id: "alpha", title: "Alpha thread" });
    const beta = await service.create({ workspace_id: "beta", title: "Beta thread" });
    await writeFile(
      join(alpha.session_dir, "alpha.jsonl"),
      sessionLines(alpha.session_id, alphaDirectory, ["alpha only"]),
    );

    assert.deepEqual(
      (await service.history({ workspace_id: "alpha", thread_id: alpha.thread_id })).entries.map(
        (entry) => entry.message.content[0].text,
      ),
      ["alpha only"],
    );
    assert.deepEqual((await service.history({ workspace_id: "beta", thread_id: beta.thread_id })).entries, []);
    await assert.rejects(readThread(storageRoot, "beta", alpha.thread_id), { code: "thread-not-found" });
    assert.notEqual(alpha.session_dir, beta.session_dir);
    assert.ok(!(await lstat(join(betaDirectory, "threads", `${alpha.thread_id}.json`)).catch(() => null)));
  } finally {
    service.close();
  }
});

test("thread record symlink refusals reject escapes before reading", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });

  // A symlinked threads directory is refused for creation and reads.
  await symlink(outside, join(workspaceDirectory, "threads"));
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    await assert.rejects(service.create({ workspace_id: "alpha", title: "Symlinked threads" }), { code: "invalid-thread" });
    await assert.rejects(readThread(storageRoot, "alpha", randomUUID()), { code: "invalid-thread" });
  } finally {
    service.close();
  }

  // A symlinked thread file is refused and surfaced as an invalid list entry.
  await rm(join(workspaceDirectory, "threads"));
  const record = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
  const file = await publishRecord(workspaceDirectory, record);
  await rm(file);
  const outsideRecord = join(outside, "record.json");
  await writeFile(outsideRecord, `${JSON.stringify(record)}\n`);
  await symlink(outsideRecord, file);
  const listService = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    await assert.rejects(readThread(storageRoot, "alpha", record.thread_id), { code: "invalid-thread" });
    const listed = await listService.list({ workspace_id: "alpha" });
    assert.deepEqual(listed.threads, []);
    assert.equal(listed.invalid.length, 1);
    assert.equal(listed.invalid[0].code, "invalid-thread");
  } finally {
    listService.close();
  }

  // A symlinked session directory is refused.
  const sessionRecord = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
  await publishRecord(workspaceDirectory, sessionRecord);
  await rm(sessionRecord.session_dir, { recursive: true, force: true });
  await symlink(outside, sessionRecord.session_dir);
  await assert.rejects(readThread(storageRoot, "alpha", sessionRecord.thread_id), { code: "invalid-thread" });

  // A symlinked session_file is refused.
  const fileRecord = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: { session_file: null },
  });
  await publishRecord(workspaceDirectory, fileRecord);
  const linkedFile = join(fileRecord.session_dir, "linked.jsonl");
  await writeFile(join(outside, "session.jsonl"), "{}\n");
  await symlink(join(outside, "session.jsonl"), linkedFile);
  await writeFile(
    join(workspaceDirectory, "threads", `${fileRecord.thread_id}.json`),
    `${JSON.stringify({ ...fileRecord, session_file: linkedFile })}\n`,
  );
  await assert.rejects(readThread(storageRoot, "alpha", fileRecord.thread_id), { code: "invalid-thread" });
});

test("thread identity resolves repository and registered worktree targets", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const primary = await makeRepo(join(root, "repos", "primary"));
  const worktreePath = join(root, "repos", "linked");
  await git(primary, ["worktree", "add", "--quiet", worktreePath]);
  const linked = await realpath(worktreePath);
  await setupWorkspace(storageRoot, "repo-ws", [
    { id: "app", path: primary },
    { id: "app-linked", path: linked },
  ]);
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    const repository = await service.create({
      workspace_id: "repo-ws",
      title: "Repository target",
      target: { kind: "repository", repository_id: "app" },
    });
    assert.equal(repository.execution_dir, primary);
    assert.deepEqual(repository.target, { kind: "repository", repository_id: "app" });
    assert.equal(repository.attention, null);

    const worktree = await service.create({
      workspace_id: "repo-ws",
      title: "Worktree target",
      target: { kind: "worktree", path: linked },
    });
    assert.equal(worktree.execution_dir, linked);
    assert.deepEqual(worktree.target, { kind: "worktree", path: linked });
    assert.equal(worktree.attention, null);

    const unregisteredPath = join(root, "repos", "extra");
    await git(primary, ["worktree", "add", "--quiet", unregisteredPath]);
    const unregistered = await realpath(unregisteredPath);
    assert.equal((await git(unregistered, ["rev-parse", "--is-inside-work-tree"])).trim(), "true");
    const missing = await service.create({
      workspace_id: "repo-ws",
      title: "Unregistered worktree",
      target: { kind: "worktree", path: unregistered },
    });
    assert.equal(missing.attention, "missing-directory");
    assert.equal(missing.execution_dir, unregistered);
    assert.deepEqual(missing.target, { kind: "worktree", path: unregistered });
  } finally {
    service.close();
  }
});

test("thread identity missing target persists browse-only attention", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const missingRepoPath = join(root, "repos", "absent");
  const workspaceDirectory = await setupWorkspace(storageRoot, "missing-ws", [{ id: "gone", path: missingRepoPath }]);
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    const missing = await service.create({
      workspace_id: "missing-ws",
      title: "Missing repository",
      target: { kind: "repository", repository_id: "gone" },
    });
    assert.equal(missing.attention, "missing-directory");
    assert.deepEqual(missing.target, { kind: "repository", repository_id: "gone" });
    assert.equal(missing.execution_dir, missingRepoPath);
    assert.notEqual(missing.execution_dir, workspaceDirectory);

    const unknown = await service.create({
      workspace_id: "missing-ws",
      title: "Unknown repository",
      target: { kind: "repository", repository_id: "not-in-kit" },
    });
    assert.equal(unknown.attention, "missing-directory");
    assert.equal(unknown.execution_dir, workspaceDirectory);
  } finally {
    service.close();
  }
});

test("thread identity service close refuses mutations and clears subscribers", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  await setupWorkspace(storageRoot, "alpha");
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  const threadId = randomUUID();
  const unsubscribe = service.subscribe({ workspace_id: "alpha", thread_id: threadId }, () => {});
  service.close();
  service.close();
  assert.throws(
    () => service.subscribe({ workspace_id: "alpha", thread_id: threadId }, () => {}),
    { code: "service-closed" },
  );
  await assert.rejects(service.create({ workspace_id: "alpha", title: "After close" }), { code: "service-closed" });
  assert.doesNotThrow(() => unsubscribe());
});

test("thread identity resume refuses live, unknown and marker-only owners without signalling", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");

  const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => {
    try {
      foreign.kill("SIGKILL");
    } catch {
      // already exited
    }
  });
  await new Promise((resolvePromise) => foreign.once("spawn", resolvePromise));
  const identity = processIdentity(foreign.pid);
  assert.ok(identity, "the foreign process must expose a start identity");

  const liveRecord = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: { process: identity },
  });
  await publishRecord(workspaceDirectory, liveRecord);
  const liveService = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    await assert.rejects(liveService.resume({ workspace_id: "alpha", thread_id: liveRecord.thread_id }), {
      code: "live-owner",
    });
    assert.equal(foreign.exitCode, null);
    assert.deepEqual((await readThread(storageRoot, "alpha", liveRecord.thread_id)).process, identity);
  } finally {
    await liveService.close();
  }

  const unknownRecord = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: { process: { pid: foreign.pid, started_at: null } },
  });
  await publishRecord(workspaceDirectory, unknownRecord);
  const unknownService = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    await assert.rejects(unknownService.resume({ workspace_id: "alpha", thread_id: unknownRecord.thread_id }), {
      code: "live-owner",
    });
    assert.equal(foreign.exitCode, null);
  } finally {
    await unknownService.close();
  }

  const mismatchedRecord = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: { process: { pid: foreign.pid, started_at: "bogus start text" } },
  });
  await publishRecord(workspaceDirectory, mismatchedRecord);
  const mismatchedService = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    await assert.rejects(mismatchedService.resume({ workspace_id: "alpha", thread_id: mismatchedRecord.thread_id }), {
      code: "live-owner",
    });
    assert.equal(foreign.exitCode, null);
  } finally {
    await mismatchedService.close();
  }

  const orphanRecord = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
  await publishRecord(workspaceDirectory, orphanRecord);
  const harness = piHarness({ psOutput: `  55555 node server.js discussion:${orphanRecord.thread_id}\n` });
  const orphanService = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
  });
  try {
    await assert.rejects(orphanService.resume({ workspace_id: "alpha", thread_id: orphanRecord.thread_id }), {
      code: "live-owner",
    });
    assert.equal(harness.calls.filter((call) => call.command === "pi").length, 0);
  } finally {
    await orphanService.close();
  }
});

test("thread identity resume refuses untrusted process listings", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const record = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
  await publishRecord(workspaceDirectory, record);

  const cases = [
    ["exit", piHarness({ psOutput: "", psCode: 1 })],
    ["malformed", piHarness({ psOutput: "not a pid line\n" })],
    ["truncated", piHarness({ psOutput: "x".repeat(1024 * 1024 + 10) })],
  ];
  for (const [label, harness] of cases) {
    const service = createDiscussionService({
      root: storageRoot,
      agentDir: join(root, "agent"),
      spawn: harness.spawnImpl,
    });
    try {
      await assert.rejects(service.resume({ workspace_id: "alpha", thread_id: record.thread_id }), { code: "live-owner" }, label);
      assert.equal(harness.calls.filter((call) => call.command === "pi").length, 0, label);
    } finally {
      await service.close();
    }
  }

  // Prefix/suffix lookalikes are not the standalone marker token and must not
  // block a fresh spawn.
  const lookalikeHarness = piHarness({
    psOutput: `  1 launchd\n  2 node xdiscussion:${record.thread_id}\n  3 node discussion:${record.thread_id}-extra\n`,
  });
  const lookalikeService = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: lookalikeHarness.spawnImpl,
  });
  try {
    await lookalikeService.resume({ workspace_id: "alpha", thread_id: record.thread_id });
    assert.equal(lookalikeHarness.calls.filter((call) => call.command === "pi").length, 1);
  } finally {
    await lookalikeService.close();
  }
});

test("thread identity resume reuses one owned child and permits a dead prior child", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const record = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
  await publishRecord(workspaceDirectory, record);

  const harness = piHarness();
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl });
  try {
    const [first, second] = await Promise.all([
      service.resume({ workspace_id: "alpha", thread_id: record.thread_id }),
      service.resume({ workspace_id: "alpha", thread_id: record.thread_id }),
    ]);
    assert.equal(harness.calls.filter((call) => call.command === "pi").length, 1);
    assert.equal(first.process.pid, second.process.pid);
    assert.equal(first.process.started_at, second.process.started_at);
    assert.equal(first.session_file, second.session_file);
    assert.equal(first.queue_paused, false);
    assert.equal(first.session_file, null);
  } finally {
    await service.close();
  }
  await waitFor(async () => (await readThread(storageRoot, "alpha", record.thread_id)).process === undefined);

  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolvePromise) => dead.once("exit", resolvePromise));
  const deadRecord = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: { process: { pid: dead.pid, started_at: null } },
  });
  await publishRecord(workspaceDirectory, deadRecord);
  const harness2 = piHarness();
  const service2 = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness2.spawnImpl,
  });
  try {
    const resumed = await service2.resume({ workspace_id: "alpha", thread_id: deadRecord.thread_id });
    assert.equal(harness2.calls.filter((call) => call.command === "pi").length, 1);
    assert.notEqual(resumed.process.pid, dead.pid);
  } finally {
    await service2.close();
  }
});

// A thread only needs its execution directory: kit context (including folder
// entries such as Phoenix-era material roots) and any legacy per-record
// context are never read, so neither can block a start.
test("thread preservation resume starts Pi without kit or record context", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha", [], ["sources/material", "notes/missing.md"]);
  await mkdir(join(workspaceDirectory, "sources", "material"), { recursive: true });

  const sourceSession = join(root, "imported-source.jsonl");
  await writeFile(sourceSession, sessionLines(randomUUID(), workspaceDirectory, ["source only"]));
  const snapshots = {
    kit: await readFile(join(workspaceDirectory, "kit.yaml")),
    source: await readFile(sourceSession),
  };
  const record = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: {
      context: ["briefs/gone.md"],
      import: {
        source: "adj7",
        digest: "d".repeat(64),
        imported_at: "2026-01-01T00:00:00.000Z",
        adjacent: { authority: "none", provenance: { nested: { kept: [1, 2, 3] } } },
      },
      custom: { anything: { deeper: true } },
    },
  });
  await publishRecord(workspaceDirectory, record);
  const harness = piHarness();
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl });
  try {
    const resumed = await service.resume({ workspace_id: "alpha", thread_id: record.thread_id });
    assert.equal(resumed.attention, null);
    assert.deepEqual(resumed.context, ["briefs/gone.md"], "a legacy context field is retained as additive data");
    assert.deepEqual(resumed.import.adjacent.provenance.nested.kept, [1, 2, 3]);
    assert.deepEqual(resumed.custom, { anything: { deeper: true } });
    const piCall = harness.calls.find((call) => call.command === "pi");
    assert.ok(piCall, "the Pi child is spawned despite a folder kit entry and a missing legacy reference");
    assert.equal(piCall.options.cwd, workspaceDirectory);
    assert.equal(piCall.args.includes("--append-system-prompt"), false);
  } finally {
    await service.close();
  }
  await waitFor(async () => (await readThread(storageRoot, "alpha", record.thread_id)).process === undefined);
  assert.deepEqual(await readFile(join(workspaceDirectory, "kit.yaml")), snapshots.kit);
  assert.deepEqual(await readFile(sourceSession), snapshots.source);

  const imported = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: { history_only: true, queue_paused: true },
  });
  await publishRecord(workspaceDirectory, imported);
  const importedHarness = piHarness();
  const importedService = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: importedHarness.spawnImpl,
  });
  try {
    await assert.rejects(importedService.resume({ workspace_id: "alpha", thread_id: imported.thread_id }), {
      code: "history-only",
    });
    assert.equal(importedHarness.calls.filter((call) => call.command === "pi").length, 0);
  } finally {
    await importedService.close();
  }
});

test("thread preservation resume rewrites missing-target attention keeping unknown metadata", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const missingRepoPath = join(root, "repos", "absent");
  const workspaceDirectory = await setupWorkspace(storageRoot, "missing-ws", [{ id: "gone", path: missingRepoPath }]);
  const record = manualRecord({
    workspaceId: "missing-ws",
    directory: workspaceDirectory,
    overrides: {
      target: { kind: "repository", repository_id: "gone" },
      execution_dir: missingRepoPath,
      import: {
        source: "adj7",
        digest: "c".repeat(64),
        imported_at: "2026-01-01T00:00:00.000Z",
        adjacent: { authority: "none", provenance: { kept: true } },
      },
      custom: { nested: [1, 2, 3] },
    },
  });
  await publishRecord(workspaceDirectory, record);
  const harness = piHarness();
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl });
  try {
    const resumed = await service.resume({ workspace_id: "missing-ws", thread_id: record.thread_id });
    assert.equal(resumed.attention, "missing-directory");
    assert.deepEqual(resumed.custom, { nested: [1, 2, 3] });
    assert.deepEqual(resumed.import, record.import);
    assert.equal(resumed.execution_dir, missingRepoPath);
    assert.equal(harness.calls.filter((call) => call.command === "pi").length, 0);
  } finally {
    await service.close();
  }

  const invalid = { ...record, title: null, attention: "missing-directory" };
  const invalidFile = join(workspaceDirectory, "threads", `${record.thread_id}.json`);
  await writeFile(invalidFile, `${JSON.stringify(invalid)}\n`);
  const before = await readFile(invalidFile);
  const invalidService = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    await assert.rejects(invalidService.resume({ workspace_id: "missing-ws", thread_id: record.thread_id }), {
      code: "invalid-thread",
    });
    assert.deepEqual(await readFile(invalidFile), before);
  } finally {
    await invalidService.close();
  }
});

test("thread identity resume keeps lazy session files null and refuses after close", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const record = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
  await publishRecord(workspaceDirectory, record);
  const harness = piHarness();
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl });
  let resumed;
  try {
    resumed = await service.resume({ workspace_id: "alpha", thread_id: record.thread_id });
    assert.equal(resumed.session_file, null);
    const piCall = harness.calls.find((call) => call.command === "pi");
    assert.ok(piCall);
    assert.deepEqual(piCall.args.slice(-2), ["--session-id", record.session_id]);
  } finally {
    await service.close();
  }
  await assert.rejects(service.resume({ workspace_id: "alpha", thread_id: record.thread_id }), {
    code: "service-closed",
  });
  assert.equal(harness.calls.filter((call) => call.command === "pi").length, 1);
});

test("thread identity resume pins a preexisting owned session header", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const record = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
  await publishRecord(workspaceDirectory, record);
  const ownedCopy = join(record.session_dir, "copy.jsonl");
  await writeFile(
    ownedCopy,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: record.session_id,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: workspaceDirectory,
    })}\n`,
  );
  const copyBefore = await readFile(ownedCopy);
  const harness = piHarness();
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl });
  try {
    const resumed = await service.resume({ workspace_id: "alpha", thread_id: record.thread_id });
    assert.equal(resumed.session_file, ownedCopy);
    assert.deepEqual(harness.calls.find((call) => call.command === "pi").args.slice(-2), ["--session", ownedCopy]);
    assert.deepEqual(await readFile(ownedCopy), copyBefore);
  } finally {
    await service.close();
  }
});

test("thread identity close during startup closes only the owned handle", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const record = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
  await publishRecord(workspaceDirectory, record);
  const harness = piHarness({ env: { FAKE_PI_GET_STATE_HANG: "1" } });
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl });
  const resuming = service.resume({ workspace_id: "alpha", thread_id: record.thread_id });
  resuming.catch(() => {});
  await waitFor(() => harness.calls.some((call) => call.command === "pi"));
  await service.close();
  await assert.rejects(resuming);
  assert.equal(harness.calls.filter((call) => call.command === "pi").length, 1);
  const after = await readThread(storageRoot, "alpha", record.thread_id);
  assert.equal(typeof after.process?.pid, "number");
});

test(
  "thread stop thread identity unconfirmed ready shutdown retains process and attention",
  { timeout: 15000 },
  async (t) => {
    const root = await tempRoot(t);
    const storageRoot = join(root, "storage");
    await setupStorage(storageRoot);
    const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
    const record = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
    await publishRecord(workspaceDirectory, record);

    const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    t.after(() => {
      try {
        dummy.kill("SIGKILL");
      } catch {
        // already exited
      }
    });
    await new Promise((resolvePromise) => dummy.once("spawn", resolvePromise));
    const identity = processIdentity(dummy.pid);
    assert.ok(identity, "the owned dummy must expose a start identity");

    const clock = manualClock();
    const harness = shutdownHarness({ record, pid: dummy.pid, ready: true });
    const service = createDiscussionService({
      root: storageRoot,
      agentDir: join(root, "agent"),
      spawn: harness.spawnImpl,
      clock,
    });
    try {
      const resumed = await service.resume({ workspace_id: "alpha", thread_id: record.thread_id });
      assert.equal(resumed.process.pid, dummy.pid);
      assert.equal(resumed.process.started_at, identity.started_at);

      const closing = service.close();
      await waitFor(() => clock.has(4000));
      clock.fire(4000);
      await waitFor(() => harness.child.kills.includes("SIGKILL") && clock.has(1000));
      clock.fire(1000);
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      if (clock.has(5000)) clock.fire(5000);
      await closing;
      await waitFor(async () => (await readThread(storageRoot, "alpha", record.thread_id)).attention === "live-owner");

      const after = await readThread(storageRoot, "alpha", record.thread_id);
      assert.deepEqual(after.process, { pid: dummy.pid, started_at: identity.started_at });
      assert.equal(after.attention, "live-owner");
      assert.equal(dummy.exitCode, null);
      assert.deepEqual(harness.child.kills, ["SIGKILL"]);
    } finally {
      await service.close();
      harness.child.stdin.destroy();
      harness.child.stdout.destroy();
      harness.child.stderr.destroy();
    }

    const nextHarness = shutdownHarness({ record, pid: dummy.pid, ready: true });
    const nextService = createDiscussionService({
      root: storageRoot,
      agentDir: join(root, "agent"),
      spawn: nextHarness.spawnImpl,
      clock: manualClock(),
    });
    try {
      await assert.rejects(nextService.resume({ workspace_id: "alpha", thread_id: record.thread_id }), {
        code: "live-owner",
      });
      assert.equal(nextHarness.calls.filter((call) => call.command === "pi").length, 0);
    } finally {
      await nextService.close();
      nextHarness.child.stdin.destroy();
      nextHarness.child.stdout.destroy();
      nextHarness.child.stderr.destroy();
    }
  },
);

test(
  "thread identity unconfirmed startup shutdown stays within five seconds",
  { timeout: 15000 },
  async (t) => {
    const root = await tempRoot(t);
    const storageRoot = join(root, "storage");
    await setupStorage(storageRoot);
    const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
    const record = manualRecord({
      workspaceId: "alpha",
      directory: workspaceDirectory,
      overrides: { queue_paused: true },
    });
    await publishRecord(workspaceDirectory, record);

    const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    t.after(() => {
      try {
        dummy.kill("SIGKILL");
      } catch {
        // already exited
      }
    });
    await new Promise((resolvePromise) => dummy.once("spawn", resolvePromise));

    const clock = manualClock();
    const harness = shutdownHarness({ record, pid: dummy.pid, ready: false });
    const service = createDiscussionService({
      root: storageRoot,
      agentDir: join(root, "agent"),
      spawn: harness.spawnImpl,
      clock,
    });
    const resuming = service.resume({ workspace_id: "alpha", thread_id: record.thread_id });
    const rejection = resuming.then(
      () => null,
      (error) => error,
    );
    try {
      await waitFor(async () => {
        const current = await readThread(storageRoot, "alpha", record.thread_id).catch(() => null);
        return current?.process?.pid === dummy.pid;
      });
      assert.equal(harness.calls.filter((call) => call.command === "pi").length, 1);

      const closing = service.close();
      await waitFor(() => clock.has(4000));
      clock.fire(4000);
      await waitFor(() => harness.child.kills.includes("SIGKILL") && clock.has(1000));
      clock.fire(1000);
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      if (clock.has(5000)) clock.fire(5000);
      await closing;

      const outcome = await rejection;
      assert.equal(outcome?.code, "service-closed");
      const after = await readThread(storageRoot, "alpha", record.thread_id);
      assert.equal(after.process?.pid, dummy.pid);
      assert.equal(after.queue_paused, true);
      assert.ok(typeof after.attention === "string" && after.attention !== "");
      assert.deepEqual(harness.child.kills, ["SIGKILL"]);
      assert.equal(dummy.exitCode, null);
    } finally {
      await service.close();
      harness.child.stdin.destroy();
      harness.child.stdout.destroy();
      harness.child.stderr.destroy();
    }
  },
);

test(
  "thread identity unknown captured start retains exclusion and pause",
  { timeout: 15000 },
  async (t) => {
    const root = await tempRoot(t);
    const storageRoot = join(root, "storage");
    await setupStorage(storageRoot);
    const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
    const record = manualRecord({
      workspaceId: "alpha",
      directory: workspaceDirectory,
      overrides: { queue_paused: true },
    });
    await publishRecord(workspaceDirectory, record);

    // An already-exited owned dummy makes the real processIdentity probe return
    // null while the fake handle stays live.
    const dummy = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolvePromise) => dummy.once("exit", resolvePromise));
    assert.notEqual(dummy.exitCode, null);

    const clock = manualClock();
    const harness = shutdownHarness({ record, pid: dummy.pid, ready: true });
    const service = createDiscussionService({
      root: storageRoot,
      agentDir: join(root, "agent"),
      spawn: harness.spawnImpl,
      clock,
    });
    try {
      const resumed = await service.resume({ workspace_id: "alpha", thread_id: record.thread_id });
      assert.equal(resumed.process.pid, dummy.pid);
      assert.equal(resumed.process.started_at, null);
      assert.equal(resumed.attention, "live-owner");
      assert.equal(resumed.queue_paused, true);
      assert.equal(dummy.signalCode, null);
    } finally {
      const closing = service.close();
      await waitFor(() => clock.has(4000));
      clock.fire(4000);
      await waitFor(() => harness.child.kills.includes("SIGKILL") && clock.has(1000));
      clock.fire(1000);
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      if (clock.has(5000)) clock.fire(5000);
      await closing;
      harness.child.stdin.destroy();
      harness.child.stdout.destroy();
      harness.child.stderr.destroy();
    }
  },
);

test("thread durable queue concurrent same-ID enqueues once and preserves original text", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  await setupWorkspace(storageRoot, "alpha");
  const logPath = join(root, "commands.log");
  const harness = piHarness({
    env: { FAKE_PI_COMMAND_LOG: logPath, FAKE_PI_DELAYS: JSON.stringify({ prompt: 120 }) },
  });
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl });
  try {
    const thread = await service.create({ workspace_id: "alpha", title: "Queue" });
    const id = randomUUID();
    const [first, second] = await Promise.all([
      service.send({ workspace_id: "alpha", thread_id: thread.thread_id, id, text: "first text" }),
      service.send({ workspace_id: "alpha", thread_id: thread.thread_id, id, text: "second text" }),
    ]);
    assert.equal(first.duplicate, false);
    assert.equal(first.state, "accepted");
    assert.equal(second.duplicate, true);
    assert.equal(second.message_id, id);
    assert.ok(second.state === "delivering" || second.state === "accepted" || second.state === "queued");

    const persisted = await readThread(storageRoot, "alpha", thread.thread_id);
    assert.deepEqual(persisted.queue, []);
    assert.deepEqual(persisted.accepted_message_ids, [id]);
    assert.equal(persisted.session_file, null);

    const third = await service.send({ workspace_id: "alpha", thread_id: thread.thread_id, id, text: "third text" });
    assert.equal(third.duplicate, true);
    assert.equal(third.state, "accepted");
    assert.equal((await readFile(logPath, "utf8")).split("\n").filter((line) => line.includes('"prompt"')).length, 1);
  } finally {
    await service.close();
  }
});

// Run alone: node --test --test-name-pattern='named from its first message' scripts/workspaces/discussion.test.mjs
test("thread named from its first message only while it keeps the default title", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  await setupWorkspace(storageRoot, "alpha");
  const harness = piHarness();
  const asked = [];
  const titles = { "list the docs": "Docs listing", "this naming fails": null };
  const suggestTitle = async (text) => {
    asked.push(text);
    return titles[text];
  };
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl, suggestTitle });
  const send = (thread, text) => service.send({ workspace_id: "alpha", thread_id: thread.thread_id, id: randomUUID(), text });
  try {
    const named = await service.create({ workspace_id: "alpha" });
    assert.equal(named.title, "New thread");
    await send(named, "list the docs");
    await waitFor(async () => (await readThread(storageRoot, "alpha", named.thread_id)).title === "Docs listing");
    await send(named, "a later message");

    const custom = await service.create({ workspace_id: "alpha", title: "Chosen title" });
    await send(custom, "never named");
    const failing = await service.create({ workspace_id: "alpha" });
    await send(failing, "this naming fails");
    await waitFor(async () => asked.includes("this naming fails"));

    assert.deepEqual(asked, ["list the docs", "this naming fails"], "only first messages of default-titled threads are named");
    assert.equal((await readThread(storageRoot, "alpha", custom.thread_id)).title, "Chosen title");
    assert.equal((await readThread(storageRoot, "alpha", failing.thread_id)).title, "New thread");
  } finally {
    await service.close();
  }
});

test("thread durable queue same text different IDs stay distinct", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  await setupWorkspace(storageRoot, "alpha");
  const harness = piHarness();
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl });
  try {
    const thread = await service.create({ workspace_id: "alpha", title: "Queue" });
    const firstId = randomUUID();
    const secondId = randomUUID();
    const first = await service.send({ workspace_id: "alpha", thread_id: thread.thread_id, id: firstId, text: "same text" });
    assert.equal(first.state, "accepted");
    const second = await service.send({ workspace_id: "alpha", thread_id: thread.thread_id, id: secondId, text: "same text" });
    assert.equal(second.state, "queued");
    const persisted = await readThread(storageRoot, "alpha", thread.thread_id);
    assert.deepEqual(persisted.queue.map((item) => item.id), [secondId]);
    assert.equal(persisted.queue[0].text, "same text");
    assert.deepEqual(persisted.accepted_message_ids, [firstId]);
  } finally {
    await service.close();
  }
});

test("thread durable queue delivering publication precedes prompt write and accepted ack persists once", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const setup = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  let thread;
  try {
    thread = await setup.create({ workspace_id: "alpha", title: "Observe prompt" });
  } finally {
    await setup.close();
  }
  const threadFile = join(workspaceDirectory, "threads", `${thread.thread_id}.json`);
  const logPath = join(root, "commands.log");
  const children = [];
  let observed = null;
  const spawnImpl = (command, args, options = {}) => {
    if (command === "ps") return psChild("  1 launchd\n");
    const child = spawn(process.execPath, [PI_FIXTURE, ...args], {
      ...options,
      env: {
        ...process.env,
        FAKE_PI_COMMAND_LOG: logPath,
        FAKE_PI_DELAYS: JSON.stringify({ prompt: 120 }),
      },
    });
    const originalWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, callback) => {
      const line = chunk.toString();
      if (observed === null && line.includes('"prompt"')) {
        observed = JSON.parse(readFileSync(threadFile, "utf8"));
      }
      return originalWrite(chunk, callback);
    };
    children.push(child);
    return child;
  };
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: spawnImpl });
  try {
    const id = randomUUID();
    const first = service.send({ workspace_id: "alpha", thread_id: thread.thread_id, id, text: "hello" });
    const second = service.send({ workspace_id: "alpha", thread_id: thread.thread_id, id, text: "hello again" });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.state, "accepted");
    assert.equal(secondResult.duplicate, true);
    assert.equal(secondResult.message_id, id);
    assert.ok(secondResult.state === "delivering" || secondResult.state === "accepted" || secondResult.state === "queued");

    assert.ok(observed, "the prompt write must be observed");
    assert.equal(observed.queue.length, 1);
    assert.equal(observed.queue[0].id, id);
    assert.equal(observed.queue[0].state, "delivering");
    assert.equal(observed.queue[0].attempt, 1);

    const persisted = await readThread(storageRoot, "alpha", thread.thread_id);
    assert.deepEqual(persisted.queue, []);
    assert.deepEqual(persisted.accepted_message_ids, [id]);
    assert.equal((await readFile(logPath, "utf8")).split("\n").filter((line) => line.includes('"prompt"')).length, 1);
  } finally {
    await service.close();
    for (const child of children) {
      try {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      } catch {
        // already closed
      }
    }
  }
});

test("thread durable queue accepted retry window evicts oldest identity after durable acknowledgement", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const preseeded = Array.from({ length: 100 }, () => randomUUID());
  const record = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: { accepted_message_ids: preseeded },
  });
  await publishRecord(workspaceDirectory, record);
  const logPath = join(root, "commands.log");
  const harness = piHarness({
    env: {
      FAKE_PI_COMMAND_LOG: logPath,
      FAKE_PI_PROMPT_EVENTS: JSON.stringify([{ type: "agent_settled", aborted: false }]),
    },
  });
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl });
  try {
    const id = randomUUID();
    const first = await service.send({ workspace_id: "alpha", thread_id: record.thread_id, id, text: "text one" });
    assert.equal(first.state, "accepted");
    let persisted = await readThread(storageRoot, "alpha", record.thread_id);
    assert.equal(persisted.accepted_message_ids.length, 100);
    assert.ok(!persisted.accepted_message_ids.includes(preseeded[0]));
    assert.ok(persisted.accepted_message_ids.includes(id));
    for (const kept of preseeded.slice(1)) assert.ok(persisted.accepted_message_ids.includes(kept));
    assert.equal(persisted.accepted_message_ids.at(-1), id);
    assert.deepEqual(persisted.queue, []);

    const retry = await service.send({ workspace_id: "alpha", thread_id: record.thread_id, id, text: "changed" });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.state, "accepted");
    assert.equal((await readFile(logPath, "utf8")).split("\n").filter((line) => line.includes('"prompt"')).length, 1);

    const secondId = randomUUID();
    const second = await service.send({ workspace_id: "alpha", thread_id: record.thread_id, id: secondId, text: "text one" });
    assert.equal(second.state, "accepted");
    persisted = await readThread(storageRoot, "alpha", record.thread_id);
    assert.equal(persisted.accepted_message_ids.length, 100);
    assert.ok(persisted.accepted_message_ids.includes(secondId));
    assert.ok(persisted.accepted_message_ids.includes(id));
    assert.equal((await readFile(logPath, "utf8")).split("\n").filter((line) => line.includes('"prompt"')).length, 2);
  } finally {
    await service.close();
  }
});

test("thread durable queue delayed acknowledgement deduplicates delivering retries", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const record = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
  await publishRecord(workspaceDirectory, record);
  const logPath = join(root, "commands.log");
  const harness = piHarness({ env: { FAKE_PI_COMMAND_LOG: logPath, FAKE_PI_DELAYS: JSON.stringify({ prompt: 150 }) } });
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl });
  try {
    const id = randomUUID();
    const first = service.send({ workspace_id: "alpha", thread_id: record.thread_id, id, text: "original text" });
    first.catch(() => {});
    await waitFor(async () => {
      const current = await readThread(storageRoot, "alpha", record.thread_id);
      const log = await readFile(logPath, "utf8").catch(() => "");
      return current.queue[0]?.state === "delivering" && log.includes('"prompt"');
    });
    const retry = await service.send({ workspace_id: "alpha", thread_id: record.thread_id, id, text: "changed text" });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.state, "delivering");
    const during = await readThread(storageRoot, "alpha", record.thread_id);
    assert.equal(during.queue.length, 1);
    assert.equal(during.queue[0].id, id);
    assert.equal(during.queue[0].text, "original text");
    assert.equal(during.queue[0].attempt, 1);

    const accepted = await first;
    assert.equal(accepted.state, "accepted");
    assert.equal((await readFile(logPath, "utf8")).split("\n").filter((line) => line.includes('"prompt"')).length, 1);
    const persisted = await readThread(storageRoot, "alpha", record.thread_id);
    assert.deepEqual(persisted.queue, []);
    assert.deepEqual(persisted.accepted_message_ids, [id]);
  } finally {
    await service.close();
  }
});

test("thread durable queue EOF after prompt remains uncertain across restart", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const record = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: { custom: { kept: true } },
  });
  await publishRecord(workspaceDirectory, record);
  const logPath = join(root, "commands.log");
  const harness = piHarness({ env: { FAKE_PI_COMMAND_LOG: logPath, FAKE_PI_EOF_ON: "prompt" } });
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl });
  const id = randomUUID();
  try {
    await assert.rejects(
      service.send({ workspace_id: "alpha", thread_id: record.thread_id, id, text: "eof text" }),
      { code: "delivery-uncertain" },
    );
    const persisted = await readThread(storageRoot, "alpha", record.thread_id);
    assert.equal(persisted.queue.length, 1);
    assert.equal(persisted.queue[0].id, id);
    assert.equal(persisted.queue[0].text, "eof text");
    assert.equal(persisted.queue[0].state, "uncertain");
    assert.equal(persisted.queue[0].attempt, 1);
    assert.equal(persisted.attention, "uncertain");
    assert.deepEqual(persisted.custom, { kept: true });
    const retry = await service.send({ workspace_id: "alpha", thread_id: record.thread_id, id, text: "again" });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.state, "uncertain");
    assert.equal((await readFile(logPath, "utf8")).split("\n").filter((line) => line.includes('"prompt"')).length, 1);
  } finally {
    await service.close();
  }

  const freshHarness = piHarness();
  const fresh = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: freshHarness.spawnImpl });
  try {
    const listed = await fresh.list({ workspace_id: "alpha" });
    const listedRecord = listed.threads.find((entry) => entry.thread_id === record.thread_id);
    assert.equal(listedRecord.queue[0].state, "uncertain");
    const retry = await fresh.send({ workspace_id: "alpha", thread_id: record.thread_id, id, text: "again" });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.state, "uncertain");
    assert.equal(freshHarness.calls.filter((call) => call.command === "pi").length, 0);
  } finally {
    await fresh.close();
  }
});

test("thread durable queue prompt timeout stays uncertain without resend", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const record = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
  await publishRecord(workspaceDirectory, record);
  const logPath = join(root, "commands.log");
  const clock = manualClock();
  const harness = piHarness({ env: { FAKE_PI_COMMAND_LOG: logPath, FAKE_PI_PROMPT_HANG: "1" } });
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
    clock,
  });
  const id = randomUUID();
  try {
    const send = service.send({ workspace_id: "alpha", thread_id: record.thread_id, id, text: "timeout text" });
    send.catch(() => {});
    await waitFor(async () => {
      const log = await readFile(logPath, "utf8").catch(() => "");
      return log.includes('"prompt"') && clock.has(30000);
    });
    clock.fire(30000);
    await assert.rejects(send, { code: "delivery-uncertain" });

    const persisted = await readThread(storageRoot, "alpha", record.thread_id);
    assert.equal(persisted.queue.length, 1);
    assert.equal(persisted.queue[0].id, id);
    assert.equal(persisted.queue[0].text, "timeout text");
    assert.equal(persisted.queue[0].state, "uncertain");
    assert.equal(persisted.queue[0].attempt, 1);
    assert.equal(persisted.attention, "uncertain");

    const retry = await service.send({ workspace_id: "alpha", thread_id: record.thread_id, id, text: "again" });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.state, "uncertain");

    const freshId = randomUUID();
    const queued = await service.send({ workspace_id: "alpha", thread_id: record.thread_id, id: freshId, text: "fresh" });
    assert.equal(queued.state, "queued");
    assert.equal((await readFile(logPath, "utf8")).split("\n").filter((line) => line.includes('"prompt"')).length, 1);
  } finally {
    await service.close();
  }
});

test("thread durable queue acceptance publication failure recovers without duplicate prompt", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const record = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: {
      import: {
        source: "adj7",
        digest: "e".repeat(64),
        imported_at: "2026-01-01T00:00:00.000Z",
        adjacent: { authority: "none", provenance: { kept: [1, 2] } },
      },
      custom: { kept: true },
    },
  });
  await publishRecord(workspaceDirectory, record);
  const logPath = join(root, "commands.log");
  const harness = piHarness({ env: { FAKE_PI_COMMAND_LOG: logPath, FAKE_PI_DELAYS: JSON.stringify({ prompt: 100 }) } });
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl });
  const threadsDir = join(workspaceDirectory, "threads");
  const backupDir = join(root, "owned-threads-backup");
  const threadFile = join(threadsDir, `${record.thread_id}.json`);
  const id = randomUUID();
  let renamed = false;
  try {
    const send = service.send({ workspace_id: "alpha", thread_id: record.thread_id, id, text: "acceptance text" });
    send.catch(() => {});
    await waitFor(async () => {
      const log = await readFile(logPath, "utf8").catch(() => "");
      if (!log.includes('"prompt"')) return false;
      try {
        const current = JSON.parse(await readFile(threadFile, "utf8"));
        return current.queue[0]?.state === "delivering" && current.queue[0]?.attempt === 1;
      } catch {
        return false;
      }
    });
    await rename(threadsDir, backupDir);
    renamed = true;
    const outcome = await send.then(
      () => null,
      (error) => error,
    );
    assert.equal(outcome?.code, "delivery-uncertain");
    const onDisk = JSON.parse(await readFile(join(backupDir, `${record.thread_id}.json`), "utf8"));
    assert.equal(onDisk.queue[0].state, "delivering");
    assert.equal(onDisk.queue[0].attempt, 1);
    assert.deepEqual(onDisk.accepted_message_ids, []);
  } finally {
    if (renamed) {
      await rename(backupDir, threadsDir);
      renamed = false;
    }
    await service.close();
  }

  const restored = JSON.parse(await readFile(threadFile, "utf8"));
  assert.equal(restored.queue[0].state, "delivering");
  assert.deepEqual(restored.accepted_message_ids, []);
  assert.equal((await readFile(logPath, "utf8")).split("\n").filter((line) => line.includes('"prompt"')).length, 1);

  const freshHarness = piHarness();
  const fresh = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: freshHarness.spawnImpl });
  try {
    const listed = await fresh.list({ workspace_id: "alpha" });
    const recovered = listed.threads.find((entry) => entry.thread_id === record.thread_id);
    assert.equal(recovered.queue[0].state, "uncertain");
    assert.equal(recovered.queue[0].id, id);
    assert.equal(recovered.queue[0].text, "acceptance text");
    assert.equal(recovered.queue[0].attempt, 1);
    assert.deepEqual(recovered.import.adjacent.provenance, { kept: [1, 2] });
    assert.deepEqual(recovered.custom, { kept: true });
    const retry = await fresh.send({ workspace_id: "alpha", thread_id: record.thread_id, id, text: "again" });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.state, "uncertain");
    assert.equal(freshHarness.calls.filter((call) => call.command === "pi").length, 0);
  } finally {
    await fresh.close();
  }
});

test("thread durable queue restart delivering becomes uncertain on first access", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const deliveringId = randomUUID();
  const queuedId = randomUUID();
  const record = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: {
      queue: [
        {
          id: deliveringId,
          text: "delivering text",
          queued_at: "2026-01-01T00:00:00.000Z",
          state: "delivering",
          attempt: 2,
          extra: { kept: true },
        },
        { id: queuedId, text: "queued text", queued_at: "2026-01-01T00:00:00.000Z", state: "queued", attempt: 0 },
      ],
      queue_paused: true,
      custom: { nested: { kept: true } },
    },
  });
  await publishRecord(workspaceDirectory, record);
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    const listed = await service.list({ workspace_id: "alpha" });
    const recovered = listed.threads.find((entry) => entry.thread_id === record.thread_id);
    assert.equal(recovered.queue[0].state, "uncertain");
    assert.equal(recovered.queue[1].state, "queued");
    assert.equal(recovered.attention, "uncertain");
    assert.equal(recovered.queue_paused, true);
    assert.deepEqual(recovered.queue[0].extra, { kept: true });
    assert.deepEqual(recovered.custom, { nested: { kept: true } });

    await service.history({ workspace_id: "alpha", thread_id: record.thread_id });
    const persisted = await readThread(storageRoot, "alpha", record.thread_id);
    assert.equal(persisted.queue[0].state, "uncertain");
    assert.equal(persisted.queue[0].id, deliveringId);
    assert.equal(persisted.queue[0].attempt, 2);
    assert.equal(persisted.queue[1].state, "queued");
  } finally {
    await service.close();
  }

  // A fresh service recovers before resume work and never writes a prompt.
  const logPath = join(root, "commands.log");
  const harness = piHarness({ env: { FAKE_PI_COMMAND_LOG: logPath } });
  const resumed = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl });
  try {
    await resumed.resume({ workspace_id: "alpha", thread_id: record.thread_id });
    assert.ok(!(await readFile(logPath, "utf8")).includes('"prompt"'));
    const persisted = await readThread(storageRoot, "alpha", record.thread_id);
    assert.equal(persisted.queue[0].state, "uncertain");
    assert.equal(persisted.queue[1].state, "queued");
  } finally {
    await resumed.close();
  }
});

test("thread durable queue duplicates survive a new service for queued uncertain and accepted", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const queuedId = randomUUID();
  const uncertainId = randomUUID();
  const acceptedIds = Array.from({ length: 100 }, () => randomUUID());
  const record = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: {
      queue: [
        { id: queuedId, text: "queued text", queued_at: "2026-01-01T00:00:00.000Z", state: "queued", attempt: 0 },
        { id: uncertainId, text: "uncertain text", queued_at: "2026-01-01T00:00:00.000Z", state: "uncertain", attempt: 1 },
      ],
      accepted_message_ids: acceptedIds,
      queue_paused: true,
      custom: { kept: true },
    },
  });
  await publishRecord(workspaceDirectory, record);
  const threadFile = join(workspaceDirectory, "threads", `${record.thread_id}.json`);
  const bytes = await readFile(threadFile);
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    const queued = await service.send({ workspace_id: "alpha", thread_id: record.thread_id, id: queuedId, text: "replacement" });
    assert.equal(queued.duplicate, true);
    assert.equal(queued.state, "queued");
    const uncertain = await service.send({
      workspace_id: "alpha",
      thread_id: record.thread_id,
      id: uncertainId,
      text: "replacement",
    });
    assert.equal(uncertain.duplicate, true);
    assert.equal(uncertain.state, "uncertain");
    const accepted = await service.send({
      workspace_id: "alpha",
      thread_id: record.thread_id,
      id: acceptedIds[99],
      text: "replacement",
    });
    assert.equal(accepted.duplicate, true);
    assert.equal(accepted.state, "accepted");
    assert.deepEqual(await readFile(threadFile), bytes);
    const persisted = await readThread(storageRoot, "alpha", record.thread_id);
    assert.equal(persisted.queue[0].text, "queued text");
    assert.equal(persisted.queue[1].text, "uncertain text");
    assert.equal(persisted.queue_paused, true);
    assert.deepEqual(persisted.custom, { kept: true });
  } finally {
    await service.close();
  }
});

test("thread durable queue discard and resend replace uncertain identity with fresh uuid", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const uncertainId = randomUUID();
  const queuedId = randomUUID();
  const record = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: {
      queue: [
        {
          id: uncertainId,
          text: "uncertain text",
          queued_at: "2026-01-01T00:00:00.000Z",
          state: "uncertain",
          attempt: 3,
          extra: { kept: true },
        },
        { id: queuedId, text: "queued text", queued_at: "2026-01-01T00:00:00.000Z", state: "queued", attempt: 0 },
      ],
      queue_paused: true,
      custom: { kept: true },
    },
  });
  await publishRecord(workspaceDirectory, record);
  const threadFile = join(workspaceDirectory, "threads", `${record.thread_id}.json`);
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    const bytesBefore = await readFile(threadFile);
    await assert.rejects(service.discard({ workspace_id: "alpha", thread_id: record.thread_id, id: queuedId }), {
      code: "message-not-uncertain",
    });
    await assert.rejects(service.discard({ workspace_id: "alpha", thread_id: record.thread_id, id: randomUUID() }), {
      code: "message-not-found",
    });
    assert.deepEqual(await readFile(threadFile), bytesBefore);

    const discarded = await service.discard({ workspace_id: "alpha", thread_id: record.thread_id, id: uncertainId });
    assert.equal(discarded.state, "discarded");
    assert.equal(discarded.message_id, uncertainId);
    let persisted = await readThread(storageRoot, "alpha", record.thread_id);
    assert.deepEqual(persisted.queue.map((item) => item.id), [queuedId]);
    assert.equal(persisted.queue_paused, true);
    assert.deepEqual(persisted.custom, { kept: true });

    const resentSourceId = randomUUID();
    const resentSource = {
      ...persisted,
      queue: [
        ...persisted.queue,
        {
          id: resentSourceId,
          text: "resend text",
          queued_at: "2026-01-01T00:00:00.000Z",
          state: "uncertain",
          attempt: 1,
        },
      ],
    };
    await writeFile(threadFile, `${JSON.stringify(resentSource)}\n`);
    const resent = await service.discard({ workspace_id: "alpha", thread_id: record.thread_id, id: resentSourceId, resend: true });
    assert.notEqual(resent.message_id, resentSourceId);
    assert.equal(resent.state, "queued");
    assert.equal(resent.warning, "possible duplicate response");
    persisted = await readThread(storageRoot, "alpha", record.thread_id);
    const replacement = persisted.queue.find((item) => item.id === resent.message_id);
    assert.equal(replacement.text, "resend text");
    assert.equal(replacement.state, "queued");
    assert.equal(replacement.attempt, 0);
    assert.equal(persisted.queue.length, resentSource.queue.length);
    assert.equal(persisted.queue_paused, true);
    assert.deepEqual(persisted.custom, { kept: true });
  } finally {
    await service.close();
  }
});

test("thread durable queue invalid history-only and closed inputs leave bytes unchanged", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");

  const invalidRecord = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: { title: null },
  });
  await publishRecord(workspaceDirectory, invalidRecord);
  const invalidFile = join(workspaceDirectory, "threads", `${invalidRecord.thread_id}.json`);
  const invalidBytes = await readFile(invalidFile);
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    await assert.rejects(
      service.send({ workspace_id: "alpha", thread_id: invalidRecord.thread_id, id: randomUUID(), text: "x" }),
      { code: "invalid-thread" },
    );
    assert.deepEqual(await readFile(invalidFile), invalidBytes);
    await assert.rejects(service.send({ workspace_id: "alpha", thread_id: randomUUID(), id: randomUUID(), text: "x" }), {
      code: "thread-not-found",
    });
    await assert.rejects(
      service.send({ workspace_id: "alpha", thread_id: randomUUID(), id: "not-a-uuid", text: "x" }),
      { code: "invalid-message" },
    );
    await assert.rejects(service.send({ workspace_id: "alpha", thread_id: randomUUID(), id: randomUUID(), text: "" }), {
      code: "invalid-message",
    });
    await assert.rejects(
      service.send({
        workspace_id: "alpha",
        thread_id: randomUUID(),
        id: randomUUID(),
        text: "x".repeat(64 * 1024 + 1),
      }),
      { code: "invalid-message" },
    );
    await assert.rejects(
      service.send({ workspace_id: "alpha", thread_id: randomUUID(), id: randomUUID(), text: "x", root: "/tmp/override" }),
      { code: "invalid-message" },
    );
  } finally {
    await service.close();
  }

  const historyRecord = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: { history_only: true, queue_paused: true },
  });
  await publishRecord(workspaceDirectory, historyRecord);
  const historyFile = join(workspaceDirectory, "threads", `${historyRecord.thread_id}.json`);
  const historyBytes = await readFile(historyFile);
  const historyService = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    await assert.rejects(
      historyService.send({ workspace_id: "alpha", thread_id: historyRecord.thread_id, id: randomUUID(), text: "x" }),
      { code: "history-only" },
    );
    await assert.rejects(
      historyService.discard({ workspace_id: "alpha", thread_id: historyRecord.thread_id, id: randomUUID() }),
      { code: "history-only" },
    );
    assert.deepEqual(await readFile(historyFile), historyBytes);
  } finally {
    await historyService.close();
  }

  const closedService = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  await closedService.close();
  await assert.rejects(
    closedService.send({ workspace_id: "alpha", thread_id: randomUUID(), id: randomUUID(), text: "x" }),
    { code: "service-closed" },
  );
  await assert.rejects(
    closedService.discard({ workspace_id: "alpha", thread_id: randomUUID(), id: randomUUID() }),
    { code: "service-closed" },
  );
});

test("thread durable queue settled before failed acknowledgement keeps uncertainty without lease leak", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  await setupWorkspace(storageRoot, "alpha");
  const logPath = join(root, "commands.log");
  const harness = piHarness({
    env: {
      FAKE_PI_COMMAND_LOG: logPath,
      FAKE_PI_PROMPT_EVENTS: JSON.stringify([{ type: "agent_settled", aborted: false }]),
      FAKE_PI_DISPOSITION: "invalid-disposition",
    },
  });
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent"), spawn: harness.spawnImpl });
  try {
    const firstThread = await service.create({ workspace_id: "alpha", title: "Settled failure" });
    const secondThread = await service.create({ workspace_id: "alpha", title: "Next thread" });
    const failedId = randomUUID();
    await assert.rejects(
      service.send({ workspace_id: "alpha", thread_id: firstThread.thread_id, id: failedId, text: "will fail" }),
      { code: "delivery-uncertain" },
    );
    const failed = await readThread(storageRoot, "alpha", firstThread.thread_id);
    assert.equal(failed.queue.length, 1);
    assert.equal(failed.queue[0].id, failedId);
    assert.equal(failed.queue[0].state, "uncertain");
    assert.equal(failed.queue[0].attempt, 1);

    const nextId = randomUUID();
    try {
      const second = await service.send({
        workspace_id: "alpha",
        thread_id: secondThread.thread_id,
        id: nextId,
        text: "next",
      });
      assert.equal(second.state, "queued");
    } catch (error) {
      assert.equal(error.code, "delivery-uncertain");
    }
    await waitFor(async () => {
      const record = await readThread(storageRoot, "alpha", secondThread.thread_id);
      return record.queue.some(
        (item) => item.id === nextId && item.state === "uncertain" && item.attempt === 1,
      );
    });
    const prompts = (await readFile(logPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "prompt");
    assert.deepEqual(prompts.map((entry) => entry.id), [failedId, nextId]);
    const failedAgain = await readThread(storageRoot, "alpha", firstThread.thread_id);
    assert.equal(failedAgain.queue[0].state, "uncertain");
  } finally {
    await service.close();
  }
});

test("thread durable queue unknown captured identity never writes prompt", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const record = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: { queue_paused: true },
  });
  await publishRecord(workspaceDirectory, record);

  const dummy = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolvePromise) => dummy.once("exit", resolvePromise));
  assert.notEqual(dummy.exitCode, null);

  const commands = [];
  const clock = manualClock();
  const harness = shutdownHarness({ record, pid: dummy.pid, ready: true });
  harness.child.stdin.on("data", (chunk) => commands.push(chunk.toString("utf8")));
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
    clock,
  });
  try {
    const id = randomUUID();
    const queued = await service.send({ workspace_id: "alpha", thread_id: record.thread_id, id, text: "should not prompt" });
    assert.equal(queued.duplicate, false);
    assert.equal(queued.state, "queued");
    const persisted = await readThread(storageRoot, "alpha", record.thread_id);
    assert.equal(persisted.queue.length, 1);
    assert.equal(persisted.queue[0].id, id);
    assert.equal(persisted.queue[0].state, "queued");
    assert.equal(persisted.queue[0].attempt, 0);
    assert.equal(persisted.queue_paused, true);
    assert.equal(persisted.process?.started_at, null);
    assert.equal(persisted.attention, "live-owner");
    assert.equal(
      commands.some((chunk) => chunk.includes('"prompt"')),
      false,
    );
    assert.equal(dummy.signalCode, null);
  } finally {
    const closing = service.close();
    await waitFor(() => clock.has(4000));
    clock.fire(4000);
    await waitFor(() => harness.child.kills.includes("SIGKILL") && clock.has(1000));
    clock.fire(1000);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    if (clock.has(5000)) clock.fire(5000);
    await closing;
    harness.child.stdin.destroy();
    harness.child.stdout.destroy();
    harness.child.stderr.destroy();
  }
});

// Fixture IPC seam harness: spawns the real Node fixture with stdio pipes plus
// an IPC control channel, retains children by the discussion-<thread> --name
// value and awaits a processed-control ACK with a finite deadline.
function fixtureHarness({ env = {}, ipc = true, onCommand = null, envFor = null } = {}) {
  const calls = [];
  const children = [];
  const byThread = new Map();
  const receipts = [];
  const spawnImpl = (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === "ps") return psChild("  1 launchd\n");
    const base = options.stdio ?? ["pipe", "pipe", "pipe"];
    const stdio = ipc ? [base[0] ?? "pipe", base[1] ?? "pipe", base[2] ?? "pipe", "ipc"] : base;
    const childEnv = typeof envFor === "function" ? envFor(args, command) : env;
    const child = spawn(process.execPath, [PI_FIXTURE, ...args], {
      ...options,
      stdio,
      env: { ...process.env, ...childEnv },
    });
    child.receipts = [];
    const originalWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, callback) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() === "") continue;
        try {
          const parsed = JSON.parse(line);
          receipts.push(parsed);
          child.receipts.push(parsed);
          if (typeof onCommand === "function") onCommand(parsed, child, args);
        } catch {
          // Non-JSON writes are not command receipts.
        }
      }
      return originalWrite(chunk, callback);
    };
    const nameIndex = args.indexOf("--name");
    const threadId = nameIndex === -1 ? null : String(args[nameIndex + 1]).replace(/^discussion:/, "");
    if (threadId !== null) byThread.set(threadId, child);
    children.push(child);
    return child;
  };
  const control = (threadId, message, timeoutMs = 3000) => {
    const child = byThread.get(threadId);
    if (!child) return Promise.reject(new Error(`no fixture child for thread ${threadId}`));
    const ack = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("fixture control ACK timed out")), timeoutMs);
      child.once("message", (reply) => {
        clearTimeout(timer);
        resolvePromise(reply);
      });
    });
    child.send(message);
    return ack;
  };
  return { calls, children, byThread, receipts, spawnImpl, control };
}

// node --test --test-name-pattern="thread failure recovery wakes" scripts/workspaces/discussion.test.mjs
for (const resend of [false, true]) {
  test(`thread failure recovery wakes ${resend ? "explicit resend" : "following work after discard"} after settled acknowledgement timeout`, async (t) => {
    const root = await tempRoot(t);
    const storageRoot = join(root, "storage");
    await setupStorage(storageRoot);
    await setupWorkspace(storageRoot, "alpha");
    const clock = manualClock();
    const harness = fixtureHarness({ env: { FAKE_PI_PROMPT_HANG: "1" } });
    const service = createDiscussionService({
      root: storageRoot,
      agentDir: join(root, "agent"),
      spawn: harness.spawnImpl,
      clock,
    });
    try {
      const thread = await service.create({ workspace_id: "alpha", title: "Recovery" });
      const failedId = randomUUID();
      const sending = service.send({ workspace_id: "alpha", thread_id: thread.thread_id, id: failedId, text: "original" });
      sending.catch(() => {});
      await waitFor(() => harness.receipts.some((entry) => entry.type === "prompt") && clock.has(30000));
      const followingId = randomUUID();
      if (!resend) {
        const queued = await service.send({ workspace_id: "alpha", thread_id: thread.thread_id, id: followingId, text: "following" });
        assert.equal(queued.state, "queued");
      }
      await harness.control(thread.thread_id, { event: { type: "agent_settled", aborted: false } });
      clock.fire(30000);
      await assert.rejects(sending, { code: "delivery-uncertain" });
      // Let the failed pump finish its catalog scan and stop at the uncertain
      // head; recovery must wake an idle pump, not race its previous pass.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      const failed = await readThread(storageRoot, "alpha", thread.thread_id);
      assert.equal(failed.queue[0].state, "uncertain");
      assert.equal(harness.receipts.filter((entry) => entry.type === "prompt").length, 1);

      const recovered = await service.discard({ workspace_id: "alpha", thread_id: thread.thread_id, id: failedId, resend });
      const expectedId = resend ? recovered.message_id : followingId;
      assert.notEqual(expectedId, failedId);
      await waitFor(() => harness.receipts.filter((entry) => entry.type === "prompt").length === 2);
      const prompts = harness.receipts.filter((entry) => entry.type === "prompt");
      assert.deepEqual(prompts.map((entry) => entry.id), [failedId, expectedId]);
      assert.equal(prompts[1].message, resend ? "original" : "following");
      const progressed = await readThread(storageRoot, "alpha", thread.thread_id);
      assert.equal(progressed.queue[0].id, expectedId);
      assert.equal(progressed.queue[0].state, "delivering");
      assert.equal(progressed.queue[0].attempt, 1);
    } finally {
      await service.close();
    }
  });
}

test("thread global scheduler FIFO projection", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const alphaDirectory = await setupWorkspace(storageRoot, "alpha");
  const betaDirectory = await setupWorkspace(storageRoot, "beta");

  const alphaRecord = manualRecord({
    workspaceId: "alpha",
    directory: alphaDirectory,
    overrides: {
      queue: [
        {
          id: randomUUID(),
          text: "alpha first",
          queued_at: "2026-01-01T00:00:00.000Z",
          state: "queued",
          attempt: 0,
        },
        {
          id: randomUUID(),
          text: "alpha second",
          queued_at: "2026-01-01T00:00:01.000Z",
          state: "queued",
          attempt: 0,
        },
      ],
    },
  });
  await publishRecord(alphaDirectory, alphaRecord);
  const betaRecord = manualRecord({
    workspaceId: "beta",
    directory: betaDirectory,
    overrides: {
      queue: [
        {
          id: randomUUID(),
          text: "beta first",
          queued_at: "2026-01-01T00:00:02.000Z",
          state: "queued",
          attempt: 0,
        },
      ],
    },
  });
  await publishRecord(betaDirectory, betaRecord);
  const pausedRecord = manualRecord({
    workspaceId: "alpha",
    directory: alphaDirectory,
    overrides: {
      queue: [
        {
          id: randomUUID(),
          text: "paused head",
          queued_at: "2026-01-01T00:00:00.000Z",
          state: "queued",
          attempt: 0,
        },
      ],
      queue_paused: true,
    },
  });
  await publishRecord(alphaDirectory, pausedRecord);
  const uncertainRecord = manualRecord({
    workspaceId: "beta",
    directory: betaDirectory,
    overrides: {
      queue: [
        {
          id: randomUUID(),
          text: "uncertain head",
          queued_at: "2026-01-01T00:00:00.000Z",
          state: "uncertain",
          attempt: 1,
        },
      ],
    },
  });
  await publishRecord(betaDirectory, uncertainRecord);

  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    const listed = await service.list();
    const byId = new Map(listed.threads.map((record) => [record.thread_id, record]));
    const alpha = byId.get(alphaRecord.thread_id);
    const beta = byId.get(betaRecord.thread_id);
    const paused = byId.get(pausedRecord.thread_id);
    const uncertain = byId.get(uncertainRecord.thread_id);
    assert.deepEqual(
      alpha.queue.map((item) => item.queue_position),
      [1, 2],
    );
    assert.deepEqual(
      beta.queue.map((item) => item.queue_position),
      [3],
    );
    assert.equal(paused.queue[0].queue_position, null);
    assert.equal(uncertain.queue[0].queue_position, null);

    for (const [directory, record] of [
      [alphaDirectory, alphaRecord],
      [betaDirectory, betaRecord],
      [alphaDirectory, pausedRecord],
      [betaDirectory, uncertainRecord],
    ]) {
      const stored = JSON.parse(await readFile(join(directory, "threads", `${record.thread_id}.json`), "utf8"));
      assert.ok(!("state" in stored) && !("partial" in stored) && !("generation" in stored));
      for (const item of stored.queue) assert.ok(!("queue_position" in item));
    }
  } finally {
    await service.close();
  }
});

test("thread global scheduler holds started lease", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  await setupWorkspace(storageRoot, "alpha");
  const harness = fixtureHarness();
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
  });
  try {
    const threadA = await service.create({ workspace_id: "alpha", title: "Scheduler A" });
    const threadB = await service.create({ workspace_id: "alpha", title: "Scheduler B" });
    const aId = randomUUID();
    const bId = randomUUID();
    const a2Id = randomUUID();

    const aFirst = await service.send({ workspace_id: "alpha", thread_id: threadA.thread_id, id: aId, text: "A one" });
    assert.equal(aFirst.state, "accepted");
    const bFirst = await service.send({ workspace_id: "alpha", thread_id: threadB.thread_id, id: bId, text: "B one" });
    assert.equal(bFirst.state, "queued");
    const aSecond = await service.send({ workspace_id: "alpha", thread_id: threadA.thread_id, id: a2Id, text: "A two" });
    assert.equal(aSecond.state, "queued");
    const promptIds = () => harness.receipts.filter((receipt) => receipt.type === "prompt").map((receipt) => receipt.id);
    assert.deepEqual(promptIds(), [aId]);

    await harness.control(threadA.thread_id, { event: { type: "agent_end" } });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    assert.deepEqual(promptIds(), [aId]);

    await harness.control(threadA.thread_id, { event: { type: "agent_settled", aborted: false } });
    await waitFor(async () =>
      (await readThread(storageRoot, "alpha", threadB.thread_id)).accepted_message_ids.includes(bId),
    );
    await waitFor(() => harness.byThread.has(threadB.thread_id));
    await harness.control(threadB.thread_id, { event: { type: "agent_settled", aborted: false } });
    await waitFor(async () =>
      (await readThread(storageRoot, "alpha", threadA.thread_id)).accepted_message_ids.includes(a2Id),
    );

    assert.deepEqual(promptIds(), [aId, bId, a2Id]);
    const aFinal = await readThread(storageRoot, "alpha", threadA.thread_id);
    const bFinal = await readThread(storageRoot, "alpha", threadB.thread_id);
    assert.deepEqual(aFinal.accepted_message_ids, [aId, a2Id]);
    assert.deepEqual(bFinal.accepted_message_ids, [bId]);
    assert.deepEqual(aFinal.queue, []);
    assert.deepEqual(bFinal.queue, []);
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread global scheduler event before acknowledgement", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const observed = { delivering: null, acceptedA: null, threadFileA: null, aId: null, bId: null };
  const harness = fixtureHarness({
    env: {
      FAKE_PI_PROMPT_EVENTS: JSON.stringify([{ type: "agent_settled", aborted: false }]),
      FAKE_PI_DELAYS: JSON.stringify({ prompt: 120 }),
    },
    onCommand: (receipt) => {
      if (receipt.type !== "prompt" || observed.threadFileA === null) return;
      if (receipt.id === observed.aId && observed.delivering === null) {
        observed.delivering = JSON.parse(readFileSync(observed.threadFileA, "utf8"));
      }
      if (receipt.id === observed.bId && observed.acceptedA === null) {
        observed.acceptedA = JSON.parse(readFileSync(observed.threadFileA, "utf8"));
      }
    },
  });
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
  });
  try {
    const threadA = await service.create({ workspace_id: "alpha", title: "Ordering A" });
    const threadB = await service.create({ workspace_id: "alpha", title: "Ordering B" });
    const aId = randomUUID();
    const bId = randomUUID();
    observed.threadFileA = join(workspaceDirectory, "threads", `${threadA.thread_id}.json`);
    observed.aId = aId;
    observed.bId = bId;

    const aSend = service.send({ workspace_id: "alpha", thread_id: threadA.thread_id, id: aId, text: "A" });
    aSend.catch(() => {});
    await waitFor(() => observed.delivering !== null);
    const bSend = service.send({ workspace_id: "alpha", thread_id: threadB.thread_id, id: bId, text: "B" });
    bSend.catch(() => {});
    assert.equal((await bSend).state, "queued");

    assert.equal((await aSend).state, "accepted");
    assert.ok(observed.delivering, "the A prompt write must be observed");
    assert.equal(observed.delivering.queue[0].state, "delivering");
    assert.equal(observed.delivering.queue[0].attempt, 1);

    await waitFor(() => observed.acceptedA !== null);
    assert.deepEqual(observed.acceptedA.accepted_message_ids, [aId]);
    assert.deepEqual(observed.acceptedA.queue, []);

    await waitFor(async () =>
      (await readThread(storageRoot, "alpha", threadB.thread_id)).accepted_message_ids.includes(bId),
    );
    assert.deepEqual(
      harness.receipts.filter((receipt) => receipt.type === "prompt").map((receipt) => receipt.id),
      [aId, bId],
    );
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread isolation keeps scoped events and history separate", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");

  const markerA = "A \u2028\u2029 \u{1F680} end";
  const markerB = "B only";
  const recordA = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
  const recordB = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
  const copyA = join(recordA.session_dir, "copy.jsonl");
  const copyB = join(recordB.session_dir, "copy.jsonl");
  const sessionText = (sessionId, text) =>
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: workspaceDirectory,
    })}\n${JSON.stringify({
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text }] },
    })}\n`;
  await publishRecord(workspaceDirectory, { ...recordA, session_file: copyA });
  await publishRecord(workspaceDirectory, { ...recordB, session_file: copyB });
  await writeFile(copyA, sessionText(recordA.session_id, markerA));
  await writeFile(copyB, sessionText(recordB.session_id, markerB));

  const harness = fixtureHarness({ env: { FAKE_PI_SPLIT_WRITES: "1" } });
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
  });
  try {
    await service.resume({ workspace_id: "alpha", thread_id: recordA.thread_id });
    await service.resume({ workspace_id: "alpha", thread_id: recordB.thread_id });

    const seenA = [];
    const seenB = [];
    const unsubscribeA = service.subscribe({ workspace_id: "alpha", thread_id: recordA.thread_id }, (payload) =>
      seenA.push(payload),
    );
    service.subscribe({ workspace_id: "alpha", thread_id: recordA.thread_id }, () => {
      throw new Error("throwing subscriber");
    });
    service.subscribe({ workspace_id: "alpha", thread_id: recordB.thread_id }, (payload) => seenB.push(payload));

    await harness.control(recordA.thread_id, { event: { type: "message_update", delta: markerA } });
    await harness.control(recordB.thread_id, { event: { type: "message_update", delta: markerB } });
    await waitFor(
      () =>
        seenA.some((payload) => payload.event?.type === "message_update") &&
        seenB.some((payload) => payload.event?.type === "message_update"),
    );

    const payloadA = seenA.find((payload) => payload.event?.type === "message_update");
    const payloadB = seenB.find((payload) => payload.event?.type === "message_update");
    assert.equal(payloadA.thread_id, recordA.thread_id);
    assert.equal(payloadB.thread_id, recordB.thread_id);
    assert.equal(typeof payloadA.generation, "string");
    assert.equal(typeof payloadB.generation, "string");
    assert.notEqual(payloadA.generation, payloadB.generation);
    assert.equal(payloadA.event.delta, markerA);
    assert.equal(payloadB.event.delta, markerB);
    assert.ok(Number.isSafeInteger(payloadA.sequence) && payloadA.sequence >= 1, "envelopes carry a positive sequence");
    assert.ok(Number.isSafeInteger(payloadB.sequence) && payloadB.sequence >= 1, "envelopes carry a positive sequence");

    const listed = await service.list({ workspace_id: "alpha" });
    const byId = new Map(listed.threads.map((entry) => [entry.thread_id, entry]));
    assert.ok(byId.get(recordA.thread_id).partial.includes("\u2028"));
    assert.ok(byId.get(recordA.thread_id).partial.includes("\u{1F680}"));
    assert.equal(byId.get(recordB.thread_id).partial, markerB);
    assert.equal(byId.get(recordA.thread_id).watermark, payloadA.sequence, "projection watermark matches the latest scoped event");
    assert.equal(byId.get(recordB.thread_id).watermark, payloadB.sequence);

    // A later delta advances only this thread's sequence and partial; the
    // projection reports the new watermark beside the accumulated partial.
    await harness.control(recordA.thread_id, { event: { type: "message_update", delta: " second" } });
    await waitFor(() => seenA.filter((payload) => payload.event?.type === "message_update").length === 2);
    const progressed = seenA.filter((payload) => payload.event?.type === "message_update")[1];
    assert.ok(progressed.sequence > payloadA.sequence, "later events advance the thread watermark");
    const relisted = await service.list({ workspace_id: "alpha" });
    const byIdAgain = new Map(relisted.threads.map((entry) => [entry.thread_id, entry]));
    assert.equal(byIdAgain.get(recordA.thread_id).watermark, progressed.sequence);
    assert.ok(byIdAgain.get(recordA.thread_id).partial.endsWith(" second"), "partial keeps both deltas");
    assert.equal(byIdAgain.get(recordB.thread_id).watermark, payloadB.sequence, "the other thread watermark is unchanged");

    const historyA = await service.history({ workspace_id: "alpha", thread_id: recordA.thread_id });
    const historyB = await service.history({ workspace_id: "alpha", thread_id: recordB.thread_id });
    assert.deepEqual(
      historyA.entries.map((entry) => entry.message.content[0].text),
      [markerA],
    );
    assert.deepEqual(
      historyB.entries.map((entry) => entry.message.content[0].text),
      [markerB],
    );
    unsubscribeA();
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread stop pauses and releases only confirmed idle", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const observed = { stopStarted: false, pausedAtRpc: null, fileA: null };
  const harness = fixtureHarness({
    onCommand: (receipt) => {
      if (!observed.stopStarted || receipt.type !== "get_state" || observed.pausedAtRpc !== null) return;
      observed.pausedAtRpc = JSON.parse(readFileSync(observed.fileA, "utf8")).queue_paused;
    },
  });
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
  });
  try {
    const threadA = await service.create({ workspace_id: "alpha", title: "Stop A" });
    const threadB = await service.create({ workspace_id: "alpha", title: "Stop B" });
    observed.fileA = join(workspaceDirectory, "threads", `${threadA.thread_id}.json`);
    const aId = randomUUID();
    const bId = randomUUID();
    const a2Id = randomUUID();
    assert.equal((await service.send({ workspace_id: "alpha", thread_id: threadA.thread_id, id: aId, text: "A one" })).state, "accepted");
    assert.equal((await service.send({ workspace_id: "alpha", thread_id: threadB.thread_id, id: bId, text: "B one" })).state, "queued");
    assert.equal((await service.send({ workspace_id: "alpha", thread_id: threadA.thread_id, id: a2Id, text: "A two" })).state, "queued");
    await harness.control(threadA.thread_id, {
      state: { isStreaming: true, isCompacting: false, pendingMessageCount: 2 },
    });

    const childA = harness.byThread.get(threadA.thread_id);
    const before = childA.receipts.length;
    observed.stopStarted = true;
    const stopped = await service.stop({ workspace_id: "alpha", thread_id: threadA.thread_id });
    assert.equal(stopped.stopped, true);
    assert.equal(observed.pausedAtRpc, true);
    assert.deepEqual(
      childA.receipts.slice(before).map((receipt) => receipt.type),
      ["get_state", "clear_queue", "abort", "get_state"],
    );

    await waitFor(async () =>
      (await readThread(storageRoot, "alpha", threadB.thread_id)).accepted_message_ids.includes(bId),
    );
    const aAfter = await readThread(storageRoot, "alpha", threadA.thread_id);
    assert.equal(aAfter.queue_paused, true);
    assert.deepEqual(aAfter.queue.map((item) => item.id), [a2Id]);
    assert.deepEqual(aAfter.queue.map((item) => item.state), ["queued"]);
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread stop abort unknown keeps exclusion", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  await setupWorkspace(storageRoot, "alpha");
  const clock = manualClock();
  const harness = fixtureHarness({ env: { FAKE_PI_ABORT_HANG: "1" } });
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
    clock,
  });
  try {
    const threadA = await service.create({ workspace_id: "alpha", title: "Abort A" });
    const threadB = await service.create({ workspace_id: "alpha", title: "Abort B" });
    const aId = randomUUID();
    const bId = randomUUID();
    assert.equal((await service.send({ workspace_id: "alpha", thread_id: threadA.thread_id, id: aId, text: "A" })).state, "accepted");
    assert.equal((await service.send({ workspace_id: "alpha", thread_id: threadB.thread_id, id: bId, text: "B" })).state, "queued");
    await harness.control(threadA.thread_id, {
      state: { isStreaming: true, isCompacting: false, pendingMessageCount: 2 },
    });
    const promptIds = () => harness.receipts.filter((receipt) => receipt.type === "prompt").map((receipt) => receipt.id);

    const stopPromise = service.stop({ workspace_id: "alpha", thread_id: threadA.thread_id });
    stopPromise.catch(() => {});
    await waitFor(() => clock.has(30000));
    clock.fire(30000);
    const stopped = await stopPromise;
    assert.equal(stopped.stopped, false);
    const aAfter = await readThread(storageRoot, "alpha", threadA.thread_id);
    assert.equal(aAfter.attention, "uncertain");
    assert.equal(aAfter.queue_paused, true);
    assert.deepEqual(promptIds(), [aId]);

    await harness.control(threadA.thread_id, { event: { type: "agent_end" } });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    assert.deepEqual(promptIds(), [aId]);

    await harness.control(threadA.thread_id, { event: { type: "agent_settled", aborted: true } });
    await waitFor(async () =>
      (await readThread(storageRoot, "alpha", threadB.thread_id)).accepted_message_ids.includes(bId),
    );
    assert.deepEqual(promptIds(), [aId, bId]);
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread stop close four children within five seconds", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  await setupWorkspace(storageRoot, "alpha");
  const harness = fixtureHarness({ env: { FAKE_PI_HANG: "1" } });
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
  });
  try {
    const threads = [];
    for (let index = 0; index < 4; index += 1) {
      threads.push(await service.create({ workspace_id: "alpha", title: `Close ${index}` }));
    }
    await Promise.all(
      threads.map((thread) => service.resume({ workspace_id: "alpha", thread_id: thread.thread_id })),
    );
    assert.equal(harness.children.length, 4);

    const started = Date.now();
    const closing = service.close();
    await assert.rejects(
      service.send({ workspace_id: "alpha", thread_id: threads[0].thread_id, id: randomUUID(), text: "x" }),
      { code: "service-closed" },
    );
    await closing;
    const elapsed = Date.now() - started;
    assert.ok(elapsed <= 5500, `close took ${elapsed}ms`);
    for (const child of harness.children) {
      assert.ok(child.signalCode === "SIGKILL" || child.exitCode !== null);
    }
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread failure stalled retains exclusion", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  await setupWorkspace(storageRoot, "alpha");
  const clock = manualClock();
  const harness = fixtureHarness();
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
    clock,
  });
  try {
    const threadA = await service.create({ workspace_id: "alpha", title: "Stall A" });
    const threadB = await service.create({ workspace_id: "alpha", title: "Stall B" });
    const aId = randomUUID();
    const bId = randomUUID();
    assert.equal((await service.send({ workspace_id: "alpha", thread_id: threadA.thread_id, id: aId, text: "A" })).state, "accepted");
    await service.resume({ workspace_id: "alpha", thread_id: threadB.thread_id });
    await harness.control(threadB.thread_id, { event: { type: "message_update", delta: "idle" } });
    assert.equal((await service.send({ workspace_id: "alpha", thread_id: threadB.thread_id, id: bId, text: "B" })).state, "queued");
    const seenA = [];
    service.subscribe({ workspace_id: "alpha", thread_id: threadA.thread_id }, (payload) => seenA.push(payload));
    const promptIds = () => harness.receipts.filter((receipt) => receipt.type === "prompt").map((receipt) => receipt.id);

    await waitFor(() => clock.has(600000));
    clock.fire(600000);
    await waitFor(async () => (await readThread(storageRoot, "alpha", threadA.thread_id)).attention === "stalled");
    let notice = null;
    await waitFor(() => {
      notice = seenA.find((payload) => payload.type === "notice" && payload.event?.attention === "stalled");
      return Boolean(notice);
    });
    assert.deepEqual(promptIds(), [aId]);

    await harness.control(threadA.thread_id, { event: { type: "agent_end" } });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    assert.deepEqual(promptIds(), [aId]);

    await harness.control(threadA.thread_id, { event: { type: "agent_settled", aborted: false } });
    await waitFor(async () =>
      (await readThread(storageRoot, "alpha", threadB.thread_id)).accepted_message_ids.includes(bId),
    );
    assert.deepEqual(promptIds(), [aId, bId]);
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread failure confirmed exit advances queue", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  await setupWorkspace(storageRoot, "alpha");
  const harness = fixtureHarness();
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
  });
  try {
    const threadA = await service.create({ workspace_id: "alpha", title: "Exit A" });
    const threadB = await service.create({ workspace_id: "alpha", title: "Exit B" });
    const aId = randomUUID();
    const bId = randomUUID();
    assert.equal((await service.send({ workspace_id: "alpha", thread_id: threadA.thread_id, id: aId, text: "A" })).state, "accepted");
    assert.equal((await service.send({ workspace_id: "alpha", thread_id: threadB.thread_id, id: bId, text: "B" })).state, "queued");

    const childA = harness.byThread.get(threadA.thread_id);
    assert.ok(childA, "the A fixture child must be owned");
    childA.kill("SIGKILL");

    await waitFor(async () =>
      (await readThread(storageRoot, "alpha", threadB.thread_id)).accepted_message_ids.includes(bId),
    );
    await waitFor(async () => (await readThread(storageRoot, "alpha", threadA.thread_id)).process === undefined);
    const aAfter = await readThread(storageRoot, "alpha", threadA.thread_id);
    assert.deepEqual(aAfter.accepted_message_ids, [aId]);
    const bAfter = await readThread(storageRoot, "alpha", threadB.thread_id);
    assert.deepEqual(bAfter.accepted_message_ids, [bId]);
    assert.deepEqual(bAfter.queue, []);
    assert.deepEqual(
      harness.receipts.filter((receipt) => receipt.type === "prompt").map((receipt) => receipt.id),
      [aId, bId],
    );
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread failure EOF and dialog retain exclusion", async (t) => {
  const scenarios = [
    { name: "EOF", env: { FAKE_PI_EOF_ON: "prompt" } },
    { name: "dialog", env: { FAKE_PI_EXTENSION_UI_ON: "prompt" } },
  ];
  for (const scenario of scenarios) {
    const root = await tempRoot(t);
    const storageRoot = join(root, "storage");
    await setupStorage(storageRoot);
    await setupWorkspace(storageRoot, "alpha");
    const perChild = { match: null, env: scenario.env };
    const harness = fixtureHarness({
      envFor: (args) => {
        const nameIndex = args.indexOf("--name");
        const threadId = nameIndex === -1 ? null : String(args[nameIndex + 1]).replace(/^discussion:/, "");
        return threadId === perChild.match ? perChild.env : {};
      },
    });
    const service = createDiscussionService({
      root: storageRoot,
      agentDir: join(root, "agent"),
      spawn: harness.spawnImpl,
    });
    try {
      const threadA = await service.create({ workspace_id: "alpha", title: `${scenario.name} A` });
      const threadB = await service.create({ workspace_id: "alpha", title: `${scenario.name} B` });
      perChild.match = threadA.thread_id;
      const aId = randomUUID();
      const bId = randomUUID();
      const seenA = [];
      service.subscribe({ workspace_id: "alpha", thread_id: threadA.thread_id }, (payload) => seenA.push(payload));
      const promptIds = () => harness.receipts.filter((receipt) => receipt.type === "prompt").map((receipt) => receipt.id);

      await assert.rejects(
        service.send({ workspace_id: "alpha", thread_id: threadA.thread_id, id: aId, text: "A" }),
        { code: "delivery-uncertain" },
      );
      const aAfter = await readThread(storageRoot, "alpha", threadA.thread_id);
      assert.equal(aAfter.queue[0].state, "uncertain");
      assert.equal(aAfter.attention, "uncertain");
      await waitFor(() =>
        seenA.some((payload) => payload.type === "notice" && payload.event?.attention === "uncertain"),
      );

      assert.equal((await service.send({ workspace_id: "alpha", thread_id: threadB.thread_id, id: bId, text: "B" })).state, "queued");
      assert.deepEqual(promptIds(), [aId]);

      const childA = harness.byThread.get(threadA.thread_id);
      assert.ok(childA, `the ${scenario.name} A fixture child must be owned`);
      childA.kill("SIGKILL");
      await waitFor(async () =>
        (await readThread(storageRoot, "alpha", threadB.thread_id)).accepted_message_ids.includes(bId),
      );
      assert.deepEqual(promptIds(), [aId, bId]);
    } finally {
      await service.close();
      for (const child of harness.children) {
        try {
          child.disconnect?.();
        } catch {
          // Channel already closed.
        }
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    }
  }
});

test("thread failure live orphan globally excludes new responses", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const alphaDirectory = await setupWorkspace(storageRoot, "alpha");
  const betaDirectory = await setupWorkspace(storageRoot, "beta");

  const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => {
    try {
      dummy.kill("SIGKILL");
    } catch {
      // already exited
    }
  });
  await new Promise((resolvePromise) => dummy.once("spawn", resolvePromise));
  const identity = processIdentity(dummy.pid);
  assert.ok(identity, "the dummy must expose a start identity");

  const orphan = manualRecord({
    workspaceId: "alpha",
    directory: alphaDirectory,
    overrides: { process: identity, queue_paused: true },
  });
  const mismatch = manualRecord({
    workspaceId: "alpha",
    directory: alphaDirectory,
    overrides: { process: { pid: dummy.pid, started_at: "bogus start text" }, queue_paused: true },
  });
  const target = manualRecord({ workspaceId: "beta", directory: betaDirectory });
  await publishRecord(alphaDirectory, orphan);
  await publishRecord(alphaDirectory, mismatch);
  await publishRecord(betaDirectory, target);

  const harness = fixtureHarness();
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
  });
  try {
    const bId = randomUUID();
    const bSend = await service.send({ workspace_id: "beta", thread_id: target.thread_id, id: bId, text: "B" });
    assert.equal(bSend.state, "queued");
    assert.equal(harness.calls.filter((call) => call.command === "pi").length, 0);
    assert.equal(dummy.exitCode, null);

    dummy.kill("SIGKILL");
    await new Promise((resolvePromise) => dummy.once("exit", resolvePromise));
    await service.stop({ workspace_id: "alpha", thread_id: orphan.thread_id });
    await service.stop({ workspace_id: "alpha", thread_id: mismatch.thread_id });
    await waitFor(async () =>
      (await readThread(storageRoot, "beta", target.thread_id)).accepted_message_ids.includes(bId),
    );
    assert.deepEqual(
      harness.receipts.filter((receipt) => receipt.type === "prompt").map((receipt) => receipt.id),
      [bId],
    );
    assert.ok(!(await readThread(storageRoot, "alpha", orphan.thread_id)).process);
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread failure confirmed prestart permits next thread", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const perChild = { matchA: null };
  const harness = fixtureHarness({
    envFor: (args) => {
      const nameIndex = args.indexOf("--name");
      const threadId = nameIndex === -1 ? null : String(args[nameIndex + 1]).replace(/^discussion:/, "");
      return threadId === perChild.matchA ? { FAKE_PI_STATE_ID: randomUUID() } : {};
    },
  });
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
  });
  try {
    const recordA = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
    const recordB = manualRecord({ workspaceId: "alpha", directory: workspaceDirectory });
    await publishRecord(workspaceDirectory, recordA);
    await publishRecord(workspaceDirectory, recordB);
    perChild.matchA = recordA.thread_id;
    const aId = randomUUID();
    const bId = randomUUID();
    const promptIds = () => harness.receipts.filter((receipt) => receipt.type === "prompt").map((receipt) => receipt.id);

    const aSend = service.send({ workspace_id: "alpha", thread_id: recordA.thread_id, id: aId, text: "A" });
    aSend.catch(() => {});
    await waitFor(() => harness.byThread.has(recordA.thread_id));
    const bSend = service.send({ workspace_id: "alpha", thread_id: recordB.thread_id, id: bId, text: "B" });
    bSend.catch(() => {});
    await assert.rejects(aSend, { code: "session-mismatch" });
    assert.equal((await bSend).state, "queued");
    await waitFor(async () =>
      (await readThread(storageRoot, "alpha", recordB.thread_id)).accepted_message_ids.includes(bId),
    );

    const aAfter = await readThread(storageRoot, "alpha", recordA.thread_id);
    assert.equal(aAfter.queue_paused, true);
    assert.ok(typeof aAfter.attention === "string" && aAfter.attention !== "");
    assert.deepEqual(aAfter.queue.map((item) => item.state), ["queued"]);
    assert.deepEqual(promptIds(), [bId]);

    await harness.control(recordB.thread_id, { event: { type: "agent_settled", aborted: false } });
    const b2 = randomUUID();
    await service.send({ workspace_id: "alpha", thread_id: recordB.thread_id, id: b2, text: "B2" });
    await waitFor(() => promptIds().length === 2);
    assert.deepEqual(promptIds(), [bId, b2]);
    assert.equal((await readThread(storageRoot, "alpha", recordA.thread_id)).queue_paused, true);
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread global scheduler bounded children evicts confirmed idle LRU", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  await setupWorkspace(storageRoot, "alpha");
  const clock = manualClock();
  const harness = fixtureHarness();
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
    clock,
  });
  try {
    const threads = [];
    for (let index = 0; index < 4; index += 1) {
      threads.push(await service.create({ workspace_id: "alpha", title: `Cap ${index}` }));
      clock.advance(1000);
      await service.resume({ workspace_id: "alpha", thread_id: threads[index].thread_id });
      clock.advance(1000);
    }
    assert.equal(harness.children.length, 4);

    const firstThread = threads[0];
    const secondThread = threads[1];
    await harness.control(firstThread.thread_id, {
      state: { isStreaming: true, isCompacting: false, pendingMessageCount: 0 },
    });

    const fifth = await service.create({ workspace_id: "alpha", title: "Cap 4" });
    await service.resume({ workspace_id: "alpha", thread_id: fifth.thread_id });
    const secondChild = harness.byThread.get(secondThread.thread_id);
    await waitFor(() => secondChild.exitCode !== null || secondChild.signalCode !== null);
    assert.equal(harness.children.length, 5);
    assert.equal(
      harness.children.filter((child) => child.exitCode === null && child.signalCode === null).length,
      4,
    );

    for (const thread of [firstThread, ...threads.slice(2), fifth]) {
      await harness.control(thread.thread_id, {
        state: { isStreaming: true, isCompacting: false, pendingMessageCount: 0 },
      });
    }
    const sixth = await service.create({ workspace_id: "alpha", title: "Cap 5" });
    await assert.rejects(service.resume({ workspace_id: "alpha", thread_id: sixth.thread_id }), {
      code: "child-limit",
    });
    assert.equal(harness.children.length, 5);
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread failure idle expiry closes only confirmed idle", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const clock = manualClock();
  const harness = fixtureHarness();
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
    clock,
  });
  try {
    const threadA = await service.create({ workspace_id: "alpha", title: "Idle A" });
    const threadB = await service.create({ workspace_id: "alpha", title: "Idle B" });
    const threadC = await service.create({ workspace_id: "alpha", title: "Idle C" });
    const threadD = await service.create({ workspace_id: "alpha", title: "Idle D" });
    await service.resume({ workspace_id: "alpha", thread_id: threadA.thread_id });
    await service.resume({ workspace_id: "alpha", thread_id: threadB.thread_id });
    await service.resume({ workspace_id: "alpha", thread_id: threadC.thread_id });
    await service.resume({ workspace_id: "alpha", thread_id: threadD.thread_id });
    const stoppedD = await service.stop({ workspace_id: "alpha", thread_id: threadD.thread_id });
    assert.equal(stoppedD.stopped, true);
    await harness.control(threadA.thread_id, {
      state: { isStreaming: true, isCompacting: false, pendingMessageCount: 0 },
    });
    const cFile = join(workspaceDirectory, "threads", `${threadC.thread_id}.json`);
    const cRecord = JSON.parse(await readFile(cFile, "utf8"));
    await writeFile(cFile, `${JSON.stringify({ ...cRecord, attention: "uncertain" })}\n`);

    assert.equal(harness.children.length, 4);
    await waitFor(() => clock.has(600000));
    clock.fire(600000);
    const childB = harness.byThread.get(threadB.thread_id);
    await waitFor(() => childB.exitCode !== null || childB.signalCode !== null);
    const childD = harness.byThread.get(threadD.thread_id);
    await waitFor(() => childD.exitCode !== null || childD.signalCode !== null);
    const childA = harness.byThread.get(threadA.thread_id);
    const childC = harness.byThread.get(threadC.thread_id);
    assert.equal(childA.exitCode, null);
    assert.equal(childC.exitCode, null);
    assert.equal(harness.children.length, 4);
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread global scheduler stale generation cannot release new lease", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  await setupWorkspace(storageRoot, "alpha");
  const harness = fixtureHarness();
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
  });
  try {
    const threadA = await service.create({ workspace_id: "alpha", title: "Stale A" });
    const threadB = await service.create({ workspace_id: "alpha", title: "Stale B" });
    const aId = randomUUID();
    const bId = randomUUID();
    const promptIds = () => harness.receipts.filter((receipt) => receipt.type === "prompt").map((receipt) => receipt.id);

    assert.equal(
      (await service.send({ workspace_id: "alpha", thread_id: threadA.thread_id, id: aId, text: "A1" })).state,
      "accepted",
    );
    const oldChild = harness.byThread.get(threadA.thread_id);
    assert.ok(oldChild, "the old A child must be captured");
    oldChild.kill("SIGKILL");
    await waitFor(async () => (await readThread(storageRoot, "alpha", threadA.thread_id)).process === undefined);

    const a2Id = randomUUID();
    const a2Send = await service.send({ workspace_id: "alpha", thread_id: threadA.thread_id, id: a2Id, text: "A2" });
    assert.ok(a2Send.state === "queued" || a2Send.state === "accepted");
    // Exit publishes process removal before releasing the response lease.
    // Observe acceptance rather than requiring send to win that race.
    await waitFor(async () =>
      (await readThread(storageRoot, "alpha", threadA.thread_id)).accepted_message_ids.includes(a2Id),
    );
    const newChild = harness.byThread.get(threadA.thread_id);
    assert.notEqual(newChild, oldChild);
    assert.equal(
      (await service.send({ workspace_id: "alpha", thread_id: threadB.thread_id, id: bId, text: "B" })).state,
      "queued",
    );
    assert.deepEqual(promptIds(), [aId, a2Id]);

    oldChild.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "agent_settled", aborted: true })}\n`));
    oldChild.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "message_update", delta: "stale \u2028 delta" })}\n`),
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    assert.deepEqual(promptIds(), [aId, a2Id]);
    const listed = await service.list({ workspace_id: "alpha" });
    const aRecord = listed.threads.find((record) => record.thread_id === threadA.thread_id);
    assert.equal(aRecord.partial, "");

    await harness.control(threadA.thread_id, { event: { type: "agent_settled", aborted: false } });
    await waitFor(async () =>
      (await readThread(storageRoot, "alpha", threadB.thread_id)).accepted_message_ids.includes(bId),
    );
    assert.deepEqual(promptIds(), [aId, a2Id, bId]);
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread global scheduler handled requires confirmed idle", async (t) => {
  {
    const root = await tempRoot(t);
    const storageRoot = join(root, "storage");
    await setupStorage(storageRoot);
    await setupWorkspace(storageRoot, "alpha");
    const harness = fixtureHarness({ env: { FAKE_PI_DISPOSITION: "handled" } });
    const service = createDiscussionService({
      root: storageRoot,
      agentDir: join(root, "agent"),
      spawn: harness.spawnImpl,
    });
    try {
      const threadA = await service.create({ workspace_id: "alpha", title: "Handled A" });
      const threadB = await service.create({ workspace_id: "alpha", title: "Handled B" });
      const aId = randomUUID();
      const bId = randomUUID();
      assert.equal(
        (await service.send({ workspace_id: "alpha", thread_id: threadA.thread_id, id: aId, text: "A" })).state,
        "accepted",
      );
      const bSend = await service.send({ workspace_id: "alpha", thread_id: threadB.thread_id, id: bId, text: "B" });
      assert.ok(bSend.state === "queued" || bSend.state === "accepted");
      await waitFor(async () =>
        (await readThread(storageRoot, "alpha", threadB.thread_id)).accepted_message_ids.includes(bId),
      );
      assert.deepEqual(
        harness.receipts.filter((receipt) => receipt.type === "prompt").map((receipt) => receipt.id),
        [aId, bId],
      );
    } finally {
      await service.close();
      for (const child of harness.children) {
        try {
          child.disconnect?.();
        } catch {
          // Channel already closed.
        }
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    }
  }

  {
    const root = await tempRoot(t);
    const storageRoot = join(root, "storage");
    await setupStorage(storageRoot);
    await setupWorkspace(storageRoot, "alpha");
    const harness = fixtureHarness({ env: { FAKE_PI_DISPOSITION: "handled" } });
    const service = createDiscussionService({
      root: storageRoot,
      agentDir: join(root, "agent"),
      spawn: harness.spawnImpl,
    });
    try {
      const threadA = await service.create({ workspace_id: "alpha", title: "Handled C" });
      const threadB = await service.create({ workspace_id: "alpha", title: "Handled D" });
      const aId = randomUUID();
      const bId = randomUUID();
      const promptIds = () => harness.receipts.filter((receipt) => receipt.type === "prompt").map((receipt) => receipt.id);
      await service.resume({ workspace_id: "alpha", thread_id: threadA.thread_id });
      await harness.control(threadA.thread_id, {
        state: { isStreaming: false, isCompacting: true, pendingMessageCount: 1 },
      });
      const aSend = await service.send({ workspace_id: "alpha", thread_id: threadA.thread_id, id: aId, text: "A" });
      assert.ok(aSend.state === "queued" || aSend.state === "accepted");
      await waitFor(async () =>
        (await readThread(storageRoot, "alpha", threadA.thread_id)).accepted_message_ids.includes(aId),
      );
      assert.equal(
        (await service.send({ workspace_id: "alpha", thread_id: threadB.thread_id, id: bId, text: "B" })).state,
        "queued",
      );
      await harness.control(threadA.thread_id, { event: { type: "agent_end" } });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
      assert.deepEqual(promptIds(), [aId]);

      await harness.control(threadA.thread_id, {
        state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
      });
      await harness.control(threadA.thread_id, { event: { type: "agent_settled", aborted: false } });
      await waitFor(async () =>
        (await readThread(storageRoot, "alpha", threadB.thread_id)).accepted_message_ids.includes(bId),
      );
      assert.deepEqual(promptIds(), [aId, bId]);
    } finally {
      await service.close();
      for (const child of harness.children) {
        try {
          child.disconnect?.();
        } catch {
          // Channel already closed.
        }
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    }
  }
});

test("thread failure rejected prompt visible no auto retry", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  await setupWorkspace(storageRoot, "alpha");
  const perChild = { matchA: null };
  const harness = fixtureHarness({
    envFor: (args) => {
      const nameIndex = args.indexOf("--name");
      const threadId = nameIndex === -1 ? null : String(args[nameIndex + 1]).replace(/^discussion:/, "");
      return threadId === perChild.matchA ? { FAKE_PI_FAIL_ON: "prompt" } : {};
    },
  });
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
  });
  try {
    const threadA = await service.create({ workspace_id: "alpha", title: "Reject A" });
    const threadB = await service.create({ workspace_id: "alpha", title: "Reject B" });
    perChild.matchA = threadA.thread_id;
    const aId = randomUUID();
    const bId = randomUUID();
    await assert.rejects(
      service.send({ workspace_id: "alpha", thread_id: threadA.thread_id, id: aId, text: "A" }),
      { code: "delivery-uncertain" },
    );
    const aAfter = await readThread(storageRoot, "alpha", threadA.thread_id);
    assert.equal(aAfter.queue.length, 1);
    assert.equal(aAfter.queue[0].state, "queued");
    assert.equal(aAfter.queue_paused, true);
    assert.equal(aAfter.attention, "prompt-failed");

    assert.equal(
      (await service.send({ workspace_id: "alpha", thread_id: threadB.thread_id, id: bId, text: "B" })).state,
      "queued",
    );
    await waitFor(async () =>
      (await readThread(storageRoot, "alpha", threadB.thread_id)).accepted_message_ids.includes(bId),
    );
    assert.deepEqual(
      harness.receipts.filter((receipt) => receipt.type === "prompt").map((receipt) => receipt.id),
      [aId, bId],
    );
    assert.equal((await readThread(storageRoot, "alpha", threadA.thread_id)).queue_paused, true);
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread handoff save publishes one material and one handoff", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const record = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: {
      queue: [
        {
          id: randomUUID(),
          text: "queued",
          queued_at: "2026-01-01T00:00:00.000Z",
          state: "queued",
          attempt: 0,
        },
      ],
      import: {
        source: "adj7",
        digest: "f".repeat(64),
        imported_at: "2026-01-01T00:00:00.000Z",
        adjacent: { authority: "none", provenance: { kept: true } },
      },
      custom: { kept: true },
    },
  });
  await publishRecord(workspaceDirectory, record);
  const harness = fixtureHarness();
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
  });
  try {
    const requestId = randomUUID();
    const [first, second] = await Promise.all([
      service.saveBrief({ workspace_id: "alpha", thread_id: record.thread_id, request_id: requestId, title: "Title", content: "body\n" }),
      service.saveBrief({ workspace_id: "alpha", thread_id: record.thread_id, request_id: requestId, title: "Title", content: "body\n" }),
    ]);
    assert.equal(first.brief, second.brief);
    assert.match(first.brief, /^briefs\/brief-[0-9a-f]{64}\.md$/);
    assert.equal(await readFile(join(workspaceDirectory, first.brief), "utf8"), "# Title\n\nbody\n");
    const after = await readThread(storageRoot, "alpha", record.thread_id);
    assert.equal(after.handoffs.length, 1);
    assert.equal(after.handoffs[0].request_id, requestId);
    assert.equal(after.handoffs[0].brief, first.brief);
    assert.deepEqual(after.custom, { kept: true });
    assert.deepEqual(after.import.adjacent.provenance, { kept: true });
    assert.equal(after.queue.length, 1);
    assert.equal(after.queue[0].text, "queued");
    assert.equal((await readdir(join(workspaceDirectory, "briefs"))).filter((name) => name.endsWith(".md")).length, 1);
    assert.equal(harness.calls.filter((call) => call.command === "pi").length, 0);

    await assert.rejects(
      service.saveBrief({ workspace_id: "alpha", thread_id: record.thread_id, request_id: requestId, title: "Other", content: "changed\n" }),
      { code: "request-conflict" },
    );
    assert.equal(await readFile(join(workspaceDirectory, first.brief), "utf8"), "# Title\n\nbody\n");
    assert.equal((await readThread(storageRoot, "alpha", record.thread_id)).handoffs.length, 1);
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread handoff save converges after a material before handoff crash", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  await setupWorkspace(storageRoot, "alpha");
  const requestId = randomUUID();
  const crashed = await addMaterial(storageRoot, "alpha", {
    kind: "brief",
    title: "Title",
    content: "body\n",
    request_id: requestId,
  });
  const harness = fixtureHarness();
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
  });
  let threadId = null;
  try {
    const thread = await service.create({ workspace_id: "alpha", title: "Crash residue" });
    threadId = thread.thread_id;
    const recovered = await service.saveBrief({
      workspace_id: "alpha",
      thread_id: threadId,
      request_id: requestId,
      title: "Title",
      content: "body\n",
    });
    assert.equal(recovered.brief, crashed.path);
    assert.equal(recovered.duplicate, false);
    assert.equal(recovered.thread.handoffs.length, 1);
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }

  const restartHarness = fixtureHarness();
  const restarted = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: restartHarness.spawnImpl,
  });
  try {
    const repeat = await restarted.saveBrief({
      workspace_id: "alpha",
      thread_id: threadId,
      request_id: requestId,
      title: "Title",
      content: "body\n",
    });
    assert.equal(repeat.brief, crashed.path);
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.thread.handoffs.length, 1);
  } finally {
    await restarted.close();
    for (const child of restartHarness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread handoff preview matches the canonical assignment resolution", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const binDirectory = join(root, "bin");
  await mkdir(binDirectory, { recursive: true });
  const piPath = join(binDirectory, "pi");
  await writeFile(piPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(piPath, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDirectory}${delimiter}${savedPath}`;
  t.after(() => {
    process.env.PATH = savedPath;
  });

  const harness = fixtureHarness();
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: harness.spawnImpl,
  });
  try {
    const thread = await service.create({ workspace_id: "alpha", title: "Preview" });
    const requestId = randomUUID();
    const saved = await service.saveBrief({
      workspace_id: "alpha",
      thread_id: thread.thread_id,
      request_id: requestId,
      title: "Title",
      content: "body\n",
    });
    const assignmentId = randomUUID();
    const instructions = "Deliver the preview.";
    const preview = await service.previewAssignment({
      workspace_id: "alpha",
      thread_id: thread.thread_id,
      request_id: requestId,
      assignment_id: assignmentId,
      instructions,
    });
    const oracle = await resolveAssignment({
      storageRoot,
      workspace_id: "alpha",
      assignment_id: assignmentId,
      brief: saved.brief,
      instructions,
      skill: "general",
      target: null,
    });
    assert.equal(preview.contractDigest, oracle.contractDigest);
    assert.deepEqual(preview.piArgs, oracle.piArgs);
    assert.deepEqual(preview.briefBytes, oracle.briefBytes);
    assert.equal(preview.record.assignment_id, assignmentId);
    assert.equal(preview.record.workspace_id, "alpha");
    assert.equal(preview.record.brief, saved.brief);
    assert.equal(preview.record.execution_dir, thread.execution_dir);
    assert.equal(preview.record.brief_sha256, oracle.record.brief_sha256);
    await assert.rejects(lstat(join(workspaceDirectory, "assignments")), { code: "ENOENT" });
    await assert.rejects(lstat(join(storageRoot, ".sentinel")), { code: "ENOENT" });
    assert.equal(harness.calls.filter((call) => call.command === "pi").length, 0);

    await assert.rejects(
      service.previewAssignment({
        workspace_id: "alpha",
        thread_id: thread.thread_id,
        request_id: randomUUID(),
        assignment_id: randomUUID(),
        instructions,
      }),
      { code: "brief-not-found" },
    );
    for (const override of ["root", "brief", "target", "adapters"]) {
      await assert.rejects(
        service.previewAssignment({
          workspace_id: "alpha",
          thread_id: thread.thread_id,
          request_id: requestId,
          assignment_id: randomUUID(),
          instructions,
          [override]: "x",
        }),
        { code: "invalid-handoff" },
      );
    }
    await service.close();
    await assert.rejects(
      service.saveBrief({
        workspace_id: "alpha",
        thread_id: thread.thread_id,
        request_id: randomUUID(),
        title: "Title",
        content: "body\n",
      }),
      { code: "service-closed" },
    );
    await assert.rejects(
      service.previewAssignment({
        workspace_id: "alpha",
        thread_id: thread.thread_id,
        request_id: requestId,
        assignment_id: randomUUID(),
        instructions,
      }),
      { code: "service-closed" },
    );
  } finally {
    await service.close();
    for (const child of harness.children) {
      try {
        child.disconnect?.();
      } catch {
        // Channel already closed.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("thread handoff launch links the durable assignment without owning tmux", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const binDirectory = join(root, "bin");
  await mkdir(binDirectory, { recursive: true });
  const piPath = join(binDirectory, "pi");
  await writeFile(piPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(piPath, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDirectory}${delimiter}${savedPath}`;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  const dummy = dummyProcess(t);
  const tmux = tmuxHarness({ dummyPid: dummy.pid });
  const makeService = () =>
    createDiscussionService({
      root: storageRoot,
      agentDir: join(root, "agent"),
      assignmentAdapters: {
        tmuxRun: tmux.run,
        observationProbes: {
          tmuxRun: tmux.run,
          psRun: () => ({ stdout: "", complete: true }),
        },
      },
    });

  const instructions = "Deliver the handoff.";
  const requestId = randomUUID();
  const assignmentId = randomUUID();
  let threadId = null;
  let previewDigest = null;
  const launchInput = () => ({
    workspace_id: "alpha",
    thread_id: threadId,
    request_id: requestId,
    assignment_id: assignmentId,
    expectedDigest: previewDigest,
    instructions,
  });

  const service = makeService();
  try {
    const thread = await service.create({ workspace_id: "alpha", title: "Handoff launch" });
    threadId = thread.thread_id;
    await mkdir(join(workspaceDirectory, 'notes'), { recursive: true });
    await writeFile(join(workspaceDirectory, 'notes', 'context.md'), '# Selected context\nUse this exact source.\n');
    const suggestions = await service.suggestions({ workspace_id: 'alpha', thread_id: threadId, kind: 'file', query: 'context.md' });
    const reference = { kind: 'file', id: suggestions.items[0].id };
    const saved = await service.saveBrief({
      workspace_id: "alpha",
      thread_id: threadId,
      request_id: requestId,
      title: "Title",
      content: "body\n",
      references: [reference],
    });
    const preview = await service.previewAssignment({
      workspace_id: "alpha",
      thread_id: threadId,
      request_id: requestId,
      assignment_id: assignmentId,
      instructions,
    });
    previewDigest = preview.contractDigest;
    assert.equal(preview.record.execution_dir, workspaceDirectory);

    const launched = await service.launchAssignment(launchInput());
    assert.equal(launched.assignment.assignment_id, assignmentId);
    assert.equal(launched.assignment.state, "live");
    assert.equal(launched.assignment.brief, saved.brief);
    assert.equal(launched.assignment.execution_dir, workspaceDirectory);
    assert.equal(launched.assignment.pi_identity.pid, dummy.pid);
    assert.equal(launched.observation.state, "live");
    assert.equal(launched.handoff.assignment_id, assignmentId);
    assert.equal(tmux.newSessionCount(), 1);

    const stored = await findAssignment(storageRoot, assignmentId);
    assert.equal(stored.assignment_id, assignmentId);
    assert.equal(stored.state, "live");
    const launchedSnapshot = await readFile(join(workspaceDirectory, "assignments", `${assignmentId}.brief.md`), "utf8");
    assert.equal(launchedSnapshot, preview.briefBytes.toString('utf8'));
    assert.match(launchedSnapshot, /^# Title\n\nbody\n/);
    assert.match(launchedSnapshot, /# Selected context\nUse this exact source/);
    assert.equal(stored.context_references[0].id, reference.id);
    assert.deepEqual(
      (await readdir(join(workspaceDirectory, "assignments"))).filter((name) => name.endsWith(".json")),
      [`${assignmentId}.json`],
    );

    const repeat = await service.launchAssignment(launchInput());
    assert.equal(repeat.assignment.assignment_id, assignmentId);
    assert.equal(repeat.assignment.state, "live");
    assert.equal(repeat.handoff.assignment_id, assignmentId);
    assert.equal(tmux.newSessionCount(), 1);

    await assert.rejects(
      service.launchAssignment({ ...launchInput(), assignment_id: randomUUID() }),
      { code: "request-conflict" },
    );
  } finally {
    await service.close();
  }

  // Service close must leave the assignment's tmux work untouched.
  assert.equal(tmux.newSessionCount(), 1);
  assert.equal(tmux.destructiveCount(), 0);
  assert.equal(dummy.exitCode, null);
  assert.doesNotThrow(() => process.kill(dummy.pid, 0));

  const restarted = makeService();
  try {
    const repeat = await restarted.launchAssignment(launchInput());
    assert.equal(repeat.assignment.assignment_id, assignmentId);
    assert.equal(repeat.handoff.assignment_id, assignmentId);
    assert.equal(tmux.newSessionCount(), 1);

    // Assignment-published but handoff-unlinked crash: removing only the
    // durable handoff assignment_id must relink on the same-ID launch.
    const threadFile = join(workspaceDirectory, "threads", `${threadId}.json`);
    const unlinked = JSON.parse(await readFile(threadFile, "utf8"));
    delete unlinked.handoffs[0].assignment_id;
    await writeFile(threadFile, `${JSON.stringify(unlinked)}\n`);

    const relinked = await restarted.launchAssignment(launchInput());
    assert.equal(relinked.assignment.assignment_id, assignmentId);
    assert.equal(relinked.handoff.assignment_id, assignmentId);
    assert.equal(tmux.newSessionCount(), 1);
    assert.equal((await findAssignment(storageRoot, assignmentId)).assignment_id, assignmentId);
    assert.deepEqual(
      (await readdir(join(workspaceDirectory, "assignments"))).filter((name) => name.endsWith(".json")),
      [`${assignmentId}.json`],
    );
    const persisted = JSON.parse(await readFile(threadFile, "utf8"));
    assert.equal(persisted.handoffs[0].assignment_id, assignmentId);
  } finally {
    await restarted.close();
  }
});

test("thread handoff launch refuses stale preview after brief bytes change", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const binDirectory = join(root, "bin");
  await mkdir(binDirectory, { recursive: true });
  const piPath = join(binDirectory, "pi");
  await writeFile(piPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(piPath, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDirectory}${delimiter}${savedPath}`;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  const tmux = tmuxHarness();
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    assignmentAdapters: { tmuxRun: tmux.run },
  });
  try {
    const thread = await service.create({ workspace_id: "alpha", title: "Stale brief" });
    const requestId = randomUUID();
    const assignmentId = randomUUID();
    const instructions = "Deliver the handoff.";
    const saved = await service.saveBrief({
      workspace_id: "alpha",
      thread_id: thread.thread_id,
      request_id: requestId,
      title: "Title",
      content: "body\n",
    });
    const preview = await service.previewAssignment({
      workspace_id: "alpha",
      thread_id: thread.thread_id,
      request_id: requestId,
      assignment_id: assignmentId,
      instructions,
    });
    await writeFile(join(workspaceDirectory, saved.brief), "# Title\n\nchanged bytes\n");
    await assert.rejects(
      service.launchAssignment({
        workspace_id: "alpha",
        thread_id: thread.thread_id,
        request_id: requestId,
        assignment_id: assignmentId,
        expectedDigest: preview.contractDigest,
        instructions,
      }),
      { code: "stale-preview" },
    );
    assert.equal(tmux.calls.length, 0);
    await assert.rejects(lstat(join(workspaceDirectory, "assignments")), { code: "ENOENT" });
  } finally {
    await service.close();
  }
});

test("thread handoff launch refuses stale preview after repository rebinding", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const first = await makeRepo(join(root, "repos", "first"));
  const second = await makeRepo(join(root, "repos", "second"));
  const workspaceDirectory = await setupWorkspace(storageRoot, "repo-ws", [{ id: "app", path: first }]);
  const binDirectory = join(root, "bin");
  await mkdir(binDirectory, { recursive: true });
  const piPath = join(binDirectory, "pi");
  await writeFile(piPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(piPath, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDirectory}${delimiter}${savedPath}`;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  const tmux = tmuxHarness();
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    assignmentAdapters: { tmuxRun: tmux.run },
  });
  try {
    const thread = await service.create({
      workspace_id: "repo-ws",
      title: "Rebound repository",
      target: { kind: "repository", repository_id: "app" },
    });
    assert.equal(thread.execution_dir, first);
    const requestId = randomUUID();
    const assignmentId = randomUUID();
    const instructions = "Deliver the handoff.";
    await service.saveBrief({
      workspace_id: "repo-ws",
      thread_id: thread.thread_id,
      request_id: requestId,
      title: "Title",
      content: "body\n",
    });
    const preview = await service.previewAssignment({
      workspace_id: "repo-ws",
      thread_id: thread.thread_id,
      request_id: requestId,
      assignment_id: assignmentId,
      instructions,
    });
    assert.equal(preview.record.execution_dir, first);

    await writeFile(
      join(workspaceDirectory, "kit.yaml"),
      kitYaml({ id: "repo-ws", name: "repo-ws", repositories: [{ id: "app", path: second }] }),
    );
    await assert.rejects(
      service.launchAssignment({
        workspace_id: "repo-ws",
        thread_id: thread.thread_id,
        request_id: requestId,
        assignment_id: assignmentId,
        expectedDigest: preview.contractDigest,
        instructions,
      }),
      { code: "stale-preview" },
    );
    assert.equal(tmux.calls.length, 0);
    await assert.rejects(lstat(join(workspaceDirectory, "assignments")), { code: "ENOENT" });
  } finally {
    await service.close();
  }
});

test("thread handoff worktree target launches into the registered repository", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const primary = await makeRepo(join(root, "repos", "primary"));
  const worktreePath = join(root, "repos", "linked");
  await git(primary, ["worktree", "add", "--quiet", worktreePath]);
  const linked = await realpath(worktreePath);
  await setupWorkspace(storageRoot, "wt-ws", [
    { id: "app", path: primary },
    { id: "app-linked", path: linked },
  ]);
  const binDirectory = join(root, "bin");
  await mkdir(binDirectory, { recursive: true });
  const piPath = join(binDirectory, "pi");
  await writeFile(piPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(piPath, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDirectory}${delimiter}${savedPath}`;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  const dummy = dummyProcess(t);
  const tmux = tmuxHarness({ dummyPid: dummy.pid });
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    assignmentAdapters: {
      tmuxRun: tmux.run,
      observationProbes: {
        tmuxRun: tmux.run,
        psRun: () => ({ stdout: "", complete: true }),
      },
    },
  });
  try {
    const thread = await service.create({
      workspace_id: "wt-ws",
      title: "Registered worktree",
      target: { kind: "worktree", path: linked },
    });
    assert.equal(thread.execution_dir, linked);
    assert.equal(thread.attention, null);
    const requestId = randomUUID();
    const assignmentId = randomUUID();
    const instructions = "Deliver the worktree handoff.";
    await service.saveBrief({
      workspace_id: "wt-ws",
      thread_id: thread.thread_id,
      request_id: requestId,
      title: "Title",
      content: "body\n",
    });
    const preview = await service.previewAssignment({
      workspace_id: "wt-ws",
      thread_id: thread.thread_id,
      request_id: requestId,
      assignment_id: assignmentId,
      instructions,
    });
    assert.equal(preview.record.execution_dir, linked);
    assert.equal(preview.record.repository_id, "app-linked");

    const launched = await service.launchAssignment({
      workspace_id: "wt-ws",
      thread_id: thread.thread_id,
      request_id: requestId,
      assignment_id: assignmentId,
      expectedDigest: preview.contractDigest,
      instructions,
    });
    assert.equal(launched.assignment.execution_dir, linked);
    assert.equal(launched.assignment.repository_id, "app-linked");
    assert.equal(tmux.newSessionCount(), 1);
    const session = tmux.calls.find((call) => call.args.includes("new-session"));
    assert.equal(session.args[session.args.indexOf("-c") + 1], linked);
  } finally {
    await service.close();
  }
  assert.equal(dummy.exitCode, null);
  assert.equal(tmux.destructiveCount(), 0);
});

test("worktree target binds to a repository declared with a ~/ path", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const primary = await makeRepo(join(root, "repos", "primary"));
  const worktreePath = join(root, "repos", "linked");
  await git(primary, ["worktree", "add", "--quiet", worktreePath]);
  const linked = await realpath(worktreePath);
  await setupWorkspace(storageRoot, "home-ws", [
    { id: "app", path: primary },
    { id: "app-linked", path: "~/repos/linked" },
  ]);
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    const thread = await service.create({
      workspace_id: "home-ws",
      title: "Home-relative worktree",
      target: { kind: "worktree", path: linked },
    });
    assert.equal(thread.attention, null);
    assert.equal(thread.execution_dir, linked);
  } finally {
    await service.close();
  }
});

test("thread handoff refuses a Git worktree with no registered repository", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const primary = await makeRepo(join(root, "repos", "primary"));
  const worktreePath = join(root, "repos", "extra");
  await git(primary, ["worktree", "add", "--quiet", worktreePath]);
  const linked = await realpath(worktreePath);
  const workspaceDirectory = await setupWorkspace(storageRoot, "wt-ws", [{ id: "app", path: primary }]);
  const binDirectory = join(root, "bin");
  await mkdir(binDirectory, { recursive: true });
  const piPath = join(binDirectory, "pi");
  await writeFile(piPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(piPath, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDirectory}${delimiter}${savedPath}`;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  const tmux = tmuxHarness();
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    assignmentAdapters: { tmuxRun: tmux.run },
  });
  try {
    assert.equal((await git(linked, ["rev-parse", "--is-inside-work-tree"])).trim(), "true");
    const thread = await service.create({
      workspace_id: "wt-ws",
      title: "Unregistered worktree",
      target: { kind: "worktree", path: linked },
    });
    assert.equal(thread.attention, "missing-directory");
    assert.equal(thread.execution_dir, linked);
    assert.notEqual(thread.execution_dir, workspaceDirectory);
    const requestId = randomUUID();
    const instructions = "Deliver the handoff.";
    await service.saveBrief({
      workspace_id: "wt-ws",
      thread_id: thread.thread_id,
      request_id: requestId,
      title: "Title",
      content: "body\n",
    });
    await assert.rejects(
      service.previewAssignment({
        workspace_id: "wt-ws",
        thread_id: thread.thread_id,
        request_id: requestId,
        assignment_id: randomUUID(),
        instructions,
      }),
      /worktree target has no unique recorded repository/,
    );
    await assert.rejects(
      service.launchAssignment({
        workspace_id: "wt-ws",
        thread_id: thread.thread_id,
        request_id: requestId,
        assignment_id: randomUUID(),
        expectedDigest: "0".repeat(64),
        instructions,
      }),
      /worktree target has no unique recorded repository/,
    );
    assert.equal(tmux.calls.length, 0);
    await assert.rejects(lstat(join(workspaceDirectory, "assignments")), { code: "ENOENT" });
    const stored = JSON.parse(
      await readFile(join(workspaceDirectory, "threads", `${thread.thread_id}.json`), "utf8"),
    );
    assert.equal(stored.handoffs[0].assignment_id, undefined);
    assert.deepEqual(stored.target, { kind: "worktree", path: linked });
  } finally {
    await service.close();
  }
});
