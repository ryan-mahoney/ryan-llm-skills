#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

// Resolve locations only. Never copy, create, merge, or modify spec files.
try {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const executionRoot = realpathSync(git("rev-parse", "--show-toplevel"));
  const records = git("worktree", "list", "--porcelain", "-z").split("\0\0").filter(Boolean);
  const roots = records.map((record) => {
    const fields = record.split("\0");
    const location = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    return { location, bare: fields.includes("bare") };
  });
  const primary = roots[0];
  if (!primary?.location || primary.bare || !existsSync(primary.location)) {
    throw new Error("The primary repository checkout is unavailable; do not use a worktree spec copy.");
  }
  const repositoryRoot = realpathSync(primary.location);
  const specRoot = path.join(repositoryRoot, ".specs");
  const input = process.argv[2];
  let specPath;
  if (input) {
    let candidate = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input)
      ? path.join(executionRoot, ".specs", input)
      : input === ".specs" || input.startsWith(".specs/")
        ? path.resolve(executionRoot, input)
        : path.resolve(input);
    // Resolve aliases such as /var -> /private/var even for a not-yet-created file.
    let ancestor = candidate;
    while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    candidate = path.join(realpathSync(ancestor), path.relative(ancestor, candidate));
    for (const root of roots) {
      if (!root.location || !existsSync(root.location)) continue;
      const localSpecs = path.join(realpathSync(root.location), ".specs");
      const relative = path.relative(localSpecs, candidate);
      if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        specPath = path.join(specRoot, relative);
        break;
      }
    }
    if (!specPath) throw new Error("The spec path must be inside .specs of this repository or one of its registered worktrees.");
  }
  console.log(JSON.stringify({ executionRoot, repositoryRoot, specRoot, ...(specPath ? { specPath } : {}) }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
