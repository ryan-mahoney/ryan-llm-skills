// Absent-bubblewrap fallback regression (step 13, F3).
//
// A host without bubblewrap still gets a property probe and a bounded worktree
// route. The overlay capability is unavailable for the stated reason, the
// fallback stays eligible, and nothing reports the kernel overlay as probed or
// successful. The isolated host is synthetic, so no kernel proof is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';

import { checkRuntimeHost, HOST_REMEDIES } from './linux-resources.mjs';
import { isolatedHost } from './linux-resources-fix-fixture.mjs';

test('wave linux: absent bubblewrap probes properties then falls back to the worktree route', async t => {
  const { run, calls, options } = await isolatedHost(t);

  const result = await checkRuntimeHost({ ...options, probe: true });

  assert.equal(result.route, 'worktree', `expected worktree route: ${result.reason}`);
  assert.ok(result.fallback, 'the worktree fallback metadata is published');
  assert.equal(result.fallback.mode, 'worktree');
  assert.equal(result.fallback.reason, 'bwrap-absent');
  assert.equal(result.fallback.bounded, true);

  assert.equal(result.overlay.status, 'unavailable');
  assert.equal(result.overlay.reason, 'bwrap-absent');
  assert.equal(result.overlay.remedy, HOST_REMEDIES['bwrap-absent']);
  assert.equal(result.overlay.fallbackEligible, true);
  assert.equal(result.overlay.probed, false, 'the kernel overlay is never reported as probed');
  assert.notEqual(result.overlay.status, 'supported');
  assert.equal(result.nativeReady, false);

  // The property probe is independent of overlay availability: the isolated
  // property probe executes and verifies the required unit property set.
  assert.equal(result.properties.source, 'probe');
  assert.equal(result.properties.status, 'supported');
  assert.equal(result.properties.unsupported.length, 0);
  assert.ok(
    calls.some(call => call.command === 'systemd-run' && call.args.some(arg => arg.includes('MemoryMax='))),
    'the property probe command executed'
  );

  // Absent bubblewrap is the only reason; the reason names it, not the probe.
  assert.equal(result.reason, 'bwrap-absent');
});

test('wave linux: unprobed control also reports the overlay unavailable', async t => {
  const { options } = await isolatedHost(t);

  const result = await checkRuntimeHost({ ...options });

  assert.equal(result.overlay.status, 'unavailable');
  assert.equal(result.overlay.reason, 'bwrap-absent');
  assert.equal(result.overlay.probed, false);
  assert.equal(result.overlay.fallbackEligible, true);
  assert.equal(result.route, 'worktree');
  assert.equal(result.fallback.reason, 'bwrap-absent');
  assert.equal(result.nativeReady, false);
});
