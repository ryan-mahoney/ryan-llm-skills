#!/usr/bin/env bun

// One explicit first-index path. The engine remains offline-only: this script
// copies existing pinned assets into a location outside Git before invoking it.
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rename, rm, chmod, lstat } from 'node:fs/promises';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_MODELS = join(homedir(), '.local', 'share', 'agent-repo-search', 'models');
const DEFAULT_STATE = join(homedir(), '.cache', 'agent-repo-search');
const MODEL_ID = 'jinaai/jina-embeddings-v2-base-code';

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (key === '--help' && argv.length === 1) return { help: true };
    if (!['--root', '--models-from', '--models-to', '--state', '--spec-use'].includes(key)
      || !argv[i + 1] || argv[i + 1].startsWith('--') || values[key] !== undefined) {
      throw new Error(`Invalid or missing value for ${key ?? 'option'}`);
    }
    values[key] = argv[i + 1];
  }
  if (values['--spec-use'] !== undefined && values['--spec-use'] !== 'on') {
    throw new Error('--spec-use accepts only on');
  }
  return {
    root: resolve(values['--root'] ?? process.cwd()),
    from: values['--models-from'] ? resolve(values['--models-from']) : process.env.REPO_SEARCH_MODELS,
    to: resolve(values['--models-to'] ?? DEFAULT_MODELS),
    state: resolve(values['--state'] ?? DEFAULT_STATE),
    specUse: values['--spec-use'] === 'on',
  };
}

function helperDir() {
  const local = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'repo-search');
  const candidates = [process.env.REPO_SEARCH_HELPER, join(homedir(), '.agents', 'scripts', 'repo-search'), local];
  const found = candidates.find((candidate) => candidate && existsSync(join(candidate, 'cli.mjs')));
  if (!found) throw new Error('Repo-search helper is unavailable; install the optional repo-search package first.');
  return realpathSync(found);
}

function nearestExisting(path) {
  let candidate = path;
  while (!existsSync(candidate)) candidate = dirname(candidate);
  if (!statSync(candidate).isDirectory()) throw new Error(`Destination ancestor is not a directory: ${candidate}`);
  return realpathSync(candidate);
}

function assertOutsideGit(path, label) {
  const ancestor = nearestExisting(path);
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', ancestor, 'rev-parse', '--absolute-git-dir'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error) throw new Error(`Cannot check ${label} for Git containment: ${result.error.message}`);
  if (result.status === 0) throw new Error(`${label} must be outside Git repositories: ${path}`);
  if (result.status !== 128) throw new Error(`Cannot check ${label} for Git containment: ${result.stderr.trim()}`);
}

async function assertOrdinaryDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be an ordinary directory: ${path}`);
  }
}

function cli(helper, command, options = []) {
  const result = spawnSync('node', [join(helper, 'cli.mjs'), command, ...options, '--json'], {
    encoding: 'utf8', timeout: command === 'build' ? 31 * 60 * 1000 : 11 * 60 * 1000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  let receipt;
  try { receipt = JSON.parse(result.stdout.trim()); }
  catch { throw new Error(`${command} returned no valid receipt: ${result.stderr.trim()}`); }
  if (result.status !== 0 || receipt.status !== 'ok') {
    throw new Error(`${command} failed: ${receipt.reason ?? receipt.message ?? result.stderr.trim() ?? 'unknown'}`);
  }
  return receipt;
}

async function prepareModel({ from, to, helper }) {
  assertOutsideGit(to, 'Model destination');
  await mkdir(to, { recursive: true, mode: 0o700 });
  await assertOrdinaryDirectory(to, 'Model destination');
  const canonicalTo = await realpath(to);
  assertOutsideGit(canonicalTo, 'Model destination');
  const { verifyModel, PINNED_CODE_MODEL_ASSETS } = await import(pathToFileURL(join(helper, 'core', 'codeModelAssets.ts')).href);

  if (existsSync(join(canonicalTo, MODEL_ID))) {
    await assertOrdinaryDirectory(join(canonicalTo, 'jinaai'), 'Model namespace');
    await assertOrdinaryDirectory(join(canonicalTo, MODEL_ID), 'Model directory');
    await verifyModel(canonicalTo);
    return canonicalTo;
  }
  if (!from) throw new Error('No existing model root was supplied; pass --models-from or set REPO_SEARCH_MODELS.');
  const canonicalFrom = await realpath(resolve(from));
  await verifyModel(canonicalFrom);

  const stagingRoot = await mkdtemp(join(canonicalTo, '.model-staging-'));
  try {
    const stagingModel = join(stagingRoot, MODEL_ID);
    await mkdir(join(stagingModel, 'onnx'), { recursive: true, mode: 0o700 });
    for (const asset of PINNED_CODE_MODEL_ASSETS) {
      const destination = join(stagingModel, asset.path);
      await copyFile(join(canonicalFrom, MODEL_ID, asset.path), destination);
      await chmod(destination, 0o600);
    }
    await verifyModel(stagingRoot);
    const namespaceDir = join(canonicalTo, 'jinaai');
    await mkdir(namespaceDir, { recursive: true, mode: 0o700 });
    await assertOrdinaryDirectory(namespaceDir, 'Model namespace');
    if (existsSync(join(canonicalTo, MODEL_ID))) {
      await verifyModel(canonicalTo);
    } else {
      await rename(stagingModel, join(canonicalTo, MODEL_ID));
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  return canonicalTo;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`Usage: bun --no-install setup.mjs [--root CHECKOUT] [--models-from ROOT] [--models-to ROOT] [--state ROOT] [--spec-use on]

--root         Git checkout to index (default: current checkout)
--models-from  Existing root containing jinaai/jina-embeddings-v2-base-code/
               (or set REPO_SEARCH_MODELS; omit after the external copy exists)
--models-to    External model copy (default: ~/.local/share/agent-repo-search/models)
--state        External index state (default: ~/.cache/agent-repo-search)
--spec-use on  Enable queries from spec tooling after the first build

Model and state destinations must be outside Git repositories. Model assets
are never downloaded; locked dependency installation may use the network.
`);
    return;
  }
  const helper = helperDir();
  const { resolveCheckout } = await import(pathToFileURL(join(helper, 'identity.mjs')).href);
  const checkout = await resolveCheckout(args.root);
  assertOutsideGit(args.state, 'Index state');
  if (existsSync(args.state)) await assertOrdinaryDirectory(args.state, 'Index state');
  process.stderr.write('Verifying local model assets...\n');
  const models = await prepareModel({ from: args.from, to: args.to, helper });
  const stateArgs = ['--state', args.state];
  process.stderr.write('Installing locked search dependencies...\n');
  cli(helper, 'install', ['--models', models, ...stateArgs]);
  const before = cli(helper, 'status', ['--root', checkout.root, ...stateArgs]);
  if (before.receipt.currentGenerationId === null) {
    process.stderr.write('Building the first checkout index...\n');
    cli(helper, 'build', ['--root', checkout.root, '--models', models, ...stateArgs]);
  } else if (before.receipt.availability !== 'ready') {
    throw new Error('An existing current index is unavailable; use an explicit reindex after diagnosis.');
  }
  if (args.specUse) {
    process.stderr.write('Enabling spec use...\n');
    cli(helper, 'configure', ['--root', checkout.root, '--spec-use', 'on', ...stateArgs]);
  }
  const final = cli(helper, 'status', ['--root', checkout.root, ...stateArgs]);
  if (!final.receipt.enrolled || final.receipt.availability !== 'ready') {
    throw new Error(`Index is not ready: ${final.receipt.availability}`);
  }
  process.stdout.write(`${JSON.stringify({ root: checkout.root, modelRoot: models, stateRoot: args.state,
    generation: final.receipt.currentGenerationId, specUse: final.receipt.specUse })}\n`);
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
