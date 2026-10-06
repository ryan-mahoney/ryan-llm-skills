#!/usr/bin/env node
import { gitFacts, summarizeLog } from './core.mjs';

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || !command) {
    console.log('Usage: node cli.mjs git [--repo PATH] [--base REV [--head REV]] [--limit 1..1000]\n       node cli.mjs log --file PATH\nRead-only facts and bounded excerpts. No readiness verdict or inferred test result.');
  } else {
    if (!['git', 'log'].includes(command)) throw new Error('unknown command');
    const options = {};
    const allowed = command === 'git' ? ['repo', 'base', 'head', 'limit'] : ['file'];
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].slice(2), value = args[i + 1];
      if (!args[i].startsWith('--') || !allowed.includes(key) || !value || value.startsWith('--') || key in options) throw new Error('invalid arguments');
      options[key] = key === 'limit' ? Number(value) : value;
    }
    if (command === 'log' && !options.file) throw new Error('log requires --file');
    console.log(JSON.stringify(command === 'git' ? gitFacts(options) : await summarizeLog(options.file)));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message })); process.exitCode = 1;
}
