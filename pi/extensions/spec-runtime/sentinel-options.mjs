// Operator-facing startup options. Workflow identity is discovered at runtime.
import { discoveryRoot } from '../../../scripts/spec-observe/discovery.mjs';
export const SENTINEL_DEFAULT_MODEL = 'openrouter/inception/mercury-2.5:high';
export const SENTINEL_MODES = ['observe', 'shadow', 'recover'];

export function parseSentinelStart(args = '') {
  // Quoted paths/model selectors are accepted without evaluating shell syntax.
  const tokens = String(args).match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [];
  if (tokens.some(token => /["']/.test(token) && !/^(["']).*\1$/.test(token)))
    throw new Error('Use matching quotes around paths that contain spaces.');
  const words = tokens.map(token => /^(["']).*\1$/.test(token) ? token.slice(1, -1) : token);
  const mode = words[0] && !words[0].startsWith('--') ? words.shift() : 'observe';
  if (!SENTINEL_MODES.includes(mode)) throw new Error('Choose observe, shadow or recover.');
  const options = { mode, model: SENTINEL_DEFAULT_MODEL, root: null };
  const seen = new Set();
  while (words.length) {
    const flag = words.shift();
    if (!['--root', '--model'].includes(flag)) throw new Error(`Unknown sentinel option: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate sentinel option: ${flag}`);
    seen.add(flag);
    const value = words.shift();
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    options[flag.slice(2)] = value;
  }
  if (/\s|[\u0000-\u001f\u007f]/.test(options.model) || !/^[^/]+\/[^:]+(?::[^:]+)?$/.test(options.model))
    throw new Error('--model must be provider/model[:thinking].');
  if (options.root) options.root = discoveryRoot(options.root);
  return options;
}
