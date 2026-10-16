import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, chmodSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Runtime, launch, loadRun, summary, groupAlive, runEditor, runCommand, runVerification, runCompletion, runAdvice, activeGroups, spawnManaged, settleGroup, assertLease, assertIdleWriter, editorSlot, revoke, event, assertManagedModel, waveSiblingMatches, waveSiblingConflict } from './runtime.mjs';
import { createVerificationRecorder, readVerificationIncidents } from './sentinel.mjs';
import { makePackageFixture } from './package-fixture.mjs';
import { createOwnership } from './ownership.mjs';
import { runCapabilityProbe } from './overlay.mjs';

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
  const runtimes = new Set();
  // Cancel every runtime this fixture's tests created BEFORE removing the
  // directory: a retained deadline timer owns the run record and would outlive
  // an rm, firing against a deleted package.
  t.after(async () => {
    for (const runtime of runtimes) {
      try { await Promise.allSettled([...runtime.active.values()].map(({ record }) => runtime.cancel(record.package, record.id))); } catch {}
    }
    for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...base, step, options, finished, pids, runtimes, input: { package: packagePath, step, owner_model: 'test/owner', editor_model: 'test/editor' } };
}

function prepare(f, difficulty = 'hard') {
  for (const file of ['context.md', 'spec.md', 'spec-prepare.md']) writeFileSync(join(f.packagePath, file), 'Prepared and validated');
  writeFileSync(f.locations.project_context, 'Project authority');
  writeFileSync(join(f.packagePath, 'evidence-plan.json'), '{}');
  writeFileSync(join(f.packagePath, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1, difficulty }] }));
  const { step, ...input } = f.input;
  return { ...input, strong_owner_model: 'test/strong' };
}

test('settled print worker with leaked handles is stopped before its result releases the run', async t => {
  const f = await fixture(t, `
    process.on('SIGTERM', () => {});
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Retained handoff'}]}}));
    console.log(JSON.stringify({type:'agent_settled',aborted:false}));
    setInterval(() => {}, 1000);
  `);
  const launchProcess = f.options.launchProcess;
  f.options.launchProcess = (r, role, prompt, opts) => launchProcess(r, role, prompt, { ...opts, shutdownGraceMs: 25 });
  const runtime = new Runtime(f.options);
  const started = await runtime.start(f.input);
  const result = await f.finished;
  assert.equal(result.state, 'completed');
  assert.equal(result.shutdown_cleanup, true);
  assert.equal(loadRun(f.packagePath, started.run_id).shutdown_cleanup, true);
  assert.equal(loadRun(f.packagePath, started.run_id).result, 'Retained handoff');
  assert.equal(groupAlive(f.pids[0]), false);
  assert.equal(result.handoff.status, 'handoff_incomplete', 'shutdown is not acceptance or a fabricated handoff');
});

test('a final response without native settlement never triggers shutdown cleanup', async t => {
  const f = await fixture(t, `
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Still processing'}]}}));
    setTimeout(() => process.exit(0), 100);
  `);
  const launchProcess = f.options.launchProcess;
  f.options.launchProcess = (r, role, prompt, opts) => launchProcess(r, role, prompt, { ...opts, shutdownGraceMs: 5 });
  const runtime = new Runtime(f.options);
  await runtime.start(f.input); await f.finished;
  assert.equal(loadRun(f.packagePath).shutdown_cleanup, false);
});

test('settled editor cleanup preserves its live owner and returns the retained result', async t => {
  const f = await fixture(t, `
    if(process.env.SPEC_RUNTIME_ROLE === 'editor') {
      console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Edits complete'}]}}));
      console.log(JSON.stringify({type:'agent_settled',aborted:false}));
    }
    setInterval(() => {}, 1000);
  `);
  const launchProcess = f.options.launchProcess;
  f.options.launchProcess = (r, role, prompt, opts) => launchProcess(r, role, prompt, { ...opts, shutdownGraceMs: 25 });
  const runtime = new Runtime(f.options);
  await runtime.start(f.input);
  const record = loadRun(f.packagePath);
  const result = await runEditor(record, 'Edit one function', undefined, f.options.launchProcess);
  assert.equal(result.error, undefined);
  assert.equal(result.result, 'Edits complete');
  assert.equal(groupAlive(f.pids[0]), true);
  assert.equal(groupAlive(f.pids[1]), false);
  await runtime.cancel(f.packagePath, record.id);
});

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
  assert.match(readFileSync(f.step, 'utf8'), /<!-- spec-location:begin -->[\s\S]*Prepared step/, 'a card written after package creation is stamped on first dispatch');
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

// Run alone: node --test --test-name-pattern='default step sessions' runtime.test.mjs
test('default step sessions isolate steps, retain retries and support explicit package reuse', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  const nextStep = join(f.packagePath, 'step-002-subspec.md'); writeFileSync(nextStep, 'Next prepared step');
  const run = async input => {
    const receipt = await runtime.start({ ...f.input, ...input });
    const record = loadRun(f.packagePath, receipt.run_id);
    assert.equal((await runtime.start({ ...f.input, ...input })).run_id, receipt.run_id);
    await runtime.cancel(f.packagePath, receipt.run_id, 1000);
    return record;
  };
  const first = await run({ assignment_id: 'first', attempt_kind: 'implementation' });
  assert.equal(first.session_scope, 'step');
  assert.equal(summary(first).attempt_kind, 'implementation');
  const retry = await run({ assignment_id: 'retry', attempt_kind: 'verification-continuation' });
  const second = await run({ assignment_id: 'second', step: nextStep });
  assert.equal(first.editor_session, retry.editor_session);
  assert.equal(first.owner_session, retry.owner_session);
  assert.notEqual(first.editor_session, second.editor_session);
  const legacy1 = await run({ assignment_id: 'legacy1', session_scope: 'package' });
  assert.equal((await runtime.start({ ...f.input, assignment_id: 'legacy1' })).run_id, legacy1.id);
  const packageRetry = await run({ assignment_id: 'legacy-repair', attempt_kind: 'review-repair' });
  assert.equal(packageRetry.session_scope, 'package');
  assert.equal(packageRetry.owner_session, legacy1.owner_session);
  const legacy2 = await run({ assignment_id: 'legacy2', step: nextStep, session_scope: 'package' });
  assert.equal(legacy1.editor_session, legacy2.editor_session);
  assert.notEqual(first.editor_session, legacy1.editor_session);
  await assert.rejects(() => runtime.start({ ...f.input, assignment_id: 'first', session_scope: 'package', attempt_kind: 'implementation' }), /different launch contract/);
  const g = await fixture(t), other = new Runtime(g.options);
  await assert.rejects(() => other.start({ ...g.input, attempt_kind: 'automatic-retry' }), /Unknown attempt_kind/);
  await assert.rejects(() => other.start({ ...g.input, session_scope: 'discard' }), /session_scope/);
  assert.equal(g.pids.length, 0);
  assert.equal(existsSync(join(g.packagePath, 'runtime')), false);
});

// Run alone: node --test --test-name-pattern='legacy package assignments' runtime.test.mjs
test('legacy package assignments remain idempotent without rewriting their sessions', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  const receipt = await runtime.start({ ...f.input, assignment_id: 'legacy', session_scope: 'package' });
  await runtime.cancel(f.packagePath, receipt.run_id, 1000);
  const dir = join(f.packagePath, 'runtime/assignments');
  const file = join(dir, readdirSync(dir)[0]);
  const assignment = JSON.parse(readFileSync(file));
  const parts = JSON.parse(assignment.contract); parts.pop();
  assignment.contract = JSON.stringify(parts); writeFileSync(file, JSON.stringify(assignment));
  const manifest = join(f.packagePath, 'runtime/runs', `${receipt.run_id}.json`);
  const record = JSON.parse(readFileSync(manifest)); delete record.session_scope;
  writeFileSync(manifest, JSON.stringify(record));
  const before = readFileSync(manifest, 'utf8');
  const resumed = await runtime.start({ ...f.input, assignment_id: 'legacy' });
  assert.equal(resumed.run_id, receipt.run_id);
  assert.equal(resumed.session_scope, 'package');
  assert.equal(resumed.owner_session, record.owner_session);
  assert.equal((await runtime.start({ ...f.input, assignment_id: 'legacy', session_scope: 'package' })).run_id, receipt.run_id);
  assert.equal(readFileSync(manifest, 'utf8'), before);
  assert.equal(f.pids.length, 1);
  await assert.rejects(() => runtime.start({ ...f.input, assignment_id: 'legacy', session_scope: 'step' }), /different launch contract/);
  const repair = await runtime.start({ ...f.input, assignment_id: 'legacy-retry', attempt_kind: 'implementation-repair' });
  assert.equal(repair.session_scope, 'package');
  assert.equal(repair.owner_session, record.owner_session);
  await runtime.cancel(f.packagePath, repair.run_id, 1000);
});

// Run alone: node --test --test-name-pattern='CURRENT handoff' runtime.test.mjs
test('CURRENT handoff carries bounded latest prerequisite facts and preserves explicit instructions', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);');
  const dir = join(f.packagePath, 'runtime/runs'); mkdirSync(dir, { recursive: true });
  const prerequisite = join(f.packagePath, 'step-000-subspec.md');
  writeFileSync(f.step, 'Prerequisites: steps 0–0');
  writeFileSync(join(dir, 'corrupt.json'), '{');
  for (const [id, started_at, gap] of [['old', '2026-01-01', 'historical blocker'], ['new', '2026-01-02', 'current obligation']]) {
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, step: prerequisite, state: 'completed', started_at }));
    writeFileSync(join(dir, `${id}-completion.json`), JSON.stringify({ learning: { outcome: 'checkpoint', commit: id, remaining_work: ['finish owned evidence'], evidence: [{ id: 'large'.repeat(5000), artifact: 'a'.repeat(20000), proof_boundary: 'b'.repeat(20000), applicability: 'c'.repeat(20000) }] }, decisions: ['use existing helper'], gaps: [gap], findings: [] }));
  }
  let prompt;
  const runtime = new Runtime({ ...f.options, launchProcess: (...args) => { prompt = args[2]; return f.options.launchProcess(...args); } });
  const receipt = await runtime.start({ ...f.input, instructions: 'Preserve explicit direction' });
  const current = JSON.parse(prompt.match(/CURRENT: ([^\n]+)/)[1]);
  assert.equal(current.step, f.step);
  assert.match(current.revision.commit, /^[a-f0-9]{40}$/);
  assert.equal(current.observations.find(item => item.step === '000').run_id, 'new');
  assert.deepEqual(current.observations.find(item => item.step === '000').unresolved_obligations, ['current obligation']);
  assert.deepEqual(current.observations.find(item => item.step === '000').remaining_work, ['finish owned evidence']);
  assert.ok(current.coverage_gaps.some(gap => gap.includes('corrupt.json')));
  const context = current.observations.find(item => item.step === '000');
  assert.match(context.relevance, /dependency not inferred/);
  assert.equal(context.truncated, true);
  assert.equal(context.evidence[0].artifact.length, 300);
  assert.ok(JSON.stringify(current.observations).length <= 10000);
  assert.ok(!prompt.includes('historical blocker'));
  assert.ok(prompt.includes('use existing helper'));
  assert.ok(prompt.includes('Preserve explicit direction'));
  assert.ok(prompt.includes('do not establish acceptance'));
  await runtime.cancel(f.packagePath, receipt.run_id, 1000);
});

// Run alone: node --test --test-name-pattern='prompt construction failure' runtime.test.mjs
test('prompt construction failure leaves a terminal receipt and permits a later dispatch', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000);'), runtime = new Runtime(f.options);
  const prepared = await runtime.start({ ...f.input, assignment_id: 'prepare-checkout' });
  await runtime.cancel(f.packagePath, prepared.run_id, 1000);
  const unreadableCard = join(f.packagePath, 'step-002-subspec.md'); mkdirSync(unreadableCard);
  await assert.rejects(() => runtime.start({ ...f.input, step: unreadableCard, assignment_id: 'bad-card' }), /EISDIR/);
  const failed = loadRun(f.packagePath);
  assert.equal(failed.state, 'failed');
  assert.ok(failed.finished_at);
  assert.equal(f.pids.length, 1);
  const next = await runtime.start({ ...f.input, assignment_id: 'good-card' });
  assert.equal(next.state, 'running');
  await runtime.cancel(f.packagePath, next.run_id, 1000);
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

test('editor packets use separate durable sessions while preserving checkout changes', async t => {
  const f = await fixture(t, `setInterval(()=>{},1000)`);
  const runtime = new Runtime(f.options); await runtime.start(f.input);
  const record = loadRun(f.packagePath), sessions = [];
  const source = join(record.checkout, 'pending.txt'); writeFileSync(source, 'accepted change');
  const launchEditor = (run, role, prompt) => {
    assert.equal(role, 'editor'); assert.match(prompt, /FRESH EDITOR/);
    assert.equal(readFileSync(source, 'utf8'), 'accepted change');
    sessions.push(run.editor_session);
    return { child: {}, done: Promise.resolve({ result: 'done' }) };
  };
  for (const packet of ['First edit', 'Second edit']) {
    const result = await runEditor(record, packet, undefined, launchEditor);
    assert.equal(result.editor_session, sessions.at(-1));
  }
  assert.notEqual(sessions[0], sessions[1]);
  assert.deepEqual(JSON.parse(readFileSync(join(f.packagePath, 'runtime/runs', `${record.id}-editor-sessions.json`), 'utf8')), sessions);
  await runtime.cancel(f.packagePath, undefined, 1000);
});


for (const content of [[], [{ type: 'text', text: 'Partially implemented; pending evidence.' }]]) {
  test(`length-limited final response is incomplete even with ${content.length ? 'partial text' : 'no text'} and exit zero`, async t => {
    const f = await fixture(t, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'length',content:${JSON.stringify(content)}}}));`);
    await new Runtime(f.options).start(f.input);
    const outcome = await f.finished;
    assert.equal(outcome.state, 'failed');
    assert.match(outcome.error, /length limit; packet is incomplete/);
    assert.equal(outcome.stop_reason, 'length');
    assert.match(outcome.next, /partial work.*bounded continuation/);
    assert.equal(readFileSync(outcome.full_result_path, 'utf8'), content[0]?.text || '');
  });
}

test('native recovery after a length stop can finish without inheriting the earlier failure', async t => {
  const f = await fixture(t, `
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'length',content:[{type:'text',text:'Partial'}]}}));
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Recovered'}]}}));
  `);
  await new Runtime(f.options).start(f.input);
  const outcome = await f.finished;
  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result, 'Recovered');
});

// ---------------------------------------------------------------------------
// Wave runtime: input/ownership binding only.
// ---------------------------------------------------------------------------

async function waveSetup(t, source, composition = false) {
  const f = await fixture(t, source);
  if (composition) {
    // A normal separate-git-dir integration checkout: fallback worktrees'
    // shared admin storage must not be nested inside the integration tree.
    const common = join(f.dir, 'common.git');
    renameSync(join(f.repo, '.git'), common);
    writeFileSync(join(f.repo, '.git'), `gitdir: ${common}\n`);
    f.locations.targets[0].common = common;
    writeFileSync(join(f.packagePath, 'locations.json'), JSON.stringify(f.locations, null, 2));
  }
  const ownershipRoot = join(f.dir, 'ownership');
  const ownership = createOwnership({ registryRoot: ownershipRoot });
  const coordinator = { session: 'coord-1', epoch: 1, pid: process.pid, started_at: new Date().toISOString() };
  const acquired = await ownership.acquirePackage({ packageId: f.ref, packagePath: f.packagePath, coordinator });
  const packageClaim = acquired.claim ?? acquired.result?.claim;
  const waveRoot = join(f.dir, 'wave-root');
  const base = execFileSync('git', ['-C', f.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const common = realpathSync(execFileSync('git', ['-C', f.repo, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim());
  const fake = join(f.dir, 'fake-pi.cjs');
  const reserveMember = async (step, attemptId) => {
    const attemptRoot = join(waveRoot, 'attempts', attemptId);
    for (const name of ['lower', 'upper', 'work', 'merged', 'git']) mkdirSync(join(attemptRoot, name), { recursive: true });
    const reserved = await ownership.reserveCheckout({ packageId: f.ref, attempt: attemptId,
      checkout: { gitCommonDir: join(attemptRoot, 'upper'), worktreeGitDir: join(attemptRoot, 'upper') }, coordinator });
    const checkoutClaim = reserved.claim ?? reserved.result?.claim;
    return { kind: 'step', backend: 'overlayfs', snapshotId: `snap-${step}`, baseCommit: base,
      lower: join(attemptRoot, 'lower'), upper: join(attemptRoot, 'upper'), work: join(attemptRoot, 'work'),
      merged: join(attemptRoot, 'merged'), gitDir: join(attemptRoot, 'git'), worktree: null,
      claim: { token: checkoutClaim.token, epoch: checkoutClaim.epoch }, packageId: f.ref, setup: 'none',
      requestedBackend: 'auto', selectedBackend: 'overlayfs', backendReason: 'overlay-supported', backendRemedy: 'overlayfs-mount' };
  };
  // Transport double only: it records the sanitized env/argv it receives, reports no
  // kernel proof and launches a real disposable Node child that writes the native
  // stream. Its stop/drain status is the sole cleanup authority the runtime sees.
  const launches = [];
  const children = new Set();
  const services = new Map();
  const adapter = {
    kind: 'fake', kernel_proof: false, drainOutcome: { status: 'confirmed' }, beforeRegister: null, stops: [], drains: [],
    async start(request) {
      if (adapter.beforeRegister) adapter.beforeRegister();
      launches.push({ argv: [...request.argv], env: { ...request.env }, cwd: request.cwd, deadline: request.deadline, limits: request.limits });
      const service = { unit: `fake-unit-${launches.length}`, invocation: `fake-invocation-${launches.length}`, main_pid: null, terminal: false };
      // Composition mode executes the exact production argv. Only the final
      // `pi` on PATH is a fixture; neither bootstrap nor bwrap is substituted.
      if (composition && !request.register(service)) throw new Error('contained registration refused');
      const [command, ...args] = composition ? request.argv : [process.execPath, fake];
      const child = spawn(command, args, { cwd: request.cwd, env: { ...request.env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const submittedLaunch = launches.at(-1);
      child.stderr.on('data', chunk => { submittedLaunch.stderr = (submittedLaunch.stderr ?? '') + chunk; });
      child.on('error', () => {});
      service.main_pid = child.pid;
      services.set(service.unit, { service, child });
      children.add(child);
      try {
        // A refused registration must not authorize a live bootstrap.
        if (!composition && !request.register(service)) throw new Error('contained registration refused');
      } catch (error) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        throw error;
      }
      return { ok: true, status: 'running', child, main_pid: child.pid, record: service };
    },
    async stop(service) {
      adapter.stops.push(service.unit);
      const entry = services.get(service.unit);
      if (entry && entry.child.exitCode === null && entry.child.signalCode === null) { try { process.kill(-entry.child.pid, 'SIGTERM'); } catch {} }
      if (composition) await waitForExit(entry?.child);
      return { status: 'confirmed', service, kernel_proof: false };
    },
    async drain(service) {
      adapter.drains.push(service.unit);
      const entry = services.get(service.unit);
      // Unknown is absence of proof, even if the leader has already exited.
      if (composition && adapter.drainOutcome.status !== 'confirmed')
        return { ...adapter.drainOutcome, service, kernel_proof: false };
      if (entry && entry.child.exitCode === null && entry.child.signalCode === null) { try { process.kill(-entry.child.pid, 'SIGKILL'); } catch {} }
      if (composition) await waitForExit(entry?.child);
      return { ...adapter.drainOutcome, service, kernel_proof: false };
    },
  };
  t.after(async () => {
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      if (child.exitCode === null && child.signalCode === null)
        await new Promise(resolve => { const timer = setTimeout(resolve, 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
  });
  const target = f.locations.targets[0];
  const wave = { version: 1, package_ref: f.ref, claim_token: packageClaim.token,
    coordinator: { session: coordinator.session, epoch: coordinator.epoch }, generation: 1,
    target: { id: target.id, base_commit: base, common, integration_checkout: realpathSync(f.repo) }, members: {} };
  const attachMember = (step, attemptId, memberWorkspace) => {
    wave.members[String(step)] = { step, attempt_id: attemptId, phase: 'implementing', run_id: null, workspace: memberWorkspace };
  };
  const workspace = await reserveMember(1, 'attempt-1');
  attachMember(1, 'attempt-1', workspace);
  mkdirSync(join(f.packagePath, 'runtime', 'waves'), { recursive: true });
  const wavePath = join(f.packagePath, 'runtime', 'waves', 'wave-1.json');
  writeFileSync(wavePath, JSON.stringify(wave, null, 2));
  const input = { ...f.input, wave_id: 'wave-1', expected_generation: 1, step_number: 1, attempt_id: 'attempt-1',
    phase: 'implementing', claim_token: packageClaim.token, coordinator_epoch: 1 };
  const addMember = async (step, attemptId = `attempt-${step}`) => {
    const memberWorkspace = await reserveMember(step, attemptId);
    attachMember(step, attemptId, memberWorkspace);
    writeFileSync(wavePath, JSON.stringify(wave, null, 2));
    const memberStep = join(f.packagePath, `step-${String(step).padStart(3, '0')}-subspec.md`);
    writeFileSync(memberStep, 'Prepared step');
    const stepsFile = join(f.packagePath, 'spec-steps.json');
    const steps = existsSync(stepsFile) ? JSON.parse(readFileSync(stepsFile, 'utf8')).steps : [];
    if (!steps.some(entry => entry.step === step)) steps.push({ step, difficulty: 'hard' });
    writeFileSync(stepsFile, JSON.stringify({ steps }));
    return { workspace: memberWorkspace, input: { ...input, step: memberStep, step_number: step, attempt_id: attemptId, assignment_id: `wave-member-${step}` } };
  };
  return { f, ownershipRoot, ownership, coordinator, waveRoot, wave, wavePath, workspace, input, adapter, launches, children, addMember, fake };
}

async function waitForExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('real child did not exit after stop/drain')), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function composedWave(t, source, portable = false) {
  const originalPath = process.env.PATH;
  t.after(() => { process.env.PATH = originalPath; });
  const w = await waveSetup(t, source, portable ? 'portable' : true);
  if (portable) {
    // Real executable discovery, not a probe runner/result override: neither
    // bwrap nor a directory containing it is reachable through this PATH.
    const bin = join(w.f.dir, 'portable-bin');
    mkdirSync(bin);
    for (const command of ['git', 'sh', 'mkdir', 'flock', 'tar']) {
      const executable = execFileSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim();
      symlinkSync(executable, join(bin, command));
    }
    process.env.PATH = bin;
  }
  // Use production capability classification and selection, never a fabricated
  // unavailable result. This is NOT a systemd/cgroup or EV-14 rehearsal.
  const probe = await runCapabilityProbe({ fixtureRoot: w.f.dir });
  w.capability = probe.result;
  if (portable) {
    assert.equal(probe.result.status, 'unavailable');
    assert.equal(probe.result.reason, 'bwrap-absent');
  }
  assert.notEqual(probe.result.status, 'blocked', JSON.stringify(probe));
  w.wave.target.backend = 'auto';
  w.wave.target.capability = probe.result;
  await w.ownership.releaseClaim({ ...w.workspace.claim, drain: 'confirmed' });
  w.wave.members['1'].workspace = null;
  writeFileSync(w.wavePath, JSON.stringify(w.wave, null, 2));
  const target = w.f.locations.targets[0].id;
  writeFileSync(join(w.f.packagePath, 'spec-steps.json'), JSON.stringify({
    steps: [{ step: 1, difficulty: 'hard' }],
    setup: { [target]: { command: 'mkdir -p deps; printf prepared > deps/setup-output', environment: [], lockfiles: [] } },
  }));
  const bin = join(w.f.dir, 'bin');
  mkdirSync(bin);
  const pi = join(bin, 'pi');
  writeFileSync(pi, `#!${process.execPath}\n${source}`);
  chmodSync(pi, 0o700);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  const runtime = waveRuntime(w);
  const prepared = await runtime.prepareWaveMember(w.input);
  w.workspace = prepared.workspace;
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.preparation_receipt.trackedClean, true);
  assert.equal(w.workspace.selectedBackend, probe.result.status === 'supported' ? 'overlayfs' : 'worktree');
  assert.equal(w.workspace.backendReason, probe.result.reason);
  if (portable) {
    assert.equal(w.workspace.selectedBackend, 'worktree');
    assert.equal(w.workspace.backend, 'worktree');
    assert.ok(w.launches.every(({ argv }) => argv[0] === process.execPath && !argv.includes('bwrap')));
  }
  t.diagnostic(portable ? 'portable execution SUBSET: production worktree fallback, bwrap absent from PATH; setup publication KNOWN GAP outside step 6; kernel_proof:false; not EV-14'
    : 'host-dependent/native auto-selection evidence only; not the portable contract; kernel_proof:false; not EV-14');
  t.diagnostic(`composition backend=${w.workspace.selectedBackend}; capability=${probe.result.reason}; probe boundary=${probe.boundary}; no systemd/cgroup or EV-14 certification`);
  const durable = JSON.parse(readFileSync(w.wavePath, 'utf8')).members['1'];
  assert.equal(durable.workspace.snapshotId, w.workspace.snapshotId);
  assert.equal(durable.preparation_receipt.drain, 'confirmed');
  assert.equal(w.launches[0].argv[0], process.execPath, 'setup executes the real root bootstrap');
  return { ...w, runtime };
}

const waveRuntime = w => {
  const runtime = new Runtime({ ...w.f.options, ownershipRoot: w.ownershipRoot, serviceAdapter: w.adapter });
  w.f.runtimes.add(runtime);
  return runtime;
};

for (const portable of [false, true]) {
// Original names/assertions stay intact for host-dependent auto-selection;
// Portable variants establish execution/cleanup, but explicitly expose missing
// setup publication. They cannot close F3 until the step-004 defect is repaired.
const compositionName = portable ? 'portable fallback composition subset (KNOWN setup publication gap)' : 'composition';
test(`wave runtime: ${compositionName} executes the submitted bootstrap and observes private worker context`, async t => {
  const previousSecret = process.env.SPEC_RUNTIME_COMPOSITION_SECRET;
  process.env.SPEC_RUNTIME_COMPOSITION_SECRET = 'private-composition-context';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.SPEC_RUNTIME_COMPOSITION_SECRET;
    else process.env.SPEC_RUNTIME_COMPOSITION_SECRET = previousSecret;
  });
  const w = await composedWave(t, `
    const fs = require('fs'), path = require('path');
    const record = JSON.parse(fs.readFileSync(process.env.SPEC_RUNTIME_RECORD, 'utf8'));
    fs.writeFileSync(path.join(record.package, 'worker-environment.json'), JSON.stringify(process.env));
    fs.writeFileSync(path.join(record.package, 'worker-checkout.json'), JSON.stringify({
      cwd: process.cwd(), pointer: fs.readFileSync('.git', 'utf8'),
      head: require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(),
      setup: fs.existsSync('deps/setup-output') ? fs.readFileSync('deps/setup-output', 'utf8') : null,
    }));
    setInterval(() => {}, 1000);
  `, portable);
  const { runtime } = w;
  const started = await runtime.start(w.input);
  if (portable) {
    assert.equal(loadRun(w.f.packagePath, started.run_id).wave_bindings.backend, 'worktree');
    assert.equal(w.launches.at(-1).argv[0], process.execPath);
  }
  const observed = join(w.f.packagePath, 'worker-environment.json');
  const checkoutObserved = join(w.f.packagePath, 'worker-checkout.json');
  for (let i = 0; i < 100 && !existsSync(checkoutObserved); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(checkoutObserved), true, w.launches.at(-1).stderr);
  assert.equal(existsSync(observed), true, 'submitted bootstrap must deliver the private request environment');
  const env = JSON.parse(readFileSync(observed, 'utf8'));
  assert.equal(env.SPEC_RUNTIME_RECORD, join(w.f.packagePath, 'runtime', 'runs', `${started.run_id}.json`));
  assert.equal(env.SPEC_RUNTIME_ROLE, 'owner');
  assert.equal(env.PI_INTERCOM_SCOPE_ID, started.run_id);
  assert.equal(env.PI_INTERCOM_STABLE_ID, `spec-owner-${started.run_id}`);
  assert.equal(env.PI_WARDEN_HOST_PATHS, realpathSync(w.f.packagePath));
  assert.equal(env.PI_WARDEN_ENABLED, '1');
  assert.equal(env.SPEC_RUNTIME_COMPOSITION_SECRET, 'private-composition-context');
  for (const key of ['SPEC_RUNTIME_ROLE', 'SPEC_RUNTIME_RECORD', 'PI_INTERCOM_SCOPE_ID', 'PI_WARDEN_ENABLED', 'PI_WARDEN_HOST_PATHS', 'SPEC_RUNTIME_COMPOSITION_SECRET'])
    assert.equal(w.launches.at(-1).env[key], undefined, `${key} is private, not transport`);
  assert.ok(!w.launches.at(-1).argv.some(arg => arg.includes('private-composition-context')));
  if (w.workspace.backend === 'overlayfs') {
    const argv = w.launches.at(-1).argv;
    assert.equal(argv[0], 'bwrap');
    assert.ok(argv.includes('--unshare-user'));
  }
  const checkout = JSON.parse(readFileSync(checkoutObserved, 'utf8'));
  assert.equal(checkout.cwd, w.workspace.merged ?? w.workspace.worktree);
  assert.match(checkout.pointer, /^gitdir: /);
  assert.equal(checkout.head, w.wave.target.base_commit);
  if (portable) {
    await t.test('prepared fallback output reaches portable worker (not EV-14)', () => {
      assert.equal(checkout.setup, 'prepared', 'real setup output is published to fallback');
    });
    assert.equal(w.launches[0].argv[0], process.execPath);
    const staging = join(w.workspace.worktree, '..', '..', '..', 'staging', 'attempt-1', 'dependencies', 'deps', 'setup-output');
    assert.equal(readFileSync(staging, 'utf8'), 'prepared', 'real setup produced bytes in staging before publication');
  } else {
    assert.equal(checkout.setup, 'prepared');
  }
  await runtime.cancel(w.f.packagePath, started.run_id);
});

for (const drainStatus of ['confirmed', 'unknown']) {
  test(`wave runtime: ${compositionName} contained settled cleanup with ${drainStatus} drain retains state for phase remount (not EV-14)`, { timeout: 60000 }, async t => {
    const w = await composedWave(t, `
      const fs = require('fs'), path = require('path');
      const record = JSON.parse(fs.readFileSync(process.env.SPEC_RUNTIME_RECORD, 'utf8'));
      const retained = fs.existsSync('retained.txt') ? fs.readFileSync('retained.txt', 'utf8') : null;
      fs.writeFileSync(path.join(record.package, record.id + '-observed.json'), JSON.stringify({
        retained, setup: fs.existsSync('deps/setup-output') ? fs.readFileSync('deps/setup-output', 'utf8') : null,
        head: require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(),
      }));
      fs.writeFileSync('retained.txt', 'dirty retained bytes');
      process.on('SIGTERM', () => process.exit(143));
      console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Retained handoff'}]}}));
      console.log(JSON.stringify({type:'agent_settled',aborted:false}));
      setInterval(() => {}, 1000);
    `, portable);
    const { runtime } = w;
    w.adapter.drainOutcome = { status: drainStatus, reason: drainStatus === 'unknown' ? 'inspection-unavailable' : undefined };
    const started = await runtime.start(w.input);
    const result = await w.f.finished;
    let record = loadRun(w.f.packagePath, started.run_id);
    if (portable) {
      assert.equal(record.wave_bindings.backend, 'worktree');
      assert.equal(w.launches.at(-1).argv[0], process.execPath);
    }
    const claims = () => JSON.parse(readFileSync(join(w.ownershipRoot, 'claims.json'), 'utf8')).claims;
    const ownClaims = () => claims().filter(c => [record.capacity_claim.token, record.wave_bindings.checkout_claim].includes(c.token));
    assert.equal(w.adapter.stops.filter(unit => unit === record.service.unit).length, 1, `real contained settled-worker callback ran exactly once: ${JSON.stringify(result)}`);
    assert.ok(w.adapter.drains.includes(record.service.unit), 'Runtime.finish used contained drain');
    const child = [...w.children].at(-1);
    assert.notEqual(child.exitCode ?? child.signalCode, null, 'real submitted process exited before drain confirmation');
    const receiptPath = join(w.f.packagePath, 'runtime', 'runs', `${record.id}-phase-drain.json`);
    if (drainStatus === 'unknown') {
      assert.equal(result.state, 'blocked');
      assert.equal(ownClaims().length, 2, 'unknown drain retains BOTH capacity and checkout');
      assert.equal(existsSync(receiptPath), false, 'unknown drain cannot mint release proof');
      await assert.rejects(() => runtime.remountWaveMember(w.input), /confirmed phase drain receipt/);
      w.adapter.drainOutcome = { status: 'confirmed' };
      await runtime.finish(record, { code: 143, shutdown_cleanup: true, result: 'Retained handoff' });
      record = loadRun(w.f.packagePath, started.run_id);
    } else {
      assert.equal(result.state, 'completed');
      assert.equal(result.shutdown_cleanup, true, 'exit 143 from contained cleanup is not a crash');
      assert.equal(result.error, undefined);
    }
    assert.equal(record.state, 'completed');
    assert.equal(ownClaims().length, 0, 'confirmed drain/retry releases both claims');
    assert.ok(claims().some(c => c.kind === 'package'), 'package authority is never released');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.run_id, started.run_id);
    assert.deepEqual(receipt.released.map(c => c.kind).sort(), ['capacity', 'checkout']);
    assert.equal(receipt.service.unit, record.service.unit);
    const retained = w.workspace.retained;
    const wave = JSON.parse(readFileSync(w.wavePath, 'utf8'));
    wave.members['1'].phase = 'reviewing';
    writeFileSync(w.wavePath, JSON.stringify(wave, null, 2));
    const input = { ...w.input, phase: 'reviewing', assignment_id: 'retained-review-phase' };
    const remounted = await runtime.remountWaveMember(input);
    assert.equal(remounted.remounted, true);
    assert.deepEqual(remounted.workspace.retained, retained, 'same immutable retained identity');
    assert.notEqual(remounted.workspace.claim.token, w.workspace.claim.token);
    assert.equal((await runtime.remountWaveMember(input)).idempotent, true);
    const next = await runtime.start(input);
    if (portable) {
      assert.equal(loadRun(w.f.packagePath, next.run_id).wave_bindings.backend, 'worktree');
      assert.equal(w.launches.at(-1).argv[0], process.execPath);
    }
    const observed = join(w.f.packagePath, `${next.run_id}-observed.json`);
    for (let i = 0; i < 100 && !existsSync(observed); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const actual = JSON.parse(readFileSync(observed, 'utf8'));
    assert.equal(actual.retained, 'dirty retained bytes', 'second real worker sees first worker dirty state');
    if (portable) {
      assert.equal(actual.setup, 'prepared', 'published setup output survives phase remount');
    } else {
      assert.equal(actual.setup, 'prepared', 'published setup output survives phase remount');
    }
    assert.equal(actual.head, w.wave.target.base_commit);
    assert.notEqual(next.run_id, started.run_id);
    await runtime.cancel(w.f.packagePath, next.run_id);
  });
}

}

test('wave runtime: nonnative overlay argv construction retains real bootstrap without executing bwrap (not EV-14)', async t => {
  const w = await waveSetup(t, 'throw new Error("must not execute");');
  let submitted;
  w.adapter.start = async request => {
    submitted = request;
    throw new Error('argv inspection only: no execution');
  };
  await assert.rejects(() => waveRuntime(w).start(w.input), /argv inspection only/);
  assert.ok(submitted, 'production containedRoot must submit the composition');
  const layers = w.workspace;
  assert.deepEqual(submitted.argv.slice(0, 20), [
    'bwrap', '--unshare-user', '--die-with-parent', '--bind', '/', '/',
    '--dev', '/dev', '--proc', '/proc', '--overlay-src', layers.lower,
    '--overlay', layers.upper, layers.work, layers.merged, '--chdir', layers.merged,
    '--', process.execPath,
  ]);
  assert.equal(submitted.argv[20], '-e');
  assert.match(submitted.argv[21], /spawn/);
  const requestPath = submitted.argv[22];
  assert.equal(submitted.argv.length, 23, 'bootstrap request is the final argv element');
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));
  assert.equal(request.checkout, layers.merged);
  assert.equal(request.gitDir, layers.gitDir);
  assert.equal(request.command, 'pi');
  assert.ok(request.args.includes('--session'));
  assert.equal(request.env.SPEC_RUNTIME_ROLE, 'owner');
  assert.equal(w.children.size, 0, 'inspection never executes a transport');
  t.diagnostic('nonnative production overlay argv inspection only; no capability probe, fixture bwrap or execution; kernel_proof:false; not EV-14');
});

test('wave runtime: production fallback workspace binds and starts without an overlay upper (not EV-14)', async t => {
  const w = await composedWave(t, 'setInterval(() => {}, 1000);', true);
  assert.equal(w.workspace.upper, null);
  assert.equal(existsSync(join(w.workspace.worktree, '..', 'upper')), false);
  const started = await w.runtime.start(w.input);
  const record = loadRun(w.f.packagePath, started.run_id);
  assert.equal(record.state, 'running');
  assert.equal(record.wave_bindings.backend, 'worktree');
  assert.equal(record.wave_bindings.layers, null);
  assert.equal(record.checkout, w.workspace.worktree);
  await w.runtime.cancel(w.f.packagePath, started.run_id);
});

test('wave runtime: overlay workspace with a missing upper still throws before launch', async t => {
  const w = await waveSetup(t);
  rmSync(w.workspace.upper, { recursive: true });
  await assert.rejects(() => waveRuntime(w).start(w.input), error => {
    assert.equal(error.code, 'ENOENT');
    assert.equal(error.path, w.workspace.upper);
    return true;
  });
  assert.equal(w.launches.length, 0);
});

test('wave runtime: a validated member binds its run and bypasses only the serial latest-run exclusion', async t => {
  const w = await waveSetup(t, 'setInterval(() => {}, 1000);');
  writeFileSync(join(w.f.packagePath, 'runtime', 'run.json'), JSON.stringify({ id: 'prior-run', state: 'running', coordinator_pid: process.pid, package: w.f.packagePath, step: w.f.step }));
  const runtime = waveRuntime(w);
  const started = await runtime.start(w.input);
  const record = loadRun(w.f.packagePath, started.run_id);
  assert.equal(record.state, 'running');
  assert.equal(record.wave_bindings.wave_id, 'wave-1');
  assert.equal(record.wave_bindings.generation, 1);
  assert.equal(record.wave_bindings.backend, 'overlayfs');
  assert.equal(summary(record).wave.wave_id, 'wave-1');
  assert.equal(JSON.parse(readFileSync(w.wavePath, 'utf8')).members['1'].run_id, started.run_id);
  assert.equal(JSON.parse(readFileSync(join(w.f.packagePath, 'runtime', 'run.json'), 'utf8')).id, 'prior-run');
  const replayed = await runtime.start(w.input);
  assert.equal(replayed.run_id, started.run_id, 'the wave binding is idempotent for the same assignment');
});

test('wave runtime: the start prompt uses the frozen base without probing the empty merged overlay', async t => {
  const w = await waveSetup(t, 'setInterval(() => {}, 1000);');
  const base = execFileSync('git', ['-C', w.f.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // The fixture's joined overlay is an intentionally empty external mountpoint with
  // no .git; the coordinator must build the prompt without reading it.
  assert.equal(existsSync(join(w.workspace.merged, '.git')), false, 'fixture keeps the external merged mountpoint empty');
  const runtime = waveRuntime(w);
  const started = await runtime.start(w.input);
  const request = JSON.parse(readFileSync(join(w.f.packagePath, 'runtime', 'runs', `${started.run_id}-owner-request.json`), 'utf8'));
  const prompt = request.args.find(value => typeof value === 'string' && value.includes('CURRENT:'));
  const current = JSON.parse(prompt.match(/CURRENT: ([^\n]+)/)[1]);
  assert.equal(current.revision.commit, base, 'CURRENT revision is the durable frozen base');
  assert.equal(current.revision.dirty, null, 'the coordinator never measures dirtiness against an unmounted overlay');
  assert.equal(existsSync(join(w.workspace.merged, '.git')), false, 'the coordinator did not initialize the empty external merged mountpoint');
  await runtime.cancel(w.f.packagePath, started.run_id);
});

test('wave runtime: a stale generation is refused', async t => {
  const w = await waveSetup(t, 'setInterval(() => {}, 1000);');
  await assert.rejects(() => waveRuntime(w).start({ ...w.input, expected_generation: 2 }), /expected_generation/);
});

test('wave runtime: a member reusing the integration checkout is refused', async t => {
  const w = await waveSetup(t, 'setInterval(() => {}, 1000);');
  w.wave.target.integration_checkout = w.workspace.merged;
  writeFileSync(w.wavePath, JSON.stringify(w.wave, null, 2));
  await assert.rejects(() => waveRuntime(w).start(w.input), /integration checkout/);
});

test('wave runtime: a serial start refuses any active package wave claim', async t => {
  const w = await waveSetup(t, 'setInterval(() => {}, 1000);');
  await assert.rejects(() => waveRuntime(w).start(w.f.input), /active wave claim/);
});

test('wave runtime: revoking the wave member binding fails the writer lease', async t => {
  const w = await waveSetup(t, 'setInterval(() => {}, 1000);');
  const started = await waveRuntime(w).start(w.input);
  const record = loadRun(w.f.packagePath, started.run_id);
  w.wave.members['1'].run_id = null;
  writeFileSync(w.wavePath, JSON.stringify(w.wave, null, 2));
  assert.throws(() => assertLease(record), /Wave member binding/);
});

test('wave runtime: a refused registration blocks the run and leaves no live bootstrap', { timeout: 120000 }, async t => {
  const w = await waveSetup(t, 'setInterval(() => {}, 1000);');
  w.adapter.beforeRegister = () => {
    const current = JSON.parse(readFileSync(w.wavePath, 'utf8'));
    current.members['1'].run_id = 'forged-run';
    writeFileSync(w.wavePath, JSON.stringify(current, null, 2));
  };
  await assert.rejects(() => waveRuntime(w).start(w.input), /Wave member binding/);
  const runsDir = join(w.f.packagePath, 'runtime', 'runs');
  const runFile = readdirSync(runsDir).find(name => /^[0-9a-f-]{36}\.json$/.test(name));
  const record = JSON.parse(readFileSync(join(runsDir, runFile), 'utf8'));
  assert.equal(record.state, 'blocked');
  assert.equal(record.pid ?? null, null, 'a wave launcher pid is never recorded as the run pid');
  for (const child of w.children) {
    if (child.exitCode === null && child.signalCode === null)
      await new Promise(resolve => { const timer = setTimeout(resolve, 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    assert.equal(groupAlive(child.pid), false, 'no bootstrap survives a refused registration');
  }
});

test('wave runtime: two members run concurrently in distinct workspaces and cancelling one leaves the sibling active', { timeout: 120000 }, async t => {
  const w = await waveSetup(t, 'setInterval(() => {}, 1000);');
  const second = await w.addMember(2);
  const runtime = waveRuntime(w);
  const [first, other] = await Promise.all([runtime.start(w.input), runtime.start(second.input)]);
  const firstRecord = loadRun(w.f.packagePath, first.run_id);
  const otherRecord = loadRun(w.f.packagePath, other.run_id);
  assert.notEqual(firstRecord.checkout, otherRecord.checkout, 'members have distinct retained workspaces');
  assert.equal(firstRecord.state, 'running');
  assert.equal(otherRecord.state, 'running');
  assert.equal(groupAlive(firstRecord.pid), true);
  assert.equal(groupAlive(otherRecord.pid), true);
  // Readiness barrier: each member's durable wave binding names its own run before cancellation.
  const bound = JSON.parse(readFileSync(w.wavePath, 'utf8'));
  assert.equal(bound.members['1'].run_id, first.run_id);
  assert.equal(bound.members['2'].run_id, other.run_id);
  const siblingGroupsBefore = activeGroups(loadRun(w.f.packagePath, other.run_id)).map(group => group.pid);
  await runtime.cancelRun(w.f.packagePath, first.run_id);
  assert.equal(loadRun(w.f.packagePath, first.run_id).state, 'cancelled');
  const siblingAfter = loadRun(w.f.packagePath, other.run_id);
  assert.equal(siblingAfter.state, 'running');
  assert.equal(groupAlive(siblingAfter.pid), true, 'the sibling bootstrap was never signalled');
  assert.deepEqual(activeGroups(siblingAfter).map(group => group.pid), siblingGroupsBefore);
  await runtime.cancelRun(w.f.packagePath, other.run_id);
});

test('wave runtime: an unknown drain retains capacity and checkout and a confirmed retry releases only that member', { timeout: 120000 }, async t => {
  const w = await waveSetup(t);
  const runtime = waveRuntime(w);
  const started = await runtime.start(w.input);
  w.adapter.drainOutcome = { status: 'stop-requested', reason: 'inspect-error' };
  const blocked = await w.f.finished;
  assert.equal(blocked.state, 'blocked', 'a non-confirmed drain cannot finish the run');
  const inspect = async () => (await w.ownership.inspectClaims({ packageId: w.f.ref })).claims;
  const before = await inspect();
  assert.ok(before.some(claim => claim.kind === 'capacity' && claim.attempt === 'wave-1:attempt-1:implementing'));
  assert.ok(before.some(claim => claim.kind === 'checkout' && claim.attempt === 'attempt-1'));
  assert.equal(loadRun(w.f.packagePath, started.run_id).state, 'blocked');
  w.adapter.drainOutcome = { status: 'confirmed' };
  await runtime.finish(loadRun(w.f.packagePath, started.run_id), { result: 'Done' });
  const after = await inspect();
  const released = claim => before.some(old => old.token === claim.token) && !after.some(next => next.token === claim.token);
  const capacity = before.filter(claim => claim.kind === 'capacity' && claim.attempt === 'wave-1:attempt-1:implementing');
  const checkout = before.filter(claim => claim.kind === 'checkout' && claim.attempt === 'attempt-1');
  assert.equal(capacity.length, 1);
  assert.equal(checkout.length, 1);
  assert.equal(released(capacity[0]), true);
  assert.equal(released(checkout[0]), true);
  assert.equal(after.filter(claim => claim.kind === 'package').length, 1, 'the wave package claim is never released');
  const record = loadRun(w.f.packagePath, started.run_id);
  assert.equal(record.state, 'completed');
  assert.equal(record.phase_drain.status, 'confirmed');
  assert.ok(record.phase_drain.path && existsSync(record.phase_drain.path));
  const receipt = JSON.parse(readFileSync(record.phase_drain.path, 'utf8'));
  assert.equal(receipt.status, 'confirmed');
  assert.deepEqual(receipt.released.map(item => item.kind).sort(), ['capacity', 'checkout']);
});

test('wave runtime: the private request carries Warden, SPEC_RUNTIME and intercom while the adapter transport stays sanitized', { timeout: 120000 }, async t => {
  const w = await waveSetup(t, 'setInterval(() => {}, 1000);');
  const secret = 'wave-private-secret-token';
  const previous = process.env.SPEC_RUNTIME_TEST_SECRET;
  process.env.SPEC_RUNTIME_TEST_SECRET = secret;
  t.after(() => { if (previous === undefined) delete process.env.SPEC_RUNTIME_TEST_SECRET; else process.env.SPEC_RUNTIME_TEST_SECRET = previous; });
  const runtime = waveRuntime(w);
  const started = await runtime.start(w.input);
  const launch = w.launches.at(-1);
  assert.equal(launch.env.SPEC_RUNTIME_TEST_SECRET, undefined, 'secrets never reach the transport env');
  assert.equal(launch.env.SPEC_RUNTIME_ROLE, undefined);
  assert.equal(launch.env.PI_INTERCOM_SCOPE_ID, undefined);
  assert.equal(launch.env.PI_WARDEN_HOST_PATHS, undefined);
  assert.ok(!launch.argv.some(part => String(part).includes(secret)), 'secrets never reach the transport argv');
  const record = loadRun(w.f.packagePath, started.run_id);
  const request = JSON.parse(readFileSync(record.service_request, 'utf8'));
  assert.equal(request.env.SPEC_RUNTIME_TEST_SECRET, secret, 'the mode-0600 private request forwards the full environment');
  assert.equal(request.env.SPEC_RUNTIME_ROLE, 'owner');
  assert.equal(request.env.SPEC_RUNTIME_RECORD, join(w.f.packagePath, 'runtime', 'runs', `${started.run_id}.json`));
  assert.equal(request.env.PI_INTERCOM_SCOPE_ID, started.run_id);
  assert.equal(request.env.PI_INTERCOM_STABLE_ID, `spec-owner-${started.run_id}`);
  assert.equal(request.env.PI_WARDEN_HOST_PATHS, realpathSync(w.f.packagePath));
  await runtime.cancelRun(w.f.packagePath, started.run_id);
});

test('wave runtime: a sibling member aliasing the same checkout is refused', { timeout: 120000 }, async t => {
  const w = await waveSetup(t, 'setInterval(() => {}, 1000);');
  const second = await w.addMember(2);
  w.wave.members['2'].workspace = { ...w.workspace };
  writeFileSync(w.wavePath, JSON.stringify(w.wave, null, 2));
  await assert.rejects(() => waveRuntime(w).start(second.input), /same checkout or private git dir/i);
});

test('wave runtime: a caller presenting a replaced checkout claim is refused', { timeout: 120000 }, async t => {
  const w = await waveSetup(t, 'setInterval(() => {}, 1000);');
  const claimsFile = join(w.ownershipRoot, 'claims.json');
  const registry = JSON.parse(readFileSync(claimsFile, 'utf8'));
  registry.claims.find(claim => claim.kind === 'checkout').epoch += 1000;
  writeFileSync(claimsFile, JSON.stringify(registry, null, 2));
  await assert.rejects(() => waveRuntime(w).start(w.input), /checkout claim/i);
});

test('wave runtime: only a recorded role fallback is admitted and it never rewrites the requested selector', async () => {
  const record = { owner_model: 'primalabs/owner-model', editor_model: 'primalabs/editor-model' };
  const fallback = { provider: 'deepseek', id: 'deepseek-flash' };
  const recovery = requested_model => ({ type: 'custom', customType: 'spec-provider-recovery',
    data: { version: 1, requested_model, event: 'fallback_selected', effective_model: 'deepseek/deepseek-flash' } });
  assert.doesNotThrow(() => assertManagedModel(record, 'owner', { provider: 'primalabs', id: 'owner-model' }, []), 'the exact requested selector passes');
  assert.doesNotThrow(() => assertManagedModel(record, 'owner', fallback, [recovery('primalabs/owner-model')]), 'the recorded owner fallback passes');
  assert.doesNotThrow(() => assertManagedModel(record, 'editor', fallback, [recovery('primalabs/editor-model')]), 'the recorded editor fallback passes');
  assert.throws(() => assertManagedModel(record, 'owner', fallback, []), /SPEC_MODEL_SELECTOR_MISMATCH/, 'an unrecorded fallback is refused');
  assert.throws(() => assertManagedModel(record, 'editor', fallback, [recovery('primalabs/owner-model')]), /SPEC_MODEL_SELECTOR_MISMATCH/, "another role's entry does not authorize the editor");
  assert.throws(() => assertManagedModel(record, 'owner', { provider: 'deepseek', id: 'deepseek-chat' }, [recovery('primalabs/owner-model')]), /SPEC_MODEL_SELECTOR_MISMATCH/, 'an arbitrary model swap is refused');
  assert.throws(() => assertManagedModel(record, 'owner', fallback, [{ type: 'custom', customType: 'spec-provider-recovery',
    data: { version: 1, requested_model: 'primalabs/owner-model', event: 'fallback_selected', effective_model: 'deepseek/deepseek-chat' } }]), /SPEC_MODEL_SELECTOR_MISMATCH/, 'a mismatched effective model is refused');
  assert.throws(() => assertManagedModel({ owner_model: 'test/owner' }, 'owner', fallback, [recovery('test/owner')]), /SPEC_MODEL_SELECTOR_MISMATCH/, 'only a primalabs requested selector is recovery-eligible');
});

test('wave runtime: sibling identity requires the same generation and a distinct member', async () => {
  const validated = { wave_id: 'wave-1', package_ref: 'pkg', generation: 1, coordinator_epoch: 1, target: 'target-1', step_number: 1 };
  assert.equal(waveSiblingMatches(validated, { ...validated, step_number: 2 }), true, 'a distinct member of the same generation matches');
  assert.equal(waveSiblingMatches(validated, { ...validated }), false, 'the same member is not a sibling');
  assert.equal(waveSiblingMatches(validated, { ...validated, step_number: 2, generation: 2 }), false, 'a stale generation is refused');
  assert.equal(waveSiblingMatches(validated, { ...validated, step_number: 2, coordinator_epoch: 2 }), false, 'another coordinator epoch is refused');
  assert.equal(waveSiblingMatches(validated, { ...validated, step_number: 2, target: 'target-2' }), false, 'another target is refused');
  assert.equal(waveSiblingMatches(validated, { ...validated, step_number: 2, package_ref: 'other' }), false, 'another package is refused');
  assert.equal(waveSiblingMatches(validated, null), false, 'a serial conflict is never a sibling');
});

test('wave runtime: a numeric shared deadline stays running with finite future remaining time', { timeout: 120000 }, async t => {
  const w = await waveSetup(t, 'setInterval(() => {}, 1000);');
  const runtime = waveRuntime(w);
  const started = await runtime.start(w.input);
  // Explicit ready barrier: the contained launch is registered before start
  // returns, and a zero-delay (NaN) deadline timer fires before this later
  // zero-delay timer, so a numerically mis-parsed deadline is observable here.
  assert.ok(w.launches.length >= 1, 'the contained member launch is registered');
  await new Promise(resolve => setTimeout(resolve, 0));
  const record = loadRun(w.f.packagePath, started.run_id);
  assert.equal(record.state, 'running', 'a numeric shared deadline does not cancel the run');
  assert.ok(Number.isSafeInteger(record.deadline.expires_at), 'the shared expiry is a safe integer');
  assert.equal(record.deadline.expires_at, record.deadline.started_at + record.deadline.timeout_ms, 'the recorded deadline is internally consistent');
  const wave = JSON.parse(readFileSync(w.wavePath, 'utf8'));
  assert.deepEqual(record.deadline, wave.deadline, 'the run retains the shared wave deadline unchanged');
  const remaining = record.deadline.expires_at - Date.now();
  assert.ok(Number.isFinite(remaining) && remaining > 0, 'the shared deadline retains finite future time');
});

test('wave runtime: a live distinct sibling conflict is waived while stale and same-member conflicts are refused', { timeout: 120000 }, async t => {
  const w = await waveSetup(t, 'setInterval(() => {}, 1000);');
  const runtime = waveRuntime(w);
  const started = await runtime.start(w.input);
  const bound = loadRun(w.f.packagePath, started.run_id).wave_bindings;
  const siblingConfig = { wave_bindings: { ...bound, step_number: 2 } };
  assert.equal(waveSiblingConflict(w.f.packagePath, { runId: started.run_id }, siblingConfig), true, 'a live distinct sibling is waived');
  assert.equal(waveSiblingConflict(w.f.packagePath, { runId: started.run_id }, { wave_bindings: bound }), false, 'the same member stays a conflict');
  assert.equal(waveSiblingConflict(w.f.packagePath, { runId: 'missing-run' }, siblingConfig), false, 'an unknown run is refused');
  await runtime.cancelRun(w.f.packagePath, started.run_id);
  assert.equal(waveSiblingConflict(w.f.packagePath, { runId: started.run_id }, siblingConfig), false, 'a cancelled sibling no longer holds a lease');
});

test('wave runtime: simultaneous event appenders lose no valid line', { timeout: 120000 }, async t => {
  const f = await fixture(t, 'setInterval(() => {}, 1000);');
  mkdirSync(join(f.packagePath, 'runtime'), { recursive: true });
  const script = join(f.dir, 'append-events.mjs');
  writeFileSync(script, `import { event } from ${JSON.stringify(new URL('./runtime.mjs', import.meta.url).href)};\nevent({ package: process.argv[2], id: process.argv[3] }, 'probe', {});`);
  await Promise.all(Array.from({ length: 16 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, f.packagePath, `run-${i}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`append ${i} exited ${code}: ${err}`)));
  })));
  const lines = readFileSync(join(f.packagePath, 'runtime', 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 16, 'no append is lost');
  assert.deepEqual(lines.map(line => JSON.parse(line).run_id).sort(), Array.from({ length: 16 }, (_, i) => `run-${i}`).sort(), 'every line stays valid JSON');
});

test('wave runtime: a failed event lock append surfaces an explicit error', async t => {
  const f = await fixture(t, 'setInterval(() => {}, 1000);');
  mkdirSync(join(f.packagePath, 'runtime'), { recursive: true });
  const emptyPath = join(f.dir, 'empty-path');
  mkdirSync(emptyPath, { recursive: true });
  const previousPath = process.env.PATH;
  process.env.PATH = emptyPath;
  t.after(() => { process.env.PATH = previousPath; });
  assert.throws(() => event({ package: f.packagePath, id: 'run-lock' }, 'probe'), /Cannot append runtime event probe/, 'a missing lock command is surfaced, not silently dropped');
});

for (const code of [137, 143]) {
  test(`wave runtime: wait cleanup maps a confirmed stop that exits ${code} to cleanup, not a crash`, { timeout: 120000 }, async t => {
    const f = await fixture(t, `
      process.on('SIGTERM', () => { process.exit(${code}); });
      console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Retained handoff'}]}}));
      console.log(JSON.stringify({type:'agent_settled',aborted:false}));
      setInterval(() => {}, 1000);
    `);
    const launchProcess = f.options.launchProcess;
    f.options.launchProcess = (r, role, prompt, opts) => launchProcess(r, role, prompt, { ...opts, shutdownGraceMs: 25 });
    const runtime = new Runtime(f.options);
    const started = await runtime.start(f.input);
    const result = await f.finished;
    assert.equal(result.state, 'completed');
    assert.equal(result.shutdown_cleanup, true);
    assert.equal(result.error, undefined, 'a numeric cleanup exit is not reported as a crash');
    assert.equal(loadRun(f.packagePath, started.run_id).state, 'completed');
  });
}
