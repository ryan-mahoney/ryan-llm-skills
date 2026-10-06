import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommunication } from './communication.mjs';

function fixture(options = {}) {
  const registrations = new Map(), publishes = [];
  const record = { id: 'isolated-test-run' };
  const identities = {};
  function pi(role) {
    const events = new Map(), hooks = new Map();
    const api = { events: {
      on(name, handler) { events.set(name, handler); return () => events.delete(name); },
      emit(name, payload) {
        if (name !== 'intercom:extension-register') return events.get(name)?.(payload);
        assert.match(payload.namespace, /^[a-z0-9][a-z0-9._/-]{0,63}$/);
        registrations.set(role, payload);
        payload.onReady({
          snapshot: () => ({ connected: true, supported: true, owner: { sessionId: identities.owner } }),
          publish(value, opts) {
            publishes.push({ role, value, opts });
            const targets = opts.audience === 'owner' ? ['owner'] : ['owner', 'editor'];
            for (const target of targets) registrations.get(target)?.onEvent({ type: 'message', fromSessionId: identities[role], owner: { sessionId: identities.owner }, payload: value });
          },
        });
      },
    }, on(name, handler) { hooks.set(name, handler); } };
    return { api, start() { api.events.emit('intercom:session-identity', { version: 1, claim(value) { identities[role] = value; } }); hooks.get('session_start')(); } };
  }
  const op = pi('owner'), ep = pi('editor');
  const owner = createCommunication(op.api, record, 'owner', options);
  const editor = createCommunication(ep.api, record, 'editor', options);
  op.start(); ep.start();
  return { owner, editor, publishes, registrations, identities, record, close() { owner.close(); editor.close(); } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('owner yields for decisions and resumes the same live editor through two questions', async t => {
  const f = fixture(); t.after(f.close);
  const task = deferred(); let starts = 0;
  const first = f.owner.beginEditor(() => { starts++; return task.promise; });
  const q1 = f.editor.question('Which existing interface?');
  const decision = await first;
  assert.equal(decision.state, 'needs_decision');
  await assert.rejects(f.owner.beginEditor(() => { starts++; }), /already active/);
  const next = f.owner.answer(decision.request_id, 'Use the established interface.');
  assert.equal(await q1, 'Use the established interface.');
  const q2 = f.editor.question('Keep the current acceptance case?');
  const decision2 = await next;
  assert.notEqual(decision.request_id, decision2.request_id);
  const done = f.owner.answer(decision2.request_id, 'Keep it.');
  assert.equal(await q2, 'Keep it.');
  task.resolve({ result: 'committed', revision: 'abc' });
  assert.deepEqual(await done, { result: 'committed', revision: 'abc' });
  assert.equal(starts, 1);
  const nextTask = f.owner.beginEditor(() => ({ result: 'next assignment' }));
  assert.deepEqual(await nextTask, { result: 'next assignment' });
});

test('wrong sender/run and replayed request cannot steer the owner', async t => {
  const f = fixture(); t.after(f.close);
  const task = deferred(), signal = new AbortController();
  const waiting = f.owner.beginEditor(() => task.promise, signal.signal);
  const handler = f.registrations.get('owner').onEvent;
  const payload = { version: 1, run_id: f.record.id, kind: 'question', request_id: 'replayed', question: 'Current?', expires_at: Date.now() + 1000 };
  handler({ type: 'message', fromSessionId: 'outsider', payload });
  handler({ type: 'message', fromSessionId: f.identities.editor, payload: { ...payload, run_id: 'old-run' } });
  handler({ type: 'message', fromSessionId: f.identities.editor, payload });
  assert.equal((await waiting).request_id, 'replayed');
  const resumed = f.owner.answer('replayed', 'Yes');
  handler({ type: 'message', fromSessionId: f.identities.editor, payload });
  await assert.rejects(f.owner.answer('replayed', 'Duplicate'), /stale/);
  task.resolve({ result: 'done' });
  assert.deepEqual(await resumed, { result: 'done' });
});

test('question deadline cancels its request and stale answer cannot reach another question', async t => {
  const f = fixture({ timeoutMs: 30 }); t.after(f.close);
  const task = deferred();
  const waiting = f.owner.beginEditor(() => task.promise);
  const question = f.editor.question('Deadline case');
  const decision = await waiting;
  await assert.rejects(question, /deadline/);
  await assert.rejects(f.owner.answer(decision.request_id, 'Too late'), /stale/);
  assert.equal(f.publishes.at(-1).value.kind, 'cancel');
  task.resolve({ error: 'Question expired' });
});

test('aborting editor question unblocks its tool and does not launch another editor', async t => {
  const f = fixture(); t.after(f.close);
  const task = deferred(), abort = new AbortController();
  const waiting = f.owner.beginEditor(() => task.promise);
  const question = f.editor.question('Interrupted', abort.signal);
  await waiting; abort.abort();
  await assert.rejects(question, /interrupted/);
  task.resolve({ error: 'Interrupted' });
});

test('unsupported intercom fails within the readiness budget and text remains bounded', async t => {
  const hooks = new Map();
  const pi = { events: { on() {}, emit() {} }, on(name, fn) { hooks.set(name, fn); } };
  const editor = createCommunication(pi, { id: 'unsupported' }, 'editor', { readyTimeoutMs: 20 }); t.after(editor.close);
  hooks.get('session_start')();
  await assert.rejects(editor.question('No transport'), /deadline/);
  await assert.rejects(editor.question('x'.repeat(12001)), /12000/);
});

test('shutdown wakes waits and completion without a question has no communication startup delay', async t => {
  const f = fixture(); t.after(f.close);
  assert.deepEqual(await f.owner.beginEditor(() => ({ result: 'ordinary' })), { result: 'ordinary' });
  const waiting = f.owner.beginEditor(() => new Promise(() => {}));
  f.owner.close();
  await assert.rejects(waiting, /closed/);
});

 test('communication telemetry contains metadata without question or answer bodies', async t => {
  const events = [];
  const f = fixture({ onEvent: (name, detail) => events.push({ name, ...detail }) }); t.after(f.close);
  const task = deferred();
  const waiting = f.owner.beginEditor(() => task.promise);
  const question = f.editor.question('PRIVATE QUESTION BODY');
  const decision = await waiting;
  const done = f.owner.answer(decision.request_id, 'PRIVATE ANSWER BODY');
  await question; task.resolve({ result: 'done' }); await done;
  assert.deepEqual(events.map(e => e.name), ['question_sent', 'question_answered']);
  assert.equal(typeof events[1].duration_ms, 'number');
  assert.equal(JSON.stringify(events).includes('PRIVATE'), false);
});

test('editor ignores spoofed and stale answers while waiting for its exact owner response', async t => {
  const f = fixture(); t.after(f.close);
  const task = deferred();
  const waiting = f.owner.beginEditor(() => task.promise);
  const question = f.editor.question('Exact sender and request');
  const decision = await waiting;
  const handler = f.registrations.get('editor').onEvent;
  const payload = { version: 1, run_id: f.record.id, kind: 'answer', request_id: decision.request_id, answer: 'spoofed' };
  handler({ type: 'message', fromSessionId: 'outsider', payload });
  handler({ type: 'message', fromSessionId: f.identities.owner, payload: { ...payload, request_id: 'old-request' } });
  handler({ type: 'message', fromSessionId: f.identities.owner, payload: { ...payload, run_id: 'old-run' } });
  const done = f.owner.answer(decision.request_id, 'real owner');
  assert.equal(await question, 'real owner');
  task.resolve({ result: 'done' }); await done;
});

test('escaped payload expansion is bounded before broker publication', async t => {
  const f = fixture(); t.after(f.close);
  await assert.rejects(f.editor.question('x' + '\n'.repeat(10000)), /channel limit/);
  assert.equal(f.publishes.some(p => p.value.kind === 'question'), false);
});
