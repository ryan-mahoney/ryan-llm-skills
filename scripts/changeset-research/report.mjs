#!/usr/bin/env node
// Report retained evidence; never treat unknown pricing as zero or combine
// differing workload versions as matched experiments.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { equivalentCost, costPolicy } from './cost.mjs';
const root = resolve(process.argv[2] ?? '.');
const rows = [];
for (const name of readdirSync(root).sort()) {
  const dir=join(root,name);
  if (!existsSync(join(dir,'run.json')) || !existsSync(join(dir,'manifest.json'))) continue;
  const run=JSON.parse(readFileSync(join(dir,'run.json'),'utf8')), manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));
  for (const cell of run.cells) {
    let execution=null;
    try { execution=JSON.parse(readFileSync(join(dir,cell.artifacts?.execution_report ?? join(cell.id,'execution.json')),'utf8')); } catch { /* unfinished */ }
    rows.push({run:name,scenario:cell.scenario,version:cell.version,model:cell.model,outcome:cell.outcome ?? 'unfinished',reason:cell.reason,
      candidate:manifest.changeset_sha256,skill:manifest.skill_sha256,elapsed_ms:cell.elapsed_ms,cost_usd:cell.cost_usd,
      equivalent_cost_usd:equivalentCost(execution?.receipts),first_pass:execution?.workflow?.first_pass ?? null,repairs:execution?.workflow?.repairs ?? null,
      tokens:cell.tokens,model_calls:execution?.receipts?.length ?? null,metrics:execution?.report?.metrics ?? null});
  }
}
const groups = new Map();
for(const row of rows) {
  const key=JSON.stringify([row.candidate,row.skill,row.scenario,row.version]);
  if(!groups.has(key)) groups.set(key,[]); groups.get(key).push(row);
}
const summary={schema_version:1,cost_policy:costPolicy,observed_at:new Date().toISOString(),rows,groups:[...groups.values()].map(items=>({candidate:items[0].candidate,scenario:items[0].scenario,version:items[0].version,
  total:items.length,passed:items.filter(x=>x.outcome==='passed').length,finished:items.filter(x=>x.outcome!=='unfinished').length,
  reported_cost_usd:items.every(x=>x.cost_usd!==null)?items.reduce((n,x)=>n+x.cost_usd,0):null,
}))};
if(process.argv[3])writeFileSync(resolve(process.argv[3]),JSON.stringify(summary,null,2)+'\n');
console.log('run\tscenario\tplanner\toutcome\tseconds\tcatalog USD\tmodel calls\tequivalent USD');
for(const r of rows)console.log([r.run,r.scenario,r.model,r.outcome,r.elapsed_ms===null?'unknown':(r.elapsed_ms/1000).toFixed(2),r.cost_usd===null?'unknown':r.cost_usd.toFixed(6),r.model_calls??'unknown',r.equivalent_cost_usd===null?'unknown':r.equivalent_cost_usd.toFixed(6)].join('\t'));
console.log('\nDistinct candidate/workload/version groups: '+groups.size);
