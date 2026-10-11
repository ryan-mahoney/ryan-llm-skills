import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decideFinalCheckpoint, completeWorkflowsAfterPublication } from './final-checkpoint.mjs';
import { recordCheckpoint as recordSentinelCheckpoint, readCheckpointRecord } from './sentinel.mjs';
import { recordCheckpoint } from './completion.mjs';
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

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'final-checkpoint-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Final Checkpoint'); git('config', 'user.email', 'final@example.invalid');
  writeFileSync(join(repo, 'README'), 'fixture\n'); git('add', 'README'); git('commit', '-qm', 'Initial fixture');
  const pkg = join(repo, '.specs', 'feature');
  mkdirSync(join(pkg, 'runtime', 'runs'), { recursive: true });
  writeFileSync(join(pkg, 'spec.md'), '# spec\n');
  writeFileSync(join(pkg, 'runtime', 'progress.json'), JSON.stringify({ runs: [] }));
  return { base, repo, pkg };
}

const session = 'session-1';
const register = (pkg, workers, inbox = { items: [] }) => recordSentinelCheckpoint({ package: pkg, workflow_id: 'wf-1', expected_revision: 0, state: 'ready',
  obligation: { key: 'implement:step-1', stage: 'implementation', summary: 'working', artifacts: [] }, workers, inbox,
  reconciles_input_revision: 3, coordinator_session: session, checkout: null });
const finish = (pkg, known = [{ package: pkg, workflow_id: 'wf-1' }]) => completeWorkflowsAfterPublication({ package: pkg, known,
  coordinator_session: session, input_revision: 3 });

test('publication complete closes the workflow so the observer reports the package as recently completed', async t => {
  const { base, repo, pkg } = fixture(t);
  register(pkg, [owner('working')]);
  writeFileSync(join(pkg, 'runtime', 'runs', 'run-1.json'), JSON.stringify({ id: 'run-1', package: pkg, state: 'completed',
    started_at: new Date(Date.now() - 60000).toISOString() }));
  writeFileSync(join(pkg, 'pr-url.json'), JSON.stringify({ kind: 'pr_submission', package: pkg, url: 'https://github.com/o/r/pull/9' }));
  const input = { roots: [repo], indexDir: join(base, 'index'), now: () => Date.now() };
  assert.equal((await collectWorkspace(input)).recently_completed.length, 0, 'ready checkpoint is still current work');

  const stage = recordCheckpoint(pkg, { stage: 'spec-pr', status: 'complete', next: 'Done', decisions: [], artifacts: ['spec.md'] });
  assert.equal(stage.stage, 'publication');
  const [outcome] = finish(pkg);
  assert.deepEqual(outcome, { workflow_id: 'wf-1', outcome: 'complete', revision: 2 });

  const stored = readCheckpointRecord(pkg, 'wf-1');
  assert.equal(stored.state, 'complete');
  assert.deepEqual(stored.workers, [owner('complete')]);
  assert.equal(stored.obligation.summary, 'Publication complete: https://github.com/o/r/pull/9');
  const snapshot = await collectWorkspace(input);
  assert.deepEqual(snapshot.recently_completed.map(run => [run.package, run.completion_basis]), [[pkg, 'workflow-checkpoint']]);
  assert.equal(snapshot.runs.some(run => run.package === pkg), false);
});

test('publication complete leaves a package with a running worker for the coordinator to finish', t => {
  const { pkg } = fixture(t);
  register(pkg, [owner('working')]);
  writeFileSync(join(pkg, 'runtime', 'runs', 'run-1.json'), JSON.stringify({ id: 'run-1', package: pkg, state: 'running' }));
  assert.deepEqual(finish(pkg), [{ workflow_id: 'wf-1', outcome: 'skipped', reason: 'worker-active: run-1' }]);
  assert.equal(readCheckpointRecord(pkg, 'wf-1').state, 'ready');
});

test('publication complete finds this coordinator\'s workflows on disk when none are registered in memory', t => {
  const { pkg } = fixture(t);
  register(pkg, []);
  assert.equal(finish(pkg, [])[0].outcome, 'complete');
  assert.deepEqual(completeWorkflowsAfterPublication({ package: pkg, known: [], coordinator_session: 'other', input_revision: 3 }), []);
});
