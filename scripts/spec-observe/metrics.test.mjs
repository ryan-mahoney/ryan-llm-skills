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
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'spec-metrics-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function log(file, rows) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map(JSON.stringify).join('\n') + '\n');
}
const header = id => ({ type: 'session', id, timestamp: time(0), cwd: '/repo' });

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
  assert.equal(data.mercury.model_calls, 0);
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

test('native clerk names attribute Mercury calls and completion reports separate subsequent checks', async t => {
  const dir = await fixture(t), root = path.join(dir, 'pi/root.jsonl');
  const clerk = path.join(dir, 'pi/root/clerk/run-0/session.jsonl');
  const summary = `outcome: published\nspec-folder: ${dir}\npr: https://example.test/pr/3\nblocker: none`;
  await log(root, [header('root'), message('user', 0, {}),
    assistant(10, 8, [{ type: 'thinking', thinking: '```txt\n' + summary + '\n```' }], { stopReason: 'stop' }),
    assistant(20, 18, [{ type: 'text', text: '```txt\n' + summary + '\n```' }], { stopReason: 'stop' }),
    assistant(25, 24, [call('test', 'bash', 'node --test x.test.mjs')]), result('test', 30)]);
  await log(clerk, [header('clerk'), { type: 'session_info', name: 'subagent-spec-clerk-e576cedd-b542-4195-9c26-c58d7902e399-1' },
    assistant(5, 3, [], { model: 'mercury-2.5' }), assistant(7, 6, [], { model: 'mercury-2.5' })]);
  await mkdir(path.join(dir, 'runtime/runs'), { recursive: true });
  await writeFile(path.join(dir, 'runtime/runs/run.json'), JSON.stringify({ id: 'run', parent_session: root, started_at: time(0), finished_at: time(15), state: 'completed' }));
  const receipt = { schema_version: 1, kind: 'pr_submission', package: dir, parent_session: root, url: 'https://example.test/pr/3', submitted_at: time(16) };
  await writeFile(path.join(dir, 'pr-url.json'), JSON.stringify(receipt));
  const data = await metrics(dir, { now: Date.parse(time(40)) });
  assert.equal(data.mercury.clerk_model_calls, 2);
  assert.equal(data.process.elapsed_to_completion_report_seconds, 20);
  assert.equal(data.process.post_completion_activity_seconds, 10);
  assert.match(formatMetrics(data), /completion reported by coordinator/);
  assert.deepEqual(data.process.milestones.map(m => m.kind), ['pr_submitted', 'coordinator_completion_reported']);
  for (const stale of [{ ...receipt, parent_session: '/another/run.jsonl' }, { ...receipt, package: '/another/package' }, { ...receipt, submitted_at: time(-1) }, { ...receipt, submitted_at: time(50) }]) {
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
