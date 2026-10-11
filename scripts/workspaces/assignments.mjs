// Bounded assignment resolution for Adjacent tmux launches.
//
// Node-standard-library only. `resolveTarget` selects the physical execution
// directory for a workspace or one of its kit repositories and checks a
// supplied spec package against that checkout's canonical git common
// directory. `resolveAssignment` validates the immutable launch contract,
// reads the reviewed brief bytes once, derives the fixed-order canonical
// digest and the Pi argument array, and returns the preview record.
//
// Both functions are read-only: they create, modify and delete nothing. The
// caller owns snapshot publication (assignments/<id>.brief.md), session
// directory creation and record persistence.

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { canonicalPackage } from "../../pi/extensions/spec-runtime/runtime.mjs";
import { resolveCheckout } from "../repo-search/identity.mjs";
import { fetchWorkspace, resolveWorkspacePath } from "./store.mjs";

const GIT_TIMEOUT_MS = 5000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PUBLICATION_AUTHORITIES = new Set(["none", "draft-pr", "pr"]);
const ATTEMPT_KINDS = new Set(["initial", "launch-retry"]);

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

/**
 * Resolve the physical execution directory for a workspace target.
 *
 * A null/undefined `target` selects the workspace directory itself. A string
 * `target` must match exactly one retained kit repository whose recorded
 * status is `ok`; the declared path (absolute or workspace-relative) is
 * resolved to its physical checkout root through `resolveCheckout`.
 * Workspace and repository attention entries are preserved.
 *
 * When `specPackage` is supplied, `canonicalPackage` must resolve it to the
 * primary checkout of the execution directory's repository; the canonical
 * package path is returned as `spec_package`.
 *
 * @param {{workspace: object, target?: string|null, specPackage?: string|null}} input
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
    if (typeof target !== "string" || target === "") {
      throw new Error("target must be a repository id string");
    }
    const matches = (Array.isArray(workspace.repositories) ? workspace.repositories : [])
      .filter((record) => record && record.id === target);
    if (matches.length === 0) {
      throw new Error(`repository is not available in workspace: ${target}`);
    }
    if (matches.length > 1) throw new Error(`repository is ambiguous: ${target}`);
    const record = matches[0];
    if (record.status !== "ok") {
      throw new Error(`repository is not usable: ${target} (${String(record.status)})`);
    }
    if (typeof record.path !== "string" || record.path === "") {
      throw new Error(`repository path is missing: ${target}`);
    }
    const declared = isAbsolute(record.path)
      ? resolve(record.path)
      : resolve(directory, record.path);
    let physical;
    try {
      physical = await fs.realpath(declared);
    } catch (error) {
      throw new Error(`repository path is not resolvable: ${target}`, { cause: error });
    }
    let identity;
    try {
      identity = await resolveCheckout(physical, { deadline: Date.now() + GIT_TIMEOUT_MS });
    } catch (error) {
      throw new Error(`repository is not a Git work tree: ${target}`, { cause: error });
    }
    if (identity.root !== physical) {
      throw new Error(`repository path is not a Git top level: ${target}`);
    }
    checkout = identity;
    executionDir = identity.root;
    repositoryId = target;
    attention = mergeAttention(attention, record.attention);
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
  const tmuxSocket = optionalNonEmptyString(input.tmux_socket, "tmux_socket", "adjacent");
  const tmuxSession = optionalNonEmptyString(
    input.tmux_session,
    "tmux_session",
    `adj-${assignmentId.replace(/-/g, "").slice(0, 12)}`,
  );
  const piPath = await resolvePiExecutable(input.pi_path ?? null);
  const coordinationDatabase = optionalNonEmptyString(
    input.coordination_database,
    "coordination_database",
    join(storageRootPhysical, ".sentinel", "coordination.sqlite"),
  );
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
  // instruction for the model to read itself.
  const initialInstruction = skillPath === null
    ? `${instructions}\n\n${assignmentBlock}`
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

  return { record, piArgs, briefBytes, contractDigest };
}
