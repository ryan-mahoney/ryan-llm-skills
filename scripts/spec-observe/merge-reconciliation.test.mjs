import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMergeReconciler, applicableMerge, MERGE_RETRY_MS, MERGE_POLL_MS, mergeBinding, validateMergeCache } from './merge-reconciliation.mjs';
// Run independently: node --test --test-name-pattern='merge reconciliation' scripts/spec-observe/merge-reconciliation.test.mjs
const head='a'.repeat(40), merged='b'.repeat(40), learning='c'.repeat(40);
function fixture(t){const pkg=realpathSync(mkdtempSync(join(tmpdir(),'merge-reconcile-')));t.after(()=>rmSync(pkg,{recursive:true,force:true}));return {package:pkg,primary:pkg,pr:{url:'https://github.com/o/r/pull/7',branch:'feature',base:'main'},commits:[learning],receipts:[['run','cancelled','2026-10-08T10:00:00Z']],checkpoints:[['waiting-worker','2026-10-08T10:05:00Z']]};}
test('merge reconciliation binds current branch despite stale draft publication and reuses stable evidence',async t=>{
 const input=fixture(t);let api=0,tip=head;
 const command=async(program,args)=>{if(program==='gh'){api++;return JSON.stringify({url:input.pr.url,state:'MERGED',mergedAt:'2026-10-08T11:00:00Z',mergeCommit:{oid:merged},headRefOid:head,headRefName:'feature',baseRefName:'main'});}return args[0]==='rev-parse'?tip:'';};
 const reconcile=createMergeReconciler({persist:true,now:()=>Date.parse('2026-10-08T12:00:00Z'),command,readBranch:async()=>({state:'present',head:tip})});
 const record=await reconcile(input);assert.equal(record.state,'merged');assert.equal(applicableMerge(record,input),true);
 assert.equal((await reconcile(input)).state,'merged');assert.equal(api,1);assert.equal(JSON.parse(readFileSync(join(input.package,'sentinel-merge.json'))).merge_commit,merged);
 tip='d'.repeat(40);assert.equal((await reconcile(input)).state,'unknown');assert.equal(api,2,'new branch commits invalidate durable merge');
 assert.equal(applicableMerge(record,{...input,receipts:[['new','completed','2026-10-08T11:30:00Z']]}),false);
 assert.equal(applicableMerge(record,{...input,checkpoints:[['ready','2026-10-08T11:30:00Z']]}),false);
});
test('merge reconciliation caches unknown API failure and bounds retries',async t=>{
 const input=fixture(t);let clock=Date.parse('2026-10-08T12:00:00Z'),api=0;
 const command=async(program)=>{if(program==='gh'){api++;throw Error('offline');}return head;};
 const reconcile=createMergeReconciler({persist:true,now:()=>clock,command,readBranch:async()=>({state:'present',head})});
 assert.equal((await reconcile(input)).state,'unknown');await reconcile(input);assert.equal(api,1);
 clock+=MERGE_RETRY_MS+1;await createMergeReconciler({persist:true,now:()=>clock,command,readBranch:async()=>({state:'present',head})})(input);assert.equal(api,2);
});

test('merge reconciliation persists observe cache on shadow transition without another API query',async t=>{
 const input=fixture(t);let api=0;const command=async(program,args)=>program==='gh'?(api++,JSON.stringify({url:input.pr.url,state:'MERGED',mergedAt:'2026-10-08T11:00:00Z',mergeCommit:{oid:merged},headRefOid:head,headRefName:'feature',baseRefName:'main'})):args[0]==='rev-parse'?head:'';
 await createMergeReconciler({persist:false,command,readBranch:async()=>({state:'present',head})})(input);
 assert.throws(()=>readFileSync(join(input.package,'sentinel-merge.json')));
 await createMergeReconciler({persist:true,command,readBranch:async()=>({state:'present',head})})(input);
 assert.equal(JSON.parse(readFileSync(join(input.package,'sentinel-merge.json'))).state,'merged');assert.equal(api,1);
});

// Run independently: node --test --test-name-pattern='lookup budget starts' scripts/spec-observe/merge-reconciliation.test.mjs
test('lookup budget starts with network work and cached merges survive another package exhausting it',async t=>{
 const input=fixture(t);let clock=Date.parse('2026-10-08T12:00:00Z'),api=0;
 const command=async(_program,_args,_cwd,timeout)=>{assert.equal(Number.isInteger(timeout),true);api++;clock+=2000.25;return JSON.stringify({url:input.pr.url,state:'MERGED',mergedAt:'2026-10-08T11:00:00Z',mergeCommit:{oid:merged},headRefOid:head,headRefName:'feature',baseRefName:'main'});};
 const reconcile=createMergeReconciler({now:()=>clock,monotonic:()=>clock,command,readBranch:async()=>({state:'present',head})});
 clock+=15000;assert.equal((await reconcile(input)).state,'merged','discovery before first lookup cannot exhaust its budget');
 for(let i=0;i<2;i++){const other=fixture(t);assert.equal((await reconcile(other)).state,'merged');}
 assert.equal((await reconcile(fixture(t))).reason,'merge-check-budget');
 assert.equal((await reconcile(input)).state,'merged','local validation reuses confirmed evidence after network budget exhaustion');assert.equal(api,3);
});

test('remote metadata supplies absent branch and base and detects a merged PR after branch deletion',async t=>{
 const input=fixture(t);input.pr.branch=null;input.pr.base=null;let api=0;
 const command=async()=>{api++;return JSON.stringify({url:input.pr.url,state:'MERGED',mergedAt:'2026-10-08T11:00:00Z',mergeCommit:{oid:merged},headRefOid:head,headRefName:'feature',baseRefName:'main'});};
 const reconcile=createMergeReconciler({command,readBranch:async()=>({state:'missing'})});
 const record=await reconcile(input);assert.equal(record.state,'merged');assert.equal(record.branch,'feature');assert.equal(record.base,'main');assert.equal(record.local_branch_absent,true);
 assert.equal((await reconcile(input)).state,'merged');assert.equal(api,1);
 const reopened={...input,receipts:[['new','running','2026-10-08T11:30:00Z']]};assert.equal((await reconcile(reopened)).state,'unknown');assert.equal(api,2);
});

// Run independently: node --test --test-name-pattern='historical bookkeeping' scripts/spec-observe/merge-reconciliation.test.mjs
test('confirmed merge survives historical bookkeeping but rejects a dispatch newer than the merge',async t=>{
 const input=fixture(t);let api=0;const command=async()=>{api++;return JSON.stringify({url:input.pr.url,state:'MERGED',mergedAt:'2026-10-08T11:00:00Z',mergeCommit:{oid:merged},headRefOid:head,headRefName:'feature',baseRefName:'main'});};
 const reconcile=createMergeReconciler({command,readBranch:async()=>({state:'present',head})});
 const confirmed=await reconcile(input);assert.equal(confirmed.state,'merged');
 const bookkeeping={...input,receipts:[['run','completed','2026-10-08T10:00:00Z'],['older','completed','2026-10-08T10:30:00Z']],checkpoints:[['complete','2026-10-08T10:45:00Z']]};
 assert.equal((await reconcile(bookkeeping)).state,'merged');assert.equal(applicableMerge(confirmed,bookkeeping),true);assert.equal(api,1,'old record reconciliation must not require another API query');
 const reopened={...bookkeeping,receipts:[...bookkeeping.receipts,['new','running','2026-10-08T11:30:00Z']]};
 assert.equal((await reconcile(reopened)).state,'unknown');assert.equal(api,2);assert.equal(applicableMerge(confirmed,reopened),false);
 assert.equal(applicableMerge(confirmed,{...bookkeeping,pr:{...bookkeeping.pr,url:'https://github.com/o/r/pull/8'}}),false);
});

function gitFixture(t, number = 7) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'local-pr-merge-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const git=(args,date='2026-10-08T09:00:00Z')=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date}}).trim();
 git(['init','-q','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);git(['remote','add','origin','git@github.com:o/r.git']);
 writeFileSync(join(root,'README'),'base');git(['add','README']);git(['commit','-qm','Initial fixture']);const base=git(['rev-parse','HEAD']);
 git(['checkout','-qb','feature']);writeFileSync(join(root,'feature'),'feature');git(['add','feature']);git(['commit','-qm','Feature fixture'],'2026-10-08T10:00:00Z');const head=git(['rev-parse','HEAD']);
 git(['checkout','-q','main']);git(['merge','--no-ff','feature','-m',`Merge pull request #${number} from o/feature`],'2026-10-08T11:00:00Z');const merge=git(['rev-parse','HEAD']);
 git(['update-ref','refs/remotes/origin/main',merge]);git(['symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/main']);
 const pkg=join(root,'.specs','feature');mkdirSync(pkg,{recursive:true});
 const input={package:pkg,primary:root,pr:{url:`https://github.com/o/r/pull/${number}`,branch:null,base:null},commits:[],receipts:[['old','running','2026-10-08T10:00:00Z']],checkpoints:[['waiting-worker','2026-10-08T10:05:00Z']]};
 let api=0;const command=async(program,args,cwd,timeout)=>{if(program==='gh'){api++;throw Object.assign(new Error('private token never retained'),{stderr:'error connecting to api.github.com secret-token'});}return execFileSync(program,args,{cwd,timeout,encoding:'utf8',maxBuffer:65536});};
 return {git,root,input,head,merge,base,command,get api(){return api;}};
}

// Run independently: node --test --test-name-pattern='fetched local PR merge' scripts/spec-observe/merge-reconciliation.test.mjs
test('fetched local PR merge proves scoped lifecycle before API and preserves reopen guards',async t=>{
 const f=gitFixture(t),input=f.input;const unknown={schema_version:1,package:input.package,binding:mergeBinding(input),url:input.pr.url,branch:null,tip:null,checked_at:'2026-10-08T12:00:00Z',state:'unknown',reason:'merge-check-unavailable'};
 writeFileSync(join(input.package,'sentinel-merge.json'),JSON.stringify(unknown));
 const reconcile=createMergeReconciler({command:f.command,now:()=>Date.parse('2026-10-08T12:00:00Z')});const record=await reconcile(input);
 assert.equal(record.state,'merged');assert.equal(record.reason,'local-pr-merge');assert.equal(record.merge_commit,f.merge);assert.equal(record.head,f.head);assert.equal(record.branch,'feature');assert.equal(record.base,'main');assert.equal(f.api,0);
 assert.equal(await validateMergeCache(record,input),true);
 const reopened={...input,receipts:[...input.receipts,['new','running','2026-10-08T11:30:00Z']]};const next=await reconcile(reopened);assert.equal(next.state,'unknown');assert.equal(next.local_reason,'newer-dispatch-or-checkpoint');assert.equal(next.reason,'api-network-unavailable');assert.ok(!JSON.stringify(next).includes('secret-token'));
 f.git(['update-ref','refs/remotes/origin/main',f.base]);assert.equal(await validateMergeCache(record,input),false,'rewinding fetched base invalidates cold and active cache');
});

test('local fallback rejects ancestor-only wrong PR, unpublished merges, wrong repository and advanced head',async t=>{
 const f=gitFixture(t);const now=()=>Date.parse('2026-10-08T12:00:00Z');
 const wrong={...f.input,pr:{...f.input.pr,url:'https://github.com/o/r/pull/8'}};assert.equal((await createMergeReconciler({command:f.command,now})(wrong)).local_reason,'local-pr-merge-not-found');
 f.git(['update-ref','refs/remotes/origin/main',f.base]);assert.equal((await createMergeReconciler({command:f.command,now})(f.input)).local_reason,'local-pr-merge-not-found','local main alone cannot certify publication');
 f.git(['update-ref','refs/remotes/origin/main',f.merge]);f.git(['remote','set-url','origin','git@github.com:o/other.git']);
 const mismatch={...f.input,receipts:[]};assert.equal((await createMergeReconciler({command:f.command,now})(mismatch)).local_reason,'local-repository-mismatch');
 f.git(['remote','set-url','origin','git@github.com:o/r.git']);f.git(['checkout','-q','feature']);writeFileSync(join(f.root,'feature'),'new work');f.git(['add','feature']);f.git(['commit','-qm','Continue feature'],'2026-10-08T11:30:00Z');
 assert.equal((await createMergeReconciler({command:f.command,now})(f.input)).local_reason,'local-head-mismatch');
});

test('cached local misses let later packages progress and expired unmerged evidence gets refreshed',async t=>{
 const packages=[fixture(t),fixture(t),fixture(t),gitFixture(t,10)];let clock=Date.parse('2026-10-08T12:00:00Z');
 const last=packages[3],command=async(program,args,cwd,timeout)=>{if(program==='gh')throw Error('connection unavailable');return last.command(program,args,cwd,timeout);};
 const scan=()=>createMergeReconciler({command,now:()=>clock,readBranch:async(primary,branch)=>primary===last.root?(await import('./merge-reconciliation.mjs')).readMergeBranch(primary,branch):({state:'present',head})});
 let reader=scan();for(const p of packages)await reader(p.input??p);
 reader=scan();let final;for(const p of packages)final=await reader(p.input??p);
 assert.equal(final.state,'merged','first three local misses must cool down so the fourth package gets a turn');
 const other=gitFixture(t,11),input=other.input;
 writeFileSync(join(input.package,'sentinel-merge.json'),JSON.stringify({schema_version:1,package:input.package,binding:mergeBinding(input),url:input.pr.url,branch:'feature',base:'main',tip:other.head,checked_at:new Date(clock).toISOString(),state:'unmerged',local_reason:'local-pr-merge-not-found'}));
 let calls=0;const authoritative=async(program,args,cwd,timeout)=>program==='git'?other.command(program,args,cwd,timeout):(calls++,JSON.stringify({url:input.pr.url,state:'MERGED',mergedAt:'2026-10-08T11:00:00Z',mergeCommit:{oid:other.merge},headRefOid:other.head,headRefName:'feature',baseRefName:'main'}));
 const r=createMergeReconciler({command:authoritative,now:()=>clock});assert.equal((await r(input)).state,'unmerged');assert.equal(calls,0);clock+=MERGE_POLL_MS+1;assert.equal((await r(input)).reason,'authoritative-pr');assert.equal(calls,1);
});
