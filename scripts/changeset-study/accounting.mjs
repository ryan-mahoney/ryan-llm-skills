import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { equivalentCost } from '../changeset-research/cost.mjs';

const rows = path => {
  if (!existsSync(path)) return [];
  return readFileSync(path,'utf8').split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
};
export function recoverAccounting(directory, ledger) {
  const receipts = rows(join(directory,'receipts.jsonl')), requests = rows(join(directory,'requests.jsonl'));
  const ids = new Set([...receipts,...requests].map(r=>r.reservation));
  const entries = JSON.parse(readFileSync(ledger,'utf8')).entries.filter(e=>ids.has(e.id));
  const complete = ids.size > 0 && ids.size === receipts.length && receipts.every(r=>r.usage?.cost?.total > 0);
  return {
    model_calls: ids.size || null,
    accounting_complete: complete,
    catalog_usd: complete ? receipts.reduce((n,r)=>n+r.usage.cost.total,0) : null,
    known_catalog_usd: receipts.reduce((n,r)=>n+(r.usage?.cost?.total??0),0),
    equivalent_usd: complete ? equivalentCost(receipts) : null,
    retained_budget_exposure_usd: entries.reduce((n,e)=>n+(e.charged_usd??e.reserved_usd),0),
    tokens: Object.fromEntries(['input','output','cacheRead','cacheWrite','totalTokens'].map(key=>[key,
      complete ? receipts.reduce((n,r)=>n+(r.usage?.[key]??0),0) : null])),
    known_tokens: Object.fromEntries(['input','output','cacheRead','cacheWrite','totalTokens'].map(key=>[key,
      receipts.reduce((n,r)=>n+(r.usage?.[key]??0),0)])),
  };
}
