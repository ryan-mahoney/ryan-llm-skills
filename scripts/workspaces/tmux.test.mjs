// Step 2 focused tests: isolated tmux adapter.
//
// Each case gets a realpath(mkdtemp(tmpdir())) root, a unique socket path, a
// real tmux 3.8 server, the repository's fake Pi fixture and a temporary cwd.
// Cleanup signals only test-owned fixture PIDs and kills only the owned
// socket server; the default tmux server and tmux configuration are observed
// read-only and asserted unchanged. No real storage root or .sentinel is
// touched.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sameProcess } from "../spec-observe/process-identity.mjs";
import { attachArgs, hasSession, sessionPanePid, startSession } from "./tmux.mjs";

const TEST_TIMEOUT_MS = 10000;
const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");

function runTmux(argv) {
  return new Promise((resolvePromise) => {
    execFile(
      "tmux",
      argv,
      {
        timeout: TEST_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          ok: !error,
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          message: error ? error.message : null,
        });
      },
    );
  });
}

function tmuxExec(socketPath, args) {
  return runTmux(["-S", socketPath, ...args]);
}

async function tmuxOutput(socketPath, args) {
  const result = await tmuxExec(socketPath, args);
  assert.equal(
    result.ok,
    true,
    `tmux ${args.join(" ")} failed: ${result.stderr || result.message}`,
  );
  return result.stdout.trim();
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

function sessionName() {
  return `adj-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

async function tempRoot(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "adj4tmux-")));
  const state = { pids: [], children: [] };
  t.after(async () => {
    for (const child of state.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const pid of state.pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already exited.
      }
    }
    if (state.socketPath) await tmuxExec(state.socketPath, ["kill-server"]);
    delete process.env.FAKE_PI_LOG;
    await rm(root, { recursive: true, force: true });
  });
  return { root, state };
}

async function logEntries(logPath) {
  let text;
  try {
    text = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

async function waitForLogEntry(logPath, pid) {
  return waitFor(async () => {
    const entries = await logEntries(logPath);
    return entries.find((entry) => entry.pid === pid) ?? null;
  }, `fake pi ${pid} log entry`);
}

async function waitForClient(socketPath, name) {
  return waitFor(async () => {
    const result = await tmuxExec(socketPath, ["list-clients", "-F", "#{client_name} #{client_session}"]);
    if (!result.ok) return null;
    for (const line of result.stdout.split("\n")) {
      const match = /^(\S+) (\S+)$/.exec(line.trim());
      if (match && match[2] === name) return match[1];
    }
    return null;
  }, `attach client for ${name}`);
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("attach client did not exit after detach"));
    }, TEST_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function defaultServerObservation() {
  const result = await runTmux(["list-sessions", "-F", "#{session_id} #{session_name}"]);
  return { ok: result.ok, code: result.code, stderr: result.stderr.trim(), stdout: result.stdout };
}

async function tmuxConfigState() {
  const candidates = [
    join(homedir(), ".tmux.conf"),
    join(homedir(), ".config", "tmux", "tmux.conf"),
  ];
  const state = [];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate, { bigint: true });
      state.push([candidate, info.size.toString(), info.mtimeNs.toString()]);
    } catch {
      state.push([candidate, null]);
    }
  }
  return state;
}

function startInput({ socketPath, name, cwd, args, assignmentId }) {
  return {
    socketPath,
    sessionName: name,
    cwd,
    piPath: process.execPath,
    piArgs: [FIXTURE_PATH, ...args],
    assignmentId,
  };
}

test("tmux adapter: first launch bootstraps keys and runs fixture with exact argv and cwd", async (t) => {
  const { root, state } = await tempRoot(t);
  const socketPath = join(root, "s.sock");
  const cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
  const logPath = join(root, "fake-pi.jsonl");
  process.env.FAKE_PI_LOG = logPath;
  state.socketPath = socketPath;

  const name = sessionName();
  const assignmentId = randomUUID();
  const piArgs = [FIXTURE_PATH, "--alpha", "spaced value"];

  const result = await startSession({
    socketPath,
    sessionName: name,
    cwd,
    piPath: process.execPath,
    piArgs,
    assignmentId,
  });
  state.pids.push(result.panePid);

  assert.equal(result.socketPath, socketPath);
  assert.equal(result.sessionName, name);
  assert.match(result.paneId, /^%\d+$/);
  assert.ok(Number.isSafeInteger(result.panePid) && result.panePid > 0);
  assert.equal(result.piIdentity.pid, result.panePid);
  assert.equal(typeof result.piIdentity.started_at, "string");
  assert.ok(result.piIdentity.started_at.length > 0);

  // First server bootstrap enables extended keys and records the full UUID.
  assert.equal(await tmuxOutput(socketPath, ["show-options", "-sv", "extended-keys"]), "on");
  assert.equal(
    await tmuxOutput(socketPath, ["show-options", "-v", "-t", `=${name}:`, "@adjacent_assignment_id"]),
    assignmentId,
  );

  // The pane really runs the fixture with the exact argv and physical cwd.
  const entry = await waitForLogEntry(logPath, result.panePid);
  assert.deepEqual(entry.argv, piArgs);
  assert.equal(entry.cwd, cwd);
  assert.equal(entry.pid, result.panePid);

  assert.deepEqual(await sessionPanePid({ socketPath, sessionName: name }), {
    paneId: result.paneId,
    panePid: result.panePid,
  });
  assert.deepEqual(attachArgs({ socketPath, sessionName: name }), [
    "-S",
    socketPath,
    "attach-session",
    "-t",
    `=${name}`,
  ]);
});

test("tmux adapter: foreign short-name collision refuses adoption of a different full id", async (t) => {
  const { root, state } = await tempRoot(t);
  const socketPath = join(root, "s.sock");
  const cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
  const logPath = join(root, "fake-pi.jsonl");
  process.env.FAKE_PI_LOG = logPath;
  state.socketPath = socketPath;

  // A foreign session whose name shares the requested UUID's 12-hex prefix
  // but records a different full assignment id.
  const ownerId = randomUUID();
  const hex = ownerId.replaceAll("-", "").slice(0, 12);
  const name = `adj-${hex}`;
  const foreignId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4000-8000-000000000000`;
  const foreign = await tmuxExec(socketPath, [
    "start-server", ";",
    "new-session", "-d", "-x", "200", "-y", "50", "-s", name, "-c", cwd,
    "--", process.execPath, FIXTURE_PATH, "foreign", ";",
    "set-option", "-t", `=${name}:`, "@adjacent_assignment_id", foreignId,
  ]);
  assert.equal(foreign.ok, true, foreign.stderr);
  const foreignPane = await sessionPanePid({ socketPath, sessionName: name });
  assert.ok(foreignPane !== null);
  state.pids.push(foreignPane.panePid);
  await waitForLogEntry(logPath, foreignPane.panePid);

  await assert.rejects(
    startSession(startInput({ socketPath, name, cwd, args: ["own"], assignmentId: ownerId })),
    /collision/,
  );
  assert.deepEqual(await sessionPanePid({ socketPath, sessionName: name }), foreignPane);
  assert.equal(
    await tmuxOutput(socketPath, ["show-options", "-v", "-t", `=${name}:`, "@adjacent_assignment_id"]),
    foreignId,
  );
  assert.equal((await logEntries(logPath)).length, 1);

  // A same-name foreign session with no recorded id also refuses.
  const untaggedName = sessionName();
  const untagged = await tmuxExec(socketPath, [
    "new-session", "-d", "-x", "200", "-y", "50", "-s", untaggedName, "-c", cwd,
    "--", process.execPath, FIXTURE_PATH, "untagged",
  ]);
  assert.equal(untagged.ok, true, untagged.stderr);
  const untaggedPane = await sessionPanePid({ socketPath, sessionName: untaggedName });
  assert.ok(untaggedPane !== null);
  state.pids.push(untaggedPane.panePid);
  await waitForLogEntry(logPath, untaggedPane.panePid);
  await assert.rejects(
    startSession(startInput({
      socketPath,
      name: untaggedName,
      cwd,
      args: ["own"],
      assignmentId: randomUUID(),
    })),
    /collision/,
  );
  assert.equal((await logEntries(logPath)).length, 2);

  // An owned repeat with the same full id adopts the existing pane instead.
  const ownedName = sessionName();
  const ownedId = randomUUID();
  const input = startInput({ socketPath, name: ownedName, cwd, args: ["owned"], assignmentId: ownedId });
  const owned = await startSession(input);
  state.pids.push(owned.panePid);
  await waitForLogEntry(logPath, owned.panePid);
  const repeated = await startSession(input);
  assert.equal(repeated.paneId, owned.paneId);
  assert.equal(repeated.panePid, owned.panePid);
  assert.equal(repeated.piIdentity.pid, owned.piIdentity.pid);
  assert.ok(sameProcess(owned.piIdentity));
  assert.equal((await logEntries(logPath)).length, 3);
});

test("tmux adapter: owned PTY attach and detach preserve pane and Pi identity; default server untouched", async (t) => {
  const { root, state } = await tempRoot(t);
  const socketPath = join(root, "s.sock");
  const cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
  const logPath = join(root, "fake-pi.jsonl");
  process.env.FAKE_PI_LOG = logPath;
  state.socketPath = socketPath;

  const defaultBefore = await defaultServerObservation();
  const configBefore = await tmuxConfigState();

  const name = sessionName();
  const assignmentId = randomUUID();
  const created = await startSession(startInput({
    socketPath,
    name,
    cwd,
    args: ["attached"],
    assignmentId,
  }));
  state.pids.push(created.panePid);
  await waitForLogEntry(logPath, created.panePid);

  // Attach a real PTY client to the owned socket only.
  const attach = spawn("/usr/bin/script", [
    "-q",
    "/dev/null",
    "tmux",
    ...attachArgs({ socketPath, sessionName: name }),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  attach.on("error", () => {});
  state.children.push(attach);

  const clientName = await waitForClient(socketPath, name);
  assert.ok(typeof clientName === "string" && clientName.length > 0);
  assert.deepEqual(await sessionPanePid({ socketPath, sessionName: name }), {
    paneId: created.paneId,
    panePid: created.panePid,
  });
  assert.ok(sameProcess(created.piIdentity));

  // Detach only the owned client; the pane and Pi identity stay the same.
  const detached = await tmuxExec(socketPath, ["detach-client", "-t", clientName]);
  assert.equal(detached.ok, true, detached.stderr);
  await waitForExit(attach);
  assert.deepEqual(await sessionPanePid({ socketPath, sessionName: name }), {
    paneId: created.paneId,
    panePid: created.panePid,
  });
  assert.ok(sameProcess(created.piIdentity));

  // The explicit -S socket never touched the default server or tmux config.
  const defaultAfter = await defaultServerObservation();
  assert.deepEqual(
    { ok: defaultAfter.ok, code: defaultAfter.code, stderr: defaultAfter.stderr },
    { ok: defaultBefore.ok, code: defaultBefore.code, stderr: defaultBefore.stderr },
  );
  assert.ok(!defaultAfter.stdout.includes(name), "owned session must not appear on the default server");
  assert.deepEqual(await tmuxConfigState(), configBefore);
});

test("tmux adapter: session probes distinguish confirmed absence from unreachable server", async (t) => {
  const { root, state } = await tempRoot(t);
  const socketPath = join(root, "s.sock");
  state.socketPath = socketPath;
  const absentName = sessionName();

  // No server answers on the fresh socket: absence is unknown, not confirmed.
  await assert.rejects(hasSession({ socketPath, sessionName: absentName }), /unreachable/);
  await assert.rejects(sessionPanePid({ socketPath, sessionName: absentName }), /unreachable/);

  // A live server without the session confirms absence.
  const presentName = sessionName();
  const started = await tmuxExec(socketPath, [
    "start-server", ";",
    "new-session", "-d", "-x", "200", "-y", "50", "-s", presentName, "-c", root,
    "--", "/bin/sleep", "300",
  ]);
  assert.equal(started.ok, true, started.stderr);
  assert.equal(await hasSession({ socketPath, sessionName: absentName }), false);
  assert.equal(await sessionPanePid({ socketPath, sessionName: absentName }), null);
  assert.equal(await hasSession({ socketPath, sessionName: presentName }), true);
  const pane = await sessionPanePid({ socketPath, sessionName: presentName });
  assert.match(pane.paneId, /^%\d+$/);
  assert.ok(Number.isSafeInteger(pane.panePid) && pane.panePid > 0);
});
