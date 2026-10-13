// Isolated tmux transport adapter for Adjacent assignments.
//
// Node-standard-library only plus the shared adj2 PID/start-time observation.
// Every tmux invocation targets an explicit `-S socketPath` server with
// argument arrays (never a shell). Production code never signals or kills
// agents during observation or launch, never mutates the default tmux server
// and never writes tmux configuration. Only endSession closes a verified
// assignment terminal after an explicit operator request.
//
// On Linux, `startSession` ensures an independent user-service server and
// forbids client auto-start. Other platforms retain the detached bootstrap. It runs the
// direct Pi argv in the new pane and records the full assignment UUID as an
// exact session user option. Adoption of an existing session happens only
// when that recorded UUID equals the requested assignment AND the caller
// supplies the saved pane identity (`expectedPane`) that still matches the
// live pane process; a short-name match alone never adopts, and adoption
// without (or with mismatched) saved pane evidence refuses fail-closed.
//
// tmux 3.8 target syntax: session-target commands (`has-session`,
// `attach-session`) accept `=name` for exact matching, while pane-target
// commands (`set-option`, `display-message`) need `=name:` so the session
// part is still matched exactly. tmux 3.8 exposes a single
// `extended-keys [on|off|always]` server option (the planner's separate
// `extended-keys-always` command does not exist on the installed version)
// plus the independent `extended-keys-format [csi-u|xterm]` server option;
// the bootstrap sets the CSI-u format when supported. tmux 3.4 has no
// format option: quiet set-option skips that optional setting so it cannot
// abort the command queue before Pi is started.

import { ensureTerminalHost, terminalSocketAbsent } from "./tmux-host.mjs";
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { inspectProcess, processIdentity, sameProcess } from "../spec-observe/process-identity.mjs";

const TMUX_TIMEOUT_MS = 10000;
const IDENTITY_READY_MS = 2000;
const SESSION_NAME_PATTERN = /^adj-[0-9a-f]{12}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || value === "" || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
}

function assertSessionName(sessionName) {
  if (typeof sessionName !== "string" || !SESSION_NAME_PATTERN.test(sessionName)) {
    throw new Error(`sessionName must match ${SESSION_NAME_PATTERN}`);
  }
}

function assertUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be an RFC4122 UUID`);
  }
}

function assertExpectedPane(value) {
  if (value === undefined) return;
  const paneIdOk = typeof value === "object" && value !== null
    && typeof value.paneId === "string" && /^%\d+$/.test(value.paneId);
  const identity = paneIdOk ? value.piIdentity : null;
  const identityOk = typeof identity === "object" && identity !== null
    && Number.isSafeInteger(identity.pid) && identity.pid > 0
    && typeof identity.started_at === "string" && identity.started_at !== "";
  if (!paneIdOk || !identityOk) {
    throw new Error("expectedPane must be {paneId: '%N', piIdentity: {pid, started_at}}");
  }
}

// tmux 3.8 parses its own argv after the shell: a standalone ";" token and
// a trailing ";" both act as command separators, so a literal argument in
// either position must escape the final ";" as "\;". Leading and
// interior semicolons pass through untouched (verified against tmux 3.8 on
// an isolated socket: ";x", "a;b" and "x;;y" arrive unchanged, while
// unescaped ";" splits the queue and "abc;" arrives as "abc").
function escapeTmuxArg(argument) {
  if (argument.endsWith(";")) return `${argument.slice(0, -1)}\\;`;
  return argument;
}

// Bounded single argv-array tmux invocation. A non-zero exit resolves with
// the exit code; spawn-level failures keep the string code.
function runTmux(socketPath, args) {
  return new Promise((resolvePromise) => {
    execFile(
      "tmux",
      ["-S", socketPath, ...args],
      {
        timeout: TMUX_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
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
        resolvePromise({ ok: true, code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

function tmuxFailure(command, result) {
  const detail = result.stderr.trim() || result.message || "unknown error";
  return new Error(`tmux ${command} failed: ${detail}`);
}

// A read-only reachability probe: `list-clients` exits 0 on a running server
// (with or without attached clients) and exits 1 when no server answers.
async function serverReachable(socketPath, run = runTmux) {
  const probe = await run(socketPath, ["list-clients"]);
  if (probe.ok) return true;
  if (probe.code === 1) return false;
  throw tmuxFailure("list-clients", probe);
}

/**
 * Determine whether the exact session exists on the explicit socket server.
 * `false` is confirmed absence (has-session exit 1 with a reachable server);
 * an unreachable server or any other transport failure throws.
 * @param {{socketPath: string, sessionName: string}} input
 * @returns {Promise<boolean>}
 */
export async function hasSession({ socketPath, sessionName } = {}, { run = runTmux } = {}) {
  assertAbsolutePath(socketPath, "socketPath");
  assertSessionName(sessionName);
  const result = await run(socketPath, ["has-session", "-t", `=${sessionName}`]);
  if (result.ok) return true;
  if (result.code === 1) {
    if (await serverReachable(socketPath, run)) return false;
    throw new Error(`tmux server is unreachable: ${socketPath}`);
  }
  throw tmuxFailure("has-session", result);
}

/**
 * Resolve the exact session's current pane identity. Returns null only on
 * confirmed session absence; unreachable-server and transport failures throw.
 * @param {{socketPath: string, sessionName: string}} input
 * @returns {Promise<{paneId: string, panePid: number}|null>}
 */
export async function sessionPanePid({ socketPath, sessionName } = {}, { run = runTmux } = {}) {
  assertAbsolutePath(socketPath, "socketPath");
  assertSessionName(sessionName);
  if (!(await hasSession({ socketPath, sessionName }, { run }))) return null;
  const result = await run(socketPath, [
    "display-message",
    "-p",
    "-t",
    `=${sessionName}:`,
    "#{pane_id} #{pane_pid}",
  ]);
  if (!result.ok) {
    // The session may have vanished after the has-session probe: re-check to
    // distinguish confirmed absence from a transport failure.
    if (!(await hasSession({ socketPath, sessionName }, { run }))) return null;
    throw tmuxFailure("display-message", result);
  }
  const match = /^(%\d+)\s+(\d+)$/.exec(result.stdout.trim());
  if (!match) {
    throw new Error(`tmux returned an unexpected pane identity: ${JSON.stringify(result.stdout)}`);
  }
  const panePid = Number(match[2]);
  if (!Number.isSafeInteger(panePid) || panePid <= 0) {
    throw new Error(`tmux returned an invalid pane pid: ${match[2]}`);
  }
  return { paneId: match[1], panePid };
}

/**
 * Read the exact session's current window dimensions. `null` is returned
 * only on confirmed session absence; an unreachable server or any other
 * transport failure throws instead of returning fabricated dimensions.
 * With `includeStatus` the same read additionally reports the session's
 * current status option rows (`off`/`0` → 0, `on` → 1, `1`..`5` → that
 * count); the default call and its exact `{cols, rows}` result are unchanged.
 * Reading the option never mutates it.
 * @param {{socketPath: string, sessionName: string}} input
 * @param {{run?: Function, includeStatus?: boolean}} [options]
 * @returns {Promise<{cols: number, rows: number, statusRows?: number}|null>}
 */
export async function windowSize({ socketPath, sessionName } = {}, { run = runTmux, includeStatus = false } = {}) {
  assertAbsolutePath(socketPath, "socketPath");
  assertSessionName(sessionName);
  if (!(await hasSession({ socketPath, sessionName }, { run }))) return null;
  const format = includeStatus
    ? "#{window_width} #{window_height} #{status}"
    : "#{window_width} #{window_height}";
  const result = await run(socketPath, [
    "display-message",
    "-p",
    "-t",
    `=${sessionName}:`,
    format,
  ]);
  if (!result.ok) {
    // The session may have vanished after the has-session probe: re-check to
    // distinguish confirmed absence from a transport failure.
    if (!(await hasSession({ socketPath, sessionName }, { run }))) return null;
    throw tmuxFailure("display-message", result);
  }
  const match = (includeStatus ? /^(\d+)\s+(\d+)\s+(\S+)$/ : /^(\d+)\s+(\d+)$/).exec(result.stdout.trim());
  const cols = match === null ? NaN : Number(match[1]);
  const rows = match === null ? NaN : Number(match[2]);
  if (!Number.isSafeInteger(cols) || cols <= 0 || !Number.isSafeInteger(rows) || rows <= 0) {
    throw new Error(`tmux returned invalid window dimensions: ${JSON.stringify(result.stdout)}`);
  }
  if (!includeStatus) return { cols, rows };
  const status = match[3];
  const statusRows = status === "off" || status === "0"
    ? 0
    : status === "on"
      ? 1
      : /^[1-5]$/.test(status)
        ? Number(status)
        : null;
  if (statusRows === null) {
    throw new Error(`tmux returned invalid window status: ${JSON.stringify(status)}`);
  }
  return { cols, rows, statusRows };
}

async function resolveOwnedSession(socketPath, sessionName, run = runTmux) {
  const pane = await sessionPanePid({ socketPath, sessionName }, { run });
  if (pane === null) throw new Error(`tmux session is absent: ${sessionName}`);
  const deadline = Date.now() + IDENTITY_READY_MS;
  for (;;) {
    const piIdentity = processIdentity(pane.panePid);
    if (piIdentity !== null) {
      return { socketPath, sessionName, paneId: pane.paneId, panePid: pane.panePid, piIdentity };
    }
    if (Date.now() >= deadline) {
      throw new Error(`tmux session pane process identity is unavailable: ${sessionName}`);
    }
    await delay(25);
  }
}

// A pre-existing session is adopted only when its full recorded assignment
// UUID equals the requested one AND the caller's saved pane identity still
// matches the live pane process. Without saved evidence, or on any pane or
// process mismatch, adoption refuses fail-closed: an observable process in
// the active pane is not a matching recorded Pi process.
async function adoptExisting(socketPath, sessionName, assignmentId, expectedPane, run = runTmux) {
  const tag = await run(socketPath, [
    "show-options",
    "-v",
    "-t",
    `=${sessionName}:`,
    "@adjacent_assignment_id",
  ]);
  if (!tag.ok) {
    if (tag.code === 1) {
      throw new Error(`tmux session name collision: ${sessionName} has no assignment id`);
    }
    throw tmuxFailure("show-options", tag);
  }
  const recorded = tag.stdout.trim();
  if (recorded !== assignmentId) {
    throw new Error(
      `tmux session name collision: ${sessionName} records assignment ${recorded}`,
    );
  }
  if (expectedPane === undefined) {
    throw new Error(
      `tmux session pane identity is unavailable for adoption: ${sessionName} records assignment ${recorded}`,
    );
  }
  const current = await resolveOwnedSession(socketPath, sessionName, run);
  if (current.paneId !== expectedPane.paneId) {
    throw new Error(
      `tmux session pane identity mismatch: ${sessionName} active pane ${current.paneId} is not the recorded ${expectedPane.paneId}`,
    );
  }
  const expected = expectedPane.piIdentity;
  if (
    current.piIdentity.pid !== expected.pid
    || current.piIdentity.started_at !== expected.started_at
    || !sameProcess(expected)
  ) {
    throw new Error(
      `tmux session pane process mismatch: ${sessionName} pane ${current.paneId} no longer runs the recorded Pi process`,
    );
  }
  return current;
}

/**
 * Start the assignment's isolated tmux session and run the direct Pi argv.
 *
 * Linux first ensures the independent user service; its client queue uses
 * `-N` to prohibit accidental server creation. Other platforms bootstrap in
 * the same command queue. The `-S socketPath` queue enables extended
 * keys with the CSI-u reporting format, creates the detached session (200x50)
 * in `cwd` with `ADJACENT_ASSIGNMENT_ID`, executes `piPath` + `piArgs`
 * without a shell, and records the exact assignment UUID as
 * `@adjacent_assignment_id`. Literal `cwd`, `piPath` and `piArgs` values are
 * encoded for tmux's own argv parser (a standalone or trailing `";"` would
 * otherwise split the queue or be stripped); intentional queue separators
 * stay bare. An existing same-name session is adopted only when its recorded
 * UUID matches and `expectedPane` (`{paneId, piIdentity}` saved from the
 * original launch) still matches the live pane process; missing or
 * mismatched pane evidence refuses adoption, and any other collision throws.
 *
 * @param {{socketPath: string, sessionName: string, cwd: string,
 *   piPath: string, piArgs: string[], assignmentId: string,
 *   expectedPane?: {paneId: string, piIdentity: {pid: number, started_at: string}}}} input
 * @param {{run?: (socketPath: string, args: string[]) => Promise<object>}} [options]
 *   final tmux command boundary; defaults to the real adapter transport
 * @returns {Promise<{socketPath: string, sessionName: string, paneId: string,
 *   panePid: number, piIdentity: {pid: number, started_at: string}}>}
 */
export async function startSession({
  socketPath,
  sessionName,
  cwd,
  piPath,
  piArgs,
  assignmentId,
  expectedPane,
} = {}, { run = runTmux } = {}) {
  assertAbsolutePath(socketPath, "socketPath");
  assertSessionName(sessionName);
  assertAbsolutePath(cwd, "cwd");
  assertAbsolutePath(piPath, "piPath");
  assertUuid(assignmentId, "assignmentId");
  assertExpectedPane(expectedPane);
  if (!Array.isArray(piArgs) || piArgs.length === 0
    || piArgs.some((argument) => typeof argument !== "string")) {
    throw new Error("piArgs must be a non-empty array of strings");
  }
  // piArgs is non-empty, so the direct command has more than one argument
  // after `--` (the piPath command counts as the first).
  const commands = [
    "start-server", ";",
    "set-option", "-s", "extended-keys", "on", ";",
    "set-option", "-sq", "extended-keys-format", "csi-u", ";",
    "new-session", "-d", "-x", "200", "-y", "50", "-s", sessionName, "-c", escapeTmuxArg(cwd),
    "-e", `ADJACENT_ASSIGNMENT_ID=${assignmentId}`, "--", escapeTmuxArg(piPath), ...piArgs.map(escapeTmuxArg), ";",
    "set-option", "-t", `=${sessionName}:`, "@adjacent_assignment_id", assignmentId,
  ];
  const managed = process.platform === "linux" && run === runTmux;
  const serverIdentity = managed ? await ensureTerminalHost(socketPath) : null;
  // tmux copies these values from this client's environment when creating
  // the session. Only names enter argv, including provider credentials; the
  // independent server's older environment must not replace launch settings.
  const environmentNames = [...new Set(["PATH", "PI_SUBAGENTS_TEMP_ROOT", "PI_AGENT_DIR", "PI_CODING_AGENT_DIR", "TMPDIR",
    ...Object.keys(process.env).filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      && !["INVOCATION_ID", "SYSTEMD_EXEC_PID", "NOTIFY_SOCKET", "LISTEN_PID", "LISTEN_FDS"].includes(name))])];
  const managedCommands = ["-N", "set-option", "-g", "update-environment", environmentNames.join(" "), ";", ...commands.slice(2)];
  const created = await run(socketPath, managed ? managedCommands : commands);
  if (!created.ok) {
    // A duplicate-session race is the only expected failure to retry through
    // adoption; other failures refuse with the original create error.
    let exists = false;
    try {
      exists = await hasSession({ socketPath, sessionName }, { run });
    } catch {
      exists = false;
    }
    if (exists) return adoptExisting(socketPath, sessionName, assignmentId, expectedPane, run);
    throw tmuxFailure("start-session", created);
  }
  const owned = await resolveOwnedSession(socketPath, sessionName, run);
  if (serverIdentity) {
    const verified = await ensureTerminalHost(socketPath);
    if (verified.pid !== serverIdentity.pid || verified.started_at !== serverIdentity.started_at) {
      throw new Error("Terminal server changed during launch; inspect the reserved assignment before retrying.");
    }
    const { readFile } = await import("node:fs/promises");
    const paneGroup = await readFile(`/proc/${owned.panePid}/cgroup`, "utf8");
    const launcherGroup = await readFile("/proc/self/cgroup", "utf8");
    if (paneGroup === launcherGroup) throw new Error("Terminal pane still belongs to the launcher service.");
  }
  return { ...owned, ...(serverIdentity ? { serverIdentity } : {}) };
}

/**
 * Attach argv for the owned session: explicit socket, exact `=name` session
 * target, no shell and no session creation/kill options.
 * @param {{socketPath: string, sessionName: string}} input
 * @returns {string[]}
 */
export function attachArgs({ socketPath, sessionName } = {}) {
  assertAbsolutePath(socketPath, "socketPath");
  assertSessionName(sessionName);
  return ["-S", socketPath, "attach-session", "-t", `=${sessionName}`];
}

function terminalUnknown(reason) {
  return { status: "unknown", reason };
}

// `#{session_attached}` on a live session is a nonnegative client count. A
// missing field, a nondecimal token, a negative value or an unsafe integer is
// unknown, never zero: a parse failure must not claim that no client is
// attached.
function parseAttachedCount(value) {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!/^\d+$/.test(token)) return null;
  const count = Number(token);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

// Injected final boundaries may throw; normalize to the same result shape as
// runTmux so failure handling is uniform.
async function probeCommand(run, socketPath, args) {
  try {
    return await run(socketPath, args);
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error);
    return { ok: false, code: null, stdout: "", stderr: message, message };
  }
}

/**
 * Read-only terminal observation for one assignment record.
 *
 * The saved explicit socket and exact `=name` session are probed with
 * `has-session`; exit 1 is confirmed absence only while another read-only
 * `list-clients` shows the server is reachable, so an unreachable server or
 * any transport failure is `unknown`. On Linux, a refused socket connection
 * plus absence from the kernel socket inventory (and a dead saved server,
 * when recorded) can establish terminal absence. A reachable session proves ownership
 * only through the exact full assignment UUID in the
 * `@adjacent_assignment_id` user option; a missing or mismatched option is
 * `unknown` (never safe foreign adoption). The live pane must then resolve
 * through `display-message`, and when the record carries a saved `pane_id`
 * the observed pane must match it exactly.
 *
 * The default read-only query returns the exact two-field pane identity. With
 * `includeAttached: true` the same query also asks tmux for the session's
 * current client count: the opt-in present result adds `attached`, a
 * nonnegative safe integer, or null when the count is missing, malformed or
 * unsafe. The count is presence information only: it never grants control,
 * and an unparseable count stays unknown rather than becoming zero.
 *
 * @param {{tmux_socket?: string, tmux_session?: string, assignment_id?: string,
 *   pane_id?: string|null}} record
 * @param {{run?: (socketPath: string, args: string[]) => Promise<object>,
 *   includeAttached?: boolean}} [options]
 * @returns {Promise<{status: 'present', assignment_id: string, pane_id: string,
 *   pid: number, attached?: number|null} | {status: 'absent'}
 *   | {status: 'unknown', reason: string}>}
 */
export async function probeSession(record, { run = runTmux, includeAttached = false } = {}) {
  const socketPath = record?.tmux_socket;
  const sessionName = record?.tmux_session;
  const assignmentId = record?.assignment_id;
  if (typeof socketPath !== "string" || !isAbsolute(socketPath)) {
    return terminalUnknown("missing-socket");
  }
  if (typeof sessionName !== "string" || !SESSION_NAME_PATTERN.test(sessionName)) {
    return terminalUnknown("missing-session");
  }
  if (typeof assignmentId !== "string" || !UUID_PATTERN.test(assignmentId)) {
    return terminalUnknown("missing-assignment-id");
  }
  const savedPaneId = record.pane_id ?? null;
  if (savedPaneId !== null
    && (typeof savedPaneId !== "string" || !/^%\d+$/.test(savedPaneId))) {
    return terminalUnknown("invalid-saved-pane-id");
  }

  let exists;
  try {
    exists = await hasSession({ socketPath, sessionName }, { run });
  } catch (error) {
    if (run === runTmux && String(error?.message).startsWith("tmux server is unreachable:")
      && await terminalSocketAbsent(record, { inspect: inspectProcess })) return { status: "absent" };
    return terminalUnknown(error && error.message ? String(error.message) : "session-probe-failed");
  }
  if (!exists) return { status: "absent" };

  const tag = await probeCommand(run, socketPath, [
    "show-options",
    "-v",
    "-t",
    `=${sessionName}:`,
    "@adjacent_assignment_id",
  ]);
  if (!tag.ok) return terminalUnknown("assignment-id-option-unavailable");
  const recorded = typeof tag.stdout === "string" ? tag.stdout.trim() : "";
  if (recorded === "") return terminalUnknown("assignment-id-option-empty");
  if (recorded !== assignmentId) return terminalUnknown("assignment-id-mismatch");

  const pane = await probeCommand(run, socketPath, [
    "display-message",
    "-p",
    "-t",
    `=${sessionName}:`,
    includeAttached ? "#{pane_id} #{pane_pid} #{session_attached}" : "#{pane_id} #{pane_pid}",
  ]);
  if (!pane.ok) return terminalUnknown("pane-identity-unavailable");
  const paneText = typeof pane.stdout === "string" ? pane.stdout.trim() : "";
  // The default query keeps the exact two-field contract. The opt-in query
  // appends the current client count, and a missing or malformed field leaves
  // the count unknown while the exact UUID/pane/PID checks still decide
  // identity, so injected two-field fixtures stay usable.
  const match = includeAttached
    ? /^(%\d+)\s+(\d+)(?:\s+(.*))?$/.exec(paneText)
    : /^(%\d+)\s+(\d+)$/.exec(paneText);
  if (!match) return terminalUnknown("unexpected-pane-identity");
  const panePid = Number(match[2]);
  if (!Number.isSafeInteger(panePid) || panePid <= 0) {
    return terminalUnknown("invalid-pane-pid");
  }
  if (savedPaneId !== null && match[1] !== savedPaneId) {
    return terminalUnknown("pane-id-mismatch");
  }
  if (!includeAttached) {
    return { status: "present", assignment_id: assignmentId, pane_id: match[1], pid: panePid };
  }
  return {
    status: "present",
    assignment_id: assignmentId,
    pane_id: match[1],
    pid: panePid,
    attached: parseAttachedCount(match[3]),
  };
}

// Evaluated inside tmux's queue, not by the shell or an earlier probe.
export function terminalIdentityCondition(record) {
  if (!/^%\d+$/.test(record.pane_id ?? "")
    || !Number.isSafeInteger(record.pi_identity?.pid) || record.pi_identity.pid <= 0) return "0";
  return `#{&&:#{==:#{@adjacent_assignment_id},${record.assignment_id}},#{&&:#{==:#{pane_id},${record.pane_id}},#{==:#{pane_pid},${record.pi_identity.pid}}}}`;
}

/** Close only the exact, freshly verified recorded terminal. Never kill a server. */
export async function endSession(record,{run=runTmux}={}) {
  const observed=await probeSession(record,{run});
  if(observed.status!=='present'||observed.pid!==record.pi_identity?.pid
    ||observed.pane_id!==record.pane_id||!sameProcess(record.pi_identity)) {
    throw new Error('Session identity changed or is unavailable. Refresh before ending it.');
  }
  // Check the full UUID and pane again inside tmux's command queue. A session
  // replaced between the read-only probe and this command must survive.
  const condition=terminalIdentityCondition(record);
  const result=await run(record.tmux_socket,['if-shell','-F','-t',`=${record.tmux_session}:`,condition,
    `kill-session -t =${record.tmux_session}`,'display-message -p identity-changed']);
  if(!result.ok)throw tmuxFailure('end-session',result);
  if(result.stdout.trim())throw new Error('Session identity changed. No session was ended.');
  // A closed terminal alone is not proof that its process exited.
  const until=Date.now()+2000;
  while(Date.now()<until){
    const fresh=inspectProcess(record.pi_identity.pid);
    if(fresh.state==='dead'||(fresh.state==='alive'&&fresh.started_at!==record.pi_identity.started_at))return;
    if(fresh.state==='unknown')throw new Error('Terminal closed, but process exit could not be verified. Refresh to inspect its state.');
    await delay(25);
  }
  throw new Error('Terminal closed, but the agent process is still present. Refresh to inspect its state.');
}
