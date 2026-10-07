import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { SENTINEL_LIMITS, collectWorkspace, reduceConditions, renderWorkspace, enrollmentReasons } from './sentinel.mjs';

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

test('a package without a prepared step index keeps coverage complete; a malformed one is explicit', async t => {
  const f = sandbox(t);
  const packagePath = pack(primary(f.dir, 'nosteps'));
  receipt(packagePath, { id: 'run-nosteps', assignment_id: 'assign-nosteps', state: 'running', started_at: ago(60000) });

  const snapshot = await collectWorkspace({ roots: [join(f.dir, 'nosteps')], indexDir: f.indexDir, now });
  const run = snapshot.runs.find(item => item.assignment_id === 'assign-nosteps');
  assert.ok(run);
  assert.equal(run.obligation, null);
  assert.equal(run.coverage.state, 'complete');
  assert.equal(run.coverage.reasons.some(reason => reason.startsWith('step-index-invalid')), false);
  assert.equal(snapshot.coverage.reasons.some(reason => reason.startsWith('step-index-invalid')), false);

  // Absence is legitimate, but a malformed index stays an explicit defect.
  const broken = pack(primary(f.dir, 'brokensteps'));
  writeFileSync(join(broken, 'spec-steps.json'), '{"steps":');
  receipt(broken, { id: 'run-broken', assignment_id: 'assign-broken', state: 'running', started_at: ago(60000) });
  const other = await collectWorkspace({ roots: [join(f.dir, 'brokensteps')], indexDir: f.indexDir, now });
  const brokenRun = other.runs.find(item => item.assignment_id === 'assign-broken');
  assert.ok(brokenRun);
  assert.equal(brokenRun.coverage.state, 'partial');
  assert.ok(brokenRun.coverage.reasons.some(reason => reason.startsWith('step-index-invalid')));
  assert.ok(other.coverage.reasons.some(reason => reason.startsWith('step-index-invalid')));
});

test('populated managed index pointers share the reconciliation budget with package reads', async t => {
  const f = sandbox(t);
  const packagePath = pack(primary(f.dir, 'pointed'));
  const receiptFile = receipt(packagePath, { id: 'run-pointed', assignment_id: 'assign-pointed', state: 'running', started_at: ago(60000) });
  mkdirSync(f.indexDir, { recursive: true });
  const pointerFile = join(f.indexDir, 'run-pointed.json');
  writeFileSync(pointerFile, JSON.stringify({ run_id: 'run-pointed', package: packagePath }));

  const snapshot = await collectWorkspace({ roots: [], packages: [], indexDir: f.indexDir, now });
  const run = snapshot.runs.find(item => item.assignment_id === 'assign-pointed');
  assert.ok(run);
  assert.equal(snapshot.coverage.state, 'complete');
  // Pointer bytes count against the same total as package reads.
  assert.ok(snapshot.coverage.bytes_read >= statSync(pointerFile).size + statSync(receiptFile).size,
    `bytes_read ${snapshot.coverage.bytes_read}`);
});

test('pointer reads that exhaust the total budget become an explicit unknown omission', async t => {
  const f = sandbox(t);
  mkdirSync(f.indexDir, { recursive: true });
  // Valid ~60 KiB pointers charge the shared budget without producing
  // per-file errors, so exhausting the 4 MiB workspace total is the visible
  // outcome for managed discovery.
  const pad = 'p'.repeat(61440 - 96);
  for (let index = 0; index < 70; index++) {
    writeFileSync(join(f.indexDir, `big-${String(index).padStart(2, '0')}.json`),
      JSON.stringify({ run_id: `run-${index}`, package: '/canonical/package', pad }));
  }

  const snapshot = await collectWorkspace({ roots: [], packages: [], indexDir: f.indexDir, now });
  assert.equal(snapshot.runs.length, 0);
  assert.ok(snapshot.coverage.reasons.some(reason => reason.includes('READ_BUDGET')), JSON.stringify(snapshot.coverage.reasons.slice(0, 3)));
  assert.equal(snapshot.coverage.omitted, null);
  assert.ok(snapshot.coverage.bytes_read <= SENTINEL_LIMITS.totalBytes, `bytes_read ${snapshot.coverage.bytes_read}`);
  assert.notEqual(snapshot.coverage.state, 'complete');
});

test('retained non-receipt entries cannot make the receipt walk unbounded', async t => {
  const f = sandbox(t);
  const packagePath = pack(primary(f.dir, 'retained'));
  receipt(packagePath, { id: 'run-kept', assignment_id: 'assign-kept', state: 'running', started_at: ago(60000) });
  const runsDir = join(packagePath, 'runtime', 'runs');
  for (let index = 0; index < 450; index++) writeFileSync(join(runsDir, `retained-${String(index).padStart(3, '0')}.jsonl`), 'retained\n');

  const snapshot = await collectWorkspace({ roots: [join(f.dir, 'retained')], indexDir: f.indexDir, now });
  // The examination ceiling is an explicit unknown omission, never a silent
  // full scan or a guessed complete set.
  assert.ok(snapshot.coverage.reasons.some(reason => reason.startsWith('receipts-cap')), JSON.stringify(snapshot.coverage.reasons));
  assert.equal(snapshot.coverage.omitted, null);
  assert.ok(snapshot.runs.length <= 1);
});

test('special-file and symlinked sources are rejected without being opened or followed', async t => {
  const f = sandbox(t);
  const packagePath = pack(primary(f.dir, 'special'));
  const lock = join(realpathSync(join(packagePath, '..', '..')), '.git', 'spec-runtime.lock');
  mkdirSync(lock, { recursive: true });
  execFileSync('mkfifo', [join(lock, 'lease.json')]);
  const foreign = join(f.dir, 'foreign-steps.json');
  writeFileSync(foreign, JSON.stringify({ steps: [{ step: 1, name: 'Foreign obligation' }] }));
  symlinkSync(foreign, join(packagePath, 'spec-steps.json'));
  receipt(packagePath, { id: 'run-link', assignment_id: 'assign-link', state: 'running',
    started_at: ago(60000), lock });
  receipt(packagePath, { id: 'run-plain', assignment_id: 'assign-plain', state: 'running', started_at: ago(60000) });

  const snapshot = await collectWorkspace({ roots: [join(f.dir, 'special')], indexDir: f.indexDir, now });
  const byAssignment = id => snapshot.runs.find(run => run.assignment_id === id);
  const linked = byAssignment('assign-link');
  assert.ok(linked);
  // The FIFO lease and foreign symlinked step index are explicit unknowns;
  // neither blocks the refresh nor supplies foreign facts.
  assert.ok(linked.coverage.reasons.includes('lease-missing'));
  assert.ok(linked.coverage.reasons.some(reason => reason.startsWith('step-index-invalid')));
  assert.equal(linked.obligation, null);
  const plain = byAssignment('assign-plain');
  assert.ok(plain);
  // Shared package metadata (the foreign step index) reaches this run too;
  // the lease fact stays isolated to the run that recorded it.
  assert.equal(plain.coverage.state, 'partial');
  assert.ok(plain.coverage.reasons.some(reason => reason.startsWith('step-index-invalid')));
  assert.equal(plain.coverage.reasons.includes('lease-missing'), false);
  for (const text of [JSON.stringify(snapshot), renderWorkspace(snapshot).join('\n')]) {
    assert.equal(text.includes('Foreign obligation'), false);
  }
});

test('directory failures and truncation surface for every affected run', async t => {
  const f = sandbox(t);
  const packagePath = pack(primary(f.dir, 'dircaps'));
  receipt(packagePath, { id: 'run-a', assignment_id: 'assign-a', state: 'running', started_at: ago(60000) });
  receipt(packagePath, { id: 'run-b', assignment_id: 'assign-b', state: 'running', started_at: ago(90000) });
  // Shared malformed metadata must reach both runs, not only the first reader.
  writeFileSync(join(packagePath, 'spec-steps.json'), '{"steps":');
  // A non-directory at the checkpoint location is an explicit unknown.
  writeFileSync(join(packagePath, 'runtime', 'sentinel'), 'not a directory');
  // A non-directory at one run's activity location is that run's unknown only.
  writeFileSync(join(packagePath, 'runtime', 'runs', 'run-a-activity'), 'not a directory');

  const snapshot = await collectWorkspace({ roots: [join(f.dir, 'dircaps')], indexDir: f.indexDir, now });
  const byAssignment = id => snapshot.runs.find(run => run.assignment_id === id);
  const a = byAssignment('assign-a');
  const b = byAssignment('assign-b');
  assert.ok(a && b);
  for (const run of [a, b]) {
    assert.equal(run.coverage.state, 'partial');
    assert.ok(run.coverage.reasons.some(reason => reason.startsWith('step-index-invalid')), JSON.stringify(run.coverage.reasons));
    assert.ok(run.coverage.reasons.some(reason => reason.startsWith('checkpoints-unavailable')));
  }
  assert.ok(a.coverage.reasons.some(reason => reason.startsWith('activity-unavailable')));
  assert.equal(b.coverage.reasons.some(reason => reason.startsWith('activity-unavailable')), false);
  assert.deepEqual(condition(a, 'activity-unreadable'), { ...condition(a, 'activity-unreadable'), severity: 'attention', state: 'unknown' });
});

test('checkout identity is validated against the package repository', async t => {
  const f = sandbox(t);
  const alpha = primary(f.dir, 'alpha');
  const packagePath = pack(alpha);
  const worktree = join(alpha, 'wt');
  execFileSync('git', ['-C', alpha, 'worktree', 'add', '-q', worktree], { stdio: 'pipe' });
  const beta = primary(f.dir, 'beta');
  receipt(packagePath, { id: 'run-wt', assignment_id: 'assign-wt', state: 'running', started_at: ago(60000), checkout: worktree });
  receipt(packagePath, { id: 'run-foreign', assignment_id: 'assign-foreign', state: 'running', started_at: ago(70000), checkout: beta });
  receipt(packagePath, { id: 'run-gone', assignment_id: 'assign-gone', state: 'running', started_at: ago(80000), checkout: join(f.dir, 'gone') });

  const snapshot = await collectWorkspace({ roots: [alpha], indexDir: f.indexDir, now });
  const byAssignment = id => snapshot.runs.find(run => run.assignment_id === id);
  const wt = byAssignment('assign-wt');
  assert.equal(wt.checkout, realpathSync(worktree));
  assert.equal(wt.coverage.state, 'complete');
  const foreign = byAssignment('assign-foreign');
  assert.equal(foreign.checkout, null);
  assert.equal(foreign.coverage.state, 'stale');
  assert.ok(foreign.coverage.reasons.some(reason => reason.startsWith('checkout-foreign')));
  const gone = byAssignment('assign-gone');
  assert.equal(gone.checkout, null);
  assert.equal(gone.coverage.state, 'partial');
  assert.ok(gone.coverage.reasons.some(reason => reason.startsWith('checkout-unavailable')));
});

test('an unrepresentable numeric activity time stays an explicit unknown', async t => {
  const f = sandbox(t);
  const packagePath = pack(primary(f.dir, 'hugetime'));
  receipt(packagePath, { id: 'run-huge', assignment_id: 'assign-huge', state: 'running', started_at: ago(60000) });
  activity(packagePath, 'run-huge', 'owner', { run_id: 'run-huge', role: 'owner', phase: 'working', activity: 'still working', last_activity: 1e100 });

  const snapshot = await collectWorkspace({ roots: [join(f.dir, 'hugetime')], indexDir: f.indexDir, now });
  const run = snapshot.runs.find(item => item.assignment_id === 'assign-huge');
  assert.ok(run);
  assert.ok(run.coverage.reasons.includes('activity-invalid: owner'));
  assert.equal(run.observed_at, ago(60000));
  assert.deepEqual(condition(run, 'activity-unreadable'), { ...condition(run, 'activity-unreadable'), severity: 'attention', state: 'unknown' });
});

test('enrollment read failures project into workspace coverage, never healthy emptiness', async t => {
  const f = sandbox(t);
  const packagePath = pack(primary(f.dir, 'enroll-err'));
  receipt(packagePath, { id: 'run-enroll-err', assignment_id: 'assign-enroll-err', state: 'running', started_at: ago(60000) });

  // The only enrollment record being unreadable must not read as a fully
  // observed empty workspace.
  const broken = await collectWorkspace({
    roots: [], enrollmentErrors: [{ path: '/agent/spec-sentinel/ws/enrollments/a.json', code: 'ENROLLMENT_INVALID' }],
    indexDir: f.indexDir, now,
  });
  assert.equal(broken.runs.length, 0);
  assert.equal(broken.coverage.state, 'unavailable');
  assert.equal(broken.coverage.omitted, null);
  assert.ok(broken.coverage.reasons.some(reason => reason.startsWith('enrollment-invalid')), JSON.stringify(broken.coverage.reasons));
  assert.match(renderWorkspace(broken).join('\n'), /enrollment-invalid/);
  assert.doesNotMatch(renderWorkspace(broken).join('\n'), /no enrolled roots/);

  // A still-readable root beside a failed record keeps partial coverage with
  // the explicit unknown rather than claiming completeness.
  const mixed = await collectWorkspace({
    roots: [join(f.dir, 'enroll-err')],
    enrollmentErrors: [{ path: '/agent/spec-sentinel/ws/enrollments/b.json', code: 'EACCES' }],
    indexDir: f.indexDir, now,
  });
  assert.equal(mixed.runs.length, 1);
  assert.equal(mixed.coverage.state, 'partial');
  assert.equal(mixed.coverage.omitted, null);
  assert.ok(mixed.coverage.reasons.some(reason => reason.startsWith('enrollment-unavailable')), JSON.stringify(mixed.coverage.reasons));

  assert.deepEqual(enrollmentReasons(null), []);
  assert.deepEqual(enrollmentReasons([{ path: '/a', code: 'ENROLLMENT_CAP' }, { path: '/a', code: 'ENROLLMENT_CAP' }]),
    ['enrollment-cap: /a (ENROLLMENT_CAP)']);
});

test('metadata-heavy checkpoints cannot exceed the shared reconciliation byte ceiling', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'metadata-budget');
  const packagePath = pack(repo);
  receipt(packagePath, { id: 'one', state: 'running' });
  for (let index = 0; index < 80; index++) {
    const dir = join(packagePath, 'runtime', 'sentinel', `workflow-${index}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ package: packagePath, workers: [], padding: 'x'.repeat(60000) }));
  }
  const snapshot = await collectWorkspace({ roots: [repo], indexDir: f.indexDir, now });
  assert.ok(snapshot.coverage.bytes_read <= SENTINEL_LIMITS.totalBytes);
  assert.equal(snapshot.coverage.state, 'partial');
  assert.ok(snapshot.coverage.reasons.some(reason => reason.startsWith('read-budget:')));
});

test('external activity ancestor symlinks remain unknown instead of importing foreign hints', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'activity-ancestor');
  const packagePath = pack(repo);
  receipt(packagePath, { id: 'one', state: 'running' });
  const foreign = join(f.dir, 'foreign');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'owner.json'), JSON.stringify({ run_id: 'one', hint: 'FOREIGN SOURCE' }));
  symlinkSync(foreign, join(packagePath, 'runtime', 'runs', 'one-activity'));
  const snapshot = await collectWorkspace({ roots: [repo], indexDir: f.indexDir, now });
  assert.equal(snapshot.runs[0].activity, null);
  assert.equal(snapshot.coverage.state, 'partial');
  assert.equal(condition(snapshot.runs[0], 'activity-unreadable').state, 'unknown');
  assert.ok(!renderWorkspace(snapshot).join('\n').includes('FOREIGN SOURCE'));
});

test('production retained incidents and action outcomes appear as bounded source-backed conditions', async t => {
  const { createVerificationRecorder } = await import('../../pi/extensions/spec-runtime/sentinel.mjs');
  const f = sandbox(t);
  const repo = primary(f.dir, 'incident-facts');
  const packagePath = pack(repo);
  const workflow = 'workflow-one';
  const assignment = join(packagePath, 'step-1-subspec.md');
  receipt(packagePath, { id: 'one', assignment_id: assignment, state: 'running' });
  const options = { roots: [repo], indexDir: f.indexDir, now };
  const before = await collectWorkspace(options);
  const recorder = createVerificationRecorder({ now });
  const record = { id: 'one', assignment_id: assignment, package: packagePath, workflow_id: workflow };
  for (let index = 1; index <= 3; index++) recorder.observe(record, {
    type: 'tool_execution_end', toolName: 'spec_verify', toolCallId: `call-${index}`,
    result: { details: { exit_code: 1, sentinel_failure: { version: 1, complete: true,
      command_sha256: 'a'.repeat(64), summary_sha256: 'b'.repeat(64), tree_digest: 'c'.repeat(64), exit_code: 1 } } },
  });
  const dir = join(packagePath, 'runtime', 'sentinel', workflow);
  writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ package: packagePath, workers: [{ id: 'one' }] }));
  mkdirSync(join(dir, 'intents'));
  const actionFile = join(dir, 'intents', 'intent-one.json');
  writeFileSync(actionFile, JSON.stringify({ version: 1, id: 'intent-one', package: packagePath,
    workflow_id: workflow, kind: 'cancel', subject_key: 'PRIVATE SUBJECT / spaces', state: 'unknown', reason_code: 'receipt-unpersisted',
    result_reference: 'PRIVATE TEXT MUST NOT APPEAR' }));
  const after = await collectWorkspace(options);
  const run = after.runs[0];
  assert.equal(condition(before.runs[0], 'repeated-verification-failure'), undefined);
  assert.equal(run.incidents[0].count, 3);
  assert.equal(condition(run, 'repeated-verification-failure').state, 'open');
  assert.equal(condition(run, 'repeated-verification-failure').severity, 'attention');
  assert.equal(condition(run, 'action-outcome-unknown').state, 'unknown');
  assert.equal(condition(run, 'action-outcome-unknown').action_id, 'intent-one');
  assert.equal(run.incidents[0].assignment_id, assignment);
  assert.ok(!JSON.stringify(after).includes('PRIVATE SUBJECT'));
  const retainedUnknown = reduceConditions({ ...after, runs: [{ ...run, incidents: [{ ...run.incidents[0], state: 'unknown' }] }] });
  assert.equal(condition(retainedUnknown.runs[0], 'repeated-verification-failure').state, 'unknown');
  assert.equal(condition(retainedUnknown.runs[0], 'repeated-verification-failure').severity, 'attention');
  assert.ok(renderWorkspace({ ...after, runs: [{ ...run, actions: [
    { id: 'applied', kind: 'cancel', state: 'applied' }, { id: 'shadow', kind: 'continue', state: 'blocked' },
  ] }] }).join('\n').includes('actions: cancel [applied] · continue [blocked]'));
  assert.ok(run.source_paths.includes(actionFile));
  assert.equal(run.source_paths.length, run.source_hashes.length);
  assert.ok(!JSON.stringify(after).includes('PRIVATE TEXT'));
  assert.deepEqual(reduceConditions(after), after);
  // Actual retained success resolves; mere absence or corrupt data cannot do so.
  recorder.observe(record, { type: 'tool_execution_end', toolName: 'spec_verify', toolCallId: 'success', result: { details: { exit_code: 0 } } });
  const resolved = await collectWorkspace(options);
  assert.equal(condition(resolved.runs[0], 'repeated-verification-failure').state, 'resolved');
  assert.equal(condition(resolved.runs[0], 'repeated-verification-failure').id, condition(run, 'repeated-verification-failure').id);
  writeFileSync(join(dir, 'verification-incidents.json'), '{bad');
  const invalid = await collectWorkspace(options);
  assert.equal(invalid.coverage.state, 'partial');
  assert.equal(condition(invalid.runs[0], 'repeated-verification-failure'), undefined);
});
