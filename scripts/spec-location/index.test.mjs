// Run: node --test scripts/spec-location/index.test.mjs
// Real temp directories and real git repositories; no mocks of owned modules.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkPackage, legacySpecs, listEpics, locatePackage, materialize, migrate, newPackage, recordWorktree, resolveWorkspace, setWorktree, stamp, updateScope,
} from './index.mjs';
import { gitInit, makeFixture, put } from './fixture.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const code = result => (result.ok ? 'ok' : result.code);

async function withFixture(run, config) {
  const fx = makeFixture(config);
  try { await run(fx); } finally { fx.cleanup(); }
}

test('resolveWorkspace: finds the workspace and repository from a subdirectory of a checkout', () => withFixture(async fx => {
  mkdirSync(join(fx.beta, 'src'));
  const result = await resolveWorkspace({ ...fx.options, cwd: join(fx.beta, 'src') });
  assert.equal(result.ok, true);
  assert.equal(result.workspace, 'demo');
  assert.equal(result.repository, 'beta');
  assert.equal(result.specsDir, join(fx.workspaceDir, 'specs'));
  assert.equal(result.executionHost, 'box');
}));

test('resolveWorkspace: refusal codes', () => withFixture(async fx => {
  const { options } = fx;
  assert.equal(code(await resolveWorkspace({ ...options, root: join(fx.tmp, 'nowhere'), workspace: 'demo' })), 'storage-unavailable');
  assert.equal(code(await resolveWorkspace({ ...options, workspace: 'ghost' })), 'workspace-not-found');

  const stranger = join(fx.tmp, 'stranger');
  gitInit(stranger);
  assert.equal(code(await resolveWorkspace({ ...options, cwd: stranger })), 'repository-not-in-kit');

  put(join(fx.root, 'projects', 'other', 'kit.yaml'), fx.kit('other', 'execution_host: box\n'));
  assert.equal(code(await resolveWorkspace({ ...options, cwd: fx.alpha })), 'repository-in-multiple-kits');
  assert.equal((await resolveWorkspace({ ...options, cwd: fx.alpha, workspace: 'demo' })).repository, 'alpha');

  assert.equal(code(await resolveWorkspace({ ...options, workspace: 'demo', hostname: 'Elsewhere.example.com' })), 'wrong-host');
  assert.equal(code(await resolveWorkspace({ ...options, workspace: 'demo', hostname: 'BOX.example.com' })), 'ok');

  put(join(fx.root, 'projects', 'demo', 'kit.yaml'), fx.kit('demo'));
  assert.equal(code(await resolveWorkspace({ ...options, workspace: 'demo' })), 'execution-host-unset');
}));

test('resolveWorkspace: hosts compare by lowercased first DNS label on both sides', () => withFixture(async fx => {
  put(join(fx.workspaceDir, 'kit.yaml'), fx.kit('demo', 'execution_host: Box.local\n'));
  assert.equal(code(await resolveWorkspace({ ...fx.options, workspace: 'demo', hostname: 'box' })), 'ok');
  const refused = await resolveWorkspace({ ...fx.options, workspace: 'demo', hostname: 'Laptop.example.com' });
  assert.equal(refused.code, 'wrong-host');
  assert.match(refused.message, /executes on box; this machine is laptop/);
}));

test('resolveWorkspace: untracked .specs entries refuse with legacy-specs-present', () => withFixture(async fx => {
  put(join(fx.beta, '.specs', 'old', 'spec.md'), '# old\n');
  const result = await resolveWorkspace({ ...fx.options, workspace: 'demo' });
  assert.equal(result.code, 'legacy-specs-present');
  assert.match(result.remedy, /migrate --workspace demo/);
}));

test('legacySpecs: a git failure is surfaced, not read as "nothing to migrate"', () => withFixture(async fx => {
  rmSync(join(fx.alpha, '.git'), { recursive: true });
  put(join(fx.alpha, '.specs', 'old', 'spec.md'), '# old\n');
  await assert.rejects(legacySpecs(fx.alpha), /git ls-files failed/);
  assert.equal((await resolveWorkspace({ ...fx.options, workspace: 'demo' })).code, 'legacy-check-failed');
  assert.equal((await migrate({ ...fx.options, workspace: 'demo' })).code, 'legacy-check-failed');
}));

test('legacySpecs: tracked entries are not legacy', async () => {
  const fx = makeFixture();
  try {
    put(join(fx.alpha, '.specs', 'kept.md'), 'tracked\n');
    put(join(fx.alpha, '.specs', 'loose', 'spec.md'), 'untracked\n');
    execFileSync('git', ['-C', fx.alpha, 'add', '.specs/kept.md']);
    execFileSync('git', ['-C', fx.alpha, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x']);
    assert.deepEqual(await legacySpecs(fx.alpha), ['loose']);
    assert.deepEqual(await legacySpecs(fx.beta), []);
  } finally { fx.cleanup(); }
});

test('newPackage: writes scope.json and locations.json with the documented shape', () => withFixture(async fx => {
  const created = await newPackage({ ...fx.options, workspace: 'demo', slug: 'p1-alerts', targets: [{ id: 'alpha' }, { id: 'beta', branch: 'custom' }], designs: ['demo/redesign'], plan: 'pages.md', epic: 'pages' });
  assert.equal(created.ok, true);
  const dir = join(fx.workspaceDir, 'specs', 'p1-alerts');
  assert.deepEqual(json(join(dir, 'scope.json')), {
    schema_version: 1, workspace: 'demo', slug: 'p1-alerts',
    targets: [{ id: 'alpha', branch: 'spec-p1-alerts' }, { id: 'beta', branch: 'custom' }],
    designs: ['demo/redesign'], plan: 'pages.md', epic: 'pages',
  });
  const locations = json(join(dir, 'locations.json'));
  assert.equal(locations.package_ref, 'demo/p1-alerts');
  assert.equal(locations.execution_host, 'box');
  assert.equal(locations.package_dir, dir);
  assert.equal(locations.plan, join(fx.workspaceDir, 'plans', 'pages.md'));
  assert.equal(locations.epic, join(fx.workspaceDir, 'epics', 'pages', 'epic.json'));
  assert.deepEqual(locations.designs, [{ ref: 'demo/redesign', dir: join(fx.workspaceDir, 'designs', 'redesign') }]);
  assert.deepEqual(locations.targets[0], { id: 'alpha', primary: fx.alpha, common: join(fx.alpha, '.git'), branch: 'spec-p1-alerts', worktree: null });

  assert.equal(code(await newPackage({ ...fx.options, workspace: 'demo', slug: 'p1-alerts', targets: [{ id: 'alpha' }] })), 'package-exists');
  assert.equal(code(await newPackage({ ...fx.options, workspace: 'demo', slug: 'p2', targets: [{ id: 'gamma' }] })), 'target-not-in-kit');
}));

test('locatePackage: ref, file inside the package, and refusals', () => withFixture(async fx => {
  await newPackage({ ...fx.options, workspace: 'demo', slug: 'p1', targets: [{ id: 'alpha' }] });
  const dir = join(fx.workspaceDir, 'specs', 'p1');
  put(join(dir, 'step-001-subspec.md'), '# step\n');
  for (const input of ['demo/p1', dir, join(dir, 'step-001-subspec.md')]) {
    const found = await locatePackage(input, fx.options);
    assert.deepEqual([found.ref, found.packageDir], ['demo/p1', dir]);
  }
  assert.equal(code(await locatePackage('demo/nope', fx.options)), 'package-not-found');
  put(join(fx.alpha, '.specs', 'old', 'spec.md'), '# old\n');
  assert.equal(code(await locatePackage(join(fx.alpha, '.specs', 'old', 'spec.md'), fx.options)), 'legacy-location');
}));

test('checkPackage: refusal codes and success', () => withFixture(async fx => {
  const { options } = fx;
  await newPackage({ ...options, workspace: 'demo', slug: 'p1', targets: [{ id: 'alpha' }], plan: 'pages.md' });
  put(join(fx.workspaceDir, 'plans', 'pages.md'), '# plan\n');
  const dir = join(fx.workspaceDir, 'specs', 'p1');
  assert.equal(code(await checkPackage('demo/p1', options)), 'ok');
  assert.equal(code(await checkPackage('demo/p1', { ...options, hostname: 'other' })), 'wrong-host');

  rmSync(join(fx.workspaceDir, 'plans', 'pages.md'));
  const missing = await checkPackage('demo/p1', options);
  assert.equal(missing.code, 'path-missing');
  assert.match(missing.remedy, /materialize demo\/p1/);
  put(join(fx.workspaceDir, 'plans', 'pages.md'), '# plan\n');

  const kitText = readFileSync(join(fx.workspaceDir, 'kit.yaml'), 'utf8');
  put(join(fx.workspaceDir, 'kit.yaml'), kitText.replace('  - id: alpha\n', '  - id: alpha2\n'));
  assert.equal(code(await checkPackage('demo/p1', options)), 'target-not-in-kit');
  put(join(fx.workspaceDir, 'kit.yaml'), kitText);

  rmSync(fx.alpha, { recursive: true });
  assert.equal(code(await checkPackage('demo/p1', options)), 'target-missing');

  rmSync(join(dir, 'locations.json'));
  gitInit(fx.alpha);
  assert.equal(code(await checkPackage('demo/p1', options)), 'locations-missing');
}));

test('authoring off the execution host: uses this machine\'s paths until a worktree is recorded', () => withFixture(async fx => {
  const laptop = { ...fx.options, hostname: 'laptop', authoring: true };
  assert.equal(code(await resolveWorkspace({ ...fx.options, hostname: 'laptop', workspace: 'demo' })), 'wrong-host');
  assert.equal(code(await resolveWorkspace({ ...laptop, workspace: 'demo' })), 'ok');

  assert.equal(code(await newPackage({ ...laptop, workspace: 'demo', slug: 'p1', targets: [{ id: 'alpha' }] })), 'ok');
  // Simulate a sync from the host: locations.json now holds paths that do not exist here.
  const file = join(fx.workspaceDir, 'specs', 'p1', 'locations.json');
  const hostCopy = { ...json(file), package_dir: '/home/host/specs/p1', targets: [{ ...json(file).targets[0], primary: '/home/host/alpha' }] };
  writeFileSync(file, JSON.stringify(hostCopy));
  assert.equal(code(await checkPackage('demo/p1', { ...fx.options, hostname: 'laptop' })), 'wrong-host');
  const checked = await checkPackage('demo/p1', laptop);
  assert.equal(checked.locations.package_dir, join(fx.workspaceDir, 'specs', 'p1'));
  assert.equal(checked.locations.targets[0].primary, fx.alpha);
  assert.deepEqual(json(file), hostCopy);

  hostCopy.targets[0].worktree = '/home/host/alpha-wt';
  writeFileSync(file, JSON.stringify(hostCopy));
  assert.equal(code(await checkPackage('demo/p1', laptop)), 'execution-started');
  assert.equal(code(await updateScope('demo/p1', { addTarget: 'beta' }, laptop)), 'execution-started');
  assert.equal(code(await checkPackage('demo/p1', { ...fx.options, authoring: true })), 'path-missing');
}));

test('materialize: keeps an existing worktree and drops one that no longer exists',() => withFixture(async fx => {
  await newPackage({ ...fx.options, workspace: 'demo', slug: 'p1', targets: [{ id: 'alpha' }, { id: 'beta' }] });
  const trees = { alpha: join(fx.tmp, 'alpha-wt'), beta: join(fx.tmp, 'beta-wt') };
  mkdirSync(trees.alpha);
  assert.equal((await setWorktree('demo/p1', 'alpha', trees.alpha, fx.options)).ok, true);
  assert.equal((await setWorktree('demo/p1', 'beta', trees.beta, fx.options)).ok, true);
  const { locations } = await materialize('demo/p1', fx.options);
  assert.equal(locations.targets[0].worktree, trees.alpha);
  assert.equal(locations.targets[1].worktree, null);
  assert.equal((await setWorktree('demo/p1', 'gamma', '/x', fx.options)).code, 'target-not-in-scope');
}));

test('recordWorktree: records a real worktree of the target, refuses anything else, and restamps', () => withFixture(async fx => {
  const commit = repo => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'x']);
  commit(fx.alpha);
  commit(fx.beta);
  await newPackage({ ...fx.options, workspace: 'demo', slug: 'p1', targets: [{ id: 'alpha' }] });
  put(join(fx.workspaceDir, 'specs', 'p1', 'spec.md'), '# Spec\n');
  const wt = join(fx.tmp, 'alpha-wt');
  execFileSync('git', ['-C', fx.alpha, 'worktree', 'add', '-q', '-b', 'spec-p1', wt]);
  const betaWt = join(fx.tmp, 'beta-wt');
  execFileSync('git', ['-C', fx.beta, 'worktree', 'add', '-q', '-b', 'spec-p1', betaWt]);
  const plain = join(fx.tmp, 'plain');
  mkdirSync(plain);
  mkdirSync(join(wt, 'sub'));

  for (const path of [plain, betaWt, join(wt, 'sub')]) {
    assert.equal(code(await recordWorktree('demo/p1', 'alpha', path, fx.options)), 'not-a-worktree');
  }
  assert.equal(json(join(fx.workspaceDir, 'specs', 'p1', 'locations.json')).targets[0].worktree, null);

  const done = await recordWorktree('demo/p1', 'alpha', wt, fx.options);
  assert.equal(done.ok, true);
  assert.equal(json(join(fx.workspaceDir, 'specs', 'p1', 'locations.json')).targets[0].worktree, realpathSync(wt));
  assert.match(readFileSync(join(fx.workspaceDir, 'specs', 'p1', 'spec.md'), 'utf8'), /worktree `.*alpha-wt`/);
  assert.equal(code(await recordWorktree('demo/p1', 'beta', betaWt, fx.options)), 'target-not-in-scope');
}));

test('newPackage and updateScope: plan must be a plain file name, branches must be valid refs', () => withFixture(async fx => {
  const base = { ...fx.options, workspace: 'demo', slug: 'p1', targets: [{ id: 'alpha' }] };
  assert.equal(code(await newPackage({ ...base, plan: '../x.md' })), 'invalid-input');
  assert.equal(code(await newPackage({ ...base, plan: 'a/b.md' })), 'invalid-input');
  assert.equal(code(await newPackage({ ...base, targets: [{ id: 'alpha', branch: 'bad..name' }] })), 'invalid-input');
  assert.equal(code(await newPackage({ ...base, targets: [{ id: 'alpha', branch: 'feature/ok' }] })), 'ok');
  assert.equal(code(await updateScope('demo/p1', { setPlan: '../x.md' }, fx.options)), 'invalid-input');
  assert.equal(code(await updateScope('demo/p1', { addTarget: { id: 'beta', branch: '-x' } }, fx.options)), 'invalid-input');
}));

test('stamp: block follows the H1, repeated runs change nothing, headingless files get it on top', () => withFixture(async fx => {
  await newPackage({ ...fx.options, workspace: 'demo', slug: 'p1', targets: [{ id: 'alpha' }] });
  const dir = join(fx.workspaceDir, 'specs', 'p1');
  put(join(dir, 'spec.md'), '# Spec title\n\nBody text.\n');
  put(join(dir, 'context.md'), 'No heading here.\n');
  put(join(dir, 'step-002-subspec.md'), '# Step 2\nImmediately after.\n');
  const first = await stamp('demo/p1', fx.options);
  assert.deepEqual(first.files, ['context.md', 'spec.md', 'step-002-subspec.md']);
  const snapshot = ['spec.md', 'context.md', 'step-002-subspec.md'].map(name => readFileSync(join(dir, name), 'utf8'));

  const [spec, context, step] = snapshot;
  assert.match(spec, /^# Spec title\n\n<!-- spec-location:begin -->\n[\s\S]*<!-- spec-location:end -->\n\nBody text\.\n$/);
  assert.match(spec, /- Package: `demo\/p1` at `.*specs\/p1`/);
  assert.match(spec, /- Targets:\n {2}- `alpha`: primary `.*alpha`, branch `spec-p1`, worktree none/);
  assert.match(context, /^<!-- spec-location:begin -->[\s\S]*<!-- spec-location:end -->\n\nNo heading here\.\n$/);
  assert.match(step, /^# Step 2\n\n<!-- spec-location:begin -->[\s\S]*<!-- spec-location:end -->\n\nImmediately after\.\n$/);

  await stamp('demo/p1', fx.options);
  await materialize('demo/p1', fx.options);
  assert.deepEqual(['spec.md', 'context.md', 'step-002-subspec.md'].map(name => readFileSync(join(dir, name), 'utf8')), snapshot);
}));

test('updateScope: add-target extends scope and locations; unknown or repeated targets refuse', () => withFixture(async fx => {
  await newPackage({ ...fx.options, workspace: 'demo', slug: 'p1', targets: [{ id: 'alpha' }] });
  const dir = join(fx.workspaceDir, 'specs', 'p1');
  const result = await updateScope('demo/p1', { addTarget: { id: 'beta', branch: 'b' }, addDesign: 'demo/ladder', setPlan: 'pages.md', setEpic: 'pages' }, fx.options);
  assert.equal(result.ok, true);
  const scope = json(join(dir, 'scope.json'));
  assert.deepEqual(scope.targets, [{ id: 'alpha', branch: 'spec-p1' }, { id: 'beta', branch: 'b' }]);
  assert.deepEqual([scope.designs, scope.plan, scope.epic], [['demo/ladder'], 'pages.md', 'pages']);
  assert.deepEqual(json(join(dir, 'locations.json')).targets.map(t => t.id), ['alpha', 'beta']);
  assert.equal(code(await updateScope('demo/p1', { addTarget: { id: 'beta' } }, fx.options)), 'target-exists');
  assert.equal(code(await updateScope('demo/p1', { addTarget: { id: 'gamma' } }, fx.options)), 'target-not-in-kit');
  assert.equal((await updateScope('demo/p1', { setPlan: null, setEpic: null }, fx.options)).locations.plan, null);
}));

test('listEpics: members resolve to package directories and report whether they exist', () => withFixture(async fx => {
  await newPackage({ ...fx.options, workspace: 'demo', slug: 'p1', targets: [{ id: 'alpha' }] });
  put(join(fx.workspaceDir, 'epics', 'pages', 'epic.json'), JSON.stringify({ epic: 'pages', packages: [{ package: 'p1', requires: [] }, { package: 'p2', requires: ['p1'] }] }));
  const { epics } = await listEpics('demo', fx.options);
  assert.equal(epics.length, 1);
  assert.deepEqual(epics[0].members, [
    { slug: 'p1', packageDir: join(fx.workspaceDir, 'specs', 'p1'), exists: true },
    { slug: 'p2', packageDir: join(fx.workspaceDir, 'specs', 'p2'), exists: false },
  ]);
}));
