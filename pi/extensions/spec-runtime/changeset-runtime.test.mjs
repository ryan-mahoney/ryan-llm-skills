// node --test pi/extensions/spec-runtime/changeset-runtime.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runManagedChangeset, writerClient, CHANGESET_ROUTE } from './changeset-runtime.mjs';
import { roleContract, verifyPublishedCommit } from './runtime.mjs';
import { hash } from '../../../scripts/changeset/workspace.mjs';
import { sourceCommand } from './source-commands.mjs';
import { changesetMetrics } from '../../../scripts/changeset/metrics.mjs';
import { stagedGenerator } from './changeset-generator.mjs';
import { execFileSync } from 'node:child_process';
import { prepareReviewCheckout, removeReviewCheckout } from './review-checkout.mjs';
import { serialFixContext } from './decision-stage.mjs';
import { renderReviewMarkdown, renderFixMarkdown } from './wave-review.mjs';
import { buildHistoryIndex } from '../../../skills/spec-run/scripts/build-history-index.mjs';
import { completionStatus } from './completion.mjs';

function fixture(t, stage) {
  const dir = mkdtempSync(join(tmpdir(), 'changeset-runtime-')), checkout = join(dir, 'repo'), packageDir = join(dir, 'package');
  mkdirSync(checkout); mkdirSync(join(packageDir, 'runtime/runs'), { recursive: true });
  writeFileSync(join(checkout, 'value.mjs'), 'export const value = 1;\n// existing dirty change\n');
  writeFileSync(join(checkout, 'untouched.bin'), Buffer.from([0, 255]));
  symlinkSync('untouched.bin', join(checkout, 'unrelated-link'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record = { id: 'test-run', package: packageDir, checkout, package_ref: 'workspace/example',
    owner_model: 'fixture/default:low', planner_model: 'fixture/strong:high', strong_owner_model: 'fixture/strong:high',
    editor_model: 'fixture/writer:off', writing_route: CHANGESET_ROUTE, ...(stage ? { stage: { role: stage } } : {}) };
  const plan = { schema_version: 1, operations: [{ id: 'value', executor: 'simple', reads: [], writes: ['value.mjs'], depends_on: [],
    objective: 'Update value', instruction: 'Change value to 2.', requirements: ['Preserve the existing comment'],
    context: [{ path: 'value.mjs', start: null, end: null }] }] };
  const createClient = async selector => ({ selector, calls: 0,
    text: async () => '*** Begin Patch\n*** Update File: value.mjs\n@@\n-export const value = 1;\n+export const value = 2;\n*** End Patch',
    json: async () => ({ edits: [{ kind: 'replace', path: 'value.mjs', search: 'value = 1', text: 'value = 2' }] }) });
  return { dir, record, plan, createClient, assertActive: () => {}, source: () => readFileSync(join(checkout, 'value.mjs'), 'utf8') };
}

test('default owner and review fixer use strong planning and preserve actual dirty source', async t => {
  for (const stage of [undefined, 'fixer']) {
    const f = fixture(t, stage), selectors = [];
    const result = await runManagedChangeset(f.record, 'Update value', undefined, { ...f,
      plan: async ({ trace }) => { selectors.push(trace.summary.planner_model); return { plan: f.plan }; } });
    assert.equal(result.publication, 'published');
    assert.deepEqual(selectors, ['fixture/strong:high']);
    assert.equal(f.record.owner_model, 'fixture/default:low');
    assert.equal(f.source(), 'export const value = 2;\n// existing dirty change\n');
    const summary = JSON.parse(readFileSync(result.full_result_path, 'utf8'));
    assert.equal(summary.status, 'applied');
    assert.equal(summary.stage, stage ?? 'implementation');
    assert.equal(summary.stage_kind, stage ?? 'implementation');
    assert.ok(summary.execution_ms >= 0);
    const events = readFileSync(join(f.record.package, 'runtime/runs', `${f.record.id}-edits`, result.edit_id, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
    assert.ok(events.some(event => event.event === 'publication_finished'));
    assert.ok(!JSON.stringify(events).includes('existing dirty change'));
  }
});

test('strong owner submits its own plan without a second planner and forged owner submission fails', async t => {
  const f = fixture(t);
  await assert.rejects(runManagedChangeset(f.record, null, undefined, { ...f, submittedPlan: f.plan,
    submittedModel: f.record.owner_model }), /Only the bound strong-owner/);
  const result = await runManagedChangeset(f.record, null, undefined, { ...f, submittedPlan: f.plan,
    submittedModel: f.record.planner_model, plan: () => { throw new Error('Duplicate planning'); } });
  assert.equal(result.publication, 'published');
});

test('invalid planning receives one correction and never falls back to direct editing', async t => {
  const f = fixture(t), before = f.source(); let calls = 0, writers = 0;
  const result = await runManagedChangeset(f.record, 'Update value', undefined, { ...f,
    plan: async () => { calls++; return { plan: { schema_version: 1, operations: [] } }; },
    createClient: () => { writers++; throw new Error('Must not start writer'); } });
  assert.equal(calls, 2); assert.equal(writers, 0);
  assert.equal(result.publication, 'not-published'); assert.equal(f.source(), before);
  assert.equal(JSON.parse(readFileSync(result.full_result_path, 'utf8')).status, 'failed');
});

test('failed writer and cancelled edit publish no candidate and keep a diagnostic trace', async t => {
  for (const cancel of [false, true]) {
    const f = fixture(t), before = f.source(), controller = new AbortController();
    const result = await runManagedChangeset(f.record, null, controller.signal, { ...f, submittedPlan: f.plan,
      submittedModel: f.record.planner_model, createClient: async () => ({ text: async () => {
        if (cancel) controller.abort(); throw new Error('Provider unavailable');
      } }) });
    assert.equal(result.publication, 'not-published'); assert.equal(f.source(), before);
    assert.equal(JSON.parse(readFileSync(result.full_result_path, 'utf8')).status, cancel ? 'cancelled' : 'failed');
  }
});

test('stale input during model execution preserves the intervening change', async t => {
  const f = fixture(t), clients = await f.createClient(f.record.editor_model);
  const result = await runManagedChangeset(f.record, null, undefined, { ...f, submittedPlan: f.plan,
    submittedModel: f.record.planner_model, createClient: async () => ({ ...clients, text: async (...args) => {
      writeFileSync(join(f.record.checkout, 'value.mjs'), '// operator update\n');
      return clients.text(...args);
    } }) });
  assert.match(result.error, /Stale workspace/);
  assert.equal(f.source(), '// operator update\n');
  assert.equal(result.publication, 'not-published');
});

test('observer failure remains explicit without turning an applied edit into a retry', async t => {
  const f = fixture(t);
  const result = await runManagedChangeset(f.record, null, undefined, { ...f, submittedPlan: f.plan,
    submittedModel: f.record.planner_model, onEvent: () => { throw new Error('Observer unavailable'); } });
  assert.equal(result.publication, 'published');
  const summary = JSON.parse(readFileSync(result.full_result_path, 'utf8'));
  assert.ok(summary.observation_errors.length > 0);
});

test('writer receipts retain failed provider usage and metrics report missing costs as unknown', async t => {
  const f = fixture(t), identity = { id: 'fixture', provider: 'fixture', maxTokens: 1000 };
  const { createEditTrace } = await import('../../../scripts/changeset/telemetry.mjs');
  const dir = join(f.record.package, 'runtime/runs', `${f.record.id}-edits`, 'call-test');
  const trace = createEditTrace({ directory: dir, identity: { edit_id: 'call-test', run_id: f.record.id } });
  let calls = 0;
  const runtime = { getModel: () => identity, hasConfiguredAuth: () => true, completeSimple: async (_model, context, options) => {
    assert.equal(context.tools, undefined); assert.equal(options.maxRetries, 0);
    calls++;
    return calls === 1 ? { stopReason: 'error', errorMessage: 'Overloaded', content: [], usage: { input: 5, output: 0 } }
      : { stopReason: 'stop', content: [{ type: 'text', text: '{"edits":[]}' }], usage: { input: 8, output: 2, cost: { total: 0.01 } } };
  } };
  const client = await writerClient('fixture/fixture:off', { runtime, trace });
  await assert.rejects(client.json('System', { secret_source: 'private source' }, 'writer', { operation_id: 'value', writer_attempt: 0 }), /Overloaded/);
  await client.json('System', {}, 'writer', { operation_id: 'value', writer_attempt: 1 });
  trace.finish('failed');
  const report = await changesetMetrics(f.record.package);
  assert.equal(report.totals.writer_calls, 2);
  assert.equal(report.totals.known_cost_usd, 0.01);
  assert.equal(report.totals.unknown_cost_calls, 1);
  assert.equal(report.edits[0].models[0].failures, 1);
  assert.ok(!readFileSync(join(dir, 'events.jsonl'), 'utf8').includes('private source'));
});

test('new decision roles cannot access either provider write tools or shell and unsupported command hosts refuse', () => {
  for (const role of ['owner', 'fixer', 'reviewer', 'planner', 'decision']) {
    const contract = roleContract({ writing_route: CHANGESET_ROUTE }, role);
    for (const forbidden of ['bash', 'edit', 'write', 'exec_command', 'write_stdin', 'apply_patch'])
      assert.ok(![...contract.tools, ...contract.providerTools].includes(forbidden), `${role}: ${forbidden}`);
  }
  assert.throws(() => sourceCommand({}, 'touch source.mjs', { platform: 'darwin' }), /unrestricted fallback is prohibited/);
});

test('source generation stages declared inputs and publishes only its declared output without writer calls', async t => {
  const f = fixture(t);
  const script = "require('node:fs').writeFileSync('generated.mjs', 'export const generated = 3;\\n');\n";
  writeFileSync(join(f.record.checkout, 'generate.cjs'), script);
  const plan = { schema_version: 1, operations: [{ id: 'generated', executor: 'generated', reads: ['generate.cjs'],
    writes: ['generated.mjs'], depends_on: [], instruction: 'Run the existing generator', generator: { argv: [process.execPath, 'generate.cjs'] } }] };
  const generate = stagedGenerator(f.record, async (record, command) => {
    assert.notEqual(record.checkout, f.record.checkout);
    execFileSync('/bin/bash', ['-c', command], { cwd: record.checkout });
    return { exit_code: 0 };
  });
  const result = await runManagedChangeset(f.record, null, undefined, { ...f, submittedPlan: plan,
    submittedModel: f.record.planner_model, generate, createClient: () => { throw new Error('Unexpected model writing'); } });
  assert.equal(result.publication, 'published');
  assert.equal(readFileSync(join(f.record.checkout, 'generated.mjs'), 'utf8'), 'export const generated = 3;\n');
  assert.equal(readFileSync(join(f.record.checkout, 'generate.cjs'), 'utf8'), script);
});

test('strong plans cannot bypass editor authoring with deterministic source creation', async t => {
  const f = fixture(t), plan = { schema_version: 1, operations: [{ id: 'bypass', executor: 'deterministic',
    reads: [], writes: ['new.mjs'], depends_on: [], edits: [{ kind: 'create', path: 'new.mjs', text: 'export const bypass = true;\n' }] }] };
  const result = await runManagedChangeset(f.record, null, undefined, { ...f, submittedPlan: plan, submittedModel: f.record.planner_model });
  assert.match(result.error, /Delegate authored source/); assert.equal(result.publication, 'not-published');
});

test('background review sees its pinned commit while the next step keeps its dirty source', t => {
  const f = fixture(t), cwd = f.record.checkout;
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['add', 'value.mjs'], { cwd });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Initial fixture'], { cwd });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  writeFileSync(join(cwd, 'value.mjs'), '// next step in progress\n');
  const review = prepareReviewCheckout(cwd, head);
  try {
    assert.equal(readFileSync(join(review.checkout, 'value.mjs'), 'utf8'), 'export const value = 1;\n// existing dirty change\n');
    assert.equal(f.source(), '// next step in progress\n');
    assert.equal(execFileSync('git', ['-C', review.checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), head);
  } finally { removeReviewCheckout(review); }
  assert.equal(f.source(), '// next step in progress\n');
});

test('commit evidence rejects hook-authored bytes and extra staged paths', t => {
  const f = fixture(t), cwd = f.record.checkout;
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', 'value.mjs'); git('commit', '-qm', 'Initial fixture');
  const parent = git('rev-parse', 'HEAD'), approved = 'export const value = 2;\n';
  writeFileSync(join(cwd, 'value.mjs'), approved); git('add', 'value.mjs'); git('commit', '-qm', 'Apply published fixture');
  const expected = new Map([['value.mjs', hash(approved)]]);
  assert.equal(verifyPublishedCommit(cwd, parent, expected), git('rev-parse', 'HEAD'));
  assert.throws(() => verifyPublishedCommit(cwd, parent, new Map([['value.mjs', hash('unpublished bytes')]])), /bytes differ/);
  writeFileSync(join(cwd, 'extra.mjs'), 'export const extra = true;\n'); git('add', 'extra.mjs'); git('commit', '--amend', '--no-edit', '-q');
  assert.throws(() => verifyPublishedCommit(cwd, parent, expected), /unpublished path/);
  writeFileSync(join(f.record.package, 'runtime/runs', `${f.record.id}-commit-reconciliation.json`), '{}');
  assert.equal(completionStatus(f.record).status, 'handoff_incomplete');
  assert.match(completionStatus(f.record).missing[0], /reconciliation/);
});

test('serial fix stages preserve canonical packet IDs and fix records consumed by spec history', async t => {
  const f = fixture(t), head = 'a'.repeat(40), commit = 'b'.repeat(40);
  mkdirSync(join(f.record.package, 'reviews'));
  writeFileSync(join(f.record.package, 'spec.md'), '# Fixture intent\n');
  const record = { ...f.record, stage: { label: 'step-001', role: 'reviewer', base: head, head,
    review_path: 'reviews/step-001-review.md', fix_path: 'reviews/step-001-fix.md' } };
  writeFileSync(join(f.record.package, record.stage.review_path), renderReviewMarkdown(record, { verdict: 'needs-fix',
    findings: [{ id: 'F1', severity: 'HIGH', category: 'correctness', actionable: true, file: 'value.mjs', line: 1,
      symbol: 'value', signature: 'wrong-value', explanation: 'The value is incorrect.', correction: 'Set the intended value.', commit: head }], fix_verdicts: [], limitations: [] }));
  const stage = serialFixContext(f.record.package, record.stage.review_path, record.stage.fix_path);
  assert.equal(stage.role, 'fixer'); assert.deepEqual(stage.packet.ids, ['F1']);
  assert.deepEqual(stage.expected_ids, ['F1']);
  const fixed = { ...record, stage: { ...record.stage, ...stage } };
  writeFileSync(join(f.record.package, stage.fix_path), renderFixMarkdown(fixed, {
    commits: [commit], decisions: [{ id: 'F1', decision: 'fixed', signature: 'wrong-value', note: 'Correct the value.' }],
    evidence: [], unresolved: [], triage: { summary: 'Repair the incorrect value.', fallback: false } }));
  const history = await buildHistoryIndex(f.record.package), fix = history.records.find(record => record.path === stage.fix_path);
  assert.deepEqual(fix.decisions, ['fixed']);
  assert.ok(!fix.missingReferences?.length);
  assert.match(readFileSync(join(f.record.package, stage.fix_path), 'utf8'), /pending: \[\]/);
});
