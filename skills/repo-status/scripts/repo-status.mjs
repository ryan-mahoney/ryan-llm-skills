import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

export function parseArgs(argv, cwd = process.cwd()) {
  const options = { root: path.resolve(cwd), depth: 0, prs: false, help: false };
  let hasRoot = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--depth") {
      const value = argv[++i];
      if (!/^[0-9]+$/.test(value ?? "") || !Number.isSafeInteger(Number(value))) {
        throw new Error("--depth requires a nonnegative decimal safe integer");
      }
      options.depth = Number(value);
    } else if (arg === "--prs") {
      options.prs = true;
    } else if (arg === "--help") {
      options.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      if (hasRoot) throw new Error("only one root path is accepted");
      options.root = path.resolve(cwd, arg);
      hasRoot = true;
    }
  }

  return options;
}

// Also use this environment for gh, whose checkout resolution invokes Git.
export function sanitizedGitEnv(env = process.env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if ([
      "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX",
      "GIT_NAMESPACE", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    ].includes(key) || /^GIT_CONFIG_(KEY|VALUE)_[0-9]+$/.test(key)) {
      delete clean[key];
    }
  }
  return { ...clean, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" };
}

export function runProcess(command, args, {
  cwd,
  env = process.env,
  deadline = Infinity,
  childLimitMs = 10000,
  maxBuffer = 8388608,
} = {}) {
  // Rounding down avoids scheduling past the monotonic deadline. A zero timeout
  // disables spawnSync's timeout, so stop before spawning when less than 1 ms remains.
  const timeout = Math.floor(Math.min(10000, childLimitMs, deadline - performance.now()));
  if (timeout <= 0) {
    return { status: null, signal: null, error: null, stdout: "", stderr: "", kind: "budget-exhausted" };
  }

  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    killSignal: "SIGKILL",
    maxBuffer,
  });
  // spawnSync can return the chunk that crossed maxBuffer. Retain bounded
  // diagnostic bytes, and never allow an overflowing result to become success.
  const outputBytes = (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0);
  const stdout = result.stdout?.subarray(0, maxBuffer);
  const stderr = result.stderr?.subarray(0, maxBuffer - (stdout?.length ?? 0));
  let kind;
  if (result.error?.code === "ETIMEDOUT") kind = "timeout";
  else if (result.error?.code === "ENOBUFS" || outputBytes > maxBuffer) kind = "output-limit";
  else if (result.error?.code === "ENOENT") kind = "unavailable";
  else if (result.error || result.signal || result.status !== 0) kind = "failed";
  else kind = "ok";

  return {
    status: result.status,
    signal: result.signal,
    error: result.error ?? null,
    stdout: stdout?.toString("utf8") ?? "",
    stderr: stderr?.toString("utf8") ?? "",
    kind,
  };
}

export function runGit(dir, args, { env, deadline } = {}) {
  return runProcess("git", ["-C", dir, "-c", "core.fsmonitor=false", ...args], {
    env: sanitizedGitEnv(env),
    deadline,
  });
}
