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
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createOverlayPhases, interpretProbeResult } from './overlay.mjs';
import { createHash as newHash } from 'node:crypto';
import {
  existsSync as pathExists,
  readFileSync as readFileBytes,
  readdirSync as listDirEntries,
  writeFileSync as writeBytes,
} from 'node:fs';
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

test('wave workspaces: replay preserves a valid empty private index', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-empty-index-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-empty-index-root');
  const ownership = makeOwnership(t, 'wave-workspaces-empty-index');
  const options = workspaceOptions({
    target, waveRoot, ownership, packageId: 'wave-empty-index',
    label: 'empty-index', attemptId: 'attempt-empty-index', baseCommit: target.c2,
  });
  const attempt = await prepareStepWorkspace(options);
  git(attempt.gitDir, ['read-tree', '--empty']);
  writeFileSync(join(attempt.merged, 'retained.txt'), 'keep worktree bytes\n');
  const tree = git(attempt.gitDir, ['write-tree']);
  const index = readFileSync(join(attempt.gitDir, 'index'));
  const head = git(attempt.gitDir, ['rev-parse', 'HEAD']);
  const worktree = treeSnapshot(attempt.merged);
  await createOverlayPhases({ ownership }).endPhase({
    token: attempt.claim.token, epoch: attempt.claim.epoch, drain: 'confirmed',
  });
  const replay = await prepareStepWorkspace(options);
  assert.deepEqual(readFileSync(join(replay.gitDir, 'index')), index, 'empty index bytes survive replay');
  assert.equal(git(replay.gitDir, ['ls-files']), '', 'all tracked deletions remain staged');
  assert.equal(git(replay.gitDir, ['write-tree']), tree, 'empty index tree survives replay');
  assert.equal(git(replay.gitDir, ['rev-parse', 'HEAD']), head, 'private HEAD survives replay');
  assert.deepEqual(treeSnapshot(replay.merged), worktree, 'worktree survives replay');
});

test('wave workspaces: replay seeds a missing or unreadable private index', async t => {
  for (const state of ['missing', 'unreadable']) {
    await t.test(state, async t => {
      const target = makeTargetRepo(t, `wave-workspaces-${state}-index-target`);
      const waveRoot = freshRoot(t, `wave-workspaces-${state}-index-root`);
      const ownership = makeOwnership(t, `wave-workspaces-${state}-index`);
      const options = workspaceOptions({
        target, waveRoot, ownership, packageId: `wave-${state}-index`,
        label: `${state}-index`, attemptId: 'attempt-index', baseCommit: target.c2,
      });
      const attempt = await prepareStepWorkspace(options);
      const indexPath = join(attempt.gitDir, 'index');
      if (state === 'missing') rmSync(indexPath);
      else writeFileSync(indexPath, 'invalid index bytes\n');
      const head = git(attempt.gitDir, ['rev-parse', 'HEAD']);
      const worktree = treeSnapshot(attempt.merged);
      await createOverlayPhases({ ownership }).endPhase({
        token: attempt.claim.token, epoch: attempt.claim.epoch, drain: 'confirmed',
      });
      const replay = await prepareStepWorkspace(options);
      assert.equal(git(replay.gitDir, ['write-tree']), git(target.worktree, ['rev-parse', `${target.c2}^{tree}`]));
      assert.equal(git(replay.gitDir, ['rev-parse', 'HEAD']), head);
      assert.deepEqual(treeSnapshot(replay.merged), worktree);
    });
  }
});

test('wave workspaces: private Git metadata stays independent and imports exact heads', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-git-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-git-root');
  const ownership = makeOwnership(t, 'wave-workspaces-git');
  const common = { target, waveRoot, ownership, packageId: 'wave-git', label: 'git', baseCommit: target.c2, mode: 'overlayfs' };

  const canonicalHead = git(target.worktree, ['rev-parse', 'HEAD']);
  const canonicalRefs = git(target.worktree, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const canonicalObjects = git(target.worktree, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']).split('\n').sort().join('\n');
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

  // The private base resolves to the exact base commit with the base commit's
  // tree as its index, while nothing from the base is checked out into the
  // attempt worktree.
  const baseTree = git(target.worktree, ['rev-parse', `${target.c2}^{tree}`]);
  const basePaths = git(target.worktree, ['ls-tree', '-r', '--name-only', target.c2]).split('\n');
  for (const record of [attemptA, attemptB]) {
    assert.equal(git(record.gitDir, ['rev-parse', 'HEAD']), target.c2, 'private HEAD resolves to the base commit');
    assert.equal(git(record.gitDir, ['rev-parse', 'HEAD^{tree}']), baseTree, 'private HEAD carries the base tree');
    assert.equal(git(record.gitDir, ['write-tree']), baseTree, 'the private index carries exactly the base commit tree');
    assert.deepEqual(git(record.gitDir, ['ls-files']).split('\n'), basePaths, 'ls-files agrees with the base tree');
    for (const path of basePaths) {
      assert.ok(!existsSync(join(record.merged, path)), `${path} is not checked out into the attempt worktree`);
    }
    assert.ok(!existsSync(join(record.merged, 'README.md')), 'no base file is checked out into the attempt worktree');
  }

  // An ordinary commit in the private repository extends the base commit
  // instead of starting unrelated history.
  for (const record of [attemptA, attemptB]) {
    writeFileSync(join(record.merged, 'commit-probe.txt'), 'commit probe\n');
    execFileSync('git', ['--git-dir', record.gitDir, '--work-tree', record.merged, 'add', 'commit-probe.txt'], { cwd: record.merged, ...GIT });
    execFileSync('git', [
      '--git-dir', record.gitDir, '--work-tree', record.merged,
      '-c', 'user.email=wave-editor@example.test', '-c', 'user.name=Wave Editor',
      'commit', '-q', '-m', 'probe commit',
    ], { cwd: record.merged, ...GIT });
    assert.equal(git(record.gitDir, ['rev-parse', 'HEAD^']), target.c2, 'an ordinary commit has the base commit as its parent');
    assert.equal(git(record.gitDir, ['rev-parse', 'HEAD^^{tree}']), baseTree, 'the parent commit carries the base tree');
  }

  // Private provisioning leaves the canonical repository untouched.
  assert.equal(git(target.worktree, ['rev-parse', 'HEAD']), canonicalHead, 'canonical HEAD is untouched');
  assert.equal(git(target.worktree, ['for-each-ref', '--format=%(refname) %(objectname)']), canonicalRefs, 'canonical refs are untouched');
  assert.equal(git(target.worktree, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']).split('\n').sort().join('\n'), canonicalObjects, 'canonical objects are untouched');

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

test('wave workspaces: a novel private head is imported with its exact objects', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-novel-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-novel-root');
  const ownership = makeOwnership(t, 'wave-workspaces-novel');
  const attempt = await prepareStepWorkspace(workspaceOptions({
    target,
    waveRoot,
    ownership,
    packageId: 'wave-novel',
    label: 'novel',
    attemptId: 'attempt-novel',
    baseCommit: target.c2,
    mode: 'overlayfs',
  }));
  const privateGit = args => execFileSync('git', ['--git-dir', attempt.gitDir, ...args], GIT).trim();
  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Wave Reviewer',
    GIT_AUTHOR_EMAIL: 'wave-reviewer@example.test',
    GIT_AUTHOR_DATE: '2026-10-15T00:00:00 +0000',
    GIT_COMMITTER_NAME: 'Wave Reviewer',
    GIT_COMMITTER_EMAIL: 'wave-reviewer@example.test',
    GIT_COMMITTER_DATE: '2026-10-15T00:00:00 +0000',
  };

  // A genuinely novel commit exists only in the attempt's private repository.
  const expectedParent = privateGit(['rev-parse', 'HEAD']);
  mkdirSync(join(attempt.merged, 'docs'), { recursive: true });
  writeFileSync(join(attempt.merged, 'docs', 'novel-import.txt'), 'novel private payload\n');
  execFileSync('git', ['--git-dir', attempt.gitDir, '--work-tree', attempt.merged, 'add', '--', 'docs/novel-import.txt'], GIT);
  execFileSync('git', ['--git-dir', attempt.gitDir, '--work-tree', attempt.merged, 'commit', '-q', '-m', 'novel private head'], { ...GIT, env: commitEnv });
  const novelSha = privateGit(['rev-parse', 'HEAD']);
  const novelTree = privateGit(['rev-parse', `${novelSha}^{tree}`]);
  const baseTree = privateGit(['rev-parse', `${target.c2}^{tree}`]);
  assert.notEqual(novelSha, target.c2, 'the novel head is a new commit');
  assert.notEqual(novelTree, baseTree, 'the novel commit changes the tree');
  assert.equal(privateGit(['rev-parse', `${novelSha}^`]), expectedParent, 'the novel commit records the expected parent');

  // The canonical repository genuinely lacks the novel object before the import.
  assert.throws(
    () => git(target.worktree, ['cat-file', '-e', `${novelSha}^{commit}`]),
    'the canonical repository lacks the novel commit object',
  );
  assert.throws(
    () => git(target.worktree, ['rev-parse', '--verify', `${novelSha}^{commit}`]),
    'the novel sha does not verify in the canonical repository',
  );
  assert.ok(
    !existsSync(join(target.worktree, '.git', 'objects', novelSha.slice(0, 2), novelSha.slice(2))),
    'no loose novel object exists in the canonical object store',
  );

  const privateHeadBeforeImport = privateGit(['rev-parse', 'HEAD']);
  const retentionRef = 'refs/waves/retained/novel-head';
  await importSealedHead({ repo: target.worktree, source: attempt.gitDir, sha: novelSha, retentionRef });

  // The canonical repository now holds the exact novel objects.
  assert.doesNotThrow(() => git(target.worktree, ['cat-file', '-e', `${novelSha}^{commit}`]), 'the novel commit resolves in the canonical repository');
  assert.equal(git(target.worktree, ['cat-file', '-t', novelSha]), 'commit', 'the novel sha is a commit in the canonical repository');
  assert.equal(git(target.worktree, ['rev-parse', `${novelSha}^{tree}`]), novelTree, 'the exact changed tree is imported');
  assert.notEqual(git(target.worktree, ['rev-parse', `${novelSha}^{tree}`]), baseTree, 'the imported tree is not the base tree');
  assert.equal(git(target.worktree, ['rev-parse', `${novelSha}^`]), expectedParent, 'the expected parent commit is preserved');
  assert.doesNotThrow(() => git(target.worktree, ['merge-base', '--is-ancestor', target.c1, novelSha]), 'the first base commit is an ancestor of the novel head');
  assert.doesNotThrow(() => git(target.worktree, ['merge-base', '--is-ancestor', target.c2, novelSha]), 'the base commit is an ancestor of the novel head');
  assert.notEqual(novelSha, target.c2, 'the base commit is a proper ancestor of the novel head');
  assert.equal(
    git(target.worktree, ['cat-file', '-p', `${novelSha}:docs/novel-import.txt`]),
    'novel private payload',
    'the changed blob is present at its exact path',
  );
  assert.equal(git(target.worktree, ['rev-parse', retentionRef]), novelSha, 'the retention ref names the novel sha');
  assert.ok(!existsSync(join(target.worktree, '.git', 'objects', 'info', 'alternates')), 'no alternates are left behind');

  // The private repository is unchanged by the import.
  assert.equal(privateGit(['rev-parse', 'HEAD']), privateHeadBeforeImport, 'the private head is untouched');
  assert.equal(privateGit(['rev-parse', `${novelSha}^{tree}`]), novelTree, 'the private objects are untouched');
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

// F6: a retained record is re-mountable only while it still describes the
// requested attempt and a real, intact workspace on disk. These cases tamper
// with the record's agreement with the requested attempt or with the retained
// paths themselves; each must refuse with one named reason, take no claim and
// leave every surviving retained byte untouched (non-destructive refusal).

function retainedRequest(record, waveRoot, overrides = {}) {
  return {
    backend: record.backend,
    waveRoot,
    attemptId: record.retained.upperId,
    snapshotId: record.snapshotId,
    baseCommit: record.baseCommit,
    ...overrides,
  };
}

// Byte-level snapshot of a retained path tree (files, directories, symlink
// targets) so a refused remount can be proven non-destructive.
function treeSnapshot(root) {
  const entries = new Map();
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) entries.set(rel, `symlink:${readlinkSync(abs)}`);
      else if (stat.isDirectory()) { entries.set(rel, 'dir'); walk(abs, rel); }
      else entries.set(rel, readFileSync(abs));
    }
  };
  walk(root, '');
  return entries;
}

async function assertNoClaims(ownership, label) {
  const { claims } = await ownership.inspectClaims();
  assert.deepEqual(claims, [], `${label}: no phase claim may be taken`);
}

test('wave workspaces: a retained record whose identity no longer matches refuses to remount', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-retained-identity-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-retained-identity-root');
  const ownership = makeOwnership(t, 'wave-workspaces-retained-identity');
  const phases = createOverlayPhases({ ownership });

  const record = await prepareStepWorkspace(workspaceOptions({
    target, waveRoot, ownership, packageId: 'wave-retained-identity', label: 'retained-identity',
    attemptId: 'attempt-retained-identity', baseCommit: target.c2, mode: 'overlayfs',
  }));
  assert.equal(record.backend, 'overlayfs');
  const expected = {
    lower: record.lower, upper: record.upper, work: record.work, merged: record.merged,
    gitDir: record.gitDir, baseCommit: record.baseCommit, snapshotId: record.snapshotId,
  };
  const released = await phases.endPhase({ token: record.claim.token, epoch: record.claim.epoch, drain: 'confirmed' });
  assert.equal(released.status, 'released', 'the prior phase is positively drained');

  const before = {
    lower: treeSnapshot(record.lower), upper: treeSnapshot(record.upper), work: treeSnapshot(record.work),
    merged: treeSnapshot(record.merged), gitDir: treeSnapshot(record.gitDir),
  };

  const remount = request => remountRetainedWorkspace({
    retained: JSON.parse(JSON.stringify(record.retained)),
    expected,
    previous: { token: record.claim.token, epoch: record.claim.epoch },
    phaseToken: 'phase-retained-identity-next',
    coordinator: coordinatorFor('retained-identity'),
    ownership,
    request,
  });

  for (const [label, request] of [
    ['a different attempt identity', retainedRequest(record, waveRoot, { attemptId: 'attempt-someone-else' })],
    ['a different snapshot', retainedRequest(record, waveRoot, { snapshotId: 'snapshot-someone-else' })],
    ['a different base commit', retainedRequest(record, waveRoot, { baseCommit: target.c1 })],
    ['a different wave root', retainedRequest(record, waveRoot, { waveRoot: freshRoot(t, 'wave-workspaces-retained-identity-other') })],
  ]) {
    await assertRefusalAsync('retained-workspace-invalid', () => remount(request));
    await assertNoClaims(ownership, label);
  }

  assert.deepEqual({
    lower: treeSnapshot(record.lower), upper: treeSnapshot(record.upper), work: treeSnapshot(record.work),
    merged: treeSnapshot(record.merged), gitDir: treeSnapshot(record.gitDir),
  }, before, 'every retained path is byte-identical after the refused remounts');

  // A request that still agrees with the record remounts exactly as today.
  const remounted = await remount(retainedRequest(record, waveRoot));
  assert.equal(remounted.backend, 'overlayfs');
  assert.equal(remounted.upper, record.upper);
  assert.equal(remounted.merged, record.merged);
});

test('wave workspaces: a retained record with missing or redirected layers refuses to remount', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-retained-layers-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-retained-layers-root');
  const ownership = makeOwnership(t, 'wave-workspaces-retained-layers');
  const phases = createOverlayPhases({ ownership });

  const prepare = attemptId => prepareStepWorkspace(workspaceOptions({
    target, waveRoot, ownership, packageId: 'wave-retained-layers', label: 'retained-layers',
    attemptId, baseCommit: target.c2, mode: 'overlayfs',
  }));
  const remountFor = record => remountRetainedWorkspace({
    retained: JSON.parse(JSON.stringify(record.retained)),
    expected: {
      lower: record.lower, upper: record.upper, work: record.work, merged: record.merged,
      gitDir: record.gitDir, baseCommit: record.baseCommit, snapshotId: record.snapshotId,
    },
    previous: { token: record.claim.token, epoch: record.claim.epoch },
    phaseToken: `phase-${record.retained.upperId}-next`,
    coordinator: coordinatorFor('retained-layers'),
    ownership,
    request: retainedRequest(record, waveRoot),
  });
  const drain = async record => {
    const released = await phases.endPhase({ token: record.claim.token, epoch: record.claim.epoch, drain: 'confirmed' });
    assert.equal(released.status, 'released', 'the prior phase is positively drained');
  };

  // Sub-case one: the merged layer directory is gone.
  const missing = await prepare('attempt-retained-missing-merged');
  await drain(missing);
  const missingLower = treeSnapshot(missing.lower);
  const missingUpper = treeSnapshot(missing.upper);
  rmSync(missing.merged, { recursive: true, force: true });
  await assertRefusalAsync('retained-workspace-invalid', () => remountFor(missing));
  await assertNoClaims(ownership, 'missing merged');
  assert.ok(!existsSync(missing.merged), 'the refused remount never recreates the merged layer');
  assert.deepEqual(treeSnapshot(missing.lower), missingLower, 'the surviving retained bytes are unchanged');
  assert.deepEqual(treeSnapshot(missing.upper), missingUpper, 'the surviving retained bytes are unchanged');

  // Sub-case two: a layer is replaced by a symbolic link pointing outside the
  // wave root.
  const redirected = await prepare('attempt-retained-redirected-work');
  await drain(redirected);
  const outside = freshRoot(t, 'wave-workspaces-retained-layers-outside');
  writeFileSync(join(outside, 'outside.txt'), 'outside\n');
  const redirectedLower = treeSnapshot(redirected.lower);
  const redirectedUpper = treeSnapshot(redirected.upper);
  rmSync(redirected.work, { recursive: true, force: true });
  symlinkSync(outside, redirected.work);
  await assertRefusalAsync('retained-workspace-invalid', () => remountFor(redirected));
  await assertNoClaims(ownership, 'redirected work');
  assert.equal(lstatSync(redirected.work).isSymbolicLink(), true, 'the refused remount deletes nothing');
  assert.equal(readlinkSync(redirected.work), outside, 'the redirection is left exactly as it is');
  assert.deepEqual(treeSnapshot(redirected.lower), redirectedLower, 'the surviving retained bytes are unchanged');
  assert.deepEqual(treeSnapshot(redirected.upper), redirectedUpper, 'the surviving retained bytes are unchanged');
  assert.deepEqual(treeSnapshot(outside), new Map([['outside.txt', Buffer.from('outside\n')]]), 'the outside target is untouched');
});

test('wave workspaces: a retained fallback worktree whose path vanished refuses to remount', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-retained-worktree-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-retained-worktree-root');
  const ownership = makeOwnership(t, 'wave-workspaces-retained-worktree');
  const phases = createOverlayPhases({ ownership });

  const record = await prepareStepWorkspace(workspaceOptions({
    target, waveRoot, ownership, packageId: 'wave-retained-worktree', label: 'retained-worktree',
    attemptId: 'attempt-retained-worktree', baseCommit: target.c2, mode: 'worktree',
  }));
  assert.equal(record.backend, 'worktree');
  assert.ok(record.worktree, 'the fallback attempt records its worktree path');
  const released = await phases.endPhase({ token: record.claim.token, epoch: record.claim.epoch, drain: 'confirmed' });
  assert.equal(released.status, 'released', 'the prior phase is positively drained');
  rmSync(record.worktree, { recursive: true, force: true });

  await assertRefusalAsync('retained-workspace-invalid', () => remountRetainedWorkspace({
    retained: JSON.parse(JSON.stringify(record.retained)),
    expected: {
      lower: record.lower, upper: record.upper, work: record.work, merged: record.merged,
      gitDir: record.gitDir, baseCommit: record.baseCommit, snapshotId: record.snapshotId,
    },
    previous: { token: record.claim.token, epoch: record.claim.epoch },
    phaseToken: 'phase-retained-worktree-next',
    coordinator: coordinatorFor('retained-worktree'),
    ownership,
    request: retainedRequest(record, waveRoot),
  }));
  await assertNoClaims(ownership, 'vanished worktree');
  assert.ok(!existsSync(record.worktree), 'the refused remount does not recreate the vanished worktree');
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

test('wave workspaces: interrupted snapshot publication is recovered or named distinctly', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-publish-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-publish-root');
  const ownership = makeOwnership(t, 'wave-workspaces-publish');
  const baseCommit = target.c2;
  const declaration = { command: 'npm ci --ignore-scripts', lockfiles: [], environment: [] };
  const staging = stagePreparedInput(t, target, baseCommit);
  const { snapshotId } = setupIdentity({ baseCommit, setup: declaration, targetRoot: target.worktree });
  const preparationReceipt = {
    ok: true, drain: 'confirmed', baseCommit, trackedClean: true,
    snapshotId, stagingDigest: stagingDigest(staging),
  };
  const snapshotDir = join(waveRoot, 'snapshots');
  const snapshotRoot = join(snapshotDir, snapshotId);
  const options = attemptId => ({
    ...workspaceOptions({
      target, waveRoot, ownership, packageId: 'wave-publish', label: 'publish', attemptId, baseCommit,
      mode: 'overlayfs', setup: declaration, env: { HOME: process.env.HOME, PATH: process.env.PATH }, preparationReceipt,
    }),
    staging,
  });

  // Interrupted publication, case one: only a leftover publication temporary
  // directory beside the final snapshot root exists.
  const leftover = join(snapshotDir, `.publish-${snapshotId}`);
  mkdirSync(join(leftover, 'lower'), { recursive: true });
  writeFileSync(join(leftover, 'lower', 'poison.txt'), 'interrupted mid-copy\n');

  const recovered = await prepareStepWorkspace(options('attempt-publish-1'));
  assert.equal(existsSync(snapshotRoot), true, 'recovery ends with the snapshot at the final path');
  assert.equal(existsSync(leftover), false, 'the leftover publication temporary directory is discarded, never adopted');
  assert.equal(existsSync(join(recovered.lower, 'poison.txt')), false, 'a leftover partial lower is never adopted blindly');
  assert.equal(readFileSync(join(recovered.lower, 'README.md'), 'utf8'), 'base\n', 'the recovered lower is complete');
  const recordName = readdirSync(snapshotRoot).find(name => name !== 'lower');
  assert.ok(recordName, 'the recovered snapshot carries its record beside the lower');

  const reused = await prepareStepWorkspace(options('attempt-publish-2'));
  assert.equal(readFileSync(join(reused.lower, 'README.md'), 'utf8'), 'base\n', 'a subsequent call yields a usable complete frozen lower');

  // Interrupted publication, case two: the final path exists but is
  // incomplete. The exact-reason match below also proves it is never reported
  // as snapshot-mismatch.
  rmSync(snapshotRoot, { recursive: true, force: true });
  mkdirSync(join(snapshotRoot, 'lower'), { recursive: true });
  writeFileSync(join(snapshotRoot, 'lower', 'half.txt'), 'half built\n');
  await assertRefusalAsync('snapshot-publication-incomplete', () => prepareStepWorkspace(options('attempt-publish-3')));

  rmSync(join(snapshotRoot, 'lower'), { recursive: true, force: true });
  writeFileSync(join(snapshotRoot, recordName), `${JSON.stringify({ version: 1, snapshotId, identity: {} }, null, 2)}\n`);
  await assertRefusalAsync('snapshot-publication-incomplete', () => prepareStepWorkspace(options('attempt-publish-4')));

  // Clearing the incomplete final path lets the next call rebuild a complete
  // frozen lower.
  rmSync(snapshotRoot, { recursive: true, force: true });
  const rebuilt = await prepareStepWorkspace(options('attempt-publish-5'));
  assert.equal(readFileSync(join(rebuilt.lower, 'README.md'), 'utf8'), 'base\n', 'a subsequent call yields a usable complete frozen lower');
});

test('wave workspaces: a complete snapshot with a conflicting identity still refuses as snapshot-mismatch', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-conflict-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-conflict-root');
  const ownership = makeOwnership(t, 'wave-workspaces-conflict');
  const baseCommit = target.c2;
  const declaration = { command: 'npm ci --ignore-scripts', lockfiles: [], environment: [] };
  const staging = stagePreparedInput(t, target, baseCommit);
  const { snapshotId } = setupIdentity({ baseCommit, setup: declaration, targetRoot: target.worktree });
  const preparationReceipt = {
    ok: true, drain: 'confirmed', baseCommit, trackedClean: true,
    snapshotId, stagingDigest: stagingDigest(staging),
  };
  const options = attemptId => ({
    ...workspaceOptions({
      target, waveRoot, ownership, packageId: 'wave-conflict', label: 'conflict', attemptId, baseCommit,
      mode: 'overlayfs', setup: declaration, env: { HOME: process.env.HOME, PATH: process.env.PATH }, preparationReceipt,
    }),
    staging,
  });

  const first = await prepareStepWorkspace(options('attempt-conflict-1'));
  const snapshotRoot = join(waveRoot, 'snapshots', snapshotId);
  const recordName = readdirSync(snapshotRoot).find(name => name !== 'lower');
  const stored = JSON.parse(readFileSync(join(snapshotRoot, recordName), 'utf8'));
  stored.identity = { ...stored.identity, tampered: true };
  writeFileSync(join(snapshotRoot, recordName), `${JSON.stringify(stored, null, 2)}\n`);
  assert.equal(existsSync(first.lower), true, 'the snapshot stays structurally complete');

  await assertRefusalAsync('snapshot-mismatch', () => prepareStepWorkspace(options('attempt-conflict-2')));
});

function dirEntries(dir) {
  return listDirEntries(dir, { withFileTypes: true }).map(entry => entry.name).sort();
}

function digestTree(root) {
  const hash = newHash('sha256');
  const walk = dir => {
    for (const entry of listDirEntries(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      hash.update(`${entry.name} ${entry.isSymbolicLink() ? 'l' : entry.isDirectory() ? 'd' : 'f'}\n`);
      if (entry.isSymbolicLink()) hash.update(readFileBytes(full, 'utf8'));
      else if (entry.isDirectory()) walk(full);
      else hash.update(readFileBytes(full));
    }
  };
  walk(root);
  return hash.digest('hex');
}

test('wave workspaces: a losing contender cannot mutate a held attempt', async t => {
  const target = makeTargetRepo(t, 'loser-target');
  const waveRoot = freshRoot(t, 'loser-wave');
  const ownership = makeOwnership(t, 'loser');
  const attemptId = 'attempt-loser';
  const common = { target, waveRoot, ownership, packageId: 'wave-loser', attemptId, baseCommit: target.c2 };
  // The holder is built through the real provision path, so the attempt holds
  // its claim before any overlay layer or private Git config exists.
  const holder = await prepareStepWorkspace(workspaceOptions({
    ...common,
    label: 'loser-holder',
    mode: 'auto',
    capability: fallbackCapability(),
  }));
  assert.equal(typeof holder.claim.token, 'string');
  assert.equal(typeof holder.claim.epoch, 'number');
  const attemptRoot = join(waveRoot, 'attempts', attemptId);
  assert.deepEqual(dirEntries(attemptRoot), ['worktree']);
  const before = { attempt: digestTree(attemptRoot), repo: digestTree(target.worktree) };
  await assertRefusalAsync('upper-held', () => prepareStepWorkspace(workspaceOptions({ ...common, label: 'loser-contender' })));
  assert.deepEqual(dirEntries(attemptRoot), ['worktree'], 'the refused attempt created no layer directory');
  assert.equal(pathExists(join(attemptRoot, 'git', 'config')), false, 'the refused attempt wrote no private Git config');
  assert.equal(digestTree(attemptRoot), before.attempt, 'the attempt root is byte-identical after the refusal');
  assert.equal(digestTree(target.worktree), before.repo, 'the canonical repository is byte-identical after the refusal');
  // Replay by the claim holder stays non-destructive: an existing valid
  // worktree at the same head is retained and the held claim is reused.
  const replayed = await prepareStepWorkspace(workspaceOptions({
    ...common,
    label: 'loser-holder',
    mode: 'auto',
    capability: fallbackCapability(),
  }));
  assert.equal(replayed.claim.token, holder.claim.token, 'the replay did not reuse the held claim');
  assert.equal(replayed.worktree, holder.worktree, 'the replay recreated the worktree');
  assert.equal(digestTree(attemptRoot), before.attempt, 'the replay recreated the held attempt state');
  // An existing valid overlay state is likewise reused, not recreated.
  const overlayId = 'attempt-loser-overlay';
  const overlayOptions = workspaceOptions({ ...common, attemptId: overlayId, label: 'loser-overlay' });
  const overlayHolder = await prepareStepWorkspace(overlayOptions);
  writeBytes(join(overlayHolder.upper, 'dirty.txt'), 'kept\n');
  const overlayRoot = join(waveRoot, 'attempts', overlayId);
  const overlayDirty = digestTree(overlayRoot);
  const overlayReplay = await prepareStepWorkspace(overlayOptions);
  assert.equal(overlayReplay.claim.token, overlayHolder.claim.token, 'the overlay replay did not reuse the held claim');
  assert.equal(pathExists(join(overlayHolder.upper, 'dirty.txt')), true, 'the overlay replay destroyed the held overlay state');
  assert.equal(digestTree(overlayRoot), overlayDirty, 'the overlay replay recreated the attempt state');
});

test('wave workspaces: worktree fallback attempts hold ownership before any worktree write', async t => {
  const target = makeTargetRepo(t, 'fallback-own-target');
  const waveRoot = freshRoot(t, 'fallback-own-wave');
  const ownership = makeOwnership(t, 'fallback-own');
  const attemptId = 'attempt-fallback-own';
  const common = {
    target,
    waveRoot,
    ownership,
    packageId: 'wave-fallback-own',
    attemptId,
    baseCommit: target.c2,
    mode: 'auto',
    capability: fallbackCapability(),
  };
  const holder = await prepareStepWorkspace(workspaceOptions({ ...common, label: 'fallback-own-holder' }));
  assert.equal(typeof holder.claim.token, 'string', 'the fallback record carries a real claim token');
  assert.equal(typeof holder.claim.epoch, 'number', 'the fallback record carries a numeric claim epoch');
  assert.equal(Object.isFrozen(holder.claim), true);
  const attemptRoot = join(waveRoot, 'attempts', attemptId);
  const before = { listing: dirEntries(attemptRoot), location: digestTree(attemptRoot) };
  await assertRefusalAsync('upper-held', () => prepareStepWorkspace(workspaceOptions({ ...common, label: 'fallback-own-contender' })));
  assert.deepEqual(dirEntries(attemptRoot), before.listing, 'the refusal added nothing under the fallback worktree location');
  assert.equal(digestTree(attemptRoot), before.location, 'the fallback worktree location is byte-identical after the refusal');
  // Replay of the held attempt is non-destructive: the worktree state survives.
  writeBytes(join(holder.worktree, 'dirty.txt'), 'kept\n');
  const dirty = digestTree(attemptRoot);
  const replayed = await prepareStepWorkspace(workspaceOptions({ ...common, label: 'fallback-own-holder' }));
  assert.equal(replayed.claim.token, holder.claim.token, 'the replay did not reuse the held claim');
  assert.equal(pathExists(join(holder.worktree, 'dirty.txt')), true, 'the replay destroyed the worktree state');
  assert.equal(digestTree(attemptRoot), dirty, 'the replay recreated the fallback worktree');
});

test('wave workspaces: an attempt cannot change backend after it is written', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-conv-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-conv-root');
  const ownership = makeOwnership(t, 'wave-workspaces-conv');
  const attemptId = 'attempt-conv';
  const common = {
    target, waveRoot, ownership, packageId: 'wave-conv', attemptId, baseCommit: target.c2,
    label: 'conv', mode: 'overlayfs', capability: supportedCapability(),
  };
  const holder = await prepareStepWorkspace(workspaceOptions(common));
  assert.equal(holder.backend, 'overlayfs');
  writeFileSync(join(holder.upper, 'dirty.txt'), 'kept\n');
  const attemptRoot = join(waveRoot, 'attempts', attemptId);
  const before = { upper: digestTree(holder.upper), attempt: digestTree(attemptRoot) };

  // The written attempt's own holder re-prepares the same attemptId as an
  // explicit worktree request while the overlay claim is still live. The
  // conversion is prohibited: it refuses before any worktree is created and
  // before any dirty state is touched.
  await assertRefusalAsync('backend-conversion-prohibited', () => prepareStepWorkspace(workspaceOptions({
    ...common,
    mode: 'worktree',
  })));
  assert.equal(readFileSync(join(holder.upper, 'dirty.txt'), 'utf8'), 'kept\n', 'the dirty upper bytes survive the refused conversion');
  assert.equal(digestTree(holder.upper), before.upper, 'the refused conversion left the dirty upper byte-identical');
  assert.equal(digestTree(attemptRoot), before.attempt, 'the refused conversion left the attempt state byte-identical');
  assert.equal(pathExists(join(attemptRoot, 'worktree')), false, 'the refused conversion created no fallback worktree');

  // The retained record is unchanged: a replay under the original backend
  // still returns the identical durable retained identity.
  const replayed = await prepareStepWorkspace(workspaceOptions(common));
  assert.equal(replayed.backend, 'overlayfs');
  assert.deepEqual(replayed.retained, holder.retained, 'the retained record is unchanged after the refused conversion');
});

test('wave workspaces: automatic selection cannot convert a written attempt', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-autoconv-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-autoconv-root');
  const ownership = makeOwnership(t, 'wave-workspaces-autoconv');
  const attemptId = 'attempt-autoconv';
  const common = {
    target, waveRoot, ownership, packageId: 'wave-autoconv', attemptId, baseCommit: target.c2,
    label: 'autoconv', mode: 'overlayfs', capability: supportedCapability(),
  };
  const holder = await prepareStepWorkspace(workspaceOptions(common));
  assert.equal(holder.backend, 'overlayfs');
  writeFileSync(join(holder.upper, 'dirty.txt'), 'kept\n');
  const attemptRoot = join(waveRoot, 'attempts', attemptId);
  const before = { upper: digestTree(holder.upper), attempt: digestTree(attemptRoot) };

  // With the overlay backend unavailable an automatic request would silently
  // select the worktree fallback; the written attempt must refuse the
  // conversion identically instead of converting behind its dirty upper.
  await assertRefusalAsync('backend-conversion-prohibited', () => prepareStepWorkspace(workspaceOptions({
    ...common,
    mode: 'auto',
    capability: fallbackCapability(),
  })));
  assert.equal(readFileSync(join(holder.upper, 'dirty.txt'), 'utf8'), 'kept\n', 'the attached upper survives the refused automatic conversion');
  assert.equal(digestTree(holder.upper), before.upper, 'the refused conversion left the dirty upper byte-identical');
  assert.equal(digestTree(attemptRoot), before.attempt, 'the refused conversion left the attempt state byte-identical');
  assert.equal(pathExists(join(attemptRoot, 'worktree')), false, 'no fallback worktree was silently selected');
});

test('wave workspaces: backend provenance records requested selection and remedy', async t => {
  const target = makeTargetRepo(t, 'wave-workspaces-prov-target');
  const waveRoot = freshRoot(t, 'wave-workspaces-prov-root');
  const ownership = makeOwnership(t, 'wave-workspaces-prov');
  const baseCommit = target.c2;

  const provenanceOf = record => ({
    requestedBackend: record.requestedBackend,
    selectedBackend: record.selectedBackend,
    backendReason: record.backendReason,
    backendRemedy: record.backendRemedy,
    capability: record.capability,
  });
  const assertProvenance = (record, expected, attemptId, label) => {
    assert.equal(record.backend, expected.selectedBackend, `${label}: backend still reads the selected backend`);
    assert.equal(record.requestedBackend, expected.requestedBackend, `${label}: the requested backend is recorded truthfully`);
    assert.equal(record.selectedBackend, expected.selectedBackend, `${label}: the selected backend is recorded truthfully`);
    assert.equal(typeof record.backendReason, 'string', `${label}: the classification reason is a string`);
    assert.ok(record.backendReason.length > 0, `${label}: the classification reason is non-empty`);
    assert.equal(typeof record.backendRemedy, 'string', `${label}: the remedy is a string`);
    assert.ok(record.backendRemedy.length > 0, `${label}: the remedy is non-empty`);
    assert.ok(record.capability && typeof record.capability === 'object', `${label}: the classified capability is carried`);
    assert.ok(record.retained, `${label}: the record carries a retained identity`);
    assert.deepEqual(provenanceOf(record.retained), provenanceOf(record), `${label}: the retained record carries the same provenance`);
    const durable = JSON.parse(readFileSync(join(waveRoot, 'attempts', `${attemptId}.workspace-identity.json`), 'utf8'));
    assert.deepEqual(provenanceOf(durable), provenanceOf(record), `${label}: the durable attempt record carries the same provenance`);
    assert.equal(durable.backend, expected.selectedBackend, `${label}: the durable record keeps the selected backend`);
    assert.equal(durable.attemptId, attemptId, `${label}: the durable record binds the attempt identity`);
  };

  // An explicit worktree request records requested and selected as worktree.
  const explicit = await prepareStepWorkspace(workspaceOptions({
    target, waveRoot, ownership, packageId: 'wave-prov', attemptId: 'attempt-prov-worktree', baseCommit,
    label: 'prov-worktree', mode: 'worktree', capability: supportedCapability(),
  }));
  assertProvenance(explicit, { requestedBackend: 'worktree', selectedBackend: 'worktree' }, 'attempt-prov-worktree', 'explicit worktree');

  // An automatic request with the overlay backend unavailable records
  // requested auto, selected worktree, a non-empty reason and a non-empty
  // remedy (and the capability), while backend still reads worktree.
  const automatic = await prepareStepWorkspace(workspaceOptions({
    target, waveRoot, ownership, packageId: 'wave-prov', attemptId: 'attempt-prov-auto', baseCommit,
    label: 'prov-auto', mode: 'auto', capability: fallbackCapability(),
  }));
  assertProvenance(automatic, { requestedBackend: 'auto', selectedBackend: 'worktree' }, 'attempt-prov-auto', 'auto fallback');

  // A supported automatic selection is recorded just as truthfully.
  const overlay = await prepareStepWorkspace(workspaceOptions({
    target, waveRoot, ownership, packageId: 'wave-prov', attemptId: 'attempt-prov-overlay', baseCommit,
    label: 'prov-overlay', mode: 'auto', capability: supportedCapability(),
  }));
  assertProvenance(overlay, { requestedBackend: 'auto', selectedBackend: 'overlayfs' }, 'attempt-prov-overlay', 'auto overlayfs');
});
test('wave workspaces: concurrent snapshot publishers never expose an interrupted partial lower', { timeout: 60000 }, async t => {
  for (const interrupt of [true, false]) {
    await t.test(interrupt ? 'interrupted contender' : 'completed contender reuses winner', async t => {
      const target = makeTargetRepo(t, 'wave-concurrent-target');
      const waveRoot = freshRoot(t, 'wave-concurrent-root');
      const registryRoot = freshRoot(t, 'wave-concurrent-ownership');
      const signals = freshRoot(t, 'wave-concurrent-signals');
      const staging = stagePreparedInput(t, target, target.c2);
      writeFileSync(join(staging.dependencies, 'dependency.txt'), 'prepared dependency\n');
      const setup = { command: 'node --version', lockfiles: [], environment: [] };
      const { snapshotId } = setupIdentity({ baseCommit: target.c2, setup, targetRoot: target.worktree });
      const options = {
        ...workspaceOptions({
          target, waveRoot, packageId: 'wave-concurrent', label: 'concurrent', baseCommit: target.c2,
          preparationReceipt: {
            ok: true, drain: 'confirmed', baseCommit: target.c2, trackedClean: true,
            snapshotId, stagingDigest: stagingDigest(staging),
          },
        }),
        staging,
      };
      const childCode = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { join } from 'node:path';
        const { options, registryRoot, signals, role, interrupt, moduleUrl, ownershipUrl } = JSON.parse(process.argv[1]);
        const copy = fs.copyFileSync, chmod = fs.chmodSync;
        let paused = false;
        function pause(path) {
          if (paused || !path.includes('/.publish-') || !path.includes('/lower/')) return;
          paused = true;
          fs.writeFileSync(join(signals, role + '.paused'), path);
          const deadline = Date.now() + 15000;
          while (!fs.existsSync(join(signals, role + '.release'))) {
            if (Date.now() > deadline) throw new Error('publisher barrier timed out: ' + role);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
          if (role === 'b' && interrupt) throw new Error('injected publisher interruption');
        }
        fs.copyFileSync = (source, destination, ...rest) => {
          if (role === 'b') pause(destination);
          return copy(source, destination, ...rest);
        };
        fs.chmodSync = (path, ...rest) => {
          const result = chmod(path, ...rest);
          if (role === 'a' && path.endsWith('/README.md')) pause(path);
          return result;
        };
        syncBuiltinESMExports();
        const { prepareStepWorkspace } = await import(moduleUrl);
        const { createOwnership } = await import(ownershipUrl);
        try {
          const record = await prepareStepWorkspace({
            ...options, attemptId: 'attempt-' + role, phaseToken: 'phase-' + role,
            coordinator: { ...options.coordinator, pid: process.pid },
            ownership: createOwnership({ registryRoot }),
          });
          fs.writeFileSync(join(signals, role + '.result'), JSON.stringify({ record }));
        } catch (error) {
          fs.writeFileSync(join(signals, role + '.result'), JSON.stringify({ error: error.message }));
        }
      `;
      const launch = role => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, JSON.stringify({
          options, registryRoot, signals, role, interrupt,
          moduleUrl: new URL('./step-workspaces.mjs', import.meta.url).href,
          ownershipUrl: new URL('./ownership.mjs', import.meta.url).href,
        })], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        const exited = new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('exit', code => code === 0 ? resolve() : reject(new Error(`publisher ${role}: ${code}: ${stderr}`)));
        });
        // Attach immediately so teardown cannot produce an unhandled rejection.
        exited.catch(() => {});
        t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
        return exited;
      };
      const waitFor = async name => {
        const deadline = Date.now() + 15000;
        while (!existsSync(join(signals, name))) {
          assert.ok(Date.now() < deadline, `publisher barrier timed out: ${name}`);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      const a = launch('a');
      await waitFor('a.paused'); // A has copied and chmodded README.
      const b = launch('b');
      await waitFor('b.paused'); // B has created staging, but has not copied a file.
      writeFileSync(join(signals, 'a.release'), '');
      await a;
      const first = JSON.parse(readFileSync(join(signals, 'a.result'), 'utf8'));
      assert.equal(first.error, undefined, 'the first publisher succeeds');
      const assertContents = lower => {
        for (const [input, prefix] of [[staging.source, ''], [staging.dependencies, '']]) {
          const check = (directory, relative) => {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
              const path = join(relative, entry.name);
              if (entry.isDirectory()) check(join(directory, entry.name), path);
              else {
                assert.deepEqual(readFileSync(join(lower, path)), readFileSync(join(input, path)), `${path}: complete bytes`);
                assert.equal(statSync(join(lower, path)).mode & 0o777, statSync(join(input, path)).mode & 0o777, `${path}: complete modes`);
              }
            }
          };
          check(input, prefix);
        }
      };
      assertContents(first.record.lower);
      assert.notEqual(readFileSync(join(signals, 'a.paused'), 'utf8').split('/lower/')[0],
        readFileSync(join(signals, 'b.paused'), 'utf8').split('/lower/')[0], 'publishers exclusively own different staging directories');
      writeFileSync(join(signals, 'b.release'), '');
      await b;
      const second = JSON.parse(readFileSync(join(signals, 'b.result'), 'utf8'));
      if (interrupt) assert.match(second.error, /injected publisher interruption/);
      else {
        assert.equal(second.error, undefined, 'a completed losing publisher reuses the winner');
        assert.equal(second.record.lower, first.record.lower);
      }
      const third = await prepareStepWorkspace({
        ...options, attemptId: 'attempt-c', phaseToken: 'phase-c', ownership: createOwnership({ registryRoot }),
      });
      assert.equal(third.lower, first.record.lower, 'an uninstrumented caller reuses the winner');
      assertContents(third.lower);
      assert.deepEqual(readdirSync(join(waveRoot, 'snapshots')), [snapshotId], 'each publisher cleans only its own staging');
    });
  }
});
