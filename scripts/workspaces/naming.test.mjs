import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { cleanTitle, printReply, suggestTitle, TITLE_MODEL } from "./naming.mjs";

// A spawn stand-in that records argv, kill signals and replays stdout and an
// exit code.
function fakeSpawn({ stdout = "", code = 0, hang = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.killed = false;
    child.kills = [];
    child.kill = (signal) => { child.killed = true; child.kills.push(signal); return true; };
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
  const hungPending = suggestTitle("x", { spawn: hung.spawn, timeoutMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(hung.calls[0].child.killed, true);
  hung.release();
  assert.equal(await hungPending, null);
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, []); // cancellation completes only after the drained close
  assert.equal(hanging.calls[0].child.killed, true);
  hanging.release(0, "late reply", 0);
  assert.equal(await pending, null);
  assert.deepEqual(seen, [null]); // cancelled output is drained, never returned
  hanging.release(0, "more late reply", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [null]); // a settled result cannot be flipped
  const hung = fakeSpawn({ hang: true, stdout: "late reply" });
  const hungSeen = [];
  const hungPending = printReply({ text: "x", spawn: hung.spawn, timeoutMs: 20 })
    .then((value) => { hungSeen.push(value); return value; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(hungSeen, []); // the deadline cancels; the close still drains first
  assert.equal(hung.calls[0].child.killed, true);
  hung.release(0, "late reply", 0);
  assert.equal(await hungPending, null);
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(hungSeen, [null]);
  assert.deepEqual(unhandled, []);
});

test("cancellation drains a delayed-close child and escalates TERM to KILL", async () => {
  // A TERM-friendly child that closes late: the promise must not resolve
  // before close so a caller can await it before starting a replacement, and
  // the bounded TERM-to-KILL cleanup is cancelled once the child closes.
  const delayed = fakeSpawn({ hang: true, stdout: "late reply" });
  const order = [];
  const controller = new AbortController();
  const pending = printReply({ text: "x", spawn: delayed.spawn, signal: controller.signal, killGraceMs: 20 })
    .then((value) => { order.push("resolved"); return value; });
  delayed.calls[0].child.once("close", () => order.push("closed"));
  controller.abort();
  assert.deepEqual(delayed.calls[0].child.kills, ["SIGTERM"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []); // no observable completion before close
  delayed.release(0, "late reply", 0);
  assert.equal(await pending, null);
  assert.deepEqual(order, ["closed", "resolved"]); // replacement may start only after close
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(delayed.calls[0].child.kills, ["SIGTERM"]); // close cancels the KILL escalation

  // A TERM-resistant child gets SIGKILL after the grace and still settles at
  // its close, never before.
  const resistant = fakeSpawn({ hang: true, stdout: "late reply" });
  const resistantOrder = [];
  const resistantController = new AbortController();
  const resistantPending = printReply({ text: "x", spawn: resistant.spawn, signal: resistantController.signal, killGraceMs: 20 })
    .then((value) => { resistantOrder.push("resolved"); return value; });
  resistant.calls[0].child.once("close", () => resistantOrder.push("closed"));
  resistantController.abort();
  assert.deepEqual(resistant.calls[0].child.kills, ["SIGTERM"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(resistant.calls[0].child.kills, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(resistantOrder, []); // still not settled until close
  resistant.release(0, "late reply", null);
  assert.equal(await resistantPending, null);
  assert.deepEqual(resistantOrder, ["closed", "resolved"]);
});

test("the output budget counts raw stdout bytes across multibyte replies", async () => {
  const cjk = "日本"; // 2 UTF-16 code units but 6 UTF-8 bytes
  const bytes = Buffer.from(cjk, "utf8");
  assert.equal(bytes.length, 6);
  assert.equal(await printReply({ text: "x", spawn: fakeSpawn({ stdout: bytes }).spawn, maxOutputBytes: 6 }), cjk);
  // 6 bytes exceed a 4-byte budget even though the decoded string length is 2.
  const over = fakeSpawn({ stdout: bytes });
  assert.equal(await printReply({ text: "x", spawn: over.spawn, maxOutputBytes: 4 }), null);
  assert.equal(over.calls[0].child.killed, true);
  // Raw stdout buffers keep split multibyte sequences intact across chunks.
  const split = fakeSpawn({ hang: true });
  const pending = printReply({ text: "x", spawn: split.spawn, maxOutputBytes: 6 });
  split.calls[0].child.stdout.emit("data", bytes.subarray(0, 1));
  split.calls[0].child.stdout.emit("data", bytes.subarray(1));
  split.release(0, "", 0);
  assert.equal(await pending, cjk);
});
