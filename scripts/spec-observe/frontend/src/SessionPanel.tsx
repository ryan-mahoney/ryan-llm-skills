import {Show, createSignal, onCleanup, onMount} from 'solid-js';
import {getJson,postJson} from './api';
import {copyText} from './clipboard';

type Session={assignment_id:string;identity:string;can_end:boolean;state:string;reason:string;attach_command:string|null;local_command:string|null};
export default function SessionPanel(props:{assignment:any;token?:string;live:boolean;refresh:()=>Promise<void>;onEnded:(id:string)=>void}) {
  const [session,setSession]=createSignal<Session>();
  const [error,setError]=createSignal('');
  const [busy,setBusy]=createSignal(false);
  const [copied,setCopied]=createSignal('');
  const [review,setReview]=createSignal<Session>();
  const [ended,setEnded]=createSignal(false);
  let dialog!:HTMLDialogElement,command!:HTMLTextAreaElement;
  let disposed=false,loading=false;
  async function load(){
    if(!props.live||loading||disposed)return;
    loading=true;
    try{const next=await getJson<Session>(`/api/assignment-session?${new URLSearchParams({assignment_id:props.assignment.assignment_id})}`);if(!disposed){setSession(next);setError('');if(next.state==='ended')setEnded(true);}}
    catch(e){if(!disposed){setError(e instanceof Error?e.message:'Session could not be checked.');setSession(undefined);}}
    finally{loading=false;}
  }
  async function copy(){
    const text=session()?.attach_command;if(!text)return;
    const result=await copyText(text,command);
    setCopied(result==='copied'?'Attach command copied. Paste it into your terminal.':'Select and copy the command, then paste it into your terminal.');
  }
  function ask(){const s=session();if(!s?.can_end||busy())return;setReview({...s});setError('');dialog.showModal();}
  async function end(){
    const s=review();if(!s||busy()||!props.token)return;
    setBusy(true);setError('');
    try{
      await postJson('/api/assignment-session/end',{assignment_id:s.assignment_id,expected_identity:s.identity,confirm:true},props.token);
      if(disposed)return;
      setEnded(true);props.onEnded(s.assignment_id);setSession({...s,state:'ended',can_end:false,attach_command:null,local_command:null,reason:'Session ended. Saved files and transcript remain available.'});dialog.close();setReview(undefined);await props.refresh();
    }catch(e){if(!disposed)setError(e instanceof Error?e.message:'Session could not be ended. Refresh and retry.');}
    finally{if(!disposed)setBusy(false);}
  }
  onMount(()=>{void load();const timer=setInterval(()=>{if(!review()&&!ended())void load();},5000);onCleanup(()=>{disposed=true;clearInterval(timer);});});
  return <section class="section session-controls" aria-labelledby="session-heading">
    <div class="section-head"><h3 id="session-heading">Terminal session</h3><span class="pill muted">{ended()?'Ended':props.assignment.task_activity?.state==='idle'?'Idle · response finished':'Session controls'}</span></div>
    <Show when={props.live} fallback={<p>Open the live host dashboard to attach to or end a session.</p>}>
      <Show when={session()} fallback={<p>{error()||'Checking terminal identity…'}</p>}>
        <p role="status">{session()?.reason}</p>
        <Show when={session()?.attach_command&&!ended()}>
          <label class="small" for="session-attach-command">Run this command in your computer’s terminal</label>
          <textarea id="session-attach-command" class="mono" rows="4" readonly value={session()?.attach_command??''} ref={command} style={{width:'100%','overflow-wrap':'anywhere'}} />
          <button type="button" onClick={()=>void copy()}>Copy attach command</button>
          <p class="small" role="status">{copied()}</p>
          <details><summary>Already on the host?</summary><pre style={{'white-space':'pre-wrap','overflow-wrap':'anywhere'}}>{session()?.local_command}</pre></details>
          <p class="small">To detach and leave the session open, press <kbd>Ctrl+B</kbd>, release both keys, then press <kbd>D</kbd>.</p>
        </Show>
        <Show when={session()?.can_end&&!ended()}>
          <button type="button" class="danger" disabled={!props.token||busy()} onClick={ask}>End session…</button>
          <p class="small muted">Ends this terminal and its agent, including any work still in progress. Saved files and the transcript are kept.</p>
        </Show>
      </Show>
      <Show when={error()&&!review()}><p class="warn" role="alert">{error()}</p></Show>
      <button type="button" disabled={busy()} onClick={()=>void load()}>Refresh session</button>
    </Show>
    <dialog ref={dialog} aria-labelledby="end-session-heading" onCancel={e=>{if(busy())e.preventDefault();else setReview(undefined);}}>
      <form onSubmit={e=>{e.preventDefault();void end();}}>
        <h2 id="end-session-heading">End this session?</h2>
        <p>This closes the terminal and stops its agent. Any work still running will be interrupted. Saved files and the transcript will remain.</p>
        <p class="mono" style={{'overflow-wrap':'anywhere'}}>{review()?.assignment_id}</p>
        <p>You cannot reattach after ending it. To leave it running, choose Cancel and detach with Ctrl+B, then D.</p>
        <Show when={error()}><p class="warn" role="alert">{error()}</p></Show>
        <div class="thread-actions"><button type="button" disabled={busy()} onClick={()=>{dialog.close();setReview(undefined);}}>Cancel</button><button type="submit" class="danger" disabled={busy()}>{busy()?'Ending session…':'End session'}</button></div>
      </form>
    </dialog>
  </section>;
}
