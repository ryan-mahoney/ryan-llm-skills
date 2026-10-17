// Read-only launch guard for the runtime's process-group leases and
// pi-subagents lifecycle artifacts. Never reconciles or rewrites worker state.
import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,readlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {TERMINAL_WAVE_STATES,projectWaveRecord} from '../spec-observe/core.mjs';
import {inspectProcess} from '../spec-observe/process-identity.mjs';
import {createSystemdServiceAdapter} from '../../pi/extensions/spec-runtime/linux-resources.mjs';
// Bounds inspection cost while staying fail-closed. A long spec run kept about 2,400
// runtime/runs entries (logs, receipts, sessions), so 2,048 refused a legitimate relaunch.
const LIMIT=16384;
const WAVE_FILE=/^[A-Za-z0-9_-]{1,128}\.json$/;
const refuse=(message,reason='worker-unknown',detail=null)=>Object.assign(new Error(message),{code:'run-active',reason,detail});
export const subagentRoot=()=>join(process.env.PI_SUBAGENTS_TEMP_ROOT?.trim()
  ?resolve(process.env.PI_SUBAGENTS_TEMP_ROOT):join(tmpdir(),`pi-subagents-uid-${process.getuid()}`),'async-subagent-runs');
async function entries(path){
  let list;
  try{list=await readdir(path,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw refuse('Worker records could not be inspected.','record-invalid');}
  if(list.length>LIMIT)throw refuse('Worker record inspection exceeded its limit; ownership is unconfirmed.','record-invalid');
  if(list.some(item=>item.isSymbolicLink()))throw refuse('Worker records contain a symbolic link; ownership is unconfirmed.','record-invalid');
  return list;
}
async function json(path,optional=false){
  try{
    const info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw new Error('invalid worker artifact');
    return JSON.parse(await readFile(path,'utf8'));
  }catch(error){if(optional&&error.code==='ENOENT')return null;throw refuse('Worker state could not be read safely.','record-invalid',error instanceof SyntaxError?'invalid-json':'unreadable');}
}
function assertGone(pid,label,group=false){
  if(!Number.isSafeInteger(pid)||pid<=1)throw refuse(`${label} has no reliable process identity.`,'worker-unknown');
  try{process.kill(group?-pid:pid,0);}catch(error){if(error.code==='ESRCH')return;throw refuse(`${label} process status is unavailable.`,'worker-unknown');}
  throw refuse(`${label} is still running. Wait for it to finish before relaunching.`,'worker-live');
}
function observedTree(writer){
  return writer?.kind==='pi-writer'&&typeof writer.processInstanceId==='string'
    &&writer.processTree?.state==='observed'&&writer.processTree.mechanism==='posix-process-group'
    &&Number.isSafeInteger(writer.processTree.processGroupId)&&writer.processTree.processGroupId>1;
}
function workerLabel(run){
  const wave=run?.command_phase?.wave_id??run?.wave_bindings?.wave_id;
  const step=run?.command_phase?.subject?.step??run?.command_phase?.step??run?.command_phase?.step_number??run?.step??run?.wave_bindings?.step_number;
  const parts=[];
  if(typeof wave==='string'&&wave!=='')parts.push(`wave ${wave}`);
  if(Number.isSafeInteger(step)&&step>0)parts.push(`step ${step}`);
  return parts.length?` (${parts.join(', ')})`:'';
}
async function assertServicesDrained(run,getAdapter){
  if(run?.phase_drain?.status==='confirmed')return;
  const label=workerLabel(run);
  for(const service of [run?.service,run?.command_service]){
    if(!service)continue;
    let observed;
    try{observed=await getAdapter().inspect(service,{ownershipVerified:false});}
    catch{throw refuse(`A worker unit${label} identity could not be established; run systemctl --user status ${service.unit} and spec_dispatch recover.`,'worker-unknown','identity-unestablished');}
    if(observed.status==='confirmed')continue;
    const unit=observed.unit??service.unit;
    if(observed.status==='populated')throw refuse(`A worker unit${label} is still running (${unit}); run systemctl --user status ${unit} and spec_dispatch recover.`,'worker-live',unit);
    throw refuse(`A worker unit${label} has unknown status (${unit}); run systemctl --user status ${unit} and spec_dispatch recover.`,'worker-unknown',observed.reason);
  }
}
export async function assertNoAssignmentWorkers(record){
  if(!record.spec_package)return;
  const waveDir=join(record.spec_package,'runtime','waves');
  try{
    const waveDirInfo=await lstat(waveDir);
    if(waveDirInfo.isSymbolicLink()||!waveDirInfo.isDirectory())
      throw refuse('Wave records could not be inspected safely; ownership is unconfirmed.','record-invalid');
  }catch(error){
    if(error.code!=='ENOENT')throw refuse('Wave records could not be inspected safely; ownership is unconfirmed.','record-invalid');
  }
  for(const entry of await entries(waveDir)){
    if(!WAVE_FILE.test(entry.name))continue;
    const wavePath=join(waveDir,entry.name);
    let value;
    try{
      value=await json(wavePath);
    }catch(error){
      if(error.reason!=='record-invalid')throw error;
      throw refuse(`Wave record ${entry.name} could not be read safely; run spec_dispatch recover.`,'record-invalid',error.detail);
    }
    const projected=projectWaveRecord(value,wavePath);
    if(!projected.ok)throw refuse(`Wave record ${entry.name} is invalid (${projected.reason}); run spec_dispatch recover.`,'record-invalid',projected.reason);
    const wave=projected.wave;
    if(TERMINAL_WAVE_STATES.includes(wave.state))continue;
    const identity=wave.coordinator?.process_identity;
    if(!Number.isSafeInteger(identity?.pid)||typeof identity?.started_at!=='string'||identity.started_at==='')
      throw refuse(`Wave ${wave.wave_id} has no confirmed coordinator identity; run spec_dispatch recover.`,'coordinator-unknown');
    let observed=null;
    try{observed=inspectProcess(identity.pid);}catch{}
    if(observed?.state==='dead')continue;
    if(observed?.state==='alive'&&observed.started_at===identity.started_at)
      throw refuse(`Wave ${wave.wave_id} already has a live coordinator; run spec_dispatch recover.`,'coordinator-live');
    throw refuse(`Wave ${wave.wave_id} coordinator status is unknown; run spec_dispatch recover.`,'coordinator-unknown');
  }
  const current=await json(join(record.spec_package,'runtime','run.json'),true);
  const parents=new Set([current?.parent_session].filter(value=>typeof value==='string'));
  const runs=join(record.spec_package,'runtime','runs');
  let serviceAdapter=null;
  const getAdapter=()=>serviceAdapter??=createSystemdServiceAdapter();
  for(const entry of await entries(runs)){
    if(entry.isFile()&&entry.name.endsWith('.json')) {
      const run=await json(join(runs,entry.name));
      if(typeof run.parent_session==='string')parents.add(run.parent_session);
      if(entry.name.endsWith('-phase-drain.json')&&run.status==='confirmed')continue;
      await assertServicesDrained(run,getAdapter);
    }
    if(!entry.isDirectory()||!entry.name.endsWith('-processes'))continue;
    for(const file of await entries(join(runs,entry.name))){
      if(!file.name.endsWith('.json'))continue;
      const lease=await json(join(runs,entry.name,file.name));
      if(lease.active!==false)assertGone(lease.pid,'A spec worker',true);
    }
  }
  if(record.pi_session_dir){
    for(const entry of await entries(record.pi_session_dir)){
      if(entry.isFile()&&entry.name.endsWith('.jsonl'))parents.add(join(record.pi_session_dir,entry.name));
    }
  }
  const root=record.subagent_async_root??subagentRoot();
  // The active index is small regardless of retained history. Terminal indexes
  // are keyed by exact parent session, so unrelated old artifacts cannot block
  // this package. Read their existing schema without invoking mutating repair.
  const ids=new Set();
  for(const marker of await entries(join(root,'.active-runs'))){
    if(marker.isFile()&&/^[a-zA-Z0-9_-]+$/.test(marker.name))ids.add(marker.name);
  }
  for(const parent of parents){
    const keys=[`~sha256-${createHash('sha256').update(parent).digest('hex')}`];
    const encoded=encodeURIComponent(parent);
    if(Buffer.byteLength(encoded)<=255)keys.push(encoded);
    for(const key of keys){
      for(const marker of await entries(join(root,'.terminal-runs',key))){
        if(!marker.isFile()||!marker.name.endsWith('.json'))continue;
        const index=await json(join(root,'.terminal-runs',key,marker.name));
        if(index.sessionId!==parent||typeof index.runId!=='string'||!/^[a-zA-Z0-9_-]+$/.test(index.runId))throw refuse('A worker index has inconsistent ownership.','record-invalid');
        ids.add(index.runId);
      }
    }
  }
  if(ids.size>LIMIT)throw refuse('This package has too many worker records to inspect safely.','record-invalid');
  for(const id of ids){
    const dir=join(root,id);
    const status=await json(join(dir,'status.json'),true);
    if(!status)continue;
    const parent=typeof status.sessionId==='string'?status.sessionId:'';
    if(!(record.pi_session_dir&&parent.startsWith(record.pi_session_dir+sep))&&!parents.has(parent))continue;
    const proof=await json(join(dir,'process-terminal.json'),true);
    const instance=status.processTerminal?.runnerProcessInstanceId;
    if(proof?.state==='observed'&&proof.version===1&&proof.runId===status.runId
      &&proof.runnerProcessInstanceId===instance&&Array.isArray(proof.instances)
      &&proof.instances.some(item=>item.kind==='runner'&&item.processInstanceId===instance)
      &&proof.instances.filter(item=>item.kind!=='runner').every(observedTree))continue;
    if(process.platform==='linux'){
      const namespace=await readlink('/proc/self/ns/pid').catch(()=>null);
      if(!namespace||status.pidNamespaceScope!==namespace)throw refuse('A worker belongs to an unconfirmed PID namespace.');
    }
    assertGone(status.pid,'A background worker');
    assertGone(status.pid,'A background runner process group',true);
    const candidate=await json(join(dir,'process-terminal-candidate.json'),true);
    if(!candidate||candidate.version!==1||candidate.runId!==status.runId
      ||!instance||candidate.runnerProcessInstanceId!==instance||!candidate.writers||!candidate.expectedWriters
      ||typeof candidate.writers!=='object'||typeof candidate.expectedWriters!=='object')throw refuse('A stopped worker has incomplete child-process evidence.');
    const indexes=new Set([...Object.keys(candidate.writers),...Object.keys(candidate.expectedWriters)]);
    if(!indexes.size)throw refuse('A stopped worker has incomplete child-process evidence.');
    for(const index of indexes){
      const writers=candidate.writers[index],expected=candidate.expectedWriters[index];
      if(!Array.isArray(writers)||!Number.isSafeInteger(expected)||expected<0
        ||new Set(writers.map(item=>item.processInstanceId)).size!==expected)throw refuse('A stopped worker has incomplete child-process evidence.');
      for(const writer of writers){
        if(!observedTree(writer))throw refuse('A worker process group has not been confirmed stopped.');
        assertGone(writer.processTree.processGroupId,'A background worker process group',true);
      }
    }
  }
}
