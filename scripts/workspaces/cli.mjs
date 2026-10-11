#!/usr/bin/env node
// Single workspace CLI. Strict argv handling runs completely before any store
// mutation; refusals print one {error,path} JSON object to stderr and exit 1.
// Reads never create anything and no target repository is ever written.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  addArtifact,
  addMaterial,
  applyKitEdit,
  createWorkspace,
  fetchWorkspace,
  listWorkspaces,
  resolveStorageRoot,
  setupStorage,
  storageStatus,
} from './store.mjs';
import { formatScalar, planKitEdit } from './kit.mjs';

const USAGE = `Usage: node scripts/workspaces/cli.mjs <command> [options]

Commands:
  status                                                     Report the storage root boundary without writing
  setup                                                      Create a missing root and projects/ directory
  list                                                       List workspace kits and invalid manifests
  show ID                                                    Read one workspace and its associations
  create ID [--name NAME]                                    Publish an empty kit.yaml
  add-repo ID --id RID --path ABS [--role ROLE] [--remote URL] [--apply]
  set-role ID --id RID --role ROLE [--apply]
  add-brief ID --title TITLE [--from FILE]
  add-note ID --title TITLE [--from FILE]
  add-artifact ID (--repository RID --path REL | --url URL) [--title T] [--note N]

Global options:
  --root PATH   Override ADJACENT_STORAGE_ROOT (default ~/Documents/adjacent-storage)
  --json        Print the structured result object instead of human text`;

const COMMANDS = {
  status: { positionals: 0, flags: {} },
  setup: { positionals: 0, flags: {} },
  list: { positionals: 0, flags: {} },
  show: { positionals: 1, flags: {} },
  create: { positionals: 1, flags: { '--name': 'value' } },
  'add-repo': {
    positionals: 1,
    flags: { '--id': 'value', '--path': 'value', '--role': 'value', '--remote': 'value', '--apply': 'boolean' },
  },
  'set-role': { positionals: 1, flags: { '--id': 'value', '--role': 'value', '--apply': 'boolean' } },
  'add-brief': { positionals: 1, flags: { '--title': 'value', '--from': 'value' } },
  'add-note': { positionals: 1, flags: { '--title': 'value', '--from': 'value' } },
  'add-artifact': {
    positionals: 1,
    flags: { '--repository': 'value', '--path': 'value', '--url': 'value', '--title': 'value', '--note': 'value' },
  },
};
const GLOBAL_FLAGS = { '--root': 'value', '--json': 'boolean' };

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command.startsWith('-')) throw new UsageError(USAGE);
  if (!Object.hasOwn(COMMANDS, command)) throw new UsageError(`Unknown command: ${command}\n\n${USAGE}`);
  const spec = COMMANDS[command];
  const flags = { ...GLOBAL_FLAGS, ...spec.flags };
  const options = Object.create(null);
  const positionals = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith('-')) {
      const kind = flags[token];
      if (kind === undefined) throw new UsageError(`Unknown option: ${token}`);
      if (token in options) throw new UsageError(`Duplicate option: ${token}`);
      if (kind === 'boolean') {
        options[token] = true;
        continue;
      }
      const value = rest[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new UsageError(`Missing value for ${token}`);
      }
      options[token] = value;
      index += 1;
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length !== spec.positionals) {
    throw new UsageError(positionals.length < spec.positionals
      ? `${command} requires a workspace id`
      : `${command} accepts no positional arguments`);
  }
  if (command === 'add-repo') {
    for (const required of ['--id', '--path']) {
      if (!(required in options)) throw new UsageError(`add-repo requires ${required}`);
    }
    if (!isAbsolute(options['--path'])) {
      throw new UsageError('add-repo requires --path to be an absolute path');
    }
  }
  if (command === 'set-role') {
    for (const required of ['--id', '--role']) {
      if (!(required in options)) throw new UsageError(`set-role requires ${required}`);
    }
  }
  if (command === 'add-brief' || command === 'add-note') {
    if (!('--title' in options)) throw new UsageError(`${command} requires --title`);
  }
  if (command === 'add-artifact') {
    const repository = '--repository' in options;
    const artifactPath = '--path' in options;
    const url = '--url' in options;
    if (url) {
      if (repository || artifactPath) {
        throw new UsageError('add-artifact accepts either --url or --repository with --path, not both');
      }
    } else if (repository) {
      if (!artifactPath) throw new UsageError('add-artifact requires --path with --repository');
    } else {
      throw new UsageError('add-artifact requires --url or --repository with --path');
    }
  }
  return { command, options, positionals };
}

function write(stream, text) {
  return new Promise((resolvePromise, rejectPromise) => {
    stream.write(text, (error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

const print = (text) => write(process.stdout, text.endsWith('\n') ? text : `${text}\n`);
const describe = (error) => (error instanceof Error ? error.message : String(error));

async function fail(error, path) {
  process.exitCode = 1;
  try {
    await write(process.stderr, `${JSON.stringify({ error: describe(error), path: String(path ?? '') })}\n`);
  } catch {
    // stderr is unavailable; the exit code still records the refusal.
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Material comes from --from when given; stdin is read only otherwise, so a
// piped stdin can never hang or leak into a file-sourced add.
async function readContent(options) {
  return options['--from'] !== undefined ? readFile(options['--from'], 'utf8') : readStdin();
}

function artifactOptions(options) {
  const shared = {};
  if (options['--title'] !== undefined) shared.title = options['--title'];
  if (options['--note'] !== undefined) shared.note = options['--note'];
  if (options['--url'] !== undefined) return { kind: 'url', target: options['--url'], ...shared };
  return {
    kind: 'repository',
    target: { repository_id: options['--repository'], path: options['--path'] },
    ...shared,
  };
}

const stripBreak = (line) => line.replace(/[\r\n]+$/, '');

async function printPlan(header, plan, options) {
  if (options['--json'] === true) {
    await print(JSON.stringify(plan));
    return;
  }
  const lines = [header, `--- before (line ${plan.hunk.start_line})`];
  for (const line of plan.hunk.before_lines) lines.push(`- ${stripBreak(line)}`);
  lines.push('--- after');
  for (const line of plan.hunk.after_lines) lines.push(`+ ${stripBreak(line)}`);
  await print(lines.join('\n'));
}

// Dry-run prints the planned hunk and exits without writing; --apply hands the
// same plan to the exclusive-writer store contract.
async function kitEdit(command, root, id, options) {
  const detail = await fetchWorkspace(root, id);
  const current = await readFile(join(detail.directory, 'kit.yaml'), 'utf8');
  let plan;
  let header;
  if (command === 'add-repo') {
    const repository = { id: options['--id'], path: options['--path'] };
    if (options['--role'] !== undefined) repository.role = options['--role'];
    if (options['--remote'] !== undefined) repository.remote = options['--remote'];
    plan = planKitEdit(current, { kind: 'add-repository', repository });
    header = `add-repo ${id} --id ${repository.id} --path ${repository.path}`;
  } else {
    plan = planKitEdit(current, { kind: 'set-role', repository_id: options['--id'], role: options['--role'] });
    header = `set-role ${id} --id ${options['--id']} --role ${options['--role']}`;
  }
  await printPlan(header, plan, options);
  if (options['--apply'] !== true) return undefined;
  return applyKitEdit(root, id, plan);
}

async function execute(command, root, options, positionals) {
  switch (command) {
    case 'status': return storageStatus(root);
    case 'setup': return setupStorage(root);
    case 'list': return listWorkspaces(root);
    case 'show': return fetchWorkspace(root, positionals[0]);
    case 'create': {
      if (options['--name'] !== undefined) formatScalar(options['--name']);
      return createWorkspace(root, { id: positionals[0], name: options['--name'] });
    }
    case 'add-brief':
      return addMaterial(root, positionals[0], {
        kind: 'brief', title: options['--title'], content: await readContent(options),
      });
    case 'add-note':
      return addMaterial(root, positionals[0], {
        kind: 'note', title: options['--title'], content: await readContent(options),
      });
    case 'add-artifact': return addArtifact(root, positionals[0], artifactOptions(options));
    case 'add-repo':
    case 'set-role': return kitEdit(command, root, positionals[0], options);
    default: throw new UsageError(`Unknown command: ${command}`);
  }
}

function human(command, result) {
  switch (command) {
    case 'status': {
      const lines = [`status ${result.status}`, result.root];
      for (const entry of result.errors ?? []) lines.push(`${entry.path}: ${entry.message}`);
      return lines.join('\n');
    }
    case 'setup': return `root ${result.root}\nprojects ${result.projects}`;
    case 'list': {
      const lines = [`${result.valid.length} workspace(s)`];
      for (const entry of result.valid) lines.push(`${entry.id}\t${entry.directory}`);
      for (const entry of result.invalid) lines.push(`invalid\t${entry.directory}: ${(entry.errors ?? []).join('; ')}`);
      for (const entry of result.errors ?? []) lines.push(`${entry.path}: ${entry.message}`);
      return lines.join('\n');
    }
    case 'show': return `${result.id} (${result.name}) at ${result.directory}`;
    case 'create': return `created ${result.id} at ${result.directory}`;
    default:
      if (result && typeof result === 'object' && 'backup' in result) {
        return `applied ${result.path}\nbackup ${result.backup}`;
      }
      if (result && typeof result === 'object' && 'path' in result) return `added ${result.path}`;
      return JSON.stringify(result);
  }
}

async function printResult(command, result, options) {
  if (result === undefined) return;
  if (options['--json'] === true) {
    await print(JSON.stringify(result));
    return;
  }
  await print(human(command, result));
}

function usagePath(argv) {
  const index = argv.indexOf('--root');
  return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : '';
}

function errorPath(parsed, root, workspacePath) {
  if ((parsed.command === 'add-brief' || parsed.command === 'add-note') && parsed.options['--from'] !== undefined) {
    return parsed.options['--from'];
  }
  if (parsed.command === 'status' || parsed.command === 'setup' || parsed.command === 'list') return root;
  return workspacePath;
}

async function main() {
  const argv = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    await fail(error, error instanceof UsageError ? usagePath(argv) : '');
    return;
  }
  let root;
  try {
    root = parsed.options['--root'] !== undefined
      ? resolve(parsed.options['--root'])
      : resolveStorageRoot(process.env, homedir());
  } catch (error) {
    await fail(error, process.env.ADJACENT_STORAGE_ROOT ?? '');
    return;
  }
  const workspacePath = parsed.positionals[0] !== undefined
    ? join(root, 'projects', parsed.positionals[0])
    : root;
  try {
    const result = await execute(parsed.command, root, parsed.options, parsed.positionals);
    await printResult(parsed.command, result, parsed.options);
  } catch (error) {
    await fail(error, error?.backup ?? errorPath(parsed, root, workspacePath));
  }
}

try {
  await main();
} catch (error) {
  await fail(error, '');
}
