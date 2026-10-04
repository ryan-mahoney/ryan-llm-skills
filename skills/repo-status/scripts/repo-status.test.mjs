import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { parseArgs, runProcess, runGit } from "./repo-status.mjs";

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
