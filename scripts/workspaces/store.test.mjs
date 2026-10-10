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
import { createFileExclusive, listWorkspaces, resolveStorageRoot, resolveWorkspacePath, storageStatus, writeFileAtomic } from "./store.mjs";

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

test("workspace catalog: resolves roots, reports status and lists identities without mutation", async (t) => {
  const home = await createRoot();
  const parent = await createRoot();
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(parent, { recursive: true, force: true }));

  // resolveStorageRoot: default, absolute override, relative refusal; none created.
  assert.equal(resolveStorageRoot({}, home), join(home, "Documents", "adjacent-storage"));
  const customRoot = join(parent, "custom-root");
  assert.equal(resolveStorageRoot({ ADJACENT_STORAGE_ROOT: customRoot }, home), customRoot);
  assert.throws(() => resolveStorageRoot({ ADJACENT_STORAGE_ROOT: "relative-store" }, home));
  await assert.rejects(lstat(join(home, "Documents")), { code: "ENOENT" });
  await assert.rejects(lstat(customRoot), { code: "ENOENT" });

  // storageStatus: missing root and missing projects stay absent.
  const missingRoot = join(parent, "missing-root");
  const missingStatus = await storageStatus(missingRoot);
  assert.equal(missingStatus.root, missingRoot);
  assert.equal(missingStatus.status, "missing_root");
  assert.ok(Array.isArray(missingStatus.errors));
  await assert.rejects(lstat(missingRoot), { code: "ENOENT" });

  const root = join(parent, "store");
  await mkdir(root);
  const beforeProjects = await storageStatus(root);
  assert.equal(beforeProjects.root, root);
  assert.equal(beforeProjects.status, "missing_projects");
  await assert.rejects(lstat(join(root, "projects")), { code: "ENOENT" });

  // listWorkspaces: missing root and missing projects report without creating.
  const missingList = await listWorkspaces(missingRoot);
  assert.deepEqual(missingList.valid, []);
  assert.ok(missingList.invalid.length + missingList.errors.length > 0);
  await assert.rejects(lstat(missingRoot), { code: "ENOENT" });

  const emptyList = await listWorkspaces(root);
  assert.deepEqual(emptyList.valid, []);
  assert.ok(emptyList.invalid.length + emptyList.errors.length > 0);
  await assert.rejects(lstat(join(root, "projects")), { code: "ENOENT" });

  // Catalog fixtures: valid, mismatch, duplicate, wrong-type, unreadable and hidden.
  const projects = join(root, "projects");
  await mkdir(projects);
  const writeKit = async (directory, id, name) => {
    await mkdir(join(projects, directory));
    await writeFile(
      join(projects, directory, "kit.yaml"),
      `version: 1\nid: ${id}\nname: ${name}\nrepositories: []\n`,
    );
  };
  await writeKit("alpha", "alpha", "Alpha");
  await writeKit("gamma-dir", "gamma", "Gamma");
  await writeKit("dup-a", "shared", "Shared A");
  await writeKit("dup-b", "shared", "Shared B");
  await writeKit(".hidden", "hidden", "Hidden");
  await mkdir(join(projects, "broken", "kit.yaml"), { recursive: true });
  const deniedKit = join(projects, "denied", "kit.yaml");
  await writeKit("denied", "denied", "Denied");
  await chmod(deniedKit, 0o000);
  const deniedUnreadable = await readFile(deniedKit, "utf8").then(
    () => false,
    () => true,
  );

  const okStatus = await storageStatus(root);
  assert.equal(okStatus.status, "ok");
  assert.deepEqual(okStatus.errors, []);

  // A fake git first on PATH records any execution while the catalog is read.
  const bin = join(parent, "bin");
  await mkdir(bin);
  const gitRan = join(parent, "git-ran");
  await writeFile(join(bin, "git"), `#!/bin/sh\nprintf ran > "${gitRan}"\nexit 7\n`);
  await chmod(join(bin, "git"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${sep}${originalPath ?? ""}`;
  let catalog;
  try {
    catalog = await listWorkspaces(root);
  } finally {
    process.env.PATH = originalPath;
  }

  // No git process ran and no boundary was created by the read.
  await assert.rejects(lstat(gitRan), { code: "ENOENT" });
  assert.ok(Array.isArray(catalog.errors));

  const expectedValidIds = ["alpha", "gamma", ...(deniedUnreadable ? [] : ["denied"])].sort();
  assert.deepEqual(catalog.valid.map((entry) => entry.id).sort(), expectedValidIds);
  const byId = new Map(catalog.valid.map((entry) => [entry.id, entry]));

  const alpha = byId.get("alpha");
  assert.equal(alpha.name, "Alpha");
  assert.equal(alpha.directory, join(projects, "alpha"));
  assert.equal(alpha.kit.version, 1);
  assert.equal(alpha.kit.id, "alpha");
  assert.deepEqual(alpha.kit.repositories, []);
  assert.deepEqual(alpha.attention, []);

  const gamma = byId.get("gamma");
  assert.ok(gamma, "directory mismatch stays valid");
  assert.equal(gamma.name, "Gamma");
  assert.equal(gamma.directory, join(projects, "gamma-dir"));
  assert.ok(Array.isArray(gamma.attention));
  assert.ok(gamma.attention.includes("directory_mismatch"));

  assert.equal(byId.has("shared"), false);
  assert.equal(byId.has("hidden"), false);

  const expectedInvalid = ["broken", "dup-a", "dup-b", ...(deniedUnreadable ? ["denied"] : [])]
    .map((directory) => join(projects, directory))
    .sort();
  assert.deepEqual(catalog.invalid.map((entry) => entry.directory).sort(), expectedInvalid);
  for (const entry of catalog.invalid) {
    assert.ok(Array.isArray(entry.errors) && entry.errors.length > 0, `missing errors for ${entry.directory}`);
  }
});
