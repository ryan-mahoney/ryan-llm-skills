import {Show,createSignal,onCleanup} from 'solid-js';
import {postJson} from './api';
import {busyAgentsHref} from './route';

type Props={assignment:any;live:boolean;token?:string};
type Attempt={id:string;digest?:string};
export default function RelaunchAssignment(props:Props){
  const [busy,setBusy]=createSignal(false);
  const [error,setError]=createSignal('');
  const [launched,setLaunched]=createSignal('');
  let disposed=false;
  onCleanup(()=>{disposed=true;});
  const running=()=>['live','live-unrecorded'].includes(props.assignment.display);
  const key=()=>`sentinel-relaunch:${props.assignment.assignment_id}`;
  function attempt():Attempt{
    try{const value=JSON.parse(sessionStorage.getItem(key())||'null');if(value?.id)return value;}catch{}
    const value={id:crypto.randomUUID()};
    sessionStorage.setItem(key(),JSON.stringify(value));
    return value;
  }
  async function relaunch(){
    if(busy()||!props.live||!props.token)return;
    setBusy(true);setError('');
    try{
      const retry=attempt();
      const input={assignment_id:props.assignment.assignment_id,retry_id:retry.id};
      if(!retry.digest){
        const preview=await postJson<{contractDigest:string}>('/api/assignment-session/relaunch-preview',input,props.token);
        retry.digest=preview.contractDigest;
        sessionStorage.setItem(key(),JSON.stringify(retry));
      }
      const result=await postJson<{assignment:{assignment_id:string;state:string}}>('/api/assignment-session/relaunch',{...input,expectedDigest:retry.digest},props.token);
      if(disposed)return;
      if(result.assignment.state==='live')setLaunched(result.assignment.assignment_id);
      else setError('The attempt was recorded, but startup is not confirmed. Check the agent before trying again.');
    }catch(cause){if(!disposed)setError(cause instanceof Error?cause.message:'Relaunch could not be confirmed. Retry to check the same attempt.');}
    finally{if(!disposed)setBusy(false);}
  }
  return <section class="section" aria-label="Relaunch spec">
    <h3>Run spec again</h3>
    <p>Run the spec-end-to-end prompt again. The agent checks the spec’s progress and continues unfinished work with the same target and agent settings.</p>
    <p class="small muted">Starts a new conversation. Saved work and earlier conversations are kept.</p>
    <Show when={!launched()} fallback={<p role="status">Agent started. <a href={busyAgentsHref(props.assignment.workspace||props.assignment.workspace_id,launched(),[])}>View agent</a></p>}>
      <button class="ds-btn ds-btn--primary" type="button" disabled={busy()||running()||!props.live||!props.token} aria-busy={busy()} onClick={()=>void relaunch()}>{busy()?'Starting agent…':'Relaunch agent'}</button>
      <Show when={running()}><p class="small muted">The agent is still running. Open its terminal to continue.</p></Show>
      <Show when={!props.live||!props.token}><p class="small muted">Open the authorized live dashboard to relaunch this spec.</p></Show>
    </Show>
    <Show when={error()}><p role="alert">{error()}</p><a href={busyAgentsHref(props.assignment.workspace||props.assignment.workspace_id,'',[])}>Check agents</a></Show>
  </section>;
}
