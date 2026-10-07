// Step 6 Node client: preflight, command grammar, owned Bun child spawn and
// settlement, and structured receipts. Node standard library only; never
// imports Bun/TS or Pi runtime code.

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const CEILINGS_MS = {
  status: 10000,
  check: 120000,
  build: 1800000,
  update: 1800000,
  reindex: 1800000,
  configure: 10000,
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
  configure: ["root", "state", "timeoutMs", "specUse"],
  forget: ["root", "state", "timeoutMs"],
  prune: ["state", "timeoutMs"],
  recover: ["state", "timeoutMs", "operation"],
};

const TRANSPORT_OPTIONS = new Set(["packageDir", "bunPath", "spawn", "signal"]);
const MAX_STDOUT_BYTES = 64 * 1024;
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

function validateGrammar(command, options) {
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
    if (typeof options[key] !== "string" || options[key].length === 0) {
      return { ok: false, message: `${key} must be a non-empty string.` };
    }
  }

  if (allowed.has("root") && typeof options.root !== "string") {
    return { ok: false, message: `${command} requires --root.` };
  }
  if (allowed.has("models") && typeof options.models !== "string") {
    return { ok: false, message: `${command} requires --models.` };
  }
  if (allowed.has("specUse") && typeof options.specUse !== "boolean") {
    return { ok: false, message: "configure requires --spec-use on|off." };
  }
  if (allowed.has("operation") && typeof options.operation !== "string") {
    return { ok: false, message: "recover requires --operation." };
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

function hasDependencies(packageDir) {
  return (
    existsSync(join(packageDir, "node_modules")) &&
    existsSync(join(packageDir, "node_modules", "@orama", "orama"))
  );
}

function buildRequest(command, options) {
  const request = { version: 1, command };
  if (options.root !== undefined) request.root = options.root;
  if (options.state !== undefined) request.state = options.state;
  if (options.models !== undefined) request.models = options.models;
  if (options.timeoutMs !== undefined) request.timeoutMs = options.timeoutMs;
  if (options.specUse !== undefined) request.specUse = options.specUse;
  if (options.operation !== undefined) request.operation = options.operation;
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
  let killError = null;
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error && error.code === "ESRCH") return;
      killError = error;
      throw error;
    }
  };

  const closed = new Promise((resolve) => {
    if (child.exitCode !== undefined && child.exitCode !== null) {
      resolve();
      return;
    }
    if (typeof child.once !== "function") {
      resolve();
      return;
    }
    child.once("close", () => resolve());
  });

  killGroup("SIGTERM");
  const timer = setTimeout(() => {
    try {
      killGroup("SIGKILL");
    } catch {
      // surfaced after close (or already ESRCH)
    }
  }, SETTLE_GRACE_MS);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
  if (killError) {
    throw new Error(
      `failed to terminate owned process group ${child.pid}: ${errorMessage(killError)}`,
    );
  }
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

export async function runCommand(command, options = {}) {
  const grammar = validateGrammar(command, options);
  if (!grammar.ok) return usageReceipt(command, grammar.message);

  const packageDir = options.packageDir ?? defaultPackageDir();
  const bunPath = resolveBun(options.bunPath);
  if (!bunPath) return unavailableReceipt(command, "runtime-unavailable");
  if (!hasDependencies(packageDir)) return unavailableReceipt(command, "dependencies-unavailable");

  const timeoutMs = options.timeoutMs ?? CEILINGS_MS[command];
  const request = buildRequest(command, options);
  const spawnImpl = options.spawn ?? spawn;

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
  const outcome = await new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
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
  });

  if (outcome.kind === "timeout" || outcome.kind === "abort") {
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
