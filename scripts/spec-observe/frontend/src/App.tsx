import { For, Show, Switch, Match, createSignal, createMemo, createEffect, onMount, onCleanup, untrack } from 'solid-js';
import { getJson, postJson } from './api';
import { str, base, time, activeRun, attention, setClock, tickClock, stale, statusMarkdown } from './format';
import { normalizeEnvelope, authoritativeObservers, collectRecords, collectAssignments, collectEpics, type Envelope, type WireRecord } from './model';
import { PackageList, PackageDetail, AgentList, AgentDetail, EpicList, EpicDetail } from './Observations';
import Threads from './Threads';
import Files from './Files';
import Designs from './Designs';

type Mode='packages'|'workspaces'|'agents'|'epics';
type Filter='active'|'attention'|'completed';
type Catalog={storage?:WireRecord;valid:WireRecord[];invalid?:WireRecord[];errors?:WireRecord[]};
const liveBrowser=()=>location.protocol!=='file:';

export default function App(){
 const [payload,setPayload]=createSignal<Envelope|null>(null);
 const [imported,setImported]=createSignal(false);
 const [error,setError]=createSignal('');
 const [fetching,setFetching]=createSignal(false);
 const [mode,setMode]=createSignal<Mode>('packages');
 const [filter,setFilter]=createSignal<Filter>('active');
 const [query,setQuery]=createSignal('');
 const [selected,setSelected]=createSignal<string|null>(null);
 const [selectedAgent,setSelectedAgent]=createSignal<string|null>(null);
 const [selectedEpic,setSelectedEpic]=createSignal<string|null>(null);
 const [catalog,setCatalog]=createSignal<Catalog|null>(null);
 const [catalogError,setCatalogError]=createSignal('');
 const [workspaceId,setWorkspaceId]=createSignal('');
 const [workspace,setWorkspace]=createSignal<WireRecord|undefined>();
 const [workspaceError,setWorkspaceError]=createSignal('');
 const [refreshKey,setRefreshKey]=createSignal(0);
 const [openFile,setOpenFile]=createSignal<string|null>(null);
 const [completion,setCompletion]=createSignal<WireRecord|null>(null);
 const [completionBusy,setCompletionBusy]=createSignal(false);
 const [completionError,setCompletionError]=createSignal('');
 let importInput!:HTMLInputElement,dialog!:HTMLDialogElement;
 let stateGeneration=0,catalogGeneration=0,workspaceGeneration=0,catalogBusy=false;
 let workspaceBusyId:string|null=null;
 const live=()=>liveBrowser()&&!imported();
 const records=createMemo(()=>collectRecords(payload()));
 const [endedSessions,setEndedSessions]=createSignal<string[]>([]);
 const assignments=createMemo(()=>collectAssignments(payload()).map(a=>!imported()&&endedSessions().includes(a.assignment_id)?{...a,display:'ended',recordedState:'ended',observedState:'ended',task_activity:undefined,quiet:false,nextAction:'History',safeAction:'History'}:a));
 const epics=createMemo(()=>collectEpics(payload()));
 const record=createMemo(()=>records().find(r=>r.key===selected()));
 const agent=createMemo(()=>assignments().find(a=>a.key===selectedAgent()));
 const epic=createMemo(()=>epics().find(e=>e.key===selectedEpic()));
 const token=()=>live()&&!error()?payload()?.thread_action_token||payload()?.action_token:undefined;
 const completionToken=()=>live()&&!error()?payload()?.action_token:undefined;
 const observers=createMemo(()=>authoritativeObservers(payload()?.observers??[]));
 const freshObservers=()=>observers().filter(o=>o.state==='observing'&&!stale(o.published_at));
 const connectionLabel=()=>imported()?'Imported snapshot':error()?'Connection unavailable':freshObservers().length?'Monitor connected':observers().length?'Monitor stale':'Waiting for monitor';
 const q=()=>query().trim().toLowerCase();
 const visibleRecords=createMemo(()=>records().filter(r=>(!q()||[r.workspace,r.package_ref,r.package,r.activity,r.obligation,r.execution].some(v=>str(v).toLowerCase().includes(q())))&&(filter()==='completed'?r.recent_completion:filter()==='attention'?attention(r):activeRun(r))).sort((a,b)=>filter()==='completed'?Date.parse(b.completed_at)-Date.parse(a.completed_at)||str(a.package).localeCompare(str(b.package)):0));
 const visibleAssignments=createMemo(()=>assignments().filter(a=>!q()||[a.assignment_id,a.spec_package,a.workflow_id,a.display,a.nextAction||a.safeAction].some(v=>str(v).toLowerCase().includes(q()))));
 const visibleEpics=createMemo(()=>epics().filter(e=>!q()||[e.title,e.epic,e.workspace,...(e.members??[]).map((m:WireRecord)=>m.name)].some(v=>str(v).toLowerCase().includes(q()))));
 const epicSupport=()=>!observers().length?'No observer snapshots':!observers().some(o=>Array.isArray(o.snapshot?.epics))?'Epic data unavailable':null;
 const workspaceRows=()=>catalog()?.valid.filter(w=>!q()||[w.id,w.name,w.directory].some(v=>str(v).toLowerCase().includes(q())))??[];
 const count=()=>mode()==='workspaces'?workspaceRows().length:mode()==='agents'?assignments().filter(a=>!q()||[a.assignment_id,a.spec_package,a.workflow_id,a.display,a.nextAction||a.safeAction].some(v=>str(v).toLowerCase().includes(q()))).length:mode()==='epics'?epics().filter(e=>!q()||[e.title,e.epic,e.workspace,...(e.members??[]).map((m:WireRecord)=>m.name)].some(v=>str(v).toLowerCase().includes(q()))).length:records().filter(r=>(!q()||[r.workspace,r.package_ref,r.package,r.activity,r.obligation,r.execution].some(v=>str(v).toLowerCase().includes(q())))&&(filter()==='completed'?r.recent_completion:filter()==='attention'?attention(r):activeRun(r))).length;
 const notes=()=>{
  const out:string[]=[];if(error())out.push(error());if(payload()?.truncated)out.push('Snapshot read budget reached; some observations are unavailable.');
  for(const e of payload()?.errors??[])out.push(`${e.source?str(e.source)+': ':''}${str(e.message)}`);
  if(!imported()&&!error()&&observers().length&&!freshObservers().length)out.push('Observer heartbeat is stale; work may have continued since this snapshot.');
  for(const o of observers())for(const a of o.snapshot?.attention??[])if(a.kind==='legacy-location')out.push(`Untracked .specs in ${a.repository} (${a.count} entries). Remedy: ${a.remedy}.`);
  return out;
 };
 const storageDiagnostics=()=>{
  const c=catalog(),storage=c?.storage; if(!storage)return [];
  const seen=new Set<string>();return [...(storage.errors??[]),...(c?.errors??[])].map(e=>typeof e==='object'?e:{message:e}).filter(e=>{const k=JSON.stringify([e.path,e.message]);if(e.message===storage.status||seen.has(k))return false;seen.add(k);return true;});
 };
 async function refresh(manual=false){
  if(fetching())return;
  if(manual){setImported(false);setRefreshKey(k=>k+1);}
  if(imported())return;
  if(!liveBrowser()){setError('Import a published snapshot to inspect it offline.');return;}
  const request=++stateGeneration;setFetching(true);
  try{const value=normalizeEnvelope(await getJson<unknown>('/api/state',AbortSignal.timeout(10000)));if(request!==stateGeneration||imported())return;setClock(value.generated_at);setPayload(value);setError('');}
  catch{if(request===stateGeneration&&!imported())setError('Could not refresh workspace state. Retry to reconnect.');}
  finally{if(request===stateGeneration)setFetching(false);}
 }
 async function loadCatalog(){
  if(!live()||catalogBusy)return;catalogBusy=true;const request=++catalogGeneration;
  try{const value=await getJson<Catalog>('/api/workspaces');if(request!==catalogGeneration||!live())return;setCatalog(value);setCatalogError('');if(workspaceId()&&!value.valid.some(w=>w.id===workspaceId())){setWorkspace(undefined);setWorkspaceError('Selected workspace is no longer in the catalog.');}else if(workspaceId())void loadWorkspace(workspaceId());}
  catch{if(request===catalogGeneration)setCatalogError('Could not load workspaces.');}
  finally{if(request===catalogGeneration)catalogBusy=false;}
 }
 async function loadWorkspace(id:string){
  if(!live()||!id||workspaceBusyId===id)return;workspaceBusyId=id;const request=++workspaceGeneration;
  try{const value=await getJson<WireRecord>('/api/workspace?'+new URLSearchParams({id}));if(request!==workspaceGeneration||workspaceId()!==id||!live())return;setWorkspace(value);setWorkspaceError('');}
  catch{if(request===workspaceGeneration&&workspaceId()===id)setWorkspaceError('Could not load workspace. Retry to reconnect.');}
  finally{if(workspaceBusyId===id)workspaceBusyId=null;}
 }
 function chooseWorkspace(id:string){if(id!==workspaceId()){workspaceGeneration++;setWorkspace(undefined);setWorkspaceError('');setOpenFile(null);setWorkspaceId(id);}void loadWorkspace(id);}
 function chooseMode(next:Mode){setMode(next);setQuery('');setOpenFile(null);if(next==='workspaces')void loadCatalog();}
 function chooseRecord(k:string){setSelected(k);setOpenFile(null);}
 function askCompletion(){const r=record();if(!r||!live()||!payload()?.action_token)return;setCompletion(r);setCompletionError('');dialog.showModal();}
 async function complete(){const r=completion();if(!r||!payload()?.action_token||completionBusy())return;setCompletionBusy(true);try{await postJson('/api/package-completion',{package:r.package},payload()!.action_token!);dialog.close();setCompletion(null);await refresh();}catch(e){setCompletionError(e instanceof Error?e.message:'Completion could not be saved. Retry.');}finally{setCompletionBusy(false);}}
 async function importSnapshot(file:File|undefined){if(!file)return;try{if(file.size>12*1024*1024)throw Error('File too large.');const value=normalizeEnvelope(JSON.parse(await file.text()));stateGeneration++;catalogGeneration++;workspaceGeneration++;catalogBusy=false;workspaceBusyId=null;setFetching(false);setClock(undefined);setPayload(value);setImported(true);setError('');setMode('packages');setFilter('active');setCatalog(null);setCatalogError('');setSelected(null);setSelectedAgent(null);setSelectedEpic(null);setWorkspaceId('');setWorkspace(undefined);setOpenFile(null);}catch{setError('Choose a valid Sentinel JSON snapshot smaller than 12 MB.');}finally{importInput.value='';}}
 // Follow a package across dispatches without replacing the components that own editors.
 let selectedIdentity:{workspace:string;package:string}|null=null;
 createEffect(()=>{
  const rows=records(),k=selected(),visible=visibleRecords(),current=rows.find(r=>r.key===k);
  if(current)selectedIdentity={workspace:current.workspace,package:current.package};
  if(!visible.some(r=>r.key===k)){
   const next=k&&selectedIdentity?visible.find(r=>!r.recent_completion&&r.is_current_assignment===true&&r.workspace===selectedIdentity!.workspace&&r.package===selectedIdentity!.package):undefined;
   setSelected(next?.key??visible[0]?.key??null);
  }
  if(!visibleAssignments().some(a=>a.key===selectedAgent()))setSelectedAgent(visibleAssignments()[0]?.key??null);
  if(!visibleEpics().some(e=>e.key===selectedEpic()))setSelectedEpic(visibleEpics()[0]?.key??null);
 });
 onMount(()=>{void refresh();const poll=setInterval(()=>{void refresh();if(mode()==='workspaces'&&live())void loadCatalog();},5000);const clock=setInterval(tickClock,1000);onCleanup(()=>{clearInterval(poll);clearInterval(clock);stateGeneration++;catalogGeneration++;workspaceGeneration++;});});
 return <>
  <header class="flex items-center gap-3 border-b"><span class="brand" aria-hidden="true">◉</span><div><h1>Spec sentinel</h1><p class="small muted">Workspace observation</p></div><div class="top-actions flex items-center gap-3"><span id="connection-status" class={`pill ${freshObservers().length&&!error()&&!imported()?'good':'muted'}`} role="status">{connectionLabel()}</span><button id="refresh-button" aria-busy={fetching()} onClick={()=>{void refresh(true);if(mode()==='workspaces')void loadCatalog();}}>Refresh state</button><button id="import-button" onClick={()=>importInput.click()}>Import snapshot</button><input ref={importInput} id="import-file" type="file" accept=".json,application/json" hidden onChange={e=>void importSnapshot(e.currentTarget.files?.[0])}/></div></header>
  <Show when={notes().length}><div id="notice" class="notice" role="status"><For each={notes()}>{note=><p innerHTML={statusMarkdown(note)}/>}</For></div></Show>
  <div class="shell" id="shell"><aside aria-label="Workspaces and packages"><div class="sidebar-head"><div class="flex justify-between items-center" style={{'margin-bottom':'18px'}}><h3 id="sidebar-heading">{mode()==='packages'?'Workspaces & packages':mode()==='workspaces'?'Workspaces':mode()==='agents'?'Agents':'Epics'}</h3><span id="run-count" class="small muted">{count()} {mode()==='workspaces'?'workspaces':mode()==='agents'?'agents':mode()==='epics'?'epics':'packages'}</span></div><label for="repo-search">Find {mode()==='workspaces'?'workspace':mode()==='agents'?'agent':mode()==='epics'?'epic':'workspace or package'}</label><input id="repo-search" type="search" placeholder="Search names, paths, activity…" value={query()} onInput={e=>setQuery(e.currentTarget.value)}/><Show when={mode()==='packages'}><div class="filters" aria-label="Package filters"><For each={['active','attention','completed'] as Filter[]}>{f=><button data-filter={f} aria-pressed={filter()===f} onClick={()=>{setFilter(f);setSelected(null);setOpenFile(null);}}>{f==='completed'?'Recently completed':f==='active'?'Active':'Attention'} <span class="pill muted">{records().filter(r=>f==='completed'?r.recent_completion:f==='active'?activeRun(r):attention(r)).length}</span></button>}</For></div></Show><div class="filters" aria-label="View mode" style={{'grid-template-columns':'repeat(4,minmax(0,1fr))'}}><For each={['packages','workspaces','agents','epics'] as Mode[]}>{m=><button data-mode={m} aria-pressed={mode()===m} onClick={()=>chooseMode(m)}>{m[0].toUpperCase()+m.slice(1)}</button>}</For></div><p id="filter-note" class="small muted" role="status">{mode()==='packages'&&filter()==='completed'?'Last 7 days · newest first':mode()==='workspaces'?catalogError():''}</p></div>
   <div id="run-list" class="run-list scroll"><Switch>
    <Match when={mode()==='packages'}><Show when={payload()} fallback={<Empty title="Loading observer snapshots…"/>}><PackageList records={records()} filter={filter()} query={query()} selected={selected()} onSelect={chooseRecord}/></Show></Match>
    <Match when={mode()==='agents'}><Show when={payload()} fallback={<Empty title="Loading observer snapshots…"/>}><AgentList assignments={assignments()} query={query()} selected={selectedAgent()} onSelect={setSelectedAgent}/></Show></Match>
    <Match when={mode()==='epics'}><Show when={payload()} fallback={<Empty title="Loading observer snapshots…"/>}><Show when={!epicSupport()} fallback={<Empty title={epicSupport()??'Epic data unavailable'}/> }><EpicList epics={epics()} query={query()} selected={selectedEpic()} onSelect={setSelectedEpic}/></Show></Show></Match>
    <Match when={mode()==='workspaces'}>
     <Show when={catalog()?.storage?.status&&catalog()?.storage?.status!=='ok'||storageDiagnostics().length}><div class="empty warn" role="status"><h3>{catalog()?.storage?.status!=='ok'?'Workspace storage unavailable':'Workspace catalog incomplete'}</h3><p class="small">Configured root: <span class="mono">{catalog()?.storage?.root}</span></p><p class="small">Storage status: {catalog()?.storage?.status}</p><For each={storageDiagnostics()}>{e=><p class="small">{str(e.message)}<Show when={e.path}><br/>{str(e.path)}</Show></p>}</For><button onClick={()=>void loadCatalog()}>Retry</button></div></Show>
     <Show when={catalogError()}><div class="empty" role="alert"><h3>Workspaces unavailable</h3><p>{catalogError()}</p><button onClick={()=>void loadCatalog()}>Retry</button></div></Show>
     <For each={workspaceRows()} fallback={<div class="empty"><h3>{!live()?'Workspaces require a live dashboard':!catalog()?'Loading workspaces…':query()?'No matching workspaces':'No workspaces'}</h3></div>}>{w=><button class="run-row" data-workspace={w.id} aria-pressed={workspaceId()===w.id} onClick={()=>chooseWorkspace(w.id)}><div class="flex justify-between gap-3"><span class="run-title">{w.name||w.id}</span><span class="pill muted">Workspace</span></div><p class="summary mono">{w.directory}</p><For each={w.attention??[]}>{a=><p class="small warn">{str(a)}</p>}</For></button>}</For>
     <For each={catalog()?.invalid??[]}>{w=><div class="info-row"><p><strong>Invalid workspace</strong></p><small class="mono">{w.directory}</small><For each={w.errors??[]}>{e=><small class="warn">{str(e)}</small>}</For></div>}</For>
    </Match>
   </Switch></div><div id="observer-summary" class="sidebar-foot">{observers().length} observer · {freshObservers().length} fresh heartbeat · {imported()?'Imported file':'Refreshes every 5 seconds'}<Show when={observers().some(o=>o.snapshot?.coverage?.state&&o.snapshot.coverage.state!=='complete')}> · Workspace {observers().find(o=>o.snapshot?.coverage?.state&&o.snapshot.coverage.state!=='complete')?.snapshot?.coverage?.state}</Show></div></aside>
   <main id="run-detail" aria-label="Selected detail"><div id="observation-detail"><Switch>
    <Match when={mode()==='packages'}><Show when={record()} fallback={<Empty title="Select an observed package" text="Choose a package to inspect its current obligation, activity, coverage and source paths."/>}><PackageDetail record={record()} records={records()} live={live()&&!error()} previewToken={token()} completionToken={completionToken()} completionLocalOnly={payload()?.completion==='local-only'} onComplete={askCompletion} onOpenFile={setOpenFile} onSelect={chooseRecord}/><Show when={record()?.package} keyed>{owner=><Files source="package" owner={owner} live={live()} initialFile={openFile()} recentCompletion={record()?.recent_completion}/>}</Show></Show></Match>
    <Match when={mode()==='agents'}><Show when={agent()} fallback={<Empty title="Select an observed agent" text="Choose an assignment to inspect its execution, lifecycle and declared evidence."/>}><AgentDetail assignment={agent()} records={records()} token={token()} live={live()} refresh={refresh} onEnded={id=>setEndedSessions(prev=>prev.includes(id)?prev:[...prev,id])}/></Show></Match>
    <Match when={mode()==='epics'}><Show when={epic()} fallback={<Empty title="Select an epic" text="Choose an epic to see its members and their derived status."/>}><EpicDetail epic={epic()} onSelectPackage={(workspace,name)=>{const r=records().find(r=>r.workspace===workspace&&base(r.package)===name);if(r){setMode('packages');chooseRecord(r.key);}}}/></Show></Match>
    <Match when={mode()==='workspaces'}><Show when={workspaceId()} keyed fallback={<Empty title={catalog()?.storage?.status&&catalog()?.storage?.status!=='ok'?'Workspace storage unavailable':'Select a workspace'} text="Choose a workspace to browse repositories, designs, files and discussions."/>}>{id=><WorkspaceDetail id={id} data={workspace()} error={workspaceError()} retry={()=>void loadWorkspace(id)} token={token()} live={live()} refreshKey={refreshKey()}/>}</Show></Match>
   </Switch></div></main>
  </div>
  <dialog ref={dialog} id="completion-dialog" aria-labelledby="completion-title" onCancel={e=>{if(completionBusy())e.preventDefault();}}><form onSubmit={e=>{e.preventDefault();void complete();}}><h2 id="completion-title">Mark package complete?</h2><p class="mono">{base(completion()?.package)}</p><p>This saves a completion record and moves the package to Recently completed. Running workers continue; step evidence and PR status stay as recorded. Only a new dispatch makes the package current again.</p><Show when={completionError()}><p class="warn" role="alert">{completionError()}</p></Show><div class="flex justify-end gap-3"><button type="button" disabled={completionBusy()} onClick={()=>dialog.close()}>Cancel</button><button type="submit" disabled={completionBusy()}>{completionBusy()?'Saving…':'Mark complete'}</button></div></form></dialog>
 </>;
}
function Empty(props:{title:string;text?:string}){return <div class="empty"><h2>{props.title}</h2><Show when={props.text}><p>{props.text}</p></Show></div>;}
function WorkspaceDetail(props:{id:string;data:WireRecord|undefined;error:string;retry:()=>void;token?:string;live:boolean;refreshKey:number}){
 const [file,setFile]=createSignal<string|null>(null);
 const material=(name:string,path:string)=><section class="section"><div class="section-head"><h3>{name}</h3><span class="small muted">{props.data?.[path]?.length??0} files</span></div><For each={props.data?.[path]??[]} fallback={<p class="small muted">No {name.toLowerCase()} recorded.</p>}>{item=><p><button onClick={()=>setFile(path+'/'+(typeof item==='string'?item:item.name))}>{typeof item==='string'?item:item.name}</button></p>}</For></section>;
 return <article class="detail"><Show when={props.error}><div class="empty warn" role="alert"><h3>Workspace unavailable</h3><p>{props.error}</p><button onClick={props.retry}>Retry workspace</button></div></Show><Show when={props.data} fallback={<Empty title="Loading workspace…"/>}>
  <div class="eyebrow">{props.id} / Workspace</div><div class="detail-title"><div><h2>{props.data?.name||props.id}</h2><p class="subtitle mono">{props.id} · {props.data?.directory}</p></div><span class="pill muted">Workspace</span></div><For each={props.data?.attention??[]}>{a=><p class="warn">{str(a)}</p>}</For>
  <section class="section"><div class="section-head"><h3>Repositories</h3><span class="small muted">{props.data?.repositories?.length??0} recorded</span></div><For each={props.data?.repositories??[]} fallback={<p class="small muted">No repositories recorded.</p>}>{repo=><div class="info-row"><p><strong>{repo.id}</strong> · {repo.status}</p><small class="mono">{repo.path}</small><Show when={repo.remote}><small class="mono">{repo.remote}</small></Show><Show when={repo.role}><small>Role {repo.role}</small></Show><For each={repo.attention??[]}>{a=><small class="warn">{str(a)}</small>}</For></div>}</For></section>
  <section class="section"><div class="section-head"><h3>Context</h3><span class="small muted">{props.data?.context?.length??0} recorded</span></div><For each={props.data?.context??[]} fallback={<p class="small muted">No context entries recorded.</p>}>{item=><div class="info-row"><p>{typeof item==='string'?item:item.label||item.path}</p><Show when={typeof item==='object'}><small class="mono">{item.path} · {item.status}</small></Show></div>}</For></section>
  {material('Briefs','briefs')}{material('Notes','notes')}
  <section class="section"><div class="section-head"><h3>Artifacts</h3><span class="small muted">{props.data?.artifacts?.length??0} records</span></div><For each={props.data?.artifacts??[]} fallback={<p class="small muted">No artifacts recorded.</p>}>{item=><div class="info-row"><p><strong>{item.title||'Artifact'}</strong> · {item.kind||'unknown'} · {item.status||'unknown'}</p><small class="mono">{item.kind==='url'?str(typeof item.target==='string'?item.target:item.target?.url):[item.target?.repository_id,item.target?.path].filter(Boolean).join(' · ')}</small><Show when={item.note}><small>{item.note}</small></Show><Show when={item.reason}><small class="warn">{item.reason}</small></Show><Show when={item.path}><small class="mono">{item.path}</small></Show></div>}</For></section>
  <Designs workspaceId={props.id} live={props.live}/>
  <section class="section"><h3>Kit</h3><p class="small muted mono">{props.data?.kit?.id} · {props.data?.kit?.name}</p></section>
  <Threads workspaceId={props.id} repositories={props.data?.repositories??[]} token={props.token} live={props.live} refreshKey={props.refreshKey}/>
  <Files source="workspace" owner={props.id} live={props.live} initialFile={file()}/>
 </Show></article>;
}
