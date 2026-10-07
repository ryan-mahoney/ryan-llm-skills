#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { discover, discoverManaged, discoverPackage, report } from './core.mjs';
import { metrics, formatMetrics } from './metrics.mjs';
import { collectWorkspace, renderWorkspace, readEnrollments } from './sentinel.mjs';
import { createRepositoryDiscovery } from './discovery.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const options = {};
// Resolve after the write has been handed to the OS; process.exit can otherwise
// truncate a snapshot larger than the pipe buffer.
const print = text => new Promise(resolve => process.stdout.write(`${text}\n`, resolve));
const usage = `Usage: node scripts/spec-observe/cli.mjs list|runs|report|metrics|sentinel [options]
  metrics --package PATH  Calls, role/model response time, steps, test submissions and cost
  --format text|json     Metrics output (default json)
  --all-sessions         Metrics across all recorded coordinator sessions, including pauses
  runs                 List managed run pointers without reading any transcripts
  --index-root PATH     Managed index (default ~/.pi/agent/spec-runtime; runs only)
  sentinel status [--root PATH | --package PATH] [--format text|json] [--agent-dir PATH]  Discover workspace repositories (default ~/Documents)
  --sessions-root PATH  Default: ~/.pi/agent/sessions
  --package PATH        Discover managed runtime records and linked parent/owner/editor sessions
  --cwd PATH            Filter root sessions by exact recorded working directory
  --limit N             Root sessions listed (default 10)
  --session ID|PATH     Report this discovered session and its descendants
  --max-mb N            Per-session read bound (default 64)
Output is compact metadata JSON. No transcript text, commands, or prompts are emitted.
Without --session, report selects the most recently started matching root session.`;
try {
  if (command === '--help' || command === 'help') { console.log(usage); process.exit(0); }
  if (!['list', 'runs', 'report', 'metrics', 'sentinel'].includes(command)) throw new Error(usage);
  if (command === 'sentinel' && args.shift() !== 'status') throw new Error(usage);
  while (args.length) {
    const key = args.shift();
    if (key === '--all-sessions' && command === 'metrics') { options[key] = true; continue; }
    const allowed = ['--sessions-root', '--index-root', '--package', '--cwd', '--limit', '--session', '--max-mb',
      ...(command === 'metrics' ? ['--format'] : []), ...(command === 'sentinel' ? ['--format', '--agent-dir', '--root'] : [])];
    if (!allowed.includes(key) || !args.length) throw new Error(`Unknown option or missing value: ${key}`);
    options[key] = args.shift();
  }
  const limit = Number(options['--limit'] ?? 10);
  const maxMb = Number(options['--max-mb'] ?? 64);
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(maxMb) || maxMb < 1 || maxMb > 1024) throw new Error('limit must be a positive integer; max-mb must be between 1 and 1024.');
  if (command === 'metrics') {
    if (!options['--package'] || (options['--all-sessions'] && options['--session']) || Object.keys(options).some(key => !['--package', '--session', '--all-sessions', '--format', '--max-mb'].includes(key))) throw new Error('metrics requires --package; choose --session or --all-sessions.');
    if (!['json', 'text'].includes(options['--format'] ?? 'json')) throw new Error('format must be text or json');
    const value = await metrics(options['--package'], { session: options['--session'], allSessions: options['--all-sessions'], maxBytes: maxMb * 1024 * 1024 });
    console.log(options['--format'] === 'text' ? formatMetrics(value) : JSON.stringify(value, null, 2));
    process.exit(0);
  }
  if (command === 'runs') {
    if (Object.keys(options).some(key => !['--limit', '--index-root'].includes(key))) throw new Error('runs accepts only --limit and --index-root.');
    console.log(JSON.stringify(await discoverManaged(options['--index-root'] ?? path.join(os.homedir(), '.pi/agent/spec-runtime'), { limit }), null, 2));
    process.exit(0);
  }
  if (command === 'sentinel') {
    if (Object.keys(options).some(key => !['--package', '--format', '--agent-dir', '--root'].includes(key))) throw new Error('sentinel status accepts only --root, --package, --format and --agent-dir.');
    if (options['--package'] && options['--root']) throw new Error('Choose --root or --package.');
    const format = options['--format'] ?? 'text';
    if (!['text', 'json'].includes(format)) throw new Error('format must be text or json');
    const agentDir = options['--agent-dir'] ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi/agent');
    const scope = process.env.PI_INTERCOM_SCOPE_ID ?? null;
    let roots = [];
    const packages = [];
    let enrollmentErrors = [];
    let discovery;
    if (options['--package']) packages.push(options['--package']);
    else {
      ({ roots, errors: enrollmentErrors } = await readEnrollments({ agentDir, scope }));
      discovery = await createRepositoryDiscovery({ agentDir, root: options['--root'] }).read();
      roots = [...new Set([...roots, ...discovery.roots])];
    }
    const snapshot = await collectWorkspace({ roots, packages, enrollmentErrors, discovery, indexDir: path.join(agentDir, 'spec-runtime'), agentDir, scope });
    if (format === 'json') {
      await print(JSON.stringify(enrollmentErrors.length ? { ...snapshot, enrollment_errors: enrollmentErrors } : snapshot, null, 2));
      process.exit(0);
    }
    const lines = renderWorkspace(snapshot);
    for (const error of enrollmentErrors) lines.push(`Enrollment unavailable: ${error.path} (${error.code})`);
    await print(lines.join('\n'));
    process.exit(0);
  }
  if (options['--index-root']) throw new Error('--index-root applies only to runs.');
  if (options['--package'] && options['--sessions-root']) throw new Error('Choose --package or --sessions-root.');
  const index = options['--package'] ? await discoverPackage(options['--package'], { cwd: options['--cwd'], limit })
    : await discover(options['--sessions-root'] ?? path.join(os.homedir(), '.pi/agent/sessions'), { cwd: options['--cwd'], limit });
  const result = command === 'list' ? { roots: index.roots, ...(index.runtime ? { runtime: index.runtime } : {}), discovery_errors: index.errors }
    : await report(index, options['--session'], { maxBytes: Math.floor(maxMb * 1024 * 1024) });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
