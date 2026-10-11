// Fail-closed assignment observation for Adjacent tmux launches.
//
// `classify` is a pure transition function over externally supplied
// observations. `observeAssignment` performs the read-only external reads —
// the recorded launcher/Pi PID identities through the shared adj2 inspector,
// the terminal through the step-2 tmux adapter, a conservative flattened
// process listing and the owned Pi session directory — and then delegates to
// classify. Nothing here writes, signals, retries or tags a terminal.
// Unknown evidence never releases a reservation.
//
// Documented platform limitation: a default flattened `ps` listing can show a
// positive candidate for the assignment UUID, but truncated or reformatted
// argv cannot prove that no process exists. The default probe therefore
// reports `unknown`, never `absent`; a caller that has a complete process
// listing may inject a `psRun` that returns `{stdout, complete: true}`.

import { execFileSync } from "node:child_process";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { inspectProcess } from "../spec-observe/process-identity.mjs";
import { catalogEntries, readCatalogFile } from "./store.mjs";
import { probeSession } from "./tmux.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGE_ATTENTION_MS = 60000;
const PS_TIMEOUT_MS = 10000;
const PS_MAX_BUFFER = 4 * 1024 * 1024;
const SESSION_HEADER_MAX_BYTES = 65536;
const TERMINAL_STATES = new Set(["launch_failed", "ended"]);
const SESSION_FILE_SUFFIX = ".jsonl";

function defaultPsRun() {
  return execFileSync("ps", ["-Awwo", "pid=,command="], {
    env: { ...process.env, LC_ALL: "C" },
    encoding: "utf8",
    timeout: PS_TIMEOUT_MS,
    maxBuffer: PS_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function mergeAttention(base, extra) {
  const merged = [];
  for (const value of [...(Array.isArray(base) ? base : []), ...extra]) {
    if (typeof value === "string" && !merged.includes(value)) merged.push(value);
  }
  return merged;
}

function validIdentity(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { pid, started_at: startedAt } = value;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "string" || startedAt.length === 0) return null;
  return { pid, started_at: startedAt };
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeLauncher(observation) {
  return {
    status: oneOf(observation?.status, ["alive", "dead", "unknown"], "unknown"),
    identity: validIdentity(observation?.identity),
  };
}

function normalizeTerminal(observation) {
  return {
    status: oneOf(observation?.status, ["present", "absent", "unknown"], "unknown"),
    assignment_id: typeof observation?.assignment_id === "string"
      ? observation.assignment_id
      : null,
    pane_id: typeof observation?.pane_id === "string" && /^%\d+$/.test(observation.pane_id)
      ? observation.pane_id
      : null,
    pid: Number.isSafeInteger(observation?.pid) && observation.pid > 0
      ? observation.pid
      : null,
  };
}

function normalizePi(observation) {
  const identity = validIdentity(observation?.identity);
  const status = oneOf(observation?.status, ["alive", "dead", "unknown"], "unknown");
  // An "alive" claim without a valid start text is malformed evidence, not a
  // reused-process absence.
  if (status === "alive" && identity === null) return { status: "unknown", identity: null };
  return { status, identity };
}

function normalizeUuidProcesses(observation) {
  return { status: oneOf(observation?.status, ["present", "absent", "unknown"], "unknown") };
}

function normalizeSession(observation) {
  return {
    status: oneOf(
      observation?.status,
      ["missing", "readable", "unreadable", "ambiguous"],
      "missing",
    ),
    file: typeof observation?.file === "string" && observation.file !== ""
      ? observation.file
      : null,
  };
}

function normalizeNow(now) {
  if (typeof now === "number" && Number.isFinite(now)) return now;
  if (typeof now === "string" && now !== "") {
    const parsed = Date.parse(now);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function deadlinePassed(deadline) {
  return typeof deadline === "number" && Number.isFinite(deadline)
    && performance.now() >= deadline;
}

/**
 * Pure reservation-preserving transition over observed launcher, terminal,
 * Pi, process-listing and session-file evidence.
 *
 * Transitions (spec.md step 3):
 * - launching -> live only after exact pane and exact saved Pi identity.
 * - launching -> launch_failed only when the launcher is dead and gone is
 *   confirmed; an interrupted (dead launcher, incomplete evidence) or
 *   ambiguous (unknown launcher) launching record becomes launch_unknown.
 * - launch_unknown -> live after the same exact evidence, or launch_failed
 *   only after confirmed gone.
 * - live -> ended only after confirmed gone; otherwise live.
 * - launch_failed/ended never revive.
 *
 * Gone requires a dead launcher, an absent terminal, a recorded Pi identity
 * that is dead or replaced by a reused PID, and — when no Pi identity was
 * recorded — a complete process listing that shows the UUID is absent. With
 * `observations.requireCompleteUuid`, even a dead recorded Pi additionally
 * requires the complete listing's confirmed absence.
 * A matching live Pi without the exact terminal stays attention and holds
 * the reservation. Age beyond 60 seconds adds attention only.
 *
 * @param {object} record assignment record (`state`, `assignment_id`,
 *   `created_at`, optional `attention`, `pane_id`, `pi_identity`)
 * @param {{launcher?: object, terminal?: object, pi?: object,
 *   uuidProcesses?: object, session?: object, now?: number|string}} observations
 * @returns {{state: string, piIdentity: {pid: number, started_at: string}|null,
 *   sessionFile: string|null, attention: string[], gone: boolean}}
 */
export function classify(record, observations = {}) {
  const current = typeof record?.state === "string" ? record.state : "launch_unknown";
  const assignmentId = record?.assignment_id;
  if (typeof assignmentId !== "string" || !UUID_PATTERN.test(assignmentId)) {
    const attention = mergeAttention(record?.attention, [
      "assignment record has no valid UUID; refusing any transition",
    ]);
    return { state: current, piIdentity: null, sessionFile: null, attention, gone: false };
  }

  const launcher = normalizeLauncher(observations.launcher);
  const terminal = normalizeTerminal(observations.terminal);
  const pi = normalizePi(observations.pi);
  const uuidProcesses = normalizeUuidProcesses(observations.uuidProcesses);
  const session = normalizeSession(observations.session);

  // A missing recorded identity (crash before PID capture) is distinct from
  // a malformed one: only the former may be recovered through the terminal
  // pane, and a malformed saved identity never authorizes liveness or gone.
  const savedInput = record.pi_identity;
  const savedMissing = savedInput === undefined || savedInput === null;
  const saved = validIdentity(savedInput);
  const savedMalformed = !savedMissing && saved === null;
  const piExact = saved !== null && pi.status === "alive" && pi.identity !== null
    && pi.identity.pid === saved.pid && pi.identity.started_at === saved.started_at;
  const terminalMatches = terminal.status === "present"
    && terminal.assignment_id === assignmentId
    && terminal.pane_id !== null
    && (record.pane_id === undefined
      || record.pane_id === null
      || (/^%\d+$/.test(record.pane_id) && terminal.pane_id === record.pane_id));
  // Without a saved identity, an alive process observed at the exact saved
  // terminal pane is the only admissible Pi identity. With a saved identity,
  // only its exact pid and start may match.
  const terminalDerived = savedMissing
    && terminalMatches
    && pi.status === "alive"
    && pi.identity !== null
    && terminal.pid !== null
    && pi.identity.pid === terminal.pid;
  const liveEvidence = saved !== null
    ? piExact && terminalMatches && terminal.pid === saved.pid
    : terminalDerived;
  // The returned identity is the exact saved Pi process whenever piExact,
  // independently of the terminal, or the terminal-derived recovery process.
  // State promotion still requires liveEvidence.
  const observedPiIdentity = piExact
    ? { pid: saved.pid, started_at: saved.started_at }
    : terminalDerived
      ? { pid: pi.identity.pid, started_at: pi.identity.started_at }
      : null;

  // A live PID whose valid start text changed is a reused PID: the recorded
  // process is gone. Without a recorded Pi identity, only a complete process
  // listing may establish UUID absence, and a malformed saved identity never
  // does.
  const requireCompleteUuid = observations.requireCompleteUuid === true;
  const piAbsent = saved !== null
    ? pi.status === "dead" || (pi.status === "alive" && !piExact)
    : savedMissing && pi.status !== "alive" && uuidProcesses.status === "absent";
  // A positive process-listing candidate is contradictory evidence and
  // always blocks gone, even with an otherwise dead saved identity. Callers
  // that require a complete process listing additionally demand confirmed
  // UUID absence before gone, even for a dead recorded Pi.
  const gone = launcher.status === "dead"
    && terminal.status === "absent"
    && piAbsent
    && uuidProcesses.status !== "present"
    && (!requireCompleteUuid || uuidProcesses.status === "absent")
    && !liveEvidence;

  let state;
  if (TERMINAL_STATES.has(current)) {
    state = current;
  } else if (liveEvidence) {
    state = "live";
  } else if (gone) {
    state = current === "live" ? "ended" : "launch_failed";
  } else if (current === "live") {
    state = "live";
  } else if (current === "launching") {
    state = launcher.status === "alive" ? "launching" : "launch_unknown";
  } else if (current === "launch_unknown") {
    state = "launch_unknown";
  } else {
    state = current;
  }

  const extra = [];
  if (TERMINAL_STATES.has(current) && liveEvidence) {
    extra.push(`assignment state ${current} is terminal but live evidence was observed; refusing to revive it`);
  }
  if (!TERMINAL_STATES.has(current) && !["launching", "launch_unknown", "live"].includes(current)) {
    extra.push(`assignment state ${JSON.stringify(current)} is not reconcilable; retaining it without transition`);
  }
  if (!liveEvidence) {
    if (launcher.status === "unknown") {
      extra.push("launcher identity observation is unknown; retaining the reservation");
    }
    if (savedMissing) {
      extra.push("no Pi process identity was recorded; only complete UUID absence may prove gone");
    } else if (savedMalformed) {
      extra.push("recorded Pi process identity is malformed; refusing liveness and gone evidence");
    } else if (pi.status === "unknown") {
      extra.push(`recorded Pi process ${saved.pid} observation is unknown`);
    } else if (pi.status === "dead") {
      extra.push(`recorded Pi process ${saved.pid} is confirmed dead`);
    } else if (!piExact) {
      extra.push(`recorded Pi process ${saved.pid} start no longer matches the live process`);
    }
    if (piExact) {
      extra.push("matching Pi process is alive without the exact recorded terminal; retaining the reservation");
    }
    if (terminal.status === "unknown") extra.push("terminal observation is unknown");
    if (savedMissing && uuidProcesses.status === "unknown") {
      extra.push("process listing is incomplete; assignment UUID absence cannot be confirmed");
    }
    if (requireCompleteUuid && uuidProcesses.status !== "absent") {
      extra.push("complete process-listing absence is required; UUID absence cannot be confirmed");
    }
    if (uuidProcesses.status === "present") {
      extra.push("process listing shows a candidate for the assignment UUID; retaining the reservation");
    }
  }
  if (session.status === "unreadable") {
    extra.push("Pi session file candidate is unreadable or malformed; refusing selection");
  }
  if (session.status === "ambiguous") {
    extra.push(`multiple Pi session files match assignment ${assignmentId}; refusing selection`);
  }
  const nowMs = normalizeNow(observations.now);
  const createdMs = typeof record.created_at === "string" ? Date.parse(record.created_at) : NaN;
  if (!liveEvidence && nowMs !== null && Number.isFinite(createdMs)
    && nowMs - createdMs > AGE_ATTENTION_MS) {
    extra.push("assignment age exceeds 60 seconds; retaining the reservation");
  }

  return {
    state,
    piIdentity: observedPiIdentity,
    sessionFile: session.status === "readable" ? session.file : null,
    attention: mergeAttention(record.attention, extra),
    gone,
  };
}

// Map one recorded identity through the shared adj2 inspector. Only an exact
// recorded start is alive; a reused PID and confirmed ESRCH are dead; every
// exception, malformed result and missing identity is unknown. An explicit
// but malformed saved identity is not equivalent to a missing one.
function observeIdentity(savedInput, inspect) {
  const saved = validIdentity(savedInput);
  if (saved === null) {
    const missing = savedInput === undefined || savedInput === null;
    return { status: "unknown", reason: missing ? "missing-identity" : "malformed-identity" };
  }
  let observed;
  try {
    observed = inspect(saved.pid);
  } catch (error) {
    return { status: "unknown", reason: (error && error.code) || "inspect-failed" };
  }
  if (observed === null || typeof observed !== "object" || observed.pid !== saved.pid) {
    return { status: "unknown", reason: "malformed-observation" };
  }
  if (observed.state === "dead") return { status: "dead" };
  if (observed.state === "alive") {
    const startedAt = typeof observed.started_at === "string" ? observed.started_at.trim() : "";
    // Empty or malformed start text cannot distinguish the recorded process
    // from a reused PID; it is unknown, never dead/reused.
    if (startedAt === "") return { status: "unknown", reason: "malformed-observation" };
    if (startedAt === saved.started_at) {
      return { status: "alive", identity: { pid: saved.pid, started_at: startedAt } };
    }
    return { status: "dead", reason: "reused-pid" };
  }
  return { status: "unknown", reason: observed.reason ?? "unknown" };
}

// Missing-identity recovery: observe a raw pane PID through the same shared
// inspector. Only a fresh alive observation with valid start text yields an
// identity; every other result is unknown or dead.
function inspectPaneProcess(pid, inspect) {
  let observed;
  try {
    observed = inspect(pid);
  } catch (error) {
    return { status: "unknown", reason: (error && error.code) || "inspect-failed" };
  }
  if (observed === null || typeof observed !== "object" || observed.pid !== pid) {
    return { status: "unknown", reason: "malformed-observation" };
  }
  if (observed.state === "dead") return { status: "dead" };
  if (observed.state !== "alive") return { status: "unknown", reason: observed.reason ?? "unknown" };
  const startedAt = typeof observed.started_at === "string" ? observed.started_at.trim() : "";
  if (startedAt === "") return { status: "unknown", reason: "malformed-observation" };
  return { status: "alive", identity: { pid, started_at: startedAt } };
}

async function observeUuidProcesses(record, psRun) {
  let output;
  try {
    output = await psRun(record);
  } catch (error) {
    return { status: "unknown", reason: (error && error.code) || "ps-failed" };
  }
  let listing = output;
  let complete = false;
  if (output !== null && typeof output === "object") {
    listing = output.stdout ?? output.listing;
    complete = output.complete === true;
  }
  if (typeof listing !== "string") return { status: "unknown", reason: "malformed-listing" };
  if (listing.includes(record.assignment_id)) return { status: "present" };
  return complete ? { status: "absent" } : { status: "unknown", reason: "incomplete-listing" };
}

// Installed Pi names session files `${fileTimestamp}_${sessionId}.jsonl`
// (dist/core/session-manager.js writes ISO timestamps with ":" and "."
// replaced by "-"), so the UUID is the final underscore-separated token.
function sessionFilenameMatches(name, assignmentId) {
  if (!name.endsWith(SESSION_FILE_SUFFIX)) return false;
  const token = name.slice(0, -SESSION_FILE_SUFFIX.length).split("_").pop();
  return token === assignmentId;
}

// Bounded read of the first JSONL line: the session header. Anything that
// cannot be validated (malformed JSON, non-session type, missing line) is
// unreadable, never "missing".
async function readSessionHeader(path, budget = null) {
  let text;
  if (budget === null) {
    let handle;
    try {
      handle = await open(path, "r");
    } catch (error) {
      return { state: "unreadable", reason: (error && error.code) || "open-failed" };
    }
    try {
      const buffer = Buffer.alloc(SESSION_HEADER_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } catch (error) {
      return { state: "unreadable", reason: (error && error.code) || "read-failed" };
    } finally {
      await handle.close();
    }
  } else {
    // Bounded first-line mode: charge only the header prefix, never the
    // transcript, through the shared catalog reader.
    const read = await readCatalogFile(path, budget, { maxBytes: SESSION_HEADER_MAX_BYTES });
    if (!read.ok) return { state: "unreadable", reason: read.reason };
    text = read.text;
  }
  const newline = text.indexOf("\n");
  const line = (newline === -1 ? text : text.slice(0, newline)).trim();
  if (line === "") return { state: "unreadable", reason: "empty-header" };
  let header;
  try {
    header = JSON.parse(line);
  } catch {
    return { state: "unreadable", reason: "malformed-header" };
  }
  if (header === null || typeof header !== "object" || header.type !== "session") {
    return { state: "unreadable", reason: "not-a-session-header" };
  }
  return { state: "parsed", header };
}

// Session discovery stays inside the single recorded owned session directory;
// there is no host-wide scan. A missing directory or no filename candidate is
// missing. Symlinked, non-regular, malformed or unreadable candidates refuse
// selection (they could hide a second matching file), and multiple valid
// matching headers are ambiguous.
async function discoverPiSession(record, budget = null, deadline = null) {
  if (deadlinePassed(deadline)) return { status: "unreadable", reason: "probe-deadline" };
  const dir = record?.pi_session_dir;
  if (typeof dir !== "string" || dir === "" || !isAbsolute(dir)) {
    return { status: "missing", reason: "no-session-directory" };
  }
  let info;
  try {
    info = await lstat(dir);
  } catch (error) {
    if (error && error.code === "ENOENT") return { status: "missing" };
    return { status: "unreadable", reason: (error && error.code) || "lstat-failed" };
  }
  if (info.isSymbolicLink()) {
    return { status: "unreadable", reason: "session-directory-is-symlink" };
  }
  if (!info.isDirectory()) {
    return { status: "unreadable", reason: "session-directory-is-not-a-directory" };
  }
  if (deadlinePassed(deadline)) return { status: "unreadable", reason: "probe-deadline" };

  let entries;
  let truncated = false;
  if (budget === null) {
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      return { status: "unreadable", reason: (error && error.code) || "readdir-failed" };
    }
  } else {
    entries = [];
    try {
      for await (const entry of catalogEntries(dir, budget)) {
        entries.push(entry);
      }
    } catch (error) {
      return { status: "unreadable", reason: (error && error.code) || "readdir-failed" };
    }
    // The iterator marks the shared omission when it stops at the entry cap
    // without a further read; a capped scan cannot prove absence.
    truncated = budget.omissions === "unknown" && budget.entries >= budget.maxEntries;
  }
  // A truncated listing can never prove absence or uniqueness: unavailable
  // remains unreadable, not missing.
  if (truncated) return { status: "unreadable", reason: "session-scan-truncated" };
  if (deadlinePassed(deadline)) return { status: "unreadable", reason: "probe-deadline" };
  const candidates = entries.filter((entry) => sessionFilenameMatches(entry.name, record.assignment_id));
  if (candidates.length === 0) return { status: "missing" };

  const matches = [];
  const problems = [];
  for (const entry of candidates) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      problems.push({
        path,
        reason: entry.isSymbolicLink() ? "symlink" : "not-a-regular-file",
      });
      continue;
    }
    if (deadlinePassed(deadline)) return { status: "unreadable", reason: "probe-deadline" };
    const parsed = await readSessionHeader(path, budget);
    if (parsed.state !== "parsed") {
      problems.push({ path, reason: parsed.reason });
      continue;
    }
    if (parsed.header.id !== record.assignment_id) {
      problems.push({ path, reason: "session-id-mismatch" });
      continue;
    }
    matches.push(path);
  }

  if (problems.length > 0) {
    return { status: "unreadable", reason: problems[0].reason, problems };
  }
  if (matches.length > 1) return { status: "ambiguous", files: matches };
  return { status: "readable", file: matches[0] };
}

/**
 * Assemble the real external observations for an assignment record and return
 * the pure classify result. Side-effect-free: no record writes, no tmux
 * mutation, no signals. `probes` substitutes only the final boundaries —
 * `inspect` (OS identity; defaults to the shared adj2 inspector), `psRun`
 * (flattened process listing), `tmuxRun` (tmux command transport), `now`
 * (observation clock) and `includeAttached` (the tmux owner's documented
 * opt-in client count, default off). The classify composition itself is
 * never substituted.
 *
 * @param {object} record assignment record
 * @param {{inspect?: Function, psRun?: Function, tmuxRun?: Function,
 *   now?: number|string|Function, budget?: object, deadline?: number,
 *   onObservations?: Function, requireCompleteUuid?: boolean,
 *   includeAttached?: boolean}} [probes] `includeAttached` forwards the tmux
 *   owner's opt-in client count with the same exact terminal identity query;
 *   the default query and result shape stay unchanged
 * @returns {Promise<{state: string, piIdentity: object|null,
 *   sessionFile: string|null, attention: string[], gone: boolean}>}
 */
export async function observeAssignment(record, probes = {}) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("record must be an assignment record object");
  }
  const inspect = typeof probes.inspect === "function" ? probes.inspect : inspectProcess;
  const psRun = typeof probes.psRun === "function" ? probes.psRun : defaultPsRun;
  const budget = probes.budget ?? null;
  const deadline = typeof probes.deadline === "number" && Number.isFinite(probes.deadline)
    ? probes.deadline
    : null;
  const now = typeof probes.now === "function" ? probes.now() : (probes.now ?? Date.now());
  const finish = (launcher, terminal, pi, uuidProcesses, session) => classify(record, {
    launcher,
    terminal,
    pi,
    uuidProcesses,
    session,
    now,
    requireCompleteUuid: probes.requireCompleteUuid === true,
  });

  const launcher = observeIdentity(record.launcher_identity, inspect);

  let terminal;
  try {
    terminal = await probeSession(record, {
      ...(probes.tmuxRun === undefined ? {} : { run: probes.tmuxRun }),
      includeAttached: probes.includeAttached === true,
    });
  } catch (error) {
    terminal = { status: "unknown", reason: (error && error.code) || "tmux-probe-failed" };
  }
  // The shared monotonic deadline is checked between awaited stages so a
  // late-resolving transport cannot start later probes, scans or reads.
  if (deadlinePassed(deadline)) {
    return finish(launcher, terminal, { status: "unknown" }, { status: "unknown" },
      { status: "unreadable", reason: "probe-deadline" });
  }

  // Crash before PID capture: with no saved identity, observe the exact
  // saved terminal pane PID through the shared inspector. classify admits
  // the result only when the terminal UUID/pane and PID all match.
  const pi = (record.pi_identity === undefined || record.pi_identity === null)
    && terminal.status === "present"
    && Number.isSafeInteger(terminal.pid) && terminal.pid > 0
    ? inspectPaneProcess(terminal.pid, inspect)
    : observeIdentity(record.pi_identity, inspect);
  if (deadlinePassed(deadline)) {
    return finish(launcher, terminal, pi, { status: "unknown" },
      { status: "unreadable", reason: "probe-deadline" });
  }

  const uuidProcesses = await observeUuidProcesses(record, psRun);
  if (deadlinePassed(deadline)) {
    return finish(launcher, terminal, pi, uuidProcesses,
      { status: "unreadable", reason: "probe-deadline" });
  }

  const session = await discoverPiSession(record, budget, deadline);
  const observations = { launcher, terminal, pi, uuidProcesses, session };
  if (typeof probes.onObservations === "function" && !deadlinePassed(deadline)) {
    await probes.onObservations({ ...observations });
  }
  return finish(launcher, terminal, pi, uuidProcesses, session);
}

// The same observational operation for adj6: an alias, never a parallel
// writer. Persisted updates remain owned by assignments.mjs under the root
// claim.
export const reconcileAssignment = observeAssignment;
