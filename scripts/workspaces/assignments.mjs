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

import { assertNoAssignmentWorkers, subagentRoot } from "./worker-guard.mjs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inspectSpecWorktree, prepareSpecWorktree, specWorktreePath } from "../spec-location/worktree.mjs";
import { checkPackage, materialize } from "../spec-location/index.mjs";
import { resolveCheckout } from "../repo-search/identity.mjs";
import { processIdentity, sameProcess } from "../spec-observe/process-identity.mjs";
import { claimOwner } from "../spec-observe/owner-claim.mjs";
import { observeAssignment } from "./reconcile.mjs";
import { createReferenceCatalog } from "./references.mjs";
import {
  catalogEntries,
  createFileExclusive,
  fetchWorkspace,
  listWorkspaces,
  noteCatalogOmission,
  noteCatalogUnavailable,
  readCatalogFile,
  resolveRepositoryPath,
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
  "context_references",
  "skill",
  "skill_path",
  "instructions",
  "provider",
  "model",
  "thinking",
  "project_trust",
  "execution_dir",
  "execution_branch",
  "repository_id",
  "spec_package",
  "package_ref",
  "workflow_id",
  "publication_authority",
  "attempt_kind",
  "supersedes",
  "thread_id",
  "contract_digest",
  "tmux_socket",
  "tmux_session",
  "pi_path",
  "coordination_database",
  "pi_session_dir",
  "harness",
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
// Fixed harness enum and wrapper names. `pi` keeps the existing Pi argv;
// `claude`/`codex` resolve to the committed exec wrappers that add the
// unrestricted flags. The service never accepts an executable path.
const HARNESSES = new Map([
  ["pi", "pi"],
  ["claude", "clauded"],
  ["codex", "codexd"],
]);
// Claude owns a closed effort enum; Codex accepts any non-empty string.
const CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

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

async function resolveAgentExecutable(piPath, executableName) {
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
    const physical = await resolveExecutable(join(entry, executableName));
    if (physical !== null) return physical;
  }
  throw new Error(
    `${executableName} executable was not found on PATH; run ~/.agents/sync.sh to install it`,
  );
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
 * When `specPackage` is supplied (a `workspace/slug` reference, package
 * directory or file inside it), spec-location must accept it for this
 * workspace and the execution directory must be one of the package's target
 * worktrees or primary checkouts. The absolute package directory and its
 * reference are returned as `spec_package` and `package_ref`.
 *
 * @param {{workspace: object, target?: string|null, specPackage?: string|null}} input
 * @returns {Promise<{execution_dir: string, repository_id: string|null,
 *   spec_package: string|null, package_ref: string|null, attention: string[]}>}
 */
export async function resolveTarget({ workspace, target = null, specPackage = null, specWorktree = false } = {}) {
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
    const declared = resolveRepositoryPath(directory, record.path);
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
  let packageRef = null;
  let executionBranch = null;
  if (specPackage !== null && specPackage !== undefined) {
    if (typeof specPackage !== "string" || specPackage === "") {
      throw new Error("specPackage must be a non-empty string");
    }
    // Workspaces live at <storage root>/projects/<id>.
    const checked = await checkPackage(specPackage, { root: dirname(dirname(directory)) });
    if (!checked.ok) throw typedAssignmentError('spec-package-unavailable', `${checked.message} ${checked.remedy}`);
    const { locations } = checked;
    if (await fs.realpath(locations.workspace_dir) !== directory) {
      throw new Error("spec package belongs to a different workspace than the assignment");
    }
    const candidates = await Promise.all(
      locations.targets.flatMap((entry) => [entry.primary, entry.worktree])
        .filter(Boolean)
        .map((path) => fs.realpath(path).catch(() => null)),
    );
    if (!candidates.includes(executionDir)) {
      throw new Error(
        "execution directory is not a target worktree or primary checkout of the spec package",
      );
    }
    if (specWorktree) {
      const matches = locations.targets.filter(entry => entry.id === repositoryId);
      if (matches.length !== 1 || await fs.realpath(matches[0].primary) !== executionDir)
        throw typedAssignmentError('spec-worktree-unavailable', 'Choose a registered repository target of this spec package.');
      const prepared = inspectSpecWorktree(locations, matches[0]);
      executionDir = prepared.worktree;
      executionBranch = prepared.branch;
    }
    specPackagePath = await fs.realpath(locations.package_dir);
    packageRef = locations.package_ref;
  }

  return {
    execution_dir: executionDir,
    execution_branch: executionBranch,
    repository_id: repositoryId,
    spec_package: specPackagePath,
    package_ref: packageRef,
    attention,
  };
}

/** Explicit mutating preparation; previews and launch resolution remain read-only.
 * Browser callers supply repository/package identities, never paths or branches.
 * The launch lease serializes preparation with writer reservations.
 */
export async function prepareAssignmentSpecTarget({storageRoot, workspace_id, target, specPackage, supersedes = null, probes = {}}) {
  const claim = await acquireRootClaim(storageRoot);
  try {
    const workspace = await fetchWorkspace(storageRoot, workspace_id);
    // A package synced from another machine has no locations.json here. This is
    // the execution host and preparation already writes, so record its paths now.
    if (typeof specPackage === 'string' && specPackage !== '') {
      const checked = await checkPackage(specPackage, {root: storageRoot});
      if (!checked.ok && checked.code === 'locations-missing') await materialize(specPackage, {root: storageRoot});
    }
    const primary = await resolveTarget({workspace, target, specPackage});
    if (!primary.spec_package || !primary.repository_id)
      throw typedAssignmentError('spec-worktree-unavailable', 'Choose a spec package and its repository.');
    const checked = await checkPackage(primary.spec_package, {root: storageRoot});
    if (!checked.ok) throw typedAssignmentError('spec-package-unavailable', checked.message);
    const locations = checked.locations;
    const matches = locations.targets.filter(entry => entry.id === primary.repository_id);
    if (matches.length !== 1 || await fs.realpath(matches[0].primary) !== primary.execution_dir)
      throw typedAssignmentError('spec-worktree-unavailable', 'Spec target does not match the registered repository.');
    const destination = specWorktreePath(locations, matches[0]);
    const physicalDestination = await fs.realpath(destination).catch(() => resolve(destination));
    const records = await listAssignments(storageRoot);
    if (supersedes && records.some(entry => entry.supersedes === supersedes))
      throw typedAssignmentError('target-busy', 'This assignment already has a successor.');
    for (const entry of records) {
      const samePackage = entry.spec_package === primary.spec_package;
      if (!samePackage && entry.execution_dir !== physicalDestination) continue;
      if (samePackage) await assertNoAssignmentWorkers(entry);
      if (!EXCLUSION_STATES.has(entry.state)) continue;
      if (entry.assignment_id === supersedes && samePackage && entry.repository_id === target) {
        const observation = await observeAssignment(entry, probes);
        if (observation.gone === true) continue;
      }
      throw Object.assign(new Error('This spec package or worktree already has an assignment.'),
        {code:'target-busy', assignment_id:entry.assignment_id});
    }
    await assertNoActiveRun(primary);
    await assertNoAssignmentWorkers(primary);
    const prepared = await prepareSpecWorktree(locations, matches[0], {root:storageRoot, repairStamp:true});
    return {...primary, execution_dir:prepared.worktree, execution_branch:prepared.branch};
  } finally { claim.release(); }
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
export async function resolveAssignment(input = {}, options = {}) {
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
  const threadId = input.thread_id ?? null;
  if (threadId !== null && (typeof threadId !== "string" || !UUID_PATTERN.test(threadId))) {
    throw new Error(`thread_id must be a UUID: ${String(threadId)}`);
  }
  const workspaceId = requireNonEmptyString(input.workspace_id, "workspace_id");
  const brief = requireNonEmptyString(input.brief, "brief");
  const instructions = requireNonEmptyString(input.instructions, "instructions");
  const storageRoot = requireNonEmptyString(input.storageRoot, "storageRoot");

  // Fixed harness enum; absence/null normalize to Pi, anything else refuses
  // here at the input boundary before any setting-specific validation.
  const harnessInput = input.harness ?? null;
  let harness;
  if (harnessInput === null) {
    harness = "pi";
  } else if (typeof harnessInput === "string" && HARNESSES.has(harnessInput)) {
    harness = harnessInput;
  } else {
    throw new Error(`invalid harness: ${String(harnessInput)}`);
  }

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
  const thinking = input.thinking ?? null;
  if (thinking !== null && (typeof thinking !== "string" || thinking === "")) {
    throw new Error("thinking must be a non-empty string");
  }
  if (harness === "pi") {
    if ((provider === null) !== (model === null)) {
      throw new Error("provider and model must be supplied together");
    }
    if (thinking !== null) {
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
  } else {
    if (provider !== null) {
      throw new Error(`provider must be null for harness ${harness}`);
    }
    if (thinking !== null && harness === "claude" && !CLAUDE_EFFORT_LEVELS.has(thinking)) {
      throw new Error(
        `invalid thinking level: ${thinking} (valid: ${[...CLAUDE_EFFORT_LEVELS].join(", ")})`,
      );
    }
  }

  const projectTrust = input.project_trust ?? null;
  if (projectTrust !== null && typeof projectTrust !== "string") {
    throw new Error("project_trust must be a string");
  }
  if (harness !== "pi" && projectTrust !== null) {
    throw new Error(`project_trust must be null for harness ${harness}`);
  }
  const trustFlags = harness === "pi" ? projectTrustFlags(projectTrust) : [];

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
    specWorktree: true,
  });

  // Read the reviewed brief bytes once; the hash and returned bytes bind this
  // exact read, so later source edits cannot change the approved contract.
  const briefPath = await resolveWorkspacePath(workspace.directory, brief);
  const sourceBriefBytes = await fs.readFile(briefPath);
  const context = await (options.referenceCatalog ?? createReferenceCatalog({ home })).capture({
    workspace, executionDir: target.execution_dir, references: input.context_references ?? [],
  });
  const briefBytes = context.text ? Buffer.concat([sourceBriefBytes, Buffer.from(context.text)]) : sourceBriefBytes;
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
  const piPath = await resolveAgentExecutable(input.pi_path ?? null, HARNESSES.get(harness));
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
    target.package_ref,
    workflowId,
    publicationAuthority,
    attemptKind,
    supersedes,
    piPath,
    tmuxSocket,
    tmuxSession,
    coordinationDatabase,
    piSessionDir,
    harness,
  ];
  if (target.spec_package) canonical.push(target.execution_branch);
  const contractDigest = sha256Hex(Buffer.from(JSON.stringify(canonical), "utf8"));

  // The context block comes first so every harness sees exact paths and the
  // pre-computed first command before the request. It derives only from
  // digested fields plus the assignment id and snapshot path.
  const authorityMeaning = {
    none: "This launch grants no push or pull request.",
    "draft-pr": "You may push the branch and open a draft pull request.",
    pr: "You may push the branch and open a pull request ready for review.",
  }[publicationAuthority];
  const buildContext = (briefLine) => [
    "Assignment context",
    `- Assignment: ${assignmentId}. Its record is ${join(workspace.directory, "assignments", `${assignmentId}.json`)}; ` +
      "read it again if you lose earlier context.",
    `- Workspace: ${workspace.name} (${workspaceId}) at ${workspace.directory}. ` +
      "Workspace storage holds the kit, briefs, spec packages and sessions; code changes belong in the working directory.",
    target.repository_id === null
      ? `- Working directory: ${target.execution_dir} (the workspace directory; no repository target).`
      : `- Working directory: ${target.execution_dir} (repository ${target.repository_id} checkout).`,
    target.spec_package === null
      ? "- Spec package: none."
      : `- Spec package: ${target.package_ref} at ${target.spec_package}. ` +
        `First run \`node ${join(home, ".agents", "scripts", "spec-location", "cli.mjs")} check ${target.package_ref}\` ` +
        "and take every package path from its `locations`. Never copy package files into a checkout.",
    `- Brief: ${briefPath}. ${briefLine}`,
    `- Publication authority: ${publicationAuthority}. ${authorityMeaning} ` +
      "Merge and deployment are allowed only when the request grants them.",
    ...(workflowId === null ? [] : [`- Workflow: ${workflowId}.`]),
    ...(supersedes === null ? [] : [`- Retries assignment ${supersedes}.`]),
  ].join("\n");
  // Pi's @file prefix suppresses skill expansion and only a leading `/skill:`
  // triggers it, so the skill is delivered as a plain absolute-path
  // instruction for the model to read itself. Every prompt starts with the
  // fixed ordinary-text prefix "Assignment context", so user text beginning
  // with '-', '--' or '@' stays one message instead of an option, extension
  // flag or file argument in the installed Pi parseArgs.
  const requestText = skillPath === null
    ? `Request\nPerform this request:\n\n${instructions}`
    : `Request\nRead the skill at ${skillPath} and perform its instructions for this request.\n\n${instructions}`;
  const initialInstruction = `${buildContext(
    `The launch copy is attached above (${snapshotPath}); edit the source, not the copy.`,
  )}\n\n${requestText}`;
  // Non-Pi harnesses receive no attachment, so they are told to read the copy.
  const nonPiPrompt = `${buildContext(
    `Read the launch copy at ${snapshotPath}; edit the source, not the copy.`,
  )}\n\n${requestText}`;
  let piArgs;
  if (harness === "pi") {
    piArgs = [
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
  } else {
    const modelOptions = model === null ? [] : [`--model=${model}`];
    piArgs = harness === "claude"
      ? [
          "--session-id",
          assignmentId,
          ...modelOptions,
          ...(thinking === null ? [] : ["--effort", thinking]),
          nonPiPrompt,
        ]
      : [
          ...modelOptions,
          ...(thinking === null
            ? []
            : [
                "-c",
                // JSON.stringify leaves literal U+007F, which TOML basic
                // strings reject; the six-character \u007f escape is valid
                // TOML and preserves the value.
                `model_reasoning_effort=${JSON.stringify(thinking).replace(/\u007f/g, "\\u007f")}`,
              ]),
          nonPiPrompt,
        ];
  }

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
    execution_branch: target.execution_branch,
    repository_id: target.repository_id,
    spec_package: target.spec_package,
    package_ref: target.package_ref,
    // Resolution diagnostics are part of the record but not of the canonical
    // contract digest above.
    attention: target.attention,
    workflow_id: workflowId,
    publication_authority: publicationAuthority,
    attempt_kind: attemptKind,
    supersedes,
    thread_id: threadId,
    contract_digest: contractDigest,
    tmux_socket: tmuxSocket,
    tmux_session: tmuxSession,
    pi_path: piPath,
    coordination_database: coordinationDatabase,
    pi_session_dir: piSessionDir,
    harness,
    pi_session_file: null,
    ...(context.references.length ? { context_references: context.references.map(({ content, ...ref }) => ref) } : {}),
    launcher_identity: null,
    launch_token: randomUUID(),
    state: "preview",
    created_at: timestamp,
    updated_at: timestamp,
  };

  const result = { record, piArgs, briefBytes, contractDigest,
    inputPreview: {
      brief: briefBytes.toString('utf8'),
      instruction: harness === "pi" ? initialInstruction : nonPiPrompt,
      references: context.references,
    },
  };
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
  // Origin thread is optional: a record persisted before thread_id existed
  // reads as legacy data and is never rewritten; an explicit non-null value
  // must be an RFC4122 UUID.
  const persistedThreadId = record.thread_id === undefined ? null : record.thread_id;
  if (persistedThreadId !== null
    && (typeof persistedThreadId !== "string" || !UUID_PATTERN.test(persistedThreadId))) {
    refuseAssignment(path, "thread_id is not an RFC4122 UUID");
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
  // Persisted harness: absence is interpreted locally as legacy Pi without
  // mutating the returned record; explicit null or an unknown value refuses.
  const persistedHarness = record.harness === undefined ? "pi" : record.harness;
  if (typeof persistedHarness !== "string" || !HARNESSES.has(persistedHarness)) {
    refuseAssignment(
      path,
      `harness ${JSON.stringify(record.harness)} is not a known harness`,
    );
  }
  if (persistedHarness === "pi") {
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
  } else {
    if (record.provider !== null) {
      refuseAssignment(path, "provider must be null for a non-Pi harness");
    }
    if (record.project_trust !== null) {
      refuseAssignment(path, "project_trust must be null for a non-Pi harness");
    }
    if (record.model !== null && (typeof record.model !== "string" || record.model === "")) {
      refuseAssignment(path, "model must be null or a non-empty string");
    }
    if (record.thinking !== null && (typeof record.thinking !== "string" || record.thinking === "")) {
      refuseAssignment(path, "thinking must be null or a non-empty string");
    }
    if (persistedHarness === "claude"
      && record.thinking !== null && !CLAUDE_EFFORT_LEVELS.has(record.thinking)) {
      refuseAssignment(path, "thinking is not a supported Claude effort level");
    }
  }
  if (record.repository_id !== null
    && (typeof record.repository_id !== "string" || record.repository_id === "")) {
    refuseAssignment(path, "repository_id is neither null nor a non-empty string");
  }
  if (record.spec_package !== null
    && (typeof record.spec_package !== "string" || !isAbsolute(record.spec_package))) {
    refuseAssignment(path, "spec_package is neither null nor an absolute path");
  }
  if (record.package_ref !== undefined && record.package_ref !== null
    && (typeof record.package_ref !== "string" || record.package_ref === "")) {
    refuseAssignment(path, "package_ref is neither null nor a non-empty string");
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
async function readWorkspaceAssignments(physicalRoot, workspace, budget = null, candidates = null) {
  const directory = join(workspace.directory, "assignments");
  if (budget !== null) {
    let lookup;
    try {
      lookup = await lstatOrNull(directory);
    } catch (error) {
      noteCatalogOmission(
        budget,
        `assignments-directory-unavailable:${directory}:${error.code ?? error.message}`,
      );
      return;
    }
    if (lookup === null) return;
    await readWorkspaceAssignmentsBounded(
      physicalRoot, workspace, directory, lookup, budget, candidates,
    );
    return;
  }
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

// Shared bounded row candidates: at most maxRows entries are retained, every
// seen id stays tracked so a duplicate removes the selected matching row even
// when the first occurrence was dropped at the row limit, and dropping any
// candidate marks the scan truncated.
function offerAssignmentCandidate(state, budget, entry) {
  const id = entry.record.assignment_id;
  if (state.duplicates.has(id)) return;
  if (state.seen.has(id)) {
    state.duplicates.add(id);
    state.candidates.delete(id);
    noteCatalogUnavailable(budget, `assignment-duplicate:${id}`);
    return;
  }
  state.seen.add(id);
  if (state.candidates.size >= budget.maxRows) {
    noteCatalogOmission(budget, "row-budget-exhausted");
    return;
  }
  state.candidates.set(id, entry);
}

// Opt-in bounded variant: directory entries and file bytes charge the shared
// budget, and unreadable, malformed or schema-invalid records are reported
// through the budget instead of refusing the whole lookup. Valid records are
// offered to the shared candidate state, which keeps at most `maxRows`
// candidates while the scan continues (within the entry and byte budgets) to
// detect duplicates, including ids whose first occurrence was dropped.
async function readWorkspaceAssignmentsBounded(physicalRoot, workspace, directory, lookup, budget, candidates) {
  if (lookup.isSymbolicLink() || !lookup.isDirectory()) {
    noteCatalogOmission(budget, `assignments-directory-unavailable:${directory}`);
    return;
  }
  let physical;
  try {
    physical = await fs.realpath(directory);
  } catch (error) {
    noteCatalogOmission(
      budget,
      `assignments-directory-unavailable:${directory}:${error.code ?? error.message}`,
    );
    return;
  }
  if (physical !== directory) {
    noteCatalogOmission(budget, `assignments-directory-unavailable:${directory}`);
    return;
  }
  try {
    for await (const entry of catalogEntries(directory, budget)) {
      if (!entry.name.endsWith(".json")) continue;
      const path = join(directory, entry.name);
      const read = await readCatalogFile(path, budget);
      if (!read.ok) {
        noteCatalogUnavailable(budget, `assignment-unavailable:${path}:${read.reason}`);
        if (read.exhausted === true) break;
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(read.text);
      } catch {
        noteCatalogUnavailable(budget, `assignment-malformed:${path}`);
        continue;
      }
      let record;
      try {
        record = await validateAssignmentRecord(physicalRoot, workspace, path, parsed);
      } catch (error) {
        noteCatalogUnavailable(
          budget,
          `assignment-invalid:${path}:${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      offerAssignmentCandidate(candidates, budget, { record, path });
    }
  } catch (error) {
    noteCatalogOmission(
      budget,
      `assignments-directory-unreadable:${directory}:${error.code ?? error.message}`,
    );
  }
}

// Read-only global scan: the root must pass storage status, the catalog may
// not contain invalid potentially relevant state, and a duplicated assignment
// UUID refuses before any workspace filter. Results are sorted by created_at
// then assignment id.
async function scanAssignmentRecords(root, budget = null) {
  if (typeof root !== "string" || root === "") {
    throw new TypeError("root must be a non-empty string");
  }
  if (budget !== null) return scanAssignmentRecordsBounded(root, budget);
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

// Opt-in bounded scan: retains valid rows up to maxRows, reports malformed,
// invalid and duplicate records as unavailable through the budget, and leaves
// the omission count unknown on truncation. Never writes.
async function scanAssignmentRecordsBounded(root, budget) {
  const status = await storageStatus(root);
  if (status.status !== "ok") {
    noteCatalogOmission(budget, `storage-${status.status}`);
    return [];
  }
  const physicalRoot = status.root;
  const catalog = await listWorkspaces(physicalRoot, { budget });
  for (const problem of catalog.errors) {
    noteCatalogUnavailable(budget, `catalog-unreadable:${problem.path}`);
  }
  for (const entry of catalog.invalid) {
    noteCatalogUnavailable(
      budget,
      `workspace-unavailable:${entry.directory}:${entry.errors.join("; ")}`,
    );
  }
  if (catalog.errors.length > 0 || catalog.invalid.length > 0) {
    noteCatalogOmission(budget, "catalog-incomplete");
  }
  const state = { candidates: new Map(), seen: new Set(), duplicates: new Set() };
  for (const workspace of catalog.valid) {
    if (budget.entries >= budget.maxEntries) {
      noteCatalogOmission(budget, "entry-budget-exhausted");
      break;
    }
    if (budget.bytes >= budget.maxTotalBytes) {
      noteCatalogOmission(budget, "byte-budget-exhausted");
      break;
    }
    await readWorkspaceAssignments(physicalRoot, workspace, budget, state);
  }
  const scanned = [...state.candidates.values()];
  scanned.sort((left, right) =>
    left.record.created_at.localeCompare(right.record.created_at)
    || left.record.assignment_id.localeCompare(right.record.assignment_id));
  budget.rows = scanned.length;
  return scanned;
}

/**
 * List persisted assignments in one existing storage root without creating or
 * modifying anything. Invalid or duplicated records refuse the lookup rather
 * than being skipped.
 * @param {string} root
 * @param {string|null} [workspaceId]
 * @param {{budget?: object}} [options] optional shared budget from
 *   `createCatalogReadBudget`; with a budget malformed, invalid and duplicate
 *   records are reported as unavailable through the budget instead of
 *   refusing the lookup
 * @returns {Promise<object[]>} records sorted by created_at then id
 */
export async function listAssignments(root, workspaceId = null, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("listAssignments options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (key !== "budget") throw new Error(`listAssignments does not accept option ${key}`);
  }
  const budget = options.budget ?? null;
  if (budget !== null && (typeof budget !== "object" || Array.isArray(budget))) {
    throw new TypeError("listAssignments budget must be a catalog read budget");
  }
  const scanned = await scanAssignmentRecords(root, budget);
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
  return IMMUTABLE_RECORD_FIELDS.every((field) => {
    if (field === 'thread_id') {
      // Optional origin thread: a retained record missing thread_id equals an
      // approved null (and vice versa); differing UUIDs stay unequal.
      return (existing.thread_id ?? null) === (approved.thread_id ?? null);
    }
    return field === 'execution_branch' && !existing.spec_package && !approved.spec_package
      ? (existing[field] ?? null) === (approved[field] ?? null)
      : isDeepStrictEqual(existing[field], approved[field]);
  });
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

// Refuse a launch into a spec package whose current run still has a live
// coordinator, the same check spec_dispatch applies.
async function assertNoActiveRun(record) {
  if (record.spec_package === null) return;
  let run;
  try {
    run = JSON.parse(await fs.readFile(join(record.spec_package, "runtime", "run.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error(`cannot read spec run state at ${record.spec_package}: ${error.code ?? error.message}`);
  }
  if (!["running", "cancelling", "blocked"].includes(run.state)) return;
  const pid = run.coordinator_pid ?? run.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Spec coordinator identity is unavailable.");
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw new Error("Spec coordinator status is unavailable.");
  }
  throw Object.assign(
    new Error(`run-active: spec run ${run.id} is ${run.state} and its coordinator (pid ${pid}) is alive; refusing launch`),
    { code: "run-active", run_id: run.id, pid },
  );
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
    subagent_async_root: subagentRoot(),
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
    specWorktree: true,
  });
  if (target.package_ref !== record.package_ref) {
    throw new Error("approved package_ref is not the canonical package reference");
  }
  if (target.execution_dir !== record.execution_dir || target.execution_branch !== record.execution_branch) {
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

    // Preparation uses this same lease; recheck the exact approved target after
    // waiting for it so another preparation cannot retarget this reservation.
    const lockedTarget = await resolveTarget({workspace, target:record.repository_id,
      specPackage:record.spec_package, specWorktree:true});
    if (lockedTarget.execution_dir !== record.execution_dir || lockedTarget.execution_branch !== record.execution_branch
      || lockedTarget.spec_package !== record.spec_package || lockedTarget.package_ref !== record.package_ref)
      throw typedAssignmentError('stale-preview', 'The prepared spec target changed. Preview again.');
    let supersededId = null;
    if (record.attempt_kind === "launch-retry") {
      supersededId = record.supersedes;
      const successor = records.find(entry => entry.supersedes === supersededId);
      if (successor) throw new Error(`Assignment already relaunched as ${successor.assignment_id}; inspect that attempt.`);
      const old = records.find((entry) => entry.assignment_id === supersededId);
      if (!old) throw new Error(`launch-retry supersedes an unknown assignment: ${supersededId}`);
      if (old.execution_dir !== record.execution_dir && !(old.spec_package
        && old.spec_package === record.spec_package && old.repository_id === record.repository_id
        && old.workspace_id === record.workspace_id)) {
        throw new Error(
          "launch-retry must preserve its execution directory or its canonical spec target",
        );
      }
      await assertNoAssignmentWorkers(old);
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
      if (record.spec_package && entry.spec_package === record.spec_package) await assertNoAssignmentWorkers(entry);
      if ((entry.execution_dir === record.execution_dir
        || (record.spec_package && entry.spec_package === record.spec_package)) && EXCLUSION_STATES.has(entry.state)) {
        throw Object.assign(
          new Error(
            `another ${entry.state} assignment reserves ${record.execution_dir}: ${entry.assignment_id}`,
          ),
          { code: "target-busy", assignment_id: entry.assignment_id },
        );
      }
    }

    // Runs under the held claim, after the identical-repeat return and
    // exclusion checks, immediately before publication.
    await assertNoActiveRun(record);
    await assertNoAssignmentWorkers(record);

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
      specPackage: plan.record.spec_package,
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
        tmux_server_identity: spawned.serverIdentity ?? null,
        launch_completed_at: new Date().toISOString(),
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
        // The spawn call has finished, even when the long-lived host remains
        // alive. Preserve the reservation without claiming launch is ongoing.
        state: observation.state === "launching" ? "launch_unknown" : observation.state,
        pi_identity: observation.piIdentity ?? current.pi_identity,
        pi_session_file: observation.sessionFile ?? current.pi_session_file,
        updated_at: new Date().toISOString(),
        attention: mergeAttention(current.attention, [
          `launch spawn failed: ${spawnError.message}`,
          ...observation.attention,
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
