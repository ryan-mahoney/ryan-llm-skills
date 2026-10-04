import path from "node:path";
import fs from "node:fs";
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

export const DISCOVERY_EXCLUSIONS = Object.freeze([
  ".git", "node_modules", "dist", "build", "target", "out", "coverage", "tmp",
]);

export function parseWorktrees(text) {
  if (text && !text.endsWith("\0")) throw new Error("unterminated worktree registry");
  const entries = [];
  let entry = null;
  for (const field of text.split("\0")) {
    if (!field) {
      if (entry) entries.push(entry);
      entry = null;
    } else if (field.startsWith("worktree ")) {
      if (entry || !field.slice(9)) throw new Error("invalid worktree registry record");
      entry = { path: field.slice(9), branch: null, head: null, bare: false, locked: false, prunable: false };
    } else {
      if (!entry) throw new Error("worktree registry field has no path");
      if (field.startsWith("HEAD ")) entry.head = field.slice(5);
      else if (field.startsWith("branch ")) entry.branch = field.slice(7);
      else if (field === "bare") entry.bare = true;
      else if (field === "locked") entry.locked = true;
      else if (field.startsWith("locked ")) entry.locked = field.slice(7);
      else if (field === "prunable") entry.prunable = true;
      else if (field.startsWith("prunable ")) entry.prunable = field.slice(9);
    }
  }
  return entries;
}

export function discoverRepositories(options, { env, deadline = Infinity, readDir = fs.readdirSync } = {}) {
  const report = {
    root: path.resolve(options.root), effectiveRoot: null, depth: options.depth,
    repos: [], diagnostics: [], incomplete: false,
  };
  const groups = new Map();
  const candidates = new Set();
  const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const fail = (message) => {
    report.incomplete = true;
    report.diagnostics.push(message);
  };
  let budgetReported = false;
  const hasBudget = (dir) => {
    if (performance.now() < deadline) return true;
    if (!budgetReported) fail(`${dir}: discovery budget-exhausted`);
    budgetReported = true;
    return false;
  };
  const gitFailure = (dir, operation, result) => fail(
    `${dir}: ${operation} ${result.kind}: ${result.stderr.trim() || result.error?.message || `exit ${result.status}, signal ${result.signal}`}`,
  );
  const addCandidate = (dir) => {
    if (candidates.has(dir) || !hasBudget(dir)) return;
    candidates.add(dir);
    const result = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { env, deadline });
    if (result.kind !== "ok") {
      gitFailure(dir, "common Git directory", result);
      return;
    }
    if (!hasBudget(dir)) return;
    try {
      // Remove the protocol's final newline only: a path may itself end in one.
      const commonDir = fs.realpathSync(result.stdout.replace(/\n$/, ""));
      const group = groups.get(commonDir);
      if (!group) groups.set(commonDir, { commonDir, path: dir, worktrees: [] });
      else if (ordinal(dir, group.path) < 0) group.path = dir;
    } catch (error) {
      fail(`${dir}: common Git directory unavailable: ${error.message}`);
    }
  };

  if (!hasBudget(report.root)) return report;
  try {
    report.effectiveRoot = fs.realpathSync(report.root);
    if (!hasBudget(report.effectiveRoot)) return report;
    if (!fs.statSync(report.effectiveRoot).isDirectory()) throw new Error("root is not a directory");
  } catch (error) {
    fail(`${report.root}: invalid root: ${error.message}`);
    return report;
  }

  // Include an enclosing checkout without moving the descent anchor to it.
  if (hasBudget(report.effectiveRoot)) {
    const enclosing = runGit(report.effectiveRoot, ["rev-parse", "--show-toplevel"], { env, deadline });
    if (enclosing.kind === "ok" && hasBudget(report.effectiveRoot)) {
      try {
        addCandidate(fs.realpathSync(enclosing.stdout.replace(/\n$/, "")));
      } catch (error) {
        fail(`${report.effectiveRoot}: enclosing checkout unavailable: ${error.message}`);
      }
    } else if (enclosing.kind !== "ok" && !(enclosing.kind === "failed" && enclosing.status === 128 &&
      /not a git repository|must be run in a work tree/.test(enclosing.stderr))) {
      gitFailure(report.effectiveRoot, "enclosing checkout", enclosing);
    }
  }

  // Synchronous filesystem reads cannot enforce a deadline on a stalled mount.
  const pending = [{ dir: report.effectiveRoot, level: 0 }];
  while (pending.length) {
    const { dir, level } = pending.pop();
    if (!hasBudget(dir)) break;
    let entries;
    try {
      entries = readDir(dir, { withFileTypes: true });
    } catch (error) {
      fail(`${dir}: directory traversal failed: ${error.message}`);
      continue;
    }
    if (entries.some((entry) => entry.name === ".git" && (entry.isFile() || entry.isDirectory()))) addCandidate(dir);
    if (level < options.depth) {
      const children = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() &&
        !DISCOVERY_EXCLUSIONS.includes(entry.name)).sort((a, b) => ordinal(b.name, a.name));
      for (const entry of children) pending.push({ dir: path.join(dir, entry.name), level: level + 1 });
    }
  }

  report.repos = [...groups.values()].sort((a, b) => ordinal(a.commonDir, b.commonDir));
  for (const repo of report.repos) {
    if (!hasBudget(repo.path)) break;
    const registry = runGit(repo.path, ["worktree", "list", "--porcelain", "-z"], { env, deadline });
    if (registry.kind !== "ok") {
      gitFailure(repo.path, "worktree registry", registry);
      continue;
    }
    try {
      repo.worktrees = parseWorktrees(registry.stdout);
      if (!repo.worktrees.length) throw new Error("empty worktree registry");
      for (const entry of repo.worktrees) {
        if (!path.isAbsolute(entry.path)) throw new Error("nonabsolute worktree path");
        entry.path = path.normalize(entry.path);
        if (!hasBudget(entry.path)) continue;
        try {
          entry.path = fs.realpathSync(entry.path);
        } catch (error) {
          // Stale registry entries are facts; the later worktree collector owns
          // their unavailable working-tree state. Never prune or drop them here.
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") fail(`${entry.path}: worktree path unavailable: ${error.message}`);
        }
      }
      repo.worktrees.sort((a, b) => ordinal(a.path, b.path));
    } catch (error) {
      fail(`${repo.path}: invalid worktree registry: ${error.message}`);
    }
  }
  hasBudget(report.effectiveRoot);
  if (!report.repos.length && !report.incomplete) fail(`${report.effectiveRoot}: no repositories discovered`);
  report.diagnostics.sort(ordinal);
  return report;
}
