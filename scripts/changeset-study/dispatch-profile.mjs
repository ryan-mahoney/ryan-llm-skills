import { parseSelector } from '../changeset/models.mjs';

// Explicit opt-in: historical configurations retain their original defaults.
export function resolveDispatchProfile({ dispatchProfile = null, strategy, selector, editorSelector,
  writerRecoverySelector = null, optimization = null, queryMode = null, queryGranularity = null } = {}) {
  if (dispatchProfile === null) return { dispatchProfile, optimization: optimization ?? 'none',
    queryMode: queryMode ?? 'discovery', queryGranularity, writerFormat: 'json' };
  if (dispatchProfile !== 'optimized-v4a') throw new Error('Unknown dispatch profile');
  const planner = parseSelector(selector ?? ''), writer = parseSelector(editorSelector ?? '');
  if (strategy !== 'owner-query-writer' || planner.provider !== 'openai-codex' || planner.id !== 'gpt-6.1-sol' ||
      writer.provider !== 'deepseek' || writer.id !== 'deepseek-flash' || writer.reasoning !== 'off' || writerRecoverySelector !== null)
    throw new Error('optimized-v4a requires Sol 6.1 query planning and native DeepSeek Flash :off writing with same-selector fallback');
  if ((optimization !== null && optimization !== 'contextual') || (queryMode !== null && queryMode !== 'catalog-lookup') ||
      (queryGranularity !== null && queryGranularity !== 'smaller-regions'))
    throw new Error('optimized-v4a requires contextual optimization, catalog-lookup and smaller-regions');
  return { dispatchProfile, optimization: 'contextual', queryMode: 'catalog-lookup',
    queryGranularity: 'smaller-regions', writerFormat: 'v4a-fallback' };
}
