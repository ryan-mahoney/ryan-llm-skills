// Focused real-Git fixtures for canonical checkout identity and the safe
// tracked-source snapshot contract. These cases use disposable repositories
// and linked worktrees only; no operator checkout is read or modified.

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  checkoutStatePath,
  defaultStateRoot,
  enrollmentPath,
  resolveCheckout,
  resolveStateRoot,
} from "./identity.mjs";
import {
  captureSnapshot,
  DEFAULT_MAX_BYTES_PER_FILE,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_TOTAL_BYTES,
  readEligibleFile,
  SOURCE_POLICY_VERSION,
} from "./source";
import { chunkFile } from "./core/chunk";
import { languageForPath, routeStrategy } from "./core/route";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "repo-search-identity-")),
  );
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// Fixture Git configuration is local to each invocation; nothing is written to
// the operator's global or system Git configuration.
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(cwd: string, message: string): string {
  git(
    cwd,
    "-c",
    "user.name=Identity Fixture",
    "-c",
    "user.email=identity@example.invalid",
    "commit",
    "-qm",
    message,
  );
  return git(cwd, "rev-parse", "HEAD");
}

function makeRepo(base: string, name: string): string {
  const repo = join(base, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git(repo, "add", "README.md");
  commit(repo, "fixture");
  return repo;
}

function addWorktree(repo: string, path: string, branch: string): void {
  mkdirSync(dirname(path), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", branch, path, "HEAD");
}

// Independent SHA256 derivation used to check captured bytes, never imported
// from the module under test.
function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function makeEligibleRepo(base: string): string {
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  return repo;
}

function track(repo: string, relPath: string, content: string | Buffer): void {
  const absolute = join(repo, relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function commitAll(repo: string, message = "fixture"): string {
  git(repo, "add", "-A");
  return commit(repo, message);
}

async function captureFailure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

const HEX_KEY = /^[0-9a-f]{64}$/;

describe("resolveCheckout", () => {
  test("keeps same-basename linked worktrees distinct and canonicalizes aliases", async () => {
    const base = makeTempRoot();
    const repo = makeRepo(base, "primary");
    const left = join(base, "left-parent", "feature");
    const right = join(base, "right-parent", "feature");
    addWorktree(repo, left, "left-feature");
    addWorktree(repo, right, "right-feature");

    const primary = await resolveCheckout(repo);
    const leftIdentity = await resolveCheckout(left);
    const rightIdentity = await resolveCheckout(right);

    // Primary: canonical root and matching Git/common directories.
    expect(primary.root).toBe(realpathSync(repo));
    expect(primary.commonDir).toBe(realpathSync(join(repo, ".git")));
    expect(primary.gitDir).toBe(primary.commonDir);
    expect(primary.primary).toBe(true);

    // Linked worktrees: same repository, distinct Git directories.
    for (const identity of [leftIdentity, rightIdentity]) {
      expect(identity.primary).toBe(false);
      expect(identity.gitDir).not.toBe(identity.commonDir);
      expect(identity.repoKey).toBe(primary.repoKey);
      expect(identity.commonDir).toBe(primary.commonDir);
    }
    expect(leftIdentity.root).toBe(realpathSync(left));
    expect(rightIdentity.root).toBe(realpathSync(right));

    // Deliberate basename collision must not collide the checkout keys.
    expect(basename(left)).toBe("feature");
    expect(basename(right)).toBe("feature");
    expect(leftIdentity.checkoutKey).not.toBe(rightIdentity.checkoutKey);
    expect(
      new Set([
        primary.checkoutKey,
        leftIdentity.checkoutKey,
        rightIdentity.checkoutKey,
      ]).size,
    ).toBe(3);

    for (const identity of [primary, leftIdentity, rightIdentity]) {
      expect(identity.repoKey).toMatch(HEX_KEY);
      expect(identity.checkoutKey).toMatch(HEX_KEY);
      expect(identity.head).toMatch(/^[0-9a-f]{40}$/);
    }

    // A symlink alias resolves to the same canonical identity as its target.
    const alias = join(base, "primary-alias");
    symlinkSync(repo, alias, "dir");
    const aliased = await resolveCheckout(alias);
    expect(aliased.root).toBe(primary.root);
    expect(aliased.commonDir).toBe(primary.commonDir);
    expect(aliased.gitDir).toBe(primary.gitDir);
    expect(aliased.repoKey).toBe(primary.repoKey);
    expect(aliased.checkoutKey).toBe(primary.checkoutKey);
    expect(aliased.primary).toBe(true);
    expect(aliased.head).toBe(primary.head);
  });

  test("preserves trailing whitespace in the requested checkout path", async () => {
    const base = makeTempRoot();
    const trimmedSibling = makeRepo(base, "checkout");
    const requested = makeRepo(base, "checkout ");

    const requestedIdentity = await resolveCheckout(requested);
    const siblingIdentity = await resolveCheckout(trimmedSibling);

    expect(requestedIdentity.root).toBe(realpathSync(requested));
    expect(requestedIdentity.gitDir).toBe(realpathSync(join(requested, ".git")));
    expect(requestedIdentity.checkoutKey).not.toBe(siblingIdentity.checkoutKey);
  });

  test("resolves a detached HEAD without using it as an identity key", async () => {
    const base = makeTempRoot();
    const repo = makeRepo(base, "primary");
    const first = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "second.txt"), "second\n");
    git(repo, "add", "second.txt");
    const second = commit(repo, "second");
    expect(second).not.toBe(first);

    const attached = await resolveCheckout(repo);
    const worktree = join(base, "detached-parent", "feature");
    addWorktree(repo, worktree, "detached-feature");
    git(worktree, "checkout", "-q", "--detach", first);

    const detached = await resolveCheckout(worktree);
    expect(detached.head).toBe(first);
    expect(detached.head).not.toBe(second);
    expect(detached.primary).toBe(false);
    // HEAD is provenance: the key is derived from dirs, not the commit.
    expect(detached.checkoutKey).not.toBe(attached.checkoutKey);

    // Re-attaching changes provenance without changing the checkout key.
    git(worktree, "checkout", "-q", "detached-feature");
    const reattached = await resolveCheckout(worktree);
    expect(reattached.head).toBe(second);
    expect(reattached.checkoutKey).toBe(detached.checkoutKey);
  });
});

describe("state and enrollment paths", () => {
  test("validates checkout keys before forming contained paths", () => {
    const key = "a".repeat(64);
    expect(defaultStateRoot()).toBe(
      join(homedir(), ".cache", "agent-repo-search"),
    );
    expect(resolveStateRoot(undefined)).toBe(defaultStateRoot());
    expect(resolveStateRoot("")).toBe(defaultStateRoot());

    const root = resolveStateRoot("/tmp/repo-search-custom-state");
    expect(root).toBe("/tmp/repo-search-custom-state");
    expect(checkoutStatePath(root, key)).toBe(join(root, "checkouts", key));
    expect(enrollmentPath(root, key)).toBe(
      join(root, "checkouts", key, "enrollment.json"),
    );

    const invalid = [
      "",
      "abc",
      "A".repeat(64),
      `${key}0`,
      key.slice(0, 63),
      "../escape",
      `${key}/../../escape`,
    ];
    for (const candidate of invalid) {
      expect(() => checkoutStatePath(root, candidate)).toThrow();
      expect(() => enrollmentPath(root, candidate)).toThrow();
    }
  });
});

describe("captureSnapshot", () => {
  test("captures eligible exact bytes and preserves whitespace/newline filenames", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    const alpha = "export const alpha = 1;\n";
    const beta = "no trailing newline";
    const tabbed = "tabbed\n";
    const newlineNamed = "newline name\n";
    const leaf = "# leaf\n";
    track(repo, "src/alpha.ts", alpha);
    track(repo, "space name.txt", beta);
    track(repo, " tab\tindented.txt", tabbed);
    track(repo, "new\nline.txt", newlineNamed);
    track(repo, "dir with space/leaf.md", leaf);
    commitAll(repo);
    const identity = await resolveCheckout(repo);

    const snapshot = await captureSnapshot(identity, {});
    expect(snapshot.policyVersion).toBe(SOURCE_POLICY_VERSION);
    expect(snapshot.identity.checkoutKey).toBe(identity.checkoutKey);

    const alphaFile = snapshot.files.get("src/alpha.ts");
    expect(alphaFile).toBeDefined();
    expect(Buffer.from(alphaFile?.bytes ?? Buffer.alloc(0)).toString("utf8")).toBe(alpha);
    expect(alphaFile?.sha256).toBe(sha256(Buffer.from(alpha, "utf8")));

    const spaceFile = snapshot.files.get("space name.txt");
    expect(spaceFile).toBeDefined();
    expect(Buffer.from(spaceFile?.bytes ?? Buffer.alloc(0)).toString("utf8")).toBe(beta);
    expect(spaceFile?.sha256).toBe(sha256(Buffer.from(beta, "utf8")));

    // Whitespace and newline names round trip exactly, never trimmed.
    expect(snapshot.files.get(" tab\tindented.txt")?.sha256).toBe(
      sha256(Buffer.from(tabbed, "utf8")),
    );
    expect(snapshot.files.get("new\nline.txt")?.sha256).toBe(
      sha256(Buffer.from(newlineNamed, "utf8")),
    );
    expect(snapshot.files.get("dir with space/leaf.md")?.sha256).toBe(
      sha256(Buffer.from(leaf, "utf8")),
    );

    expect(snapshot.sourceBytes).toBe(
      Buffer.byteLength(alpha) +
        Buffer.byteLength(beta) +
        Buffer.byteLength(tabbed) +
        Buffer.byteLength(newlineNamed) +
        Buffer.byteLength(leaf),
    );
    expect(snapshot.digest).toMatch(HEX_KEY);

    // Identical content yields an identical deterministic digest.
    const again = await captureSnapshot(identity, {});
    expect(again.digest).toBe(snapshot.digest);
  });

  test("preserves a leading BOM character in a tracked filename", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    const bomPath = "\ufeffcode.ts";
    const content = "export const bomOnly = true;\n";
    track(repo, bomPath, content);
    commitAll(repo);
    const identity = await resolveCheckout(repo);

    const snapshot = await captureSnapshot(identity, {});
    expect([...snapshot.files.keys()]).toEqual([bomPath]);
    expect(snapshot.files.get(bomPath)?.sha256).toBe(
      sha256(Buffer.from(content, "utf8")),
    );
  });

  test("keeps BOM-prefixed and plain tracked filenames distinct", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    const bomPath = "\ufeffcode.ts";
    const bomContent = "export const variant = 'bom';\n";
    const plainContent = "export const variant = 'plain';\n";
    track(repo, bomPath, bomContent);
    track(repo, "code.ts", plainContent);
    commitAll(repo);
    const identity = await resolveCheckout(repo);

    const snapshot = await captureSnapshot(identity, {});
    expect(snapshot.files.size).toBe(2);
    expect(snapshot.files.get(bomPath)?.sha256).toBe(
      sha256(Buffer.from(bomContent, "utf8")),
    );
    expect(snapshot.files.get("code.ts")?.sha256).toBe(
      sha256(Buffer.from(plainContent, "utf8")),
    );
  });

  test("changed same-HEAD bytes with backdated mtime change hashes and digest", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    track(repo, "code.ts", "export const value = 1;\n");
    commitAll(repo);
    const identity = await resolveCheckout(repo);
    const before = await captureSnapshot(identity, {});
    const headBefore = identity.head;

    const codePath = join(repo, "code.ts");
    writeFileSync(codePath, "export const value = 2;\n");
    const stale = new Date(Date.now() - 86_400_000);
    utimesSync(codePath, stale, stale);

    const after = await captureSnapshot(identity, {});
    expect(after.identity.head).toBe(headBefore);
    expect(after.files.get("code.ts")?.sha256).not.toBe(
      before.files.get("code.ts")?.sha256,
    );
    expect(
      Buffer.from(after.files.get("code.ts")?.bytes ?? Buffer.alloc(0)).toString("utf8"),
    ).toBe("export const value = 2;\n");
    expect(after.digest).not.toBe(before.digest);
  });

  test("excludes tracked secrets, tests, binaries, excluded dirs and symlinks", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    track(repo, "src/keep.ts", "export const keep = true;\n");
    track(repo, ".env", "SECRET=1\n");
    track(repo, ".env.local", "SECRET=2\n");
    track(repo, ".npmrc", "//registry\n");
    track(repo, "id_rsa", "PRIVATE\n");
    track(repo, "id_ed25519", "PRIVATE\n");
    track(repo, "certs/server.pem", "PEM\n");
    track(repo, "certs/server.key", "KEY\n");
    track(repo, "certs/store.p12", "P12\n");
    track(repo, "certs/store.pfx", "PFX\n");
    track(repo, "config/credentials.json", "{}\n");
    track(repo, "src/app.test.ts", "test\n");
    track(repo, "src/app.spec.js", "spec\n");
    track(repo, "assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    track(repo, "archives/data.zip", Buffer.from([0x50, 0x4b]));
    track(repo, "node_modules/pkg/index.js", "module\n");
    track(repo, "vendor/lib.js", "vendor\n");
    track(repo, "build/out.js", "build\n");
    track(repo, "dist/out.js", "dist\n");
    track(repo, "coverage/report.js", "coverage\n");
    track(repo, "generated/schema.ts", "generated\n");
    track(repo, ".restory/state.json", "{}\n");
    track(repo, ".specs/notes.md", "notes\n");
    track(repo, ".ssh/id_rsa", "PRIVATE\n");
    track(repo, "binary.txt", Buffer.from([0x00, 0x01, 0x02]));
    track(repo, "invalid-utf8.txt", Buffer.from([0xff, 0xfe, 0xfd]));
    symlinkSync("/etc/hosts", join(repo, "outside-link"), "file");
    commitAll(repo);
    const identity = await resolveCheckout(repo);

    const snapshot = await captureSnapshot(identity, {});
    expect([...snapshot.files.keys()]).toEqual(["src/keep.ts"]);
    expect(snapshot.excluded["excluded-secret"]).toBe(10);
    expect(snapshot.excluded["excluded-test"]).toBe(2);
    expect(snapshot.excluded["excluded-directory"]).toBe(9);
    expect(snapshot.excluded["excluded-binary-extension"]).toBe(2);
    expect(snapshot.excluded["excluded-symlink"]).toBe(1);
    expect(snapshot.excluded["content-binary"]).toBe(1);
    expect(snapshot.excluded["content-not-utf8"]).toBe(1);
  });

  test("counts invalid UTF-8 tracked filenames as an explicit exclusion", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    track(repo, "keep.ts", "export const keep = 1;\n");
    commitAll(repo);

    // macOS rejects creating an invalid-byte pathname (EILSEQ), so seed the
    // invalid name directly into the Git index: write a blob, then add an
    // index entry whose NUL-terminated path holds the invalid UTF-8 bytes.
    const blobId = execFileSync(
      "git",
      ["-C", repo, "hash-object", "-w", "--stdin"],
      { input: Buffer.from("content\n"), encoding: "utf8" },
    ).trim();
    const invalidName = Buffer.concat([
      Buffer.from("bad-", "utf8"),
      Buffer.from([0xff, 0xfe]),
    ]);
    const indexInfo = Buffer.concat([
      Buffer.from(`100644 ${blobId} 0\t`, "utf8"),
      invalidName,
      Buffer.from([0x00]),
    ]);
    execFileSync("git", ["-C", repo, "update-index", "-z", "--index-info"], {
      input: indexInfo,
      stdio: ["pipe", "pipe", "pipe"],
    });
    commit(repo, "bad name");
    const identity = await resolveCheckout(repo);

    const snapshot = await captureSnapshot(identity, {});
    expect(snapshot.excluded["invalid-utf8-name"]).toBe(1);
    expect([...snapshot.files.keys()]).toEqual(["keep.ts"]);
  });

  test("never enumerates ignored or untracked files", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    track(repo, ".gitignore", "ignored.txt\n");
    track(repo, "tracked.ts", "export const tracked = 1;\n");
    commitAll(repo);
    writeFileSync(join(repo, "untracked.ts"), "export const untracked = 1;\n");
    writeFileSync(join(repo, "ignored.txt"), "ignored\n");
    const identity = await resolveCheckout(repo);

    const snapshot = await captureSnapshot(identity, {});
    expect(snapshot.files.has("tracked.ts")).toBe(true);
    expect(snapshot.files.has("untracked.ts")).toBe(false);
    expect(snapshot.files.has("ignored.txt")).toBe(false);
  });

  test("rejects low budgets and refuses raised ceilings", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    track(repo, "a.ts", "a".repeat(200));
    track(repo, "b.ts", "b".repeat(200));
    track(repo, "c.ts", "c".repeat(200));
    commitAll(repo);
    const identity = await resolveCheckout(repo);

    expect((await captureFailure(captureSnapshot(identity, { maxFiles: 2 })))?.code).toBe(
      "budget-exceeded",
    );
    expect(
      (await captureFailure(captureSnapshot(identity, { maxBytesPerFile: 10 })))?.code,
    ).toBe("budget-exceeded");
    expect(
      (await captureFailure(captureSnapshot(identity, { maxTotalBytes: 100 })))?.code,
    ).toBe("budget-exceeded");
    expect(
      (await captureFailure(captureSnapshot(identity, { maxFiles: 0 })))?.code,
    ).toBe("budget-exceeded");
    expect(
      (await captureFailure(
        captureSnapshot(identity, { maxFiles: DEFAULT_MAX_FILES + 1 }),
      ))?.code,
    ).toBe("budget-exceeded");
    expect(
      (await captureFailure(
        captureSnapshot(identity, { maxBytesPerFile: DEFAULT_MAX_BYTES_PER_FILE + 1 }),
      ))?.code,
    ).toBe("budget-exceeded");
    expect(
      (await captureFailure(
        captureSnapshot(identity, { maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES + 1 }),
      ))?.code,
    ).toBe("budget-exceeded");
  });

  test("aborts when an eligible path disappears or becomes unreadable", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    track(repo, "keep.ts", "export const keep = 1;\n");
    track(repo, "vanish.ts", "export const vanish = 1;\n");
    commitAll(repo);
    const identity = await resolveCheckout(repo);

    const vanished = await captureFailure(
      captureSnapshot(identity, {
        beforeOpen: (absolute) => {
          if (absolute.endsWith("vanish.ts")) rmSync(absolute, { force: true });
        },
      }),
    );
    expect(vanished?.code).toBe("source-raced");

    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const locked = join(repo, "keep.ts");
      chmodSync(locked, 0o000);
      const unreadable = await captureFailure(captureSnapshot(identity, {}));
      chmodSync(locked, 0o600);
      expect(unreadable?.code).toBe("source-raced");
    }
  });

  test("readEligibleFile returns the same exact bytes and hash", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    const content = "const exact = 'bytes';\n";
    track(repo, "exact.ts", content);
    commitAll(repo);
    const identity = await resolveCheckout(repo);

    const captured = await readEligibleFile(identity, "exact.ts");
    expect(Buffer.from(captured.bytes).toString("utf8")).toBe(content);
    expect(captured.sha256).toBe(sha256(Buffer.from(content, "utf8")));
    await expect(readEligibleFile(identity, "../escape.ts")).rejects.toThrow();
  });

  test("readEligibleFile treats tracked pathspec characters literally", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    const literalContent = "export const literal = true;\n";
    track(repo, "literal-*.ts", literalContent);
    track(repo, "literal-match.ts", "export const match = true;\n");
    commitAll(repo);
    const identity = await resolveCheckout(repo);

    const captured = await readEligibleFile(identity, "literal-*.ts");
    expect(captured.path).toBe("literal-*.ts");
    expect(captured.sha256).toBe(sha256(Buffer.from(literalContent, "utf8")));
  });

  test("readEligibleFile refuses an untracked ordinary file", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    track(repo, "tracked.ts", "export const tracked = true;\n");
    commitAll(repo);
    track(repo, "untracked.ts", "export const untracked = true;\n");
    const identity = await resolveCheckout(repo);

    await expect(readEligibleFile(identity, "untracked.ts")).rejects.toThrow();
  });

  test("readEligibleFile refuses a retained file removed from the index", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    const content = "export const formerlyTracked = true;\n";
    track(repo, "removed.ts", content);
    commitAll(repo);
    const identity = await resolveCheckout(repo);
    const indexed = await readEligibleFile(identity, "removed.ts");
    expect(indexed.sha256).toBe(sha256(Buffer.from(content, "utf8")));

    git(repo, "rm", "--cached", "--", "removed.ts");
    expect(Buffer.from(indexed.bytes).toString("utf8")).toBe(content);
    await expect(readEligibleFile(identity, "removed.ts")).rejects.toThrow();
  });

  test("treats a regular file replaced by an out-of-root symlink as a source race", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    track(repo, "swap.ts", "inside bytes\n");
    commitAll(repo);
    const identity = await resolveCheckout(repo);

    const outside = join(base, "outside-final.txt");
    writeFileSync(outside, "outside bytes\n");
    const swapped = await captureFailure(
      captureSnapshot(identity, {
        beforeOpen: (absolute) => {
          if (absolute.endsWith("swap.ts")) {
            rmSync(absolute, { force: true });
            symlinkSync(outside, absolute, "file");
          }
        },
      }),
    );
    expect(swapped?.code).toBe("source-raced");
  });

  test("discards outside bytes when a validated ancestor becomes a symlink", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    track(repo, "src/data.ts", "inside bytes\n");
    commitAll(repo);
    const identity = await resolveCheckout(repo);

    // The outside directory mirrors the relative path with identical bytes so
    // a path-following reader would silently substitute outside content.
    const outsideDir = join(base, "outside-dir");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "data.ts"), "inside bytes\n");

    const swapped = await captureFailure(
      captureSnapshot(identity, {
        beforeOpen: (absolute) => {
          if (absolute.endsWith("src/data.ts")) {
            const srcDir = join(repo, "src");
            rmSync(srcDir, { recursive: true, force: true });
            symlinkSync(outsideDir, srcDir, "dir");
          }
        },
      }),
    );
    expect(swapped?.code).toBe("source-raced");
  });

  test("chunk input comes from the captured buffer, not a later path read", async () => {
    const base = makeTempRoot();
    const repo = makeEligibleRepo(base);
    const capturedSource = [
      "export function capturedOne() {",
      "  return 1;",
      "}",
      "",
      "export function capturedTwo() {",
      "  return 2;",
      "}",
      "",
    ].join("\n");
    track(repo, "sample.ts", capturedSource);
    commitAll(repo);
    const identity = await resolveCheckout(repo);

    const snapshot = await captureSnapshot(identity, {});
    const captured = snapshot.files.get("sample.ts");
    expect(captured).toBeDefined();
    const capturedBuffer = Buffer.from(captured?.bytes ?? Buffer.alloc(0));

    // Mutate the working tree after capture; only the retained buffer feeds
    // chunking, so the later path bytes must never appear in emitted content.
    writeFileSync(join(repo, "sample.ts"), "export const MUTATED = true;\n");

    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(capturedBuffer);
    const chunks = await chunkFile({
      path: "sample.ts",
      content: decoded,
      strategy: routeStrategy("sample.ts"),
      language: languageForPath("sample.ts"),
    });
    expect(chunks.length).toBeGreaterThan(0);
    const joined = chunks.map((chunk) => chunk.content).join("\n");
    expect(joined).toContain("capturedOne");
    expect(joined).toContain("capturedTwo");
    expect(joined).not.toContain("MUTATED");
  });
});
