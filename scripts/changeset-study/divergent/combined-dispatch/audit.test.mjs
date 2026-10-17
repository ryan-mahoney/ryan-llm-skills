// Run: CHANGESET_TEST_PARSER=/path/to/acorn.mjs node --test scripts/changeset-study/divergent/combined-dispatch/audit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '../../client.mjs';
import { v4aEditor } from '../../v4a-editor.mjs';
import { routeContext } from '../../context-router.mjs';
import { optimizePlan } from '../../optimizer.mjs';
import { hash, read, rows } from '../writer-control/support.mjs';
import { auditTrial } from './audit.mjs';

const scripts = fileURLToPath(new URL('../../../', import.meta.url));
const patch = '*** Begin Patch\n*** Update File: answer.mjs\n@@\n-export const answer = 1;\n+export const answer = 2;\n*** End Patch';
const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: .0001 } };
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
async function fixture(t, mode = 'pass') {
  const root = mkdtempSync(join(tmpdir(), 'combined-audit-')), frozenRoot = join(root, 'frozen'), directory = join(root, 'trial'), ledger = join(root, 'budget.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(directory, { recursive: true }); mkdirSync(join(frozenRoot, 'scripts'), { recursive: true });
  for (const path of ['changeset', 'changeset-study', 'changeset-research']) cpSync(join(scripts, path), join(frozenRoot, 'scripts', path), { recursive: true });
  assert.ok(process.env.CHANGESET_TEST_PARSER, 'Supply the pinned parser path');
  mkdirSync(join(frozenRoot, 'scripts/changeset-study/parser'), { recursive: true });
  cpSync(process.env.CHANGESET_TEST_PARSER, join(frozenRoot, 'scripts/changeset-study/parser/acorn.mjs'));
  save(ledger, { schema_version: 1, limit_usd: 50, entries: [] });
  const entry = join(root, 'jev/node_modules/pi-typesafe/dist/index.js'); mkdirSync(dirname(entry), { recursive: true });
  save(join(dirname(entry), '..', 'package.json'), { name: 'offline-fixture', version: '1.0.0', type: 'module' });
  writeFileSync(entry, `export const choice=(prompt,options)=>({prompt,options});
export const createTypeSafe=()=>({getSpend:()=>({usdPerMTok:.04,session:{requestsStarted:1,requestsSucceeded:1,inputTokens:10,outputTokens:1}})});
export const ask=async()=>({ok:true,model:'jev-latest',answers:{context_0:{choice:'excerpts',confidence:1}},usage:{input_tokens:10,output_tokens:1}});`);
  save(join(root, 'manifest.json'), { jev_entry: 'jev/node_modules/pi-typesafe/dist/index.js' });
  const task = { id: 'offline', files: { 'answer.mjs': 'export const answer = 1;\nfunction keep() { return "private unseen body"; }\n', 'keep.txt': 'protected\n' },
    protected: ['keep.txt'], limits: { model_calls: 8, max_output_tokens: 32000, cell_ms: 1200000 } };
  const raw = { schema_version: 1, operations: [{ id: 'answer', executor: 'simple', reads: [], writes: ['answer.mjs'], depends_on: [],
    objective: 'Set the answer to two.', instruction: 'Change the answer constant from one to two.', requirements: ['Preserve unrelated source.'],
    context: [{ path: 'answer.mjs', start: null, end: 'function keep' }] }] };
  const expectedJob = { task, selector: 'openai-codex/gpt-6.1-sol:low', editorSelector: 'deepseek/deepseek-flash:off', writerRecoverySelector: null,
    strategy: 'owner-query-writer', queryMode: 'catalog-lookup', queryGranularity: 'smaller-regions', optimization: 'contextual', dispatchProfile: 'optimized-v4a',
    preparedPlan: raw, preparedBrief: 'Exact settled brief\n', ledger };
  const prior = process.env.JEV_TYPESAFE_MODULE; let routing;
  try { process.env.JEV_TYPESAFE_MODULE = entry; routing = await routeContext(raw, task.files, { ledger, artifactDirectory: join(directory, 'routing') }); }
  finally { if (prior === undefined) delete process.env.JEV_TYPESAFE_MODULE; else process.env.JEV_TYPESAFE_MODULE = prior; }
  const dispatched = optimizePlan(raw, task.files, { mode: 'contextual', ...routing }).plan;
  let call = 0;
  const client = new Client({ runtime: { getModel: () => ({ cost: { input: .3, output: 1.2 } }), hasConfiguredAuth: () => true,
    completeSimple: async () => ({ stopReason: mode === 'length' ? 'length' : 'stop', usage, content: [{ type: 'text', text:
      mode === 'delete' ? '*** Begin Patch\n*** Delete File: answer.mjs\n*** End Patch' : mode === 'fallback' && call++ === 0 ? 'not a patch' : mode === 'fallback' ? JSON.stringify({ edits: [{ kind: 'replace', path: 'answer.mjs', search: 'answer = 1', text: 'answer = 2', count: 1 }] }) : patch }] }) },
    selector: expectedJob.editorSelector, ledger, receiptPath: join(directory, 'receipts.jsonl') });
  let outcome, error;
  try { outcome = await v4aEditor(client, 'editor', { operation: dispatched.operations[0], files: { 'answer.mjs': task.files['answer.mjs'] } }); }
  catch (caught) { error = caught; }
  const metrics = outcome ?? error, passed = Boolean(outcome), candidate = { ...task.files, ...outcome?.files };
  for (const [path, text] of Object.entries(candidate)) if (text === null) delete candidate[path];
  save(join(directory, 'candidate.json'), candidate);
  const result = { task: task.id, task_hash: hash(JSON.stringify(task)), selector: expectedJob.selector, editor_selector: expectedJob.editorSelector,
    strategy: expectedJob.strategy, writer_recovery_selector: null, optimization: 'contextual', dispatch_profile: 'optimized-v4a', limits: task.limits,
    implementation_brief_hash: hash(expectedJob.preparedBrief), reviews: [], repairs: 0, review_accepted: null, review_mode: 'executable-checks-only',
    model_calls: client.calls, calls_including_routing: client.calls + 1, routing_call_count_exact: true,
    tokens: Object.fromEntries(['input','output','cacheRead','cacheWrite','totalTokens'].map(key => [key, usage[key] * client.calls])), routing,
    executions: [{ ok: passed, plan_sha256: hash(JSON.stringify(dispatched)), operations: [{ id: 'answer', executor: 'simple', status: passed ? 'passed' : 'failed',
      ...(passed ? { output_hashes: { 'answer.mjs': Object.hasOwn(candidate, 'answer.mjs') ? hash(candidate['answer.mjs']) : null } } : { error: error.message }) }] }],
    writer_attempts: [{ operation_id: 'answer', writer_fallback: metrics.writer_fallback ?? false, attempts: metrics.writer_attempts }],
    candidate_hash: hash(readFileSync(join(directory, 'candidate.json'))), accepted: passed, hidden_pass: passed, hidden: { ok: passed, completed: true },
    checks: [{ visible: { ok: passed, base_ok: passed, candidate_tests: [] } }], stages: [{ name: 'execution', elapsed_ms: 2000 }, { name: 'optimization', elapsed_ms: 100 }, { name: 'context-routing', elapsed_ms: 50 }],
    ...(error ? { error: error.message } : {}) };
  for (const [name, value] of Object.entries({ 'job.json': expectedJob, 'raw-plan.json': raw, 'plan-0.json': dispatched, 'routing.json': routing,
    'result.json': result, 'preprocessing.json': { plan: dispatched, input_hash: hash(JSON.stringify(raw)), output_hash: hash(JSON.stringify(dispatched)), routing, elapsed_ms: 200 } })) save(join(directory, name), value);
  writeFileSync(join(directory, 'implementation-brief.md'), expectedJob.preparedBrief);
  save(join(root, 'reservations.json'), read(ledger).entries.map(({ id, selector, reserved_usd }) => ({ id, selector, reserved_usd })));
  return { directory, expectedJob, frozenRoot, ledger, root };
}

test('retained successful V4A is replayed with source privacy and preprocessing counted once', async t => {
  const input = await fixture(t), report = await auditTrial(input);
  assert.deepEqual(report.failures, []); assert.equal(report.integrity_valid, true); assert.equal(report.audited_delivered, true);
  assert.equal(report.application_complete, true); assert.equal(report.writer_calls, 1); assert.equal(report.jev_requests_started, 1);
  assert.equal(report.writer_catalog_usd, .0001); assert.ok(Math.abs(report.jev_estimated_usd - .0000004) < 1e-20); assert.equal(report.writing_seconds, 2.2);
  assert.equal(report.process_elapsed_seconds, null); assert.equal(report.retries, 0);
});

test('local fallback evidence is replayed but a hidden-source packet or ledger unknown hold cannot pass integrity', async t => {
  const input = await fixture(t, 'fallback'), report = await auditTrial(input);
  assert.deepEqual(report.failures, []); assert.equal(report.audited_delivered, true); assert.equal(report.writer_calls, 2); assert.equal(report.fallbacks, 1); assert.equal(report.retries, 1);
  const requests = rows(join(input.directory, 'requests.jsonl'));
  requests[1].context.messages[0].content += ' private unseen body';
  writeFileSync(join(input.directory, 'requests.jsonl'), requests.map(r => JSON.stringify(r)).join('\n') + '\n');
  const changed = await auditTrial(input); assert.equal(changed.integrity_valid, false); assert.equal(changed.audited_delivered, false);
  assert.ok(changed.failures.includes('exact frozen writer input including original staged excerpts/local-only diagnostics'));
  const state = read(input.ledger), entry = state.entries.find(e => e.selector === input.expectedJob.editorSelector); entry.status = 'unknown'; entry.charged_usd = null; save(input.ledger, state);
  const unknown = await auditTrial(input); assert.equal(unknown.accounting_complete, false); assert.equal(unknown.mixed_estimated_total_usd, null);
  assert.equal(unknown.unknown_reservations, 1); assert.ok(unknown.retained_budget_exposure_usd > unknown.known_charged_usd);
});

test('provider length failure remains a valid failed observation with no invented local fallback', async t => {
  const input = await fixture(t, 'length'), report = await auditTrial(input);
  assert.equal(report.integrity_valid, true, report.failures.join('\n')); assert.equal(report.application_complete, false); assert.equal(report.audited_delivered, false);
  assert.equal(report.writer_calls, 1); assert.equal(report.fallbacks, 0); assert.equal(report.retries, 0); assert.equal(report.accounting_complete, true);
});

test('missing brief or receipt is invalid retained evidence rather than a thrown audit or free delivery', async t => {
  const input = await fixture(t); rmSync(join(input.directory, 'implementation-brief.md')); rmSync(join(input.directory, 'receipts.jsonl'));
  const report = await auditTrial(input); assert.equal(report.integrity_valid, false); assert.equal(report.audited_delivered, false);
  assert.ok(report.failures.includes('retained implementation-brief.md')); assert.ok(report.known_charged_usd > 0);
});

test('successful owned deletion replays a null output hash without inventing file bytes', async t => {
  const report = await auditTrial(await fixture(t, 'delete'));
  assert.deepEqual(report.failures, []); assert.equal(report.integrity_valid, true); assert.equal(report.application_complete, true);
});
