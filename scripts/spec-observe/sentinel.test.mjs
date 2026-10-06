import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { SENTINEL_LIMITS, collectWorkspace, reduceConditions, renderWorkspace } from './sentinel.mjs';

const FIXED = Date.parse('2026-10-06T12:00:00.000Z');
const now = () => FIXED;
const ago = ms => new Date(FIXED - ms).toISOString();

// Real disposable Git primaries and an empty managed index: no fixture may read
// the operator's live ~/.pi/agent/spec-runtime state.
function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sentinel-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, indexDir: join(dir, 'index') };
}

function primary(base, name) {
  const repo = join(base, name);
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Sentinel Test');
  git('config', 'user.email', 'sentinel@example.invalid');
  writeFileSync(join(repo, 'README'), 'fixture\n');
  git('add', 'README');
  git('commit', '-qm', 'Initial fixture');
  return repo;
}

function pack(repo, name = 'feature') {
  const packagePath = join(repo, '.specs', name);
  mkdirSync(packagePath, { recursive: true });
  return packagePath;
}

function receipt(packagePath, record) {
  const file = join(packagePath, 'runtime', 'runs', `${record.id}.json`);
  mkdirSync(join(packagePath, 'runtime', 'runs'), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...record, package: record.package ?? packagePath }));
  return file;
}

function activity(packagePath, id, role, state) {
  const dir = join(packagePath, 'runtime', 'runs', `${id}-activity`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${role}.json`), JSON.stringify(state));
}

const condition = (run, kind) => run.conditions.find(item => item.kind === kind);

test('same-basename packages keep distinct identities and a linked-worktree copy is not canonical', async t => {
  const f = sandbox(t);
  const one = pack(primary(f.dir, 'alpha'));
  const two = pack(primary(f.dir, 'beta'));
  receipt(one, { id: 'run-one', assignment_id: 'assign-one', state: 'running',
    started_at: ago(60000), parent_session: '/sessions/one.jsonl', lock: join(one, '..', '..', '.git', 'spec-runtime.lock') });
  receipt(two, { id: 'run-two', assignment_id: 'assign-two', state: 'running',
    started_at: ago(60000), parent_session: '/sessions/two.jsonl', lock: join(two, '..', '..', '.git', 'spec-runtime.lock') });

  const snapshot = await collectWorkspace({ roots: [join(f.dir, 'alpha'), join(f.dir, 'beta')], indexDir: f.indexDir, now });
  assert.equal(snapshot.runs.length, 2);
  assert.deepEqual(snapshot.runs.map(run => run.package.split('/').pop()), ['feature', 'feature']);
  assert.notEqual(snapshot.runs[0].package, snapshot.runs[1].package);
  assert.notEqual(snapshot.runs[0].repository, snapshot.runs[1].repository);
  assert.deepEqual(snapshot.runs.map(run => run.workflow_id), [null, null]);
  assert.deepEqual(new Set(snapshot.runs.map(run => run.coordinator_session)),
    new Set(['/sessions/one.jsonl', '/sessions/two.jsonl']));

  // A .specs copy inside a linked worktree is not an authoritative package.
  const alpha = join(f.dir, 'alpha');
  const worktree = join(alpha, 'worktree');
  execFileSync('git', ['-C', alpha, 'worktree', 'add', '-q', worktree], { stdio: 'pipe' });
  const copy = join(worktree, '.specs', 'feature');
  mkdirSync(copy, { recursive: true });
  const rejected = await collectWorkspace({ roots: [worktree], packages: [copy], indexDir: f.indexDir, now });
  assert.equal(rejected.runs.length, 0);
  assert.notEqual(rejected.coverage.state, 'complete');
  assert.ok(rejected.coverage.reasons.some(reason => /worktree|primary checkout/i.test(reason)),
    JSON.stringify(rejected.coverage.reasons));
});

test('root and assignment caps report partial coverage and explicit omissions', async t => {
  const f = sandbox(t);
  for (let index = 0; index < 21; index++) {
    const packagePath = pack(primary(f.dir, `repo-${String(index).padStart(2, '0')}`));
    receipt(packagePath, { id: `run-${index}`, assignment_id: `assign-${index}`, state: 'completed', started_at: ago(60000) });
  }
  const roots = [];
  for (let index = 0; index < 21; index++) roots.push(join(f.dir, `repo-${String(index).padStart(2, '0')}`));
  const capped = await collectWorkspace({ roots, indexDir: f.indexDir, now });
  assert.equal(capped.runs.length, 20);
  assert.equal(capped.coverage.state, 'partial');
  assert.equal(capped.coverage.omitted, 1);
  assert.ok(capped.coverage.reasons.some(reason => reason.startsWith('roots-cap')), JSON.stringify(capped.coverage.reasons));
  assert.ok(capped.coverage.bytes_read <= SENTINEL_LIMITS.totalBytes);

  const many = pack(primary(f.dir, 'crowded'));
  for (let index = 0; index < 51; index++) {
    receipt(many, { id: `assignment-${index}`, assignment_id: `assignment-${index}`,
      state: index === 50 ? 'running' : 'completed', started_at: ago(60000) });
  }
  const selected = await collectWorkspace({ roots: [join(f.dir, 'crowded')], indexDir: f.indexDir, now });
  assert.equal(selected.runs.length, SENTINEL_LIMITS.assignments);
  assert.equal(selected.coverage.state, 'partial');
  assert.equal(selected.coverage.omitted, 1);
  assert.ok(selected.coverage.reasons.some(reason => reason.startsWith('assignments-cap')), JSON.stringify(selected.coverage.reasons));
  assert.ok(selected.runs.some(run => run.assignment_id === 'assignment-50' && run.execution === 'running'));
});

test('oversized, replaced and absent snapshots stay explicit and no secret or cost is retained', async t => {
  const f = sandbox(t);
  const packagePath = pack(primary(f.dir, 'privacy'));
  const lock = join(realpathSync(join(packagePath, '..', '..')), '.git', 'spec-runtime.lock');
  mkdirSync(lock, { recursive: true });
  receipt(packagePath, { id: 'run-oversized', assignment_id: 'assign-oversized', state: 'running',
    started_at: ago(60000), lock, result: 'raw command body secret', token: 'lease-token-secret', usage: { cost: 0 } });
  activity(packagePath, 'run-oversized', 'owner',
    { run_id: 'run-oversized', role: 'owner', phase: 'working', activity: 'x'.repeat(SENTINEL_LIMITS.activityBytes + 1), last_activity: ago(30000) });
  writeFileSync(join(lock, 'lease.json'), JSON.stringify({ id: 'other-run', token: 'lease-token-secret', revoked: false }));
  receipt(packagePath, { id: 'run-replaced', assignment_id: 'assign-replaced', state: 'running', started_at: ago(60000) });
  activity(packagePath, 'run-replaced', 'owner', { run_id: 'foreign-run', role: 'owner', phase: 'working', activity: 'replaced', last_activity: ago(30000) });
  receipt(packagePath, { id: 'run-missing', assignment_id: 'assign-missing', state: 'running', started_at: ago(60000) });

  const snapshot = await collectWorkspace({ roots: [join(f.dir, 'privacy')], indexDir: f.indexDir, now });
  const byAssignment = id => snapshot.runs.find(run => run.assignment_id === id);

  const oversized = byAssignment('assign-oversized');
  assert.equal(oversized.activity, null);
  assert.ok(oversized.coverage.reasons.includes('activity-oversized: owner'));
  assert.ok(oversized.coverage.reasons.includes('lease-mismatch'));
  assert.deepEqual(condition(oversized, 'activity-unreadable'), { ...condition(oversized, 'activity-unreadable'), severity: 'attention', state: 'unknown' });
  assert.deepEqual(condition(oversized, 'lease-mismatch'), { ...condition(oversized, 'lease-mismatch'), severity: 'attention', state: 'open' });

  const replaced = byAssignment('assign-replaced');
  assert.equal(replaced.activity, null);
  assert.equal(replaced.coverage.state, 'stale');
  assert.deepEqual(condition(replaced, 'activity-mismatch'), { ...condition(replaced, 'activity-mismatch'), severity: 'attention', state: 'unknown' });

  const missing = byAssignment('assign-missing');
  assert.equal(missing.activity, null);
  assert.deepEqual(condition(missing, 'activity-unknown'), { ...condition(missing, 'activity-unknown'), severity: 'info', state: 'unknown' });

  const rendered = renderWorkspace(snapshot).join('\n');
  for (const text of [JSON.stringify(snapshot), rendered]) {
    assert.equal(text.includes('raw command body secret'), false);
    assert.equal(text.includes('lease-token-secret'), false);
    assert.equal(text.includes('cost'), false);
  }
});

test('completion reconciles, ordinary startup and benign silence never become spinning', async t => {
  const f = sandbox(t);
  const packagePath = pack(primary(f.dir, 'conditions'));
  writeFileSync(join(packagePath, 'spec-steps.json'), JSON.stringify({ steps: [
    { step: 1, name: 'Prepare inputs' }, { step: 2, name: 'Draft reader' }, { step: 3, name: 'Collect bounded workspace facts' },
    { step: 4, name: 'Wire commands' }, { step: 5, name: 'Record failures' }, { step: 6, name: 'Record obligations' },
    { step: 7, name: 'Share owned leaf' }, { step: 8, name: 'Finish' }] }));

  receipt(packagePath, { id: 'run-complete', assignment_id: 'assign-complete', state: 'completed',
    step: join(packagePath, 'step-003-subspec.md'), started_at: ago(360000), finished_at: ago(60000) });
  activity(packagePath, 'run-complete', 'owner', { run_id: 'run-complete', role: 'owner', phase: 'returned', activity: 'returned to coordinator', last_activity: ago(60000) });

  receipt(packagePath, { id: 'run-start', assignment_id: 'assign-start', state: 'running',
    step: join(packagePath, 'step-001-subspec.md'), started_at: ago(34000) });
  activity(packagePath, 'run-start', 'owner', { run_id: 'run-start', role: 'owner', phase: 'starting', activity: 'starting worker', last_activity: ago(34000) });

  receipt(packagePath, { id: 'run-quiet', assignment_id: 'assign-quiet', state: 'running',
    step: join(packagePath, 'step-002-subspec.md'), started_at: ago(300000) });
  activity(packagePath, 'run-quiet', 'owner', { run_id: 'run-quiet', role: 'owner', phase: 'working', activity: 'editing reader', last_activity: ago(121000) });

  const snapshot = reduceConditions(await collectWorkspace({ roots: [join(f.dir, 'conditions')], indexDir: f.indexDir, now }));
  const byAssignment = id => snapshot.runs.find(run => run.assignment_id === id);

  const complete = byAssignment('assign-complete');
  assert.equal(complete.execution, 'completed');
  assert.deepEqual(condition(complete, 'reconciliation-pending'), { ...condition(complete, 'reconciliation-pending'), severity: 'info', state: 'open' });
  assert.match(complete.obligation, /step 3 of 8/);

  const start = byAssignment('assign-start');
  assert.equal(start.conditions.some(item => item.severity === 'attention'), false);
  assert.equal(start.conditions.some(item => item.kind === 'quiet-activity'), false);

  const quiet = byAssignment('assign-quiet');
  assert.deepEqual(condition(quiet, 'quiet-activity'), { ...condition(quiet, 'quiet-activity'), severity: 'info', state: 'open' });

  for (const run of snapshot.runs) for (const item of run.conditions) assert.doesNotMatch(item.kind, /spin/i);
  const rendered = renderWorkspace(snapshot).join('\n');
  assert.doesNotMatch(rendered, /spin/i);
  assert.match(rendered, /reconciliation-pending/);
  assert.deepEqual(reduceConditions(snapshot).runs.map(run => run.conditions), snapshot.runs.map(run => run.conditions));
});
