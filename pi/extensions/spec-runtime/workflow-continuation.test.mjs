import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makePackageFixture } from './package-fixture.mjs';
import { recordCheckpoint } from './sentinel.mjs';
import { createWorkflowContinuation } from './workflow-continuation.mjs';

const boundary = () => ({ entries: [], continue: false, outcome: 'completed', context: { pendingMessages: [] } });
async function fixture(t) {
  const f = await makePackageFixture({ prefix: 'workflow-continuation-' });
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const pkg = f.packagePath, session = join(f.dir, 'coordinator.jsonl'), entries = [], notes = [];
  const pi = { appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) };
  const ctx = { sessionManager: { getSessionFile: () => session, getBranch: () => entries } };
  mkdirSync(join(pkg, 'inbox')); mkdirSync(join(pkg, 'processed'));
  writeFileSync(join(pkg, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1 }, { step: 2 }] }));
  let revision = 0;
  const checkpoint = (overrides = {}) => {
    const record = recordCheckpoint({ package: pkg, workflow_id: 'workflow', expected_revision: revision,
      state: 'ready', obligation: { key: 'review:step-1', stage: 'review', summary: 'Review the completed step', artifacts: [] },
      workers: [], inbox: { items: [] }, reconciles_input_revision: 0, coordinator_session: session, checkout: f.repo, ...overrides });
    revision = record.revision; return record;
  };
  const record = checkpoint();
  const guards = { coordinator_session: session, inputGuard: { input_revision: 0, active_prompts: 0 },
    activeManaged: false, notify: message => notes.push(message) };
  return { ...f, pkg, pi, entries, notes, ctx, checkpoint, record, guards };
}

// Run alone: node --test pi/extensions/spec-runtime/workflow-continuation.test.mjs
test('owned workflow survives resume and intermediate completion until final publication facts exist', async t => {
  const f = await fixture(t);
  let workflow = createWorkflowContinuation(f.pi);
  assert.equal(workflow.beforeSettle(boundary(), f.guards), undefined, 'ordinary checkpoint is not an opt-in');
  workflow.register(f.record, 'Complete both steps, independent review and a draft PR; no merge.');
  const first = workflow.beforeSettle(boundary(), f.guards);
  assert.equal(first.continue, true);
  assert.match(first.entries[0].content, /draft PR; no merge/);
  workflow = createWorkflowContinuation(f.pi); workflow.restore(f.ctx);
  assert.match(workflow.context({ messages: [] }).messages[0].content, /both steps/);
  f.checkpoint({ state: 'complete' });
  assert.equal(workflow.beforeSettle(boundary(), f.guards).continue, true, 'premature whole-workflow completion does not erase the objective');
  mkdirSync(join(f.pkg, 'runtime/stages'), { recursive: true });
  writeFileSync(join(f.pkg, 'runtime/progress.json'), JSON.stringify({ runs: [1, 2].map(step => ({
    step: `step-00${step}-subspec.md`, execution: 'completed', handoff: { status: 'recorded', outcome: 'as-specified' } })) }));
  writeFileSync(join(f.pkg, 'runtime/stages/publication.json'), JSON.stringify({ status: 'complete', artifacts: ['pr-url.json'] }));
  writeFileSync(join(f.pkg, 'pr-url.json'), JSON.stringify({ targets: { repo: { url: 'https://example.invalid/pull/1', mode: 'draft' } } }));
  assert.equal(workflow.beforeSettle(boundary(), f.guards), undefined);
  assert.equal(existsSync(join(f.pkg, 'runtime/sentinel/workflow/authority/grant.json')), false, 'Sentinel is never armed');
});

test('owned workflow respects holds, active work, new input and aborts without consuming a continuation', async t => {
  const f = await fixture(t), workflow = createWorkflowContinuation(f.pi);
  workflow.register(f.record, 'Finish the package locally.', 'work-tour');
  const saved = f.entries.length;
  for (const state of ['user-held', 'blocked', 'decision-required', 'waiting-worker', 'waiting-external', 'unknown']) {
    f.checkpoint({ state }); assert.equal(workflow.beforeSettle(boundary(), f.guards), undefined);
  }
  f.checkpoint();
  for (const changed of [{ outcome: 'aborted' }, { outcome: 'error' }, { continue: true }, { context: { pendingMessages: [{}] } }])
    assert.equal(workflow.beforeSettle({ ...boundary(), ...changed }, f.guards), undefined);
  for (const changed of [{ activeManaged: true }, { coordinator_session: 'different' },
    { inputGuard: { input_revision: 1, active_prompts: 0 } }, { inputGuard: { input_revision: 0, active_prompts: 1 } }])
    assert.equal(workflow.beforeSettle(boundary(), { ...f.guards, ...changed }), undefined);
  f.checkpoint({ workers: [{ id: 'reviewer', kind: 'review', state: 'working' }] });
  assert.equal(workflow.beforeSettle(boundary(), f.guards), undefined);
  f.checkpoint();
  writeFileSync(join(f.pkg, 'inbox/unread.md'), 'Unreconciled direction');
  assert.equal(workflow.beforeSettle(boundary(), f.guards), undefined);
  assert.equal(f.entries.length, saved);
});

test('owned workflow exposes a repeated stall and resume cannot replenish the same obligation', async t => {
  const f = await fixture(t);
  let workflow = createWorkflowContinuation(f.pi);
  workflow.register(f.record, 'Finish the package.');
  assert.equal(workflow.beforeSettle(boundary(), f.guards).continue, true);
  assert.equal(workflow.beforeSettle(boundary(), f.guards).continue, true);
  workflow = createWorkflowContinuation(f.pi); workflow.restore(f.ctx);
  workflow.register(f.record, 'Finish the package.');
  assert.equal(workflow.beforeSettle(boundary(), f.guards), undefined);
  assert.equal(workflow.beforeSettle(boundary(), f.guards), undefined);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0], /unfinished/);
  f.checkpoint({ obligation: { key: 'implementation:step-2', stage: 'implementation', summary: 'Implement step 2', artifacts: [] } });
  assert.equal(workflow.beforeSettle(boundary(), f.guards).continue, true);
  workflow.restore({ sessionManager: { getSessionFile: () => 'another-session', getBranch: () => f.entries } });
  assert.equal(workflow.context({ messages: [] }), undefined);
});
