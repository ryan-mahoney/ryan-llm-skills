// node --test scripts/spec-observe/session-activity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseSessionActivity,readSessionActivity} from './session-activity.mjs';
const line=(role,stopReason,content=[{type:'text',text:'Proposal complete.'}])=>JSON.stringify({type:'message',timestamp:'2026-10-12T11:23:10Z',message:{role,stopReason,content}})+'\n';
test('a final response proves idle, while later requests and tools invalidate idle',()=>{
 const final=line('assistant','stop');
 assert.equal(parseSessionActivity(final).state,'idle');
 assert.equal(parseSessionActivity(final).last_reply,'Proposal complete.');
 for(const next of [line('user'),line('assistant','toolUse',[{type:'toolCall',name:'bash'}]),line('toolResult')])assert.equal(parseSessionActivity(final+next).state,'working');
 for(const reason of ['error','aborted','length'])assert.equal(parseSessionActivity(final+line('assistant',reason)).state,'interrupted');
});
test('partial, branched, malformed and tool-bearing output never claims idle',()=>{
 const final=line('assistant','stop');
 for(const text of [final.slice(0,-1),final+'{bad}\n',final+'{"type":"branch_summary"}\n',line('assistant','stop',[{type:'toolCall'}]),line('assistant',undefined),line('assistant','stop',[])])assert.equal(parseSessionActivity(text).state,'unknown');
 assert.equal(parseSessionActivity('partial\n'+final,{partialStart:true}).state,'idle');
});
test('bounded tail reads retain final output and refuse symbolic links',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'sentinel-response-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'session.jsonl');await writeFile(path,line('user',null,[{type:'text',text:'x'.repeat(300000)}])+line('assistant','stop'));
 const read=await readSessionActivity(path);assert.equal(read.task_activity.state,'idle');assert.ok(read.size>256*1024);
 await symlink(path,join(root,'link'));assert.equal(await readSessionActivity(join(root,'link')),null);
});
