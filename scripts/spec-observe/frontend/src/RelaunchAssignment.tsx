import {Show,createSignal,onCleanup} from 'solid-js';
import {postJson} from './api';
import {busyAgentsHref} from './route';

type Props={assignment:any;live:boolean;token?:string};
type Attempt={id:string;digest?:string;record?:{execution_dir:string;execution_branch?:string}};
export default function RelaunchAssignment(props:Props){
  const [busy,setBusy]=createSignal(false);
  const [error,setError]=createSignal('');
  const [launched,setLaunched]=createSignal('');
  const [review,setReview]=createSignal<{assignmentId:string;attempt:Attempt}|null>(null);
  const currentReview=()=>review()?.assignmentId===props.assignment.assignment_id?review()?.attempt:null;
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
      if(!currentReview()){
        if(!retry.digest||!retry.record){
          const preview=await postJson<{contractDigest:string;record:NonNullable<Attempt['record']>}>('/api/assignment-session/relaunch-preview',input,props.token);
          retry.digest=preview.contractDigest;
          retry.record=preview.record;
          sessionStorage.setItem(key(),JSON.stringify(retry));
        }
        if(!disposed)setReview({assignmentId:props.assignment.assignment_id,attempt:retry});
        return;
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
    <p>Run the spec-end-to-end prompt again. The agent checks the spec’s progress and continues unfinished work in its own worktree with the same repository and agent settings.</p>
    <p class="small muted">Starts a new conversation. Saved work and earlier conversations are kept.</p>
    <Show when={!launched()} fallback={<p role="status">Agent started. <a href={busyAgentsHref(props.assignment.workspace||props.assignment.workspace_id,launched(),[])}>View agent</a></p>}>
      <Show when={currentReview()}>{attempt=><dl class="thread-facts">
        <div><dt>Worktree</dt><dd class="mono">{attempt().record?.execution_dir}</dd></div>
        <Show when={attempt().record?.execution_branch}><div><dt>Branch</dt><dd class="mono">{attempt().record?.execution_branch}</dd></div></Show>
      </dl>}</Show>
      <button class="ds-btn ds-btn--primary" type="button" disabled={busy()||running()||!props.live||!props.token} aria-busy={busy()} onClick={()=>void relaunch()}>{busy()?(currentReview()?'Starting agent…':'Preparing preview…'):(currentReview()?'Start agent':'Preview relaunch')}</button>
      <Show when={running()}><p class="small muted">The agent is still running. Open its terminal to continue.</p></Show>
      <Show when={!props.live||!props.token}><p class="small muted">Open the authorized live dashboard to relaunch this spec.</p></Show>
    </Show>
    <Show when={error()}><p role="alert">{error()}</p><a href={busyAgentsHref(props.assignment.workspace||props.assignment.workspace_id,'',[])}>Check agents</a></Show>
  </section>;
}
