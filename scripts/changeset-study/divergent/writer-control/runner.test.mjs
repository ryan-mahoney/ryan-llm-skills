// Run alone: CHANGESET_TEST_PARSER=/path/to/acorn.mjs node --test scripts/changeset-study/divergent/writer-control/runner.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditCell } from './audit.mjs';
import { auditFixedOffRun } from './fixed-off-audit.mjs';
import { prepare, verifyPrepared, auditPrepared, reservationReadiness } from './runner.mjs';
import { hash, inventory, model, read, taskIds, write } from './support.mjs';

function fixture(root) {
  const source = join(root, 'dispatch-deepseek/18-fixture'), sdk = join(root, 'installation/node_modules/@earendil-works'), dependency = join(root, 'dependency');
  const ledger = join(root, 'budget.json'), backend = join(source, 'frozen');
  mkdirSync(source, { recursive: true }); mkdirSync(dependency); write(join(dependency, 'package.json'), {});
  write(ledger, { schema_version: 1, limit_usd: 50, entries: [] });
  const metadata = { provider: 'openai-codex', id: 'gpt-6.1-sol', maxTokens: 100, contextWindow: 1000, cost: { input: 0.3, output: 1.2 } };
  for (const pkg of ['pi-agent-core', 'pi-coding-agent', 'pi-ai']) { mkdirSync(join(sdk, pkg, 'dist'), { recursive: true }); write(join(sdk, pkg, 'package.json'), { type: 'module' }); }
  mkdirSync(join(sdk, 'pi-ai/dist/api')); writeFileSync(join(sdk, 'pi-ai/dist/api/openai-codex-responses.js'), '// Offline adapter fixture; enforcement unverified.\n');
  mkdirSync(join(sdk, 'pi-coding-agent/dist/core'));
  writeFileSync(join(sdk, 'pi-coding-agent/dist/core/model-runtime.js'), `export const ModelRuntime={create:async()=>({getModel:()=>(${JSON.stringify(metadata)})})};`);
  const scripts = fileURLToPath(new URL('../../..', import.meta.url));
  cpSync(join(scripts, 'changeset'), join(backend, 'scripts/changeset'), { recursive: true });
  mkdirSync(join(backend, 'scripts/changeset-study/parser'), { recursive: true });
  for (const name of ['focused-editors.mjs', 'context-compact.mjs']) cpSync(join(scripts, 'changeset-study', name), join(backend, 'scripts/changeset-study', name));
  assert.ok(process.env.CHANGESET_TEST_PARSER);
  cpSync(process.env.CHANGESET_TEST_PARSER, join(backend, 'scripts/changeset-study/parser/acorn.mjs'));
  writeFileSync(join(backend, 'scripts/changeset-study/worker.mjs'), `
import {readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; import {createHash} from 'node:crypto';
import {compile,transform} from '../changeset/engine.mjs'; import {focusedInput} from './focused-editors.mjs';
const h=x=>createHash('sha256').update(x).digest('hex'),job=JSON.parse(readFileSync(process.argv[2]));
const w=(n,x)=>writeFileSync(join(job.directory,n),JSON.stringify(x));
const plan={...job.preparedPlan,operations:compile(job.preparedPlan)},op=plan.operations[0],input=focusedInput(op,job.task.files);
input.file_state=Object.entries(job.task.files).map(([path,text])=>({path,writable:op.writes.includes(path),exists:text!==null}));
const edits=[{kind:'replace',path:'answer.mjs',search:"'wrong'",text:"'correct'"}],changed=transform({...op,edits},job.task.files),candidate={...job.task.files,...changed};
const usage={input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15,cost:{total:0.001}};
const q={reservation:'one',stage:'editor',selector:job.editorSelector,operation_id:op.id,writer_attempt:0,context:{systemPrompt:'offline fixture',messages:[{role:'user',content:JSON.stringify(input),timestamp:0}]}};
w('requests.jsonl',q);w('receipts.jsonl',{...q,stop_reason:'stop',elapsed_ms:1,usage});w('responses.jsonl',{reservation:'one',stage:'editor',response:{stopReason:'stop',usage,content:[{type:'text',text:JSON.stringify({edits})}]}});
w('plan-0.json',plan);w('candidate.json',candidate);w('result.json',{task:job.task.id,task_hash:h(JSON.stringify(job.task)),strategy:job.strategy,selector:job.selector,editor_selector:job.editorSelector,writer_recovery_selector:null,optimization:'none',query_mode:job.queryMode,query_granularity:job.queryGranularity,limits:job.task.limits,repairs:0,reviews:[],model_calls:1,tokens:usage,stages:[{name:'execution',elapsed_ms:1}],candidate_hash:h(JSON.stringify(candidate)),accepted:true,hidden_pass:true,checks:[{visible:{ok:true,candidate_tests:[]}}],executions:[{ok:true,plan_sha256:h(JSON.stringify(plan)),operations:[{id:op.id,executor:op.executor,status:'passed'}]}]});
`);
  const tasks = taskIds.map(id => ({ id, context: 'discovery', spec: 'Offline task', check: 'node --check answer.mjs', hidden: 'offline terminal fixture', protected: [],
    files: { 'answer.mjs': "export function answer() { return 'wrong'; }\n" }, limits: { cell_ms: 3000, grade_ms: 1000, model_calls: 8, max_output_tokens: 100, call_ms: 1000, command_ms: 1000 } }));
  write(join(source, 'tasks.json'), tasks);
  for (const [index, task] of tasks.entries()) {
    const directory = join(source, `${String(index).padStart(3, '0')}-${task.id}`); mkdirSync(directory);
    const plan = { schema_version: 1, operations: [{ id: 'answer', executor: 'simple', reads: [], writes: ['answer.mjs'], depends_on: [],
      objective: 'Update answer', instruction: 'Apply the settled answer update', requirements: ['Preserve other source'], context: [{ path: 'answer.mjs', start: null, end: null }] }] };
    const brief = 'Change answer.mjs using the settled source.\n';
    write(join(directory, 'job.json'), { task, ledger, selector: model, editorSelector: 'deepseek/deepseek-flash:off', preparedBrief: brief, queryGranularity: 'smaller-regions', mounts: [[dependency, '/node_modules']], plannerPrompt: 'unused' });
    writeFileSync(join(directory, 'implementation-brief.md'), brief); write(join(directory, 'raw-plan.json'), plan); write(join(directory, 'plan-0.json'), plan);
    write(join(directory, 'result.json'), { selector: model, editor_selector: 'deepseek/deepseek-flash:off', optimization: 'none', query_mode: 'catalog-lookup', task_hash: hash(JSON.stringify(task)), process_elapsed_ms: 1, query_granularity: 'smaller-regions',
      implementation_brief_hash: hash(brief), executions: [{ ok: true, plan_sha256: hash(JSON.stringify(plan)), operations: [{ id: 'answer', executor: 'simple', status: 'passed' }] }] });
    writeFileSync(join(directory, 'requests.jsonl'), JSON.stringify({ stage: 'editor', context: { messages: [{ role: 'user', content: 'offline retained packet' }] } }) + '\n');
  }
  write(join(source, 'manifest.json'), { revision: '80cf4f1' + '0'.repeat(33), comparison: 'deepseek-owner-sol-query-deepseek-writer', source_run: 'original-workflow', source_manifest_hash: hash('original-workflow-fixture'), strategy: 'owner-query-writer', selector: model, editor_selector: 'deepseek/deepseek-flash:off',
    query_mode: 'catalog-lookup', query_granularity: 'smaller-regions', optimization: 'none', schedule: taskIds, tasks_hash: hash(readFileSync(join(source, 'tasks.json'))),
    frozen_files: inventory(backend), sdk_files: Object.fromEntries(['pi-agent-core', 'pi-coding-agent', 'pi-ai'].map(pkg => [pkg, inventory(join(sdk, pkg, 'dist'))])),
    dependencies_hash: hash(JSON.stringify(inventory(dependency))), models: [{ selector: model, model: metadata }, { selector: 'deepseek/deepseek-flash:off', model: { ...metadata, provider: 'deepseek', id: 'deepseek-flash' } }] });
  return { source, sdk, ledger, output: join(root, 'writer-controls/sol') };
}

test('writer control freezes donor bytes offline, preserves canonical ledger and audits fake boundary execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'writer-control-'));
  try {
    const args = fixture(root), prepared = prepare(args);
    assert.deepEqual(prepared.manifest.backend_files, read(join(args.source, 'manifest.json')).frozen_files);
    assert.equal(prepared.manifest.output_cap.matched_provider_enforcement, false);
    assert.equal(prepared.manifest.output_cap.control_effective_output_cap, 'unverified for this adapter hash');
    const before = readFileSync(args.ledger, 'utf8');
    const frozen = await import(pathToFileURL(join(args.output, 'harness/runner.mjs')));
    const report = await frozen.runPrepared(args.output);
    assert.equal(report.all_qualified_application, true, JSON.stringify(report));
    assert.equal(report.all_delivery_checks_pass, true);
    assert.equal(readFileSync(args.ledger, 'utf8'), before, 'fake boundary must not charge or reset shared ledger');
    assert.ok(report.cells.every(cell => cell.source_replay_performed));
    await assert.rejects(frozen.runPrepared(args.output), /execute once/);
    const directory = join(args.output, prepared.manifest.cells[0].name);
    const request = JSON.parse(readFileSync(join(directory, 'requests.jsonl'))), receipt = JSON.parse(readFileSync(join(directory, 'receipts.jsonl')));
    writeFileSync(join(directory, 'requests.jsonl'), JSON.stringify({ ...request, selector: 'deepseek/deepseek-flash:off' }));
    writeFileSync(join(directory, 'receipts.jsonl'), JSON.stringify({ ...receipt, selector: 'deepseek/deepseek-flash:off' }));
    const invalid = await auditPrepared(args.output);
    assert.equal(invalid.all_qualified_application, false, 'matching wrong selectors must not qualify');
    // The same staged response and final candidate are valid, but a transport-triggered retry is not a matched local retry.
    const response = read(join(directory, 'responses.jsonl')), result = read(join(directory, 'result.json'));
    const originalInput = JSON.parse(request.context.messages[0].content);
    const retry = { ...request, reservation: 'retry', writer_attempt: 1, context: { ...request.context,
      messages: [{ role: 'user', content: JSON.stringify({ ...originalInput, application_failure: 'Transport error' }), timestamp: 0 }] } };
    const firstReceipt = { ...receipt, stop_reason: 'error', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } };
    const retryReceipt = { ...receipt, reservation: 'retry', writer_attempt: 1 };
    writeFileSync(join(directory, 'requests.jsonl'), [request, retry].map(JSON.stringify).join('\n'));
    writeFileSync(join(directory, 'receipts.jsonl'), [firstReceipt, retryReceipt].map(JSON.stringify).join('\n'));
    writeFileSync(join(directory, 'responses.jsonl'), [{ reservation: 'one', stage: 'editor', error: 'Transport error', response: null },
      { ...response, reservation: 'retry' }].map(JSON.stringify).join('\n'));
    write(join(directory, 'result.json'), { ...result, model_calls: 2 });
    const transport = await auditPrepared(args.output);
    assert.equal(transport.all_qualified_application, false);
    assert.ok(transport.cells[0].validation.some(check => check.check.includes('never transport') && !check.ok));
    assert.equal(transport.cells[0].reported_usd, 0.001, 'ineligible comparison still retains incurred charges');
    let parseFailure;
    try { JSON.parse('not JSON'); } catch (error) { parseFailure = error.message; }
    retry.context.messages[0].content = JSON.stringify({ ...originalInput, application_failure: parseFailure });
    writeFileSync(join(directory, 'requests.jsonl'), [request, retry].map(JSON.stringify).join('\n'));
    writeFileSync(join(directory, 'receipts.jsonl'), [{ ...firstReceipt, stop_reason: 'stop' }, retryReceipt].map(JSON.stringify).join('\n'));
    writeFileSync(join(directory, 'responses.jsonl'), [{ reservation: 'one', stage: 'editor', response: { stopReason: 'stop', usage: firstReceipt.usage, content: [{ type: 'text', text: 'not JSON' }] } },
      { ...response, reservation: 'retry' }].map(JSON.stringify).join('\n'));
    assert.equal((await auditPrepared(args.output)).all_qualified_application, true, 'decoded-format retry is eligible');
    writeFileSync(join(args.output, 'inputs', prepared.manifest.cells[0].name, 'implementation-brief.md'), 'Changed brief');
    assert.throws(() => verifyPrepared(args.output), /artifacts differ/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writer control rejects unsafe output, new ledgers, unauthorized writers and changed snapshots before execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'writer-control-guards-'));
  try {
    const args = fixture(root);
    assert.throws(() => prepare({ ...args, writer: 'deepseek/deepseek-flash:off' }), /Only/);
    assert.throws(() => prepare({ ...args, ledger: join(root, 'typo-ledger.json') }), /Existing/);
    assert.throws(() => prepare({ ...args, output: join(dirname(args.source), 'control') }), /outside dispatch/);
    const wrongLedger = join(root, 'other-ledger.json'); write(wrongLedger, { schema_version: 1, limit_usd: 50, entries: [] });
    assert.throws(() => prepare({ ...args, ledger: wrongLedger }), /canonical/);
    prepare(args);
    writeFileSync(join(args.output, 'backend/scripts/changeset-study/worker.mjs'), 'Changed worker');
    assert.throws(() => verifyPrepared(args.output), /Frozen control bytes/);
    const metadata = { maxTokens: 128000, contextWindow: 500000, cost: { input: 5, output: 15 } };
    const cells = [{ name: '000-hard-context-calibration', job: { task: { limits: { max_output_tokens: 32000 } } } }];
    const readiness = reservationReadiness(metadata, cells, args.source, { limit_usd: 50, entries: [{ reserved_usd: 20 }] });
    assert.equal(readiness.output_tokens_reserved, 500000);
    assert.equal(readiness.four_retained_packet_reservations_fit, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


// Run alone: CHANGESET_TEST_PARSER=/path/to/acorn.mjs node --test --test-name-pattern='writer audit rejects unexecuted' scripts/changeset-study/divergent/writer-control/runner.test.mjs
test('writer audit rejects unexecuted success claims, dependency misordering and orphan responses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'writer-control-replay-'));
  try {
    const args = fixture(root), { manifest } = prepare(args);
    const frozen = await import(pathToFileURL(join(args.output, 'harness/runner.mjs')));
    await frozen.runPrepared(args.output);
    const cell = manifest.cells[0], directory = join(args.output, cell.name);
    const baseline = { expectedJob: read(join(directory, 'job.json')), plan: read(join(directory, 'plan-0.json')),
      result: read(join(directory, 'result.json')), candidate: read(join(directory, 'candidate.json')),
      requests: [read(join(directory, 'requests.jsonl'))], receipts: [read(join(directory, 'receipts.jsonl'))], responses: [read(join(directory, 'responses.jsonl'))] };
    async function audit(mutate) {
      const data = structuredClone(baseline); mutate(data);
      data.expectedJob.preparedPlan = data.plan;
      data.result.executions[0].plan_sha256 = hash(JSON.stringify(data.plan));
      data.result.candidate_hash = hash(JSON.stringify(data.candidate));
      write(join(directory, 'job.json'), data.expectedJob); write(join(directory, 'plan-0.json'), data.plan);
      writeFileSync(join(directory, 'candidate.json'), JSON.stringify(data.candidate)); write(join(directory, 'result.json'), data.result);
      for (const name of ['requests', 'receipts', 'responses']) writeFileSync(join(directory, name + '.jsonl'), data[name].map(JSON.stringify).join('\n'));
      return auditCell({ directory, expectedJob: data.expectedJob, expectedPlan: data.plan, taskHash: cell.task_hash });
    }
    const addDependent = data => {
      data.plan.operations.push({ ...structuredClone(data.plan.operations[0]), id: 'later', depends_on: ['answer'], instruction: 'Apply second update' });
      data.result.executions[0].operations.push({ id: 'later', executor: 'simple', status: 'passed' });
    };
    const missing = await audit(addDependent);
    assert.equal(missing.qualified_application, false);
    assert.equal(missing.application_complete, false);
    assert.ok(missing.validation.some(check => check.check === 'unattempted operation cannot be recorded passed' && !check.ok));
    const failedOnly = await audit(data => {
      data.responses[0].response.content[0].text = '{"edits":[]}';
      data.candidate = data.expectedJob.task.files;
    });
    assert.equal(failedOnly.application_complete, false, 'a failed-only response cannot substantiate the passed record');
    const blocked = await audit(data => {
      addDependent(data); data.responses[0].response.content[0].text = '{"edits":[]}'; data.candidate = data.expectedJob.task.files;
      data.result.executions[0].ok = false;
      data.result.executions[0].operations = [{ id: 'answer', executor: 'simple', status: 'failed', error: 'Editor returned no edits' },
        { id: 'later', status: 'blocked', dependencies: ['answer'] }];
    });
    assert.equal(blocked.integrity_valid, true, JSON.stringify(blocked));
    assert.equal(blocked.application_complete, false);
    const completedDependent = data => {
      addDependent(data);
      const input = JSON.parse(data.requests[0].context.messages[0].content);
      input.instruction = 'Apply second update'; input.excerpts[0].text = input.excerpts[0].text.replace("'wrong'", "'correct'");
      data.requests.push({ ...data.requests[0], reservation: 'later', operation_id: 'later', context: { ...data.requests[0].context,
        messages: [{ role: 'user', content: JSON.stringify(input), timestamp: 1 }] } });
      data.receipts.push({ ...data.receipts[0], reservation: 'later', operation_id: 'later' });
      data.responses.push({ ...structuredClone(data.responses[0]), reservation: 'later' });
      data.responses[1].response.content[0].text = JSON.stringify({ edits: [{ kind: 'replace', path: 'answer.mjs', search: "'correct'", text: "'done'" }] });
      data.candidate['answer.mjs'] = data.candidate['answer.mjs'].replace("'correct'", "'done'");
      data.result.model_calls = 2;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) data.result.tokens[key] *= 2;
    };
    assert.equal((await audit(completedDependent)).qualified_application, true, 'correctly ordered dependencies can qualify');
    const outOfOrder = await audit(data => { completedDependent(data); data.requests.reverse(); });
    assert.equal(outOfOrder.qualified_application, false);
    assert.ok(outOfOrder.validation.some(check => check.check.includes('dependency final attempt precedes') && !check.ok));
    const mismatchedOutcome = await audit(data => { data.receipts[0].stop_reason = 'exception'; data.receipts[0].error = 'Transport error'; });
    assert.equal(mismatchedOutcome.qualified_application, false);
    assert.ok(mismatchedOutcome.validation.some(check => check.check.includes('outcome and usage match') && !check.ok));
    for (const stage of ['implementation-planning', 'planning', 'review', 'editor']) {
      const orphan = await audit(data => data.responses.push({ ...data.responses[0], reservation: 'orphan', stage }));
      assert.equal(orphan.qualified_application, false, stage);
      assert.ok(orphan.validation.some(check => check.check.includes('no orphan responses') && !check.ok), stage);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


// Run alone: CHANGESET_TEST_PARSER=/path/to/acorn.mjs node --test --test-name-pattern='explicit fixed-off audit' scripts/changeset-study/divergent/writer-control/runner.test.mjs
test('explicit fixed-off audit verifies donor provenance while default Sol audit stays strict and transport retries fail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixed-off-audit-'));
  try {
    const args = fixture(root), sourceManifest = read(join(args.source, 'manifest.json'));
    const run = join(dirname(args.source), '22-off-fixture'), frozen = join(run, 'frozen');
    cpSync(join(args.source, 'frozen'), frozen, { recursive: true });
    mkdirSync(join(frozen, 'skills/spec-changeset-plan'), { recursive: true });
    writeFileSync(join(frozen, 'skills/spec-changeset-plan/SKILL.md'), 'Unused offline planner skill');
    cpSync(join(args.source, 'tasks.json'), join(run, 'tasks.json'));
    write(join(run, 'manifest.json'), { ...sourceManifest, revision: 'offline-fixed-off', plans_from: '18-fixture', briefs_from: null,
      writer_recovery_selector: null, frozen_files: inventory(frozen) });
    for (const [index, id] of taskIds.entries()) {
      const name = `${String(index).padStart(3, '0')}-${id}`, source = join(args.source, name), directory = join(run, name);
      mkdirSync(directory);
      const original = read(join(source, 'job.json')), resultBytes = readFileSync(join(source, 'result.json'));
      const brief = readFileSync(join(source, 'implementation-brief.md'), 'utf8'), raw = readFileSync(join(source, 'raw-plan.json'));
      const job = { task: original.task, optimization: 'none', queryMode: 'catalog-lookup', queryGranularity: 'smaller-regions',
        preparedPlan: JSON.parse(raw), preparedBrief: brief,
        planningSource: { run: '18-fixture', cell: name, plan_hash: hash(raw), plan_artifact: 'raw-plan.json', result_hash: hash(resultBytes), query_granularity: 'smaller-regions' },
        briefSource: { run: '18-fixture', cell: name, brief_hash: hash(brief), result_hash: hash(resultBytes) },
        arm: 'changeset', strategy: 'owner-query-writer', selector: model, editorSelector: 'deepseek/deepseek-flash:off', writerRecoverySelector: null,
        ledger: args.ledger, directory, mounts: original.mounts, plannerPrompt: 'Unused offline planner skill' };
      write(join(directory, 'job.json'), job);
      execFileSync(process.execPath, [join(frozen, 'scripts/changeset-study/worker.mjs'), join(directory, 'job.json')]);
      const result = read(join(directory, 'result.json'));
      Object.assign(result, { process_elapsed_ms: 1, planning_source: job.planningSource, brief_source: job.briefSource,
        implementation_brief_hash: hash(brief), query_assignment_budget: { max_calls: 8, calls_used: 0, query_calls_reserved: 0, writer_attempts_per_operation: 2, max_operations: 4 } });
      write(join(directory, 'result.json'), result);
    }
    const options = { run, donor: args.source, sdk: args.sdk };
    const report = await auditFixedOffRun(options);
    assert.equal(report.all_qualified_application, true, JSON.stringify(report));
    const directory = join(run, '000-hard-context-calibration'), job = read(join(directory, 'job.json'));
    const defaultAudit = await auditCell({ directory, expectedJob: job, expectedPlan: read(join(directory, 'plan-0.json')),
      taskHash: hash(JSON.stringify(job.task)), frozenBackendRoot: frozen });
    assert.equal(defaultAudit.integrity_valid, false, 'default audit still accepts only Sol writer evidence');
    assert.ok(defaultAudit.validation.some(check => check.check === 'only authorized writer requests and receipts' && !check.ok));
    const badJob = structuredClone(job); badJob.preparedBrief = 'Unbound owner brief'; write(join(directory, 'job.json'), badJob);
    assert.equal((await auditFixedOffRun(options)).all_integrity_valid, false, 'expected job must derive from donor, not tampered actual job');
    write(join(directory, 'job.json'), job);
    const request = read(join(directory, 'requests.jsonl')), receipt = read(join(directory, 'receipts.jsonl')), response = read(join(directory, 'responses.jsonl'));
    const savedResult = read(join(directory, 'result.json')), savedCandidate = readFileSync(join(directory, 'candidate.json'));
    const failedRetry = { ...request, reservation: 'failed-retry', writer_attempt: 1, context: { ...request.context,
      messages: [{ role: 'user', content: JSON.stringify({ ...JSON.parse(request.context.messages[0].content), application_failure: 'Editor returned no edits' }), timestamp: 1 }] } };
    writeFileSync(join(directory, 'requests.jsonl'), [request, failedRetry].map(JSON.stringify).join('\n'));
    writeFileSync(join(directory, 'receipts.jsonl'), [receipt, { ...receipt, reservation: 'failed-retry', writer_attempt: 1 }].map(JSON.stringify).join('\n'));
    const failedResponse = structuredClone(response); failedResponse.response.content[0].text = '{"edits":[]}';
    writeFileSync(join(directory, 'responses.jsonl'), [failedResponse, { ...failedResponse, reservation: 'failed-retry' }].map(JSON.stringify).join('\n'));
    const failedResult = structuredClone(savedResult); failedResult.model_calls = 2;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) failedResult.tokens[key] *= 2;
    failedResult.executions[0].ok = false; failedResult.executions[0].operations[0].status = 'failed';
    failedResult.executions[0].operations[0].error = 'Editor returned no edits'; failedResult.accepted = false; failedResult.hidden_pass = false;
    failedResult.checks[0].visible.ok = false; failedResult.candidate_hash = hash(JSON.stringify(job.task.files));
    writeFileSync(join(directory, 'candidate.json'), JSON.stringify(job.task.files)); write(join(directory, 'result.json'), failedResult);
    const cliResult = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./fixed-off-audit.mjs', import.meta.url)),
      '--run', run, '--donor', args.source, '--sdk-root', args.sdk], { encoding: 'utf8' }));
    assert.equal(cliResult.all_integrity_valid, true, 'CLI exits zero for a valid failed observation');
    assert.equal(cliResult.all_qualified_application, false); assert.equal(cliResult.all_delivery_checks_pass, false);
    assert.equal(cliResult.audit_provider_calls, 0); assert.equal(Object.hasOwn(cliResult, 'provider_calls'), false);
    writeFileSync(join(directory, 'requests.jsonl'), JSON.stringify(request)); writeFileSync(join(directory, 'receipts.jsonl'), JSON.stringify(receipt));
    writeFileSync(join(directory, 'responses.jsonl'), JSON.stringify(response)); writeFileSync(join(directory, 'candidate.json'), savedCandidate); write(join(directory, 'result.json'), savedResult);
    const retry = { ...request, reservation: 'retry', writer_attempt: 1, context: { ...request.context,
      messages: [{ role: 'user', content: JSON.stringify({ ...JSON.parse(request.context.messages[0].content), application_failure: 'Transport error' }), timestamp: 1 }] } };
    const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
    writeFileSync(join(directory, 'requests.jsonl'), [request, retry].map(JSON.stringify).join('\n'));
    writeFileSync(join(directory, 'receipts.jsonl'), [{ ...receipt, stop_reason: 'error', error: 'Transport error', usage: zeroUsage },
      { ...receipt, reservation: 'retry', writer_attempt: 1 }].map(JSON.stringify).join('\n'));
    writeFileSync(join(directory, 'responses.jsonl'), [{ reservation: 'one', stage: 'editor', response: { stopReason: 'error', errorMessage: 'Transport error', usage: zeroUsage, content: [] } },
      { ...response, reservation: 'retry' }].map(JSON.stringify).join('\n'));
    const result = read(join(directory, 'result.json')); result.model_calls = 2; write(join(directory, 'result.json'), result);
    const rejected = await auditFixedOffRun(options);
    assert.equal(rejected.all_qualified_application, false);
    assert.ok(rejected.cells[0].validation.some(check => check.check.includes('never transport') && !check.ok));
    assert.equal(rejected.cells[0].reported_usd, 0.001);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
