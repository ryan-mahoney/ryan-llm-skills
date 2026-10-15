// Browser microphone capture for the request media path. This module owns the
// complete device-rate capture pipeline (getUserMedia -> AudioContext ->
// ScriptProcessorNode) and the bounded 30 s / 16 kHz clip semantics: capture
// buffers mono device samples in memory only, caps at the device-rate budget
// derived from REQUEST_LIMITS before downsampling, and every finish path
// (explicit stop, limit auto-stop, cancel, setup failure after acquisition)
// runs one shared cleanup. The media/clock boundary is injectable so tests fake
// only that boundary; production defaults use navigator.mediaDevices,
// AudioContext, performance.now and a setTimeout-based sleep. Audio never
// leaves memory: no persistence, no worklet asset, no recognition dependency,
// and no Node imports.
import { REQUEST_LIMITS } from '../../../workspaces/request-actions.mjs';

const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;
const PENDING_CALLBACK_WAIT_MS = 250;

const MIC_DENIED_MESSAGE = 'microphone permission denied';
const MIC_UNAVAILABLE_MESSAGE = 'microphone unavailable';
const UNSUPPORTED_RATE_MESSAGE = 'unsupported sample rate';
const CAPTURE_CANCELLED_MESSAGE = 'capture cancelled';

type AudioErrorCode = 'mic-denied' | 'mic-unavailable' | 'unsupported-rate' | 'cancelled';

const audioError = (code: AudioErrorCode, message: string): Error & { code: AudioErrorCode } => {
  const error = new Error(message) as Error & { code: AudioErrorCode };
  error.code = code;
  return error;
};

// Minimal structural members of the final browser media/clock boundary; only
// what capture actually touches. Method syntax keeps the real DOM types
// assignable where the production defaults need them.
type MediaTrackLike = {
  stop(): void;
};
type MediaStreamLike = {
  getTracks(): MediaTrackLike[];
};
type TrackConstraintsLike = {
  channelCount: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
};
type MediaDevicesLike = {
  getUserMedia(constraints: { audio: TrackConstraintsLike }): Promise<MediaStreamLike>;
};
type AudioNodeLike = {
  connect(destination: AudioNodeLike): void;
  disconnect(): void;
};
type AudioBufferLike = {
  getChannelData(channel: number): Float32Array;
};
type AudioProcessEventLike = {
  inputBuffer: AudioBufferLike;
};
type AudioProcessHandler = (event: AudioProcessEventLike) => void;
type ScriptProcessorNodeLike = AudioNodeLike & {
  onaudioprocess: AudioProcessHandler | null;
};
type AudioContextLike = {
  sampleRate: number;
  destination: AudioNodeLike;
  createMediaStreamSource(stream: MediaStreamLike): AudioNodeLike;
  createScriptProcessor(
    bufferSize: number,
    inputChannels: number,
    outputChannels: number,
  ): ScriptProcessorNodeLike;
  close(): void;
};

type StartCaptureOptions = {
  onLevel?: (level: number) => void;
  onLimit?: () => void;
  mediaDevices?: MediaDevicesLike;
  createContext?: () => AudioContextLike;
  // Clock readings are milliseconds (the performance.now unit) end to end.
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type CaptureHandle = {
  stop(): Promise<Float32Array>;
  cancel(): void;
};

const requireSupportedRate = (rate: number): number => {
  if (!Number.isFinite(rate) || rate < REQUEST_LIMITS.sampleRateHz) {
    throw audioError('unsupported-rate', UNSUPPORTED_RATE_MESSAGE);
  }
  return rate;
};

// Box-average conversion to the fixed output rate. The output is bounded by
// the shared 30 s budget at the output rate, so the clip can never exceed the
// upload limit.
export const downsampleTo16k = (input: Float32Array, rate: number): Float32Array => {
  requireSupportedRate(rate);
  const outLen = Math.min(
    Math.round((input.length * REQUEST_LIMITS.sampleRateHz) / rate),
    REQUEST_LIMITS.sampleRateHz * REQUEST_LIMITS.recordingSeconds,
  );
  const output = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const start = Math.floor((i * input.length) / outLen);
    const end = Math.floor(((i + 1) * input.length) / outLen);
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    output[i] = sum / (end - start);
  }
  return output;
};

export const levelOf = (samples: Float32Array): number => {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i]);
    if (magnitude > peak) peak = magnitude;
  }
  return Math.min(1, peak);
};

// Device-rate sample budget: the cap applied to buffered device samples before
// downsampling, so the 16 kHz output stays inside the shared limits.
export const limitSamples = (rate: number): number =>
  Math.round(REQUEST_LIMITS.recordingSeconds * requireSupportedRate(rate));

// The clock boundary is milliseconds throughout (performance.now); the sample
// cut converts that elapsed time to seconds explicitly before scaling by rate.
const defaultNow = (): number => performance.now();

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// The DOM AudioContext carries far more members than capture touches; the cast
// keeps the injected boundary minimal and fakes structural.
const defaultCreateContext = (): AudioContextLike =>
  new AudioContext() as unknown as AudioContextLike;

const resolveMediaDevices = (provided?: MediaDevicesLike): MediaDevicesLike => {
  const native = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  const devices = provided ?? native ?? null;
  if (!devices || typeof devices.getUserMedia !== 'function') {
    throw audioError('mic-unavailable', MIC_UNAVAILABLE_MESSAGE);
  }
  return devices;
};

export const startCapture = async (options: StartCaptureOptions = {}): Promise<CaptureHandle> => {
  const onLevel = options.onLevel;
  const onLimit = options.onLimit;
  const now = options.now ?? defaultNow;
  const sleep = options.sleep ?? defaultSleep;
  const mediaDevices = resolveMediaDevices(options.mediaDevices);

  let stream: MediaStreamLike;
  try {
    stream = await mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      throw audioError('mic-denied', MIC_DENIED_MESSAGE);
    }
    throw audioError('mic-unavailable', MIC_UNAVAILABLE_MESSAGE);
  }

  const ownedTracks = stream.getTracks();

  // Track ownership is established before any fallible context or graph
  // initialization; every later failure path runs the shared cleanup below.
  let context: AudioContextLike | null = null;
  let processor: ScriptProcessorNodeLike | null = null;
  let source: AudioNodeLike | null = null;
  let sourceConnected = false;
  let processorConnected = false;
  let cleanedUp = false;
  let cancelled = false;
  let limitFired = false;
  let totalDelivered = 0;
  let chunks: Float32Array[] = [];
  let retainedClip: Float32Array | null = null;
  let finishPromise: Promise<Float32Array> | null = null;

  // One shared cleanup for every finish path; guarded so it runs exactly once.
  // Tolerates a missing context and a partial graph: only created nodes are
  // torn down and only connected nodes are disconnected.
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (processor) {
      processor.onaudioprocess = null;
      if (processorConnected) {
        processor.disconnect();
        processorConnected = false;
      }
    }
    if (source && sourceConnected) {
      source.disconnect();
      sourceConnected = false;
    }
    for (const track of ownedTracks) track.stop();
    context?.close();
  };

  // Context construction and rate validation are cleanup-protected: a throwing
  // context factory or unsupported rate still stops the acquired tracks and
  // closes any created context before the error surfaces.
  let rate: number;
  let budget: number;
  try {
    context = (options.createContext ?? defaultCreateContext)();
    rate = context.sampleRate;
    budget = limitSamples(rate);
  } catch (error) {
    cleanup();
    throw error;
  }

  const startTime = now();

  const finish = async (): Promise<Float32Array> => {
    const stopAt = now();
    // Wait (bounded) for at most one pending audio callback so its pre-stop
    // samples join the buffer before the cut is computed.
    await sleep(PENDING_CALLBACK_WAIT_MS);
    if (cancelled) throw audioError('cancelled', CAPTURE_CANCELLED_MESSAGE);
    let buffered = 0;
    for (const chunk of chunks) buffered += chunk.length;
    // Freeze the end at the explicit stop time: samples at/after the cut from a
    // straddling or late callback are trimmed, and the device slice is capped at
    // the budget before downsampling. now() is milliseconds, so convert the
    // elapsed time to seconds before scaling by the device rate.
    const cut = Math.max(0, Math.min(Math.round(((stopAt - startTime) / 1000) * rate), budget, buffered));
    const deviceClip = new Float32Array(cut);
    let offset = 0;
    for (const chunk of chunks) {
      if (offset >= cut) break;
      const take = Math.min(chunk.length, cut - offset);
      deviceClip.set(chunk.subarray(0, take), offset);
      offset += take;
    }
    const clip = downsampleTo16k(deviceClip, rate);
    retainedClip = clip;
    chunks = [];
    cleanup();
    return clip;
  };

  const ensureFinished = (): Promise<Float32Array> => {
    if (!finishPromise) finishPromise = finish();
    return finishPromise;
  };

  const onAudioProcess = (event: AudioProcessEventLike): void => {
    if (cleanedUp || cancelled) return;
    const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
    const remaining = budget - totalDelivered;
    const take = Math.min(chunk.length, Math.max(0, remaining));
    // Append at most the remaining budget; extra samples never enter the buffer.
    if (take > 0) {
      chunks.push(take === chunk.length ? chunk : chunk.slice(0, take));
      totalDelivered += take;
    }
    onLevel?.(levelOf(chunk));
    if (!limitFired && totalDelivered >= budget) {
      limitFired = true;
      onLimit?.();
      void ensureFinished().catch(() => undefined);
    }
  };

  // Graph setup is cleanup-protected the same way, so a throwing media source
  // or processor step cannot leak the acquired tracks or the created context.
  try {
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1);
    source.connect(processor);
    sourceConnected = true;
    processor.connect(context.destination);
    processorConnected = true;
    processor.onaudioprocess = onAudioProcess;
  } catch (error) {
    cleanup();
    throw error;
  }

  const stop = async (): Promise<Float32Array> => {
    if (cancelled) throw audioError('cancelled', CAPTURE_CANCELLED_MESSAGE);
    await ensureFinished();
    if (!retainedClip) throw audioError('cancelled', CAPTURE_CANCELLED_MESSAGE);
    return retainedClip;
  };

  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    chunks = [];
    retainedClip = null;
    cleanup();
  };

  return { stop, cancel };
};
