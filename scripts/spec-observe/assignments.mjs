// Pure projection for observed tmux assignments.
//
// `projectAssignment` maps one stored assignment record plus adj4's pure
// `classify` result into the public observer row. It is a deterministic
// function of its inputs: no I/O, no persistence, no signals and no producer
// imports. Unknown evidence stays unknown; quiet is informational; attached
// presence never grants control.
//
// Display states follow the supervision state table in the package proposal:
// live, live-unrecorded, launching, launch-unconfirmed, exited-unrecorded,
// terminal-lost, unknown, ended and launch-failed.

// Mirrors SENTINEL_LIMITS.quietActivityMs in sentinel.mjs and adj4's 60-second
// launch-age attention. Local constants keep this module free of observer and
// producer imports.
export const QUIET_ACTIVITY_MS = 120000;
export const LAUNCHING_ATTENTION_MS = 60000;

const CLASSIFIED_STATES = new Set(["launching", "live", "launch_unknown", "launch_failed", "ended"]);
const TERMINAL_RECORD_STATES = new Set(["launch_failed", "ended"]);
const RUN_ENDED_EXECUTION = new Set(["exited", "failed", "cancelled", "blocked"]);
const LEASE_REASONS = ["lease-missing", "lease-mismatch", "lease-revoked"];
// adj4 classify has no structured probe-status field, so availability is read
// from its own attention notes for an unknown launcher/terminal/Pi observation
// or an incomplete UUID process listing.
const PROBE_UNAVAILABLE_FRAGMENTS = ["observation is unknown", "process listing is incomplete"];
// adj4 classify says this when the exact recorded Pi process is alive without
// the exact recorded terminal: S-2 terminal-lost.
const ALIVE_WITHOUT_TERMINAL = "alive without the exact recorded terminal";
const UNKNOWN_ACTION = "Fix probe; no relaunch";

function asString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Same spelling normalization on both sides of the run join; the comparison is
// an exact match after trailing separators are removed.
function canonicalPackage(value) {
  const text = asString(value);
  if (text === null) return null;
  const trimmed = text.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function normalizeTime(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function validIdentity(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const pid = value.pid;
  const startedAt = value.started_at;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "string" || startedAt.length === 0) return null;
  return { pid, started_at: startedAt };
}

function mergeAttention(base, extra) {
  const merged = [];
  for (const value of [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])]) {
    if (typeof value === "string" && value !== "" && !merged.includes(value)) merged.push(value);
  }
  return merged;
}

function normalizeRecord(record) {
  const source = record !== null && typeof record === "object" && !Array.isArray(record) ? record : {};
  return {
    assignmentId: asString(source.assignment_id),
    specPackage: canonicalPackage(source.spec_package),
    workflowId: asString(source.workflow_id),
    recordedState: asString(source.state),
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

function probeUnavailable(observed) {
  if (!observed.known) return true;
  return observed.attention.some(value =>
    PROBE_UNAVAILABLE_FRAGMENTS.some(fragment => value.includes(fragment)));
}

function aliveWithoutTerminal(observed) {
  if (observed.piIdentity === null) return false;
  return observed.attention.some(value => value.includes(ALIVE_WITHOUT_TERMINAL));
}

// Session metadata counts only for this assignment and only when it is a
// successful finite size/mtime stat. Null, failed, mismatched and
// transcript-only inputs stay unusable.
function normalizeActivity(activity, assignmentId, sessionFile) {
  if (activity === null || typeof activity !== "object" || Array.isArray(activity)) return null;
  if (activity.ok !== true && activity.status !== "ok") return null;
  const activityAssignment = asString(activity.assignment_id ?? activity.assignmentId);
  if (activityAssignment !== null && activityAssignment !== assignmentId) return null;
  const activitySession = asString(activity.session_file ?? activity.sessionFile);
  if (activitySession !== null && activitySession !== sessionFile) return null;
  const size = activity.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return null;
  const mtime = normalizeTime(activity.mtime ?? activity.modified_at);
  if (mtime === null) return null;
  return { size, mtime };
}

function attachedCount(record, activity) {
  const candidates = [
    record?.attached, record?.attached_count, record?.attachedCount, record?.clients,
    activity?.attached, activity?.attached_count, activity?.attachedCount, activity?.clients,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  return null;
}

// A run joins only on the same workflow id and the same canonical package; a
// run that carries a full assignment id must also name this assignment.
function linkedRuns(runs, normalized) {
  if (normalized.workflowId === null || normalized.specPackage === null) return [];
  const matches = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run === null || typeof run !== "object") continue;
    if (asString(run.workflow_id) !== normalized.workflowId) continue;
    if (canonicalPackage(run.spec_package ?? run.package) !== normalized.specPackage) continue;
    const runAssignment = asString(run.assignment_id);
    if (runAssignment !== null && runAssignment !== normalized.assignmentId) continue;
    matches.push(run);
  }
  return matches;
}

function leaseReasons(run) {
  const reasons = Array.isArray(run?.coverage?.reasons) ? run.coverage.reasons
    : Array.isArray(run?.reasons) ? run.reasons : [];
  return LEASE_REASONS.filter(kind =>
    reasons.some(reason => typeof reason === "string"
      && (reason === kind || reason.startsWith(`${kind}:`))));
}

function displayFor(normalized, observed, nowMs) {
  const recorded = normalized.recordedState;
  const effective = recorded ?? "launch_unknown";
  const locate = `adjacent locate ${normalized.assignmentId ?? "unknown"}`;

  // Recorded terminal states never revive, whatever the observation claims.
  // But positive matching process evidence contradicting a terminal record
  // is an unresolved process/record mismatch: adj4 classify keeps the state
  // terminal yet returns the exact saved Pi identity with an explicit
  // terminal/live contradiction note, so the projection must surface unknown
  // authority instead of ended history. classify yields a non-null identity
  // only on exact saved pid/start liveness or an exact pane/pid recovery,
  // so the identity itself is the positive-evidence signal.
  if (TERMINAL_RECORD_STATES.has(recorded)) {
    if (observed.piIdentity !== null) {
      return { display: "unknown", nextAction: UNKNOWN_ACTION, unrecorded: false };
    }
    return {
      display: recorded === "ended" ? "ended" : "launch-failed",
      nextAction: "History",
      unrecorded: false,
    };
  }
  // Unavailable probes are unknown, especially not ended.
  if (!observed.known || probeUnavailable(observed)) {
    return { display: "unknown", nextAction: UNKNOWN_ACTION, unrecorded: false };
  }
  // A confirmed gone differs from the stored record until an explicit locate.
  if (observed.gone) {
    if (effective === "live") {
      return { display: "exited-unrecorded", nextAction: locate, unrecorded: true };
    }
    return { display: "launch-failed", nextAction: locate, unrecorded: true };
  }
  // A matching Pi process alive without its terminal is terminal-lost and must
  // never invite a relaunch.
  if (aliveWithoutTerminal(observed)) {
    return {
      display: "terminal-lost",
      nextAction: "Do not relaunch. The agent is still running without a terminal.",
      unrecorded: false,
    };
  }
  // A `live` classification is authoritative only with positive matching
  // identity evidence: adj4 retains `live` whenever gone is unproven, even
  // without liveEvidence, so a retained reservation without an identity must
  // not present a running agent.
  if (observed.state === "live" && observed.piIdentity !== null) {
    if (effective === "live") {
      return { display: "live", nextAction: "Attach command", unrecorded: false };
    }
    if (effective === "launching" || effective === "launch_unknown") {
      return { display: "live-unrecorded", nextAction: locate, unrecorded: true };
    }
    return { display: "unknown", nextAction: UNKNOWN_ACTION, unrecorded: false };
  }
  // Record says live but the observation neither confirms it with positive
  // identity evidence nor proves gone: report the gap, not a revived live
  // state. This also covers a retained `live` classification without an
  // identity over any record.
  if (effective === "live" || observed.state === "live") {
    return { display: "unknown", nextAction: UNKNOWN_ACTION, unrecorded: false };
  }
  if (effective === "launching") {
    // Unknown age cannot establish the 60-second threshold, so a young launch
    // stays waiting rather than claiming a failure.
    const age = normalized.createdAt === null ? null : nowMs - normalized.createdAt;
    if (age !== null && age >= LAUNCHING_ATTENTION_MS) {
      return { display: "launch-unconfirmed", nextAction: locate, unrecorded: false };
    }
    return { display: "launching", nextAction: "Wait", unrecorded: false };
  }
  if (effective === "launch_unknown") {
    return { display: "launch-unconfirmed", nextAction: locate, unrecorded: false };
  }
  return { display: "unknown", nextAction: UNKNOWN_ACTION, unrecorded: false };
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
 *   `spec_package`, `workflow_id`, `state`, `created_at`, optional `attention`)
 * @param {{state?: string, piIdentity?: object|null, sessionFile?: string|null,
 *   attention?: string[], gone?: boolean}} classification adj4 `classify`
 *   result (or nothing when observation failed)
 * @param {{runs?: object[], activity?: object|null, now?: number|string|Date}} options
 *   same-workflow/canonical-package run rows, optional session stat metadata
 *   (`{ok: true, size, mtime}`) and the projection clock
 * @returns {object} public row: full `assignment_id`, canonical `spec_package`,
 *   `workflow_id`, `recordedState`, `observedState`, `display`, `unrecorded`,
 *   `quiet`, `attachedCount`, `hasControl: false`, `workersUnconfirmed`,
 *   `nextAction`/`safeAction`, merged `attention`, string `coverage` and
 *   `coverageReasons`
 */
export function projectAssignment(record, classification, { runs = [], activity = null, now } = {}) {
  const normalized = normalizeRecord(record);
  const observed = normalizeClassification(classification);
  const attention = mergeAttention(normalized.attention, observed.attention);
  const nowMs = normalizeTime(now) ?? Date.now();

  const decision = displayFor(normalized, observed, nowMs);

  const metadata = normalizeActivity(activity, normalized.assignmentId, observed.sessionFile);
  const processPresent = decision.display === "live"
    || decision.display === "live-unrecorded"
    || decision.display === "terminal-lost";
  const quiet = processPresent && metadata !== null
    && nowMs - metadata.mtime > QUIET_ACTIVITY_MS;

  const matches = linkedRuns(runs, normalized);
  const leases = [];
  for (const run of matches) {
    for (const kind of leaseReasons(run)) if (!leases.includes(kind)) leases.push(kind);
  }
  const runEnded = matches.some(run => RUN_ENDED_EXECUTION.has(asString(run.execution)));
  const coordinatorGone = decision.display === "ended" || decision.display === "exited-unrecorded";
  const workersUnconfirmed = matches.length > 0 && leases.length > 0 && (runEnded || coordinatorGone);

  let nextAction = decision.nextAction;
  if (workersUnconfirmed) {
    nextAction = "Inspect recorded workers";
    attention.push("workers-unconfirmed");
    for (const kind of leases) if (!attention.includes(kind)) attention.push(kind);
  }

  const coverageReasons = [];
  if (!observed.known) coverageReasons.push("classification-unknown");
  if (observed.known && probeUnavailable(observed)) coverageReasons.push("probe-unavailable");

  return {
    assignment_id: normalized.assignmentId,
    spec_package: normalized.specPackage,
    workflow_id: normalized.workflowId,
    recordedState: normalized.recordedState,
    observedState: observed.state,
    display: decision.display,
    unrecorded: decision.unrecorded,
    quiet,
    attachedCount: attachedCount(record, activity),
    hasControl: false,
    workersUnconfirmed,
    nextAction,
    safeAction: nextAction,
    attention,
    coverage: decision.display === "unknown" ? "partial" : "complete",
    coverageReasons,
  };
}
