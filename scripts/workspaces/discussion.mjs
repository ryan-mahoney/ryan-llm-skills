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
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readSessionBranch } from "../spec-observe/core.mjs";
import { inspectProcess, processIdentity } from "../spec-observe/process-identity.mjs";
import { resolveTarget } from "./assignments.mjs";
import { closeOwnedPiChild, createPiRpc } from "./pi-rpc.mjs";
import {
  createFileExclusive,
  fetchWorkspace,
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
const MAX_ACCEPTED_MESSAGE_IDS = 100;
const CONTEXT_LIMIT_BYTES = 256 * 1024;
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
const contextFailure = (code, message, extra = {}) => typedError(code, message, extra);

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

function contextBytes(context) {
  let total = 0;
  for (const entry of context) total += Buffer.byteLength(entry, "utf8") + 1;
  return total;
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
  if (!Array.isArray(record.context) || record.context.some((entry) => typeof entry !== "string")) {
    throw invalidThread("context must be an array of strings");
  }
  if (contextBytes(record.context) > CONTEXT_LIMIT_BYTES) {
    throw invalidThread(`context exceeds ${CONTEXT_LIMIT_BYTES} bytes`);
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

async function readOwnedRecord(root, workspaceId, threadId) {
  const workspace = await fetchWorkspace(root, workspaceId);
  const directory = await physicalDirectory(workspace.directory, "workspace directory");
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
    return canonicalIfPossible(isAbsolute(record.path) ? resolve(record.path) : resolve(directory, record.path));
  }
  return canonicalIfPossible(resolve(target.path));
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

// Bounded context reference read: the size is checked against the remaining
// budget before any buffer is allocated, so an oversized file is refused
// without an unbounded read. Short reads are refused, and dev/ino/size/mtime
// are recorded for the pre-spawn replacement check.
async function readBoundedReference(physical, label, budget) {
  let handle;
  try {
    handle = await open(physical, "r");
  } catch {
    throw contextFailure("missing-context", `context reference is unreadable: ${label}`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw contextFailure("missing-context", `context reference is not a regular file: ${label}`);
    const header = `--- ${label} ---\n`;
    const headerBytes = Buffer.byteLength(header, "utf8");
    if (headerBytes > budget.remaining) throw contextFailure("invalid-context", "context exceeds the 256KiB budget");
    if (info.size > budget.remaining - headerBytes) {
      throw contextFailure("invalid-context", `context reference exceeds the remaining 256KiB budget: ${label}`);
    }
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const { bytesRead } = await handle.read(buffer, offset, info.size - offset, offset);
      if (bytesRead <= 0) throw contextFailure("missing-context", `context reference changed while reading: ${label}`);
      offset += bytesRead;
    }
    budget.remaining -= headerBytes + info.size;
    return {
      chunk: `${header}${buffer.toString("utf8")}`,
      physical,
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

// Assemble fresh current kit context plus the record's selected material
// references at spawn time. Missing, escaping, symlinked, oversize or
// concurrently changed references refuse before any child is spawned and no
// file is written. The pi-rpc append string joins chunks with "\n\n", so the
// separators count against the 256KiB budget.
async function assembleContext({ root, workspace, directory, record }) {
  const budget = { remaining: CONTEXT_LIMIT_BYTES };
  const chunks = [];
  const refs = [];
  const addReference = async (reference, label) => {
    const separator = chunks.length === 0 ? 0 : 2;
    if (separator > budget.remaining) throw contextFailure("invalid-context", "context exceeds the 256KiB budget");
    budget.remaining -= separator;
    const physical = await resolveWorkspacePath(directory, reference).catch(() => {
      throw contextFailure("missing-context", `context is not an owned path: ${label}`);
    });
    const stamp = await readBoundedReference(physical, reference, budget);
    chunks.push(stamp.chunk);
    refs.push({ reference, stamp });
  };
  for (const entry of Array.isArray(workspace.context) ? workspace.context : []) {
    if (entry.status !== "ok" || typeof entry.path !== "string" || entry.path === "") {
      throw contextFailure("missing-context", `kit context is not available: ${String(entry.path)}`);
    }
    const reference = isAbsolute(entry.path) ? relative(directory, resolve(entry.path)) : entry.path;
    if (reference === "" || reference.startsWith("..") || isAbsolute(reference)) {
      throw contextFailure("missing-context", `kit context escapes the workspace: ${entry.path}`);
    }
    await addReference(reference, entry.path);
  }
  for (const reference of record.context) {
    if (typeof reference !== "string" || reference === "" || isAbsolute(reference)) {
      throw contextFailure("missing-context", `selected context must be a relative path: ${String(reference)}`);
    }
    await addReference(reference, reference);
  }
  for (const { reference, stamp } of refs) {
    const again = await resolveWorkspacePath(directory, reference).catch(() => {
      throw contextFailure("missing-context", `context disappeared during assembly: ${reference}`);
    });
    if (again !== stamp.physical) {
      throw contextFailure("missing-context", `context was replaced during assembly: ${reference}`);
    }
    const info = await lstat(again).catch(() => null);
    if (
      !info ||
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.dev !== stamp.dev ||
      info.ino !== stamp.ino ||
      info.size !== stamp.size ||
      info.mtimeMs !== stamp.mtimeMs
    ) {
      throw contextFailure("missing-context", `context changed during assembly: ${reference}`);
    }
  }
  const refreshed = await fetchWorkspace(root, record.workspace_id);
  const signature = (entries) =>
    (Array.isArray(entries) ? entries : []).map((entry) => `${entry.path}\u0000${entry.status}`).join("\n");
  if (signature(refreshed.context) !== signature(workspace.context)) {
    throw contextFailure("missing-context", "kit context changed during assembly");
  }
  return chunks;
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
 * configuration; per-request overrides are not accepted. send/stop/discard/
 * handoff mutations and prompt delivery arrive in later steps.
 * @param {{root?: string, agentDir?: string|null, spawn?: Function, clock?: object}} options
 * @returns {object}
 */
export function createDiscussionService({ root, agentDir = null, spawn = nodeSpawn, clock = defaultClock } = {}) {
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
  const clockImpl = clock && typeof clock.setTimeout === "function" && typeof clock.clearTimeout === "function" ? clock : defaultClock;

  let closed = false;
  let closePromise = null;
  const subscribers = new Map();
  const threadLocks = new Map();
  const ownedChildren = new Map();
  const ownedAdapters = new Map();

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
    return record;
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
          !current ||
          current.generation !== adapter.identity.generation ||
          current.process.pid !== capturedProcess.pid ||
          current.process.started_at !== capturedProcess.started_at
        ) {
          return;
        }
        ownedAdapters.delete(key);
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
    if (code === "missing-context" || code === "live-owner" || code === "session-mismatch") return code;
    if (code === "invalid-context") return "missing-context";
    return "start-failed";
  }

  async function create({ workspace_id, title, target = { kind: "workspace" }, context = [], model, specPackage = null } = {}) {
    if (closed) throw serviceClosed();
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (typeof title !== "string" || title.length < 1 || title.length > MAX_TITLE_LENGTH) {
      throw invalidThread(`title must be 1..${MAX_TITLE_LENGTH} characters`);
    }
    const preservedTarget = validateTargetShape({ ...requirePlainObject(target, "target") });
    if (!Array.isArray(context) || context.some((entry) => typeof entry !== "string")) {
      throw invalidThread("context must be an array of strings");
    }
    if (contextBytes(context) > CONTEXT_LIMIT_BYTES) throw invalidThread(`context exceeds ${CONTEXT_LIMIT_BYTES} bytes`);
    validateModel(model);
    if (specPackage !== null && specPackage !== undefined && (typeof specPackage !== "string" || specPackage === "")) {
      throw new TypeError("specPackage must be a non-empty string when provided");
    }
    const workspace = await fetchWorkspace(configuredRoot, workspace_id);
    const directory = await physicalDirectory(workspace.directory, "workspace directory");
    let resolved = null;
    let failureAttention = null;
    try {
      resolved = await resolveTarget({ workspace, target: preservedTarget, specPackage: specPackage ?? null });
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
      context: [...context],
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
      return record;
    });
  }

  async function list({ workspace_id } = {}) {
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
        threads.push(record);
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

  async function history({ workspace_id, thread_id, before, limit } = {}) {
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (!isUuid(thread_id)) throw invalidThread("thread_id must be a UUID");
    const record = await readOwnedRecord(configuredRoot, workspace_id, thread_id);
    const file = await ownedSessionFile(record);
    if (file === null) return { ...EMPTY_BRANCH, entries: [] };
    return readSessionBranch(file, { before, limit });
  }

  // Resume is the only process-producing public method in this batch. It never
  // sends a prompt: it guards recorded/observed owners, publishes the captured
  // identity before the startup handshake, assembles context and keeps lazy
  // session files null until the owned file actually exists.
  async function resume({ workspace_id, thread_id } = {}) {
    if (closed) throw serviceClosed();
    if (typeof workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace_id)) {
      throw invalidThread("workspace_id must be a workspace id");
    }
    if (!isUuid(thread_id)) throw invalidThread("thread_id must be a UUID");
    return withThreadLock(workspace_id, thread_id, async () => {
      if (closed) throw serviceClosed();
      const original = await readOwnedRecord(configuredRoot, workspace_id, thread_id);
      const workspace = await fetchWorkspace(configuredRoot, workspace_id);
      const directory = await physicalDirectory(workspace.directory, "workspace directory");
      let current = original;
      let resolved;
      try {
        resolved = await resolveTarget({ workspace, target: original.target });
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
              attention: resolved.attention[0] ?? current.attention,
              queue_paused: owned.process.started_at === null ? current.queue_paused : false,
            });
            return current;
          } catch (error) {
            const shutdown = await closeOwnedPiChild(owned.child, { clock: clockImpl });
            ownedAdapters.delete(key);
            ownedChildren.delete(owned.child);
            if (!shutdown.confirmed_death) {
              current = await persistRecord(directory, { ...current, process: owned.process, attention: "live-owner" });
              throw typedError("live-owner", "owned discussion process did not confirm death", { pid: owned.process.pid });
            }
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

        const assembled = await assembleContext({ root: configuredRoot, workspace, directory, record: current });
        if (closed) throw serviceClosed();

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
            thread: { ...current, session_file: spawnFile, context: assembled },
            context: assembled,
            spawn: spawnBoundary,
            clock: clockImpl,
            signal: controller.signal,
          });
        } catch (error) {
          startupError = error;
        }

        if (earlyPersist !== null) {
          try {
            current = await earlyPersist;
          } catch (persistError) {
            if (rawChild !== null) {
              await closeOwnedPiChild(rawChild, { clock: clockImpl }).catch(() => {});
              ownedChildren.delete(rawChild);
            }
            throw persistError;
          }
        }

        if (startupError !== null) {
          const tracked = rawChild !== null ? ownedChildren.get(rawChild) : null;
          const shutdown = rawChild !== null ? await closeOwnedPiChild(rawChild, { clock: clockImpl }).catch(() => null) : null;
          if (rawChild !== null) ownedChildren.delete(rawChild);
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
          ownedChildren.delete(rawChild);
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
          ownedChildren.delete(rawChild);
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
        adapter.events.on("event", (envelope) => {
          if (envelope.event?.type === "exit") {
            void onOwnedExit(key, adapter, rawChild, processInfo, directory);
          }
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
    });
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
        if (result && result.confirmed_death === false && typeof entry.process?.pid === "number") {
          try {
            await withThreadLock(entry.workspaceId, entry.threadId, async () => {
              const record = await readOwnedRecord(configuredRoot, entry.workspaceId, entry.threadId);
              await persistRecord(entry.directory, { ...record, process: entry.process, attention: "live-owner" });
            });
          } catch {
            // The unconfirmed result remains observable to the caller.
          }
        } else {
          ownedChildren.delete(child);
        }
        return result;
      }),
    );
    closePromise = (async () => {
      let timer = null;
      const deadline = new Promise((resolvePromise) => {
        timer = clockImpl.setTimeout(resolvePromise, 5000);
      });
      await Promise.race([work.catch(() => {}), deadline]);
      if (timer !== null) clockImpl.clearTimeout(timer);
    })();
    return closePromise;
  }

  return { create, list, history, subscribe, resume, close };
}
