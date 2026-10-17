import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectWorkspace } from './sentinel.mjs';
import { createDashboardServer, readDashboardState } from './dashboard.mjs';
import { COMPLETION_FILE, applyManualCompletions } from './manual-completion.mjs';
import { makeFixture } from '../spec-location/fixture.mjs';
import { newPackage } from '../spec-location/index.mjs';

function request(server, path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise(resolve => {
    const req = Readable.from([body]);
    Object.assign(req, { url: path, method, headers: { host: '127.0.0.1:4319', ...headers }, socket: { localPort: 4319 } });
    const res = { status: 200, setHeader() {}, writeHead(code) { this.status = code; },
      end(value) { let data; try { data = JSON.parse(value); } catch { data = value; } resolve({ status: this.status, data }); } };
    server.emit('request', req, res);
  });
}
async function fixture(t) {
  const fx = makeFixture(); t.after(fx.cleanup);
  const dir = fx.tmp, root = fx.alpha, agentDir = join(dir, 'agent');
  const pkg = (await newPackage({ workspace: 'demo', slug: 'feature', targets: [{ id: 'alpha' }], ...fx.options })).locations.package_dir;
  const runs = join(pkg, 'runtime', 'runs'); mkdirSync(runs, { recursive: true });
  const receipt = join(runs, 'old.json');
  writeFileSync(receipt, JSON.stringify({ id: 'old', assignment_id: 'old', package: pkg, state: 'running', started_at: '2026-01-01T10:00:00Z' }));
  const collect = () => collectWorkspace({ packages: [pkg], storageRoot: fx.root, skipManagedIndex: true });
  const snapshot = await collect(); assert.equal(snapshot.coverage.state, 'complete');
  const observers = join(agentDir, 'spec-sentinel', 'a'.repeat(64), 'observers'); mkdirSync(observers, { recursive: true });
  const published = join(observers, 'a.json');
  const publish = snapshot => writeFileSync(published, JSON.stringify({ schema_version: 1, observer_id: 'a', state: 'observing', published_at: new Date().toISOString(), snapshot }));
  publish(snapshot);
  const server = createDashboardServer({ agentDir, storageRoot: fx.root });
  const { data } = await request(server, '/api/state');
  const revision = snapshot.runs[0].completion_revision;
  const post = (input = { package: pkg, revision }, headers = {}) => request(server, '/api/package-completion', {
    method: 'POST', body: JSON.stringify(input), headers: { origin: 'http://127.0.0.1:4319', 'content-type': 'application/json', 'x-sentinel-token': data.action_token, ...headers },
  });
  return { dir, root, pkg, agentDir, receipt, runs, revision, collect, publish, post, server };
}

// Run independently: node --test scripts/spec-observe/manual-completion.test.mjs
test('manual completion overrides changed state, preserves worker evidence and allows new dispatches to reopen work', async t => {
  const f = await fixture(t), original = readFileSync(f.receipt, 'utf8');
  assert.equal((await f.post()).status, 200);
  const marker = JSON.parse(readFileSync(join(f.pkg, COMPLETION_FILE), 'utf8'));
  assert.equal(marker.kind, 'manual_completion'); assert.equal(marker.schema_version, 2); assert.equal(marker.package_ref, 'demo/feature');
  assert.equal(readFileSync(f.receipt, 'utf8'), original);
  const immediate = await readDashboardState(f.agentDir);
  assert.equal(immediate.observers[0].snapshot.runs.length, 0);
  assert.equal(immediate.observers[0].snapshot.recently_completed[0].completion_basis, 'manual');
  const fresh = await f.collect();
  assert.equal(fresh.runs.length, 0); assert.equal(fresh.recently_completed[0].completion_basis, 'manual');
  marker.completed_at = new Date(Date.now() - 2000).toISOString();
  writeFileSync(join(f.pkg, COMPLETION_FILE), JSON.stringify(marker));
  writeFileSync(join(f.runs, 'new.json'), JSON.stringify({ id: 'new', assignment_id: 'new', package: f.pkg, state: 'running', started_at: new Date(Date.parse(marker.completed_at) + 1000).toISOString() }));
  const reopened = await f.collect();
  assert.equal(reopened.recently_completed.length, 0); assert.equal(reopened.runs.find(r => r.is_current_assignment).assignment_id, 'new');
  f.publish(reopened);
  assert.equal((await readDashboardState(f.agentDir)).observers[0].snapshot.recently_completed.length, 0);
  assert.equal((await f.post({ package: f.pkg, revision: 'old-page-revision' })).status, 200, 'an explicit decision does not require a matching page revision');
  assert.equal((await f.collect()).runs.length, 0);
  assert.equal(readFileSync(f.receipt, 'utf8'), original);
});

test('completion writes require same-origin action token and reject unpublished or redirected targets', async t => {
  const f = await fixture(t);
  for (const headers of [{ origin: undefined }, { origin: 'null' }, { origin: 'https://other.example' }, { 'x-sentinel-token': 'wrong' }, { 'content-type': 'text/plain' }])
    assert.equal((await f.post(undefined, headers)).status, 403);
  assert.equal((await f.post({ package: f.dir, revision: f.revision })).status, 503);
  assert.equal(existsSync(join(f.pkg, COMPLETION_FILE)), false);
  const outside = join(f.dir, 'outside'); writeFileSync(outside, 'unchanged');
  symlinkSync(outside, join(f.pkg, COMPLETION_FILE));
  assert.equal((await f.post()).status, 503);
  assert.equal(readFileSync(outside, 'utf8'), 'unchanged');
});

// Run alone: node --test --test-name-pattern='wave-only manual completion' scripts/spec-observe/manual-completion.test.mjs
test('wave-only manual completion keeps worker evidence and a new wave dispatch reopens the package', async t => {
  const f = await fixture(t);
  rmSync(f.runs, { recursive: true });
  const waves = join(f.pkg, 'runtime', 'waves'); mkdirSync(waves, { recursive: true });
  const wave = { version: 1, wave_id: 'only', ordinal: 1, state: 'running', generation: 1,
    started_at: '2026-01-01T10:00:00Z', transitions: [{ state: 'running', at: '2026-01-01T10:00:00Z' }],
    members: { 1: { step: 1, phase: 'implementing', run_id: null } } };
  writeFileSync(join(waves, 'only.json'), JSON.stringify(wave));
  const active = await f.collect(); f.publish(active);
  assert.equal(active.runs.length, 0); assert.equal(active.package_executions[0].execution_summary.phase, 'running');
  assert.equal((await f.post()).status, 200, 'published package metadata authorizes wave-only completion');
  const immediate = await readDashboardState(f.agentDir);
  assert.equal(immediate.observers[0].snapshot.package_executions[0].execution_summary.phase, 'complete');
  assert.equal(immediate.observers[0].snapshot.recently_completed[0].completion_basis, 'manual');
  const fresh = await f.collect(); assert.equal(fresh.package_executions[0].execution_summary.phase, 'complete');
  assert.equal(fresh.recently_completed[0].completion_basis, 'manual');
  assert.deepEqual(JSON.parse(readFileSync(join(waves, 'only.json'))), wave, 'operator completion preserves the wave journal');
  const marker = JSON.parse(readFileSync(join(f.pkg, COMPLETION_FILE)));
  marker.completed_at = new Date(Date.now() - 2000).toISOString();
  writeFileSync(join(f.pkg, COMPLETION_FILE), JSON.stringify(marker));
  wave.started_at = new Date(Date.now() - 1000).toISOString();
  writeFileSync(join(waves, 'only.json'), JSON.stringify(wave));
  const reopened = await f.collect(); f.publish(reopened);
  assert.equal(reopened.package_executions[0].execution_summary.phase, 'running');
  assert.equal((await readDashboardState(f.agentDir)).observers[0].snapshot.recently_completed.length, 0);
});

test('manual completion uses package dispatches when a published execution row lacks timing', async t => {
  const f = await fixture(t);
  const completed_at = new Date(Date.now() - 2000).toISOString();
  writeFileSync(join(f.pkg, COMPLETION_FILE), JSON.stringify({ schema_version: 2, kind: 'manual_completion',
    package_ref: 'demo/feature', completed_at }));
  const snapshot = { runs: [{ package: f.pkg, package_ref: 'demo/feature', is_current_assignment: true,
    timing: { attempts: [{ started_at: new Date(Date.now() - 1000).toISOString() }] } }],
    package_executions: [{ package: f.pkg, package_ref: 'demo/feature', execution_summary: { phase: 'running' } }] };
  await applyManualCompletions({ observers: [{ snapshot }] });
  assert.equal(snapshot.runs.length, 1); assert.deepEqual(snapshot.recently_completed, []);
});

test('existing worker checkpoint updates preserve an operator completion decision', async t => {
  const f = await fixture(t); assert.equal((await f.post()).status, 200);
  const checkpoint = join(f.pkg, 'runtime', 'sentinel', 'workflow'); mkdirSync(checkpoint, { recursive: true });
  writeFileSync(join(checkpoint, 'checkpoint.json'), JSON.stringify({ version: 1, workflow_id: 'workflow', package: f.pkg,
    state: 'ready', observed_at: new Date().toISOString(), workers: [{ id: 'old', kind: 'owner', state: 'ready' }] }));
  const fresh = await f.collect();
  assert.equal(fresh.runs.length, 0); assert.equal(fresh.recently_completed[0].completion_basis, 'manual');
  assert.equal(JSON.parse(readFileSync(join(checkpoint, 'checkpoint.json'))).state, 'ready');
});

test('manual completion permits cleaned up worktrees and incomplete lifecycle records', async t => {
  const f = await fixture(t);
  const receipt = JSON.parse(readFileSync(f.receipt));
  writeFileSync(f.receipt, JSON.stringify({ ...receipt, checkout: join(f.dir, 'removed-worktree') }));
  const partial = await f.collect();
  assert.equal(partial.coverage.state, 'partial');
  assert.ok(partial.runs[0].coverage.reasons.some(reason => reason.startsWith('checkout-unavailable:')));
  const checkpoint = join(f.pkg, 'runtime', 'sentinel', 'workflow'); mkdirSync(checkpoint, { recursive: true });
  writeFileSync(join(checkpoint, 'checkpoint.json'), '{');
  const incomplete = await f.collect(); assert.equal(incomplete.runs[0].completion_revision, null);
  f.publish(incomplete);
  assert.equal((await f.post({ package: f.pkg })).status, 200);
  assert.equal((await f.collect()).recently_completed[0].completion_basis, 'manual');
  assert.equal((await readDashboardState(f.agentDir)).observers[0].snapshot.runs.length, 0);
});
