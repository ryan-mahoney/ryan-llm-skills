// Run alone: CHANGESET_TEST_PARSER=/path/to/acorn.mjs node --test scripts/changeset-study/query-granularity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveQueryGranularity, queryAssignmentBudget, smallerRegionQueryRole, catalogPlannerRole } from './roles.mjs';
import { strategyPlanner } from './strategies.mjs';

const policy = { strategy: 'owner-query-writer', queryMode: 'catalog-lookup', optimization: 'none' };

test('query granularity inherits plan provenance and rejects relabeling or regrouping', () => {
  assert.equal(resolveQueryGranularity({}), 'default');
  assert.equal(resolveQueryGranularity({ ...policy, inherited: 'smaller-regions' }), 'smaller-regions');
  assert.equal(resolveQueryGranularity({ ...policy, inherited: 'default' }), 'default');
  assert.throws(() => resolveQueryGranularity({ ...policy, inherited: 'default', requested: 'smaller-regions' }), /inherited plan/);
  assert.throws(() => resolveQueryGranularity({ ...policy, inherited: 'smaller-regions', requested: 'default' }), /inherited plan/);
  for (const changed of [{ strategy: 'focused-dispatch' }, { queryMode: 'catalog' }, { optimization: 'deterministic' }])
    assert.throws(() => resolveQueryGranularity({ ...policy, ...changed, requested: 'smaller-regions' }), /requires/);
  assert.throws(() => resolveQueryGranularity({ ...policy, requested: 'unknown' }), /Unknown/);
});

test('smaller-region assignment budget reserves query and local retry calls after owner spending', () => {
  assert.deepEqual(queryAssignmentBudget({ maxCalls: 17, callsUsed: 4, queryCallsReserved: 3 }),
    { max_calls: 17, calls_used: 4, query_calls_reserved: 3, writer_attempts_per_operation: 2, max_operations: 5 });
  assert.equal(queryAssignmentBudget({ maxCalls: 17, callsUsed: 0, queryCallsReserved: 0 }).max_operations, 8);
  assert.equal(queryAssignmentBudget({ maxCalls: 1000, callsUsed: 0, queryCallsReserved: 3 }).max_operations, 200);
  assert.throws(() => queryAssignmentBudget({ maxCalls: 7, callsUsed: 3, queryCallsReserved: 3 }), /Insufficient/);
});

test('smaller-region query preserves same-file partitions, staged context and bounded predispatch correction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'study-granularity-'));
  const previous = process.env.CHANGESET_MODEL_RUNTIME;
  try {
    const scripts = fileURLToPath(new URL('..', import.meta.url));
    for (const folder of ['changeset-study', 'changeset', 'changeset-research'])
      cpSync(join(scripts, folder), join(root, 'scripts', folder), { recursive: true });
    mkdirSync(join(root, 'scripts/changeset-study/parser'), { recursive: true });
    assert.ok(process.env.CHANGESET_TEST_PARSER);
    cpSync(process.env.CHANGESET_TEST_PARSER, join(root, 'scripts/changeset-study/parser/acorn.mjs'));
    const fake = join(root, 'fake-runtime.mjs');
    writeFileSync(fake, `export const ModelRuntime={create:async()=>({
      getModel:(provider,id)=>({provider,id,api:'test',cost:{input:0.3,output:1.2}}),hasConfiguredAuth:()=>true,
      streamSimple:()=>{throw Error('Native discovery forbidden');},
      completeSimple:async(model,context)=>{
        const input=JSON.parse(context.messages[0].content);
        let value;
        if(model.id==='planner') {
          if(input.task!==undefined || input.feedback!==undefined || input.files!==undefined || !input.implementation_brief || !input.catalog)
            throw Error('Original task or feedback reached the query');
          const count=input.implementation_brief.includes('overbudget')?3:2;
          value={schema_version:1,operations:Array.from({length:count},(_,i)=>({
            id:'region-'+i,executor:'simple',reads:[],writes:['answer.mjs'],depends_on:i?['region-'+(i-1)]:[],
            objective:i?'Finish assigned update':'Begin assigned update',instruction:i?'Set half to correct':'Set wrong to half',
            requirements:['Preserve other source.'],context:[{path:'answer.mjs',start:null,end:null}]}))};
        } else {
          const next=input.instruction==='Set wrong to half'?'half':'correct';
          const prior=next==='half'?'wrong':'half';
          if(!input.excerpts[0].text.includes(prior)) throw Error('Writer missed staged source');
          value={edits:[{kind:'replace',path:'answer.mjs',search:"'"+prior+"'",text:"'"+next+"'"}]};
        }
        return {stopReason:'stop',usage:{cost:{total:0.000001}},content:[{type:'text',text:JSON.stringify(value)}]};
      }
    })};`);
    process.env.CHANGESET_MODEL_RUNTIME = fake;
    const { runCell } = await import(pathToFileURL(join(root, 'scripts/changeset-study/cell.mjs')));
    const options = { ...policy, arm: 'changeset', selector: 'test/planner', editorSelector: 'test/editor',
      ledger: join(root, 'budget.json'), plannerPrompt: 'planner', preparedBrief: 'Change answer.mjs, preserving all source.\n',
      task: { id: 'granularity', spec: 'ORIGINAL TASK', protected: [], files: { 'answer.mjs': "export function answer() { return 'wrong'; }\n" },
        check: 'node --check answer.mjs', hidden: '', limits: { model_calls: 7, cell_ms: 5000, grade_ms: 2000 } } };
    const directory = join(root, 'smaller');
    const result = await runCell({ ...options, queryGranularity: 'smaller-regions', directory });
    assert.equal(result.executions[0]?.ok, true, JSON.stringify(result));
    assert.equal(result.query_assignment_budget.max_operations, 2);
    const raw = JSON.parse(readFileSync(join(directory, 'raw-plan.json')));
    const dispatched = JSON.parse(readFileSync(join(directory, 'plan-0.json')));
    assert.deepEqual(dispatched.operations.map(op => op.id), raw.operations.map(op => op.id));
    assert.equal(result.query_granularity, 'smaller-regions');
    const requests = readFileSync(join(directory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(requests.map(request => request.stage), ['planning', 'editor', 'editor']);
    assert.ok(requests[0].context.systemPrompt.endsWith(smallerRegionQueryRole(result.query_assignment_budget)));
    assert.match(JSON.parse(requests[2].context.messages[0].content).excerpts[0].text, /'half'/);

    const defaultDirectory = join(root, 'default');
    await runCell({ ...options, directory: defaultDirectory });
    const initial = JSON.parse(readFileSync(join(defaultDirectory, 'requests.jsonl'), 'utf8').split('\n')[0]);
    assert.equal(initial.context.systemPrompt, strategyPlanner('owner-query-writer', 'planner') + '\n' + catalogPlannerRole({ lookup: true }));

    const inheritedDirectory = join(root, 'inherited');
    const inheritedOptions = { ...options, preparedPlan: raw, planningSource: { query_granularity: 'smaller-regions' } };
    const inherited = await runCell({ ...inheritedOptions, directory: inheritedDirectory });
    assert.equal(inherited.query_granularity, 'smaller-regions');
    assert.equal(inherited.query_assignment_budget.query_calls_reserved, 0);
    assert.equal(inherited.executions[0]?.ok, true, JSON.stringify(inherited));
    const inheritedRequests = readFileSync(join(inheritedDirectory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(inheritedRequests.map(request => request.stage), ['editor', 'editor']);
    await assert.rejects(runCell({ ...inheritedOptions, directory: join(root, 'relabeled'), queryGranularity: 'default' }), /inherited plan/);

    const failedDirectory = join(root, 'overbudget');
    const failed = await runCell({ ...options, directory: failedDirectory, queryGranularity: 'smaller-regions', preparedBrief: options.preparedBrief + 'overbudget' });
    const failedRequests = readFileSync(join(failedDirectory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(failedRequests.map(request => request.stage), ['planning', 'planning']);
    assert.deepEqual(failed.executions, []);
    assert.match(failed.checks[0].implementation_error, /assignment cap: 3 > 2/);
    assert.equal(existsSync(join(failedDirectory, 'plan-0.json')), false);
  } finally {
    if (previous === undefined) delete process.env.CHANGESET_MODEL_RUNTIME;
    else process.env.CHANGESET_MODEL_RUNTIME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
