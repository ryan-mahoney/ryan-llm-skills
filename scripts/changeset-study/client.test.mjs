import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from './client.mjs';

test('client stores trusted writer-attempt metadata in request and receipt without adding it to the prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'study-client-audit-'));
  try {
    const runtime = {
      getModel: () => ({ cost: { input: 1, output: 1 } }),
      hasConfiguredAuth: () => true,
      completeSimple: async (_model, context) => {
        assert.equal(JSON.parse(context.messages[0].content).instruction, 'Set answer to 2.');
        return { stopReason: 'stop', content: [{ type: 'text', text: '{"edits":[]}' }],
          usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.0001 } } };
      },
    };
    const receiptPath = join(root, 'receipts.jsonl');
    const client = new Client({ runtime, selector: 'deepseek/deepseek-flash:off', ledger: join(root, 'ledger.json'), receiptPath });
    await client.json('system', { instruction: 'Set answer to 2.' }, 'editor', { operation_id: 'answer', writer_attempt: 0 });
    const request = JSON.parse(readFileSync(join(root, 'requests.jsonl'), 'utf8').trim());
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8').trim());
    for (const row of [request, receipt]) {
      assert.equal(row.operation_id, 'answer');
      assert.equal(row.writer_attempt, 0);
      assert.equal(row.stage, 'editor');
      assert.equal(row.selector, 'deepseek/deepseek-flash:off');
    }
    assert.deepEqual(JSON.parse(request.context.messages[0].content), { instruction: 'Set answer to 2.' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function textFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'study-client-text-'));
  const usage = { input: 10, output: 2, totalTokens: 12, cost: { total: 0.0001 } };
  const runtime = { getModel: () => ({ cost: { input: 1, output: 1 } }), hasConfiguredAuth: () => true,
    completeSimple: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: 'raw' }], usage }) };
  const ledger = join(root, 'ledger.json'), receiptPath = join(root, 'receipts.jsonl');
  const client = new Client({ runtime, selector: 'deepseek/deepseek-flash:off', ledger, receiptPath, ...options });
  return { root, runtime, client, ledger, receiptPath, usage, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('text preserves raw fragments and fences while settling one attributed request without JSON parsing', async () => {
  const f = textFixture();
  try {
    let calls = 0;
    f.runtime.completeSimple = async (_model, context, options) => {
      calls++; assert.equal(context.systemPrompt, 'raw writer'); assert.equal(context.messages[0].content, 'literal\ninput');
      assert.equal(options.maxRetries, 0);
      return { stopReason: 'stop', content: [{ type: 'text', text: '```patch\n{invalid' },
        { type: 'thinking', thinking: 'not output' }, { type: 'text', text: ' JSON}\n```\n' }], usage: f.usage };
    };
    const raw = await f.client.text('raw writer', 'literal\ninput', 'writer', { operation_id: 'file-a', writer_attempt: 1 });
    assert.equal(raw, '```patch\n{invalid JSON}\n```\n'); assert.equal(calls, 1); assert.equal(f.client.calls, 1);
    const ledger = JSON.parse(readFileSync(f.ledger)); assert.equal(ledger.entries.length, 1); assert.equal(ledger.entries[0].charged_usd, .0001);
    const request = JSON.parse(readFileSync(join(f.root, 'requests.jsonl'), 'utf8').trim());
    const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8').trim());
    for (const row of [request, receipt]) { assert.equal(row.operation_id, 'file-a'); assert.equal(row.writer_attempt, 1); assert.equal(row.stage, 'writer'); }
    assert.equal(request.context.messages[0].content, 'literal\ninput'); assert.equal(receipt.stop_reason, 'stop');
  } finally { f.cleanup(); }
});

test('text length and provider stops throw after accounting and transport errors retain identity without retries', async () => {
  const f = textFixture();
  try {
    let calls = 0;
    for (const stopReason of ['length', 'error']) {
      f.runtime.completeSimple = async () => { calls++; return { stopReason, errorMessage: 'upstream', content: [{ type: 'text', text: 'partial' }], usage: f.usage }; };
      await assert.rejects(f.client.text('system', { instruction: 'write' }, 'writer'), error => error.name !== 'ModelJsonParseError' && error.message.startsWith('Model stopped: ' + stopReason));
    }
    const transport = new SyntaxError('transport decoder failed');
    f.runtime.completeSimple = async () => { calls++; throw transport; };
    await assert.rejects(f.client.text('system', 'write', 'writer'), error => error === transport);
    assert.equal(calls, 3);
    const ledger = JSON.parse(readFileSync(f.ledger)); assert.equal(ledger.entries.length, 3);
    assert.deepEqual(ledger.entries.map(e => e.status), ['priced', 'priced', 'unknown']);
    assert.equal(readFileSync(f.receiptPath, 'utf8').trim().split('\n').length, 3);
  } finally { f.cleanup(); }
});

test('text respects shared call budgets and aborts before transport or after a late response', async () => {
  const shared = { calls: 0 }, f = textFixture({ shared, maxCalls: 1 });
  try {
    let calls = 0;
    f.runtime.completeSimple = async () => { calls++; return { stopReason: 'stop', content: [{ type: 'text', text: 'one' }], usage: f.usage }; };
    assert.equal(await f.client.text('system', 'one', 'writer'), 'one');
    await assert.rejects(f.client.text('system', 'two', 'writer'), /model-call limit/); assert.equal(calls, 1); assert.equal(shared.calls, 1);
    const other = new Client({ runtime: f.runtime, selector: 'deepseek/deepseek-flash:off', ledger: f.ledger, receiptPath: f.receiptPath, shared, maxCalls: 1 });
    await assert.rejects(other.text('system', 'three', 'writer'), /model-call limit/); assert.equal(calls, 1);
    const aborted = new AbortController(); aborted.abort();
    const before = new Client({ runtime: f.runtime, selector: 'deepseek/deepseek-flash:off', ledger: f.ledger, receiptPath: f.receiptPath, signal: aborted.signal });
    await assert.rejects(before.text('system', 'four', 'writer'), /deadline/); assert.equal(calls, 1);
    const controller = new AbortController();
    const late = new Client({ runtime: f.runtime, selector: 'deepseek/deepseek-flash:off', ledger: f.ledger, receiptPath: f.receiptPath, signal: controller.signal });
    f.runtime.completeSimple = async () => { calls++; controller.abort(); return { stopReason: 'stop', content: [{ type: 'text', text: 'late' }], usage: f.usage }; };
    await assert.rejects(late.text('system', 'five', 'writer'), /deadline/); assert.equal(calls, 2);
    assert.equal(late.receipts[0].error, 'Cell deadline exceeded');
    assert.equal(JSON.parse(readFileSync(f.ledger)).entries.length, 2);
    const spent = JSON.parse(readFileSync(f.ledger)).entries.reduce((sum, entry) => sum + entry.charged_usd, 0);
    f.client.budget.reserve('fixture/control', 50 - spent);
    const exhausted = new Client({ runtime: f.runtime, selector: 'deepseek/deepseek-flash:off', ledger: f.ledger, receiptPath: f.receiptPath });
    await assert.rejects(exhausted.text('system', 'six', 'writer'), error => error.message === 'Campaign budget exhausted' && error.name !== 'ModelJsonParseError');
    assert.equal(calls, 2); assert.equal(JSON.parse(readFileSync(f.ledger)).entries.length, 3);
  } finally { f.cleanup(); }
});
