// Versioned safe tracked-source snapshot contract.
//
// This module is the sole owner of eligible working-tree bytes. It enumerates
// tracked paths with a bounded argv-only Git child, applies the versioned
// policy, and reads regular files through no-follow descriptors while checking
// root/ancestor/file identity before and after. identity.mjs remains the sole
// identity owner; callers pass a resolved CheckoutIdentity in.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const SOURCE_POLICY_VERSION = "tracked-source-v1" as const;

export const DEFAULT_MAX_BYTES_PER_FILE = 512 * 1024;
export const DEFAULT_MAX_FILES = 50_000;
export const DEFAULT_MAX_TOTAL_BYTES = 250 * 1024 * 1024;
export const ENUMERATION_STDOUT_LIMIT = 16 * 1024 * 1024;

const GIT_TIMEOUT_MS = 5000;
const READ_CHUNK_BYTES = 64 * 1024;

export type CheckoutIdentity = {
  repoKey: string;
  checkoutKey: string;
  root: string;
  commonDir: string;
  gitDir: string;
  head: string | null;
  primary: boolean;
};

export type CapturedFile = { path: string; bytes: Buffer; sha256: string };

export type SnapshotLimits = {
  maxBytesPerFile?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  /** Optional boundary hook used only to synchronize a real mutation before open. */
  beforeOpen?: (absolutePath: string) => void | Promise<void>;
};

export type Snapshot = {
  identity: CheckoutIdentity;
  observedAt: string;
  digest: string;
  files: Map<string, CapturedFile>;
  policyVersion: typeof SOURCE_POLICY_VERSION;
  excluded: Record<string, number>;
  sourceBytes: number;
};

export type SourceErrorCode =
  | "source-raced"
  | "budget-exceeded"
  | "source-unavailable";

export class SourceCaptureError extends Error {
  code: SourceErrorCode;
  constructor(code: SourceErrorCode, message: string) {
    super(message);
    this.name = "SourceCaptureError";
    this.code = code;
  }
}

type EffectiveLimits = {
  maxBytesPerFile: number;
  maxFiles: number;
  maxTotalBytes: number;
  beforeOpen?: (absolutePath: string) => void | Promise<void>;
};

// Directory names that never contribute bounded eligible source.
const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "vendor",
  "build",
  "dist",
  "coverage",
  "generated",
  ".restory",
  ".specs",
  ".ssh",
]);

// Secret/key material by extension. `.key` is also a binary extension, but the
// exclusion reason stays secret-bearing here.
const SECRET_EXTENSIONS: ReadonlySet<string> = new Set([
  "pem",
  "key",
  "p12",
  "pfx",
]);

// Source binary extensions preserved from the Restory walk owner.
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "tiff",
  "mp3",
  "mp4",
  "mov",
  "wav",
  "flac",
  "ogg",
  "pdf",
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "onnx",
  "bin",
  "exe",
  "dll",
  "so",
  "dylib",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  "psd",
  "ai",
  "sketch",
  "fig",
  "numbers",
  "pages",
  "class",
  "jar",
  "war",
]);

// JS/TS-family test/spec suffix exclusion preserved from the build owner.
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

export type ExclusionReason =
  | "invalid-path"
  | "invalid-utf8-name"
  | "excluded-directory"
  | "excluded-secret"
  | "excluded-binary-extension"
  | "excluded-test"
  | "excluded-symlink"
  | "excluded-nonregular"
  | "content-binary"
  | "content-not-utf8";

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function extensionOf(base: string): string {
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function isSecretName(base: string): boolean {
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === ".npmrc" || base === ".netrc" || base === ".pypirc") return true;
  if (base === "credentials" || base.startsWith("credentials.")) return true;
  if (base === "id_rsa" || base === "id_ed25519") return true;
  return false;
}

function classifyPath(relPath: string): ExclusionReason | null {
  if (relPath.length === 0 || relPath.includes("\0") || isAbsolute(relPath)) {
    return "invalid-path";
  }
  const segments = relPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "invalid-path";
  }
  for (const segment of segments) {
    if (EXCLUDED_DIRECTORIES.has(segment)) return "excluded-directory";
  }
  const base = segments[segments.length - 1];
  if (isSecretName(base)) return "excluded-secret";
  const extension = extensionOf(base);
  if (SECRET_EXTENSIONS.has(extension)) return "excluded-secret";
  if (TEST_FILE_PATTERN.test(relPath)) return "excluded-test";
  if (BINARY_EXTENSIONS.has(extension)) return "excluded-binary-extension";
  return null;
}

function classifyContent(bytes: Buffer): "content-binary" | "content-not-utf8" | null {
  if (bytes.includes(0)) return "content-binary";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return null;
  } catch {
    return "content-not-utf8";
  }
}

function countExcluded(excluded: Record<string, number>, reason: ExclusionReason): void {
  excluded[reason] = (excluded[reason] ?? 0) + 1;
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  ceiling: number,
  label: string,
): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new SourceCaptureError("budget-exceeded", `${label} must be a positive integer`);
  }
  if (resolved > ceiling) {
    throw new SourceCaptureError(
      "budget-exceeded",
      `${label} cannot exceed the ${ceiling} hard ceiling`,
    );
  }
  return resolved;
}

function resolveLimits(limits: SnapshotLimits): EffectiveLimits {
  return {
    maxBytesPerFile: positiveLimit(
      limits.maxBytesPerFile,
      DEFAULT_MAX_BYTES_PER_FILE,
      DEFAULT_MAX_BYTES_PER_FILE,
      "maxBytesPerFile",
    ),
    maxFiles: positiveLimit(
      limits.maxFiles,
      DEFAULT_MAX_FILES,
      DEFAULT_MAX_FILES,
      "maxFiles",
    ),
    maxTotalBytes: positiveLimit(
      limits.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      DEFAULT_MAX_TOTAL_BYTES,
      "maxTotalBytes",
    ),
    beforeOpen: limits.beforeOpen,
  };
}

function assertIdentity(identity: CheckoutIdentity | undefined): asserts identity is CheckoutIdentity {
  if (
    !identity ||
    typeof identity.root !== "string" ||
    identity.root.length === 0 ||
    typeof identity.checkoutKey !== "string"
  ) {
    throw new SourceCaptureError(
      "source-unavailable",
      "a resolved checkout identity is required",
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("source capture aborted");
    error.name = "AbortError";
    throw error;
  }
}

type EnumerationOptions = {
  excluded: Record<string, number>;
  maxFiles: number;
};

// Streams `git ls-files -z` records as they arrive. Each NUL-terminated raw
// record is strict-decoded, deduplicated and policy-classified, and the
// eligible-count ceiling is enforced incrementally. On abort, timeout, the
// 16 MiB byte cap or the count cap the owned child is killed and its close is
// awaited before rejecting. A normal exit with a partial trailing record is
// malformed output. Whitespace and newlines inside records are preserved.
async function enumerateTrackedPaths(
  root: string,
  signal: AbortSignal | undefined,
  options: EnumerationOptions,
): Promise<string[]> {
  const { excluded, maxFiles } = options;
  return new Promise<string[]>((resolveEnum, rejectEnum) => {
    let child;
    try {
      child = spawn(
        "git",
        ["-c", "core.fsmonitor=false", "-C", root, "ls-files", "-z"],
        {
          env: {
            ...process.env,
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (error) {
      rejectEnum(
        new SourceCaptureError(
          "source-unavailable",
          `git ls-files failed to start: ${(error as Error).message}`,
        ),
      );
      return;
    }

    let stderr = "";
    let totalBytes = 0;
    let pending: Buffer = Buffer.alloc(0);
    let settled = false;
    let stopReason: Error | null = null;
    const seen = new Set<string>();
    const eligible: string[] = [];

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const requestStop = (error: Error): void => {
      if (settled || stopReason) return;
      stopReason = error;
      child.kill("SIGKILL");
    };
    const countRecord = (record: Buffer): void => {
      if (record.length === 0) return;
      let relPath: string;
      try {
        relPath = new TextDecoder("utf-8", { fatal: true }).decode(record);
      } catch {
        countExcluded(excluded, "invalid-utf8-name");
        return;
      }
      if (seen.has(relPath)) return;
      seen.add(relPath);
      const reason = classifyPath(relPath);
      if (reason !== null) {
        countExcluded(excluded, reason);
        return;
      }
      eligible.push(relPath);
      if (eligible.length > maxFiles) {
        requestStop(
          new SourceCaptureError(
            "budget-exceeded",
            `eligible file count ${eligible.length} exceeds limit ${maxFiles}`,
          ),
        );
      }
    };
    const onAbort = (): void => {
      const error = new Error("source capture aborted");
      error.name = "AbortError";
      requestStop(error);
    };
    const timer = setTimeout(() => {
      requestStop(
        new SourceCaptureError("source-unavailable", "git ls-files timed out"),
      );
    }, GIT_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || stopReason) return;
      totalBytes += chunk.length;
      if (totalBytes > ENUMERATION_STDOUT_LIMIT) {
        requestStop(
          new SourceCaptureError(
            "budget-exceeded",
            "git ls-files output exceeds 16 MiB",
          ),
        );
        return;
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let start = 0;
      for (let index = 0; index < pending.length; index += 1) {
        if (pending[index] !== 0) continue;
        countRecord(pending.subarray(start, index));
        start = index + 1;
        if (stopReason) break;
      }
      pending =
        start >= pending.length
          ? Buffer.alloc(0)
          : Buffer.from(pending.subarray(start));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000);
    });
    child.on("error", (error) => {
      finish(() =>
        rejectEnum(
          new SourceCaptureError(
            "source-unavailable",
            `git ls-files failed: ${error.message}`,
          ),
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      if (stopReason) {
        finish(() => rejectEnum(stopReason as Error));
        return;
      }
      if (code !== 0) {
        finish(() =>
          rejectEnum(
            new SourceCaptureError(
              "source-unavailable",
              `git ls-files exited ${code}: ${stderr.trim()}`,
            ),
          ),
        );
        return;
      }
      if (pending.length > 0) {
        finish(() =>
          rejectEnum(
            new SourceCaptureError(
              "source-unavailable",
              "git ls-files emitted an unterminated record",
            ),
          ),
        );
        return;
      }
      finish(() => resolveEnum(eligible));
    });
  });
}

type ReadResult = CapturedFile | { excluded: ExclusionReason };

type AncestorIdentity = { path: string; dev: number | bigint; ino: number | bigint };

async function readEligibleBytes(
  identity: CheckoutIdentity,
  relPath: string,
  limits: EffectiveLimits,
  signal: AbortSignal | undefined,
): Promise<ReadResult> {
  const root = identity.root;
  throwIfAborted(signal);

  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch {
    throw new SourceCaptureError("source-raced", "checkout root is unavailable");
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new SourceCaptureError(
      "source-raced",
      "checkout root is not a stable directory",
    );
  }

  const segments = relPath.split("/");
  const ancestors: AncestorIdentity[] = [
    { path: root, dev: rootInfo.dev, ino: rootInfo.ino },
  ];
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch {
      throw new SourceCaptureError(
        "source-raced",
        `source ancestor disappeared: ${relPath}`,
      );
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SourceCaptureError(
        "source-raced",
        `source ancestor is not a stable directory: ${relPath}`,
      );
    }
    ancestors.push({ path: current, dev: info.dev, ino: info.ino });
  }

  const absolute = join(root, relPath);
  let before;
  try {
    before = await lstat(absolute);
  } catch {
    throw new SourceCaptureError(
      "source-raced",
      `eligible source disappeared: ${relPath}`,
    );
  }
  if (before.isSymbolicLink()) return { excluded: "excluded-symlink" };
  if (!before.isFile()) return { excluded: "excluded-nonregular" };
  if (before.size > limits.maxBytesPerFile) {
    throw new SourceCaptureError(
      "budget-exceeded",
      `source file exceeds per-file limit: ${relPath}`,
    );
  }

  if (limits.beforeOpen) await limits.beforeOpen(absolute);

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(absolute, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      // A regular file validated before the boundary became a symlink; this is
      // a race, not a pre-existing symlink policy exclusion.
      throw new SourceCaptureError(
        "source-raced",
        `eligible source changed to a symlink at open: ${relPath}`,
      );
    }
    throw new SourceCaptureError(
      "source-raced",
      `eligible source could not be opened: ${relPath}`,
    );
  }

  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new SourceCaptureError(
        "source-raced",
        `eligible source changed before read: ${relPath}`,
      );
    }

    const chunks: Buffer[] = [];
    let read = 0;
    const cap = limits.maxBytesPerFile + 1;
    while (read < cap) {
      const size = Math.min(READ_CHUNK_BYTES, cap - read);
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(buffer, 0, size, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      read += bytesRead;
    }
    if (read > limits.maxBytesPerFile) {
      throw new SourceCaptureError(
        "budget-exceeded",
        `source file exceeds per-file limit: ${relPath}`,
      );
    }

    let after;
    try {
      after = await lstat(absolute);
    } catch {
      throw new SourceCaptureError(
        "source-raced",
        `eligible source disappeared during read: ${relPath}`,
      );
    }
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new SourceCaptureError(
        "source-raced",
        `eligible source changed during read: ${relPath}`,
      );
    }
    for (const ancestor of ancestors) {
      let info;
      try {
        info = await lstat(ancestor.path);
      } catch {
        throw new SourceCaptureError(
          "source-raced",
          `source ancestor disappeared: ${relPath}`,
        );
      }
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        info.dev !== ancestor.dev ||
        info.ino !== ancestor.ino
      ) {
        throw new SourceCaptureError(
          "source-raced",
          `source ancestor changed during read: ${relPath}`,
        );
      }
    }

    const bytes = Buffer.concat(chunks);
    return { path: relPath, bytes, sha256: sha256Hex(bytes) };
  } finally {
    await handle.close();
  }
}

function computeDigest(files: Map<string, CapturedFile>): string {
  const rows: Array<[string, string, number]> = [];
  for (const file of files.values()) {
    rows.push([file.path, file.sha256, file.bytes.length]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(JSON.stringify([SOURCE_POLICY_VERSION, rows]));
}

/** Read exactly the eligible bytes of one path under the default per-file ceiling. */
export async function readEligibleFile(
  identity: CheckoutIdentity,
  relPath: string,
  signal?: AbortSignal,
): Promise<CapturedFile> {
  assertIdentity(identity);
  const reason = classifyPath(relPath);
  if (reason !== null) {
    throw new SourceCaptureError(
      "source-unavailable",
      `path is not eligible: ${relPath}`,
    );
  }
  throwIfAborted(signal);
  const result = await readEligibleBytes(
    identity,
    relPath,
    { maxBytesPerFile: DEFAULT_MAX_BYTES_PER_FILE, maxFiles: DEFAULT_MAX_FILES, maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES },
    signal,
  );
  if ("excluded" in result) {
    throw new SourceCaptureError(
      "source-raced",
      `source is not a readable regular file: ${relPath}`,
    );
  }
  const contentReason = classifyContent(result.bytes);
  if (contentReason !== null) {
    throw new SourceCaptureError(
      "source-unavailable",
      `source content is not eligible: ${relPath}`,
    );
  }
  return result;
}

/** Capture a sorted, hashed, policy-counted snapshot of eligible tracked bytes. */
export async function captureSnapshot(
  identity: CheckoutIdentity,
  limits: SnapshotLimits = {},
  signal?: AbortSignal,
): Promise<Snapshot> {
  assertIdentity(identity);
  const effective = resolveLimits(limits);
  throwIfAborted(signal);

  const excluded: Record<string, number> = {};
  const eligible = await enumerateTrackedPaths(identity.root, signal, {
    excluded,
    maxFiles: effective.maxFiles,
  });
  eligible.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const files = new Map<string, CapturedFile>();
  let sourceBytes = 0;
  for (const relPath of eligible) {
    throwIfAborted(signal);
    const result = await readEligibleBytes(identity, relPath, effective, signal);
    if ("excluded" in result) {
      countExcluded(excluded, result.excluded);
      continue;
    }
    const contentReason = classifyContent(result.bytes);
    if (contentReason !== null) {
      countExcluded(excluded, contentReason);
      continue;
    }
    sourceBytes += result.bytes.length;
    if (sourceBytes > effective.maxTotalBytes) {
      throw new SourceCaptureError(
        "budget-exceeded",
        `captured source bytes ${sourceBytes} exceeds limit ${effective.maxTotalBytes}`,
      );
    }
    files.set(relPath, result);
  }

  return {
    identity,
    observedAt: new Date().toISOString(),
    digest: computeDigest(files),
    files,
    policyVersion: SOURCE_POLICY_VERSION,
    excluded,
    sourceBytes,
  };
}
