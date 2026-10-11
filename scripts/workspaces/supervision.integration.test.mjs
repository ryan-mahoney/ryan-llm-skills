// Step 6 focused tests: takeover and resume CLI commands.
//
// The ordinary CLI runs as a subprocess over an isolated physical storage root
// and a canonical `.specs` package inside the target fixture repository. Real
// tmux and the fake Pi own the assignment lifetime; only the final attach
// client boundary is substituted through a PATH wrapper that delegates every
// probe to the real tmux binary. No live root, host or store is touched.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { locateAssignment } from "./assignments.mjs";
import { hasSession } from "./tmux.mjs";
import { readInboxGuard, recordCheckpoint } from "../../pi/extensions/spec-runtime/sentinel.mjs";

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "cli.mjs");
const TEST_TIMEOUT_MS = 60000;
const FIXED = Date.parse("2026-10-06T12:00:00.000Z");

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
  const lines = ["version: 1", `id: ${JSON.stringify(id)}`, `name: ${JSON.stringify(name)}`, "repositories:"];
  for (const repository of repositories) {
    lines.push(`  - id: ${JSON.stringify(repository.id)}`);
    lines.push(`    path: ${JSON.stringify(repository.path)}`);
  }
  return `${lines.join("\n")}\n`;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 15000;
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
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
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
  const envelopes = result.stderr.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{"));
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
      { timeout: TEST_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true },
      (error, stdout) => {
        resolvePromise({
          ok: !error,
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout: stdout ?? "",
        });
      },
    );
  });
}

const tmuxExec = (socketPath, args) => runTmux(["-S", socketPath, ...args]);

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// Native PTY through a real shell pipe; the sleep holder keeps the feeder open
// for the whole attach session and dies with the group kill.
function spawnPty(argumentVector, env) {
  const command = `(exec sleep 60) | exec /usr/bin/script -q /dev/null ${argumentVector.map(shellQuote).join(" ")}`;
  const child = spawn("/bin/sh", ["-c", command], { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
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

async function createFixture(t) {
  const base = await realpath("/tmp").catch(() => tmpdir());
  const root = await realpath(await mkdtemp(join(base, "adj6-supervision-")));
  const storageRoot = join(root, "storage");
  const workspaceId = "supervision-workspace";
  const workspaceDirectory = join(storageRoot, "projects", workspaceId);
  await mkdir(join(workspaceDirectory, "briefs"), { recursive: true });
  const repoApp = await makeRepo(join(root, "repos", "app"));
  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: workspaceId,
    name: "Supervision Workspace",
    repositories: [{ id: "app", path: repoApp }],
  }));
  await writeFile(join(workspaceDirectory, "briefs", "brief.md"), "Supervision brief.\n");

  // The canonical package must share the target checkout's primary repository.
  const packagePath = join(repoApp, ".specs", "feature");
  await mkdir(join(packagePath, "inbox"), { recursive: true });
  await mkdir(join(packagePath, "processed"), { recursive: true });

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
    TERM: "xterm-256color",
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
  return { root, storageRoot, workspaceId, workspaceDirectory, repoApp, packagePath, fakePiLog, env, state };
}

// Substitute only the final attach client; every probe reaches the real tmux.
// attachExit controls the substituted client's exit code: 0 keeps the normal
// successful-detach behavior, nonzero exercises the attach-failure receipt.
async function addTmuxWrapper(fixture, { attachExit = 0 } = {}) {
  if (!Number.isInteger(attachExit) || attachExit < 0 || attachExit > 255) {
    throw new Error(`attachExit must be an integer 0-255, got ${attachExit}`);
  }
  const wrapperDir = join(fixture.root, "tmux-wrapper");
  await mkdir(wrapperDir, { recursive: true });
  const realTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
  const log = join(fixture.root, "fake-tmux.log");
  const script = `#!/bin/sh
case " $* " in
  *" attach-session "*)
    count=$(find "$FAKE_TMUX_INBOX" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
    printf '%s hold=%s\\n' "$*" "$count" >> "$FAKE_TMUX_LOG"
    exit ${attachExit}
    ;;
esac
exec "$FAKE_TMUX_REAL" "$@"
`;
  const wrapper = join(wrapperDir, "tmux");
  await writeFile(wrapper, script, { mode: 0o755 });
  await chmod(wrapper, 0o755);
  const env = {
    ...fixture.env,
    PATH: `${wrapperDir}${delimiter}${fixture.env.PATH}`,
    FAKE_TMUX_LOG: log,
    FAKE_TMUX_INBOX: join(fixture.packagePath, "inbox"),
    FAKE_TMUX_REAL: realTmux,
  };
  return { env, log };
}

async function launchAssignment(fixture, { id, specPackage, workflow, target = "app" }) {
  const args = ["launch", fixture.workspaceId, "--brief", "briefs/brief.md",
    "--instructions", "Supervision fixture.", "--id", id, "--json"];
  if (target !== null) args.push("--target", target);
  if (specPackage !== null && specPackage !== undefined) args.push("--spec-package", specPackage);
  if (workflow !== null && workflow !== undefined) args.push("--workflow", workflow);
  const previewRun = await runCli(args, fixture.env);
  assert.equal(previewRun.code, 1, `preview should refuse without digest: ${previewRun.stderr}`);
  const preview = JSON.parse(previewRun.stdout.trim().split("\n")[0]);
  const launched = await runCli([...args, "--digest", preview.contract_digest], fixture.env);
  assert.equal(launched.code, 0, launched.stderr);
  const lines = launched.stdout.trim().split("\n");
  const record = JSON.parse(lines[lines.length - 1]).record;
  fixture.state.socketPaths.add(record.tmux_socket);
  return record;
}

function writeCheckpoint(packagePath, workflow = "wf-1") {
  recordCheckpoint({
    package: packagePath,
    workflow_id: workflow,
    expected_revision: 0,
    state: "ready",
    obligation: { key: "implement:step-006", stage: "implementation", step: "step-006",
      summary: "expose takeover and resume", artifacts: [] },
    workers: [],
    inbox: { items: [] },
    reconciles_input_revision: 0,
    coordinator_session: "session-1",
    checkout: "/tmp/checkout-1",
    now: () => FIXED,
  });
}

async function inboxFiles(packagePath) {
  const list = async (name) => {
    try {
      return (await readdir(join(packagePath, name))).filter((entry) => entry.endsWith(".md")).sort();
    } catch {
      return [];
    }
  };
  return { inbox: await list("inbox"), processed: await list("processed") };
}

test("takeover CLI: delivers a coordinator hold before any attach and skips attach without a TTY", async (t) => {
  const fixture = await createFixture(t);
  writeCheckpoint(fixture.packagePath);
  const id = randomUUID();
  await launchAssignment(fixture, { id, specPackage: fixture.packagePath, workflow: "wf-1" });
  const checkpointFile = join(fixture.packagePath, "runtime", "sentinel", "wf-1", "checkpoint.json");
  const before = { bytes: await readFile(checkpointFile), mtimeMs: (await lstat(checkpointFile)).mtimeMs };

  const run = await runCli(["takeover", id, "--run", "wf-1", "--json"], fixture.env);
  assert.equal(run.code, 0, `takeover failed: ${run.stderr}`);
  const result = JSON.parse(run.stdout.trim().split("\n").at(-1));
  assert.equal(result.takeover, "delivered");
  assert.equal(result.spec_package, fixture.packagePath);
  assert.equal(result.run, "wf-1");
  assert.equal(result.hold.status, "delivered");
  assert.equal(result.attached, false);
  assert.match(result.safe_boundary, /blocks automatic continuation/);
  assert.deepEqual(result.attach_command, ["node", CLI_PATH, "attach", id, "--root", fixture.storageRoot]);

  const guard = readInboxGuard(fixture.packagePath);
  const holds = guard.items.filter((item) => item.kind === "hold" && item.run === "wf-1");
  assert.equal(holds.length, 1);
  assert.equal(holds[0].state, "blocking");
  assert.equal(holds[0].sha256, result.hold.sha256);
  const holdBytes = await readFile(join(fixture.packagePath, holds[0].path));
  assert.equal(createHash("sha256").update(holdBytes).digest("hex"), result.hold.sha256);

  const after = { bytes: await readFile(checkpointFile), mtimeMs: (await lstat(checkpointFile)).mtimeMs };
  assert.deepEqual(after, before, "the hold never rewrites the checkpoint");
});

test("takeover CLI: delivers the hold before the mocked final tmux attach boundary under a TTY", async (t) => {
  const fixture = await createFixture(t);
  writeCheckpoint(fixture.packagePath);
  const id = randomUUID();
  await launchAssignment(fixture, { id, specPackage: fixture.packagePath, workflow: "wf-1" });
  const { env, log } = await addTmuxWrapper(fixture);

  const pty = spawnPty([process.execPath, CLI_PATH, "takeover", id, "--run", "wf-1", "--json"], env);
  fixture.state.children.push(pty.child);
  await waitFor(async () => {
    let attachLog = "";
    try {
      attachLog = await readFile(log, "utf8");
    } catch {
      return null;
    }
    return attachLog.trim() !== "" && pty.output().stdout.includes('"takeover":"delivered"') ? true : null;
  }, "mocked attach-session boundary and delivery receipt").catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify(pty.output())}`);
  });

  const attachLine = (await readFile(log, "utf8")).trim();
  assert.match(attachLine, /attach-session/);
  assert.match(attachLine, /hold=1$/, "the hold original existed when the attach client started");
  const holds = readInboxGuard(fixture.packagePath).items.filter((item) => item.kind === "hold");
  assert.equal(holds.length, 1, "the hold was delivered before attach");
  assert.match(pty.output().stdout, /safe_boundary/);
  killGroup(pty.child);
  await waitForClose(pty.child);
});

test("takeover CLI: a nonzero attach exit after a delivered hold reports the attach failure without a duplicate", async (t) => {
  const fixture = await createFixture(t);
  writeCheckpoint(fixture.packagePath);
  const id = randomUUID();
  await launchAssignment(fixture, { id, specPackage: fixture.packagePath, workflow: "wf-1" });
  const { env, log } = await addTmuxWrapper(fixture, { attachExit: 3 });

  const pty = spawnPty([process.execPath, CLI_PATH, "takeover", id, "--run", "wf-1", "--json"], env);
  fixture.state.children.push(pty.child);
  await waitFor(async () => {
    let attachLog = "";
    try {
      attachLog = await readFile(log, "utf8");
    } catch {
      return null;
    }
    return attachLog.trim() !== "" && pty.output().stdout.includes("attach_error") ? true : null;
  }, "failed attach-session boundary and attach_error receipt").catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify(pty.output())}`);
  });

  const stdout = pty.output().stdout;
  assert.match(stdout, /"takeover":"delivered"/);
  assert.match(stdout, /attach_error/);
  assert.match(stdout, /attach exited with code 3/);
  assert.match(stdout, /held pending/);
  killGroup(pty.child);
  await waitForClose(pty.child);

  const inventory = await inboxFiles(fixture.packagePath);
  assert.equal(inventory.inbox.length, 1, `expected exactly one hold: ${JSON.stringify(inventory)}`);
  const holds = readInboxGuard(fixture.packagePath).items.filter((item) => item.kind === "hold");
  assert.equal(holds.length, 1, "the failed attach wrote no duplicate original");
  assert.equal(holds[0].state, "blocking");
});

test("takeover CLI: a non-spec assignment writes no inbox original and prints the attach hint", async (t) => {
  const fixture = await createFixture(t);
  const id = randomUUID();
  await launchAssignment(fixture, { id, specPackage: null, workflow: null });
  const inventoryBefore = await inboxFiles(fixture.packagePath);
  const recordFile = join(fixture.workspaceDirectory, "assignments", `${id}.json`);
  const recordBefore = await readFile(recordFile);

  const run = await runCli(["takeover", id, "--json"], fixture.env);
  assert.equal(run.code, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.takeover, "attach-only");
  assert.equal(result.spec_package, null);
  assert.match(result.note, /no automatic actor/);
  assert.deepEqual(result.attach_command, ["node", CLI_PATH, "attach", id, "--root", fixture.storageRoot]);
  assert.deepEqual(await inboxFiles(fixture.packagePath), inventoryBefore, "non-spec takeover writes no inbox file");
  assert.deepEqual(await readFile(recordFile), recordBefore);
});

test("resume CLI: requests a release direction without releasing or rewriting the hold", async (t) => {
  const fixture = await createFixture(t);
  writeCheckpoint(fixture.packagePath);
  const id = randomUUID();
  await launchAssignment(fixture, { id, specPackage: fixture.packagePath, workflow: "wf-1" });

  const takeover = await runCli(["takeover", id, "--json"], fixture.env);
  assert.equal(takeover.code, 0, takeover.stderr);
  const taken = JSON.parse(takeover.stdout.trim());
  const holdBefore = await readFile(taken.hold.path);
  const holdMtime = (await lstat(taken.hold.path)).mtimeMs;
  const checkpointFile = join(fixture.packagePath, "runtime", "sentinel", "wf-1", "checkpoint.json");
  const checkpointBytes = await readFile(checkpointFile);

  const run = await runCli(["resume", id, "--hold", taken.hold.id, "--run", "wf-1", "--json"], fixture.env);
  assert.equal(run.code, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.resume, "requested");
  assert.equal(result.released, false);
  assert.equal(result.direction.status, "delivered");
  assert.match(result.note, /did not release/);

  const guard = readInboxGuard(fixture.packagePath);
  const hold = guard.items.find((item) => item.id === taken.hold.id);
  assert.ok(hold, "the hold remains in the guard");
  assert.ok(["blocking", "held"].includes(hold.state), `hold state ${hold.state}`);
  const direction = guard.items.find((item) => item.kind === "direction" && item.run === "wf-1");
  assert.ok(direction, "the direction original is retained");
  assert.equal(direction.sha256, result.direction.sha256);
  assert.equal(createHash("sha256").update(holdBefore).digest("hex"), taken.hold.sha256);
  assert.deepEqual(await readFile(taken.hold.path), holdBefore, "resume never rewrites the hold original");
  assert.equal((await lstat(taken.hold.path)).mtimeMs, holdMtime, "resume never touches the hold mtime");
  assert.deepEqual(await readFile(checkpointFile), checkpointBytes, "resume never touches the checkpoint");
});

test("resume CLI: wrong run, unknown hold and missing checkpoint refuse without writing", async (t) => {
  const fixture = await createFixture(t);
  writeCheckpoint(fixture.packagePath);
  const id = randomUUID();
  await launchAssignment(fixture, { id, specPackage: fixture.packagePath, workflow: "wf-1" });
  const takeover = await runCli(["takeover", id, "--json"], fixture.env);
  assert.equal(takeover.code, 0, takeover.stderr);
  const taken = JSON.parse(takeover.stdout.trim());
  const inventory = await inboxFiles(fixture.packagePath);

  const wrongRun = await runCli(["resume", id, "--hold", taken.hold.id, "--run", "wf-other", "--json"], fixture.env);
  assert.match(parseRefusal(wrongRun).error, /does not match/);
  const unknownHold = await runCli(["resume", id, "--hold", randomUUID(), "--run", "wf-1", "--json"], fixture.env);
  assert.match(parseRefusal(unknownHold).error, /no retained kind:hold/);
  assert.deepEqual(await inboxFiles(fixture.packagePath), inventory, "refusals write nothing");

  await rm(join(fixture.packagePath, "runtime", "sentinel"), { recursive: true, force: true });
  const missing = await runCli(["takeover", id, "--run", "wf-1", "--json"], fixture.env);
  assert.match(parseRefusal(missing).error, /requires a retained checkpoint/);
  assert.deepEqual(await inboxFiles(fixture.packagePath), inventory, "a missing checkpoint publishes nothing");
});

test("resume CLI: conflicting hold copies refuse without publishing a direction", async (t) => {
  const fixture = await createFixture(t);
  writeCheckpoint(fixture.packagePath);
  const id = randomUUID();
  await launchAssignment(fixture, { id, specPackage: fixture.packagePath, workflow: "wf-1" });
  const takeover = await runCli(["takeover", id, "--json"], fixture.env);
  assert.equal(takeover.code, 0, takeover.stderr);
  const taken = JSON.parse(takeover.stdout.trim());
  const holdBytes = await readFile(taken.hold.path, "utf8");

  // A conflicting copy: the same hold id with different bytes in the archive.
  await writeFile(
    join(fixture.packagePath, "processed", `${taken.hold.id}.md`),
    `${holdBytes}\nConflicting copy.\n`,
  );
  const inventory = await inboxFiles(fixture.packagePath);
  assert.equal(inventory.inbox.length, 1);
  assert.equal(inventory.processed.length, 1);

  const refused = await runCli(["resume", id, "--hold", taken.hold.id, "--run", "wf-1", "--json"], fixture.env);
  assert.match(parseRefusal(refused).error, /conflicting hold/);
  assert.deepEqual(await inboxFiles(fixture.packagePath), inventory, "the refusal publishes no direction");
  assert.equal(await readFile(taken.hold.path, "utf8"), holdBytes, "the refusal rewrites no hold");
});

test("resume CLI: a changed hold refuses against the retained checkpoint hash", async (t) => {
  const fixture = await createFixture(t);
  writeCheckpoint(fixture.packagePath);
  const id = randomUUID();
  await launchAssignment(fixture, { id, specPackage: fixture.packagePath, workflow: "wf-1" });
  const takeover = await runCli(["takeover", id, "--json"], fixture.env);
  assert.equal(takeover.code, 0, takeover.stderr);
  const taken = JSON.parse(takeover.stdout.trim());
  const holdBytes = await readFile(taken.hold.path, "utf8");

  // Retain the delivered hold hash in the checkpoint, then change the live
  // original under the same hold id.
  recordCheckpoint({
    package: fixture.packagePath,
    workflow_id: "wf-1",
    expected_revision: 1,
    state: "ready",
    obligation: { key: "implement:step-006", stage: "implementation", step: "step-006",
      summary: "expose takeover and resume", artifacts: [] },
    workers: [],
    inbox: { items: [{ id: taken.hold.id, sha256: taken.hold.sha256, outcome: "held" }] },
    reconciles_input_revision: 0,
    coordinator_session: "session-1",
    checkout: "/tmp/checkout-1",
    now: () => FIXED,
  });
  await writeFile(taken.hold.path, `${holdBytes}\nRewritten archive.\n`);
  const inventory = await inboxFiles(fixture.packagePath);

  const refused = await runCli(["resume", id, "--hold", taken.hold.id, "--run", "wf-1", "--json"], fixture.env);
  assert.match(parseRefusal(refused).error, /conflicting hold|different hash/);
  assert.deepEqual(await inboxFiles(fixture.packagePath), inventory, "the refusal publishes no direction");
});

test("takeover CLI: attach failure after a delivered hold keeps it held and a retry writes no duplicate", async (t) => {
  const fixture = await createFixture(t);
  writeCheckpoint(fixture.packagePath);

  // The tmux server process retains the argv of the first `new-session` that
  // booted it, including ADJACENT_ASSIGNMENT_ID=<first UUID>. Launch a
  // spec-less dummy first (no inbox, no checkpoint, its own execution
  // directory) so the server argv carries only the dummy UUID and the real
  // assignment's UUID never appears in the process listing while its
  // confirmed-gone observation is probed.
  await launchAssignment(fixture, { id: randomUUID(), specPackage: null, workflow: null, target: null });

  const id = randomUUID();
  const record = await launchAssignment(fixture, { id, specPackage: fixture.packagePath, workflow: "wf-1" });

  const entry = await waitForAssignmentLogEntry(fixture.fakePiLog, id);

  // The recorded launcher is the launch CLI process; confirm it is actually
  // gone (reaped, not a zombie whose argv still shows the assignment UUID)
  // instead of assuming its exit raced observation.
  const launcher = record.launcher_identity ?? null;
  if (launcher !== null) {
    await waitFor(() => {
      try {
        process.kill(launcher.pid, 0);
        return null;
      } catch (error) {
        return error.code === "ESRCH" ? true : null;
      }
    }, "fixture launcher process to exit");
  }

  // Stop only the real assignment: kill its exact session while it still
  // exists (asserted), then SIGTERM its recorded Pi and wait for the OS to
  // reap it. The dummy session keeps the owned server reachable throughout,
  // so hasSession(real session) reports confirmed absence rather than an
  // unreachable-server unknown, and the real UUID is absent from the process
  // listing while gone is probed.
  const killed = await tmuxExec(record.tmux_socket, ["kill-session", "-t", `=${record.tmux_session}`]);
  assert.equal(killed.ok, true, `kill-session failed: ${killed.stdout}`);
  try {
    process.kill(entry.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await waitFor(() => {
    try {
      process.kill(entry.pid, 0);
      return null;
    } catch (error) {
      return error.code === "ESRCH" ? true : null;
    }
  }, "fixture pi process to exit");
  assert.equal(
    await hasSession({ socketPath: record.tmux_socket, sessionName: record.tmux_session }),
    false,
    "the assignment session is absent while the tmux server is reachable",
  );

  const nonLive = await waitFor(async () => {
    const located = await locateAssignment(fixture.storageRoot, id);
    return located.state !== "live" ? located : null;
  }, "assignment to become non-live");
  assert.ok(["ended", "launch_failed"].includes(nonLive.state), nonLive.state);

  const pty = spawnPty([process.execPath, CLI_PATH, "takeover", id, "--run", "wf-1", "--json"], fixture.env);
  fixture.state.children.push(pty.child);
  await waitForPtyText(pty, "held pending", "held-pending report").catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify(pty.output())}`);
  });
  const stdout = pty.output().stdout;
  assert.match(stdout, /"takeover":"delivered"/);
  assert.match(stdout, /attach_error/);
  killGroup(pty.child);
  await waitForClose(pty.child);

  const inventory = await inboxFiles(fixture.packagePath);
  assert.equal(inventory.inbox.length, 1, `expected exactly one hold: ${JSON.stringify(inventory)}`);
  const holdPath = join(fixture.packagePath, "inbox", inventory.inbox[0]);
  const holdBytes = await readFile(holdPath);

  // Retrying the attach alone never publishes another original.
  const retry = spawnPty([process.execPath, CLI_PATH, "attach", id], fixture.env);
  fixture.state.children.push(retry.child);
  await waitForPtyText(retry, "is not live", "non-live attach refusal");
  killGroup(retry.child);
  await waitForClose(retry.child);
  assert.deepEqual(await inboxFiles(fixture.packagePath), inventory, "no duplicate original on retry");
  assert.deepEqual(await readFile(holdPath), holdBytes, "the delivered hold is preserved byte-for-byte");
});
