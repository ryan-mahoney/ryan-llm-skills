import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

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
    `${dir}: ${operation} ${result.kind} (exit ${result.status}, signal ${result.signal})`,
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
        // Git can report the main submodule's metadata directory as its path.
        // Resolve that checkout from its common directory, even when discovery
        // found only a linked checkout; linked and bare registry paths stay intact.
        if (entry === repo.worktrees[0] && !entry.bare && entry.path === repo.commonDir) {
          const checkout = runGit(repo.commonDir, ["rev-parse", "--show-toplevel"], { env, deadline });
          if (checkout.kind !== "ok") {
            gitFailure(entry.path, "main checkout", checkout);
            continue;
          }
          entry.path = checkout.stdout.replace(/\n$/, "");
          if (!path.isAbsolute(entry.path)) throw new Error("nonabsolute main checkout path");
          if (!hasBudget(entry.path)) continue;
        }
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

export function parseStatus(text) {
  if (!text.endsWith("\0")) throw new Error("unterminated status output");
  const observed = { branch: null, head: null, upstream: null, ahead: null, behind: null, dirty: 0 };
  const headers = new Set();
  const records = text.slice(0, -1).split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith("# ")) {
      const separator = record.indexOf(" ", 2);
      const key = record.slice(2, separator);
      const value = record.slice(separator + 1);
      if (!["branch.oid", "branch.head", "branch.upstream", "branch.ab"].includes(key)) continue;
      if (headers.has(key) || separator < 0 || !value) throw new Error("invalid branch header");
      headers.add(key);
      if (key === "branch.oid") {
        if (value !== "(initial)" && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error("invalid branch OID");
        observed.head = value === "(initial)" ? null : value;
      } else if (key === "branch.head") {
        observed.branch = value === "(detached)" ? null : value;
      } else if (key === "branch.upstream") {
        observed.upstream = value;
      } else {
        const counts = /^\+([0-9]+) -([0-9]+)$/.exec(value);
        if (!counts || !Number.isSafeInteger(Number(counts[1])) || !Number.isSafeInteger(Number(counts[2]))) {
          throw new Error("invalid ahead/behind counts");
        }
        observed.ahead = Number(counts[1]);
        observed.behind = Number(counts[2]);
      }
    } else if (/^1(?: [^ ]+){7} [\s\S]+$/.test(record) || /^u(?: [^ ]+){9} [\s\S]+$/.test(record)) {
      observed.dirty++;
    } else if (/^2(?: [^ ]+){8} [\s\S]+$/.test(record)) {
      // The next NUL field is the source pathname, even if it resembles a header.
      if (!records[++i]) throw new Error("missing rename source pathname");
      observed.dirty++;
    } else if (/^\? [\s\S]+$/.test(record)) {
      observed.dirty++;
    } else if (!/^! [\s\S]+$/.test(record)) {
      throw new Error("invalid status record");
    }
  }
  if (!headers.has("branch.oid") || !headers.has("branch.head") ||
    (observed.ahead !== null && (!observed.head || !observed.upstream))) {
    throw new Error("incomplete branch headers");
  }
  return observed;
}

export function collectWorktree(entry, { env, deadline } = {}) {
  const observed = {
    ...entry, registry: { ...entry }, branch: null, head: null, upstream: null,
    upstreamHead: null, ahead: null, behind: null, dirty: null,
    state: entry.bare ? "bare" : "unavailable", diagnostics: [],
  };
  if (entry.bare) {
    observed.diagnostics.push(`${entry.path}: bare repository has no working-tree observations`);
    return observed;
  }
  const failed = (operation, result) => {
    observed.state = "unavailable";
    observed.diagnostics.push(`${entry.path}: ${operation} ${result.kind} (exit ${result.status}, signal ${result.signal})`);
  };
  const status = runGit(entry.path, [
    "status", "--porcelain=v2", "--branch", "--ahead-behind", "-z",
    "--untracked-files=all", "--ignore-submodules=none", "--renames",
  ], { env, deadline });
  if (status.kind !== "ok") {
    failed("worktree status", status);
    return observed;
  }
  try {
    Object.assign(observed, parseStatus(status.stdout));
  } catch (error) {
    observed.diagnostics.push(`${entry.path}: invalid worktree status: ${error.message}`);
    return observed;
  }
  observed.state = !observed.head ? "unborn" : !observed.branch ? "detached" :
    !observed.upstream ? "no-upstream" : "ok";
  if (observed.state !== "ok") observed.diagnostics.push(`${entry.path}: ${observed.state}`);
  if (!observed.upstream) return observed;

  const upstream = runGit(entry.path, ["rev-parse", "--verify", "--quiet", "@{upstream}^{commit}"], { env, deadline });
  if (upstream.kind === "failed" && upstream.status === 1 && !upstream.signal && !upstream.error &&
    !upstream.stdout && !upstream.stderr) {
    observed.ahead = observed.behind = null;
    if (observed.state === "ok") observed.state = "upstream-unavailable";
    observed.diagnostics.push(`${entry.path}: upstream local ref unavailable: ${observed.upstream}`);
  } else if (upstream.kind !== "ok") {
    observed.ahead = observed.behind = null;
    failed("upstream commit", upstream);
  } else {
    const oid = upstream.stdout.replace(/\n$/, "");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) ||
      (observed.state === "ok" && (observed.ahead === null || observed.behind === null))) {
      observed.ahead = observed.behind = null;
      observed.state = "unavailable";
      observed.diagnostics.push(`${entry.path}: invalid upstream commit or missing divergence counts`);
    } else {
      observed.upstreamHead = oid;
    }
  }
  return observed;
}

export function collectLocal(options, { env, deadline = Infinity } = {}) {
  const report = { ...discoverRepositories(options, { env, deadline }), prs: options.prs };
  for (const repo of report.repos) {
    repo.worktrees = repo.worktrees.map((entry) => collectWorktree(entry, { env, deadline }));
    for (const entry of repo.worktrees) {
      if (entry.state === "unavailable") {
        report.incomplete = true;
        report.diagnostics.push(...entry.diagnostics);
      }
    }
  }
  if (performance.now() >= deadline) {
    report.incomplete = true;
    report.diagnostics.push(`${report.effectiveRoot ?? report.root}: local collection budget-exhausted`);
  }
  return report;
}

export function collectPullRequests(repo, { env = process.env, deadline } = {}) {
  const observed = { repository: null, state: "unavailable", items: [], diagnostics: [] };
  const unavailable = (operation, result) => {
    observed.diagnostics.push(`${repo.path}: ${operation} ${result.kind} (exit ${result.status}, signal ${result.signal})`);
    return observed;
  };
  const ghEnv = sanitizedGitEnv(env);
  for (const key of ["GH_REPO", "GH_DEBUG", "GH_FORCE_TTY", "CLICOLOR_FORCE"]) delete ghEnv[key];
  Object.assign(ghEnv, {
    GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1", NO_COLOR: "1", CLICOLOR: "0",
  });
  const checkout = repo.worktrees.find((entry) => !entry.bare && entry.state !== "unavailable");
  if (!checkout) {
    observed.diagnostics.push(`${repo.path}: GitHub selection unavailable: no available checkout`);
    return observed;
  }
  const selection = runProcess("gh", ["repo", "view", "--json", "nameWithOwner,url"], {
    cwd: checkout.path, env: ghEnv, deadline,
  });
  if (selection.kind !== "ok") return unavailable("GitHub selection", selection);
  try {
    const identity = JSON.parse(selection.stdout);
    if (!identity || typeof identity !== "object" || Array.isArray(identity) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/.test(identity.nameWithOwner) ||
      typeof identity.url !== "string") throw new Error();
    const url = new URL(identity.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::[0-9]+)?$/.test(url.host) ||
      url.pathname !== `/${identity.nameWithOwner}` ||
      identity.url !== `https://${url.host}/${identity.nameWithOwner}`) throw new Error();
    observed.repository = `${url.host}/${identity.nameWithOwner}`;
  } catch {
    observed.diagnostics.push(`${repo.path}: GitHub selection unavailable: invalid repository identity JSON`);
    return observed;
  }
  const list = runProcess("gh", [
    "pr", "list", "--repo", observed.repository, "--state", "open", "--limit", "101", "--json",
    "number,url,title,headRefName,baseRefName,headRepository,headRepositoryOwner,isDraft,mergeable,mergeStateStatus",
  ], { cwd: checkout.path, env: ghEnv, deadline });
  if (list.kind !== "ok") return unavailable("GitHub PR list", list);
  try {
    const items = JSON.parse(list.stdout);
    const numbers = new Set();
    if (!Array.isArray(items) || items.length > 101) throw new Error();
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item) ||
        !Number.isSafeInteger(item.number) || item.number <= 0 || numbers.has(item.number) ||
        !["url", "title", "headRefName", "baseRefName"].every((key) => typeof item[key] === "string") ||
        typeof item.isDraft !== "boolean" ||
        !["mergeable", "mergeStateStatus"].every((key) => item[key] === null || typeof item[key] === "string") ||
        !(item.headRepository === null || (item.headRepository && typeof item.headRepository === "object" &&
          ["name", "nameWithOwner"].every((key) => typeof item.headRepository[key] === "string"))) ||
        !(item.headRepositoryOwner === null || (item.headRepositoryOwner && typeof item.headRepositoryOwner === "object" &&
          typeof item.headRepositoryOwner.login === "string"))) throw new Error();
      numbers.add(item.number);
    }
    observed.items = items.toSorted((a, b) => a.number - b.number).slice(0, 100);
    observed.state = items.length > 100 ? "incomplete" : "complete";
  } catch {
    observed.diagnostics.push(`${repo.path}: GitHub PR list unavailable: invalid PR list JSON or schema`);
  }
  return observed;
}

// Report fields and terminal diagnostics share visible, inert representations.
// Numeric entities retain punctuation for readers without introducing Markdown syntax.
function escapeReportText(value) {
  return String(value).replace(/\r\n|\r|\n/g, "\\n")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/[&<>"'\\`|\[\]()_*#!{}.+\-~=]/g, (character) => `&#${character.charCodeAt(0)};`);
}

export function formatMarkdown(report) {
  const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const display = (value) => value === null || value === undefined ? "unknown / absent" : escapeReportText(value);
  const oid = (value) => display(value?.slice(0, 12));
  const lines = [
    "# Repository status", "",
    `Requested root: ${display(report.root)}`,
    `Effective discovery root: ${display(report.effectiveRoot)}`,
    `Discovery depth: ${display(report.depth)}`,
    `Excluded child directories: ${DISCOVERY_EXCLUSIONS.map(escapeReportText).join(", ")}`,
    `Repositories: ${report.repos.length}`,
    "Worktree scope: all registered worktrees, including paths outside the discovery root and depth.",
    "Comparison: local refs only; remote freshness unknown. No fetch is performed.",
    "Observations are sequential, not an atomic snapshot.", "",
    report.incomplete ? "**Incomplete local collection**" : "Local collection complete.", "",
  ];
  for (const repo of [...report.repos].sort((a, b) => ordinal(a.commonDir, b.commonDir))) {
    lines.push(`## ${display(repo.path)}`, "", `Common Git directory: ${display(repo.commonDir)}`, "",
      "| Worktree | Branch | HEAD | Upstream local ref | Upstream HEAD | Ahead | Behind | Dirty entries | State / reason | Registry metadata |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const entry of [...repo.worktrees].sort((a, b) => ordinal(a.path, b.path))) {
      const registry = entry.registry ?? entry;
      const metadata = [
        `branch: ${registry.branch ?? "absent"}`, `HEAD: ${registry.head?.slice(0, 12) ?? "absent"}`,
        ...(entry.bare ? ["bare"] : []),
        ...(entry.locked ? [`locked: ${entry.locked === true ? "yes" : entry.locked}`] : []),
        ...(entry.prunable ? [`prunable: ${entry.prunable === true ? "yes" : entry.prunable}`] : []),
      ].join("; ");
      const reason = [entry.state, ...(entry.diagnostics ?? []).toSorted(ordinal)].join("; ");
      lines.push(`| ${[
        display(entry.path), display(entry.branch), oid(entry.head), display(entry.upstream),
        oid(entry.upstreamHead), display(entry.ahead), display(entry.behind), display(entry.dirty),
        display(reason), display(metadata),
      ].join(" | ")} |`);
    }
    if (!repo.worktrees.length) lines.push("", "Registered worktree observations unavailable; see diagnostics.");
    lines.push("");
    if (report.prs) {
      const prs = repo.prs;
      lines.push("### Open pull requests", "",
        `GitHub-selected repository: ${display(prs?.repository)}`,
        "Provenance: optional network observations through gh; configured/default checkout selection.",
        `PR collection: ${display(prs?.state ?? "unavailable")}.`, "");
      if (prs?.state === "incomplete") lines.push("Showing 100; additional open PRs exist. PR collection is incomplete.", "");
      if (prs?.state === "complete" && !prs.items.length) lines.push("No open PRs.", "");
      if (!prs || prs.state === "unavailable") lines.push("Pull request facts unavailable; no empty-list or merge-readiness conclusion.", "");
      if (prs?.items.length) {
        lines.push("Mergeability and merge state are observed values; unknown values do not establish merge readiness.", "",
          "| PR | URL | Title | Head branch | Base branch | Head repository | Head owner | Draft | Mergeability | Merge state |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
        for (const item of [...prs.items].sort((a, b) => a.number - b.number)) {
          lines.push(`| ${[
            item.number, item.url, item.title, item.headRefName, item.baseRefName,
            item.headRepository?.nameWithOwner, item.headRepositoryOwner?.login,
            item.isDraft, item.mergeable, item.mergeStateStatus,
          ].map(display).join(" | ")} |`);
        }
        lines.push("");
      }
      for (const diagnostic of [...new Set(prs?.diagnostics ?? [])].sort(ordinal)) lines.push(`- ${display(diagnostic)}`);
      lines.push("");
    }
  }
  if (report.diagnostics.length) {
    lines.push("## Local diagnostics", "");
    for (const diagnostic of [...new Set(report.diagnostics)].sort(ordinal)) lines.push(`- ${display(diagnostic)}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`repo-status: ${escapeReportText(error.message)}\nRun with --help for usage.\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write([
      "Usage: node repo-status.mjs [root path] [--depth N] [--prs] [--help]",
      "Root defaults to cwd; discovery depth defaults to 0 and accepts nonnegative decimal integers.",
      "Discover the enclosing repository and nested repositories through depth N under the supplied root.",
      `Skip child directories: ${DISCOVERY_EXCLUSIONS.join(", ")}. Child symlinks are skipped.`,
      "Always include all registered worktrees, even outside the root and discovery depth.",
      "Git is required for collection. Local refs have unknown remote freshness; no fetch is performed.",
      "Default collection is local only. --prs opts into GitHub observations (at most 100 displayed PRs).",
      "Local collection has a 30-second budget; each child has at most 10 seconds and 8 MiB output.",
      "Failed local reads produce partial facts and nonzero exit; normal absent tracking remains successful.", "",
    ].join("\n"));
    process.exitCode = 0;
    return;
  }
  const started = performance.now();
  const report = collectLocal(options, { deadline: started + 30000 });
  if (options.prs) {
    const deadline = Math.min(performance.now() + 30000, started + 60000);
    for (const repo of report.repos) repo.prs = collectPullRequests(repo, { deadline });
  }
  process.stdout.write(formatMarkdown(report));
  if (report.incomplete) {
    process.stderr.write("repo-status: Incomplete local collection. Git must be available and affected paths readable.\n");
    for (const diagnostic of [...new Set(report.diagnostics)].sort()) {
      process.stderr.write(`${escapeReportText(diagnostic)}\n`);
    }
  }
  process.exitCode = report.incomplete ? 1 : 0;
}

// Node resolves module URLs physically, while argv can retain the installed symlink.
if (process.argv[1] && fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
