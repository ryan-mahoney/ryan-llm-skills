// EV-11 focused evidence for explicit request proposals composed through the
// production request store (createRequestStore defaults) and the singleton
// launch owners. Only the final fetch boundary is controlled: the shipped
// interpretation reply shape (scripts/spec-observe/request-routes.mjs) feeds
// the store and the real launch-state -> launch-client -> api.ts path performs
// every save, preview and launch, so request/launch identities, store latches,
// retained-outcome protection and the composed brief bytes are observable end
// to end. Each case owns its workspace/package identity and restores every
// replaced global; deferred fetches stand in for pending work instead of
// sleeps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeNewThreadDraft } from './conversations-state';
import {
  changeLaunchModel, changeLaunchTarget, editLaunchDraft, getLaunchDraft, launchReviewedDraft, reviewLaunchDraft, saveLaunchDraft,
} from './launch-state';
import { packageLaunchPresentation, type PlannedTarget } from './launch-handoff';
import type { WireRecord } from './model';
import { createRequestStore, deriveProposal } from './request-state';
import type { ProposalCandidate, ProposalEnvironment, ProposalObservation, RequestStore } from './request-state';
import type { RouteState } from './route';

const TOKEN = 'test-action-token';
const ASSIGNMENT_ID = '22222222-2222-4222-8222-222222222222';
const DIGEST = 'a'.repeat(64);
const MODEL = { provider: 'openrouter', model: 'kimi-k2' };
const SECTION_BEGIN = '--- Begin request work ---';
const SECTION_END = '--- End request work ---';

type CapturedCall = { url: string; body: any; init: RequestInit };
type Scope = { after: (callback: () => void) => void };

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

// Production preview and launch resolve a bound package target against the
// stored physical canonical_path before submitting, so the fixture maps each
// canonical path to its registered repository alias.
function workspaceInventory(ws: string, repositories: Array<{ alias: string; canonicalPath: string }>): Response {
  return jsonResponse(200, {
    id: ws,
    directory: '/workspace',
    repositories: repositories.map(({ alias, canonicalPath }) => ({
      id: alias, path: canonicalPath, status: 'ok', canonical_path: canonicalPath,
    })),
  });
}

function scopeFetch(t: Scope, respond: (call: CapturedCall) => Response | Promise<Response>): CapturedCall[] {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: CapturedCall = {
      url: String(input), init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
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

// The proposal environment boundary: observe() is re-read by the store before
// every awaited operation, so live/token/signature/context stay current.
function proposalEnvironment(initial: Partial<ProposalObservation> & { context: ProposalObservation['context'] }): {
  env: ProposalEnvironment;
  routes: RouteState[];
  closes: () => number;
  set: (next: Partial<ProposalObservation>) => void;
} {
  const state: ProposalObservation = {
    live: initial.live ?? true,
    token: initial.token === undefined ? TOKEN : initial.token,
    signature: initial.signature === undefined ? 'signature-1' : initial.signature,
    context: initial.context,
  };
  const routes: RouteState[] = [];
  let closes = 0;
  const env: ProposalEnvironment = {
    observe: () => ({ ...state, context: { ...state.context } }),
    navigate: route => { routes.push(route); },
    close: () => { closes += 1; },
  };
  return { env, routes, closes: () => closes, set: next => { Object.assign(state, next); } };
}

// The shipped interpretation candidate shape (request-interpret.mjs).
function wireCandidate(ws: string, slug: string, goal = `Implement ${slug} package`): ProposalCandidate {
  return {
    action: 'implement_spec',
    workspace: ws,
    entity: `spec:${slug}`,
    uses: [`spec:${slug}`],
    resolved_refs: [`spec:${slug}`],
    research: { code: 'unspecified' },
    goal,
    constraints: [],
  };
}

function wireProposal(requestId: string, candidates: ProposalCandidate[]): unknown {
  return {
    request_id: requestId,
    resolution: 'proposal',
    candidates,
    unresolved_references: [],
    clarification: null,
    catalog: { read_at: '2025-01-01T00:00:00Z', omitted: 0, errors: [] },
  };
}

// A typed, positively prepared, coverage-complete single-target package record.
function readyRecord(ws: string, slug: string, targets: PlannedTarget[]): WireRecord {
  return {
    workspace: ws,
    name: slug,
    slug,
    package: `/storage/proj/specs/${slug}`,
    package_ref: `${ws}/${slug}`,
    targets,
    planning: {
      proposal: true, critique: false, critique_recommended: false,
      prepared: true, step_count: 4, preparation: { outcome: 'valid' },
      decision: null, receipts: [], worktree_recorded: null,
    },
    assignment_coverage: { state: 'complete' },
  };
}

// The exact-owner fixture: an active spec-end-to-end assignment bound to the
// same canonical package, the one shape that blocks a duplicate dispatch.
function activeOwner(ws: string, pkg: string): WireRecord {
  return {
    workspace: ws, workspace_id: ws, spec_package: pkg,
    skill: 'spec-end-to-end', display: 'running', assignment_id: ASSIGNMENT_ID,
  };
}

const sectionCount = (content: string): number => content.split(SECTION_BEGIN).length - 1;

const previewReply = (repositoryId: string): unknown => ({
  record: { assignment_id: ASSIGNMENT_ID, repository_id: repositoryId, skill: 'spec-end-to-end', publication_authority: 'draft-pr' },
  contractDigest: DIGEST,
});

const launchReply = (state: string): unknown => ({
  assignment: { assignment_id: ASSIGNMENT_ID, state }, observation: { assignment_id: ASSIGNMENT_ID },
});

test('a typed prepared single-target proposal shares one prepare promise and composes one save and one preview', async (t) => {
  const ws = 'ws-ev11-single';
  const slug = 'alpha-single';
  const pkg = `/storage/proj/specs/${slug}`;
  const primary = '/workspace/repos/alpha-single';
  const record = readyRecord(ws, slug, [{ id: 'alpha-single-target', primary }]);
  const selected = wireCandidate(ws, slug, 'Implement the alpha single package');
  const launchGate = deferredResponse();
  const calls = scopeFetch(t, call => {
    if (call.url === '/api/request/interpret') return jsonResponse(200, wireProposal(call.body.request_id, [selected]));
    if (call.url === '/api/dispatch/save-brief') return jsonResponse(200, { brief: `briefs/${slug}.md` });
    if (call.url === `/api/workspace?id=${ws}`) return workspaceInventory(ws, [{ alias: 'alpha-single-repo', canonicalPath: primary }]);
    if (call.url === '/api/dispatch/prepare-spec-target') return jsonResponse(200, {});
    if (call.url === '/api/dispatch/preview') return jsonResponse(200, previewReply('alpha-single-repo'));
    if (call.url === '/api/dispatch/launch') return launchGate.promise;
    throw new Error(`unexpected fetch ${call.url}`);
  });

  const store = createRequestStore();
  const probe = proposalEnvironment({ context: { record } });
  store.editTranscript(ws, 'Implement the alpha single package now.');
  await store.submitRequest(ws, TOKEN);

  // The returned implement_spec candidate is selected twice before the first
  // selection resolves: both selections share exactly one prepare promise.
  const first = store.prepareProposal(ws, selected, probe.env);
  const second = store.prepareProposal(ws, selected, probe.env);
  assert.strictEqual(first, second, 'duplicate selection shares exactly one prepare promise');
  const prepared = await first;
  if (!prepared.ok) assert.fail(prepared.reason);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.status, 'reviewed');

  // One save carrying the canonical implementation base plus one request
  // section holding the requestBrief content.
  const saves = calls.filter(call => call.url === '/api/dispatch/save-brief');
  assert.equal(saves.length, 1, 'the composition saves once');
  const base = packageLaunchPresentation('implement', pkg).content.replace(/\s+$/, '');
  const content = saves[0].body.content as string;
  assert.ok(content.startsWith(base), 'the canonical implementation base is preserved');
  assert.equal(sectionCount(content), 1, 'exactly one delimited Request work section');
  assert.equal(content.split(SECTION_END).length - 1, 1);
  assert.match(content, /Request \(typed\):\nImplement the alpha single package now\./);
  assert.match(content, /Action: implement spec package "alpha-single"/);

  // One preview binding spec-end-to-end/draft-pr and resolving the record's
  // canonical primary path to the real inventory alias.
  const previews = calls.filter(call => call.url === '/api/dispatch/preview');
  assert.equal(previews.length, 1, 'exactly one preview');
  assert.equal(previews[0].body.skill, 'spec-end-to-end');
  assert.equal(previews[0].body.publication_authority, 'draft-pr');
  assert.equal(previews[0].body.repository_id, 'alpha-single-repo');
  assert.equal(previews[0].body.spec_package, pkg);
  assert.equal(calls.find(call => call.url === '/api/dispatch/prepare-spec-target')?.body.repository_id, 'alpha-single-repo');
  assert.equal('provider' in previews[0].body, false, 'a default absent model is omitted');
  assert.equal('model' in previews[0].body, false);

  // The binding exposes the launch identity and the preview signature.
  const binding = prepared.work.binding;
  assert.ok(binding);
  assert.deepEqual(binding.launch, { ws, package: pkg, skill: 'spec-end-to-end', authority: 'draft-pr', target: primary });
  assert.equal(binding.signature, 'signature-1');

  // Double launch shares the launch owner's latch: one POST carrying one
  // request identity, the assignment id and the reviewed digest. Closing the
  // panel never cancels the pending launch and the exact outcome stays
  // observable.
  const launchOne = store.launchProposal(ws, probe.env);
  const launchTwo = await store.launchProposal(ws, probe.env);
  if (!launchTwo.ok) assert.fail(launchTwo.reason);
  assert.equal(launchTwo.ok, true);
  assert.equal(launchTwo.status, 'inspect', 'the duplicate observes the pending launch');
  store.closePanel(ws);
  launchGate.resolve(jsonResponse(200, launchReply('live')));
  const outcome = await launchOne;
  if (!outcome.ok) assert.fail(outcome.reason);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'inspect', 'the exact returned outcome is observable');
  assert.ok(outcome.work.binding);
  const launches = calls.filter(call => call.url === '/api/dispatch/launch');
  assert.equal(launches.length, 1, 'double launch yields one POST');
  assert.equal(launches[0].body.request_id, saves[0].body.request_id, 'one request identity');
  assert.equal(new Set(launches.map(call => call.body.request_id)).size, 1);
  assert.equal(launches[0].body.assignment_id, previews[0].body.assignment_id, 'the launch carries the reviewed assignment id');
  assert.equal(launches[0].body.expectedDigest, DIGEST);
  assert.equal('provider' in launches[0].body, false);
  assert.equal(getLaunchDraft(binding.launch)?.result?.kind, 'launched');
});

test('a retained unfinished spec draft keeps its chosen target, model and ordinary text while the request section is replaced once', async (t) => {
  const ws = 'ws-ev11-retain';
  const slug = 'alpha-retain';
  const pkg = `/storage/proj/specs/${slug}`;
  const firstPath = '/workspace/repos/alpha-retain-a';
  const secondPath = '/workspace/repos/alpha-retain-b';
  const record = readyRecord(ws, slug, [{ id: 'retain-a', primary: firstPath }]);
  const selected = wireCandidate(ws, slug, 'Implement the alpha retain package');
  const calls = scopeFetch(t, call => {
    if (call.url === '/api/request/interpret') return jsonResponse(200, wireProposal(call.body.request_id, [selected]));
    if (call.url === '/api/dispatch/save-brief') return jsonResponse(200, { brief: `briefs/${slug}.md` });
    if (call.url === `/api/workspace?id=${ws}`) return workspaceInventory(ws, [
      { alias: 'retain-a', canonicalPath: firstPath }, { alias: 'retain-b', canonicalPath: secondPath },
    ]);
    if (call.url === '/api/dispatch/prepare-spec-target') return jsonResponse(200, {});
    if (call.url === '/api/dispatch/preview') return jsonResponse(200, previewReply('retain-b'));
    throw new Error(`unexpected fetch ${call.url}`);
  });

  const store = createRequestStore();
  const probe = proposalEnvironment({ context: { record } });
  store.editTranscript(ws, 'Implement the alpha retain package now.');
  await store.submitRequest(ws, TOKEN);
  const prepared = await store.prepareProposal(ws, selected, probe.env);
  if (!prepared.ok) assert.fail(prepared.reason);
  assert.equal(prepared.ok, true);
  const launch = prepared.work.binding!.launch;

  // The operator chooses the target and model through the launch-state public
  // methods and keeps ordinary draft text outside the request section.
  changeLaunchTarget(launch, secondPath);
  changeLaunchModel(launch, MODEL);
  const edited = editLaunchDraft(launch, { content: `${getLaunchDraft(launch)!.content}\n\nOperator note retained.` });
  assert.ok(edited);

  // Repeated prepares preserve the target, the model and the ordinary text;
  // the request section is replaced in place and stays singular.
  for (let round = 0; round < 2; round += 1) {
    const again = await store.prepareProposal(ws, selected, probe.env);
    if (!again.ok) assert.fail(again.reason);
    assert.equal(again.ok, true);
    const draft = getLaunchDraft(launch)!;
    assert.equal(draft.target, secondPath);
    assert.deepEqual(draft.model, MODEL);
    assert.match(draft.content, /Operator note retained\./);
    assert.equal(sectionCount(draft.content), 1);
    assert.equal(draft.content.split(SECTION_END).length - 1, 1);
  }
  const previews = calls.filter(call => call.url === '/api/dispatch/preview');
  assert.equal(previews[previews.length - 1].body.repository_id, 'retain-b', 'the chosen target resolves its own alias');
  assert.deepEqual(getLaunchDraft(launch)?.model, MODEL);

  // An edited transcript is reinterpreted and replaces the section text in
  // place: the old request text is gone, the ordinary text survives.
  store.editTranscript(ws, 'Transcribe the corrected request.');
  await store.submitRequest(ws, TOKEN);
  const corrected = await store.prepareProposal(ws, selected, probe.env);
  if (!corrected.ok) assert.fail(corrected.reason);
  assert.equal(corrected.ok, true);
  const draft = getLaunchDraft(launch)!;
  assert.match(draft.content, /Transcribe the corrected request\./);
  assert.doesNotMatch(draft.content, /Implement the alpha retain package now\./);
  assert.match(draft.content, /Operator note retained\./);
  assert.equal(sectionCount(draft.content), 1);
  assert.equal(draft.target, secondPath);
  assert.deepEqual(draft.model, MODEL);
});

test('retained pending and recorded outcomes stay inspect-only and newRequest replaces only a launched outcome', async (t) => {
  const kinds = ['pending-save', 'pending-preview', 'pending-launch', 'launched', 'unconfirmed', 'failed'] as const;
  for (const kind of kinds) {
    await t.test(kind, async (t) => {
      const ws = `ws-ev11-${kind}`;
      const slug = `alpha-${kind}`;
      const pkg = `/storage/proj/specs/${slug}`;
      const firstPath = `/workspace/repos/alpha-${kind}-a`;
      const secondPath = `/workspace/repos/alpha-${kind}-b`;
      const record = readyRecord(ws, slug, [{ id: `${slug}-a`, primary: firstPath }]);
      const selected = wireCandidate(ws, slug);
      const gate = deferredResponse();
      let hold = false;
      const calls = scopeFetch(t, call => {
        if (call.url === '/api/request/interpret') return jsonResponse(200, wireProposal(call.body.request_id, [selected]));
        if (call.url === '/api/dispatch/save-brief') {
          return hold && kind === 'pending-save' ? gate.promise : jsonResponse(200, { brief: `briefs/${slug}.md` });
        }
        if (call.url === `/api/workspace?id=${ws}`) {
          return workspaceInventory(ws, [
            { alias: `${slug}-a`, canonicalPath: firstPath }, { alias: `${slug}-b`, canonicalPath: secondPath },
          ]);
        }
        if (call.url === '/api/dispatch/prepare-spec-target') return jsonResponse(200, {});
        if (call.url === '/api/dispatch/preview') {
          return hold && kind === 'pending-preview' ? gate.promise : jsonResponse(200, previewReply(`${slug}-b`));
        }
        if (call.url === '/api/dispatch/launch') {
          if (hold && kind === 'pending-launch') return gate.promise;
          return jsonResponse(200, launchReply(kind === 'launched' ? 'live' : kind === 'failed' ? 'launch_failed' : 'pending'));
        }
        throw new Error(`unexpected fetch ${call.url}`);
      });

      const store = createRequestStore();
      const probe = proposalEnvironment({ context: { record } });
      store.editTranscript(ws, `Implement the ${slug} package.`);
      await store.submitRequest(ws, TOKEN);
      const prepared = await store.prepareProposal(ws, selected, probe.env);
      if (!prepared.ok) assert.fail(prepared.reason);
      assert.equal(prepared.ok, true);
      const launch = prepared.work.binding!.launch;

      // Target and model are chosen through the launch-state public methods.
      changeLaunchTarget(launch, secondPath);
      changeLaunchModel(launch, MODEL);
      let pending: Promise<unknown> | null = null;
      hold = true;
      if (kind === 'pending-save') pending = saveLaunchDraft(launch, TOKEN);
      else if (kind === 'pending-preview') pending = reviewLaunchDraft(launch, TOKEN);
      else {
        await reviewLaunchDraft(launch, TOKEN);
        if (kind === 'pending-launch') pending = launchReviewedDraft(launch, TOKEN);
        else await launchReviewedDraft(launch, TOKEN);
      }
      await flush();

      const draft = getLaunchDraft(launch)!;
      const facts = {
        content: draft.content, requestId: draft.requestId, assignmentId: draft.assignmentId,
        savedRequestId: draft.saved?.requestId, model: draft.model, target: draft.target,
      };
      const posts = calls.length;

      // Re-entry is inspect-only and stays observable with offline and
      // active-owner facts: the binding is exposed before any gate.
      const offline = proposalEnvironment({
        live: false, token: null, signature: null,
        context: { record, assignments: [activeOwner(ws, pkg)] },
      });
      assert.equal(deriveProposal(selected, offline.env.observe().context).action, 'open-assignment');
      const reentry = await store.prepareProposal(ws, selected, offline.env);
      if (!reentry.ok) assert.fail(reentry.reason);
      assert.equal(reentry.ok, true);
      assert.equal(reentry.status, 'inspect');
      assert.ok(reentry.work.binding, 'the binding stays exposed for inspection');
      const after = getLaunchDraft(launch)!;
      assert.deepEqual({
        content: after.content, requestId: after.requestId, assignmentId: after.assignmentId,
        savedRequestId: after.saved?.requestId, model: after.model, target: after.target,
      }, facts, 'content, identities, model and target are untouched');
      assert.equal(calls.length, posts, 'inspect-only re-entry never posts');

      // newRequest:true replaces only an acknowledged launched outcome, and
      // unconfirmed/failed (and every pending state) stay inspect-only.
      const postsBefore = calls.length;
      const fresh = await store.prepareProposal(ws, selected, probe.env, { newRequest: true });
      if (!fresh.ok) assert.fail(fresh.reason);
      assert.equal(fresh.ok, true);
      if (kind === 'launched') {
        assert.equal(fresh.status, 'reviewed');
        const saves = calls.filter(call => call.url === '/api/dispatch/save-brief');
        const last = saves[saves.length - 1];
        assert.notEqual(last.body.request_id, facts.savedRequestId, 'the replacement mints a new save request identity');
        const freshContent = last.body.content as string;
        assert.ok(freshContent.startsWith(packageLaunchPresentation('implement', pkg).content.replace(/\s+$/, '')),
          'the replacement keeps the canonical base');
        assert.equal(sectionCount(freshContent), 1);
      } else {
        assert.equal(fresh.status, 'inspect', `${kind} stays inspect-only even with newRequest`);
        assert.equal(calls.length, postsBefore, `${kind} never posts over the retained outcome`);
      }

      if (pending) {
        hold = false;
        gate.resolve(jsonResponse(200, kind === 'pending-launch' ? launchReply('live') : { brief: `briefs/${slug}.md` }));
        await pending.catch(() => undefined);
      }
    });
  }
});

test('moved readiness signatures refuse preparation and launch without posting', async (t) => {
  const ws = 'ws-ev11-signature';
  const slug = 'alpha-signature';
  const pkg = `/storage/proj/specs/${slug}`;
  const primary = '/workspace/repos/alpha-signature';
  const record = readyRecord(ws, slug, [{ id: 'signature-target', primary }]);
  const selected = wireCandidate(ws, slug);
  const saveGate = deferredResponse();
  const previewGate = deferredResponse();
  let holdSave = false;
  let holdPreview = false;
  const calls = scopeFetch(t, call => {
    if (call.url === '/api/request/interpret') return jsonResponse(200, wireProposal(call.body.request_id, [selected]));
    if (call.url === '/api/dispatch/save-brief') return holdSave ? saveGate.promise : jsonResponse(200, { brief: `briefs/${slug}.md` });
    if (call.url === `/api/workspace?id=${ws}`) return workspaceInventory(ws, [{ alias: 'signature-repo', canonicalPath: primary }]);
    if (call.url === '/api/dispatch/prepare-spec-target') return jsonResponse(200, {});
    if (call.url === '/api/dispatch/preview') return holdPreview ? previewGate.promise : jsonResponse(200, previewReply('signature-repo'));
    if (call.url === '/api/dispatch/launch') return jsonResponse(200, launchReply('live'));
    throw new Error(`unexpected fetch ${call.url}`);
  });

  const store = createRequestStore();
  const probe = proposalEnvironment({ context: { record } });
  store.editTranscript(ws, 'Implement the alpha signature package.');
  await store.submitRequest(ws, TOKEN);

  // A signature that moves while the save is in flight refuses the review
  // instead of reviewing stale readiness.
  holdSave = true;
  const started = store.prepareProposal(ws, selected, probe.env);
  probe.set({ signature: 'signature-2' });
  saveGate.resolve(jsonResponse(200, { brief: `briefs/${slug}.md` }));
  holdSave = false;
  const moved = await started;
  assert.equal(moved.ok, false);
  if (moved.ok) assert.fail('a moved signature must refuse');
  assert.match(moved.reason, /readiness facts changed/i);
  assert.equal(calls.filter(call => call.url === '/api/dispatch/preview').length, 0, 'no preview over stale readiness');

  // A prepared proposal whose signature moves after the preview refuses the
  // launch with no POST.
  probe.set({ signature: 'signature-3' });
  const prepared = await store.prepareProposal(ws, selected, probe.env);
  if (!prepared.ok) assert.fail(prepared.reason);
  assert.equal(prepared.ok, true);
  probe.set({ signature: 'signature-4' });
  const refused = await store.launchProposal(ws, probe.env);
  assert.equal(refused.ok, false);
  if (refused.ok) assert.fail('a moved signature must refuse the launch');
  assert.match(refused.reason, /readiness facts changed/i);
  assert.equal(calls.filter(call => call.url === '/api/dispatch/launch').length, 0, 'no launch POST');

  // A signature that moves across the preview await refuses reviewProposal and
  // stores nothing.
  holdPreview = true;
  const review = store.reviewProposal(ws, probe.env);
  probe.set({ signature: 'signature-5' });
  previewGate.resolve(jsonResponse(200, previewReply('signature-repo')));
  const reviewed = await review;
  assert.equal(reviewed.ok, false);
  if (reviewed.ok) assert.fail('a moved signature must refuse the review');
  assert.match(reviewed.reason, /readiness facts changed/i);
  assert.equal(calls.filter(call => call.url === '/api/dispatch/launch').length, 0);
});

test('an active exact owner refuses prepare and cannot be approved by review', async (t) => {
  const ws = 'ws-ev11-owner';
  const slug = 'alpha-owner';
  const pkg = `/storage/proj/specs/${slug}`;
  const primary = '/workspace/repos/alpha-owner';
  const record = readyRecord(ws, slug, [{ id: 'owner-target', primary }]);
  const selected = wireCandidate(ws, slug);
  const calls = scopeFetch(t, call => {
    if (call.url === '/api/request/interpret') return jsonResponse(200, wireProposal(call.body.request_id, [selected]));
    if (call.url === '/api/dispatch/save-brief') return jsonResponse(200, { brief: `briefs/${slug}.md` });
    if (call.url === `/api/workspace?id=${ws}`) return workspaceInventory(ws, [{ alias: 'owner-repo', canonicalPath: primary }]);
    if (call.url === '/api/dispatch/prepare-spec-target') return jsonResponse(200, {});
    if (call.url === '/api/dispatch/preview') return jsonResponse(200, previewReply('owner-repo'));
    throw new Error(`unexpected fetch ${call.url}`);
  });

  const store = createRequestStore();
  const owned = proposalEnvironment({ context: { record, assignments: [activeOwner(ws, pkg)] } });
  store.editTranscript(ws, 'Implement the alpha owner package.');
  await store.submitRequest(ws, TOKEN);

  const refused = await store.prepareProposal(ws, selected, owned.env);
  assert.equal(refused.ok, false);
  if (refused.ok) assert.fail('an active exact owner must refuse');
  assert.match(refused.reason, /owns this package/i);
  assert.equal(calls.filter(call => call.url.startsWith('/api/dispatch')).length, 0, 'no dispatch POST while owned');

  // Review cannot approve an owner that appears after preparation either.
  const clean = proposalEnvironment({ context: { record } });
  const prepared = await store.prepareProposal(ws, selected, clean.env);
  if (!prepared.ok) assert.fail(prepared.reason);
  assert.equal(prepared.ok, true);
  const beforeReview = calls.filter(call => call.url === '/api/dispatch/preview').length;
  const review = await store.reviewProposal(ws, owned.env);
  assert.equal(review.ok, false);
  if (review.ok) assert.fail('review must not approve an active owner');
  assert.match(review.reason, /owns this package/i);
  assert.equal(calls.filter(call => call.url === '/api/dispatch/preview').length, beforeReview, 'no preview over an active owner');
});

test('incomplete preparation and partial coverage refuse the implement proposal without posting', async (t) => {
  for (const defect of ['incomplete-preparation', 'partial-coverage'] as const) {
    await t.test(defect, async (t) => {
      const ws = `ws-ev11-${defect}`;
      const slug = `alpha-${defect}`;
      const primary = `/workspace/repos/alpha-${defect}`;
      const record = readyRecord(ws, slug, [{ id: `${slug}-target`, primary }]);
      if (defect === 'incomplete-preparation') {
        record.planning = { ...(record.planning as WireRecord), prepared: false };
      } else {
        record.assignment_coverage = { state: 'partial' };
      }
      const selected = wireCandidate(ws, slug);
      const calls = scopeFetch(t, call => {
        if (call.url === '/api/request/interpret') return jsonResponse(200, wireProposal(call.body.request_id, [selected]));
        throw new Error(`unexpected fetch ${call.url}`);
      });

      const store = createRequestStore();
      const probe = proposalEnvironment({ context: { record } });
      store.editTranscript(ws, `Implement the ${slug} package.`);
      await store.submitRequest(ws, TOKEN);
      const outcome = await store.prepareProposal(ws, selected, probe.env);
      assert.equal(outcome.ok, false);
      if (outcome.ok) assert.fail('incomplete readiness must refuse');
      assert.match(outcome.reason, defect === 'incomplete-preparation' ? /preparation report is missing/i : /coverage is partial/i);
      assert.equal(calls.filter(call => call.url.startsWith('/api/dispatch')).length, 0, 'no dispatch POST');
    });
  }
});

test('an edited request and missing live or token refuse the bound launch without posting', async (t) => {
  const ws = 'ws-ev11-guards';
  const slug = 'alpha-guards';
  const primary = '/workspace/repos/alpha-guards';
  const record = readyRecord(ws, slug, [{ id: 'guards-target', primary }]);
  const selected = wireCandidate(ws, slug);
  const calls = scopeFetch(t, call => {
    if (call.url === '/api/request/interpret') return jsonResponse(200, wireProposal(call.body.request_id, [selected]));
    if (call.url === '/api/dispatch/save-brief') return jsonResponse(200, { brief: `briefs/${slug}.md` });
    if (call.url === `/api/workspace?id=${ws}`) return workspaceInventory(ws, [{ alias: 'guards-repo', canonicalPath: primary }]);
    if (call.url === '/api/dispatch/prepare-spec-target') return jsonResponse(200, {});
    if (call.url === '/api/dispatch/preview') return jsonResponse(200, previewReply('guards-repo'));
    throw new Error(`unexpected fetch ${call.url}`);
  });

  const store = createRequestStore();
  const probe = proposalEnvironment({ context: { record } });
  store.editTranscript(ws, 'Implement the alpha guards package.');
  await store.submitRequest(ws, TOKEN);
  const prepared = await store.prepareProposal(ws, selected, probe.env);
  if (!prepared.ok) assert.fail(prepared.reason);
  assert.equal(prepared.ok, true);

  probe.set({ live: false });
  const offline = await store.launchProposal(ws, probe.env);
  assert.equal(offline.ok, false);
  if (offline.ok) assert.fail('offline must refuse the launch');
  assert.match(offline.reason, /live workspace service/i);

  probe.set({ live: true, token: null });
  const anonymous = await store.launchProposal(ws, probe.env);
  assert.equal(anonymous.ok, false);
  if (anonymous.ok) assert.fail('a missing token must refuse the launch');
  assert.match(anonymous.reason, /token is unavailable/i);

  probe.set({ token: TOKEN });
  store.editTranscript(ws, 'Implement the edited alpha guards package.');
  const edited = await store.launchProposal(ws, probe.env);
  assert.equal(edited.ok, false);
  if (edited.ok) assert.fail('an edited request must refuse the launch');
  assert.match(edited.reason, /request changed/i);
  assert.equal(calls.filter(call => call.url === '/api/dispatch/launch').length, 0, 'no launch POST from any refusal');
});

test('plan epic and build screens seed whole-workspace catalog contexts and refuse missing design facts', async (t) => {
  const ws = 'ws-ev11-catalog';
  const planCandidate: ProposalCandidate = {
    action: 'plan_epic', workspace: ws, entity: `workspace:${ws}`,
    uses: [], resolved_refs: [], research: {}, goal: 'Plan the alpha epic', constraints: [],
  };
  const designCandidate: ProposalCandidate = {
    action: 'build_screens', workspace: ws, entity: 'design:alpha-ui',
    uses: [], resolved_refs: [], research: {}, goal: 'Build the alpha ui screens', constraints: [],
  };
  const calls = scopeFetch(t, call => {
    if (call.url === '/api/request/interpret') {
      const candidates = call.body.transcript === 'Plan the alpha epic.' ? [planCandidate] : [designCandidate];
      return jsonResponse(200, wireProposal(call.body.request_id, candidates));
    }
    if (call.url === '/api/dispatch/save-brief') return jsonResponse(200, { brief: 'briefs/catalog.md' });
    if (call.url === '/api/dispatch/preview') return jsonResponse(200, previewReply('unused'));
    throw new Error(`unexpected fetch ${call.url}`);
  });

  // plan_epic: catalog skill epic-plan, authority none, whole-workspace.
  const planner = createRequestStore();
  const planEnv = proposalEnvironment({ context: {} });
  planner.editTranscript(ws, 'Plan the alpha epic.');
  await planner.submitRequest(ws, TOKEN);
  const planned = await planner.prepareProposal(ws, planCandidate, planEnv.env);
  if (!planned.ok) assert.fail(planned.reason);
  assert.equal(planned.ok, true);
  const planPreview = calls.filter(call => call.url === '/api/dispatch/preview').pop()!;
  assert.equal(planPreview.body.skill, 'epic-plan');
  assert.equal(planPreview.body.publication_authority, 'none');
  assert.equal('repository_id' in planPreview.body, false, 'whole-workspace: no repository is bound');
  assert.equal('spec_package' in planPreview.body, false, 'whole-workspace: no package is bound');
  assert.equal(planned.work.binding!.launch.target, null);

  // build_screens: catalog skill design-run, authority none, whole-workspace.
  const builder = createRequestStore();
  const designEnv = proposalEnvironment({ context: { designIndex: true, designBrief: true } });
  builder.editTranscript(ws, 'Build the alpha ui screens.');
  await builder.submitRequest(ws, TOKEN);
  const built = await builder.prepareProposal(ws, designCandidate, designEnv.env);
  if (!built.ok) assert.fail(built.reason);
  assert.equal(built.ok, true);
  const designPreview = calls.filter(call => call.url === '/api/dispatch/preview').pop()!;
  assert.equal(designPreview.body.skill, 'design-run');
  assert.equal(designPreview.body.publication_authority, 'none');
  assert.equal('repository_id' in designPreview.body, false);

  // Missing observed design index and brief refuses before any dispatch POST.
  const refusedStore = createRequestStore();
  const refusedEnv = proposalEnvironment({ context: { designIndex: false, designBrief: false } });
  refusedStore.editTranscript(ws, 'Build the alpha ui screens.');
  await refusedStore.submitRequest(ws, TOKEN);
  const posts = calls.filter(call => call.url.startsWith('/api/dispatch')).length;
  const refused = await refusedStore.prepareProposal(ws, designCandidate, refusedEnv.env);
  assert.equal(refused.ok, false);
  if (refused.ok) assert.fail('missing design facts must refuse');
  assert.match(refused.reason, /design index and design brief/i);
  assert.equal(calls.filter(call => call.url.startsWith('/api/dispatch')).length, posts, 'no dispatch POST without design facts');
});

test('multi-target implement opens the target-choice brief and closes without posting', async (t) => {
  const ws = 'ws-ev11-multi';
  const slug = 'alpha-multi';
  const record = readyRecord(ws, slug, [
    { id: 'multi-a', primary: '/workspace/repos/alpha-multi-a' },
    { id: 'multi-b', primary: '/workspace/repos/alpha-multi-b' },
  ]);
  const selected = wireCandidate(ws, slug);
  const calls = scopeFetch(t, call => {
    if (call.url === '/api/request/interpret') return jsonResponse(200, wireProposal(call.body.request_id, [selected]));
    throw new Error(`unexpected fetch ${call.url}`);
  });

  const store = createRequestStore();
  const probe = proposalEnvironment({ context: { record } });
  store.editTranscript(ws, 'Implement the alpha multi package.');
  await store.submitRequest(ws, TOKEN);
  const outcome = await store.prepareProposal(ws, selected, probe.env);
  if (!outcome.ok) assert.fail(outcome.reason);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'brief');
  assert.deepEqual(probe.routes.map(route => [route.dest, route.tab]), [['launch', 'brief']], 'the existing target-choice brief is opened');
  assert.equal(probe.routes[0].target, undefined, 'no repository is guessed');
  assert.equal(probe.closes(), 1, 'the panel closes');
  assert.equal(outcome.work.binding!.launch.target, null);

  // The target-choice brief carries the operator's request: the canonical
  // implementation base plus exactly one request section with the transcript.
  const draft = getLaunchDraft(outcome.work.binding!.launch)!;
  const base = packageLaunchPresentation('implement', `/storage/proj/specs/${slug}`).content.replace(/\s+$/, '');
  assert.ok(draft.content.startsWith(base), 'the canonical implementation base is preserved');
  assert.equal(sectionCount(draft.content), 1, 'exactly one delimited Request work section');
  assert.equal(draft.content.split(SECTION_END).length - 1, 1);
  assert.match(draft.content, /Request \(typed\):\nImplement the alpha multi package\./);

  assert.equal(calls.filter(call => call.url.startsWith('/api/dispatch')).length, 0, 'no save or preview');
  assert.equal(calls.filter(call => call.url.startsWith('/api/workspace')).length, 0, 'no repository resolution');
});

test('conversation seeding and agent navigation stay offline and route observed keys', async (t) => {
  const ws = 'ws-ev11-nav';
  const slug = 'alpha-nav';
  const pkg = `/storage/proj/specs/${slug}`;
  const primary = '/workspace/repos/alpha-nav';
  const record = readyRecord(ws, slug, [{ id: 'nav-target', primary }]);
  const selected = wireCandidate(ws, slug);
  const calls = scopeFetch(t, call => {
    if (call.url === '/api/request/interpret') return jsonResponse(200, wireProposal(call.body.request_id, [selected]));
    throw new Error(`unexpected fetch ${call.url}`);
  });

  const store: RequestStore = createRequestStore();
  const probe = proposalEnvironment({ context: { record } });
  store.editTranscript(ws, 'Discuss the alpha nav package.');
  await store.submitRequest(ws, TOKEN);
  const posts = calls.length;

  // Conversation seeding carries the transcript into a tab=new route with no
  // network call and closes the panel.
  store.startConversation(ws, probe.env);
  assert.equal(consumeNewThreadDraft(ws)?.text, 'Discuss the alpha nav package.');
  assert.deepEqual(probe.routes.at(-1), { dest: 'conversations', ws, tab: 'new' });
  assert.equal(probe.closes(), 1);
  assert.equal(calls.length, posts, 'conversation seeding never posts');

  // Agent navigation picks the observed key of the intended second row; an
  // unobserved id falls back to the workspace-scoped q filter.
  const assignments = [
    { assignment_id: '11111111-1111-4111-8111-111111111111', key: '["ws-ev11-nav","11111111-1111-4111-8111-111111111111"]' },
    { assignment_id: ASSIGNMENT_ID, key: `["ws-ev11-nav","${ASSIGNMENT_ID}"]` },
  ];
  probe.set({ context: { record, assignments } });
  store.openAgent(ws, probe.env, ASSIGNMENT_ID);
  assert.equal(probe.routes.at(-1)?.dest, 'agents');
  assert.equal(probe.routes.at(-1)?.id, `["ws-ev11-nav","${ASSIGNMENT_ID}"]`, 'the observed key of the intended row wins');
  store.openAgent(ws, probe.env, '99999999-9999-4999-8999-999999999999');
  assert.equal(probe.routes.at(-1)?.q, '99999999-9999-4999-8999-999999999999', 'an unobserved id uses the q filter');
  assert.equal(calls.length, posts, 'agent navigation never posts');
});
