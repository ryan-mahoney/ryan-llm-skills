import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client, sdkImport } from '../../client.mjs';
import { muse, museModel, mimo, mimoModel, deepseek, providerRegistration, checkLedgerState } from '../model-permutations/policy.mjs';
import { validateLedger, read } from '../writer-control/support.mjs';
export const deepseekPin = JSON.parse(readFileSync(new URL('./deepseek-metadata.json', import.meta.url)));
export const models = [{ selector: deepseek, model: deepseekPin.model }, { selector: muse, model: { ...museModel, provider: 'openrouter' } }, { selector: mimo, model: { ...mimoModel, provider: 'primalabs' }, reasoning_effective: 'thinking enabled; no distinct medium wire setting' }];
export async function oneTextCall({ selector, ledger, directory, context, signal, runtime = null, maxOutputTokens = 8192, callMs = 120000, beforeCall = () => {} }) {
  const selected = models.find(row => row.selector === selector); if (!selected) throw new Error('Unauthorized suite selector');
  const canonical = validateLedger(ledger); checkLedgerState(canonical.state);
  if (!runtime) {
    const { ModelRuntime } = await sdkImport('pi-coding-agent/dist/core/model-runtime.js');
    runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    let custom = null;
    if (selected.model.provider === 'primalabs') custom = JSON.parse(readFileSync(join(homedir(), '.pi/agent/models.json'), 'utf8')).providers?.primalabs;
    runtime.registerProvider(selected.model.provider, providerRegistration(selected.model, custom));
    await runtime.refresh({ allowNetwork: false, providers: [selected.model.provider] });
  }
  const client = new Client({ runtime, selector, ledger: canonical.path, receiptPath: join(directory, 'receipts.jsonl'), maxCalls: 1, maxTokens: maxOutputTokens, callMs, signal });
  beforeCall(reservationCeiling(context, client.model, client.reservationOutputTokens)); const began = performance.now();
  const { finish, options } = client.begin(context, null, 'suite'); let response;
  try { response = await runtime.completeSimple(client.model, context, options); finish(response); }
  catch (error) { finish(response, error); return { text: null, stop_reason: response?.stopReason ?? 'exception', error: error.message, elapsed_ms: performance.now() - began }; }
  const text = response.content?.filter(part => part.type === 'text').map(part => part.text).join('') ?? '';
  return { text, stop_reason: response.stopReason, error: response.errorMessage ?? null, elapsed_ms: performance.now() - began, usage: response.usage ?? null };
}

export function reservationCeiling(context, model, outputTokens = 8192) {
  const rates = [model.cost, ...(model.cost.tiers ?? [])];
  const input = Math.max(...rates.flatMap(rate => [rate.input, rate.cacheRead ?? 0, rate.cacheWrite ?? 0]));
  const output = Math.max(...rates.map(rate => rate.output));
  return ((Buffer.byteLength(JSON.stringify(context)) + 8192) * input + outputTokens * output) / 1e6 * 1.25;
}
