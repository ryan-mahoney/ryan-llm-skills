#!/usr/bin/env node
// Single workspace CLI. Strict argv handling runs completely before any store
// mutation; refusals print one {error,path} JSON object to stderr and exit 1.
// Reads never create anything and no target repository is ever written.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
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
import {
  attachAssignment,
  findAssignment,
  launchAssignment,
  listAssignments,
  locateAssignment,
  resolveAssignment,
} from './assignments.mjs';
import { canonicalPackage } from '../../pi/extensions/spec-runtime/runtime.mjs';
import { readCheckpointRecord, readInboxGuard } from '../../pi/extensions/spec-runtime/sentinel.mjs';
import { deliverOverseerMessage } from '../spec-observe/overseer-inbox.mjs';

const CLI_PATH = fileURLToPath(import.meta.url);

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
  launch ID --brief REL (--instructions TEXT | --instructions-file PATH) [--id UUID] [--target RID]
  locate ID --json                                           Reconcile and print one assignment envelope
  assignments [--workspace ID]                               List assignment envelopes
  attach ID                                                  Attach this terminal to a live assignment session
  takeover ID [--run RUN]                                    Deliver a coordinator hold, then attach when a TTY is present
  resume ID --hold ID [--run RUN]                            Deliver a release direction naming one retained hold

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
  launch: {
    positionals: 1,
    flags: {
      '--brief': 'value',
      '--skill': 'value',
      '--instructions': 'value',
      '--instructions-file': 'value',
      '--id': 'value',
      '--target': 'value',
      '--spec-package': 'value',
      '--provider': 'value',
      '--model': 'value',
      '--thinking': 'value',
      '--trust': 'value',
      '--authority': 'value',
      '--workflow': 'value',
      '--attempt': 'value',
      '--supersedes': 'value',
      '--tmux-socket': 'value',
      '--tmux-session': 'value',
      '--pi-path': 'value',
      '--digest': 'value',
      '--yes': 'boolean',
    },
  },
  locate: { positionals: 1, flags: {} },
  assignments: { positionals: 0, flags: { '--workspace': 'value' } },
  attach: { positionals: 1, flags: {} },
  takeover: { positionals: 1, flags: { '--run': 'value' } },
  resume: { positionals: 1, flags: { '--hold': 'value', '--run': 'value' } },
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
  if (command === 'launch') {
    if (!('--brief' in options)) throw new UsageError('launch requires --brief');
    const hasInstructions = '--instructions' in options;
    const hasInstructionsFile = '--instructions-file' in options;
    if (!hasInstructions && !hasInstructionsFile) {
      throw new UsageError('launch requires --instructions or --instructions-file');
    }
    if (hasInstructions && hasInstructionsFile) {
      throw new UsageError('launch accepts either --instructions or --instructions-file, not both');
    }
  }
  if (command === 'resume' && !('--hold' in options)) throw new UsageError('resume requires --hold');
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

// Launch preview and confirmation. Resolution is read-only; the confirmation
// binds the displayed contract digest and the exact resolved result is handed
// to launchAssignment, so the approved brief bytes and argv cannot change
// between preview and spawn.
async function buildLaunchInput(root, workspaceId, options) {
  const instructions = options['--instructions-file'] !== undefined
    ? await readFile(options['--instructions-file'], 'utf8')
    : options['--instructions'];
  return {
    assignment_id: options['--id'] ?? randomUUID(),
    workspace_id: workspaceId,
    storageRoot: root,
    home: homedir(),
    brief: options['--brief'],
    skill: options['--skill'] ?? 'general',
    instructions,
    target: options['--target'],
    specPackage: options['--spec-package'],
    workflow_id: options['--workflow'],
    publication_authority: options['--authority'] ?? 'none',
    attempt_kind: options['--attempt'] ?? 'initial',
    supersedes: options['--supersedes'],
    provider: options['--provider'],
    model: options['--model'],
    thinking: options['--thinking'],
    project_trust: options['--trust'],
    tmux_socket: options['--tmux-socket'],
    tmux_session: options['--tmux-session'],
    pi_path: options['--pi-path'],
  };
}

function previewObject(preview) {
  const { record } = preview;
  return {
    assignment_id: record.assignment_id,
    workspace_id: record.workspace_id,
    workspace_directory: record.workspace_directory,
    storage_root: record.storage_root,
    execution_dir: record.execution_dir,
    repository_id: record.repository_id,
    spec_package: record.spec_package,
    attention: record.attention ?? [],
    brief: record.brief,
    brief_sha256: record.brief_sha256,
    brief_snapshot: record.brief_snapshot,
    skill: record.skill,
    skill_path: record.skill_path,
    instructions: record.instructions,
    provider: record.provider,
    model: record.model,
    thinking: record.thinking,
    project_trust: record.project_trust,
    publication_authority: record.publication_authority,
    publication_authority_note: 'grants no merge/deploy',
    workflow_id: record.workflow_id,
    attempt_kind: record.attempt_kind,
    supersedes: record.supersedes,
    contract_digest: preview.contractDigest,
    tmux_socket: record.tmux_socket,
    tmux_session: record.tmux_session,
    coordination_database: record.coordination_database,
    pi_session_dir: record.pi_session_dir,
    pi_path: record.pi_path,
    piArgs: preview.piArgs,
  };
}

async function printPreview(preview, options) {
  const view = previewObject(preview);
  if (options['--json'] === true) {
    await print(JSON.stringify(view));
    return;
  }
  const lines = ['launch preview'];
  for (const [key, value] of Object.entries(view)) {
    if (key === 'piArgs' || key === 'publication_authority_note') continue;
    if (key === 'attention') {
      for (const entry of value) lines.push(`attention ${entry}`);
      continue;
    }
    if (key === 'publication_authority') {
      lines.push(`${key} ${value} (grants no merge/deploy)`);
      continue;
    }
    lines.push(`${key} ${value === null || value === undefined ? 'null' : value}`);
  }
  lines.push('argv:');
  for (const arg of view.piArgs) lines.push(`  ${arg}`);
  await print(lines.join('\n'));
}

async function confirmLaunch(preview, options) {
  if (options['--digest'] !== undefined) {
    if (options['--digest'] !== preview.contractDigest) {
      throw new Error(`digest mismatch: reviewed ${options['--digest']} does not match resolved ${preview.contractDigest}`);
    }
    return;
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error('launch requires --digest when stdin and stdout are not a TTY');
  }
  if (options['--yes'] !== true) throw new Error('interactive launch requires --yes');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = await rl.question('Type yes to launch: ');
  } finally {
    rl.close();
  }
  if (answer.trim() !== 'yes') throw new Error('launch confirmation refused: expected "yes"');
}

async function printLaunchResult(record, preview, options) {
  if (options['--json'] === true) {
    await print(JSON.stringify({ record, digest: preview.contractDigest, argv: preview.piArgs }));
    if (record.state !== 'live') process.exitCode = 1;
    return;
  }
  if (record.state === 'live') {
    await print([
      `launched ${record.assignment_id}`,
      `digest ${preview.contractDigest}`,
      `socket ${record.tmux_socket}`,
      `session ${record.tmux_session}`,
      `execution_dir ${record.execution_dir}`,
    ].join('\n'));
    return;
  }
  // A retained reservation is not a confirmed live launch: report the
  // returned state and attention and exit non-success without deleting the
  // durable reservation. Identical-ID repeats still return without a spawn.
  const lines = [
    `launch incomplete ${record.assignment_id}`,
    `state ${record.state}`,
    `digest ${preview.contractDigest}`,
    `socket ${record.tmux_socket}`,
    `session ${record.tmux_session}`,
    `execution_dir ${record.execution_dir}`,
  ];
  for (const entry of record.attention ?? []) lines.push(`attention ${entry}`);
  await print(lines.join('\n'));
  process.exitCode = 1;
}

async function launchCommand(root, workspaceId, options) {
  const input = await buildLaunchInput(root, workspaceId, options);
  const preview = await resolveAssignment(input);
  await printPreview(preview, options);
  await confirmLaunch(preview, options);
  const record = await launchAssignment(input, {
    expectedDigest: preview.contractDigest,
    resolved: preview,
  });
  await printLaunchResult(record, preview, options);
}

// Stable assignment envelope shared by locate and assignments. attach_command
// is a round-trippable argv array naming this exact CLI and root.
function assignmentEnvelope(root, record) {
  return {
    record,
    attach_command: ['node', CLI_PATH, 'attach', record.assignment_id, '--root', root],
    attention: record.attention ?? [],
  };
}

function humanEnvelope(envelope) {
  const { record } = envelope;
  const lines = [
    `${record.assignment_id} ${record.state} ${record.workspace_id}`,
    `execution_dir ${record.execution_dir}`,
    `socket ${record.tmux_socket}`,
    `session ${record.tmux_session}`,
    `attach ${envelope.attach_command.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')}`,
  ];
  for (const entry of envelope.attention) lines.push(`attention ${entry}`);
  return lines.join('\n');
}

async function locateCommand(root, id, options) {
  const record = await locateAssignment(root, id);
  const envelope = assignmentEnvelope(root, record);
  if (options['--json'] === true) {
    await print(JSON.stringify(envelope));
    return;
  }
  await print(humanEnvelope(envelope));
}

async function assignmentsCommand(root, options) {
  const records = await listAssignments(root, options['--workspace'] ?? null);
  const envelopes = records.map((record) => assignmentEnvelope(root, record));
  if (options['--json'] === true) {
    await print(JSON.stringify(envelopes));
    return;
  }
  if (envelopes.length === 0) {
    await print('no assignments');
    return;
  }
  await print(envelopes.map(humanEnvelope).join('\n\n'));
}

async function attachCommand(root, id) {
  const { exitCode, signal } = await attachAssignment(root, id, {
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    stdio: 'inherit',
  });
  process.exitCode = signal != null ? 1 : (exitCode ?? 1);
}

// Takeover/resume reuse the step-5 exclusive writer and the retained guard
// projections. A hold is published before any attach; a resume direction never
// releases, archives or edits anything and always waits for the coordinator's
// hash-bound applied outcome.
const TAKEOVER_SAFE_BOUNDARY = 'A delivered hold blocks automatic continuation only once the coordinator observes it; effects already in flight and the running process are not stopped by this command.';

const shellWords = (args) => args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');

function takeoverTty() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function attachHintArgs(root, id) {
  return ['node', CLI_PATH, 'attach', id, '--root', root];
}

function specPackageOrNull(record) {
  return typeof record.spec_package === 'string' && record.spec_package !== '' ? record.spec_package : null;
}

// The recorded workflow id is authoritative: --run may fill a missing record
// but never override a differing one.
function resolveRun(record, requested) {
  const recorded = typeof record.workflow_id === 'string' && record.workflow_id !== '' ? record.workflow_id : null;
  if (requested !== undefined && recorded !== null && requested !== recorded) {
    throw new Error(`--run ${requested} does not match the recorded workflow_id ${recorded}`);
  }
  const run = requested ?? recorded;
  if (run === null) throw new Error('assignment has no recorded workflow_id; pass --run');
  return run;
}

function retainedCheckpoint(packagePath, run, command) {
  const checkpoint = readCheckpointRecord(packagePath, run);
  if (checkpoint === null || checkpoint.package !== packagePath || checkpoint.workflow_id !== run) {
    throw new Error(`${command} requires a retained checkpoint for run ${run} in ${packagePath}`);
  }
  return checkpoint;
}

async function takeoverCommand(root, id, options) {
  const record = await findAssignment(root, id);
  const declared = specPackageOrNull(record);
  const tty = takeoverTty();
  const attach_command = attachHintArgs(root, id);

  if (declared === null) {
    const result = {
      assignment_id: id,
      takeover: 'attach-only',
      spec_package: null,
      run: null,
      hold: null,
      attached: false,
      attach_command,
      note: 'no spec package: no automatic actor. Attach only; no inbox message was written.',
    };
    if (!tty) return result;
    await printResult('takeover', result, options);
    const { exitCode, signal } = await attachAssignment(root, id, { isTTY: true, stdio: 'inherit' });
    process.exitCode = signal != null ? 1 : (exitCode ?? 1);
    return undefined;
  }

  const packagePath = canonicalPackage(declared).packagePath;
  const run = resolveRun(record, options['--run']);
  retainedCheckpoint(packagePath, run, 'takeover');
  const delivery = await deliverOverseerMessage(packagePath, {
    run,
    sender: 'operator',
    audience: 'coordinator',
    kind: 'hold',
    body: `Operator takeover for assignment ${id}: hold delivered before any terminal attach.`,
  });
  const result = {
    assignment_id: id,
    takeover: 'delivered',
    spec_package: packagePath,
    run,
    hold: { id: delivery.id, path: delivery.path, sha256: delivery.sha256, status: delivery.status },
    attached: false,
    attach_command,
    safe_boundary: TAKEOVER_SAFE_BOUNDARY,
    note: delivery.status === 'delivered'
      ? 'hold delivered; release only through resume plus a coordinator applied outcome bound to both hashes'
      : 'hold publication is unconfirmed; no attach was attempted and no second original was written',
  };
  if (delivery.status !== 'delivered') {
    process.exitCode = 1;
    return result;
  }
  if (!tty) return result;
  // Print the delivery receipt before the attach client takes over stdio.
  await printResult('takeover', result, options);
  try {
    const { exitCode, signal } = await attachAssignment(root, id, { isTTY: true, stdio: 'inherit' });
    process.exitCode = signal != null ? 1 : (exitCode ?? 1);
  } catch (error) {
    await printResult('takeover', {
      ...result,
      attached: false,
      attach_error: describe(error),
      note: 'attach failed after hold delivery; the message is retained and remains held pending',
    }, options);
    process.exitCode = 0;
  }
  return undefined;
}

async function resumeCommand(root, id, options) {
  const record = await findAssignment(root, id);
  const declared = specPackageOrNull(record);
  if (declared === null) throw new Error('resume requires an assignment with a spec package');
  const packagePath = canonicalPackage(declared).packagePath;
  const run = resolveRun(record, options['--run']);
  retainedCheckpoint(packagePath, run, 'resume');
  const holdId = options['--hold'];
  const guard = readInboxGuard(packagePath);
  const hold = (guard.items ?? []).find((item) => item.id === holdId && item.kind === 'hold'
    && item.run === run && (item.state === 'blocking' || item.state === 'held'));
  if (!hold) throw new Error(`no retained kind:hold original ${holdId} for run ${run} in ${packagePath}`);
  const delivery = await deliverOverseerMessage(packagePath, {
    run,
    sender: 'operator',
    audience: 'coordinator',
    kind: 'direction',
    body: `Release requested for hold ${hold.id} (sha256 ${hold.sha256}). The hold is released only after the coordinator records an applied outcome bound to both hashes.`,
  });
  return {
    assignment_id: id,
    resume: 'requested',
    spec_package: packagePath,
    run,
    hold: { id: hold.id, sha256: hold.sha256, directory: hold.directory, state: hold.state },
    direction: { id: delivery.id, path: delivery.path, sha256: delivery.sha256, status: delivery.status },
    released: false,
    note: delivery.status === 'delivered'
      ? 'release requested: waiting for the coordinator applied outcome; this command did not release the hold'
      : 'direction publication is unconfirmed; the hold remains and no release occurred',
  };
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
    case 'launch':
      await launchCommand(root, positionals[0], options);
      return undefined;
    case 'locate':
      await locateCommand(root, positionals[0], options);
      return undefined;
    case 'assignments':
      await assignmentsCommand(root, options);
      return undefined;
    case 'attach':
      await attachCommand(root, positionals[0]);
      return undefined;
    case 'takeover': return takeoverCommand(root, positionals[0], options);
    case 'resume': return resumeCommand(root, positionals[0], options);
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
    case 'takeover': {
      const lines = [`takeover ${result.assignment_id}`, `mode ${result.takeover}`,
        `spec_package ${result.spec_package ?? 'none'}`, `run ${result.run ?? 'none'}`];
      if (result.hold) lines.push(`hold ${result.hold.id} ${result.hold.status}`);
      if (result.hold) lines.push(`hold_path ${result.hold.path}`);
      if (result.safe_boundary) lines.push(`safe_boundary ${result.safe_boundary}`);
      if (result.attach_error) lines.push(`attach_error ${result.attach_error}`);
      lines.push(result.note);
      lines.push(`attach ${shellWords(result.attach_command)}`);
      return lines.join('\n');
    }
    case 'resume': return [`resume ${result.assignment_id}`, `run ${result.run}`,
      `hold ${result.hold.id} ${result.hold.state}`,
      `direction ${result.direction.id} ${result.direction.status}`, result.note].join('\n');
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
