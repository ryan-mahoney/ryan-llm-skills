import test from 'node:test';
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
