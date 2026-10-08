import test from 'node:test';
import assert from 'node:assert/strict';
import { createSentinelControl } from './sentinel-control.mjs';
import { parseSentinelStart, SENTINEL_DEFAULT_MODEL } from './sentinel-options.mjs';

import { controlBus } from './sentinel-control-fixture.mjs';

test('sentinel modes: defaults and explicit model/root overrides need no policy file', () => {
  assert.deepEqual(parseSentinelStart(''), { mode: 'observe', model: SENTINEL_DEFAULT_MODEL, root: null });
  assert.deepEqual(parseSentinelStart('shadow --root "/Projects/My Work" --model test/model:low'),
    { mode: 'shadow', model: 'test/model:low', root: '/Projects/My Work' });
  for (const args of ['recover --model', 'shadow --expires 10', 'observe --root /one --root /two', 'recover --model no-provider'])
    assert.throws(() => parseSentinelStart(args));
});

test('sentinel global control: dormant registration, late join, stop from another session, and replacement', () => {
  const bus = controlBus(), reports = [];
  const one = createSentinelControl(bus.events('monitor'), { onReport: report => reports.push(report) });
  const two = createSentinelControl(bus.events('repo-a'));
  one.register(); two.register();
  assert.equal(one.current(), null);
  assert.equal(two.current(), null);
  one.start(parseSentinelStart('shadow'));
  assert.equal(two.current().options.mode, 'shadow');
  const three = createSentinelControl(bus.events('repo-b'));
  three.register();
  assert.equal(three.current().options.mode, 'shadow');
  three.report({ message: 'diagnosed repo-b' });
  assert.deepEqual(reports, [{ message: 'diagnosed repo-b' }]);

  two.start(parseSentinelStart('recover'));
  assert.equal(one.current().options.mode, 'recover');
  assert.equal(three.current().options.mode, 'recover');
  one.close(); // Closing a former controller must not stop its replacement.
  assert.equal(three.current().options.mode, 'recover');
  three.stop(); // Off can be issued in any participating session.
  assert.equal(two.current(), null);
  assert.equal(three.current(), null);
});

test('sentinel global control: controller loss revokes participants; ordinary participant loss does not', () => {
  const bus = controlBus();
  const monitor = createSentinelControl(bus.events('monitor'));
  const a = createSentinelControl(bus.events('a'));
  const b = createSentinelControl(bus.events('b'));
  monitor.register(); a.register(); b.register();
  monitor.start(parseSentinelStart('recover'));
  a.close(); bus.disconnect('a');
  assert.equal(b.current().options.mode, 'recover');
  bus.disconnect('monitor');
  assert.equal(b.current(), null);
  assert.equal(monitor.current(), null);
  assert.throws(() => monitor.start(parseSentinelStart('recover')), /connected pi-intercom/);
});
