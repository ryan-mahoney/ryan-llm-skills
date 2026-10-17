import { createHash } from 'node:crypto';
const digest = text => createHash('sha256').update(text).digest('hex');
const target = "plan = parseJson(await stage(feedback ? 'repair-planning' : 'discovery-planning', () => scout.prompt(JSON.stringify(planningInput))));";
const replacement = "plan = await stage(feedback ? 'repair-planning' : 'discovery-planning', () => retryPlanningJson(scout, planningInput, { parseJson }));";
const imported = "import { retryPlanningJson } from './divergent/deepseek-direct/format-retry.mjs';\n";
export function overlayCell(source) {
  if (typeof source !== 'string' || source.split(target).length !== 2 || source.includes(imported.trim()))
    throw new Error('DeepSeek overlay requires the exact single current discovery-planning call; backend drift requires review');
  const overlaid = imported + source.replace(target, replacement);
  return { source: overlaid, metadata: { schema_version: 1, adapter: 'deepseek-direct-json-format-retry-v1',
    original_hash: digest(source), overlaid_hash: digest(overlaid),
    exact_target: target, exact_replacement: replacement, prepended_import: imported } };
}
