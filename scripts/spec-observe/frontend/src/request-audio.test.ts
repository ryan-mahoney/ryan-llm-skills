// Step 6 focused capture-boundary cases for request-audio. Every case injects
// only the final media/clock boundary: a fake getUserMedia stream with counting
// tracks, a fake AudioContext/ScriptProcessor node whose onaudioprocess the
// case drives with fake input buffers, and fake now()/sleep(); the production
// capture implementation in ./request-audio is never patched. Case coverage
// maps to the two spec cases:
// - "Hand-derived 48kHz vectors averages and 44.1kHz output length match; stop
//   includes pending pre-stop buffer and trims later samples"
// - "At 30 seconds one limit fires, output<=480000 samples, tracks/context
//   clean once; denied/no-device maps visibly; retry retains exact clip"
// All expected vectors are hand-derived in the assertions, and the injected
// sleep delivers the pending callback and completes immediately so no case
// waits on real timers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REQUEST_LIMITS } from '../../../workspaces/request-actions.mjs';
import { downsampleTo16k, levelOf, limitSamples, startCapture } from './request-audio';

type FakeProcessHandler = (event: {
  inputBuffer: { getChannelData(channel: number): Float32Array };
}) => void;

const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

const sampleChunk = (base: number, length: number): Float32Array => {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i += 1) samples[i] = base + i;
  return samples;
};

const makeHarness = (sampleRate: number) => {
  let clock = 0;
  let closeCount = 0;
  let sleepAction: (() => void) | null = null;
  const sleepCalls: number[] = [];
  const trackStops = [0, 0];
  const tracks = trackStops.map((_, index) => ({
    stop: () => {
      trackStops[index] += 1;
    },
  }));
  const stream = { getTracks: () => tracks };
  const node = () => ({ connect: () => undefined, disconnect: () => undefined });
  const processor = {
    connect: () => undefined,
    disconnect: () => undefined,
    onaudioprocess: null as FakeProcessHandler | null,
  };
  const context = {
    sampleRate,
    destination: node(),
    createMediaStreamSource: () => node(),
    createScriptProcessor: () => processor,
    close: async () => {
      closeCount += 1;
    },
  };
  return {
    mediaDevices: { getUserMedia: async () => stream },
    createContext: () => context,
    now: () => clock,
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      const action = sleepAction;
      sleepAction = null;
      if (action) action();
      return Promise.resolve();
    },
    deliver: (samples: Float32Array) => {
      clock += samples.length / sampleRate;
      processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
    },
    setClock: (value: number) => {
      clock = value;
    },
    onSleep: (action: () => void) => {
      sleepAction = action;
    },
    trackStops,
    sleepCalls,
    closeCount: () => closeCount,
  };
};

const startFakeCapture = (harness: ReturnType<typeof makeHarness>, onLimit?: () => void) =>
  startCapture({
    mediaDevices: harness.mediaDevices,
    createContext: harness.createContext,
    now: harness.now,
    sleep: harness.sleep,
    onLimit,
  });

test('Hand-derived 48kHz vectors averages and 44.1kHz output length match', () => {
  const outputs = downsampleTo16k(new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 48000);
  // Hand-derived: out[i] = mean of input[3i..3i+2] = 3i + 1.
  assert.deepEqual(Array.from(outputs), [1, 4, 7, 10]);

  const wideOut = downsampleTo16k(sampleChunk(0, 1000), 44100);
  assert.equal(wideOut.length, 363);
  assert.equal(wideOut.length, Math.round((1000 * REQUEST_LIMITS.sampleRateHz) / 44100));

  assert.equal(levelOf(new Float32Array([0, -0.25, 0.5, -0.125])), 0.5);
  assert.equal(levelOf(new Float32Array([0.25, -2.5])), 1);
  assert.equal(levelOf(new Float32Array(0)), 0);
  assert.equal(limitSamples(48000), REQUEST_LIMITS.recordingSeconds * 48000);
});

test('stop includes pending pre-stop buffer and trims later samples', async () => {
  const harness = makeHarness(48000);
  const capture = await startFakeCapture(harness);

  harness.deliver(sampleChunk(0, 4096));
  // Freeze the stop 0.128 s in: cut = round(0.128 * 48000) = 6144 device
  // samples, mid-way through the second (pending) callback.
  harness.setClock(0.128);
  harness.onSleep(() => {
    harness.deliver(sampleChunk(4096, 4096));
  });
  const clip = await capture.stop();

  // Hand-derived: samples [0, 6144) box-average to out[i] = 3i + 1.
  assert.equal(clip.length, 2048);
  for (let i = 0; i < clip.length; i += 1) assert.equal(clip[i], 3 * i + 1);
  assert.equal(clip[clip.length - 1], 6142); // last kept sample is 6143; later ones trimmed
  assert.deepEqual(harness.sleepCalls, [250]);
  assert.deepEqual(harness.trackStops, [1, 1]);
  assert.equal(harness.closeCount(), 1);

  harness.deliver(sampleChunk(8192, 4096)); // late callback after cleanup is ignored
  assert.deepEqual(harness.trackStops, [1, 1]);
  assert.equal(harness.closeCount(), 1);
});

test('At 30 seconds one limit fires, output<=480000 samples, tracks/context clean once', async () => {
  const harness = makeHarness(48000);
  let limitCount = 0;
  const capture = await startFakeCapture(harness, () => {
    limitCount += 1;
  });

  // 351 full callbacks reach 1437696 samples; the 352nd is truncated to the
  // limitSamples(48000) = 1440000 budget, the 353rd adds nothing.
  for (let n = 0; n < 353; n += 1) harness.deliver(sampleChunk(n * 4096, 4096));
  const clip = await capture.stop();

  assert.equal(limitCount, 1);
  assert.equal(clip.length, 480000);
  for (let i = 0; i < clip.length; i += 1) assert.equal(clip[i], 3 * i + 1);
  assert.ok(clip.length * 4 <= REQUEST_LIMITS.maxAudioBytes);
  assert.deepEqual(harness.trackStops, [1, 1]);
  assert.equal(harness.closeCount(), 1);

  capture.cancel(); // cleanup must not run twice
  assert.deepEqual(harness.trackStops, [1, 1]);
  assert.equal(harness.closeCount(), 1);
});

test('denied/no-device maps visibly', async () => {
  const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  await assert.rejects(
    startCapture({ mediaDevices: { getUserMedia: async () => { throw denied; } } }),
    (error: unknown) => errorCode(error) === 'mic-denied',
  );

  const noDevice = Object.assign(new Error('missing'), { name: 'NotFoundError' });
  await assert.rejects(
    startCapture({ mediaDevices: { getUserMedia: async () => { throw noDevice; } } }),
    (error: unknown) => errorCode(error) === 'mic-unavailable',
  );

  await assert.rejects(startCapture({}), (error: unknown) => errorCode(error) === 'mic-unavailable');

  const harness = makeHarness(8000);
  await assert.rejects(startFakeCapture(harness), (error: unknown) => errorCode(error) === 'unsupported-rate');
  assert.deepEqual(harness.trackStops, [1, 1]); // acquired tracks stopped once
  assert.equal(harness.closeCount(), 1);

  assert.throws(
    () => downsampleTo16k(new Float32Array(4), 8000),
    (error: unknown) => errorCode(error) === 'unsupported-rate',
  );
  assert.throws(() => limitSamples(8000), (error: unknown) => errorCode(error) === 'unsupported-rate');
});

test('retry retains exact clip', async () => {
  const harness = makeHarness(48000);
  const capture = await startFakeCapture(harness);
  harness.deliver(sampleChunk(0, 4096));
  harness.setClock(1); // cut = min(48000, budget, 4096) = 4096 device samples
  const clipA = await capture.stop();
  const clipB = await capture.stop();
  assert.equal(clipB, clipA); // identical retained clip values for transcription retry
  assert.equal(clipA.length, 1365); // round(4096 * 16000 / 48000)
});

test('cancel drops them', async () => {
  const harness = makeHarness(48000);
  const capture = await startFakeCapture(harness);
  harness.deliver(sampleChunk(0, 4096));
  harness.setClock(1);
  const clip = await capture.stop();
  assert.ok(clip.length > 0);
  capture.cancel();
  capture.cancel(); // second cancel is a no-op
  await assert.rejects(capture.stop(), (error: unknown) => errorCode(error) === 'cancelled');
  assert.deepEqual(harness.trackStops, [1, 1]);
  assert.equal(harness.closeCount(), 1);
});
