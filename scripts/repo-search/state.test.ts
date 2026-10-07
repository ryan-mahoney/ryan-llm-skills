// Focused contract tests for immutable generation publication, acquisition
// pins, overlay-base retention, cross-process claims, recovery, and state-path
// containment. These cases exercise the real state.ts public API against
// disposable owner-only state roots and real Bun SQLite/filesystem state.
//
// API exercised here:
//   openState(stateRoot,{processProbe?,afterRename?}) -> State
//   beginOperation({command,kind,checkoutKey?,writer?,native?}) -> { id }
//   beginGeneration({operationId,checkoutKey,repoKey,kind,baseId,compatibility,
//     snapshotDigest,capturedAt,observedHead,sourceMoved,bytes})
//     -> { id, tempPath, finalPath } and records staging ownership
//   publish({operationId,generationId,validate}) -> Promise<void>;
//     validate(tempPath) returning false rejects and leaves current unchanged
//   acquireCurrent({operationId,checkoutKey}) -> { current, base } and pins both
//     until finishOperation
//   finishOperation(operationId,outcome?); close(); forgetCheckout(checkoutKey)
//   recover(operationId) -> Promise<interrupted operation>; refuses live/unknown
//   prune({maxGenerations?,deadlineMs?}) -> Promise<{ deleted, retained }> ids

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { createCodeSearchCompatibility } from "./core/embeddingContract";
import { checkoutStatePath, resolveStateRoot } from "./identity.mjs";
import { openState } from "./state";

// Owned-child protocol. The private env var is read before any test
// registration so a parent test can spawn this same file as a finite child.
// The child only touches its supplied disposable state root.
const CHILD_ENV = "REPO_SEARCH_STATE_CHILD";
const childConfig = process.env[CHILD_ENV];
if (childConfig) {
  await runChild(JSON.parse(childConfig));
  process.exit(0);
}

const REPO_KEY = "a".repeat(64);
const PRIMARY_KEY = "b".repeat(64);
const WORKTREE_KEY = "c".repeat(64);

// Independently authored compatibility: identical across generations of one
// checkout so compatibility comparison is exercised, never duplicated here.
const COMPATIBILITY = createCodeSearchCompatibility({
  modelId: "fixture/jina-embeddings-v2-base-code",
  assetDigest: "d".repeat(64),
});

const tempRoots: string[] = [];
const startedChildren: ChildProcess[] = [];
const TEST_FILE = fileURLToPath(import.meta.url);

function makeStateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-search-state-"));
  tempRoots.push(root);
  return root;
}

// Settle every owned child, then remove only owned temp roots.
afterEach(async () => {
  for (const child of startedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function metadata(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    checkoutKey: PRIMARY_KEY,
    repoKey: REPO_KEY,
    kind: "full",
    baseId: null,
    compatibility: COMPATIBILITY,
    snapshotDigest: "0".repeat(64),
    capturedAt: new Date().toISOString(),
    observedHead: null,
    sourceMoved: false,
    bytes: 1,
    ...overrides,
  };
}

// Real temp marker file plus a validate callback that proves publish only
// accepts a fully written directory.
async function publishGeneration(
  state: any,
  operationId: string,
  overrides: Record<string, unknown>,
  marker = "manifest.json",
): Promise<{ id: string; tempPath: string; finalPath: string }> {
  const input = metadata(overrides);
  const generation = state.beginGeneration({ operationId, ...input });
  mkdirSync(generation.tempPath, { recursive: true });
  writeFileSync(
    join(generation.tempPath, marker),
    JSON.stringify({ id: generation.id, digest: input.snapshotDigest }),
  );
  await state.publish({
    operationId,
    generationId: generation.id,
    validate: (tempPath: string) => existsSync(join(tempPath, marker)),
  });
  return generation;
}

// ---- Owned child protocol -------------------------------------------------

type ChildConfig = {
  mode: "reader" | "orphan";
  stateRoot: string;
  command: string;
  kind: string;
  checkoutKey?: string;
  writer?: boolean;
  native?: boolean;
  acquireCheckoutKey?: string;
};

async function writeLine(line: string): Promise<void> {
  await new Promise<void>((resolve) => process.stdout.write(`${line}\n`, () => resolve()));
}

function waitForStdinLine(): Promise<string> {
  return new Promise<string>((resolve) => {
    const reader = createInterface({ input: process.stdin });
    reader.once("line", (line) => {
      reader.close();
      resolve(line);
    });
  });
}

// Runs in the spawned child before any test registration. A reader waits for
// explicit release and finishes; an orphan exits without finish so recovery
// sees a confirmed-dead owner.
async function runChild(config: ChildConfig): Promise<void> {
  const state: any = openState(config.stateRoot);
  const operation = state.beginOperation({
    command: config.command,
    kind: config.kind,
    checkoutKey: config.checkoutKey,
    writer: config.writer,
    native: config.native,
  });
  let currentId: string | null = null;
  let baseId: string | null = null;
  if (config.acquireCheckoutKey) {
    const acquired = state.acquireCurrent({
      operationId: operation.id,
      checkoutKey: config.acquireCheckoutKey,
    });
    currentId = acquired.current?.id ?? null;
    baseId = acquired.base?.id ?? null;
  }
  await writeLine(
    JSON.stringify({ type: "ready", operationId: operation.id, currentId, baseId }),
  );
  if (config.mode === "reader") {
    await waitForStdinLine();
    state.finishOperation(operation.id);
    state.close();
  }
  process.exit(0);
}

// ---- Parent-side child control --------------------------------------------

function startChild(config: ChildConfig): ChildProcess {
  const child = spawn(process.execPath, ["--no-install", TEST_FILE], {
    env: { ...process.env, [CHILD_ENV]: JSON.stringify(config) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  startedChildren.push(child);
  return child;
}

function waitForReady(child: ChildProcess): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message?.type === "ready") {
            finish(() => resolve(message));
            return;
          }
        } catch {
          // ignore non-JSON child diagnostics
        }
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      finish(() => reject(new Error(`child exited before ready (${code}): ${stderr}`)));
    });
    child.on("error", (error) => finish(() => reject(error)));
  });
}

function releaseChild(child: ChildProcess): void {
  child.stdin!.write("release\n");
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve({ code }));
  });
}

describe("immutable generation publication", () => {
  test("publishes full G1 then G2 and makes only the validated ready generation current", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const operationId = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;

      const g1 = await publishGeneration(state, operationId, {
        snapshotDigest: "1".repeat(64),
        bytes: 11,
      });
      const first = state.acquireCurrent({ operationId, checkoutKey: PRIMARY_KEY });
      expect(first.current?.id).toBe(g1.id);
      expect(first.base).toBeNull();
      expect(existsSync(checkoutStatePath(root, PRIMARY_KEY))).toBe(true);

      const g2 = await publishGeneration(state, operationId, {
        snapshotDigest: "2".repeat(64),
        bytes: 22,
      });
      const second = state.acquireCurrent({ operationId, checkoutKey: PRIMARY_KEY });
      expect(second.current?.id).toBe(g2.id);

      // A generation that fails validation never becomes current or final.
      const rejected = state.beginGeneration({
        operationId,
        ...metadata({ snapshotDigest: "3".repeat(64), bytes: 33 }),
      });
      mkdirSync(rejected.tempPath, { recursive: true });
      await expect(
        state.publish({
          operationId,
          generationId: rejected.id,
          validate: () => false,
        }),
      ).rejects.toThrow();
      const afterReject = state.acquireCurrent({ operationId, checkoutKey: PRIMARY_KEY });
      expect(afterReject.current?.id).toBe(g2.id);
      expect(existsSync(rejected.finalPath)).toBe(false);

      // Validated generations are renamed to their owned final paths.
      expect(existsSync(g1.finalPath)).toBe(true);
      expect(existsSync(g2.finalPath)).toBe(true);
      expect(existsSync(g2.tempPath)).toBe(false);

      state.finishOperation(operationId);
    } finally {
      state.close();
    }
  });

  test("does not make a moved source generation current", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const operationId = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;

      const stable = await publishGeneration(state, operationId, {
        snapshotDigest: "4".repeat(64),
        bytes: 4,
      });
      const moved = await publishGeneration(state, operationId, {
        snapshotDigest: "5".repeat(64),
        bytes: 5,
        sourceMoved: true,
      });

      expect(existsSync(moved.finalPath)).toBe(true);
      const current = state.acquireCurrent({ operationId, checkoutKey: PRIMARY_KEY });
      expect(current.current?.id).toBe(stable.id);

      state.finishOperation(operationId);
    } finally {
      state.close();
    }
  });
});

describe("acquisition pins and prune", () => {
  test("a reader pin retains the prior current across publish until finishOperation", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g1 = await publishGeneration(state, writer, {
        snapshotDigest: "1".repeat(64),
        bytes: 10,
      });

      const reader = state.beginOperation({
        command: "search",
        kind: "search",
        checkoutKey: PRIMARY_KEY,
      }).id;
      const readerAcquired = state.acquireCurrent({
        operationId: reader,
        checkoutKey: PRIMARY_KEY,
      });
      expect(readerAcquired.current?.id).toBe(g1.id);

      const g2 = await publishGeneration(state, writer, {
        snapshotDigest: "2".repeat(64),
        bytes: 20,
      });
      const writerCurrent = state.acquireCurrent({
        operationId: writer,
        checkoutKey: PRIMARY_KEY,
      });
      expect(writerCurrent.current?.id).toBe(g2.id);

      // Reader's pin protects G1 even though G2 is now current.
      const pinned = await state.prune({});
      expect(pinned.deleted).toEqual([]);
      expect([...pinned.retained].sort()).toEqual([g1.id, g2.id].sort());
      expect(existsSync(g1.finalPath)).toBe(true);

      state.finishOperation(reader);
      const released = await state.prune({});
      expect(released.deleted).toEqual([g1.id]);
      expect(released.retained).toEqual([g2.id]);
      expect(existsSync(g1.finalPath)).toBe(false);
      expect(existsSync(g2.finalPath)).toBe(true);

      state.finishOperation(writer);
    } finally {
      state.close();
    }
  });

  test("a ready overlay base reference preserves a forgotten checkout's generation", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const primaryWriter = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const base = await publishGeneration(state, primaryWriter, {
        checkoutKey: PRIMARY_KEY,
        snapshotDigest: "6".repeat(64),
        bytes: 6,
      });
      state.finishOperation(primaryWriter);

      const builder = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: WORKTREE_KEY,
        writer: true,
      }).id;
      const acquired = state.acquireCurrent({
        operationId: builder,
        checkoutKey: PRIMARY_KEY,
      });
      expect(acquired.current?.id).toBe(base.id);

      const overlay = await publishGeneration(state, builder, {
        checkoutKey: WORKTREE_KEY,
        repoKey: REPO_KEY,
        kind: "overlay",
        baseId: base.id,
        snapshotDigest: "7".repeat(64),
        bytes: 7,
      });
      state.finishOperation(builder);

      // Forgetting the primary removes only its current/enrollment reference;
      // the ready overlay's recorded base still protects the base generation.
      state.forgetCheckout(PRIMARY_KEY);

      const pruned = await state.prune({});
      expect(pruned.deleted).toEqual([]);
      expect([...pruned.retained].sort()).toEqual([base.id, overlay.id].sort());
      expect(existsSync(base.finalPath)).toBe(true);
      expect(existsSync(overlay.finalPath)).toBe(true);

      // The overlay remains current for its worktree with the base exposed.
      const worktreeReader = state.beginOperation({
        command: "search",
        kind: "search",
        checkoutKey: WORKTREE_KEY,
      }).id;
      const worktreeCurrent = state.acquireCurrent({
        operationId: worktreeReader,
        checkoutKey: WORKTREE_KEY,
      });
      expect(worktreeCurrent.current?.id).toBe(overlay.id);
      expect(worktreeCurrent.base?.id).toBe(base.id);
      state.finishOperation(worktreeReader);
    } finally {
      state.close();
    }
  });
});

describe("cross-process acquisition and recovery", () => {
  test("a live reader child pin retains G1 across parent publish and prune", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const setupWriter = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g1 = await publishGeneration(state, setupWriter, {
        snapshotDigest: "1".repeat(64),
        bytes: 10,
      });
      state.finishOperation(setupWriter);

      const child = startChild({
        mode: "reader",
        stateRoot: resolveStateRoot(root),
        command: "search",
        kind: "search",
        checkoutKey: PRIMARY_KEY,
        acquireCheckoutKey: PRIMARY_KEY,
      });
      const ready = await waitForReady(child);
      expect(ready.currentId).toBe(g1.id);

      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g2 = await publishGeneration(state, writer, {
        snapshotDigest: "2".repeat(64),
        bytes: 20,
      });
      state.finishOperation(writer);

      // The child's acquisition pin protects G1 even though G2 is current.
      const pinned = await state.prune({});
      expect(pinned.deleted).toEqual([]);
      expect([...pinned.retained].sort()).toEqual([g1.id, g2.id].sort());

      releaseChild(child);
      expect((await waitForExit(child)).code).toBe(0);

      const status = state.readStatus();
      expect(status.operations.find((op: any) => op.id === ready.operationId)?.state).toBe(
        "finished",
      );

      const released = await state.prune({});
      expect(released.deleted).toEqual([g1.id]);
      expect(released.retained).toEqual([g2.id]);
    } finally {
      state.close();
    }
  });

  test("live child writer and native claims block conflicting operations", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const child = startChild({
        mode: "reader",
        stateRoot: resolveStateRoot(root),
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
        native: true,
      });
      await waitForReady(child);

      expect(() =>
        state.beginOperation({
          command: "build",
          kind: "build",
          checkoutKey: PRIMARY_KEY,
          writer: true,
        }),
      ).toThrow();
      expect(() => state.forgetCheckout(PRIMARY_KEY)).toThrow();
      expect(() =>
        state.beginOperation({
          command: "build",
          kind: "build",
          checkoutKey: WORKTREE_KEY,
          native: true,
        }),
      ).toThrow();

      releaseChild(child);
      expect((await waitForExit(child)).code).toBe(0);

      // Claims released on finish: replacements are permitted.
      const replacementWriter = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      });
      state.finishOperation(replacementWriter.id);
      const replacementNative = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: WORKTREE_KEY,
        native: true,
      });
      state.finishOperation(replacementNative.id);
    } finally {
      state.close();
    }
  });

  test("recover refuses a live child and leaves it running", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const child = startChild({
        mode: "reader",
        stateRoot: resolveStateRoot(root),
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
        native: true,
      });
      const ready = await waitForReady(child);

      await expect(state.recover(ready.operationId)).rejects.toThrow();
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();

      releaseChild(child);
      expect((await waitForExit(child)).code).toBe(0);
    } finally {
      state.close();
    }
  });

  test("recover reclaims a confirmed-dead orphan and releases its references", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const setupWriter = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g1 = await publishGeneration(state, setupWriter, {
        snapshotDigest: "1".repeat(64),
        bytes: 10,
      });
      state.finishOperation(setupWriter);

      // The orphan claims a different checkout's writer slot but pins PRIMARY's
      // current generation, then exits without finishing.
      const orphan = startChild({
        mode: "orphan",
        stateRoot: resolveStateRoot(root),
        command: "build",
        kind: "build",
        checkoutKey: WORKTREE_KEY,
        writer: true,
        native: true,
        acquireCheckoutKey: PRIMARY_KEY,
      });
      const ready = await waitForReady(orphan);
      expect(ready.currentId).toBe(g1.id);
      expect((await waitForExit(orphan)).code).toBe(0);

      expect(
        state.readStatus().operations.find((op: any) => op.id === ready.operationId)?.state,
      ).toBe("active");

      // G1 is no longer current but is still pinned by the dead operation.
      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g2 = await publishGeneration(state, writer, {
        snapshotDigest: "2".repeat(64),
        bytes: 20,
      });
      state.finishOperation(writer);

      const pinned = await state.prune({});
      expect(pinned.deleted).toEqual([]);
      expect([...pinned.retained].sort()).toEqual([g1.id, g2.id].sort());

      await state.recover(ready.operationId);
      expect(
        state.readStatus().operations.find((op: any) => op.id === ready.operationId)?.state,
      ).toBe("interrupted");

      const reclaimed = await state.prune({});
      expect(reclaimed.deleted).toEqual([g1.id]);
      expect(reclaimed.retained).toEqual([g2.id]);

      // Released writer/native claims permit replacements.
      const replacementWriter = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: WORKTREE_KEY,
        writer: true,
      });
      state.finishOperation(replacementWriter.id);
      const replacementNative = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: WORKTREE_KEY,
        native: true,
      });
      state.finishOperation(replacementNative.id);
    } finally {
      state.close();
    }
  });

  test("an unknown process probe refuses recovery and preserves claims and pins", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root), {
      processProbe: () => "unknown",
    });
    try {
      const setupWriter = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g1 = await publishGeneration(state, setupWriter, {
        snapshotDigest: "1".repeat(64),
        bytes: 10,
      });
      state.finishOperation(setupWriter);

      const orphan = startChild({
        mode: "orphan",
        stateRoot: resolveStateRoot(root),
        command: "build",
        kind: "build",
        checkoutKey: WORKTREE_KEY,
        writer: true,
        native: true,
        acquireCheckoutKey: PRIMARY_KEY,
      });
      const ready = await waitForReady(orphan);
      expect((await waitForExit(orphan)).code).toBe(0);

      await expect(state.recover(ready.operationId)).rejects.toThrow();
      expect(
        state.readStatus().operations.find((op: any) => op.id === ready.operationId)?.state,
      ).toBe("active");

      // Claims and pins are preserved by the refused recovery.
      expect(() =>
        state.beginOperation({
          command: "build",
          kind: "build",
          checkoutKey: WORKTREE_KEY,
          writer: true,
        }),
      ).toThrow();
      expect(() =>
        state.beginOperation({
          command: "build",
          kind: "build",
          checkoutKey: PRIMARY_KEY,
          native: true,
        }),
      ).toThrow();

      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g2 = await publishGeneration(state, writer, {
        snapshotDigest: "2".repeat(64),
        bytes: 20,
      });
      state.finishOperation(writer);

      const pinned = await state.prune({});
      expect(pinned.deleted).toEqual([]);
      expect([...pinned.retained].sort()).toEqual([g1.id, g2.id].sort());
    } finally {
      state.close();
    }
  });
});

describe("interrupted publication and resumable prune", () => {
  test("a failure after rename leaves G1 current and prune reclaims the staging orphan", async () => {
    const root = makeStateRoot();
    let failAfterRename = false;
    const state: any = openState(resolveStateRoot(root), {
      afterRename: () => {
        if (failAfterRename) throw new Error("simulated crash after rename");
      },
    });
    try {
      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g1 = await publishGeneration(state, writer, {
        snapshotDigest: "1".repeat(64),
        bytes: 10,
      });

      failAfterRename = true;
      const g2 = state.beginGeneration({
        operationId: writer,
        ...metadata({ snapshotDigest: "2".repeat(64), bytes: 20 }),
      });
      mkdirSync(g2.tempPath, { recursive: true });
      writeFileSync(join(g2.tempPath, "manifest.json"), "{}");
      await expect(
        state.publish({ operationId: writer, generationId: g2.id, validate: () => true }),
      ).rejects.toThrow();

      // G2 was renamed to its final path but recorded staging, and G1 is current.
      expect(existsSync(g2.finalPath)).toBe(true);
      expect(existsSync(g2.tempPath)).toBe(false);
      const staging = state.readStatus().generations.find((entry: any) => entry.id === g2.id);
      expect(staging?.status).toBe("staging");
      const stillCurrent = state.acquireCurrent({ operationId: writer, checkoutKey: PRIMARY_KEY });
      expect(stillCurrent.current?.id).toBe(g1.id);

      state.finishOperation(writer, "failed");
      const pruned = await state.prune({});
      expect(pruned.deleted).toEqual([g2.id]);
      expect(pruned.retained).toEqual([g1.id]);
      expect(existsSync(g2.finalPath)).toBe(false);
      expect(existsSync(g1.finalPath)).toBe(true);
    } finally {
      state.close();
    }
  });

  test("prune resumes a row already marked deleting", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g1 = await publishGeneration(state, writer, {
        snapshotDigest: "1".repeat(64),
        bytes: 10,
      });
      const g2 = await publishGeneration(state, writer, {
        snapshotDigest: "2".repeat(64),
        bytes: 20,
      });
      state.finishOperation(writer);

      const raw = new Database(join(root, "state.sqlite"));
      raw.query("UPDATE generations SET status = 'deleting' WHERE id = ?").run(g1.id);
      raw.close();

      const pruned = await state.prune({});
      expect(pruned.deleted).toEqual([g1.id]);
      expect(pruned.retained).toEqual([g2.id]);
      expect(existsSync(g1.finalPath)).toBe(false);
    } finally {
      state.close();
    }
  });

  test("prune bounds one invocation to 100 generations and resumes the remainder", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      for (let index = 0; index < 101; index += 1) {
        await publishGeneration(state, writer, {
          snapshotDigest: index.toString(16).padStart(64, "0"),
          bytes: index + 1,
          sourceMoved: true,
        });
      }
      state.finishOperation(writer);

      const first = await state.prune({});
      expect(first.deleted.length).toBe(100);
      expect(first.retained.length).toBe(1);
      const second = await state.prune({});
      expect(second.deleted.length).toBe(1);
      expect(second.retained).toEqual([]);
    } finally {
      state.close();
    }
  });

  test("the schema rejects a current row pointing at a staging generation", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const staging = state.beginGeneration({
        operationId: writer,
        ...metadata({ snapshotDigest: "9".repeat(64), bytes: 9 }),
      });

      const raw = new Database(join(root, "state.sqlite"));
      expect(() =>
        raw
          .query(
            "INSERT INTO current_generations (checkout_key, generation_id, updated_at) VALUES (?, ?, ?)",
          )
          .run("e".repeat(64), staging.id, new Date().toISOString()),
      ).toThrow();
      raw.close();

      state.finishOperation(writer);
    } finally {
      state.close();
    }
  });
});

describe("state-path containment", () => {
  test("rejects a symlink root and an accessible root, and creates an absent root 0700", () => {
    const base = makeStateRoot();

    const realRoot = join(base, "real-state");
    mkdirSync(realRoot, { recursive: true, mode: 0o700 });
    const symlinkRoot = join(base, "link-state");
    symlinkSync(realRoot, symlinkRoot, "dir");
    expect(() => openState(symlinkRoot)).toThrow();

    const openRoot = join(base, "open-state");
    mkdirSync(openRoot, { recursive: true, mode: 0o777 });
    chmodSync(openRoot, 0o777);
    expect(() => openState(openRoot)).toThrow();

    const freshRoot = join(base, "fresh-state");
    const fresh = openState(freshRoot);
    expect(statSync(freshRoot).mode & 0o777).toBe(0o700);
    fresh.close();
  });

  test("prune rejects a symlinked final generation directory instead of skipping it", async () => {
    const base = makeStateRoot();
    const stateRoot = join(base, "state");
    const state: any = openState(stateRoot);
    try {
      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g1 = await publishGeneration(state, writer, {
        snapshotDigest: "1".repeat(64),
        bytes: 10,
      });
      const g2 = await publishGeneration(state, writer, {
        snapshotDigest: "2".repeat(64),
        bytes: 20,
      });
      state.finishOperation(writer);

      const external = join(base, "external-final");
      mkdirSync(external, { recursive: true });
      writeFileSync(join(external, "sentinel.txt"), "external");
      rmSync(g1.finalPath, { recursive: true, force: true });
      symlinkSync(external, g1.finalPath, "dir");

      await expect(state.prune({})).rejects.toThrow();
      expect(existsSync(join(external, "sentinel.txt"))).toBe(true);
      expect(lstatSync(g1.finalPath).isSymbolicLink()).toBe(true);
      expect(existsSync(g2.finalPath)).toBe(true);
    } finally {
      state.close();
    }
  });

  test("prune rejects a symlinked generations parent instead of following it", async () => {
    const base = makeStateRoot();
    const stateRoot = join(base, "state");
    const state: any = openState(stateRoot);
    try {
      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g1 = await publishGeneration(state, writer, {
        snapshotDigest: "1".repeat(64),
        bytes: 10,
      });
      const g2 = await publishGeneration(state, writer, {
        snapshotDigest: "2".repeat(64),
        bytes: 20,
      });
      state.finishOperation(writer);

      renameSync(join(stateRoot, "generations"), join(base, "generations-backup"));
      const externalParent = join(base, "external-generations");
      mkdirSync(join(externalParent, g1.id), { recursive: true });
      writeFileSync(join(externalParent, g1.id, "sentinel.txt"), "external");
      symlinkSync(externalParent, join(stateRoot, "generations"), "dir");

      await expect(state.prune({})).rejects.toThrow();
      expect(existsSync(join(externalParent, g1.id, "sentinel.txt"))).toBe(true);
      expect(existsSync(join(base, "generations-backup", g2.id))).toBe(true);
    } finally {
      state.close();
    }
  });

  test("prune rejects a corrupted generation path column pointing outside the state root", async () => {
    const base = makeStateRoot();
    const stateRoot = join(base, "state");
    const state: any = openState(stateRoot);
    try {
      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g1 = await publishGeneration(state, writer, {
        snapshotDigest: "1".repeat(64),
        bytes: 10,
      });
      const g2 = await publishGeneration(state, writer, {
        snapshotDigest: "2".repeat(64),
        bytes: 20,
      });
      state.finishOperation(writer);

      const external = join(base, "external-corrupt");
      mkdirSync(join(external, "payload"), { recursive: true });
      writeFileSync(join(external, "payload", "sentinel.txt"), "external");
      const raw = new Database(join(stateRoot, "state.sqlite"));
      raw
        .query("UPDATE generations SET final_path = ?, temp_path = ? WHERE id = ?")
        .run(join(external, "payload"), join(external, "payload.tmp"), g1.id);
      raw.close();

      await expect(state.prune({})).rejects.toThrow();
      expect(existsSync(join(external, "payload", "sentinel.txt"))).toBe(true);
      expect(existsSync(g2.finalPath)).toBe(true);
    } finally {
      state.close();
    }
  });
});

describe("generation ownership", () => {
  test("an active read-only operation cannot stage a generation", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const reader = state.beginOperation({
        command: "search",
        kind: "search",
        checkoutKey: PRIMARY_KEY,
      }).id;

      expect(() =>
        state.beginGeneration({
          operationId: reader,
          ...metadata({ snapshotDigest: "1".repeat(64), bytes: 10 }),
        }),
      ).toThrow();

      state.finishOperation(reader, "failed");
    } finally {
      state.close();
    }
  });

  test("a writer claimed for one checkout cannot stage a generation for another", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;

      expect(() =>
        state.beginGeneration({
          operationId: writer,
          ...metadata({
            checkoutKey: WORKTREE_KEY,
            snapshotDigest: "2".repeat(64),
            bytes: 20,
          }),
        }),
      ).toThrow();

      state.finishOperation(writer, "failed");
    } finally {
      state.close();
    }
  });

  test("an overlay requires the same operation to have pinned its primary base", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const setupWriter = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const base = await publishGeneration(state, setupWriter, {
        snapshotDigest: "3".repeat(64),
        bytes: 30,
      });
      state.finishOperation(setupWriter);

      const builder = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: WORKTREE_KEY,
        writer: true,
      }).id;

      const overlayInput = metadata({
        checkoutKey: WORKTREE_KEY,
        kind: "overlay",
        baseId: base.id,
        snapshotDigest: "4".repeat(64),
        bytes: 40,
      });

      // Without an acquisition pin on the base, staging must be rejected.
      expect(() =>
        state.beginGeneration({ operationId: builder, ...overlayInput }),
      ).toThrow();

      // Legitimate cross-checkout acquisition pins the primary base.
      const acquired = state.acquireCurrent({
        operationId: builder,
        checkoutKey: PRIMARY_KEY,
      });
      expect(acquired.current?.id).toBe(base.id);

      const staged = state.beginGeneration({ operationId: builder, ...overlayInput });
      expect(staged.id).toBeTruthy();
      const stagedRow = state
        .readStatus()
        .generations.find((entry: any) => entry.id === staged.id);
      expect(stagedRow?.status).toBe("staging");
      expect(stagedRow?.baseId).toBe(base.id);

      // Finish failed so the staging orphan is safely reclaimable.
      state.finishOperation(builder, "failed");
      const pruned = await state.prune({});
      expect(pruned.deleted).toEqual([staged.id]);
      expect(pruned.retained).toEqual([base.id]);
    } finally {
      state.close();
    }
  });
});

describe("F1: state database path containment", () => {
  test("rejects a symlinked state.sqlite without touching the external database", () => {
    const base = makeStateRoot();
    const stateRoot = join(base, "state");
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const external = join(base, "external.sqlite");
    const externalDb = new Database(external);
    externalDb.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('keep');");
    externalDb.close();
    const bytesBefore = readFileSync(external);
    const modeBefore = statSync(external).mode & 0o777;

    symlinkSync(external, join(stateRoot, "state.sqlite"));
    expect(() => {
      const opened = openState(stateRoot);
      opened.close();
    }).toThrow();

    const check = new Database(external);
    const row = check.query("SELECT value FROM sentinel").get() as any;
    expect(row?.value).toBe("keep");
    check.close();
    expect(readFileSync(external).equals(bytesBefore)).toBe(true);
    expect(statSync(external).mode & 0o777).toBe(modeBefore);
  });

  test("rejects symlinked state.sqlite-wal/state.sqlite-shm sidecars", () => {
    const base = makeStateRoot();
    const stateRoot = join(base, "state");
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const wal = join(base, "external-wal");
    const shm = join(base, "external-shm");
    writeFileSync(wal, "wal-sentinel");
    writeFileSync(shm, "shm-sentinel");
    symlinkSync(wal, join(stateRoot, "state.sqlite-wal"));
    symlinkSync(shm, join(stateRoot, "state.sqlite-shm"));

    expect(() => {
      const opened = openState(stateRoot);
      opened.close();
    }).toThrow();
    expect(readFileSync(wal, "utf8")).toBe("wal-sentinel");
    expect(readFileSync(shm, "utf8")).toBe("shm-sentinel");
  });
});

describe("F2: resumed overlay deletion and base reference", () => {
  test("resumed overlay deletion preserves its base until the next prune", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const primaryWriter = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const base = await publishGeneration(state, primaryWriter, {
        snapshotDigest: "1".repeat(64),
        bytes: 10,
      });
      state.finishOperation(primaryWriter);

      const builder = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: WORKTREE_KEY,
        writer: true,
      }).id;
      const acquired = state.acquireCurrent({
        operationId: builder,
        checkoutKey: PRIMARY_KEY,
      });
      expect(acquired.current?.id).toBe(base.id);
      const overlay = await publishGeneration(state, builder, {
        checkoutKey: WORKTREE_KEY,
        kind: "overlay",
        baseId: base.id,
        snapshotDigest: "2".repeat(64),
        bytes: 20,
      });
      state.finishOperation(builder);

      state.forgetCheckout(PRIMARY_KEY);
      state.forgetCheckout(WORKTREE_KEY);

      // Simulate an interrupted overlay prune through the real database.
      const raw = new Database(join(root, "state.sqlite"));
      raw.query("UPDATE generations SET status = 'deleting' WHERE id = ?").run(overlay.id);
      raw.close();

      const first = await state.prune({});
      expect(first.deleted).toEqual([overlay.id]);
      expect(first.retained).toEqual([base.id]);
      expect(existsSync(overlay.finalPath)).toBe(false);
      expect(existsSync(base.finalPath)).toBe(true);

      const second = await state.prune({});
      expect(second.deleted).toEqual([base.id]);
      expect(second.retained).toEqual([]);
      expect(existsSync(base.finalPath)).toBe(false);
    } finally {
      state.close();
    }
  });
});

describe("F3: publish revalidates the temp path after async validation", () => {
  test("rejects a temp directory replaced during an async validator", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g1 = await publishGeneration(state, writer, {
        snapshotDigest: "1".repeat(64),
        bytes: 10,
      });
      const g2 = state.beginGeneration({
        operationId: writer,
        ...metadata({ snapshotDigest: "2".repeat(64), bytes: 20 }),
      });
      mkdirSync(g2.tempPath, { recursive: true });
      writeFileSync(join(g2.tempPath, "manifest.json"), "{}");

      let startValidation!: () => void;
      let releaseValidation!: () => void;
      const validationStarted = new Promise<void>((resolve) => {
        startValidation = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
      const publishing = state.publish({
        operationId: writer,
        generationId: g2.id,
        validate: async () => {
          startValidation();
          await gate;
          return true;
        },
      });

      await validationStarted;
      rmSync(g2.tempPath, { recursive: true, force: true });
      mkdirSync(g2.tempPath, { recursive: true, mode: 0o700 });
      writeFileSync(join(g2.tempPath, "replacement.txt"), "replacement");
      releaseValidation();

      await expect(publishing).rejects.toThrow();
      const current = state.acquireCurrent({ operationId: writer, checkoutKey: PRIMARY_KEY });
      expect(current.current?.id).toBe(g1.id);
      expect(existsSync(g2.finalPath)).toBe(false);
      expect(
        state.readStatus().generations.find((entry: any) => entry.id === g2.id)?.status,
      ).toBe("staging");

      state.finishOperation(writer, "failed");
    } finally {
      state.close();
    }
  });

  test("rejects a temp path swapped to an external symlink during async validation", async () => {
    const base = makeStateRoot();
    const state: any = openState(base);
    try {
      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g1 = await publishGeneration(state, writer, {
        snapshotDigest: "1".repeat(64),
        bytes: 10,
      });
      const g2 = state.beginGeneration({
        operationId: writer,
        ...metadata({ snapshotDigest: "2".repeat(64), bytes: 20 }),
      });
      mkdirSync(g2.tempPath, { recursive: true });
      writeFileSync(join(g2.tempPath, "manifest.json"), "{}");

      let startValidation!: () => void;
      let releaseValidation!: () => void;
      const validationStarted = new Promise<void>((resolve) => {
        startValidation = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
      const publishing = state.publish({
        operationId: writer,
        generationId: g2.id,
        validate: async () => {
          startValidation();
          await gate;
          return true;
        },
      });

      await validationStarted;
      const external = join(base, "external-swap");
      mkdirSync(external, { recursive: true });
      writeFileSync(join(external, "sentinel.txt"), "external");
      rmSync(g2.tempPath, { recursive: true, force: true });
      symlinkSync(external, g2.tempPath, "dir");
      releaseValidation();

      await expect(publishing).rejects.toThrow();
      expect(existsSync(join(external, "sentinel.txt"))).toBe(true);
      const current = state.acquireCurrent({ operationId: writer, checkoutKey: PRIMARY_KEY });
      expect(current.current?.id).toBe(g1.id);
      expect(existsSync(g2.finalPath)).toBe(false);

      state.finishOperation(writer, "failed");
    } finally {
      state.close();
    }
  });
});

describe("F4: recover refuses malformed operation identity without probing", () => {
  test("a negative stored pid refuses recovery and preserves state, pins and claims", async () => {
    const root = makeStateRoot();
    let probeCalls = 0;
    const state: any = openState(resolveStateRoot(root), {
      processProbe: () => {
        probeCalls += 1;
        return "alive";
      },
    });
    try {
      const operation = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
        native: true,
      }).id;
      const g1 = await publishGeneration(state, operation, {
        snapshotDigest: "1".repeat(64),
        bytes: 10,
      });
      const pin = state.acquireCurrent({ operationId: operation, checkoutKey: PRIMARY_KEY });
      expect(pin.current?.id).toBe(g1.id);
      const g2 = await publishGeneration(state, operation, {
        snapshotDigest: "2".repeat(64),
        bytes: 20,
      });

      // Corruption setup only: bypass check constraints and store an invalid pid.
      const raw = new Database(join(root, "state.sqlite"));
      raw.exec("PRAGMA ignore_check_constraints = ON;");
      raw.query("UPDATE operations SET pid = ? WHERE id = ?").run(-12345, operation);
      raw.close();

      let recoverError: any = null;
      try {
        await state.recover(operation);
      } catch (error) {
        recoverError = error;
      }
      expect(recoverError).not.toBeNull();
      expect(recoverError?.code).toBe("operation-unknown");
      expect(probeCalls).toBe(0);

      expect(
        state.readStatus().operations.find((entry: any) => entry.id === operation)?.state,
      ).toBe("active");
      expect(() =>
        state.beginOperation({
          command: "build",
          kind: "build",
          checkoutKey: PRIMARY_KEY,
          writer: true,
        }),
      ).toThrow();
      expect(() =>
        state.beginOperation({
          command: "build",
          kind: "build",
          checkoutKey: WORKTREE_KEY,
          native: true,
        }),
      ).toThrow();

      // The pinned, non-current G1 must survive prune.
      const pruned = await state.prune({});
      expect(pruned.deleted).toEqual([]);
      expect([...pruned.retained].sort()).toEqual([g1.id, g2.id].sort());
    } finally {
      state.close();
    }
  });
});

describe("finalized publication facts", () => {
  test("publish finalize overrides sourceMoved/bytes without advancing current", async () => {
    const root = makeStateRoot();
    const state: any = openState(resolveStateRoot(root));
    try {
      const writer = state.beginOperation({
        command: "build",
        kind: "build",
        checkoutKey: PRIMARY_KEY,
        writer: true,
      }).id;
      const g1 = await publishGeneration(state, writer, {
        snapshotDigest: "1".repeat(64),
        bytes: 10,
      });

      const g2 = state.beginGeneration({
        operationId: writer,
        ...metadata({
          snapshotDigest: "2".repeat(64),
          bytes: 0,
          sourceMoved: false,
        }),
      });
      mkdirSync(g2.tempPath, { recursive: true });
      writeFileSync(join(g2.tempPath, "manifest.json"), "{}");
      await state.publish({
        operationId: writer,
        generationId: g2.id,
        validate: () => true,
        finalize: { sourceMoved: true, bytes: 4321 },
      });

      // Finalized facts are observable as ready generation metadata.
      const row = state
        .readStatus()
        .generations.find((entry: any) => entry.id === g2.id);
      expect(row?.status).toBe("ready");
      expect(row?.sourceMoved).toBe(true);
      expect(row?.bytes).toBe(4321);

      // The finalized moved generation never advances current.
      const acquired = state.acquireCurrent({
        operationId: writer,
        checkoutKey: PRIMARY_KEY,
      });
      expect(acquired.current?.id).toBe(g1.id);

      state.finishOperation(writer);
    } finally {
      state.close();
    }
  });
});
