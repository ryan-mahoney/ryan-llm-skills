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
import { addArtifact, addMaterial, createFileExclusive, createWorkspace, fetchWorkspace, listWorkspaces, resolveStorageRoot, resolveWorkspacePath, setupStorage, storageStatus, writeFileAtomic } from "./store.mjs";
import { parseKit } from "./kit.mjs";

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

test("workspace target status: reports retained repositories, context and artifacts without mutation", async (t) => {
  const root = await createRoot();
  const outside = await createRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));

  // Bound every fixture Git invocation; the test owns and kills its children.
  const runGit = (cwd, args, timeoutMs = 15000) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise(stdout);
        else rejectPromise(new Error(`git ${args.join(" ")} failed with ${code}: ${stderr.trim()}`));
      });
    });

  // Repositories: canonical work tree, its subdirectory, a plain file, a bare
  // repository, a missing path and a remote mismatch.
  const repoOk = join(root, "repos", "repo-ok");
  await mkdir(repoOk, { recursive: true });
  await runGit(repoOk, ["init", "--quiet"]);
  const repoSub = join(repoOk, "sub");
  await mkdir(repoSub);
  const repoFile = join(root, "repos", "plain.txt");
  await writeFile(repoFile, "not a repository");
  const repoBare = join(root, "repos", "repo-bare");
  await mkdir(repoBare, { recursive: true });
  await runGit(repoBare, ["init", "--bare", "--quiet"]);
  const repoMissing = join(root, "repos", "repo-missing");
  const repoRemote = join(root, "repos", "repo-remote");
  await mkdir(repoRemote, { recursive: true });
  await runGit(repoRemote, ["init", "--quiet"]);
  await runGit(repoRemote, ["config", "remote.origin.url", "https://example.com/actual.git"]);

  // Workspace: one kit with every repository and context case.
  const workspace = join(root, "projects", "ws1");
  const contextDir = join(workspace, "context");
  await mkdir(contextDir, { recursive: true });
  const unreadableContext = join(contextDir, "unreadable.md");
  await writeFile(unreadableContext, "restricted");
  await chmod(unreadableContext, 0o000);
  const unreadableDetected = await readFile(unreadableContext, "utf8").then(
    () => false,
    () => true,
  );
  const outsideFile = join(outside, "outside.md");
  await writeFile(outsideFile, "outside");
  await writeFile(
    join(workspace, "kit.yaml"),
    [
      "version: 1",
      "id: ws1",
      "name: Workspace One",
      "repositories:",
      "  - id: repo-ok",
      `    path: ${repoOk}`,
      "  - id: repo-sub",
      `    path: ${repoSub}`,
      "  - id: repo-file",
      `    path: ${repoFile}`,
      "  - id: repo-bare",
      `    path: ${repoBare}`,
      "  - id: repo-missing",
      `    path: ${repoMissing}`,
      "  - id: repo-remote",
      `    path: ${repoRemote}`,
      "    remote: https://example.com/kit.git",
      "context:",
      "  - missing.md",
      `  - ${outsideFile}`,
      "  - context/unreadable.md",
      "",
    ].join("\n"),
  );

  // Artifact records: unknown repository, escaping target, malformed JSON,
  // unknown schema and an external URL that is never fetched.
  const artifactsDir = join(workspace, "artifacts");
  await mkdir(artifactsDir);
  const writeRecord = (name, payload) =>
    writeFile(join(artifactsDir, name), typeof payload === "string" ? payload : JSON.stringify(payload));
  const repositoryArtifact = (artifactId, target) => ({
    schema_version: 1,
    artifact_id: artifactId,
    kind: "repository",
    target,
    title: artifactId,
    note: "",
    added_at: "2026-10-10T00:00:00Z",
  });
  await writeRecord(
    "artifact-unknown-repo.json",
    repositoryArtifact("artifact-unknown-repo", { repository_id: "ghost", path: "src/app.js" }),
  );
  await writeRecord(
    "artifact-escape.json",
    repositoryArtifact("artifact-escape", { repository_id: "repo-ok", path: "../escape" }),
  );
  await writeRecord("artifact-malformed.json", "{ this is not JSON");
  await writeRecord("artifact-unknown-schema.json", {
    schema_version: 99,
    artifact_id: "artifact-future",
    kind: "url",
    target: "https://example.invalid/future",
    title: "future",
    note: "",
    added_at: "2026-10-10T00:00:00Z",
  });
  await writeRecord("artifact-url.json", {
    schema_version: 1,
    artifact_id: "artifact-url",
    kind: "url",
    target: "https://example.invalid/resource",
    title: "remote",
    note: "",
    added_at: "2026-10-10T00:00:00Z",
  });

  // Read-only proof: the whole storage root is size/mtime-identical after the read.
  const snapshot = async () => {
    const entries = [];
    const walk = async (directory, prefix) => {
      const listing = await readdir(directory, { withFileTypes: true });
      for (const item of listing.sort((left, right) => left.name.localeCompare(right.name))) {
        const path = join(directory, item.name);
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        const info = await lstat(path);
        entries.push(`${relative}:${info.isDirectory() ? "d" : "f"}:${info.size}:${info.mtimeMs}`);
        if (item.isDirectory()) await walk(path, relative);
      }
    };
    await walk(root, "");
    return entries;
  };
  const before = await snapshot();
  const result = await fetchWorkspace(root, "ws1");
  assert.deepEqual(await snapshot(), before);

  assert.equal(result.id, "ws1");
  assert.equal(result.name, "Workspace One");
  assert.equal(result.directory, workspace);
  assert.equal(result.has_workspace_specs, false);

  const repositories = new Map(result.repositories.map((entry) => [entry.id, entry]));
  assert.equal(repositories.size, 6);
  assert.equal(repositories.get("repo-ok").status, "ok");
  assert.equal(repositories.get("repo-sub").status, "not_git");
  assert.equal(repositories.get("repo-file").status, "not_git");
  assert.equal(repositories.get("repo-bare").status, "not_git");
  assert.equal(repositories.get("repo-remote").status, "ok");
  assert.equal(repositories.get("repo-missing").status, "missing");
  assert.equal(repositories.get("repo-missing").path, repoMissing);
  assert.match(
    JSON.stringify([...(result.attention ?? []), ...(repositories.get("repo-remote").attention ?? [])]),
    /mismatch/,
  );

  const context = new Map(result.context.map((entry) => [entry.path, entry]));
  assert.equal(context.size, 3);
  assert.equal(context.get("missing.md").status, "missing");
  assert.equal(context.get(outsideFile).status, "outside_root");
  assert.equal(context.get("context/unreadable.md").status, unreadableDetected ? "unreadable" : "ok");

  const artifacts = new Map(result.artifacts.map((entry) => [entry.path, entry]));
  assert.equal(artifacts.size, 5);
  assert.equal(artifacts.get(join(artifactsDir, "artifact-unknown-repo.json")).status, "repository_unavailable");
  assert.equal(artifacts.get(join(artifactsDir, "artifact-escape.json")).status, "outside_root");
  assert.match(artifacts.get(join(artifactsDir, "artifact-malformed.json")).status, /unreadable|malformed/);
  assert.equal(artifacts.get(join(artifactsDir, "artifact-unknown-schema.json")).status, "unreadable");
  assert.equal(artifacts.get(join(artifactsDir, "artifact-url.json")).status, "external");
});

test("workspace target status: refuses unsafe references and retains unavailable associations", async (t) => {
  const root = await createRoot();
  const outside = await createRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));

  const runGit = (cwd, args, timeoutMs = 15000) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise(null);
        else rejectPromise(new Error(`git ${args.join(" ")} failed with ${code}: ${stderr.trim()}`));
      });
    });

  // One usable repository with readable, locked and symlinked content, one
  // missing path and one plain file; the outside root owns the leak targets.
  const repoOk = join(root, "repos", "repo-ok");
  await mkdir(join(repoOk, "docs"), { recursive: true });
  await runGit(repoOk, ["init", "--quiet"]);
  await writeFile(join(repoOk, "docs", "keep.md"), "kept");
  await writeFile(join(repoOk, "docs", "locked.md"), "restricted");
  await chmod(join(repoOk, "docs", "locked.md"), 0o000);
  const lockedDetected = await readFile(join(repoOk, "docs", "locked.md"), "utf8").then(
    () => false,
    () => true,
  );
  const repoMissing = join(root, "repos", "repo-missing");
  const repoFile = join(root, "repos", "plain.txt");
  await writeFile(repoFile, "not a repository");
  const outsideSecret = join(outside, "secret.md");
  await writeFile(outsideSecret, "external bytes");
  await symlink(outside, join(repoOk, "link"));
  await symlink(join(repoOk, "docs", "keep.md"), join(repoOk, "selflink"));

  const workspace = join(root, "projects", "ws2");
  await mkdir(join(workspace, "context"), { recursive: true });
  await symlink(outside, join(workspace, "context-link"));
  await writeFile(
    join(workspace, "kit.yaml"),
    [
      "version: 1",
      "id: ws2",
      "name: Workspace Two",
      "repositories:",
      "  - id: repo-ok",
      `    path: ${repoOk}`,
      "  - id: repo-missing",
      `    path: ${repoMissing}`,
      "  - id: repo-file",
      `    path: ${repoFile}`,
      "context:",
      "  - docs/../escape.md",
      "  - ./docs/keep.md",
      "  - context-link/secret.md",
      "  - docs/keep-missing.md",
      "",
    ].join("\n"),
  );

  // Record fixtures: a symlinked record pointing at a valid outside record,
  // lexical violations, symlink-ancestor and unavailable-repository targets,
  // an unreadable target and positive controls.
  const artifactsDir = join(workspace, "artifacts");
  await mkdir(artifactsDir);
  const repositoryArtifact = (artifactId, target) => ({
    schema_version: 1,
    artifact_id: artifactId,
    kind: "repository",
    target,
    title: artifactId,
    note: "",
    added_at: "2026-10-10T00:00:00Z",
  });
  const writeRecord = (name, payload) =>
    writeFile(join(artifactsDir, name), typeof payload === "string" ? payload : JSON.stringify(payload));
  await writeFile(
    outsideSecret.replace(/secret\.md$/, "outside-record.json"),
    JSON.stringify({
      schema_version: 1,
      artifact_id: "leaked",
      kind: "url",
      target: "https://example.invalid/leaked",
      title: "leaked",
      note: "",
      added_at: "2026-10-10T00:00:00Z",
    }),
  );
  await symlink(
    outsideSecret.replace(/secret\.md$/, "outside-record.json"),
    join(artifactsDir, "artifact-symlink.json"),
  );
  await writeRecord("artifact-dotdot.json", repositoryArtifact("artifact-dotdot", { repository_id: "repo-ok", path: "docs/../keep.md" }));
  await writeRecord("artifact-dot.json", repositoryArtifact("artifact-dot", { repository_id: "repo-ok", path: "./docs/keep.md" }));
  await writeRecord("artifact-empty.json", repositoryArtifact("artifact-empty", { repository_id: "repo-ok", path: "" }));
  await writeRecord(
    "artifact-absolute.json",
    repositoryArtifact("artifact-absolute", { repository_id: "repo-ok", path: join(repoOk, "docs", "keep.md") }),
  );
  await writeRecord("artifact-link.json", repositoryArtifact("artifact-link", { repository_id: "repo-ok", path: "link/new.md" }));
  await writeRecord("artifact-selflink.json", repositoryArtifact("artifact-selflink", { repository_id: "repo-ok", path: "selflink" }));
  await writeRecord("artifact-repo-missing.json", repositoryArtifact("artifact-repo-missing", { repository_id: "repo-missing", path: "x.md" }));
  await writeRecord("artifact-repo-file.json", repositoryArtifact("artifact-repo-file", { repository_id: "repo-file", path: "x.md" }));
  await writeRecord("artifact-locked.json", repositoryArtifact("artifact-locked", { repository_id: "repo-ok", path: "docs/locked.md" }));
  await writeRecord("artifact-ok.json", repositoryArtifact("artifact-ok", { repository_id: "repo-ok", path: "docs/keep.md" }));
  await writeRecord("artifact-gone.json", repositoryArtifact("artifact-gone", { repository_id: "repo-ok", path: "docs/gone.md" }));

  const result = await fetchWorkspace(root, "ws2");
  const context = new Map(result.context.map((entry) => [entry.path, entry]));
  assert.equal(context.get("docs/../escape.md").status, "outside_root");
  assert.equal(context.get("./docs/keep.md").status, "outside_root");
  assert.equal(context.get("context-link/secret.md").status, "outside_root");
  assert.equal(context.get("docs/keep-missing.md").status, "missing");

  const artifacts = new Map(result.artifacts.map((entry) => [entry.path, entry]));
  assert.equal(artifacts.size, 12);
  const linked = artifacts.get(join(artifactsDir, "artifact-symlink.json"));
  assert.equal(linked.status, "unreadable");
  assert.ok(!("artifact_id" in linked), "symlinked record bytes must not surface");
  assert.equal(artifacts.get(join(artifactsDir, "artifact-dotdot.json")).status, "outside_root");
  assert.equal(artifacts.get(join(artifactsDir, "artifact-dot.json")).status, "outside_root");
  assert.equal(artifacts.get(join(artifactsDir, "artifact-empty.json")).status, "outside_root");
  assert.equal(artifacts.get(join(artifactsDir, "artifact-absolute.json")).status, "outside_root");
  assert.equal(artifacts.get(join(artifactsDir, "artifact-link.json")).status, "outside_root");
  assert.equal(artifacts.get(join(artifactsDir, "artifact-link.json")).artifact_id, "artifact-link");
  assert.equal(artifacts.get(join(artifactsDir, "artifact-selflink.json")).status, "outside_root");
  for (const name of ["artifact-dotdot.json", "artifact-absolute.json", "artifact-selflink.json"]) {
    assert.equal(artifacts.get(join(artifactsDir, name)).artifact_id, name.replace(/\.json$/, ""));
  }
  const unavailableMissing = artifacts.get(join(artifactsDir, "artifact-repo-missing.json"));
  assert.equal(unavailableMissing.status, "repository_unavailable");
  assert.equal(unavailableMissing.artifact_id, "artifact-repo-missing");
  const unavailableFile = artifacts.get(join(artifactsDir, "artifact-repo-file.json"));
  assert.equal(unavailableFile.status, "repository_unavailable");
  assert.equal(unavailableFile.artifact_id, "artifact-repo-file");
  const locked = artifacts.get(join(artifactsDir, "artifact-locked.json"));
  assert.equal(locked.status, lockedDetected ? "unreadable" : "ok");
  assert.equal(locked.artifact_id, "artifact-locked");
  assert.deepEqual(locked.target, { repository_id: "repo-ok", path: "docs/locked.md" });
  assert.equal(artifacts.get(join(artifactsDir, "artifact-ok.json")).status, "ok");
  const gone = artifacts.get(join(artifactsDir, "artifact-gone.json"));
  assert.equal(gone.status, "missing");
  assert.equal(gone.artifact_id, "artifact-gone");
});

test("workspace target status: reports git timeouts as unreadable attention", async (t) => {
  const root = await createRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  // A fake git that never answers: the bounded identity call must surface a
  // timeout as unreadable attention, never as a not_git identity result.
  const fakeBin = join(root, "fakebin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fakeBin, "git"), "#!/bin/sh\n sleep 30\n");
  await chmod(join(fakeBin, "git"), 0o755);
  const repoDir = join(root, "repos", "repo-slow");
  await mkdir(repoDir, { recursive: true });
  const workspace = join(root, "projects", "ws-slow");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, "kit.yaml"),
    [
      "version: 1",
      "id: ws-slow",
      "name: Slow",
      "repositories:",
      "  - id: repo-slow",
      `    path: ${repoDir}`,
      "",
    ].join("\n"),
  );

  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
  try {
    const result = await fetchWorkspace(root, "ws-slow");
    assert.equal(result.repositories.length, 1);
    assert.equal(result.repositories[0].status, "unreadable");
    assert.ok(result.repositories[0].attention.includes("unreadable"));
  } finally {
    process.env.PATH = previousPath;
  }
});

test("workspace create: sets up storage and creates exclusive empty workspace kits", async (t) => {
  const tmp = await createRoot();
  t.after(() => rm(tmp, { recursive: true, force: true }));

  // setupStorage creates only the missing root and projects and stays idempotent.
  const fresh = join(tmp, "fresh-store");
  await setupStorage(fresh);
  assert.equal((await lstat(fresh)).isDirectory(), true);
  assert.equal((await lstat(join(fresh, "projects"))).isDirectory(), true);
  await assert.rejects(lstat(join(fresh, ".adjacent")), { code: "ENOENT" });
  await setupStorage(fresh);
  assert.equal((await lstat(fresh)).isDirectory(), true);
  assert.equal((await lstat(join(fresh, "projects"))).isDirectory(), true);
  await assert.rejects(lstat(join(fresh, ".adjacent")), { code: "ENOENT" });

  // Missing intermediate parents and wrong types are refused without creation.
  const deep = join(tmp, "a", "b", "store");
  await assert.rejects(setupStorage(deep));
  await assert.rejects(lstat(join(tmp, "a")), { code: "ENOENT" });

  const fileRoot = join(tmp, "file-root");
  await writeFile(fileRoot, "keep");
  await assert.rejects(setupStorage(fileRoot), /exists|not a directory/);
  assert.equal(await readFile(fileRoot, "utf8"), "keep");

  const realRoot = join(tmp, "real-root");
  await mkdir(realRoot);
  const linkedRoot = join(tmp, "linked-root");
  await symlink(realRoot, linkedRoot);
  await assert.rejects(setupStorage(linkedRoot), /symlink|exists/);

  // A missing root beneath a symlink refuses before writing outside.
  const outside = join(tmp, "outside-target");
  await mkdir(outside);
  const linkBase = join(tmp, "link-base");
  await mkdir(linkBase);
  await symlink(outside, join(linkBase, "link"));
  const missingUnderLink = join(linkBase, "link", "new-store");
  await assert.rejects(setupStorage(missingUnderLink), /symlink/);
  await assert.rejects(lstat(missingUnderLink), { code: "ENOENT" });
  assert.deepEqual(await readdir(outside), []);

  const projectsFileRoot = join(tmp, "projects-file-root");
  await mkdir(projectsFileRoot);
  await writeFile(join(projectsFileRoot, "projects"), "keep");
  await assert.rejects(setupStorage(projectsFileRoot), /exists|not a directory/);
  assert.equal(await readFile(join(projectsFileRoot, "projects"), "utf8"), "keep");

  // createWorkspace requires projects and refuses invalid ids without creation.
  const noProjects = join(tmp, "no-projects");
  await mkdir(noProjects);
  await assert.rejects(createWorkspace(noProjects, { id: "one" }));
  await assert.rejects(lstat(join(noProjects, "projects")), { code: "ENOENT" });
  assert.deepEqual(await readdir(noProjects), []);

  await assert.rejects(createWorkspace(fresh, { id: "Bad_ID!" }), /invalid/);
  await assert.rejects(lstat(join(fresh, "projects", "Bad_ID!")), { code: "ENOENT" });

  // Valid creates default the name to the id and honor an explicit name.
  await createWorkspace(fresh, { id: "alpha" });
  const alpha = parseKit(await readFile(join(fresh, "projects", "alpha", "kit.yaml"), "utf8"));
  assert.equal(alpha.ok, true);
  assert.equal(alpha.kit.version, 1);
  assert.equal(alpha.kit.id, "alpha");
  assert.equal(alpha.kit.name, "alpha");
  assert.deepEqual(alpha.kit.repositories, []);

  await createWorkspace(fresh, { id: "beta", name: "Beta Workspace" });
  const betaPath = join(fresh, "projects", "beta", "kit.yaml");
  const betaBytes = await readFile(betaPath);
  const beta = parseKit(betaBytes.toString("utf8"));
  assert.equal(beta.ok, true);
  assert.equal(beta.kit.version, 1);
  assert.equal(beta.kit.id, "beta");
  assert.equal(beta.kit.name, "Beta Workspace");
  assert.deepEqual(beta.kit.repositories, []);

  await assert.rejects(
    createWorkspace(fresh, { id: "beta", name: "Other" }),
    (error) => error.code === "EEXIST",
  );
  assert.deepEqual(await readFile(betaPath), betaBytes);
  assert.equal((await lstat(join(fresh, "projects", "beta"))).isDirectory(), true);

  // A failure after the exclusive directory mkdir keeps the owned directory visible.
  await assert.rejects(createWorkspace(fresh, { id: "partial", name: 42 }));
  assert.equal((await lstat(join(fresh, "projects", "partial"))).isDirectory(), true);
  await assert.rejects(lstat(join(fresh, "projects", "partial", "kit.yaml")), { code: "ENOENT" });

  // Numeric/keyword ids stay strings and comment-like/escaped names survive.
  await createWorkspace(fresh, { id: "1", name: "Alpha # beta" });
  const numericRaw = await readFile(join(fresh, "projects", "1", "kit.yaml"), "utf8");
  assert.ok(numericRaw.includes('id: "1"'));
  assert.ok(numericRaw.includes('name: "Alpha # beta"'));
  const numeric = parseKit(numericRaw);
  assert.equal(numeric.ok, true);
  assert.equal(numeric.kit.id, "1");
  assert.equal(numeric.kit.name, "Alpha # beta");

  await createWorkspace(fresh, { id: "true", name: 'a"b\\c' });
  const keywordRaw = await readFile(join(fresh, "projects", "true", "kit.yaml"), "utf8");
  assert.ok(keywordRaw.includes('id: "true"'));
  const keyword = parseKit(keywordRaw);
  assert.equal(keyword.ok, true);
  assert.equal(keyword.kit.id, "true");
  assert.equal(keyword.kit.name, 'a"b\\c');

  // Control-bearing names refuse but keep the incomplete directory visible.
  await assert.rejects(createWorkspace(fresh, { id: "control-refusal", name: "a\nb" }));
  assert.equal((await lstat(join(fresh, "projects", "control-refusal"))).isDirectory(), true);
  await assert.rejects(lstat(join(fresh, "projects", "control-refusal", "kit.yaml")), { code: "ENOENT" });

  // The generated empty kit is accepted by the installed Adjacent loader.
  const oraclePath = process.env.ADJ3_KIT_ORACLE
    ?? "/Users/ryanmahoney/.agents/.specs/adj3-workspace-storage/evidence/kit-oracle.mjs";
  const adjacentPath = process.env.ADJ3_ADJACENT ?? "/Users/ryanmahoney/Documents/adjacent";
  const fixtures = join(tmp, "oracle-fixtures");
  const oracleOut = join(tmp, "oracle-result.json");
  await mkdir(fixtures);
  await createWorkspace(fresh, { id: "oracle-kit", name: "Oracle Kit" });
  await writeFile(
    join(fixtures, "generated.yaml"),
    await readFile(join(fresh, "projects", "oracle-kit", "kit.yaml")),
  );
  await writeFile(
    join(fixtures, "tricky.yaml"),
    await readFile(join(fresh, "projects", "1", "kit.yaml")),
  );
  await writeFile(
    join(fixtures, "fixtures.json"),
    JSON.stringify({ version: 1, fixtures: [{ file: "generated.yaml", kind: "accepted" }, { file: "tricky.yaml", kind: "accepted" }] }),
  );

  const runOracle = (command, args, timeoutMs) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let forceTimer = null;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        rejectPromise(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        resolvePromise({ code, signal, timedOut, stdout, stderr });
      });
    });

  const oracle = await runOracle(
    process.execPath,
    [
      oraclePath,
      "--adjacent",
      adjacentPath,
      "--fixtures",
      fixtures,
      "--out",
      oracleOut,
      "--timeout-ms",
      "30000",
    ],
    45000,
  );
  assert.equal(oracle.timedOut, false, `kit oracle timed out: ${oracle.stderr}`);
  assert.equal(oracle.code, 0, `kit oracle failed: ${oracle.stderr || oracle.stdout}`);
  const observed = JSON.parse(await readFile(oracleOut, "utf8"));
  assert.equal(observed.ok, true);
  assert.equal(observed.observations.length, 2);
  assert.equal(observed.observations[0].status, "ok");
  assert.equal(observed.observations[0].kit.id, "oracle-kit");
  assert.equal(observed.observations[0].kit.name, "Oracle Kit");
  assert.deepEqual(observed.observations[0].kit.repositories, []);
  assert.equal(observed.observations[1].status, "ok");
  assert.equal(observed.observations[1].kit.id, "1");
  assert.equal(observed.observations[1].kit.name, "Alpha # beta");
  assert.deepEqual(observed.observations[1].kit.repositories, []);
});

test("workspace material: adds briefs, notes and artifact records exclusively", async (t) => {
  const root = await createRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const runBounded = (command, args, cwd, timeoutMs) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolvePromise({ code, signal, timedOut, stdout, stderr });
      });
    });

  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  const initialized = await runBounded("git", ["init", "--quiet"], repo, 15000);
  assert.equal(initialized.timedOut, false, initialized.stderr);
  assert.equal(initialized.code, 0, initialized.stderr);

  await setupStorage(root);
  await createWorkspace(root, { id: "writer" });
  const workspace = join(root, "projects", "writer");
  const kitPath = join(workspace, "kit.yaml");
  await writeFile(
    kitPath,
    [
      "version: 1",
      "id: writer",
      "name: Writer",
      "repositories:",
      "  - id: docs",
      `    path: ${repo}`,
      "",
    ].join("\n"),
  );
  const kitBefore = await readFile(kitPath);

  const first = await addMaterial(root, "writer", {
    kind: "brief",
    title: "First Brief",
    content: "first content\n",
  });
  assert.match(first.path, /^briefs\/\d{4}-\d{2}-\d{2}-first-brief\.md$/);
  const briefsDir = join(workspace, "briefs");
  assert.equal(dirname(join(workspace, first.path)), briefsDir);
  assert.equal(await readFile(join(workspace, first.path), "utf8"), "first content\n");

  const second = await addMaterial(root, "writer", {
    kind: "brief",
    title: "First Brief",
    content: "second content\n",
  });
  assert.equal(second.path, `${first.path.slice(0, -3)}-2.md`);
  assert.equal(await readFile(join(workspace, first.path), "utf8"), "first content\n");
  assert.equal(await readFile(join(workspace, second.path), "utf8"), "second content\n");

  // Control and path injection in a title cannot escape the briefs directory.
  const workspaceBefore = (await readdir(workspace)).sort();
  const injected = await addMaterial(root, "writer", {
    kind: "brief",
    title: "../evil\x00../x",
    content: "injected\n",
  });
  assert.equal(dirname(join(workspace, injected.path)), briefsDir);
  assert.equal(injected.path.split("/").includes(".."), false);
  const slashInjected = await addMaterial(root, "writer", {
    kind: "brief",
    title: "a/b\\c:d",
    content: "slash injected\n",
  });
  assert.equal(dirname(join(workspace, slashInjected.path)), briefsDir);
  assert.equal(slashInjected.path.split("/").includes(".."), false);
  assert.deepEqual((await readdir(workspace)).sort(), workspaceBefore);
  await assert.rejects(lstat(join(briefsDir, "a")), { code: "ENOENT" });
  await assert.rejects(lstat(join(workspace, "a")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, "evil")), { code: "ENOENT" });

  const note = await addMaterial(root, "writer", {
    kind: "note",
    title: "Meeting Notes",
    content: "note content\n",
  });
  assert.match(note.path, /^notes\/\d{4}-\d{2}-\d{2}-meeting-notes\.md$/);
  assert.equal(dirname(join(workspace, note.path)), join(workspace, "notes"));
  assert.equal(await readFile(join(workspace, note.path), "utf8"), "note content\n");

  const briefsBefore = (await readdir(briefsDir)).sort();
  await assert.rejects(addMaterial(root, "writer", { kind: "memo", title: "X", content: "x" }), /invalid/);
  await assert.rejects(addMaterial(root, "writer", { kind: "brief", title: "", content: "x" }), /invalid/);
  await assert.rejects(addMaterial(root, "writer", { kind: "brief", title: "X", content: 42 }));
  assert.deepEqual((await readdir(briefsDir)).sort(), briefsBefore);

  const firstFile = join(workspace, first.path);
  const readScript = `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(firstFile)}, "utf8"))`;
  const fresh = await runBounded(process.execPath, ["-e", readScript], root, 15000);
  assert.equal(fresh.timedOut, false);
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.equal(fresh.stdout, "first content\n");

  const repositoryArtifact = await addArtifact(root, "writer", {
    kind: "repository",
    target: { repository_id: "docs", path: "missing-doc.md" },
    title: "Missing doc",
    note: "visible later",
  });
  assert.match(repositoryArtifact.path, /^artifacts\/[0-9a-f-]{36}\.json$/);
  const artifactsDir = join(workspace, "artifacts");
  assert.equal(dirname(join(workspace, repositoryArtifact.path)), artifactsDir);
  const storedRepository = JSON.parse(await readFile(join(workspace, repositoryArtifact.path), "utf8"));
  assert.deepEqual(storedRepository, repositoryArtifact.record);
  assert.equal(storedRepository.schema_version, 1);
  assert.equal(typeof storedRepository.artifact_id, "string");
  assert.equal(basename(repositoryArtifact.path), `${storedRepository.artifact_id}.json`);
  assert.match(storedRepository.added_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
  assert.deepEqual(storedRepository.target, { repository_id: "docs", path: "missing-doc.md" });
  await assert.rejects(lstat(join(repo, "missing-doc.md")), { code: "ENOENT" });

  const urlArtifact = await addArtifact(root, "writer", {
    kind: "url",
    target: "https://example.invalid/resource",
    title: "External",
    note: "",
  });
  const storedUrl = JSON.parse(await readFile(join(workspace, urlArtifact.path), "utf8"));
  assert.deepEqual(storedUrl, urlArtifact.record);
  assert.equal(storedUrl.kind, "url");
  assert.equal(storedUrl.target, "https://example.invalid/resource");

  const artifactsBefore = (await readdir(artifactsDir)).sort();
  await assert.rejects(
    addArtifact(root, "writer", { kind: "repository", target: { repository_id: "ghost", path: "doc.md" } }),
    /unknown/,
  );
  for (const unsafe of ["../escape", "/etc/passwd", "a\\b.md"]) {
    await assert.rejects(
      addArtifact(root, "writer", { kind: "repository", target: { repository_id: "docs", path: unsafe } }),
    );
  }
  await assert.rejects(
    addArtifact(root, "writer", { kind: "url", target: "ftp://example.invalid/resource" }),
    /scheme|invalid/,
  );
  await assert.rejects(
    addArtifact(root, "writer", { kind: "url", target: "javascript:alert(1)" }),
    /scheme|invalid/,
  );
  assert.deepEqual((await readdir(artifactsDir)).sort(), artifactsBefore);

  assert.deepEqual(await readFile(kitPath), kitBefore);
});

test("workspace material: refuses symlink-ancestor artifact targets without publishing", async (t) => {
  const root = await createRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.md"), "outside\n");
  await symlink(outside, join(repo, "link"));
  const initialized = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["init", "--quiet"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code, stderr }));
  });
  assert.equal(initialized.code, 0, initialized.stderr);

  await setupStorage(root);
  await createWorkspace(root, { id: "links" });
  const workspace = join(root, "projects", "links");
  await writeFile(
    join(workspace, "kit.yaml"),
    ["version: 1", "id: links", "name: Links", "repositories:", "  - id: docs", `    path: ${repo}`, ""].join("\n"),
  );
  const artifactsDir = join(workspace, "artifacts");

  // The leaf is missing, but the existing `link` ancestor is a symlink that
  // escapes the repository: admission must refuse before publishing.
  await assert.rejects(
    addArtifact(root, "links", {
      kind: "repository",
      target: { repository_id: "docs", path: "link/new.md" },
    }),
    /unsafe/,
  );
  await assert.rejects(lstat(join(repo, "link", "new.md")), { code: "ENOENT" });
  let names = [];
  try {
    names = (await readdir(artifactsDir)).sort();
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  assert.deepEqual(names, []);

  // A safe missing target through real ancestors is still retained.
  const retained = await addArtifact(root, "links", {
    kind: "repository",
    target: { repository_id: "docs", path: "missing-doc.md" },
  });
  assert.match(retained.path, /^artifacts\/[0-9a-f-]{36}\.json$/);
  assert.deepEqual((await readdir(artifactsDir)).sort(), [basename(retained.path)]);
});

test("workspace material: stores canonical http urls that remain readable", async (t) => {
  const root = await createRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await setupStorage(root);
  await createWorkspace(root, { id: "urls" });
  const workspace = join(root, "projects", "urls");
  await writeFile(
    join(workspace, "kit.yaml"),
    ["version: 1", "id: urls", "name: Urls", "repositories:", "  - id: docs", `    path: ${repo}`, ""].join("\n"),
  );

  // Both spellings parse as https but only the canonical form satisfies the
  // `https?://` record reader; no network access occurs.
  const collapsed = await addArtifact(root, "urls", {
    kind: "url",
    target: "https:example.invalid/resource",
    title: "Collapsed",
    note: "slashes",
  });
  assert.equal(collapsed.record.target, "https://example.invalid/resource");
  const padded = await addArtifact(root, "urls", {
    kind: "url",
    target: " https://example.invalid/resource",
    title: "Padded",
  });
  assert.equal(padded.record.target, "https://example.invalid/resource");

  for (const created of [collapsed, padded]) {
    const stored = JSON.parse(await readFile(join(workspace, created.path), "utf8"));
    assert.match(stored.target, /^https?:\/\//);
  }
  const fetched = await fetchWorkspace(root, "urls");
  for (const created of [collapsed, padded]) {
    const visible = fetched.artifacts.find((entry) => entry.artifact_id === created.record.artifact_id);
    assert.ok(visible, `missing artifact ${created.record.artifact_id}`);
    assert.equal(visible.status, "external");
    assert.equal(visible.target, "https://example.invalid/resource");
    assert.equal(visible.title, created.record.title);
  }
});

test("workspace material: concurrent first additions allocate distinct names", async (t) => {
  const root = await createRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await setupStorage(root);
  await createWorkspace(root, { id: "race" });
  const workspace = join(root, "projects", "race");
  // Neither briefs directory exists: both additions race its first creation.
  await assert.rejects(lstat(join(workspace, "briefs")), { code: "ENOENT" });

  const results = await Promise.all([
    addMaterial(root, "race", { kind: "brief", title: "Concurrent Brief", content: "first payload\n" }),
    addMaterial(root, "race", { kind: "brief", title: "Concurrent Brief", content: "second payload\n" }),
  ]);
  assert.notEqual(results[0].path, results[1].path);
  const bodies = await Promise.all(results.map((entry) => readFile(join(workspace, entry.path), "utf8")));
  assert.deepEqual(new Set(bodies), new Set(["first payload\n", "second payload\n"]));
  for (const entry of results) {
    assert.equal(dirname(join(workspace, entry.path)), join(workspace, "briefs"));
  }
});
