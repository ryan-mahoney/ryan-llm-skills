// Step 8 explicit local setup orchestrator.
//
// Runs one locked package-manager install child for this package directory and
// optionally verifies/saves an existing local model root through the Bun
// worker. Never downloads assets, enrolls a checkout, indexes source, or
// enables spec use.

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBunPath, runCommand, runOwnedProcess } from "./client.mjs";

const INSTALL_TIMEOUT_MS = 600000;
const CONFIGURE_MODEL_CEILING_MS = 60000;
const INSTALL_ARGV = ["install", "--frozen-lockfile"];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function defaultPackageDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function installReceipt(packageDir, exitCode) {
  return {
    ok: exitCode === 0,
    packageDir,
    argv: [...INSTALL_ARGV],
    exitCode,
  };
}

/**
 * @param {{
 *   modelsRoot?: string,
 *   stateRoot?: string,
 *   packageDir?: string,
 *   bunPath?: string,
 *   spawn?: Function,
 *   modelAssets?: Array<{path: string; sha256: string}>,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{status: string, exitCode: number, reason?: string, receipt?: unknown, message?: string}>}
 */
export async function runInstall(input = {}) {
  const packageDir = input.packageDir ?? defaultPackageDir();
  const bunPath = resolveBunPath(input.bunPath);
  if (!bunPath) {
    return { status: "unavailable", reason: "runtime-unavailable", exitCode: 3 };
  }
  const spawnImpl = input.spawn ?? spawn;
  const timeoutMs =
    input.timeoutMs !== undefined
      ? Math.min(input.timeoutMs, INSTALL_TIMEOUT_MS)
      : INSTALL_TIMEOUT_MS;

  const install = await runOwnedProcess(spawnImpl, bunPath, INSTALL_ARGV, {
    cwd: packageDir,
    env: process.env,
    timeoutMs,
    signal: input.signal,
  });

  if (!install.complete) {
    const receipt = { install: installReceipt(packageDir, null) };
    if (install.reason === "timeout") {
      return { status: "unavailable", reason: "timeout", exitCode: 124, receipt };
    }
    if (install.reason === "canceled") {
      return { status: "unavailable", reason: "canceled", exitCode: 130, receipt };
    }
    return {
      status: "failed",
      reason: "install-failed",
      exitCode: 1,
      receipt,
      message: install.message,
    };
  }

  if (install.code !== 0) {
    return {
      status: "failed",
      reason: "install-failed",
      exitCode: 1,
      receipt: { install: installReceipt(packageDir, install.code) },
      message: install.stderr.trim() || undefined,
    };
  }

  const receipt = { install: installReceipt(packageDir, 0) };
  if (input.modelsRoot === undefined) {
    return { status: "ok", exitCode: 0, receipt };
  }

  const modelTimeoutMs =
    input.timeoutMs !== undefined
      ? Math.min(input.timeoutMs, CONFIGURE_MODEL_CEILING_MS)
      : undefined;

  const worker = await runCommand("configure-model", {
    models: input.modelsRoot,
    state: input.stateRoot,
    modelAssets: input.modelAssets,
    packageDir,
    bunPath,
    spawn: spawnImpl,
    timeoutMs: modelTimeoutMs,
    signal: input.signal,
  });

  if (worker.status === "ok" && worker.receipt) {
    return {
      status: "ok",
      exitCode: 0,
      receipt: { install: receipt.install, model: worker.receipt },
    };
  }
  if (worker.status === "unavailable") {
    return {
      status: "unavailable",
      reason: worker.reason ?? "model-unavailable",
      exitCode: worker.exitCode ?? 3,
      receipt,
    };
  }
  return {
    status: "failed",
    reason: worker.reason ?? "failed",
    exitCode: worker.exitCode ?? 1,
    receipt,
    message: worker.message,
  };
}

export { errorMessage };
