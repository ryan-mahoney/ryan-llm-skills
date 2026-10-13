// Identity-bound read-only terminal streams for the local dashboard.
//
// Node-standard-library only. Each stream entry is bound to the durable
// assignment record's verified terminal identity: browser callers never
// select a tmux socket, session or pane. `createTerminalViews` owns admission
// and capacity (`open`), the asset HTTP proxy, the raw WebSocket upgrade
// proxy, the single stop path used for startup failures, superseded
// identities, viewer grace/idle and shutdown, and the bounded SIGTERM/SIGKILL
// drain (`closeAll`).
//
// No assignment record is written and no durable state is mutated. Only owned
// asciinema ChildProcess handles receive signals; the tmux server and the
// agent pane are never signalled. Assets and upgrades attach to an existing
// admitted entry only and never start a process.

import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { findAssignment } from "../workspaces/assignments.mjs";
import { quote, verifyTerminal } from "../workspaces/session-control.mjs";
import { terminalIdentityCondition, windowSize } from "../workspaces/tmux.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Bounded owned-cleanup constants, not operator configuration: the direct
// dashboard stop deadline is 1000 ms, so SIGTERM escalates at 500 ms and a
// drain that exceeds 750 ms is reported as a failure.
const KILL_ESCALATION_MS = 500;
const DRAIN_TIMEOUT_MS = 750;
// Child stdout/stderr are retained only as a bounded private diagnostic on
// the internal failure object; they never cross HTTP.
const DIAGNOSTICS_LIMIT_BYTES = 4096;
// A readiness line is short; a longer unterminated run is not one. Only this
// bounded tail of unterminated stdout is retained.
const STDOUT_LINE_LIMIT = 4096;
// asciinema 3.x headless readiness, e.g.
// "::: Live streaming at http://127.0.0.1:57426". The announced URL must be
// the complete loopback origin; any other announcement is a startup failure.
const READINESS_LINE_PATTERN = /^(?:[:]{3}\s*)?Live streaming at (\S+)$/;
const LOOPBACK_HOST = "127.0.0.1";
// The only proxyable player assets and their fixed upstream paths.
const ASSET_CONTENT_TYPES = new Map([
  ["asciinema-player.min.js", "text/javascript; charset=utf-8"],
  ["asciinema-player.css", "text/css; charset=utf-8"],
]);
const UPGRADE_STATUS_TEXT = new Map([
  [400, "Bad Request"],
  [404, "Not Found"],
  [405, "Method Not Allowed"],
  [409, "Conflict"],
  [500, "Internal Server Error"],
  [502, "Bad Gateway"],
  [503, "Service Unavailable"],
]);

// Fixed, browser-safe failures carry only the allowlisted state code.
function terminalError(state, status, message) {
  return Object.assign(new Error(message), { state, status });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function notYetExited(value) {
  return value === null || value === undefined;
}

function boundedTail(value) {
  return value.length <= STDOUT_LINE_LIMIT ? value : value.slice(value.length - STDOUT_LINE_LIMIT);
}

// The readiness announcement must parse as the exact loopback HTTP origin. A
// valid loopback prefix of a malformed URL (extra path, query, junk after the
// port, credentials) is not a usable stream.
function parseAnnouncedPort(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.hostname !== LOOPBACK_HOST) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (!/^\d+$/.test(url.port)) return null;
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return port;
}

/**
 * Create the dashboard's terminal stream owner.
 *
 * `open(id)` validates the UUID (400), reads and verifies the durable
 * assignment record, refuses a missing/ended/confirmed-absent terminal as 404
 * `not-live`, a present-but-mismatched identity as 409 `changed` and any other
 * verification failure as 503 `failed`. It reserves one entry per assignment
 * synchronously before any window-size/spawn await, shares that entry's ready
 * promise with matching concurrent callers, stops and replaces an entry whose
 * verified identity changed, and counts every pending/ready/stopping entry
 * toward `maxStreams` (503 `busy`). The ready result is
 * `{assignment_id, state: 'live', cols, rows}`.
 *
 * `handleAsset(request, response, id, name)` proxies only
 * `asciinema-player.min.js` and `asciinema-player.css` from the current ready
 * entry's loopback listener; unknown assets or a non-ready entry return 404
 * `not-running` and no asset request ever starts a process.
 *
 * `handleUpgrade(request, socket, head, id)` first owns the incoming socket,
 * re-verifies the durable identity, then forwards the WebSocket handshake and
 * `head` bytes to the current ready entry's `/ws` listener and pipes both
 * directions. A missing ready entry is 409 `not-running` and a changed
 * identity is 409 `changed`; upgrades never start a process.
 *
 * Viewer timers: a ready entry that was never viewed is stopped after
 * `startIdleMs`; admitting a viewer clears idle/grace; closing the last pair
 * arms `graceMs` unless the entry is already stopping.
 *
 * `closeAll()` is idempotent: it synchronously disables admission, destroys
 * unresolved upgrade sockets, stops every entry through the single stop path
 * (clear timers, destroy owned resources, SIGTERM, SIGKILL after 500 ms) and
 * returns one repeated drain promise that resolves on actual child exits or
 * rejects with 503 `failed` when the drain exceeds 750 ms. Pending size/start
 * callbacks cannot spawn once admission is disabled.
 *
 * @param {object} [options]
 * @param {string} [options.storageRoot] physical storage root for record reads
 * @param {string} [options.asciinema] asciinema executable name or path
 * @param {number} [options.graceMs] last-viewer grace window
 * @param {number} [options.startIdleMs] unused-start window
 * @param {number} [options.startTimeoutMs] readiness deadline
 * @param {number} [options.maxStreams] concurrent entry cap
 * @param {Function} [options.spawnProcess] final process boundary
 * @param {Function} [options.tmuxRun] final tmux command boundary
 * @param {Function} [options.verify] final identity verification boundary
 * @returns {{open: (id: string) => Promise<object>,
 *   handleAsset: (request: object, response: object, id: string, name: string) => void,
 *   handleUpgrade: (request: object, socket: object, head: Buffer, id: string) => Promise<void>,
 *   closeAll: () => Promise<void>}}
 */
export function createTerminalViews({
  storageRoot,
  asciinema = "asciinema",
  graceMs = 10000,
  startIdleMs = 30000,
  startTimeoutMs = 5000,
  maxStreams = 4,
  spawnProcess = spawn,
  tmuxRun,
  verify = verifyTerminal,
} = {}) {
  const tmuxOptions = tmuxRun ? { run: tmuxRun } : undefined;
  // `entries` holds the current reservation per assignment id; `retiring`
  // holds stopped entries that were superseded by a newer reservation for the
  // same id, so a late exit callback can never delete its replacement. Both
  // count toward maxStreams until the child actually exits. Unresolved
  // upgrade sockets are owned at manager scope so closeAll can destroy them
  // before their identity handler resumes.
  const entries = new Map();
  const retiring = new Set();
  const pendingUpgrades = new Set();
  let admitting = true;
  let drainPromise = null;

  const counted = () => entries.size + retiring.size;

  function createEntry(record, identity) {
    return {
      id: record.assignment_id,
      record,
      identity,
      phase: "starting",
      stopping: false,
      terminal: false,
      ready: deferred(),
      readySettled: false,
      exited: deferred(),
      exitedSettled: false,
      child: null,
      port: null,
      cols: null,
      rows: null,
      // Admitted dashboard/upstream socket pairs and owned upstream requests
      // or sockets. The single stop path destroys resources and closes pairs.
      viewers: new Set(),
      resources: new Set(),
      stdout: "",
      diagnostics: Buffer.alloc(0),
      startTimer: null,
      idleTimer: null,
      graceTimer: null,
      killTimer: null,
    };
  }

  function clearTimer(entry, name) {
    if (entry[name] === null) return;
    clearTimeout(entry[name]);
    entry[name] = null;
  }

  function clearTimers(entry) {
    clearTimer(entry, "startTimer");
    clearTimer(entry, "idleTimer");
    clearTimer(entry, "graceTimer");
    clearTimer(entry, "killTimer");
  }

  function clearViewerTimers(entry) {
    clearTimer(entry, "idleTimer");
    clearTimer(entry, "graceTimer");
  }

  // A ready entry with no viewers is stopped after the unused-start window;
  // the first admitted viewer cancels it and the last close arms grace.
  function armIdleTimer(entry) {
    if (entry.terminal || entry.stopping || entry.viewers.size > 0) return;
    clearViewerTimers(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.terminal || entry.stopping || entry.viewers.size > 0) return;
      stopEntry(entry);
    }, startIdleMs);
  }

  function armGraceTimer(entry) {
    if (entry.terminal || entry.stopping || entry.viewers.size > 0) return;
    clearViewerTimers(entry);
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = null;
      if (entry.terminal || entry.stopping || entry.viewers.size > 0) return;
      stopEntry(entry);
    }, graceMs);
  }

  function boundDiagnostics(current, chunk) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    const combined = bytes.length >= DIAGNOSTICS_LIMIT_BYTES
      ? bytes
      : Buffer.concat([current, bytes]);
    return combined.length <= DIAGNOSTICS_LIMIT_BYTES
      ? combined
      : combined.subarray(combined.length - DIAGNOSTICS_LIMIT_BYTES);
  }

  function attachDiagnostics(error, entry) {
    const text = entry.diagnostics.toString("utf8").trim();
    if (text !== "") error.diagnostics = text;
    return error;
  }

  function settleReady(entry, error, value) {
    if (entry.readySettled) return;
    entry.readySettled = true;
    if (error) entry.ready.reject(error);
    else entry.ready.resolve(value);
  }

  function ownResource(entry, resource) {
    if (entry.terminal || entry.stopping) return false;
    entry.resources.add(resource);
    return true;
  }

  function destroyResources(entry) {
    for (const resource of [...entry.resources]) {
      entry.resources.delete(resource);
      try {
        resource.destroy();
      } catch {
        // Cleanup is best effort; the exit handler still releases the entry.
      }
    }
  }

  // Close one admitted pair exactly once on either side's close/error. The
  // dashboard socket, the upstream socket and the resource registration all
  // clear here, and the last pair arms the grace window unless a stop is
  // already in progress.
  function closePair(pair) {
    if (pair.closed) return;
    pair.closed = true;
    const entry = pair.entry;
    entry.viewers.delete(pair);
    if (pair.upstream !== null) entry.resources.delete(pair.upstream);
    try {
      pair.upstream?.destroy();
    } catch {
      // Pair cleanup is best effort.
    }
    try {
      pair.client.destroy();
    } catch {
      // Pair cleanup is best effort.
    }
    if (entry.viewers.size === 0 && !entry.stopping && !entry.terminal && entry.phase === "ready") {
      armGraceTimer(entry);
    }
  }

  function closePairs(entry) {
    for (const pair of [...entry.viewers]) closePair(pair);
  }

  function finalizeEntry(entry) {
    if (entry.terminal) return;
    entry.terminal = true;
    entry.phase = "stopped";
    clearTimers(entry);
    destroyResources(entry);
    closePairs(entry);
    // Deletion is guarded by entry identity: a late exit from a superseded
    // entry must never delete the newer reservation for the same id.
    if (entries.get(entry.id) === entry) entries.delete(entry.id);
    retiring.delete(entry);
    if (!entry.exitedSettled) {
      entry.exitedSettled = true;
      entry.exited.resolve();
    }
  }

  // The single stop path: startup failures, superseded identities, viewer
  // timeouts and closeAll all pass through it. The reservation is released by
  // finalizeEntry only when the owned child has actually exited; a spawn
  // error with no child counts as terminal immediately.
  function stopEntry(entry) {
    if (entry.terminal || entry.stopping) return;
    entry.stopping = true;
    entry.phase = "stopping";
    clearTimers(entry);
    destroyResources(entry);
    closePairs(entry);
    settleReady(entry, terminalError("busy", 503, "The terminal stream was stopped."));
    const child = entry.child;
    const running = child !== null
      && child.pid !== undefined
      && notYetExited(child.exitCode)
      && notYetExited(child.signalCode);
    if (!running) {
      finalizeEntry(entry);
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // The exit handler still owns finalization.
    }
    entry.killTimer = setTimeout(() => {
      entry.killTimer = null;
      if (entry.terminal || !notYetExited(child.exitCode) || !notYetExited(child.signalCode)) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // The exit handler still owns finalization.
      }
    }, KILL_ESCALATION_MS);
  }

  function retireEntry(entry) {
    if (entries.get(entry.id) === entry) entries.delete(entry.id);
    if (!entry.terminal) retiring.add(entry);
    stopEntry(entry);
  }

  function failEntry(entry, error) {
    settleReady(entry, attachDiagnostics(error, entry));
    stopEntry(entry);
  }

  function spawnFailure(error, entry) {
    const failure = error?.code === "ENOENT"
      ? terminalError("not-installed", 503, "asciinema is not installed on the dashboard host.")
      : terminalError("failed", 503, "The terminal stream could not be started.");
    return attachDiagnostics(failure, entry);
  }

  function handleReadinessLine(entry, line) {
    const match = READINESS_LINE_PATTERN.exec(line.trim());
    if (match === null) return false;
    if (entry.readySettled || entry.terminal) return true;
    const port = parseAnnouncedPort(match[1]);
    if (port === null) {
      failEntry(entry, terminalError("failed", 503, "The terminal stream announced an unusable address."));
      return true;
    }
    entry.port = port;
    entry.phase = "ready";
    clearTimer(entry, "startTimer");
    settleReady(entry, null, {
      assignment_id: entry.id,
      state: "live",
      cols: entry.cols,
      rows: entry.rows,
    });
    armIdleTimer(entry);
    return true;
  }

  // Split complete stdout lines across chunks while holding at most the
  // bounded tail; a line longer than the readiness announcement cannot match.
  function onStdout(entry, chunk) {
    if (entry.terminal) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    entry.diagnostics = boundDiagnostics(entry.diagnostics, text);
    let pending = entry.stdout;
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) {
        const rest = text.slice(start);
        pending = rest.length >= STDOUT_LINE_LIMIT
          ? rest.slice(rest.length - STDOUT_LINE_LIMIT)
          : boundedTail(pending + rest);
        break;
      }
      const length = newline - start;
      if (length < STDOUT_LINE_LIMIT) {
        const line = boundedTail(pending + text.slice(start, newline)).replace(/\r$/, "");
        pending = "";
        if (handleReadinessLine(entry, line)) {
          entry.stdout = "";
          return;
        }
      } else {
        pending = "";
      }
      start = newline + 1;
    }
    entry.stdout = pending;
  }

  function onSpawnError(entry, error, child) {
    if (entry.terminal) return;
    if (!entry.readySettled) settleReady(entry, spawnFailure(error, entry));
    if (child.pid === undefined) finalizeEntry(entry);
    else stopEntry(entry);
  }

  function onChildExit(entry) {
    if (entry.terminal) return;
    if (!entry.readySettled && !entry.stopping) {
      settleReady(entry, attachDiagnostics(
        terminalError("failed", 503, "The terminal stream exited before it was ready."),
        entry,
      ));
    }
    finalizeEntry(entry);
  }

  function spawnChild(entry, size) {
    const record = entry.record;
    const attach = ["attach-session", "-t", `=${record.tmux_session}`,
      "-f", "read-only,ignore-size"].map(quote).join(" ");
    const command = [
      "tmux",
      "-S",
      record.tmux_socket,
      "if-shell",
      "-F",
      "-t",
      `=${record.tmux_session}:`,
      terminalIdentityCondition(record),
      attach,
      "display-message -p identity-changed",
    ].map(quote).join(" ");
    const env = { ...process.env };
    if (!env.TERM) env.TERM = "xterm-256color";
    let child;
    try {
      child = spawnProcess(
        asciinema,
        [
          "stream",
          "--local",
          "--headless",
          "--window-size",
          `${size.cols}x${size.rows}`,
          "-c",
          command,
        ],
        { detached: false, env, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      failEntry(entry, spawnFailure(error, entry));
      return;
    }
    entry.child = child;
    entry.cols = size.cols;
    entry.rows = size.rows;
    if (typeof child.stdout?.on === "function") {
      child.stdout.on("data", (chunk) => onStdout(entry, chunk));
    }
    if (typeof child.stderr?.on === "function") {
      child.stderr.on("data", (chunk) => {
        entry.diagnostics = boundDiagnostics(entry.diagnostics, chunk);
      });
    }
    child.once("error", (error) => onSpawnError(entry, error, child));
    child.once("exit", () => onChildExit(entry));
    // A boundary that settles the child during listener registration has
    // already finalized the entry; do not arm a readiness timer for it.
    if (entry.terminal || entry.stopping) return;
    entry.startTimer = setTimeout(() => {
      entry.startTimer = null;
      failEntry(entry, terminalError("failed", 503, "The terminal stream was not ready in time."));
    }, startTimeoutMs);
  }

  async function startEntry(entry) {
    let size;
    try {
      size = await windowSize(
        { socketPath: entry.record.tmux_socket, sessionName: entry.record.tmux_session },
        tmuxOptions,
      );
    } catch {
      failEntry(entry, terminalError("failed", 503, "The terminal size could not be read."));
      return;
    }
    // closeAll, a superseded reservation or a startup failure may have stopped
    // this entry while the size read was pending; it must never spawn later.
    if (entry.terminal || entry.stopping || !admitting || entries.get(entry.id) !== entry) {
      settleReady(entry, terminalError("busy", 503, "The terminal stream was stopped before it started."));
      return;
    }
    if (size === null) {
      // The session vanished between verification and the size read.
      failEntry(entry, terminalError("not-live", 404, "The assignment terminal is not live."));
      return;
    }
    try {
      const resolved = await readTerminal(entry.id);
      if (resolved.identity !== entry.identity) {
        throw terminalError("changed", 409, "The assignment terminal identity changed. Reconcile it before viewing.");
      }
    } catch (error) {
      failEntry(entry, error);
      return;
    }
    // Verification also awaits record/process probes; preserve reservation
    // ownership after that await, including shutdown and replacement.
    if (entry.terminal || entry.stopping || !admitting || entries.get(entry.id) !== entry) return;
    spawnChild(entry, size);
  }

  async function resolveTerminal(id) {
    const examined = entries.get(id);
    try {
      const resolved = await readTerminal(id);
      if (examined && examined.identity !== resolved.identity) invalidateEntry(examined);
      return resolved;
    } catch (error) {
      if (examined && (error.state === "changed" || error.state === "not-live")) invalidateEntry(examined);
      throw error;
    }
  }

  function invalidateEntry(entry) {
    // A late observation belongs only to its original reservation. stopEntry
    // closes viewers now but retains capacity until the owned child exits.
    if (entries.get(entry.id) === entry) stopEntry(entry);
  }

  async function readTerminal(id) {
    let record;
    try {
      record = await findAssignment(storageRoot, id);
    } catch (error) {
      if (error?.code === "ASSIGNMENT_MISSING") {
        throw terminalError("not-live", 404, "The assignment terminal is not live.");
      }
      throw terminalError("failed", 503, "The assignment could not be read.");
    }
    let verified;
    try {
      verified = await verify(record, tmuxOptions);
    } catch {
      throw terminalError("failed", 503, "The assignment terminal could not be verified.");
    }
    if (verified.ended || verified.pane?.status === "absent") {
      throw terminalError("not-live", 404, "The assignment terminal is not live.");
    }
    // probeSession reports an explicit saved-pane or session-tag mismatch as
    // an unknown probe reason; it is a changed identity, not a transport
    // failure. Every other unknown reason stays failed.
    if (
      verified.pane?.status === "unknown"
      && (verified.pane.reason === "assignment-id-mismatch" || verified.pane.reason === "pane-id-mismatch")
    ) {
      throw terminalError(
        "changed",
        409,
        "The assignment terminal identity changed. Reconcile it before viewing.",
      );
    }
    if (verified.pane?.status !== "present") {
      throw terminalError("failed", 503, "The assignment terminal could not be verified.");
    }
    if (verified.exact !== true) {
      throw terminalError(
        "changed",
        409,
        "The assignment terminal identity changed. Reconcile it before viewing.",
      );
    }
    return { record, identity: verified.identity };
  }

  // The current, admitted ready reservation for an id. Assets and upgrades
  // only attach to this entry; they never create or revive one.
  function readyEntry(id) {
    const entry = entries.get(id);
    if (!entry || entry.terminal || entry.stopping || entry.phase !== "ready" || entry.port === null) {
      return null;
    }
    return entry;
  }

  // Synchronous reservation: no await may separate the map check from the
  // map insertion, so concurrent callers cannot both create an entry or
  // exceed the cap. Matching pending/ready identities share one ready promise;
  // a stopped entry is never reused.
  function ensure(record, identity) {
    if (!admitting) throw terminalError("busy", 503, "Terminal streams are shutting down.");
    const existing = entries.get(record.assignment_id);
    if (existing && !existing.stopping && existing.identity === identity) {
      return existing.ready.promise;
    }
    if (existing) retireEntry(existing);
    if (counted() >= maxStreams) {
      throw terminalError("busy", 503, "Too many terminal streams are open.");
    }
    const entry = createEntry(record, identity);
    entries.set(record.assignment_id, entry);
    void startEntry(entry);
    return entry.ready.promise;
  }

  async function open(id) {
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
      throw terminalError(null, 400, "Assignment ID must be a UUID.");
    }
    if (!admitting) throw terminalError("busy", 503, "Terminal streams are shutting down.");
    const { record, identity } = await resolveTerminal(id);
    return ensure(record, identity);
  }

  function sendAssetFailure(response, status, state, message) {
    if (response.headersSent || response.destroyed) return;
    const body = JSON.stringify({ state, error: message });
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
  }

  function handleAsset(request, response, id, name) {
    if (typeof id !== "string" || !UUID_PATTERN.test(id) || !ASSET_CONTENT_TYPES.has(name)) {
      sendAssetFailure(response, 404, "not-running", "Terminal asset is not available.");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendAssetFailure(response, 405, "not-running", "Use GET or HEAD.");
      return;
    }
    const entry = readyEntry(id);
    if (entry === null) {
      sendAssetFailure(response, 404, "not-running", "Terminal stream is not running.");
      return;
    }
    const upstream = httpRequest({
      hostname: LOOPBACK_HOST,
      port: entry.port,
      path: `/${name}`,
      method: request.method,
    });
    // The exchange stays owned through the response body: the stop path must
    // be able to destroy the upstream response and the downstream response,
    // and a client close must abort both directions.
    let upstreamResponse = null;
    let settled = false;
    const owned = {
      destroy() {
        if (settled) return;
        settled = true;
        try {
          upstreamResponse?.destroy();
        } catch {
          // Exchange cleanup is best effort.
        }
        try {
          upstream.destroy();
        } catch {
          // Exchange cleanup is best effort.
        }
        try {
          response.destroy();
        } catch {
          // Exchange cleanup is best effort.
        }
      },
    };
    if (!ownResource(entry, owned)) {
      upstream.destroy();
      sendAssetFailure(response, 404, "not-running", "Terminal stream is not running.");
      return;
    }
    const release = () => {
      settled = true;
      entry.resources.delete(owned);
    };
    const abort = () => {
      entry.resources.delete(owned);
      owned.destroy();
    };
    request.once("aborted", abort);
    response.once("close", () => {
      if (!response.writableEnded) abort();
    });
    upstream.once("error", () => {
      if (settled) {
        if (!response.destroyed) response.destroy();
        return;
      }
      entry.resources.delete(owned);
      settled = true;
      sendAssetFailure(response, 502, "failed", "Terminal asset is unavailable.");
    });
    upstream.once("response", (incoming) => {
      upstreamResponse = incoming;
      if (settled) {
        upstreamResponse.destroy();
        return;
      }
      const headers = {
        "Content-Type": incoming.headers["content-type"] ?? ASSET_CONTENT_TYPES.get(name),
      };
      const length = incoming.headers["content-length"];
      if (typeof length === "string") headers["Content-Length"] = length;
      response.writeHead(incoming.statusCode ?? 502, headers);
      incoming.on("error", () => response.destroy());
      incoming.once("close", release);
      incoming.pipe(response);
    });
    upstream.end();
  }

  // Refuse a raw upgrade with a status line and a fixed message; the message
  // never carries child diagnostics.
  function refuseUpgrade(socket, status, message) {
    if (socket.destroyed) return;
    const text = UPGRADE_STATUS_TEXT.get(status) ?? "Error";
    const response = `HTTP/1.1 ${status} ${text}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
    try {
      socket.end(response);
      socket.once("finish", () => socket.destroy());
    } catch {
      socket.destroy();
    }
  }

  // Forward only the fields a WebSocket upgrade needs; the upstream Host is
  // always the loopback listener, never the dashboard's incoming Host.
  function upstreamHandshake(entry, request) {
    const headers = request?.headers ?? {};
    const lines = [
      "GET /ws HTTP/1.1",
      `Host: ${LOOPBACK_HOST}:${entry.port}`,
      `Upgrade: ${headers.upgrade ?? "websocket"}`,
      `Connection: ${headers.connection ?? "Upgrade"}`,
    ];
    const forwarded = [
      ["Sec-WebSocket-Key", headers["sec-websocket-key"]],
      ["Sec-WebSocket-Version", headers["sec-websocket-version"]],
      ["Sec-WebSocket-Protocol", headers["sec-websocket-protocol"]],
      ["Sec-WebSocket-Extensions", headers["sec-websocket-extensions"]],
      ["Origin", headers.origin],
    ];
    for (const [name, value] of forwarded) {
      if (typeof value === "string" && value !== "") lines.push(`${name}: ${value}`);
    }
    return `${lines.join("\r\n")}\r\n\r\n`;
  }

  function connectUpstream(entry, request, client, head) {
    // The pair is admitted here, before the connect completes, so a pending
    // connect already counts as a viewer and cancels the idle timer.
    const pair = { entry, client, upstream: null, closed: false };
    entry.viewers.add(pair);
    clearViewerTimers(entry);
    let upstream;
    try {
      upstream = netConnect({ host: LOOPBACK_HOST, port: entry.port });
    } catch {
      stopEntry(entry);
      return;
    }
    pair.upstream = upstream;
    entry.resources.add(upstream);
    upstream.once("connect", () => {
      if (pair.closed || entry.terminal || entry.stopping) {
        closePair(pair);
        return;
      }
      upstream.write(upstreamHandshake(entry, request));
      if (head && head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.once("error", () => {
      // A failed upstream closes both sockets and stops the entry through the
      // single stop path; capacity is released only on actual child exit.
      stopEntry(entry);
    });
    upstream.once("close", () => {
      if (!pair.closed) closePair(pair);
    });
    // A graceful FIN ('end') can precede close on upgraded sockets that stay
    // half-open; close the pair on EOF so the last viewer arms grace.
    upstream.once("end", () => closePair(pair));
    client.once("error", () => closePair(pair));
    client.once("end", () => closePair(pair));
    client.once("close", () => closePair(pair));
  }

  async function handleUpgrade(request, socket, head, id) {
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
      refuseUpgrade(socket, 400, "Assignment ID must be a UUID.");
      return;
    }
    if (!admitting) {
      refuseUpgrade(socket, 503, "Terminal streams are shutting down.");
      return;
    }
    // Own the unresolved socket at manager scope before the identity await:
    // closeAll destroys it, a disconnect releases it, and a late completion
    // cannot revive it.
    pendingUpgrades.add(socket);
    const releasePending = () => {
      pendingUpgrades.delete(socket);
    };
    socket.once("error", () => {
      releasePending();
      socket.destroy();
    });
    socket.once("end", () => {
      releasePending();
      socket.destroy();
    });
    socket.once("close", releasePending);
    let resolved;
    try {
      resolved = await resolveTerminal(id);
    } catch (error) {
      releasePending();
      refuseUpgrade(socket, error.status ?? 500, error.message);
      return;
    }
    releasePending();
    if (socket.destroyed) return;
    if (!admitting) {
      refuseUpgrade(socket, 503, "Terminal streams are shutting down.");
      return;
    }
    const entry = readyEntry(id);
    if (entry === null) {
      refuseUpgrade(socket, 409, "Terminal stream is not running.");
      return;
    }
    if (entry.identity !== resolved.identity) {
      refuseUpgrade(socket, 409, "The assignment terminal identity changed. Reconcile it before viewing.");
      return;
    }
    connectUpstream(entry, request, socket, head);
  }

  function drain(pending) {
    if (pending.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(terminalError("failed", 503, "Terminal streams did not drain in time."));
      }, DRAIN_TIMEOUT_MS);
      Promise.all(pending.map((entry) => entry.exited.promise)).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function closeAll() {
    // Admission stops synchronously; every pending size/start callback then
    // sees a stopped entry (or `admitting === false`) and cannot spawn.
    admitting = false;
    if (drainPromise === null) {
      for (const socket of [...pendingUpgrades]) {
        pendingUpgrades.delete(socket);
        try {
          socket.destroy();
        } catch {
          // The pending handler sees the socket gone and stops.
        }
      }
      const pending = [...entries.values(), ...retiring];
      for (const entry of [...entries.values()]) retireEntry(entry);
      drainPromise = drain(pending);
      // A repeated close must not surface an unhandled rejection when its
      // caller relies on the idempotent drain fallback.
      drainPromise.catch(() => {});
    }
    return drainPromise;
  }

  return { open, handleAsset, handleUpgrade, closeAll };
}
