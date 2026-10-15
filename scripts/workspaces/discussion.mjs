// Step 3: ThreadV1 validation, owned thread persistence, read-only history and
// guarded resume with owned-child lifecycle.
//
// Library-only composition over the canonical workspace store: thread records
// live at <workspace>/threads/<thread_id>.json and the owned session copy at
// <workspace>/sessions/<thread_id>/. This batch exposes validateThread,
// readThread and create/list/history/subscribe/resume/close on
// createDiscussionService; prompt delivery, scheduling and handoff mutations
// belong to later steps. Node stdlib only.

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readSessionBranch } from "../spec-observe/core.mjs";
import { inspectProcess, processIdentity } from "../spec-observe/process-identity.mjs";
import { prepareAssignmentSpecTarget, findAssignment, launchAssignment as launchAssignmentOwner, resolveAssignment, resolveTarget } from "./assignments.mjs";
import { observeAssignment } from "./reconcile.mjs";
import { closeOwnedPiChild, createPiRpc } from "./pi-rpc.mjs";
import { createReferenceCatalog, validateReferences } from "./references.mjs";
import {
  addMaterial,
  createFileExclusive,
  fetchWorkspace,
  listWorkspaces,
  requestMaterialPath,
  resolveRepositoryPath,
  resolveStorageRoot,
  resolveWorkspacePath,
  writeFileAtomic,
} from "./store.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const QUEUE_STATES = new Set(["queued", "delivering", "uncertain"]);
const TARGET_KINDS = new Set(["workspace", "repository", "worktree"]);
const MAX_TITLE_LENGTH = 200;
// A thread keeps this title until its first message is named (see nameThread).
export const DEFAULT_THREAD_TITLE = "New thread";
const MAX_ACCEPTED_MESSAGE_IDS = 100;
const MAX_MESSAGE_BYTES = 64 * 1024;
const PS_SCAN_TIMEOUT_MS = 2000;
const PS_SCAN_MAX_BYTES = 1024 * 1024;
const EMPTY_BRANCH = {
  header: null,
  entries: [],
  leaf_id: null,
  incomplete_tail: false,
  skipped_lines: 0,
  truncated: false,
};

const defaultClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isUuid = (value) => typeof value === "string" && UUID_PATTERN.test(value);
const isIsoUtc = (value) => {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
};
const isCanonicalAbsolutePath = (value) =>
  typeof value === "string" && value !== "" && isAbsolute(value) && !value.includes("\0") && resolve(value) === value;
const isSafeArgValue = (value) =>
  typeof value === "string" && value.length > 0 && value[0] !== "-" && !/[\u0000-\u001f\u007f]/.test(value);

function typedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}
const invalidThread = (message, extra = {}) => typedError("invalid-thread", message, extra);
const serviceClosed = () => typedError("service-closed", "discussion service is closed");
const threadExists = (threadId) => typedError("thread-exists", `thread already exists: ${threadId}`);
const threadNotFound = (threadId) => typedError("thread-not-found", `thread not found: ${threadId}`);

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) throw invalidThread(`${label} must be an object`);
  return value;
}

function validateTargetShape(target) {
  requirePlainObject(target, "target");
  if (!TARGET_KINDS.has(target.kind)) throw invalidThread(`target.kind is not supported: ${String(target.kind)}`);
  if (target.kind === "repository" && (typeof target.repository_id !== "string" || target.repository_id === "")) {
    throw invalidThread("target.repository_id must be a non-empty string");
  }
  if (target.kind === "worktree" && !isCanonicalAbsolutePath(target.path)) {
    throw invalidThread("target.path must be a canonical absolute path");
  }
  return target;
}

function validateModel(model) {
  if (model === undefined || model === null) return;
  requirePlainObject(model, "model");
  if (!isSafeArgValue(model.provider)) {
    throw invalidThread("model.provider must be a non-empty string without control characters or a leading dash");
  }
  if (!isSafeArgValue(model.model)) {
    throw invalidThread("model.model must be a non-empty string without control characters or a leading dash");
  }
  if (model.thinking !== undefined && !THINKING_LEVELS.includes(model.thinking)) {
    throw invalidThread(`model.thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }
}

function validateQueue(queue) {
  if (!Array.isArray(queue)) throw invalidThread("queue must be an array");
  for (const item of queue) {
    requirePlainObject(item, "queue item");
    if (!isUuid(item.id)) throw invalidThread("queue item id must be a UUID");
    if (typeof item.text !== "string") throw invalidThread("queue item text must be a string");
    if (!isIsoUtc(item.queued_at)) throw invalidThread("queue item queued_at must be an ISO UTC string");
    if (!QUEUE_STATES.has(item.state)) throw invalidThread("queue item state must be queued, delivering or uncertain");
    if (!Number.isSafeInteger(item.attempt) || item.attempt < 0) {
      throw invalidThread("queue item attempt must be a nonnegative integer");
    }
  }
}

function validateHandoffs(handoffs) {
  if (!Array.isArray(handoffs)) throw invalidThread("handoffs must be an array");
  for (const handoff of handoffs) {
    requirePlainObject(handoff, "handoff");
    if (!isUuid(handoff.request_id)) throw invalidThread("handoff request_id must be a UUID");
    if (typeof handoff.brief !== "string") throw invalidThread("handoff brief must be a string");
    if (!isIsoUtc(handoff.saved_at)) throw invalidThread("handoff saved_at must be an ISO UTC string");
    if (handoff.references !== undefined) validateReferences(handoff.references);
    if (handoff.assignment_id !== undefined && (typeof handoff.assignment_id !== "string" || handoff.assignment_id === "")) {
      throw invalidThread("handoff assignment_id must be a non-empty string when present");
    }
  }
}

function validateOptionalProcess(process) {
  if (process === undefined || process === null) return;
  requirePlainObject(process, "process");
  if (!Number.isSafeInteger(process.pid) || process.pid <= 0) {
    throw invalidThread("process.pid must be a positive safe integer");
  }
  if (process.started_at !== null && (typeof process.started_at !== "string" || process.started_at === "")) {
    throw invalidThread("process.started_at must be a non-empty string or null");
  }
}

function validateImport(record) {
  if (record.import === undefined || record.import === null) return;
  requirePlainObject(record.import, "import");
  if (typeof record.import.source !== "string" || record.import.source === "") {
    throw invalidThread("import.source must be a non-empty string");
  }
  if (typeof record.import.digest !== "string" || record.import.digest === "") {
    throw invalidThread("import.digest must be a non-empty string");
  }
  if (!isIsoUtc(record.import.imported_at)) throw invalidThread("import.imported_at must be an ISO UTC string");
  requirePlainObject(record.import.adjacent, "import.adjacent");
  if (record.import.adjacent.authority !== "none") {
    throw invalidThread("import.adjacent.authority must be none");
  }
}

/**
 * Validate a full ThreadV1 record lexically. Unknown additive keys, including
 * nested provenance, are preserved untouched and the same object is returned;
 * a malformed required field throws a typed `invalid-thread` error and the
 * record is never repaired.
 * @param {object} record
 * @returns {object}
 */
export function validateThread(record) {
  requirePlainObject(record, "thread record");
  if (record.schema_version !== 1) throw invalidThread("schema_version must be 1");
  if (!isUuid(record.thread_id)) throw invalidThread("thread_id must be a UUID");
  if (!isUuid(record.session_id)) throw invalidThread("session_id must be a UUID");
  if (typeof record.workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(record.workspace_id)) {
    throw invalidThread("workspace_id must be a workspace id");
  }
  if (typeof record.title !== "string" || record.title.length < 1 || record.title.length > MAX_TITLE_LENGTH) {
    throw invalidThread(`title must be 1..${MAX_TITLE_LENGTH} characters`);
  }
  validateTargetShape(record.target);
  if (!isCanonicalAbsolutePath(record.execution_dir)) {
    throw invalidThread("execution_dir must be a canonical absolute path");
  }
  if (!isCanonicalAbsolutePath(record.session_dir)) {
    throw invalidThread("session_dir must be a canonical absolute path");
  }
  if (record.session_file !== null && !isCanonicalAbsolutePath(record.session_file)) {
    throw invalidThread("session_file must be null or a canonical absolute path");
  }
  if (typeof record.history_only !== "boolean") throw invalidThread("history_only must be a boolean");
  validateQueue(record.queue);
  if (typeof record.queue_paused !== "boolean") throw invalidThread("queue_paused must be a boolean");
  if (record.history_only) {
    if (record.queue_paused !== true) throw invalidThread("history_only records must be paused");
    if (record.queue.length !== 0) throw invalidThread("history_only records must have an empty queue");
    if (record.process !== undefined && record.process !== null) {
      throw invalidThread("history_only records must not own a process");
    }
  }
  if (
    !Array.isArray(record.accepted_message_ids) ||
    record.accepted_message_ids.length > MAX_ACCEPTED_MESSAGE_IDS ||
    record.accepted_message_ids.some((id) => !isUuid(id))
  ) {
    throw invalidThread(`accepted_message_ids must be up to ${MAX_ACCEPTED_MESSAGE_IDS} UUIDs`);
  }
  validateHandoffs(record.handoffs);
  if (record.attention !== null && typeof record.attention !== "string") {
    throw invalidThread("attention must be null or a string");
  }
  if (!isIsoUtc(record.created_at)) throw invalidThread("created_at must be an ISO UTC string");
  if (!isIsoUtc(record.updated_at)) throw invalidThread("updated_at must be an ISO UTC string");
  validateModel(record.model);
  validateOptionalProcess(record.process);
  validateImport(record);
  return record;
}

async function physicalDirectory(path, label) {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new Error(`${label} is not readable: ${path}`, { cause: error });
  }
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  const physical = await realpath(path);
  if (physical !== resolve(path)) throw new Error(`${label} path contains a symbolic link: ${path}`);
  return physical;
}

// The owned session directory must be exactly <workspace>/sessions/<thread_id>,
// and a recorded session file must be a direct non-symlink regular child.
async function assertOwnedSessionPaths(workspaceDirectory, record) {
  const expected = join(workspaceDirectory, "sessions", record.thread_id);
  if (record.session_dir !== expected) throw invalidThread("session_dir is not the owned thread directory");
  let info;
  try {
    info = await lstat(expected);
  } catch (error) {
    throw invalidThread("session_dir is missing", { cause: error });
  }
  if (info.isSymbolicLink()) throw invalidThread("session_dir must not be a symlink");
  if (!info.isDirectory()) throw invalidThread("session_dir is not a directory");
  if ((await realpath(expected)) !== expected) throw invalidThread("session_dir path contains a symbolic link");
  if (record.session_file === null) return;
  const rel = relative(expected, record.session_file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/") || rel.includes("\\")) {
    throw invalidThread("session_file is not directly inside session_dir");
  }
  const fileInfo = await lstatOrNull(record.session_file);
  if (fileInfo === null) return;
  if (fileInfo.isSymbolicLink()) throw invalidThread("session_file must not be a symlink");
  if (!fileInfo.isFile()) throw invalidThread("session_file is not a regular file");
  if ((await realpath(record.session_file)) !== record.session_file) {
    throw invalidThread("session_file path contains a symbolic link");
  }
}

async function readRecordAt(directory, workspaceId, threadId) {
  let file;
  try {
    file = await resolveWorkspacePath(directory, `threads/${threadId}.json`);
  } catch (error) {
    if (error && typeof error.message === "string" && error.message.includes("does not exist")) {
      throw threadNotFound(threadId);
    }
    throw invalidThread(`thread file is not an owned regular path: ${error.message}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw invalidThread(`thread record is not valid JSON: ${error.message}`, { cause: error });
  }
  const record = validateThread(parsed);
  if (record.thread_id !== threadId) throw invalidThread("thread file identity does not match its name");
  if (record.workspace_id !== workspaceId) {
    throw invalidThread("thread record workspace_id does not match the requested workspace");
  }
  await assertOwnedSessionPaths(directory, record);
  return record;
}

async function readOwnedRecord(root, workspaceId, threadId) {
  const workspace = await fetchWorkspace(root, workspaceId);
  const directory = await physicalDirectory(workspace.directory, "workspace directory");
  return readRecordAt(directory, workspaceId, threadId);
}

/**
 * Read one owned ThreadV1 record. The physical workspace, thread file and
 * session directory are resolved through the canonical store before any bytes
 * are trusted; escapes and symlinks are refused.
 * @param {string} root
 * @param {string} workspaceId
 * @param {string} threadId
 * @returns {Promise<object>}
 */
export async function readThread(root, workspaceId, threadId) {
  if (typeof root !== "string" || root === "") throw new TypeError("root must be a non-empty string");
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw invalidThread("workspace_id must be a workspace id");
  }
  if (!isUuid(threadId)) throw invalidThread("thread_id must be a UUID");
  return readOwnedRecord(root, workspaceId, threadId);
}

async function canonicalIfPossible(path) {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

// Browse-only intended execution path for a missing/unusable target. Unknown
// repositories fall back to the workspace directory; the workspace fallback is
// never executed silently because attention stays 'missing-directory'.
async function intendedExecutionPath(workspace, directory, target) {
  if (target.kind === "workspace") return directory;
  if (target.kind === "repository") {
    const record = (Array.isArray(workspace.repositories) ? workspace.repositories : [])
      .find((entry) => entry && entry.id === target.repository_id);
    if (!record || typeof record.path !== "string" || record.path === "") return directory;
    return canonicalIfPossible(resolveRepositoryPath(directory, record.path));
  }
  return canonicalIfPossible(resolve(target.path));
}

// Map one stored ThreadV1 target to the adj4 resolveTarget input: workspace
// targets are unbound (null), repository targets pass their id, and worktree
// targets bind only to the unique recorded repository whose absolute or
// workspace-relative path resolves to the same physical worktree path.
// Unresolvable entry paths are ignored; absent or ambiguous bindings throw so
// callers keep their existing browse-only missing-directory attention.
async function adj4TargetFor(workspace, target) {
  if (target.kind === "workspace") return null;
  if (target.kind === "repository") return target.repository_id;
  let worktree;
  try {
    worktree = await realpath(target.path);
  } catch (error) {
    throw new Error(`worktree target is not resolvable: ${target.path}`, { cause: error });
  }
  const matches = [];
  for (const entry of Array.isArray(workspace.repositories) ? workspace.repositories : []) {
    if (!entry || typeof entry.id !== "string" || typeof entry.path !== "string" || entry.path === "") continue;
    const declared = resolveRepositoryPath(workspace.directory, entry.path);
    let physical;
    try {
      physical = await realpath(declared);
    } catch {
      continue;
    }
    if (physical === worktree) matches.push(entry.id);
  }
  if (matches.length !== 1) {
    throw new Error(`worktree target has no unique recorded repository: ${target.path}`);
  }
  return matches[0];
}

async function ensureOwnedDirectory(parent, name) {
  const path = join(parent, name);
  let info = await lstatOrNull(path);
  if (info === null) {
    try {
      await mkdir(path, { recursive: false });
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
    info = await lstatOrNull(path);
  }
  if (info === null) throw invalidThread(`${name} is unavailable`);
  if (info.isSymbolicLink()) throw invalidThread(`${name} must not be a symlink`);
  if (!info.isDirectory()) throw invalidThread(`${name} is not a directory`);
  if ((await realpath(path)) !== path) throw invalidThread(`${name} path contains a symbolic link`);
  return path;
}

async function ownedSessionFile(record) {
  if (record.session_file !== null) {
    const info = await lstatOrNull(record.session_file);
    if (info === null) return null;
    if (info.isSymbolicLink() || !info.isFile()) throw invalidThread("session_file is not an owned regular file");
    return record.session_file;
  }
  const names = (await readdir(record.session_dir)).filter((name) => name.endsWith(".jsonl")).sort();
  const files = [];
  for (const name of names) {
    const candidate = join(record.session_dir, name);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw invalidThread("session file must not be a symlink");
    if (info.isFile()) files.push(candidate);
  }
  if (files.length === 0) return null;
  if (files.length > 1) throw invalidThread("session directory contains multiple session files");
  return files[0];
}

function parseDiscussionListing(text, threadId) {
  const token = `discussion:${threadId}`;
  const matches = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!match) return { ok: false, reason: "malformed" };
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: false, reason: "malformed" };
    if (match[2].split(/\s+/).includes(token)) matches.push(pid);
  }
  return { ok: true, matches };
}

/**
 * Create the discussion service slice. root/agentDir are bound host
 * configuration; per-request overrides are not accepted. assignmentAdapters is
 * trusted construction-time plumbing for the final adj4 tmux/observation
 * boundaries only; public requests can never supply adapters, resolvers or
 * paths.
 * @param {{root?: string, agentDir?: string|null, spawn?: Function,
 *   clock?: object, assignmentAdapters?: object|null}} options
 * @returns {object}
 */
export function createDiscussionService({ root, agentDir = null, spawn = nodeSpawn, clock = defaultClock, assignmentAdapters = null, suggestTitle = null, referenceCatalog = createReferenceCatalog({ agentDir: agentDir ?? undefined }) } = {}) {
  const configuredRoot = root === undefined || root === null || root === "" ? resolveStorageRoot(process.env, homedir()) : root;
  if (typeof configuredRoot !== "string" || !isAbsolute(configuredRoot) || resolve(configuredRoot) !== configuredRoot) {
    throw new TypeError("root must be a lexical canonical absolute path");
  }
  if (agentDir !== null && agentDir !== undefined) {
    if (typeof agentDir !== "string" || !isAbsolute(agentDir) || resolve(agentDir) !== agentDir) {
      throw new TypeError("agentDir must be a lexical canonical absolute path when provided");
    }
  }
  const spawnImpl = typeof spawn === "function" ? spawn : nodeSpawn;
  const suggestTitleImpl = typeof suggestTitle === "function" ? suggestTitle : null;
  const clockImpl = clock && typeof clock.setTimeout === "function" && typeof clock.clearTimeout === "function" ? clock : defaultClock;
  // Trusted final-boundary adapters are accepted only at construction; public
  // requests can never supply adapters, resolvers or paths.
  let trustedAdapters = null;
  if (assignmentAdapters !== null && assignmentAdapters !== undefined) {
    if (typeof assignmentAdapters !== "object" || Array.isArray(assignmentAdapters)) {
      throw new TypeError("assignmentAdapters must be a plain object when provided");
    }
    if (assignmentAdapters.tmuxRun !== undefined && typeof assignmentAdapters.tmuxRun !== "function") {
      throw new TypeError("assignmentAdapters.tmuxRun must be a function when provided");
    }
    const probes = assignmentAdapters.observationProbes;
    if (probes !== undefined && (probes === null || typeof probes !== "object" || Array.isArray(probes))) {
      throw new TypeError("assignmentAdapters.observationProbes must be a plain object when provided");
    }
    trustedAdapters = assignmentAdapters;
  }
  const launchAdapters = trustedAdapters;

  let closed = false;
  let closePromise = null;
  const subscribers = new Map();
  // Per-thread transient event watermark. Every scoped emission advances the
  // thread's sequence even with no subscribers, so an SSE snapshot can tell
  // which buffered runtime frames it already reflects. Sequences stay
  // monotonic for the service lifetime, including across generations.
  const eventSequences = new Map();
  const threadLocks = new Map();
  const ownedChildren = new Map();
  const ownedAdapters = new Map();
  const recoveredThreads = new Set();
  const ownedDelivering = new Map();
  let responseLease = null;

  let pumpRunning = false;
  let pumpRequested = false;
  let pumpPromise = null;
  const dispatchOutcomes = new Map();
  const waitingDispatches = new Set();
  const MAX_OWNED_CHILDREN = 4;
  let capacityReservations = 0;
  let capacityMutex = Promise.resolve();

  function acquireCapacity() {
    const attempt = capacityMutex.then(async () => {
      if (closed) throw serviceClosed();
      if (ownedChildren.size + capacityReservations < MAX_OWNED_CHILDREN) {
        capacityReservations += 1;
        return;
      }
      // Full: try one ready, idle, non-current owned adapter ordered by the
      // runtime's lastUsed (then key). Unknown or unconfirmed victims are kept.
      const candidates = [];
      for (const [key, entry] of ownedAdapters) {
        if (entry.evicting === true) continue;
        if (ownedDelivering.has(key)) continue;
        if (responseLease !== null && entry.generation === responseLease.generation) continue;
        if (!entry.child || typeof entry.child.pid !== "number") continue;
        const runtime = runtimes.get(key);
        candidates.push({ key, entry, lastUsed: runtime?.lastUsed ?? 0 });
      }
      const threadOf = (key) => key.slice(key.indexOf(":") + 1);
      candidates.sort((a, b) => a.lastUsed - b.lastUsed || threadOf(a.key).localeCompare(threadOf(b.key)));
      for (const { key, entry } of candidates) {
        if (ownedDelivering.has(key)) continue;
        if (responseLease !== null && entry.generation === responseLease.generation) continue;
        let state;
        try {
          state = await entry.adapter.request({ type: "get_state" });
        } catch {
          continue;
        }
        if (
          state.data?.isStreaming !== false ||
          state.data?.isCompacting !== false ||
          state.data?.pendingMessageCount !== 0
        ) {
          continue;
        }
        const [storedWorkspace, storedThread] = key.split(":");
        let stored;
        try {
          stored = await readOwnedRecord(configuredRoot, storedWorkspace, storedThread);
        } catch {
          continue;
        }
        if (
          stored.attention === "uncertain" ||
          stored.attention === "stalled" ||
          stored.attention === "live-owner" ||
          stored.queue.some((item) => item.state === "uncertain" || item.state === "delivering")
        ) {
          continue;
        }
        if (ownedDelivering.has(key)) continue;
        if (responseLease !== null && entry.generation === responseLease.generation) continue;
        if (ownedAdapters.get(key) !== entry || entry.evicting === true) continue;
        entry.evicting = true;
        const shutdown = await entry.adapter.close().catch(() => null);
        if (shutdown && shutdown.confirmed_death === true) {
          if (ownedAdapters.get(key) === entry) ownedAdapters.delete(key);
          ownedChildren.delete(entry.child);
          void onOwnedExit(key, entry.adapter, entry.child, entry.process, entry.directory);
          capacityReservations += 1;
          return;
        }
        // Unconfirmed: retain the entry and child count; schedule visible
        // attention and owned-exit cleanup off the capacity mutex.
        const runtime = runtimes.get(key);
        if (runtime) runtime.lastUsed = nowFn();
        const [workspaceId, threadId] = key.split(":");
        void withThreadLock(workspaceId, threadId, async () => {
          try {
            const { record, directory } = await loadServiceRecord(workspaceId, threadId);
            if (record.attention !== "live-owner") {
              await persistRecord(directory, {
                ...record,
                attention: "live-owner",
                updated_at: new Date().toISOString(),
              });
            }
          } catch {
            // Visible through the next read.
          }
        });
      }
      throw typedError("child-limit", "owned discussion child limit reached");
    });
    capacityMutex = attempt.catch(() => {});
    return attempt;
  }

  function reservationRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      capacityReservations = Math.max(0, capacityReservations - 1);
    };
  }

  // Unconfirmed closes keep the owned handle tracked so capacity cannot be
  // freed on an unknown live child; deletion requires a real exit fact or a
  // confirmed death from the owned handle.
  function releaseOwnedChildIfDead(child, shutdown, exitFacts) {
    if (!child) return;
    const dead =
      exitFacts === true || (shutdown !== null && shutdown !== undefined && shutdown.confirmed_death === true);
    if (dead) ownedChildren.delete(child);
  }

  const idleTimers = new Map();

  function clearIdleTimer(key) {
    const handle = idleTimers.get(key);
    if (handle !== undefined) {
      clockImpl.clearTimeout(handle);
      idleTimers.delete(key);
    }
  }

  function clearAllIdleTimers() {
    for (const handle of idleTimers.values()) clockImpl.clearTimeout(handle);
    idleTimers.clear();
  }

  function resetIdleTimer(workspace_id, thread_id) {
    const key = `${workspace_id}:${thread_id}`;
    clearIdleTimer(key);
    const entry = ownedAdapters.get(key);
    const runtime = runtimes.get(key);
    if (closed || !entry || entry.evicting === true || !runtime || runtime.generation !== entry.generation) return;
    const generation = entry.generation;
    const timer = clockImpl.setTimeout(() => {
      idleTimers.delete(key);
      void expireIdleChild(key, workspace_id, thread_id, generation);
    }, 10 * 60 * 1000);
    if (timer && typeof timer.unref === "function") timer.unref();
    idleTimers.set(key, timer);
  }

  async function expireIdleChild(key, workspace_id, thread_id, generation) {
    if (closed) return;
    const entry = ownedAdapters.get(key);
    if (!entry || entry.evicting === true || entry.generation !== generation) return;
    if (responseLease !== null && responseLease.generation === generation) return;
    if (ownedDelivering.has(key)) return;
    let state;
    try {
      state = await entry.adapter.request({ type: "get_state" });
    } catch {
      return;
    }
    const idle =
      state.data?.isStreaming === false &&
      state.data?.isCompacting === false &&
      state.data?.pendingMessageCount === 0;
    if (!idle) {
      resetIdleTimer(workspace_id, thread_id);
      return;
    }
    try {
      const record = await readOwnedRecord(configuredRoot, workspace_id, thread_id);
      if (
        record.attention === "uncertain" ||
        record.attention === "stalled" ||
        record.attention === "live-owner" ||
        record.queue.some((item) => item.state === "uncertain" || item.state === "delivering")
      ) {
        resetIdleTimer(workspace_id, thread_id);
        return;
      }
    } catch {
      resetIdleTimer(workspace_id, thread_id);
      return;
    }
    if (closed) return;
    if (ownedAdapters.get(key) !== entry || entry.evicting === true || entry.generation !== generation) return;
    if (responseLease !== null && responseLease.generation === generation) return;
    if (ownedDelivering.has(key)) return;
    entry.evicting = true;
    const shutdown = await entry.adapter.close().catch(() => null);
    if (shutdown && shutdown.confirmed_death === true) {
      if (ownedAdapters.get(key) === entry) ownedAdapters.delete(key);
      releaseOwnedChildIfDead(entry.child, shutdown, false);
      void onOwnedExit(key, entry.adapter, entry.child, entry.process, entry.directory);
    } else {
      const runtime = runtimes.get(key);
      if (runtime) runtime.lastUsed = nowFn();
      void withThreadLock(workspace_id, thread_id, async () => {
        try {
          const current = ownedAdapters.get(key);
          if (!current || current.generation !== generation) return;
          const { record, directory } = await loadServiceRecord(workspace_id, thread_id);
          const again = ownedAdapters.get(key);
          if (!again || again.generation !== generation) return;
          await persistRecord(directory, {
            ...record,
            process: entry.process,
            attention: "live-owner",
            updated_at: new Date().toISOString(),
          });
        } catch {
          // Visible through the next read.
        }
      });
    }
  }

  const runtimes = new Map();
  const nowFn =
    typeof clockImpl.now === "function"
      ? () => clockImpl.now()
      : typeof clockImpl.now === "number"
        ? () => clockImpl.now
        : () => Date.now();
  let stallTimer = null;

  function emitScoped(workspace_id, thread_id, generation, type, event) {
    const key = `${workspace_id}:${thread_id}`;
    const sequence = (eventSequences.get(key) ?? 0) + 1;
    eventSequences.set(key, sequence);
    const listeners = subscribers.get(key);
    if (!listeners) return;
    const payload = { workspace_id, thread_id, generation, sequence, type, event };
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch {
        // A throwing subscriber must not affect scheduling or delivery.
      }
    }
  }

  function clearStallTimer() {
    if (stallTimer !== null) {
      clockImpl.clearTimeout(stallTimer);
      stallTimer = null;
    }
  }

  function resetStallTimer(generation) {
    const lease = responseLease;
    if (closed || !lease || lease.generation !== generation) return;
    clearStallTimer();
    stallTimer = clockImpl.setTimeout(() => {
      stallTimer = null;
      const current = responseLease;
      if (closed || current !== lease || lease.generation !== generation) return;
      void withThreadLock(lease.workspace_id, lease.thread_id, async () => {
        try {
          const { record, directory } = await loadServiceRecord(lease.workspace_id, lease.thread_id);
          if (record.attention !== "stalled") {
            await persistRecord(directory, { ...record, attention: "stalled", updated_at: new Date().toISOString() });
          }
        } catch {
          // Visible through the next read.
        }
      });
    }, 10 * 60 * 1000);
    if (stallTimer && typeof stallTimer.unref === "function") stallTimer.unref();
  }

  function noteRuntimeEvent(workspace_id, thread_id, generation, event) {
    const runtime = runtimes.get(`${workspace_id}:${thread_id}`);
    if (!runtime || runtime.generation !== generation) return;
    runtime.lastEventAt = nowFn();
    runtime.lastUsed = runtime.lastEventAt;
    if (!closed) {
      resetIdleTimer(workspace_id, thread_id);
    }
    if (!closed && (event?.type === "transport_error" || event?.type === "policy_refusal")) {
      const attention = event.type === "policy_refusal" ? "policy-refusal" : "uncertain";
      const key = `${workspace_id}:${thread_id}`;
      void withThreadLock(workspace_id, thread_id, async () => {
        try {
          const current = ownedAdapters.get(key);
          if (!current || current.generation !== generation) return;
          const { record, directory } = await loadServiceRecord(workspace_id, thread_id);
          const again = ownedAdapters.get(key);
          if (!again || again.generation !== generation) return;
          if (record.attention !== attention) {
            await persistRecord(directory, { ...record, attention, updated_at: new Date().toISOString() });
          }
        } catch {
          // Visible through the next read.
        }
      });
    }
    let type = null;
    if (event?.type === "message_update") {
      type = "delta";
      const delta = event.delta ?? event.assistantMessageEvent?.delta ?? "";
      if (typeof delta === "string" && delta !== "") {
        runtime.partial += delta;
        if (Buffer.byteLength(runtime.partial, "utf8") > 256 * 1024) {
          const bytes = Buffer.from(runtime.partial, "utf8");
          let start = bytes.length - 256 * 1024;
          while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
          runtime.partial = bytes.subarray(start).toString("utf8");
        }
      }
    } else if (event?.type === "message_end") {
      type = "message_end";
      runtime.partial = "";
    } else if (event?.type === "agent_settled") {
      type = "settled";
    } else if (event?.type === "tool_execution_start" || event?.type === "tool_execution_end") {
      type = "tool";
    } else if (event?.type === "entry_appended" || event?.type === "session_info") {
      type = "state";
    }
    if (type === null) {
      type =
        event?.type === "extension_error" || event?.type === "transport_error" || event?.type === "policy_refusal"
          ? "notice"
          : "state";
    }
    emitScoped(workspace_id, thread_id, generation, type, event);
    if (!closed) resetStallTimer(generation);
  }

  function releaseLease(lease) {
    if (responseLease !== lease) return;
    clearStallTimer();
    responseLease = null;
    requestPump();
  }

  function withThreadLock(workspaceId, threadId, task) {
    const key = `${workspaceId}:${threadId}`;
    const prior = threadLocks.get(key) ?? Promise.resolve();
    const run = prior.then(() => task());
    const settled = run.then(
      () => {},
      () => {},
    );
    threadLocks.set(key, settled);
    settled.then(() => {
      if (threadLocks.get(key) === settled) threadLocks.delete(key);
    });
    return run;
  }

  async function persistRecord(directory, record) {
    validateThread(record);
    await writeFileAtomic(join(directory, "threads", `${record.thread_id}.json`), `${JSON.stringify(record)}\n`);
    const runtime = runtimes.get(`${record.workspace_id}:${record.thread_id}`);
    const generation = runtime?.generation ?? null;
    emitScoped(record.workspace_id, record.thread_id, generation, "state", {
      type: "state",
      title: record.title,
      queue: record.queue,
      queue_paused: record.queue_paused,
      attention: record.attention,
    });
    if (typeof record.attention === "string" && record.attention !== "") {
      emitScoped(record.workspace_id, record.thread_id, generation, "notice", {
        type: "notice",
        attention: record.attention,
      });
    }
    return record;
  }

  // First-access recovery converts durable delivering rows to uncertain and
  // marks the thread recovered only after publication succeeds. The service's
  // own current delivering row (later delivery batches) is exempt, and invalid
  // records never reach this path because reading validates first.
  async function recoverRecord(directory, workspaceId, record) {
    const key = `${workspaceId}:${record.thread_id}`;
    if (recoveredThreads.has(key)) return record;
    const flight = ownedDelivering.get(key);
    let changed = false;
    const queue = record.queue.map((item) => {
      if (item.state !== "delivering" || item.id === flight?.id) return item;
      changed = true;
      return { ...item, state: "uncertain" };
    });
    if (!changed) {
      recoveredThreads.add(key);
      return record;
    }
    const recovered = await persistRecord(directory, {
      ...record,
      queue,
      attention: "uncertain",
      updated_at: new Date().toISOString(),
    });
    recoveredThreads.add(key);
    return recovered;
  }

  async function loadServiceRecord(workspaceId, threadId) {
    const workspace = await fetchWorkspace(configuredRoot, workspaceId);
    const directory = await physicalDirectory(workspace.directory, "workspace directory");
    const record = await readRecordAt(directory, workspaceId, threadId);
    return { record: await recoverRecord(directory, workspaceId, record), workspace, directory };
  }

  function scanDiscussionProcesses(threadId) {
    return new Promise((resolvePromise) => {
      let child;
      try {
        child = spawnImpl("ps", ["-axo", "pid=,args="], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        resolvePromise({ ok: false, reason: "spawn-failed" });
        return;
      }
      if (!child.stdout) {
        resolvePromise({ ok: false, reason: "missing-stdout" });
        return;
      }
      let settled = false;
      let bytes = 0;
      let timer = null;
      const chunks = [];
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clockImpl.clearTimeout(timer);
        resolvePromise(result);
      };
      timer = clockImpl.setTimeout(() => {
        try {
          child.kill?.("SIGKILL");
        } catch {
          // already exited
        }
        finish({ ok: false, reason: "timeout" });
      }, PS_SCAN_TIMEOUT_MS);
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > PS_SCAN_MAX_BYTES) {
          try {
            child.kill?.("SIGKILL");
          } catch {
            // already exited
          }
          finish({ ok: false, reason: "truncated" });
          return;
        }
        chunks.push(chunk);
      });
      child.stdout.on("error", () => finish({ ok: false, reason: "stdout-error" }));
      child.on("error", () => finish({ ok: false, reason: "spawn-error" }));
      // 'close' fires after stdout is drained; 'exit' can precede the data.
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish({ ok: false, reason: "exit" });
          return;
        }
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.trim() === "") {
          finish({ ok: false, reason: "empty-listing" });
          return;
        }
        finish(parseDiscussionListing(text, threadId));
      });
    });
  }

  async function onOwnedExit(key, adapter, child, capturedProcess, directory) {
    ownedChildren.delete(child);
    const [workspaceId, threadId] = key.split(":");
    try {
      await withThreadLock(workspaceId, threadId, async () => {
        const current = ownedAdapters.get(key);
        if (
          current &&
          (current.generation !== adapter.identity.generation ||
            current.process.pid !== capturedProcess.pid ||
            current.process.started_at !== capturedProcess.started_at)
        ) {
          return;
        }
        if (current) ownedAdapters.delete(key);
        const runtime = runtimes.get(key);
        if (runtime && runtime.generation === adapter.identity.generation) {
          emitScoped(workspaceId, threadId, adapter.identity.generation, "state", {
            type: "state",
            state: "exited",
          });
          runtimes.delete(key);
        }
        const record = await readOwnedRecord(configuredRoot, workspaceId, threadId);
        if (
          !record.process ||
          record.process.pid !== capturedProcess.pid ||
          record.process.started_at !== capturedProcess.started_at
        ) {
          return;
        }
        const { process: _process, ...rest } = record;
        await persistRecord(directory, {
          ...rest,
          attention: record.attention === "live-owner" ? null : record.attention,
        });
      });
    } catch {
      // The next read/resume observes the stale process record and refuses.
    }
  }

  async function ownedFileOrNull(file) {
    if (typeof file !== "string" || file === "") return null;
    const info = await lstatOrNull(file);
    if (info === null || info.isSymbolicLink() || !info.isFile()) return null;
    return file;
  }

  async function verifyOwnedSessionFile(record, file) {
    if (typeof file !== "string" || file === "") return false;
    const info = await lstatOrNull(file);
    if (info === null) throw typedError("session-mismatch", "recorded session file is missing");
    if (info.isSymbolicLink() || !info.isFile()) {
      throw typedError("session-mismatch", "recorded session file is not an owned regular file");
    }
    const branch = await readSessionBranch(file, { limit: 1 });
    const header = branch.header;
    if (!header || header.id !== record.session_id || resolve(header.cwd) !== record.execution_dir) {
      throw typedError("session-mismatch", "session header does not match the recorded thread");
    }
    return true;
  }

  async function discoverOwnedSessionFile(record) {
    const names = (await readdir(record.session_dir)).filter((name) => name.endsWith(".jsonl")).sort();
    const matches = [];
    for (const name of names) {
      const file = join(record.session_dir, name);
      const info = await lstatOrNull(file);
      if (info === null) throw typedError("session-mismatch", `owned session candidate is missing: ${name}`);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw typedError("session-mismatch", `owned session candidate is not a regular file: ${name}`);
      }
      let branch;
      try {
        branch = await readSessionBranch(file, { limit: 1 });
      } catch (error) {
        throw typedError("session-mismatch", `owned session candidate is unreadable: ${name}`, { cause: error });
      }
      if (!branch.header || branch.header.id !== record.session_id || resolve(branch.header.cwd) !== record.execution_dir) {
        throw typedError("session-mismatch", `owned session candidate header does not match: ${name}`);
      }
      matches.push(file);
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) throw typedError("session-mismatch", "multiple owned session files match the recorded session");
    return matches[0];
  }

  function attentionForError(error) {
    const code = error && error.code;
    if (code === "invalid-thread" || code === "service-closed") return null;
    if (code === "live-owner" || code === "session-mismatch") return code;
    return "start-failed";
  }

  async function create({ workspace_id, title = DEFAULT_THREAD_TITLE, target = { kind: "workspace" }, model, specPackage = null } = {}) {
    if (closed) throw serviceClosed();
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (typeof title !== "string" || title.length < 1 || title.length > MAX_TITLE_LENGTH) {
      throw invalidThread(`title must be 1..${MAX_TITLE_LENGTH} characters`);
    }
    const preservedTarget = validateTargetShape({ ...requirePlainObject(target, "target") });
    validateModel(model);
    if (specPackage !== null && specPackage !== undefined && (typeof specPackage !== "string" || specPackage === "")) {
      throw new TypeError("specPackage must be a non-empty string when provided");
    }
    const workspace = await fetchWorkspace(configuredRoot, workspace_id);
    const directory = await physicalDirectory(workspace.directory, "workspace directory");
    let resolved = null;
    let failureAttention = null;
    try {
      resolved = await resolveTarget({
        workspace,
        target: await adj4TargetFor(workspace, preservedTarget),
        specPackage: specPackage ?? null,
      });
    } catch (error) {
      if (specPackage !== null && specPackage !== undefined) throw error;
      failureAttention = "missing-directory";
    }
    const executionDir = resolved
      ? resolved.execution_dir
      : await intendedExecutionPath(workspace, directory, preservedTarget);
    const threadId = randomUUID();
    const timestamp = new Date().toISOString();
    const record = {
      schema_version: 1,
      thread_id: threadId,
      session_id: threadId,
      workspace_id,
      title,
      target: preservedTarget,
      execution_dir: executionDir,
      session_dir: join(directory, "sessions", threadId),
      session_file: null,
      history_only: false,
      queue: [],
      queue_paused: false,
      accepted_message_ids: [],
      handoffs: [],
      attention: resolved ? (resolved.attention[0] ?? null) : failureAttention,
      created_at: timestamp,
      updated_at: timestamp,
      ...(model === undefined ? {} : { model: isPlainObject(model) ? { ...model } : model }),
    };
    validateThread(record);
    return withThreadLock(workspace_id, threadId, async () => {
      if (closed) throw serviceClosed();
      await ensureOwnedDirectory(directory, "threads");
      await ensureOwnedDirectory(directory, "sessions");
      const sessionDir = record.session_dir;
      try {
        await mkdir(sessionDir, { recursive: false });
      } catch (error) {
        if (error && error.code === "EEXIST") throw threadExists(threadId);
        throw error;
      }
      try {
        await createFileExclusive(join(directory, "threads", `${threadId}.json`), `${JSON.stringify(record)}\n`);
      } catch (error) {
        if (error && error.code === "EEXIST") throw threadExists(threadId);
        throw error;
      }
      recoveredThreads.add(`${workspace_id}:${threadId}`);
      return record;
    });
  }

  async function listRecords({ workspace_id } = {}) {
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    const workspace = await fetchWorkspace(configuredRoot, workspace_id);
    const directory = await physicalDirectory(workspace.directory, "workspace directory");
    const threadsDir = join(directory, "threads");
    const info = await lstatOrNull(threadsDir);
    if (info === null) return { threads: [], invalid: [] };
    if (info.isSymbolicLink()) throw invalidThread("threads directory must not be a symlink");
    if (!info.isDirectory()) throw invalidThread("threads is not a directory");
    if ((await realpath(threadsDir)) !== threadsDir) throw invalidThread("threads directory path contains a symbolic link");
    const names = (await readdir(threadsDir)).filter((name) => name.endsWith(".json")).sort();
    const threads = [];
    const invalid = [];
    for (const name of names) {
      const file = join(threadsDir, name);
      try {
        const entryInfo = await lstat(file);
        if (entryInfo.isSymbolicLink()) throw invalidThread("thread file must not be a symlink");
        if (!entryInfo.isFile()) throw invalidThread("thread file is not a regular file");
        const record = validateThread(JSON.parse(await readFile(file, "utf8")));
        if (record.thread_id !== name.slice(0, -".json".length)) {
          throw invalidThread("thread file identity does not match its name");
        }
        if (record.workspace_id !== workspace_id) {
          throw invalidThread("thread record workspace_id does not match the workspace");
        }
        await assertOwnedSessionPaths(directory, record);
        const recovered = await withThreadLock(workspace_id, record.thread_id, async () => {
          const latest = await readRecordAt(directory, workspace_id, record.thread_id);
          return recoverRecord(directory, workspace_id, latest);
        });
        threads.push(recovered);
      } catch (error) {
        invalid.push({
          file,
          code: "invalid-thread",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { threads, invalid };
  }

  // Public FIFO projection: canonical records are copied and given 1-based
  // queue_position for their globally eligible queued rows; stored ThreadV1
  // bytes are never changed. Runtime state/partial/generation are transient.
  async function list({ workspace_id } = {}) {
    const requested = workspace_id ?? null;
    if (requested !== null && (typeof requested !== "string" || !WORKSPACE_ID_PATTERN.test(requested))) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    const gathered = [];
    if (requested !== null) {
      gathered.push({ workspace_id: requested, listed: await listRecords({ workspace_id: requested }) });
    }
    const catalog = await listWorkspaces(configuredRoot);
    for (const workspace of catalog.valid) {
      if (requested !== null && workspace.id === requested) continue;
      try {
        gathered.push({ workspace_id: workspace.id, listed: await listRecords({ workspace_id: workspace.id }) });
      } catch {
        // Other workspaces are best-effort; the requested workspace already threw.
      }
    }

    const currentItem = (head) => head.record.queue[head.index];
    const compareHeads = (a, b) => {
      const itemA = currentItem(a);
      const itemB = currentItem(b);
      return (
        itemA.queued_at.localeCompare(itemB.queued_at) ||
        a.record.thread_id.localeCompare(b.record.thread_id) ||
        itemA.id.localeCompare(itemB.id)
      );
    };
    let active = [];
    for (const { workspace_id: id, listed } of gathered) {
      for (const record of listed.threads) {
        if (record.queue_paused || record.history_only) continue;
        const head = record.queue[0];
        if (!head || head.state !== "queued") continue;
        if (record.attention === "missing-directory") continue;
        active.push({ workspace_id: id, record, index: 0 });
      }
    }
    const positions = new Map();
    let position = 1;
    while (active.length > 0) {
      active.sort(compareHeads);
      const head = active[0];
      const item = currentItem(head);
      positions.set(`${head.workspace_id}:${head.record.thread_id}:${item.id}`, position++);
      const following = head.record.queue[head.index + 1];
      if (following && following.state === "queued") head.index += 1;
      else active.shift();
    }

    const threads = [];
    const invalid = [];
    for (const { workspace_id: id, listed } of gathered) {
      if (requested !== null && id !== requested) continue;
      invalid.push(...listed.invalid);
      for (const record of listed.threads) {
        const runtime = runtimes.get(`${id}:${record.thread_id}`);
        const queue = record.queue.map((item) => ({
          ...item,
          queue_position: positions.get(`${id}:${record.thread_id}:${item.id}`) ?? null,
        }));
        // The single in-flight response lease is server-owned transient state.
        // It is computed before attention collapses the projected state so a
        // stalled-but-still-owned response keeps a truthful Stop path.
        const ownsResponse =
          responseLease !== null &&
          responseLease.workspace_id === id &&
          responseLease.thread_id === record.thread_id &&
          runtime !== undefined &&
          runtime !== null &&
          responseLease.generation !== null &&
          responseLease.generation === runtime.generation;
        let state;
        if (record.history_only) state = "history-only";
        else if (record.queue_paused) state = "paused";
        else if (typeof record.attention === "string" && record.attention !== "") state = record.attention;
        else state = ownsResponse ? "active" : "idle";
        threads.push({
          ...record,
          queue,
          state,
          owns_response: ownsResponse,
          partial: runtime?.partial ?? "",
          generation: runtime?.generation ?? null,
          watermark: eventSequences.get(`${id}:${record.thread_id}`) ?? 0,
        });
      }
    }
    return { threads, invalid };
  }

  async function history({ workspace_id, thread_id, before, limit } = {}) {
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (!isUuid(thread_id)) throw invalidThread("thread_id must be a UUID");
    const { record } = await withThreadLock(workspace_id, thread_id, () => loadServiceRecord(workspace_id, thread_id));
    const file = await ownedSessionFile(record);
    if (file === null) return { ...EMPTY_BRANCH, entries: [] };
    return readSessionBranch(file, { before, limit });
  }

  // Resume is the only process-producing public method in this batch. It never
  // sends a prompt: it guards recorded/observed owners, publishes the captured
  // identity before the startup handshake and keeps lazy
  // session files null until the owned file actually exists.
  async function resume({ workspace_id, thread_id } = {}) {
    if (closed) throw serviceClosed();
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (!isUuid(thread_id)) throw invalidThread("thread_id must be a UUID");
    const resumed = await withThreadLock(workspace_id, thread_id, () => resumeLocked(workspace_id, thread_id));
    requestPump();
    return resumed;
  }

  // Assumes the per-thread lock is held; send composes this same identity
  // and spawn ownership path without recursively locking.
  async function resumeLocked(workspace_id, thread_id) {
    if (closed) throw serviceClosed();
    const loaded = await loadServiceRecord(workspace_id, thread_id);
    const original = loaded.record;
    const workspace = loaded.workspace;
    const directory = loaded.directory;
    let current = original;
    let resolved;
    try {
      resolved = await resolveTarget({ workspace, target: await adj4TargetFor(workspace, original.target) });
    } catch {
      return persistRecord(directory, { ...original, attention: "missing-directory" });
    }
    if (resolved.execution_dir !== original.execution_dir) {
      return persistRecord(directory, { ...original, attention: "missing-directory" });
    }
    try {
      if (original.history_only) throw typedError("history-only", "history-only threads cannot resume");

      const key = `${workspace_id}:${thread_id}`;
      const owned = ownedAdapters.get(key);
      if (owned && owned.evicting === true) {
        throw typedError("child-limit", "owned discussion child is being evicted");
      }
      if (owned) {
        const observed = inspectProcess(owned.process.pid);
        const identityKnown = observed.state === "alive" && observed.started_at === owned.process.started_at;
        const recordedMatches =
          current.process !== null &&
          current.process !== undefined &&
          current.process.pid === owned.process.pid &&
          current.process.started_at === owned.process.started_at;
        if (!identityKnown || !recordedMatches) {
          throw typedError("live-owner", "a prior owned discussion process is not confirmed dead", {
            state: observed.state,
            pid: owned.process.pid,
          });
        }
        try {
          const state = await owned.adapter.request({ type: "get_state" });
          const ownedRuntime = runtimes.get(key);
          if (ownedRuntime) ownedRuntime.lastUsed = nowFn();
          resetIdleTimer(workspace_id, thread_id);
          const expectedFile = owned.adapter.identity.session_file ?? null;
          if (state.data?.sessionId !== current.session_id) {
            throw typedError("session-mismatch", "reused adapter session id does not match the thread");
          }
          if (typeof state.data?.sessionFile !== "string" || state.data.sessionFile !== expectedFile) {
            throw typedError("session-mismatch", "reused adapter session file does not match the thread");
          }
          await verifyOwnedSessionFile(current, current.session_file);
          const pinned = await ownedFileOrNull(expectedFile);
          current = await persistRecord(directory, {
            ...current,
            session_file: pinned ?? current.session_file,
            process: owned.process,
            attention:
              resolved.attention[0] ?? (current.attention === "live-owner" ? null : current.attention),
            queue_paused: owned.process.started_at === null ? current.queue_paused : false,
          });
          return current;
        } catch (error) {
          const shutdown = await closeOwnedPiChild(owned.child, { clock: clockImpl });
          if (!shutdown.confirmed_death) {
            owned.evicting = true;
            current = await persistRecord(directory, { ...current, process: owned.process, attention: "live-owner" });
            throw typedError("live-owner", "owned discussion process did not confirm death", { pid: owned.process.pid });
          }
          ownedAdapters.delete(key);
          ownedChildren.delete(owned.child);
          if (error.code === "session-mismatch") throw error;
        }
      }

      if (current.process !== null && current.process !== undefined) {
        const observed = inspectProcess(current.process.pid);
        if (observed.state !== "dead") {
          throw typedError("live-owner", "recorded discussion process is not confirmed dead", {
            state: observed.state,
            pid: current.process.pid,
          });
        }
      }

      const scan = await scanDiscussionProcesses(thread_id);
      if (!scan.ok) {
        throw typedError("live-owner", `process listing is not trustworthy: ${scan.reason}`, { reason: scan.reason });
      }
      if (scan.matches.length > 0) {
        throw typedError("live-owner", "another discussion process is live for this thread", { pids: scan.matches });
      }
      if (closed) throw serviceClosed();

      let spawnFile = current.session_file;
      if (spawnFile !== null) {
        await verifyOwnedSessionFile(current, spawnFile);
      } else {
        const discovered = await discoverOwnedSessionFile(current);
        if (discovered !== null) spawnFile = discovered;
      }

      await acquireCapacity();
      const releaseReservation = reservationRelease();
      let rawChild = null;
      let captured = null;
      let earlyPersist = null;
      const controller = new AbortController();
      const spawnBoundary = (command, args, options) => {
        if (closed) throw serviceClosed();
        const child = spawnImpl(command, args, options);
        if (command === "pi" && child && typeof child === "object") {
          rawChild = child;
          captured = processIdentity(child.pid);
          const processInfo = captured ?? { pid: child.pid, started_at: null };
          ownedChildren.set(child, {
            workspaceId: workspace_id,
            threadId: thread_id,
            directory,
            process: processInfo,
            adapter: null,
            controller,
          });
          releaseReservation();
          earlyPersist = persistRecord(directory, {
            ...current,
            session_file: spawnFile,
            process: processInfo,
            attention: "live-owner",
          });
          earlyPersist.catch(() => {});
        }
        return child;
      };

      let adapter = null;
      let startupError = null;
      try {
        adapter = await createPiRpc({
          thread: { ...current, session_file: spawnFile },
          spawn: spawnBoundary,
          clock: clockImpl,
          signal: controller.signal,
        });
      } catch (error) {
        startupError = error;
      } finally {
        releaseReservation();
      }

      if (earlyPersist !== null) {
        try {
          current = await earlyPersist;
        } catch (persistError) {
          if (rawChild !== null) {
            const shutdown = await closeOwnedPiChild(rawChild, { clock: clockImpl }).catch(() => null);
            const exitFacts =
              typeof rawChild.exitCode === "number" ||
              (rawChild.signalCode !== null && rawChild.signalCode !== undefined);
            releaseOwnedChildIfDead(rawChild, shutdown, exitFacts);
          }
          throw persistError;
        }
      }

      if (startupError !== null) {
        const tracked = rawChild !== null ? ownedChildren.get(rawChild) : null;
        const shutdown = rawChild !== null ? await closeOwnedPiChild(rawChild, { clock: clockImpl }).catch(() => null) : null;
        if (rawChild !== null) {
          const exitFacts =
            typeof rawChild.exitCode === "number" ||
            (rawChild.signalCode !== null && rawChild.signalCode !== undefined);
          releaseOwnedChildIfDead(rawChild, shutdown, exitFacts);
        }
        if (tracked) {
          if (shutdown !== null && shutdown.confirmed_death === false) {
            current = await persistRecord(directory, { ...current, process: tracked.process, attention: "live-owner" });
          } else if (
            current.process &&
            current.process.pid === tracked.process.pid &&
            current.process.started_at === tracked.process.started_at
          ) {
            const { process: _process, ...rest } = current;
            current = await persistRecord(directory, { ...rest, attention: "start-failed" });
          }
        }
        throw startupError;
      }

      const childExited =
        rawChild !== null &&
        (typeof rawChild.exitCode === "number" || (rawChild.signalCode !== null && rawChild.signalCode !== undefined));
      if (rawChild === null || childExited) {
        if (rawChild !== null) {
          await closeOwnedPiChild(rawChild, { clock: clockImpl }).catch(() => {});
          ownedChildren.delete(rawChild);
        }
        const { process: _process, ...rest } = current;
        current = await persistRecord(directory, { ...rest, attention: "start-failed" });
        throw typedError("live-owner", "resume child exited during startup");
      }

      const processInfo = captured ?? { pid: rawChild.pid, started_at: null };
      const stopClosedResume = async (shutdown) => {
        const exitFacts =
          typeof rawChild.exitCode === "number" ||
          (rawChild.signalCode !== null && rawChild.signalCode !== undefined);
        releaseOwnedChildIfDead(rawChild, shutdown, exitFacts);
        const unconfirmed = shutdown === null || shutdown === undefined || shutdown.confirmed_death === false;
        if (unconfirmed) {
          return persistRecord(directory, {
            ...current,
            process: processInfo,
            attention: "live-owner",
            queue_paused: original.queue_paused,
          }).catch(() => current);
        }
        const { process: _process, ...rest } = current;
        return persistRecord(directory, {
          ...rest,
          attention: "start-failed",
          queue_paused: original.queue_paused,
        }).catch(() => current);
      };
      // Closed after the handshake: never install or unpause on a closed service.
      if (closed) {
        const shutdown = await adapter.close().catch(() => null);
        current = await stopClosedResume(shutdown);
        throw serviceClosed();
      }

      const pinned = await ownedFileOrNull(adapter.identity.session_file);
      try {
        current = await persistRecord(directory, {
          ...current,
          session_file: pinned ?? current.session_file,
          process: processInfo,
          attention: processInfo.started_at === null ? "live-owner" : (resolved.attention[0] ?? null),
          queue_paused: processInfo.started_at === null ? current.queue_paused : false,
        });
      } catch (persistError) {
        const shutdown = await closeOwnedPiChild(rawChild, { clock: clockImpl }).catch(() => null);
        const exitFacts =
          typeof rawChild.exitCode === "number" ||
          (rawChild.signalCode !== null && rawChild.signalCode !== undefined);
        releaseOwnedChildIfDead(rawChild, shutdown, exitFacts);
        if (shutdown && shutdown.confirmed_death === false && typeof rawChild?.pid === "number") {
          try {
            await persistRecord(directory, {
              ...current,
              process: processInfo,
              attention: "live-owner",
              queue_paused: original.queue_paused,
            });
          } catch {
            // The unconfirmed handle result remains observable to the caller.
          }
        }
        throw persistError;
      }

      const exitedAfterPersist =
        typeof rawChild.exitCode === "number" ||
        (rawChild.signalCode !== null && rawChild.signalCode !== undefined);
      if (exitedAfterPersist) {
        const shutdown = await closeOwnedPiChild(rawChild, { clock: clockImpl }).catch(() => null);
        current = await stopClosedResume(shutdown);
        throw typedError("live-owner", "resume child exited during startup");
      }

      // Closed while the final publication was awaited: same owned-only cleanup.
      if (closed) {
        const shutdown = await adapter.close().catch(() => null);
        current = await stopClosedResume(shutdown);
        throw serviceClosed();
      }

      ownedAdapters.set(key, {
        adapter,
        child: rawChild,
        generation: adapter.identity.generation,
        process: processInfo,
        directory,
      });
      const tracked = ownedChildren.get(rawChild);
      if (tracked) tracked.adapter = adapter;
      runtimes.set(`${workspace_id}:${thread_id}`, {
        generation: adapter.identity.generation,
        lastEventAt: nowFn(),
        lastUsed: nowFn(),
        partial: "",
        state: "ready",
      });
      resetIdleTimer(workspace_id, thread_id);
      adapter.events.on("event", (envelope) => {
        const event = envelope.event;
        if (event?.type === "exit") {
          if (runtimes.get(key)?.generation === adapter.identity.generation) {
            clearIdleTimer(key);
          }
          const lease = responseLease;
          if (lease && lease.generation === adapter.identity.generation) {
            lease.settled = true;
            void onOwnedExit(key, adapter, rawChild, processInfo, directory).then(() => {
              const flight = ownedDelivering.get(key);
              const hasAttempt = Boolean(flight && flight.id === lease.message_id);
              if (!hasAttempt || lease.acknowledged) releaseLease(lease);
            });
          } else {
            void onOwnedExit(key, adapter, rawChild, processInfo, directory);
          }
          return;
        }
        if (ownedAdapters.get(key)?.generation !== adapter.identity.generation) return;
        noteRuntimeEvent(workspace_id, thread_id, adapter.identity.generation, event);
        if (event?.type === "agent_settled") {
          const lease = responseLease;
          if (lease && lease.generation === adapter.identity.generation) {
            lease.settled = true;
            if (lease.acknowledged) releaseLease(lease);
          }
        }
        // agent_end is intentionally ignored.
      });
      return current;
    } catch (error) {
      if (error && error.code !== "invalid-thread") {
        const attention = attentionForError(error);
        if (attention !== null) {
          try {
            await persistRecord(directory, { ...current, attention });
          } catch {
            // The refusal remains visible through the thrown error.
          }
        }
      }
      throw error;
    }
  }

  /**
   * Enqueue one durable message under the per-thread lock and, when the item is
   * the eligible queue head and the global response slot is free, dispatch it to
   * the current thread's owned adapter. Duplicates never mutate or dispatch.
   * Returned shape for later batches and step 7:
   * `{ thread, message_id, state: 'queued'|'delivering'|'uncertain'|'accepted', duplicate }`.
   */
  // Background naming for a thread still called DEFAULT_THREAD_TITLE: the
  // title is stored only if nobody renamed the thread meanwhile, and every
  // failure leaves the default in place without affecting delivery.
  function nameThread(workspace_id, thread_id, text) {
    if (suggestTitleImpl === null) return;
    Promise.resolve()
      .then(() => suggestTitleImpl(text))
      .then((title) => {
        if (closed || typeof title !== "string" || title === "" || title.length > MAX_TITLE_LENGTH) return null;
        return withThreadLock(workspace_id, thread_id, async () => {
          if (closed) return;
          const { record, directory } = await loadServiceRecord(workspace_id, thread_id);
          if (record.title !== DEFAULT_THREAD_TITLE) return;
          await persistRecord(directory, { ...record, title, updated_at: new Date().toISOString() });
        });
      })
      .catch(() => {});
  }

  async function send(input = {}) {
    if (closed) throw serviceClosed();
    requirePlainObject(input, "send input");
    for (const override of ["root", "agentDir", "execution_dir", "session_dir"]) {
      if (Object.prototype.hasOwnProperty.call(input, override)) {
        throw typedError("invalid-message", `send does not accept a ${override} override`);
      }
    }
    const { workspace_id, thread_id, id, text } = input;
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (!isUuid(thread_id)) throw invalidThread("thread_id must be a UUID");
    if (!isUuid(id)) throw typedError("invalid-message", "message id must be a UUID");
    if (typeof text !== "string" || text.length === 0) {
      throw typedError("invalid-message", "message text must be a non-empty string");
    }
    if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
      throw typedError("invalid-message", `message text exceeds ${MAX_MESSAGE_BYTES} bytes`);
    }

    // Admission only: dedup and enqueue under the per-thread lock. No lease or
    // delivering work happens here; every prompt flows through the shared pump.
    const admitted = await withThreadLock(workspace_id, thread_id, async () => {
      if (closed) throw serviceClosed();
      const { record, directory } = await loadServiceRecord(workspace_id, thread_id);
      if (record.history_only) throw typedError("history-only", "history-only threads cannot send");
      const existing = record.queue.find((item) => item.id === id);
      if (existing) return { duplicate: true, state: existing.state, record };
      if (record.accepted_message_ids.includes(id)) {
        return { duplicate: true, state: "accepted", record };
      }
      // A genuinely new ID on a paused queue must pass identity checks
      // before any unpause; the new item is still durably enqueued and the
      // queue stays paused when validation returns browse-only.
      let latest = record;
      if (record.queue_paused === true) {
        latest = await resumeLocked(workspace_id, thread_id);
      }
      const item = { id, text, queued_at: new Date().toISOString(), state: "queued", attempt: 0 };
      const firstMessage = latest.queue.length === 0 && latest.accepted_message_ids.length === 0;
      const updated = await persistRecord(directory, {
        ...latest,
        queue: [...latest.queue, item],
        updated_at: new Date().toISOString(),
      });
      return {
        duplicate: false,
        queued: latest.queue_paused === true || latest.attention === "missing-directory",
        record: updated,
        name: firstMessage && latest.title === DEFAULT_THREAD_TITLE,
      };
    });
    if (admitted.name) nameThread(workspace_id, thread_id, text);

    if (admitted.duplicate) {
      return { thread: admitted.record, message_id: id, state: admitted.state, duplicate: true };
    }
    if (admitted.queued) {
      requestPump();
      return { thread: admitted.record, message_id: id, state: "queued", duplicate: false };
    }

    const dispatchKey = `${workspace_id}:${thread_id}:${id}`;
    waitingDispatches.add(dispatchKey);
    let pass;
    try {
      pass = requestPumpPass();
    } catch (error) {
      waitingDispatches.delete(dispatchKey);
      throw error;
    }
    if (pass === null) {
      waitingDispatches.delete(dispatchKey);
      requestPump();
      return { thread: admitted.record, message_id: id, state: "queued", duplicate: false };
    }
    let failure = null;
    try {
      await pass;
      failure = dispatchOutcomes.get(dispatchKey) ?? null;
    } finally {
      dispatchOutcomes.delete(dispatchKey);
      waitingDispatches.delete(dispatchKey);
    }
    if (failure) throw failure;
    const { record: latest } = await withThreadLock(workspace_id, thread_id, () =>
      loadServiceRecord(workspace_id, thread_id),
    );
    if (latest.accepted_message_ids.includes(id)) {
      return { thread: latest, message_id: id, state: "accepted", duplicate: false };
    }
    const item = latest.queue.find((entry) => entry.id === id);
    return {
      thread: latest,
      message_id: id,
      state: item ? item.state : "queued",
      duplicate: false,
    };
  }

  async function completeDispatch(staged) {
    // The RPC is awaited outside the per-thread lock so concurrent retries can
    // observe the durable delivering row and later Stop cannot deadlock.
    const requestRuntime = runtimes.get(`${staged.workspace_id}:${staged.thread_id}`);
    if (requestRuntime) requestRuntime.lastUsed = nowFn();
    resetIdleTimer(staged.workspace_id, staged.thread_id);
    let response;
    try {
      response = await staged.adapter.request({ type: "prompt", id: staged.message_id, message: staged.text });
    } catch (error) {
      await finalizeDeliveryFailure(staged, error);
      if (error.code === "command-failed" && !closed) {
        try {
          const state = await staged.adapter.request({ type: "get_state" });
          if (
            state.data?.isStreaming === false &&
            state.data?.isCompacting === false &&
            state.data?.pendingMessageCount === 0
          ) {
            staged.lease.settled = true;
            if (staged.lease.acknowledged) releaseLease(staged.lease);
          }
        } catch {
          // Retain exclusion without settlement.
        }
      }
      throw typedError("delivery-uncertain", `prompt ${staged.message_id} is uncertain: ${error.message}`, {
        cause: error,
        message_id: staged.message_id,
      });
    }
    const disposition = response?.data?.disposition;
    if (disposition !== "started" && disposition !== "queued" && disposition !== "handled") {
      await finalizeDeliveryFailure(
        staged,
        typedError("invalid-disposition", `unexpected prompt disposition: ${String(disposition)}`),
      );
      throw typedError("delivery-uncertain", `prompt ${staged.message_id} returned an invalid disposition`, {
        message_id: staged.message_id,
      });
    }
    if (disposition === "handled") {
      try {
        const state = await staged.adapter.request({ type: "get_state" });
        if (
          state.data?.isStreaming === false &&
          state.data?.isCompacting === false &&
          state.data?.pendingMessageCount === 0
        ) {
          staged.lease.settled = true;
        }
      } catch {
        // Keep the conservative unsettled state; agent_settled can release later.
      }
    }

    let completed;
    try {
      completed = await withThreadLock(staged.workspace_id, staged.thread_id, async () => {
        const key = `${staged.workspace_id}:${staged.thread_id}`;
        const latest = await readRecordAt(staged.directory, staged.workspace_id, staged.thread_id);
        const flight = ownedDelivering.get(key);
        if (
          !flight ||
          flight.id !== staged.message_id ||
          flight.attempt !== staged.attempt ||
          flight.generation !== staged.generation
        ) {
          return { stale: true, record: latest };
        }
        const index = latest.queue.findIndex(
          (entry) =>
            entry.id === staged.message_id && entry.state === "delivering" && entry.attempt === staged.attempt,
        );
        if (index === -1) {
          if (latest.accepted_message_ids.includes(staged.message_id)) {
            ownedDelivering.delete(key);
            return { stale: false, record: latest };
          }
          return { stale: true, record: latest };
        }
        let pinned = null;
        const candidate = await ownedFileOrNull(staged.adapter.identity.session_file);
        if (candidate !== null) {
          await verifyOwnedSessionFile(latest, candidate);
          pinned = candidate;
        }
        const queue = latest.queue.filter((entry) => entry.id !== staged.message_id);
        const accepted = [
          ...latest.accepted_message_ids.filter((entry) => entry !== staged.message_id),
          staged.message_id,
        ].slice(-MAX_ACCEPTED_MESSAGE_IDS);
        const updated = await persistRecord(staged.directory, {
          ...latest,
          queue,
          accepted_message_ids: accepted,
          session_file: pinned ?? latest.session_file,
          updated_at: new Date().toISOString(),
        });
        ownedDelivering.delete(key);
        return { stale: false, record: updated };
      });
    } catch (error) {
      await finalizeDeliveryFailure(staged, error);
      throw typedError("delivery-uncertain", `prompt ${staged.message_id} acceptance could not be persisted`, {
        cause: error,
        message_id: staged.message_id,
      });
    }
    if (completed.stale) {
      await finalizeDeliveryFailure(staged, typedError("stale-generation", "prompt completion belongs to another attempt"));
      throw typedError("delivery-uncertain", `prompt ${staged.message_id} completion was stale`, {
        message_id: staged.message_id,
      });
    }
    staged.lease.acknowledged = true;
    if (staged.lease.settled) releaseLease(staged.lease);
    return { thread: completed.record, message_id: staged.message_id, state: "accepted", duplicate: false };
  }

  // Stage an already-queued eligible head for one thread. Takes the per-thread
  // lock itself; callers must not hold it. The prompt text comes from the durable
  // item, never from the latest request.
  async function stageQueuedHead(workspace_id, thread_id, id) {
    return withThreadLock(workspace_id, thread_id, async () => {
      if (closed) return { kind: "skip", reason: "closed" };
      const { record, directory } = await loadServiceRecord(workspace_id, thread_id);
      if (record.history_only) return { kind: "skip", reason: "history-only" };
      const head = record.queue[0];
      if (!head || head.id !== id || head.state !== "queued") return { kind: "skip", reason: "not-head" };
      if (record.queue_paused === true) return { kind: "skip", reason: "paused" };
      if (record.attention === "missing-directory") return { kind: "skip", reason: "missing-directory" };
      if (responseLease !== null) return { kind: "busy" };
      const lease = { workspace_id, thread_id, message_id: id, generation: null, settled: false, acknowledged: false };
      responseLease = lease;
      let adapter;
      try {
        const resumed = await resumeLocked(workspace_id, thread_id);
        const owned = ownedAdapters.get(`${workspace_id}:${thread_id}`);
        const knownProcess =
          resumed.process !== null &&
          resumed.process !== undefined &&
          typeof resumed.process.started_at === "string" &&
          resumed.process.started_at !== "";
        if (!owned || resumed.queue_paused === true || !knownProcess || resumed.attention === "missing-directory") {
          if (!owned && (resumed.process === undefined || resumed.process === null)) releaseLease(lease);
          return { kind: "skip", reason: "not-ready" };
        }
        adapter = owned.adapter;
        lease.generation = adapter.identity.generation;
        resetStallTimer(lease.generation);
        const stagedRuntime = runtimes.get(`${workspace_id}:${thread_id}`);
        if (stagedRuntime) stagedRuntime.lastUsed = nowFn();
      } catch (error) {
        let latest = null;
        try {
          latest = await readRecordAt(directory, workspace_id, thread_id);
        } catch {
          latest = null;
        }
        const recordedOwner =
          latest && latest.process
            ? inspectProcess(latest.process.pid).state !== "dead"
            : false;
        const rawOwner = [...ownedChildren.entries()].some(
          ([child, entry]) =>
            entry.threadId === thread_id &&
            entry.workspaceId === workspace_id &&
            !(typeof child.exitCode === "number" || (child.signalCode !== null && child.signalCode !== undefined)),
        );
        const hasOwner = recordedOwner || rawOwner;
        if (!hasOwner) {
          if (latest) {
            const attention = attentionForError(error);
            try {
              await persistRecord(directory, {
                ...latest,
                queue_paused: true,
                attention: attention ?? latest.attention,
                updated_at: new Date().toISOString(),
              });
            } catch {
              // The startup failure remains visible through the thrown error.
            }
          }
          releaseLease(lease);
        }
        throw error;
      }
      const latest = await readRecordAt(directory, workspace_id, thread_id);
      let delivering;
      try {
        delivering = await persistRecord(directory, {
          ...latest,
          queue: latest.queue.map((entry) =>
            entry.id === id ? { ...entry, state: "delivering", attempt: entry.attempt + 1 } : entry,
          ),
          updated_at: new Date().toISOString(),
        });
      } catch (error) {
        try {
          const state = await adapter.request({ type: "get_state" });
          if (
            state.data?.isStreaming === false &&
            state.data?.isCompacting === false &&
            state.data?.pendingMessageCount === 0
          ) {
            releaseLease(lease);
          }
        } catch {
          // Retain exclusion.
        }
        throw error;
      }
      const persistedAttempt = delivering.queue.find((entry) => entry.id === id)?.attempt ?? 0;
      ownedDelivering.set(`${workspace_id}:${thread_id}`, {
        id,
        generation: lease.generation,
        attempt: persistedAttempt,
      });
      if (closed) {
        await persistRecord(directory, {
          ...delivering,
          queue: delivering.queue.map((entry) => (entry.id === id ? { ...entry, state: "uncertain" } : entry)),
          attention: "uncertain",
          updated_at: new Date().toISOString(),
        }).catch(() => null);
        ownedDelivering.delete(`${workspace_id}:${thread_id}`);
        throw serviceClosed();
      }
      return {
        kind: "dispatch",
        adapter,
        directory,
        record: delivering,
        workspace_id,
        thread_id,
        message_id: id,
        generation: lease.generation,
        attempt: persistedAttempt,
        text: delivering.queue.find((entry) => entry.id === id)?.text ?? head.text,
        lease,
      };
    });
  }

  // Service-global eligible head over all canonical workspaces, ordered by the
  // durable queued_at, then thread_id, then message id. Paused, history-only,
  // uncertain and delivering heads are excluded.
  async function findEligibleHead(excluded) {
    const catalog = await listWorkspaces(configuredRoot);
    const heads = [];
    for (const workspace of catalog.valid) {
      let listed;
      try {
        listed = await listRecords({ workspace_id: workspace.id });
      } catch {
        continue;
      }
      for (const record of listed.threads) {
        const key = `${workspace.id}:${record.thread_id}`;
        const processInfo = record.process;
        if (processInfo !== null && processInfo !== undefined) {
          const observed = inspectProcess(processInfo.pid);
          const owned = ownedAdapters.get(key);
          const ownedMatches =
            observed.state === "alive" &&
            observed.started_at === processInfo.started_at &&
            owned !== undefined &&
            owned !== null &&
            owned.evicting !== true &&
            owned.process.pid === processInfo.pid &&
            owned.process.started_at === processInfo.started_at;
          if (observed.state !== "dead" && !ownedMatches) {
            if (responseLease === null) {
              responseLease = {
                workspace_id: workspace.id,
                thread_id: record.thread_id,
                message_id: null,
                generation: null,
                settled: false,
                acknowledged: true,
                orphan: true,
              };
              void withThreadLock(workspace.id, record.thread_id, async () => {
                try {
                  const { record: latest, directory } = await loadServiceRecord(workspace.id, record.thread_id);
                  if (latest.attention !== "live-owner") {
                    await persistRecord(directory, {
                      ...latest,
                      attention: "live-owner",
                      updated_at: new Date().toISOString(),
                    });
                  }
                } catch {
                  // Visible through the next read.
                }
              });
            }
            return null;
          }
        }
        if (record.queue_paused || record.history_only) continue;
        const head = record.queue[0];
        if (!head || head.state !== "queued") continue;
        if (record.attention === "missing-directory") continue;
        if (excluded.has(`${workspace.id}:${record.thread_id}`)) continue;
        heads.push({
          workspace_id: workspace.id,
          thread_id: record.thread_id,
          message_id: head.id,
          queued_at: head.queued_at,
        });
      }
    }
    heads.sort(
      (a, b) =>
        a.queued_at.localeCompare(b.queued_at) ||
        a.thread_id.localeCompare(b.thread_id) ||
        a.message_id.localeCompare(b.message_id),
    );
    return heads[0] ?? null;
  }

  function requestPumpPass() {
    if (responseLease !== null || pumpRunning || closed) return null;
    return requestPump();
  }

  function requestPump() {
    pumpRequested = true;
    if (!pumpRunning && !closed) {
      const pass = runPump()
        .catch(() => null)
        .finally(() => {
          if (pumpPromise === pass) pumpPromise = null;
        });
      pumpPromise = pass;
    }
    return pumpPromise;
  }

  // One serial pump pass at a time; it waits for the prompt ack (never for
  // settlement) and drains free-lease candidates. Per-run exclusions prevent a
  // failed or not-ready head from busy-looping. Dispatch errors for the
  // initiating message are retained for that send to throw.
  async function runPump() {
    if (pumpRunning) return;
    pumpRunning = true;
    pumpRequested = false;
    const excluded = new Set();
    try {
      while (!closed) {
        if (responseLease !== null) return;
        let candidate;
        try {
          candidate = await findEligibleHead(excluded);
        } catch {
          return;
        }
        if (!candidate) return;
        const threadKey = `${candidate.workspace_id}:${candidate.thread_id}`;
        const messageKey = `${threadKey}:${candidate.message_id}`;
        let staged;
        try {
          staged = await stageQueuedHead(candidate.workspace_id, candidate.thread_id, candidate.message_id);
        } catch (error) {
          excluded.add(threadKey);
          if (waitingDispatches.has(messageKey)) dispatchOutcomes.set(messageKey, error);
          continue;
        }
        if (staged.kind !== "dispatch") {
          excluded.add(threadKey);
          continue;
        }
        try {
          await completeDispatch(staged);
          dispatchOutcomes.delete(messageKey);
        } catch (error) {
          excluded.add(threadKey);
          if (waitingDispatches.has(messageKey)) dispatchOutcomes.set(messageKey, error);
        }
      }
    } finally {
      pumpRunning = false;
      if (pumpRequested && !closed && responseLease === null) {
        queueMicrotask(() => requestPump());
      } else {
        pumpRequested = false;
      }
    }
  }

  // Best-effort uncertainty marking for a dispatched attempt that did not reach
  // acceptance. Only the exact persisted delivering attempt is finalized; a
  // stale tuple or a non-matching item is left untouched and the flight record
  // is deleted only after the outcome is durably saved.
  async function finalizeDeliveryFailure(staged, error) {
    await withThreadLock(staged.workspace_id, staged.thread_id, async () => {
      const key = `${staged.workspace_id}:${staged.thread_id}`;
      const flight = ownedDelivering.get(key);
      if (
        !flight ||
        flight.id !== staged.message_id ||
        flight.attempt !== staged.attempt ||
        flight.generation !== staged.generation
      ) {
        return;
      }
      let latest;
      try {
        latest = await readRecordAt(staged.directory, staged.workspace_id, staged.thread_id);
      } catch {
        return;
      }
      const index = latest.queue.findIndex(
        (entry) =>
          entry.id === staged.message_id && entry.state === "delivering" && entry.attempt === staged.attempt,
      );
      if (index === -1) return;
      const commandFailed = error && error.code === "command-failed";
      const queue = latest.queue.map((entry) => {
        if (entry.id !== staged.message_id || entry.state !== "delivering" || entry.attempt !== staged.attempt) {
          return entry;
        }
        return commandFailed ? { ...entry, state: "queued" } : { ...entry, state: "uncertain" };
      });
      const next = { ...latest, queue, updated_at: new Date().toISOString() };
      if (commandFailed) {
        next.queue_paused = true;
        next.attention = "prompt-failed";
      } else {
        next.attention = "uncertain";
      }
      let saved = false;
      try {
        await persistRecord(staged.directory, next);
        saved = true;
      } catch {
        // The item stays delivering on disk; no outcome is claimed.
      }
      if (saved) {
        ownedDelivering.delete(key);
        staged.lease.acknowledged = true;
        if (staged.lease.settled === true) releaseLease(staged.lease);
      }
    }).catch(() => {});
  }

  /**
   * Explicitly remove one uncertain queue item, or replace it in place with a
   * fresh server-generated identity when `resend` is true. The old uncertain
   * id and text are never reused for delivery. Returned shapes for step 7:
   * discard `{ thread, message_id, state: 'discarded', duplicate: false }`;
   * resend `{ thread, message_id, state: 'queued', duplicate: false, warning }`.
   */
  async function discard(input = {}) {
    if (closed) throw serviceClosed();
    requirePlainObject(input, "discard input");
    for (const override of ["root", "agentDir", "execution_dir", "session_dir"]) {
      if (Object.prototype.hasOwnProperty.call(input, override)) {
        throw typedError("invalid-message", `discard does not accept a ${override} override`);
      }
    }
    const { workspace_id, thread_id, id, resend = false } = input;
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (!isUuid(thread_id)) throw invalidThread("thread_id must be a UUID");
    if (!isUuid(id)) throw typedError("invalid-message", "message id must be a UUID");
    if (typeof resend !== "boolean") throw typedError("invalid-message", "resend must be a boolean");
    return withThreadLock(workspace_id, thread_id, async () => {
      if (closed) throw serviceClosed();
      const { record, directory } = await loadServiceRecord(workspace_id, thread_id);
      if (record.history_only) throw typedError("history-only", "history-only threads cannot discard");
      const index = record.queue.findIndex((item) => item.id === id);
      if (index === -1) throw typedError("message-not-found", `queue message not found: ${id}`);
      const item = record.queue[index];
      if (item.state !== "uncertain") {
        throw typedError("message-not-uncertain", `only uncertain messages can be discarded: ${item.state}`);
      }
      if (!resend) {
        const queue = record.queue.filter((entry) => entry.id !== id);
        const updated = await persistRecord(directory, { ...record, queue, updated_at: new Date().toISOString() });
        ownedDelivering.delete(`${workspace_id}:${thread_id}`);
        requestPump();
        return { thread: updated, message_id: id, state: "discarded", duplicate: false };
      }
      const replacement = {
        id: randomUUID(),
        text: item.text,
        queued_at: new Date().toISOString(),
        state: "queued",
        attempt: 0,
      };
      const queue = [...record.queue];
      queue[index] = replacement;
      const updated = await persistRecord(directory, { ...record, queue, updated_at: new Date().toISOString() });
      ownedDelivering.delete(`${workspace_id}:${thread_id}`);
      requestPump();
      return {
        thread: updated,
        message_id: replacement.id,
        state: "queued",
        duplicate: false,
        warning: "possible duplicate response",
      };
    });
  }

  // Pauses this thread's queue before any RPC, then (outside the lock) stops the
  // currently owned generation. The lease is released only through confirmed
  // idle after abort, agent_settled, or real exit, and only once the attempt
  // outcome is durable. Recorded tuples are inspected conservatively; numeric
  // PIDs are never signalled and other queues are untouched.
  async function stop({ workspace_id, thread_id } = {}) {
    if (closed) throw serviceClosed();
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (!isUuid(thread_id)) throw invalidThread("thread_id must be a UUID");

    const key = `${workspace_id}:${thread_id}`;
    const paused = await withThreadLock(workspace_id, thread_id, async () => {
      if (closed) throw serviceClosed();
      const { record, directory } = await loadServiceRecord(workspace_id, thread_id);
      if (record.history_only) throw typedError("history-only", "history-only threads cannot stop");
      return persistRecord(directory, {
        ...record,
        queue_paused: true,
        updated_at: new Date().toISOString(),
      });
    });

    const persistStopAttention = (attention) =>
      withThreadLock(workspace_id, thread_id, async () => {
        const { record, directory } = await loadServiceRecord(workspace_id, thread_id);
        if (record.attention === attention) return record;
        return persistRecord(directory, { ...record, attention, updated_at: new Date().toISOString() });
      });

    const owned = ownedAdapters.get(key);
    const lease = responseLease;
    const matchesLease =
      lease !== null &&
      lease.workspace_id === workspace_id &&
      lease.thread_id === thread_id &&
      (owned === null || owned === undefined || lease.generation === owned.generation);
    const releaseSettledLease = () => {
      if (matchesLease && lease.acknowledged && lease.settled) releaseLease(lease);
    };

    if (owned) {
      const observed = inspectProcess(owned.process.pid);
      const identityKnown = observed.state === "alive" && observed.started_at === owned.process.started_at;
      if (!identityKnown) {
        const latest = await persistStopAttention(observed.state === "dead" ? null : "live-owner");
        if (matchesLease && observed.state === "dead" && ownedAdapters.get(key) === owned) {
          lease.settled = true;
        }
        releaseSettledLease();
        return { thread: latest, stopped: false };
      }
      try {
        const before = await owned.adapter.request({ type: "get_state" });
        if (typeof before.data?.pendingMessageCount === "number" && before.data.pendingMessageCount > 0) {
          await owned.adapter.request({ type: "clear_queue" });
        }
        await owned.adapter.request({ type: "abort" });
        const after = await owned.adapter.request({ type: "get_state" });
        const idle =
          after.data?.isStreaming === false &&
          after.data?.isCompacting === false &&
          after.data?.pendingMessageCount === 0;
        if (idle) {
          if (ownedAdapters.get(key) !== owned) {
            const latest = await persistStopAttention("uncertain");
            return { thread: latest, stopped: false };
          }
          const latest = await persistStopAttention(null);
          if (matchesLease) {
            lease.settled = true;
            if (lease.acknowledged) releaseLease(lease);
          }
          return { thread: latest, stopped: true };
        }
        const latest = await persistStopAttention("uncertain");
        return { thread: latest, stopped: false };
      } catch (error) {
        const attention = error && error.code === "policy-refusal" ? "policy-refusal" : "uncertain";
        const latest = await persistStopAttention(attention);
        return { thread: latest, stopped: false };
      }
    }

    // No owned adapter: inspect the recorded tuple conservatively.
    const recorded = paused.process;
    if (recorded === null || recorded === undefined) {
      const liveRaw = [...ownedChildren.entries()].some(
        ([child, entry]) =>
          entry.workspaceId === workspace_id &&
          entry.threadId === thread_id &&
          !(typeof child.exitCode === "number" || (child.signalCode !== null && child.signalCode !== undefined)),
      );
      if (matchesLease && lease.orphan === true && !liveRaw) {
        lease.settled = true;
        if (lease.acknowledged) releaseLease(lease);
      } else {
        releaseSettledLease();
      }
      return { thread: paused, stopped: false };
    }
    const observed = inspectProcess(recorded.pid);
    if (observed.state === "dead") {
      const cleaned = await withThreadLock(workspace_id, thread_id, async () => {
        const { record, directory } = await loadServiceRecord(workspace_id, thread_id);
        if (
          record.process &&
          record.process.pid === recorded.pid &&
          record.process.started_at === recorded.started_at
        ) {
          const { process: _process, ...rest } = record;
          return persistRecord(directory, {
            ...rest,
            attention: record.attention === "live-owner" ? null : record.attention,
          });
        }
        return record;
      });
      if (matchesLease && lease.message_id === null && lease.generation === null) {
        lease.settled = true;
        if (lease.acknowledged) releaseLease(lease);
      } else {
        releaseSettledLease();
      }
      return { thread: cleaned, stopped: false };
    }
    const latest = await persistStopAttention("live-owner");
    return { thread: latest, stopped: false };
  }

  /**
   * Publish a canonical brief material once and link exactly one handoff row.
   * The material is published before the thread record, so a crash between the
   * two converges on retry and conflicting bytes refuse before any record
   * change. No Pi process, target repository or assignment lifecycle is touched.
   */
  async function saveBrief(input = {}) {
    if (closed) throw serviceClosed();
    requirePlainObject(input, "saveBrief input");
    for (const override of [
      "root",
      "storageRoot",
      "agentDir",
      "path",
      "brief",
      "target",
      "execution_dir",
      "session_dir",
    ]) {
      if (Object.prototype.hasOwnProperty.call(input, override)) {
        throw typedError("invalid-brief", `saveBrief does not accept a ${override} override`);
      }
    }
    const { workspace_id, thread_id, request_id: requestId, title, content } = input;
    const references = validateReferences(input.references);
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (!isUuid(thread_id)) throw invalidThread("thread_id must be a UUID");
    if (!isUuid(requestId)) throw typedError("invalid-brief", "request_id must be a UUID");
    if (typeof title !== "string" || title.trim() === "") {
      throw typedError("invalid-brief", "brief title must be a non-empty string");
    }
    if (typeof content !== "string") throw typedError("invalid-brief", "brief content must be a string");

    return withThreadLock(workspace_id, thread_id, async () => {
      if (closed) throw serviceClosed();
      const { record, directory } = await loadServiceRecord(workspace_id, thread_id);
      const previous = record.handoffs.find(entry => entry.request_id === requestId);
      if (previous && JSON.stringify(previous.references ?? []) !== JSON.stringify(references)) {
        throw typedError('request-conflict', 'Saved brief references conflict with this request.');
      }
      const material = await addMaterial(configuredRoot, workspace_id, {
        kind: "brief",
        title,
        content,
        request_id: requestId,
      });
      const existing = record.handoffs.find((handoff) => handoff.request_id === requestId);
      if (existing) {
        if (existing.brief !== material.path) {
          throw typedError("request-conflict", "brief request conflicts with the recorded handoff", {
            request_id: requestId,
          });
        }
        return { thread: record, brief: material.path, handoff: existing, duplicate: true };
      }
      const handoff = {
        request_id: requestId,
        brief: material.path,
        saved_at: new Date().toISOString(),
        ...(references.length ? { references } : {}),
      };
      const updated = await persistRecord(directory, {
        ...record,
        handoffs: [...record.handoffs, handoff],
        updated_at: new Date().toISOString(),
      });
      return { thread: updated, brief: material.path, handoff, duplicate: false };
    });
  }

  const HANDOFF_OVERRIDES = [
    "root",
    "storageRoot",
    "agentDir",
    "brief",
    "path",
    "target",
    "execution_dir",
    "pi_path",
    "home",
    "tmux_socket",
    "tmux_session",
    "pi_session_dir",
    "coordination_database",
    "adapters",
    "resolved",
  ];

  // Shared preview/launch request validation: identities only, never authority
  // paths, adapters or extra argv material.
  function validateHandoffRequest(input, label) {
    requirePlainObject(input, `${label} input`);
    for (const override of HANDOFF_OVERRIDES) {
      if (Object.prototype.hasOwnProperty.call(input, override)) {
        throw typedError("invalid-handoff", `${label} does not accept a ${override} override`);
      }
    }
    const { workspace_id, thread_id, request_id: requestId, assignment_id: assignmentId, instructions } = input;
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (!isUuid(thread_id)) throw invalidThread("thread_id must be a UUID");
    if (!isUuid(requestId)) throw typedError("invalid-handoff", "request_id must be a UUID");
    if (!isUuid(assignmentId)) throw typedError("invalid-handoff", "assignment_id must be a UUID");
    if (typeof instructions !== "string" || instructions === "") {
      throw typedError("invalid-handoff", "instructions must be a non-empty string");
    }
    return { workspace_id, thread_id, requestId, assignmentId };
  }

  // Build the trusted adj4 input for a saved handoff. All authority fields
  // (root, brief path, target) come from the service construction and the saved
  // ThreadV1 record, never from the caller. The stored target object is adapted
  // to adj4's repository-id input; an absent or ambiguous worktree binding
  // rejects the handoff instead of falling back to a workspace launch.
  async function handoffInput(record, handoff, input, workspace) {
    return {
      assignment_id: input.assignment_id,
      workspace_id: record.workspace_id,
      thread_id: record.thread_id,
      storageRoot: configuredRoot,
      brief: handoff.brief,
      instructions: input.instructions,
      context_references: handoff.references ?? [],
      skill: input.skill ?? "general",
      target: await adj4TargetFor(workspace, record.target),
      specPackage: input.specPackage ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      thinking: input.thinking ?? null,
      harness: input.harness ?? null,
      project_trust: input.project_trust ?? null,
      workflow_id: input.workflow_id ?? null,
      publication_authority: input.publication_authority ?? "none",
      attempt_kind: input.attempt_kind ?? "initial",
      supersedes: input.supersedes ?? null,
    };
  }

  // Direct (thread-free) dispatch. Direct requests are trusted only through the
  // service construction and the canonical workspace material: identities,
  // instructions and references are validated, the brief path is derived from
  // the workspace and request UUID, and every authority path, adapter or
  // runtime override is refused before resolution.
  const DIRECT_SAVE_KEYS = new Set(["workspace_id", "request_id", "title", "content"]);
  const DIRECT_PREVIEW_KEYS = new Set([
    "workspace_id",
    "request_id",
    "assignment_id",
    "instructions",
    "repository_id",
    "references",
    "skill",
    "spec_package",
    "publication_authority",
    "provider",
    "model",
  ]);
  const DIRECT_LAUNCH_KEYS = new Set([...DIRECT_PREVIEW_KEYS, "expectedDigest"]);

  function validateDirectRequest(input, label, launch) {
    requirePlainObject(input, `${label} input`);
    const allowed = launch ? DIRECT_LAUNCH_KEYS : DIRECT_PREVIEW_KEYS;
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        throw typedError("invalid-handoff", `${label} does not accept a ${key} override`);
      }
    }
    const { workspace_id, request_id: requestId, assignment_id: assignmentId, instructions } = input;
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (!isUuid(requestId)) throw typedError("invalid-handoff", "request_id must be a UUID");
    if (!isUuid(assignmentId)) throw typedError("invalid-handoff", "assignment_id must be a UUID");
    if (typeof instructions !== "string" || instructions === "") {
      throw typedError("invalid-handoff", "instructions must be a non-empty string");
    }
    const repositoryId = input.repository_id ?? null;
    if (repositoryId !== null && (typeof repositoryId !== "string" || repositoryId === "")) {
      throw typedError("invalid-handoff", "repository_id must be a non-empty string when provided");
    }
    const skill = input.skill ?? "general";
    if (typeof skill !== "string" || skill === "") {
      throw typedError("invalid-handoff", "skill must be a non-empty string when provided");
    }
    const specPackage = input.spec_package ?? null;
    if (specPackage !== null && (typeof specPackage !== "string" || specPackage === "")) {
      throw typedError("invalid-handoff", "spec_package must be a non-empty string when provided");
    }
    const publicationAuthority =
      input.publication_authority === undefined ? "none" : input.publication_authority;
    if (publicationAuthority !== "none" && publicationAuthority !== "draft-pr") {
      throw typedError("invalid-handoff", "publication_authority must be none or draft-pr");
    }
    const provider = input.provider ?? null;
    const model = input.model ?? null;
    if (provider !== null && model !== null) {
      if (typeof provider !== "string" || provider === "") {
        throw typedError("invalid-handoff", "provider must be a non-empty string when provided");
      }
      if (typeof model !== "string" || model === "") {
        throw typedError("invalid-handoff", "model must be a non-empty string when provided");
      }
      if (provider.length > 100) {
        throw typedError("invalid-handoff", "provider length exceeds 100 characters");
      }
      if (model.length > 300) {
        throw typedError("invalid-handoff", "model length exceeds 300 characters");
      }
      if (!isSafeArgValue(provider)) {
        throw typedError("invalid-handoff", "provider contains unsafe characters");
      }
      if (!isSafeArgValue(model)) {
        throw typedError("invalid-handoff", "model contains unsafe characters");
      }
    } else if (provider !== null || model !== null) {
      throw typedError("invalid-handoff", "provider and model must both be specified or both omitted");
    }
    let expectedDigest = null;
    if (launch) {
      if (typeof input.expectedDigest !== "string" || !/^[0-9a-f]{64}$/.test(input.expectedDigest)) {
        throw typedError("invalid-handoff", "expectedDigest must be a 64-character lowercase hex digest");
      }
      expectedDigest = input.expectedDigest;
    }
    return {
      workspaceId: workspace_id,
      requestId,
      assignmentId,
      instructions,
      repositoryId,
      skill,
      specPackage,
      publicationAuthority,
      references: validateReferences(input.references),
      provider,
      model,
      expectedDigest,
    };
  }

  // Resolve the canonical direct brief for one saved request. The path is
  // derived, never supplied, and the leaf must already be an owned regular
  // workspace file; anything else is brief-not-found.
  async function directBrief(workspaceId, requestId) {
    const workspace = await fetchWorkspace(configuredRoot, workspaceId);
    const directory = await physicalDirectory(workspace.directory, "workspace directory");
    const brief = requestMaterialPath(workspaceId, "brief", requestId);
    let leaf;
    try {
      leaf = await resolveWorkspacePath(directory, brief);
    } catch (error) {
      throw typedError("brief-not-found", `saved brief not found: ${requestId}`, { cause: error });
    }
    const info = await lstatOrNull(leaf);
    if (info === null || info.isSymbolicLink() || !info.isFile()) {
      throw typedError("brief-not-found", `saved brief not found: ${requestId}`);
    }
    return brief;
  }

  // Build the trusted direct assignment input: general/Pi/none/initial
  // defaults with no runtime overrides from the request.
  async function directHandoffInput(input, label, launch) {
    const validated = validateDirectRequest(input, label, launch);
    const brief = await directBrief(validated.workspaceId, validated.requestId);
    return {
      trustedInput: {
        assignment_id: validated.assignmentId,
        workspace_id: validated.workspaceId,
        storageRoot: configuredRoot,
        brief,
        instructions: validated.instructions,
        context_references: validated.references,
        skill: validated.skill,
        target: validated.repositoryId,
        specPackage: validated.specPackage,
        provider: validated.provider,
        model: validated.model,
        thinking: null,
        harness: "pi",
        project_trust: null,
        workflow_id: null,
        publication_authority: validated.publicationAuthority,
        attempt_kind: "initial",
        supersedes: null,
      },
      expectedDigest: validated.expectedDigest,
    };
  }

  async function prepareSpecTarget(input = {}) {
    if (closed) throw serviceClosed();
    if (!isPlainObject(input) || Object.keys(input).some(key => !['workspace_id','thread_id','repository_id','spec_package'].includes(key))
      || !WORKSPACE_ID_PATTERN.test(input.workspace_id ?? '') || typeof input.spec_package !== 'string' || !input.spec_package
      || (input.thread_id !== undefined && (!isUuid(input.thread_id) || input.repository_id !== undefined)))
      throw typedError('invalid-handoff', 'Choose a workspace, spec package and one target identity.');
    const prepare = target => prepareAssignmentSpecTarget({storageRoot:configuredRoot,
      workspace_id:input.workspace_id, target, specPackage:input.spec_package});
    if (input.thread_id) return withThreadLock(input.workspace_id, input.thread_id, async () => {
      if (closed) throw serviceClosed();
      const {record,workspace} = await loadServiceRecord(input.workspace_id,input.thread_id);
      const target = await adj4TargetFor(workspace,record.target);
      const binding = await resolveTarget({workspace,target,specPackage:input.spec_package});
      if (binding.execution_dir !== record.execution_dir) throw typedError('stale-preview','The conversation target changed.');
      return prepare(target);
    });
    return prepare(input.repository_id ?? null);
  }

  // A conversation stays bound to its registered repository. A spec handoff
  // deliberately runs in that repository's canonical package worktree instead.
  // Validate both bindings separately; never accept a browser execution path.
  async function resolveFreshAssignment(trustedInput, executionBinding, label) {
    const fresh = await resolveAssignment(trustedInput, { referenceCatalog });
    if (executionBinding !== null) {
      const workspace = await fetchWorkspace(configuredRoot, trustedInput.workspace_id);
      const conversation = await resolveTarget({workspace, target:trustedInput.target, specPackage:trustedInput.specPackage});
      if (conversation.execution_dir !== executionBinding)
        throw typedError("stale-preview", `${label} target no longer matches the stored conversation binding`);
    }
    return fresh;
  }

  // Shared launch core for thread handoffs and direct dispatch: approve the
  // fresh digest, let the canonical assignment owner publish/claim/start,
  // verify the stored record, optionally link the thread handoff and finally
  // observe. Owner writer/run refusals become service typed errors carrying
  // only the validated conflicting assignment UUID; unknown errors propagate.
  async function executeResolvedLaunch({ trustedInput, assignmentId, expectedDigest, executionBinding, linkHandoff }) {
    const fresh = await resolveFreshAssignment(trustedInput, executionBinding, "launch");
    if (fresh.contractDigest !== expectedDigest) {
      throw typedError("stale-preview", "approved contract digest no longer matches the resolved preview");
    }
    if (closed) throw serviceClosed();
    try {
      await launchAssignmentOwner(trustedInput, {
        expectedDigest,
        resolved: fresh,
        adapters: launchAdapters ?? {},
      });
    } catch (error) {
      if (error && error.code === "target-busy") {
        throw typedError(
          "target-busy",
          error.message,
          isUuid(error.assignment_id) ? { assignment_id: error.assignment_id } : {},
        );
      }
      if (error && error.code === "run-active") {
        throw typedError("run-active", error.message);
      }
      throw error;
    }
    const stored = await findAssignment(configuredRoot, assignmentId);
    if (
      stored.assignment_id !== assignmentId ||
      stored.workspace_id !== trustedInput.workspace_id ||
      stored.brief !== trustedInput.brief ||
      stored.execution_dir !== fresh.record.execution_dir ||
      stored.contract_digest !== fresh.contractDigest
    ) {
      throw typedError("stale-preview", "launched assignment record does not match the approved contract");
    }
    const linked = typeof linkHandoff === "function" ? await linkHandoff(stored) : null;
    const observation = await observeAssignment(stored, launchAdapters?.observationProbes ?? {});
    return { stored, observation, linked };
  }

  /**
   * Preview an assignment from a saved handoff without launching it or writing
   * any assignment record. Returns the exact adj4 resolution object
   * `{record, piArgs, briefBytes, contractDigest}`.
   */
  async function previewAssignment(input = {}) {
    if (closed) throw serviceClosed();
    const { workspace_id, thread_id, requestId } = validateHandoffRequest(input, "previewAssignment");
    return withThreadLock(workspace_id, thread_id, async () => {
      if (closed) throw serviceClosed();
      const { record, workspace } = await loadServiceRecord(workspace_id, thread_id);
      const handoff = record.handoffs.find((entry) => entry.request_id === requestId);
      if (!handoff) throw typedError("brief-not-found", `saved brief not found: ${requestId}`);
      const trustedInput = await handoffInput(record, handoff, input, workspace);
      return resolveFreshAssignment(trustedInput, record.execution_dir, "preview");
    });
  }

  /**
   * Launch an assignment from a saved handoff. The fresh resolution must equal
   * the caller's expected digest and the stored execution binding before the
   * canonical adj4 launch runs; the handoff is linked only after a unique
   * assignment record verifies. Assignment work never becomes an owned child
   * and service close never kills the launched tmux session.
   */
  async function launchAssignment(input = {}) {
    if (closed) throw serviceClosed();
    const { workspace_id, thread_id, requestId, assignmentId } = validateHandoffRequest(input, "launchAssignment");
    if (typeof input.expectedDigest !== "string" || !/^[0-9a-f]{64}$/.test(input.expectedDigest)) {
      throw typedError("invalid-handoff", "expectedDigest must be a 64-character lowercase hex digest");
    }
    return withThreadLock(workspace_id, thread_id, async () => {
      if (closed) throw serviceClosed();
      const { record, directory, workspace } = await loadServiceRecord(workspace_id, thread_id);
      const handoff = record.handoffs.find((entry) => entry.request_id === requestId);
      if (!handoff) throw typedError("brief-not-found", `saved brief not found: ${requestId}`);
      if (handoff.assignment_id !== undefined && handoff.assignment_id !== assignmentId) {
        throw typedError("request-conflict", "brief request is already linked to a different assignment", {
          request_id: requestId,
        });
      }
      const trustedInput = await handoffInput(record, handoff, input, workspace);
      const launched = await executeResolvedLaunch({
        trustedInput,
        assignmentId,
        expectedDigest: input.expectedDigest,
        executionBinding: record.execution_dir,
        linkHandoff: async () => {
          let linked = record;
          let linkedHandoff = handoff;
          if (handoff.assignment_id !== assignmentId) {
            linkedHandoff = { ...handoff, assignment_id: assignmentId };
            linked = await persistRecord(directory, {
              ...record,
              handoffs: record.handoffs.map((entry) =>
                entry.request_id === requestId ? linkedHandoff : entry,
              ),
              updated_at: new Date().toISOString(),
            });
          }
          return { thread: linked, handoff: linkedHandoff };
        },
      });
      return {
        thread: launched.linked.thread,
        handoff: launched.linked.handoff,
        assignment: launched.stored,
        observation: launched.observation,
      };
    });
  }

  /**
   * Save one direct brief material. Only the canonical workspace-relative
   * brief path is returned; no thread or handoff record is created, and
   * identical bytes under the same request UUID stay idempotent.
   */
  async function dispatchSaveBrief(input = {}) {
    if (closed) throw serviceClosed();
    requirePlainObject(input, "dispatchSaveBrief input");
    for (const key of Object.keys(input)) {
      if (!DIRECT_SAVE_KEYS.has(key)) {
        throw typedError("invalid-brief", `dispatchSaveBrief does not accept a ${key} override`);
      }
    }
    const { workspace_id, request_id: requestId, title, content } = input;
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (!isUuid(requestId)) throw typedError("invalid-brief", "request_id must be a UUID");
    if (typeof title !== "string" || title.trim() === "") {
      throw typedError("invalid-brief", "brief title must be a non-empty string");
    }
    if (typeof content !== "string") throw typedError("invalid-brief", "brief content must be a string");
    const material = await addMaterial(configuredRoot, workspace_id, {
      kind: "brief",
      title,
      content,
      request_id: requestId,
    });
    return { brief: material.path };
  }

  /**
   * Preview a direct assignment from its canonical saved brief. Nothing is
   * published, linked or reserved.
   */
  async function dispatchPreview(input = {}) {
    if (closed) throw serviceClosed();
    const { trustedInput } = await directHandoffInput(input, "dispatchPreview", false);
    return resolveFreshAssignment(trustedInput, null, "preview");
  }

  /**
   * Launch a direct assignment once the caller's reviewed digest matches the
   * fresh resolution and the stored record verifies.
   */
  async function dispatchLaunch(input = {}) {
    if (closed) throw serviceClosed();
    const { trustedInput, expectedDigest } = await directHandoffInput(input, "dispatchLaunch", true);
    const launched = await executeResolvedLaunch({
      trustedInput,
      assignmentId: trustedInput.assignment_id,
      expectedDigest,
      executionBinding: null,
      linkHandoff: null,
    });
    return { assignment: launched.stored, observation: launched.observation };
  }

  /**
   * Suggest skills or files for one workspace repository. The selected
   * repository resolves through the canonical target owner without a package.
   */
  async function dispatchSuggestions(input = {}) {
    if (closed) throw serviceClosed();
    requirePlainObject(input, "dispatchSuggestions input");
    for (const key of Object.keys(input)) {
      if (!["workspace_id", "repository_id", "kind", "query"].includes(key)) {
        throw typedError("invalid-handoff", `dispatchSuggestions does not accept a ${key} override`);
      }
    }
    const { workspace_id, repository_id: repositoryId = null, kind, query = "" } = input;
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (repositoryId !== null && (typeof repositoryId !== "string" || repositoryId === "")) {
      throw typedError("invalid-handoff", "repository_id must be a non-empty string when provided");
    }
    const workspace = await fetchWorkspace(configuredRoot, workspace_id);
    const resolved = await resolveTarget({ workspace, target: repositoryId ?? null, specPackage: null });
    return referenceCatalog.suggest({ workspace, executionDir: resolved.execution_dir, kind, query });
  }

  function subscribe({ workspace_id, thread_id } = {}, listener) {
    if (closed) throw serviceClosed();
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (!isUuid(thread_id)) throw invalidThread("thread_id must be a UUID");
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const key = `${workspace_id}:${thread_id}`;
    let listeners = subscribers.get(key);
    if (!listeners) {
      listeners = new Set();
      subscribers.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = subscribers.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) subscribers.delete(key);
    };
  }

  function close() {
    if (closePromise !== null) return closePromise;
    clearStallTimer();
    clearAllIdleTimers();
    closed = true;
    for (const [key, listeners] of subscribers) {
      const [workspaceId, threadId] = key.split(":");
      for (const listener of listeners) {
        try {
          listener({ type: "closed", workspace_id: workspaceId, thread_id: threadId });
        } catch {
          // Subscriber callbacks must not block or throw into cleanup.
        }
      }
    }
    subscribers.clear();
    eventSequences.clear();
    // threadLocks are intentionally preserved so queued mutations keep their
    // per-thread serialization through shutdown.
    const entries = [...ownedChildren.entries()];
    for (const [, entry] of entries) {
      try {
        entry.controller?.abort();
      } catch {
        // Aborting is best effort; the owned handle close still runs.
      }
    }
    const work = Promise.all(
      entries.map(async ([child, entry]) => {
        const result = entry.adapter
          ? await entry.adapter.close().catch(() => null)
          : await closeOwnedPiChild(child, { clock: clockImpl }).catch(() => null);
        const confirmed = result !== null && result !== undefined && result.confirmed_death === true;
        if (confirmed) {
          ownedChildren.delete(child);
        } else if (typeof entry.process?.pid === "number") {
          try {
            await withThreadLock(entry.workspaceId, entry.threadId, async () => {
              const record = await readOwnedRecord(configuredRoot, entry.workspaceId, entry.threadId);
              await persistRecord(entry.directory, { ...record, process: entry.process, attention: "live-owner" });
            });
          } catch {
            // The unconfirmed result remains observable to the caller.
          }
        }
        return result;
      }),
    );
    // Drain exit cleanup and fault publication that were serialized under the
    // per-thread locks or the pump, including locks registered while the owned
    // children were closing. This stays inside the single existing 5s race.
    const drain = (async () => {
      await work.catch(() => {});
      const first = [...threadLocks.values()];
      const pumps = pumpPromise !== null ? [pumpPromise.catch(() => null)] : [];
      await Promise.allSettled([...first, ...pumps]);
      const late = [...threadLocks.values()];
      if (late.length > 0) await Promise.allSettled(late);
      if (pumpPromise !== null) await pumpPromise.catch(() => null);
    })();
    closePromise = (async () => {
      let timer = null;
      const deadline = new Promise((resolvePromise) => {
        timer = clockImpl.setTimeout(resolvePromise, 5000);
      });
      await Promise.race([drain, deadline]);
      if (timer !== null) clockImpl.clearTimeout(timer);
    })();
    return closePromise;
  }

  async function suggestions({ workspace_id, thread_id, kind, query = '' } = {}) {
    if (closed) throw serviceClosed();
    if (!isUuid(thread_id) || typeof workspace_id !== 'string' || !WORKSPACE_ID_PATTERN.test(workspace_id)) throw invalidThread('Suggestion target is invalid.');
    const { record, workspace } = await loadServiceRecord(workspace_id, thread_id);
    return referenceCatalog.suggest({ workspace, executionDir: record.execution_dir, kind, query });
  }

  return { create, list, history, send, saveBrief, suggestions, prepareSpecTarget, dispatchSaveBrief, dispatchPreview, dispatchLaunch, dispatchSuggestions, previewAssignment, launchAssignment, discard, subscribe, resume, stop, close };
}
