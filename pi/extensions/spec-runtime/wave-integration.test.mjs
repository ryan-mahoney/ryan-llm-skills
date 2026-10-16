// Wave integration contract (step 9).
//
// Composes the real overlay phase-claim machinery, temporary Git repositories,
// step-4 workspace provisioning/import helpers and flock ownership registries.
// Two substituted boundaries are explicitly not kernel proof: mount transport
// (writes land directly in an attempt's editable root) and channel containment
// (candidate-phase commands go through the caller-supplied runCommand seam).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createOwnership } from './ownership.mjs';
import { createOverlayPhases, interpretProbeResult } from './overlay.mjs';
import { importSealedHead, prepareStepWorkspace } from './step-workspaces.mjs';
import { makePackageFixture } from './package-fixture.mjs';
import { runCommand as runtimeRunCommand } from './runtime.mjs';
import {
  assembleCandidate, mergeTreeOutcome, prepareIntegrationRepair,
  acceptIntegrationRepair, promoteWave, recoverPromotion, runCandidateChecks, readWaveRecord,
  updateWaveRecord,
} from './wave-integration.mjs';

const GIT = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const TIMEOUT = 120000;
// Chosen fields of an accepted repair, used for an exact projection assertion.
const projection = ({ trigger, step, parents, head, reviewed }) => ({ trigger, step, parents, head, reviewed });
const fixtureFor = (t, wave, recordPath, canonical, waveRoot, ownership, pkg, members) => ({
  t, waveId: wave, recordPath, canonical, waveRoot, ownership, packagePath: pkg.packagePath, members,
});

function freshRoot(t, label) {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], GIT).trim();
}

function gitMaybe(cwd, args) {
  try {
    return { ok: true, out: git(cwd, args) };
  } catch (error) {
    return { ok: false, out: '', status: error.status };
  }
}

function coordinatorFor(label) {
  return { session: `wave-integration-${label}`, epoch: 1, pid: process.pid, started_at: `fixture-start-${label}` };
}

// Deterministic committer identity/environment for repair and sealed commits.
function editorEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Wave Editor', GIT_AUTHOR_EMAIL: 'wave-editor@example.test',
    GIT_COMMITTER_NAME: 'Wave Editor', GIT_COMMITTER_EMAIL: 'wave-editor@example.test',
    GIT_AUTHOR_DATE: '2026-10-15T00:00:00 +0000', GIT_COMMITTER_DATE: '2026-10-15T00:00:00 +0000',
  };
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// Canonical repo on branch main at base B: .gitignore naming .cache/, README.md
// and the ignored sentinel .cache/user.txt, plus any extra tracked conflict file
// a case declares. Returns the resolved identity the ctx shape needs.
function makeCanonical(t, label, { extra = {} } = {}) {
  const worktree = freshRoot(t, `${label}-canonical`);
  execFileSync('git', ['init', '-q', '-b', 'main', worktree], GIT);
  git(worktree, ['config', 'user.email', 'wave-editor@example.test']);
  git(worktree, ['config', 'user.name', 'Wave Editor']);
  git(worktree, ['config', 'commit.gpgSign', 'false']);
  // The owned empty hooks directory keeps local commit policy out of the path.
  mkdirSync(join(worktree, '.git', 'empty-hooks'), { recursive: true });
  git(worktree, ['config', 'core.hooksPath', join(worktree, '.git', 'empty-hooks')]);
  mkdirSync(join(worktree, '.cache'));
  writeFileSync(join(worktree, '.gitignore'), '.cache/\n');
  writeFileSync(join(worktree, 'README.md'), 'base\n');
  for (const [path, contents] of Object.entries(extra)) {
    const full = join(worktree, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  writeFileSync(join(worktree, '.cache', 'user.txt'), 'ignored sentinel\n');
  git(worktree, ['add', '-A']);
  git(worktree, ['commit', '-q', '-m', 'B']);
  const base = git(worktree, ['rev-parse', 'HEAD']);
  return { worktree, gitCommonDir: realpathSync(join(worktree, '.git')), branch: 'main', base };
}

// Built through the same classifier the step-4 tests use, never reimplementing
// the probe decision table.
function supportedCapability() {
  const observation = fields => JSON.stringify({
    fstype: 'overlay',
    options: 'rw,lowerdir=/lower,upperdir=/upper,workdir=/work',
    ...fields,
  });
  return interpretProbeResult({
    collect: { exitCode: 0, signal: null, stdout: observation({ copyUp: true, deletion: true }), stderr: '' },
    verify: { exitCode: 0, signal: null, stdout: observation({ retainedWrite: true, retainedDeletion: true }), stderr: '' },
  });
}

// A real step-4 prepared attempt (substituted mount transport: writes land in
// the attempt's editable root, are committed in the private gitDir and imported
// into refs/waves/retained/<wave>/step-00N). Shell commands address the private
// gitDir and editable root explicitly. The phase drains confirmed before return
// and every commit head is captured for ancestor assertions.
async function sealedMember(t, { canonical, waveRoot, ownership, wave, step, backend = 'overlayfs', commits }) {
  const attemptId = `${wave}-step-${String(step).padStart(3, '0')}`;
  const prepared = await prepareStepWorkspace({
    packageId: wave, coordinator: coordinatorFor(wave), phaseToken: `phase-${attemptId}`, attemptId,
    target: canonical, waveRoot, baseCommit: canonical.base,
    setup: { command: 'node --version', lockfiles: [], environment: [] },
    env: { HOME: process.env.HOME, PATH: process.env.PATH },
    preparationReceipt: { ok: true, drain: 'confirmed', baseCommit: canonical.base, trackedClean: true },
    mode: backend, capability: supportedCapability(), ownership,
  });
  assert.equal(prepared.backend, backend);
  const commitEnv = editorEnv();
  // Overlay edits its merged view, worktree its published worktree. Overlay has
  // a private gitDir; a worktree attempt's git dir is its own.
  const root = prepared.backend === 'worktree' ? prepared.worktree : prepared.merged;
  if (prepared.backend !== 'worktree') execFileSync('cp', ['-a', `${prepared.lower}/.`, root], GIT);
  const gitDir = prepared.gitDir
    ?? realpathSync(execFileSync('git', ['-C', prepared.worktree, 'rev-parse', '--absolute-git-dir'], GIT).trim());
  const shellEnv = { ...commitEnv, GIT_DIR: gitDir, GIT_WORK_TREE: root };
  const heads = [];
  for (const command of commits) {
    if (command.shell) {
      execFileSync('/bin/bash', ['-o', 'pipefail', '-c', command.shell], { cwd: root, ...GIT, env: shellEnv });
    } else if (command.write) {
      const path = join(root, command.write.path);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, command.write.contents);
    } else if (command.remove) {
      rmSync(join(root, command.remove), { recursive: true, force: true });
    }
    if (command.commit) {
      execFileSync('git', ['--git-dir', gitDir, '--work-tree', root, 'add', '-A'], GIT);
      execFileSync('git', ['--git-dir', gitDir, '--work-tree', root, 'commit', '-q', '-m', command.commit], { ...GIT, env: commitEnv });
      heads.push({ message: command.commit, head: execFileSync('git', ['--git-dir', gitDir, 'rev-parse', 'HEAD'], GIT).trim() });
    }
  }
  const sealedHead = execFileSync('git', ['--git-dir', gitDir, 'rev-parse', 'HEAD'], GIT).trim();
  const retentionRef = `refs/waves/retained/${wave}/step-${String(step).padStart(3, '0')}`;
  await importSealedHead({ repo: canonical.worktree, source: gitDir, sha: sealedHead, retentionRef });
  const phases = createOverlayPhases({ ownership });
  const drained = await phases.endPhase({ token: prepared.claim.token, epoch: prepared.claim.epoch, drain: 'confirmed' });
  assert.equal(drained.status, 'released', `member ${attemptId} phase drains confirmed`);
  return { step, sealedHead, retentionRef, heads, prepared, commitEnv };
}

function writeWaveRecord(t, fields = {}) {
  const dir = fields.dir ?? freshRoot(t, 'wave-integration-record');
  const recordPath = join(dir, `${fields.waveId ?? 'w1'}.json`);
  const record = {
    wave_id: fields.waveId ?? 'w1', generation: 1, revision: 1,
    target: { candidate_commit: null, integration: null, promotion: null, ...fields.target },
    ...fields.record,
  };
  writeJson(recordPath, record);
  return { recordPath, dir, record };
}

// A caller-supplied candidate-phase run record: the real package fixture's run
// record driven through the real runtime.runCommand seam. The one substituted
// behavior is the merged view (overlay lower -> merged once before the first
// command; a worktree candidate keeps its own root). Requested ownership captures
// are recorded and the record persists running then completed/blocked.
function phaseRecordFor(fixture, { captured = [] } = {}) {
  const state = { count: 0, records: [], purpose: null, lower: null };
  if (!fixture.runRecord && fixture.runsDir && existsSync(fixture.runsDir)) {
    const [first] = readdirSync(fixture.runsDir).filter(name => name.endsWith('.json')).sort();
    if (first) fixture.runRecord = JSON.parse(readFileSync(join(fixture.runsDir, first), 'utf8'));
  }
  const phaseRecord = async (workspace, { phaseToken, purpose }) => {
    state.count += 1;
    state.purpose = purpose;
    if (workspace.backend !== 'worktree' && state.count === 1) {
      state.lower = workspace.lower;
      execFileSync('cp', ['-a', `${workspace.lower}/.`, workspace.merged], GIT);
    }
    fixture.captured = captured;
    const claims = fixture.ownership ? (await fixture.ownership.inspectClaims()).claims : [];
    captured.push({ phaseToken, purpose, claims });
    const record = {
      ...fixture.runRecord, id: `${fixture.waveId}-candidate-${phaseToken}`,
      packagePath: fixture.packagePath, package: fixture.packagePath,
      checkout: workspace.backend === 'worktree' ? workspace.worktree : workspace.merged,
      phaseToken, purpose, state: 'running',
    };
    state.records.push(record);
    fixture.runRecord = record;
    if (fixture.runsDir) writeJson(join(fixture.runsDir, `${record.id}.json`), record);
    return record;
  };
  // The seam closes a phase with `{ drained }`: a confirmed drain completes the
  // record, anything else blocks it.
  const endPhaseRecord = async (record, { drained } = {}) => {
    const completed = drained === true || drained === 'confirmed';
    const ended = { ...record, state: completed ? 'completed' : 'blocked' };
    if (fixture.runsDir) writeJson(join(fixture.runsDir, `${record.id}.json`), ended);
    fixture.runRecord = ended;
    return ended;
  };
  const runCommand = (record, command, timeoutSeconds, signal) => runtimeRunCommand(record, command, timeoutSeconds, signal);
  return { phaseRecord, endPhaseRecord, runCommand, state };
}

// Acquire the package claim through a temp-root ownership registry, matching the
// ctx.packageClaim contract. The revision always comes from the written record.
async function ctxFor(fixture, options = {}) {
  const ownership = options.ownership ?? fixture.ownership
    ?? createOwnership({ registryRoot: freshRoot(fixture.t, `${fixture.waveId}-ownership`) });
  const acquired = await ownership.acquirePackage({
    packageId: fixture.waveId, coordinator: coordinatorFor(fixture.waveId), ...(options.packageClaim ?? {}),
  });
  const claim = acquired.claim ?? acquired;
  const written = fixture.recordPath ? JSON.parse(readFileSync(fixture.recordPath, 'utf8')) : {};
  if (fixture.packagePath) {
    fixture.runsDir = join(fixture.packagePath, 'runtime', 'runs');
    mkdirSync(fixture.runsDir, { recursive: true });
  }
  fixture.ownership = ownership;
  const phaseKit = options.phaseKit ?? phaseRecordFor(fixture, options.phaseOptions);
  return {
    recordPath: fixture.recordPath, revision: written.revision, waveId: fixture.waveId,
    packageId: fixture.packageId ?? fixture.waveId,
    packageClaim: { token: claim.token, epoch: claim.epoch },
    coordinator: coordinatorFor(fixture.waveId), ownership,
    target: { worktree: fixture.canonical.worktree, gitCommonDir: fixture.canonical.gitCommonDir, branch: 'main' },
    baseCommit: fixture.canonical.base,
    members: fixture.members.map(member => ({ step: member.step, sealedHead: member.sealedHead, retentionRef: member.retentionRef })),
    workspace: {
      waveRoot: fixture.waveRoot, mode: options.mode ?? 'overlayfs',
      capability: options.capability ?? supportedCapability(),
      setup: { command: 'node --version', lockfiles: [], environment: [] },
      env: { HOME: process.env.HOME, PATH: process.env.PATH },
      preparationReceipt: { ok: true, drain: 'confirmed', baseCommit: fixture.canonical.base, trackedClean: true },
      ...(options.staging ? { staging: options.staging } : {}),
    },
    checks: options.checks,
    capacity: options.capacity ?? { memoryBytes: 512 * 1024 * 1024, tasks: 2 },
    phaseRecord: options.phaseRecord ?? phaseKit.phaseRecord,
    runCommand: options.runCommand ?? phaseKit.runCommand,
    endPhaseRecord: options.endPhaseRecord ?? phaseKit.endPhaseRecord,
    onBoundary: options.onBoundary,
  };
}

// A fresh canonical worktree whose only sealed member adds feature.txt, driven
// through the real candidate pipeline to a verified integration: assemble,
// then one real worktree candidate check `test -f feature.txt`. Returns the
// canonical/target handle plus the verified ctx and its candidate commit so a
// promotion case can mutate a real input and call promoteWave.
async function verifiedFixture(t, label) {
  const canonical = makeCanonical(t, `${label}-verified`);
  const waveRoot = freshRoot(t, `${label}-verified-root`);
  const registryRoot = freshRoot(t, `${label}-verified-ownership`);
  const ownership = createOwnership({ registryRoot });
  const wave = `w-${label}`;
  const member = await sealedMember(t, {
    canonical, waveRoot, ownership, wave, step: 1, backend: 'worktree',
    commits: [{ write: { path: 'feature.txt', contents: 'feature\n' }, commit: 'feature' }],
  });
  const { recordPath } = writeWaveRecord(t, { waveId: wave });
  const pkg = await makePackageFixture({ prefix: `${label}-verified-pkg-`, repos: [wave], targets: [wave] });
  t.after(() => rmSync(pkg.dir, { recursive: true, force: true }));
  const fixture = fixtureFor(t, wave, recordPath, canonical, waveRoot, ownership, pkg, [member]);
  const ctx = await ctxFor(fixture, { mode: 'worktree' });
  const assembled = await assembleCandidate(ctx);
  assert.equal(assembled.status, 'assembled');
  const candidate = assembled.candidate.commit;
  ctx.revision = assembled.revision;
  ctx.checks = [{ id: 'EV-11', command: 'test -f feature.txt', artifact: 'evidence/feature.txt', ownerStep: 1 }];
  const checks = await runCandidateChecks(ctx);
  ctx.revision = checks.revision;
  assert.equal(checks.status, 'passed');
  assert.equal(readWaveRecord(recordPath).target.integration.status, 'verified');
  assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), canonical.base, 'the fixture reaches the boundary with main = B');
  return { canonical, ctx, ownership, registryRoot, candidate, fixture, recordPath };
}

// ---------------------------------------------------------------------------
// Case 1: clean assembly keeps worker and fix ancestry.
// ---------------------------------------------------------------------------

test('wave integration: clean assembly keeps worker and fix ancestry', { timeout: TIMEOUT }, async t => {
  const canonical = makeCanonical(t, 'wave-clean');
  const waveRoot = freshRoot(t, 'wave-clean-root');
  const ownership = createOwnership({ registryRoot: freshRoot(t, 'wave-clean-ownership') });
  const wave = 'w1';
  // Step 3 commits I3 then fix F3; step 1 commits H1.
  const member3 = await sealedMember(t, {
    canonical, waveRoot, ownership, wave, step: 3, commits: [
      { write: { path: 'src/three.js', contents: 'three\n' }, commit: 'I3' },
      { write: { path: 'src/three.js', contents: 'three fixed\n' }, commit: 'F3' },
    ],
  });
  const member1 = await sealedMember(t, {
    canonical, waveRoot, ownership, wave, step: 1,
    commits: [{ write: { path: 'src/one.js', contents: 'one\n' }, commit: 'H1' }],
  });
  const { recordPath } = writeWaveRecord(t, { waveId: wave });
  const pkg = await makePackageFixture({ prefix: 'wave-clean-pkg-', repos: ['wave'], targets: ['wave'] });
  t.after(() => rmSync(pkg.dir, { recursive: true, force: true }));
  const fixture = fixtureFor(t, wave, recordPath, canonical, waveRoot, ownership, pkg, [member3, member1]);
  const ctx = await ctxFor(fixture);

  const first = await assembleCandidate(ctx);
  assert.equal(first.status, 'assembled');
  const candidate = first.candidate.commit;
  ctx.revision = first.revision;

  // _M1 merges B with step 1 (H1); C merges _M1 with step 3 (F3), so both the
  // worker head and the fix head stay ancestors of the candidate.
  const parents = git(canonical.worktree, ['rev-list', '--parents', '-n1', candidate]).split(' ');
  assert.equal(parents.length, 3, 'the candidate has two parents');
  const [candidateSha, m1, f3] = parents;
  assert.equal(candidateSha, candidate);
  assert.equal(f3, member3.sealedHead, 'the step 3 sealed/fix head is the second parent');
  const m1Parents = git(canonical.worktree, ['rev-list', '--parents', '-n1', m1]).split(' ');
  assert.equal(m1Parents.length, 3, 'the first merge has two parents');
  assert.equal(m1Parents[1], canonical.base, 'the first merge starts from B');
  assert.equal(m1Parents[2], member1.sealedHead, 'the step 1 head is a parent');
  // I3 must stay an ancestor of F3 and so of C; the parent walk alone would not
  // catch a dropped fix.
  const i3 = member3.heads.find(entry => entry.message === 'I3').head;
  assert.notEqual(i3, member3.sealedHead, 'I3 differs from the sealed fix head F3');
  assert.equal(member3.heads.find(entry => entry.message === 'F3').head, member3.sealedHead);
  for (const ancestor of [member3.sealedHead, i3, member1.sealedHead, canonical.base]) {
    assert.doesNotThrow(() => git(canonical.worktree, ['merge-base', '--is-ancestor', ancestor, candidate]), `${ancestor} is an ancestor of the candidate`);
  }
  assert.doesNotThrow(
    () => git(canonical.worktree, ['merge-base', '--is-ancestor', i3, member3.sealedHead]),
    'I3 is an ancestor of the sealed fix head F3',
  );

  const expectedTree = { '.gitignore': '.cache/', 'README.md': 'base', 'src/one.js': 'one', 'src/three.js': 'three fixed' };
  const listed = git(canonical.worktree, ['ls-tree', '-r', '--name-only', candidate]).split('\n').filter(Boolean);
  assert.deepEqual(listed, Object.keys(expectedTree));
  for (const [path, contents] of Object.entries(expectedTree)) {
    assert.equal(git(canonical.worktree, ['cat-file', '-p', `${candidate}:${path}`]), contents);
  }
  // Assembly is object-only: canonical branch/index/worktree remain at B.
  assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), canonical.base);
  assert.equal(git(canonical.worktree, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(git(canonical.worktree, ['rev-parse', `refs/waves/retained/${wave}/candidate`]), candidate);

  const beforeRefs = git(canonical.worktree, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const second = await assembleCandidate(ctx);
  assert.equal(second.status, 'assembled');
  assert.equal(second.replayed, true);
  assert.equal(second.candidate.commit, candidate);
  assert.equal(second.revision, first.revision, 'replay leaves the record revision unchanged');
  assert.equal(git(canonical.worktree, ['for-each-ref', '--format=%(refname) %(objectname)']), beforeRefs);
});

// ---------------------------------------------------------------------------
// Case 2: textual, file/directory and rename/delete conflicts stop for repair.
// ---------------------------------------------------------------------------

test('wave integration: textual, file/directory and rename/delete conflicts stop for repair', { timeout: TIMEOUT }, async t => {
  const cases = [
    // A conflict case declares the extra tracked file its members disagree on.
    { label: 'textual', base: { 'src/shared.js': 'base-shared\n' }, conflictPath: 'src/shared.js' },
    { label: 'file-directory', base: { 'src/node': 'base node\n' }, conflictPath: null },
    { label: 'rename-delete', base: { 'docs/a.txt': 'a\n' }, conflictPath: 'docs/b.txt' },
  ];
  for (const scenario of cases) {
    const wave = `w-${scenario.label}`;
    const canonical = makeCanonical(t, `wave-conflict-${scenario.label}`, { extra: scenario.base });
    const waveRoot = freshRoot(t, `wave-conflict-${scenario.label}-root`);
    const ownership = createOwnership({ registryRoot: freshRoot(t, `wave-conflict-${scenario.label}-ownership`) });
    const step1Commits = [{ write: { path: 'src/one.js', contents: 'one\n' } }];
    const step2Commits = [{ write: { path: 'src/two.js', contents: 'two\n' } }];
    if (scenario.label === 'textual') {
      step1Commits.push({ write: { path: 'src/shared.js', contents: 'one version\n' } });
      step2Commits.push({ write: { path: 'src/shared.js', contents: 'two version\n' } });
    } else if (scenario.label === 'file-directory') {
      step1Commits.push({ remove: 'src/node' }, { write: { path: 'src/node/child.js', contents: 'child\n' } });
      step2Commits.push({ write: { path: 'src/node', contents: 'file\n' } });
    } else {
      step1Commits.push({ shell: 'git mv docs/a.txt docs/b.txt' });
      step2Commits.push({ remove: 'docs/a.txt' });
    }
    step1Commits.push({ commit: 'step 1' });
    step2Commits.push({ commit: 'step 2' });
    const member1 = await sealedMember(t, { canonical, waveRoot, ownership, wave, step: 1, commits: step1Commits });
    const member2 = await sealedMember(t, { canonical, waveRoot, ownership, wave, step: 2, commits: step2Commits });
    const { recordPath } = writeWaveRecord(t, { waveId: wave });
    const pkg = await makePackageFixture({ prefix: `wave-conflict-${scenario.label}-pkg-`, repos: [wave], targets: [wave] });
    t.after(() => rmSync(pkg.dir, { recursive: true, force: true }));
    const fixture = fixtureFor(t, wave, recordPath, canonical, waveRoot, ownership, pkg, [member1, member2]);
    const ctx = await ctxFor(fixture);

    const result = await assembleCandidate(ctx);
    assert.equal(result.status, 'conflict', `${scenario.label}: assembly stops at the conflict`);
    assert.equal(result.conflict.step, 2);
    const m1 = result.conflict.parents[0];
    assert.deepEqual(result.conflict.parents, [m1, member2.sealedHead], 'conflict parents are [first merge, second head]');
    const expectedPath = scenario.label === 'file-directory' ? `src/node~${member2.sealedHead}` : scenario.conflictPath;
    assert.deepEqual(result.conflict.paths, [expectedPath]);
    assert.match(readFileSync(result.conflict.output_path, 'utf8'), /CONFLICT \(/);
    // Nothing on main moved; the candidate ref still points at the first merge.
    assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), canonical.base);
    assert.equal(git(canonical.worktree, ['rev-parse', `refs/waves/retained/${wave}/candidate`]), m1);
    ctx.revision = result.revision;

    // A repair packet exposes exactly one pair, with private HEAD pinned to the
    // first merge and the conflicting head present as a commit object.
    const packet = await prepareIntegrationRepair(ctx);
    ctx.revision = packet.revision;
    assert.equal(packet.status, 'repair-ready');
    assert.equal(packet.repair.kind, 'integration-repair');
    assert.equal(packet.repair.trigger, 'conflict');
    assert.deepEqual(packet.repair.parents, [m1, member2.sealedHead]);
    const gitDir = packet.repair.workspace.gitDir;
    assert.equal(
      execFileSync('git', ['--git-dir', gitDir, 'rev-parse', 'HEAD'], GIT).trim(),
      m1,
      'the repair workspace HEAD is pinned to the first merge',
    );
    assert.doesNotThrow(
      () => execFileSync('git', ['--git-dir', gitDir, 'cat-file', '-e', `${member2.sealedHead}^{commit}`], GIT),
      'the conflicting head is present in the private gitDir',
    );
  }
  // mergeTreeOutcome classifies an invalid merge input as a tool failure rather
  // than a conflict, so callers can distinguish environment faults.
  const canonical = makeCanonical(t, 'wave-tool-failure');
  assert.throws(
    () => mergeTreeOutcome({
      repo: canonical.worktree, ours: '0000000000000000000000000000000000000001', theirs: canonical.base,
    }),
    error => error?.code === 'integration-refusal' && error?.reason === 'merge-tool-failure',
  );
});

// ---------------------------------------------------------------------------
// Case 3: an overlay candidate repair is reviewed, imported and promoted.
// ---------------------------------------------------------------------------

test('wave integration: an overlay candidate repair is reviewed, imported and promoted', { timeout: TIMEOUT }, async t => {
  const canonical = makeCanonical(t, 'wave-repair-overlay', { extra: { 'src/shared.js': 'base-shared\n' } });
  const waveRoot = freshRoot(t, 'wave-repair-overlay-root');
  const ownership = createOwnership({ registryRoot: freshRoot(t, 'wave-repair-overlay-ownership') });
  const wave = 'w-repair-overlay';
  const member1 = await sealedMember(t, {
    canonical, waveRoot, ownership, wave, step: 1,
    commits: [{ write: { path: 'src/shared.js', contents: 'one version\n' }, commit: 'step 1' }],
  });
  const member2 = await sealedMember(t, {
    canonical, waveRoot, ownership, wave, step: 2,
    commits: [{ write: { path: 'src/shared.js', contents: 'two version\n' }, commit: 'step 2' }],
  });
  const { recordPath } = writeWaveRecord(t, { waveId: wave });
  const pkg = await makePackageFixture({ prefix: 'wave-repair-overlay-pkg-', repos: [wave], targets: [wave] });
  t.after(() => rmSync(pkg.dir, { recursive: true, force: true }));
  const fixture = fixtureFor(t, wave, recordPath, canonical, waveRoot, ownership, pkg, [member1, member2]);
  const ctx = await ctxFor(fixture);

  const stopped = await assembleCandidate(ctx);
  assert.equal(stopped.status, 'conflict');
  const m1 = stopped.conflict.parents[0];
  const h2 = member2.sealedHead;
  ctx.revision = stopped.revision;
  const packet = await prepareIntegrationRepair(ctx);
  ctx.revision = packet.revision;
  const gitDir = packet.repair.workspace.gitDir;
  const privateGit = args => execFileSync('git', ['--git-dir', gitDir, ...args], GIT).trim();
  // The chosen resolution commit R: resolved merged-view bytes, tree written,
  // then commit-tree with parents [M1, H2] and private HEAD advanced to R.
  const merged = packet.repair.workspace.merged;
  writeFileSync(join(merged, 'src/shared.js'), 'resolved\n');
  execFileSync('git', ['--git-dir', gitDir, '--work-tree', merged, 'add', 'src/shared.js'], GIT);
  const tree = privateGit(['write-tree']);
  const repairEnv = editorEnv();
  const r = execFileSync('git', ['--git-dir', gitDir, 'commit-tree', tree, '-p', m1, '-p', h2, '-m', 'repair'], { ...GIT, env: repairEnv }).trim();
  execFileSync('git', ['--git-dir', gitDir, 'update-ref', 'HEAD', r, m1], GIT);
  const review = { verdict: 'pass', head: r, artifact: 'evidence/repair.txt' };

  // A real commit with the reversed parent pair [H2, M1] is not this repair, and
  // the review head must match the accepted head.
  const rbad = execFileSync('git', ['--git-dir', gitDir, 'commit-tree', tree, '-p', h2, '-p', m1, '-m', 'bad'], { ...GIT, env: repairEnv }).trim();
  await assert.rejects(
    () => acceptIntegrationRepair(ctx, { head: rbad, review: { ...review, head: rbad } }),
    error => error?.code === 'integration-refusal' && error?.reason === 'repair-invalid',
  );
  await assert.rejects(
    () => acceptIntegrationRepair(ctx, { head: r, review: { ...review, head: '0'.repeat(40) } }),
    error => error?.reason === 'repair-invalid',
  );
  // A refusal has no effect: the first repair ref is absent.
  assert.equal(gitMaybe(canonical.worktree, ['rev-parse', '--verify', '--quiet', `refs/waves/retained/${wave}/repair-1`]).ok, false);

  const accepted = await acceptIntegrationRepair(ctx, { head: r, review });
  ctx.revision = accepted.revision;
  assert.deepEqual(projection(accepted.repair), { trigger: 'conflict', step: 2, parents: [m1, h2], head: r, reviewed: true });
  assert.equal(git(canonical.worktree, ['rev-parse', `refs/waves/retained/${wave}/repair-1`]), r);
  assert.equal(privateGit(['rev-parse', `${r}^{tree}`]), tree);
  const reassembled = await assembleCandidate(ctx);
  ctx.revision = reassembled.revision;
  assert.equal(reassembled.status, 'assembled');
  assert.equal(reassembled.candidate.commit, r);
  assert.equal(git(canonical.worktree, ['cat-file', '-p', `${r}:src/shared.js`]), 'resolved');

  ctx.checks = [{ id: 'EV-01', command: 'test $(cat src/shared.js) = resolved', artifact: 'evidence/x.txt', ownerStep: 2 }];
  const checks = await runCandidateChecks(ctx);
  ctx.revision = checks.revision;
  assert.equal(checks.status, 'passed');
  const promoted = await promoteWave(ctx);
  assert.equal(promoted.status, 'promoted');
  assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), r);
  assert.equal(readFileSync(join(canonical.worktree, 'src/shared.js'), 'utf8'), 'resolved\n');
  const record = readWaveRecord(recordPath);
  assert.equal(record.target.integration.backend, 'overlayfs');
  assert.ok(existsSync(record.target.integration.workspace.upper), 'the candidate upper directory survives');
});

// ---------------------------------------------------------------------------
// Case 4: candidate gates run through runCommand at the observed candidate head.
// ---------------------------------------------------------------------------

test('wave integration: candidate gates run through runCommand at the observed candidate head', { timeout: TIMEOUT }, async t => {
  const canonical = makeCanonical(t, 'wave-checks-worktree');
  const waveRoot = freshRoot(t, 'wave-checks-worktree-root');
  const ownership = createOwnership({ registryRoot: freshRoot(t, 'wave-checks-worktree-ownership') });
  const wave = 'w-checks';
  const member1 = await sealedMember(t, {
    canonical, waveRoot, ownership, wave, step: 1, backend: 'worktree',
    commits: [{ write: { path: 'src/one.js', contents: 'one\n' }, commit: 'one' }],
  });
  const member2 = await sealedMember(t, {
    canonical, waveRoot, ownership, wave, step: 2, backend: 'worktree',
    commits: [{ write: { path: 'src/two.js', contents: 'two\n' }, commit: 'two' }],
  });
  const { recordPath } = writeWaveRecord(t, { waveId: wave });
  const pkg = await makePackageFixture({ prefix: 'wave-checks-pkg-', repos: [wave], targets: [wave] });
  t.after(() => rmSync(pkg.dir, { recursive: true, force: true }));
  const fixture = fixtureFor(t, wave, recordPath, canonical, waveRoot, ownership, pkg, [member1, member2]);
  const ctx = await ctxFor(fixture, { mode: 'worktree' });

  // An automatic backend cannot verify an unrecorded candidate: the refusal
  // lands before any checkout claim exists beyond the package claim.
  const autoCtx = await ctxFor(fixture, { mode: 'auto', ownership });
  await assert.rejects(
    () => runCandidateChecks(autoCtx),
    error => error?.reason === 'backend-unspecified',
  );
  const afterAuto = (await ownership.inspectClaims()).claims;
  assert.deepEqual([...new Set(afterAuto.map(claim => claim.kind))], ['package']);

  const assembled = await assembleCandidate(ctx);
  assert.equal(assembled.status, 'assembled');
  const candidate = assembled.candidate.commit;
  ctx.revision = assembled.revision;
  ctx.checks = [{
    id: 'EV-90',
    command: 'test $(cat src/one.js) = one && test $(cat src/two.js) = two',
    artifact: 'evidence/x.txt',
    ownerStep: 2,
  }];
  const checks = await runCandidateChecks(ctx);
  ctx.revision = checks.revision;
  assert.equal(checks.status, 'passed');
  assert.equal(checks.repair, null);

  const captured = checks.captured ?? fixture.captured ?? [];
  const claims = captured[0]?.claims ?? [];
  assert.ok(claims.some(claim => claim.kind === 'checkout' && String(claim.attempt).includes(`${wave}-candidate-p1`)), 'the phase holds a checkout claim');
  assert.ok(claims.some(claim => claim.kind === 'capacity' && claim.attempt === `${wave}:candidate:${wave}-candidate-p1`), 'the phase holds a candidate capacity claim');

  // The verification and process receipts are named after the phase record the
  // production caller actually ran, not the gate id.
  const runsDir = join(pkg.packagePath, 'runtime', 'runs');
  const checkId = fixture.runRecord.id;
  const verification = JSON.parse(readFileSync(join(runsDir, `${checkId}-verification.json`), 'utf8'));
  assert.equal(verification.receipts.length, 1);
  assert.equal(verification.receipts[0].outcome, 'pass');
  assert.equal(verification.receipts[0].before.commit, candidate);
  assert.equal(verification.receipts[0].after.commit, candidate);
  const record = readWaveRecord(recordPath);
  assert.deepEqual(record.target.integration.checks, [{
    gate: 'EV-90',
    command: ctx.checks[0].command,
    receipt_id: verification.receipts[0].id,
    exit_code: verification.receipts[0].exit_code,
    outcome: 'pass',
    observed_commit: candidate,
    output_path: verification.receipts[0].artifact,
  }]);

  const processNames = readdirSync(join(runsDir, `${checkId}-processes`));
  assert.ok(processNames.length > 0, 'the check phase recorded child processes');
  for (const name of processNames) {
    assert.equal(JSON.parse(readFileSync(join(runsDir, `${checkId}-processes`, name), 'utf8')).role, 'command');
  }
  const afterReturn = (await ownership.inspectClaims({ packageId: wave })).claims;
  assert.deepEqual([...new Set(afterReturn.map(claim => claim.kind))], ['package']);
  const replayed = await runCandidateChecks(ctx);
  assert.equal(replayed.status, 'passed');
  assert.equal(replayed.replayed, true);
  const afterReplay = JSON.parse(readFileSync(join(runsDir, `${checkId}-verification.json`), 'utf8'));
  assert.equal(afterReplay.receipts.length, 1);
});

// ---------------------------------------------------------------------------
// Case 5: a failing composition gate blocks promotion and allows one repair.
// ---------------------------------------------------------------------------

test('wave integration: a failing composition gate blocks promotion and allows one automatic repair', { timeout: TIMEOUT }, async t => {
  const canonical = makeCanonical(t, 'wave-composition', { extra: { 'src/lib.js': 'export function original() {\n  return 1;\n}\n' } });
  const waveRoot = freshRoot(t, 'wave-composition-root');
  const ownership = createOwnership({ registryRoot: freshRoot(t, 'wave-composition-ownership') });
  const wave = 'w-composition';
  const member1 = await sealedMember(t, {
    canonical, waveRoot, ownership, wave, step: 1, backend: 'worktree',
    commits: [{ write: { path: 'src/lib.js', contents: 'export function renamed() {\n  return 1;\n}\n' }, commit: 'rename' }],
  });
  const member2 = await sealedMember(t, {
    canonical, waveRoot, ownership, wave, step: 2, backend: 'worktree',
    commits: [{ write: { path: 'src/use.js', contents: "import { original } from './lib.js';\nconsole.log(original());\n" }, commit: 'use' }],
  });
  const { recordPath } = writeWaveRecord(t, { waveId: wave });
  const pkg = await makePackageFixture({ prefix: 'wave-composition-pkg-', repos: [wave], targets: [wave] });
  t.after(() => rmSync(pkg.dir, { recursive: true, force: true }));
  const fixture = fixtureFor(t, wave, recordPath, canonical, waveRoot, ownership, pkg, [member1, member2]);
  const ctx = await ctxFor(fixture, { mode: 'worktree' });

  const assembled = await assembleCandidate(ctx);
  assert.equal(assembled.status, 'assembled');
  const candidate = assembled.candidate.commit;
  ctx.revision = assembled.revision;
  const gate = { id: 'EV-91', command: 'node src/use.js', artifact: 'evidence/y.txt', ownerStep: 2 };
  ctx.checks = [gate];
  const failed = await runCandidateChecks(ctx);
  ctx.revision = failed.revision;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.repair.kind, 'integration-repair');
  assert.equal(failed.repair.trigger, 'composition');
  assert.deepEqual(failed.repair.parents, [candidate]);
  assert.deepEqual(failed.repair.failed_gates, ['EV-91']);
  await assert.rejects(
    () => promoteWave(ctx),
    error => error?.reason === 'candidate-unverified',
  );
  assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), canonical.base);
  assert.equal(git(canonical.worktree, ['rev-parse', `refs/waves/retained/${wave}/candidate`]), candidate);

  // A composition repair R1 with a single parent C still failing the gate is
  // accepted with a pass review; the second gate run stays blocked. A worktree
  // repair uses -C on its own published worktree (gitDir/merged are null).
  const packet = await prepareIntegrationRepair(ctx);
  ctx.revision = packet.revision;
  const repairRoot = packet.repair.workspace.worktree;
  writeFileSync(join(repairRoot, 'src/use.js'), "import { original } from './lib.js';\nconsole.log(original());\n// still coupled\n");
  git(repairRoot, ['add', 'src/use.js']);
  const tree = git(repairRoot, ['write-tree']);
  const repairEnv = editorEnv();
  const r1 = execFileSync('git', ['-C', repairRoot, 'commit-tree', tree, '-p', candidate, '-m', 'repair'], { ...GIT, env: repairEnv }).trim();
  git(repairRoot, ['update-ref', 'HEAD', r1, candidate]);
  const accepted = await acceptIntegrationRepair(ctx, {
    head: r1,
    review: { verdict: 'pass', head: r1, artifact: 'evidence/repair.txt' },
  });
  ctx.revision = accepted.revision;
  const second = await assembleCandidate(ctx);
  ctx.revision = second.revision;
  assert.equal(second.candidate.commit, r1);
  const blocked = await runCandidateChecks(ctx);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blocked_reason, 'repair-unresolved');
  assert.equal(readWaveRecord(recordPath).target.integration.status, 'blocked');
});

// ---------------------------------------------------------------------------
// Case 6: promotion refuses dirty, moved, foreign-held or changed inputs.
// ---------------------------------------------------------------------------

// sha256 over every regular file under root except .git, in sorted relative
// path order, folding the path itself in so renames change the digest. Ignored
// and untracked bytes are included; only .git is excluded.
function snapshotTreeDigest(root) {
  const hash = createHash('sha256');
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === root && name === '.git') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { hash.update(`dir\0${relative(root, full)}\0`); walk(full); continue; }
      hash.update(`file\0${relative(root, full)}\0`);
      hash.update(readFileSync(full));
    }
  };
  walk(root);
  return hash.digest('hex');
}

// diff-index --cached --quiet HEAD exit status (0 equal, 1 differs), the exact
// before/after index signal the case asserts on.
function cachedIndexStatus(root) {
  const result = spawnSync('git', ['-C', root, 'diff-index', '--cached', '--quiet', 'HEAD'], { encoding: 'utf8' });
  return result.status;
}

test('wave integration: promotion refuses dirty, moved, foreign-held or changed inputs without touching files', { timeout: TIMEOUT }, async t => {
  const refusals = [
    { label: 'tracked-dirty', reason: 'checkout-dirty', mutate: ({ canonical }) => writeFileSync(join(canonical.worktree, 'README.md'), 'edited\n') },
    { label: 'untracked', reason: 'checkout-dirty', mutate: ({ canonical }) => writeFileSync(join(canonical.worktree, 'notes.txt'), 'notes\n') },
    { label: 'ref-moved', reason: 'ref-changed', mutate: ({ canonical }) => git(canonical.worktree, ['commit', '--allow-empty', '-q', '-m', 'external']) },
    { label: 'foreign-claim', reason: 'checkout-held', mutate: async ({ ownership, cleanup }) => {
      const claim = await ownership.reserveCheckout({
        packageId: 'wave-foreign-holder', attempt: 'wave-foreign-holder:promotion',
        checkout: { gitCommonDir: cleanup.gitCommonDir, worktreeGitDir: cleanup.worktreeGitDir },
        coordinator: { session: 'foreign-session', epoch: 1, pid: process.pid, started_at: 'foreign-start' },
      });
      cleanup.foreign = { ownership, token: claim.claim?.token ?? claim.token, epoch: claim.claim?.epoch ?? claim.epoch };
    } },
    { label: 'sealed-head-moved', reason: 'sealed-head-changed', mutate: ({ canonical, fixture, candidate }) => {
      const { base } = fixture.canonical;
      return execFileSync('git', ['-C', canonical.worktree, 'commit-tree', `${base}^{tree}`, '-p', base, '-m', 'other'], { ...GIT, env: editorEnv() }).trim();
    } },
  ];
  for (const scenario of refusals) {
    const verified = await verifiedFixture(t, `promote-${scenario.label}`);
    const { canonical, ctx, ownership, candidate } = verified;
    const cleanup = {
      gitCommonDir: canonical.gitCommonDir,
      worktreeGitDir: realpathSync(join(canonical.worktree, '.git')),
    };
    const moved = await scenario.mutate({ canonical, ownership, fixture: verified.fixture, candidate, cleanup });
    if (scenario.label === 'sealed-head-moved') {
      git(canonical.worktree, ['update-ref', ctx.members[0].retentionRef, moved]);
    }
    // Capture the digest after the mutation and immediately before promoteWave.
    const before = snapshotTreeDigest(canonical.worktree);
    const beforeIndex = cachedIndexStatus(canonical.worktree);
    await assert.rejects(() => promoteWave(ctx), error => error?.reason === scenario.reason, `${scenario.label}: refuses ${scenario.reason}`);
    assert.equal(snapshotTreeDigest(canonical.worktree), before, `${scenario.label}: canonical bytes are unchanged`);
    assert.equal(cachedIndexStatus(canonical.worktree), beforeIndex, `${scenario.label}: index status is unchanged`);
    assert.equal(readWaveRecord(verified.recordPath).target.promotion, null, `${scenario.label}: no promotion intent is journalled`);
  }

  // (f) before-cas: a hook mutates main externally after intent is written; the
  // CAS observes the mismatch and blocks ref-changed without writing bytes.
  const hook = await verifiedFixture(t, 'promote-before-cas');
  const externalCommit = execFileSync('git', ['-C', hook.canonical.worktree, 'commit-tree', git(hook.canonical.worktree, ['write-tree']), '-p', hook.canonical.base, '-m', 'external'], { ...GIT, env: editorEnv() }).trim();
  const hookCtx = { ...hook.ctx, onBoundary: name => {
    if (name === 'before-cas') git(hook.canonical.worktree, ['update-ref', 'refs/heads/main', externalCommit, hook.canonical.base]);
  } };
  const beforeHook = snapshotTreeDigest(hook.canonical.worktree);
  const beforeHookIndex = cachedIndexStatus(hook.canonical.worktree);
  const blocked = await promoteWave(hookCtx);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'ref-changed');
  const blockedRecord = readWaveRecord(hook.recordPath);
  assert.equal(blockedRecord.target.promotion.state, 'blocked');
  assert.equal(git(hook.canonical.worktree, ['rev-parse', 'refs/heads/main']), externalCommit, 'main equals the external commit');
  assert.equal(snapshotTreeDigest(hook.canonical.worktree), beforeHook, 'the module wrote no canonical bytes');
  assert.equal(cachedIndexStatus(hook.canonical.worktree), beforeHookIndex, 'the before-cas hook left the cached index status unchanged');
});

// ---------------------------------------------------------------------------
// Case 7: a crash at each promotion boundary resumes the same journal.
// ---------------------------------------------------------------------------

// Child crash script: import the real module and ownership from absolute file
// URLs, rebuild the ownership registry handle, and run promoteWave with an
// onBoundary that SIGKILLs this process at the chosen seam.
function crashScript({ moduleUrl, ownershipUrl, ctxArgs, crashAt }) {
  return `
    import { createRequire } from 'node:module';
    const { createOwnership } = await import(${JSON.stringify(ownershipUrl)});
    const { promoteWave } = await import(${JSON.stringify(moduleUrl)});
    const args = JSON.parse(process.argv[1]);
    const ownership = createOwnership({ registryRoot: args.registryRoot, session: args.session });
    const ctx = { ...args.ctx, ownership, onBoundary: name => { if (name === args.crashAt) process.kill(process.pid, 'SIGKILL'); } };
    await promoteWave(ctx);
  `;
}

test('wave integration: a crash at each promotion boundary resumes the same journal', { timeout: TIMEOUT }, async t => {
  const boundaries = ['before-cas', 'after-cas', 'before-read-tree', 'after-read-tree'];
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('./wave-integration.mjs', import.meta.url))).href;
  const ownershipUrl = pathToFileURL(fileURLToPath(new URL('./ownership.mjs', import.meta.url))).href;
  for (const boundary of boundaries) {
    const verified = await verifiedFixture(t, `crash-${boundary}`);
    const { canonical, ctx, candidate, recordPath } = verified;
    // Serialize the ctx without functions, then reconstruct ownership in the
    // child from the identical coordinator/registry data.
    const { ownership, phaseRecord, runCommand, endPhaseRecord, onBoundary, ...serializable } = ctx;
    const args = { registryRoot: verified.registryRoot, session: ctx.coordinator.session, ctx: serializable, crashAt: boundary };
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', crashScript({ moduleUrl, ownershipUrl, ctxArgs: args, crashAt: boundary }), JSON.stringify(args)], { encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL', `${boundary}: the child is killed at its seam`);

    // The parent recovers in-process from the on-disk record and finishes the
    // same journal. The parent holds no claim, so it re-acquires under the same
    // replay rule, matching the child's coordinator session.
    ctx.revision = readWaveRecord(recordPath).revision;
    const promoted = await recoverPromotion(ctx);
    assert.equal(promoted.status, 'promoted', `${boundary}: recovery promotes`);
    assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), candidate, `${boundary}: main equals C`);
    assert.doesNotThrow(() => git(canonical.worktree, ['diff-index', '--cached', '--quiet', candidate]), `${boundary}: cached index equals C`);
    assert.doesNotThrow(() => git(canonical.worktree, ['diff-files', '--quiet']), `${boundary}: no unstaged changes`);
    assert.equal(readFileSync(join(canonical.worktree, '.cache', 'user.txt'), 'utf8'), 'ignored sentinel\n', `${boundary}: ignored bytes preserved`);
    const reflog = git(canonical.worktree, ['reflog', 'show', '--format=%gs%x00%H', 'refs/heads/main']).split('\n');
    const promoteEntries = reflog.filter(line => line.split('\0')[0] === `wave ${ctx.waveId}: promote`);
    assert.equal(promoteEntries.length, 1, `${boundary}: exactly one promotion reflog entry`);
    assert.equal(promoteEntries[0].split('\0')[1], candidate, `${boundary}: the reflog new value is C`);
    const record = readWaveRecord(recordPath);
    assert.equal(record.target.promotion.state, 'synced', `${boundary}: journal is synced`);
    assert.equal(record.target.promotion.candidate, candidate, `${boundary}: the journal names C`);
    assert.equal(git(canonical.worktree, ['rev-parse', `refs/waves/retained/${ctx.waveId}/candidate`]), candidate, `${boundary}: the candidate ref survives`);
    const claims = (await ownership.inspectClaims({ packageId: ctx.packageId })).claims;
    assert.equal(claims.filter(claim => claim.kind === 'checkout').length, 0, `${boundary}: no promotion checkout claim remains`);

    // A replay of recovery is idempotent: promoted, no extra reflog entry.
    ctx.revision = readWaveRecord(recordPath).revision;
    const replayed = await recoverPromotion(ctx);
    assert.equal(replayed.status, 'promoted', `${boundary}: replay promotes`);
    assert.equal(replayed.replayed, true, `${boundary}: replay is flagged`);
    assert.equal(git(canonical.worktree, ['reflog', 'show', '--format=%gs', 'refs/heads/main']).split('\n').filter(line => line === `wave ${ctx.waveId}: promote`).length, 1, `${boundary}: replay adds no reflog entry`);
  }

  // Interrupted after-cas fixtures: a dirty worktree, an external ref move and a
  // truncated journal each block recovery with its own reason.
  const interrupted = [
    { label: 'untracked-after-ref', reason: 'checkout-dirty-after-ref', break: ({ canonical }) => writeFileSync(join(canonical.worktree, 'notes.txt'), 'notes\n') },
    { label: 'external-ref', reason: 'ref-external-change', break: ({ canonical, candidate }) => {
      const external = execFileSync('git', ['-C', canonical.worktree, 'commit-tree', git(canonical.worktree, ['write-tree']), '-p', candidate, '-m', 'external'], { ...GIT, env: editorEnv() }).trim();
      git(canonical.worktree, ['update-ref', 'refs/heads/main', external]);
      return external;
    } },
    { label: 'truncated-journal', reason: 'journal-corrupt', break: ({ recordPath }) => writeFileSync(recordPath, '{"target":') },
  ];
  for (const scenario of interrupted) {
    const verified = await verifiedFixture(t, `crash-after-cas-${scenario.label}`);
    const { canonical, ctx, candidate, recordPath } = verified;
    const { ownership, phaseRecord, runCommand, endPhaseRecord, onBoundary, ...serializable } = ctx;
    const args = { registryRoot: verified.registryRoot, session: ctx.coordinator.session, ctx: serializable, crashAt: 'after-cas' };
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', crashScript({ moduleUrl, ownershipUrl, ctxArgs: args, crashAt: 'after-cas' }), JSON.stringify(args)], { encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL', `${scenario.label}: the child is killed at after-cas`);
    const bytesBefore = readFileSync(recordPath);
    const broken = scenario.break({ canonical, candidate, recordPath });
    const observedBefore = scenario.reason === 'journal-corrupt' ? readFileSync(recordPath) : null;
    ctx.revision = scenario.reason === 'journal-corrupt' ? ctx.revision : readWaveRecord(recordPath).revision;
    const result = await recoverPromotion(ctx);
    assert.equal(result.status, 'blocked', `${scenario.label}: recovery blocks`);
    assert.equal(result.reason, scenario.reason, `${scenario.label}: reason is ${scenario.reason}`);
    if (scenario.reason === 'checkout-dirty-after-ref') {
      assert.equal(readFileSync(join(canonical.worktree, 'notes.txt'), 'utf8'), 'notes\n', 'the untracked file is intact');
      assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), candidate, 'main still equals C');
    } else if (scenario.reason === 'ref-external-change') {
      assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), broken, 'main still names the external value');
    } else {
      assert.deepEqual(readFileSync(recordPath), observedBefore, 'the corrupt journal bytes are unchanged');
    }
    void bytesBefore;
  }
});

// ---------------------------------------------------------------------------
// Case 8: final owner-identified safeguards (test-first regressions).
// ---------------------------------------------------------------------------

test('wave integration: assembly replay requires a live package claim', { timeout: TIMEOUT }, async t => {
  const { canonical, ctx, ownership, recordPath } = await verifiedFixture(t, 'replay-claim');
  const before = readFileSync(recordPath);
  const mainBefore = git(canonical.worktree, ['rev-parse', 'refs/heads/main']);

  // Release the current package claim this ctx names, then replay the assembly.
  await ownership.releaseClaim({ token: ctx.packageClaim.token, epoch: ctx.packageClaim.epoch, drain: 'confirmed' });
  await assert.rejects(
    () => assembleCandidate(ctx),
    error => error?.reason === 'package-claim-missing',
  );

  assert.deepEqual(readFileSync(recordPath), before, 'the journal bytes are unchanged by the refused replay');
  assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), mainBefore, 'main is untouched by the refused replay');
});

test('wave integration: changed gate commands cannot reuse a receipt', { timeout: TIMEOUT }, async t => {
  const { canonical, ctx, recordPath } = await verifiedFixture(t, 'changed-command');
  ctx.checks = [{ id: 'EV-11', command: 'false', artifact: 'evidence/feature.txt', ownerStep: 1 }];

  const failed = await runCandidateChecks(ctx);

  assert.equal(failed.status, 'failed', 'the changed command is not covered by the old receipt, so it must actually run and fail');
  assert.equal(failed.replayed, false, 'the changed command did not replay the pass receipt');
  assert.equal(failed.repair.kind, 'integration-repair');
  assert.equal(failed.repair.trigger, 'composition');
  assert.deepEqual(failed.repair.failed_gates, ['EV-11']);
  const record = readWaveRecord(recordPath);
  const entry = (record.target.integration.checks ?? []).find(check => check.gate === 'EV-11' && check.command === 'false');
  assert.ok(entry, 'the fresh failing run is journaled');
  assert.equal(entry.outcome, 'fail');
  assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), canonical.base, 'main stays at base B');
});

test('wave integration: recovery rejects a different wave without touching its journal', { timeout: TIMEOUT }, async t => {
  const { ctx, recordPath } = await verifiedFixture(t, 'recover-other-wave');
  const promoted = await promoteWave(ctx);
  assert.equal(promoted.status, 'promoted');
  const before = readFileSync(recordPath);

  const result = await recoverPromotion({ ...ctx, waveId: 'different-wave' });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'journal-corrupt');
  assert.deepEqual(readFileSync(recordPath), before, 'the other wave cannot touch this journal');
});

// ---------------------------------------------------------------------------
// Promotion safety regressions: ignored collisions, changed input identity and
// promoted replay. The module must never let untracked-but-ignored bytes hide a
// promotion collision, never promote overlapped inputs, and always return the
// same branch ref for a promoted journal.
// ---------------------------------------------------------------------------

// A fresh verified candidate whose canonical tree declares no feature.txt.
// Collisions are introduced only by the subcase, so the baseline is clean.
async function promotionBaseline(t, label) {
  const verified = await verifiedFixture(t, label);
  const { canonical, ctx, candidate, recordPath } = verified;
  assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), canonical.base, `${label}: main starts at B`);
  const before = {
    digest: snapshotTreeDigest(canonical.worktree),
    index: cachedIndexStatus(canonical.worktree),
    main: git(canonical.worktree, ['rev-parse', 'refs/heads/main']),
    record: readFileSync(recordPath),
  };
  return { ...verified, before };
}

test('wave integration: ignored collisions refuse promotion without touching bytes', { timeout: TIMEOUT }, async t => {
  const collisions = [
    // feature.txt is ignored via .git/info/exclude; the candidate also ships a
    // tracked feature.txt, so promotion would overwrite valuable ignoring state.
    { label: 'ignored-file', exclude: 'feature.txt\n', mutate: ({ canonical }) => writeFileSync(join(canonical.worktree, 'feature.txt'), 'valuable ignored\n') },
    // feature.txt is ignored and exists as a directory holding a valuable child,
    // which a file collision would replace.
    { label: 'ignored-directory', exclude: 'feature.txt/\n', mutate: ({ canonical }) => {
      mkdirSync(join(canonical.worktree, 'feature.txt'), { recursive: true });
      writeFileSync(join(canonical.worktree, 'feature.txt', 'valuable.txt'), 'valuable child\n');
    } },
  ];
  for (const scenario of collisions) {
    const baseline = await promotionBaseline(t, `ignored-${scenario.label}`);
    const { canonical, ctx, recordPath } = baseline;
    // Install the ignore rule and the valuable bytes the candidate collides with.
    mkdirSync(join(canonical.worktree, '.git', 'info'), { recursive: true });
    writeFileSync(join(canonical.worktree, '.git', 'info', 'exclude'), scenario.exclude);
    scenario.mutate({ canonical });
    // Pre-mutation index status is re-observed because the ignore rule itself
    // changes what is tracked-clean. The raw index bytes are captured too so the
    // refusal can prove it did not rewrite the checkout's index file.
    const beforeIndex = cachedIndexStatus(canonical.worktree);
    const beforeRawIndex = readFileSync(join(canonical.worktree, '.git', 'index'));
    const beforeBytes = snapshotTreeDigest(canonical.worktree);
    const refused = await promoteWave(ctx).then(result => ({ result }), error => ({ error }));
    // The module may either throw (refusal, leaving the journal at no intent) or
    // return a blocked result; both preserve the canonical bytes, the raw index
    // and main at B.
    if (refused.error) {
      assert.equal(refused.error.code, 'integration-refusal', `${scenario.label}: refusal raises integration-refusal`);
      assert.ok(typeof refused.error.reason === 'string' && refused.error.reason.length > 0, `${scenario.label}: refusal names a reason`);
      assert.equal(readWaveRecord(recordPath).target.promotion, null, `${scenario.label}: refusal writes no journal intent`);
    } else {
      assert.equal(refused.result.status, 'blocked', `${scenario.label}: promotion blocks`);
      const blockedRecord = readWaveRecord(recordPath);
      assert.equal(blockedRecord.target.promotion.state, 'blocked', `${scenario.label}: the journal marks the promotion blocked`);
    }
    assert.equal(snapshotTreeDigest(canonical.worktree), beforeBytes, `${scenario.label}: canonical bytes are unchanged`);
    assert.equal(cachedIndexStatus(canonical.worktree), beforeIndex, `${scenario.label}: the raw index status is unchanged`);
    assert.deepEqual(readFileSync(join(canonical.worktree, '.git', 'index')), beforeRawIndex, `${scenario.label}: the raw index is unchanged`);
    assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), canonical.base, `${scenario.label}: main stays at B`);
    const valuableFile = scenario.label === 'ignored-file'
      ? join(canonical.worktree, 'feature.txt')
      : join(canonical.worktree, 'feature.txt', 'valuable.txt');
    assert.equal(readFileSync(valuableFile, 'utf8'),
      scenario.label === 'ignored-file' ? 'valuable ignored\n' : 'valuable child\n',
      `${scenario.label}: valuable ignored bytes survive`);
  }

  // The unrelated ignored fixture the canonical repo already ships stays intact
  // in every subcase, proving the refusal is targeted at the collision.
  const sentinelBaseline = await promotionBaseline(t, 'ignored-sentinel-intact');
  const { canonical: sentinelCanonical, ctx: sentinelCtx } = sentinelBaseline;
  mkdirSync(join(sentinelCanonical.worktree, '.git', 'info'), { recursive: true });
  writeFileSync(join(sentinelCanonical.worktree, '.git', 'info', 'exclude'), 'feature.txt\n');
  writeFileSync(join(sentinelCanonical.worktree, 'feature.txt'), 'valuable ignored\n');
  await promoteWave(sentinelCtx).then(() => {}, () => {});
  assert.equal(readFileSync(join(sentinelCanonical.worktree, '.cache', 'user.txt'), 'utf8'), 'ignored sentinel\n', 'the unrelated ignored fixture is preserved');
});

test('wave integration: a collision introduced before read-tree blocks and preserves bytes', { timeout: TIMEOUT }, async t => {
  const baseline = await promotionBaseline(t, 'ignored-before-read-tree');
  const { canonical, ctx, recordPath } = baseline;
  // The candidate ships feature.txt; an untracked-but-ignored feature.txt is
  // planted at the before-read-tree seam, after the ref CAS but before the index
  // read, so the module must block rather than clobber it while materializing.
  // Snapshot the planted bytes and raw index inside the hook, immediately after
  // the collision is planted and before the module reads the tree, so both the
  // blocked result and the later recovery can be compared against the exact
  // state the module was handed.
  const snapshots = {};
  const collisionCtx = { ...ctx, onBoundary: name => {
    if (name !== 'before-read-tree') return;
    mkdirSync(join(canonical.worktree, '.git', 'info'), { recursive: true });
    writeFileSync(join(canonical.worktree, '.git', 'info', 'exclude'), 'feature.txt\n');
    writeFileSync(join(canonical.worktree, 'feature.txt'), 'valuable ignored\n');
    snapshots.bytes = snapshotTreeDigest(canonical.worktree);
    snapshots.index = readFileSync(join(canonical.worktree, '.git', 'index'));
    snapshots.indexStatus = cachedIndexStatus(canonical.worktree);
  } };
  const result = await promoteWave(collisionCtx);
  assert.equal(result.status, 'blocked', 'the before-read-tree collision blocks promotion');
  const blockedRecord = readWaveRecord(recordPath);
  assert.equal(blockedRecord.target.promotion.state, 'blocked', 'the journal records the block');
  assert.equal(snapshotTreeDigest(canonical.worktree), snapshots.bytes, 'the blocked result preserves the planted canonical bytes');
  assert.deepEqual(readFileSync(join(canonical.worktree, '.git', 'index')), snapshots.index, 'the blocked result preserves the planted raw index');
  assert.equal(cachedIndexStatus(canonical.worktree), snapshots.indexStatus, 'the blocked result preserves the planted raw index status');
  // Recovery from the blocked journal must stay blocked and preserve both.
  ctx.revision = readWaveRecord(recordPath).revision;
  const recovered = await recoverPromotion(ctx);
  assert.equal(recovered.status, 'blocked', 'recovery remains blocked');
  assert.equal(readWaveRecord(recordPath).target.promotion.state, 'blocked', 'the journal is still blocked');
  assert.equal(snapshotTreeDigest(canonical.worktree), snapshots.bytes, 'recovery preserves the canonical bytes');
  assert.deepEqual(readFileSync(join(canonical.worktree, '.git', 'index')), snapshots.index, 'recovery preserves the raw index');
  assert.equal(cachedIndexStatus(canonical.worktree), snapshots.indexStatus, 'recovery preserves the raw index status');
  assert.equal(readFileSync(join(canonical.worktree, 'feature.txt'), 'utf8'), 'valuable ignored\n', 'the valuable ignored bytes survive recovery');
});

test('wave integration: moved sealed head and retention ref reject promotion', { timeout: TIMEOUT }, async t => {
  // After a promoted candidate is assembled, moving the sealed head together
  // with its retention ref to canonical.base changes the input identity.
  const { canonical, ctx, recordPath, before } = await promotionBaseline(t, 'input-identity-move');
  const member = ctx.members[0];
  git(canonical.worktree, ['update-ref', member.retentionRef, canonical.base, member.sealedHead]);
  const movedCtx = { ...ctx, members: [{ ...member, sealedHead: canonical.base }] };
  const beforeIndex = cachedIndexStatus(canonical.worktree);
  const beforeRawIndex = readFileSync(join(canonical.worktree, '.git', 'index'));
  const beforeBytes = snapshotTreeDigest(canonical.worktree);
  const refused = await promoteWave(movedCtx).then(result => ({ result }), error => ({ error }));
  if (refused.error) {
    assert.equal(refused.error.reason, 'integration-input-changed', 'a member identity moved with its refs refuses as integration-input-changed');
  } else {
    assert.equal(refused.result.status, 'blocked', 'a changed member identity blocks promotion');
    assert.equal(refused.result.reason, 'integration-input-changed', 'the block names integration-input-changed');
  }
  assert.deepEqual(readFileSync(recordPath), before.record, 'the raw journal is unchanged');
  assert.equal(snapshotTreeDigest(canonical.worktree), beforeBytes, 'the canonical bytes are unchanged');
  assert.equal(cachedIndexStatus(canonical.worktree), beforeIndex, 'the raw index status is unchanged');
  assert.deepEqual(readFileSync(join(canonical.worktree, '.git', 'index')), beforeRawIndex, 'the raw index is unchanged');
  assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), canonical.base, 'main stays at B');
});

test('wave integration: recovery refuses moved inputs after a before-cas crash', { timeout: TIMEOUT }, async t => {
  const { canonical, ctx, candidate, recordPath } = await promotionBaseline(t, 'input-identity-crash');
  const member = ctx.members[0];
  // Run promotion in this process but trip a sentinel at before-cas so the
  // journal is left at intent with the checkout still at B.
  const sentinel = new Error('before-cas-sentinel');
  const crashed = await promoteWave({ ...ctx, onBoundary: name => { if (name === 'before-cas') throw sentinel; } })
    .then(() => null, error => error);
  assert.equal(crashed, sentinel, 'the before-cas sentinel is caught by the test');
  const journalBefore = readFileSync(recordPath);
  const indexBefore = cachedIndexStatus(canonical.worktree);
  const rawIndexBefore = readFileSync(join(canonical.worktree, '.git', 'index'));
  const bytesBefore = snapshotTreeDigest(canonical.worktree);
  assert.notEqual(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), candidate, 'the crash left main unpromoted');
  // Move the sealed head and its retention ref together to canonical.base.
  git(canonical.worktree, ['update-ref', member.retentionRef, canonical.base, member.sealedHead]);
  ctx.members = [{ ...member, sealedHead: canonical.base }];
  ctx.revision = readWaveRecord(recordPath).revision;
  const recovered = await recoverPromotion(ctx).then(result => ({ result }), error => ({ error }));
  if (recovered.error) {
    assert.equal(recovered.error.reason, 'integration-input-changed', 'recovery refuses the moved member identity');
  } else {
    assert.equal(recovered.result.status, 'blocked', 'recovery blocks on changed inputs');
    assert.ok(['integration-input-changed', 'candidate-unverified', 'journal-corrupt'].includes(recovered.result.reason), 'recovery names a refusal reason');
  }
  assert.deepEqual(readFileSync(recordPath), journalBefore, 'the raw journal is unchanged by the refused recovery');
  assert.equal(snapshotTreeDigest(canonical.worktree), bytesBefore, 'the canonical bytes are unchanged');
  assert.equal(cachedIndexStatus(canonical.worktree), indexBefore, 'the raw index status is unchanged');
  assert.deepEqual(readFileSync(join(canonical.worktree, '.git', 'index')), rawIndexBefore, 'the raw index is unchanged');
  assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), canonical.base, 'main stays at B after refusal');
});

test('wave integration: promoted replay returns the same branch ref', { timeout: TIMEOUT }, async t => {
  const { canonical, ctx, candidate, recordPath } = await promotionBaseline(t, 'promoted-replay-ref');
  const promoted = await promoteWave(ctx);
  assert.equal(promoted.status, 'promoted', 'the fresh promotion succeeds');
  assert.equal(promoted.ref, 'refs/heads/main', 'a fresh promotion returns refs/heads/main');
  assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), candidate, 'main equals C after promotion');
  ctx.revision = readWaveRecord(recordPath).revision;
  const recovered = await recoverPromotion(ctx);
  assert.equal(recovered.status, 'promoted', 'recoverPromotion returns promoted');
  assert.equal(recovered.ref, promoted.ref, 'recoverPromotion returns the same ref as the fresh promotion');
  const replayed = await promoteWave({ ...ctx, revision: readWaveRecord(recordPath).revision });
  assert.equal(replayed.status, 'promoted', 'promoteWave on the synced journal returns promoted');
  assert.equal(replayed.ref, promoted.ref, 'promoteWave replay returns the same ref');
  assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), candidate, 'replay leaves main at C');
});

// ---------------------------------------------------------------------------
// Case 10: capacity queuing, drain-unknown and orphan-promotion recovery.
// ---------------------------------------------------------------------------

test('wave integration: a queued candidate check leaves a repair-ready journal', { timeout: TIMEOUT }, async t => {
  const { ctx, ownership, registryRoot } = await verifiedFixture(t, 'queued-check');
  ctx.checks = [{ id: 'EV-12', command: 'false', artifact: 'evidence/queued.txt', ownerStep: 1 }];

  // Force the gate to fail so a composition repair is requested, then make the
  // internal repair's own capacity reservation queue: the confirmed drain at the
  // end of the gate record installs a zero-task ownership on the same registry.
  const originalEnd = ctx.endPhaseRecord;
  const originalOwnership = ctx.ownership;
  let swapped = false;
  ctx.endPhaseRecord = async (record, options) => {
    const ended = await originalEnd(record, options);
    if (!swapped && options?.drained === true) {
      swapped = true;
      ctx.ownership = createOwnership({ registryRoot, budgets: { tasks: 0 } });
    }
    return ended;
  };

  const failed = await runCandidateChecks(ctx);
  ctx.ownership = originalOwnership;

  assert.equal(failed.status, 'queued', 'the internal repair capacity reservation is queued, not silently dropped');
  assert.equal(failed.revision, readWaveRecord(ctx.recordPath).revision, 'the queued result reports the current journal revision');
  assert.equal(failed.repair, null, 'a queued repair has no repair packet');
  assert.ok(failed.constraint, 'a queued result carries the constraint that queued it');

  // With the blocked drain the repair request was never written, so a fresh
  // prepare at the queued revision must still be able to reach repair-ready.
  const prepared = await prepareIntegrationRepair({ ...ctx, revision: failed.revision });
  assert.equal(prepared.status, 'repair-ready', 'a fresh prepare succeeds repair-ready, not revision-mismatch');
  assert.equal(prepared.repair.kind, 'integration-repair');
  assert.equal(prepared.repair.attempt, 'repair-1');
  assert.equal(ownership, ctx.ownership);
});

test('wave integration: a thrown gate transport blocks drain-unknown and keeps claims until a confirmed retry', { timeout: TIMEOUT }, async t => {
  for (const state of ['checking', 'blocked']) {
    const { ctx, ownership, recordPath } = await verifiedFixture(t, `drain-unknown-${state}`);
    const gate = { id: 'EV-13', command: 'test -f feature.txt', artifact: 'evidence/drain.txt', ownerStep: 1 };
    ctx.checks = [gate];

    // Model a mid-gate crash: only this one configured command's transport throws
    // (launching no gate child), so the phase is genuinely unknown. Every other
    // status/materialization command delegates to the real seam.
    const originalRun = ctx.runCommand;
    let thrown = false;
    ctx.runCommand = async (record, command, timeoutSeconds, signal) => {
      if (!thrown && command === gate.command) { thrown = true; throw new Error('gate transport crashed'); }
      return originalRun(record, command, timeoutSeconds, signal);
    };
    // The first pass runs the throw from the current verified status: the
    // nonreplay gate leaves the phase unknown, so the run blocks and retains
    // both the phase and capacity claims.
    const blocked = await runCandidateChecks(ctx);
    assert.equal(blocked.status, 'blocked', `${state}: an unknown drain blocks`);
    assert.equal(blocked.blocked_reason, 'drain-unknown', `${state}: the block reason is drain-unknown`);
    assert.equal(blocked.claims, 'kept', `${state}: the phase and capacity claims are retained`);

    if (state === 'checking') {
      // Persist a mid-gate crash fingerprint: status checking at the exact
      // blocked revision, with no live processes and no completed run record.
      updateWaveRecord(recordPath, { expectedRevision: blocked.revision }, draft => {
        draft.target.integration = { ...draft.target.integration, status: 'checking' };
      });
      ctx.revision = readWaveRecord(recordPath).revision;
    }

    // Without a confirmed drain the retained claims make a retry refuse as
    // drain-unknown rather than double-reserve; the journal and claims are
    // unchanged by that refusal.
    const before = readFileSync(recordPath);
    const claimsBefore = await ownership.inspectClaims({ packageId: ctx.packageId });
    await assert.rejects(
      () => runCandidateChecks({ ...ctx, revision: readWaveRecord(recordPath).revision }),
      error => error?.reason === 'drain-unknown',
      `${state}: a retry without a confirmed drain is refused as drain-unknown while claims are held`,
    );
    assert.deepEqual(readFileSync(recordPath), before, `${state}: the refused retry does not mutate the journal`);
    assert.deepEqual(await ownership.inspectClaims({ packageId: ctx.packageId }), claimsBefore, `${state}: the refused retry leaves the retained claims unchanged`);

    // Restore the real transport and confirm the drain: because the thrown
    // command launched no gate child, the drain is real. The retry must pass on a
    // fresh pass receipt at canonical B with no claims left except the package.
    ctx.runCommand = originalRun;
    const retried = await runCandidateChecks({ ...ctx, revision: readWaveRecord(recordPath).revision }, { drain: 'confirmed' });
    assert.equal(retried.status, 'passed', `${state}: the confirmed retry passes`);
    assert.equal(retried.replayed, false, `${state}: the pass is a fresh receipt, not a replay`);
    const record = readWaveRecord(recordPath);
    assert.equal(record.target.integration.status, 'verified', `${state}: the journal reaches verified`);
    assert.equal(record.target.candidate_commit, record.target.integration.checks[0].observed_commit, `${state}: the receipt is bound to the candidate`);
    assert.equal(git(ctx.target.worktree, ['rev-parse', 'refs/heads/main']), ctx.baseCommit, `${state}: canonical main stays at B`);
    const { claims } = await ownership.inspectClaims({ packageId: ctx.packageId });
    const remaining = (claims ?? []).filter(claim => claim.kind !== 'package');
    assert.deepEqual(remaining, [], `${state}: only the package claim remains`);
  }
});

test('wave integration: a spent automatic repair blocks until an explicit reviewed repair is accepted', { timeout: TIMEOUT }, async t => {
  const { ctx, candidate, recordPath, fixture } = await verifiedFixture(t, 'explicit-repair');
  const repairRoot = fixture.canonical.worktree;
  const repairEnv = editorEnv();
  const gate = { id: 'EV-14', command: 'false', artifact: 'evidence/explicit.txt', ownerStep: 1 };
  ctx.checks = [gate];

  // First automatic repair: the failing gate requests one repair, which we review
  // and accept as R1 (a child of C in the candidate worktree).
  const first = await runCandidateChecks(ctx);
  ctx.revision = first.revision;
  assert.equal(first.status, 'failed');
  assert.equal(first.repair.attempt, 'repair-1');
  const packet = await prepareIntegrationRepair(ctx);
  ctx.revision = packet.revision;
  assert.equal(packet.status, 'repair-ready');
  const r1Root = packet.repair.workspace.worktree;
  writeFileSync(join(r1Root, 'repair-1.txt'), 'r1\n');
  git(r1Root, ['add', 'repair-1.txt']);
  const r1Tree = git(r1Root, ['write-tree']);
  const r1 = execFileSync('git', ['-C', r1Root, 'commit-tree', r1Tree, '-p', candidate, '-m', 'repair-1'], { ...GIT, env: repairEnv }).trim();
  git(r1Root, ['update-ref', 'HEAD', r1, candidate]);
  const accepted1 = await acceptIntegrationRepair(ctx, { head: r1, review: { verdict: 'pass', head: r1, artifact: 'evidence/repair-1.txt' } });
  ctx.revision = accepted1.revision;
  assert.equal(accepted1.status, 'accepted');

  // Re-assemble at R1 and fail again: the automatic limit is spent, so a fresh
  // automatic prepare must block repair-unresolved before any explicit call.
  const second = await assembleCandidate(ctx);
  ctx.revision = second.revision;
  assert.equal(second.candidate.commit, r1);
  const auto = await runCandidateChecks(ctx);
  ctx.revision = auto.revision;
  assert.equal(auto.status, 'blocked', 'the automatic path blocks once the repair limit is spent');
  assert.equal(auto.blocked_reason, 'repair-unresolved');

  // An explicit reviewed repair is still allowed: prepare must reach repair-ready
  // with a durable repair_request whose attempt is repair-2.
  const explicit = await prepareIntegrationRepair(ctx, { explicit: true });
  ctx.revision = explicit.revision;
  assert.equal(explicit.status, 'repair-ready', 'an explicit prepare overrides the spent automatic limit');
  assert.equal(explicit.repair.attempt, 'repair-2');
  assert.ok(readWaveRecord(recordPath).target.integration.repair_request, 'the repair_request is durable in the journal');
  assert.equal(readWaveRecord(recordPath).target.integration.repair_request.attempt, 'repair-2');

  // R2 is a child of R1; accepting it explicitly records a second repair with
  // head R2 and the revised status per the current API.
  const r2Root = explicit.repair.workspace.worktree;
  writeFileSync(join(r2Root, 'repair-2.txt'), 'r2\n');
  git(r2Root, ['add', 'repair-2.txt']);
  const r2Tree = git(r2Root, ['write-tree']);
  const r2 = execFileSync('git', ['-C', r2Root, 'commit-tree', r2Tree, '-p', r1, '-m', 'repair-2'], { ...GIT, env: repairEnv }).trim();
  git(r2Root, ['update-ref', 'HEAD', r2, r1]);
  const accepted2 = await acceptIntegrationRepair(ctx, { head: r2, explicit: true, review: { verdict: 'pass', head: r2, artifact: 'evidence/repair-2.txt' } });
  ctx.revision = accepted2.revision;
  assert.equal(accepted2.status, 'accepted', 'the explicit repair is accepted');
  const record = readWaveRecord(recordPath);
  assert.equal(record.target.integration.repairs.length, 2, 'both reviewed repairs are recorded');
  assert.equal(record.target.integration.repairs[1].head, r2, 'the second repair head is R2');
  assert.equal(record.target.integration.repairs[1].explicit, true, 'the second repair is flagged explicit');
  assert.equal(record.target.candidate_commit, r2, 'the candidate advances to R2');
  assert.equal(git(repairRoot, ['rev-parse', 'refs/heads/main']), ctx.baseCommit, 'accepting the repair never touches canonical main');
});

test('wave integration: promotion recovery adopts an orphaned pre-intent checkout claim', { timeout: TIMEOUT }, async t => {
  const { canonical, ctx, ownership, candidate, recordPath } = await verifiedFixture(t, 'orphan-promotion');
  assert.equal(readWaveRecord(recordPath).target.promotion ?? null, null, 'no promotion intent exists before recovery');

  // Model a crash immediately after the real reservation and before the intent:
  // reserve the canonical checkout directly through ownership under this wave's
  // promotion attempt, with the same epoch and exact observed paths.
  const checkout = realpathSync(canonical.worktree);
  const gitCommonDir = realpathSync(git(canonical.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const worktreeGitDir = realpathSync(git(canonical.worktree, ['rev-parse', '--path-format=absolute', '--absolute-git-dir']));
  await ownership.reserveCheckout({
    packageId: ctx.packageId,
    attempt: `${ctx.waveId}:promotion`,
    checkout: { gitCommonDir, worktreeGitDir },
    coordinator: { ...ctx.coordinator, session: 'old-promotion-coordinator' },
  });

  assert.equal(readWaveRecord(recordPath).target.promotion ?? null, null, 'the orphan reservation alone writes no promotion intent');

  // Recovery under the current coordinator session adopts the retained
  // pre-intent claim and promotes, returning the branch ref, the candidate, a
  // synced journal and only the package claim remaining (the orphan checkout
  // claim is released).
  const recovered = await recoverPromotion({ ...ctx, revision: readWaveRecord(recordPath).revision });
  assert.equal(recovered.status, 'promoted', 'recovery adopts the orphan claim and promotes');
  assert.equal(recovered.ref, 'refs/heads/main');
  assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), candidate, 'recovery promotes main to C');
  assert.ok(recovered.promotion, 'the recovered promotion is reported');
  assert.equal(readWaveRecord(recordPath).target.promotion.state, 'synced', 'the recovered journal is synced');
  const { claims } = await ownership.inspectClaims({ packageId: ctx.packageId });
  const remaining = (claims ?? []).filter(claim => claim.kind !== 'package');
  assert.deepEqual(remaining, [], 'the adopted checkout claim is released, leaving only the package');

  // A second recovery is a synced replay returning the same ref.
  const replay = await recoverPromotion({ ...ctx, revision: readWaveRecord(recordPath).revision, coordinator: { ...ctx.coordinator, session: 'old-promotion-coordinator' } });
  assert.equal(replay.status, 'promoted', 'a synced journal replays as promoted');
  assert.equal(replay.ref, recovered.ref, 'the replay returns the same branch ref');
  assert.equal(git(canonical.worktree, ['rev-parse', 'refs/heads/main']), candidate, 'the replay leaves main at C');
});
