import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, readlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
export const model = 'openai-codex/gpt-6.1-sol:low';
export const comparison = 'matched-sol-writer-boundary-control-v1';
export const taskIds = ['hard-context-calibration', 'hard-dependency-handoff', 'hard-lifecycle-extract'];
export const hash = value => createHash('sha256').update(value).digest('hex');
export const read = path => JSON.parse(readFileSync(path, 'utf8'));
export const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
export const same = (a, b) => {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
};
export const inside = (base, path) => { const rel = relative(base, path); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../')); };
export function prospective(path) {
  let ancestor = resolve(path); const suffix = [];
  while (!existsSync(ancestor)) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  return join(realpathSync(ancestor), ...suffix);
}
export function inventory(root) {
  const result = [], canonical = realpathSync(root);
  function scan(directory, prefix = '') {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + item.name, absolute = join(directory, item.name);
      if (item.isDirectory()) scan(absolute, path + '/');
      else if (item.isFile()) result.push([path, hash(readFileSync(absolute))]);
      else if (item.isSymbolicLink() && inside(canonical, realpathSync(absolute))) result.push([path, { symlink: readlinkSync(absolute) }]);
      else throw new Error('Unsupported or escaping snapshot entry: ' + path);
    }
  }
  scan(root); return result;
}
export function validateLedger(path) {
  let canonical, state;
  try { canonical = realpathSync(path); state = read(canonical); } catch { throw new Error('Existing shared budget ledger required'); }
  if (state?.schema_version !== 1 || state.limit_usd !== 50 || !Array.isArray(state.entries)) throw new Error('Shared ledger requires schema1 and limit50');
  const ids = new Set();
  for (const entry of state.entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || typeof entry.selector !== 'string' || !entry.selector.includes('/') ||
        !Number.isFinite(entry.reserved_usd) || entry.reserved_usd <= 0 || !['reserved', 'priced', 'unknown'].includes(entry.status) ||
        !(entry.charged_usd == null || Number.isFinite(entry.charged_usd) && entry.charged_usd >= 0) ||
        entry.status === 'priced' && !(Number.isFinite(entry.charged_usd) && entry.charged_usd >= 0)) throw new Error('Invalid shared ledger entry');
    ids.add(entry.id);
  }
  return { path: canonical, state };
}
export function rows(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(line => line.trim()).map(JSON.parse) : [];
}
export function packet(request) {
  try {
    const content = request.context.messages.filter(message => message.role === 'user').at(-1).content;
    return JSON.parse(content);
  } catch { return null; }
}
export function safePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('Unsafe relative path');
  return path;
}
