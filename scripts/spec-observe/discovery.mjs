// Bounded directory metadata discovery. No source, transcript or Git commands.
import { constants } from 'node:fs';
import { open, opendir, lstat, realpath, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DISCOVERY_LIMITS = Object.freeze({ depth: 8, directories: 2000, entries: 20000, milliseconds: 2000, cacheMs: 300000 });
const skipped = new Set(['node_modules', 'vendor', 'deps', '_build', 'build', 'dist', 'target', 'coverage', '__pycache__']);
export const discoveryConfigPath = agentDir => join(agentDir, 'spec-sentinel', 'discovery.json');
export function discoveryRoot(path, home = homedir()) {
  const expanded = path === '~' ? home : path?.startsWith('~/') ? join(home, path.slice(2)) : path;
  if (typeof expanded !== 'string' || !isAbsolute(expanded)) throw new Error('Discovery root must be an absolute path or start with ~/');
  return resolve(expanded);
}

async function configuredRoot(agentDir, home) {
  const file = discoveryConfigPath(agentDir);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8192) throw new Error('Expected a regular discovery config of at most 8 KiB');
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new Error('Discovery config exceeds 8 KiB');
    const config = JSON.parse(buffer.subarray(0, bytesRead).toString());
    if (config.version !== 1) throw new Error('Unknown discovery config version');
    return discoveryRoot(config.root, home);
  } catch (error) {
    if (error.code === 'ENOENT') return join(home, 'Documents');
    throw error;
  } finally { await handle?.close(); }
}

export async function saveDiscoveryRoot(agentDir, path, home = homedir()) {
  const root = discoveryRoot(path, home);
  if (!(await lstat(root)).isDirectory()) throw new Error('Discovery root must be a directory, not a symlink');
  const directory = join(agentDir, 'spec-sentinel');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = discoveryConfigPath(agentDir), temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, root }) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temp, file);
  return root;
}

export async function discoverRepositories(root, { limits = DISCOVERY_LIMITS, now = Date.now } = {}) {
  const roots = [], reasons = [];
  const started = now();
  let directories = 0, entries = 0;
  const note = reason => { if (reasons.length < 50 && !reasons.includes(reason)) reasons.push(reason); };
  const result = () => ({ root, roots, reasons, directories, entries, observed_at: new Date(started).toISOString() });
  try {
    if (!(await lstat(root)).isDirectory()) throw new Error('Not a directory or is a symlink');
    root = await realpath(root);
  } catch (error) { note(`discovery-unavailable: ${root} (${error.code || error.message})`); return result(); }
  const queue = [{ path: root, depth: 0 }];
  for (let index = 0; index < queue.length; index++) {
    if (directories >= limits.directories || entries >= limits.entries || now() - started >= limits.milliseconds) {
      note('discovery-cap: directory, entry or time limit reached'); break;
    }
    const current = queue[index];
    let handle;
    try {
      // Recheck queued directories: never follow a child symlink out of the root.
      if (!(await lstat(current.path)).isDirectory()) continue;
      const actual = await realpath(current.path), rel = relative(root, actual);
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) { note(`discovery-changed: ${current.path}`); continue; }
      handle = await opendir(current.path); directories++;
      let git = false, specs = false, entry;
      while ((entry = await handle.read())) {
        entries++;
        if (entries > limits.entries || now() - started >= limits.milliseconds) { note('discovery-cap: entry or time limit reached'); break; }
        if (entry.name === '.git' && (entry.isDirectory() || entry.isFile())) git = true;
        if (entry.name === '.specs' && entry.isDirectory()) specs = true;
        if (!entry.isDirectory() || entry.name.startsWith('.') || skipped.has(entry.name)) continue;
        if (current.depth >= limits.depth) { note(`discovery-depth-cap: ${current.path}`); continue; }
        if (queue.length >= limits.directories) { note('discovery-cap: directory limit reached'); continue; }
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
      }
      // Canonical package validation remains with the existing workspace reader;
      // linked-worktree copies never become accepted primary packages.
      if (git && specs) roots.push(current.path);
    } catch (error) { note(`discovery-unavailable: ${current.path} (${error.code || error.message})`); }
    finally { await handle?.close(); }
  }
  return result();
}

export function createRepositoryDiscovery({ agentDir, root: override, home = homedir(), now = Date.now,
  scan = discoverRepositories, cacheMs = DISCOVERY_LIMITS.cacheMs } = {}) {
  let cached;
  return { async read() {
    let root;
    try { root = override ? discoveryRoot(override, home) : await configuredRoot(agentDir, home); }
    catch (error) { return { root: null, roots: [], reasons: [`discovery-config-unavailable: ${discoveryConfigPath(agentDir)} (${error.code || error.message})`] }; }
    if (!cached || cached.root !== root || now() - cached.at >= cacheMs || now() < cached.at)
      cached = { root, at: now(), value: await scan(root) };
    return cached.value;
  } };
}
