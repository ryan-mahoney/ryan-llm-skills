import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Budget, modelRuntime, parseSelector, parseJson } from '../changeset/models.mjs';
import { registerStudyModel } from './model-catalog.mjs';

export function sdkRoot() {
  if (process.env.CHANGESET_STUDY_SDK_ROOT) return process.env.CHANGESET_STUDY_SDK_ROOT;
  const base = process.env.PI_MANAGED_INSTALL_ROOT || join(homedir(), '.pi/agent/install');
  const version = readFileSync(join(base, 'current-version'), 'utf8').trim();
  if (!/^[\w.-]+$/.test(version) || version === '..') throw new Error('Invalid SDK version');
  return join(base, 'releases', version, 'node_modules/@earendil-works');
}
export async function sdkImport(path) { return import(pathToFileURL(join(sdkRoot(), path)).href); }

export class ModelJsonParseError extends SyntaxError {
  constructor(error, text) {
    super(error.message, { cause: error });
    this.name = 'ModelJsonParseError';
    this.responseExcerpt = text.slice(0, 12000);
  }
}

export class Client {
  static async create(options) {
    const runtime = await modelRuntime();
    await registerStudyModel(runtime, options.selector);
    return new Client({ ...options, runtime });
  }
  // `shared` lets two clients in one cell (mixed routing) draw on one call limit.
  constructor({ runtime, selector, ledger, receiptPath, signal, maxCalls = 32, maxTokens = 16000, callMs = 120000, shared = null }) {
    Object.assign(this, { runtime, selector, receiptPath, signal, maxCalls, maxTokens, callMs, shared });
    const { provider, id, reasoning } = parseSelector(selector);
    this.model = runtime.getModel(provider, id); this.reasoning = reasoning;
    if (!this.model || !runtime.hasConfiguredAuth(provider)) throw new Error(`Unavailable model: ${selector}`);
    // The subscription adapter omits maxTokens from its payload. Reserve against
    // the full advertised context/output capacity instead of that unenforced limit.
    this.reservationOutputTokens = provider === 'openai-codex'
      ? Math.max(maxTokens, this.model.maxTokens ?? 0, this.model.contextWindow ?? 0) : maxTokens;
    this.budget = new Budget(ledger, 50); this.receipts = []; this.calls = 0;
  }
  begin(context, externalSignal, stage) {
    if (this.signal?.aborted || externalSignal?.aborted) throw new Error('Cell deadline exceeded');
    const counter = this.shared ?? this;
    if (counter.calls >= this.maxCalls) throw new Error('Cell model-call limit exceeded');
    const rates = [this.model.cost, ...(this.model.cost?.tiers ?? [])];
    const inputRate = Math.max(...rates.flatMap(r => [r.input, r.cacheRead ?? 0, r.cacheWrite ?? 0]));
    const outputRate = Math.max(...rates.map(r => r.output));
    const bytes = Buffer.byteLength(JSON.stringify(context)) + 8192;
    const reservation = this.budget.reserve(this.selector, (bytes * inputRate + this.reservationOutputTokens * outputRate) / 1e6 * 1.25);
    counter.calls++; if (counter !== this) this.calls++;
    appendFileSync(this.receiptPath.replace(/receipts\.jsonl$/, 'requests.jsonl'), JSON.stringify({ reservation, selector: this.selector, stage, context }) + '\n');
    const signal = AbortSignal.any([AbortSignal.timeout(this.callMs), ...[this.signal, externalSignal].filter(Boolean)]);
    const started = Date.now(); let settled = false;
    const finish = (response, error) => {
      if (settled) return; settled = true;
      this.budget.settle(reservation, response?.usage);
      const receipt = { selector: this.selector, stage, elapsed_ms: Date.now() - started, usage: response?.usage ?? null,
        stop_reason: response?.stopReason ?? 'exception', error: error?.message ?? response?.errorMessage ?? null, reservation };
      this.receipts.push(receipt); appendFileSync(this.receiptPath, JSON.stringify(receipt) + '\n');
      appendFileSync(this.receiptPath.replace(/receipts\.jsonl$/, 'responses.jsonl'), JSON.stringify({ reservation, stage, response: response ?? null, error: error?.message ?? null }) + '\n');
    };
    return { finish, options: { maxTokens: this.maxTokens, reasoning: this.reasoning === 'off' ? undefined : this.reasoning,
      maxRetries: 0, timeoutMs: this.callMs, signal } };
  }
  async json(systemPrompt, prompt, stage) {
    const context = { systemPrompt, messages: [{ role: 'user', content: typeof prompt === 'string' ? prompt : JSON.stringify(prompt), timestamp: Date.now() }] };
    const { finish, options } = this.begin(context, null, stage);
    let response;
    try {
      response = await this.runtime.completeSimple(this.model, context, options); finish(response);
      if (response.stopReason !== 'stop') throw new Error(`Model stopped: ${response.stopReason}: ${response.errorMessage ?? ''}`);
      const text = response.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      try { return parseJson(text); }
      catch (error) {
        if (error instanceof SyntaxError) throw new ModelJsonParseError(error, text);
        throw error;
      }
    } catch (error) { finish(response, error); throw error; }
  }
  stream(stage) {
    return async (_model, context, suppliedOptions) => {
      const { finish, options } = this.begin(context, suppliedOptions?.signal, stage);
      let stream;
      try { stream = this.runtime.streamSimple(this.model, context, { ...suppliedOptions, ...options }); }
      catch (error) { finish(null, error); throw error; }
      const result = Promise.resolve(stream.result()).then(message => { finish(message); return message; }, error => { finish(null, error); throw error; });
      // Settlement is part of stream completion, before another request starts.
      return { result: () => result, async *[Symbol.asyncIterator]() { try { for await (const event of stream) yield event; await result; } catch (error) { finish(null, error); throw error; } } };
    };
  }
}
