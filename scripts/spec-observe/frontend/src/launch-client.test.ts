// Step 5 focused fetch-boundary cases for the launch adapter. Each case scopes
// a fake fetch that returns real Response objects, so the real postJson/api.ts
// decoding runs; the previous fetch is restored after every case. No case
// performs HTTP or any mutation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { HttpError } from './api';
import { FIXED_INSTRUCTION, previewLaunchAssignment, saveLaunchBrief, submitLaunchAssignment, suggestionSourceFor, type LaunchContext } from './launch-client';

const TOKEN = 'test-action-token';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ASSIGNMENT_ID = '22222222-2222-4222-8222-222222222222';
const DIGEST = 'a'.repeat(64);

type CapturedCall = { url: string; body: any; init: RequestInit };
type FetchScope = { after: (callback: () => void) => void };
type AuthorityContext = LaunchContext & { authority: 'none' | 'draft-pr' };

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function scopeFetch(t: FetchScope, responses: Response[]): CapturedCall[] {
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

const FORBIDDEN_FIELDS = ['brief', 'path', 'model', 'harness', 'publication', 'publication_authority', 'authority', 'project_trust', 'provider', 'thinking', 'runtime', 'session_dir', 'execution_dir', 'workflow_id'];

function assertNoOverrides(calls: CapturedCall[]): void {
  for (const call of calls) {
    for (const field of FORBIDDEN_FIELDS) {
      assert.equal(field in call.body, false, `${field} must not be sent to ${call.url}`);
    }
  }
}

test('refusal metadata distinguishes fixed reasons and retains only a valid target-busy UUID', async (t) => {
  const busy = randomUUID();
  scopeFetch(t, [
    jsonResponse(409, { error: 'This execution directory already has an assignment.', reason: 'target-busy', assignment_id: busy }),
    jsonResponse(409, { error: 'The reviewed assignment changed. Review it again.', reason: 'stale-preview' }),
    jsonResponse(409, { error: 'This spec package has an active run.', reason: 'run-active' }),
    jsonResponse(409, { error: 'This request conflicts with saved state.', reason: 'request-conflict', request_id: REQUEST_ID }),
    jsonResponse(409, { error: 'busy', reason: 'target-busy', assignment_id: 'not-a-uuid' }),
    jsonResponse(409, { error: 'refused', reason: 'made-up-reason' }),
    jsonResponse(503, { error: 'Dispatch service unavailable.', reason: 'service-unavailable' }),
    jsonResponse(503, { error: 'Discussion service unavailable.' }),
    new Response('not json', { status: 503 }),
  ]);
  const ctx: LaunchContext = { ws: 'ws-1', target: 'repo-1' };
  const input = { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID };
  const errors: HttpError[] = [];
  for (let index = 0; index < 9; index += 1) {
    await assert.rejects(previewLaunchAssignment(ctx, input, TOKEN), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      errors.push(error);
      return true;
    });
  }
  assert.deepEqual(
    errors.map(error => [error.status, error.reason, error.assignmentId]),
    [
      [409, 'target-busy', busy],
      [409, 'stale-preview', undefined],
      [409, 'run-active', undefined],
      [409, 'request-conflict', undefined],
      [409, 'target-busy', undefined],
      [409, undefined, undefined],
      [503, 'service-unavailable', undefined],
      [503, undefined, undefined],
      [503, undefined, undefined],
    ],
  );
  assert.equal(errors[0].message, 'This execution directory already has an assignment.');
  assert.equal(errors[7].message, 'Discussion service unavailable.');
  assert.equal(errors[8].message, 'Request failed (503).');
});

test('thread save sends identity-only references and preview/launch carry stored-reference bindings', async (t) => {
  const calls = scopeFetch(t, [
    jsonResponse(200, { brief: 'briefs/req-1.md' }),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: ASSIGNMENT_ID }, contractDigest: DIGEST, inputPreview: { brief: 'B', instruction: FIXED_INSTRUCTION, references: [] } }),
    jsonResponse(200, { assignment: { assignment_id: ASSIGNMENT_ID }, observation: { assignment_id: ASSIGNMENT_ID } }),
  ]);
  const richReference = { kind: 'skill' as const, id: 'skill-1', label: 'Label', token: '@skill-1', path: '/private' };
  const ctx: LaunchContext = { ws: 'ws-1', thread: 'thread-1', target: 'repo-1', package: '/storage/proj/specs/pkg', skill: 'review' };
  const saved = await saveLaunchBrief(ctx, REQUEST_ID, { title: 'Title', content: 'Body', references: [richReference] }, TOKEN);
  const preview = await previewLaunchAssignment(ctx, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID, references: [richReference] }, TOKEN);
  const launch = await submitLaunchAssignment(ctx, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID, expectedDigest: DIGEST, references: [richReference] }, TOKEN);

  assert.deepEqual(saved, { brief: 'briefs/req-1.md' });
  assert.deepEqual(preview.record, { assignment_id: ASSIGNMENT_ID });
  assert.deepEqual(launch, { assignment: { assignment_id: ASSIGNMENT_ID }, observation: { assignment_id: ASSIGNMENT_ID } });
  const [saveCall, prepareCall, previewCall, launchCall] = calls;
  assert.equal(calls.length, 4);
  assert.equal(saveCall.url, '/api/thread/save-brief');
  assert.deepEqual(saveCall.body, { workspace_id: 'ws-1', thread_id: 'thread-1', request_id: REQUEST_ID, title: 'Title', content: 'Body', references: [{ kind: 'skill', id: 'skill-1' }] });
  assert.equal(prepareCall.url, '/api/dispatch/prepare-spec-target');
  assert.deepEqual(prepareCall.body, { workspace_id: 'ws-1', spec_package: '/storage/proj/specs/pkg', thread_id: 'thread-1' });
  assert.equal(previewCall.url, '/api/thread/preview-assignment');
  assert.deepEqual(previewCall.body, { workspace_id: 'ws-1', thread_id: 'thread-1', request_id: REQUEST_ID, assignment_id: ASSIGNMENT_ID, instructions: FIXED_INSTRUCTION, skill: 'review', specPackage: '/storage/proj/specs/pkg' });
  assert.equal(launchCall.url, '/api/thread/launch-assignment');
  assert.deepEqual(launchCall.body, { workspace_id: 'ws-1', thread_id: 'thread-1', request_id: REQUEST_ID, assignment_id: ASSIGNMENT_ID, instructions: FIXED_INSTRUCTION, skill: 'review', specPackage: '/storage/proj/specs/pkg', expectedDigest: DIGEST });
  for (const call of [previewCall, launchCall]) {
    assert.equal('references' in call.body, false, `thread ${call.url} reuses stored references`);
    assert.equal('repository_id' in call.body, false, `thread ${call.url} keeps its stored target`);
  }
  assertNoOverrides(calls);
});

test('direct bodies bind repository_id/spec_package with identity-only references and default skill', async (t) => {
  const calls = scopeFetch(t, [
    jsonResponse(200, { brief: 'briefs/req-1.md' }),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: ASSIGNMENT_ID }, contractDigest: DIGEST }),
    jsonResponse(200, { assignment: { assignment_id: ASSIGNMENT_ID }, observation: { assignment_id: ASSIGNMENT_ID } }),
  ]);
  const richReference = { kind: 'file' as const, id: 'src/b.ts', label: 'B', token: '@b', path: '/x' };
  const ctx: LaunchContext = { ws: 'ws-2', target: 'repo-2', package: '/storage/proj/specs/direct' };
  await saveLaunchBrief(ctx, REQUEST_ID, { title: 'T', content: 'C', references: [richReference] }, TOKEN);
  await previewLaunchAssignment(ctx, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID, references: [richReference] }, TOKEN);
  await submitLaunchAssignment(ctx, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID, expectedDigest: DIGEST, references: [richReference] }, TOKEN);

  const [saveCall, prepareCall, previewCall, launchCall] = calls;
  assert.equal(calls.length, 4);
  assert.equal(saveCall.url, '/api/dispatch/save-brief');
  assert.deepEqual(saveCall.body, { workspace_id: 'ws-2', request_id: REQUEST_ID, title: 'T', content: 'C' });
  assert.equal(prepareCall.url, '/api/dispatch/prepare-spec-target');
  assert.deepEqual(prepareCall.body, { workspace_id: 'ws-2', spec_package: '/storage/proj/specs/direct', repository_id: 'repo-2' });
  assert.equal(previewCall.url, '/api/dispatch/preview');
  assert.deepEqual(previewCall.body, { workspace_id: 'ws-2', repository_id: 'repo-2', request_id: REQUEST_ID, assignment_id: ASSIGNMENT_ID, instructions: FIXED_INSTRUCTION, references: [{ kind: 'file', id: 'src/b.ts' }], skill: 'general', spec_package: '/storage/proj/specs/direct' });
  assert.equal(launchCall.url, '/api/dispatch/launch');
  assert.deepEqual(launchCall.body, { ...previewCall.body, expectedDigest: DIGEST });
  assertNoOverrides(calls);
});

// A bound direct request carries the package's canonical primary path while
// the workspace inventory declares the repository as ~/relative/symlink text:
// the stored physical canonical_path resolves it to the registered id, and the
// request context itself stays unchanged. The declared-path fallback stays for
// older snapshots and the fixture.
test('direct canonical package target maps repository id via canonical_path without mutating the context', async (t) => {
  const workspace = {
    directory: '/home/operator/projects/ws-canonical',
    repositories: [{ id: 'repo-canonical', path: '~/checkouts/primary', status: 'ok', canonical_path: '/checkout/primary' }],
  };
  const calls = scopeFetch(t, [
    jsonResponse(200, workspace),
    jsonResponse(200, {}),
    jsonResponse(200, { record: { assignment_id: ASSIGNMENT_ID }, contractDigest: DIGEST }),
    jsonResponse(200, workspace),
    jsonResponse(200, { assignment: { assignment_id: ASSIGNMENT_ID }, observation: { assignment_id: ASSIGNMENT_ID } }),
  ]);
  const ctx: LaunchContext = { ws: 'ws-canonical', target: '/checkout/primary', package: '/storage/proj/specs/canonical' };
  const original = { ...ctx };
  const preview = await previewLaunchAssignment(ctx, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID }, TOKEN);
  const launch = await submitLaunchAssignment(ctx, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID, expectedDigest: DIGEST }, TOKEN);

  assert.deepEqual(preview, { record: { assignment_id: ASSIGNMENT_ID }, contractDigest: DIGEST });
  assert.deepEqual(launch, { assignment: { assignment_id: ASSIGNMENT_ID }, observation: { assignment_id: ASSIGNMENT_ID } });
  assert.deepEqual(ctx, original);
  const [workspaceCall, prepareCall, previewCall, workspaceAgain, launchCall] = calls;
  assert.equal(calls.length, 5);
  assert.equal(workspaceCall.url, '/api/workspace?id=ws-canonical');
  assert.equal(prepareCall.url, '/api/dispatch/prepare-spec-target');
  assert.deepEqual(prepareCall.body, { workspace_id: 'ws-canonical', spec_package: '/storage/proj/specs/canonical', repository_id: 'repo-canonical' });
  assert.equal(previewCall.url, '/api/dispatch/preview');
  assert.deepEqual(previewCall.body, {
    workspace_id: 'ws-canonical', repository_id: 'repo-canonical', request_id: REQUEST_ID, assignment_id: ASSIGNMENT_ID,
    instructions: FIXED_INSTRUCTION, references: [], skill: 'general', spec_package: '/storage/proj/specs/canonical',
  });
  assert.equal(workspaceAgain.url, '/api/workspace?id=ws-canonical');
  assert.equal(launchCall.url, '/api/dispatch/launch');
  assert.deepEqual(launchCall.body, { ...previewCall.body, expectedDigest: DIGEST });
  assertNoOverrides([prepareCall, previewCall, launchCall]);
});

// An ambiguous usable mapping refuses before prepare/preview; only the
// workspace read happens.
test('direct canonical package target refuses an ambiguous usable mapping before any POST', async (t) => {
  const calls = scopeFetch(t, [jsonResponse(200, {
    directory: '/home/operator/projects/ws-canonical',
    repositories: [
      { id: 'repo-one', path: '/checkout/primary', status: 'ok', canonical_path: '/checkout/primary' },
      { id: 'repo-two', path: '~/checkouts/primary', status: 'ok', canonical_path: '/checkout/primary' },
    ],
  })]);
  const ctx: LaunchContext = { ws: 'ws-canonical', target: '/checkout/primary', package: '/storage/proj/specs/canonical' };
  await assert.rejects(
    previewLaunchAssignment(ctx, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID }, TOKEN),
    /matches more than one repository/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/workspace?id=ws-canonical');
});

// A matching canonical_path on an unusable record never counts, and an absent
// mapping refuses before prepare/preview.
test('direct canonical package target refuses an absent or unusable mapping before any POST', async (t) => {
  const calls = scopeFetch(t, [jsonResponse(200, {
    directory: '/home/operator/projects/ws-canonical',
    repositories: [
      { id: 'repo-other', path: '/checkout/other', status: 'ok', canonical_path: '/checkout/other' },
      { id: 'repo-unusable', path: '~/checkouts/primary', status: 'not_git', canonical_path: '/checkout/primary' },
    ],
  })]);
  const ctx: LaunchContext = { ws: 'ws-canonical', target: '/checkout/primary', package: '/storage/proj/specs/canonical' };
  await assert.rejects(
    previewLaunchAssignment(ctx, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID }, TOKEN),
    /is not a usable repository/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/workspace?id=ws-canonical');
});

// The bound direct surface sends the publication authority it was seeded with
// on preview and launch; thread requests keep the stored binding and never
// carry it. Authority-unset defaults stay covered by the earlier
// forbidden-override checks.
test('direct authority reaches preview and launch bodies while thread contexts omit it', async (t) => {
  const calls = scopeFetch(t, [
    jsonResponse(200, { record: { assignment_id: ASSIGNMENT_ID }, contractDigest: DIGEST }),
    jsonResponse(200, { assignment: { assignment_id: ASSIGNMENT_ID }, observation: { assignment_id: ASSIGNMENT_ID } }),
    jsonResponse(200, { record: { assignment_id: ASSIGNMENT_ID }, contractDigest: DIGEST }),
    jsonResponse(200, { assignment: { assignment_id: ASSIGNMENT_ID }, observation: { assignment_id: ASSIGNMENT_ID } }),
    jsonResponse(200, { record: { assignment_id: ASSIGNMENT_ID }, contractDigest: DIGEST }),
    jsonResponse(200, { assignment: { assignment_id: ASSIGNMENT_ID }, observation: { assignment_id: ASSIGNMENT_ID } }),
  ]);
  const noneCtx: AuthorityContext = { ws: 'ws-auth', target: 'repo-auth', authority: 'none' };
  const draftCtx: AuthorityContext = { ws: 'ws-auth', target: 'repo-auth', authority: 'draft-pr' };
  const threadCtx: AuthorityContext = { ws: 'ws-auth', thread: 'thread-auth', authority: 'draft-pr' };
  const ids = { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID };
  const launchIds = { ...ids, expectedDigest: DIGEST };
  await previewLaunchAssignment(noneCtx, ids, TOKEN);
  await submitLaunchAssignment(noneCtx, launchIds, TOKEN);
  await previewLaunchAssignment(draftCtx, ids, TOKEN);
  await submitLaunchAssignment(draftCtx, launchIds, TOKEN);
  await previewLaunchAssignment(threadCtx, ids, TOKEN);
  await submitLaunchAssignment(threadCtx, launchIds, TOKEN);

  const [nonePreview, noneLaunch, draftPreview, draftLaunch, threadPreview, threadLaunch] = calls;
  assert.equal(nonePreview.url, '/api/dispatch/preview');
  assert.equal(nonePreview.body.publication_authority, 'none');
  assert.equal(noneLaunch.url, '/api/dispatch/launch');
  assert.equal(noneLaunch.body.publication_authority, 'none');
  assert.equal(draftPreview.url, '/api/dispatch/preview');
  assert.equal(draftPreview.body.publication_authority, 'draft-pr');
  assert.equal(draftLaunch.url, '/api/dispatch/launch');
  assert.equal(draftLaunch.body.publication_authority, 'draft-pr');
  assert.equal(threadPreview.url, '/api/thread/preview-assignment');
  assert.equal('publication_authority' in threadPreview.body, false, 'thread preview keeps the stored binding');
  assert.equal(threadLaunch.url, '/api/thread/launch-assignment');
  assert.equal('publication_authority' in threadLaunch.body, false, 'thread launch keeps the stored binding');

  // Only the explicit publication_authority field may appear on direct
  // requests; every other runtime override stays out, and the thread requests
  // keep the complete default check.
  for (const call of [nonePreview, noneLaunch, draftPreview, draftLaunch]) {
    for (const field of FORBIDDEN_FIELDS) {
      if (field === 'publication_authority') continue;
      assert.equal(field in call.body, false, `${field} must not be sent to ${call.url}`);
    }
  }
  assertNoOverrides([threadPreview, threadLaunch]);
});

test('absent target and package are omitted per surface while skill defaults to general', async (t) => {
  const calls = scopeFetch(t, [
    jsonResponse(200, { record: {}, contractDigest: '' }),
    jsonResponse(200, { record: {}, contractDigest: '' }),
  ]);
  const direct: LaunchContext = { ws: 'ws-3', target: null };
  const thread: LaunchContext = { ws: 'ws-3', thread: 'thread-3' };
  await previewLaunchAssignment(direct, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID }, TOKEN);
  await previewLaunchAssignment(thread, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID }, TOKEN);
  const [directCall, threadCall] = calls;
  assert.equal('repository_id' in directCall.body, false);
  assert.equal('spec_package' in directCall.body, false);
  assert.equal(directCall.body.skill, 'general');
  assert.deepEqual(directCall.body.references, []);
  assert.equal('specPackage' in threadCall.body, false);
  assert.equal(threadCall.body.skill, 'general');
  assert.equal('references' in threadCall.body, false);
});

test('direct and thread success responses normalize to the same preview and launch shapes', async (t) => {
  const rawPreview = { record: { assignment_id: ASSIGNMENT_ID, state: 'preview' }, contractDigest: DIGEST, inputPreview: { brief: 'B', instruction: FIXED_INSTRUCTION, references: [] }, extra: 'dropped' };
  const rawReply = { assignment: { assignment_id: ASSIGNMENT_ID, state: 'live' }, observation: { state: 'observing' }, extra: 'dropped' };
  const calls = scopeFetch(t, [
    jsonResponse(200, rawPreview), jsonResponse(200, rawReply),
    jsonResponse(200, rawPreview), jsonResponse(200, rawReply),
  ]);
  const direct: LaunchContext = { ws: 'ws-4', target: 'repo-4' };
  const thread: LaunchContext = { ws: 'ws-4', thread: 'thread-4' };
  const directPreview = await previewLaunchAssignment(direct, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID }, TOKEN);
  const directReply = await submitLaunchAssignment(direct, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID, expectedDigest: DIGEST }, TOKEN);
  const threadPreview = await previewLaunchAssignment(thread, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID }, TOKEN);
  const threadReply = await submitLaunchAssignment(thread, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID, expectedDigest: DIGEST }, TOKEN);

  const expectedPreview = { record: rawPreview.record, contractDigest: DIGEST, inputPreview: rawPreview.inputPreview };
  const expectedReply = { assignment: rawReply.assignment, observation: rawReply.observation };
  assert.deepEqual(directPreview, expectedPreview);
  assert.deepEqual(threadPreview, expectedPreview);
  assert.deepEqual(directReply, expectedReply);
  assert.deepEqual(threadReply, expectedReply);
  assert.equal(calls.length, 4);
});

test('missing preview and launch fields degrade to empty records and an empty digest', async (t) => {
  scopeFetch(t, [jsonResponse(200, {}), jsonResponse(200, {})]);
  const ctx: LaunchContext = { ws: 'ws-5', target: 'repo-5' };
  const preview = await previewLaunchAssignment(ctx, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID }, TOKEN);
  const reply = await submitLaunchAssignment(ctx, { requestId: REQUEST_ID, assignmentId: ASSIGNMENT_ID, expectedDigest: DIGEST }, TOKEN);
  assert.deepEqual(preview, { record: {}, contractDigest: '' });
  assert.equal('inputPreview' in preview, false);
  assert.deepEqual(reply, { assignment: {}, observation: {} });
});

// node --import tsx --test --test-name-pattern="suggestion sources" src/launch-client.test.ts
test('suggestion sources follow the owning binding and never retarget a thread draft', () => {
  // A thread context reads the stored thread binding with the exact UUID; the
  // route-carried and retained draft targets stay out of the request.
  assert.deepEqual(suggestionSourceFor({ ws: 'ws-1', thread: 'thread-1', target: 'route-target' }, 'draft-target'), {
    path: '/api/thread/suggestions',
    params: { workspace_id: 'ws-1', thread_id: 'thread-1' },
  });
  // Direct contexts keep the retained draft target, and a null target omits
  // the repository parameter instead of inventing one.
  assert.deepEqual(suggestionSourceFor({ ws: 'ws-2' }, 'repo-2'), {
    path: '/api/dispatch/suggestions',
    params: { workspace_id: 'ws-2', repository_id: 'repo-2' },
  });
  assert.deepEqual(suggestionSourceFor({ ws: 'ws-2' }, null), {
    path: '/api/dispatch/suggestions',
    params: { workspace_id: 'ws-2' },
  });
});
