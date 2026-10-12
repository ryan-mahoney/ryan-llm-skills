// Isolated integration fixture: real dashboard HTTP/file routes, fake discussion workers.
import {createServer} from 'node:http';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDashboardServer} from '../dashboard.mjs';
import {setupStorage,createWorkspace} from '../../workspaces/store.mjs';
const root=await realpath(await mkdtemp(join(tmpdir(),'sentinel-solid-browser-')));
const storage=join(root,'storage');await setupStorage(storage);
const workspace=await createWorkspace(storage,{id:'fixture',name:'Browser fixture'});
await createWorkspace(storage,{id:'other',name:'Other workspace'});
const pkg=join(workspace.directory,'specs','browser');await mkdir(pkg,{recursive:true});
await writeFile(join(pkg,'work-tour.html'),'<html><body><h1>Isolated work tour</h1></body></html>');
await writeFile(join(pkg,'linked.md'),'# Linked evidence\n');
await writeFile(join(pkg,'spec.md'),'# Browser specification\n[Evidence](linked.md)\n<script>unsafe()</script>\n');
await mkdir(join(workspace.directory,'notes'),{recursive:true});
await writeFile(join(workspace.directory,'notes','browser.md'),'# Browser note\nA recorded note.\n');
const designDir=join(workspace.directory,'designs','demo');await mkdir(designDir,{recursive:true});
await writeFile(join(designDir,'brief.md'),'# Design fixture\n');
await mkdir(join(designDir,'screens'));
for(let i=1;i<=2;i++)await writeFile(join(designDir,`screens/0${i}-screen-${i}.html`),`<html><body><h1>Design screen ${i}</h1></body></html>`);
await writeFile(join(designDir,'design.json'),JSON.stringify({schema_version:1,design:'demo',title:'Design fixture',brief:'brief.md',viewport:{posture:'responsive',widths:[390,1280]},screens:[1,2].map(step=>({step,id:`screen-${step}`,file:`screens/0${step}-screen-${step}.html`,title:`Screen ${step}`,person:'Operator',job:'Review work',kind:'action',state:'ideal',primary_action:'Review work',captured:{}}))}));
const observerDir=join(root,'agent','spec-sentinel','a'.repeat(64),'observers');await mkdir(observerDir,{recursive:true});
const observerFile=join(observerDir,'a.json');
const thread1='11111111-1111-4111-8111-111111111111',thread2='22222222-2222-4222-8222-222222222222';
let threads=[{thread_id:thread1,workspace_id:'fixture',title:'Discussion one',state:'idle',queue:[],attention:null,queue_paused:false,history_only:false,generation:1,updated_at:new Date().toISOString()},{thread_id:thread2,workspace_id:'fixture',title:'Discussion two',state:'idle',queue:[],attention:null,queue_paused:false,history_only:false,generation:1}];
let entries=[{id:'entry-1',timestamp:new Date().toISOString(),message:{role:'assistant',content:[{type:'text',text:'Ready to discuss. <script>unsafe()</script>'}]}}];
let localOperator=false;
let tick=0,staleLaunch=true,failSend=false,delaySend=false,delayBrief=false;
const posts=[];
const subscribers=new Set();
const digest=()=>String(tick%2?'a':'b').repeat(64);
const copied=value=>JSON.parse(JSON.stringify(value));
const discussion={
 async list({workspace_id}){return {threads:workspace_id==='fixture'?copied(threads):[],invalid:[]};},
 async history({before}){if(before)return {entries:[{id:'entry-old',message:{role:'user',content:'Older message'}}],truncated:false,incomplete_tail:false};return {entries:copied(entries),truncated:true,incomplete_tail:false};},
 async create(input){posts.push({name:'create',input});const t={...threads[0],thread_id:randomUUID(),title:'New thread',queue:[]};threads=[t,...threads];return copied(t);},
 async send(input){posts.push({name:'send',input});if(delaySend)await new Promise(r=>setTimeout(r,700));if(failSend)throw Object.assign(new Error('Temporary fixture failure'),{code:'service-closed'});entries.push({id:randomUUID(),message:{role:'user',content:input.text}});return {state:'accepted'};},
 async stop(input){posts.push({name:'stop',input});threads=threads.map(t=>t.thread_id===input.thread_id?{...t,queue_paused:true,owns_response:false}:t);return {};},
 async resume(input){posts.push({name:'resume',input});threads=threads.map(t=>t.thread_id===input.thread_id?{...t,queue_paused:false,attention:null}:t);return {};},
 async discard(input){posts.push({name:'discard',input});threads=threads.map(t=>t.thread_id===input.thread_id?{...t,queue:[]}:t);return {};},
 async saveBrief(input){posts.push({name:'saveBrief',input});if(delayBrief)await new Promise(r=>setTimeout(r,700));return {brief:'briefs/fixture.md',handoff:{request_id:input.request_id},duplicate:false};},
 async previewAssignment(input){posts.push({name:'previewAssignment',input});return {record:{assignment_id:input.assignment_id,repository_id:'repo',execution_dir:root,brief:'briefs/fixture.md',model:'Pi default'},contractDigest:digest()};},
 async launchAssignment(input){posts.push({name:'launchAssignment',input});if(staleLaunch)throw Object.assign(new Error('Stale fixture preview'),{code:'stale-preview'});return {assignment:{assignment_id:input.assignment_id,state:'live',tmux_session:'fixture'},observation:{state:'live'}};},
 subscribe({thread_id},callback){subscribers.add({thread_id,callback});const current=()=>threads.find(t=>t.thread_id===thread_id);const timer=setInterval(()=>callback({type:'state',event:copied(current()??{}),workspace_id:'fixture',thread_id,generation:1}),700);return ()=>{clearInterval(timer);for(const item of subscribers)if(item.callback===callback)subscribers.delete(item);};},
};
const makeSnapshot=()=>{const now=new Date().toISOString();const run={workspace:'fixture',package:pkg,package_ref:'fixture/browser',assignment_id:'run-1',workflow_id:'workflow-1',execution:'running',workflow_state:'waiting-worker',is_current_assignment:true,activity:'Building the dashboard',obligation:'Keep editors stable',observed_at:now,coverage:{state:'complete',reasons:[]},spec_progress:{current_position:(tick%3)+1,total_steps:3,current_name:'Migrate view'},timing:{started_at:now,attempts:[]},evidence:{state:'recorded',verdict:'ready',scope:'declared-artifact',source:'work-tour.html',commit:'abc123',observed_at:now},epic:{epic:'demo',workspace:'fixture'}};
return {schema_version:1,observer_id:'fixture',state:'observing',published_at:now,snapshot:{workspace:'fixture',coverage:{state:'complete',observed_at:now,reasons:[]},runs:[run],recently_completed:[{...run,assignment_id:'landed',package:pkg,completion_basis:'merged-pr',completed_at:now,is_current_assignment:false}],assignments:[{assignment_id:'run-1',spec_package:'fixture/browser',workflow_id:'workflow-1',display:'live',state:'live',executionDir:root,terminal:'fixture',coverage:{state:'complete',reasons:[]},nextAction:'Attach to the terminal'}],assignment_coverage:{state:'complete',reasons:[]},epics:[{workspace:'fixture',epic:'demo',title:'Demo epic',state:'active',members:[{name:'browser',package:'browser',workspace:'fixture',status:'in-progress',waiting_on:[],attention:false}],summary:{total:1,merged:0,complete:0,attention:0},next:'browser',coverage:{state:'complete',reasons:[]}}]}};};
await writeFile(observerFile,JSON.stringify(makeSnapshot()));
const dashboard=createDashboardServer({agentDir:join(root,'agent'),storageRoot:storage,publicHost:'dashboard.example',discussion});
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');
 if(url.pathname==='/__fixture/control'){
  const action=url.searchParams.get('action');
  if(action==='fail-send')failSend=url.searchParams.get('value')==='true';
  if(action==='delay-send')delaySend=url.searchParams.get('value')==='true';
  if(action==='delay-brief')delayBrief=url.searchParams.get('value')==='true';
  if(action==='stale-launch')staleLaunch=url.searchParams.get('value')==='true';
  if(action==='attention')threads=threads.map((t,i)=>i===0?{...t,attention:'stalled',owns_response:true}:t);
  if(action==='queue')threads=threads.map((t,i)=>i===0?{...t,attention:'uncertain',queue:[{id:'uncertain-1',text:'Uncertain message',state:'uncertain'}]}:t);
  if(action==='clear-attention')threads=threads.map(t=>({...t,attention:null,queue:[],queue_paused:false,owns_response:false}));
  if(action==='tick')tick++;
  if(action==='local')localOperator=url.searchParams.get('value')==='true';
  if(action==='delta')for(const item of subscribers)item.callback({type:'delta',event:{delta:'Streamed reply <script>unsafe()</script>'},workspace_id:'fixture',thread_id:item.thread_id,generation:1});
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({posts,threads,tick}));return;
 }
 // Emulate the trusted Serve endpoint so the browser exercises thread-only tokens.
 if(!localOperator){req.headers.host='dashboard.example';if(req.headers.origin)req.headers.origin='https://dashboard.example';}
 dashboard.emit('request',req,res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const timer=setInterval(()=>{tick++;void writeFile(observerFile,JSON.stringify(makeSnapshot()));},1000);
console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,package:pkg,thread1,thread2}));
async function close(){clearInterval(timer);server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
