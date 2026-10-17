import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { safePath } from '../../../scripts/changeset/workspace.mjs';

const git = (record, ...args) => execFileSync('git', ['-C', record.checkout, ...args], { encoding: 'utf8', timeout: 5000 });

// Commands can read source and write only designated infrastructure outputs.
// The kernel mount boundary, not a shell regex, prevents source authoring.
export function sourceCommand(record, command, { outputs = [], gitWrite = false, checkoutWrite = false, platform = process.platform } = {}) {
  if (platform !== 'linux') throw new Error('Read-only source execution requires the configured Linux execution host and bubblewrap; unrestricted fallback is prohibited');
  execFileSync('bwrap', ['--version'], { encoding: 'utf8', timeout: 5000 });
  const checkout = realpathSync(record.checkout), packageDir = realpathSync(record.package);
  const relPackage = relative(checkout, packageDir);
  if (!relPackage || (relPackage !== '..' && !relPackage.startsWith('../') && !isAbsolute(relPackage))) throw new Error('Writable package must be outside source');
  const relSource = relative(packageDir, checkout);
  if (relSource !== '..' && !relSource.startsWith('../') && !isAbsolute(relSource)) throw new Error('Writable package cannot contain source');
  const writable = [];
  for (const path of outputs) {
    safePath(path);
    if (git(record, 'ls-files', '--', path).trim() || !gitIgnored(record, path))
      throw new Error(`Writable output must be ignored and contain no tracked source: ${path}`);
    let current = checkout;
    for (const part of path.split('/')) {
      current = join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink output refused: ${path}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    mkdirSync(current, { recursive: true }); writable.push(current);
  }
  if (gitWrite) {
    writable.push(resolve(checkout, git(record, 'rev-parse', '--git-dir').trim()));
    writable.push(resolve(checkout, git(record, 'rev-parse', '--git-common-dir').trim()));
  }
  const scratch = mkdtempSync(join(tmpdir(), 'spec-command-'));
  return { command: 'bwrap', args: ['--die-with-parent', '--unshare-user', '--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--bind', packageDir, packageDir, '--bind', scratch, scratch,
    ...(checkoutWrite ? ['--bind', checkout, checkout] : []),
    ...[...new Set(writable)].flatMap(path => ['--bind', path, path]),
    '--setenv', 'TMPDIR', scratch, '--chdir', checkout,
    '--', '/bin/bash', '-o', 'pipefail', '-c', `export SHELLOPTS\n${command}`],
    cleanup: () => rmSync(scratch, { recursive: true, force: true }),
    enforcement: { source: checkoutWrite ? record.generator_stage ? 'isolated-generator-copy' : 'trusted-git-operation' : 'read-only', outputs, git_metadata_writable: gitWrite } };
}

function gitIgnored(record, path) {
  try { git(record, 'check-ignore', '--no-index', '--', path); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}
