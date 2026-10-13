import { readSessionActivity } from "./session-activity.mjs";
// Pure projection for observed tmux assignments.
//
// `projectAssignment` maps one stored assignment record plus adj4's pure
// `classify` result into the public observer row. It is a deterministic
// function of its inputs: no I/O, no persistence, no signals. Unknown evidence
// stays unknown; quiet is informational; attached presence never grants
// control. The collection path below composes the real producers; the
// projection function itself stays pure.
//
// Display states follow the supervision state table in the package proposal:
// live, live-unrecorded, launching, launch-unconfirmed, exited-unrecorded,
// terminal-lost, unknown, ended and launch-failed.

import { execFile, execFileSync } from "node:child_process";
import { inspectProcess } from "./process-identity.mjs";
import { listAssignments } from "../workspaces/assignments.mjs";
import { observeAssignment } from "../workspaces/reconcile.mjs";
import { createCatalogReadBudget } from "../workspaces/store.mjs";

// Mirrors SENTINEL_LIMITS.quietActivityMs in sentinel.mjs and adj4's 60-second
// launch-age attention. The projection function stays import-free; the
// collection path below owns the producer imports.
export const QUIET_ACTIVITY_MS = 120000;
export const LAUNCHING_ATTENTION_MS = 60000;

const CLASSIFIED_STATES = new Set([
  "launching",
  "live",
  "launch_unknown",
  "launch_failed",
  "ended",
]);
const TERMINAL_RECORD_STATES = new Set(["launch_failed", "ended"]);
const RUN_ENDED_EXECUTION = new Set([
  "exited",
  "failed",
  "cancelled",
  "blocked",
]);
// A run recorded as running whose coordinator process is gone leaves its workers unconfirmed.
const UNCONFIRMED_REASONS = ["coordinator-gone"];
// adj4 classify has no structured probe-status field, so availability is read
// from its own attention notes for an unknown launcher/terminal/Pi observation
// or an incomplete UUID process listing.
const PROBE_UNAVAILABLE_FRAGMENTS = [
  "observation is unknown",
  "process listing is incomplete",
];
// adj4 classify says this when the exact recorded Pi process is alive without
// the exact recorded terminal: S-2 terminal-lost.
const ALIVE_WITHOUT_TERMINAL = "alive without the exact recorded terminal";
// adj4 classify says this when the flattened process listing contains the
// assignment UUID: positive evidence that contradicts a persisted terminal
// record even when the saved Pi identity is confirmed dead.
const UUID_PROCESS_CANDIDATE =
  "process listing shows a candidate for the assignment UUID";
const UNKNOWN_ACTION = "Fix probe; no relaunch";

function asString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Same spelling normalization on both sides of the run join; the comparison is
// an exact match after trailing separators are removed.
function packageKey(value) {
  const text = asString(value);
  if (text === null) return null;
  const trimmed = text.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function normalizeTime(value) {
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function validIdentity(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const pid = value.pid;
  const startedAt = value.started_at;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "string" || startedAt.length === 0) return null;
  return { pid, started_at: startedAt };
}

function mergeAttention(base, extra) {
  const merged = [];
  for (const value of [
    ...(Array.isArray(base) ? base : []),
    ...(Array.isArray(extra) ? extra : []),
  ]) {
    if (typeof value === "string" && value !== "" && !merged.includes(value))
      merged.push(value);
  }
  return merged;
}

function normalizeRecord(record) {
  const source =
    record !== null && typeof record === "object" && !Array.isArray(record)
      ? record
      : {};
  return {
    assignmentId: asString(source.assignment_id),
    specPackage: packageKey(source.spec_package),
    workflowId: asString(source.workflow_id),
    recordedState: asString(source.state),
    paneId: asString(source.pane_id),
    executionDir: asString(source.execution_dir),
    repositoryId: asString(source.repository_id),
    createdAt: normalizeTime(source.created_at),
    attention: mergeAttention(source.attention, []),
  };
}

function normalizeClassification(classification) {
  const state = asString(classification?.state);
  return {
    state: state !== null && CLASSIFIED_STATES.has(state) ? state : "unknown",
    known: state !== null && CLASSIFIED_STATES.has(state),
    piIdentity: validIdentity(classification?.piIdentity),
    sessionFile: asString(classification?.sessionFile),
    attention: mergeAttention(classification?.attention, []),
    gone: classification?.gone === true,
  };
}

// Structured collector observations. When supplied they are preferred over
// attention prose for terminal and gone decisions; legacy classification-only
// behavior is preserved when absent.
function normalizeObservations(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  return {
    launcher: value.launcher ?? null,
    terminal: value.terminal ?? null,
    pi: value.pi ?? null,
    uuidProcesses: value.uuidProcesses ?? null,
    session: value.session ?? null,
  };
}

function observationStatus(observations, key) {
  const value = observations?.[key];
  return value !== null &&
    typeof value === "object" &&
    typeof value.status === "string"
    ? value.status
    : null;
}

// Positive full-UUID process evidence for a terminal record. Structured
// producer status is authoritative when supplied; the classifier's own
// attention phrase carries the same signal for classification-only input.
function uuidProcessCandidate(observed, observations) {
  if (observations !== null)
    return observationStatus(observations, "uuidProcesses") === "present";
  return observed.attention.some((value) =>
    value.includes(UUID_PROCESS_CANDIDATE),
  );
}

// A structured terminal is usable only when present, for this exact
// assignment and, when the record saved a pane, for the exact recorded pane.
// A positive classified Pi must also be the process in that pane.
function structuredTerminalUnusable(normalized, observed, observations) {
  const terminal = observations?.terminal;
  if (terminal === null || typeof terminal !== "object") return true;
  if (terminal.status === "unknown") return true;
  if (terminal.status !== "present") return false;
  if (asString(terminal.assignment_id) !== normalized.assignmentId) return true;
  const terminalPane = asString(terminal.pane_id);
  if (normalized.paneId !== null && terminalPane !== normalized.paneId)
    return true;
  if (observed.piIdentity !== null && terminal.pid !== observed.piIdentity.pid)
    return true;
  return false;
}

function structuredUnavailable(observations) {
  return ["launcher", "terminal", "pi", "uuidProcesses"].some(
    (key) => observationStatus(observations, key) === "unknown",
  );
}

function probeUnavailable(observed) {
  if (!observed.known) return true;
  return observed.attention.some((value) =>
    PROBE_UNAVAILABLE_FRAGMENTS.some((fragment) => value.includes(fragment)),
  );
}

function aliveWithoutTerminal(observed) {
  if (observed.piIdentity === null) return false;
  return observed.attention.some((value) =>
    value.includes(ALIVE_WITHOUT_TERMINAL),
  );
}

// Session metadata counts only for this assignment and only when it is a
// successful finite size/mtime stat. Null, failed, mismatched and
// transcript-only inputs stay unusable.
function normalizeActivity(activity, assignmentId, sessionFile) {
  if (
    activity === null ||
    typeof activity !== "object" ||
    Array.isArray(activity)
  )
    return null;
  if (activity.ok !== true && activity.status !== "ok") return null;
  const activityAssignment = asString(
    activity.assignment_id ?? activity.assignmentId,
  );
  if (activityAssignment !== null && activityAssignment !== assignmentId)
    return null;
  const activitySession = asString(
    activity.session_file ?? activity.sessionFile,
  );
  if (activitySession !== null && activitySession !== sessionFile) return null;
  const size = activity.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0)
    return null;
  const mtime = normalizeTime(activity.mtime ?? activity.modified_at);
  if (mtime === null) return null;
  return { size, mtime, task_activity: activity.task_activity };
}

function attachedCount(record, activity) {
  const candidates = [
    record?.attached,
    record?.attached_count,
    record?.attachedCount,
    record?.clients,
    activity?.attached,
    activity?.attached_count,
    activity?.attachedCount,
    activity?.clients,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return Math.floor(value);
  }
  return null;
}

// The opt-in tmux probe reports the current session's client count with the
// exact terminal identity. A present terminal count is current evidence for
// the exact assignment and recorded pane, so it takes priority over retained
// record and activity hints. A foreign terminal or a missing, malformed or
// unsafe count leaves the structured count unknown.
function structuredAttachedCount(normalized, observations) {
  const terminal = observations?.terminal;
  if (
    terminal === null ||
    typeof terminal !== "object" ||
    Array.isArray(terminal)
  )
    return null;
  if (terminal.status !== "present") return null;
  if (asString(terminal.assignment_id) !== normalized.assignmentId) return null;
  const terminalPane = asString(terminal.pane_id);
  if (normalized.paneId !== null && terminalPane !== normalized.paneId)
    return null;
  const value = terminal.attached;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return null;
  return value;
}

// A run joins only on the same workflow id and the same package (`ws/slug`
// reference or directory path); a run that carries a full assignment id must
// also name this assignment.
function linkedRuns(runs, normalized) {
  if (normalized.workflowId === null || normalized.specPackage === null)
    return [];
  const matches = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run === null || typeof run !== "object") continue;
    if (asString(run.workflow_id) !== normalized.workflowId) continue;
    if (
      ![run.spec_package, run.package_ref, run.package].some(
        (value) => packageKey(value) === normalized.specPackage,
      )
    )
      continue;
    const runAssignment = asString(run.assignment_id);
    if (runAssignment !== null && runAssignment !== normalized.assignmentId)
      continue;
    matches.push(run);
  }
  return matches;
}

function unconfirmedReasons(run) {
  const reasons = Array.isArray(run?.coverage?.reasons)
    ? run.coverage.reasons
    : Array.isArray(run?.reasons)
      ? run.reasons
      : [];
  return UNCONFIRMED_REASONS.filter((kind) =>
    reasons.some(
      (reason) =>
        typeof reason === "string" &&
        (reason === kind || reason.startsWith(`${kind}:`)),
    ),
  );
}

function displayFor(normalized, observed, nowMs, observations) {
  const recorded = normalized.recordedState;
  const effective = recorded ?? "launch_unknown";
  const locate = locateCommand(normalized.assignmentId ?? "unknown");

  // Recorded terminal states never revive, whatever the observation claims.
  // But positive process evidence contradicting a terminal record is an
  // unresolved process/record mismatch: adj4 classify keeps the state terminal
  // yet returns the exact saved Pi identity on exact saved pid/start liveness
  // (or pane/pid recovery), or keeps a positive full-UUID candidate in the
  // process listing. Either signal means the terminal record cannot be
  // presented as ended history.
  if (TERMINAL_RECORD_STATES.has(recorded)) {
    if (
      observed.piIdentity !== null ||
      uuidProcessCandidate(observed, observations)
    ) {
      return {
        display: "unknown",
        nextAction: UNKNOWN_ACTION,
        unrecorded: false,
        recordProcessMismatch: true,
      };
    }
    return {
      display: recorded === "ended" ? "ended" : "launch-failed",
      nextAction: "History",
      unrecorded: false,
    };
  }
  // Structured observations are authoritative over attention prose: an
  // unknown terminal or a terminal for another assignment, pane or Pi can never
  // become terminal-lost or live.
  if (
    observations !== null &&
    structuredTerminalUnusable(normalized, observed, observations)
  ) {
    return {
      display: "unknown",
      nextAction: UNKNOWN_ACTION,
      unrecorded: false,
    };
  }
  // Unavailable probes are unknown, especially not ended. With structured
  // observations availability comes from the producer statuses, not prose.
  if (
    !observed.known ||
    (observations === null && probeUnavailable(observed))
  ) {
    return {
      display: "unknown",
      nextAction: UNKNOWN_ACTION,
      unrecorded: false,
    };
  }
  // A confirmed gone differs from the stored record until an explicit locate.
  // With structured observations, gone additionally requires the producer's
  // completed absence; otherwise the record is unresolved, not ended.
  if (observed.gone) {
    if (
      observations !== null &&
      observationStatus(observations, "uuidProcesses") !== "absent"
    ) {
      return {
        display: "unknown",
        nextAction: UNKNOWN_ACTION,
        unrecorded: false,
      };
    }
    if (effective === "live") {
      return {
        display: "exited-unrecorded",
        nextAction: locate,
        unrecorded: true,
      };
    }
    return { display: "launch-failed", nextAction: locate, unrecorded: true };
  }
  // A matching Pi process alive without its terminal is terminal-lost and must
  // never invite a relaunch. With structured observations only an exact
  // positive Pi plus an absent terminal qualifies; prose alone does not.
  const terminalLost =
    observations === null
      ? aliveWithoutTerminal(observed)
      : observed.piIdentity !== null &&
        observationStatus(observations, "terminal") === "absent";
  if (terminalLost) {
    return {
      display: "terminal-lost",
      nextAction:
        "Do not relaunch. The agent is still running without a terminal.",
      unrecorded: false,
    };
  }
  // A `live` classification is authoritative only with positive matching
  // identity evidence: adj4 retains `live` whenever gone is unproven, even
  // without liveEvidence, so a retained reservation without an identity must
  // not present a running agent. A structured exact terminal plus Pi shows
  // live without requiring negative UUID proof.
  if (observed.state === "live" && observed.piIdentity !== null) {
    if (effective === "live") {
      return {
        display: "live",
        nextAction: "Attach command",
        unrecorded: false,
      };
    }
    if (effective === "launching" || effective === "launch_unknown") {
      return {
        display: "live-unrecorded",
        nextAction: locate,
        unrecorded: true,
      };
    }
    return {
      display: "unknown",
      nextAction: UNKNOWN_ACTION,
      unrecorded: false,
    };
  }
  // Record says live but the observation neither confirms it with positive
  // identity evidence nor proves gone: report the gap, not a revived live
  // state. This also covers a retained `live` classification without an
  // identity over any record.
  if (effective === "live" || observed.state === "live") {
    return {
      display: "unknown",
      nextAction: UNKNOWN_ACTION,
      unrecorded: false,
    };
  }
  // Structured: a launching record without positive Pi identity and with an
  // unknown launcher, Pi or UUID probe cannot prove a running launch; never
  // present waiting state. An alive launcher with a confirmed dead Pi, absent
  // terminal and complete UUID absence keeps launching with gone false.
  if (
    observations !== null &&
    (effective === "launching" || effective === "launch_unknown") &&
    observed.piIdentity === null
  ) {
    const launcherStatus = observationStatus(observations, "launcher");
    const piStatus = observationStatus(observations, "pi");
    const uuidStatus = observationStatus(observations, "uuidProcesses");
    if (
      launcherStatus === "unknown" ||
      piStatus === "unknown" ||
      uuidStatus === "unknown"
    ) {
      return {
        display: "unknown",
        nextAction: UNKNOWN_ACTION,
        unrecorded: false,
      };
    }
  }
  if (effective === "launching") {
    // Unknown age cannot establish the 60-second threshold, so a young launch
    // stays waiting rather than claiming a failure.
    const age =
      normalized.createdAt === null ? null : nowMs - normalized.createdAt;
    if (age !== null && age >= LAUNCHING_ATTENTION_MS) {
      return {
        display: "launch-unconfirmed",
        nextAction: locate,
        unrecorded: false,
      };
    }
    return { display: "launching", nextAction: "Wait", unrecorded: false };
  }
  if (effective === "launch_unknown") {
    return {
      display: "launch-unconfirmed",
      nextAction: locate,
      unrecorded: false,
    };
  }
  return { display: "unknown", nextAction: UNKNOWN_ACTION, unrecorded: false };
}

/**
 * The supported locate command for an assignment id. Pure text: the
 * projection publishes it and never invokes it.
 *
 * @param {string|number|null|undefined} id assignment id (or the caller's
 *   unknown placeholder when no id was recorded)
 * @returns {string} the exact `node ~/.agents/scripts/workspaces/cli.mjs
 *   locate <id>` command text
 */
export function locateCommand(id) {
  return `node ~/.agents/scripts/workspaces/cli.mjs locate ${id}`;
}

/**
 * Pure projection of one stored assignment record and one adj4 classification
 * into the public observer row.
 *
 * Never persists, signals or imports a producer: the same inputs always yield
 * the same row. `hasControl` is always false; attached presence and quiet
 * activity are informational only.
 *
 * @param {object} record stored assignment record (`assignment_id`,
 *   `spec_package`, `workflow_id`, `state`, `created_at`, optional `attention`,
 *   optional `execution_dir` and `repository_id` execution facts)
 * @param {{state?: string, piIdentity?: object|null, sessionFile?: string|null,
 *   attention?: string[], gone?: boolean}} classification adj4 `classify`
 *   result (or nothing when observation failed)
 * @param {{runs?: object[], activity?: object|null, now?: number|string|Date,
 *   observations?: object|null}} options same-workflow/canonical-package run
 *   rows, optional session stat metadata (`{ok: true, size, mtime}`), the
 *   projection clock and optional structured producer observations (preferred
 *   over attention prose when supplied; a present terminal's `attached` count
 *   takes priority over retained record and activity hints)
 * @returns {object} public row: full `assignment_id`, canonical `spec_package`,
 *   `workflow_id`, string-or-null `execution_dir`/`repository_id`, the
 *   supported `locate_command` text (null without a recorded id),
 *   `recordedState`, `observedState`, `display`, `unrecorded`,
 *   `quiet`, `attachedCount`, `hasControl: false`, `workersUnconfirmed`,
 *   `nextAction`/`safeAction`, merged `attention`, string `coverage` and
 *   `coverageReasons`. A terminal record with positive process evidence keeps
 *   its persisted state but projects `unknown`/no-relaunch/partial and adds
 *   the `record-process-mismatch` coverage reason.
 */
export function projectAssignment(
  record,
  classification,
  { runs = [], activity = null, now, observations = null } = {},
) {
  const normalized = normalizeRecord(record);
  const observed = normalizeClassification(classification);
  const structured = normalizeObservations(observations);
  // The sidebar has room for two notes. Keep the actual launch error ahead
  // of generic missing-identity diagnostics, including older persisted records.
  let attention = mergeAttention(normalized.attention, observed.attention).sort(
    (a, b) =>
      Number(b.startsWith("launch spawn failed:")) -
      Number(a.startsWith("launch spawn failed:")),
  );
  const nowMs = normalizeTime(now) ?? Date.now();

  const decision = displayFor(normalized, observed, nowMs, structured);
  if (decision.display === "live" || decision.display === "live-unrecorded") {
    // Exact live evidence supersedes these retained startup observations.
    // Keep the durable record intact, and label the launch error as history.
    const startupNotes = [
      "no Pi process identity was recorded; only complete UUID absence may prove gone",
      "terminal observation is unknown",
      "process listing is incomplete; assignment UUID absence cannot be confirmed",
      "complete process-listing absence is required; UUID absence cannot be confirmed",
      "assignment age exceeds 60 seconds; retaining the reservation",
      "launcher identity observation is unknown; retaining the reservation",
    ];
    attention = attention
      .filter((note) => !startupNotes.includes(note))
      .map((note) =>
        note.startsWith("launch spawn failed:")
          ? note.replace(
              "launch spawn failed:",
              "Earlier launch attempt failed; session is now open:",
            )
          : note,
      );
  }

  const currentAttached = structuredAttachedCount(normalized, structured);

  const metadata = normalizeActivity(
    activity,
    normalized.assignmentId,
    observed.sessionFile,
  );
  const processPresent =
    decision.display === "live" ||
    decision.display === "live-unrecorded" ||
    decision.display === "terminal-lost";
  const quiet =
    processPresent &&
    metadata !== null &&
    nowMs - metadata.mtime > QUIET_ACTIVITY_MS;

  const matches = linkedRuns(runs, normalized);
  const unconfirmed = [];
  for (const run of matches) {
    for (const kind of unconfirmedReasons(run))
      if (!unconfirmed.includes(kind)) unconfirmed.push(kind);
  }
  const runEnded = matches.some((run) =>
    RUN_ENDED_EXECUTION.has(asString(run.execution)),
  );
  const coordinatorGone =
    decision.display === "ended" || decision.display === "exited-unrecorded";
  const workersUnconfirmed =
    matches.length > 0 &&
    unconfirmed.length > 0 &&
    (runEnded || coordinatorGone);

  let nextAction = decision.nextAction;
  if (workersUnconfirmed) {
    nextAction = "Inspect recorded workers";
    attention.push("workers-unconfirmed");
    for (const kind of unconfirmed)
      if (!attention.includes(kind)) attention.push(kind);
  }

  const coverageReasons = [];
  if (decision.recordProcessMismatch) {
    coverageReasons.push("record-process-mismatch");
    const mismatch = `assignment state ${normalized.recordedState} is terminal but process evidence was observed; refusing ended history`;
    if (!attention.includes(mismatch)) attention.push(mismatch);
  }
  if (!observed.known) coverageReasons.push("classification-unknown");
  const unavailable =
    structured === null
      ? probeUnavailable(observed)
      : structuredUnavailable(structured);
  if (observed.known && unavailable) coverageReasons.push("probe-unavailable");
  const sessionUnavailable =
    structured !== null
      ? ["unreadable", "ambiguous"].includes(
          observationStatus(structured, "session"),
        )
      : observed.attention.some(
          (value) =>
            value.includes("session file candidate is unreadable") ||
            value.includes("multiple Pi session files match"),
        );
  if (sessionUnavailable) coverageReasons.push("session-unavailable");

  return {
    assignment_id: normalized.assignmentId,
    created_at: record.created_at ?? null,
    supersedes: record.supersedes ?? null,
    skill: record.skill ?? null,
    spec_package: normalized.specPackage,
    workflow_id: normalized.workflowId,
    execution_dir: normalized.executionDir,
    repository_id: normalized.repositoryId,
    locate_command: normalized.assignmentId
      ? locateCommand(normalized.assignmentId)
      : null,
    recordedState: normalized.recordedState,
    observedState: observed.state,
    display: decision.display,
    unrecorded: decision.unrecorded,
    quiet,
    task_activity:
      processPresent && metadata?.task_activity
        ? metadata.task_activity
        : {
            state: "unknown",
            reason: "Session response state is unavailable.",
          },
    workspace_id: record.workspace_id ?? null,
    attachedCount: currentAttached ?? attachedCount(record, activity),
    hasControl: false,
    workersUnconfirmed,
    nextAction,
    safeAction: nextAction,
    attention,
    coverage:
      decision.display === "unknown" || unavailable || sessionUnavailable
        ? "partial"
        : "complete",
    coverageReasons,
  };
}

// Collection path -----------------------------------------------------------

const COLLECTION_BUDGET_KEYS = [
  "maxEntries",
  "maxRows",
  "maxFileBytes",
  "maxTotalBytes",
];
const PROBE_TIMEOUT_DEFAULT_MS = 2000;
const PROBE_TIMEOUT_CEILING_MS = 2000;
const PS_MAX_BUFFER = 4 * 1024 * 1024;
const PS_START_MAX_BUFFER = 4096;
const TMUX_MAX_BUFFER = 1024 * 1024;

function clockValue(now) {
  if (typeof now === "function") {
    const value = now();
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return Date.now();
  }
  if (typeof now === "number" && Number.isFinite(now)) return now;
  return Date.now();
}

function collectionBudget(limits) {
  const overrides = {};
  for (const key of COLLECTION_BUDGET_KEYS) {
    if (limits[key] !== undefined) overrides[key] = limits[key];
  }
  return createCatalogReadBudget(overrides);
}

function collectionProbeTimeout(limits) {
  const value = limits.probeTimeoutMs;
  if (value === undefined) return PROBE_TIMEOUT_DEFAULT_MS;
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > PROBE_TIMEOUT_CEILING_MS
  ) {
    throw new Error(
      `probeTimeoutMs must be a positive integer no greater than ${PROBE_TIMEOUT_CEILING_MS}`,
    );
  }
  return value;
}

function remainingProbeMs(deadline) {
  return deadline - performance.now();
}

function probeExpired(deadline) {
  return remainingProbeMs(deadline) <= 0;
}

function tmuxUnavailable(message) {
  return {
    ok: false,
    code: null,
    spawnCode: null,
    signal: null,
    killed: false,
    stdout: "",
    stderr: "",
    message,
  };
}

// Real final transports bounded by the one shared deadline. The default
// flattened listing never claims completeness, so UUID absence stays
// unproven and collection never fabricates ended state from it.
function defaultCollectionProbes(deadline) {
  const inspect = (pid) =>
    inspectProcess(pid, {
      run: (targetPid) =>
        execFileSync("ps", ["-o", "lstart=", "-p", String(targetPid)], {
          env: { ...process.env, LC_ALL: "C" },
          encoding: "utf8",
          timeout: Math.max(1, Math.ceil(remainingProbeMs(deadline))),
          maxBuffer: PS_START_MAX_BUFFER,
          stdio: ["ignore", "pipe", "pipe"],
        }),
    });
  const psRun = async () => ({
    stdout: execFileSync("ps", ["-Awwo", "pid=,command="], {
      env: { ...process.env, LC_ALL: "C" },
      encoding: "utf8",
      timeout: Math.max(1, Math.ceil(remainingProbeMs(deadline))),
      maxBuffer: PS_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    complete: false,
  });
  const tmuxRun = (socketPath, args) =>
    new Promise((resolvePromise) => {
      execFile(
        "tmux",
        ["-S", socketPath, ...args],
        {
          timeout: Math.max(1, Math.ceil(remainingProbeMs(deadline))),
          killSignal: "SIGKILL",
          maxBuffer: TMUX_MAX_BUFFER,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolvePromise({
              ok: false,
              code: typeof error.code === "number" ? error.code : null,
              spawnCode: typeof error.code === "string" ? error.code : null,
              signal: error.signal ?? null,
              killed: error.killed === true,
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              message: error.message,
            });
            return;
          }
          resolvePromise({
            ok: true,
            code: 0,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          });
        },
      );
    });
  return { inspect, psRun, tmuxRun };
}

// Every final boundary, default or injected, is wrapped so it is never
// invoked once the shared deadline has expired.
function deadlineBoundary(fn, fallback, deadline) {
  return (...args) => {
    if (probeExpired(deadline)) return fallback(...args);
    return fn(...args);
  };
}

// The deadline timer stays ref'd: a pending injected boundary with no other
// handles must still let the race return. A rejection resolves the race with
// the error so the caller can record it instead of aborting the collection.
async function raceProbeDeadline(promise, deadline) {
  const remaining = remainingProbeMs(deadline);
  if (remaining <= 0) return { completed: false };
  let timer;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ completed: true, value }),
        (error) => ({ completed: false, error }),
      ),
      new Promise((resolvePromise) => {
        timer = setTimeout(
          () => resolvePromise({ completed: false }),
          Math.ceil(remaining),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Read a bounded tail of the identity-validated session alongside its stat.
// This observes response completion, never workflow acceptance or control authority.
// The read shares the collection byte budget and deadline.
async function selectedSessionActivity(classification, deadline, budget) {
  const file = classification?.sessionFile;
  if (typeof file !== "string" || file === "") return null;
  if (probeExpired(deadline)) return null;
  const remaining = remainingProbeMs(deadline);
  if (remaining <= 0) return null;
  const work = readSessionActivity(file, { budget, deadline });
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(null), Math.ceil(remaining));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collect bounded, read-only assignment observations for one storage root.
 *
 * Enumeration uses the real adj4 bounded listAssignments under one shared
 * catalog budget; observation uses the real adj4 observeAssignment/classify
 * composition sequentially under one monotonic probe deadline started after
 * enumeration. The composition requests the tmux owner's opt-in current
 * client count with the exact terminal identity and projects it as
 * informational `attachedCount`. No persistence, claims, locate, signals or
 * host wiring. Missing or unusable roots yield explicit unavailable coverage.
 *
 * @param {{storageRoot: string, runs?: object[], now?: Function|number,
 *   limits?: {maxEntries?: number, maxRows?: number, maxFileBytes?: number,
 *     maxTotalBytes?: number, probeTimeoutMs?: number}, probes?: object}} input
 * @returns {Promise<{assignments: object[], coverage: {state: string,
 *   reasons: string[], omitted: number|null, bytes_read: number,
 *   observed_at: string}}>}
 */
export async function collectAssignments({
  storageRoot,
  runs = [],
  now = Date.now,
  limits = {},
  probes = {},
} = {}) {
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) {
    throw new TypeError("collectAssignments limits must be an object");
  }
  if (probes === null || typeof probes !== "object" || Array.isArray(probes)) {
    throw new TypeError("collectAssignments probes must be an object");
  }
  const observedAtMs = clockValue(now);
  const observedAt = new Date(observedAtMs).toISOString();
  if (typeof storageRoot !== "string" || storageRoot === "") {
    return {
      assignments: [],
      coverage: {
        state: "unavailable",
        reasons: ["storage-root-unavailable"],
        omitted: null,
        bytes_read: 0,
        observed_at: observedAt,
      },
    };
  }
  const timeoutMs = collectionProbeTimeout(limits);
  const budget = collectionBudget(limits);

  let records;
  try {
    records = await listAssignments(storageRoot, null, { budget });
  } catch (error) {
    const reasons = [...budget.reasons];
    const reason = `collection-failed:${(error && error.code) || "unknown"}`;
    if (!reasons.includes(reason)) reasons.push(reason);
    return {
      assignments: [],
      coverage: {
        state: "unavailable",
        reasons,
        omitted: budget.omissions === "unknown" ? null : 0,
        bytes_read: budget.bytes,
        observed_at: observedAt,
      },
    };
  }
  const storageFailure = budget.reasons.find((reason) =>
    reason.startsWith("storage-"),
  );
  if (storageFailure && records.length === 0) {
    return {
      assignments: [],
      coverage: {
        state: "unavailable",
        reasons: [...budget.reasons],
        omitted: null,
        bytes_read: budget.bytes,
        observed_at: observedAt,
      },
    };
  }

  // One monotonic deadline shared by every record, started after enumeration.
  const deadline = performance.now() + timeoutMs;
  const defaults = defaultCollectionProbes(deadline);
  const inspect = deadlineBoundary(
    typeof probes.inspect === "function" ? probes.inspect : defaults.inspect,
    (pid) => ({ state: "unknown", pid, reason: "probe-deadline" }),
    deadline,
  );
  const psRun = deadlineBoundary(
    typeof probes.psRun === "function" ? probes.psRun : defaults.psRun,
    () => ({ stdout: "", complete: false }),
    deadline,
  );
  const tmuxRun = deadlineBoundary(
    typeof probes.tmuxRun === "function" ? probes.tmuxRun : defaults.tmuxRun,
    () => tmuxUnavailable("probe-deadline"),
    deadline,
  );

  const probeReasons = [];
  const noteProbe = (reason) => {
    if (!probeReasons.includes(reason)) probeReasons.push(reason);
  };
  const rows = [];
  for (const record of records) {
    let classification = null;
    let observations = null;
    let timedOut = probeExpired(deadline);
    if (!timedOut) {
      const raced = await raceProbeDeadline(
        observeAssignment(record, {
          budget,
          deadline,
          requireCompleteUuid: true,
          includeAttached: true,
          now: observedAtMs,
          onObservations: (value) => {
            observations = value;
          },
          inspect,
          psRun,
          tmuxRun,
        }),
        deadline,
      );
      if (raced.completed) classification = raced.value;
      else if (raced.error) {
        noteProbe(
          `observation-failed:${(raced.error && raced.error.code) || "unknown"}`,
        );
      } else {
        timedOut = true;
      }
    }
    if (timedOut) noteProbe("probe-deadline-exceeded");
    const activity =
      classification === null
        ? null
        : await selectedSessionActivity(classification, deadline, budget);
    rows.push(
      projectAssignment(record, classification, {
        runs,
        activity,
        now: observedAtMs,
        observations,
      }),
    );
  }

  // An omitted unknown source may hide a duplicate record: no row may claim
  // proven uniqueness, live state or ended history.
  const omissionUnknown = budget.omissions === "unknown";
  const assignments = rows.map((row) => {
    if (!omissionUnknown) return row;
    return {
      ...row,
      display: "unknown",
      unrecorded: false,
      quiet: false,
      hasControl: false,
      workersUnconfirmed: false,
      nextAction: UNKNOWN_ACTION,
      safeAction: UNKNOWN_ACTION,
      coverage: "partial",
      coverageReasons: [
        ...new Set([...(row.coverageReasons ?? []), "enumeration-omitted"]),
      ],
      attention: [
        ...new Set([...(row.attention ?? []), "enumeration-omitted"]),
      ],
    };
  });

  const reasons = [...new Set([...budget.reasons, ...probeReasons])];
  if (omissionUnknown && !reasons.includes("omitted-unknown"))
    reasons.push("omitted-unknown");
  const rowPartial = assignments.some((row) => row.coverage === "partial");
  return {
    assignments,
    coverage: {
      state: rowPartial || reasons.length > 0 ? "partial" : "complete",
      reasons,
      omitted: omissionUnknown ? null : 0,
      bytes_read: budget.bytes,
      observed_at: observedAt,
    },
  };
}
