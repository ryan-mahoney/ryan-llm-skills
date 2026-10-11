import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJsonlSplitter, discover, discoverManaged, discoverPackage, readSessionBranch, report, summarize } from './core.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spec-observe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function log(file, rows) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
const session = (id, timestamp = '2026-10-05T07:00:00Z') => ({ type: 'session', id, timestamp, cwd: '/project' });
const message = (role, timestamp, extra = {}) => ({ type: 'message', timestamp, message: { role, ...extra } });

test('managed index discovery reads bounded pointers without following manifests or leaking extra fields', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'run.json'), JSON.stringify({ run_id: 'run', package: '/canonical/package',
    manifest: '/does/not/exist', parent_session: '/also/absent', prompt: 'secret prompt' }));
  await writeFile(path.join(directory, 'large.json'), 'x'.repeat(65537));
  const result = await discoverManaged(directory);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].package, '/canonical/package');
  assert.equal(result.runs[0].manifest, '/does/not/exist');
  assert.equal(JSON.stringify(result).includes('secret prompt'), false);
  assert.equal(result.discovery_errors[0].code, 'OVERSIZED_INDEX_RECORD');
});

test('discovers nested workers and measures their writes without exposing commands or prompts', async t => {
  const directory = await fixture(t);
  const root = path.join(directory, 'project', 'root.jsonl');
  const owner = path.join(directory, 'project', 'root', 'worker', 'run-0', 'session.jsonl');
  const editor = path.join(path.dirname(owner), 'session', 'editor', 'run-0', 'session.jsonl');
  await log(root, [session('root'), message('user', '2026-10-05T07:00:02Z', { content: 'secret prompt' }),
    message('assistant', '2026-10-05T07:00:05Z', { content: [{ type: 'toolCall', name: 'subagent', arguments: { workflow: 'secret workflow' } }] })]);
  await log(owner, [session('owner', '2026-10-05T07:00:10Z')]);
  await log(editor, [session('editor', '2026-10-05T07:00:15Z'),
    message('assistant', '2026-10-05T07:00:20Z', { content: [{ type: 'toolCall', name: 'write', arguments: { content: 'secret code' } }] })]);
  const index = await discover(directory);
  assert.deepEqual(index.roots.map(item => item.id), ['root']);
  const result = await report(index, 'root');
  assert.equal(result.sessions.find(item => item.id === 'editor').parent_id, 'owner');
  assert.equal(result.timings.first_child_started_seconds, 8);
  assert.equal(result.timings.first_child_write_tool_seconds, 18);
  assert.equal(result.sessions[0].dispatch_attempt_seconds, 3);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('distinguishes missing cost from reported zero and tolerates incomplete live records', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'run.jsonl');
  await log(file, [session('root'), message('assistant', '2026-10-05T07:00:01Z', { usage: { input: 4 }, stopReason: 'error', errorMessage: 'Upstream idle timeout secret credential' })]);
  let result = await summarize({ file });
  assert.equal(result.reported_usage.cost, null);
  assert.equal(result.reported_usage.tokens.output, null);
  assert.deepEqual(result.provider_errors, { timeout: 1 });
  await writeFile(file, JSON.stringify(message('assistant', '2026-10-05T07:00:02Z', { usage: { cost: { total: 0 }, output: 2 } })) + '\n{"partial":', { flag: 'a' });
  result = await summarize({ file });
  assert.equal(result.reported_usage.cost, 0);
  assert.equal(result.reported_usage.messages_with_cost, 1);
  assert.equal(result.reported_usage.messages_with_usage, 2);
  assert.equal(result.malformed_lines, 1);
  assert.equal(JSON.stringify(result).includes('credential'), false);
  const bounded = await summarize({ file }, { maxBytes: 10 });
  assert.equal(bounded.truncated, true);
});

test('prepared startup is a dispatch attempt without claiming successful execution', async t => {
  const directory = await fixture(t), file = path.join(directory, 'startup.jsonl');
  await log(file, [session('root'), message('user', '2026-10-05T07:00:01Z'),
    message('assistant', '2026-10-05T07:00:04Z', { content: [{ type: 'toolCall', name: 'spec_dispatch', arguments: { action: 'startup' } }] })]);
  const result = await summarize({ file });
  assert.equal(result.dispatch_attempt_seconds, 3);
  assert.equal(result.first_write_tool_at, null);
});

test('managed records link external parent and sibling editor logs, omitting free-form results', async t => {
  const directory = await fixture(t);
  const parent = path.join(directory, 'outside', 'parent.jsonl');
  const owner = path.join(directory, 'runtime', 'sessions', 'pair', 'owner.jsonl');
  const editor = path.join(directory, 'runtime', 'sessions', 'pair', 'editor.jsonl');
  await log(parent, [session('parent')]);
  await log(owner, [session('owner')]);
  await log(editor, [session('editor')]);
  await mkdir(path.join(directory, 'runtime', 'runs'));
  await writeFile(path.join(directory, 'runtime', 'runs', 'run.json'), JSON.stringify({ id: 'run', state: 'completed',
    started_at: '2026-10-05T07:00:00Z', finished_at: '2026-10-05T07:01:00Z',
    parent_session: parent, owner_session: owner, editor_session: editor, result: 'secret output' }));
  await log(path.join(directory, 'runtime', 'events.jsonl'), [{ timestamp: '2026-10-05T07:00:10Z', event: 'editor_started', run_id: 'run', assignment: 'secret output' }]);
  const index = await discoverPackage(directory);
  assert.deepEqual(index.roots.map(item => item.id), ['parent']);
  const result = await report(index);
  assert.equal(result.sessions.find(item => item.id === 'editor').parent_id, 'owner');
  assert.equal(result.runtime.records[0].state, 'completed');
  assert.equal(result.runtime.records[0].first_editor_started_seconds, 10);
  assert.equal(result.runtime.records[0].elapsed_seconds, 60);
  assert.equal(JSON.stringify(result).includes('secret output'), false);
});

test('reports failed launches without sessions and separates runs sharing retained session paths', async t => {
  const directory = await fixture(t);
  await mkdir(path.join(directory, 'runtime', 'runs'), { recursive: true });
  const shared = { owner_session: path.join(directory, 'absent-owner.jsonl'), editor_session: path.join(directory, 'absent-editor.jsonl') };
  for (const [id, started_at, state] of [['first', '2026-10-05T07:00:00Z', 'completed'], ['second', '2026-10-05T08:00:00Z', 'failed']]) {
    await writeFile(path.join(directory, 'runtime', 'runs', `${id}.json`), JSON.stringify({ ...shared, id, assignment_id: id, started_at, state }));
  }
  await log(path.join(directory, 'runtime', 'events.jsonl'), [
    { run_id: 'first', event: 'editor_started', timestamp: '2026-10-05T07:00:10Z' },
    { run_id: 'first', event: 'editor_finished', timestamp: '2026-10-05T07:00:30Z', state: 'completed' },
    { run_id: 'second', event: 'editor_started', timestamp: '2026-10-05T08:00:05Z' },
  ]);
  const result = await report(await discoverPackage(directory));
  assert.equal(result.root_id, null);
  assert.equal(result.sessions.length, 0);
  const [second, first] = result.runtime.records;
  assert.equal(first.first_editor_started_seconds, 10);
  assert.equal(second.first_editor_started_seconds, 5);
  assert.equal(first.editor_assignments[0].elapsed_seconds, 20);
  assert.equal(second.editor_assignments[0].finished_at, null);
  assert.equal(second.editor_assignments[0].state, null);
  assert.equal(second.state, 'failed');
  await log(shared.owner_session, [session('retained-owner')]);
  await log(shared.editor_session, [session('retained-editor'),
    message('assistant', '2026-10-05T07:00:12Z', { content: [{ type: 'toolCall', name: 'write' }] }),
    message('assistant', '2026-10-05T08:00:07Z', { content: [{ type: 'toolCall', name: 'edit' }] })]);
  const retained = await report(await discoverPackage(directory));
  assert.equal(retained.sessions.length, 2);
  assert.equal(retained.runtime.records[0].first_editor_started_seconds, 5);
  assert.equal(retained.runtime.records[1].first_editor_started_seconds, 10);
});

test('managed enumeration stops at the examined-entry ceiling despite retained junk', async t => {
  const directory = await fixture(t);
  for (let index = 0; index < 3; index++) {
    await writeFile(path.join(directory, `pointer-${index}.json`), JSON.stringify({ run_id: `run-${index}`, package: '/canonical/package' }));
  }
  for (let index = 0; index < 4100; index++) {
    await writeFile(path.join(directory, `retained-${String(index).padStart(4, '0')}.log`), 'retained\n');
  }
  const result = await discoverManaged(directory, { limit: 10 });
  // The ceiling is reported as candidate truncation; entries beyond it are an
  // unknown omission, never a full scan.
  assert.equal(result.candidates_truncated, true);
  assert.ok(result.runs.length <= 3);
  assert.equal(result.discovery_errors.length, 0);
});

test('managed pointer discovery reports selection omission separately from candidate truncation', async t => {
  const directory = await fixture(t);
  for (let index = 0; index < 12; index++) {
    await writeFile(path.join(directory, `pointer-${String(index).padStart(4, '0')}.json`),
      JSON.stringify({ run_id: `run-${index}`, package: '/canonical/package' }));
  }
  const capped = await discoverManaged(directory, { limit: 5 });
  assert.equal(capped.runs.length, 5);
  assert.equal(capped.runs_truncated, true);
  assert.equal(capped.candidates_truncated, false);
  const complete = await discoverManaged(directory, { limit: 12 });
  assert.equal(complete.runs.length, 12);
  assert.equal(complete.runs_truncated, false);
  assert.equal(complete.candidates_truncated, false);
  for (let index = 12; index < 1005; index++) {
    await writeFile(path.join(directory, `pointer-${String(index).padStart(4, '0')}.json`),
      JSON.stringify({ run_id: `run-${index}`, package: '/canonical/package' }));
  }
  const flooded = await discoverManaged(directory, { limit: 5 });
  assert.equal(flooded.candidates_truncated, true);
  assert.equal(flooded.runs.length, 5);
  assert.equal(flooded.runs_truncated, true);
});

test('LF splitter frames literal LF, keeps split UTF-8 and U+2028, and reports malformed lines only', () => {
  const lines = [], errors = [];
  const splitter = createJsonlSplitter({ onLine: (record, raw) => lines.push([record, raw]), onError: (error, raw) => errors.push(raw) });
  const record = { type: 'message', id: 'a', message: { role: 'user', content: 'left\u2028right \u26c4' } };
  const bytes = Buffer.from(JSON.stringify(record) + '\n');
  const splitAt = bytes.indexOf(Buffer.from('\u26c4')) + 1;
  splitter.write(bytes.subarray(0, splitAt));
  splitter.write(Buffer.concat([bytes.subarray(splitAt), Buffer.from('{"broken":\n{"ok":1}\r\n')]));
  assert.equal(splitter.end(), '');
  assert.equal(lines.length, 2);
  assert.equal(lines[0][0].message.content, 'left\u2028right \u26c4');
  assert.equal(lines[0][0].message.content.includes('\uFFFD'), false);
  assert.equal(JSON.parse(lines[1][1]).ok, 1);
  assert.deepEqual(errors, ['{"broken":']);
  // A torn final line is returned, never emitted or reported as malformed.
  const torn = createJsonlSplitter({ onLine: () => { throw new Error('must not emit'); }, onError: () => { throw new Error('must not report'); } });
  torn.write('{"type":"message"');
  assert.equal(torn.end(), '{"type":"message"');
});

test('session branch follows the active parentId chain and preserves Unicode with a torn final line', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'active.jsonl');
  const rows = [
    { type: 'session', version: 3, id: 's1', timestamp: '2026-10-05T07:00:00Z', cwd: '/project' },
    { type: 'message', id: 'a', parentId: null, timestamp: '2026-10-05T07:00:01Z', message: { role: 'user', content: 'start\u2028snow \u26c4' } },
    { type: 'model_change', id: 'm', parentId: 'a', timestamp: '2026-10-05T07:00:02Z', provider: 'p', modelId: 'm' },
    { type: 'message', id: 'b', parentId: 'm', timestamp: '2026-10-05T07:00:03Z', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned' }] } },
    { type: 'message', id: 'c', parentId: 'b', timestamp: '2026-10-05T07:00:04Z', message: { role: 'user', content: 'abandoned tip' } },
    { type: 'message', id: 'd', parentId: 'a', timestamp: '2026-10-05T07:00:05Z', message: { role: 'user', content: 'new branch \u26c4' } },
    { type: 'message', id: 'e', parentId: 'd', timestamp: '2026-10-05T07:00:06Z', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
  ];
  const text = rows.map(JSON.stringify).join('\n') + '\nnot json\n' + '{"type":"message","id":"torn"';
  await writeFile(file, text);
  const branch = await readSessionBranch(file);
  assert.equal(branch.header.id, 's1');
  assert.equal(branch.header.version, 3);
  assert.deepEqual(branch.entries.map(item => item.id), ['a', 'd', 'e']);
  assert.equal(branch.entries[2].message.content[0].text, 'reply');
  assert.equal(branch.leaf_id, 'e');
  assert.equal(branch.incomplete_tail, true);
  assert.equal(branch.skipped_lines, 1);
  assert.equal(branch.truncated, false);
  assert.equal(branch.entries[0].message.content, 'start\u2028snow \u26c4');
  assert.equal(JSON.stringify(branch).includes('\uFFFD'), false);
  assert.equal((await readFile(file, 'utf8')).length, text.length);
  await assert.rejects(readSessionBranch(file, { before: 'm' }), error => error.code === 'invalid-cursor');
});

test('session branch pages before an active entry and refuses invalid cursors, missing parents and cycles', async t => {
  const directory = await fixture(t);
  const header = { type: 'session', version: 3, id: 's1', timestamp: '2026-10-05T07:00:00Z', cwd: '/project' };
  const file = path.join(directory, 'page.jsonl');
  await log(file, [header,
    { type: 'message', id: 'a', parentId: null, timestamp: '2026-10-05T07:00:01Z', message: { role: 'user', content: 'one' } },
    { type: 'model_change', id: 'm', parentId: 'a', timestamp: '2026-10-05T07:00:02Z', provider: 'p', modelId: 'm' },
    { type: 'message', id: 'b', parentId: 'm', timestamp: '2026-10-05T07:00:03Z', message: { role: 'assistant', content: 'two' } },
    { type: 'message', id: 'c', parentId: 'b', timestamp: '2026-10-05T07:00:04Z', message: { role: 'user', content: 'three' } },
    { type: 'message', id: 'd', parentId: 'c', timestamp: '2026-10-05T07:00:05Z', message: { role: 'assistant', content: 'four' } }]);
  const page = await readSessionBranch(file, { limit: 2 });
  assert.deepEqual(page.entries.map(item => item.id), ['c', 'd']);
  assert.equal(page.truncated, true);
  assert.equal(page.leaf_id, 'd');
  const older = await readSessionBranch(file, { before: 'c' });
  assert.deepEqual(older.entries.map(item => item.id), ['a', 'b']);
  assert.equal(older.truncated, false);
  const olderStill = await readSessionBranch(file, { before: 'd', limit: 1 });
  assert.deepEqual(olderStill.entries.map(item => item.id), ['c']);
  assert.equal(olderStill.truncated, true);
  // before may name a non-message entry on the active branch.
  const beforeModel = await readSessionBranch(file, { before: 'm', limit: 1 });
  assert.deepEqual(beforeModel.entries.map(item => item.id), ['a']);
  await assert.rejects(readSessionBranch(file, { before: 'absent' }), error => error.code === 'invalid-cursor');
  await assert.rejects(readSessionBranch(file, { before: 's1' }), error => error.code === 'invalid-cursor');
  const cyclic = path.join(directory, 'cyclic.jsonl');
  await log(cyclic, [header,
    { type: 'message', id: 'x', parentId: 'y', timestamp: '2026-10-05T07:00:01Z', message: { role: 'user', content: 'x' } },
    { type: 'message', id: 'y', parentId: 'x', timestamp: '2026-10-05T07:00:02Z', message: { role: 'user', content: 'y' } }]);
  await assert.rejects(readSessionBranch(cyclic), error => error.code === 'corrupt-session');
  const missingParent = path.join(directory, 'missing-parent.jsonl');
  await log(missingParent, [header,
    { type: 'message', id: 'x', parentId: 'ghost', timestamp: '2026-10-05T07:00:01Z', message: { role: 'user', content: 'x' } }]);
  await assert.rejects(readSessionBranch(missingParent), error => error.code === 'corrupt-session');
});

test('session branch treats missing as empty, unreadable and oversized as typed failures, and version 1 as order', async t => {
  const directory = await fixture(t);
  assert.deepEqual(await readSessionBranch(path.join(directory, 'absent.jsonl')),
    { header: null, entries: [], leaf_id: null, incomplete_tail: false, skipped_lines: 0, truncated: false });
  await assert.rejects(readSessionBranch(directory), error => error.code === 'unreadable-session');
  const linear = path.join(directory, 'linear.jsonl');
  await log(linear, [{ type: 'session', version: 1, id: 's1', timestamp: '2026-10-05T07:00:00Z', cwd: '/project' },
    { type: 'message', id: 'a', timestamp: '2026-10-05T07:00:01Z', message: { role: 'user', content: 'first' } },
    { type: 'message', id: 'b', timestamp: '2026-10-05T07:00:02Z', message: { role: 'assistant', content: 'second' } }]);
  const linearBranch = await readSessionBranch(linear);
  assert.deepEqual(linearBranch.entries.map(item => item.id), ['a', 'b']);
  assert.equal(linearBranch.leaf_id, 'b');
  await assert.rejects(readSessionBranch(linear, { limit: 201 }), RangeError);
  await assert.rejects(readSessionBranch(linear, { limit: 0 }), RangeError);
  const oversized = path.join(directory, 'oversized.jsonl');
  await writeFile(oversized, '{"type":"session","version":3,"id":"s1"}\n');
  await truncate(oversized, 64 * 1024 * 1024 + 1);
  await assert.rejects(readSessionBranch(oversized), error => error.code === 'session-too-large');
});
