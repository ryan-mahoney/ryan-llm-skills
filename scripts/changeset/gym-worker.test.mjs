// Focused: node --test scripts/changeset/gym-worker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
test('real worker escalates only the rejected batch, retains drafts and publishes verified output', t => {
  const root=mkdtempSync(join(tmpdir(),'changeset-worker-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const repo=join(root,'repo'),pkg=join(root,'package');mkdirSync(repo);mkdirSync(pkg);
  writeFileSync(join(repo,'answer'),'old');writeFileSync(join(pkg,'spec.md'),'Set answer to good');
  writeFileSync(join(root,'skill.md'),'Produce a plan');
  const grader=join(root,'grader.mjs');writeFileSync(grader,"import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';assert.equal(readFileSync(process.argv[2]+'/answer','utf8'),'good');");
  const runtime=join(root,'fake-runtime.mjs');
  writeFileSync(runtime,`
    const plan={schema_version:1,operations:[{id:'edit',executor:'simple',reads:[],writes:['answer'],depends_on:[],instruction:'Set good'}]};
    export class ModelRuntime {
      static create(){return new ModelRuntime();}
      getModel(provider,id){return {id,cost:{input:1,output:1}};}
      hasConfiguredAuth(){return true;}
      async completeSimple(model,context,options){
        if(options.maxRetries!==0)throw new Error('Unexpected retries');
        const prompt=JSON.parse(context.messages[0].content);
        const value=model.id==='planner'?plan:model.id==='reviewer'?{accepted:prompt.evidence.ok,findings:prompt.evidence.ok?[]:[{path:'answer',reason:'wrong'}],repair_plan:prompt.evidence.ok?null:plan}:{files:{answer:model.id==='strong'?'good':'bad'}};
        return {stopReason:'stop',content:[{type:'text',text:JSON.stringify(value)}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0.000002}}};
      }
    }
  `);
  const config={repo,package:pkg,skill:join(root,'skill.md'),task:'Set good',model:'fake/planner',budget:join(root,'budget.json'),timeout_ms:10000,result:join(root,'execution.json'),calls:join(root,'calls.jsonl'),verification:[{script:grader,timeout_ms:1000}],execution:{simple_model:'fake/fast',involved_model:'fake/involved',review_model:'fake/reviewer',repair_model:'fake/strong',concurrency:2,max_repairs:1}};
  const configPath=join(root,'config.json');writeFileSync(configPath,JSON.stringify(config));
  execFileSync(process.execPath,[fileURLToPath(new URL('./gym-worker.mjs',import.meta.url)),configPath],{env:{...process.env,CHANGESET_MODEL_RUNTIME:runtime},timeout:10000});
  const result=JSON.parse(readFileSync(config.result,'utf8'));
  assert.equal(result.outcome,'finished');assert.equal(result.workflow.first_pass,false);assert.equal(result.workflow.repairs,1);
  assert.deepEqual(result.receipts.map(r=>r.selector),['fake/planner','fake/fast','fake/reviewer','fake/strong','fake/reviewer']);
  assert.equal(readFileSync(join(repo,'answer'),'utf8'),'good');
  assert.equal(JSON.parse(readFileSync(join(root,'draft-round-0.json'),'utf8')).files.answer,'bad');
  assert.equal(JSON.parse(readFileSync(join(root,'draft-round-1.json'),'utf8')).files.answer,'good');
});
