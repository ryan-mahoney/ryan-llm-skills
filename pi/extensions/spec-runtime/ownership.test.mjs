import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { SOFTWARE_CEILING, resolveRegistryRoot, createOwnership } from './ownership.mjs';

const OWNERSHIP_PATH = fileURLToPath(new URL('./ownership.mjs', import.meta.url));
const RACE_WAIT_MS = 10000;
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const GENEROUS_BUDGETS = { memoryBytes: 100 * GiB, tasks: 4096, perLifecycleMemoryBytes: 3 * GiB, perLifecycleTasks: 512 };

// Fixture runner: imports the module under test from its absolute path, prints a
// 'ready' line, waits for a 'go' line on stdin, then runs one operation. The
// stdin/stdout exchange is the explicit barrier; no timing is involved.
const RUNNER_SOURCE = [
  "import { pathToFileURL } from 'node:url';",
  '',
  'const [modulePath, jobText] = process.argv.slice(2);',
  'const job = JSON.parse(jobText);',
  'const { createOwnership } = await import(pathToFileURL(modulePath).href);',
  'const client = createOwnership({ registryRoot: job.registryRoot, budgets: job.budgets });',
  'const coordinator = { session: job.session, epoch: job.epoch, pid: process.pid, started_at: `runner-${job.session}` };',
  "process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');",
  "await new Promise(resolve => { process.stdin.once('data', resolve); });",
  'const result = await client[job.method]({ ...job.args, coordinator });',
  "process.stdout.write(JSON.stringify({ type: 'result', result }) + '\\n', () => process.exit(0));",
  '',
].join('\n');

function freshRoot(t, label) {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Mirrors scripts/spec-observe/process-identity.mjs: ps lstart text is compared
// exactly and never parsed as a date.
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

function within(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function spawnRunner(fixturePath, job) {
  const child = spawn(process.execPath, [fixturePath, OWNERSHIP_PATH, JSON.stringify(job)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiters = [];
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  const nextLine = () => (lines.length > 0 ? Promise.resolve(lines.shift()) : new Promise(resolve => waiters.push(resolve)));
  return { child, stderr: () => stderr, send: text => child.stdin.write(text), nextLine };
}

async function readRunnerLine(runner, label) {
  try {
    return await within(runner.nextLine(), RACE_WAIT_MS, label);
  } catch (error) {
    const diagnostics = runner.stderr().trim();
    throw new Error(`${error.message}; runner stderr: ${diagnostics || '(none)'}`, { cause: error });
  }
}

async function startRunner(fixturePath, job) {
  const runner = spawnRunner(fixturePath, job);
  const ready = JSON.parse(await readRunnerLine(runner, `${job.session} ready`));
  assert.equal(ready.type, 'ready', `${job.session} did not reach the barrier`);
  return runner;
}

async function collectResult(runner, session) {
  const message = JSON.parse(await readRunnerLine(runner, `${session} result`));
  assert.equal(message.type, 'result', `${session} returned ${JSON.stringify(message)}`);
  return message.result;
}

function mentionsValue(value, needle) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'object') {
    try { return JSON.stringify(value).includes(needle); } catch { return false; }
  }
  return String(value).includes(needle);
}

test('wave ownership: two real processes race a package claim with one winner', async t => {
  assert.equal(typeof resolveRegistryRoot, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'wave-ownership-package-race-'));
  const runners = [];
  t.after(() => {
    for (const runner of runners) { try { runner.child.kill('SIGKILL'); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  });
  const fixture = join(dir, 'runner.mjs');
  writeFileSync(fixture, RUNNER_SOURCE);
  const registryRoot = join(dir, 'registry');
  const packageId = 'package-race';
  const base = {
    registryRoot,
    budgets: GENEROUS_BUDGETS,
    method: 'acquirePackage',
    args: { packageId, packagePath: join(dir, 'package-path') },
  };
  const first = await startRunner(fixture, { ...base, session: 'race-one', epoch: 1 });
  const second = await startRunner(fixture, { ...base, session: 'race-two', epoch: 1 });
  runners.push(first, second);
  first.send('go\n');
  second.send('go\n');
  const results = await Promise.all([collectResult(first, 'race-one'), collectResult(second, 'race-two')]);

  const acquired = results.filter(result => result.status === 'acquired');
  const held = results.filter(result => result.status === 'held');
  assert.equal(acquired.length, 1, `expected one acquirer: ${JSON.stringify(results)}`);
  assert.equal(held.length, 1, `expected one holder: ${JSON.stringify(results)}`);
  assert.equal(acquired[0].claim.kind, 'package');
  assert.equal(acquired[0].claim.packageId, packageId);
  assert.equal(held[0].claim.kind, 'package');
  assert.equal(held[0].claim.token, acquired[0].claim.token);

  const client = createOwnership({ registryRoot, budgets: GENEROUS_BUDGETS });
  const inspected = await client.inspectClaims({ packageId });
  const packageClaims = inspected.claims.filter(claim => claim.kind === 'package');
  assert.equal(packageClaims.length, 1, JSON.stringify(inspected.claims));
  assert.equal(packageClaims[0].token, acquired[0].claim.token);
});

test('wave ownership: two real processes race a checkout claim with one winner', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wave-ownership-checkout-race-'));
  const runners = [];
  t.after(() => {
    for (const runner of runners) { try { runner.child.kill('SIGKILL'); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  });
  const fixture = join(dir, 'runner.mjs');
  writeFileSync(fixture, RUNNER_SOURCE);
  const registryRoot = join(dir, 'registry');
  const packageId = 'package-checkout-race';
  const checkout = {
    gitCommonDir: join(dir, 'repo', '.git'),
    worktreeGitDir: join(dir, 'repo', '.git', 'worktrees', 'worker'),
  };
  const base = {
    registryRoot,
    budgets: GENEROUS_BUDGETS,
    method: 'reserveCheckout',
    args: { packageId, checkout },
  };
  const first = await startRunner(fixture, { ...base, session: 'checkout-one', epoch: 1, args: { ...base.args, attempt: 'attempt-one' } });
  const second = await startRunner(fixture, { ...base, session: 'checkout-two', epoch: 1, args: { ...base.args, attempt: 'attempt-two' } });
  runners.push(first, second);
  first.send('go\n');
  second.send('go\n');
  const results = await Promise.all([collectResult(first, 'checkout-one'), collectResult(second, 'checkout-two')]);

  const reserved = results.filter(result => result.status === 'reserved');
  const held = results.filter(result => result.status === 'held');
  assert.equal(reserved.length, 1, `expected one reserver: ${JSON.stringify(results)}`);
  assert.equal(held.length, 1, `expected one holder: ${JSON.stringify(results)}`);
  assert.equal(reserved[0].claim.kind, 'checkout');
  assert.equal(reserved[0].claim.packageId, packageId);
  assert.equal(held[0].claim.kind, 'checkout');
  assert.equal(held[0].claim.token, reserved[0].claim.token);
  assert.equal(held[0].claim.attempt, reserved[0].claim.attempt);

  const client = createOwnership({ registryRoot, budgets: GENEROUS_BUDGETS });
  const inspected = await client.inspectClaims({ packageId });
  const checkoutClaims = inspected.claims.filter(claim => claim.kind === 'checkout');
  assert.equal(checkoutClaims.length, 1, JSON.stringify(inspected.claims));
  assert.equal(checkoutClaims[0].token, reserved[0].claim.token);
});

test('wave ownership: generous budgets admit five and nine reservations', async t => {
  const dir = freshRoot(t, 'wave-ownership-admit');
  const coordinator = liveCoordinator('admit', 1);

  const five = createOwnership({ registryRoot: join(dir, 'registry-five'), budgets: GENEROUS_BUDGETS });
  for (let index = 0; index < 5; index += 1) {
    const result = await five.reserveCapacity({
      packageId: 'package-five',
      attempt: `five-${index}`,
      request: { memoryBytes: 64 * MiB, tasks: 8 },
      coordinator,
    });
    assert.equal(result.status, 'reserved', JSON.stringify(result));
    assert.equal(result.claim.kind, 'capacity');
  }
  const fiveClaims = (await five.inspectClaims({ packageId: 'package-five' })).claims;
  assert.equal(fiveClaims.filter(claim => claim.kind === 'capacity').length, 5, JSON.stringify(fiveClaims));
  assert.ok(fiveClaims.every(claim => claim.liveness === 'alive'), JSON.stringify(fiveClaims.map(claim => [claim.token, claim.liveness])));

  const nine = createOwnership({ registryRoot: join(dir, 'registry-nine'), budgets: GENEROUS_BUDGETS });
  for (let index = 0; index < 9; index += 1) {
    const result = await nine.reserveCapacity({
      packageId: 'package-nine',
      attempt: `nine-${index}`,
      request: { memoryBytes: 64 * MiB, tasks: 8 },
      coordinator,
    });
    assert.equal(result.status, 'reserved', JSON.stringify(result));
  }
  const nineClaims = (await nine.inspectClaims({ packageId: 'package-nine' })).claims;
  assert.equal(nineClaims.filter(claim => claim.kind === 'capacity').length, 9, JSON.stringify(nineClaims));
});

test('wave ownership: the sixteenth capacity reservation fits and the seventeenth queues on the software ceiling', async t => {
  assert.equal(SOFTWARE_CEILING, 16);
  const dir = freshRoot(t, 'wave-ownership-ceiling');
  const client = createOwnership({ registryRoot: join(dir, 'registry'), budgets: GENEROUS_BUDGETS });
  const coordinator = liveCoordinator('ceiling', 1);
  const request = { memoryBytes: 16 * MiB, tasks: 1 };
  for (let index = 0; index < SOFTWARE_CEILING; index += 1) {
    const result = await client.reserveCapacity({ packageId: 'package-ceiling', attempt: `ceiling-${index}`, request, coordinator });
    assert.equal(result.status, 'reserved', JSON.stringify(result));
  }
  const queued = await client.reserveCapacity({ packageId: 'package-ceiling', attempt: `ceiling-${SOFTWARE_CEILING}`, request, coordinator });
  assert.equal(queued.status, 'queued', JSON.stringify(queued));
  assert.equal(queued.constraint.reason, 'software-ceiling');
  assert.ok(mentionsValue(queued.constraint.owner, String(SOFTWARE_CEILING)), `software ceiling owner: ${JSON.stringify(queued.constraint.owner)}`);
  const claims = (await client.inspectClaims({ packageId: 'package-ceiling' })).claims;
  assert.equal(claims.filter(claim => claim.kind === 'capacity').length, SOFTWARE_CEILING, JSON.stringify(claims));
});

test('wave ownership: cross-package memory pressure names the real owner', async t => {
  const dir = freshRoot(t, 'wave-ownership-pressure');
  const budgets = { memoryBytes: GiB, tasks: 64, perLifecycleMemoryBytes: 2 * GiB, perLifecycleTasks: 128 };
  const client = createOwnership({ registryRoot: join(dir, 'registry'), budgets });
  const coordinator = liveCoordinator('pressure', 1);

  const holder = await client.reserveCapacity({ packageId: 'package-a', attempt: 'a-1', request: { memoryBytes: GiB, tasks: 1 }, coordinator });
  assert.equal(holder.status, 'reserved', JSON.stringify(holder));

  const blocked = await client.reserveCapacity({ packageId: 'package-b', attempt: 'b-1', request: { memoryBytes: 1, tasks: 1 }, coordinator });
  assert.equal(blocked.status, 'queued', JSON.stringify(blocked));
  assert.equal(blocked.constraint.reason, 'memory-budget');
  assert.ok(
    mentionsValue(blocked.constraint.owner, 'package-a') || mentionsValue(blocked.constraint.owner, holder.claim.token),
    `owner ${JSON.stringify(blocked.constraint.owner)} must name package-a or ${holder.claim.token}`,
  );
});

test('wave ownership: a dead coordinator never releases a retained claim', async t => {
  const dir = freshRoot(t, 'wave-ownership-dead');
  const client = createOwnership({ registryRoot: join(dir, 'registry'), budgets: GENEROUS_BUDGETS });
  const packageId = 'package-dead';
  const reserved = await client.reserveCapacity({
    packageId,
    attempt: 'dead-1',
    request: { memoryBytes: 32 * MiB, tasks: 2 },
    coordinator: deadCoordinator('dead-owner', 2),
  });
  assert.equal(reserved.status, 'reserved', JSON.stringify(reserved));
  const token = reserved.claim.token;

  const before = (await client.inspectClaims({ packageId })).claims.filter(claim => claim.kind === 'capacity');
  assert.equal(before.length, 1, JSON.stringify(before));
  assert.equal(before[0].token, token);
  assert.equal(before[0].state, 'reserved');
  assert.equal(before[0].liveness, 'dead');

  const denied = await client.recoverClaims({ token: 'not-the-token', epoch: before[0].epoch, coordinator: liveCoordinator('recoverer', before[0].epoch) });
  assert.equal(denied.status, 'denied');

  const after = (await client.inspectClaims({ packageId })).claims.filter(claim => claim.kind === 'capacity');
  assert.equal(after.length, 1, JSON.stringify(after));
  assert.equal(after[0].token, token);
});

test('wave ownership: a changed process identity never releases a retained claim', async t => {
  const dir = freshRoot(t, 'wave-ownership-impostor');
  const client = createOwnership({ registryRoot: join(dir, 'registry'), budgets: GENEROUS_BUDGETS });
  const packageId = 'package-impostor';
  const impostor = { session: 'impostor-owner', epoch: 3, pid: process.pid, started_at: 'not-the-live-process-start' };
  const reserved = await client.reserveCapacity({
    packageId,
    attempt: 'impostor-1',
    request: { memoryBytes: 32 * MiB, tasks: 2 },
    coordinator: impostor,
  });
  assert.equal(reserved.status, 'reserved', JSON.stringify(reserved));

  const before = (await client.inspectClaims({ packageId })).claims.filter(claim => claim.kind === 'capacity');
  assert.equal(before.length, 1, JSON.stringify(before));
  assert.equal(before[0].token, reserved.claim.token);
  assert.equal(before[0].liveness, 'unknown');
  assert.equal(before[0].coordinator.pid, process.pid);
  assert.equal(before[0].coordinator.started_at, 'not-the-live-process-start');

  const denied = await client.recoverClaims({ token: 'not-the-token', epoch: before[0].epoch, coordinator: liveCoordinator('recoverer', before[0].epoch) });
  assert.equal(denied.status, 'denied');

  const after = (await client.inspectClaims({ packageId })).claims.filter(claim => claim.kind === 'capacity');
  assert.equal(after.length, 1, JSON.stringify(after));
  assert.equal(after[0].token, reserved.claim.token);
});

test('wave ownership: unknown drain never releases a capacity claim', async t => {
  const dir = freshRoot(t, 'wave-ownership-drain');
  const client = createOwnership({ registryRoot: join(dir, 'registry'), budgets: GENEROUS_BUDGETS });
  const packageId = 'package-drain';
  const reserved = await client.reserveCapacity({
    packageId,
    attempt: 'drain-1',
    request: { memoryBytes: 32 * MiB, tasks: 2 },
    coordinator: liveCoordinator('drain', 5),
  });
  assert.equal(reserved.status, 'reserved', JSON.stringify(reserved));
  const { token, epoch } = reserved.claim;

  const unknown = await client.releaseClaim({ token, epoch, drain: 'unknown' });
  assert.equal(unknown.status, 'denied');
  assert.equal(unknown.reason, 'drain-unconfirmed');

  const omitted = await client.releaseClaim({ token, epoch });
  assert.equal(omitted.status, 'denied');
  assert.equal(omitted.reason, 'drain-unconfirmed');

  const retained = (await client.inspectClaims({ packageId })).claims.filter(claim => claim.kind === 'capacity');
  assert.equal(retained.length, 1, JSON.stringify(retained));
  assert.equal(retained[0].token, token);
});

test('wave ownership: wrong token and epoch cannot release another claim', async t => {
  const dir = freshRoot(t, 'wave-ownership-release');
  const client = createOwnership({ registryRoot: join(dir, 'registry'), budgets: GENEROUS_BUDGETS });
  const packageId = 'package-release';
  const coordinator = liveCoordinator('release', 5);
  const first = await client.reserveCapacity({ packageId, attempt: 'release-1', request: { memoryBytes: 32 * MiB, tasks: 2 }, coordinator });
  const second = await client.reserveCapacity({ packageId, attempt: 'release-2', request: { memoryBytes: 32 * MiB, tasks: 2 }, coordinator });
  assert.equal(first.status, 'reserved', JSON.stringify(first));
  assert.equal(second.status, 'reserved', JSON.stringify(second));
  assert.notEqual(first.claim.token, second.claim.token);

  const wrongToken = await client.releaseClaim({ token: `${first.claim.token}-tampered`, epoch: first.claim.epoch, drain: 'confirmed' });
  assert.equal(wrongToken.status, 'denied');
  assert.equal(wrongToken.reason, 'token-mismatch');

  const wrongEpoch = await client.releaseClaim({ token: first.claim.token, epoch: first.claim.epoch + 1, drain: 'confirmed' });
  assert.equal(wrongEpoch.status, 'denied');
  assert.equal(wrongEpoch.reason, 'epoch-mismatch');

  const stillHeld = (await client.inspectClaims({ packageId })).claims.filter(claim => claim.kind === 'capacity');
  assert.equal(stillHeld.length, 2, JSON.stringify(stillHeld));

  const released = await client.releaseClaim({ token: second.claim.token, epoch: second.claim.epoch, drain: 'confirmed' });
  assert.equal(released.status, 'released', JSON.stringify(released));
  assert.equal(released.claim.token, second.claim.token);

  const remaining = (await client.inspectClaims({ packageId })).claims.filter(claim => claim.kind === 'capacity');
  assert.equal(remaining.length, 1, JSON.stringify(remaining));
  assert.equal(remaining[0].token, first.claim.token);
});

test('wave ownership: replay after a crash reuses the reservation identity and recovery rebinds it', async t => {
  const dir = freshRoot(t, 'wave-ownership-replay');
  const registryRoot = join(dir, 'registry');
  const budgets = GENEROUS_BUDGETS;
  const packageId = 'package-replay';
  const attempt = 'attempt-replay';
  const request = { memoryBytes: 256 * MiB, tasks: 16 };

  const first = createOwnership({ registryRoot, budgets });
  const reserved = await first.reserveCapacity({ packageId, attempt, request, coordinator: deadCoordinator('crashed', 7) });
  assert.equal(reserved.status, 'reserved', JSON.stringify(reserved));
  assert.equal(reserved.claim.state, 'reserved');
  assert.equal(reserved.claim.running, false);
  const token = reserved.claim.token;
  const epoch = reserved.claim.epoch;
  assert.equal(epoch, 7);

  const second = createOwnership({ registryRoot, budgets });
  const retained = (await second.inspectClaims()).claims.filter(claim => claim.kind === 'capacity' && claim.packageId === packageId);
  assert.equal(retained.length, 1, JSON.stringify(retained));
  assert.equal(retained[0].token, token);
  assert.equal(retained[0].state, 'reserved');
  assert.equal(retained[0].running, false);

  const replayed = await second.reserveCapacity({ packageId, attempt, request, coordinator: liveCoordinator('survivor', 7) });
  assert.equal(replayed.status, 'reserved', JSON.stringify(replayed));
  assert.equal(replayed.claim.token, token);
  assert.equal(replayed.replayed, true);

  const afterReplay = (await second.inspectClaims({ packageId })).claims.filter(claim => claim.kind === 'capacity');
  assert.equal(afterReplay.length, 1, JSON.stringify(afterReplay));
  assert.equal(afterReplay[0].reservations.memoryBytes, request.memoryBytes);
  assert.equal(afterReplay[0].reservations.tasks, request.tasks);

  const recovered = await second.recoverClaims({ token, epoch, coordinator: liveCoordinator('survivor', 7) });
  assert.equal(recovered.status, 'recovered', JSON.stringify(recovered));
  assert.equal(recovered.claim.token, token);
  assert.equal(recovered.claim.epoch, epoch);

  const afterRecovery = (await second.inspectClaims({ packageId })).claims.filter(claim => claim.kind === 'capacity');
  assert.equal(afterRecovery.length, 1, JSON.stringify(afterRecovery));
  assert.equal(afterRecovery[0].token, token);
  assert.equal(afterRecovery[0].coordinator.session, 'survivor');
  assert.equal(afterRecovery[0].coordinator.pid, process.pid);
});
