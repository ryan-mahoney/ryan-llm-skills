import test from 'node:test';
import assert from 'node:assert/strict';
import { createScout } from './scout.mjs';

function bus() {
  const listeners = new Map();
  return {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
    emit(name, value) { for (const fn of [...(listeners.get(name) || [])]) fn(value); },
  };
}
const requestEvent = 'prompt-template:subagent:request';
const responseEvent = 'prompt-template:subagent:response';
const cancelEvent = 'prompt-template:subagent:cancel';

test('scouting selects the configured fresh leaf and ignores responses from other attempts', async () => {
  const events = bus(); let request;
  events.on(requestEvent, value => { request = value; });
  const scout = createScout(events, { ownerRunId: 'owner', cwd: '/repo', model: 'openai-codex/gpt-6-luna:low' });
  const pending = scout.run('Find the actual callers of select.');
  assert.equal(request.agent, 'scout'); assert.equal(request.context, 'fresh');
  assert.equal(request.cwd, '/repo'); assert.equal(request.model, 'openai-codex/gpt-6-luna');
  assert.equal(request.thinking, 'low'); assert.equal(request.intercomBridge.mode, 'off');
  await assert.rejects(scout.run('Duplicate'), /already active/);
  events.emit(responseEvent, { ...request, requestId: 'another', status: 'completed', result: { kind: 'text', text: 'wrong' } });
  events.emit(responseEvent, { ...request, status: 'completed', result: { kind: 'text', text: '{literal source evidence}' }, runId: 'child' });
  assert.equal((await pending).result, '{literal source evidence}');
  scout.close();
});

test('abort and shutdown cancel only the owned request and do not accept late success', async () => {
  const events = bus(); let request, cancelled;
  events.on(requestEvent, value => { request = value; });
  events.on(cancelEvent, value => { cancelled = value; events.emit(responseEvent, { ...request, status: 'completed', result: { kind: 'text', text: 'too late' } }); });
  const scout = createScout(events, { ownerRunId: 'owner', cwd: '/repo' });
  const controller = new AbortController();
  const pending = scout.run('Find callers.', controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.deepEqual(cancelled, { requestId: request.requestId, ownerRunId: 'owner', nodeId: 'scout' });
  const next = scout.run('Find fixtures.'); scout.close();
  await assert.rejects(next, /closed/);
  await assert.rejects(scout.run('No more.'), /closed/);
});

test('missing delegation extension and failed scouts return errors without a fallback launch', async () => {
  const events = bus(); let starts = 0;
  events.on(requestEvent, () => starts++);
  const scout = createScout(events, { ownerRunId: 'owner', cwd: '/repo', readyMs: 5 });
  await assert.rejects(scout.run('Find entry.'), /did not accept/);
  assert.equal(starts, 1);
  events.on(requestEvent, value => events.emit(responseEvent, { ...value, status: 'failed', error: 'Selected model unavailable' }));
  await assert.rejects(scout.run('Find entry.'), /Selected model unavailable/);
  assert.equal(starts, 2); scout.close();
});
