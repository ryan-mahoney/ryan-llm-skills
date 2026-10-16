#!/usr/bin/env node
// Paired application experiment: freeze one successful planner output, then run
// each executor strategy on a fresh copy of the exact initial Git tree.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { equivalentCost, costPolicy } from './cost.mjs';
import { gitSnapshot } from './snapshot.mjs';
import { Workspace, hash } from '../changeset/workspace.mjs';
import { compile, execute } from '../changeset/engine.mjs';
import { Budget, modelRuntime, editorAdapter } from '../changeset/models.mjs';
import { loadScenario, gradeCell } from '../spec-gym/core.mjs';
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {values:v}=parseArgs({options:{'allow-failed-source':{type:'boolean',default:false},campaign:{type:'string'},cell:{type:'string'},root:{type:'string'},budget:{type:'string'},repeat:{type:'string',default:'2'},strategy:{type:'string',multiple:true}}});
if(!v.campaign||!v.cell||!v.root||!v.budget)throw new Error('Required --campaign DIR --cell ID --root DIR --budget FILE [--repeat N]');
const campaign=resolve(v.campaign), run=JSON.parse(readFileSync(join(campaign,'run.json'),'utf8')), cell=run.cells.find(c=>c.id===v.cell);
if(!cell || (cell.outcome!=='passed' && !(v['allow-failed-source'] && cell.outcome==='failed')))throw new Error('Choose a passing source cell, or explicitly allow a failed source for a recovery experiment');
const frozenScenario=join(campaign,'frozen/scenarios/spec-changeset-plan',cell.scenario);
const scenario=loadScenario(existsSync(frozenScenario)?frozenScenario:join(repoRoot,'scenarios/spec-changeset-plan',cell.scenario));
const sourceExecution=JSON.parse(readFileSync(join(campaign,cell.id,'execution.json'),'utf8'));
if(!v['allow-failed-source'] && sourceExecution.workflow && !sourceExecution.workflow.first_pass)throw new Error('Choose a first-pass source plan; repairs are a different application workload');
if(scenario.version!==cell.version)throw new Error('Frozen workload version differs; run the current workload first');
const sourceRepo=join(campaign,cell.id,'repo'), sourcePackage=join(campaign,cell.id,'storage/projects/gym/specs',cell.scenario);
const plan=JSON.parse(readFileSync(join(sourcePackage,'change-plan.json'),'utf8')), contract=readFileSync(join(sourcePackage,'spec.md'),'utf8');
compile(plan);
const repeats=Number(v.repeat);if(!Number.isInteger(repeats)||repeats<1||repeats>10)throw new Error('Repeat must be 1..10');
const {files:original,modes}=gitSnapshot(sourceRepo);
const strategies=v.strategy??['parallel','serial','serial-model'];
if(!strategies.length||strategies.some(s=>!['parallel','parallel-fast','parallel-deepseek-32k','parallel-sol','serial','serial-model'].includes(s)))throw new Error('Unknown strategy');
const root=join(resolve(v.root),new Date().toISOString().replace(/[:.]/g,'-')+'-'+cell.scenario);mkdirSync(root,{recursive:true});
const codeFiles=['scripts/spec-gym/core.mjs',...['scripts/changeset','scripts/changeset-research'].flatMap(dir=>readdirSync(join(repoRoot,dir)).filter(n=>n.endsWith('.mjs')).map(n=>dir+'/'+n))].sort();
const candidateHash=hash(JSON.stringify(codeFiles.map(p=>[p,hash(readFileSync(join(repoRoot,p)))])));
const manifest={schema_version:1,candidate_sha256:candidateHash,node:process.version,planner_equivalent_cost_usd:equivalentCost(sourceExecution.receipts?.slice(0,1)),planner_elapsed_ms:sourceExecution.receipts?.[0]?.elapsed_ms??null,cost_policy:costPolicy,source_campaign:campaign,source_cell:cell.id,source_outcome:cell.outcome,source_first_pass:sourceExecution.workflow?.first_pass??null,source_planner:cell.model,scenario:cell.scenario,version:cell.version,plan_sha256:hash(JSON.stringify(plan)),source_sha256:hash(JSON.stringify({files:original,modes})),repeats,strategies,planner_cost_usd:JSON.parse(readFileSync(join(campaign,cell.id,'execution.json'),'utf8')).receipts[0]?.usage?.cost?.total??null};
writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest,null,2));
const runtime=await modelRuntime(),budget=new Budget(v.budget),results=[];
for(let repeat=1;repeat<=repeats;repeat++){
  const order=repeat%2?manifest.strategies:[...manifest.strategies].reverse();
  for(const strategy of order){
    const dir=join(root,`${strategy}-${repeat}`),repo=join(dir,'repo'),pkg=join(dir,'package');mkdirSync(pkg,{recursive:true});mkdirSync(repo,{recursive:true});
    new Workspace(original,null,modes).materialize(repo);
    const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});
    git('init','-q');git('config','user.name','Changeset Experiment');git('config','user.email','research@example.invalid');git('add','-A');git('commit','-qm','Fixture');
    writeFileSync(join(pkg,'change-plan.json'),JSON.stringify(plan,null,2));writeFileSync(join(pkg,'spec.md'),contract);
    const receipts=[],onReceipt=r=>{receipts.push(r);appendFileSync(join(dir,'calls.jsonl'),JSON.stringify(r)+'\n');},execution=scenario.scenario.execution;
    const adapter=selector=>editorAdapter({runtime,budget,selector,contract,maxTokens:strategy==='parallel-deepseek-32k'&&selector.startsWith('deepseek/')?32000:16000,timeoutMs:120000,onReceipt});
    const involved=strategy==='parallel-fast'?execution.involved_model.replace(/:(low|medium|high|xhigh|max|minimal|off)$/, '')+':off':execution.involved_model;
    const adapters={simple:adapter(execution.simple_model),involved:adapter(strategy==='parallel-sol'?cell.model:involved)};
    let actual=plan;
    if(strategy==='serial-model'){
      actual={schema_version:1,operations:compile(plan).map(op=>({...op,executor:'involved',instruction:op.executor==='deterministic'?`Apply these settled mechanical edits exactly, preserving other content: ${JSON.stringify(op.edits)}`:op.instruction}))};
      adapters.involved=adapter(cell.model);
    }
    console.log(`start ${cell.scenario} ${strategy} r${repeat}`);
    const ws=Workspace.load(repo),start=Date.now();
    const report=await execute(actual,ws,{concurrency:strategy.startsWith('parallel')?4:1,adapters});
    if(report.ok)ws.publish();
    const graded=gradeCell({outcome:report.ok?'finished':'failed',reason:report.ok?null:'execution failed'},scenario,{repo,checkout:repo,package:pkg});
    const result={strategy,repeat,outcome:graded.outcome,checks:graded.checks,report,receipts,equivalent_cost_usd:report.metrics.model_calls===0?0:receipts.length===report.metrics.model_calls?equivalentCost(receipts):null,elapsed_ms:Date.now()-start,cost_usd:receipts.length===report.metrics.model_calls&&receipts.every(r=>Number.isFinite(r.usage?.cost?.total)&&r.usage.cost.total>0)?receipts.reduce((n,r)=>n+r.usage.cost.total,0):null};
    results.push(result);writeFileSync(join(dir,'result.json'),JSON.stringify(result,null,2));
    writeFileSync(join(root,'results.json'),JSON.stringify({manifest,results},null,2));
    console.log(`finish ${strategy} ${result.outcome} ${(result.elapsed_ms/1000).toFixed(2)}s ${result.cost_usd===null?'unknown':result.cost_usd.toFixed(6)} USD`);
  }
}
console.log(root);
