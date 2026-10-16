import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POLICY, budgetModel, estimatePayload, inputTokens, installContextBudget } from './policy.mjs';

test('working cap preserves provider identity and smaller native limits; cached input counts toward budget', () => {
  const original = { id: 'model', provider: 'provider', contextWindow: 1048576, maxTokens: 65536, cost: { input: 1 } };
  assert.deepEqual(budgetModel(original), { ...original, contextWindow: 88000 });
  assert.equal(original.contextWindow, 1048576);
  assert.equal(budgetModel(original).maxTokens, 65536);
  assert.equal(budgetModel({ ...original, maxTokens: 0 }).maxTokens, 0);
  assert.equal(budgetModel({ ...original, contextWindow: 32000, maxTokens: 4096 }).contextWindow, 32000);
  assert.equal(inputTokens({ input: 1000, cacheRead: 98000, cacheWrite: 2000, output: 999 }), 101000);
  assert.ok(estimatePayload({ messages: [{ content: '界'.repeat(90000) }] }) > POLICY.requestEstimateLimit);
  assert.ok(estimatePayload({ messages: [{ content: [{ type: 'image_url', image_url: { url: 'x'.repeat(1000000) } }] }] }) < 10000);
});

// Run alone: node --test --test-name-pattern='calibrates' pi/extensions/context-budget/policy.test.mjs
test('request guard calibrates to reported input so it cannot fire before native compaction', () => {
  const handlers = {}, entries = [];
  const pi = { on: (name, fn) => handlers[name] = fn, appendEntry: (_kind, data) => entries.push(data) };
  installContextBudget(pi);
  const send = chars => {
    let aborted = false;
    handlers.before_provider_request({ payload: { messages: [{ content: 'x'.repeat(chars) }] } }, { abort: () => { aborted = true; } });
    return aborted;
  };
  // An observed Codex reviewer: ~80k estimated was 50.6k reported, then one read batch
  // raised the estimate to ~93k while real input stayed below the 59.6k compaction trigger.
  assert.equal(send(276000), true, 'uncalibrated ~93k estimate is blocked');
  assert.equal(send(237000), false);
  handlers.message_end({ message: { role: 'assistant', usage: { input: 2000, cacheRead: 46000, output: 10 } } });
  assert.equal(send(276000), false, '~93k estimate at a 0.6 ratio is ~56k real input');
  assert.equal(send(480000), true, '~161k estimate at a 0.6 ratio still exceeds the guard');
  handlers.message_end({ message: { role: 'assistant', usage: { input: 0, output: 0 } } });
  assert.equal(entries.at(-1).event, 'usage');
  assert.equal(send(276000), false, 'a response without reported usage keeps the prior calibration');
});

// Run alone: node --test --test-name-pattern='compaction preflight' pi/extensions/context-budget/policy.test.mjs
test('compaction preflight sizes the sent summary text and context, not raw message JSON', async () => {
  const handlers = {}, entries = [];
  const pi = { on: (name, fn) => handlers[name] = fn, appendEntry: (_kind, data) => entries.push(data) };
  // Summarizers send text without thinking blocks; the fake keeps only visible text.
  installContextBudget(pi, { serialize: messages => messages.map(m => m.text ?? '').join('\n') });
  const compact = async (preparation) => {
    let aborted = false;
    const result = await handlers.session_before_compact({ preparation }, { abort: () => { aborted = true; } });
    return { cancelled: result?.cancel === true, aborted };
  };
  // A Sol owner: ~600k bytes of encrypted reasoning, 73k real context, short visible text.
  const owner = { messagesToSummarize: [{ text: 'read src/runtime.mjs', thinking: 'e'.repeat(600000) }], turnPrefixMessages: [], tokensBefore: 73000 };
  assert.deepEqual(await compact(owner), { cancelled: false, aborted: false });
  assert.deepEqual(await compact({ ...owner, tokensBefore: 95000 }), { cancelled: true, aborted: true }, 'context past the limit');
  assert.deepEqual(await compact({ ...owner, tokensBefore: 40000, turnPrefixMessages: [{ text: 'x'.repeat(300000) }] }),
    { cancelled: true, aborted: true }, 'a ~100k split-turn prefix request');
  assert.equal(entries.at(-1).context_tokens, 40000);
});

// Run alone: node --test --test-name-pattern='reasoning-only' pi/extensions/context-budget/policy.test.mjs
test('a reasoning-only final response continues twice at most and text resets the allowance', () => {
  const handlers = {}, entries = [];
  const pi = { on: (name, fn) => handlers[name] = fn, appendEntry: (_kind, data) => entries.push(data) };
  installContextBudget(pi);
  const thinking = { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'plan' }] };
  // Pi omits a `length` response from the settle context, so only message_end shows it.
  const settle = (last, extra = {}) => {
    handlers.message_end({ message: { usage: {}, ...last } });
    return handlers.agent_before_settle({ outcome: 'completed', continue: false, entries: [],
      context: { pendingMessages: [], contextMessages: [{ role: 'user', content: 'task' }] }, ...extra });
  };
  const first = settle(thinking);
  assert.equal(first.continue, true);
  assert.match(first.entries[0].content, /next tool call/);
  assert.equal(settle({ ...thinking, stopReason: 'length' }).continue, true, 'reasoning cut off at the output cap also continues');
  assert.equal(settle(thinking), undefined, 'a third consecutive empty response is left to end');
  handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: 'Edited the file.' }], usage: {} } });
  assert.equal(settle(thinking).continue, true, 'a substantive response resets the allowance');
  assert.equal(settle({ role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking' }, { type: 'text', text: 'Done.' }] }), undefined);
  assert.equal(settle({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'read' }] }), undefined);
  assert.equal(settle(thinking, { outcome: 'aborted' }), undefined, 'an aborted run is not continued');
  assert.deepEqual(entries.filter(e => e.event === 'empty_response_continue').map(e => e.attempt), [1, 2, 1]);
});

test('large tool output remains exactly recoverable, retains error tail, and telemetry excludes content', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'context-budget-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const handlers = {}, entries = [];
  const pi = { on: (name, fn) => handlers[name] = fn, appendEntry: (_kind, data) => entries.push(data) };
  installContextBudget(pi);
  const original = 'private source\n'.repeat(3000) + 'IMPORTANT ERROR';
  const answer = handlers.tool_result({ content: [{ type: 'text', text: original }] }, { sessionManager: { getSessionFile: () => join(dir, 'session.jsonl') } });
  const text = answer.content[0].text;
  const path = text.match(/Full result: (.+)\. Read only/)[1];
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.ok(text.length < 12000); assert.ok(text.endsWith('IMPORTANT ERROR'));
  let aborted = false;
  handlers.before_provider_request({ payload: { messages: [{ content: 'private source'.repeat(30000) }] } }, { abort: () => { aborted = true; } });
  assert.equal(aborted, true);
  assert.equal(entries[0].blocked, true);
  assert.ok(!JSON.stringify(entries).includes('private source'));
});
