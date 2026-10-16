import a from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [repo,pkg]=process.argv.slice(2);
const text=p=>readFileSync(join(repo,p),'utf8');
const json=p=>JSON.parse(text(p));
const moduleAt=p=>import(pathToFileURL(join(repo,p)).href);
const plan=JSON.parse(readFileSync(join(pkg,'change-plan.json'),'utf8'));
a.equal(text('keep.txt'),'preserve this exact text\n');
const c=await moduleAt('src/count.mjs'),n=await moduleAt('src/name.mjs'),s=await moduleAt('src/status.mjs'),d=await moduleAt('src/duration.mjs');
a.equal(c.countLabel(0),'No items');a.equal(c.countLabel(1),'1 item');a.equal(c.countLabel(23),'23 items');
for(const x of [-1,1.2,'2',NaN,Infinity])a.throws(()=>c.countLabel(x),RangeError);
a.equal(n.displayName('  Ada ',' Lovelace  '),'Ada Lovelace');a.equal(n.displayName('',' X '),'X');a.equal(n.displayName('  ',' '),'Anonymous');a.throws(()=>n.displayName(null,'x'),TypeError);
a.equal(s.statusLabel(true),'Enabled');a.equal(s.statusLabel(false),'Disabled');for(const x of [0,1,'true',null])a.throws(()=>s.statusLabel(x),TypeError);
a.equal(d.durationLabel(0),'0 minutes 0 seconds');a.equal(d.durationLabel(61),'1 minutes 1 seconds');a.equal(d.durationLabel(125),'2 minutes 5 seconds');for(const x of [-1,0.5,'2',Infinity])a.throws(()=>d.durationLabel(x),RangeError);
a.deepEqual(json('config.json'),{version:2,keep:true});a.equal(plan.operations.filter(o=>o.executor==='simple').length,4);a.ok(plan.operations.some(o=>o.executor==='deterministic'));

console.log('Behavior and preserved data passed');
