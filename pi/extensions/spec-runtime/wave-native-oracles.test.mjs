// EV-13 native wave oracle unit proof (step-013-subspec.md).
//
// These cases pin the two durable-record helpers the native wave cases use:
// the integrated timestamp oracle must be the persisted transition value (never
// the test's own observation time), and the stage-worker selector must keep
// every real worker — including a resumed reviewer — while excluding bound
// `command_phase` records and records bound to other waves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { integratedWaveAt, waveWorkerRuns } from './wave-native-oracles.mjs';

function waveRecord(transitions, extra = {}) {
  return { wave_id: 'wave-1', state: 'integrated', transitions, ...extra };
}

test('integratedWaveAt returns the persisted integrated timestamp', () => {
  const record = waveRecord([
    { state: 'open', at: '2026-02-01T10:00:00.000Z' },
    { state: 'integrated', at: '2026-02-01T10:05:00.000Z' },
  ]);
  assert.equal(integratedWaveAt(record), Date.parse('2026-02-01T10:05:00.000Z'));
  // Observed much later, the oracle still reports the persisted value.
  assert.notEqual(integratedWaveAt(record), Date.now());
});

test('integratedWaveAt uses the last integrated transition', () => {
  const record = waveRecord([
    { state: 'open', at: '2026-02-01T10:00:00.000Z' },
    { state: 'integrated', at: '2026-02-01T10:05:00.000Z' },
    { state: 'open', at: '2026-02-01T10:10:00.000Z' },
    { state: 'integrated', at: '2026-02-01T10:15:00.000Z' },
  ]);
  assert.equal(integratedWaveAt(record), Date.parse('2026-02-01T10:15:00.000Z'));
});

test('integratedWaveAt rejects an absent integrated timestamp', () => {
  assert.throws(() => integratedWaveAt(waveRecord([
    { state: 'open', at: '2026-02-01T10:00:00.000Z' },
  ])), /no integrated transition/);
  assert.throws(() => integratedWaveAt(waveRecord([{ state: 'integrated' }])),
    /integrated transition has no timestamp/);
});

test('integratedWaveAt rejects an invalid integrated timestamp', () => {
  assert.throws(() => integratedWaveAt(waveRecord([
    { state: 'integrated', at: 'not-a-timestamp' },
  ])), /not parseable/);
});

test('integratedWaveAt rejects a non-record', () => {
  assert.throws(() => integratedWaveAt(null), /is not a wave record/);
});

test('waveWorkerRuns keeps both reviewers including the resumed one and the implementing run', () => {
  const runs = [
    {
      id: '4488a72d',
      command_phase: { purpose: 'seal', stage: null, assignment_id: null },
      wave_bindings: { wave_id: 'wave-1', step_number: 1 },
    },
    {
      id: '05e242b1',
      wave_bindings: {
        wave_id: 'wave-1', step_number: 1, phase: 'reviewing', stage: { role: 'reviewer', attempt: 1 },
      },
    },
    {
      id: 'd9b5c8a9',
      wave_bindings: {
        wave_id: 'wave-1', step_number: 1, phase: 'reviewing', stage: { role: 'reviewer', attempt: 1, resumed: true },
      },
    },
    {
      id: 'implementing-1',
      wave_bindings: { wave_id: 'wave-1', step_number: 1, phase: 'implementing' },
    },
    {
      id: 'other-wave',
      command_phase: null,
      wave_bindings: { wave_id: 'wave-2', step_number: 1, phase: 'implementing' },
    },
  ];
  const selected = waveWorkerRuns(runs, 'wave-1');
  assert.deepEqual(selected.map(run => run.id), ['05e242b1', 'd9b5c8a9', 'implementing-1']);
  assert.equal(selected.filter(run => run.wave_bindings.phase === 'reviewing').length, 2,
    'both reviewer workers are retained, including the resumed one');
  assert.equal(selected.filter(run => run.wave_bindings.phase === 'implementing').length, 1,
    'the implementing worker is retained');
  assert.deepEqual(selected.filter(run => run.command_phase), [], 'the bound seal command is excluded');
});

test('waveWorkerRuns keeps a third actual reviewer in the selection', () => {
  const reviewer = id => ({
    id,
    wave_bindings: {
      wave_id: 'wave-1', step_number: 1, phase: 'reviewing', stage: { role: 'reviewer', attempt: 1 },
    },
  });
  const runs = [reviewer('a'), reviewer('b'), reviewer('c')];
  const selected = waveWorkerRuns(runs, 'wave-1');
  assert.equal(selected.length, 3, 'three actual reviewers all remain in the selection');
  assert.deepEqual(selected.map(run => run.id), ['a', 'b', 'c']);
});

test('waveWorkerRuns rejects non-array input and a missing wave id', () => {
  assert.throws(() => waveWorkerRuns(null, 'wave-1'), /needs an array of run records/);
  assert.throws(() => waveWorkerRuns([], ''), /needs a wave id/);
});
