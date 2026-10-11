import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Runtime, launch, loadRun, summary, groupAlive, runEditor, runCommand, runVerification, runCompletion, runAdvice, activeGroups, spawnManaged, settleGroup, assertLease, assertIdleWriter, editorSlot, revoke } from './runtime.mjs';
import { createVerificationRecorder, readVerificationIncidents } from './sentinel.mjs';
import { makePackageFixture } from './package-fixture.mjs';

async function fixture(t, source) {
  const base = await makePackageFixture();
  const { dir, repo, packagePath, location } = base;
  const step = join(packagePath, 'step-001-subspec.md'); writeFileSync(step, 'Prepared step');
  const fake = join(dir, 'fake-pi.cjs');
  writeFileSync(fake, source || `setTimeout(() => { console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Implemented; focused check passed.'}]}})); }, 50);`);
  const pids = [];
  let notified;
  const finished = new Promise(resolve => { notified = resolve; });
  const options = { indexDir: join(dir, 'index'), notify: notified, location, launchProcess: (record, role, prompt, launchOptions = {}) => {
    const task = launch(record, role, prompt, { command: process.execPath, prefix: [fake], ...launchOptions }); pids.push(task.child.pid); return task;
  } };
  t.after(() => { for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch {} } rmSync(dir, { recursive: true, force: true }); });
  return { ...base, step, options, finished, pids, input: { package: packagePath, step, owner_model: 'test/owner', editor_model: 'test/editor' } };
}

function prepare(f, difficulty = 'hard') {
  for (const file of ['context.md', 'spec.md', 'spec-prepare.md']) writeFileSync(join(f.packagePath, file), 'Prepared and validated');
  writeFileSync(f.locations.project_context, 'Project authority');
  writeFileSync(join(f.packagePath, 'evidence-plan.json'), '{}');
  writeFileSync(join(f.packagePath, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1, difficulty }] }));
  const { step, ...input } = f.input;
  return { ...input, strong_owner_model: 'test/strong' };
}

test('prepared startup routes hard work, returns retained progress, and never equates worker completion with acceptance', async t => {
  const f = await fixture(t), input = prepare(f), runtime = new Runtime(f.options);
  const started = await runtime.startup(input, '/parent/session.jsonl');
  assert.equal(started.owner_model, 'test/strong');
  assert.equal(started.routing_reason, 'prepared hard tier');
  assert.equal(existsSync(join(f.packagePath, 'history-index.json')), true);
  assert.equal((await runtime.startup(input)).run_id, started.run_id);
  await f.finished;
  const resumed = await runtime.startup(input);
  assert.equal(resumed.run_id, started.run_id);
  assert.match(resumed.next, /never infer acceptance/);
  assert.equal(f.pids.length, 1);
  assert.ok(Date.parse(loadRun(f.packagePath).dispatch_requested_at) <= Date.parse(loadRun(f.packagePath).started_at));
});

test('prepared startup defers pending directions and legacy progress without launching a writer', async t => {
  const f = await fixture(t), input = prepare(f), runtime = new Runtime(f.options);
  mkdirSync(join(f.packagePath, 'inbox'));
  writeFileSync(join(f.packagePath, 'inbox/hold.md'), 'Hold implementation');
  assert.equal((await runtime.startup(input)).state, 'needs_intake');
  rmSync(join(f.packagePath, 'inbox/hold.md'));
  writeFileSync(join(f.packagePath, 'step-001-learning.md'), 'Historical progress');
  assert.equal((await runtime.startup(input)).state, 'needs_reconciliation');
  assert.equal(f.pids.length, 0);
});

test('explicit owner override wins over hard routing; missing prepared cards cannot create a worktree', async t => {
  const f = await fixture(t), input = prepare(f), runtime = new Runtime(f.options);
  const checkout = join(f.dir, 'repo-feature');
  rmSync(f.step);
  await assert.rejects(runtime.startup(input), /Prepared card missing/);
  assert.equal(existsSync(checkout), false);
  writeFileSync(f.step, 'Prepared step');
  const receipt = await runtime.startup({ ...input, owner_override: 'test/pinned' });
  assert.equal(receipt.owner_model, 'test/pinned');
  await f.finished;
});

test('spec file and directory inputs share run identity; explicit start honors owner_override without a default owner', async t => {
  const f = await fixture(t), runtime = new Runtime(f.options);
  writeFileSync(join(f.packagePath, 'spec.md'), 'Spec');
  const input = { ...f.input, package: join(f.packagePath, 'spec.md'), owner_model: undefined, owner_override: 'test/pinned' };
  const receipt = await runtime.start(input);
  assert.equal(receipt.package, f.packagePath);
  assert.equal(receipt.owner_model, 'test/pinned');
  assert.equal((await runtime.start({ ...input, package: f.packagePath })).run_id, receipt.run_id);
  assert.equal(loadRun(input.package).id, receipt.run_id);
  assert.equal(loadRun(f.step).id, receipt.run_id, 'a step card names its package');
  assert.deepEqual(receipt.environment.dependency_paths, []);
  await f.finished;
});

test('repeated starts return the same run before and after completion; a second coordinator cannot take its writer lease', async t => {
  const f = await fixture(t);
  const runtime = new Runtime(f.options);
  const first = await runtime.start(f.input, '/parent/session.jsonl');
  assert.equal((await runtime.start(f.input)).run_id, first.run_id);
  await assert.rejects(() => new Runtime(f.options).start({ ...f.input, assignment_id: 'another-step' }), /run-active/);
  const completed = await f.finished;
  assert.equal(completed.state, 'completed');
  assert.equal(completed.result, 'Implemented; focused check passed.');
  assert.equal((await runtime.start(f.input)).run_id, first.run_id);
  const record = loadRun(f.packagePath);
  assert.equal(record.parent_session, '/parent/session.jsonl');
  assert.throws(() => assertLease(record), /revoked/, 'a finished run no longer holds the writer role');
  assert.match(readFileSync(join(f.packagePath, 'runtime/events.jsonl'), 'utf8'), /run_finished/);
});

test('a rejected cancellation preserves the lease and prevents replacement', async t => {
  const f = await fixture(t, 'setInterval(() => {}, 1000);');
  const runtime = new Runtime({ ...f.options, kill: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); } });
  const started = await runtime.start(f.input);
  await assert.rejects(runtime.cancel(f.packagePath, started.run_id, 10), /Cancellation unconfirmed/);
  assert.equal(loadRun(f.packagePath).state, 'blocked');
  await assert.rejects(() => runtime.start({ ...f.input, assignment_id: 'replacement' }), /run-active/);
  process.kill(-f.pids[0], 'SIGKILL');
  await f.finished;
});

test('owner exit is not completion while a descendant can still write', async t => {
  const f = await fixture(t, `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref(); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]}}));`);
  const runtime = new Runtime(f.options);
  await runtime.start(f.input);
  const outcome = await f.finished;
  assert.equal(outcome.state, 'blocked');
  assert.equal(groupAlive(f.pids[0]), true);
  assertLease(loadRun(f.packagePath));
  await assert.rejects(() => runtime.start({ ...f.input, assignment_id: 'replacement' }), /run-active/);
  const cancelled = await runtime.cancel(f.packagePath, undefined, 1000);
  assert.equal(cancelled.state, 'cancelled');
});

test('provider failure is retained as failure even with process exit zero', async t => {
  const f = await fixture(t, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'upstream timeout',content:[]}}));`);
  await new Runtime(f.options).start(f.input);
  const outcome = await f.finished;
  assert.equal(outcome.state, 'failed'); assert.equal(outcome.error, 'upstream timeout');
});

test('oversized results preserve their beginning and expose a complete readable artifact', async t => {
  const response = 'Outcome: change applied.\n' + 'x'.repeat(16000) + '\nFinal diagnostic.';
  const f = await fixture(t, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:${JSON.stringify(response)}}]}}));`);
  await new Runtime(f.options).start(f.input);
  const outcome = await f.finished;
  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.handoff.status, 'handoff_incomplete');
  assert.throws(() => assertLease(loadRun(f.packagePath)), /revoked/);
  assert.equal(outcome.result_truncated, true);
  assert.ok(outcome.result.startsWith('Outcome: change applied.'));
  assert.ok(outcome.result.length <= 8000);
  assert.match(outcome.result, /Result truncated/);
  assert.equal(readFileSync(outcome.full_result_path, 'utf8'), response);
  assert.equal(loadRun(f.packagePath).full_result_path, outcome.full_result_path);
});

test('successful recovery clears a transient provider failure while preserving the error event', async t => {
  const f = await fixture(t, `
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'upstream timeout',content:[]}}));
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Recovered and completed.'}]}}));
  `);
  await new Runtime(f.options).start(f.input);
  const outcome = await f.finished;
  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result_truncated, false);
  assert.equal(outcome.result, 'Recovered and completed.');
  assert.match(readFileSync(outcome.full_result_path.replace(/\.result\.txt$/, ''), 'utf8'), /upstream timeout/);
});

test('confirmed cancellation releases the writer lease, while a new coordinator cannot kill by stale PID', async t => {
  const f = await fixture(t, 'setInterval(() => {}, 1000);');
  const runtime = new Runtime(f.options);
  const first = await runtime.start(f.input);
  await assert.rejects(new Runtime(f.options).cancel(f.packagePath, first.run_id), /does not own the live process handle/);
  const cancelled = await runtime.cancel(f.packagePath, first.run_id, 50);
  assert.equal(cancelled.state, 'cancelled');
  assert.throws(() => assertLease(loadRun(f.packagePath)), /revoked/);
});

test('start creates the target worktree on the target branch, records it in locations.json and the run index, and writes no lock fields', async t => {
  const f = await fixture(t);
  await new Runtime(f.options).start(f.input);
  await f.finished;
  const record = loadRun(f.packagePath);
  assert.equal(record.package, f.packagePath);
  assert.equal(record.package_ref, 'demo/feature');
  assert.equal(record.step, f.step);
  assert.equal(record.checkout, join(f.dir, 'repo-feature'));
  assert.equal(record.primary, f.repo);
  assert.equal(record.coordinator_pid, process.pid);
  for (const field of ['lock', 'package_lock', 'token']) assert.equal(field in record, false, field);
  assert.equal(execFileSync('git', ['-C', record.checkout, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'spec-feature');
  assert.equal(JSON.parse(readFileSync(join(f.packagePath, 'locations.json'), 'utf8')).targets[0].worktree, record.checkout);
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'index', `${record.id}.json`), 'utf8')).package_ref, 'demo/feature');
  assert.equal(existsSync(join(f.packagePath, 'runtime/package.lock')), false);
  assert.deepEqual(readdirSync(join(f.packagePath, 'runtime')).filter(name => name.endsWith('.lock')), []);
});

test('a package ref starts the same run as its folder', async t => {
  const f = await fixture(t);
  const receipt = await new Runtime(f.options).start({ ...f.input, package: f.ref });
  assert.equal(receipt.package, f.packagePath);
  await f.finished;
});

async function twoTargets(t, steps) {
  const base = await makePackageFixture({ repos: ['repo', 'second'], targets: ['repo', 'second'] });
  t.after(() => rmSync(base.dir, { recursive: true, force: true }));
  writeFileSync(join(base.packagePath, 'spec-steps.json'), JSON.stringify({ steps }));
  const cards = steps.map(({ step }) => { const card = join(base.packagePath, `step-${String(step).padStart(3, '0')}-subspec.md`); writeFileSync(card, 'Prepared step'); return card; });
  const prompts = [];
  const fake = join(base.dir, 'fake-pi.cjs');
  writeFileSync(fake, `setTimeout(() => console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'ok'}]}})), 20);`);
  const pids = [];
  t.after(() => { for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch {} } });
  const dispatch = async (card, extra = {}) => {
    let done; const finished = new Promise(resolve => { done = resolve; });
    const runtime = new Runtime({ indexDir: join(base.dir, 'index'), notify: done, location: base.location, launchProcess: (record, role, prompt, options = {}) => {
      prompts.push({ role, prompt }); const task = launch(record, role, prompt, { command: process.execPath, prefix: [fake], ...options }); pids.push(task.child.pid); return task;
    } });
    const receipt = await runtime.start({ package: base.ref, step: card, owner_model: 'test/owner', editor_model: 'test/editor', ...extra });
    await finished;
    return { receipt, record: loadRun(base.packagePath, receipt.run_id) };
  };
  return { ...base, cards, prompts, dispatch };
}

test('a two-target package runs each step in its own target worktree and creates the other worktree only when a step needs it', async t => {
  const f = await twoTargets(t, [{ step: 1, repository: 'repo' }, { step: 2, repository: 'second' }]);
  const first = await f.dispatch(f.cards[0]);
  assert.equal(first.record.target, 'repo');
  assert.equal(first.record.checkout, join(f.dir, 'repo-feature'));
  assert.equal(first.record.primary, f.paths.repo);
  assert.deepEqual(first.record.other_targets, []);
  assert.equal(existsSync(join(f.dir, 'second-feature')), false);
  const second = await f.dispatch(f.cards[1]);
  assert.equal(second.record.target, 'second');
  assert.equal(second.record.checkout, join(f.dir, 'second-feature'));
  assert.equal(second.record.primary, f.paths.second);
  assert.deepEqual(second.record.other_targets, [{ id: 'repo', worktree: first.record.checkout }]);
  assert.equal(execFileSync('git', ['-C', second.record.checkout, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'spec-feature');
  assert.deepEqual(JSON.parse(readFileSync(join(f.packagePath, 'locations.json'), 'utf8')).targets.map(entry => entry.worktree), [first.record.checkout, second.record.checkout]);
  assert.notEqual(first.record.owner_session, second.record.owner_session);
  const secondPrompt = f.prompts.find(({ prompt }) => prompt.includes('TARGET: second')).prompt;
  assert.match(secondPrompt, new RegExp(`CHECKOUT: ${second.record.checkout}\\n`));
  assert.match(secondPrompt, new RegExp(`OTHER TARGETS \\(read-only context, never edit\\): repo=${first.record.checkout}`));
});

test('a multi-target step without a known repository is refused before any worktree or run', async t => {
  const f = await twoTargets(t, [{ step: 1 }, { step: 2, repository: 'nowhere' }]);
  await assert.rejects(f.dispatch(f.cards[0]), error => error.code === 'step-repository-missing' && Boolean(error.remedy));
  await assert.rejects(f.dispatch(f.cards[1]), error => error.code === 'step-repository-unknown' && /nowhere/.test(error.message));
  assert.equal(existsSync(join(f.dir, 'repo-feature')), false);
  assert.equal(existsSync(join(f.dir, 'second-feature')), false);
  assert.equal(existsSync(join(f.packagePath, 'runtime')), false);
});

test('a live coordinator refuses a second dispatch; a dead coordinator marks its run stale and the new run proceeds', async t => {
  const f = await fixture(t);
  const runtime = new Runtime(f.options);
  const first = await runtime.start(f.input);
  await f.finished;
  // Reopen the finished run as one whose coordinator is another live process, then a dead one.
  const reopen = pid => { const run = loadRun(f.packagePath); const open = { ...run, state: 'running', coordinator_pid: pid };
    writeFileSync(join(f.packagePath, 'runtime/run.json'), JSON.stringify(open)); writeFileSync(join(f.packagePath, 'runtime/runs', `${run.id}.json`), JSON.stringify(open)); return run.id; };
  reopen(process.ppid);
  await assert.rejects(runtime.start({ ...f.input, assignment_id: 'second' }), error => error.code === 'run-active');
  const dead = spawnSync(process.execPath, ['-e', '']);
  const staleId = reopen(dead.pid);
  const second = await runtime.start({ ...f.input, assignment_id: 'second' });
  assert.notEqual(second.run_id, staleId);
  assert.equal(JSON.parse(readFileSync(join(f.packagePath, 'runtime/runs', `${staleId}.json`), 'utf8')).state, 'stale');
  assert.equal(loadRun(f.packagePath).id, second.run_id);
  assert.equal(first.run_id, staleId);
  assert.match(readFileSync(join(f.packagePath, 'runtime/events.jsonl'), 'utf8'), /run_stale/);
  await runtime.cancel(f.packagePath, second.run_id, 1000).catch(() => {});
});

test('an editor descendant prevents a second editor and remains cancellable by its owner runtime', async t => {
  const f = await fixture(t, `if(process.env.SPEC_RUNTIME_ROLE==='owner')setInterval(()=>{},1000); else { require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref(); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]}})); }`);
  const runtime = new Runtime(f.options); await runtime.start(f.input);
  const record = loadRun(f.packagePath);
  const editor = await runEditor(record, 'Implement', undefined, f.options.launchProcess);
  assert.match(editor.error, /descendants remain alive/);
  assert.equal(editor.requires_cancellation, true);
  await assert.rejects(runEditor(record, 'Replace', undefined, f.options.launchProcess), /revoked/);
  assert.equal((await runtime.cancel(f.packagePath, undefined, 1000)).state, 'cancelled');
});

test('editor abort returns a fatal receipt when termination cannot close stdout', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  await runtime.start(f.input);
  try {
    const signal = new AbortController();
    signal.abort();
    const reply = await runEditor(loadRun(f.packagePath), 'Implement', signal.signal,
      f.options.launchProcess, { stopGroup: async () => false });
    assert.equal(reply.requires_cancellation, true);
    assert.match(reply.error, /descendants remain alive/);
    assert.throws(() => assertLease(loadRun(f.packagePath)), /revoked/);
  } finally { await runtime.cancel(f.packagePath); }
});

test('editor fatal command receipt returns before the editor process finishes', async t => {
  const f = await fixture(t, `if(process.env.SPEC_RUNTIME_ROLE==='editor')console.log(JSON.stringify({type:'tool_execution_end',result:{details:{requires_cancellation:true,error:'editor command cleanup unconfirmed'}}})); setInterval(()=>{},1000);`);
  const runtime = new Runtime(f.options);
  await runtime.start(f.input);
  try {
    const reply = await runEditor(loadRun(f.packagePath), 'Implement', undefined, f.options.launchProcess);
    assert.equal(reply.requires_cancellation, true);
    assert.throws(() => assertLease(loadRun(f.packagePath)), /revoked/);
  } finally { await runtime.cancel(f.packagePath); }
});

test('a shell timeout kills its process group before allowing further work', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); await runtime.start(f.input);
  const record = loadRun(f.packagePath);
  const output = await runCommand(record, `"${process.execPath}" -e 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'`, 0.1);
  assert.match(output.error, /timed out/);
  assert.equal(activeGroups(record).filter(group => group.role === 'command').length, 0);
  await runtime.cancel(f.packagePath, undefined, 1000);
});

test('verification preserves pipeline failures including literal nested Bash wrappers', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  await runtime.start(f.input);
  try {
    const record = loadRun(f.packagePath);
    const fingerprints = [];
    for (const command of ['false | tail -1', "bash -lc 'false | tail -1'"]) {
      const reply = await runVerification(record, command);
      assert.equal(reply.exit_code, 1);
      assert.equal(reply.sentinel_failure.complete, true);
      assert.equal(reply.sentinel_failure.exit_code, 1);
      fingerprints.push(reply.sentinel_failure);
    }
    // An unchanged checkout keeps the same structured failure.
    assert.deepEqual((await runVerification(record, 'false | tail -1')).sentinel_failure, fingerprints[0]);
  } finally { await runtime.cancel(f.packagePath); }
});

test('a leaked command group is cleaned up without revoking the owner or permitting a false success', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  await runtime.start(f.input);
  try {
    const record = loadRun(f.packagePath);
    const reply = await runVerification(record, 'sleep 30 >/dev/null 2>&1 &');
    assert.match(reply.error, /runtime stopped them/);
    assert.equal(reply.requires_cancellation, undefined);
    assertLease(record);
    assert.equal(groupAlive(record.pid), true);
    assert.equal(activeGroups(record).filter(g => g.role !== 'owner').length, 0);
    assert.equal((await runVerification(record, 'true')).exit_code, 0);
  } finally { await runtime.cancel(f.packagePath); }
});

test('unconfirmed command cleanup revokes the lease and requests coordinator cancellation', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  await runtime.start(f.input);
  try {
    const record = loadRun(f.packagePath);
    const reply = await runCommand(record, 'sleep 30 >/dev/null 2>&1 &', 5, undefined, { stopGroup: async () => false });
    assert.equal(reply.requires_cancellation, true);
    assert.throws(() => assertLease(record), /revoked/);
    await assert.rejects(runVerification(record, 'true'), /revoked/);
  } finally { await runtime.cancel(f.packagePath); }
});

test('unconfirmed timeout returns a cancellation receipt even while the command keeps stdout open', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  await runtime.start(f.input);
  try {
    const reply = await runCommand(loadRun(f.packagePath), 'sleep 30', 0.05, undefined, { stopGroup: async () => false });
    assert.equal(reply.requires_cancellation, true);
    assert.equal(reply.exit_code, null);
  } finally { await runtime.cancel(f.packagePath); }
});

test('fatal cleanup receipt wakes the coordinator and cancels the managed owner', async t => {
  const f = await fixture(t, `console.log(JSON.stringify({type:'tool_execution_end',result:{details:{requires_cancellation:true,error:'fixture cleanup unconfirmed'}}})); setInterval(()=>{},1000);`);
  const notifications = [];
  let resolveCancelled;
  const cancelled = new Promise(resolve => { resolveCancelled = resolve; });
  const runtime = new Runtime({ ...f.options, notify: value => { notifications.push(value); if (value.state === 'cancelled') resolveCancelled(value); } });
  await runtime.start(f.input);
  const result = await cancelled;
  assert.equal(result.state, 'cancelled');
  assert.match(notifications[0].error, /cleanup unconfirmed/);
  assert.equal(groupAlive(f.pids[0]), false);
});

test('fatal cleanup receipt survives a throwing observer callback', async t => {
  const f = await fixture(t, `console.log(JSON.stringify({type:'tool_execution_end',result:{details:{requires_cancellation:true,error:'fixture cleanup unconfirmed'}}})); setInterval(()=>{},1000);`);
  const notifications = [];
  let resolveCancelled;
  const cancelled = new Promise(resolve => { resolveCancelled = resolve; });
  const runtime = new Runtime({ ...f.options,
    onWorkerEvent: () => { throw new Error('observer failed'); },
    notify: value => { notifications.push(value); if (value.state === 'cancelled') resolveCancelled(value); } });
  await runtime.start(f.input);
  const result = await cancelled;
  // A throwing observer neither suppresses lifecycle cancellation nor replaces
  // the worker result.
  assert.equal(result.state, 'cancelled');
  assert.match(notifications[0].error, /cleanup unconfirmed/);
  assert.equal(groupAlive(f.pids[0]), false);
});

test('sentinel fingerprint: failed verification carries complete hashes, success omits it, and only surrounding whitespace is ignored', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  await runtime.start(f.input);
  try {
    const record = loadRun(f.packagePath);
    const HEX = /^[a-f0-9]{64}$/;
    const failed = await runVerification(record, 'printf focused; exit 7');
    assert.equal(failed.exit_code, 7);
    assert.deepEqual({ ...failed.sentinel_failure, command_sha256: 0, summary_sha256: 0, tree_digest: 0 },
      { ...failed.sentinel_failure, command_sha256: 0, summary_sha256: 0, tree_digest: 0, version: 1, exit_code: 7, complete: true });
    for (const key of ['command_sha256', 'summary_sha256', 'tree_digest']) assert.match(failed.sentinel_failure[key], HEX);

    const padded = await runVerification(record, '  printf focused; exit 7 \n');
    assert.equal(padded.sentinel_failure.command_sha256, failed.sentinel_failure.command_sha256);
    assert.equal(padded.sentinel_failure.summary_sha256, failed.sentinel_failure.summary_sha256);
    assert.equal(padded.sentinel_failure.tree_digest, failed.sentinel_failure.tree_digest);

    const spaced = await runVerification(record, 'printf  focused; exit 7');
    assert.notEqual(spaced.sentinel_failure.command_sha256, failed.sentinel_failure.command_sha256);

    const passed = await runVerification(record, 'true');
    assert.equal(passed.exit_code, 0);
    assert.equal(passed.sentinel_failure, undefined);

    writeFileSync(join(record.checkout, 'untracked-fixture.txt'), 'changed working tree\n');
    const changed = await runVerification(record, 'printf focused; exit 7');
    assert.equal(changed.sentinel_failure.complete, true);
    assert.notEqual(changed.sentinel_failure.tree_digest, failed.sentinel_failure.tree_digest);

    const loud = join(f.dir, 'loud.txt');
    writeFileSync(loud, 'x'.repeat(20000));
    const truncated = await runVerification(record, `cat '${loud}'; exit 7`);
    assert.equal(truncated.exit_code, 7);
    assert.equal(truncated.sentinel_failure.complete, false);
  } finally { await runtime.cancel(f.packagePath); }
});

test('sentinel repetition: three distinct owner spec_verify events open one incident and a replay does not advance it', async t => {
  const failure = { version: 1, command_sha256: 'a'.repeat(64), summary_sha256: 'b'.repeat(64), tree_digest: 'c'.repeat(64), complete: true, exit_code: 1 };
  const event = id => JSON.stringify({ type: 'tool_execution_end', toolName: 'spec_verify', toolCallId: id, isError: true,
    result: { details: { exit_code: 1, sentinel_failure: failure } } });
  const source = [event('verify-1'), event('verify-2'), event('verify-2'), event('verify-3')]
    .map(line => `console.log(${JSON.stringify(line)});`).join('')
    + `setTimeout(() => { console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Verification failed repeatedly.'}]}})); }, 50);`;
  const f = await fixture(t, source);
  const recorder = createVerificationRecorder();
  const runtime = new Runtime({ ...f.options, onWorkerEvent: (record, value) => recorder.observe(record, value) });
  await runtime.start(f.input);
  await f.finished;
  const snapshot = readVerificationIncidents(f.packagePath);
  assert.equal(snapshot.version, 1);
  const entries = Object.values(snapshot.assignments);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.count, 3);
  assert.equal(entry.state, 'open');
  assert.equal(entry.generation, 1);
  assert.deepEqual(entry.tool_call_ids, ['verify-1', 'verify-2', 'verify-3']);
  assert.match(entry.incident_id, /^[a-f0-9]{32}$/);
  assert.deepEqual(entry.fingerprint, { command_sha256: 'a'.repeat(64), summary_sha256: 'b'.repeat(64), tree_digest: 'c'.repeat(64) });
  await runtime.cancel(f.packagePath, undefined, 1000);
});

const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('managed verification waits for a server, preserves capture failures, and cleans up before the next writer', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  await runtime.start(f.input);
  try {
    const record = loadRun(f.packagePath), port = await freePort();
    const script = join(f.dir, 'server.cjs');
    writeFileSync(script, `require('node:http').createServer((q,s)=>s.end('ready')).listen(${port},'127.0.0.1');`);
    const server = { command: `${quote(process.execPath)} ${quote(script)}`, ready_url: `http://127.0.0.1:${port}`, readiness_timeout: 3 };
    const capture = `${quote(process.execPath)} -e ${quote(`fetch('${server.ready_url}').then(async r=>{console.log(await r.text());process.exitCode=7})`)}`;
    const reply = await runVerification(record, capture, 5, undefined, server);
    assert.equal(reply.exit_code, 7);
    assert.match(reply.output, /ready/);
    assert.equal(reply.error, undefined);
    assert.equal(activeGroups(record).filter(g => g.role !== 'owner').length, 0);
    assert.equal((await runVerification(record, 'true')).exit_code, 0);
    const unreachable = { ...server, command: 'sleep 30', readiness_timeout: 1 };
    const timeout = await runVerification(record, 'echo should-not-run', 5, undefined, unreachable);
    assert.match(timeout.error, /readiness timed out/);
    assert.equal(activeGroups(record).filter(g => g.role !== 'owner').length, 0);
    assertLease(record);
    const abort = new AbortController();
    const pending = runVerification(record, 'sleep 30', 5, abort.signal, server);
    setTimeout(() => abort.abort(), 300);
    const interrupted = await pending;
    assert.match(interrupted.error, /interrupted/i);
    assert.equal(activeGroups(record).filter(g => g.role !== 'owner').length, 0);
  } finally { await runtime.cancel(f.packagePath); }
});

test('managed verification refuses an already responding server without touching it', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  const external = createServer((q,s) => s.end('external'));
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${external.address().port}`;
  await runtime.start(f.input);
  try {
    await assert.rejects(runVerification(loadRun(f.packagePath), 'true', 3, undefined, { command: 'exit 1', ready_url: url }), /already responds/);
    assert.equal(await (await fetch(url)).text(), 'external');
  } finally { await runtime.cancel(f.packagePath); await new Promise(resolve => external.close(resolve)); }
});

test('owner verification reports failure and cannot overlap an editor or another check', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); await runtime.start(f.input);
  const record = loadRun(f.packagePath);
  const slotPath = editorSlot(record);
  // The editor keeps this slot while waiting for an owner answer.
  mkdirSync(slotPath);
  const marker = join(f.dir, 'should-not-run');
  await assert.rejects(runVerification(record, `touch '${marker}'`), /holds the writer slot/);
  assert.equal(existsSync(marker), false);
  rmSync(slotPath, { recursive: true });
  const pending = runVerification(record, 'printf "focused failure"; exit 7');
  await assert.rejects(runVerification(record, 'true'), /holds the writer slot/);
  await assert.rejects(runEditor(record, 'Overlapping edit', undefined, f.options.launchProcess), /already active/);
  const result = await pending;
  assert.equal(result.exit_code, 7);
  assert.equal(result.output, 'focused failure');
  assert.equal(existsSync(slotPath), false);
  assert.equal((await runVerification(record, 'true')).exit_code, 0);
  await runtime.cancel(f.packagePath, undefined, 1000);
});

test('the assignment deadline cancels live workers and records a terminal result', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  await new Runtime(f.options).start({ ...f.input, timeout_ms: 100 });
  assert.equal((await f.finished).state, 'cancelled');
  assert.match(readFileSync(join(f.packagePath, 'runtime/events.jsonl'), 'utf8'), /deadline_reached/);
});

test('Jev advice uses the assigned checkout, excludes writers and propagates uncertainty without retry', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); await runtime.start(f.input);
  const record = loadRun(f.packagePath);
  let finish, calls = 0;
  const input = { schema_version: 1 };
  const pending = runAdvice(record, 'verification', input, { decideTask: async (task, options) => {
    calls++; assert.equal(task, 'verification'); assert.equal(options.repo, record.checkout); assert.equal(options.input, input);
    return new Promise(resolve => { finish = resolve; });
  } });
  await assert.rejects(runEditor(record, 'overlap', undefined, f.options.launchProcess), /already active/);
  await assert.rejects(runVerification(record, 'true'), /holds the writer slot/);
  finish({ status: 'uncertain', test_pass_claim: false });
  assert.equal((await pending).status, 'uncertain'); assert.equal(calls, 1);
  assert.equal((await runVerification(record, 'true')).exit_code, 0);
  await runtime.cancel(f.packagePath, undefined, 1000);
});

test('command excerpts retain early failures and each command owns its exact raw log and exit code', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); await runtime.start(f.input);
  const record = loadRun(f.packagePath);
  const content = 'starting\n'.repeat(300) + 'Assertion failed: missing rejection\n' + 'noise\n'.repeat(5000) + 'all passed (untrusted text)\n';
  const source = join(f.dir, 'output.txt'); writeFileSync(source, content);
  const failed = await runVerification(record, `cat '${source}'; exit 7`);
  assert.equal(failed.exit_code, 7); assert.equal(failed.output_truncated, true);
  assert.match(failed.output, /Assertion failed: missing rejection/);
  assert.ok(failed.output.length < 8000);
  assert.equal(readFileSync(failed.full_output_path, 'utf8'), content);
  const next = await runVerification(record, 'printf next');
  assert.notEqual(next.full_output_path, failed.full_output_path);
  assert.equal(next.output, 'next'); assert.equal(next.exit_code, 0);
  assert.equal(readFileSync(next.full_output_path, 'utf8'), 'next');
  const empty = await runVerification(record, 'true');
  assert.equal(readFileSync(empty.full_output_path, 'utf8'), '');
  await runtime.cancel(f.packagePath, undefined, 1000);
});

test('revocation during group registration prevents the gated command from writing', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); await runtime.start(f.input);
  const record = loadRun(f.packagePath);
  const target = join(f.dir, 'should-not-exist');
  const child = spawnManaged(record, 'command', process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'bad')`], () => {
    revoke(record);
  });
  await new Promise(resolveDone => child.once('close', resolveDone));
  assert.equal(existsSync(target), false);
  assert.match(child.launchError, /revoked/);
  settleGroup(record, child.pid);
  await runtime.cancel(f.packagePath, undefined, 1000);
});

test('historical assignment IDs remain idempotent after another step and reject changed launch contracts', async t => {
  const f = await fixture(t);
  let notify;
  const runtime = new Runtime({ ...f.options, notify: value => notify(value) });
  const firstDone = new Promise(resolve => { notify = resolve; });
  const first = await runtime.start({ ...f.input, assignment_id: 'A' }); await firstDone;
  const nextDone = new Promise(resolve => { notify = resolve; });
  await runtime.start({ ...f.input, assignment_id: 'B' }); await nextDone;
  assert.equal((await runtime.start({ ...f.input, assignment_id: 'A' })).run_id, first.run_id);
  assert.equal(f.pids.length, 2);
  await assert.rejects(() => runtime.start({ ...f.input, assignment_id: 'A', owner_model: 'test/strong' }), /different launch contract/);
  // A supplied workflow_id joins the launch contract: the same assignment cannot
  // be reused under a workflow (or under a different workflow).
  await assert.rejects(() => runtime.start({ ...f.input, assignment_id: 'A', workflow_id: 'wf-contract' }), /different launch contract/);
  const workflowDone = new Promise(resolve => { notify = resolve; });
  await runtime.start({ ...f.input, assignment_id: 'C', workflow_id: 'wf-contract' }); await workflowDone;
  await assert.rejects(() => runtime.start({ ...f.input, assignment_id: 'C', workflow_id: 'wf-other' }), /different launch contract/);
});

test('concurrent cancellation requests share one terminal outcome without recreating a blocked run', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); await runtime.start(f.input);
  const results = await Promise.all([runtime.cancel(f.packagePath, undefined, 1000), runtime.cancel(f.packagePath, undefined, 1000)]);
  assert.deepEqual(results.map(value => value.state), ['cancelled', 'cancelled']);
  assert.equal(loadRun(f.packagePath).state, 'cancelled');
});

test('a bounded UI-style command can start and reap a temporary server before handing back the writer', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); await runtime.start(f.input);
  const record = loadRun(f.packagePath);
  const output = await runCommand(record, `"${process.execPath}" -e 'require("node:http").createServer((q,s)=>s.end("ok")).listen(0)' &\nserver=$!\ntrap 'kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true' EXIT\nkill -0 "$server"\nprintf 'capture fixture complete\\n'`, 5);
  assert.equal(output.exit_code, 0); assert.equal(output.error, undefined);
  assert.equal(activeGroups(record).filter(group => group.role === 'command').length, 0);
  await runtime.cancel(f.packagePath, undefined, 1000);
});


test('owner completion persists learning from real verification and releases the settled lease without accepting review', async t => {
  const f = await fixture(t, `setTimeout(() => console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Handoff submitted.'}]}})), 1000);`);
  writeFileSync(join(f.packagePath, 'spec.md'), '# Fixture');
  writeFileSync(join(f.packagePath, 'evidence-plan.json'), JSON.stringify({ gates: [{ id: 'EV-1', phase: 'merge', ownerStep: 1, required: true, rejects: ['FH-1'] }] }));
  const runtime = new Runtime(f.options); await runtime.start(f.input);
  const r = loadRun(f.packagePath);
  const check = await runVerification(r, 'echo focused-result');
  assert.ok(check.receipt_id);
  assert.ok(check.elapsed_ms >= 0);
  assert.ok(Date.parse(check.observed_at) >= Date.parse(check.started_at));
  assert.match(readFileSync(check.verification_artifact, 'utf8'), /focused-result/);
  const completion = await runCompletion(r, { outcome: 'as-specified', strategy: 'implementation-first', decisions: [], gaps: [], findings: [], introduced: [], evidence: [{ id: 'EV-1', status: 'passed', receipt_id: check.receipt_id, artifact: check.full_output_path, proof_boundary: 'command plumbing only' }] });
  assert.equal(completion.status, 'recorded');
  const finished = await f.finished;
  assert.equal(finished.handoff.status, 'recorded'); assert.match(finished.handoff.acceptance, /review/);
  assert.throws(() => assertLease(r), /revoked/);
  assert.equal(JSON.parse(readFileSync(join(f.packagePath, 'runtime/progress.json'))).runs[0].execution, 'completed');
});

test('runtime carries a validated workflow_id and stable assignment_id into the record and summary', async t => {
  const f = await fixture(t), runtime = new Runtime(f.options);
  const started = await runtime.start({ ...f.input, workflow_id: 'wf-runtime-int', assignment_id: 'assign-runtime-int' });
  assert.equal(started.workflow_id, 'wf-runtime-int');
  assert.equal(started.assignment_id, 'assign-runtime-int');
  const record = loadRun(f.packagePath, started.run_id);
  assert.equal(record.workflow_id, 'wf-runtime-int');
  assert.equal(record.assignment_id, 'assign-runtime-int');
  assert.equal(summary(record).workflow_id, 'wf-runtime-int');
  assert.equal(summary(record).assignment_id, 'assign-runtime-int');
  await f.finished;
  // The persisted record keeps the identity after completion for the terminal
  // notification fallback; it is never inferred from the run id or step.
  assert.equal(summary(loadRun(f.packagePath, started.run_id)).workflow_id, 'wf-runtime-int');

  // A malformed supplied workflow_id is refused before any run/lease side effect.
  const g = await fixture(t), runtime2 = new Runtime(g.options);
  await assert.rejects(() => runtime2.start({ ...g.input, workflow_id: 'bad id!' }), /workflow_id must be/);
  assert.equal(existsSync(join(g.packagePath, 'runtime')), false);
  assert.equal(g.pids.length, 0);
});

test('step-scoped sessions isolate steps, retain retries and leave default package reuse unchanged', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  const nextStep = join(f.packagePath, 'step-002-subspec.md'); writeFileSync(nextStep, 'Next prepared step');
  const run = async input => {
    const receipt = await runtime.start({ ...f.input, ...input });
    const record = loadRun(f.packagePath, receipt.run_id);
    assert.equal((await runtime.start({ ...f.input, ...input })).run_id, receipt.run_id);
    await runtime.cancel(f.packagePath, receipt.run_id, 1000);
    return record;
  };
  const first = await run({ assignment_id: 'first', session_scope: 'step', attempt_kind: 'implementation' });
  assert.equal(summary(first).attempt_kind, 'implementation');
  const retry = await run({ assignment_id: 'retry', session_scope: 'step', attempt_kind: 'verification-continuation' });
  const second = await run({ assignment_id: 'second', step: nextStep, session_scope: 'step' });
  assert.equal(first.editor_session, retry.editor_session);
  assert.equal(first.owner_session, retry.owner_session);
  assert.notEqual(first.editor_session, second.editor_session);
  const legacy1 = await run({ assignment_id: 'legacy1' });
  const legacy2 = await run({ assignment_id: 'legacy2', step: nextStep });
  assert.equal(legacy1.editor_session, legacy2.editor_session);
  assert.notEqual(first.editor_session, legacy1.editor_session);
  await assert.rejects(() => runtime.start({ ...f.input, assignment_id: 'first', session_scope: 'package', attempt_kind: 'implementation' }), /different launch contract/);
  const g = await fixture(t), other = new Runtime(g.options);
  await assert.rejects(() => other.start({ ...g.input, attempt_kind: 'automatic-retry' }), /Unknown attempt_kind/);
  await assert.rejects(() => other.start({ ...g.input, session_scope: 'discard' }), /session_scope/);
  assert.equal(g.pids.length, 0);
  assert.equal(existsSync(join(g.packagePath, 'runtime')), false);
});

test('clarification redispatch reuses retained sessions and refuses the stale attempt ID', async t => {
  const f = await fixture(t, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:process.argv.slice(2).join(' ')}]}}));`);
  let settle;
  const runtime = new Runtime({ ...f.options, notify: value => settle?.(value) });
  const complete = async input => {
    const finished = new Promise(resolve => { settle = resolve; });
    const receipt = await runtime.start({ ...f.input, ...input });
    await finished;
    return loadRun(f.packagePath, receipt.run_id);
  };
  const first = await complete({ assignment_id: 'startup', instructions: 'Original direction' });
  assert.equal(first.state, 'completed');
  assert.ok(first.result.includes(`--session ${first.owner_session}`));
  assert.ok(first.result.includes('Original direction'));
  const runsDir = join(f.packagePath, 'runtime', 'runs');
  const runsBefore = readdirSync(runsDir);
  await assert.rejects(() => runtime.start({ ...f.input, assignment_id: 'startup', instructions: 'changed' }), /different launch contract/);
  assert.equal(f.pids.length, 1);
  assert.deepEqual(readdirSync(runsDir), runsBefore);
  const second = await complete({ assignment_id: 'startup-clarified-1', attempt_kind: 'implementation', instructions: 'Clarification: Q: which helper A: existing one' });
  assert.notEqual(second.id, first.id);
  assert.equal(second.owner_session, first.owner_session);
  assert.equal(second.editor_session, first.editor_session);
  assert.ok(second.result.includes(`--session ${second.owner_session}`));
  assert.ok(second.result.includes('Clarification: Q: which helper A: existing one'));
  assert.equal(f.pids.length, 2);
});

test('sentinel cancellation: assertIdleWriter rejects a claimed editor slot while the lease is valid', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options);
  const started = await runtime.start(f.input);
  const record = loadRun(f.packagePath, started.run_id);
  assertIdleWriter(record);
  const slot = editorSlot(record);
  mkdirSync(slot);
  assert.throws(() => assertIdleWriter(record), /editor or verification/);
  rmSync(slot, { recursive: true, force: true });
  assertIdleWriter(record);
  await runtime.cancel(f.packagePath, started.run_id, 1000);
});

test('editor latches deterministic model failure across retained records without revoking lease or retrying', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options);
  await runtime.start({ ...f.input, editor_model: 'vendor/team/exact-model:high' });
  let launches = 0;
  const failedLaunch = () => {
    launches++;
    return { child: { pid: undefined }, done: Promise.resolve({ error: '404 This model cannot be used with the chat/completions endpoint (adapter DeepInfraBatchAdapter)' }) };
  };
  try {
    const first = await runEditor(loadRun(f.packagePath), 'Apply edits', undefined, failedLaunch);
    assert.equal(first.coordinator_action_required, true);
    assert.match(first.error, /vendor\/team\/exact-model:high/);
    const repeated = await runEditor(loadRun(f.packagePath), 'Try again', undefined, failedLaunch);
    assert.equal(repeated.coordinator_action_required, true);
    assert.equal(launches, 1);
    assertLease(loadRun(f.packagePath));
    assert.equal(existsSync(editorSlot(loadRun(f.packagePath))), false);
    const corrected = { ...loadRun(f.packagePath), editor_model: 'vendor/team/corrected-model:high' };
    await runEditor(corrected, 'Corrected selector', undefined, () => ({ child: { pid: undefined }, done: Promise.resolve({ result: 'done' }) }));
  } finally { await runtime.cancel(f.packagePath); }
});

test('editor transient and undiagnosed HTTP errors remain retryable', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); await runtime.start(f.input);
  let launches = 0;
  try {
    for (const error of ['404 Not Found', 'ECONNRESET', '429 Too Many Requests']) {
      const launchFailure = () => { launches++; return { child: { pid: undefined }, done: Promise.resolve({ error }) }; };
      assert.equal((await runEditor(loadRun(f.packagePath), 'Retry packet', undefined, launchFailure)).error, error);
    }
    assert.equal(launches, 3);
    assertLease(loadRun(f.packagePath));
  } finally { await runtime.cancel(f.packagePath); }
});

test('launch passes exact nested model and thinking separately and captures selector mismatch diagnostics', async t => {
  const f = await fixture(t, `if(process.env.SPEC_RUNTIME_ROLE==='owner')setInterval(()=>{},1000); else { console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(process.argv.slice(2))}]}})); }`);
  const runtime = new Runtime(f.options); await runtime.start({ ...f.input, editor_model: 'openrouter/deepseek/deepseek-v4.1-flash:high' });
  try {
    const record = loadRun(f.packagePath);
    const reply = await runEditor(record, 'Apply', undefined, f.options.launchProcess);
    const args = JSON.parse(reply.result);
    assert.equal(args[args.indexOf('--provider') + 1], 'openrouter');
    assert.equal(args[args.indexOf('--model') + 1], 'deepseek/deepseek-v4.1-flash');
    assert.equal(args[args.indexOf('--thinking') + 1], 'high');
    const mismatchScript = join(f.dir, 'mismatch.cjs');
    writeFileSync(mismatchScript, "process.stderr.write('SPEC_MODEL_SELECTOR_MISMATCH: requested exact model; selected variant\\n');process.exitCode=78;");
    const failure = await runEditor(record, 'Apply', undefined, (run, role, prompt) => launch(run, role, prompt, { command: process.execPath, prefix: [mismatchScript] }));
    assert.equal(failure.coordinator_action_required, true);
    assert.match(failure.error, /selected variant/);
    assertLease(record);
  } finally { await runtime.cancel(f.packagePath); }
});
