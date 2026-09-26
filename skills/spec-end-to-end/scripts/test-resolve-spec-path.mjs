#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "canonical-specs-")));
const repo = path.join(sandbox, "main repo");
const worktree = path.join(sandbox, "code worktree");
const resolver = fileURLToPath(new URL("resolve-spec-path.mjs", import.meta.url));
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
let checks = 0;
try {
  await mkdir(path.join(repo, ".specs", "sample"), { recursive: true });
  await writeFile(path.join(repo, ".specs", "sample", "spec.md"), "Tracked original\n");
  git("init", "-q");
  git("add", ".specs");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Add fixture");
  git("worktree", "add", "-qb", "implementation", worktree);
  await writeFile(path.join(repo, ".specs", "sample", "spec.md"), "Canonical updated spec\n");
  await writeFile(path.join(worktree, ".specs", "sample", "spec.md"), "Diverged worktree copy\n");
  await mkdir(path.join(worktree, "src"));
  const resolve = (cwd, input, suffix) => {
    const result = spawnSync(process.execPath, [resolver, ...(input ? [input] : [])], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.repositoryRoot, repo);
    assert.equal(value.executionRoot, cwd === repo ? repo : worktree);
    assert.equal(value.specRoot, path.join(repo, ".specs"));
    assert.equal(value.specPath, suffix === undefined ? undefined : path.join(repo, ".specs", suffix));
    checks++;
    return value;
  };
  resolve(repo);
  resolve(worktree);
  resolve(worktree, "sample", "sample");
  resolve(worktree, ".specs/project-context.md", "project-context.md");
  const alias = path.join(sandbox, "checkout alias");
  await symlink(worktree, alias, "dir");
  resolve(worktree, path.join(alias, ".specs/new-feature/spec.md"), "new-feature/spec.md");
  resolve(path.join(worktree, "src"), ".specs/sample/spec.md", "sample/spec.md");
  resolve(path.join(worktree, "src"), "../.specs/sample/spec.md", "sample/spec.md");
  resolve(worktree, path.join(worktree, ".specs/sample/spec.md"), "sample/spec.md");
  const resolved = resolve(worktree, path.join(repo, ".specs/sample/spec.md"), "sample/spec.md");
  assert.equal(await readFile(resolved.specPath, "utf8"), "Canonical updated spec\n");
  await writeFile(resolved.specPath, "Updated through resolved path\n");
  assert.equal(await readFile(path.join(worktree, ".specs/sample/spec.md"), "utf8"), "Diverged worktree copy\n");
  resolve(worktree, ".specs/new-feature/proposal.md", "new-feature/proposal.md");
  await rm(path.join(worktree, ".specs"), { recursive: true });
  resolve(worktree, ".specs/sample/spec.md", "sample/spec.md");
  for (const input of [path.join(sandbox, ".specs/foreign/spec.md"), ".specs/../../outside.md"]) {
    const result = spawnSync(process.execPath, [resolver, input], { cwd: worktree, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    checks++;
  }
  console.log(`spec paths: ${checks} checks passed`);
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
