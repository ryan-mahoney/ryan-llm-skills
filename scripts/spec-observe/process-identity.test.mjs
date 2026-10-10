import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { inspectProcess, processIdentity, sameProcess } from './process-identity.mjs';

const fixedStart = 'Thu Jan  1 00:00:00 1970';

test('real self identity is alive with nonempty OS start text and exactly matchable', () => {
  const observed = inspectProcess(process.pid);
  assert.equal(observed.state, 'alive');
  assert.equal(observed.pid, process.pid);
  assert.equal(typeof observed.started_at, 'string');
  assert.notEqual(observed.started_at.trim(), '');
  assert.equal(observed.started_at, observed.started_at.trim());
  const identity = processIdentity(process.pid);
  assert.deepEqual(identity, { pid: process.pid, started_at: observed.started_at });
  assert.equal(sameProcess(identity), true);
  assert.equal(sameProcess(observed), true);
});

test('a fixed mismatched start value is a different process', () => {
  assert.equal(sameProcess({ pid: process.pid, started_at: fixedStart }), false);
  assert.equal(sameProcess({ pid: process.pid, started_at: 'not-an-observed-start' }), false);
});

test('ESRCH is the only confirmed death', () => {
  const injected = {
    run: () => '',
    probe: () => { throw Object.assign(new Error('No such process'), { code: 'ESRCH' }); },
  };
  assert.deepEqual(inspectProcess(999999, injected), { state: 'dead', pid: 999999 });
  assert.equal(processIdentity(999999, injected), null);
  assert.equal(sameProcess({ pid: 999999, started_at: fixedStart }, injected), false);
  const exited = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.equal(Number.isSafeInteger(exited.pid), true);
  assert.deepEqual(inspectProcess(exited.pid), { state: 'dead', pid: exited.pid });
});

test('ps timeout is unknown and never reclaimable', () => {
  const calls = [];
  const run = () => { calls.push('run'); throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); };
  const probe = () => { calls.push('probe'); };
  assert.deepEqual(inspectProcess(4242, { run, probe }), { state: 'unknown', pid: 4242, reason: 'ETIMEDOUT' });
  assert.equal(processIdentity(4242, { run, probe }), null);
  assert.equal(sameProcess({ pid: 4242, started_at: 'any-start-text' }, { run, probe }), false);
  assert.equal(calls.includes('probe'), false);
  assert.deepEqual(calls, ['run', 'run', 'run']);
});

test('permission failure on probe plus empty ps output is unknown and never reclaimable', () => {
  const run = () => '';
  const probe = () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); };
  assert.deepEqual(inspectProcess(4243, { run, probe }), { state: 'unknown', pid: 4243, reason: 'EPERM' });
  assert.equal(processIdentity(4243, { run, probe }), null);
  assert.equal(sameProcess({ pid: 4243, started_at: 'any-start-text' }, { run, probe }), false);
});

test('empty ps output with a live probe is unknown', () => {
  const probe = () => {};
  const options = { run: () => '', probe };
  assert.deepEqual(inspectProcess(4244, options), { state: 'unknown', pid: 4244, reason: 'empty-output' });
  assert.deepEqual(inspectProcess(4244, { run: () => '   \n', probe }), { state: 'unknown', pid: 4244, reason: 'empty-output' });
  assert.deepEqual(inspectProcess(4244, { run: () => null, probe }), { state: 'unknown', pid: 4244, reason: 'empty-output' });
  assert.equal(processIdentity(4244, options), null);
  assert.equal(sameProcess({ pid: 4244, started_at: 'any-start-text' }, options), false);
});

test('invalid pid is unknown without calling the OS boundary', () => {
  const calls = [];
  const run = pid => { calls.push(pid); return fixedStart; };
  const probe = pid => { calls.push(pid); };
  for (const pid of [0, -1, 1.5, NaN, 'x']) {
    const observed = inspectProcess(pid, { run, probe });
    assert.equal(observed.state, 'unknown');
    assert.equal(observed.pid, pid);
    assert.equal(processIdentity(pid, { run, probe }), null);
    assert.equal(sameProcess({ pid, started_at: fixedStart }, { run, probe }), false);
  }
  assert.deepEqual(calls, []);
});
