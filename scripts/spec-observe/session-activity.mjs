// A completed response is distinct from a live terminal and from accepted work.
import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
const MAX_TAIL=256*1024;
const unknown=reason=>({state:'unknown',reason});
export function parseSessionActivity(text,{partialStart=false}={}) {
  if(!text.endsWith('\n'))return unknown('Session output is still being written.');
  const lines=text.split('\n');if(partialStart)lines.shift();
  let last=null;
  for(const line of lines){
    if(!line.trim())continue;
    let entry;try{entry=JSON.parse(line);}catch{return unknown('Session output could not be read completely.');}
    if(entry.type==='message')last=entry;
    else if(!['session','session_info','model_change','thinking_level_change','custom'].includes(entry.type))last=null;
  }
  const m=last?.message;
  if(!m)return unknown('No recent response state was recorded.');
  if(m.role==='user'||m.role==='toolResult'||(m.role==='assistant'&&m.stopReason==='toolUse'))return {state:'working',reason:'A request or tool operation is in progress.'};
  if(m.role!=='assistant')return unknown('Response state is unavailable.');
  if(['error','aborted','length'].includes(m.stopReason))return {state:'interrupted',reason:'The last response stopped before normal completion.'};
  const blocks=Array.isArray(m.content)?m.content:[];
  const reply=blocks.filter(b=>b.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n').trim();
  if(m.stopReason!=='stop'||blocks.some(b=>b.type==='toolCall')||!reply||!Number.isFinite(Date.parse(last.timestamp)))return unknown('No normal final response was recorded.');
  return {state:'idle',reason:'The last response finished. The session is waiting for input.',finished_at:last.timestamp,last_reply:reply.slice(0,6000)};
}
export async function readSessionActivity(file,{budget,deadline}={}) {
  let handle;
  try{
    if(await realpath(file)!==file)return null;
    handle=await open(file,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
    const before=await handle.stat();if(!before.isFile())return null;
    if(deadline!=null&&performance.now()>=deadline)return null;
    const wanted=Math.min(before.size,MAX_TAIL,budget?.maxFileBytes??MAX_TAIL,Math.max(0,budget?budget.maxTotalBytes-budget.bytes:MAX_TAIL));
    if(wanted===0)return {ok:true,size:before.size,mtime:before.mtimeMs,session_file:file,task_activity:unknown('No session output fits the observation budget.')};
    // Reserve the read before awaiting it so a deadline cannot allow late I/O
    // to exceed the collector's shared byte budget.
    if(budget)budget.bytes+=wanted;
    const start=before.size-wanted,buffer=Buffer.alloc(wanted);
    const {bytesRead}=await handle.read(buffer,0,buffer.length,start);
    const after=await handle.stat();
    const stable=bytesRead===buffer.length&&before.size===after.size&&before.mtimeMs===after.mtimeMs;
    return {ok:true,size:after.size,mtime:after.mtimeMs,session_file:file,
      task_activity:stable?parseSessionActivity(buffer.toString('utf8',0,bytesRead),{partialStart:start>0}):unknown('Session output changed during observation.')};
  }catch{return null;}finally{await handle?.close();}
}
