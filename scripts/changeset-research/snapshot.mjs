import { execFileSync } from 'node:child_process';
export function gitSnapshot(repo) {
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const files = Object.create(null), modes = Object.create(null);
  for (const entry of git('ls-tree', '-rz', 'HEAD').split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t'), [mode, type] = entry.slice(0, tab).split(' '), path = entry.slice(tab + 1);
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error(`Unsupported fixture mode: ${mode}`);
    files[path] = git('show', `HEAD:${path}`);
    modes[path] = mode === '100755' ? 0o755 : 0o644;
  }
  return { files, modes };
}
