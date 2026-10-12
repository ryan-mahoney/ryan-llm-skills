import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as tcpConnect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectDashboard, createSentinelDashboard } from './sentinel-dashboard.mjs';
function fixture(options = {}) {
  const children = [], opened = [], launches = [];
  const service = createSentinelDashboard({ agentDir: '/fixture/agent', ...options,
    launch: (file, args) => {
      launches.push({ file, args });
      const child = new EventEmitter();
      child.kills = 0;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = signal => {
        child.kills++;
        child.signalCode = signal ?? null;
        // A real ChildProcess emits exit asynchronously after SIGKILL; mirror
        // that terminal boundary so an awaited stop can settle.
        process.nextTick(() => child.emit('exit', null, signal ?? null));
        return true;
      };
      child.unref = () => {};
      children.push(child); return child;
    },
    open: async url => { opened.push(url); },
  });
  return { children, opened, launches, service };
}

function directFixture(t, options = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), 'sentinel-direct-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  return createDirectDashboard({ agentDir, port: 0, ...options });
}

function requestOnce({ port, path = '/', headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let body = null;
        try { body = JSON.parse(text); } catch { /* refusal bodies stay non-JSON */ }
        resolve({ status: response.statusCode, body, text });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitForRefusal(port) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const accepted = await new Promise(resolve => {
      const socket = tcpConnect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (!accepted) return;
    if (Date.now() > deadline) throw new Error(`Port ${port} still accepts connections after stop.`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('dashboard is inert, starts once, opens its ready URL and stops only its owned service', async () => {
  const f = fixture();
  assert.equal(f.children.length, 0);
  const first = f.service.start(), second = f.service.start();
  assert.equal(first, second);
  f.children[0].emit('message', { type: 'ready', url: 'http://127.0.0.1:12345/' });
  assert.equal((await first).url, 'http://127.0.0.1:12345/');
  await f.service.start();
  assert.deepEqual(f.opened, ['http://127.0.0.1:12345/']);
  f.service.stop();
  assert.equal(f.children[0].kills, 1);
  assert.equal(f.service.url, null);
  const next = f.service.start();
  assert.equal(f.children.length, 2);
  f.children[1].emit('message', { type: 'ready', url: 'http://127.0.0.1:12346/' });
  await next; f.service.stop();
});

test('off during startup prevents a late child from opening the browser', async () => {
  const f = fixture();
  const promise = f.service.start();
  f.service.stop();
  f.children[0].emit('message', { type: 'ready', url: 'http://127.0.0.1:12345/' });
  await assert.rejects(promise, /cancelled/);
  assert.deepEqual(f.opened, []);
});

test('dashboard passes exact port, agent-dir and optional public-host and storage-root child arguments', async () => {
  const plain = fixture();
  const first = plain.service.start();
  assert.deepEqual(plain.launches[0].args, ['--port', '0', '--agent-dir', '/fixture/agent']);
  assert.match(plain.launches[0].file, /dashboard\.mjs$/);
  plain.children[0].emit('message', { type: 'ready', url: 'http://127.0.0.1:12345/' });
  await first;
  plain.service.stop();
  const configured = fixture({ port: 4319, publicHost: 'dashboard.example', storageRoot: '/fixture/storage' });
  const second = configured.service.start();
  assert.deepEqual(configured.launches[0].args, ['--port', '4319', '--agent-dir', '/fixture/agent', '--public-host', 'dashboard.example', '--storage-root', '/fixture/storage']);
  configured.children[0].emit('message', { type: 'ready', url: 'http://127.0.0.1:4319/' });
  await second;
  configured.service.stop();
});

test('stop settles on the owned child exit and repeated stops share the promise', async () => {
  const f = fixture();
  const started = f.service.start();
  f.children[0].emit('message', { type: 'ready', url: 'http://127.0.0.1:12345/' });
  await started;
  const child = f.children[0];
  // Hold the terminal boundary open: kill records the signal but emits no exit.
  child.kill = signal => { child.kills++; child.signalCode = signal ?? null; return true; };
  const first = f.service.stop();
  const second = f.service.stop();
  assert.equal(first, second, 'repeated stops share one tracked promise');
  let settled = false;
  first.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'stop waits for the owned child exit instead of returning early');
  child.exitCode = 0;
  child.emit('exit', 0, null);
  await first;
  assert.equal(f.service.stop(), first, 'the settled stop remains the shared promise');
});

test('direct dashboard is inert, shares startup, serves state and repeats its ready URL', async t => {
  const service = directFixture(t);
  assert.equal(service.url, null);
  const first = service.start(), second = service.start();
  assert.equal(first, second, 'concurrent starts share one promise');
  const ready = await first;
  assert.deepEqual(ready, { url: ready.url, browserError: null });
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const repeated = await service.start();
  assert.equal(repeated.url, ready.url);
  assert.equal(repeated.browserError, null);
  const port = Number(new URL(ready.url).port);
  const state = await requestOnce({ port, path: '/api/state' });
  assert.equal(state.status, 200);
  assert.equal(state.body.schema_version, 1);
  assert.ok(Array.isArray(state.body.observers));
  assert.match(state.body.action_token, /^[a-f0-9]{64}$/);
  await service.stop();
});

test('direct stop shares its promise, clears the URL, closes connections and leaves the discussion service open', async t => {
  let closed = 0;
  const discussion = { close: () => { closed++; } };
  const service = directFixture(t, { discussion });
  const ready = await service.start();
  const port = Number(new URL(ready.url).port);
  const socket = tcpConnect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const gone = new Promise(resolve => socket.once('close', resolve));
  const first = service.stop(), second = service.stop();
  assert.equal(first, second, 'repeated stops share one promise');
  assert.equal(service.url, null);
  await first;
  await gone;
  assert.equal(closed, 0, 'the discussion service is never closed by the dashboard stop');
  await waitForRefusal(port);
});

test('direct dashboard reports EADDRINUSE exactly and stops safely', async t => {
  const blocker = createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const { port } = blocker.address();
  const service = directFixture(t, { port });
  await assert.rejects(service.start(), { message: 'Dashboard service failed: EADDRINUSE' });
  assert.equal(service.url, null);
  const first = service.stop(), second = service.stop();
  assert.equal(first, second, 'a failed start still shares the stop promise');
  await first;
  assert.equal(service.url, null);
  await new Promise(resolve => blocker.close(resolve));
});

test('direct stop during pending startup cancels the start and a late listen cannot resurrect the URL', async t => {
  const port = await freePort();
  const service = directFixture(t, { port });
  const starting = service.start();
  const first = service.stop(), second = service.stop();
  assert.equal(first, second, 'repeated stops share one promise');
  await assert.rejects(starting, { message: 'Dashboard startup cancelled.' });
  await first;
  // Flush any late listening callback before proving the URL stayed revoked.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.url, null);
  await waitForRefusal(port);
});

test('direct dashboard public host refuses thread reads before the service and hides the action token', async t => {
  const calls = [];
  const discussion = { list: async () => { calls.push('list'); return { threads: [] }; } };
  const service = directFixture(t, { publicHost: 'dashboard.example', discussion });
  const ready = await service.start();
  const port = Number(new URL(ready.url).port);
  const threads = await requestOnce({ port, path: '/api/threads', headers: { Host: 'dashboard.example' } });
  assert.equal(threads.status, 403);
  assert.deepEqual(calls, [], 'the public host never reaches the discussion service');
  const state = await requestOnce({ port, path: '/api/state', headers: { Host: 'dashboard.example' } });
  assert.equal(state.status, 200);
  assert.equal(Object.hasOwn(state.body, 'action_token'), false, 'the public host state omits the action token');
  await service.stop();
});
