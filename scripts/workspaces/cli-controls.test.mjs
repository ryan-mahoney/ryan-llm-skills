// Step 6 focused tests: CLI assignment controls.
//
// The ordinary CLI runs over isolated temp roots (short /tmp base for the
// tmux sun_path limit) with the fake Pi first in PATH and real git
// repositories. Attach cases use a native /usr/bin/script PTY supplied through
// a shell pipeline with a sleep holder and group-kill teardown. Cleanup signals
// only logged fixture PIDs and kills only owned socket servers.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sameProcess } from "../spec-observe/process-identity.mjs";
import { locateAssignment } from "./assignments.mjs";

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "cli.mjs");
const TEST_TIMEOUT_MS = 60000;

const FAKE_PI_SOURCE = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  pid: process.pid,
  at: new Date().toISOString(),
}) + '\\n');
process.stdout.write('READY\\n');
setInterval(() => {}, 1 << 30);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;

function git(cwd, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: 10000,
        killSignal: "SIGKILL",
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout, stderr) => {
        if (error) rejectPromise(new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`));
        else resolvePromise(stdout);
      },
    );
  });
}

async function makeRepo(directory) {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "--quiet"]);
  return realpath(directory);
}

function kitYaml({ id, name, repositories }) {
  const lines = [
    "version: 1",
    `id: ${JSON.stringify(id)}`,
    `name: ${JSON.stringify(name)}`,
  ];
  if (repositories.length === 0) {
    lines.push("repositories: []");
  } else {
    lines.push("repositories:");
    for (const repository of repositories) {
      lines.push(`  - id: ${JSON.stringify(repository.id)}`);
      lines.push(`    path: ${JSON.stringify(repository.path)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(50);
  }
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

function assignmentEntries(entries, id) {
  return entries.filter((entry) => {
    const index = entry.argv.indexOf("--session-id");
    return index !== -1 && entry.argv[index + 1] === id;
  });
}

async function waitForAssignmentLogEntry(logPath, id) {
  return waitFor(async () => assignmentEntries(await logEntries(logPath), id)[0] ?? null, `fake pi ${id}`);
}

function runCli(args, env) {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [CLI_PATH, ...args],
      {
        env,
        timeout: TEST_TIMEOUT_MS,
        killSignal: "SIGKILL",
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
    child.stdin.end();
  });
}

function parseRefusal(result) {
  assert.equal(result.code, 1, `expected refusal, got ${result.code}: ${result.stdout}`);
  const envelopes = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  assert.ok(envelopes.length > 0, `refusal envelope not found in stderr: ${result.stderr}`);
  const parsed = JSON.parse(envelopes[envelopes.length - 1]);
  assert.equal(typeof parsed.error, "string");
  assert.ok(parsed.error.length > 0, "refusal must carry an error message");
  return parsed;
}

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
  assert.equal(result.ok, true, `tmux ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function sessionNames(socketPath) {
  const result = await tmuxExec(socketPath, ["list-sessions", "-F", "#{session_name}"]);
  if (!result.ok) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

async function waitForClient(socketPath, sessionName) {
  return waitFor(async () => {
    const result = await tmuxExec(socketPath, ["list-clients", "-F", "#{client_name} #{client_session}"]);
    if (!result.ok) return null;
    for (const line of result.stdout.split("\n")) {
      const match = /^(\S+) (\S+)$/.exec(line.trim());
      if (match && match[2] === sessionName) return match[1];
    }
    return null;
  }, `attach client for ${sessionName}`);
}

async function waitForClientGone(socketPath, sessionName) {
  return waitFor(async () => {
    const result = await tmuxExec(socketPath, ["list-clients", "-F", "#{client_name} #{client_session}"]);
    if (!result.ok) return true;
    return result.stdout.split("\n").some((line) => line.trim().endsWith(` ${sessionName}`)) ? null : true;
  }, `client for ${sessionName} to detach`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// Native PTY through a real shell pipe; the sleep holder keeps the feeder open
// for the whole attach session and dies with the group kill.
function spawnPty(argumentVector, env) {
  const command = `(exec sleep 60) | exec /usr/bin/script -q /dev/null ${argumentVector
    .map(shellQuote)
    .join(" ")}`;
  const child = spawn("/bin/sh", ["-c", command], {
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  return { child, output: () => ({ stdout, stderr }) };
}

function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => child.once("close", resolvePromise));
}

async function waitForPtyText(pty, needle, label) {
  return waitFor(() => (pty.output().stdout.includes(needle) ? true : null), label);
}

async function readRecord(workspaceDirectory, id) {
  return JSON.parse(await readFile(join(workspaceDirectory, "assignments", `${id}.json`), "utf8"));
}

async function cliLaunch(fixture, { target, id, instructions }) {
  const args = [
    "launch", fixture.workspaceId,
    "--brief", "briefs/brief.md",
    "--instructions", instructions,
    "--id", id,
    "--target", target,
    "--json",
  ];
  const previewRun = await runCli(args, fixture.env);
  assert.equal(previewRun.code, 1, `preview should refuse without digest: code=${previewRun.code} stdout=${previewRun.stdout} stderr=${previewRun.stderr}`);
  const preview = JSON.parse(previewRun.stdout.trim().split("\n")[0]);
  const launched = await runCli([...args, "--digest", preview.contract_digest], fixture.env);
  assert.equal(launched.code, 0, launched.stderr);
  const lines = launched.stdout.trim().split("\n");
  const record = JSON.parse(lines[lines.length - 1]).record;
  fixture.state.socketPaths.add(record.tmux_socket);
  return record;
}

async function createFixture(t) {
  const base = await realpath("/tmp").catch(() => tmpdir());
  const root = await realpath(await mkdtemp(join(base, "adj4-controls-")));
  const storageRoot = join(root, "storage");
  const workspaceId = "controls-workspace";
  const workspaceDirectory = join(storageRoot, "projects", workspaceId);
  await mkdir(join(workspaceDirectory, "briefs"), { recursive: true });
  const repoApp = await makeRepo(join(root, "repos", "app"));
  const repoSecond = await makeRepo(join(root, "repos", "second"));
  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: workspaceId,
    name: "Controls Workspace",
    repositories: [
      { id: "app", path: repoApp },
      { id: "second", path: repoSecond },
    ],
  }));
  await writeFile(join(workspaceDirectory, "briefs", "brief.md"), "Controls brief.\n");

  const otherId = "other-workspace";
  const otherDirectory = join(storageRoot, "projects", otherId);
  await mkdir(join(otherDirectory, "briefs"), { recursive: true });
  await writeFile(join(otherDirectory, "kit.yaml"), kitYaml({
    id: otherId,
    name: "Other Workspace",
    repositories: [],
  }));

  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const piPath = join(binDir, "pi");
  await writeFile(piPath, FAKE_PI_SOURCE, { mode: 0o755 });
  await chmod(piPath, 0o755);

  const fakePiLog = join(root, "fake-pi.jsonl");
  const env = {
    ...process.env,
    ADJACENT_STORAGE_ROOT: storageRoot,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    FAKE_PI_LOG: fakePiLog,
  };
  const state = { socketPaths: new Set(), children: [] };
  t.after(async () => {
    for (const child of state.children) killGroup(child);
    for (const socketPath of state.socketPaths) await tmuxExec(socketPath, ["kill-server"]);
    try {
      for (const entry of await logEntries(fakePiLog)) {
        try {
          process.kill(entry.pid, "SIGTERM");
        } catch {
          // Already exited.
        }
      }
    } catch {
      // No fixture process was logged.
    }
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    storageRoot,
    workspaceId,
    workspaceDirectory,
    otherId,
    otherDirectory,
    fakePiLog,
    env,
    state,
  };
}

test("CLI assignment controls: locate and assignments expose unique records while duplicate UUIDs refuse", async (t) => {
  const fixture = await createFixture(t);
  const id = randomUUID();
  const record = await cliLaunch(fixture, { target: "app", id, instructions: "Controls A." });

  const locate = await runCli(["locate", id, "--json"], fixture.env);
  assert.equal(locate.code, 0, locate.stderr);
  const envelope = JSON.parse(locate.stdout.trim());
  assert.equal(envelope.record.assignment_id, id);
  assert.equal(envelope.record.state, "live");
  assert.deepEqual(envelope.attach_command, ["node", CLI_PATH, "attach", id, "--root", fixture.storageRoot]);
  assert.ok(Array.isArray(envelope.attention));

  const list = await runCli(["assignments", "--json"], fixture.env);
  assert.equal(list.code, 0, list.stderr);
  const envelopes = JSON.parse(list.stdout.trim());
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].record.assignment_id, id);
  assert.deepEqual(envelopes[0].attach_command, envelope.attach_command);
  assert.deepEqual(envelopes[0].attention, envelope.attention);

  const filtered = await runCli(["assignments", "--workspace", fixture.workspaceId, "--json"], fixture.env);
  assert.equal(filtered.code, 0, filtered.stderr);
  assert.equal(JSON.parse(filtered.stdout.trim()).length, 1);
  const otherFiltered = await runCli(["assignments", "--workspace", fixture.otherId, "--json"], fixture.env);
  assert.equal(otherFiltered.code, 0, otherFiltered.stderr);
  assert.deepEqual(JSON.parse(otherFiltered.stdout.trim()), []);

  const human = await runCli(["locate", id], fixture.env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, new RegExp(id));
  assert.match(human.stdout, /attach node /);

  // Hand-crafted duplicate UUID record in the second workspace.
  const duplicateDirectory = join(fixture.otherDirectory, "assignments");
  await mkdir(duplicateDirectory, { recursive: true });
  const duplicate = {
    ...record,
    workspace_id: fixture.otherId,
    workspace_directory: fixture.otherDirectory,
    brief_snapshot: join(fixture.otherDirectory, "assignments", `${id}.brief.md`),
    pi_session_dir: join(fixture.otherDirectory, "sessions", id),
  };
  const duplicatePath = join(duplicateDirectory, `${id}.json`);
  await writeFile(duplicatePath, JSON.stringify(duplicate));
  const duplicateBytes = await readFile(duplicatePath);

  const ambiguousLocate = await runCli(["locate", id, "--json"], fixture.env);
  assert.match(parseRefusal(ambiguousLocate).error, /more than once|ambiguous/i);
  const ambiguousList = await runCli(["assignments", "--json"], fixture.env);
  assert.match(parseRefusal(ambiguousList).error, /more than once|ambiguous/i);

  // A TTY attach also refuses the ambiguity instead of adopting a record.
  const ambiguousAttach = spawnPty([process.execPath, CLI_PATH, "attach", id], fixture.env);
  fixture.state.children.push(ambiguousAttach.child);
  await waitForPtyText(ambiguousAttach, "more than once", "attach ambiguity refusal");
  killGroup(ambiguousAttach.child);
  await waitForClose(ambiguousAttach.child);

  assert.deepEqual(await readFile(duplicatePath), duplicateBytes);
  await assert.rejects(lstat(join(fixture.otherDirectory, "sessions")), { code: "ENOENT" });
});

test("CLI assignment controls: non-TTY and non-live attach refuse while owned PTY attach keeps pane identity", async (t) => {
  const fixture = await createFixture(t);
  const liveId = randomUUID();
  const live = await cliLaunch(fixture, { target: "app", id: liveId, instructions: "Controls live." });
  const deadId = randomUUID();
  const dead = await cliLaunch(fixture, { target: "second", id: deadId, instructions: "Controls dead." });
  const socketPath = live.tmux_socket;

  const nonTty = await runCli(["attach", liveId], fixture.env);
  assert.match(parseRefusal(nonTty).error, /TTY/);

  // Stop the second fixture Pi explicitly, then confirm the record is no
  // longer live and attach refuses it.
  const deadEntry = await waitForAssignmentLogEntry(fixture.fakePiLog, deadId);
  process.kill(deadEntry.pid, "SIGTERM");
  // The terminal session outlives the pane command; kill only the owned
  // session on the owned socket, then wait for it to disappear so
  // observation can reach the confirmed non-live state.
  const keepAlive = await tmuxExec(dead.tmux_socket, ["new-session", "-d", "-s", "adj4-keepalive"]);
  assert.equal(keepAlive.ok, true, keepAlive.stderr);
  await tmuxExec(dead.tmux_socket, ["kill-session", "-t", `=${dead.tmux_session}`]);
  await waitFor(async () => {
    const present = await tmuxExec(dead.tmux_socket, ["has-session", "-t", `=${dead.tmux_session}`]);
    return present.ok ? null : true;
  }, `session ${dead.tmux_session} to be gone`);
  // The ordinary CLI locate cannot prove this record gone: the child CLI's
  // own argv contains the assignment UUID, so the default conservative
  // flattened `ps` observation lists that observer as a positive UUID
  // candidate and retains the reservation. Poll the shared locateAssignment
  // directly instead — the test process argv carries no UUID — with no
  // substituted probes or manually written states, so the real default
  // ps/tmux/identity path reaches the terminal state. The ordinary CLI is
  // exercised again below once the terminal state is persisted.
  const nonLive = await waitFor(async () => {
    const record = await locateAssignment(fixture.storageRoot, deadId);
    return record.state !== "live" ? record : null;
  }, "assignment to become non-live");
  assert.equal(nonLive.state, "ended");

  const endedLocate = await runCli(["locate", deadId, "--json"], fixture.env);
  assert.equal(endedLocate.code, 0, endedLocate.stderr);
  assert.equal(JSON.parse(endedLocate.stdout.trim()).record.state, "ended");

  const deadAttach = spawnPty([process.execPath, CLI_PATH, "attach", deadId], fixture.env);
  fixture.state.children.push(deadAttach.child);
  await waitForPtyText(deadAttach, "is not live", "non-live attach refusal");
  killGroup(deadAttach.child);
  await waitForClose(deadAttach.child);

  // The live assignment keeps its pane, session count and single Pi spawn
  // through an owned PTY attach/detach.
  const sessionsBefore = await sessionNames(socketPath);
  const spawnsBefore = assignmentEntries(await logEntries(fixture.fakePiLog), liveId).length;
  assert.equal(spawnsBefore, 1);

  const attached = spawnPty([process.execPath, CLI_PATH, "attach", liveId], fixture.env);
  fixture.state.children.push(attached.child);
  const clientName = await waitForClient(socketPath, live.tmux_session);
  assert.ok(typeof clientName === "string" && clientName.length > 0);

  const located = await runCli(["locate", liveId, "--json"], fixture.env);
  assert.equal(located.code, 0, located.stderr);
  const locatedRecord = JSON.parse(located.stdout.trim()).record;
  assert.equal(locatedRecord.state, "live");
  assert.equal(locatedRecord.pane_id, live.pane_id);
  assert.ok(sameProcess(live.pi_identity));
  assert.deepEqual(await sessionNames(socketPath), sessionsBefore);

  const detached = await tmuxExec(socketPath, ["detach-client", "-t", clientName]);
  assert.equal(detached.ok, true, detached.stderr);
  await waitForClientGone(socketPath, live.tmux_session);
  killGroup(attached.child);
  await waitForClose(attached.child);

  const after = await readRecord(fixture.workspaceDirectory, liveId);
  assert.equal(after.state, "live");
  assert.equal(after.pane_id, live.pane_id);
  assert.ok(sameProcess(live.pi_identity));
  assert.deepEqual(await sessionNames(socketPath), sessionsBefore);
  assert.equal(assignmentEntries(await logEntries(fixture.fakePiLog), liveId).length, 1);
});

test("CLI assignment controls: attach releases the root claim before the attach client starts", async (t) => {
  const fixture = await createFixture(t);
  const attachedId = randomUUID();
  const attached = await cliLaunch(fixture, { target: "app", id: attachedId, instructions: "Controls attached." });
  const socketPath = attached.tmux_socket;

  const pty = spawnPty([process.execPath, CLI_PATH, "attach", attachedId], fixture.env);
  fixture.state.children.push(pty.child);
  await waitForClient(socketPath, attached.tmux_session);

  // A launch for a different execution directory succeeds while the attach
  // client is still connected: the root claim was released before it started.
  const launchedId = randomUUID();
  const launched = await cliLaunch(fixture, { target: "second", id: launchedId, instructions: "Controls parallel." });
  assert.equal(launched.state, "live");
  await waitForClient(socketPath, attached.tmux_session);
  assert.ok((await sessionNames(socketPath)).includes(launched.tmux_session));

  const clientName = await waitForClient(socketPath, attached.tmux_session);
  const detached = await tmuxExec(socketPath, ["detach-client", "-t", clientName]);
  assert.equal(detached.ok, true, detached.stderr);
  await waitForClientGone(socketPath, attached.tmux_session);
  killGroup(pty.child);
  await waitForClose(pty.child);
});
