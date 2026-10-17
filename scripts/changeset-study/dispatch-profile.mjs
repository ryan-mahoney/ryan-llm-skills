import { parseSelector } from '../changeset/models.mjs';

// Research knobs for the optimized profile. Defaults reproduce the historical
// optimized-v4a behavior exactly; every departure is explicit and recorded.
export { defaultDispatchOptions, resolveDispatchOptions, leanDispatchOptions } from '../changeset/dispatch-options.mjs';
import { resolveDispatchOptions, leanDispatchOptions } from '../changeset/dispatch-options.mjs';
const profiles = { 'optimized-v4a': {}, 'optimized-lean': leanDispatchOptions, 'optimized-lean-repair': { ...leanDispatchOptions, repair_rounds: 1 } };

// Explicit opt-in: historical configurations retain their original defaults.
export function resolveDispatchProfile({ dispatchProfile = null, dispatchOptions = null, strategy, selector, editorSelector,
  writerRecoverySelector = null, optimization = null, queryMode = null, queryGranularity = null } = {}) {
  if (dispatchProfile === null) {
    if (dispatchOptions !== null && dispatchOptions !== undefined) throw new Error('dispatchOptions require an optimized dispatch profile');
    return { dispatchProfile, optimization: optimization ?? 'none', queryMode: queryMode ?? 'discovery', queryGranularity, writerFormat: 'json', options: null };
  }
  if (!Object.hasOwn(profiles, dispatchProfile)) throw new Error('Unknown dispatch profile');
  const planner = parseSelector(selector ?? ''), writer = parseSelector(editorSelector ?? '');
  // focused-dispatch: one Sol discovery agent plans the writer packets directly, with
  // no separate owner brief or catalog query; the same preprocessing and writers apply.
  const single = strategy === 'focused-dispatch';
  // The planner is Sol 6.1, or, on the single-agent strategy only, native DeepSeek Flash so the
  // owner tier itself can be tested as the planner. The writer is always DeepSeek Flash :off.
  const plannerAllowed = (planner.provider === 'openai-codex' && planner.id === 'gpt-6.1-sol') || (single && planner.provider === 'deepseek' && planner.id === 'deepseek-flash');
  if (!['owner-query-writer', 'focused-dispatch'].includes(strategy) || !plannerAllowed ||
      writer.provider !== 'deepseek' || writer.id !== 'deepseek-flash' || writer.reasoning !== 'off' || writerRecoverySelector !== null)
    throw new Error('An optimized dispatch profile requires Sol 6.1 query planning (or DeepSeek Flash planning on focused-dispatch) and native DeepSeek Flash :off writing with same-selector fallback');
  if ((optimization !== null && optimization !== 'contextual') || (queryMode !== null && queryMode !== (single ? 'discovery' : 'catalog-lookup')) ||
      (queryGranularity !== null && queryGranularity !== (single ? 'default' : 'smaller-regions')))
    throw new Error(single ? 'An optimized focused-dispatch profile requires contextual optimization and discovery planning' : 'An optimized dispatch profile requires contextual optimization, catalog-lookup and smaller-regions');
  const options = resolveDispatchOptions({ ...profiles[dispatchProfile], ...(dispatchOptions ?? {}) });
  const writerFormat = options.writer_routing === 'v4a' ? 'v4a-fallback' : options.writer_routing === 'json' ? 'json-focused' : options.writer_routing;
  return { dispatchProfile, optimization: 'contextual', queryMode: single ? 'discovery' : 'catalog-lookup', queryGranularity: single ? null : 'smaller-regions', writerFormat, options };
}
