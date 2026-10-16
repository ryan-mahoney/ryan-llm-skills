// CHANGESET_TEST_PARSER="$ACORN_MODULE" node --test scripts/changeset-study/dispatch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deliveredResult } from './strategies.mjs';

test('dispatch runs no owner review or repair after either successful or failed editor work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'study-dispatch-'));
  const previous = process.env.CHANGESET_MODEL_RUNTIME;
  try {
    const scripts = fileURLToPath(new URL('..', import.meta.url));
    for (const folder of ['changeset-study', 'changeset', 'changeset-research']) cpSync(join(scripts, folder), join(root, 'scripts', folder), { recursive: true });
    mkdirSync(join(root, 'scripts/changeset-study/parser'), { recursive: true });
    assert.ok(process.env.CHANGESET_TEST_PARSER, 'Use the same Acorn module as the study');
    cpSync(process.env.CHANGESET_TEST_PARSER, join(root, 'scripts/changeset-study/parser/acorn.mjs'));
    const fake = join(root, 'fake-runtime.mjs');
    writeFileSync(fake, `export const ModelRuntime={create:async()=>({
      getModel:(provider,id)=>({provider,id,api:'test',cost:{input:0.3,output:1.2}}),hasConfiguredAuth:()=>true,
      streamSimple:(model,context)=>{
        const message=context.messages.filter(m=>m.role==='user').at(-1);
        const input=JSON.parse(typeof message.content==='string'?message.content:message.content.map(c=>c.text??'').join(''));
        let text;
        if(model.id==='editor') {
          if(input.task!=='three-role') throw Error('Step owner did not receive original task');
          text='Change: set answer.txt to correct. Preserve other files. Return edits only.';
        } else {
          if(input.task!==undefined || input.files!==undefined || !input.implementation_brief) throw Error('Query planner must receive settled brief, not original task');
          text=JSON.stringify({schema_version:1,operations:[{id:'answer',executor:'simple',reads:[],writes:['answer.txt'],depends_on:[],
            objective:'Change answer',instruction:'correct',requirements:['Keep other files.'],context:[{path:'answer.txt',start:null,end:null}]}]});
        }
        const response={role:'assistant',model:model.id,provider:model.provider,api:'test',stopReason:'stop',timestamp:Date.now(),
          usage:{cost:{total:0.000001}},content:[{type:'text',text}]};
        return {result:async()=>response,async *[Symbol.asyncIterator](){yield {type:'done',reason:'stop',message:response};}};
      },
      completeSimple:async(model,context)=>{
        const input=JSON.parse(context.messages[0].content);
        let value;
        if(model.id==='planner') {
          if(!input.file_tree || input.feedback) throw Error('Unexpected owner follow-up');
          value={schema_version:1,operations:[{id:'answer',executor:'simple',reads:[],writes:['answer.txt'],depends_on:[],
            objective:'Change answer',instruction:input.task==='plan-correction'?'correct':input.task,requirements:['Keep other files.'],
            context:[{path:'answer.txt',start:null,end:input.task==='plan-correction'&&!input.planning_validation_errors?'missing':null}]}]};
        } else value={edits:[{kind:'replace',path:'answer.txt',search:input.instruction==='bad-anchor'?'absent':'wrong',text:input.instruction}]};
        return {stopReason:'stop',usage:{cost:{total:0.000001}},content:[{type:'text',text:JSON.stringify(value)}]};
      }
    })};`);
    process.env.CHANGESET_MODEL_RUNTIME = fake;
    const { runCell } = await import(pathToFileURL(join(root, 'scripts/changeset-study/cell.mjs')));
    for (const outcome of ['correct', 'bad-anchor', 'incorrect-behavior', 'plan-correction', 'three-role']) {
      const directory = join(root, outcome);
      const result = await runCell({ arm: 'changeset', strategy: outcome === 'three-role' ? 'owner-query-writer' : 'focused-dispatch', selector: 'test/planner', editorSelector: 'test/editor',
        ledger: join(root, 'budget.json'), directory, plannerPrompt: 'planner', task: {
          id: outcome, spec: outcome, context: 'prepared', files: { 'answer.txt': 'wrong' }, protected: [],
          check: 'test "$(cat answer.txt)" = correct',
          hidden: "import {readFileSync} from 'node:fs'; if(readFileSync('/work/answer.txt','utf8')!=='correct') throw Error('wrong answer');",
          limits: { cell_ms: 5000, grade_ms: 3000 },
        } });
      const requests = readFileSync(join(directory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const stages = { correct: ['planning', 'editor'], 'bad-anchor': ['planning', 'editor', 'editor'],
        'incorrect-behavior': ['planning', 'editor'], 'plan-correction': ['planning', 'planning', 'editor'],
        'three-role': ['implementation-planning', 'discovery-planning', 'editor'] };
      assert.deepEqual(requests.map(r => r.stage), stages[outcome]);
      if (outcome === 'three-role') assert.deepEqual(requests.map(r => r.selector), ['test/editor', 'test/planner', 'test/editor']);
      assert.equal(result.review_accepted, null);
      assert.equal(result.review_mode, 'executable-checks-only');
      assert.equal(result.repairs, 0);
      assert.deepEqual(result.reviews, []);
      assert.equal(result.stages.some(s => s.name === 'impact-review' || s.name === 'repair-planning'), false);
      assert.equal(deliveredResult(result), ['correct', 'plan-correction', 'three-role'].includes(outcome), result.error ?? JSON.stringify(result.checks));
    }

    const sourceDirectory = join(root, 'three-role');
    const replayDirectory = join(root, 'three-role-replay');
    const replay = await runCell({ arm: 'changeset', strategy: 'owner-query-writer', optimization: 'deterministic',
      selector: 'test/planner', editorSelector: 'test/editor', ledger: join(root, 'budget.json'), directory: replayDirectory,
      plannerPrompt: 'planner', preparedPlan: JSON.parse(readFileSync(join(sourceDirectory, 'raw-plan.json'), 'utf8')),
      preparedBrief: readFileSync(join(sourceDirectory, 'implementation-brief.md'), 'utf8'), task: {
        id: 'three-role', spec: 'three-role', context: 'prepared', files: { 'answer.txt': 'wrong' }, protected: [],
        check: 'test "$(cat answer.txt)" = correct',
        hidden: "import {readFileSync} from 'node:fs'; if(readFileSync('/work/answer.txt','utf8')!=='correct') throw Error('wrong answer');",
        limits: { cell_ms: 5000, grade_ms: 3000 },
      } });
    const replayRequests = readFileSync(join(replayDirectory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(replayRequests.map(request => request.stage), ['editor']);
    assert.deepEqual(replayRequests.map(request => request.selector), ['test/editor']);
    assert.equal(replay.optimization, 'deterministic');
    assert.equal(readFileSync(join(replayDirectory, 'repository/answer.txt'), 'utf8'), 'correct');
    assert.equal(deliveredResult(replay), true, replay.error ?? JSON.stringify(replay.checks));
  } finally {
    if (previous === undefined) delete process.env.CHANGESET_MODEL_RUNTIME;
    else process.env.CHANGESET_MODEL_RUNTIME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
