// Focused: node --test scripts/changeset-research/cost.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { equivalentCost } from './cost.mjs';
test('Sol comparison uses DeepSeek token rates while preserving provider receipts', () => {
  const sol = { selector: 'openai-codex/gpt-6.1-sol:low', usage: { input: 1000000, output: 1000000, cacheRead: 500000, cacheWrite: 0, cost: { total: 12 } } };
  const deepseek = { selector: 'deepseek/deepseek-flash:low', usage: { cost: { total: 0.5 } } };
  assert.equal(equivalentCost([sol, deepseek]), 2.003);
  assert.equal(sol.usage.cost.total, 12);
  assert.equal(equivalentCost([sol, { selector: 'unknown', usage: {} }]), null);
  assert.equal(equivalentCost([]), null);
  assert.equal(equivalentCost([{selector:sol.selector,usage:{input:0,output:0,cacheRead:0,cacheWrite:0}}]),null);
});
