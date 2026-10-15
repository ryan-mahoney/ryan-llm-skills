import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { cleanTitle, printReply, suggestTitle, TITLE_MODEL } from "./naming.mjs";

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
  return {
    spawn,
    calls,
    // Emit a late stdout and close for a hanging child, to prove a settled
    // result cannot be flipped by a drained exit.
    release(index = 0, out = stdout, exitCode = code) {
      const { child } = calls[index];
      child.stdout.emit("data", out);
      child.emit("close", exitCode);
    },
  };
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

test("printReply returns the raw reply while suggestTitle keeps flags, cleanup and fallback", async () => {
  const rawReply = '\n## Title: "Docs listing."\nextra';
  const naming = fakeSpawn({ stdout: rawReply });
  assert.equal(await printReply({ text: "What docs/ files exist?", spawn: naming.spawn }), rawReply);
  assert.equal(await suggestTitle("What docs/ files exist?", { spawn: naming.spawn }), "Docs listing");
  const longInput = "abcde".repeat(500); // 2500 chars, longer than the 2000-char slice
  const flagged = fakeSpawn({ stdout: rawReply });
  await suggestTitle(longInput, { spawn: flagged.spawn });
  const [{ command, args, options }] = flagged.calls;
  assert.equal(command, "pi");
  for (const flag of ["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args[args.indexOf("--model") + 1], TITLE_MODEL);
  assert.equal(args[args.indexOf("--thinking") + 1], "off");
  assert.deepEqual(args.slice(-2), ["--", longInput.slice(0, 2000)]);
  assert.equal(options.shell, false);
  assert.equal(await suggestTitle("x", fakeSpawn({ stdout: "Some title", code: 1 })), null);
  assert.equal(await printReply({ text: "x", spawn: fakeSpawn({ stdout: "Some title", code: 1 }).spawn }), null);
  const throwing = () => { throw new Error("spawn failed"); };
  assert.equal(await suggestTitle("x", { spawn: throwing }), null);
  assert.equal(await printReply({ text: "x", spawn: throwing }), null);
  const unused = fakeSpawn();
  assert.equal(await suggestTitle("   ", unused), null);
  assert.equal(await printReply({ text: "   ", spawn: unused.spawn }), null);
  assert.equal(unused.calls.length, 0);
});

test("abort and deadline kill the child, settle once and drain the exit", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  const unused = fakeSpawn();
  assert.equal(await printReply({ text: "x", spawn: unused.spawn, signal: preAborted.signal }), null);
  assert.equal(unused.calls.length, 0);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const hanging = fakeSpawn({ hang: true, stdout: "late reply" });
  const controller = new AbortController();
  const seen = [];
  const pending = printReply({ text: "x", spawn: hanging.spawn, signal: controller.signal })
    .then((value) => { seen.push(value); return value; });
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(hanging.calls[0].child.killed, true);
  hanging.release(0, "late reply", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [null]);
  const hung = fakeSpawn({ hang: true, stdout: "late reply" });
  const hungSeen = [];
  const hungPending = printReply({ text: "x", spawn: hung.spawn, timeoutMs: 20 })
    .then((value) => { hungSeen.push(value); return value; });
  assert.equal(await hungPending, null);
  assert.equal(hung.calls[0].child.killed, true);
  hung.release(0, "late reply", 0);
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(hungSeen, [null]);
  assert.deepEqual(unhandled, []);
});
