import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

// Working limits, not provider capabilities or prices. Leave headroom below the
// operator's 100k input ceiling for schemas, token-estimation error and tool bursts.
export const POLICY = Object.freeze({ contextWindow: 76000,
  requestEstimateLimit: 90000, toolTextChars: 12000 });
const installed = new WeakSet();

export function budgetModel(model) {
  if (!model || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return model;
  // Output and thinking budgets have different semantics across providers. This
  // policy controls retained input; preserve the selected model's output limit.
  return { ...model, contextWindow: Math.min(model.contextWindow, POLICY.contextWindow) };
}

// Full provider payload: system prompt, cached conversation, tools and reasoning
// all count. This deliberately estimates conservatively; it is not a tokenizer.
// Images need an allowance rather than counting base64 as textual tokens.
export function estimatePayload(payload) {
  let images = 0;
  const text = JSON.stringify(payload, (key, value) => {
    if (value && typeof value === 'object' &&
        (value.type === 'image' || value.type === 'image_url' || value.type === 'input_image')) {
      images++; return '[image]';
    }
    return value;
  });
  return Math.ceil(Buffer.byteLength(text || '', 'utf8') / 3) + images * 4096 + 1024;
}

export function inputTokens(usage) {
  return ['input', 'cacheRead', 'cacheWrite'].reduce((sum, key) =>
    sum + (Number.isFinite(usage?.[key]) ? usage[key] : 0), 0);
}

export function boundedToolContent(content, artifact) {
  const length = content.reduce((n, block) => n + (block.type === 'text' ? block.text.length : 0), 0);
  if (length <= POLICY.toolTextChars) return content;
  // Preserve non-text blocks and error tails. The full result remains recoverable.
  const all = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  return [{ type: 'text', text: `${all.slice(0, 8000)}\n\n[Output abbreviated. Full result: ${artifact}. Read only the missing range; do not rerun the command or infer omitted code.]\n\n${all.slice(-2000)}` },
    ...content.filter(block => block.type !== 'text')];
}

export function installContextBudget(pi) {
  if (installed.has(pi)) return;
  installed.add(pi);
  // Pi gives each extension a different API object. Elect one installer on its
  // shared event bus; subscriptions are removed by Pi on extension reload.
  let claimed = false;
  pi.events?.emit('context-budget:claim', () => { claimed = true; });
  if (claimed) return;
  pi.events?.on('context-budget:claim', claim => claim());
  let applying = false;
  let lastEstimate = 0;
  const record = data => pi.appendEntry('context-budget', { version: 1, ...data });
  const apply = async (_event, ctx) => {
    if (applying || !ctx.model) return;
    const model = budgetModel(ctx.model);
    if (model === ctx.model || (model.contextWindow === ctx.model.contextWindow && model.maxTokens === ctx.model.maxTokens)) return;
    applying = true;
    const thinking = pi.getThinkingLevel();
    try {
      // Public Pi API, session-local copy. Do not edit registry, provider identity,
      // global defaults, credentials, rates, or selected thinking effort.
      if (await pi.setModel(model) === false) throw new Error('Cannot apply context working budget');
      pi.setThinkingLevel(thinking);
      record({ event: 'policy', context_window: model.contextWindow, max_output_tokens: model.maxTokens });
    } finally { applying = false; }
  };
  pi.on('session_start', apply);
  pi.on('model_select', apply);
  pi.on('before_agent_start', apply);
  pi.on('session_before_compact', (event, ctx) => {
    const p = event.preparation;
    const estimate = estimatePayload({ messages: p.messagesToSummarize,
      prefix: p.turnPrefixMessages, summary: p.previousSummary,
      instructions: event.customInstructions });
    record({ event: 'compaction_request', estimated_input_tokens: estimate,
      blocked: estimate >= POLICY.requestEstimateLimit });
    if (estimate >= POLICY.requestEstimateLimit) {
      const message = 'Context budget refused an oversized compaction request. Resume in a fresh session from canonical artifacts and a bounded handoff; preserve the original transcript.';
      ctx.ui?.notify(message, 'error');
      process.stderr.write(`${message}\n`);
      ctx.abort();
      return { cancel: true };
    }
  });
  pi.on('before_provider_request', (event, ctx) => {
    lastEstimate = estimatePayload(event.payload);
    record({ event: 'request', estimated_input_tokens: lastEstimate,
      limit: POLICY.requestEstimateLimit, blocked: lastEstimate >= POLICY.requestEstimateLimit });
    if (lastEstimate >= POLICY.requestEstimateLimit) {
      // Pi reports hook exceptions but continues sending: throwing alone is NOT
      // a guard. Abort the native request signal before the provider transport.
      ctx.abort();
      const message = `Context budget stopped an estimated ${lastEstimate}-token request before transport. Preserve work; compact or resume in a fresh session with a bounded handoff. Do not retry the same oversized request.`;
      ctx.ui?.notify(message, 'error');
      process.stderr.write(`${message}\n`);
    }
  });
  pi.on('message_end', (event) => {
    if (event.message?.role !== 'assistant') return;
    const usage = event.message.usage;
    record({ event: 'usage', provider: event.message.provider, model: event.message.model,
      input_tokens: inputTokens(usage), output_tokens: usage?.output ?? null,
      cache_read_tokens: usage?.cacheRead ?? null, reasoning_tokens: usage?.reasoning ?? null,
      estimated_input_tokens: lastEstimate, stop_reason: event.message.stopReason,
      usage_available: inputTokens(usage) > 0 });
  });
  pi.on('session_compact', event => record({ event: 'compaction',
    input_tokens: inputTokens(event.compactionEntry?.usage),
    output_tokens: event.compactionEntry?.usage?.output ?? null }));
  pi.on('tool_result', (event, ctx) => {
    const content = event.content;
    if (!Array.isArray(content) || content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0) <= POLICY.toolTextChars) return;
    const session = ctx.sessionManager.getSessionFile();
    if (!session) return; // No durable recovery path: preserve the original result.
    const dir = join(dirname(session), `${basename(session, '.jsonl')}-context-artifacts`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const artifact = join(dir, `${randomUUID()}.txt`);
    writeFileSync(artifact, content.filter(b => b.type === 'text').map(b => b.text).join('\n'), { mode: 0o600 });
    return { content: boundedToolContent(content, artifact) };
  });
}
