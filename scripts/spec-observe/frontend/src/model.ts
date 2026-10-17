import {normalize,authoritativeObservers as observers} from './model-helpers.js';
import {str,stale,key,activeRun,attention,packageFilterMatches} from './format';
import {aggregatePackage} from './execution-state';
import {blockingAssignment,implementationAssignment} from './readiness';
export type WireRecord=Record<string,any>;
export interface Observer extends WireRecord {observer_id:string;state:string;published_at:string;snapshot?:{workspace?:string;runs:WireRecord[];recently_completed?:WireRecord[];planned_packages?:WireRecord[];package_executions?:WireRecord[];assignments?:WireRecord[];epics?:WireRecord[];coverage?:WireRecord;assignment_coverage?:WireRecord;completion_history?:WireRecord;attention?:WireRecord[]};}
export interface Envelope {schema_version?:number;generated_at?:string;observers:Observer[];errors?:WireRecord[];truncated?:boolean;action_token?:string;thread_action_token?:string;completion?:string;}
export const normalizeEnvelope=(value:unknown):Envelope=>normalize(value);
export const authoritativeObservers=(list:Observer[]):Observer[]=>observers(list);
export function collectRecords(payload:Envelope|null):WireRecord[]{
  const map=new Map<string,WireRecord>();
  const knownDone=(r:WireRecord)=>r.workflow_state==='complete'||Boolean(r.completion_basis)||Number.isFinite(Date.parse(r.completed_at||''));
  for(const o of authoritativeObservers(payload?.observers??[])){
    if(!o.snapshot)continue;
    const rank=(o.state==='observing'&&!stale(o.published_at)?1e15:0)+(Date.parse(o.snapshot.coverage?.observed_at)||0);
    const workspace=o.snapshot.workspace||o.observer_id||o.source||'unknown';
    const packageExecutions=(Array.isArray(o.snapshot.package_executions)?o.snapshot.package_executions:[]).filter((entry:unknown):entry is WireRecord=>Boolean(entry)&&typeof entry==='object'&&!Array.isArray(entry)&&typeof (entry as WireRecord).package==='string');
    const packageIdentity=(r:WireRecord)=>JSON.stringify([r.workspace||workspace,r.package]);
    const rows=[...o.snapshot.runs.map(r=>({...r,workspace:r.workspace||workspace,recent_completion:false})),...(o.snapshot.recently_completed??[]).map(r=>({...r,workspace:r.workspace||workspace,recent_completion:true}))] as WireRecord[];
    const excludedPackages=new Set(rows.filter(r=>r.recent_completion||activeRun(r)||attention(r)||knownDone(r)).map(packageIdentity));
    const planned=new Map<string,WireRecord>();
    const addPlanned=(r:WireRecord)=>{
      const normalized:WireRecord={...r,workspace:r.workspace||workspace,planned:true,recent_completion:false};
      const identity=packageIdentity(normalized);
      if(!normalized.package||excludedPackages.has(identity))return;
      const k=JSON.stringify([normalized.workspace,normalized.package,'planned-package',null]);
      const prior=planned.get(k);
      const candidateRank=rank+(Date.parse(normalized.timing?.started_at)||Date.parse(normalized.observed_at)||0);
      if(!prior||prior.rank<candidateRank)planned.set(k,{...prior,...normalized,targets:normalized.targets??prior?.targets,source_paths:normalized.source_paths??prior?.source_paths,epic:normalized.epic??prior?.epic,rank:candidateRank,key:k,observer:o});
    };
    if(Array.isArray(o.snapshot.planned_packages))for(const r of o.snapshot.planned_packages)addPlanned(r);
    const executions=packageExecutions.filter(r=>(r.visibility ? r.visibility==='active' : !['planned','complete'].includes(r.execution_summary?.phase))).map(r=>({...r,workspace:r.workspace||workspace,execution_record:true,recent_completion:false,key:JSON.stringify([r.workspace||workspace,r.package,'execution-source'])}));
    for(const r of [...rows,...planned.values(),...executions] as WireRecord[]){
      const k=r.recent_completion?JSON.stringify([r.workspace,r.package,'recent-completion']):r.planned||r.execution_record?r.key:key(r);
      if(r.planned){if(!map.has(k)||map.get(k)!.rank<r.rank)map.set(k,r);continue;}
      if(!map.has(k)||map.get(k)!.rank<rank)map.set(k,{...r,package_visibility:packageExecutions.find(e=>e.package===r.package&&(!e.workspace||e.workspace===r.workspace))?.visibility,observer:o,rank,key:k});
    }
  }
  const records=projectStartingRecords([...map.values()],payload);
  const excludedPackages=new Set(records.filter(r=>r.recent_completion||activeRun(r)||attention(r)||knownDone(r)).map(r=>JSON.stringify([r.workspace,r.package])));
  return records.filter(r=>!r.planned||!excludedPackages.has(JSON.stringify([r.workspace,r.package])))
    .sort((a,b)=>str(a.workspace).localeCompare(str(b.workspace))||str(a.package).localeCompare(str(b.package))||Number(b.is_current_assignment===true)-Number(a.is_current_assignment===true)||(Date.parse(b.timing?.started_at)||0)-(Date.parse(a.timing?.started_at)||0));
}
// A live implementation assignment for a receipt-free planned package is
// projected as a pending starting record: the stable planned key and source
// facts stay, the planned badge is dropped, and a real run row for the same
// package always wins instead of producing a duplicate row.
function projectStartingRecords(records:WireRecord[],payload:Envelope|null):WireRecord[]{
  const assignments=new Map<string,WireRecord>();
  for(const o of authoritativeObservers(payload?.observers??[])){
    if(!o.snapshot)continue;
    const workspace=o.snapshot.workspace||o.observer_id||o.source||'unknown';
    const rank=(o.state==='observing'&&!stale(o.published_at)?1e15:0)+(Date.parse(o.snapshot.coverage?.observed_at)||0);
    for(const a of o.snapshot.assignments??[]){
      if(!implementationAssignment(a)||!blockingAssignment(a))continue;
      const assignmentWorkspace=a.workspace||a.workspace_id||workspace;
      if(typeof a.spec_package!=='string'||!a.spec_package)continue;
      const identity=JSON.stringify([assignmentWorkspace,a.spec_package]);
      const prior=assignments.get(identity);
      if(prior&&prior.rank>=rank)continue;
      assignments.set(identity,{...a,workspace:assignmentWorkspace,rank});
    }
  }
  if(!assignments.size)return records;
  const claimed=new Set<string>();
  // A cancelled run row is history when its receipt belongs to a superseded
  // assignment: the sentinel marks the newest receipt as the current assignment
  // even after cancellation, so that flag alone must not suppress the
  // assignment-backed starting projection for the new blocking owner. A
  // cancellation carrying the new owning assignment's identity stays
  // authoritative, as do active obligations, pending workflow, recent
  // completions and every non-cancelled run.
  const cancelledHistory=(r:WireRecord):boolean=>{
    if(r.recent_completion===true||activeRun(r))return false;
    if(r.workflow_state==='complete'||Boolean(r.completion_basis)||Number.isFinite(Date.parse(r.completed_at||'')))return false;
    if(r.execution!=='cancelled')return false;
    // Same canonical identity rule as the projection itself: a row may carry
    // the canonical path as `package` or `package_ref`.
    const owner=[r.package,r.package_ref].filter((value:unknown):value is string=>typeof value==='string'&&Boolean(value))
      .map(value=>assignments.get(JSON.stringify([r.workspace,value]))).find(Boolean);
    if(!owner)return true;
    const ownerId=owner.assignment_id;
    const identities=[r.assignment_id,...(Array.isArray(r.receipts)?r.receipts.map((receipt:WireRecord)=>receipt?.assignment_id):[])]
      .filter((value:unknown):value is string=>typeof value==='string'&&Boolean(value));
    return !identities.includes(ownerId);
  };
  const withRuns=new Set(records.filter(r=>!r.planned&&!cancelledHistory(r)).map(r=>JSON.stringify([r.workspace,r.package])));
  return records.map(record=>{
    if(!record.planned)return record;
    const identity=JSON.stringify([record.workspace,record.package]);
    if(claimed.has(identity)||withRuns.has(identity))return record;
    const receiptFree=!Array.isArray(record.receipts)||record.receipts.every((receipt:WireRecord)=>receipt?.state==='cancelled');
    if(!receiptFree)return record;
    const candidate=[record.package,record.package_ref].find((value:unknown):value is string=>typeof value==='string'&&Boolean(value));
    const assignment=candidate?assignments.get(JSON.stringify([record.workspace,candidate])):undefined;
    if(!assignment)return record;
    claimed.add(identity);
    return {...record,planned:undefined,implementation_starting:true,assignment_id:assignment.assignment_id,assignment,is_current_assignment:true};
  });
}
// Specs are packages; assignment records remain available for detail/history.
export function packageSummaries(records:WireRecord[],filter:Parameters<typeof packageFilterMatches>[1]='all'):WireRecord[]{
  const packages=new Map<string,WireRecord[]>();
  const priority=(r:WireRecord)=>r.recent_completion?7:r.execution_record?6:activeRun(r)?5:r.is_current_assignment===true?3:r.planned?2:1;
  const updated=(r:WireRecord)=>Date.parse(r.timing?.started_at||r.completed_at||r.planned_at||r.observed_at||'')||0;
  for(const record of records){
    const identity=JSON.stringify([record.workspace,record.package]);
    packages.set(identity,[...(packages.get(identity)??[]),record]);
  }
  return [...packages.values()].map(rows=>{
    // Completion and prepared partitions retain their established identities.
    const eligible=filter==='completed'?rows.filter(r=>r.recent_completion):filter==='ready'||filter==='planned'?rows.filter(r=>r.planned):rows;
    const sorted=eligible.slice().sort((a,b)=>priority(b)-priority(a)||updated(b)-updated(a));
    return sorted.length?aggregatePackage(rows,sorted[0]):null;
  }).filter((record):record is WireRecord=>Boolean(record)&&packageFilterMatches(record,filter));
}
export function collectAssignments(payload:Envelope|null):WireRecord[]{
 const map=new Map<string,WireRecord>();
 for(const o of authoritativeObservers(payload?.observers??[])){
  if(!o.snapshot)continue;const workspace=o.snapshot.workspace||o.observer_id||o.source||'unknown';const rank=(o.state==='observing'&&!stale(o.published_at)?1e15:0)+(Date.parse(o.snapshot.coverage?.observed_at)||0);
  for(const a of o.snapshot.assignments??[]){if(typeof a.assignment_id!=='string'||!a.assignment_id)continue;
   // The assignment record's own workspace identity wins: the observer
   // snapshot's workspace is a collector hash and must not replace it.
   const assignmentWorkspace=typeof a.workspace_id==='string'&&a.workspace_id?a.workspace_id:typeof a.workspace==='string'&&a.workspace?a.workspace:workspace;
   const k=JSON.stringify([assignmentWorkspace,a.assignment_id]);if(!map.has(k)||map.get(k)!.rank<rank)map.set(k,{...a,observer:o,workspace:assignmentWorkspace,key:k,rank,assignment_coverage:o.snapshot.assignment_coverage??null});}
 }
 const ended=(a:WireRecord)=>['ended','launch-failed'].includes(a.display);
 return [...map.values()].sort((a,b)=>Number(ended(a))-Number(ended(b))||str(a.spec_package).localeCompare(str(b.spec_package))||a.assignment_id.localeCompare(b.assignment_id));
}
export function collectEpics(payload:Envelope|null):WireRecord[]{
 const map=new Map<string,WireRecord>();
 for(const o of authoritativeObservers(payload?.observers??[])){
  if(!o.snapshot)continue;const rank=(o.state==='observing'&&!stale(o.published_at)?1e15:0)+(Date.parse(o.snapshot.coverage?.observed_at)||0);
  for(const e of o.snapshot.epics??[]){const k=JSON.stringify([e.workspace,e.epic]);if(!map.has(k)||map.get(k)!.rank<rank)map.set(k,{...e,observer:o,rank,key:k});}
 }
 return [...map.values()].sort((a,b)=>str(a.workspace).localeCompare(str(b.workspace))||str(a.title).localeCompare(str(b.title)));
}
