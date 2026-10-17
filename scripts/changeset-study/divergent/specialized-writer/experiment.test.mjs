import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePreparation, guardClient, withFrozenRuntime, preparationTurnPolicy, remainingCellMs } from './experiment.mjs';
import { buildInput, selectedModel, digest } from './writer.mjs';

test('settled full-file preparation rejects duplicate, protected and escaping targets before writing',()=>{
  const task={protected:['visible.mjs']}, file={path:'lib/a.mjs',instruction:'Set value',update:'export const a=1;'};
  assert.deepEqual(validatePreparation({files:[file]},task),{files:[file]});
  for(const files of [[file,file],[{...file,path:'visible.mjs'}],[{...file,path:'../outside.mjs'}],[{...file,update:''}]])
    assert.throws(()=>validatePreparation({files},task));
});

test('opt-in context estimate admits large full-file request while strict default rejects and estimated overflow remains fenced',()=>{
  const model=selectedModel('openrouter/morph/morph-v3-fast');
  const source='//'+ 'a'.repeat(143000), input={path:'lib/a.mjs',allowedPaths:['lib/a.mjs'],source,sourceHash:digest(source),instruction:'Update',update:'const x=1;'};
  assert.throws(()=>buildInput(input,model,38000),{code:'context-cap'});
  const estimated=buildInput(input,model,38000,'utf8-bytes-div4');
  assert.equal(estimated.contextEstimate,'utf8-bytes-div4'); assert.ok(estimated.estimatedInputTokens<37000);
  const larger='x'.repeat(200000);
  assert.throws(()=>buildInput({...input,source:larger,sourceHash:digest(larger)},model,38000,'utf8-bytes-div4'),{code:'context-cap'});
});

test('campaign guard includes existing holds and refuses reservation above extra spend ceiling without changing canonical ledger',()=>{
  const root=mkdtempSync(join(tmpdir(),'specialized-guard-')),ledger=join(root,'budget.json');
  try {
    writeFileSync(ledger,JSON.stringify({schema_version:1,limit_usd:50,entries:[{id:'a',selector:'deepseek/model',reserved_usd:1,status:'unknown',charged_usd:null}]}));
    let reserved=0; const client={budget:{reserve(_selector,amount){reserved+=amount;return 'id';}}};
    guardClient(client,ledger,{ids:new Set(['a'])},5);
    assert.equal(client.budget.reserve('deepseek/model',4),'id'); assert.equal(reserved,4);
    assert.throws(()=>client.budget.reserve('deepseek/model',4.01),/\$5 exposure guard/); assert.equal(reserved,4);
  } finally {rmSync(root,{recursive:true,force:true});}
});


test('actual inference runtime uses frozen SDK and restores caller environment even on failure',async()=>{
  const root=mkdtempSync(join(tmpdir(),'specialized-sdk-'));
  const runtime=join(root,'sdk/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js');
  const keys=['CHANGESET_STUDY_SDK_ROOT','CHANGESET_MODEL_RUNTIME'], prior=keys.map(k=>process.env[k]);
  try {
    mkdirSync(join(runtime,'..'),{recursive:true}); writeFileSync(runtime,'// frozen fixture');
    process.env[keys[0]]='/unfrozen-sdk'; delete process.env[keys[1]];
    await assert.rejects(withFrozenRuntime(root,{sdk_root:'sdk/node_modules/@earendil-works'},async()=>{
      assert.equal(process.env[keys[0]],join(root,'sdk/node_modules/@earendil-works'));
      assert.equal(process.env[keys[1]],runtime); throw new Error('expected');
    }),/expected/);
    assert.equal(process.env[keys[0]],'/unfrozen-sdk'); assert.equal(process.env[keys[1]],undefined);
  } finally {
    keys.forEach((k,i)=>{if(prior[i]===undefined) delete process.env[k]; else process.env[k]=prior[i];});
    rmSync(root,{recursive:true,force:true});
  }
});


test('owner reserves final emission plus an unused JSON correction within eight total calls',()=>{
  assert.deepEqual(preparationTurnPolicy(5,false),{finalRequired:false,canCorrect:true});
  assert.deepEqual(preparationTurnPolicy(6,false),{finalRequired:true,canCorrect:true});
  assert.deepEqual(preparationTurnPolicy(7,true),{finalRequired:true,canCorrect:false});
  assert.deepEqual(preparationTurnPolicy(6,true),{finalRequired:false,canCorrect:false});
});


test('fractional measured preparation time becomes a positive integer deadline accepted by Node',()=>{
  assert.equal(remainingCellMs(1200000,5396.871201),1194603);
  assert.equal(remainingCellMs(1200000,1200000.25),1);
  assert.doesNotThrow(()=>AbortSignal.timeout(remainingCellMs(1200000,5396.871201)));
});
