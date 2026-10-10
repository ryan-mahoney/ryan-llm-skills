// Workspace store filesystem primitives: exclusive creation, atomic replacement
// and contained existing-path resolution.
//
// Node-standard-library only. This module owns no store layout, kit schema or
// CLI behavior. Callers own replacement serialization: only one writer may
// replace a given target at a time, and ancestor directories are assumed stable
// during a call (a hostile process that swaps an ancestor can defeat the
// rechecks). Publication fsyncs only the temporary file: there is no directory
// fsync and no power-loss durability claim.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseKit } from "./kit.mjs";
import { resolveCheckout } from "../repo-search/identity.mjs";

const TEMP_PREFIX = ".workspace-publish-";
const TEMP_SUFFIX = ".tmp";

function toBytes(bytes) {
  if (typeof bytes === "string") return Buffer.from(bytes, "utf8");
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  throw new TypeError("bytes must be a string, Buffer or Uint8Array");
}

async function lstatOrNull(path) {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

// The parent must exist, be a real directory and contain no symlinked
// component; the returned final path points into the physical parent.
async function physicalParent(target) {
  const absolute = resolve(target);
  const name = basename(absolute);
  if (!name || name === "." || name === "..") {
    throw new Error(`target must name a file: ${target}`);
  }
  const parent = dirname(absolute);
  const info = await lstatOrNull(parent);
  if (!info) throw new Error(`parent directory does not exist: ${parent}`);
  if (info.isSymbolicLink()) throw new Error(`parent directory must not be a symlink: ${parent}`);
  if (!info.isDirectory()) throw new Error(`parent is not a directory: ${parent}`);
  const physical = await fs.realpath(parent);
  if (physical !== resolve(parent)) {
    throw new Error(`parent path contains a symbolic link: ${parent}`);
  }
  return { parent: physical, final: join(physical, name) };
}

async function recheckParent(target, expectedParent) {
  const current = await physicalParent(target);
  if (current.parent !== expectedParent) {
    throw new Error(`parent directory changed during publication: ${expectedParent}`);
  }
  return current.final;
}

async function assertCreateTarget(final) {
  const info = await lstatOrNull(final);
  if (!info) return;
  const error = new Error(`target already exists: ${final}`);
  error.code = "EEXIST";
  throw error;
}

async function assertReplaceTarget(final) {
  const info = await lstatOrNull(final);
  if (info && !info.isFile()) {
    throw new Error(`replacement target is not a regular file: ${final}`);
  }
}

async function publishExclusive(temporary, final) {
  await assertCreateTarget(final);
  await fs.link(temporary, final);
}

async function publishReplacement(temporary, final) {
  await assertReplaceTarget(final);
  await fs.rename(temporary, final);
}

// Shared open/write/sync/close/publish/cleanup routine. The temporary file is
// removed in finally only when this invocation created it, never by pattern.
async function publishBytes(target, bytes, publish) {
  if (typeof target !== "string") throw new TypeError("target path must be a string");
  if (target === "") throw new Error("target path must not be empty");
  if (target.includes("\0")) throw new Error("target path must not contain NUL");
  const payload = toBytes(bytes);
  const { parent } = await physicalParent(target);
  const temporary = join(parent, `${TEMP_PREFIX}${randomUUID()}${TEMP_SUFFIX}`);
  let handle = null;
  let owned = false;
  let primaryError = null;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    owned = true;
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = null;
    const final = await recheckParent(target, parent);
    await publish(temporary, final);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // Preserve the original failure over a cleanup-only close failure.
      }
    }
    if (owned) {
      try {
        await fs.unlink(temporary);
      } catch (cleanupError) {
        if ((!cleanupError || cleanupError.code !== "ENOENT") && !primaryError) {
          throw cleanupError;
        }
      }
    }
  }
}

/**
 * Create a file exclusively: publish complete `bytes` from a same-directory
 * `wx` 0600 temporary after syncing, then hard-link it to `path` so an existing
 * target is never replaced (`EEXIST`). Parents must already exist.
 * @param {string} path
 * @param {string|Buffer|Uint8Array} bytes
 * @returns {Promise<void>}
 */
export async function createFileExclusive(path, bytes) {
  return publishBytes(path, bytes, publishExclusive);
}

/**
 * Atomically replace (or create) a file by renaming a synced same-directory
 * 0600 temporary over `path`. A present non-regular or symlink target is
 * refused; a missing target is allowed. Callers own serialization.
 * @param {string} path
 * @param {string|Buffer|Uint8Array} bytes
 * @returns {Promise<void>}
 */
export async function writeFileAtomic(path, bytes) {
  return publishBytes(path, bytes, publishReplacement);
}

// Reject a relative reference before any normalization so no absolute, empty,
// dot, dotdot, backslash or NUL segment can reach the filesystem walk.
function relativeSegments(relative) {
  if (typeof relative !== "string") throw new TypeError("relative path must be a string");
  if (relative === "") throw new Error("relative path must not be empty");
  if (isAbsolute(relative)) throw new Error("relative path must not be absolute");
  if (relative.includes("\0")) throw new Error("relative path must not contain NUL");
  if (relative.includes("\\")) throw new Error("relative path must not contain backslashes");
  const segments = relative.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`relative path contains an invalid segment: ${JSON.stringify(segment)}`);
    }
  }
  return segments;
}

async function physicalBase(base) {
  if (typeof base !== "string") throw new TypeError("base must be a string");
  const absolute = resolve(base);
  const info = await lstatOrNull(absolute);
  if (!info) throw new Error(`base directory does not exist: ${absolute}`);
  if (info.isSymbolicLink()) throw new Error(`base directory must not be a symlink: ${absolute}`);
  if (!info.isDirectory()) throw new Error(`base is not a directory: ${absolute}`);
  const physical = await fs.realpath(absolute);
  if (physical !== absolute) {
    throw new Error(`base path contains a symbolic link: ${absolute}`);
  }
  return physical;
}

/**
 * Resolve an existing path strictly inside `base`. Every referenced component
 * is lstat-checked for symlinks, intermediate components must be directories,
 * and the physical target must stay under the physical base.
 * @param {string} base
 * @param {string} relative
 * @returns {Promise<string>}
 */
export async function resolveWorkspacePath(base, relative) {
  const segments = relativeSegments(relative);
  const physical = await physicalBase(base);
  let current = physical;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const info = await lstatOrNull(current);
    if (!info) throw new Error(`path does not exist: ${relative}`);
    if (info.isSymbolicLink()) throw new Error(`path component must not be a symlink: ${relative}`);
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error(`intermediate path component is not a directory: ${relative}`);
    }
  }
  const target = await fs.realpath(current);
  const prefix = physical.endsWith(sep) ? physical : `${physical}${sep}`;
  if (target === physical || !target.startsWith(prefix)) {
    throw new Error(`path escapes the workspace base: ${relative}`);
  }
  return target;
}

// Read-only storage root resolution, storage status and catalog identity.
// These functions create, modify and lock nothing; catalog reads never run git.

const STORAGE_PERMISSION_CODES = new Set(["EACCES", "EPERM"]);

function isStoragePermissionError(error) {
  return Boolean(error) && STORAGE_PERMISSION_CODES.has(error.code);
}

function storageError(path, error) {
  return { path, message: error instanceof Error ? error.message : String(error) };
}

async function storageLstat(path) {
  try {
    return { info: await fs.lstat(path) };
  } catch (error) {
    if (error && error.code === "ENOENT") return { info: null };
    if (isStoragePermissionError(error)) return { permission: error };
    throw error;
  }
}

/**
 * Resolve the storage root: an absolute `ADJACENT_STORAGE_ROOT` wins
 * unchanged, otherwise `<home>/Documents/adjacent-storage`. Relative
 * overrides are refused; nothing is created.
 * @param {{ADJACENT_STORAGE_ROOT?: string}} env
 * @param {string} home
 * @returns {string}
 */
export function resolveStorageRoot(env, home) {
  const configured = env ? env.ADJACENT_STORAGE_ROOT : undefined;
  if (configured === undefined || configured === null || configured === "") {
    return join(home, "Documents", "adjacent-storage");
  }
  if (!isAbsolute(configured)) {
    throw new Error("ADJACENT_STORAGE_ROOT must be an absolute path");
  }
  return configured;
}

/**
 * Read-only storage status: reports the first unusable boundary without
 * creating or modifying anything.
 * @param {string} root
 * @returns {Promise<{root: string, status: string,
 *   errors: {path: string, message: string}[]}>}
 */
export async function storageStatus(root) {
  if (typeof root !== "string" || root === "") {
    throw new TypeError("root must be a non-empty string");
  }
  const absolute = resolve(root);

  const rootLookup = await storageLstat(absolute);
  if (rootLookup.permission) {
    return {
      root: absolute,
      status: "unreadable",
      errors: [storageError(absolute, rootLookup.permission)],
    };
  }
  if (rootLookup.info === null) return { root: absolute, status: "missing_root", errors: [] };
  if (rootLookup.info.isSymbolicLink() || !rootLookup.info.isDirectory()) {
    return {
      root: absolute,
      status: "invalid_root",
      errors: [{ path: absolute, message: "root is not a real directory" }],
    };
  }
  if ((await fs.realpath(absolute)) !== absolute) {
    return {
      root: absolute,
      status: "invalid_root",
      errors: [{ path: absolute, message: "root path contains a symbolic link" }],
    };
  }

  let rootHandle;
  try {
    rootHandle = await fs.opendir(absolute);
  } catch (error) {
    if (isStoragePermissionError(error)) {
      return { root: absolute, status: "unreadable", errors: [storageError(absolute, error)] };
    }
    throw error;
  }
  await rootHandle.close();

  const projects = join(absolute, "projects");
  const projectsLookup = await storageLstat(projects);
  if (projectsLookup.permission) {
    return {
      root: absolute,
      status: "unreadable",
      errors: [storageError(projects, projectsLookup.permission)],
    };
  }
  if (projectsLookup.info === null) {
    return { root: absolute, status: "missing_projects", errors: [] };
  }
  if (projectsLookup.info.isSymbolicLink() || !projectsLookup.info.isDirectory()) {
    return {
      root: absolute,
      status: "invalid_projects",
      errors: [{ path: projects, message: "projects is not a real directory" }],
    };
  }
  if ((await fs.realpath(projects)) !== resolve(projects)) {
    return {
      root: absolute,
      status: "invalid_projects",
      errors: [{ path: projects, message: "projects path contains a symbolic link" }],
    };
  }

  let projectsHandle;
  try {
    projectsHandle = await fs.opendir(projects);
  } catch (error) {
    if (isStoragePermissionError(error)) {
      return { root: absolute, status: "unreadable", errors: [storageError(projects, error)] };
    }
    return { root: absolute, status: "invalid_projects", errors: [storageError(projects, error)] };
  }
  await projectsHandle.close();
  return { root: absolute, status: "ok", errors: [] };
}

async function readWorkspaceEntry(projectsDir, directoryName) {
  const directory = join(projectsDir, directoryName);
  const directoryLookup = await storageLstat(directory);
  if (directoryLookup.permission) {
    return { invalid: { directory, errors: [directoryLookup.permission.message] } };
  }
  if (directoryLookup.info === null) {
    return { invalid: { directory, errors: ["workspace directory is missing"] } };
  }
  if (directoryLookup.info.isSymbolicLink() || !directoryLookup.info.isDirectory()) {
    return { invalid: { directory, errors: ["workspace is not a real directory"] } };
  }

  const kitPath = join(directory, "kit.yaml");
  const kitLookup = await storageLstat(kitPath);
  if (kitLookup.permission) {
    return { invalid: { directory, errors: [kitLookup.permission.message] } };
  }
  if (kitLookup.info === null) {
    return { invalid: { directory, errors: ["kit.yaml is missing"] } };
  }
  if (kitLookup.info.isSymbolicLink() || !kitLookup.info.isFile()) {
    return { invalid: { directory, errors: ["kit.yaml is not a regular file"] } };
  }

  let text;
  try {
    text = await fs.readFile(kitPath, "utf8");
  } catch (error) {
    return {
      invalid: { directory, errors: [error instanceof Error ? error.message : String(error)] },
    };
  }
  const parsed = parseKit(text);
  if (!parsed.ok) return { invalid: { directory, errors: parsed.errors } };
  const { kit } = parsed;
  if (typeof kit.id !== "string" || kit.id === "") {
    return { invalid: { directory, errors: ["kit id is missing"] } };
  }
  const displayName = typeof kit.name === "string" && kit.name !== "" ? kit.name : kit.id;
  return {
    valid: {
      id: kit.id,
      name: displayName,
      directory,
      kit: {
        version: kit.version,
        id: kit.id,
        name: kit.name,
        repositories: kit.repositories.map((repository) => ({ ...repository })),
        context: [...kit.context],
      },
      attention: directoryName === kit.id ? [] : ["directory_mismatch"],
    },
  };
}

/**
 * Read-only workspace catalog: invalid manifests and duplicate ids are
 * retained with their source paths. Nothing is created and no git runs.
 * @param {string} root
 * @returns {Promise<{valid: object[], invalid: {directory: string, errors: string[]}[],
 *   errors: {path: string, message: string}[]}>}
 */
export async function listWorkspaces(root) {
  if (typeof root !== "string" || root === "") {
    throw new TypeError("root must be a non-empty string");
  }
  const rootPath = resolve(root);
  const valid = [];
  const invalid = [];
  const errors = [];

  const status = await storageStatus(rootPath);
  if (status.status !== "ok") {
    if (status.errors.length > 0) errors.push(...status.errors);
    else {
      errors.push({
        path: status.status === "missing_projects" ? join(rootPath, "projects") : rootPath,
        message: status.status,
      });
    }
    return { valid, invalid, errors };
  }

  const projectsDir = join(rootPath, "projects");
  let handle;
  try {
    handle = await fs.opendir(projectsDir);
  } catch (error) {
    errors.push(storageError(projectsDir, error));
    return { valid, invalid, errors };
  }

  const directoryNames = [];
  try {
    for await (const entry of handle) {
      if (!entry.name.startsWith(".")) directoryNames.push(entry.name);
    }
  } catch (error) {
    errors.push(storageError(projectsDir, error));
  }

  for (const directoryName of directoryNames) {
    const read = await readWorkspaceEntry(projectsDir, directoryName);
    if (read.valid) valid.push(read.valid);
    else invalid.push(read.invalid);
  }

  const claimants = new Map();
  for (const entry of valid) {
    const list = claimants.get(entry.id);
    if (list) list.push(entry);
    else claimants.set(entry.id, [entry]);
  }
  const unique = [];
  for (const entry of valid) {
    if (claimants.get(entry.id).length === 1) unique.push(entry);
    else {
      invalid.push({
        directory: entry.directory,
        errors: [`duplicate workspace id ${JSON.stringify(entry.id)}`],
      });
    }
  }

  return { valid: unique, invalid, errors };
}

// Read-only workspace detail: retained repository, context and artifact
// status. Git runs only through bounded read-only commands; nothing is
// created, modified, fetched or served outside the owned roots.

const WORKSPACE_GIT_TIMEOUT_MS = 5000;

function boundedRemoteConfig(cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["-C", cwd, "config", "--get", "remote.origin.url"],
      {
        timeout: WORKSPACE_GIT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise(stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout);
      },
    );
  });
}

function insideRoot(root, target) {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function repositoryRecord(workspaceDirectory, repository) {
  const record = {
    id: repository.id,
    path: repository.path,
    remote: repository.remote ?? null,
    role: repository.role ?? null,
    status: "missing",
    attention: [],
  };
  const requested = isAbsolute(repository.path)
    ? resolve(repository.path)
    : resolve(workspaceDirectory, repository.path);
  let lookup;
  try {
    lookup = await storageLstat(requested);
  } catch {
    record.status = "unreadable";
    record.attention.push("unreadable");
    return record;
  }
  if (lookup.permission) {
    record.status = "unreadable";
    record.attention.push("unreadable");
    return record;
  }
  if (lookup.info === null) return record;

  let physical;
  try {
    physical = await fs.realpath(requested);
  } catch {
    record.status = "missing";
    return record;
  }
  try {
    const identity = await resolveCheckout(physical, {
      deadline: Date.now() + WORKSPACE_GIT_TIMEOUT_MS,
    });
    if (identity.root !== physical) {
      record.status = "not_git";
      return record;
    }
    record.status = "ok";
  } catch (error) {
    if (
      typeof error?.code === "string" ||
      error?.killed === true ||
      typeof error?.signal === "string"
    ) {
      record.status = "unreadable";
      record.attention.push("unreadable");
    } else {
      record.status = "not_git";
    }
    return record;
  }

  if (typeof repository.remote === "string" && repository.remote !== "") {
    try {
      const configured = await boundedRemoteConfig(physical);
      if (configured !== repository.remote) record.attention.push("remote_mismatch");
    } catch (error) {
      if (error?.code === 1) record.attention.push("remote_mismatch");
      else record.attention.push("unreadable");
    }
  }
  return record;
}

function contextPath(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry.path === "string") return entry.path;
  return null;
}

// Inspect a relative content reference against an absolute base without
// following symlinks. Lexical violations (empty, absolute, dot, dotdot,
// backslash or NUL segments) refuse as outside_root. Every existing component
// is lstat-checked: a symlink component refuses as outside_root, a missing
// component (or a non-directory intermediate) reports missing only because
// every existing ancestor stayed inside the physical base, and an existing
// target resolves to its physical path for the caller to read.
async function inspectContainedReference(base, referenced) {
  try {
    relativeSegments(referenced);
  } catch {
    return { status: "outside_root", physical: null };
  }
  const segments = referenced.split("/");
  let physicalBase;
  try {
    physicalBase = await fs.realpath(base);
  } catch {
    return { status: "unreadable", physical: null };
  }
  let current = physicalBase;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if (error && error.code === "ENOENT") return { status: "missing", physical: null };
      if (error && (error.code === "EACCES" || error.code === "EPERM")) {
        return { status: "unreadable", physical: null };
      }
      throw error;
    }
    if (info.isSymbolicLink()) return { status: "outside_root", physical: null };
    if (index < segments.length - 1 && !info.isDirectory()) {
      return { status: "missing", physical: null };
    }
  }
  let physical;
  try {
    physical = await fs.realpath(current);
  } catch (error) {
    if (error && error.code === "ENOENT") return { status: "missing", physical: null };
    if (error && (error.code === "EACCES" || error.code === "EPERM")) {
      return { status: "unreadable", physical: null };
    }
    throw error;
  }
  const prefix = physicalBase.endsWith(sep) ? physicalBase : `${physicalBase}${sep}`;
  if (physical !== current && !physical.startsWith(prefix)) {
    return { status: "outside_root", physical: null };
  }
  return { status: "ok", physical };
}

async function contextRecord(workspaceDirectory, entry) {
  const requested = contextPath(entry);
  const record = { path: requested ?? String(entry), status: "unreadable" };
  if (requested === null) return record;
  let referenced = requested;
  if (isAbsolute(requested)) {
    const target = resolve(requested);
    if (!insideRoot(workspaceDirectory, target)) {
      record.status = "outside_root";
      return record;
    }
    if (target === workspaceDirectory) return record;
    referenced = relative(workspaceDirectory, target);
  }
  let inspected;
  try {
    inspected = await inspectContainedReference(workspaceDirectory, referenced);
  } catch {
    return record;
  }
  if (inspected.status === "outside_root") {
    record.status = "outside_root";
    return record;
  }
  if (inspected.status === "missing") {
    record.status = "missing";
    return record;
  }
  if (inspected.status !== "ok") return record;
  try {
    await fs.readFile(inspected.physical);
    record.status = "ok";
  } catch {
    // A directory or unreadable file keeps the unreadable status.
  }
  return record;
}

async function artifactRecords(workspaceDirectory, repositories) {
  const artifactsDirectory = join(workspaceDirectory, "artifacts");
  let directoryLookup;
  try {
    directoryLookup = await storageLstat(artifactsDirectory);
  } catch {
    return [];
  }
  if (directoryLookup.permission || directoryLookup.info === null) return [];
  if (directoryLookup.info.isSymbolicLink() || !directoryLookup.info.isDirectory()) return [];

  const repositoryById = new Map(repositories.map((record) => [record.id, record]));
  const names = [];
  let handle;
  try {
    handle = await fs.opendir(artifactsDirectory);
  } catch {
    return [];
  }
  try {
    for await (const entry of handle) {
      if (entry.name.endsWith(".json") && !entry.name.startsWith(".")) names.push(entry.name);
    }
  } catch {
    // Retain the records listed before a partial listing failure.
  }
  names.sort();

  const records = [];
  for (const name of names) {
    const recordPath = join(artifactsDirectory, name);
    // The record itself must be a regular non-symlink file: a symlinked
    // record is refused without reading the bytes it points at.
    let recordLookup;
    try {
      recordLookup = await storageLstat(recordPath);
    } catch {
      recordLookup = null;
    }
    if (
      recordLookup === null ||
      recordLookup.permission ||
      recordLookup.info === null ||
      recordLookup.info.isSymbolicLink() ||
      !recordLookup.info.isFile()
    ) {
      records.push({ path: recordPath, status: "unreadable", reason: "unreadable record" });
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(recordPath, "utf8"));
    } catch (error) {
      records.push({
        path: recordPath,
        status: "unreadable",
        reason: error instanceof SyntaxError ? "malformed JSON" : "unreadable record",
      });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || parsed.schema_version !== 1
      || (parsed.kind !== "repository" && parsed.kind !== "url")) {
      records.push({ path: recordPath, status: "unreadable", reason: "unknown schema" });
      continue;
    }
    if (parsed.kind === "url") {
      if (typeof parsed.target !== "string" || !/^https?:\/\//i.test(parsed.target)) {
        records.push({ path: recordPath, status: "unreadable", reason: "unreadable url" });
      } else {
        records.push({ ...parsed, path: recordPath, status: "external" });
      }
      continue;
    }

    const target = parsed.target;
    if (!target || typeof target !== "object"
      || typeof target.repository_id !== "string" || typeof target.path !== "string") {
      records.push({
        path: recordPath,
        status: "unreadable",
        reason: "unreadable repository target",
      });
      continue;
    }
    const repository = repositoryById.get(target.repository_id);
    if (!repository) {
      records.push({ ...parsed, path: recordPath, status: "repository_unavailable" });
      continue;
    }
    // A retained repository that is not usable cannot ground a target: the
    // artifact keeps its fields with a distinct unavailable status.
    if (repository.status !== "ok") {
      records.push({ ...parsed, path: recordPath, status: "repository_unavailable" });
      continue;
    }
    const repositoryPath = isAbsolute(repository.path)
      ? resolve(repository.path)
      : resolve(workspaceDirectory, repository.path);
    let inspected;
    try {
      inspected = await inspectContainedReference(repositoryPath, target.path);
    } catch {
      records.push({
        ...parsed,
        path: recordPath,
        status: "unreadable",
        reason: "unreadable target",
      });
      continue;
    }
    if (inspected.status === "outside_root") {
      records.push({ ...parsed, path: recordPath, status: "outside_root" });
      continue;
    }
    if (inspected.status === "missing") {
      records.push({ ...parsed, path: recordPath, status: "missing" });
      continue;
    }
    if (inspected.status !== "ok") {
      records.push({
        ...parsed,
        path: recordPath,
        status: "unreadable",
        reason: "unreadable target",
      });
      continue;
    }
    try {
      await fs.readFile(inspected.physical);
      records.push({ ...parsed, path: recordPath, status: "ok" });
    } catch {
      records.push({
        ...parsed,
        path: recordPath,
        status: "unreadable",
        reason: "unreadable target",
      });
    }
  }
  return records;
}

async function materialFiles(workspaceDirectory, name, attention) {
  const directory = join(workspaceDirectory, name);
  try {
    const lookup = await storageLstat(directory);
    if (lookup.permission) {
      attention.push(`${name}_unreadable`);
      return [];
    }
    if (lookup.info === null) return [];
    if (lookup.info.isSymbolicLink() || !lookup.info.isDirectory()) {
      attention.push(`${name}_unreadable`);
      return [];
    }
    const names = await fs.readdir(directory);
    return names.filter((entry) => !entry.startsWith(".")).sort();
  } catch {
    attention.push(`${name}_unreadable`);
    return [];
  }
}

async function hasWorkspaceSpecs(workspaceDirectory) {
  try {
    const specsPath = join(workspaceDirectory, ".specs");
    const lookup = await storageLstat(specsPath);
    if (lookup.permission || lookup.info === null) return false;
    if (lookup.info.isSymbolicLink() || !lookup.info.isDirectory()) return false;
    return (await fs.realpath(specsPath)) === specsPath;
  } catch {
    return false;
  }
}

/**
 * Read-only workspace detail: catalog identity plus retained repository,
 * context and artifact status. Nothing is created, modified or fetched.
 * @param {string} root
 * @param {string} id
 * @returns {Promise<{id: string, name: string, directory: string, kit: object,
 *   repositories: object[], context: object[], briefs: string[],
 *   notes: string[], artifacts: object[], has_workspace_specs: boolean,
 *   attention: string[]}>}
 */
export async function fetchWorkspace(root, id) {
  if (typeof root !== "string" || root === "") {
    throw new TypeError("root must be a non-empty string");
  }
  if (typeof id !== "string" || id === "") {
    throw new TypeError("id must be a non-empty string");
  }
  const rootPath = resolve(root);
  const catalog = await listWorkspaces(rootPath);
  const matches = catalog.valid.filter((entry) => entry.kit && entry.kit.id === id);
  if (matches.length !== 1) throw new Error(`workspace is not uniquely available: ${id}`);
  const catalogEntry = matches[0];
  const directory = catalogEntry.directory;

  // Detail resolves from the authorized catalog read: re-reading the manifest
  // here would accept an unvalidated replacement identity or silently drop
  // context when the second read fails.
  const kit = catalogEntry.kit;
  const contextEntries = Array.isArray(kit.context) ? kit.context : [];

  const attention = [...(catalogEntry.attention ?? [])];
  const repositories = [];
  for (const repository of kit.repositories) {
    repositories.push(await repositoryRecord(directory, repository));
  }
  if (repositories.some((record) => record.attention.includes("remote_mismatch"))) {
    attention.push("remote_mismatch");
  }
  const context = [];
  for (const entry of contextEntries) {
    context.push(await contextRecord(directory, entry));
  }
  const artifacts = await artifactRecords(directory, repositories);
  const briefs = await materialFiles(directory, "briefs", attention);
  const notes = await materialFiles(directory, "notes", attention);
  const has_workspace_specs = await hasWorkspaceSpecs(directory);

  return {
    id: catalogEntry.id,
    name: catalogEntry.name,
    directory,
    kit,
    repositories,
    context,
    briefs,
    notes,
    artifacts,
    has_workspace_specs,
    attention,
  };
}

// Explicit setup and exclusive creation of empty workspace kits. Both
// functions create only owned directories and files: nothing is deleted or
// replaced, and .adjacent is never touched.

const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// Resolve an existing real directory while refusing symlinks, non-directories
// and symlinked ancestors. A missing path returns null so callers can create
// only that single component non-recursively.
async function existingRealDirectory(path, label) {
  const lookup = await storageLstat(path);
  if (lookup.permission) throw new Error(`${label} is not readable: ${path}`);
  if (lookup.info === null) return null;
  if (lookup.info.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  if (!lookup.info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  if ((await fs.realpath(path)) !== resolve(path)) {
    throw new Error(`${label} path contains a symbolic link: ${path}`);
  }
  return resolve(path);
}

/**
 * Create only a missing root and its projects directory, one nonrecursive
 * component at a time. Existing roots and projects must already be real
 * directories; a second call is a no-op.
 * @param {string} root
 * @returns {Promise<{root: string, projects: string}>}
 */
export async function setupStorage(root) {
  if (typeof root !== "string" || root === "") {
    throw new TypeError("root must be a non-empty string");
  }
  const requestedRoot = resolve(root);
  let rootPath = await existingRealDirectory(requestedRoot, "storage root");
  if (rootPath === null) {
    await fs.mkdir(requestedRoot, { recursive: false });
    rootPath = await existingRealDirectory(requestedRoot, "storage root");
  }
  const requestedProjects = join(rootPath, "projects");
  let projects = await existingRealDirectory(requestedProjects, "projects directory");
  if (projects === null) {
    await fs.mkdir(requestedProjects, { recursive: false });
    projects = await existingRealDirectory(requestedProjects, "projects directory");
  }
  return { root: rootPath, projects };
}

/**
 * Create an empty workspace kit exclusively: the projects directory must
 * already exist, the id is validated before any mkdir, and kit.yaml is
 * published through createFileExclusive. Any failure after the mkdir leaves
 * the newly owned directory visible without a kit.
 * @param {string} root
 * @param {{id: string, name?: string}} options
 * @returns {Promise<{id: string, name: string, directory: string, kit: string}>}
 */
export async function createWorkspace(root, options = {}) {
  if (typeof root !== "string" || root === "") {
    throw new TypeError("root must be a non-empty string");
  }
  const { id, name } = options ?? {};
  const projectsRequested = join(resolve(root), "projects");
  const projects = await existingRealDirectory(projectsRequested, "projects directory");
  if (projects === null) throw new Error(`projects directory does not exist: ${projectsRequested}`);
  if (typeof id !== "string" || !WORKSPACE_ID_PATTERN.test(id)) {
    throw new Error(`invalid workspace id: ${String(id)}`);
  }
  const resolvedName = name === undefined ? id : name;
  const directory = join(projects, id);
  await fs.mkdir(directory, { recursive: false });
  if (typeof resolvedName !== "string" || resolvedName === "") {
    throw new Error(`invalid workspace name: ${String(resolvedName)}`);
  }
  const kit = join(directory, "kit.yaml");
  const bytes = `version: 1\nid: ${id}\nname: ${resolvedName}\nrepositories: []\n`;
  await createFileExclusive(kit, bytes);
  return { id, name: resolvedName, directory, kit };
}
