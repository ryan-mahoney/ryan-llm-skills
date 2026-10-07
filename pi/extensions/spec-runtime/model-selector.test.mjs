import test from 'node:test';
import assert from 'node:assert/strict';
import { splitModelSelector, assertModelSelector, configurationFailure } from './model-selector.mjs';

test('preserves nested model IDs and variant colons while separating provider and thinking', () => {
  assert.deepEqual(splitModelSelector('openrouter/deepseek/deepseek-v4.1-flash:high'), { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', thinking: 'high' });
  assert.deepEqual(splitModelSelector('vendor/team/model:batch:low'), { provider: 'vendor', model: 'team/model:batch', thinking: 'low' });
  assert.deepEqual(splitModelSelector('vendor/team/model:batch'), { provider: 'vendor', model: 'team/model:batch', thinking: undefined });
  assert.deepEqual(splitModelSelector('deepseek/deepseek-flash:max'), { provider: 'deepseek', model: 'deepseek-flash', thinking: 'max' });
  assert.throws(() => splitModelSelector('model'), /provider\/model/);
});

test('rejects fuzzy variants, wrong providers and missing model instead of substituting', () => {
  const selector = 'openrouter/deepseek/deepseek-v4.1-flash:high';
  assertModelSelector(selector, { provider: 'openrouter', id: 'deepseek/deepseek-v4.1-flash' });
  for (const selected of [{ provider: 'openrouter', id: 'deepseek/deepseek-v4.1-flash:batch' }, { provider: 'deepseek', id: 'deepseek/deepseek-v4.1-flash' }, undefined])
    assert.throws(() => assertModelSelector(selector, selected), /SPEC_MODEL_SELECTOR_MISMATCH/);
});

test('configuration errors require an explicit model or adapter diagnosis, not HTTP status alone', () => {
  for (const error of ['404 model does not exist', '404 This model does not support chat/completions', '404 This model cannot be used with the chat/completions endpoint (adapter DeepInfraBatchAdapter)', 'Unknown provider: vendor', 'SPEC_MODEL_SELECTOR_MISMATCH: wrong variant'])
    assert.equal(configurationFailure(error)?.kind, 'model_configuration', error);
  for (const error of ['404 Not Found', '404 upstream request failed', '503 Service Unavailable', '429 Too Many Requests', 'ECONNRESET', 'Request timed out'])
    assert.equal(configurationFailure(error), undefined, error);
});
