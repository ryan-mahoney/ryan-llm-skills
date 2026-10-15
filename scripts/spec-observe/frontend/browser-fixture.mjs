// Isolated integration fixture: real dashboard HTTP/file routes, fake discussion workers.
import {createServer} from 'node:http';
import {mkdtemp,realpath,mkdir,readFile,writeFile,rm,rename,access,opendir,stat,utimes} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {createDashboardServer} from '../dashboard.mjs';
import {parseModelCatalog} from '../model-routes.mjs';
import {collectWorkspace} from '../sentinel.mjs';
import {createDiscussionService} from '../../workspaces/discussion.mjs';
import {createReferenceCatalog} from '../../workspaces/references.mjs';
import {createSessionControl} from '../../workspaces/session-control.mjs';
import {resolveAssignment,prepareAssignmentSpecTarget} from '../../workspaces/assignments.mjs';
import {setupStorage,createWorkspace,fetchWorkspace,resolveRepositoryPath} from '../../workspaces/store.mjs';
import {newPackage} from '../../spec-location/index.mjs';
const plannedLaunch=process.env.SENTINEL_PLANNED_LAUNCH==='1';
const specsReadiness=process.env.SENTINEL_SPECS_READINESS==='1';
const epicPlanning=process.env.SENTINEL_EPIC_PLANNING==='1';
const filesFixture=process.env.SENTINEL_REPOSITORY_FILES==='1';
const modelsFixture=process.env.SENTINEL_MODELS==='1';
const handoffIntegration=process.env.SENTINEL_HANDOFF_INTEGRATION==='1'&&(plannedLaunch||specsReadiness||epicPlanning);
const nextSteps=process.env.SENTINEL_NEXT_STEPS==='1';
// EV-7 runs the next-steps fixture over the real discussion service; that
// composition additionally seeds one package whose catalog kit id differs from
// its storage directory basename so the ordinary cold route proves the
// catalog-to-snapshot identity adapter rather than a same-name coincidence.
const nextStepsColdAlias=nextSteps&&handoffIntegration;
const root=await realpath(process.env.SENTINEL_FIXTURE_ROOT??await mkdtemp(join(tmpdir(),'sentinel-solid-browser-')));
// Real final-integration resolution reads HOME and PATH: isolate both to this
// fixture root so the real catalog sees root/.agents skills and the fake pi
// file, never the live operator home.
if(handoffIntegration||modelsFixture||nextSteps){process.env.HOME=root;process.env.PATH=`${root}:${process.env.PATH??''}`;}
const storage=join(root,'storage');await setupStorage(storage);
// Models fixture (gated by SENTINEL_MODELS=1)
let modelsReadAt=Date.now();
let modelsCatalogFail=false;
let observerMode=false;
let modelsPreferencePosts=0;
let modelsCatalogDrop='';
const modelsPreferredSeed=`{"version":1,"preferred":[{"provider":"pi-claude-cli","model":"claude-sonnet-5-5"},{"provider":"pi-claude-cli","model":"claude-haiku-5-5"},{"provider":"zai","model":"glm-5.3"},{"provider":"deepseek","model":"deepseek-v4-pro"},{"provider":"kimi-coding","model":"k3"},{"provider":"openai-codex","model":"gpt-6-sol"},{"provider":"old-provider","model":"retired-model"}],"updated_at":"2026-10-14T14:31:00.000Z"}`;
if(modelsFixture){
 const prefDir=join(root,'agent','spec-sentinel');await mkdir(prefDir,{recursive:true});
 await writeFile(join(prefDir,'preferred-models.json'),modelsPreferredSeed);
}
const workspace=await createWorkspace(storage,{id:'fixture',name:'Browser fixture'});
const otherWorkspace=await createWorkspace(storage,{id:'other',name:'Other workspace'});
const mismatchDirectory=await createWorkspace(storage,{id:'physical',name:'Physical directory'});
const neighborDirectory=await createWorkspace(storage,{id:'alpha',name:'Neighbor alpha'});
await writeFile(join(mismatchDirectory.directory,'kit.yaml'),'version: 1\nid: alpha\nname: Alpha kit\nrepositories: []\n');
await writeFile(join(neighborDirectory.directory,'kit.yaml'),'version: 1\nid: physical\nname: Physical neighbor\nrepositories: []\n');
const checkout=join(root,'checkout');await mkdir(checkout,{recursive:true});execFileSync('git',['init','--quiet',checkout],{stdio:'ignore'});
const secondCheckout=join(root,'checkout-two');if(plannedLaunch){await mkdir(secondCheckout,{recursive:true});execFileSync('git',['init','--quiet',secondCheckout],{stdio:'ignore'});}
// Models fixture catalog building
const buildTable=(rows)=>{
 const header=['provider','model','context','max-out','thinking','images'];
 const widths=header.map((h,i)=>Math.max(h.length,...rows.map(r=>String(r[i]??'').length)));
 return [header.map((h,i)=>h.padEnd(widths[i])).join('  '),...rows.map(r=>r.map((c,i)=>String(c??'').padEnd(widths[i])).join('  '))].join('\n');
};
const modelsFixtureRows=[
 ['pi-claude-cli','claude-sonnet-5-5','1M','128K','yes','yes'],
 ['pi-claude-cli','claude-haiku-5-5','1M','128K','yes','yes'],
 ['pi-claude-cli','claude-opus-5-5','1M','128K','yes','yes'],
 ['pi-claude-cli','claude-fable-5','1M','128K','yes','yes'],
 ['zai','glm-5.3','272K','64K','yes','no'],
 ['zai','glm-4.7','200K','32K','no','no'],
 ['zai','glm-5.3-flash','128K','16K','no','yes'],
 ['deepseek','deepseek-v4-pro','1M','128K','yes','no'],
 ['deepseek','deepseek-flash','128K','16K','no','yes'],
 ['kimi-coding','k3','1M','128K','yes','no'],
 ['kimi-coding','k3-256k','256K','32K','yes','no'],
 ['kimi-coding','kimi-for-coding','1M','64K','yes','no'],
 ['openai-codex','gpt-6-sol','1M','128K','yes','yes'],
 ['openai-codex','gpt-5.6-luna','272K','64K','yes','yes'],
 ['openai-codex','gpt-5.5','200K','32K','no','no'],
 ['openrouter','anthropic/claude-sonnet-4','1M','128K','yes','yes'],
 ['openrouter','openai/gpt-4.1','1M','128K','yes','yes'],
 ['openrouter','google/gemini-1.5','1M','128K','yes','yes'],
 ['groq','llama3-70b','128K','32K','no','no'],
 ['groq','mixtral-8x7b','128K','32K','no','no'],
 ['gmicloud','gemini-1.5-pro','1M','128K','yes','yes'],
 ['gmicloud','gemini-1.5-flash','272K','64K','yes','yes']
];
let modelsCatalogTable=buildTable(modelsFixtureRows);
const fixtureCatalog={
 host:'fixture-host',
 async read(){
  if(modelsCatalogFail)return {state:'failed',host:'fixture-host',failed_at:new Date(modelsReadAt).toISOString(),reason:'catalog-unavailable'};
  let models=parseModelCatalog(modelsCatalogTable);
  if(modelsCatalogDrop){
   const [provider,model]=modelsCatalogDrop.split('|');
   models=models.filter(m=>!(m.provider===provider&&m.model===model));
  }
  return {state:'ready',host:'fixture-host',read_at:new Date(modelsReadAt).toISOString(),providers:new Set(models.map(m=>m.provider)).size,models};
 }
};
// Real spec-worktree preparation needs a base commit in each isolated repo;
// the Next steps mode uses the same owned checkout so its real spec-target
// resolution has the same starting point.
const baseCommitDirectories=plannedLaunch?[checkout,secondCheckout]:nextSteps?[checkout]:[];
for(const directory of baseCommitDirectories)execFileSync('git',['-C',directory,'-c','user.name=Browser fixture','-c','user.email=fixture@example.invalid','commit','--quiet','--allow-empty','-m','Initialize fixture repository'],{stdio:'ignore'});
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
// Epic-planning case packages: real prepared-looking directories for members
// whose rows exercise prepared-prerequisite truth and index-only blockers.
// The missing member deliberately gets no package directory.
const epicPlanningSlugs=epicPlanning?['prepared-prereq-browser','index-browser','blocked-browser']:[];
if(epicPlanning)for(const slug of epicPlanningSlugs){const created=await newPackage({root:storage,workspace:'fixture',slug,targets:[{id:'fixture-repo'}]});if(!created.ok)throw new Error(`Epic planning fixture package setup failed: ${created.code} ${created.message}`);await writeFile(join(workspace.directory,'specs',slug,'spec.md'),`# ${slug} specification\n`);}
// Opt-in real final-integration seeds: the same package files a real host
// reads drive readiness, planning and epic membership for this mode only.
const handoffPackageDirs=new Map([['fixture/browser',pkg],['fixture/other-browser',otherPkg]]);
for(const slug of readinessSlugs)handoffPackageDirs.set(`fixture/${slug}`,join(workspace.directory,'specs',slug));
for(const slug of epicPlanningSlugs)handoffPackageDirs.set(`fixture/${slug}`,join(workspace.directory,'specs',slug));
if(epicPlanning)handoffPackageDirs.set('fixture/missing-browser',join(workspace.directory,'specs','missing-browser'));
const integrationSteps=(count=3)=>JSON.stringify({schema_version:1,steps:Array.from({length:count},(_,index)=>({step:index+1,name:`Integration step ${index+1}`,description:`Complete integration step ${index+1}.`,difficulty:'easy',visualDesign:false,evidence:[],repository:'fixture-repo'}))},null,2);
if(handoffIntegration){
 await mkdir(otherPkg,{recursive:true});
 await writeFile(join(otherPkg,'spec.md'),'# Other planned browser specification\n');
 await writeFile(join(pkg,'spec-steps.json'),integrationSteps(3));
 await writeFile(join(pkg,'spec-prepare.md'),'# Preparation report\n\nPrepared 2026-10-10\noutcome: prepared\n');
 if(specsReadiness){
  const waitingDir=join(workspace.directory,'specs','waiting-browser');
  await writeFile(join(waitingDir,'spec-steps.json'),integrationSteps(5));
  await writeFile(join(waitingDir,'spec-prepare.md'),'# Preparation report\n\nPrepared 2026-10-10\noutcome: prepared\n');
  await writeFile(join(workspace.directory,'specs','incomplete-browser','proposal.md'),'---\ncritique_recommended: false\n---\n\n# Incomplete browser proposal\nA recorded proposal resumes without re-architecture.\n');
  const decisionDir=join(workspace.directory,'specs','decision-browser');
  await writeFile(join(decisionDir,'decision-required.md'),'---\nstage: specification\nquestion: "Should integration resume specification without re-architecture?"\nrecommendation: "Resume spec-write after the operator answers."\nrecorded_at: 2026-10-15T00:00:00.000Z\n---\n\n# Decision required\n\nResume the recorded specification stage.\n');
  await writeFile(join(decisionDir,'spec-prepare.md'),'# Preparation report\n\noutcome: decision-required\n');
 }
 const epicPackages=[{package:'base'},{package:'browser'},{package:'other-browser'}];
 if(specsReadiness)epicPackages.push({package:'waiting-browser',requires:['other-browser']},{package:'incomplete-browser'},{package:'decision-browser'});
 if(epicPlanning)epicPackages.push({package:'prepared-prereq-browser',requires:['base']},{package:'index-browser'},{package:'blocked-browser',requires:['index-browser']},{package:'missing-browser'});
 const epicDir=join(storage,'projects','fixture','epics','demo');await mkdir(epicDir,{recursive:true});
 await writeFile(join(epicDir,'epic.json'),`${JSON.stringify({schema_version:1,epic:'demo',title:'Demo epic',state:'active',created_at:'2026-10-01T00:00:00.000Z',packages:epicPackages},null,2)}\n`);
}
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
// --- Opt-in Next steps filesystem/snapshot fixture -------------------------
// SENTINEL_NEXT_STEPS=1 keeps the real dashboard and /api/next-steps scan route
// and seeds an isolated catalog tree whose watched package files drive the list
// states. The mode owns one dedicated snapshot; the ordinary default snapshot
// and the mismatch observer are never published here. All package facts come
// from fixture-owned files; only the running and recent-completion records are
// snapshot-only observations.
const nextStepsWatched=['proposal.md','critique.md','spec.md','work-tour.html'];
const nextStepsPackages=new Map();
const nextStepsDynamicDirs=new Set();
const nextStepsInitialFiles=new Map();
const nextStepsEpicDir=join(storage,'projects','fixture','epics','new-epic');
const nextStepsEpicPath=join(nextStepsEpicDir,'epic.json');
let nextStepsScanFail=false,nextStepsScanDelayMs=0,nextStepsArrivals=0,nextStepsLastMutation=null,nextStepsPublishChain=Promise.resolve();
const nextStepsExists=async path=>{try{await access(path);return true;}catch{return false;}};
const nextStepsStat=async path=>{try{const info=await stat(path);return {path,exists:true,mtimeMs:info.mtimeMs,mtimeIso:new Date(info.mtimeMs).toISOString(),size:info.size};}catch{return {path,exists:false};}};
const nextStepsMeta=async()=>{const packages={};for(const [slug,item] of nextStepsPackages){const files={};for(const name of nextStepsWatched)files[name]=await nextStepsStat(join(item.dir,name));packages[slug]={workspace:item.workspace,workspaceId:item.wsId,packageRef:item.packageRef,dir:item.dir,files};}return {storage,packages,epic:await nextStepsStat(nextStepsEpicPath),scan:{fail:nextStepsScanFail,delayMs:nextStepsScanDelayMs},lastMutation:nextStepsLastMutation};};
const nextStepsRemember=async path=>{try{nextStepsInitialFiles.set(path,{bytes:await readFile(path),mtimeMs:(await stat(path)).mtimeMs});}catch{}};
const nextStepsWrite=async(dir,name,content,mtimeMs)=>{const path=join(dir,name);await writeFile(path,content);if(mtimeMs!==undefined)await utimes(path,new Date(mtimeMs),new Date(mtimeMs));await nextStepsRemember(path);return path;};
const nextStepsProposal=(verdict,critique,summary)=>`---\nverdict: ${verdict}\ncritique_recommended: ${critique?'true':'false'}\n---\n\n# Proposal\n\n## Summary\n\n${summary}\n\n## Verdict\n\n${verdict==='INCOMPATIBLE'?'The approach does not fit the observed workspace.':'The recorded verdict and its caveats.'}\n\n- A storage-layout caveat.\n- A reader-contract caveat.\n`;
const nextStepsCritique='# Critique\n\n## Recommendations\n\n### Must Address\n\n1. **Keep the reader contract stable.** The shared reader semantics stay unchanged.\n2. **Preserve prepared steps.** Existing prepared steps remain valid.\n\n### Should Address\n\n1. **Name the owning surface.** The step names the surface it changes.\n\n### Consider\n\n**C1 — Fold the optional follow-up into a later pass.**\n\n## Assessment\n\nThe architecture is sound; fold in the must-address items before specification.\n';
const nextStepsSteps=count=>JSON.stringify({schema_version:1,steps:Array.from({length:count},(_,index)=>({step:index+1,name:`Fixture step ${index+1}`,description:`Complete fixture step ${index+1}.`,difficulty:'easy',visualDesign:false,evidence:[],repository:'fixture-repo'}))},null,2);
async function makeNextStepsSnapshot(){
 const now=new Date().toISOString();
 let snapshot;
 try{snapshot=await collectWorkspace({storageRoot:storage,agentDir:join(root,'agent'),skipManagedIndex:true,assignmentProbes:{tmuxRun:handoffTmuxRun,psRun:handoffPsRun}});}
 catch(error){snapshot={workspace:'fixture',coverage:{state:'unavailable',observed_at:now,reasons:[`collect-workspace: ${error?.message??error}`]},runs:[],recently_completed:[],assignments:[],assignment_coverage:{state:'unavailable',reasons:[]},epics:[],planned_packages:[]};}
 // Package-local target aliases keep the canonical primary the resolver matches;
 // the id is deliberately distinct from every workspace repository alias.
 snapshot.planned_packages=(snapshot.planned_packages??[]).map(row=>{const slug=String(row.package_ref??'').split('/').pop()||'package';return {...row,name:row.name??slug,targets:(row.targets??[]).map(target=>({id:`${slug}-local`,primary:target.primary}))};});
 const running=nextStepsPackages.get('running'),landed=nextStepsPackages.get('landed');
 const runningAssignment='11111111-2222-4333-8444-555555555555';
 // Snapshot-only lifecycle observations: the owned files cannot record a live
 // worker or a landed merge, so one running record plus the real assignment row
 // the Agents surface keys by, and one recent completion, are injected here.
 // Every other package fact comes from collectWorkspace over the fixture files.
 if(running)snapshot.runs=[...(snapshot.runs??[]),{workspace:'fixture',package:running.dir,package_ref:running.packageRef,assignment_id:runningAssignment,workflow_id:'fixture-workflow',execution:'running',workflow_state:'waiting-worker',is_current_assignment:true,activity:'Reviewing the observed proposal',obligation:'Observe the running assignment',observed_at:now,coverage:{state:'complete',reasons:[]},timing:{started_at:now,attempts:[]}}];
 if(landed)snapshot.recently_completed=[...(snapshot.recently_completed??[]),{workspace:'fixture',package:landed.dir,package_ref:landed.packageRef,assignment_id:'99999999-8888-4777-8666-555555555555',workflow_id:'fixture-workflow',execution:'completed',workflow_state:'complete',is_current_assignment:false,completion_basis:'merged-pr',completed_at:now,observed_at:now,coverage:{state:'complete',reasons:[]}}];
 if(running)snapshot.assignments=[...(snapshot.assignments??[]),{assignment_id:runningAssignment,workspace_id:'fixture',workspace:'fixture',spec_package:running.dir,package_ref:running.packageRef,workflow_id:'fixture-workflow',display:'live',state:'live',skill:'spec-end-to-end',executionDir:checkout,terminal:'fixture',coverage:{state:'complete',reasons:[]},task_activity:{state:'idle',reason:'The fixture assignment is waiting for input.'},nextAction:'Attach to the terminal'}];
 snapshot.assignment_coverage=snapshot.assignment_coverage??{state:'complete',reasons:[]};
 return {schema_version:1,observer_id:'fixture-next-steps',state:'observing',published_at:now,snapshot};
}
function publishNextStepsSnapshot(){const run=async()=>{const wrapper=await makeNextStepsSnapshot();const temporary=`${observerFile}.publishing`;await writeFile(temporary,JSON.stringify(wrapper));await rename(temporary,observerFile);return wrapper;};const result=nextStepsPublishChain.then(run);nextStepsPublishChain=result.then(()=>undefined,()=>undefined);return result;}
const nextStepsOtherKit=async()=>{await writeFile(join(otherWorkspace.directory,'kit.yaml'),`version: 1\nid: other\nname: Other workspace\nexecution_host: ${hostname()}\nrepositories:\n  - id: other-alias\n    path: ${checkout}\n    role: Discussion alias\n`);};
if(nextSteps){
 try{
 await nextStepsOtherKit();
 for(const wsDir of [workspace.directory,otherWorkspace.directory,mismatchDirectory.directory,neighborDirectory.directory]){
  const specsDir=join(wsDir,'specs');let handle;try{handle=await opendir(specsDir);}catch{continue;}
  for await(const entry of handle){if(!entry.isDirectory())continue;for(const name of nextStepsWatched)await rm(join(specsDir,entry.name,name),{force:true});}
 }
 const addPackage=async(slug,wsId,targetId)=>{const created=await newPackage({root:storage,workspace:wsId,slug,targets:[{id:targetId}]});if(!created.ok)throw new Error(`Next steps fixture package setup failed: ${created.code} ${created.message}`);const item={slug,workspace:wsId,wsId,dir:join(storage,'projects',wsId,'specs',slug),packageRef:`${wsId}/${slug}`};nextStepsPackages.set(slug,item);return item;};
 for(const slug of ['recommended','direct','critiqued','ready','waiting','running','markup','landed','tour','epic-first','epic-second'])await addPackage(slug,'fixture','fixture-repo');
 await addPackage('incompatible','other','other-alias');
 const base=Date.now(),ago=ms=>base-ms,pick=slug=>nextStepsPackages.get(slug);
 await nextStepsWrite(pick('recommended').dir,'proposal.md',nextStepsProposal('COMPATIBLE_WITH_CAVEATS',true,'The proposal covers the storage layout and the reader contract.\n\nA second summary line keeps the excerpt multi-line.'),ago(1200000));
 await nextStepsWrite(pick('direct').dir,'proposal.md',nextStepsProposal('COMPATIBLE',false,'The proposal is compatible and needs no critique before its specification.'),ago(1100000));
 await nextStepsWrite(pick('incompatible').dir,'proposal.md',nextStepsProposal('INCOMPATIBLE',false,'The proposal conflicts with the observed storage contract.'),ago(1000000));
 await nextStepsWrite(pick('critiqued').dir,'proposal.md',nextStepsProposal('COMPATIBLE_WITH_CAVEATS',true,'The proposal is compatible with caveats.'),ago(900000));
 await nextStepsWrite(pick('critiqued').dir,'critique.md',nextStepsCritique,ago(600000));
 await nextStepsWrite(pick('ready').dir,'spec.md','# Ready fixture specification\n',ago(500000));
 await writeFile(join(pick('ready').dir,'spec-steps.json'),nextStepsSteps(3));
 await writeFile(join(pick('ready').dir,'spec-prepare.md'),'# Preparation report\n\noutcome: prepared\n');
 await nextStepsWrite(pick('waiting').dir,'spec.md','# Waiting fixture specification\n',ago(450000));
 await nextStepsWrite(pick('tour').dir,'work-tour.html','<html><body><h1>Fixture work tour</h1></body></html>',ago(400000));
 await writeFile(join(pick('tour').dir,'work-tour.json'),JSON.stringify({schema_version:1,verdict:'ready',gaps:['One tour gap is recorded.','A second follow-up remains open.'],commit:'abcdef1234567890',title:'Observed work tour',summary:'The work tour records ready merge evidence for the observed package.'}));
 await writeFile(join(pick('tour').dir,'pr-url.json'),JSON.stringify({targets:{'fixture-repo':{url:'https://github.com/adjacent-storage/agents/pull/10'}}}));
 await nextStepsWrite(pick('running').dir,'proposal.md',nextStepsProposal('COMPATIBLE_WITH_CAVEATS',true,'A running assignment owns this package.'),ago(300000));
 await nextStepsWrite(pick('markup').dir,'proposal.md',nextStepsProposal('COMPATIBLE',false,'Literal <img src=x onerror="window.__fixtureInjected=true"> summary text stays text.'),ago(200000));
 await nextStepsWrite(pick('landed').dir,'proposal.md',nextStepsProposal('COMPATIBLE',false,'This package already landed and must be omitted from the list.'),ago(100000));
 await mkdir(nextStepsEpicDir,{recursive:true});
 await writeFile(nextStepsEpicPath,JSON.stringify({schema_version:1,epic:'new-epic',title:'New epic',state:'planned',created_at:'2026-10-12T00:00:00.000Z',packages:[{package:'epic-first'},{package:'epic-second',requires:['epic-first']}]}));
 await utimes(nextStepsEpicPath,new Date(ago(1250000)),new Date(ago(1250000)));
 await nextStepsRemember(nextStepsEpicPath);
 if(nextStepsColdAlias){
  // The catalog kit id stays 'alpha' while the storage directory is
  // 'physical'; the declared repository makes the package resolvable like a
  // real workspace so the cold route can reach the review surface.
  await writeFile(join(mismatchDirectory.directory,'kit.yaml'),`version: 1\nid: alpha\nname: Alpha kit\nexecution_host: ${hostname()}\nrepositories:\n  - id: fixture-repo\n    path: ${checkout}\n    role: Catalog id/directory mismatch alias\n`);
  const alias=await addPackage('kit-alias','physical','fixture-repo');
  await nextStepsWrite(alias.dir,'proposal.md',nextStepsProposal('COMPATIBLE_WITH_CAVEATS',true,'The alias workspace proposal records a recommended critique that is not written.'),ago(950000));
 }
 }catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
const skillPath=(plannedLaunch||handoffIntegration||nextSteps)?join(root,'.agents','skills','spec-end-to-end','SKILL.md'):join(root,'skills','fixture-skill','SKILL.md');await mkdir(join(skillPath,'..'),{recursive:true});
await writeFile(skillPath,(plannedLaunch||nextSteps)?'---\nname: spec-end-to-end\ndescription: Implement a spec package end to end.\n---\n# Spec end to end fixture\nUse the attached brief and the referenced package.\n':'---\nname: fixture-skill\ndescription: Plan work from the chosen brief.\n---\n# Fixture skill\nApply the selected workflow and read references relative to this skill directory.\n');
// Bound plan/review fixture skills plus the generic fallback live under the
// fake home so the real resolver can find each requested skill file.
if(plannedLaunch||handoffIntegration||nextSteps)for(const skillName of ['spec-architect-initial','spec-architect-critics','spec-write','fixture-skill']){const boundSkillPath=join(root,'.agents','skills',skillName,'SKILL.md');await mkdir(join(boundSkillPath,'..'),{recursive:true});await writeFile(boundSkillPath,`---\nname: ${skillName}\ndescription: Bound package review fixture.\n---\n# ${skillName} fixture\n`);}
const piPath=join(root,'pi');await writeFile(piPath,'#!/bin/sh\nexit 0\n',{mode:0o755});
const referenceCatalog=createReferenceCatalog({home:root,agentDir:join(root,'agent'),skillLoader:()=>({skills:[{name:plannedLaunch?'spec-end-to-end':'fixture-skill',description:plannedLaunch?'Implement a spec package end to end.':'Plan work from the chosen brief.',filePath:skillPath,baseDir:join(skillPath,'..'),sourceInfo:{scope:'user'}}],diagnostics:[]})});
// --- Opt-in real final-integration boundary --------------------------------
// SENTINEL_HANDOFF_INTEGRATION=1 delegates the five direct dispatch methods to
// the real discussion service. The final tmux process boundary stays fake:
// new-session starts an owned inert Node child as the pane PID, session probes
// answer from a fixture-owned session map, and completing a recorded planning
// assignment marks its session absent. Nothing else is simulated: the service
// keeps its canonical brief/preview/launch/claim/guard logic, and the resolver
// reads this fixture root's skills and fake pi through the isolated HOME/PATH.
const handoffSessions=new Map();
const handoffTmuxCalls=[];
let handoffNewSessions=0;
// Final-adapter failure control for the real launch composition: the service
// still publishes, claims and reconciles, while the fake tmux pane start refuses.
let handoffTmuxFail=false;
function endHandoffSession(session){if(!session||session.ended)return;session.ended=true;try{session.dummy.kill('SIGKILL');}catch{}}
function handoffTargetName(rest){const index=rest.indexOf('-t');if(index!==-1)return String(rest[index+1]??'').replace(/^=/,'').replace(/:$/,'');const candidate=rest.find(token=>typeof token==='string'&&token.startsWith('='));return candidate?candidate.replace(/^=/,'').replace(/:$/,''):null;}
async function handoffTmuxRun(socketPath,args){
 const list=Array.isArray(args)?args:[];
 handoffTmuxCalls.push({socketPath,args:[...list]});
 const segments=[];let current=[];
 for(const token of list){if(token===';'){if(current.length)segments.push(current);current=[];}else current.push(token);}
 if(current.length)segments.push(current);
 let stdout='';
 for(const segment of segments){
  const [command,...rest]=segment;
  if(command==='start-server'||command==='set-option'||command==='list-clients'||command==='list-panes')continue;
  if(command==='new-session'){
   if(handoffTmuxFail)return {ok:false,code:1,stdout:'',stderr:'fixture tmux pane refused',message:'fixture-tmux-refused'};
   const nameIndex=rest.indexOf('-s');const name=nameIndex!==-1?rest[nameIndex+1]:null;
   const marker=rest.find(token=>typeof token==='string'&&token.startsWith('ADJACENT_ASSIGNMENT_ID='));
   const assignmentId=marker?marker.slice('ADJACENT_ASSIGNMENT_ID='.length):null;
   if(!name||!assignmentId)return {ok:false,code:1,stdout:'',stderr:'new-session requires -s and ADJACENT_ASSIGNMENT_ID',message:'invalid-session'};
   if(handoffSessions.has(`${socketPath}#${name}`))return {ok:false,code:1,stdout:'',stderr:'duplicate session',message:'duplicate-session'};
   const cwdIndex=rest.indexOf('-c');const cwd=cwdIndex!==-1&&typeof rest[cwdIndex+1]==='string'&&rest[cwdIndex+1].startsWith('/')?rest[cwdIndex+1]:root;
   const dummy=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore',cwd});
   handoffNewSessions++;
   handoffSessions.set(`${socketPath}#${name}`,{socketPath,name,assignmentId,dummy,ended:false,paneId:'%1',startedAt:new Date().toISOString()});
   continue;
  }
  if(command==='has-session'){
   const name=handoffTargetName(rest);const session=name?handoffSessions.get(`${socketPath}#${name}`):null;
   if(!session||session.ended)return {ok:false,code:1,stdout:'',stderr:"can't find session",message:"can't find session"};
   continue;
  }
  if(command==='display-message'){
   const name=handoffTargetName(rest);const session=name?handoffSessions.get(`${socketPath}#${name}`):null;
   if(!session||session.ended)return {ok:false,code:1,stdout:'',stderr:"can't find session",message:"can't find session"};
   stdout+=`%1 ${session.dummy.pid}\n`;
   continue;
  }
  if(command==='show-options'){
   const name=handoffTargetName(rest);const session=name?handoffSessions.get(`${socketPath}#${name}`):null;
   stdout+=`${session&&!session.ended?session.assignmentId:''}\n`;
   continue;
  }
  if(command==='list-sessions'){
   for(const session of handoffSessions.values())if(!session.ended&&session.socketPath===socketPath)stdout+=`${session.name}: 1 windows (created fixture)\n`;
   continue;
  }
  if(command==='kill-session'||command==='kill-server'){
   if(command==='kill-server'){for(const session of handoffSessions.values())if(session.socketPath===socketPath)endHandoffSession(session);}
   else{const name=handoffTargetName(rest);const session=name?handoffSessions.get(`${socketPath}#${name}`):null;if(session)endHandoffSession(session);}
   continue;
  }
  if(command==='if-shell'){
   // Durable end: only the exact recorded session whose tmux condition still
   // matches the stored assignment, pane and PID is ended; anything else
   // answers identity-changed so the canonical end refuses.
   const name=handoffTargetName(rest);const session=name?handoffSessions.get(`${socketPath}#${name}`):null;
   const conditionIndex=rest.indexOf('-t')+2;const condition=conditionIndex>1?String(rest[conditionIndex]??''):'';
   const expected=session?`#{&&:#{==:#{@adjacent_assignment_id},${session.assignmentId}},#{&&:#{==:#{pane_id},${session.paneId}},#{==:#{pane_pid},${session.dummy.pid}}}}`:'';
   if(!session||session.ended||condition!==expected)return {ok:true,code:0,stdout:'identity-changed\n',stderr:''};
   endHandoffSession(session);
   continue;
  }
  return {ok:false,code:1,stdout:'',stderr:`unexpected tmux command: ${segment.join(' ')}`,message:'unexpected-command'};
 }
 return {ok:true,code:0,stdout,stderr:''};
}
const handoffPsRun=()=>({stdout:'',complete:true});
const integrationCatalog=(handoffIntegration||modelsFixture)?createReferenceCatalog({home:root,agentDir:join(root,'agent')}):null;
const modelRpcCalls=[];
const modelSpawn=(command,args,options)=>{
 if(command!=='pi')return spawn(command,args,options);
 modelRpcCalls.push({command,args:[...args]});
 const child=spawn(process.execPath,[fileURLToPath(new URL('../../workspaces/fixtures/fake-pi-rpc.mjs',import.meta.url)),...args],options);
 return child;
};
const handoffService=(handoffIntegration||modelsFixture)?createDiscussionService({...modelsFixture?{spawn:modelSpawn}:{},root:storage,agentDir:join(root,'agent'),referenceCatalog:modelsFixture?referenceCatalog:integrationCatalog,assignmentAdapters:{tmuxRun:handoffTmuxRun,observationProbes:{tmuxRun:handoffTmuxRun,psRun:handoffPsRun}}}):null;
const integrationSessionControl=handoffIntegration?createSessionControl({storageRoot:storage,transport:{run:handoffTmuxRun}}):null;
let integrationPublishChain=Promise.resolve();
function publishIntegrationSnapshot(){
 const run=async()=>{
  if(!handoffIntegration)return null;
  const snapshot=await collectWorkspace({storageRoot:storage,agentDir:join(root,'agent'),skipManagedIndex:true,assignmentProbes:{tmuxRun:handoffTmuxRun,psRun:handoffPsRun}});
  const wrapper={schema_version:1,observer_id:'fixture-integration',state:'observing',published_at:new Date().toISOString(),snapshot};
  const temporary=`${observerFile}.publishing`;
  await writeFile(temporary,JSON.stringify(wrapper));
  await rename(temporary,observerFile);
  return wrapper;
 };
 const result=integrationPublishChain.then(run);
 integrationPublishChain=result.then(()=>undefined,()=>undefined);
 return result;
}
async function handoffAssignmentRecord(ref,assignmentId){
 if(typeof ref!=='string'||!handoffPackageDirs.has(ref))throw new Error(`unknown fixture package reference: ${ref}`);
 if(typeof assignmentId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(assignmentId))throw new Error('assignment_id must be a UUID');
 const directory=handoffPackageDirs.get(ref);
 const recordPath=join(storage,'projects','fixture','assignments',`${assignmentId}.json`);
 const record=JSON.parse(await readFile(recordPath,'utf8'));
 if(record.assignment_id!==assignmentId)throw new Error('assignment record identity mismatch');
 const storedPackage=typeof record.spec_package==='string'?record.spec_package:(typeof record.package_ref==='string'?record.package_ref:null);
 if(storedPackage===null)throw new Error('assignment record does not name its spec package');
 const matches=storedPackage===ref||(await realpath(storedPackage).catch(()=>null))===(await realpath(directory).catch(()=>null));
 if(!matches)throw new Error(`assignment record package mismatch: ${storedPackage}`);
 return {record,directory,recordPath};
}
async function completeHandoffPlanning(url){
 const ref=url.searchParams.get('package_ref')??'';const assignmentId=url.searchParams.get('assignment_id')??'';const stage=url.searchParams.get('stage')||'proposal';
 if(!['proposal','prepared'].includes(stage))throw new Error(`unsupported handoff planning stage: ${stage}`);
 const {record,directory}=await handoffAssignmentRecord(ref,assignmentId);
 const skill=typeof record.skill==='string'?record.skill:'';
 if(!['spec-architect-initial','spec-architect-critics','spec-write'].includes(skill))throw new Error(`handoff-complete-planning requires a planning skill, got ${skill||'unrecorded'}`);
 const description=await integrationSessionControl.describe(assignmentId);
 if(!description.can_end)throw new Error(`handoff-complete-planning requires a verified open session, got ${description.state}: ${description.reason}`);
 await integrationSessionControl.end({assignment_id:assignmentId,confirm:true,expected_identity:description.identity});
 if(stage==='proposal')await writeFile(join(directory,'proposal.md'),'---\ncritique_recommended: true\n---\n\n# Integration proposal\nPlanning completed; critique is recommended before specification.\n');
 else{await writeFile(join(directory,'critique.md'),'# Integration critique\nArchitecture reviewed; proceed to specification.\n');await writeFile(join(directory,'spec-prepare.md'),'# Preparation report\n\nPrepared 2026-10-15\noutcome: prepared\n');await writeFile(join(directory,'spec-steps.json'),integrationSteps(3));}
 const wrapper=await publishIntegrationSnapshot();
 return {control:'handoff-complete-planning',package_ref:ref,assignment_id:assignmentId,stage,snapshot:wrapper?.snapshot??null,processStarts:handoffNewSessions};
}
async function writeHandoffReceipt(url){
 const ref=url.searchParams.get('package_ref')??'';const assignmentId=url.searchParams.get('assignment_id')??'';
 const {record,directory}=await handoffAssignmentRecord(ref,assignmentId);
 if(record.skill!=='spec-end-to-end')throw new Error(`handoff-write-receipt requires spec-end-to-end, got ${typeof record.skill==='string'?record.skill:'unrecorded'}`);
 const now=new Date().toISOString();
 const receipt={schema_version:1,id:assignmentId,assignment_id:assignmentId,package_ref:ref,package:directory,state:'running',started_at:now,dispatch_requested_at:now,step:'step-1-subspec.md',checkout:typeof record.execution_dir==='string'?record.execution_dir:checkout};
 await mkdir(join(directory,'runtime','runs'),{recursive:true});
 const receiptPath=join(directory,'runtime','runs',`${assignmentId}.json`);
 await writeFile(receiptPath,`${JSON.stringify(receipt)}\n`);
 await writeFile(join(directory,'runtime','run.json'),`${JSON.stringify(receipt)}\n`);
 const wrapper=await publishIntegrationSnapshot();
 return {control:'handoff-write-receipt',package_ref:ref,assignment_id:assignmentId,receiptPath,snapshot:wrapper?.snapshot??null,processStarts:handoffNewSessions};
}
const savedBriefs=new Map(),launchResolutions=new Map();let delaySuggestions=false,briefWritesPending=0,completedBriefWrites=0;
const thread1='11111111-1111-4111-8111-111111111111',thread2='22222222-2222-4222-8222-222222222222',thread3='44444444-4444-4444-8444-444444444444';
// thread1 carries a recorded repository target so Prepare can pass the recorded
// repository identity; thread2 stays workspace-bound with no route target;
// thread3 stores a worktree path that maps to the fixture-docs checkout and is
// displayed as the stored path, never as an inferred repository id.
let threads=[{thread_id:thread1,workspace_id:'fixture',title:'Discussion one',state:'idle',queue:[],attention:null,queue_paused:false,history_only:false,generation:1,updated_at:new Date().toISOString(),target:{kind:'repository',repository_id:'fixture-repo'}},{thread_id:thread2,workspace_id:'fixture',title:'Discussion two',state:'idle',queue:[],attention:null,queue_paused:false,history_only:false,generation:1,target:{kind:'workspace'}},{thread_id:thread3,workspace_id:'fixture',title:'Discussion worktree',state:'idle',queue:[],attention:null,queue_paused:false,history_only:false,generation:1,target:{kind:'worktree',path:docsCheckout}}];
if(modelsFixture)threads=await Promise.all(threads.map(({title,target})=>handoffService.create({workspace_id:'fixture',title,target})));
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
// Explicit observed planning facts, independently controlled per package.
const specsPlanningOverrides=new Map();
const plannedPlanningOverrides=new Map();
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
const resetBoundaryControls=()=>{specsPlanningOverrides.clear();plannedPlanningOverrides.clear();reviewHoldingRun=null;boundary.catalogFail=false;boundary.detailFail=false;boundary.stateFail=false;boundary.catalogDelayMs=0;boundary.detailDelayMs=0;boundary.detailDelayId='';boundary.stateDelayMs=0;boundary.stateClockOffsetMs=0;boundary.catalogMode='healthy';delayDispatchBrief=false;failDispatchBrief=false;delayDispatchSuggestions=false;holdDispatchPreview=false;holdDispatchLaunch=false;dispatchPreviewRefusal='none';dispatchLaunchRefusal='none';dispatchLaunchOutcome='live';launchedAssignments.clear();delayCreate=false;failCreate=false;holdThreadsWorkspace='';incompleteTail=false;invalidRecords=false;listFailStatus=0;historyFailStatus=0;releaseWaiters(dispatchPreviewWaiters);releaseWaiters(dispatchLaunchWaiters);releaseWaiters(createWaiters);if(activeBoundary.size===0){boundaryLog.length=0;boundaryAttempt=0;}};
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
const fixtureDiscussion={
 async prepareSpecTarget(input){const entry={name:'prepareSpecTarget',input};posts.push(entry);try{const directTarget=typeof input.repository_id==='string'&&dispatchRepos.some(repo=>repo.id===input.repository_id)?input.repository_id:null;const result=await prepareAssignmentSpecTarget({storageRoot:storage,workspace_id:input.workspace_id,target:directTarget??await fixtureAssignmentTarget(input.thread_id),specPackage:input.spec_package});entry.result=result;return result;}catch(error){entry.error={code:error?.code??null,message:error?.message??String(error)};throw error;}},
 async suggestions(input){posts.push({name:'suggestions',input});if(delaySuggestions)await new Promise(r=>setTimeout(r,650));const thread=threads.find(item=>item.thread_id===input.thread_id);if(!thread)throw Object.assign(new Error('Thread not found'),{code:'thread-not-found'});const target=thread.target&&typeof thread.target==='object'?thread.target:{};let executionDir=workspace.directory;if(target.kind==='repository'){const match=dispatchRepos.find(repo=>repo.id===target.repository_id);if(match)executionDir=await realpath(match.path);}else if(target.kind==='worktree'&&typeof target.path==='string'){executionDir=await realpath(target.path);}return referenceCatalog.suggest({workspace:{...workspace,repositories:dispatchRepos.map(repo=>({id:repo.id,path:repo.path}))},executionDir,kind:input.kind,query:input.query});},
 async list({workspace_id}){if(holdThreads&&(!holdThreadsWorkspace||workspace_id===holdThreadsWorkspace))await waitForRelease(threadWaiters);if(failThreads)throw Object.assign(new Error('Fixture thread list unavailable'),{code:'service-closed'});return {threads:workspace_id==='fixture'?copied(threads):[],invalid:workspace_id==='fixture'&&invalidRecords?[{reason:'invalid-json'},{reason:'fixture-secret-token'}]:[]};},
 async history({before}){if(before)return {entries:[{id:'entry-old',message:{role:'user',content:'Older message'}}],truncated:false,incomplete_tail:false};if(longHistory)return {entries:Array.from({length:48},(_,index)=>({id:`entry-long-${index+1}`,timestamp:new Date(Date.now()-index*60000).toISOString(),message:{role:index%2?'assistant':'user',content:`Long history message ${index+1}. Fixture transcript line for the retained reading position. A second sentence keeps each row tall enough to scroll.`}})),truncated:true,incomplete_tail:false};return {entries:copied(entries),truncated:true,incomplete_tail:incompleteTail};},
 async create(input){const entry={name:'create',input};posts.push(entry);if(delayCreate)await waitForRelease(createWaiters);if(failCreate)throw Object.assign(new Error('Fixture conversation creation failed'),{code:'service-closed'});const t={...threads[0],thread_id:randomUUID(),title:input.title||'New thread',target:input.target||{kind:'workspace'},queue:[],attention:null,model:input.model?{provider:input.model.provider,model:input.model.model}:null};threads=[t,...threads];createdThreads.push({thread_id:t.thread_id,workspace_id:t.workspace_id,target:copied(t.target),model:copied(t.model)});entry.result={thread_id:t.thread_id};return copied(t);},
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
const observedDispatch=name=>async input=>{const entry={name,input};posts.push(entry);try{const result=await handoffService[name](input);entry.result=result;return result;}catch(error){entry.error={code:error?.code??null,message:error?.message??String(error)};throw error;}};
const observedModel=name=>async input=>{
 const entry={name,input};posts.push(entry);
 try{
  const result=await handoffService[name](input);entry.result=result;
  if(name==='create')createdThreads.push(JSON.parse(await readFile(join(workspace.directory,'threads',`${result.thread_id}.json`),'utf8')));
  if(name==='dispatchLaunch'){
   const record=JSON.parse(await readFile(join(workspace.directory,'assignments',`${input.assignment_id}.json`),'utf8'));
   entry.persisted=record;
   resolverDiagnostics.push({name,matched:record.contract_digest===input.expectedDigest,record});
  }
  return result;
 }catch(error){entry.error={code:error?.code??null,message:error?.message??String(error)};throw error;}
};
const discussion=modelsFixture?{...handoffService,...Object.fromEntries(['create','send','dispatchSuggestions','dispatchSaveBrief','dispatchPreview','dispatchLaunch','prepareSpecTarget'].map(name=>[name,observedModel(name)]))}:handoffIntegration?{...fixtureDiscussion,list:observedDispatch('list'),prepareSpecTarget:observedDispatch('prepareSpecTarget'),dispatchSuggestions:observedDispatch('dispatchSuggestions'),dispatchSaveBrief:observedDispatch('dispatchSaveBrief'),dispatchPreview:observedDispatch('dispatchPreview'),dispatchLaunch:observedDispatch('dispatchLaunch')}:fixtureDiscussion;
// Result-case epic inventory: the bound planning result returns to this epic
// and offers the next independent member while its launch runs.
const plannedEpic={workspace:'fixture',epic:'demo',title:'Demo epic',state:'active',next:'other-browser',members:[{name:'base',package:'base',workspace:'fixture',status:specsReadiness?'merged':'prepared',requires:[],waiting_on:[],attention:false,planning:{prepared:true,step_count:2,preparation:{outcome:'prepared',reported_at:'2026-10-09T12:00:00Z',source:'spec-prepare.md',read:'ok',bytes:80},decision:null,receipts:[]}},{name:'browser',package:'browser',workspace:'fixture',status:'prepared',requires:['base'],waiting_on:[],attention:false,planning:{prepared:true,step_count:3,preparation:{outcome:'prepared',reported_at:'2026-10-10T12:00:00Z',source:'spec-prepare.md',read:'ok',bytes:120},decision:null,receipts:[]}},{name:'other-browser',package:'other-browser',workspace:'fixture',status:'proposed',requires:[],waiting_on:[],attention:false,planning:{proposal:false,prepared:false,step_count:0,preparation:{outcome:'missing'},decision:null,receipts:[]}}],summary:{total:3,merged:0,complete:0,attention:0},coverage:{state:'complete',reasons:[]}};
let specsAssignmentCoverage='complete';
if(specsReadiness){plannedEpic.members.push({name:'waiting-browser',package:'waiting-browser',workspace:'fixture',status:'prepared',requires:['other-browser'],waiting_on:['other-browser'],attention:false,planning:{prepared:true,step_count:5,preparation:{outcome:'prepared',reported_at:'2026-10-10T12:00:00Z',source:'spec-prepare.md',read:'ok',bytes:90},decision:null,receipts:[]}},{name:'incomplete-browser',package:'incomplete-browser',workspace:'fixture',status:'prepared',requires:[],waiting_on:[],attention:false,planning:{proposal:true,critique:false,critique_recommended:false,prepared:false,step_count:4,preparation:{outcome:'missing'},decision:null,receipts:[]}},{name:'legacy-browser',package:'legacy-browser',workspace:'fixture',status:'prepared',requires:[],waiting_on:[],attention:false},{name:'decision-browser',package:'decision-browser',workspace:'fixture',status:'prepared',requires:[],waiting_on:[],attention:false,planning:{prepared:true,step_count:6,preparation:{outcome:'prepared',reported_at:'2026-10-10T12:00:00Z',source:'spec-prepare.md',read:'ok',bytes:90},decision:{question:'Choose the storage layout'},receipts:[]}});plannedEpic.summary.total=plannedEpic.members.length;}
// Epic-planning members: prepared-prerequisite truth (base is prepared, not
// landed), an index-only prerequisite on an executing member, and a missing
// package directory whose Plan action must stay disabled.
if(epicPlanning)plannedEpic.members.push(
 {name:'prepared-prereq-browser',package:'prepared-prereq-browser',workspace:'fixture',status:'proposed',requires:['base'],waiting_on:[],attention:false,planning:{proposal:false,prepared:false,step_count:null,preparation:{outcome:'missing'},decision:null,receipts:[]}},
 {name:'index-browser',package:'index-browser',workspace:'fixture',status:'in-progress',requires:[],waiting_on:[],attention:false,planning:{prepared:false,step_count:2,preparation:{outcome:'missing'},decision:null,receipts:[]}},
 {name:'blocked-browser',package:'blocked-browser',workspace:'fixture',status:'proposed',requires:['index-browser'],waiting_on:[],attention:false,planning:{proposal:false,prepared:false,step_count:null,preparation:{outcome:'missing'},decision:null,receipts:[]}},
 {name:'missing-browser',package:'missing-browser',workspace:'fixture',status:'missing',requires:[],waiting_on:[],attention:false});
if(epicPlanning)plannedEpic.summary.total=plannedEpic.members.length;
const makeSnapshot=()=>{const now=new Date().toISOString();const run={workspace:'fixture',package:pkg,package_ref:'fixture/browser',assignment_id:'run-1',workflow_id:'workflow-1',execution:'running',workflow_state:'waiting-worker',is_current_assignment:true,activity:'Building the dashboard',obligation:'Keep editors stable',observed_at:now,coverage:{state:'complete',reasons:[]},spec_progress:{current_position:(tick%3)+1,total_steps:3,current_name:'Migrate view'},timing:{started_at:now,attempts:[]},evidence:{state:'recorded',verdict:'ready',scope:'declared-artifact',source:'work-tour.html',commit:'abc123',observed_at:now},epic:{epic:'demo',workspace:'fixture'}};
const runAssignment={assignment_id:'run-1',workspace_id:'fixture',task_activity:{state:'idle',reason:'The last response finished. The session is waiting for input.',finished_at:now,last_reply:'Architecture proposal complete.'},spec_package:'fixture/browser',workflow_id:'workflow-1',display:terminalAssignment==='ended'?'ended':'live',state:'live',executionDir:root,terminal:'fixture',coverage:{state:'complete',reasons:[]},nextAction:'Attach to the terminal'};
const snapshot={workspace:'fixture',coverage:{state:'complete',observed_at:now,reasons:[]},runs:plannedLaunch?(reviewHoldingRun?[reviewHoldingRun]:[]):[run],recently_completed:plannedLaunch?[]:[{...run,assignment_id:'landed',package:pkg,completion_basis:'merged-pr',completed_at:now,is_current_assignment:false}],assignments:[...(plannedLaunch||terminalAssignment==='absent'?[]:[runAssignment]),...[...launchedAssignments.values()].map(copied)],assignment_coverage:{state:'complete',reasons:[]},epics:plannedLaunch?[plannedEpic]:[{workspace:'fixture',epic:'demo',title:'Demo epic',state:'active',members:[{name:'browser',package:'browser',workspace:'fixture',status:'in-progress',waiting_on:[],attention:false}],summary:{total:1,merged:0,complete:0,attention:0},next:'browser',coverage:{state:'complete',reasons:[]}}]};if(plannedLaunch)snapshot.planned_packages=[{workspace:'fixture',package:pkg,package_ref:'fixture/browser',planned_at:'2026-10-10T12:00:00Z',prepared:true,step_count:3,preparation:{outcome:'prepared',reported_at:'2026-10-10T12:00:00Z',source:'spec-prepare.md',read:'ok',bytes:120},decision:null,receipts:[],targets:specsReadiness||epicPlanning?[{id:'main',primary:checkout}]:[{id:'main',primary:checkout},{id:'alternate',primary:secondCheckout}],source_paths:['spec.md']},{workspace:'fixture',package:otherPkg,package_ref:'fixture/other-browser',planned_at:'2026-10-11T12:00:00Z',prepared:false,step_count:0,preparation:{outcome:'missing'},decision:null,receipts:[],targets:specsReadiness||epicPlanning?[{id:'main',primary:checkout}]:[{id:'main',primary:checkout},{id:'alternate',primary:secondCheckout}],source_paths:['spec.md']}];
if(specsReadiness)snapshot.planned_packages.push({workspace:'fixture',package:readinessPackageDirs[0],package_ref:'fixture/waiting-browser',planned_at:'2026-10-10T12:00:00Z',prepared:true,step_count:5,preparation:{outcome:'prepared',reported_at:'2026-10-10T12:00:00Z',source:'spec-prepare.md',read:'ok',bytes:90},decision:null,receipts:[],requires:['other-browser'],targets:[{id:'main',primary:checkout}],source_paths:['spec.md']},{workspace:'fixture',package:readinessPackageDirs[1],package_ref:'fixture/incomplete-browser',planned_at:'2026-10-10T12:00:00Z',proposal:true,critique:false,critique_recommended:false,prepared:false,step_count:4,preparation:{outcome:'missing'},decision:null,receipts:[],targets:[{id:'main',primary:checkout}],source_paths:['spec.md']},{workspace:'fixture',package:readinessPackageDirs[2],package_ref:'fixture/legacy-browser',planned_at:'2026-10-10T12:00:00Z',source_paths:['spec.md'],targets:[{id:'main',primary:checkout}]},{workspace:'fixture',package:readinessPackageDirs[3],package_ref:'fixture/decision-browser',planned_at:'2026-10-10T12:00:00Z',prepared:true,step_count:6,preparation:{outcome:'prepared',reported_at:'2026-10-10T12:00:00Z',source:'spec-prepare.md',read:'ok',bytes:90},decision:{question:'Choose the storage layout'},receipts:[],targets:[{id:'main',primary:checkout}],source_paths:['spec.md']});
if(specsReadiness||epicPlanning)snapshot.assignment_coverage.state=specsAssignmentCoverage;
if(specsReadiness){
 snapshot.assignment_coverage.state=specsAssignmentCoverage;
 // Match collectFact: requires lives on the epic, report sources are absolute.
 for(const row of snapshot.planned_packages){
  delete row.requires;
  if(row.preparation?.source)row.preparation.source=join(row.package,'spec-prepare.md');
 }
}
if(epicPlanning)for(const slug of epicPlanningSlugs)snapshot.planned_packages.push({workspace:'fixture',package:join(workspace.directory,'specs',slug),package_ref:`fixture/${slug}`,planned_at:'2026-10-10T12:00:00Z',prepared:false,decision:null,receipts:[],targets:[{id:'main',primary:checkout}],source_paths:['spec.md']});
// Ordinary route fixtures have no planned inventory. Overrides only change
// observed planning facts, never manufacture packages in that mode.
for(const row of snapshot.planned_packages??[]){
 const override=specsPlanningOverrides.get(row.package_ref)??plannedPlanningOverrides.get(row.package_ref);
 if(override)Object.assign(row,override);
}
return {schema_version:1,observer_id:'fixture',state:'observing',published_at:now,snapshot};};
const makeMismatchSnapshot=()=>{const now=new Date().toISOString();const run=(workspaceName,packagePath,packageRef,activity)=>({workspace:workspaceName,package:packagePath,package_ref:packageRef,assignment_id:'mismatch-run',workflow_id:'mismatch-workflow',execution:'running',workflow_state:'waiting-external',is_current_assignment:true,activity,obligation:activity,observed_at:now,coverage:{state:'complete',reasons:[]},spec_progress:{current_position:1,total_steps:2,current_name:'Mismatch step'},timing:{started_at:now,attempts:[]}});return {schema_version:1,observer_id:'mismatch-fixture',state:'observing',published_at:now,snapshot:{workspace:'physical',coverage:{state:'complete',observed_at:now,reasons:[]},runs:[run('physical',alphaKitPackage,'alpha/alpha-kit','Alpha kit run'),run('alpha',physicalKitPackage,'physical/physical-kit','Neighbor physical run')],recently_completed:[],assignments:[{assignment_id:'alpha-assignment',workspace_id:'alpha',workspace:'physical',spec_package:'alpha/alpha-kit',workflow_id:'mismatch-workflow',display:'live',state:'live',executionDir:root,coverage:{state:'complete',reasons:[]},task_activity:{state:'idle',reason:'Waiting for mismatch review.'},nextAction:'Review mismatch assignment'},{assignment_id:'physical-assignment',workspace_id:'physical',workspace:'alpha',spec_package:'physical/physical-kit',workflow_id:'mismatch-workflow',display:'live',state:'live',executionDir:root,coverage:{state:'complete',reasons:[]},task_activity:{state:'idle',reason:'Waiting for mismatch review.'},nextAction:'Review mismatch assignment'}],assignment_coverage:{state:'complete',reasons:[]},epics:[{workspace:'physical',epic:'alpha-kit-epic',title:'Alpha kit epic',state:'active',members:[{name:'alpha-kit',package:'alpha-kit',workspace:'physical',status:'in-progress',waiting_on:[],attention:false}],summary:{total:1,merged:0,complete:0,attention:0},next:'alpha-kit',coverage:{state:'complete',reasons:[]}},{workspace:'alpha',epic:'physical-neighbor-epic',title:'Neighbor physical epic',state:'active',members:[{name:'physical-kit',package:'physical-kit',workspace:'alpha',status:'in-progress',waiting_on:[],attention:false}],summary:{total:1,merged:0,complete:0,attention:0},next:'physical-kit',coverage:{state:'complete',reasons:[]}}]}};};
if(!handoffIntegration&&!nextSteps)await writeFile(mismatchObserverFile,JSON.stringify(makeMismatchSnapshot()));
let sessionEnded=false,sessionEndFails=false,sessionIdentity='fixture-identity';
const sessionControl={
 async describe(id){return {assignment_id:id,identity:sessionIdentity,state:sessionEnded?'ended':'open',can_end:!sessionEnded,reason:sessionEnded?'Session has ended. Saved files and transcript remain available.':'Terminal session is open.',attach_command:sessionEnded?null:"ssh -t operator@host 'tmux -S /tmp/fixture.sock attach-session -t =fixture'",local_command:sessionEnded?null:'tmux -S /tmp/fixture.sock attach-session -t =fixture'};},
 async end(input){posts.push({name:'endSession',input});if(sessionEndFails)throw new Error('Session identity changed. Refresh and review it again.');if(input.confirm!==true||input.expected_identity!==sessionIdentity)throw new Error('Session identity changed. Refresh and review it again.');sessionEnded=true;return {state:'ended'};},
};
// Terminal-only verification stub. The player asset, the open action and the
// state matrix are fake and only counted; no tmux, asciinema or WebSocket
// stream is started. Existing public/local Host/Origin mapping and the
// dashboard upgrade forwarding stay untouched, and the teardown drain hook
// still closes the injected dashboard through closeTerminalViews.
let terminalState='none',terminalDelayMs=0,terminalOpenDelayMs=0,terminalFailAsset='none',terminalAssignment='live';
const terminalCounts={open:0,openById:{},assets:{styles:0,script:0},assetById:{}};
const terminalStateStatus={'not-live':404,changed:409,'not-installed':503,busy:503,failed:503,'not-running':503};
const terminalStateMessage={'not-live':'The assignment terminal is not live.',changed:'The assignment terminal identity changed. Reconcile it before viewing.','not-installed':'asciinema is not installed on the dashboard host.',busy:'Terminal streams are unavailable. Try again shortly.',failed:'The terminal stream could not be started.','not-running':'The terminal stream is not running.'};
const TERMINAL_STUB_STYLES='.terminal-frame{background:#050505;color:#b6f7b6;font-family:monospace;font-size:12px;height:100%;padding:8px;white-space:pre-wrap;overflow:hidden}';
const TERMINAL_STUB_SCRIPT=`(function(){
  window.__fixturePlayerCreates=window.__fixturePlayerCreates||{};
  window.__fixturePlayerDisposals=window.__fixturePlayerDisposals||0;
  window.AsciinemaPlayer={create:function(source,element){
    var url=String(source&&source.url||'');
    var parts=url.split('/api/assignment-terminal/');
    var id=parts.length>1?decodeURIComponent(parts[1].split('/')[0]):'unknown';
    window.__fixturePlayerCreates[id]=(window.__fixturePlayerCreates[id]||0)+1;
    var listeners={},disposed=false;
    function emit(name){var fns=listeners[name]||[];for(var i=0;i<fns.length;i++){try{fns[i]();}catch(error){}}}
    element.setAttribute('data-fixture-player','stub');
    element.textContent='fixture terminal output';
    setTimeout(function(){if(!disposed){element.textContent='fixture terminal output\\n$ ready';emit('loading');}},20);
    setTimeout(function(){if(!disposed)emit('playing');},80);
    return {
      addEventListener:function(name,fn){if(!listeners[name])listeners[name]=[];listeners[name].push(fn);},
      removeEventListener:function(name,fn){var fns=listeners[name]||[];var index=fns.indexOf(fn);if(index>=0)fns.splice(index,1);},
      dispose:function(){if(disposed)return;disposed=true;window.__fixturePlayerDisposals++;element.textContent='';element.removeAttribute('data-fixture-player');}
    };
  }};
})();`;
async function readTerminalRequest(req,limit){
 let bytes=0;const chunks=[];
 for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)return null;chunks.push(Buffer.from(chunk));}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return null;}
}
async function handleTerminalRequest(req,res,url,assetMatch){
 const send=(status,body,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(typeof body==='string'?body:JSON.stringify(body));};
 if(url.pathname==='/api/assignment-terminal/open'){
  if(req.method!=='POST'){send(405,{error:'Use POST.'});return;}
  const input=await readTerminalRequest(req,4096);
  const id=typeof input?.assignment_id==='string'?input.assignment_id:'';
  if(!id){send(400,{error:'Assignment ID must be a UUID.'});return;}
  terminalCounts.open+=1;terminalCounts.openById[id]=(terminalCounts.openById[id]||0)+1;
  if(terminalOpenDelayMs>0)await new Promise(resolve=>setTimeout(resolve,terminalOpenDelayMs));
  if(terminalState!=='none'){const state=terminalState;send(terminalStateStatus[state]??503,{state,error:terminalStateMessage[state]??'The terminal stream could not be started.'});return;}
  send(200,{assignment_id:id,state:'live'});
  return;
 }
 const id=assetMatch[1],assetFile=assetMatch[2];
 if(assetFile!=='asciinema-player.css'&&assetFile!=='asciinema-player.min.js'){send(404,{error:'Not found'});return;}
 const kind=assetFile==='asciinema-player.css'?'styles':'script';
 terminalCounts.assets[kind]+=1;
 const perAssignment=terminalCounts.assetById[id]??(terminalCounts.assetById[id]={styles:0,script:0});
 perAssignment[kind]+=1;
 if(terminalDelayMs>0)await new Promise(resolve=>setTimeout(resolve,terminalDelayMs));
 if(terminalFailAsset===kind||terminalFailAsset==='both'){send(503,{error:'Fixture player asset failure.'});return;}
 send(200,kind==='styles'?TERMINAL_STUB_STYLES:TERMINAL_STUB_SCRIPT,kind==='styles'?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
}
if(nextSteps)await publishNextStepsSnapshot();
else if(handoffIntegration)await publishIntegrationSnapshot();
else await writeFile(observerFile,JSON.stringify(makeSnapshot()));
const dashboard=createDashboardServer({...modelsFixture?{modelCatalog:fixtureCatalog}:{},agentDir:join(root,'agent'),storageRoot:storage,publicHost:'dashboard.example',discussion,sessionControl});
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');
 if(url.pathname==='/__fixture/control'){
  const action=url.searchParams.get('action');
  let controlResult=null;
  if(handoffIntegration&&action==='handoff-complete-planning')try{controlResult=await completeHandoffPlanning(url);}catch(error){controlResult={control:'handoff-complete-planning',error:String(error?.message??error)};}
  if(handoffIntegration&&action==='handoff-write-receipt')try{controlResult=await writeHandoffReceipt(url);}catch(error){controlResult={control:'handoff-write-receipt',error:String(error?.message??error)};}
  if(action==='observer')observerMode=url.searchParams.get('value')==='true';
  if(nextSteps&&action==='next-arrive'){try{const slug=`arrive-${++nextStepsArrivals}`;const created=await newPackage({root:storage,workspace:'fixture',slug,targets:[{id:'fixture-repo'}]});if(!created.ok)throw new Error(`${created.code}: ${created.message}`);const item={slug,workspace:'fixture',wsId:'fixture',dir:join(storage,'projects','fixture','specs',slug),packageRef:`fixture/${slug}`};nextStepsPackages.set(slug,item);nextStepsDynamicDirs.add(item.dir);const path=await nextStepsWrite(item.dir,'proposal.md',nextStepsProposal('COMPATIBLE_WITH_CAVEATS',true,`Arrived proposal ${slug} for the fixture workspace.`),Date.now());nextStepsLastMutation={action:'next-arrive',at:Date.now(),slug,package:item.dir,file:await nextStepsStat(path)};await publishNextStepsSnapshot();controlResult={control:'next-arrive',...(nextStepsLastMutation??{})};}catch(error){controlResult={control:'next-arrive',error:String(error?.message??error)};}}
  if(nextSteps&&action==='next-critique'){try{const item=nextStepsPackages.get('recommended');if(!item)throw new Error('recommended package is absent');const path=join(item.dir,'critique.md');await writeFile(path,nextStepsCritique);await utimes(path,new Date(),new Date());nextStepsLastMutation={action:'next-critique',at:Date.now(),slug:'recommended',package:item.dir,file:await nextStepsStat(path)};await publishNextStepsSnapshot();controlResult={control:'next-critique',...(nextStepsLastMutation??{})};}catch(error){controlResult={control:'next-critique',error:String(error?.message??error)};}}
  if(nextSteps&&action==='next-remove'){const slug=url.searchParams.get('slug')||'recommended';const item=nextStepsPackages.get(slug);const removed=[];if(item)for(const name of nextStepsWatched){const path=join(item.dir,name);if(await nextStepsExists(path)){await rm(path,{force:true});removed.push(path);}}nextStepsLastMutation={action:'next-remove',at:Date.now(),slug,package:item?.dir??null,removed,stats:item?await Promise.all(nextStepsWatched.map(name=>nextStepsStat(join(item.dir,name)))):[]};await publishNextStepsSnapshot();controlResult={control:'next-remove',...(nextStepsLastMutation??{})};}
  if(nextSteps&&action==='next-empty'){const removed=[];for(const pkgItem of nextStepsPackages.values())for(const name of nextStepsWatched){const path=join(pkgItem.dir,name);if(await nextStepsExists(path)){await rm(path,{force:true});removed.push(path);}}const epicRemoved=await nextStepsExists(nextStepsEpicPath);await rm(nextStepsEpicDir,{recursive:true,force:true});nextStepsLastMutation={action:'next-empty',at:Date.now(),removed,epicRemoved};await publishNextStepsSnapshot();controlResult={control:'next-empty',...(nextStepsLastMutation??{})};}
  if(nextSteps&&action==='next-partial-zero'){for(const pkgItem of nextStepsPackages.values())for(const name of nextStepsWatched)await rm(join(pkgItem.dir,name),{force:true});await rm(nextStepsEpicDir,{recursive:true,force:true});await applyCatalogMode('partial');nextStepsLastMutation={action:'next-partial-zero',at:Date.now(),catalogMode:'partial'};await publishNextStepsSnapshot();controlResult={control:'next-partial-zero',...(nextStepsLastMutation??{})};}
  if(nextSteps&&action==='next-reset'){await restoreHealthyWorkspace();await nextStepsOtherKit();for(const pkgItem of nextStepsPackages.values())for(const name of nextStepsWatched)await rm(join(pkgItem.dir,name),{force:true});for(const [slug,pkgItem] of [...nextStepsPackages])if(nextStepsDynamicDirs.has(pkgItem.dir))nextStepsPackages.delete(slug);for(const path of [...nextStepsInitialFiles.keys()])for(const dir of nextStepsDynamicDirs)if(path.startsWith(dir)){nextStepsInitialFiles.delete(path);break;}for(const dir of nextStepsDynamicDirs)await rm(dir,{recursive:true,force:true});nextStepsDynamicDirs.clear();for(const [path,stored] of nextStepsInitialFiles){await mkdir(dirname(path),{recursive:true});await writeFile(path,stored.bytes);await utimes(path,new Date(stored.mtimeMs),new Date(stored.mtimeMs));}nextStepsLastMutation={action:'next-reset',at:Date.now(),restored:nextStepsInitialFiles.size};await publishNextStepsSnapshot();controlResult={control:'next-reset',...(nextStepsLastMutation??{})};}
  if(nextSteps&&action==='next-local')localOperator=url.searchParams.get('value')==='true';
  if(nextSteps&&action==='next-scan-fail')nextStepsScanFail=url.searchParams.get('value')==='true';
  if(nextSteps&&action==='next-scan-delay-ms')nextStepsScanDelayMs=numberValue(url.searchParams.get('value'),0,15000);
  if(action==='session-end-fails')sessionEndFails=url.searchParams.get('value')==='true';
  if(action==='session-identity'){const next=url.searchParams.get('value');sessionIdentity=next?next:'fixture-identity';}
  if(action==='terminal-state')terminalState=url.searchParams.get('value')||'none';
  if(action==='terminal-delay-ms')terminalDelayMs=numberValue(url.searchParams.get('value'),0,15000);
  if(action==='terminal-open-delay-ms')terminalOpenDelayMs=numberValue(url.searchParams.get('value'),0,15000);
  if(action==='terminal-fail-asset')terminalFailAsset=url.searchParams.get('value')||'none';
  if(action==='terminal-assignment'){terminalAssignment=url.searchParams.get('value')||'live';await writeFile(observerFile,JSON.stringify(makeSnapshot()));}
  if(action==='terminal-reset'){terminalState='none';terminalDelayMs=0;terminalOpenDelayMs=0;terminalFailAsset='none';terminalAssignment='live';}
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
  if(action==='integration-tmux-fail')handoffTmuxFail=url.searchParams.get('value')==='true';
  if(action==='review-holding-run'){const value=url.searchParams.get('value')||'';reviewHoldingRun=value?{workspace:'fixture',package:pkg,package_ref:'fixture/browser',assignment_id:value,workflow_id:'workflow-1',execution:'running',workflow_state:'waiting-worker',is_current_assignment:true,activity:'Holding fixture/browser',obligation:'Finish before another review',observed_at:new Date().toISOString(),coverage:{state:'complete',reasons:[]}}:null;}
  if(action==='publish-assignment'){const id=url.searchParams.get('value')||'';const skill=url.searchParams.get('skill')||'';const specPackage=url.searchParams.get('package')||'fixture/browser';if(id){launchedAssignments.set(id,{assignment_id:id,workspace_id:'fixture',spec_package:specPackage,workflow_id:'workflow-1',display:'live',state:'live',executionDir:root,terminal:'fixture',coverage:{state:'complete',reasons:[]},task_activity:{state:'idle',reason:'Fixture assignment is waiting for input.'},nextAction:'Attach to the terminal',...(skill?{skill}:{})});await writeFile(observerFile,JSON.stringify(makeSnapshot()));}}
  if(action==='clear-launch-publications')launchedAssignments.clear();
  if(action==='planned-planning-facts'&&plannedLaunch){
   const ref=url.searchParams.get('package_ref')||'fixture/browser';
   const value=url.searchParams.get('value');
   if(!value||value==='null')plannedPlanningOverrides.delete(ref);else plannedPlanningOverrides.set(ref,JSON.parse(value));
  }
  if(action==='specs-package-facts'&&(specsReadiness||epicPlanning)){
   const ref=url.searchParams.get('package_ref')||'';
   const value=url.searchParams.get('value');
   if(ref){if(!value||value==='null')specsPlanningOverrides.delete(ref);else specsPlanningOverrides.set(ref,JSON.parse(value));}
  }
  if(action==='specs-assignment-coverage'&&(specsReadiness||epicPlanning))specsAssignmentCoverage=url.searchParams.get('value')||'unknown';
  if(action==='epic-planning-facts'&&epicPlanning){
   const member=plannedEpic.members.find(item=>item.name===(url.searchParams.get('member')||'other-browser'));
   const value=url.searchParams.get('value');
   if(member&&value)member.planning=JSON.parse(value);
  }
  if(action==='epic-base-status'&&epicPlanning)plannedEpic.members[0].status=url.searchParams.get('value')||'prepared';
  if(action==='specs-publish-snapshot'&&(specsReadiness||epicPlanning))await writeFile(observerFile,JSON.stringify(makeSnapshot()));
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
  if(modelsFixture&&action==='models-catalog-fail')modelsCatalogFail=url.searchParams.get('value')==='true';
  if(modelsFixture&&action==='models-stale'){modelsReadAt=url.searchParams.get('value')==='true'?Date.now()-30*60*60*1000:Date.now();}
  if(modelsFixture&&action==='models-preferences-broken')await writeFile(join(root,'agent','spec-sentinel','preferred-models.json'),url.searchParams.get('value')==='true'?'{ broken json':modelsPreferredSeed);
  if(modelsFixture&&action==='models-preferences-empty')await writeFile(join(root,'agent','spec-sentinel','preferred-models.json'),url.searchParams.get('value')==='true'?`{"version":1,"preferred":[],"updated_at":"2026-10-14T14:31:00.000Z"}`:modelsPreferredSeed);
  if(modelsFixture&&action==='models-catalog-drop')modelsCatalogDrop=url.searchParams.get('value')||'';
  const modelsState=modelsFixture?{catalogFail:modelsCatalogFail,drop:modelsCatalogDrop,readAt:new Date(modelsReadAt).toISOString(),stale:Date.now()-modelsReadAt>24*60*60*1000}:null;
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...packageIdentity,local:localOperator,posts,resolverDiagnostics,threads,createdThreads,modelRpcCalls,modelTmuxCalls:handoffTmuxCalls,tick,boundary,threadControls:{holdThreads,holdThreadsWorkspace,failThreads,longHistory,incompleteTail,invalidRecords,listFailStatus,historyFailStatus,responseState},subscribedThreadIds:[...new Set([...subscribers].map(item=>item.thread_id))],createControls:{delayCreate,failCreate},session:{identity:sessionIdentity,ended:sessionEnded},terminal:{state:terminalState,delayMs:terminalDelayMs,openDelayMs:terminalOpenDelayMs,failAsset:terminalFailAsset,assignment:terminalAssignment,counts:terminalCounts},review:{holdDispatchPreview,holdDispatchLaunch,dispatchPreviewRefusal,dispatchLaunchRefusal,staleLaunch,holdingRun:reviewHoldingRun?.assignment_id??null},launch:{outcome:dispatchLaunchOutcome,published:[...launchedAssignments.keys()]},diagnostics:{resolvers:resolverDiagnostics},boundaryLog:boundaryLog.slice(-60),active:[...activeBoundary.values()],launchResolutions:Object.fromEntries(launchResolutions),briefWritesPending,completedBriefWrites,integration:handoffIntegration?{enabled:true,processStarts:handoffNewSessions,sessions:[...handoffSessions.values()].map(session=>({session:session.name,socket:session.socketPath,assignment_id:session.assignmentId,ended:session.ended})),tmuxCalls:handoffTmuxCalls.length}:{enabled:false},models:modelsState,...(nextSteps?{nextSteps:await nextStepsMeta()}:{}),...(controlResult??{})}));return;
 }
 const terminalAsset=/^\/api\/assignment-terminal\/([^/]+)\/([^/]+)$/.exec(url.pathname);
 if(url.pathname==='/api/assignment-terminal/open'||terminalAsset){await handleTerminalRequest(req,res,url,terminalAsset);return;}
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
 if(url.pathname==='/api/models/preferred'&&req.method==='POST')modelsPreferencePosts+=1;
 if(!readKind){
  if(nextSteps&&url.pathname==='/api/next-steps'&&(nextStepsScanFail||nextStepsScanDelayMs>0)){const attempt=startBoundary('next-steps','scan');if(nextStepsScanDelayMs>0)await new Promise(resolve=>setTimeout(resolve,nextStepsScanDelayMs));if(nextStepsScanFail){finishBoundary(attempt,'fail');res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'fixture-next-steps-failure'}));return;}finishBoundary(attempt,'complete');}
  dashboard.emit('request',req,res);return;
 }
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
  if(readKind==='state'&&observerMode&&(typeof body==='string'||Buffer.isBuffer(body))){
   const text=Buffer.isBuffer(body)?body.toString('utf8'):body;
   try{
    const parsed=JSON.parse(text);
    delete parsed.action_token;
    delete parsed.thread_action_token;
    body=JSON.stringify(parsed);
   }catch{}
  }
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
// Upgrades bypass the request handler; mirror the same trusted-Serve Host/Origin
// classification the request path applies so the dashboard upgrade boundary sees
// a consistent operator view.
server.on('upgrade',(req,socket,head)=>{
 if(!localOperator){req.headers.host='dashboard.example';if(req.headers.origin)req.headers.origin='https://dashboard.example';}
 dashboard.emit('upgrade',req,socket,head);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const timer=setInterval(()=>{
 if(nextSteps){tick++;void publishNextStepsSnapshot();return;}
 if(handoffIntegration){void publishIntegrationSnapshot().catch(()=>{});return;}
 tick++;void writeFile(observerFile,JSON.stringify(makeSnapshot()));void writeFile(mismatchObserverFile,JSON.stringify(makeMismatchSnapshot()));
},1000);
console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,root,checkout,secondCheckout,otherPackage:otherPkg,...packageIdentity,thread1,thread2,thread3,worktreeTarget:docsCheckout,integration:handoffIntegration,nextSteps:nextSteps?await nextStepsMeta():undefined}));
async function close(){
 clearInterval(timer);
 if(handoffIntegration||modelsFixture){
  await integrationPublishChain.catch(()=>{});
  if(handoffService)await handoffService.close().catch(()=>{});
  for(const session of handoffSessions.values())endHandoffSession(session);
 }
 if(nextSteps)await nextStepsPublishChain.catch(()=>{});
 const drained=dashboard.closeTerminalViews();
 server.closeAllConnections();await new Promise(r=>server.close(r));await drained.catch(()=>{});await rm(root,{recursive:true,force:true});process.exit(0);
}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
