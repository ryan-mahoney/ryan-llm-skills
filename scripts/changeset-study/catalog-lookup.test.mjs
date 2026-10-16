// Run alone: CHANGESET_TEST_PARSER=/path/to/acorn.mjs node --test scripts/changeset-study/catalog-lookup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hash } from '../changeset/workspace.mjs';

test('catalog lookup reads frozen source once before the final plan and permits one validation correction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'study-lookup-'));
  const previous = process.env.CHANGESET_MODEL_RUNTIME;
  try {
    const scripts = fileURLToPath(new URL('..', import.meta.url));
    for (const folder of ['changeset-study', 'changeset', 'changeset-research']) cpSync(join(scripts, folder), join(root, 'scripts', folder), { recursive: true });
    mkdirSync(join(root, 'scripts/changeset-study/parser'), { recursive: true });
    assert.ok(process.env.CHANGESET_TEST_PARSER);
    cpSync(process.env.CHANGESET_TEST_PARSER, join(root, 'scripts/changeset-study/parser/acorn.mjs'));
    const fake = join(root, 'fake-runtime.mjs');
    writeFileSync(fake, `export const ModelRuntime={create:async()=>({
      getModel:(provider,id)=>({provider,id,api:'test',cost:{input:0.3,output:1.2}}),hasConfiguredAuth:()=>true,
      streamSimple:()=>{throw Error('Native discovery is forbidden');},
      completeSimple:async(model,context)=>{
        const input=JSON.parse(context.messages[0].content);
        let value;
        if(model.id==='planner') {
          if(input.task!==undefined || input.files!==undefined || input.feedback!==undefined || !input.implementation_brief || !input.catalog)
            throw Error('Unexpected task/source tree/behavioral feedback');
          const brief=input.implementation_brief;
          if(!input.source_lookup && !brief.includes('direct')) value={source_requests:[{path:brief.includes('bad-path')?'missing.mjs':'support.mjs',symbol:'prepare'}]};
          else if(brief.includes('repeat-lookup')) value={source_requests:[{path:'answer.mjs',tail:true}]};
          else {
            const binding=input.catalog.files.find(file=>file.path==='answer.mjs').preamble;
            const snippet=input.source_lookup?.snippets[0];
            if(snippet && (!snippet.text.includes('function prepare') || input.catalog.files.some(file=>file.path==='support.mjs')))
              throw Error('Lookup must add real source absent from initial catalog');
            value={schema_version:1,operations:[{id:'answer',executor:'simple',reads:snippet?['support.mjs']:[],writes:['answer.mjs'],depends_on:[],
              objective:'Correct answer',instruction:'Return correct',requirements:['Keep other source.'],context:[
                {path:'answer.mjs',start:brief.includes('correction')&&!input.planning_validation_errors?'invented':binding.start_anchor,end:binding.end_anchor},
                ...(snippet?[{path:'support.mjs',start:snippet.start,end:snippet.end}]:[])]}]};
          }
        } else {
          if(input.excerpts.some(e=>e.path==='support.mjs')&&!input.excerpts.some(e=>e.text.includes('function prepare')))
            throw Error('Writer did not receive bound helper source');
          value={edits:[{kind:'replace',path:'answer.mjs',search:"'wrong'",text:"'correct'"}]};
        }
        const malformed=model.id==='planner' && input.implementation_brief.includes('malformed') &&
          (input.implementation_brief.includes('malformed-twice') || (!input.source_lookup && !input.json_format_error));
        if(model.id==='planner' && input.implementation_brief.includes('transport-syntax-error')) throw new SyntaxError('provider decoding failed');
        return {stopReason:'stop',usage:{cost:{total:0.000001}},content:[{type:'text',text:JSON.stringify(value)+(malformed?' extra text':'')}]};
      }
    })};`);
    process.env.CHANGESET_MODEL_RUNTIME = fake;
    const { runCell } = await import(pathToFileURL(join(root, 'scripts/changeset-study/cell.mjs')));
    const brief = 'Change answer.mjs answer to correct. Preserve all other files.\n';
    const task = { id: 'lookup', spec: 'ORIGINAL TASK IS NOT QUERY INPUT', context: 'discovery', protected: [],
      files: { 'answer.mjs': "export function answer() { return 'wrong'; }\n", 'support.mjs': 'const prefix = true;\n// Fixture signature.\nexport function prepare(targets = [\'repo\']) { return targets; }\n' },
      check: 'node --input-type=module -e "import { answer } from \'./answer.mjs\'; if(answer()!==\'correct\') process.exit(1)"',
      hidden: "import {answer} from '/work/answer.mjs'; if(answer()!=='correct') throw Error('wrong answer');", limits: { cell_ms: 5000, grade_ms: 3000 } };
    const options = { task, arm: 'changeset', strategy: 'owner-query-writer', queryMode: 'catalog-lookup', preparedBrief: brief,
      plannerPrompt: 'planner', selector: 'test/planner', editorSelector: 'test/editor', ledger: join(root, 'budget.json') };
    const directory = join(root, 'correction');
    const result = await runCell({ ...options, directory, preparedBrief: brief + 'correction' });
    const requests = readFileSync(join(directory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(requests.map(r => [r.selector, r.stage]), [['test/planner','planning'], ['test/planner','planning'], ['test/planner','planning'], ['test/editor','editor']], JSON.stringify(result));
    assert.equal(result.executions[0]?.ok, true, JSON.stringify(result));
    assert.equal(result.source_requests_hash, hash(readFileSync(join(directory, 'source-requests.json'))));
    assert.equal(result.source_lookup_hash, hash(readFileSync(join(directory, 'source-lookup.json'))));
    const lookup = JSON.parse(readFileSync(join(directory, 'source-lookup.json')));
    assert.equal(lookup.snippets[0].source_hash, hash(task.files['support.mjs']));
    assert.equal(result.source_lookup_characters, lookup.source_characters);
    assert.equal(result.stages.filter(stage => stage.name === 'query-context').length, 2);
    assert.equal(result.query_mode, 'catalog-lookup');
    assert.equal(readFileSync(join(directory, 'repository/support.mjs'), 'utf8'), task.files['support.mjs']);
    const finalCorrection = JSON.parse(requests[2].context.messages[0].content);
    assert.deepEqual(finalCorrection.source_lookup, lookup);
    assert.ok(finalCorrection.previous_plan);
    assert.ok(finalCorrection.planning_validation_errors);

    for (const [mode, expectedCalls, message] of [['bad-path', 1, /unknown frozen source path/], ['repeat-lookup', 2, /allowed only once/]]) {
      const failedDirectory = join(root, mode);
      const failed = await runCell({ ...options, directory: failedDirectory, preparedBrief: brief + mode });
      const calls = readFileSync(join(failedDirectory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(calls.length, expectedCalls);
      assert.ok(calls.every(call => call.selector === 'test/planner'));
      assert.deepEqual(failed.executions, []);
      assert.match(failed.checks[0].implementation_error, message);
      if (mode === 'bad-path') {
        const failure = JSON.parse(readFileSync(join(failedDirectory, 'source-lookup.json')));
        assert.equal(failure.ok, false);
        assert.equal(failed.source_lookup_hash, hash(readFileSync(join(failedDirectory, 'source-lookup.json'))));
      }
    }
    const largeBrief = brief + 'direct ' + 'x '.repeat(45000);
    const directDirectory = join(root, 'direct');
    const direct = await runCell({ ...options, directory: directDirectory, preparedBrief: largeBrief });
    assert.equal(direct.executions[0]?.ok, true, JSON.stringify(direct));
    const directRequest = JSON.parse(readFileSync(join(directDirectory, 'requests.jsonl'), 'utf8').split('\n')[0]);
    assert.ok(Buffer.byteLength(JSON.stringify(directRequest.context)) > 80 * 1024);
    assert.equal(existsSync(join(directDirectory, 'source-requests.json')), false);
    const oversizedDirectory = join(root, 'oversized');
    const oversized = await runCell({ ...options, directory: oversizedDirectory, preparedBrief: brief + 'direct ' + 'x '.repeat(85000) });
    assert.equal(existsSync(join(oversizedDirectory, 'requests.jsonl')), false);
    assert.match(oversized.checks[0].implementation_error, /exceeds 160 KiB/);

    for (const [mode, expectedStages, succeeds] of [
      ['malformed-once direct', ['planning', 'planning', 'editor'], true],
      ['malformed-before-lookup', ['planning', 'planning', 'planning', 'editor'], true],
      ['malformed-twice direct', ['planning', 'planning'], false],
      ['malformed-once correction direct', ['planning', 'planning'], false],
      ['transport-syntax-error direct', ['planning'], false],
    ]) {
      const formatDirectory = join(root, mode.replaceAll(' ', '-'));
      const formatted = await runCell({ ...options, directory: formatDirectory, preparedBrief: brief + mode });
      const calls = readFileSync(join(formatDirectory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(calls.map(call => call.stage), expectedStages, mode);
      assert.equal(formatted.executions[0]?.ok === true, succeeds, mode);
      if (mode.startsWith('malformed')) {
        const retryInput = JSON.parse(calls[1].context.messages[0].content);
        assert.ok(retryInput.json_format_error, mode);
        assert.match(retryInput.previous_response_excerpt, /extra text$/, mode);
        assert.equal(formatted.query_format_recoveries.length, 1, mode);
      }
      if (mode === 'malformed-once correction direct')
        assert.match(formatted.checks[0].implementation_error, /correction allowance already used/);
    }
  } finally {
    if (previous === undefined) delete process.env.CHANGESET_MODEL_RUNTIME;
    else process.env.CHANGESET_MODEL_RUNTIME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
