// Workspace store filesystem primitives: exclusive creation, atomic replacement
// and contained existing-path resolution.
//
// Node-standard-library only. This module owns no store layout, kit schema or
// CLI behavior. Callers own replacement serialization: only one writer may
// replace a given target at a time, and ancestor directories are assumed stable
// during a call (a hostile process that swaps an ancestor can defeat the
// rechecks). Publication fsyncs only the temporary file: there is no directory
// fsync and no power-loss durability claim.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseKit } from "./kit.mjs";

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
      kit: { version: kit.version, id: kit.id, name: kit.name, repositories: kit.repositories },
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
