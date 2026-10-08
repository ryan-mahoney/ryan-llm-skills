import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { submitCompletion, completionStatus, recordVerification, verificationReceipts, revision, refreshProgress, recordCheckpoint, installProgressContext, watchProgress } from './completion.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'completion-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.specs/\n'); writeFileSync(join(root, 'source.js'), 'export const value = 1;\n');
  git('add', '.'); git('commit', '-qm', 'Fixture');
  const pkg = join(root, '.specs/feature'); mkdirSync(join(pkg, 'runtime/runs'), { recursive: true });
  mkdirSync(join(pkg, 'evidence')); writeFileSync(join(pkg, 'spec.md'), '# Spec');
  const gate = { id: 'EV-1', ownerStep: 1, required: true, phase: 'merge', rejects: ['FH-1'], artifact: '.specs/feature/evidence/check.txt' };
  writeFileSync(join(pkg, 'evidence-plan.json'), JSON.stringify({ gates: [gate] }));
  const r = { id: 'attempt-1', completion_contract: 1, step: join(pkg, 'step-001-subspec.md'), package: pkg, primary: root, checkout: root, state: 'running' };
  writeFileSync(join(pkg, 'runtime/runs/attempt-1.json'), JSON.stringify(r));
  const evidence = join(pkg, 'evidence/check.txt'); writeFileSync(evidence, 'observed check result\n');
  const receipt = recordVerification(r, 'node focused-check.js', revision(r), revision(r), { exit_code: 0, full_output_path: evidence });
  const input = { outcome: 'as-specified', strategy: 'implementation-first', decisions: ['Preserve existing caller contract.'], gaps: [], findings: [], introduced: [{ symbol: 'value', path: 'source.js', purpose: 'shared fixture value' }],
    evidence: [{ id: 'EV-1', status: 'passed', receipt_id: receipt.id, proof_boundary: 'isolated focused behavior only' }] };
  return { root, pkg, git, r, input, evidence };
}

test('structured handoff writes canonical learning and index without converting process exit into acceptance', async t => {
  const f = fixture(t);
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

test('verification summaries preserve execution facts and populate learning without timestamp transcription', t => {
  const f = fixture(t), before = revision(f.r);
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

test('evidence logs, failed receipts, omitted gates and changed HEAD cannot masquerade as completed handoff', t => {
  const f = fixture(t);
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

test('checkpoint records missing evidence honestly and rejects escaped or symlinked artifacts', t => {
  const f = fixture(t);
  const input = { ...f.input, outcome: 'checkpoint', gaps: ['Required behavior unfinished'], evidence: [{ id: 'EV-1', status: 'pending', proof_boundary: 'not run' }] };
  assert.equal(submitCompletion(f.r, input).outcome, 'checkpoint');
  assert.throws(() => submitCompletion(f.r, { ...input, outcome: 'as-specified' }), /gaps/);
  assert.throws(() => submitCompletion(f.r, { ...f.input, evidence: [{ ...f.input.evidence[0], artifact: '/tmp/escape' }] }), /canonical root/);
  rmSync(join(f.pkg, 'learnings'), { recursive: true }); symlinkSync(f.root, join(f.pkg, 'learnings'));
  assert.throws(() => submitCompletion(f.r, f.input), /Symlink/);
});

test('progress watcher failure is reported and disposed without crashing the host', async t => {
  const f = fixture(t), watchers = [], errors = [];
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
  const f = fixture(t);
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

test('compacted owner context receives one current reminder without persistent messages or extra turns', t => {
  const f = fixture(t), handlers = {};
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
  const f = fixture(t);
  recordCheckpoint(f.pkg, { stage: 'implementation', status: 'running', next: 'Finish step 1', decisions: [], artifacts: ['spec.md'] });
  const ledger = await refreshProgress(f.pkg);
  assert.equal(ledger.stages[0].next, 'Finish step 1');
  assert.throws(() => recordCheckpoint(f.pkg, { stage: 'implementation', status: 'complete', next: 'Publish', decisions: [], artifacts: ['spec.md'] }), /Unfinished/);
  assert.throws(() => recordCheckpoint(f.pkg, { stage: 'publication', status: 'complete', next: 'Done', decisions: [], artifacts: [] }), /actual artifacts/);
});


test('coordinator session binding survives compaction and restores next action without a model wake', async t => {
  const f = fixture(t), handlers = {}, persisted = [];
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
  const f = fixture(t);
  await refreshProgress(f.pkg);
  for (const stage of ['spec-run', 'spec-step-run', 'spec-pr']) {
    assert.throws(() => recordCheckpoint(f.pkg, { stage, status: 'complete', next: 'Continue', decisions: [], artifacts: ['spec.md'] }), /Unfinished/);
  }
  assert.equal(recordCheckpoint(f.pkg, { stage: 'publication-draft', status: 'complete', next: 'Wait for review and CI', decisions: [], artifacts: ['spec.md'] }).stage, 'publication-draft');
  assert.equal(recordCheckpoint(f.pkg, { stage: 'spec-run', status: 'running', next: 'Finish', decisions: [], artifacts: ['spec.md'] }).stage, 'implementation');
});

test('artifact references accept canonical package forms and reject escapes or future evidence', t => {
  const f = fixture(t);
  for (const path of ['spec.md', '.specs/feature/spec.md', join(f.pkg, 'spec.md')]) {
    assert.equal(recordCheckpoint(f.pkg, { stage: 'preparation', status: 'complete', next: 'Implement', decisions: [], artifacts: [path] }).status, 'complete');
  }
  for (const artifact of ['evidence/check.txt', '.specs/feature/evidence/check.txt', f.evidence]) {
    assert.equal(submitCompletion(f.r, { ...f.input, evidence: [{ ...f.input.evidence[0], artifact }] }).status, 'recorded');
  }
  mkdirSync(join(f.root, 'evidence')); writeFileSync(join(f.root, 'evidence/check.txt'), 'different checkout artifact');
  assert.throws(() => submitCompletion(f.r, { ...f.input, evidence: [{ ...f.input.evidence[0], artifact: 'evidence/check.txt' }] }), /Ambiguous evidence/);
  assert.throws(() => recordCheckpoint(f.pkg, { stage: 'preparation', status: 'running', next: 'Implement', decisions: [], artifacts: ['../outside.md'] }), /canonical root/);
  assert.throws(() => recordCheckpoint(f.pkg, { stage: 'preparation', status: 'running', next: 'Implement', decisions: [], artifacts: ['runtime/future-editor.jsonl'] }), /existing artifact/);
  assert.throws(() => submitCompletion(f.r, { ...f.input, evidence: [{ ...f.input.evidence[0], artifact: 'evidence/future.txt' }] }), /actual evidence or report pending/);
});

test('new human input marks stale stage decisions for reconciliation after resume without releasing holds', async t => {
  const f = fixture(t), handlers = {}, persisted = [];
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
  const f = fixture(t);
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
  const f = fixture(t), handlers = {}, entries = [];
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
