import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCell } from './cell.mjs';

// Run alone: node --test --test-name-pattern='separate grading' scripts/changeset-study/cell.test.mjs
test('separate grading can finish after the implementation deadline without rejecting correct code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'study-grading-'));
  const previous = process.env.CHANGESET_MODEL_RUNTIME;
  const fake = join(root, 'fake-runtime.mjs');
  writeFileSync(fake, `export const ModelRuntime={create:async()=>({
    getModel:()=>({cost:{input:0.3,output:1.2}}),hasConfiguredAuth:()=>true,
    completeSimple:async(_model,context)=>({stopReason:'stop',usage:{cost:{total:0.000001}},content:[{type:'text',text:JSON.stringify(
      context.systemPrompt==='planner' ? {schema_version:1,operations:[{id:'fix',executor:'deterministic',reads:['answer.txt'],writes:['answer.txt'],depends_on:[],edits:[{kind:'replace',path:'answer.txt',search:'wrong',text:'correct'}]}]} : {accepted:true,findings:[]}
    )}]})})};`);
  process.env.CHANGESET_MODEL_RUNTIME = fake;
  try {
    const result = await runCell({ arm: 'changeset', selector: 'test/fake', ledger: join(root, 'budget.json'),
      directory: join(root, 'cell'), plannerPrompt: 'planner', task: {
        id: 'grading-deadline', spec: 'Set answer.txt to correct.', context: 'prepared', files: { 'answer.txt': 'wrong' },
        protected: [], check: 'test "$(cat answer.txt)" = correct',
        hidden: "import {readFileSync} from 'node:fs'; await new Promise(r=>setTimeout(r,1700)); if(readFileSync('/work/answer.txt','utf8')!=='correct') throw Error('wrong answer');",
        limits: { cell_ms: 1500, grade_ms: 3000 },
      } });
    assert.ok(result.implementation_ms < 1500, 'implementation must finish within its own allowance');
    assert.ok(result.total_ms > 1500, 'grading must cross the implementation deadline');
    assert.equal(result.hidden_pass, true, result.hidden?.output);
    assert.equal(result.accepted, true, result.error);
    assert.equal(result.outcome, 'passed');
  } finally {
    if (previous === undefined) delete process.env.CHANGESET_MODEL_RUNTIME;
    else process.env.CHANGESET_MODEL_RUNTIME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
