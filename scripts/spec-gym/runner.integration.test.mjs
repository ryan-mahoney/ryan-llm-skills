import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPackage, loadRun } from '../../pi/extensions/spec-runtime/runtime.mjs';
import { gitFacts } from '../spec-facts/core.mjs';
import { PREPARED_PACKAGE_FILES, loadScenario, renderIndex } from './core.mjs';
import { ambientContext, cellEnvironment, createRun, freezeManifest, materializeCell, runLeafCell, runManagedCell, writeRunRecord } from './runner.mjs';

// Test plumbing only: pin the ambient variables each case mutates so restore
// hooks return to the module baseline regardless of hook registration order.
const baseEnv = { HOME: process.env.HOME, SECRET_TOKEN: process.env.SECRET_TOKEN, SPEC_GYM_FAKE_PI_LOG: process.env.SPEC_GYM_FAKE_PI_LOG, SPEC_GYM_FAKE_PI_SCRIPT: process.env.SPEC_GYM_FAKE_PI_SCRIPT };

function restoreBaseEnv(names) {
  for (const name of names) {
    const value = baseEnv[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

const leafScenario = () => ({
  id: 'leaf-case',
  skill: 'spec-a',
  driver: 'leaf',
  status: 'draft',
  purpose: 'Leaf fixture for materialization.',
  fixture: { feature: 'leaf-feature' },
  task: 'Produce the leaf artifact.',
  timeout_ms: 60000,
  expectation_sources: ['requirements.md item 1'],
  checks: [{ id: 'spec-written', kind: 'file-exists', root: 'package', path: 'spec.md' }],
});

const managedScenario = () => ({
  id: 'managed-case',
  skill: 'spec-a',
  driver: 'managed-step',
  status: 'draft',
  purpose: 'Managed-step fixture for materialization.',
  fixture: { feature: 'example-feature', step: 1 },
  task: 'spec=.specs/example-feature/spec.md step=1',
  roles: { editor_model: 'provider/editor' },
  timeout_ms: 60000,
  expectation_sources: ['requirements.md item 2'],
  checks: [{ id: 'owner-finished', kind: 'run-state', equals: 'completed' }],
});

function writeFixtureFile(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

function writeScenario(folder, scenario) {
  writeFixtureFile(join(folder, 'scenario.json'), `${JSON.stringify(scenario, null, 2)}\n`);
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spec-gym-runner-')));
  const gym = join(root, 'gym');
  writeFixtureFile(join(gym, 'skills', 'spec-a', 'SKILL.md'), '# spec-a\n');

  const leaf = join(gym, 'scenarios', 'spec-a', 'leaf-case');
  writeScenario(leaf, leafScenario());
  writeFixtureFile(join(leaf, 'input', 'repository', 'src', 'app.mjs'), 'export const app = 1;\n');
  writeFixtureFile(join(leaf, 'input', 'repository', 'README.md'), 'leaf fixture\n');
  writeFixtureFile(join(leaf, 'input', 'repository', 'scripts', 'check.sh'), '#!/bin/sh\nexit 0\n', 0o755);
  writeFixtureFile(join(leaf, 'input', 'package', 'spec.md'), '# spec\n');
  writeFixtureFile(join(leaf, 'input', 'project-context.md'), 'context\n');

  const managed = join(gym, 'scenarios', 'spec-a', 'managed-case');
  writeScenario(managed, managedScenario());
  for (const name of PREPARED_PACKAGE_FILES) {
    if (name === '../project-context.md') continue;
    writeFixtureFile(join(managed, 'input', 'package', name), name === 'spec-steps.json' ? '{"steps":[{"step":1}]}\n' : `${name}\n`);
  }
  writeFixtureFile(join(managed, 'input', 'package', 'step-001-subspec.md'), '# Step 1\n');
  writeFixtureFile(join(managed, 'input', 'project-context.md'), 'context\n');

  const git = (...args) => execFileSync('git', ['-C', gym, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Spec Gym Runner Test');
  git('config', 'user.email', 'spec-gym-runner@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'Fixture gym');

  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, gym, leaf, managed };
}

function treeFiles(root, ignore = []) {
  const files = [];
  const visit = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (ignore.includes(relative)) continue;
      if (lstatSync(path).isDirectory()) visit(path, relative);
      else files.push(relative);
    }
  };
  if (existsSync(root)) visit(root, '');
  return files;
}

function digestTree(root) {
  const hash = createHash('sha256');
  for (const file of treeFiles(root)) {
    hash.update(file);
    hash.update('\0');
    hash.update(readFileSync(join(root, file)));
  }
  return hash.digest('hex');
}

function runFixture(f, options = {}) {
  return createRun({ repoRoot: f.gym, root: f.root, skill: 'spec-a', scenarios: [f.leaf], models: ['provider/model'], timeoutMs: 60000, ...options });
}

function stubPiCommand(root) {
  const wrapper = join(root, 'stub-pi.sh');
  writeFixtureFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL('./fake-pi.mjs', import.meta.url))}" "$@"\n`, 0o755);
  return wrapper;
}

function leafCase(t, { script = 'success', timeoutMs, model = 'test/leaf-model:low' } = {}) {
  const f = fixture(t);
  if (timeoutMs !== undefined) {
    const timed = leafScenario();
    timed.timeout_ms = timeoutMs;
    writeScenario(f.leaf, timed);
  }
  const scenario = loadScenario(f.leaf);
  const run = createRun({ repoRoot: f.gym, root: f.root, skill: 'spec-a', scenarios: [f.leaf], models: [model], timeoutMs: timeoutMs ?? 60000, pi: stubPiCommand(f.root) });
  const materialized = materializeCell(run, run.cells[0], scenario);
  process.env.SPEC_GYM_FAKE_PI_LOG = join(materialized.cellDir, 'streams', 'fake-pi-log.json');
  process.env.SPEC_GYM_FAKE_PI_SCRIPT = script;
  t.after(() => restoreBaseEnv(['SPEC_GYM_FAKE_PI_LOG', 'SPEC_GYM_FAKE_PI_SCRIPT']));
  const execute = async () => {
    const result = await runLeafCell(run, run.cells[0], scenario, materialized);
    t.after(() => { try { process.kill(-result.pid, 'SIGKILL'); } catch { /* already gone */ } });
    return result;
  };
  return { f, run, scenario, materialized, execute };
}

function managedCase(t, { script = 'success', timeoutMs } = {}) {
  const f = fixture(t);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'spec-gym-managed-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (timeoutMs !== undefined) {
    const timed = managedScenario();
    timed.timeout_ms = timeoutMs;
    writeScenario(f.managed, timed);
  }
  const scenario = loadScenario(f.managed);
  const childExtension = join(f.root, 'managed-child-extension.mjs');
  const run = createRun({
    repoRoot: f.gym, root: f.root, skill: 'spec-a', scenarios: [f.managed], models: ['test/owner-model'],
    roles: { editor_model: 'test/editor-model', scout_model: 'test/scout-model' },
    timeoutMs: 60000, childExtensions: [childExtension], pi: stubPiCommand(f.root),
  });
  run.manifest = freezeManifest(run);
  const materialized = materializeCell(run, run.cells[0], scenario);
  const original = process.env;
  t.after(() => {
    restoreBaseEnv(['HOME', 'SECRET_TOKEN', 'SPEC_GYM_FAKE_PI_LOG', 'SPEC_GYM_FAKE_PI_SCRIPT']);
    process.env = original;
  });
  const logPath = join(materialized.cellDir, 'streams', 'fake-pi-log.json');
  process.env.HOME = home;
  process.env.SECRET_TOKEN = 'managed-secret';
  process.env.SPEC_GYM_FAKE_PI_LOG = logPath;
  process.env.SPEC_GYM_FAKE_PI_SCRIPT = script;
  const env = { object: process.env, values: { ...process.env } };
  const pids = [];
  const execute = async () => {
    const result = await runManagedCell(run, run.cells[0], scenario, materialized);
    if (Number.isInteger(result.pid)) pids.push(result.pid);
    return result;
  };
  t.after(() => {
    for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
  });
  return { f, run, scenario, materialized, home, logPath, childExtension, env, execute };
}

const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));

function cliFixture(t, { status = 'ready' } = {}) {
  const f = fixture(t);
  writeScenario(f.leaf, { ...leafScenario(), status });
  writeFixtureFile(join(f.gym, 'scenarios', 'spec-a', 'scenarios.md'), renderIndex('spec-a', [loadScenario(f.leaf), loadScenario(f.managed)]));
  writeFixtureFile(join(f.gym, 'skills', 'spec-b', 'SKILL.md'), '# spec-b\n');
  const git = (...args) => execFileSync('git', ['-C', f.gym, ...args], { stdio: 'pipe' });
  git('add', '-A');
  git('commit', '-qm', 'CLI fixture');
  return f;
}

function spawnCli(args, { f, env = {}, detached = false } = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: f.gym,
    env: { ...process.env, SPEC_GYM_REPO: f.gym, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr })));
  return { child, done, stdout: () => stdout, stderr: () => stderr };
}

function runCli(args, options) {
  return spawnCli(args, options).done;
}

async function waitFor(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('materialize creates a canonical fixture repository with one Fixture commit', t => {
  const f = fixture(t);
  const run = runFixture(f);
  freezeManifest(run);
  const materialized = materializeCell(run, run.cells[0], loadScenario(f.leaf));

  const sourceRepository = join(f.leaf, 'input', 'repository');
  const providedGitignore = existsSync(join(sourceRepository, '.gitignore'));
  const actualRepository = treeFiles(materialized.repoDir, ['.git', '.specs'])
    .filter(file => file !== '.gitignore' || providedGitignore);
  assert.deepEqual(actualRepository, treeFiles(sourceRepository));
  for (const file of treeFiles(sourceRepository)) {
    assert.deepEqual(readFileSync(join(materialized.repoDir, file)), readFileSync(join(sourceRepository, file)));
  }
  assert.equal(lstatSync(join(materialized.repoDir, 'scripts', 'check.sh')).mode & 0o777, 0o755);
  assert.match(execFileSync('git', ['-C', materialized.repoDir, 'ls-files', '-s', 'scripts/check.sh'], { encoding: 'utf8' }), /^100755 /);
  assert.deepEqual(treeFiles(materialized.packageDir), treeFiles(join(f.leaf, 'input', 'package')));
  assert.equal(existsSync(materialized.projectContext), true);

  const subjects = execFileSync('git', ['-C', materialized.repoDir, 'log', '--format=%s'], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(subjects, ['Fixture']);

  const canonical = canonicalPackage(materialized.packageDir);
  assert.equal(canonical.primary, materialized.repoDir);
});

test('materialize writes .gitignore only when the fixture provides none', t => {
  const f = fixture(t);
  const run = runFixture(f, { repeats: 2 });
  const generated = materializeCell(run, run.cells[0], loadScenario(f.leaf));
  assert.equal(readFileSync(join(generated.repoDir, '.gitignore'), 'utf8'), '.specs/\n');

  writeFixtureFile(join(f.leaf, 'input', 'repository', '.gitignore'), 'dist/\n');
  const provided = materializeCell(run, run.cells[1], loadScenario(f.leaf));
  assert.equal(readFileSync(join(provided.repoDir, '.gitignore'), 'utf8'), 'dist/\n');
});

test('materialize refuses colliding cell selectors before creating the run', t => {
  const f = fixture(t);
  const before = readdirSync(f.root).sort();
  assert.throws(
    () => runFixture(f, { models: ['provider/a/b', 'provider/a-b'] }),
    error => error.message.includes('provider/a/b') && error.message.includes('provider/a-b'),
  );
  assert.throws(
    () => runFixture(f, { models: ['provider/model', 'provider/model'] }),
    error => error.message.includes('provider/model'),
  );
  assert.deepEqual(readdirSync(f.root).sort(), before);
});

test('containment: every created path stays under the run directory', t => {
  const f = fixture(t);
  const run = runFixture(f);
  freezeManifest(run);
  materializeCell(run, run.cells[0], loadScenario(f.leaf));
  writeRunRecord(run, { run_id: run.runId, cells: [] });

  assert.deepEqual(readdirSync(f.root).sort(), ['gym', run.runId].sort());
  assert.deepEqual(readdirSync(run.runDir).sort(), [run.cells[0].id, 'manifest.json', 'run.json'].sort());
  assert.ok(run.runDir.startsWith(f.root + sep));
  for (const file of treeFiles(f.root)) {
    const absolute = join(f.root, file);
    assert.ok(absolute.startsWith(f.gym + sep) || absolute.startsWith(run.runDir + sep), absolute);
  }
});

test('immutable: scenario tree digest is unchanged by materialization', t => {
  const f = fixture(t);
  const before = digestTree(f.leaf);
  const run = runFixture(f);
  freezeManifest(run);
  materializeCell(run, run.cells[0], loadScenario(f.leaf));
  assert.equal(digestTree(f.leaf), before);
});

test('immutable: manifest skill digest distinguishes distinct raw bytes', t => {
  const f = fixture(t);
  const skillFile = join(f.gym, 'skills', 'spec-a', 'SKILL.md');
  const run = runFixture(f);
  writeFileSync(skillFile, Buffer.from([0x80]));
  const first = freezeManifest(run).skill_sha256;
  writeFileSync(skillFile, Buffer.from([0x81]));
  const second = freezeManifest(run).skill_sha256;
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});

test('immutable: managed manifest freezes the owner profile the runtime loads', t => {
  const f = fixture(t);
  const ownerProfile = join(f.gym, 'pi', 'agents', 'spec-step-owner.md');
  assert.equal(freezeManifest(runFixture(f)).managed_sha256, undefined);
  const run = runFixture(f, { scenarios: [f.managed] });
  writeFixtureFile(ownerProfile, '# owner v1\n');
  const first = freezeManifest(run);
  writeFileSync(ownerProfile, '# owner v2\n');
  const second = freezeManifest(run);
  assert.match(first.managed_sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(first.managed_sha256, second.managed_sha256);
  assert.equal(first.skill_sha256, second.skill_sha256);
});

test('materialize rejects traversal cell IDs before writing', t => {
  const f = fixture(t);
  const run = runFixture(f);
  const scenario = loadScenario(f.leaf);
  for (const cell of ['../outside', '.', '..', 'nested/cell', { id: '../outside' }]) {
    assert.throws(() => materializeCell(run, cell, scenario), error => error.message.includes('cell id'));
  }
  assert.equal(existsSync(join(f.root, 'outside')), false);
  assert.equal(existsSync(join(run.runDir, 'nested')), false);
  assert.deepEqual(readdirSync(run.runDir), []);
});

test('symlink and dot-dot fixtures are rejected before writing', t => {
  const f = fixture(t);
  const run = runFixture(f);
  const cell = run.cells[0];
  const cellDir = join(run.runDir, cell.id);

  symlinkSync(join(f.leaf, 'input', 'repository', 'README.md'), join(f.leaf, 'input', 'link.md'));
  assert.throws(() => materializeCell(run, cell, loadScenario(f.leaf)), error => error.message.includes('input/link.md'));
  assert.equal(existsSync(cellDir), false);

  rmSync(join(f.leaf, 'input', 'link.md'));
  const broken = loadScenario(f.leaf);
  broken.scenario.fixture.feature = '../x';
  assert.throws(() => materializeCell(run, cell, broken), error => error.message.includes('../x'));
  assert.equal(existsSync(cellDir), false);
});

test('environment allowlist passes only listed names', () => {
  const result = cellEnvironment({
    PATH: '/usr/bin', HOME: '/home/test', SECRET_TOKEN: 'secret', PI_FOO: 'foo', OPENAI_API_KEY: 'key', MIX_ENV: 'mix',
  });
  assert.deepEqual(result, { PATH: '/usr/bin', HOME: '/home/test', PI_FOO: 'foo', OPENAI_API_KEY: 'key' });
});

test('ambient context lists ancestor AGENTS.md and ~/.pi/agent files', t => {
  const f = fixture(t);
  const home = join(f.root, 'home');
  const run = runFixture(f);
  const repoDir = join(run.runDir, run.cells[0].id, 'repo');
  assert.deepEqual(ambientContext(repoDir, { home }), []);

  writeFixtureFile(join(home, '.pi', 'agent', 'AGENTS.md'), 'home agent\n');
  writeFixtureFile(join(f.root, 'AGENTS.md'), 'root agent\n');
  assert.deepEqual(ambientContext(repoDir, { home }), [join(f.root, 'AGENTS.md'), join(home, '.pi', 'agent', 'AGENTS.md')].sort());

  // --no-context-files does not suppress the agent directory's system prompt.
  writeFixtureFile(join(home, '.pi', 'agent', 'APPEND_SYSTEM.md'), 'appended\n');
  assert.ok(ambientContext(repoDir, { home }).includes(join(home, '.pi', 'agent', 'APPEND_SYSTEM.md')));
});

test('manifest freezes provenance before the first materialize call', t => {
  const f = fixture(t);
  const fakePi = join(f.root, 'fake-pi-no-version.sh');
  writeFileSync(fakePi, '#!/bin/sh\necho "usage: fake-pi" >&2\nexit 1\n', { mode: 0o755 });
  process.env.SPEC_GYM_UNLISTED_SECRET = 'value-that-must-not-appear';
  t.after(() => delete process.env.SPEC_GYM_UNLISTED_SECRET);

  const run = runFixture(f, { models: ['provider/model:high'], pi: fakePi });
  const manifest = freezeManifest(run);

  const manifestPath = join(run.runDir, 'manifest.json');
  assert.equal(existsSync(manifestPath), true);
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), manifest);
  assert.equal(existsSync(join(run.runDir, run.cells[0].id)), false);

  assert.deepEqual(manifest.gym.head, gitFacts({ repo: f.gym }).head);
  assert.match(manifest.skill_sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.scenarios[0].version, loadScenario(f.leaf).version);
  assert.equal(manifest.cells[0].thinking, 'high');
  assert.equal(manifest.pi.command, fakePi);
  assert.equal(manifest.pi.version, null);
  assert.ok(manifest.env_names.includes('PATH'));
  assert.ok(!manifest.env_names.includes('SPEC_GYM_UNLISTED_SECRET'));
  assert.ok(!JSON.stringify(manifest).includes('value-that-must-not-appear'));
});

test('leaf passes frozen isolation and model arguments', async t => {
  const c = leafCase(t);
  const result = await c.execute();
  assert.equal(result.outcome, 'finished');
  const log = JSON.parse(readFileSync(join(c.materialized.cellDir, 'streams', 'fake-pi-log.json'), 'utf8'));
  assert.deepEqual(log.argv, [
    '--print', '--mode', 'json', '--session', join(c.materialized.cellDir, 'sessions', 'leaf.jsonl'),
    '--no-context-files', '--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--skill', c.run.skillDir, '--append-system-prompt', join(c.run.skillDir, 'SKILL.md'),
    '--provider', 'test', '--model', 'leaf-model', '--thinking', 'low',
    '--', c.scenario.scenario.task,
  ]);
  assert.equal(log.cwd, c.materialized.repoDir);
});

test('leaf env names equal allowlist intersection', async t => {
  const previousFoo = process.env.PI_FOO;
  const previousSecret = process.env.SECRET_TOKEN;
  process.env.PI_FOO = 'foo';
  process.env.SECRET_TOKEN = 'secret';
  t.after(() => {
    if (previousFoo === undefined) delete process.env.PI_FOO; else process.env.PI_FOO = previousFoo;
    if (previousSecret === undefined) delete process.env.SECRET_TOKEN; else process.env.SECRET_TOKEN = previousSecret;
  });
  const c = leafCase(t);
  await c.execute();
  const log = JSON.parse(readFileSync(join(c.materialized.cellDir, 'streams', 'fake-pi-log.json'), 'utf8'));
  assert.ok(log.envNames.includes('PATH'));
  assert.ok(log.envNames.includes('PI_FOO'));
  assert.ok(!log.envNames.includes('SECRET_TOKEN'));
});

test('leaf hang is timed-out and group is gone', async t => {
  const c = leafCase(t, { script: 'hang', timeoutMs: 500 });
  const result = await c.execute();
  assert.equal(result.outcome, 'timed-out');
  assert.equal(result.reason, 'deadline exceeded');
  assert.ok(result.elapsed_ms >= 500, `elapsed_ms ${result.elapsed_ms}`);
  assert.throws(() => process.kill(-result.pid, 0), error => error.code === 'ESRCH');
  assert.ok(readFileSync(join(c.materialized.cellDir, 'streams', 'leaf.jsonl'), 'utf8').trim().length > 0);
});

test('leaf timeout keeps escalating until a TERM-resistant descendant is gone', { timeout: 15000 }, async t => {
  const c = leafCase(t, { script: 'stubborn', timeoutMs: 500 });
  const result = await c.execute();
  assert.equal(result.outcome, 'timed-out');
  assert.equal(result.reason, 'deadline exceeded');
  assert.ok(result.elapsed_ms >= 500, `elapsed_ms ${result.elapsed_ms}`);
  assert.throws(() => process.kill(-result.pid, 0), error => error.code === 'ESRCH');
});

test('leaf zero exit without a final assistant event is blocked', async t => {
  const c = leafCase(t, { script: 'no-final' });
  const result = await c.execute();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason, 'Pi exited without a final assistant result');
  assert.equal(result.text, '');
  assert.equal(result.stream, join(c.materialized.cellDir, 'streams', 'leaf.jsonl'));
});

test('leaf zero exit after a tool request is blocked', async t => {
  const c = leafCase(t, { script: 'tool-use' });
  const result = await c.execute();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason, 'Pi exited without a final assistant result');
  assert.equal(result.stop_reason, 'toolUse');
  assert.match(readFileSync(result.stream, 'utf8'), /"stopReason":"toolUse"/);
});

test('leaf error exit is blocked not failed', async t => {
  const errorCase = leafCase(t, { script: 'error' });
  const errorResult = await errorCase.execute();
  assert.equal(errorResult.outcome, 'blocked');
  assert.match(errorResult.reason, /unknown model/);
  assert.equal(errorResult.configuration_failure?.kind, 'model_configuration');

  const exitCase = leafCase(t, { script: 'exit-2' });
  const exitResult = await exitCase.execute();
  assert.equal(exitResult.outcome, 'blocked');
  assert.match(exitResult.reason, /Pi exited 2/);
});

test('leaf unpriced cost is unknown', async t => {
  const c = leafCase(t, { script: 'unpriced' });
  const result = await c.execute();
  assert.equal(result.outcome, 'finished');
  assert.equal(result.cost_usd, null);
  assert.equal(result.tokens.input_tokens, 100);
  assert.equal(result.tokens.output_tokens, 20);
});

test('leaf priced cost is summed', async t => {
  const c = leafCase(t, { script: 'success' });
  const result = await c.execute();
  assert.equal(result.outcome, 'finished');
  assert.equal(result.cost_usd, 0.25);
  assert.equal(result.tokens.input_tokens, 100);
  assert.equal(result.tokens.output_tokens, 20);
});

test('leaf writes stay inside the cell', async t => {
  const c = leafCase(t);
  const rootBefore = readdirSync(c.f.root).sort();
  const result = await c.execute();
  assert.equal(result.outcome, 'finished');
  assert.ok(existsSync(join(c.materialized.cellDir, 'sessions')));
  assert.ok(existsSync(join(c.materialized.cellDir, 'streams')));
  assert.deepEqual(readdirSync(c.f.root).sort(), rootBefore);
});

test('managed success hosts Runtime with a cell-local index and exact owner argv', { timeout: 10000 }, async t => {
  const c = managedCase(t);
  const rootBefore = readdirSync(c.f.root).sort();
  const digestBefore = digestTree(c.f.managed);
  const result = await c.execute();

  assert.equal(result.outcome, 'finished');
  assert.equal(result.state, 'completed');
  assert.equal(existsSync(join(c.home, '.pi', 'agent', 'spec-runtime')), false);

  const pointer = JSON.parse(readFileSync(join(c.run.runDir, 'index', `${result.run_id}.json`), 'utf8'));
  assert.equal(pointer.package, canonicalPackage(c.materialized.packageDir).packagePath);
  assert.equal(pointer.manifest, join(c.materialized.packageDir, 'runtime', 'runs', `${result.run_id}.json`));

  const raw = loadRun(c.materialized.packageDir, result.run_id);
  assert.equal(raw.state, 'completed');
  assert.equal(raw.owner_model, 'test/owner-model');
  assert.equal(raw.editor_model, 'test/editor-model');
  assert.equal(raw.scout_model, 'test/scout-model');
  assert.deepEqual(raw.child_extensions, [c.childExtension]);

  const log = JSON.parse(readFileSync(c.logPath, 'utf8'));
  assert.deepEqual(log.argv.slice(0, 11), [
    '--no-context-files', '--no-mcp', '--print', '--mode', 'json', '--session', raw.owner_session,
    '--provider', 'test', '--model', 'owner-model',
  ]);
  assert.equal(log.argv.at(-2), '--');
  assert.ok(log.argv.at(-1).includes(`${c.scenario.scenario.task}\nEnvironment paths (observations, not setup approval): `));
  assert.ok(log.argv.includes(c.childExtension));
  assert.equal(log.cwd, raw.checkout);

  assert.equal(raw.checkout, join(c.materialized.cellDir, 'checkout'));
  const commonDir = execFileSync('git', ['-C', raw.checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  assert.equal(commonDir, join(c.materialized.repoDir, '.git'));

  assert.deepEqual(result.sessions, [raw.owner_session, raw.editor_session]);
  assert.deepEqual(result.checks_root, { package: c.materialized.packageDir, repo: c.materialized.repoDir, checkout: raw.checkout });
  assert.equal(result.pid, raw.pid);
  assert.equal(result.text, 'Completed the leaf task.');
  assert.equal(result.tokens.input_tokens, 100);
  assert.equal(result.tokens.output_tokens, 20);
  assert.equal(result.cost_usd, 0.25);

  assert.equal(process.env, c.env.object);
  assert.deepEqual({ ...process.env }, c.env.values);
  assert.ok(log.envNames.includes('HOME'));
  assert.ok(!log.envNames.includes('SECRET_TOKEN'));

  assert.deepEqual(readdirSync(c.f.root).sort(), rootBefore);
  assert.equal(digestTree(c.f.managed), digestBefore);
});

test('managed hang is cancelled and timed-out with a retained partial stream', { timeout: 15000 }, async t => {
  const c = managedCase(t, { script: 'hang', timeoutMs: 500 });
  const result = await c.execute();

  assert.equal(result.outcome, 'timed-out');
  assert.equal(result.state, 'cancelled');
  assert.equal(result.reason, 'deadline exceeded');
  const raw = loadRun(c.materialized.packageDir, result.run_id);
  assert.equal(raw.state, 'cancelled');
  const events = readFileSync(join(c.materialized.packageDir, 'runtime', 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(entry => entry.event === 'deadline_reached' && entry.run_id === result.run_id));
  assert.throws(() => process.kill(-result.pid, 0), error => error.code === 'ESRCH');

  const runsDir = join(c.materialized.packageDir, 'runtime', 'runs');
  const streams = readdirSync(runsDir).filter(name => name.startsWith(`${result.run_id}-owner-`) && name.endsWith('.jsonl'));
  assert.equal(streams.length, 1);
  assert.ok(readFileSync(join(runsDir, streams[0]), 'utf8').length > 0);

  assert.equal(process.env, c.env.object);
  assert.deepEqual({ ...process.env }, c.env.values);
  assert.ok(!JSON.parse(readFileSync(c.logPath, 'utf8')).envNames.includes('SECRET_TOKEN'));
});

test('managed configuration failure is blocked and restores env', { timeout: 10000 }, async t => {
  const c = managedCase(t, { script: 'error' });
  const result = await c.execute();

  assert.equal(result.outcome, 'blocked');
  assert.equal(result.state, 'failed');
  assert.match(result.reason, /unknown model/);
  assert.equal(result.configuration_failure?.kind, 'model_configuration');
  const raw = loadRun(c.materialized.packageDir, result.run_id);
  assert.equal(raw.state, 'failed');
  assert.match(raw.error, /unknown model/);

  assert.equal(process.env, c.env.object);
  assert.deepEqual({ ...process.env }, c.env.values);
  assert.ok(!JSON.parse(readFileSync(c.logPath, 'utf8')).envNames.includes('SECRET_TOKEN'));
});

test('managed ambient context refusal covers ancestor and home files', { timeout: 10000 }, async t => {
  const placements = [
    { name: 'ancestor AGENTS.md', plant: c => join(c.f.root, 'AGENTS.md') },
    { name: 'ancestor CLAUDE.md', plant: c => join(c.run.runDir, 'CLAUDE.md') },
    { name: 'home AGENTS.md', plant: c => join(c.home, '.pi', 'agent', 'AGENTS.md') },
  ];
  for (const { name, plant } of placements) {
    await t.test(name, async sub => {
      const c = managedCase(sub);
      const planted = plant(c);
      writeFixtureFile(planted, 'ambient\n');
      const result = await c.execute();

      assert.equal(result.outcome, 'invalid');
      assert.equal(result.reason, 'ambient-context');
      assert.ok(result.detail.includes(planted));
      assert.equal(existsSync(join(c.materialized.packageDir, 'runtime')), false);
      assert.equal(existsSync(c.logPath), false);
      assert.equal(existsSync(join(c.run.runDir, 'index')), false);
      assert.equal(process.env, c.env.object);
      assert.deepEqual({ ...process.env }, c.env.values);
    });
  }
});

test('managed missing step card is blocked before launch and restores env', { timeout: 10000 }, async t => {
  const c = managedCase(t);
  rmSync(join(c.materialized.packageDir, 'step-001-subspec.md'));
  const result = await c.execute();

  assert.equal(result.outcome, 'blocked');
  assert.equal(result.state, 'blocked');
  assert.match(result.reason, /step-001-subspec\.md/);
  assert.equal(existsSync(join(c.materialized.packageDir, 'runtime')), false);
  assert.equal(existsSync(c.logPath), false);
  assert.equal(process.env, c.env.object);
  assert.deepEqual({ ...process.env }, c.env.values);
});

test('managed assignment reuse returns the terminal record without relaunching', { timeout: 10000 }, async t => {
  const c = managedCase(t);
  const first = await c.execute();
  const second = await c.execute();

  assert.equal(first.outcome, 'finished');
  assert.equal(second.outcome, 'finished');
  assert.equal(second.state, 'completed');
  assert.equal(second.run_id, first.run_id);
  assert.deepEqual(second.sessions, first.sessions);
  assert.equal(process.env, c.env.object);
  assert.deepEqual({ ...process.env }, c.env.values);
});

test('cli run freezes manifest before the first cell and rewrites run.json per cell', { timeout: 30000 }, async t => {
  const f = cliFixture(t);
  const runRoot = join(f.root, 'runs');
  mkdirSync(runRoot, { recursive: true });
  const snapshots = join(f.root, 'snapshots');
  const result = await runCli([
    'run', '--skill', 'spec-a', '--scenario', 'leaf-case',
    '--model', 'test/leaf-model:low', '--model', 'test/leaf-model:high',
    '--root', runRoot, '--pi', stubPiCommand(f.root),
  ], { f, env: { SPEC_GYM_FAKE_PI_SCRIPT: 'success', SPEC_GYM_FAKE_PI_LOG: join(f.root, 'fake-pi-log.json'), SPEC_GYM_FAKE_PI_RUN_SNAPSHOT: snapshots } });
  assert.equal(result.code, 0, result.stderr);

  const runId = readdirSync(runRoot)[0];
  const runDir = join(runRoot, runId);
  const record = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  assert.deepEqual(record.cells.map(cell => [cell.state, cell.outcome]), [['finished', 'passed'], ['finished', 'passed']]);
  assert.ok(statSync(join(runDir, 'manifest.json')).mtimeMs <= statSync(join(runDir, record.cells[0].id)).mtimeMs);

  const firstSnapshot = JSON.parse(readFileSync(join(snapshots, `${record.cells[0].id}.json`), 'utf8'));
  assert.equal(firstSnapshot.cells[0].state, 'running');
  assert.equal(firstSnapshot.cells[1].state, 'pending');
});

test('cli run prints start and finish lines in order', { timeout: 30000 }, async t => {
  const f = cliFixture(t);
  const runRoot = join(f.root, 'runs');
  mkdirSync(runRoot, { recursive: true });
  const result = await runCli([
    'run', '--skill', 'spec-a', '--scenario', 'leaf-case',
    '--model', 'test/leaf-model:low', '--model', 'test/leaf-model:high',
    '--root', runRoot, '--pi', stubPiCommand(f.root),
  ], { f, env: { SPEC_GYM_FAKE_PI_SCRIPT: 'success', SPEC_GYM_FAKE_PI_LOG: join(f.root, 'fake-pi-log.json') } });
  assert.equal(result.code, 0, result.stderr);

  const runDir = join(runRoot, readdirSync(runRoot)[0]);
  const record = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  const [first, second] = record.cells.map(cell => cell.id);
  let cursor = -1;
  for (const marker of [`start ${first}`, `finish ${first} passed`, `start ${second}`, `finish ${second} passed`]) {
    const at = result.stdout.indexOf(marker, cursor + 1);
    assert.ok(at > cursor, `${marker} out of order in ${result.stdout}`);
    cursor = at;
  }

  const report = readFileSync(join(runDir, 'report.md'), 'utf8');
  const rows = report.split('\n').filter(line => line.startsWith('| ')).filter(line => !/^\|[\s|:-]+\|$/.test(line)).slice(1);
  assert.equal(rows.length, 2);
  assert.ok(report.includes('Label: matched'));
});

test('cli run refuses draft scenario before creating a run directory', { timeout: 30000 }, async t => {
  const f = cliFixture(t, { status: 'draft' });
  const runRoot = join(f.root, 'runs');
  mkdirSync(runRoot, { recursive: true });
  const result = await runCli([
    'run', '--skill', 'spec-a', '--scenario', 'leaf-case', '--model', 'test/leaf-model',
    '--root', runRoot, '--pi', stubPiCommand(f.root),
  ], { f });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /leaf-case/);
  assert.match(result.stderr, /draft/);
  assert.deepEqual(readdirSync(runRoot), []);
});

test('cli run refuses a skill without an index', { timeout: 30000 }, async t => {
  const f = cliFixture(t);
  const runRoot = join(f.root, 'runs');
  mkdirSync(runRoot, { recursive: true });
  const result = await runCli([
    'run', '--skill', 'spec-b', '--scenario', 'leaf-case', '--model', 'test/leaf-model',
    '--root', runRoot, '--pi', stubPiCommand(f.root),
  ], { f });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /scenarios\/spec-b\/scenarios\.md/);
});

test('cli run marks invalid selector blocked without substitution', { timeout: 30000 }, async t => {
  const f = cliFixture(t);
  const runRoot = join(f.root, 'runs');
  mkdirSync(runRoot, { recursive: true });
  const result = await runCli([
    'run', '--skill', 'spec-a', '--scenario', 'leaf-case', '--model', 'test/owner-model',
    '--root', runRoot, '--pi', stubPiCommand(f.root),
  ], { f, env: { SPEC_GYM_FAKE_PI_LOG: join(f.root, 'fake-pi-log.json'), SPEC_GYM_FAKE_PI_SCRIPT: 'error' } });
  assert.equal(result.code, 0, result.stderr);

  const record = JSON.parse(readFileSync(join(runRoot, readdirSync(runRoot)[0], 'run.json'), 'utf8'));
  assert.equal(record.cells.length, 1);
  assert.equal(record.cells[0].outcome, 'blocked');
  assert.match(record.cells[0].reason, /unknown model/);
});

test('cli validate detects drift and write-index repairs it', { timeout: 30000 }, async t => {
  const f = cliFixture(t);
  writeFileSync(join(f.gym, 'scenarios', 'spec-a', 'scenarios.md'), '# stale\n');

  const drifted = await runCli(['validate', '--skill', 'spec-a'], { f });
  assert.equal(drifted.code, 1);
  assert.match(drifted.stderr, /index drift: /);
  assert.match(drifted.stderr, /scenarios\/spec-a\/scenarios\.md/);

  const repaired = await runCli(['validate', '--skill', 'spec-a', '--write-index'], { f });
  assert.equal(repaired.code, 0, repaired.stderr);
  const clean = await runCli(['validate', '--skill', 'spec-a'], { f });
  assert.equal(clean.code, 0, clean.stderr);
});

test('cli list prints eligible skills and no curated scenarios', { timeout: 30000 }, async t => {
  const f = cliFixture(t);
  const result = await runCli(['list'], { f });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^spec-a: leaf-case ready [0-9a-f]{12} leaf$/m);
  assert.match(result.stdout, /^spec-b: no curated scenarios$/m);
});

test('cli run writes partial report on SIGINT', { timeout: 30000 }, async t => {
  const f = cliFixture(t);
  const runRoot = join(f.root, 'runs');
  mkdirSync(runRoot, { recursive: true });
  const logPath = join(f.root, 'fake-pi-log.json');
  const cli = spawnCli([
    'run', '--skill', 'spec-a', '--scenario', 'leaf-case', '--model', 'test/leaf-model',
    '--timeout-ms', '600000', '--root', runRoot, '--pi', stubPiCommand(f.root),
  ], { f, env: { SPEC_GYM_FAKE_PI_LOG: logPath, SPEC_GYM_FAKE_PI_SCRIPT: 'hang' } });
  t.after(() => { try { cli.child.kill('SIGKILL'); } catch { /* already gone */ } });

  assert.ok(await waitFor(() => cli.stdout().includes('start ')), `no start line: ${cli.stdout()} ${cli.stderr()}`);
  assert.ok(await waitFor(() => existsSync(logPath)), 'no stub log');
  const pid = JSON.parse(readFileSync(logPath, 'utf8')).pid;
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } });

  cli.child.kill('SIGINT');
  const result = await cli.done;
  assert.equal(result.code, 130, result.stderr);

  const runDir = join(runRoot, readdirSync(runRoot)[0]);
  assert.match(readFileSync(join(runDir, 'report.md'), 'utf8'), /aborted/);
  assert.throws(() => process.kill(-pid, 0), error => error.code === 'ESRCH');
});

test('cli run SIGINT escalation kills a TERM-resistant descendant group and exits 130', { timeout: 30000 }, async t => {
  const f = cliFixture(t);
  const runRoot = join(f.root, 'runs');
  mkdirSync(runRoot, { recursive: true });
  const logPath = join(f.root, 'fake-pi-log.json');
  const cli = spawnCli([
    'run', '--skill', 'spec-a', '--scenario', 'leaf-case', '--model', 'test/leaf-model',
    '--timeout-ms', '600000', '--root', runRoot, '--pi', stubPiCommand(f.root),
  ], { f, detached: true, env: { SPEC_GYM_FAKE_PI_LOG: logPath, SPEC_GYM_FAKE_PI_SCRIPT: 'stubborn' } });
  t.after(() => { try { process.kill(-cli.child.pid, 'SIGKILL'); } catch { /* already gone */ } });

  assert.ok(await waitFor(() => cli.stdout().includes('start ')), `no start line: ${cli.stdout()} ${cli.stderr()}`);
  assert.ok(await waitFor(() => {
    if (!existsSync(logPath)) return false;
    try { return Number.isInteger(JSON.parse(readFileSync(logPath, 'utf8')).stubborn_child); } catch { return false; }
  }), 'no TERM-resistant descendant');
  assert.ok(await waitFor(() => existsSync(`${logPath}.descendant-ready`)), 'descendant did not arm its SIGTERM handler');
  const pid = JSON.parse(readFileSync(logPath, 'utf8')).pid;
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } });

  cli.child.kill('SIGINT');
  const result = await cli.done;
  assert.equal(result.code, 130, result.stderr);

  const runDir = join(runRoot, readdirSync(runRoot)[0]);
  assert.match(readFileSync(join(runDir, 'report.md'), 'utf8'), /aborted/);
  assert.throws(() => process.kill(-pid, 0), error => error.code === 'ESRCH');
});

test('cli run refuses a ready scenario with empty checks before creating a run directory', { timeout: 30000 }, async t => {
  const f = cliFixture(t);
  writeScenario(f.leaf, { ...leafScenario(), status: 'ready', checks: [] });
  writeFixtureFile(join(f.gym, 'scenarios', 'spec-a', 'scenarios.md'), renderIndex('spec-a', [loadScenario(f.leaf), loadScenario(f.managed)]));
  const runRoot = join(f.root, 'runs');
  mkdirSync(runRoot, { recursive: true });
  const result = await runCli([
    'run', '--skill', 'spec-a', '--scenario', 'leaf-case', '--model', 'test/leaf-model',
    '--root', runRoot, '--pi', stubPiCommand(f.root),
  ], { f });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /ready scenario requires a non-empty checks array/);
  assert.deepEqual(readdirSync(runRoot), []);
});

test('cli run refuses a ready scenario with an untracked fixture before creating a run directory', { timeout: 30000 }, async t => {
  const f = cliFixture(t);
  writeFixtureFile(join(f.leaf, 'input', 'package', 'untracked.md'), 'not committed\n');
  writeFixtureFile(join(f.gym, 'scenarios', 'spec-a', 'scenarios.md'), renderIndex('spec-a', [loadScenario(f.leaf), loadScenario(f.managed)]));
  const runRoot = join(f.root, 'runs');
  mkdirSync(runRoot, { recursive: true });
  const result = await runCli([
    'run', '--skill', 'spec-a', '--scenario', 'leaf-case', '--model', 'test/leaf-model',
    '--root', runRoot, '--pi', stubPiCommand(f.root),
  ], { f });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /input\/package\/untracked\.md: untracked by Git/);
  assert.deepEqual(readdirSync(runRoot), []);
});

test('cli run refuses a stale scenario index before creating a run directory', { timeout: 30000 }, async t => {
  const f = cliFixture(t);
  writeFileSync(join(f.gym, 'scenarios', 'spec-a', 'scenarios.md'), '# stale\n');
  const runRoot = join(f.root, 'runs');
  mkdirSync(runRoot, { recursive: true });
  const result = await runCli([
    'run', '--skill', 'spec-a', '--scenario', 'leaf-case', '--model', 'test/leaf-model',
    '--root', runRoot, '--pi', stubPiCommand(f.root),
  ], { f });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /index drift: /);
  assert.match(result.stderr, /scenarios\/spec-a\/scenarios\.md/);
  assert.deepEqual(readdirSync(runRoot), []);
});

test('cli managed campaign records finished scheduling state and report artifact links', { timeout: 30000 }, async t => {
  const f = cliFixture(t);
  writeScenario(f.managed, { ...managedScenario(), status: 'ready' });
  writeFixtureFile(join(f.gym, 'scenarios', 'spec-a', 'scenarios.md'), renderIndex('spec-a', [loadScenario(f.leaf), loadScenario(f.managed)]));
  const runRoot = join(f.root, 'runs');
  mkdirSync(runRoot, { recursive: true });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'spec-gym-cli-managed-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = await runCli([
    'run', '--skill', 'spec-a', '--scenario', 'managed-case', '--model', 'test/owner-model',
    '--root', runRoot, '--pi', stubPiCommand(f.root),
  ], { f, env: { HOME: home, SPEC_GYM_FAKE_PI_LOG: join(f.root, 'fake-pi-managed.json'), SPEC_GYM_FAKE_PI_SCRIPT: 'success' } });
  assert.equal(result.code, 0, result.stderr);

  const runDir = join(runRoot, readdirSync(runRoot)[0]);
  const record = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  assert.equal(record.cells.length, 1);
  const [cell] = record.cells;
  assert.equal(cell.state, 'finished');
  assert.equal(cell.outcome, 'passed');

  const runtimeRecord = loadRun(join(runDir, cell.id, 'repo', '.specs', 'example-feature'));
  assert.equal(runtimeRecord.state, 'completed');

  for (const name of ['owner_session', 'run_receipt', 'events']) {
    assert.equal(typeof cell.artifacts[name], 'string', `missing artifact ${name}`);
  }
  for (const [name, path] of Object.entries(cell.artifacts)) {
    assert.equal(existsSync(join(runDir, path)), true, `${name}: ${path}`);
  }
  // The stub owner never dispatches an editor; an unlaunched transcript must not be linked.
  assert.equal('editor_session' in cell.artifacts, existsSync(runtimeRecord.editor_session));
  const report = readFileSync(join(runDir, 'report.md'), 'utf8');
  for (const [name, path] of Object.entries(cell.artifacts)) {
    assert.ok(report.includes(`[${name}](${path})`), `missing ${name} link in report`);
  }
});
