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
