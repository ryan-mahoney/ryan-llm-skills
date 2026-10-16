import { spawn } from 'node:child_process';
import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Native file tools receive virtual /work paths. Never allow an absolute path or
// a symlink created by a shell command to reveal another trial or an oracle.
export function confinedPath(root, virtual) {
  const rel = relative('/work', resolve('/work', virtual));
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('/')) throw new Error('Path outside /work');
  let current = realpathSync(root);
  for (const part of rel.split('/').filter(Boolean)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Symlinks unavailable in study tools'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}

export function sandbox(root, command, { readOnly = false, signal, timeoutMs = 30000, onData, oracle } = {}) {
  return new Promise((resolvePromise, reject) => {
    const args = ['--die-with-parent', '--new-session', '--unshare-all', '--clearenv',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--dir', '/opt', '--ro-bind', process.execPath, '/opt/node',
      readOnly ? '--ro-bind' : '--bind', realpathSync(root), '/work',
      '--setenv', 'PATH', '/opt:/usr/bin:/bin', '--setenv', 'HOME', '/tmp',
      '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'PYTHONDONTWRITEBYTECODE', '1', '--chdir', '/work'];
    if (oracle) args.push('--ro-bind', realpathSync(oracle), '/oracle.mjs');
    args.push('--', '/bin/bash', '--noprofile', '--norc', '-c', command);
    const child = spawn('bwrap', args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {} });
    let output = '', timedOut = false, settled = false;
    const collect = data => { output = (output + data.toString()).slice(-65536); onData?.(data); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const abort = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; abort(); }, Math.min(timeoutMs, 30000));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { if (!settled) { settled = true; cleanup(); reject(error); } });
    child.on('close', (code, termSignal) => {
      if (settled) return; settled = true; cleanup();
      resolvePromise({ ok: code === 0, exitCode: code ?? 137, output, timedOut, signal: termSignal });
    });
  });
}

export async function grade(root, source, { oracle, signal } = {}) {
  const marker = `STUDY_COMPLETED_${randomUUID()}`;
  writeFileSync(oracle, source + '\nconsole.log(' + JSON.stringify(marker) + ');\n');
  const result = await sandbox(root, 'node /oracle.mjs', { oracle, readOnly: true, signal });
  const completed = result.output.split('\n').includes(marker);
  return { ...result, ok: result.ok && completed, completed, output: result.output.replace(marker + '\n', '') };
}
