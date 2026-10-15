import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { installProviderRecovery, transientProviderFailure } from './provider-recovery.mjs';
import { installContextBudget } from '../context-budget/policy.mjs';

test('deployment outages retry despite HTTP 400; configuration, funds, context and abort failures do not', () => {
  const error = errorMessage => ({ stopReason: 'error', errorMessage });
  for (const message of ['400: litellm.BadRequestError: There are no healthy deployments for this model.',
    '429 Too Many Requests', '503 Service Unavailable', 'upstream timeout', 'ECONNRESET'])
    assert.equal(transientProviderFailure(error(message)), true, message);
  for (const message of ['400 invalid request', '401 Unauthorized', '403 Forbidden',
    '429 insufficient_quota', '503 invalid model', 'maximum context length exceeded',
    'rate limit: billing credits exhausted'])
    assert.equal(transientProviderFailure(error(message)), false, message);
  assert.equal(transientProviderFailure({ stopReason: 'aborted', errorMessage: '503' }), false);
  assert.equal(transientProviderFailure({ stopReason: 'length', errorMessage: '503' }), false);
});

const root = process.env.SPEC_PI_SDK;
const sdk = root ? await import(pathToFileURL(join(root, 'dist/index.js'))) : null;
const compat = root ? await import(pathToFileURL(join(root, '../pi-ai/dist/compat.js'))) : null;
const skip = sdk ? false : 'Set SPEC_PI_SDK to exercise the installed native Pi boundary';
const selected = 'primalabs/primalabs-ai/MiMo-V2.6-Pro:high';
const outage = '400: litellm.BadRequestError: There are no healthy deployments for this model.';

async function fixture(t, { toolFirst = false, primaryFailures = Infinity, fallbackPresent = true,
  wait, seed, fallbackFails = false, nativeRetry = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'provider-recovery-'));
  const requests = [], delays = [], events = [];
  let mutations = 0, primaryCount = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString()); requests.push(payload);
    const primary = payload.model === 'primalabs-ai/MiMo-V2.6-Pro';
    if (primary) primaryCount++;
    const tool = primary && toolFirst && primaryCount === 1;
    if ((!tool && primary && primaryCount - (toolFirst ? 1 : 0) <= primaryFailures) || (!primary && fallbackFails)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: nativeRetry ? '503 Service Unavailable' : outage } })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: payload.model,
      choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: 'call_write', type: 'function',
        function: { name: 'fixture_write', arguments: '{}' } }] } : { content: 'Retained work completed.' }, finish_reason: null }] };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = id => ({ api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-only',
    models: [{ id, name: id, reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const providers = { primalabs: provider('primalabs-ai/MiMo-V2.6-Pro'),
    ...(fallbackPresent ? { deepseek: provider('deepseek-flash') } : {}) };
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  for (const [name, config] of Object.entries(providers)) runtime.registerProvider(name, config);
  const settings = sdk.SettingsManager.inMemory({ retry: { enabled: nativeRetry, maxRetries: 3, baseDelayMs: 1 }, compaction: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Preserve tool results and finish the assigned work.', extensionFactories: [pi => {
      for (const [name, config] of Object.entries(providers)) pi.registerProvider(name, config);
      installContextBudget(pi);
      installProviderRecovery(pi, { requestedModel: selected, onEvent: event => events.push(event),
        nativeRetryable: compat.isRetryableAssistantError, retrySettings: () => settings.getRetrySettings(),
        wait: async (ms, signal) => { delays.push(ms); await wait?.(ms, signal); } });
      pi.registerTool({ name: 'fixture_write', label: 'Write fixture', description: 'Write once',
        parameters: { type: 'object', properties: {} }, execute: async () => {
          mutations++; return { content: [{ type: 'text', text: 'Durable change already applied.' }], details: {} };
        } });
    }] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const manager = sdk.SessionManager.inMemory(dir); seed?.(manager);
  const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime,
    settingsManager: settings, resourceLoader: loader, sessionManager: manager, tools: ['fixture_write'] });
  await session.setModel(runtime.getModel('primalabs', 'primalabs-ai/MiMo-V2.6-Pro'));
  session.setThinkingLevel('high');
  await session.bindExtensions({ mode: 'rpc', onError: error => { throw new Error(error.error); } });
  session.setActiveToolsByName(['fixture_write']);
  t.after(async () => { session.dispose(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  return { session, manager, requests, delays, events, mutations: () => mutations };
}

// Run alone: SPEC_PI_SDK=<installed package> node --test pi/extensions/spec-runtime/provider-recovery.test.mjs
test('native outage retries 5/10/20s then switches exact provider without replaying successful tools', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, { toolFirst: true });
  await f.session.prompt('Apply the fixture change once, then finish.');
  assert.deepEqual(f.delays, [5000, 10000, 20000]);
  assert.deepEqual(f.requests.map(r => r.model), [...Array(5).fill('primalabs-ai/MiMo-V2.6-Pro'), 'deepseek-flash']);
  assert.equal(f.mutations(), 1);
  assert.equal(f.session.model.provider, 'deepseek');
  assert.equal(f.session.model.contextWindow, 76000, 'fallback retains the context guard');
  assert.equal(f.session.thinkingLevel, 'high');
  assert.match(JSON.stringify(f.requests.at(-1)), /Durable change already applied/);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /no healthy deployments/);
  assert.equal(f.manager.getEntries().filter(e => e.type === 'message' && e.message.stopReason === 'error').length, 4,
    'raw failed attempts remain in the retained transcript');
  assert.equal(f.events.filter(e => e.event === 'fallback_selected').length, 1);
});

test('native primary recovery stops backoff immediately; retained fallback resumes without probing primary', { skip, timeout: 15000 }, async t => {
  const recovered = await fixture(t, { primaryFailures: 1 });
  await recovered.session.prompt('Finish the work.');
  assert.deepEqual(recovered.delays, [5000]);
  assert.equal(recovered.session.model.provider, 'primalabs');
  const restored = await fixture(t, { seed: manager => manager.appendCustomEntry('spec-provider-recovery', {
    version: 1, requested_model: selected, event: 'fallback_selected', effective_model: 'deepseek/deepseek-flash' }) });
  await restored.session.prompt('Continue preserved work.');
  assert.deepEqual(restored.requests.map(r => r.model), ['deepseek-flash']);
  assert.deepEqual(restored.delays, []);
});

test('native cancellation during backoff prevents another request or fallback', { skip, timeout: 15000 }, async t => {
  let waiting;
  const started = new Promise(resolve => { waiting = resolve; });
  const f = await fixture(t, { wait: (_ms, signal) => new Promise((resolve, reject) => {
    waiting(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const run = f.session.prompt('Finish the work.');
  await started;
  await f.session.abort();
  await run;
  assert.equal(f.requests.length, 1);
  assert.equal(f.events.some(e => e.event === 'fallback_selected'), false);
});

test('native fallback failure stops without cycling providers or repeating the assignment', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, { fallbackFails: true });
  await f.session.prompt('Finish the work.');
  assert.equal(f.requests.length, 5);
  assert.deepEqual(f.delays, [5000, 10000, 20000]);
  assert.equal(f.session.model.provider, 'deepseek');
  assert.equal(f.manager.getEntries().filter(e => e.type === 'message').at(-1).message.stopReason, 'error');
});

test('native retries count toward fallback instead of receiving a second retry budget', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t, { nativeRetry: true });
  await f.session.prompt('Finish the work.');
  assert.deepEqual(f.requests.map(r => r.model), [...Array(4).fill('primalabs-ai/MiMo-V2.6-Pro'), 'deepseek-flash']);
  assert.deepEqual(f.delays, [], 'native backoff already supplied the three waits');
  assert.equal(f.events.filter(e => e.event === 'fallback_selected').length, 1);
});
