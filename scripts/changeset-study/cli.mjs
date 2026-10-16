#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { development, evaluation } from './corpus.mjs';
import { Workspace, hash } from '../changeset/workspace.mjs';
import { sandbox, grade } from './sandbox.mjs';
import { sdkRoot } from './client.mjs';
import { recoverAccounting } from './accounting.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2), command = args.shift();
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const all = key => args.flatMap((arg, i) => arg === key ? [args[i+1]] : []);
const phase = option('--phase', 'dev'), tasks = phase === 'eval' ? evaluation() : development();
if (!['dev','eval'].includes(phase)) throw new Error('Phase must be dev or eval');
const root = resolve(option('--root', '/tmp/changeset-study'));
if (!relative(repo, root).startsWith('..')) throw new Error('Run storage must be outside the checkout');
mkdirSync(root, { recursive: true });
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
function fileHashes(root) {
  const files=[];
  const scan=(dir,prefix='')=>{for(const name of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const rel=prefix+name.name;if(name.isDirectory())scan(join(dir,name.name),rel+'/');else if(name.isFile())files.push([rel,hash(readFileSync(join(dir,name.name)))]);}};
  scan(root);return files;
}
const sdkHashes=root=>Object.fromEntries(['pi-agent-core','pi-coding-agent','pi-ai'].map(pkg=>[pkg,fileHashes(join(root,pkg,'dist'))]));

if (command === 'validate') {
  const rows=[];
  for (const task of tasks) {
    const dir = join(root, `validate-${phase}`, task.id); mkdirSync(dir, { recursive: true });
    const oracle=join(dir,'hidden.mjs');
    for(const [kind, files] of [['initial',task.files],['gold',{...task.files,...task.gold}]]){
      const project=join(dir,kind);mkdirSync(project,{recursive:true});new Workspace(files).materialize(project);
      const hidden=await grade(project,task.hidden,{oracle});
      const visible=await sandbox(project,task.check??'node visible.mjs',{readOnly:true});
      const ok=kind==='gold'?hidden.ok&&visible.ok:!hidden.ok;
      const row={task:task.id,task_hash:hash(JSON.stringify(task)),kind,ok,hidden,visible};rows.push(row);console.log(JSON.stringify({task:task.id,kind,ok,...(!ok?{hidden,visible}:{})}));
    }
  }
  write(join(root,`validation-${phase}.json`),{corpus_hash:hash(JSON.stringify(tasks)),rows});if(rows.some(r=>!r.ok))process.exitCode=1;
} else if (command === 'run') {
  const ledger=option('--ledger');if(!ledger)throw new Error('--ledger required (existing campaign budget)');
  const models=all('--model');if(!models.length)throw new Error('Explicit --model selector required');
  const repetitions=Number(option('--repeat','2')), seed=option('--seed','changeset-study-20261016-v1');
  if(!Number.isInteger(repetitions)||repetitions<1||repetitions>10)throw new Error('Invalid repeat');
  const validation=JSON.parse(readFileSync(join(root,`validation-${phase}.json`),'utf8'));
  if(validation.corpus_hash!==hash(JSON.stringify(tasks))||validation.rows.length!==tasks.length*2||tasks.some(task=>['initial','gold'].some(kind=>validation.rows.filter(r=>r.task===task.id&&r.kind===kind&&r.task_hash===hash(JSON.stringify(task))&&r.ok).length!==1)))throw new Error('Current gold/initial validation required');
  const pinnedSdk=sdkRoot(), sdkFingerprint=sdkHashes(pinnedSdk);
  const run=join(root,new Date().toISOString().replace(/[:.]/g,'-')+'-'+phase);mkdirSync(run);
  const frozen=join(run,'frozen');mkdirSync(join(frozen,'scripts'),{recursive:true});
  for(const folder of ['changeset-study','changeset','changeset-research'])cpSync(join(repo,'scripts',folder),join(frozen,'scripts',folder),{recursive:true});
  mkdirSync(join(frozen,'skills/spec-changeset-plan'),{recursive:true});cpSync(join(repo,'skills/spec-changeset-plan/SKILL.md'),join(frozen,'skills/spec-changeset-plan/SKILL.md'));
  write(join(run,'tasks.json'),tasks.map(({gold,...task})=>task));
  const files=fileHashes(frozen);
  const schedule=[];
  for(const task of tasks)for(const selector of models)for(let repetition=0;repetition<repetitions;repetition++){
    const bit=parseInt(hash(seed+task.id+selector).slice(0,2),16)%2;
    const arms=(bit+repetition)%2?['agent','changeset']:['changeset','agent'];
    schedule.push({task:task.id,selector,repetition,arms,order:hash(seed+task.id+selector+repetition)});
  }
  schedule.sort((a,b)=>a.order.localeCompare(b.order));
  write(join(run,'manifest.json'),{schema_version:1,phase,seed,repetitions,models,created_at:new Date().toISOString(),node:process.version,
    revision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
    frozen_files:files,corpus_hash:hash(JSON.stringify(tasks)),sdk:relative(resolve(sdkRoot(),'../../..'),sdkRoot()),
    sdk_files:sdkFingerprint,schedule});
  console.log(JSON.stringify({run,cells:schedule.length*2}));
  let index=0;
  for(const pair of schedule)for(const arm of pair.arms){
    if(hash(JSON.stringify(sdkHashes(pinnedSdk)))!==hash(JSON.stringify(sdkFingerprint)))throw new Error('Pinned SDK bytes changed; campaign stopped');
    const directory=join(run,`${String(index++).padStart(3,'0')}-${pair.task}-${arm}`);mkdirSync(directory);
    const job={task:structuredClone(tasks.find(t=>t.id===pair.task)),arm,selector:pair.selector,ledger:resolve(ledger),directory,
      plannerPrompt:readFileSync(join(frozen,'skills/spec-changeset-plan/SKILL.md'),'utf8')};delete job.task.gold;
    write(join(directory,'job.json'),job);
    const began=performance.now();
    const outcome=await new Promise((done,reject)=>{
      const child=spawn(process.execPath,[join(frozen,'scripts/changeset-study/worker.mjs'),join(directory,'job.json')],{stdio:['ignore','pipe','pipe'],detached:true,
        env:{...process.env,CHANGESET_STUDY_SDK_ROOT:pinnedSdk,CHANGESET_MODEL_RUNTIME:join(pinnedSdk,'pi-coding-agent/dist/core/model-runtime.js')}});
      let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output=(output+b).slice(-8000);});
      const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},335000);
      child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);done({code,output});});
    });
    const path=join(directory,'result.json');
    const result=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{task:pair.task,arm,selector:pair.selector,outcome:'blocked',accepted:false,error:outcome.output};
    Object.assign(result,recoverAccounting(directory,ledger));
    result.process_elapsed_ms=performance.now()-began;result.repetition=pair.repetition;result.order_in_pair=pair.arms.indexOf(arm);
    if(result.process_elapsed_ms>300000){result.accepted=false;result.outcome='timed-out';}
    result.capped_time_to_success_ms=result.accepted?result.process_elapsed_ms:300000;write(path,result);
    console.log(JSON.stringify({index,task:pair.task,arm,model:pair.selector,accepted:result.accepted,outcome:result.outcome,seconds:result.process_elapsed_ms/1000,calls:result.model_calls,error:result.error??null}));
    const budget=JSON.parse(readFileSync(ledger,'utf8'));if(budget.entries.reduce((n,e)=>n+(e.charged_usd??e.reserved_usd),0)>=49)throw new Error('Study stopped at conservative budget threshold');
  }
  console.log(JSON.stringify({completed:run}));
} else throw new Error('Use validate or run with --phase dev|eval --root external-directory');
