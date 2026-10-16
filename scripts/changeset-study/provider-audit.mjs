#!/usr/bin/env node
// Inspect the installed Sol adapter's request construction without network access.
// A synthetic credential satisfies local parsing; onPayload throws before transport.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from '../changeset/workspace.mjs';
import { sdkRoot, sdkImport } from './client.mjs';

const root = sdkRoot(), module = 'pi-ai/dist/api/openai-codex-responses.js';
const { streamSimple } = await sdkImport(module);
const model = JSON.parse(readFileSync(join(root, 'pi-ai/dist/providers/data/openai-codex.json'), 'utf8'))
  ['openai-codex-responses']['chat:gpt-6.1-sol'];
const credential = 'offline.' + Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'offline-no-network' },
})).toString('base64url') + '.offline';
let observed;
const result = await streamSimple(model, { messages: [
  { role: 'system', content: 'Offline instruction marker', timestamp: 0 },
  { role: 'user', content: 'Offline request; never send', timestamp: 0 },
] }, {
  apiKey: credential, reasoning: 'low', maxTokens: 32000,
  onPayload: body => {
    observed = { model: body.model, instructions: body.instructions, reasoning: body.reasoning, text: body.text,
      max_output_tokens: body.max_output_tokens ?? null, max_completion_tokens: body.max_completion_tokens ?? null };
    throw new Error('OFFLINE_PAYLOAD_CAPTURE_NO_NETWORK');
  },
}).result();
if (!observed || !result.errorMessage?.includes('OFFLINE_PAYLOAD_CAPTURE_NO_NETWORK')) throw new Error('Offline interception did not succeed');
console.log(JSON.stringify({ observed, requested_max_tokens: 32000,
  transport: 'aborted in onPayload before headers/network', module,
  module_sha256: hash(readFileSync(join(root, module))) }, null, 2));
