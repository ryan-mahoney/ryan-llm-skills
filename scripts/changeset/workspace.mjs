import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, chmodSync, existsSync, realpathSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const fileMode = (modes, path) => Object.hasOwn(modes, path) ? modes[path] : 0o644;

export const hash = text => text === null ? null : createHash('sha256').update(text).digest('hex');
export function safePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || p === '.git')) throw new Error(`Invalid workspace path: ${path}`);
  return path;
}
function diskPath(root, path) {
  safePath(path);
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink refused: ${path}`); }
    catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e; }
  }
  return current;
}
const readDisk = path => { try { return readFileSync(path, 'utf8'); } catch (e) { if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(e.code)) return null; throw e; } };

export class Workspace {
  constructor(files = {}, root = null, modes = {}) {
    this.base = new Map(Object.entries(files).map(([p, text]) => {
      safePath(p); if (typeof text !== 'string') throw new Error('Workspace requires text files'); return [p, text];
    }));
    this.files = new Map(this.base);
    this.root = root;
    this.modes = { ...modes };
    this.baseModes = { ...modes };
  }
  static load(root, { maxBytes = 8 * 1024 * 1024, maxFiles = 2000 } = {}) {
    root = realpathSync(root);
    const files = Object.create(null), modes = Object.create(null); let bytes = 0;
    function walk(dir, prefix = '') {
      for (const name of readdirSync(dir).sort()) {
        if (['.git', 'node_modules'].includes(name)) continue;
        const path = prefix + name, full = join(dir, name), info = lstatSync(full);
        if (info.isSymbolicLink()) throw new Error(`Symlink refused: ${path}`);
        if (info.isDirectory()) walk(full, path + '/');
        else if (info.isFile()) {
          bytes += info.size;
          if (bytes > maxBytes || Object.keys(files).length >= maxFiles) throw new Error('Workspace snapshot limit exceeded');
          const buffer = readFileSync(full);
          if (buffer.includes(0)) throw new Error(`Binary file refused: ${path}`);
          const text = buffer.toString('utf8');
          if (!Buffer.from(text).equals(buffer)) throw new Error(`Non-UTF8 file refused: ${path}`);
          files[path] = text; modes[path] = info.mode & 0o777;
        } else throw new Error(`Non-regular file refused: ${path}`);
      }
    }
    walk(root); return new Workspace(files, root, modes);
  }
  read(path) { return this.files.get(safePath(path)) ?? null; }
  snapshot(paths = [...this.files.keys()]) { return Object.fromEntries(paths.map(p => [p, this.read(p)])); }
  apply(files) {
    const next = new Map(this.files);
    for (const [path, text] of Object.entries(files)) {
      safePath(path);
      if (text === null) next.delete(path);
      else if (typeof text === 'string') next.set(path, text);
      else throw new Error('Writes must be text or null');
    }
    for (const name of next.keys()) {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i++) if (next.has(parts.slice(0, i).join('/'))) throw new Error('File/directory collision');
    }
    this.files = next;
  }
  changes() {
    return [...new Set([...this.base.keys(), ...this.files.keys()])].sort().filter(p => (this.base.get(p) ?? null) !== this.read(p)).map(path => ({ path, before: this.base.get(path) ?? null, after: this.read(path) }));
  }
  publish({ beforeWrite } = {}) {
    if (!this.root) throw new Error('No disk workspace');
    const changes = this.changes();
    // Revalidate all snapshot inputs, not just outputs: a changed read can invalidate a plan.
    for (const path of new Set([...this.base.keys(), ...changes.map(c => c.path)])) {
      if (hash(readDisk(diskPath(this.root, path))) !== hash(this.base.get(path) ?? null)) throw new Error(`Stale workspace: ${path}`);
    }
    const undo = [], temps = [];
    const parents = dir => {
      if (existsSync(dir)) return;
      parents(dirname(dir)); mkdirSync(dir); undo.push(() => rmdirSync(dir));
    };
    const removeEmptyDirectories = dir => {
      const info = lstatSync(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Untracked path blocks directory transition');
      for (const name of readdirSync(dir)) removeEmptyDirectories(join(dir, name));
      rmdirSync(dir);
      undo.push(() => { mkdirSync(dir); chmodSync(dir, info.mode & 0o777); });
    };
    try {
      // Remove old files first so both file-to-directory transitions and their
      // reverse can be published. Every mutation records its exact inverse.
      for (const change of changes.filter(c => c.before !== null)) {
        const full = diskPath(this.root, change.path);
        beforeWrite?.(change.path); unlinkSync(full);
        undo.push(() => { writeFileSync(full, change.before); chmodSync(full, fileMode(this.baseModes, change.path)); });
      }
      for (const change of changes.filter(c => c.after !== null)) {
        const full = diskPath(this.root, change.path);
        beforeWrite?.(change.path);
        if (existsSync(full)) removeEmptyDirectories(full);
        parents(dirname(full));
        const temp = `${full}.changeset-${randomUUID()}`; temps.push(temp);
        const mode = fileMode(this.modes, change.path);
        writeFileSync(temp, change.after, { flag: 'wx', mode });
        chmodSync(temp, mode); // writeFile's mode alone is filtered through umask.
        renameSync(temp, full); undo.push(() => unlinkSync(full));
      }
    } catch (error) {
      const failures = [];
      for (const temp of temps) { try { if (existsSync(temp)) unlinkSync(temp); } catch (e) { failures.push(e.message); } }
      for (const restore of undo.reverse()) { try { restore(); } catch (e) { failures.push(e.message); } }
      if (failures.length) throw new Error(`${error.message}; rollback failed: ${failures.join('; ')}`);
      throw error;
    } finally { for (const temp of temps) if (existsSync(temp)) unlinkSync(temp); }
    this.baseModes = { ...this.modes };
    this.base = new Map(this.files);
    return changes.map(c => c.path);
  }
  materialize(root) {
    root = resolve(root);
    for (const [path, text] of this.files) {
      const full = diskPath(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, text, { mode: fileMode(this.modes, path) }); chmodSync(full, fileMode(this.modes, path));
    }
  }
}
