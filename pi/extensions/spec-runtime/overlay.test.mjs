import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildOverlayArgv, validateLayers, retainLayer, createOverlayPhases, runCapabilityProbe, interpretProbeResult } from './overlay.mjs';
import { createOwnership } from './ownership.mjs';

// Fixtures are disposable directories under os.tmpdir(). These tests compose
// overlay argv and ownership phase claims only: they never launch bubblewrap,
// mount anything or touch a real layer.
function freshRoot(t, label) {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeLayerDirs(root) {
  const lower = join(root, 'lower');
  const upper = join(root, 'upper');
  const work = join(root, 'work');
  const merged = join(root, 'merged');
  for (const dir of [lower, upper, work, merged]) mkdirSync(dir, { recursive: true });
  return { lower, upper, work, merged };
}

// Mirrors ownership.test.mjs: ps lstart text is compared exactly, never parsed.
function observedStart(pid) {
  return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    env: { ...process.env, LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 4096,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function liveCoordinator(session, epoch = 1) {
  return { session, epoch, pid: process.pid, started_at: observedStart(process.pid) };
}

function deadCoordinator(session, epoch = 1) {
  const child = spawnSync(process.execPath, ['-e', '0']);
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, 'dead coordinator fixture needs a pid');
  return { session, epoch, pid: child.pid, started_at: `dead-${session}` };
}

async function checkoutClaims(ownership, packageId) {
  const { claims } = await ownership.inspectClaims({ packageId });
  return claims.filter(claim => claim.kind === 'checkout');
}

function assertRefusal(reason, options) {
  assert.throws(
    () => buildOverlayArgv(options),
    error => {
      assert.equal(error.code, 'overlay-refusal', `expected overlay-refusal, got ${JSON.stringify(error)}`);
      assert.equal(error.reason, reason);
      return true;
    },
  );
}

// The claim attempt binds the phase token to the canonical work identity; the
// test computes it independently from the documented contract.
function attemptBinding(token, work) {
  return `${token}+${realpathSync(work)}`;
}

// Command-level probe runner: it executes the exact command argv handed to the
// boundary (including the production probe script text) and substitutes only
// the kernel mount boundary - a synthetic mountinfo line passed as the script's
// fourth positional argument plus symlinked merged entries standing in for
// kernel copy-up and whiteout behavior. Removing any probe operation from the
// script breaks the emitted records and/or the independent filesystem oracle.
function scriptProbeRunner({ calls = null, captured = null, betweenPhases = null, mountFstype = 'overlay' } = {}) {
  return async ({ argv, phase }) => {
    if (calls) calls.push({ argv, phase });
    const overlaySrc = argv.indexOf('--overlay-src');
    const overlayIndex = argv.indexOf('--overlay');
    const dirs = {
      lower: argv[overlaySrc + 1],
      upper: argv[overlayIndex + 1],
      work: argv[overlayIndex + 2],
      merged: argv[overlayIndex + 3],
    };
    if (captured) Object.assign(captured, dirs);
    const mountinfo = join(dirs.work, 'substituted-mountinfo');
    if (phase === 'collect') {
      writeFileSync(join(dirs.upper, 'wave-probe-copy-up.txt'), '');
      writeFileSync(join(dirs.upper, 'wave-probe-delete.txt'), 'whiteout stand-in\n');
      symlinkSync(join(dirs.upper, 'wave-probe-copy-up.txt'), join(dirs.merged, 'wave-probe-copy-up.txt'));
      symlinkSync(join(dirs.lower, 'wave-probe-delete.txt'), join(dirs.merged, 'wave-probe-delete.txt'));
      writeFileSync(
        mountinfo,
        `36 25 0:32 / ${dirs.merged} rw - ${mountFstype} ${mountFstype} rw,nosuid,nodev,redirect_dir=nofollow,uuid=on,userxattr\n`,
      );
    }
    if (phase === 'verify' && betweenPhases) await betweenPhases(dirs);
    const command = argv.slice(argv.indexOf('--') + 1).concat(mountinfo);
    const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', shell: false });
    return {
      exitCode: typeof result.status === 'number' ? result.status : 1,
      signal: result.signal ?? null,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
  };
}

test('wave overlay: fixed argv preserves host PIDs/network and enters the merged cwd', t => {
  const dir = freshRoot(t, 'wave-overlay-argv');
  const { lower, upper, work, merged } = makeLayerDirs(dir);
  const token = 'phase-token-argv';
  const command = ['sh', '-c', 'true'];

  const { token: returnedToken, argv } = buildOverlayArgv({ token, lower, upper, work, merged, command });
  assert.equal(returnedToken, token);
  assert.deepEqual(argv, [
    'bwrap', '--unshare-user', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--overlay-src', lower, '--overlay', upper, work, merged, '--chdir', merged, '--', ...command,
  ]);
  for (const forbidden of ['--unshare-pid', '--unshare-pidns', '--unshare-net', '--unshare-all']) {
    assert.equal(argv.includes(forbidden), false, `argv must not contain ${forbidden}`);
  }

  const explicit = buildOverlayArgv({ token, lower, upper, work, merged, chdir: lower, command: ['node', 'x.js'] });
  const chdirIndex = explicit.argv.indexOf('--chdir');
  assert.equal(explicit.argv[chdirIndex + 1], lower);
  assert.deepEqual(explicit.argv.slice(-3), ['--', 'node', 'x.js']);
});

test('wave overlay: invalid identities, options and tokens refuse', t => {
  const dir = freshRoot(t, 'wave-overlay-refusals');
  const { lower, upper, work, merged } = makeLayerDirs(dir);
  const base = { token: 'phase-token-refusals', lower, upper, work, merged, command: ['true'] };

  assertRefusal('token-invalid', { ...base, token: '' });
  assertRefusal('option-unknown', { ...base, mountOptions: { overlay: true } });
  assertRefusal('identity-invalid', { ...base, lower: 'relative/lower' });
  assertRefusal('identity-not-distinct', { ...base, work: upper });
  assertRefusal('identity-missing', { ...base, lower: join(dir, 'absent-lower') });
  assertRefusal('command-invalid', { ...base, command: [] });
  assertRefusal('chdir-invalid', { ...base, chdir: 'relative/cwd' });
});

test('wave overlay: upper and work must share one filesystem', t => {
  const dir = freshRoot(t, 'wave-overlay-filesystem');
  const { lower, upper, work, merged } = makeLayerDirs(dir);
  const base = { token: 'phase-token-fs', lower, upper, work, merged, command: ['true'] };
  const statWith = (upperDev, workDev) => path => {
    if (path.endsWith('/work')) return { dev: workDev };
    if (path.endsWith('/upper')) return { dev: upperDev };
    return { dev: 1 };
  };

  assertRefusal('upper-work-filesystem-mismatch', { ...base, stat: statWith(11, 12) });
  const mismatch = validateLayers({ lower, upper, work, merged, stat: statWith(11, 12) });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'upper-work-filesystem-mismatch');
  assert.ok('detail' in mismatch, 'mismatch result carries detail');

  const matched = validateLayers({ lower, upper, work, merged });
  assert.equal(matched.ok, true, JSON.stringify(matched));
  assert.deepEqual(
    { lower: matched.identities.lower, upper: matched.identities.upper, work: matched.identities.work, merged: matched.identities.merged },
    { lower, upper, work, merged },
  );
  assert.equal(matched.devices.upper, statSync(upper).dev);
  assert.equal(matched.devices.work, statSync(work).dev);

  const fakeMatch = validateLayers({ lower, upper, work, merged, stat: statWith(7, 7) });
  assert.equal(fakeMatch.ok, true, JSON.stringify(fakeMatch));
  assert.equal(fakeMatch.devices.upper, 7);
  assert.equal(fakeMatch.devices.work, 7);
});

test('wave overlay: layer identities and source modes survive phase exit', async t => {
  const dir = freshRoot(t, 'wave-overlay-modes');
  const { lower, upper, work, merged } = makeLayerDirs(dir);
  const gitDir = join(dir, 'private-git');
  mkdirSync(gitDir, { recursive: true });
  const plain = join(lower, 'plain.txt');
  const script = join(lower, 'tool.sh');
  writeFileSync(plain, 'plain\n', { mode: 0o644 });
  writeFileSync(script, '#!/bin/sh\n', { mode: 0o755 });
  chmodSync(plain, 0o644);
  chmodSync(script, 0o755);

  const validated = validateLayers({ lower, upper, work, merged, gitDir });
  assert.equal(validated.ok, true, JSON.stringify(validated));
  assert.equal(validated.identities.gitDir, gitDir);

  const identity = { lower, upper, work, merged, gitDir, baseCommit: 'commit-abc', snapshotId: 'snap-1', upperId: 'upper-1' };
  const record = retainLayer(identity);
  assert.ok(Object.isFrozen(record), 'retained layer record is frozen');
  assert.deepEqual(record, identity);

  const ownership = createOwnership({ registryRoot: join(dir, 'registry') });
  const { startPhase, endPhase } = createOverlayPhases({ ownership });
  const started = await startPhase({
    packageId: 'package-modes',
    upper,
    work,
    phaseToken: 'phase-modes-1',
    coordinator: liveCoordinator('overlay-modes'),
  });
  assert.equal(started.status, 'permitted', JSON.stringify(started));
  const released = await endPhase({ token: started.claim.token, epoch: started.claim.epoch, drain: 'confirmed' });
  assert.equal(released.status, 'released', JSON.stringify(released));
  assert.equal(released.claim.token, started.claim.token);

  assert.deepEqual(record, identity);
  assert.equal(statSync(plain).mode & 0o777, 0o644);
  assert.equal(statSync(script).mode & 0o777, 0o755);
});

test('wave overlay: interrupted launch never clears retained work directories', async t => {
  const dir = freshRoot(t, 'wave-overlay-interrupted');
  const { upper, work } = makeLayerDirs(dir);
  const marker = join(work, 'kernel-content.marker');
  writeFileSync(marker, 'retained attempt\n', { mode: 0o600 });
  chmodSync(marker, 0o600);

  const overlayNamespace = await import('./overlay.mjs');
  const cleanupExports = Object.keys(overlayNamespace).filter(name => /cleanup|unmount/i.test(name));
  assert.deepEqual(cleanupExports, [], `overlay.mjs must expose no cleanup/unmount API: ${cleanupExports.join(', ')}`);

  const ownership = createOwnership({ registryRoot: join(dir, 'registry') });
  const { startPhase, endPhase } = createOverlayPhases({ ownership });
  const packageId = 'package-interrupted';
  const first = await startPhase({
    packageId,
    upper,
    work,
    phaseToken: 'phase-interrupted-1',
    coordinator: deadCoordinator('overlay-interrupted'),
  });
  assert.equal(first.status, 'permitted', JSON.stringify(first));

  // Interrupted launch: the mount never happened and no release is sent.
  const retry = await startPhase({
    packageId,
    upper,
    work,
    phaseToken: 'phase-interrupted-2',
    coordinator: liveCoordinator('overlay-interrupted-retry'),
  });
  assert.equal(retry.status, 'refused', JSON.stringify(retry));
  assert.equal(retry.reason, 'upper-held');
  assert.equal(retry.claim.token, first.claim.token);
  assert.equal(retry.claim.attempt, attemptBinding('phase-interrupted-1', work));

  assert.equal(readFileSync(marker, 'utf8'), 'retained attempt\n');
  assert.equal(statSync(marker).mode & 0o777, 0o600);

  const denied = await endPhase({ token: first.claim.token, epoch: first.claim.epoch, drain: 'unknown' });
  assert.equal(denied.status, 'denied', JSON.stringify(denied));
  assert.equal(denied.reason, 'drain-unconfirmed');

  assert.equal(readFileSync(marker, 'utf8'), 'retained attempt\n');
  assert.equal(statSync(marker).mode & 0o777, 0o600);
  assert.equal((await checkoutClaims(ownership, packageId)).length, 1);
});

test('wave overlay: a second phase cannot mount the same upper while the first is live or unknown', async t => {
  const dir = freshRoot(t, 'wave-overlay-liveness');
  const { upper, work } = makeLayerDirs(dir);
  const otherUpper = join(dir, 'upper-other');
  const otherWork = join(dir, 'work-other');
  mkdirSync(otherUpper, { recursive: true });
  mkdirSync(otherWork, { recursive: true });
  const ownership = createOwnership({ registryRoot: join(dir, 'registry') });
  const { startPhase } = createOverlayPhases({ ownership });

  const live = await startPhase({
    packageId: 'package-liveness-live',
    upper,
    work,
    phaseToken: 'phase-live-1',
    coordinator: liveCoordinator('overlay-live'),
  });
  assert.equal(live.status, 'permitted', JSON.stringify(live));
  assert.equal(live.claim.liveness, 'alive');
  const liveBlocked = await startPhase({
    packageId: 'package-liveness-live',
    upper,
    work,
    phaseToken: 'phase-live-2',
    coordinator: liveCoordinator('overlay-live'),
  });
  assert.equal(liveBlocked.status, 'refused', JSON.stringify(liveBlocked));
  assert.equal(liveBlocked.reason, 'upper-held');
  assert.equal(liveBlocked.claim.token, live.claim.token);
  assert.equal(liveBlocked.claim.attempt, attemptBinding('phase-live-1', work));

  const unknownCoordinator = { session: 'overlay-unknown', epoch: 3, pid: process.pid, started_at: 'not-the-live-process-start' };
  const unknown = await startPhase({
    packageId: 'package-liveness-unknown',
    upper: otherUpper,
    work: otherWork,
    phaseToken: 'phase-unknown-1',
    coordinator: unknownCoordinator,
  });
  assert.equal(unknown.status, 'permitted', JSON.stringify(unknown));
  assert.equal(unknown.claim.liveness, 'unknown');
  const unknownBlocked = await startPhase({
    packageId: 'package-liveness-unknown',
    upper: otherUpper,
    work: otherWork,
    phaseToken: 'phase-unknown-2',
    coordinator: unknownCoordinator,
  });
  assert.equal(unknownBlocked.status, 'refused', JSON.stringify(unknownBlocked));
  assert.equal(unknownBlocked.reason, 'upper-held');
  assert.equal(unknownBlocked.claim.token, unknown.claim.token);
  assert.equal(unknownBlocked.claim.attempt, attemptBinding('phase-unknown-1', otherWork));
});

test('wave overlay: claim replay is idempotent and only positive drain permits retained remount', async t => {
  const dir = freshRoot(t, 'wave-overlay-replay');
  const { upper, work } = makeLayerDirs(dir);
  const ownership = createOwnership({ registryRoot: join(dir, 'registry') });
  const { startPhase, endPhase } = createOverlayPhases({ ownership });
  const packageId = 'package-replay';
  const coordinator = liveCoordinator('overlay-replay');

  const first = await startPhase({ packageId, upper, work, phaseToken: 'phase-replay-1', coordinator });
  assert.equal(first.status, 'permitted', JSON.stringify(first));
  assert.equal((await checkoutClaims(ownership, packageId)).length, 1);

  const replay = await startPhase({ packageId, upper, work, phaseToken: 'phase-replay-1', coordinator });
  assert.equal(replay.status, 'replayed', JSON.stringify(replay));
  assert.equal(replay.claim.token, first.claim.token);
  assert.equal((await checkoutClaims(ownership, packageId)).length, 1);

  const pending = await endPhase({ token: first.claim.token, epoch: first.claim.epoch, drain: 'pending' });
  assert.equal(pending.status, 'denied', JSON.stringify(pending));
  assert.equal(pending.reason, 'drain-unconfirmed');

  const blocked = await startPhase({ packageId, upper, work, phaseToken: 'phase-replay-2', coordinator });
  assert.equal(blocked.status, 'refused', JSON.stringify(blocked));
  assert.equal(blocked.reason, 'upper-held');

  const released = await endPhase({ token: first.claim.token, epoch: first.claim.epoch, drain: 'confirmed' });
  assert.equal(released.status, 'released', JSON.stringify(released));
  assert.equal(released.claim.token, first.claim.token);
  assert.equal((await checkoutClaims(ownership, packageId)).length, 0);

  const remount = await startPhase({ packageId, upper, work, phaseToken: 'phase-replay-3', coordinator });
  assert.equal(remount.status, 'permitted', JSON.stringify(remount));
  assert.notEqual(remount.claim.token, first.claim.token);
  assert.equal((await checkoutClaims(ownership, packageId)).length, 1);
});

test('wave overlay: wrong token or epoch cannot release the phase claim', async t => {
  const dir = freshRoot(t, 'wave-overlay-release');
  const { upper, work } = makeLayerDirs(dir);
  const ownership = createOwnership({ registryRoot: join(dir, 'registry') });
  const { startPhase, endPhase } = createOverlayPhases({ ownership });
  const packageId = 'package-release';
  const coordinator = liveCoordinator('overlay-release');

  const started = await startPhase({ packageId, upper, work, phaseToken: 'phase-release-1', coordinator });
  assert.equal(started.status, 'permitted', JSON.stringify(started));

  const wrongToken = await endPhase({ token: `${started.claim.token}-tampered`, epoch: started.claim.epoch, drain: 'confirmed' });
  assert.equal(wrongToken.status, 'denied', JSON.stringify(wrongToken));
  assert.equal(wrongToken.reason, 'token-mismatch');

  const wrongEpoch = await endPhase({ token: started.claim.token, epoch: started.claim.epoch + 1, drain: 'confirmed' });
  assert.equal(wrongEpoch.status, 'denied', JSON.stringify(wrongEpoch));
  assert.equal(wrongEpoch.reason, 'epoch-mismatch');

  const stillHeld = await startPhase({ packageId, upper, work, phaseToken: 'phase-release-2', coordinator });
  assert.equal(stillHeld.status, 'refused', JSON.stringify(stillHeld));
  assert.equal(stillHeld.reason, 'upper-held');
  assert.equal((await checkoutClaims(ownership, packageId)).length, 1);
});

test('wave overlay: capability parsing distinguishes enumerated unavailability from corruption and unknown effects', () => {
  const options = 'rw,nosuid,nodev,redirect_dir=nofollow,uuid=on,userxattr';
  const phase = (exitCode, stdout, stderr = '') => ({ exitCode, stdout, stderr });
  const validCollect = (overrides = {}) => ({ fstype: 'overlay', options, copyUp: true, deletion: true, ...overrides });
  const validVerify = (overrides = {}) => ({ fstype: 'overlay', options, retainedWrite: true, retainedDeletion: true, ...overrides });
  const remedy = {
    bwrapAbsent: 'install supported bubblewrap (>= 0.11.0, non-setuid) with overlay options',
    overlayOptions: 'install bubblewrap >= 0.11.0 (overlay options)',
    userns: 'administrator installs the OS-approved AppArmor user-namespace profile or enables unprivileged user namespaces',
    semantics: 'kernel overlay semantics failed the disposable probe; select worktree fallback or repair the kernel/filesystem',
    filesystem: 'place retained overlay layers on a local filesystem supporting kernel OverlayFS',
  };
  const eligibleReasons = [
    'bwrap-absent', 'overlay-options-absent', 'userns-denied',
    'mount-denied', 'filesystem-unsupported', 'semantics-failed',
  ];
  const seenEligible = new Set();
  const seenBlocked = new Set();

  const checked = (label, result, expected) => {
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(result[key], value, `${label}: ${key}`);
    }
    if (result.status === 'blocked') {
      assert.equal(result.fallbackEligible, false, `${label}: blocked probes are not fallback-eligible`);
      assert.equal(result.remedy, null, `${label}: blocked probes carry no remedy`);
      seenBlocked.add(result.reason);
    } else if (result.status === 'unavailable') {
      assert.ok(eligibleReasons.includes(result.reason), `${label}: ${result.reason} is not an enumerated pre-write reason`);
      assert.equal(result.fallbackEligible, true, `${label}: enumerated unavailability is fallback-eligible`);
      seenEligible.add(result.reason);
    } else {
      assert.equal(result.status, 'supported', `${label}: unexpected status ${result.status}`);
      assert.equal(result.fallbackEligible, false, `${label}: supported probes are not fallback-eligible`);
    }
    return result;
  };

  checked('spawn ENOENT', interpretProbeResult({
    spawnError: Object.assign(new Error('spawn bwrap ENOENT'), { code: 'ENOENT' }),
  }), {
    status: 'unavailable', reason: 'bwrap-absent', fallbackEligible: true, remedy: remedy.bwrapAbsent, observed: null,
  });

  checked('overlay options absent', interpretProbeResult({
    collect: phase(1, '', 'bwrap: unknown option --overlay'),
    verify: phase(0, JSON.stringify(validVerify())),
  }), {
    status: 'unavailable', reason: 'overlay-options-absent', fallbackEligible: true, remedy: remedy.overlayOptions,
  });

  // A denied user namespace outranks the verify phase: the decision table is top-down.
  checked('user namespace denied', interpretProbeResult({
    collect: phase(1, '', 'bwrap: setting up user namespaces: Operation not permitted'),
    verify: phase(1, '', 'probe: remount verification failed'),
  }), {
    status: 'unavailable', reason: 'userns-denied', fallbackEligible: true, remedy: remedy.userns,
  });

  checked('mount denied', interpretProbeResult({
    collect: phase(1, '', 'bwrap: cannot mount tmpfs on /newroot/tmp: Operation not permitted'),
    verify: phase(0, JSON.stringify(validVerify())),
  }), {
    status: 'unavailable', reason: 'mount-denied', fallbackEligible: true, remedy: remedy.userns,
  });

  checked('unknown effect', interpretProbeResult({
    collect: phase(1, '', 'bwrap: execvp true: No such file or directory'),
    verify: phase(0, JSON.stringify(validVerify())),
  }), {
    status: 'blocked', reason: 'unknown-effect', fallbackEligible: false, remedy: null,
  });

  checked('unparseable collect output', interpretProbeResult({
    collect: phase(0, 'not json'),
    verify: phase(0, JSON.stringify(validVerify())),
  }), {
    status: 'blocked', reason: 'corrupt-output', fallbackEligible: false, remedy: null, observed: null,
  });

  checked('collect output missing required fields', interpretProbeResult({
    collect: phase(0, JSON.stringify({ fstype: 'overlay', options, copyUp: true })),
    verify: phase(0, JSON.stringify(validVerify())),
  }), {
    status: 'blocked', reason: 'corrupt-output', fallbackEligible: false, remedy: null, observed: null,
  });

  checked('verify execution failure with unrecognized effect is blocked', interpretProbeResult({
    collect: phase(0, JSON.stringify(validCollect())),
    verify: phase(1, '', 'probe: remount verification failed'),
  }), {
    status: 'blocked', reason: 'unknown-effect', fallbackEligible: false, remedy: null,
  });

  checked('verify resource exhaustion is blocked', interpretProbeResult({
    collect: phase(0, JSON.stringify(validCollect())),
    verify: phase(1, '', 'write failed after remount: No space left on device'),
  }), {
    status: 'blocked', reason: 'unknown-effect', fallbackEligible: false, remedy: null,
  });

  checked('collect I/O failure naming --overlay is blocked', interpretProbeResult({
    collect: phase(1, '', 'write failed after --overlay setup: Input/output error'),
    verify: phase(0, JSON.stringify(validVerify())),
  }), {
    status: 'blocked', reason: 'unknown-effect', fallbackEligible: false, remedy: null,
  });

  checked('signal termination is blocked', interpretProbeResult({
    collect: { ...phase(0, JSON.stringify(validCollect())), signal: 'SIGSEGV' },
    verify: phase(0, JSON.stringify(validVerify())),
  }), {
    status: 'blocked', reason: 'unknown-effect', fallbackEligible: false, remedy: null,
  });

  checked('missing verify result is blocked', interpretProbeResult({
    collect: phase(0, JSON.stringify(validCollect())),
  }), {
    status: 'blocked', reason: 'unknown-effect', fallbackEligible: false, remedy: null,
  });

  checked('non-boolean observation fields are corrupt', interpretProbeResult({
    collect: phase(0, JSON.stringify(validCollect({ copyUp: 'true' }))),
    verify: phase(0, JSON.stringify(validVerify())),
  }), {
    status: 'blocked', reason: 'corrupt-output', fallbackEligible: false, remedy: null, observed: null,
  });

  checked('empty observation strings are corrupt', interpretProbeResult({
    collect: phase(0, JSON.stringify(validCollect({ options: '' }))),
    verify: phase(0, JSON.stringify(validVerify())),
  }), {
    status: 'blocked', reason: 'corrupt-output', fallbackEligible: false, remedy: null, observed: null,
  });

  checked('wrong remount filesystem is unsupported', interpretProbeResult({
    collect: phase(0, JSON.stringify(validCollect())),
    verify: phase(0, JSON.stringify(validVerify({ fstype: 'ext4' }))),
  }), {
    status: 'unavailable', reason: 'filesystem-unsupported', fallbackEligible: true, remedy: remedy.filesystem,
  });

  checked('filesystem unsupported', interpretProbeResult({
    collect: phase(0, JSON.stringify(validCollect({ fstype: 'ext4' }))),
    verify: phase(0, JSON.stringify(validVerify())),
  }), {
    status: 'unavailable', reason: 'filesystem-unsupported', fallbackEligible: true, remedy: remedy.filesystem,
  });

  checked('copy-up failed', interpretProbeResult({
    collect: phase(0, JSON.stringify(validCollect({ copyUp: false }))),
    verify: phase(0, JSON.stringify(validVerify())),
  }), {
    status: 'unavailable', reason: 'semantics-failed', fallbackEligible: true, remedy: remedy.semantics,
  });

  checked('retained deletion failed', interpretProbeResult({
    collect: phase(0, JSON.stringify(validCollect({ deletion: false }))),
    verify: phase(0, JSON.stringify(validVerify())),
  }), {
    status: 'unavailable', reason: 'semantics-failed', fallbackEligible: true, remedy: remedy.semantics,
  });

  checked('fully supported', interpretProbeResult({
    collect: phase(0, JSON.stringify(validCollect())),
    verify: phase(0, JSON.stringify(validVerify())),
  }), {
    status: 'supported', reason: 'overlay-supported', fallbackEligible: false, remedy: null,
    observed: {
      fstype: 'overlay', options, copyUp: true, deletion: true,
      verifyFstype: 'overlay', verifyOptions: options,
      retainedWrite: true, retainedDeletion: true,
    },
  });

  assert.deepEqual([...seenEligible].sort(), [...eligibleReasons].sort(), 'exactly the enumerated pre-write reasons are fallback-eligible');
  assert.deepEqual([...seenBlocked].sort(), ['corrupt-output', 'unknown-effect'], 'only corruption and unknown effects are blocked');
});

test('wave overlay: probe orchestration checks copy-up, deletion and remount and propagates observed results', async t => {
  const fixtureRoot = freshRoot(t, 'wave-overlay-probe');
  const options = 'rw,nosuid,nodev,redirect_dir=nofollow,uuid=on,userxattr';
  const collectPayload = { fstype: 'overlay', options, copyUp: true, deletion: true };
  const verifyPayload = { fstype: 'overlay', options, retainedWrite: true, retainedDeletion: true };
  const calls = [];
  // The runner executes the production probe script (command-level
  // assertions); only the kernel mount boundary is substituted. The observed
  // records below therefore fail if copy-up, deletion, mount observation or
  // retained verification operations are removed from the script.
  const runner = scriptProbeRunner({ calls });

  const out = await runCapabilityProbe({ runner, fixtureRoot });
  t.after(() => rmSync(out.fixtureDir, { recursive: true, force: true }));

  assert.equal(out.boundary, 'substituted');
  assert.equal(calls.length, 2, 'the runner is invoked exactly twice');
  assert.deepEqual(calls.map(call => call.phase), ['collect', 'verify']);
  assert.deepEqual(out.phases, {
    collect: { exitCode: 0, signal: null, stdout: `${JSON.stringify(collectPayload)}\n`, stderr: '' },
    verify: { exitCode: 0, signal: null, stdout: `${JSON.stringify(verifyPayload)}\n`, stderr: '' },
  });
  assert.equal(out.result.status, 'supported');
  assert.deepEqual(out.result.observed, {
    fstype: 'overlay', options, copyUp: true, deletion: true,
    verifyFstype: 'overlay', verifyOptions: options,
    retainedWrite: true, retainedDeletion: true,
  });

  const fixedPrefix = ['bwrap', '--unshare-user', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--overlay-src'];
  const fixtureDirsOf = (argv, label) => {
    assert.deepEqual(argv.slice(0, fixedPrefix.length), fixedPrefix, `${label}: fixed bwrap prefix`);
    const overlaySrc = argv.indexOf('--overlay-src');
    const overlayIndex = argv.indexOf('--overlay');
    const chdirIndex = argv.indexOf('--chdir');
    const separator = argv.indexOf('--');
    assert.equal(overlayIndex, overlaySrc + 2, `${label}: --overlay follows the --overlay-src layer`);
    assert.ok(chdirIndex > overlayIndex, `${label}: --chdir follows the overlay trio`);
    assert.ok(separator > chdirIndex, `${label}: the probe command follows --chdir`);
    assert.ok(argv.length > separator + 1, `${label}: probe command argv is present`);
    const merged = argv[overlayIndex + 3];
    assert.equal(argv[chdirIndex + 1], merged, `${label}: --chdir enters the merged directory`);
    return { lower: argv[overlaySrc + 1], upper: argv[overlayIndex + 1], work: argv[overlayIndex + 2], merged };
  };
  const [collectDirs, verifyDirs] = calls.map(call => fixtureDirsOf(call.argv, call.phase));
  assert.deepEqual(verifyDirs, collectDirs, 'both phases mount the same disposable fixture');
  assert.equal(new Set(Object.values(collectDirs)).size, 4, 'fixture identities are distinct');
  for (const dir of Object.values(collectDirs)) {
    assert.ok(statSync(dir).isDirectory(), `${dir} is a disposable probe fixture directory`);
  }
  assert.ok(out.fixtureDir.startsWith(fixtureRoot), 'fixtureDir lives under the injected fixtureRoot');

  const failingCalls = [];
  // The real script reports a failed retained deletion when the emulated
  // merged view shows the deleted entry again after the phase exit.
  const failingRunner = scriptProbeRunner({
    calls: failingCalls,
    betweenPhases: dirs => writeFileSync(join(dirs.merged, 'wave-probe-delete.txt'), 'regressed\n'),
  });
  const failing = await runCapabilityProbe({ runner: failingRunner, fixtureRoot });
  t.after(() => rmSync(failing.fixtureDir, { recursive: true, force: true }));
  assert.deepEqual(failingCalls.map(call => call.phase), ['collect', 'verify']);
  assert.equal(failing.result.status, 'unavailable');
  assert.equal(failing.result.reason, 'semantics-failed');
  assert.equal(failing.result.fallbackEligible, true);

  const spawnCalls = [];
  const spawnFailure = Object.assign(new Error('spawn bwrap ENOENT'), { code: 'ENOENT' });
  const missingRunner = async ({ phase }) => {
    spawnCalls.push(phase);
    throw spawnFailure;
  };
  const missing = await runCapabilityProbe({ runner: missingRunner, fixtureRoot });
  t.after(() => rmSync(missing.fixtureDir, { recursive: true, force: true }));
  assert.deepEqual(spawnCalls, ['collect'], 'verify is skipped when collect cannot spawn');
  assert.equal(missing.phases.verify, null);
  assert.equal(missing.result.status, 'unavailable');
  assert.equal(missing.result.reason, 'bwrap-absent');
  assert.equal(missing.result.fallbackEligible, true);
});

test('wave overlay: substituted OS responses are never labeled real kernel proof', async t => {
  const fixtureRoot = freshRoot(t, 'wave-overlay-substituted');
  const options = 'rw,nosuid,nodev,redirect_dir=nofollow,uuid=on,userxattr';
  const collectPayload = { fstype: 'overlay', options, copyUp: true, deletion: true };
  const verifyPayload = { fstype: 'overlay', options, retainedWrite: true, retainedDeletion: true };
  const phases = [];
  const runner = scriptProbeRunner({ calls: phases });

  const out = await runCapabilityProbe({ runner, fixtureRoot });
  t.after(() => rmSync(out.fixtureDir, { recursive: true, force: true }));

  assert.equal(out.boundary, 'substituted');
  assert.deepEqual(phases.map(call => call.phase), ['collect', 'verify']);
  assert.deepEqual(out.phases, {
    collect: { exitCode: 0, signal: null, stdout: `${JSON.stringify(collectPayload)}\n`, stderr: '' },
    verify: { exitCode: 0, signal: null, stdout: `${JSON.stringify(verifyPayload)}\n`, stderr: '' },
  });
  for (const [label, value] of [['probe output', out], ['interpreted result', out.result]]) {
    assert.equal(Object.hasOwn(value, 'kernelProof'), false, `${label} must not claim kernelProof`);
    assert.equal(Object.hasOwn(value, 'proof'), false, `${label} must not claim proof`);
  }
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes('kernel-proof'), false, 'serialized output must not contain kernel-proof');
  assert.equal(serialized.includes('real kernel'), false, 'serialized output must not contain real kernel');

  assert.equal(out.result.status, 'supported');
  assert.equal(out.result.reason, 'overlay-supported');
  assert.deepEqual(out.result.observed, {
    fstype: 'overlay', options, copyUp: true, deletion: true,
    verifyFstype: 'overlay', verifyOptions: options,
    retainedWrite: true, retainedDeletion: true,
  });
  assert.deepEqual(
    out.result,
    interpretProbeResult({ collect: out.phases.collect, verify: out.phases.verify }),
    'the same substituted outputs always interpret the same way',
  );
});

test('wave overlay: one canonical upper permits one phase regardless of work spelling', async t => {
  const dir = freshRoot(t, 'wave-overlay-upper-key');
  const { upper, work } = makeLayerDirs(dir);
  const otherWork = join(dir, 'other-work');
  mkdirSync(otherWork);
  const { startPhase, endPhase } = createOverlayPhases({ ownership: createOwnership({ registryRoot: join(dir, 'registry') }) });
  const coordinator = liveCoordinator('overlay-upper-key');

  const first = await startPhase({ packageId: 'pkg-upper-key', upper, work, phaseToken: 'phase-upper-key-1', coordinator });
  assert.equal(first.status, 'permitted', JSON.stringify(first));

  // The same canonical upper conflicts regardless of the supplied work.
  const second = await startPhase({ packageId: 'pkg-upper-key', upper, work: otherWork, phaseToken: 'phase-upper-key-2', coordinator });
  assert.equal(second.status, 'refused', JSON.stringify(second));
  assert.equal(second.reason, 'upper-held');
  assert.equal(second.claim.token, first.claim.token);

  // A path alias of the same upper conflicts too.
  const upperAlias = join(dir, 'upper-alias');
  symlinkSync(upper, upperAlias);
  const aliased = await startPhase({ packageId: 'pkg-upper-key', upper: upperAlias, work, phaseToken: 'phase-upper-key-3', coordinator });
  assert.equal(aliased.status, 'refused', JSON.stringify(aliased));
  assert.equal(aliased.reason, 'upper-held');
  assert.equal(aliased.claim.token, first.claim.token);

  // The recorded binding replays only for the same canonical work identity,
  // including an aliased spelling of that work.
  const workAlias = join(dir, 'work-alias');
  symlinkSync(work, workAlias);
  const replay = await startPhase({ packageId: 'pkg-upper-key', upper, work, phaseToken: 'phase-upper-key-1', coordinator });
  assert.equal(replay.status, 'replayed', JSON.stringify(replay));
  assert.equal(replay.claim.token, first.claim.token);
  assert.equal(replay.claim.attempt, attemptBinding('phase-upper-key-1', work));
  const aliasReplay = await startPhase({ packageId: 'pkg-upper-key', upper, work: workAlias, phaseToken: 'phase-upper-key-1', coordinator });
  assert.equal(aliasReplay.status, 'replayed', JSON.stringify(aliasReplay));
  assert.equal(aliasReplay.claim.token, first.claim.token);

  // Only a positive drain frees the upper for a new phase.
  const released = await endPhase({ token: first.claim.token, epoch: first.claim.epoch, drain: 'confirmed' });
  assert.equal(released.status, 'released');
  const next = await startPhase({ packageId: 'pkg-upper-key', upper, work: otherWork, phaseToken: 'phase-upper-key-2', coordinator });
  assert.equal(next.status, 'permitted', JSON.stringify(next));
});

test('wave overlay: replay requires the complete claim identity', async t => {
  const dir = freshRoot(t, 'wave-overlay-replay-identity');
  const { upper, work } = makeLayerDirs(dir);
  const { startPhase } = createOverlayPhases({ ownership: createOwnership({ registryRoot: join(dir, 'registry') }) });
  const coordinator = liveCoordinator('overlay-replay-id');

  const first = await startPhase({ packageId: 'pkg-replay', upper, work, phaseToken: 'phase-replay-1', coordinator });
  assert.equal(first.status, 'permitted', JSON.stringify(first));

  const otherPackage = await startPhase({ packageId: 'pkg-replay-other', upper, work, phaseToken: 'phase-replay-1', coordinator });
  assert.equal(otherPackage.status, 'refused', JSON.stringify(otherPackage));
  assert.equal(otherPackage.reason, 'upper-held');
  assert.equal(otherPackage.claim.token, first.claim.token);

  const otherSession = await startPhase({
    packageId: 'pkg-replay', upper, work, phaseToken: 'phase-replay-1',
    coordinator: { ...coordinator, session: 'overlay-replay-other' },
  });
  assert.equal(otherSession.status, 'refused', JSON.stringify(otherSession));
  assert.equal(otherSession.reason, 'upper-held');
  assert.equal(otherSession.claim.token, first.claim.token);

  const otherEpoch = await startPhase({
    packageId: 'pkg-replay', upper, work, phaseToken: 'phase-replay-1',
    coordinator: { ...coordinator, epoch: coordinator.epoch + 1 },
  });
  assert.equal(otherEpoch.status, 'refused', JSON.stringify(otherEpoch));
  assert.equal(otherEpoch.reason, 'upper-held');
  assert.equal(otherEpoch.claim.token, first.claim.token);

  const otherWorker = await startPhase({
    packageId: 'pkg-replay', upper, work, phaseToken: 'phase-replay-1',
    coordinator: { ...coordinator, pid: coordinator.pid + 1 },
  });
  assert.equal(otherWorker.status, 'refused', JSON.stringify(otherWorker));
  assert.equal(otherWorker.reason, 'upper-held');

  // The exact complete identity still replays idempotently.
  const replay = await startPhase({ packageId: 'pkg-replay', upper, work, phaseToken: 'phase-replay-1', coordinator });
  assert.equal(replay.status, 'replayed', JSON.stringify(replay));
  assert.equal(replay.claim.token, first.claim.token);
  assert.equal(replay.claim.attempt, first.claim.attempt);
});

test('wave overlay: resolved layer identities refuse nesting, aliases and non-directories', t => {
  const dir = freshRoot(t, 'wave-overlay-layer-identity');
  const { lower, upper, work, merged } = makeLayerDirs(dir);

  // Ancestor/descendant layer identities are refused under any spelling.
  const nested = validateLayers({ lower: dir, upper, work, merged });
  assert.equal(nested.ok, false, JSON.stringify(nested));
  assert.equal(nested.reason, 'identity-nested');

  // A symlink alias of another layer resolves to a duplicate identity.
  const lowerAlias = join(dir, 'lower-alias');
  symlinkSync(upper, lowerAlias);
  const aliased = validateLayers({ lower: lowerAlias, upper, work, merged });
  assert.equal(aliased.ok, false, JSON.stringify(aliased));
  assert.equal(aliased.reason, 'identity-not-distinct');

  // A regular file is not a layer directory.
  const file = join(dir, 'lower-file');
  writeFileSync(file, 'not a directory\n');
  const fileLayer = validateLayers({ lower: file, upper, work, merged });
  assert.equal(fileLayer.ok, false, JSON.stringify(fileLayer));
  assert.equal(fileLayer.reason, 'identity-not-directory');

  // A private Git directory reached through an alias inside merged is refused.
  const privateGit = join(merged, '.git');
  mkdirSync(privateGit);
  const gitAlias = join(dir, 'git-alias');
  symlinkSync(privateGit, gitAlias);
  const git = validateLayers({ lower, upper, work, merged, gitDir: gitAlias });
  assert.equal(git.ok, false, JSON.stringify(git));
  assert.equal(git.reason, 'git-inside-merged');

  // Distinct symlinked layer roots remain valid, recorded by their spelling.
  const mergedReal = join(dir, 'merged-real');
  mkdirSync(mergedReal);
  const mergedAlias = join(dir, 'merged-alias');
  symlinkSync(mergedReal, mergedAlias);
  const ok = validateLayers({ lower, upper, work, merged: mergedAlias });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.identities, { lower, upper, work, merged: mergedAlias, gitDir: null });

  // buildOverlayArgv refuses through the same identity pipeline.
  assertRefusal('identity-nested', { token: 'phase-nested-1', lower: dir, upper, work, merged, command: ['true'] });
});

test('wave overlay: probe script operations are proven by an independent filesystem oracle', async t => {
  const fixtureRoot = freshRoot(t, 'wave-overlay-script-oracle');
  const options = 'rw,nosuid,nodev,redirect_dir=nofollow,uuid=on,userxattr';
  const captured = {};
  const out = await runCapabilityProbe({ runner: scriptProbeRunner({ captured }), fixtureRoot });
  t.after(() => rmSync(out.fixtureDir, { recursive: true, force: true }));

  assert.equal(out.boundary, 'substituted');
  // Independent oracle: the filesystem itself, not the script's JSON, proves
  // the copy-up, the whiteout and the retained lower/upper content.
  assert.ok(readFileSync(join(captured.upper, 'wave-probe-copy-up.txt'), 'utf8').includes('wave-probe-modified'), 'copy-up content lives in the upper layer');
  assert.ok(readFileSync(join(captured.lower, 'wave-probe-copy-up.txt'), 'utf8').includes('wave-probe-base'), 'lower source content is retained');
  assert.throws(() => statSync(join(captured.merged, 'wave-probe-delete.txt')), error => error.code === 'ENOENT', 'the deleted entry is gone from the merged view');
  assert.equal(statSync(join(captured.upper, 'wave-probe-delete.txt')).isFile(), true, 'the whiteout stand-in remains in the upper layer');
  assert.equal(statSync(join(captured.lower, 'wave-probe-delete.txt')).isFile(), true, 'the deleted lower source is retained');

  assert.equal(out.result.status, 'supported');
  assert.deepEqual(out.result.observed, {
    fstype: 'overlay', options, copyUp: true, deletion: true,
    verifyFstype: 'overlay', verifyOptions: options,
    retainedWrite: true, retainedDeletion: true,
  });

  // The substituted mount boundary is the only filesystem-type oracle: a
  // non-OverlayFS mount observation is positively unsupported.
  const ext4 = await runCapabilityProbe({ runner: scriptProbeRunner({ mountFstype: 'ext4' }), fixtureRoot });
  t.after(() => rmSync(ext4.fixtureDir, { recursive: true, force: true }));
  assert.equal(ext4.result.status, 'unavailable');
  assert.equal(ext4.result.reason, 'filesystem-unsupported');
  assert.equal(ext4.result.fallbackEligible, true);
});
