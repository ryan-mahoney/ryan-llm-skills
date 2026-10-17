// CHANGESET_TEST_PARSER="$ACORN_MODULE" node --test scripts/changeset-study/catalog-integration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hash } from '../changeset/workspace.mjs';

test('catalog query reuses exact brief bytes and dispatches only query then writer calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'study-catalog-'));
  const previous = process.env.CHANGESET_MODEL_RUNTIME;
  try {
    const scripts = fileURLToPath(new URL('..', import.meta.url));
    for (const folder of ['changeset-study', 'changeset', 'changeset-research']) cpSync(join(scripts, folder), join(root, 'scripts', folder), { recursive: true });
    mkdirSync(join(root, 'scripts/changeset-study/parser'), { recursive: true });
    assert.ok(process.env.CHANGESET_TEST_PARSER, 'Use the same Acorn module as the study');
    cpSync(process.env.CHANGESET_TEST_PARSER, join(root, 'scripts/changeset-study/parser/acorn.mjs'));
    const fake = join(root, 'fake-runtime.mjs');
    writeFileSync(fake, `export const ModelRuntime={create:async()=>({
      getModel:(provider,id)=>({provider,id,api:'test',cost:{input:0.3,output:1.2}}),hasConfiguredAuth:()=>true,
      streamSimple:()=>{throw Error('Catalog mode must not start source discovery or rerun the owner');},
      completeSimple:async(model,context)=>{
        const input=JSON.parse(context.messages[0].content);
        let value;
        if(model.id==='planner') {
          if(input.task!==undefined || input.files!==undefined || !input.implementation_brief || !input.catalog || !input.file_tree || !input.protected_files)
            throw Error('Catalog query must receive only brief/catalog/tree/protected metadata');
          if(context.tools?.length) throw Error('Catalog query cannot have repository tools');
          if(input.implementation_brief.includes('bound-only')) throw Error('Oversized request reached inference');
          if(input.implementation_brief.includes('missing-binding')) value={blocked:'needs discovery: missing binding'};
          else {
            const file=input.catalog.files.find(file=>file.path==='answer.mjs');
            const definition=file.preamble;
            let start=definition.start_anchor,end=definition.end_anchor;
            if(input.implementation_brief.includes('cross-entry-context')) {
              start=file.symbols.find(symbol=>symbol.name==='before').start_anchor;
              end=file.symbols.find(symbol=>symbol.name==='between').end_anchor;
            } else if(input.implementation_brief.includes('start-anchor-as-end-context')) {
              start=file.symbols.find(symbol=>symbol.name==='before').start_anchor;
              end=file.symbols.find(symbol=>symbol.name==='answer').start_anchor;
            } else if(input.implementation_brief.includes('cross-file-binding')&&!input.planning_validation_errors) {
              start=input.catalog.files.find(file=>file.path==='other.mjs').symbols[0].start_anchor;
              end=file.symbols.find(symbol=>symbol.name==='answer').end_anchor;
            } else if(input.implementation_brief.includes('eof-append-context')) {
              start=file.symbols.find(symbol=>symbol.name==='answer').start_anchor;
              end=null;
            } else if(input.implementation_brief.includes('bad-catalog-binding')&&!input.planning_validation_errors) start='invented anchor';
            value={schema_version:1,operations:[{id:'answer',executor:'simple',reads:'answer.mjs',writes:'answer.mjs',
              objective:'Change answer',instruction:'Return correct',requirements:['Keep other files.'],
              context:[{path:'answer.mjs',start,end}]}]};
            if(input.implementation_brief.includes('unknown-create')) value.operations.push({
              id:'unknown',executor:'simple',reads:[],writes:['invented/new.mjs'],depends_on:[],
              objective:'Create unknown file',instruction:'create unknown',requirements:['Keep unrelated source.'],context:[]});
            if(input.implementation_brief.includes('generated-context')) {
              const later={id:'finish',executor:'simple',reads:[],writes:['src/new.mjs'],depends_on:['create'],
                objective:'Finish generated file',instruction:'finish',requirements:['Keep unrelated source.'],
                context:[{path:'src/new.mjs',start:null,end:null}]};
              const create={...later,id:'create',depends_on:[],instruction:'create',context:[]};
              if(input.implementation_brief.includes('before-creation-binding')) create.context=later.context;
              value.operations.push(create,later);
            }
          }
        } else if(input.instruction==='create') value={edits:[{kind:'create',path:'src/new.mjs',text:'export const value = 1;'}]};
        else if(input.instruction==='finish') value={edits:[{kind:'replace',path:'src/new.mjs',search:'value = 1',text:'value = 2'}]};
        else value={edits:[{kind:'replace',path:'answer.mjs',search:"'wrong'",text:"'correct'"}]};
        return {stopReason:'stop',usage:{cost:{total:0.000001}},content:[{type:'text',text:JSON.stringify(value)}]};
      }
    })};`);
    process.env.CHANGESET_MODEL_RUNTIME = fake;
    const { runCell } = await import(pathToFileURL(join(root, 'scripts/changeset-study/cell.mjs')));
    const brief = 'Change: answer.mjs function answer returns correct. Preserve before, between, after and other.mjs.\r\nReturn: edits.\n\n';
    const briefSource = { run: 'donor', cell: 'answer', brief_hash: hash(brief), result_hash: 'donor-result-hash' };
    const task = { id: 'catalog-answer', spec: 'ORIGINAL TASK MUST NOT REACH QUERY', context: 'discovery',
      files: { 'answer.mjs': "// Foreign anchor text: const other = 3;\nexport function before() { return 0; }\nexport function between() { return 1; }\nexport function answer() { return 'wrong'; }\nexport function after() { return 2; }\n",
        'other.mjs': 'const other = 3;\n' }, protected: [],
      check: 'node --input-type=module -e "import { answer } from \'./answer.mjs\'; if(answer()!==\'correct\') process.exit(1)"',
      hidden: "import {answer} from '/work/answer.mjs'; if(answer()!=='correct') throw Error('wrong answer');",
      limits: { cell_ms: 5000, grade_ms: 3000 } };
    const options = { arm: 'changeset', strategy: 'owner-query-writer', queryMode: 'catalog',
      selector: 'test/planner', editorSelector: 'test/editor', ledger: join(root, 'budget.json'),
      plannerPrompt: 'planner', task, preparedBrief: brief, briefSource };
    const directory = join(root, 'reuse');
    const result = await runCell({ ...options, directory });
    const requests = readFileSync(join(directory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(requests.map(r => [r.selector, r.stage]), [['test/planner', 'planning'], ['test/editor', 'editor']], JSON.stringify(result));
    assert.equal(result.implementation_brief_hash, briefSource.brief_hash);
    assert.deepEqual(result.brief_source, briefSource);
    assert.deepEqual(readFileSync(join(directory, 'implementation-brief.md')), Buffer.from(brief));
    assert.equal(result.query_mode, 'catalog');
    assert.equal(result.catalog_hash, hash(readFileSync(join(directory, 'catalog.json'))));
    assert.equal(result.stages.some(stage => stage.name === 'query-context'), true);
    assert.equal(result.query_normalizations.length, 3);
    const rawPlan = JSON.parse(readFileSync(join(directory, 'raw-plan.json'), 'utf8'));
    assert.deepEqual(rawPlan.operations[0].reads, ['answer.mjs']);
    assert.deepEqual(rawPlan.operations[0].writes, ['answer.mjs']);
    assert.deepEqual(rawPlan.operations[0].depends_on, []);
    const response = JSON.parse(readFileSync(join(directory, 'responses.jsonl'), 'utf8').split('\n')[0]);
    assert.equal(JSON.parse(response.response.content[0].text).operations[0].writes, 'answer.mjs');
    assert.equal(result.executions[0]?.ok, true, JSON.stringify(result));
    assert.equal(readFileSync(join(directory, 'repository/answer.mjs'), 'utf8'),
      "// Foreign anchor text: const other = 3;\nexport function before() { return 0; }\nexport function between() { return 1; }\nexport function answer() { return 'correct'; }\nexport function after() { return 2; }\n");

    const crossEntryDirectory = join(root, 'cross-entry');
    const crossEntry = await runCell({ ...options, preparedBrief: brief + 'cross-entry-context', briefSource: null, directory: crossEntryDirectory });
    assert.deepEqual(readFileSync(join(crossEntryDirectory, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).stage), ['planning', 'editor']);
    assert.equal(crossEntry.executions[0]?.ok, true, JSON.stringify(crossEntry));

    const startAsEndDirectory = join(root, 'start-as-end-context');
    const startAsEnd = await runCell({ ...options, preparedBrief: brief + 'start-anchor-as-end-context', briefSource: null, directory: startAsEndDirectory });
    assert.deepEqual(readFileSync(join(startAsEndDirectory, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).stage), ['planning', 'editor']);
    assert.equal(startAsEnd.executions[0]?.ok, true, JSON.stringify(startAsEnd));

    const eofDirectory = join(root, 'eof-context');
    const eofContext = await runCell({ ...options, preparedBrief: brief + 'eof-append-context', briefSource: null, directory: eofDirectory });
    assert.deepEqual(readFileSync(join(eofDirectory, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).stage), ['planning', 'editor']);
    assert.equal(eofContext.executions[0]?.ok, true, JSON.stringify(eofContext));

    const correctionDirectory = join(root, 'correction');
    const correction = await runCell({ ...options, preparedBrief: brief + 'bad-catalog-binding', briefSource: null, directory: correctionDirectory });
    const correctionRequests = readFileSync(join(correctionDirectory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(correctionRequests.map(request => request.stage), ['planning', 'planning', 'editor']);
    const correctedInput = JSON.parse(correctionRequests[1].context.messages[0].content);
    assert.match(correctedInput.planning_validation_errors.join(';'), /absent from catalog/);
    assert.deepEqual(correctedInput.catalog, JSON.parse(correctionRequests[0].context.messages[0].content).catalog);
    assert.equal(correction.executions[0]?.ok, true, JSON.stringify(correction));

    const crossFileDirectory = join(root, 'cross-file');
    await runCell({ ...options, preparedBrief: brief + 'cross-file-binding', briefSource: null, directory: crossFileDirectory });
    const crossFileRequests = readFileSync(join(crossFileDirectory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(crossFileRequests.map(request => request.stage), ['planning', 'planning', 'editor']);
    const crossFileCorrection = JSON.parse(crossFileRequests[1].context.messages[0].content);
    assert.match(crossFileCorrection.planning_validation_errors.join(';'), /absent from catalog/);

    const generatedDirectory = join(root, 'generated');
    const generatedBrief = brief + ' Create src/new.mjs, then finish it. generated-context';
    const generated = await runCell({ ...options, preparedBrief: generatedBrief, briefSource: null, directory: generatedDirectory });
    assert.equal(generated.executions[0]?.ok, true, JSON.stringify(generated));
    assert.equal(readFileSync(join(generatedDirectory, 'repository/src/new.mjs'), 'utf8'), 'export const value = 2;');
    const premature = await runCell({ ...options, preparedBrief: generatedBrief + ' before-creation-binding', briefSource: null, directory: join(root, 'premature') });
    assert.deepEqual(premature.executions, []);
    assert.match(premature.checks[0].implementation_error, /binding is absent from catalog/);

    const unknownDirectory = join(root, 'unknown-create');
    const unknown = await runCell({ ...options, preparedBrief: brief + 'unknown-create', briefSource: null, directory: unknownDirectory });
    assert.deepEqual(unknown.executions, []);
    assert.match(unknown.checks[0].implementation_error, /absent write has no explicit catalog binding: invented\/new.mjs/);
    const unknownRequests = readFileSync(join(unknownDirectory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(unknownRequests.map(request => request.stage), ['planning', 'planning'], 'unbound creation must never dispatch a writer');
    assert.equal(existsSync(join(unknownDirectory, 'repository/invented/new.mjs')), false);

    await assert.rejects(runCell({ ...options, preparedBrief: brief + 'tampered', directory: join(root, 'tampered') }), /Shared brief changed/);
    assert.equal(existsSync(join(root, 'tampered/requests.jsonl')), false);

    const blockedDirectory = join(root, 'blocked');
    const blocked = await runCell({ ...options, preparedBrief: brief + 'missing-binding', briefSource: null, directory: blockedDirectory });
    const blockedRequests = readFileSync(join(blockedDirectory, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(blockedRequests.length, 1);
    assert.match(blocked.checks[0].implementation_error, /needs discovery/);
    assert.deepEqual(blocked.executions, []);

    const boundDirectory = join(root, 'bound');
    const bound = await runCell({ ...options, preparedBrief: brief + 'bound-only' + 'x '.repeat(41 * 1024), briefSource: null, directory: boundDirectory });
    assert.equal(existsSync(join(boundDirectory, 'requests.jsonl')), false);
    assert.match(bound.checks[0].implementation_error, /needs discovery/);
    assert.deepEqual(bound.executions, []);
  } finally {
    if (previous === undefined) delete process.env.CHANGESET_MODEL_RUNTIME;
    else process.env.CHANGESET_MODEL_RUNTIME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
