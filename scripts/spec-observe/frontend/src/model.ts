import {normalize,authoritativeObservers as observers} from './model-helpers.js';
import {str,stale,key} from './format';
export type WireRecord=Record<string,any>;
export interface Observer extends WireRecord {observer_id:string;state:string;published_at:string;snapshot?:{workspace?:string;runs:WireRecord[];recently_completed?:WireRecord[];assignments?:WireRecord[];epics?:WireRecord[];coverage?:WireRecord;assignment_coverage?:WireRecord;completion_history?:WireRecord;attention?:WireRecord[]};}
export interface Envelope {schema_version?:number;generated_at?:string;observers:Observer[];errors?:WireRecord[];truncated?:boolean;action_token?:string;thread_action_token?:string;completion?:string;}
export const normalizeEnvelope=(value:unknown):Envelope=>normalize(value);
export const authoritativeObservers=(list:Observer[]):Observer[]=>observers(list);
export function collectRecords(payload:Envelope|null):WireRecord[]{
  const map=new Map<string,WireRecord>();
  for(const o of authoritativeObservers(payload?.observers??[])){
    if(!o.snapshot)continue;
    const rank=(o.state==='observing'&&!stale(o.published_at)?1e15:0)+(Date.parse(o.snapshot.coverage?.observed_at)||0);
    for(const r of [...o.snapshot.runs.map(r=>({...r,recent_completion:false})),...(o.snapshot.recently_completed??[]).map(r=>({...r,recent_completion:true}))] as WireRecord[]){
      const k=r.recent_completion?JSON.stringify([r.workspace,r.package,'recent-completion']):key(r);
      if(!map.has(k)||map.get(k)!.rank<rank)map.set(k,{...r,observer:o,rank,key:k});
    }
  }
  return [...map.values()].sort((a,b)=>str(a.workspace).localeCompare(str(b.workspace))||str(a.package).localeCompare(str(b.package))||Number(b.is_current_assignment===true)-Number(a.is_current_assignment===true)||(Date.parse(b.timing?.started_at)||0)-(Date.parse(a.timing?.started_at)||0));
}
export function collectAssignments(payload:Envelope|null):WireRecord[]{
 const map=new Map<string,WireRecord>();
 for(const o of authoritativeObservers(payload?.observers??[])){
  if(!o.snapshot)continue;const workspace=o.snapshot.workspace||o.observer_id||o.source||'unknown';const rank=(o.state==='observing'&&!stale(o.published_at)?1e15:0)+(Date.parse(o.snapshot.coverage?.observed_at)||0);
  for(const a of o.snapshot.assignments??[]){if(typeof a.assignment_id!=='string'||!a.assignment_id)continue;const k=JSON.stringify([workspace,a.assignment_id]);if(!map.has(k)||map.get(k)!.rank<rank)map.set(k,{...a,observer:o,workspace,key:k,rank,assignment_coverage:o.snapshot.assignment_coverage??null});}
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
