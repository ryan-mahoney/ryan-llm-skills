// Explicit operator actions. All paths and terminal identities come from the
// unique durable assignment, never from browser-supplied terminal arguments.
import {createAssignmentRelaunch} from './relaunch.mjs';
import {createHash} from 'node:crypto';
import {hostname,userInfo} from 'node:os';
import {join} from 'node:path';
import {acquireRootClaim,findAssignment} from './assignments.mjs';
import {probeSession,endSession} from './tmux.mjs';
import {sameProcess,inspectProcess} from '../spec-observe/process-identity.mjs';
import {writeFileAtomic} from './store.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const quote=value=>/^[a-zA-Z0-9_./:@=-]+$/.test(value)?value:`'${value.replace(/'/g,"'\\''")}'`;
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
const identity=r=>createHash('sha256').update(JSON.stringify([r.assignment_id,r.launch_token,r.tmux_socket,r.tmux_session,r.pane_id,r.pi_identity])).digest('hex');
export async function verifyTerminal(record, transport){
  const pane=await probeSession(record, transport);
  const exact=pane.status==='present'&&pane.pid===record.pi_identity?.pid&&pane.pane_id===record.pane_id&&sameProcess(record.pi_identity);
  const ended=['ended','launch_failed'].includes(record.state);
  return {pane,exact,ended,identity:identity(record)};
}
export function createSessionControl({storageRoot,publicHost,transport}={}) {
  async function record(id){if(typeof id!=='string'||!uuid.test(id))throw fail('Invalid assignment ID.',400);return findAssignment(storageRoot,id);}
  async function describe(id){
    const r=await record(id);
    const {exact,ended,identity:terminalIdentity}=await verifyTerminal(r,transport);
    const canEnd=exact&&!ended;
    const local=['tmux','-S',r.tmux_socket,'attach-session','-t',`=${r.tmux_session}`].map(quote).join(' ');
    const remote=['ssh','-t',`${userInfo().username}@${publicHost||hostname()}`,local].map(quote).join(' ');
    return {assignment_id:r.assignment_id,workspace_id:r.workspace_id,identity:terminalIdentity,can_end:canEnd,
      state:ended&&!exact?'ended':exact?'open':'unknown',local_command:exact?local:null,attach_command:exact?remote:null,
      reason:ended&&!exact?'Session has ended. Saved files and transcript remain available.':exact?'Terminal session is open.':'Terminal identity could not be verified. Refresh before taking action.'};
  }
  async function end(input){
    if(input?.confirm!==true||typeof input?.expected_identity!=='string')throw fail('Confirm which session to end.',400);
    const claim=await acquireRootClaim(storageRoot);
    try{
      const r=await record(input.assignment_id);
      if(input.expected_identity!==identity(r))throw fail('Session changed after confirmation. Refresh and review it again.');
      if(r.state==='ended'){
        const p=inspectProcess(r.pi_identity?.pid);
        if(p.state!=='dead'&&!(p.state==='alive'&&p.started_at!==r.pi_identity?.started_at))throw fail('Session state needs verification. Refresh before taking action.');
        return {assignment_id:r.assignment_id,state:'ended',duplicate:true};
      }
      if(r.state==='launch_failed')throw fail('This assignment is recorded as failed. Refresh to inspect its terminal state.');
      await endSession(r,transport);
      await writeFileAtomic(join(r.workspace_directory,'assignments',`${r.assignment_id}.json`),JSON.stringify({...r,state:'ended',updated_at:new Date().toISOString(),attention:[...new Set(['Session ended by operator.',...r.attention])]}));
      return {assignment_id:r.assignment_id,state:'ended'};
    }finally{claim.release();}
  }
  return {describe,end,...createAssignmentRelaunch({storageRoot})};
}
