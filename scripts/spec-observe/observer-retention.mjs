// Single owner of the observer retention window and the prune routine for stale snapshots.
import { opendir, lstat, readFile, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
export const OBSERVER_RETENTION_MS = 60 * 60 * 1000;
const MAX_FILE = 4 * 1024 * 1024;
export function observerExpired(value, at = Date.now()) {
  const published = value?.published_at;
  if (typeof published !== 'string') return false;
  const time = Date.parse(published);
  return Number.isFinite(time) && at - time > OBSERVER_RETENTION_MS;
}
export async function pruneExpiredObservers(directory, { at = Date.now(), except = null } = {}) {
  const removed = [];
  const skip = except == null ? null : basename(except);
  let entries;
  try { entries = await opendir(directory); } catch { return removed; }
  try {
    for await (const entry of entries) {
      const name = entry.name;
      if (!name.endsWith('.json') || name === skip) continue;
      const path = join(directory, name);
      try {
        const info = await lstat(path);
        if (!info.isFile() || at - info.mtimeMs <= OBSERVER_RETENTION_MS || info.size > MAX_FILE) continue;
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        if (!observerExpired(parsed, at)) continue;
        await unlink(path);
        removed.push(name);
      } catch { continue; }
    }
  } catch { return removed; }
  return removed;
}
