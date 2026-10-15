// Step 7 focused transport-boundary cases for request-state. Cases fake
// ONLY the final transport/media boundaries: either through createRequestStore
// options (deferred interpret/transcribe promises and a fake capture handle) or,
// for the default adapters, by controlling the final fetch boundary so the
// route-contract serialization itself runs. The real store logic, snapshot
// acceptance, identity minting and derivations in ./request-state run
// throughout. Case coverage maps to the spec cases plus the step-007 review
// fixes:
// - "Real request store/transport snapshot discards stale successes AND errors
//   after edit/scope/new request; unchanged retry keeps UUID."
// - "Exact package owner/prepared coverage derive launchability/Open
//   assignment/Open spec; observation timestamp alone cannot stale
//   relevant-facts signature."
// - "Failure and close retain transcript/clip; close recording cancels tracks;
//   initial idle/typing works without speech setup."
// - Default adapters translate the route contracts and decode production
//   replies at the fetch boundary (review F1/F2).
// - A retained clip transcribes once; corrected text is authoritative (F3).
// - An accepted recording is a new request-content generation (F4).
// - Deferred acquisition/stop completions are generation-bound (F5).
// - The recording-limit path transcribes only (transcribeClip) and waits for
//   the explicit Interpret request under the clip's existing request identity.
// - Named transcription failure variants retain clip bytes and typed text; the
//   unchanged retry re-sends identical bytes under the same request id.
// - cancelRecording cancels the capture session, discards the audio and never
//   installs late stop bytes; late transcribe outcomes are discarded silently.
// No case waits on real timers: a microtask flush drives the deferred pipeline.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from './api';
import type { WireRecord } from './model';
import {
  createRequestStore,
  deriveProposal,
  pageContext,
  readinessSignature,
  signatureChanged,
} from './request-state';
import type { CaptureHandle, RequestReply, RequestSnapshot, SignatureFacts } from './request-state';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// Microtask drain so the deferred one-microtask submission pipeline has
// started and registered its boundary call; no real waits.
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

// Production-shaped route replies (scripts/spec-observe/request-routes.mjs):
// serveTranscribe replies {request_id, text, seconds}; serveInterpret replies
// {request_id, resolution, candidates, unresolved_references, clarification,
// catalog} with resolution proposal|clarification|unsupported.
const WIRE_ID = '11111111-1111-4111-8111-111111111111';
const wireCatalog = { read_at: '2025-01-01T00:00:00Z', omitted: 0, errors: [] };
const wireCandidate = {
  action: 'implement_spec', workspace: 'demo', entity: 'spec:alpha',
  uses: [], resolved_refs: [], research: { code: 'unspecified' },
  goal: 'Implement alpha', constraints: [],
};
const wireProposal = (requestId: string) => ({
  request_id: requestId,
  resolution: 'proposal',
  candidates: [wireCandidate],
  unresolved_references: [],
  clarification: null,
  catalog: wireCatalog,
});
const wireClarification = (requestId: string) => ({
  request_id: requestId,
  resolution: 'clarification',
  candidates: [],
  unresolved_references: [],
  clarification: { question: 'Which package owns this?', options: ['spec:alpha', 'spec:beta'] },
  catalog: wireCatalog,
});
const wireUnsupported = (requestId: string) => ({
  request_id: requestId,
  resolution: 'unsupported',
  candidates: [],
  unresolved_references: [],
  clarification: null,
  catalog: wireCatalog,
});
const wireSpeech = (requestId: string, speech: string) => ({ request_id: requestId, text: speech, seconds: 1.5 });

test('Real request store/transport snapshot discards stale successes AND errors after edit/scope/new request; unchanged retry keeps UUID.', async () => {
  const ws = 'demo';
  const interpretCalls: RequestSnapshot[] = [];
  const deferreds: Deferred<unknown>[] = [];
  let captures = 0;
  const store = createRequestStore({
    interpret: (body) => {
      interpretCalls.push({ ...body, refs: body.refs.map(reference => ({ ...reference })) });
      const pending = deferred<unknown>();
      deferreds.push(pending);
      return pending.promise;
    },
    transcribe: async () => {
      throw new Error('transcribe must not be touched');
    },
    capture: async () => {
      captures += 1;
      throw new Error('capture must not be touched');
    },
  });

  // A typed transcript is enough to submit; no speech boundary is touched.
  store.editTranscript(ws, 'Build the login screens.');
  const first = store.submitRequest(ws, 'token');
  await flush();
  const firstId = store.getRequest(ws)!.requestId!;
  assert.ok(firstId.length > 0);
  assert.equal(interpretCalls.length, 1);
  assert.equal(interpretCalls[0].requestId, firstId);
  assert.equal(interpretCalls[0].transcript, 'Build the login screens.');

  // A scope change mints a new request identity and the late success is
  // discarded because its captured snapshot no longer matches.
  store.changeScope(ws, { workspace: ws, spec: 'specs/alpha' });
  const scopeId = store.getRequest(ws)!.requestId!;
  assert.notEqual(scopeId, firstId);
  const firstReply = wireProposal(firstId);
  deferreds[0].resolve(firstReply);
  assert.equal(await first, firstReply); // the shared promise still resolves
  let state = store.getRequest(ws)!;
  assert.equal(state.result, null); // late success discarded silently
  assert.equal(state.failure, null);

  // The scope change minted the new identity; submitting that unchanged
  // content reuses it, while a further transcript edit mints another one and
  // discards the late failure.
  const second = store.submitRequest(ws, 'token');
  await flush();
  const secondId = store.getRequest(ws)!.requestId!;
  assert.equal(secondId, scopeId);
  store.editTranscript(ws, 'Build the login screens and the audit trail.');
  assert.notEqual(store.getRequest(ws)!.requestId, secondId);
  deferreds[1].reject(new HttpError(502, 'Request interpretation failed.', 'interpretation-failed'));
  await assert.rejects(second);
  state = store.getRequest(ws)!;
  assert.equal(state.failure, null); // late error discarded silently

  // A settled proposal is retained but marked stale after an edit; the primary
  // action is disabled with a reason string.
  const third = store.submitRequest(ws, 'token');
  await flush();
  deferreds[2].resolve(wireProposal('22222222-2222-4222-8222-222222222222'));
  await third;
  state = store.getRequest(ws)!;
  assert.equal(state.result?.variant, 'proposal');
  assert.equal(state.phase, 'result');
  store.editTranscript(ws, 'Also prepare the export.');
  state = store.getRequest(ws)!;
  assert.equal(state.result?.variant, 'proposal'); // previous proposal retained
  assert.equal(state.stale, true);
  assert.ok((state.staleReason ?? '').length > 0);
  assert.equal(state.primaryAction.enabled, false);
  assert.equal(state.primaryAction.reason, state.staleReason);

  // An unchanged retry keeps the request UUID; a double tap joins the single
  // in-flight call and shares its promise exactly.
  const fourth = store.submitRequest(ws, 'token');
  await flush();
  const fourthId = store.getRequest(ws)!.requestId!;
  assert.equal(interpretCalls.length, 4);
  const fourthTap = store.submitRequest(ws, 'token');
  assert.strictEqual(fourthTap, fourth);
  assert.equal(interpretCalls.length, 4); // joined, not re-sent
  deferreds[3].resolve(wireUnsupported(WIRE_ID));
  await fourth;
  const fifth = store.submitRequest(ws, 'token'); // unchanged retry after settle
  await flush();
  assert.equal(store.getRequest(ws)!.requestId, fourthId);
  assert.equal(interpretCalls.length, 5);
  deferreds[4].resolve(wireUnsupported(WIRE_ID));
  await fifth;

  // A refs change mints a fresh request identity.
  store.changeRefs(ws, [{ kind: 'spec', id: 'specs/beta' }]);
  assert.notEqual(store.getRequest(ws)!.requestId, fourthId);

  // A new request (explicit discard) discards late replies too.
  const sixth = store.submitRequest(ws, 'token');
  await flush();
  store.discardRequest(ws);
  deferreds[5].resolve(wireProposal(WIRE_ID));
  await sixth;
  state = store.getRequest(ws)!;
  assert.equal(state.result, null);
  assert.equal(state.transcript, ''); // discard is the only text clear
  assert.equal(captures, 0);
});

test('Exact package owner/prepared coverage derive launchability/Open assignment/Open spec; observation timestamp alone cannot stale relevant-facts signature.', () => {
  const readyRecord: WireRecord = {
    workspace: 'demo',
    package: 'specs/alpha',
    package_ref: 'specs/alpha',
    requires: [],
    planning: {
      proposal: true, critique: true, critique_recommended: true, prepared: true,
      step_count: 6, preparation: { outcome: 'ok', observed_at: '2025-01-01T00:00:00Z' },
      decision: null, receipts: [{ id: 'r1' }], worktree_recorded: true,
    },
    assignment_coverage: { state: 'complete' },
  };
  const unpreparedRecord: WireRecord = {
    workspace: 'demo',
    package: 'specs/alpha',
    package_ref: 'specs/alpha',
    planning: { prepared: false, step_count: null, preparation: { outcome: 'missing' } },
    assignment_coverage: { state: 'complete' },
  };
  const unknownRecord: WireRecord = { workspace: 'demo', package: 'specs/alpha', package_ref: 'specs/alpha' };
  const missingRecord: WireRecord = { workspace: 'demo', package: 'specs/alpha', status: 'missing' };
  const exactOwner: WireRecord = {
    id: 'a1', workspace: 'demo', spec_package: 'specs/alpha',
    display: 'live', skill: 'spec-end-to-end', observed_at: '2025-01-01T00:00:00Z',
  };

  // Exact workspace + exact canonical package path joins a live blocking owner.
  const owned = deriveProposal({ action: 'implement_spec' }, { record: readyRecord, assignments: [exactOwner] });
  assert.equal(owned.action, 'open-assignment');
  assert.ok((owned.facts.owner ?? '').length > 0);

  // Ready + launchable + complete coverage derives launchability.
  const launchable = deriveProposal({ action: 'implement_spec' }, { record: readyRecord, assignments: [] });
  assert.equal(launchable.action, 'launchable');
  assert.equal(launchable.facts.readiness, 'ready');
  assert.equal(launchable.facts.coverage, 'complete');

  // Unprepared, unknown, missing and incomplete coverage all derive
  // prerequisite-missing (Open spec).
  for (const [record, coverage] of [
    [unpreparedRecord, null],
    [unknownRecord, null],
    [missingRecord, null],
    [readyRecord, { state: 'partial' }],
  ] as const) {
    const decision = deriveProposal({ action: 'implement_spec' }, {
      record, assignments: [], coverage: coverage as WireRecord | null,
    });
    assert.equal(decision.action, 'prerequisite-missing', JSON.stringify(decision.facts));
    assert.ok(decision.reason.length > 0);
  }

  // Wrong workspace or basename-only package matches must NOT join: no
  // open-assignment is derived from them.
  const wrongWorkspace: WireRecord = { ...exactOwner, id: 'a2', workspace: 'other' };
  const basenameOnly: WireRecord = { ...exactOwner, id: 'a3', spec_package: 'alpha' };
  for (const assignment of [wrongWorkspace, basenameOnly]) {
    const notJoined = deriveProposal({ action: 'implement_spec' }, { record: readyRecord, assignments: [assignment] });
    assert.notEqual(notJoined.action, 'open-assignment');
    assert.equal(notJoined.facts.owner, null);
    const fallsThrough = deriveProposal({ action: 'implement_spec' }, { record: unpreparedRecord, assignments: [assignment] });
    assert.equal(fallsThrough.action, 'prerequisite-missing');
  }

  // Build screens additionally requires observed design planning inputs.
  assert.equal(
    deriveProposal({ action: 'build_screens' }, { record: readyRecord, assignments: [] }).action,
    'prerequisite-missing',
  );
  const designed = deriveProposal({ action: 'build_screens' }, {
    record: readyRecord, assignments: [], design: { screens: [{ id: 'overview' }] },
  });
  assert.equal(designed.action, 'launchable');
  assert.equal(designed.facts.designScreens, 1);

  // Observation timestamps alone cannot stale the relevant-facts signature.
  const signatureBase: SignatureFacts = {
    proposal: true, critique: true, critiqueRecommended: true, prepared: true, steps: 6,
    preparation: { outcome: 'ok', observed_at: '2025-01-01T00:00:00Z' },
    prerequisites: [{ name: 'base', state: 'landed' }],
    owner: exactOwner,
    workspace: 'demo', package: 'specs/alpha', target: 'specs/alpha', model: 'openrouter/gpt',
    observedAt: '2025-01-01T00:00:00Z',
  };
  const refreshed: SignatureFacts = {
    ...signatureBase,
    preparation: { outcome: 'ok', observed_at: '2025-04-04T00:00:00Z' },
    owner: { ...exactOwner, observed_at: '2025-04-04T00:00:00Z', published_at: '2025-04-04T00:00:00Z' },
    observedAt: '2025-04-04T00:00:00Z',
    publishedAt: '2025-04-04T00:00:00Z',
  };
  assert.equal(readinessSignature(signatureBase), readinessSignature(refreshed));
  assert.equal(signatureChanged(readinessSignature(signatureBase), readinessSignature(refreshed)), false);

  // Owner, prerequisite and target changes do stale it.
  assert.ok(signatureChanged(
    readinessSignature(signatureBase),
    readinessSignature({ ...signatureBase, owner: { ...exactOwner, id: 'a9' } }),
  ));
  assert.ok(signatureChanged(
    readinessSignature(signatureBase),
    readinessSignature({ ...signatureBase, prerequisites: [{ name: 'base', state: 'unresolved' }] }),
  ));
  assert.ok(signatureChanged(
    readinessSignature(signatureBase),
    readinessSignature({ ...signatureBase, model: 'openrouter/other' }),
  ));

  // The page scope line follows route parameters and demands an explicit
  // workspace instead of guessing among several candidates.
  assert.deepEqual(pageContext({ workspace: 'demo', spec: 'specs/alpha' }).scope, { workspace: 'demo', spec: 'specs/alpha' });
  assert.deepEqual(pageContext({ workspace: 'demo', design: 'designs/checkout' }).scope, { workspace: 'demo', design: 'designs/checkout' });
  const ambiguous = pageContext({ candidates: ['demo', 'other'] });
  assert.equal(ambiguous.scope, null);
  assert.ok((ambiguous.workspaceSelection ?? '').length > 0);
});

test('Failure and close retain transcript/clip; close recording cancels tracks; initial idle/typing works without speech setup.', async () => {
  const clip = new Float32Array([0.1, -0.2, 0.3]);
  let cancels = 0;
  const touched = { capture: 0, transcribe: 0, interpret: 0 };
  const store = createRequestStore({
    capture: async () => {
      touched.capture += 1;
      return {
        stop: async () => clip,
        cancel: () => {
          cancels += 1;
        },
      };
    },
    transcribe: async () => {
      touched.transcribe += 1;
      throw new HttpError(502, 'Speech transcription failed.', 'transcription-failed');
    },
    interpret: async (body) => {
      touched.interpret += 1;
      return wireUnsupported(body.requestId);
    },
  });
  const w = 'demo';

  // Initial idle/typing works without any speech or transport setup touched.
  store.editTranscript(w, 'Type the request without speaking.');
  let state = store.getRequest(w)!;
  assert.equal(state.phase, 'ready');
  assert.equal(state.transcript, 'Type the request without speaking.');
  assert.deepEqual(touched, { capture: 0, transcribe: 0, interpret: 0 });

  // Recording resolves and retains the downsampled clip; a transcription
  // failure retains transcript and clip for retry (step-06 retention contract).
  await store.beginRecording(w);
  state = store.getRequest(w)!;
  assert.equal(state.phase, 'recording');
  assert.equal(state.recording, true);
  await store.finishRecording(w);
  state = store.getRequest(w)!;
  assert.strictEqual(state.clip, clip);
  assert.equal(state.phase, 'ready');
  const failed = store.submitRequest(w, 'token');
  await assert.rejects(failed);
  state = store.getRequest(w)!;
  assert.equal(state.failure, 'transcription-failed');
  assert.equal(state.phase, 'failure');
  assert.equal(state.transcript, 'Type the request without speaking.'); // retained
  assert.strictEqual(state.clip, clip); // retained for retry

  // Close in a non-recording phase retains transcript and clip.
  store.closePanel(w);
  state = store.getRequest(w)!;
  assert.equal(state.transcript, 'Type the request without speaking.');
  assert.strictEqual(state.clip, clip);

  // Close while recording cancels the capture handle; tracks stop inside the
  // request-audio cleanup owned by the cancelled handle.
  await store.beginRecording(w);
  assert.equal(store.getRequest(w)!.recording, true);
  store.closePanel(w);
  assert.equal(cancels, 1);
  state = store.getRequest(w)!;
  assert.equal(state.recording, false);
  assert.equal(state.phase, 'ready');
  assert.equal(state.transcript, 'Type the request without speaking.'); // still retained

  // Close in another phase keeps a pending request running; its reply applies.
  const pendingReply = deferred<RequestReply>();
  const pendingStore = createRequestStore({
    interpret: () => pendingReply.promise,
    transcribe: async () => {
      throw new Error('transcribe must not be touched');
    },
    capture: async () => {
      throw new Error('capture must not be touched');
    },
  });
  const p = 'panel';
  pendingStore.editTranscript(p, 'Keep this draft.');
  const pending = pendingStore.submitRequest(p, 'token');
  await flush();
  pendingStore.closePanel(p);
  assert.equal(pendingStore.getRequest(p)!.pending !== null, true); // not cancelled
  const reply = wireProposal(WIRE_ID);
  pendingReply.resolve(reply);
  assert.equal(await pending, reply);
  state = pendingStore.getRequest(p)!;
  assert.equal(state.result?.variant, 'proposal');
  assert.equal(state.transcript, 'Keep this draft.'); // retained across close
});

test('Default store adapters translate the route contracts and decode production replies at the fetch boundary.', async () => {
  const clip = new Float32Array([0.5, -0.25, 0.125]);
  const requests: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const replies: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    requests.push({ url: String(input), method: init?.method ?? 'GET', headers, body: init?.body });
    const reply = replies.shift() ?? {};
    return Promise.resolve({ ok: true, status: 200, json: async () => reply } as unknown as Response);
  }) as unknown as typeof fetch;
  try {
    const store = createRequestStore({
      // Only the media boundary is faked: transcribe/interpret stay the
      // production defaults so their serialization is what runs.
      capture: async () => ({ stop: async () => clip, cancel: () => undefined }),
    });
    const ws = 'demo';
    store.changeScope(ws, { workspace: 'demo', design: 'designs/checkout' });
    store.changeRefs(ws, [{ kind: 'spec', id: 'alpha' }, { kind: 'material', id: 'plans/plan.md' }]);
    await store.beginRecording(ws);
    await store.finishRecording(ws);
    const requestId = store.getRequest(ws)!.requestId!;
    replies.push(wireSpeech(requestId, 'Build the onboarding screens.'), wireProposal(requestId));
    await store.submitRequest(ws, 'token');

    // serveTranscribe contract: POST the clip's exact sample bytes with the
    // request_id query parameter and the action token.
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, `/api/request/transcribe?request_id=${requestId}`);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].headers['Content-Type'], 'application/octet-stream');
    assert.equal(requests[0].headers['X-Sentinel-Token'], 'token');
    assert.deepEqual(
      new Uint8Array(requests[0].body as ArrayBuffer),
      new Uint8Array(clip.buffer, clip.byteOffset, clip.byteLength),
    );

    // serveInterpret contract: POST {request_id, workspace_id, transcript,
    // context, resolved_refs} with typed reference serialization — not the
    // internal snapshot shape (requestId/scope/refs).
    assert.equal(requests[1].url, '/api/request/interpret');
    assert.equal(requests[1].method, 'POST');
    assert.equal(requests[1].headers['Content-Type'], 'application/json');
    assert.equal(requests[1].headers['X-Sentinel-Token'], 'token');
    assert.deepEqual(JSON.parse(requests[1].body as string), {
      request_id: requestId,
      workspace_id: 'demo',
      transcript: 'Build the onboarding screens.',
      context: { design: 'designs/checkout' },
      resolved_refs: ['spec:alpha', 'material:plans/plan.md'],
    });

    // The production speech reply decodes into the editable transcript and a
    // single-candidate proposal decodes as 'proposal'.
    const state = store.getRequest(ws)!;
    assert.equal(state.transcript, 'Build the onboarding screens.');
    assert.equal(state.result?.variant, 'proposal');

    // Production clarification and unsupported replies decode to their
    // variants at the same boundary.
    store.editTranscript(ws, 'Build the onboarding screens and the audit trail.');
    replies.push(wireClarification(store.getRequest(ws)!.requestId!));
    await store.submitRequest(ws, 'token');
    assert.equal(store.getRequest(ws)!.result?.variant, 'clarification');

    store.editTranscript(ws, 'Tell me about the weather.');
    replies.push(wireUnsupported(store.getRequest(ws)!.requestId!));
    await store.submitRequest(ws, 'token');
    assert.equal(store.getRequest(ws)!.result?.variant, 'conversation');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('A retained clip transcribes once; corrected text interprets without re-running speech; failed transcription retries explicitly.', async () => {
  const clip = new Float32Array([0.1, 0.2]);
  let transcribes = 0;
  let failTranscriptions = 0;
  let failInterpretations = 0;
  const interpreted: string[] = [];
  const store = createRequestStore({
    capture: async () => ({ stop: async () => clip, cancel: () => undefined }),
    transcribe: async () => {
      transcribes += 1;
      if (failTranscriptions > 0) {
        failTranscriptions -= 1;
        throw new HttpError(502, 'Speech transcription failed.', 'transcription-failed');
      }
      return wireSpeech('unused', 'onboarding');
    },
    interpret: async (body) => {
      interpreted.push(body.transcript);
      if (failInterpretations > 0) {
        failInterpretations -= 1;
        throw new HttpError(502, 'Request interpretation failed.', 'interpretation-failed');
      }
      return wireProposal(body.requestId);
    },
  });
  const ws = 'demo';
  await store.beginRecording(ws);
  await store.finishRecording(ws);
  await store.submitRequest(ws, 'token');
  assert.equal(transcribes, 1);
  assert.deepEqual(interpreted, ['onboarding']);

  // The operator corrects the transcript; the retained clip must not
  // overwrite it on the next submission.
  store.editTranscript(ws, 'billing');
  await store.submitRequest(ws, 'token');
  assert.equal(transcribes, 1);
  assert.deepEqual(interpreted, ['onboarding', 'billing']);

  // An interpretation-only retry runs without requiring speech again.
  failInterpretations = 1;
  await assert.rejects(store.submitRequest(ws, 'token'));
  await store.submitRequest(ws, 'token');
  assert.equal(transcribes, 1);
  assert.deepEqual(interpreted, ['onboarding', 'billing', 'billing', 'billing']);

  // A failed transcription retries explicitly against the retained clip and
  // the true retry keeps the clip's request identity.
  failTranscriptions = 1;
  store.discardRequest(ws);
  await store.beginRecording(ws);
  await store.finishRecording(ws);
  const clipId = store.getRequest(ws)!.requestId!;
  await assert.rejects(store.submitRequest(ws, 'token'));
  assert.equal(store.getRequest(ws)!.failure, 'transcription-failed');
  assert.strictEqual(store.getRequest(ws)!.clip, clip); // retained for retry
  assert.equal(transcribes, 2);
  await store.submitRequest(ws, 'token'); // explicit transcription retry
  assert.equal(transcribes, 3);
  assert.equal(store.getRequest(ws)!.transcript, 'onboarding');
  assert.equal(store.getRequest(ws)!.requestId, clipId);
});

test('Accepting a new recording is a new request-content generation; a true retry of the same clip keeps its identity.', async () => {
  const clips = [new Float32Array([1]), new Float32Array([2]), new Float32Array([3])];
  let clipIndex = 0;
  const deferreds: Deferred<unknown>[] = [];
  const transcribed: (Float32Array | undefined)[] = [];
  const store = createRequestStore({
    capture: async () => {
      const clip = clips[clipIndex++];
      return { stop: async () => clip, cancel: () => undefined };
    },
    transcribe: async (clip) => {
      transcribed.push(clip);
      return wireSpeech('unused', 'spoken');
    },
    interpret: () => {
      const pending = deferred<unknown>();
      deferreds.push(pending);
      return pending.promise;
    },
  });
  const ws = 'demo';
  store.editTranscript(ws, 'Keep this text.');
  await store.beginRecording(ws);
  await store.finishRecording(ws);
  const first = store.submitRequest(ws, 'token');
  await flush();
  const firstId = store.getRequest(ws)!.requestId!;

  // Recording B completing while request A is pending is a new content
  // generation: A's late reply loses acceptance and B has its own identity.
  await store.beginRecording(ws);
  await store.finishRecording(ws);
  const secondId = store.getRequest(ws)!.requestId!;
  assert.notEqual(secondId, firstId);
  deferreds[0].resolve(wireProposal(firstId));
  await first;
  assert.equal(store.getRequest(ws)!.result, null); // late success discarded silently

  // Submitting B uses the new identity and the new clip.
  const second = store.submitRequest(ws, 'token');
  await flush();
  assert.equal(store.getRequest(ws)!.requestId, secondId);
  assert.strictEqual(transcribed[1], clips[1]);
  deferreds[1].resolve(wireProposal(secondId));
  await second;
  assert.equal(store.getRequest(ws)!.result?.variant, 'proposal');

  // An accepted proposal goes stale when new audio is recorded; the primary
  // action is disabled and the identity is minted again.
  await store.beginRecording(ws);
  await store.finishRecording(ws);
  const state = store.getRequest(ws)!;
  assert.equal(state.stale, true);
  assert.equal(state.primaryAction.enabled, false);
  assert.notEqual(state.requestId, secondId);

  // A true retry of the same clip keeps its identity (double tap joins too).
  const third = store.submitRequest(ws, 'token');
  await flush();
  const thirdId = store.getRequest(ws)!.requestId!;
  assert.strictEqual(store.submitRequest(ws, 'token'), third);
  deferreds[2].resolve(wireProposal(thirdId));
  await third;
  const fourth = store.submitRequest(ws, 'token'); // unchanged retry after settle
  await flush();
  assert.equal(store.getRequest(ws)!.requestId, thirdId);
  deferreds[3].resolve(wireProposal(thirdId));
  await fourth;
});

test('Deferred capture acquisition and stop completions are bound to their recording generation.', async () => {
  const ws = 'demo';
  let cancels = 0;
  let captures = 0;
  const acquisitions: Deferred<CaptureHandle>[] = [];
  const handleOf = (stop: () => Promise<Float32Array>): CaptureHandle => ({
    stop,
    cancel: () => {
      cancels += 1;
    },
  });
  const store = createRequestStore({
    capture: () => {
      captures += 1;
      const pending = deferred<CaptureHandle>();
      acquisitions.push(pending);
      return pending.promise;
    },
    transcribe: async () => wireSpeech('unused', 'spoken'),
    interpret: async (body) => wireProposal(body.requestId),
  });

  // One acquisition at a time: a second beginRecording cannot orphan the
  // first handle.
  const begun = store.beginRecording(ws);
  await flush();
  assert.equal(captures, 1);
  await store.beginRecording(ws);
  assert.equal(captures, 1);

  // closePanel invalidates an in-flight acquisition: the late handle is
  // cancelled, never installed, and the latch frees for a fresh recording.
  store.closePanel(ws);
  acquisitions[0].resolve(handleOf(async () => new Float32Array([9])));
  await begun;
  assert.equal(cancels, 1);
  assert.equal(store.getRequest(ws)!.recording, false);
  assert.equal(store.getRequest(ws)!.phase, 'ready');

  // discardRequest during an acquisition does the same and keeps the cleared
  // state; the late acquisition cannot install a recording phase.
  const discarded = store.beginRecording(ws);
  await flush();
  store.discardRequest(ws);
  acquisitions[1].resolve(handleOf(async () => new Float32Array([8])));
  await discarded;
  assert.equal(cancels, 2);
  assert.equal(store.getRequest(ws)!.clip, null);
  assert.equal(store.getRequest(ws)!.phase, 'ready');

  // A late stop after discardRequest can never restore the discarded bytes.
  const stop = deferred<Float32Array>();
  const recording = store.beginRecording(ws);
  await flush();
  acquisitions[2].resolve(handleOf(() => stop.promise));
  await recording;
  const finishing = store.finishRecording(ws);
  await flush();
  store.discardRequest(ws);
  stop.resolve(new Float32Array([7]));
  await finishing;
  assert.equal(store.getRequest(ws)!.clip, null);
  assert.equal(store.getRequest(ws)!.transcript, '');
  assert.equal(store.getRequest(ws)!.phase, 'ready');

  // Closing during the stop wait cancels that unsettled recording too (the
  // close-while-recording contract) and leaves no dangling recording phase.
  const stopTwo = deferred<Float32Array>();
  const recordingTwo = store.beginRecording(ws);
  await flush();
  acquisitions[3].resolve(handleOf(() => stopTwo.promise));
  await recordingTwo;
  const finishingTwo = store.finishRecording(ws);
  await flush();
  store.closePanel(ws);
  assert.equal(store.getRequest(ws)!.phase, 'ready');
  stopTwo.resolve(new Float32Array([6]));
  await finishingTwo;
  assert.equal(store.getRequest(ws)!.clip, null);
});

test('Recording limit auto-transcribes only: transcribeClip installs spoken text and waits for the explicit Interpret request.', async () => {
  const clip = new Float32Array([0.4, -0.1, 0.2]);
  const levels: number[] = [];
  let limitFired = 0;
  let transcribes = 0;
  let interprets = 0;
  const sent: { clip: Float32Array | undefined; requestId: string }[] = [];
  const store = createRequestStore({
    capture: (hooks) => {
      hooks?.onLevel?.(0.5);
      hooks?.onLevel?.(0.75);
      hooks?.onLimit?.();
      return Promise.resolve({ stop: async () => clip, cancel: () => undefined });
    },
    transcribe: (seenClip, requestId) => {
      transcribes += 1;
      sent.push({ clip: seenClip, requestId });
      return Promise.resolve(wireSpeech(requestId, 'spoken limit text'));
    },
    interpret: () => {
      interprets += 1;
      return Promise.resolve(wireProposal(WIRE_ID));
    },
  });
  const ws = 'demo';

  // The capture level/limit hooks reach the capture boundary.
  await store.beginRecording(ws, {
    onLevel: level => { levels.push(level); },
    onLimit: () => { limitFired += 1; },
  });
  assert.deepEqual(levels, [0.5, 0.75]);
  assert.equal(limitFired, 1);
  await store.finishRecording(ws);
  const clipId = store.getRequest(ws)!.requestId!;
  assert.strictEqual(store.getRequest(ws)!.clip, clip);

  // The limit path transcribes only: one boundary call carrying the clip's
  // identity and exact bytes; the double tap shares the same promise.
  const first = store.transcribeClip(ws, 'token');
  assert.strictEqual(store.transcribeClip(ws, 'token'), first);
  const state = await first;
  assert.equal(transcribes, 1);
  assert.strictEqual(sent[0].clip, clip);
  assert.equal(sent[0].requestId, clipId);
  assert.equal(interprets, 0); // waits for the explicit Interpret request
  assert.equal(state.transcript, 'spoken limit text');
  assert.equal(state.phase, 'ready');
  assert.equal(state.clipNeedsTranscription, false);
  assert.strictEqual(state.clip, clip); // retained bytes serve recovery only
  assert.equal(state.requestId, clipId); // the clip identity is unchanged

  // An unchanged retry resolves the current view without re-sending.
  const retry = await store.transcribeClip(ws, 'token');
  assert.equal(transcribes, 1);
  assert.equal(interprets, 0);
  assert.equal(retry.requestId, clipId);
  assert.equal(retry.transcript, 'spoken limit text');
});

test('Transcribe-only failure variants retain the clip and typed text; the unchanged retry re-sends identical bytes under the same request id.', async () => {
  const clip = new Float32Array([0.9, 0.1]);
  let transcribes = 0;
  let interprets = 0;
  const sent: { clip: Float32Array | undefined; requestId: string }[] = [];
  const outcomes: (Error | null)[] = [
    new HttpError(502, 'Speech transcription failed.', 'transcription-failed'),
    new HttpError(422, 'No speech found in the recording.', 'no-speech'),
    null,
  ];
  const store = createRequestStore({
    capture: async () => ({ stop: async () => clip, cancel: () => undefined }),
    transcribe: (seenClip, requestId) => {
      transcribes += 1;
      sent.push({ clip: seenClip, requestId });
      const failure = outcomes.shift() ?? null;
      if (failure) throw failure;
      return Promise.resolve(wireSpeech(requestId, 'recovered speech'));
    },
    interpret: () => {
      interprets += 1;
      return Promise.resolve(wireProposal(WIRE_ID));
    },
  });
  const ws = 'demo';
  store.editTranscript(ws, 'Keep this typed draft.');
  await store.beginRecording(ws);
  await store.finishRecording(ws);
  const clipId = store.getRequest(ws)!.requestId!;

  // Named failure variants set from the boundary error; bytes and typed text
  // are retained so the retry can re-send the same clip.
  await assert.rejects(store.transcribeClip(ws, 'token'));
  let state = store.getRequest(ws)!;
  assert.equal(state.failure, 'transcription-failed');
  assert.equal(state.phase, 'failure');
  assert.strictEqual(state.clip, clip);
  assert.equal(state.clipNeedsTranscription, true);
  assert.equal(state.transcript, 'Keep this typed draft.');
  assert.equal(state.requestId, clipId);

  // The unchanged retry re-sends the exact same bytes under the same request
  // id; the no-speech variant maps the same way and still retains the clip.
  await assert.rejects(store.transcribeClip(ws, 'token'));
  state = store.getRequest(ws)!;
  assert.equal(state.failure, 'no-speech');
  assert.strictEqual(state.clip, clip);
  assert.equal(transcribes, 2);
  assert.strictEqual(sent[1].clip, clip);
  assert.equal(sent[1].requestId, clipId);

  // The eventual success installs the spoken text and still waits for the
  // explicit Interpret request.
  const recovered = await store.transcribeClip(ws, 'token');
  assert.equal(transcribes, 3);
  assert.strictEqual(sent[2].clip, clip);
  assert.equal(sent[2].requestId, clipId);
  assert.equal(interprets, 0);
  assert.equal(recovered.failure, null);
  assert.equal(recovered.transcript, 'recovered speech');
  assert.equal(recovered.phase, 'ready');
  assert.equal(recovered.clipNeedsTranscription, false);
});

test('Cancel recording cancels the capture session, discards the audio and keeps typed text; a late stop never installs bytes.', async () => {
  const ws = 'demo';
  const clip = new Float32Array([2, 3]);
  let cancels = 0;
  const acquisitions: Deferred<CaptureHandle>[] = [];
  const handleOf = (stop: () => Promise<Float32Array>): CaptureHandle => ({
    stop,
    cancel: () => {
      cancels += 1;
    },
  });
  const store = createRequestStore({
    capture: () => {
      const pending = deferred<CaptureHandle>();
      acquisitions.push(pending);
      return pending.promise;
    },
    transcribe: async () => {
      throw new Error('transcribe must not be touched');
    },
    interpret: async () => {
      throw new Error('interpret must not be touched');
    },
  });
  store.editTranscript(ws, 'Keep this typed draft.');

  // A retained clip exists from an earlier recording.
  const recording = store.beginRecording(ws);
  await flush();
  acquisitions[0].resolve(handleOf(async () => clip));
  await recording;
  await store.finishRecording(ws);
  assert.strictEqual(store.getRequest(ws)!.clip, clip);
  assert.equal(store.getRequest(ws)!.clipNeedsTranscription, true);
  const clipId = store.getRequest(ws)!.requestId!;

  // Cancel while recording: the in-flight handle's cancel() is observed and
  // the retained audio is discarded without touching typed text or identity.
  const active = store.beginRecording(ws);
  await flush();
  acquisitions[1].resolve(handleOf(async () => new Float32Array([9])));
  await active;
  const cancelled = store.cancelRecording(ws);
  assert.equal(cancels, 1);
  assert.equal(cancelled.recording, false);
  assert.equal(cancelled.clip, null);
  assert.equal(cancelled.clipNeedsTranscription, false);
  assert.equal(cancelled.transcript, 'Keep this typed draft.');
  assert.equal(cancelled.phase, 'ready');
  assert.equal(cancelled.requestId, clipId); // no contentChanged minting

  // A stop() resolving after cancel never installs clip bytes.
  const stop = deferred<Float32Array>();
  const recordingTwo = store.beginRecording(ws);
  await flush();
  acquisitions[2].resolve(handleOf(() => stop.promise));
  await recordingTwo;
  const finishing = store.finishRecording(ws);
  await flush();
  store.cancelRecording(ws);
  stop.resolve(new Float32Array([7, 7]));
  await finishing;
  const state = store.getRequest(ws)!;
  assert.equal(state.clip, null);
  assert.equal(state.clipNeedsTranscription, false);
  assert.equal(state.phase, 'ready');
  assert.equal(state.transcript, 'Keep this typed draft.');
  assert.equal(state.requestId, clipId);

  // Cancel during an in-flight acquisition cancels the late handle and never
  // installs a recording.
  const pending = store.beginRecording(ws);
  await flush();
  store.cancelRecording(ws);
  acquisitions[3].resolve(handleOf(async () => new Float32Array([5])));
  await pending;
  assert.equal(cancels, 2);
  assert.equal(store.getRequest(ws)!.recording, false);
  assert.equal(store.getRequest(ws)!.phase, 'ready');
});

test('A late transcribeClip outcome after a content change or clip discard is discarded silently.', async () => {
  const clip = new Float32Array([0.6]);
  const transcriptions: Deferred<unknown>[] = [];
  const store = createRequestStore({
    capture: async () => ({ stop: async () => clip, cancel: () => undefined }),
    transcribe: () => {
      const pending = deferred<unknown>();
      transcriptions.push(pending);
      return pending.promise;
    },
    interpret: async (body) => wireProposal(body.requestId),
  });
  const ws = 'demo';

  // A content change mid-flight discards the late spoken text.
  await store.beginRecording(ws);
  await store.finishRecording(ws);
  const first = store.transcribeClip(ws, 'token');
  await flush();
  store.editTranscript(ws, 'Operator typed instead.');
  transcriptions[0].resolve(wireSpeech('unused', 'late spoken text'));
  await first;
  let state = store.getRequest(ws)!;
  assert.equal(state.transcript, 'Operator typed instead.'); // late speech discarded
  assert.equal(state.failure, null);
  // The clip was transcribed once, so corrected text stays authoritative.
  assert.equal(state.clipNeedsTranscription, false);

  // A clip discard mid-flight does the same and keeps the cleared state.
  await store.beginRecording(ws);
  await store.finishRecording(ws);
  const second = store.transcribeClip(ws, 'token');
  await flush();
  store.discardRequest(ws);
  transcriptions[1].resolve(wireSpeech('unused', 'late spoken text'));
  await second;
  state = store.getRequest(ws)!;
  assert.equal(state.transcript, '');
  assert.equal(state.clip, null);
  assert.equal(state.phase, 'ready');
  assert.equal(state.failure, null);
});
