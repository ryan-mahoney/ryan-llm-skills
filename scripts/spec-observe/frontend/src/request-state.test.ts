// Step 7 focused transport-boundary cases for request-state. Every case fakes
// ONLY the final transport/media boundaries through createRequestStore options
// (deferred interpret/transcribe promises and a fake capture handle); the real
// store logic, snapshot acceptance, identity minting and derivations in
// ./request-state run throughout. Case coverage maps to the three spec cases:
// - "Real request store/transport snapshot discards stale successes AND errors
//   after edit/scope/new request; unchanged retry keeps UUID."
// - "Exact package owner/prepared coverage derive launchability/Open
//   assignment/Open spec; observation timestamp alone cannot stale
//   relevant-facts signature."
// - "Failure and close retain transcript/clip; close recording cancels tracks;
//   initial idle/typing works without speech setup."
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
import type { RequestReply, RequestSnapshot, SignatureFacts } from './request-state';

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
  const firstReply = { variant: 'proposal', action: 'launchable' };
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
  deferreds[2].resolve({ variant: 'proposal', action: 'launchable' });
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
  deferreds[3].resolve({ variant: 'conversation' });
  await fourth;
  const fifth = store.submitRequest(ws, 'token'); // unchanged retry after settle
  await flush();
  assert.equal(store.getRequest(ws)!.requestId, fourthId);
  assert.equal(interpretCalls.length, 5);
  deferreds[4].resolve({ variant: 'conversation' });
  await fifth;

  // A refs change mints a fresh request identity.
  store.changeRefs(ws, [{ kind: 'spec', id: 'specs/beta' }]);
  assert.notEqual(store.getRequest(ws)!.requestId, fourthId);

  // A new request (explicit discard) discards late replies too.
  const sixth = store.submitRequest(ws, 'token');
  await flush();
  store.discardRequest(ws);
  deferreds[5].resolve({ variant: 'proposal', action: 'launchable' });
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
      return { variant: 'conversation', ...body } as RequestReply;
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
  const reply = { variant: 'proposal', action: 'launchable' };
  pendingReply.resolve(reply);
  assert.equal(await pending, reply);
  state = pendingStore.getRequest(p)!;
  assert.equal(state.result?.variant, 'proposal');
  assert.equal(state.transcript, 'Keep this draft.'); // retained across close
});
