// Native wave policy calculation. Wave launches reserve capacity and set service
// unit limits from the same advanced values a saved host policy recorded, so the
// resolved policy comes from the shared saved-options resolver rather than the
// bare calculator defaults. An invalid host configuration or saved policy is an
// error here: a launch never silently falls back to defaults.
import { calculateResourcePolicy, resolveRuntimeHostPolicyOptions } from './linux-resources.mjs';

export function calculateWaveResourcePolicy(options = {}) {
  const resolved = resolveRuntimeHostPolicyOptions(options);
  if (!resolved.ok) {
    const error = new Error(resolved.detail
      ? `Saved host policy is not usable (${resolved.reason}): ${resolved.detail}`
      : `Saved host policy is not usable (${resolved.reason})`);
    error.code = resolved.reason;
    throw error;
  }
  return calculateResourcePolicy(resolved.options);
}
