// Focused composition cases for bound package hand-offs. The real singleton
// launch-state store, the launch-client adapter and the api.ts JSON transport
// run in every case; only fetch is faked, so store latches, identities,
// decoding and the adapter body mapping are exercised end to end. Each case
// uses its own workspace/package identity and restores every replaced global.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  editLaunchDraft, getLaunchDraft, launchReviewedDraft, reviewLaunchDraft, saveLaunchDraft,
} from './launch-state';
import {
  handoffReturn, packageLaunchPresentation, plannedTargetChoices, retargetPackageHandoff,
  seedColdHandoff, startPackageHandoff, type HandoffInput, type PlannedTarget,
} from './launch-handoff';
import { navigate, type RouteState } from './route';

const TOKEN = 'test-action-token';
const ASSIGNMENT_ID = '22222222-2222-4222-8222-222222222222';
const DIGEST = 'a'.repeat(64);
const NEXT_DIGEST = 'b'.repeat(64);

type CapturedCall = { url: string; body: any; init: RequestInit };
type Scope = { after: (callback: () => void) => void };

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function scopeFetch(t: Scope, responses: Array<Response | Promise<Response>>): CapturedCall[] {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: CapturedCall = { url: String(input), init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${call.url}`);
    return next;
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function deferredResponse(): { promise: Promise<Response>; resolve: (response: Response) => void } {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(settle => { resolve = settle; });
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0); });

type FakeBrowser = { hash: () => string };

// route.ts reads bare window/location/history, so scoped fakes let the real
// navigate/subscribeRoute run under node while the case restores them after.
function scopeBrowser(t: Scope): FakeBrowser {
  const state = { hash: '' };
  const target = globalThis as unknown as Record<string, unknown>;
  const originals = { window: target.window, location: target.location, history: target.history };
  target.window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  target.history = {
    replaceState: (_data: unknown, _title: string, url: string) => { state.hash = url; },
    pushState: (_data: unknown, _title: string, url: string) => { state.hash = url; },
  };
  target.location = {
    get hash(): string { return state.hash; },
    set hash(value: string) { state.hash = value; },
  };
  t.after(() => {
    for (const key of ['window', 'location', 'history'] as const) {
      if (originals[key] === undefined) delete target[key];
      else target[key] = originals[key];
    }
  });
  return { hash: () => state.hash };
}

test('package handoff single implement saves once and opens review before any preview or launch', async (t) => {
  const calls = scopeFetch(t, [
    jsonResponse(200, { brief: 'briefs/pkg-one.md' }),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: ASSIGNMENT_ID, repository_id: '/workspace/repos/web-primary', skill: 'spec-end-to-end', publication_authority: 'draft-pr' }, contractDigest: DIGEST }),
    jsonResponse(200, { assignment: { assignment_id: ASSIGNMENT_ID, state: 'live' }, observation: { assignment_id: ASSIGNMENT_ID } }),
  ]);
  const routes: RouteState[] = [];
  const input: HandoffInput = {
    ws: 'ws-handoff-one',
    packageRef: '/storage/proj/specs/pkg-one',
    targets: [{ id: 'web-alias', primary: '/workspace/repos/web-primary' }],
  };
  const started = await startPackageHandoff('implement', input, TOKEN, route => { routes.push(route); });
  if (!started.ok) assert.fail(started.reason);
  assert.equal(started.stage, 'review');
  assert.equal(started.navigated, true);
  assert.equal(started.draft.target, '/workspace/repos/web-primary');
  assert.equal(calls.length, 1, 'the hand-off saves once and never previews or launches');
  assert.equal(calls[0].url, '/api/dispatch/save-brief');
  assert.equal(calls[0].body.workspace_id, 'ws-handoff-one');
  assert.equal(calls[0].body.title, 'Implement /storage/proj/specs/pkg-one through draft PR');
  assert.equal(packageLaunchPresentation('implement', input.packageRef).stop, 'draft-pr');
  assert.deepEqual(routes.map(route => [route.dest, route.tab]), [['launch', 'review']]);
  assert.equal(routes[0].target, '/workspace/repos/web-primary');
  assert.equal(routes[0].skill, 'spec-end-to-end');

  await reviewLaunchDraft(started.context, TOKEN);
  await launchReviewedDraft(started.context, TOKEN);
  assert.deepEqual(calls.map(call => call.url), [
    '/api/dispatch/save-brief',
    '/api/dispatch/prepare-spec-target',
    '/api/dispatch/preview',
    '/api/dispatch/launch',
  ]);
  assert.deepEqual(calls[1].body, {
    workspace_id: 'ws-handoff-one',
    spec_package: '/storage/proj/specs/pkg-one',
    repository_id: '/workspace/repos/web-primary',
  });
  assert.equal(calls[2].body.repository_id, '/workspace/repos/web-primary');
  assert.equal(calls[2].body.skill, 'spec-end-to-end');
  assert.equal(calls[2].body.spec_package, '/storage/proj/specs/pkg-one');
  assert.equal(calls[2].body.publication_authority, 'draft-pr');
  assert.equal(calls[3].body.repository_id, '/workspace/repos/web-primary');
  assert.equal(calls[3].body.publication_authority, 'draft-pr');
  assert.equal(calls[3].body.expectedDigest, DIGEST);
});

test('package handoff passed planning plan saves the derived stages before preview with none authority', async (t) => {
  const calls = scopeFetch(t, [
    jsonResponse(200, { brief: 'briefs/pkg-two.md' }),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: ASSIGNMENT_ID }, contractDigest: DIGEST }),
  ]);
  const plan = { skill: 'spec-architect-critics' as const, stages: ['spec-architect-critics', 'spec-write'], stop: 'prepared' as const };
  const input: HandoffInput = { ws: 'ws-handoff-two', packageRef: '/storage/proj/specs/pkg-two', targets: [{ id: 'two', primary: '/workspace/repos/two' }], planningPlan: plan };
  const presentation = packageLaunchPresentation('plan', input.packageRef, plan);
  assert.equal(presentation.skill, 'spec-architect-critics');
  assert.equal(presentation.authority, 'none');
  assert.deepEqual(presentation.stages, ['spec-architect-critics', 'spec-write']);
  assert.equal(presentation.stop, 'prepared');

  const started = await startPackageHandoff('plan', input, TOKEN, () => undefined);
  if (!started.ok) assert.fail(started.reason);
  assert.equal(started.stage, 'review');
  assert.equal(calls.length, 1, 'the hand-off never previews');
  assert.equal(started.draft.content, presentation.content);
  assert.match(started.draft.content, /Stages: 1 Critique \(spec-architect-critics\) -> 2 Specification and preparation \(spec-write\)\./);
  assert.match(started.draft.content, /Stop at Prepared\./);
  assert.match(started.draft.content, /Publication authority: none\./);

  await reviewLaunchDraft(started.context, TOKEN);
  assert.equal(calls[2].url, '/api/dispatch/preview');
  assert.equal(calls[2].body.publication_authority, 'none');
  assert.equal(calls[2].body.skill, 'spec-architect-critics');
});

test('package handoff rejects missing workspace, package and zero targets without fetching', async (t) => {
  const calls = scopeFetch(t, []);
  const targets: PlannedTarget[] = [{ id: 'three', primary: '/workspace/repos/three' }];
  const noWorkspace = await startPackageHandoff('plan', { ws: '', packageRef: '/storage/proj/specs/pkg-three', targets }, TOKEN, () => undefined);
  if (noWorkspace.ok) assert.fail('a missing workspace must be rejected');
  assert.match(noWorkspace.reason, /workspace/i);
  const noPackage = await startPackageHandoff('plan', { ws: 'ws-handoff-three', packageRef: '', targets }, TOKEN, () => undefined);
  if (noPackage.ok) assert.fail('a missing package must be rejected');
  assert.match(noPackage.reason, /package/i);
  const noTargets = await startPackageHandoff('plan', { ws: 'ws-handoff-three', packageRef: '/storage/proj/specs/pkg-three', targets: [] }, TOKEN, () => undefined);
  if (noTargets.ok) assert.fail('zero canonical targets must be rejected');
  assert.match(noTargets.reason, /target/i);
  assert.equal(calls.length, 0);
  assert.equal(getLaunchDraft({ ws: 'ws-handoff-three', package: '/storage/proj/specs/pkg-three', skill: 'spec-architect-initial' }), undefined);
});

test('package handoff multiple targets seed null and stay unsaved until a canonical retarget', async (t) => {
  const calls = scopeFetch(t, [
    jsonResponse(200, { brief: 'briefs/pkg-four.md' }),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: ASSIGNMENT_ID }, contractDigest: DIGEST }),
  ]);
  const targets: PlannedTarget[] = [
    { id: 'zeta', primary: '/workspace/repos/zeta' },
    { id: 'alpha', primary: '/workspace/repos/alpha' },
  ];
  const routes: RouteState[] = [];
  const started = await startPackageHandoff('implement', { ws: 'ws-handoff-four', packageRef: '/storage/proj/specs/pkg-four', targets }, TOKEN, route => { routes.push(route); });
  if (!started.ok) assert.fail(started.reason);
  assert.equal(started.stage, 'brief');
  assert.equal(started.navigated, true);
  assert.equal(started.draft.target, null);
  assert.equal(calls.length, 0, 'a multi-target seed saves and previews nothing');
  assert.equal(routes[0].tab, 'brief');
  assert.equal(routes[0].target, undefined);

  const refused = retargetPackageHandoff(started.context, targets, '/workspace/repos/not-listed');
  if (refused.ok) assert.fail('an arbitrary target must be refused');
  assert.match(refused.reason, /target/i);
  assert.equal(calls.length, 0);

  const chosen = retargetPackageHandoff(started.context, targets, '/workspace/repos/alpha');
  if (!chosen.ok) assert.fail(chosen.reason);
  assert.equal(chosen.draft?.target, '/workspace/repos/alpha');

  await saveLaunchDraft(started.context, TOKEN);
  await reviewLaunchDraft(started.context, TOKEN);
  assert.deepEqual(calls.map(call => call.url), ['/api/dispatch/save-brief', '/api/dispatch/prepare-spec-target', '/api/dispatch/preview']);
  assert.equal(calls[1].body.repository_id, '/workspace/repos/alpha');
  assert.equal(calls[2].body.repository_id, '/workspace/repos/alpha');
});

test('package handoff canonical target choices sort, dedupe and keep primary paths', () => {
  const choices = plannedTargetChoices([
    { id: 'main', primary: '/home/operator/Documents/app', worktree: '/home/operator/worktrees/app-feature' },
    { id: 'alternate', primary: '/home/operator/Documents/docs' },
    { id: 'invalid', primary: '' },
    { id: 'main', primary: '/home/operator/Documents/app', worktree: '/home/operator/worktrees/app-feature' },
  ]);
  assert.deepEqual(choices, [
    { key: 'alternate\n/home/operator/Documents/docs', id: 'alternate', path: '/home/operator/Documents/docs' },
    { key: 'main\n/home/operator/Documents/app', id: 'main', path: '/home/operator/Documents/app' },
  ]);
});

test('package handoff repeat during a deferred save keeps the request, bytes and return origin without a second post', async (t) => {
  const deferred = deferredResponse();
  const calls = scopeFetch(t, [deferred.promise]);
  const routes: RouteState[] = [];
  const origin: RouteState = { dest: 'specs', ws: 'ws-handoff-five', filter: 'ready' };
  const input: HandoffInput = {
    ws: 'ws-handoff-five',
    packageRef: '/storage/proj/specs/pkg-five',
    targets: [{ id: 'alias-five', primary: '/workspace/repos/five' }],
    returnRoute: origin,
  };
  const first = startPackageHandoff('implement', input, TOKEN, route => { routes.push(route); });
  await flush();
  assert.equal(calls.length, 1);

  // Repeat entry must resolve from the retained state while the save is still
  // pending; the previous implementation awaited the pending promise here.
  const repeat = await startPackageHandoff('implement', { ...input, returnRoute: { dest: 'epics', ws: 'ws-handoff-five' } }, TOKEN, route => { routes.push(route); });
  if (!repeat.ok) assert.fail(repeat.reason);
  assert.equal(repeat.stage, 'brief');
  assert.equal(repeat.draft.pending?.kind, 'save');
  assert.equal(calls.length, 1);
  assert.deepEqual(handoffReturn('implement', repeat.context), origin, 'repeat entry must not overwrite the origin return');

  deferred.resolve(jsonResponse(200, { brief: 'briefs/pkg-five.md' }));
  const settled = await first;
  if (!settled.ok) assert.fail(settled.reason);
  assert.equal(settled.stage, 'review');
  assert.equal(calls.length, 1);
  assert.equal(settled.draft.saved?.requestId, calls[0].body.request_id);
  assert.equal(getLaunchDraft(settled.context)?.requestId, calls[0].body.request_id);
  assert.equal(settled.draft.content, packageLaunchPresentation('implement', input.packageRef).content);
  assert.deepEqual(routes.map(route => [route.dest, route.tab]), [['launch', 'brief'], ['launch', 'review']]);

  // A later edit and repeat entry keep the edited bytes and minted request and
  // still do not post or overwrite the remembered origin.
  const edited = editLaunchDraft(repeat.context, { content: 'Edited hand-off body.' });
  if (!edited) assert.fail('the retained draft must be editable after the save settles');
  const requestAfterEdit = edited.requestId;
  const afterEdit = await startPackageHandoff('implement', { ...input, returnRoute: { dest: 'epics', ws: 'ws-handoff-five' } }, TOKEN, route => { routes.push(route); });
  if (!afterEdit.ok) assert.fail(afterEdit.reason);
  assert.equal(afterEdit.stage, 'brief');
  assert.equal(afterEdit.draft.content, 'Edited hand-off body.');
  assert.equal(afterEdit.draft.requestId, requestAfterEdit);
  assert.equal(calls.length, 1, 'repeat entry never saves by itself');
  assert.deepEqual(handoffReturn('implement', afterEdit.context), origin);
});

test('package handoff late save cannot redirect after the caller navigates away', async (t) => {
  const deferred = deferredResponse();
  const calls = scopeFetch(t, [deferred.promise]);
  const browser = scopeBrowser(t);
  const input: HandoffInput = {
    ws: 'ws-handoff-six',
    packageRef: '/storage/proj/specs/pkg-six',
    targets: [{ id: 'alias-six', primary: '/workspace/repos/six' }],
  };
  const started = startPackageHandoff('implement', input, TOKEN, navigate);
  await flush();
  assert.equal(calls.length, 1);

  // Repeat entry routes immediately from the retained save without posting;
  // the caller then leaves before the deferred save settles.
  const repeat = await startPackageHandoff('implement', input, TOKEN, navigate);
  if (!repeat.ok) assert.fail(repeat.reason);
  assert.equal(repeat.stage, 'brief');
  assert.equal(calls.length, 1, 'repeat entry must not post');

  const away: RouteState = { dest: 'epics', ws: 'ws-handoff-six' };
  navigate(away);
  const awayHash = browser.hash();
  assert.notEqual(awayHash, '');

  deferred.resolve(jsonResponse(200, { brief: 'briefs/pkg-six.md' }));
  const settled = await started;
  if (!settled.ok) assert.fail(settled.reason);
  assert.equal(settled.stage, 'brief');
  assert.equal(settled.navigated, false, 'a late save must not claim the route after navigation');
  assert.equal(calls.length, 1);
  assert.equal(browser.hash(), awayHash, 'the away route is retained');
});

test('package handoff repeat entry retains unconfirmed and failed outcomes without new submissions', async (t) => {
  const calls = scopeFetch(t, [
    jsonResponse(200, { brief: 'briefs/pkg-seven.md' }),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: 'assignment-seven' }, contractDigest: DIGEST }),
    jsonResponse(200, { assignment: { assignment_id: 'assignment-seven', state: 'launching' }, observation: {} }),
    jsonResponse(200, { brief: 'briefs/pkg-eight.md' }),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: 'assignment-eight' }, contractDigest: DIGEST }),
    jsonResponse(200, { assignment: { assignment_id: 'assignment-eight', state: 'launch_failed' }, observation: {} }),
  ]);
  const scenarios = [
    { ws: 'ws-handoff-seven', packageRef: '/storage/proj/specs/pkg-seven', path: '/workspace/repos/seven', kind: 'unconfirmed' },
    { ws: 'ws-handoff-eight', packageRef: '/storage/proj/specs/pkg-eight', path: '/workspace/repos/eight', kind: 'failed' },
  ] as const;
  for (const scenario of scenarios) {
    const input: HandoffInput = { ws: scenario.ws, packageRef: scenario.packageRef, targets: [{ id: scenario.ws, primary: scenario.path }] };
    const started = await startPackageHandoff('implement', input, TOKEN, () => undefined);
    if (!started.ok) assert.fail(started.reason);
    await reviewLaunchDraft(started.context, TOKEN);
    await launchReviewedDraft(started.context, TOKEN);
    const recorded = getLaunchDraft(started.context);
    assert.equal(recorded?.result?.kind, scenario.kind);
    const identity = recorded?.result?.assignmentId;
    const requestId = recorded?.requestId;
    const before = calls.length;
    const routes: RouteState[] = [];
    const repeated = await startPackageHandoff('implement', input, TOKEN, route => { routes.push(route); });
    if (!repeated.ok) assert.fail(repeated.reason);
    assert.equal(repeated.stage, 'result');
    assert.equal(calls.length, before, 'repeat entry must not post');
    assert.equal(routes[0].tab, 'result');
    assert.equal(routes[0].id, identity);
    const retained = getLaunchDraft(started.context);
    assert.equal(retained?.result?.kind, scenario.kind);
    assert.equal(retained?.result?.assignmentId, identity);
    assert.equal(retained?.requestId, requestId);
  }
});

test('package handoff cold seed derives the observed resumed brief without posting', async (t) => {
  const calls = scopeFetch(t, []);
  const plan = { skill: 'spec-architect-critics' as const, stages: ['spec-architect-critics', 'spec-write'], stop: 'prepared' as const };
  const input: HandoffInput = { ws: 'ws-handoff-nine', packageRef: '/storage/proj/specs/pkg-nine', targets: [{ id: 'nine', primary: '/workspace/repos/nine' }], planningPlan: plan };
  const first = seedColdHandoff('plan', input);
  if (!first.ok) assert.fail(first.reason);
  assert.equal(first.stage, 'brief');
  assert.equal(first.navigated, false);
  assert.equal(first.draft.target, '/workspace/repos/nine');
  assert.equal(first.draft.saved, undefined);
  const presentation = packageLaunchPresentation('plan', input.packageRef, plan);
  assert.equal(first.draft.content, presentation.content);
  assert.match(first.draft.content, /spec-architect-critics/);
  assert.match(first.draft.content, /Stop at Prepared\./);

  const second = seedColdHandoff('plan', { ...input, planningPlan: { ...plan, stop: 'proposal' } });
  if (!second.ok) assert.fail(second.reason);
  assert.equal(second.draft.content, presentation.content, 'an existing draft is never reseeded');
  assert.equal(calls.length, 0);
});

test('package handoff fallback returns are workspace scoped', () => {
  assert.deepEqual(handoffReturn('plan', { ws: 'ws-handoff-ten' }), { dest: 'epics', ws: 'ws-handoff-ten' });
  assert.deepEqual(handoffReturn('implement', { ws: 'ws-handoff-ten' }), { dest: 'specs', ws: 'ws-handoff-ten', filter: 'ready' });
});

test('package handoff retarget after review clears approval and requires a fresh preview digest', async (t) => {
  const calls = scopeFetch(t, [
    jsonResponse(200, { brief: 'briefs/pkg-eleven.md' }),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: ASSIGNMENT_ID }, contractDigest: DIGEST }),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: ASSIGNMENT_ID }, contractDigest: NEXT_DIGEST }),
    jsonResponse(200, { assignment: { assignment_id: ASSIGNMENT_ID, state: 'live' }, observation: {} }),
  ]);
  const first = '/workspace/repos/eleven-a';
  const second = '/workspace/repos/eleven-b';
  const targets: PlannedTarget[] = [
    { id: 'eleven-a', primary: first },
    { id: 'eleven-b', primary: second },
  ];
  const started = await startPackageHandoff('implement', { ws: 'ws-handoff-eleven', packageRef: '/storage/proj/specs/pkg-eleven', targets: [targets[0]] }, TOKEN, () => undefined);
  if (!started.ok) assert.fail(started.reason);
  await reviewLaunchDraft(started.context, TOKEN);
  const reviewed = getLaunchDraft(started.context);
  assert.equal(reviewed?.reviewStatus, 'current');
  assert.equal(reviewed?.preview?.target, first);

  const retargeted = retargetPackageHandoff(started.context, targets, second);
  if (!retargeted.ok) assert.fail(retargeted.reason);
  const afterRetarget = getLaunchDraft(started.context);
  assert.equal(afterRetarget?.target, second);
  assert.equal(afterRetarget?.preview, undefined, 'retarget clears the current approval');
  assert.equal(afterRetarget?.reviewStatus, 'stale');
  assert.equal(afterRetarget?.lastReviewed?.target, first, 'previous facts stay retained as unapproved');
  assert.equal(afterRetarget?.lastReviewed?.contractDigest, DIGEST);

  // Repeat entry routes the retained second target even though the entry
  // input still names the original single target.
  const repeatRoutes: RouteState[] = [];
  const repeated = await startPackageHandoff('implement', { ws: 'ws-handoff-eleven', packageRef: '/storage/proj/specs/pkg-eleven', targets: [targets[0]] }, TOKEN, route => { repeatRoutes.push(route); });
  if (!repeated.ok) assert.fail(repeated.reason);
  assert.equal(repeated.context.target, second);
  assert.equal(repeated.draft.target, second);
  assert.equal(repeatRoutes[0].target, second);

  // Cold seed of the same context reports the retained target and leaves the
  // reviewed-then-retargeted draft untouched.
  const cold = seedColdHandoff('implement', { ws: 'ws-handoff-eleven', packageRef: '/storage/proj/specs/pkg-eleven', targets: [targets[0]] });
  if (!cold.ok) assert.fail(cold.reason);
  assert.equal(cold.context.target, second);
  assert.equal(cold.draft.target, second);
  assert.equal(cold.draft.revision, afterRetarget?.revision);
  assert.equal(cold.draft.lastReviewed?.contractDigest, DIGEST);

  await assert.rejects(launchReviewedDraft(started.context, TOKEN), /Review the current target before launching/);

  await reviewLaunchDraft(started.context, TOKEN);
  assert.equal(getLaunchDraft(started.context)?.preview?.contractDigest, NEXT_DIGEST);
  await launchReviewedDraft(started.context, TOKEN);
  assert.equal(calls.length, 6);
  assert.equal(calls[4].body.repository_id, second);
  assert.equal(calls[5].body.repository_id, second);
  assert.equal(calls[5].body.expectedDigest, NEXT_DIGEST);
  assert.equal(getLaunchDraft(started.context)?.result?.kind, 'launched');
});
