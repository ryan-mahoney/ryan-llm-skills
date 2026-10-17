import { mkdtempSync, existsSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { Workspace } from '../../../scripts/changeset/workspace.mjs';

export function stagedGenerator(record, runCommand) {
  return async ({ operation, files, signal, trace }) => {
    const argv = operation.generator?.argv;
    if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || !value || value.includes('\0'))
      || JSON.stringify(argv).length > 8000) throw new Error('Generator requires a bounded argv array');
    if (['sh', 'bash', 'zsh', 'fish', 'env', 'pi', 'codex', 'claude', 'opencode'].includes(basename(argv[0]))
      || argv.some(value => ['-e', '-c', '--eval', '--execute'].includes(value)))
      throw new Error('Use an existing formatter/generator command, not a shell, agent, or inline implementation');
    const directory = mkdtempSync(join(tmpdir(), 'spec-generator-'));
    let drained = true;
    try {
      const modes = Object.fromEntries(Object.keys(files).filter(path => files[path] !== null)
        .map(path => [path, lstatSync(join(record.checkout, path)).mode & 0o777]));
      const before = new Workspace(Object.fromEntries(Object.entries(files).filter(([, value]) => value !== null)), null, modes);
      before.materialize(directory);
      for (const name of ['node_modules', '.git']) {
        const source = join(record.checkout, name);
        if (existsSync(source)) symlinkSync(source, join(directory, name));
      }
      const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
      trace?.emit('generator_started', { operation_id: operation.id, executable: argv[0], writes: operation.writes });
      const result = await runCommand({ ...record, checkout: directory, generator_stage: true }, argv.map(quote).join(' '), 600, signal, { checkoutWrite: true });
      drained = !result.requires_cancellation;
      trace?.artifact(`generator-${operation.id}.json`, { argv, ...result });
      trace?.emit('generator_finished', { operation_id: operation.id, exit_code: result.exit_code,
        requires_cancellation: result.requires_cancellation ?? false });
      if (result.error || result.exit_code !== 0) throw new Error(`Generator failed: ${result.error ?? result.exit_code}; see its command receipt`);
      signal?.throwIfAborted();
      const after = Workspace.load(directory, { maxBytes: 16 * 1024 * 1024, maxFiles: 10000 }), paths = new Set([...Object.keys(files), ...Object.keys(after.snapshot())]);
      const changes = {};
      for (const path of paths) {
        if (before.read(path) === after.read(path) && (before.modes[path] ?? 0o644) === (after.modes[path] ?? 0o644)) continue;
        if (!operation.writes.includes(path)) throw new Error(`Generator changed an undeclared output: ${path}`);
        if (after.read(path) !== null && (before.modes[path] ?? 0o644) !== after.modes[path]) throw new Error(`Generator mode changes require an explicit supported operation: ${path}`);
        changes[path] = after.read(path);
      }
      return { files: changes };
    } finally { if (drained) rmSync(directory, { recursive: true, force: true }); }
  };
}
