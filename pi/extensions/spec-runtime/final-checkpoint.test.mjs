import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { decideFinalCheckpoint, completeWorkflowsAfterPublication } from './final-checkpoint.mjs';
import { recordCheckpoint as recordSentinelCheckpoint, readCheckpointRecord } from './sentinel.mjs';
import { recordCheckpoint } from './completion.mjs';
import { makePackageFixture } from './package-fixture.mjs';
import { collectWorkspace } from '../../../scripts/spec-observe/sentinel.mjs';

const owner = (state, id = 'run-1') => ({ id, kind: 'owner', state });
const checkpoint = (over = {}) => ({ state: 'ready', workers: [owner('working')], inbox: { items: [] }, ...over });

test('final checkpoint decision: already complete is skipped', () => {
  assert.deepEqual(decideFinalCheckpoint(checkpoint({ state: 'complete' }), []), { action: 'skip', reason: 'already-complete' });
});

test('final checkpoint decision: receipts resolve working workers and terminal workers are kept', () => {
  const workers = [owner('working', 'a'), owner('complete', 'b'), owner('working', 'c'), owner('failed', 'd')];
  const receipts = [{ id: 'a', state: 'completed' }, { id: 'run-c', assignment_id: 'c', state: 'cancelled' }];
  assert.deepEqual(decideFinalCheckpoint(checkpoint({ workers }), receipts), { action: 'complete', workers: [
    owner('complete', 'a'), owner('complete', 'b'), owner('cancelled', 'c'), owner('failed', 'd')] });
});

test('final checkpoint decision: a running or unreceipted worker blocks completion', () => {
  assert.deepEqual(decideFinalCheckpoint(checkpoint(), [{ id: 'run-1', state: 'running' }]), { action: 'skip', reason: 'worker-active: run-1' });
  assert.deepEqual(decideFinalCheckpoint(checkpoint(), [{ id: 'other', state: 'completed' }]), { action: 'skip', reason: 'worker-unknown: run-1' });
});

test('final checkpoint decision: a retried assignment uses its latest receipt', () => {
  const receipts = [{ id: 'r1', assignment_id: 'run-1', state: 'failed', started_at: '2026-10-06T10:00:00Z' },
    { id: 'r2', assignment_id: 'run-1', state: 'completed', started_at: '2026-10-06T11:00:00Z' }];
  assert.deepEqual(decideFinalCheckpoint(checkpoint(), receipts).workers, [owner('complete')]);
});

test('final checkpoint decision: a human hold or unresolved direction is not closed over', () => {
  const receipts = [{ id: 'run-1', state: 'completed' }];
  assert.equal(decideFinalCheckpoint(checkpoint({ state: 'user-held' }), receipts).reason, 'state: user-held');
  const inbox = { items: [{ id: 'hold-1', sha256: 'a'.repeat(64), outcome: 'held' }] };
  assert.equal(decideFinalCheckpoint(checkpoint({ inbox }), receipts).reason, 'inbox-unresolved: hold-1');
});

async function fixture(t) {
  const base = await makePackageFixture({ prefix: 'final-checkpoint-' });
  t.after(() => rmSync(base.dir, { recursive: true, force: true }));
  const pkg = base.packagePath;
  mkdirSync(join(pkg, 'runtime', 'runs'), { recursive: true });
  writeFileSync(join(pkg, 'spec.md'), '# spec\n');
  writeFileSync(join(pkg, 'runtime', 'progress.json'), JSON.stringify({ runs: [] }));
  return { base: base.dir, repo: base.repo, root: base.root, pkg, ref: base.ref, location: base.location };
}

const session = 'session-1';
const register = (pkg, workers, inbox = { items: [] }) => recordSentinelCheckpoint({ package: pkg, workflow_id: 'wf-1', expected_revision: 0, state: 'ready',
  obligation: { key: 'implement:step-1', stage: 'implementation', summary: 'working', artifacts: [] }, workers, inbox,
  reconciles_input_revision: 3, coordinator_session: session, checkout: null });
const finish = (pkg, known = [{ package: pkg, workflow_id: 'wf-1' }], location, input = pkg) => completeWorkflowsAfterPublication({ package: input, known,
  coordinator_session: session, input_revision: 3, location });

test('publication complete closes the workflow so the observer reports the package as recently completed', async t => {
  const { base, repo, root, pkg, ref, location } = await fixture(t);
  register(pkg, [owner('working')]);
  writeFileSync(join(pkg, 'runtime', 'runs', 'run-1.json'), JSON.stringify({ id: 'run-1', package: pkg, state: 'completed',
    started_at: new Date(Date.now() - 60000).toISOString() }));
  writeFileSync(join(pkg, 'pr-url.json'), JSON.stringify({ package_ref: ref, targets: { repo: { url: 'https://github.com/o/r/pull/9', number: 9 } } }));
  const input = { packages: [pkg], storageRoot: root, indexDir: join(base, 'index'), now: () => Date.now() };
  assert.equal((await collectWorkspace(input)).recently_completed.length, 0, 'ready checkpoint is still current work');

  const stage = recordCheckpoint(pkg, { stage: 'spec-pr', status: 'complete', next: 'Done', decisions: [], artifacts: ['spec.md'] });
  assert.equal(stage.stage, 'publication');
  const [outcome] = await finish(pkg, undefined, location);
  assert.deepEqual(outcome, { workflow_id: 'wf-1', outcome: 'complete', revision: 2 });

  const stored = readCheckpointRecord(pkg, 'wf-1');
  assert.equal(stored.state, 'complete');
  assert.deepEqual(stored.workers, [owner('complete')]);
  assert.equal(stored.obligation.summary, 'Publication complete: https://github.com/o/r/pull/9');
  const snapshot = await collectWorkspace(input);
  assert.deepEqual(snapshot.recently_completed.map(run => [run.package, run.completion_basis]), [[pkg, 'workflow-checkpoint']]);
  assert.equal(snapshot.runs.some(run => run.package === pkg), false);
});

test('publication complete leaves a package with a running worker for the coordinator to finish', async t => {
  const { pkg, location } = await fixture(t);
  register(pkg, [owner('working')]);
  writeFileSync(join(pkg, 'runtime', 'runs', 'run-1.json'), JSON.stringify({ id: 'run-1', package: pkg, state: 'running' }));
  assert.deepEqual(await finish(pkg, undefined, location), [{ workflow_id: 'wf-1', outcome: 'skipped', reason: 'worker-active: run-1' }]);
  assert.equal(readCheckpointRecord(pkg, 'wf-1').state, 'ready');
});

test('publication complete finds this coordinator\'s workflows on disk when none are registered in memory', async t => {
  const { pkg, ref, location } = await fixture(t);
  register(pkg, []);
  // The package may be named by its workspace/slug ref; the workflow is found in the located folder.
  assert.equal((await finish(pkg, [], location, ref))[0].outcome, 'complete');
  assert.deepEqual(await completeWorkflowsAfterPublication({ package: pkg, known: [], coordinator_session: 'other', input_revision: 3, location }), []);
});

test('with two targets, publication complete waits until both targets have a pull request URL', async t => {
  const base = await makePackageFixture({ prefix: 'final-checkpoint-', repos: ['repo', 'second'], targets: ['repo', 'second'] });
  t.after(() => rmSync(base.dir, { recursive: true, force: true }));
  const pkg = base.packagePath;
  mkdirSync(join(pkg, 'runtime', 'runs'), { recursive: true });
  register(pkg, []);
  const pr = targets => writeFileSync(join(pkg, 'pr-url.json'), JSON.stringify({ package_ref: base.ref, targets }));
  pr({ repo: { url: 'https://github.com/o/r/pull/9' } });
  assert.deepEqual(await finish(pkg, undefined, base.location), [{ workflow_id: 'wf-1', outcome: 'skipped', reason: 'pr-missing: second' }]);
  assert.equal(readCheckpointRecord(pkg, 'wf-1').state, 'ready');
  pr({ repo: { url: 'https://github.com/o/r/pull/9' }, second: { url: 'https://github.com/o/s/pull/4' } });
  const [outcome] = await finish(pkg, undefined, base.location);
  assert.equal(outcome.outcome, 'complete');
  assert.equal(readCheckpointRecord(pkg, 'wf-1').obligation.summary, 'Publication complete');
});
