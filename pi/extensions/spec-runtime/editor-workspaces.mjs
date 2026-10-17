// Isolated packet workspaces for the wave packet manager (step 10, AC23).
//
// A wave packet declares the checkout-relative writable paths it is allowed to
// touch. When every packet's declared paths are disjoint the packets can share
// the owner checkout directly. When any two packets declare an equal or nested
// path, each packet instead runs in its own directory: a byte-for-byte copy of
// the current owner working tree (never HEAD) inside a fresh, independent git
// repository seeded from that snapshot. `integrate(index)` performs an explicit
// three-way merge (ancestor = snapshot, ours = owner working tree, theirs =
// packet working tree) over exactly the declared paths, applies the packet as
// one bounded transaction with rollback, and reports conflicts without writing.
//
// This module never creates git worktrees and never mounts anything; packet
// repositories share no object store with the owner repository.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { createOwnership } from './ownership.mjs';
import { prepareStepWorkspace } from './step-workspaces.mjs';
import { processIdentity } from '../../../scripts/spec-observe/process-identity.mjs';

const GIT_RUN = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 };
const GIT_IDENTITY = { name: 'Wave Packets', email: 'wave-packets@example.invalid' };
const ROOT_EXCLUSIONS = new Set(['.git']);

// ---------------------------------------------------------------------------
// Small process and filesystem helpers
// ---------------------------------------------------------------------------

function git(args) {
  try {
    return { status: 0, stdout: execFileSync('git', args, GIT_RUN) ?? '', stderr: '' };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 'error',
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error?.message ?? error),
    };
  }
}

function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

// Copy a tree without ever following a symlink. Only the top-level call can
// exclude entries; nested `.git` directories are ordinary directories.
function copyTree(source, dest, rootExclusions = new Set()) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (rootExclusions.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(dest, entry.name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(from), to);
    } else if (stat.isDirectory()) {
      copyTree(from, to);
    } else if (stat.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, stat.mode & 0o7777);
    }
    // Special files carry no declared writable content and are skipped.
  }
}

function isBinary(bytes) {
  return bytes.includes(0);
}

// ---------------------------------------------------------------------------
// Path validation and overlap detection
// ---------------------------------------------------------------------------

function normalizeCheckout(checkout) {
  if (typeof checkout !== 'string' || checkout.length === 0) throw new Error('checkout must be a non-empty string');
  if (!isAbsolute(checkout)) throw new Error('checkout must be an absolute path');
  return resolve(checkout);
}

// Normalize one declared writable path: it must stay inside the checkout, be
// non-empty after normalization and never name a `.git` segment.
function normalizeRelPath(raw, packetIndex) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`packet ${packetIndex} path must be a non-empty string`);
  }
  if (raw.includes('\\')) throw new Error(`packet ${packetIndex} path must use forward slashes: ${raw}`);
  if (isAbsolute(raw)) throw new Error(`packet ${packetIndex} path must be relative: ${raw}`);
  const segments = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) {
        throw new Error(`packet ${packetIndex} path escapes the checkout: ${raw}`);
      }
      segments.pop();
      continue;
    }
    if (part === '.git') throw new Error(`packet ${packetIndex} path may not reference .git: ${raw}`);
    segments.push(part);
  }
  if (segments.length === 0) throw new Error(`packet ${packetIndex} path is empty: ${raw}`);
  return segments.join('/');
}

function validatePackets(packets) {
  if (!Array.isArray(packets)) throw new Error('packets must be an array');
  return packets.map((packet, index) => {
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
      throw new Error(`packet ${index} must be an object`);
    }
    if (!Array.isArray(packet.paths)) throw new Error(`packet ${index} paths must be an array`);
    if (packet.paths.length === 0) throw new Error(`packet ${index} paths must not be empty`);
    return { paths: packet.paths.map(path => normalizeRelPath(path, index)) };
  });
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function hasOverlap(declared) {
  for (let i = 0; i < declared.length; i += 1) {
    for (let j = i + 1; j < declared.length; j += 1) {
      for (const left of declared[i].paths) {
        for (const right of declared[j].paths) {
          if (pathsOverlap(left, right)) return true;
        }
      }
    }
  }
  return false;
}

// Reject a declared path whose ancestor component is any symlink (including a
// dangling or in-tree alias). A symlink cannot be trusted as an ordinary
// directory component: writes would follow it. A genuinely missing component
// cannot escape and is skipped.
function assertSafeAncestors(root, rel, label) {
  const parts = rel.split('/');
  let current = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = join(current, parts[i]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`declared path ${rel} escapes ${label} through symlink ${current}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot description and per-path three-way merge
// ---------------------------------------------------------------------------

function describe(root, rel) {
  const abs = join(root, rel);
  let stat;
  try {
    stat = lstatSync(abs);
  } catch (error) {
    if (isMissing(error)) return { kind: 'absent' };
    throw error;
  }
  if (stat.isSymbolicLink()) return { kind: 'link', target: readlinkSync(abs) };
  if (stat.isDirectory()) return { kind: 'dir' };
  if (stat.isFile()) return { kind: 'file', mode: stat.mode & 0o7777, bytes: readFileSync(abs) };
  return { kind: 'other' };
}

function statesEqual(left, right) {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'file') return left.mode === right.mode && left.bytes.equals(right.bytes);
  if (left.kind === 'link') return left.target === right.target;
  return true;
}

// Enumerate the leaf (file/symlink) paths a declared path covers in one side.
// Directories are walked, symlinks are never traversed.
function collectLeaves(root, rel) {
  let stat;
  try {
    stat = lstatSync(join(root, rel));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (stat.isSymbolicLink()) return [rel];
  if (stat.isDirectory()) {
    const leaves = [];
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      leaves.push(...collectLeaves(root, `${rel}/${entry.name}`));
    }
    return leaves;
  }
  if (stat.isFile()) return [rel];
  return [];
}

function mergeText(baseBytes, ourBytes, theirBytes, tempRoot) {
  const work = mkdtempSync(join(tempRoot, 'merge-'));
  const baseFile = join(work, 'base');
  const ourFile = join(work, 'ours');
  const theirFile = join(work, 'theirs');
  writeFileSync(baseFile, baseBytes);
  writeFileSync(ourFile, ourBytes);
  writeFileSync(theirFile, theirBytes);
  try {
    const result = spawnSync('git', ['merge-file', '-p', ourFile, baseFile, theirFile], {
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status === 0) return { clean: true, bytes: result.stdout };
    return { clean: false };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function mergedMode(base, ours, theirs) {
  if (ours.mode === theirs.mode) return ours.mode;
  if (ours.mode === base.mode) return theirs.mode;
  if (theirs.mode === base.mode) return ours.mode;
  return null;
}

function operationsForTheirs(rel, ours, theirs) {
  if (theirs.kind === 'absent' || theirs.kind === 'dir') {
    return ours.kind === 'absent' ? [] : [{ op: 'delete', path: rel }];
  }
  if (theirs.kind === 'file') return [{ op: 'write', path: rel, bytes: theirs.bytes, mode: theirs.mode }];
  if (theirs.kind === 'link') return [{ op: 'link', path: rel, target: theirs.target }];
  return [];
}

// One declared leaf: identical and only-one-side-changed are fast paths; two
// differing regular text files go through `git merge-file`; everything else
// (add/add, delete/modify, type change, binary) conflicts.
function mergeLeaf(rel, base, ours, theirs, tempRoot) {
  if (statesEqual(ours, theirs)) return { ops: [] };
  if (statesEqual(base, ours)) return { ops: operationsForTheirs(rel, ours, theirs) };
  if (statesEqual(base, theirs)) return { ops: [] };
  if (
    base.kind === 'file' && ours.kind === 'file' && theirs.kind === 'file'
    && !isBinary(base.bytes) && !isBinary(ours.bytes) && !isBinary(theirs.bytes)
  ) {
    const merged = mergeText(base.bytes, ours.bytes, theirs.bytes, tempRoot);
    if (merged.clean) {
      const mode = mergedMode(base, ours, theirs);
      if (mode !== null) return { ops: [{ op: 'write', path: rel, bytes: merged.bytes, mode }] };
    }
  }
  return { conflict: true };
}

function mergePackets({ baseDir, checkout, packetDir, paths, tempRoot }) {
  const leaves = new Set();
  for (const rel of paths) {
    for (const side of [baseDir, checkout, packetDir]) {
      assertSafeAncestors(side, rel, side === checkout ? 'checkout' : 'workspace');
      for (const leaf of collectLeaves(side, rel)) leaves.add(leaf);
    }
  }
  const conflictingPaths = [];
  const operations = [];
  for (const rel of [...leaves].sort()) {
    const result = mergeLeaf(rel, describe(baseDir, rel), describe(checkout, rel), describe(packetDir, rel), tempRoot);
    if (result.conflict) conflictingPaths.push(rel);
    else operations.push(...result.ops);
  }
  // Delete leaf collisions before writes so a file can replace a directory and
  // a directory can replace a file.
  operations.sort((left, right) => Number(right.op === 'delete') - Number(left.op === 'delete'));
  return { conflictingPaths, operations };
}

// ---------------------------------------------------------------------------
// Transactional application with rollback
// ---------------------------------------------------------------------------

function captureState(abs, tempRoot) {
  let stat;
  try {
    stat = lstatSync(abs);
  } catch (error) {
    if (isMissing(error)) return { kind: 'absent' };
    throw error;
  }
  if (stat.isSymbolicLink()) return { kind: 'link', target: readlinkSync(abs) };
  if (stat.isDirectory()) {
    const backup = join(mkdtempSync(join(tempRoot, 'rollback-')), 'dir');
    copyTree(abs, backup);
    return { kind: 'dir', backup, mode: stat.mode & 0o7777 };
  }
  if (stat.isFile()) return { kind: 'file', bytes: readFileSync(abs), mode: stat.mode & 0o7777 };
  return { kind: 'other' };
}

function restoreState(abs, state) {
  rmSync(abs, { recursive: true, force: true });
  if (state.kind === 'absent' || state.kind === 'other') return;
  if (state.kind === 'link') {
    symlinkSync(state.target, abs);
    return;
  }
  if (state.kind === 'dir') {
    copyTree(state.backup, abs);
    return;
  }
  if (state.kind === 'file') {
    writeFileSync(abs, state.bytes);
    chmodSync(abs, state.mode);
  }
}

function applyOperations(checkout, operations, tempRoot) {
  const applied = [];
  try {
    for (const op of operations) {
      const abs = join(checkout, op.path);
      const original = captureState(abs, tempRoot);
      // Register the rollback state before the first mutation so a failure while
      // deleting or replacing cannot leave the checkout half-applied.
      applied.push({ abs, original });
      if (op.op === 'delete') {
        if (original.kind !== 'absent') rmSync(abs, { recursive: true, force: true });
      } else if (op.op === 'write') {
        mkdirSync(dirname(abs), { recursive: true });
        if (original.kind !== 'absent' && original.kind !== 'file') {
          rmSync(abs, { recursive: true, force: true });
        }
        // Regular files land through a sibling temp file and an atomic rename
        // once every merge operation has already been computed, so a partial
        // write never becomes the visible file.
        const temp = join(dirname(abs), `.wave-write-${process.pid}-${applied.length}-${Date.now()}`);
        try {
          writeFileSync(temp, op.bytes);
          chmodSync(temp, op.mode);
          renameSync(temp, abs);
        } catch (error) {
          rmSync(temp, { force: true });
          throw error;
        }
      } else if (op.op === 'link') {
        mkdirSync(dirname(abs), { recursive: true });
        if (original.kind !== 'absent') rmSync(abs, { recursive: true, force: true });
        symlinkSync(op.target, abs);
      }
    }
  } catch (error) {
    for (let index = applied.length - 1; index >= 0; index -= 1) {
      restoreState(applied[index].abs, applied[index].original);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Packet repository setup and patch rendering
// ---------------------------------------------------------------------------

// Unified base-to-packet changes for the declared paths. The whole disposable
// packet repository is staged first so additions and deletions (including any
// ignored owner bytes) are captured without a pathspec that fails on absent
// declared files; the diff is then limited to the declared paths.
function buildPatch(dir, baseCommit, paths) {
  if (paths.length === 0) return '';
  const staged = git(['-C', dir, 'add', '-f', '-A']);
  if (staged.status !== 0) {
    throw new Error(`git add -f -A failed for packet patch: ${staged.stderr}`);
  }
  const diff = git(['-C', dir, 'diff', '--cached', '--binary', baseCommit, '--', ...paths]);
  if (diff.status !== 0) {
    throw new Error(`git diff --cached failed for packet patch: ${diff.stderr}`);
  }
  return diff.stdout;
}

function requireIndex(index, expected, count) {
  if (!Number.isInteger(index)) throw new Error('packet index must be an integer');
  if (index < 0 || index >= count) throw new Error(`packet index ${index} is out of range`);
  if (index !== expected) throw new Error(`packet ${expected} must integrate before packet ${index}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Workspace tree snapshot
// ---------------------------------------------------------------------------

function canonicalize(input) {
  try {
    return realpathSync(input);
  } catch {
    return resolve(input);
  }
}

function gitCommonDir(checkout) {
  const result = git(['-C', checkout, 'rev-parse', '--git-common-dir']);
  if (result.status !== 0) {
    throw new Error(`cannot resolve the git common dir for ${checkout}: ${result.stderr}`);
  }
  const declared = result.stdout.trim();
  return realpathSync(isAbsolute(declared) ? declared : join(checkout, declared));
}

// One commit object whose tree is the checkout's CURRENT working tree (tracked
// edits, untracked files and ignored files) and whose parent is the current
// HEAD, created through a temporary GIT_INDEX_FILE so the owner's index, HEAD,
// refs, hooks and configuration are never touched. The commit is written
// dangling; only the returned SHA refers to it.
export function snapshotWorkingTree(checkout) {
  const root = normalizeCheckout(checkout);
  const head = git(['-C', root, 'rev-parse', '--verify', '-q', 'HEAD']);
  if (head.status !== 0) {
    throw new Error(`cannot resolve HEAD for the working-tree snapshot in ${root}: ${head.stderr}`);
  }
  const parent = head.stdout.trim();
  const indexDir = mkdtempSync(join(tmpdir(), 'editor-snapshot-index-'));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(indexDir, 'index'),
    GIT_AUTHOR_NAME: GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: GIT_IDENTITY.email,
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00+0000',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00+0000',
  };
  const run = args => {
    try {
      return { status: 0, stdout: execFileSync('git', ['-C', root, ...args], { ...GIT_RUN, env }) ?? '', stderr: '' };
    } catch (error) {
      return {
        status: typeof error.status === 'number' ? error.status : 'error',
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? String(error?.message ?? error),
      };
    }
  };
  try {
    const added = run(['add', '-f', '-A']);
    if (added.status !== 0) throw new Error(`git add -f -A failed for the working-tree snapshot: ${added.stderr}`);
    const tree = run(['write-tree']);
    if (tree.status !== 0) throw new Error(`git write-tree failed for the working-tree snapshot: ${tree.stderr}`);
    const commit = run(['-c', 'commit.gpgsign=false', 'commit-tree', tree.stdout.trim(), '-p', parent, '-m', 'editor packet workspace snapshot']);
    if (commit.status !== 0) throw new Error(`git commit-tree failed for the working-tree snapshot: ${commit.stderr}`);
    return commit.stdout.trim();
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Card-owned packet workspace preparation and release
// ---------------------------------------------------------------------------

// Overlay packet workspaces provision only unmounted layers. A caller must
// supply the real mount/drain transport; the wrapper never fabricates one and
// fails closed when it is missing.
function requireMountTransport(mountTransport) {
  if (!mountTransport || typeof mountTransport.mount !== 'function' || typeof mountTransport.drain !== 'function') {
    const error = new Error(
      'overlay lifecycle mount transport is unavailable: packet overlay workspaces require callable mount and drain',
    );
    error.code = 'overlay-mount-transport-unavailable';
    throw error;
  }
  return mountTransport;
}

// A positive drain is cached per retained member so a release retry never drains
// an already-confirmed overlay a second time. A member whose drain was not yet
// confirmed is drained again by the retry.
const drainedMembers = new WeakSet();

function requireDrainTransport(mountTransport) {
  if (!mountTransport || typeof mountTransport.drain !== 'function') {
    const error = new Error(
      'overlay lifecycle drain transport is unavailable: a retained overlay workspace cannot be confirmed drained',
    );
    error.code = 'overlay-mount-transport-unavailable';
    throw error;
  }
  return mountTransport;
}

// A 'denied' release result is only accepted as an already-absent claim when a
// fresh inspection proves the exact token is gone. A missing or unknown
// inspector cannot prove absence and must throw.
async function claimAbsentAfterDenial(ownership, claim) {
  if (!ownership || typeof ownership.inspectClaims !== 'function') {
    throw new Error(`cannot confirm packet workspace claim ${claim.token} is absent: claim inspector is unavailable`);
  }
  let inspected;
  try {
    inspected = await ownership.inspectClaims();
  } catch (error) {
    throw new Error(`cannot inspect packet workspace claims while releasing ${claim.token}: ${error?.message ?? error}`);
  }
  const claims = inspected && Array.isArray(inspected.claims) ? inspected.claims : null;
  if (!claims) {
    throw new Error(`cannot confirm packet workspace claim ${claim.token} is absent: claim inspection returned no claims`);
  }
  return !claims.some(entry => entry && entry.token === claim.token);
}

// Prepare one real worktree workspace per packet from the working-tree
// snapshot. Every packet calls the card's prepareStepWorkspace with kind
// 'packet' (so the canonical-repo tracked-base check is skipped and the
// snapshot commit is the base), the canonical package identity and target, the
// declared 'none' setup, a confirmed tracked-clean receipt at the snapshot, and
// the caller's real ownership registry, coordinator, mode and capability. A
// partial preparation releases every member already prepared before rethrowing.
export async function preparePacketWorkspaces({
  record,
  snapshot,
  packets,
  ownership,
  coordinator,
  mode = 'worktree',
  capability,
  batch = 0,
  waveRoot,
  mountTransport,
} = {}) {
  if (!record || typeof record !== 'object') throw new Error('record is required');
  if (typeof snapshot !== 'string' || snapshot.length === 0) throw new Error('snapshot commit is required');
  if (!Array.isArray(packets)) throw new Error('packets must be an array');
  if (!ownership || typeof ownership !== 'object') throw new Error('ownership registry is required');
  if (typeof waveRoot !== 'string' || !isAbsolute(waveRoot)) throw new Error('waveRoot must be an absolute path');
  const canonicalPackage = canonicalize(record.package);
  const checkout = canonicalize(record.checkout);
  const target = { worktree: checkout, gitCommonDir: gitCommonDir(checkout) };
  const preparationReceipt = { ok: true, drain: 'confirmed', baseCommit: snapshot, trackedClean: true };
  const members = [];
  try {
    for (let k = 0; k < packets.length; k += 1) {
      const receipt = await prepareStepWorkspace({
        kind: 'packet',
        packageId: canonicalPackage,
        attemptId: `${record.id}:batch-${batch}:packet-${k}`,
        baseCommit: snapshot,
        waveRoot,
        target,
        setup: 'none',
        preparationReceipt,
        ownership,
        coordinator,
        mode,
        capability,
      });
      // Retain the member and its real claim before any mount attempt so a
      // missing or unconfirmed mount still exposes exactly what must be drained
      // and released.
      const member = Object.freeze({ ...receipt, k, checkout: receipt.worktree ?? receipt.merged });
      members.push(member);
      if (member.backend !== 'worktree') {
        requireMountTransport(mountTransport);
        const mounted = await mountTransport.mount(member);
        if (!mounted || mounted.status !== 'mounted') {
          const error = new Error(`overlay mount was not confirmed for packet ${k}`);
          error.code = 'mount-unconfirmed';
          throw error;
        }
      }
    }
  } catch (error) {
    // Surface a cleanup failure instead of swallowing it; the members that hold
    // real claims and their roots remain for inspection.
    try {
      await releasePacketWorkspaces({ record, members, ownership, mountTransport });
    } catch (releaseError) {
      error.cleanupError = error.cleanupError ?? releaseError;
      error.retainedMembers = members.slice();
    }
    throw error;
  }
  return { members, snapshot, mode, capability, mountTransport };
}

// Inspect the owner repository's real worktree registrations. A member checkout
// is "already gone" only when it is absent from the registration list; an
// unreadable registration list is not evidence of absence.
function registeredWorktrees(repo) {
  const result = git(['-C', repo, 'worktree', 'list', '--porcelain']);
  if (result.status !== 0) {
    throw new Error(`cannot inspect worktree registrations for ${repo}: ${result.stderr}`);
  }
  const paths = [];
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) paths.push(canonicalize(line.slice('worktree '.length)));
  }
  return paths;
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

// Release the exact member workspaces and claims. Every mounted overlay is
// drained to a positive confirmation before any removal or claim release; each
// member's workspace is removed first (worktrees with the real `git worktree
// remove --force`, overlay attempt roots by deletion) and only then is its claim
// released. A failed removal retains the claim and aborts the batch; a claim
// release is only accepted as proof of absence after a fresh inspection says the
// exact token is gone. Idempotent only for resources that are genuinely already
// gone or already released: a retained or unconfirmed resource makes the whole
// release throw and leaves the batch root in place.
export async function releasePacketWorkspaces({ record, members, ownership, mountTransport } = {}) {
  const repo = record && typeof record.checkout === 'string' ? canonicalize(record.checkout) : null;
  const registered = repo ? registeredWorktrees(repo) : [];
  const list = members ?? [];
  // Pass one: drain every mounted overlay before any release or deletion.
  const overlays = list.filter(member => member?.backend && member.backend !== 'worktree');
  if (overlays.some(member => !drainedMembers.has(member))) requireDrainTransport(mountTransport);
  for (const member of overlays) {
    if (drainedMembers.has(member)) continue;
    const drained = await mountTransport.drain(member);
    if (!drained || drained.status !== 'confirmed') {
      const error = new Error(`overlay drain was not confirmed for packet ${member.k}; retaining the workspace and claim`);
      error.code = 'drain-unconfirmed';
      throw error;
    }
    drainedMembers.add(member);
  }
  // Pass two: remove exactly that member's workspace, then release its claim.
  for (const member of list) {
    if (member?.backend === 'worktree' || (!member?.backend && typeof member?.checkout === 'string' && member.checkout.length > 0)) {
      const checkout = member.checkout;
      if (repo && typeof checkout === 'string' && checkout.length > 0) {
        const resolved = canonicalize(checkout);
        if (registered.includes(resolved) || pathExists(resolved)) {
          // Removal was requested for a still-registered or existing workspace, so
          // a failure is a real failure: propagate it and retain the claim and root.
          try {
            execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', checkout], GIT_RUN);
          } catch (error) {
            const message = error?.stderr ?? error?.message ?? String(error);
            throw new Error(`failed to remove packet workspace ${checkout}: ${message}`);
          }
        }
        // Otherwise the worktree is genuinely absent and removal is idempotent.
      }
    } else if (member?.backend) {
      // Overlay layers live under the per-attempt directory that contains the
      // upper layer; removing it is safe only after the confirmed drain above.
      const attemptRoot = typeof member.upper === 'string' && member.upper.length > 0
        ? dirname(member.upper)
        : (typeof member.checkout === 'string' && member.checkout.length > 0 ? dirname(member.checkout) : null);
      if (attemptRoot) rmSync(attemptRoot, { recursive: true, force: true });
    }
    // Only after its exact workspace is proven removed is the claim released.
    const claim = member?.claim;
    if (claim && ownership && typeof ownership.releaseClaim === 'function') {
      let result;
      try {
        result = await ownership.releaseClaim({ token: claim.token, epoch: claim.epoch, drain: 'confirmed' });
      } catch (error) {
        throw new Error(`failed to release packet workspace claim ${claim.token}: ${error?.message ?? error}`);
      }
      const status = result && typeof result === 'object' ? result.result?.status ?? result.status : null;
      if (status === 'released') {
        // Success: the exact claim was released.
      } else if (status === 'denied') {
        // A denial never proves absence on its own; only a fresh inspection
        // that finds the exact token gone may accept it.
        const absent = await claimAbsentAfterDenial(ownership, claim);
        if (!absent) {
          throw new Error(`failed to release packet workspace claim ${claim.token}: still held after ${JSON.stringify(result)}`);
        }
      } else {
        throw new Error(`unexpected claim release result for ${claim.token}: ${JSON.stringify(result)}`);
      }
    }
  }
  if (repo) {
    try {
      execFileSync('git', ['-C', repo, 'worktree', 'prune'], GIT_RUN);
    } catch {
      // Pruning is best effort; a missing registration is not an error here.
    }
  }
}

// ---------------------------------------------------------------------------
// Wrapper defaults
// ---------------------------------------------------------------------------

function defaultCoordinator() {
  const observed = processIdentity(process.pid);
  if (!observed || observed.started_at === undefined || observed.started_at === null) {
    throw new Error('cannot observe the coordinator process identity: missing started_at');
  }
  return {
    session: `editor-workspaces-${process.pid}`,
    epoch: 1,
    pid: process.pid,
    started_at: observed.started_at,
  };
}

// The actual backend a non-isolated batch reports: no workspace is provisioned,
// so the explicit selection is the backend the batch ran under.
function requestedBackend(mode) {
  return mode === 'overlayfs' || mode === 'overlay' ? 'overlayfs' : 'worktree';
}

// An explicit worktree selection needs no overlay probe: resolveBackend honors
// the explicit mode without consulting the classification, so this wrapper
// never fabricates a supported overlay. This record only satisfies the
// classifier shape for a caller that omits a capability; it cannot authorize a
// silent overlay fallback.
function explicitWorktreeCapability() {
  return { status: 'unavailable', reason: 'explicit-worktree', fallbackEligible: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createPacketWorkspaces({
  checkout,
  packets,
  record,
  ownership,
  coordinator,
  mode = 'worktree',
  capability,
  batch = 0,
  mountTransport,
} = {}) {
  const root = normalizeCheckout(checkout);
  const declared = validatePackets(packets);
  for (const packet of declared) {
    for (const rel of packet.paths) assertSafeAncestors(root, rel, 'checkout');
  }
  const isolated = hasOverlap(declared);
  // The wrapper record always carries the defaults, the caller's record fields
  // and the resolved checkout (an explicit record may omit checkout).
  const batchRecord = {
    id: 'editor-packet-batch',
    package: root,
    ...record,
    checkout: root,
  };

  if (!isolated) {
    let expected = 0;
    return {
      isolated: false,
      mode: 'shared',
      backend: requestedBackend(mode),
      snapshot: null,
      members: declared.map((packet, k) => ({ k, checkout: root, paths: packet.paths })),
      workspaces: declared.map(() => root),
      integrate(index, { skip = false } = {}) {
        requireIndex(index, expected, declared.length);
        expected += 1;
        if (skip) return { status: 'not-run', conflicting_paths: [], patch: '' };
        return { status: 'applied', conflicting_paths: [], patch: '' };
      },
      cleanup() {},
    };
  }

  let cleaned = false;
  let members = [];
  let tempRoot = null;
  let effectiveOwnership = ownership;
  try {
    tempRoot = mkdtempSync(join(tmpdir(), 'editor-workspaces-'));
    if (!effectiveOwnership) {
      effectiveOwnership = createOwnership({ registryRoot: join(tempRoot, 'ownership') });
    }
    const effectiveCoordinator = coordinator ?? defaultCoordinator();
    const effectiveCapability = capability ?? explicitWorktreeCapability();
    const waveRoot = join(tempRoot, 'wave-workspaces');
    // The snapshot commit is the ancestor for the merge engine and the base for
    // every prepared member; baseDir is the same working-tree bytes as a plain
    // read-only copy, kept for the existing three-way merge.
    const snapshot = snapshotWorkingTree(root);
    const baseDir = join(tempRoot, 'base');
    copyTree(root, baseDir, ROOT_EXCLUSIONS);

    const prepared = await preparePacketWorkspaces({
      record: batchRecord,
      snapshot,
      packets: declared,
      ownership: effectiveOwnership,
      coordinator: effectiveCoordinator,
      mode,
      capability: effectiveCapability,
      batch,
      waveRoot,
      mountTransport,
    });
    members = prepared.members;

    const workspaces = members.map(member => member.checkout);
    let expected = 0;

    return {
      isolated: true,
      mode: 'isolated',
      backend: members[0]?.backend ?? requestedBackend(mode),
      snapshot,
      members,
      workspaces,
      integrate(index, { skip = false } = {}) {
        if (cleaned) throw new Error('packet workspaces have been cleaned up');
        requireIndex(index, expected, declared.length);
        const member = members[index];
        expected += 1;
        if (skip) return { status: 'not-run', conflicting_paths: [], patch: '' };
        const merged = mergePackets({ baseDir, checkout: root, packetDir: member.checkout, paths: declared[index].paths, tempRoot });
        const patch = buildPatch(member.checkout, member.baseCommit, declared[index].paths);
        if (merged.conflictingPaths.length > 0) {
          return { status: 'conflict', conflicting_paths: merged.conflictingPaths, patch };
        }
        applyOperations(root, merged.operations, tempRoot);
        return { status: 'applied', conflicting_paths: [], patch };
      },
      async cleanup() {
        if (cleaned) return;
        await releasePacketWorkspaces({ record: batchRecord, members, ownership: effectiveOwnership, mountTransport });
        if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
        // Marked only after the full release and root removal succeeded; a
        // failure above leaves cleanup retryable.
        cleaned = true;
      },
    };
  } catch (error) {
    // A preparation failure still exposes the members that hold real claims and
    // their batch root. Release is attempted, but a cleanup failure is surfaced
    // on the error rather than swallowed, and a retained resource is never
    // recursively deleted.
    // preparePacketWorkspaces may already have attempted release and surfaced
    // the surviving members on the error; preserve that list instead of
    // retrying a cleanup that already failed.
    const alreadyAttempted = Array.isArray(error.retainedMembers) && error.retainedMembers.length > 0;
    let retained = alreadyAttempted ? error.retainedMembers : members;
    if (!alreadyAttempted && members.length > 0 && tempRoot) {
      try {
        await releasePacketWorkspaces({ record: batchRecord, members, ownership: effectiveOwnership, mountTransport });
        retained = [];
      } catch (releaseError) {
        error.cleanupError = error.cleanupError ?? releaseError;
      }
    }
    if (tempRoot) {
      if (retained.length === 0) {
        try {
          rmSync(tempRoot, { recursive: true, force: true });
        } catch {
          // The original creation failure is the error the caller must see.
        }
      } else {
        error.retainedMembers = retained.slice();
        error.retainedRoot = tempRoot;
      }
    }
    throw error;
  }
}
