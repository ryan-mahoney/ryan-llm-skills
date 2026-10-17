import {createSignal} from 'solid-js';
import * as helpers from './format-helpers.js';
export const str=(value:unknown):string=>helpers.str(value);
export const esc=(value:unknown):string=>helpers.esc(value);
export const base=(value:unknown):string=>helpers.base(value);
export const time=(value:unknown):string=>helpers.time(value);
export const inlineMarkdown=(value:unknown,links=true):string=>helpers.inlineMarkdown(value,links);
export const statusMarkdown=(value:unknown,resolver?:((path:string)=>string|null)):string=>helpers.renderMarkdown(value,resolver);
const [clock,setTime]=createSignal<number|null>(null);
let anchor:{at:number;perf:number}|null=null;
export function setClock(value:string|undefined){const at=Date.parse(value??'');anchor=Number.isFinite(at)?{at,perf:performance.now()}:null;tickClock();}
export function tickClock(){setTime(anchor?anchor.at+performance.now()-anchor.perf:null);}
export const serverNow=()=>clock();
export function age(value:unknown){const t=Date.parse(str(value)),n=clock();if(!Number.isFinite(t)||n===null)return 'Age unknown';const s=Math.max(0,Math.floor((n-t)/1000));return s<60?`${s}s ago`:s<3600?`${Math.floor(s/60)}m ago`:s<86400?`${Math.floor(s/3600)}h ago`:`${Math.floor(s/86400)}d ago`;}
export function stale(value:unknown,now:number|null=clock()){const t=Date.parse(str(value));return now===null||!Number.isFinite(t)||now-t>45000;}
export const terminal=new Set(['completed','complete','failed','cancelled','stale','stopped','closed','aborted','done']);
export {compareReadiness} from './readiness';
export const key=(r:any)=>JSON.stringify([r.workspace,r.package,r.assignment_id]);
export const pendingWorkflow=(r:any)=>r.is_current_assignment===true&&['ready','waiting-worker','waiting-external','decision-required','blocked','user-held'].includes(r.workflow_state);
export const activeRun=(r:any)=>r.package_aggregate?r.aggregate_active===true:!r.recent_completion&&!r.planned&&(r.is_current_assignment!==false&&(!terminal.has(r.execution)||pendingWorkflow(r)||r.is_current_assignment===true&&r.execution==='failed'&&r.workflow_state!=='complete'));
export const runningUnconfirmed=(r:any)=>r.execution==='running'&&(r.coverage?.reasons||[]).some((reason:string)=>/^coordinator-gone$|^checkout-unavailable:/.test(reason));
export const attention=(r:any)=>r.package_aggregate?r.aggregate_attention===true:activeRun(r)&&(['blocked','decision-required'].includes(r.workflow_state)||(r.conditions||[]).some((x:any)=>x.severity==='attention'&&x.state!=='resolved'&&(x.kind!=='action-outcome-unknown'||x.current===true))||(r.incidents||[]).some((x:any)=>x.state==='open'));
export type PackageFilter='all'|'active'|'attention'|'completed'|'planned'|'ready';
// `planned` is the history alias for the Ready partition: prepared inventory
// that is not already starting. Starting projections and planned rows never
// carry attention, so a pending implementation cannot double as a problem row.
export const packageFilterMatches=(r:any,filter:PackageFilter)=>filter==='all'?true:filter==='completed'?r?.recent_completion===true:filter==='planned'||filter==='ready'?r?.planned===true&&r?.implementation_starting!==true:filter==='attention'?!r?.planned&&!r?.implementation_starting&&attention(r):activeRun(r)||r?.implementation_starting===true;
export function duration(start:unknown,end:unknown){const a=Date.parse(str(start)),b=Date.parse(str(end));if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)return 'Unknown';const s=Math.floor((b-a)/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?`${d}d ${h}h ${m}m`:h?`${h}h ${m}m ${s%60}s`:m?`${m}m ${s%60}s`:`${s}s`;}
export function rows(items:any[],kind:string){return items?.length?`<div class="rows">${items.map(x=>`<div class="info-row"><p>${esc(x.kind||x.action||x.state||kind)}${x.state&&x.kind?' · '+esc(x.state):''}${x.count!=null?' · '+esc(x.count)+' failure(s)':''}</p><small>${inlineMarkdown(x.summary||x.reason||x.reason_code||x.message||x.note||x.hint||'')}${x.observed_at?' · '+esc(time(x.observed_at)):''}</small>${x.id?`<small class="mono">${esc(x.id)}</small>`:''}</div>`).join('')}</div>`:`<p class="small muted">No ${kind.toLowerCase()} recorded.</p>`;}
