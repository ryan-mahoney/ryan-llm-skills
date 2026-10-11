// Final Pi substitution for step-4 launch integration.
//
// Records the exact argv, cwd and the sha256 of the consumed @snapshot bytes
// to ADJ4_FIXTURE_LOG, writes a valid Pi session header into the owned
// `--session-dir`, then stays alive until the test-owned ADJ4_FIXTURE_STOP
// file exists. No stdin listener: the process never consumes the shared
// terminal.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const logPath = process.env.ADJ4_FIXTURE_LOG;
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
    `${JSON.stringify({ pid: process.pid, argv, cwd: process.cwd(), snapshotSha256 })}\n`,
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

const stopPath = process.env.ADJ4_FIXTURE_STOP;
setInterval(() => {
  if (stopPath && existsSync(stopPath)) process.exit(0);
}, 100);
