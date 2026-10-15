// Step 6 focused store-boundary cases for launch-state. Each case builds a
// fresh createLaunchStore() and scopes a fake fetch whose responses resolve
// from explicit deferred slots; the previous fetch is restored after every
// case and no case uses timers or sleeps. Package target preparation is
// acknowledged separately before the deferred preview; launch-client.test.ts
// keeps its exact ordering/body coverage and the
// adapter decoding/normalization coverage; these cases assert store identity
// and transition behavior plus the exact bodies the real adapter submits
// (displayed digest and minted UUIDs).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { HttpError } from './api';
import {
  contextKey,
  createLaunchStore,
  normalizeLaunchStop,
  resolveLaunchStage,
  type LaunchContext,
  type LaunchDraft,
  type LaunchReviewStatus,
  type LaunchStore,
} from './launch-state';

const TOKEN = 'test-action-token';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

type CapturedCall = { url: string; body: any; init: RequestInit };

class DeferredResponse {
  readonly promise: Promise<Response>;
  private settle!: (response: Response) => void;
  private fail!: (error: unknown) => void;
  constructor() {
    this.promise = new Promise<Response>((resolve, reject) => { this.settle = resolve; this.fail = reject; });
  }
  resolve(response: Response): void { this.settle(response); }
  reject(error: unknown): void { this.fail(error); }
}

type FetchScope = {
  calls: CapturedCall[];
  reply: (index: number, response: Response) => void;
  fail: (index: number, error: unknown) => void;
};

function scopeFetch(t: TestContext): FetchScope {
  const calls: CapturedCall[] = [];
  const deferreds: DeferredResponse[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (String(input) === '/api/dispatch/prepare-spec-target') {
      const body = JSON.parse(String(init.body));
      assert.equal(init.method, 'POST');
      assert.ok(body.workspace_id);
      assert.ok(body.spec_package);
      assert.ok(body.thread_id || body.repository_id);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    calls.push({ url: String(input), init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    const deferred = new DeferredResponse();
    deferreds.push(deferred);
    return deferred.promise;
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return {
    calls,
    reply: (index, response) => { const deferred = deferreds[index]; assert.ok(deferred, `no fetch call at ${index}`); deferred.resolve(response); },
    fail: (index, error) => { const deferred = deferreds[index]; assert.ok(deferred, `no fetch call at ${index}`); deferred.reject(error); },
  };
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const okBrief = (path = 'briefs/ws-1/request.md'): Response => jsonResponse(200, { brief: path });
const okPreview = (digest = DIGEST_A): Response => jsonResponse(200, { record: { assignment_id: 'server-record' }, contractDigest: digest });
const okLaunch = (state = 'live', assignment: Record<string, unknown> = {}): Response =>
  jsonResponse(200, { assignment: { state, ...assignment }, observation: { observer_id: 'obs-1' } });

async function saveAndReview(store: LaunchStore, scope: FetchScope, ctx: LaunchContext, title = 'Brief', content = 'Body'): Promise<void> {
  store.seedLaunchDraft(ctx, { title, content });
  const save = store.saveLaunchDraft(ctx, TOKEN);
  await flush();
  scope.reply(scope.calls.length - 1, okBrief());
  await save;
  const review = store.reviewLaunchDraft(ctx, TOKEN);
  await flush();
  scope.reply(scope.calls.length - 1, okPreview());
  await review;
}

// node --import tsx --test --test-name-pattern="duplicate pending save" src/launch-state.test.ts
test('duplicate pending save returns the exact promise and submits one POST', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1' };
  store.seedLaunchDraft(ctx, { title: 'Brief', content: 'Body' });
  const first = store.saveLaunchDraft(ctx, TOKEN);
  const second = store.saveLaunchDraft(ctx, TOKEN);
  assert.equal(first, second);
  await flush();
  assert.equal(scope.calls.length, 1);
  assert.equal(scope.calls[0].url, '/api/dispatch/save-brief');
  scope.reply(0, okBrief());
  assert.deepEqual(await first, { brief: 'briefs/ws-1/request.md' });
  assert.deepEqual(await second, { brief: 'briefs/ws-1/request.md' });
  assert.equal(store.getLaunchDraft(ctx)?.pending, undefined);
  assert.equal(store.getLaunchDraft(ctx)?.saved?.brief, 'briefs/ws-1/request.md');
});

// node --import tsx --test --test-name-pattern="duplicate pending launch" src/launch-state.test.ts
test('duplicate pending launch returns the exact promise and submits one POST', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1' };
  await saveAndReview(store, scope, ctx);
  const assignmentId = store.getLaunchDraft(ctx)!.assignmentId!;
  const first = store.launchReviewedDraft(ctx, TOKEN);
  const second = store.launchReviewedDraft(ctx, TOKEN);
  assert.equal(first, second);
  store.seedLaunchDraft(ctx, { title: 'Replacement', content: 'Not yet' });
  assert.equal(store.getLaunchDraft(ctx)?.title, 'Brief');
  assert.equal(store.getLaunchDraft(ctx)?.pending?.promise, first);
  await flush();
  assert.equal(scope.calls.length, 3);
  scope.reply(2, okLaunch());
  const settled = await first;
  assert.deepEqual(await second, settled);
  assert.equal(store.getLaunchDraft(ctx)?.result?.kind, 'launched');
  assert.equal(store.getLaunchDraft(ctx)?.result?.assignmentId, assignmentId);
});

test('acknowledged success allows an explicit second assignment in the retained context', async t => {
  const scope = scopeFetch(t);
  for (const target of ['repo-1', 'repo-2']) {
    const store = createLaunchStore();
    const ctx: LaunchContext = { ws: 'ws-1', thread: 'thread-1', package: 'pkg-a', skill: 'skill-a', target: 'repo-1' };
    await saveAndReview(store, scope, ctx);
    const launch = store.launchReviewedDraft(ctx, TOKEN);
    await flush();
    scope.reply(scope.calls.length - 1, okLaunch());
    await launch;
    const previous = store.getLaunchDraft(ctx)!;
    const snapshot = structuredClone(previous);
    assert.equal(store.beginCorrectedAttempt(ctx), undefined);

    const nextContext = { ...ctx, target };
    const seeded = store.seedLaunchDraft(nextContext, { title: 'Second', content: 'New work' });
    assert.equal(store.getLaunchDraft(ctx)?.title, 'Second');
    assert.equal(seeded.target, target);
    assert.equal(seeded.result, undefined);
    assert.equal(seeded.saved, undefined);
    assert.equal(seeded.preview, undefined);
    assert.equal(seeded.reviewStatus, 'idle');
    const save = store.saveLaunchDraft(nextContext, TOKEN);
    await flush();
    const saveCall = scope.calls.at(-1)!;
    assert.equal(saveCall.body.title, 'Second');
    assert.equal(saveCall.body.content, 'New work');
    assert.ok(saveCall.body.request_id);
    assert.notEqual(saveCall.body.request_id, previous.requestId);
    scope.reply(scope.calls.length - 1, okBrief('briefs/ws-1/second.md'));
    await save;
    assert.equal(store.getLaunchDraft(ctx)?.saved?.brief, 'briefs/ws-1/second.md');

    const review = store.reviewLaunchDraft(nextContext, TOKEN);
    await flush();
    const reviewCall = scope.calls.at(-1)!;
    assert.equal(reviewCall.body.request_id, saveCall.body.request_id);
    assert.equal(reviewCall.body.thread_id, ctx.thread);
    assert.ok(reviewCall.body.assignment_id);
    assert.notEqual(reviewCall.body.assignment_id, previous.assignmentId);
    scope.reply(scope.calls.length - 1, okPreview(DIGEST_B));
    await review;
    assert.equal(store.getLaunchDraft(ctx)?.preview?.target, target);
    assert.deepEqual(previous, snapshot);
  }
});

// node --import tsx --test --test-name-pattern="pending save survives re-entry" src/launch-state.test.ts
test('a pending save survives re-entry and leaves other contexts untouched', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const a: LaunchContext = { ws: 'ws-a' };
  const b: LaunchContext = { ws: 'ws-b' };
  store.seedLaunchDraft(a, { title: 'A', content: 'one' });
  store.seedLaunchDraft(b, { title: 'B', content: 'two' });
  const submittedA = store.saveLaunchDraft(a, TOKEN);
  const submittedB = store.saveLaunchDraft(b, TOKEN);
  await flush();
  assert.equal(scope.calls.length, 2);
  assert.equal(scope.calls[0].body.workspace_id, 'ws-a');
  assert.equal(scope.calls[1].body.workspace_id, 'ws-b');
  const retainedA = store.getLaunchDraft(a)!;
  assert.equal(retainedA.pending?.kind, 'save');
  assert.equal(retainedA.pending?.promise, submittedA);
  const requestA = retainedA.requestId;
  assert.equal(store.getLaunchDraft(b)?.pending?.promise, submittedB);
  scope.reply(0, okBrief('briefs/ws-a/request.md'));
  scope.reply(1, okBrief('briefs/ws-b/request.md'));
  await Promise.all([submittedA, submittedB]);
  const afterA = store.getLaunchDraft(a)!;
  const afterB = store.getLaunchDraft(b)!;
  assert.equal(afterA.pending, undefined);
  assert.equal(afterA.saved?.requestId, requestA);
  assert.equal(afterA.saved?.brief, 'briefs/ws-a/request.md');
  assert.equal(afterB.saved?.brief, 'briefs/ws-b/request.md');
  assert.notEqual(afterB.saved?.requestId, requestA);
});

// node --import tsx --test --test-name-pattern="mutating the caller context" src/launch-state.test.ts
test('mutating the caller context after submission cannot retarget the queued POST', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-original', target: 'repo-1' };
  store.seedLaunchDraft(ctx, { title: 'Brief', content: 'Body' });
  const submitted = store.saveLaunchDraft(ctx, TOKEN);
  ctx.ws = 'ws-mutated';
  ctx.target = 'repo-2';
  await flush();
  assert.equal(scope.calls.length, 1);
  assert.equal(scope.calls[0].body.workspace_id, 'ws-original');
  scope.reply(0, jsonResponse(200, { brief: 'briefs/ws-original/request.md' }));
  await submitted;
  assert.equal(store.getLaunchDraft({ ws: 'ws-original', target: 'repo-1' })?.saved?.brief, 'briefs/ws-original/request.md');
  assert.equal(store.getLaunchDraft(ctx), undefined);
});

// node --import tsx --test --test-name-pattern="pending save locks submitted text" src/launch-state.test.ts
test('pending save locks submitted text fields', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1' };
  store.seedLaunchDraft(ctx, { title: 'Locked', content: 'Original' });
  const submitted = store.saveLaunchDraft(ctx, TOKEN);
  await flush();
  store.editLaunchDraft(ctx, { title: 'Changed', content: 'Changed' });
  const retained = store.getLaunchDraft(ctx)!;
  assert.equal(retained.title, 'Locked');
  assert.equal(retained.content, 'Original');
  assert.equal(retained.revision, 0);
  scope.reply(0, okBrief());
  await submitted;
  assert.equal(store.getLaunchDraft(ctx)?.saved?.title, 'Locked');
});

// node --import tsx --test --test-name-pattern="target change during save" src/launch-state.test.ts
test('a target change during save keeps typed work without approving the late response', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-a' };
  store.seedLaunchDraft(ctx, { title: 'Typed', content: 'Work' });
  const submitted = store.saveLaunchDraft(ctx, TOKEN);
  await flush();
  store.changeLaunchTarget(ctx, 'repo-b');
  const changed = store.getLaunchDraft(ctx)!;
  assert.equal(changed.target, 'repo-b');
  assert.equal(changed.title, 'Typed');
  assert.equal(changed.content, 'Work');
  assert.equal(changed.revision, 1);
  scope.reply(0, okBrief());
  await submitted;
  const settled = store.getLaunchDraft(ctx)!;
  assert.equal(settled.target, 'repo-b');
  assert.equal(settled.saved?.brief, 'briefs/ws-1/request.md');
  assert.equal(settled.reviewStatus, 'idle');
  assert.equal(settled.preview, undefined);
});

// node --import tsx --test --test-name-pattern="target change during preview" src/launch-state.test.ts
test('a target change during preview blocks the late approval', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-a' };
  store.seedLaunchDraft(ctx, { title: 'Typed', content: 'Work' });
  const save = store.saveLaunchDraft(ctx, TOKEN);
  await flush();
  scope.reply(0, okBrief());
  await save;
  const review = store.reviewLaunchDraft(ctx, TOKEN);
  await flush();
  store.changeLaunchTarget(ctx, 'repo-b');
  assert.equal(store.getLaunchDraft(ctx)?.title, 'Typed');
  scope.reply(1, okPreview());
  await review;
  const settled = store.getLaunchDraft(ctx)!;
  assert.equal(settled.target, 'repo-b');
  assert.equal(settled.preview, undefined);
  assert.notEqual(settled.reviewStatus, 'current');
  await assert.rejects(store.launchReviewedDraft(ctx, TOKEN));
  assert.equal(scope.calls.length, 2);
});

// node --import tsx --test --test-name-pattern="late preview refusal" src/launch-state.test.ts
test('a late preview refusal cannot reset a target change', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-a' };
  await saveAndReview(store, scope, ctx);
  const requestId = store.getLaunchDraft(ctx)!.requestId;
  const before = scope.calls.length;
  const review = store.reviewLaunchDraft(ctx, TOKEN);
  await flush();
  store.changeLaunchTarget(ctx, 'repo-b');
  scope.reply(before, jsonResponse(409, { error: 'conflict', reason: 'request-conflict' }));
  await assert.rejects(review, (error: unknown) => error instanceof HttpError);
  const draft = store.getLaunchDraft(ctx)!;
  assert.equal(draft.target, 'repo-b');
  assert.equal(draft.requestId, requestId);
  assert.equal(draft.saved?.requestId, requestId);
  assert.equal(draft.assignmentId, undefined);
  assert.equal(draft.reviewStatus, 'idle');
  assert.equal(draft.error, undefined);
  assert.equal(scope.calls.length, before + 1);
});

// node --import tsx --test --test-name-pattern="target A/B/A history" src/launch-state.test.ts
test('target A/B/A history requires a fresh review and retains the saved request', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-a' };
  await saveAndReview(store, scope, ctx);
  const requestId = store.getLaunchDraft(ctx)!.requestId;
  assert.equal(store.getLaunchDraft(ctx)?.preview?.target, 'repo-a');
  store.changeLaunchTarget(ctx, 'repo-b');
  const toB = store.getLaunchDraft(ctx)!;
  assert.equal(toB.preview, undefined);
  assert.equal(toB.reviewStatus, 'stale');
  assert.equal(toB.saved?.requestId, requestId);
  store.changeLaunchTarget(ctx, 'repo-a');
  const toA = store.getLaunchDraft(ctx)!;
  assert.equal(toA.preview, undefined);
  assert.notEqual(toA.reviewStatus, 'current');
  assert.equal(toA.requestId, requestId);
  await assert.rejects(store.launchReviewedDraft(ctx, TOKEN));
  assert.equal(scope.calls.length, 2);
  const rereview = store.reviewLaunchDraft(ctx, TOKEN);
  await flush();
  assert.equal(scope.calls[2].body.repository_id, 'repo-a');
  assert.equal(scope.calls[2].body.request_id, requestId);
  scope.reply(2, okPreview(DIGEST_B));
  await rereview;
  assert.equal(store.getLaunchDraft(ctx)?.reviewStatus, 'current');
  assert.equal(store.getLaunchDraft(ctx)?.preview?.target, 'repo-a');
  assert.equal(store.getLaunchDraft(ctx)?.preview?.contractDigest, DIGEST_B);
});

// node --import tsx --test --test-name-pattern="contexts retain separate drafts" src/launch-state.test.ts
test('workspace, thread, package and skill contexts retain separate drafts', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const plain: LaunchContext = { ws: 'ws-1', target: 'repo-x' };
  const threaded: LaunchContext = { ws: 'ws-1', thread: 'thread-1', target: 'repo-t' };
  const packaged: LaunchContext = { ws: 'ws-1', package: 'pkg-a', target: 'repo-p' };
  const skilled: LaunchContext = { ws: 'ws-1', skill: 'skill-a', target: 'repo-s' };
  store.seedLaunchDraft(plain, { title: 'plain', content: 'p' });
  store.seedLaunchDraft(threaded, { title: 'threaded', content: 't' });
  store.seedLaunchDraft(packaged, { title: 'packaged', content: 'k' });
  store.seedLaunchDraft(skilled, { title: 'skilled', content: 's' });
  assert.deepEqual(
    [plain, threaded, packaged, skilled].map(context => store.getLaunchDraft(context)?.title),
    ['plain', 'threaded', 'packaged', 'skilled'],
  );
  store.editLaunchDraft(plain, { title: 'plain-2', content: 'p2' });
  store.changeLaunchTarget(threaded, 'repo-t2');
  assert.equal(store.getLaunchDraft(plain)?.title, 'plain-2');
  assert.equal(store.getLaunchDraft(threaded)?.title, 'threaded');
  assert.equal(store.getLaunchDraft(threaded)?.target, 'repo-t2');
  assert.equal(store.getLaunchDraft(packaged)?.target, 'repo-p');
  assert.equal(store.getLaunchDraft(skilled)?.target, 'repo-s');
  assert.equal(scope.calls.length, 0);
});

test('only the critics-only critique stop splits identity while other stop values share the absent entry', () => {
  const store = createLaunchStore();
  const base: LaunchContext = { ws: 'ws-stop', thread: 'thread-stop', package: 'pkg-stop', skill: 'spec-architect-critics' };
  const critique: LaunchContext = { ...base, stop: 'critique' };
  const prepared: LaunchContext = { ...base, stop: 'prepared' };
  const proposal: LaunchContext = { ...base, stop: 'proposal' };
  const absent: LaunchContext = { ...base };
  store.seedLaunchDraft(critique, { title: 'critique', content: 'c' });
  store.seedLaunchDraft(absent, { title: 'absent', content: 'a' });
  assert.equal(store.getLaunchDraft(critique)?.title, 'critique');
  assert.equal(store.getLaunchDraft(prepared)?.title, 'absent', 'a prepared stop shares the absent-stop identity');
  assert.equal(store.getLaunchDraft(proposal)?.title, 'absent', 'a proposal stop shares the absent-stop identity');

  const wrongSkill: LaunchContext = { ...base, skill: 'spec-write' };
  store.seedLaunchDraft(wrongSkill, { title: 'wrong skill', content: 'w' });
  assert.equal(store.getLaunchDraft({ ...wrongSkill, stop: 'critique' })?.title, 'wrong skill',
    'a critique stop outside the critics skill adds no identity of its own');

  const unknownStop = { ...base, stop: 'other' } as unknown as LaunchContext;
  assert.equal(store.getLaunchDraft(unknownStop)?.title, 'absent', 'an unrecognized stop shares the absent-stop identity');
  store.editLaunchDraft(unknownStop, { content: 'edited through the unknown stop' });
  assert.equal(store.getLaunchDraft(absent)?.content, 'edited through the unknown stop');
  assert.equal(store.getLaunchDraft(critique)?.content, 'c');
  assert.equal(store.getLaunchDraft(prepared)?.content, 'edited through the unknown stop');

  assert.equal(normalizeLaunchStop('critique', 'spec-architect-critics'), 'critique');
  assert.equal(normalizeLaunchStop('critique', 'spec-write'), undefined);
  assert.equal(normalizeLaunchStop('critique'), undefined);
  assert.equal(normalizeLaunchStop('proposal', 'spec-architect-critics'), undefined);
  assert.equal(normalizeLaunchStop('prepared', 'spec-architect-critics'), undefined);
  assert.equal(normalizeLaunchStop('other', 'spec-architect-critics'), undefined);
  assert.equal(normalizeLaunchStop(undefined, 'spec-architect-critics'), undefined);
  assert.equal(normalizeLaunchStop(null, 'spec-architect-critics'), undefined);
  assert.equal(normalizeLaunchStop(7, 'spec-architect-critics'), undefined);
});

// node --import tsx --test --test-name-pattern="unchanged save retries" src/launch-state.test.ts
test('unchanged save retries keep one request ID while identity edits mint a new one', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1' };
  store.seedLaunchDraft(ctx, {
    title: 'Title',
    content: 'Body',
    references: [{ kind: 'file', id: 'doc-a', label: 'Doc A', token: '@doc-a' }],
  });
  const failed = store.saveLaunchDraft(ctx, TOKEN);
  await flush();
  const requestId = store.getLaunchDraft(ctx)!.requestId!;
  assert.ok(requestId);
  scope.reply(0, jsonResponse(503, { error: 'dispatch unavailable' }));
  await assert.rejects(failed, (error: unknown) => error instanceof HttpError && error.status === 503);
  const afterFailure = store.getLaunchDraft(ctx)!;
  assert.equal(afterFailure.requestId, requestId);
  assert.equal(afterFailure.saved, undefined);
  assert.equal(afterFailure.error?.status, 503);
  const retry = store.saveLaunchDraft(ctx, TOKEN);
  await flush();
  assert.equal(scope.calls[1].body.request_id, requestId);
  assert.equal(scope.calls[1].body.title, 'Title');
  scope.reply(1, okBrief());
  await retry;
  assert.equal(store.getLaunchDraft(ctx)?.saved?.requestId, requestId);
  store.editLaunchDraft(ctx, { title: 'Title 2' });
  const afterTitle = store.getLaunchDraft(ctx)!;
  assert.notEqual(afterTitle.requestId, requestId);
  assert.equal(afterTitle.saved, undefined);
  assert.equal(afterTitle.assignmentId, undefined);
  const afterContent = store.editLaunchDraft(ctx, { content: 'Body 2' });
  const contentRequestId = afterContent?.requestId;
  assert.notEqual(contentRequestId, afterTitle.requestId);
  const afterReference = store.editLaunchDraft(ctx, {
    references: [{ kind: 'file', id: 'doc-b', label: 'Doc B', token: '@doc-b' }],
  });
  assert.notEqual(afterReference?.requestId, contentRequestId);
  assert.equal(scope.calls.length, 2);
});

// node --import tsx --test --test-name-pattern="confirmed failed launch correction" src/launch-state.test.ts
test('a confirmed failed launch correction returns the old record and mints both identities', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1' };
  await saveAndReview(store, scope, ctx);
  const firstRequest = store.getLaunchDraft(ctx)!.requestId!;
  const firstAssignment = store.getLaunchDraft(ctx)!.assignmentId!;
  const launch = store.launchReviewedDraft(ctx, TOKEN);
  await flush();
  scope.reply(2, okLaunch('launch_failed'));
  await launch;
  assert.equal(store.getLaunchDraft(ctx)?.result?.kind, 'failed');
  store.seedLaunchDraft(ctx, { title: 'Replacement', content: 'Needs correction' });
  assert.equal(store.getLaunchDraft(ctx)?.title, 'Brief');
  assert.equal(store.getLaunchDraft(ctx)?.result?.kind, 'failed');
  const previous = store.beginCorrectedAttempt(ctx);
  assert.ok(previous);
  assert.equal(previous.kind, 'failed');
  assert.equal(previous.assignmentId, firstAssignment);
  const corrected = store.getLaunchDraft(ctx)!;
  assert.equal(corrected.result, undefined);
  assert.equal(corrected.saved, undefined);
  assert.equal(corrected.preview, undefined);
  assert.equal(corrected.title, 'Brief');
  assert.equal(corrected.content, 'Body');
  assert.notEqual(corrected.requestId, firstRequest);
  assert.notEqual(corrected.assignmentId, firstAssignment);
  assert.ok(corrected.requestId);
  assert.ok(corrected.assignmentId);
  // launch is blocked until the corrected brief is saved and reviewed again
  await assert.rejects(store.launchReviewedDraft(ctx, TOKEN));
  assert.equal(scope.calls.length, 3);
  const resave = store.saveLaunchDraft(ctx, TOKEN);
  await flush();
  assert.equal(scope.calls[3].body.request_id, corrected.requestId);
  scope.reply(3, okBrief('briefs/ws-1/corrected.md'));
  await resave;
  const rereview = store.reviewLaunchDraft(ctx, TOKEN);
  await flush();
  assert.equal(scope.calls[4].body.assignment_id, corrected.assignmentId);
  scope.reply(4, okPreview(DIGEST_B));
  await rereview;
  assert.equal(store.getLaunchDraft(ctx)?.reviewStatus, 'current');
});

// node --import tsx --test --test-name-pattern="transport failure after submission" src/launch-state.test.ts
test('a transport failure after submission is unconfirmed and blocks retry transitions', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1' };
  await saveAndReview(store, scope, ctx);
  const assignmentId = store.getLaunchDraft(ctx)!.assignmentId!;
  const launch = store.launchReviewedDraft(ctx, TOKEN);
  await flush();
  scope.fail(2, new TypeError('fetch failed'));
  await assert.rejects(launch, /fetch failed/);
  const draft = store.getLaunchDraft(ctx)!;
  assert.equal(draft.result?.kind, 'unconfirmed');
  assert.equal(draft.result?.assignmentId, assignmentId);
  assert.equal(draft.assignmentId, assignmentId);
  assert.ok(draft.saved);
  assert.ok(draft.preview);
  store.editLaunchDraft(ctx, { title: 'Changed' });
  store.seedLaunchDraft(ctx, { title: 'Replaced', content: 'Nope' });
  store.changeLaunchTarget(ctx, 'repo-2');
  assert.equal(store.beginCorrectedAttempt(ctx), undefined);
  const held = store.getLaunchDraft(ctx)!;
  assert.equal(held.title, 'Brief');
  assert.equal(held.target, 'repo-1');
  assert.equal(held.result?.kind, 'unconfirmed');
  await assert.rejects(store.saveLaunchDraft(ctx, TOKEN));
  await assert.rejects(store.reviewLaunchDraft(ctx, TOKEN));
  await assert.rejects(store.launchReviewedDraft(ctx, TOKEN));
  assert.equal(scope.calls.length, 3);
});

// node --import tsx --test --test-name-pattern="fixed refusals ahead of ambiguous" src/launch-state.test.ts
test('review classifies fixed refusals ahead of ambiguous failures', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1' };
  store.seedLaunchDraft(ctx, { title: 'Brief', content: 'Body' });
  const save = store.saveLaunchDraft(ctx, TOKEN);
  await flush();
  scope.reply(0, okBrief());
  await save;
  const originalRequest = store.getLaunchDraft(ctx)!.requestId;
  const refusals: Array<{ status: number; body: Record<string, unknown>; expected: LaunchReviewStatus }> = [
    { status: 409, body: { error: 'busy', reason: 'target-busy' }, expected: 'denied' },
    { status: 409, body: { error: 'active', reason: 'run-active' }, expected: 'denied' },
    { status: 403, body: { error: 'unauthorized' }, expected: 'denied' },
    { status: 503, body: { error: 'unavailable', reason: 'service-unavailable' }, expected: 'denied' },
    { status: 409, body: { error: 'changed', reason: 'stale-preview' }, expected: 'stale' },
    { status: 400, body: { error: 'bad request' }, expected: 'error' },
    { status: 503, body: { error: 'unknown failure' }, expected: 'error' },
    { status: 409, body: { error: 'conflict', reason: 'request-conflict' }, expected: 'error' },
  ];
  for (const [offset, refusal] of refusals.entries()) {
    const review = store.reviewLaunchDraft(ctx, TOKEN);
    await flush();
    scope.reply(offset + 1, jsonResponse(refusal.status, refusal.body));
    await assert.rejects(review, (error: unknown) => {
      assert.ok(error instanceof HttpError, JSON.stringify(refusal.body));
      assert.equal(error.status, refusal.status);
      return true;
    });
    const draft = store.getLaunchDraft(ctx)!;
    assert.equal(draft.reviewStatus, refusal.expected, JSON.stringify(refusal.body));
    assert.equal(draft.preview, undefined);
    assert.equal(draft.error?.status, refusal.status);
  }
  const conflicted = store.getLaunchDraft(ctx)!;
  assert.equal(conflicted.saved, undefined);
  assert.equal(conflicted.requestId, undefined);
  assert.equal(conflicted.assignmentId, undefined);
  // a corrected save mints a fresh request identity that can be reviewed
  const resave = store.saveLaunchDraft(ctx, TOKEN);
  await flush();
  const freshRequest = store.getLaunchDraft(ctx)!.requestId;
  assert.ok(freshRequest);
  assert.notEqual(freshRequest, originalRequest);
  assert.equal(scope.calls.at(-1)!.body.request_id, freshRequest);
  scope.reply(scope.calls.length - 1, okBrief('briefs/ws-1/fresh.md'));
  await resave;
  const rereview = store.reviewLaunchDraft(ctx, TOKEN);
  await flush();
  scope.reply(scope.calls.length - 1, okPreview());
  await rereview;
  assert.equal(store.getLaunchDraft(ctx)?.reviewStatus, 'current');
  // once reviewed, an ambiguous 503 at dispatch is unconfirmed, not a denial
  const launch = store.launchReviewedDraft(ctx, TOKEN);
  await flush();
  scope.reply(scope.calls.length - 1, jsonResponse(503, { error: 'unknown failure' }));
  await assert.rejects(launch);
  const afterLaunch = store.getLaunchDraft(ctx)!;
  assert.equal(afterLaunch.result?.kind, 'unconfirmed');
  assert.equal(afterLaunch.error?.status, 503);
});

// node --import tsx --test --test-name-pattern="launch refusals classify" src/launch-state.test.ts
test('launch refusals classify without a result or approval and block the next dispatch', async t => {
  const scope = scopeFetch(t);
  const refusals: Array<{ status: number; body: Record<string, unknown>; expected: LaunchReviewStatus }> = [
    { status: 409, body: { error: 'changed', reason: 'stale-preview' }, expected: 'stale' },
    { status: 409, body: { error: 'busy', reason: 'target-busy' }, expected: 'denied' },
    { status: 409, body: { error: 'active', reason: 'run-active' }, expected: 'denied' },
    { status: 403, body: { error: 'unauthorized' }, expected: 'denied' },
    { status: 503, body: { error: 'unavailable', reason: 'service-unavailable' }, expected: 'denied' },
    { status: 409, body: { error: 'conflict', reason: 'request-conflict' }, expected: 'error' },
    { status: 400, body: { error: 'bad request' }, expected: 'error' },
  ];
  for (const refusal of refusals) {
    const store = createLaunchStore();
    const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1' };
    await saveAndReview(store, scope, ctx);
    const before = scope.calls.length;
    const launch = store.launchReviewedDraft(ctx, TOKEN);
    await flush();
    scope.reply(before, jsonResponse(refusal.status, refusal.body));
    await assert.rejects(launch, (error: unknown) => {
      assert.ok(error instanceof HttpError, JSON.stringify(refusal.body));
      assert.equal(error.status, refusal.status);
      return true;
    });
    const draft = store.getLaunchDraft(ctx)!;
    assert.equal(draft.result, undefined, JSON.stringify(refusal.body));
    assert.equal(draft.preview, undefined, JSON.stringify(refusal.body));
    assert.equal(draft.reviewStatus, refusal.expected, JSON.stringify(refusal.body));
    await assert.rejects(store.launchReviewedDraft(ctx, TOKEN));
    assert.equal(scope.calls.length, before + 1, JSON.stringify(refusal.body));
  }
});

// node --import tsx --test --test-name-pattern="cold stage resolver" src/launch-state.test.ts
test('the cold stage resolver reads local state without any POST', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1' };
  assert.equal(store.getLaunchDraft(ctx), undefined);
  assert.equal(resolveLaunchStage(undefined, { tab: 'review' }), 'brief');
  assert.equal(resolveLaunchStage(store.getLaunchDraft(ctx), { tab: 'review' }), 'brief');
  assert.equal(resolveLaunchStage(undefined, { tab: 'result', id: randomUUID() }), 'inspection');
  assert.equal(resolveLaunchStage(undefined, { tab: 'nonsense' }), 'brief');
  assert.equal(resolveLaunchStage(undefined, { tab: 'result' }), 'brief');
  const saved: LaunchDraft = {
    title: 'T', content: 'C', references: [], target: null, revision: 1, reviewStatus: 'current', model: null,
    saved: { requestId: randomUUID(), title: 'T', content: 'C', references: [], brief: 'briefs/ws-1/r.md' },
  };
  assert.equal(resolveLaunchStage(saved, { tab: 'review' }), 'review');
  const launched: LaunchDraft = { ...saved, result: { kind: 'launched', assignmentId: 'assignment-1' } };
  assert.equal(resolveLaunchStage(launched, { tab: 'result', id: 'assignment-1' }), 'result');
  assert.equal(resolveLaunchStage(launched, { tab: 'result', id: 'assignment-2' }), 'inspection');
  // A recorded outcome owns the result presentation on brief/review re-entry
  // and on a result URL that omits the local identity; a mismatched result id
  // stays inspect-only, and saved or pending work without an outcome keeps the
  // brief so no mounted normalization hides it.
  assert.equal(resolveLaunchStage(launched, { tab: 'brief' }), 'result');
  assert.equal(resolveLaunchStage(launched, { tab: 'review' }), 'result');
  assert.equal(resolveLaunchStage(launched, { tab: 'result' }), 'result');
  const failed: LaunchDraft = { ...saved, result: { kind: 'failed', assignmentId: 'assignment-1' } };
  assert.equal(resolveLaunchStage(failed, { tab: 'brief' }), 'result');
  const unconfirmed: LaunchDraft = { ...saved, result: { kind: 'unconfirmed', assignmentId: 'assignment-1' } };
  assert.equal(resolveLaunchStage(unconfirmed, { tab: 'review' }), 'result');
  assert.equal(resolveLaunchStage(saved, { tab: 'brief' }), 'brief');
  assert.equal(resolveLaunchStage(saved, { tab: 'review' }), 'review');
  const pending: LaunchDraft = { ...saved, pending: { kind: 'save', revision: 1, requestId: 'request-1', target: null, model: null, promise: Promise.resolve() } };
  assert.equal(resolveLaunchStage(pending, { tab: 'brief' }), 'brief');
  assert.equal(store.getLaunchDraft(ctx), undefined);
  assert.equal(scope.calls.length, 0);
});

// node --import tsx --test --test-name-pattern="real adapter bodies" src/launch-state.test.ts
test('the store submits real adapter bodies with minted identities and the displayed digest', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1', skill: 'skill-a' };
  store.seedLaunchDraft(ctx, {
    title: 'Exact title',
    content: 'Exact body',
    references: [{ kind: 'file', id: 'doc-a', label: 'Doc A', token: '@doc-a' }],
  });
  const save = store.saveLaunchDraft(ctx, TOKEN);
  await flush();
  const requestId = store.getLaunchDraft(ctx)!.requestId!;
  assert.equal(scope.calls[0].url, '/api/dispatch/save-brief');
  assert.equal(scope.calls[0].body.workspace_id, 'ws-1');
  assert.equal(scope.calls[0].body.request_id, requestId);
  assert.equal(scope.calls[0].body.title, 'Exact title');
  assert.equal(scope.calls[0].body.content, 'Exact body');
  scope.reply(0, okBrief('briefs/ws-1/exact.md'));
  await save;
  assert.equal(store.getLaunchDraft(ctx)?.saved?.brief, 'briefs/ws-1/exact.md');

  const review = store.reviewLaunchDraft(ctx, TOKEN);
  await flush();
  const assignmentId = store.getLaunchDraft(ctx)!.assignmentId!;
  assert.equal(scope.calls[1].url, '/api/dispatch/preview');
  assert.equal(scope.calls[1].body.workspace_id, 'ws-1');
  assert.equal(scope.calls[1].body.repository_id, 'repo-1');
  assert.equal(scope.calls[1].body.request_id, requestId);
  assert.equal(scope.calls[1].body.assignment_id, assignmentId);
  assert.equal(scope.calls[1].body.skill, 'skill-a');
  assert.deepEqual(scope.calls[1].body.references, [{ kind: 'file', id: 'doc-a' }]);
  scope.reply(1, okPreview(DIGEST_A));
  await review;

  const launch = store.launchReviewedDraft(ctx, TOKEN);
  await flush();
  assert.equal(scope.calls[2].url, '/api/dispatch/launch');
  assert.equal(scope.calls[2].body.request_id, requestId);
  assert.equal(scope.calls[2].body.assignment_id, assignmentId);
  assert.equal(scope.calls[2].body.expectedDigest, DIGEST_A);
  assert.deepEqual(scope.calls[2].body.references, [{ kind: 'file', id: 'doc-a' }]);
  scope.reply(2, okLaunch()); // the reply omits assignment_id on purpose
  await launch;
  const result = store.getLaunchDraft(ctx)!;
  assert.equal(result.result?.kind, 'launched');
  assert.equal(result.result?.assignmentId, assignmentId); // client UUID preserved
  assert.equal(result.preview?.contractDigest, DIGEST_A);
  assert.equal(result.saved?.requestId, requestId);
});

// node --import tsx --test --test-name-pattern="last reviewed facts" src/launch-state.test.ts
test('last reviewed facts survive stale and denied refusals while dispatch stays withheld', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1' };
  await saveAndReview(store, scope, ctx);
  const reviewed = store.getLaunchDraft(ctx)!;
  assert.ok(reviewed.preview);
  assert.deepEqual(reviewed.lastReviewed, reviewed.preview);
  const digest = reviewed.preview!.contractDigest;
  const assignmentId = reviewed.assignmentId!;

  // Stale launch refusal clears the current approval but retains previous facts.
  const staleLaunch = store.launchReviewedDraft(ctx, TOKEN);
  await flush();
  scope.reply(scope.calls.length - 1, jsonResponse(409, { error: 'changed', reason: 'stale-preview' }));
  await assert.rejects(staleLaunch);
  const stale = store.getLaunchDraft(ctx)!;
  assert.equal(stale.preview, undefined);
  assert.equal(stale.reviewStatus, 'stale');
  assert.ok(stale.lastReviewed);
  assert.equal(stale.lastReviewed!.contractDigest, digest);
  assert.equal(stale.lastReviewed!.target, 'repo-1');
  assert.equal(stale.saved?.requestId, reviewed.requestId);
  await assert.rejects(store.launchReviewedDraft(ctx, TOKEN));
  assert.equal(scope.calls.length, 3);

  // Fresh review restores the approval; a busy denial retains the new facts.
  const rereview = store.reviewLaunchDraft(ctx, TOKEN);
  await flush();
  scope.reply(scope.calls.length - 1, okPreview(DIGEST_B));
  await rereview;
  const current = store.getLaunchDraft(ctx)!;
  assert.equal(current.reviewStatus, 'current');
  assert.equal(current.lastReviewed!.contractDigest, DIGEST_B);
  const denied = store.reviewLaunchDraft(ctx, TOKEN);
  await flush();
  scope.reply(scope.calls.length - 1, jsonResponse(409, { error: 'busy', reason: 'target-busy', assignment_id: 'b42f1903-9508-46c1-a4aa-a0842dbce617' }));
  await assert.rejects(denied);
  const afterDenied = store.getLaunchDraft(ctx)!;
  assert.equal(afterDenied.reviewStatus, 'denied');
  assert.equal(afterDenied.preview, undefined);
  assert.equal(afterDenied.lastReviewed!.contractDigest, DIGEST_B);
  assert.equal(afterDenied.error?.assignmentId, 'b42f1903-9508-46c1-a4aa-a0842dbce617');
  await assert.rejects(store.launchReviewedDraft(ctx, TOKEN));
});

// node --import tsx --test --test-name-pattern="target change retains" src/launch-state.test.ts
test('target change retains last reviewed facts beside current requested facts', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-a' };
  await saveAndReview(store, scope, ctx);
  const digest = store.getLaunchDraft(ctx)!.preview!.contractDigest;
  const requestId = store.getLaunchDraft(ctx)!.requestId;
  store.changeLaunchTarget(ctx, 'repo-b');
  const moved = store.getLaunchDraft(ctx)!;
  assert.equal(moved.target, 'repo-b');
  assert.equal(moved.preview, undefined);
  assert.equal(moved.reviewStatus, 'stale');
  assert.equal(moved.saved?.requestId, requestId);
  assert.ok(moved.lastReviewed);
  assert.equal(moved.lastReviewed!.contractDigest, digest);
  assert.equal(moved.lastReviewed!.target, 'repo-a');
  await assert.rejects(store.launchReviewedDraft(ctx, TOKEN));
});

// node --import tsx --test --test-name-pattern="brief edit clears" src/launch-state.test.ts
test('brief edit clears last reviewed facts with the saved handoff', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1' };
  await saveAndReview(store, scope, ctx);
  assert.ok(store.getLaunchDraft(ctx)!.lastReviewed);
  store.editLaunchDraft(ctx, { title: 'Changed title' });
  const edited = store.getLaunchDraft(ctx)!;
  assert.equal(edited.saved, undefined);
  assert.equal(edited.preview, undefined);
  assert.equal(edited.lastReviewed, undefined);
  assert.equal(edited.reviewStatus, 'idle');
  assert.equal(scope.calls.length, 2);
});

test('seedLaunchDraft retains the copied explicit model and context identity excludes it', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();

  // Seed a draft with explicit model
  const MODEL_A = { provider: 'deepseek', model: 'deepseek-v4-pro' };
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1', model: MODEL_A } as LaunchContext;
  store.seedLaunchDraft(ctx, { title: 'Title', content: 'Body' });
  const draft = store.getLaunchDraft(ctx);
  assert.deepEqual(draft?.model, { provider: 'deepseek', model: 'deepseek-v4-pro' });
  assert.notEqual(draft?.model, MODEL_A, 'stored model is a copy of the caller\'s object');

  // Same context identity (model excluded) but different model value
  const MODEL_B = { provider: 'openai', model: 'gpt-6-sol' };
  const differentModelCtx: LaunchContext = { ws: 'ws-1', target: 'repo-1', model: MODEL_B } as LaunchContext;
  assert.equal(contextKey(ctx), contextKey(differentModelCtx), 'model is not part of identity tuple');
  const sameDraft = store.getLaunchDraft(differentModelCtx);
  assert.equal(sameDraft?.title, 'Title');
  assert.deepEqual(sameDraft?.model, { provider: 'deepseek', model: 'deepseek-v4-pro' });

  // Prove one entry by mutating through the other route
  store.changeLaunchTarget(differentModelCtx, 'repo-9');
  assert.equal(store.getLaunchDraft(ctx)?.target, 'repo-9');

  // No fetch calls should have been made
  assert.equal(scope.calls.length, 0);
});

test('seedLaunchDraft with default (no-model) seed yields model null', async t => {
  const store = createLaunchStore();
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1' };
  store.seedLaunchDraft(ctx, { title: 'Title', content: 'Body' });
  const draft = store.getLaunchDraft(ctx);
  assert.equal(draft?.model, null);
});

test('changeLaunchModel clears the current preview and retains saved bytes and last-reviewed facts', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const MODEL_A = { provider: 'deepseek', model: 'deepseek-v4-pro' };
  const MODEL_B = { provider: 'openai', model: 'gpt-6-sol' };
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1', model: MODEL_A } as LaunchContext;

  await saveAndReview(store, scope, ctx, 'Title', 'Body');
  const draft = store.getLaunchDraft(ctx)!;
  assert.deepEqual(draft.preview?.model, MODEL_A);
  const savedCopy = structuredClone(draft.saved);
  const lastReviewedCopy = structuredClone(draft.lastReviewed);

  const changed = store.changeLaunchModel(ctx, MODEL_B)!;
  assert.deepEqual(changed.model, { provider: 'openai', model: 'gpt-6-sol' });
  assert.notEqual(changed.model, MODEL_B, 'stored model is a copy');
  assert.equal(changed.preview, undefined);
  assert.equal(changed.reviewStatus, 'stale');
  assert.deepEqual(changed.saved, savedCopy);
  assert.deepEqual(changed.lastReviewed, lastReviewedCopy);

  await assert.rejects(store.launchReviewedDraft(ctx, TOKEN), /Review the current target before launching/);

  const review = store.reviewLaunchDraft(ctx, TOKEN);
  await flush();
  const scopeCall = scope.calls[scope.calls.length - 1];
  assert.equal(scopeCall.body.provider, 'openai');
  assert.equal(scopeCall.body.model, 'gpt-6-sol');
  assert.ok(scopeCall.body.request_id);
  scope.reply(scope.calls.length - 1, okPreview(DIGEST_B));
  await review;
  assert.equal(store.getLaunchDraft(ctx)?.reviewStatus, 'current');
  assert.deepEqual(store.getLaunchDraft(ctx)?.preview?.model, MODEL_B);
});

test('a late preview for a previous model never becomes current', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const MODEL_A = { provider: 'deepseek', model: 'deepseek-v4-pro' };
  const MODEL_B = { provider: 'openai', model: 'gpt-6-sol' };
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1', model: MODEL_A } as LaunchContext;

  store.seedLaunchDraft(ctx, { title: 'Title', content: 'Body' });
  const save = store.saveLaunchDraft(ctx, TOKEN);
  await flush();
  scope.reply(0, okBrief());
  await save;

  const review = store.reviewLaunchDraft(ctx, TOKEN);
  store.changeLaunchModel(ctx, MODEL_B);
  await flush();
  scope.reply(1, okPreview(DIGEST_A));
  await review;
  assert.equal(store.getLaunchDraft(ctx)?.preview, undefined);
  assert.notEqual(store.getLaunchDraft(ctx)?.reviewStatus, 'current');
  await assert.rejects(store.launchReviewedDraft(ctx, TOKEN), /Review the current target before launching/);
});

test('changeLaunchModel refuses while a launch is pending and after a recorded result', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const MODEL_A = { provider: 'deepseek', model: 'deepseek-v4-pro' };
  const MODEL_B = { provider: 'openai', model: 'gpt-6-sol' };
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1', model: MODEL_A } as LaunchContext;

  await saveAndReview(store, scope, ctx, 'Title', 'Body');
  const before = store.getLaunchDraft(ctx)!;
  const beforeModel = before.model;
  const beforeRevision = before.revision;

  const launch = store.launchReviewedDraft(ctx, TOKEN);
  const during = store.changeLaunchModel(ctx, MODEL_B);
  assert.equal(during?.model, beforeModel);
  assert.equal(during?.revision, beforeRevision);

  await flush();
  scope.reply(scope.calls.length - 1, okLaunch());
  await launch;

  const afterResult = store.getLaunchDraft(ctx)!;
  assert.equal(afterResult.model, beforeModel);
  assert.equal(afterResult.result?.kind, 'launched');
  const after = store.changeLaunchModel(ctx, MODEL_B);
  assert.equal(after?.model, beforeModel);
});


