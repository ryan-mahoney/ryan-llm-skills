// Split only the runtime provider and a recognized thinking suffix. Model IDs
// may themselves contain slashes or colons; those segments are never shortened.
export function splitModelSelector(selector) {
  if (typeof selector !== 'string' || !selector || /\s/.test(selector))
    throw new Error('Model selector must be exact provider/model[:thinking] without whitespace');
  const slash = selector.indexOf('/');
  if (slash <= 0 || slash === selector.length - 1)
    throw new Error('Model selector must include provider/model[:thinking]');
  const provider = selector.slice(0, slash);
  let model = selector.slice(slash + 1);
  const suffix = model.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
  const thinking = suffix?.[1];
  if (suffix) model = model.slice(0, -suffix[0].length);
  if (!model) throw new Error('Model selector requires a nonempty model ID');
  return { provider, model, thinking };
}

// Status codes alone are not evidence of a configuration error. Require an
// explicit model/provider/adapter diagnosis so ordinary HTTP/network failures retry.
export function configurationFailure(error) {
  const message = typeof error === 'string' ? error : error?.message;
  if (!message) return undefined;
  if (/SPEC_MODEL_SELECTOR_MISMATCH|(?:unknown|invalid|unrecognized) (?:model|provider)|(?:model|provider)(?:[^\n]{0,160})(?:not found|does not exist)|(?:not found|no model found)(?:[^\n]{0,100})model|(?:does not support|cannot be used with|not supported|unsupported)(?:[^\n]{0,180})(?:chat\/completions|adapter)|(?:chat\/completions|adapter)(?:[^\n]{0,180})(?:not supported|unsupported)/i.test(message))
    return { kind: 'model_configuration', cause: message };
  return undefined;
}

export function configurationAction(selector, cause) {
  return `Model configuration failed for exact selector ${selector}: ${cause}. Coordinator action required: supply an explicitly corrected provider/model[:thinking] selector or start a new assignment contract. Identical editor retries are blocked for this run; preserve existing work, evidence, sessions and writer lease. Do not probe model inventory or silently substitute a model.`;
}

export function assertModelSelector(selector, selected) {
  const expected = splitModelSelector(selector);
  if (selected?.provider !== expected.provider || selected?.id !== expected.model)
    throw new Error(`SPEC_MODEL_SELECTOR_MISMATCH: requested ${selector}; selected ${selected?.provider || 'unknown'}/${selected?.id || 'unknown'}. Exact provider and model ID are required; silent fallback is prohibited.`);
}
