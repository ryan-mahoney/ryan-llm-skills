import { setTimeout as sleep } from 'node:timers/promises';
import { configurationFailure, splitModelSelector } from './model-selector.mjs';

const ENTRY = 'spec-provider-recovery';
export const PROVIDER_RECOVERY = Object.freeze({ delays: [5000, 10000, 20000],
  fallback: { provider: 'deepseek', model: 'deepseek-flash' } });

export function transientProviderFailure(message) {
  if (message?.stopReason !== 'error' || typeof message.errorMessage !== 'string') return false;
  const error = message.errorMessage;
  if (configurationFailure(error) || /\b(?:401|402|403)\b|unauthori[sz]ed|forbidden|invalid.api.key|insufficient.(?:funds|credits|quota)|billing|payment.required|context.(?:window|length)|maximum.context|token.limit/i.test(error)) return false;
  return /no healthy deployments|overloaded|temporarily unavailable|service unavailable|rate.limit|too many requests|\b(?:429|500|502|503|504)\b|\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|upstream timeout|connection (?:reset|closed)|fetch failed/i.test(error);
}

export function emptyProviderResponse(message) {
  return message?.stopReason === 'stop' && Array.isArray(message.content)
    && message.content.every(block => block.type === 'thinking'
      || (block.type === 'text' && typeof block.text === 'string' && !block.text.trim()));
}
const recoverableResponse = message => transientProviderFailure(message) || emptyProviderResponse(message);

// Continue the failed request in the same native session. Never relaunch a step,
// replay a successful tool call, or turn a failed check into a provider retry.
// Native Pi gets first use of its retry policy. Its failed responses count toward
// this allowance, so recognized errors do not receive a second full retry budget.
export function installProviderRecovery(pi, { requestedModel, assertActive = () => {},
  onEvent = () => {}, nativeRetryable = () => false, retrySettings = () => ({ enabled: false }),
  wait = (ms, signal) => sleep(ms, undefined, { signal }) } = {}) {
  if (typeof requestedModel !== 'string') return; // Native launch validation owns malformed records.
  const requested = splitModelSelector(requestedModel);
  if (requested.provider !== 'primalabs') return;
  const fallback = PROVIDER_RECOVERY.fallback;
  let generation = 0, pendingWait, restoreFailed = false;
  const record = data => {
    const value = { version: 1, requested_model: requestedModel, ...data };
    pi.appendEntry(ENTRY, value);
    onEvent(value);
  };
  const notify = (ctx, message, level = 'info') => ctx.ui?.notify(message, level);
  async function selectFallback(ctx, restoring = false, failureKind) {
    assertActive();
    const model = ctx.modelRegistry.find(fallback.provider, fallback.model);
    if (!model) throw new Error('Fallback model is not registered');
    const thinking = pi.getThinkingLevel();
    if (await pi.setModel(model) === false) throw new Error('Fallback authentication unavailable');
    pi.setThinkingLevel(thinking);
    record({ event: restoring ? 'fallback_restored' : 'fallback_selected',
      effective_model: `${fallback.provider}/${fallback.model}`, failure_kind: failureKind });
    notify(ctx, `Provider unavailable after retries; continuing with ${fallback.provider}/${fallback.model}.`);
  }
  pi.on('session_start', async (_event, ctx) => {
    const retained = ctx.sessionManager.getBranch().some(entry => entry.type === 'custom'
      && entry.customType === ENTRY && entry.data?.requested_model === requestedModel
      && ['fallback_selected', 'fallback_restored'].includes(entry.data.event));
    if (!retained) return;
    try { await selectFallback(ctx, true); }
    catch {
      restoreFailed = true;
      record({ event: 'fallback_unavailable' });
      notify(ctx, 'Retained provider fallback is unavailable; repair its configuration before continuing.', 'error');
    }
  });
  pi.on('before_provider_request', (_event, ctx) => { if (restoreFailed) ctx.abort(); });
  pi.on('input', () => { generation++; pendingWait?.abort(); });
  pi.on('session_shutdown', () => { generation++; pendingWait?.abort(); });
  function priorFailures(ctx) {
    const failures = [];
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== 'message') continue;
      if (entry.message.role === 'user') break;
      if (entry.message.role !== 'assistant') continue;
      if (!recoverableResponse(entry.message)) break;
      failures.push(entry);
    }
    return failures;
  }
  // Wait while the native request still owns an abort signal. Pi's final settle
  // boundary has no active request signal, so sleeping there delays cancellation.
  pi.on('message_end', async (event, ctx) => {
    const message = event.message;
    if (message?.role !== 'assistant' || !recoverableResponse(message)
      || ctx.model?.provider !== requested.provider || ctx.model?.id !== requested.model
      || ctx.signal?.aborted || ctx.hasPendingMessages()) return;
    const attempt = priorFailures(ctx).length + 1;
    const native = retrySettings();
    if (native.enabled && nativeRetryable(message) && attempt <= native.maxRetries) return;
    if (attempt > PROVIDER_RECOVERY.delays.length) return;
    try { assertActive(); } catch { return; }
    const delay = PROVIDER_RECOVERY.delays[attempt - 1];
    record({ event: 'retry_scheduled', attempt, delay_ms: delay,
      failure_kind: emptyProviderResponse(message) ? 'empty_response' : 'provider_error',
      effective_model: `${requested.provider}/${requested.model}` });
    notify(ctx, `Provider temporarily unavailable; retry ${attempt}/3 in ${delay / 1000}s.`);
    pendingWait = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, pendingWait.signal]) : pendingWait.signal;
    try { await wait(delay, signal); } catch { /* Native abort remains authoritative. */ }
    finally { pendingWait = undefined; }
  });
  pi.on('agent_before_settle', async (event, ctx) => {
    if (restoreFailed || !['error', 'completed'].includes(event.outcome) || event.continue
      || event.context?.pendingMessages?.length || ctx.hasPendingMessages()
      || ctx.signal?.aborted || ctx.model?.provider !== requested.provider
      || ctx.model?.id !== requested.model) return;
    const failures = priorFailures(ctx);
    if (!failures.length) return;
    if (event.outcome === 'completed' && !emptyProviderResponse(failures[0].message)) return;
    const inputGeneration = generation;
    try { assertActive(); } catch { return; }
    if (failures.length > PROVIDER_RECOVERY.delays.length) {
      try { await selectFallback(ctx, false,
        emptyProviderResponse(failures[0].message) ? 'empty_response' : 'provider_error'); }
      catch {
        record({ event: 'fallback_unavailable' });
        notify(ctx, 'Provider retries exhausted and deepseek/deepseek-flash is unavailable. Preserved the session; repair fallback configuration.', 'error');
        return;
      }
    }
    if (ctx.signal?.aborted || generation !== inputGeneration || ctx.hasPendingMessages()) return;
    // Raw errors and empty responses remain durable. Omit only failed responses from the
    // next request; the preceding user/tool result is the native continuation.
    return { entries: [...event.entries, ...failures.map(entry => ({ type: 'context_edit',
      targetId: entry.id, replacement: null }))], continue: true };
  });
}
