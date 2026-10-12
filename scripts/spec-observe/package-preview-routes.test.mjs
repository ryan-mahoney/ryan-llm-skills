import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { createDashboardServer } from './dashboard.mjs';
import { setupStorage, createWorkspace } from '../workspaces/store.mjs';

async function fixture(t, previewService) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'package-preview-routes-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const storageRoot = join(temp, 'storage');
  await setupStorage(storageRoot); await createWorkspace(storageRoot, { id: 'demo' });
  const pkg = join(storageRoot, 'projects', 'demo', 'specs', 'feature');
  await mkdir(pkg, { recursive: true });
  const observers = join(temp, 'spec-sentinel', 'a'.repeat(64), 'observers');
  await mkdir(observers, { recursive: true });
  await writeFile(join(observers, 'a.json'), JSON.stringify({ schema_version: 1, observer_id: 'a', state: 'observing', published_at: new Date().toISOString(), snapshot: { runs: [{ package: pkg, workspace: 'demo' }] } }));
  const server = createDashboardServer({ agentDir: temp, storageRoot, publicHost: 'dashboard.example', previewService });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const call = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(body);
  });
  const token = JSON.parse((await call('/api/state')).text).action_token;
  const headers = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-sentinel-token': token };
  return { pkg, call, headers, port };
}

// Run: node --test --test-name-pattern='preview routes.*unconfigured' scripts/spec-observe/package-preview-routes.test.mjs
test('preview routes return unconfigured state without creating a runtime', async t => {
  const f = await fixture(t);
  const result = await f.call('/api/package-preview?' + new URLSearchParams({ package: f.pkg }));
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), { configured: false });
});

// Run: node --test --test-name-pattern='preview routes.*operator' scripts/spec-observe/package-preview-routes.test.mjs
test('preview routes authorize operator endpoints and published packages before runtime actions', async t => {
  const calls = [];
  const output = { configured: true, state: 'running', url: 'http://127.0.0.1:1234', error: null, can_start: false, can_stop: true };
  const previewService = Object.fromEntries(['status', 'start', 'stop'].map(action => [action, async target => { calls.push({ action, target }); return output; }]));
  const f = await fixture(t, previewService);
  const path = '/api/package-preview';
  const body = JSON.stringify({ package: f.pkg, action: 'start' });
  for (const headers of [
    { ...f.headers, 'x-sentinel-token': 'wrong' },
    { ...f.headers, origin: `http://localhost:${f.port}` },
    { ...f.headers, 'x-forwarded-for': '' },
    { ...f.headers, 'content-type': 'text/plain' },
  ]) assert.equal((await f.call(path, { method: 'POST', headers, body })).status, 403);
  assert.equal((await f.call(path + '?' + new URLSearchParams({ package: f.pkg }), { headers: { 'x-forwarded-for': '' } })).status, 403);
  assert.equal((await f.call(path, { method: 'POST', headers: f.headers, body: JSON.stringify({ package: join(f.pkg, '..', 'unpublished'), action: 'start' }) })).status, 403);
  assert.equal((await f.call(path, { method: 'POST', headers: f.headers, body: JSON.stringify({ package: f.pkg, action: 'destroy' }) })).status, 400);
  assert.equal((await f.call(path, { method: 'PUT', headers: f.headers })).status, 405);
  assert.equal((await f.call(path, { method: 'POST', headers: f.headers, body: 'x'.repeat(8193) })).status, 413);
  assert.deepEqual(calls, []);
  const publicState = JSON.parse((await f.call('/api/state', { headers: { host: 'dashboard.example' } })).text);
  assert.equal(publicState.action_token, undefined);
  assert.equal(typeof publicState.thread_action_token, 'string');
  for (const action of ['start', 'stop']) {
    const result = await f.call(path, { method: 'POST', headers: { host: 'dashboard.example', origin: 'https://dashboard.example', 'content-type': 'application/json', 'x-sentinel-token': publicState.thread_action_token, 'x-forwarded-for': '100.1.2.3' }, body: JSON.stringify({ package: f.pkg, action }) });
    assert.equal(result.status, 202); assert.deepEqual(JSON.parse(result.text), output);
  }
  assert.equal((await f.call(path + '?' + new URLSearchParams({ package: f.pkg }))).status, 200);
  assert.deepEqual(calls, ['start', 'stop', 'status'].map(action => ({ action, target: { root: f.pkg, ref: 'demo/feature' } })));
});

// Run: node --test --test-name-pattern='preview routes.*sanitize' scripts/spec-observe/package-preview-routes.test.mjs
test('preview routes sanitize runtime exceptions', async t => {
  const f = await fixture(t, { status: async () => { throw Object.assign(new Error('secret Compose output'), { status: 409, publicMessage: 'secret config' }); } });
  const result = await f.call('/api/package-preview?' + new URLSearchParams({ package: f.pkg }));
  assert.equal(result.status, 409);
  assert.deepEqual(JSON.parse(result.text), { error: 'Package preview conflicts with current state.' });
});
