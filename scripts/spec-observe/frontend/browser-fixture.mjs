// Isolated integration fixture: real dashboard HTTP/file routes, fake discussion workers.
import {createServer} from 'node:http';
import {mkdtemp,realpath,mkdir,writeFile,rm,rename,access} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createDashboardServer} from '../dashboard.mjs';
import {createReferenceCatalog} from '../../workspaces/references.mjs';
import {resolveAssignment,prepareAssignmentSpecTarget} from '../../workspaces/assignments.mjs';
import {setupStorage,createWorkspace,fetchWorkspace,resolveRepositoryPath} from '../../workspaces/store.mjs';
import {newPackage} from '../../spec-location/index.mjs';
const plannedLaunch=process.env.SENTINEL_PLANNED_LAUNCH==='1';
const specsReadiness=process.env.SENTINEL_SPECS_READINESS==='1';
const filesFixture=process.env.SENTINEL_REPOSITORY_FILES==='1';
const root=await realpath(await mkdtemp(join(tmpdir(),'sentinel-solid-browser-')));
const storage=join(root,'storage');await setupStorage(storage);
const workspace=await createWorkspace(storage,{id:'fixture',name:'Browser fixture'});
await createWorkspace(storage,{id:'other',name:'Other workspace'});
const mismatchDirectory=await createWorkspace(storage,{id:'physical',name:'Physical directory'});
const neighborDirectory=await createWorkspace(storage,{id:'alpha',name:'Neighbor alpha'});
await writeFile(join(mismatchDirectory.directory,'kit.yaml'),'version: 1\nid: alpha\nname: Alpha kit\nrepositories: []\n');
await writeFile(join(neighborDirectory.directory,'kit.yaml'),'version: 1\nid: physical\nname: Physical neighbor\nrepositories: []\n');
const checkout=join(root,'checkout');await mkdir(checkout,{recursive:true});execFileSync('git',['init','--quiet',checkout],{stdio:'ignore'});
const secondCheckout=join(root,'checkout-two');if(plannedLaunch){await mkdir(secondCheckout,{recursive:true});execFileSync('git',['init','--quiet',secondCheckout],{stdio:'ignore'});}
// Real spec-worktree preparation needs a base commit in each isolated repo.
if(plannedLaunch)for(const directory of [checkout,secondCheckout])execFileSync('git',['-C',directory,'-c','user.name=Browser fixture','-c','user.email=fixture@example.invalid','commit','--quiet','--allow-empty','-m','Initialize fixture repository'],{stdio:'ignore'});
// Checkout-scoped suggestion target: visible only when file suggestions are
// requested for the fixture-repo target, never from the whole workspace.
await writeFile(join(checkout,'fixture-repo-plan.md'),'# Fixture repository plan\nCheckout-scoped suggestion target.\n');
const docsCheckout=join(root,'docs-checkout');await mkdir(docsCheckout,{recursive:true});execFileSync('git',['init','--quiet',docsCheckout],{stdio:'ignore'});
await writeFile(join(docsCheckout,'fixture-docs-guide.md'),'# Fixture docs guide\nSecond-repository suggestion target.\n');
// Repository map for dispatch suggestions: mirrors the production target
// owner, resolving the requested repository to its execution directory so a
// retained target change retargets both the request and the file choices.
const dispatchRepos=[{id:'fixture-repo',path:checkout},{id:'fixture-docs',path:docsCheckout}];
await mkdir(join(workspace.directory,'context'),{recursive:true});
await mkdir(join(workspace.directory,'briefs'),{recursive:true});
await writeFile(join(workspace.directory,'context','project-context.md'),'# Project context\nBrowser context note.\n');
await writeFile(join(workspace.directory,'briefs','browser.md'),'# Browser brief\nA recorded brief.\n');
const contextPath=process.env.SENTINEL_NONCANONICAL_CONTEXT==='1'
 ? `${workspace.directory}/../fixture//context/./unused/../project-context.md`
 : 'context/project-context.md';
const contextArtifactFixture=process.env.SENTINEL_NONCANONICAL_CONTEXT==='1';
// Gated repository artifact fixture for the Files context/artifact journey: the
// real store resolves this record against the healthy kit's fixture-repo checkout
// and the existing fixture-repo-plan.md bytes. The default fixture is unchanged
// when neither gated flag is set.
if(filesFixture||contextArtifactFixture){
 await mkdir(join(workspace.directory,'artifacts'),{recursive:true});
 await writeFile(join(workspace.directory,'artifacts','browser-plan.json'),JSON.stringify({schema_version:1,artifact_id:'browser-plan',title:'Browser repository plan',kind:'repository',target:{repository_id:'fixture-repo',path:'fixture-repo-plan.md'}},null,2));
}
const healthyKit=`version: 1\nid: fixture\nname: Browser fixture\nexecution_host: ${hostname()}\nrepositories:\n  - id: fixture-repo\n    path: ${checkout}\n    role: Browser verification\n  - id: fixture-docs\n    path: ${docsCheckout}\n    role: Second suggestion target\n${plannedLaunch?`  - id: fixture-repo-two\n    path: ${secondCheckout}\n    role: Browser alternate\n`:''}context:\n  - ${contextPath}\n`;
await writeFile(join(workspace.directory,'kit.yaml'),healthyKit);
if(plannedLaunch){const created=await newPackage({root:storage,workspace:'fixture',slug:'browser',targets:[{id:'fixture-repo'},{id:'fixture-repo-two'}]});if(!created.ok)throw new Error(`Planned fixture package setup failed: ${created.code} ${created.message}`);}
if(plannedLaunch){const created=await newPackage({root:storage,workspace:'fixture',slug:'other-browser',targets:[{id:'fixture-repo'},{id:'fixture-repo-two'}]});if(!created.ok)throw new Error(`Planned fixture package setup failed: ${created.code} ${created.message}`);}
const pkg=join(workspace.directory,'specs','browser');await mkdir(pkg,{recursive:true});
const otherPkg=join(workspace.directory,'specs','other-browser');if(plannedLaunch){await mkdir(otherPkg,{recursive:true});await writeFile(join(otherPkg,'spec.md'),'# Other planned browser specification\n');}
// Specs readiness extras (gated): waiting, incomplete, legacy-unknown and
// decision packages so the Ready list/detail states have real observed rows
// without changing the review/result fixture inventory. Create them through
// the same lifecycle as browser/other-browser so Resume planning resolves a
// real prepared package (scope/locations), then seed the observation files.
const readinessSlugs=specsReadiness?['waiting-browser','incomplete-browser','legacy-browser','decision-browser']:[];
const readinessPackageDirs=readinessSlugs.map(slug=>join(workspace.directory,'specs',slug));
if(specsReadiness)for(const slug of readinessSlugs){
 const created=await newPackage({root:storage,workspace:'fixture',slug,targets:[{id:'fixture-repo'}]});
 if(!created.ok)throw new Error(`Specs readiness fixture package setup failed: ${created.code} ${created.message}`);
 await writeFile(join(workspace.directory,'specs',slug,'spec.md'),`# ${slug} specification\n`);
}
if(specsReadiness){await writeFile(join(workspace.directory,'specs','waiting-browser','spec-prepare.md'),'# Preparation report\n');await writeFile(join(workspace.directory,'specs','incomplete-browser','proposal.md'),'---\ncritique_recommended: false\n---\n\n# Incomplete browser proposal\nA recorded proposal resumes without re-architecture.\n');await writeFile(join(workspace.directory,'specs','decision-browser','spec-prepare.md'),'# Preparation report\n');}
await writeFile(join(pkg,'work-tour.html'),'<html><body><h1>Isolated work tour</h1></body></html>');
await writeFile(join(pkg,'linked.md'),'# Linked evidence\n');
await writeFile(join(pkg,'spec.md'),'# Browser specification\n[Evidence](linked.md)\n<script>unsafe()</script>\n');
if(plannedLaunch)await writeFile(join(pkg,'spec.md'),'# Browser specification\n\nPR 42 plans this package for the fixture repository.\n');
const alphaKitPackage=join(mismatchDirectory.directory,'specs','alpha-kit');await mkdir(alphaKitPackage,{recursive:true});
await writeFile(join(alphaKitPackage,'spec.md'),'# Alpha kit specification\n');
await writeFile(join(alphaKitPackage,'work-tour.html'),'<html><body><h1>Alpha kit tour</h1></body></html>');
const physicalKitPackage=join(neighborDirectory.directory,'specs','physical-kit');await mkdir(physicalKitPackage,{recursive:true});
const packageIdentity={package:pkg,mismatchPackage:physicalKitPackage,mismatchAlphaPackage:alphaKitPackage};
await writeFile(join(physicalKitPackage,'spec.md'),'# Physical kit specification\n');
await writeFile(join(physicalKitPackage,'work-tour.html'),'<html><body><h1>Physical kit tour</h1></body></html>');
await mkdir(join(workspace.directory,'notes'),{recursive:true});
await writeFile(join(workspace.directory,'notes','browser.md'),'# Browser note\nA recorded note.\n');
// Gated Files reader bytes: real markdown/JSON/code/image/HTML/binary kinds for
// the files-workspace case only; the default fixture stays unchanged.
if(filesFixture){
 const filesDir=join(workspace.directory,'files');await mkdir(filesDir,{recursive:true});
 const overflowLines=Array.from({length:72},(_,index)=>`Line ${index+1}: independent reader overflow fixture text.`).join('\n');
 await writeFile(join(filesDir,'overview.md'),`# Fixture overview\n\n${overflowLines}\n\n<script>window.__fixtureUnsafe=true</script>\n`);
 await writeFile(join(filesDir,'valid.json'),JSON.stringify({schema_version:1,name:'fixture',items:[1,2,3],nested:{ok:true}},null,2));
 await writeFile(join(filesDir,'data.json'),JSON.stringify({schema_version:1,kind:'continuity',items:[1,2,3],nested:{stable:true}},null,2));
 await writeFile(join(filesDir,'invalid.json'),'{"broken": [1, 2,\n');
 await writeFile(join(filesDir,'indented.py'),'def fixture(value):\n    if value:\n        return {\n            "value": value,\n        }\n    return None\n\n\nfixture(1)\n');
 const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');
 await writeFile(join(filesDir,'pixel.png'),pixel);
 await writeFile(join(filesDir,'sandbox.html'),'<!doctype html><html><body><h1>Sandbox fixture</h1><script>document.body.dataset.fixtureScript="ran"</script></body></html>');
 const bundle=Buffer.alloc(2048,0x42);bundle[0]=0;bundle[1]=0x50;bundle[2]=0x4b;
 await writeFile(join(filesDir,'capture-bundle.zip'),bundle);
 const assetsDir=join(pkg,'assets');await mkdir(assetsDir,{recursive:true});
 await writeFile(join(assetsDir,'pixel.png'),pixel);
 await writeFile(join(assetsDir,'linked-assets.md'),'# Package assets\n\n![Pixel](pixel.png)\n\n[Spec](../spec.md)\n');
 await writeFile(join(assetsDir,'sandbox.html'),'<!doctype html><html><body><h1>Package sandbox</h1><img src="pixel.png" alt="Pixel"><script>document.body.dataset.fixtureScript="ran"</script></body></html>');
}
const designDir=join(workspace.directory,'designs','demo');await mkdir(designDir,{recursive:true});
await writeFile(join(designDir,'brief.md'),'# Design fixture\n');
await mkdir(join(designDir,'screens'));
for(let i=1;i<=2;i++)await writeFile(join(designDir,`screens/0${i}-screen-${i}.html`),`<html><body><h1>Design screen ${i}</h1></body></html>`);
await writeFile(join(designDir,'design.json'),JSON.stringify({schema_version:1,design:'demo',title:'Design fixture',brief:'brief.md',viewport:{posture:'responsive',widths:[390,1280]},screens:[1,2].map(step=>({step,id:`screen-${step}`,file:`screens/0${step}-screen-${step}.html`,title:`Screen ${step}`,person:'Operator',job:'Review work',kind:'action',state:'ideal',primary_action:'Review work',captured:{}}))}));
const observerDir=join(root,'agent','spec-sentinel','a'.repeat(64),'observers');await mkdir(observerDir,{recursive:true});
const observerFile=join(observerDir,'a.json');
const mismatchObserverFile=join(observerDir,'b.json');
const skillPath=plannedLaunch?join(root,'.agents','skills','spec-end-to-end','SKILL.md'):join(root,'skills','fixture-skill','SKILL.md');await mkdir(join(skillPath,'..'),{recursive:true});
await writeFile(skillPath,plannedLaunch?'---\nname: spec-end-to-end\ndescription: Implement a spec package end to end.\n---\n# Spec end to end fixture\nUse the attached brief and the referenced package.\n':'---\nname: fixture-skill\ndescription: Plan work from the chosen brief.\n---\n# Fixture skill\nApply the selected workflow and read references relative to this skill directory.\n');
// Bound plan/review fixture skills plus the generic fallback live under the
// fake home so the real resolver can find each requested skill file.
if(plannedLaunch)for(const skillName of ['spec-architect-initial','spec-architect-critics','spec-write','fixture-skill']){const boundSkillPath=join(root,'.agents','skills',skillName,'SKILL.md');await mkdir(join(boundSkillPath,'..'),{recursive:true});await writeFile(boundSkillPath,`---\nname: ${skillName}\ndescription: Bound package review fixture.\n---\n# ${skillName} fixture\n`);}
const piPath=join(root,'pi');await writeFile(piPath,'#!/bin/sh\nexit 0\n',{mode:0o755});
const referenceCatalog=createReferenceCatalog({home:root,agentDir:join(root,'agent'),skillLoader:()=>({skills:[{name:plannedLaunch?'spec-end-to-end':'fixture-skill',description:plannedLaunch?'Implement a spec package end to end.':'Plan work from the chosen brief.',filePath:skillPath,baseDir:join(skillPath,'..'),sourceInfo:{scope:'user'}}],diagnostics:[]})});
const savedBriefs=new Map(),launchResolutions=new Map();let delaySuggestions=false,briefWritesPending=0,completedBriefWrites=0;
const thread1='11111111-1111-4111-8111-111111111111',thread2='22222222-2222-4222-8222-222222222222',thread3='44444444-4444-4444-8444-444444444444';
// thread1 carries a recorded repository target so Prepare can pass the recorded
// repository identity; thread2 stays workspace-bound with no route target;
// thread3 stores a worktree path that maps to the fixture-docs checkout and is
// displayed as the stored path, never as an inferred repository id.
let threads=[{thread_id:thread1,workspace_id:'fixture',title:'Discussion one',state:'idle',queue:[],attention:null,queue_paused:false,history_only:false,generation:1,updated_at:new Date().toISOString(),target:{kind:'repository',repository_id:'fixture-repo'}},{thread_id:thread2,workspace_id:'fixture',title:'Discussion two',state:'idle',queue:[],attention:null,queue_paused:false,history_only:false,generation:1,target:{kind:'workspace'}},{thread_id:thread3,workspace_id:'fixture',title:'Discussion worktree',state:'idle',queue:[],attention:null,queue_paused:false,history_only:false,generation:1,target:{kind:'worktree',path:docsCheckout}}];
let entries=[{id:'entry-1',timestamp:new Date().toISOString(),message:{role:'assistant',content:[{type:'text',text:'Ready to discuss. <script>unsafe()</script>'}]}}];
let localOperator=false;
let tick=0,staleLaunch=!plannedLaunch,failSend=false,delaySend=false,delayBrief=false,delayDispatchBrief=false,failDispatchBrief=false,delayDispatchSuggestions=false;
// Route-drafts only additive controls: deliberate held/rejected /api/threads
// reads and an opt-in long transcript. Every default stays unchanged.
let holdThreads=false,holdThreadsWorkspace='',failThreads=false,longHistory=false,holdSend=false,incompleteTail=false,invalidRecords=false,listFailStatus=0,historyFailStatus=0;
// Response-state controls for screens 20-25: one named-state switch keeps the
// queued/absent-owner/history-only/responding shapes together; the default
// fixture stays unchanged.
let responseState='default';
// EV-7 new-thread creation controls: delay-create holds the next create until
// release-create; fail-create rejects it. Both default off, so the ordinary
// immediate create path is unchanged.
let delayCreate=false,failCreate=false;
// Review/dispatch controls: hold pending responses until both widths are
// captured, then release; typed refusals drive each presentation state.
let holdDispatchPreview=false,holdDispatchLaunch=false,dispatchPreviewRefusal='none',dispatchLaunchRefusal='none';
// Result controls: the launch reply selects the recorded outcome, and the
// observer snapshot exposes a published assignment as an observed row.
let dispatchLaunchOutcome='live';
// Bound review conflicts: a published holding run supplies the identity the
// run-active refusal opens; refused dispatches never start a worker.
let reviewHoldingRun=null;
const launchedAssignments=new Map();
const dispatchPreviewWaiters=[],dispatchLaunchWaiters=[],threadWaiters=[],sendWaiters=[],createWaiters=[];
const busyAssignmentId='b42f1903-9508-46c1-a4aa-a0842dbce617';
const waitForRelease=waiters=>new Promise(resolve=>waiters.push(resolve));
const releaseWaiters=waiters=>{const pending=waiters.splice(0);for(const resolve of pending)resolve();};
const posts=[];
// Returned conversation identities: the checker asserts the exact created id
// and target instead of guessing a row.
const createdThreads=[];
// Fixture-owned resolver diagnostics: every completed preview/launch resolution
// records its inspected input and resulting record facts, plus the launch
// expectedDigest comparison. Exposed read-only through /__fixture/control; it
// never feeds resolution, digest comparison or launch outcomes.
const resolverDiagnostics=[];
const diagnosticInputFacts=input=>({request_id:input?.request_id??null,assignment_id:input?.assignment_id??null,expected_digest:input?.expectedDigest??null,instructions:input?.instructions??null,target:input?.target??input?.repository_id??null});
const diagnosticRecordFacts=record=>record?({assignment_id:record.assignment_id??null,contract_digest:record.contract_digest??null,brief:record.brief??null,brief_sha256:record.brief_sha256??null,instructions:record.instructions??null,execution_dir:record.execution_dir??null,repository_id:record.repository_id??null,skill:record.skill??null,tmux_socket:record.tmux_socket??null,tmux_session:record.tmux_session??null,pi_session_dir:record.pi_session_dir??null}):null;
// `resolution` is resolveAssignment's outer result: record facts come from its
// nested `record`, and the entry keeps the resolution's own contractDigest.
const noteResolution=(name,input,resolution,extra={})=>{resolverDiagnostics.push({name,at:Date.now(),input:diagnosticInputFacts(input),record:diagnosticRecordFacts(resolution?.record??resolution??null),contract_digest:resolution?.contractDigest??null,...extra});if(resolverDiagnostics.length>80)resolverDiagnostics.splice(0,resolverDiagnostics.length-80);};
const boundary={catalogFail:false,detailFail:false,stateFail:false,catalogDelayMs:0,detailDelayMs:0,detailDelayId:'',stateDelayMs:0,stateClockOffsetMs:0,catalogMode:'healthy'};
const boundaryLog=[];
const activeBoundary=new Map();
let boundaryAttempt=0;
const startBoundary=(kind,id)=>{const attempt=++boundaryAttempt;activeBoundary.set(attempt,{kind,id});boundaryLog.push({kind,id,attempt,phase:'start',at:Date.now()});return attempt;};
const finishBoundary=(attempt,phase)=>{const active=activeBoundary.get(attempt);if(!active)return;activeBoundary.delete(attempt);boundaryLog.push({...active,attempt,phase,at:Date.now()});};
const numberValue=(value,min,max)=>{const parsed=Number(value);return Number.isFinite(parsed)?Math.min(max,Math.max(min,Math.trunc(parsed))):0;};
const projectsDir=join(storage,'projects');
const projectsBackup=join(root,'projects-backup');
const invalidKitDir=join(projectsDir,'broken');
const partialKit=`version: 1\nid: fixture\nname: Browser fixture\nrepositories:\n  - id: fixture-repo\n    path: ${checkout}\n    role: Browser verification\n  - id: fixture-missing\n    path: ${join(root,'checkout-missing')}\n    role: Missing checkout\ncontext:\n  - ${contextPath}\n  - ${join(root,'outside-context.md')}\n`;
const exists=async path=>{try{await access(path);return true;}catch{return false;}};
const resetBoundaryControls=()=>{boundary.catalogFail=false;boundary.detailFail=false;boundary.stateFail=false;boundary.catalogDelayMs=0;boundary.detailDelayMs=0;boundary.detailDelayId='';boundary.stateDelayMs=0;boundary.stateClockOffsetMs=0;boundary.catalogMode='healthy';delayDispatchBrief=false;failDispatchBrief=false;delayDispatchSuggestions=false;holdDispatchPreview=false;holdDispatchLaunch=false;dispatchPreviewRefusal='none';dispatchLaunchRefusal='none';dispatchLaunchOutcome='live';launchedAssignments.clear();delayCreate=false;failCreate=false;holdThreadsWorkspace='';incompleteTail=false;invalidRecords=false;listFailStatus=0;historyFailStatus=0;releaseWaiters(dispatchPreviewWaiters);releaseWaiters(dispatchLaunchWaiters);releaseWaiters(createWaiters);if(activeBoundary.size===0){boundaryLog.length=0;boundaryAttempt=0;}};
// Response-state shapes for screens 20-25. The queued shape keeps one
// persisted queue_position on the selected row and names thread2 as the
// in-scope owner; queued-absent leaves no owner row so the surface must use
// the generic another-thread copy. Paused, paused-owned and queued-blocked carry
// production-shaped null positions (paused queues and blocked heads are
// excluded from the server FIFO); paused-owned keeps queue_paused with the
// response lease still held (owns_response) plus a delivering head and queued
// follower; stalled-elsewhere keeps the selected row
// unowned while thread2 owns the slot. default/clear restores the base rows.
const responseStatePatch=state=>state==='responding'?{state:'active',owns_response:true}:state==='queued'||state==='queued-absent'?{queue:[{id:'queued-1',text:'Use the existing file reader contract and keep the current source visible.',state:'queued',queue_position:2}]}:state==='paused'?{queue:[{id:'queued-1',text:'Use the existing file reader contract and keep the current source visible.',state:'queued',queue_position:null}],queue_paused:true}:state==='paused-owned'?{queue:[{id:'delivering-head',text:'Delivering head message.',state:'delivering'},{id:'queued-1',text:'Use the existing file reader contract and keep the current source visible.',state:'queued',queue_position:null}],queue_paused:true,owns_response:true}:state==='queued-blocked'?{queue:[{id:'blocked-head',text:'Delivering head message.',state:'delivering'},{id:'queued-1',text:'Use the existing file reader contract and keep the current source visible.',state:'queued',queue_position:null}]}:state==='history-only'?{history_only:true}:state==='stalled'?{attention:'stalled',owns_response:true}:state==='stalled-unowned'?{attention:'stalled'}:state==='stalled-elsewhere'?{attention:'stalled'}:state==='start-failed'?{attention:'start-failed'}:{};
const applyResponseState=state=>{responseState=state;const first=threads[0].thread_id,second=threads[1]?threads[1].thread_id:null;const base=responseStatePatch(state);threads=threads.map(t=>({...t,state:'idle',attention:null,queue:[],queue_paused:false,owns_response:false,history_only:false,...(t.thread_id===first?base:{})}));if((state==='queued'||state==='stalled-elsewhere')&&second)threads=threads.map(t=>t.thread_id===second?{...t,state:'active',owns_response:true}:t);};
reviewHoldingRun=null;
async function moveProjectsToBackup(){await rm(projectsBackup,{recursive:true,force:true});await rename(projectsDir,projectsBackup);}
async function restoreHealthyWorkspace(){if(await exists(projectsBackup)){await rm(projectsDir,{recursive:true,force:true});await rename(projectsBackup,projectsDir);}await rm(invalidKitDir,{recursive:true,force:true});await writeFile(join(workspace.directory,'kit.yaml'),healthyKit);}
async function applyCatalogMode(mode){if(mode==='empty'){await restoreHealthyWorkspace();await moveProjectsToBackup();await mkdir(projectsDir,{recursive:true});}else if(mode==='missing_projects'){await restoreHealthyWorkspace();await moveProjectsToBackup();}else if(mode==='partial'){await restoreHealthyWorkspace();await mkdir(invalidKitDir,{recursive:true});await writeFile(join(invalidKitDir,'kit.yaml'),'id: [broken\n');await writeFile(join(workspace.directory,'kit.yaml'),partialKit);}else{await restoreHealthyWorkspace();}boundary.catalogMode=mode;}
const subscribers=new Set();
const copied=value=>JSON.parse(JSON.stringify(value));
async function fixtureAssignmentTarget(threadId){
 const thread=threads.find(item=>item.thread_id===threadId);
 if(!thread||!thread.target||thread.target.kind==='workspace')return null;
 if(thread.target.kind==='repository')return thread.target.repository_id;
 if(thread.target.kind!=='worktree')throw new Error('Fixture assignment target kind is unsupported.');
 const requested=await realpath(thread.target.path);
 const detail=await fetchWorkspace(storage,'fixture');
 const matches=[];
 for(const repository of detail.repositories||[]){
  if(typeof repository.path!=='string'||!repository.path)continue;
  const declared=resolveRepositoryPath(detail.directory,repository.path);
  if(await realpath(declared).catch(()=>null)===requested)matches.push(repository.id);
 }
 if(matches.length!==1)throw new Error('Fixture worktree target has no unique canonical repository binding.');
 return matches[0];
}
const discussion={
 async prepareSpecTarget(input){posts.push({name:'prepareSpecTarget',input});const directTarget=typeof input.repository_id==='string'&&dispatchRepos.some(repo=>repo.id===input.repository_id)?input.repository_id:null;return prepareAssignmentSpecTarget({storageRoot:storage,workspace_id:input.workspace_id,target:directTarget??await fixtureAssignmentTarget(input.thread_id),specPackage:input.spec_package});},
 async suggestions(input){posts.push({name:'suggestions',input});if(delaySuggestions)await new Promise(r=>setTimeout(r,650));const thread=threads.find(item=>item.thread_id===input.thread_id);if(!thread)throw Object.assign(new Error('Thread not found'),{code:'thread-not-found'});const target=thread.target&&typeof thread.target==='object'?thread.target:{};let executionDir=workspace.directory;if(target.kind==='repository'){const match=dispatchRepos.find(repo=>repo.id===target.repository_id);if(match)executionDir=await realpath(match.path);}else if(target.kind==='worktree'&&typeof target.path==='string'){executionDir=await realpath(target.path);}return referenceCatalog.suggest({workspace:{...workspace,repositories:dispatchRepos.map(repo=>({id:repo.id,path:repo.path}))},executionDir,kind:input.kind,query:input.query});},
 async list({workspace_id}){if(holdThreads&&(!holdThreadsWorkspace||workspace_id===holdThreadsWorkspace))await waitForRelease(threadWaiters);if(failThreads)throw Object.assign(new Error('Fixture thread list unavailable'),{code:'service-closed'});return {threads:workspace_id==='fixture'?copied(threads):[],invalid:workspace_id==='fixture'&&invalidRecords?[{reason:'invalid-json'},{reason:'fixture-secret-token'}]:[]};},
 async history({before}){if(before)return {entries:[{id:'entry-old',message:{role:'user',content:'Older message'}}],truncated:false,incomplete_tail:false};if(longHistory)return {entries:Array.from({length:48},(_,index)=>({id:`entry-long-${index+1}`,timestamp:new Date(Date.now()-index*60000).toISOString(),message:{role:index%2?'assistant':'user',content:`Long history message ${index+1}. Fixture transcript line for the retained reading position. A second sentence keeps each row tall enough to scroll.`}})),truncated:true,incomplete_tail:false};return {entries:copied(entries),truncated:true,incomplete_tail:incompleteTail};},
 async create(input){const entry={name:'create',input};posts.push(entry);if(delayCreate)await waitForRelease(createWaiters);if(failCreate)throw Object.assign(new Error('Fixture conversation creation failed'),{code:'service-closed'});const t={...threads[0],thread_id:randomUUID(),title:input.title||'New thread',target:input.target||{kind:'workspace'},queue:[],attention:null};threads=[t,...threads];createdThreads.push({thread_id:t.thread_id,workspace_id:t.workspace_id,target:copied(t.target)});entry.result={thread_id:t.thread_id};return copied(t);},
 async send(input){posts.push({name:'send',input});if(holdSend)await waitForRelease(sendWaiters);if(delaySend)await new Promise(r=>setTimeout(r,700));if(failSend)throw Object.assign(new Error('Temporary fixture failure'),{code:'service-closed'});entries.push({id:randomUUID(),message:{role:'user',content:input.text}});return {state:'accepted'};},
 async stop(input){posts.push({name:'stop',input});threads=threads.map(t=>t.thread_id===input.thread_id?{...t,queue_paused:true,owns_response:false}:t);return {};},
 async resume(input){posts.push({name:'resume',input});threads=threads.map(t=>t.thread_id===input.thread_id?{...t,queue_paused:false,attention:null}:t);return {};},
 async discard(input){posts.push({name:'discard',input});threads=threads.map(t=>t.thread_id===input.thread_id?{...t,attention:input.resend?t.attention:null,queue:input.resend?t.queue:(t.queue||[]).filter(item=>item.id!==input.id)}:t);return {};},
 async saveBrief(input){posts.push({name:'saveBrief',input});briefWritesPending++;try{if(delayBrief)await new Promise(r=>setTimeout(r,700));await mkdir(join(workspace.directory,'briefs'),{recursive:true});const path=`briefs/${input.request_id}.md`;await writeFile(join(workspace.directory,path),input.content);savedBriefs.set(input.request_id,{path,references:input.references || [],thread_id:input.thread_id,title:input.title,content:input.content});completedBriefWrites++;return {brief:path,handoff:{request_id:input.request_id},duplicate:false};}finally{briefWritesPending--; }},
 async previewAssignment(input){posts.push({name:'previewAssignment',input});const saved=savedBriefs.get(input.request_id);const resolved=await resolveAssignment({workspace_id:'fixture',assignment_id:input.assignment_id,storageRoot:storage,brief:saved.path,instructions:input.instructions,context_references:saved.references,target:await fixtureAssignmentTarget(input.thread_id),specPackage:input.specPackage,skill:input.skill,provider:input.provider,model:input.model,thinking:input.thinking,harness:input.harness,publication_authority:input.publication_authority,home:root,pi_path:piPath},{referenceCatalog});noteResolution('previewAssignment',input,resolved,{refused:false,refusal:null});launchResolutions.set(input.request_id,{record:resolved.record,piArgs:resolved.piArgs,inputPreview:resolved.inputPreview,contractDigest:resolved.contractDigest});return resolved;},
 async launchAssignment(input){posts.push({name:'launchAssignment',input});const saved=savedBriefs.get(input.request_id);const fresh=await resolveAssignment({workspace_id:'fixture',assignment_id:input.assignment_id,storageRoot:storage,brief:saved.path,instructions:input.instructions,context_references:saved.references,target:await fixtureAssignmentTarget(input.thread_id),specPackage:input.specPackage,skill:input.skill,provider:input.provider,model:input.model,thinking:input.thinking,harness:input.harness,publication_authority:input.publication_authority,home:root,pi_path:piPath},{referenceCatalog});const matched=fresh.contractDigest===input.expectedDigest;noteResolution('launchAssignment',input,fresh,{expected_digest:input.expectedDigest??null,fresh_digest:fresh.contractDigest,matched,refused:!matched||staleLaunch,refusal:!matched?'digest-mismatch':staleLaunch?'stale-launch-control':null});if(!matched)throw Object.assign(new Error('Changed source'),{code:'stale-preview'});if(staleLaunch)throw Object.assign(new Error('Stale fixture preview'),{code:'stale-preview'});return {assignment:{assignment_id:input.assignment_id,state:'live',tmux_session:'fixture'},observation:{state:'live'}};},
 async dispatchSuggestions(input){posts.push({name:'dispatchSuggestions',input});if(delayDispatchSuggestions)await new Promise(r=>setTimeout(r,650));const match=dispatchRepos.find(repo=>repo.id===input.repository_id);const executionDir=match?await realpath(match.path):workspace.directory;return referenceCatalog.suggest({workspace:{...workspace,repositories:dispatchRepos.map(repo=>({id:repo.id,path:repo.path}))},executionDir,kind:input.kind,query:input.query});},
 async dispatchSaveBrief(input){posts.push({name:'dispatchSaveBrief',input});if(delayDispatchBrief)await new Promise(r=>setTimeout(r,700));if(failDispatchBrief)throw Object.assign(new Error('Temporary fixture failure'),{code:'service-closed'});await mkdir(join(workspace.directory,'briefs'),{recursive:true});const path=`briefs/dispatch-${input.request_id}.md`;await writeFile(join(workspace.directory,path),input.content);savedBriefs.set(input.request_id,{path,references:input.references||[]});return {brief:path,handoff:{request_id:input.request_id},duplicate:false};},
 // Direct preview/launch resolve the request's identity-only references through
 // the real reference catalog, mirroring directHandoffInput; execution, workers
 // and launch outcomes stay fake, so this proves the browser boundary only.
 async dispatchPreview(input){posts.push({name:'dispatchPreview',input});if(holdDispatchPreview)await waitForRelease(dispatchPreviewWaiters);if(dispatchPreviewRefusal==='stale')throw Object.assign(new Error('Stale fixture preview'),{code:'stale-preview'});if(dispatchPreviewRefusal==='busy')throw Object.assign(new Error('Busy fixture target'),{code:'target-busy',assignment_id:busyAssignmentId});if(dispatchPreviewRefusal==='run-active')throw Object.assign(new Error('Active fixture run'),{code:'run-active'});if(dispatchPreviewRefusal==='service')throw Object.assign(new Error('Fixture dispatch unavailable'),{code:'service-closed'});if(dispatchPreviewRefusal==='error')throw new Error('Fixture resolution failure');const saved=savedBriefs.get(input.request_id);const resolution=await resolveAssignment({workspace_id:'fixture',assignment_id:input.assignment_id,storageRoot:storage,brief:saved.path,instructions:input.instructions,pi_path:piPath,home:root,context_references:input.references??saved.references,specPackage:input.spec_package??null,target:input.repository_id??null,skill:input.skill??'general',publication_authority:input.publication_authority??'none',provider:input.provider??null,model:input.model??null,thinking:input.thinking??null,harness:input.harness??null},{referenceCatalog});noteResolution('dispatchPreview',input,resolution,{refused:false,refusal:null});return resolution;},
 async dispatchLaunch(input){posts.push({name:'dispatchLaunch',input});if(holdDispatchLaunch)await waitForRelease(dispatchLaunchWaiters);if(dispatchLaunchRefusal==='stale'||staleLaunch)throw Object.assign(new Error('Stale fixture launch'),{code:'stale-preview'});const saved=savedBriefs.get(input.request_id);const fresh=await resolveAssignment({workspace_id:'fixture',assignment_id:input.assignment_id,storageRoot:storage,brief:saved.path,instructions:input.instructions,pi_path:piPath,home:root,context_references:input.references??saved.references,specPackage:input.spec_package??null,target:input.repository_id??null,skill:input.skill??'general',publication_authority:input.publication_authority??'none',provider:input.provider??null,model:input.model??null,thinking:input.thinking??null,harness:input.harness??null},{referenceCatalog});const matched=fresh.contractDigest===input.expectedDigest;noteResolution('dispatchLaunch',input,fresh,{expected_digest:input.expectedDigest??null,fresh_digest:fresh.contractDigest,matched,refused:!matched,refusal:matched?null:'digest-mismatch'});if(!matched)throw Object.assign(new Error('Changed source'),{code:'stale-preview'});if(dispatchLaunchOutcome==='failed')return {assignment:{assignment_id:input.assignment_id,state:'launch_failed'},observation:{state:'failed'}};if(dispatchLaunchOutcome==='unknown')return {assignment:{assignment_id:input.assignment_id,state:'unknown'},observation:{state:'unknown'}};return {assignment:{assignment_id:input.assignment_id,state:'live',tmux_session:'fixture',launch_completed_at:new Date().toISOString()},observation:{state:'live'}};},
 subscribe({thread_id},callback){subscribers.add({thread_id,callback});const current=()=>threads.find(t=>t.thread_id===thread_id);const timer=setInterval(()=>callback({type:'state',event:copied(current()??{}),workspace_id:'fixture',thread_id,generation:1}),700);return ()=>{clearInterval(timer);for(const item of subscribers)if(item.callback===callback)subscribers.delete(item);};},
};
// Result-case epic inventory: the bound planning result returns to this epic
// and offers the next independent member while its launch runs.
const plannedEpic={workspace:'fixture',epic:'demo',title:'Demo epic',state:'active',next:'other-browser',members:[{name:'base',package:'base',workspace:'fixture',status:specsReadiness?'merged':'prepared',requires:[],waiting_on:[],attention:false,planning:{prepared:true,step_count:2,preparation:{outcome:'prepared',reported_at:'2026-10-09T12:00:00Z',source:'spec-prepare.md',read:'ok',bytes:80},decision:null,receipts:[]}},{name:'browser',package:'browser',workspace:'fixture',status:'prepared',requires:['base'],waiting_on:[],attention:false,planning:{prepared:true,step_count:3,preparation:{outcome:'prepared',reported_at:'2026-10-10T12:00:00Z',source:'spec-prepare.md',read:'ok',bytes:120},decision:null,receipts:[]}},{name:'other-browser',package:'other-browser',workspace:'fixture',status:'proposed',requires:[],waiting_on:[],attention:false,planning:{prepared:false,step_count:0,preparation:{outcome:'missing'},decision:null,receipts:[]}}],summary:{total:3,merged:0,complete:0,attention:0},coverage:{state:'complete',reasons:[]}};
if(specsReadiness){plannedEpic.members.push({name:'waiting-browser',package:'waiting-browser',workspace:'fixture',status:'prepared',requires:['other-browser'],waiting_on:['other-browser'],attention:false,planning:{prepared:true,step_count:5,preparation:{outcome:'prepared',reported_at:'2026-10-10T12:00:00Z',source:'spec-prepare.md',read:'ok',bytes:90},decision:null,receipts:[]}},{name:'incomplete-browser',package:'incomplete-browser',workspace:'fixture',status:'prepared',requires:[],waiting_on:[],attention:false,planning:{proposal:true,critique:false,critique_recommended:false,prepared:false,step_count:4,preparation:{outcome:'missing'},decision:null,receipts:[]}},{name:'legacy-browser',package:'legacy-browser',workspace:'fixture',status:'prepared',requires:[],waiting_on:[],attention:false},{name:'decision-browser',package:'decision-browser',workspace:'fixture',status:'prepared',requires:[],waiting_on:[],attention:false,planning:{prepared:true,step_count:6,preparation:{outcome:'prepared',reported_at:'2026-10-10T12:00:00Z',source:'spec-prepare.md',read:'ok',bytes:90},decision:{question:'Choose the storage layout'},receipts:[]}});plannedEpic.summary.total=plannedEpic.members.length;}
const makeSnapshot=()=>{const now=new Date().toISOString();const run={workspace:'fixture',package:pkg,package_ref:'fixture/browser',assignment_id:'run-1',workflow_id:'workflow-1',execution:'running',workflow_state:'waiting-worker',is_current_assignment:true,activity:'Building the dashboard',obligation:'Keep editors stable',observed_at:now,coverage:{state:'complete',reasons:[]},spec_progress:{current_position:(tick%3)+1,total_steps:3,current_name:'Migrate view'},timing:{started_at:now,attempts:[]},evidence:{state:'recorded',verdict:'ready',scope:'declared-artifact',source:'work-tour.html',commit:'abc123',observed_at:now},epic:{epic:'demo',workspace:'fixture'}};
const snapshot={workspace:'fixture',coverage:{state:'complete',observed_at:now,reasons:[]},runs:plannedLaunch?(reviewHoldingRun?[reviewHoldingRun]:[]):[run],recently_completed:plannedLaunch?[]:[{...run,assignment_id:'landed',package:pkg,completion_basis:'merged-pr',completed_at:now,is_current_assignment:false}],assignments:[...(plannedLaunch?[]:[{assignment_id:'run-1',workspace_id:'fixture',task_activity:{state:'idle',reason:'The last response finished. The session is waiting for input.',finished_at:now,last_reply:'Architecture proposal complete.'},spec_package:'fixture/browser',workflow_id:'workflow-1',display:'live',state:'live',executionDir:root,terminal:'fixture',coverage:{state:'complete',reasons:[]},nextAction:'Attach to the terminal'}]),...[...launchedAssignments.values()].map(copied)],assignment_coverage:{state:'complete',reasons:[]},epics:plannedLaunch?[plannedEpic]:[{workspace:'fixture',epic:'demo',title:'Demo epic',state:'active',members:[{name:'browser',package:'browser',workspace:'fixture',status:'in-progress',waiting_on:[],attention:false}],summary:{total:1,merged:0,complete:0,attention:0},next:'browser',coverage:{state:'complete',reasons:[]}}]};if(plannedLaunch)snapshot.planned_packages=[{workspace:'fixture',package:pkg,package_ref:'fixture/browser',planned_at:'2026-10-10T12:00:00Z',prepared:true,step_count:3,preparation:{outcome:'prepared',reported_at:'2026-10-10T12:00:00Z',source:'spec-prepare.md',read:'ok',bytes:120},decision:null,receipts:[],targets:specsReadiness?[{id:'main',primary:checkout}]:[{id:'main',primary:checkout},{id:'alternate',primary:secondCheckout}],source_paths:['spec.md']},{workspace:'fixture',package:otherPkg,package_ref:'fixture/other-browser',planned_at:'2026-10-11T12:00:00Z',prepared:false,step_count:0,preparation:{outcome:'missing'},decision:null,receipts:[],targets:specsReadiness?[{id:'main',primary:checkout}]:[{id:'main',primary:checkout},{id:'alternate',primary:secondCheckout}],source_paths:['spec.md']}];
if(specsReadiness)snapshot.planned_packages.push({workspace:'fixture',package:readinessPackageDirs[0],package_ref:'fixture/waiting-browser',planned_at:'2026-10-10T12:00:00Z',prepared:true,step_count:5,preparation:{outcome:'prepared',reported_at:'2026-10-10T12:00:00Z',source:'spec-prepare.md',read:'ok',bytes:90},decision:null,receipts:[],requires:['other-browser'],targets:[{id:'main',primary:checkout}],source_paths:['spec.md']},{workspace:'fixture',package:readinessPackageDirs[1],package_ref:'fixture/incomplete-browser',planned_at:'2026-10-10T12:00:00Z',proposal:true,critique:false,critique_recommended:false,prepared:false,step_count:4,preparation:{outcome:'missing'},decision:null,receipts:[],targets:[{id:'main',primary:checkout}],source_paths:['spec.md']},{workspace:'fixture',package:readinessPackageDirs[2],package_ref:'fixture/legacy-browser',planned_at:'2026-10-10T12:00:00Z',source_paths:['spec.md'],targets:[{id:'main',primary:checkout}]},{workspace:'fixture',package:readinessPackageDirs[3],package_ref:'fixture/decision-browser',planned_at:'2026-10-10T12:00:00Z',prepared:true,step_count:6,preparation:{outcome:'prepared',reported_at:'2026-10-10T12:00:00Z',source:'spec-prepare.md',read:'ok',bytes:90},decision:{question:'Choose the storage layout'},receipts:[],targets:[{id:'main',primary:checkout}],source_paths:['spec.md']});return {schema_version:1,observer_id:'fixture',state:'observing',published_at:now,snapshot};};
await writeFile(observerFile,JSON.stringify(makeSnapshot()));
const makeMismatchSnapshot=()=>{const now=new Date().toISOString();const run=(workspaceName,packagePath,packageRef,activity)=>({workspace:workspaceName,package:packagePath,package_ref:packageRef,assignment_id:'mismatch-run',workflow_id:'mismatch-workflow',execution:'running',workflow_state:'waiting-external',is_current_assignment:true,activity,obligation:activity,observed_at:now,coverage:{state:'complete',reasons:[]},spec_progress:{current_position:1,total_steps:2,current_name:'Mismatch step'},timing:{started_at:now,attempts:[]}});return {schema_version:1,observer_id:'mismatch-fixture',state:'observing',published_at:now,snapshot:{workspace:'physical',coverage:{state:'complete',observed_at:now,reasons:[]},runs:[run('physical',alphaKitPackage,'alpha/alpha-kit','Alpha kit run'),run('alpha',physicalKitPackage,'physical/physical-kit','Neighbor physical run')],recently_completed:[],assignments:[{assignment_id:'alpha-assignment',workspace_id:'alpha',workspace:'physical',spec_package:'alpha/alpha-kit',workflow_id:'mismatch-workflow',display:'live',state:'live',executionDir:root,coverage:{state:'complete',reasons:[]},task_activity:{state:'idle',reason:'Waiting for mismatch review.'},nextAction:'Review mismatch assignment'},{assignment_id:'physical-assignment',workspace_id:'physical',workspace:'alpha',spec_package:'physical/physical-kit',workflow_id:'mismatch-workflow',display:'live',state:'live',executionDir:root,coverage:{state:'complete',reasons:[]},task_activity:{state:'idle',reason:'Waiting for mismatch review.'},nextAction:'Review mismatch assignment'}],assignment_coverage:{state:'complete',reasons:[]},epics:[{workspace:'physical',epic:'alpha-kit-epic',title:'Alpha kit epic',state:'active',members:[{name:'alpha-kit',package:'alpha-kit',workspace:'physical',status:'in-progress',waiting_on:[],attention:false}],summary:{total:1,merged:0,complete:0,attention:0},next:'alpha-kit',coverage:{state:'complete',reasons:[]}},{workspace:'alpha',epic:'physical-neighbor-epic',title:'Neighbor physical epic',state:'active',members:[{name:'physical-kit',package:'physical-kit',workspace:'alpha',status:'in-progress',waiting_on:[],attention:false}],summary:{total:1,merged:0,complete:0,attention:0},next:'physical-kit',coverage:{state:'complete',reasons:[]}}]}};};
await writeFile(mismatchObserverFile,JSON.stringify(makeMismatchSnapshot()));
let sessionEnded=false,sessionEndFails=false,sessionIdentity='fixture-identity';
const sessionControl={
 async describe(id){return {assignment_id:id,identity:sessionIdentity,state:sessionEnded?'ended':'open',can_end:!sessionEnded,reason:sessionEnded?'Session has ended. Saved files and transcript remain available.':'Terminal session is open.',attach_command:sessionEnded?null:"ssh -t operator@host 'tmux -S /tmp/fixture.sock attach-session -t =fixture'",local_command:sessionEnded?null:'tmux -S /tmp/fixture.sock attach-session -t =fixture'};},
 async end(input){posts.push({name:'endSession',input});if(sessionEndFails)throw new Error('Session identity changed. Refresh and review it again.');if(input.confirm!==true||input.expected_identity!==sessionIdentity)throw new Error('Session identity changed. Refresh and review it again.');sessionEnded=true;return {state:'ended'};},
};
const dashboard=createDashboardServer({agentDir:join(root,'agent'),storageRoot:storage,publicHost:'dashboard.example',discussion,sessionControl});
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');
 if(url.pathname==='/__fixture/control'){
  const action=url.searchParams.get('action');
  if(action==='session-end-fails')sessionEndFails=url.searchParams.get('value')==='true';
  if(action==='session-identity'){const next=url.searchParams.get('value');sessionIdentity=next?next:'fixture-identity';}
  if(action==='delay-suggestions')delaySuggestions=url.searchParams.get('value')==='true';
  if(action==='edit-context')await writeFile(join(workspace.directory,'notes','browser.md'),'# Updated browser note\nChanged source after preview.\n');
  if(action==='fail-send')failSend=url.searchParams.get('value')==='true';
  if(action==='delay-send')delaySend=url.searchParams.get('value')==='true';
  if(action==='hold-send')holdSend=url.searchParams.get('value')==='true';
  if(action==='release-send'){holdSend=false;releaseWaiters(sendWaiters);}
  if(action==='delay-create')delayCreate=url.searchParams.get('value')==='true';
  if(action==='release-create'){delayCreate=false;releaseWaiters(createWaiters);}
  if(action==='fail-create')failCreate=url.searchParams.get('value')==='true';
  if(action==='hold-threads')holdThreads=url.searchParams.get('value')==='true';
  if(action==='hold-threads-workspace')holdThreadsWorkspace=url.searchParams.get('value')??'';
  if(action==='incomplete-tail')incompleteTail=url.searchParams.get('value')==='true';
  if(action==='invalid-records')invalidRecords=url.searchParams.get('value')==='true';
  if(action==='list-fail-status')listFailStatus=numberValue(url.searchParams.get('value'),0,599);
  if(action==='history-fail-status')historyFailStatus=numberValue(url.searchParams.get('value'),0,599);
  if(action==='release-threads'){holdThreads=false;releaseWaiters(threadWaiters);}
  if(action==='fail-threads')failThreads=url.searchParams.get('value')==='true';
  if(action==='long-history')longHistory=url.searchParams.get('value')==='true';
  if(action==='delay-brief')delayBrief=url.searchParams.get('value')==='true';
  if(action==='delay-dispatch-brief')delayDispatchBrief=url.searchParams.get('value')==='true';
  if(action==='fail-dispatch-brief')failDispatchBrief=url.searchParams.get('value')==='true';
  if(action==='delay-dispatch-suggestions')delayDispatchSuggestions=url.searchParams.get('value')==='true';
  if(action==='stale-launch')staleLaunch=url.searchParams.get('value')==='true';
  if(action==='hold-dispatch-preview')holdDispatchPreview=url.searchParams.get('value')==='true';
  if(action==='release-dispatch-preview'){holdDispatchPreview=false;releaseWaiters(dispatchPreviewWaiters);}
  if(action==='hold-dispatch-launch')holdDispatchLaunch=url.searchParams.get('value')==='true';
  if(action==='release-dispatch-launch'){holdDispatchLaunch=false;releaseWaiters(dispatchLaunchWaiters);}
  if(action==='dispatch-preview-refusal')dispatchPreviewRefusal=url.searchParams.get('value')||'none';
  if(action==='dispatch-launch-refusal')dispatchLaunchRefusal=url.searchParams.get('value')||'none';
  if(action==='dispatch-launch-outcome')dispatchLaunchOutcome=url.searchParams.get('value')||'live';
  if(action==='review-preview-refusal'){const value=url.searchParams.get('value')||'none';dispatchPreviewRefusal=value==='target-busy'?'busy':value==='stale'?'stale':value==='run-active'?'run-active':value==='service'?'service':value==='error'?'error':'none';}
  if(action==='review-launch-refusal'){dispatchLaunchRefusal=url.searchParams.get('value')||'none';}
  if(action==='review-hold-preview')holdDispatchPreview=url.searchParams.get('value')==='true';
  if(action==='review-release-preview'){holdDispatchPreview=false;releaseWaiters(dispatchPreviewWaiters);}
  if(action==='review-hold-launch')holdDispatchLaunch=url.searchParams.get('value')==='true';
  if(action==='review-release-launch'){holdDispatchLaunch=false;releaseWaiters(dispatchLaunchWaiters);}
  if(action==='review-holding-run'){const value=url.searchParams.get('value')||'';reviewHoldingRun=value?{workspace:'fixture',package:pkg,package_ref:'fixture/browser',assignment_id:value,workflow_id:'workflow-1',execution:'running',workflow_state:'waiting-worker',is_current_assignment:true,activity:'Holding fixture/browser',obligation:'Finish before another review',observed_at:new Date().toISOString(),coverage:{state:'complete',reasons:[]}}:null;}
  if(action==='publish-assignment'){const id=url.searchParams.get('value')||'';const skill=url.searchParams.get('skill')||'';const specPackage=url.searchParams.get('package')||'fixture/browser';if(id)launchedAssignments.set(id,{assignment_id:id,workspace_id:'fixture',spec_package:specPackage,workflow_id:'workflow-1',display:'live',state:'live',executionDir:root,terminal:'fixture',coverage:{state:'complete',reasons:[]},task_activity:{state:'idle',reason:'Fixture assignment is waiting for input.'},nextAction:'Attach to the terminal',...(skill?{skill}:{})});}
  if(action==='clear-launch-publications')launchedAssignments.clear();
  if(action==='attention')threads=threads.map((t,i)=>i===0?{...t,attention:'stalled',owns_response:true}:t);
  if(action==='queue')threads=threads.map((t,i)=>i===0?{...t,attention:'uncertain',queue:[{id:'uncertain-1',text:'Uncertain message',state:'uncertain'}]}:t);
  if(action==='clear-attention')threads=threads.map(t=>({...t,attention:null,queue:[],queue_paused:false,owns_response:false}));
  if(action==='response-state')applyResponseState(url.searchParams.get('value')||'default');
  if(action==='tool')for(const item of subscribers)item.callback({type:'tool',event:{toolName:'Reading package-files.mjs'},workspace_id:'fixture',thread_id:item.thread_id,generation:1});
  if(action==='tick')tick++;
  if(action==='local')localOperator=url.searchParams.get('value')==='true';
  if(action==='delta')for(const item of subscribers)item.callback({type:'delta',event:{delta:'Streamed reply <script>unsafe()</script>'},workspace_id:'fixture',thread_id:item.thread_id,generation:1});
  // Opt-in settled control: an attributed, allowed service envelope exactly as
  // the real projection would forward it to current subscribers. The default
  // fixture behavior (only the 700ms state interval) is unchanged.
  if(action==='settled')for(const item of subscribers)item.callback({type:'settled',event:{},workspace_id:'fixture',thread_id:item.thread_id,generation:1});
  if(action==='workspace-reset'){await restoreHealthyWorkspace();resetBoundaryControls();}
  if(action==='catalog-fail')boundary.catalogFail=url.searchParams.get('value')==='true';
  if(action==='detail-fail')boundary.detailFail=url.searchParams.get('value')==='true';
  if(action==='state-fail')boundary.stateFail=url.searchParams.get('value')==='true';
  if(action==='catalog-delay-ms')boundary.catalogDelayMs=numberValue(url.searchParams.get('value'),0,5000);
  if(action==='detail-delay-ms')boundary.detailDelayMs=numberValue(url.searchParams.get('value'),0,5000);
  if(action==='detail-delay-id')boundary.detailDelayId=url.searchParams.get('value')??'';
  if(action==='state-delay-ms')boundary.stateDelayMs=numberValue(url.searchParams.get('value'),0,5000);
  if(action==='state-clock-offset-ms')boundary.stateClockOffsetMs=numberValue(url.searchParams.get('value'),-120000,120000);
  if(action==='catalog-mode')await applyCatalogMode(url.searchParams.get('value')||'healthy');
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...packageIdentity,posts,threads,createdThreads,tick,boundary,threadControls:{holdThreads,holdThreadsWorkspace,failThreads,longHistory,incompleteTail,invalidRecords,listFailStatus,historyFailStatus,responseState},subscribedThreadIds:[...new Set([...subscribers].map(item=>item.thread_id))],createControls:{delayCreate,failCreate},session:{identity:sessionIdentity,ended:sessionEnded},review:{holdDispatchPreview,holdDispatchLaunch,dispatchPreviewRefusal,dispatchLaunchRefusal,staleLaunch,holdingRun:reviewHoldingRun?.assignment_id??null},launch:{outcome:dispatchLaunchOutcome,published:[...launchedAssignments.keys()]},diagnostics:{resolvers:resolverDiagnostics},boundaryLog:boundaryLog.slice(-60),active:[...activeBoundary.values()],launchResolutions:Object.fromEntries(launchResolutions),briefWritesPending,completedBriefWrites}));return;
 }
 // Emulate the trusted Serve endpoint so the browser exercises thread-only tokens.
 if(!localOperator){req.headers.host='dashboard.example';if(req.headers.origin)req.headers.origin='https://dashboard.example';}
 const readKind=url.pathname==='/api/workspaces'?'catalog':url.pathname==='/api/workspace'?'detail':url.pathname==='/api/state'?'state':null;
 // View-state reads: exact list/history HTTP statuses for the denied/error
 // split, served before the real discussion route.
 const threadRead=url.pathname==='/api/threads'?'threads':url.pathname==='/api/thread/history'?'history':null;
 if(threadRead){
  const status=threadRead==='threads'?listFailStatus:historyFailStatus;
  if(status){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:threadRead==='threads'?'Fixture thread list unavailable':'Fixture transcript read unavailable'}));return;}
 }
 if(!readKind){dashboard.emit('request',req,res);return;}
 const id=url.searchParams.get('id')??'';
 const attempt={
  fail:readKind==='catalog'?boundary.catalogFail:readKind==='detail'?boundary.detailFail:boundary.stateFail,
  delayMs:readKind==='catalog'?boundary.catalogDelayMs:readKind==='detail'?boundary.detailDelayMs:readKind==='state'?boundary.stateDelayMs:0,
  applies:readKind!=='detail'||!boundary.detailDelayId||boundary.detailDelayId===id,
  offset:readKind==='state'?boundary.stateClockOffsetMs:0,
 };
 const boundaryAttemptNumber=startBoundary(readKind,id);
 if(attempt.delayMs>0&&attempt.applies)await new Promise(resolve=>setTimeout(resolve,attempt.delayMs));
 if(attempt.fail){finishBoundary(boundaryAttemptNumber,'fail');res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:`fixture-${readKind}-failure`}));return;}
 res.on('close',()=>{if(!res.writableEnded)finishBoundary(boundaryAttemptNumber,'aborted');});
 const originalEnd=res.end.bind(res);
 res.end=(body,encoding,callback)=>{
  if(readKind==='state'&&attempt.offset!==0&&(typeof body==='string'||Buffer.isBuffer(body))){
   const text=Buffer.isBuffer(body)?body.toString('utf8'):body;
   try{
    const parsed=JSON.parse(text);
    if(typeof parsed.generated_at==='string'&&Number.isFinite(Date.parse(parsed.generated_at))){
     parsed.generated_at=new Date(Date.parse(parsed.generated_at)+attempt.offset).toISOString();
     body=JSON.stringify(parsed);
    }
   }catch{}
  }
  finishBoundary(boundaryAttemptNumber,'complete');
  return originalEnd(body,encoding,callback);
 };
 dashboard.emit('request',req,res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const timer=setInterval(()=>{tick++;void writeFile(observerFile,JSON.stringify(makeSnapshot()));void writeFile(mismatchObserverFile,JSON.stringify(makeMismatchSnapshot()));},1000);
console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,root,checkout,secondCheckout,otherPackage:otherPkg,...packageIdentity,thread1,thread2,thread3,worktreeTarget:docsCheckout}));
async function close(){clearInterval(timer);server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
