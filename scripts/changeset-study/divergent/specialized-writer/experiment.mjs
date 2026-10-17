#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { prepare as freezeInputs, inventory, validateLedger, taskIds } from '../deepseek-direct/runner.mjs';
import { Client } from '../../client.mjs';
import { Workspace, safePath } from '../../../changeset/workspace.mjs';
import { sandbox, grade } from '../../sandbox.mjs';
import { changedTestCommands } from '../../candidate-checks.mjs';
import { recoverAccounting } from '../../accounting.mjs';
import { createWriter, selectedModel, digest, metadataHash } from './writer.mjs';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const same = (a,b) => digest(JSON.stringify(a)) === digest(JSON.stringify(b));
export const protocol = 'deepseek-specialized-full-file-v1';
export const selectors = ['openrouter/morph/morph-v3-fast', 'openrouter/relace/relace-apply-3'];
export const ownerSystem = `You own implementation of a coding task. You receive the exact task and a read-only virtual source tree. You cannot execute commands or modify a filesystem. No editor tools exist. Return ONLY one JSON object, without Markdown fences. To inspect source, return {"read":["repository/relative/path"]}; only listed existing files can be read. Requested source is provided verbatim on the next call and retained in subsequent prompts. When implementation is settled, return {"files":[{"path":"repository/relative/path","instruction":"complete settled instructions for this file","update":"precise code update snippet"}]}. Each target must occur once; new files are allowed; deletion is unsupported. The update is sent with the ORIGINAL complete target file to a specialized apply model which returns the full new file. Include sufficient unchanged code anchors and all changed/new code in the snippet. For a new file include its entire content. Never ask the apply model to design an implementation. Cross-file changes must be consistent. Preserve protected files. Include required regression tests unless the task forbids editing tests. Do not emit changeset IR, operations, offsets, shell commands, implementation commentary or tests results. You have at most 8 total requests, including read requests and one possible JSON-format correction. When final_preparation_required is true, emit files; further source requests are forbidden. Finish within that bound.`;
export const preparationTurnPolicy = (turn, corrected) => ({ finalRequired: turn >= (corrected ? 7 : 6), canCorrect: !corrected && turn < 7 });
export function validatePreparation(value, task) {
  if (!value || !Array.isArray(value.files) || !value.files.length || value.files.length > 32 || Object.keys(value).some(k=>k!=='files')) throw new Error('Owner must return only a nonempty files array (at most 32)');
  const seen = new Set();
  for (const file of value.files) {
    safePath(file.path);
    if (seen.has(file.path) || (task.protected ?? []).some(p=>file.path===p || file.path.startsWith(p+'/')) ||
        typeof file.instruction !== 'string' || !file.instruction.trim() || typeof file.update !== 'string' || !file.update.trim() ||
        Object.keys(file).some(k=>!['path','instruction','update'].includes(k))) throw new Error('Invalid, duplicate or protected owner target');
    seen.add(file.path);
  }
  return value;
}
export function guardClient(client, ledger, campaign, cap = 5) {
  const reserve = client.budget.reserve.bind(client.budget);
  client.budget.reserve = (selector, amount) => {
    const state = validateLedger(ledger).state;
    const exposure = state.entries.filter(e=>campaign.ids.has(e.id)).reduce((n,e)=>n+(e.charged_usd ?? e.reserved_usd),0);
    if (exposure + amount > cap) throw new Error('Specialized campaign $5 exposure guard');
    const id = reserve(selector, amount); campaign.ids.add(id);
    if(campaign.path) write(campaign.path,{reservation_ids:[...campaign.ids]});
    return id;
  };
  return client;
}
export function prepare(options) {
  const { output, manifest } = freezeInputs({ ...options, model: 'deepseek/deepseek-flash:off' });
  Object.assign(manifest, { protocol, strategy: 'settled-snippet-to-full-file', roles: { owner: 'deepseek/deepseek-flash:off', writers: selectors },
    limits: { extra_exposure_usd: 5, owner_calls: 8, json_format_retries: 1, semantic_retries: 0, writer_retries: 0,
      context_estimate: 'utf8-bytes-div4', writer_output_tokens: Object.fromEntries(selectors.map(s=>[s,selectedModel(s).maxTokens])) },
    metadata_hash: metadataHash, boundary: 'Standalone full-file route. Direct JSON owner with read-only source requests. No changeset execution, Sol inference, model review or repair. The legacy cell overlay retained by the shared freezer is unused.',
    limitations: ['Three exposed development tasks; one preparation and one attempt per vendor/task.', 'Byte/4 is an estimate, not a tokenizer or context acceptance guarantee.', 'Different advertised output ceilings are explicitly enforced (Morph 38000, Relace 128000).', 'All provider requests share the canonical ledger; reuse is allocated once per estimated complete route, not charged twice.', 'Legacy freezer retains cell overlay and planner skill; neither is used by this route.'] });
  write(join(output,'manifest.json'),manifest); return { output, manifest };
}
export function verify(output) {
  const m = read(join(output,'manifest.json'));
  if(m.protocol!==protocol || digest(readFileSync(process.execPath))!==m.node_hash || digest(readFileSync(join(output,'tasks.json')))!==m.tasks_hash ||
     !same(inventory(join(output,'frozen')),m.frozen_files) || !same(inventory(join(output,'sdk/node_modules')),m.sdk_files) ||
     m.mounts.some(([p],i)=>!same(inventory(p),m.dependency_files[i])) || metadataHash!==m.metadata_hash) throw new Error('Frozen experiment inputs changed');
  validateLedger(m.ledger); return m;
}
async function owner(task, directory, manifest, campaign) {
  mkdirSync(directory,{recursive:true}); const started=performance.now();
  const result={ task:task.id, status:'failed', files:null };
  const signal=AbortSignal.timeout(task.limits.cell_ms), loaded=Object.fromEntries(Object.entries(task.files).filter(([path])=>task.spec.includes(path) || task.spec.includes('`'+basename(path)+'`'))); let correction=null, corrected=false;
  let client;
  try {
  client=guardClient(await Client.create({selector:manifest.model,ledger:manifest.ledger,receiptPath:join(directory,'receipts.jsonl'),
    maxCalls:8,maxTokens:task.limits.max_output_tokens,callMs:task.limits.call_ms,signal}),manifest.ledger,campaign);
    for(let turn=0;turn<8;turn++) {
      let value; const policy=preparationTurnPolicy(turn,corrected);
      try { value=await client.json(ownerSystem,{task:task.spec,visible_check:task.check,protected_files:task.protected,
        tree:Object.entries(task.files).map(([path,s])=>({path,bytes:Buffer.byteLength(s)})),files:loaded,requests_remaining:8-turn,final_preparation_required:policy.finalRequired,...(correction?{json_format_correction:correction}:{})},'owner-preparation'); }
      catch(error) {
        if(error.name==='ModelJsonParseError' && policy.canCorrect) { corrected=true; correction={error:error.message,prior_response:error.responseExcerpt}; continue; }
        throw error;
      }
      correction=null;
      if(!policy.finalRequired && value && Array.isArray(value.read) && Object.keys(value).length===1 && value.read.length && value.read.every(p=>typeof p==='string' && Object.hasOwn(task.files,p))) {
        for(const path of value.read) loaded[path]=task.files[path];
        write(join(directory,`read-${turn}.json`),{paths:value.read}); continue;
      }
      validatePreparation(value,task); result.files=value.files; result.status='prepared'; write(join(directory,'settled.json'),value); break;
    }
    if(result.status!=='prepared') result.error='Owner exhausted eight-call preparation bound';
  } catch(error) { result.error=error.message; }
  result.elapsed_ms=performance.now()-started; result.format_correction_used=corrected;
  result.accounting=recoverAccounting(directory,manifest.ledger); write(join(directory,'result.json'),result); return result;
}
async function applyTask(task, preparation, selector, directory, manifest, campaign, parser) {
  mkdirSync(directory,{recursive:true}); const began=performance.now();
  const row={task:task.id,selector,status:'failed',application:false,delivered:false,files:[],preparation_status:preparation.status,
    preparation_elapsed_ms:preparation.elapsed_ms,preparation_accounting:preparation.accounting};
  if(preparation.status!=='prepared') { row.status='owner-failed'; write(join(directory,'result.json'),row); return row; }
  const files=structuredClone(task.files), signal=AbortSignal.timeout(Math.max(1,task.limits.cell_ms-preparation.elapsed_ms));
  let writer;
  try {
  writer=await createWriter({selector,ledger:manifest.ledger,receiptPath:join(directory,'receipts.jsonl'),
    maxOutputTokens:selectedModel(selector).maxTokens,maxOutputBytes:2000000,maxCalls:task.limits.model_calls-preparation.accounting.model_calls,
    callMs:task.limits.call_ms,signal,contextEstimate:'utf8-bytes-div4'});
  guardClient(writer.client,manifest.ledger,campaign);
    for(const input of preparation.files) {
      const start=performance.now(), source=task.files[input.path]??'';
      try {
        const result=await writer.write({...input,source,sourceHash:digest(source),allowedPaths:preparation.files.map(f=>f.path),protectedPaths:task.protected});
        files[input.path]=result.text; const {text,...receipt}=result;
        row.files.push({...receipt,elapsed_ms:performance.now()-start});
      } catch(error) { row.files.push({path:input.path,error:error.message,code:error.code??null,elapsed_ms:performance.now()-start}); throw error; }
    }
    row.application=true; row.status='applied';
  } catch(error) { row.error=error.message; row.status=signal.aborted?'timed-out':row.files.at(-1)?.code??'writer-failed'; }
  row.writer_elapsed_ms=performance.now()-began;
  row.modification_within_limits=!signal.aborted;
  // Freeze every candidate before any visible/hidden checks. No model calls follow checks.
  row.candidate_hash=digest(JSON.stringify(files)); writeFileSync(join(directory,'candidate.json'),JSON.stringify(files));
  const root=join(directory,'repository'); mkdirSync(root); new Workspace(files).materialize(root);
  const gradingStart=performance.now();
  try {
    const visible=await sandbox(root,task.check,{mounts:manifest.mounts,maxMs:task.limits.command_ms,timeoutMs:task.limits.command_ms,signal});
    const tests=[];
    for(const selected of changedTestCommands(task.files,files,parser)) {
      const checked=await sandbox(root,selected.command,{mounts:manifest.mounts,maxMs:task.limits.command_ms,timeoutMs:task.limits.command_ms,signal});
      if(checked.ok && selected.names && !/# pass [1-9]\d*/.test(checked.output)) checked.ok=false;
      tests.push({...selected,...checked});
    }
    row.visible=visible; row.candidate_tests=tests;
    row.checks_elapsed_ms=performance.now()-gradingStart;
    row.implementation_within_limits=!signal.aborted;
    row.hidden=await grade(root,task.hidden,{oracle:join(directory,'hidden.mjs'),mounts:manifest.mounts,maxMs:task.limits.grade_ms,signal:AbortSignal.timeout(task.limits.grade_ms)});
    row.protected_intact=(task.protected??[]).every(p=>files[p]===task.files[p]);
    row.terminal_pass=row.hidden.ok && row.protected_intact;
    if(task.id==='hard-dependency-handoff') {
      const auditPath=join(directory,'path-audit.json');
      const audit=spawnSync(process.execPath,[join(manifest.output,'frozen/scripts/changeset-study/path-audit.mjs'),join(directory,'candidate.json'),
        join(manifest.output,'frozen/scripts/changeset-study/parser/acorn.mjs'),auditPath],{timeout:30000,encoding:'utf8'});
      row.path_audit=existsSync(auditPath)?read(auditPath):{passed:false,structurally_inapplicable:true,error:(audit.stderr??audit.error?.message??'').slice(-4000)};
    }
    row.delivered=row.application && row.implementation_within_limits && row.terminal_pass && visible.ok && tests.every(t=>t.ok) &&
      (task.id!=='hard-dependency-handoff'||row.path_audit?.passed===true && row.path_audit.candidate_hash===row.candidate_hash);
  } catch(error) { row.grading_error=error.message; }
  row.grading_elapsed_ms=performance.now()-gradingStart; row.elapsed_ms=performance.now()-began;
  row.writer_accounting=recoverAccounting(directory,manifest.ledger);
  row.estimated_complete_route={elapsed_ms:preparation.elapsed_ms+row.elapsed_ms,preparation_and_modification_ms:preparation.elapsed_ms+row.writer_elapsed_ms,
    known_catalog_usd:preparation.accounting.known_catalog_usd+row.writer_accounting.known_catalog_usd,
    retained_budget_exposure_usd:preparation.accounting.retained_budget_exposure_usd+row.writer_accounting.retained_budget_exposure_usd,
    model_calls:(preparation.accounting.model_calls??0)+(row.writer_accounting.model_calls??0),
    accounting_complete:preparation.accounting.accounting_complete&&row.writer_accounting.accounting_complete};
  write(join(directory,'result.json'),row); return row;
}
export async function withFrozenRuntime(output, manifest, fn) {
  const sdk=realpathSync(join(output,manifest.sdk_root));
  const runtime=realpathSync(join(sdk,'pi-coding-agent/dist/core/model-runtime.js'));
  const keys=['CHANGESET_STUDY_SDK_ROOT','CHANGESET_MODEL_RUNTIME'], prior=keys.map(key=>process.env[key]);
  process.env[keys[0]]=sdk; process.env[keys[1]]=runtime;
  try { return await fn(); } finally {
    keys.forEach((key,i)=>{if(prior[i]===undefined) delete process.env[key]; else process.env[key]=prior[i];});
  }
}
export async function run(output) {
  output=realpathSync(output); const manifest=verify(output); manifest.output=output;
  if(realpathSync(fileURLToPath(import.meta.url))!==realpathSync(join(output,'frozen/scripts/changeset-study/divergent/specialized-writer/experiment.mjs'))) throw new Error('Execute frozen experiment runner');
  return withFrozenRuntime(output,manifest,async()=> {
  writeFileSync(join(output,'started.json'),JSON.stringify({at:new Date().toISOString()})+'\n',{flag:'wx'});
  const entries=validateLedger(manifest.ledger).state.entries;
  const baseline=entries.reduce((n,e)=>n+(e.charged_usd??e.reserved_usd),0);
  const campaign={ids:new Set(),path:join(output,'campaign-reservations.json')};
  write(join(output,'budget-baseline.json'),{exposure_usd:baseline,entries:entries.length,extra_guard_usd:5});
  const tasks=read(join(output,'tasks.json')); const {parse}=await import(pathToFileURL(join(output,'frozen/scripts/changeset-study/parser/acorn.mjs')).href);
  const preparations=[]; const rows=[];
  for(const task of tasks) {
    verify(output); const prep=await owner(task,join(output,'preparations',task.id),manifest,campaign); preparations.push(prep);
    write(join(output,'preparations.json'),preparations);
  }
  // Vendor arms run sequentially. All files use the same original source and frozen owner snippets.
  for(const [index,selector] of selectors.entries()) for(const task of tasks) {
    verify(output); const prep=preparations.find(p=>p.task===task.id);
    const row=await applyTask(task,prep,selector,join(output,`vendor-${index}`,task.id),manifest,campaign,parse); rows.push(row);
    write(join(output,'results.json'),{protocol,preparations,rows});
  }
  const finalEntries=validateLedger(manifest.ledger).state.entries;
  const final={protocol,tasks:taskIds,preparations,rows,actual_campaign:{entries:campaign.ids.size,
    exposure_usd:finalEntries.filter(e=>campaign.ids.has(e.id)).reduce((n,e)=>n+(e.charged_usd??e.reserved_usd),0)},note:'Actual shared preparation charged once; each estimated complete route allocates it once. Do not sum route estimates as actual campaign spend.'};
  write(join(output,'results.json'),final); return {output,completed_cells:rows.length};
  });
}
export async function main(args) {
  const [command,...rest]=args, options={};
  for(let i=0;i<rest.length;i+=2) { if(!['--source','--output','--ledger','--parser','--sdk-root'].includes(rest[i])||!rest[i+1]||Object.hasOwn(options,rest[i])) throw new Error('Unique named options required'); options[rest[i]]=rest[i+1]; }
  if(command==='prepare') return prepare({source:options['--source'],output:options['--output'],ledger:options['--ledger'],parser:options['--parser'],...(options['--sdk-root']?{sdk:options['--sdk-root']}:{})});
  if(command==='run' && Object.keys(options).length===1 && options['--output']) return run(options['--output']);
  throw new Error('Use prepare --source RUN03 --output NEW --ledger FILE --parser ACORN [--sdk-root SDK], or run --output FROZEN');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {const result=await main(process.argv.slice(2)); console.log(JSON.stringify({output:result.output,status:result.manifest?.status??'completed'}));}
  catch(error) {console.error(error.stack); process.exitCode=1;}
}
