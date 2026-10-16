import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverAccounting } from './accounting.mjs';

test('killed study workers retain completed charges and unresolved reservations', () => {
  const dir=mkdtempSync(join(tmpdir(),'study-accounting-'));
  try {
    const ledger=join(dir,'budget.json');
    writeFileSync(ledger,JSON.stringify({entries:[{id:'done',charged_usd:0.02,reserved_usd:1},{id:'in-flight',reserved_usd:2}]}));
    writeFileSync(join(dir,'requests.jsonl'),JSON.stringify({reservation:'done'})+'\n'+JSON.stringify({reservation:'in-flight'})+'\n');
    writeFileSync(join(dir,'receipts.jsonl'),JSON.stringify({reservation:'done',selector:'deepseek/deepseek-flash:off',usage:{input:10,output:20,cost:{total:0.02}}})+'\n{"partial');
    const recovered=recoverAccounting(dir,ledger);
    assert.equal(recovered.model_calls,2);assert.equal(recovered.accounting_complete,false);
    assert.equal(recovered.known_catalog_usd,0.02);assert.equal(recovered.retained_budget_exposure_usd,2.02);
    assert.equal(recovered.equivalent_usd,null);assert.equal(recovered.tokens.output,null);assert.equal(recovered.known_tokens.output,20);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
