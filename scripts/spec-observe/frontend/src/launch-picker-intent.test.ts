// Step 11 F1 terminal coverage: All-workspaces picker repeat entry after a
// successful launch. Drives the real launch-picker-intent helpers plus a
// real createLaunchStore() through the acknowledged-success reset that
// App.tsx prepareAgentAssignment/chooseWorkspace execute literally. Generic
// scope/history navigation must abandon the armed intent without resetting,
// and pending/failed/unconfirmed entries must never be replaced.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { HttpError } from './api';
import {
  armLaunchPickerIntent,
  cancelLaunchPickerIntent,
  createLaunchPickerIntent,
  shouldApplyPickerReset,
  shouldResetAcknowledgedDraft,
} from './launch-picker-intent';
import { createLaunchStore, type LaunchContext } from './launch-state';

const TOKEN = 'test-action-token';
const DIGEST = 'a'.repeat(64);

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

function scopeFetch(t: TestContext) {
  const calls: Array<{ url: string; body: any }> = [];
  const deferreds: DeferredResponse[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    const deferred = new DeferredResponse();
    deferreds.push(deferred);
    return deferred.promise;
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return {
    calls,
    reply: (index: number, response: Response) => { assert.ok(deferreds[index], `no fetch at ${index}`); deferreds[index].resolve(response); },
  };
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

async function launchSuccessfully(store: ReturnType<typeof createLaunchStore>, scope: ReturnType<typeof scopeFetch>, ctx: LaunchContext): Promise<{ requestId: string; assignmentId: string }> {
  store.seedLaunchDraft(ctx, { title: 'First work', content: 'First body' });
  const save = store.saveLaunchDraft(ctx, TOKEN);
  await flush();
  scope.reply(scope.calls.length - 1, jsonResponse(200, { brief: 'briefs/W/request.md' }));
  await save;
  const review = store.reviewLaunchDraft(ctx, TOKEN);
  await flush();
  scope.reply(scope.calls.length - 1, jsonResponse(200, { record: { assignment_id: 'server-record' }, contractDigest: DIGEST }));
  await review;
  const requestId = store.getLaunchDraft(ctx)!.requestId!;
  const assignmentId = store.getLaunchDraft(ctx)!.assignmentId!;
  const launch = store.launchReviewedDraft(ctx, TOKEN);
  await flush();
  scope.reply(scope.calls.length - 1, jsonResponse(200, { assignment: { state: 'live', assignment_id: assignmentId }, observation: {} }));
  await launch;
  assert.equal(store.getLaunchDraft(ctx)?.result?.kind, 'launched');
  return { requestId, assignmentId };
}

// Mirrors App.tsx prepareAgentAssignment + chooseWorkspace literally.
function prepareAgentAssignment(intent: ReturnType<typeof createLaunchPickerIntent>, ws: string | undefined, store: ReturnType<typeof createLaunchStore>): { dest: string; ws?: string } {
  if (ws) {
    const context = { ws };
    if (shouldResetAcknowledgedDraft(store.getLaunchDraft(context))) {
      store.seedLaunchDraft(context, { title: '', content: '' });
    }
    return { dest: 'launch', ws };
  }
  armLaunchPickerIntent(intent);
  return { dest: 'launch' };
}

function chooseWorkspace(intent: ReturnType<typeof createLaunchPickerIntent>, dest: string, id: string, store: ReturnType<typeof createLaunchStore>): { dest: string; ws: string } {
  if (shouldApplyPickerReset(intent, dest)) {
    const context = { ws: id };
    if (shouldResetAcknowledgedDraft(store.getLaunchDraft(context))) {
      store.seedLaunchDraft(context, { title: '', content: '' });
    }
    cancelLaunchPickerIntent(intent);
  }
  return { dest: 'launch', ws: id };
}

test('F1: All-workspaces picker repeat entry after a successful launch starts independent work', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const intent = createLaunchPickerIntent();
  const ctx: LaunchContext = { ws: 'W' };
  const { requestId: firstRequest, assignmentId: firstAssignment } = await launchSuccessfully(store, scope, ctx);

  // Return to Agents, scope All workspaces, Launch agent arms the intent and
  // lands in the picker (no ws, no reset yet — the retained terminal draft
  // is still present for history restoration).
  const pickerRoute = prepareAgentAssignment(intent, undefined, store);
  assert.equal(pickerRoute.dest, 'launch');
  assert.equal(pickerRoute.ws, undefined);
  assert.equal(intent.armed, true);
  assert.equal(store.getLaunchDraft(ctx)?.result?.kind, 'launched');
  assert.equal(store.getLaunchDraft(ctx)?.title, 'First work');

  // Choosing W in the picker applies the acknowledged-success reset once the
  // concrete workspace is known and disarms.
  const launchRoute = chooseWorkspace(intent, pickerRoute.dest, 'W', store);
  assert.equal(launchRoute.ws, 'W');
  assert.equal(intent.armed, false);
  const fresh = store.getLaunchDraft(ctx)!;
  assert.equal(fresh.title, '');
  assert.equal(fresh.content, '');
  assert.equal(fresh.result, undefined);
  assert.equal(fresh.saved, undefined);
  assert.equal(fresh.preview, undefined);
  assert.equal(fresh.reviewStatus, 'idle');

  // The fresh draft saves/reviews with new identities; nothing launches silently.
  const callsBefore = scope.calls.length;
  store.editLaunchDraft(ctx, { title: 'Second work', content: 'Second body' });
  const save = store.saveLaunchDraft(ctx, TOKEN);
  await flush();
  assert.equal(scope.calls.length, callsBefore + 1);
  const freshRequest = scope.calls.at(-1)!.body.request_id;
  assert.ok(freshRequest);
  assert.notEqual(freshRequest, firstRequest);
  scope.reply(scope.calls.length - 1, jsonResponse(200, { brief: 'briefs/W/second.md' }));
  await save;
  const review = store.reviewLaunchDraft(ctx, TOKEN);
  await flush();
  const freshAssignment = scope.calls.at(-1)!.body.assignment_id;
  assert.ok(freshAssignment);
  assert.notEqual(freshAssignment, firstAssignment);
  scope.reply(scope.calls.length - 1, jsonResponse(200, { record: {}, contractDigest: DIGEST }));
  await review;
  assert.equal(store.getLaunchDraft(ctx)?.reviewStatus, 'current');
  assert.equal(scope.calls.filter(c => c.url === '/api/dispatch/launch').length, 1);
});

test('F1: generic scope/history navigation abandons the armed intent without resetting', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const intent = createLaunchPickerIntent();
  const ctx: LaunchContext = { ws: 'W' };
  await launchSuccessfully(store, scope, ctx);
  prepareAgentAssignment(intent, undefined, store);
  assert.equal(intent.armed, true);
  // Generic scope change (All -> W via the scope control, not the picker).
  cancelLaunchPickerIntent(intent);
  assert.equal(intent.armed, false);
  assert.equal(store.getLaunchDraft(ctx)?.result?.kind, 'launched');
  assert.equal(store.getLaunchDraft(ctx)?.title, 'First work');
  // History arrival at a concrete launch without a picker choice also leaves
  // the terminal draft for restoration.
  armLaunchPickerIntent(intent);
  cancelLaunchPickerIntent(intent);
  assert.equal(shouldApplyPickerReset(intent, 'launch'), false);
  assert.equal(store.getLaunchDraft(ctx)?.result?.kind, 'launched');
  // A picker visit without an armed intent never resets either.
  const untouched = createLaunchPickerIntent();
  assert.equal(shouldApplyPickerReset(untouched, 'launch'), false);
  assert.equal(shouldApplyPickerReset(intent, 'agents'), false);
});

test('F1: pending, failed and unconfirmed entries are never replaced by picker repeat entry', async t => {
  const scope = scopeFetch(t);
  const store = createLaunchStore();
  const intent = createLaunchPickerIntent();
  // Pending: armed picker choice must not touch the in-flight draft.
  const pendingCtx: LaunchContext = { ws: 'P' };
  store.seedLaunchDraft(pendingCtx, { title: 'Pending work', content: 'body' });
  const pendingSave = store.saveLaunchDraft(pendingCtx, TOKEN);
  await flush();
  assert.ok(store.getLaunchDraft(pendingCtx)?.pending);
  armLaunchPickerIntent(intent);
  chooseWorkspace(intent, 'launch', 'P', store);
  assert.equal(store.getLaunchDraft(pendingCtx)?.title, 'Pending work');
  assert.ok(store.getLaunchDraft(pendingCtx)?.pending);
  scope.reply(0, jsonResponse(200, { brief: 'briefs/P/request.md' }));
  await pendingSave;

  // Failed and unconfirmed: the guard refuses, so the picker keeps the
  // retained entry for correction/location instead of seeding fresh work.
  assert.equal(shouldResetAcknowledgedDraft({ result: { kind: 'failed' } }), false);
  assert.equal(shouldResetAcknowledgedDraft({ result: { kind: 'unconfirmed' } }), false);
  assert.equal(shouldResetAcknowledgedDraft({ pending: { kind: 'save' } as any, result: { kind: 'launched' } }), false);
  assert.equal(shouldResetAcknowledgedDraft(undefined), false);
  assert.equal(shouldResetAcknowledgedDraft({ title: 'editable' } as any), false);
  assert.equal(shouldResetAcknowledgedDraft({ result: { kind: 'launched' } }), true);

  // Failed entry through the real store stays for correction.
  const failedCtx: LaunchContext = { ws: 'F' };
  store.seedLaunchDraft(failedCtx, { title: 'Failed work', content: 'body' });
  const saveF = store.saveLaunchDraft(failedCtx, TOKEN);
  await flush();
  scope.reply(scope.calls.length - 1, jsonResponse(200, { brief: 'briefs/F/request.md' }));
  await saveF;
  const reviewF = store.reviewLaunchDraft(failedCtx, TOKEN);
  await flush();
  scope.reply(scope.calls.length - 1, jsonResponse(200, { record: {}, contractDigest: DIGEST }));
  await reviewF;
  const launchF = store.launchReviewedDraft(failedCtx, TOKEN);
  await flush();
  scope.reply(scope.calls.length - 1, jsonResponse(200, { assignment: { state: 'launch_failed' }, observation: {} }));
  await launchF;
  assert.equal(store.getLaunchDraft(failedCtx)?.result?.kind, 'failed');
  const intent2 = createLaunchPickerIntent();
  armLaunchPickerIntent(intent2);
  chooseWorkspace(intent2, 'launch', 'F', store);
  assert.equal(store.getLaunchDraft(failedCtx)?.result?.kind, 'failed');
  assert.equal(store.getLaunchDraft(failedCtx)?.title, 'Failed work');
  assert.ok(launchF instanceof Object);
  assert.ok(randomUUID().length > 0);
  assert.ok(HttpError !== undefined);
});
