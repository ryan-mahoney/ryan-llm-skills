import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testCommands, readMetrics, metrics, formatMetrics } from './metrics.mjs';

const time = seconds => new Date(Date.parse('2026-10-05T10:00:00Z') + seconds * 1000).toISOString();
const message = (role, end, data) => ({ type: 'message', timestamp: time(end), message: { role, ...data } });
const assistant = (end, start, content = [], extra = {}) => message('assistant', end, { provider: 'provider', model: 'model', timestamp: Date.parse(time(start)), content, ...extra });
const call = (id, name, command) => ({ type: 'toolCall', id, name, arguments: { command } });
const result = (id, end, extra = {}) => message('toolResult', end, { toolCallId: id, ...extra });
// The package directory sits in a storage root (projects/demo/specs/feature) so spec-location accepts it.
async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'spec-metrics-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, 'projects/demo/specs/feature'), { recursive: true });
  await writeFile(path.join(base, 'projects/demo/kit.yaml'), 'id: demo\n');
  return path.join(base, 'projects/demo/specs/feature');
}
async function log(file, rows) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map(JSON.stringify).join('\n') + '\n');
}
const header = id => ({ type: 'session', id, timestamp: time(0), cwd: '/repo' });

test('package metrics expose managed final-review sessions and API writer telemetry separately', async t => {
  const dir = await fixture(t), root = path.join(dir, 'pi/root.jsonl'), decision = path.join(dir, 'pi/decision.jsonl');
  await log(root, [header('root'), assistant(1, 0)]);
  await log(decision, [header('decision'), assistant(3, 2)]);
  await mkdir(path.join(dir, 'runtime/runs/run-edits/edit'), { recursive: true });
  await writeFile(path.join(dir, 'runtime/runs/run.json'), JSON.stringify({ id: 'run', parent_session: root,
    decision_session: decision, stage: { role: 'decision', kind: 'final-review' },
    started_at: time(0), finished_at: time(5), state: 'completed', writing_route: 'changeset-v1' }));
  await writeFile(path.join(dir, 'runtime/runs/run-edits/edit/summary.json'), JSON.stringify({ schema_version: 1,
    run_id: 'run', edit_id: 'edit', status: 'failed', publication: 'not-published',
    calls: [{ stage: 'writer', selector: 'fixture/writer:off', status: 'failed', usage: null }] }));
  const data = await metrics(dir, { now: Date.parse(time(10)) });
  assert.equal(data.agents.find(agent => agent.role === 'final-review').model_calls, 1);
  assert.equal(data.totals.model_calls, 2);
  assert.equal(data.changesets.totals.writer_calls, 1);
  assert.equal(data.changesets.totals.failed, 1);
  assert.equal(data.changesets.totals.unknown_usage_calls, 1);
  assert.match(formatMetrics(data), /1 failed/);
});

test('test detection counts submissions, ignores quoted mentions, and handles common runners', () => {
  assert.deepEqual(testCommands('echo "mix test"; grep "pytest" log.txt; cat test/foo.exs'), []);
  assert.deepEqual(testCommands('cd /repo&&MIX_ENV=test mix test test/foo.exs | tail -10; timeout 120 npm run test:unit'), ['mix test', 'npm test-script']);
  assert.deepEqual(testCommands("python3 - <<'PY'\nprint('mix test')\nPY"), []);
  assert.deepEqual(testCommands('python3 -m pytest x.py && node --test x.test.mjs'), ['python -m pytest', 'node --test']);
  assert.deepEqual(testCommands('mix compile; mix format; git status'), []);
});

test('test detection unwraps literal shell commands without interpreting quoted examples or dynamic code', () => {
  assert.deepEqual(testCommands("bash -lc 'cd /repo && mix test test/a.exs; exit $?'"), ['mix test']);
  assert.deepEqual(testCommands('env MIX_ENV=test timeout 20 /bin/bash -lc "mix test a.exs | tail -5"'), ['mix test']);
  assert.deepEqual(testCommands("bash -lc 'echo \"mix test\"; grep \"pytest\" log; bash -c \"node --test a.mjs\"'"), ['node --test']);
  assert.deepEqual(testCommands('bash -lc "$COMMAND"'), []);
  assert.deepEqual(testCommands('bash -lc "$(cat command.txt)"'), []);
  assert.deepEqual(testCommands("echo \"bash -lc 'mix test'\""), []);
});

test('test command results distinguish pending submissions, failed tools and structured exits without claiming suite passes', async t => {
  const dir = await fixture(t), file = path.join(dir, 'session.jsonl');
  await log(file, [header('counts'),
    assistant(1, 0, [call('failed', 'spec_verify', "bash -lc 'mix test'")]), result('failed', 2, { isError: true, details: { exit_code: 1 } }),
    assistant(3, 2, [call('unknown', 'bash', 'pytest')]), result('unknown', 4),
    assistant(5, 4, [call('pending', 'spec_verify', 'node --test file.mjs')])]);
  const a = (await readMetrics({ file, role: 'owner' })).agents[0];
  assert.equal(a.test_command_calls, 3);
  assert.equal(a.test_command_results, 2);
  assert.equal(a.test_command_failures, 1);
  assert.equal(a.test_commands_with_exit, 1);
});

test('mise exec commands and native verification receipts count real submissions and failures', async t => {
  assert.deepEqual(testCommands('PGHOST=127.0.0.1 mise exec -- mix test test/search_test.exs'), ['mix test']);
  assert.deepEqual(testCommands('/opt/bin/mise x elixir@1.18 -- mix test'), ['mix test']);
  for (const command of ['mise run test', 'mise exec mix test', 'echo "mise exec -- mix test"', 'mise exec -- echo "mix test"', 'mise exec "$TOOLS" -- mix test'])
    assert.deepEqual(testCommands(command), [], command);
  const dir = await fixture(t), file = path.join(dir, 'session.jsonl');
  await log(file, [header('mise'),
    assistant(1, 0, [call('failure', 'spec_verify', 'mise exec -- mix test')]),
    result('failure', 2, { content: [{ type: 'text', text: JSON.stringify({ receipt_id: 'r1', exit_code: 1 }) }] }),
    assistant(3, 2, [call('success', 'spec_verify', 'mise exec -- mix test')]),
    result('success', 4, { content: [{ type: 'text', text: JSON.stringify({ receipt_id: 'r2', exit_code: 0 }) }] }),
    assistant(5, 4, [call('untrusted', 'bash', 'mise exec -- mix test')]),
    result('untrusted', 6, { content: [{ type: 'text', text: '{"receipt_id":"r3","exit_code":1}' }] })]);
  const a = (await readMetrics({ file, role: 'owner' })).agents[0];
  assert.equal(a.test_command_calls, 3);
  assert.equal(a.test_command_results, 3);
  assert.equal(a.test_command_failures, 1);
  assert.equal(a.test_commands_with_exit, 2);
});

test('startup counts stop at dispatch; transport errors and successful checkout edits stay distinct', async t => {
  const dir = await fixture(t), file = path.join(dir, 'session.jsonl');
  await log(file, [header('startup'), message('user', 0, {}),
    assistant(2, 1, [call('read', 'read'), call('bash', 'bash', 'git status')]), result('read', 3), result('bash', 3),
    assistant(5, 4, [], { stopReason: 'error', errorMessage: 'Connection error' }),
    assistant(8, 6, [], { stopReason: 'error', errorMessage: 'upstream timeout' }),
    assistant(9, 8, [{ type: 'toolCall', id: 'artifact', name: 'write', arguments: { path: '.specs/x/result.md' } }]), result('artifact', 10),
    assistant(11, 10, [{ type: 'toolCall', id: 'bad', name: 'edit', arguments: { path: 'src/code.js' } }]), result('bad', 12, { isError: true }),
    assistant(13, 12, [{ type: 'toolCall', id: 'good', name: 'edit', arguments: { path: 'src/code.js' } }]), result('good', 14)]);
  const data = await readMetrics({ file, role: 'coordinator', firstDispatch: Date.parse(time(5)), checkout: dir });
  assert.deepEqual(data.startup, { model_calls: 2, tool_calls: 2, reads: 1, shell_calls: 1 });
  assert.equal(data.agents[0].connection_errors, 1);
  assert.equal(data.agents[0].timeout_errors, 1);
  assert.deepEqual(data.successfulEdits, [Date.parse(time(14))]);
});

test('separates model response time from delegation and overlapping tool waits with usage coverage', async t => {
  const dir = await fixture(t), file = path.join(dir, 'session.jsonl');
  await log(file, [header('s'), message('user', 0, { content: 'private prompt' }),
    assistant(3, 1, [call('a', 'spec_editor'), call('b', 'read')], { usage: { input: 20, output: 5, cost: { total: 0 } } }),
    result('b', 4), result('a', 20), assistant(24, 21, [call('c', 'spec_verify', 'mix test')]), result('c', 30, { isError: true }),
    message('assistant', 32, { content: [], provider: 'other', model: 'unknown', usage: undefined })]);
  const data = await readMetrics({ file, role: 'owner' });
  const a = data.agents[0];
  assert.equal(a.model_calls, 2); assert.equal(a.model_response_seconds, 5);
  assert.equal(a.delegation_wait_upper_bound_seconds, 17); assert.equal(a.tool_wait_upper_bound_seconds, 7);
  assert.equal(a.test_command_calls, 1); assert.equal(a.tool_errors, 1);
  assert.equal(a.reported_cost, 0); assert.equal(a.priced_model_calls, 1);
  assert.equal(data.agents[1].timed_model_calls, 0); assert.equal(data.agents[1].reported_cost, null);
  assert.equal(JSON.stringify(data).includes('private prompt'), false);
  assert.equal(JSON.stringify(data).includes('mix test'), false);
});

test('package metrics isolate retained sessions, find async reviewers, and keep repeated step attempts separate', async t => {
  const dir = await fixture(t), root = path.join(dir, 'pi', 'root.jsonl'), old = path.join(dir, 'pi', 'old.jsonl');
  const owner = path.join(dir, 'runtime/sessions/pair/owner.jsonl'), editor = path.join(dir, 'runtime/sessions/pair/editor.jsonl');
  const reviewer = path.join(dir, 'pi/root/review/run-0/session.jsonl');
  await log(root, [header('root'), message('user', 100, { content: 'run' }), assistant(102, 101)]);
  await log(old, [header('old'), message('user', 0, {}), assistant(2, 1)]);
  await log(owner, [header('owner'), assistant(10, 5), assistant(115, 110, [call('a', 'spec_verify', 'mix test')]), result('a', 120), assistant(140, 130)]);
  await log(editor, [header('editor'), assistant(116, 114, [{ type: 'toolCall', id: 'edit', name: 'edit', arguments: { path: 'src/code.js' } }], { model: 'editor' }), result('edit', 117)]);
  await log(reviewer, [header('review'), { type: 'session_info', name: 'spec-stage-reviewer: private assignment' }, assistant(130, 125, [], { model: 'reviewer' })]);
  await mkdir(path.join(dir, 'runtime/runs'), { recursive: true });
  await writeFile(path.join(dir, 'runtime/runs', 'abandoned.json'), JSON.stringify({ id: 'abandoned', parent_session: old,
    owner_session: path.join(dir, 'missing-historical-owner.jsonl'), started_at: time(-10), finished_at: time(-5), state: 'cancelled' }));
  for (const [id, parent, start, finish] of [['old', old, 0, 20], ['first', root, 105, 125], ['retry', root, 128, 145]]) {
    await writeFile(path.join(dir, 'runtime/runs', id + '.json'), JSON.stringify({ id, parent_session: parent, owner_session: owner, editor_session: editor,
      checkout: dir, dispatch_requested_at: time(start - 1), step: '/canonical/step-003-subspec.md', started_at: time(start), finished_at: time(finish), state: 'completed', assignment_id: id }));
  }
  await log(path.join(dir, 'runtime/events.jsonl'), [{ event: 'editor_started', run_id: 'first', timestamp: time(114) }, { event: 'editor_finished', run_id: 'first', timestamp: time(118), state: 'completed' }]);
  const data = await metrics(dir, { now: Date.parse(time(150)) });
  assert.equal(data.totals.model_calls, 5); assert.equal(data.steps.length, 2);
  assert.deepEqual(data.discovery_errors, []);
  assert.equal(data.agents.find(a => a.role === 'owner').model_calls, 2);
  assert.equal(data.agents.find(a => a.role === 'reviewer').model_calls, 1);
  assert.equal(data.process.observed_span_seconds, 40);
  assert.equal(data.process.completion, 'not_inferred_from_agent_exit');
  assert.equal(data.leaders.model_response_seconds.role, 'owner');
  assert.equal(data.steps[0].elapsed_seconds, 20);
  assert.equal(data.startup.session_to_first_owner_seconds, 5);
  assert.equal(data.startup.model_calls, 1);
  assert.equal(data.steps[0].dispatch_to_owner_seconds, 1);
  assert.equal(data.steps[0].first_editor_seconds, 9);
  assert.equal(data.steps[0].editor_to_first_checkout_edit_seconds, 3);
  assert.equal(data.steps[1].editor_to_first_checkout_edit_seconds, null);
  assert.equal((await metrics(dir, { allSessions: true, now: Date.parse(time(150)) })).totals.model_calls, 7);
  assert.match(formatMetrics(data), /completion not inferred/);
  assert.equal(JSON.stringify(data).includes('private assignment'), false);
});

test('live and bounded transcripts report gaps instead of guessing completion', async t => {
  const dir = await fixture(t), file = path.join(dir, 'session.jsonl');
  await log(file, [header('s'), assistant(3, 1, [call('pending', 'spec_verify', 'pytest')])]);
  await writeFile(file, '{"partial":', { flag: 'a' });
  const data = await readMetrics({ file, role: 'owner' });
  assert.equal(data.coverage.malformed_lines, 1); assert.equal(data.coverage.unresolved_tool_calls, 1);
  assert.equal((await readMetrics({ file, role: 'owner' }, { maxBytes: 20 })).coverage.truncated, true);
});

test('completion reports separate subsequent checks', async t => {
  const dir = await fixture(t), root = path.join(dir, 'pi/root.jsonl');
  const summary = `outcome: published\nspec-folder: ${dir}\npr: https://example.test/pr/3\nblocker: none`;
  await log(root, [header('root'), message('user', 0, {}),
    assistant(10, 8, [{ type: 'thinking', thinking: '```txt\n' + summary + '\n```' }], { stopReason: 'stop' }),
    assistant(20, 18, [{ type: 'text', text: '```txt\n' + summary + '\n```' }], { stopReason: 'stop' }),
    assistant(25, 24, [call('test', 'bash', 'node --test x.test.mjs')]), result('test', 30)]);
  await mkdir(path.join(dir, 'runtime/runs'), { recursive: true });
  await writeFile(path.join(dir, 'runtime/runs/run.json'), JSON.stringify({ id: 'run', parent_session: root, started_at: time(0), finished_at: time(15), state: 'completed' }));
  const entry = { parent_session: root, url: 'https://example.test/pr/3', submitted_at: time(16) };
  const receiptOf = target => ({ schema_version: 1, kind: 'pr_submission', package_ref: 'demo/feature', targets: { alpha: target } });
  const receipt = receiptOf(entry);
  await writeFile(path.join(dir, 'pr-url.json'), JSON.stringify(receipt));
  const data = await metrics(dir, { now: Date.parse(time(40)) });
  assert.equal(data.process.elapsed_to_completion_report_seconds, 20);
  assert.equal(data.process.post_completion_activity_seconds, 10);
  assert.match(formatMetrics(data), /completion reported by coordinator/);
  assert.deepEqual(data.process.milestones.map(m => m.kind), ['pr_submitted', 'coordinator_completion_reported']);
  for (const stale of [receiptOf({ ...entry, parent_session: '/another/run.jsonl' }), { ...receipt, package_ref: 'demo/another' }, receiptOf({ ...entry, submitted_at: time(-1) }), receiptOf({ ...entry, submitted_at: time(50) })]) {
    await writeFile(path.join(dir, 'pr-url.json'), JSON.stringify(stale));
    assert.equal((await metrics(dir, { now: Date.parse(time(40)) })).process.milestones.length, 1);
  }
  // A receipt and terminal run state never establish coordinator completion.
  await log(root, [header('root'), message('user', 0, {}), assistant(10, 8)]);
  await writeFile(path.join(dir, 'pr-url.json'), JSON.stringify(receipt));
  const publicationOnly = await metrics(dir, { now: Date.parse(time(40)) });
  assert.equal(publicationOnly.process.completion_reported_at, null);
  assert.equal(publicationOnly.process.completion, 'not_inferred_from_agent_exit');
  assert.equal(publicationOnly.process.milestones[0].kind, 'pr_submitted');
});

test('every fresh editor session contributes once to the run metrics', async t => {
  const dir = await fixture(t), root = path.join(dir, 'pi/root.jsonl');
  const owner = path.join(dir, 'pi/owner.jsonl');
  const editors = [path.join(dir, 'pi/editors/a.jsonl'), path.join(dir, 'pi/editors/b.jsonl')];
  await log(root, [header('root'), assistant(1, 0)]);
  await log(owner, [header('owner'), assistant(3, 2)]);
  for (const [i, file] of editors.entries()) await log(file, [header(`editor-${i}`), assistant(5 + i, 4 + i)]);
  await mkdir(path.join(dir, 'runtime/sessions'), { recursive: true });
  await mkdir(path.join(dir, 'runtime/runs'), { recursive: true });
  await writeFile(path.join(dir, 'runtime/runs/run.json'), JSON.stringify({ id: 'run', parent_session: root, owner_session: owner,
    editor_session: path.join(dir, 'unused-anchor.jsonl'), started_at: time(0), finished_at: time(10), state: 'completed' }));
  await writeFile(path.join(dir, 'runtime/runs/run-editor-sessions.json'), JSON.stringify(editors));
  const data = await metrics(dir, { now: Date.parse(time(15)) });
  assert.equal(data.totals.model_calls, 4);
  assert.equal(data.agents.filter(a => a.role === 'editor').reduce((n, a) => n + a.model_calls, 0), 2);
  assert.deepEqual(data.discovery_errors, []);
});

test('wave observation: metrics separate barrier wait, resource queue and integration time across five- and nine-member waves', async t => {
  const dir = await fixture(t);
  const runDir = path.join(dir, 'runtime/runs'), waveDir = path.join(dir, 'runtime/waves');
  await mkdir(runDir, { recursive: true }); await mkdir(waveDir, { recursive: true });
  const stepFile = n => path.join(dir, `step-${String(n).padStart(3, '0')}-subspec.md`);
  const A = path.join(dir, 'pi/coordinator-a.jsonl'), B = path.join(dir, 'pi/coordinator-b.jsonl');
  // Production-shaped step index: steps 1-5 stand alone; 6-14 require step 1; 15 requires step 6.
  const steps = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(step => ({
    step, name: `Step ${step}`, description: `Step ${step}`, difficulty: 'medium', visualDesign: false, evidence: [],
    ...(step >= 6 && step <= 14 ? { requires: [1] } : {}), ...(step === 15 ? { requires: [6] } : {}) }));
  await writeFile(path.join(dir, 'spec-steps.json'), JSON.stringify({ steps }, null, 2));
  const effective_limits = { software_ceiling: 16, explicit_cap: null, memory: { slots: 9 }, tasks: { slots: 9 }, binding: 'overlayfs', source: 'host-policy' };
  // A member transition sequence plus its workspace binding. Times are strictly ordered.
  const member = (step, phases) => ({ step, attempt: 1, attempt_id: `attempt-${step}`,
    phase: phases[phases.length - 1].phase, queue_reason: phases[phases.length - 1].reason ?? null,
    transitions: phases.map(p => ({ phase: p.phase, at: time(p.at), reason: p.reason ?? null })),
    owner_model: null, resume: 0, run_id: phases[phases.length - 1].run_id ?? null, implementation_run_id: null,
    base_commit: null, head_commit: null, sealed_head: null, retention_ref: null, review_artifacts: [], ownership_adaptations: [],
    repair: null, blocking_reason: null, interrupted_at: null,
    workspace: { backend: 'overlayfs', backendReason: null, merged: path.join(dir, 'attempts', `attempt-${step}`, 'merged') },
    preparation_receipt: null });
  // Wave record in production shape: members keyed by step string, transitions carry state changes.
  const wave = (wave_id, members, transitions, requested_width, admitted_width) => ({ version: 1, wave_id, generation: 1, revision: 0,
    state: transitions[transitions.length - 1].state, transitions: transitions.map(x => ({ state: x.state, at: time(x.at) })),
    package_ref: 'demo/feature', package: dir, started_at: time(transitions[0].at), requested_width, admitted_width,
    effective_limits, members: Object.fromEntries(members.map(m => [String(m.step), m])) });
  // Member 3 runs the fix/confirm detour; the rest seal together.
  const w1members = [1, 2, 4, 5].map(step => member(step, [
    { phase: 'provisioning', at: 0 }, { phase: 'implementing', at: 10 }, { phase: 'reviewing', at: 40 }, { phase: 'sealed', at: 45 }]))
    .concat([member(3, [
      { phase: 'provisioning', at: 0 }, { phase: 'implementing', at: 10 }, { phase: 'reviewing', at: 40 },
      { phase: 'fixing', at: 50 }, { phase: 'confirming', at: 60 }, { phase: 'sealed', at: 75 }])]);
  await writeFile(path.join(waveDir, 'w1.json'), JSON.stringify(wave('w1', w1members, [
    { state: 'running', at: 0 }, { state: 'ready-to-integrate', at: 75 }, { state: 'integrating', at: 90 },
    { state: 'verifying', at: 100 }, { state: 'promoting', at: 110 }, { state: 'integrated', at: 115 }], 5, 5)));
  const w2members = [6, 7, 8, 9, 10, 11, 12, 13, 14].map(step => member(step, [
    { phase: 'provisioning', at: 115 }, { phase: 'implementing', at: 120 }, { phase: 'reviewing', at: 180 },
    { phase: 'sealed', at: step === 6 ? 190 : 205 }]));
  await writeFile(path.join(waveDir, 'w2.json'), JSON.stringify(wave('w2', w2members, [
    { state: 'running', at: 115 }, { state: 'integrating', at: 205 }, { state: 'verifying', at: 215 },
    { state: 'promoting', at: 225 }, { state: 'integrated', at: 230 }], 9, 9)));
  // w3 opens behind the w2 barrier and queues its only member for the task budget.
  const w3members = [member(15, [
    { phase: 'queued', at: 230, reason: 'task-budget' }, { phase: 'provisioning', at: 240 },
    { phase: 'implementing', at: 245 }])];
  await writeFile(path.join(waveDir, 'w3.json'), JSON.stringify(wave('w3', w3members, [{ state: 'running', at: 230 }], 1, 1)));
  // Run records carry wave_bindings, never a top-level wave_id. Phase and run window are explicit.
  const run = (id, parent, wave_id, step, phase, started, finished, state = 'completed') => ({ id, package: dir, package_ref: 'demo/feature',
    primary: dir, step: stepFile(step), target: 'demo', checkout: path.join(dir, 'attempts', `attempt-${step}`, 'merged'),
    state, started_at: time(started), finished_at: finished === null ? null : time(finished), parent_session: parent,
    owner_session: null, editor_session: null, wave_bindings: { wave_id, generation: 1, step_number: step, phase, target: 'demo', backend: 'overlayfs', base_commit: null } });
  const owners = [];
  for (const step of [1, 2, 3, 4, 5]) owners.push(run(`w1-owner-${step}`, A, 'w1', step, 'implementing', 10, 40));
  for (const step of [6, 7, 8, 9, 10, 11, 12, 13, 14]) owners.push(run(`w2-owner-${step}`, B, 'w2', step, 'implementing', 120, 180));
  owners.push(run('w3-owner-15', B, 'w3', 15, 'implementing', 245, null, 'running'));
  await writeFile(path.join(runDir, 'w1-owner-3-reviewing.json'), JSON.stringify(run('w1-owner-3-reviewing', A, 'w1', 3, 'reviewing', 40, 50)));
  await writeFile(path.join(runDir, 'w1-owner-3-fixing.json'), JSON.stringify(run('w1-owner-3-fixing', A, 'w1', 3, 'fixing', 50, 60)));
  await writeFile(path.join(runDir, 'w1-owner-3-confirming.json'), JSON.stringify(run('w1-owner-3-confirming', A, 'w1', 3, 'confirming', 60, 70)));
  for (const record of owners) await writeFile(path.join(runDir, `${record.id}.json`), JSON.stringify(record));
  // The reviewer run reviews step 3 while the fixer waits; each carries its own wave binding.
  await writeFile(path.join(runDir, 'w1-step-3-reviewer.json'), JSON.stringify({ id: 'w1-step-3-reviewer', package: dir, package_ref: 'demo/feature', primary: dir,
    step: stepFile(3), target: 'demo', checkout: path.join(dir, 'attempts', 'attempt-3', 'merged'), state: 'completed',
    started_at: time(45), finished_at: time(60), parent_session: A, owner_session: null, editor_session: null,
    wave_bindings: { wave_id: 'w1', generation: 1, step_number: 3, phase: 'reviewing', target: 'demo', backend: 'overlayfs', base_commit: null } }));
  await writeFile(path.join(runDir, 'w1-step-3-fixer.json'), JSON.stringify({ id: 'w1-step-3-fixer', package: dir, package_ref: 'demo/feature', primary: dir,
    step: stepFile(3), target: 'demo', checkout: path.join(dir, 'attempts', 'attempt-3', 'merged'), state: 'completed',
    started_at: time(50), finished_at: time(60), parent_session: A, owner_session: null, editor_session: null,
    wave_bindings: { wave_id: 'w1', generation: 1, step_number: 3, phase: 'fixing', target: 'demo', backend: 'overlayfs', base_commit: null } }));
  await writeFile(path.join(runDir, 'w1-step-3-confirmer.json'), JSON.stringify({ id: 'w1-step-3-confirmer', package: dir, package_ref: 'demo/feature', primary: dir,
    step: stepFile(3), target: 'demo', checkout: path.join(dir, 'attempts', 'attempt-3', 'merged'), state: 'completed',
    started_at: time(60), finished_at: time(70), parent_session: A, owner_session: null, editor_session: null,
    wave_bindings: { wave_id: 'w1', generation: 1, step_number: 3, phase: 'confirming', target: 'demo', backend: 'overlayfs', base_commit: null } }));
  // Exactly one assistant message per named session window. Editors hang off member 3's owner run.
  const editorA = path.join(dir, 'pi/editors/a.jsonl'), editorB = path.join(dir, 'pi/editors/b.jsonl');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'w1-owner-3-editor-sessions.json'), JSON.stringify([editorA, editorB]));
  await log(A, [header('A'), message('user', 0, {}), assistant(20, 15, [{ type: 'text', text: 'coordinating wave one' }])]);
  await log(B, [header('B'), message('user', 0, {}), assistant(130, 125, [{ type: 'text', text: 'coordinating waves two and three' }])]);
  await log(path.join(dir, 'pi/owner-3.jsonl'), [header('owner-3'), assistant(30, 25, [{ type: 'text', text: 'implementing step three' }])]);
  await writeFile(path.join(runDir, 'w1-owner-3.json'), JSON.stringify({ ...run('w1-owner-3', A, 'w1', 3, 'implementing', 10, 40),
    owner_session: path.join(dir, 'pi/owner-3.jsonl') }));
  for (const [id, file] of [['w1-owner-3-reviewing', 'pi/reviewer-3.jsonl'], ['w1-owner-3-fixing', 'pi/fixer-3.jsonl'], ['w1-owner-3-confirming', 'pi/confirmer-3.jsonl']]) {
    await writeFile(path.join(runDir, `${id}.json`), JSON.stringify({ ...run(id, A, 'w1', 3, id.split('-').pop(), 40, 70),
      owner_session: path.join(dir, file) }));
  }
  await log(editorA, [header('editor-a'), assistant(35, 32, [{ type: 'text', text: 'editing attempt three' }])]);
  await log(editorB, [header('editor-b'), assistant(37, 34, [{ type: 'text', text: 'editing attempt three again' }])]);
  await log(path.join(dir, 'pi/reviewer-3.jsonl'), [header('reviewer-3'), assistant(48, 46, [{ type: 'text', text: 'reviewing step three' }])]);
  await log(path.join(dir, 'pi/fixer-3.jsonl'), [header('fixer-3'), assistant(55, 52, [{ type: 'text', text: 'fixing step three' }])]);
  await log(path.join(dir, 'pi/confirmer-3.jsonl'), [header('confirmer-3'), assistant(65, 62, [{ type: 'text', text: 'confirming step three' }])]);

  const result = await metrics(dir, { now: Date.parse(time(300)) });
  assert.equal(result.scope, 'all_wave_coordinator_sessions');
  assert.deepEqual(new Set(result.coordinator_sessions), new Set([A, B]));
  assert.equal(result.totals.model_calls, 8);
  const role = name => result.agents.filter(a => a.role === name).reduce((n, a) => n + a.model_calls, 0);
  assert.equal(role('coordinator'), 2); assert.equal(role('owner'), 1); assert.equal(role('editor'), 2);
  assert.equal(role('reviewer'), 2); assert.equal(role('fixer'), 1);
  const byId = Object.fromEntries(result.waves.map(w => [w.wave_id, w]));
  assert.equal(byId.w1.peak_observed_overlap, 5); assert.equal(byId.w2.peak_observed_overlap, 9); assert.equal(byId.w3.peak_observed_overlap, 1);
  assert.equal(byId.w1.requested_width, 5); assert.equal(byId.w1.admitted_width, 5);
  assert.equal(byId.w2.requested_width, 9); assert.equal(byId.w2.admitted_width, 9);
  assert.equal(byId.w1.integration_seconds, 25); assert.equal(byId.w1.elapsed_accepted_wave_seconds, 115);
  assert.deepEqual(byId.w1.phase_seconds, { setup: 50, implementation: 150, review: 45, fix: 10, queued: 0 });
  assert.equal(byId.w2.integration_seconds, 25);
  assert.deepEqual(byId.w2.effective_limits, effective_limits);
  assert.deepEqual(byId.w3.queue.by_reason, { 'task-budget': 10 });
  assert.equal(byId.w3.elapsed_accepted_wave_seconds, null);
  assert.equal(byId.w3.elapsed_to_snapshot_seconds, 70);
  const waits = Object.fromEntries(result.barrier_waits.map(r => [r.step, r]));
  for (const step of [6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    assert.equal(waits[step].waiting_on_barrier_seconds, 70);
    assert.deepEqual(waits[step].barrier_wave_ids, ['w1']);
    assert.equal(waits[step].end_reason, 'integrated');
  }
  assert.equal(waits[15].wave_id, 'w3'); assert.equal(waits[15].waiting_on_barrier_seconds, 40);
  assert.deepEqual(waits[15].barrier_wave_ids, ['w2']); assert.equal(waits[15].end_reason, 'integrated');
  assert.doesNotMatch(JSON.stringify(result), /speedup/i);
  assert.doesNotMatch(formatMetrics(result), /speedup/i);
  assert.ok(result.limits.includes('Wave overlap, queue, barrier and integration times are observed scheduling facts for this run; synthetic or loopback providers establish no provider throughput or cost improvement.'));
});

test('wave observation: metrics report backend, fallback, setup time and retained layer storage without reading merged views', async t => {
  const dir = await fixture(t);
  const runDir = path.join(dir, 'runtime/runs'), waveDir = path.join(dir, 'runtime/waves');
  await mkdir(runDir, { recursive: true }); await mkdir(waveDir, { recursive: true });
  const stepFile = n => path.join(dir, `step-${String(n).padStart(3, '0')}-subspec.md`);
  const A = path.join(dir, 'pi/coordinator.jsonl');
  const steps = [1, 2, 3].map(step => ({ step, name: `Step ${step}`, description: `Step ${step}`, difficulty: 'medium', visualDesign: false, evidence: [] }));
  await writeFile(path.join(dir, 'spec-steps.json'), JSON.stringify({ steps }, null, 2));
  // Retained layer directories: lower shared by members 1 and 3, upper/gitDir per member, worktree for the fallback member.
  const lower = path.join(dir, 'state/snapshots/s1/lower');
  const upper1 = path.join(dir, 'state/snapshots/s1/upper'), upper3 = path.join(dir, 'state/snapshots/s3/upper');
  const git1 = path.join(dir, 'state/snapshots/s1/git'), git3 = path.join(dir, 'state/snapshots/s3/git');
  const work2 = path.join(dir, 'state/worktrees/attempt-2');
  await mkdir(lower, { recursive: true }); await mkdir(upper1, { recursive: true }); await mkdir(upper3, { recursive: true });
  await mkdir(git1, { recursive: true }); await mkdir(git3, { recursive: true }); await mkdir(work2, { recursive: true });
  await writeFile(path.join(lower, 'shared.bin'), Buffer.alloc(2000));
  await writeFile(path.join(upper1, 'up.bin'), Buffer.alloc(1000));
  await writeFile(path.join(git1, 'pack'), Buffer.alloc(500));
  await writeFile(path.join(upper3, 'up.bin'), Buffer.alloc(100));
  await writeFile(path.join(git3, 'pack'), Buffer.alloc(50));
  await writeFile(path.join(work2, 'work.bin'), Buffer.alloc(300));
  // Merged views and work directories are present but must never be counted.
  const merged = path.join(dir, 'attempts/attempt-1/merged'), work = path.join(dir, 'attempts/attempt-1/work');
  await mkdir(merged, { recursive: true }); await mkdir(work, { recursive: true });
  await writeFile(path.join(merged, 'merged.bin'), Buffer.alloc(7777));
  await writeFile(path.join(work, 'work.bin'), Buffer.alloc(9999));
  const member = (step, phases, workspace) => ({ step, attempt: 1, attempt_id: `attempt-${step}`,
    phase: phases[phases.length - 1].phase, queue_reason: null,
    transitions: phases.map(p => ({ phase: p.phase, at: time(p.at), reason: null })),
    owner_model: null, resume: 0, run_id: null, implementation_run_id: null, base_commit: null, head_commit: null,
    sealed_head: null, retention_ref: null, review_artifacts: [], ownership_adaptations: [], repair: null,
    blocking_reason: null, interrupted_at: null, workspace, preparation_receipt: null });
  const w1members = [
    member(1, [{ phase: 'provisioning', at: 0 }, { phase: 'implementing', at: 12 }],
      { backend: 'overlayfs', backendReason: null, merged, snapshotId: 's1', retained: { lower, upper: upper1, gitDir: git1 } }),
    member(2, [{ phase: 'provisioning', at: 0 }, { phase: 'implementing', at: 3 }],
      { backend: 'worktree', backendReason: 'userns-denied', worktree: work2, retained: { worktree: work2 } }),
    member(3, [{ phase: 'provisioning', at: 0 }, { phase: 'implementing', at: 5 }],
      { backend: 'overlayfs', backendReason: null, merged: path.join(dir, 'attempts/attempt-3/merged'), snapshotId: 's1', retained: { lower, upper: upper3, gitDir: git3 } })];
  await writeFile(path.join(waveDir, 'w1.json'), JSON.stringify({ version: 1, wave_id: 'w1', generation: 1, revision: 0, state: 'running',
    transitions: [{ state: 'running', at: time(0) }], package_ref: 'demo/feature', package: dir, started_at: time(0),
    requested_width: 3, admitted_width: 3, members: Object.fromEntries(w1members.map(m => [String(m.step), m])) }));
  const run = (id, step, phase, started, finished, state = 'completed') => ({ id, package: dir, package_ref: 'demo/feature',
    primary: dir, step: stepFile(step), target: 'demo', checkout: path.join(dir, 'attempts', `attempt-${step}`, 'merged'),
    state, started_at: time(started), finished_at: finished === null ? null : time(finished), parent_session: A,
    owner_session: null, editor_session: null,
    wave_bindings: { wave_id: 'w1', generation: 1, step_number: step, phase, target: 'demo', backend: 'overlayfs', base_commit: null } });
  for (const [id, step, phase, started, finished] of [
    ['w1-owner-1', 1, 'implementing', 12, 40], ['w1-owner-2', 2, 'implementing', 3, 40], ['w1-owner-3', 3, 'implementing', 5, 40]]) {
    await writeFile(path.join(runDir, `${id}.json`), JSON.stringify(run(id, step, phase, started, finished)));
  }
  await log(A, [header('A'), message('user', 0, {}), assistant(20, 15, [{ type: 'text', text: 'observing storage' }])]);
  const result = await metrics(dir, { now: Date.parse(time(60)) });
  assert.deepEqual(result.waves[0].members.map(m => ({ step: m.step, backend: m.backend, fallback_reason: m.fallback_reason, setup_seconds: m.setup_seconds })),
    [{ step: 1, backend: 'overlayfs', fallback_reason: null, setup_seconds: 12 },
      { step: 2, backend: 'worktree', fallback_reason: 'userns-denied', setup_seconds: 3 },
      { step: 3, backend: 'overlayfs', fallback_reason: null, setup_seconds: 5 }]);
  assert.deepEqual(result.waves[0].storage, { lower_bytes: 2000, upper_bytes: 1100, git_bytes: 550, worktree_bytes: 300, truncated: false, unreadable: 0 });
});

test('wave observation: barrier waits end at blocked or cancelled terminal states and open waits run to the snapshot', async t => {
  const build = async terminal => {
    const dir = await fixture(t);
    const runDir = path.join(dir, 'runtime/runs'), waveDir = path.join(dir, 'runtime/waves');
    await mkdir(runDir, { recursive: true }); await mkdir(waveDir, { recursive: true });
    const stepFile = n => path.join(dir, `step-${String(n).padStart(3, '0')}-subspec.md`);
    const A = path.join(dir, 'pi/coordinator.jsonl');
    const steps = [{ step: 1, name: 'Step 1', description: 'Step 1', difficulty: 'medium', visualDesign: false, evidence: [] },
      { step: 2, name: 'Step 2', description: 'Step 2', difficulty: 'medium', visualDesign: false, evidence: [], requires: [1] }];
    await writeFile(path.join(dir, 'spec-steps.json'), JSON.stringify({ steps }, null, 2));
    const member1 = { step: 1, attempt: 1, attempt_id: 'attempt-1', phase: 'sealed', queue_reason: null,
      transitions: [{ phase: 'provisioning', at: time(0) }, { phase: 'implementing', at: time(2) }, { phase: 'sealed', at: time(10) }],
      owner_model: null, resume: 0, run_id: 'r1', implementation_run_id: null, base_commit: null, head_commit: null,
      sealed_head: null, retention_ref: null, review_artifacts: [], ownership_adaptations: [], repair: null,
      blocking_reason: null, interrupted_at: null,
      workspace: { backend: 'overlayfs', backendReason: null, merged: path.join(dir, 'attempts/attempt-1/merged') }, preparation_receipt: null };
    const transitions = terminal === 'running' ? [{ state: 'running', at: 0 }]
      : [{ state: 'running', at: 0 }, { state: terminal, at: terminal === 'blocked' ? 50 : 30 }];
    await writeFile(path.join(waveDir, 'w1.json'), JSON.stringify({ version: 1, wave_id: 'w1', generation: 1, revision: 0,
      state: transitions[transitions.length - 1].state, transitions: transitions.map(x => ({ state: x.state, at: time(x.at) })),
      package_ref: 'demo/feature', package: dir, started_at: time(0), requested_width: 1, admitted_width: 1,
      members: { 1: member1 } }));
    const r1 = { id: 'r1', package: dir, package_ref: 'demo/feature', primary: dir, step: stepFile(1), target: 'demo',
      checkout: path.join(dir, 'attempts/attempt-1/merged'), state: 'completed', started_at: time(2), finished_at: time(10),
      parent_session: A, owner_session: null, editor_session: null,
      wave_bindings: { wave_id: 'w1', generation: 1, step_number: 1, phase: 'implementing', target: 'demo', backend: 'overlayfs', base_commit: null } };
    await writeFile(path.join(runDir, 'r1.json'), JSON.stringify(r1));
    await log(A, [header('A'), message('user', 0, {}), assistant(5, 3, [{ type: 'text', text: 'coordinating' }])]);
    return dir;
  };
  const blocked = await build('blocked');
  const cancelled = await build('cancelled');
  const open = await build('running');
  const now = Date.parse(time(100));
  const blockedResult = await metrics(blocked, { now });
  assert.deepEqual(blockedResult.barrier_waits, [{ step: 2, wave_id: null, barrier_wave_ids: ['w1'],
    started_at: time(10), ended_at: time(50), waiting_on_barrier_seconds: 40, end_reason: 'blocked' }]);
  const cancelledResult = await metrics(cancelled, { now });
  assert.equal(cancelledResult.barrier_waits[0].ended_at, time(30));
  assert.equal(cancelledResult.barrier_waits[0].waiting_on_barrier_seconds, 20);
  assert.equal(cancelledResult.barrier_waits[0].end_reason, 'cancelled');
  const openResult = await metrics(open, { now });
  assert.equal(openResult.barrier_waits[0].ended_at, null);
  assert.equal(openResult.barrier_waits[0].waiting_on_barrier_seconds, 90);
  assert.equal(openResult.barrier_waits[0].end_reason, 'open');
});

test('wave observation: metrics use actual stage sessions and ignore command model anchors', async t => {
  const dir = await fixture(t);
  const runDir = path.join(dir, 'runtime/runs'), waveDir = path.join(dir, 'runtime/waves'), sessionDir = path.join(dir, 'runtime/sessions');
  await mkdir(runDir, { recursive: true }); await mkdir(waveDir, { recursive: true }); await mkdir(sessionDir, { recursive: true });
  const stepFile = n => path.join(dir, `step-${String(n).padStart(3, '0')}-subspec.md`);
  const A = path.join(dir, 'pi/coordinator.jsonl');
  // Valid production-shaped wave record: one member sitting in its reviewing stage.
  const member = { step: 1, attempt: 1, attempt_id: 'attempt-1', phase: 'reviewing', queue_reason: null,
    transitions: [{ phase: 'reviewing', at: time(40), reason: null }], owner_model: null, resume: 0, run_id: null,
    implementation_run_id: null, base_commit: null, head_commit: null, sealed_head: null, retention_ref: null,
    review_artifacts: [], ownership_adaptations: [], repair: null, blocking_reason: null, interrupted_at: null,
    workspace: { backend: 'overlayfs', backendReason: null, merged: path.join(dir, 'attempts/attempt-1/merged') }, preparation_receipt: null };
  await writeFile(path.join(waveDir, 'w1.json'), JSON.stringify({ version: 1, wave_id: 'w1', generation: 1, revision: 0,
    state: 'running', transitions: [{ state: 'running', at: time(0) }], package_ref: 'demo/feature', package: dir,
    started_at: time(0), requested_width: 1, admitted_width: 1, members: { 1: member } }));
  // Stage runs name their real model session through stage.role; owner/editor anchors stay unused.
  const stageRun = (id, phase, role, started, finished) => ({ id, package: dir, package_ref: 'demo/feature', primary: dir,
    step: stepFile(1), target: 'demo', checkout: path.join(dir, 'attempts/attempt-1/merged'), state: 'completed',
    started_at: time(started), finished_at: time(finished), parent_session: A,
    owner_session: path.join(dir, 'pi/unused-owner.jsonl'), editor_session: path.join(dir, 'pi/unused-editor.jsonl'),
    stage: { role, label: 'wave-w1-step-001-review-1', round: 1, base: null, head: null, review_path: null, fix_path: null,
      parents: [], packet: null, expected_ids: [], triage_summary: null },
    wave_bindings: { wave_id: 'w1', generation: 1, step_number: 1, phase, target: 'demo', backend: 'overlayfs', base_commit: null } });
  const reviewA = path.join(dir, 'pi/stages/review-a.jsonl'), reviewB = path.join(dir, 'pi/stages/review-b.jsonl'), fixA = path.join(dir, 'pi/stages/fix-a.jsonl');
  const reviewing = { ...stageRun('w1-review', 'reviewing', 'reviewer', 40, 60), reviewer_session: reviewA };
  const fixing = { ...stageRun('w1-fix', 'fixing', 'fixer', 50, 70), fixer_session: fixA };
  const confirming = { ...stageRun('w1-confirm', 'confirming', 'reviewer', 60, 80), reviewer_session: reviewB };
  for (const record of [reviewing, fixing, confirming]) await writeFile(path.join(runDir, `${record.id}.json`), JSON.stringify(record));
  // A command-phase run owns no model session; its anchors are decoys that must add nothing.
  const commandReview = path.join(dir, 'pi/stages/command-review.jsonl'), commandOwner = path.join(dir, 'pi/stages/command-owner.jsonl');
  await writeFile(path.join(runDir, 'w1-gates.json'), JSON.stringify({ schema_version: 1, id: 'w1-gates', package: dir, state: 'completed',
    mode: 'run-only', checkout: path.join(dir, 'attempts/attempt-1/merged'), started_at: time(0), finished_at: time(1),
    reviewer_session: commandReview, owner_session: commandOwner,
    command_phase: { wave_id: 'w1', subject: { kind: 'step', step: 1 }, purpose: 'gates', backend: 'overlayfs', layers: null, claim_token: null } }));
  await log(A, [header('A'), message('user', 0, {}), assistant(5, 3, [{ type: 'text', text: 'coordinating' }])]);
  for (const [file, end, start] of [[reviewA, 45, 42], [fixA, 55, 52], [reviewB, 65, 62], [commandReview, 1, 0], [commandOwner, 2, 1]])
    await log(file, [header(path.basename(file, '.jsonl')), assistant(end, start, [{ type: 'text', text: 'stage' }])]);
  const result = await metrics(dir, { now: Date.parse(time(300)) });
  assert.equal(result.totals.model_calls, 4);
  const role = name => result.agents.filter(a => a.role === name).reduce((n, a) => n + a.model_calls, 0);
  assert.equal(role('coordinator'), 1); assert.equal(role('reviewer'), 2); assert.equal(role('fixer'), 1);
  assert.deepEqual(result.discovery_errors, []);
});

test('wave observation: metrics count distinct overlapping intervals without filling gaps', async t => {
  const dir = await fixture(t);
  const runDir = path.join(dir, 'runtime/runs'), waveDir = path.join(dir, 'runtime/waves');
  await mkdir(runDir, { recursive: true }); await mkdir(waveDir, { recursive: true });
  const stepFile = n => path.join(dir, `step-${String(n).padStart(3, '0')}-subspec.md`);
  const A = path.join(dir, 'pi/coordinator.jsonl');
  const member = step => ({ step, attempt: 1, attempt_id: `attempt-${step}`, phase: 'implementing', queue_reason: null,
    transitions: [{ phase: 'implementing', at: time(0), reason: null }], owner_model: null, resume: 0, run_id: null,
    implementation_run_id: null, base_commit: null, head_commit: null, sealed_head: null, retention_ref: null,
    review_artifacts: [], ownership_adaptations: [], repair: null, blocking_reason: null, interrupted_at: null,
    workspace: { backend: 'overlayfs', backendReason: null, merged: path.join(dir, `attempts/attempt-${step}/merged`) }, preparation_receipt: null });
  await writeFile(path.join(waveDir, 'w1.json'), JSON.stringify({ version: 1, wave_id: 'w1', generation: 1, revision: 0,
    state: 'running', transitions: [{ state: 'running', at: time(0) }], package_ref: 'demo/feature', package: dir,
    started_at: time(0), requested_width: 2, admitted_width: 2, members: { 1: member(1), 2: member(2) } }));
  // Runs carry production wave_bindings, never a bare wave_id receipt.
  const run = (id, step, started, finished) => ({ id, package: dir, package_ref: 'demo/feature', primary: dir, step: stepFile(step),
    target: 'demo', checkout: path.join(dir, `attempts/attempt-${step}/merged`), state: 'completed',
    started_at: time(started), finished_at: time(finished), parent_session: A, owner_session: null, editor_session: null,
    wave_bindings: { wave_id: 'w1', generation: 1, step_number: step, phase: 'implementing', target: 'demo', backend: 'overlayfs', base_commit: null } });
  await log(A, [header('A'), message('user', 0, {}), assistant(5, 3, [{ type: 'text', text: 'coordinating' }])]);
  // Step 1 runs two disjoint intervals; no other member overlaps either of them.
  await writeFile(path.join(runDir, 'w1-step-1a.json'), JSON.stringify(run('w1-step-1a', 1, 0, 10)));
  await writeFile(path.join(runDir, 'w1-step-1b.json'), JSON.stringify(run('w1-step-1b', 1, 30, 40)));
  await writeFile(path.join(runDir, 'w1-step-2.json'), JSON.stringify(run('w1-step-2', 2, 15, 25)));
  const disjoint = await metrics(dir, { now: Date.parse(time(100)) });
  assert.equal(disjoint.waves.find(w => w.wave_id === 'w1').peak_observed_overlap, 1);
  // Step 1 now has two overlapping intervals; step 2 overlaps them, but step 1 still counts once.
  await writeFile(path.join(runDir, 'w1-step-1a.json'), JSON.stringify(run('w1-step-1a', 1, 0, 10)));
  await writeFile(path.join(runDir, 'w1-step-1b.json'), JSON.stringify(run('w1-step-1b', 1, 5, 12)));
  await writeFile(path.join(runDir, 'w1-step-2.json'), JSON.stringify(run('w1-step-2', 2, 6, 8)));
  const overlapping = await metrics(dir, { now: Date.parse(time(100)) });
  assert.equal(overlapping.waves.find(w => w.wave_id === 'w1').peak_observed_overlap, 2);
});

test('wave observation: C11-3 invalid wave records surface discovery errors', async t => {
  const dir = await fixture(t);
  const runDir = path.join(dir, 'runtime/runs'), waveDir = path.join(dir, 'runtime/waves');
  await mkdir(runDir, { recursive: true }); await mkdir(waveDir, { recursive: true });
  const stepFile = n => path.join(dir, `step-${String(n).padStart(3, '0')}-subspec.md`);
  const A = path.join(dir, 'pi/coordinator.jsonl');
  // A managed completed run plus its coordinator log keep metrics executing.
  const r1 = { id: 'r1', package: dir, package_ref: 'demo/feature', primary: dir, step: stepFile(1), target: 'demo',
    checkout: path.join(dir, 'attempts/attempt-1/merged'), state: 'completed', started_at: time(2), finished_at: time(10),
    parent_session: A, owner_session: null, editor_session: null,
    wave_bindings: { wave_id: 'w1', generation: 1, step_number: 1, phase: 'implementing', target: 'demo', backend: 'overlayfs', base_commit: null } };
  await writeFile(path.join(runDir, 'r1.json'), JSON.stringify(r1));
  await log(A, [header('A'), message('user', 0, {}), assistant(5, 3, [{ type: 'text', text: 'coordinating' }])]);
  // An unreadable wave record must surface one discovery error, not a wave row.
  const badWavePath = path.join(waveDir, 'w1.json');
  await writeFile(badWavePath, '{');
  const invalid = await metrics(dir, { now: Date.parse(time(100)) });
  assert.deepEqual(invalid.discovery_errors.filter(e => e.path === badWavePath),
    [{ path: badWavePath, code: 'INVALID_WAVE_RECORD' }]);
  // Exceeding the bounded wave-record read surfaces truncation against the directory.
  const WAVE_LIMIT = 100;
  await writeFile(badWavePath, JSON.stringify({ version: 1, wave_id: 'w1', generation: 1, revision: 0, state: 'running',
    transitions: [{ state: 'running', at: time(0) }], package_ref: 'demo/feature', package: dir, started_at: time(0),
    requested_width: 1, admitted_width: 1, members: {} }));
  for (let n = 0; n <= WAVE_LIMIT; n++)
    await writeFile(path.join(waveDir, `extra-${String(n).padStart(3, '0')}.json`),
      JSON.stringify({ version: 1, wave_id: `extra-${n}`, generation: 1, revision: 0, state: 'running',
        transitions: [{ state: 'running', at: time(0) }], package_ref: 'demo/feature', package: dir, started_at: time(0),
        requested_width: 1, admitted_width: 1, members: {} }));
  const truncated = await metrics(dir, { now: Date.parse(time(100)) });
  assert.deepEqual(truncated.discovery_errors.filter(e => e.path === waveDir),
    [{ path: waveDir, code: 'WAVE_RECORDS_TRUNCATED' }]);
});
