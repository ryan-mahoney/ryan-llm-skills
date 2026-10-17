// EV-14 test-only fixture: a real, caller-retained OverlayFS test bed.
//
// This module is not production code. It builds a disposable canonical Git
// repository, exports its base tree into a frozen `lower` directory through
// `git archive` + `tar` (never by copying `.git`), creates sibling `upper`,
// `work` and `merged` directories on the same filesystem, clones a private
// bare Git directory for the merged worktree, and wires the real ownership
// registry and overlay phase API from the production modules.
//
// It never mounts an overlay and never writes to `merged` through Git: only a
// consumer-driven phase may do that. Nothing here cleans up; the caller owns
// retention of the whole fixture root.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, sep } from 'node:path';

import { createOwnership } from './ownership.mjs';
import { createOverlayPhases } from './overlay.mjs';

const GIT_TIMEOUT_MS = 30000;

export function makeLinuxOverlayFixture(root) {
  if (typeof root !== 'string' || root === '') throw new Error('makeLinuxOverlayFixture requires a retention root');
  mkdirSync(root, { recursive: true });
  const fixtureRoot = mkdtempSync(join(root, 'wave-linux-overlay-'));

  const repo = join(fixtureRoot, 'repo');
  const lower = join(fixtureRoot, 'lower');
  const upper = join(fixtureRoot, 'upper');
  const work = join(fixtureRoot, 'work');
  const merged = join(fixtureRoot, 'merged');
  const gitDir = join(fixtureRoot, 'git');
  const ownershipRoot = join(fixtureRoot, 'ownership');
  const archivePath = join(fixtureRoot, 'base.tar');

  const git = createGit(repo);

  // Canonical base repository. The user identity is local so fixture commits
  // never depend on (or write) the operator's Git configuration.
  mkdirSync(repo, { recursive: true });
  git('init');
  git('config', 'user.name', 'Wave Linux Fixture');
  git('config', 'user.email', 'wave-linux@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  // `git archive` honours tar.umask when stamping entry modes. Pin it locally so
  // archived tracked files keep 0644 and executable files keep 0755 regardless
  // of the host's Git defaults.
  git('config', 'tar.umask', '0022');

  writeTrackedFile(join(repo, 'tracked.txt'), 'base\n', 0o644);
  writeTrackedFile(join(repo, 'bin/run.sh'), '#!/bin/sh\necho base\n', 0o755);
  writeTrackedFile(join(repo, 'lowerdir/a.txt'), 'a\n', 0o644);
  writeTrackedFile(join(repo, 'deleted.txt'), 'delete\n', 0o644);
  writeTrackedFile(join(repo, '.gitignore'), '*.log\n', 0o644);

  git('add', '--all');
  git('commit', '--no-gpg-sign', '--message', 'base');
  const baseCommit = git('rev-parse', 'HEAD');

  // Frozen lower: the committed base tree only, with modes preserved by tar.
  // Nothing from `.git` is copied, so the lower layer is a plain file tree.
  mkdirSync(lower, { recursive: true });
  git('archive', '--format=tar', '--output', archivePath, baseCommit);
  runTar(['-xpf', archivePath, '-C', lower]);

  mkdirSync(upper, { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(merged, { recursive: true });

  // Private Git directory for the merged worktree. The bare clone shares no
  // objects or refs with the canonical repository (`--no-local`).
  runGit(fixtureRoot, 'clone', '--bare', '--no-local', repo, gitDir);
  gitAt(gitDir, 'config', 'core.bare', 'false');
  gitAt(gitDir, 'config', 'core.worktree', merged);
  gitAt(gitDir, 'config', 'user.name', 'Wave Linux Fixture');
  gitAt(gitDir, 'config', 'user.email', 'wave-linux@example.invalid');

  const ownership = createOwnership({ registryRoot: ownershipRoot });
  const phases = createOverlayPhases({ ownership });

  return {
    root: fixtureRoot,
    repo,
    baseCommit,
    lower,
    upper,
    work,
    merged,
    gitDir,
    ownership,
    phases,
    coordinator: {
      session: 'linux-overlay-fixture',
      epoch: 1,
      pid: process.pid,
      started_at: processStartTime(process.pid),
    },
    lowerDigest: digestTree(lower),
    git,
  };
}

function createGit(cwd) {
  return (...args) => runGit(cwd, ...args);
}

function runGit(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: cleanGitEnv() });
  if (result.error) throw new Error(`git ${args.join(' ')} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${(result.stderr || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

function gitAt(gitDir, ...args) {
  return runGit(process.cwd(), '-C', gitDir, ...args);
}

function runTar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (result.error) throw new Error(`tar ${args.join(' ')} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`tar ${args.join(' ')} exited ${result.status}: ${(result.stderr || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

// Fixture commits are isolated from host-level Git configuration that would
// change identity, signing or hooks.
function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  env.PATH = env.PATH || [process.env.PATH, '/usr/bin', '/bin'].filter(Boolean).join(delimiter);
  return env;
}

function writeTrackedFile(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
}

// SHA-256 over the sorted relative path, mode, type and content of every child
// entry below `root`, directories included. The ordering and framing are fixed
// so a re-read of the same tree always yields the same digest.
function digestTree(root) {
  const hash = createHash('sha256');
  for (const entry of collectEntries(root)) {
    hash.update(`${entry.type}\0${entry.mode.toString(8)}\0${entry.path}\0`, 'utf8');
    if (entry.type === 'file') hash.update(readFileSync(entry.full));
    else if (entry.type === 'symlink') hash.update(readlinkSync(entry.full));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function collectEntries(root) {
  const entries = [];

  function walk(directory) {
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      const full = join(directory, child.name);
      const stats = lstatSync(full);
      const path = relative(root, full).split(sep).join('/');
      const type = child.isDirectory() ? 'dir' : child.isSymbolicLink() ? 'symlink' : 'file';
      entries.push({ full, path, mode: stats.mode & 0o7777, type });
      if (child.isDirectory()) walk(full);
    }
  }

  walk(root);
  return entries;
}

// The ownership registry records the human-readable kernel start time that
// `ps -o lstart=` reports, so the fixture coordinator carries the same shape.
function processStartTime(pid) {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.error) throw new Error(`ps -o lstart= -p ${pid} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`ps -o lstart= -p ${pid} exited ${result.status}: ${(result.stderr || '').trim()}`);
  }
  const startedAt = (result.stdout || '').trim();
  if (startedAt === '') throw new Error(`ps -o lstart= -p ${pid} returned no start time`);
  return startedAt;
}
