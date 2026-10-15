import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POLICY, budgetModel, estimatePayload, inputTokens, installContextBudget } from './policy.mjs';

test('working cap preserves provider identity and smaller native limits; cached input counts toward budget', () => {
  const original = { id: 'model', provider: 'provider', contextWindow: 1048576, maxTokens: 65536, cost: { input: 1 } };
  assert.deepEqual(budgetModel(original), { ...original, contextWindow: 76000, maxTokens: 12000 });
  assert.equal(original.contextWindow, 1048576);
  assert.equal(budgetModel({ ...original, contextWindow: 32000, maxTokens: 4096 }).contextWindow, 32000);
  assert.equal(inputTokens({ input: 1000, cacheRead: 98000, cacheWrite: 2000, output: 999 }), 101000);
  assert.ok(estimatePayload({ messages: [{ content: '界'.repeat(90000) }] }) > POLICY.requestEstimateLimit);
  assert.ok(estimatePayload({ messages: [{ content: [{ type: 'image_url', image_url: { url: 'x'.repeat(1000000) } }] }] }) < 10000);
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
