// Final Pi substitution for step-4 launch integration.
//
// Records the exact argv, cwd and the sha256 of the consumed @snapshot bytes
// to ADJ4_FIXTURE_LOG, writes a valid Pi session header into the owned
// `--session-dir`, then stays alive until the test-owned ADJ4_FIXTURE_STOP
// file exists. Without ADJ4_TERMINAL_PROBE_DIR there is no stdin listener:
// the process never consumes the shared terminal. With that opt-in directory
// set, the process instead prints INITIAL_TERMINAL_MARKER, records consumed
// stdin bytes to its own input.log, and prints LATER_TERMINAL_MARKER exactly
// once after the test-owned later-output.trigger file appears. Probe output
// files are written only inside that owned directory.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const logPath = process.env.ADJ4_FIXTURE_LOG;
const probeDir = process.env.ADJ4_TERMINAL_PROBE_DIR;
const argv = process.argv.slice(2);
let snapshotSha256 = null;
const snapshotArg = argv.find((argument) => argument.startsWith("@"));
if (snapshotArg && snapshotArg.length > 1) {
  try {
    snapshotSha256 = createHash("sha256").update(readFileSync(snapshotArg.slice(1))).digest("hex");
  } catch {
    snapshotSha256 = null;
  }
}
if (logPath) {
  appendFileSync(
    logPath,
    `${JSON.stringify({
      pid: process.pid,
      argv,
      cwd: process.cwd(),
      snapshotSha256,
      ...(probeDir ? { probeDir } : {}),
    })}\n`,
  );
}

const dirIndex = argv.indexOf("--session-dir");
const idIndex = argv.indexOf("--session-id");
if (dirIndex !== -1 && idIndex !== -1) {
  const dir = argv[dirIndex + 1];
  const id = argv[idIndex + 1];
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(
      join(dir, `${stamp}_${id}.jsonl`),
      `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
    );
  } catch {
    // Header publication is best-effort; the argv/snapshot log remains the oracle.
  }
}

let laterMarkerEmitted = false;
if (probeDir) {
  mkdirSync(probeDir, { recursive: true });
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    // Raw mode delivers each sent byte to the observer immediately instead of
    // waiting for a newline; the probe owns stdin only in this opt-in mode.
    process.stdin.setRawMode(true);
  }
  process.stdout.write("INITIAL_TERMINAL_MARKER\r\n");
  process.stdin.on("data", (chunk) => {
    try {
      appendFileSync(join(probeDir, "input.log"), chunk);
    } catch {
      // Input observation is best-effort; tmux read-only enforcement remains the oracle.
    }
  });
}

const stopPath = process.env.ADJ4_FIXTURE_STOP;
setInterval(() => {
  if (probeDir && !laterMarkerEmitted && existsSync(join(probeDir, "later-output.trigger"))) {
    laterMarkerEmitted = true;
    process.stdout.write("LATER_TERMINAL_MARKER\r\n");
  }
  if (stopPath && existsSync(stopPath)) process.exit(0);
}, 100);
