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
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { newPackage } from "../spec-location/index.mjs";
import { resolveAssignment, resolveTarget } from "./assignments.mjs";
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
  const piBase = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist";
  const { parseArgs } = await import(`${piBase}/cli/args.js`);
  const { buildInitialMessage } = await import(`${piBase}/cli/initial-message.js`);

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
    const expectedInstruction =
      `Perform the following request:\n\n${instructions}\n\n` +
      `Assignment ${id} workspace option-workspace dir ${appPhysical}. ` +
      "Publication authority: none (grants no merge/deploy).";
    assert.equal(resolved.piArgs[resolved.piArgs.length - 1], expectedInstruction);

    const parsed = parseArgs(resolved.piArgs);
    assert.deepEqual(parsed.fileArgs, [snapshotPath]);
    assert.deepEqual(parsed.messages, [expectedInstruction]);
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.unknownFlags.size, 0);

    const { initialMessage } = buildInitialMessage({
      parsed,
      fileText: resolved.briefBytes.toString("utf8"),
      fileImages: [],
      stdinContent: undefined,
    });
    assert.ok(initialMessage.includes(instructions));
    assert.ok(initialMessage.includes(
      `Assignment ${id} workspace option-workspace dir ${appPhysical}. ` +
        "Publication authority: none (grants no merge/deploy).",
    ));
  }
  t.diagnostic("option-like instruction variants stayed in the parsed message");

  await assertNoWrites(workspaceDirectory, storageRoot);
});
