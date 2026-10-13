// Step 6 focused store-boundary cases for launch-state. Each case builds a
// fresh createLaunchStore() and scopes a fake fetch whose responses resolve
// from explicit deferred slots; the previous fetch is restored after every
// case and no case uses timers or sleeps. launch-client.test.ts keeps the
// adapter decoding/normalization coverage; these cases assert store identity
// and transition behavior plus the exact bodies the real adapter submits
// (displayed digest and minted UUIDs).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { HttpError } from './api';
import {
  createLaunchStore,
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
  await flush();
  assert.equal(scope.calls.length, 3);
  scope.reply(2, okLaunch());
  const settled = await first;
  assert.deepEqual(await second, settled);
  assert.equal(store.getLaunchDraft(ctx)?.result?.kind, 'launched');
  assert.equal(store.getLaunchDraft(ctx)?.result?.assignmentId, assignmentId);
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
    title: 'T', content: 'C', references: [], target: null, revision: 1, reviewStatus: 'current',
    saved: { requestId: randomUUID(), title: 'T', content: 'C', references: [], brief: 'briefs/ws-1/r.md' },
  };
  assert.equal(resolveLaunchStage(saved, { tab: 'review' }), 'review');
  const launched: LaunchDraft = { ...saved, result: { kind: 'launched', assignmentId: 'assignment-1' } };
  assert.equal(resolveLaunchStage(launched, { tab: 'result', id: 'assignment-1' }), 'result');
  assert.equal(resolveLaunchStage(launched, { tab: 'result', id: 'assignment-2' }), 'inspection');
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
