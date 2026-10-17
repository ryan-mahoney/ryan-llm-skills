// Elapsed-time regression for the wave chain/flat metrics diagnostic.
//
// Set SPEC_WAVE_TIMING_REVISION to a git revision to run the identical
// assertions against that revision's baseline: the pre-repair `elapsedMs` arrow
// and chain calculation are read with `git show REV:path` and evaluated alone
// through vm, so the same test body exhibits the latent null-vs-finite defect on
// the baseline and the repair on the working tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = join(here, '..', '..', '..');
const revision = process.env.SPEC_WAVE_TIMING_REVISION || null;

function revisionSource(file) {
  return execFileSync('git', ['show', `${revision}:pi/extensions/spec-runtime/${file}`],
    { cwd: checkout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

// Extract the baseline `const elapsedMs = ...;` arrow through the `chainMs`
// calculation from the integration test's metrics case, inclusive. Nothing
// later in the block is needed, so the standalone integration_ms lookup stays
// out of the evaluated source.
function extractBaselineTiming(source) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.includes('const elapsedMs = record => {'));
  assert.notEqual(start, -1, 'the baseline integration test declares the elapsedMs arrow');
  const end = lines.findIndex((line, index) => index > start && line.includes('const chainMs = '));
  assert.notEqual(end, -1, 'the baseline integration test computes chainMs');
  return lines.slice(start, end + 1).join('\n');
}

const baseline = revision ? extractBaselineTiming(revisionSource('waves.integration.test.mjs')) : null;

// A member record as waves.mjs writes it: durable transitions, no opened_at.
function record(state, at) {
  return { wave_id: `wave-${state}-${at}`, transitions: [{ state, at }] };
}

const OPEN = '2024-01-01T00:00:00.000Z';
const INTEGRATED = '2024-01-01T00:00:01.500Z';
const CHAIN_INTEGRATED = '2024-01-01T00:00:04.500Z';

// A single durable-transition record as waves.mjs writes it.
function singleRecord() {
  const single = record('open', OPEN);
  single.transitions.push({ state: 'integrated', at: INTEGRATED });
  return single;
}

// Three overlapping chain members as waves.mjs writes them.
function chainRecords() {
  return [
    { transitions: [{ state: 'open', at: OPEN }, { state: 'integrated', at: '2024-01-01T00:00:01.500Z' }] },
    { transitions: [{ state: 'open', at: '2024-01-01T00:00:01.500Z' }, { state: 'integrated', at: '2024-01-01T00:00:03.000Z' }] },
    { transitions: [{ state: 'open', at: '2024-01-01T00:00:03.000Z' }, { state: 'integrated', at: CHAIN_INTEGRATED }] },
  ];
}

// Baseline: the arrow and chain calculation are evaluated with genuine bindings
// for the values the copied block closes over, so a null result is the defect
// and not a missing sandbox global.
function runBaseline(records) {
  return vm.runInNewContext(
    `(() => {\n${baseline}\nreturn { flat: elapsedMs(records[0]), chainMs };\n})()`,
    { records, chainRecords: records, readWaveRecord: () => records[0], flat: {} },
    { filename: 'revision:wave-native-timing' },
  );
}

test('wave timing: one wave elapsed time comes from durable transitions, not opened_at', async () => {
  const single = singleRecord();
  assert.equal(single.opened_at, undefined, 'the fixture record carries no opened_at');

  if (!revision) {
    const { elapsedWaveMs } = await import('./wave-native-timing.mjs');
    assert.equal(elapsedWaveMs(single), 1500, 'one wave elapsed is the transition delta');
    return;
  }

  const flatOnly = runBaseline([single]).flat;
  assert.equal(flatOnly, 1500, 'baseline wave elapsed is finite for a durable-transition record');
});

test('wave timing: chain elapsed time spans durable transitions across waves', async () => {
  const records = chainRecords();
  assert.deepEqual(records.map(entry => entry.opened_at), [undefined, undefined, undefined],
    'the fixture records carry no opened_at');

  if (!revision) {
    const { elapsedWaveSetMs } = await import('./wave-native-timing.mjs');
    assert.equal(elapsedWaveSetMs(records), 4500, 'the chain spans min open to max integrated');
    return;
  }

  const chain = runBaseline(records).chainMs;
  assert.equal(chain, 4500, 'baseline chain elapsed is finite across durable-transition records');
});

test('wave timing: invalid durable transitions are rejected, not reported as zero', async () => {
  if (revision) {
    // The baseline has no rejection contract; only the repair is asserted here.
    return;
  }
  const { elapsedWaveMs, elapsedWaveSetMs } = await import('./wave-native-timing.mjs');

  assert.throws(() => elapsedWaveMs({ transitions: [{ state: 'open', at: OPEN }] }),
    'a record without an integrated transition is rejected');
  assert.throws(() => elapsedWaveMs({ transitions: [{ state: 'open', at: 'not-a-date' }, { state: 'integrated', at: INTEGRATED }] }),
    'a record with an unparseable open date is rejected');
  assert.throws(() => elapsedWaveMs({ transitions: [{ state: 'open', at: OPEN }, { state: 'integrated', at: 'not-a-date' }] }),
    'a record with an unparseable integrated date is rejected');
  assert.throws(() => elapsedWaveMs(record('integrated', INTEGRATED)),
    'a record without an open transition is rejected');
  assert.throws(() => elapsedWaveMs({
    transitions: [{ state: 'open', at: INTEGRATED }, { state: 'integrated', at: OPEN }],
  }), 'a record whose integrated transition precedes open is rejected');

  assert.throws(() => elapsedWaveSetMs([]), 'an empty set is rejected');
  assert.throws(() => elapsedWaveSetMs([{ transitions: [{ state: 'open', at: OPEN }] }]),
    'a member without an integrated transition is rejected in a set');
  assert.throws(() => elapsedWaveSetMs([{ transitions: [{ state: 'integrated', at: INTEGRATED }] }]),
    'a member without an open transition is rejected in a set');
});
