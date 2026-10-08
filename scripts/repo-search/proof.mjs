#!/usr/bin/env node
// Step 7 finite offline real-model semantic proof.
//
// Creates a disposable tracked Git fixture, builds and searches through the
// actual public Node CLI (node cli.mjs build/search) under macOS sandbox-exec
// network denial, and writes honest result/transcript artifacts. No engine,
// model, or vector substitution; no downloads, source indexing, operator state
// writes, or network access. Structured argv only; no shell.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "cli.mjs");
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const TIME_BIN = "/usr/bin/time";
const NETWORK_DENY_PROFILE = "(version 1)(allow default)(deny network*)";

// Fixed before execution; the query deliberately omits the literal target
// phrase/path and the distractors' implementation terms.
const QUERY = "when an operation keeps failing, wait longer between each attempt with an upper limit";
const EXPECTED_TARGET = "src/delayed-retry.ts";

const FIXTURE_FILES = {
  "src/delayed-retry.ts": [
    "const MAX_ATTEMPTS = 5;",
    "const BASE_DELAY_MS = 100;",
    "const MAX_DELAY_MS = 5000;",
    "",
    "export async function fetchWithGrowingBackoff<T>(operation: () => Promise<T>): Promise<T> {",
    "  let attempt = 0;",
    "  for (;;) {",
    "    try {",
    "      return await operation();",
    "    } catch (error) {",
    "      attempt += 1;",
    "      if (attempt > MAX_ATTEMPTS) throw error;",
    "      const delayMs = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);",
    "      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/fixed-poll.ts": [
    "export async function pollFixedInterval<T>(read: () => Promise<T>, attempts: number): Promise<T> {",
    "  for (let index = 0; index < attempts; index += 1) {",
    "    const value = await read();",
    "    if (value) return value;",
    "    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));",
    "  }",
    "  throw new Error('poll exhausted');",
    "}",
    "",
  ].join("\n"),
  "src/read-once.ts": [
    "export async function readOnce<T>(read: () => Promise<T>): Promise<T> {",
    "  return read();",
    "}",
    "",
  ].join("\n"),
};

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--models" && flag !== "--artifacts" && flag !== "--deadline-ms") {
      return { ok: false, message: `Unknown argument: ${flag}` };
    }
    const value = argv[index + 1];
    if (value === undefined) return { ok: false, message: `Missing value for ${flag}` };
    index += 1;
    if (flag === "--models") options.models = value;
    else if (flag === "--artifacts") options.artifacts = value;
    else options.deadlineMs = value;
  }
  if (typeof options.models !== "string" || options.models.length === 0) {
    return { ok: false, message: "--models is required" };
  }
  if (typeof options.artifacts !== "string" || options.artifacts.length === 0) {
    return { ok: false, message: "--artifacts is required" };
  }
  if (!/^[1-9]\d*$/.test(options.deadlineMs ?? "")) {
    return { ok: false, message: "--deadline-ms must be a positive integer" };
  }
  return {
    ok: true,
    value: {
      models: resolve(options.models),
      artifacts: resolve(options.artifacts),
      deadlineMs: Number.parseInt(options.deadlineMs, 10),
    },
  };
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseMaxRssBytes(stderr) {
  const match = /(\d+)\s+maximum resident set size/m.exec(stderr ?? "");
  return match ? Number.parseInt(match[1], 10) : null;
}

function lastNonEmptyLine(text) {
  const lines = String(text ?? "").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.length > 0) return line;
  }
  return "";
}

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? ""}`);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    process.exitCode = 2;
    return;
  }
  const { models, artifacts, deadlineMs } = parsed.value;
  const startedAt = new Date().toISOString();
  const deadlineAt = Date.now() + deadlineMs;
  const remaining = () => Math.max(0, deadlineAt - Date.now());

  const result = {
    version: 1,
    status: "pending-setup",
    reason: "not-run",
    query: QUERY,
    expectedTarget: EXPECTED_TARGET,
    networkDenied: false,
    networkDenialMechanism: "sandbox-exec",
    observedAt: startedAt,
    startedAt,
    finishedAt: null,
    timings: { totalMs: null, buildMs: null, searchMs: null },
    maxRssBytes: null,
    targetSha256: sha256(FIXTURE_FILES[EXPECTED_TARGET]),
    repoKey: null,
    checkoutKey: null,
    generationId: null,
    returnedPaths: [],
    steps: [],
  };

  const fail = (reason, message) => {
    result.status = "failed";
    result.reason = reason;
    if (message !== undefined) result.error = message;
  };
  const pending = (reason, message) => {
    result.status = "pending-setup";
    result.reason = reason;
    if (message !== undefined) result.error = message;
  };

  let fixtureRoot = null;
  const finish = () => {
    // Owned fixture cleanup happens before the final result write; a cleanup
    // failure downgrades the outcome rather than being hidden.
    if (fixtureRoot) {
      try {
        rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = null;
      } catch (error) {
        fail("cleanup-failed", error instanceof Error ? error.message : String(error));
      }
    }
    result.finishedAt = new Date().toISOString();
    result.timings.totalMs = Date.now() - Date.parse(startedAt);
    writeAtomic(join(artifacts, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === "passed" ? 0 : 1;
  };

  try {
    if (!existsSync(SANDBOX_EXEC) || !existsSync(TIME_BIN)) {
      pending("sandbox-or-time-unavailable");
      return;
    }
    if (!existsSync(models) || !statSync(models).isDirectory()) {
      pending("model-unavailable");
      return;
    }

    fixtureRoot = mkdtempSync(join(tmpdir(), "repo-search-proof-"));
    const repo = join(fixtureRoot, "repo");
    mkdirSync(repo, { recursive: true });
    for (const [path, content] of Object.entries(FIXTURE_FILES)) {
      writeAtomic(join(repo, path), content);
      writeAtomic(join(artifacts, "fixture", path), content);
    }

    runGit(repo, ["init", "-q", "-b", "main"]);
    runGit(repo, ["add", "-A"]);
    runGit(repo, [
      "-c",
      "user.name=Proof Fixture",
      "-c",
      "user.email=proof@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    const stateRoot = join(fixtureRoot, "state");

    const runCli = (label, args, ceilingMs) => {
      const available = remaining() - 10_000;
      if (available <= 0) {
        result.steps.push({
          label,
          argv: null,
          exitCode: null,
          signal: null,
          elapsedMs: 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          timedOut: true,
          message: "insufficient remaining deadline",
        });
        fail("timeout");
        return { status: null, signal: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" }, timedOut: true };
      }
      const internalTimeoutMs = Math.min(ceilingMs, available);
      const outerTimeoutMs = Math.min(remaining(), internalTimeoutMs + 5000);
      const argv = [
        SANDBOX_EXEC,
        "-p",
        NETWORK_DENY_PROFILE,
        TIME_BIN,
        "-l",
        process.execPath,
        CLI,
        ...args,
        "--timeout-ms",
        String(internalTimeoutMs),
        "--json",
      ];
      const stepStarted = Date.now();
      const spawned = spawnSync(argv[0], argv.slice(1), {
        cwd: repo,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: outerTimeoutMs,
      });
      const timedOut = Boolean(spawned.error && spawned.error.code === "ETIMEDOUT");
      if (spawned.status !== null) result.networkDenied = true;
      const step = {
        label,
        argv,
        exitCode: spawned.status,
        signal: spawned.signal,
        elapsedMs: Date.now() - stepStarted,
        stdoutBytes: Buffer.byteLength(spawned.stdout ?? "", "utf8"),
        stderrBytes: Buffer.byteLength(spawned.stderr ?? "", "utf8"),
        timedOut,
      };
      result.steps.push(step);
      writeAtomic(join(artifacts, "commands", `${label}.json`), `${JSON.stringify(argv, null, 2)}\n`);
      writeAtomic(join(artifacts, "transcripts", `${label}.stdout`), spawned.stdout ?? "");
      writeAtomic(join(artifacts, "transcripts", `${label}.stderr`), spawned.stderr ?? "");
      const rss = parseMaxRssBytes(spawned.stderr);
      if (rss !== null) result.maxRssBytes = Math.max(result.maxRssBytes ?? 0, rss);
      return { ...spawned, timedOut };
    };

    const build = runCli(
      "build",
      ["build", "--root", repo, "--state", stateRoot, "--models", models],
      480000,
    );
    result.timings.buildMs = result.steps[result.steps.length - 1].elapsedMs;
    if (build.status !== 0) {
      const parsedBuild = (() => {
        try {
          return JSON.parse(lastNonEmptyLine(build.stdout));
        } catch {
          return null;
        }
      })();
      if (build.timedOut || (build.error && build.error.code === "ETIMEDOUT")) {
        fail("timeout");
      } else if (parsedBuild && parsedBuild.reason === "model-unavailable") {
        pending("model-unavailable");
      } else {
        fail("build-failed");
      }
      return;
    }

    const search = runCli(
      "search",
      [
        "search",
        "--root",
        repo,
        "--state",
        stateRoot,
        "--models",
        models,
        "--query",
        QUERY,
        "--mode",
        "vector",
        "--limit",
        "10",
      ],
      110000,
    );
    result.timings.searchMs = result.steps[result.steps.length - 1].elapsedMs;
    if (search.status !== 0) {
      if (search.timedOut || (search.error && search.error.code === "ETIMEDOUT")) {
        fail("timeout");
      } else {
        fail("search-failed");
      }
      return;
    }

    const stdout = search.stdout ?? "";
    if (Buffer.byteLength(stdout, "utf8") > 4096) {
      fail("output-budget");
      return;
    }
    if (stdout.includes(QUERY)) {
      fail("query-echo");
      return;
    }
    let receipt;
    try {
      receipt = JSON.parse(lastNonEmptyLine(stdout));
    } catch {
      fail("unparsable-output");
      return;
    }

    const hits = Array.isArray(receipt.hits) ? receipt.hits : [];
    result.returnedPaths = hits.map((hit) => hit.path);
    result.generationId = receipt.generationId ?? null;
    result.checkoutKey = receipt.checkoutKey ?? null;
    result.repoKey = receipt.repoKey ?? null;
    const coverage = receipt.coverage ?? {};
    if (coverage.completeness !== "unknown" && coverage.completeness !== "partial") {
      fail("unexpected-coverage");
      return;
    }

    if (!result.returnedPaths.includes(EXPECTED_TARGET)) {
      fail("relevance");
      return;
    }
    result.status = "passed";
    result.reason = "target-retrieved";
  } catch (error) {
    fail("proof-error", error instanceof Error ? error.message : String(error));
  } finally {
    finish();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
