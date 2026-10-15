// OverlayFS step workspace provisioning (step 4).
//
// This module turns one classified capability record plus one declared setup
// identity into an attempt-scoped workspace: a frozen lower layer materialized
// once per snapshot identity, a per-attempt upper/work/merged triple claimed
// exclusively through the ownership registry, private Git metadata that shares
// no object store with the canonical repository, and the explicit worktree
// fallback. The final kernel mount boundary is NOT executed here: only layer
// identities and staging directories are provisioned, and kernel OverlayFS
// behavior remains the EV-14 probe.
//
// Capability classification is never re-derived here: resolveBackend consumes
// the record produced by interpretProbeResult, so fallback is authorized only
// by a positive unavailable classification whose fallbackEligible flag is true.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { createOverlayPhases, retainLayer, validateLayers } from './overlay.mjs';

const GIT_RUN = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const SNAPSHOT_RECORD = 'snapshot.json';
const SNAPSHOT_VERSION = 1;
const RETENTION_REF_PREFIX = 'refs/waves/retained/';
const BACKEND_STATUSES = new Set(['supported', 'unavailable', 'blocked']);
const CAPABILITY_MODES = new Set(['auto', 'overlayfs', 'worktree']);
const ROOT_COMMANDS = new Set(['sudo', 'doas', 'apt-get', 'apt', 'dnf', 'yum', 'apk', 'pacman', 'zypper']);
const IDENTITY_FIELDS = ['lower', 'upper', 'work', 'merged', 'gitDir', 'baseCommit', 'snapshotId'];

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

function refusal(reason, detail) {
  const error = new Error(detail ? `${reason}: ${detail}` : reason);
  error.code = 'workspace-refusal';
  error.reason = reason;
  return error;
}

function refuse(reason, detail) {
  throw refusal(reason, detail);
}

// ---------------------------------------------------------------------------
// Shared argument and path helpers
// ---------------------------------------------------------------------------

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireAbsolutePath(value, label) {
  requireString(value, label);
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return normalize(value);
}

function requireAttemptId(value) {
  requireString(value, 'attemptId');
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new Error('attemptId must be a single path segment');
  }
  return value;
}

function normalizeTarget(target) {
  if (!target || typeof target !== 'object') throw new Error('target is required');
  return {
    worktree: requireAbsolutePath(target.worktree, 'target.worktree'),
    gitCommonDir: requireAbsolutePath(target.gitCommonDir, 'target.gitCommonDir'),
  };
}

// Canonicalize through the filesystem when possible and re-append a missing
// suffix otherwise, so a not-yet-created attempt path still compares on the
// same resolved identity as the canonical worktree a workspace may not nest in.
function canonicalPath(input) {
  const target = resolve(input);
  const missing = [];
  let current = target;
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return target;
      const parent = dirname(current);
      if (parent === current) return target;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// Snapshot identity is compared and hashed through one key-sorted
// serialization, so declaration order can never produce two identities for one
// identical setup.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashFileBytes(filePath) {
  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch {
    refuse('lockfile-missing', `declared lockfile cannot be read: ${filePath}`);
  }
  return createHash('sha256').update(bytes).digest('hex');
}

function gitText(args) {
  return execFileSync('git', args, GIT_RUN).trim();
}

function gitMaybe(args) {
  try {
    const value = gitText(args);
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function objectExists(repo, sha) {
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], GIT_RUN);
    return true;
  } catch {
    return false;
  }
}
// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

function capabilityRecord(capability) {
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) return null;
  if (!BACKEND_STATUSES.has(capability.status)) return null;
  if (typeof capability.reason !== 'string' || capability.reason.length === 0) return null;
  if (capability.status === 'unavailable' && typeof capability.fallbackEligible !== 'boolean') return null;
  return capability;
}

// Only a classified capability record authorizes a backend. An explicit
// worktree request is honored without consulting the probe; an automatic
// fallback requires positive unavailability with fallbackEligible; a blocked
// classification or an ineligible unavailability refuses instead of falling
// back (INV-4).
export function resolveBackend({ mode = 'auto', capability } = {}) {
  const selectedMode = CAPABILITY_MODES.has(mode) ? mode : 'auto';
  const classified = capabilityRecord(capability);
  if (!classified) refuse('capability-unknown', 'capability record is missing or malformed');
  if (selectedMode === 'worktree') {
    return Object.freeze({ backend: 'worktree', reason: 'explicit-worktree', mode: selectedMode, capability: classified });
  }
  if (classified.status === 'supported') {
    return Object.freeze({ backend: 'overlayfs', reason: 'overlay-supported', mode: selectedMode, capability: classified });
  }
  if (selectedMode === 'overlayfs') refuse('overlay-unavailable', classified.reason);
  if (classified.status === 'unavailable' && classified.fallbackEligible === true) {
    return Object.freeze({ backend: 'worktree', reason: classified.reason, mode: selectedMode, capability: classified });
  }
  refuse('capability-blocked', classified.reason);
}

// ---------------------------------------------------------------------------
// Setup identity and freeze checks
// ---------------------------------------------------------------------------

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeSetupPath(entry, index) {
  if (typeof entry !== 'string' || entry.length === 0) {
    refuse('setup-malformed', `lockfiles[${index}] must be a nonempty string`);
  }
  const normalized = [];
  for (const segment of entry.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      refuse('setup-malformed', `lockfiles[${index}] must be a canonical target-relative path with no escape: ${entry}`);
    }
    if (segment === '.git') {
      refuse('setup-malformed', `lockfiles[${index}] must not name .git: ${entry}`);
    }
    normalized.push(segment);
  }
  return normalized.join('/');
}

// Consume exactly the prepared index declaration: the literal "none" maps to
// the empty declaration, otherwise `{command: string, lockfiles: string[],
// environment: string[]}`. Anything else refuses with setup-malformed; no
// field is coerced or dropped. Environment entries are names only, never values.
function normalizeSetup(setup) {
  if (setup === 'none') return { command: '', lockfiles: [], environment: [] };
  if (!setup || typeof setup !== 'object' || Array.isArray(setup)) {
    refuse('setup-malformed', 'setup must be "none" or the prepared declaration object');
  }
  for (const key of Object.keys(setup)) {
    if (key !== 'command' && key !== 'lockfiles' && key !== 'environment') {
      refuse('setup-malformed', `setup carries an unknown field: ${key}`);
    }
  }
  const { command, lockfiles, environment } = setup;
  if (typeof command !== 'string' || command.trim().length === 0) {
    refuse('setup-malformed', 'setup.command must be a nonempty prepared shell command string');
  }
  if (!Array.isArray(lockfiles) || !Array.isArray(environment)) {
    refuse('setup-malformed', 'setup.lockfiles and setup.environment must be string arrays');
  }
  const seenPaths = new Set();
  const normalizedPaths = lockfiles.map((entry, index) => {
    const path = normalizeSetupPath(entry, index);
    if (seenPaths.has(path)) refuse('setup-malformed', `duplicate lockfile path: ${path}`);
    seenPaths.add(path);
    return path;
  });
  const seenNames = new Set();
  const names = environment.map((entry, index) => {
    if (typeof entry !== 'string' || !ENV_NAME_PATTERN.test(entry)) {
      refuse('setup-malformed', `environment[${index}] must be a valid variable name, never a value`);
    }
    if (seenNames.has(entry)) refuse('setup-malformed', `duplicate environment variable name: ${entry}`);
    seenNames.add(entry);
    return entry;
  });
  return { command, lockfiles: normalizedPaths, environment: names };
}

// The setup identity covers exactly what the frozen snapshot is bound to: the
// base commit plus the declared command plus the resolved lockfile paths with
// their bytes plus the environment names. `prepare` computes its snapshotId
// through this helper and a preparation receipt binds to the identical value,
// so the receipt cannot attest a different identity than the snapshot uses.
// normalizeSetup is idempotent, so re-consuming the declaration here never
// changes what the identity covers or which refusals fire first.
export function setupIdentity({ baseCommit, setup, targetRoot }) {
  const declared = normalizeSetup(setup);
  const lockfiles = declared.lockfiles.map(filePath => ({
    path: filePath,
    sha256: hashFileBytes(join(targetRoot, filePath)),
  }));
  const identity = {
    baseCommit,
    setup: {
      command: declared.command,
      lockfiles: [...lockfiles].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
      environment: [...declared.environment].sort(),
    },
  };
  return { identity, snapshotId: createHash('sha256').update(canonicalJson(identity)).digest('hex') };
}

// A validated staging input carries the prepared source tree at baseCommit
// plus the prepared dependency output. The frozen lower is always produced
// from a staging input - never by archiving the source commit straight into
// the final snapshot directory - so dependency-setup output has a path into
// the lower and the staged contents are validated and bound to the receipt
// before anything is published. The declared command is never executed here:
// step 6 owns contained setup execution; this run only accepts, validates and
// consumes the staging input.
function stagingEntries(root, prefix = '') {
  const entries = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (path.split('/').includes('.git')) {
      refuse('staging-invalid', `staging input must carry no .git metadata: ${path}`);
    }
    const absolute = join(root, path);
    if (entry.isDirectory()) {
      entries.push(...stagingEntries(root, path));
    } else if (entry.isSymbolicLink()) {
      entries.push({ path, kind: 'link', target: readlinkSync(absolute) });
    } else if (entry.isFile()) {
      entries.push({ path, kind: 'file', mode: lstatSync(absolute).mode, bytes: readFileSync(absolute) });
    } else {
      refuse('staging-invalid', `staging input carries an unsupported entry: ${path}`);
    }
  }
  return entries;
}

function gitBlobSha1(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function validateStagingInput({ staging, baseCommit, targetRoot }) {
  if (!staging || typeof staging !== 'object' || Array.isArray(staging)) {
    refuse('staging-invalid', 'a staged preparation must supply its staging input');
  }
  for (const field of ['source', 'dependencies']) {
    const value = staging[field];
    if (typeof value !== 'string' || !isAbsolute(value) || !existsSync(value) || !statSync(value).isDirectory()) {
      refuse('staging-invalid', `staging input ${field} must be an existing absolute directory`);
    }
  }
  const stagedSource = stagingEntries(staging.source);
  stagingEntries(staging.dependencies);

  let listing;
  try {
    listing = execFileSync('git', ['-C', targetRoot, 'ls-tree', '-r', '-z', baseCommit], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    refuse('staging-invalid', `staging input cannot be validated against base commit ${baseCommit}`);
  }
  const tracked = new Map();
  for (const record of listing.toString('utf8').split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode, type, sha] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (type !== 'blob') refuse('staging-invalid', `base commit carries an unsupported tree entry: ${path}`);
    tracked.set(path, { mode, sha });
  }
  const staged = new Map(stagedSource.map(entry => [entry.path, entry]));
  if (staged.size !== tracked.size) {
    refuse('staging-invalid', 'staging input source must be exactly the prepared source tree at baseCommit');
  }
  for (const [path, entry] of tracked) {
    const found = staged.get(path);
    if (!found) refuse('staging-invalid', `staging input source is incomplete, missing tracked path: ${path}`);
    const bytes = found.kind === 'link' ? Buffer.from(found.target) : found.bytes;
    if (gitBlobSha1(bytes) !== entry.sha) {
      refuse('staging-invalid', `staging input source does not match base commit bytes: ${path}`);
    }
    if (entry.mode === '120000' && found.kind !== 'link') {
      refuse('staging-invalid', `staging input source must preserve symlinks: ${path}`);
    }
    if (entry.mode !== '120000' && found.kind !== 'file') {
      refuse('staging-invalid', `staging input source carries an unexpected link: ${path}`);
    }
    if (found.kind === 'file' && (entry.mode === '100755') !== Boolean(found.mode & 0o111)) {
      refuse('staging-invalid', `staging input source does not preserve the executable bit: ${path}`);
    }
  }
  return { source: staging.source, dependencies: staging.dependencies };
}

// The receipt binds the validated staged contents themselves, not merely a
// path: the digest covers every staged file's bytes and every link target,
// across both the prepared source tree and the prepared dependency output.
export function stagingDigest(staging) {
  const entries = [];
  for (const [label, root] of [['source', staging.source], ['dependencies', staging.dependencies]]) {
    for (const entry of stagingEntries(root)) {
      const bytes = entry.kind === 'link' ? Buffer.from(`link:${entry.target}`) : entry.bytes;
      entries.push([`${label}/${entry.path}`, createHash('sha256').update(bytes).digest('hex')]);
    }
  }
  entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return createHash('sha256').update(canonicalJson(entries)).digest('hex');
}

function copyTreeInto(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const sourcePath = join(from, entry.name);
    const destinationPath = join(to, entry.name);
    if (entry.isSymbolicLink()) {
      symlinkSync(readlinkSync(sourcePath), destinationPath);
    } else if (entry.isDirectory()) {
      mkdirSync(destinationPath, { recursive: true });
      copyTreeInto(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      copyFileSync(sourcePath, destinationPath);
      chmodSync(destinationPath, lstatSync(sourcePath).mode & 0o777);
    } else {
      refuse('staging-invalid', `staging input carries an unsupported entry: ${sourcePath}`);
    }
  }
}

function receiptConfirmed(receipt, baseCommit) {
  return Boolean(receipt)
    && typeof receipt === 'object'
    && !Array.isArray(receipt)
    && receipt.ok === true
    && receipt.drain === 'confirmed'
    && receipt.baseCommit === baseCommit
    && receipt.trackedClean === true;
}

// The target repository must still be exactly at the declared commit with no
// tracked modifications. The freeze checks all run before any shared lower or
// attempt directory is touched, so a refused preparation leaves no partial
// workspace behind.
function requireStableBase({ worktree, baseCommit }) {
  let head = null;
  let status = null;
  try {
    head = gitText(['-C', worktree, 'rev-parse', 'HEAD']);
    status = gitText(['-C', worktree, 'status', '--porcelain', '--untracked-files=no']);
  } catch {
    refuse('tracked-base-changed', `target repository is not inspectable: ${worktree}`);
  }
  if (head !== baseCommit) refuse('tracked-base-changed', `target HEAD ${head} does not match ${baseCommit}`);
  if (status !== '') refuse('tracked-base-changed', 'target repository has tracked modifications');
}

function frozenSetup({ command, lockfiles, environment }) {
  return Object.freeze({
    command,
    lockfiles: Object.freeze([...lockfiles]),
    environment: Object.freeze([...environment]),
  });
}

// ---------------------------------------------------------------------------
// Frozen lower snapshots
// ---------------------------------------------------------------------------

function readSnapshotRecord(snapshotRoot) {
  try {
    const parsed = JSON.parse(readFileSync(join(snapshotRoot, SNAPSHOT_RECORD), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Stream the commit tree instead of buffering it, and preserve recorded file
// modes so an executable stays executable inside the frozen lower. The
// tar.umask override forces Git's canonical tar header modes (0644 regular,
// 0755 executable) so extraction by `tar -x -p` is independent of the
// process umask that would otherwise widen them to 0664/0775 from umask 0002.
function extractCommitTree({ source, baseCommit, destination }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const archive = spawn('git', ['-c', 'tar.umask=0022', '-C', source, 'archive', '--format=tar', baseCommit], { stdio: ['ignore', 'pipe', 'pipe'] });
    const extract = spawn('tar', ['-x', '-p', '-f', '-', '-C', destination], { stdio: ['pipe', 'ignore', 'pipe'] });
    const archiveError = [];
    const extractError = [];
    archive.stderr.on('data', chunk => archiveError.push(chunk));
    extract.stderr.on('data', chunk => extractError.push(chunk));
    archive.stdout.pipe(extract.stdin);

    const exited = child => new Promise((resolveExit, rejectExit) => {
      child.on('error', rejectExit);
      child.on('close', code => resolveExit(code));
    });

    Promise.all([exited(archive), exited(extract)]).then(([archiveCode, extractCode]) => {
      if (archiveCode === 0 && extractCode === 0) {
        resolvePromise();
        return;
      }
      const archiveDetail = Buffer.concat(archiveError).toString('utf8').trim();
      const extractDetail = Buffer.concat(extractError).toString('utf8').trim();
      rejectPromise(new Error(`snapshot extraction failed (git archive ${archiveCode}, tar ${extractCode}): ${archiveDetail || extractDetail}`));
    }, rejectPromise);
  });
}

// One snapshot per setup identity is created once and then reused read-only: a
// recorded identity that no longer matches the computed one is refused, never
// repaired in place, so no attempt can observe a lower it did not freeze.
async function ensureSnapshot({ snapshotRoot, snapshotId, lower, identity, source, baseCommit, staging }) {
  const snapshotDir = join(snapshotRoot, '..');
  const publishTmp = join(snapshotDir, `.publish-${snapshotId}`);
  if (existsSync(snapshotRoot)) {
    let stored = null;
    try {
      stored = readSnapshotRecord(snapshotRoot);
    } catch {
      stored = null;
    }
    // A final path that is structurally incomplete (record missing or not a
    // valid record, or lower missing) is an interrupted publication, not an
    // identity conflict: it gets its own refusal reason so a partial
    // publication is never mistaken for a genuine mismatch.
    const structurallyComplete = Boolean(stored)
      && typeof stored === 'object'
      && 'version' in stored
      && 'snapshotId' in stored
      && 'identity' in stored
      && isDirectory(lower);
    if (!structurallyComplete) refuse('snapshot-publication-incomplete', `snapshot ${snapshotId} was published incompletely`);
    const matches = stored.version === SNAPSHOT_VERSION
      && stored.snapshotId === snapshotId
      && canonicalJson(stored.identity) === canonicalJson(identity);
    if (!matches) refuse('snapshot-mismatch', `snapshot ${snapshotId} exists with a different identity`);
    return;
  }
  // The frozen lower is produced from a staging input, never by archiving the
  // source commit straight into the final snapshot directory: a caller-
  // supplied input carries the prepared source tree at baseCommit plus the
  // prepared dependency output, and the default input stages the commit
  // archive first. Both are consumed through the same copy path, so prepared
  // dependency output has a route into the frozen lower. The complete lower
  // plus its snapshot record are assembled in a temporary directory beside
  // the final snapshot root (same filesystem) and moved into place with one
  // rename, so a partially built snapshot is never visible under the final
  // snapshots/<snapshotId> path. A leftover publication temporary directory
  // from an interrupted run is discarded here, never adopted blindly as a
  // valid snapshot.
  rmSync(publishTmp, { recursive: true, force: true });
  mkdirSync(snapshotDir, { recursive: true });
  const publishLower = join(publishTmp, 'lower');
  mkdirSync(publishLower, { recursive: true });
  const ownedStaging = staging ? null : mkdtempSync(join(tmpdir(), 'wave-lower-staging-'));
  try {
    const input = staging ?? { source: join(ownedStaging, 'source'), dependencies: join(ownedStaging, 'dependencies') };
    if (ownedStaging) {
      mkdirSync(input.source, { recursive: true });
      mkdirSync(input.dependencies, { recursive: true });
      await extractCommitTree({ source, baseCommit, destination: input.source });
    }
    copyTreeInto(input.source, publishLower);
    copyTreeInto(input.dependencies, publishLower);
    writeFileSync(
      join(publishTmp, SNAPSHOT_RECORD),
      `${JSON.stringify({ version: SNAPSHOT_VERSION, snapshotId, identity }, null, 2)}\n`,
    );
    renameSync(publishTmp, snapshotRoot);
  } finally {
    rmSync(publishTmp, { recursive: true, force: true });
    if (ownedStaging) rmSync(ownedStaging, { recursive: true, force: true });
  }
}
// ---------------------------------------------------------------------------
// Private Git metadata
// ---------------------------------------------------------------------------

// The attempt fetches the base closure from the canonical repository as
// separate objects: no alternates file and no shared object directory, so the
// attempt's history remains readable after the canonical checkout moves on.
function fetchCommitObjects({ gitDir, source, sha }) {
  execFileSync('git', ['-c', 'uploadpack.allowAnySHA1InWant=true', '-C', gitDir, 'fetch', '--no-tags', source, sha], GIT_RUN);
}

function dropAlternates(gitDir) {
  const alternates = join(gitDir, 'objects', 'info', 'alternates');
  if (existsSync(alternates)) rmSync(alternates, { force: true });
}

// ---------------------------------------------------------------------------
// Attempt provisioning
// ---------------------------------------------------------------------------

async function provisionOverlay({ kind, snapshotId, baseCommit, target, waveRoot, attemptId, setup, ownership, packageId, coordinator, phaseToken, identity, attemptRoot, staging }) {
  const snapshotRoot = join(waveRoot, 'snapshots', snapshotId);
  const lower = join(snapshotRoot, 'lower');
  await ensureSnapshot({ snapshotRoot, snapshotId, lower, identity, source: target.worktree, baseCommit, staging });

  const upper = join(attemptRoot, 'upper');
  const work = join(attemptRoot, 'work');
  const merged = join(attemptRoot, 'merged');
  const gitDir = join(attemptRoot, 'git');
  for (const layer of [upper, work, merged, gitDir]) mkdirSync(layer, { recursive: true });

  const layers = validateLayers({ lower, upper, work, merged, gitDir });
  if (!layers.ok) refuse('layer-identity-mismatch', `${layers.reason}: ${layers.detail}`);

  execFileSync('git', ['init', '--bare', '-q', gitDir], GIT_RUN);
  gitText(['-C', gitDir, 'config', 'core.bare', 'false']);
  gitText(['-C', gitDir, 'config', 'core.worktree', merged]);
  fetchCommitObjects({ gitDir, source: target.worktree, sha: baseCommit });
  dropAlternates(gitDir);

  const phases = createOverlayPhases({ ownership });
  const phase = await phases.startPhase({ packageId, upper, work, phaseToken, coordinator });
  if (phase.status === 'refused') refuse('upper-held', `upper already holds a phase claim: ${upper}`);

  const retained = Object.freeze({
    ...retainLayer({ lower, upper, work, merged, gitDir, baseCommit, snapshotId, upperId: attemptId }),
    packageId,
    setup,
  });
  return Object.freeze({
    kind,
    backend: 'overlayfs',
    snapshotId,
    baseCommit,
    lower,
    upper,
    work,
    merged,
    gitDir,
    worktree: null,
    claim: Object.freeze({ token: phase.claim.token, epoch: phase.claim.epoch }),
    retained,
    setup,
  });
}

async function provisionWorktree({ kind, snapshotId, baseCommit, target, waveRoot, attemptId, setup }) {
  const worktree = join(waveRoot, 'attempts', attemptId, 'worktree');
  mkdirSync(dirname(worktree), { recursive: true });
  const existingHead = existsSync(worktree) ? gitMaybe(['-C', worktree, 'rev-parse', 'HEAD']) : null;
  if (existingHead === null) {
    execFileSync('git', ['-C', target.worktree, 'worktree', 'add', '--detach', worktree, baseCommit], GIT_RUN);
  } else if (existingHead !== baseCommit) {
    throw new Error(`fallback worktree already exists at a different head: ${worktree}`);
  }
  const declaredCommon = gitText(['-C', worktree, 'rev-parse', '--git-common-dir']);
  const commonDir = realpathSync(isAbsolute(declaredCommon) ? declaredCommon : join(worktree, declaredCommon));
  if (commonDir !== realpathSync(target.gitCommonDir)) {
    throw new Error(`fallback worktree lost the canonical common dir: ${commonDir}`);
  }
  return Object.freeze({
    kind,
    backend: 'worktree',
    snapshotId,
    baseCommit,
    lower: null,
    upper: null,
    work: null,
    merged: null,
    gitDir: null,
    worktree,
    claim: null,
    retained: null,
    setup,
  });
}
// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

async function prepare(kind, options = {}) {
  const packageId = requireString(options.packageId, 'packageId');
  const attemptId = requireAttemptId(options.attemptId);
  const baseCommit = requireString(options.baseCommit, 'baseCommit');
  const waveRoot = requireAbsolutePath(options.waveRoot, 'waveRoot');
  const target = normalizeTarget(options.target);
  const ownership = options.ownership;
  if (!ownership || typeof ownership !== 'object') throw new Error('ownership is required');
  const coordinator = options.coordinator;

  const backend = resolveBackend({ mode: options.mode ?? 'auto', capability: options.capability });
  const setup = normalizeSetup(options.setup);
  const environment = options.env && typeof options.env === 'object' ? options.env : {};

  // Freeze order: every declared-input check refuses before any snapshot or
  // attempt directory is created and before any phase claim is requested.
  // Lockfiles resolve against the accepted base target root, never the
  // caller's CWD, and the resolved file's bytes feed the identity.
  // The snapshot identity is computed through the exported helper so a
  // preparation receipt can bind to the identical snapshotId; the helper
  // re-resolves the declared lockfiles against the accepted base target root
  // exactly as before, so refusal order and identity contents are unchanged.
  const { identity, snapshotId } = setupIdentity({ baseCommit, setup: options.setup, targetRoot: target.worktree });
  for (const name of setup.environment) {
    if (!(name in environment)) refuse('env-missing', `declared environment variable is absent: ${name}`);
  }
  const commandName = setup.command.trim().split(/\s+/)[0];
  if (commandName !== '' && ROOT_COMMANDS.has(commandName)) {
    refuse('setup-root-command', `setup command must not invoke a root command: ${commandName}`);
  }
  if (!receiptConfirmed(options.preparationReceipt, baseCommit)) {
    refuse('receipt-invalid', 'preparation receipt must record a confirmed, tracked-clean base');
  }

  // A staged preparation must be bound end to end before anything is created:
  // the receipt is checked against the identical setup identity the snapshot
  // uses, the staging input is validated, and the receipt must bind the
  // validated staged contents. Every refusal here fires before any attempt
  // directory or phase claim is created.
  const receipt = options.preparationReceipt;
  let stagingInput;
  const staged = Boolean(options.staging)
    || Boolean(receipt && (receipt.snapshotId !== undefined || receipt.stagingDigest !== undefined));
  if (staged) {
    if (!receipt || receipt.snapshotId !== snapshotId) {
      refuse('receipt-identity-mismatch', 'preparation receipt must bind the identical setup snapshot identity');
    }
    stagingInput = validateStagingInput({ staging: options.staging, baseCommit, targetRoot: target.worktree });
    if (receipt.stagingDigest !== stagingDigest(stagingInput)) {
      refuse('receipt-identity-mismatch', 'preparation receipt must bind the validated staging input contents');
    }
  }
  requireStableBase({ worktree: target.worktree, baseCommit });

  const attemptRoot = join(waveRoot, 'attempts', attemptId);
  const canonicalWorktree = canonicalPath(target.worktree);
  const canonicalAttemptRoot = canonicalPath(attemptRoot);
  if (canonicalAttemptRoot === canonicalWorktree || canonicalAttemptRoot.startsWith(`${canonicalWorktree}${sep}`)) {
    refuse('canonical-worktree-is-not-a-workspace', 'the attempt workspace would resolve inside the canonical worktree');
  }

  // The identity and snapshotId come from setupIdentity above, the same
  // values the preparation receipt binds; they are not recomputed here.
  const declared = frozenSetup(setup);

  if (backend.backend === 'worktree') {
    return provisionWorktree({ kind, snapshotId, baseCommit, target, waveRoot, attemptId, setup: declared });
  }
  return provisionOverlay({
    kind,
    snapshotId,
    baseCommit,
    target,
    waveRoot,
    attemptId,
    setup: declared,
    ownership,
    packageId,
    coordinator,
    phaseToken: options.phaseToken ?? `phase-${attemptId}`,
    identity,
    attemptRoot,
    staging: stagingInput,
  });
}

export async function prepareStepWorkspace(options) {
  return prepare('step', options);
}

export async function prepareCandidateWorkspace(options) {
  return prepare('candidate', options);
}

// ---------------------------------------------------------------------------
// Retained remount
// ---------------------------------------------------------------------------

async function heldClaim(ownership, previous) {
  if (!previous || typeof previous !== 'object') return null;
  const { claims } = await ownership.inspectClaims();
  return claims.find(claim => claim.token === previous.token && claim.epoch === previous.epoch) ?? null;
}

// A positive drain is the only authority to remount: an identity mismatch
// refuses before touching any state, and a still-held claim refuses without
// resetting the upper, so dirty edits, deletions and untracked files survive
// both refusals and a successful re-claim.
export async function remountRetainedWorkspace({ retained, expected, previous, phaseToken, coordinator, ownership }) {
  if (!retained || typeof retained !== 'object') throw new Error('retained layer identity is required');
  if (!expected || typeof expected !== 'object') throw new Error('expected layer identity is required');
  for (const field of IDENTITY_FIELDS) {
    if (retained[field] !== expected[field]) {
      refuse('layer-identity-mismatch', `${field} differs from the expected retained identity`);
    }
  }
  if (typeof retained.packageId !== 'string' || retained.packageId.length === 0) {
    refuse('layer-identity-mismatch', 'retained layer carries no package identity');
  }
  const held = await heldClaim(ownership, previous);
  if (held) {
    refuse('phase-not-drained', `prior phase ${previous.token} is still held`);
  }
  const phases = createOverlayPhases({ ownership });
  const phase = await phases.startPhase({
    packageId: retained.packageId,
    upper: retained.upper,
    work: retained.work,
    phaseToken,
    coordinator,
  });
  if (phase.status === 'refused') refuse('upper-held', `upper already holds a phase claim: ${retained.upper}`);
  return Object.freeze({
    kind: 'step',
    backend: 'overlayfs',
    snapshotId: retained.snapshotId,
    baseCommit: retained.baseCommit,
    lower: retained.lower,
    upper: retained.upper,
    work: retained.work,
    merged: retained.merged,
    gitDir: retained.gitDir,
    worktree: null,
    claim: Object.freeze({ token: phase.claim.token, epoch: phase.claim.epoch }),
    retained,
    setup: retained.setup,
  });
}

// ---------------------------------------------------------------------------
// Workspace paths and sealed-head import
// ---------------------------------------------------------------------------

export function workspacePath(record, relative) {
  if (!record || typeof record !== 'object') throw new Error('workspace record is required');
  const root = record.backend === 'worktree' ? record.worktree : record.merged;
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('workspace record has no resolvable root');
  if (typeof relative !== 'string') throw new Error('workspace path must be a string');
  if (isAbsolute(relative)) refuse('path-escape', `absolute paths are outside the workspace: ${relative}`);
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relative);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${sep}`)) {
    refuse('path-escape', `path escapes the workspace: ${relative}`);
  }
  return candidate;
}

// Only the module's own retention namespace may be written: an import cannot
// move or overwrite a branch the canonical repository already owns, and the
// imported object graph keeps the exact commit, tree and ancestry.
export async function importSealedHead({ repo, source, sha, retentionRef }) {
  const repository = requireAbsolutePath(repo, 'repo');
  const origin = requireAbsolutePath(source, 'source');
  const target = requireString(sha, 'sha');
  const ref = requireString(retentionRef, 'retentionRef');
  if (!ref.startsWith(RETENTION_REF_PREFIX)) {
    refuse('retention-ref-conflict', `retention ref must stay inside ${RETENTION_REF_PREFIX}`);
  }
  const existing = gitMaybe(['-C', repository, 'rev-parse', '--verify', '--quiet', ref]);
  if (existing !== null && existing !== target) {
    refuse('retention-ref-conflict', `retention ref ${ref} already points at ${existing}`);
  }
  fetchCommitObjects({ gitDir: repository, source: origin, sha: target });
  if (!objectExists(repository, target)) {
    throw new Error(`sealed head ${target} was not found after fetching from ${origin}`);
  }
  if (existing === null) gitText(['-C', repository, 'update-ref', ref, target]);
}

