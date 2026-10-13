// Linux tmux servers belong to their own user service, never to the launcher.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {connect} from 'node:net';
import {readFile} from 'node:fs/promises';
import {processIdentity} from '../spec-observe/process-identity.mjs';

export function terminalUnit(socketPath) {
  return `adjacent-tmux-${createHash('sha256').update(socketPath).digest('hex').slice(0,24)}.service`;
}
export function command(file,args) {
  return new Promise(resolve=>execFile(file,args,{encoding:'utf8',timeout:10000,maxBuffer:1024*1024},(error,stdout,stderr)=>resolve({ok:!error,stdout:stdout??'',stderr:stderr??'',code:error?.code,message:error?.message})));
}
const pause=()=>new Promise(resolve=>setTimeout(resolve,25));
export async function ensureTerminalHost(socketPath,{run=command,identity=processIdentity,read=readFile}={}) {
  const unit=terminalUnit(socketPath);
  const probe=()=>run('tmux',['-N','-S',socketPath,'display-message','-p','#{pid}']);
  let server=await probe();
  if(!server.ok){
    const sockets=await read('/proc/net/unix','utf8');
    if(sockets.split('\n').some(line=>line.match(/^(?:\S+\s+){7}(.*)$/)?.[1]===socketPath)) throw new Error('Terminal socket is still bound but unreachable; refusing to replace its server.');
    const started=await run('systemd-run',['--user',`--unit=${unit}`,'--collect','--property=Type=exec','--setenv=PATH',...['PI_SUBAGENTS_TEMP_ROOT','TMPDIR'].filter(key=>process.env[key]).map(key=>`--setenv=${key}`),'tmux','-D','-S',socketPath]);
    // Concurrent starters may race on the same unit. Only a verified server
    // is success, including when systemd reports that the unit already exists.
    const deadline=Date.now()+2000;
    for(;;){
      server=await probe();
      if(server.ok)break;
      if(Date.now()>=deadline)throw new Error(`Independent terminal service could not start: ${started.stderr||server.stderr}. Check the user systemd service ${unit}.`);
      await pause();
    }
  }
  const pid=Number(server.stdout.trim());
  const saved=Number.isSafeInteger(pid)&&pid>0?identity(pid):null;
  if(!saved)throw new Error('Terminal server identity is unavailable.');
  const cgroup=await read(`/proc/${pid}/cgroup`,'utf8');
  if(!cgroup.trim().split('\n').some(line=>line.endsWith(`/${unit}`))){
    throw new Error('The existing terminal server is not independently managed. Let its sessions finish before migrating the terminal service; restarting Sentinel may interrupt them.');
  }
  return {...saved,unit};
}

// An unreachable pathname is not absence. The Linux kernel keeps a bound
// Unix socket in this inventory even after its filesystem name is removed.
// Combine a refused connection, no bound socket, and a dead saved server
// identity (when available). Callers still require the saved agent to be dead.
export async function terminalSocketAbsent(record,{platform=process.platform,read=readFile,inspect}={}) {
  if(platform!=='linux')return false;
  try{
    if(record.tmux_server_identity){
      const saved=record.tmux_server_identity;
      const current=inspect(saved.pid);
      if(current.state!=='dead'&&!(current.state==='alive'&&current.started_at!==saved.started_at))return false;
    }
    const refused=await new Promise(resolve=>{
      const socket=connect(record.tmux_socket);
      socket.setTimeout(1000,()=>{socket.destroy();resolve(false);});
      socket.once('connect',()=>{socket.destroy();resolve(false);});
      socket.once('error',error=>resolve(['ENOENT','ECONNREFUSED'].includes(error.code)));
    });
    if(!refused)return false;
    const listing=await read('/proc/net/unix','utf8');
    if(!listing.startsWith('Num'))return false;
    return !listing.split('\n').some(line=>line.match(/^(?:\S+\s+){7}(.*)$/)?.[1]===record.tmux_socket);
  }catch{return false;}
}
