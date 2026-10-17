// Run alone: node --test scripts/workspaces/worker-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { assertNoAssignmentWorkers } from './worker-guard.mjs';

test('a long run with more than 2048 finished run entries can still be relaunched', async t => {
  const root = mkdtempSync(join(tmpdir(), 'worker-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runs = join(root, 'runtime', 'runs');
  mkdirSync(join(runs, 'r1-processes'), { recursive: true });
  for (let i = 0; i < 2100; i++) writeFileSync(join(runs, `r${i}-command.log`), '');
  writeFileSync(join(runs, 'r1-processes', '1.json'), JSON.stringify({ pid: 4242, active: false }));
  await assert.doesNotReject(assertNoAssignmentWorkers({ spec_package: root }));
  // The guard probes a worker's process group, so the live worker must lead its own group.
  const worker = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-worker.pid, 'SIGKILL'); } catch {} });
  writeFileSync(join(runs, 'r1-processes', '2.json'), JSON.stringify({ pid: worker.pid, active: true }));
  await assert.rejects(assertNoAssignmentWorkers({ spec_package: root }), /still running/, 'a live worker is still refused');
});
