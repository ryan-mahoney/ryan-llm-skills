import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Client } from '../../client.mjs';
import { modelRuntime } from '../../../changeset/models.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const metadata = JSON.parse(readFileSync(new URL('./openrouter-metadata.json', import.meta.url), 'utf8'));
export const metadataHash = digest(readFileSync(new URL('./openrouter-metadata.json', import.meta.url)));
export class WriterError extends Error {
  constructor(code, message) { super(message); this.name = 'WriterError'; this.code = code; }
}
const fail = (code, message) => { throw new WriterError(code, message); };

export function selectedModel(selector) {
  const row = metadata.models.find(row => selector === `openrouter/${row.catalog.id}`);
  if (!row) fail('model', 'Select an explicitly pinned OpenRouter apply model without a reasoning suffix');
  const endpoints = row.endpoints.filter(endpoint => endpoint.status === 0);
  if (!endpoints.length) fail('model', 'Pinned model has no active endpoint');
  const catalog = row.catalog;
  const pricing = [catalog.pricing, ...endpoints.map(endpoint => endpoint.pricing)];
  return { id: catalog.id, name: catalog.name, api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1',
    reasoning: false, input: ['text'], compat: { maxTokensField: 'max_tokens' },
    contextWindow: Math.min(catalog.context_length, ...endpoints.map(endpoint => endpoint.context_length)),
    maxTokens: Math.min(catalog.top_provider.max_completion_tokens, ...endpoints.map(endpoint => endpoint.max_completion_tokens)),
    cost: { input: Math.max(...pricing.map(rate => Number(rate.prompt))) * 1e6,
      output: Math.max(...pricing.map(rate => Number(rate.completion))) * 1e6,
      // No discounted cache price is advertised; reservations never assume a cache saving.
      cacheRead: Math.max(...pricing.map(rate => Number(rate.prompt))) * 1e6,
      cacheWrite: Math.max(...pricing.map(rate => Number(rate.prompt))) * 1e6 } };
}

function ledgerPath(path) {
  let canonical, ledger;
  try { canonical = realpathSync(path); ledger = JSON.parse(readFileSync(canonical, 'utf8')); }
  catch { fail('ledger', 'An existing shared budget ledger is required'); }
  if (ledger.schema_version !== 1 || ledger.limit_usd !== 50 || !Array.isArray(ledger.entries))
    fail('ledger', 'Shared ledger must use schema 1 and limit 50');
  const ids = new Set();
  for (const entry of ledger.entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
        typeof entry.selector !== 'string' || !entry.selector.includes('/') ||
        !Number.isFinite(entry.reserved_usd) || entry.reserved_usd <= 0 ||
        !['reserved', 'priced', 'unknown'].includes(entry.status) ||
        (entry.status === 'priced'
          ? !(Number.isFinite(entry.charged_usd) && entry.charged_usd >= 0)
          : entry.charged_usd != null))
      fail('ledger', 'Shared ledger contains an invalid reservation');
    ids.add(entry.id);
  }
  return canonical;
}
const validPath = path => typeof path === 'string' && path.length > 0 && !path.includes('\\') && !path.includes('\0') &&
  !path.split('/').some(part => !part || part === '.' || part === '..') && !/^[A-Za-z]:/.test(path);

export function buildInput({ path, source, sourceHash, instruction, update, allowedPaths, protectedPaths = [] }, model, maxTokens) {
  if (!validPath(path) || !Array.isArray(allowedPaths) || !allowedPaths.every(validPath) || !allowedPaths.includes(path) ||
      !Array.isArray(protectedPaths) || protectedPaths.some(protectedPath => path === protectedPath || path.startsWith(protectedPath + '/')))
    fail('path', 'File must be an explicitly allowed relative path outside protected paths');
  if (typeof source !== 'string' || !/^[a-f0-9]{64}$/.test(sourceHash ?? '') || digest(source) !== sourceHash)
    fail('source', 'Current file source hash is required and must match');
  if (typeof instruction !== 'string' || !instruction.trim() || typeof update !== 'string' || !update.trim())
    fail('input', 'Settled owner instruction and update snippet are required');
  // Escaping would alter exact source bytes. Refuse ambiguous delimiters instead.
  for (const value of [instruction, source, update]) if (/<\/?(?:instruction|code|update)(?:\s|>)/i.test(value))
    fail('delimiter', 'Input contains reserved apply prompt delimiters');
  const content = `<instruction>${instruction}</instruction>\n<code>${source}</code>\n<update>${update}</update>`;
  const context = { messages: [{ role: 'user', content, timestamp: Date.now() }] };
  const bytes = Buffer.byteLength(JSON.stringify(context));
  // No vendor tokenizer is available. UTF-8 bytes plus framing reserve are a conservative
  // eligibility guard, not a measured token count or a guarantee of provider acceptance.
  if (bytes + maxTokens + 1024 > model.contextWindow)
    fail('context-cap', 'Full file and update exceed the conservative input/output context budget; no chunking or truncation is performed');
  return { context, inputBytes: bytes };
}

function syntax(path, text) {
  const mode = /\.cjs$/.test(path) ? 'commonjs' : /\.(?:mjs|js)$/.test(path) ? 'module' : null;
  if (!mode) return false;
  try { execFileSync(process.execPath, [`--input-type=${mode}`, '--check'], { input: text, timeout: 3000, maxBuffer: 16384, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { fail('syntax', 'Returned full file failed JavaScript syntax validation'); }
  return true;
}

/** No candidate filesystem writes or changeset operations: one owner-prepared file update. */
export async function createWriter({ selector, ledger, receiptPath, maxOutputTokens, maxOutputBytes = 2_000_000,
  maxCalls = 32, callMs = 120000, signal, shared, runtime = null }) {
  const model = selectedModel(selector);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > model.maxTokens)
    fail('output-cap', `Explicit maxOutputTokens must be between 1 and ${model.maxTokens}`);
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) fail('output-cap', 'Output byte cap must be positive');
  const canonicalLedger = ledgerPath(ledger);
  runtime ??= await modelRuntime();
  runtime.registerProvider('openrouter', { models: [model] });
  await runtime.refresh({ allowNetwork: false, providers: ['openrouter'] });
  const client = new Client({ runtime, selector, ledger: canonicalLedger, receiptPath, maxTokens: maxOutputTokens, maxCalls, callMs, signal, shared });
  return { selector, model, metadataHash, client,
    async write(input) {
      const { path, source, sourceHash } = input;
      const { context, inputBytes } = buildInput(input, model, maxOutputTokens);
      // Source/output eligibility is explicit, never inherited from historical writer caps.
      if (Buffer.byteLength(source) > maxOutputBytes) fail('output-cap', 'Current source already exceeds the requested full-file output byte cap');
      if (ledgerPath(canonicalLedger) !== canonicalLedger) fail('ledger', 'Canonical shared ledger identity changed');
      const { finish, options } = client.begin(context, null, 'specialized-writer');
      let response;
      try { response = await runtime.completeSimple(client.model, context, options); finish(response); }
      catch (error) { finish(response, error); throw error; }
      if (response.stopReason !== 'stop') fail('truncated-or-failed', `Full-file response did not stop normally: ${response.stopReason}`);
      if (!Array.isArray(response.content) || response.content.some(part => part.type !== 'text')) fail('response', 'Apply model must return only full-file text');
      const text = response.content.map(part => part.text).join('');
      if (!text.length || Buffer.byteLength(text) > maxOutputBytes) fail('output-cap', 'Returned full file is empty or exceeds the byte cap');
      if (text.startsWith('```')) fail('response', 'Return raw full-file text without Markdown fences');
      const syntaxChecked = syntax(path, text);
      return { path, source_hash: sourceHash, output_hash: digest(text), text,
        selector, metadata_hash: metadataHash, input_bytes: inputBytes, max_output_tokens: maxOutputTokens,
        max_output_bytes: maxOutputBytes, syntax_checked: syntaxChecked, usage: response.usage ?? null };
    } };
}
