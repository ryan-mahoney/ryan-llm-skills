// Step 5 focused tests: preview-confirmed CLI launch.
//
// Each case runs the ordinary CLI through execFile with an isolated physical
// ADJACENT_STORAGE_ROOT, a fake Pi first in PATH, a temp HOME and a real git
// repository target. Refusals must leave no assignments/, sessions/ or
// .sentinel state; confirmed launches write only inside the temp root and
// signal only the logged fake Pi processes during cleanup.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "cli.mjs");
const TEST_TIMEOUT_MS = 60000;

const FAKE_PI_SOURCE = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
let briefSha256 = null;
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('@')) {
    try {
      briefSha256 = createHash('sha256').update(readFileSync(arg.slice(1))).digest('hex');
    } catch {
      briefSha256 = null;
    }
  }
}
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  pid: process.pid,
  at: new Date().toISOString(),
  briefSha256,
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

function kitYaml({ id, name, repositories }) {
  const lines = [
    "version: 1",
    `id: ${JSON.stringify(id)}`,
    `name: ${JSON.stringify(name)}`,
    "repositories:",
  ];
  for (const repository of repositories) {
    lines.push(`  - id: ${JSON.stringify(repository.id)}`);
    lines.push(`    path: ${JSON.stringify(repository.path)}`);
    if (repository.remote !== undefined && repository.remote !== null) {
      lines.push(`    remote: ${JSON.stringify(repository.remote)}`);
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
    await delay(25);
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

async function waitForLogEntry(logPath, pid) {
  return waitFor(async () => {
    const entries = await logEntries(logPath);
    return entries.find((entry) => entry.pid === pid) ?? null;
  }, `fake pi ${pid} log entry`);
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// The PTY redraw can indent the launched block, so completion is anchored to
// the confirmation prompt: the tail after it excludes the human preview and
// must contain the launched marker, then the launched digest, then the final
// execution_dir line in order.
function launchedBlockComplete(text) {
  const prompt = text.indexOf("Type yes to launch:");
  if (prompt === -1) return false;
  const tail = text.slice(prompt);
  const launched = tail.indexOf("launched ");
  if (launched === -1) return false;
  const digest = tail.indexOf("digest ", launched + "launched ".length);
  if (digest === -1) return false;
  return tail.indexOf("execution_dir ", digest + "digest ".length) !== -1;
}

// The Node-spawned /usr/bin/script form fails in this sandbox (tcgetattr on a
// socket-backed stdio pipe), so the PTY is supplied through a real shell pipe.
// Gated PTY confirmation: the feeder blocks until the test releases it, so
// the owned PTY stays held at the confirmation prompt while the test edits
// the source brief between preview and confirmation. onPrompt runs after the
// prompt appears and before yes is delivered; releasing the gate sends yes
// through the same shell-pipeline PTY that works in this sandbox.
function runCliTtyGated(args, env, { onPrompt } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const gatePath = join(tmpdir(), `adj4-tty-gate-${randomUUID()}`);
    const command = `(while [ ! -e ${shellQuote(gatePath)} ]; do sleep 0.05; done; printf '%s\\n' ${shellQuote("yes")}; exec sleep 60) | exec /usr/bin/script -q /dev/null ${[process.execPath, CLI_PATH, ...args]
      .map(shellQuote)
      .join(" ")}`;
    const child = spawn("/bin/sh", ["-c", command], { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let prompted = false;
    let completed = false;
    let settled = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };
    const finishSettled = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rm(gatePath, { force: true }).catch(() => {}).finally(fn);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup();
      rm(gatePath, { force: true }).catch(() => {}).finally(() => {
        rejectPromise(new Error(`PTY CLI timed out; stdout=${stdout}; stderr=${stderr}`));
      });
    }, TEST_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!prompted && stdout.includes("Type yes to launch:")) {
        prompted = true;
        (async () => {
          try {
            if (onPrompt) await onPrompt();
          } catch (error) {
            finishSettled(() => rejectPromise(error));
            killGroup();
            return;
          }
          try {
            await writeFile(gatePath, "release\n");
          } catch (error) {
            finishSettled(() => rejectPromise(error));
            killGroup();
          }
        })();
      }
      if (!completed && launchedBlockComplete(stdout)) {
        completed = true;
        killGroup();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finishSettled(() => rejectPromise(error));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rm(gatePath, { force: true }).catch(() => {}).finally(() => {
        resolvePromise({ code: completed ? 0 : (typeof code === "number" ? code : null), stdout, stderr });
      });
    });
    child.stdin.on("error", () => {});
  });
}

function parseRefusal(result) {
  assert.equal(result.code, 1, `expected refusal, got ${result.code}: ${result.stdout}`);
  const lines = result.stderr.trim().split("\n");
  const parsed = JSON.parse(lines[lines.length - 1]);
  assert.equal(typeof parsed.error, "string");
  assert.ok(parsed.error.length > 0, "refusal must carry an error message");
  return parsed;
}

async function assertNoWrites(workspaceDirectory, storageRoot) {
  await assert.rejects(lstat(join(workspaceDirectory, "assignments")), { code: "ENOENT" });
  await assert.rejects(lstat(join(workspaceDirectory, "sessions")), { code: "ENOENT" });
  await assert.rejects(lstat(join(storageRoot, ".sentinel")), { code: "ENOENT" });
}

async function createFixture(t, { directoryName = "launch-workspace", remote = null, origin = null } = {}) {
  // Keep the root short: the default tmux socket <root>/.sentinel/adjacent.sock
  // must fit the ~103-char unix sun_path limit; macOS TMPDIR under
  // /private/var/folders is too long.
  const base = await realpath("/tmp").catch(() => tmpdir());
  const root = await realpath(await mkdtemp(join(base, "adj4-launch-")));
  const storageRoot = join(root, "storage");
  const workspaceId = "launch-workspace";
  const workspaceDirectory = join(storageRoot, "projects", directoryName);
  await mkdir(join(workspaceDirectory, "briefs"), { recursive: true });

  const repo = join(root, "repos", "app");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "--quiet"]);
  if (origin !== null) await git(repo, ["remote", "add", "origin", origin]);
  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: workspaceId,
    name: "Launch Workspace",
    repositories: [{ id: "app", path: repo, ...(remote === null ? {} : { remote }) }],
  }));
  const briefBytes = Buffer.from("Reviewed brief bytes.\n", "utf8");
  await writeFile(join(workspaceDirectory, "briefs", "brief.md"), briefBytes);

  const home = join(root, "home");
  await mkdir(join(home, ".agents", "skills", "demo"), { recursive: true });
  await writeFile(join(home, ".agents", "skills", "demo", "SKILL.md"), "# Demo skill\n");

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
  const state = { socketPath: null };
  t.after(async () => {
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
    if (state.socketPath !== null) {
      await new Promise((resolvePromise) => {
        execFile(
          "tmux",
          ["-S", state.socketPath, "kill-server"],
          { timeout: 10000, killSignal: "SIGKILL" },
          () => resolvePromise(),
        );
      });
    }
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    storageRoot,
    workspaceId,
    workspaceDirectory,
    repo,
    home,
    fakePiLog,
    env,
    briefBytes,
    state,
  };
}

test("CLI launch preview: non-TTY and stale digest refuse before writes; matching digest launches once", async (t) => {
  const fixture = await createFixture(t);
  const { env, storageRoot, workspaceDirectory, workspaceId, briefBytes, home } = fixture;
  const id = randomUUID();
  const baseArgs = [
    "launch", workspaceId,
    "--brief", "briefs/brief.md",
    "--instructions", "Do the reviewed work.",
    "--id", id,
    "--target", "app",
    "--authority", "pr",
  ];

  // Non-TTY without --digest refuses before writing anything.
  const withoutDigest = await runCli(baseArgs, env);
  parseRefusal(withoutDigest);
  assert.match(withoutDigest.stderr, /TTY|digest/i);
  const previewText = withoutDigest.stdout.replaceAll("\r", "");
  assert.match(previewText, /launch preview/);
  assert.match(previewText, /publication_authority pr \(grants no merge\/deploy\)/);
  const digestLine = /^contract_digest ([0-9a-f]{64})$/m.exec(previewText);
  assert.ok(digestLine, `missing preview digest: ${previewText}`);
  await assertNoWrites(workspaceDirectory, storageRoot);

  // --instructions-file is the alternative source of the same contract.
  const instructionsFile = join(fixture.root, "instructions.txt");
  await writeFile(instructionsFile, "Do the reviewed work.");
  const fromFile = await runCli([
    ...baseArgs.filter((arg) => arg !== "--instructions" && arg !== "Do the reviewed work."),
    "--instructions-file", instructionsFile,
    "--json",
  ], env);
  parseRefusal(fromFile);
  const previewFromFile = JSON.parse(fromFile.stdout.trim());
  assert.equal(previewFromFile.contract_digest, digestLine[1]);
  assert.equal(previewFromFile.publication_authority, "pr");
  assert.equal(previewFromFile.publication_authority_note, "grants no merge/deploy");
  assert.deepEqual(previewFromFile.attention, []);
  await assertNoWrites(workspaceDirectory, storageRoot);

  // A preview with a HOME skill resolves the installed skill path read-only.
  const withSkill = await runCli([
    "launch", workspaceId,
    "--brief", "briefs/brief.md",
    "--instructions", "Do the reviewed work.",
    "--id", randomUUID(),
    "--target", "app",
    "--skill", "demo",
    "--json",
  ], env);
  parseRefusal(withSkill);
  const skillPreview = JSON.parse(withSkill.stdout.trim());
  assert.equal(skillPreview.skill, "demo");
  assert.equal(skillPreview.skill_path, join(home, ".agents", "skills", "demo", "SKILL.md"));
  await assertNoWrites(workspaceDirectory, storageRoot);

  // A stale digest refuses before writes.
  const stale = await runCli([...baseArgs, "--json", "--digest", "0".repeat(64)], env);
  parseRefusal(stale);
  assert.match(stale.stderr, /digest/i);
  assert.match(stale.stdout.trim(), /^\{/);
  await assertNoWrites(workspaceDirectory, storageRoot);

  // The matching digest launches once and binds the approved bytes. --json
  // prints the preview line first and the launched result line last.
  const launched = await runCli([...baseArgs, "--json", "--digest", digestLine[1]], env);
  assert.equal(launched.code, 0, launched.stderr);
  const launchedLines = launched.stdout.trim().split("\n");
  const launchedPreview = JSON.parse(launchedLines[0]);
  const result = JSON.parse(launchedLines[launchedLines.length - 1]);
  assert.equal(launchedPreview.contract_digest, digestLine[1]);
  assert.equal(result.digest, digestLine[1]);
  assert.equal(result.record.assignment_id, id);
  assert.equal(result.record.workspace_id, workspaceId);
  assert.equal(result.record.publication_authority, "pr");
  assert.equal(result.record.state, "live", JSON.stringify({
    attention: result.record.attention,
    pi_identity: result.record.pi_identity,
    tmux_socket: result.record.tmux_socket,
    tmux_session: result.record.tmux_session,
  }));
  assert.equal(result.record.tmux_socket, join(storageRoot, ".sentinel", "adjacent.sock"));
  assert.equal(result.record.tmux_session, `adj-${id.replaceAll("-", "").slice(0, 12)}`);

  const snapshot = await readFile(result.record.brief_snapshot);
  assert.deepEqual(snapshot, briefBytes);
  assert.equal(
    result.record.brief_sha256,
    createHash("sha256").update(briefBytes).digest("hex"),
  );

  const entry = await waitForLogEntry(fixture.fakePiLog, result.record.pi_identity.pid);
  assert.ok(entry.argv.includes("--session-id"));
  assert.ok(entry.argv.includes(id));
  assert.ok(entry.argv.includes(`@${result.record.brief_snapshot}`));
  assert.equal(entry.cwd, result.record.execution_dir);

  // An identical repeat returns the same record without a second spawn.
  const repeat = await runCli([...baseArgs, "--json", "--digest", digestLine[1]], env);
  assert.equal(repeat.code, 0, repeat.stderr);
  const repeatLines = repeat.stdout.trim().split("\n");
  assert.equal(JSON.parse(repeatLines[0]).contract_digest, digestLine[1]);
  assert.equal(JSON.parse(repeatLines[repeatLines.length - 1]).record.assignment_id, id);
  assert.equal((await logEntries(fixture.fakePiLog)).length, 1);

  fixture.state.socketPath = result.record.tmux_socket;
});

test("CLI launch preview: TTY confirmation binds displayed bytes and edited source keeps the approved snapshot", async (t) => {
  const fixture = await createFixture(t);
  const { env, workspaceDirectory, workspaceId, briefBytes } = fixture;
  const id = randomUUID();
  const args = [
    "launch", workspaceId,
    "--brief", "briefs/brief.md",
    "--instructions", "Bound bytes.",
    "--id", id,
    "--target", "app",
    "--yes",
  ];
  const originalHash = createHash("sha256").update(briefBytes).digest("hex");
  const briefPath = join(workspaceDirectory, "briefs", "brief.md");

  // Hold the owned PTY at the confirmation prompt, edit the source before
  // sending yes, then verify the approved snapshot still binds the reviewed
  // bytes. The gated feeder delivers yes only after onPrompt completes.
  const result = await runCliTtyGated(args, env, {
    onPrompt: async () => {
      await writeFile(briefPath, "EDITED between preview and confirmation\n");
    },
  });
  assert.equal(result.code, 0, `PTY CLI failed: ${result.stderr}; stdout=${result.stdout}`);
  const output = result.stdout.replaceAll("\r", "");
  assert.match(output, /Type yes to launch:/);
  assert.match(output, /publication_authority none \(grants no merge\/deploy\)/);
  const previewDigest = /^contract_digest ([0-9a-f]{64})$/m.exec(output);
  const launchedDigest = /^digest ([0-9a-f]{64})$/m.exec(output);
  assert.ok(previewDigest, `missing preview digest: ${output}`);
  assert.ok(launchedDigest, `missing launched digest: ${output}`);
  assert.equal(launchedDigest[1], previewDigest[1]);

  const record = JSON.parse(
    await readFile(join(workspaceDirectory, "assignments", `${id}.json`), "utf8"),
  );
  assert.equal(record.contract_digest, previewDigest[1]);
  assert.equal(record.publication_authority, "none");
  assert.equal(record.brief_sha256, originalHash);
  assert.deepEqual(await readFile(record.brief_snapshot), briefBytes);

  // The source edit landed before confirmation yet the approved snapshot
  // keeps the reviewed bytes; the fake Pi independently hashed the @file it
  // was actually given.
  assert.equal(await readFile(briefPath, "utf8"), "EDITED between preview and confirmation\n");
  const entry = await waitForLogEntry(fixture.fakePiLog, record.pi_identity.pid);
  assert.ok(entry.argv.includes(`@${record.brief_snapshot}`));
  assert.equal(entry.briefSha256, originalHash);
  const snapshotHash = createHash("sha256")
    .update(await readFile(record.brief_snapshot))
    .digest("hex");
  assert.equal(snapshotHash, originalHash);
  fixture.state.socketPath = record.tmux_socket;
});

test("CLI launch preview: spawn failure reports reservation state and non-zero exit", async (t) => {
  const fixture = await createFixture(t);
  const { env, workspaceDirectory, workspaceId, briefBytes } = fixture;
  const id = randomUUID();
  // Unique overlong socket: passes resolution and digest approval but cannot
  // start tmux (exceeds the platform Unix-socket limit).
  const badSocket = join(fixture.root, `${"s".repeat(180)}.sock`);
  assert.ok(badSocket.length > 103, `socket fixture must exceed sun_path: ${badSocket.length}`);
  const baseArgs = [
    "launch", workspaceId,
    "--brief", "briefs/brief.md",
    "--instructions", "Do the reviewed work.",
    "--id", id,
    "--target", "app",
    "--tmux-socket", badSocket,
  ];

  // Preview resolves and refuses before writes so the digest is observable.
  const previewed = await runCli([...baseArgs, "--json"], env);
  parseRefusal(previewed);
  const preview = JSON.parse(previewed.stdout.trim());
  assert.equal(preview.tmux_socket, badSocket);
  assert.match(preview.contract_digest, /^[0-9a-f]{64}$/);
  await assertNoWrites(workspaceDirectory, fixture.storageRoot);

  // Human failure: reports the retained reservation state and attention,
  // never prints a confirmed launch, and exits non-zero.
  const failed = await runCli([...baseArgs, "--digest", preview.contract_digest], env);
  assert.equal(failed.code, 1, `expected spawn-failure exit 1: ${failed.stdout} ${failed.stderr}`);
  const failedText = failed.stdout.replaceAll("\r", "");
  assert.match(failedText, /launch incomplete /);
  assert.match(failedText, new RegExp(`launch incomplete ${id}`));
  assert.match(failedText, /state (launching|launch_unknown)/);
  assert.match(failedText, /attention .*launch spawn failed/i);
  assert.doesNotMatch(failedText, new RegExp(`^launched ${id}$`, "m"));

  // The durable reservation is retained with the approved snapshot bytes and
  // no fake Pi ever spawned.
  const persisted = JSON.parse(
    await readFile(join(workspaceDirectory, "assignments", `${id}.json`), "utf8"),
  );
  assert.ok(["launching", "launch_unknown"].includes(persisted.state), persisted.state);
  assert.ok(
    (persisted.attention ?? []).some((entry) => /launch spawn failed/i.test(entry)),
    JSON.stringify(persisted.attention),
  );
  assert.equal(persisted.tmux_socket, badSocket);
  assert.deepEqual(await readFile(persisted.brief_snapshot), briefBytes);
  assert.equal((await logEntries(fixture.fakePiLog)).length, 0);

  // JSON failure: retains the record state and also exits non-zero.
  const failedJson = await runCli([...baseArgs, "--json", "--digest", preview.contract_digest], env);
  assert.equal(failedJson.code, 1, `expected JSON spawn-failure exit 1: ${failedJson.stderr}`);
  const failedLines = failedJson.stdout.trim().split("\n");
  const failedResult = JSON.parse(failedLines[failedLines.length - 1]);
  assert.equal(failedResult.record.assignment_id, id);
  assert.ok(["launching", "launch_unknown"].includes(failedResult.record.state));
  assert.ok(
    (failedResult.record.attention ?? []).some((entry) => /launch spawn failed/i.test(entry)),
  );
  // Identical repeat starts nothing new: still no fake Pi spawn.
  assert.equal((await logEntries(fixture.fakePiLog)).length, 0);
});

// Select alone with --test-name-pattern='CLI launch preview: directory and origin mismatch'.
test("CLI launch preview: directory and origin mismatch attention shown before approval", async (t) => {
  const fixture = await createFixture(t, {
    directoryName: "wrong-directory",
    remote: "https://example.com/expected.git",
    origin: "https://example.com/actual.git",
  });
  const { env, storageRoot, workspaceDirectory, workspaceId } = fixture;
  const id = randomUUID();
  const args = [
    "launch", workspaceId,
    "--brief", "briefs/brief.md",
    "--instructions", "Do the mismatched work.",
    "--id", id,
    "--target", "app",
  ];

  // JSON preview (non-TTY refusal): attention is a predictable preview field
  // printed before confirmation, and the refusal writes nothing.
  const jsonPreview = await runCli([...args, "--json"], env);
  parseRefusal(jsonPreview);
  const view = JSON.parse(jsonPreview.stdout.trim());
  assert.deepEqual(view.attention, ["directory_mismatch", "remote_mismatch"]);
  await assertNoWrites(workspaceDirectory, storageRoot);

  // Human preview prints one attention line per diagnostic entry before the
  // confirmation gate refuses without --digest.
  const humanPreview = await runCli(args, env);
  parseRefusal(humanPreview);
  const text = humanPreview.stdout.replaceAll("\r", "");
  assert.match(text, /^attention directory_mismatch$/m);
  assert.match(text, /^attention remote_mismatch$/m);
  await assertNoWrites(workspaceDirectory, storageRoot);
});
