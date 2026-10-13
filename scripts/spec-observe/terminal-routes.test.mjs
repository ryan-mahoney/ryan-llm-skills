// EV-3 composed evidence for the dashboard's terminal routes and owned
// shutdown: real createDashboardServer/createDirectDashboard composition and
// the standalone dashboard CLI, disposable storage records and private
// test-owned tmux sessions with the default verifyTerminal/windowSize
// boundaries. Only the final asciinema process is substituted:
// fixtures/terminal-view-stream.mjs through a spawn wrapper, or a PATH shim
// for the CLI case.
//
// All cases: node --test scripts/spec-observe/terminal-routes.test.mjs
// One case:  node --test --test-name-pattern="terminal routes 1" scripts/spec-observe/terminal-routes.test.mjs
//            ... "terminal routes 2" ... "terminal routes 3" ... "terminal routes 4" ... "terminal routes 5"
//
// Every case creates and removes only owned temporary state (workspace,
// assignment record, private tmux socket, child processes); it never reads a
// live operator session, never writes a recording and bounds every wait.
// Cleanup is registered from the first owned resource and runs on failure too.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDirectDashboard, createSentinelDashboard } from "../../pi/extensions/spec-runtime/sentinel-dashboard.mjs";
import { setupStorage, createWorkspace } from "../workspaces/store.mjs";
import { createDashboardServer } from "./dashboard.mjs";
import { inspectProcess, processIdentity, sameProcess } from "./process-identity.mjs";
import { createTerminalViews } from "./terminal-view.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "terminal-view-stream.mjs");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout = 4000, interval = 10, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(interval);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function exec(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

// Durable record conventions mirror terminal-view.test.mjs; this file keeps its
// own copies rather than exporting general helpers from that test module.
async function makeSetup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "terminal-routes-")));
  const storageRoot = join(root, "storage");
  const workspaceId = "terminal-routes-fixture";
  const workspaceDirectory = join(storageRoot, "projects", workspaceId);
  await mkdir(workspaceDirectory, { recursive: true });
  await writeFile(
    join(workspaceDirectory, "kit.yaml"),
    `version: 1\nid: ${JSON.stringify(workspaceId)}\nname: ${JSON.stringify(workspaceId)}\nrepositories: []\n`,
  );
  return { root, storageRoot, workspaceId, workspaceDirectory };
}

function buildRecord(setup, id, overrides = {}) {
  const hex = "a".repeat(64);
  const timestamp = new Date().toISOString();
  return {
    schema_version: 1,
    assignment_id: id,
    workspace_id: setup.workspaceId,
    workspace_directory: setup.workspaceDirectory,
    storage_root: setup.storageRoot,
    brief: "brief.md",
    brief_sha256: hex,
    brief_snapshot: join(setup.workspaceDirectory, "assignments", `${id}.brief.md`),
    skill: "general",
    skill_path: null,
    instructions: "Fixture instructions.",
    provider: null,
    model: null,
    thinking: null,
    project_trust: null,
    execution_dir: setup.workspaceDirectory,
    execution_branch: null,
    repository_id: null,
    spec_package: null,
    package_ref: null,
    attention: [],
    workflow_id: null,
    publication_authority: "none",
    attempt_kind: "initial",
    supersedes: null,
    contract_digest: hex,
    tmux_socket: join(setup.storageRoot, "fixture.sock"),
    tmux_session: `adj-${id.replace(/-/g, "").slice(0, 12)}`,
    pi_path: "/bin/true",
    coordination_database: join(setup.storageRoot, ".sentinel", "coordination.sqlite"),
    pi_session_dir: join(setup.workspaceDirectory, "sessions", id),
    harness: "pi",
    pi_session_file: null,
    launcher_identity: null,
    pi_identity: null,
    pane_id: null,
    state: "live",
    created_at: timestamp,
    updated_at: timestamp,
    launch_token: randomUUID(),
    ...overrides,
  };
}

async function addRecord(setup, overrides = {}) {
  const id = overrides.assignment_id ?? randomUUID();
  const record = buildRecord(setup, id, overrides);
  const directory = join(setup.workspaceDirectory, "assignments");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.json`), JSON.stringify(record, null, 2));
  return record;
}

// A private tmux server whose pane runs one long-lived node process, tagged
// with the exact assignment UUID probeSession requires. The identity is read
// back from the real pane, so default verifyTerminal and windowSize work. The
// caller passes the same id as its durable record.
async function startTmuxAgent(setup, id) {
  const socket = join(setup.root, "tmux.sock");
  const session = `adj-${id.replace(/-/g, "").slice(0, 12)}`;
  await exec("tmux", ["-S", socket, "new-session", "-d", "-s", session, process.execPath, "-e", "setInterval(() => {}, 1000)"]);
  await exec("tmux", ["-S", socket, "set-option", "-t", `=${session}:`, "@adjacent_assignment_id", id]);
  const { stdout } = await exec("tmux", ["-S", socket, "display-message", "-p", "-t", `=${session}:`, "#{pane_id} #{pane_pid}"]);
  const [paneId, pidText] = stdout.trim().split(/\s+/);
  const pid = Number(pidText);
  assert.match(paneId, /^%\d+$/);
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const identity = await waitFor(() => processIdentity(pid), { label: "pane process identity" });
  return { socket, session, paneId, pid, identity };
}

function captureSpawn(fixtureEnv, children) {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const child = spawn(command, args, { ...options, env: { ...options.env, ...fixtureEnv } });
    calls.push({ command, args, options });
    children.push(child);
    return child;
  };
  return { spawnProcess, calls, children };
}

function makeViews(setup, spawns, overrides = {}) {
  return createTerminalViews({
    storageRoot: setup.storageRoot,
    asciinema: FIXTURE,
    spawnProcess: spawns.spawnProcess,
    maxStreams: 4,
    startTimeoutMs: 3000,
    startIdleMs: 60000,
    graceMs: 60000,
    ...overrides,
  });
}

function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function killChildren(children) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

function settleChildren(children) {
  return Promise.all(children.map((child) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }));
}

function bounded(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  server.closeAllConnections?.();
  await bounded(new Promise((resolve) => server.close(resolve)), 2000);
}

// Cleanup runs on success and failure. Stops go first so a standalone helper
// can terminate its stream gracefully, then lingering viewer sockets are
// destroyed, owned views drain, servers close, and only the pre-registered
// owned tmux socket is killed; the final SIGKILL is a bounded fallback.
function cleanupAll(t, setup, resources) {
  t.after(async () => {
    try {
      for (const stop of resources.stops ?? []) await Promise.resolve(stop()).catch(() => {});
      for (const viewer of resources.viewers ?? []) {
        try {
          viewer.end();
        } catch {
          // Best effort.
        }
      }
      for (const views of resources.views ?? []) await views.closeAll().catch(() => {});
      for (const server of resources.servers ?? []) await closeServer(server);
      for (const socket of resources.tmuxSockets ?? []) await exec("tmux", ["-S", socket, "kill-server"]).catch(() => {});
    } finally {
      killChildren(resources.children ?? []);
      await settleChildren(resources.children ?? []);
      await rm(setup.root, { recursive: true, force: true });
    }
  });
}

async function readLog(logPath) {
  let text;
  try {
    text = await readFile(logPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

function call(port, path, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Non-JSON refusal bodies stay null.
        }
        resolve({ status: response.statusCode, headers: response.headers, body: text, json });
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(body ?? undefined);
  });
}

function openHeaders(port, token, extra = {}) {
  return {
    "Content-Type": "application/json",
    Origin: `http://127.0.0.1:${port}`,
    "X-Sentinel-Token": token,
    ...extra,
  };
}

function postOpen(port, headers, body) {
  return call(port, "/api/assignment-terminal/open", { method: "POST", headers, body });
}

// Raw upgrade with explicit Host/Origin so locality and origin variants can be
// exercised exactly as a WebSocket client would send them.
function rawUpgrade(port, path, { host = `127.0.0.1:${port}`, origin = null, extra = {}, head = "" } = {}) {
  const socket = netConnect({ host: "127.0.0.1", port });
  const state = { socket, data: Buffer.alloc(0), closed: false, error: null };
  socket.on("data", (chunk) => {
    state.data = Buffer.concat([state.data, chunk]);
  });
  socket.on("close", () => {
    state.closed = true;
  });
  socket.on("error", (error) => {
    state.error = error;
    state.closed = true;
  });
  state.ready = new Promise((resolve) => {
    socket.once("connect", () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
      ];
      if (origin !== null) lines.push(`Origin: ${origin}`);
      for (const [name, value] of Object.entries(extra)) lines.push(`${name}: ${value}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n${head}`);
      resolve();
    });
  });
  state.write = (value) => socket.write(value);
  state.end = () => socket.destroy();
  return state;
}

async function stateToken(port) {
  const state = await call(port, "/api/state");
  assert.equal(state.status, 200);
  assert.match(state.json.action_token, /^[a-f0-9]{64}$/);
  return state.json.action_token;
}

async function startDashboard(setup, views, extra = {}) {
  const server = createDashboardServer({
    agentDir: join(setup.root, "agent"),
    storageRoot: setup.storageRoot,
    terminalViews: views,
    ...extra,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function refuseUpgrade(socket, expectedStatus, label) {
  await socket.ready;
  await waitFor(() => socket.data.length > 0, { label: `${label} response` });
  assert.match(socket.data.toString("latin1"), new RegExp(`^HTTP/1\\.1 ${expectedStatus}`), label);
  await waitFor(() => socket.closed, { label: `${label} close` });
}

// A resources record registered before the first owned resource exists; the
// known tmux socket path is pre-registered so a startup failure still kills
// only that owned server.
function trackResources(setup) {
  return {
    stops: [],
    views: [],
    children: [],
    servers: [],
    viewers: [],
    tmuxSockets: [join(setup.root, "tmux.sock")],
  };
}

test("terminal routes 1: local open requires token, Origin, locality, bounded JSON and a UUID", { timeout: 30000 }, async (t) => {
  const setup = await makeSetup();
  const resources = trackResources(setup);
  cleanupAll(t, setup, resources);
  const id = randomUUID();
  const tmuxServer = await startTmuxAgent(setup, id);
  await addRecord(setup, {
    assignment_id: id,
    tmux_socket: tmuxServer.socket,
    tmux_session: tmuxServer.session,
    pane_id: tmuxServer.paneId,
    pi_identity: tmuxServer.identity,
  });
  const fixtureEnv = { TERMINAL_VIEW_LOG: join(setup.root, "fixture.log") };
  const spawns = captureSpawn(fixtureEnv, resources.children);
  const views = makeViews(setup, spawns);
  resources.views.push(views);
  const server = await startDashboard(setup, views, { publicHost: "dashboard.example" });
  resources.servers.push(server);
  const port = server.address().port;
  const token = await stateToken(port);
  const path = "/api/assignment-terminal/open";
  const body = JSON.stringify({ assignment_id: id });
  const good = openHeaders(port, token);
  const without = (headers, name) => {
    const copy = { ...headers };
    delete copy[name];
    return copy;
  };

  const refusals = [
    ["wrong token", { ...good, "X-Sentinel-Token": "0".repeat(64) }],
    ["empty token", { ...good, "X-Sentinel-Token": "" }],
    ["missing token", without(good, "X-Sentinel-Token")],
    ["wrong content type", { ...good, "Content-Type": "text/plain" }],
    ["missing Origin", without(good, "Origin")],
    ["foreign Origin", { ...good, Origin: "https://evil.example" }],
    ["other local-host Origin", { ...good, Origin: `http://localhost:${port}` }],
    ["mismatched local Host", { ...good, Host: `localhost:${port}` }],
    ["forwarding x-forwarded-for", { ...good, "X-Forwarded-For": "" }],
    ["forwarding x-forwarded-host", { ...good, "X-Forwarded-Host": "" }],
    ["forwarding forwarded", { ...good, Forwarded: "" }],
    ["forwarding tailscale-user-login", { ...good, "Tailscale-User-Login": "" }],
  ];
  for (const [label, headers] of refusals) {
    const response = await postOpen(port, headers, body);
    assert.equal(response.status, 403, label);
    assert.equal(response.json?.diagnostics, undefined, label);
  }
  const publicHost = await postOpen(port, { ...good, Host: "dashboard.example", Origin: "https://dashboard.example" }, body);
  assert.equal(publicHost.status, 403, "public host");
  assert.equal(publicHost.json?.diagnostics, undefined, "public host");
  assert.equal((await call(port, path, { method: "GET", headers: good })).status, 405, "wrong method");
  for (const [label, raw] of [
    ["invalid JSON", "{"],
    ["missing body id", "{}"],
    ["invalid UUID", JSON.stringify({ assignment_id: "not-a-uuid" })],
    ["array body", "[]"],
  ]) {
    const response = await postOpen(port, good, raw);
    assert.equal(response.status, 400, label);
    assert.equal(response.json?.state, undefined, `${label} uses no non-allowlisted state`);
    assert.equal(response.json?.diagnostics, undefined, label);
  }
  assert.equal((await postOpen(port, good, `{"assignment_id":"${"x".repeat(4096)}"}`)).status, 413, "oversized body");
  assert.equal(spawns.calls.length, 0, "no refusal spawns the stream owner");

  const live = await postOpen(port, good, body);
  assert.equal(live.status, 200);
  assert.deepEqual(
    { assignment_id: live.json.assignment_id, state: live.json.state },
    { assignment_id: id, state: "live" },
  );
  assert.ok(Number.isSafeInteger(live.json.cols) && live.json.cols > 0, "window width");
  assert.ok(Number.isSafeInteger(live.json.rows) && live.json.rows > 0, "window height");
  await waitFor(() => spawns.calls.length === 1, { label: "one owned child" });

  const asset = await call(port, `/api/assignment-terminal/${id}/unknown.js`);
  assert.equal(asset.status, 404);
  assert.equal(asset.json.state, "not-running");
  assert.equal(asset.json.diagnostics, undefined);
  assert.doesNotMatch(asset.body, /TERMINAL_VIEW|Live streaming|fixture\.log/, "no child diagnostics cross HTTP");
  assert.equal(spawns.calls.length, 1, "unknown assets never spawn");
});

test("terminal routes 2: raw upgrades enforce exact locality/path and proxy a live stream", { timeout: 30000 }, async (t) => {
  const setup = await makeSetup();
  const resources = trackResources(setup);
  cleanupAll(t, setup, resources);
  const id = randomUUID();
  const tmuxServer = await startTmuxAgent(setup, id);
  await addRecord(setup, {
    assignment_id: id,
    tmux_socket: tmuxServer.socket,
    tmux_session: tmuxServer.session,
    pane_id: tmuxServer.paneId,
    pi_identity: tmuxServer.identity,
  });
  const spawns = captureSpawn({ TERMINAL_VIEW_LOG: join(setup.root, "fixture.log") }, resources.children);
  const views = makeViews(setup, spawns);
  resources.views.push(views);
  const server = await startDashboard(setup, views, { publicHost: "dashboard.example" });
  resources.servers.push(server);
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const path = `/api/assignment-terminal/${id}/ws`;

  // Authenticated shape, no ready entry: the owner refuses 409 and never spawns.
  await refuseUpgrade(rawUpgrade(port, path, { origin }), 409, "not-running");
  assert.equal(spawns.calls.length, 0);

  // Only the exact UUID /ws path reaches the owner.
  for (const wrong of [
    `/api/assignment-terminal/${id}/socket`,
    "/api/assignment-terminal/not-a-uuid/ws",
    `${path}?stale=1`,
  ]) {
    await refuseUpgrade(rawUpgrade(port, wrong, { origin }), 404, `path ${wrong}`);
  }

  // Host, Origin and forwarding markers are all required exactly.
  const denied = [
    ["foreign Host", { host: `remote.example:${port}`, origin }],
    ["public Host", { host: "dashboard.example", origin: "https://dashboard.example" }],
    ["missing Origin", { host: `127.0.0.1:${port}`, origin: null }],
    ["foreign Origin", { host: `127.0.0.1:${port}`, origin: "https://evil.example" }],
    ["other local Origin", { host: `127.0.0.1:${port}`, origin: `http://localhost:${port}` }],
    ["mismatched local Host", { host: `localhost:${port}`, origin }],
    ["forwarding header", { host: `127.0.0.1:${port}`, origin, extra: { "X-Forwarded-For": "" } }],
  ];
  for (const [label, variant] of denied) {
    await refuseUpgrade(rawUpgrade(port, path, variant), 403, label);
  }
  assert.equal(spawns.calls.length, 0, "no refused upgrade spawns the stream owner");

  const token = await stateToken(port);
  const live = await postOpen(port, openHeaders(port, token), JSON.stringify({ assignment_id: id }));
  assert.equal(live.status, 200);
  await waitFor(() => spawns.calls.length === 1, { label: "live child" });

  const viewer = rawUpgrade(port, path, { origin });
  resources.viewers.push(viewer);
  await viewer.ready;
  await waitFor(() => viewer.data.includes(Buffer.from("101 Switching Protocols")), { label: "authorized 101" });
  viewer.write("PING");
  await waitFor(() => viewer.data.includes(Buffer.from("PING")), { label: "viewer echo" });

  const asset = await call(port, `/api/assignment-terminal/${id}/asciinema-player.min.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.body, /__terminalViewFixture/);
  assert.equal(spawns.calls.length, 1);
});

test("terminal routes 3: owned shutdown drains the terminal child before the stop settles", { timeout: 30000 }, async (t) => {
  const setup = await makeSetup();
  const resources = trackResources(setup);
  cleanupAll(t, setup, resources);
  const id = randomUUID();
  const tmuxServer = await startTmuxAgent(setup, id);
  await addRecord(setup, {
    assignment_id: id,
    tmux_socket: tmuxServer.socket,
    tmux_session: tmuxServer.session,
    pane_id: tmuxServer.paneId,
    pi_identity: tmuxServer.identity,
  });
  const logPath = join(setup.root, "fixture.log");
  const spawns = captureSpawn({
    TERMINAL_VIEW_LOG: logPath,
    TERMINAL_VIEW_MODE: "delayed-term",
    TERMINAL_VIEW_TERM_DELAY_MS: "200",
  }, resources.children);
  const views = makeViews(setup, spawns);
  resources.views.push(views);
  const direct = createDirectDashboard({
    agentDir: join(setup.root, "agent"),
    storageRoot: setup.storageRoot,
    terminalViews: views,
  });
  resources.stops.push(() => direct.stop());
  const { url } = await direct.start();
  const port = Number(new URL(url).port);
  const token = await stateToken(port);
  const origin = `http://127.0.0.1:${port}`;

  const live = await postOpen(port, openHeaders(port, token), JSON.stringify({ assignment_id: id }));
  assert.equal(live.status, 200);
  await waitFor(() => spawns.calls.length === 1, { label: "live child" });
  const child = spawns.children[0];

  // Establish a real upgraded viewer before the stop begins.
  const viewer = rawUpgrade(port, `/api/assignment-terminal/${id}/ws`, { origin });
  resources.viewers.push(viewer);
  await viewer.ready;
  await waitFor(() => viewer.data.includes(Buffer.from("101 Switching Protocols")), { label: "viewer 101" });

  const stop = direct.stop();
  assert.equal(direct.stop(), stop, "repeated stops share the promise");
  let settled = false;
  stop.then(() => { settled = true; }, () => { settled = true; });
  await delay(60);
  assert.equal(settled, false, "stop waits for the delayed owned child exit, not the HTTP close");
  assert.equal(child.exitCode, null, "owned child is alive while the stop is pending");

  // Admission is disabled synchronously, before the drain can finish.
  await assert.rejects(views.open(id), (error) => {
    assert.equal(error.state, "busy");
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(spawns.calls.length, 1, "shutdown never respawns");

  await waitFor(() => viewer.closed, { label: "viewer destroyed by stop" });
  const outcome = await exited(child);
  assert.ok(outcome.code !== null || outcome.signal !== null, "owned child actually exited");
  await stop;
  assert.equal(settled, true);
  const log = await readLog(logPath);
  assert.ok(log.some((entry) => entry.event === "term" && entry.pid === child.pid), "fixture saw SIGTERM");
  assert.ok(log.some((entry) => entry.event === "exit" && entry.pid === child.pid), "fixture exited");

  // A rejecting drain surfaces through the same shared stop promise; the stop
  // stays pending until the drain settles and never silently times out early.
  const drainGate = deferred();
  const failing = createDirectDashboard({
    agentDir: join(setup.root, "agent"),
    storageRoot: setup.storageRoot,
    terminalViews: { closeAll: () => drainGate.promise },
  });
  resources.stops.push(() => failing.stop());
  const failingReady = await failing.start();
  const failingPort = Number(new URL(failingReady.url).port);
  assert.ok(failingPort > 0);
  const failingStop = failing.stop();
  let failureSettled = false;
  failingStop.then(() => { failureSettled = true; }, () => { failureSettled = true; });
  await delay(50);
  assert.equal(failureSettled, false, "a pending drain holds the stop open");
  assert.equal(failing.stop(), failingStop, "the pending failing stop is shared");
  drainGate.reject(Object.assign(new Error("Terminal streams did not drain in time."), { state: "failed", status: 503 }));
  await assert.rejects(failingStop, { message: "Terminal streams did not drain in time." });
  assert.equal(failing.stop(), failingStop, "the rejected stop remains the shared promise");
});

test("terminal routes 4: the Sentinel owner stops the standalone helper and drains its stream child", { timeout: 30000 }, async (t) => {
  const setup = await makeSetup();
  const resources = trackResources(setup);
  cleanupAll(t, setup, resources);
  const id = randomUUID();
  const tmuxServer = await startTmuxAgent(setup, id);
  await addRecord(setup, {
    assignment_id: id,
    tmux_socket: tmuxServer.socket,
    tmux_session: tmuxServer.session,
    pane_id: tmuxServer.paneId,
    pi_identity: tmuxServer.identity,
  });
  const logPath = join(setup.root, "fixture.log");
  const binDir = join(setup.root, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, "asciinema"),
    `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`,
    { mode: 0o755 },
  );
  let child;
  const service = createSentinelDashboard({
    agentDir: join(setup.root, "agent"),
    storageRoot: setup.storageRoot,
    open: async () => {},
    launch: (file, args, options) => {
      child = fork(file, args, {
        ...options,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          TERMINAL_VIEW_LOG: logPath,
          TERMINAL_VIEW_MODE: "delayed-term",
          TERMINAL_VIEW_TERM_DELAY_MS: "200",
        },
      });
      resources.children.push(child);
      return child;
    },
  });
  // Cleanup on a failed assertion terminates the helper gracefully so its
  // owned stream drains before the bounded SIGKILL fallback.
  resources.stops.push(() => service.stop());
  const ready = await service.start();
  let earlyExit = null;
  child.once("exit", (code, signal) => { earlyExit = { code, signal }; });

  const port = Number(new URL(ready.url).port);
  const token = await stateToken(port);
  const live = await postOpen(port, openHeaders(port, token), JSON.stringify({ assignment_id: id }));
  assert.equal(live.status, 200);
  const stream = (await readLog(logPath)).find(entry => entry.event === "start");
  assert.ok(stream, "fixture stream process started");
  const streamIdentity = await processIdentity(stream.pid);
  assert.ok(streamIdentity);
  // Failure cleanup covers the descendant too, without signalling a reused PID.
  resources.stops.push(async () => {
    if (sameProcess(streamIdentity)) {
      process.kill(stream.pid, "SIGTERM");
      await waitFor(() => inspectProcess(stream.pid).state === "dead", { label: "fixture cleanup exit" });
    }
  });
  const viewer = rawUpgrade(port, `/api/assignment-terminal/${id}/ws`, { origin: `http://127.0.0.1:${port}` });
  resources.viewers.push(viewer);
  await viewer.ready;
  await waitFor(() => viewer.data.includes(Buffer.from("101 Switching Protocols")), { label: "CLI viewer 101" });

  const signalledAt = Date.now();
  const stopped = service.stop();
  assert.equal(service.stop(), stopped, "repeated owner stops share the drain");
  await stopped;
  await waitFor(() => viewer.closed, { label: "CLI viewer destroyed" });
  const outcome = await waitFor(() => earlyExit, { label: "helper exit", timeout: 5000 });
  assert.deepEqual(outcome, { code: 0, signal: null }, "the helper exits cleanly after the drain");
  assert.ok(Date.now() - signalledAt >= 150, "the helper waited for the delayed owned child exit");
  const log = await readLog(logPath);
  assert.ok(log.some((entry) => entry.event === "term"), "fixture saw SIGTERM");
  assert.ok(log.some((entry) => entry.event === "exit"), "fixture exited before the helper");
  assert.equal(inspectProcess(stream.pid).state, "dead", "the owned stream process actually exited");
});

test("terminal routes 5: shell CSP carries the scoped player allowances, documents do not", { timeout: 20000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "terminal-routes-csp-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storageRoot = join(root, "storage");
  await setupStorage(storageRoot);
  const workspace = await createWorkspace(storageRoot, { id: "demo" });
  await writeFile(join(workspace.directory, "docs.md"), "# Demo docs\n");
  const pkg = join(workspace.directory, "specs", "feature");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "spec.md"), "# Feature spec\n");
  const observers = join(root, "agent", "spec-sentinel", "a".repeat(64), "observers");
  await mkdir(observers, { recursive: true });
  await writeFile(join(observers, "a.json"), JSON.stringify({
    schema_version: 1,
    observer_id: "a",
    state: "observing",
    published_at: new Date().toISOString(),
    snapshot: { runs: [{ package: pkg, workspace: "demo" }] },
  }));

  const server = createDashboardServer({ agentDir: join(root, "agent"), storageRoot });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await server.closeTerminalViews().catch(() => {});
    await closeServer(server);
  });
  const port = server.address().port;

  for (const path of ["/", "/dashboard.html"]) {
    const page = await call(port, path);
    assert.equal(page.status, 200, path);
    const csp = page.headers["content-security-policy"];
    assert.match(csp, /'wasm-unsafe-eval'/, path);
    assert.doesNotMatch(csp, /'unsafe-eval'/, `${path} has no general eval allowance`);
    assert.ok(csp.includes(`ws://127.0.0.1:${port}`), `${path} exact loopback ws origin`);
    assert.ok(csp.includes(`ws://localhost:${port}`), `${path} exact localhost ws origin`);
    assert.match(csp, /connect-src 'self' ws:\/\/127\.0\.0\.1:\d+ ws:\/\/localhost:\d+;/, path);
  }

  const documents = [
    `/package-view/${Buffer.from(pkg).toString("base64url")}/spec.md`,
    `/workspace-view/${Buffer.from("demo").toString("base64url")}/docs.md`,
    "/api/state",
  ];
  for (const path of documents) {
    const document = await call(port, path);
    assert.equal(document.status, 200, path);
    const csp = document.headers["content-security-policy"];
    assert.doesNotMatch(csp, /wasm-unsafe-eval/, path);
    assert.doesNotMatch(csp, /ws:\/\//, path);
    if (path !== "/api/state") {
      assert.match(csp, /sandbox allow-scripts/, path);
      assert.match(csp, /connect-src 'none'/, path);
    }
  }
});
