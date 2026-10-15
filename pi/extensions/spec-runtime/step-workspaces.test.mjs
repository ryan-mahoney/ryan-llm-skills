// OverlayFS workspace provisioning contract (step 4).
//
// These tests compose the real overlay phase-claim machinery, real temporary
// Git repositories and real flock ownership registries. Only the final kernel
// mount boundary is substituted: writes/deletes that a kernel overlay would
// apply to the merged view are applied directly to an attempt's upper
// directory, and that substitution is explicitly not kernel OverlayFS proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createOverlayPhases, interpretProbeResult } from './overlay.mjs';
import { createOwnership } from './ownership.mjs';
import {
  importSealedHead, prepareCandidateWorkspace, prepareStepWorkspace, remountRetainedWorkspace, resolveBackend, setupIdentity,
  stagingDigest, workspacePath,
} from './step-workspaces.mjs';

const GIT = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

function freshRoot(t, label) {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], GIT).trim();
}

// Synthetic probe phase records: only interpretProbeResult performs capability
// classification, so these tests never reimplement the probe decision table.
function phase(exitCode, stdout = '', stderr = '', signal = null) {
  return { exitCode, signal, stdout, stderr };
}

function observation(fields) {
  return JSON.stringify({
    fstype: 'overlay',
    options: 'rw,lowerdir=/lower,upperdir=/upper,workdir=/work',
    ...fields,
  });
}

function supportedCapability() {
  return interpretProbeResult({
    collect: phase(0, observation({ copyUp: true, deletion: true })),
    verify: phase(0, observation({ retainedWrite: true, retainedDeletion: true })),
  });
}

function fallbackCapability() {
  return interpretProbeResult({ collect: phase(1, '', 'bwrap: unrecognized option --overlay') });
}

function refusal(reason) {
  return error => {
    assert.equal(error?.code, 'workspace-refusal', `expected workspace-refusal, got ${JSON.stringify(error)}`);
    assert.equal(error?.reason, reason);
    return true;
  };
}

function assertRefusal(reason, fn) {
  assert.throws(fn, refusal(reason));
}

async function assertRefusalAsync(reason, fn) {
  await assert.rejects(fn, refusal(reason));
}

function coordinatorFor(label) {
  return { session: `wave-workspaces-${label}`, epoch: 1, pid: process.pid, started_at: `fixture-start-${label}` };
}

function makeTargetRepo(t, label) {
  const worktree = freshRoot(t, label);
  execFileSync('git', ['init', '-q', '-b', 'main', worktree], GIT);
  git(worktree, ['config', 'user.email', 'wave-editor@example.test']);
  git(worktree, ['config', 'user.name', 'Wave Editor']);
  mkdirSync(join(worktree, 'src'));
  mkdirSync(join(worktree, 'scripts'));
  mkdirSync(join(worktree, 'docs'));
  writeFileSync(join(worktree, 'README.md'), 'base\n');
  writeFileSync(join(worktree, 'src', 'app.js'), 'console.log("base");\n');
  writeFileSync(join(worktree, 'scripts', 'run.sh'), '#!/bin/sh\necho base\n');
  chmodSync(join(worktree, 'scripts', 'run.sh'), 0o755);
  writeFileSync(join(worktree, 'docs', 'remove-me.txt'), 'remove me\n');
  git(worktree, ['add', '-A']);
  git(worktree, ['commit', '-q', '-m', 'c1']);
  const c1 = git(worktree, ['rev-parse', 'HEAD']);
  writeFileSync(join(worktree, 'reviewed.txt'), 'reviewed\n');
  git(worktree, ['add', 'reviewed.txt']);
  git(worktree, ['commit', '-q', '-m', 'c2']);
  const c2 = git(worktree, ['rev-parse', 'HEAD']);
  return { worktree, gitCommonDir: realpathSync(join(worktree, '.git')), c1, c2 };
}

function makeOwnership(t, label) {
  return createOwnership({ registryRoot: freshRoot(t, `${label}-ownership`) });
}

function workspaceOptions({
  target, waveRoot, ownership, packageId, label, attemptId, baseCommit,
  mode = 'overlayfs', capability = supportedCapability(), setup, env, preparationReceipt, phaseToken = `phase-${attemptId}`,
}) {
  return {
    packageId,
    coordinator: coordinatorFor(label),
    phaseToken,
    attemptId,
    target,
    waveRoot,
    baseCommit,
    setup: setup ?? { command: 'node --version', lockfiles: [], environment: [] },
    env: env ?? { HOME: process.env.HOME, PATH: process.env.PATH },
    preparationReceipt: preparationReceipt ?? { ok: true, drain: 'confirmed', baseCommit, trackedClean: true },
    mode,
    capability,
    ownership,
  };
}

test('wave workspaces: backend selection follows capability classification', () => {
  const supported = supportedCapability();
  assert.equal(supported.status, 'supported');

  for (const mode of ['auto', 'overlayfs']) {
    const selected = resolveBackend({ mode, capability: supported });
    assert.equal(selected.backend, 'overlayfs');
    assert.equal(selected.reason, 'overlay-supported');
    assert.equal(selected.mode, mode);
    assert.equal(selected.capability, supported);
    assert.ok(Object.isFrozen(selected), 'backend records are frozen');
  }

  const explicitWorktree = resolveBackend({ mode: 'worktree', capability: supported });
  assert.equal(explicitWorktree.backend, 'worktree');
  assert.equal(explicitWorktree.reason, 'explicit-worktree');

  const unavailable = fallbackCapability();
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.fallbackEligible, true);

  assertRefusal('overlay-unavailable', () => resolveBackend({ mode: 'overlayfs', capability: unavailable }));

  const fallback = resolveBackend({ mode: 'auto', capability: unavailable });
  assert.equal(fallback.backend, 'worktree');
  assert.equal(fallback.reason, unavailable.reason, 'the visible fallback reason is the capability reason');
  assert.equal(fallback.capability, unavailable);

  const corrupt = interpretProbeResult({ collect: phase(0, 'wave-probe-garbage'), verify: null });
  assert.equal(corrupt.status, 'blocked');
  assert.equal(corrupt.reason, 'corrupt-output');
  assertRefusal('capability-blocked', () => resolveBackend({ mode: 'auto', capability: corrupt }));

  const unknownEffect = interpretProbeResult({
    collect: phase(1, 'wave-probe partial output', 'bwrap: execvp true: No such file or directory'),
  });
  assert.equal(unknownEffect.status, 'blocked');
  assertRefusal('capability-blocked', () => resolveBackend({ mode: 'auto', capability: unknownEffect }));

  const postWrite = interpretProbeResult({
    collect: phase(0, observation({ copyUp: true, deletion: true })),
    verify: phase(1, 'wave-probe verification output', 'probe: remount verification failed'),
  });
  assert.equal(postWrite.status, 'blocked');
  assertRefusal('capability-blocked', () => resolveBackend({ mode: 'auto', capability: postWrite }));

  assertRefusal('capability-blocked', () => resolveBackend({
    mode: 'auto',
    capability: { status: 'unavailable', reason: 'filesystem-unsupported', fallbackEligible: false },
  }));

  for (const malformed of [null, undefined, 'overlay-supported', {}, { status: 7 }]) {
    assertRefusal('capability-unknown', () => resolveBackend({ mode: 'auto', capability: malformed }));
  }
});

test('wave workspaces: attempts share one frozen snapshot with independent layers', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-shared-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-shared-root');
  const ownership = makeOwnership(t, 'wave-workspaces-shared');
  const common = { target, waveRoot, ownership, packageId: 'wave-shared', label: 'shared', baseCommit: target.c2, mode: 'overlayfs' };

  const first = await prepareStepWorkspace(workspaceOptions({ ...common, attemptId: 'attempt-a' }));
  const second = await prepareStepWorkspace(workspaceOptions({ ...common, attemptId: 'attempt-b' }));

  assert.equal(first.kind, 'step');
  assert.equal(first.backend, 'overlayfs');
  assert.equal(first.baseCommit, target.c2);
  assert.ok(Object.isFrozen(first));
  assert.equal(typeof first.claim.token, 'string');
  assert.equal(typeof first.claim.epoch, 'number');

  assert.equal(first.snapshotId, second.snapshotId, 'identical inputs reuse one snapshot');
  assert.equal(first.lower, second.lower);
  assert.equal(first.lower, join(waveRoot, 'snapshots', first.snapshotId, 'lower'));
  assert.equal(first.upper, join(waveRoot, 'attempts', 'attempt-a', 'upper'));
  assert.equal(second.upper, join(waveRoot, 'attempts', 'attempt-b', 'upper'));
  assert.notEqual(first.upper, second.upper);
  assert.notEqual(first.work, second.work);
  assert.notEqual(first.gitDir, second.gitDir);
  for (const layer of [first.upper, first.work, first.merged, first.gitDir]) {
    assert.ok(statSync(layer).isDirectory(), `${layer} is provisioned`);
  }

  assert.equal(readFileSync(join(first.lower, 'README.md'), 'utf8'), 'base\n');
  assert.equal(statSync(join(first.lower, 'scripts', 'run.sh')).mode & 0o777, 0o755, 'git archive preserves modes');

  // Substituted final mount boundary: the merged-view writes/deletes below are
  // applied directly to this attempt's upper directory. Not kernel proof.
  writeFileSync(join(first.upper, 'README.md'), 'attempt-a-edit\n');
  writeFileSync(join(first.upper, 'added.txt'), 'attempt-a-new\n');
  mkdirSync(join(first.upper, 'docs'), { recursive: true });
  writeFileSync(join(first.upper, 'docs', 'remove-me.txt'), readFileSync(join(first.lower, 'docs', 'remove-me.txt'))); // copy-up stand-in
  rmSync(join(first.upper, 'docs', 'remove-me.txt')); // deletion stand-in

  assert.equal(readFileSync(join(first.lower, 'README.md'), 'utf8'), 'base\n', 'the frozen lower is never modified');
  assert.equal(readFileSync(join(first.lower, 'docs', 'remove-me.txt'), 'utf8'), 'remove me\n');
  assert.deepEqual(readdirSync(second.upper), [], 'a sibling attempt keeps its own empty layer');
});

test('wave workspaces: private Git metadata stays independent and imports exact heads', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-git-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-git-root');
  const ownership = makeOwnership(t, 'wave-workspaces-git');
  const common = { target, waveRoot, ownership, packageId: 'wave-git', label: 'git', baseCommit: target.c2, mode: 'overlayfs' };

  const attemptA = await prepareStepWorkspace(workspaceOptions({ ...common, attemptId: 'attempt-git-a' }));
  const attemptB = await prepareStepWorkspace(workspaceOptions({ ...common, attemptId: 'attempt-git-b' }));
  assert.equal(attemptA.backend, 'overlayfs');

  for (const record of [attemptA, attemptB]) {
    assert.ok(existsSync(join(record.gitDir, 'HEAD')), 'the private gitDir is a real repository');
    assert.ok(!existsSync(join(record.gitDir, 'objects', 'info', 'alternates')), 'objects are fetched without alternates');
    assert.doesNotThrow(() => git(record.gitDir, ['cat-file', '-e', `${target.c2}^{commit}`]));
    assert.doesNotThrow(() => git(record.gitDir, ['cat-file', '-e', `${target.c1}^{commit}`]), 'reviewed-head ancestry is fetched');
  }
  assert.notEqual(attemptA.gitDir, attemptB.gitDir);

  // HEAD and index are per-attempt private state.
  const headB = readFileSync(join(attemptB.gitDir, 'HEAD'), 'utf8');
  git(attemptA.gitDir, ['symbolic-ref', 'HEAD', 'refs/heads/private-attempt-a']);
  assert.equal(readFileSync(join(attemptB.gitDir, 'HEAD'), 'utf8'), headB, 'attempt A HEAD changes do not move attempt B');

  writeFileSync(join(attemptA.merged, 'index-probe.txt'), 'probe\n');
  execFileSync('git', ['--git-dir', attemptA.gitDir, '--work-tree', attemptA.merged, 'add', 'index-probe.txt'], { cwd: attemptA.merged, ...GIT });
  const listedA = execFileSync('git', ['--git-dir', attemptA.gitDir, '--work-tree', attemptA.merged, 'ls-files'], { cwd: attemptA.merged, ...GIT });
  const listedB = execFileSync('git', ['--git-dir', attemptB.gitDir, '--work-tree', attemptB.merged, 'ls-files'], { cwd: attemptB.merged, ...GIT });
  assert.ok(listedA.split('\n').includes('index-probe.txt'));
  assert.ok(!listedB.split('\n').includes('index-probe.txt'), 'attempt B index is independent');

  assert.equal(workspacePath(attemptA, 'src/app.js'), join(attemptA.merged, 'src', 'app.js'));
  assertRefusal('path-escape', () => workspacePath(attemptA, '../outside.txt'));
  assertRefusal('path-escape', () => workspacePath(attemptA, 'src/../../outside.txt'));

  const retentionRef = 'refs/waves/retained/reviewed-head';
  await importSealedHead({ repo: target.worktree, source: attemptA.gitDir, sha: target.c2, retentionRef });
  assert.equal(git(target.worktree, ['rev-parse', retentionRef]), target.c2, 'the retention ref points at the exact sha');
  assert.equal(
    git(target.worktree, ['rev-parse', `${retentionRef}^{tree}`]),
    git(target.worktree, ['rev-parse', `${target.c2}^{tree}`]),
    'the imported tree is identical',
  );
  assert.doesNotThrow(() => git(target.worktree, ['merge-base', '--is-ancestor', target.c1, target.c2]), 'reviewed-head ancestry is preserved');
  assert.ok(!existsSync(join(target.worktree, '.git', 'objects', 'info', 'alternates')));

  await assertRefusalAsync('retention-ref-conflict', () => importSealedHead({
    repo: target.worktree,
    source: target.worktree,
    sha: target.c1,
    retentionRef,
  }));
  assert.equal(git(target.worktree, ['rev-parse', retentionRef]), target.c2, 'a conflicting import leaves the ref untouched');
});

test('wave workspaces: worktree fallback preserves canonical common-dir and isolated setup', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-fallback-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-fallback-root');
  const ownership = makeOwnership(t, 'wave-workspaces-fallback');
  const capability = fallbackCapability();
  assert.equal(capability.status, 'unavailable');
  assert.equal(capability.fallbackEligible, true);

  const record = await prepareStepWorkspace(workspaceOptions({
    target, waveRoot, ownership, packageId: 'wave-fallback', label: 'fallback', attemptId: 'attempt-fallback',
    baseCommit: target.c2, mode: 'auto', capability,
  }));

  assert.equal(record.backend, 'worktree');
  assert.equal(record.baseCommit, target.c2);
  assert.equal(record.worktree, join(waveRoot, 'attempts', 'attempt-fallback', 'worktree'));
  assert.equal(git(record.worktree, ['rev-parse', 'HEAD']), target.c2);
  const commonDir = git(record.worktree, ['rev-parse', '--git-common-dir']);
  const resolvedCommon = realpathSync(isAbsolute(commonDir) ? commonDir : join(record.worktree, commonDir));
  assert.equal(resolvedCommon, target.gitCommonDir, 'the fallback keeps the canonical common dir');
  assert.equal(readFileSync(join(record.worktree, 'README.md'), 'utf8'), 'base\n');
  assert.equal(workspacePath(record, 'src/app.js'), join(record.worktree, 'src', 'app.js'), 'fallback paths resolve under the worktree');

  const canonicalHead = git(target.worktree, ['rev-parse', 'HEAD']);
  const canonicalReadme = readFileSync(join(target.worktree, 'README.md'), 'utf8');
  await assertRefusalAsync('canonical-worktree-is-not-a-workspace', () => prepareStepWorkspace(workspaceOptions({
    target, waveRoot: target.worktree, ownership, packageId: 'wave-fallback-inside', label: 'fallback-inside',
    attemptId: 'attempt-inside', baseCommit: target.c2, mode: 'auto', capability,
  })));
  assert.equal(readFileSync(join(target.worktree, 'README.md'), 'utf8'), canonicalReadme, 'the canonical worktree bytes are untouched');
  assert.equal(git(target.worktree, ['rev-parse', 'HEAD']), canonicalHead);
});

test('wave workspaces: retained remount preserves dirty state and blocks unclean phases', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-retained-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-retained-root');
  const ownership = makeOwnership(t, 'wave-workspaces-retained');
  const phases = createOverlayPhases({ ownership });

  const record = await prepareStepWorkspace(workspaceOptions({
    target, waveRoot, ownership, packageId: 'wave-retained', label: 'retained', attemptId: 'attempt-retained',
    baseCommit: target.c2, mode: 'overlayfs',
  }));
  assert.equal(record.backend, 'overlayfs');
  const previous = { token: record.claim.token, epoch: record.claim.epoch };
  const expected = {
    lower: record.lower, upper: record.upper, work: record.work, merged: record.merged,
    gitDir: record.gitDir, baseCommit: record.baseCommit, snapshotId: record.snapshotId,
  };

  // Substituted final mount boundary: a dirty edit, a deletion stand-in and an
  // untracked file are applied directly to the attempt's upper; no kernel
  // overlay mount is exercised here.
  writeFileSync(join(record.upper, 'README.md'), 'dirty-edit\n');
  mkdirSync(join(record.upper, 'docs'), { recursive: true });
  writeFileSync(join(record.upper, 'docs', 'remove-me.txt'), readFileSync(join(record.lower, 'docs', 'remove-me.txt')));
  rmSync(join(record.upper, 'docs', 'remove-me.txt'));
  writeFileSync(join(record.upper, 'untracked.txt'), 'scratch\n');

  const remount = (overrides = {}) => remountRetainedWorkspace({
    // The JSON round-trip proves retained identity is durable plain data a
    // fresh process could rebuild; real cross-process recovery is EV-8/step-6.
    retained: JSON.parse(JSON.stringify(record.retained)),
    expected,
    previous,
    phaseToken: 'phase-retained-next',
    coordinator: coordinatorFor('retained'),
    ownership,
    ...overrides,
  });

  await assertRefusalAsync('phase-not-drained', () => remount());
  assert.equal(readFileSync(join(record.upper, 'README.md'), 'utf8'), 'dirty-edit\n', 'the dirty layer is not reset');
  assert.ok(existsSync(join(record.upper, 'untracked.txt')));
  assert.ok(!existsSync(join(record.upper, 'docs', 'remove-me.txt')));

  const released = await phases.endPhase({ token: previous.token, epoch: previous.epoch, drain: 'confirmed' });
  assert.equal(released.status, 'released', 'the old phase was positively drained');

  await assertRefusalAsync('layer-identity-mismatch', () => remount({ expected: { ...expected, snapshotId: 'snapshot-other' } }));
  assert.equal(readFileSync(join(record.upper, 'README.md'), 'utf8'), 'dirty-edit\n', 'an identity mismatch does not reset the layer');

  const remounted = await remount();
  assert.equal(remounted.backend, 'overlayfs');
  assert.equal(remounted.snapshotId, record.snapshotId);
  assert.equal(remounted.lower, record.lower);
  assert.equal(remounted.upper, record.upper);
  assert.equal(remounted.work, record.work);
  assert.equal(remounted.merged, record.merged);
  assert.equal(remounted.gitDir, record.gitDir);
  assert.equal(remounted.retained.upper, record.retained.upper, 'retained identities are unchanged');
  assert.notEqual(remounted.claim.token, previous.token, 'the remount uses a new phase claim');

  assert.equal(readFileSync(join(remounted.upper, 'README.md'), 'utf8'), 'dirty-edit\n', 'the dirty edit survives remount');
  assert.equal(readFileSync(join(remounted.upper, 'untracked.txt'), 'utf8'), 'scratch\n', 'the untracked file survives remount');
  assert.ok(!existsSync(join(remounted.upper, 'docs', 'remove-me.txt')), 'the deletion stands after remount');
  assert.ok(existsSync(join(record.lower, 'docs', 'remove-me.txt')), 'the lower deletion source is untouched');
});

test('wave workspaces: index setup declaration preserves command and environment names', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-index-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-index-root');
  const ownership = makeOwnership(t, 'wave-workspaces-index');
  writeFileSync(join(target.worktree, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const baseCommit = target.c2;
  const declaration = { command: 'npm ci', lockfiles: ['package-lock.json'], environment: ['REQUIRED_MISSING'] };

  const options = (attemptId, overrides = {}) => ({
    ...workspaceOptions({
      target, waveRoot, ownership, packageId: 'wave-index', label: 'index', attemptId, baseCommit,
      mode: 'overlayfs', setup: declaration,
      env: { HOME: process.env.HOME, PATH: process.env.PATH, REQUIRED_MISSING: 'value-never-recorded' },
    }),
    ...overrides,
  });

  const prepared = await prepareStepWorkspace(options('attempt-index-1'));
  assert.equal(prepared.setup.command, 'npm ci', 'the prepared record preserves the command string');
  assert.deepEqual([...prepared.setup.environment], ['REQUIRED_MISSING'], 'a declared variable name is recorded as a name, never a value');

  await assertRefusalAsync('env-missing', () => prepareStepWorkspace(options('attempt-index-2', {
    env: { HOME: process.env.HOME },
  })));

  const commandChanged = await prepareStepWorkspace(options('attempt-index-3', {
    setup: { ...declaration, command: 'npm ci --ignore-scripts' },
  }));
  assert.notEqual(commandChanged.snapshotId, prepared.snapshotId, 'declarations differing only in the command produce different snapshot ids');

  writeFileSync(join(target.worktree, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
  const lockChanged = await prepareStepWorkspace(options('attempt-index-4'));
  assert.notEqual(lockChanged.snapshotId, prepared.snapshotId, 'a relative lockfile resolved against the accepted base feeds the snapshot identity');

  const none = await prepareStepWorkspace(options('attempt-index-5', { setup: 'none' }));
  assert.equal(none.setup.command, '', '"none" maps to the empty declaration');
  assert.deepEqual([...none.setup.environment], []);
});

test('wave workspaces: malformed index setup declarations refuse with setup-malformed', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-malformed-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-malformed-root');
  const ownership = makeOwnership(t, 'wave-workspaces-malformed');
  const baseCommit = target.c2;

  const options = (attemptId, setup) => workspaceOptions({
    target, waveRoot, ownership, packageId: 'wave-malformed', label: 'malformed', attemptId, baseCommit,
    mode: 'overlayfs', setup,
    env: { HOME: process.env.HOME, PATH: process.env.PATH },
  });

  const malformed = [
    ['argv-array-command', { command: ['node', '--version'], lockfiles: [], environment: [] }],
    ['env-key', { command: 'node --version', lockfiles: [], env: [] }],
    ['non-string-environment-entry', { command: 'node --version', lockfiles: [], environment: [42] }],
    ['escaping-lockfile-path', { command: 'node --version', lockfiles: ['../escape.lock'], environment: [] }],
    ['git-lockfile-path', { command: 'node --version', lockfiles: ['pkg/.git/config'], environment: [] }],
    ['duplicate-environment-names', { command: 'node --version', lockfiles: [], environment: ['A', 'A'] }],
    ['duplicate-lockfile-paths', { command: 'node --version', lockfiles: ['a.lock', 'a.lock'], environment: [] }],
    ['empty-command', { command: '', lockfiles: [], environment: [] }],
  ];
  for (const [label, setup] of malformed) {
    await assertRefusalAsync('setup-malformed', () => prepareStepWorkspace(options(`attempt-malformed-${label}`, setup)));
    assert.equal(existsSync(join(waveRoot, 'attempts', `attempt-malformed-${label}`)), false, `${label} creates no workspace`);
  }
});

test('wave workspaces: setup identity and freeze receipts fail closed', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-freeze-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-freeze-root');
  const ownership = makeOwnership(t, 'wave-workspaces-freeze');
  const lockfile = join(target.worktree, 'package-lock.json');
  writeFileSync(lockfile, '{"lockfileVersion":3}\n');
  const baseCommit = target.c2;

  const options = (attemptId, overrides = {}) => ({
    ...workspaceOptions({
      target, waveRoot, ownership, packageId: 'wave-freeze', label: 'freeze', attemptId, baseCommit,
      mode: 'overlayfs', setup: { command: 'node --version', lockfiles: ['package-lock.json'], environment: [] },
      env: { HOME: process.env.HOME, PATH: process.env.PATH },
    }),
    ...overrides,
  });

  const first = await prepareStepWorkspace(options('attempt-freeze-1'));
  const second = await prepareStepWorkspace(options('attempt-freeze-2'));
  assert.equal(first.snapshotId, second.snapshotId, 'identical setup inputs keep one snapshot identity');
  assert.equal(first.lower, second.lower);

  const commandChanged = await prepareStepWorkspace(options('attempt-freeze-3', {
    setup: { command: 'node --test', lockfiles: ['package-lock.json'], environment: [] },
  }));
  assert.notEqual(commandChanged.snapshotId, first.snapshotId, 'a changed setup command changes the snapshot identity');

  writeFileSync(lockfile, '{"lockfileVersion":3,"changed":true}\n');
  const lockChanged = await prepareStepWorkspace(options('attempt-freeze-4'));
  assert.notEqual(lockChanged.snapshotId, first.snapshotId, 'changed lockfile bytes change the snapshot identity');

  await assertRefusalAsync('lockfile-missing', () => prepareStepWorkspace(options('attempt-freeze-5', {
    setup: { command: 'node --version', lockfiles: ['absent.lock'], environment: [] },
  })));

  await assertRefusalAsync('env-missing', () => prepareStepWorkspace(options('attempt-freeze-6', {
    setup: { command: 'node --version', lockfiles: [], environment: ['WAVE_REQUIRED_ENV'] },
    env: { HOME: process.env.HOME },
  })));

  for (const rootCommand of ['sudo', 'apt-get']) {
    await assertRefusalAsync('setup-root-command', () => prepareStepWorkspace(options(`attempt-freeze-root-${rootCommand}`, {
      setup: { command: `${rootCommand} install`, lockfiles: [], environment: [] },
    })));
  }

  const legal = await prepareCandidateWorkspace(options('attempt-freeze-legal', {
    setup: { command: 'npm ci --ignore-scripts', lockfiles: ['package-lock.json'], environment: [] },
  }));
  assert.equal(legal.kind, 'candidate');
  assert.equal(legal.setup.command, 'npm ci --ignore-scripts', 'the declared command string is recorded verbatim');

  await assertRefusalAsync('receipt-invalid', () => prepareStepWorkspace(options('attempt-freeze-7', { preparationReceipt: undefined })));
  await assertRefusalAsync('receipt-invalid', () => prepareStepWorkspace(options('attempt-freeze-8', {
    preparationReceipt: { ok: false, drain: 'confirmed', baseCommit, trackedClean: true },
  })));
  await assertRefusalAsync('receipt-invalid', () => prepareStepWorkspace(options('attempt-freeze-9', {
    preparationReceipt: { ok: true, drain: 'unknown', baseCommit, trackedClean: true },
  })));
  await assertRefusalAsync('receipt-invalid', () => prepareStepWorkspace(options('attempt-freeze-10', {
    preparationReceipt: { ok: true, drain: 'confirmed', baseCommit: target.c1, trackedClean: true },
  })));
  await assertRefusalAsync('receipt-invalid', () => prepareStepWorkspace(options('attempt-freeze-11', {
    preparationReceipt: { ok: true, drain: 'confirmed', baseCommit, trackedClean: false },
  })));

  writeFileSync(join(target.worktree, 'README.md'), 'dirty tracked\n');
  await assertRefusalAsync('tracked-base-changed', () => prepareStepWorkspace(options('attempt-freeze-12')));
  git(target.worktree, ['checkout', '--', 'README.md']);

  await assertRefusalAsync('tracked-base-changed', () => prepareStepWorkspace(options('attempt-freeze-13', {
    baseCommit: target.c1,
    preparationReceipt: { ok: true, drain: 'confirmed', baseCommit: target.c1, trackedClean: true },
  })));
});

// A staging input as a Runtime preparation would hand it over: the prepared
// source tree at baseCommit plus the prepared dependency output. The fixture
// materializes it; prepare never executes the declared command (step 6 owns
// contained setup execution).
function stagePreparedInput(t, target, baseCommit) {
  const root = freshRoot(t, 'wave-workspaces-staging-input');
  const source = join(root, 'source');
  const dependencies = join(root, 'dependencies');
  mkdirSync(source, { recursive: true });
  mkdirSync(dependencies, { recursive: true });
  const archive = execFileSync('git', ['-C', target.worktree, 'archive', baseCommit]);
  execFileSync('tar', ['-x', '-C', source], { input: archive });
  return { source, dependencies };
}

test('wave workspaces: staged prepared dependency output reaches the frozen lower', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-staged-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-staged-root');
  const ownership = makeOwnership(t, 'wave-workspaces-staged');
  const baseCommit = target.c2;
  const declaration = { command: 'npm ci --ignore-scripts', lockfiles: [], environment: [] };
  const staging = stagePreparedInput(t, target, baseCommit);
  mkdirSync(join(staging.dependencies, 'node_modules', 'leftpad'), { recursive: true });
  writeFileSync(join(staging.dependencies, 'node_modules', 'leftpad', 'index.js'), 'module.exports = 1;\n');
  const { snapshotId } = setupIdentity({ baseCommit, setup: declaration, targetRoot: target.worktree });
  const preparationReceipt = {
    ok: true, drain: 'confirmed', baseCommit, trackedClean: true,
    snapshotId, stagingDigest: stagingDigest(staging),
  };

  const record = await prepareStepWorkspace({
    ...workspaceOptions({
      target, waveRoot, ownership, packageId: 'wave-staged', label: 'staged', attemptId: 'attempt-staged-1', baseCommit,
      mode: 'overlayfs', setup: declaration, env: { HOME: process.env.HOME, PATH: process.env.PATH }, preparationReceipt,
    }),
    staging,
  });

  const artifact = join(record.lower, 'node_modules', 'leftpad', 'index.js');
  assert.equal(existsSync(artifact), true, 'staged prepared dependency output reaches the frozen lower');
  assert.equal(readFileSync(artifact, 'utf8'), 'module.exports = 1;\n', 'the validated staged contents are frozen verbatim');
  assert.equal(existsSync(join(record.lower, 'README.md')), true, 'the prepared source tree at baseCommit is frozen in the lower');
  assert.equal(record.snapshotId, snapshotId);
  assert.throws(
    () => git(target.worktree, ['cat-file', '-e', `${baseCommit}:node_modules/leftpad/index.js`]),
    'the source commit does not contain the dependency artifact',
  );
  assert.equal(existsSync(join(target.worktree, 'node_modules')), false, 'the live checkout is never used as the lower');
});

test('wave workspaces: preparation receipts bind identity and validated staging input', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-bind-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-bind-root');
  const ownership = makeOwnership(t, 'wave-workspaces-bind');
  const baseCommit = target.c2;
  const declaration = { command: 'npm ci --ignore-scripts', lockfiles: [], environment: [] };
  const staging = stagePreparedInput(t, target, baseCommit);
  writeFileSync(join(staging.dependencies, 'dep.js'), 'module.exports = 2;\n');
  const { snapshotId } = setupIdentity({ baseCommit, setup: declaration, targetRoot: target.worktree });
  const digest = stagingDigest(staging);
  const bound = { ok: true, drain: 'confirmed', baseCommit, trackedClean: true, snapshotId, stagingDigest: digest };
  const options = (attemptId, receipt, stagingInput = staging) => ({
    ...workspaceOptions({
      target, waveRoot, ownership, packageId: 'wave-bind', label: 'bind', attemptId, baseCommit,
      mode: 'overlayfs', setup: declaration, env: { HOME: process.env.HOME, PATH: process.env.PATH }, preparationReceipt: receipt,
    }),
    staging: stagingInput,
  });

  // A receipt that does not bind the identity is refused before anything exists.
  await assertRefusalAsync('receipt-identity-mismatch', () => prepareStepWorkspace(options('attempt-bind-1', {
    ok: true, drain: 'confirmed', baseCommit, trackedClean: true,
  })));
  assert.equal(existsSync(join(waveRoot, 'snapshots', snapshotId)), false, 'an unbound receipt publishes no lower');
  assert.equal(existsSync(join(waveRoot, 'attempts', 'attempt-bind-1')), false, 'an unbound receipt creates no attempt directory');

  await assertRefusalAsync('receipt-identity-mismatch', () => prepareStepWorkspace(options('attempt-bind-2', {
    ...bound, snapshotId: '0'.repeat(64),
  })));

  await assertRefusalAsync('receipt-identity-mismatch', () => prepareStepWorkspace(options('attempt-bind-3', {
    ...bound, stagingDigest: '0'.repeat(64),
  })));

  // A bound receipt still requires the staging input itself.
  await assertRefusalAsync('staging-invalid', () => prepareStepWorkspace(options('attempt-bind-4', bound, null)));

  // An incomplete staging input: the prepared source tree is missing a tracked path.
  rmSync(join(staging.source, 'README.md'));
  await assertRefusalAsync('staging-invalid', () => prepareStepWorkspace(options('attempt-bind-5', bound)));
  assert.equal(existsSync(join(waveRoot, 'snapshots', snapshotId)), false, 'an invalid staging input publishes no lower');
  writeFileSync(join(staging.source, 'README.md'), 'base\n');

  const record = await prepareStepWorkspace(options('attempt-bind-6', bound));
  assert.equal(record.snapshotId, snapshotId, 'a correctly bound receipt is accepted');
  assert.equal(readFileSync(join(record.lower, 'dep.js'), 'utf8'), 'module.exports = 2;\n');
});

