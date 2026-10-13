import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

import { SENTINEL_LIMITS, collectWorkspace, reduceConditions, renderWorkspace, enrollmentReasons } from './sentinel.mjs';
import { createWorkspace, setupStorage } from '../workspaces/store.mjs';
import { newPackage } from '../spec-location/index.mjs';
import { makeFixture } from '../spec-location/fixture.mjs';
import { resolveAssignment } from '../workspaces/assignments.mjs';

const FIXED = Date.parse('2026-10-06T12:00:00.000Z');
const now = () => FIXED;
const ago = ms => new Date(FIXED - ms).toISOString();

// Real disposable Git primaries, a storage root and an empty managed index: no
// fixture may read the operator's live ~/.pi/agent/spec-runtime state. Each
// primary gets its own workspace (kit id = directory name = repository id), so
// `pack(repo, name)` is the package projects/<repo>/specs/<name> targeting it.
let STORAGE = null;
function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sentinel-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  STORAGE = join(dir, 'storage');
  mkdirSync(join(STORAGE, 'projects'), { recursive: true });
  return { dir, indexDir: join(dir, 'index') };
}

// A explicit package list scopes the read, as `sentinel status --package` does.
const collect = input => collectWorkspace({ storageRoot: STORAGE, packagesOnly: (input.packages?.length ?? 0) > 0, ...input });

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
  mkdirSync(join(STORAGE, 'projects', name), { recursive: true });
  writeFileSync(join(STORAGE, 'projects', name, 'kit.yaml'),
    `version: 1\nid: ${name}\nname: ${name}\nexecution_host: box\nrepositories:\n  - id: ${name}\n    path: ${repo}\n`);
  return repo;
}

function pack(repo, name = 'feature') {
  const workspace = basename(repo);
  const packagePath = join(STORAGE, 'projects', workspace, 'specs', name);
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(join(packagePath, 'locations.json'), JSON.stringify({ schema_version: 1, package_ref: `${workspace}/${name}`,
    targets: [{ id: workspace, primary: repo, common: join(repo, '.git'), branch: `spec-${name}`, worktree: null }] }));
  return packagePath;
}

// pr-url.json in its per-target shape for a package made by pack().
function publication(packagePath, entry) {
  const workspace = basename(join(packagePath, '..', '..'));
  writeFileSync(join(packagePath, 'pr-url.json'), JSON.stringify({ schema_version: 1, kind: 'pr_submission', package_ref: `${workspace}/${basename(packagePath)}`, targets: { [workspace]: entry } }));
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

test('package observation needs no Git process and reads targets from locations.json', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'shared-primary');
  const one = pack(repo, 'one'), two = pack(repo, 'two');
  receipt(one, { id: 'one', assignment_id: 'one', state: 'completed' });
  receipt(two, { id: 'two', assignment_id: 'two', state: 'completed' });
  t.mock.method(childProcess, 'execFile', () => { throw Object.assign(new Error('spawn EBADF'), { code: 'EBADF' }); });
  t.mock.method(childProcess, 'execFileSync', () => { throw new Error('Synchronous Git blocks the host'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const snapshot = await collect({ roots: [repo], packages: [one, one, two], indexDir: f.indexDir, now });
  assert.equal(snapshot.runs.length, 2);
  assert.equal(snapshot.coverage.state, 'complete');
  assert.deepEqual(snapshot.runs[0].targets, [{ id: 'shared-primary', primary: repo }]);
});

test('same-slug packages keep distinct identities and a linked-worktree copy is not a package', async t => {
  const f = sandbox(t);
  const one = pack(primary(f.dir, 'alpha'));
  const two = pack(primary(f.dir, 'beta'));
  receipt(one, { id: 'run-one', assignment_id: 'assign-one', state: 'running', started_at: ago(60000), parent_session: '/sessions/one.jsonl' });
  receipt(two, { id: 'run-two', assignment_id: 'assign-two', state: 'running', started_at: ago(60000), parent_session: '/sessions/two.jsonl' });

  const snapshot = await collect({ roots: [join(f.dir, 'alpha'), join(f.dir, 'beta')], indexDir: f.indexDir, now });
  assert.equal(snapshot.runs.length, 2);
  assert.deepEqual(snapshot.runs.map(run => run.package.split('/').pop()), ['feature', 'feature']);
  assert.deepEqual(snapshot.runs.map(run => [run.workspace, run.package_ref]), [['alpha', 'alpha/feature'], ['beta', 'beta/feature']]);
  assert.notEqual(snapshot.runs[0].package, snapshot.runs[1].package);
  assert.deepEqual(snapshot.runs.map(run => run.workflow_id), [null, null]);
  assert.deepEqual(new Set(snapshot.runs.map(run => run.coordinator_session)),
    new Set(['/sessions/one.jsonl', '/sessions/two.jsonl']));

  // A .specs copy inside a linked worktree is neither a package nor a legacy-location row.
  const alpha = join(f.dir, 'alpha');
  const worktree = join(alpha, 'worktree');
  execFileSync('git', ['-C', alpha, 'worktree', 'add', '-q', worktree], { stdio: 'pipe' });
  const copy = join(worktree, '.specs', 'feature');
  mkdirSync(copy, { recursive: true });
  const rejected = await collect({ roots: [worktree], packages: [copy], indexDir: f.indexDir, now });
  assert.equal(rejected.runs.length, 0);
  assert.deepEqual(rejected.attention, []);
  assert.notEqual(rejected.coverage.state, 'complete');
  assert.ok(rejected.coverage.reasons.some(reason => /legacy-location/.test(reason)), JSON.stringify(rejected.coverage.reasons));
});

test('root and assignment caps report partial coverage and explicit omissions', async t => {
  const f = sandbox(t);
  for (let index = 0; index < 21; index++) {
    const packagePath = pack(primary(f.dir, `repo-${String(index).padStart(2, '0')}`));
    receipt(packagePath, { id: `run-${index}`, assignment_id: `assign-${index}`, state: 'completed', started_at: ago(60000) });
  }
  const roots = [];
  for (let index = 0; index < 21; index++) roots.push(join(f.dir, `repo-${String(index).padStart(2, '0')}`));
  const capped = await collect({ roots, indexDir: f.indexDir, now });
  // The cap bounds the repositories checked for legacy content; packages come from storage.
  assert.equal(capped.runs.length, 21);
  assert.equal(capped.coverage.state, 'partial');
  assert.equal(capped.coverage.omitted, 1);
  assert.ok(capped.coverage.reasons.some(reason => reason.startsWith('roots-cap')), JSON.stringify(capped.coverage.reasons));
  assert.ok(capped.coverage.bytes_read <= SENTINEL_LIMITS.totalBytes);

  const many = pack(primary(f.dir, 'crowded'));
  for (let index = 0; index < 51; index++) {
    receipt(many, { id: `assignment-${index}`, assignment_id: `assignment-${index}`,
      state: index === 50 ? 'running' : 'completed', started_at: ago(60000) });
  }
  const selected = await collect({ packages: [many], indexDir: f.indexDir, now });
  assert.equal(selected.runs.length, SENTINEL_LIMITS.assignments);
  assert.equal(selected.coverage.state, 'partial');
  assert.equal(selected.coverage.omitted, 1);
  assert.ok(selected.coverage.reasons.some(reason => reason.startsWith('assignments-cap')), JSON.stringify(selected.coverage.reasons));
  assert.ok(selected.runs.some(run => run.assignment_id === 'assignment-50' && run.execution === 'running'));
});

test('oversized, replaced and absent snapshots stay explicit and no secret or cost is retained', async t => {
  const f = sandbox(t);
  const packagePath = pack(primary(f.dir, 'privacy'));
  receipt(packagePath, { id: 'run-oversized', assignment_id: 'assign-oversized', state: 'running',
    started_at: ago(60000), result: 'raw command body secret', token: 'lease-token-secret', usage: { cost: 0 } });
  activity(packagePath, 'run-oversized', 'owner',
    { run_id: 'run-oversized', role: 'owner', phase: 'working', activity: 'x'.repeat(SENTINEL_LIMITS.activityBytes + 1), last_activity: ago(30000) });
  receipt(packagePath, { id: 'run-replaced', assignment_id: 'assign-replaced', state: 'running', started_at: ago(60000) });
  activity(packagePath, 'run-replaced', 'owner', { run_id: 'foreign-run', role: 'owner', phase: 'working', activity: 'replaced', last_activity: ago(30000) });
  receipt(packagePath, { id: 'run-missing', assignment_id: 'assign-missing', state: 'running', started_at: ago(60000) });

  const snapshot = await collect({ roots: [join(f.dir, 'privacy')], indexDir: f.indexDir, now });
  const byAssignment = id => snapshot.runs.find(run => run.assignment_id === id);

  const oversized = byAssignment('assign-oversized');
  assert.equal(oversized.activity, null);
  assert.ok(oversized.coverage.reasons.includes('activity-oversized: owner'));
  assert.deepEqual(condition(oversized, 'activity-unreadable'), { ...condition(oversized, 'activity-unreadable'), severity: 'attention', state: 'unknown' });

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

  const snapshot = reduceConditions(await collect({ roots: [join(f.dir, 'conditions')], indexDir: f.indexDir, now }));
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

  const snapshot = await collect({ roots: [join(f.dir, 'nosteps')], indexDir: f.indexDir, now });
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
  const other = await collect({ roots: [join(f.dir, 'brokensteps')], indexDir: f.indexDir, now });
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

  const snapshot = await collect({ roots: [], packages: [], indexDir: f.indexDir, now });
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
  // per-file errors, so exhausting the workspace total is the visible
  // outcome for managed discovery.
  const pad = 'p'.repeat(61440 - 96);
  for (let index = 0; index < Math.ceil(SENTINEL_LIMITS.totalBytes / 61440) + 4; index++) {
    writeFileSync(join(f.indexDir, `big-${String(index).padStart(3, '0')}.json`),
      JSON.stringify({ run_id: `run-${index}`, package: '/canonical/package', pad }));
  }

  const snapshot = await collect({ roots: [], packages: [], indexDir: f.indexDir, now });
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
  for (let index = 0; index < SENTINEL_LIMITS.receiptDirectoryEntries + 50; index++) writeFileSync(join(runsDir, `retained-${String(index).padStart(3, '0')}.jsonl`), 'retained\n');
  // A current run must remain observable even when the bounded directory walk
  // cannot reach its archived receipt.
  writeFileSync(join(packagePath, 'runtime', 'run.json'), JSON.stringify({
    id: 'run-current', package: packagePath, assignment_id: 'assign-current',
    state: 'running', started_at: ago(1000),
  }));

  const snapshot = await collect({ roots: [join(f.dir, 'retained')], indexDir: f.indexDir, now });
  // The examination ceiling is an explicit unknown omission, never a silent
  // full scan or a guessed complete set.
  assert.ok(snapshot.coverage.reasons.some(reason => reason.startsWith('receipts-cap')), JSON.stringify(snapshot.coverage.reasons));
  assert.equal(snapshot.coverage.omitted, null);
  assert.ok(snapshot.runs.some(run => run.assignment_id === 'assign-current' && run.execution === 'running'));
  assert.ok(snapshot.runs.length <= 2);
});

test('special-file and symlinked sources are rejected without being opened or followed', async t => {
  const f = sandbox(t);
  const packagePath = pack(primary(f.dir, 'special'));
  execFileSync('mkfifo', [join(packagePath, 'work-tour.json')]);
  const foreign = join(f.dir, 'foreign-steps.json');
  writeFileSync(foreign, JSON.stringify({ steps: [{ step: 1, name: 'Foreign obligation' }] }));
  symlinkSync(foreign, join(packagePath, 'spec-steps.json'));
  receipt(packagePath, { id: 'run-link', assignment_id: 'assign-link', state: 'running', started_at: ago(60000) });
  receipt(packagePath, { id: 'run-plain', assignment_id: 'assign-plain', state: 'running', started_at: ago(60000) });

  const snapshot = await collect({ roots: [join(f.dir, 'special')], indexDir: f.indexDir, now });
  const byAssignment = id => snapshot.runs.find(run => run.assignment_id === id);
  const linked = byAssignment('assign-link');
  assert.ok(linked);
  // The FIFO work tour and foreign symlinked step index are explicit unknowns;
  // neither blocks the refresh nor supplies foreign facts.
  assert.equal(linked.evidence.state, 'unavailable');
  assert.match(linked.evidence.reason, /source-not-regular/);
  assert.ok(linked.coverage.reasons.some(reason => reason.startsWith('step-index-invalid')));
  assert.equal(linked.obligation, null);
  const plain = byAssignment('assign-plain');
  assert.ok(plain);
  // Shared package metadata (the foreign step index) reaches this run too.
  assert.equal(plain.coverage.state, 'partial');
  assert.ok(plain.coverage.reasons.some(reason => reason.startsWith('step-index-invalid')));
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

  const snapshot = await collect({ roots: [join(f.dir, 'dircaps')], indexDir: f.indexDir, now });
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

  const snapshot = await collect({ roots: [alpha], indexDir: f.indexDir, now });
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

  const snapshot = await collect({ roots: [join(f.dir, 'hugetime')], indexDir: f.indexDir, now });
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
  const broken = await collect({
    storageRoot: null, roots: [], enrollmentErrors: [{ path: '/agent/spec-sentinel/ws/enrollments/a.json', code: 'ENROLLMENT_INVALID' }],
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
  const mixed = await collect({
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

// Run alone: node --test --test-name-pattern='metadata-heavy checkpoints' scripts/spec-observe/sentinel.test.mjs
// Each package holds `count` valid ~62 KB checkpoints (about 6 MB per package).
function heavyPackage(repo, name, count = 100) {
  const packagePath = pack(repo, name);
  receipt(packagePath, { id: 'one', state: 'running', step: join(packagePath, 'step-002-subspec.md') });
  writeFileSync(join(packagePath, 'spec-steps.json'), JSON.stringify({ steps: [
    { step: 1, name: 'Start' }, { step: 2, name: 'Build' }, { step: 3, name: 'Finish' },
  ] }));
  const padding = 'x'.repeat(62000);
  for (let index = 0; index < count; index++) {
    const dir = join(packagePath, 'runtime', 'sentinel', `workflow-${index}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ package: packagePath, workers: [], padding }));
  }
  return packagePath;
}

const budgetReasons = snapshot => snapshot.coverage.reasons.filter(reason => reason.startsWith('read-budget:'));

test('metadata-heavy checkpoints preserve spec progress within the shared reconciliation byte ceiling', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'metadata-budget');
  // Earlier packages drain the shared pool; the last one keeps its floor reads.
  const heavy = ['a-one', 'a-two', 'a-three'].map(name => heavyPackage(repo, name));
  const packagePath = heavyPackage(repo, 'z-last', 80);
  // Explicit packages are observed in the given order; directory order is not stable.
  const snapshot = await collect({ roots: [repo], packages: [...heavy, packagePath], indexDir: f.indexDir, now });
  assert.ok(snapshot.coverage.bytes_read <= SENTINEL_LIMITS.totalBytes);
  assert.equal(snapshot.coverage.state, 'partial');
  assert.ok(budgetReasons(snapshot).some(reason => reason.includes('/z-last/')));
  assert.deepEqual(snapshot.runs.find(run => run.package === packagePath).spec_progress, { basis: 'step-position', total_steps: 3,
    current_step: 2, current_position: 2, current_name: 'Build', accepted_steps: null });
});

test('a package after budget-exhausting packages still reaches recently_completed from its floor', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'floor');
  const heavy = ['a-one', 'a-two', 'a-three'].map(name => heavyPackage(repo, name));
  const light = pack(repo, 'z-light');
  receipt(light, { id: 'done', state: 'completed', started_at: ago(60000) });
  const commit = 'a'.repeat(40);
  publication(light, { kind: 'pr_submission', commit, url: 'https://example.test/pull/1', submitted_at: ago(1000) });
  writeFileSync(join(light, 'work-tour.json'), JSON.stringify({ verdict: 'ready', commit }));
  const snapshot = await collect({ roots: [repo], packages: [...heavy, light], indexDir: f.indexDir, now });
  const reasons = budgetReasons(snapshot);
  assert.ok(reasons.some(reason => reason.includes('/a-three/')), 'the heavy packages exhaust the pool');
  assert.ok(!reasons.some(reason => reason.includes('/z-light/')), JSON.stringify(reasons));
  assert.deepEqual(snapshot.recently_completed.map(run => [run.package, run.completion_basis]), [[light, 'ready-pr']]);
});

test('the floor reservation stops at half the budget and unused floor returns to the pool', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'reservation');
  const MiB = 1024 * 1024;
  const heavy = [heavyPackage(repo, 'a-one'), heavyPackage(repo, 'a-two')];
  // 100 floors (9.6 MiB) exceed half of the 16 MiB budget.
  const lights = [];
  for (let index = 0; index < 100; index++) {
    const light = pack(repo, `b-${String(index).padStart(3, '0')}`);
    receipt(light, { id: 'one', state: 'running' });
    lights.push(light);
  }
  const snapshot = await collect({ roots: [repo], packages: [...heavy, ...lights], indexDir: f.indexDir, now });
  const reasons = budgetReasons(snapshot);
  assert.ok(reasons.some(reason => reason.includes('/a-two/')), 'the first two packages exhaust the unreserved half');
  // Every light run.json is read, including the ones past the 85th floor, because
  // earlier lights return their unspent floor. (Reasons are capped at 50 entries,
  // so the candidate count below is the stronger check.)
  assert.ok(!reasons.some(reason => reason.includes('/b-')), JSON.stringify(reasons.slice(0, 3)));
  assert.ok(snapshot.coverage.reasons.includes('assignments-cap: selected 50 of 102'), 'all 102 current receipts were read');
  // Heavy packages read about half the budget (an uncapped reservation leaves about 6.4 MiB).
  assert.ok(snapshot.coverage.bytes_read > 7.5 * MiB && snapshot.coverage.bytes_read < 9 * MiB, `bytes_read ${snapshot.coverage.bytes_read}`);
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
  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
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
  const before = await collect(options);
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
  const after = await collect(options);
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
  const resolved = await collect(options);
  assert.equal(condition(resolved.runs[0], 'repeated-verification-failure').state, 'resolved');
  assert.equal(condition(resolved.runs[0], 'repeated-verification-failure').id, condition(run, 'repeated-verification-failure').id);
  writeFileSync(join(dir, 'verification-incidents.json'), '{bad');
  const invalid = await collect(options);
  assert.equal(invalid.coverage.state, 'partial');
  assert.equal(condition(invalid.runs[0], 'repeated-verification-failure'), undefined);
});

test('24-hour activity filter hides untouched packages before assignment selection and rediscovers nested edits', async t => {
  const { readdirSync, utimesSync } = await import('node:fs');
  const f = sandbox(t);
  const repo = primary(f.dir, 'activity-window');
  const old = pack(repo, 'merged-old-work');
  const recent = pack(repo, 'current');
  receipt(old, { id: 'old', state: 'running', started_at: ago(3 * 86400000) });
  receipt(recent, { id: 'recent', state: 'running', started_at: ago(1000) });
  const nested = join(old, 'runtime', 'runs', 'old-activity');
  mkdirSync(nested, { recursive: true });
  const activityFile = join(nested, 'owner.json');
  writeFileSync(activityFile, JSON.stringify({ run_id: 'old', role: 'owner', hint: 'editing' }));
  function ageTree(path, date) {
    if (statSync(path).isDirectory()) for (const name of readdirSync(path)) ageTree(join(path, name), date);
    utimesSync(path, date, date);
  }
  ageTree(old, new Date(FIXED - 86400001));
  const input = { roots: [repo], indexDir: f.indexDir, now };
  const filtered = await collect(input);
  assert.deepEqual(filtered.runs.map(run => run.assignment_id), ['recent']);
  assert.equal(filtered.activity_filter.hidden_packages, 1);
  assert.equal(filtered.coverage.omitted, 0, 'intentional age filtering is not a coverage failure');
  assert.ok(filtered.spec_roots.includes(join(STORAGE, 'projects', 'activity-window', 'specs')), 'old packages remain watched');
  const history = await collect({ ...input, includeInactive: true });
  assert.equal(history.runs.length, 2);
  assert.equal(history.activity_filter.window_ms, null);
  // Editing an existing deep file does not update the top-level directory mtime.
  utimesSync(activityFile, new Date(FIXED - 86400000), new Date(FIXED - 86400000));
  const boundary = await collect(input);
  assert.equal(boundary.runs.length, 2, 'exactly 24 hours remains visible');
  assert.equal(statSync(old).mtimeMs, FIXED - 86400001);
  utimesSync(activityFile, new Date(FIXED - 1000), new Date(FIXED - 1000));
  assert.equal((await collect(input)).runs.length, 2);
});

test('completed packages leave monitoring but unfinished steps and reopened packages remain visible', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'completion-filter');
  const done = pack(repo, 'done'), legacy = pack(repo, 'published'), unfinished = pack(repo, 'unfinished');
  for (const path of [done, legacy, unfinished]) receipt(path, { id: 'attempt', state: 'completed', started_at: ago(60000) });
  const checkpointDir = join(done, 'runtime', 'sentinel', 'workflow');
  mkdirSync(checkpointDir, { recursive: true });
  const checkpointFile = join(checkpointDir, 'checkpoint.json');
  const checkpoint = { version: 1, workflow_id: 'workflow', package: done, state: 'complete', observed_at: ago(1000), workers: [] };
  writeFileSync(checkpointFile, JSON.stringify(checkpoint));
  const commit = 'a'.repeat(40);
  publication(legacy, { kind: 'pr_submission', commit, url: 'https://example.test/pull/1', submitted_at: ago(1000) });
  writeFileSync(join(legacy, 'work-tour.json'), JSON.stringify({ verdict: 'ready', commit }));
  const input = { roots: [repo], indexDir: f.indexDir, now };
  const live = await collect(input);
  assert.deepEqual(live.runs.map(run => run.package), [unfinished], 'a completed worker is not a completed workflow');
  assert.equal(live.activity_filter.hidden_completed_packages, 2);
  assert.deepEqual(live.recently_completed.map(run => [run.package, run.completed_at, run.completion_basis]), [
    [done, ago(1000), 'workflow-checkpoint'], [legacy, ago(1000), 'ready-pr'],
  ]);
  assert.ok(live.recently_completed.every(run => run.conditions.length === 0), 'history is outside recovery reduction');
  assert.equal((await collect({ ...input, includeInactive: true })).runs.length, 3);
  const unreadable = join(done, 'runtime', 'runs', 'unreadable.json');
  writeFileSync(unreadable, '{');
  const uncertain = await collect(input);
  assert.ok(uncertain.runs.some(run => run.package === done), 'unreadable later work prevents confirmed completion');
  assert.ok(!uncertain.recently_completed.some(run => run.package === done));
  rmSync(unreadable);
  writeFileSync(join(legacy, 'work-tour.json'), JSON.stringify({ verdict: 'ready', commit: 'b'.repeat(40) }));
  assert.equal((await collect(input)).activity_filter.hidden_completed_packages, 1, 'mismatched publication cannot hide work');
  writeFileSync(join(legacy, 'work-tour.json'), JSON.stringify({ verdict: 'ready', commit }));
  // Explicitly reopening the workflow overrides previous completion.
  writeFileSync(checkpointFile, JSON.stringify({ ...checkpoint, state: 'ready' }));
  assert.equal((await collect(input)).runs.length, 2);
  // A later dispatch also overrides older publication evidence.
  receipt(legacy, { id: 'new', state: 'running', started_at: ago(0) });
  const reopened = await collect(input);
  assert.equal(reopened.activity_filter.hidden_completed_packages, 0);
  assert.deepEqual(reopened.recently_completed, []);
});

test('completion history uses recorded dates past the activity window, includes receipt-free workflows, and expires after seven days', async t => {
  const { readdirSync, utimesSync } = await import('node:fs');
  const f = sandbox(t), repo = primary(f.dir, 'completion-dates');
  const week = SENTINEL_LIMITS.recentCompletionMs;
  function ageTree(path) {
    if (statSync(path).isDirectory()) for (const name of readdirSync(path)) ageTree(join(path, name));
    utimesSync(path, new Date(FIXED - week * 2), new Date(FIXED - week * 2));
  }
  for (const [name, elapsed, workers] of [['older', week + 1, []], ['boundary', week, []],
    ['recent', 2 * 86400000, []], ['future', -1000, []], ['unfinished', 1000, [{ id: 'fixer', state: 'working' }]]]) {
    const path = pack(repo, name), dir = join(path, 'runtime', 'sentinel', 'workflow');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ version: 1, workflow_id: 'workflow',
      package: path, state: 'complete', observed_at: ago(elapsed), workers }));
    // A restored checkout's mtime must not redefine when the spec completed.
    ageTree(path);
  }
  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  assert.deepEqual(snapshot.runs, []);
  assert.deepEqual(snapshot.recently_completed.map(r => r.package.split('/').pop()), ['recent', 'boundary']);
  assert.equal(snapshot.completion_history.cutoff, ago(week));
  assert.equal(snapshot.completion_history.omitted, 0);
  assert.equal(snapshot.coverage.state, 'complete');
});

// Run alone: node --test --test-name-pattern='planned inventory includes old folders' scripts/spec-observe/sentinel.test.mjs
test('planned inventory includes old folders and excludes active, blocked, and historical completion', async t => {
  const { readdirSync, utimesSync } = await import('node:fs');
  const f = sandbox(t), repo = primary(f.dir, 'planned-inventory');
  const empty = pack(repo, 'empty-planned');
  const settled = pack(repo, 'settled-planned');
  const active = pack(repo, 'active');
  const blocked = pack(repo, 'blocked');
  const oldActive = pack(repo, 'old-active');
  const oldBlocked = pack(repo, 'old-blocked');
  const done = pack(repo, 'historical-done');
  const unknownCheckpoint = pack(repo, 'unknown-checkpoint');
  receipt(settled, { id: 'settled', state: 'cancelled', started_at: ago(9 * 86400000) });
  receipt(active, { id: 'active', state: 'running', started_at: ago(1000) });
  receipt(blocked, { id: 'blocked', state: 'blocked', started_at: ago(1000) });
  receipt(oldActive, { id: 'old-active', state: 'running', started_at: ago(9 * 86400000) });
  receipt(oldBlocked, { id: 'old-blocked', state: 'blocked', started_at: ago(9 * 86400000) });
  const checkpointDir = join(done, 'runtime', 'sentinel', 'workflow');
  mkdirSync(checkpointDir, { recursive: true });
  writeFileSync(join(checkpointDir, 'checkpoint.json'), JSON.stringify({ version: 1, workflow_id: 'workflow',
    package: done, state: 'complete', observed_at: ago(SENTINEL_LIMITS.recentCompletionMs + 1000), workers: [] }));
  const unknownCheckpointDir = join(unknownCheckpoint, 'runtime', 'sentinel', 'workflow');
  mkdirSync(unknownCheckpointDir, { recursive: true });
  writeFileSync(join(unknownCheckpointDir, 'checkpoint.json'), JSON.stringify({ version: 2, workflow_id: 'workflow',
    package: unknownCheckpoint, state: 'complete', observed_at: ago(1000), workers: [] }));
  const ageTree = path => {
    if (statSync(path).isDirectory()) for (const name of readdirSync(path)) ageTree(join(path, name));
    utimesSync(path, new Date(FIXED - 9 * 86400000), new Date(FIXED - 9 * 86400000));
  };
  ageTree(empty);
  ageTree(settled);
  ageTree(done);
  ageTree(oldActive);
  ageTree(oldBlocked);
  ageTree(unknownCheckpoint);

  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  assert.deepEqual(snapshot.planned_packages.map(row => basename(row.package)), ['empty-planned', 'settled-planned']);
  assert.deepEqual(snapshot.planned_packages.map(row => [row.workspace, row.package_ref, row.targets.length]), [
    ['planned-inventory', 'planned-inventory/empty-planned', 1],
    ['planned-inventory', 'planned-inventory/settled-planned', 1],
  ]);
  assert.equal(snapshot.activity_filter.hidden_packages, 6, 'old packages stay available for lifecycle classification past the activity window');
  assert.ok(snapshot.runs.some(run => run.package === active), 'the active package remains a run');
  assert.ok(snapshot.runs.some(run => run.package === blocked), 'the blocked package remains visible for attention');
  assert.ok(!snapshot.planned_packages.some(row => [oldActive, oldBlocked].includes(row.package)),
    'old active and blocked lifecycle facts stay excluded from planned inventory');
  assert.ok(!snapshot.planned_packages.some(row => row.package === unknownCheckpoint),
    'an unsupported checkpoint version is unknown, not planned');
  assert.deepEqual(snapshot.recently_completed, [], 'completion older than the history window is not reclassified as planned');
});

// Run alone: node --test --test-name-pattern='planned inventory excludes legacy implementation' scripts/spec-observe/sentinel.test.mjs
test('planned inventory excludes legacy implementation artifacts and orders plans by authored time', async t => {
  const { utimesSync } = await import('node:fs');
  const f = sandbox(t), repo = primary(f.dir, 'planned-history');
  const older = pack(repo, 'a-old'), newer = pack(repo, 'z-new');
  for (const [path, age] of [[older, 8000], [newer, 1000]]) {
    writeFileSync(join(path, 'spec.md'), '# Plan\n');
    utimesSync(join(path, 'spec.md'), new Date(FIXED - age), new Date(FIXED - age));
  }
  // Rematerializing location metadata must not reorder an older plan.
  utimesSync(older, new Date(FIXED), new Date(FIXED));
  const tour = pack(repo, 'ready-tour');
  writeFileSync(join(tour, 'work-tour.json'), JSON.stringify({ verdict: 'ready', commit: 'a'.repeat(40) }));
  const legacy = pack(repo, 'legacy-pr');
  publication(legacy, { url: 'https://github.com/org/repo/pull/1', submitted_at: ago(1000) });
  const integrated = pack(repo, 'integrated');
  publication(integrated, { url: null, mergedInto: 'demo', commit: 'b'.repeat(40), submitted_at: ago(1000) });
  const draft = pack(repo, 'draft');
  publication(draft, { url: 'https://github.com/org/repo/pull/2', mode: 'draft', submitted_at: ago(1000) });
  const foreign = pack(repo, 'foreign-pr');
  publication(foreign, { url: 'https://github.com/org/repo/pull/3', submitted_at: ago(1000) });
  const foreignFile = join(foreign, 'pr-url.json');
  const record = JSON.parse(await (await import('node:fs/promises')).readFile(foreignFile, 'utf8'));
  writeFileSync(foreignFile, JSON.stringify({ ...record, package_ref: 'elsewhere/foreign-pr' }));
  const unreadable = pack(repo, 'unreadable-tour');
  writeFileSync(join(unreadable, 'work-tour.json'), '{');
  const implemented = pack(repo, 'implemented-step');
  receipt(implemented, { id: 'implemented', state: 'completed', started_at: ago(2000) });
  const oldLearning = pack(repo, 'legacy-learning');
  writeFileSync(join(oldLearning, 'step-001-learning.md'), '# Implemented step\n');
  const nestedLearning = pack(repo, 'nested-learning');
  mkdirSync(join(nestedLearning, 'learnings'));
  writeFileSync(join(nestedLearning, 'learnings', 'step-001-learning.md'), '# Implemented step\n');

  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  const planned = snapshot.planned_packages;
  assert.deepEqual(planned.filter(row => [older, newer].includes(row.package)).map(row => row.package), [newer, older]);
  assert.equal(planned.find(row => row.package === newer).planned_at, ago(1000));
  for (const path of [tour, legacy, integrated, unreadable, implemented, oldLearning, nestedLearning]) assert.ok(!planned.some(row => row.package === path), basename(path));
  for (const path of [draft, foreign]) assert.ok(planned.some(row => row.package === path), basename(path));
  assert.deepEqual(snapshot.recently_completed, [], 'exclusion from Planned does not assert accepted completion');
});

// Run alone: node --test --test-name-pattern='planned inventory publishes readiness' scripts/spec-observe/sentinel.test.mjs
test('planned inventory publishes readiness and planning facts for a standalone prepared package and its epic member', async t => {
  const f = sandbox(t), repo = primary(f.dir, 'planned-facts');
  const prepared = path => {
    writeFileSync(join(path, 'spec-steps.json'), JSON.stringify({ steps: [
      { step: 1, name: 'Prepare inputs', description: 'Prepare bounded inputs.', difficulty: 'medium', visualDesign: false, evidence: [] },
      { step: 2, name: 'Draft reader', description: 'Draft the bounded reader.', difficulty: 'medium', visualDesign: false, evidence: [] }] }));
    writeFileSync(join(path, 'spec-prepare.md'), '# Preparation\n\nOutcome: prepared\nPrepared: 2026-10-06\n');
    writeFileSync(join(path, 'proposal.md'), '---\nverdict: COMPATIBLE\ncritique_recommended: true\n---\n\n# Proposal\n');
    writeFileSync(join(path, 'critique.md'), '# Critique\n');
  };
  const standalone = pack(repo, 'prepared-standalone');
  const member = pack(repo, 'epic-member');
  prepared(standalone);
  prepared(member);
  const epicDir = join(STORAGE, 'projects', basename(repo), 'epics', 'facts');
  mkdirSync(epicDir, { recursive: true });
  writeFileSync(join(epicDir, 'epic.json'), JSON.stringify({ schema_version: 1, epic: 'facts',
    title: 'Facts epic', state: 'active', packages: [{ package: 'epic-member' }] }));

  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  const row = snapshot.planned_packages.find(item => item.package === standalone);
  assert.ok(row, 'a standalone no-receipt package is planned inventory');
  assert.equal(row.step_count, 2);
  assert.equal(row.prepared, true);
  assert.equal(row.preparation.outcome, 'prepared');
  assert.equal(row.preparation.reported_at, '2026-10-06');
  assert.equal(row.decision, null);
  assert.deepEqual(row.receipts, []);
  assert.equal(row.worktree_recorded, repo, 'a null recorded worktree falls back to the primary checkout');
  assert.equal(row.proposal, true);
  assert.equal(row.critique, true);
  assert.equal(row.critique_recommended, true);

  const memberRow = snapshot.planned_packages.find(item => item.package === member);
  assert.ok(memberRow?.epic, 'an epic member package carries epic membership');
  for (const field of ['step_count', 'prepared', 'decision', 'receipts', 'worktree_recorded', 'proposal', 'critique', 'critique_recommended'])
    assert.deepEqual(memberRow[field], row[field], `standalone and epic member share ${field}`);
  assert.equal(memberRow.preparation.outcome, row.preparation.outcome);
});

// Run alone: node --test --test-name-pattern='planned inventory never publishes prepared' scripts/spec-observe/sentinel.test.mjs
test('planned inventory never publishes prepared for blocked, pending, malformed, or unreadable preparation', async t => {
  const f = sandbox(t), repo = primary(f.dir, 'planned-unready');
  const steps = JSON.stringify({ steps: [{ step: 1, name: 'One' }, { step: 2, name: 'Two' }] });
  const blocked = pack(repo, 'blocked-prepare');
  writeFileSync(join(blocked, 'spec-steps.json'), steps);
  writeFileSync(join(blocked, 'spec-prepare.md'), 'Outcome: blocked\n');
  const pending = pack(repo, 'pending-decision');
  writeFileSync(join(pending, 'spec-steps.json'), steps);
  writeFileSync(join(pending, 'spec-prepare.md'), 'Outcome: decision-required\n');
  writeFileSync(join(pending, 'decision-required.md'), '---\nstage: architecture\nquestion: "Which seam?"\nrecommendation: "Keep it local"\nrecorded_at: 2026-10-06T12:00:00.000Z\n---\n');
  const sparse = pack(repo, 'sparse-index');
  writeFileSync(join(sparse, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1, name: 'One' }, { step: 3, name: 'Three' }] }));
  writeFileSync(join(sparse, 'spec-prepare.md'), 'Outcome: prepared\n');
  const unreadable = pack(repo, 'unreadable-prepare');
  writeFileSync(join(unreadable, 'spec-steps.json'), steps);
  writeFileSync(join(unreadable, 'spec-prepare.md'), 'x'.repeat(65537));
  const noIndex = pack(repo, 'missing-index');
  writeFileSync(join(noIndex, 'spec-prepare.md'), 'Outcome: prepared\n');

  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  const row = path => snapshot.planned_packages.find(item => item.package === path);
  for (const path of [blocked, pending, sparse, unreadable, noIndex]) {
    assert.ok(row(path), `${basename(path)} is still planned inventory`);
    assert.equal(row(path).prepared, false, basename(path));
  }
  assert.equal(row(blocked).preparation.outcome, 'blocked');
  assert.equal(row(pending).decision.stage, 'architecture');
  assert.equal(row(pending).decision.question, 'Which seam?');
  assert.equal(row(sparse).step_count, 2, 'a readable non-sequential index still reports its size');
  assert.equal(row(noIndex).step_count, null);
});

// Run alone: node --test --test-name-pattern='planned inventory refuses incomplete multi-target routing' scripts/spec-observe/sentinel.test.mjs
test('planned inventory refuses incomplete multi-target routing without repository membership', async t => {
  const f = sandbox(t);
  const repoA = primary(f.dir, 'multi-a');
  const repoB = primary(f.dir, 'multi-b');
  const workspace = basename(repoA);
  const twoTargets = [
    { id: 'multi-a', primary: repoA, common: join(repoA, '.git'), branch: 'spec-multi', worktree: null },
    { id: 'multi-b', primary: repoB, common: join(repoB, '.git'), branch: 'spec-multi', worktree: null },
  ];
  const makeMulti = name => {
    const path = pack(repoA, name);
    writeFileSync(join(path, 'locations.json'), JSON.stringify({ schema_version: 1,
      package_ref: `${workspace}/${name}`, targets: twoTargets }));
    writeFileSync(join(path, 'spec-prepare.md'), 'Outcome: prepared\n');
    return path;
  };
  const valid = entry => ({ step: entry.step, name: entry.name, description: 'Do the bounded step.',
    difficulty: 'medium', visualDesign: false, evidence: [], ...(entry.repository === undefined ? {} : { repository: entry.repository }) });
  const missing = makeMulti('multi-missing');
  writeFileSync(join(missing, 'spec-steps.json'), JSON.stringify({ steps: [valid({ step: 1, name: 'One' })] }));
  const unknown = makeMulti('multi-unknown');
  writeFileSync(join(unknown, 'spec-steps.json'), JSON.stringify({ steps: [valid({ step: 1, name: 'One', repository: 'unknown-target' })] }));
  const incomplete = makeMulti('multi-incomplete');
  writeFileSync(join(incomplete, 'spec-steps.json'), JSON.stringify({ steps: [valid({ step: 1, name: 'One', repository: 'multi-a' }), { step: 2, name: 'Two' }] }));
  const routed = makeMulti('multi-routed');
  writeFileSync(join(routed, 'spec-steps.json'), JSON.stringify({ steps: [valid({ step: 1, name: 'One', repository: 'multi-a' })] }));
  const singleIncomplete = pack(repoA, 'single-incomplete');
  writeFileSync(join(singleIncomplete, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1, name: 'One' }] }));
  writeFileSync(join(singleIncomplete, 'spec-prepare.md'), 'Outcome: prepared\n');
  const singleUnknown = pack(repoA, 'single-unknown');
  writeFileSync(join(singleUnknown, 'spec-steps.json'), JSON.stringify({ steps: [valid({ step: 1, name: 'One', repository: 'unknown-target' })] }));
  writeFileSync(join(singleUnknown, 'spec-prepare.md'), 'Outcome: prepared\n');

  const snapshot = await collect({ roots: [repoA, repoB], indexDir: f.indexDir, now });
  const row = path => snapshot.planned_packages.find(item => item.package === path);
  for (const path of [missing, unknown, incomplete, singleIncomplete, singleUnknown]) {
    assert.ok(row(path), `${basename(path)} is still planned inventory`);
    assert.equal(row(path).prepared, false, basename(path));
    assert.equal(row(path).step_count, path === incomplete ? 2 : 1, 'a readable index still reports its size');
  }
  assert.ok(row(routed), 'a routed multi-target package is planned inventory');
  assert.equal(row(routed).prepared, true, 'a valid repository membership publishes prepared true');
});

// Run alone: node --test --test-name-pattern='epic planning' scripts/spec-observe/sentinel.test.mjs
test('epic planning facts match planned inventory truth and blocked, missing members stay unlaunchable', async t => {
  const f = sandbox(t), repo = primary(f.dir, 'epic-planning');
  const prepared = pack(repo, 'prepared-member');
  writeFileSync(join(prepared, 'spec-steps.json'), JSON.stringify({ steps: [
    { step: 1, name: 'One', description: 'Prepare bounded inputs.', difficulty: 'medium', visualDesign: false, evidence: [] },
    { step: 2, name: 'Two', description: 'Draft the bounded reader.', difficulty: 'medium', visualDesign: false, evidence: [] }] }));
  writeFileSync(join(prepared, 'spec-prepare.md'), 'Outcome: prepared\nPrepared: 2026-10-06\n');
  writeFileSync(join(prepared, 'proposal.md'), '---\ncritique_recommended: true\n---\n# Proposal\n');
  writeFileSync(join(prepared, 'critique.md'), '# Critique\n');
  const blocked = pack(repo, 'blocked-member');
  writeFileSync(join(blocked, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1, name: 'One' }] }));
  writeFileSync(join(blocked, 'spec-prepare.md'), 'Outcome: blocked\n');
  const epicDir = join(STORAGE, 'projects', basename(repo), 'epics', 'planning');
  mkdirSync(epicDir, { recursive: true });
  writeFileSync(join(epicDir, 'epic.json'), JSON.stringify({ schema_version: 1, epic: 'planning', title: 'Planning epic', state: 'active',
    packages: [{ package: 'prepared-member' }, { package: 'blocked-member' }, { package: 'missing-member' }] }));

  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  const epic = snapshot.epics.find(item => item.epic === 'planning');
  const member = name => epic.members.find(item => item.name === name);
  const planningFields = ['proposal', 'critique', 'critique_recommended', 'prepared', 'step_count', 'preparation', 'decision'];
  const projected = row => Object.fromEntries(planningFields.map(field => [field, row[field] ?? null]));

  const preparedRow = snapshot.planned_packages.find(item => item.package === prepared);
  assert.ok(preparedRow, 'the prepared member is planned inventory');
  assert.deepEqual(member('prepared-member').planning, projected(preparedRow), 'member planning equals the planned inventory truth');
  assert.equal(member('prepared-member').planning.step_count, 2);
  assert.equal(member('prepared-member').planning.preparation.outcome, 'prepared');

  assert.ok(snapshot.planned_packages.some(item => item.package === blocked), 'the blocked member is still planned inventory');
  assert.equal(member('blocked-member').status, 'prepared', 'the legacy index-only lifecycle stays prepared');
  assert.equal(member('blocked-member').planning.prepared, false, 'a blocked report is not launchable preparation');
  assert.equal(member('blocked-member').planning.preparation.outcome, 'blocked');

  assert.equal(member('missing-member').status, 'missing');
  assert.equal(member('missing-member').planning, null, 'a missing member publishes no planning facts');
  assert.equal(epic.summary.merged, 0);
  assert.equal(epic.summary.complete, 0, 'landed counts are unchanged by planning observations');
  assert.equal(epic.summary.prepared, 2, 'legacy prepared lifecycle counting is unchanged');
  assert.equal(epic.summary.missing, 1);
});

// Run alone: node --test --test-name-pattern='planned inventory keeps cancelled receipts' scripts/spec-observe/sentinel.test.mjs
test('planned inventory keeps cancelled receipts as history and a recorded worktree as a non-disqualifying fact', async t => {
  const f = sandbox(t), repo = primary(f.dir, 'planned-history-facts');
  const workspace = basename(repo);
  const settled = pack(repo, 'settled-worktree');
  receipt(settled, { id: 'settled', state: 'cancelled', started_at: ago(60000) });
  writeFileSync(join(settled, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1, name: 'One' }] }));
  const recorded = join(f.dir, 'recorded-worktree');
  writeFileSync(join(settled, 'locations.json'), JSON.stringify({ schema_version: 1, package_ref: `${workspace}/settled-worktree`,
    targets: [{ id: workspace, primary: repo, common: join(repo, '.git'), branch: 'spec-settled', worktree: recorded }] }));
  const active = pack(repo, 'active-implementation');
  receipt(active, { id: 'active', state: 'running', started_at: ago(1000) });
  const completed = pack(repo, 'completed-implementation');
  receipt(completed, { id: 'completed', state: 'completed', started_at: ago(2000) });

  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  const row = snapshot.planned_packages.find(item => item.package === settled);
  assert.ok(row, 'a cancelled-only receipt history does not disqualify a package');
  assert.deepEqual(row.receipts, [{ id: 'settled', state: 'cancelled' }]);
  assert.equal(row.worktree_recorded, recorded, 'the recorded worktree is a fact, not a disqualifier');
  assert.ok(!snapshot.planned_packages.some(item => item.package === active), 'active implementation stays outside planned inventory');
  assert.ok(!snapshot.planned_packages.some(item => item.package === completed), 'completed implementation stays outside planned inventory');
});

test('completion history caps packages independently of monitored assignments and reports omitted history', async t => {
  const f = sandbox(t), repo = primary(f.dir, 'completion-cap');
  const active = pack(repo, 'active');
  receipt(active, { id: 'running', state: 'running', started_at: ago(1000) });
  for (let i = 0; i < SENTINEL_LIMITS.completedPackages + 1; i++) {
    const path = pack(repo, `done-${String(i).padStart(2, '0')}`), dir = join(path, 'runtime', 'sentinel', 'workflow');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ version: 1, workflow_id: 'workflow',
      package: path, state: 'complete', observed_at: ago(i * 1000), workers: [] }));
  }
  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  assert.deepEqual(snapshot.runs.map(r => r.package), [active]);
  assert.equal(snapshot.recently_completed.length, SENTINEL_LIMITS.completedPackages);
  assert.equal(snapshot.completion_history.omitted, 1);
  assert.ok(snapshot.recently_completed[0].package.endsWith('done-00'));
});

test('spec progress uses sparse index position without accepting completed workers', async t => {
  const f = sandbox(t), repo = primary(f.dir, 'progress'), packagePath = pack(repo);
  writeFileSync(join(packagePath, 'spec-steps.json'), JSON.stringify({ steps: [
    { step: 9, name: 'Finish' }, { step: 2, name: 'Start' }, { step: 5, name: 'Build' },
  ] }));
  for (const step of [2, 5, 9, 7]) receipt(packagePath, { id: `run-${step}`, state: 'completed',
    step: join(packagePath, `step-${String(step).padStart(3, '0')}-subspec.md`) });
  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  const progress = step => snapshot.runs.find(run => run.assignment_id === `run-${step}`).spec_progress;
  assert.deepEqual(progress(5), { basis: 'step-position', total_steps: 3, current_step: 5,
    current_position: 2, current_name: 'Build', accepted_steps: null });
  assert.equal(progress(2).current_position, 1);
  assert.equal(progress(9).current_position, 3);
  assert.equal(progress(9).accepted_steps, null);
  assert.equal(progress(7).current_position, null);
});

test('missing, empty and malformed indices keep spec size and position honest', async t => {
  const f = sandbox(t), repo = primary(f.dir, 'unknown-progress'), packagePath = pack(repo);
  receipt(packagePath, { id: 'run', state: 'completed', step: join(packagePath, 'step-001-subspec.md') });
  const input = { roots: [repo], indexDir: f.indexDir, now };
  assert.equal((await collect(input)).runs[0].spec_progress.total_steps, null);
  writeFileSync(join(packagePath, 'spec-steps.json'), JSON.stringify({ steps: [] }));
  assert.equal((await collect(input)).runs[0].spec_progress.total_steps, 0);
  for (const steps of [[{ step: 0 }], [{ step: 1 }, { step: 1 }], [{ name: 'Missing ID' }]]) {
    writeFileSync(join(packagePath, 'spec-steps.json'), JSON.stringify({ steps }));
    const run = (await collect(input)).runs[0];
    assert.equal(run.spec_progress.total_steps, null);
    assert.equal(run.spec_progress.current_position, null);
    assert.equal(run.coverage.state, 'partial');
  }
});

test('worker completion retains the current unfinished workflow without activating historical attempts', async t => {
  const f = sandbox(t), repo = primary(f.dir, 'between-steps'), packagePath = pack(repo);
  receipt(packagePath, { id: 'old', state: 'completed', started_at: ago(120000) });
  receipt(packagePath, { id: 'current', state: 'completed', started_at: ago(60000) });
  const dir = join(packagePath, 'runtime', 'sentinel', 'workflow');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ version: 1, workflow_id: 'workflow',
    package: packagePath, state: 'ready', observed_at: ago(1000), workers: [{ id: 'old' }, { id: 'current' }] }));
  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  const current = snapshot.runs.find(r => r.assignment_id === 'current');
  assert.equal(current.execution, 'completed');
  assert.equal(current.workflow_state, 'ready');
  assert.equal(current.is_current_assignment, true);
  assert.equal(snapshot.runs.find(r => r.assignment_id === 'old').is_current_assignment, false);
});

test('completed implementation exposes recorded repair workers and explicit attempt reasons without inferring acceptance', async t => {
  const f = sandbox(t), repo = primary(f.dir, 'repair'), packagePath = pack(repo);
  receipt(packagePath, { id: 'done', state: 'completed', started_at: ago(60000),
    attempt_kind: 'verification-continuation', handoff: { outcome: 'checkpoint' } });
  const dir = join(packagePath, 'runtime/sentinel/workflow'); mkdirSync(dir, { recursive: true });
  const checkpoint = { version: 1, workflow_id: 'workflow', package: packagePath, state: 'waiting-worker', observed_at: ago(1000),
    workers: [{ id: 'done', kind: 'owner', state: 'complete' }, { id: 'repair-4', kind: 'fixer', state: 'working' }] };
  writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify(checkpoint));
  const input = { roots: [repo], indexDir: f.indexDir, now };
  const snapshot = await collect(input), run = snapshot.runs[0];
  assert.equal(run.execution, 'completed');
  assert.deepEqual(run.workflow_workers, [{ id: 'repair-4', kind: 'fixer', state: 'working' }]);
  assert.equal(run.workflow_observed_at, ago(1000));
  assert.equal(run.timing.attempts[0].attempt_kind, 'verification-continuation');
  assert.equal(run.timing.attempts[0].handoff_outcome, 'checkpoint');
  assert.match(renderWorkspace(snapshot).join('\n'), /Recorded worker: fixer repair-4/);
  checkpoint.workers[1].state = 'complete';
  writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify(checkpoint));
  assert.deepEqual((await collect(input)).runs[0].workflow_workers, []);
});

// Run alone: node --test --test-name-pattern='replaced step workers' scripts/spec-observe/sentinel.test.mjs
test('replaced step workers retain the current coordinator obligation without binding historical or foreign runs', async t => {
  const f = sandbox(t), repo = primary(f.dir, 'handoff'), packagePath = pack(repo);
  const binding = { checkout: repo, parent_session: '/sessions/coordinator.jsonl' };
  receipt(packagePath, { id: 'old', state: 'completed', started_at: ago(120000), ...binding });
  receipt(packagePath, { id: 'current', state: 'completed', started_at: ago(60000), ...binding });
  const dir = join(packagePath, 'runtime/sentinel/workflow'); mkdirSync(dir, { recursive: true });
  const checkpoint = { version: 1, workflow_id: 'workflow', package: packagePath,
    checkout: repo, coordinator_session: binding.parent_session, state: 'waiting-worker', observed_at: ago(1000),
    obligation: { summary: 'Await step fix' }, workers: [{ id: 'fix-worker', kind: 'fixer', state: 'working' }] };
  const save = () => writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify(checkpoint));
  save();
  const input = { packages: [packagePath], indexDir: f.indexDir, now };
  const snapshot = await collect(input);
  const current = snapshot.runs.find(run => run.assignment_id === 'current');
  assert.equal(current.execution, 'completed');
  assert.equal(current.is_current_assignment, true);
  assert.equal(current.workflow_state, 'waiting-worker');
  assert.equal(current.obligation, 'Await step fix');
  assert.deepEqual(current.workflow_workers, [{ id: 'fix-worker', kind: 'fixer', state: 'working' }]);
  assert.equal(snapshot.runs.find(run => run.assignment_id === 'old').workflow_state, null);
  for (const [key, value] of [['coordinator_session', '/sessions/other.jsonl'], ['checkout', '/other/checkout'], ['observed_at', ago(90000)]]) {
    const previous = checkpoint[key]; checkpoint[key] = value; save();
    assert.equal((await collect(input)).runs.find(run => run.assignment_id === 'current').workflow_state, null, key);
    checkpoint[key] = previous;
  }
  save();
  const other = join(packagePath, 'runtime/sentinel/other'); mkdirSync(other);
  writeFileSync(join(other, 'checkpoint.json'), JSON.stringify({ ...checkpoint, workflow_id: 'other' }));
  assert.equal((await collect(input)).runs.find(run => run.assignment_id === 'current').workflow_state, null, 'ambiguous workflow');
});

test('spec timing retains the earliest dispatch and every attempt across assignment caps', async t => {
  const f = sandbox(t), repo = primary(f.dir, 'timing'), packagePath = pack(repo);
  writeFileSync(join(packagePath, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1, name: 'Build' }] }));
  for (let i = 0; i < 52; i++) receipt(packagePath, { id: `attempt-${i}`, state: i === 51 ? 'running' : 'completed',
    step: join(packagePath, 'step-001-subspec.md'), started_at: ago((60 - i) * 60000),
    dispatch_requested_at: i === 0 ? ago(61 * 60000) : undefined,
    finished_at: i === 51 ? undefined : ago((59 - i) * 60000) });
  const input = { roots: [repo], indexDir: f.indexDir, now, includeInactive: true };
  const snapshot = await collect(input);
  assert.equal(snapshot.runs.length, 50);
  const timing = snapshot.runs.find(r => r.is_current_assignment).timing;
  assert.equal(timing.started_at, ago(61 * 60000));
  assert.equal(timing.attempts.length, 52, 'timing reuses all bounded receipts, even omitted display assignments');
  assert.equal(timing.attempts[0].name, 'Build');
  assert.equal(timing.attempts[0].finished_at, ago(59 * 60000));
  assert.equal(timing.attempts.at(-1).finished_at, null);
  assert.equal(timing.finished_at, null, 'worker completion does not establish spec completion');
  receipt(packagePath, { id: 'attempt-51', state: 'completed', started_at: ago(9 * 60000), finished_at: ago(60000) });
  const dir = join(packagePath, 'runtime', 'sentinel', 'workflow');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ version: 1, workflow_id: 'workflow',
    package: packagePath, state: 'complete', observed_at: ago(30000), workers: [] }));
  assert.equal((await collect(input)).runs[0].timing.finished_at, ago(30000));
  receipt(packagePath, { id: 'reopened', state: 'running', started_at: ago(10000) });
  assert.equal((await collect(input)).runs[0].timing.finished_at, null);
});

// Run independently: node --test --test-name-pattern='merged lifecycle' scripts/spec-observe/sentinel.test.mjs
test('merged lifecycle supersedes stale draft and worker checkpoint but new dispatch keeps work current',async t=>{
 const {mergeBinding}=await import('./merge-reconciliation.mjs');const f=sandbox(t),repo=primary(f.dir,'merged-lifecycle'),pkg=pack(repo);
 writeFileSync(join(pkg,'spec-steps.json'),JSON.stringify({steps:[{step:1,name:'Build'}]}));mkdirSync(join(pkg,'learnings'));
 writeFileSync(join(pkg,'learnings','step-001-learning.md'),'```yaml\nlearning:\n  version: 2\n  kind: "step"\n  step: 1\n  outcome: "as-specified"\n  commit: "'+'c'.repeat(40)+'"\n```\n');
 publication(pkg,{kind:'pr_submission',url:'https://github.com/o/r/pull/1',branch:'feature',base:'main',draft:true,commit:'d'.repeat(40)});
 receipt(pkg,{id:'run',assignment_id:'attempt',state:'cancelled',started_at:ago(60000)});
 const dir=join(pkg,'runtime','sentinel','workflow');mkdirSync(dir,{recursive:true});const checkpoint={version:1,workflow_id:'workflow',package:pkg,state:'waiting-worker',observed_at:ago(30000),workers:[{id:'attempt',kind:'owner',state:'working'}]};writeFileSync(join(dir,'checkpoint.json'),JSON.stringify(checkpoint));
 let checks=0;const reconcileMerge=async input=>{checks++;return {schema_version:1,package_ref:input.ref,target:input.target,binding:mergeBinding(input),state:'merged',head:'a'.repeat(40),merge_commit:'b'.repeat(40),merged_at:ago(1000)};};
 const input={packages:[pkg],indexDir:f.indexDir,now,reconcileMerge};const merged=await collect(input);
 assert.equal(checks,1);assert.equal(merged.runs.length,0);assert.equal(merged.recently_completed[0].completion_basis,'merged-pr');assert.equal(merged.recently_completed[0].execution,'cancelled','merge lifecycle does not turn a cancelled worker into success');
 receipt(pkg,{id:'new',state:'running',started_at:ago(0)});const reopened=await collect(input);assert.equal(reopened.recently_completed.length,0);assert.equal(reopened.runs.length,2);assert.equal(checks,2,'lookup does not supersede a dispatch newer than the merge');
});

// Run independently: node --test --test-name-pattern='scoped merged PR' scripts/spec-observe/sentinel.test.mjs
test('scoped merged PR supersedes old running receipts and unfinished planning without inventing acceptance',async t=>{
 const {mergeBinding}=await import('./merge-reconciliation.mjs');const f=sandbox(t),repo=primary(f.dir,'legacy-merged'),pkg=pack(repo);
 writeFileSync(join(pkg,'spec-steps.json'),JSON.stringify({steps:[{step:1},{step:2}]}));
 // Canonical publication records can omit branch/base and step learnings.
 publication(pkg,{kind:'pr_submission',url:'https://github.com/o/r/pull/2',draft:true});
 receipt(pkg,{id:'old',state:'running',started_at:ago(60000)});
 const dir=join(pkg,'runtime','sentinel','workflow');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'checkpoint.json'),JSON.stringify({version:1,workflow_id:'workflow',package:pkg,state:'waiting-worker',observed_at:ago(30000),workers:[{id:'old',state:'working',kind:'owner'}]}));
 let observed;const reconcileMerge=async input=>{observed=input;return {schema_version:1,package_ref:input.ref,target:input.target,binding:mergeBinding(input),state:'merged',head:'a'.repeat(40),merge_commit:'b'.repeat(40),merged_at:ago(1000)};};
 const result=await collect({packages:[pkg],indexDir:f.indexDir,now,reconcileMerge});
 assert.equal(observed.pr.branch,null);assert.equal(observed.pr.base,null);assert.equal(result.runs.length,0);assert.equal(result.recently_completed[0].execution,'running');assert.equal(result.recently_completed[0].completion_basis,'merged-pr');
 const missing=pack(repo,'unpublished');receipt(missing,{id:'unpublished',state:'running',started_at:ago(1000)});
 const next=await collect({packages:[missing],indexDir:f.indexDir,now,reconcileMerge});assert.equal(next.runs[0].merge.reason,'missing-pr-record');
});

// Run independently: node --test --test-name-pattern='receipt discovery ignores' scripts/spec-observe/sentinel.test.mjs
test('receipt discovery ignores hundreds of sidecar logs without weakening the actual receipt cap',async t=>{
 const {mergeBinding}=await import('./merge-reconciliation.mjs');const f=sandbox(t),repo=primary(f.dir,'receipt-sidecars'),pkg=pack(repo);
 receipt(pkg,{id:'current',state:'running',started_at:ago(60000)});
 const runs=join(pkg,'runtime','runs');for(let i=0;i<510;i++)writeFileSync(join(runs,`log-${i}.md`),'ignored log');
 publication(pkg,{kind:'pr_submission',url:'https://github.com/o/r/pull/3'});
 let checks=0;const reconcileMerge=async input=>{checks++;return {schema_version:1,package_ref:input.ref,target:input.target,binding:mergeBinding(input),state:'merged',head:'a'.repeat(40),merge_commit:'b'.repeat(40),merged_at:ago(1000)};};
 const input={packages:[pkg],indexDir:f.indexDir,now,reconcileMerge};const merged=await collect(input);
 assert.equal(merged.runs.length,0);assert.equal(merged.recently_completed.length,1);assert.equal(merged.coverage.state,'complete');assert.equal(checks,1);
 for(let i=0;i<SENTINEL_LIMITS.receiptFiles;i++)receipt(pkg,{id:`attempt-${i}`,state:'completed',started_at:ago(30000)});
 const capped=await collect(input);assert.equal(capped.recently_completed.length,0);assert.ok(capped.coverage.reasons.some(r=>r.startsWith('receipts-cap:')));assert.equal(checks,1,'genuine receipt truncation inhibits lifecycle reconciliation');
});

// Run independently: node --test --test-name-pattern='cold local merge' scripts/spec-observe/sentinel.test.mjs
test('cold local merge cache stays tied to the fetched base ref',async t=>{
 const {mergeBinding}=await import('./merge-reconciliation.mjs');const f=sandbox(t),repo=primary(f.dir,'cold-local'),pkg=pack(repo);
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();const head=git('rev-parse','HEAD');git('branch','feature');
 writeFileSync(join(repo,'next'),'next');git('add','next');git('commit','-qm','Advance fixture base');const base=git('rev-parse','HEAD');git('update-ref','refs/remotes/origin/main',base);
 receipt(pkg,{id:'old',state:'running',started_at:ago(60000)});const pr={kind:'pr_submission',url:'https://github.com/o/r/pull/7',branch:'feature',base:'main'};publication(pkg,pr);
 const input={package:pkg,ref:'cold-local/feature',target:'cold-local',primary:repo,pr,commits:[],receipts:[['old','running',ago(60000)]],checkpoints:[]};writeFileSync(join(pkg,'sentinel-merge.json'),JSON.stringify({schema_version:2,package_ref:input.ref,targets:{'cold-local':{schema_version:1,package_ref:input.ref,target:input.target,binding:mergeBinding(input),url:pr.url,branch:'feature',base:'main',head,merge_commit:base,merged_at:ago(1000),state:'merged',reason:'local-pr-merge',evidence_source:'local-git',base_tip:base}}}));
 const options={packages:[pkg],indexDir:f.indexDir,now};assert.equal((await collect(options)).recently_completed.length,1);
 git('update-ref','refs/remotes/origin/main',head);const rewound=await collect(options);assert.equal(rewound.recently_completed.length,0);assert.equal(rewound.runs.length,1);assert.equal(rewound.runs[0].merge.reason,'merge-evidence-unavailable');
});

// Run independently: node --test --test-name-pattern='declared tour evidence' scripts/spec-observe/sentinel.test.mjs
test('declared tour evidence records a ready verdict at the declared old commit with explicit scope', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'tour-recorded');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const oldCommit = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'next'), 'next\n');
  git('add', 'next');
  git('commit', '-qm', 'Advance fixture');
  assert.notEqual(git('rev-parse', 'HEAD'), oldCommit, 'the declared commit is older than current HEAD');
  const packagePath = pack(repo);
  // Real tours carry an evidence manifest well past the small-JSON read limit.
  writeFileSync(join(packagePath, 'work-tour.json'), JSON.stringify({ verdict: 'ready', commit: oldCommit, manifest: 'x'.repeat(SENTINEL_LIMITS.smallJsonBytes * 2) }));
  receipt(packagePath, { id: 'run-tour', assignment_id: 'assign-tour', state: 'running', started_at: ago(60000) });

  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  const run = snapshot.runs.find(item => item.assignment_id === 'assign-tour');
  assert.ok(run);
  assert.deepEqual(run.evidence, {
    state: 'recorded', verdict: 'ready', commit: oldCommit, source: 'work-tour.json',
    scope: 'declared-artifact', observed_at: run.observed_at, reason: null,
  });
  assert.equal(run.execution, 'running');
  assert.ok(run.source_paths.includes(join(packagePath, 'work-tour.json')), 'recorded evidence retains its source');
  assert.equal(run.source_hashes.length, run.source_paths.length);
  assert.deepEqual(snapshot.recently_completed, [], 'declared evidence alone is not completion');
});

test('declared tour evidence stays not-assessed when the package has no work-tour artifact', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'tour-missing');
  const packagePath = pack(repo);
  receipt(packagePath, { id: 'run-none', assignment_id: 'assign-none', state: 'running', started_at: ago(60000) });
  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  const run = snapshot.runs.find(item => item.assignment_id === 'assign-none');
  assert.deepEqual(run.evidence, { state: 'not-assessed', verdict: null, commit: null,
    source: 'work-tour.json', scope: 'declared-artifact', observed_at: run.observed_at, reason: null });
  assert.equal(run.coverage.state, 'complete', 'an absent declared artifact is not a coverage gap');
});

test('declared tour evidence stays not-assessed under manual completion and never implies acceptance', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'tour-manual');
  const packagePath = pack(repo);
  receipt(packagePath, { id: 'run-manual', assignment_id: 'assign-manual', state: 'running', started_at: ago(60000) });
  writeFileSync(join(packagePath, 'sentinel-completion.json'), JSON.stringify({ schema_version: 2,
    kind: 'manual_completion', package_ref: 'tour-manual/feature', package: packagePath, completed_at: ago(1000) }));
  const input = { roots: [repo], indexDir: f.indexDir, now };

  const hidden = await collect(input);
  assert.deepEqual(hidden.runs, []);
  assert.equal(hidden.recently_completed.length, 1);
  assert.equal(hidden.recently_completed[0].completion_basis, 'manual');
  assert.equal(hidden.recently_completed[0].evidence.state, 'not-assessed');
  assert.equal(hidden.recently_completed[0].evidence.verdict, null);

  const visible = await collect({ ...input, includeInactive: true });
  const run = visible.runs.find(item => item.assignment_id === 'assign-manual');
  assert.equal(run.execution, 'running');
  assert.equal(run.evidence.state, 'not-assessed', 'manual completion never invents declared evidence');
});

test('declared tour evidence does not derive lifecycle from a terminal worker receipt', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'tour-terminal');
  const packagePath = pack(repo);
  receipt(packagePath, { id: 'run-done', assignment_id: 'assign-done', state: 'completed',
    started_at: ago(60000), finished_at: ago(30000) });
  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  const run = snapshot.runs.find(item => item.assignment_id === 'assign-done');
  assert.equal(run.execution, 'completed');
  assert.equal(run.evidence.state, 'not-assessed');
  assert.equal(run.coverage.state, 'complete');
  assert.deepEqual(snapshot.recently_completed, [], 'a worker receipt is not workflow completion');
});

test('declared tour evidence reports malformed and symlinked artifacts as unavailable', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'tour-invalid');
  const packagePath = pack(repo);
  receipt(packagePath, { id: 'run-bad', assignment_id: 'assign-bad', state: 'running', started_at: ago(60000) });
  const file = join(packagePath, 'work-tour.json');
  const input = { roots: [repo], indexDir: f.indexDir, now };

  writeFileSync(file, JSON.stringify({ version: 1, verdict: 'ready' }));
  const missingCommit = (await collect(input)).runs.find(item => item.assignment_id === 'assign-bad');
  assert.equal(missingCommit.evidence.state, 'unavailable');
  assert.equal(missingCommit.evidence.reason, `work-tour-invalid: ${file}`);

  writeFileSync(file, '{not json');
  const broken = (await collect(input)).runs.find(item => item.assignment_id === 'assign-bad');
  assert.equal(broken.evidence.state, 'unavailable');
  assert.match(broken.evidence.reason, /work-tour-invalid/);

  rmSync(file);
  writeFileSync(join(packagePath, 'tour-target.json'), JSON.stringify({ version: 2, verdict: 'blocked', commit: 'a'.repeat(40) }));
  symlinkSync(join(packagePath, 'tour-target.json'), file);
  const linked = (await collect(input)).runs.find(item => item.assignment_id === 'assign-bad');
  assert.equal(linked.evidence.state, 'unavailable');
  assert.match(linked.evidence.reason, /source-not-regular/);

  rmSync(file);
  symlinkSync(join(packagePath, 'absent-tour-target.json'), file);
  const dangling = (await collect(input)).runs.find(item => item.assignment_id === 'assign-bad');
  assert.equal(dangling.evidence.state, 'unavailable');
  assert.match(dangling.evidence.reason, /source-not-regular/);
});

test('declared tour evidence reports an oversized artifact as unavailable without touching completion', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'tour-oversized');
  const packagePath = pack(repo);
  receipt(packagePath, { id: 'run-fat', assignment_id: 'assign-fat', state: 'running', started_at: ago(60000) });
  const file = join(packagePath, 'work-tour.json');
  writeFileSync(file, JSON.stringify({ version: 1, verdict: 'ready', commit: 'a'.repeat(40),
    padding: 'x'.repeat(SENTINEL_LIMITS.tourBytes) }));
  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  const run = snapshot.runs.find(item => item.assignment_id === 'assign-fat');
  assert.equal(run.evidence.state, 'unavailable');
  assert.equal(run.evidence.reason, `work-tour-oversized: ${file}`);
  assert.equal(snapshot.coverage.state, 'complete');
  assert.deepEqual(snapshot.recently_completed, []);
});

test('declared tour evidence leaves ready-pr completion and recent lifecycle rules unchanged', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'tour-completion');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'next'), 'next\n');
  git('add', 'next');
  git('commit', '-qm', 'Advance fixture');
  const packagePath = pack(repo);
  writeFileSync(join(packagePath, 'work-tour.json'), JSON.stringify({ version: 2, verdict: 'ready', commit }));
  publication(packagePath, { url: 'https://github.com/o/r/pull/9', commit, submitted_at: ago(1000), mode: 'ready' });
  receipt(packagePath, { id: 'run-published', assignment_id: 'assign-published', state: 'completed', started_at: ago(60000) });

  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  assert.deepEqual(snapshot.runs, [], 'ready publication still leaves monitoring');
  assert.equal(snapshot.activity_filter.hidden_completed_packages, 1);
  assert.equal(snapshot.recently_completed.length, 1);
  assert.equal(snapshot.recently_completed[0].completion_basis, 'ready-pr');
  assert.equal(snapshot.recently_completed[0].evidence.state, 'recorded');
  assert.equal(snapshot.recently_completed[0].evidence.verdict, 'ready');
  assert.equal(snapshot.recently_completed[0].evidence.commit, commit);
  assert.equal(snapshot.recently_completed[0].evidence.scope, 'declared-artifact');
  assert.equal(snapshot.recently_completed[0].execution, 'completed');
  // A draft publication is not completion.
  publication(packagePath, { url: 'https://github.com/o/r/pull/9', commit, submitted_at: ago(1000), mode: 'draft' });
  const draft = await collect({ roots: [repo], indexDir: f.indexDir, now });
  assert.deepEqual(draft.recently_completed, []);
  assert.equal(draft.runs.length, 1);
});

const ASSIGNMENT_READER_ID = '11111111-1111-4111-8111-111111111111';

test('assignment reader: a persisted live assignment stays unknown under unavailable final probes', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'assignments-reader');
  const packagePath = pack(repo);
  receipt(packagePath, { id: 'run-reader', assignment_id: ASSIGNMENT_READER_ID, state: 'running', started_at: ago(60000) });

  // Real adj3 storage plus a real adj4 resolved record persisted as a live
  // assignment in the temporary root. Nothing is launched and no model runs.
  const storageRoot = join(f.dir, 'storage');
  await setupStorage(storageRoot);
  const workspace = await createWorkspace(storageRoot, { id: 'ws-reader', name: 'Reader Workspace' });
  mkdirSync(join(workspace.directory, 'briefs'), { recursive: true });
  writeFileSync(join(workspace.directory, 'briefs', 'brief.md'), '# Reader brief\n');
  const resolved = await resolveAssignment({
    assignment_id: ASSIGNMENT_READER_ID,
    workspace_id: 'ws-reader',
    brief: 'briefs/brief.md',
    instructions: 'Remain read-only while observed.',
    storageRoot,
    workflow_id: 'workflow-reader',
    pi_path: process.execPath,
  });
  mkdirSync(join(workspace.directory, 'assignments'), { recursive: true });
  writeFileSync(
    join(workspace.directory, 'assignments', `${ASSIGNMENT_READER_ID}.json`),
    JSON.stringify({ ...resolved.record, state: 'live', updated_at: new Date(FIXED).toISOString() }),
  );

  const snapshot = await collect({
    roots: [repo],
    packages: [packagePath],
    indexDir: f.indexDir,
    now,
    storageRoot,
    assignmentProbes: {
      inspect: pid => ({ state: 'unknown', pid, reason: 'synthetic-unavailable' }),
      psRun: async () => ({ stdout: '', complete: false }),
      tmuxRun: async () => {
        const error = new Error('synthetic tmux unavailable');
        error.code = 'ENOENT';
        throw error;
      },
    },
  });

  assert.equal(SENTINEL_LIMITS.workspaceAssignments, 100);
  assert.ok(Array.isArray(snapshot.assignments), 'collectWorkspace must expose additive assignment rows');
  const row = snapshot.assignments.find(entry => entry.assignment_id === ASSIGNMENT_READER_ID);
  assert.ok(row, 'the persisted live assignment must be exposed');
  assert.equal(row.assignment_id, ASSIGNMENT_READER_ID);
  assert.equal(row.display, 'unknown');
  assert.equal(row.hasControl, false);
  assert.equal(snapshot.assignment_coverage.state, 'partial');

  const run = snapshot.runs.find(entry => entry.assignment_id === ASSIGNMENT_READER_ID);
  assert.ok(run, 'the existing run row stays present');
  assert.equal(run.execution, 'running');

  const rendered = renderWorkspace(snapshot).join('\n');
  assert.ok(rendered.includes(ASSIGNMENT_READER_ID), 'the full assignment id must render');
  assert.match(rendered, /unknown/);
  assert.match(rendered, /no relaunch/i);
});

test('missing assignment root stays explicit and changes no run facts', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'missing-assignment-root');
  const packagePath = pack(repo);
  receipt(packagePath, { id: 'run-root', assignment_id: 'assign-root', state: 'running', started_at: ago(60000) });
  const omitted = await collect({ roots: [repo], packages: [packagePath], indexDir: f.indexDir, now, storageRoot: null });
  const missingRoot = join(f.dir, 'no-such-storage-root');
  const missing = await collect({ roots: [repo], packages: [packagePath], indexDir: f.indexDir, now, storageRoot: missingRoot });
  assert.deepEqual(missing.runs, omitted.runs, 'run rows are unchanged by the missing assignment source');
  assert.deepEqual(missing.recently_completed, omitted.recently_completed);
  assert.ok(missing.coverage.reasons.some(reason => reason.startsWith('storage-unavailable')), 'a missing storage root is a coverage reason');
  assert.equal(omitted.assignments.length, 0);
  assert.equal(omitted.assignment_coverage.state, 'unavailable');
  assert.equal(missing.assignments.length, 0);
  assert.equal(missing.assignment_coverage.state, 'unavailable');
  assert.ok(missing.assignment_coverage.reasons.some(reason => reason.startsWith('storage-')),
    JSON.stringify(missing.assignment_coverage.reasons));
  assert.equal(existsSync(missingRoot), false, 'the missing storage root is never created');
});

test('assignment reader: CLI status and inspect expose one exact sanitized row', async t => {
  const f = sandbox(t);
  const repo = primary(f.dir, 'cli-assignment-reader');
  const packagePath = pack(repo);
  receipt(packagePath, { id: 'run-cli-reader', assignment_id: ASSIGNMENT_READER_ID, state: 'running', started_at: ago(60000) });
  const storageRoot = join(f.dir, 'storage');
  await setupStorage(storageRoot);
  const workspace = await createWorkspace(storageRoot, { id: 'ws-cli-reader', name: 'CLI Reader Workspace' });
  mkdirSync(join(workspace.directory, 'briefs'), { recursive: true });
  writeFileSync(join(workspace.directory, 'briefs', 'brief.md'), '# CLI Reader brief\n');
  const resolved = await resolveAssignment({
    assignment_id: ASSIGNMENT_READER_ID,
    workspace_id: 'ws-cli-reader',
    brief: 'briefs/brief.md',
    instructions: 'Remain read-only while observed.',
    storageRoot,
    workflow_id: 'workflow-cli-reader',
    pi_path: process.execPath,
  });
  mkdirSync(join(workspace.directory, 'assignments'), { recursive: true });
  writeFileSync(join(workspace.directory, 'assignments', `${ASSIGNMENT_READER_ID}.json`),
    JSON.stringify({ ...resolved.record, state: 'live',
      attention: ['injected\u0007control\nsecond line', 'plain attention'] }));
  const agentDir = join(f.dir, 'agent');
  mkdirSync(agentDir, { recursive: true });
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const runCli = args => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000,
        env: { PATH: process.env.PATH, HOME: f.dir, PI_CODING_AGENT_DIR: agentDir, PI_INTERCOM_SCOPE_ID: '', ADJACENT_STORAGE_ROOT: storageRoot, LC_ALL: 'C', TMPDIR: tmpdir() } }) };
    } catch (error) {
      return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
    }
  };

  const status = runCli(['sentinel', 'status', '--root', f.dir, '--format', 'json']);
  assert.equal(status.status, 0, status.stderr);
  const statusSnapshot = JSON.parse(status.stdout);
  assert.ok(statusSnapshot.assignments.some(row => row.assignment_id === ASSIGNMENT_READER_ID));

  const inspect = runCli(['sentinel', 'inspect', ASSIGNMENT_READER_ID, '--root', f.dir, '--format', 'json']);
  assert.equal(inspect.status, 0, inspect.stderr);
  const inspected = JSON.parse(inspect.stdout);
  assert.equal(inspected.assignment.assignment_id, ASSIGNMENT_READER_ID);
  assert.equal(inspected.assignment.hasControl, false);
  assert.equal(inspected.assignment.display, 'unknown');

  const direct = await collect({ roots: [repo], packages: [packagePath], indexDir: f.indexDir, now: Date.now, storageRoot });
  const directRow = direct.assignments.find(row => row.assignment_id === ASSIGNMENT_READER_ID);
  assert.ok(directRow, 'direct real producers see the same assignment');
  assert.equal(inspected.assignment.display, directRow.display);
  assert.equal(inspected.assignment.recordedState, directRow.recordedState);
  assert.equal(inspected.assignment.observedState, directRow.observedState);
  assert.equal(inspected.assignment.hasControl, directRow.hasControl);
  assert.equal(inspected.assignment.quiet, directRow.quiet);

  const prefix = runCli(['sentinel', 'inspect', ASSIGNMENT_READER_ID.slice(0, 8), '--root', f.dir, '--format', 'json']);
  assert.notEqual(prefix.status, 0, 'a short prefix is rejected');
  assert.match(prefix.stderr, /full assignment UUID/);
  const wrong = runCli(['sentinel', 'inspect', '99999999-9999-4999-8999-999999999999', '--root', f.dir, '--format', 'json']);
  assert.notEqual(wrong.status, 0, 'an unknown full UUID is rejected');
  assert.match(wrong.stderr, /No observed assignment matches/);

  const text = runCli(['sentinel', 'inspect', ASSIGNMENT_READER_ID, '--root', f.dir]);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(/[\u0000-\u0009\u000b-\u001f]/.test(text.stdout), false,
    'no injected control characters survive the text render');
  assert.ok(text.stdout.includes('injectedcontrol'),
    'publicHint keeps the injected text on one collapsed safe line');
  assert.equal(text.stdout.includes('second line'), false,
    'the injected newline never becomes a rendered line');
});

// Run independently: node --test --test-name-pattern='epic membership' scripts/spec-observe/sentinel.test.mjs
test('epic membership derives member status from package facts and skips underscore folders', async t => {
  const { mergeBinding } = await import('./merge-reconciliation.mjs');
  const f = sandbox(t), repo = primary(f.dir, 'epic-primary');
  const workspaceDir = join(STORAGE, 'projects', 'epic-primary');
  mkdirSync(join(workspaceDir, 'plans'), { recursive: true });
  writeFileSync(join(workspaceDir, 'plans', 'demo.md'), '# plan\n');
  const merged = pack(repo, 'a-merged'), live = pack(repo, 'b-live'), ready = pack(repo, 'c-ready');
  receipt(pack(repo, '_backup'), { id: 'skipped', state: 'running', started_at: ago(1000) });
  publication(merged, { kind: 'pr_submission', url: 'https://github.com/o/r/pull/9' });
  receipt(merged, { id: 'done', state: 'completed', started_at: ago(60000) });
  writeFileSync(join(live, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1, name: 'One' }, { step: 2, name: 'Two' }] }));
  receipt(live, { id: 'run', assignment_id: 'assign-live', state: 'running', started_at: ago(60000), step: join(live, 'step-2-subspec.md') });
  writeFileSync(join(ready, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1 }] }));
  const epics = join(workspaceDir, 'epics');
  mkdirSync(join(epics, 'demo'), { recursive: true });
  mkdirSync(join(epics, 'bad'), { recursive: true });
  writeFileSync(join(epics, 'bad', 'epic.json'), JSON.stringify({ schema_version: 1, epic: 'other', title: 'Bad', state: 'active', packages: [] }));
  writeFileSync(join(epics, 'demo', 'epic.json'), JSON.stringify({ schema_version: 1, epic: 'demo', title: 'Demo epic', plan: 'demo.md', state: 'active',
    packages: [{ package: 'a-merged' }, { package: 'b-live', requires: ['a-merged'] }, { package: 'c-ready', requires: ['a-merged'] },
      { package: 'd-missing', requires: ['c-ready'] }] }));
  const reconcileMerge = async input => input.package === merged
    ? { schema_version: 1, package_ref: input.ref, target: input.target, binding: mergeBinding(input), state: 'merged', head: 'a'.repeat(40), merge_commit: 'b'.repeat(40), merged_at: ago(1000) }
    : { state: 'unknown' };

  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now, reconcileMerge });
  assert.equal(snapshot.epics.length, 1, 'the invalid record is skipped, not guessed');
  const [epic] = snapshot.epics;
  assert.deepEqual(epic.members.map(m => [m.name, m.status]), [['a-merged', 'merged'], ['b-live', 'in-progress'], ['c-ready', 'prepared'], ['d-missing', 'missing']]);
  assert.deepEqual(epic.summary, { total: 4, merged: 1, complete: 0, published: 0, in_progress: 1, prepared: 1, proposed: 0, missing: 1, unobserved: 0, unknown: 0, attention: 0 });
  assert.equal(epic.next, 'c-ready');
  assert.deepEqual(epic.members[3].waiting_on, ['c-ready']);
  assert.deepEqual(epic.members[1].step, { position: 2, total: 2 });
  assert.equal(epic.plan, join(workspaceDir, 'plans', 'demo.md'));
  assert.equal(epic.workspace, 'epic-primary');
  assert.deepEqual(snapshot.runs.map(run => run.epic), [{ epic: 'demo', workspace: 'epic-primary', position: 2, total: 4 }]);
  assert.deepEqual(snapshot.recently_completed.map(run => run.epic?.position), [1]);
  assert.deepEqual(snapshot.coverage.reasons, [`epic-invalid: ${join(epics, 'bad', 'epic.json')} (epic does not match directory name)`]);
  assert.equal(snapshot.coverage.state, 'partial');
  const text = renderWorkspace(snapshot).join('\n');
  assert.match(text, /Epic demo · Demo epic · 1\/4 landed · next c-ready · state active/);
  assert.match(text, /\n  d-missing · missing · waiting on c-ready/);
  assert.match(text, /\n  b-live · in-progress · step 2\/2/);
});

// Storage packages created by spec-location itself (workspace "demo", repositories alpha and beta).
async function demoPackage(fx, slug, targets) {
  const made = await newPackage({ workspace: 'demo', slug, targets: targets.map(id => ({ id })), ...fx.options });
  assert.equal(made.ok, true, JSON.stringify(made));
  return made.locations.package_dir;
}
const demoInput = (fx, extra = {}) => ({ storageRoot: fx.root, indexDir: join(fx.tmp, 'index'), now, ...extra });

// Run alone: node --test --test-name-pattern='storage package' scripts/spec-observe/sentinel.test.mjs
test('storage package is observed with each target from locations.json, and unreadable locations are a coverage reason', async t => {
  const fx = makeFixture(); t.after(fx.cleanup);
  const both = await demoPackage(fx, 'both', ['alpha', 'beta']);
  const solo = await demoPackage(fx, 'solo', ['alpha']);
  receipt(both, { id: 'run-both', assignment_id: 'assign-both', state: 'running', started_at: ago(60000) });
  receipt(solo, { id: 'run-solo', assignment_id: 'assign-solo', state: 'running', started_at: ago(60000) });

  const snapshot = await collectWorkspace(demoInput(fx));
  const row = id => snapshot.runs.find(run => run.assignment_id === id);
  assert.equal(snapshot.coverage.state, 'complete');
  assert.deepEqual([row('assign-both').workspace, row('assign-both').package_ref], ['demo', 'demo/both']);
  assert.deepEqual(row('assign-both').targets, [{ id: 'alpha', primary: fx.alpha }, { id: 'beta', primary: fx.beta }]);
  assert.deepEqual(row('assign-solo').targets, [{ id: 'alpha', primary: fx.alpha }]);
  assert.match(renderWorkspace(snapshot).join('\n'), /demo\/both · assign-both · running/);

  rmSync(join(solo, 'locations.json'));
  const degraded = await collectWorkspace(demoInput(fx));
  assert.ok(degraded.coverage.reasons.includes('locations-unavailable: demo/solo'), JSON.stringify(degraded.coverage.reasons));
  assert.equal(degraded.coverage.state, 'partial');
  const unlocated = degraded.runs.find(run => run.assignment_id === 'assign-solo');
  assert.ok(unlocated, 'the run is still observed from its runtime files');
  assert.deepEqual(unlocated.targets, []);

  // --package scoping: a reference, a folder or a file inside it selects one package.
  writeFileSync(join(both, 'spec.md'), '# spec\n');
  for (const requested of ['demo/both', both, join(both, 'spec.md')]) {
    const scoped = await collectWorkspace(demoInput(fx, { packages: [requested], packagesOnly: true }));
    assert.deepEqual(scoped.runs.map(run => run.package_ref), ['demo/both'], requested);
  }
});

test('a repository with untracked .specs entries yields one legacy-location row naming the workspace to migrate', async t => {
  const fx = makeFixture(); t.after(fx.cleanup);
  mkdirSync(join(fx.alpha, '.specs', 'old-feature'), { recursive: true });
  writeFileSync(join(fx.alpha, '.specs', 'old-feature', 'spec.md'), '# old\n');
  const stray = join(fx.tmp, 'stray');
  mkdirSync(join(stray, '.specs', 'orphan'), { recursive: true });
  execFileSync('git', ['init', '-q', stray]);
  const clean = join(fx.tmp, 'clean');
  mkdirSync(join(clean, '.specs', 'tracked'), { recursive: true });
  execFileSync('git', ['init', '-q', clean]);
  writeFileSync(join(clean, '.specs', 'tracked', 'spec.md'), '# tracked\n');
  execFileSync('git', ['-C', clean, 'add', '-f', '.specs/tracked/spec.md']);

  const snapshot = await collectWorkspace(demoInput(fx, { roots: [fx.alpha, fx.beta, stray, clean] }));
  assert.deepEqual(snapshot.attention.map(({ kind, repository, workspaces, entries, count, remedy }) => ({ kind, repository, workspaces, entries, count, remedy })), [
    { kind: 'legacy-location', repository: fx.alpha, workspaces: ['demo'], entries: ['old-feature'], count: 1, remedy: 'spec-location migrate --workspace demo' },
    { kind: 'legacy-location', repository: stray, workspaces: [], entries: ['orphan'], count: 1, remedy: 'add the repository to a kit' },
  ]);
  assert.deepEqual(snapshot.runs, [], 'a legacy .specs folder is never read as a package');
  const text = renderWorkspace(snapshot).join('\n');
  assert.ok(text.includes(`Attention legacy-location · ${fx.alpha} · 1 untracked .specs entry · spec-location migrate --workspace demo`), text);
});

// Run alone: node --test --test-name-pattern='two-target' scripts/spec-observe/sentinel.test.mjs
test('a two-target package is merged only when the PR of every target is merged', async t => {
  const { mergeBinding } = await import('./merge-reconciliation.mjs');
  const fx = makeFixture(); t.after(fx.cleanup);
  const pkg = await demoPackage(fx, 'pair', ['alpha', 'beta']);
  receipt(pkg, { id: 'done', state: 'completed', started_at: ago(60000) });
  writeFileSync(join(pkg, 'pr-url.json'), JSON.stringify({ package_ref: 'demo/pair', targets: {
    alpha: { url: 'https://github.com/o/alpha/pull/1', branch: 'spec-pair' }, beta: { url: 'https://github.com/o/beta/pull/2', branch: 'spec-pair' } } }));
  const mergedTargets = new Set();
  const calls = [];
  const reconcileMerge = async input => {
    calls.push([input.target, input.primary]);
    return mergedTargets.has(input.target)
      ? { schema_version: 1, package_ref: input.ref, target: input.target, binding: mergeBinding(input), state: 'merged',
        url: input.pr.url, head: 'a'.repeat(40), merge_commit: 'b'.repeat(40), merged_at: ago(input.target === 'alpha' ? 3000 : 1000) }
      : { state: 'unmerged', reason: 'pr-not-merged', url: input.pr.url };
  };

  mergedTargets.add('alpha');
  const half = await collectWorkspace(demoInput(fx, { reconcileMerge }));
  assert.deepEqual(calls, [['alpha', fx.alpha], ['beta', fx.beta]], 'each target is checked in its own primary checkout');
  assert.equal(half.recently_completed.length, 0);
  assert.equal(half.runs[0].merge.state, 'unmerged');
  assert.deepEqual(half.runs[0].merge.targets.map(item => [item.target, item.state]), [['alpha', 'merged'], ['beta', 'unmerged']]);

  mergedTargets.add('beta');
  const both = await collectWorkspace(demoInput(fx, { reconcileMerge }));
  assert.deepEqual(both.runs, []);
  assert.equal(both.recently_completed[0].completion_basis, 'merged-pr');
  assert.equal(both.recently_completed[0].completed_at, ago(1000), 'the package lands when its last PR does');
  assert.equal(both.recently_completed[0].merge.state, 'merged');

  // A PR record that omits one target leaves the package unmerged.
  writeFileSync(join(pkg, 'pr-url.json'), JSON.stringify({ package_ref: 'demo/pair', targets: { alpha: { url: 'https://github.com/o/alpha/pull/1' } } }));
  const partial = await collectWorkspace(demoInput(fx, { reconcileMerge }));
  assert.equal(partial.recently_completed.length, 0);
  assert.equal(partial.runs[0].merge.reason, 'missing-pr-record');
});

test('a running run whose coordinator process is gone is flagged; a live or terminal one is not', async t => {
  const f = sandbox(t), repo = primary(f.dir, 'liveness'), pkg = pack(repo);
  const dead = childProcess.spawnSync(process.execPath, ['-e', '']).pid;
  receipt(pkg, { id: 'gone', assignment_id: 'assign-gone', state: 'running', started_at: ago(60000), coordinator_pid: dead });
  receipt(pkg, { id: 'alive', assignment_id: 'assign-alive', state: 'running', started_at: ago(60000), coordinator_pid: process.pid });
  receipt(pkg, { id: 'ended', assignment_id: 'assign-ended', state: 'failed', started_at: ago(60000), coordinator_pid: dead });
  receipt(pkg, { id: 'superseded', assignment_id: 'assign-stale', state: 'stale', started_at: ago(60000), coordinator_pid: dead });
  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  const row = id => snapshot.runs.find(run => run.assignment_id === id);
  assert.ok(row('assign-gone').coverage.reasons.includes('coordinator-gone'));
  assert.deepEqual(condition(row('assign-gone'), 'coordinator-gone'), { ...condition(row('assign-gone'), 'coordinator-gone'), severity: 'attention', state: 'open' });
  assert.equal(condition(row('assign-alive'), 'coordinator-gone'), undefined);
  assert.equal(condition(row('assign-ended'), 'coordinator-gone'), undefined);
  assert.equal(condition(row('assign-stale'), 'coordinator-gone'), undefined, 'a stale run is terminal');
});

test('a receipt names its package by reference, and a foreign reference is stale evidence', async t => {
  const f = sandbox(t), repo = primary(f.dir, 'by-ref'), pkg = pack(repo);
  // `package` is the writing machine's directory and need not exist here.
  receipt(pkg, { id: 'moved', assignment_id: 'assign-moved', state: 'running', started_at: ago(60000), package: '/other/host/projects/by-ref/specs/feature', package_ref: 'by-ref/feature' });
  receipt(pkg, { id: 'foreign', assignment_id: 'assign-foreign', state: 'running', started_at: ago(60000), package_ref: 'other/feature' });
  const snapshot = await collect({ roots: [repo], indexDir: f.indexDir, now });
  assert.deepEqual(snapshot.runs.map(run => run.assignment_id), ['assign-moved']);
  assert.equal(snapshot.coverage.state, 'stale');
  assert.ok(snapshot.coverage.reasons.some(reason => reason.startsWith('receipt-mismatch')));
});
