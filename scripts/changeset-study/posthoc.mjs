#!/usr/bin/env node
// Additional contract checks discovered during source inspection. These are
// explicitly post-hoc; they never replace or feed back into the frozen campaign.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Workspace, hash } from '../changeset/workspace.mjs';
import { grade } from './sandbox.mjs';
import { evaluation } from './corpus.mjs';

const [runInput, outputInput] = process.argv.slice(2);
if (!runInput || !outputInput) throw new Error('Usage: posthoc RUN_DIRECTORY EXTERNAL_OUTPUT_DIRECTORY');
const run=resolve(runInput),output=resolve(outputInput);mkdirSync(output,{recursive:true});
const extra={
  'historical-session-version': String.raw`
put([message('a',null,'root'),message('b','a','abandoned'),message('c','a','active')]);
a.deepEqual((await f(file)).entries.map(x=>x.id),['a','c']);
put([{type:'session'},message('a',undefined,'first'),message(undefined,undefined,'last')]);
a.equal((await f(file)).leaf_id,'a');
for(const version of ['1',false,1.5]){
  put([{type:'session',version},message('a',null,'root'),message('b','a','abandoned'),message('c','a','active')]);
  a.deepEqual((await f(file)).entries.map(x=>x.id),['a','c']);
}
`,
  'historical-action-lookup': String.raw`
for(const name of ['missing','toString','constructor'])a.throws(()=>f(name),e=>e.code==='invalid-request'&&e.message==='An unknown request action was named.');
a.throws(()=>f('implement_spec',options),e=>e.code==='invalid-request'&&e.message==='A canonical entity is required.');
a.equal(f('build_screens',{...options,entity:'screen',observed:{designIndex:true,designBrief:true}}).launchable,true);
`,
  'formatting-library': String.raw`
for(const [name,values] of [['bytes',[1.2,Number.MAX_SAFE_INTEGER+1]],['ordinal',[0,1.2,Number.MAX_SAFE_INTEGER+1]],['percent',[1.01,-0.01]]]){
 const f=(await load('src/'+name+'.mjs'))[name];for(const x of values)a.throws(()=>f(x),RangeError);
}
a.equal((await load('src/mask.mjs')).mask('😀abcd'),'**abcd');
a.equal((await load('src/initials.mjs')).initials('ada\tgrace\nlinus'),'AGL');
`,
  'exact-account-report': String.raw`
const parser=(await load('src/parse.mjs')).parseLine;
a.deepEqual(parser('a_B-0,-0002'),{account:'a_B-0',cents:-2n});
a.equal(typeof parser('a,99999999999999999999999999999999999999').cents,'bigint');
for(const x of [null,3,'a,2\r','a,+2',' a,2','a,2 '])a.throws(()=>parser(x),TypeError);
`,
  'csv-row-parser': String.raw`
for(const [x,y]of [['""""',['"']],['"x\r\ny",z',['x\r\ny','z']],[' a , b ',[' a ',' b ']],['"a",,',['a','','']]])a.deepEqual(p(x),y);
for(const x of ['a\rb','"x"\t','a,"b"c','"""'])a.throws(()=>p(x),SyntaxError);
`,
  'shared-options': String.raw`
a.equal(m.parseBoolean('true'),true);a.equal(m.parseBoolean(undefined),false);
a.deepEqual(m.parseList(' z, A,z,A,a '),['z','A','a']);
for(const x of ['80\n','1e2','0x50','-1'])a.throws(()=>m.parsePort(x),RangeError);
`,
  'python-ledger': String.raw`
execFileSync('python3',['-c',"from ledger import summarize\nassert summarize([{'account':' ','cents':0},{'account':'é','cents':-10**90}]) == [{'account':' ','cents':0},{'account':'é','cents':-10**90}]"],{stdio:'inherit'});
`,
};
const tasks=JSON.parse(readFileSync(join(run,'tasks.json'),'utf8'));
const goldTasks=evaluation();
const sources={};
for(const task of tasks){
  const source=task.hidden+'\n'+(extra[task.id]??'');sources[task.id]=source;
  const gold=goldTasks.find(t=>t.id===task.id);
  if(hash(JSON.stringify(Object.fromEntries(Object.entries(gold).filter(([key])=>key!=='gold'))))!==hash(JSON.stringify(task)))throw new Error('Task changed since campaign');
  const dir=join(output,'gold',task.id);mkdirSync(dir,{recursive:true});new Workspace({...task.files,...gold.gold}).materialize(dir);
  const result=await grade(dir,source,{oracle:join(output,`gold-${task.id}.mjs`)});
  if(!result.ok)throw new Error(`Invalid supplemental oracle ${task.id}: ${result.output}`);
}
const rows=[];
for(const entry of readdirSync(run,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^\d+-/.test(e.name))){
  const cell=join(run,entry.name);if(!existsSync(join(cell,'result.json')))throw new Error('Campaign still running');
  const original=JSON.parse(readFileSync(join(cell,'result.json'),'utf8'));
  const files=JSON.parse(readFileSync(join(cell,'candidate.json'),'utf8'));
  if(hash(JSON.stringify(files))!==original.candidate_hash)throw new Error('Candidate hash mismatch');
  const dir=join(output,entry.name);mkdirSync(dir,{recursive:true});new Workspace(files).materialize(dir);
  const result=await grade(dir,sources[original.task],{oracle:join(output,entry.name+'.mjs')});
  rows.push({cell:entry.name,task:original.task,selector:original.selector,arm:original.arm,repetition:original.repetition,
    original_accepted:original.accepted,supplemental_accepted:original.accepted&&result.ok,candidate_hash:original.candidate_hash,
    oracle_hash:hash(sources[original.task]),result});
}
writeFileSync(join(output,'results.json'),JSON.stringify({label:'post-hoc contract coverage audit; no feedback or new model calls',rows},null,2));
console.log(JSON.stringify({cells:rows.length,new_failures:rows.filter(r=>r.original_accepted&&!r.supplemental_accepted).map(({result,...r})=>r)}));
