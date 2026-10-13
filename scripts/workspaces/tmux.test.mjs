// Step 2 focused tests: isolated tmux adapter.
//
// Session cases get a realpath(mkdtemp(tmpdir())) root, a unique socket path,
// a real tmux 3.8 server, the repository's fake Pi fixture and a temporary
// cwd; probe shape and parse cases inject only the documented final command
// boundary.
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
import {
  attachArgs,
  hasSession,
  probeSession,
  sessionPanePid,
  startSession,
  windowSize,
} from "./tmux.mjs";

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

  // First server bootstrap enables extended keys with the CSI-u format and
  // records the full UUID.
  assert.equal(await tmuxOutput(socketPath, ["show-options", "-sv", "extended-keys"]), "on");
  const format = await tmuxOutput(socketPath, ["show-options", "-sqv", "extended-keys-format"]);
  // tmux 3.4 has no format option; both versions must reach the real child.
  assert.ok(format === "" || format === "csi-u", `unexpected extended key format: ${format}`);
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

test("tmux adapter: literal semicolons survive tmux argv parsing with exact delivery", async (t) => {
  const { root, state } = await tempRoot(t);
  const socketPath = join(root, "s.sock");
  // A cwd with a trailing semicolon exercises the same tmux-level escaping
  // as Pi arguments: it must not split the bootstrap queue.
  const cwd = join(root, "work;");
  await mkdir(cwd, { recursive: true });
  const logPath = join(root, "fake-pi.jsonl");
  process.env.FAKE_PI_LOG = logPath;
  state.socketPath = socketPath;

  const name = sessionName();
  const assignmentId = randomUUID();
  const args = [";", ";;", "trailing;", "a;;", "a;b", ";x", "\\;", "abc\\;", "plain", "--name", "ws:title;"];
  const result = await startSession({
    socketPath,
    sessionName: name,
    cwd,
    piPath: process.execPath,
    piArgs: [FIXTURE_PATH, ...args],
    assignmentId,
  });
  state.pids.push(result.panePid);

  const entry = await waitForLogEntry(logPath, result.panePid);
  assert.deepEqual(entry.argv, [FIXTURE_PATH, ...args]);
  assert.equal(entry.cwd, cwd);

  // No semicolon became a tmux command separator: exactly one session runs.
  assert.equal(await tmuxOutput(socketPath, ["list-sessions", "-F", "#{session_name}"]), name);
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

  // An owned repeat with the same full id adopts the existing pane only when
  // the caller supplies the saved pane identity; without that evidence
  // adoption refuses fail-closed even though the UUID matches.
  const ownedName = sessionName();
  const ownedId = randomUUID();
  const input = startInput({ socketPath, name: ownedName, cwd, args: ["owned"], assignmentId: ownedId });
  const owned = await startSession(input);
  state.pids.push(owned.panePid);
  await waitForLogEntry(logPath, owned.panePid);
  const expectedPane = { paneId: owned.paneId, piIdentity: owned.piIdentity };
  await assert.rejects(startSession(input), /pane identity/);
  const repeated = await startSession({ ...input, expectedPane });
  assert.equal(repeated.paneId, owned.paneId);
  assert.equal(repeated.panePid, owned.panePid);
  assert.equal(repeated.piIdentity.pid, owned.piIdentity.pid);
  assert.ok(sameProcess(owned.piIdentity));
  assert.equal((await logEntries(logPath)).length, 3);
});

test("tmux adapter: same-UUID adoption requires the recorded pane and Pi process", async (t) => {
  const { root, state } = await tempRoot(t);
  const socketPath = join(root, "s.sock");
  const cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
  const logPath = join(root, "fake-pi.jsonl");
  process.env.FAKE_PI_LOG = logPath;
  state.socketPath = socketPath;

  const name = sessionName();
  const assignmentId = randomUUID();
  const input = startInput({ socketPath, name, cwd, args: ["owned"], assignmentId });
  const owned = await startSession(input);
  state.pids.push(owned.panePid);
  await waitForLogEntry(logPath, owned.panePid);
  const expectedPane = { paneId: owned.paneId, piIdentity: owned.piIdentity };

  // Splitting a second pane selects it: the same UUID with a different
  // active pane must refuse adoption instead of taking over the sibling.
  const split = await tmuxExec(socketPath, [
    "split-window", "-t", `=${name}:`, "-c", cwd,
    "--", process.execPath, FIXTURE_PATH, "sibling",
  ]);
  assert.equal(split.ok, true, split.stderr);
  const sibling = await waitFor(async () => {
    const current = await sessionPanePid({ socketPath, sessionName: name });
    return current !== null && current.paneId !== owned.paneId ? current : null;
  }, `sibling pane in ${name}`);
  state.pids.push(sibling.panePid);
  await waitForLogEntry(logPath, sibling.panePid);
  await assert.rejects(startSession({ ...input, expectedPane }), /pane identity mismatch/);

  // Replacing the recorded pane process keeps the pane id but ends the
  // recorded Pi identity: adoption must still refuse.
  const reselect = await tmuxExec(socketPath, ["select-pane", "-t", owned.paneId]);
  assert.equal(reselect.ok, true, reselect.stderr);
  const respawn = await tmuxExec(socketPath, [
    "respawn-pane", "-k", "-t", owned.paneId,
    process.execPath, FIXTURE_PATH, "replacement",
  ]);
  assert.equal(respawn.ok, true, respawn.stderr);
  const replacement = await waitFor(async () => {
    const current = await sessionPanePid({ socketPath, sessionName: name });
    return current !== null && current.panePid !== owned.panePid ? current : null;
  }, `replacement process in ${owned.paneId}`);
  state.pids.push(replacement.panePid);
  await waitForLogEntry(logPath, replacement.panePid);
  assert.equal(replacement.paneId, owned.paneId);
  await assert.rejects(startSession({ ...input, expectedPane }), /pane process mismatch/);
  assert.ok(!sameProcess(owned.piIdentity));
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

// Injected final boundary for the read-only probe queue: reachable server,
// exact recorded UUID option and one configurable display-message reply.
function stubProbeRun({ assignmentId, display, formats }) {
  return async (_socketPath, args) => {
    if (args[0] === "has-session") return { ok: true, code: 0, stdout: "", stderr: "" };
    if (args[0] === "show-options") {
      return { ok: true, code: 0, stdout: `${assignmentId}\n`, stderr: "" };
    }
    if (args[0] === "display-message") {
      formats.push(args[4]);
      return { ok: true, code: 0, stdout: display, stderr: "" };
    }
    return {
      ok: false, code: 1, stdout: "", stderr: "unexpected command", message: "unexpected command",
    };
  };
}

test("tmux adapter: probeSession default probe keeps the exact two-field identity result", async () => {
  const assignmentId = randomUUID();
  const record = {
    tmux_socket: join(tmpdir(), "adj4-probe-default.sock"),
    tmux_session: sessionName(),
    assignment_id: assignmentId,
    pane_id: "%3",
  };
  const formats = [];
  const present = await probeSession(record, {
    run: stubProbeRun({ assignmentId, display: "%3 4242\n", formats }),
  });
  assert.deepEqual(present, {
    status: "present",
    assignment_id: assignmentId,
    pane_id: "%3",
    pid: 4242,
  });
  assert.deepEqual(formats, ["#{pane_id} #{pane_pid}"]);

  // The default contract never consumes a third field, so an unexpected reply
  // cannot silently become an attachment count.
  const unexpected = await probeSession(record, {
    run: stubProbeRun({ assignmentId, display: "%3 4242 1\n", formats: [] }),
  });
  assert.equal(unexpected.status, "unknown");
});

test("tmux adapter: probeSession opt-in attached count distinguishes zero, positive and unknown", async () => {
  const assignmentId = randomUUID();
  const record = {
    tmux_socket: join(tmpdir(), "adj4-probe-attached.sock"),
    tmux_session: sessionName(),
    assignment_id: assignmentId,
    pane_id: "%3",
  };
  const cases = [
    ["%3 4242 0\n", 0],
    ["%3 4242 5\n", 5],
    ["%3 4242\n", null],
    ["%3 4242 many\n", null],
    ["%3 4242 -1\n", null],
    ["%3 4242 9007199254740993\n", null],
  ];
  for (const [display, expected] of cases) {
    const formats = [];
    const present = await probeSession(record, {
      run: stubProbeRun({ assignmentId, display, formats }),
      includeAttached: true,
    });
    assert.equal(present.status, "present", display.trim());
    assert.equal(present.assignment_id, assignmentId);
    assert.equal(present.pane_id, "%3");
    assert.equal(present.pid, 4242);
    assert.equal(present.attached, expected, display.trim());
    assert.deepEqual(formats, ["#{pane_id} #{pane_pid} #{session_attached}"]);
  }

  // The opt-in query keeps the exact saved-pane ownership check.
  const mismatch = await probeSession(record, {
    run: stubProbeRun({ assignmentId, display: "%4 4242 2\n", formats: [] }),
    includeAttached: true,
  });
  assert.equal(mismatch.status, "unknown");
});

// Injected final boundary for window-size reads: scripted session existence,
// server reachability and display-message reply, recording every invocation.
// `sessionExists` may be a function of the 1-based has-session probe number,
// and `display` may be a function returning a full transport result.
function stubWindowSizeRun({ sessionExists = true, serverReachable = true, display = "200 50" } = {}) {
  const calls = [];
  let probes = 0;
  const run = async (socketPath, args) => {
    calls.push({ socketPath, args: [...args] });
    if (args[0] === "has-session") {
      const exists = typeof sessionExists === "function" ? sessionExists(++probes) : sessionExists;
      return exists
        ? { ok: true, code: 0, stdout: "", stderr: "" }
        : { ok: false, code: 1, stdout: "", stderr: "can't find session", message: "tmux has-session failed" };
    }
    if (args[0] === "list-clients") {
      return serverReachable
        ? { ok: true, code: 0, stdout: "", stderr: "" }
        : { ok: false, code: 1, stdout: "", stderr: "no server", message: "tmux list-clients failed" };
    }
    if (args[0] === "display-message") {
      return typeof display === "function"
        ? display()
        : { ok: true, code: 0, stdout: display, stderr: "" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "unexpected command", message: "unexpected command" };
  };
  return { run, calls };
}

test("tmux adapter: window size reads the target session's exact dimensions", async () => {
  const socketPath = join(tmpdir(), "adj4-window-size.sock");
  const name = sessionName();
  const { run, calls } = stubWindowSizeRun({ display: "200 50\n" });
  assert.deepEqual(await windowSize({ socketPath, sessionName: name }, { run }), { cols: 200, rows: 50 });
  // The probe and the read target the exact explicit socket and `=name:`
  // session; the display format asks for exactly the two size fields.
  assert.deepEqual(calls, [
    { socketPath, args: ["has-session", "-t", `=${name}`] },
    {
      socketPath,
      args: ["display-message", "-p", "-t", `=${name}:`, "#{window_width} #{window_height}"],
    },
  ]);
});

test("tmux adapter: window size optionally reads the status rows for the stream probe", async () => {
  const socketPath = join(tmpdir(), "adj4-window-status.sock");
  const name = sessionName();
  const cases = [["on", 1], ["off", 0], ["0", 0], ["1", 1], ["2", 2], ["5", 5]];
  for (const [status, statusRows] of cases) {
    const { run, calls } = stubWindowSizeRun({ display: `200 50 ${status}\n` });
    assert.deepEqual(
      await windowSize({ socketPath, sessionName: name }, { run, includeStatus: true }),
      { cols: 200, rows: 50, statusRows },
      status,
    );
    // The opt-in read asks for exactly the status field in the same exact
    // session target; the default read keeps the two-field format above.
    assert.deepEqual(calls[1], {
      socketPath,
      args: ["display-message", "-p", "-t", `=${name}:`, "#{window_width} #{window_height} #{status}"],
    });
  }
  for (const status of ["maybe", "6", "-1", "1.5"]) {
    const { run } = stubWindowSizeRun({ display: `200 50 ${status}\n` });
    await assert.rejects(
      windowSize({ socketPath, sessionName: name }, { run, includeStatus: true }),
      /invalid window status/,
      status,
    );
  }
  const missing = stubWindowSizeRun({ display: "200 50\n" });
  await assert.rejects(
    windowSize({ socketPath, sessionName: name }, { run: missing.run, includeStatus: true }),
    /invalid window dimensions/,
  );
});

test("tmux adapter: window size returns null only on confirmed session absence", async () => {
  const socketPath = join(tmpdir(), "adj4-window-absent.sock");
  const name = sessionName();

  // A reachable server without the session confirms absence.
  const missing = stubWindowSizeRun({ sessionExists: false });
  assert.equal(await windowSize({ socketPath, sessionName: name }, { run: missing.run }), null);
  assert.deepEqual(missing.calls, [
    { socketPath, args: ["has-session", "-t", `=${name}`] },
    { socketPath, args: ["list-clients"] },
  ]);

  // A session that vanishes between the probe and display-message is likewise
  // confirmed absence, not a fabricated size.
  const vanished = stubWindowSizeRun({
    sessionExists: (probe) => probe === 1,
    display: () => ({
      ok: false, code: 1, stdout: "", stderr: "session vanished", message: "tmux display-message failed",
    }),
  });
  assert.equal(await windowSize({ socketPath, sessionName: name }, { run: vanished.run }), null);
  assert.deepEqual(
    vanished.calls.map((call) => call.args[0]),
    ["has-session", "display-message", "has-session", "list-clients"],
  );

  // The same display failure with the session still present is a transport
  // failure and must throw.
  const failed = stubWindowSizeRun({
    display: () => ({
      ok: false, code: 1, stdout: "", stderr: "boom", message: "tmux display-message failed",
    }),
  });
  await assert.rejects(
    windowSize({ socketPath, sessionName: name }, { run: failed.run }),
    /tmux display-message failed: boom/,
  );
});

test("tmux adapter: window size fails closed when the explicit server is unreachable", async () => {
  const socketPath = join(tmpdir(), "adj4-window-unreachable.sock");
  const name = sessionName();
  const { run, calls } = stubWindowSizeRun({ sessionExists: false, serverReachable: false });
  await assert.rejects(
    windowSize({ socketPath, sessionName: name }, { run }),
    /tmux server is unreachable/,
  );
  assert.deepEqual(calls, [
    { socketPath, args: ["has-session", "-t", `=${name}`] },
    { socketPath, args: ["list-clients"] },
  ]);
  assert.ok(
    !calls.some((call) => call.args[0] === "display-message"),
    "an unreachable server must not produce fabricated dimensions",
  );
});

test("tmux adapter: window size rejects zero, nonnumeric and unsafe dimensions", async () => {
  const socketPath = join(tmpdir(), "adj4-window-invalid.sock");
  const name = sessionName();
  const cases = [
    "0 50\n",
    "200 0\n",
    "0 0\n",
    "200\n",
    "200 50 10\n",
    "cols 50\n",
    "200 fifty\n",
    "9007199254740993 50\n",
    "200 9007199254740993\n",
  ];
  for (const display of cases) {
    const { run } = stubWindowSizeRun({ display });
    await assert.rejects(
      windowSize({ socketPath, sessionName: name }, { run }),
      /invalid window dimensions/,
      `display ${JSON.stringify(display)} must be rejected`,
    );
  }
});
