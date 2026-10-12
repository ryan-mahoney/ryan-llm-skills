// Workspace CLI integration tests (test-first for scripts/workspaces/cli.mjs).
//
// Run independently:
//   node --test --test-name-pattern='workspace CLI restart' scripts/workspaces/cli.test.mjs
//
// Every case drives real child processes against disposable temp roots. The
// focused command runs the production CLI entry with fresh processes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKit } from './kit.mjs';
import { resolveStorageRoot } from './store.mjs';

const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CHILD_TIMEOUT_MS = 15000;

function makeTempParent(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-cli-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return parent;
}

// Base environment for every child: the operator's real ADJACENT_STORAGE_ROOT
// and saved root config must never leak into a test. Callers opt back in
// through `env`. Node's node:sqlite ExperimentalWarning is silenced so stderr
// carries only the {error,path} refusal the tests parse.
const NO_CONFIG_HOME = join(tmpdir(), 'workspace-cli-no-config');
function childEnvironment(env) {
  const merged = {
    ...process.env,
    XDG_CONFIG_HOME: NO_CONFIG_HOME,
    NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
    ...env,
  };
  if (!Object.prototype.hasOwnProperty.call(env, 'ADJACENT_STORAGE_ROOT')) {
    delete merged.ADJACENT_STORAGE_ROOT;
  }
  return merged;
}

function runCli(args, { env = {}, input = '', timeoutMs = CHILD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO,
      env: childEnvironment(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    // A child that exits before reading stdin (for example, a missing CLI)
    // emits EPIPE on this stream; that must fail the assertion, not the test file.
    child.stdin.on('error', () => {});
    if (input !== null) child.stdin.end(input);
  });
}

function success(result, label) {
  assert.equal(result.timedOut, false, `${label} timed out after ${CHILD_TIMEOUT_MS}ms`);
  assert.equal(
    result.code,
    0,
    `${label} exited ${result.code}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  );
  return result;
}

function jsonResult(result, label) {
  success(result, label);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    assert.fail(`${label} did not print a JSON document: ${JSON.stringify(result.stdout)}`);
  }
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), `${label} JSON must be an object`);
  return parsed;
}

function ndjsonResults(result, count, label) {
  success(result, label);
  const documents = result.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        assert.fail(`${label} printed a non-JSON line: ${JSON.stringify(line)}`);
      }
    });
  assert.equal(documents.length, count, `${label} must print ${count} NDJSON documents`);
  return documents;
}

function kitDocument(bytes, label) {
  const parsed = parseKit(bytes.toString('utf8'));
  assert.equal(parsed.ok, true, `${label} must parse as a kit: ${parsed.errors.join('; ')}`);
  return parsed.kit;
}

function refusal(result, label) {
  assert.equal(result.timedOut, false, `${label} timed out after ${CHILD_TIMEOUT_MS}ms`);
  assert.equal(
    result.code,
    1,
    `${label} must exit 1\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stderr);
  } catch {
    assert.fail(`${label} stderr is not the {error,path} JSON shape: ${JSON.stringify(result.stderr)}`);
  }
  assert.equal(typeof parsed.error, 'string', `${label} stderr.error must be a string`);
  assert.ok(parsed.error.length > 0, `${label} stderr.error must not be empty`);
  assert.equal(typeof parsed.path, 'string', `${label} stderr.path must be a string`);
  return parsed;
}

// Content and mtime of every regular file, so "no writes" means exact bytes.
function treeSnapshot(root) {
  const entries = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        entries.push([`${relative}/`, 'directory']);
        walk(path, relative);
      } else if (entry.isFile()) {
        const stat = statSync(path, { bigint: true });
        entries.push([relative, `${stat.mtimeNs} ${readFileSync(path).toString('base64')}`]);
      }
    }
  };
  walk(root, '');
  return entries;
}

function kitState(workspaceDirectory) {
  const kitPath = join(workspaceDirectory, 'kit.yaml');
  const stat = statSync(kitPath, { bigint: true });
  return { kitPath, bytes: readFileSync(kitPath), mtimeNs: stat.mtimeNs };
}

function kitBackups(workspaceDirectory) {
  return readdirSync(workspaceDirectory)
    .filter((name) => name.startsWith('kit.yaml.prev-'))
    .sort();
}

function gitInit(directory) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['init', '--quiet'], { cwd: directory, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, CHILD_TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`git init failed with ${code}: ${stderr}`));
    });
  });
}

test('workspace CLI restart: status, setup and create/show run in fresh processes', async (t) => {
  const parent = makeTempParent(t);
  const root = join(parent, 'store');

  // status reports the missing boundary without creating anything.
  const missing = jsonResult(await runCli(['status', '--json', '--root', root]), 'status missing root');
  assert.equal(missing.status, 'missing_root');
  assert.equal(missing.root, root);
  assert.equal(existsSync(root), false, 'status must not create the root');

  // setup creates root+projects and is idempotent.
  const setup = jsonResult(await runCli(['setup', '--json', '--root', root]), 'setup');
  assert.equal(setup.root, root);
  assert.equal(setup.projects, join(root, 'projects'));
  assert.equal(statSync(root).isDirectory(), true);
  assert.equal(statSync(join(root, 'projects')).isDirectory(), true);
  const afterSetup = treeSnapshot(root);
  const repeated = jsonResult(await runCli(['setup', '--json', '--root', root]), 'setup repeat');
  assert.equal(repeated.root, root);
  assert.deepEqual(treeSnapshot(root), afterSetup, 'setup must be idempotent');

  // create publishes a kit the next process can read.
  const created = jsonResult(await runCli(['create', 'writer', '--name', 'Writer', '--json', '--root', root]), 'create');
  assert.equal(created.id, 'writer');
  assert.equal(created.name, 'Writer');
  assert.equal(existsSync(join(root, 'projects', 'writer', 'kit.yaml')), true);

  const shown = jsonResult(await runCli(['show', 'writer', '--json', '--root', root]), 'show fresh process');
  assert.equal(shown.id, 'writer');
  assert.equal(shown.name, 'Writer');
  assert.equal(shown.directory, join(root, 'projects', 'writer'));
  assert.deepEqual(shown.repositories, []);
  assert.deepEqual(shown.briefs, []);
  assert.deepEqual(shown.notes, []);
  assert.deepEqual(shown.artifacts, []);
});

test('workspace CLI restart: brief and note material persist across fresh processes', async (t) => {
  const parent = makeTempParent(t);
  const root = join(parent, 'store');
  success(await runCli(['setup', '--root', root]), 'setup');
  success(await runCli(['create', 'writer', '--root', root]), 'create');
  const workspace = join(root, 'projects', 'writer');

  // stdin is the material source only when --from is absent.
  const stdinBody = 'STDIN-BRIEF-BODY\nsecond line\n';
  const brief = jsonResult(
    await runCli(['add-brief', 'writer', '--title', 'Restart brief', '--json', '--root', root], { input: stdinBody }),
    'add-brief stdin',
  );
  assert.match(brief.path, /^briefs\/\d{4}-\d{2}-\d{2}-restart-brief\.md$/);
  assert.equal(readFileSync(join(workspace, brief.path), 'utf8'), stdinBody);

  const sourceFile = join(parent, 'source-note.md');
  writeFileSync(sourceFile, 'FROM-FILE-BODY\n');
  const fileBrief = jsonResult(
    await runCli(
      ['add-brief', 'writer', '--title', 'From file', '--from', sourceFile, '--json', '--root', root],
      { input: 'STDIN-MUST-BE-IGNORED\n' },
    ),
    'add-brief --from',
  );
  assert.match(fileBrief.path, /^briefs\/\d{4}-\d{2}-\d{2}-from-file\.md$/);
  assert.equal(
    readFileSync(join(workspace, fileBrief.path), 'utf8'),
    'FROM-FILE-BODY\n',
    '--from content must win over available stdin',
  );

  // --from with stdin left open: the child chooses the file and exits without
  // waiting for stdin, so the open pipe is destroyed only after its own close.
  const openSource = join(parent, 'open-source.md');
  writeFileSync(openSource, 'OPEN-STDIN-FILE-BODY\n');
  const openStdin = await runCli(
    ['add-brief', 'writer', '--title', 'Open stdin', '--from', openSource, '--json', '--root', root],
    { input: null },
  );
  const openResult = jsonResult(openStdin, 'add-brief --from with open stdin');
  assert.ok(openResult.path.startsWith('briefs/') && openResult.path.endsWith('-open-stdin.md'));
  assert.equal(readFileSync(join(workspace, openResult.path), 'utf8'), 'OPEN-STDIN-FILE-BODY\n');

  const note = jsonResult(
    await runCli(['add-note', 'writer', '--title', 'Restart note', '--json', '--root', root], { input: 'NOTE-BODY\n' }),
    'add-note',
  );
  assert.match(note.path, /^notes\/\d{4}-\d{2}-\d{2}-restart-note\.md$/);
  assert.equal(readFileSync(join(workspace, note.path), 'utf8'), 'NOTE-BODY\n');

  // A fresh process retrieves every association written by the earlier children.
  const shown = jsonResult(await runCli(['show', 'writer', '--json', '--root', root]), 'show after material');
  assert.ok(shown.briefs.includes(brief.path.slice('briefs/'.length)), 'show must retrieve the stdin brief');
  assert.ok(shown.briefs.includes(fileBrief.path.slice('briefs/'.length)), 'show must retrieve the --from brief');
  assert.ok(shown.notes.includes(note.path.slice('notes/'.length)), 'show must retrieve the note');
});

test('workspace CLI restart: add-repo and set-role preview then apply', async (t) => {
  const parent = makeTempParent(t);
  const root = join(parent, 'store');
  success(await runCli(['setup', '--root', root]), 'setup');
  success(await runCli(['create', 'team', '--root', root]), 'create');
  const workspace = join(root, 'projects', 'team');
  const repositoryPath = join(parent, 'docs-repo');
  mkdirSync(repositoryPath);
  await gitInit(repositoryPath);

  const baseline = kitState(workspace);
  assert.deepEqual(kitBackups(workspace), []);
  assert.equal(existsSync(join(workspace, 'kit.yaml.lock')), false);

  // add-repo without --apply prints the hunk and changes nothing.
  const preview = success(
    await runCli(['add-repo', 'team', '--id', 'docs', '--path', repositoryPath, '--root', root]),
    'add-repo preview',
  );
  assert.ok(preview.stdout.includes('repositories'), 'preview must print the edited kit section');
  assert.ok(preview.stdout.includes('docs'), 'preview must print the new repository id');
  assert.ok(preview.stdout.includes(repositoryPath), 'preview must print the resolved repository path');
  const afterPreview = kitState(workspace);
  assert.deepEqual(afterPreview.bytes, baseline.bytes, 'dry-run must not change kit bytes');
  assert.equal(afterPreview.mtimeNs, baseline.mtimeNs, 'dry-run must not touch kit mtime');
  assert.deepEqual(kitBackups(workspace), [], 'dry-run must not publish a prior copy');
  assert.equal(existsSync(join(workspace, 'kit.yaml.lock')), false, 'dry-run must not leave a lock');

  // --apply previews first (the exact plan), then applies and retains exactly the planned original bytes.
  const addDocuments = ndjsonResults(
    await runCli(['add-repo', 'team', '--id', 'docs', '--path', repositoryPath, '--apply', '--json', '--root', root]),
    2,
    'add-repo apply',
  );
  const afterApply = kitState(workspace);
  assert.equal(addDocuments[0].before, baseline.bytes.toString('utf8'), 'the first NDJSON document is the exact plan');
  assert.equal(addDocuments[0].after, afterApply.bytes.toString('utf8'), 'the plan after bytes are the applied bytes');
  assert.equal(addDocuments[1].path, join(workspace, 'kit.yaml'));
  const appliedKit = kitDocument(afterApply.bytes, 'add-repo applied');
  assert.ok(
    appliedKit.repositories.some((entry) => entry.id === 'docs' && entry.path === repositoryPath),
    'applied kit must record docs at the repository path',
  );
  const addBackups = kitBackups(workspace);
  assert.equal(addBackups.length, 1, 'apply must publish one prior copy');
  assert.equal(addDocuments[1].backup, join(workspace, addBackups[0]));
  assert.deepEqual(readFileSync(join(workspace, addBackups[0])), baseline.bytes);
  assert.equal(existsSync(join(workspace, 'kit.yaml.lock')), false, 'apply must release its lock');

  // set-role separates preview from apply the same way.
  const beforeRole = kitState(workspace);
  const rolePreview = success(
    await runCli(['set-role', 'team', '--id', 'docs', '--role', 'owner', '--root', root]),
    'set-role preview',
  );
  assert.ok(rolePreview.stdout.includes('docs'), 'set-role preview must name the repository');
  assert.ok(rolePreview.stdout.includes('owner'), 'set-role preview must print the new role');
  const afterRolePreview = kitState(workspace);
  assert.deepEqual(afterRolePreview.bytes, beforeRole.bytes, 'set-role dry-run must not change kit bytes');
  assert.equal(afterRolePreview.mtimeNs, beforeRole.mtimeNs, 'set-role dry-run must not touch kit mtime');
  assert.deepEqual(kitBackups(workspace), addBackups, 'set-role dry-run must not publish a prior copy');

  const roleDocuments = ndjsonResults(
    await runCli(['set-role', 'team', '--id', 'docs', '--role', 'owner', '--apply', '--json', '--root', root]),
    2,
    'set-role apply',
  );
  const afterRole = kitState(workspace);
  assert.equal(roleDocuments[0].before, beforeRole.bytes.toString('utf8'));
  assert.equal(roleDocuments[0].after, afterRole.bytes.toString('utf8'));
  assert.equal(kitDocument(afterRole.bytes, 'set-role applied').repositories.find((entry) => entry.id === 'docs')?.role, 'owner');
  const roleBackups = kitBackups(workspace);
  assert.equal(roleBackups.length, 2, 'set-role apply must publish another prior copy');
  const roleBackup = roleBackups.find((name) => !addBackups.includes(name));
  assert.ok(roleBackup, 'set-role apply must add a new prior copy');
  assert.equal(roleDocuments[1].backup, join(workspace, roleBackup));
  assert.deepEqual(readFileSync(join(workspace, roleBackup)), beforeRole.bytes);
  assert.equal(existsSync(join(workspace, 'kit.yaml.lock')), false, 'set-role apply must release its lock');

  // A held lock refuses a later apply: the plan is previewed first, stderr names
  // the retained prior copy, and the held sentinel is untouched.
  const sentinelLock = join(workspace, 'kit.yaml.lock');
  writeFileSync(sentinelLock, 'held-by-fixture\n');
  const lockResult = await runCli(['set-role', 'team', '--id', 'docs', '--role', 'reviewer', '--apply', '--json', '--root', root]);
  const lockRefusal = refusal(lockResult, 'set-role held lock');
  assert.equal(JSON.parse(lockResult.stdout).before, afterRole.bytes.toString('utf8'), 'the preview must print before the lock refusal');
  const contenderBackups = kitBackups(workspace);
  assert.equal(contenderBackups.length, roleBackups.length + 1, 'a refused apply leaves its completed prior copy');
  const contenderBackup = contenderBackups.find((name) => !roleBackups.includes(name));
  assert.equal(lockRefusal.path, join(workspace, contenderBackup), 'stderr must name the retained prior copy');
  assert.deepEqual(kitState(workspace).bytes, afterRole.bytes, 'held lock refusal must leave kit bytes');
  assert.equal(readFileSync(sentinelLock, 'utf8'), 'held-by-fixture\n', 'held lock sentinel must be untouched');
  rmSync(sentinelLock);

  // Duplicate repository ids refuse before any plan is applied.
  refusal(await runCli(['add-repo', 'team', '--id', 'docs', '--path', repositoryPath, '--root', root]), 'duplicate add-repo');
  assert.deepEqual(kitState(workspace).bytes, afterRole.bytes, 'duplicate refusal must leave kit bytes');
  assert.deepEqual(kitBackups(workspace), contenderBackups, 'duplicate refusal must not publish a prior copy');

  // The applied repository grounds repository-relative artifacts, retrieved by a fresh show.
  writeFileSync(join(repositoryPath, 'spec.md'), 'SPEC\n');
  const artifact = jsonResult(
    await runCli(
      ['add-artifact', 'team', '--repository', 'docs', '--path', 'spec.md', '--title', 'Spec', '--json', '--root', root],
    ),
    'add-artifact repository',
  );
  assert.match(artifact.path, /^artifacts\/[0-9a-f-]+\.json$/);
  const record = JSON.parse(readFileSync(join(workspace, artifact.path), 'utf8'));
  assert.equal(record.schema_version, 1);
  assert.equal(record.kind, 'repository');
  assert.deepEqual(record.target, { repository_id: 'docs', path: 'spec.md' });
  assert.equal(record.title, 'Spec');

  const brief = jsonResult(
    await runCli(['add-brief', 'team', '--title', 'Team brief', '--json', '--root', root], { input: 'TEAM-BRIEF\n' }),
    'add-brief team',
  );
  const urlArtifact = jsonResult(
    await runCli(
      ['add-artifact', 'team', '--url', 'https://example.com/team', '--note', 'External reference', '--json', '--root', root],
    ),
    'add-artifact url',
  );
  const urlRecord = JSON.parse(readFileSync(join(workspace, urlArtifact.path), 'utf8'));
  assert.equal(urlRecord.kind, 'url');
  assert.equal(urlRecord.note, 'External reference');

  const shown = jsonResult(await runCli(['show', 'team', '--json', '--root', root]), 'show after repository');
  const repository = shown.repositories.find((entry) => entry.id === 'docs');
  assert.ok(repository, 'show must retrieve the applied repository');
  assert.equal(repository.role, 'owner');
  assert.equal(repository.status, 'ok');
  assert.ok(shown.briefs.includes(brief.path.slice('briefs/'.length)), 'show must retrieve the team brief');
  assert.ok(
    shown.artifacts.some((entry) => entry.artifact_id === record.artifact_id && entry.status === 'ok'),
    'show must retrieve the repository artifact',
  );
  const external = shown.artifacts.find((entry) => entry.artifact_id === urlRecord.artifact_id);
  assert.ok(external, 'show must retrieve the URL artifact');
  assert.equal(external.status, 'external');
});

test('workspace CLI restart: explicit --root overrides env and env roots stay isolated', async (t) => {
  const parent = makeTempParent(t);
  const rootA = join(parent, 'root-a');
  const rootB = join(parent, 'root-b');
  const envB = { ADJACENT_STORAGE_ROOT: rootB };

  success(await runCli(['setup', '--root', rootA]), 'setup root A');
  success(await runCli(['create', 'alpha', '--root', rootA]), 'create alpha');
  success(await runCli(['setup'], { env: envB }), 'setup env root B');
  success(await runCli(['create', 'beta'], { env: envB }), 'create beta');

  // Different ADJACENT_STORAGE_ROOT values do not see each other.
  const listB = jsonResult(await runCli(['list', '--json'], { env: envB }), 'list env root B');
  assert.deepEqual(listB.valid.map((entry) => entry.id), ['beta']);
  assert.equal(listB.valid.some((entry) => entry.id === 'alpha'), false, 'env root B must not see root A');

  // Explicit --root wins over the env root for reads and for resolution.
  const listA = jsonResult(await runCli(['list', '--json', '--root', rootA], { env: envB }), 'list root A override');
  assert.deepEqual(listA.valid.map((entry) => entry.id), ['alpha']);
  const statusA = jsonResult(await runCli(['status', '--json', '--root', rootA], { env: envB }), 'status root A override');
  assert.equal(statusA.root, rootA);
  assert.equal(statusA.status, 'ok');
  success(await runCli(['show', 'alpha', '--json', '--root', rootA], { env: envB }), 'show alpha override');
  refusal(await runCli(['show', 'beta', '--json', '--root', rootA], { env: envB }), 'show beta under wrong root');
});

test('workspace CLI restart: default root resolves under an injected HOME', async (t) => {
  const parent = makeTempParent(t);
  const home = join(parent, 'home');
  mkdirSync(home);
  const expectedRoot = join(home, 'Documents', 'adjacent-storage');

  assert.equal(resolveStorageRoot({}, home), expectedRoot, 'the pure resolver uses the injected home');

  const env = { HOME: home };
  const before = jsonResult(await runCli(['status', '--json'], { env }), 'status default root');
  assert.equal(before.root, expectedRoot);
  assert.equal(before.status, 'missing_root');
  assert.equal(existsSync(join(home, 'Documents')), false, 'status must not create the default root');

  // With Documents/ present, status still reports the missing store and creates nothing.
  mkdirSync(join(home, 'Documents'));
  const withDocuments = jsonResult(await runCli(['status', '--json'], { env }), 'status with Documents present');
  assert.equal(withDocuments.status, 'missing_root');
  assert.equal(existsSync(expectedRoot), false, 'status must not create the store root');
});

test('workspace CLI restart: malformed input refuses without writes', async (t) => {
  const parent = makeTempParent(t);
  const root = join(parent, 'store');
  success(await runCli(['setup', '--root', root]), 'setup');
  success(await runCli(['create', 'alpha', '--root', root]), 'create alpha');
  const snapshot = treeSnapshot(root);

  refusal(await runCli(['create', 'alpha', '--root', root]), 'duplicate create');
  refusal(await runCli(['create', '--root', root]), 'create without id');
  refusal(await runCli(['create', 'beta', '--bogus', '--root', root]), 'unknown flag');
  assert.equal(existsSync(join(root, 'projects', 'beta')), false, 'unknown flag must not create the workspace');
  refusal(await runCli(['add-brief', 'alpha', '--root', root], { input: 'body' }), 'add-brief without title');
  refusal(await runCli(['add-repo', 'alpha', '--id', 'docs', '--root', root]), 'add-repo without path');
  refusal(
    await runCli(
      ['add-artifact', 'alpha', '--repository', 'docs', '--url', 'https://example.com/x', '--root', root],
    ),
    'add-artifact with two targets',
  );
  refusal(
    await runCli(['add-brief', 'alpha', '--title', 'Missing file', '--from', join(root, 'absent.md'), '--root', root]),
    'add-brief --from missing file',
  );
  refusal(await runCli(['show', 'missing', '--root', root]), 'show unknown workspace');
  refusal(await runCli(['create', 'beta', '--root', root, '--root', root]), 'duplicate --root');
  refusal(await runCli(['create', 'beta', '--json', '--json', '--root', root]), 'duplicate --json');
  refusal(
    await runCli(['add-repo', 'alpha', '--id', 'docs', '--id', 'other', '--path', join(root, 'repo'), '--root', root]),
    'duplicate --id',
  );
  refusal(await runCli(['add-repo', 'alpha', '--id', 'docs', '--path', '--root', root]), 'missing option value');
  refusal(await runCli(['toString', '--root', root]), 'inherited command name');
  refusal(await runCli(['create', 'beta', '--name', 'line\nbreak', '--root', root]), 'create name with newline');
  // A relative path is workspace-relative: it previews, and apply refuses a checkout that is absent.
  refusal(
    await runCli(['add-repo', 'alpha', '--id', 'docs', '--path', 'relative/repo', '--apply', '--root', root]),
    'relative add-repo apply to a missing checkout',
  );
  assert.deepEqual(treeSnapshot(root), snapshot, 'refusals must not write to storage');
});

test('workspace CLI restart: setup --save persists the root and status names its source', async (t) => {
  const parent = makeTempParent(t);
  const root = join(parent, 'store');
  const other = join(parent, 'other');
  const xdg = join(parent, 'xdg');
  const env = { XDG_CONFIG_HOME: xdg };

  const setup = jsonResult(await runCli(['setup', '--save', '--json', '--root', root], { env }), 'setup --save');
  const config = join(xdg, 'adjacent', 'config.json');
  assert.equal(setup.saved, config);
  assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), { storage_root: root });

  const saved = jsonResult(await runCli(['status', '--json'], { env }), 'status from config');
  assert.equal(saved.root, root);
  assert.equal(saved.source, 'config');
  assert.equal(saved.status, 'ok');
  const fromEnv = jsonResult(await runCli(['status', '--json'], { env: { ...env, ADJACENT_STORAGE_ROOT: other } }), 'status from env');
  assert.deepEqual([fromEnv.root, fromEnv.source], [other, 'env']);
  const fromFlag = jsonResult(await runCli(['status', '--json', '--root', other], { env }), 'status from flag');
  assert.equal(fromFlag.source, 'flag');
  assert.equal(jsonResult(await runCli(['status', '--json']), 'status default').source, 'default');
  assert.equal(existsSync(join(other, 'projects')), false);
});

test('workspace CLI restart: kit edit commands preview without writing, apply with a backup, and restore', async (t) => {
  const parent = makeTempParent(t);
  const home = join(parent, 'home');
  const root = join(parent, 'store');
  const env = { HOME: home };
  mkdirSync(join(home, 'docs'), { recursive: true });
  await gitInit(join(home, 'docs'));
  mkdirSync(join(home, 'web'));
  await gitInit(join(home, 'web'));
  success(await runCli(['setup', '--root', root], { env }), 'setup');
  success(await runCli(['create', 'team', '--root', root], { env }), 'create');
  const workspace = join(root, 'projects', 'team');
  const run = (args) => runCli([...args, '--root', root], { env });

  // Each step: [args, text the applied kit.yaml must contain]. Preview first, then apply.
  const steps = [
    [['add-repo', 'team', '--id', 'docs', '--path', '~/docs'], 'path: "~/docs"'],
    [['add-repo', 'team', '--id', 'web', '--path', join(home, 'web'), '--role', 'app'], 'role: "app"'],
    [['set-remote', 'team', '--id', 'docs', '--remote', 'git@example.com:docs.git'], 'remote: "git@example.com:docs.git"'],
    [['clear-role', 'team', '--id', 'web'], 'path: ' + JSON.stringify(join(home, 'web'))],
    [['set-name', 'team', '--name', 'Team Space'], 'name: "Team Space"'],
    [['add-context', 'team', '--path', 'context/notes.md'], '- "context/notes.md"'],
    [['set-design-system', 'team', '--repo', 'docs', '--path', 'ds/a.css', '--path', 'ds/b.css', '--applies-to', 'all'], '    - "ds/b.css"'],
    [['set-preview', 'team', '--repo', 'docs', '--file', 'dev/compose.yaml'], 'compose_file: \"dev/compose.yaml\"'],
    [['clear-preview', 'team'], 'context:'],
    [['set-preview', 'team', '--repo', 'web', '--file', 'compose.yaml'], 'compose_file: \"compose.yaml\"'],
    [['set-execution-host', 'team', '--host', 'restory-box'], 'execution_host: "restory-box"'],
    [['rewrite-paths', 'team', '--from', home, '--to', '~'], 'path: "~/web"'],
    [['remove-context', 'team', '--path', 'context/notes.md'], 'context: []'],
  ];
  for (const [args, expected] of steps) {
    const before = kitState(workspace);
    const backups = kitBackups(workspace).length;
    const preview = success(await run(args), `${args[0]} preview`);
    assert.ok(preview.stdout.includes('--- after'), `${args[0]} preview prints the hunk`);
    assert.deepEqual(kitState(workspace).bytes, before.bytes, `${args[0]} preview must not write`);
    assert.equal(kitBackups(workspace).length, backups, `${args[0]} preview must not back up`);
    const applied = ndjsonResults(await run([...args, '--apply', '--json']), 2, `${args[0]} apply`);
    assert.equal(applied[0].before, before.bytes.toString('utf8'), `${args[0]} applies the previewed plan`);
    assert.ok(kitState(workspace).bytes.toString('utf8').includes(expected), `${args[0]} result contains ${expected}`);
    assert.equal(kitBackups(workspace).length, backups + 1, `${args[0]} apply publishes one backup`);
  }
  const kit = kitDocument(kitState(workspace).bytes, 'edited kit');
  assert.equal(kit.name, 'Team Space');
  assert.equal(kit.execution_host, 'restory-box');
  assert.deepEqual(kit.design_system, { repository: 'docs', paths: ['ds/a.css', 'ds/b.css'], applies_to: 'all' });
  assert.deepEqual(kit.repositories.map((repository) => repository.path), ['~/docs', '~/web']);
  const shown = jsonResult(await run(['show', 'team', '--json']), 'show edited kit');
  assert.deepEqual(shown.repositories.map((repository) => repository.status), ['ok', 'ok'], '~ paths resolve with the local home');
  assert.equal(shown.kit.design_system.repository, 'docs');
  assert.deepEqual(shown.kit.preview, { repository: 'web', compose_file: 'compose.yaml' });

  // remove-repo previews the records that reference the repository and never refuses.
  mkdirSync(join(workspace, 'threads'));
  writeFileSync(join(workspace, 'threads', 'thread-1.json'), JSON.stringify({ target: { kind: 'repository', repository_id: 'web' } }));
  const removePreview = success(await run(['remove-repo', 'team', '--id', 'web']), 'remove-repo preview');
  assert.match(removePreview.stdout, /threads: thread-1/);
  const removed = ndjsonResults(await run(['remove-repo', 'team', '--id', 'web', '--apply', '--json']), 2, 'remove-repo apply');
  assert.deepEqual(removed[0].references.threads, ['thread-1']);
  assert.deepEqual(kitDocument(kitState(workspace).bytes, 'after remove').repositories.map((repository) => repository.id), ['docs']);
  assert.equal(kitDocument(kitState(workspace).bytes, 'after preview repository removal').preview, undefined);
  assert.equal(existsSync(join(workspace, 'threads', 'thread-1.json')), true, 'the thread record stays');

  // The oldest backup restores through the same preview, backup and apply path.
  const listed = jsonResult(await run(['kit-backups', 'team', '--json']), 'kit-backups').backups;
  assert.equal(listed.length, kitBackups(workspace).length);
  const oldest = listed[listed.length - 1];
  const current = kitState(workspace).bytes;
  success(await run(['restore-kit', 'team', oldest]), 'restore-kit preview');
  assert.deepEqual(kitState(workspace).bytes, current, 'restore preview must not write');
  success(await run(['restore-kit', 'team', oldest, '--apply']), 'restore-kit apply');
  assert.equal(kitDocument(kitState(workspace).bytes, 'restored').repositories.length, 0);
  refusal(await run(['restore-kit', 'team', '../kit.yaml', '--apply']), 'restore-kit rejects a name that is not a listed backup');
});
