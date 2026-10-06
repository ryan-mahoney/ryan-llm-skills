import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Runtime, launch, loadRun, groupAlive, runEditor, runCommand, runVerification, runCompletion, runAdvice, activeGroups, spawnManaged, settleGroup, assertLease, canonicalPackage } from './runtime.mjs';

function fixture(t, source) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'spec-runtime-test-')));
  const repo = join(dir, 'repo'); mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Runtime Test'); git('config', 'user.email', 'runtime@example.invalid');
  writeFileSync(join(repo, 'README'), 'fixture\n'); git('add', 'README'); git('commit', '-qm', 'Initial fixture');
  const packagePath = join(repo, '.specs/feature'); mkdirSync(packagePath, { recursive: true });
  const step = join(packagePath, 'step-001-subspec.md'); writeFileSync(step, 'Prepared step');
  const fake = join(dir, 'fake-pi.cjs');
  writeFileSync(fake, source || `setTimeout(() => { console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Implemented; focused check passed.'}]}})); }, 50);`);
  const pids = [];
  let notified;
  const finished = new Promise(resolve => { notified = resolve; });
  const options = { indexDir: join(dir, 'index'), notify: notified, launchProcess: (record, role, prompt) => {
    const task = launch(record, role, prompt, { command: process.execPath, prefix: [fake] }); pids.push(task.child.pid); return task;
  } };
  t.after(() => { for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch {} } rmSync(dir, { recursive: true, force: true }); });
  return { dir, repo, packagePath, step, options, finished, pids, input: { package: packagePath, step, checkout: repo, owner_model: 'test/owner', editor_model: 'test/editor' } };
}

function prepare(f, difficulty = 'hard') {
  for (const file of ['context.md', 'spec.md', 'spec-prepare.md']) writeFileSync(join(f.packagePath, file), 'Prepared and validated');
  writeFileSync(join(f.repo, '.specs/project-context.md'), 'Project authority');
  writeFileSync(join(f.packagePath, 'evidence-plan.json'), '{}');
  writeFileSync(join(f.packagePath, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1, difficulty }] }));
  const { step, ...input } = f.input;
  return { ...input, strong_owner_model: 'test/strong' };
}

test('prepared startup routes hard work, returns retained progress, and never equates worker completion with acceptance', async t => {
  const f = fixture(t), input = prepare(f), runtime = new Runtime(f.options);
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
  const f = fixture(t), input = prepare(f), runtime = new Runtime(f.options);
  mkdirSync(join(f.packagePath, 'inbox'));
  writeFileSync(join(f.packagePath, 'inbox/hold.md'), 'Hold implementation');
  assert.equal((await runtime.startup(input)).state, 'needs_intake');
  rmSync(join(f.packagePath, 'inbox/hold.md'));
  writeFileSync(join(f.packagePath, 'step-001-learning.md'), 'Historical progress');
  assert.equal((await runtime.startup(input)).state, 'needs_reconciliation');
  assert.equal(f.pids.length, 0);
});

test('explicit owner override wins over hard routing; missing prepared cards cannot create a worktree', async t => {
  const f = fixture(t), input = prepare(f), runtime = new Runtime(f.options);
  const checkout = join(f.dir, 'new-checkout');
  rmSync(f.step);
  await assert.rejects(runtime.startup({ ...input, checkout }), /Prepared card missing/);
  assert.equal(existsSync(checkout), false);
  writeFileSync(f.step, 'Prepared step');
  const receipt = await runtime.startup({ ...input, owner_override: 'test/pinned' });
  assert.equal(receipt.owner_model, 'test/pinned');
  await f.finished;
});

test('spec file and directory inputs share run identity; explicit start honors owner_override without a default owner', async t => {
  const f = fixture(t), runtime = new Runtime(f.options);
  writeFileSync(join(f.packagePath, 'spec.md'), 'Spec');
  const input = { ...f.input, package: join(f.packagePath, 'spec.md'), owner_model: undefined, owner_override: 'test/pinned' };
  const receipt = runtime.start(input);
  assert.equal(receipt.package, f.packagePath);
  assert.equal(receipt.owner_model, 'test/pinned');
  assert.equal(runtime.start({ ...input, package: f.packagePath }).run_id, receipt.run_id);
  assert.equal(loadRun(input.package).id, receipt.run_id);
  assert.throws(() => canonicalPackage(f.step), /directory or its spec.md/);
  assert.deepEqual(receipt.environment.dependency_paths, []);
  await f.finished;
});

test('repeated starts return the same run before and after completion; a second coordinator cannot take its writer lease', async t => {
  const f = fixture(t);
  const runtime = new Runtime(f.options);
  const first = runtime.start(f.input, '/parent/session.jsonl');
  assert.equal(runtime.start(f.input).run_id, first.run_id);
  assert.throws(() => new Runtime(f.options).start({ ...f.input, assignment_id: 'another-step' }), /Writer already reserved/);
  const completed = await f.finished;
  assert.equal(completed.state, 'completed');
  assert.equal(completed.result, 'Implemented; focused check passed.');
  assert.equal(runtime.start(f.input).run_id, first.run_id);
  const record = loadRun(f.packagePath);
  assert.equal(record.parent_session, '/parent/session.jsonl');
  assert.equal(existsSync(record.lock), false);
  assert.match(readFileSync(join(f.packagePath, 'runtime/events.jsonl'), 'utf8'), /run_finished/);
});

test('a rejected cancellation preserves the lease and prevents replacement', async t => {
  const f = fixture(t, 'setInterval(() => {}, 1000);');
  const runtime = new Runtime({ ...f.options, kill: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); } });
  const started = runtime.start(f.input);
  await assert.rejects(runtime.cancel(f.packagePath, started.run_id, 10), /Cancellation unconfirmed/);
  assert.equal(loadRun(f.packagePath).state, 'blocked');
  assert.throws(() => runtime.start({ ...f.input, assignment_id: 'replacement' }), /Writer already reserved/);
  process.kill(-f.pids[0], 'SIGKILL');
  await f.finished;
});

test('owner exit is not completion while a descendant can still write', async t => {
  const f = fixture(t, `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref(); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]}}));`);
  const runtime = new Runtime(f.options);
  runtime.start(f.input);
  const outcome = await f.finished;
  assert.equal(outcome.state, 'blocked');
  assert.equal(groupAlive(f.pids[0]), true);
  assert.equal(existsSync(loadRun(f.packagePath).lock), true);
  assert.throws(() => runtime.start({ ...f.input, assignment_id: 'replacement' }), /Writer already reserved/);
  const cancelled = await runtime.cancel(f.packagePath, undefined, 1000);
  assert.equal(cancelled.state, 'cancelled');
});

test('provider failure is retained as failure even with process exit zero', async t => {
  const f = fixture(t, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'upstream timeout',content:[]}}));`);
  new Runtime(f.options).start(f.input);
  const outcome = await f.finished;
  assert.equal(outcome.state, 'failed'); assert.equal(outcome.error, 'upstream timeout');
});

test('oversized results preserve their beginning and expose a complete readable artifact', async t => {
  const response = 'Outcome: change applied.\n' + 'x'.repeat(16000) + '\nFinal diagnostic.';
  const f = fixture(t, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:${JSON.stringify(response)}}]}}));`);
  new Runtime(f.options).start(f.input);
  const outcome = await f.finished;
  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.handoff.status, 'handoff_incomplete');
  assert.equal(existsSync(loadRun(f.packagePath).lock), false);
  assert.equal(outcome.result_truncated, true);
  assert.ok(outcome.result.startsWith('Outcome: change applied.'));
  assert.ok(outcome.result.length <= 8000);
  assert.match(outcome.result, /Result truncated/);
  assert.equal(readFileSync(outcome.full_result_path, 'utf8'), response);
  assert.equal(loadRun(f.packagePath).full_result_path, outcome.full_result_path);
});

test('successful recovery clears a transient provider failure while preserving the error event', async t => {
  const f = fixture(t, `
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'upstream timeout',content:[]}}));
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Recovered and completed.'}]}}));
  `);
  new Runtime(f.options).start(f.input);
  const outcome = await f.finished;
  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result_truncated, false);
  assert.equal(outcome.result, 'Recovered and completed.');
  assert.match(readFileSync(outcome.full_result_path.replace(/\.result\.txt$/, ''), 'utf8'), /upstream timeout/);
});

test('confirmed cancellation releases the writer lease, while a new coordinator cannot kill by stale PID', async t => {
  const f = fixture(t, 'setInterval(() => {}, 1000);');
  const runtime = new Runtime(f.options);
  const first = runtime.start(f.input);
  await assert.rejects(new Runtime(f.options).cancel(f.packagePath, first.run_id), /does not own the live process handle/);
  const cancelled = await runtime.cancel(f.packagePath, first.run_id, 50);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(existsSync(loadRun(f.packagePath).lock), false);
});

test('omitting checkout creates a linked worktree while retaining canonical spec paths', async t => {
  const f = fixture(t);
  new Runtime(f.options).start({ ...f.input, checkout: undefined });
  await f.finished;
  const record = loadRun(f.packagePath);
  assert.equal(record.package, f.packagePath);
  assert.equal(record.step, f.step);
  assert.equal(record.checkout, join(f.dir, 'repo-feature'));
  assert.equal(existsSync(join(record.checkout, '.specs')), false);
});

test('an editor descendant prevents a second editor and remains cancellable by its owner runtime', async t => {
  const f = fixture(t, `if(process.env.SPEC_RUNTIME_ROLE==='owner')setInterval(()=>{},1000); else { require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref(); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]}})); }`);
  const runtime = new Runtime(f.options); runtime.start(f.input);
  const record = loadRun(f.packagePath);
  const editor = await runEditor(record, 'Implement', undefined, f.options.launchProcess);
  assert.match(editor.error, /descendants remain alive/);
  assert.equal(editor.requires_cancellation, true);
  await assert.rejects(runEditor(record, 'Replace', undefined, f.options.launchProcess), /revoked/);
  assert.equal((await runtime.cancel(f.packagePath, undefined, 1000)).state, 'cancelled');
});

test('editor abort returns a fatal receipt when termination cannot close stdout', async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  runtime.start(f.input);
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
  const f = fixture(t, `if(process.env.SPEC_RUNTIME_ROLE==='editor')console.log(JSON.stringify({type:'tool_execution_end',result:{details:{requires_cancellation:true,error:'editor command cleanup unconfirmed'}}})); setInterval(()=>{},1000);`);
  const runtime = new Runtime(f.options);
  runtime.start(f.input);
  try {
    const reply = await runEditor(loadRun(f.packagePath), 'Implement', undefined, f.options.launchProcess);
    assert.equal(reply.requires_cancellation, true);
    assert.throws(() => assertLease(loadRun(f.packagePath)), /revoked/);
  } finally { await runtime.cancel(f.packagePath); }
});

test('a shell timeout kills its process group before allowing further work', async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); runtime.start(f.input);
  const record = loadRun(f.packagePath);
  const output = await runCommand(record, `"${process.execPath}" -e 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'`, 0.1);
  assert.match(output.error, /timed out/);
  assert.equal(activeGroups(record).filter(group => group.role === 'command').length, 0);
  await runtime.cancel(f.packagePath, undefined, 1000);
});

test('verification preserves pipeline failures including literal nested Bash wrappers', async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  runtime.start(f.input);
  try {
    const record = loadRun(f.packagePath);
    for (const command of ['false | tail -1', "bash -lc 'false | tail -1'"])
      assert.equal((await runVerification(record, command)).exit_code, 1);
  } finally { await runtime.cancel(f.packagePath); }
});

test('a leaked command group is cleaned up without revoking the owner or permitting a false success', async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  runtime.start(f.input);
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
  const f = fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  runtime.start(f.input);
  try {
    const record = loadRun(f.packagePath);
    const reply = await runCommand(record, 'sleep 30 >/dev/null 2>&1 &', 5, undefined, { stopGroup: async () => false });
    assert.equal(reply.requires_cancellation, true);
    assert.throws(() => assertLease(record), /revoked/);
    await assert.rejects(runVerification(record, 'true'), /revoked/);
  } finally { await runtime.cancel(f.packagePath); }
});

test('unconfirmed timeout returns a cancellation receipt even while the command keeps stdout open', async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  runtime.start(f.input);
  try {
    const reply = await runCommand(loadRun(f.packagePath), 'sleep 30', 0.05, undefined, { stopGroup: async () => false });
    assert.equal(reply.requires_cancellation, true);
    assert.equal(reply.exit_code, null);
  } finally { await runtime.cancel(f.packagePath); }
});

test('fatal cleanup receipt wakes the coordinator and cancels the managed owner', async t => {
  const f = fixture(t, `console.log(JSON.stringify({type:'tool_execution_end',result:{details:{requires_cancellation:true,error:'fixture cleanup unconfirmed'}}})); setInterval(()=>{},1000);`);
  const notifications = [];
  let resolveCancelled;
  const cancelled = new Promise(resolve => { resolveCancelled = resolve; });
  const runtime = new Runtime({ ...f.options, notify: value => { notifications.push(value); if (value.state === 'cancelled') resolveCancelled(value); } });
  runtime.start(f.input);
  const result = await cancelled;
  assert.equal(result.state, 'cancelled');
  assert.match(notifications[0].error, /cleanup unconfirmed/);
  assert.equal(groupAlive(f.pids[0]), false);
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
  const f = fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  runtime.start(f.input);
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
  const f = fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  const external = createServer((q,s) => s.end('external'));
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${external.address().port}`;
  runtime.start(f.input);
  try {
    await assert.rejects(runVerification(loadRun(f.packagePath), 'true', 3, undefined, { command: 'exit 1', ready_url: url }), /already responds/);
    assert.equal(await (await fetch(url)).text(), 'external');
  } finally { await runtime.cancel(f.packagePath); await new Promise(resolve => external.close(resolve)); }
});

test('owner verification reports failure and cannot overlap an editor or another check', async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); runtime.start(f.input);
  const record = loadRun(f.packagePath);
  const editorSlot = join(record.lock, 'editor');
  // The editor keeps this slot while waiting for an owner answer.
  mkdirSync(editorSlot);
  const marker = join(f.dir, 'should-not-run');
  await assert.rejects(runVerification(record, `touch '${marker}'`), /active editor/);
  assert.equal(existsSync(marker), false);
  rmSync(editorSlot, { recursive: true });
  const pending = runVerification(record, 'printf "focused failure"; exit 7');
  await assert.rejects(runVerification(record, 'true'), /active editor or verification/);
  await assert.rejects(runEditor(record, 'Overlapping edit', undefined, f.options.launchProcess), /already active/);
  const result = await pending;
  assert.equal(result.exit_code, 7);
  assert.equal(result.output, 'focused failure');
  assert.equal(existsSync(editorSlot), false);
  assert.equal((await runVerification(record, 'true')).exit_code, 0);
  await runtime.cancel(f.packagePath, undefined, 1000);
});

test('the assignment deadline cancels live workers and records a terminal result', async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);');
  new Runtime(f.options).start({ ...f.input, timeout_ms: 100 });
  assert.equal((await f.finished).state, 'cancelled');
  assert.match(readFileSync(join(f.packagePath, 'runtime/events.jsonl'), 'utf8'), /deadline_reached/);
});

test('Jev advice uses the assigned checkout, excludes writers and propagates uncertainty without retry', async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); runtime.start(f.input);
  const record = loadRun(f.packagePath);
  let finish, calls = 0;
  const input = { schema_version: 1 };
  const pending = runAdvice(record, 'verification', input, { decideTask: async (task, options) => {
    calls++; assert.equal(task, 'verification'); assert.equal(options.repo, record.checkout); assert.equal(options.input, input);
    return new Promise(resolve => { finish = resolve; });
  } });
  await assert.rejects(runEditor(record, 'overlap', undefined, f.options.launchProcess), /already active/);
  await assert.rejects(runVerification(record, 'true'), /active editor or verification/);
  finish({ status: 'uncertain', test_pass_claim: false });
  assert.equal((await pending).status, 'uncertain'); assert.equal(calls, 1);
  assert.equal((await runVerification(record, 'true')).exit_code, 0);
  await runtime.cancel(f.packagePath, undefined, 1000);
});

test('command excerpts retain early failures and each command owns its exact raw log and exit code', async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); runtime.start(f.input);
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
  const f = fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); runtime.start(f.input);
  const record = loadRun(f.packagePath);
  const target = join(f.dir, 'should-not-exist');
  const child = spawnManaged(record, 'command', process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'bad')`], () => {
    const file = join(record.lock, 'lease.json');
    const lease = JSON.parse(readFileSync(file, 'utf8')); writeFileSync(file, JSON.stringify({ ...lease, revoked: true }));
  });
  await new Promise(resolveDone => child.once('close', resolveDone));
  assert.equal(existsSync(target), false);
  assert.match(child.launchError, /revoked/);
  settleGroup(record, child.pid);
  await runtime.cancel(f.packagePath, undefined, 1000);
});

test('historical assignment IDs remain idempotent after another step and reject changed launch contracts', async t => {
  const f = fixture(t);
  let notify;
  const runtime = new Runtime({ ...f.options, notify: value => notify(value) });
  const firstDone = new Promise(resolve => { notify = resolve; });
  const first = runtime.start({ ...f.input, assignment_id: 'A' }); await firstDone;
  const nextDone = new Promise(resolve => { notify = resolve; });
  runtime.start({ ...f.input, assignment_id: 'B' }); await nextDone;
  assert.equal(runtime.start({ ...f.input, assignment_id: 'A' }).run_id, first.run_id);
  assert.equal(f.pids.length, 2);
  assert.throws(() => runtime.start({ ...f.input, assignment_id: 'A', owner_model: 'test/strong' }), /different launch contract/);
});

test('concurrent cancellation requests share one terminal outcome without recreating a blocked run', async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); runtime.start(f.input);
  const results = await Promise.all([runtime.cancel(f.packagePath, undefined, 1000), runtime.cancel(f.packagePath, undefined, 1000)]);
  assert.deepEqual(results.map(value => value.state), ['cancelled', 'cancelled']);
  assert.equal(loadRun(f.packagePath).state, 'cancelled');
});

test('a bounded UI-style command can start and reap a temporary server before handing back the writer', async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);');
  const runtime = new Runtime(f.options); runtime.start(f.input);
  const record = loadRun(f.packagePath);
  const output = await runCommand(record, `"${process.execPath}" -e 'require("node:http").createServer((q,s)=>s.end("ok")).listen(0)' &\nserver=$!\ntrap 'kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true' EXIT\nkill -0 "$server"\nprintf 'capture fixture complete\\n'`, 5);
  assert.equal(output.exit_code, 0); assert.equal(output.error, undefined);
  assert.equal(activeGroups(record).filter(group => group.role === 'command').length, 0);
  await runtime.cancel(f.packagePath, undefined, 1000);
});


test('owner completion persists learning from real verification and releases the settled lease without accepting review', async t => {
  const f = fixture(t, `setTimeout(() => console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Handoff submitted.'}]}})), 1000);`);
  writeFileSync(join(f.packagePath, 'spec.md'), '# Fixture');
  writeFileSync(join(f.packagePath, 'evidence-plan.json'), JSON.stringify({ gates: [{ id: 'EV-1', phase: 'merge', ownerStep: 1, required: true, rejects: ['FH-1'] }] }));
  const runtime = new Runtime(f.options); runtime.start(f.input);
  const r = loadRun(f.packagePath);
  const check = await runVerification(r, 'echo focused-result');
  assert.ok(check.receipt_id);
  const completion = await runCompletion(r, { outcome: 'as-specified', strategy: 'implementation-first', decisions: [], gaps: [], findings: [], introduced: [], evidence: [{ id: 'EV-1', status: 'passed', receipt_id: check.receipt_id, artifact: check.full_output_path, proof_boundary: 'command plumbing only' }] });
  assert.equal(completion.status, 'recorded');
  const finished = await f.finished;
  assert.equal(finished.handoff.status, 'recorded'); assert.match(finished.handoff.acceptance, /review/);
  assert.equal(existsSync(r.lock), false);
  assert.equal(JSON.parse(readFileSync(join(f.packagePath, 'runtime/progress.json'))).runs[0].execution, 'completed');
});
