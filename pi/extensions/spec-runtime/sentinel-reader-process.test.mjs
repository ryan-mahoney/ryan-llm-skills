import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSentinelReaderProcess } from './sentinel-reader-process.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sentinel-reader-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('isolated reader returns workspace data and can restart after stop', async t => {
  const dir = fixture(t);
  const reader = createSentinelReaderProcess();
  t.after(() => reader.stop());
  const options = { agentDir: dir, indexDir: join(dir, 'index'), root: dir };
  const result = await reader.read(options);
  assert.equal(result.snapshot.version, 1);
  assert.deepEqual(result.snapshot.runs, []);
  await Promise.all([reader.stop(), reader.stop()]);
  assert.throws(() => process.kill(result.snapshot.reader.pid, 0), error => error.code === 'ESRCH',
    'both stop callers await the owned helper exit');
  assert.equal((await reader.read(options)).snapshot.version, 1);
});

test('blocked reader cannot block host timers, expires and can restart without killing host', async t => {
  const dir = fixture(t), script = join(dir, 'blocked.mjs');
  // A real child stuck in synchronous JS demonstrates process isolation; a
  // promise-only fake would not catch moving this workload back into Pi.
  writeFileSync(script, "process.on('message', () => { while (true) {} });\n");
  const reader = createSentinelReaderProcess({ workerFile: script, timeoutMs: 150, cooldownMs: 0 });
  t.after(() => reader.stop());
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 5);
  try { await assert.rejects(reader.read({}), /scan exceeded/); }
  finally { clearInterval(heartbeat); }
  assert.ok(ticks > 1, 'host event loop stays responsive while child is blocked');
  writeFileSync(script, "process.on('message', m => process.send({ type: 'result', id: m.id, value: { recovered: true } }));\n");
  assert.deepEqual(await reader.read({}), { recovered: true });
});


test('isolated reader finds indexed active work outside the discovery root', async t => {
  const dir = realpathSync(fixture(t));
  const root = join(dir, 'Documents'), repo = join(dir, '.agents');
  mkdirSync(root); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const packagePath = join(repo, '.specs', 'repo-search-index');
  const runs = join(packagePath, 'runtime', 'runs');
  const indexDir = join(dir, 'index');
  mkdirSync(runs, { recursive: true }); mkdirSync(indexDir);
  writeFileSync(join(runs, 'active.json'), JSON.stringify({ id: 'active', package: packagePath,
    checkout: repo, state: 'running', started_at: new Date().toISOString() }));
  writeFileSync(join(indexDir, 'active.json'), JSON.stringify({ run_id: 'active', package: packagePath }));
  const reader = createSentinelReaderProcess();
  t.after(() => reader.stop());
  const { snapshot } = await reader.read({ agentDir: dir, root, indexDir });
  assert.equal(snapshot.coverage.state, 'complete');
  assert.equal(snapshot.runs[0].package, packagePath);
  assert.equal(snapshot.runs[0].execution, 'running');
  assert.equal(snapshot.runs[0].checkout, repo);
  assert.equal(snapshot.reader.isolated, true);
  assert.notEqual(snapshot.reader.pid, process.pid);
});
