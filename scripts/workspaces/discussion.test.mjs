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
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { processIdentity } from "../spec-observe/process-identity.mjs";
import { createDiscussionService, readThread, validateThread } from "./discussion.mjs";
import { createWorkspace, setupStorage } from "./store.mjs";

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
    context: [],
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
    const record = await service.create({ workspace_id: "alpha", title: "First thread", context: ["notes/a.md"] });
    assert.equal(record.schema_version, 1);
    assert.match(record.thread_id, UUID_RE);
    assert.equal(record.session_id, record.thread_id);
    assert.equal(record.workspace_id, "alpha");
    assert.equal(record.title, "First thread");
    assert.deepEqual(record.target, { kind: "workspace" });
    assert.equal(record.execution_dir, workspaceDirectory);
    assert.equal(record.session_dir, join(workspaceDirectory, "sessions", record.thread_id));
    assert.equal(record.session_file, null);
    assert.deepEqual(record.context, ["notes/a.md"]);
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
    ["context non-string", { context: [1] }],
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

test("thread record context references are stored without writes", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha");
  const service = createDiscussionService({ root: storageRoot, agentDir: join(root, "agent") });
  try {
    const kitBefore = await readFile(join(workspaceDirectory, "kit.yaml"));
    const listingBefore = (await readdir(workspaceDirectory)).sort();
    const references = ["notes/missing.md", "briefs/also-missing.md"];
    const record = await service.create({ workspace_id: "alpha", title: "Context refs", context: references });
    assert.deepEqual(record.context, references);
    await assert.rejects(lstat(join(workspaceDirectory, "notes", "missing.md")), { code: "ENOENT" });
    assert.deepEqual(await readFile(join(workspaceDirectory, "kit.yaml")), kitBefore);
    assert.deepEqual(
      (await readdir(workspaceDirectory)).sort(),
      [...listingBefore, "sessions", "threads"].sort(),
    );
  } finally {
    service.close();
  }
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
  await setupWorkspace(storageRoot, "repo-ws", [{ id: "app", path: primary }]);
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

    const unregistered = join(root, "repos", "plain");
    await mkdir(unregistered, { recursive: true });
    const missing = await service.create({
      workspace_id: "repo-ws",
      title: "Unregistered worktree",
      target: { kind: "worktree", path: unregistered },
    });
    assert.equal(missing.attention, "missing-directory");
    assert.equal(missing.execution_dir, unregistered);
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

test("thread preservation resume assembles context and refuses invalid references", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspaceDirectory = await setupWorkspace(storageRoot, "alpha", [], ["notes/current.md"]);
  await mkdir(join(workspaceDirectory, "notes"), { recursive: true });
  await writeFile(join(workspaceDirectory, "notes", "current.md"), "current kit context\n");
  await mkdir(join(workspaceDirectory, "briefs"), { recursive: true });
  await writeFile(join(workspaceDirectory, "briefs", "selected.md"), "selected material\n");

  const sourceSession = join(root, "imported-source.jsonl");
  await writeFile(sourceSession, sessionLines(randomUUID(), workspaceDirectory, ["source only"]));
  const snapshots = {
    kit: await readFile(join(workspaceDirectory, "kit.yaml")),
    notes: await readFile(join(workspaceDirectory, "notes", "current.md")),
    selected: await readFile(join(workspaceDirectory, "briefs", "selected.md")),
    source: await readFile(sourceSession),
  };
  const record = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: {
      context: ["briefs/selected.md"],
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
    assert.deepEqual(resumed.import.adjacent.provenance.nested.kept, [1, 2, 3]);
    assert.deepEqual(resumed.custom, { anything: { deeper: true } });
    const piCall = harness.calls.find((call) => call.command === "pi");
    assert.ok(piCall, "the Pi child is spawned after context assembly");
    const flagIndex = piCall.args.indexOf("--append-system-prompt");
    assert.ok(flagIndex !== -1);
    const assembled = piCall.args[flagIndex + 1];
    assert.ok(assembled.includes("--- notes/current.md ---"));
    assert.ok(assembled.includes("current kit context"));
    assert.ok(assembled.includes("--- briefs/selected.md ---"));
    assert.ok(assembled.includes("selected material"));
  } finally {
    await service.close();
  }
  await waitFor(async () => (await readThread(storageRoot, "alpha", record.thread_id)).process === undefined);
  assert.deepEqual(await readFile(join(workspaceDirectory, "kit.yaml")), snapshots.kit);
  assert.deepEqual(await readFile(join(workspaceDirectory, "notes", "current.md")), snapshots.notes);
  assert.deepEqual(await readFile(join(workspaceDirectory, "briefs", "selected.md")), snapshots.selected);
  assert.deepEqual(await readFile(sourceSession), snapshots.source);

  const missingRecord = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: { context: ["briefs/gone.md"] },
  });
  await publishRecord(workspaceDirectory, missingRecord);
  const missingHarness = piHarness();
  const missingService = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: missingHarness.spawnImpl,
  });
  try {
    await assert.rejects(missingService.resume({ workspace_id: "alpha", thread_id: missingRecord.thread_id }), {
      code: "missing-context",
    });
    assert.equal(missingHarness.calls.filter((call) => call.command === "pi").length, 0);
  } finally {
    await missingService.close();
  }

  const outside = join(root, "outside.md");
  await writeFile(outside, "outside\n");
  await symlink(outside, join(workspaceDirectory, "briefs", "linked.md"));
  const linkedRecord = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: { context: ["briefs/linked.md"] },
  });
  await publishRecord(workspaceDirectory, linkedRecord);
  const linkedHarness = piHarness();
  const linkedService = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: linkedHarness.spawnImpl,
  });
  try {
    await assert.rejects(linkedService.resume({ workspace_id: "alpha", thread_id: linkedRecord.thread_id }), {
      code: "missing-context",
    });
    assert.equal(linkedHarness.calls.filter((call) => call.command === "pi").length, 0);
  } finally {
    await linkedService.close();
  }

  await writeFile(join(workspaceDirectory, "briefs", "huge.md"), "x".repeat(256 * 1024 + 1));
  const hugeRecord = manualRecord({
    workspaceId: "alpha",
    directory: workspaceDirectory,
    overrides: { context: ["briefs/huge.md"] },
  });
  await publishRecord(workspaceDirectory, hugeRecord);
  const hugeHarness = piHarness();
  const hugeService = createDiscussionService({
    root: storageRoot,
    agentDir: join(root, "agent"),
    spawn: hugeHarness.spawnImpl,
  });
  try {
    await assert.rejects(hugeService.resume({ workspace_id: "alpha", thread_id: hugeRecord.thread_id }), {
      code: "invalid-context",
    });
    assert.equal(hugeHarness.calls.filter((call) => call.command === "pi").length, 0);
  } finally {
    await hugeService.close();
  }

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
  "thread identity unconfirmed ready shutdown retains process and attention",
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
