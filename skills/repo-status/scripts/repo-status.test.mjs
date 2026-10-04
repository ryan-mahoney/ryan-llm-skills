import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { parseArgs, runProcess, runGit, parseWorktrees, discoverRepositories, parseStatus, collectWorktree, collectLocal, formatMarkdown } from "./repo-status.mjs";

const scriptPath = fileURLToPath(new URL("./repo-status.mjs", import.meta.url));

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
  assert.deepEqual(report.repos[2].worktrees.map((entry) => entry.path), [submodule]);
  const submoduleObserved = collectWorktree(report.repos[2].worktrees[0], { env });
  assert.equal(submoduleObserved.state, "ok");
  assert.equal(submoduleObserved.dirty, 0, "the discovered submodule path is a usable checkout");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.filter((args) => args.includes("worktree")).map((args) => args[1]), [a, clone, submodule]);
  assert.equal(fs.existsSync(stale), false, "discovery never repairs a missing registered path");

  const linkedSubmodule = path.join(root, "outside-submodule");
  git(submodule, "worktree", "add", "--quiet", "-b", "linked-submodule", linkedSubmodule);
  const linkedReport = discoverRepositories({ root: linkedSubmodule, depth: 0 }, { env });
  assert.equal(linkedReport.incomplete, false, linkedReport.diagnostics.join("\n"));
  assert.equal(linkedReport.repos[0].path, linkedSubmodule);
  assert.deepEqual(linkedReport.repos[0].worktrees.map((entry) => entry.path), [linkedSubmodule, submodule],
    "the main checkout resolves independently of the discovered linked checkout");
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

test("facts: NUL records count renames, newline paths, conflicts, submodules and individual untracked files once", () => {
  const oid = "a".repeat(40);
  const headers = [`# branch.oid ${oid}`, "# branch.head topic", "# branch.upstream origin/topic", "# branch.ab +2 -1"];
  const changes = [
    `1 .M N... 100644 100644 100644 ${oid} ${oid} line\nbreak`,
    `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 destination\0# branch.ab +99 -99`,
    `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflict`,
    `1 .M SCMU 160000 160000 160000 ${oid} ${oid} submodule`,
    "? directory/one", "? directory/two", "! ignored\nfile",
  ];
  const expected = { branch: "topic", head: oid, upstream: "origin/topic", ahead: 2, behind: 1, dirty: 6 };
  assert.deepEqual(parseStatus([...headers, ...changes, ""].join("\0")), expected);
  assert.deepEqual(parseStatus([...headers.toReversed(), "# future.extension ignored", ...changes.toReversed(), ""].join("\0")), expected);
  assert.deepEqual(parseStatus(`# branch.head sha256\0# branch.oid ${"b".repeat(64)}\0`), {
    branch: "sha256", head: "b".repeat(64), upstream: null, ahead: null, behind: null, dirty: 0,
  });
});

test("facts: malformed or truncated status cannot become known clean counts", () => {
  const headers = `# branch.oid ${"a".repeat(40)}\0# branch.head main\0`;
  for (const text of [
    "", headers.slice(0, -1), "# branch.head main\0", "# branch.oid invalid\0# branch.head main\0",
    `${headers}# branch.head duplicate\0`, `${headers}# branch.ab +x -1\0`,
    `${headers}# branch.upstream origin/main\0# branch.ab +9007199254740992 -0\0`,
    `${headers}# branch.ab +0 -0\0`, `${headers}1 incomplete\0`, `${headers}? \0`,
    `${headers}2 R. N... 100644 100644 100644 ${"a".repeat(40)} ${"a".repeat(40)} R100 dest\0`,
    `${headers}unknown record\0`,
  ]) assert.throws(() => parseStatus(text), Error, JSON.stringify(text));
});

test("facts: real Git preserves each worktree upstream and authored divergence despite hidden untracked configuration", (t) => {
  const { root, env, git, init } = gitFixture(t);
  const primary = init(path.join(root, "primary"));
  fs.writeFileSync(path.join(primary, "old-name"), "tracked rename contents\n");
  fs.writeFileSync(path.join(primary, "line\nbreak"), "original\n");
  git(primary, "add", "--all");
  git(primary, "commit", "--quiet", "-m", "Shared base");
  // Authored graph: main has two descendants of base; upstream has one.
  const upstreamPath = path.join(root, "upstream");
  git(primary, "worktree", "add", "--quiet", "-b", "upstream", upstreamPath);
  git(primary, "commit", "--quiet", "--allow-empty", "-m", "Main one");
  git(primary, "commit", "--quiet", "--allow-empty", "-m", "Main two");
  const mainHead = git(primary, "rev-parse", "HEAD").trim();
  git(upstreamPath, "commit", "--quiet", "--allow-empty", "-m", "Upstream one");
  const upstreamHead = git(upstreamPath, "rev-parse", "HEAD").trim();
  git(primary, "branch", "--set-upstream-to=upstream", "main");
  const side = path.join(root, "side");
  git(primary, "worktree", "add", "--quiet", "-b", "side", side, "main");
  git(side, "commit", "--quiet", "--allow-empty", "-m", "Side one");
  const sideHead = git(side, "rev-parse", "HEAD").trim();
  git(side, "branch", "--set-upstream-to=main", "side");
  git(primary, "config", "status.showUntrackedFiles", "no");
  git(primary, "config", "status.renames", "false");
  git(primary, "mv", "old-name", "new-name");
  fs.writeFileSync(path.join(primary, "line\nbreak"), "changed\n");
  fs.mkdirSync(path.join(primary, "untracked"));
  fs.writeFileSync(path.join(primary, "untracked/one"), "one");
  fs.writeFileSync(path.join(primary, "untracked/two"), "two");
  fs.writeFileSync(path.join(primary, ".git/info/exclude"), "ignored\n");
  fs.writeFileSync(path.join(primary, "ignored"), "ignored");
  fs.writeFileSync(path.join(side, "side-untracked"), "side dirtiness");
  const entries = discoverRepositories({ root: primary, depth: 0 }, { env }).repos[0].worktrees;

  const main = collectWorktree(entries.find((entry) => entry.path === primary), { env });
  assert.deepEqual({ branch: main.branch, head: main.head, upstream: main.upstream, upstreamHead: main.upstreamHead,
    ahead: main.ahead, behind: main.behind, dirty: main.dirty, state: main.state, diagnostics: main.diagnostics }, {
    branch: "main", head: mainHead, upstream: "upstream", upstreamHead, ahead: 2, behind: 1, dirty: 4, state: "ok", diagnostics: [],
  });
  assert.deepEqual(main.registry, entries.find((entry) => entry.path === primary));
  const sideObserved = collectWorktree(entries.find((entry) => entry.path === side), { env });
  assert.deepEqual({ branch: sideObserved.branch, head: sideObserved.head, upstream: sideObserved.upstream,
    upstreamHead: sideObserved.upstreamHead, ahead: sideObserved.ahead, behind: sideObserved.behind,
    dirty: sideObserved.dirty, state: sideObserved.state }, {
    branch: "side", head: sideHead, upstream: "main", upstreamHead: mainHead,
    ahead: 1, behind: 0, dirty: 1, state: "ok",
  });
});

test("facts: normal no-upstream, unborn, detached and missing-upstream states retain dirtiness", (t) => {
  const { root, env, git, init } = gitFixture(t);
  const primary = init(path.join(root, "primary"), true);
  fs.writeFileSync(path.join(primary, "untracked"), "primary dirtiness");
  const unborn = init(path.join(root, "unborn"));
  fs.writeFileSync(path.join(unborn, "one"), "one");
  fs.writeFileSync(path.join(unborn, "two"), "two");
  const detached = path.join(root, "detached");
  git(primary, "worktree", "add", "--quiet", "--detach", detached);
  fs.writeFileSync(path.join(detached, "untracked"), "detached dirtiness");
  const missing = path.join(root, "missing-upstream");
  git(primary, "worktree", "add", "--quiet", "-b", "missing-upstream", missing);
  git(primary, "config", "branch.missing-upstream.remote", ".");
  git(primary, "config", "branch.missing-upstream.merge", "refs/heads/absent");
  fs.writeFileSync(path.join(missing, "one"), "one");
  fs.writeFileSync(path.join(missing, "two"), "two");
  const entries = discoverRepositories({ root: primary, depth: 0 }, { env }).repos[0].worktrees;
  const unbornEntry = discoverRepositories({ root: unborn, depth: 0 }, { env }).repos[0].worktrees[0];
  for (const [entry, state, dirty] of [
    [entries.find((entry) => entry.path === primary), "no-upstream", 1],
    [unbornEntry, "unborn", 2], [entries.find((entry) => entry.path === detached), "detached", 1],
    [entries.find((entry) => entry.path === missing), "upstream-unavailable", 2],
  ]) {
    const observed = collectWorktree(entry, { env });
    assert.equal(observed.state, state, observed.diagnostics.join("\n"));
    assert.equal(observed.dirty, dirty, state);
    assert.equal(observed.ahead, null, state);
    assert.equal(observed.behind, null, state);
    assert.equal(observed.upstreamHead, null, state);
    assert.ok(observed.diagnostics.length > 0, `${state} has an explicit reason`);
    assert.deepEqual(observed.registry, entry);
    if (state === "unborn") { assert.equal(observed.head, null); assert.equal(observed.branch, "main"); }
    if (state === "detached") { assert.equal(observed.branch, null); assert.match(observed.head, /^[a-f0-9]{40}$/); }
    if (state === "upstream-unavailable") assert.equal(observed.upstream, "absent");
  }
});

test("facts: stale registry paths retain metadata with unknown observations; bare entries require no status command", (t) => {
  const { root, env, git, init } = gitFixture(t);
  const primary = init(path.join(root, "primary"), true);
  const stale = path.join(root, "stale");
  git(primary, "worktree", "add", "--quiet", "-b", "stale", stale);
  git(primary, "worktree", "lock", "--reason", "retained lock", stale);
  fs.rmSync(stale, { recursive: true });
  const entry = discoverRepositories({ root: primary, depth: 0 }, { env }).repos[0].worktrees.find((entry) => entry.path === stale);
  const observed = collectWorktree(entry, { env });
  assert.equal(observed.state, "unavailable");
  assert.deepEqual(observed.registry, entry);
  assert.equal(observed.registry.branch, "refs/heads/stale");
  assert.equal(observed.locked, "retained lock");
  for (const key of ["branch", "head", "upstream", "upstreamHead", "ahead", "behind", "dirty"]) assert.equal(observed[key], null, key);
  assert.match(observed.diagnostics[0], /worktree status failed/);
  assert.equal(fs.existsSync(stale), false, "collection does not repair a missing registered worktree");
  const bare = path.join(root, "bare");
  git(root, "clone", "--quiet", "--bare", primary, bare);
  const bareEntry = parseWorktrees(git(bare, "worktree", "list", "--porcelain", "-z"))[0];
  const bareObserved = collectWorktree(bareEntry, { env: { ...env, PATH: root } });
  assert.equal(bareObserved.state, "bare", "bare metadata needs no Git executable");
  assert.deepEqual(bareObserved.registry, bareEntry);
  assert.equal(bareObserved.dirty, null);
  assert.ok(bareObserved.diagnostics.length > 0);
});

test("facts: failed upstream reads preserve known dirtiness and never masquerade as expected absence", (t) => {
  const dir = fs.realpathSync(temporaryDirectory(t));
  const oid = "a".repeat(40);
  const status = `# branch.oid ${oid}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0? dirty\0`;
  const entry = { path: dir, branch: "refs/heads/main", head: oid, bare: false, locked: false, prunable: false };
  fs.writeFileSync(path.join(dir, "git"), `#!${process.execPath}\nif (process.argv.includes('status')) process.stdout.write(${JSON.stringify(status)}); else { process.stderr.write('fixture read failure'); process.exit(1); }\n`, { mode: 0o755 });
  const observed = collectWorktree(entry, { env: { ...process.env, PATH: dir } });
  assert.equal(observed.state, "unavailable");
  assert.equal(observed.dirty, 1);
  assert.equal(observed.head, oid);
  assert.equal(observed.upstream, "origin/main");
  assert.equal(observed.upstreamHead, null);
  assert.equal(observed.ahead, null);
  assert.equal(observed.behind, null);
  assert.match(observed.diagnostics[0], /upstream commit failed/);

  fs.writeFileSync(path.join(dir, "git"), `#!${process.execPath}\nprocess.stdout.write('malformed\\0');\n`, { mode: 0o755 });
  const malformed = collectWorktree(entry, { env: { ...process.env, PATH: dir } });
  assert.equal(malformed.state, "unavailable");
  assert.equal(malformed.dirty, null);
  assert.match(malformed.diagnostics[0], /invalid worktree status/);
  const exhausted = collectWorktree(entry, { deadline: performance.now() - 1 });
  assert.equal(exhausted.state, "unavailable");
  assert.equal(exhausted.dirty, null);
  assert.match(exhausted.diagnostics[0], /budget-exhausted/);
});

function runCli(args, { cwd, env, preload } = {}) {
  return runProcess(process.execPath, [
    ...(preload ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`] : []), scriptPath, ...args,
  ], { cwd, env, childLimitMs: 10000 });
}

// Decode only in assertion views; raw-output assertions below protect inert markup.
function visibleReport(text) {
  return text.replace(/&#([0-9]+);/g, (_, number) => String.fromCharCode(Number(number)));
}

test("report: deterministic ordering, nullable facts and registry reasons survive inert escaping", () => {
  const injection = "pipe|\n# heading `code` <script>alert(1)</script> [link](url) !*_\\\u001b\t";
  const worktree = (checkout, branch) => ({
    path: checkout, branch, head: "a".repeat(40), upstream: "origin/main", upstreamHead: "b".repeat(40),
    ahead: 2, behind: 1, dirty: 4, state: "ok", diagnostics: ["z reason", "a reason"],
    registry: { branch: "refs/heads/main", head: "a".repeat(40) }, locked: injection, prunable: "missing",
  });
  const report = {
    root: injection, effectiveRoot: "/physical", depth: 2, prs: false, incomplete: true,
    diagnostics: [injection, "z diagnostic", "a diagnostic"],
    repos: [
      { path: "/z", commonDir: "/z/.git", worktrees: [worktree("/z/b", injection), worktree("/z/a", "topic")] },
      { path: "/a", commonDir: "/a/.git", worktrees: [{
        ...worktree("/a/missing", null), head: null, upstream: null, upstreamHead: null,
        ahead: null, behind: null, dirty: null, state: "unavailable", diagnostics: ["worktree status failed"],
      }] },
    ],
  };
  const output = formatMarkdown(report);
  const reordered = { ...report, diagnostics: report.diagnostics.toReversed(), repos: report.repos.toReversed().map((repo) => ({
    ...repo, worktrees: repo.worktrees.toReversed().map((entry) => ({ ...entry, diagnostics: entry.diagnostics.toReversed() })),
  })) };
  assert.equal(formatMarkdown(reordered), output);
  assert.ok(output.indexOf("## /a") < output.indexOf("## /z"));
  assert.ok(output.indexOf("| /z/a") < output.indexOf("| /z/b"));
  const rows = output.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| ---") && !line.startsWith("| Worktree"));
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(row.split("|").length, 12, "dynamic data cannot introduce a cell");
  assert.equal(output.split("\n").filter((line) => line.startsWith("# ")).length, 1);
  assert.doesNotMatch(output, /<script>|`|\u001b|\t|\n# heading|\[link\]/);
  assert.match(output, /&#124;.*&#92;n.*&#96;code&#96;.*&#60;script&#62;/);
  assert.match(output, /&#92;u001b&#92;u0009/);
  const visible = visibleReport(output);
  assert.match(visible, /unknown \/ absent.*unavailable.*worktree status failed/);
  assert.match(visible, /locked: pipe\|\\n# heading/);
  assert.match(visible, /branch: refs\/heads\/main; HEAD: aaaaaaaaaaaa/);
  assert.match(output, /Incomplete local collection/);
  assert.match(output, /remote freshness unknown/);
  assert.match(output, /sequential, not an atomic snapshot/);
  assert.match(visible, /Excluded child directories: \.git, node_modules, dist, build, target, out, coverage, tmp/);
});

test("report: expired local budget emits unknown coverage without scheduling a child", (t) => {
  const root = temporaryDirectory(t);
  const marker = path.join(root, "invoked");
  fs.writeFileSync(path.join(root, "git"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\n`, { mode: 0o755 });
  const report = collectLocal({ root, depth: 2, prs: false }, { env: { ...process.env, PATH: root }, deadline: performance.now() - 1 });
  assert.equal(report.incomplete, true);
  assert.equal(report.repos.length, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.match(visibleReport(formatMarkdown(report)), /Incomplete local collection[\s\S]*budget-exhausted/);
});

test("local CLI: help and invalid options invoke neither Git nor gh", (t) => {
  const root = temporaryDirectory(t);
  const marker = path.join(root, "invoked");
  for (const name of ["git", "gh"]) fs.writeFileSync(path.join(root, name), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(9);\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: root };
  const help = runCli(["--help"], { cwd: root, env });
  assert.equal(help.kind, "ok", help.stderr);
  assert.match(help.stdout, /discovery depth defaults to 0/);
  assert.match(help.stdout, /all registered worktrees, even outside/);
  assert.match(help.stdout, /unknown remote freshness/);
  assert.match(help.stdout, /at most 100 displayed PRs/);
  assert.equal(help.stderr, "");
  for (const args of [["--depth", "-1"], ["--depth"], ["--unexpected"], ["a", "b"]]) {
    const invalid = runCli(args, { cwd: root, env });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /repo-status:.*\nRun with --help/);
  }
  assert.equal(fs.existsSync(marker), false);
});

test("local CLI: ordinary repo/src invocation reports authored graph, all worktrees and identical reruns", (t) => {
  const { root, env, git, init } = gitFixture(t);
  const primary = init(path.join(root, "primary"), true);
  const upstream = path.join(root, "outside-upstream");
  git(primary, "worktree", "add", "--quiet", "-b", "upstream", upstream);
  git(primary, "commit", "--quiet", "--allow-empty", "-m", "Main one");
  git(primary, "commit", "--quiet", "--allow-empty", "-m", "Main two");
  const mainHead = git(primary, "rev-parse", "HEAD").trim();
  git(upstream, "commit", "--quiet", "--allow-empty", "-m", "Upstream one");
  const upstreamHead = git(upstream, "rev-parse", "HEAD").trim();
  git(primary, "branch", "--set-upstream-to=upstream", "main");
  const src = path.join(primary, "src");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "line\nbreak"), "one");
  fs.writeFileSync(path.join(src, "two"), "two");
  const first = runCli([], { cwd: src, env });
  const second = runCli([], { cwd: src, env });
  assert.equal(first.kind, "ok", first.stderr);
  assert.equal(second.kind, "ok", second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stderr, "");
  const visible = visibleReport(first.stdout);
  assert.match(visible, new RegExp(`Requested root: ${src}`));
  assert.match(visible, new RegExp(`Effective discovery root: ${src}`));
  assert.match(visible, /Repositories: 1/);
  assert.ok(visible.includes(`| ${primary} | main | ${mainHead.slice(0, 12)} | upstream | ${upstreamHead.slice(0, 12)} | 2 | 1 | 2 | ok |`));
  assert.ok(visible.includes(`| ${upstream} | upstream | ${upstreamHead.slice(0, 12)} | unknown / absent | unknown / absent | unknown / absent | unknown / absent | 0 | no-upstream;`));
  assert.match(visible, /local refs only; remote freshness unknown/);
});

test("local CLI: normal lifecycle absences retain dirtiness and exit zero", (t) => {
  const { root, env, git, init } = gitFixture(t);
  const primary = init(path.join(root, "primary"), true);
  const unborn = init(path.join(root, "unborn"));
  fs.writeFileSync(path.join(unborn, "one"), "one");
  const detached = path.join(root, "detached");
  git(primary, "worktree", "add", "--quiet", "--detach", detached);
  const missing = path.join(root, "missing-upstream");
  git(primary, "worktree", "add", "--quiet", "-b", "missing-upstream", missing);
  git(primary, "config", "branch.missing-upstream.remote", ".");
  git(primary, "config", "branch.missing-upstream.merge", "refs/heads/absent");
  fs.writeFileSync(path.join(missing, "one"), "one");
  const result = runCli([root, "--depth", "1"], { cwd: root, env });
  assert.equal(result.kind, "ok", result.stderr);
  assert.equal(result.stderr, "");
  const visible = visibleReport(result.stdout);
  for (const state of ["no-upstream", "unborn", "detached", "upstream-unavailable"]) assert.ok(visible.includes(state), state);
  assert.ok(visible.includes(`| ${unborn} | main | unknown / absent | unknown / absent | unknown / absent | unknown / absent | unknown / absent | 1 | unborn;`));
  assert.ok(visible.includes(`| ${missing} | missing-upstream |`));
  assert.match(visible, /unknown \/ absent \| unknown \/ absent \| unknown \/ absent \| 1 \| upstream-unavailable;/);
});

function metadataSnapshot(repo) {
  const gitDir = path.join(repo, ".git");
  const names = ["index", "HEAD", "config", "packed-refs"];
  const pending = ["refs"];
  while (pending.length) {
    const relative = pending.pop();
    const absolute = path.join(gitDir, relative);
    if (!fs.existsSync(absolute)) continue;
    if (fs.statSync(absolute).isDirectory()) {
      for (const name of fs.readdirSync(absolute)) pending.push(path.join(relative, name));
    } else names.push(relative);
  }
  return Object.fromEntries(names.sort().filter((name) => fs.existsSync(path.join(gitDir, name))).map((name) => {
    const absolute = path.join(gitDir, name);
    return [name, { bytes: fs.readFileSync(absolute).toString("hex"), mtimeNs: fs.statSync(absolute, { bigint: true }).mtimeNs }];
  }));
}

test("local CLI: touched content leaves index, refs and config unchanged and default collection stays offline", (t) => {
  const { root, env, git, init } = gitFixture(t);
  const primary = init(path.join(root, "primary"));
  const file = path.join(primary, "tracked");
  fs.writeFileSync(file, "unchanged content\n");
  git(primary, "add", "tracked");
  git(primary, "commit", "--quiet", "-m", "Tracked fixture");
  const fsmonitorMarker = path.join(root, "fsmonitor-ran");
  const fsmonitor = path.join(root, "fsmonitor");
  fs.writeFileSync(fsmonitor, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(fsmonitorMarker)}, 'called');\n`, { mode: 0o755 });
  git(primary, "config", "core.fsmonitor", fsmonitor);
  const wrong = init(path.join(root, "wrong"), true);
  fs.writeFileSync(path.join(wrong, "wrong-dirty"), "wrong");
  const realGit = env.PATH.split(path.delimiter).map((dir) => path.join(dir, "git")).find((candidate) => fs.existsSync(candidate));
  assert.ok(realGit, "Git prerequisite");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const log = path.join(root, "git-calls.jsonl");
  const ghMarker = path.join(root, "gh-ran");
  fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(ghMarker)}, 'called'); process.exit(9);\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args,env:{GIT_OPTIONAL_LOCKS:process.env.GIT_OPTIONAL_LOCKS,GIT_NO_LAZY_FETCH:process.env.GIT_NO_LAZY_FETCH,LC_ALL:process.env.LC_ALL}})+'\\n'); if(args.some(arg => /^(fetch|push|pull|clone|ls-remote|remote-|upload-pack|receive-pack)$/.test(arg))) process.exit(91); const result=require('node:child_process').spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'}); process.exit(result.status ?? 1);\n`, { mode: 0o755 });
  // Capture after touching and before any status command could refresh the index.
  const stat = fs.statSync(file);
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 60000));
  const before = metadataSnapshot(primary);
  const injected = {
    ...env, PATH: bin + path.delimiter + env.PATH,
    GIT_DIR: path.join(wrong, ".git"), GIT_WORK_TREE: wrong, GIT_COMMON_DIR: path.join(wrong, ".git"),
    GIT_INDEX_FILE: path.join(wrong, ".git/index"), GIT_OBJECT_DIRECTORY: path.join(wrong, ".git/objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(wrong, ".git/objects"), GIT_PREFIX: "wrong/", GIT_NAMESPACE: "wrong",
    GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='wrong'", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "wrong",
  };
  const result = runCli([primary], { cwd: root, env: injected });
  assert.equal(result.kind, "ok", result.stderr);
  assert.deepEqual(metadataSnapshot(primary), before);
  const visible = visibleReport(result.stdout);
  assert.ok(visible.includes(`| ${primary} | main |`));
  assert.match(visible, /\| 0 \| no-upstream;/);
  assert.ok(!visible.includes(wrong));
  assert.equal(fs.existsSync(fsmonitorMarker), false);
  assert.equal(fs.existsSync(ghMarker), false);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.deepEqual(call.env, { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" });
    assert.deepEqual(call.args.slice(0, 4), ["-C", primary, "-c", "core.fsmonitor=false"]);
    assert.ok(!call.args.some((arg) => /^(fetch|push|pull|clone|ls-remote|remote-|upload-pack|receive-pack)$/.test(arg)));
  }
});

test("local CLI: invalid root, no repositories and missing Git produce explicit nonzero coverage", (t) => {
  const { root, env } = gitFixture(t);
  for (const [args, expected] of [[[path.join(root, "absent")], /invalid root/], [[root], /no repositories discovered/]]) {
    const result = runCli(args, { cwd: root, env });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Incomplete local collection/);
    assert.match(visibleReport(result.stderr), expected);
    assert.ok(visibleReport(result.stdout).includes(args[0]));
  }
  const unavailable = runCli([root], { cwd: root, env: { ...env, PATH: root } });
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /Git must be available/);
  assert.match(unavailable.stdout, /unavailable/);
});

test("local CLI: stale rows and traversal failure retain independent known facts and affected paths", (t) => {
  const { root, env, git, init } = gitFixture(t);
  const good = init(path.join(root, "good"), true);
  const stale = path.join(root, "stale");
  git(good, "worktree", "add", "--quiet", "-b", "stale", stale);
  git(good, "worktree", "lock", "--reason", "retain metadata", stale);
  fs.rmSync(stale, { recursive: true });
  const unreadable = init(path.join(root, "unreadable"), true);
  const preload = `import fs from 'node:fs'; const read=fs.readdirSync; fs.readdirSync=function(dir,...args){if(dir===${JSON.stringify(unreadable)}) throw Object.assign(new Error('fixture EACCES'),{code:'EACCES'}); return read.call(this,dir,...args);};`;
  const result = runCli([root, "--depth", "1"], { cwd: root, env, preload });
  assert.equal(result.status, 1);
  const visible = visibleReport(result.stdout);
  assert.ok(visible.includes(`| ${good} | main |`));
  assert.ok(visible.includes(`| ${stale} | unknown / absent | unknown / absent |`));
  assert.match(visible, /locked: retain metadata/);
  assert.match(visible, /branch: refs\/heads\/stale/);
  assert.match(visible, /unavailable.*worktree status failed/);
  assert.match(visible, /directory traversal failed: fixture EACCES/);
  assert.ok(visibleReport(result.stderr).includes(stale));
  assert.ok(visibleReport(result.stderr).includes(unreadable));
  assert.equal(fs.existsSync(stale), false);
});

test("local CLI: required Git failure and output overflow retain unrelated rows without dumping stderr", (t) => {
  const { root, env, git, init } = gitFixture(t);
  const primary = init(path.join(root, "primary"), true);
  const broken = path.join(root, "broken");
  git(primary, "worktree", "add", "--quiet", "-b", "broken", broken);
  const realGit = env.PATH.split(path.delimiter).map((dir) => path.join(dir, "git")).find((candidate) => fs.existsSync(candidate));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const [mode, expected] of [["failure", /worktree status failed/], ["overflow", /worktree status output-limit/]]) {
    fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nconst args=process.argv.slice(2); if(args[1]===${JSON.stringify(broken)} && args.includes('status')) { ${mode === "overflow" ? "require('node:fs').writeSync(1,Buffer.alloc(9*1024*1024,'x'));" : "process.stderr.write('SENSITIVE_REMOTE_DEBUG_SENTINEL'); process.exit(7);"} } else {const result=require('node:child_process').spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status ?? 1);}\n`, { mode: 0o755 });
    const result = runCli([primary], { cwd: root, env: { ...env, PATH: bin + path.delimiter + env.PATH } });
    assert.equal(result.status, 1);
    const visible = visibleReport(result.stdout);
    assert.match(visible, expected);
    assert.ok(visible.includes(`| ${primary} | main |`));
    assert.ok(visible.includes(`| ${broken} | unknown / absent | unknown / absent |`));
    assert.doesNotMatch(result.stdout + result.stderr, /SENSITIVE_REMOTE_DEBUG_SENTINEL|x{100}/);
    assert.ok(visibleReport(result.stderr).includes(broken));
  }
});

test("local CLI: actual child timeout is presented under the default budget using a controlled external clock", (t) => {
  const root = fs.realpathSync(temporaryDirectory(t));
  fs.writeFileSync(path.join(root, ".git"), "fixture marker");
  fs.writeFileSync(path.join(root, "git"), `#!${process.execPath}\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);\n`, { mode: 0o755 });
  // Only the external clock is controlled: main still initializes its ordinary
  // 30-second allowance, leaving 50ms for a genuinely blocked child.
  const preload = "import { performance } from 'node:perf_hooks'; const now=performance.now.bind(performance); let first=true; performance.now=()=>{ const value=now(); if(first){first=false; return value-29950;} return value; };";
  const result = runCli([root], { cwd: root, env: { ...process.env, PATH: root }, preload });
  assert.equal(result.status, 1);
  assert.match(visibleReport(result.stdout), /Incomplete local collection[\s\S]*timeout/);
  assert.match(visibleReport(result.stderr), /timeout/);
  assert.ok(visibleReport(result.stderr).includes(root));
  assert.doesNotMatch(result.stdout, /Local collection complete/);
});

test("local CLI: a failed upstream read keeps known branch and dirty facts", (t) => {
  const { root, env, git, init } = gitFixture(t);
  const primary = init(path.join(root, "primary"), true);
  git(primary, "branch", "upstream");
  git(primary, "branch", "--set-upstream-to=upstream", "main");
  fs.writeFileSync(path.join(primary, "dirty"), "known dirtiness");
  const head = git(primary, "rev-parse", "HEAD").trim();
  const realGit = env.PATH.split(path.delimiter).map((dir) => path.join(dir, "git")).find((candidate) => fs.existsSync(candidate));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nconst args=process.argv.slice(2); if(args.includes('@{upstream}^{commit}')) {process.stderr.write('SENSITIVE_REMOTE_DEBUG_SENTINEL');process.exit(7);} const result=require('node:child_process').spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status ?? 1);\n`, { mode: 0o755 });
  const result = runCli([primary], { cwd: root, env: { ...env, PATH: bin + path.delimiter + env.PATH } });
  assert.equal(result.status, 1);
  const visible = visibleReport(result.stdout);
  assert.ok(visible.includes(`| ${primary} | main | ${head.slice(0, 12)} | upstream | unknown / absent | unknown / absent | unknown / absent | 1 | unavailable;`));
  assert.match(visible, /upstream commit failed/);
  assert.doesNotMatch(result.stdout + result.stderr, /SENSITIVE_REMOTE_DEBUG_SENTINEL/);
});

test("local CLI: importing with a non-file argv does not accidentally invoke or throw", (t) => {
  const root = temporaryDirectory(t);
  const result = runProcess(process.execPath, ["--input-type=module", "-e",
    `await import(${JSON.stringify(new URL("./repo-status.mjs", import.meta.url).href)});`, "not-a-file",
  ], { cwd: root, env: { ...process.env, PATH: root } });
  assert.equal(result.kind, "ok", result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

function ghFixture(t) {
  const fixture = gitFixture(t);
  const bin = path.join(fixture.root, "bin");
  fs.mkdirSync(bin);
  const log = path.join(fixture.root, "gh-calls.jsonl");
  const data = path.join(fixture.root, "gh-responses.json");
  const marker = path.join(fixture.root, "selection-complete");
  const keys = ["GH_REPO", "GH_DEBUG", "GH_FORCE_TTY", "GH_HOST", "GH_PROMPT_DISABLED", "GH_NO_UPDATE_NOTIFIER",
    "GH_NO_EXTENSION_UPDATE_NOTIFIER", "NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "GIT_DIR", "GIT_WORK_TREE",
    "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX",
    "GIT_NAMESPACE", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
    "GIT_OPTIONAL_LOCKS", "GIT_NO_LAZY_FETCH", "LC_ALL"];
  fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const selection = args[0] === 'repo' && args[1] === 'view';
const list = args[0] === 'pr' && args[1] === 'list';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args,cwd:process.cwd(),pid:process.pid,hasToken:!!process.env.GH_TOKEN,env:Object.fromEntries(${JSON.stringify(keys)}.filter(key=>key in process.env).map(key=>[key,process.env[key]]))})+'\\n');
if (!selection && !list) process.exit(91);
const response = JSON.parse(fs.readFileSync(${JSON.stringify(data)},'utf8'))[process.cwd()];
if (!response) process.exit(92);
const phase = selection ? 'selection' : 'list';
if (list && response.waitList) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);
if (response[phase+'Exit']) {process.stderr.write('SENSITIVE_CREDENTIAL_DEBUG_SENTINEL');process.exit(response[phase+'Exit']);}
process.stdout.write(response[phase+'Raw'] ?? JSON.stringify(selection ? response.identity : response.items));
if (selection) fs.writeFileSync(${JSON.stringify(marker)},'done');
`, { mode: 0o755 });
  return { ...fixture, bin, marker, env: { ...fixture.env, PATH: bin + path.delimiter + fixture.env.PATH,
    GH_CONFIG_DIR: path.join(fixture.root, "gh-config"), GH_TOKEN: "OFFLINE_AUTH_SENTINEL" },
    respond: (responses) => fs.writeFileSync(data, JSON.stringify(responses)),
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [],
  };
}

function prFixture(number, overrides = {}) {
  return { number, url: `https://github.example/owner/project/pull/${number}`, title: `Change ${number}`,
    headRefName: "feature", baseRefName: "main", headRepository: { id: "repo-id", name: "fork", nameWithOwner: "contributor/fork" },
    headRepositoryOwner: { id: "owner-id", login: "contributor", name: "Contributor" }, isDraft: false,
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", ...overrides };
}

const selectedIdentity = { nameWithOwner: "owner/project", url: "https://github.example/owner/project" };

test("pull requests: ordinary CLI scopes two repositories explicitly, preserves uncertainty and sanitizes selection", (t) => {
  const { root, env, init, git, respond, calls } = ghFixture(t);
  const first = init(path.join(root, "first"), true);
  const linked = path.join(root, "linked");
  git(first, "worktree", "add", "--quiet", "-b", "linked", linked);
  const second = init(path.join(root, "second"), true);
  const title = "Pipe|\n# forged `code` <script> [click](url)\u001b";
  respond({
    [first]: { identity: selectedIdentity, items: [prFixture(11, { title, isDraft: true, mergeable: "UNKNOWN", mergeStateStatus: "BLOCKED" }),
      prFixture(2, { mergeable: null, mergeStateStatus: null, headRepository: null, headRepositoryOwner: null })] },
    [second]: { identity: { nameWithOwner: "other/repo", url: "https://github.com/other/repo" }, items: [] },
  });
  const result = runCli([root, "--depth", "1", "--prs"], { cwd: root, env: { ...env,
    GH_REPO: "github.com/wrong/repo", GH_DEBUG: "api", GH_FORCE_TTY: "100%", CLICOLOR_FORCE: "1", GH_HOST: "github.example",
    GIT_DIR: "/missing", GIT_WORK_TREE: "/missing", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "missing",
  } });
  assert.equal(result.kind, "ok", result.stderr);
  assert.equal(result.stderr, "");
  const visible = visibleReport(result.stdout);
  assert.match(visible, /GitHub-selected repository: github.example\/owner\/project/);
  assert.match(visible, /GitHub-selected repository: github.com\/other\/repo/);
  assert.match(visible, /optional network observations through gh/);
  assert.match(visible, /configured\/default checkout selection/);
  assert.match(visible, /\| feature \| main \| contributor\/fork \| contributor \| true \| UNKNOWN \| BLOCKED \|/);
  assert.match(visible, /\| feature \| main \| unknown \/ absent \| unknown \/ absent \| false \| unknown \/ absent \| unknown \/ absent \|/);
  assert.ok(visible.indexOf("| 2 | https:") < visible.indexOf("| 11 | https:"));
  assert.match(visible, /No open PRs/);
  assert.doesNotMatch(result.stdout, /<script>|\u001b|\n# forged|`code`|\[click\]/);
  assert.equal(result.stdout.split("\n").filter((line) => /^\| (2|11) \|/.test(line)).length, 2);
  const observations = calls();
  assert.equal(observations.length, 4, "one selection and one list per common-directory group");
  for (const [offset, cwd, scope] of [[0, first, "github.example/owner/project"], [2, second, "github.com/other/repo"]]) {
    assert.deepEqual(observations[offset].args, ["repo", "view", "--json", "nameWithOwner,url"]);
    assert.deepEqual(observations[offset + 1].args, ["pr", "list", "--repo", scope, "--state", "open", "--limit", "101", "--json",
      "number,url,title,headRefName,baseRefName,headRepository,headRepositoryOwner,isDraft,mergeable,mergeStateStatus"]);
    for (const call of observations.slice(offset, offset + 2)) {
      assert.equal(call.cwd, cwd);
      assert.equal(call.hasToken, true, "authentication remains available without logging its value");
      assert.deepEqual(call.env, { GH_HOST: "github.example", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1",
        GH_NO_EXTENSION_UPDATE_NOTIFIER: "1", NO_COLOR: "1", CLICOLOR: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" });
    }
  }
  assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(observations), /OFFLINE_AUTH_SENTINEL|SENSITIVE_CREDENTIAL_DEBUG_SENTINEL/);
});

test("pull requests: cap sorts numeric rows before showing 100 and keeps additional observations incomplete", (t) => {
  const { root, env, init, respond } = ghFixture(t);
  const primary = init(path.join(root, "primary"), true);
  respond({ [primary]: { identity: selectedIdentity, items: Array.from({ length: 101 }, (_, i) => prFixture(101 - i)) } });
  const result = runCli([primary, "--prs"], { cwd: root, env });
  assert.equal(result.kind, "ok", result.stderr);
  const visible = visibleReport(result.stdout);
  assert.match(visible, /PR collection: incomplete/);
  assert.match(visible, /Showing 100; additional open PRs exist/);
  const rows = visible.split("\n").filter((line) => /^\| [0-9]+ \|/.test(line));
  assert.equal(rows.length, 100);
  assert.match(rows[0], /^\| 1 \|/);
  assert.match(rows[99], /^\| 100 \|/);
  assert.doesNotMatch(visible, /\| 101 \|/);
  assert.doesNotMatch(visible, /No open PRs/);
  assert.match(visible, /Local collection complete/);
  respond({ [primary]: { identity: selectedIdentity, items: Array.from({ length: 100 }, (_, i) => prFixture(i + 1)) } });
  const exact = runCli([primary, "--prs"], { cwd: root, env });
  assert.equal(exact.kind, "ok", exact.stderr);
  assert.match(exact.stdout, /PR collection: complete/);
  assert.doesNotMatch(exact.stdout, /additional open PRs exist|PR collection is incomplete/);
});

test("pull requests: invalid or ambiguous selection never guesses scope or invokes a list", (t) => {
  const { root, env, init, respond, calls } = ghFixture(t);
  const primary = init(path.join(root, "primary"), true);
  const invalid = [null, [], [selectedIdentity], {}, { nameWithOwner: "a/b/c", url: "https://github.com/a/b/c" },
    { ...selectedIdentity, url: "https://github.example/wrong/repo" }, { ...selectedIdentity, url: "https://secret@github.example/owner/project" },
    { ...selectedIdentity, url: "http://github.example/owner/project" }, { ...selectedIdentity, url: "https://github.example/owner/project?token=secret" },
    { ...selectedIdentity, url: "https://github.example/owner/project#fragment" },
    { ...selectedIdentity, url: "https://github..example/owner/project" },
    { ...selectedIdentity, url: "https://github.example/x/../owner/project" }];
  for (const identity of invalid) {
    const before = calls().length;
    respond({ [primary]: { identity, items: [] } });
    const result = runCli([primary, "--prs"], { cwd: root, env });
    assert.equal(result.kind, "ok", JSON.stringify(identity));
    assert.match(visibleReport(result.stdout), /PR collection: unavailable[\s\S]*invalid repository identity JSON/);
    assert.doesNotMatch(result.stdout, /No open PRs|secret|wrong\/repo/);
    assert.equal(calls().length, before + 1);
  }
});

test("pull requests: malformed list JSON or records never become a successful empty list", (t) => {
  const { root, env, init, respond } = ghFixture(t);
  const primary = init(path.join(root, "primary"), true);
  const missing = prFixture(1); delete missing.headRepository;
  for (const value of ["{", "null", "{}", JSON.stringify([null]), JSON.stringify([missing]), JSON.stringify([prFixture(1, { number: "1" })]),
    JSON.stringify([prFixture(1, { isDraft: "false" })]), JSON.stringify([prFixture(1, { headRepositoryOwner: {} })]),
    JSON.stringify([prFixture(1, { mergeable: false })]), JSON.stringify([prFixture(1), prFixture(1)])]) {
    respond({ [primary]: { identity: selectedIdentity, listRaw: value } });
    const result = runCli([primary, "--prs"], { cwd: root, env });
    assert.equal(result.kind, "ok", value);
    const visible = visibleReport(result.stdout);
    assert.match(visible, /GitHub-selected repository: github.example\/owner\/project/);
    assert.match(visible, /PR collection: unavailable[\s\S]*invalid PR list JSON or schema/);
    assert.doesNotMatch(visible, /No open PRs|\| 1 \| https:/);
  }
});

test("pull requests: missing binary, auth and selection failures stay visible without changing local success", (t) => {
  const { root, env, init, respond, bin, calls } = ghFixture(t);
  const primary = init(path.join(root, "primary"), true);
  for (const response of [{ selectionExit: 4 }, { selectionExit: 1 }, { selectionRaw: "{" }, { identity: selectedIdentity, listExit: 4 }]) {
    const before = calls().length;
    respond({ [primary]: response });
    const result = runCli([primary, "--prs"], { cwd: root, env });
    assert.equal(result.kind, "ok", result.stderr);
    assert.match(result.stdout, /PR collection: unavailable/);
    assert.match(result.stdout, /Local collection complete/);
    assert.doesNotMatch(result.stdout + result.stderr, /No open PRs|SENSITIVE_CREDENTIAL_DEBUG_SENTINEL/);
    assert.equal(calls().length, before + (response.listExit ? 2 : 1));
    assert.match(visibleReport(result.stdout), response.selectionRaw ? /invalid repository identity JSON/ :
      new RegExp(`GitHub ${response.listExit ? "PR list" : "selection"} failed \\(exit ${response.listExit ?? response.selectionExit}, signal null\\)`));
  }
  fs.rmSync(path.join(bin, "gh"));
  const realGit = env.PATH.split(path.delimiter).map((dir) => path.join(dir, "git")).find((candidate) => fs.existsSync(candidate));
  fs.symlinkSync(realGit, path.join(bin, "git"));
  const missing = runCli([primary, "--prs"], { cwd: root, env: { ...env, PATH: bin } });
  assert.equal(missing.kind, "ok", missing.stderr);
  assert.match(visibleReport(missing.stdout), /GitHub selection unavailable \(exit null, signal null\)/);
  const before = calls().length;
  const local = runCli([primary], { cwd: root, env });
  assert.equal(local.kind, "ok", local.stderr);
  assert.equal(calls().length, before, "default invocation performs zero gh calls");
  assert.doesNotMatch(local.stdout, /Open pull requests|GitHub-selected repository/);
});

test("pull requests: real gh timeout and expired allowance cross the ordinary CLI adapter and report", (t) => {
  const { root, env, init, respond, calls, marker } = ghFixture(t);
  const primary = init(path.join(root, "primary"), true);
  const second = init(path.join(root, "second"), true);
  respond({ [primary]: { identity: selectedIdentity, waitList: true, items: [] },
    [second]: { identity: { nameWithOwner: "other/repo", url: "https://github.com/other/repo" }, items: [] } });
  // The external clock leaves about 500ms after selection. The normal allowance
  // and production adapters remain active; the fake final list really blocks.
  const preload = `import fs from 'node:fs'; import {performance} from 'node:perf_hooks'; const now=performance.now.bind(performance); let previous=now(),offset; performance.now=()=>{const current=now();if(offset===undefined && fs.existsSync(${JSON.stringify(marker)})) offset=previous+29500-current; previous=current;return current+(offset??0);};`;
  const result = runCli([root, "--depth", "1", "--prs"], { cwd: root, env, preload });
  assert.equal(result.kind, "ok", result.stderr);
  const visible = visibleReport(result.stdout);
  assert.match(visible, /GitHub PR list timeout/);
  assert.match(visible, /GitHub selection budget-exhausted/);
  assert.doesNotMatch(visible, /No open PRs/);
  assert.equal(calls().length, 2, "expired budget schedules no subsequent gh child");
  assert.throws(() => process.kill(calls()[1].pid, 0), { code: "ESRCH" });
});

test("pull requests: available checkout selection survives a stale registry row and preserves local failure", (t) => {
  const { root, env, init, git, respond, calls } = ghFixture(t);
  const primary = init(path.join(root, "z-available"), true);
  const stale = path.join(root, "a-stale");
  git(primary, "worktree", "add", "--quiet", "-b", "stale", stale);
  git(primary, "worktree", "lock", stale);
  fs.rmSync(stale, { recursive: true });
  respond({ [primary]: { identity: selectedIdentity, items: [] } });
  const result = runCli([primary, "--prs"], { cwd: root, env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Incomplete local collection/);
  assert.match(result.stdout, /PR collection: complete[\s\S]*No open PRs/);
  assert.match(visibleReport(result.stdout), /a-stale.*worktree status failed/);
  assert.equal(calls().length, 2);
  assert.ok(calls().every((call) => call.cwd === primary));
  assert.equal(fs.existsSync(stale), false);
});
