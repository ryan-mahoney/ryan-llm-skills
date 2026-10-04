import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { parseArgs, runProcess, runGit, parseWorktrees, discoverRepositories } from "./repo-status.mjs";

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("arguments: defaults and complete decimal safe integers", () => {
  assert.deepEqual(parseArgs([], "/fixture/root"), {
    root: "/fixture/root", depth: 0, prs: false, help: false,
  });
  assert.equal(parseArgs([]).root, process.cwd());
  assert.deepEqual(parseArgs(["../other", "--depth", "02", "--prs"], "/fixture/root"), {
    root: "/fixture/other", depth: 2, prs: true, help: false,
  });
  for (const [value, expected] of [["0", 0], ["17", 17], ["9007199254740991", 9007199254740991]]) {
    assert.equal(parseArgs(["--depth", value]).depth, expected, value);
  }
});

test("arguments: reject missing or invalid depths, unknown flags and extra roots", () => {
  for (const value of [undefined, "", "-1", "1.5", "9007199254740992", "1e3", "0x10", "+2", " 2", "2tail", "--prs"]) {
    const argv = value === undefined ? ["--depth"] : ["--depth", value];
    assert.throws(() => parseArgs(argv), /--depth requires/, JSON.stringify(argv));
  }
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/);
  assert.throws(() => parseArgs(["first", "second"]), /only one root/);
  assert.throws(() => parseArgs(["--help", "--depth", "-1"]), /--depth requires/);
});

test("arguments: help and module import perform no collection", (t) => {
  const dir = temporaryDirectory(t);
  const marker = path.join(dir, "collected");
  const executable = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\n`;
  fs.writeFileSync(path.join(dir, "git"), executable, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "gh"), executable, { mode: 0o755 });
  const moduleUrl = new URL("./repo-status.mjs", import.meta.url).href;
  const result = runProcess(process.execPath, ["--input-type=module", "-e",
    `const { parseArgs } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(parseArgs(['--help'])));`,
  ], { cwd: dir, env: { ...process.env, PATH: dir } });

  assert.equal(result.kind, "ok", result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { root: fs.realpathSync(dir), depth: 0, prs: false, help: true });
  assert.equal(fs.existsSync(marker), false);
});

test("process policy: preserve successful output, literal arguments and ignored stdin", () => {
  const literal = "$(exit 9); * ' quoted";
  const result = runProcess(process.execPath, ["-e",
    "process.stdout.write(require('node:fs').readFileSync(0, 'utf8') + process.argv[1]);", literal,
  ]);

  assert.deepEqual(result, { status: 0, signal: null, error: null, stdout: literal, stderr: "", kind: "ok" });
});

test("process policy: preserve nonzero status and both output streams", () => {
  const result = runProcess(process.execPath, ["-e",
    "process.stdout.write('known output'); process.stderr.write('known error'); process.exit(7);",
  ]);

  assert.deepEqual(result, {
    status: 7, signal: null, error: null, stdout: "known output", stderr: "known error", kind: "failed",
  });
});

test("process policy: an unavailable executable retains its error", (t) => {
  const result = runProcess(path.join(temporaryDirectory(t), "not-installed"), []);
  assert.equal(result.kind, "unavailable");
  assert.equal(result.status, null);
  assert.equal(result.signal, null);
  assert.equal(result.error.code, "ENOENT");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("process policy: remaining deadline kills an owned blocked child", () => {
  const started = performance.now();
  const result = runProcess(process.execPath, ["-e",
    "process.stdout.write(String(process.pid)); process.stderr.write('waiting'); setInterval(() => {}, 1000);",
  ], { deadline: started + 500, childLimitMs: 5000 });

  assert.equal(result.kind, "timeout");
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.status, null);
  assert.equal(result.stderr, "waiting");
  assert.match(result.stdout, /^[0-9]+$/);
  assert.throws(() => process.kill(Number(result.stdout), 0), { code: "ESRCH" });
  assert.ok(performance.now() - started < 3000, "remaining deadline wins over the 5-second child limit");
});

test("process policy: child limit applies without a collection deadline", () => {
  const result = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { childLimitMs: 100 });
  assert.equal(result.kind, "timeout");
  assert.equal(result.signal, "SIGKILL");
});

test("process policy: output overflow is never a successful observation", () => {
  const result = runProcess(process.execPath, ["-e",
    "require('node:fs').writeSync(1, Buffer.alloc(9 * 1024 * 1024, 'x'));",
  ]);
  assert.equal(result.kind, "output-limit");
  assert.equal(result.error.code, "ENOBUFS");
  assert.equal(result.signal, "SIGKILL");
  assert.ok(result.stdout.length > 0, "retain available output for diagnostics");
  assert.ok(Buffer.byteLength(result.stdout) <= 8388608, "returned output stays within the 8 MiB capture bound");

  const stderr = runProcess(process.execPath, ["-e",
    "require('node:fs').writeSync(2, Buffer.alloc(16384, 'e'));",
  ], { maxBuffer: 1024 });
  assert.equal(stderr.kind, "output-limit");
  assert.equal(stderr.error.code, "ENOBUFS");
});

test("process policy: expired budget schedules no child", (t) => {
  const marker = path.join(temporaryDirectory(t), "started");
  const result = runProcess(process.execPath, ["-e",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`,
  ], { deadline: performance.now() - 1 });

  assert.deepEqual(result, {
    status: null, signal: null, error: null, stdout: "", stderr: "", kind: "budget-exhausted",
  });
  assert.equal(fs.existsSync(marker), false);
});

test("process policy: default runGit sanitizes the actual child environment", (t) => {
  const dir = temporaryDirectory(t);
  const selectionKeys = [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_NAMESPACE", "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_42", "GIT_CONFIG_VALUE_42",
  ];
  const observedKeys = [...selectionKeys, "GIT_OPTIONAL_LOCKS", "GIT_NO_LAZY_FETCH", "LC_ALL", "RETAINED_TEST_VALUE"];
  fs.writeFileSync(path.join(dir, "git"), `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), env: Object.fromEntries(${JSON.stringify(observedKeys)}.filter(key => key in process.env).map(key => [key, process.env[key]])) }));\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: dir, GIT_OPTIONAL_LOCKS: "1", GIT_NO_LAZY_FETCH: "0", LC_ALL: "sentinel", RETAINED_TEST_VALUE: "retained" };
  for (const key of selectionKeys) env[key] = "sentinel";
  const moduleUrl = new URL("./repo-status.mjs", import.meta.url).href;
  const result = runProcess(process.execPath, ["--input-type=module", "-e",
    `const { runGit } = await import(${JSON.stringify(moduleUrl)}); const result = runGit(${JSON.stringify(dir)}, ['rev-parse', '--git-common-dir']); process.stdout.write(result.stdout); process.exit(result.status ?? 1);`,
  ], { env });

  assert.equal(result.kind, "ok", result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    args: ["-C", dir, "-c", "core.fsmonitor=false", "rev-parse", "--git-common-dir"],
    env: { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C", RETAINED_TEST_VALUE: "retained" },
  });
});

test("process policy: real Git uses the named directory despite selection sentinels", (t) => {
  const dir = temporaryDirectory(t);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
  const available = runProcess("git", ["--version"], { env });
  assert.equal(available.kind, "ok", "Git is required for the isolated fixture");
  const initialized = runGit(dir, ["init", "--quiet"], { env });
  assert.equal(initialized.kind, "ok", initialized.stderr);
  const injected = {
    ...env, GIT_DIR: path.join(dir, "wrong.git"), GIT_WORK_TREE: path.join(dir, "wrong-tree"),
    GIT_INDEX_FILE: path.join(dir, "wrong-index"), GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "broken-executable",
  };
  const original = { ...injected };

  const result = runGit(dir, ["rev-parse", "--show-toplevel"], { env: injected });
  assert.equal(result.kind, "ok", result.stderr);
  assert.equal(fs.realpathSync(result.stdout.trim()), fs.realpathSync(dir));
  assert.deepEqual(injected, original, "sanitization does not mutate the caller's environment");
});

function gitFixture(t) {
  const root = fs.realpathSync(temporaryDirectory(t));
  const env = {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
  assert.equal(runProcess("git", ["--version"], { env }).kind, "ok", "Git is required for discovery fixtures");
  const git = (dir, ...args) => {
    const result = runGit(dir, ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { env });
    assert.equal(result.kind, "ok", `${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  const init = (dir, commit = false) => {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "--quiet", "-b", "main");
    if (commit) git(dir, "commit", "--quiet", "--allow-empty", "-m", "Fixture root");
    return dir;
  };
  return { root, env, git, init };
}

test("discovery: NUL registry records preserve newline paths and bare, locked, prunable metadata", () => {
  const head = "a".repeat(40);
  const entries = parseWorktrees([
    "worktree /fixture/bare", "bare", "", "worktree /fixture/line\nbreak\n",
    `HEAD ${head}`, "branch refs/heads/main", "locked reason\nwith newline", "",
    "worktree /fixture/missing", `HEAD ${head}`, "detached", "prunable gitdir file points to non-existent location", "",
    "worktree /fixture/locked", `HEAD ${head}`, "branch refs/heads/other", "locked", "prunable", "", "",
  ].join("\0"));

  assert.deepEqual(entries, [
    { path: "/fixture/bare", branch: null, head: null, bare: true, locked: false, prunable: false },
    { path: "/fixture/line\nbreak\n", branch: "refs/heads/main", head, bare: false, locked: "reason\nwith newline", prunable: false },
    { path: "/fixture/missing", branch: null, head, bare: false, locked: false, prunable: "gitdir file points to non-existent location" },
    { path: "/fixture/locked", branch: "refs/heads/other", head, bare: false, locked: true, prunable: true },
  ]);
  assert.deepEqual(parseWorktrees(""), []);
  assert.throws(() => parseWorktrees("worktree /fixture/truncated"), /unterminated/);
});

test("discovery: depth includes N, excludes N+1 and continues inside repositories", (t) => {
  const { root, env, init } = gitFixture(t);
  const scan = path.join(root, "scan");
  const first = init(path.join(scan, "first"));
  const nested = init(path.join(first, "nested"));
  init(path.join(nested, "too-deep"));
  const sibling = init(path.join(scan, "sibling"));

  const one = discoverRepositories({ root: scan, depth: 1 }, { env });
  assert.equal(one.incomplete, false, one.diagnostics.join("\n"));
  assert.deepEqual(one.repos.map((repo) => repo.path), [first, sibling]);
  const two = discoverRepositories({ root: scan, depth: 2 }, { env });
  assert.equal(two.incomplete, false, two.diagnostics.join("\n"));
  assert.deepEqual(two.repos.map((repo) => repo.path), [first, nested, sibling]);

  const src = path.join(first, "src");
  fs.mkdirSync(src);
  const within = init(path.join(src, "within"));
  const enclosing = discoverRepositories({ root: src, depth: 1 }, { env });
  assert.equal(enclosing.incomplete, false, enclosing.diagnostics.join("\n"));
  assert.equal(enclosing.effectiveRoot, src);
  assert.deepEqual(enclosing.repos.map((repo) => repo.path), [first, within]);
  const zero = discoverRepositories({ root: src, depth: 0 }, { env });
  assert.deepEqual(zero.repos.map((repo) => repo.path), [first]);
  assert.equal(zero.incomplete, false);
});

test("discovery: sibling worktrees share one outside-primary group, while clones and submodules stay distinct", (t) => {
  const { root, env, git, init } = gitFixture(t);
  const primary = init(path.join(root, "primary"), true);
  git(primary, "remote", "add", "origin", "https://example.invalid/shared.git");
  const scan = path.join(root, "scan");
  fs.mkdirSync(scan);
  const a = path.join(scan, "a");
  const b = path.join(scan, "b\n");
  const stale = path.join(root, "outside-stale");
  git(primary, "worktree", "add", "--quiet", "-b", "a", a);
  git(primary, "worktree", "add", "--quiet", "-b", "b", b);
  git(primary, "worktree", "lock", "--reason", "fixture lock", b);
  git(primary, "worktree", "add", "--quiet", "--detach", stale);
  fs.rmSync(stale, { recursive: true });
  const clone = path.join(scan, "clone");
  git(root, "clone", "--quiet", primary, clone);
  git(clone, "remote", "set-url", "origin", "https://example.invalid/shared.git");
  const source = init(path.join(root, "submodule-source"), true);
  git(clone, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", source, "modules/sub");
  const submodule = path.join(clone, "modules/sub");
  const newlineRoot = discoverRepositories({ root: b, depth: 0 }, { env });
  assert.equal(newlineRoot.incomplete, false, newlineRoot.diagnostics.join("\n"));
  assert.equal(newlineRoot.repos[0].path, b, "an enclosing path's own final newline is retained");

  // Wrap only the final Git executable, forwarding every command to real Git.
  // Registry enumeration count is part of the bounded discovery contract.
  const realGit = env.PATH.split(path.delimiter).map((dir) => path.join(dir, "git")).find((file) => fs.existsSync(file));
  assert.ok(realGit, "Git executable prerequisite");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const log = path.join(root, "git-calls.jsonl");
  fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n'); const result = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }); process.exit(result.status ?? 1);\n`, { mode: 0o755 });
  const report = discoverRepositories({ root: scan, depth: 3 }, { env: { ...env, PATH: bin + path.delimiter + env.PATH } });

  assert.equal(report.incomplete, false, report.diagnostics.join("\n"));
  assert.deepEqual(report.repos.map((repo) => repo.commonDir), [
    path.join(primary, ".git"), path.join(clone, ".git"), path.join(clone, ".git/modules/modules/sub"),
  ]);
  const grouped = report.repos[0];
  assert.equal(grouped.path, a);
  assert.deepEqual(grouped.worktrees.map((entry) => entry.path), [stale, primary, a, b]);
  assert.equal(grouped.worktrees.find((entry) => entry.path === b).locked, "fixture lock");
  assert.equal(grouped.worktrees.find((entry) => entry.path === stale).prunable, "gitdir file points to non-existent location");
  assert.equal(report.repos[1].path, clone);
  assert.equal(report.repos[2].path, submodule);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.filter((args) => args.includes("worktree")).map((args) => args[1]), [a, clone, submodule]);
  assert.equal(fs.existsSync(stale), false, "discovery never repairs a missing registered path");
});

test("discovery: inspect explicit symlink and tmp roots, skip child aliases and exact excluded names", (t) => {
  const { root, env, init } = gitFixture(t);
  const scan = init(path.join(root, "tmp"));
  for (const name of ["node_modules", "dist", "build", "target", "out", "coverage", "tmp"]) init(path.join(scan, name));
  const specs = init(path.join(scan, ".specs"));
  const docs = init(path.join(scan, "docs"));
  const tests = init(path.join(scan, "tests"));
  const elsewhere = init(path.join(root, "elsewhere"));
  fs.symlinkSync(elsewhere, path.join(scan, "child-alias"));
  const alias = path.join(root, "root-alias");
  fs.symlinkSync(scan, alias);

  const report = discoverRepositories({ root: alias, depth: 1 }, { env });

  assert.equal(report.root, alias);
  assert.equal(report.effectiveRoot, scan);
  assert.equal(report.incomplete, false, report.diagnostics.join("\n"));
  // The root's .git common directory sorts before the nested .specs/.git.
  assert.deepEqual(report.repos.map((repo) => repo.path), [scan, specs, docs, tests]);
  assert.equal(report.repos.find((repo) => repo.path === scan).worktrees[0].path, scan);
});

test("discovery: unreadable traversal and invalid markers retain independent groups", (t) => {
  const { root, env, init } = gitFixture(t);
  const scan = path.join(root, "scan");
  const good = init(path.join(scan, "good"));
  const unreadable = init(path.join(scan, "unreadable"));
  const invalid = path.join(scan, "invalid");
  fs.mkdirSync(invalid);
  fs.writeFileSync(path.join(invalid, ".git"), "gitdir: nonexistent\n");
  const readDir = (dir, options) => {
    if (dir === unreadable) throw Object.assign(new Error("fixture EACCES"), { code: "EACCES" });
    return fs.readdirSync(dir, options);
  };

  const report = discoverRepositories({ root: scan, depth: 1 }, { env, readDir });

  assert.equal(report.incomplete, true);
  assert.deepEqual(report.repos.map((repo) => repo.path), [good]);
  assert.equal(report.repos[0].worktrees[0].path, good);
  assert.equal(report.diagnostics.length, 2);
  assert.match(report.diagnostics[0], /invalid.*common Git directory failed/);
  assert.match(report.diagnostics[1], /unreadable.*directory traversal failed.*EACCES/);
});

test("discovery: invalid roots, empty scans, missing Git and exhausted budgets stay explicit", (t) => {
  const { root, env, init } = gitFixture(t);
  const missing = discoverRepositories({ root: path.join(root, "missing"), depth: 0 }, { env });
  assert.equal(missing.incomplete, true);
  assert.equal(missing.effectiveRoot, null);
  assert.match(missing.diagnostics[0], /invalid root/);
  const file = path.join(root, "file");
  fs.writeFileSync(file, "fixture");
  assert.match(discoverRepositories({ root: file, depth: 0 }, { env }).diagnostics[0], /root is not a directory/);
  const empty = discoverRepositories({ root, depth: 0 }, { env });
  assert.equal(empty.incomplete, true);
  assert.match(empty.diagnostics[0], /no repositories discovered/);
  const repo = init(path.join(root, "repo"));
  const unavailable = discoverRepositories({ root: repo, depth: 0 }, { env: { ...env, PATH: root } });
  assert.equal(unavailable.incomplete, true);
  assert.equal(unavailable.repos.length, 0);
  assert.match(unavailable.diagnostics.join("\n"), /unavailable/);
  const exhausted = discoverRepositories({ root: repo, depth: 1 }, {
    env, deadline: performance.now() - 1, readDir() { assert.fail("expired budget must not schedule traversal"); },
  });
  assert.equal(exhausted.incomplete, true);
  assert.equal(exhausted.repos.length, 0);
  assert.match(exhausted.diagnostics[0], /budget-exhausted/);
});
