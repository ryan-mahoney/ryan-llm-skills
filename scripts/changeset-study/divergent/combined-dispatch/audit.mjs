import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditCell } from '../writer-control/audit.mjs';
import { hash, read, rows, same } from '../writer-control/support.mjs';
import { readLedger } from './guard.mjs';
const writer='deepseek/deepseek-flash:off';
const tokenKeys=['input','output','cacheRead','cacheWrite','totalTokens'];
const total=(items,fn)=>items.reduce((n,item)=>n+(fn(item)??0),0);
const finite=n=>Number.isFinite(n)&&n>=0;
const load=async(root,path)=>import(pathToFileURL(join(root,'scripts',path)).href);

/** Read-only retained-evidence audit. No model construction, inference or ledger mutation. */
export async function auditTrial({directory,expectedJob,frozenRoot,ledger,expectedPlan}) {
  const validation=[],check=(ok,name)=>validation.push({check:name,ok:Boolean(ok)});
  let result={},requests=[],receipts=[],responses=[],job={},candidate=null,state={entries:[]};
  const get=(name,optional=false)=>{try{return read(join(directory,name));}catch{if(!optional)check(false,'retained '+name);return null;}};
  const bytes=name=>{try{return readFileSync(join(directory,name));}catch{check(false,'retained '+name);return null;}};
  result=get('result.json')??{};job=get('job.json')??{};candidate=get('candidate.json');
  try{requests=rows(join(directory,'requests.jsonl'));receipts=rows(join(directory,'receipts.jsonl'));responses=rows(join(directory,'responses.jsonl'));}catch{check(false,'parseable request/response/receipt streams');}
  try{state=readLedger(ledger).state;}catch{check(false,'canonical schema1 ledger');}
  const combined=expectedJob.dispatchProfile==='optimized-v4a',source=expectedJob.task.files,raw=expectedJob.preparedPlan;
  check(same(job,expectedJob)&&job.ledger===ledger,'exact frozen job/source/brief/plan/limits');
  check(expectedJob.editorSelector===writer&&expectedJob.writerRecoverySelector===null&&expectedJob.strategy==='owner-query-writer'&&
    expectedJob.queryMode==='catalog-lookup'&&expectedJob.queryGranularity==='smaller-regions'&&
    (combined?expectedJob.optimization==='contextual':expectedJob.dispatchProfile==null&&expectedJob.optimization==='none'),'authorized comparison treatment');
  check(result.task===expectedJob.task.id&&result.task_hash===hash(JSON.stringify(expectedJob.task))&&result.editor_selector===writer&&
    result.selector===expectedJob.selector&&result.strategy===expectedJob.strategy&&result.writer_recovery_selector==null&&
    result.optimization===expectedJob.optimization&&(result.dispatch_profile??null)===(expectedJob.dispatchProfile??null),'result task and role identity');
  check(Object.entries(expectedJob.task.limits).every(([key,value])=>same(result.limits?.[key],value)),'unchanged task limits');
  check(same(get('raw-plan.json'),raw)&&bytes('implementation-brief.md')?.toString('utf8')===expectedJob.preparedBrief&&
    result.implementation_brief_hash===hash(expectedJob.preparedBrief),'exact raw plan and settled brief bytes');
  check((result.reviews??[]).length===0&&result.repairs===0&&result.review_accepted===null&&result.review_mode==='executable-checks-only','no outer model review or repair');
  check(requests.every(r=>r.selector===writer&&r.stage==='editor')&&receipts.every(r=>r.selector===writer&&r.stage==='editor'),'DS editor only; no owner/query/Sol/feedback request');
  const ids=new Set(requests.map(r=>r.reservation)),byReceipt=new Map(receipts.map(r=>[r.reservation,r])),byResponse=new Map(responses.map(r=>[r.reservation,r]));
  check(requests.every(r=>typeof r.reservation==='string'&&r.reservation)&&ids.size===requests.length&&receipts.length===requests.length&&byReceipt.size===receipts.length&&
    receipts.every(r=>ids.has(r.reservation))&&responses.length===requests.length&&byResponse.size===responses.length&&responses.every(r=>ids.has(r.reservation)&&r.stage==='editor'),'bijective request/receipt/response reservations');
  for(const request of requests) {
    const receipt=byReceipt.get(request.reservation),response=byResponse.get(request.reservation),entry=state.entries.find(e=>e.id===request.reservation);
    check(receipt&&response&&receipt.operation_id===request.operation_id&&receipt.writer_attempt===request.writer_attempt&&
      [0,1].includes(request.writer_attempt)&&receipt.stop_reason===(response.response?.stopReason??'exception')&&
      same(receipt.usage??null,response.response?.usage??null)&&(receipt.error??null)===(response.error??response.response?.errorMessage??null),'writer response/receipt route and outcome join');
    check(entry?.selector===writer&&entry.status==='priced'&&finite(entry.charged_usd)&&same(entry.usage,receipt?.usage)&&
      entry.charged_usd===receipt?.usage?.cost?.total,'writer canonical charge and usage join');
  }
  const writerTokens=Object.fromEntries(tokenKeys.map(key=>[key,total(receipts,r=>r.usage?.[key])])),writerUsd=total(receipts,r=>r.usage?.cost?.total);
  check(receipts.every(r=>tokenKeys.every(k=>finite(r.usage?.[k]))),'complete writer usage');
  check(result.model_calls===requests.length&&tokenKeys.every(k=>result.tokens?.[k]===writerTokens[k]),'recorded writer calls/tokens');
  let routing=null,routeIds=[],jevCalls=0,jevCountExact=true,jevUsd=0,jevUsage=null;
  if(combined) {
    routing=get('routing.json');const rr=get('routing/receipt.json'),rq=get('routing/request.json'),ra=get('routing/answer.json');
    check(routing&&same(result.routing,routing)&&same(rr,routing),'retained Jev result/receipt identity');
    if(routing) {
      check(routing.plan_hash===hash(JSON.stringify(raw))&&routing.source_hash===hash(JSON.stringify(source))&&
        routing.config?.backend==='typesafe'&&routing.config?.model==='jev-latest'&&routing.config?.maxRequests===1&&
        routing.config_hash===hash(JSON.stringify(routing.config))&&same(rq?.config,routing.config)&&rq?.config_hash===routing.config_hash&&
        rq?.plan_hash===routing.plan_hash&&rq?.source_hash===routing.source_hash&&same(rq?.library_identity,routing.library_identity)&&
        same(ra?.answer??null,routing.answer??null)&&routing.actual_model===(routing.answer?.model??null),'Jev plan/source/config/request/answer identity');
      if(routing.reservation) {
        routeIds=[routing.reservation];const entry=state.entries.find(e=>e.id===routing.reservation);
        check(rq?.reservation===routing.reservation&&entry?.selector==='typesafe/jev-latest'&&entry.status==='priced'&&finite(entry.charged_usd)&&
          finite(routing.estimated_usd)&&entry.charged_usd===routing.estimated_usd,'Jev canonical estimated charge join');
        jevUsd=routing.estimated_usd??0;
        if(routing.usage)check(same(entry?.usage?.inputTokens,routing.usage.inputTokens)&&same(entry?.usage?.outputTokens,routing.usage.outputTokens),'Jev normalized usage join');
      } else check(routing.attempted===false,'unreserved Jev cannot claim a request');
      jevCountExact=Number.isInteger(routing.requests_started)&&routing.requests_started>=0||!routing.attempted;
      jevCalls=routing.requests_started??(routing.attempted?1:0);jevUsage=routing.usage??null;
      check(jevCalls<=1&&jevCountExact,'bounded known Jev request count');
      if(routing.usage)check(finite(routing.price_usd_per_million_input)&&finite(routing.usage.inputTokens)&&finite(routing.usage.outputTokens)&&
        routing.estimated_usd===routing.usage.inputTokens*routing.price_usd_per_million_input/1e6,'Jev input-only cost basis');
      try {
        const outer=read(join(dirname(frozenRoot),'manifest.json')),entry=join(dirname(frozenRoot),outer.jev_entry),pkgBytes=readFileSync(join(dirname(entry),'..','package.json')),pkg=JSON.parse(pkgBytes);
        check(same(routing.library_identity,{kind:'module',name:pkg.name,version:pkg.version,entry_sha256:hash(readFileSync(entry)),package_sha256:hash(pkgBytes)}),'actual Jev library equals frozen dependency');
      }catch{check(false,'actual Jev library equals frozen dependency');}
    }
  }else check(!result.routing?.attempted,'baseline has no routing request');
  const allIds=new Set([...requests,...receipts,...responses].map(r=>r.reservation).filter(id=>typeof id==='string').concat(routeIds));
  const entries=state.entries.filter(e=>allIds.has(e.id));
  check(entries.length===allIds.size&&entries.every(e=>e.status==='priced'&&finite(e.charged_usd)),'all observed reservations retain known canonical cost');
  try {
    const registry=read(join(dirname(frozenRoot),'reservations.json'));
    check([...allIds].every(id=>registry.filter(r=>r.id===id).length===1&&same(registry.find(r=>r.id===id),
      (({id,selector,reserved_usd})=>({id,selector,reserved_usd}))(state.entries.find(e=>e.id===id)))),'observed IDs join campaign reservation registry');
  }catch{check(false,'observed IDs join campaign reservation registry');}
  check(requests.length+jevCalls<=expectedJob.task.limits.model_calls,'shared writer plus Jev call ceiling');
  if(combined)check(result.calls_including_routing===requests.length+jevCalls&&result.routing_call_count_exact===jevCountExact,'recorded total routing-inclusive calls');
  let dispatched=null,application=false,replayed=false;
  try {
    const [{compile},{optimizePlan,mergeCandidates},{v4aEditor},{parseJson},{ModelJsonParseError},{parse}]=await Promise.all([
      load(frozenRoot,'changeset/engine.mjs'),load(frozenRoot,'changeset-study/optimizer.mjs'),load(frozenRoot,'changeset-study/v4a-editor.mjs'),
      load(frozenRoot,'changeset/models.mjs'),load(frozenRoot,'changeset-study/client.mjs'),load(frozenRoot,'changeset-study/parser/acorn.mjs')]);
    let mergeChoices={},contextChoices={};
    if(combined&&routing?.answer?.ok&&!routing.fallback) {
      const choose=key=>routing.answer.answers?.[key]?.confidence>=.7?routing.answer.answers[key].choice:null;
      mergeCandidates(raw,source).slice(0,16).forEach((pair,i)=>{if(choose('merge_'+i)==='separate')mergeChoices[pair.key]='separate';});
      raw.operations.filter(op=>!raw.operations.some(other=>other.id!==op.id&&other.writes.some(p=>[...op.reads,...op.writes].includes(p)))&&
        [...new Set([...op.reads,...op.writes])].every(p=>source[p]==null||source[p].length<=8000)).slice(0,16)
        .forEach((op,i)=>{if(choose('context_'+i)==='whole')contextChoices[op.id]='whole-small-files';});
    }
    if(combined)check(same(mergeChoices,routing?.mergeChoices??{})&&same(contextChoices,routing?.contextChoices??{}),'routing choices reproduced from retained answer');
    const optimized=optimizePlan(raw,source,{mode:combined?'contextual':'none',mergeChoices,contextChoices});dispatched=optimized.plan;
    check(same(get('plan-0.json'),dispatched)&&(!expectedPlan||same(dispatched,expectedPlan)),'deterministic dispatched plan reproduced from raw source');
    if(combined){const preprocessing=get('preprocessing.json');check(same(preprocessing?.plan,dispatched)&&preprocessing?.input_hash===hash(JSON.stringify(raw))&&
      preprocessing?.output_hash===hash(JSON.stringify(dispatched))&&same(preprocessing?.routing,routing),'preprocessing artifact binds input/output/routing');}
    if(!combined) {
      const base=await auditCell({directory,expectedJob,expectedPlan:dispatched,taskHash:hash(JSON.stringify(expectedJob.task)),expectedWriterSelector:writer,frozenBackendRoot:frozenRoot});
      validation.push(...base.validation);application=base.application_complete;replayed=base.source_replay_performed;
    }else {
      const operations=compile(dispatched),records=result.executions?.[0]?.operations??[],staged={...source},outcomes=new Map();
      check(result.executions?.length===1&&result.executions[0].plan_sha256===hash(JSON.stringify(dispatched))&&records.length===operations.length&&
        new Set(records.map(r=>r.id)).size===records.length,'one frozen execution/status per operation');
      check(requests.every(r=>operations.some(op=>op.id===r.operation_id)),'every writer request has a dispatched owner');
      for(const operation of operations) {
        const attempts=requests.filter(r=>r.operation_id===operation.id),record=records.find(r=>r.id===operation.id);
        if(!operation.depends_on.every(id=>outcomes.get(id)?.passed)) {
          check(!attempts.length&&record?.status==='blocked'&&same(record.dependencies,operation.depends_on),'failed dependency blocks dispatch');outcomes.set(operation.id,{passed:false});continue;
        }
        const context=Object.fromEntries([...new Set([...operation.reads,...operation.writes])].map(p=>[p,staged[p]??null]));let consumed=0,outcome=null,error=null;
        for(const dependency of operation.depends_on){const parent=outcomes.get(dependency)?.reservation;
          check(parent&&requests.findIndex(r=>r.reservation===parent)<requests.indexOf(attempts[0])&&responses.findIndex(r=>r.reservation===parent)<responses.findIndex(r=>r.reservation===attempts[0]?.reservation),'dependency completes before dependent attempt');}
        const invoke=async(method,system,payload,stage,metadata)=>{
          const request=attempts[consumed];if(!request)throw new Error(record?.error??'No retained request');
          check(request.operation_id===metadata.operation_id&&request.writer_attempt===metadata.writer_attempt&&request.writer_attempt===consumed&&stage==='editor'&&
            request.context?.systemPrompt===system&&request.context?.messages?.length===1&&request.context.messages[0].role==='user'&&
            request.context.messages[0].content===(typeof payload==='string'?payload:JSON.stringify(payload)),'exact frozen writer input including original staged excerpts/local-only diagnostics');
          consumed++;fake.calls++;const origin=byResponse.get(request.reservation),message=origin?.response;
          if(!origin||origin.error)throw new Error(origin?.error??'Missing retained response');
          if(message?.stopReason!=='stop')throw new Error(`Model stopped: ${message?.stopReason}: ${message?.errorMessage??''}`);
          const text=message.content.filter(p=>p.type==='text').map(p=>p.text).join(method==='text'?'':'\n');
          if(method==='text')return text;
          try{return parseJson(text);}catch(error){throw error instanceof SyntaxError?new ModelJsonParseError(error,text):error;}
        };
        const fake={calls:0,text:(...args)=>invoke('text',...args),json:(...args)=>invoke('json',...args)};
        try{outcome=await v4aEditor(fake,'editor',{operation,files:context},{contextParse:parse});}catch(caught){error=caught;}
        check(consumed===attempts.length,'all retained attempts consumed exactly once by frozen editor');
        const value=outcome??error,retained=(result.writer_attempts??[]).filter(r=>r.operation_id===operation.id);
        const stable=a=>(a??[]).map(({elapsed_ms,...rest})=>rest);
        check(retained.length===1&&retained[0].writer_fallback===(value?.writer_fallback??false)&&same(stable(retained[0].attempts),stable(value?.writer_attempts)),'per-attempt failure/fallback/application accounting reproduced');
        const passed=Boolean(outcome);
        check(passed?record?.status==='passed'&&record.executor===operation.executor:record?.status==='failed'&&typeof record.error==='string','execution status matches successful final attempt or retained failure');
        if(passed){for(const[p,text]of Object.entries(outcome.files)){check(record.output_hashes?.[p]===(text===null?null:hash(text)),'successful output hash');if(text===null)delete staged[p];else staged[p]=text;}}
        outcomes.set(operation.id,{passed,reservation:passed?attempts.at(-1)?.reservation:null});
      }
      check(same(staged,candidate),'retained responses reproduce exact complete candidate');replayed=true;
      application=operations.every(op=>outcomes.get(op.id)?.passed)&&result.executions?.[0]?.ok===true;
    }
  }catch(error){check(false,'frozen source replay: '+error.message.slice(0,300));}
  const writable=new Set((dispatched?.operations??raw.operations).flatMap(op=>op.writes));
  const protectedIntact=candidate&&expectedJob.task.protected.every(p=>candidate[p]===source[p]);
  const pathIntact=candidate&&Object.entries(candidate).every(([p,text])=>typeof text==='string'&&(Object.hasOwn(source,p)||writable.has(p)))&&
    [...new Set([...Object.keys(source),...Object.keys(candidate)])].every(p=>writable.has(p)||source[p]===candidate[p]);
  check(protectedIntact&&pathIntact&&candidate&&hash(bytes('candidate.json')??'')===result.candidate_hash,'candidate paths/protected source/hash');
  const visible=result.checks?.at(-1)?.visible,tests=visible?.candidate_tests??[],hidden=result.hidden;
  const delivered=application&&result.accepted===true&&result.hidden_pass===true&&hidden?.ok===true&&hidden?.completed===true&&visible?.ok===true&&tests.every(t=>t.ok===true)&&!result.error&&!result.grading_error;
  const stages=result.stages??[],seconds=name=>total(stages.filter(s=>s.name===name),s=>s.elapsed_ms)/1000;
  const preprocessing=combined?get('preprocessing.json',true):null,execution=seconds('execution'),optimization=seconds('optimization'),jev=seconds('context-routing');
  const integrity=validation.every(c=>c.ok),exposure=total(entries,e=>e.charged_usd??e.reserved_usd),known=total(entries,e=>e.charged_usd);
  return {integrity_valid:integrity,validation,application_complete:application,source_replay_performed:replayed,audited_delivered:integrity&&delivered,
    writer_calls:requests.length,jev_requests_started:jevCalls,jev_call_count_exact:jevCountExact,calls:requests.length+jevCalls,
    writer_catalog_usd:writerUsd,writer_tokens:writerTokens,jev_estimated_usd:jevUsd,jev_usage:jevUsage,
    accounting_complete:entries.length===allIds.size&&entries.every(e=>e.status==='priced'&&finite(e.charged_usd)),
    mixed_estimated_total_usd:entries.length===allIds.size&&entries.every(e=>e.status==='priced'&&finite(e.charged_usd))?writerUsd+jevUsd:null,known_charged_usd:known,retained_budget_exposure_usd:exposure,unknown_reservations:entries.filter(e=>e.charged_usd==null).length,
    retries:requests.filter(r=>r.writer_attempt===1).length,fallbacks:(result.writer_attempts??[]).filter(r=>r.writer_fallback).length,
    execution_seconds:execution,optimization_seconds:optimization,jev_seconds:jev,preprocessing_seconds:finite(preprocessing?.elapsed_ms)?preprocessing.elapsed_ms/1000:null,
    writing_seconds:execution+(combined?(preprocessing?.elapsed_ms??0)/1000:optimization),provider_latency_seconds:total(receipts,r=>r.elapsed_ms)/1000,
    visible_seconds:seconds('visible-check'),hidden_seconds:seconds('terminal-grading'),process_elapsed_seconds:finite(result.process_elapsed_ms)?result.process_elapsed_ms/1000:null,
    downstream:{visible_base_ok:visible?.base_ok??visible?.ok??null,visible_ok:visible?.ok??null,candidate_checks:tests.map(t=>({path:t.path,ok:t.ok,timedOut:t.timedOut??false})),
      hidden_ok:hidden?.ok??null,hidden_completed:hidden?.completed??null,hidden_timed_out:hidden?.timedOut??null,hidden_signal:hidden?.signal??null,protected_intact:Boolean(protectedIntact),paths_intact:Boolean(pathIntact)},
    failures:[...validation.filter(c=>!c.ok).map(c=>c.check),...((result.executions?.[0]?.operations)??[]).filter(r=>r.status!=='passed').map(r=>`${r.id}: ${r.status}: ${r.error??''}`),...(result.error?[result.error]:[])]};
}
