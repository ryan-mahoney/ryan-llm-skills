// Package access is authorized by a published canonical snapshot, never a URL path.
import { constants } from 'node:fs';
import { lstat, realpath, opendir, open } from 'node:fs/promises';
import { dirname, basename, join, resolve, sep, extname } from 'node:path';
export const PACKAGE_FILE_LIMITS = { entries: 500, totalEntries: 10000, depth: 12, bytes: 8 * 1024 * 1024 };
export async function authorizePackage(state, requested) {
  if (typeof requested !== 'string' || !state.observers.some(o => [...(o.snapshot?.runs ?? []), ...(o.snapshot?.recently_completed ?? [])].some(r => r.package === requested))) throw Error('Package is not published');
  const root = await realpath(requested);
  if (root !== requested || basename(dirname(root)) !== '.specs' || !(await lstat(root)).isDirectory()
    || !(await lstat(join(dirname(dirname(root)), '.git'))).isDirectory()) throw Error('Package is not canonical');
  // .specs itself may not redirect into another checkout.
  if (await realpath(dirname(root)) !== dirname(root)) throw Error('Package is not canonical');
  return root;
}
async function safePath(root, name, { exclude } = {}) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0')) throw Error('Invalid file path');
  const parts = name.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) throw Error('Invalid file path');
  let path = root;
  for (const part of parts) {
    if (typeof exclude === 'function' && exclude(part)) throw Error('File is unavailable');
    path = join(path, part);
    if ((await lstat(path)).isSymbolicLink()) throw Error('Symbolic links are unavailable');
  }
  const real = await realpath(path);
  if (!real.startsWith(root + sep)) throw Error('File is outside the package');
  return real;
}
export async function listPackageFiles(root, cursor = 0, { exclude } = {}) {
  if(!Number.isSafeInteger(cursor)||cursor<0||cursor>=PACKAGE_FILE_LIMITS.totalEntries)throw Error('Invalid listing cursor');
  const files = [], errors = []; let scanned = 0, truncated = false, pageLimit = Math.min(cursor+PACKAGE_FILE_LIMITS.entries,PACKAGE_FILE_LIMITS.totalEntries);
  let depthTruncated=false;
  async function walk(path, prefix, depth) {
    if (depth > PACKAGE_FILE_LIMITS.depth) { depthTruncated = true; return; }
    let handle;
    try {
      handle = await opendir(path);
      for await (const entry of handle) {
        if (typeof exclude === 'function' && exclude(entry.name)) continue;
        if (++scanned > pageLimit) { truncated = true; break; }
        const name = prefix + entry.name;
        if (scanned <= cursor) { if (entry.isDirectory()) await walk(await safePath(root, name, { exclude }), name + '/', depth + 1); if (truncated) break; continue; }
        if (entry.isSymbolicLink()) files.push({ name, available: false, reason: 'Symbolic link' });
        else if (entry.isDirectory()) await walk(await safePath(root, name, { exclude }), name + '/', depth + 1);
        else if (entry.isFile()) { const info = await lstat(await safePath(root, name, { exclude })); files.push({ name, size: info.size, available: info.size <= PACKAGE_FILE_LIMITS.bytes, reason: info.size > PACKAGE_FILE_LIMITS.bytes ? 'Exceeds 8 MiB limit' : null }); }
        else files.push({ name, available: false, reason: 'Not a regular file' });
        if (truncated) break;
      }
    } catch (error) { errors.push({ name: prefix, message: error.code ?? error.message }); }
  }
  await walk(root, '', 0);
  return { files: files.sort((a,b) => a.name.localeCompare(b.name)), truncated:truncated||depthTruncated, next_cursor:truncated&&pageLimit<PACKAGE_FILE_LIMITS.totalEntries?pageLimit:null, errors, limits: PACKAGE_FILE_LIMITS };
}
export async function readPackageFile(root, name, { exclude } = {}) {
  const path = await safePath(root, name, { exclude });
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > PACKAGE_FILE_LIMITS.bytes) throw Error('File is not a bounded regular file');
    const buffer = Buffer.alloc(PACKAGE_FILE_LIMITS.bytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > PACKAGE_FILE_LIMITS.bytes || await realpath(path) !== path) throw Error('File changed or exceeds limit');
    const bytes = buffer.subarray(0, bytesRead), extension = extname(name).toLowerCase();
    const images = { '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.avif':'image/avif', '.ico':'image/x-icon' };
    const text = ['.md','.markdown','.json','.yaml','.yml','.txt','.log','.csv','.ts','.js','.mjs','.css','.toml','.xml','.svg','.sh','.html','.htm'].includes(extension) || !extension;
    let readable=text;
    if(!readable&&!bytes.includes(0)){try{const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);readable=!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded);}catch{}}
    const binary = bytes.includes(0) || !readable;
    return { bytes, type: images[extension] ?? (binary ? 'application/octet-stream' : extension === '.html' || extension === '.htm' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8'), kind: images[extension] ? 'image' : binary ? 'download' : ['.html','.htm'].includes(extension) ? 'html' : ['.md','.markdown'].includes(extension) ? 'markdown' : extension === '.json' ? 'json' : 'text' };
  } finally { await handle.close(); }
}
