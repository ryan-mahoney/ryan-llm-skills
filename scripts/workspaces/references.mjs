// Contextual brief references. Skill discovery uses the installed Pi vendor;
// file identities and snapshots belong to the workspace, never the browser.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, delimiter } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_CONTEXT_BYTES = 96 * 1024;
const MAX_ENTRIES = 20000;
const excluded = new Set(['.git', 'node_modules']);
const workspaceExcluded = new Set(['.sentinel', '.restory', 'sessions', 'assignments', 'threads']);
const hash = value => createHash('sha256').update(value).digest('hex');
const idFor = (kind, ...parts) => `${kind}:${hash(JSON.stringify(parts))}`;
const invalid = message => Object.assign(new Error(message), { code: 'invalid-reference' });
const missing = message => Object.assign(new Error(message), { code: 'reference-unavailable' });
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const git = (cwd, args) => new Promise((done, fail) => execFile('git', args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (e, out) => e ? fail(e) : done(out)));
let vendorPromise;

async function importSkillVendor(home, agentDir) {
  const candidates = [];
  const require = createRequire(import.meta.url);
  for (const name of ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent']) {
    try { candidates.push(join(dirname(require.resolve(name)), 'core/skills.js')); } catch {}
    for (const prefix of ['/opt/homebrew/lib', '/usr/local/lib', '/usr/lib']) candidates.push(join(prefix, 'node_modules', name, 'dist/core/skills.js'));
    try {
      const install = process.env.PI_MANAGED_INSTALL_ROOT || join(agentDir, 'install');
      const version = (await readFile(join(install, 'current-version'), 'utf8')).trim();
      if (/^[a-zA-Z0-9._+-]+$/.test(version)) candidates.unshift(join(install, 'releases', version, 'node_modules', name, 'dist/core/skills.js'));
    } catch {}
  }
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    try {
      let parent = dirname(await realpath(join(dir, 'pi')));
      for (let i = 0; i < 4; i++, parent = dirname(parent)) candidates.push(join(parent, 'core/skills.js'), join(parent, 'dist/core/skills.js'));
    } catch {}
  }
  for (const path of [...new Set(candidates)]) {
    try {
      const module = await import(pathToFileURL(path).href);
      if (typeof module.loadSkills !== 'function') continue;
      const { DefaultPackageManager } = await import(pathToFileURL(join(dirname(path), 'package-manager.js')).href);
      const { SettingsManager } = await import(pathToFileURL(join(dirname(path), 'settings-manager.js')).href);
      return { ...module, DefaultPackageManager, SettingsManager };
    } catch {}
  }
  throw missing('Pi skill discovery is unavailable on the execution host.');
}

async function configuredSkillPaths(cwd, agentDir, home) {
  const paths = [];
  for (const [base, file] of [[agentDir, join(agentDir, 'settings.json')], [cwd, join(cwd, '.pi/settings.json')]]) {
    try {
      const settings = JSON.parse(await readFile(file, 'utf8'));
      for (const path of settings.skills || []) if (typeof path === 'string' && !path.startsWith('!')) paths.push(resolve(base, path.startsWith('~/') ? join(home, path.slice(2)) : path));
    } catch (e) { if (e.code !== 'ENOENT') throw missing('Pi skill settings could not be read.'); }
  }
  return paths;
}

export async function discoverSkills({ cwd, agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), home = homedir(), skillLoader } = {}) {
  // Loading skills is read-only; no agent session, extension or model is started.
  const vendor = skillLoader ? { loadSkills: skillLoader } : await (vendorPromise ??= importSkillVendor(home, agentDir).catch(e => { vendorPromise = undefined; throw e; }));
  let paths, metadata = new Map();
  const warnings = [];
  if (skillLoader) paths = await configuredSkillPaths(cwd, agentDir, home);
  else {
    const settingsManager = vendor.SettingsManager.create(cwd, agentDir);
    const manager = new vendor.DefaultPackageManager({ cwd, agentDir, settingsManager });
    const resources = await manager.resolve(async source => { warnings.push(`Skill package is not installed: ${source}`); return 'skip'; });
    paths = resources.skills.filter(resource => resource.enabled).map(resource => { metadata.set(resource.path, resource.metadata); return resource.path; });
  }
  const result = vendor.loadSkills({ cwd, agentDir, includeDefaults: Boolean(skillLoader), skillPaths: paths });
  return { skills: result.skills.map(skill => ({ kind: 'skill', id: idFor('skill', skill.filePath), label: skill.name, description: skill.description, source: metadata.get(skill.filePath)?.scope || skill.sourceInfo?.scope || skill.sourceInfo?.source || 'host', path: skill.filePath, base_dir: skill.baseDir })), warnings: [...warnings, ...result.diagnostics.map(d => d.message)].slice(0, 20) };
}

export function validateReferences(value = []) {
  if (!Array.isArray(value) || value.length > 16) throw invalid('Select at most 16 skills and files.');
  const seen = new Set();
  return value.map(ref => {
    if (!ref || typeof ref !== 'object' || !['skill', 'file'].includes(ref.kind) || typeof ref.id !== 'string' || !/^(skill|file):[0-9a-f]{64}$/.test(ref.id) || !ref.id.startsWith(`${ref.kind}:`)) throw invalid('A selected reference is invalid.');
    if (seen.has(ref.id)) throw invalid('A reference was selected twice.');
    seen.add(ref.id);
    return { kind: ref.kind, id: ref.id };
  });
}

async function fileRoots(workspace, executionDir) {
  const roots = [{ scope: 'workspace', root: workspace.directory, label: 'workspace', workspace_id: workspace.id }];
  for (const repo of workspace.repositories || []) {
    if (repo.status && !['ok', 'available'].includes(repo.status)) continue;
    let root;
    try { root = await realpath(isAbsolute(repo.path) ? repo.path : resolve(workspace.directory, repo.path)); } catch { continue; }
    if (executionDir !== workspace.directory && root !== executionDir) continue;
    roots.push({ scope: 'repository', root, label: repo.id, workspace_id: workspace.id });
  }
  return roots;
}

async function enumerateRoot(source) {
  const root = await realpath(source.root);
  let paths;
  if (source.scope === 'repository') {
    try { paths = (await git(root, ['ls-files', '-co', '--exclude-standard', '-z'])).split('\0').filter(Boolean); } catch {}
  }
  let truncated = false;
  if (!paths) {
    paths = [];
    async function walk(dir, prefix = '') {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (excluded.has(entry.name) || source.scope === 'workspace' && !prefix && workspaceExcluded.has(entry.name)) continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(join(dir, entry.name), path);
        else if (entry.isFile() || entry.isSymbolicLink()) paths.push(path);
        if (paths.length >= MAX_ENTRIES) { truncated = true; return; }
      }
    }
    await walk(root);
  }
  const files = [];
  for (const path of [...new Set(paths)].slice(0, MAX_ENTRIES)) {
    if (path.split('/').some(p => excluded.has(p)) || source.scope === 'workspace' && workspaceExcluded.has(path.split('/')[0])) continue;
    files.push({ kind: 'file', id: idFor('file', source.workspace_id, source.scope, source.label, path), label: path, description: source.label, source: source.label, scope: source.scope, relative_path: path, root });
  }
  return { files, truncated: truncated || paths.length > MAX_ENTRIES };
}

// Fuzzy path matching adapted from Re-Story's repoFileReferenceTrigger. Rank
// exact names and prefixes before subsequences, with stable path tie breaking.
export function rankReferences(items, query, limit = 30) {
  const q = query.toLowerCase();
  return items.map(item => {
    const name = item.label.toLowerCase();
    const searchable = `${item.source}/${name}`.toLowerCase();
    let score = 0, cursor = 0;
    if (q) {
      if (name === q) score = 10000;
      else if (basename(name).startsWith(q)) score = 9000;
      else if (name.includes(q) || searchable.includes(q)) score = 8000;
      else { for (const char of q) { const pos = searchable.indexOf(char, cursor); if (pos < 0) return null; score -= pos - cursor; cursor = pos + 1; } score += 1000; }
    }
    return { item, score: score - name.length / 1000 };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label)).slice(0, limit).map(v => v.item);
}

export function createReferenceCatalog({ home = homedir(), agentDir, skillLoader } = {}) {
  const cache = new Map();
  const skillCache = new Map();
  async function files(workspace, executionDir, fresh = false) {
    const key = `${workspace.directory}\0${executionDir}`;
    let entry = cache.get(key);
    if (fresh || !entry || Date.now() - entry.time > 10000) {
      entry = { time: Date.now(), promise: fileRoots(workspace, executionDir).then(roots => Promise.all(roots.map(async root => {
        try { return await enumerateRoot(root); } catch { return { files: [], warnings: [`${root.label} files could not be read.`] }; }
      }))).then(parts => ({ files: parts.flatMap(p => p.files), warnings: parts.flatMap(p => p.warnings || []), truncated: parts.some(p => p.truncated) })) };
      if (cache.size >= 32) cache.delete(cache.keys().next().value);
      cache.set(key, entry);
    }
    return entry.promise;
  }
  async function skills(executionDir, fresh = false) {
    let entry = skillCache.get(executionDir);
    if (fresh || !entry || Date.now() - entry.time > 5000) {
      entry = { time: Date.now(), promise: discoverSkills({ cwd: executionDir, home, agentDir, skillLoader }).catch(error => { skillCache.delete(executionDir); throw error; }) };
      if (skillCache.size >= 32) skillCache.delete(skillCache.keys().next().value);
      skillCache.set(executionDir, entry);
    }
    return entry.promise;
  }
  async function captureFile(file) {
    try {
      const path = await realpath(join(file.root, file.relative_path));
      if (!inside(file.root, path)) throw missing('Selected file no longer belongs to its source.');
      const info = await stat(path);
      if (!info.isFile()) throw missing('Selected reference is no longer a file.');
      if (info.size > MAX_FILE_BYTES) throw invalid('Selected file exceeds the 64 KiB context limit.');
      const bytes = await readFile(path);
      if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) throw invalid('Select a text file up to 64 KiB.');
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid('Select a UTF-8 text file.'); }
      return { ...file, path, content, sha256: hash(bytes) };
    } catch (error) {
      if (['invalid-reference', 'reference-unavailable'].includes(error.code)) throw error;
      throw missing('Selected file could not be read on the execution host.');
    }
  }
  return {
    async suggest({ workspace, executionDir, kind, query = '' }) {
      if (!['skill', 'file'].includes(kind) || typeof query !== 'string' || query.length > 200) throw invalid('Suggestion query is invalid.');
      const result = kind === 'skill' ? await skills(executionDir) : await files(workspace, executionDir);
      const ranked = rankReferences(result.skills || result.files, query);
      const items = [];
      for (const item of ranked) {
        if (kind === 'file') {
          try {
            const captured = await captureFile(item);
            const heading = captured.content.match(/^#\s+(.+)$/m)?.[1];
            items.push({ ...item, description: heading ? `${heading} · ${item.source}` : `${basename(item.label)} · ${item.source}` });
          } catch { continue; }
        } else items.push(item);
      }
      return { items: items.map(({ root, ...item }) => item), warnings: result.warnings, truncated: result.truncated || false };
    },
    async capture({ workspace, executionDir, references }) {
      const refs = validateReferences(references);
      if (!refs.length) return { references: [], text: '' };
      const skillItems = refs.some(r => r.kind === 'skill') ? (await skills(executionDir, true)).skills : [];
      const fileItems = refs.some(r => r.kind === 'file') ? (await files(workspace, executionDir, true)).files : [];
      const captured = [];
      let total = 0;
      for (const ref of refs) {
        const item = (ref.kind === 'skill' ? skillItems : fileItems).find(item => item.id === ref.id);
        if (!item) throw missing('A selected skill or file is no longer available in this target.');
        let capture;
        if (ref.kind === 'skill') {
          let bytes;
          try { bytes = await readFile(item.path); } catch { throw missing('Selected skill could not be read on the execution host.'); }
          capture = { ...item, content: bytes.toString('utf8'), sha256: hash(bytes) };
        } else capture = await captureFile(item);
        total += Buffer.byteLength(capture.content);
        if (total > MAX_CONTEXT_BYTES) throw invalid('Selected context exceeds 96 KiB. Select fewer or smaller references.');
        const { root, ...snapshot } = capture;
        captured.push(snapshot);
      }
      const text = captured.map(ref => ref.kind === 'skill'
        ? `Apply skill ${ref.label}. Supporting references are relative to ${ref.base_dir}.\nSkill source: ${ref.path}\n\n${ref.content}`
        : `File context: ${ref.source}/${ref.label}\nOriginal source: ${ref.path}\n\n${ref.content}`).join('\n\n---\n\n');
      return { references: captured, text: `\n\n# Explicitly selected assignment context\n\n${text}\n` };
    },
  };
}
