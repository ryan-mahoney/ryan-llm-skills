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
const m=await moduleAt('src/settings.mjs'); a.equal(m.apiEndpoint,'/v2/items'); a.equal(m.endpoint,undefined); a.equal(m.timeout,30);
a.equal(text('archive.txt'),'retained content\n'); a.equal(existsSync(join(repo,'old.txt')),false); a.equal(existsSync(join(repo,'obsolete.txt')),false); a.equal(text('notes.txt'),'Migration ready\n');
a.deepEqual(json('config.json'),{version:2,flags:{ready:true},keep:17});
a.equal(plan.operations.every(o=>o.executor==='deterministic'),true); a.ok(plan.operations.some(o=>o.depends_on.length));

console.log('Behavior and preserved data passed');
