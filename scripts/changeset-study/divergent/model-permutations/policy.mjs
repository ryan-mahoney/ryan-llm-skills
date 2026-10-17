import { readFileSync } from 'node:fs';
import { compile } from '../../../changeset/engine.mjs';
import { preflightFocusedPlan } from '../../focused-editors.mjs';
import { validateStrategyPlan } from '../../strategies.mjs';
export const muse = 'openrouter/meta/muse-spark-1.3-contributor:high';
export const sol = 'openai-codex/gpt-6.1-sol:low';
export const deepseek = 'deepseek/deepseek-flash:off';
export const mimo = 'primalabs/primalabs-ai/MiMo-V2.6-Pro:medium';
export const metadata = JSON.parse(readFileSync(new URL('./metadata.json', import.meta.url)));
export const arms = [
  { id: 'muse-self', planner: muse, writer: null, representation: 'executable', prep: 'muse-executable' },
  { id: 'muse-deepseek', planner: muse, writer: deepseek, representation: 'delegated', prep: 'muse-delegated' },
  { id: 'sol-muse', planner: sol, writer: muse, representation: 'delegated', prep: 'sol-delegated' },
  { id: 'sol-mimo', planner: sol, writer: mimo, representation: 'delegated', prep: 'sol-delegated', reasoning_requested: 'medium', reasoning_effective: 'thinking enabled; no distinct medium wire setting' },
];
export const museModel = { id: metadata.model.id, name: metadata.model.name, api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1',
  reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 943718,
  cost: { input: .1, output: .2, cacheRead: .002, cacheWrite: .1 },
  thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
  compat: { supportsDeveloperRole: false, thinkingFormat: 'openrouter', supportsStrictMode: true, maxTokensField: 'max_tokens' } };
export function validatePlan(plan, representation, files, parse, remainingCalls = 96) {
  const operations = compile(plan);
  if (!operations.length || operations.length > 200) throw new Error('Plan requires 1–200 operations');
  if (representation === 'executable') {
    if (operations.some(operation => operation.executor !== 'deterministic')) throw new Error('Self arm requires executable deterministic edits only; no writer delegation');
  } else if (representation === 'delegated') {
    validateStrategyPlan('focused-dispatch', plan);
    if (operations.length * 2 > remainingCalls) throw new Error('Delegated assignments exceed remaining-call budget for two local attempts');
    const errors = preflightFocusedPlan(plan, files, { parse });
    if (errors.length) throw new Error(errors.join('; '));
  } else throw new Error('Unknown representation');
  return plan;
}
export function routeLimits(taskLimits, prep) {
  const model_calls = taskLimits.model_calls - prep.model_calls;
  const cell_ms = taskLimits.cell_ms - prep.elapsed_ms;
  if (model_calls < 1 || cell_ms <= 0) throw new Error('Preparation exhausted original per-route allowance');
  return { ...taskLimits, model_calls, cell_ms };
}

export const mimoModel = { id: 'primalabs-ai/MiMo-V2.6-Pro', name: 'MiMo V2.6 Pro', api: 'openai-completions', baseUrl: 'https://api.primalabs.ai/v1', reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 65536,
  cost: { input: .435, output: .87, cacheRead: .0036, cacheWrite: .435 },
  compat: { maxTokensField: 'max_tokens', thinkingFormat: 'chat-template', chatTemplateKwargs: { thinking: { $var: 'thinking.enabled' } } } };
export function checkLedgerState(state) {
  if (state?.schema_version !== 1 || state.limit_usd !== 50 || !Array.isArray(state.entries) || state.entries.some(entry =>
    entry.status === 'priced' ? !Number.isFinite(entry.charged_usd) || entry.charged_usd < 0 : entry.charged_usd != null))
    throw new Error('Shared ledger status/charge integrity is invalid');
  return state;
}

export function providerRegistration(model, custom = null) {
  return { models: [model], ...(model.provider === 'primalabs' ? { api: model.api, baseUrl: model.baseUrl, ...(custom?.apiKey ? { apiKey: custom.apiKey } : {}) } : {}) };
}
