import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setWorktree } from '../../../scripts/spec-location/index.mjs';
import { makePackageFixture } from './package-fixture.mjs';
import { submitCompletion, completionStatus, recordVerification, verificationReceipts, revision, refreshProgress, recordCheckpoint, installProgressContext, watchProgress, reminder } from './completion.mjs';

async function fixture(t) {
  const base = await makePackageFixture({ prefix: 'completion-' });
  const root = base.repo, pkg = base.packagePath;
  t.after(() => rmSync(base.dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  writeFileSync(join(root, 'source.js'), 'export const value = 1;\n');
  git('add', '.'); git('commit', '-qm', 'Fixture');
  const recorded = await setWorktree(base.ref, 'repo', root, base.location);
  assert.equal(recorded.ok, true);
  mkdirSync(join(pkg, 'runtime/runs'), { recursive: true });
  writeFileSync(join(pkg, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1 }] }));
  mkdirSync(join(pkg, 'evidence')); writeFileSync(join(pkg, 'spec.md'), '# Spec');
  const gate = { id: 'EV-1', ownerStep: 1, required: true, phase: 'merge', rejects: ['FH-1'], artifact: 'evidence/check.txt' };
  writeFileSync(join(pkg, 'evidence-plan.json'), JSON.stringify({ gates: [gate] }));
  const r = { id: 'attempt-1', completion_contract: 1, step: join(pkg, 'step-001-subspec.md'), package: pkg, primary: root, checkout: root, state: 'running' };
  writeFileSync(join(pkg, 'runtime/runs/attempt-1.json'), JSON.stringify(r));
  const evidence = join(pkg, 'evidence/check.txt'); writeFileSync(evidence, 'observed check result\n');
  const receipt = recordVerification(r, 'node focused-check.js', revision(r), revision(r), { exit_code: 0, full_output_path: evidence });
  const input = { outcome: 'as-specified', strategy: 'implementation-first', decisions: ['Preserve existing caller contract.'], gaps: [], findings: [], introduced: [{ symbol: 'value', path: 'source.js', purpose: 'shared fixture value' }],
    evidence: [{ id: 'EV-1', status: 'passed', receipt_id: receipt.id, proof_boundary: 'isolated focused behavior only' }] };
  return { root, pkg, git, r, input, evidence };
}

// Wave attempts keep their own retained checkout, Git history and evidence, plus the
// runtime `wave_bindings` that name the target/attempt identity used by completion.mjs.
async function waveRuns(t, specs) {
  const f = await fixture(t);
  const runs = [];
  for (const { id, attempt_id, started_at, decisions = ['Wave attempt records its own immutable learning.'] } of specs) {
    const checkout = join(dirname(f.pkg), 'wave-attempts', attempt_id);
    mkdirSync(join(checkout, 'evidence'), { recursive: true });
    const agit = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    agit('init', '-q'); agit('config', 'user.name', 'Wave Attempt'); agit('config', 'user.email', 'wave@example.invalid');
    writeFileSync(join(checkout, 'source.js'), `export const value = '${attempt_id}';\n`);
    writeFileSync(join(checkout, 'evidence/check.txt'), `${attempt_id} local check result\n`);
    agit('add', '.'); agit('commit', '-qm', `Wave attempt ${attempt_id}`);
    const base_commit = agit('rev-parse', 'HEAD');
    const wave_bindings = { wave_id: 'wave-1', generation: 1, step_number: 1, attempt_id, phase: 'implementing',
      target: 'repo', backend: 'overlayfs', base_commit };
    const r = { id, completion_contract: 1, step: join(f.pkg, 'step-001-subspec.md'), package: f.pkg, primary: f.root,
      checkout, state: 'running', started_at, wave_bindings };
    writeFileSync(join(f.pkg, 'runtime/runs', `${id}.json`), JSON.stringify(r));
    const receipt = recordVerification(r, `node ${attempt_id}-check.js`, revision(r), revision(r),
      { exit_code: 0, full_output_path: join(checkout, 'evidence/check.txt') });
    const input = { outcome: 'as-specified', strategy: 'implementation-first', decisions, gaps: [], findings: [],
      introduced: [{ symbol: 'value', path: 'source.js', purpose: `wave ${attempt_id} value` }],
      evidence: [{ id: 'EV-1', status: 'passed', receipt_id: receipt.id, artifact: 'repo:evidence/check.txt', proof_boundary: 'isolated wave attempt behavior only' }] };
    runs.push({ r, input, checkout, git: agit, base_commit, attempt_id });
  }
  return { ...f, runs };
}

// Spawn workers exactly as refreshProgress does: the fixed direct-exec helper under flock.
function refreshWorker(packagePath) {
  const lock = join(packagePath, 'runtime', 'progress.lock');
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['-x', lock, process.execPath, fileURLToPath(new URL('./completion.mjs', import.meta.url)), 'refresh-progress']);
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`refresh worker exited ${code}: ${err}`)));
    child.stdin.end(JSON.stringify({ package: packagePath }));
  });
}

test('structured handoff writes canonical learning and index without converting process exit into acceptance', async t => {
  const f = await fixture(t);
  assert.equal(completionStatus(f.r).status, 'handoff_incomplete');
  const saved = submitCompletion(f.r, f.input);
  assert.equal(saved.status, 'recorded'); assert.match(saved.acceptance, /review/);
  assert.match(readFileSync(saved.learning_path, 'utf8'), /learning:\n  version: 2/);
  const ledger = await refreshProgress(f.pkg);
  assert.equal(ledger.runs[0].execution, 'running'); assert.equal(ledger.runs[0].handoff.status, 'recorded');
  const index = JSON.parse(readFileSync(join(f.pkg, 'history-index.json')));
  assert.equal(index.records[0].kind, 'learning'); assert.match(index.records[0].introduced, /value/);
  submitCompletion(f.r, f.input); // Repeat after an interrupted return doesn't create another record.
  assert.equal(verificationReceipts(f.r).length, 1);
});

test('verification summaries preserve execution facts and populate learning without timestamp transcription', async t => {
  const f = await fixture(t), before = revision(f.r);
  const receipt = recordVerification(f.r, 'mise exec -- mix test focused.exs', before, before,
    { exit_code: 0, full_output_path: f.evidence }, { started_at: '2026-10-08T13:20:00.000Z', elapsed_ms: 3700 });
  const markdown = readFileSync(receipt.summary_artifact, 'utf8');
  const facts = JSON.parse(markdown.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(facts.started_at, '2026-10-08T13:20:00.000Z');
  assert.equal(facts.elapsed_ms, 3700);
  assert.equal(facts.exit_code, 0);
  assert.equal(facts.observed_at, receipt.observed_at);
  assert.equal(facts.before.commit, before.commit);
  assert.equal(facts.artifact, f.evidence);
  const input = { ...f.input, evidence: [{ ...f.input.evidence[0], receipt_id: receipt.id, artifact: receipt.summary_artifact }] };
  const result = submitCompletion(f.r, input);
  assert.match(readFileSync(result.learning_path, 'utf8'), /elapsed_ms: 3700/);
  assert.match(result.acceptance, /independent review/);
  const failed = recordVerification(f.r, 'false', before, before, { exit_code: 1 });
  assert.equal(failed.elapsed_ms, null, 'legacy timing stays unknown');
  assert.throws(() => submitCompletion(f.r, { ...input, evidence: [{ ...input.evidence[0], receipt_id: failed.id, artifact: failed.summary_artifact }] }), /failed receipt/);
});

test('evidence logs, failed receipts, omitted gates and changed HEAD cannot masquerade as completed handoff', async t => {
  const f = await fixture(t);
  mkdirSync(join(f.pkg, 'learnings')); writeFileSync(join(f.pkg, 'learnings/step-001-learning.md'), 'Canonical learning: evidence/check.txt');
  assert.equal(completionStatus(f.r).status, 'handoff_incomplete');
  assert.throws(() => submitCompletion(f.r, { ...f.input, evidence: [] }), /exactly/);
  const failure = recordVerification(f.r, 'false', revision(f.r), revision(f.r), { exit_code: 1 });
  assert.throws(() => submitCompletion(f.r, { ...f.input, evidence: [{ ...f.input.evidence[0], receipt_id: failure.id }] }), /failed receipt/);
  submitCompletion(f.r, f.input);
  writeFileSync(join(f.root, 'source.js'), 'export const value = 2;\n');
  assert.equal(completionStatus(f.r, { checkHead: true }).status, 'handoff_incomplete');
  f.git('add', 'source.js'); f.git('commit', '-qm', 'Change fixture');
  assert.throws(() => submitCompletion(f.r, f.input), /applicability/);
  assert.equal(submitCompletion(f.r, { ...f.input, evidence: [{ ...f.input.evidence[0], applicability: 'Earlier focused evidence covers the unchanged contract; later change is constant-only.' }] }).status, 'recorded');
});

test('checkpoint records missing evidence honestly and rejects escaped or symlinked artifacts', async t => {
  const f = await fixture(t);
  const input = { ...f.input, outcome: 'checkpoint', gaps: ['Required behavior unfinished'], evidence: [{ id: 'EV-1', status: 'pending', proof_boundary: 'not run' }] };
  assert.equal(submitCompletion(f.r, input).outcome, 'checkpoint');
  assert.throws(() => submitCompletion(f.r, { ...input, outcome: 'as-specified' }), /gaps/);
  assert.throws(() => submitCompletion(f.r, { ...f.input, evidence: [{ ...f.input.evidence[0], artifact: '/tmp/escape' }] }), /canonical root/);
  rmSync(join(f.pkg, 'learnings'), { recursive: true }); symlinkSync(f.root, join(f.pkg, 'learnings'));
  assert.throws(() => submitCompletion(f.r, f.input), /Symlink/);
});

// Run alone: node --test --test-name-pattern='checkpoint routing' pi/extensions/spec-runtime/completion.test.mjs
test('checkpoint routing retains legacy receipts and exposes concrete remaining action without completion repetition', async t => {
  const f = await fixture(t);
  const input = { ...f.input, outcome: 'checkpoint', gaps: ['Seed the authenticated fixture before EV-1'],
    evidence: [{ id: 'EV-1', status: 'pending', proof_boundary: 'browser check unattempted' }] };
  let status = submitCompletion(f.r, input);
  assert.equal(status.checkpoint_reason, null);
  assert.equal(status.next_action, 'Seed the authenticated fixture before EV-1');
  assert.equal(verificationReceipts(f.r).length, 1);
  assert.equal(completionStatus(f.r).status, 'recorded');
  const remaining = ['Seed authenticated fixture, then run EV-1 and observe destination'];
  status = submitCompletion(f.r, { ...input, checkpoint_reason: 'blocker', remaining_work: remaining });
  assert.deepEqual(status.remaining_work, remaining);
  assert.equal(status.checkpoint_reason, 'blocker');
  assert.match(reminder(f.r), /Remaining action: Seed authenticated fixture/);
  assert.doesNotMatch(reminder(f.r), /Before ending this assignment/);
  const ledger = await refreshProgress(f.pkg);
  assert.deepEqual(ledger.runs[0].handoff.remaining_work, remaining);
  assert.throws(() => submitCompletion(f.r, { ...input, checkpoint_reason: 'unattempted', remaining_work: remaining }), /Unknown checkpoint_reason/);
  assert.throws(() => submitCompletion(f.r, { ...input, checkpoint_reason: 'deadline' }), /concrete remaining_work/);
  assert.throws(() => submitCompletion(f.r, { ...f.input, checkpoint_reason: 'blocker', remaining_work: remaining }), /Completed outcomes/);
  assert.equal(submitCompletion(f.r, { ...input, outcome: 'decision-required', checkpoint_reason: 'decision', remaining_work: remaining }).checkpoint_reason, 'decision');
});

test('progress watcher failure is reported and disposed without crashing the host', async t => {
  const f = await fixture(t), watchers = [], errors = [];
  const close = watchProgress(f.pkg, error => errors.push(error), () => {}, {
    watchDirectory: () => {
      const watcher = new EventEmitter();
      watcher.closed = false;
      watcher.close = () => { watcher.closed = true; };
      watchers.push(watcher);
      return watcher;
    },
  });
  t.after(close);
  const error = Object.assign(new Error('too many open files'), { code: 'EMFILE' });
  assert.doesNotThrow(() => watchers[0].emit('error', error));
  assert.equal(watchers[0].closed, true);
  assert.deepEqual(errors, [error]);
  await close();
  assert.ok(watchers.every(watcher => watcher.closed));
});

test('review arrival refreshes index and progress without a model request or acceptance claim', async t => {
  const f = await fixture(t);
  const errors = []; const close = watchProgress(f.pkg, e => errors.push(e)); t.after(close);
  mkdirSync(join(f.pkg, 'reviews'));
  writeFileSync(join(f.pkg, 'reviews/step-001-review.md'), '```yaml\nreview:\n  verdict: needs-fix\n```\n');
  const deadline = Date.now() + 2500;
  let ledger;
  while (Date.now() < deadline) {
    try { ledger = JSON.parse(readFileSync(join(f.pkg, 'runtime/progress.json'))); } catch {}
    if (ledger?.artifacts.some(a => a.kind === 'review')) break;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.deepEqual(errors, []); assert.equal(ledger.artifacts.find(a => a.kind === 'review').assessment, 'inspect source; presence is not approval');
});

test('compacted owner context receives one current reminder without persistent messages or extra turns', async t => {
  const f = await fixture(t), handlers = {};
  const pi = { on: (event, fn) => { handlers[event] = fn; } };
  installProgressContext(pi, { record: f.r, role: 'owner' });
  const first = handlers.context({ messages: [{ role: 'user', content: 'Compacted context' }] });
  assert.match(first.messages.at(-1).content, /spec_complete submission/);
  submitCompletion(f.r, f.input);
  const second = handlers.context({ messages: first.messages });
  assert.equal(second.messages.filter(m => m.customType === 'spec-obligations').length, 1);
  assert.match(second.messages.at(-1).content, /Handoff: recorded/);
});

test('coordinator decisions survive reconstruction while artifact presence is never review approval', async t => {
  const f = await fixture(t);
  recordCheckpoint(f.pkg, { stage: 'implementation', status: 'running', next: 'Finish step 1', decisions: [], artifacts: ['spec.md'] });
  const ledger = await refreshProgress(f.pkg);
  assert.equal(ledger.stages[0].next, 'Finish step 1');
  assert.throws(() => recordCheckpoint(f.pkg, { stage: 'implementation', status: 'complete', next: 'Publish', decisions: [], artifacts: ['spec.md'] }), /Unfinished/);
  assert.throws(() => recordCheckpoint(f.pkg, { stage: 'publication', status: 'complete', next: 'Done', decisions: [], artifacts: [] }), /actual artifacts/);
});

// Run alone: node --test --test-name-pattern='unattempted prepared steps' pi/extensions/spec-runtime/completion.test.mjs
test('unattempted prepared steps prevent implementation and publication completion', async t => {
  const f = await fixture(t);
  submitCompletion(f.r, f.input);
  writeFileSync(join(f.pkg, 'runtime/runs/attempt-1.json'), JSON.stringify({ ...f.r, state: 'completed' }));
  writeFileSync(join(f.pkg, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1 }, { step: 2 }] }));
  await refreshProgress(f.pkg);
  for (const stage of ['implementation', 'publication']) {
    assert.throws(() => recordCheckpoint(f.pkg, { stage, status: 'complete', next: 'Done', decisions: [], artifacts: ['spec.md'] }), /Unfinished prepared steps: 2/);
  }
});


test('coordinator session binding survives compaction and restores next action without a model wake', async t => {
  const f = await fixture(t), handlers = {}, persisted = [];
  const pi = { on: (event, fn) => { handlers[event] = fn; }, appendEntry: (customType, data) => persisted.push({ type: 'custom', customType, data }) };
  const hooks = installProgressContext(pi);
  hooks.attach(f.pkg);
  recordCheckpoint(f.pkg, { stage: 'implementation', status: 'running', next: 'Resolve the saved handoff gap', decisions: [], artifacts: ['spec.md'] });
  await refreshProgress(f.pkg);
  await handlers.session_shutdown();
  installProgressContext(pi);
  handlers.session_start({}, { sessionManager: { getBranch: () => persisted } });
  const reminder = handlers.context({ messages: [{ role: 'user', content: 'summary after compaction' }] });
  assert.match(reminder.messages.at(-1).content, /Resolve the saved handoff gap/);
  assert.equal(persisted.length, 1);
  await handlers.session_shutdown();
});

test('skill stage aliases retain completion guards while draft publication remains a checkpoint', async t => {
  const f = await fixture(t);
  await refreshProgress(f.pkg);
  for (const stage of ['spec-run', 'spec-step-run', 'spec-pr']) {
    assert.throws(() => recordCheckpoint(f.pkg, { stage, status: 'complete', next: 'Continue', decisions: [], artifacts: ['spec.md'] }), /Unfinished/);
  }
  assert.equal(recordCheckpoint(f.pkg, { stage: 'publication-draft', status: 'complete', next: 'Wait for review and CI', decisions: [], artifacts: ['spec.md'] }).stage, 'publication-draft');
  assert.equal(recordCheckpoint(f.pkg, { stage: 'spec-run', status: 'running', next: 'Finish', decisions: [], artifacts: ['spec.md'] }).stage, 'implementation');
});

test('artifact references accept canonical package forms and reject escapes or future evidence', async t => {
  const f = await fixture(t);
  for (const path of ['spec.md', '.specs/feature/spec.md', join(f.pkg, 'spec.md')]) {
    assert.equal(recordCheckpoint(f.pkg, { stage: 'preparation', status: 'complete', next: 'Implement', decisions: [], artifacts: [path] }).status, 'complete');
  }
  for (const artifact of ['evidence/check.txt', '.specs/feature/evidence/check.txt', f.evidence]) {
    assert.equal(submitCompletion(f.r, { ...f.input, evidence: [{ ...f.input.evidence[0], artifact }] }).status, 'recorded');
  }
  mkdirSync(join(f.root, 'evidence')); writeFileSync(join(f.root, 'evidence/check.txt'), 'different checkout artifact');
  assert.throws(() => submitCompletion(f.r, { ...f.input, evidence: [{ ...f.input.evidence[0], artifact: 'evidence/check.txt' }] }), /Ambiguous evidence/);
  // <repo id>:<path> resolves in that target's worktree even where the bare relative path is ambiguous.
  assert.equal(submitCompletion(f.r, { ...f.input, evidence: [{ ...f.input.evidence[0], artifact: 'repo:evidence/check.txt' }] }).status, 'recorded');
  assert.throws(() => submitCompletion(f.r, { ...f.input, evidence: [{ ...f.input.evidence[0], artifact: 'repo:evidence/future.txt' }] }), /actual evidence or report pending/);
  assert.throws(() => submitCompletion(f.r, { ...f.input, evidence: [{ ...f.input.evidence[0], artifact: 'repo:../outside.txt' }] }), /canonical root/);
  assert.throws(() => recordCheckpoint(f.pkg, { stage: 'preparation', status: 'running', next: 'Implement', decisions: [], artifacts: ['.specs/other/spec.md'] }), /does not name a file of this package/);
  assert.throws(() => recordCheckpoint(f.pkg, { stage: 'preparation', status: 'running', next: 'Implement', decisions: [], artifacts: ['../outside.md'] }), /canonical root/);
  assert.throws(() => recordCheckpoint(f.pkg, { stage: 'preparation', status: 'running', next: 'Implement', decisions: [], artifacts: ['runtime/future-editor.jsonl'] }), /existing artifact/);
  assert.throws(() => submitCompletion(f.r, { ...f.input, evidence: [{ ...f.input.evidence[0], artifact: 'evidence/future.txt' }] }), /actual evidence or report pending/);
});

test('new human input marks stale stage decisions for reconciliation after resume without releasing holds', async t => {
  const f = await fixture(t), handlers = {}, persisted = [];
  const pi = { on: (event, fn) => { handlers[event] = fn; }, appendEntry: (customType, data) => persisted.push({ type: 'custom', customType, data }) };
  const hooks = installProgressContext(pi); hooks.attach(f.pkg);
  recordCheckpoint(f.pkg, { stage: 'implementation', status: 'blocked', next: 'Await human decision', decisions: ['Hold implementation'], artifacts: ['spec.md'] });
  await refreshProgress(f.pkg);
  handlers.input({ type: 'input', source: 'interactive', text: 'Here is more context' });
  const inputRecords = persisted.filter(entry => entry.customType === 'spec-progress-input');
  handlers.input({ type: 'input', source: 'extension', text: 'Automated follow-up' });
  handlers.input({ type: 'input', source: 'tool', text: 'Tool output' });
  assert.equal(persisted.filter(entry => entry.customType === 'spec-progress-input').length, inputRecords.length);
  const context = () => handlers.context({ messages: [] }).messages.at(-1).content;
  assert.match(context(), /implementation=blocked.*recorded before latest user input/);
  assert.match(context(), /holds remain until explicitly resolved/);
  await handlers.session_shutdown();
  installProgressContext(pi); handlers.session_start({}, { sessionManager: { getBranch: () => persisted } });
  assert.match(context(), /recorded before latest user input/);
  const recorded = JSON.parse(readFileSync(join(f.pkg, 'runtime/stages/implementation.json')));
  assert.equal(recorded.status, 'blocked'); assert.deepEqual(recorded.decisions, ['Hold implementation']);
  await handlers.session_shutdown();
});

test('progress reconciles historical stage aliases by newest checkpoint and retains latest hold', async t => {
  const f = await fixture(t);
  const directory = join(f.pkg, 'runtime/stages'); mkdirSync(directory);
  const checkpoint = { status: 'complete', next: 'Continue', artifacts: ['spec.md'], decisions: [] };
  writeFileSync(join(directory, 'spec-run.json'), JSON.stringify({ ...checkpoint, stage: 'spec-run', recorded_at: '2026-01-01T00:00:00Z' }));
  writeFileSync(join(directory, 'implementation.json'), JSON.stringify({ ...checkpoint, stage: 'implementation', status: 'blocked', next: 'Hold for decision', recorded_at: '2026-01-02T00:00:00Z' }));
  let progress = await refreshProgress(f.pkg);
  assert.equal(progress.stages.length, 1);
  assert.equal(progress.stages[0].stage, 'implementation');
  assert.equal(progress.stages[0].status, 'blocked');
  writeFileSync(join(directory, 'spec-run.json'), JSON.stringify({ ...checkpoint, stage: 'spec-run', status: 'running', next: 'Explicitly resume', recorded_at: '2026-01-03T00:00:00Z' }));
  progress = await refreshProgress(f.pkg);
  assert.equal(progress.stages.length, 1);
  assert.equal(progress.stages[0].next, 'Explicitly resume');
  assert.equal(recordCheckpoint(f.pkg, { ...checkpoint, stage: 'spec-write' }).stage, 'preparation');
});

test('session restore clears input and package bindings from the previous branch', async t => {
  const f = await fixture(t), handlers = {}, entries = [];
  const pi = { on: (event, fn) => { handlers[event] = fn; }, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) };
  const hooks = installProgressContext(pi); hooks.attach(f.pkg);
  recordCheckpoint(f.pkg, { stage: 'preparation', status: 'blocked', next: 'Await decision', decisions: [], artifacts: ['spec.md'] });
  await refreshProgress(f.pkg);
  handlers.input({ source: 'rpc', text: 'A new direction' });
  assert.match(handlers.context({ messages: [] }).messages[0].content, /recorded before latest user input/);
  const binding = entries.filter(entry => entry.customType === 'spec-progress-binding');
  handlers.session_start({}, { sessionManager: { getBranch: () => binding } });
  assert.doesNotMatch(handlers.context({ messages: [] }).messages[0].content, /recorded before latest user input/);
  handlers.session_tree({}, { sessionManager: { getBranch: () => [] } });
  assert.equal(handlers.context({ messages: [] }), undefined);
  await handlers.session_shutdown();
});

// Run alone: node --test --test-name-pattern='^wave runtime:' pi/extensions/spec-runtime/completion.test.mjs
test('wave runtime: concurrent same-step attempts retain immutable per-run learning while the canonical pointer stays deterministic', async t => {
  const w = await waveRuns(t, [
    { id: 'wave-a', attempt_id: 'attempt-a', started_at: '2026-01-01T00:00:00.000Z', decisions: ['Attempt a keeps its own learning.'] },
    { id: 'wave-b', attempt_id: 'attempt-b', started_at: '2026-01-02T00:00:00.000Z', decisions: ['Attempt b keeps its own learning.'] },
  ]);
  const [a, b] = w.runs;
  assert.equal(submitCompletion(a.r, a.input).status, 'recorded');
  assert.equal(submitCompletion(b.r, b.input).status, 'recorded');
  const aLearning = join(w.pkg, 'runtime/runs', `${a.r.id}-learning.md`);
  const bLearning = join(w.pkg, 'runtime/runs', `${b.r.id}-learning.md`);
  assert.match(readFileSync(aLearning, 'utf8'), /Attempt a keeps its own learning/);
  assert.match(readFileSync(bLearning, 'utf8'), /Attempt b keeps its own learning/);
  assert.equal(completionStatus(a.r).status, 'recorded');
  assert.equal(completionStatus(b.r).status, 'recorded');
  await refreshProgress(w.pkg);
  const canonical = join(w.pkg, 'learnings', 'step-001-learning.md');
  assert.equal(readFileSync(canonical, 'utf8'), readFileSync(bLearning, 'utf8'));
  await refreshProgress(w.pkg);
  assert.equal(readFileSync(canonical, 'utf8'), readFileSync(bLearning, 'utf8'));
  assert.match(readFileSync(aLearning, 'utf8'), /Attempt a keeps its own learning/, 'earlier attempt learning is immutable');
});

test('wave runtime: concurrent cross-process refresh workers produce both run entries without corrupting history or the ledger', async t => {
  const w = await waveRuns(t, [
    { id: 'wave-a', attempt_id: 'attempt-a', started_at: '2026-01-01T00:00:00.000Z' },
    { id: 'wave-b', attempt_id: 'attempt-b', started_at: '2026-01-02T00:00:00.000Z' },
  ]);
  for (const run of w.runs) submitCompletion(run.r, run.input);
  const ledgers = await Promise.all([refreshWorker(w.pkg), refreshWorker(w.pkg)]);
  for (const ledger of ledgers) {
    assert.deepEqual(ledger.runs.map(r => r.run_id).sort(), ['attempt-1', 'wave-a', 'wave-b']);
    assert.equal(ledger.runs.find(r => r.run_id === 'wave-a').wave.wave_id, 'wave-1');
    assert.equal(ledger.runs.find(r => r.run_id === 'wave-a').wave.attempt_id, 'attempt-a');
    assert.equal(ledger.runs.find(r => r.run_id === 'attempt-1').wave, null);
  }
  const progress = JSON.parse(readFileSync(join(w.pkg, 'runtime/progress.json'), 'utf8'));
  assert.equal(progress.runs.length, 3);
  const index = JSON.parse(readFileSync(join(w.pkg, 'history-index.json'), 'utf8'));
  assert.ok(Array.isArray(index.records));
  for (const run of w.runs) assert.match(readFileSync(join(w.pkg, 'runtime/runs', `${run.r.id}-learning.md`), 'utf8'), /learning:/);
});

test('wave runtime: worker target artifacts resolve the attempt checkout and reject a foreign target', async t => {
  const w = await waveRuns(t, [{ id: 'wave-a', attempt_id: 'attempt-a', started_at: '2026-01-01T00:00:00.000Z' }]);
  const [a] = w.runs;
  // The canonical integration worktree lacks the wave-relative evidence; only the attempt checkout has it.
  assert.equal(existsSync(join(w.root, 'evidence/check.txt')), false);
  assert.equal(submitCompletion(a.r, a.input).status, 'recorded');
  assert.throws(() => submitCompletion(a.r, { ...a.input, evidence: [{ ...a.input.evidence[0], artifact: 'other:evidence/check.txt' }] }), /foreign target/);
});

test('wave runtime: a drained overlay is checked via the same-run revision receipt, and forged or missing provenance fails', async t => {
  const w = await waveRuns(t, [{ id: 'wave-a', attempt_id: 'attempt-a', started_at: '2026-01-01T00:00:00.000Z' }]);
  const [a] = w.runs;
  assert.equal(submitCompletion(a.r, a.input).status, 'recorded');
  const receiptFile = join(w.pkg, 'runtime/runs', `${a.r.id}-revision.json`);
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  assert.equal(receipt.run_id, a.r.id);
  assert.equal(receipt.wave_id, 'wave-1');
  assert.equal(receipt.attempt_id, 'attempt-a');
  assert.equal(receipt.target, 'repo');
  assert.equal(receipt.commit, a.base_commit);
  // Confirmed drain: the overlay is gone and the outside checkout is unmounted/empty.
  rmSync(a.checkout, { recursive: true, force: true });
  a.r.phase_drain = { status: 'confirmed' };
  assert.equal(completionStatus(a.r, { checkHead: true }).status, 'recorded');
  writeFileSync(receiptFile, JSON.stringify({ ...receipt, wave_id: 'wave-forged' }));
  assert.equal(completionStatus(a.r, { checkHead: true }).status, 'handoff_incomplete');
  writeFileSync(receiptFile, JSON.stringify({ ...receipt, commit: '0'.repeat(40) }));
  assert.equal(completionStatus(a.r, { checkHead: true }).status, 'handoff_incomplete');
  rmSync(receiptFile);
  assert.equal(completionStatus(a.r, { checkHead: true }).status, 'handoff_incomplete');
});

for (const proof of ['valid', 'missing', 'mismatched']) {
  test(`wave runtime: Runtime finish and refresh reject invalid revision proof (${proof})`, async t => {
    const { Runtime } = await import('./runtime.mjs');
    const w = await waveRuns(t, [{ id: 'wave-a', attempt_id: 'attempt-a', started_at: '2026-01-01T00:00:00.000Z' }]);
    const [a] = w.runs;
    assert.equal(submitCompletion(a.r, a.input).status, 'recorded');
    const receiptFile = join(w.pkg, 'runtime/runs', `${a.r.id}-revision.json`);
    if (proof === 'missing') rmSync(receiptFile);
    if (proof === 'mismatched') {
      const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
      writeFileSync(receiptFile, JSON.stringify({ ...receipt, commit: '0'.repeat(40) }));
    }
    // No outside Git checkout remains after the contained service drains.
    rmSync(a.checkout, { recursive: true, force: true });
    const runtime = new Runtime();
    runtime.drainContainedService = async () => {
      a.r.phase_drain = { status: 'confirmed' };
      return a.r.phase_drain;
    };
    await runtime.finish(a.r, { result: 'Done' });
    const expected = proof === 'valid' ? 'recorded' : 'handoff_incomplete';
    const saved = JSON.parse(readFileSync(join(w.pkg, 'runtime/runs', `${a.r.id}.json`), 'utf8'));
    assert.equal(saved.handoff.status, expected);
    const progress = await refreshProgress(w.pkg);
    assert.equal(progress.runs.find(run => run.run_id === a.r.id).handoff.status, expected);
    assert.equal(existsSync(join(w.pkg, 'learnings/step-001-learning.md')), proof === 'valid');
  });
}
