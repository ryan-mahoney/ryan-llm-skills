// Cross-process ownership registry for waves.
//
// Every mutation runs in one host-local child process per operation, serialized
// by util-linux flock(1) around a single lock file at the registry root. The
// library spawns `flock -x <lock> <node> <this module> <operation>` with an
// argv array (no shell interpolation) and exchanges one JSON request/response
// over stdio. The child performs exactly one atomic read-modify-write of the
// registry and exits 0; unknown operation names fail closed.
//
// Kernel locks release on process death, persistent claims do not: stale claims
// stay registered until a positive release or token/epoch-bound recovery.
// Ownership is never inferred from basename, a numeric pid alone, mtime, TTL or
// run.json.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectProcess } from '../../../scripts/spec-observe/process-identity.mjs';

export const SOFTWARE_CEILING = 16;

const MODULE_PATH = fileURLToPath(import.meta.url);
const REGISTRY_FILE = 'claims.json';
const LOCK_FILE = 'registry.lock';
const REGISTRY_VERSION = 1;

// Fixed operation names: the parent passes exactly one to the mutation child.
const OPERATIONS = {
  acquirePackage: 'acquire-package',
  reserveCheckout: 'reserve-checkout',
  reserveCapacity: 'reserve-capacity',
  releaseClaim: 'release-claim',
  recoverClaims: 'recover-claims',
};

export function resolveRegistryRoot(override) {
  return override || join(homedir(), '.pi/agent/spec-runtime', 'ownership');
}

export function createOwnership({ registryRoot = resolveRegistryRoot(), budgets = {} } = {}) {
  const root = resolveRegistryRoot(registryRoot);
  const effectiveBudgets = normalizeBudgets(budgets);
  const mutate = (operation, args) => runMutation({ registryRoot: root, budgets: effectiveBudgets, operation, args: args || {} });
  return {
    async acquirePackage(args) { return mutate(OPERATIONS.acquirePackage, args); },
    async reserveCheckout(args) { return mutate(OPERATIONS.reserveCheckout, args); },
    async reserveCapacity(args) { return mutate(OPERATIONS.reserveCapacity, args); },
    async releaseClaim(args) { return mutate(OPERATIONS.releaseClaim, args); },
    async recoverClaims(args) { return mutate(OPERATIONS.recoverClaims, args); },
    // Inspect reads the atomically replaced registry file directly; no lock.
    async inspectClaims(filter = {}) {
      const { claims } = readRegistry(root);
      const packageId = filter && filter.packageId;
      const selected = typeof packageId === 'string' ? claims.filter(claim => claim.packageId === packageId) : claims;
      return { claims: selected.map(projectClaim) };
    },
  };
}

function runMutation({ registryRoot, budgets, operation, args }) {
  mkdirSync(registryRoot, { recursive: true });
  const lockPath = join(registryRoot, LOCK_FILE);
  closeSync(openSync(lockPath, 'a', 0o600));
  return new Promise((resolvePromise, reject) => {
    const child = spawn('flock', ['-x', lockPath, process.execPath, MODULE_PATH, operation], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`ownership mutation ${operation} failed (${signal || `exit ${code}`}): ${stderr.trim() || 'no diagnostics'}`));
        return;
      }
      try { resolvePromise(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`ownership mutation ${operation} returned invalid JSON: ${stdout.trim().slice(0, 200)}`, { cause: error })); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ registryRoot, budgets, args }));
  });
}

// ---------------------------------------------------------------------------
// Mutation child. The parent invokes this file directly with a fixed operation
// name; the child reads one JSON request on stdin and prints one JSON response.
// ---------------------------------------------------------------------------

const MUTATION_HANDLERS = {
  [OPERATIONS.acquirePackage]: (state, request) => {
    const { packageId, packagePath, coordinator } = request.args;
    requireString(packageId, 'packageId');
    const owner = normalizeCoordinator(coordinator);
    const existing = state.claims.find(claim => claim.kind === 'package' && claim.packageId === packageId);
    if (existing) return { changed: false, result: { status: 'held', claim: projectClaim(existing) } };
    const claim = {
      kind: 'package',
      token: newToken(),
      epoch: owner.epoch,
      packageId,
      attempt: null,
      state: 'acquired',
      reservations: null,
      coordinator: owner,
      packagePath: typeof packagePath === 'string' ? packagePath : null,
    };
    state.claims.push(claim);
    return { changed: true, result: { status: 'acquired', claim: projectClaim(claim) } };
  },

  [OPERATIONS.reserveCheckout]: (state, request) => {
    const { packageId, attempt, checkout, coordinator } = request.args;
    requireString(packageId, 'packageId');
    requireString(attempt, 'attempt');
    const identity = checkoutIdentity(checkout);
    const owner = normalizeCoordinator(coordinator);
    const existing = state.claims.find(claim => claim.kind === 'checkout' && claim.checkoutKey === identity.key);
    if (existing) return { changed: false, result: { status: 'held', claim: projectClaim(existing) } };
    const claim = {
      kind: 'checkout',
      token: newToken(),
      epoch: owner.epoch,
      packageId,
      attempt,
      state: 'reserved',
      reservations: null,
      coordinator: owner,
      checkout: { gitCommonDir: identity.gitCommonDir, worktreeGitDir: identity.worktreeGitDir },
      checkoutKey: identity.key,
    };
    state.claims.push(claim);
    return { changed: true, result: { status: 'reserved', claim: projectClaim(claim) } };
  },

  [OPERATIONS.reserveCapacity]: (state, request) => {
    const { packageId, attempt, request: unit, coordinator } = request.args;
    requireString(packageId, 'packageId');
    requireString(attempt, 'attempt');
    const reservations = requireReservations(unit);
    const owner = normalizeCoordinator(coordinator);
    const existing = state.claims.find(claim => claim.kind === 'capacity' && claim.packageId === packageId && claim.attempt === attempt);
    // Replay is idempotent by packageId + attempt: the existing reservation is
    // returned unchanged, so a crash before launch cannot consume another slot.
    if (existing) return { changed: false, result: { status: 'reserved', claim: projectClaim(existing), replayed: true } };
    const queued = capacityDecision(state, normalizeBudgets(request.budgets), reservations);
    if (queued) return { changed: false, result: queued };
    const claim = {
      kind: 'capacity',
      token: newToken(),
      epoch: owner.epoch,
      packageId,
      attempt,
      state: 'reserved',
      reservations,
      coordinator: owner,
    };
    state.claims.push(claim);
    return { changed: true, result: { status: 'reserved', claim: projectClaim(claim), replayed: false } };
  },

  [OPERATIONS.releaseClaim]: (state, request) => {
    const { token, epoch, drain } = request.args;
    const index = state.claims.findIndex(claim => claim.token === token);
    if (index < 0) return { changed: false, result: { status: 'denied', reason: 'token-mismatch' } };
    const claim = state.claims[index];
    if (claim.epoch !== epoch) return { changed: false, result: { status: 'denied', reason: 'epoch-mismatch' } };
    // Capacity slots are only returned on positive drain; timeout, dead owner,
    // changed identity and unknown drain all leave the claim retained.
    if (claim.kind === 'capacity' && drain !== 'confirmed') return { changed: false, result: { status: 'denied', reason: 'drain-unconfirmed' } };
    state.claims.splice(index, 1);
    return { changed: true, result: { status: 'released', claim: projectClaim(claim) } };
  },

  [OPERATIONS.recoverClaims]: (state, request) => {
    const { token, epoch, coordinator } = request.args;
    const claim = state.claims.find(candidate => candidate.token === token);
    if (!claim) return { changed: false, result: { status: 'denied', reason: 'token-mismatch' } };
    if (claim.epoch !== epoch) return { changed: false, result: { status: 'denied', reason: 'epoch-mismatch' } };
    // Recovery only rebinds the coordinator identity; token, epoch and slot are
    // unchanged and nothing is released.
    claim.coordinator = normalizeCoordinator(coordinator);
    return { changed: true, result: { status: 'recovered', claim: projectClaim(claim) } };
  },
};

function capacityDecision(state, budgets, reservations) {
  const active = state.claims.filter(claim => claim.kind === 'capacity');
  if (active.length >= SOFTWARE_CEILING) {
    return { status: 'queued', constraint: { reason: 'software-ceiling', owner: { kind: 'software-ceiling', ceiling: SOFTWARE_CEILING } } };
  }
  const totals = active.reduce((sum, claim) => ({
    memoryBytes: sum.memoryBytes + (claim.reservations?.memoryBytes || 0),
    tasks: sum.tasks + (claim.reservations?.tasks || 0),
  }), { memoryBytes: 0, tasks: 0 });
  if (totals.memoryBytes + reservations.memoryBytes > budgets.memoryBytes) {
    return { status: 'queued', constraint: { reason: 'memory-budget', owner: budgetOwner(active, 'memoryBytes') } };
  }
  if (totals.tasks + reservations.tasks > budgets.tasks) {
    return { status: 'queued', constraint: { reason: 'task-budget', owner: budgetOwner(active, 'tasks') } };
  }
  return null;
}

function budgetOwner(claims, unit) {
  return { kind: 'capacity-budget', unit, holders: claims.map(claim => ({ packageId: claim.packageId, token: claim.token })) };
}

// ---------------------------------------------------------------------------
// Registry storage helpers.
// ---------------------------------------------------------------------------

function readRegistry(registryRoot) {
  let raw;
  try {
    raw = readFileSync(join(registryRoot, REGISTRY_FILE), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { version: REGISTRY_VERSION, claims: [] };
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.claims)) throw new Error('ownership registry is malformed');
  return { version: REGISTRY_VERSION, claims: parsed.claims };
}

function writeRegistry(registryRoot, state) {
  mkdirSync(registryRoot, { recursive: true });
  const file = join(registryRoot, REGISTRY_FILE);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function projectClaim(claim) {
  const liveness = observeLiveness(claim.coordinator);
  return {
    kind: claim.kind,
    token: claim.token,
    epoch: claim.epoch,
    packageId: claim.packageId,
    attempt: claim.attempt ?? null,
    state: claim.state,
    running: liveness === 'alive',
    reservations: claim.reservations ? { memoryBytes: claim.reservations.memoryBytes, tasks: claim.reservations.tasks } : null,
    coordinator: { ...claim.coordinator },
    liveness,
  };
}

// Mirrors scripts/spec-observe/process-identity.mjs: only a live pid with the
// exact observed start text is 'alive'; mismatch or inconclusive is 'unknown'.
function observeLiveness(coordinator) {
  if (!coordinator) return 'unknown';
  const observed = inspectProcess(coordinator.pid);
  if (observed.state === 'dead') return 'dead';
  if (observed.state !== 'alive') return 'unknown';
  return observed.started_at === coordinator.started_at ? 'alive' : 'unknown';
}

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

function normalizeBudgets(budgets) {
  const source = budgets && typeof budgets === 'object' ? budgets : {};
  return {
    memoryBytes: Number.isFinite(source.memoryBytes) ? Number(source.memoryBytes) : Number.POSITIVE_INFINITY,
    tasks: Number.isFinite(source.tasks) ? Number(source.tasks) : Number.POSITIVE_INFINITY,
  };
}

function normalizeCoordinator(coordinator) {
  if (!coordinator || typeof coordinator !== 'object') throw new Error('coordinator identity is required');
  const { session, epoch, pid, started_at } = coordinator;
  requireString(session, 'coordinator.session');
  if (!Number.isSafeInteger(epoch)) throw new Error('coordinator.epoch must be an integer');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('coordinator.pid must be a positive integer');
  requireString(started_at, 'coordinator.started_at');
  return { session, epoch, pid, started_at };
}

function requireReservations(unit) {
  const memoryBytes = unit ? unit.memoryBytes : undefined;
  const tasks = unit ? unit.tasks : undefined;
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 0) throw new Error('request.memoryBytes must be a non-negative integer');
  if (!Number.isSafeInteger(tasks) || tasks < 0) throw new Error('request.tasks must be a non-negative integer');
  return { memoryBytes, tasks };
}

function checkoutIdentity(checkout) {
  if (!checkout || typeof checkout !== 'object') throw new Error('checkout identity is required');
  const gitCommonDir = resolve(requireString(checkout.gitCommonDir, 'checkout.gitCommonDir'));
  const worktreeGitDir = resolve(requireString(checkout.worktreeGitDir, 'checkout.worktreeGitDir'));
  return { gitCommonDir, worktreeGitDir, key: `${gitCommonDir}\u0000${worktreeGitDir}` };
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function newToken() {
  return `claim-${randomBytes(16).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Direct-execution entry point: the flock-guarded mutation child.
// ---------------------------------------------------------------------------

if (isDirectExecution()) {
  runMutationChild().catch(error => {
    process.stderr.write(`${(error && error.stack) || String(error)}\n`);
    process.exitCode = 1;
  });
}

function isDirectExecution() {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return resolve(entry) === MODULE_PATH; } catch { return false; }
}

async function runMutationChild() {
  const operation = process.argv[2];
  const handler = MUTATION_HANDLERS[operation];
  if (!handler) throw new Error(`unknown ownership operation: ${String(operation)}`);
  const request = JSON.parse(readFileSync(0, 'utf8'));
  const registryRoot = requireString(request.registryRoot, 'registryRoot');
  const state = readRegistry(registryRoot);
  const { result, changed } = handler(state, request);
  if (changed) writeRegistry(registryRoot, state);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
