import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectWorkspace } from './sentinel.mjs';
import { createDashboardServer, readDashboardState } from './dashboard.mjs';
import { COMPLETION_FILE } from './manual-completion.mjs';

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'manual-completion-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo'), agentDir = join(dir, 'agent'), pkg = join(root, '.specs', 'feature');
  mkdirSync(pkg, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Initial fixture']);
  const runs = join(pkg, 'runtime', 'runs'); mkdirSync(runs, { recursive: true });
  const receipt = join(runs, 'old.json');
  writeFileSync(receipt, JSON.stringify({ id: 'old', assignment_id: 'old', package: pkg, state: 'running', started_at: '2026-01-01T10:00:00Z' }));
  const collect = () => collectWorkspace({ packages: [pkg], skipManagedIndex: true });
  const snapshot = await collect(); assert.equal(snapshot.coverage.state, 'complete');
  const observers = join(agentDir, 'spec-sentinel', 'a'.repeat(64), 'observers'); mkdirSync(observers, { recursive: true });
  const published = join(observers, 'a.json');
  const publish = snapshot => writeFileSync(published, JSON.stringify({ schema_version: 1, observer_id: 'a', state: 'observing', published_at: new Date().toISOString(), snapshot }));
  publish(snapshot);
  const server = createDashboardServer({ agentDir });
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
  assert.equal(marker.kind, 'manual_completion'); assert.equal(marker.schema_version, 2);
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

test('existing worker checkpoint updates preserve an operator completion decision', async t => {
  const f = await fixture(t); assert.equal((await f.post()).status, 200);
  const checkpoint = join(f.pkg, 'runtime', 'sentinel', 'workflow'); mkdirSync(checkpoint, { recursive: true });
  writeFileSync(join(checkpoint, 'checkpoint.json'), JSON.stringify({ version: 1, workflow_id: 'workflow', package: f.pkg,
    state: 'ready', observed_at: new Date().toISOString(), workers: [{ id: 'old', kind: 'owner', state: 'ready' }] }));
  const fresh = await f.collect();
  assert.equal(fresh.runs.length, 0); assert.equal(fresh.recently_completed[0].completion_basis, 'manual');
  assert.equal(JSON.parse(readFileSync(join(checkpoint, 'checkpoint.json'))).state, 'ready');
});

test('manual completion permits cleaned up worktrees, missing leases and incomplete lifecycle records', async t => {
  const f = await fixture(t);
  const receipt = JSON.parse(readFileSync(f.receipt));
  writeFileSync(f.receipt, JSON.stringify({ ...receipt, checkout: join(f.dir, 'removed-worktree'), lock: join(f.root, '.git', 'missing.lock') }));
  const partial = await f.collect();
  assert.equal(partial.coverage.state, 'partial');
  assert.ok(partial.runs[0].coverage.reasons.some(reason => reason.startsWith('checkout-unavailable:')));
  assert.ok(partial.runs[0].coverage.reasons.includes('lease-missing'));
  const checkpoint = join(f.pkg, 'runtime', 'sentinel', 'workflow'); mkdirSync(checkpoint, { recursive: true });
  writeFileSync(join(checkpoint, 'checkpoint.json'), '{');
  const incomplete = await f.collect(); assert.equal(incomplete.runs[0].completion_revision, null);
  f.publish(incomplete);
  assert.equal((await f.post({ package: f.pkg })).status, 200);
  assert.equal((await f.collect()).recently_completed[0].completion_basis, 'manual');
  assert.equal((await readDashboardState(f.agentDir)).observers[0].snapshot.runs.length, 0);
});
