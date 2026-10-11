import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { cleanTitle, suggestTitle, TITLE_MODEL } from "./naming.mjs";

// A spawn stand-in that records argv and replays stdout and an exit code.
function fakeSpawn({ stdout = "", code = 0, hang = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    calls.push({ command, args, options, child });
    if (!hang) setImmediate(() => { child.stdout.emit("data", stdout); child.emit("close", code); });
    return child;
  };
  return { spawn, calls };
}

test("cleanTitle keeps one plain line and rejects empty replies", () => {
  assert.equal(cleanTitle("Listing documentation files\n"), "Listing documentation files");
  assert.equal(cleanTitle('\n## Title: "Docs listing."\nextra'), "Docs listing");
  assert.equal(cleanTitle("**Route planner review**"), "Route planner review");
  assert.equal(cleanTitle("word ".repeat(40)).length <= 80, true);
  assert.equal(cleanTitle("word ".repeat(40)).endsWith(" "), false);
  assert.equal(cleanTitle("  \n \n"), null);
  assert.equal(cleanTitle('"..."'), null);
});

test("suggestTitle runs a tool-less one-shot Pi call and cleans its reply", async () => {
  const { spawn, calls } = fakeSpawn({ stdout: "Docs listing.\n" });
  assert.equal(await suggestTitle("What docs/ files exist?", { spawn }), "Docs listing");
  const [{ command, args, options }] = calls;
  assert.equal(command, "pi");
  for (const flag of ["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args[args.indexOf("--model") + 1], TITLE_MODEL);
  assert.deepEqual(args.slice(-2), ["--", "What docs/ files exist?"]);
  assert.equal(options.shell, false);
});

test("suggestTitle returns null on failure, timeout or empty input", async () => {
  assert.equal(await suggestTitle("x", fakeSpawn({ stdout: "Some title", code: 1 })), null);
  const hung = fakeSpawn({ hang: true });
  assert.equal(await suggestTitle("x", { spawn: hung.spawn, timeoutMs: 20 }), null);
  assert.equal(hung.calls[0].child.killed, true);
  const throwing = () => { throw new Error("spawn failed"); };
  assert.equal(await suggestTitle("x", { spawn: throwing }), null);
  const unused = fakeSpawn();
  assert.equal(await suggestTitle("   ", unused), null);
  assert.equal(unused.calls.length, 0);
});
