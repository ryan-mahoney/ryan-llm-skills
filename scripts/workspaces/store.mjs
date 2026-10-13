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
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cloneKit, formatScalar, parseKit } from "./kit.mjs";
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
 * Path of the per-machine config file holding `{"storage_root": "/abs/path"}`:
 * `$XDG_CONFIG_HOME/adjacent/config.json`, else `<home>/.config/adjacent/config.json`.
 * @param {{XDG_CONFIG_HOME?: string}} env
 * @param {string} home
 * @returns {string}
 */
export function storageConfigPath(env, home) {
  const xdg = env ? env.XDG_CONFIG_HOME : undefined;
  const base = typeof xdg === "string" && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "adjacent", "config.json");
}

function readConfiguredRoot(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
  let configured;
  try {
    configured = JSON.parse(text)?.storage_root;
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (configured === undefined) return null;
  if (typeof configured !== "string" || !isAbsolute(configured)) {
    throw new Error(`${path}: storage_root must be an absolute path`);
  }
  return configured;
}

/**
 * Resolve the storage root and report what decided it. Precedence: `flag`
 * (CLI `--root`), absolute `ADJACENT_STORAGE_ROOT`, `storage_root` in the
 * config file, then `<home>/Documents/adjacent-storage`. A relative env value
 * or a malformed config file throws; nothing is created.
 * @param {{ADJACENT_STORAGE_ROOT?: string, XDG_CONFIG_HOME?: string}} env
 * @param {string} home
 * @param {string} [flag]
 * @returns {{root: string, source: "flag"|"env"|"config"|"default", config?: string}}
 */
export function describeStorageRoot(env, home, flag) {
  if (flag !== undefined && flag !== null && flag !== "") return { root: resolve(flag), source: "flag" };
  const configured = env ? env.ADJACENT_STORAGE_ROOT : undefined;
  if (configured !== undefined && configured !== null && configured !== "") {
    if (!isAbsolute(configured)) throw new Error("ADJACENT_STORAGE_ROOT must be an absolute path");
    return { root: configured, source: "env" };
  }
  const config = storageConfigPath(env, home);
  const saved = readConfiguredRoot(config);
  if (saved !== null) return { root: saved, source: "config", config };
  return { root: join(home, "Documents", "adjacent-storage"), source: "default" };
}

/**
 * Resolve the storage root without the CLI flag; see `describeStorageRoot`.
 * @param {{ADJACENT_STORAGE_ROOT?: string, XDG_CONFIG_HOME?: string}} env
 * @param {string} home
 * @returns {string}
 */
export function resolveStorageRoot(env, home) {
  return describeStorageRoot(env, home).root;
}

/**
 * Persist `root` as this machine's storage root in the config file.
 * @param {{XDG_CONFIG_HOME?: string}} env
 * @param {string} home
 * @param {string} root absolute path
 * @returns {Promise<string>} the config file path
 */
export async function saveStorageRoot(env, home, root) {
  if (!isAbsolute(root)) throw new Error("storage root must be an absolute path");
  const config = storageConfigPath(env, home);
  await fs.mkdir(dirname(config), { recursive: true });
  await fs.writeFile(config, `${JSON.stringify({ storage_root: root }, null, 2)}\n`);
  return config;
}

/**
 * Resolve a kit repository path to an absolute path: `~` and `~/...` use the
 * local home, absolute paths pass through, anything else is relative to the
 * workspace directory. The kit stores the path as written.
 * @param {string} workspaceDirectory
 * @param {string} path
 * @param {string} [home]
 * @returns {string}
 */
export function resolveRepositoryPath(workspaceDirectory, path, home = homedir()) {
  if (path === "~" || path.startsWith("~/")) return resolve(home, path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(workspaceDirectory, path);
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

// Bounded catalog read budget ----------------------------------------------
//
// Opt-in observation budget shared by the catalog and assignment readers.
// Hard ceilings bound one scan; overrides may only lower them. The mutable
// `entries`/`bytes` counters are charged by the readers, `reasons` records
// unavailable or truncating boundaries, and `omissions` turns "unknown" as
// soon as truncation prevents a complete count. No budget means the strict
// all-or-error readers remain in force.

const CATALOG_READ_HARD_LIMITS = Object.freeze({
  maxEntries: 400,
  maxRows: 100,
  maxFileBytes: 65536,
  maxTotalBytes: 4194304,
});

function catalogReason(budget, reason) {
  if (!budget.reasons.includes(reason)) budget.reasons.push(reason);
}

/**
 * Mark the scan truncated: any count or later source may be omitted.
 */
export function noteCatalogOmission(budget, reason) {
  budget.omissions = "unknown";
  catalogReason(budget, reason);
}

/**
 * Record one unavailable source without changing the omission state.
 */
export function noteCatalogUnavailable(budget, reason) {
  catalogReason(budget, reason);
}

/**
 * Charge one consumed directory entry. Returns false at the hard entry limit
 * and marks the scan truncated; the caller stops iterating that directory.
 */
export function chargeCatalogEntry(budget) {
  if (budget.entries >= budget.maxEntries) {
    noteCatalogOmission(budget, "entry-budget-exhausted");
    return false;
  }
  budget.entries += 1;
  return true;
}

/**
 * Bounded directory-entry iterator. Entries are charged one at a time and the
 * iterator stops BEFORE the next directory read once the shared entry cap is
 * reached, so the dirent beyond the cap is never fetched. Hitting the cap
 * marks the scan truncated conservatively: the exact remaining count is not
 * known. The directory handle is always closed.
 * @param {string} directory
 * @param {{maxEntries: number, entries: number, omissions: string,
 *   reasons: string[]}} budget
 * @returns {AsyncGenerator<import("node:fs").Dirent>}
 */
export async function* catalogEntries(directory, budget) {
  const handle = await fs.opendir(directory, { bufferSize: 1 });
  try {
    for (;;) {
      if (budget.entries >= budget.maxEntries) {
        noteCatalogOmission(budget, "entry-budget-exhausted");
        return;
      }
      const entry = await handle.read();
      if (entry === null) return;
      if (!chargeCatalogEntry(budget)) {
        noteCatalogOmission(budget, "entry-budget-exhausted");
        return;
      }
      yield entry;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Create the shared opt-in catalog read budget.
 * @param {{maxEntries?: number, maxRows?: number, maxFileBytes?: number,
 *   maxTotalBytes?: number}} [overrides] only smaller positive integers
 * @returns {{maxEntries: number, maxRows: number, maxFileBytes: number,
 *   maxTotalBytes: number, entries: number, bytes: number, rows: number,
 *   reasons: string[], omissions: string}}
 */
export function createCatalogReadBudget(overrides = {}) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("catalog read budget overrides must be an object");
  }
  for (const key of Object.keys(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(CATALOG_READ_HARD_LIMITS, key)) {
      throw new Error(`unknown catalog read budget limit: ${key}`);
    }
  }
  const budget = {
    ...CATALOG_READ_HARD_LIMITS,
    entries: 0,
    bytes: 0,
    rows: 0,
    reasons: [],
    omissions: "none",
  };
  for (const [key, ceiling] of Object.entries(CATALOG_READ_HARD_LIMITS)) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`catalog read budget ${key} must be a positive integer`);
    }
    if (value > ceiling) {
      throw new Error(`catalog read budget ${key} must not exceed the hard ceiling ${ceiling}`);
    }
    budget[key] = value;
  }
  return budget;
}

/**
 * Read one regular file with the shared byte budget: opens NOFOLLOW and
 * NONBLOCK, verifies a regular file with fstat, refuses oversize files before
 * reading, and charges the actual bytes read. Symlinks, non-regular files,
 * oversize files and byte exhaustion return `{ok:false, reason}`; exhaustion
 * also reports `exhausted: true` after marking the scan truncated. With
 * `options.maxBytes`, reads only that bounded prefix (never oversize-refused)
 * so callers can inspect a first line without reading the rest of a large
 * file. Bytes already read are charged even when a later read throws, and EOF
 * before the stat size is an unavailable source, never budget exhaustion.
 */
export async function readCatalogFile(path, budget, options = {}) {
  const prefixBytes = options.maxBytes;
  if (prefixBytes !== undefined
    && (!Number.isSafeInteger(prefixBytes) || prefixBytes <= 0)) {
    throw new TypeError("readCatalogFile maxBytes must be a positive integer");
  }
  const remaining = budget.maxTotalBytes - budget.bytes;
  if (remaining <= 0) {
    noteCatalogOmission(budget, "byte-budget-exhausted");
    return { ok: false, reason: "byte-budget-exhausted", exhausted: true };
  }
  let handle;
  try {
    handle = await fs.open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = error && error.code;
    return { ok: false, reason: code === "ELOOP" ? "symlink" : `open-${code ?? "failed"}` };
  }
  let total = 0;
  try {
    let info;
    try {
      info = await handle.stat();
    } catch (error) {
      return { ok: false, reason: `stat-${(error && error.code) ?? "failed"}` };
    }
    if (!info.isFile()) return { ok: false, reason: "not-a-regular-file" };
    if (prefixBytes === undefined && info.size > budget.maxFileBytes) {
      return { ok: false, reason: "oversize-file" };
    }
    const wanted = prefixBytes === undefined
      ? info.size
      : Math.min(info.size, prefixBytes, budget.maxFileBytes);
    if (wanted > remaining) {
      noteCatalogOmission(budget, "byte-budget-exhausted");
      return { ok: false, reason: "byte-budget-exhausted", exhausted: true };
    }
    const buffer = Buffer.alloc(wanted);
    while (total < buffer.length) {
      let bytesRead;
      try {
        ({ bytesRead } = await handle.read(buffer, total, buffer.length - total, total));
      } catch (error) {
        // Bytes already delivered are charged even though the read failed.
        budget.bytes += total;
        return { ok: false, reason: `read-${(error && error.code) ?? "failed"}`, bytes: total };
      }
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    budget.bytes += total;
    if (prefixBytes === undefined && total < info.size) {
      // EOF before the stat size is a changing or unavailable source, not
      // budget exhaustion.
      return { ok: false, reason: "unavailable", bytes: total };
    }
    return { ok: true, bytes: total, text: buffer.toString("utf8") };
  } finally {
    await handle.close();
  }
}

async function readWorkspaceEntry(projectsDir, directoryName, budget = null) {
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
  if (budget === null) {
    try {
      text = await fs.readFile(kitPath, "utf8");
    } catch (error) {
      return {
        invalid: { directory, errors: [error instanceof Error ? error.message : String(error)] },
      };
    }
  } else {
    const read = await readCatalogFile(kitPath, budget);
    if (!read.ok) {
      return {
        invalid: { directory, errors: [`kit.yaml unavailable (${read.reason})`] },
        exhausted: read.exhausted === true,
      };
    }
    text = read.text;
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
      kit: cloneKit(kit),
      attention: directoryName === kit.id ? [] : ["directory_mismatch"],
    },
  };
}

/**
 * Read-only workspace catalog: invalid manifests and duplicate ids are
 * retained with their source paths. Nothing is created and no git runs.
 * @param {string} root
 * @param {{budget?: object}} [options] optional shared budget from
 *   `createCatalogReadBudget`; when present the scan is bounded and
 *   truncation is reported through the budget instead of throwing
 * @returns {Promise<{valid: object[], invalid: {directory: string, errors: string[]}[],
 *   errors: {path: string, message: string}[]}>}
 */
export async function listWorkspaces(root, options = {}) {
  if (typeof root !== "string" || root === "") {
    throw new TypeError("root must be a non-empty string");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("listWorkspaces options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (key !== "budget") throw new Error(`listWorkspaces does not accept option ${key}`);
  }
  const budget = options.budget ?? null;
  if (budget !== null && (typeof budget !== "object" || Array.isArray(budget))) {
    throw new TypeError("listWorkspaces budget must be a catalog read budget");
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
    if (budget !== null) noteCatalogOmission(budget, `storage-${status.status}`);
    return { valid, invalid, errors };
  }

  const projectsDir = join(rootPath, "projects");
  const directoryNames = [];
  if (budget === null) {
    let handle;
    try {
      handle = await fs.opendir(projectsDir);
    } catch (error) {
      errors.push(storageError(projectsDir, error));
      return { valid, invalid, errors };
    }
    try {
      for await (const entry of handle) {
        if (!entry.name.startsWith(".")) directoryNames.push(entry.name);
      }
    } catch (error) {
      errors.push(storageError(projectsDir, error));
    }
  } else {
    try {
      for await (const entry of catalogEntries(projectsDir, budget)) {
        if (!entry.name.startsWith(".")) directoryNames.push(entry.name);
      }
    } catch (error) {
      errors.push(storageError(projectsDir, error));
      noteCatalogOmission(budget, "projects-unreadable");
    }
  }

  for (const directoryName of directoryNames) {
    const read = await readWorkspaceEntry(projectsDir, directoryName, budget);
    if (read.valid) valid.push(read.valid);
    else invalid.push(read.invalid);
    if (read.exhausted === true) break;
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
  const requested = resolveRepositoryPath(workspaceDirectory, repository.path);
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
    // Resolved physical checkout for a positively validated repository. The
    // transport can compare a registered canonical target without
    // re-implementing filesystem path resolution in the browser.
    record.canonical_path = physical;
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
    const repositoryPath = resolveRepositoryPath(workspaceDirectory, repository.path);
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
    // Validate the existing parent before creating through it: a missing root
    // beneath a symlinked ancestor must refuse without writing outside.
    await physicalParent(requestedRoot);
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
 * already exist, the id and name are validated and emitted through
 * formatScalar before any mkdir, and kit.yaml is published through
 * createFileExclusive. A refused id or name creates nothing. Any failure
 * after the mkdir leaves the newly owned directory visible; the kit may be
 * absent or, when publication linked before its cleanup failed, complete —
 * callers must inspect visible state rather than assume absence.
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
  if (typeof resolvedName !== "string" || resolvedName === "") {
    throw new Error(`invalid workspace name: ${String(resolvedName)}`);
  }
  const bytes = `version: 1\nid: ${formatScalar(id)}\nname: ${formatScalar(resolvedName)}\nrepositories: []\n`;
  const directory = join(projects, id);
  await fs.mkdir(directory, { recursive: false });
  const kit = join(directory, "kit.yaml");
  await createFileExclusive(kit, bytes);
  return { id, name: resolvedName, directory, kit };
}

// Workspace material and artifact records. Both identities are
// workspace-relative paths; nothing replaces or deletes existing bytes and no
// target repository is ever written.

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Deterministic workspace-relative path of a request-owned material:
 * `<folder>/brief-<sha256(workspace id NUL kind NUL request id)>.md`, where
 * `folder` is `briefs` for a brief and `notes` for a note. Pure computation:
 * nothing is read, created or modified; the caller owns publication and
 * conflict checks.
 * @param {string} workspaceId workspace kit id
 * @param {"brief"|"note"} kind
 * @param {string} requestId canonical RFC 4122 request id
 * @returns {string}
 */
export function requestMaterialPath(workspaceId, kind, requestId) {
  if (typeof workspaceId !== "string" || workspaceId === "") {
    throw new TypeError("workspace id must be a non-empty string");
  }
  const folder = kind === "brief" ? "briefs" : kind === "note" ? "notes" : null;
  if (folder === null) throw new Error(`invalid material kind: ${String(kind)}`);
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    throw Object.assign(new Error(`invalid material request_id: ${String(requestId)}`), {
      code: "invalid-request-id",
    });
  }
  const digest = createHash("sha256")
    .update(`${workspaceId}\0${kind}\0${requestId}`, "utf8")
    .digest("hex");
  return `${folder}/brief-${digest}.md`;
}

function materialSlug(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "material" : slug;
}

async function ensureRealDirectory(path, label) {
  let resolved = await existingRealDirectory(path, label);
  if (resolved === null) {
    try {
      await fs.mkdir(path, { recursive: false });
    } catch (error) {
      // A concurrent first addition may have created the directory between
      // the absence check and this mkdir: revalidate below instead of
      // surfacing EEXIST.
      if (!error || error.code !== "EEXIST") throw error;
    }
    resolved = await existingRealDirectory(path, label);
    if (resolved === null) throw new Error(`${label} does not exist: ${path}`);
  }
  return resolved;
}

async function catalogWorkspace(root, id) {
  const catalog = await listWorkspaces(resolve(root));
  const matches = catalog.valid.filter((entry) => entry.kit && entry.kit.id === id);
  if (matches.length !== 1) throw new Error(`workspace is not uniquely available: ${id}`);
  return matches[0];
}

function assertRelativeArtifactPath(path) {
  try {
    relativeSegments(path);
  } catch {
    throw new Error(`unsafe artifact target path: ${String(path)}`);
  }
}

/**
 * Add an exclusive brief or note inside the workspace material directory.
 *
 * Without `request_id` the destination is `<UTC date>-<slug>.md` and name
 * collisions allocate `-2` through `-1000` before failing with EEXIST; the
 * raw content is written unchanged.
 *
 * With a canonical RFC 4122 `request_id` the destination is deterministic:
 * `<folder>/brief-<sha256(workspace id NUL kind NUL request id)>.md` holding
 * the canonical markdown `# <title>\n\n<content>` (a trailing newline is
 * added when the content lacks one). An existing destination is idempotent
 * only when it is a regular non-symlink file with identical bytes; a
 * symlink, non-regular file or different bytes never get overwritten, and
 * different bytes refuse with typed `request-conflict`.
 * @param {string} root
 * @param {string} id
 * @param {{kind: "brief"|"note", title: string, content: string,
 *   request_id?: string}} options
 * @returns {Promise<{path: string}>} workspace-relative material path
 */
export async function addMaterial(root, id, options = {}) {
  if (typeof root !== "string" || root === "") {
    throw new TypeError("root must be a non-empty string");
  }
  if (typeof id !== "string" || id === "") {
    throw new TypeError("id must be a non-empty string");
  }
  const catalogEntry = await catalogWorkspace(root, id);
  const { kind, title, content, request_id: requestId } = options ?? {};
  const folder = kind === "brief" ? "briefs" : kind === "note" ? "notes" : null;
  if (folder === null) throw new Error(`invalid material kind: ${String(kind)}`);
  if (typeof title !== "string" || title.trim() === "") throw new Error("invalid material title");
  if (typeof content !== "string") throw new Error("invalid material content");
  if (requestId !== undefined && (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId))) {
    throw Object.assign(new Error(`invalid material request_id: ${String(requestId)}`), {
      code: "invalid-request-id",
    });
  }

  const directory = await ensureRealDirectory(
    join(catalogEntry.directory, folder),
    `${folder} directory`,
  );

  if (requestId !== undefined) {
    const bytes = `# ${title}\n\n${content}${content.endsWith("\n") ? "" : "\n"}`;
    const relativePath = requestMaterialPath(id, kind, requestId);
    const name = basename(relativePath);
    try {
      await createFileExclusive(join(directory, name), bytes);
      return { path: relativePath };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      // Only an identical regular canonical file is an idempotent repeat.
      let leaf;
      try {
        leaf = await resolveWorkspacePath(catalogEntry.directory, relativePath);
      } catch {
        throw error;
      }
      let info;
      try {
        info = await fs.lstat(leaf);
      } catch {
        throw error;
      }
      if (!info.isFile()) throw error;
      let existing;
      try {
        const handle = await fs.open(leaf, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        try {
          const handleInfo = await handle.stat();
          if (!handleInfo.isFile()) throw error;
          existing = await handle.readFile();
        } finally {
          await handle.close();
        }
      } catch {
        throw error;
      }
      if (Buffer.isBuffer(existing) && existing.equals(Buffer.from(bytes, "utf8"))) {
        return { path: relativePath };
      }
      throw Object.assign(new Error(`material request conflicts with published bytes: ${relativePath}`), {
        code: "request-conflict",
      });
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const slug = materialSlug(title);
  let failure = null;
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const name = attempt === 1 ? `${date}-${slug}.md` : `${date}-${slug}-${attempt}.md`;
    try {
      await createFileExclusive(join(directory, name), content);
      return { path: `${folder}/${name}` };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      failure = error;
    }
  }
  throw failure ?? Object.assign(
    new Error(`material names exhausted: ${slug}`),
    { code: "EEXIST" },
  );
}

/**
 * Add an artifact record as `artifacts/<uuid>.json`. Repository targets must
 * name a kit repository and stay repository-relative; URL targets accept only
 * http/https and are never fetched. Missing repository targets are retained.
 * @param {string} root
 * @param {string} id
 * @param {{kind: "repository"|"url", target: object|string,
 *   title?: string, note?: string}} options
 * @returns {Promise<{record: object, path: string}>} record plus
 *   workspace-relative record path
 */
export async function addArtifact(root, id, options = {}) {
  if (typeof root !== "string" || root === "") {
    throw new TypeError("root must be a non-empty string");
  }
  if (typeof id !== "string" || id === "") {
    throw new TypeError("id must be a non-empty string");
  }
  const catalogEntry = await catalogWorkspace(root, id);
  const { kind, target, title, note } = options ?? {};
  if (kind !== "repository" && kind !== "url") {
    throw new Error(`invalid artifact kind: ${String(kind)}`);
  }
  if (title !== undefined && typeof title !== "string") throw new Error("invalid artifact title");
  if (note !== undefined && typeof note !== "string") throw new Error("invalid artifact note");

  let normalizedTarget;
  if (kind === "repository") {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error("invalid artifact target");
    }
    if (typeof target.repository_id !== "string" || target.repository_id === "") {
      throw new Error("invalid artifact repository id");
    }
    if (
      !catalogEntry.kit.repositories.some((repository) => repository.id === target.repository_id)
    ) {
      throw new Error(`unknown repository: ${target.repository_id}`);
    }
    assertRelativeArtifactPath(target.path);
    const repository = catalogEntry.kit.repositories.find(
      (entry) => entry.id === target.repository_id,
    );
    const repositoryPath = resolveRepositoryPath(catalogEntry.directory, repository.path);
    // Reject symlink-redirected existing ancestors before publishing: a
    // missing leaf beneath a symlink still inspects as outside_root, while
    // safe missing targets and unavailable bases stay retainable.
    let inspected = null;
    try {
      inspected = await inspectContainedReference(repositoryPath, target.path);
    } catch {
      inspected = null;
    }
    if (inspected !== null && inspected.status === "outside_root") {
      throw new Error(`unsafe artifact target path: ${target.path}`);
    }
    normalizedTarget = { repository_id: target.repository_id, path: target.path };
  } else {
    if (typeof target !== "string" || target === "") throw new Error("invalid artifact url");
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      throw new Error(`invalid artifact url: ${target}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`invalid artifact url scheme: ${parsed.protocol}`);
    }
    // Persist the canonical parsed URL: accepted spellings such as a missing
    // `//` or surrounding whitespace must remain readable to the
    // `https?://` record reader instead of becoming path-only entries.
    normalizedTarget = parsed.href;
  }

  const record = {
    schema_version: 1,
    artifact_id: randomUUID(),
    kind,
    target: normalizedTarget,
    added_at: new Date().toISOString(),
  };
  if (title !== undefined) record.title = title;
  if (note !== undefined) record.note = note;

  const directory = await ensureRealDirectory(
    join(catalogEntry.directory, "artifacts"),
    "artifacts directory",
  );
  const name = `${record.artifact_id}.json`;
  await createFileExclusive(join(directory, name), JSON.stringify(record));
  return { record, path: `artifacts/${name}` };
}

// Exclusive kit replacement. The operator exclusion window covers the
// compare-to-rename gap: the step-10 CLI prints plan.hunk before this call and
// the operator does not edit kit.yaml while the apply runs. Ancestor
// directories are assumed stable during the call. There is no directory fsync
// and no power-loss durability claim.

async function requireRegularKit(kitPath) {
  const lookup = await storageLstat(kitPath);
  if (lookup.permission) throw new Error(`kit.yaml is not readable: ${kitPath}`);
  if (lookup.info === null) throw new Error(`kit.yaml does not exist: ${kitPath}`);
  if (lookup.info.isSymbolicLink()) throw new Error(`kit.yaml must not be a symlink: ${kitPath}`);
  if (!lookup.info.isFile()) throw new Error(`kit.yaml is not a regular file: ${kitPath}`);
  const physical = await fs.realpath(kitPath);
  if (physical !== resolve(kitPath)) {
    throw new Error(`kit.yaml path contains a symbolic link: ${kitPath}`);
  }
  return physical;
}

async function assertRepositoryTopLevel(repositoryPath) {
  const physical = await existingRealDirectory(repositoryPath, "repository path");
  if (physical === null) throw new Error(`repository path does not exist: ${repositoryPath}`);
  let identity;
  try {
    identity = await resolveCheckout(physical, { deadline: Date.now() + WORKSPACE_GIT_TIMEOUT_MS });
  } catch {
    throw new Error(`repository path is not a Git work tree: ${repositoryPath}`);
  }
  if (identity.root !== physical) {
    throw new Error(`repository path is not a Git top level: ${repositoryPath}`);
  }
  return physical;
}

function requirePlan(plan) {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new TypeError("plan must be an object");
  }
  const { before, after, expected } = plan;
  if (typeof before !== "string" || typeof after !== "string") {
    throw new TypeError("plan before and after must be strings");
  }
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    throw new TypeError("plan expected must be a kit object");
  }
  return { before, after, expected };
}

// Whether a parsed record names `id` as a `repository_id` anywhere inside it.
function mentionsRepository(value, id) {
  if (Array.isArray(value)) return value.some((item) => mentionsRepository(item, id));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => (key === "repository_id" && item === id)
    || mentionsRepository(item, id));
}

async function jsonRecords(directory) {
  let names;
  try {
    names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const name of names) {
    try {
      records.push({ name, record: JSON.parse(await fs.readFile(join(directory, name), "utf8")) });
    } catch {
      // An unreadable or malformed record cannot be attributed to a repository.
    }
  }
  return records;
}

/**
 * Workspace records that name a kit repository, for the remove-repo preview:
 * threads, assignments and artifacts by `repository_id`; designs whose
 * design-system files lie inside the repository's checkout; spec packages
 * whose `scope.json` targets it. Read-only.
 * @param {string} root
 * @param {string} id workspace id
 * @param {string} repositoryId
 * @returns {Promise<{threads: string[], assignments: string[], artifacts: string[], designs: string[], packages: string[]}>}
 */
export async function repositoryReferences(root, id, repositoryId) {
  const { directory, kit } = await catalogWorkspace(root, id);
  const repository = kit.repositories.find((entry) => entry.id === repositoryId);
  const checkout = repository ? resolveRepositoryPath(directory, repository.path) : null;
  const named = async (folder) => (await jsonRecords(join(directory, folder)))
    .filter(({ record }) => mentionsRepository(record, repositoryId))
    .map(({ name }) => name.replace(/\.json$/, ""));
  const designs = [];
  for (const entry of await fs.readdir(join(directory, "designs")).catch(() => [])) {
    const { record } = (await jsonRecords(join(directory, "designs", entry))).find(({ name }) => name === "design.json") ?? {};
    const system = record?.design_system;
    const files = [system?.path, system?.tokens];
    if (system?.repository === repositoryId
      || (checkout !== null && files.some((file) => typeof file === "string" && insideRoot(checkout, file)))) {
      designs.push(entry);
    }
  }
  const packages = [];
  for (const entry of await fs.readdir(join(directory, "specs")).catch(() => [])) {
    const scope = await fs.readFile(join(directory, "specs", entry, "scope.json"), "utf8").then(JSON.parse, () => null);
    if (Array.isArray(scope?.targets) && scope.targets.some((target) => target?.id === repositoryId)) packages.push(entry);
  }
  return {
    threads: await named("threads"),
    assignments: await named("assignments"),
    artifacts: await named("artifacts"),
    designs,
    packages,
  };
}

const KIT_BACKUP_PREFIX = "kit.yaml.prev-";
const KIT_BACKUPS_KEPT = 20;

/**
 * Names of a workspace's `kit.yaml.prev-*` backups, newest first. The UTC ISO
 * timestamp in the name makes the lexical order chronological.
 * @param {string} root
 * @param {string} id
 * @returns {Promise<string[]>}
 */
export async function listKitBackups(root, id) {
  const { directory } = await catalogWorkspace(root, id);
  return backupNames(directory);
}

async function backupNames(directory) {
  return (await fs.readdir(directory))
    .filter((name) => name.startsWith(KIT_BACKUP_PREFIX))
    .sort()
    .reverse();
}

/**
 * Read one listed backup's text (the name must be one `listKitBackups` returns).
 * @returns {Promise<string>}
 */
export async function readKitBackup(root, id, name) {
  const { directory } = await catalogWorkspace(root, id);
  if (!(await backupNames(directory)).includes(name)) {
    throw new Error(`no kit backup named ${JSON.stringify(name)} for workspace ${id}`);
  }
  return fs.readFile(join(directory, name), "utf8");
}

// Best effort: a failed prune must not turn a completed apply into an error.
async function pruneKitBackups(directory) {
  try {
    for (const name of (await backupNames(directory)).slice(KIT_BACKUPS_KEPT)) {
      await fs.unlink(join(directory, name));
    }
  } catch {
    // Left for the next apply.
  }
}

/**
 * Apply a previewed kit replacement as an exclusive filesystem transaction.
 *
 * Order: validate the plan and compare the actual original bytes; publish a
 * unique `kit.yaml.prev-<UTC ISO>-<UUID>` copy of the original bytes before
 * acquiring `kit.yaml.lock` (`wx`); after acquisition re-resolve the regular
 * kit, re-read and byte-compare immediately before the atomic replacement. A
 * held lock refuses without touching it; a completed prior copy may remain.
 * Errors after the backup carry `error.backup` for operator recovery. Only the
 * owning lock is closed and unlinked; after a successful replacement all but
 * the newest 20 `kit.yaml.prev-*` copies are deleted.
 * This library does not print; the CLI prints plan.hunk before calling.
 *
 * @param {string} root
 * @param {string} id
 * @param {{before: string, after: string, expected: object}} plan
 * @returns {Promise<{path: string, backup: string}>}
 */
export async function applyKitEdit(root, id, plan) {
  if (typeof root !== "string" || root === "") throw new TypeError("root must be a non-empty string");
  if (typeof id !== "string" || id === "") throw new TypeError("id must be a non-empty string");
  const { before, after, expected } = requirePlan(plan);

  const parsedBefore = parseKit(before);
  if (!parsedBefore.ok) throw new Error(`plan before is not a valid kit: ${parsedBefore.errors.join("; ")}`);
  const parsedAfter = parseKit(after);
  if (!parsedAfter.ok) throw new Error(`plan after is not a valid kit: ${parsedAfter.errors.join("; ")}`);
  if (parsedBefore.kit.id !== id) {
    throw new Error(`plan before id ${JSON.stringify(parsedBefore.kit.id)} does not match workspace ${JSON.stringify(id)}`);
  }
  if (parsedAfter.kit.id !== id) {
    throw new Error(`plan after id ${JSON.stringify(parsedAfter.kit.id)} does not match workspace ${JSON.stringify(id)}`);
  }
  if (!isDeepStrictEqual(parsedAfter.kit, expected)) {
    throw new Error("plan after does not match the expected kit");
  }

  const catalogEntry = await catalogWorkspace(root, id);
  const workspace = await existingRealDirectory(catalogEntry.directory, "workspace directory");
  if (workspace === null) throw new Error(`workspace directory does not exist: ${id}`);
  const kitPath = join(workspace, "kit.yaml");
  const physicalKit = await requireRegularKit(kitPath);
  if (!insideRoot(workspace, physicalKit)) throw new Error(`kit.yaml escapes the workspace: ${kitPath}`);

  const original = Buffer.from(before, "utf8");
  const actual = await fs.readFile(physicalKit);
  if (!actual.equals(original)) {
    throw new Error("kit.yaml no longer matches the planned original bytes");
  }

  // A path that expands to the same location (rewrite-paths /Users/me -> ~)
  // needs no check, so a repository that is absent on this machine can still
  // be rewritten.
  const beforePaths = new Map(parsedBefore.kit.repositories.map((repository) => [
    repository.id,
    resolveRepositoryPath(workspace, repository.path),
  ]));
  for (const repository of parsedAfter.kit.repositories) {
    const expanded = resolveRepositoryPath(workspace, repository.path);
    if (beforePaths.get(repository.id) !== expanded) await assertRepositoryTopLevel(expanded);
  }

  const backup = join(workspace, `kit.yaml.prev-${new Date().toISOString()}-${randomUUID()}`);
  await createFileExclusive(backup, original);

  const lockPath = join(workspace, "kit.yaml.lock");
  let lockHandle = null;
  let ownedLock = false;
  let primaryError = null;
  try {
    try {
      lockHandle = await fs.open(lockPath, "wx", 0o600);
      ownedLock = true;
    } catch (lockError) {
      if (lockError && lockError.code === "EEXIST") {
        const held = new Error(`kit.yaml.lock is held; kit replacement refused: ${lockPath}`);
        held.code = "EEXIST";
        held.backup = backup;
        throw held;
      }
      if (lockError && lockError.backup === undefined) lockError.backup = backup;
      throw lockError;
    }

    const rechecked = await requireRegularKit(kitPath);
    if (rechecked !== physicalKit) {
      const changedPath = new Error("kit.yaml path changed during the apply window");
      changedPath.backup = backup;
      throw changedPath;
    }
    const current = await fs.readFile(rechecked);
    if (!current.equals(original)) {
      const changed = new Error("kit.yaml changed during the apply window");
      changed.backup = backup;
      throw changed;
    }
    await writeFileAtomic(rechecked, after);
    await pruneKitBackups(workspace);
    return { path: rechecked, backup };
  } catch (error) {
    primaryError = error;
    if (error && error.backup === undefined) error.backup = backup;
    throw error;
  } finally {
    if (ownedLock) {
      let cleanupFailure = null;
      try {
        await lockHandle.close();
      } catch (closeError) {
        cleanupFailure = closeError;
      }
      try {
        await fs.unlink(lockPath);
      } catch (cleanupError) {
        if (cleanupFailure === null) cleanupFailure = cleanupError;
      }
      if (cleanupFailure !== null) {
        if (cleanupFailure.backup === undefined) cleanupFailure.backup = backup;
        if (!primaryError) throw cleanupFailure;
      }
    }
  }
}
