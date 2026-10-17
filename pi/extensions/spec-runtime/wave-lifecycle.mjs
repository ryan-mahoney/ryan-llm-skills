import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { totalmem } from 'node:os';
import { createHash } from 'node:crypto';
import { checkPackage } from '../../../scripts/spec-location/index.mjs';
import { artifactEnvironment } from '../../../scripts/spec-location/artifact-environment.mjs';
import { prepareStepWorkspace, remountRetainedWorkspace, setupIdentity, stagingDigest, resolveBackend } from './step-workspaces.mjs';
import { calculateWaveResourcePolicy } from './wave-resource-policy.mjs';
import { buildOverlayArgv } from './overlay.mjs';

export function environmentFacts(checkout, primary) {
  const roots = [...new Set([checkout, primary].filter(root => typeof root === 'string' && root.length > 0))];
  return { checkout, primary, observed_only: true,
    dependency_paths: roots.flatMap(root => ['deps', 'node_modules'].map(name => join(root, name))).filter(existsSync),
    build_paths: roots.flatMap(root => ['_build', 'dist'].map(name => join(root, name))).filter(existsSync),
    configured_paths: Object.fromEntries(['MIX_DEPS_PATH', 'MIX_BUILD_PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
    next: 'Resolve missing dependencies from these paths or repository setup instructions. Existence is not compatibility or permission to share writable build output. Do not search the filesystem root.' };
}

// Sanitized transport names are the only caller environment submitted to the
// systemd unit (visible in systemd-run argv); the worker's full environment
// travels in a mode-0600 request file read by the fixed root bootstrap.
const TRANSPORT_ENV_NAMES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'TERM'];
function sanitizeTransport(env) {
  return Object.fromEntries(TRANSPORT_ENV_NAMES.filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));
}

// Fixed inline bootstrap for a contained wave root. It carries no caller text:
// the request path is positional and the full environment plus native command
// arrive through a mode-0600 JSON file. It writes the overlay .git pointer when
// asked and then spawns the native command with inherited stdio.
const ROOT_BOOTSTRAP = [
  "const fs = require('fs');",
  "const { spawn } = require('child_process');",
  "const path = require('path');",
  'const requestFile = process.argv[1];',
  'let request;',
  'try { request = JSON.parse(fs.readFileSync(requestFile, "utf8")); }',
  'catch (error) { process.stderr.write("root bootstrap cannot read its request: " + error.message + "\\n"); process.exit(70); }',
  'if (request.gitDir && request.checkout) {',
  '  const pointer = path.join(request.checkout, ".git");',
  '  const expected = "gitdir: " + request.gitDir + "\\n";',
  '  let current = null;',
  '  try { current = fs.readFileSync(pointer, "utf8"); } catch { current = null; }',
  '  if (current !== expected) fs.writeFileSync(pointer, expected);',
  '}',
  'const child = spawn(request.command, request.args, { cwd: request.checkout, env: request.env, stdio: "inherit" });',
  'const forward = signal => { try { child.kill(signal); } catch {} };',
  'process.on("SIGTERM", () => forward("SIGTERM"));',
  'process.on("SIGINT", () => forward("SIGINT"));',
  'child.on("error", error => { process.stderr.write("root bootstrap spawn failed: " + error.message + "\\n"); process.exit(70); });',
  'child.on("exit", code => { process.exit(typeof code === "number" ? code : 70); });',
];

// Runtime supplies its existing persistence, provenance and process plumbing.
// The lifecycle methods execute with the Runtime receiver, retaining its public
// entrypoints and injected adapters without a reverse import of runtime.mjs.
export function createWaveLifecycle({
  read, timestamp, atomic, inside, refusalError, stepTarget,
  waveInvalid, realOrNull, workspaceIdentity, readWaveRecord, waveClaimToken,
  readOwnershipClaimsSync, resolveWaveMemberRequest, assertWaveLease,
  runFileOf, waveFileOf, runLockedMutation, save, nativeCommand, streamTask
}) {
  // The top-level `setup` declaration for a target, defaulting to the empty
  // declaration; normalizeSetup inside setupIdentity rejects anything malformed.
  function targetSetup(packagePath, targetId) {
    let index;
    try { index = read(join(packagePath, 'spec-steps.json')); } catch { return undefined; }
    return index?.setup?.[targetId];
  }

  function declaredEnvironment(setup) {
    if (!setup || setup === 'none' || typeof setup !== 'object' || !Array.isArray(setup.environment)) return [];
    return setup.environment.filter(name => typeof name === 'string');
  }

  function shQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
  }

  // The fixed contained script: run the declared command, then record the frozen
  // base revision and the tracked-clean status of the prepared tree. Only
  // untracked (including ignored) setup output is permitted; a nonzero setup exit
  // is preserved for the coordinator.
  function waveSetupScript({ setup, source, gitDir, receiptFile, headFile, statusFile }) {
    const command = setup && typeof setup === 'object' && typeof setup.command === 'string' && setup.command.trim() !== '' ? setup.command : ':';
    const gitCall = `git --git-dir=${shQuote(gitDir)} --work-tree=${shQuote(source)}`;
    return [
      `( ${command} )`,
      'setup_rc=$?',
      `${gitCall} rev-parse HEAD > ${shQuote(headFile)} 2>/dev/null`,
      'head_rc=$?',
      `${gitCall} status --porcelain --untracked-files=no > ${shQuote(statusFile)} 2>/dev/null`,
      'status_rc=$?',
      `printf '%s %s %s\\n' "$setup_rc" "$head_rc" "$status_rc" > ${shQuote(receiptFile)}`,
      'exit 0',
    ].join('\n');
  }

  function readSetupReceipt({ receiptFile, headFile, statusFile }) {
    if (!existsSync(receiptFile)) return null;
    const [setupExit, headRc, statusRc] = readFileSync(receiptFile, 'utf8').trim().split(/\s+/).map(Number);
    if (![setupExit, headRc, statusRc].every(Number.isInteger)) return null;
    const head = headRc === 0 && existsSync(headFile) ? readFileSync(headFile, 'utf8').trim() : null;
    const status = statusRc === 0 && existsSync(statusFile) ? readFileSync(statusFile, 'utf8') : null;
    return { setup_exit: setupExit, head, tracked_clean: statusRc === 0 && status !== null && status.trim() === '' };
  }

  // Wait for a contained setup child to close, bounded by the durable shared
  // wave deadline. The adapter owns termination; this never signals a pid.
  function waitForSetupClose(child, deadline) {
    return new Promise(resolveClose => {
      if (!child) { resolveClose({ timedOut: false }); return; }
      let settled = false;
      const remaining = Number.isSafeInteger(deadline?.expires_at) ? Math.max(1, deadline.expires_at - Date.now()) : null;
      const timer = remaining === null ? null : setTimeout(() => finish(true), remaining);
      function finish(timedOut) {
        if (settled) return;
        settled = true; clearTimeout(timer); resolveClose({ timedOut });
      }
      child.once('error', () => finish(true));
      child.once('close', () => finish(false));
      if (child.exitCode !== null || child.signalCode !== null) finish(false);
    });
  }

  // The frozen base commit is extracted from the canonical repository without
  // hardlinks and re-homed into a private standalone git dir: no alternates, no
  // .git inside the prepared source tree, so tracked-base validation never
  // touches the canonical checkout.
  function buildWaveStaging({ targetCommon, baseCommit, source, gitDir }) {
    mkdirSync(source, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    const run = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
    const archive = spawnSync('git', ['-c', 'tar.umask=0022', '-C', targetCommon, 'archive', '--format=tar', baseCommit], { maxBuffer: 256 * 1024 * 1024 });
    if (archive.error || archive.status !== 0)
      throw waveInvalid('wave-staging-archive', 'Could not archive the frozen wave base commit.', 'Verify the wave base commit and canonical checkout.');
    const extract = spawnSync('tar', ['-x', '-p', '-f', '-', '-C', source], { input: archive.stdout, maxBuffer: 256 * 1024 * 1024 });
    if (extract.error || extract.status !== 0)
      throw waveInvalid('wave-staging-extract', 'Could not extract the frozen wave base tree.', 'Verify the runtime staging root is writable.');
    run(['init', '--bare', '--quiet', gitDir]);
    run(['--git-dir', gitDir, 'config', 'core.bare', 'false']);
    run(['--git-dir', gitDir, 'config', 'core.worktree', source]);
    run(['--git-dir', gitDir, 'config', 'core.fileMode', 'true']);
    run(['--git-dir', gitDir, 'fetch', '--no-tags', '--quiet', targetCommon, '+refs/heads/*:refs/remotes/origin/*']);
    run(['--git-dir', gitDir, 'cat-file', '-e', `${baseCommit}^{commit}`]);
    run(['--git-dir', gitDir, 'update-ref', 'HEAD', baseCommit]);
    run(['--git-dir', gitDir, '--work-tree', source, 'read-tree', baseCommit]);
  }

  function gitList(gitDir, source, extra) {
    const output = execFileSync('git', ['--git-dir', gitDir, '--work-tree', source, 'ls-files', ...extra, '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return output.split('\0').filter(Boolean);
  }

  // Only untracked output (including ignored dependencies) moves into the
  // dependencies staging; the source tree remains byte-for-byte the tracked base
  // tree validated by the contained setup.
  function partitionUntracked({ gitDir, source, dependencies }) {
    mkdirSync(dependencies, { recursive: true });
    const moved = new Set([...gitList(gitDir, source, ['--others', '--exclude-standard']),
      ...gitList(gitDir, source, ['--others', '--ignored', '--exclude-standard'])]);
    for (const rel of moved) {
      const from = join(source, rel);
      try { lstatSync(from); } catch { continue; }
      const to = join(dependencies, rel);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
  }

  return {
  // A contained wave root reserves capacity and binds the shared wave deadline
  // before the adapter registers durable service identity. An unknown or failed
  // start throws with the truthful blocked state; there is no plain-spawn fallback.
  async containedRoot(record, prompt) {
    const binding = record.wave_bindings;
    const adapter = this.serviceAdapter;
    const heldClaims = readOwnershipClaimsSync(this.ownershipRoot).filter(claim => claim.kind === 'capacity');
    const policy = calculateWaveResourcePolicy({ physicalMemoryBytes: totalmem(),
      held: { memoryBytes: heldClaims.reduce((total, claim) => total + (claim.reservations?.memoryBytes || 0), 0),
        tasks: heldClaims.reduce((total, claim) => total + (claim.reservations?.tasks || 0), 0) } });
    const reserved = await this.ownership.reserveCapacity({ packageId: binding.package_ref,
      attempt: `${binding.wave_id}:${binding.attempt_id}:${binding.phase}`,
      request: { memoryBytes: policy.lifecycleMemoryBytes, tasks: policy.lifecycleTasks },
      coordinator: binding.coordinator });
    // The registry mutation returns its result object directly; a queued decision
    // is a truthful refusal, not a claim to fabricate from an empty wrapper.
    if (reserved?.status === 'queued')
      throw waveInvalid('wave-capacity-queued', `Capacity reservation was refused (${reserved.constraint?.reason || 'queued'}); the run stays blocked and no worker started.`, 'Wait for capacity to drain or reduce the requested lifecycle budget, then relaunch.');
    const claim = reserved?.claim;
    if (reserved?.status !== 'reserved' || !claim || typeof claim.token !== 'string')
      throw waveInvalid('wave-capacity-failed', `Capacity reservation was not confirmed (${reserved?.status || 'unknown'}); the run stays blocked and no worker started.`, 'Recover the wave capacity claim and relaunch.');
    record.capacity_claim = { token: claim.token, epoch: claim.epoch, attempt: claim.attempt ?? binding.attempt_id };
    record.deadline = await this.ensureWaveDeadline(record);
    const { command, args, stream, errors } = nativeCommand(record, 'owner',
      `${prompt}\nEnvironment paths (observations, not setup approval): ${JSON.stringify(record.environment)}`);
    const workerEnv = { ...process.env, ...artifactEnvironment(record.package), SPEC_RUNTIME_ROLE: 'owner',
      SPEC_RUNTIME_RECORD: runFileOf(record), PI_INTERCOM_SCOPE_ID: record.id, PI_INTERCOM_STABLE_ID: `spec-owner-${record.id}` };
    // The full environment (which may hold secrets) stays in a mode-0600 file;
    // only sanitized transport names travel in the unit's argv.
    record.service_request = join(record.package, 'runtime/runs', `${record.id}-owner-request.json`);
    writeFileSync(record.service_request, JSON.stringify({ env: workerEnv, command, args,
      checkout: record.checkout, gitDir: binding.layers?.gitDir ?? null }), { mode: 0o600 });
    const bootstrap = [process.execPath, '-e', ROOT_BOOTSTRAP.join('\n'), record.service_request];
    const argv = binding.layers ? buildOverlayArgv({ token: binding.claim_token, lower: binding.layers.lower,
      upper: binding.layers.upper, work: binding.layers.work, merged: binding.layers.merged, chdir: record.checkout, command: bootstrap }).argv : bootstrap;
    const transport = sanitizeTransport(process.env);
    const started = await adapter.start({ argv, cwd: record.checkout, env: transport, deadline: record.deadline, limits: policy,
      register: serviceRecord => { record.service = serviceRecord; save(record); assertWaveLease(record); return true; } });
    record.service = started?.record ?? record.service;
    if (!started || started.ok !== true || !started.child) {
      save(record);
      throw waveInvalid('wave-service-refused', `Contained service launch was not confirmed (${started?.reason || started?.status || 'unknown'}); the run stays blocked and no worker started.`, 'Repair the host or wave binding and relaunch.');
    }
    save(record);
    const state = { service: record.service ?? null };
    const task = streamTask(record, 'owner', started.child, { onEvent: this.onWorkerEvent,
      stopSettledGroup: async () => {
        if (!state.service) return false;
        // Only a confirmed stop is cleanup authority; "stop-requested" is not drain proof.
        const stopped = await adapter.stop(state.service, { env: transport, ownershipVerified: true });
        return stopped?.status === 'confirmed';
      } }, { stream, errors });
    task.service = state.service;
    const mainPid = Number.isSafeInteger(started.main_pid) ? started.main_pid
      : (Number.isSafeInteger(started.record?.main_pid) ? started.record.main_pid : null);
    task.workerPid = mainPid;
    return task;
  },

  async ensureWaveDeadline(record) {
    const binding = record.wave_bindings;
    const timeoutMs = Number.isSafeInteger(record.timeout_ms) && record.timeout_ms >= 1000 && record.timeout_ms <= 86400000
      ? record.timeout_ms : undefined;
    const result = await runLockedMutation(`${waveFileOf(record)}.lock`, 'ensure-wave-deadline', {
      file: waveFileOf(record), generation: binding.generation, claimToken: binding.claim_token,
      coordinatorEpoch: binding.coordinator_epoch, timeoutMs });
    if (!result || result.ok !== true || !result.deadline)
      throw waveInvalid(result?.code || 'wave-deadline-failed', result?.message || 'Could not bind the shared wave deadline.', 'Repair the wave record and relaunch.');
    return result.deadline;
  },

  // The single contained-root release path. A cancellation stops the service; a
  // normal finish drains it. Only a positively confirmed outcome is proof:
  // systemd's "stop requested" or an inspect error is not drain. A confirmed
  // drain writes its external receipt first, then releases this run's own
  // capacity and checkout claims (never the wave package claim) while the
  // recorded layer identity stays on the durable run and wave records.
  async drainContainedService(record, { cancel = false } = {}) {
    const adapter = this.serviceAdapter;
    const binding = record.wave_bindings;
    const service = record.service;
    if (!service) return { status: 'unknown', reason: 'no-service-record' };
    const transport = sanitizeTransport(process.env);
    const outcome = cancel
      ? await adapter.stop(service, { env: transport, ownershipVerified: true })
      : await adapter.drain(service, { env: transport, ownershipVerified: true });
    if (outcome?.status !== 'confirmed') return outcome;
    const receiptFile = join(record.package, 'runtime', 'runs', `${record.id}-phase-drain.json`);
    // A retry from the same run preserves the prior receipt's released list so
    // an already-returned claim is never released twice.
    const released = [];
    try {
      const prior = existsSync(receiptFile) ? read(receiptFile) : null;
      if (prior && prior.run_id === record.id && Array.isArray(prior.released))
        for (const item of prior.released)
          if (item && typeof item.token === 'string' && item.epoch !== undefined) released.push(item);
    } catch { /* an unreadable prior receipt is rebuilt from the claims */ }
    const receipt = () => ({ schema_version: 1, run_id: record.id, wave_id: binding?.wave_id ?? null,
      attempt_id: binding?.attempt_id ?? null, phase: binding?.phase ?? null, status: 'confirmed',
      service: service ?? null, layers: binding?.layers ?? null, observed_at: timestamp(), released });
    // Persist the drain proof before any claim can be returned.
    atomic(receiptFile, receipt());
    record.phase_drain = { path: receiptFile, status: 'confirmed' };
    save(record);
    const release = async (kind, token, epoch) => {
      if (released.some(item => item.token === token && String(item.epoch) === String(epoch))) return;
      const returned = await this.ownership.releaseClaim({ token, epoch, drain: 'confirmed' });
      if (returned?.status !== 'released')
        throw new Error(`${kind} claim release was not confirmed (${returned?.reason || returned?.status || 'unknown'}); drain proof is retained and the claim stays reserved.`);
      released.push({ kind, token, epoch });
      atomic(receiptFile, receipt());
    };
    if (record.capacity_claim?.token)
      await release('capacity', record.capacity_claim.token, record.capacity_claim.epoch);
    if (binding?.checkout_claim)
      await release('checkout', binding.checkout_claim, binding.checkout_claim_epoch);
    save(record);
    return outcome;
  },

  // Prepare one wave member's retained workspace from the durable wave target
  // policy and return a preparation receipt. The caller supplies only the
  // membership identity used by start(); backend, capability, setup command,
  // layers, target and base all come from the wave record and the step card.
  // This provisions a workspace; it neither accepts a step nor advances a
  // phase. A confirmed setup drain and an honest tracked-clean base are the
  // only authority to publish; any unknown or failed outcome keeps the attempt,
  // capacity, service and staging durable and blocks the member.
  async prepareWaveMember(input) {
    if (process.platform === 'win32') throw new Error('spec-runtime requires POSIX process groups');
    if (!input || typeof input !== 'object') throw new Error('prepareWaveMember requires an input object');
    const checked = await checkPackage(input.package, this.location);
    if (!checked.ok) throw refusalError(checked);
    const locations = checked.locations;
    const packagePath = realpathSync(locations.package_dir);
    const packageRef = locations.package_ref;
    const step = realpathSync(input.step);
    if (!inside(packagePath, step)) throw new Error('step must be inside the package');
    const target = stepTarget(locations, packagePath, step);

    // All identity checks fire before any filesystem effect: version, package,
    // single target, base commit, generation, member attempt and phase.
    const { record, claimToken, epoch, member, coordinator } = resolveWaveMemberRequest(input, { packagePath, packageRef, target }, this.ownershipRoot);
    const baseCommit = record.target.base_commit;
    const common = realOrNull(record.target.common);
    if (!common)
      throw waveInvalid('wave-source-missing', 'Wave target records no canonical source common dir.', 'Record target.common.');
    const waveFile = join(packagePath, 'runtime', 'waves', `${input.wave_id}.json`);

    // An already-prepared member of the same identity returns only a live,
    // claimed workspace. A stale or half-built record is refused, never
    // silently accepted and never overwritten.
    if (member.workspace !== undefined && member.workspace !== null) {
      const identity = workspaceIdentity(member.workspace);
      if (identity.baseCommit !== baseCommit)
        throw waveInvalid('wave-base-mismatch', 'Wave member workspace base commit does not match the target base.', 'Provision the member at the wave target base.');
      if (identity.packageId !== null && identity.packageId !== packageRef)
        throw waveInvalid('wave-workspace-package', 'Wave member workspace package does not match the wave package.', 'Bind the member workspace to this package.');
      const live = readOwnershipClaimsSync(this.ownershipRoot).some(claim => claim.kind === 'checkout'
        && claim.token === identity.claim.token && String(claim.epoch) === String(identity.claim.epoch) && claim.packageId === packageRef);
      if (!live)
        throw waveInvalid('wave-checkout-claim', 'No live checkout claim matches the retained workspace.', 'Re-provision or recover the member workspace claim.');
      return { status: 'prepared', idempotent: true, wave_id: input.wave_id, step_number: input.step_number,
        attempt_id: input.attempt_id, phase: input.phase, workspace: member.workspace,
        preparation_receipt: member.preparation_receipt ?? null };
    }

    // Backend and capability are durable wave target policy only. The caller
    // cannot override either; an unsupported or missing capability is refused
    // here, before any staging directory exists.
    const mode = record.target.backend ?? 'auto';
    const capability = record.target.capability ?? null;
    resolveBackend({ mode, capability });

    const canonicalTarget = realpathSync(target.worktree || target.primary);
    const waveRoot = join(this.indexDir, 'wave-workspaces',
      createHash('sha256').update(packageRef).digest('hex').slice(0, 24), input.wave_id);
    if (waveRoot === canonicalTarget || inside(canonicalTarget, waveRoot))
      throw waveInvalid('wave-staging-in-target', 'Wave staging root would resolve inside the canonical target.', 'Choose a runtime index outside the canonical checkout.');
    const stagingRoot = join(waveRoot, 'staging', input.attempt_id);
    const source = join(stagingRoot, 'source');
    const dependencies = join(stagingRoot, 'dependencies');
    const gitDir = join(stagingRoot, 'git');
    const receiptFile = join(stagingRoot, 'preparation-receipt.json');
    const headFile = join(stagingRoot, 'setup-head');
    const statusFile = join(stagingRoot, 'setup-status');
    const setupReceiptFile = join(stagingRoot, 'setup-receipt');

    // Freeze the declared setup and compute the identical snapshot identity the
    // retained snapshot binds. normalizeSetup refuses a malformed declaration
    // before any staging or claim exists.
    const setup = targetSetup(packagePath, target.id);
    if (setup === undefined)
      throw waveInvalid('wave-setup-missing', `Target ${target.id} declares no setup in spec-steps.json.`, 'Declare a setup block for the target before preparing the member.');
    const { snapshotId } = setupIdentity({ baseCommit, setup, targetRoot: canonicalTarget });
    for (const name of declaredEnvironment(setup)) {
      if (typeof process.env[name] !== 'string')
        throw waveInvalid('wave-env-missing', `Declared setup environment variable is absent: ${name}.`, 'Export the declared setup environment before preparing the member.');
    }

    // A durable setup intent marks an in-flight attempt. An unresolved intent
    // refuses a retry before any staging is rebuilt; the active source,
    // dependencies and untracked setup output are never reset.
    const intentFile = join(stagingRoot, 'setup-intent.json');
    const priorIntent = existsSync(intentFile) ? read(intentFile) : null;
    if (priorIntent && priorIntent.status !== 'confirmed')
      throw waveInvalid('wave-setup-intent-unresolved', 'A previous setup attempt for this member is unresolved; refusing to reset its active staging.', 'Inspect or recover the existing setup service, then re-run preparation.');

    // From here the attempt is durable. Build the runtime-owned staging and
    // then reserve phase-specific capacity before the contained setup starts.
    buildWaveStaging({ targetCommon: common, baseCommit, source, gitDir });
    const waveStaging = { worktree: canonicalTarget, gitCommonDir: common };
    const heldClaims = readOwnershipClaimsSync(this.ownershipRoot).filter(claim => claim.kind === 'capacity');
    const policy = calculateWaveResourcePolicy({ physicalMemoryBytes: totalmem(),
      held: { memoryBytes: heldClaims.reduce((total, claim) => total + (claim.reservations?.memoryBytes || 0), 0),
        tasks: heldClaims.reduce((total, claim) => total + (claim.reservations?.tasks || 0), 0) } });
    const reserved = await this.ownership.reserveCapacity({ packageId: packageRef, attempt: `${input.wave_id}:${input.attempt_id}:setup`,
      request: { memoryBytes: policy.lifecycleMemoryBytes, tasks: policy.lifecycleTasks },
      coordinator });
    if (reserved?.status === 'queued')
      throw waveInvalid('wave-capacity-queued', `Setup capacity reservation was refused (${reserved.constraint?.reason || 'queued'}); the member stays blocked and no setup ran.`, 'Wait for capacity to drain then re-run preparation.');
    const capacityClaim = reserved?.claim;
    if (reserved?.status !== 'reserved' || !capacityClaim || typeof capacityClaim.token !== 'string')
      throw waveInvalid('wave-capacity-failed', `Setup capacity reservation was not confirmed (${reserved?.status || 'unknown'}); the member stays blocked and no setup ran.`, 'Recover the wave capacity claim then re-run preparation.');

    const setupIntent = { schema_version: 1, wave_id: input.wave_id, attempt_id: input.attempt_id, phase: input.phase,
      setup, snapshot_id: snapshotId, capacity: { token: capacityClaim.token, epoch: capacityClaim.epoch },
      status: 'launching', created_at: timestamp() };
    atomic(intentFile, setupIntent);

    let published = false;
    try {
      const deadline = await this.ensureWaveDeadline({ wave_bindings: { generation: record.generation, claim_token: claimToken, coordinator_epoch: epoch }, wave_path: waveFile });
      const transport = sanitizeTransport(process.env);
      const script = waveSetupScript({ setup, source, gitDir, receiptFile: setupReceiptFile, headFile, statusFile });
      const requestFile = join(stagingRoot, 'setup-request.json');
      writeFileSync(requestFile, JSON.stringify({ env: { ...process.env, ...artifactEnvironment(packagePath), SPEC_RUNTIME_ROLE: 'setup' },
        command: '/bin/bash', args: ['-o', 'pipefail', '-c', script], checkout: source }), { mode: 0o600 });
      const argv = [process.execPath, '-e', ROOT_BOOTSTRAP.join('\n'), requestFile];
      // Durable service identity must be registered before the authorization
      // gate opens; only sanitized transport travels in the unit argv. The
      // registration rechecks the durable wave identity and the live package
      // and capacity claims, so a revoked lease never authorizes a bootstrap.
      const started = await this.serviceAdapter.start({ argv, cwd: source, env: transport, deadline, limits: policy,
        register: serviceRecord => {
          atomic(join(stagingRoot, 'service.json'), serviceRecord);
          const current = readWaveRecord(packagePath, input.wave_id);
          if (current.generation !== record.generation || waveClaimToken(current) !== claimToken
            || String(current.coordinator?.epoch) !== String(epoch)) return false;
          const live = readOwnershipClaimsSync(this.ownershipRoot);
          const packageLive = live.some(claim => claim.kind === 'package' && claim.packageId === packageRef && claim.token === claimToken);
          const capacityLive = live.some(claim => claim.kind === 'capacity' && claim.token === capacityClaim.token && String(claim.epoch) === String(capacityClaim.epoch));
          return packageLive && capacityLive;
        } });
      const service = started?.record ?? null;
      if (!started || started.ok !== true || !service)
        throw waveInvalid('wave-service-refused', `Setup service launch was not confirmed (${started?.reason || started?.status || 'unknown'}); the member stays blocked and no setup ran.`, 'Repair the host or wave binding and re-run preparation.');
      // Consume the setup transport into a runtime-owned log and wait for the
      // contained child to close under the shared wave deadline before asking
      // the adapter to drain; an immediate drain cannot observe a healthy
      // long-running setup and would mislabel it unknown.
      const setupLog = join(stagingRoot, 'setup.log');
      const appendSetupLog = chunk => appendFileSync(setupLog, chunk, { mode: 0o600 });
      started.child?.stdout?.on('data', appendSetupLog);
      started.child?.stderr?.on('data', appendSetupLog);
      const setupClose = await waitForSetupClose(started.child, deadline);
      if (setupClose.timedOut) {
        // The adapter owns termination. A confirmed stop keeps the member
        // blocked without publishing; an unconfirmed stop retains everything.
        const stopped = await this.serviceAdapter.stop(service, { env: transport, ownershipVerified: true });
        if (stopped?.status !== 'confirmed')
          throw waveInvalid('wave-setup-unconfirmed', `Contained setup exceeded the shared wave deadline and did not report a confirmed stop (${stopped?.reason || stopped?.status || 'unknown'}); the member stays blocked and its capacity claim is retained.`, 'Inspect the contained setup service, then re-run preparation.');
        throw waveInvalid('wave-setup-timeout', 'Contained setup exceeded the shared wave deadline; the member stays blocked and its capacity claim is retained.', 'Inspect the contained setup output, then re-run preparation.');
      }
      const drained = await this.serviceAdapter.drain(service, { env: transport, ownershipVerified: true });
      if (!drained || drained.status !== 'confirmed')
        throw waveInvalid('wave-setup-unconfirmed', `Setup service did not report a confirmed drain (${drained?.status || drained?.reason || 'unknown'}); the member stays blocked and no snapshot was published.`, 'Inspect the contained setup service, then re-run preparation.');
      // Only a confirmed drain authorizes reading the contained receipt.
      const setupResult = readSetupReceipt({ receiptFile: setupReceiptFile, headFile, statusFile });
      if (!setupResult)
        throw waveInvalid('wave-setup-unconfirmed', 'Contained setup left no readable receipt; the member stays blocked and no snapshot was published.', 'Inspect the contained setup service, then re-run preparation.');
      if (setupResult.setup_exit !== 0)
        throw waveInvalid('wave-setup-failed', `Contained setup exited ${setupResult.setup_exit}; the member stays blocked and no snapshot was published.`, 'Inspect the contained setup output, then re-run preparation.');
      if (setupResult.head !== baseCommit)
        throw waveInvalid('wave-setup-head', 'Contained setup did not leave the frozen base commit checked out.', 'Re-run preparation against the recorded wave base.');
      if (!setupResult.tracked_clean)
        throw waveInvalid('wave-setup-tracked', 'Contained setup changed tracked files; no snapshot was published.', 'Repair the setup command so it only produces untracked dependency output.');
      partitionUntracked({ gitDir, source, dependencies });
      const staging = { source, dependencies };
      const receipt = { ok: true, drain: 'confirmed', baseCommit, trackedClean: true, snapshotId, stagingDigest: stagingDigest(staging) };
      atomic(receiptFile, receipt);
      const workspace = await prepareStepWorkspace({ packageId: packageRef, attemptId: input.attempt_id, baseCommit,
        waveRoot, target: waveStaging, ownership: this.ownership, mode, capability, setup, env: process.env,
        phaseToken: `${input.wave_id}:${input.attempt_id}:${input.phase}`, coordinator,
        preparationReceipt: receipt, staging });
      const persisted = await runLockedMutation(`${waveFile}.lock`, 'persist-wave-member-workspace',
        { file: waveFile, generation: record.generation, claimToken, coordinatorEpoch: epoch,
          stepNumber: input.step_number, attemptId: input.attempt_id, phase: input.phase, workspace, receipt });
      if (!persisted || persisted.ok !== true)
        throw waveInvalid(persisted?.code || 'wave-workspace-persist', persisted?.message || 'Could not persist the prepared member workspace.', 'Repair the wave record then re-run preparation.');
      published = true;
      return { status: 'prepared', idempotent: false, wave_id: input.wave_id, step_number: input.step_number,
        attempt_id: input.attempt_id, phase: input.phase, workspace, preparation_receipt: receipt };
    } finally {
      // Only a confirmed drain plus a published snapshot releases the setup
      // capacity; the package claim is never touched.
      if (published) {
        const returned = await this.ownership.releaseClaim({ token: capacityClaim.token, epoch: capacityClaim.epoch, drain: 'confirmed' });
        if (returned?.status !== 'released')
          throw new Error(`setup capacity claim release was not confirmed (${returned?.reason || returned?.status || 'unknown'}); the claim stays reserved.`);
      }
    }
  },

  // Remount a retained step workspace whose previous run positively drained for
  // this exact membership. The caller supplies only the membership identity used
  // by start(); paths, command, backend and layers come from the durable member
  // and the durable drain receipt. Nothing is recreated, deleted or converted:
  // a dirty workspace is re-claimed byte-for-byte, the previous run binding is
  // cleared under the wave lock only after revalidation, and a later Runtime.start
  // drives the current phase normally. No recovered pid is ever an authority.
  async remountWaveMember(input) {
    if (process.platform === 'win32') throw new Error('spec-runtime requires POSIX process groups');
    if (!input || typeof input !== 'object') throw new Error('remountWaveMember requires an input object');
    const checked = await checkPackage(input.package, this.location);
    if (!checked.ok) throw refusalError(checked);
    const locations = checked.locations;
    const packagePath = realpathSync(locations.package_dir);
    const packageRef = locations.package_ref;
    const step = realpathSync(input.step);
    if (!inside(packagePath, step)) throw new Error('step must be inside the package');
    const target = stepTarget(locations, packagePath, step);
    const { record, claimToken, epoch, member, candidate, coordinator } = resolveWaveMemberRequest(input, { packagePath, packageRef, target }, this.ownershipRoot);
    const waveFile = join(packagePath, 'runtime', 'waves', `${input.wave_id}.json`);

    const workspace = candidate ? record.target.integration.workspace : member.workspace;
    if (!workspace || typeof workspace !== 'object' || !workspace.retained)
      throw waveInvalid('wave-remount-unprepared', 'Wave member has no retained workspace to remount.', 'Prepare the member workspace before remounting.');
    const retained = workspace.retained;
    const identity = workspaceIdentity(workspace);

    const claims = readOwnershipClaimsSync(this.ownershipRoot);
    const currentlyLive = claims.some(claim => claim.kind === 'checkout' && claim.token === identity.claim.token
      && String(claim.epoch) === String(identity.claim.epoch) && claim.packageId === packageRef);
    // Idempotent: an already-remounted member holds a live claim with the
    // previous run cleared, so a replay never re-remounts.
    if (currentlyLive && (member.run_id === undefined || member.run_id === null))
      return { status: 'prepared', remounted: true, idempotent: true, wave_id: input.wave_id,
        step_number: input.step_number, attempt_id: input.attempt_id, phase: input.phase, workspace };

    const previousRunId = candidate ? record.target.repair.run_id : member.run_id;
    if (typeof previousRunId !== 'string' || previousRunId === '')
      throw waveInvalid('wave-remount-run', 'Wave member names no previous run to remount.', 'Drain the previous phase before remounting.');
    let previousRun;
    try { previousRun = read(join(packagePath, 'runtime', 'runs', `${previousRunId}.json`)); }
    catch { throw waveInvalid('wave-remount-run', 'The previous member run record is unavailable.', 'Recover the drained run record before remounting.'); }
    const binding = previousRun.wave_bindings;
    if (!binding || binding.wave_id !== input.wave_id || binding.attempt_id !== input.attempt_id
      || Number(binding.step_number) !== input.step_number || binding.generation !== record.generation
      || binding.package_ref !== packageRef)
      throw waveInvalid('wave-remount-run', 'The previous run binding does not match the member identity.', 'Remount the drained run named by the member.');
    const drainRef = previousRun.phase_drain;
    if (!drainRef || drainRef.status !== 'confirmed' || typeof drainRef.path !== 'string' || !drainRef.path)
      throw waveInvalid('wave-remount-drain', 'The previous run has no confirmed phase drain receipt.', 'Drain the previous phase before remounting.');
    let drain;
    try { drain = read(drainRef.path); }
    catch { throw waveInvalid('wave-remount-drain', 'The durable phase drain receipt cannot be read.', 'Recover the drain receipt before remounting.'); }
    // The drain receipt proves the previous run's own phase drained; the current
    // durable member phase is validated independently and never advanced here.
    if (drain.status !== 'confirmed' || drain.run_id !== previousRunId || drain.wave_id !== input.wave_id
      || drain.attempt_id !== input.attempt_id || drain.phase !== binding.phase)
      throw waveInvalid('wave-remount-drain', 'The phase drain receipt is not confirmed for the retained workspace.', 'Recover the confirmed drain receipt before remounting.');
    if (JSON.stringify(drain.service ?? null) !== JSON.stringify(previousRun.service ?? null))
      throw waveInvalid('wave-remount-drain', 'The phase drain receipt names a different contained service.', 'Remount only the drained phase service.');
    const layers = drain.layers && typeof drain.layers === 'object' ? drain.layers : null;
    if (layers && layers.upper !== undefined && retained.upper !== undefined && layers.upper !== retained.upper)
      throw waveInvalid('wave-remount-layers', 'The phase drain receipt names a different workspace upper.', 'Remount only the drained workspace.');
    if (layers && layers.worktree !== undefined && retained.worktree !== undefined && layers.worktree !== retained.worktree)
      throw waveInvalid('wave-remount-layers', 'The phase drain receipt names a different workspace worktree.', 'Remount only the drained workspace.');
    const released = Array.isArray(drain.released) ? drain.released : [];
    const bindingCandidate = binding.candidate ?? null;
    if (bindingCandidate !== (candidate ?? null))
      throw waveInvalid('wave-remount-candidate', 'The previous run binding names a different candidate than the remount.', 'Remount the drained run named by the selected candidate.');
    const prior = identity.claim;
    if (!released.some(item => item && item.kind === 'checkout' && item.token === prior.token && String(item.epoch) === String(prior.epoch)))
      throw waveInvalid('wave-remount-claim', 'The confirmed drain did not release the retained checkout claim.', 'Remount only from a confirmed drain of the retained claim.');
    if (currentlyLive)
      throw waveInvalid('wave-remount-held', 'The retained checkout claim is still held by a live holder.', 'Wait for the previous phase claim to drain.');

    const phaseToken = `${input.wave_id}:${input.attempt_id}:${input.phase}`;
    let remounted;
    if (retained.backend === 'worktree') {
      // Fallback backend: re-reserve the attempt under the same canonical
      // synthetic upper keys the fallback has always used, never the real
      // worktree gitdir, so the retained worktree bytes are untouched.
      const attemptRoot = dirname(retained.worktree);
      const reserved = await this.ownership.reserveCheckout({ packageId: packageRef, attempt: phaseToken,
        checkout: { gitCommonDir: join(attemptRoot, 'upper'), worktreeGitDir: join(attemptRoot, 'upper') },
        coordinator });
      if (!reserved || reserved.status !== 'reserved' || !reserved.claim || typeof reserved.claim.token !== 'string')
        throw waveInvalid('wave-remount-claim', `Fallback checkout re-reservation was not confirmed (${reserved?.status || 'unknown'}).`, 'Recover the ownership registry and retry the remount.');
      remounted = { ...workspace, claim: { token: reserved.claim.token, epoch: reserved.claim.epoch } };
    } else {
      const expected = { lower: retained.lower, upper: retained.upper, work: retained.work,
        merged: retained.merged, gitDir: retained.gitDir, baseCommit: retained.baseCommit, snapshotId: retained.snapshotId };
      const remountWaveRoot = dirname(dirname(dirname(retained.upper)));
      const result = await remountRetainedWorkspace({ retained, expected, previous: prior, phaseToken,
        coordinator, ownership: this.ownership,
        request: { backend: retained.backend, snapshotId: retained.snapshotId, baseCommit: retained.baseCommit,
          attemptId: input.attempt_id, waveRoot: remountWaveRoot } });
      remounted = { ...workspace, ...result, claim: result.claim,
        retained: result.retained ?? retained, packageId: workspace.packageId ?? packageRef,
        setup: result.setup ?? workspace.setup };
    }

    const persisted = await runLockedMutation(`${waveFile}.lock`, 'remount-wave-member', {
      file: waveFile, generation: record.generation, claimToken, coordinatorEpoch: epoch,
      stepNumber: input.step_number, attemptId: input.attempt_id, phase: input.phase,
      previousRunId, retained, workspace: remounted, ...(candidate !== null ? { candidate } : {}) });
    if (!persisted || persisted.ok !== true)
      throw waveInvalid(persisted?.code || 'wave-remount-persist', persisted?.message || 'Could not persist the remounted member workspace.', 'Repair the wave record then re-run the remount.');
    return { status: 'prepared', remounted: true, idempotent: persisted.idempotent === true,
      wave_id: input.wave_id, step_number: input.step_number, attempt_id: input.attempt_id,
      phase: input.phase, workspace: remounted };
  },

  };
}
