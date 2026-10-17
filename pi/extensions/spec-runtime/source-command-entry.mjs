// Invoked inside an existing contained wave mount. Resolve source/output paths
// there, never against the coordinator's empty outside overlay mountpoint.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sourceCommand } from './source-commands.mjs';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let command;
try {
  command = sourceCommand(input.record, input.command, input.options);
  const result = spawnSync(command.command, command.args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
finally { command?.cleanup(); }
