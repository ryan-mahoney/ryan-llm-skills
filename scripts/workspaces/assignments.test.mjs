// Step 1 focused tests: assignment resolution contracts.
//
// Every fixture root is realpath(mkdtemp(tmpdir())) with real `git init`
// repositories, kit.yaml fixtures, brief files, fake HOME skills and a fake
// pi executable. Resolution is read-only, so each test asserts the
// assignments/, sessions/ and .sentinel paths stay absent. Git child
// processes are bounded by a finite deadline.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveAssignment, resolveTarget } from "./assignments.mjs";
import { fetchWorkspace } from "./store.mjs";

const GIT_TIMEOUT_MS = 10000;

function git(cwd, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

async function tempRoot(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "adj4-assignments-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function makeRepo(directory, remote = null) {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "--quiet"]);
  if (remote !== null) await git(directory, ["remote", "add", "origin", remote]);
  return realpath(directory);
}

function kitYaml({ id, name, repositories }) {
  const lines = [
    "version: 1",
    `id: ${JSON.stringify(id)}`,
    `name: ${JSON.stringify(name)}`,
  ];
  if (repositories.length === 0) {
    lines.push("repositories: []");
  } else {
    lines.push("repositories:");
    for (const repository of repositories) {
      lines.push(`  - id: ${JSON.stringify(repository.id)}`);
      lines.push(`    path: ${JSON.stringify(repository.path)}`);
      if (repository.remote !== undefined && repository.remote !== null) {
        lines.push(`    remote: ${JSON.stringify(repository.remote)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

async function fakePi(directory) {
  await mkdir(directory, { recursive: true });
  const piPath = join(directory, "pi");
  await writeFile(piPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(piPath, 0o755);
  return realpath(piPath);
}

async function writeSkill(home, name, content = "# Demo skill\n") {
  const directory = join(home, ".agents", "skills", name);
  await mkdir(directory, { recursive: true });
  const skillPath = join(directory, "SKILL.md");
  await writeFile(skillPath, content);
  return realpath(skillPath);
}

async function assertNoWrites(workspaceDirectory, storageRoot) {
  await assert.rejects(lstat(join(workspaceDirectory, "assignments")), { code: "ENOENT" });
  await assert.rejects(lstat(join(workspaceDirectory, "sessions")), { code: "ENOENT" });
  await assert.rejects(lstat(join(storageRoot, ".sentinel")), { code: "ENOENT" });
}

async function briefFixture(workspaceDirectory, bytes) {
  const briefDirectory = join(workspaceDirectory, "briefs");
  await mkdir(briefDirectory, { recursive: true });
  await writeFile(join(briefDirectory, "brief.md"), bytes);
}

test("assignment resolution preserves directory mismatch and registered worktree remote attention", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  const workspaceDirectory = join(storageRoot, "projects", "wrong-directory");
  await mkdir(workspaceDirectory, { recursive: true });

  // Primary checkout with a distinct origin plus a registered linked worktree.
  const primary = join(root, "repos", "primary");
  await makeRepo(primary, "https://example.com/actual.git");
  await git(primary, ["commit", "--allow-empty", "-m", "init"]);
  const worktreePath = join(root, "repos", "linked");
  await git(primary, ["worktree", "add", "--quiet", worktreePath]);
  const linkedPhysical = await realpath(worktreePath);

  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: "linked-workspace",
    name: "Linked Workspace",
    repositories: [{
      id: "linked",
      path: linkedPhysical,
      remote: "https://example.com/expected.git",
    }],
  }));

  const workspace = await fetchWorkspace(storageRoot, "linked-workspace");
  assert.ok(workspace.attention.includes("directory_mismatch"));

  const resolved = await resolveTarget({ workspace, target: "linked" });
  assert.equal(resolved.execution_dir, linkedPhysical);
  assert.equal(resolved.repository_id, "linked");
  assert.equal(resolved.spec_package, null);
  assert.ok(resolved.attention.includes("directory_mismatch"));
  assert.ok(resolved.attention.includes("remote_mismatch"));

  await assertNoWrites(workspaceDirectory, storageRoot);
});

test("assignment resolution validates supplied spec package against repository common dir", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  const workspaceDirectory = join(storageRoot, "projects", "package-workspace");
  await mkdir(workspaceDirectory, { recursive: true });

  const primary = join(root, "repos", "primary");
  await makeRepo(primary);
  await git(primary, ["commit", "--allow-empty", "-m", "init"]);
  const worktreePath = join(root, "repos", "linked");
  await git(primary, ["worktree", "add", "--quiet", worktreePath]);
  const linkedPhysical = await realpath(worktreePath);

  const packageDirectory = join(primary, ".specs", "feature");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "spec.md"), "# Feature\n");

  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: "package-workspace",
    name: "Package Workspace",
    repositories: [{ id: "linked", path: linkedPhysical }],
  }));

  const workspace = await fetchWorkspace(storageRoot, "package-workspace");

  // The package lives in the primary checkout of the worktree's repository.
  const accepted = await resolveTarget({
    workspace,
    target: "linked",
    specPackage: join(packageDirectory, "spec.md"),
  });
  assert.equal(accepted.spec_package, await realpath(packageDirectory));

  // A package from a different repository refuses.
  const secondary = join(root, "repos", "secondary");
  await makeRepo(secondary);
  const secondaryPackage = join(secondary, ".specs", "other");
  await mkdir(secondaryPackage, { recursive: true });
  await writeFile(join(secondaryPackage, "spec.md"), "# Other\n");
  await assert.rejects(
    resolveTarget({ workspace, target: "linked", specPackage: join(secondaryPackage, "spec.md") }),
    /different repository/,
  );

  // Without a repository target the workspace directory is not a Git checkout.
  await assert.rejects(
    resolveTarget({ workspace, target: null, specPackage: join(packageDirectory, "spec.md") }),
    /Git repository execution directory/,
  );

  await assertNoWrites(workspaceDirectory, storageRoot);
});

test("assignment resolution refuses missing not_git invalid UUID and skill escape without writes", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  const workspaceDirectory = join(storageRoot, "projects", "refusal-workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const home = join(root, "home");
  await mkdir(home, { recursive: true });

  const missingPath = join(root, "repos", "missing");
  const plainPath = join(root, "repos", "plain");
  await mkdir(plainPath, { recursive: true });
  await writeFile(join(plainPath, "README"), "not a repository\n");
  const appPath = await makeRepo(join(root, "repos", "app"));
  const piPath = await fakePi(join(root, "bin"));

  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: "refusal-workspace",
    name: "Refusal Workspace",
    repositories: [
      { id: "missing", path: missingPath },
      { id: "plain", path: plainPath },
      { id: "app", path: appPath },
    ],
  }));
  await briefFixture(workspaceDirectory, "Brief bytes.\n");
  const kitBefore = await readFile(join(workspaceDirectory, "kit.yaml"));

  const workspace = await fetchWorkspace(storageRoot, "refusal-workspace");
  await assert.rejects(resolveTarget({ workspace, target: "missing" }), /not usable/);
  await assert.rejects(resolveTarget({ workspace, target: "plain" }), /not usable/);
  await assert.rejects(resolveTarget({ workspace, target: "absent" }), /not available/);

  const base = {
    assignment_id: randomUUID(),
    workspace_id: "refusal-workspace",
    storageRoot,
    home,
    brief: "briefs/brief.md",
    instructions: "Do nothing.",
    target: "app",
    pi_path: piPath,
  };

  await assert.rejects(resolveAssignment({ ...base, assignment_id: "not-a-uuid" }), /UUID/);
  await assert.rejects(resolveAssignment({ ...base, supersedes: "not-a-uuid" }), /UUID/);
  await assert.rejects(resolveAssignment({ ...base, supersedes: randomUUID() }), /must not supersede/);
  await assert.rejects(resolveAssignment({ ...base, attempt_kind: "launch-retry" }), /requires supersedes/);
  await assert.rejects(
    resolveAssignment({ ...base, attempt_kind: "launch-retry", supersedes: base.assignment_id }),
    /different assignment/,
  );
  await assert.rejects(resolveAssignment({ ...base, skill: "../escape" }), /invalid skill name/);
  await assert.rejects(resolveAssignment({ ...base, skill: "foo/bar" }), /invalid skill name/);
  await assert.rejects(resolveAssignment({ ...base, skill: "missing-skill" }), /does not exist/);

  // A symlinked SKILL.md is refused instead of followed.
  const realSkill = join(home, ".agents", "skills", "linked", "real-SKILL.md");
  await mkdir(join(home, ".agents", "skills", "linked"), { recursive: true });
  await writeFile(realSkill, "# Real\n");
  await symlink(realSkill, join(home, ".agents", "skills", "linked", "SKILL.md"));
  await assert.rejects(resolveAssignment({ ...base, skill: "linked" }), /must not be a symlink/);

  await assert.rejects(resolveAssignment({ ...base, brief: "" }), /brief/);
  await assert.rejects(resolveAssignment({ ...base, instructions: "" }), /instructions/);
  await assert.rejects(
    resolveAssignment({ ...base, publication_authority: "merge" }),
    /publication_authority/,
  );

  assert.deepEqual(await readFile(join(workspaceDirectory, "kit.yaml")), kitBefore);
  await assertNoWrites(workspaceDirectory, storageRoot);
});

test("assignment resolution fixes digest for known brief bytes and tracks socket model authority", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  const workspaceDirectory = join(storageRoot, "projects", "digest-workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const appPath = await makeRepo(join(root, "repos", "app"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const piPath = await fakePi(join(root, "bin"));
  const briefBytes = Buffer.from("Approved brief bytes.\n", "utf8");
  await briefFixture(workspaceDirectory, briefBytes);

  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: "digest-workspace",
    name: "Digest Workspace",
    repositories: [{ id: "app", path: appPath }],
  }));

  const id = randomUUID();
  const input = {
    assignment_id: id,
    workspace_id: "digest-workspace",
    storageRoot,
    home,
    brief: "briefs/brief.md",
    skill: "general",
    instructions: "Implement the approved change.",
    target: "app",
    publication_authority: "none",
    attempt_kind: "initial",
    pi_path: piPath,
  };

  const first = await resolveAssignment(input);
  const second = await resolveAssignment(input);

  assert.equal(first.contractDigest, second.contractDigest);
  assert.equal(first.record.contract_digest, first.contractDigest);
  assert.notEqual(first.record.launch_token, second.record.launch_token);
  assert.deepEqual(first.briefBytes, briefBytes);
  assert.equal(first.record.brief_sha256, createHash("sha256").update(briefBytes).digest("hex"));
  assert.equal(first.record.schema_version, 1);
  assert.equal(first.record.state, "preview");
  assert.equal(first.record.pi_session_file, null);
  assert.equal(first.record.launcher_identity, null);
  assert.equal(first.record.tmux_socket, "adjacent");
  assert.equal(first.record.repository_id, "app");

  const storagePhysical = await realpath(storageRoot);
  const workspacePhysical = (await fetchWorkspace(storageRoot, "digest-workspace")).directory;
  const appPhysical = await realpath(appPath);
  assert.equal(first.record.execution_dir, appPhysical);
  assert.equal(first.record.coordination_database, join(storagePhysical, ".sentinel", "coordination.sqlite"));
  assert.equal(first.record.pi_session_dir, join(workspacePhysical, "sessions", id));
  assert.equal(
    first.record.brief_snapshot,
    join(workspacePhysical, "assignments", `${id}.brief.md`),
  );

  // Independent fixed-order digest over the known bytes and effective fields.
  const expectedCanonical = [
    "digest-workspace",
    storagePhysical,
    workspacePhysical,
    "briefs/brief.md",
    first.record.brief_sha256,
    "general",
    null,
    "Implement the approved change.",
    null,
    null,
    null,
    null,
    appPhysical,
    "app",
    null,
    null,
    "none",
    "initial",
    null,
    piPath,
    "adjacent",
    `adj-${id.replace(/-/g, "").slice(0, 12)}`,
    join(storagePhysical, ".sentinel", "coordination.sqlite"),
    join(workspacePhysical, "sessions", id),
  ];
  assert.equal(
    first.contractDigest,
    createHash("sha256").update(JSON.stringify(expectedCanonical)).digest("hex"),
  );

  const socketChanged = await resolveAssignment({ ...input, tmux_socket: "adjacent-test" });
  assert.notEqual(socketChanged.contractDigest, first.contractDigest);

  const modelChanged = await resolveAssignment({
    ...input,
    provider: "test-provider",
    model: "test-model",
    thinking: "medium",
  });
  assert.notEqual(modelChanged.contractDigest, first.contractDigest);
  assert.ok(modelChanged.piArgs.includes("--provider") && modelChanged.piArgs.includes("test-provider"));
  assert.ok(modelChanged.piArgs.includes("--model") && modelChanged.piArgs.includes("test-model"));
  assert.ok(modelChanged.piArgs.includes("--thinking") && modelChanged.piArgs.includes("medium"));

  const authorityChanged = await resolveAssignment({ ...input, publication_authority: "pr" });
  assert.notEqual(authorityChanged.contractDigest, first.contractDigest);
  assert.ok(
    authorityChanged.piArgs[authorityChanged.piArgs.length - 1]
      .includes("Publication authority: pr (grants no merge/deploy)."),
  );

  const trustChanged = await resolveAssignment({ ...input, project_trust: "never" });
  assert.notEqual(trustChanged.contractDigest, first.contractDigest);
  assert.ok(trustChanged.piArgs.includes("--no-approve"));

  await assertNoWrites(workspaceDirectory, storageRoot);
});

test("assignment resolution delivers plain skill path and @snapshot without /skill expansion", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  const workspaceDirectory = join(storageRoot, "projects", "skill-workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const appPath = await makeRepo(join(root, "repos", "app"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const skillPath = await writeSkill(home, "demo");
  const piPath = await fakePi(join(root, "bin"));
  await briefFixture(workspaceDirectory, "Skill brief bytes.\n");

  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: "skill-workspace",
    name: "Skill Workspace",
    repositories: [{ id: "app", path: appPath }],
  }));

  const id = randomUUID();
  const input = {
    assignment_id: id,
    workspace_id: "skill-workspace",
    storageRoot,
    home,
    brief: "briefs/brief.md",
    skill: "demo",
    instructions: "Apply the demo skill.",
    target: "app",
    pi_path: piPath,
  };

  // The effective executable is resolved physically from PATH when pi_path is
  // not supplied; prepend the fixture bin so git stays visible to fetchWorkspace.
  const originalPath = process.env.PATH;
  process.env.PATH = `${join(root, "bin")}${delimiter}${originalPath ?? ""}`;
  let fromPath;
  try {
    fromPath = await resolveAssignment({ ...input, pi_path: undefined });
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(fromPath.record.pi_path, piPath);

  const resolved = await resolveAssignment(input);
  assert.equal(resolved.record.skill, "demo");
  assert.equal(resolved.record.skill_path, skillPath);

  const workspacePhysical = (await fetchWorkspace(storageRoot, "skill-workspace")).directory;
  const appPhysical = await realpath(appPath);
  const snapshotArg = `@${join(workspacePhysical, "assignments", `${id}.brief.md`)}`;
  assert.ok(resolved.piArgs.includes(snapshotArg));
  assert.ok(resolved.piArgs.includes("--session-dir"));
  assert.ok(resolved.piArgs.includes(join(workspacePhysical, "sessions", id)));
  assert.ok(resolved.piArgs.includes("--session-id") && resolved.piArgs.includes(id));
  assert.ok(resolved.piArgs.includes("--name") && resolved.piArgs.includes("skill-workspace:Skill Workspace"));

  const instruction = resolved.piArgs[resolved.piArgs.length - 1];
  assert.ok(instruction.startsWith(
    `Read the skill at ${skillPath} and perform its instructions for this request.\n\n`,
  ));
  assert.ok(instruction.includes("Apply the demo skill."));
  assert.ok(instruction.includes(
    `Assignment ${id} workspace skill-workspace dir ${appPhysical}. ` +
      "Publication authority: none (grants no merge/deploy).",
  ));
  // The @file prefix must not be a skill-expansion command.
  assert.ok(!instruction.includes("/skill:"));
  assert.ok(!instruction.split("\n").some((line) => line.trimStart().startsWith("/skill")));
  for (const arg of resolved.piArgs) assert.ok(!arg.startsWith("/skill"));

  const general = await resolveAssignment({ ...input, skill: "general" });
  assert.equal(general.record.skill_path, null);
  assert.ok(!general.piArgs[general.piArgs.length - 1].includes("Read the skill"));

  await assertNoWrites(workspaceDirectory, storageRoot);
});
