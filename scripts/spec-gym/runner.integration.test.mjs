import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { canonicalPackage } from '../../pi/extensions/spec-runtime/runtime.mjs';
import { gitFacts } from '../spec-facts/core.mjs';
import { PREPARED_PACKAGE_FILES, loadScenario } from './core.mjs';
import { ambientContext, cellEnvironment, createRun, freezeManifest, materializeCell, writeRunRecord } from './runner.mjs';

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
    writeFixtureFile(join(managed, 'input', 'package', name), `${name}\n`);
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
