// Canonical Git checkout identity and owned state/enrollment path formation.
//
// Node-standard-library only: this module is shared by the Node client and the
// Bun worker. It never imports Pi/runtime code, optional dependencies or runs
// worktree-mutating commands; branch and HEAD are provenance, never identity.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
const CHECKOUT_KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * @typedef {Object} CheckoutIdentity
 * @property {string} repoKey      SHA256(commonDir) hex
 * @property {string} checkoutKey  SHA256(JSON [repoKey, gitDir, root]) hex
 * @property {string} root         canonical (realpath) working-tree top level
 * @property {string} commonDir    canonical common Git directory
 * @property {string} gitDir       canonical Git directory of this checkout
 * @property {string|null} head    full HEAD object id, null only when unborn
 * @property {boolean} primary     canonical gitDir equals canonical commonDir
 */

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function removeGitOutputTerminator(output) {
  return output.endsWith("\n") ? output.slice(0, -1) : output;
}

// Bounded, argv-only Git invocation with filesystem monitoring disabled. No
// shell is involved and the child is capped by timeout and maxBuffer.
function git(cwd, args) {
  return new Promise((resolveGit, rejectGit) => {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", "-C", cwd, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail =
            typeof stderr === "string" && stderr.trim()
              ? `: ${stderr.trim()}`
              : "";
          const failure = new Error(`git ${args.join(" ")} failed${detail}`);
          failure.code = error.code;
          rejectGit(failure);
          return;
        }
        resolveGit(removeGitOutputTerminator(stdout));
      },
    );
  });
}

// HEAD is null only for a genuinely unborn repository (Git exits 1 under
// --quiet). Any other failure is a real error and must not be masked.
async function resolveHead(cwd) {
  try {
    return await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch (error) {
    if (error && error.code === 1) return null;
    throw error;
  }
}

function realDirectory(path, label) {
  let canonical;
  try {
    canonical = realpathSync(path);
  } catch (error) {
    throw new Error(`${label} is not a readable path: ${path}`);
  }
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`${label} is not a directory: ${canonical}`);
  }
  return canonical;
}

/**
 * Resolve canonical checkout identity for a working tree or any path inside it.
 * @param {string} root
 * @returns {Promise<CheckoutIdentity>}
 */
export async function resolveCheckout(root) {
  const requested = resolve(String(root));
  const topLevel = await git(requested, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) throw new Error(`not a Git work tree: ${requested}`);

  const canonicalRoot = realDirectory(topLevel, "Git top level");
  const commonDir = realDirectory(
    await git(canonicalRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
    "Git common directory",
  );
  const gitDir = realDirectory(
    await git(canonicalRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--absolute-git-dir",
    ]),
    "Git directory",
  );

  const primary = gitDir === commonDir;
  if (!primary && !gitDir.startsWith(join(commonDir, "worktrees") + sep)) {
    throw new Error(
      `Git directory ${gitDir} does not belong to common directory ${commonDir}`,
    );
  }

  // HEAD is provenance only; null means an unborn repository.
  const head = await resolveHead(canonicalRoot);

  const repoKey = sha256(commonDir);
  const checkoutKey = sha256(JSON.stringify([repoKey, gitDir, canonicalRoot]));

  return {
    repoKey,
    checkoutKey,
    root: canonicalRoot,
    commonDir,
    gitDir,
    head: head || null,
    primary,
  };
}

/**
 * Resolve the canonical primary checkout identity for a linked worktree.
 * Git lists the main working tree first in --porcelain output. A repository
 * whose main working tree is bare has no primary checkout and resolves to
 * null so callers fall back to the explicit full-generation path.
 * @param {CheckoutIdentity} identity
 * @returns {Promise<CheckoutIdentity|null>}
 */
export async function resolvePrimaryCheckout(identity) {
  if (identity.primary) return identity;

  const listed = await git(identity.root, ["worktree", "list", "--porcelain"]);
  const firstEntry = listed.split("\n\n")[0] ?? "";
  const lines = firstEntry.split("\n");
  if (lines.includes("bare")) return null;
  const worktreeLine = lines.find((line) => line.startsWith("worktree "));
  if (!worktreeLine) return null;

  const primary = await resolveCheckout(worktreeLine.slice("worktree ".length));
  if (!primary.primary || primary.repoKey !== identity.repoKey) return null;
  return primary;
}

/** Default owner-only state root: ~/.cache/agent-repo-search. */
export function defaultStateRoot() {
  return join(homedir(), ".cache", "agent-repo-search");
}

/** Canonical state root, falling back to the default installation. */
export function resolveStateRoot(stateRoot) {
  if (stateRoot === undefined || stateRoot === null || stateRoot === "") {
    return defaultStateRoot();
  }
  return resolve(String(stateRoot));
}

function assertCheckoutKey(checkoutKey) {
  if (typeof checkoutKey !== "string" || !CHECKOUT_KEY_PATTERN.test(checkoutKey)) {
    throw new Error(
      "checkoutKey must be 64 lowercase hex characters before forming a state path",
    );
  }
  return checkoutKey;
}

/** Owned per-checkout state directory: <stateRoot>/checkouts/<checkoutKey>. */
export function checkoutStatePath(stateRoot, checkoutKey) {
  return join(resolveStateRoot(stateRoot), "checkouts", assertCheckoutKey(checkoutKey));
}

/** Enrollment record path: <stateRoot>/checkouts/<checkoutKey>/enrollment.json. */
export function enrollmentPath(stateRoot, checkoutKey) {
  return join(checkoutStatePath(stateRoot, checkoutKey), "enrollment.json");
}
