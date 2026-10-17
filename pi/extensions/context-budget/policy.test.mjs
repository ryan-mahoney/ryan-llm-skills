import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POLICY, budgetModel, estimatePayload, grownWindow, inputTokens, installContextBudget, roleWindow } from './policy.mjs';

test('working cap preserves provider identity and smaller native limits; cached input counts toward budget', () => {
  const original = { id: 'model', provider: 'provider', contextWindow: 1048576, maxTokens: 65536, cost: { input: 1 } };
  assert.deepEqual(budgetModel(original, 88000), { ...original, contextWindow: 88000 });
  assert.equal(budgetModel(original).contextWindow, POLICY.windows.default);
  assert.equal(original.contextWindow, 1048576);
  assert.equal(budgetModel(original).maxTokens, 65536);
  assert.equal(budgetModel({ ...original, maxTokens: 0 }).maxTokens, 0);
  assert.equal(budgetModel({ ...original, contextWindow: 32000, maxTokens: 4096 }).contextWindow, 32000);
  assert.equal(inputTokens({ input: 1000, cacheRead: 98000, cacheWrite: 2000, output: 999 }), 101000);
  assert.ok(estimatePayload({ messages: [{ content: '界'.repeat(90000) }] }) > 90000, 'the estimate counts UTF-8 bytes');
  assert.ok(estimatePayload({ messages: [{ content: [{ type: 'image_url', image_url: { url: 'x'.repeat(1000000) } }] }] }) < 10000);
});

// Run alone: node --test --test-name-pattern='calibrates' pi/extensions/context-budget/policy.test.mjs
test('request guard calibrates to reported input so it cannot fire before native compaction', () => {
  const handlers = {}, entries = [];
  const pi = { on: (name, fn) => handlers[name] = fn, appendEntry: (_kind, data) => entries.push(data) };
  installContextBudget(pi, { role: 'editor' });
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
  installContextBudget(pi, { role: 'editor', serialize: messages => messages.map(m => m.text ?? '').join('\n') });
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
  // Codex compacts its cached history in place, so only the reported context counts there.
  const large = { messagesToSummarize: [{ text: 'x'.repeat(510000) }], turnPrefixMessages: [], tokensBefore: 72000 };
  const codex = async preparation => handlers.session_before_compact({ preparation }, { abort() {}, model: { provider: 'openai-codex' } });
  assert.equal((await codex(large))?.cancel, undefined, 'a 170k native-text estimate does not block Codex at 72k context');
  assert.equal((await codex({ ...large, tokensBefore: 95000 }))?.cancel, true);
  assert.deepEqual(await compact(large), { cancelled: true, aborted: true }, 'the same history blocks a native summarizer');
});

// Run alone: node --test --test-name-pattern='resumed session' pi/extensions/context-budget/policy.test.mjs
test('a resumed session seeds calibration from its last recorded usage', async () => {
  const start = async entries => {
    const handlers = {};
    const pi = { on: (name, fn) => { (handlers[name] ??= []).push(fn); }, appendEntry() {}, getThinkingLevel() {} };
    installContextBudget(pi, { role: 'editor' });
    for (const fn of handlers.session_start) await fn({}, { sessionManager: { getEntries: () => entries } });
    let aborted = false;
    handlers.before_provider_request[0]({ payload: { messages: [{ content: 'x'.repeat(364000) }] } }, { abort: () => { aborted = true; } });
    return aborted;
  };
  const usage = (input, estimate) => ({ type: 'custom', customType: 'context-budget', data: { event: 'usage', input_tokens: input, estimated_input_tokens: estimate } });
  // ~121k estimate; a recorded 0.53 ratio puts real input near 65k.
  assert.equal(await start([usage(53000, 100000)]), false);
  assert.equal(await start([]), true, 'no recorded usage keeps the raw estimate');
  assert.equal(await start([usage(53000, 100000), usage(0, 90000)]), false, 'an entry without usage is skipped');
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

// A session double that keeps the selected model and every handler per event.
function budgetSession({ role, nativeWindow }) {
  const handlers = {}, entries = [], selected = [];
  const native = { id: 'gpt-6.1-sol', provider: 'openai-codex', contextWindow: nativeWindow, maxTokens: 128000 };
  const ctx = { model: native, modelRegistry: { find: () => native }, abort() { ctx.aborted = true; }, aborted: false };
  const pi = { on: (name, fn) => (handlers[name] ??= []).push(fn), appendEntry: (_kind, data) => entries.push(data),
    getThinkingLevel: () => 'medium', setThinkingLevel() {},
    setModel: async model => { selected.push(model.contextWindow); ctx.model = model; return true; } };
  installContextBudget(pi, { role });
  const emit = async (name, event = {}) => { let result; for (const fn of handlers[name] ?? []) result = await fn(event, ctx) ?? result; return result; };
  const compactWith = async retained => {
    await emit('session_compact', { compactionEntry: {} });
    await emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input: 2000, cacheRead: retained - 2000, output: 50 } } });
  };
  return { ctx, entries, selected, emit, compactWith };
}

// Run alone: node --test --test-name-pattern='role window' pi/extensions/context-budget/policy.test.mjs
test('each role starts at its own window and an unknown role uses the default', async () => {
  for (const [role, expected] of [['owner', 200000], ['reviewer', 160000], ['fixer', 120000], ['editor', 88000], [undefined, 120000], ['scout', 120000]]) {
    assert.equal(roleWindow(role), expected, String(role));
    const s = budgetSession({ role, nativeWindow: 272000 });
    await s.emit('session_start');
    assert.equal(s.ctx.model.contextWindow, expected, `${role} session window`);
  }
  const small = budgetSession({ role: 'owner', nativeWindow: 128000 });
  await small.emit('session_start');
  assert.equal(small.ctx.model.contextWindow, 128000, 'a smaller native limit stays smaller');
});

// Run alone: node --test --test-name-pattern='grows the window' pi/extensions/context-budget/policy.test.mjs
test('a compaction that leaves too little working room grows the window and the request guard', async () => {
  // Observed 2026-10-17: a Sol session at an 88k window returned from each compaction at
  // about 62k, 9k below the 71.6k trigger, and compacted again within a minute.
  const s = budgetSession({ role: 'editor', nativeWindow: 272000 });
  await s.emit('session_start');
  const blocked = async chars => { s.ctx.aborted = false; await s.emit('before_provider_request', { payload: { messages: [{ content: 'x'.repeat(chars) }] } }); return s.ctx.aborted; };
  assert.equal(await blocked(300000), true, 'a ~101k estimate exceeds the 88k window guard');
  await s.compactWith(62339);
  assert.equal(s.ctx.model.contextWindow, 62339 + 32000 + 16384);
  assert.deepEqual(s.entries.filter(e => e.event === 'window_grown').map(e => [e.from, e.context_window]), [[88000, 110723]]);
  assert.equal(await blocked(300000), false, 'the guard follows the grown window');
  await s.compactWith(62000);
  assert.equal(s.ctx.model.contextWindow, 110723, 'enough room after the next compaction leaves the window unchanged');
  assert.equal((await s.emit('session_before_compact', { preparation: { tokensBefore: 90000 } }))?.cancel, undefined);
  // Pure rule: growth restores the working room and stops at the ceiling.
  assert.equal(grownWindow(200000, 62000), 200000);
  assert.equal(grownWindow(200000, 230000), POLICY.maxWindow);
});

// Run alone: node --test --test-name-pattern='cannot grow' pi/extensions/context-budget/policy.test.mjs
test('when the window cannot grow enough, the next compaction stops instead of looping', async () => {
  const s = budgetSession({ role: 'editor', nativeWindow: 100000 });
  await s.emit('session_start');
  await s.compactWith(62000);
  assert.equal(s.ctx.model.contextWindow, 100000, 'growth is capped by the native limit');
  const result = await s.emit('session_before_compact', { preparation: { tokensBefore: 85000 } });
  assert.equal(result?.cancel, true);
  assert.equal(s.ctx.aborted, true);
  assert.equal(s.entries.at(-1).event, 'compaction_loop');
});
