// EV-14 Linux rehearsal (step 13, test-first).
//
// Without SPEC_WAVES_LINUX_REHEARSAL=1 every case below is registered with the
// fixed skip reason, so an ordinary suite never starts units or OOM kills. With
// the opt-in present every capability or precondition failure is a hard
// failure: there is no capability skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCommand,
  buildOverlayArgv,
  checkRuntimeHost,
  createSystemdServiceAdapter,
  importSealedHead,
  linuxCommand,
  linuxPreconditions,
  makeLinuxOverlayFixture,
  makeLinuxServices,
} from './package-fixture.mjs';
import { registerLinuxWaveCases } from './wave-linux-wave-cases.mjs';
import { bootLinuxWave } from './wave-linux-native-fixture.mjs';
import { parseUsecProperty } from './wave-linux-duration.mjs';

const OPT_IN = process.env.SPEC_WAVES_LINUX_REHEARSAL === '1';
const SKIP_REASON = 'rehearsal not authorized in this environment';
const MIB = 1024 * 1024;
const WAIT_INTERVAL_MS = 50;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Every wait is a bounded 50 ms poll. A fixed long sleep would hide a hung
// lifecycle instead of failing it.
async function waitFor(predicate, { timeoutMs = 30000, intervalMs = WAIT_INTERVAL_MS, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await delay(intervalMs);
  }
}

function waitExit(result, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not exit within ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([result.waitExit, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

// The case root and its real service registry are created together. Cleanup
// closes every registered identity first and removes the root only after a
// positive clean result; otherwise the path is retained for inspection.
function caseRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'waves-linux-'));
  const services = makeLinuxServices(t, { root });
  t.after(async () => {
    try {
      await services.close();
    } catch (error) {
      t.diagnostic(`EV-14 cleanup refused and retained ${root}: ${error.message}`);
      return;
    }
    if (!services.clean) {
      t.diagnostic(`EV-14 cleanup left state for inspection at ${root}`);
      return;
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
      // Overlay filesystems can leave kernel work directories at mode 000.
      // Retaining the root keeps the case inspectable and is not a
      // kernel or service proof either way, so only the permissions refusal
      // is reported here; other removal failures still surface.
      t.diagnostic(`EV-14 retained ${root} after clean: ${error.message}`);
    }
  });
  return { root, services };
}

async function confirmDrain(services, record, label) {
  if (!record) return null;
  return waitFor(async () => {
    const result = await services.adapter.drain(record, { timeoutMs: 2000 });
    return result.status === 'confirmed' ? result : null;
  }, { timeoutMs: 30000, label: `${label} drain` });
}

function nodeCommand(source) {
  return [process.execPath, '-e', source];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isPidDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error && error.code === 'ESRCH';
  }
}

function waitPidDead(pid, label) {
  return waitFor(() => isPidDead(pid), { timeoutMs: 30000, label });
}

function collectEntries(root) {
  const entries = [];
  function walk(directory) {
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      const full = join(directory, child.name);
      const stats = lstatSync(full);
      const path = relative(root, full).split(sep).join('/');
      const type = child.isDirectory() ? 'dir' : child.isSymbolicLink() ? 'symlink' : 'file';
      entries.push({ full, path, mode: stats.mode & 0o7777, type });
      if (child.isDirectory()) walk(full);
    }
  }
  walk(root);
  return entries;
}

function digestTree(root) {
  const hash = createHash('sha256');
  for (const entry of collectEntries(root)) {
    hash.update(`${entry.type}\0${entry.mode.toString(8)}\0${entry.path}\0`, 'utf8');
    if (entry.type === 'file') hash.update(readFileSync(entry.full));
    else if (entry.type === 'symlink') hash.update(readlinkSync(entry.full));
    hash.update('\0');
  }
  return hash.digest('hex');
}

// Reserve the upper through the real ownership registry, then run the real
// overlay argv. A claim is released only after a positively confirmed drain.
async function reservePhase(fixture, phaseToken) {
  return fixture.phases.startPhase({
    packageId: 'wave-linux-rehearsal',
    upper: fixture.upper,
    work: fixture.work,
    phaseToken,
    coordinator: fixture.coordinator,
  });
}

function overlayArgv(fixture, phaseToken, command) {
  return buildOverlayArgv({
    token: phaseToken,
    lower: fixture.lower,
    upper: fixture.upper,
    work: fixture.work,
    merged: fixture.merged,
    command,
  }).argv;
}

async function startPhaseService(fixture, services, phaseToken, command) {
  const start = await reservePhase(fixture, phaseToken);
  assert.equal(start.status, 'permitted', `phase ${phaseToken} permitted: ${JSON.stringify(start)}`);
  const result = await services.start(overlayArgv(fixture, phaseToken, command), {
    cwd: fixture.merged,
    timeoutMs: 120000,
    register: () => true,
  });
  // The adapter result is the only proof the unit was admitted and started; a
  // refused or timed-out start must fail here, not at the drain that follows.
  assert.equal(result.ok, true,
    `phase ${phaseToken} started: ${JSON.stringify({ status: result.status, reason: result.reason, ok: result.ok, output: result.output })}`);
  return { start, result };
}

async function finishPhase(fixture, services, claim, result, label) {
  const exited = await waitExit(result, 60000, label);
  assert.equal(exited.exit_code, 0, `${label} exited cleanly: ${JSON.stringify(exited)}`);
  assert.equal(exited.error, null, `${label} exit carried no error: ${JSON.stringify(exited)}`);
  const drained = await services.adapter.drain(result.record, { timeoutMs: 30000 });
  assert.equal(drained.status, 'confirmed', `${label} drained: ${JSON.stringify(drained)}`);
  const released = await fixture.phases.endPhase({ token: claim.token, epoch: claim.epoch, drain: 'confirmed' });
  assert.equal(released.status, 'released', `${label} claim released: ${JSON.stringify(released)}`);
}

function parseByteProperty(value) {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT])?$/i.exec(text);
  if (!match) return Number.NaN;
  const scale = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[String(match[2] || '').toUpperCase()] || 1;
  return Math.round(Number(match[1]) * scale);
}

function linuxTest(name, timeout, fn) {
  test(name, { timeout, skip: OPT_IN ? false : SKIP_REASON }, async t => {
    const preconditions = linuxPreconditions(t);
    await fn(t, preconditions);
  });
}

// Case 9 stays below the insertion point for the remaining native Linux cases
// 6-8, so adding them does not renumber this case.
//
// The lifecycle policy this case exercises is fixture-owned: bootLinuxWave copies
// the operator's real saved policy and narrows only the lifecycle block inside the
// sandbox configHome, so the sandbox admits width 9 without any live host setup or
// mutation. The aggregate slice remains the operator's real saved slice and is
// still compared exactly against the live slice.
linuxTest('wave linux: operator-installed host policy matches the live slice', 120000, async (t, facts) => {
  const fixtureRemedy = 'run this case via the EV-14 Linux rehearsal (it writes the fixture lifecycle policy into its own sandbox configHome)';

  // The boot used this sandbox (fixture lifecycle policy + copied real aggregate),
  // so the real CLI resolves the same saved file through XDG_CONFIG_HOME.
  const boot = await bootLinuxWave(t, facts, { members: 9 });
  const policyPath = join(boot.sandbox.configHome, 'spec-runtime', 'host-policy.json');
  assert.ok(existsSync(policyPath), `the fixture lifecycle policy exists at ${policyPath}; ${fixtureRemedy}`);

  const checked = linuxCommand(process.execPath, [
    fileURLToPath(new URL('../../../scripts/spec-observe/cli.mjs', import.meta.url)),
    'runtime-host', 'check', '--probe',
  ], { env: boot.env });
  assert.equal(checked.error, undefined, `runtime host check could not run: ${checked.error && checked.error.message}`);
  assert.equal(checked.status, 0,
    `runtime host check failed (status ${checked.status}): ${checked.stderr || checked.stdout}`);
  const hostCheck = JSON.parse(checked.stdout);
  assert.equal(hostCheck.ok, true, `runtime host check is not ok: ${JSON.stringify(hostCheck)}`);
  assert.equal(hostCheck.route, 'native');
  assert.equal(hostCheck.nativeReady, true);
  const admittedWidth = hostCheck.admission && hostCheck.admission.admittedWidth;
  assert.ok(Number.isInteger(admittedWidth) && admittedWidth >= 9,
    `the fixture lifecycle policy must admit width 9, got ${admittedWidth}; ${fixtureRemedy}`);

  const saved = readJson(policyPath);
  assert.equal(saved.schema, 'spec-runtime-host-policy/v1');
  // The fixture writes explicit lifecycle provenance, so a policy with only
  // effective defaults cannot satisfy this case.
  assert.equal(saved.provenance && saved.provenance.lifecycleMemoryMib, 'explicit',
    'fixture policy must record explicit lifecycle memory provenance');
  assert.equal(saved.provenance && saved.provenance.lifecycleTasks, 'explicit',
    'fixture policy must record explicit lifecycle task provenance');
  const aggregate = saved.aggregate;
  assert.ok(aggregate && typeof aggregate === 'object', 'saved policy has no aggregate slice values');

  const shown = assertCommand(linuxCommand('systemctl', [
    '--user', 'show', 'spec-runtime.slice',
    '--property=MemoryMax',
    '--property=MemoryHigh',
    '--property=MemorySwapMax',
    '--property=TasksMax',
    '--property=CPUQuotaPerSecUSec',
    '--property=CPUWeight',
  ]), 'systemctl --user show spec-runtime.slice');
  const live = Object.create(null);
  for (const line of shown.stdout.split('\n')) {
    const split = line.indexOf('=');
    if (split > 0) live[line.slice(0, split)] = line.slice(split + 1).trim();
  }

  // Compare the exact aggregate values, not an ordering or an inequality. The
  // aggregate is the operator's unchanged real slice; only the fixture lifecycle
  // block differs, and the live host is never modified by this case.
  assert.equal(parseByteProperty(live.MemoryMax), aggregate.memoryMaxBytes, 'slice MemoryMax');
  assert.equal(parseByteProperty(live.MemoryHigh), aggregate.memoryHighBytes, 'slice MemoryHigh');
  assert.equal(parseByteProperty(live.MemorySwapMax), aggregate.memorySwapMaxBytes, 'slice MemorySwapMax');
  assert.equal(Number(live.TasksMax), aggregate.tasksMax, 'slice TasksMax');
  assert.equal(parseUsecProperty(live.CPUQuotaPerSecUSec), aggregate.cpuQuotaPercent * 10000, 'slice CPUQuotaPerSecUSec');
  assert.equal(Number(live.CPUWeight), aggregate.cpuWeight, 'slice CPUWeight');

  t.diagnostic(JSON.stringify({
    ev: 'EV-14',
    case: 'host-policy',
    kernel_proof: hostCheck.nativeReady === true,
    policyPath,
    lifecycle_fixture: true,
    aggregate_slice: 'live',
  }));
});

linuxTest('wave linux: kernel overlay semantics in a contained phase', 120000, async t => {
  const { root, services } = caseRoot(t);
  const fixture = makeLinuxOverlayFixture(root);
  const lowerDigestBefore = digestTree(fixture.lower);
  assert.match(fixture.lowerDigest, /^[0-9a-f]{64}$/);

  const receiptPath = join(root, 'overlay-receipt.json');
  const readyPath = join(root, 'overlay-ready.json');
  const releasePath = join(root, 'overlay-release');
  const script = `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const receiptPath = ${JSON.stringify(receiptPath)};
    const readyPath = ${JSON.stringify(readyPath)};
    const releasePath = ${JSON.stringify(releasePath)};
    const cwd = process.cwd();
    function mountInfo() {
      const lines = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\\n');
      let best = null;
      for (const line of lines) {
        const parts = line.split(' ');
        const mountpoint = parts[4];
        if (!mountpoint) continue;
        if (cwd === mountpoint || cwd.startsWith(mountpoint.endsWith('/') ? mountpoint : mountpoint + '/')) {
          if (best === null || mountpoint.length > best.mountpoint.length) best = { mountpoint, parts };
        }
      }
      if (best === null) return { fstype: null, options: null, superOptions: null, mountpoint: null };
      const dash = best.parts.indexOf('-');
      return {
        fstype: dash >= 0 ? best.parts[dash + 1] : null,
        options: best.parts[5] || null,
        superOptions: dash >= 0 ? (best.parts[dash + 3] || null) : null,
        mountpoint: best.mountpoint,
      };
    }
    let apparmor = null;
    try { apparmor = fs.readFileSync('/proc/self/attr/current', 'utf8').trim(); }
    catch (error) { apparmor = 'unreadable:' + (error.code || 'error'); }
    const unshare = cp.spawnSync('unshare', ['-U', 'true'], { encoding: 'utf8' });
    const unshareExit = unshare.error ? null : unshare.status;
    fs.appendFileSync('tracked.txt', 'appended\\n');
    fs.appendFileSync('bin/run.sh', '# appended\\n');
    const modeTracked = fs.statSync('tracked.txt').mode & 0o777;
    const modeBin = fs.statSync('bin/run.sh').mode & 0o777;
    fs.rmSync('deleted.txt');
    let renameErrno = null;
    try { fs.renameSync('lowerdir', 'renamedLower'); }
    catch (error) { renameErrno = error.code || 'unknown'; }
    // EXDEV has no in-process fallback: only the real mv crosses to the moved
    // lower, so the receipt records the actual exit of that command.
    let mvStatus = 'not-attempted';
    let mvExit = null;
    if (renameErrno === 'EXDEV') {
      const moved = cp.spawnSync('mv', ['lowerdir', 'lowerdir-moved'], { cwd, encoding: 'utf8' });
      mvExit = moved.error ? null : moved.status;
      mvStatus = moved.error ? (moved.error.code || 'error') : moved.status === 0 ? 'success' : 'failed';
    }
    fs.mkdirSync('upperdir-created');
    fs.renameSync('upperdir-created', 'upperdir-created-renamed');
    // redirect_dir=on renames the lower in place, so the file now sits at the
    // renamed path; the same real mv must still execute on that branch.
    let redirectMvExit = null;
    let redirectMvStatus = 'not-attempted';
    if (renameErrno === null && fs.existsSync('renamedLower')) {
      const moved = cp.spawnSync('mv', ['renamedLower', 'renamedLower-moved'], { cwd, encoding: 'utf8' });
      redirectMvExit = moved.error ? null : moved.status;
      redirectMvStatus = moved.error ? (moved.error.code || 'error') : moved.status === 0 ? 'success' : 'failed';
    }
    // redirect_dir=on performs the rename in place, so the successful actual
    // redirect mv is the same real move the receipt reports as mvStatus.
    if (renameErrno === null) mvStatus = redirectMvStatus;
    const info = mountInfo();
    const receipt = { cwd, ...info, modeTracked, modeBin, renameErrno, mvStatus, mvExit, redirectMvExit, redirectMvStatus,
      upperRenamedExists: fs.existsSync('upperdir-created-renamed'), apparmor, unshareExit };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid, receiptPath }));
    const timer = setInterval(() => {
      if (fs.existsSync(releasePath)) clearInterval(timer);
    }, 50);
  `;

  const { start, result } = await startPhaseService(fixture, services, 'linux-overlay-semantics', nodeCommand(script));
  await waitFor(() => existsSync(readyPath), { timeoutMs: 60000, label: 'overlay receipt and ready file' });

  // While the phase is held, the driver sees an empty mount point and no
  // merged mount of its own: the service is the only process with that view.
  assert.deepEqual(readdirSync(fixture.merged), []);
  const driverMounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
  assert.ok(!driverMounts.some(line => line.split(' ')[4] === fixture.merged),
    'driver process must not have the merged overlay mounted');

  writeFileSync(releasePath, 'release\n');
  await finishPhase(fixture, services, start.claim, result, 'overlay semantics');

  const receipt = readJson(receiptPath);
  assert.equal(receipt.cwd, fixture.merged);
  assert.equal(receipt.fstype, 'overlay');
  assert.equal(receipt.mountpoint, fixture.merged);
  assert.ok(typeof receipt.options === 'string' && receipt.options.length > 0);
  assert.ok(typeof receipt.superOptions === 'string' && receipt.superOptions.includes('lowerdir='));
  assert.equal(receipt.modeTracked, 0o644);
  assert.equal(receipt.modeBin, 0o755);
  const redirect = /redirect_dir=(on|off|nofollow)/.exec(receipt.superOptions);
  if (redirect && redirect[1] === 'on') {
    assert.equal(receipt.renameErrno, null);
    assert.equal(receipt.redirectMvExit, 0, `redirect-renamed mv exit: ${JSON.stringify(receipt)}`);
    assert.equal(receipt.redirectMvStatus, 'success');
  } else {
    assert.equal(receipt.renameErrno, 'EXDEV');
  }
  assert.equal(receipt.mvStatus, 'success');
  if (receipt.renameErrno === 'EXDEV') assert.equal(receipt.mvExit, 0, `mv lowerdir exit: ${JSON.stringify(receipt)}`);
  assert.equal(receipt.upperRenamedExists, true);
  assert.equal(typeof receipt.apparmor, 'string');
  assert.ok('unshareExit' in receipt);

  const whiteout = lstatSync(join(fixture.upper, 'deleted.txt'));
  assert.ok(whiteout.isCharacterDevice(), 'deleted lower file must leave a whiteout');
  assert.equal(whiteout.rdev, 0);
  assert.equal(digestTree(fixture.lower), lowerDigestBefore, 'lower tree must not change');

  t.diagnostic(JSON.stringify({ ev: 'EV-14', case: 'overlay-semantics', kernel_proof: true, receiptPath }));
});

linuxTest('wave linux: exclusive upper and drained dirty remount import exact commits', 120000, async t => {
  const { root, services } = caseRoot(t);
  const fixture = makeLinuxOverlayFixture(root);
  const lowerDigestBefore = digestTree(fixture.lower);
  const readyPath = join(root, 'phase-a-ready.json');
  const releasePath = join(root, 'phase-a-release');
  const remountPath = join(root, 'phase-b.json');

  const scriptA = `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const gitDir = ${JSON.stringify(fixture.gitDir)};
    const base = ${JSON.stringify(fixture.baseCommit)};
    const readyPath = ${JSON.stringify(readyPath)};
    const releasePath = ${JSON.stringify(releasePath)};
    const git = (...args) => cp.spawnSync('git', ['--git-dir', gitDir, '--work-tree', process.cwd(), ...args], { cwd: process.cwd(), encoding: 'utf8' });
    const read = git('read-tree', base);
    if (read.status !== 0) throw new Error('read-tree failed: ' + read.stderr);
    fs.appendFileSync('tracked.txt', 'phase-a\\n');
    fs.rmSync('deleted.txt');
    fs.writeFileSync('untracked.txt', 'untracked\\n');
    fs.writeFileSync('ignored.log', 'ignored\\n');
    fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid }));
    const timer = setInterval(() => {
      if (fs.existsSync(releasePath)) clearInterval(timer);
    }, 50);
  `;

  const phaseA = await startPhaseService(fixture, services, 'linux-phase-a', nodeCommand(scriptA));
  await waitFor(() => existsSync(readyPath), { timeoutMs: 60000, label: 'phase A ready file' });
  assert.equal(services.records.size, 1, 'only phase A is registered while it owns the upper');

  // Phase B must be refused, not queued, while phase A's claim is live.
  const refused = await reservePhase(fixture, 'linux-phase-b-refused');
  assert.equal(refused.status, 'refused');
  assert.equal(refused.reason, 'upper-held');
  assert.equal(services.records.size, 1, 'a refused phase adds no registry identity');

  writeFileSync(releasePath, 'release\n');
  await finishPhase(fixture, services, phaseA.start.claim, phaseA.result, 'phase A');

  const scriptB = `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const gitDir = ${JSON.stringify(fixture.gitDir)};
    const out = ${JSON.stringify(remountPath)};
    const git = (...args) => cp.spawnSync('git', ['--git-dir', gitDir, '--work-tree', process.cwd(), ...args], { cwd: process.cwd(), encoding: 'utf8' });
    const status = git('status', '--short', '--ignored');
    if (status.status !== 0) throw new Error('status failed: ' + status.stderr);
    const lines = status.stdout.split('\\n').filter(line => line.length > 0).sort();
    const add = git('add', '-A');
    if (add.status !== 0) throw new Error('add failed: ' + add.stderr);
    const commit = git('commit', '--no-gpg-sign', '-m', 'linux rehearsal phase b');
    if (commit.status !== 0) throw new Error('commit failed: ' + commit.stderr);
    const head = git('rev-parse', 'HEAD').stdout.trim();
    const tree = git('write-tree').stdout.trim();
    const parent = git('rev-parse', head + '^').stdout.trim();
    fs.writeFileSync(out, JSON.stringify({ lines, head, tree, parent }));
  `;

  const phaseB = await startPhaseService(fixture, services, 'linux-phase-b', nodeCommand(scriptB));
  await finishPhase(fixture, services, phaseB.start.claim, phaseB.result, 'phase B');
  const receipt = readJson(remountPath);

  assert.deepEqual(receipt.lines, [
    ' D deleted.txt',
    ' M tracked.txt',
    '!! ignored.log',
    '?? untracked.txt',
  ]);
  assert.equal(receipt.parent, fixture.baseCommit, 'remount commit must keep the base parent');

  const retentionRef = 'refs/waves/retained/linux-test';
  await importSealedHead({
    repo: fixture.repo,
    source: fixture.gitDir,
    sha: receipt.head,
    retentionRef,
  });

  const canonical = (...args) => {
    const result = spawnSync('git', ['-C', fixture.repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  assert.equal(canonical('rev-parse', retentionRef), receipt.head);
  assert.equal(canonical('rev-parse', `${receipt.head}^{tree}`), receipt.tree);
  assert.equal(canonical('rev-parse', `${receipt.head}^`), fixture.baseCommit);
  assert.equal(digestTree(fixture.lower), lowerDigestBefore, 'lower tree must not change');

  t.diagnostic(JSON.stringify({ ev: 'EV-14', case: 'dirty-remount-import', kernel_proof: true, retentionRef }));
});

linuxTest('wave linux: service gate, cancellation, timeout and OOM retain identity until drain', 180000, async t => {
  const { root, services } = caseRoot(t);

  // Registration refusal: the command must never receive a gate.
  const refusedMarker = join(root, 'register-refused-marker');
  const refusedScript = `require('node:fs').writeFileSync(${JSON.stringify(refusedMarker)}, 'ran')`;
  const refused = await services.start(nodeCommand(refusedScript), {
    cwd: root,
    timeoutMs: 30000,
    register: () => false,
  });
  assert.equal(refused.status, 'register-refused');
  assert.equal(existsSync(refusedMarker), false, 'register-refused command must not run');
  if (refused.record) assert.ok(services.records.has(refused.record.unit));
  await confirmDrain(services, refused.record, 'register-refused');
  assert.equal(existsSync(refusedMarker), false);

  // The registration gate expires before the callback returns.
  const deadlineMarker = join(root, 'deadline-marker');
  const deadlineScript = `require('node:fs').writeFileSync(${JSON.stringify(deadlineMarker)}, 'ran')`;
  const deadline = await services.start(nodeCommand(deadlineScript), {
    cwd: root,
    timeoutMs: 3000,
    register: async () => {
      await delay(3100);
      return true;
    },
  });
  assert.equal(deadline.status, 'refused');
  assert.equal(deadline.reason, 'deadline-expired');
  assert.equal(existsSync(deadlineMarker), false, 'deadline-expired command must not run');
  if (deadline.record) assert.ok(services.records.has(deadline.record.unit));
  await confirmDrain(services, deadline.record, 'deadline-expired');
  assert.equal(existsSync(deadlineMarker), false);

  // Descendants are not identified by the launcher identity alone.
  const pidsPath = join(root, 'descendant-pids.json');
  const descendantScript = `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const pidsPath = ${JSON.stringify(pidsPath)};
    const first = cp.spawn('sleep', ['300'], { stdio: 'ignore' });
    const second = cp.spawn('sleep', ['300'], { stdio: 'ignore' });
    fs.writeFileSync(pidsPath, JSON.stringify({ pids: [first.pid, second.pid] }));
    setInterval(() => {}, 1000);
  `;
  const descendant = await services.start(nodeCommand(descendantScript), {
    cwd: root,
    timeoutMs: 120000,
    register: () => true,
  });
  const descendantPids = await waitFor(
    () => (existsSync(pidsPath) ? readJson(pidsPath) : null),
    { timeoutMs: 60000, label: 'descendant pids' },
  );
  const launcherPid = descendant.launcher_pid ?? descendant.record.launcher_pid;
  const mainPid = descendant.main_pid ?? descendant.record.main_pid;
  assert.ok(Number.isInteger(launcherPid) && Number.isInteger(mainPid));
  assert.notEqual(launcherPid, mainPid, 'launcher and main identities must differ');
  assert.ok(services.records.has(descendant.record.unit));
  const populated = await services.adapter.inspect(descendant.record);
  assert.equal(populated.status, 'populated');
  const stopped = await services.adapter.stop(descendant.record);
  if (stopped.status !== 'confirmed') {
    await waitFor(async () => {
      const inspected = await services.adapter.inspect(descendant.record);
      return inspected.status === 'confirmed' ? inspected : null;
    }, { timeoutMs: 30000, label: 'descendant stop confirmation' });
  }
  await Promise.all(descendantPids.pids.map(pid => waitPidDead(pid, `descendant pid ${pid}`)));
  await confirmDrain(services, descendant.record, 'descendant');

  // Deadline expiry stops the unit and reports timeout, not success.
  const timeoutStartedAt = Date.now();
  const timedOut = await services.start(nodeCommand('setTimeout(() => {}, 60000)'), {
    cwd: root,
    timeoutMs: 3000,
    register: () => true,
  });
  await waitExit(timedOut, 20000, 'deadline timeout service');
  const elapsed = Date.now() - timeoutStartedAt;
  assert.ok(timedOut.output.stderr.includes('Finished with result: timeout'),
    `expected timeout result, got: ${timedOut.output.stderr}`);
  assert.ok(elapsed >= 3000 && elapsed <= 15000, `timeout elapsed ${elapsed} ms outside 3-15 s`);
  assert.ok(services.records.has(timedOut.record.unit));
  await confirmDrain(services, timedOut.record, 'deadline timeout');

  // OOM is classified from the unit result and retained kernel counters, never
  // from an exit status alone.
  const oomScript = `
    const buffers = [];
    setInterval(() => { buffers.push(Buffer.alloc(16 * 1024 * 1024, 1)); }, 10);
  `;
  // `--collect` may remove the cgroup as soon as the unit exits, so the kernel
  // counters must be sampled while the OOM service is still alive. This is
  // observation only: a temporary high-frequency sampler runs alongside the
  // main sampler and contributes the retained rows. Collection can still race
  // the final sample; if no OOM counter is observed the case is classified as
  // observed-unavailable rather than by relaxing the counter assertions.
  const oomSamples = [];
  const oomSampler = setInterval(() => {
    try {
      oomSamples.push(...services.sample('oom'));
    } catch {
      // A closed/absent cgroup is an observation gap, not a test failure here.
    }
  }, 5);
  let oom;
  try {
    oom = await services.start(nodeCommand(oomScript), {
      cwd: root,
      timeoutMs: 60000,
      limits: {
        memoryBytes: 256 * MIB,
        memoryHighBytes: 256 * MIB,
        tasksMax: 128,
        cpuWeight: 100,
      },
      register: () => true,
    });
    oomSamples.push(...services.sample('oom'));
    await waitExit(oom, 60000, 'OOM service');
  } finally {
    clearInterval(oomSampler);
  }
  assert.ok(oom.output.stderr.includes('Finished with result: oom-kill'),
    `expected oom-kill result, got: ${oom.output.stderr}`);
  const oomRow = await waitFor(() => {
    const rows = services.sample('oom').concat(oomSamples);
    return rows.find(row => row.unit === oom.record.unit && (row.memory_events && row.memory_events.oom_kill) >= 1);
  }, { timeoutMs: 30000, label: 'OOM kill counter' });
  assert.ok(oomRow.memory_peak_bytes > 0);
  assert.ok(oomRow.memory_peak_bytes <= 256 * MIB, `peak ${oomRow.memory_peak_bytes} exceeds the 256 MiB limit`);
  assert.ok(services.records.has(oom.record.unit));
  await confirmDrain(services, oom.record, 'oom-kill');

  t.diagnostic(JSON.stringify({ ev: 'EV-14', case: 'gate-timeout-oom', kernel_proof: true }));
});

linuxTest('wave linux: recovery classification on the real manager', 120000, async t => {
  const { root, services } = caseRoot(t);
  const live = await services.start(nodeCommand('setTimeout(() => {}, 60000)'), {
    cwd: root,
    timeoutMs: 120000,
    register: () => true,
  });
  const liveRecord = live.record ?? live;
  assert.equal(typeof liveRecord.unit, 'string');
  assert.equal(typeof liveRecord.boot_id, 'string');

  const reaped = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
  const reapedPid = reaped.pid;
  assert.ok(Number.isInteger(reapedPid), 'spawnSync must return the reaped child pid');

  // A never-started identity uses a fresh owned unit name, the real host and
  // boot, a control group that cannot exist, and a launcher pid already reaped.
  const randomUnit = `spec-runtime-linux-test-${process.pid}-${Date.now()}.service`;
  const neverStarted = {
    ...liveRecord,
    unit: randomUnit,
    invocation_id: 'never-started',
    control_group: `/nonexistent/test-${process.pid}-${Date.now()}`,
    launcher: { pid: reapedPid },
    launcher_pid: reapedPid,
    main_pid: reapedPid,
  };

  const missing = await services.adapter.inspect(neverStarted);
  assert.equal(missing.status, 'confirmed');
  assert.equal(missing.reason, 'unit-not-found');

  const changedBootId = liveRecord.boot_id === '00000000000000000000000000000000'
    ? '11111111111111111111111111111111'
    : '00000000000000000000000000000000';
  const changedBoot = await services.adapter.inspect({ ...neverStarted, boot_id: changedBootId });
  assert.equal(changedBoot.status, 'unknown');
  assert.equal(changedBoot.reason, 'changed-boot');
  const verifiedBoot = await services.adapter.inspect({ ...neverStarted, boot_id: changedBootId }, { ownershipVerified: true });
  assert.equal(verifiedBoot.status, 'confirmed');

  const foreign = await services.adapter.inspect({ ...neverStarted, host_id: 'foreign-host-identity' });
  assert.equal(foreign.status, 'unknown');
  assert.equal(foreign.reason, 'foreign-host');

  // A record owned by another uid is classified as foreign-user for both the
  // observation and the stop path, and the live unit named by the record is
  // left for the owner: neither call signals the foreign identity.
  const foreignUserRecord = { ...neverStarted, uid: liveRecord.uid + 1 };
  const foreignUser = await services.adapter.inspect(foreignUserRecord);
  assert.equal(foreignUser.status, 'unknown');
  assert.equal(foreignUser.reason, 'foreign-user');
  const foreignUserStop = await services.adapter.stop(foreignUserRecord);
  assert.equal(foreignUserStop.status, 'unknown');
  assert.equal(foreignUserStop.reason, 'foreign-user');

  // A synthetic adapter whose explicit identity is not an object resolves to no
  // host/user/boot triple and reports identity-unavailable on both paths. This
  // is an identity-classifier subcase, not a kernel isolation proof.
  const unavailableAdapter = createSystemdServiceAdapter({ identity: false });
  const unavailable = await unavailableAdapter.inspect(liveRecord);
  assert.equal(unavailable.status, 'unknown');
  assert.equal(unavailable.reason, 'identity-unavailable');
  const unavailableStop = await unavailableAdapter.stop(liveRecord);
  assert.equal(unavailableStop.status, 'unknown');
  assert.equal(unavailableStop.reason, 'identity-unavailable');
  t.diagnostic(JSON.stringify({ ev: 'EV-14', case: 'recovery-classification-identity', kernel_proof: false, subcase: 'identity-unavailable' }));

  const changedCgroup = await services.adapter.inspect({
    ...liveRecord,
    control_group: `${liveRecord.control_group}-changed`,
  });
  assert.equal(changedCgroup.status, 'unknown');
  assert.equal(changedCgroup.reason, 'changed-cgroup');

  const escapedCgroup = await services.adapter.inspect({ ...neverStarted, control_group: '/../../outside-cgroup-root' });
  assert.equal(escapedCgroup.status, 'unknown');
  assert.equal(escapedCgroup.reason, 'cgroup-path-outside-root');

  const changedInvocationRecord = { ...liveRecord, invocation_id: `${liveRecord.invocation_id}-changed` };
  const changedInvocation = await services.adapter.inspect(changedInvocationRecord);
  assert.equal(changedInvocation.status, 'unknown');
  assert.equal(changedInvocation.reason, 'changed-invocation');
  const refusedStop = await services.adapter.stop(changedInvocationRecord);
  assert.equal(refusedStop.status, 'unknown');
  assert.equal(refusedStop.reason, 'changed-invocation');
  const stillLive = await services.adapter.inspect(liveRecord);
  assert.equal(stillLive.status, 'populated', 'a refused stop must not signal the live unit');

  const busUnavailable = await services.adapter.inspect(liveRecord, {
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/spec-runtime-bus' },
  });
  assert.equal(busUnavailable.status, 'unknown');
  assert.equal(busUnavailable.reason, 'bus-unavailable');

  assert.ok(services.records.has(liveRecord.unit));
  await services.adapter.stop(liveRecord);
  await confirmDrain(services, liveRecord, 'live recovery identity');

  t.diagnostic(JSON.stringify({ ev: 'EV-14', case: 'recovery-classification', kernel_proof: true, unit: liveRecord.unit }));
});

// Cases 6 and 7 live in wave-linux-wave-cases.mjs and are registered before
// case 9, which intentionally stays last. Case 8 joins them in a later packet.
registerLinuxWaveCases(linuxTest);
linuxTest('wave linux: capability-denied worktree fallback is labeled and never primary proof', 60000, async t => {
  const { root } = caseRoot(t);
  const host = await checkRuntimeHost({
    bwrapPath: join(root, 'absent-bwrap'),
    probe: true,
  });

  // No transport substitution: the real host check reports the fallback it
  // actually selected, and the fallback is never promoted to overlay proof.
  assert.equal(host.route, 'worktree');
  assert.equal(host.fallback && host.fallback.reason, 'bwrap-absent');
  assert.equal(host.overlay && host.overlay.status, 'unavailable');

  t.diagnostic(JSON.stringify({
    ev: 'EV-14',
    case: 'capability-denied-fallback',
    kind: 'fallback-not-primary',
    kernel_proof: false,
    route: host.route,
    reason: host.fallback && host.fallback.reason,
    overlay: host.overlay && host.overlay.status,
  }));
});
