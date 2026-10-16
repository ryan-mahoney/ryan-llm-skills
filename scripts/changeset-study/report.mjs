#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { costPolicy } from '../changeset-research/cost.mjs';

const [input, output, supplementalInput] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: report RUN_DIRECTORY OUTPUT_PREFIX');
const run=resolve(input), manifest=JSON.parse(readFileSync(join(run,'manifest.json'),'utf8'));
const cells=readdirSync(run,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^\d+-/.test(e.name)).map(e=>{
  const result=JSON.parse(readFileSync(join(run,e.name,'result.json'),'utf8'));
  const {reviews,executions,hidden,...compact}=result;
  return {...compact,evidence_directory:e.name,hidden_pass:result.hidden_pass??hidden?.ok??false,
    workflow_completed:!result.error&&result.review_accepted===true&&result.visible_accepted===true&&reviews?.at(-1)?.implementation_error==null&&(result.arm==='agent'||executions?.at(-1)?.ok===true),
    hidden_error:hidden?.ok?null:hidden?.output??result.grading_error??null,
    reviewer_findings:reviews?.flatMap(r=>r.review.findings)??[],
    deterministic_operations:executions?.reduce((n,e)=>n+(e.metrics?.deterministic_operations??0),0)??0,
    peak_operation_concurrency:Math.max(0,...(executions??[]).map(e=>e.metrics?.peak_concurrency??0)),
    model_editor_calls:executions?.reduce((n,e)=>n+(e.metrics?.model_calls??0),0)??0};
});
const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
const median=xs=>{const sorted=[...xs].sort((a,b)=>a-b);return sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;};
const geometric=xs=>Math.exp(mean(xs.map(Math.log)));
function rng(seed=16381){return ()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32;};}
function bootstrap(rows,fn){const random=rng(),values=[];for(let i=0;i<10000;i++){const sample=Array.from({length:rows.length},()=>rows[Math.floor(random()*rows.length)]);values.push(fn(sample));}values.sort((a,b)=>a-b);return[values[250],values[9749]];}

const comparisons=[];
for(const selector of manifest.models){
  const selected=cells.filter(c=>c.selector===selector),tasks=[...new Set(selected.map(c=>c.task))];
  const byTask=tasks.map(task=>{
    const rows=selected.filter(c=>c.task===task),a=rows.filter(c=>c.arm==='agent'),b=rows.filter(c=>c.arm==='changeset');
    const ratios=a.flatMap(x=>{const y=b.find(y=>y.repetition===x.repetition);return x.accepted&&y?.accepted?[x.process_elapsed_ms/y.process_elapsed_ms]:[];});
    return {task,agent_passes:a.filter(c=>c.accepted).length,changeset_passes:b.filter(c=>c.accepted).length,
      agent_n:a.length,changeset_n:b.length,agent_mean_ms:mean(a.map(c=>c.process_elapsed_ms)),changeset_mean_ms:mean(b.map(c=>c.process_elapsed_ms)),
      capped_ratio:mean(a.map(c=>c.capped_time_to_success_ms))/mean(b.map(c=>c.capped_time_to_success_ms)),
      successful_pair_ratio:ratios.length?geometric(ratios):null,successful_pairs:ratios.length};
  });
  const arms=Object.fromEntries(['agent','changeset'].map(arm=>{
    const rows=selected.filter(c=>c.arm===arm),passes=rows.filter(c=>c.accepted).length;
    const known=rows.every(c=>c.equivalent_usd!==null&&c.equivalent_usd!==undefined);
    const sum=known?rows.reduce((n,c)=>n+c.equivalent_usd,0):null;
    return[arm,{n:rows.length,passes,hidden_passes:rows.filter(c=>c.hidden_pass).length,
      median_wall_ms:median(rows.map(c=>c.process_elapsed_ms)),mean_capped_ms:mean(rows.map(c=>c.capped_time_to_success_ms)),
      total_wall_ms:rows.reduce((n,c)=>n+c.process_elapsed_ms,0),model_calls:rows.every(c=>c.model_calls!=null)?rows.reduce((n,c)=>n+c.model_calls,0):null,
      mean_model_calls:rows.every(c=>c.model_calls!=null)?mean(rows.map(c=>c.model_calls)):null,total_equivalent_usd:sum,cost_per_acceptance:sum!==null&&passes?sum/passes:null,
      workflow_completed:rows.filter(c=>c.workflow_completed).length,top_level_errors:rows.filter(c=>c.error).length,
      repairs:rows.filter(c=>c.repairs>0).length,unknown_cost_cells:rows.filter(c=>c.equivalent_usd==null).length,
      tokens:Object.fromEntries(['input','output','cacheRead','cacheWrite','totalTokens'].map(k=>[k,rows.every(c=>c.tokens?.[k]!=null)?rows.reduce((n,c)=>n+c.tokens[k],0):null]))}];
  }));
  const successful=byTask.filter(t=>t.successful_pair_ratio!==null);
  comparisons.push({selector,task_count:tasks.length,arms,by_task:byTask,
    capped_geometric_speed_ratio:geometric(byTask.map(t=>t.capped_ratio)),
    capped_ratio_task_bootstrap_95:bootstrap(byTask,x=>geometric(x.map(t=>t.capped_ratio))),
    acceptance_difference:arms.changeset.passes/arms.changeset.n-arms.agent.passes/arms.agent.n,
    acceptance_difference_task_bootstrap_95:bootstrap(byTask,x=>mean(x.map(t=>t.changeset_passes/t.changeset_n-t.agent_passes/t.agent_n))),
    successful_pair_geometric_speed_ratio:successful.length?geometric(successful.map(t=>t.successful_pair_ratio)):null,
    successful_pair_ratio_task_bootstrap_95:successful.length?bootstrap(successful,x=>geometric(x.map(t=>t.successful_pair_ratio))):null,
    successful_pair_task_count:successful.length});
}
const supplemental=supplementalInput?JSON.parse(readFileSync(supplementalInput,'utf8')):null;
if(supplemental){
  if(supplemental.rows.length!==cells.length||cells.some(c=>supplemental.rows.filter(r=>r.cell===c.evidence_directory&&r.candidate_hash===c.candidate_hash).length!==1))throw new Error('Supplemental results do not match retained candidates');
  for(const c of comparisons){
    const rows=supplemental.rows.filter(r=>r.selector===c.selector);
    c.posthoc_acceptance=Object.fromEntries(['agent','changeset'].map(arm=>[arm,rows.filter(r=>r.arm===arm&&r.supplemental_accepted).length]));
    c.posthoc_new_failures=rows.filter(r=>r.original_accepted&&!r.supplemental_accepted).length;
    const scoped=cells.filter(cell=>cell.selector===c.selector).map(cell=>({...cell,
      audited:rows.find(row=>row.cell===cell.evidence_directory).supplemental_accepted}));
    const taskRatios=[...new Set(scoped.map(cell=>cell.task))].map(task=>{
      const group=scoped.filter(cell=>cell.task===task);
      const time=arm=>mean(group.filter(cell=>cell.arm===arm).map(cell=>cell.audited?cell.process_elapsed_ms:300000));
      return time('agent')/time('changeset');
    });
    c.posthoc_efficiency={
      capped_geometric_speed_ratio:geometric(taskRatios),
      capped_ratio_task_bootstrap_95:bootstrap(taskRatios,geometric),
      arms:Object.fromEntries(['agent','changeset'].map(arm=>[arm,{
        mean_capped_ms:mean(scoped.filter(cell=>cell.arm===arm).map(cell=>cell.audited?cell.process_elapsed_ms:300000)),
        cost_per_acceptance:c.arms[arm].total_equivalent_usd!==null&&c.posthoc_acceptance[arm]>0?c.arms[arm].total_equivalent_usd/c.posthoc_acceptance[arm]:null,
      }]))};
  }
}
const report={schema_version:1,run_id:basename(run),manifest,cost_policy:costPolicy,comparisons,cells,supplemental};
writeFileSync(output+'.json',JSON.stringify(report,null,2)+'\n');
const f=n=>n==null?'unknown':n.toFixed(2), lines=['# Matched study results','',
  `Frozen campaign: ${basename(run)}. ${cells.length} cells; ${comparisons[0]?.task_count??0} workload families; ${manifest.repetitions} repetitions per model and arm.`,
  '', 'Native Pi coding tools form the conventional baseline. Each pair uses the same model for all roles. Total process wall time includes planning, tool execution, visible checks, impact review, repairs, grading and process startup. Hidden graders run only after candidates freeze.', '',
  '| Model | Agent accepted | Changeset accepted | Agent median seconds | Changeset median seconds | Capped speed ratio (95% task interval) |',
  '|---|---:|---:|---:|---:|---:|'];
for(const c of comparisons){const a=c.arms.agent,b=c.arms.changeset;lines.push(`| ${c.selector} | ${a.passes}/${a.n} | ${b.passes}/${b.n} | ${f(a.median_wall_ms/1000)} | ${f(b.median_wall_ms/1000)} | ${f(c.capped_geometric_speed_ratio)} (${c.capped_ratio_task_bootstrap_95.map(f).join('–')}) |`);}
lines.push('', 'Ratios above 1 favor changesets. The capped metric assigns 300 seconds to unsuccessful cells. Medians include failures and are not time-to-correct-answer claims. Confidence intervals resample workload families, not individual repeats. This is a purposive small corpus, not a random sample of software engineering. An all-pass sample can produce a degenerate bootstrap interval; it does not establish equal population reliability.', '',
  '| Model | Agent model calls | Changeset model calls | Agent equivalent USD | Changeset equivalent USD |', '|---|---:|---:|---:|---:|');
for(const c of comparisons){const a=c.arms.agent,b=c.arms.changeset;lines.push(`| ${c.selector} | ${a.model_calls} | ${b.model_calls} | ${a.total_equivalent_usd?.toFixed(5)??'unknown'} | ${b.total_equivalent_usd?.toFixed(5)??'unknown'} |`);}
lines.push('', 'Equivalent costs price Sol tokens at DeepSeek rates per the operator’s subscription assumption. Original catalog costs, raw token totals, stage times, failures and task-level comparisons are retained in the companion JSON. Estimates are not invoices.', '',
  'Acceptance is determined by external tests, independently of reviewer opinion. A correct candidate can pass even if a final review response is malformed. Workflow completion and protocol errors remain separate operational measures:', '',
  '| Model | Agent completed workflow | Changeset completed workflow | Agent uncaught errors | Changeset uncaught errors |', '|---|---:|---:|---:|---:|');
for(const c of comparisons)lines.push(`| ${c.selector} | ${c.arms.agent.workflow_completed}/${c.arms.agent.n} | ${c.arms.changeset.workflow_completed}/${c.arms.changeset.n} | ${c.arms.agent.top_level_errors} | ${c.arms.changeset.top_level_errors} |`);
if(supplemental){
  lines.push('', '## Supplemental contract coverage audit', '',
    'Source inspection found that the original legacy-session grader missed the specified behavior for files without a session header. Additional checks cover that case and other explicit contract boundaries. The reference solutions passed. All 96 frozen candidates were rechecked, with no model calls, implementation changes or repair feedback. These are post-hoc observations, separate from the preregistered scores above.', '',
    '| Model | Agent accepted after supplemental checks | Changeset accepted after supplemental checks | Newly detected regressions |', '|---|---:|---:|---:|');
  for(const c of comparisons)lines.push(`| ${c.selector} | ${c.posthoc_acceptance.agent}/${c.arms.agent.n} | ${c.posthoc_acceptance.changeset}/${c.arms.changeset.n} | ${c.posthoc_new_failures} |`);
  lines.push('', '| Model | Post-hoc capped speed ratio (95% task interval) | Equivalent cost per accepted outcome, agent / changeset |', '|---|---:|---:|');
  for(const c of comparisons){const p=c.posthoc_efficiency;lines.push(`| ${c.selector} | ${f(p.capped_geometric_speed_ratio)} (${p.capped_ratio_task_bootstrap_95.map(f).join('–')}) | ${p.arms.agent.cost_per_acceptance?.toFixed(5)??'unknown'} / ${p.arms.changeset.cost_per_acceptance?.toFixed(5)??'unknown'} |`);}
  lines.push('', 'The original timing observations remain unchanged. Original conditional speed ratios do not imply speed to a correct result under these expanded checks. Sol acceptance is unchanged; DeepSeek and Mercury require the weaker reliability conclusion shown here.');
}
lines.push('',
  '## Per-workload results under original grading', '', '| Model | Task | Agent passes | Changeset passes | Mean seconds, agent / changeset |', '|---|---|---:|---:|---:|');
for(const c of comparisons)for(const t of c.by_task)lines.push(`| ${c.selector} | ${t.task} | ${t.agent_passes}/${t.agent_n} | ${t.changeset_passes}/${t.changeset_n} | ${f(t.agent_mean_ms/1000)} / ${f(t.changeset_mean_ms/1000)} |`);
lines.push('', 'Six synthetic tasks and two extracted historical modules cover mechanical migration, independent edits, shared-file parsers, cross-file precision, CSV parsing, Python aggregation, catalog validation and legacy session compatibility. Historical tasks require discovery in small module snapshots; they do not measure navigation in a full production repository. Visible tests are sparse, hidden checks cover specified boundaries, and model review is fallible.', '',
  'Provider caching, serving load and a single host can affect latency. Pair order is balanced across repetitions and randomized across tasks. No other study inference jobs run concurrently. SDK bytes are pinned; provider-side model deployments are outside the harness control. The study cannot establish general superiority, production readiness or success on ambiguous specifications and large refactors.', '');
writeFileSync(output+'.md',lines.join('\n'));console.log(JSON.stringify({output,cells:cells.length,comparisons:comparisons.map(({cells,by_task,...c})=>c)},null,2));
