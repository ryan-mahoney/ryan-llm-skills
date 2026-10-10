// Step 4 focused tests: exclusive creation, atomic replacement and contained
// path resolution for the workspace store primitives.
//
// Every fixture root is realpath(mkdtemp(tmpdir())) and is removed in `after`.
// Child processes are bounded by finite deadlines, waited on, and killed only
// as their own detached groups. No sleeps coordinate the race: children report
// readiness and wait for an explicit IPC go message.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFileExclusive, resolveWorkspacePath, writeFileAtomic } from "./store.mjs";

const STORE_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "store.mjs")).href;

// Shared child program. It patches the node:fs/promises object before importing
// the production module so the injected failures hit the open/write/sync/link/
// rename boundaries without any production flag or hook. The process exits
// after flushing its result, so no restoration is needed.
const CHILD_SCRIPT = `
const fs = require("node:fs/promises");

const storeUrl = process.env.STORE_URL;
const mode = process.env.MODE;
const finalPath = process.env.FINAL_PATH;
const failAt = process.env.FAIL_AT || "";
const fill = Number(process.env.FILL || "65");
const size = Number(process.env.SIZE || "4096");
const payload = Buffer.alloc(size, fill);

const sendMessage = (message) =>
  new Promise((resolve) => {
    if (typeof process.send !== "function") {
      resolve();
      return;
    }
    process.send(message, () => resolve());
  });

if (failAt === "collide") {
  const realOpen = fs.open.bind(fs);
  fs.open = async (target, flags, ...rest) => {
    if (flags === "wx") {
      const handle = await realOpen(target, "w", 0o600);
      await handle.writeFile(Buffer.from("collided"));
      await handle.close();
      await sendMessage({ event: "collision", path: target });
      const error = new Error("injected temp collision");
      error.code = "EEXIST";
      throw error;
    }
    return realOpen(target, flags, ...rest);
  };
}
if (failAt === "write" || failAt === "sync") {
  const realOpen = fs.open.bind(fs);
  fs.open = async (...args) => {
    const handle = await realOpen(...args);
    const realWriteFile = handle.writeFile.bind(handle);
    const realSync = handle.sync.bind(handle);
    handle.writeFile = async (...writeArgs) => {
      if (failAt === "write") throw new Error("injected write failure");
      return realWriteFile(...writeArgs);
    };
    handle.sync = async (...syncArgs) => {
      if (failAt === "sync") throw new Error("injected sync failure");
      return realSync(...syncArgs);
    };
    return handle;
  };
}
if (failAt === "link") {
  fs.link = async () => {
    throw new Error("injected link failure");
  };
}
if (failAt === "rename") {
  fs.rename = async () => {
    throw new Error("injected rename failure");
  };
}

(async () => {
  try {
    const store = await import(storeUrl);
    if (mode === "race") {
      await sendMessage({ event: "ready" });
      await new Promise((resolve) => process.once("message", resolve));
      await store.createFileExclusive(finalPath, payload);
    } else if (mode === "create") {
      await store.createFileExclusive(finalPath, payload);
    } else {
      await store.writeFileAtomic(finalPath, payload);
    }
    await sendMessage({ event: "result", ok: true });
  } catch (error) {
    await sendMessage({
      event: "result",
      ok: false,
      code: error && error.code ? error.code : null,
      message: String((error && error.message) || error),
    });
  } finally {
    if (typeof process.disconnect === "function") process.disconnect();
  }
})();
`;

async function createRoot() {
  return realpath(await mkdtemp(join(tmpdir(), "workspace-store-")));
}

function makeInbox(child, defaultTimeoutMs = 15000) {
  const messages = [];
  const waiters = [];

  function dispatch() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let index = 0; index < waiters.length; index += 1) {
        const waiter = waiters[index];
        const messageIndex = messages.findIndex(waiter.predicate);
        if (messageIndex === -1) continue;
        const [message] = messages.splice(messageIndex, 1);
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        progressed = true;
        break;
      }
    }
  }

  child.on("message", (message) => {
    messages.push(message);
    dispatch();
  });

  return {
    take(predicate, timeoutMs = defaultTimeoutMs) {
      return new Promise((resolvePromise, rejectPromise) => {
        const waiter = {
          predicate,
          resolve: resolvePromise,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            rejectPromise(new Error("timed out waiting for child message"));
          }, timeoutMs),
        };
        waiters.push(waiter);
        dispatch();
      });
    },
  };
}

function startStoreChild(env, cwd) {
  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    cwd,
    env: { ...process.env, STORE_URL, ...env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
  });
  child.stdout.resume();
  child.stderr.resume();
  let spawnError = null;
  const done = new Promise((resolvePromise) => {
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => resolvePromise({ code, signal, error: spawnError }));
  });
  return { child, inbox: makeInbox(child), done };
}

async function stopChild(entry) {
  if (!entry) return;
  if (entry.child.exitCode === null && entry.child.signalCode === null) {
    entry.child.kill("SIGKILL");
  }
  await entry.done;
}

async function waitForClose(entry, timeoutMs = 15000) {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (entry.child.exitCode === null && entry.child.signalCode === null) {
      entry.child.kill("SIGKILL");
    }
  }, timeoutMs);
  try {
    const result = await entry.done;
    return { ...result, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

test("file publication: creates exclusively with 0600 and preserves existing targets", async (t) => {
  const root = await createRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const created = join(root, "created.txt");
  await createFileExclusive(created, "hello");
  assert.equal(await readFile(created, "utf8"), "hello");
  assert.equal((await stat(created)).mode & 0o777, 0o600);

  const existing = join(root, "existing.txt");
  await writeFile(existing, "keep");
  await chmod(existing, 0o644);
  await assert.rejects(createFileExclusive(existing, "changed"), (error) => error.code === "EEXIST");
  assert.equal(await readFile(existing, "utf8"), "keep");
  assert.equal((await stat(existing)).mode & 0o777, 0o644);

  const replaced = join(root, "replaced.txt");
  await writeFile(replaced, "old");
  await chmod(replaced, 0o644);
  await writeFileAtomic(replaced, "new");
  assert.equal(await readFile(replaced, "utf8"), "new");
  assert.equal((await stat(replaced)).mode & 0o777, 0o600);

  const absent = join(root, "absent.txt");
  await writeFileAtomic(absent, "fresh");
  assert.equal(await readFile(absent, "utf8"), "fresh");

  await createFileExclusive(join(root, "from-buffer.txt"), Buffer.from("buf"));
  await createFileExclusive(join(root, "from-uint8.txt"), new Uint8Array([117, 56]));
  assert.equal(await readFile(join(root, "from-buffer.txt"), "utf8"), "buf");
  assert.equal(await readFile(join(root, "from-uint8.txt"), "utf8"), "u8");
  await assert.rejects(createFileExclusive(join(root, "bad.bin"), 5), TypeError);

  const missing = join(root, "missing-parent", "file.txt");
  await assert.rejects(createFileExclusive(missing, "x"), /does not exist/);
  await assert.rejects(lstat(join(root, "missing-parent")), { code: "ENOENT" });

  const beforeRefusals = (await readdir(root)).sort();
  await assert.rejects(createFileExclusive("", "x"), /must not be empty/);
  await assert.rejects(createFileExclusive(join(root, "bad\0name.txt"), "x"), /NUL/);
  await assert.rejects(writeFileAtomic("", "x"), /must not be empty/);
  await assert.rejects(writeFileAtomic(join(root, "bad\0name.txt"), "x"), /NUL/);
  assert.deepEqual((await readdir(root)).sort(), beforeRefusals);

  assert.deepEqual((await readdir(root)).sort(), [
    "absent.txt",
    "created.txt",
    "existing.txt",
    "from-buffer.txt",
    "from-uint8.txt",
    "replaced.txt",
  ]);
});

test("file publication: races two exclusive creators for one final path", async (t) => {
  const root = await createRoot();
  const finalPath = join(root, "race.bin");
  const payloadA = Buffer.alloc(256 * 1024, 65);
  const payloadB = Buffer.alloc(256 * 1024, 66);

  const first = startStoreChild(
    { MODE: "race", FINAL_PATH: finalPath, FILL: "65", SIZE: String(payloadA.length) },
    root,
  );
  const second = startStoreChild(
    { MODE: "race", FINAL_PATH: finalPath, FILL: "66", SIZE: String(payloadB.length) },
    root,
  );
  t.after(async () => {
    await stopChild(first);
    await stopChild(second);
    await rm(root, { recursive: true, force: true });
  });

  await first.inbox.take((message) => message.event === "ready");
  await second.inbox.take((message) => message.event === "ready");
  first.child.send("go");
  second.child.send("go");

  const resultA = await first.inbox.take((message) => message.event === "result");
  const resultB = await second.inbox.take((message) => message.event === "result");
  const closeA = await waitForClose(first);
  const closeB = await waitForClose(second);
  assert.equal(closeA.timedOut, false);
  assert.equal(closeB.timedOut, false);

  const winners = [
    { result: resultA, payload: payloadA },
    { result: resultB, payload: payloadB },
  ].filter((entry) => entry.result.ok);
  const losers = [resultA, resultB].filter((result) => !result.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, "EEXIST");
  assert.deepEqual(await readFile(finalPath), winners[0].payload);
  assert.deepEqual(await readdir(root), [basename(finalPath)]);
});

test("file publication: serialized replacements keep whole records visible to readers", async (t) => {
  const root = await createRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const finalPath = join(root, "record.bin");
  const oldPayload = Buffer.alloc(128 * 1024, 65);
  const newPayload = Buffer.alloc(128 * 1024, 66);
  await createFileExclusive(finalPath, oldPayload);

  let writing = true;
  const observed = [];
  const reader = (async () => {
    while (writing || observed.length === 0) {
      observed.push(await readFile(finalPath));
      if (!writing) break;
    }
  })();
  let writeError = null;
  try {
    for (let index = 0; index < 8; index += 1) {
      await writeFileAtomic(finalPath, index % 2 === 0 ? newPayload : oldPayload);
    }
  } catch (error) {
    writeError = error;
  } finally {
    writing = false;
  }
  await reader;
  if (writeError) throw writeError;

  assert.ok(observed.length > 0);
  for (const record of observed) {
    assert.ok(
      record.equals(oldPayload) || record.equals(newPayload),
      "reader observed a partial or missing record",
    );
  }
  assert.deepEqual(await readdir(root), [basename(finalPath)]);
});

const INJECTED_FAILURES = [
  { mode: "create", failAt: "write", expectation: "absent" },
  { mode: "create", failAt: "sync", expectation: "absent" },
  { mode: "create", failAt: "link", expectation: "absent" },
  { mode: "replace", failAt: "write", expectation: "old" },
  { mode: "replace", failAt: "sync", expectation: "old" },
  { mode: "replace", failAt: "rename", expectation: "old" },
];

for (const failure of INJECTED_FAILURES) {
  test(`file publication: injected ${failure.mode} ${failure.failAt} failure preserves targets and owned cleanup`, async (t) => {
    const root = await createRoot();
    const finalPath = join(root, `${failure.mode}-target.bin`);
    const sentinel = join(root, "unrelated-sentinel.tmp");
    await writeFile(sentinel, "sentinel");
    const oldPayload = Buffer.alloc(8 * 1024, 79);
    if (failure.mode === "replace") await writeFile(finalPath, oldPayload);

    const entry = startStoreChild(
      {
        MODE: failure.mode,
        FINAL_PATH: finalPath,
        FAIL_AT: failure.failAt,
        FILL: "78",
        SIZE: String(8 * 1024),
      },
      root,
    );
    t.after(async () => {
      await stopChild(entry);
      await rm(root, { recursive: true, force: true });
    });

    const result = await entry.inbox.take((message) => message.event === "result");
    const close = await waitForClose(entry);
    assert.equal(close.timedOut, false);
    assert.equal(result.ok, false);
    assert.match(result.message, /injected/);
    assert.equal(await readFile(sentinel, "utf8"), "sentinel");

    if (failure.expectation === "absent") {
      await assert.rejects(lstat(finalPath), { code: "ENOENT" });
      assert.deepEqual(await readdir(root), [basename(sentinel)]);
    } else {
      assert.deepEqual(await readFile(finalPath), oldPayload);
      assert.deepEqual(
        (await readdir(root)).sort(),
        [basename(finalPath), basename(sentinel)].sort(),
      );
    }
  });
}

test("file publication: injected temp-open collision keeps the collided file and publishes nothing", async (t) => {
  const root = await createRoot();
  const finalPath = join(root, "collision-target.bin");
  const entry = startStoreChild(
    { MODE: "create", FINAL_PATH: finalPath, FAIL_AT: "collide" },
    root,
  );
  t.after(async () => {
    await stopChild(entry);
    await rm(root, { recursive: true, force: true });
  });

  const collision = await entry.inbox.take((message) => message.event === "collision");
  const result = await entry.inbox.take((message) => message.event === "result");
  const close = await waitForClose(entry);
  assert.equal(close.timedOut, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, "EEXIST");
  assert.match(result.message, /injected temp collision/);
  assert.equal(collision.path.startsWith(`${root}${sep}`), true);
  assert.deepEqual(await readFile(collision.path, "utf8"), "collided");
  await assert.rejects(lstat(finalPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(root), [basename(collision.path)]);
});

test("file publication: refuses symlinked and wrong-type parents and targets", async (t) => {
  const root = await createRoot();
  const outside = await createRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));

  const real = join(root, "real.txt");
  await writeFile(real, "real");
  const link = join(root, "link.txt");
  await symlink(real, link);
  await assert.rejects(createFileExclusive(link, "new"), (error) => error.code === "EEXIST");
  assert.equal(await readFile(real, "utf8"), "real");
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  await assert.rejects(writeFileAtomic(link, "new"), /not a regular file/);
  assert.equal(await readFile(real, "utf8"), "real");

  const directoryTarget = join(root, "directory-target");
  await mkdir(directoryTarget);
  await assert.rejects(writeFileAtomic(directoryTarget, "new"), /not a regular file/);
  assert.equal((await lstat(directoryTarget)).isDirectory(), true);

  const linkDir = join(root, "link-dir");
  await symlink(outside, linkDir);
  await assert.rejects(
    createFileExclusive(join(linkDir, "file.txt"), "x"),
    /must not be a symlink|contains a symbolic link/,
  );
  await assert.rejects(
    writeFileAtomic(join(linkDir, "file.txt"), "x"),
    /must not be a symlink|contains a symbolic link/,
  );
  assert.deepEqual(await readdir(outside), []);

  const realSub = join(root, "real-sub");
  await mkdir(realSub);
  const ancestorLink = join(root, "ancestor-link");
  await symlink(realSub, ancestorLink);
  await assert.rejects(
    createFileExclusive(join(ancestorLink, "file.txt"), "x"),
    /must not be a symlink|contains a symbolic link/,
  );
  assert.deepEqual(await readdir(realSub), []);

  const plainParent = join(root, "plain-parent");
  await writeFile(plainParent, "file");
  await assert.rejects(createFileExclusive(join(plainParent, "file.txt"), "x"), /not a directory/);

  assert.deepEqual((await readdir(root)).sort(), [
    "ancestor-link",
    "directory-target",
    "link-dir",
    "link.txt",
    "plain-parent",
    "real-sub",
    "real.txt",
  ]);
});

test("file publication: resolves contained existing paths and refuses escapes", async (t) => {
  const root = await createRoot();
  const outside = await createRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));

  await mkdir(join(root, "a", "b"), { recursive: true });
  const file = join(root, "a", "b", "file.txt");
  await writeFile(file, "content");
  await writeFile(join(outside, "outside.txt"), "outside");

  assert.equal(await resolveWorkspacePath(root, "a/b/file.txt"), await realpath(file));
  assert.equal(await resolveWorkspacePath(root, "a/b"), await realpath(join(root, "a", "b")));

  const lexicalRefusals = [
    ["", /must not be empty/],
    ["/etc/passwd", /must not be absolute/],
    ["a/./b", /invalid segment/],
    ["a/../b", /invalid segment/],
    ["a//b", /invalid segment/],
    ["a/b/", /invalid segment/],
    ["..", /invalid segment/],
    ["a\\b", /backslashes/],
    ["a\0b", /NUL/],
    ["a/missing.txt", /does not exist/],
    ["a/b/file.txt/child", /not a directory/],
  ];
  for (const [relative, pattern] of lexicalRefusals) {
    await assert.rejects(resolveWorkspacePath(root, relative), pattern, relative);
  }
  await assert.rejects(resolveWorkspacePath(root, 5), TypeError);

  const symlinkComponent = join(root, "link-component");
  await symlink(join(root, "a"), symlinkComponent);
  await assert.rejects(
    resolveWorkspacePath(root, "link-component/b/file.txt"),
    /must not be a symlink/,
  );

  const escape = join(root, "escape");
  await symlink(outside, escape);
  await assert.rejects(resolveWorkspacePath(root, "escape/outside.txt"), /must not be a symlink/);

  const baseLink = join(root, "base-link");
  await symlink(root, baseLink);
  await assert.rejects(resolveWorkspacePath(baseLink, "a/b/file.txt"), /must not be a symlink/);

  const ancestorLink = join(root, "ancestor-link");
  await symlink(root, ancestorLink);
  await assert.rejects(
    resolveWorkspacePath(join(ancestorLink, "a"), "b/file.txt"),
    /contains a symbolic link/,
  );

  await assert.rejects(resolveWorkspacePath(join(root, "missing-base"), "a"), /does not exist/);
  await assert.rejects(resolveWorkspacePath(file, "a"), /not a directory/);
});
