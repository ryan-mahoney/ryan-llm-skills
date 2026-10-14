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
  discussionRepositoryTarget, handoffReturn, packageLaunchPresentation, plannedTargetChoices, retargetPackageHandoff,
  seedColdHandoff, startPackageHandoff, type HandoffInput, type PlannedTarget,
} from './launch-handoff';
import { navigate, type RouteState } from './route';

const TOKEN = 'test-action-token';
const ASSIGNMENT_ID = '22222222-2222-4222-8222-222222222222';
const DIGEST = 'a'.repeat(64);
const NEXT_DIGEST = 'b'.repeat(64);

type CapturedCall = { url: string; body: any; init: RequestInit };
type Scope = { after: (callback: () => void) => void };
type WorkspaceRepositoryFixture = { alias: string; canonicalPath: string };

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

// Production preview and launch both read the workspace inventory before a
// bound package target is submitted: the stored physical canonical_path maps
// the planned absolute primary path to its registered repository alias.
function workspaceInventory(ws: string, repositories: WorkspaceRepositoryFixture[]): Response {
  return jsonResponse(200, {
    id: ws,
    directory: '/workspace',
    repositories: repositories.map(({ alias, canonicalPath }) => ({
      id: alias, path: canonicalPath, status: 'ok', canonical_path: canonicalPath,
    })),
  });
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
    workspaceInventory('ws-handoff-one', [{ alias: 'repo-web-primary', canonicalPath: '/workspace/repos/web-primary' }]),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: ASSIGNMENT_ID, repository_id: 'repo-web-primary', skill: 'spec-end-to-end', publication_authority: 'draft-pr' }, contractDigest: DIGEST }),
    workspaceInventory('ws-handoff-one', [{ alias: 'repo-web-primary', canonicalPath: '/workspace/repos/web-primary' }]),
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
    '/api/workspace?id=ws-handoff-one',
    '/api/dispatch/prepare-spec-target',
    '/api/dispatch/preview',
    '/api/workspace?id=ws-handoff-one',
    '/api/dispatch/launch',
  ]);
  assert.equal(calls[1].url, '/api/workspace?id=ws-handoff-one', 'the preview reads the workspace inventory before binding');
  assert.deepEqual(calls[2].body, {
    workspace_id: 'ws-handoff-one',
    spec_package: '/storage/proj/specs/pkg-one',
    repository_id: 'repo-web-primary',
  });
  assert.equal(calls[3].body.repository_id, 'repo-web-primary');
  assert.equal(calls[3].body.skill, 'spec-end-to-end');
  assert.equal(calls[3].body.spec_package, '/storage/proj/specs/pkg-one');
  assert.equal(calls[3].body.publication_authority, 'draft-pr');
  assert.equal(calls[4].url, '/api/workspace?id=ws-handoff-one', 'the launch binds through the same inventory');
  assert.equal(calls[5].body.repository_id, 'repo-web-primary');
  assert.equal(calls[5].body.publication_authority, 'draft-pr');
  assert.equal(calls[5].body.expectedDigest, DIGEST);
});

test('package handoff passed planning plan saves the derived stages before preview with none authority', async (t) => {
  const calls = scopeFetch(t, [
    jsonResponse(200, { brief: 'briefs/pkg-two.md' }),
    workspaceInventory('ws-handoff-two', [{ alias: 'repo-two', canonicalPath: '/workspace/repos/two' }]),
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
  assert.equal(calls[1].url, '/api/workspace?id=ws-handoff-two');
  assert.equal(calls[2].url, '/api/dispatch/prepare-spec-target');
  assert.equal(calls[2].body.repository_id, 'repo-two');
  assert.equal(calls[3].url, '/api/dispatch/preview');
  assert.equal(calls[3].body.publication_authority, 'none');
  assert.equal(calls[3].body.skill, 'spec-architect-critics');
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
    workspaceInventory('ws-handoff-four', [{ alias: 'repo-alpha', canonicalPath: '/workspace/repos/alpha' }]),
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
  assert.deepEqual(calls.map(call => call.url), ['/api/dispatch/save-brief', '/api/workspace?id=ws-handoff-four', '/api/dispatch/prepare-spec-target', '/api/dispatch/preview']);
  assert.equal(calls[1].url, '/api/workspace?id=ws-handoff-four');
  assert.equal(calls[2].body.repository_id, 'repo-alpha');
  assert.equal(calls[3].body.repository_id, 'repo-alpha');
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

test('discussion target maps the canonical package primary and never trusts a colliding package target id', () => {
  const workspace = {
    id: 'ws-discuss-one',
    repositories: [
      { id: 'fixture-docs', status: 'ok', canonical_path: '/checkout/docs' },
      { id: 'fixture-repo', status: 'ok', canonical_path: '/checkout/primary' },
    ],
  };
  // The package target id names a different registered checkout: only the
  // canonical primary path decides, so the discussion binds fixture-repo.
  assert.deepEqual(
    discussionRepositoryTarget(workspace, 'ws-discuss-one', [{ id: 'fixture-docs', primary: '/checkout/primary' }]),
    { ok: true, target: 'fixture-repo' },
  );
  assert.deepEqual(
    discussionRepositoryTarget(workspace, 'ws-discuss-one', [{ id: 'fixture-repo', primary: '/checkout/docs' }]),
    { ok: true, target: 'fixture-docs' },
  );
});

test('discussion target refuses an absent, wrong-workspace, unhealthy, unmatched or ambiguous inventory', () => {
  const targets: PlannedTarget[] = [{ id: 'fixture-docs', primary: '/checkout/primary' }];
  assert.deepEqual(discussionRepositoryTarget(undefined, 'ws-discuss-two', targets), {
    ok: false,
    reason: 'The workspace repository inventory is unavailable; connect to the live workspace service before discussing this decision.',
  });
  const wrongWorkspace = { id: 'ws-other', repositories: [{ id: 'fixture-repo', status: 'ok', canonical_path: '/checkout/primary' }] };
  assert.equal(discussionRepositoryTarget(wrongWorkspace, 'ws-discuss-two', targets).ok, false);
  const unhealthy = { id: 'ws-discuss-two', repositories: [{ id: 'fixture-repo', status: 'not_git', canonical_path: '/checkout/primary' }] };
  assert.equal(discussionRepositoryTarget(unhealthy, 'ws-discuss-two', targets).ok, false);
  const emptyId = { id: 'ws-discuss-two', repositories: [{ id: '', status: 'ok', canonical_path: '/checkout/primary' }] };
  assert.equal(discussionRepositoryTarget(emptyId, 'ws-discuss-two', targets).ok, false);
  const unmatched = { id: 'ws-discuss-two', repositories: [{ id: 'fixture-repo', status: 'ok', canonical_path: '/checkout/other' }] };
  assert.equal(discussionRepositoryTarget(unmatched, 'ws-discuss-two', targets).ok, false);
  const ambiguous = { id: 'ws-discuss-two', repositories: [
    { id: 'fixture-repo', status: 'ok', canonical_path: '/checkout/primary' },
    { id: 'fixture-alt', status: 'ok', canonical_path: '/checkout/primary' },
  ] };
  assert.deepEqual(discussionRepositoryTarget(ambiguous, 'ws-discuss-two', targets), {
    ok: false,
    reason: 'The package target /checkout/primary matches more than one repository in this workspace.',
  });
});

test('discussion target keeps several distinct package targets unguessed and refuses a package with no usable target', () => {
  const workspace = { id: 'ws-discuss-three', repositories: [
    { id: 'fixture-repo', status: 'ok', canonical_path: '/checkout/primary' },
  ] };
  assert.deepEqual(
    discussionRepositoryTarget(workspace, 'ws-discuss-three', [
      { id: 'fixture-repo', primary: '/checkout/primary' },
      { id: 'fixture-docs', primary: '/checkout/docs' },
    ]),
    { ok: true, target: null },
  );
  assert.equal(discussionRepositoryTarget(workspace, 'ws-discuss-three', []).ok, false);
  assert.equal(discussionRepositoryTarget(workspace, 'ws-discuss-three', undefined).ok, false);
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
    workspaceInventory('ws-handoff-seven', [{ alias: 'repo-seven', canonicalPath: '/workspace/repos/seven' }]),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: 'assignment-seven' }, contractDigest: DIGEST }),
    workspaceInventory('ws-handoff-seven', [{ alias: 'repo-seven', canonicalPath: '/workspace/repos/seven' }]),
    jsonResponse(200, { assignment: { assignment_id: 'assignment-seven', state: 'launching' }, observation: {} }),
    jsonResponse(200, { brief: 'briefs/pkg-eight.md' }),
    workspaceInventory('ws-handoff-eight', [{ alias: 'repo-eight', canonicalPath: '/workspace/repos/eight' }]),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: 'assignment-eight' }, contractDigest: DIGEST }),
    workspaceInventory('ws-handoff-eight', [{ alias: 'repo-eight', canonicalPath: '/workspace/repos/eight' }]),
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

test('package handoff cold seed honors a validated route target only when it matches the package inventory', () => {
  const first = '/workspace/repos/twelve-a';
  const second = '/workspace/repos/twelve-b';
  const targets: PlannedTarget[] = [
    { id: 'twelve-a', primary: first },
    { id: 'twelve-b', primary: second },
  ];
  const chosen = seedColdHandoff('implement', { ws: 'ws-handoff-twelve', packageRef: '/storage/proj/specs/pkg-twelve', targets, target: second });
  if (!chosen.ok) assert.fail(chosen.reason);
  assert.equal(chosen.context.target, second);
  assert.equal(chosen.draft.target, second);
  const invalid = seedColdHandoff('implement', { ws: 'ws-handoff-twelve-2', packageRef: '/storage/proj/specs/pkg-twelve', targets, target: '/workspace/repos/elsewhere' });
  if (!invalid.ok) assert.fail(invalid.reason);
  assert.equal(invalid.context.target, null);
  assert.equal(invalid.draft.target, null);
  const single = seedColdHandoff('implement', { ws: 'ws-handoff-twelve-3', packageRef: '/storage/proj/specs/pkg-twelve', targets: [targets[0]], target: second });
  if (!single.ok) assert.fail(single.reason);
  assert.equal(single.context.target, first, 'one canonical target keeps the primary');
});

test('package handoff fallback returns are workspace scoped', () => {
  assert.deepEqual(handoffReturn('plan', { ws: 'ws-handoff-ten' }), { dest: 'epics', ws: 'ws-handoff-ten' });
  assert.deepEqual(handoffReturn('implement', { ws: 'ws-handoff-ten' }), { dest: 'specs', ws: 'ws-handoff-ten', filter: 'ready' });
});

test('package handoff retarget after review clears approval and requires a fresh preview digest', async (t) => {
  const first = '/workspace/repos/eleven-a';
  const second = '/workspace/repos/eleven-b';
  const targets: PlannedTarget[] = [
    { id: 'eleven-a', primary: first },
    { id: 'eleven-b', primary: second },
  ];
  const inventory = [
    { alias: 'repo-eleven-a', canonicalPath: first },
    { alias: 'repo-eleven-b', canonicalPath: second },
  ];
  const calls = scopeFetch(t, [
    jsonResponse(200, { brief: 'briefs/pkg-eleven.md' }),
    workspaceInventory('ws-handoff-eleven', inventory),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: ASSIGNMENT_ID }, contractDigest: DIGEST }),
    workspaceInventory('ws-handoff-eleven', inventory),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: ASSIGNMENT_ID }, contractDigest: NEXT_DIGEST }),
    workspaceInventory('ws-handoff-eleven', inventory),
    jsonResponse(200, { assignment: { assignment_id: ASSIGNMENT_ID, state: 'live' }, observation: {} }),
  ]);
  const started = await startPackageHandoff('implement', { ws: 'ws-handoff-eleven', packageRef: '/storage/proj/specs/pkg-eleven', targets: [targets[0]] }, TOKEN, () => undefined);
  if (!started.ok) assert.fail(started.reason);
  await reviewLaunchDraft(started.context, TOKEN);
  assert.equal(calls[1].url, '/api/workspace?id=ws-handoff-eleven');
  assert.equal(calls[2].body.repository_id, 'repo-eleven-a');
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
  assert.equal(calls.length, 4, 'a refused stale launch reads nothing further');

  await reviewLaunchDraft(started.context, TOKEN);
  assert.equal(calls[4].url, '/api/workspace?id=ws-handoff-eleven', 'the retarget re-reads the inventory before preparing');
  assert.equal(calls[5].body.repository_id, 'repo-eleven-b');
  assert.equal(getLaunchDraft(started.context)?.preview?.contractDigest, NEXT_DIGEST);
  await launchReviewedDraft(started.context, TOKEN);
  assert.equal(calls.length, 9);
  assert.equal(calls[7].url, '/api/workspace?id=ws-handoff-eleven', 'the launch resolves the retarget alias again');
  assert.equal(calls[8].body.repository_id, 'repo-eleven-b');
  assert.equal(calls[8].body.expectedDigest, NEXT_DIGEST);
  assert.equal(getLaunchDraft(started.context)?.result?.kind, 'launched');
});
