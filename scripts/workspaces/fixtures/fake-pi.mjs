#!/usr/bin/env node
// Fake Pi process for isolated tmux adapter evidence.
//
// Records its exact command args (everything after the node executable, which
// equals the launched `piArgs` array), physical cwd, pid, ppid and timestamp
// as one JSON line in $FAKE_PI_LOG, prints READY, then stays alive until an
// explicit SIGTERM/SIGINT from test cleanup. No model, network or agent
// traffic is involved and production code never uses this fixture.

import { appendFileSync } from "node:fs";

const logPath = process.env.FAKE_PI_LOG;
if (typeof logPath !== "string" || logPath === "") {
  process.stderr.write("FAKE_PI_LOG must name a log file\n");
  process.exit(2);
}

const entry = {
  argv: process.argv.slice(1),
  cwd: process.cwd(),
  pid: process.pid,
  ppid: process.ppid,
  at: new Date().toISOString(),
};
appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
process.stdout.write("READY\n");

const keepAlive = setInterval(() => {}, 1 << 30);
function shutdown() {
  clearInterval(keepAlive);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
