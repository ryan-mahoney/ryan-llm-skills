import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexDrift, loadScenario, validateScenario } from './core.mjs';
import { extract } from './extract.mjs';
import { createRun, materializeCell } from './runner.mjs';

function writeFixture(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function digestTree(root) {
  const hash = createHash('sha256');
  const entries = [];
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) entries.push([relative(root, path), Buffer.from(readlinkSync(path))]);
      else if (info.isDirectory()) visit(path);
      else entries.push([relative(root, path), readFileSync(path)]);
    }
  };
  visit(root);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, content] of entries) {
    hash.update(`${name}\0`);
    hash.update(content);
  }
  return hash.digest('hex');
}

function extractFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spec-gym-extract-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'source-repo');
  const sourcePackage = join(repo, '.specs', 'example-feature');
  const projectContext = join(repo, '.specs', 'project-context.md');
  const gym = join(root, 'gym');
  const skillsDir = join(gym, 'skills');
  const scenariosRoot = join(gym, 'scenarios');

  mkdirSync(repo, { recursive: true });
  writeFixture(join(repo, '.gitignore'), '.specs/\n');
  writeFixture(join(repo, 'src', 'app.mjs'), 'export const version = 1;\n');
  writeFixture(join(repo, 'src', 'paths.txt'), `package=${sourcePackage}\nhome=${repo}/notes.md\n`);
  writeFixture(join(repo, 'src', 'blob.bin'), Buffer.from([0, 1, 2, 255, 0, 65, 10]));
  writeFixture(join(repo, 'scripts', 'check.sh'), '#!/bin/sh\nprintf "checked\\n"\n');
  chmodSync(join(repo, 'scripts', 'check.sh'), 0o755);
  symlinkSync('app.mjs', join(repo, 'src', 'link.mjs'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Spec Gym Extract Test');
  git(repo, 'config', 'user.email', 'spec-gym-extract@example.invalid');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'A');
  const shaA = git(repo, 'rev-parse', 'HEAD');
  writeFixture(join(repo, 'src', 'app.mjs'), 'export const version = 2;\n');
  writeFixture(join(repo, 'src', 'impl.mjs'), 'export const implemented = true;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'B');
  const shaB = git(repo, 'rev-parse', 'HEAD');
  chmodSync(join(repo, 'scripts', 'check.sh'), 0o644);
  writeFixture(join(repo, 'src', 'app.mjs'), 'export const version = 3;\n');

  writeFixture(join(sourcePackage, 'requirements.md'), '# Requirements\n');
  writeFixture(join(sourcePackage, 'context.md'), [
    '# Context',
    `package:${sourcePackage}`,
    `package-again:${sourcePackage}`,
    `home:${repo}/notes.md`,
    `overlap:${sourcePackage}/nested`,
    '',
  ].join('\n'));
  writeFixture(join(sourcePackage, 'spec.md'), '# Spec\n');
  writeFixture(join(sourcePackage, 'spec-prepare.md'), '# Prepare\n');
  writeFixture(join(sourcePackage, 'evidence-plan.json'), `${JSON.stringify({ package: sourcePackage, home: repo }, null, 2)}\n`);
  writeFixture(join(sourcePackage, 'spec-steps.json'), `${JSON.stringify({ steps: [{ step: 1, title: 'One' }, { step: 2, title: 'Two' }] }, null, 2)}\n`);
  writeFixture(join(sourcePackage, 'step-001-subspec.md'), '# Step 1\n');
  writeFixture(join(sourcePackage, 'step-002-subspec.md'), '# Step 2\n');
  writeFixture(join(sourcePackage, 'criteria.md'), '# Criteria\n');
  writeFixture(join(sourcePackage, 'invariants.md'), '# Invariants\n');
  writeFixture(join(sourcePackage, 'learnings', 'step-001-learning.md'), 'post-stage learning\n');
  writeFixture(join(sourcePackage, 'reviews', 'review.md'), 'post-stage review\n');
  writeFixture(join(sourcePackage, 'runtime', 'run.json'), '{}\n');
  writeFixture(join(sourcePackage, 'evidence', 'ev-1.txt'), 'post-stage evidence\n');
  writeFixture(join(sourcePackage, 'merge-evidence.md'), 'post-stage merge evidence\n');
  writeFixture(join(sourcePackage, '.env'), 'SECRET=planted\n');
  writeFixture(projectContext, '# Project Context\n');

  writeFixture(join(skillsDir, 'spec-architect-initial', 'SKILL.md'), '# spec-architect-initial\n');
  writeFixture(join(skillsDir, 'spec-step-run', 'SKILL.md'), '# spec-step-run\n');
  mkdirSync(scenariosRoot, { recursive: true });

  return { root, repo, sourcePackage, projectContext, gym, skillsDir, scenariosRoot, shaA, shaB };
}

test('extract architecture copies profile inputs from the pinned revision and leaves sources unchanged', { timeout: 10000 }, t => {
  const f = extractFixture(t);
  const digestBefore = digestTree(f.sourcePackage);
  const statusBefore = git(f.repo, 'status', '--porcelain');
  const result = extract({
    sourcePackage: f.sourcePackage, repo: f.repo, revision: f.shaA,
    skill: 'spec-architect-initial', id: 'arch-candidate',
    include: ['src/app.mjs', 'src/blob.bin', 'src/paths.txt'], scenariosRoot: f.scenariosRoot,
  });

  assert.equal(result.status, 'draft');
  assert.deepEqual(result.missing_inputs, []);
  assert.equal(result.folder, join(f.scenariosRoot, 'spec-architect-initial', 'arch-candidate'));
  assert.deepEqual(readdirSync(join(result.folder, 'input', 'package')).sort(), ['context.md', 'requirements.md']);
  assert.equal(existsSync(join(result.folder, 'input', 'project-context.md')), true);
  assert.equal(existsSync(join(result.folder, 'input', 'repository', 'src', 'impl.mjs')), false);
  assert.deepEqual(readFileSync(join(result.folder, 'input', 'repository', 'src', 'app.mjs')), execFileSync('git', ['-C', f.repo, 'show', `${f.shaA}:src/app.mjs`]));
  assert.deepEqual(readFileSync(join(result.folder, 'input', 'repository', 'src', 'blob.bin')), execFileSync('git', ['-C', f.repo, 'show', `${f.shaA}:src/blob.bin`]));

  const loaded = loadScenario(result.folder);
  assert.equal(loaded.scenario.driver, 'leaf');
  assert.equal(loaded.scenario.status, 'draft');
  assert.equal(loaded.scenario.source.revision, f.shaA);
  assert.equal(validateScenario(result.folder).ok, true);
  assert.equal(indexDrift('spec-architect-initial', join(f.scenariosRoot, 'spec-architect-initial')).same, true);

  assert.equal(digestTree(f.sourcePackage), digestBefore);
  assert.equal(git(f.repo, 'status', '--porcelain'), statusBefore);
});

// Select alone: node --test --test-name-pattern='extract preserves pinned executable|extract refuses a pinned symlink' scripts/spec-gym/extract.integration.test.mjs
test('extract preserves pinned executable modes through materialization', { timeout: 10000 }, t => {
  const f = extractFixture(t);
  const result = extract({
    sourcePackage: f.sourcePackage, repo: f.repo, revision: f.shaA,
    skill: 'spec-architect-initial', id: 'executable-candidate',
    include: ['scripts/check.sh', 'src/app.mjs'], scenariosRoot: f.scenariosRoot,
  });
  assert.equal(lstatSync(join(result.folder, 'input', 'repository', 'scripts', 'check.sh')).mode & 0o777, 0o755);
  assert.equal(lstatSync(join(result.folder, 'input', 'repository', 'src', 'app.mjs')).mode & 0o111, 0);
  const run = createRun({
    repoRoot: f.gym, root: join(f.root, 'runs'), skill: 'spec-architect-initial',
    scenarios: [result.folder], models: ['test/model'], timeoutMs: 10000,
  });
  const materialized = materializeCell(run, run.cells[0], loadScenario(result.folder));
  assert.match(git(materialized.repoDir, 'ls-files', '-s', 'scripts/check.sh'), /^100755 /);
  assert.equal(execFileSync('./scripts/check.sh', { cwd: materialized.repoDir, encoding: 'utf8' }), 'checked\n');
});

test('extract refuses a pinned symlink without publishing or changing an existing scenario', { timeout: 10000 }, t => {
  const f = extractFixture(t);
  const base = {
    sourcePackage: f.sourcePackage, repo: f.repo, revision: f.shaA,
    skill: 'spec-architect-initial', id: 'symlink-candidate', scenariosRoot: f.scenariosRoot,
  };
  const typeFolder = join(f.scenariosRoot, base.skill);
  const statusBefore = git(f.repo, 'status', '--porcelain');
  assert.throws(() => extract({ ...base, include: ['src/link.mjs'] }), /regular repository file.*120000/);
  assert.deepEqual(readdirSync(typeFolder), []);
  const first = extract({ ...base, include: ['src/app.mjs'] });
  const before = digestTree(typeFolder);
  assert.throws(() => extract({ ...base, update: true, include: ['src/link.mjs'] }), /regular repository file.*120000/);
  assert.equal(digestTree(typeFolder), before);
  assert.equal(existsSync(first.folder), true);
  assert.equal(git(f.repo, 'status', '--porcelain'), statusBefore);
});

test('extract step requires --step and copies the prepared set without post-stage artifacts', { timeout: 10000 }, t => {
  const f = extractFixture(t);
  const typeFolder = join(f.scenariosRoot, 'spec-step-run');
  assert.throws(() => extract({
    sourcePackage: f.sourcePackage, repo: f.repo, revision: f.shaA,
    skill: 'spec-step-run', id: 'step-candidate', scenariosRoot: f.scenariosRoot,
  }), /--step/);
  assert.equal(existsSync(join(typeFolder, 'step-candidate')), false);

  const result = extract({
    sourcePackage: f.sourcePackage, repo: f.repo, revision: f.shaA,
    skill: 'spec-step-run', id: 'step-candidate', step: 1, scenariosRoot: f.scenariosRoot,
  });
  const packageFiles = readdirSync(join(result.folder, 'input', 'package')).sort();
  for (const name of ['context.md', 'spec.md', 'spec-prepare.md', 'evidence-plan.json', 'spec-steps.json', 'criteria.md', 'invariants.md', 'step-001-subspec.md', 'step-002-subspec.md']) {
    assert.ok(packageFiles.includes(name), name);
  }
  for (const name of ['learnings', 'reviews', 'runtime', 'evidence', 'merge-evidence.md', '.env']) {
    assert.equal(existsSync(join(result.folder, 'input', 'package', name)), false, name);
  }
  assert.equal(existsSync(join(result.folder, 'input', 'project-context.md')), true);
  assert.equal(JSON.parse(readFileSync(join(result.folder, 'input', 'package', 'spec-steps.json'), 'utf8')).steps.length, 2);

  const loaded = loadScenario(result.folder);
  assert.equal(loaded.scenario.driver, 'managed-step');
  assert.deepEqual(loaded.scenario.roles, { editor_model: 'TODO/editor-model', todo: true });
  assert.deepEqual(loaded.scenario.checks.map(check => check.id), ['run-state', 'learning', 'git-untouched']);
  assert.equal(loaded.scenario.checks.find(check => check.id === 'learning').path, 'learnings/step-001-learning.md');
  assert.equal(loaded.scenario.checks.find(check => check.id === 'git-untouched').todo, true);
  assert.equal(validateScenario(result.folder).ok, true);

  const scenarioPath = join(result.folder, 'scenario.json');
  const original = readFileSync(scenarioPath, 'utf8');
  writeFileSync(scenarioPath, `${JSON.stringify({ ...loaded.scenario, status: 'ready' }, null, 2)}\n`);
  const promoted = validateScenario(result.folder);
  assert.equal(promoted.ok, false);
  assert.ok(promoted.errors.some(error => /todo|expectation_sources|ready/.test(error)), promoted.errors.join('\n'));
  writeFileSync(scenarioPath, original);
});

test('extract records a missing include in the result and on the scenario', { timeout: 10000 }, t => {
  const f = extractFixture(t);
  const result = extract({
    sourcePackage: f.sourcePackage, repo: f.repo, revision: f.shaA,
    skill: 'spec-architect-initial', id: 'missing-candidate',
    include: ['src/absent.mjs', 'src/app.mjs'], scenariosRoot: f.scenariosRoot,
  });

  assert.deepEqual(result.missing_inputs, ['src/absent.mjs']);
  assert.equal(result.status, 'draft');
  assert.equal(existsSync(join(result.folder, 'input', 'repository', 'src', 'absent.mjs')), false);
  assert.equal(existsSync(join(result.folder, 'input', 'repository', 'src', 'app.mjs')), true);
  const stored = JSON.parse(readFileSync(join(result.folder, 'scenario.json'), 'utf8'));
  assert.deepEqual(stored.missing_inputs, ['src/absent.mjs']);
  assert.equal(validateScenario(result.folder).ok, true);
});

test('extract refuses a Git tree include without publishing anything', { timeout: 10000 }, t => {
  const f = extractFixture(t);
  const typeFolder = join(f.scenariosRoot, 'spec-architect-initial');
  assert.throws(() => extract({
    sourcePackage: f.sourcePackage, repo: f.repo, revision: f.shaA,
    skill: 'spec-architect-initial', id: 'tree-candidate', include: ['src'], scenariosRoot: f.scenariosRoot,
  }), error => error.message.includes('"src"') && /repository file/.test(error.message));
  assert.equal(existsSync(join(typeFolder, 'tree-candidate')), false);
  assert.equal(existsSync(join(typeFolder, 'scenarios.md')), false);
  assert.deepEqual(existsSync(typeFolder) ? readdirSync(typeFolder).filter(name => name.startsWith('.tmp-') || name.startsWith('.old-')) : [], []);
});

test('extract refuses denylisted, escaping and malformed inputs before writing', { timeout: 10000 }, t => {
  const f = extractFixture(t);
  const typeFolder = join(f.scenariosRoot, 'spec-architect-initial');
  const base = { sourcePackage: f.sourcePackage, repo: f.repo, revision: f.shaA, skill: 'spec-architect-initial', scenariosRoot: f.scenariosRoot };
  const denied = ['.env', '.env.local', 'nested/auth.json', 'certs/key.pem', 'id_rsa', 'node_modules/x.js', '.git/config', 'a/.env/x'];
  for (const include of denied) {
    assert.throws(() => extract({ ...base, id: 'denied-candidate', include: [include] }), /denylisted/, include);
    assert.equal(existsSync(join(typeFolder, 'denied-candidate')), false, include);
  }
  const malformed = ['../x', '/abs/x', 'C:/x', 'a\\b', 'a//b', './x', '..'];
  for (const include of malformed) {
    assert.throws(() => extract({ ...base, id: 'malformed-candidate', include: [include] }), /POSIX relative|empty, "." or ".."/, include);
    assert.equal(existsSync(join(typeFolder, 'malformed-candidate')), false, include);
  }
  const badIds = ['UPPER', '-dash', 'a', 'x'.repeat(65), 'under_score', 'dot.id'];
  for (const id of badIds) {
    assert.throws(() => extract({ ...base, id }), /must match/, id);
    assert.equal(existsSync(join(typeFolder, id)), false, id);
  }
  const leftovers = existsSync(typeFolder) ? readdirSync(typeFolder).filter(name => name.startsWith('.tmp-') || name.startsWith('.old-')) : [];
  assert.deepEqual(leftovers, []);
});

test('extract refuses unsupported and prototype stage profiles fast', { timeout: 10000 }, t => {
  const f = extractFixture(t);
  const base = { sourcePackage: f.sourcePackage, repo: f.repo, revision: f.shaA, id: 'profile-candidate', scenariosRoot: f.scenariosRoot };
  for (const skill of ['spec-pr', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(() => extract({ ...base, skill }), /unsupported stage profile/, skill);
    assert.equal(existsSync(join(f.scenariosRoot, skill, 'profile-candidate')), false, skill);
  }
  assert.equal(existsSync(join(f.scenariosRoot, 'spec-pr')), false);
});

test('extract refuses an existing id without update and replaces it atomically with update', { timeout: 10000 }, t => {
  const f = extractFixture(t);
  const base = { sourcePackage: f.sourcePackage, repo: f.repo, revision: f.shaA, skill: 'spec-architect-initial', scenariosRoot: f.scenariosRoot };
  const first = extract({ ...base, id: 'candidate', include: ['src/app.mjs'] });
  const digestBefore = digestTree(first.folder);

  assert.throws(() => extract({ ...base, id: 'candidate', include: ['src/impl.mjs'] }), /already exists/);
  assert.equal(digestTree(first.folder), digestBefore);

  const other = extract({ ...base, id: 'other', include: ['src/blob.bin'] });
  const otherDigest = digestTree(other.folder);

  const updated = extract({ ...base, revision: f.shaB, id: 'candidate', include: ['src/impl.mjs'], update: true });
  assert.equal(updated.folder, first.folder);
  assert.equal(existsSync(join(updated.folder, 'input', 'repository', 'src', 'impl.mjs')), true);
  assert.equal(existsSync(join(updated.folder, 'input', 'repository', 'src', 'app.mjs')), false);
  assert.equal(digestTree(other.folder), otherDigest);

  const typeFolder = join(f.scenariosRoot, 'spec-architect-initial');
  const index = readFileSync(join(typeFolder, 'scenarios.md'), 'utf8');
  assert.ok(index.includes('| candidate |'));
  assert.ok(index.includes('| other |'));
  assert.equal(indexDrift('spec-architect-initial', typeFolder).same, true);
  assert.deepEqual(readdirSync(typeFolder).filter(name => name.startsWith('.tmp-') || name.startsWith('.old-')), []);
});

test('extract rewrites package and home literals in Markdown only', { timeout: 10000 }, t => {
  const f = extractFixture(t);
  const result = extract({
    sourcePackage: f.sourcePackage, repo: f.repo, revision: f.shaA,
    skill: 'spec-step-run', id: 'sanitize-candidate', step: 1,
    include: ['src/paths.txt'], scenariosRoot: f.scenariosRoot, home: f.repo,
  });

  assert.equal(result.rewrites, 4);
  assert.equal(readFileSync(join(result.folder, 'input', 'package', 'context.md'), 'utf8'), [
    '# Context',
    'package:<SOURCE_PACKAGE>',
    'package-again:<SOURCE_PACKAGE>',
    'home:<HOME>/notes.md',
    'overlap:<SOURCE_PACKAGE>/nested',
    '',
  ].join('\n'));
  assert.equal(JSON.parse(readFileSync(join(result.folder, 'scenario.json'), 'utf8')).source.rewrites, 4);

  const repositoryCopy = readFileSync(join(result.folder, 'input', 'repository', 'src', 'paths.txt'));
  assert.deepEqual(repositoryCopy, execFileSync('git', ['-C', f.repo, 'show', `${f.shaA}:src/paths.txt`]));
  assert.ok(repositoryCopy.toString('utf8').includes(f.sourcePackage));
  assert.deepEqual(readFileSync(join(result.folder, 'input', 'package', 'evidence-plan.json')), readFileSync(join(f.sourcePackage, 'evidence-plan.json')));
});

test('extract removes temp and keeps the index when the final rename is refused', { timeout: 10000 }, t => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) return t.skip('permission failures cannot be induced in this environment');
  const f = extractFixture(t);
  const typeFolder = join(f.scenariosRoot, 'spec-architect-initial');
  const indexPath = join(typeFolder, 'scenarios.md');
  const indexBefore = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;

  const original = fs.renameSync;
  const renameMock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (basename(String(from)).startsWith('.tmp-') && dirname(String(to)) === typeFolder) {
      chmodSync(typeFolder, 0o555);
      try {
        return original(from, to);
      } finally {
        chmodSync(typeFolder, 0o755);
      }
    }
    return original(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { renameMock.mock.restore(); syncBuiltinESMExports(); });

  assert.throws(() => extract({
    sourcePackage: f.sourcePackage, repo: f.repo, revision: f.shaA,
    skill: 'spec-architect-initial', id: 'rename-candidate', include: ['src/app.mjs'], scenariosRoot: f.scenariosRoot,
  }), /EACCES|EPERM|permission denied/i);
  assert.equal(existsSync(join(typeFolder, 'rename-candidate')), false);
  assert.deepEqual(readdirSync(typeFolder).filter(name => name.startsWith('.tmp-') || name.startsWith('.old-')), []);
  if (indexBefore === null) assert.equal(existsSync(indexPath), false);
  else assert.equal(readFileSync(indexPath, 'utf8'), indexBefore);
});

test('extract update restores the old folder and index when the index rename fails', { timeout: 10000 }, t => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) return t.skip('permission failures cannot be induced in this environment');
  const f = extractFixture(t);
  const base = { sourcePackage: f.sourcePackage, repo: f.repo, revision: f.shaA, skill: 'spec-architect-initial', scenariosRoot: f.scenariosRoot };
  const first = extract({ ...base, id: 'candidate', include: ['src/app.mjs'] });
  const typeFolder = join(f.scenariosRoot, 'spec-architect-initial');
  const indexPath = join(typeFolder, 'scenarios.md');
  const digestBefore = digestTree(first.folder);
  const indexBefore = readFileSync(indexPath, 'utf8');

  const original = fs.renameSync;
  const renameMock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (basename(String(to)) === 'scenarios.md') {
      chmodSync(typeFolder, 0o555);
      try {
        return original(from, to);
      } finally {
        chmodSync(typeFolder, 0o755);
      }
    }
    return original(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { renameMock.mock.restore(); syncBuiltinESMExports(); });

  assert.throws(() => extract({ ...base, revision: f.shaB, id: 'candidate', include: ['src/impl.mjs'], update: true }), /EACCES|EPERM|permission denied/i);
  assert.equal(digestTree(first.folder), digestBefore);
  assert.equal(readFileSync(indexPath, 'utf8'), indexBefore);
  assert.deepEqual(readdirSync(typeFolder).filter(name => name.startsWith('.tmp-') || name.startsWith('.old-') || name.startsWith('scenarios.md.')), []);
});

test('extract CLI writes a draft scenario and validates it', { timeout: 15000 }, t => {
  const f = extractFixture(t);
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const env = { ...process.env, SPEC_GYM_REPO: f.gym };
  const output = execFileSync(process.execPath, [
    cli, 'extract', '--source', f.sourcePackage, '--repo', f.repo, '--revision', f.shaA,
    '--skill', 'spec-architect-initial', '--id', 'cli-candidate', '--include', 'src/app.mjs',
  ], { env, encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.status, 'draft');
  assert.equal(result.folder, join(f.scenariosRoot, 'spec-architect-initial', 'cli-candidate'));
  assert.deepEqual(readdirSync(join(result.folder, 'input', 'package')).sort(), ['context.md', 'requirements.md']);
  assert.equal(existsSync(join(result.folder, 'input', 'project-context.md')), true);
  assert.deepEqual(readFileSync(join(result.folder, 'input', 'repository', 'src', 'app.mjs')), execFileSync('git', ['-C', f.repo, 'show', `${f.shaA}:src/app.mjs`]));
  assert.equal(validateScenario(result.folder).ok, true);

  const validated = spawnSync(process.execPath, [cli, 'validate', '--skill', 'spec-architect-initial'], { env, encoding: 'utf8' });
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(validated.stderr, '');

  const missing = spawnSync(process.execPath, [
    cli, 'extract', '--repo', f.repo, '--revision', f.shaA, '--skill', 'spec-architect-initial', '--id', 'cli-missing',
  ], { env, encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /extract requires --source/);
  assert.equal(existsSync(join(f.scenariosRoot, 'spec-architect-initial', 'cli-missing')), false);
  assert.deepEqual(readdirSync(join(f.scenariosRoot, 'spec-architect-initial')).filter(name => name.startsWith('.tmp-')), []);
});

test('extract refuses destinations overlapping the source and symlinked package inputs', { timeout: 10000 }, t => {
  const f = extractFixture(t);
  const base = { sourcePackage: f.sourcePackage, repo: f.repo, revision: f.shaA, skill: 'spec-architect-initial', id: 'overlap-candidate' };
  for (const scenariosRoot of [join(f.repo, 'scenarios'), join(f.sourcePackage, 'scenarios'), join(f.repo, '.specs')]) {
    assert.throws(() => extract({ ...base, scenariosRoot }), /overlaps the source repository or package/, scenariosRoot);
    assert.equal(existsSync(join(scenariosRoot, 'spec-architect-initial', 'overlap-candidate')), false, scenariosRoot);
  }

  const linkedRepo = join(f.root, 'linked-repo');
  symlinkSync(f.repo, linkedRepo);
  assert.throws(() => extract({ ...base, scenariosRoot: join(linkedRepo, 'scenarios') }), /overlaps the source repository or package/);
  assert.equal(existsSync(join(linkedRepo, 'scenarios')), false);

  const linkedPackage = join(f.root, 'linked-package');
  symlinkSync(f.sourcePackage, linkedPackage);
  assert.throws(() => extract({ ...base, scenariosRoot: join(linkedPackage, 'nested') }), /overlaps the source repository or package/);
  assert.equal(existsSync(join(linkedPackage, 'nested')), false);

  const linkedSource = join(f.root, 'linked-source');
  const symlinkPackage = join(linkedSource, '.specs', 'example-feature');
  mkdirSync(symlinkPackage, { recursive: true });
  writeFixture(join(symlinkPackage, 'requirements.md'), '# Requirements\n');
  writeFixture(join(linkedSource, '.specs', 'project-context.md'), '# Context\n');
  symlinkSync(join(symlinkPackage, 'requirements.md'), join(symlinkPackage, 'context.md'));
  const typeFolder = join(f.scenariosRoot, 'spec-architect-initial');
  assert.throws(() => extract({
    sourcePackage: symlinkPackage, repo: f.repo, revision: f.shaA,
    skill: 'spec-architect-initial', id: 'symlink-candidate', scenariosRoot: f.scenariosRoot,
  }), /regular file/);
  assert.equal(existsSync(join(typeFolder, 'symlink-candidate')), false);
  assert.deepEqual(existsSync(typeFolder) ? readdirSync(typeFolder).filter(name => name.startsWith('.tmp-')) : [], []);
});
