import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSentinelDashboard } from './sentinel-dashboard.mjs';
function fixture(options = {}) {
  const children = [], opened = [], launches = [];
  const service = createSentinelDashboard({ agentDir: '/fixture/agent', ...options,
    launch: (file, args) => {
      launches.push({ file, args });
      const child = new EventEmitter(); child.kills = 0;
      child.kill = () => child.kills++; child.unref = () => {};
      children.push(child); return child;
    },
    open: async url => { opened.push(url); },
  });
  return { children, opened, launches, service };
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

test('dashboard passes exact port, agent-dir and optional public-host child arguments', async () => {
  const plain = fixture();
  const first = plain.service.start();
  assert.deepEqual(plain.launches[0].args, ['--port', '0', '--agent-dir', '/fixture/agent']);
  assert.match(plain.launches[0].file, /dashboard\.mjs$/);
  plain.children[0].emit('message', { type: 'ready', url: 'http://127.0.0.1:12345/' });
  await first;
  plain.service.stop();
  const configured = fixture({ port: 4319, publicHost: 'dashboard.example' });
  const second = configured.service.start();
  assert.deepEqual(configured.launches[0].args, ['--port', '4319', '--agent-dir', '/fixture/agent', '--public-host', 'dashboard.example']);
  configured.children[0].emit('message', { type: 'ready', url: 'http://127.0.0.1:4319/' });
  await second;
  configured.service.stop();
});
