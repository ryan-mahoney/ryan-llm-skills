// Focused: node --test scripts/changeset/workflow.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Workspace } from './workspace.mjs';
import { runWorkflow } from './workflow.mjs';
import { routeWithAdvice } from './routing.mjs';
const op=(id,path,text)=>({id,executor:'deterministic',reads:[],writes:[path],depends_on:[],edits:[{kind:'replace',path,search:'old',text}]});
const plan=operations=>({schema_version:1,operations});
test('batch repair reuses successful edits and verifies the entire integrated result',async()=>{
  const ws=new Workspace({a:'old',b:'old'});let reviews=0;const drafts=[];
  const result=await runWorkflow(plan([op('a','a','good'),op('b','b','bad')]),ws,{
    onDraft:(draft, round)=>drafts.push({files:draft.files,round}),
    verify:w=>w.read('a')==='good'&&w.read('b')==='good',
    review:async({files,report})=>{reviews++;assert.equal(files.a,'good');return report.ok?{accepted:true,findings:[]}:{accepted:false,findings:[{path:'b',reason:'wrong output'}],repair_plan:plan([{...op('fix','b','good'),edits:[{kind:'replace',path:'b',search:'bad',text:'good'}]}])};},
  });
  assert.equal(result.ok,true);assert.equal(result.first_pass,false);assert.equal(result.repairs,1);assert.equal(reviews,2);assert.deepEqual(ws.snapshot(),{a:'good',b:'good'});
  assert.equal(result.rounds[1].report.operations.length,1);
  assert.deepEqual(drafts,[{files:{a:'good',b:'bad'},round:0},{files:{a:'good',b:'good'},round:1}]);
});
test('review cannot approve a failing behavior gate and failed repairs preserve caller state',async()=>{
  const ws=new Workspace({a:'old'});
  const result=await runWorkflow(plan([op('a','a','bad')]),ws,{verify:()=>false,review:async()=>({accepted:true,findings:[]})});
  assert.equal(result.ok,false);assert.equal(ws.read('a'),'old');
});
test('uncertain Jev advice cannot downgrade tiers or move deterministic work to models',()=>{
  const p=plan([{...op('mechanical','a','new')},{id:'model',executor:'simple'}]);
  const advice={status:'uncertain',recommendation:{steps:[{id:'model',difficulty:'hard',source:'planner'}]},assessment:[{id:'model',uncertainty:['context_uncertain']}]};
  assert.equal(routeWithAdvice(p,advice).plan.operations[1].executor,'simple');
  advice.recommendation.steps[0].source='advisory_with_planner_floor';advice.assessment[0].uncertainty=[];
  const r=routeWithAdvice(p,advice);assert.equal(r.plan.operations[1].executor,'involved');assert.equal(r.plan.operations[0].executor,'deterministic');assert.equal(p.operations[1].executor,'simple');
});


test('mutating verifier cannot approve or publish a different candidate', async () => {
  const ws = new Workspace({a:'old'});
  const result = await runWorkflow(plan([op('change','a','draft')]), ws, {
    verify: candidate => { candidate.apply({a:'verified'}); return true; },
    review: async ({files}) => { assert.equal(files.a,'draft'); return {accepted:true,findings:[]}; },
  });
  assert.equal(result.ok,false); assert.equal(ws.read('a'),'old');
  assert.match(result.rounds[0].report.verification.error,/mutated/);
});
