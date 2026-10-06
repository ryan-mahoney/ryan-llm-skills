#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { decide, status, MAX_INPUT } from './core.mjs';
import { decisionReport } from './report.mjs';

async function stdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT) throw new Error('Input exceeds 32768 bytes.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function main() {
  const [task, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' || args[i] === '--input' || (task === 'report' && args[i] === '--since')) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing option value.');
      options[args[i].slice(2)] = args[++i];
    } else if (args[i] === '--offline') options.offline = true;
    else if (args[i] === '--verify-connectivity') options.verifyConnectivity = true;
    else throw new Error('Unknown option.');
  }
  let result;
  if (task === 'report') {
    if (options.input || options.verifyConnectivity) throw new Error('Unknown option.');
    result = await decisionReport(options);
  } else if (task === 'status') result = await status(options);
  else {
    if (options.verifyConnectivity) throw new Error('--verify-connectivity applies only to status.');
    const raw = options.input && options.input !== '-' ? await readFile(options.input, 'utf8') : await stdin();
    if (Buffer.byteLength(raw) > MAX_INPUT) throw new Error('Input exceeds 32768 bytes.');
    let input;
    try { input = JSON.parse(raw); } catch { throw new Error('Input must be JSON.'); }
    result = await decide(task, { ...options, input });
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch(error => {
  // Never echo source JSON or upstream errors.
  const allowed = ['Unknown option.', 'Missing option value.', 'Input exceeds 32768 bytes.', 'Input must be JSON.', 'An absolute repository path is required.', 'Unknown decision task.', 'Invalid decision input. See the version 1 contract.', '--verify-connectivity applies only to status.', 'Invalid report start time.', 'Decision ledger exceeds report limit.'];
  process.stdout.write(JSON.stringify({ schema_version: 1, status: 'error', error: allowed.includes(error.message) ? error.message : 'Unable to read decision input.' }) + '\n');
  process.exitCode = 1;
});
