import { parseSelector } from '../changeset/models.mjs';

// Research knobs for the optimized profile. Defaults reproduce the historical
// optimized-v4a behavior exactly; every departure is explicit and recorded.
export const defaultDispatchOptions = Object.freeze({
  advice: 'jev',              // 'jev' | 'none': one batched Jev routing request, or deterministic policy only
  writer_routing: 'v4a',      // 'v4a' | 'json' | 'hybrid' | 'hybrid-wide': packet representation choice
  prune_dependencies: false,  // drop declared depends_on edges with no file overlap; compile keeps data dependencies
  prompt_order: 'target-first', // 'target-first' | 'static-first': shared contract before the per-packet ownership sentence
  concurrency: 4,             // executor concurrency, 1..32
  anti_dependencies: 'serialize', // 'serialize' | 'snapshot': let a writer start once the reader of its file has started
  seed_moves: false,          // pre-fill an absent destination with its declared source excerpts so the writer patches seams only
  seam_retry_reasoning: 'off', // 'off' | 'low': reasoning tier of the same DeepSeek model for the second seam attempt on a seeded move
  repair_rounds: 0,           // 0 | 1: after a failed visible check, the planner (not the writers) sees the diff and check output once and re-plans
});
const optionValues = { advice: ['jev', 'none'], writer_routing: ['v4a', 'json', 'hybrid', 'hybrid-wide'], prune_dependencies: [false, true],
  prompt_order: ['target-first', 'static-first'], anti_dependencies: ['serialize', 'snapshot'], seed_moves: [false, true], seam_retry_reasoning: ['off', 'low'], repair_rounds: [0, 1] };
export function resolveDispatchOptions(options = null) {
  if (options === null || options === undefined) return { ...defaultDispatchOptions };
  if (typeof options !== 'object' || Array.isArray(options)) throw new Error('dispatchOptions must be an object');
  const resolved = { ...defaultDispatchOptions };
  for (const [key, value] of Object.entries(options)) {
    if (!Object.hasOwn(defaultDispatchOptions, key)) throw new Error(`Unknown dispatch option: ${key}`);
    if (key === 'concurrency') { if (!Number.isInteger(value) || value < 1 || value > 32) throw new Error('concurrency must be 1..32'); }
    else if (!optionValues[key].includes(value)) throw new Error(`Invalid dispatch option ${key}: ${JSON.stringify(value)}`);
    resolved[key] = value;
  }
  return resolved;
}

// The replay rounds' recommended route (stacked-optimization results): no advice call,
// sequencing-only edges pruned, per-packet representation, cacheable prompt prefix,
// seeded moves. Explicit dispatchOptions still override individual fields.
export const leanDispatchOptions = Object.freeze({ advice: 'none', writer_routing: 'hybrid', prune_dependencies: true, prompt_order: 'static-first',
  concurrency: 8, anti_dependencies: 'serialize', seed_moves: true, seam_retry_reasoning: 'low', repair_rounds: 0 });
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
