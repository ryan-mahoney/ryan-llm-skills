// Bounded assignment resolution for Adjacent tmux launches.
//
// Node-standard-library only. `resolveTarget` selects the physical execution
// directory for a workspace or one of its kit repositories and checks a
// supplied spec package against that checkout's canonical git common
// directory. `resolveAssignment` validates the immutable launch contract,
// reads the reviewed brief bytes once, derives the fixed-order canonical
// digest and the Pi argument array, and returns the preview record.
//
// resolveTarget/resolveAssignment are read-only. `acquireRootClaim` owns the
// root-scoped logical lease and creates only `<physical-root>/.sentinel` and
// its coordination database on the authorized launch path; `listAssignments`/
// `findAssignment` are strictly read-only record lookups. The caller owns
// snapshot publication (assignments/<id>.brief.md), session directory
// creation and record persistence.

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalPackage } from "../../pi/extensions/spec-runtime/runtime.mjs";
import { resolveCheckout } from "../repo-search/identity.mjs";
import { processIdentity, sameProcess } from "../spec-observe/process-identity.mjs";
import { claimOwner } from "../spec-observe/owner-claim.mjs";
import { observeAssignment } from "./reconcile.mjs";
import {
  createFileExclusive,
  fetchWorkspace,
  listWorkspaces,
  resolveWorkspacePath,
  storageStatus,
  writeFileAtomic,
} from "./store.mjs";
import { attachArgs, probeSession, startSession } from "./tmux.mjs";

const GIT_TIMEOUT_MS = 5000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PUBLICATION_AUTHORITIES = new Set(["none", "draft-pr", "pr"]);
const ATTEMPT_KINDS = new Set(["initial", "launch-retry"]);
const ROOT_CLAIM_KEY = "adjacent-launch";
const ROOT_CLAIM_TIMEOUT_MS = 5000;
const ROOT_CLAIM_RETRY_MS = 50;
// claimOwner accepts only 1-5000 ms; the remaining retry deadline bounds it.
const OWNER_CLAIM_MAX_TIMEOUT_MS = 5000;
// Persisted assignment states; a resolved preview is never persisted.
const ASSIGNMENT_STATES = new Set([
  "launching",
  "live",
  "launch_unknown",
  "launch_failed",
  "ended",
]);
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const PANE_ID_PATTERN = /^%\d+$/;
const SESSION_NAME_PATTERN = /^adj-[0-9a-f]{12}$/;
const PROJECT_TRUST_VALUES = new Set(["always", "approve", "ask", "never", "no-approve"]);
const EXCLUSION_STATES = new Set(["launching", "live", "launch_unknown"]);
// Effective immutable record fields used for an idempotent same-id repeat.
const IMMUTABLE_RECORD_FIELDS = [
  "schema_version",
  "assignment_id",
  "workspace_id",
  "workspace_directory",
  "storage_root",
  "brief",
  "brief_sha256",
  "skill",
  "skill_path",
  "instructions",
  "provider",
  "model",
  "thinking",
  "project_trust",
  "execution_dir",
  "repository_id",
  "spec_package",
  "workflow_id",
  "publication_authority",
  "attempt_kind",
  "supersedes",
  "contract_digest",
  "tmux_socket",
  "tmux_session",
  "pi_path",
  "coordination_database",
  "pi_session_dir",
];
// Private approval receipts for internally generated resolveAssignment results.
const resolvedReceipts = new WeakMap();
// Supported thinking levels mirror installed Pi dist/cli/args.js VALID_THINKING_LEVELS
// (pi 1.1.0: off, minimal, low, medium, high, xhigh, max). ResolveAssignment
// validates explicitly so an invalid level fails visibly instead of Pi
// silently omitting it and executing with another effective setting.
const SUPPORTED_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

async function lstatOrNull(path) {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalNonEmptyString(value, label, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Preserve source order while dropping duplicate and non-string entries.
function mergeAttention(base, extra) {
  const merged = [];
  for (const value of [...(base ?? []), ...(extra ?? [])]) {
    if (typeof value === "string" && !merged.includes(value)) merged.push(value);
  }
  return merged;
}

// The workspace directory is already catalog-validated; re-resolve it
// physically and refuse a symlinked final component or symlinked ancestors.
async function physicalWorkspaceDirectory(directory) {
  if (typeof directory !== "string" || directory === "") {
    throw new TypeError("workspace.directory must be a non-empty string");
  }
  const absolute = resolve(directory);
  const info = await lstatOrNull(absolute);
  if (!info) throw new Error(`workspace directory does not exist: ${absolute}`);
  if (info.isSymbolicLink()) {
    throw new Error(`workspace directory must not be a symlink: ${absolute}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`workspace directory is not a directory: ${absolute}`);
  }
  const physical = await fs.realpath(absolute);
  if (physical !== absolute) {
    throw new Error(`workspace directory path contains a symbolic link: ${absolute}`);
  }
  return physical;
}

// Resolve an existing executable candidate physically. Symlinked executables
// (for example Homebrew's pi) are followed; missing or non-executable
// candidates return null so PATH scanning can continue.
async function resolveExecutable(candidate) {
  let physical;
  try {
    physical = await fs.realpath(candidate);
  } catch {
    return null;
  }
  let info;
  try {
    info = await fs.stat(physical);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  try {
    await fs.access(physical, fsConstants.X_OK);
  } catch {
    return null;
  }
  return physical;
}

async function resolvePiExecutable(piPath) {
  if (piPath !== undefined && piPath !== null) {
    if (typeof piPath !== "string" || piPath === "") {
      throw new Error("pi_path must be a non-empty string");
    }
    const physical = await resolveExecutable(resolve(piPath));
    if (physical === null) {
      throw new Error(`pi executable is not an executable file: ${piPath}`);
    }
    return physical;
  }
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry === "") continue;
    const physical = await resolveExecutable(join(entry, "pi"));
    if (physical !== null) return physical;
  }
  throw new Error("pi executable was not found on PATH");
}

/**
 * Map an accepted project-trust value to Pi's one-shot trust flags. `null`
 * leaves the trust prompt/decision untouched, `always`/`approve` trusts
 * project-local resources for this process and `never`/`no-approve` refuses
 * them.
 */
function projectTrustFlags(projectTrust) {
  switch (projectTrust) {
    case null:
      return [];
    case "always":
    case "approve":
      return ["--approve"];
    case "ask":
      return [];
    case "never":
    case "no-approve":
      return ["--no-approve"];
    default:
      throw new Error(`unsupported project_trust value: ${projectTrust}`);
  }
}

// Resolve exactly one usable kit repository to its physical checkout root.
async function resolveRepositoryCheckout({ workspace, directory, repositoryId, attention }) {
  if (typeof repositoryId !== "string" || repositoryId === "") {
    throw new Error("repository id must be a non-empty string");
  }
  const matches = (Array.isArray(workspace.repositories) ? workspace.repositories : [])
    .filter((record) => record && record.id === repositoryId);
  if (matches.length === 0) {
    throw new Error(`repository is not available in workspace: ${repositoryId}`);
  }
  if (matches.length > 1) throw new Error(`repository is ambiguous: ${repositoryId}`);
  const record = matches[0];
  if (record.status !== "ok") {
    throw new Error(`repository is not usable: ${repositoryId} (${String(record.status)})`);
  }
  if (typeof record.path !== "string" || record.path === "") {
    throw new Error(`repository path is missing: ${repositoryId}`);
  }
  const declared = isAbsolute(record.path)
    ? resolve(record.path)
    : resolve(directory, record.path);
  let physical;
  try {
    physical = await fs.realpath(declared);
  } catch (error) {
    throw new Error(`repository path is not resolvable: ${repositoryId}`, { cause: error });
  }
  let identity;
  try {
    identity = await resolveCheckout(physical, { deadline: Date.now() + GIT_TIMEOUT_MS });
  } catch (error) {
    throw new Error(`repository is not a Git work tree: ${repositoryId}`, { cause: error });
  }
  if (identity.root !== physical) {
    throw new Error(`repository path is not a Git top level: ${repositoryId}`);
  }
  return {
    identity,
    executionDir: identity.root,
    repositoryId,
    attention: mergeAttention(attention, record.attention),
  };
}

const WORKTREE_LIST_MAX_BYTES = 1024 * 1024;

function listWorktreePaths(cwd, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(Object.assign(new Error("git deadline expired"), { code: "timeout" }));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", "-C", cwd, "worktree", "list", "--porcelain", "-z"],
      {
        timeout: Math.min(GIT_TIMEOUT_MS, remaining),
        killSignal: "SIGKILL",
        maxBuffer: WORKTREE_LIST_MAX_BYTES,
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout) => {
        if (error) rejectPromise(error);
        else resolvePromise(stdout);
      },
    );
  });
}

function parseWorktreePaths(output) {
  const paths = [];
  for (const record of output.split("\0\0")) {
    for (const field of record.split("\0")) {
      if (field.startsWith("worktree ")) {
        paths.push(resolve(field.slice("worktree ".length)));
        break;
      }
    }
  }
  return paths;
}

async function resolveWorktreeCheckout({ workspace, directory, path, attention }) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("worktree target path must be an absolute string");
  }
  const requested = resolve(path);
  let identity;
  try {
    identity = await resolveCheckout(requested, { deadline: Date.now() + GIT_TIMEOUT_MS });
  } catch (error) {
    throw new Error("worktree path is not a Git work tree", { cause: error });
  }
  if (identity.primary) throw new Error("worktree path is not a linked worktree");
  if (identity.root !== requested) {
    throw new Error("worktree path is not the exact canonical top level");
  }
  const usable = (Array.isArray(workspace.repositories) ? workspace.repositories : [])
    .filter((record) => record && record.status === "ok" && typeof record.path === "string" && record.path !== "");
  const matches = [];
  for (const record of usable) {
    const declared = isAbsolute(record.path) ? resolve(record.path) : resolve(directory, record.path);
    let candidate;
    try {
      candidate = await resolveCheckout(declared, { deadline: Date.now() + GIT_TIMEOUT_MS });
    } catch {
      continue;
    }
    if (candidate.commonDir === identity.commonDir) matches.push(record);
  }
  if (matches.length === 0) throw new Error("worktree does not belong to a usable workspace repository");
  if (matches.length > 1) throw new Error("worktree matches multiple workspace repositories");
  let registered;
  try {
    registered = parseWorktreePaths(await listWorktreePaths(identity.root, Date.now() + GIT_TIMEOUT_MS));
  } catch (error) {
    throw new Error("worktree registration could not be read", { cause: error });
  }
  if (!registered.includes(identity.root)) throw new Error("worktree is not registered in git worktree list");
  return {
    identity,
    executionDir: identity.root,
    repositoryId: matches[0].id,
    attention: mergeAttention(attention, matches[0].attention),
  };
}

/**
 * Resolve the physical execution directory for a workspace target.
 *
 * A null/undefined `target` selects the workspace directory itself. A string
 * `target` must match exactly one retained kit repository whose recorded
 * status is `ok`; the declared path (absolute or workspace-relative) is
 * resolved to its physical checkout root through `resolveCheckout`.
 * An object target accepts `{kind:'workspace'}`, `{kind:'repository',
 * repository_id}` or `{kind:'worktree', path}`. A linked worktree must belong
 * to exactly one usable workspace repository common directory and be listed
 * by the bounded `git worktree list --porcelain -z` registration read.
 * Workspace and repository attention entries are preserved.
 *
 * When `specPackage` is supplied, `canonicalPackage` must resolve it to the
 * primary checkout of the execution directory's repository; the canonical
 * package path is returned as `spec_package`.
 *
 * @param {{workspace: object, target?: string|object|null, specPackage?: string|null}} input
 * @returns {Promise<{execution_dir: string, repository_id: string|null,
 *   spec_package: string|null, attention: string[]}>}
 */
export async function resolveTarget({ workspace, target = null, specPackage = null } = {}) {
  if (workspace === null || typeof workspace !== "object" || Array.isArray(workspace)) {
    throw new TypeError("workspace must be a workspace detail object");
  }
  const directory = await physicalWorkspaceDirectory(workspace.directory);
  let attention = mergeAttention(workspace.attention, []);
  let checkout = null;
  let executionDir = directory;
  let repositoryId = null;

  if (target !== null && target !== undefined) {
    if (typeof target === "string") {
      const resolved = await resolveRepositoryCheckout({ workspace, directory, repositoryId: target, attention });
      checkout = resolved.identity;
      executionDir = resolved.executionDir;
      repositoryId = resolved.repositoryId;
      attention = resolved.attention;
    } else if (typeof target === "object" && !Array.isArray(target)) {
      if (target.kind === "workspace") {
        // The workspace directory itself remains the execution directory.
      } else if (target.kind === "repository") {
        const resolved = await resolveRepositoryCheckout({
          workspace,
          directory,
          repositoryId: target.repository_id,
          attention,
        });
        checkout = resolved.identity;
        executionDir = resolved.executionDir;
        repositoryId = resolved.repositoryId;
        attention = resolved.attention;
      } else if (target.kind === "worktree") {
        const resolved = await resolveWorktreeCheckout({
          workspace,
          directory,
          path: target.path,
          attention,
        });
        checkout = resolved.identity;
        executionDir = resolved.executionDir;
        repositoryId = resolved.repositoryId;
        attention = resolved.attention;
      } else {
        throw new Error(`unsupported target kind: ${String(target.kind)}`);
      }
    } else {
      throw new Error("target must be a repository id string");
    }
  }

  let specPackagePath = null;
  if (specPackage !== null && specPackage !== undefined) {
    if (typeof specPackage !== "string" || specPackage === "") {
      throw new Error("specPackage must be a non-empty string");
    }
    // canonicalPackage throws when the path is not a primary-checkout package.
    const canonical = canonicalPackage(specPackage);
    if (checkout === null) {
      try {
        checkout = await resolveCheckout(executionDir, { deadline: Date.now() + GIT_TIMEOUT_MS });
      } catch (error) {
        throw new Error(
          "a spec package requires a Git repository execution directory",
          { cause: error },
        );
      }
    }
    if (canonical.common !== checkout.commonDir) {
      throw new Error(
        "spec package belongs to a different repository than the execution directory",
      );
    }
    specPackagePath = canonical.packagePath;
  }

  return {
    execution_dir: executionDir,
    repository_id: repositoryId,
    spec_package: specPackagePath,
    attention,
  };
}

/**
 * Resolve an immutable, write-free assignment contract.
 *
 * Validates the immutable launch parameters, resolves the workspace and
 * execution target, installs the exact brief bytes once, resolves the skill
 * and Pi executable physically, and returns the preview record, the fixed
 * Pi argv and the canonical digest. Nothing is published, created or
 * modified: the caller owns snapshot/session publication and record writes.
 *
 * @param {object} input
 * @returns {Promise<{record: object, piArgs: string[], briefBytes: Buffer,
 *   contractDigest: string}>}
 */
export async function resolveAssignment(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("input must be an object");
  }

  const assignmentId = requireNonEmptyString(input.assignment_id, "assignment_id");
  if (!UUID_PATTERN.test(assignmentId)) {
    throw new Error(`assignment_id must be a UUID: ${assignmentId}`);
  }
  const supersedes = input.supersedes ?? null;
  if (supersedes !== null && (typeof supersedes !== "string" || !UUID_PATTERN.test(supersedes))) {
    throw new Error(`supersedes must be a UUID: ${String(supersedes)}`);
  }
  const workspaceId = requireNonEmptyString(input.workspace_id, "workspace_id");
  const brief = requireNonEmptyString(input.brief, "brief");
  const instructions = requireNonEmptyString(input.instructions, "instructions");
  const storageRoot = requireNonEmptyString(input.storageRoot, "storageRoot");

  const publicationAuthority = input.publication_authority ?? "none";
  if (!PUBLICATION_AUTHORITIES.has(publicationAuthority)) {
    throw new Error(`invalid publication_authority: ${String(publicationAuthority)}`);
  }
  const attemptKind = input.attempt_kind ?? "initial";
  if (!ATTEMPT_KINDS.has(attemptKind)) {
    throw new Error(`invalid attempt_kind: ${String(attemptKind)}`);
  }
  if (attemptKind === "initial" && supersedes !== null) {
    throw new Error("an initial assignment must not supersede another assignment");
  }
  if (attemptKind === "launch-retry") {
    if (supersedes === null) throw new Error("launch-retry requires supersedes");
    if (supersedes === assignmentId) {
      throw new Error("launch-retry must supersede a different assignment");
    }
  }

  const provider = input.provider ?? null;
  if (provider !== null && (typeof provider !== "string" || provider === "")) {
    throw new Error("provider must be a non-empty string");
  }
  const model = input.model ?? null;
  if (model !== null && (typeof model !== "string" || model === "")) {
    throw new Error("model must be a non-empty string");
  }
  if ((provider === null) !== (model === null)) {
    throw new Error("provider and model must be supplied together");
  }
  const thinking = input.thinking ?? null;
  if (thinking !== null) {
    if (typeof thinking !== "string" || thinking === "") {
      throw new Error("thinking must be a non-empty string");
    }
    if (model === null) throw new Error("thinking requires an explicit model");
    if (!SUPPORTED_THINKING_LEVELS.has(thinking)) {
      throw new Error(
        `invalid thinking level: ${thinking} (valid: ${[...SUPPORTED_THINKING_LEVELS].join(", ")})`,
      );
    }
  }
  if (model !== null && thinking !== null && model.includes(":")) {
    const suffix = model.slice(model.lastIndexOf(":") + 1);
    if (SUPPORTED_THINKING_LEVELS.has(suffix)) {
      throw new Error(
        `model-embedded thinking conflicts with explicit thinking: ${model} + ${thinking}`,
      );
    }
  }

  const projectTrust = input.project_trust ?? null;
  if (projectTrust !== null && typeof projectTrust !== "string") {
    throw new Error("project_trust must be a string");
  }
  const trustFlags = projectTrustFlags(projectTrust);

  const workflowId = input.workflow_id ?? null;
  if (workflowId !== null && (typeof workflowId !== "string" || workflowId === "")) {
    throw new Error("workflow_id must be a non-empty string");
  }

  const skill = input.skill ?? "general";
  if (typeof skill !== "string" || skill === "") {
    throw new Error("skill must be a non-empty string");
  }
  const home = resolve(requireNonEmptyString(input.home ?? homedir(), "home"));
  let skillPath = null;
  if (skill !== "general") {
    if (!SKILL_NAME_PATTERN.test(skill)) {
      throw new Error(`invalid skill name: ${skill}`);
    }
    const candidate = join(home, ".agents", "skills", skill, "SKILL.md");
    const info = await lstatOrNull(candidate);
    if (!info) throw new Error(`skill does not exist: ${skill}`);
    if (info.isSymbolicLink()) throw new Error(`skill must not be a symlink: ${skill}`);
    if (!info.isFile()) throw new Error(`skill is not a regular file: ${skill}`);
    skillPath = await fs.realpath(candidate);
  }

  const workspace = await fetchWorkspace(storageRoot, workspaceId);
  const target = await resolveTarget({
    workspace,
    target: input.target ?? null,
    specPackage: input.specPackage ?? null,
  });

  // Read the reviewed brief bytes once; the hash and returned bytes bind this
  // exact read, so later source edits cannot change the approved contract.
  const briefPath = await resolveWorkspacePath(workspace.directory, brief);
  const briefBytes = await fs.readFile(briefPath);
  const briefSha256 = sha256Hex(briefBytes);

  const storageRootPhysical = await fs.realpath(resolve(storageRoot));
  // The default dedicated socket lives in the derived coordination directory;
  // an explicit socket passes through unchanged but must be absolute so it
  // names one physical server instead of a cwd-dependent default-server path.
  let tmuxSocket;
  if (input.tmux_socket === undefined || input.tmux_socket === null) {
    tmuxSocket = coordinationPaths(storageRootPhysical).socket;
  } else {
    tmuxSocket = requireNonEmptyString(input.tmux_socket, "tmux_socket");
    if (!isAbsolute(tmuxSocket)) {
      throw new Error("tmux_socket must be an absolute path");
    }
  }
  const tmuxSession = optionalNonEmptyString(
    input.tmux_session,
    "tmux_session",
    `adj-${assignmentId.replace(/-/g, "").slice(0, 12).toLowerCase()}`,
  );
  if (!SESSION_NAME_PATTERN.test(tmuxSession)) {
    throw new Error("tmux_session is not an owned session name");
  }
  const piPath = await resolvePiExecutable(input.pi_path ?? null);
  if (input.coordination_database !== undefined && input.coordination_database !== null) {
    throw new Error(
      "coordination_database must not be supplied: derived from the physical storage root",
    );
  }
  const coordinationDatabase = coordinationPaths(storageRootPhysical).database;
  const piSessionDir = optionalNonEmptyString(
    input.pi_session_dir,
    "pi_session_dir",
    join(workspace.directory, "sessions", assignmentId),
  );
  const snapshotPath = join(workspace.directory, "assignments", `${assignmentId}.brief.md`);

  // Fixed canonical field order with explicit nulls; assignment UUID,
  // generated snapshot path, timestamps, state and launch token are excluded.
  const canonical = [
    workspaceId,
    storageRootPhysical,
    workspace.directory,
    brief,
    briefSha256,
    skill,
    skillPath,
    instructions,
    provider,
    model,
    thinking,
    projectTrust,
    target.execution_dir,
    target.repository_id,
    target.spec_package,
    workflowId,
    publicationAuthority,
    attemptKind,
    supersedes,
    piPath,
    tmuxSocket,
    tmuxSession,
    coordinationDatabase,
    piSessionDir,
  ];
  const contractDigest = sha256Hex(Buffer.from(JSON.stringify(canonical), "utf8"));

  const assignmentBlock =
    `Assignment ${assignmentId} workspace ${workspaceId} dir ${target.execution_dir}. ` +
    `Publication authority: ${publicationAuthority} (grants no merge/deploy).`;
  // Pi's @file prefix suppresses skill expansion and only a leading `/skill:`
  // triggers it, so the skill is delivered as a plain absolute-path
  // instruction for the model to read itself. A general instruction starts
  // with this fixed ordinary-text prefix so user text beginning with '-',
  // '--' or '@' stays one message instead of an option, extension flag or
  // file argument in the installed Pi parseArgs.
  const initialInstruction = skillPath === null
    ? `Perform the following request:\n\n${instructions}\n\n${assignmentBlock}`
    : `Read the skill at ${skillPath} and perform its instructions for this request.\n\n` +
      `${instructions}\n\n${assignmentBlock}`;

  const piArgs = [
    "--session-dir",
    piSessionDir,
    "--session-id",
    assignmentId,
    "--name",
    `${workspaceId}:${workspace.name}`,
    ...(provider === null ? [] : ["--provider", provider, "--model", model]),
    ...(thinking === null ? [] : ["--thinking", thinking]),
    ...trustFlags,
    `@${snapshotPath}`,
    initialInstruction,
  ];

  const timestamp = new Date().toISOString();
  const record = {
    schema_version: 1,
    assignment_id: assignmentId,
    workspace_id: workspaceId,
    workspace_directory: workspace.directory,
    storage_root: storageRootPhysical,
    brief,
    brief_sha256: briefSha256,
    brief_snapshot: snapshotPath,
    skill,
    skill_path: skillPath,
    instructions,
    provider,
    model,
    thinking,
    project_trust: projectTrust,
    execution_dir: target.execution_dir,
    repository_id: target.repository_id,
    spec_package: target.spec_package,
    // Resolution diagnostics are part of the record but not of the canonical
    // contract digest above.
    attention: target.attention,
    workflow_id: workflowId,
    publication_authority: publicationAuthority,
    attempt_kind: attemptKind,
    supersedes,
    contract_digest: contractDigest,
    tmux_socket: tmuxSocket,
    tmux_session: tmuxSession,
    pi_path: piPath,
    coordination_database: coordinationDatabase,
    pi_session_dir: piSessionDir,
    pi_session_file: null,
    launcher_identity: null,
    launch_token: randomUUID(),
    state: "preview",
    created_at: timestamp,
    updated_at: timestamp,
  };

  const result = { record, piArgs, briefBytes, contractDigest };
  // Private approval receipt: launchAssignment accepts a supplied `resolved`
  // only when it is this exact object with an unchanged record, argv, bytes
  // and digest, and the caller input deep-equals the approved input.
  resolvedReceipts.set(result, {
    input: structuredClone(input),
    record: structuredClone(record),
    piArgs: [...piArgs],
    briefBytes: Buffer.from(briefBytes),
    contractDigest,
  });
  return result;
}

// Root coordination and read-only assignment catalog -----------------------

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// The only coordination domain for one physical root. Socket and database are
// derived together so no caller can split exclusion with an override.
function coordinationPaths(physicalRoot) {
  const sentinel = join(physicalRoot, ".sentinel");
  return {
    sentinel,
    database: join(sentinel, "coordination.sqlite"),
    socket: join(sentinel, "adjacent.sock"),
  };
}

// Create an owned directory non-recursively with mode 0700, never following a
// symlink and never creating its parent.
async function ensureOwnedDirectory(path, label) {
  const existing = await lstatOrNull(path);
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink: ${path}`);
    }
    if (!existing.isDirectory()) {
      throw new Error(`${label} is not a directory: ${path}`);
    }
    if ((await fs.realpath(path)) !== path) {
      throw new Error(`${label} path contains a symbolic link: ${path}`);
    }
    return;
  }
  try {
    await fs.mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      const raced = await lstatOrNull(path);
      if (raced && !raced.isSymbolicLink() && raced.isDirectory()
        && (await fs.realpath(path)) === path) return;
    }
    throw new Error(
      `cannot create ${label} ${path}: ${error.code ?? error.message}`,
    );
  }
  const created = await lstatOrNull(path);
  if (!created || created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`${label} was not created as a real directory: ${path}`);
  }
}

/**
 * Acquire the single root-wide launcher lease for `root`.
 *
 * The database is always derived as
 * `<physical-root>/.sentinel/coordination.sqlite` with key `adjacent-launch`;
 * override arguments are refused so no caller can split the exclusion domain
 * for one physical root. The existing root must pass the shared read-only
 * storage status, and the owned `.sentinel` directory is created
 * non-recursively with mode 0700 only when missing. Refusals from the shared
 * adj2 `claimOwner` (any `OwnerClaimError`) are retried every 50 ms until the
 * 5-second deadline, then the last error is thrown. There is no reentrant or
 * same-process shortcut.
 *
 * @param {string} root
 * @param {Record<string, unknown>} [overrides]
 * @returns {Promise<{key: string, pid: number, started_at: string, token: string,
 *   release: () => void}>}
 */
export async function acquireRootClaim(root, overrides = {}) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("root claim overrides must be an object");
  }
  const overrideKeys = Object.keys(overrides);
  if (overrideKeys.length > 0) {
    throw new Error(
      `root claim does not accept overrides (${overrideKeys.join(", ")}); the coordination database is derived from the physical root`,
    );
  }
  if (typeof root !== "string" || root === "") {
    throw new TypeError("root must be a non-empty string");
  }
  const status = await storageStatus(root);
  if (status.status !== "ok") {
    const detail = status.errors.map((entry) => entry.message).join("; ") || status.status;
    throw new Error(`storage root is not usable for the launch claim (${status.status}): ${detail}`);
  }
  const physicalRoot = status.root;
  const paths = coordinationPaths(physicalRoot);
  await ensureOwnedDirectory(paths.sentinel, "coordination directory");

  const deadline = Date.now() + ROOT_CLAIM_TIMEOUT_MS;
  let lastError = null;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw lastError ?? new Error(`root claim deadline exceeded for ${physicalRoot}`);
    }
    try {
      return claimOwner({
        database: paths.database,
        key: ROOT_CLAIM_KEY,
        timeoutMs: Math.max(1, Math.min(OWNER_CLAIM_MAX_TIMEOUT_MS, remaining)),
      });
    } catch (error) {
      if (!error || error.name !== "OwnerClaimError") throw error;
      lastError = error;
    }
    if (Date.now() >= deadline) throw lastError;
    await delay(ROOT_CLAIM_RETRY_MS);
  }
}

function typedAssignmentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function refuseAssignment(path, detail) {
  throw new Error(`invalid assignment record ${path}: ${detail}`);
}

function isHex64(value) {
  return typeof value === "string" && HEX64_PATTERN.test(value);
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateOptionalIdentity(record, field, path) {
  const value = record[field];
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.started_at !== "string" || value.started_at === "") {
    refuseAssignment(path, `${field} is not a valid process identity`);
  }
}

async function validateAssignmentRecord(physicalRoot, workspace, path, record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    refuseAssignment(path, "record is not an object");
  }
  const id = record.assignment_id;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    refuseAssignment(path, "assignment_id is not an RFC4122 UUID");
  }
  if (basename(path, ".json") !== id) {
    refuseAssignment(path, "assignment_id does not match the filename");
  }
  if (record.schema_version !== 1) refuseAssignment(path, "schema_version is not 1");
  if (record.workspace_id !== workspace.id) {
    refuseAssignment(path, "workspace_id does not match the owning workspace");
  }
  if (record.storage_root !== physicalRoot) {
    refuseAssignment(path, "storage_root does not match the physical storage root");
  }
  if (record.workspace_directory !== workspace.directory) {
    refuseAssignment(path, "workspace_directory does not match the physical workspace directory");
  }
  if (typeof record.launch_token !== "string" || !UUID_PATTERN.test(record.launch_token)) {
    refuseAssignment(path, "launch_token is not an RFC4122 UUID");
  }
  if (!ASSIGNMENT_STATES.has(record.state)) {
    refuseAssignment(
      path,
      `state ${JSON.stringify(record.state)} is not a persisted assignment state`,
    );
  }
  if (!isHex64(record.brief_sha256)) refuseAssignment(path, "brief_sha256 is not a 64-hex digest");
  if (!isHex64(record.contract_digest)) {
    refuseAssignment(path, "contract_digest is not a 64-hex digest");
  }
  if (!isTimestamp(record.created_at) || !isTimestamp(record.updated_at)) {
    refuseAssignment(path, "created_at/updated_at are not valid timestamps");
  }
  if (typeof record.brief !== "string" || record.brief === "") {
    refuseAssignment(path, "brief is not a non-empty string");
  }
  if (typeof record.skill !== "string" || record.skill === "") {
    refuseAssignment(path, "skill is not a non-empty string");
  }
  if (record.skill === "general") {
    if (record.skill_path !== null) {
      refuseAssignment(path, "general skill must not carry a skill_path");
    }
  } else if (typeof record.skill_path !== "string" || !isAbsolute(record.skill_path)) {
    refuseAssignment(path, "skill_path must be an absolute path for a named skill");
  }
  if (typeof record.instructions !== "string" || record.instructions === "") {
    refuseAssignment(path, "instructions is not a non-empty string");
  }
  if (!PUBLICATION_AUTHORITIES.has(record.publication_authority)) {
    refuseAssignment(path, "publication_authority is not a known authority");
  }
  if (!ATTEMPT_KINDS.has(record.attempt_kind)) {
    refuseAssignment(path, "attempt_kind is not a known kind");
  }
  if (record.attempt_kind === "initial" && record.supersedes !== null) {
    refuseAssignment(path, "an initial assignment must not supersede another");
  }
  if (record.attempt_kind === "launch-retry"
    && (typeof record.supersedes !== "string" || !UUID_PATTERN.test(record.supersedes)
      || record.supersedes === id)) {
    refuseAssignment(path, "launch-retry must supersede a different UUID");
  }
  if (record.project_trust !== null && !PROJECT_TRUST_VALUES.has(record.project_trust)) {
    refuseAssignment(path, "project_trust is not a known trust value");
  }
  if ((record.provider === null) !== (record.model === null)
    || (record.provider !== null && (typeof record.provider !== "string" || record.provider === ""))
    || (record.model !== null && (typeof record.model !== "string" || record.model === ""))) {
    refuseAssignment(path, "provider/model must be supplied together as non-empty strings");
  }
  if (record.thinking !== null
    && (record.model === null || !SUPPORTED_THINKING_LEVELS.has(record.thinking))) {
    refuseAssignment(path, "thinking requires a model and a supported level");
  }
  if (record.repository_id !== null
    && (typeof record.repository_id !== "string" || record.repository_id === "")) {
    refuseAssignment(path, "repository_id is neither null nor a non-empty string");
  }
  if (record.spec_package !== null
    && (typeof record.spec_package !== "string" || !isAbsolute(record.spec_package))) {
    refuseAssignment(path, "spec_package is neither null nor an absolute path");
  }
  if (record.workflow_id !== null
    && (typeof record.workflow_id !== "string" || record.workflow_id === "")) {
    refuseAssignment(path, "workflow_id is neither null nor a non-empty string");
  }
  if (record.attention !== undefined
    && (!Array.isArray(record.attention)
      || record.attention.some((entry) => typeof entry !== "string"))) {
    refuseAssignment(path, "attention is not an array of strings");
  }
  const paths = coordinationPaths(physicalRoot);
  if (record.coordination_database !== paths.database) {
    refuseAssignment(path, "coordination_database is not the root-derived database");
  }
  if (typeof record.tmux_socket !== "string" || !isAbsolute(record.tmux_socket)) {
    refuseAssignment(path, "tmux_socket must be an absolute path");
  }
  if (typeof record.tmux_session !== "string"
    || !SESSION_NAME_PATTERN.test(record.tmux_session)) {
    refuseAssignment(path, "tmux_session is not an owned session name");
  }
  if (typeof record.pi_path !== "string" || !isAbsolute(record.pi_path)) {
    refuseAssignment(path, "pi_path must be an absolute path");
  }
  if (record.brief_snapshot !== join(workspace.directory, "assignments", `${id}.brief.md`)) {
    refuseAssignment(path, "brief_snapshot is not the owned snapshot path");
  }
  if (record.pi_session_dir !== join(workspace.directory, "sessions", id)) {
    refuseAssignment(path, "pi_session_dir is not the owned session directory derivation");
  }
  if (typeof record.execution_dir !== "string" || !isAbsolute(record.execution_dir)) {
    refuseAssignment(path, "execution_dir must be an absolute path");
  }
  const executionInfo = await lstatOrNull(record.execution_dir);
  if (!executionInfo || executionInfo.isSymbolicLink() || !executionInfo.isDirectory()) {
    refuseAssignment(path, "execution_dir is not an existing physical directory");
  }
  if ((await fs.realpath(record.execution_dir)) !== record.execution_dir) {
    refuseAssignment(path, "execution_dir is not the canonical physical directory");
  }
  validateOptionalIdentity(record, "launcher_identity", path);
  validateOptionalIdentity(record, "pi_identity", path);
  if (record.pane_id !== undefined && record.pane_id !== null
    && (typeof record.pane_id !== "string" || !PANE_ID_PATTERN.test(record.pane_id))) {
    refuseAssignment(path, "pane_id is not an exact tmux pane id");
  }
  if (record.pi_session_file !== undefined && record.pi_session_file !== null) {
    if (typeof record.pi_session_file !== "string" || !isAbsolute(record.pi_session_file)) {
      refuseAssignment(path, "pi_session_file is neither null nor an absolute path");
    }
    const within = relative(join(workspace.directory, "sessions", id), record.pi_session_file);
    if (within === "" || within.startsWith("..") || isAbsolute(within)) {
      refuseAssignment(path, "pi_session_file is not inside the owned session directory");
    }
  }
  return record;
}

// Scan one physical catalog workspace's assignments directory. Missing means
// no records; every other directory problem or malformed record refuses the
// whole lookup instead of being skipped.
async function readWorkspaceAssignments(physicalRoot, workspace) {
  const directory = join(workspace.directory, "assignments");
  const lookup = await lstatOrNull(directory);
  if (lookup === null) return [];
  if (lookup.isSymbolicLink() || !lookup.isDirectory()) {
    throw new Error(`assignments directory is not a real directory: ${directory}`);
  }
  if ((await fs.realpath(directory)) !== directory) {
    throw new Error(`assignments directory path contains a symbolic link: ${directory}`);
  }
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `assignments directory is unreadable: ${directory} (${error.code ?? error.message})`,
    );
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      refuseAssignment(path, "record is not a regular file");
    }
    let text;
    try {
      text = await fs.readFile(path, "utf8");
    } catch (error) {
      refuseAssignment(path, `record is unreadable (${error.code ?? error.message})`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      refuseAssignment(path, "record is malformed JSON");
    }
    records.push({
      record: await validateAssignmentRecord(physicalRoot, workspace, path, parsed),
      path,
    });
  }
  return records;
}

// Read-only global scan: the root must pass storage status, the catalog may
// not contain invalid potentially relevant state, and a duplicated assignment
// UUID refuses before any workspace filter. Results are sorted by created_at
// then assignment id.
async function scanAssignmentRecords(root) {
  if (typeof root !== "string" || root === "") {
    throw new TypeError("root must be a non-empty string");
  }
  const status = await storageStatus(root);
  if (status.status !== "ok") {
    const detail = status.errors.map((entry) => entry.message).join("; ") || status.status;
    throw new Error(`storage root is not usable (${status.status}): ${detail}`);
  }
  const physicalRoot = status.root;
  const catalog = await listWorkspaces(physicalRoot);
  if (catalog.errors.length > 0 || catalog.invalid.length > 0) {
    throw new Error(
      "workspace catalog contains invalid potentially relevant state; refusing assignment lookup",
    );
  }
  const scanned = [];
  const byId = new Map();
  for (const workspace of catalog.valid) {
    const records = await readWorkspaceAssignments(physicalRoot, workspace);
    for (const entry of records) {
      const previous = byId.get(entry.record.assignment_id);
      if (previous !== undefined) {
        throw typedAssignmentError(
          "ASSIGNMENT_AMBIGUOUS",
          `assignment UUID ${entry.record.assignment_id} appears more than once (${previous.path} and ${entry.path})`,
        );
      }
      byId.set(entry.record.assignment_id, entry);
      scanned.push(entry);
    }
  }
  scanned.sort((left, right) =>
    left.record.created_at.localeCompare(right.record.created_at)
    || left.record.assignment_id.localeCompare(right.record.assignment_id));
  return scanned;
}

/**
 * List persisted assignments in one existing storage root without creating or
 * modifying anything. Invalid or duplicated records refuse the lookup rather
 * than being skipped.
 * @param {string} root
 * @param {string|null} [workspaceId]
 * @returns {Promise<object[]>} records sorted by created_at then id
 */
export async function listAssignments(root, workspaceId = null) {
  const scanned = await scanAssignmentRecords(root);
  let selected = scanned;
  if (workspaceId !== null && workspaceId !== undefined) {
    if (typeof workspaceId !== "string" || workspaceId === "") {
      throw new TypeError("workspaceId must be a non-empty string");
    }
    selected = scanned.filter((entry) => entry.record.workspace_id === workspaceId);
  }
  return selected.map((entry) => entry.record);
}

/**
 * Find exactly one persisted assignment by full UUID. A missing record throws
 * with code `ASSIGNMENT_MISSING`; duplicates refuse with
 * `ASSIGNMENT_AMBIGUOUS` from the global scan. Read-only.
 * @param {string} root
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function findAssignment(root, id) {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    throw new Error("assignment id must be an RFC4122 UUID");
  }
  const scanned = await scanAssignmentRecords(root);
  const matches = scanned.filter((entry) => entry.record.assignment_id === id);
  if (matches.length === 0) {
    throw typedAssignmentError("ASSIGNMENT_MISSING", `assignment is not present in ${root}: ${id}`);
  }
  if (matches.length > 1) {
    throw typedAssignmentError("ASSIGNMENT_AMBIGUOUS", `assignment is ambiguous in ${root}: ${id}`);
  }
  return matches[0].record;
}

// Launch under root ownership ----------------------------------------------

function approvalResult(result) {
  return {
    record: structuredClone(result.record),
    piArgs: [...result.piArgs],
    briefBytes: Buffer.from(result.briefBytes),
    contractDigest: result.contractDigest,
  };
}

// Accept only the exact internally generated resolution result, or resolve
// once and require the caller's expected digest. Forged, cloned or tampered
// results refuse before any write.
async function approveLaunchInput(input, resolved, expectedDigest) {
  if (resolved !== null && resolved !== undefined) {
    const receipt = typeof resolved === "object" && resolved !== null
      ? resolvedReceipts.get(resolved)
      : undefined;
    if (receipt === undefined) {
      throw new Error("resolved must be the exact result of a prior resolveAssignment call");
    }
    if (!isDeepStrictEqual(input, receipt.input)) {
      throw new Error("supplied input does not match the approved resolution input");
    }
    if (resolved.contractDigest !== receipt.contractDigest
      || !isDeepStrictEqual(resolved.record, receipt.record)
      || !isDeepStrictEqual(resolved.piArgs, receipt.piArgs)
      || !Buffer.isBuffer(resolved.briefBytes)
      || !resolved.briefBytes.equals(receipt.briefBytes)) {
      throw new Error("approved resolution result was altered after generation");
    }
    if (typeof expectedDigest !== "string" || expectedDigest === "") {
      throw new Error("expectedDigest is required even for an internally generated resolution");
    }
    if (expectedDigest !== receipt.contractDigest) {
      throw new Error("expectedDigest does not match the approved resolution");
    }
    return approvalResult(receipt);
  }
  if (expectedDigest === null || expectedDigest === undefined || expectedDigest === "") {
    throw new Error("expectedDigest is required when resolved is not supplied");
  }
  const generated = await resolveAssignment(input);
  if (generated.contractDigest !== expectedDigest) {
    throw new Error("expectedDigest does not match the resolved contract");
  }
  return approvalResult(generated);
}

function immutableFieldsEqual(existing, approved) {
  return IMMUTABLE_RECORD_FIELDS.every(
    (field) => isDeepStrictEqual(existing[field], approved[field]),
  );
}

function sameIdentity(left, right) {
  return left !== null && right !== null
    && typeof left === "object" && typeof right === "object"
    && left.pid === right.pid && left.started_at === right.started_at;
}

function observePersistedUpdate(record, observation) {
  return {
    ...record,
    state: observation.state,
    pi_identity: observation.piIdentity ?? record.pi_identity,
    pi_session_file: observation.sessionFile ?? record.pi_session_file,
    attention: mergeAttention(record.attention, observation.attention),
    updated_at: new Date().toISOString(),
  };
}

async function refuseObservedLock(lockPath, label) {
  let info;
  try {
    info = await lstatOrNull(lockPath);
  } catch (error) {
    throw new Error(`cannot observe ${label} at ${lockPath}: ${error.code ?? error.message}`);
  }
  if (info) throw new Error(`observed ${label} at ${lockPath}; refusing launch`);
}

// Read-only lease preflight: observe the spec_dispatch git lock and a supplied
// spec package's runtime package lock without taking, modifying or deleting
// either. A non-git workspace is allowed, but an existing unusable .git fails
// closed.
async function assertNoObservedLeases(record) {
  let checkout = null;
  try {
    checkout = await resolveCheckout(record.execution_dir, {
      deadline: Date.now() + GIT_TIMEOUT_MS,
    });
  } catch {
    checkout = null;
  }
  if (checkout !== null) {
    await refuseObservedLock(join(checkout.gitDir, "spec-runtime.lock"), "spec_dispatch git lease");
  } else {
    const dotGit = await lstatOrNull(join(record.execution_dir, ".git"));
    if (dotGit) {
      throw new Error(
        `execution directory has an unobservable .git at ${record.execution_dir}; refusing launch`,
      );
    }
  }
  if (record.spec_package !== null) {
    await refuseObservedLock(
      join(record.spec_package, "runtime", "package.lock"),
      "spec runtime package lease",
    );
  }
}

// Publish the durable launching reservation first, then the approved snapshot
// and the owned session directory. A later publication failure retains the
// reservation with a visible error and never spawns.
async function publishLaunchReservation({ workspace, record, briefBytes, self }) {
  const id = record.assignment_id;
  const assignmentsDir = join(workspace.directory, "assignments");
  const sessionsDir = join(workspace.directory, "sessions");
  const recordPath = join(assignmentsDir, `${id}.json`);
  const snapshotPath = join(assignmentsDir, `${id}.brief.md`);
  const sessionDir = join(sessionsDir, id);

  await ensureOwnedDirectory(assignmentsDir, "assignments directory");
  for (const [candidate, label] of [
    [recordPath, "assignment record"],
    [snapshotPath, "brief snapshot"],
    [sessionDir, "session directory"],
  ]) {
    const existing = await lstatOrNull(candidate);
    if (existing) throw new Error(`${label} already exists: ${candidate}`);
  }

  const launching = {
    ...record,
    state: "launching",
    launcher_identity: { pid: self.pid, started_at: self.started_at },
    updated_at: new Date().toISOString(),
  };
  await createFileExclusive(recordPath, JSON.stringify(launching));
  try {
    await createFileExclusive(snapshotPath, briefBytes);
    await ensureOwnedDirectory(sessionsDir, "sessions directory");
    await fs.mkdir(sessionDir, { mode: 0o700 });
    const created = await lstatOrNull(sessionDir);
    if (!created || created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error(`session directory was not created as a real directory: ${sessionDir}`);
    }
  } catch (error) {
    let retained = launching;
    try {
      retained = {
        ...launching,
        state: "launch_unknown",
        updated_at: new Date().toISOString(),
        attention: mergeAttention(launching.attention, [
          `launch publication failed: ${error.message}`,
        ]),
      };
      await writeFileAtomic(recordPath, JSON.stringify(retained));
    } catch {
      // The durable launching reservation is retained unchanged.
    }
    const failure = new Error(
      `launch publication failed after the durable reservation: ${error.message}`,
      { cause: error },
    );
    failure.record = retained;
    throw failure;
  }
  return { record: launching };
}

/**
 * Publish a durable launching reservation and start the approved Pi argv in
 * its owned tmux session exactly once.
 *
 * Approval: a supplied `resolved` must be the exact internally generated
 * resolveAssignment result (unchanged record/argv/bytes/digest) for a deeply
 * equal input; otherwise the assignment is resolved once and must match
 * `expectedDigest`. The root lease is held across scan, retry persistence and
 * publication and released before tmux spawn; it is reacquired and the
 * record's launch token and launcher identity re-checked before any late
 * write. Unknown or failed spawn observations persist fail-closed.
 *
 * @param {object} input resolution input
 * @param {{expectedDigest?: string|null, resolved?: object|null,
 *   adapters?: {tmuxRun?: Function, observationProbes?: object}}} [options]
 * @returns {Promise<object>} the persisted assignment record
 */
export async function launchAssignment(input = {}, options = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("input must be an object");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const adapters = options.adapters ?? {};
  const probes = adapters.observationProbes ?? {};
  const tmuxOptions = adapters.tmuxRun === undefined ? {} : { run: adapters.tmuxRun };

  const approved = await approveLaunchInput(
    input,
    options.resolved ?? null,
    options.expectedDigest ?? null,
  );
  const record = approved.record;
  const id = record.assignment_id;
  const storageRoot = await fs.realpath(
    resolve(requireNonEmptyString(input.storageRoot, "storageRoot")),
  );
  const self = processIdentity(process.pid);
  if (self === null) throw new Error("cannot observe this process identity; refusing launch");

  // Owned-path and canonical-target validation before any write.
  const workspace = await fetchWorkspace(storageRoot, record.workspace_id);
  if (record.storage_root !== storageRoot) {
    throw new Error("approved storage_root does not match the physical root");
  }
  if (record.workspace_directory !== workspace.directory) {
    throw new Error("approved workspace_directory does not match the owning workspace");
  }
  if (record.pi_session_dir !== join(workspace.directory, "sessions", id)) {
    throw new Error("approved pi_session_dir is not the owned session directory");
  }
  if (record.brief_snapshot !== join(workspace.directory, "assignments", `${id}.brief.md`)) {
    throw new Error("approved brief_snapshot is not the owned snapshot path");
  }
  const target = await resolveTarget({
    workspace,
    target: record.repository_id,
    specPackage: record.spec_package,
  });
  if (target.execution_dir !== record.execution_dir) {
    throw new Error("approved execution_dir is not the canonical target directory");
  }
  // Reuse the catalog's persisted-schema owner before acquiring a writing
  // claim. No approved preview may publish a record that later scans reject.
  await validateAssignmentRecord(
    storageRoot,
    workspace,
    join(workspace.directory, "assignments", `${id}.json`),
    { ...record, state: "launching", launcher_identity: self },
  );

  const claim = await acquireRootClaim(storageRoot);
  let plan = null;
  try {
    const records = await listAssignments(storageRoot);
    const existing = records.find((entry) => entry.assignment_id === id);
    if (existing) {
      if (existing.contract_digest === approved.contractDigest
        && immutableFieldsEqual(existing, record)) {
        return existing;
      }
      throw new Error(`assignment ${id} already exists with a different effective contract`);
    }

    let supersededId = null;
    if (record.attempt_kind === "launch-retry") {
      supersededId = record.supersedes;
      const old = records.find((entry) => entry.assignment_id === supersededId);
      if (!old) throw new Error(`launch-retry supersedes an unknown assignment: ${supersededId}`);
      if (old.execution_dir !== record.execution_dir) {
        throw new Error(
          "launch-retry must supersede an assignment in the same execution directory",
        );
      }
      const observation = await observeAssignment(old, probes);
      if (observation.gone !== true) {
        throw new Error(
          `launch-retry requires confirmed gone superseded assignment ${supersededId}`,
        );
      }
      await writeFileAtomic(
        join(old.workspace_directory, "assignments", `${supersededId}.json`),
        JSON.stringify(observePersistedUpdate(old, observation)),
      );
    }

    for (const entry of records) {
      if (entry.assignment_id === id || entry.assignment_id === supersededId) continue;
      if (entry.execution_dir === record.execution_dir && EXCLUSION_STATES.has(entry.state)) {
        throw new Error(
          `another ${entry.state} assignment reserves ${record.execution_dir}: ${entry.assignment_id}`,
        );
      }
    }

    // Observed lease refusal runs under the held claim, after the
    // identical-repeat return and exclusion checks, immediately before
    // publication.
    await assertNoObservedLeases(record);

    plan = await publishLaunchReservation({
      workspace,
      record,
      briefBytes: approved.briefBytes,
      self,
    });
  } finally {
    claim.release();
  }

  let spawned = null;
  let spawnError = null;
  try {
    spawned = await startSession({
      socketPath: plan.record.tmux_socket,
      sessionName: plan.record.tmux_session,
      cwd: plan.record.execution_dir,
      piPath: plan.record.pi_path,
      piArgs: approved.piArgs,
      assignmentId: id,
    }, tmuxOptions);
  } catch (error) {
    spawnError = error;
  }

  const claim2 = await acquireRootClaim(storageRoot);
  try {
    const records = await listAssignments(storageRoot);
    const current = records.find((entry) => entry.assignment_id === id);
    if (!current) {
      throw new Error("assignment record disappeared after publication; refusing a late update");
    }
    if (current.launch_token !== plan.record.launch_token
      || !sameIdentity(current.launcher_identity, plan.record.launcher_identity)) {
      throw new Error("assignment ownership changed after publication; refusing a late update");
    }
    let updated;
    if (spawnError === null) {
      updated = {
        ...current,
        state: "live",
        pane_id: spawned.paneId,
        pi_identity: spawned.piIdentity,
        updated_at: new Date().toISOString(),
      };
      const observation = await observeAssignment(updated, probes);
      if (observation.sessionFile) updated.pi_session_file = observation.sessionFile;
      if (observation.attention.length > 0) {
        updated.attention = mergeAttention(updated.attention, observation.attention);
      }
    } else {
      const observation = await observeAssignment(current, probes);
      updated = {
        ...current,
        state: observation.state,
        pi_identity: observation.piIdentity ?? current.pi_identity,
        pi_session_file: observation.sessionFile ?? current.pi_session_file,
        updated_at: new Date().toISOString(),
        attention: mergeAttention(current.attention, [
          ...observation.attention,
          `launch spawn failed: ${spawnError.message}`,
        ]),
      };
    }
    await writeFileAtomic(
      join(current.workspace_directory, "assignments", `${id}.json`),
      JSON.stringify(updated),
    );
    return updated;
  } finally {
    claim2.release();
  }
}

/**
 * Reconcile one persisted assignment under the root lease and persist only
 * owned observational fields: `state`, `pi_identity`, `pi_session_file`, a
 * recovered `pane_id`, `attention` and `updated_at`. A missing saved pane is
 * recovered from the real tmux probe only when the full UUID and the observed
 * live Pi PID match the pane PID; mismatched saved evidence is never adopted.
 *
 * @param {string} root
 * @param {string} id
 * @param {{adapters?: {tmuxRun?: Function, observationProbes?: object}}} [options]
 * @returns {Promise<object>} the persisted assignment record with attention
 */
export async function locateAssignment(root, id, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    throw new Error("assignment id must be an RFC4122 UUID");
  }
  const adapters = options.adapters ?? {};
  const probes = adapters.observationProbes ?? {};
  const tmuxOptions = adapters.tmuxRun === undefined ? {} : { run: adapters.tmuxRun };
  const storageRoot = await fs.realpath(resolve(requireNonEmptyString(root, "root")));

  const claim = await acquireRootClaim(storageRoot);
  try {
    const records = await listAssignments(storageRoot);
    const record = records.find((entry) => entry.assignment_id === id);
    if (!record) {
      throw typedAssignmentError(
        "ASSIGNMENT_MISSING",
        `assignment is not present in ${storageRoot}: ${id}`,
      );
    }
    const observation = await observeAssignment(record, probes);
    let paneId = record.pane_id ?? null;
    if (paneId === null) {
      const terminal = await probeSession(record, tmuxOptions);
      if (terminal.status === "present"
        && terminal.assignment_id === record.assignment_id
        && observation.piIdentity !== null
        && observation.piIdentity.pid === terminal.pid) {
        paneId = terminal.pane_id;
      }
    }
    const updated = {
      ...record,
      state: observation.state,
      pi_identity: observation.piIdentity ?? record.pi_identity,
      pi_session_file: observation.sessionFile ?? record.pi_session_file,
      pane_id: paneId,
      attention: mergeAttention(record.attention, observation.attention),
      updated_at: new Date().toISOString(),
    };
    await writeFileAtomic(
      join(record.workspace_directory, "assignments", `${id}.json`),
      JSON.stringify(updated),
    );
    return updated;
  } finally {
    claim.release();
  }
}

/**
 * Attach the current terminal to one live assignment's recorded tmux session.
 *
 * The UUID and TTY gate run before any root claim. `locateAssignment`
 * reconciles the record under the shared root claim and releases it, then the
 * live state, saved absolute socket and saved pane id are required, and the
 * full UUID ownership must be confirmed by `probeSession`, the recorded
 * pane must still resolve to the exact saved pane id and its pane
 * process must still be the exact reconciled Pi identity (transport failures
 * are unknown and never adopted; a dead, replaced or unknown pane process
 * refuses before the client starts). The returned argv comes from
 * `attachArgs` with the recorded socket and exact `=session` target; the tmux
 * client is spawned with an argument array, no shell, the caller's stdio and
 * no new-session/-A/kill/send-keys. The root claim is never held while the
 * attach client runs and no Pi process is ever signaled.
 *
 * @param {string} root
 * @param {string} id
 * @param {{isTTY?: boolean, stdio?: object|string, adapters?: object}} [options]
 * @returns {Promise<{exitCode: number|null, signal: string|null}>}
 */
export async function attachAssignment(root, id, { isTTY, stdio, adapters } = {}) {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    throw new Error("assignment id must be an RFC4122 UUID");
  }
  if (isTTY !== true) {
    throw new Error("attach requires a TTY on stdin and stdout");
  }
  const options = adapters ?? {};
  const reconciled = await locateAssignment(root, id, { adapters: options });
  if (reconciled.state !== "live") {
    throw new Error(`assignment is not live: ${id} (${String(reconciled.state)})`);
  }
  if (typeof reconciled.tmux_socket !== "string" || !isAbsolute(reconciled.tmux_socket)) {
    throw new Error(`assignment has no absolute tmux socket: ${id}`);
  }
  if (typeof reconciled.pane_id !== "string" || reconciled.pane_id === "") {
    throw new Error(`assignment has no saved pane identity: ${id}`);
  }
  const tmuxOptions = options.tmuxRun === undefined ? {} : { run: options.tmuxRun };
  const terminal = await probeSession(reconciled, tmuxOptions);
  if (terminal.status !== "present" || terminal.assignment_id !== id) {
    throw new Error(`assignment terminal ownership is not confirmed: ${id} (${terminal.reason ?? terminal.status})`);
  }
  if (terminal.pane_id !== reconciled.pane_id) {
    throw new Error(
      `assignment pane identity changed: ${id} (${terminal.pane_id} is not ${reconciled.pane_id})`,
    );
  }
  // A matching pane id is not enough: the live pane process must still be the
  // exact reconciled Pi process (same pid and start time). A mismatch or an
  // unknown identity refuses here, before the attach client starts; no
  // process is ever signaled.
  if (terminal.pid !== reconciled.pi_identity?.pid || !sameProcess(reconciled.pi_identity)) {
    throw new Error(
      `assignment pane process changed: ${id} (pane ${terminal.pane_id} no longer runs the reconciled Pi process)`,
    );
  }
  const argv = attachArgs({
    socketPath: reconciled.tmux_socket,
    sessionName: reconciled.tmux_session,
  });
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("tmux", argv, { stdio: stdio ?? "inherit" });
    child.on("error", rejectPromise);
    child.on("exit", (exitCode, signal) => resolvePromise({ exitCode, signal }));
  });
}
