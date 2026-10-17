// node --test pi/extensions/spec-runtime/changeset-runtime.integration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Runtime, loadRun, launch, runEditor, runCommit, runVerification } from './runtime.mjs';
import { writerClient } from './changeset-runtime.mjs';
import { makePackageFixture } from './package-fixture.mjs';
import { recordStageFingerprint, submitStage } from './wave-review.mjs';

test('managed dispatch retains default ownership and executes strong planning through real worker lifecycle', async t => {
  const f = await makePackageFixture(), bin = join(f.dir, 'bin'), previousPath = process.env.PATH;
  mkdirSync(bin);
  // Use the same OS advisory lock on macOS, which lacks the flock CLI. The
  // exercised runtime/ownership commands, pipes and worker processes are real.
  writeFileSync(join(bin, 'flock'), '#!/usr/bin/env python3\nimport sys, fcntl, subprocess\nwith open(sys.argv[2], "a+b") as handle:\n fcntl.flock(handle, fcntl.LOCK_EX)\n sys.exit(subprocess.call(sys.argv[3:]))\n');
  chmodSync(join(bin, 'flock'), 0o755); process.env.PATH = `${bin}:${previousPath ?? ''}`;
  let runtime;
  t.after(async () => {
    if (runtime) for (const { record } of [...runtime.active.values()]) await runtime.cancel(record.package, record.id);
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(f.dir, { recursive: true, force: true });
  });
  const plan = { schema_version: 1, operations: [{ id: 'readme', executor: 'simple', reads: [], writes: ['README'], depends_on: [],
    objective: 'Update the fixture', instruction: 'Replace fixture with updated.', requirements: ['Keep the final newline.'],
    context: [{ path: 'README', start: null, end: null }] }] };
  const program = join(f.dir, 'worker.cjs');
  writeFileSync(program, `if (process.env.SPEC_RUNTIME_ROLE === 'planner') {
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',usage:{input:3,output:2},content:[{type:'text',text:${JSON.stringify(JSON.stringify(plan))}}]}}));
  } else if (process.env.SPEC_RUNTIME_ROLE === 'reviewer') {
    const timer=setInterval(()=>{if(require('node:fs').existsSync(process.env.SPEC_RUNTIME_RECORD.replace(/\\.json$/, '-stage.json'))) {
      clearInterval(timer); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Review submitted'}]}}));
    }},10);
  } else setInterval(()=>{},1000);`);
  const launchProcess = (record, role, prompt, options) => launch(record, role, prompt, { command: process.execPath, prefix: [program], ...options });
  runtime = new Runtime({ location: f.location, indexDir: join(f.dir, 'index'), launchProcess });
  const step = join(f.packagePath, 'step-001-subspec.md'); writeFileSync(step, 'Update the fixture README.');
  const started = await runtime.start({ package: f.packagePath, step, owner_model: 'fixture/default:low',
    strong_owner_model: 'fixture/strong:high', editor_model: 'fixture/writer:off', writing_route: 'changeset-v1', timeout_ms: 30000 });
  const record = loadRun(f.packagePath, started.run_id);
  assert.equal(record.owner_model, 'fixture/default:low'); assert.equal(record.planner_model, 'fixture/strong:high');
  const responseRuntime = { getModel: (provider, id) => ({ provider, id, maxTokens: 1000 }), hasConfiguredAuth: () => true,
    completeSimple: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: '*** Begin Patch\n*** Update File: README\n@@\n-fixture\n+updated\n*** End Patch' }], usage: { input: 8, output: 4 } }) };
  const result = await runEditor(record, 'Update the fixture README.', undefined, launchProcess, {
    createClient: (selector, options) => writerClient(selector, { ...options, runtime: responseRuntime }) });
  assert.equal(result.publication, 'published');
  assert.equal(readFileSync(join(record.checkout, 'README'), 'utf8'), 'updated\n');
  assert.equal(readFileSync(join(f.repo, 'README'), 'utf8'), 'fixture\n');
  const summary = JSON.parse(readFileSync(result.full_result_path, 'utf8'));
  assert.deepEqual(summary.calls.map(call => call.stage), ['planning', 'writer']);
  assert.ok(summary.planning_ms > 0);
  assert.equal(summary.publication, 'published');
  assert.ok(readFileSync(join(f.packagePath, 'runtime/events.jsonl'), 'utf8').includes('changeset_publication_finished'));
  await t.test('published edits verify and commit through the real Linux boundary', {
    skip: process.platform !== 'linux' ? 'Requires Linux execution host or CI' : false,
  }, async () => {
    const verified = await runVerification(record, 'test "$(cat README)" = updated');
    assert.equal(verified.exit_code, 0); assert.equal(verified.enforcement.source, 'read-only');
    const committed = await runCommit(record, 'test(fixture): update managed source');
    assert.equal(committed.error, undefined); assert.equal(committed.exit_code, 0);
    assert.deepEqual(committed.edit_ids, [result.edit_id]); assert.deepEqual(committed.paths, ['README']);
  });
  let finishedReview;
  const reviewed = new Promise(resolve => { finishedReview = resolve; });
  const head = record.revisions.checkout.head;
  const review = await runtime.start({ package: f.packagePath, step, assignment_id: 'independent-review',
    owner_model: 'fixture/reviewer:high', review_model: 'fixture/reviewer:high', strong_owner_model: 'fixture/strong:high',
    editor_model: 'fixture/writer:off', writing_route: 'changeset-v1', timeout_ms: 30000,
    stage: { role: 'reviewer', kind: 'review', label: 'step-001', base: head, head, round: 1, review_path: 'reviews/step-001-review.md' } });
  runtime.notify = result => { if (result.run_id === review.run_id) finishedReview(result); };
  const reviewRecord = loadRun(f.packagePath, review.run_id);
  assert.notEqual(reviewRecord.checkout, record.checkout);
  assert.equal(readFileSync(join(reviewRecord.checkout, 'README'), 'utf8'), 'fixture\n');
  recordStageFingerprint(reviewRecord);
  submitStage(reviewRecord, 'reviewer', { verdict: 'pass', findings: [], fix_verdicts: [], limitations: [] });
  const reviewResult = await reviewed;
  assert.equal(reviewResult.state, 'completed'); assert.equal(reviewResult.handoff.status, 'recorded');
  assert.equal(loadRun(f.packagePath).id, record.id, 'background review does not replace the integration writer lease');
  assert.equal(readFileSync(join(record.checkout, 'README'), 'utf8'), 'updated\n');
  assert.equal(loadRun(f.packagePath, review.run_id).review_checkout.removed, true);
  const cancelled = await runtime.cancel(f.packagePath, record.id);
  assert.equal(cancelled.state, 'cancelled');
});
