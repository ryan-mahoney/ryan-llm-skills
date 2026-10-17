import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { createProcessRegistry, parseProcStat } from './waves-fixture-processes.mjs';

const WORKER_SCRIPT = 'setInterval(() => {}, 60_000)';

// Spawn a detached worker in its own process group, exactly the shape the waves
// fixture launches its fake owners and services with.
const spawnWorker = script => spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });

test('fixture process registry: parseProcStat reads pgrp across spaces and parentheses in comm', () => {
  // comm is `(node (worker))`; the stat tail then starts at state after the last ')'.
  const pid = 4242;
  const fields = [
    'S', '1', '4242', '4242', '0', '-1', '4194304', '1', '0', '0', '0', '0',
    '0', '0', '0', '20', '0', '1', '0', '987654', '0', '0', '0', '0', '0',
    '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0'
  ];
  const parsed = parseProcStat(`${pid} (node (worker)) ${fields.join(' ')}`);
  assert.equal(parsed.pid, pid);
  assert.equal(parsed.state, 'S');
  assert.equal(parsed.pgrp, 4242);
  assert.equal(parsed.starttime, '987654');
  assert.equal(parseProcStat('not-a-stat-line'), null);
});

test('fixture process registry: parseProcStat accepts a kernel/non-owned task pgrp of zero', () => {
  // A kernel thread or other non-owned task reports pgrp 0. It is a valid stat
  // line; scan excludes it by pgid rather than classing it malformed.
  const pid = 2;
  const fields = [
    'S', '0', '0', '0', '0', '-1', '0', '1', '0', '0', '0', '0',
    '0', '0', '0', '20', '0', '1', '0', '123', '0', '0', '0', '0', '0',
    '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0'
  ];
  const parsed = parseProcStat(`${pid} (kthreadd) ${fields.join(' ')}`);
  assert.equal(parsed.pid, pid);
  assert.equal(parsed.state, 'S');
  assert.equal(parsed.pgrp, 0);
  assert.equal(parsed.starttime, '123');
  assert.equal(parseProcStat(`${pid} (kthreadd) ${fields.map((v, i) => (i === 2 ? '-1' : v)).join(' ')}`), null);
});

test('fixture process registry: a live detached worker is never reported drained', async () => {
  const registry = createProcessRegistry();
  const child = spawnWorker(WORKER_SCRIPT);
  registry.register(child);
  try {
    await assert.rejects(registry.assertDrained(), /not drained/i);
  } finally {
    await registry.cleanup();
  }
  await registry.assertDrained();
});

test('fixture process registry: t.after cleanup leaves no live members and is repeatable', async t => {
  const registry = createProcessRegistry();
  // Simulate the fixture integration: teardown is registered immediately, before
  // the worker is spawned, and must be safe to run again after an explicit call.
  t.after(() => registry.cleanup());
  const child = spawnWorker(WORKER_SCRIPT);
  registry.register(child);
  assert.equal(registry.size(), 1);

  await assert.rejects(registry.assertDrained(), /not drained/i);
  await registry.cleanup();
  await registry.assertDrained();

  // A second cleanup is idempotent, still confirms drain, and the group remains
  // registered (retained) so a later membership observation is still possible.
  await registry.cleanup();
  await registry.assertDrained();
  assert.equal(registry.size(), 1, 'the group is retained after its leader closed');
});

test('fixture process registry: a live descendant after the leader exits is detected and reaped', async () => {
  const registry = createProcessRegistry();
  const leaderScript = "const { spawn } = require('node:child_process'); "
    + "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' }); "
    + "child.unref(); setTimeout(() => process.exit(0), 300);";
  const leader = spawn(process.execPath, ['-e', leaderScript], { detached: true, stdio: 'ignore' });
  registry.register(leader);
  try {
    // The leader closes while its descendant stays alive in the same group; the
    // registry must still observe the descendant and refuse to call it drained.
    await once(leader, 'close');
    await assert.rejects(registry.assertDrained(), /not drained/i);
    await registry.cleanup();
    await registry.assertDrained();
  } finally {
    await registry.cleanup();
  }
});

test('wave dispatch: C10-7 registry refuses non-detached child', async () => {
  const registry = createProcessRegistry();
  // A plain non-detached child stays in this process's group, so its pgid is not
  // its own pid. The registry owns whole process groups and must refuse it rather
  // than later signalling an unrelated group.
  const child = spawn(process.execPath, ['-e', WORKER_SCRIPT], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    assert.notEqual(child.pid, process.pid);
    assert.throws(() => registry.register(child), /process group/i);
  } finally {
    child.kill('SIGKILL');
    await once(child, 'close');
  }
});
