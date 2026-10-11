// Forked launch worker for step-4 integration.
//
// Reads a JSON payload path from argv[2]. The worker calls the real
// production lifecycle; only the final tmux command transport may be paused
// so the owner test can inspect durable state or crash the worker at a seam.
// No store, claim, scanner or classifier is substituted.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { acquireRootClaim, launchAssignment } from "../assignments.mjs";

const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));

function send(message, callback) {
  if (process.send) process.send(message, callback);
}

// Flush the IPC payload before exiting so the parent never loses the result.
function respond(value) {
  send({ done: true, value }, () => process.exit(0));
}

function fail(error) {
  send(
    {
      done: true,
      error: {
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
        code: error?.code ?? null,
      },
    },
    () => process.exit(1),
  );
}

function waitForResume() {
  return new Promise((resolvePromise) => {
    process.once("message", (message) => {
      if (message === "resume") resolvePromise();
    });
  });
}

function realTmuxRun(socketPath, args) {
  return new Promise((resolvePromise) => {
    execFile(
      "tmux",
      ["-S", socketPath, ...args],
      { timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          resolvePromise({
            ok: false,
            code: typeof error.code === "number" ? error.code : null,
            spawnCode: typeof error.code === "string" ? error.code : null,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            message: error.message,
          });
          return;
        }
        resolvePromise({ ok: true, code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

function pausingRun(mode) {
  return async (socketPath, args) => {
    const isCreate = args.includes("new-session");
    if (isCreate && mode === "before-create") {
      send({ marker: "before-create" });
      await waitForResume();
    }
    const result = await realTmuxRun(socketPath, args);
    if (isCreate && mode === "after-create") {
      send({ marker: "after-create" });
      await waitForResume();
    }
    return result;
  };
}

async function main() {
  if (payload.action === "hold-claim") {
    const claim = await acquireRootClaim(payload.root);
    send({ marker: "holding", token: claim.token });
    await waitForResume();
    claim.release();
    respond({ released: true });
    return;
  }
  if (payload.action === "launch") {
    const adapters = payload.pauseMode ? { tmuxRun: pausingRun(payload.pauseMode) } : {};
    const record = await launchAssignment(payload.input, {
      expectedDigest: payload.expectedDigest,
      adapters,
    });
    respond(record);
    return;
  }
  throw new Error(`unknown worker action: ${payload.action}`);
}

main().catch(fail);
