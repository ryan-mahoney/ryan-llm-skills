// Focused: node --test scripts/changeset/models.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Budget,completeJson,parseSelector} from './models.mjs';
function budget(t,limit=1) {const dir=mkdtempSync(join(tmpdir(),'changeset-budget-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return new Budget(join(dir,'budget.json'),limit);}
test('budget reservations prevent overspend including unknown and interrupted charges',t=>{
  const b=budget(t); const id=b.reserve('x',0.6); assert.throws(()=>b.reserve('x',0.5),/exhausted/);
  b.settle(id,null); assert.throws(()=>b.reserve('x',0.5),/exhausted/);
  b.settle(id,{cost:{total:0.1}}); b.reserve('y',0.5);
  assert.equal(JSON.parse(readFileSync(b.path,'utf8')).entries.length,2);
});
test('one-shot model request bounds output and disables retries, retaining usage on invalid JSON',async t=>{
  const b=budget(t);let calls=0,receipt;
  const runtime={getModel:()=>({cost:{input:1,output:2}}),hasConfiguredAuth:()=>true,completeSimple:async(m,c,o)=>{calls++;assert.equal(o.maxRetries,0);assert.equal(o.maxTokens,100);return{stopReason:'stop',content:[{type:'text',text:'invalid'}],usage:{input:10,output:2,cost:{total:0.001}}};}};
  await assert.rejects(completeJson({runtime,selector:'p/m:low',system:'s',prompt:'p',budget:b,maxTokens:100,onReceipt:r=>receipt=r}));
  assert.equal(calls,1);assert.equal(receipt.usage.input,10);assert.equal(JSON.parse(readFileSync(b.path,'utf8')).entries[0].status,'priced');
  assert.deepEqual(parseSelector('openrouter/inception/mercury-2.5:low'),{provider:'openrouter',id:'inception/mercury-2.5',reasoning:'low'});
});
