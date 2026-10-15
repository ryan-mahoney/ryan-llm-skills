#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { discover, discoverManaged, discoverPackage, report } from './core.mjs';
import { metrics, formatMetrics } from './metrics.mjs';
import { collectWorkspace, renderWorkspace, readEnrollments } from './sentinel.mjs';
import { createRepositoryDiscovery } from './discovery.mjs';
import { changedMembers, epicWaitState, epicWaves, parseEpic } from './epics.mjs';
import { checkPackage, listEpics } from '../spec-location/index.mjs';
import { validateStepIndex } from './steps.mjs';
import { resolveStorageRoot } from '../workspaces/store.mjs';
import { publicHint } from '../../pi/extensions/spec-runtime/monitor.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const options = {};
// Resolve after the write has been handed to the OS; process.exit can otherwise
// truncate a snapshot larger than the pipe buffer.
const print = text => new Promise(resolve => process.stdout.write(`${text}\n`, resolve));
const usage = `Usage: node scripts/spec-observe/cli.mjs list|runs|report|metrics|sentinel|epic|steps [options]
  epic lint --workspace W --epic SLUG [--root PATH]  Validate one epic record; print its dependency waves (exit 1 when invalid)
  epic wait --workspace W --epic SLUG [--minutes N] [--interval-seconds N] [--root PATH]
                         Block until a member's status, attention or launched session changes, or N minutes
                         pass (default 10, at most 60; checks every 60 seconds); print members and what changed
  steps lint PACKAGE     Validate the package step index against its targets and evidence plan (exit 1 when invalid)
  metrics --package PATH  Calls, role/model response time, steps, test submissions and cost
  --format text|json     Metrics output (default json)
  --all-sessions         Metrics across all recorded coordinator sessions, including pauses
  runs                 List managed run pointers without reading any transcripts
  --index-root PATH     Managed index (default ~/.pi/agent/spec-runtime; runs only)
  sentinel status [--all] [--root PATH | --package REF|PATH] [--format text|json] [--agent-dir PATH]  Discover workspace repositories (default ~/Documents)
  sentinel inspect FULL-UUID [--root PATH | --package REF|PATH] [--format text|json] [--agent-dir PATH]  Inspect one exact assignment row
  --sessions-root PATH  Default: ~/.pi/agent/sessions
  --package PATH        Discover managed runtime records and linked parent/owner/editor sessions (sentinel: ws/slug or the package folder)
  --cwd PATH            Filter root sessions by exact recorded working directory
  --limit N             Root sessions listed (default 10)
  --session ID|PATH     Report this discovered session and its descendants
  --max-mb N            Per-session read bound (default 64)
Output is compact metadata JSON. No transcript text, commands, or prompts are emitted.
Without --session, report selects the most recently started matching root session.`;
try {
  if (command === '--help' || command === 'help') { console.log(usage); process.exit(0); }
  if (command === 'epic') {
    const [action, ...rest] = args;
    const flags = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (!['--workspace', '--epic', '--root', '--minutes', '--interval-seconds'].includes(rest[i]) || rest[i + 1] === undefined) throw new Error(usage);
      flags[rest[i]] = rest[i + 1];
    }
    if (!['lint', 'wait'].includes(action) || !flags['--workspace'] || !flags['--epic']) throw new Error(usage);
    const listed = await listEpics(flags['--workspace'], { root: flags['--root'] });
    if (!listed.ok) throw new Error(`${listed.code}: ${listed.message}`);
    const found = listed.epics.find(item => item.slug === flags['--epic']);
    const parsed = !found ? { error: 'no epic record' } : found.error ? { error: `unreadable: ${found.error}` }
      : parseEpic(found.epic, { slug: found.slug });
    const result = parsed.error ? { ok: false, record: found?.record ?? null, error: parsed.error }
      : { ok: true, record: found.record, waves: epicWaves(parsed.epic.packages).waves,
        missing: found.members.filter(member => !member.exists).map(member => member.slug) };
    if (action === 'lint' || !result.ok) {
      await print(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    }
    const minutes = Number(flags['--minutes'] ?? 10);
    const interval = Number(flags['--interval-seconds'] ?? 60);
    if (!(minutes > 0 && minutes <= 60) || !(interval >= 5 && interval <= 600)) throw new Error('minutes must be in (0, 60]; interval-seconds in [5, 600].');
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi/agent');
    const storageRoot = flags['--root'] ?? resolveStorageRoot(process.env, os.homedir());
    const packages = found.members.map(member => `${flags['--workspace']}/${member.slug}`);
    const observe = async () => {
      const snapshot = await collectWorkspace({ roots: [], packages, enrollmentErrors: [], indexDir: path.join(agentDir, 'spec-runtime'),
        agentDir, scope: process.env.PI_INTERCOM_SCOPE_ID ?? null, includeInactive: true, storageRoot, packagesOnly: true });
      const epic = snapshot.epics.find(item => item.epic === flags['--epic'] && item.workspace === flags['--workspace']);
      if (!epic) throw new Error(`sentinel did not report epic ${flags['--epic']}: ${JSON.stringify(snapshot.coverage)}`);
      // Members carry real paths; an assignment records the package path as resolved from the storage root.
      const rows = await Promise.all((snapshot.assignments ?? []).map(async row =>
        ({ ...row, spec_package: row.spec_package && await realpath(row.spec_package).catch(() => row.spec_package) })));
      return { epic, state: epicWaitState(epic, rows) };
    };
    const first = await observe();
    const deadline = Date.now() + minutes * 60000;
    let current = first;
    let changed = [];
    while (!changed.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(interval * 1000, Math.max(0, deadline - Date.now()))));
      current = await observe();
      changed = changedMembers(first.state, current.state);
    }
    const { epic } = current;
    await print(JSON.stringify({ ok: true, changed, timed_out: !changed.length,
      ready: epic.members.filter(member => ['proposed', 'prepared'].includes(member.status) && !member.waiting_on.length).map(member => member.name),
      members: epic.members.map(({ name, status, attention, step, waiting_on, pr_url }) =>
        ({ name, status, attention, step, waiting_on, pr_url, sessions: current.state[name].sessions })),
      coverage: epic.coverage }, null, 2));
    process.exit(0);
  }
  if (command === 'steps') {
    const [action, ...rest] = args;
    if (action !== 'lint' || rest.length !== 1) { console.error(usage); process.exit(2); }
    const checked = await checkPackage(rest[0]);
    if (!checked.ok) { console.error(`${checked.code}: ${checked.message}`); process.exit(2); }
    let index;
    let evidencePlan;
    try {
      index = JSON.parse(await readFile(path.join(checked.locations.package_dir, 'spec-steps.json'), 'utf8'));
      evidencePlan = JSON.parse(await readFile(path.join(checked.locations.package_dir, 'evidence-plan.json'), 'utf8'));
    } catch (error) {
      console.error(`unreadable step index: ${error.message}`);
      process.exit(2);
    }
    const result = validateStepIndex(index, { targets: checked.locations.targets.map(target => target.id), evidencePlan });
    await print(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }
  if (!['list', 'runs', 'report', 'metrics', 'sentinel'].includes(command)) throw new Error(usage);
  const sentinelAction = command === 'sentinel' ? args.shift() : null;
  if (command === 'sentinel' && !['status', 'inspect'].includes(sentinelAction)) throw new Error(usage);
  let sentinelInspectId = null;
  if (sentinelAction === 'inspect') {
    sentinelInspectId = args[0] && !args[0].startsWith('--') ? args.shift() : null;
    if (!sentinelInspectId) throw new Error(usage);
    // A full UUID is required before any discovery or collection runs.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sentinelInspectId)) throw new Error('sentinel inspect requires a full assignment UUID.');
  }
  while (args.length) {
    const key = args.shift();
    if (key === '--all' && command === 'sentinel') { options[key] = true; continue; }
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
    const label = sentinelAction === 'inspect' ? 'sentinel inspect' : 'sentinel status';
    if (sentinelAction === 'inspect' && options['--all']) throw new Error('sentinel inspect accepts only --root, --package, --format and --agent-dir.');
    if (Object.keys(options).some(key => !['--package', '--format', '--agent-dir', '--root', '--all'].includes(key))) throw new Error(`${label} accepts only --root, --package, --format, --agent-dir and --all.`);
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
    // The assignment reader uses the resolved adj3 storage root, the same
    // default as the discussion service; no flag duplicates ADJACENT_STORAGE_ROOT.
    const storageRoot = resolveStorageRoot(process.env, os.homedir());
    const snapshot = await collectWorkspace({ roots, packages, enrollmentErrors, discovery, indexDir: path.join(agentDir, 'spec-runtime'), agentDir, scope, includeInactive: options['--all'] === true, storageRoot, packagesOnly: packages.length > 0 });
    if (sentinelAction === 'inspect') {
      const row = (snapshot.assignments ?? []).find(item => item.assignment_id === sentinelInspectId);
      if (!row) throw new Error(`No observed assignment matches ${sentinelInspectId}.`);
      if (format === 'json') {
        await print(JSON.stringify({ assignment: row, assignment_coverage: snapshot.assignment_coverage }, null, 2));
        process.exit(0);
      }
      const assignmentLines = [
        `${publicHint(row.assignment_id)} · ${publicHint(row.display)} · recorded ${publicHint(row.recordedState) || 'unknown'} · observed ${publicHint(row.observedState) || 'unknown'}`,
        `coverage: ${publicHint(row.coverage)}${row.coverageReasons?.length ? ` (${row.coverageReasons.map(publicHint).join(', ')})` : ''} · quiet ${row.quiet === true} · control none`,
        `safe action: ${publicHint(row.safeAction ?? row.nextAction ?? 'no action')}`,
        ...(row.attention ?? []).map(item => `attention: ${publicHint(item)}`),
        `assignment coverage: ${publicHint(snapshot.assignment_coverage?.state ?? 'unknown')}${snapshot.assignment_coverage?.reasons?.length ? ` (${snapshot.assignment_coverage.reasons.map(publicHint).join(', ')})` : ''}`,
      ];
      await print(assignmentLines.join('\n'));
      process.exit(0);
    }
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
