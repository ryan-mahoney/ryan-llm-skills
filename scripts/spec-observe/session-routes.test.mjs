import {request as httpRequest} from 'node:http';
// node --test scripts/spec-observe/session-routes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDashboardServer} from './dashboard.mjs';

test('session routes require operator origin, token, confirmation service and bounded JSON',async t=>{
 const root=await mkdtemp(join(tmpdir(),'sentinel-session-routes-'));let calls=0;
 const server=createDashboardServer({agentDir:root,storageRoot:root,publicHost:'dashboard.example',sessionControl:{describe:async id=>({assignment_id:id}),end:async input=>{calls++;return {state:'ended',assignment_id:input.assignment_id};}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const state=await (await fetch(base+'/api/state')).json();
 const headers={'Content-Type':'application/json','Origin':base,'X-Sentinel-Token':state.action_token};
 const raw=(path,options={})=>new Promise((resolve,reject)=>{
   const req=httpRequest(base+path,options,res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,json:async()=>JSON.parse(body)}));});
   req.on('error',reject);req.end(options.body);
 });
 const post=(h,body='{}')=>raw('/api/assignment-session/end',{method:'POST',headers:h,body});
 for(const bad of [{...headers,Origin:'https://evil.example'},{...headers,'X-Sentinel-Token':'wrong'},{...headers,'Content-Type':'text/plain'},{...headers,Origin:''},{...headers,'X-Forwarded-For':'100.1.2.3'}])assert.equal((await post(bad)).status,403);
 assert.equal((await post(headers,'x'.repeat(4097))).status,413);
 assert.equal((await post(headers,'{')).status,400);
 assert.equal(calls,0);
 assert.equal((await fetch(base+'/api/assignment-session/end')).status,405);
 const publicHeaders={...headers,Host:'dashboard.example',Origin:'https://dashboard.example','X-Forwarded-For':'100.1.2.3'};
 assert.equal((await post(publicHeaders,JSON.stringify({assignment_id:'fixture',confirm:true}))).status,200);
 assert.equal(calls,1);
 const publicState=await(await raw('/api/state',{headers:{Host:'dashboard.example'}})).json();
 assert.equal(publicState.thread_action_token,state.action_token);
});
