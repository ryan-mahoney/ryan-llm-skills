// Standalone workspace regressions for the wave packet workspace manager.
//
// These tests pin the contract of `createPacketWorkspaces` from ./editor-workspaces.mjs:
//   async createPacketWorkspaces({ checkout, packets: [{ paths: [...] }] })
//     -> { isolated, workspaces, integrate(index), cleanup() }
// `isolated` is false when every packet's paths are disjoint from the others, in which
// case every entry of `workspaces` is the original checkout path and writes are visible
// immediately. When any paths overlap, packets run in isolated standalone repos seeded
// with the current working-tree bytes (including untracked files). `integrate(index)`
// merges packet `index`'s workspace back into the checkout and reports
// { status: 'applied'|'conflict', conflicting_paths, patch }. `cleanup()` removes the
// isolated workspace roots and leaks no git worktrees.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPacketWorkspaces, releasePacketWorkspaces } from './editor-workspaces.mjs';
import { interpretProbeResult } from './overlay.mjs';
import { createOwnership } from './ownership.mjs';
import { runEditorBatch } from './runtime.mjs';

// A disposable real git repository with two committed files and a dirty owner edit plus
// an untracked source file. Local identity is fixed so commits need no global config.
function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), 'wave-packets-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Wave Packets');
  git('config', 'user.email', 'wave-packets@example.invalid');
  writeFileSync(join(repo, 'shared.txt'), 'line-one\nsep-a\nsep-b\nsep-c\nline-two\n');
  writeFileSync(join(repo, 'other.txt'), 'other-base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const head = git('rev-parse', 'HEAD');
  // Dirty owner edit to the tracked file and an untracked source file, both present only
  // in the working tree (not HEAD).
  writeFileSync(join(repo, 'shared.txt'), 'line-one\nsep-a\nsep-b\nsep-c\nline-two-owner-dirty\n');
  writeFileSync(join(repo, 'untracked.txt'), 'untracked-owner-bytes\n');
  return { repo, git, head };
}

function worktreeList(repo) {
  return execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

test('wave packets: overlapping paths produce distinct workspaces seeded with dirty and untracked bytes', async (t) => {
  const f = fixture(t);
  const ws = await createPacketWorkspaces({
    checkout: f.repo,
    packets: [{ paths: ['shared.txt'] }, { paths: ['shared.txt'] }],
  });
  try {
    assert.equal(ws.isolated, true);
    assert.equal(ws.workspaces.length, 2);
    assert.notEqual(ws.workspaces[0], ws.workspaces[1]);
    assert.notEqual(ws.workspaces[0], f.repo);
    assert.notEqual(ws.workspaces[1], f.repo);

    for (const workspace of ws.workspaces) {
      // Current dirty bytes, not HEAD.
      assert.equal(readFileSync(join(workspace, 'shared.txt'), 'utf8'), 'line-one\nsep-a\nsep-b\nsep-c\nline-two-owner-dirty\n');
      // Untracked owner source is carried into the isolated workspace.
      assert.equal(readFileSync(join(workspace, 'untracked.txt'), 'utf8'), 'untracked-owner-bytes\n');
    }

    // Both packets edit different lines of the same file before any integrate.
    writeFileSync(join(ws.workspaces[0], 'shared.txt'), 'line-one-p0\nsep-a\nsep-b\nsep-c\nline-two-owner-dirty\n');
    writeFileSync(join(ws.workspaces[1], 'shared.txt'), 'line-one\nsep-a\nsep-b\nsep-c\nline-two-owner-dirty-p1\n');

    const first = await ws.integrate(0);
    assert.equal(first.status, 'applied');
    const second = await ws.integrate(1);
    assert.equal(second.status, 'applied');

    // Combined bytes retained: neither packet's edit is lost.
    assert.equal(readFileSync(join(f.repo, 'shared.txt'), 'utf8'), 'line-one-p0\nsep-a\nsep-b\nsep-c\nline-two-owner-dirty-p1\n');
  } finally {
    await ws.cleanup();
  }
});

test('wave packets: a conflicting packet integrates atomically and leaves owner files unchanged', async (t) => {
  const f = fixture(t);
  const ws = await createPacketWorkspaces({
    checkout: f.repo,
    packets: [{ paths: ['shared.txt'] }, { paths: ['shared.txt', 'other.txt'] }],
  });
  try {
    assert.equal(ws.isolated, true);

    // Packet 0 modifies the conflict file first.
    writeFileSync(join(ws.workspaces[0], 'shared.txt'), 'line-one\nsep-a\nsep-b\nsep-c\nline-two-packet-zero\n');
    // Packet 1 modifies the same line differently plus another file.
    writeFileSync(join(ws.workspaces[1], 'shared.txt'), 'line-one\nsep-a\nsep-b\nsep-c\nline-two-packet-one\n');
    writeFileSync(join(ws.workspaces[1], 'other.txt'), 'other-packet-one\n');

    const first = await ws.integrate(0);
    assert.equal(first.status, 'applied');

    const second = await ws.integrate(1);
    assert.equal(second.status, 'conflict');
    assert.ok(Array.isArray(second.conflicting_paths));
    assert.ok(second.conflicting_paths.includes('shared.txt'));
    assert.equal(typeof second.patch, 'string');
    assert.match(second.patch, /packet-one/);

    // Owner other file is unchanged: the packet is applied atomically, so its non-conflicting
    // edit is not partially landed.
    assert.equal(readFileSync(join(f.repo, 'other.txt'), 'utf8'), 'other-base\n');
  } finally {
    await ws.cleanup();
  }
});

test('wave packets: disjoint paths run unisolated in the original checkout with no-op integration', async (t) => {
  const f = fixture(t);
  const ws = await createPacketWorkspaces({
    checkout: f.repo,
    packets: [{ paths: ['shared.txt'] }, { paths: ['other.txt'] }],
  });
  t.after(() => ws.cleanup());

  assert.equal(ws.isolated, false);
  assert.equal(ws.workspaces.length, 2);
  assert.equal(ws.workspaces[0], f.repo);
  assert.equal(ws.workspaces[1], f.repo);

  // Writes are visible immediately because both packets share the checkout.
  writeFileSync(join(ws.workspaces[0], 'shared.txt'), 'line-one\nsep-a\nsep-b\nsep-c\nline-two-unisolated\n');
  assert.equal(readFileSync(join(f.repo, 'shared.txt'), 'utf8'), 'line-one\nsep-a\nsep-b\nsep-c\nline-two-unisolated\n');

  const applied = await ws.integrate(0);
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.conflicting_paths, []);
});

test('wave packets: ignored owner artifacts are seeded and integrated from the snapshot', async (t) => {
  const f = fixture(t);
  // The owner ignores one class of files; the ignored artifact is nevertheless part of the
  // working-tree snapshot and must be seeded into every isolated packet workspace.
  writeFileSync(join(f.repo, '.gitignore'), '*.cache\n');
  const baseline = 'cache-line-one\ncache-line-two\n';
  writeFileSync(join(f.repo, 'artifact.cache'), baseline);

  const ws = await createPacketWorkspaces({
    checkout: f.repo,
    packets: [{ paths: ['artifact.cache'] }, { paths: ['artifact.cache'] }],
  });
  try {
    assert.equal(ws.isolated, true);

    // Every copy starts from the ignored owner baseline bytes, not an empty file.
    for (const workspace of ws.workspaces) {
      assert.equal(readFileSync(join(workspace, 'artifact.cache'), 'utf8'), baseline);
    }

    writeFileSync(join(ws.workspaces[0], 'artifact.cache'), 'cache-packet-zero\ncache-line-two\n');
    writeFileSync(join(ws.workspaces[1], 'artifact.cache'), 'cache-packet-one\ncache-line-two\n');

    const first = await ws.integrate(0);
    assert.equal(first.status, 'applied');
    const second = await ws.integrate(1);
    assert.equal(second.status, 'conflict');
    assert.ok(second.conflicting_paths.includes('artifact.cache'));
    // The returned patch carries packet 1's replacement so the owner can inspect it.
    assert.equal(typeof second.patch, 'string');
    assert.notEqual(second.patch, '');
    assert.match(second.patch, /cache-packet-one/);

    // Owner retains the applied packet 0 bytes; the conflicted packet leaves no trace.
    assert.equal(readFileSync(join(f.repo, 'artifact.cache'), 'utf8'), 'cache-packet-zero\ncache-line-two\n');
  } finally {
    await ws.cleanup();
  }
});

test('wave packets: a declared but absent future file still yields a nonempty conflict patch', async (t) => {
  const f = fixture(t);
  // Neither packet may create this file: it stays absent in the owner checkout.
  const ws = await createPacketWorkspaces({
    checkout: f.repo,
    packets: [
      { paths: ['shared.txt', 'never-created.txt'] },
      { paths: ['shared.txt', 'never-created.txt'] },
    ],
  });
  try {
    assert.equal(ws.isolated, true);

    writeFileSync(join(ws.workspaces[0], 'shared.txt'), 'line-one\nsep-a\nsep-b\nsep-c\nline-two-packet-zero\n');
    writeFileSync(join(ws.workspaces[1], 'shared.txt'), 'line-one\nsep-a\nsep-b\nsep-c\nline-two-packet-one\n');

    const first = await ws.integrate(0);
    assert.equal(first.status, 'applied');
    const second = await ws.integrate(1);
    assert.equal(second.status, 'conflict');
    assert.ok(second.conflicting_paths.includes('shared.txt'));
    // A conflict on a declared-but-absent path must still produce a usable patch.
    assert.equal(typeof second.patch, 'string');
    assert.notEqual(second.patch, '');
    assert.match(second.patch, /packet-one/);

    // The never-created declared path is absent in the owner working tree.
    assert.equal(existsSync(join(f.repo, 'never-created.txt')), false);
    assert.equal(readFileSync(join(f.repo, 'shared.txt'), 'utf8'), 'line-one\nsep-a\nsep-b\nsep-c\nline-two-packet-zero\n');
  } finally {
    await ws.cleanup();
  }
});

test('wave packets: a declared path through an unsafe ancestor symlink is rejected before launch', async (t) => {
  const f = fixture(t);
  // External directory the owner symlink points at; packets must never escape into it.
  const external = mkdtempSync(join(tmpdir(), 'wave-external-'));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  const externalBytes = 'external-safe\n';
  writeFileSync(join(external, 'file.txt'), externalBytes);
  symlinkSync(external, join(f.repo, 'link'), 'dir');

  await assert.rejects(
    (async () => {
      const ws = await createPacketWorkspaces({
        checkout: f.repo,
        packets: [{ paths: ['link/file.txt'] }, { paths: ['link/file.txt'] }],
      });
      try {
        await ws.cleanup();
      } catch {
        // Cleanup must not mask the rejection assertion below.
      }
      return ws;
    })(),
    /symlink/,
  );

  // Rejection happens before any launch, so the external bytes are untouched.
  assert.equal(readFileSync(join(external, 'file.txt'), 'utf8'), externalBytes);
});

test('wave packets: cleanup removes isolated roots, leaks no worktrees and preserves owner bytes', async (t) => {
  const f = fixture(t);
  const before = worktreeList(f.repo);
  const ws = await createPacketWorkspaces({
    checkout: f.repo,
    packets: [{ paths: ['shared.txt'] }, { paths: ['shared.txt'] }],
  });

  assert.equal(ws.isolated, true);
  const roots = [...ws.workspaces];
  for (const root of roots) {
    assert.equal(readFileSync(join(root, 'untracked.txt'), 'utf8'), 'untracked-owner-bytes\n');
  }

  await ws.cleanup();
  // Idempotent cleanup.
  await ws.cleanup();

  assert.equal(worktreeList(f.repo), before);
  for (const root of roots) {
    assert.throws(() => readFileSync(join(root, 'shared.txt'), 'utf8'));
  }

  // Owner dirty bytes in the checkout are preserved.
  assert.equal(readFileSync(join(f.repo, 'shared.txt'), 'utf8'), 'line-one\nsep-a\nsep-b\nsep-c\nline-two-owner-dirty\n');
  assert.equal(readFileSync(join(f.repo, 'untracked.txt'), 'utf8'), 'untracked-owner-bytes\n');
});

// The classified capability record the step-workspaces tests use for the valid
// unavailable-but-fallbackEligible case: backend selection falls back to a real
// linked git worktree instead of a kernel overlay mount.
function fallbackCapability() {
  const phase = (exitCode, stdout = '', stderr = '', signal = null) => ({ exitCode, signal, stdout, stderr });
  return interpretProbeResult({ collect: phase(1, '', 'bwrap: unrecognized option --overlay') });
}

const gitAt = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

test('wave packets: overlapping packets use the real step-4 git worktree backend', async (t) => {
  const f = fixture(t);
  const pkg = mkdtempSync(join(tmpdir(), 'wave-conformance-'));
  t.after(() => rmSync(pkg, { recursive: true, force: true }));
  const registryRoot = mkdtempSync(join(tmpdir(), 'wave-conformance-ownership-'));
  t.after(() => rmSync(registryRoot, { recursive: true, force: true }));
  const ownership = createOwnership({ registryRoot });
  // Self identity follows the step-workspaces coordinator fixture convention.
  const coordinator = { session: 'wave-workspaces-conformance', epoch: 1, pid: process.pid, started_at: 'fixture-start-conformance' };
  const record = { id: 'packet-conformance', package: pkg };
  const commonDir = realpathSync(join(f.repo, '.git'));
  const ownerHeadBefore = gitAt(f.repo, 'rev-parse', 'HEAD');
  const ownerIndexBefore = gitAt(f.repo, 'write-tree');
  const worktreesBefore = worktreeList(f.repo);
  const baselineClaims = (await ownership.inspectClaims()).claims;

  const ws = await createPacketWorkspaces({
    checkout: f.repo,
    packets: [{ paths: ['shared.txt'] }, { paths: ['shared.txt'] }],
    record,
    ownership,
    coordinator,
    mode: 'worktree',
    capability: fallbackCapability(),
    batch: 1,
  });

  try {
    assert.equal(ws.isolated, true);
    // A real snapshot commit of the dirty working tree, never the owner's HEAD.
    assert.match(ws.snapshot, /^[0-9a-f]{40}$/);
    assert.notEqual(ws.snapshot, ownerHeadBefore);

    // Every packet is a real step-4 worktree receipt with explicit metadata.
    assert.equal(ws.members.length, 2);
    assert.deepEqual(ws.members.map(member => member.k), [0, 1]);
    assert.notEqual(ws.members[0].checkout, ws.members[1].checkout);
    for (const member of ws.members) {
      assert.equal(member.kind, 'packet');
      assert.equal(member.backend, 'worktree');
      assert.equal(member.baseCommit, ws.snapshot);
      assert.notEqual(member.checkout, f.repo);
      // The workspace HEAD is the snapshot commit, and the workspace is a real
      // linked worktree sharing the owner's object store (one git common dir).
      assert.equal(gitAt(member.checkout, 'rev-parse', 'HEAD'), ws.snapshot);
      const memberCommon = realpathSync(resolve(member.checkout, gitAt(member.checkout, 'rev-parse', '--git-common-dir')));
      assert.equal(memberCommon, commonDir);
    }

    // Real per-packet ownership claims are held for the life of the batch.
    const heldClaims = (await ownership.inspectClaims()).claims;
    assert.equal(heldClaims.length, baselineClaims.length + 2);

    // Awaited cleanup is idempotent and releases every claim and worktree.
    await ws.cleanup();
    await ws.cleanup();

    assert.deepEqual((await ownership.inspectClaims()).claims, baselineClaims);
    assert.equal(worktreeList(f.repo), worktreesBefore);
    for (const member of ws.members) assert.equal(existsSync(member.checkout), false);

    // The snapshot never touched the owner's real index or HEAD.
    assert.equal(gitAt(f.repo, 'rev-parse', 'HEAD'), ownerHeadBefore);
    assert.equal(gitAt(f.repo, 'write-tree'), ownerIndexBefore);
  } finally {
    await ws.cleanup();
  }
});

// Drive the real `runEditorBatch` seam with a package fixture outside the checkout and a
// (see the AC23 edge cases pinned above for ignored artifacts, absent declared paths and
// unsafe ancestor symlinks).
// launchProcess double instead of a Pi child. Both packets declare `shared.txt`, so the
// batch must isolate them, seed each workspace from the dirty working tree and integrate in
// packet order. The double records the checkout it was handed and resolves `done` only after
// both launches, proving the two editors overlapped. In conflict mode packet 1 edits the same
// line differently and adds `other.txt`.
async function runPacketBatch(t, { conflict = false, failedSecond = false } = {}) {
  const f = fixture(t);
  const pkg = mkdtempSync(join(tmpdir(), 'wave-batch-'));
  t.after(() => rmSync(pkg, { recursive: true, force: true }));
  mkdirSync(join(pkg, 'runtime', 'runs'), { recursive: true });
  const ownership = createOwnership({ registryRoot: join(pkg, 'ownership') });
  const coordinator = { session: 'wave-batch-runtime', epoch: 1, pid: process.pid, started_at: 'fixture-start-batch' };
  const record = {
    id: 'packet-run',
    state: 'running',
    package: pkg,
    checkout: f.repo,
    primary: f.repo,
    step: join(pkg, 'step.md'),
    editor_session: join(pkg, 'sessions', 'editor.jsonl'),
    editor_model: 'fixture/model',
  };
  writeFileSync(join(pkg, 'runtime', 'runs', 'packet-run.json'), JSON.stringify(record));
  writeFileSync(join(pkg, 'runtime', 'run.json'), JSON.stringify(record));

  const pids = [-42131, -42132];
  const launches = [];
  const order = [];
  let openGate;
  const gate = new Promise(resolve => { openGate = resolve; });
  const launchProcess = (memberRecord, role) => {
    assert.equal(role, 'editor');
    const index = launches.length;
    const checkout = memberRecord.checkout;
    // Each packet must start from the owner's dirty tracked bytes and the untracked file,
    // never from HEAD, before it writes its own hunk.
    const seed = readFileSync(join(checkout, 'shared.txt'), 'utf8');
    const untracked = readFileSync(join(checkout, 'untracked.txt'), 'utf8');
    if (index === 0) {
      writeFileSync(join(checkout, 'shared.txt'), seed.replace('line-one', 'line-one-p0'));
    } else if (conflict) {
      writeFileSync(join(checkout, 'shared.txt'), seed.replace('line-one', 'line-one-packet-one'));
      writeFileSync(join(checkout, 'other.txt'), 'other-packet-one\n');
    } else if (failedSecond) {
      // The second editor writes its own hunks and then fails, so none of its
      // work may reach the owner checkout or the batch receipt.
      writeFileSync(join(checkout, 'shared.txt'), seed.replace('line-two-owner-dirty', 'line-two-owner-dirty-p1'));
      writeFileSync(join(checkout, 'other.txt'), 'other-packet-one\n');
    } else {
      writeFileSync(join(checkout, 'shared.txt'), seed.replace('line-two-owner-dirty', 'line-two-owner-dirty-p1'));
    }
    launches.push({ checkout, seed, untracked, pid: pids[index] });
    order.push(`launch-${index}`);
    if (launches.length === 2) openGate();
    const done = gate.then(() => {
      order.push(`finish-${index}`);
      if (failedSecond && index === 1) throw new Error('packet-editor-failed');
      return { stop_reason: 'stop', result: 'done' };
    });
    return { child: { pid: pids[index] }, done };
  };

  // A caller-supplied provider wraps the real manager so the batch's snapshot and
  // packet roots can be asserted: the runtime itself only sees the workspace API.
  let snapshot = null;
  let roots = [];
  let batchRoot = null;
  const workspaceProvider = async options => {
    const ws = await createPacketWorkspaces(options);
    snapshot = ws.snapshot;
    roots = [...ws.workspaces];
    // The manager lays each member out at waveRoot/attempts/<attemptId>/<backend dir>.
    batchRoot = ws.members.length > 0 ? dirname(dirname(dirname(ws.members[0].checkout))) : null;
    return ws;
  };

  const reply = await runEditorBatch(record, [
    { assignment: 'Edit packet zero', paths: ['shared.txt'] },
    { assignment: 'Edit packet one', paths: conflict ? ['shared.txt', 'other.txt'] : ['shared.txt'] },
  ], undefined, launchProcess, { workspaceProvider, ownership, coordinator });
  return { f, record, ownership, snapshot, roots, batchRoot, launches, order, reply };
}

test('wave packets: runtime batches overlap concurrently and integrate in packet order', async (t) => {
  const { f, record, launches, order, reply } = await runPacketBatch(t);

  // Both editors were launched before either one finished.
  assert.deepEqual(order.slice(0, 2), ['launch-0', 'launch-1']);
  assert.ok(order.includes('finish-0') && order.includes('finish-1'));

  // Each packet ran in its own workspace, seeded from the dirty working tree plus the
  // untracked owner source.
  assert.notEqual(launches[0].checkout, launches[1].checkout);
  for (const launch of launches) {
    assert.equal(launch.seed, 'line-one\nsep-a\nsep-b\nsep-c\nline-two-owner-dirty\n');
    assert.equal(launch.untracked, 'untracked-owner-bytes\n');
  }

  // Integration happens in packet order and reports applied for each packet.
  assert.equal(reply.results.length, 2);
  assert.equal(reply.results[0].integration.status, 'applied');
  assert.equal(reply.results[1].integration.status, 'applied');

  // Neither packet's edit is lost in the owner checkout.
  assert.equal(readFileSync(join(f.repo, 'shared.txt'), 'utf8'), 'line-one-p0\nsep-a\nsep-b\nsep-c\nline-two-owner-dirty-p1\n');

  // No isolated workspace root or editor slot outlives the batch.
  for (const launch of launches) assert.equal(existsSync(launch.checkout), false);
  assert.equal(existsSync(join(record.package, 'runtime', 'runs', 'packet-run-editor-slot')), false);
});

test('wave packets: a conflicting runtime batch packet applies nothing and returns its patch', async (t) => {
  const { f, record, snapshot, launches, reply } = await runPacketBatch(t, { conflict: true });

  assert.equal(reply.results[0].integration.status, 'applied');
  assert.equal(reply.results[1].integration.status, 'conflict');
  assert.ok(Array.isArray(reply.results[1].integration.conflicting_paths));
  assert.ok(reply.results[1].integration.conflicting_paths.includes('shared.txt'));
  assert.equal(typeof reply.results[1].integration.patch, 'string');
  assert.match(reply.results[1].integration.patch, /packet-one/);

  // The owner can inspect the persisted patch, which carries both the conflicting
  // shared hunk and the packet's other-file hunk.
  const patchPath = reply.results[1].patch_path;
  assert.equal(typeof patchPath, 'string');
  assert.equal(existsSync(patchPath), true);
  const patchBytes = readFileSync(patchPath, 'utf8');
  assert.match(patchBytes, /shared\.txt/);
  assert.match(patchBytes, /other\.txt/);

  // The persisted patch applies cleanly onto a disposable worktree created at the
  // exact captured snapshot, so it is the packet's real base-to-tip change.
  const scratch = mkdtempSync(join(tmpdir(), 'wave-patch-apply-'));
  t.after(() => {
    try { execFileSync('git', ['-C', f.repo, 'worktree', 'remove', '--force', scratch], { stdio: 'pipe' }); } catch { /* teardown is best effort */ }
    rmSync(scratch, { recursive: true, force: true });
  });
  execFileSync('git', ['-C', f.repo, 'worktree', 'add', '--detach', scratch, snapshot], { encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['-C', scratch, 'apply', '--check', patchPath], { encoding: 'utf8', stdio: 'pipe' });

  // The conflicted packet is applied atomically: its non-conflicting edit never lands.
  assert.equal(readFileSync(join(f.repo, 'other.txt'), 'utf8'), 'other-base\n');

  for (const launch of launches) assert.equal(existsSync(launch.checkout), false);
  assert.equal(existsSync(join(record.package, 'runtime', 'runs', 'packet-run-editor-slot')), false);
});

test('wave packets: a failed editor packet is never integrated and leaks no workspace', async (t) => {
  const { f, record, ownership, roots, batchRoot, launches, reply } = await runPacketBatch(t, { failedSecond: true });

  // Packet 0 still applies; the failed packet is recorded as not-run with its error.
  assert.equal(reply.results[0].integration.status, 'applied');
  assert.equal(reply.results[1].integration.status, 'not-run');
  assert.ok(reply.results[1].error, 'the failed packet reports its error');
  assert.match(String(reply.results[1].error), /packet-editor-failed/);

  // Neither of the failed packet's two writes reached the owner checkout.
  assert.equal(readFileSync(join(f.repo, 'shared.txt'), 'utf8'), 'line-one-p0\nsep-a\nsep-b\nsep-c\nline-two-owner-dirty\n');
  assert.equal(readFileSync(join(f.repo, 'other.txt'), 'utf8'), 'other-base\n');

  // No isolated workspace root or editor slot outlives the failed batch.
  for (const launch of launches) assert.equal(existsSync(launch.checkout), false);
  assert.equal(existsSync(join(record.package, 'runtime', 'runs', 'packet-run-editor-slot')), false);

  // The failed batch releases every ownership attempt and removes its whole batch
  // root, so no claim or layer survives for a later recovery to trip over.
  const claims = (await ownership.inspectClaims()).claims;
  assert.equal(claims.some(claim => typeof claim.attempt === 'string' && claim.attempt.startsWith(`${record.id}:batch-`)), false);
  for (const root of roots) assert.equal(existsSync(root), false);
  assert.equal(typeof batchRoot, 'string');
  assert.equal(existsSync(batchRoot), false);
});

// AC23: a 20-line `f.mjs` whose line 10 carries an uncommitted owner edit. The
// fenced-editor tests write lines 3, 9 and 15 from independent packet workspaces.
function fencedFixture(t) {
  const repo = mkdtempSync(join(tmpdir(), 'wave-fenced-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Wave Packets');
  git('config', 'user.email', 'wave-packets@example.invalid');
  const baseLines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
  writeFileSync(join(repo, 'f.mjs'), `${baseLines.join('\n')}\n`);
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const dirtyLines = [...baseLines];
  dirtyLines[9] = 'line-10-owner-dirty';
  writeFileSync(join(repo, 'f.mjs'), `${dirtyLines.join('\n')}\n`);
  return { repo, git, base };
}

// A valid, fully supported overlay classification in the exact shape overlay.test.mjs
// uses, so `mode: 'overlayfs'` selects the overlay backend instead of falling back.
function overlayCapability() {
  const options = 'rw,nosuid,nodev,redirect_dir=nofollow,uuid=on,userxattr';
  const phase = (exitCode, stdout = '', stderr = '') => ({ exitCode, signal: null, stdout, stderr });
  return interpretProbeResult({
    collect: phase(0, JSON.stringify({ fstype: 'overlay', options, copyUp: true, deletion: true })),
    verify: phase(0, JSON.stringify({ fstype: 'overlay', options, retainedWrite: true, retainedDeletion: true })),
  });
}

function readEvents(record) {
  const file = join(record.package, 'runtime', 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line));
}

function namedEvent(record, name) {
  return readEvents(record).filter(entry => (entry.name ?? entry.event) === name).at(-1) ?? null;
}

// A run record plus the run files Runtime reads, matching the runPacketBatch fixture.
function packetRecord(t, pkg, id, repo) {
  mkdirSync(join(pkg, 'runtime', 'runs'), { recursive: true });
  const record = {
    id,
    state: 'running',
    package: pkg,
    checkout: repo,
    primary: repo,
    step: join(pkg, 'step.md'),
    editor_session: join(pkg, 'sessions', 'editor.jsonl'),
    editor_model: 'fixture/model',
  };
  writeFileSync(join(pkg, 'runtime', 'runs', `${id}.json`), JSON.stringify(record));
  writeFileSync(join(pkg, 'runtime', 'run.json'), JSON.stringify(record));
  return record;
}

test('wave packets: fenced editors integrate every edit regardless of finishing order', async (t) => {
  for (const finishOrder of [[2, 1, 0], [0, 1, 2]]) {
    const f = fencedFixture(t);
    const pkg = mkdtempSync(join(tmpdir(), 'wave-fenced-batch-'));
    t.after(() => rmSync(pkg, { recursive: true, force: true }));
    const record = packetRecord(t, pkg, `fenced-${finishOrder.join('')}`, f.repo);
    const ownerHead = f.git('rev-parse', 'HEAD');
    const ownerTree = f.git('write-tree');

    const launches = [];
    const finishes = [];
    const resolvers = [];
    let openGate;
    const allLaunched = new Promise(resolve => { openGate = resolve; });
    const launchProcess = (memberRecord, role) => {
      assert.equal(role, 'editor');
      const index = launches.length;
      const checkout = memberRecord.checkout;
      const seed = readFileSync(join(checkout, 'f.mjs'), 'utf8');
      const lines = seed.split('\n');
      const lineIndex = [2, 8, 14][index];
      lines[lineIndex] = `line-${lineIndex + 1}-editor-${index + 1}`;
      writeFileSync(join(checkout, 'f.mjs'), lines.join('\n'));
      launches.push({ checkout, seed });
      if (launches.length === 3) openGate();
      const done = allLaunched
        .then(() => new Promise(resolve => { resolvers[index] = resolve; }))
        .then(() => {
          finishes.push(index);
          return { stop_reason: 'stop', result: 'done' };
        });
      return { child: { pid: -61000 - index }, done };
    };

    const releases = (async () => {
      await allLaunched;
      for (const index of finishOrder) {
        await new Promise(resolve => setTimeout(resolve, 5));
        resolvers[index]();
      }
    })();
    const reply = await runEditorBatch(record, [
      { assignment: 'Edit line 3', paths: ['f.mjs'] },
      { assignment: 'Edit line 9', paths: ['f.mjs'] },
      { assignment: 'Edit line 15', paths: ['f.mjs'] },
    ], undefined, launchProcess);
    await releases;

    // The editors overlapped and finished in the requested order, yet packet order
    // alone decides integration: identical bytes for both finishing orders.
    assert.deepEqual(finishes, finishOrder);
    assert.notEqual(launches[0].checkout, launches[1].checkout);
    assert.notEqual(launches[1].checkout, launches[2].checkout);
    const expectedLines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
    expectedLines[2] = 'line-3-editor-1';
    expectedLines[8] = 'line-9-editor-2';
    expectedLines[9] = 'line-10-owner-dirty';
    expectedLines[14] = 'line-15-editor-3';
    assert.equal(readFileSync(join(f.repo, 'f.mjs'), 'utf8'), `${expectedLines.join('\n')}\n`);

    // The dirty owner line 10 survives and the owner's real index and HEAD never move.
    assert.equal(f.git('rev-parse', 'HEAD'), ownerHead);
    assert.equal(f.git('write-tree'), ownerTree);

    assert.deepEqual(reply.results.map(item => item.integration.status), ['applied', 'applied', 'applied']);
    const finished = namedEvent(record, 'editor_batch_finished');
    assert.ok(finished, 'the batch records its finished event');
    assert.equal(finished.packets, 3);
    assert.deepEqual(finished.integrated, ['applied', 'applied', 'applied']);
    assert.deepEqual(finished.integrated_packets, [1, 2, 3]);
  }
});

test('wave packets: disjoint runtime packets share the checkout without a provider snapshot', async (t) => {
  const f = fixture(t);
  const pkg = mkdtempSync(join(tmpdir(), 'wave-disjoint-batch-'));
  t.after(() => rmSync(pkg, { recursive: true, force: true }));
  const record = packetRecord(t, pkg, 'disjoint-run', f.repo);
  const ownerHead = gitAt(f.repo, 'rev-parse', 'HEAD');
  const reachableBefore = gitAt(f.repo, 'rev-list', '--all', '--count');

  const launches = [];
  let openGate;
  const gate = new Promise(resolve => { openGate = resolve; });
  const launchProcess = (memberRecord, role) => {
    assert.equal(role, 'editor');
    const index = launches.length;
    const checkout = memberRecord.checkout;
    const target = index === 0 ? 'shared.txt' : 'other.txt';
    writeFileSync(join(checkout, target), index === 0 ? 'shared-disjoint\n' : 'other-disjoint\n');
    launches.push({ checkout, target });
    if (launches.length === 2) openGate();
    return { child: { pid: -62000 - index }, done: gate.then(() => ({ stop_reason: 'stop', result: 'done' })) };
  };

  // The settled fifth options object: a workspace provider supplied by the caller
  // must never run for a disjoint batch because both packets share one checkout.
  let providerCalls = 0;
  const workspaceProvider = () => {
    providerCalls += 1;
    throw new Error('workspaceProvider must not run for disjoint packets');
  };

  const reply = await runEditorBatch(record, [
    { assignment: 'Edit shared', paths: ['shared.txt'] },
    { assignment: 'Edit other', paths: ['other.txt'] },
  ], undefined, launchProcess, { workspaceProvider });

  assert.equal(reply.mode, 'shared');
  assert.equal(providerCalls, 0);
  assert.equal(launches.length, 2);
  assert.equal(launches[0].checkout, f.repo);
  assert.equal(launches[1].checkout, f.repo);

  const started = namedEvent(record, 'editor_batch_started');
  assert.equal(started.mode, 'shared');
  const finished = namedEvent(record, 'editor_batch_finished');
  assert.equal(finished.mode, 'shared');

  // No per-packet snapshot commit becomes reachable and the owner's history is fixed.
  assert.equal(gitAt(f.repo, 'rev-parse', 'HEAD'), ownerHead);
  assert.equal(gitAt(f.repo, 'rev-list', '--all', '--count'), reachableBefore);
  assert.equal(readFileSync(join(f.repo, 'shared.txt'), 'utf8'), 'shared-disjoint\n');
  assert.equal(readFileSync(join(f.repo, 'other.txt'), 'utf8'), 'other-disjoint\n');
});

test('wave packets: overlay cleanup withholds claims and roots until a positive drain confirms', async (t) => {
  const f = fixture(t);
  const pkg = mkdtempSync(join(tmpdir(), 'wave-overlay-batch-'));
  t.after(() => rmSync(pkg, { recursive: true, force: true }));
  const registryRoot = mkdtempSync(join(tmpdir(), 'wave-overlay-ownership-'));
  t.after(() => rmSync(registryRoot, { recursive: true, force: true }));
  const ownership = createOwnership({ registryRoot });
  const coordinator = { session: 'wave-overlay-cleanup', epoch: 1, pid: process.pid, started_at: 'fixture-start-overlay' };
  const capability = overlayCapability();
  assert.equal(capability.status, 'supported');

  // Test substitute only: no kernel overlay is mounted. `mount` copies the frozen
  // lower into the merged layer so the member is usable, and `drain` cannot confirm
  // the first time, exercising the withheld-claim cleanup path.
  const mounts = [];
  let drainCalls = 0;
  const mountTransport = {
    mount(member) {
      mounts.push(member);
      cpSync(member.lower, member.merged, { recursive: true });
      return { status: 'mounted' };
    },
    drain() {
      drainCalls += 1;
      if (drainCalls === 1) return { status: 'unknown' };
      return { status: 'confirmed' };
    },
  };

  const baseline = (await ownership.inspectClaims()).claims;
  const ws = await createPacketWorkspaces({
    checkout: f.repo,
    packets: [{ paths: ['shared.txt'] }, { paths: ['shared.txt'] }],
    record: { id: 'overlay-cleanup', package: pkg },
    ownership,
    coordinator,
    mode: 'overlayfs',
    capability,
    batch: 1,
    mountTransport,
  });
  try {
    assert.equal(ws.isolated, true);
    assert.equal(ws.members.length, 2);
    for (const member of ws.members) assert.equal(member.backend, 'overlayfs');
    // Exactly one mount per member, and each merged layer holds the seeded bytes.
    assert.equal(mounts.length, ws.members.length);
    assert.deepEqual(mounts.map(member => member.k), ws.members.map(member => member.k));
    for (const member of ws.members) {
      assert.equal(readFileSync(join(member.merged, 'shared.txt'), 'utf8'), 'line-one\nsep-a\nsep-b\nsep-c\nline-two-owner-dirty\n');
    }
    assert.equal((await ownership.inspectClaims()).claims.length, baseline.length + ws.members.length);

    // An unconfirmed drain is not a release: the claim and root are retained.
    await assert.rejects(ws.cleanup(), /drain|unknown/i);
    assert.equal((await ownership.inspectClaims()).claims.length, baseline.length + ws.members.length);
    for (const member of ws.members) assert.equal(existsSync(member.merged), true);
    assert.equal(mounts.length, ws.members.length);

    // The retry drains every mounted member, releases every claim, removes the
    // roots, and never mounts a member a second time.
    await ws.cleanup();
    assert.deepEqual((await ownership.inspectClaims()).claims, baseline);
    assert.ok(drainCalls >= ws.members.length + 1, `retry drains every member (saw ${drainCalls})`);
    for (const member of ws.members) assert.equal(existsSync(member.merged), false);
    assert.equal(mounts.length, ws.members.length);
  } finally {
    try { await ws.cleanup(); } catch { /* keep the assertions above as the failure */ }
  }
});

test('wave packets: a token-mismatch release denial is not proof the claim is absent', async (t) => {
  const f = fixture(t);
  const pkg = mkdtempSync(join(tmpdir(), 'wave-token-batch-'));
  t.after(() => rmSync(pkg, { recursive: true, force: true }));
  const registryRoot = mkdtempSync(join(tmpdir(), 'wave-token-ownership-'));
  t.after(() => rmSync(registryRoot, { recursive: true, force: true }));
  const realOwnership = createOwnership({ registryRoot });
  const coordinator = { session: 'wave-token-cleanup', epoch: 1, pid: process.pid, started_at: 'fixture-start-token' };

  // The first release is denied with token-mismatch while the real registry still
  // holds the claim; every other ownership call delegates to the real registry.
  let releaseCalls = 0;
  const ownership = Object.create(realOwnership);
  ownership.releaseClaim = async args => {
    releaseCalls += 1;
    if (releaseCalls === 1) return { status: 'denied', reason: 'token-mismatch' };
    return realOwnership.releaseClaim(args);
  };
  ownership.inspectClaims = (...args) => realOwnership.inspectClaims(...args);

  const baseline = (await realOwnership.inspectClaims()).claims;
  const ws = await createPacketWorkspaces({
    checkout: f.repo,
    packets: [{ paths: ['shared.txt'] }, { paths: ['shared.txt'] }],
    record: { id: 'token-cleanup', package: pkg },
    ownership,
    coordinator,
    mode: 'worktree',
    capability: fallbackCapability(),
    batch: 1,
  });
  const roots = ws.members.map(member => member.checkout);
  try {
    assert.equal(ws.isolated, true);
    assert.equal((await realOwnership.inspectClaims()).claims.length, baseline.length + roots.length);

    // token-mismatch never proves absence: the first workspace is removed before
    // its release is denied, so its claim and remaining root survive the refused
    // cleanup.
    await assert.rejects(ws.cleanup(), /token|claim|release/i);
    assert.equal((await realOwnership.inspectClaims()).claims.length, baseline.length + roots.length);
    assert.equal(existsSync(roots[0]), false);
    assert.equal(existsSync(roots[1]), true);

    // Restoring the real release lets the retry remove roots and release claims.
    ownership.releaseClaim = (...args) => realOwnership.releaseClaim(...args);
    await ws.cleanup();
    assert.deepEqual((await realOwnership.inspectClaims()).claims, baseline);
    for (const root of roots) assert.equal(existsSync(root), false);
  } finally {
    ownership.releaseClaim = (...args) => realOwnership.releaseClaim(...args);
    try { await ws.cleanup(); } catch { /* keep the assertions above as the failure */ }
  }
});

test('wave packets: failed workspace removal retains its claim for cleanup retry', async (t) => {
  const f = fixture(t);
  const pkg = mkdtempSync(join(tmpdir(), 'wave-remove-fail-batch-'));
  t.after(() => rmSync(pkg, { recursive: true, force: true }));
  const registryRoot = mkdtempSync(join(tmpdir(), 'wave-remove-fail-ownership-'));
  t.after(() => rmSync(registryRoot, { recursive: true, force: true }));
  // A real directory that is not a registered git worktree: removal fails, but
  // claim release must not run, so the claim survives for a cleanup retry.
  const notAWorktree = mkdtempSync(join(f.repo, '..', 'wave-remove-fail-dir-'));
  t.after(() => rmSync(notAWorktree, { recursive: true, force: true }));

  const realOwnership = createOwnership({ registryRoot });
  const coordinator = { session: 'wave-remove-fail-cleanup', epoch: 1, pid: process.pid, started_at: 'fixture-start-remove-fail' };
  const ownership = Object.create(realOwnership);
  ownership.inspectClaims = (...args) => realOwnership.inspectClaims(...args);

  const baseline = (await realOwnership.inspectClaims()).claims;
  const ws = await createPacketWorkspaces({
    checkout: f.repo,
    packets: [{ paths: ['shared.txt'] }, { paths: ['shared.txt'] }],
    record: { id: 'remove-fail-cleanup', package: pkg },
    ownership,
    coordinator,
    mode: 'worktree',
    capability: fallbackCapability(),
    batch: 1,
  });
  const roots = ws.members.map(member => member.checkout);
  const token = ws.members[0].claim.token;
  try {
    assert.equal(ws.isolated, true);
    assert.equal((await realOwnership.inspectClaims()).claims.length, baseline.length + roots.length);

    // A member still points at its registered worktree token, but the first
    // member's checkout is replaced by an ordinary directory. `git worktree
    // remove` then fails; the denied removal must not release the claim whose
    // token the real registry still holds. ws.members is frozen, so drive the
    // release with an explicit member list rather than mutating it.
    await assert.rejects(
      releasePacketWorkspaces({
        record: { checkout: f.repo },
        members: [{ ...ws.members[0], checkout: notAWorktree }, ...ws.members.slice(1)],
        ownership,
      }),
      /remove|worktree|clean/i,
    );
    const claims = (await realOwnership.inspectClaims()).claims;
    assert.equal(claims.length, baseline.length + roots.length);
    assert.ok(claims.some(claim => claim.token === token));
    for (const root of roots) assert.equal(existsSync(root), true);
    assert.equal(existsSync(pkg), true);

    await ws.cleanup();
    assert.deepEqual((await realOwnership.inspectClaims()).claims, baseline);
    for (const root of roots) assert.equal(existsSync(root), false);
  } finally {
    try { await ws.cleanup(); } catch { /* keep the assertions above as the failure */ }
  }
});

test('wave packets: failed overlay provisioning retains resources until confirmed drain', async (t) => {
  const f = fixture(t);
  const pkg = mkdtempSync(join(tmpdir(), 'wave-overlay-fail-'));
  t.after(() => rmSync(pkg, { recursive: true, force: true }));
  const registryRoot = mkdtempSync(join(tmpdir(), 'wave-overlay-fail-ownership-'));
  t.after(() => rmSync(registryRoot, { recursive: true, force: true }));
  const ownership = createOwnership({ registryRoot });
  const coordinator = { session: 'wave-overlay-fail', epoch: 1, pid: process.pid, started_at: 'fixture-start-overlay-fail' };
  const capability = overlayCapability();
  assert.equal(capability.status, 'supported');

  // The real mount is refused after the member is recorded, and the first drain
  // cannot confirm, so the failed provision may not release the retained claim.
  const mounts = [];
  let drainCalls = 0;
  const mountTransport = {
    mount(member) {
      mounts.push(member);
      throw new Error('overlay-mount-failed');
    },
    drain() {
      drainCalls += 1;
      return drainCalls === 1 ? { status: 'unknown' } : { status: 'confirmed' };
    },
  };

  const baseline = (await ownership.inspectClaims()).claims;
  const record = { id: 'overlay-fail', package: pkg };
  let rejected = null;
  try {
    await createPacketWorkspaces({
      checkout: f.repo,
      packets: [{ paths: ['shared.txt'] }, { paths: ['shared.txt'] }],
      record,
      ownership,
      coordinator,
      mode: 'overlayfs',
      capability,
      batch: 1,
      mountTransport,
    });
    assert.fail('a refused overlay mount must reject packet provisioning');
  } catch (error) {
    rejected = error;
  }

  try {
    // The first member was recorded before the mount refusal, so the failure
    // carries the retained member and its batch root and the exact claim stays held.
    assert.match(String(rejected.message), /overlay-mount-failed/);
    assert.ok(Array.isArray(rejected.retainedMembers), 'the failure retains its members');
    assert.equal(rejected.retainedMembers.length, 1);
    assert.equal(typeof rejected.retainedRoot, 'string');
    assert.equal(existsSync(rejected.retainedRoot), true);
    const retained = rejected.retainedMembers[0];
    assert.equal(existsSync(retained.upper), true);
    const held = (await ownership.inspectClaims()).claims;
    assert.equal(held.length, baseline.length + 1);
    assert.ok(held.some(claim => claim.token === retained.claim.token), 'the exact claim remains held');
  } finally {
    // Only a positive drain may release the retained claim and remove its root.
    await releasePacketWorkspaces({ record, members: rejected?.retainedMembers ?? [], ownership, mountTransport });
  }

  assert.deepEqual((await ownership.inspectClaims()).claims, baseline);
  assert.equal(existsSync(rejected.retainedMembers[0].upper), false);
  assert.equal(mounts.length, 1);
});
