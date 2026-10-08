import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSentinelDashboard } from './sentinel-dashboard.mjs';
function fixture() {
  const children = [], opened = [];
  const service = createSentinelDashboard({ agentDir: '/fixture/agent',
    launch: () => {
      const child = new EventEmitter(); child.kills = 0;
      child.kill = () => child.kills++; child.unref = () => {};
      children.push(child); return child;
    },
    open: async url => { opened.push(url); },
  });
  return { children, opened, service };
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
