// Focused boundary tests for the identity-bound terminal stream owner.
//
// All cases:       node --test scripts/spec-observe/terminal-view.test.mjs
// One scenario:    node --test --test-name-pattern="terminal view 1" scripts/spec-observe/terminal-view.test.mjs
//                  ... "terminal view 2" ... "terminal view 3" ... "terminal view 4" ... "terminal view 5"
//
// Disposable production-shaped assignment records are resolved by the real
// findAssignment; verification/identity and the tmux size boundary are
// injected except in scenario 5, which uses the default verifyTerminal
// against a live test-owned process identity. The final process boundary is a
// test-owned executable (fixtures/terminal-view-stream.mjs) reached through a
// wrapper that spawns real ChildProcess handles and records argv/env; all
// manager-initiated signals only ever reach those owned handles. Real http and
// net traffic flows through a lightweight test server that delegates to the
// manager's API. Every wait is bounded and every test cleans up on failure.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { quote } from "../workspaces/session-control.mjs";
import { processIdentity, sameProcess } from "./process-identity.mjs";
import { createTerminalViews } from "./terminal-view.mjs";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "terminal-view-stream.mjs");

function ok(stdout = "") {
  return { ok: true, code: 0, stdout, stderr: "" };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout = 3000, interval = 10, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(interval);
  }
}

async function makeSetup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "terminal-view-")));
  const storageRoot = join(root, "storage");
  const workspaceId = "terminal-fixture";
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

async function assignmentBytes(setup) {
  const directory = join(setup.workspaceDirectory, "assignments");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const snapshot = {};
  for (const name of names) {
    snapshot[name] = (await readFile(join(directory, name))).toString("base64");
  }
  return snapshot;
}

function windowSizeRun({ size = "200 50", gate = null } = {}) {
  const calls = [];
  const run = async (socketPath, args) => {
    calls.push({ socketPath, args });
    if (args[0] === "has-session") return ok();
    if (args[0] === "list-clients") return ok();
    if (args[0] === "display-message") {
      if (gate !== null) await gate;
      return ok(`${size}\n`);
    }
    return ok();
  };
  return { run, calls };
}

function fixedVerify(identity) {
  return async () => ({ pane: { status: "present" }, exact: true, ended: false, identity });
}

function captureSpawn(fixtureEnv) {
  const calls = [];
  const children = [];
  const spawnProcess = (command, args, options) => {
    const child = spawn(command, args, { ...options, env: { ...options.env, ...fixtureEnv } });
    calls.push({ command, args, options });
    children.push(child);
    return child;
  };
  return { spawnProcess, calls, children };
}

function liveChildren(children) {
  return children.filter((child) => child.exitCode === null && child.signalCode === null);
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

function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

// A never-spawned handle emits no 'exit'; every other killed handle does.
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

function createProxyServer(views, observeUpgrade = null) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const asset = /^\/api\/terminal\/([0-9a-f-]{36})\/([^/]+)$/.exec(path);
    if (asset !== null) {
      views.handleAsset(request, response, asset[1], asset[2]);
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found");
  });
  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const match = /^\/api\/terminal\/([0-9a-f-]{36})\/ws$/.exec(path);
    if (match !== null) {
      if (observeUpgrade !== null) observeUpgrade(head);
      void views.handleUpgrade(request, socket, head, match[1]);
      return;
    }
    socket.destroy();
  });
  return server;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  server.closeAllConnections?.();
  await bounded(new Promise((resolve) => server.close(resolve)), 2000);
}

function fetchAsset(port, id, name) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path: `/api/terminal/${id}/${name}` },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode, headers: response.headers, body });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function abortAsset(port, id, name) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path: `/api/terminal/${id}/${name}` },
      (response) => {
        response.once("data", () => {
          response.destroy();
          resolve();
        });
        response.once("error", () => resolve());
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function assetCloseOutcome(port, id, name) {
  const started = deferred();
  const finished = new Promise((resolve) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path: `/api/terminal/${id}/${name}` },
      (response) => {
        let ended = false;
        response.on("data", () => started.resolve());
        response.on("end", () => {
          ended = true;
        });
        response.on("close", () => resolve({ ended }));
        response.on("error", () => resolve({ ended }));
      },
    );
    request.on("error", () => resolve({ ended: false }));
    request.end();
  });
  return { started: started.promise, finished };
}

function rawUpgrade(port, path, { head = "", headers = {} } = {}) {
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
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      ];
      socket.write(`${lines.join("\r\n")}\r\n\r\n${head}`);
      resolve();
    });
  });
  state.write = (value) => socket.write(value);
  state.end = () => socket.destroy();
  return state;
}

function makeViews(setup, options = {}) {
  return createTerminalViews({
    storageRoot: setup.storageRoot,
    asciinema: options.asciinema ?? FIXTURE,
    maxStreams: options.maxStreams ?? 4,
    startTimeoutMs: options.startTimeoutMs ?? 2000,
    startIdleMs: options.startIdleMs ?? 60000,
    graceMs: options.graceMs ?? 60000,
    spawnProcess: options.spawns.spawnProcess,
    tmuxRun: options.tmuxRun,
    verify: options.verify,
  });
}

function cleanupAll(t, setup, resources) {
  t.after(async () => {
    try {
      // Owned streams close before the HTTP servers: upgraded sockets are
      // excluded from closeAllConnections and would otherwise stall close.
      for (const views of resources.views) await views.closeAll().catch(() => {});
      for (const server of resources.servers) await closeServer(server);
    } finally {
      killChildren(resources.children);
      await settleChildren(resources.children);
      await rm(setup.root, { recursive: true, force: true });
    }
  });
}

test("terminal view 1: concurrent open reserves before size and caps pending entries", { timeout: 15000 }, async (t) => {
  const setup = await makeSetup();
  const records = [];
  for (let index = 0; index < 5; index += 1) records.push(await addRecord(setup));
  const before = await assignmentBytes(setup);
  const gate = deferred();
  const sizeRun = windowSizeRun({ gate: gate.promise });
  const fixtureEnv = { TERMINAL_VIEW_LOG: join(setup.root, "fixture.log") };
  const spawns = captureSpawn(fixtureEnv);
  const originalTerm = process.env.TERM;
  delete process.env.TERM;
  const views = makeViews(setup, {
    spawns,
    tmuxRun: sizeRun.run,
    verify: fixedVerify("identity-1"),
  });
  cleanupAll(t, setup, { servers: [], views: [views], children: spawns.children });
  t.after(() => {
    if (originalTerm === undefined) delete process.env.TERM;
    else process.env.TERM = originalTerm;
  });

  const first = views.open(records[0].assignment_id);
  const repeat = views.open(records[0].assignment_id);
  const pending = [
    views.open(records[1].assignment_id),
    views.open(records[2].assignment_id),
    views.open(records[3].assignment_id),
  ];
  await waitFor(
    () => sizeRun.calls.filter((call) => call.args[0] === "display-message").length === 4,
    { label: "four reservations before async size" },
  );
  await assert.rejects(
    views.open(records[4].assignment_id),
    (error) => {
      assert.equal(error.state, "busy");
      assert.equal(error.status, 503);
      return true;
    },
  );
  gate.resolve();
  const [live, shared, live2, live3, live4] = await Promise.all([first, repeat, ...pending]);
  assert.deepEqual(live, {
    assignment_id: records[0].assignment_id,
    state: "live",
    cols: 200,
    rows: 50,
  });
  assert.deepEqual(shared, live);
  assert.equal(live2.assignment_id, records[1].assignment_id);
  assert.equal(live3.assignment_id, records[2].assignment_id);
  assert.equal(live4.assignment_id, records[3].assignment_id);
  await waitFor(() => spawns.calls.length === 4, { label: "one child per reserved entry" });
  const sharedSpawn = spawns.calls.filter((call) => call.args[6].includes(`=${records[0].tmux_session}`));
  assert.equal(sharedSpawn.length, 1);

  const record = records[0];
  const command = [
    "tmux",
    "-S",
    record.tmux_socket,
    "attach-session",
    "-t",
    `=${record.tmux_session}`,
    "-f",
    "read-only,ignore-size",
  ].map(quote).join(" ");
  const call = sharedSpawn[0];
  assert.deepEqual(call.args, [
    "stream",
    "--local",
    "--headless",
    "--window-size",
    "200x50",
    "-c",
    command,
  ]);
  assert.ok(call.args[6].includes("'read-only,ignore-size'"));
  assert.equal(call.options.detached, false);
  assert.deepEqual(call.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(call.options.env.TERM, "xterm-256color");
  assert.ok(spawns.calls.every((entry) => entry.command === FIXTURE));
  assert.deepEqual(await assignmentBytes(setup), before);
});

test("terminal view 2: existing-entry assets and raw upgrade proxy", { timeout: 15000 }, async (t) => {
  const setup = await makeSetup();
  const liveRecord = await addRecord(setup);
  const otherRecord = await addRecord(setup);
  const before = await assignmentBytes(setup);
  const logPath = join(setup.root, "fixture.log");
  const fixtureEnv = { TERMINAL_VIEW_LOG: logPath, TERMINAL_VIEW_ASSET_DELAY_MS: "120" };
  const spawns = captureSpawn(fixtureEnv);
  const views = makeViews(setup, {
    spawns,
    tmuxRun: windowSizeRun({}).run,
    verify: fixedVerify("identity-2"),
    graceMs: 300,
  });
  const initiatingHeads = [];
  const server = createProxyServer(views, (supplied) => initiatingHeads.push(Buffer.from(supplied)));
  const port = await listen(server);
  cleanupAll(t, setup, { servers: [server], views: [views], children: spawns.children });

  const live = await views.open(liveRecord.assignment_id);
  assert.equal(live.state, "live");
  assert.equal(spawns.calls.length, 1);

  const refused = rawUpgrade(port, `/api/terminal/${otherRecord.assignment_id}/ws`);
  await refused.ready;
  await waitFor(() => refused.data.length > 0, { label: "upgrade refusal" });
  assert.match(refused.data.toString("latin1"), /^HTTP\/1\.1 409/);
  await waitFor(() => refused.closed, { label: "refusal close" });
  assert.equal(spawns.calls.length, 1);

  assert.equal((await fetchAsset(port, liveRecord.assignment_id, "unknown.js")).status, 404);
  assert.equal((await fetchAsset(port, otherRecord.assignment_id, "asciinema-player.min.js")).status, 404);
  assert.equal(spawns.calls.length, 1);

  const js = await fetchAsset(port, liveRecord.assignment_id, "asciinema-player.min.js");
  assert.equal(js.status, 200);
  assert.match(js.headers["content-type"], /javascript/);
  assert.match(js.body, /__terminalViewFixture/);
  const css = await fetchAsset(port, liveRecord.assignment_id, "asciinema-player.css");
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"], /text\/css/);
  assert.match(css.body, /#123456/);

  await abortAsset(port, liveRecord.assignment_id, "asciinema-player.min.js");
  await waitFor(
    async () => (await readLog(logPath)).some((entry) => entry.event === "asset-close" && entry.ended === false),
    { label: "client abort reaches the upstream asset response" },
  );

  const head = "HEAD-BYTES";
  const origin = `http://127.0.0.1:${port}`;
  const viewer = rawUpgrade(port, `/api/terminal/${liveRecord.assignment_id}/ws`, {
    headers: { "Sec-WebSocket-Protocol": "v1.alis", Origin: origin },
    head,
  });
  await viewer.ready;
  await waitFor(() => viewer.data.includes(Buffer.from("101 Switching Protocols")), { label: "viewer handshake" });
  await waitFor(() => viewer.data.includes(Buffer.from(head)), { label: "head echo" });
  viewer.write("PING-1");
  await waitFor(() => viewer.data.includes(Buffer.from("PING-1")), { label: "viewer echo" });
  const upgrades = (await readLog(logPath)).filter((entry) => entry.event === "upgrade");
  assert.equal(upgrades.length, 1);
  // The initiating head is observed at the manager's upgrade boundary; TCP
  // may deliver it to the upstream parser as a later chunk, so the exact
  // upstream headLength is intentionally not asserted.
  const observedHeads = initiatingHeads.filter((supplied) => supplied.length > 0);
  assert.equal(observedHeads.length, 1);
  assert.equal(observedHeads[0].toString("latin1"), head);
  assert.equal(upgrades[0].protocol, "v1.alis");
  assert.equal(upgrades[0].origin, origin);
  assert.match(upgrades[0].host ?? "", /^127\.0\.0\.1:\d+$/);
  assert.equal(viewer.data.toString("latin1").split(head).length - 1, 1);

  const viewerB = rawUpgrade(port, `/api/terminal/${liveRecord.assignment_id}/ws`, {
    headers: { "Sec-WebSocket-Protocol": "v1.alis" },
  });
  await viewerB.ready;
  await waitFor(() => viewerB.data.includes(Buffer.from("101")), { label: "second viewer handshake" });
  viewer.end();
  await waitFor(() => viewer.closed, { label: "first viewer closed" });
  viewerB.write("PING-2");
  await waitFor(() => viewerB.data.includes(Buffer.from("PING-2")), { label: "second viewer echo" });
  assert.equal(liveChildren(spawns.children).length, 1);

  viewerB.end();
  await waitFor(() => viewerB.closed, { label: "second viewer closed" });
  const viewerC = rawUpgrade(port, `/api/terminal/${liveRecord.assignment_id}/ws`, {
    headers: { "Sec-WebSocket-Protocol": "v1.alis" },
  });
  await viewerC.ready;
  await waitFor(() => viewerC.data.includes(Buffer.from("101")), { label: "reconnect handshake" });
  await delay(600);
  assert.equal(spawns.calls.length, 1);
  assert.equal(liveChildren(spawns.children).length, 1, "reconnect cancels the grace timer");
  const streamChild = spawns.children[0];
  viewerC.end();
  // The last-viewer grace window is still pending: the child survives before
  // expiry, then stops on its own and never respawns.
  await delay(120);
  assert.equal(streamChild.exitCode, null, "child survives before grace expiry");
  assert.equal(streamChild.signalCode, null, "child survives before grace expiry");
  await waitFor(
    async () => (await readLog(logPath)).some(
      (entry) => entry.event === "term" && entry.pid === streamChild.pid,
    ),
    { label: "last-viewer grace TERM" },
  );
  await exited(streamChild);
  assert.equal(spawns.calls.length, 1, "grace stop does not spawn a replacement");

  assert.deepEqual(await assignmentBytes(setup), before);
  assert.ok(spawns.calls.every((entry) => entry.command === FIXTURE));
});

test("terminal view 3: idle/grace stops, identity replacement and natural exit", { timeout: 15000 }, async (t) => {
  const setup = await makeSetup();
  const logPath = join(setup.root, "fixture.log");
  const fixtureEnv = { TERMINAL_VIEW_LOG: logPath, TERMINAL_VIEW_MODE: "delayed-term" };
  const spawns = captureSpawn(fixtureEnv);
  const views = makeViews(setup, {
    spawns,
    tmuxRun: windowSizeRun({}).run,
    verify: fixedVerify("identity-3"),
    maxStreams: 1,
    startIdleMs: 80,
    graceMs: 120,
  });
  const resources = { servers: [], views: [views], children: spawns.children };
  cleanupAll(t, setup, resources);

  // A ready entry that was never viewed stops itself; capacity stays counted
  // until the actual child exit.
  const idleRecord = await addRecord(setup);
  const idleNext = await addRecord(setup);
  const idle = await views.open(idleRecord.assignment_id);
  assert.equal(idle.state, "live");
  const idleChild = spawns.children.at(-1);
  await waitFor(
    async () => (await readLog(logPath)).some((entry) => entry.event === "term"),
    { label: "idle TERM" },
  );
  await assert.rejects(
    views.open(idleNext.assignment_id),
    (error) => {
      assert.equal(error.state, "busy");
      return true;
    },
  );
  await exited(idleChild);
  fixtureEnv.TERMINAL_VIEW_MODE = "ready";
  const afterIdle = await waitFor(
    async () => {
      try {
        return await views.open(idleNext.assignment_id);
      } catch {
        return null;
      }
    },
    { label: "capacity after actual exit" },
  );
  assert.equal(afterIdle.state, "live");

  // A changed verified identity stops the old stream and starts one replacement.
  const identity = { value: "identity-a" };
  const replaceRecord = await addRecord(setup);
  const replacing = makeViews(setup, {
    spawns,
    tmuxRun: windowSizeRun({}).run,
    verify: async () => ({
      pane: { status: "present" },
      exact: true,
      ended: false,
      identity: identity.value,
    }),
  });
  resources.views.push(replacing);
  const liveA = await replacing.open(replaceRecord.assignment_id);
  assert.equal(liveA.state, "live");
  const oldChild = spawns.children.at(-1);
  const spawnCount = spawns.calls.length;
  identity.value = "identity-b";
  const liveNew = await replacing.open(replaceRecord.assignment_id);
  assert.equal(liveNew.assignment_id, replaceRecord.assignment_id);
  assert.equal(spawns.calls.length, spawnCount + 1);
  await exited(oldChild);
  const spawnBefore = spawns.calls.length;
  const shared = await replacing.open(replaceRecord.assignment_id);
  assert.deepEqual(shared, liveNew);
  assert.equal(spawns.calls.length, spawnBefore, "late old exit cannot delete the replacement");

  // A natural child exit closes its viewers and refuses later upgrades.
  fixtureEnv.TERMINAL_VIEW_MODE = "ready";
  fixtureEnv.TERMINAL_VIEW_EXIT_AFTER_MS = "400";
  const exitRecord = await addRecord(setup);
  const exiting = makeViews(setup, {
    spawns,
    tmuxRun: windowSizeRun({}).run,
    verify: fixedVerify("identity-4"),
  });
  resources.views.push(exiting);
  const exitServer = createProxyServer(exiting);
  resources.servers.push(exitServer);
  const exitPort = await listen(exitServer);
  const liveExit = await exiting.open(exitRecord.assignment_id);
  assert.equal(liveExit.state, "live");
  const exitChild = spawns.children.at(-1);
  const exitViewer = rawUpgrade(exitPort, `/api/terminal/${exitRecord.assignment_id}/ws`, {
    headers: { "Sec-WebSocket-Protocol": "v1.alis" },
  });
  await exitViewer.ready;
  await waitFor(() => exitViewer.data.includes(Buffer.from("101")), { label: "exit viewer handshake" });
  await exited(exitChild);
  await waitFor(() => exitViewer.closed, { label: "viewer closed on child exit" });
  delete fixtureEnv.TERMINAL_VIEW_EXIT_AFTER_MS;
  const refused = rawUpgrade(exitPort, `/api/terminal/${exitRecord.assignment_id}/ws`);
  await refused.ready;
  await waitFor(() => refused.data.length > 0, { label: "not-running refusal" });
  assert.match(refused.data.toString("latin1"), /^HTTP\/1\.1 409/);
});

test("terminal view 4: startup failures, upstream failure and closeAll drain", { timeout: 15000 }, async (t) => {
  const setup = await makeSetup();
  const logPath = join(setup.root, "fixture.log");
  const fixtureEnv = { TERMINAL_VIEW_LOG: logPath };
  const spawns = captureSpawn(fixtureEnv);
  const resources = { servers: [], views: [], children: spawns.children };
  cleanupAll(t, setup, resources);

  // Split readiness across stdout chunks still resolves live.
  fixtureEnv.TERMINAL_VIEW_MODE = "split";
  const splitRecord = await addRecord(setup);
  const splitViews = makeViews(setup, {
    spawns,
    tmuxRun: windowSizeRun({}).run,
    verify: fixedVerify("split"),
  });
  resources.views.push(splitViews);
  const splitLive = await splitViews.open(splitRecord.assignment_id);
  assert.equal(splitLive.state, "live");
  await splitViews.closeAll();

  async function openFailure(mode, expectedState, asciinema = FIXTURE) {
    fixtureEnv.TERMINAL_VIEW_MODE = mode;
    const record = await addRecord(setup);
    const views = makeViews(setup, {
      spawns,
      asciinema,
      startTimeoutMs: 250,
      tmuxRun: windowSizeRun({}).run,
      verify: fixedVerify(`failure-${mode}`),
    });
    resources.views.push(views);
    await assert.rejects(
      views.open(record.assignment_id),
      (error) => {
        assert.equal(error.state, expectedState);
        assert.equal(error.status, 503);
        return true;
      },
    );
    await waitFor(
      () => spawns.children.every((child) => child.exitCode !== null || child.signalCode !== null),
      { label: `exit after ${mode}`, timeout: 3000 },
    );
    return views;
  }

  for (const mode of ["none", "malformed", "foreign", "exit"]) {
    const views = await openFailure(mode, "failed");
    fixtureEnv.TERMINAL_VIEW_MODE = "ready";
    const reuseRecord = await addRecord(setup);
    const live = await views.open(reuseRecord.assignment_id);
    assert.equal(live.state, "live", `${mode} failure releases capacity after exit`);
    await views.closeAll();
  }

  // ENOENT is not-installed; the second attempt proving non-busy shows the
  // reservation was released immediately.
  fixtureEnv.TERMINAL_VIEW_MODE = "ready";
  const enoentRecord = await addRecord(setup);
  const enoentViews = makeViews(setup, {
    spawns,
    asciinema: join(setup.root, "missing-asciinema"),
    startTimeoutMs: 250,
    tmuxRun: windowSizeRun({}).run,
    verify: fixedVerify("enoent"),
  });
  resources.views.push(enoentViews);
  await assert.rejects(
    enoentViews.open(enoentRecord.assignment_id),
    (error) => {
      assert.equal(error.state, "not-installed");
      return true;
    },
  );
  const enoentNext = await addRecord(setup);
  await assert.rejects(
    enoentViews.open(enoentNext.assignment_id),
    (error) => {
      assert.notEqual(error.state, "busy");
      return true;
    },
  );

  // A failed upstream connection destroys both sockets and stops the child.
  fixtureEnv.TERMINAL_VIEW_MODE = "closed-upstream";
  const closedRecord = await addRecord(setup);
  const closedViews = makeViews(setup, {
    spawns,
    tmuxRun: windowSizeRun({}).run,
    verify: fixedVerify("closed"),
  });
  resources.views.push(closedViews);
  const closedServer = createProxyServer(closedViews);
  resources.servers.push(closedServer);
  const closedPort = await listen(closedServer);
  const closedLive = await closedViews.open(closedRecord.assignment_id);
  assert.equal(closedLive.state, "live");
  const closedChild = spawns.children.at(-1);
  const failedAsset = await fetchAsset(closedPort, closedRecord.assignment_id, "asciinema-player.min.js");
  assert.equal(failedAsset.status, 502);
  assert.equal(JSON.parse(failedAsset.body).state, "failed");
  const closedViewer = rawUpgrade(closedPort, `/api/terminal/${closedRecord.assignment_id}/ws`);
  await closedViewer.ready;
  await waitFor(() => closedViewer.closed, { label: "failed upstream closes viewer" });
  await waitFor(
    async () => (await readLog(logPath)).some((entry) => entry.event === "term"),
    { label: "failed upstream TERM" },
  );
  await exited(closedChild);
  fixtureEnv.TERMINAL_VIEW_MODE = "ready";
  const recoveredRecord = await addRecord(setup);
  const recovered = await closedViews.open(recoveredRecord.assignment_id);
  assert.equal(recovered.state, "live");
  await closedViews.closeAll();

  // closeAll while an asset body is still streaming destroys the upstream
  // response and the downstream response through the owned exchange.
  fixtureEnv.TERMINAL_VIEW_MODE = "ready";
  fixtureEnv.TERMINAL_VIEW_ASSET_DELAY_MS = "1000";
  const streamRecord = await addRecord(setup);
  const streamViews = makeViews(setup, {
    spawns,
    tmuxRun: windowSizeRun({}).run,
    verify: fixedVerify("stream"),
  });
  resources.views.push(streamViews);
  const streamServer = createProxyServer(streamViews);
  resources.servers.push(streamServer);
  const streamPort = await listen(streamServer);
  await streamViews.open(streamRecord.assignment_id);
  const streamed = assetCloseOutcome(streamPort, streamRecord.assignment_id, "asciinema-player.min.js");
  await streamed.started;
  const streamDrain = streamViews.closeAll();
  const streamOutcome = await streamed.finished;
  assert.equal(streamOutcome.ended, false, "stop destroys the streaming asset response");
  await streamDrain;
  delete fixtureEnv.TERMINAL_VIEW_ASSET_DELAY_MS;

  // closeAll during a deferred size read cancels the pending start and returns
  // one repeated drain promise.
  const gate = deferred();
  const slowRun = windowSizeRun({ gate: gate.promise });
  const slowRecord = await addRecord(setup);
  const slowViews = makeViews(setup, {
    spawns,
    tmuxRun: slowRun.run,
    verify: fixedVerify("slow"),
  });
  resources.views.push(slowViews);
  const pendingSize = slowViews.open(slowRecord.assignment_id);
  await waitFor(
    () => slowRun.calls.some((call) => call.args[0] === "display-message"),
    { label: "deferred size lookup" },
  );
  const spawnsBefore = spawns.calls.length;
  const drain = slowViews.closeAll();
  assert.equal(slowViews.closeAll(), drain);
  await assert.rejects(
    pendingSize,
    (error) => {
      assert.equal(error.state, "busy");
      return true;
    },
  );
  await assert.rejects(
    slowViews.open(slowRecord.assignment_id),
    (error) => {
      assert.equal(error.state, "busy");
      return true;
    },
  );
  gate.resolve();
  await drain;
  assert.equal(spawns.calls.length, spawnsBefore, "no spawn after closeAll");

  // closeAll during a spawned-but-not-ready startup stops the owned child,
  // rejects the in-flight open and leaves no reusable reservation behind.
  fixtureEnv.TERMINAL_VIEW_MODE = "none";
  const notReadyRecord = await addRecord(setup);
  const notReadyViews = makeViews(setup, {
    spawns,
    startTimeoutMs: 60000,
    tmuxRun: windowSizeRun({}).run,
    verify: fixedVerify("not-ready"),
  });
  resources.views.push(notReadyViews);
  const notReadySpawnCount = spawns.calls.length;
  const notReadyOpen = notReadyViews.open(notReadyRecord.assignment_id);
  const notReadyRejected = assert.rejects(
    notReadyOpen,
    (error) => {
      assert.equal(error.state, "busy");
      return true;
    },
  );
  await waitFor(
    () => spawns.calls.length === notReadySpawnCount + 1,
    { label: "not-ready child spawned" },
  );
  const notReadyChild = spawns.children.at(-1);
  await waitFor(
    async () => (await readLog(logPath)).some(
      (entry) => entry.event === "listening" && entry.pid === notReadyChild.pid,
    ),
    { label: "not-ready fixture listening" },
  );
  const notReadyDrain = notReadyViews.closeAll();
  await notReadyRejected;
  const notReadyOutcome = await exited(notReadyChild);
  assert.ok(
    notReadyOutcome.code !== null || notReadyOutcome.signal !== null,
    "startup child actually exited",
  );
  await notReadyDrain;
  assert.equal(spawns.calls.length, notReadySpawnCount + 1, "no replacement after startup shutdown");
  await assert.rejects(
    notReadyViews.open(notReadyRecord.assignment_id),
    (error) => {
      assert.equal(error.state, "busy");
      return true;
    },
  );
  fixtureEnv.TERMINAL_VIEW_MODE = "ready";

  // closeAll during a live startup escalates to SIGKILL and drains only owned
  // handles; a pending identity upgrade socket is destroyed and cannot
  // resurrect an upstream connection after its handler resumes.
  fixtureEnv.TERMINAL_VIEW_MODE = "ignore-term";
  const escalateRecord = await addRecord(setup);
  const escalateViews = makeViews(setup, {
    spawns,
    tmuxRun: windowSizeRun({}).run,
    verify: fixedVerify("escalate"),
  });
  resources.views.push(escalateViews);
  const escalateLive = await escalateViews.open(escalateRecord.assignment_id);
  assert.equal(escalateLive.state, "live");
  const escalateChild = spawns.children.at(-1);
  const escalateStarted = Date.now();
  const escalateDrain = escalateViews.closeAll();
  await escalateDrain;
  const outcome = await exited(escalateChild);
  assert.equal(outcome.signal, "SIGKILL");
  assert.ok(Date.now() - escalateStarted >= 450, "SIGTERM was given the escalation window");

  const verifyGate = deferred();
  let verifyCalls = 0;
  const pendingViews = makeViews(setup, {
    spawns,
    tmuxRun: windowSizeRun({}).run,
    verify: async () => {
      verifyCalls += 1;
      await verifyGate.promise;
      return { pane: { status: "present" }, exact: true, ended: false, identity: "pending" };
    },
  });
  resources.views.push(pendingViews);
  const pendingRecord = await addRecord(setup);
  const upgradeServer = createNetServer((socket) => {
    void pendingViews.handleUpgrade(
      { headers: { upgrade: "websocket" } },
      socket,
      Buffer.alloc(0),
      pendingRecord.assignment_id,
    );
  });
  resources.servers.push(upgradeServer);
  const upgradePort = await listen(upgradeServer);
  const pendingClient = netConnect({ host: "127.0.0.1", port: upgradePort });
  let pendingClientClosed = false;
  pendingClient.once("close", () => {
    pendingClientClosed = true;
  });
  await new Promise((resolve) => pendingClient.once("connect", resolve));
  await waitFor(() => verifyCalls === 1, { label: "identity verification started" });
  const pendingSpawns = spawns.calls.length;
  const pendingDrain = pendingViews.closeAll();
  await waitFor(() => pendingClientClosed, { label: "pending upgrade socket destroyed" });
  verifyGate.resolve();
  await pendingDrain;
  assert.equal(spawns.calls.length, pendingSpawns, "pending identity completion cannot spawn");
  assert.ok(spawns.calls.every((entry) => entry.command === FIXTURE || entry.command.endsWith("missing-asciinema")));
});

test("terminal view 5: default verification against a live record identity", { timeout: 15000 }, async (t) => {
  const setup = await makeSetup();
  const agent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const agentIdentity = processIdentity(agent.pid);
  assert.ok(agentIdentity !== null, "test-owned agent identity is observable");
  const fixtureEnv = { TERMINAL_VIEW_LOG: join(setup.root, "fixture.log") };
  const spawns = captureSpawn(fixtureEnv);
  const resources = { servers: [], views: [], children: spawns.children };
  cleanupAll(t, setup, resources);
  t.after(() => {
    if (agent.exitCode === null && agent.signalCode === null) agent.kill("SIGKILL");
  });

  const id = randomUUID();
  const endedId = randomUUID();
  const absentId = randomUUID();
  await addRecord(setup, { assignment_id: id, pi_identity: agentIdentity, pane_id: "%7" });
  await addRecord(setup, { assignment_id: endedId, pi_identity: agentIdentity, pane_id: "%7", state: "ended" });
  await addRecord(setup, { assignment_id: absentId, pi_identity: agentIdentity, pane_id: "%7" });
  const before = await assignmentBytes(setup);

  const probe = { hasSession: true, paneId: "%7", pid: agentIdentity.pid, size: "120 40", tag: id };
  const tmuxRun = async (socketPath, args) => {
    if (args[0] === "has-session") {
      return probe.hasSession
        ? ok()
        : { ok: false, code: 1, stdout: "", stderr: "no session", message: "tmux has-session failed" };
    }
    if (args[0] === "list-clients") return ok();
    if (args[0] === "show-options") return ok(`${probe.tag}\n`);
    if (args[0] === "display-message") {
      if (args[4] === "#{window_width} #{window_height}") return ok(`${probe.size}\n`);
      return ok(`${probe.paneId} ${probe.pid}\n`);
    }
    return ok();
  };
  const views = makeViews(setup, { spawns, tmuxRun });
  resources.views.push(views);

  const live = await views.open(id);
  assert.deepEqual(live, { assignment_id: id, state: "live", cols: 120, rows: 40 });

  probe.paneId = "%8";
  await assert.rejects(
    views.open(id),
    (error) => {
      assert.equal(error.state, "changed");
      assert.equal(error.status, 409);
      return true;
    },
  );
  probe.paneId = "%7";
  // A mismatched session tag is an explicit changed identity, not a
  // transport failure.
  probe.tag = randomUUID();
  await assert.rejects(
    views.open(id),
    (error) => {
      assert.equal(error.state, "changed");
      return true;
    },
  );
  probe.tag = id;
  probe.pid = agentIdentity.pid + 1;
  await assert.rejects(
    views.open(id),
    (error) => {
      assert.equal(error.state, "changed");
      return true;
    },
  );
  probe.pid = agentIdentity.pid;

  await assert.rejects(
    views.open(endedId),
    (error) => {
      assert.equal(error.state, "not-live");
      assert.equal(error.status, 404);
      return true;
    },
  );

  probe.hasSession = false;
  await assert.rejects(
    views.open(absentId),
    (error) => {
      assert.equal(error.state, "not-live");
      assert.equal(error.status, 404);
      return true;
    },
  );
  probe.hasSession = true;

  await assert.rejects(
    views.open(randomUUID()),
    (error) => {
      assert.equal(error.state, "not-live");
      assert.equal(error.status, 404);
      return true;
    },
  );

  await views.closeAll();
  assert.ok(sameProcess(agentIdentity), "record-owned agent process remains alive");
  assert.equal(agent.exitCode, null);
  assert.deepEqual(await assignmentBytes(setup), before);
  assert.ok(spawns.calls.every((entry) => entry.command === FIXTURE));
});
