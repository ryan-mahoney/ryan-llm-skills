import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

// Working limits, not provider capabilities or prices. Each spec-runtime role starts at
// its own window: owners hold a step's state across rounds, while editors start a fresh
// session per packet. Sol compacts remotely and keeps up to 64k tokens of recent user
// messages, so an 88k window left a Sol owner about 9k of room after each compaction and
// it compacted every minute without editing on 2026-10-17. The operator raised the
// windows that day: protect against very large contexts, not ordinary step state.
export const POLICY = Object.freeze({
  windows: Object.freeze({ owner: 200000, reviewer: 160000, fixer: 120000, editor: 88000, default: 120000 }),
  // A compaction that returns with less working room than this grows the session's
  // window. The ceiling stays below Sol's 272k long-context price tier.
  minWorkingRoom: 32000, maxWindow: 240000,
  // Native compaction starts at the window minus Pi's reserve. The request guard sits
  // just above the window, so it stops only a request that compaction could not prevent.
  reserveTokens: 16384, requestMargin: 2000, toolTextChars: 12000 });
const installed = new WeakSet();
// Native update summaries otherwise accumulate completed history on every pass.
// Keep obligations intact, but make their durable artifacts carry the detail.
const SUMMARY_FOCUS = `Write a compact working handoff, aiming for at most 8000 characters.
Preserve the user's goal and authority limits, active constraints, unresolved decisions,
known failures, pending implementation/review/evidence obligations, current revisions,
and the next action. Preserve artifact paths needed to recover supporting detail.
Replace completed investigation and execution narratives with their outcome and artifact
reference. Consolidate repeated facts and remove superseded plans. Do not copy the
previous summary wholesale or preserve obsolete detail merely because it was summarized
before. Never drop an unresolved obligation to meet the length target. The retained
transcript and canonical artifacts remain available for targeted retrieval.
For completed work, the default preserve-all wording means preserve its outcome and
recovery pointer, not every prior detail. Use only a few lines for completed steps;
omit tool-call inventories, resolved errors, repeated paths and receipt-by-receipt
history. Do not copy credentials or launch/lease tokens; reference their owning record.`;

export function roleWindow(role) {
  return Object.hasOwn(POLICY.windows, role ?? '') ? POLICY.windows[role] : POLICY.windows.default;
}

export function budgetModel(model, window = POLICY.windows.default) {
  if (!model || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return model;
  // Output and thinking budgets have different semantics across providers. This
  // policy controls retained input; preserve the selected model's output limit.
  return { ...model, contextWindow: Math.min(model.contextWindow, window) };
}

// The window after a compaction that left `retained` tokens: unchanged when the
// remaining room before the next compaction is enough, otherwise large enough to
// restore it, up to the ceiling.
export function grownWindow(window, retained, reserve = POLICY.reserveTokens) {
  if (window - reserve - retained >= POLICY.minWorkingRoom) return window;
  return Math.min(POLICY.maxWindow, Math.max(window, retained + POLICY.minWorkingRoom + reserve));
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

// Summary prompt text, not a provider payload; 2k covers Pi's summarization prompt.
export function estimateText(...parts) {
  return Math.ceil(parts.reduce((n, part) => n + Buffer.byteLength(part || '', 'utf8'), 0) / 3) + 2048;
}

export function inputTokens(usage) {
  return ['input', 'cacheRead', 'cacheWrite'].reduce((sum, key) =>
    sum + (Number.isFinite(usage?.[key]) ? usage[key] : 0), 0);
}

export function reasoningOnly(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return !content.some(b => b.type === 'toolCall' || (b.type === 'text' && b.text?.trim()));
}

export function boundedToolContent(content, artifact) {
  const length = content.reduce((n, block) => n + (block.type === 'text' ? block.text.length : 0), 0);
  if (length <= POLICY.toolTextChars) return content;
  // Preserve non-text blocks and error tails. The full result remains recoverable.
  const all = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  return [{ type: 'text', text: `${all.slice(0, 8000)}\n\n[Output abbreviated. Full result: ${artifact}. Read only the missing range; do not rerun the command or infer omitted code.]\n\n${all.slice(-2000)}` },
    ...content.filter(block => block.type !== 'text')];
}

export function installContextBudget(pi, { compact, serialize, retrySettings, role = process.env.SPEC_RUNTIME_ROLE } = {}) {
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
  // The configured window can grow after a compaction; `effective` is that window
  // capped by the selected model's own limit, which the guard and growth measure against.
  let window = roleWindow(role), effective = window, measureRetained = false, exhausted = false;
  const requestLimit = () => effective + POLICY.requestMargin;
  const reserve = () => pi.getSettings?.()?.compaction?.reserveTokens ?? POLICY.reserveTokens;
  // Native compaction triggers on provider-reported input; the guard sees only the
  // byte estimate, which ran 1.3x (DeepSeek) to 1.6x (Codex) high. Uncalibrated, the
  // guard fired at ~57k real input, before compaction could start at ~59.6k. Scale by
  // the latest observed ratio; the raw estimate applies until usage is reported.
  let calibration = 1;
  const projected = estimate => Math.ceil(estimate * calibration);
  const record = data => pi.appendEntry('context-budget', { version: 1, ...data });
  const apply = async (_event, ctx) => {
    if (applying || !ctx.model) return;
    // After the first apply the session holds the capped copy; growth needs the registry limit.
    const native = ctx.modelRegistry?.find?.(ctx.model.provider, ctx.model.id)?.contextWindow;
    const model = budgetModel(Number.isFinite(native) && native > 0 ? { ...ctx.model, contextWindow: native } : ctx.model, window);
    if (Number.isFinite(model?.contextWindow) && model.contextWindow > 0) effective = model.contextWindow;
    if (model === ctx.model || (model.contextWindow === ctx.model.contextWindow && model.maxTokens === ctx.model.maxTokens)) return;
    applying = true;
    const thinking = pi.getThinkingLevel();
    try {
      // Public Pi API, session-local copy. Do not edit registry, provider identity,
      // global defaults, credentials, rates, or selected thinking effort.
      if (await pi.setModel(model) === false) throw new Error('Cannot apply context working budget');
      pi.setThinkingLevel(thinking);
      record({ event: 'policy', role: role ?? null, context_window: model.contextWindow, max_output_tokens: model.maxTokens });
    } finally { applying = false; }
  };
  pi.on('session_start', apply);
  // A resumed session starts a new process at calibration 1, so its first request was
  // judged on the raw estimate: a retained Sol owner at about 65k real input was refused
  // at 121k on 2026-10-16. Seed the ratio from the session's last recorded usage.
  pi.on('session_start', (_event, ctx) => {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const data = entries[i]?.customType === 'context-budget' ? entries[i].data : undefined;
      if (data?.event === 'usage' && data.input_tokens > 0 && data.estimated_input_tokens > 0) {
        calibration = Math.min(2, Math.max(0.5, data.input_tokens / data.estimated_input_tokens));
        return;
      }
    }
  });
  pi.on('model_select', apply);
  pi.on('before_agent_start', apply);
  pi.on('session_before_compact', async (event, ctx) => {
    const p = event.preparation;
    // Size the requests a summarizer actually sends. Native Pi sends serialized text
    // (thinking omitted, tool results truncated) and the split-turn prefix separately;
    // Codex compacts the cached provider history, whose size is p.tokensBefore, and never
    // sends the native summary. Raw message JSON counted encrypted reasoning and tool
    // details: a Sol owner at 73k real context was refused at a 208k estimate, and a
    // serialized-text estimate (170k) refused another at 72k, both on 2026-10-16.
    const inPlace = ctx.model?.provider === 'openai-codex';
    const estimate = serialize
      ? Math.max(estimateText(serialize(p.messagesToSummarize ?? []), p.previousSummary, event.customInstructions),
          estimateText(serialize(p.turnPrefixMessages ?? [])))
      : estimatePayload({ messages: p.messagesToSummarize, prefix: p.turnPrefixMessages,
          summary: p.previousSummary, instructions: event.customInstructions });
    const context = Number.isFinite(p.tokensBefore) ? p.tokensBefore : 0;
    const expected = !serialize ? projected(estimate) : inPlace ? context : Math.max(estimate, context);
    const blocked = expected >= requestLimit();
    record({ event: 'compaction_request', estimated_input_tokens: estimate,
      context_tokens: p.tokensBefore ?? null, projected_input_tokens: expected, blocked });
    if (exhausted) {
      // Growth reached its ceiling and compaction still returns nearly full: another
      // compaction would repeat the same loop without room to work.
      record({ event: 'compaction_loop', context_window: effective, blocked: true });
      const message = `Context budget stopped repeated compaction: compactions return with less than ${POLICY.minWorkingRoom} tokens of working room at the ${effective}-token window. Resume in a fresh session from canonical artifacts and a bounded handoff; preserve the original transcript.`;
      ctx.ui?.notify(message, 'error');
      process.stderr.write(`${message}\n`);
      ctx.abort();
      return { cancel: true };
    }
    if (blocked) {
      const message = 'Context budget refused an oversized compaction request. Resume in a fresh session from canonical artifacts and a bounded handoff; preserve the original transcript.';
      ctx.ui?.notify(message, 'error');
      process.stderr.write(`${message}\n`);
      ctx.abort();
      return { cancel: true };
    }
    // Scope this intervention to the provider observed accumulating summaries until
    // they exhaust the native output budget. Keep its model and reasoning selection.
    if (!compact || ctx.model?.provider !== 'deepseek') return;
    const guard = new AbortController();
    const signal = AbortSignal.any([event.signal, guard.signal]);
    const streamSummary = async (model, context, options) => {
      const stream = ctx.modelRegistry.streamSimple(model,
        { ...context, systemPrompt: `${context.systemPrompt || ''}\n\n${SUMMARY_FOCUS}` },
        { ...options, signal, onPayload: payload => {
          const estimate = estimatePayload(payload);
          record({ event: 'summary_request', provider: model.provider, model: model.id,
            estimated_input_tokens: estimate, projected_input_tokens: projected(estimate),
            blocked: projected(estimate) >= requestLimit() });
          if (projected(estimate) >= requestLimit()) guard.abort();
        } });
      const response = await stream.result();
      record({ event: 'summary_usage', provider: response.provider, model: response.model,
        input_tokens: inputTokens(response.usage), output_tokens: response.usage?.output ?? null,
        reasoning_tokens: response.usage?.reasoning ?? null, stop_reason: response.stopReason,
        usage_available: inputTokens(response.usage) > 0 });
      return stream;
    };
    try {
      // Summaries share Pi's 8k/13k output cap with reasoning. At max effort DeepSeek
      // spent 6-13k reasoning tokens per summary and hit the cap with no text, which
      // aborted the editor. The summary is a fresh single-prompt request, so disabling
      // thinking here leaves the session's selected level and reasoning replay intact.
      const result = await compact(p, ctx.model, undefined, undefined,
        [SUMMARY_FOCUS, event.customInstructions].filter(Boolean).join('\n\n'),
        signal, 'off', streamSummary,
        undefined, retrySettings?.());
      signal.throwIfAborted();
      return { compaction: result };
    } catch (error) {
      // Pi swallows hook exceptions and would then retry the unmodified native
      // summary. Explicit cancellation preserves the history and stops that loop.
      record({ event: 'summary_failed', reason: signal.aborted ? 'aborted' :
        /token cap|incomplete/.test(error?.message || '') ? 'length' : 'error' });
      ctx.ui?.notify('Context summary failed; original history is preserved. Inspect context-budget summary telemetry before recovery.', 'error');
      ctx.abort();
      return { cancel: true };
    }
  });
  pi.on('before_provider_request', (event, ctx) => {
    lastEstimate = estimatePayload(event.payload);
    const expected = projected(lastEstimate);
    const blocked = expected >= requestLimit();
    record({ event: 'request', estimated_input_tokens: lastEstimate, projected_input_tokens: expected,
      calibration: Number(calibration.toFixed(3)), limit: requestLimit(), blocked });
    if (blocked) {
      // Pi reports hook exceptions but continues sending: throwing alone is NOT
      // a guard. Abort the native request signal before the provider transport.
      ctx.abort();
      const message = `Context budget stopped a request projected at ${expected} input tokens before transport. Preserve work; compact or resume in a fresh session with a bounded handoff. Do not retry the same oversized request.`;
      ctx.ui?.notify(message, 'error');
      process.stderr.write(`${message}\n`);
    }
  });
  // A response holding only reasoning ends the agent loop with no answer or tool call.
  // MiMo produced these (stop with zero output, or length inside reasoning) and three
  // spec workers exited without results on 2026-10-15. Ask for the next action, twice
  // at most in a row; any response with text or a tool call resets the allowance.
  // Track the final response at message_end: Pi drops a `length` response from the
  // settle context, so the context alone cannot show that the run ended empty.
  let emptyStreak = 0, lastAssistant;
  pi.on('agent_before_settle', event => {
    if (event.continue || event.outcome !== 'completed' || event.context?.pendingMessages?.length) return;
    const last = lastAssistant;
    lastAssistant = undefined;
    if (!last || !['stop', 'length'].includes(last.stopReason) || !reasoningOnly(last)) return;
    if (emptyStreak >= 2) return;
    emptyStreak++;
    record({ event: 'empty_response_continue', stop_reason: last.stopReason, attempt: emptyStreak });
    return { entries: [...(event.entries ?? []), { type: 'custom_message', customType: 'context-budget', display: true,
      content: 'Your previous response contained only reasoning, with no answer or tool call, so the run would end without a result. Continue the assigned task: make the next tool call, or give the final answer if the task is complete.' }],
      continue: true };
  });
  pi.on('message_end', async (event, ctx) => {
    if (event.message?.role !== 'assistant') return;
    lastAssistant = event.message;
    if (!reasoningOnly(event.message)) emptyStreak = 0;
    const usage = event.message.usage;
    if (inputTokens(usage) > 0 && lastEstimate > 0)
      calibration = Math.min(2, Math.max(0.5, inputTokens(usage) / lastEstimate));
    record({ event: 'usage', provider: event.message.provider, model: event.message.model,
      input_tokens: inputTokens(usage), output_tokens: usage?.output ?? null,
      cache_read_tokens: usage?.cacheRead ?? null, reasoning_tokens: usage?.reasoning ?? null,
      estimated_input_tokens: lastEstimate, stop_reason: event.message.stopReason,
      usage_available: inputTokens(usage) > 0 });
    // The first reported input after a compaction is what the compaction retained.
    if (!measureRetained || inputTokens(usage) <= 0) return;
    measureRetained = false;
    const retained = inputTokens(usage), room = effective - reserve() - retained;
    const next = grownWindow(Math.max(window, effective), retained, reserve());
    record({ event: 'compaction_retained', input_tokens: retained, context_window: effective, working_room: room });
    if (room >= POLICY.minWorkingRoom) { exhausted = false; return; }
    const before = effective;
    if (next > before) {
      window = next;
      await apply(event, ctx);
      if (effective > before) record({ event: 'window_grown', from: before, context_window: effective });
    }
    exhausted = effective - reserve() - retained < POLICY.minWorkingRoom;
  });
  pi.on('session_compact', event => { measureRetained = true; record({ event: 'compaction',
    input_tokens: inputTokens(event.compactionEntry?.usage),
    output_tokens: event.compactionEntry?.usage?.output ?? null }); });
  pi.on('session_compact_failed', event => record({ event: 'compaction_failed',
    trigger: event.reason, aborted: event.aborted, from_extension: event.fromExtension,
    reason: /token cap|incomplete/.test(event.errorMessage || '') ? 'length' : 'error' }));
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
