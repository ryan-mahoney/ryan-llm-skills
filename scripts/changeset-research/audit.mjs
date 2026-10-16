#!/usr/bin/env node
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Budget,modelRuntime,completeJson } from '../changeset/models.mjs';
import { hash } from '../changeset/workspace.mjs';
const [budgetFile,output,...paths]=process.argv.slice(2);
if(!budgetFile||!output||!paths.length)throw new Error('Usage: audit BUDGET OUTPUT SOURCE...');
const files=Object.fromEntries(paths.map(p=>[p,readFileSync(resolve(p),'utf8')]));
const runtime=await modelRuntime(),receipts=[];
const result=await completeJson({runtime,budget:new Budget(budgetFile),selector:'openai-codex/gpt-6.1-sol:low',maxTokens:8000,timeoutMs:120000,onReceipt:r=>{receipts.push(r);writeFileSync(output,JSON.stringify({source_sha256:hash(JSON.stringify(files)),receipts,status:'in-progress'},null,2)+'\n');},
 system:'Review this experimental changeset implementation independently. Return JSON {findings:[{severity:"high|medium|low",file,condition,consequence,reproduction,fix}],assessment:string}. Report concrete correctness, acceptance, budget accounting, measurement validity and rollback defects supported by code. Do not invent requirements or request broad refactors. The PoC supports small trusted UTF-8 workspaces, exclusive external disk writers, known providers, trusted curator graders and no OS sandbox. It promises staged batch rollback, current context on dependent edits, complete budget reservations, and truthful evidence. A final strong reviewer cannot waive failed behavioral gates. Review is source-only; do not claim tests ran.',
 prompt:JSON.stringify({files})});
writeFileSync(output,JSON.stringify({source_sha256:hash(JSON.stringify(files)),receipts,...result.value},null,2)+'\n');
console.log(output);
