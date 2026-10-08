// Step 6 Node client: preflight, command grammar, owned Bun child spawn and
// settlement, and structured receipts. Node standard library only; never
// imports Bun/TS or Pi runtime code.

import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkoutStatePath,
  enrollmentPath,
  resolveCheckout,
  resolveStateRoot,
} from "./identity.mjs";

const CEILINGS_MS = {
  status: 10000,
  check: 120000,
  build: 1800000,
  update: 1800000,
  reindex: 1800000,
  search: 120000,
  configure: 10000,
  "configure-model": 60000,
  forget: 10000,
  prune: 30000,
  recover: 10000,
};

const COMMAND_OPTIONS = {
  status: ["root", "state", "timeoutMs"],
  check: ["root", "state", "timeoutMs"],
  build: ["root", "state", "models", "timeoutMs"],
  update: ["root", "state", "models", "timeoutMs"],
  reindex: ["root", "state", "models", "timeoutMs"],
  search: ["root", "query", "mode", "limit", "state", "models", "timeoutMs"],
  configure: ["root", "state", "timeoutMs", "specUse"],
  forget: ["root", "state", "timeoutMs"],
  prune: ["state", "timeoutMs"],
  recover: ["state", "timeoutMs", "operation"],
  "configure-model": ["state", "models", "modelAssets", "timeoutMs"],
};

const TRANSPORT_OPTIONS = new Set(["packageDir", "bunPath", "spawn", "rssSampler", "signal"]);
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_CHILD_RSS_BYTES = 2 * 1024 * 1024 * 1024;
const RSS_SAMPLE_INTERVAL_MS = 1000;
const RSS_SAMPLE_TIMEOUT_MS = 2000;
const SETTLE_GRACE_MS = 2000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function usageReceipt(command, message) {
  return {
    version: 1,
    command,
    status: "failed",
    reason: "usage",
    exitCode: 2,
    message,
  };
}

function unavailableReceipt(command, reason) {
  return {
    version: 1,
    command,
    status: "unavailable",
    reason,
    exitCode: 3,
  };
}

export function validateCommandOptions(command, options) {
  if (typeof command !== "string" || !Object.prototype.hasOwnProperty.call(COMMAND_OPTIONS, command)) {
    return { ok: false, message: `Unknown command: ${String(command)}` };
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return { ok: false, message: "Options must be an object." };
  }
  const allowed = new Set(COMMAND_OPTIONS[command]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key) && !TRANSPORT_OPTIONS.has(key)) {
      return { ok: false, message: `Unknown option for ${command}: ${key}` };
    }
    if (options[key] === undefined) continue;
    if (TRANSPORT_OPTIONS.has(key)) continue;
    if (key === "timeoutMs") {
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
        return { ok: false, message: "timeoutMs must be a positive integer." };
      }
      if (options.timeoutMs > CEILINGS_MS[command]) {
        return {
          ok: false,
          message: `timeoutMs exceeds the ${command} ceiling of ${CEILINGS_MS[command]}ms.`,
        };
      }
      continue;
    }
    if (key === "specUse") {
      if (typeof options.specUse !== "boolean") {
        return { ok: false, message: "specUse must be a boolean." };
      }
      continue;
    }
    if (key === "mode") {
      if (options.mode !== "vector" && options.mode !== "bm25") {
        return { ok: false, message: "mode must be vector or bm25." };
      }
      continue;
    }
    if (key === "limit") {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 20) {
        return { ok: false, message: "limit must be an integer 1..20." };
      }
      continue;
    }
    if (key === "query") {
      const codePoints = typeof options.query === "string" ? [...options.query].length : 0;
      if (codePoints === 0 || codePoints > 2000) {
        return { ok: false, message: "query must be 1..2000 Unicode code points." };
      }
      continue;
    }
    if (key === "modelAssets") {
      if (!Array.isArray(options.modelAssets)) {
        return { ok: false, message: "modelAssets must be an array." };
      }
      continue;
    }
    if (typeof options[key] !== "string" || options[key].length === 0) {
      return { ok: false, message: `${key} must be a non-empty string.` };
    }
  }

  if (allowed.has("root") && typeof options.root !== "string") {
    return { ok: false, message: `${command} requires --root.` };
  }
  if (
    ["build", "update", "reindex"].includes(command) &&
    typeof options.models !== "string"
  ) {
    return { ok: false, message: `${command} requires --models.` };
  }
  if (allowed.has("specUse") && typeof options.specUse !== "boolean") {
    return { ok: false, message: "configure requires --spec-use on|off." };
  }
  if (allowed.has("operation") && typeof options.operation !== "string") {
    return { ok: false, message: "recover requires --operation." };
  }
  if (command === "search" && typeof options.query !== "string") {
    return { ok: false, message: "search requires query." };
  }
  return { ok: true };
}

function defaultPackageDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function resolveBun(override) {
  if (override !== undefined) {
    if (typeof override !== "string" || override.length === 0) return null;
    try {
      accessSync(override, constants.X_OK);
      return override;
    } catch {
      return null;
    }
  }
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "bun");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // continue scanning
    }
  }
  return null;
}

export function resolveBunPath(override) {
  return resolveBun(override);
}

// Commands that consume model assets and may fall back to the saved setting.
const MODEL_SETTINGS_COMMANDS = new Set(["build", "update", "reindex", "search"]);
const MAX_SETTINGS_BYTES = 64 * 1024;

// Read the selected state root's saved model root (written by the worker's
// configure-model route). An explicit --models is resolved by the caller before
// this helper runs, so the saved record is only a fallback. The record is
// operator-owned derived state: read it without following links and treat any
// unreadable or malformed record as absent, leaving the command's own usage or
// model-unavailable outcome in charge.
function readConfiguredModelsRoot(stateRoot) {
  const settingsPath = join(resolveStateRoot(stateRoot), "settings.json");
  let info;
  try {
    info = lstatSync(settingsPath);
  } catch {
    return null;
  }
  if (info.isSymbolicLink() || !info.isFile()) return null;
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) return null;
  if ((info.mode & 0o077) !== 0) return null;
  if (info.size > MAX_SETTINGS_BYTES) return null;

  let fd = null;
  try {
    fd = openSync(settingsPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptor = fstatSync(fd);
    if (
      !descriptor.isFile() ||
      descriptor.dev !== info.dev ||
      descriptor.ino !== info.ino ||
      descriptor.size > MAX_SETTINGS_BYTES
    ) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(fd, "utf8"));
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    if (
      !record ||
      record.version !== 1 ||
      typeof record.modelsRoot !== "string" ||
      record.modelsRoot.length === 0
    ) {
      return null;
    }
    return record.modelsRoot;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}

function defaultSampleChildRss(pid) {
  if (process.platform === "linux") {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (!match) return null;
      return Number.parseInt(match[1], 10) * 1024;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const output = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: RSS_SAMPLE_TIMEOUT_MS,
        windowsHide: true,
      });
      const kib = Number.parseInt(output.trim(), 10);
      return Number.isFinite(kib) ? kib * 1024 : null;
    } catch {
      return null;
    }
  }
  return null;
}

const REQUIRED_DEPENDENCIES = [
  "@huggingface/transformers",
  "@msgpack/msgpack",
  "@orama/orama",
  "code-chunk",
];

function hasDependencies(packageDir) {
  return REQUIRED_DEPENDENCIES.every((dependency) =>
    existsSync(join(packageDir, "node_modules", dependency)),
  );
}

function buildRequest(command, options) {
  const request = { version: 1, command };
  if (options.root !== undefined) request.root = resolve(options.root);
  if (options.state !== undefined) request.state = resolve(options.state);
  if (options.models !== undefined) request.models = resolve(options.models);
  if (options.timeoutMs !== undefined) request.timeoutMs = options.timeoutMs;
  if (options.specUse !== undefined) request.specUse = options.specUse;
  if (options.operation !== undefined) request.operation = options.operation;
  if (options.query !== undefined) request.query = options.query;
  if (options.mode !== undefined) request.mode = options.mode;
  if (options.limit !== undefined) request.limit = options.limit;
  if (options.modelAssets !== undefined) request.modelAssets = options.modelAssets;
  return request;
}

function lastNonEmptyLine(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.length > 0) return line;
  }
  return "";
}

function boundedExcerpt(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 512 ? `${compact.slice(0, 512)}...` : compact;
}

async function settleOwnedGroup(child) {
  if (!child || typeof child.pid !== "number" || child.pid <= 0) return;
  const signalGroup = (signal) => {
    try { process.kill(-child.pid, signal); return true; }
    catch (error) {
      if (error?.code === "ESRCH") return false;
      throw new Error(`failed to settle owned process group ${child.pid}: ${errorMessage(error)}`);
    }
  };
  // A direct-child close says nothing about descendants retaining this group.
  if (!signalGroup("SIGTERM")) return;
  const escalationAt = Date.now() + SETTLE_GRACE_MS;
  const deadline = escalationAt + SETTLE_GRACE_MS;
  let escalated = false;
  while (signalGroup(0)) {
    if (Date.now() >= deadline) throw new Error(`owned process group ${child.pid} did not settle`);
    if (!escalated && Date.now() >= escalationAt) {
      if (!signalGroup("SIGKILL")) return;
      escalated = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function beginCapture(target, maxOutputBytes) {
  let text = "";
  let bytes = 0;
  const onData = (chunk) => {
    if (bytes >= maxOutputBytes) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const slice = buffer.subarray(0, maxOutputBytes - bytes);
    text += slice.toString("utf8");
    bytes += slice.length;
  };
  return { onData, read: () => text };
}

/**
 * Spawn one owned child and settle its process group on timeout/abort, mirroring
 * runCommand's detached-group semantics. Used by setup.mjs for the package
 * manager and by any caller that needs the same containment without the worker
 * JSON contract. Returns `{complete:true, code, stdout, stderr}` on close, or
 * `{complete:false, reason, exitCode, stdout, stderr, message?}` when the child
 * could not complete/clean up.
 */
export async function runOwnedProcess(spawnImpl, file, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 600000,
    signal,
    maxOutputBytes = MAX_STDOUT_BYTES,
  } = options;

  if (signal?.aborted || timeoutMs <= 0) return {
    complete: false, reason: signal?.aborted ? "canceled" : "timeout",
    exitCode: signal?.aborted ? 130 : 124, stdout: "", stderr: "",
  };
  let child;
  try {
    child = spawnImpl(file, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
  } catch (error) {
    return {
      complete: false,
      reason: "spawn-failed",
      exitCode: 1,
      stdout: "",
      stderr: "",
      message: errorMessage(error),
    };
  }

  const stdout = beginCapture("stdout", maxOutputBytes);
  const stderr = beginCapture("stderr", maxOutputBytes);
  if (child.stdout && typeof child.stdout.on === "function") {
    child.stdout.on("data", stdout.onData);
  }
  if (child.stderr && typeof child.stderr.on === "function") {
    child.stderr.on("data", stderr.onData);
  }

  let timer = null;
  let abortListener = null;
  const outcome = await new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      resolve(result);
    };
    timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    child.once("close", (code) => finish({ kind: "closed", code }));
    child.once("error", (error) => finish({ kind: "error", error }));
    if (signal) {
      if (signal.aborted) {
        finish({ kind: "abort" });
        return;
      }
      abortListener = () => finish({ kind: "abort" });
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });

  if (outcome.kind === "timeout" || outcome.kind === "abort") {
    try {
      await settleOwnedGroup(child);
    } catch (error) {
      return {
        complete: false,
        reason: "cleanup-failed",
        exitCode: 1,
        stdout: stdout.read(),
        stderr: stderr.read(),
        message: errorMessage(error),
      };
    }
    return {
      complete: false,
      reason: outcome.kind === "timeout" ? "timeout" : "canceled",
      exitCode: outcome.kind === "timeout" ? 124 : 130,
      stdout: stdout.read(),
      stderr: stderr.read(),
    };
  }
  if (outcome.kind === "error") {
    return {
      complete: false,
      reason: "process-error",
      exitCode: 1,
      stdout: stdout.read(),
      stderr: stderr.read(),
      message: errorMessage(outcome.error),
    };
  }
  return {
    complete: true,
    code: outcome.code ?? 1,
    stdout: stdout.read(),
    stderr: stderr.read(),
  };
}

function mapWorkerExit(code, parsed) {
  if (code === 0) return 0;
  if (code === 2) return 2;
  if (code === 3) return 3;
  if (code === 124) return 124;
  if (code === 130) return 130;
  if (typeof code === "number" && code > 0) return 1;
  return parsed && parsed.status === "ok" ? 0 : 1;
}

function interruptionReceipt(command, signal, deadline) {
  const reason = signal?.aborted ? "canceled" : Date.now() >= deadline ? "timeout" : null;
  return reason ? { version: 1, command, status: "failed", reason, exitCode: reason === "canceled" ? 130 : 124 } : null;
}

export async function runCommand(command, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? CEILINGS_MS[command]);
  const interrupted = interruptionReceipt(command, options.signal, deadline);
  if (interrupted) return interrupted;
  // Explicit --models always wins; otherwise a configured state root supplies
  // the saved model root to the same worker request. Asset verification still
  // happens inside the worker before any model use.
  let effectiveOptions = options;
  if (options.models === undefined && MODEL_SETTINGS_COMMANDS.has(command)) {
    const savedModelsRoot = readConfiguredModelsRoot(options.state);
    if (savedModelsRoot !== null) {
      effectiveOptions = { ...options, models: savedModelsRoot };
    }
  }
  const grammar = validateCommandOptions(command, effectiveOptions);
  if (!grammar.ok) return usageReceipt(command, grammar.message);

  const packageDir = options.packageDir ?? defaultPackageDir();
  const bunPath = resolveBun(options.bunPath);
  if (!bunPath) return unavailableReceipt(command, "runtime-unavailable");
  if (!hasDependencies(packageDir)) return unavailableReceipt(command, "dependencies-unavailable");

  const preSpawnInterruption = interruptionReceipt(command, options.signal, deadline);
  if (preSpawnInterruption) return preSpawnInterruption;
  const timeoutMs = Math.max(1, deadline - Date.now());
  const request = buildRequest(command, effectiveOptions);
  const spawnImpl = options.spawn ?? spawn;
  const sampleRss = options.rssSampler ?? defaultSampleChildRss;

  let child;
  try {
    child = spawnImpl(
      bunPath,
      ["--no-install", join(packageDir, "worker.ts"), JSON.stringify(request)],
      {
        cwd: packageDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      },
    );
  } catch (error) {
    return {
      version: 1,
      command,
      status: "failed",
      reason: "worker-output",
      exitCode: 1,
      message: errorMessage(error),
    };
  }

  const stdoutChunks = [];
  let stdoutBytes = 0;
  let stdoutOverflow = false;
  if (child.stdout && typeof child.stdout.on === "function") {
    child.stdout.on("data", (chunk) => {
      if (stdoutOverflow) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = MAX_STDOUT_BYTES - stdoutBytes;
      if (remaining <= 0) {
        stdoutOverflow = true;
        return;
      }
      const slice = buffer.subarray(0, remaining);
      stdoutChunks.push(slice);
      stdoutBytes += slice.length;
      if (buffer.length > remaining) stdoutOverflow = true;
    });
  }
  if (child.stderr && typeof child.stderr.on === "function") {
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }

  let timer = null;
  let abortListener = null;
  let rssTimer = null;
  let observedRssBytes = null;
  const outcome = await new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (rssTimer) clearInterval(rssTimer);
      if (options.signal && abortListener) {
        options.signal.removeEventListener("abort", abortListener);
      }
      resolve(result);
    };
    timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    child.once("close", (code, signal) => finish({ kind: "closed", code, signal }));
    child.once("error", (error) => finish({ kind: "error", error }));
    if (options.signal) {
      if (options.signal.aborted) {
        finish({ kind: "abort" });
        return;
      }
      abortListener = () => finish({ kind: "abort" });
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
    const sample = () => {
      if (done || typeof child.pid !== "number" || child.pid <= 0) return;
      let sampled = null;
      try {
        sampled = sampleRss(child.pid);
      } catch {
        sampled = null;
      }
      if (typeof sampled !== "number" || !Number.isFinite(sampled) || sampled <= 0) return;
      if (observedRssBytes === null || sampled > observedRssBytes) observedRssBytes = sampled;
      if (sampled >= MAX_CHILD_RSS_BYTES) finish({ kind: "rss" });
    };
    rssTimer = setInterval(sample, RSS_SAMPLE_INTERVAL_MS);
    sample();
  });

  if (outcome.kind === "timeout" || outcome.kind === "abort" || outcome.kind === "rss") {
    try {
      await settleOwnedGroup(child);
    } catch (error) {
      return {
        version: 1,
        command,
        status: "failed",
        reason: "cleanup-failed",
        exitCode: 1,
        message: errorMessage(error),
      };
    }
    if (outcome.kind === "rss") {
      return {
        version: 1,
        command,
        status: "unavailable",
        reason: "budget-exceeded",
        exitCode: 3,
        message: `worker exceeded the ${MAX_CHILD_RSS_BYTES}-byte child RSS ceiling`,
        observedRssBytes,
      };
    }
    if (outcome.kind === "timeout") {
      return { version: 1, command, status: "unavailable", reason: "timeout", exitCode: 124 };
    }
    return { version: 1, command, status: "unavailable", reason: "canceled", exitCode: 130 };
  }

  if (outcome.kind === "error") {
    return {
      version: 1,
      command,
      status: "failed",
      reason: "worker-output",
      exitCode: 1,
      message: `worker process error: ${errorMessage(outcome.error)}`,
    };
  }

  if (stdoutOverflow) {
    return {
      version: 1,
      command,
      status: "failed",
      reason: "worker-output",
      exitCode: 1,
      message: "worker stdout exceeded 65536 bytes",
    };
  }

  const text = Buffer.concat(stdoutChunks).toString("utf8");
  const line = lastNonEmptyLine(text);
  let parsed = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      version: 1,
      command,
      status: "failed",
      reason: "worker-output",
      exitCode: 1,
      message: `unparsable worker output: ${boundedExcerpt(text)}`,
    };
  }

  return { ...parsed, exitCode: mapWorkerExit(outcome.code, parsed) };
}

// ---- Spec-usage preflight (Node-only, no Bun/ONNX) -------------------------

function corruptEnrollment(message) {
  const error = new Error(message);
  error.reason = "corrupt";
  return error;
}

function ownedDirectoryNode(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw corruptEnrollment(`metadata directory is unavailable: ${path}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw corruptEnrollment(`metadata path is not a stable directory: ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw corruptEnrollment(`metadata path is not owned by the current user: ${path}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw corruptEnrollment(`metadata path has group/world permissions: ${path}`);
  }
  return { path, dev: info.dev, ino: info.ino };
}

function assertDirectoryNode(identity, label) {
  let info;
  try {
    info = lstatSync(identity.path);
  } catch {
    throw corruptEnrollment(`${label} is unavailable`);
  }
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.dev !== identity.dev ||
    info.ino !== identity.ino
  ) {
    throw corruptEnrollment(`${label} changed`);
  }
}

function readEnrollmentNode(identity, stateRoot) {
  const stateBase = resolveStateRoot(stateRoot);
  const stateIdentity = ownedDirectoryNode(stateBase);
  if (!stateIdentity) return null;
  const checkoutsParent = join(stateBase, "checkouts");
  const parentIdentity = ownedDirectoryNode(checkoutsParent);
  if (!parentIdentity) return null;

  const checkoutDir = checkoutStatePath(stateBase, identity.checkoutKey);
  if (dirname(checkoutDir) !== checkoutsParent) {
    throw corruptEnrollment("checkout state path escapes the owned checkouts parent");
  }
  const dirIdentity = ownedDirectoryNode(checkoutDir);
  if (!dirIdentity) return null;

  const file = enrollmentPath(stateBase, identity.checkoutKey);
  if (dirname(file) !== checkoutDir) {
    throw corruptEnrollment("enrollment path escapes its checkout directory");
  }

  let fd = null;
  try {
    try {
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw corruptEnrollment("enrollment record is unavailable");
    }
    const descriptor = fstatSync(fd);
    if (!descriptor.isFile()) {
      throw corruptEnrollment("enrollment record is not a regular file");
    }
    if (typeof process.getuid === "function" && descriptor.uid !== process.getuid()) {
      throw corruptEnrollment("enrollment record is not owned by the current user");
    }
    if ((descriptor.mode & 0o077) !== 0) {
      throw corruptEnrollment("enrollment record has group/world permissions");
    }
    if (descriptor.size > 64 * 1024) {
      throw corruptEnrollment("enrollment record exceeds 64 KiB");
    }
    const descriptorDev = descriptor.dev;
    const descriptorIno = descriptor.ino;
    const descriptorSize = descriptor.size;
    const before = lstatSync(file);
    if (
      before.isSymbolicLink() ||
      before.dev !== descriptorDev ||
      before.ino !== descriptorIno
    ) {
      throw corruptEnrollment("enrollment record changed before read");
    }
    let raw;
    try {
      raw = readFileSync(fd, "utf8");
    } catch {
      throw corruptEnrollment("enrollment record is corrupt");
    }
    const afterDescriptor = fstatSync(fd);
    if (
      afterDescriptor.dev !== descriptorDev ||
      afterDescriptor.ino !== descriptorIno ||
      afterDescriptor.size !== descriptorSize
    ) {
      throw corruptEnrollment("enrollment record changed during read");
    }
    const after = lstatSync(file);
    if (
      after.isSymbolicLink() ||
      after.dev !== descriptorDev ||
      after.ino !== descriptorIno
    ) {
      throw corruptEnrollment("enrollment record changed during read");
    }
    assertDirectoryNode(stateIdentity, "state root");
    assertDirectoryNode(parentIdentity, "checkouts parent");
    assertDirectoryNode(dirIdentity, "checkout state directory");

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw corruptEnrollment("enrollment record is corrupt");
    }
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    const identityRecord = record && record.identity;
    if (
      !record ||
      record.version !== 1 ||
      typeof record.specUse !== "boolean" ||
      !identityRecord ||
      identityRecord.repoKey !== identity.repoKey ||
      identityRecord.checkoutKey !== identity.checkoutKey ||
      identityRecord.root !== identity.root ||
      identityRecord.commonDir !== identity.commonDir ||
      identityRecord.gitDir !== identity.gitDir ||
      identityRecord.primary !== identity.primary
    ) {
      throw corruptEnrollment("enrollment record is corrupt or mismatched");
    }
    return record;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}

async function specPreflight(root, stateRoot, budget) {
  let identity;
  try {
    identity = await resolveCheckout(root, budget);
  } catch {
    return { ok: false, reason: "invalid-root" };
  }
  try {
    const enrollment = readEnrollmentNode(identity, stateRoot);
    if (!enrollment) return { ok: false, reason: "unenrolled" };
    if (enrollment.specUse !== true) return { ok: false, reason: "disabled" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: (error && error.reason) || "corrupt" };
  }
}

/**
 * Public search entry. `usage` must be `operator` or `spec`; spec usage
 * validates enrollment locally before any Bun child is spawned.
 */
export async function searchRepository(input = {}) {
  if (input.usage !== "operator" && input.usage !== "spec") {
    return usageReceipt("search", "usage must be operator|spec");
  }
  const timeoutMs = input.timeoutMs ?? (input.usage === "spec" ? 15000 : CEILINGS_MS.search);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > CEILINGS_MS.search) return usageReceipt("search", "invalid timeoutMs");
  const deadline = Date.now() + Math.min(timeoutMs, input.usage === "spec" ? 15000 : CEILINGS_MS.search);
  const interrupted = interruptionReceipt("search", input.signal, deadline);
  if (interrupted) return interrupted;
  if (input.usage === "spec") {
    const preflight = await specPreflight(input.root, input.stateRoot, { deadline, signal: input.signal });
    const interrupted = interruptionReceipt("search", input.signal, deadline);
    if (interrupted) return interrupted;
    if (!preflight.ok) return unavailableReceipt("search", preflight.reason);
  }
  return runCommand("search", {
    root: input.root,
    query: input.query,
    mode: input.mode,
    limit: input.limit,
    state: input.stateRoot,
    models: input.modelsRoot,
    timeoutMs: Math.max(1, deadline - Date.now()),
    signal: input.signal,
  });
}
