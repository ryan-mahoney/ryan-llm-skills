import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { installContextBudget, estimatePayload } from './policy.mjs';

const root = process.env.SPEC_PI_SDK;
const sdk = root ? await import(pathToFileURL(join(root, 'dist/index.js'))) : null;
const skip = sdk ? false : 'Set SPEC_PI_SDK to the installed Pi package for native boundary checks';

async function fixture(t, { compaction = true, seed, toolTurn = false, toolInput = 80000, toolOutput = 30, thinking = '', toolText = 'Pending: retain the source change and evidence.', providerName = 'budget-fixture', summaryStop = 'stop', emptyResponses = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'context-native-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString()); requests.push(payload);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const text = 'Goal: preserve input. Constraints: no publication. Pending: implement the assigned fixture; retain existing evidence.';
    const toolCall = toolTurn && requests.length === 1;
    const isSummary = JSON.stringify(payload.messages[0]).includes('context summarization assistant');
    const empty = !isSummary && requests.length <= emptyResponses;
    const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'large', choices: [{ index: 0, delta: empty ? { reasoning_content: 'Planning the next action.' } : toolCall ? { ...(thinking ? { reasoning_content: thinking } : {}), tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'fixture_read', arguments: '{}' } }] } : { content: text }, finish_reason: null }] };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : isSummary ? summaryStop : 'stop' }], usage: { prompt_tokens: toolCall ? toolInput : 100, completion_tokens: toolCall ? toolOutput : 30, total_tokens: toolCall ? toolInput + toolOutput : 130 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture',
    models: [{ id: 'large', name: 'Large fixture', reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 65536, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...(providerName === 'deepseek' ? { compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true } } : {}) }] };
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(providerName, provider);
  const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: compaction } });
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Keep all constraints and pending work.', extensionFactories: [pi => { pi.registerProvider(providerName, provider); installContextBudget(pi, { compact: sdk.compact, retrySettings: () => settings.getRetrySettings() });
      if (toolTurn) pi.registerTool({ name: 'fixture_read', label: 'Fixture', description: 'Read fixture', parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: toolText }], details: {} }) });
    }, pi => installContextBudget(pi)] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const manager = sdk.SessionManager.inMemory(dir);
  seed?.(manager);
  const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, settingsManager: settings,
    resourceLoader: loader, sessionManager: manager, tools: [] });
  await session.setModel(runtime.getModel(providerName, 'large'));
  await session.bindExtensions({ mode: 'rpc', onError: error => { throw new Error(error.error); } });
  t.after(async () => { session.dispose(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  return { session, manager, requests, runtime };
}

test('native Pi compacts retained history before the next response without changing the provider or registry', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, { seed: manager => {
    for (let i = 0; i < 12; i++) {
      manager.appendMessage({ role: 'user', content: [{ type: 'text', text: `Completed investigation ${i}: ` + 'old source '.repeat(1800) }], timestamp: Date.now() });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Recorded in artifact.' }], api: 'openai-completions', provider: 'budget-fixture', model: 'large',
        stopReason: 'stop', usage: { input: 80000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 80005, cost: {} }, timestamp: Date.now() });
    }
  } });
  assert.equal(f.session.model.contextWindow, 88000);
  assert.equal(f.session.model.maxTokens, 65536, 'provider output allowance is preserved');
  assert.equal(f.runtime.getModel('budget-fixture', 'large').contextWindow, 1048576);
  await f.session.prompt('Continue. Preserve input; no publication; implement the assigned fixture.');
  assert.ok(f.manager.getEntries().some(e => e.type === 'compaction'), 'native durable compaction happened');
  assert.ok(f.requests.length >= 2, 'summary and continuation reach the local transport');
  const last = JSON.stringify(f.requests.at(-1));
  assert.ok(last.includes('no publication')); assert.ok(last.includes('assigned fixture'));
  assert.ok(last.length < 180000, 'old investigation no longer dominates the next input');
  t.diagnostic(JSON.stringify({ summary_payload_bytes: Buffer.byteLength(JSON.stringify(f.requests[0])), continuation_payload_bytes: Buffer.byteLength(last), http_requests: f.requests.length }));
});

test('oversized initial request is aborted before the real OpenAI-compatible HTTP transport', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, { compaction: false });
  await f.session.prompt('x'.repeat(300000));
  assert.equal(f.requests.length, 0);
  assert.ok(f.manager.getEntries().some(e => e.type === 'custom' && e.customType === 'context-budget' && e.data.blocked));
});

test('oversized legacy history cannot escape the budget through the summarizer', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, { seed: manager => {
    for (let i = 0; i < 5; i++) {
      manager.appendMessage({ role: 'user', content: 'legacy '.repeat(30000), timestamp: Date.now() });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Recorded' }], api: 'openai-completions', provider: 'budget-fixture', model: 'large',
        stopReason: 'stop', usage: { input: 300000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 300005, cost: {} }, timestamp: Date.now() });
    }
  } });
  await f.session.prompt('Continue');
  assert.equal(f.requests.length, 0);
  assert.ok(f.manager.getEntries().some(e => e.customType === 'context-budget' && e.data.event === 'compaction_request' && e.data.blocked));
});

test('native Pi compacts between tool calls and retains the pending obligation', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, { toolTurn: true, seed: manager => {
    for (let i = 0; i < 8; i++) {
      manager.appendMessage({ role: 'user', content: 'Prior task ' + 'old '.repeat(1000), timestamp: Date.now() });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Done' }], api: 'openai-completions', provider: 'budget-fixture', model: 'large', stopReason: 'stop', usage: { input: 10000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10005, cost: {} }, timestamp: Date.now() });
    }
  } });
  f.session.setActiveToolsByName(['fixture_read']);
  await f.session.prompt('Read the fixture, then retain the source change and evidence. No publication.\n' + 'source '.repeat(15000));
  assert.ok(f.manager.getEntries().some(e => e.type === 'compaction'));
  assert.ok(f.requests.length >= 3, 'tool request, summary and continuation');
  assert.match(JSON.stringify(f.requests.at(-1)), /evidence/);
  const requests = f.manager.getEntries().filter(e => e.customType === 'context-budget' && e.data.event === 'request');
  assert.equal(requests.length, 2, 'two installers produce only one guard per ordinary request');
});


test('62k input plus a reasoning and tool burst compacts before the request guard', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, { toolTurn: true, toolInput: 62000, toolOutput: 12000,
    thinking: 'thinking '.repeat(6000), toolText: 'source '.repeat(1700), seed: manager => {
      for (let i = 0; i < 12; i++) {
        manager.appendMessage({ role: 'user', content: 'source '.repeat(2600), timestamp: Date.now() });
        manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Recorded' }], api: 'openai-completions', provider: 'budget-fixture', model: 'large', stopReason: 'stop', usage: { input: 50000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 50005, cost: {} }, timestamp: Date.now() });
      }
    }
  });
  f.session.setActiveToolsByName(['fixture_read']);
  await f.session.prompt('Read the fixture. Preserve the evidence.');
  const entries = f.manager.getEntries();
  assert.ok(entries.some(e => e.type === 'compaction'));
  assert.ok(!entries.some(e => e.customType === 'context-budget' && e.data.blocked));
  assert.ok(f.requests.length >= 3);
  assert.ok(estimatePayload(f.requests.at(-1)) < 90000);
  const uncompacted = { ...f.requests[0], messages: [...f.requests[0].messages,
    { role: 'assistant', reasoning_content: 'thinking '.repeat(6000) },
    { role: 'tool', content: 'source '.repeat(1700), tool_call_id: 'call_fixture' }] };
  assert.ok(estimatePayload(uncompacted) >= 90000, 'without compaction this burst would hit the guard');
  t.diagnostic(JSON.stringify({ uncompacted_estimate: estimatePayload(uncompacted), first_estimate: estimatePayload(f.requests[0]), final_estimate: estimatePayload(f.requests.at(-1)), http_requests: f.requests.length }));
});

// Run alone: node --test --test-name-pattern='DeepSeek summary' pi/extensions/context-budget/native.test.mjs
function summaryHistory(manager) {
  for (let i = 0; i < 8; i++) {
    manager.appendMessage({ role: 'user', content: 'Completed investigation ' + 'old source '.repeat(1200), timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Recorded in artifacts. No publication; implement the assigned fixture.' }],
      api: 'openai-completions', provider: 'deepseek', model: 'large', stopReason: 'stop',
      usage: { input: 10000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10005, cost: {} }, timestamp: Date.now() });
  }
}

test('DeepSeek summary keeps obligations with thinking disabled and restores selected reasoning for continuation', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, { providerName: 'deepseek', seed: summaryHistory });
  f.session.setThinkingLevel('high');
  await f.session.compact('Preserve the unresolved security review.');
  const entry = f.manager.getEntries().find(e => e.type === 'compaction');
  assert.ok(entry, 'native Pi persists the complete summary');
  assert.match(entry.summary, /no publication/);
  assert.match(entry.summary, /assigned fixture/);
  assert.ok(f.requests.length >= 1);
  for (const request of f.requests) {
    assert.match(JSON.stringify(request.messages[0]), /Replace completed investigation/);
    assert.equal(request.reasoning_effort, undefined, 'summary reasoning cannot consume its output cap');
    assert.equal(request.thinking.type, 'disabled');
  }
  assert.match(JSON.stringify(f.requests[0]), /unresolved security review/);
  assert.equal(f.session.thinkingLevel, 'high');
  assert.equal(f.session.model.maxTokens, 65536);
  await f.session.prompt('Continue the assigned fixture.');
  assert.equal(f.requests.at(-1).reasoning_effort, 'high');
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages[0]), /Replace completed investigation/);
  const usage = f.manager.getEntries().find(e => e.customType === 'context-budget' && e.data.event === 'summary_usage');
  assert.equal(usage.data.stop_reason, 'stop');
});

// Run alone: node --test --test-name-pattern='reasoning-only' pi/extensions/context-budget/native.test.mjs
test('native Pi sends one more request after a reasoning-only response and stops after two', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, { providerName: 'deepseek', emptyResponses: 1 });
  await f.session.prompt('Continue the assigned fixture.');
  assert.equal(f.requests.length, 2, 'the empty response is followed by exactly one continuation');
  assert.match(JSON.stringify(f.requests[1].messages), /contained only reasoning/);
  const g = await fixture(t, { providerName: 'deepseek', emptyResponses: 10 });
  await g.session.prompt('Continue the assigned fixture.');
  assert.equal(g.requests.length, 3, 'two continuations, then the run settles');
});

test('DeepSeek summary truncation preserves history and does not retry the default summarizer', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, { providerName: 'deepseek', summaryStop: 'length', seed: summaryHistory });
  f.session.setThinkingLevel('high');
  const before = f.manager.getBranch().filter(e => e.type === 'message').map(e => e.id);
  await assert.rejects(f.session.compact(), /cancelled/i);
  const entries = f.manager.getEntries();
  assert.equal(entries.some(e => e.type === 'compaction'), false, 'partial summary cannot become a checkpoint');
  assert.deepEqual(f.manager.getBranch().filter(e => e.type === 'message').map(e => e.id), before);
  assert.equal(f.requests.length, 1, 'no hidden retry through the original summarizer');
  assert.equal(f.session.thinkingLevel, 'high');
  assert.ok(entries.some(e => e.customType === 'context-budget' && e.data.event === 'summary_usage' && e.data.stop_reason === 'length'));
  assert.ok(entries.some(e => e.customType === 'context-budget' && e.data.event === 'compaction_failed'));
});
