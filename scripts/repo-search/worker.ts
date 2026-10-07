// Step 6 finite Bun worker.
//
// Validates the request shape strictly before importing lifecycle/state owners,
// resolves checkout identity before opening owned state, dispatches the
// lifecycle command, and prints exactly one JSON line when run as the entry.
// All progress goes to stderr; stdout carries only the final response.

import { formatSearchJson } from "./format.mjs";

export type WorkerCommand =
  | "status"
  | "check"
  | "build"
  | "update"
  | "reindex"
  | "search"
  | "configure"
  | "configure-model"
  | "forget"
  | "prune"
  | "recover";

export type WorkerRequest = {
  version: 1;
  command: WorkerCommand;
  root?: string;
  state?: string;
  models?: string;
  timeoutMs?: number;
  specUse?: boolean;
  operation?: string;
  query?: string;
  mode?: "vector" | "bm25";
  limit?: number;
  modelAssets?: Array<{ path: string; sha256: string }>;
};

export type WorkerResponse = {
  version: 1;
  command?: string;
  status: "ok" | "unavailable" | "failed";
  reason?: string;
  repoKey?: string;
  checkoutKey?: string;
  requestedRoot?: string;
  actualRoot?: string;
  receipt?: unknown;
  message?: string;
  exitCode?: number;
};

const WORKER_COMMANDS: ReadonlySet<string> = new Set([
  "status",
  "check",
  "build",
  "update",
  "reindex",
  "search",
  "configure",
  "configure-model",
  "forget",
  "prune",
  "recover",
]);

const ALLOWED_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "version",
  "command",
  "root",
  "state",
  "models",
  "timeoutMs",
  "specUse",
  "operation",
  "query",
  "mode",
  "limit",
  "modelAssets",
]);

const ROOT_COMMANDS: ReadonlySet<string> = new Set([
  "status",
  "check",
  "build",
  "update",
  "reindex",
  "search",
  "configure",
  "forget",
]);

const MODELS_COMMANDS: ReadonlySet<string> = new Set(["build", "update", "reindex"]);

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  "unenrolled",
  "incompatible",
  "no-current",
  "base-missing",
  "base-unavailable",
  "model-unavailable",
  "busy",
  "corrupt",
  "invalid-root",
  "runtime-unavailable",
  "dependencies-unavailable",
  "disabled",
  "timeout",
  "budget-exceeded",
  "source-raced",
  "output-budget",
  "unavailable",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SQLITE_CORRUPT_CODES: ReadonlySet<string> = new Set(["SQLITE_NOTADB", "SQLITE_CORRUPT"]);
const SQLITE_BUSY_CODES: ReadonlySet<string> = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);

function normalizeReason(code: string): string {
  if (code === "enrollment-corrupt") return "corrupt";
  if (code === "enrollment-path" || code === "enrollment-unavailable") return "corrupt";
  if (code === "code-model-unavailable") return "model-unavailable";
  if (code === "code-index-unavailable") return "corrupt";
  if (code === "state-unavailable") return "corrupt";
  if (SQLITE_CORRUPT_CODES.has(code)) return "corrupt";
  if (SQLITE_BUSY_CODES.has(code)) return "busy";
  if (code === "invalid-query") return "usage";
  if (code === "disposed") return "usage";
  return code;
}

function reasonForError(error: unknown): { reason: string; message: string } {
  const message = errorMessage(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) {
    return { reason: normalizeReason(code), message };
  }
  return { reason: "failed", message };
}

function classifyWorkerError(command: string | undefined, error: unknown): WorkerResponse {
  const { reason, message } = reasonForError(error);
  const unavailable = UNAVAILABLE_REASONS.has(reason);
  return {
    version: 1,
    command,
    status: unavailable ? "unavailable" : "failed",
    reason,
    message,
  };
}

type ValidationResult =
  | { ok: true; value: WorkerRequest }
  | { ok: false; command?: string; message: string };

function validateWorkerRequest(request: unknown): ValidationResult {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return { ok: false, message: "Request must be a JSON object." };
  }
  const record = request as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command : undefined;

  for (const key of Object.keys(record)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      return { ok: false, command, message: `Unknown request field: ${key}` };
    }
  }

  if (record.version !== 1) {
    return { ok: false, command, message: "Request version must be 1." };
  }
  if (command === undefined || !WORKER_COMMANDS.has(command)) {
    return { ok: false, command, message: "Unknown or missing command." };
  }

  const stringFields = ["root", "state", "models", "operation"] as const;
  for (const field of stringFields) {
    const value = record[field];
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      return { ok: false, command, message: `${field} must be a non-empty string.` };
    }
  }
  if (
    record.timeoutMs !== undefined &&
    (!Number.isInteger(record.timeoutMs) || (record.timeoutMs as number) <= 0)
  ) {
    return { ok: false, command, message: "timeoutMs must be a positive integer." };
  }
  if (record.specUse !== undefined && typeof record.specUse !== "boolean") {
    return { ok: false, command, message: "specUse must be a boolean." };
  }
  if (record.mode !== undefined && record.mode !== "vector" && record.mode !== "bm25") {
    return { ok: false, command, message: "mode must be vector or bm25." };
  }
  if (
    record.limit !== undefined &&
    (!Number.isInteger(record.limit) || (record.limit as number) < 1 || (record.limit as number) > 20)
  ) {
    return { ok: false, command, message: "limit must be an integer 1..20." };
  }
  if (record.query !== undefined) {
    if (typeof record.query !== "string") {
      return { ok: false, command, message: "query must be a string." };
    }
    const codePoints = [...record.query].length;
    if (codePoints === 0 || codePoints > 2000) {
      return { ok: false, command, message: "query must be 1..2000 Unicode code points." };
    }
  }
  if (record.modelAssets !== undefined) {
    if (command !== "configure-model") {
      return { ok: false, command, message: "modelAssets is only valid for configure-model." };
    }
    if (!Array.isArray(record.modelAssets)) {
      return { ok: false, command, message: "modelAssets must be an array." };
    }
    for (const entry of record.modelAssets) {
      const asset = entry as Record<string, unknown> | null;
      if (
        asset === null ||
        typeof asset !== "object" ||
        Array.isArray(asset) ||
        typeof asset.path !== "string" ||
        asset.path.length === 0 ||
        typeof asset.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(asset.sha256)
      ) {
        return {
          ok: false,
          command,
          message: "modelAssets entries must be {path: non-empty string, sha256: 64 lowercase hex}.",
        };
      }
    }
  }

  if (ROOT_COMMANDS.has(command) && typeof record.root !== "string") {
    return { ok: false, command, message: `${command} requires root.` };
  }
  if (MODELS_COMMANDS.has(command) && typeof record.models !== "string") {
    return { ok: false, command, message: `${command} requires models.` };
  }
  if (command === "configure" && typeof record.specUse !== "boolean") {
    return { ok: false, command, message: "configure requires specUse." };
  }
  if (command === "recover" && typeof record.operation !== "string") {
    return { ok: false, command, message: "recover requires operation." };
  }
  if (command === "search" && typeof record.query !== "string") {
    return { ok: false, command, message: "search requires query." };
  }
  if (command === "configure-model" && typeof record.models !== "string") {
    return { ok: false, command, message: "configure-model requires models." };
  }

  return {
    ok: true,
    value: {
      version: 1,
      command: command as WorkerCommand,
      root: record.root as string | undefined,
      state: record.state as string | undefined,
      models: record.models as string | undefined,
      timeoutMs: record.timeoutMs as number | undefined,
      specUse: record.specUse as boolean | undefined,
      operation: record.operation as string | undefined,
      query: record.query as string | undefined,
      mode: record.mode as "vector" | "bm25" | undefined,
      limit: record.limit as number | undefined,
      modelAssets: record.modelAssets as Array<{ path: string; sha256: string }> | undefined,
    },
  };
}

export async function runWorker(request: unknown): Promise<WorkerResponse> {
  process.umask(0o077);

  const validation = validateWorkerRequest(request);
  if (!validation.ok) {
    return {
      version: 1,
      command: validation.command,
      status: "failed",
      reason: "usage",
      message: validation.message,
    };
  }
  const req = validation.value;

  // Engine owners load only after the request is known-valid. The search route
  // must not load lifecycle/build modules.
  let stateModule: typeof import("./state.ts");
  let identityModule: typeof import("./identity.mjs");
  try {
    stateModule = await import("./state.ts");
    identityModule = await import("./identity.mjs");
  } catch (error) {
    return classifyWorkerError(req.command, error);
  }

  if (req.command === "configure-model") {
    return runConfigureModel(req, identityModule);
  }

  if (req.command === "prune" || req.command === "recover") {
    // No identity work for state-only commands; open owned state directly.
    let state: ReturnType<typeof stateModule.openState> | null = null;
    try {
      state = stateModule.openState(req.state);
      if (req.command === "prune") {
        const receipt = await state.prune({
          maxGenerations: 100,
          deadlineMs: req.timeoutMs ?? 30_000,
        });
        return { version: 1, command: req.command, status: "ok", receipt };
      }
      const receipt = await state.recover(req.operation as string);
      return { version: 1, command: req.command, status: "ok", receipt };
    } catch (error) {
      return classifyWorkerError(req.command, error);
    } finally {
      if (state) {
        try {
          state.close();
        } catch {
          // best-effort release
        }
      }
    }
  }

  // Resolve identity before opening state so invalid roots never create state.
  let identity: Awaited<ReturnType<typeof identityModule.resolveCheckout>>;
  try {
    identity = await identityModule.resolveCheckout(req.root as string);
  } catch (error) {
    return {
      version: 1,
      command: req.command,
      status: "unavailable",
      reason: "invalid-root",
      message: errorMessage(error),
    };
  }

  let state: ReturnType<typeof stateModule.openState>;
  try {
    state = stateModule.openState(req.state);
  } catch (error) {
    return classifyWorkerError(req.command, error);
  }
  const base = {
    version: 1 as const,
    command: req.command,
    repoKey: identity.repoKey,
    checkoutKey: identity.checkoutKey,
    requestedRoot: identity.root,
    actualRoot: identity.root,
  };

  try {
    if (req.command === "search") {
      const searchModule = await import("./search.ts");
      const receipt = await searchModule.searchCheckout({
        identity,
        state,
        query: req.query as string,
        mode: req.mode,
        limit: req.limit,
        modelsRoot: req.models,
      });
      return JSON.parse(formatSearchJson({ ...base, status: "ok", receipt })) as WorkerResponse;
    }

    const lifecycle = await import("./lifecycle.ts");
    switch (req.command) {
      case "status": {
        const receipt = lifecycle.readCheckoutStatus({ identity, state });
        return { ...base, status: "ok", receipt };
      }
      case "check": {
        const receipt = await lifecycle.checkCheckout({ identity, state });
        return { ...base, status: "ok", receipt };
      }
      case "configure": {
        const receipt = lifecycle.configureSpecUse({
          identity,
          state,
          specUse: req.specUse as boolean,
        });
        return { ...base, status: "ok", receipt };
      }
      case "forget": {
        state.forgetCheckout(identity.checkoutKey);
        return {
          ...base,
          status: "ok",
          receipt: {
            version: 1,
            command: "forget",
            repoKey: identity.repoKey,
            checkoutKey: identity.checkoutKey,
          },
        };
      }
      default: {
        // build | update | reindex
        const kind = req.command as "build" | "update" | "reindex";
        const modelsRoot = req.models as string;
        let receipt: Awaited<ReturnType<typeof lifecycle.buildPrimary>>;
        if (identity.primary) {
          receipt = await lifecycle.buildPrimary({ identity, state, modelsRoot, kind });
        } else if (kind === "update") {
          receipt = await lifecycle.updateCheckout({ identity, state, modelsRoot });
        } else {
          const primaryIdentity = await identityModule.resolvePrimaryCheckout(identity);
          receipt = await lifecycle.buildWorktree({
            identity,
            state,
            modelsRoot,
            kind,
            primaryIdentity: primaryIdentity ?? undefined,
          });
        }
        return { ...base, status: "ok", receipt };
      }
    }
  } catch (error) {
    return classifyWorkerError(req.command, error);
  } finally {
    try {
      state.close();
    } catch {
      // best-effort release
    }
  }
}

async function runConfigureModel(
  req: WorkerRequest,
  identityModule: typeof import("./identity.mjs"),
): Promise<WorkerResponse> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const assets = await import("./core/codeModelAssets.ts");

  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(req.models as string);
    if (!fs.statSync(canonicalRoot).isDirectory()) {
      throw new Error("models root is not a directory");
    }
  } catch {
    return {
      version: 1,
      command: "configure-model",
      status: "unavailable",
      reason: "model-unavailable",
    };
  }

  let verified: Awaited<ReturnType<typeof assets.verifyModel>>;
  try {
    verified = await assets.verifyModel(
      canonicalRoot,
      req.modelAssets ?? assets.PINNED_CODE_MODEL_ASSETS,
    );
  } catch (error) {
    return classifyWorkerError("configure-model", error);
  }

  const stateRoot = identityModule.resolveStateRoot(req.state);
  try {
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(stateRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("state root is not a stable directory");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("state root is not owned by the current user");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error("state root has group/world permissions");
    }
  } catch (error) {
    return classifyWorkerError("configure-model", error);
  }

  const settingsPath = path.join(stateRoot, "settings.json");
  let existing: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    existing = null;
  }

  if (
    existing !== null &&
    existing.version === 1 &&
    existing.modelsRoot === canonicalRoot &&
    existing.assetDigest === verified.assetDigest
  ) {
    return {
      version: 1,
      command: "configure-model",
      status: "ok",
      receipt: {
        modelsRoot: canonicalRoot,
        assetDigest: verified.assetDigest,
        saved: false,
        alreadyConfigured: true,
      },
    };
  }

  const record = {
    version: 1,
    modelsRoot: canonicalRoot,
    assetDigest: verified.assetDigest,
    configuredAt: new Date().toISOString(),
  };
  const temp = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, settingsPath);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // best-effort temp cleanup
    }
    return classifyWorkerError("configure-model", error);
  }

  return {
    version: 1,
    command: "configure-model",
    status: "ok",
    receipt: {
      modelsRoot: canonicalRoot,
      assetDigest: verified.assetDigest,
      saved: true,
      alreadyConfigured: false,
    },
  };
}

function responseExitCode(response: WorkerResponse): number {
  if (response.reason === "usage") return 2;
  if (response.status === "ok") return 0;
  if (response.status === "unavailable") return 3;
  return 1;
}

async function main(): Promise<void> {
  process.umask(0o077);
  const raw = process.argv[2];
  let response: WorkerResponse;
  if (typeof raw !== "string" || raw.length === 0) {
    response = {
      version: 1,
      status: "failed",
      reason: "usage",
      message: "Missing request JSON argument.",
    };
  } else {
    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parseFailed = true;
    }
    if (parseFailed) {
      response = {
        version: 1,
        status: "failed",
        reason: "usage",
        message: "Request must be valid JSON.",
      };
    } else {
      try {
        response = await runWorker(parsed);
      } catch (error) {
        response = {
          version: 1,
          status: "failed",
          reason: "failed",
          message: errorMessage(error),
        };
      }
    }
  }
  process.stdout.write(JSON.stringify(response) + "\n");
  process.exitCode = responseExitCode(response);
}

if (import.meta.main) {
  await main();
}
