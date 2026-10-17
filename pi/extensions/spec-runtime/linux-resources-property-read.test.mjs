// Real user-manager property read regression (step 13, F5).
//
// The property query itself must run against the operator's live user manager.
// Only the surrounding prerequisites are synthetic: the transport delegates
// every `systemctl ... -.slice` request to the real binary with the production
// argv forwarded verbatim, then normalizes the observed stdout/stderr/status
// into the run record the check consumes. No values are injected and no argv is
// rewritten, so an argument-composition bug reproduces the manager's own
// complaint instead of passing silently.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runtimeHostCommand } from './linux-resources.mjs';
import { isolatedHost, realSystemctlReader } from './linux-resources-fix-fixture.mjs';

test('wave linux: real root-slice property read runs through the production query', async t => {
  const reader = realSystemctlReader();
  const { run, calls, options } = await isolatedHost(t, { systemctlDelegate: reader.delegate });

  const handled = await runtimeHostCommand('check', {}, { ...options });
  const result = handled.result;

  assert.equal(reader.reads.length, 1, 'exactly one root-slice property read was delegated to the real manager');
  const [read] = reader.reads;

  // The delegated record must be the production query, forwarded verbatim.
  assert.equal(read.command, 'systemctl');
  assert.ok(read.args.includes('-.slice'), 'the root slice is queried');
  assert.ok(read.args.includes('--property=MemoryMax'));
  assert.ok(read.args.includes('--property=TasksMax'));
  assert.ok(read.args.includes('--property=CPUWeight'));

  assert.equal(
    read.exitCode,
    0,
    `systemctl ${read.args.join(' ')} exited ${read.exitCode}: ${String(read.stderr).trim() || '<no stderr>'}`
  );

  // The real manager output carries nonempty values for the required names.
  const lines = new Map();
  for (const line of read.stdout.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) lines.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  for (const name of ['MemoryMax', 'TasksMax', 'CPUWeight']) {
    const value = lines.get(name);
    assert.equal(typeof value, 'string', `real manager output named no ${name} value: ${read.stdout}`);
    assert.notEqual(value, '', `real manager reported an empty ${name}`);
  }

  // The parsed properties report an honest partial read: the required names
  // were read from the real manager, so they are supported; the real manager's
  // root slice does not expose RuntimeMaxSec, so it stays explicitly unverified
  // rather than being counted as supported or unsupported.
  assert.equal(result.properties.status, 'unverified', `properties: ${JSON.stringify(result.properties)}`);
  assert.equal(result.properties.source, 'read');
  assert.deepEqual(result.properties.unverified, ['RuntimeMaxSec']);
  assert.deepEqual(result.properties.unsupported, []);
  assert.ok(result.properties.supported.includes('MemoryMax'), `properties: ${JSON.stringify(result.properties)}`);
  assert.ok(result.properties.supported.includes('TasksMax'), `properties: ${JSON.stringify(result.properties)}`);
  assert.ok(result.properties.supported.includes('CPUWeight'), `properties: ${JSON.stringify(result.properties)}`);
});

test('wave linux: real manager argv is forwarded, not substituted', async t => {
  const reader = realSystemctlReader();
  const { calls, options } = await isolatedHost(t, { systemctlDelegate: reader.delegate });

  await runtimeHostCommand('check', {}, { ...options });

  assert.equal(reader.reads.length, 1);
  const [read] = reader.reads;

  // The synthetic transport recorded the same request the check composed; the
  // delegation replaced it with the real record, so the argv is untouched.
  const composed = calls.find(call => call.command === 'systemctl' && call.args.includes('-.slice'));
  assert.ok(composed, 'the check composed a root-slice query');
  assert.deepEqual(read.args, composed.args, 'the real invocation received the composed argv verbatim');

  // A malformed option surfaces the manager's own diagnostics rather than a
  // fabricated success; the observed stderr is what the check would report.
  if (read.exitCode !== 0) {
    assert.notEqual(String(read.stderr).trim(), '', 'a failed real read reports manager stderr');
  }
});
