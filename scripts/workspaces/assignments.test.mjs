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
import { createRequire } from "node:module";
import { homedir, hostname, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { newPackage } from "../spec-location/index.mjs";
import { launchAssignment, prepareAssignmentSpecTarget, resolveAssignment, resolveTarget } from "./assignments.mjs";
import { fetchWorkspace } from "./store.mjs";
import { createReferenceCatalog } from "./references.mjs";

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
  // Spec worktree preparation branches from HEAD, so the fixture needs one commit.
  await git(directory, ["commit", "--quiet", "--allow-empty", "-m", "init"]);
  if (remote !== null) await git(directory, ["remote", "add", "origin", remote]);
  return realpath(directory);
}

function kitYaml({ id, name, repositories, executionHost = null }) {
  const lines = [
    "version: 1",
    `id: ${JSON.stringify(id)}`,
    `name: ${JSON.stringify(name)}`,
  ];
  if (executionHost !== null) lines.push(`execution_host: ${JSON.stringify(executionHost)}`);
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

// Hand-written expected context block (no package, or an explicit package
// line) so assertions never derive from the production builder.
function expectedPrompt({
  id, wsName, wsId, wsDir, execDir, repo = "app", briefFile = "brief.md", snapshot, pi,
  request, authority = "none", meaning = "This launch grants no push or pull request.",
  packageLine = "- Spec package: none.", extra = [],
}) {
  return [
    "Assignment context",
    `- Assignment: ${id}. Its record is ${wsDir}/assignments/${id}.json; read it again if you lose earlier context.`,
    `- Workspace: ${wsName} (${wsId}) at ${wsDir}. Workspace storage holds the kit, briefs, spec packages and sessions; code changes belong in the working directory.`,
    `- Working directory: ${execDir} (repository ${repo} checkout).`,
    packageLine,
    `- Brief: ${wsDir}/briefs/${briefFile}. ` + (pi
      ? `The launch copy is attached above (${snapshot}); edit the source, not the copy.`
      : `Read the launch copy at ${snapshot}; edit the source, not the copy.`),
    `- Publication authority: ${authority}. ${meaning} Merge and deployment are allowed only when the request grants them.`,
    ...extra,
  ].join("\n") + `\n\nRequest\n${request}`;
}

// Resolve the installed Pi dist for tests that exercise its argv parser.
// Mirrors scripts/workspaces/references.mjs: the managed install under
// PI_MANAGED_INSTALL_ROOT or ~/.pi/agent/install/current-version, require
// resolution, a PATH-discovered pi launcher, common global prefixes and the
// running Node's sibling lib. Returns null when nothing usable is installed
// so callers can skip only the Pi-parse assertions.
async function resolveInstalledPiDist() {
  const candidates = [];
  try {
    const require = createRequire(import.meta.url);
    candidates.push(join(dirname(require.resolve("@earendil-works/pi-coding-agent")), "dist"));
  } catch {}
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const install = process.env.PI_MANAGED_INSTALL_ROOT ?? join(agentDir, "install");
    const version = (await readFile(join(install, "current-version"), "utf8")).trim();
    if (/^[a-zA-Z0-9._+-]+$/.test(version)) {
      candidates.unshift(join(
        install,
        "releases",
        version,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
      ));
    }
  } catch {}
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      let parent = dirname(await realpath(join(dir, "pi")));
      for (let i = 0; i < 4; i += 1, parent = dirname(parent)) {
        candidates.push(
          join(parent, "node_modules", "@earendil-works", "pi-coding-agent", "dist"),
        );
      }
    } catch {}
  }
  for (const prefix of ["/opt/homebrew/lib", "/usr/local/lib", "/usr/lib"]) {
    candidates.push(join(prefix, "node_modules", "@earendil-works", "pi-coding-agent", "dist"));
  }
  candidates.push(join(
    dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
  ));
  for (const candidate of [...new Set(candidates)]) {
    try {
      await readFile(join(candidate, "cli", "args.js"));
      await readFile(join(candidate, "cli", "initial-message.js"));
      return candidate;
    } catch {}
  }
  return null;
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

  // The approved record carries the same deduplicated target attention: the
  // workspace-level and repository-level remote_mismatch merge to one entry.
  await briefFixture(workspaceDirectory, "Linked brief bytes.\n");
  const piPath = await fakePi(join(root, "bin"));
  const assignmentId = randomUUID();
  const assignment = await resolveAssignment({
    assignment_id: assignmentId,
    workspace_id: "linked-workspace",
    storageRoot,
    brief: "briefs/brief.md",
    skill: "general",
    instructions: "Do the linked work.",
    target: "linked",
    pi_path: piPath,
  });
  assert.deepEqual(
    [...assignment.record.attention].sort(),
    ["directory_mismatch", "remote_mismatch"],
  );

  await assertNoWrites(workspaceDirectory, storageRoot);
});

test("assignment resolution validates supplied spec package against the package targets", async (t) => {
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
  const secondary = join(root, "repos", "secondary");
  await makeRepo(secondary);

  const executionHost = hostname().split(".")[0].toLowerCase();
  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: "package-workspace",
    name: "Package Workspace",
    executionHost,
    repositories: [{ id: "linked", path: linkedPhysical }, { id: "secondary", path: secondary }],
  }));
  const created = await newPackage({
    workspace: "package-workspace",
    slug: "feature",
    targets: [{ id: "linked" }],
    root: storageRoot,
  });
  assert.equal(created.ok, true);
  const packageDirectory = created.locations.package_dir;
  await writeFile(join(packageDirectory, "spec.md"), "# Feature\n");

  const workspace = await fetchWorkspace(storageRoot, "package-workspace");

  // The package lives in the storage root; a package file or reference resolves to it.
  for (const specPackage of [join(packageDirectory, "spec.md"), "package-workspace/feature"]) {
    const accepted = await resolveTarget({ workspace, target: "linked", specPackage });
    assert.equal(accepted.spec_package, packageDirectory);
    assert.equal(accepted.package_ref, "package-workspace/feature");
  }

  // A repository the package does not target refuses.
  await assert.rejects(
    resolveTarget({ workspace, target: "secondary", specPackage: packageDirectory }),
    /not a target worktree or primary checkout/,
  );

  // Without a repository target the workspace directory is not a package target.
  await assert.rejects(
    resolveTarget({ workspace, target: null, specPackage: packageDirectory }),
    /not a target worktree or primary checkout/,
  );

  // A legacy package inside a checkout refuses with the migration remedy.
  const legacy = join(primary, ".specs", "old");
  await mkdir(legacy, { recursive: true });
  await assert.rejects(
    resolveTarget({ workspace, target: "linked", specPackage: legacy }),
    /migrate/,
  );
  await rm(join(primary, ".specs"), { recursive: true, force: true });

  // Synced paths from another machine need a typed, recoverable refusal.
  const locationsFile = join(packageDirectory, 'locations.json');
  const locations = JSON.parse(await readFile(locationsFile, 'utf8'));
  await writeFile(locationsFile, JSON.stringify({ ...locations, storage_root: join(storageRoot, 'missing-host-root') }));
  await assert.rejects(resolveTarget({ workspace, target: 'linked', specPackage: packageDirectory }),
    { code: 'spec-package-unavailable' });

  await assertNoWrites(workspaceDirectory, storageRoot);
});

test("assignment context names the spec package and its first command, or states none", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  const workspaceDirectory = join(storageRoot, "projects", "context-workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const appPath = await makeRepo(join(root, "repos", "app"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const piPath = await fakePi(join(root, "bin"));
  await briefFixture(workspaceDirectory, "Context brief.\n");
  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: "context-workspace",
    name: "Context Workspace",
    executionHost: hostname().split(".")[0].toLowerCase(),
    repositories: [{ id: "app", path: appPath }],
  }));
  const created = await newPackage({
    workspace: "context-workspace",
    slug: "feature",
    targets: [{ id: "app" }],
    root: storageRoot,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const packageDirectory = created.locations.package_dir;

  const workspacePhysical = (await fetchWorkspace(storageRoot, "context-workspace")).directory;
  // Resolution reads the prepared package worktree, as the dashboard's preview does.
  await prepareAssignmentSpecTarget({ storageRoot, workspace_id: "context-workspace", target: "app", specPackage: packageDirectory });
  const base = {
    workspace_id: "context-workspace",
    storageRoot,
    home,
    brief: "briefs/brief.md",
    skill: "general",
    instructions: "Do the work.",
    target: "app",
    pi_path: piPath,
  };

  const withPackage = await resolveAssignment({
    ...base, assignment_id: randomUUID(), specPackage: packageDirectory, publication_authority: "draft-pr",
  });
  const prompt = withPackage.piArgs[withPackage.piArgs.length - 1];
  assert.ok(prompt.startsWith("Assignment context\n"));
  assert.ok(prompt.includes(
    `- Spec package: context-workspace/feature at ${packageDirectory}. ` +
      `First run \`node ${join(home, ".agents", "scripts", "spec-location", "cli.mjs")} check context-workspace/feature\``,
  ));
  assert.ok(prompt.includes("- Publication authority: draft-pr. You may push the branch and open a draft pull request."));
  assert.ok(prompt.indexOf("Assignment context") < prompt.indexOf("Request\nPerform this request:"));
  assert.equal(withPackage.inputPreview.instruction, prompt);

  const supersededId = randomUUID();
  const withoutPackage = await resolveAssignment({
    ...base, assignment_id: randomUUID(), workflow_id: "wf-1", attempt_kind: "launch-retry", supersedes: supersededId,
  });
  const bare = withoutPackage.piArgs[withoutPackage.piArgs.length - 1];
  assert.ok(bare.includes("- Spec package: none.\n"));
  assert.ok(!bare.includes("grants no merge"));
  assert.ok(bare.includes(`\n- Workflow: wf-1.\n- Retries assignment ${supersededId}.\n\nRequest\n`));
  assert.ok(bare.includes(`- Brief: ${workspacePhysical}/briefs/brief.md.`));

  // Resolution itself publishes nothing; only the explicit preparation above
  // held the root claim (which creates .sentinel) and the worktree.
  await assert.rejects(lstat(join(workspaceDirectory, "assignments")), { code: "ENOENT" });
  await assert.rejects(lstat(join(workspaceDirectory, "sessions")), { code: "ENOENT" });
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
  assert.equal(first.record.harness, "pi");
  assert.equal(first.record.state, "preview");
  assert.equal(first.record.pi_session_file, null);
  assert.equal(first.record.launcher_identity, null);
  assert.equal(first.record.repository_id, "app");

  const storagePhysical = await realpath(storageRoot);
  assert.equal(first.record.tmux_socket, join(storagePhysical, ".sentinel", "adjacent.sock"));
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
    null,
    "none",
    "initial",
    null,
    piPath,
    join(storagePhysical, ".sentinel", "adjacent.sock"),
    `adj-${id.replace(/-/g, "").slice(0, 12)}`,
    join(storagePhysical, ".sentinel", "coordination.sqlite"),
    join(workspacePhysical, "sessions", id),
    "pi",
  ];
  assert.equal(
    first.contractDigest,
    createHash("sha256").update(JSON.stringify(expectedCanonical)).digest("hex"),
  );

  const explicitSocket = join(storagePhysical, "sockets", "custom.sock");
  const socketChanged = await resolveAssignment({ ...input, tmux_socket: explicitSocket });
  assert.notEqual(socketChanged.contractDigest, first.contractDigest);
  assert.equal(socketChanged.record.tmux_socket, explicitSocket);
  await assert.rejects(
    resolveAssignment({ ...input, tmux_socket: "relative.sock" }),
    /absolute/,
  );

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
      .includes(
        "- Publication authority: pr. You may push the branch and open a pull request ready for review. " +
          "Merge and deployment are allowed only when the request grants them.",
      ),
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
  assert.equal(instruction, expectedPrompt({
    id,
    wsName: "Skill Workspace",
    wsId: "skill-workspace",
    wsDir: workspacePhysical,
    execDir: appPhysical,
    snapshot: join(workspacePhysical, "assignments", `${id}.brief.md`),
    pi: true,
    request: `Read the skill at ${skillPath} and perform its instructions for this request.\n\nApply the demo skill.`,
  }));
  // The @file prefix must not be a skill-expansion command.
  assert.ok(!instruction.includes("/skill:"));
  assert.ok(!instruction.split("\n").some((line) => line.trimStart().startsWith("/skill")));
  for (const arg of resolved.piArgs) assert.ok(!arg.startsWith("/skill"));

  const general = await resolveAssignment({ ...input, skill: "general" });
  assert.equal(general.record.skill_path, null);
  assert.ok(!general.piArgs[general.piArgs.length - 1].includes("Read the skill"));

  await assertNoWrites(workspaceDirectory, storageRoot);
});

test("assignment resolution refuses coordination override and invalid thinking without writes", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  const workspaceDirectory = join(storageRoot, "projects", "guard-workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const appPath = await makeRepo(join(root, "repos", "app"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const piPath = await fakePi(join(root, "bin"));
  await briefFixture(workspaceDirectory, "Guard brief bytes.\n");

  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: "guard-workspace",
    name: "Guard Workspace",
    repositories: [{ id: "app", path: appPath }],
  }));

  const base = {
    assignment_id: randomUUID(),
    workspace_id: "guard-workspace",
    storageRoot,
    home,
    brief: "briefs/brief.md",
    skill: "general",
    instructions: "Do the guarded thing.",
    target: "app",
    pi_path: piPath,
  };

  // A caller-supplied coordination database would split the single
  // root-wide coordination domain, so it must fail visibly.
  await assert.rejects(
    resolveAssignment({ ...base, coordination_database: join(root, "other.sqlite") }),
    /must not be supplied/,
  );

  // Pi omits an invalid --thinking level with a warning and executes with
  // another effective setting, so the preview must refuse it instead.
  await assert.rejects(
    resolveAssignment({ ...base, provider: "test-provider", model: "test-model", thinking: "bogus" }),
    /invalid thinking level/,
  );

  // A model-embedded thinking suffix plus an explicit --thinking flag leaves
  // Pi precedence to decide silently; refuse the conflict visibly.
  await assert.rejects(
    resolveAssignment({
      ...base,
      provider: "test-provider",
      model: "test-model:high",
      thinking: "low",
    }),
    /conflicts with explicit thinking/,
  );
  await assert.rejects(
    resolveAssignment({
      ...base,
      provider: "test-provider",
      model: "test-model:high",
      thinking: "high",
    }),
    /conflicts with explicit thinking/,
  );

  // A supported level with an explicit model still resolves.
  const valid = await resolveAssignment({
    ...base,
    provider: "test-provider",
    model: "test-model",
    thinking: "medium",
  });
  assert.equal(valid.record.thinking, "medium");
  assert.ok(valid.piArgs.includes("--thinking") && valid.piArgs.includes("medium"));

  await assertNoWrites(workspaceDirectory, storageRoot);
});

test("assignment resolution verifies installed Pi input assembly model-free", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  const workspaceDirectory = join(storageRoot, "projects", "assembly-workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const appPath = await makeRepo(join(root, "repos", "app"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const skillPath = await writeSkill(home, "demo");
  const piPath = await fakePi(join(root, "bin"));
  const briefBytes = Buffer.from("Assembly brief bytes.\n", "utf8");
  await briefFixture(workspaceDirectory, briefBytes);

  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: "assembly-workspace",
    name: "Assembly Workspace",
    repositories: [{ id: "app", path: appPath }],
  }));

  const id = randomUUID();
  const resolved = await resolveAssignment({
    assignment_id: id,
    workspace_id: "assembly-workspace",
    storageRoot,
    home,
    brief: "briefs/brief.md",
    skill: "demo",
    instructions: "Apply the demo skill.",
    target: "app",
    provider: "test-provider",
    model: "test-model",
    thinking: "medium",
    pi_path: piPath,
  });
  assert.deepEqual(resolved.briefBytes, briefBytes);

  // Exercise the installed Pi input assembler (pi 1.1.0
  // dist/cli/args.js parseArgs + dist/cli/initial-message.js
  // buildInitialMessage) model-free: the @snapshot file text plus the
  // returned plain instruction must compose into one initial prompt without
  // a /skill: expansion command.
  const piBase = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist";
  const { parseArgs } = await import(`${piBase}/cli/args.js`);
  const { buildInitialMessage } = await import(`${piBase}/cli/initial-message.js`);
  const packageJson = JSON.parse(
    await readFile("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json", "utf8"),
  );
  assert.match(String(packageJson.version), /^\d+\.\d+\.\d+/);
  t.diagnostic(`installed pi version: ${packageJson.version}`);

  const parsed = parseArgs(resolved.piArgs);
  const workspacePhysical = (await fetchWorkspace(storageRoot, "assembly-workspace")).directory;
  const snapshotPath = join(workspacePhysical, "assignments", `${id}.brief.md`);
  assert.ok(parsed.fileArgs.includes(snapshotPath));
  assert.equal(parsed.thinking, "medium");
  assert.deepEqual(parsed.diagnostics.filter((entry) => entry.message.includes("thinking")), []);
  const instruction = resolved.piArgs[resolved.piArgs.length - 1];
  assert.equal(parsed.messages[parsed.messages.length - 1], instruction);

  const { initialMessage } = buildInitialMessage({
    parsed,
    fileText: resolved.briefBytes.toString("utf8"),
    fileImages: [],
    stdinContent: undefined,
  });
  assert.ok(initialMessage.includes("Assembly brief bytes."));
  assert.ok(initialMessage.includes(`Read the skill at ${skillPath}`));
  assert.ok(initialMessage.includes("Assignment context\n- Assignment: "));
  assert.ok(initialMessage.includes("Apply the demo skill."));
  assert.ok(!initialMessage.split("\n").some((line) => line.trimStart().startsWith("/skill:")));
  t.diagnostic(`assembled initial message bytes: ${Buffer.byteLength(initialMessage, "utf8")}`);

  await assertNoWrites(workspaceDirectory, storageRoot);

  // New composer references are captured into the same @file boundary. Read
  // the actual snapshot with Pi's file processor, then assemble its real input.
  await mkdir(join(workspaceDirectory, 'notes'), { recursive: true });
  await writeFile(join(workspaceDirectory, 'notes', 'selected.md'), '# Selected file\nExact selected source contents.\n');
  const referenceCatalog = createReferenceCatalog({ agentDir: join(home, '.pi/agent'), skillLoader: () => ({
    skills: [{name:'demo', description:'Demo workflow', filePath:skillPath, baseDir:join(home,'.agents/skills/demo'), sourceInfo:{scope:'user'}}], diagnostics:[],
  }) });
  const workspace = await fetchWorkspace(storageRoot, 'assembly-workspace');
  const file = (await referenceCatalog.suggest({workspace, executionDir:appPath,kind:'file',query:'selected.md'})).items[0];
  const skill = (await referenceCatalog.suggest({workspace,executionDir:appPath,kind:'skill',query:'demo'})).items[0];
  const context = await resolveAssignment({assignment_id:id,workspace_id:'assembly-workspace',storageRoot,home,
    brief:'briefs/brief.md',instructions:'Use the explicitly selected inputs.',target:'app',pi_path:piPath,
    context_references:[skill,file].map(({kind,id})=>({kind,id})),
  }, {referenceCatalog});
  await mkdir(join(workspaceDirectory, 'assignments'));
  await writeFile(context.record.brief_snapshot, context.briefBytes);
  const { processFileArguments } = await import(`${piBase}/cli/file-processor.js`);
  const contextArgs = parseArgs(context.piArgs);
  const attachments = await processFileArguments(contextArgs.fileArgs, {autoResizeImages:false});
  const composed = buildInitialMessage({parsed:contextArgs,fileText:attachments.text,fileImages:attachments.images});
  assert.ok(composed.initialMessage.includes('Exact selected source contents.'));
  assert.ok(composed.initialMessage.includes('# Demo skill'));
  assert.ok(composed.initialMessage.includes(`Supporting references are relative to ${join(home,'.agents/skills/demo')}`));
  assert.ok(composed.initialMessage.includes('Use the explicitly selected inputs.'));
  assert.ok(composed.initialMessage.includes(context.inputPreview.brief));
  t.diagnostic('Selected skill and file contents reached the installed Pi file processor and initial-message assembler.');
});

test("assignment resolution keeps option-like general instructions as one plain message", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  const workspaceDirectory = join(storageRoot, "projects", "option-workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const appPath = await makeRepo(join(root, "repos", "app"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const piPath = await fakePi(join(root, "bin"));
  await briefFixture(workspaceDirectory, "Option-like brief bytes.\n");

  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: "option-workspace",
    name: "Option Workspace",
    repositories: [{ id: "app", path: appPath }],
  }));

  const workspacePhysical = (await fetchWorkspace(storageRoot, "option-workspace")).directory;
  const appPhysical = await realpath(appPath);
  // Resolve the installed Pi dist the same way scripts/workspaces/references.mjs
  // does; when it is unavailable, only the Pi-parse assertions below are
  // skipped and the hand-written argv/prompt expectations still run.
  const piDist = await resolveInstalledPiDist();
  let piAssembler = null;
  if (piDist !== null) {
    try {
      const { parseArgs } = await import(pathToFileURL(join(piDist, "cli", "args.js")).href);
      const { buildInitialMessage } = await import(
        pathToFileURL(join(piDist, "cli", "initial-message.js")).href
      );
      piAssembler = { parseArgs, buildInitialMessage };
      t.diagnostic(`installed Pi dist: ${piDist}`);
    } catch {
      piAssembler = null;
    }
  }

  // Pi 1.1.0 parseArgs classifies an argv element by its first characters:
  // '-...' is an invalid option, '--x' an extension flag and '@x' a file.
  // The fixed plain-text prefix keeps each instruction a single message and
  // the owned snapshot the only file argument.
  for (const instructions of [
    "- Review the request.",
    "--review=launch the plan\nSecond line of the request.",
    "@Mention the owner and continue.",
  ]) {
    const id = randomUUID();
    const resolved = await resolveAssignment({
      assignment_id: id,
      workspace_id: "option-workspace",
      storageRoot,
      home,
      brief: "briefs/brief.md",
      skill: "general",
      instructions,
      target: "app",
      pi_path: piPath,
    });
    const snapshotPath = join(workspacePhysical, "assignments", `${id}.brief.md`);
    const expectedInstruction = expectedPrompt({
      id,
      wsName: "Option Workspace",
      wsId: "option-workspace",
      wsDir: workspacePhysical,
      execDir: appPhysical,
      snapshot: snapshotPath,
      pi: true,
      request: `Perform this request:\n\n${instructions}`,
    });
    assert.equal(resolved.piArgs[resolved.piArgs.length - 1], expectedInstruction);

    if (piAssembler !== null) {
      const parsed = piAssembler.parseArgs(resolved.piArgs);
      assert.deepEqual(parsed.fileArgs, [snapshotPath]);
      assert.deepEqual(parsed.messages, [expectedInstruction]);
      assert.deepEqual(parsed.diagnostics, []);
      assert.equal(parsed.unknownFlags.size, 0);

      const { initialMessage } = piAssembler.buildInitialMessage({
        parsed,
        fileText: resolved.briefBytes.toString("utf8"),
        fileImages: [],
        stdinContent: undefined,
      });
      assert.ok(initialMessage.includes(instructions));
      assert.ok(initialMessage.includes(`- Working directory: ${appPhysical} (repository app checkout).`));
      assert.ok(initialMessage.endsWith(`Request\nPerform this request:\n\n${instructions}`));
    }
  }
  t.diagnostic(
    piAssembler === null
      ? "installed Pi dist unavailable; hand-written argv/prompt assertions ran with Pi parse checks skipped"
      : "option-like instruction variants stayed in the parsed message",
  );

  await assertNoWrites(workspaceDirectory, storageRoot);
});

test("assignment resolution harness normalizes the enum and appends it to the canonical digest", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  const workspaceDirectory = join(storageRoot, "projects", "harness-workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const appPath = await makeRepo(join(root, "repos", "app"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const piPath = await fakePi(join(root, "bin"));
  await briefFixture(workspaceDirectory, "Harness brief bytes.\n");

  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: "harness-workspace",
    name: "Harness Workspace",
    repositories: [{ id: "app", path: appPath }],
  }));

  const base = {
    assignment_id: randomUUID(),
    workspace_id: "harness-workspace",
    storageRoot,
    home,
    brief: "briefs/brief.md",
    skill: "general",
    instructions: "Resolve the harness.",
    target: "app",
    pi_path: piPath,
  };

  // Absent and explicit null normalize to Pi; explicit pi is byte-equal.
  const absent = await resolveAssignment(base);
  const explicitNull = await resolveAssignment({ ...base, harness: null });
  const explicitPi = await resolveAssignment({ ...base, harness: "pi" });
  assert.equal(absent.record.harness, "pi");
  assert.equal(absent.contractDigest, explicitNull.contractDigest);
  assert.equal(absent.contractDigest, explicitPi.contractDigest);
  assert.deepEqual(absent.piArgs, explicitPi.piArgs);

  // Independently expected Pi argv and prompt are unchanged.
  const workspacePhysical = (await fetchWorkspace(storageRoot, "harness-workspace")).directory;
  const appPhysical = await realpath(appPath);
  const storagePhysical = await realpath(storageRoot);
  const snapshotPath = join(workspacePhysical, "assignments", `${base.assignment_id}.brief.md`);
  const expectedInstruction = expectedPrompt({
    id: base.assignment_id,
    wsName: "Harness Workspace",
    wsId: "harness-workspace",
    wsDir: workspacePhysical,
    execDir: appPhysical,
    snapshot: snapshotPath,
    pi: true,
    request: "Perform this request:\n\nResolve the harness.",
  });
  assert.deepEqual(absent.piArgs, [
    "--session-dir", join(workspacePhysical, "sessions", base.assignment_id),
    "--session-id", base.assignment_id,
    "--name", "harness-workspace:Harness Workspace",
    `@${snapshotPath}`,
    expectedInstruction,
  ]);
  assert.equal(absent.inputPreview.instruction, expectedInstruction);

  // Hand-written canonical field order: the normalized harness is the last slot.
  const expectedCanonical = [
    "harness-workspace",
    storagePhysical,
    workspacePhysical,
    "briefs/brief.md",
    absent.record.brief_sha256,
    "general",
    null,
    "Resolve the harness.",
    null,
    null,
    null,
    null,
    appPhysical,
    "app",
    null,
    null,
    null,
    "none",
    "initial",
    null,
    piPath,
    join(storagePhysical, ".sentinel", "adjacent.sock"),
    `adj-${base.assignment_id.replace(/-/g, "").slice(0, 12)}`,
    join(storagePhysical, ".sentinel", "coordination.sqlite"),
    join(workspacePhysical, "sessions", base.assignment_id),
    "pi",
  ];
  assert.equal(
    absent.contractDigest,
    createHash("sha256").update(JSON.stringify(expectedCanonical)).digest("hex"),
  );

  // With one explicit executable override, pi vs claude changes only the
  // enum slot and therefore only the digest.
  const claudeInput = { ...base, harness: "claude" };
  const claude = await resolveAssignment(claudeInput);
  assert.equal(claude.record.pi_path, piPath);
  assert.equal(claude.record.harness, "claude");
  assert.equal(
    claude.contractDigest,
    createHash("sha256")
      .update(JSON.stringify([...expectedCanonical.slice(0, -1), "claude"]))
      .digest("hex"),
  );
  assert.notEqual(claude.contractDigest, absent.contractDigest);

  // Unknown, path-like and non-string harness values refuse before writes.
  for (const harness of ["", "Claude", "claude-code", "./claude", 5, {}, ["claude"], true]) {
    await assert.rejects(
      resolveAssignment({ ...base, harness }),
      /invalid harness/,
      JSON.stringify(harness),
    );
  }

  // Non-Pi settings: provider and project_trust must be null; model and
  // thinking stay optional non-empty strings.
  await assert.rejects(
    resolveAssignment({ ...base, harness: "claude", provider: "openai" }),
    /provider must be null for harness claude/,
  );
  await assert.rejects(
    resolveAssignment({ ...base, harness: "codex", provider: "openai", model: "gpt-5" }),
    /provider must be null for harness codex/,
  );
  await assert.rejects(
    resolveAssignment({ ...base, harness: "claude", project_trust: "always" }),
    /project_trust must be null for harness claude/,
  );
  await assert.rejects(
    resolveAssignment({ ...base, harness: "codex", project_trust: "never" }),
    /project_trust must be null for harness codex/,
  );
  await assert.rejects(
    resolveAssignment({ ...base, harness: "claude", model: "" }),
    /model must be a non-empty string/,
  );
  await assert.rejects(
    resolveAssignment({ ...base, harness: "codex", thinking: "" }),
    /thinking must be a non-empty string/,
  );
  await assert.rejects(
    resolveAssignment({ ...base, harness: "claude", thinking: 5 }),
    /thinking must be a non-empty string/,
  );
  await assert.rejects(
    resolveAssignment({ ...base, harness: "codex", model: {} }),
    /model must be a non-empty string/,
  );

  // The existing private approval receipt covers harness changes in the
  // record and argv; no second receipt is introduced.
  const preview = await resolveAssignment(claudeInput);
  const originalArgs = [...preview.piArgs];
  preview.piArgs = [...preview.piArgs, "--tampered"];
  await assert.rejects(
    launchAssignment(claudeInput, { resolved: preview, expectedDigest: preview.contractDigest }),
    /altered after generation/,
  );
  preview.piArgs = originalArgs;
  const originalRecord = preview.record;
  preview.record = { ...preview.record, harness: "codex" };
  await assert.rejects(
    launchAssignment(claudeInput, { resolved: preview, expectedDigest: preview.contractDigest }),
    /altered after generation/,
  );
  preview.record = originalRecord;

  await assertNoWrites(workspaceDirectory, storageRoot);
});

test("assignment resolution harness resolves clauded and codexd wrappers with hand-written argv", async (t) => {
  const root = await tempRoot(t);
  const storageRoot = join(root, "storage");
  const workspaceDirectory = join(storageRoot, "projects", "wrapper-workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const appPath = await makeRepo(join(root, "repos", "app"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const skillPath = await writeSkill(home, "spec-end-to-end");
  await briefFixture(workspaceDirectory, "Wrapper brief bytes.\n");

  await writeFile(join(workspaceDirectory, "kit.yaml"), kitYaml({
    id: "wrapper-workspace",
    name: "Wrapper Workspace",
    repositories: [{ id: "app", path: appPath }],
  }));

  // Fixed names resolve through a temporary PATH; no pi_path override.
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const executables = {};
  for (const name of ["pi", "clauded", "codexd"]) {
    const executable = join(bin, name);
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(executable, 0o755);
    executables[name] = await realpath(executable);
  }

  const workspacePhysical = (await fetchWorkspace(storageRoot, "wrapper-workspace")).directory;
  const appPhysical = await realpath(appPath);
  const wrapperPrompt = (id, request = "Perform this request:\n\nRun the wrapper.") =>
    expectedPrompt({
      id,
      wsName: "Wrapper Workspace",
      wsId: "wrapper-workspace",
      wsDir: workspacePhysical,
      execDir: appPhysical,
      snapshot: join(workspacePhysical, "assignments", `${id}.brief.md`),
      pi: false,
      request,
    });
  const makeInput = (extra = {}) => ({
    assignment_id: randomUUID(),
    workspace_id: "wrapper-workspace",
    storageRoot,
    home,
    brief: "briefs/brief.md",
    skill: "general",
    instructions: "Run the wrapper.",
    target: "app",
    ...extra,
  });

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
  try {
    const piResolved = await resolveAssignment(makeInput());
    const claudeResolved = await resolveAssignment(makeInput({ harness: "claude" }));
    const codexResolved = await resolveAssignment(makeInput({ harness: "codex" }));
    assert.equal(piResolved.record.pi_path, executables.pi);
    assert.equal(claudeResolved.record.pi_path, executables.clauded);
    assert.equal(codexResolved.record.pi_path, executables.codexd);

    assert.deepEqual(claudeResolved.piArgs, [
      "--session-id", claudeResolved.record.assignment_id,
      wrapperPrompt(claudeResolved.record.assignment_id),
    ]);
    assert.deepEqual(codexResolved.piArgs, [
      wrapperPrompt(codexResolved.record.assignment_id),
    ]);
    assert.equal(
      claudeResolved.inputPreview.instruction,
      claudeResolved.piArgs[claudeResolved.piArgs.length - 1],
    );
    assert.equal(
      codexResolved.inputPreview.instruction,
      codexResolved.piArgs[codexResolved.piArgs.length - 1],
    );
    assert.equal(
      claudeResolved.record.pi_session_dir,
      join(workspacePhysical, "sessions", claudeResolved.record.assignment_id),
    );

    // No Pi session/trust/name flags reach either non-Pi argv; Codex has no
    // session id at all, while Claude's --session-id is its own CLI flag.
    for (const argv of [claudeResolved.piArgs, codexResolved.piArgs]) {
      for (const flag of ["--session-dir", "--name", "--provider", "--thinking", "--approve", "--no-approve"]) {
        assert.ok(!argv.includes(flag), flag);
      }
    }
    assert.ok(!codexResolved.piArgs.includes("--session-id"));

    // Model and effort forms compare against hand-written arrays, never
    // against builder output.
    const claudeModeled = await resolveAssignment(makeInput({ harness: "claude", model: "opus", thinking: "high" }));
    assert.deepEqual(claudeModeled.piArgs, [
      "--session-id", claudeModeled.record.assignment_id,
      "--model=opus",
      "--effort", "high",
      wrapperPrompt(claudeModeled.record.assignment_id),
    ]);
    const claudeEffortOnly = await resolveAssignment(makeInput({ harness: "claude", thinking: "max" }));
    assert.deepEqual(claudeEffortOnly.piArgs, [
      "--session-id", claudeEffortOnly.record.assignment_id,
      "--effort", "max",
      wrapperPrompt(claudeEffortOnly.record.assignment_id),
    ]);
    const codexModeled = await resolveAssignment(makeInput({ harness: "codex", model: "gpt-5", thinking: "ultra" }));
    assert.deepEqual(codexModeled.piArgs, [
      "--model=gpt-5",
      "-c", 'model_reasoning_effort="ultra"',
      wrapperPrompt(codexModeled.record.assignment_id),
    ]);
    // A numeric-looking effort stays a quoted TOML string with no model.
    const codexNumeric = await resolveAssignment(makeInput({ harness: "codex", thinking: "42" }));
    assert.deepEqual(codexNumeric.piArgs, [
      "-c", 'model_reasoning_effort="42"',
      wrapperPrompt(codexNumeric.record.assignment_id),
    ]);

    // A DEL U+007F inside a codex effort must surface in the TOML basic
    // string as the \u007f escape, while JSON.stringify's quote, backslash
    // and newline escapes are preserved unchanged.
    const codexDelEffort = 'del\u007f"\\\n';
    const codexDel = await resolveAssignment(makeInput({ harness: "codex", thinking: codexDelEffort }));
    assert.deepEqual(codexDel.piArgs, [
      "-c", 'model_reasoning_effort="del\\u007f\\"\\\\\\n"',
      wrapperPrompt(codexDel.record.assignment_id),
    ]);

    // Claude accepts high/max without a provider and refuses off/minimal.
    for (const thinking of ["high", "max"]) {
      const accepted = await resolveAssignment(makeInput({ harness: "claude", thinking }));
      assert.equal(accepted.record.thinking, thinking);
      assert.equal(accepted.record.provider, null);
    }
    for (const thinking of ["off", "minimal"]) {
      await assert.rejects(
        resolveAssignment(makeInput({ harness: "claude", thinking })),
        /invalid thinking level/,
      );
    }

    // A stub spec-end-to-end skill stays usable with either non-Pi harness.
    for (const harness of ["claude", "codex"]) {
      const skilled = await resolveAssignment(makeInput({ harness, skill: "spec-end-to-end" }));
      assert.equal(skilled.record.skill_path, skillPath);
      const prompt = skilled.piArgs[skilled.piArgs.length - 1];
      assert.equal(prompt, wrapperPrompt(
        skilled.record.assignment_id,
        `Read the skill at ${skillPath} and perform its instructions for this request.\n\nRun the wrapper.`,
      ), harness);
      assert.ok(prompt.includes("Run the wrapper."), harness);
      assert.ok(!prompt.includes("/skill:"), harness);
      assert.ok(!prompt.split("\n").some((line) => line.trimStart().startsWith("/skill")), harness);
    }
  } finally {
    process.env.PATH = originalPath;
  }

  await assertNoWrites(workspaceDirectory, storageRoot);
});
