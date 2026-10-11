// Isolated tmux transport adapter for Adjacent assignments.
//
// Node-standard-library only plus the shared adj2 PID/start-time observation.
// Every tmux invocation targets an explicit `-S socketPath` server with
// argument arrays (never a shell). Production code never signals or kills
// agents, never mutates the default tmux server and never writes tmux
// configuration.
//
// `startSession` bootstraps a fresh server in one command queue, runs the
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
// the bootstrap sets both, and the retained observables are
// `extended-keys on` and `extended-keys-format csi-u`.

import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { processIdentity, sameProcess } from "../spec-observe/process-identity.mjs";

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
async function serverReachable(socketPath) {
  const probe = await runTmux(socketPath, ["list-clients"]);
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
export async function hasSession({ socketPath, sessionName } = {}) {
  assertAbsolutePath(socketPath, "socketPath");
  assertSessionName(sessionName);
  const result = await runTmux(socketPath, ["has-session", "-t", `=${sessionName}`]);
  if (result.ok) return true;
  if (result.code === 1) {
    if (await serverReachable(socketPath)) return false;
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
export async function sessionPanePid({ socketPath, sessionName } = {}) {
  assertAbsolutePath(socketPath, "socketPath");
  assertSessionName(sessionName);
  if (!(await hasSession({ socketPath, sessionName }))) return null;
  const result = await runTmux(socketPath, [
    "display-message",
    "-p",
    "-t",
    `=${sessionName}:`,
    "#{pane_id} #{pane_pid}",
  ]);
  if (!result.ok) {
    // The session may have vanished after the has-session probe: re-check to
    // distinguish confirmed absence from a transport failure.
    if (!(await hasSession({ socketPath, sessionName }))) return null;
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

async function resolveOwnedSession(socketPath, sessionName) {
  const pane = await sessionPanePid({ socketPath, sessionName });
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
async function adoptExisting(socketPath, sessionName, assignmentId, expectedPane) {
  const tag = await runTmux(socketPath, [
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
  const current = await resolveOwnedSession(socketPath, sessionName);
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
 * One `-S socketPath` command queue bootstraps the server, enables extended
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
} = {}) {
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
    "set-option", "-s", "extended-keys-format", "csi-u", ";",
    "new-session", "-d", "-x", "200", "-y", "50", "-s", sessionName, "-c", escapeTmuxArg(cwd),
    "-e", `ADJACENT_ASSIGNMENT_ID=${assignmentId}`, "--", escapeTmuxArg(piPath), ...piArgs.map(escapeTmuxArg), ";",
    "set-option", "-t", `=${sessionName}:`, "@adjacent_assignment_id", assignmentId,
  ];
  const created = await runTmux(socketPath, commands);
  if (!created.ok) {
    // A duplicate-session race is the only expected failure to retry through
    // adoption; other failures refuse with the original create error.
    let exists = false;
    try {
      exists = await hasSession({ socketPath, sessionName });
    } catch {
      exists = false;
    }
    if (exists) return adoptExisting(socketPath, sessionName, assignmentId, expectedPane);
    throw tmuxFailure("start-session", created);
  }
  return resolveOwnedSession(socketPath, sessionName);
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
