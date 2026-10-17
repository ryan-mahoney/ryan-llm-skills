// Run: CHANGESET_TEST_PARSER=/path/to/acorn.mjs node --test scripts/changeset-study/combined-dispatch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('Sol dispatch joins one Jev decision, deterministic grouping, parallel V4A and local manual fallback before outer checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'combined-dispatch-'));
  const previous = { runtime: process.env.CHANGESET_MODEL_RUNTIME, jev: process.env.JEV_TYPESAFE_MODULE };
  try {
    const scripts = fileURLToPath(new URL('..', import.meta.url));
    for (const folder of ['changeset-study', 'changeset', 'changeset-research'])
      cpSync(join(scripts, folder), join(root, 'scripts', folder), { recursive: true });
    mkdirSync(join(root, 'scripts/changeset-study/parser'), { recursive: true });
    assert.ok(process.env.CHANGESET_TEST_PARSER, 'Supply the pinned study Acorn module');
    cpSync(process.env.CHANGESET_TEST_PARSER, join(root, 'scripts/changeset-study/parser/acorn.mjs'));
    const fake = join(root, 'runtime.mjs');
    writeFileSync(fake, `export const ModelRuntime={create:async()=>({
      getModel:(provider,id)=>({provider,id,api:'test',cost:{input:0.3,output:1.2}}),hasConfiguredAuth:()=>true,
      streamSimple:()=>{throw Error('No discovery, owner rerun or model review permitted');},
      completeSimple:async(model,context)=>{
        const input=JSON.parse(context.messages[0].content); let text;
        if(model.provider==='openai-codex') {
          if(input.task || input.feedback || !input.catalog || !input.implementation_brief) throw Error('Unexpected Sol role');
          const packet=(id,path,instruction,depends_on=[])=>({id,executor:'simple',reads:[],writes:[path],depends_on,
            objective:instruction,instruction,requirements:['Preserve other source.'],context:[{path,start:null,end:null}]});
          text=JSON.stringify({schema_version:1,operations:[packet('first','answer.mjs','Change wrong to half'),
            packet('other','other.mjs','Change 0 to 1'),packet('second','answer.mjs','Change half to correct',['first'])]});
        } else {
          if(input.task || input.feedback || input.task_contract) throw Error('Task or test feedback reached writer');
          const path=input.writes[0];
          if(input.application_failure) {
            if(!input.excerpts.find(row=>row.path===path).text.includes('wrong')) throw Error('Rejected patch changed source');
            text=JSON.stringify({edits:[{kind:'replace',path,search:"'wrong'",text:"'correct'"}]});
          } else if(path==='answer.mjs') text='*** Begin Patch\\n*** Update File: answer.mjs\\n@@\\n-absent anchor\\n+replacement\\n*** End Patch';
          else text='*** Begin Patch\\n*** Update File: other.mjs\\n@@\\n-export const other = 0;\\n+export const other = 1;\\n*** End Patch';
        }
        return {stopReason:'stop',content:[{type:'text',text}],usage:{input:10,output:10,totalTokens:20,cost:{total:0.000015}}};
      }
    })};`);
    mkdirSync(join(root, 'jev/dist'), { recursive: true });
    writeFileSync(join(root, 'jev/package.json'), JSON.stringify({ name: 'fake-jev', version: '1', type: 'module' }));
    const jev = join(root, 'jev/dist/index.mjs');
    writeFileSync(jev, `let calls=0; export const choice=(instructions,criteria)=>({instructions,criteria});
      export const createTypeSafe=()=>({getSpend:()=>({usdPerMTok:0.042,session:{requestsStarted:calls,requestsSucceeded:calls,
        requestsFailed:0,inputTokens:calls*10,outputTokens:0,estimatedUsd:calls*0.00000042}})});
      export const ask=async(_client,{state,questions})=>{calls++; if(calls!==1 || state.pairs.length!==1) throw Error('Expected one advice batch');
        return {ok:true,model:'jev-latest',backend:'typesafe',usage:{input_tokens:10,output_tokens:0},
          answers:Object.fromEntries(Object.keys(questions).map(key=>[key,{choice:key.startsWith('merge_')?'merge':'whole',confidence:1}]))};};`);
    process.env.CHANGESET_MODEL_RUNTIME = fake; process.env.JEV_TYPESAFE_MODULE = jev;
    const { runCell } = await import(pathToFileURL(join(root, 'scripts/changeset-study/cell.mjs')));
    const directory = join(root, 'cell'), ledger = join(root, 'budget.json');
    const result = await runCell({ directory, ledger, arm: 'changeset', strategy: 'owner-query-writer', dispatchProfile: 'optimized-v4a',
      selector: 'openai-codex/gpt-6.1-sol:low', editorSelector: 'deepseek/deepseek-flash:off', plannerPrompt: 'planner',
      preparedBrief: 'Change answer.mjs to return correct and other.mjs to export 1. Preserve untouched.mjs.',
      task: { id: 'combined', context: 'discovery', spec: 'OUTER TASK', protected: ['untouched.mjs'],
        files: { 'answer.mjs': "export const answer = 'wrong';\n", 'other.mjs': 'export const other = 0;\n', 'untouched.mjs': 'export const keep = true;\n' },
        check: 'node --check answer.mjs', hidden: "import {answer} from '/work/answer.mjs'; import {other} from '/work/other.mjs'; if(answer!=='correct'||other!==1) throw Error('wrong behavior');",
        limits: { model_calls: 10, cell_ms: 10000, grade_ms: 3000 } } });
    assert.equal(result.executions[0]?.ok, true, JSON.stringify(result));
    assert.equal(result.visible_accepted, true); assert.equal(result.hidden_pass, true);
    assert.equal(result.optimization_metrics.before.assignments, 3); assert.equal(result.optimization_metrics.after.assignments, 2);
    assert.equal(result.executions[0].metrics.peak_concurrency, 2);
    assert.equal(result.routing.attempted, true); assert.equal(result.calls_including_routing, 5);
    assert.equal(result.repairs, 0); assert.equal(result.review_accepted, null);
    const requests = readFileSync(join(directory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(requests.length, 4); assert.equal(requests[0].selector, 'openai-codex/gpt-6.1-sol:low');
    assert.ok(requests.slice(1).every(row => row.selector === 'deepseek/deepseek-flash:off' && row.stage === 'editor'));
    assert.equal(requests.filter(row => row.writer_attempt === 1).length, 1);
    assert.equal(result.writer_attempts.filter(row => row.writer_fallback).length, 1);
    assert.equal(readFileSync(join(directory, 'repository/answer.mjs'), 'utf8'), "export const answer = 'correct';\n");
    assert.equal(readFileSync(join(directory, 'repository/untouched.mjs'), 'utf8'), 'export const keep = true;\n');
    assert.equal(JSON.parse(readFileSync(ledger)).entries.length, 5);
  } finally {
    for (const [key, value] of [['CHANGESET_MODEL_RUNTIME', previous.runtime], ['JEV_TYPESAFE_MODULE', previous.jev]])
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
