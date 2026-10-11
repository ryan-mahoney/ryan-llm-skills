// Step 5 counterexamples: operator holds/directions must reach the real
// exported `readInboxGuard` while the coordinator checkpoint stays untouched.
// Production delivery is imported directly; guard behavior is the contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { INBOX_FILE_BYTES, readInboxGuard, recordCheckpoint } from '../../pi/extensions/spec-runtime/sentinel.mjs';
import { deliverOverseerMessage } from './overseer-inbox.mjs';
import { makeFixture } from '../spec-location/fixture.mjs';
import { newPackage } from '../spec-location/index.mjs';

const FIXED = Date.parse('2026-10-06T12:00:00.000Z');
const sha = value => createHash('sha256').update(value).digest('hex');

// Disposable storage root with a real spec-location package and existing
// inbox/processed mailboxes.
async function canonicalFixture(t) {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const packagePath = (await newPackage({ workspace: 'demo', slug: 'feature', targets: [{ id: 'alpha' }], ...fx.options })).locations.package_dir;
  mkdirSync(join(packagePath, 'inbox'), { recursive: true });
  mkdirSync(join(packagePath, 'processed'), { recursive: true });
  return { base: fx.tmp, repo: fx.alpha, packagePath };
}

// Real implementation-stage checkpoint matching the owning fixture contract.
function checkpointInput(packagePath) {
  return {
    package: packagePath,
    workflow_id: 'wf-1',
    expected_revision: 0,
    state: 'ready',
    obligation: { key: 'implement:step-005', stage: 'implementation', step: 'step-005',
      summary: 'deliver overseer messages', artifacts: [] },
    workers: [],
    inbox: { items: [] },
    reconciles_input_revision: 0,
    coordinator_session: 'session-1',
    checkout: '/tmp/checkout-1',
    now: () => FIXED,
  };
}

test('overseer delivery: a hold original reaches the real guard and leaves the checkpoint untouched', async t => {
  const { packagePath } = await canonicalFixture(t);

  // Initial empty mailbox is nonblocking.
  const initial = readInboxGuard(packagePath);
  assert.equal(initial.blocking, false, 'an empty mailbox is nonblocking');

  // Persist a real implementation-stage checkpoint before delivery.
  recordCheckpoint(checkpointInput(packagePath));
  const checkpointPath = join(packagePath, 'runtime', 'sentinel', 'wf-1', 'checkpoint.json');
  const before = { bytes: readFileSync(checkpointPath), mtimeMs: statSync(checkpointPath).mtimeMs };

  // Deliver through the production owner; the real guard assertion below is
  // the required behavioral contract.
  const delivered = await deliverOverseerMessage(packagePath, {
    run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'hold', body: 'Stop dependent work.',
  });

  // The real guard must block on the delivered hold original.
  const guard = readInboxGuard(packagePath);
  assert.equal(guard.blocking, true, 'the delivered hold blocks the real guard');
  const hold = guard.items.find(item => item.kind === 'hold');
  assert.ok(hold, 'the real guard contains the delivered hold');
  assert.ok(['inbox', 'processed'].includes(hold.directory), `hold directory: ${hold.directory}`);
  if (delivered !== null) {
    assert.equal(delivered.id, hold.id, 'delivered id agrees with the guard original');
    assert.equal(delivered.sha256, hold.sha256, 'delivered hash agrees with the guard original');
    assert.ok(String(delivered.path).endsWith(`${hold.id}.md`), `delivered path: ${delivered.path}`);
  assert.equal(join(packagePath, hold.path), delivered.path,
    'guard original path agrees with the delivered path');
  }

  // Delivery never rewrites the coordinator checkpoint.
  const after = { bytes: readFileSync(checkpointPath), mtimeMs: statSync(checkpointPath).mtimeMs };
  assert.deepEqual(after.bytes, before.bytes, 'checkpoint bytes are unchanged');
  assert.equal(sha(after.bytes), sha(before.bytes), 'checkpoint hash is unchanged');
  assert.equal(after.mtimeMs, before.mtimeMs, 'checkpoint mtime is unchanged');
});

const checkpointPathOf = packagePath => join(packagePath, 'runtime', 'sentinel', 'wf-1', 'checkpoint.json');

function inventoryOf(packagePath) {
  const list = dir => existsSync(join(packagePath, dir))
    ? readdirSync(join(packagePath, dir)).sort() : null;
  return { inbox: list('inbox'), processed: list('processed') };
}

function checkpointDigest(packagePath) {
  const file = checkpointPathOf(packagePath);
  if (!existsSync(file)) return null;
  return { hash: sha(readFileSync(file)), mtimeMs: statSync(file).mtimeMs };
}

test('overseer delivery: archived hold protocol releases only on bound outcomes and never rewrites originals', async t => {
  const { packagePath } = await canonicalFixture(t);
  recordCheckpoint(checkpointInput(packagePath));
  const delivered = await deliverOverseerMessage(packagePath, {
    run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'hold', body: 'Stop dependent work.',
  });
  assert.equal(delivered.status, 'delivered');
  const originalBytes = readFileSync(delivered.path);
  const originalHash = sha(originalBytes);
  const originalSize = statSync(delivered.path).size;
  const originalMtimeMs = statSync(delivered.path).mtimeMs;

  // Test-only coordinator archive move; the original bytes survive.
  const archived = join(packagePath, 'processed', `${delivered.id}.md`);
  renameSync(delivered.path, archived);
  assert.equal(sha(readFileSync(archived)), originalHash);
  const held = readInboxGuard(packagePath);
  assert.equal(held.blocking, true);
  assert.equal(held.items.find(item => item.id === delivered.id).state, 'held');

  const direction = await deliverOverseerMessage(packagePath, {
    run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'direction',
    body: `Release the hold ${delivered.id}.`,
  });
  assert.equal(direction.status, 'delivered');
  const directionArchive = join(packagePath, 'processed', `${direction.id}.md`);
  renameSync(direction.path, directionArchive);
  const directionHash = sha(readFileSync(directionArchive));

  // Direction alone, even applied with the exact hash, cannot release the hold.
  const directionAlone = readInboxGuard(packagePath, { items: [
    { id: direction.id, sha256: directionHash, outcome: 'applied' },
  ] });
  assert.equal(directionAlone.items.find(item => item.id === delivered.id).state, 'held');
  assert.equal(directionAlone.blocking, true);

  // Supplying the hold item without a release reference still does not release.
  const noRelease = readInboxGuard(packagePath, { items: [
    { id: delivered.id, sha256: originalHash, outcome: 'applied' },
    { id: direction.id, sha256: directionHash, outcome: 'applied' },
  ] });
  assert.equal(noRelease.items.find(item => item.id === delivered.id).state, 'held');

  // Both outcomes applied with exact hashes plus release_source_id release it.
  const released = readInboxGuard(packagePath, { items: [
    { id: delivered.id, sha256: originalHash, outcome: 'applied', release_source_id: direction.id },
    { id: direction.id, sha256: directionHash, outcome: 'applied' },
  ] });
  assert.equal(released.items.find(item => item.id === delivered.id).state, 'released');

  // A wrong direction hash never releases.
  const wrong = readInboxGuard(packagePath, { items: [
    { id: delivered.id, sha256: originalHash, outcome: 'applied', release_source_id: direction.id },
    { id: direction.id, sha256: sha('not-the-direction'), outcome: 'applied' },
  ] });
  assert.equal(wrong.items.find(item => item.id === delivered.id).state, 'held');
  assert.equal(wrong.blocking, true);

  // The writer manufactured no checkpoint outcomes and never rewrote originals.
  assert.equal(JSON.parse(readFileSync(checkpointPathOf(packagePath), 'utf8')).inbox.items.length, 0);
  assert.equal(sha(readFileSync(archived)), originalHash);
  assert.equal(statSync(archived).size, originalSize);
  assert.equal(statSync(archived).mtimeMs, originalMtimeMs, 'archived original mtime is unchanged');
});

function retainedCheckpoint(packagePath) {
  recordCheckpoint(checkpointInput(packagePath));
  return JSON.parse(readFileSync(checkpointPathOf(packagePath), 'utf8'));
}

test('overseer delivery: refusals leave mailboxes and checkpoint untouched', async t => {
  const baseInput = { run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'hold', body: 'Stop.' };
  const cases = [
    ['missing inbox', async ({ packagePath }) => {
      recordCheckpoint(checkpointInput(packagePath));
      rmSync(join(packagePath, 'inbox'), { recursive: true, force: true });
    }, /inbox and processed must already exist/],
    ['missing processed', async ({ packagePath }) => {
      recordCheckpoint(checkpointInput(packagePath));
      rmSync(join(packagePath, 'processed'), { recursive: true, force: true });
    }, /inbox and processed must already exist/],
    ['symlinked inbox', async ({ packagePath, base }) => {
      recordCheckpoint(checkpointInput(packagePath));
      const outside = join(base, 'outside-inbox');
      mkdirSync(outside);
      rmSync(join(packagePath, 'inbox'), { recursive: true, force: true });
      symlinkSync(outside, join(packagePath, 'inbox'));
    }, /must not be a symlink/],
    ['symlinked declared package', async ({ packagePath, base }) => {
      recordCheckpoint(checkpointInput(packagePath));
      const link = join(base, 'package-link');
      symlinkSync(packagePath, link);
      return link;
    }, /physical canonical package/],
    ['linked worktree package', async ({ repo, base }) => {
      const worktree = join(base, 'linked-worktree');
      execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Initial fixture'], { stdio: 'pipe' });
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', worktree], { stdio: 'pipe' });
      const target = join(worktree, '.specs', 'feature');
      mkdirSync(join(target, 'inbox'), { recursive: true });
      mkdirSync(join(target, 'processed'), { recursive: true });
      return target;
    }, /primary|worktree|physical canonical/],
    ['wrong checkpoint package', async ({ packagePath }) => {
      const retained = retainedCheckpoint(packagePath);
      retained.package = join(packagePath, 'other');
      writeFileSync(checkpointPathOf(packagePath), JSON.stringify(retained));
    }, /no retained checkpoint/],
    ['wrong checkpoint workflow', async ({ packagePath }) => {
      const retained = retainedCheckpoint(packagePath);
      retained.workflow_id = 'wf-2';
      writeFileSync(checkpointPathOf(packagePath), JSON.stringify(retained));
    }, /no retained checkpoint/],
    ['nonexistent run', async () => {}, /no retained checkpoint/, 'wf-404'],
    ['planning stage', async ({ packagePath }) => {
      const retained = retainedCheckpoint(packagePath);
      retained.obligation.stage = 'planning';
      writeFileSync(checkpointPathOf(packagePath), JSON.stringify(retained));
    }, /stage must be implementation or review/],
    ['completed stage', async ({ packagePath }) => {
      const retained = retainedCheckpoint(packagePath);
      retained.obligation.stage = 'completed';
      writeFileSync(checkpointPathOf(packagePath), JSON.stringify(retained));
    }, /stage must be implementation or review/],
    ['unknown stage', async ({ packagePath }) => {
      const retained = retainedCheckpoint(packagePath);
      retained.obligation.stage = 'unknown';
      writeFileSync(checkpointPathOf(packagePath), JSON.stringify(retained));
    }, /stage must be implementation or review/],
    ['absent stage', async ({ packagePath }) => {
      const retained = retainedCheckpoint(packagePath);
      delete retained.obligation;
      writeFileSync(checkpointPathOf(packagePath), JSON.stringify(retained));
    }, /stage must be implementation or review/],
    ['completed state', async ({ packagePath }) => {
      const retained = retainedCheckpoint(packagePath);
      retained.state = 'completed';
      writeFileSync(checkpointPathOf(packagePath), JSON.stringify(retained));
    }, /checkpoint is complete/],
    ['complete state', async ({ packagePath }) => {
      const retained = retainedCheckpoint(packagePath);
      retained.state = 'complete';
      writeFileSync(checkpointPathOf(packagePath), JSON.stringify(retained));
    }, /checkpoint is complete/],
    ['symlinked processed', async ({ packagePath, base }) => {
      recordCheckpoint(checkpointInput(packagePath));
      const outside = join(base, 'outside-processed');
      mkdirSync(outside);
      rmSync(join(packagePath, 'processed'), { recursive: true, force: true });
      symlinkSync(outside, join(packagePath, 'processed'));
    }, /must not be a symlink/],
  ];
  for (const [name, setup, pattern, runOverride] of cases) {
    const fixture = await canonicalFixture(t);
    const target = await setup(fixture) ?? fixture.packagePath;
    const before = { inventory: inventoryOf(fixture.packagePath), checkpoint: checkpointDigest(fixture.packagePath) };
    await assert.rejects(
      deliverOverseerMessage(target, { ...baseInput, run: runOverride ?? baseInput.run }),
      pattern, name,
    );
    assert.deepEqual(inventoryOf(fixture.packagePath), before.inventory, `${name}: mailboxes unchanged`);
    assert.deepEqual(checkpointDigest(fixture.packagePath), before.checkpoint, `${name}: checkpoint unchanged`);
  }
});

test('overseer delivery: review and user-held checkpoints accept, strict input refusals publish nothing', async t => {
  const review = await canonicalFixture(t);
  const reviewInput = checkpointInput(review.packagePath);
  reviewInput.obligation = { ...reviewInput.obligation, stage: 'review' };
  recordCheckpoint(reviewInput);
  const reviewDelivery = await deliverOverseerMessage(review.packagePath, {
    run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'direction', body: 'Proceed.',
  });
  assert.equal(reviewDelivery.status, 'delivered');

  const userHeld = await canonicalFixture(t);
  const heldInput = checkpointInput(userHeld.packagePath);
  heldInput.state = 'user-held';
  recordCheckpoint(heldInput);
  const heldDelivery = await deliverOverseerMessage(userHeld.packagePath, {
    run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'hold', body: 'Hold.',
  });
  assert.equal(heldDelivery.status, 'delivered');

  const strict = await canonicalFixture(t);
  recordCheckpoint(checkpointInput(strict.packagePath));
  const before = inventoryOf(strict.packagePath);
  const rejects = [
    { run: 'wf-1\nid: injected' },
    { sender: 'editor' },
    { audience: 'worker' },
    { kind: 'note' },
    { body: '' },
    { body: 'nul\u0000body' },
    { body: 'bell\u0007body' },
    { body: 'surrogate\ud800body' },
    { body: 'x'.repeat(INBOX_FILE_BYTES) },
  ];
  for (const overrides of rejects) {
    await assert.rejects(deliverOverseerMessage(strict.packagePath, {
      run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'hold', body: 'ok', ...overrides,
    }));
  }
  assert.deepEqual(inventoryOf(strict.packagePath), before, 'no refused input publishes an original');
});

test('overseer delivery: preflight lstat collision regenerates before any link attempt', async t => {
  const { packagePath } = await canonicalFixture(t);
  recordCheckpoint(checkpointInput(packagePath));
  const realLstat = fs.lstat;
  const realLink = fs.link;
  const collidedBytes = Buffer.from('---\nid: collided-original\nrun: wf-1\nsender: operator\naudience: coordinator\nkind: hold\n---\n\ncollided\n');
  const inboxPath = join(packagePath, 'inbox');
  let linkAttempts = 0;
  let collided = null;
  try {
    fs.lstat = async target => {
      if (collided === null && String(target).startsWith(inboxPath) && String(target).endsWith('.md')) {
        await fs.writeFile(target, collidedBytes);
        collided = { path: target, hash: sha(await fs.readFile(target)), mtimeMs: (await fs.stat(target)).mtimeMs };
      }
      return realLstat(target);
    };
    fs.link = async (...args) => { linkAttempts += 1; return realLink(...args); };
    const delivered = await deliverOverseerMessage(packagePath, {
      run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'hold', body: 'Stop dependent work.',
    });
    assert.equal(linkAttempts, 1, 'exactly one link attempt');
    assert.ok(collided, 'the preflight collision was created');
    assert.equal(delivered.status, 'delivered');
    assert.notEqual(basename(collided.path, '.md'), delivered.id, 'the colliding id is never returned');
    assert.equal(sha(await fs.readFile(collided.path)), collided.hash, 'collided bytes unchanged');
    assert.equal((await fs.stat(collided.path)).mtimeMs, collided.mtimeMs, 'collided mtime unchanged');
  } finally {
    fs.lstat = realLstat;
    fs.link = realLink;
  }
});

test('overseer delivery: primitive EEXIST race is unconfirmed with the captured id and one link attempt', async t => {
  const { packagePath } = await canonicalFixture(t);
  recordCheckpoint(checkpointInput(packagePath));
  const realLink = fs.link;
  const raceBytes = Buffer.from('---\nid: race-original\nrun: wf-1\nsender: operator\naudience: coordinator\nkind: hold\n---\n\nrace\n');
  let attempts = 0;
  let captured = null;
  try {
    fs.link = async (existingPath, newPath) => {
      attempts += 1;
      await fs.writeFile(newPath, raceBytes);
      captured = { id: basename(newPath, '.md'), hash: sha(await fs.readFile(newPath)), mtimeMs: (await fs.stat(newPath)).mtimeMs };
      const error = new Error('EEXIST: file already exists');
      error.code = 'EEXIST';
      throw error;
    };
    const delivered = await deliverOverseerMessage(packagePath, {
      run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'hold', body: 'Stop dependent work.',
    });
    assert.equal(attempts, 1, 'exactly one link attempt');
    assert.equal(delivered.status, 'unconfirmed');
    assert.equal(delivered.id, captured.id, 'the captured candidate id is retained');
    assert.equal(sha(await fs.readFile(join(packagePath, 'inbox', `${captured.id}.md`))), captured.hash,
      'the race original is preserved');
    assert.equal(readdirSync(join(packagePath, 'inbox')).filter(name => name.endsWith('.md')).length, 1,
      'no duplicate original is published');
  } finally {
    fs.link = realLink;
  }
});

test('overseer delivery: EIO after a successful link still confirms the observed original', async t => {
  const { packagePath } = await canonicalFixture(t);
  recordCheckpoint(checkpointInput(packagePath));
  const realLink = fs.link;
  let attempts = 0;
  let captured = null;
  try {
    fs.link = async (existingPath, newPath) => {
      attempts += 1;
      await realLink(existingPath, newPath);
      captured = { id: basename(newPath, '.md'), path: newPath, sha256: sha(await fs.readFile(newPath)) };
      const error = new Error('EIO: i/o error');
      error.code = 'EIO';
      throw error;
    };
    const delivered = await deliverOverseerMessage(packagePath, {
      run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'hold', body: 'Stop dependent work.',
    });
    assert.equal(attempts, 1, 'exactly one link attempt');
    assert.equal(delivered.status, 'delivered');
    assert.equal(delivered.id, captured.id);
    assert.equal(delivered.path, captured.path);
    assert.equal(delivered.sha256, captured.sha256);
  } finally {
    fs.link = realLink;
  }
});

test('overseer delivery: EIO with the original moved outside the mailboxes is unconfirmed with one attempt', async t => {
  const { base, packagePath } = await canonicalFixture(t);
  recordCheckpoint(checkpointInput(packagePath));
  const realLink = fs.link;
  const moved = join(base, 'outside.md');
  let attempts = 0;
  let captured = null;
  try {
    fs.link = async (existingPath, newPath) => {
      attempts += 1;
      await realLink(existingPath, newPath);
      captured = { id: basename(newPath, '.md'), sha256: sha(await fs.readFile(newPath)) };
      await fs.rename(newPath, moved);
      const error = new Error('EIO: i/o error');
      error.code = 'EIO';
      throw error;
    };
    const delivered = await deliverOverseerMessage(packagePath, {
      run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'hold', body: 'Stop dependent work.',
    });
    assert.equal(attempts, 1, 'exactly one link attempt');
    assert.equal(delivered.status, 'unconfirmed');
    assert.equal(delivered.id, captured.id, 'the known id is retained');
    assert.equal(delivered.sha256, captured.sha256, 'the expected hash is retained');
    assert.equal(sha(await fs.readFile(moved)), captured.sha256, 'moved original bytes are retained');
    assert.equal(readdirSync(join(packagePath, 'inbox')).filter(name => name.endsWith('.md')).length, 0,
      'no duplicate or new original is published');
  } finally {
    fs.link = realLink;
  }
});

test('overseer delivery: archive after link is confirmed at the processed path', async t => {
  const { packagePath } = await canonicalFixture(t);
  recordCheckpoint(checkpointInput(packagePath));
  const realLink = fs.link;
  let attempts = 0;
  try {
    fs.link = async (existingPath, newPath) => {
      attempts += 1;
      await realLink(existingPath, newPath);
      const id = basename(newPath, '.md');
      await fs.rename(newPath, join(packagePath, 'processed', `${id}.md`));
    };
    const delivered = await deliverOverseerMessage(packagePath, {
      run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'hold', body: 'Stop dependent work.',
    });
    assert.equal(attempts, 1, 'exactly one link attempt');
    assert.equal(delivered.status, 'delivered');
    assert.equal(delivered.path, join(packagePath, 'processed', `${delivered.id}.md`), 'archive path is exact');
    assert.equal(sha(await fs.readFile(delivered.path)), delivered.sha256);
    assert.equal(existsSync(join(packagePath, 'inbox', `${delivered.id}.md`)), false,
      'the inbox original no longer exists');
  } finally {
    fs.link = realLink;
  }
});

test('overseer delivery: exact 64 KiB accepted, one byte more rejected without a new file', async t => {
  const { packagePath } = await canonicalFixture(t);
  recordCheckpoint(checkpointInput(packagePath));
  // Derive the serialized header overhead from a small real delivery with the
  // same fixed-shape values, then build an ASCII body to hit the exact cap.
  const small = await deliverOverseerMessage(packagePath, {
    run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'hold', body: 'small',
  });
  assert.equal(small.status, 'delivered');
  const overhead = statSync(small.path).size - Buffer.byteLength('small');
  const exactBody = 'x'.repeat(INBOX_FILE_BYTES - overhead);
  const exact = await deliverOverseerMessage(packagePath, {
    run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'hold', body: exactBody,
  });
  assert.equal(exact.status, 'delivered');
  assert.equal(statSync(exact.path).size, INBOX_FILE_BYTES, 'the serialized original is exactly at the cap');
  const guard = readInboxGuard(packagePath);
  assert.equal(guard.sources.find(source => source.id === exact.id).sha256, exact.sha256,
    'the guard observes the exact original hash');
  const frontmatter = readFileSync(exact.path, 'utf8').split('\n').slice(1, 6);
  assert.deepEqual(frontmatter, [`id: ${exact.id}`, 'run: wf-1', 'sender: operator',
    'audience: coordinator', 'kind: hold'], 'exactly the five unquoted frontmatter keys');

  const before = readdirSync(join(packagePath, 'inbox')).filter(name => name.endsWith('.md')).length;
  await assert.rejects(deliverOverseerMessage(packagePath, {
    run: 'wf-1', sender: 'operator', audience: 'coordinator', kind: 'hold',
    body: 'x'.repeat(INBOX_FILE_BYTES - overhead + 1),
  }), /exceeds/);
  assert.equal(readdirSync(join(packagePath, 'inbox')).filter(name => name.endsWith('.md')).length, before,
    'a rejected overlimit body publishes no new original');
});
