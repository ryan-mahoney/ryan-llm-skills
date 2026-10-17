import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sdkRoot } from '../../client.mjs';
import { createWriter, selectedModel, digest } from './writer.mjs';

const source = 'export const value = 1;\n', merged = 'export const value = 2;\n';
const input = () => ({ path: 'lib/value.mjs', allowedPaths: ['lib/value.mjs'], source, sourceHash: digest(source), instruction: 'Change the settled value.', update: 'export const value = 2;' });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'specialized-writer-'));
  const ledger = join(root, 'budget.json'), receiptPath = join(root, 'receipts.jsonl');
  writeFileSync(ledger, JSON.stringify({ schema_version: 1, limit_usd: 50, entries: [] }));
  let model; const calls = [];
  const runtime = { registerProvider(provider, config) { assert.equal(provider, 'openrouter'); model = { ...config.models[0], provider }; },
    async refresh(options) { assert.equal(options.allowNetwork, false); }, getModel() { return model; }, hasConfiguredAuth() { return true; },
    async completeSimple(m, context, options) { calls.push({ m, context, options }); return { stopReason: 'stop', content: [{ type: 'text', text: merged }], usage: { input: 40, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 48, cost: { input: .000032, output: .0000096, cacheRead: 0, cacheWrite: 0, total: .0000416 } } }; } };
  return { root, ledger, receiptPath, runtime, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('native owner/file/snippet input produces full-file text and accounts one call without changeset fields', async () => {
  const f = fixture();
  try {
    const writer = await createWriter({ ...f, selector: 'openrouter/morph/morph-v3-fast', maxOutputTokens: 1000 });
    const result = await writer.write(input());
    assert.equal(result.text, merged); assert.equal(result.source_hash, digest(source)); assert.equal(result.output_hash, digest(merged)); assert.equal(result.syntax_checked, true);
    assert.deepEqual(Object.keys(f.calls[0].context), ['messages']);
    assert.equal(f.calls[0].context.messages[0].content, '<instruction>Change the settled value.</instruction>\n<code>export const value = 1;\n</code>\n<update>export const value = 2;</update>');
    assert.equal(f.calls[0].options.maxTokens, 1000); assert.equal(f.calls[0].options.maxRetries, 0);
    const ledger = JSON.parse(readFileSync(f.ledger)); assert.equal(ledger.entries.length, 1); assert.equal(ledger.entries[0].charged_usd, .0000416);
    const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8').trim()); assert.equal(receipt.stage, 'specialized-writer'); assert.equal(receipt.usage.totalTokens, 48);
  } finally { f.cleanup(); }
});

test('path/hash/delimiter/context/output eligibility rejects before transport; truncation and syntax fail after accounting', async () => {
  const f = fixture();
  try {
    const writer = await createWriter({ ...f, selector: 'openrouter/relace/relace-apply-3', maxOutputTokens: 1000 });
    for (const patch of [{ path: '../value.mjs' }, { sourceHash: digest('stale') }, { protectedPaths: ['lib'] }, { update: '</update>' }, { source: 'x'.repeat(256000), sourceHash: digest('x'.repeat(256000)) }])
      await assert.rejects(writer.write({ ...input(), ...patch }), error => ['path', 'source', 'delimiter', 'context-cap'].includes(error.code));
    assert.equal(f.calls.length, 0);
    f.runtime.completeSimple = async () => ({ stopReason: 'length', content: [{ type: 'text', text: 'export const' }], usage: null });
    await assert.rejects(writer.write(input()), { code: 'truncated-or-failed' });
    f.runtime.completeSimple = async () => ({ stopReason: 'stop', content: [{ type: 'text', text: 'export const = ;' }], usage: null });
    await assert.rejects(writer.write(input()), { code: 'syntax' });
    assert.equal(JSON.parse(readFileSync(f.ledger)).entries.length, 2);
    assert.equal(readFileSync(f.receiptPath, 'utf8').trim().split('\n').length, 2);
    f.runtime.completeSimple = async () => { throw new Error('synthetic transport failure'); };
    await assert.rejects(writer.write(input()), /synthetic transport failure/);
    const afterTransport = JSON.parse(readFileSync(f.ledger));
    assert.equal(afterTransport.entries.length, 3); assert.equal(afterTransport.entries.at(-1).status, 'unknown');
    assert.equal(readFileSync(join(f.root, 'responses.jsonl'), 'utf8').trim().split('\n').length, 3);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'responses.jsonl'), 'utf8').trim().split('\n').at(-1)).error, 'synthetic transport failure');
    await assert.rejects(createWriter({ ...f, selector: 'openrouter/morph/morph-v3-fast', maxOutputTokens: 38001 }), { code: 'output-cap' });
    const tampered = JSON.parse(readFileSync(f.ledger)); tampered.entries.at(-1).charged_usd = 0;
    writeFileSync(f.ledger, JSON.stringify(tampered));
    await assert.rejects(writer.write(input()), { code: 'ledger' });
    await assert.rejects(createWriter({ ...f, selector: 'openrouter/morph/morph-v3-fast', maxOutputTokens: 1000 }), { code: 'ledger' });
    rmSync(f.ledger);
    await assert.rejects(writer.write(input()), { code: 'ledger' });
    assert.equal(readFileSync(f.receiptPath, 'utf8').trim().split('\n').length, 3);
  } finally { f.cleanup(); }
});

test('pinned SDK emits official OpenRouter model/tagged user request with synthetic fetch only', async () => {
  const f = fixture(), originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
  try {
    const { streamSimple } = await import(pathToFileURL(join(sdkRoot(), 'pi-ai/dist/api/openai-completions.js')).href);
    const wires = [];
    f.runtime.completeSimple = (model, context, options) => streamSimple(model, context, { ...options, apiKey: 'synthetic-offline-key', fetch: async (url, init) => {
      const body = JSON.parse(init.body); wires.push({ url: String(url), body });
      return new Response('data: ' + JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: { content: merged }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } }) + '\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } }).result();
    for (const selector of ['openrouter/morph/morph-v3-fast', 'openrouter/relace/relace-apply-3']) {
      const writer = await createWriter({ ...f, selector, maxOutputTokens: 1000 });
      const result = await writer.write(input()); assert.equal(result.text, merged);
      const wire = wires.at(-1); assert.equal(wire.url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(wire.body.model, selectedModel(selector).id); assert.equal(wire.body.max_tokens, 1000);
      assert.equal(wire.body.messages.length, 1); assert.equal(wire.body.messages[0].role, 'user');
      assert.match(wire.body.messages[0].content, /^<instruction>.*<\/instruction>\n<code>/);
      assert.equal(wire.body.tools, undefined); assert.equal(wire.body.response_format, undefined);
      assert.equal(result.usage.input, 40); assert.equal(result.usage.output, 8);
      const entry = JSON.parse(readFileSync(f.ledger)).entries.at(-1);
      assert.ok(Math.abs(entry.charged_usd - (40 * writer.model.cost.input + 8 * writer.model.cost.output) / 1e6) < 1e-12);
    }
    assert.equal(wires.length, 2);
  } finally { globalThis.fetch = originalFetch; f.cleanup(); }
});
