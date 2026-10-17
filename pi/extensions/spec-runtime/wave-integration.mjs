import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordVerification } from './completion.mjs';
import { createOverlayPhases } from './overlay.mjs';
import { importSealedHead, prepareCandidateWorkspace, remountRetainedWorkspace } from './step-workspaces.mjs';
import { resumeIntegrationRepair } from './wave-integration-recovery.mjs';
const GIT_RUN = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const GIT_TIMEOUT_MS = 60_000;
const WAVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const RETENTION_REF_PREFIX = 'refs/waves/retained/';
const candidateRef = waveId => `${RETENTION_REF_PREFIX}${waveId}/candidate`;
const memberKey = m => ({ step: Number(m.step), sealed_head: m.sealedHead, retention_ref: m.retentionRef });
function refuse(reason, detail) { throw Object.assign(new Error(detail ? `${reason}: ${detail}` : reason), { code: 'integration-refusal', reason }); }
function requireString(value, label) { if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`); return value; }
function requireSha(value, label) { if (typeof value !== 'string' || !SHA_PATTERN.test(value)) refuse('sha-invalid', `${label} must be a full SHA`); return value; }
function requireWaveId(value) {
  requireString(value, 'waveId');
  if (!WAVE_ID_PATTERN.test(value)) refuse('wave-id-invalid', `wave id ${JSON.stringify(value)} does not match ${WAVE_ID_PATTERN}`);
  if (runGit(['check-ref-format', candidateRef(value)]).status !== 0) refuse('wave-id-invalid', `wave id ${JSON.stringify(value)} is not a valid ref`);
  return value;
}
function runGit(args, options = {}) {
  try { return { status: 0, stdout: execFileSync('git', args, { ...GIT_RUN, timeout: GIT_TIMEOUT_MS, ...options }) ?? '', stderr: '' }; }
  catch (error) {
    if (error && typeof error.status === 'number') return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error };
    return { status: 'spawn-error', stdout: '', stderr: String(error?.message ?? error), error };
  }
}
function gitMaybe(repo, args) { const result = runGit(['-C', repo, ...args]); return result.status !== 0 ? null : String(result.stdout).trim(); }
const isTreeObject = (repo, sha) => typeof sha === 'string' && SHA_PATTERN.test(sha) && gitMaybe(repo, ['cat-file', '-t', sha]) === 'tree';
// A promotion must never ride on an ignored path that differs between the
// candidate tree and the canonical checkout: materialization cannot account for
// ignored bytes, so an equal path or a segment-prefix ancestor in either
// direction blocks. Non-zero git status is an observation we could not make.
function promotionCollision(repo, candidate) {
  const ignored = runGit(['-C', repo, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  if (ignored.status !== 0) return { unknown: true };
  const candidateFiles = runGit(['-C', repo, 'ls-tree', '-r', '--name-only', '-z', candidate]);
  if (candidateFiles.status !== 0) return { unknown: true };
  const ignoredPaths = String(ignored.stdout ?? '').split('\0').filter(Boolean);
  const candidatePaths = String(candidateFiles.stdout ?? '').split('\0').filter(Boolean);
  for (const ignoredPath of ignoredPaths) {
    for (const candidatePath of candidatePaths) {
      if (candidatePath === ignoredPath || candidatePath.startsWith(`${ignoredPath}/`) || ignoredPath.startsWith(`${candidatePath}/`)) return { collision: true, ignored: ignoredPath };
    }
  }
  return null;
}
export function readWaveRecord(path) {
  requireString(path, 'recordPath');
  if (!existsSync(path)) refuse('journal-missing', `no wave record at ${path}`);
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { refuse('journal-corrupt', `wave record ${path} is not valid JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) refuse('journal-corrupt', `wave record ${path} is not an object`);
  if (parsed.target != null && (typeof parsed.target !== 'object' || Array.isArray(parsed.target))) refuse('journal-corrupt', `wave record ${path} has a non-object target`);
  if (!Number.isInteger(parsed.revision)) refuse('journal-corrupt', `wave record ${path} has no integer revision`);
  if (typeof parsed.wave_id !== 'string' || !WAVE_ID_PATTERN.test(parsed.wave_id)) refuse('journal-corrupt', `wave record ${path} has no valid wave_id`);
  return parsed;
}
export function updateWaveRecord(path, { expectedRevision }, mutate) {
  requireString(path, 'recordPath');
  if (!Number.isInteger(expectedRevision)) refuse('revision-mismatch', 'expectedRevision must be an integer');
  if (typeof mutate !== 'function') throw new Error('mutate must be a function');
  const current = readWaveRecord(path);
  if (current.revision !== expectedRevision) refuse('revision-mismatch', `record is at revision ${current.revision}, caller expected ${expectedRevision}`);
  const record = { ...current };
  mutate(record);
  record.generation = current.generation;
  record.revision = current.revision + 1;
  const tmp = `${path}.${randomUUID()}.tmp`;
  let owned = false;
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); owned = true;
    chmodSync(tmp, 0o600); renameSync(tmp, path); owned = false;
  } finally { if (owned && existsSync(tmp)) rmSync(tmp, { force: true }); }
  return record;
}
function sameMembers(a = [], b = []) {
  if (a.length !== b.length) return false;
  const key = entry => `${entry.step}:${entry.sealed_head}:${entry.retention_ref}`;
  const sortedA = [...a].map(key).sort();
  const sortedB = [...b].map(key).sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}
const sameInputs = (integration, ctx) => Boolean(integration) && integration.base_commit === ctx.baseCommit && sameMembers(integration.members, ctx.members.map(memberKey));
// The package claim is only authority when the registry still holds a matching
// token at the caller's epoch, checked against fresh inspectClaims output.
async function inspectPackageClaim(ctx) {
  const ownership = ctx.ownership;
  if (!ownership || typeof ownership.inspectClaims !== 'function') throw new Error('ctx.ownership is required');
  const { claims } = await ownership.inspectClaims({ packageId: ctx.packageId });
  const wanted = ctx.packageClaim;
  const held = claims.find(claim => claim.kind === 'package' && claim.token === wanted.token);
  if (!held) refuse('package-claim-missing', `no package claim is held for token ${wanted.token}`);
  if (held.epoch !== wanted.epoch) refuse('package-claim-mismatch', `package claim epoch ${held.epoch} does not match ctx ${wanted.epoch}`);
  return held;
}
function validateContext(ctx) {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) throw new Error('ctx is required');
  requireWaveId(ctx.waveId);
  if (!Number.isInteger(ctx.revision)) refuse('revision-mismatch', 'ctx.revision must be an integer');
  if (!ctx.target || typeof ctx.target.worktree !== 'string' || !ctx.target.worktree) throw new Error('ctx.target.worktree is required');
  if (!ctx.workspace || typeof ctx.workspace !== 'object') throw new Error('ctx.workspace is required');
  if (!ctx.coordinator || typeof ctx.coordinator !== 'object') throw new Error('ctx.coordinator is required');
  if (!ctx.packageClaim || typeof ctx.packageClaim.token !== 'string' || !ctx.packageClaim.token) refuse('package-claim-missing', 'ctx.packageClaim.token is required');
  if (!ctx.ownership || typeof ctx.ownership.inspectClaims !== 'function') throw new Error('ctx.ownership is required');
  requireSha(ctx.baseCommit, 'baseCommit');
  if (!Array.isArray(ctx.members) || ctx.members.length === 0) throw new Error('ctx.members must be a non-empty array');
  for (const member of ctx.members) {
    if (!Number.isInteger(member?.step)) throw new Error('member.step must be an integer');
    requireSha(member.sealedHead, `member ${member?.step} sealedHead`);
    requireString(member.retentionRef, `member ${member?.step} retentionRef`);
  }
  const record = readWaveRecord(ctx.recordPath);
  if (record.revision !== ctx.revision) refuse('revision-mismatch', `record is at revision ${record.revision}, caller expected ${ctx.revision}`);
  if (record.wave_id !== ctx.waveId) refuse('wave-id-mismatch', `record ${record.wave_id} does not match ctx.waveId ${ctx.waveId}`);
  const claim = ctx.packageClaim;
  if (!claim || typeof claim.token !== 'string' || !claim.token) refuse('package-claim-missing', 'ctx.packageClaim.token is required');
  if (claim.epoch === undefined || claim.epoch === null || claim.epoch === '') refuse('package-claim-missing', 'ctx.packageClaim.epoch is required');
  const claims = record.package_claim_token ?? record.claim_token ?? null;
  if (typeof claims === 'string' && claims !== claim.token) refuse('package-claim-mismatch', 'ctx.packageClaim.token does not match the wave record');
  return record;
}
function verifyMembers(ctx, repo) {
  for (const member of [...ctx.members].sort((a, b) => a.step - b.step)) {
    const observed = gitMaybe(repo, ['rev-parse', '--verify', '--quiet', member.retentionRef]);
    if (observed !== member.sealedHead) refuse('sealed-head-changed', `${member.retentionRef} is ${observed}, expected ${member.sealedHead}`);
    if (runGit(['-C', repo, 'merge-base', '--is-ancestor', ctx.baseCommit, member.sealedHead]).status !== 0) refuse('sealed-head-changed', `${ctx.baseCommit} is not an ancestor of ${member.sealedHead}`);
  }
}
export function mergeTreeOutcome({ repo, ours, theirs }) {
  requireString(repo, 'repo');
  const result = runGit(['-C', repo, 'merge-tree', '--write-tree', '--name-only', '-z', ours, theirs]);
  const stdout = String(result.stdout ?? '');
  const fields = stdout.split('\0');
  const tree = fields[0];
  const stderr = String(result.stderr ?? '');
  if (result.status === 0) {
    if (isTreeObject(repo, tree)) return { kind: 'clean', tree, output: stdout };
    refuse('merge-tool-failure', 'merge-tree exited 0 without a valid tree');
  }
  if (result.status === 1) {
    if (isTreeObject(repo, tree)) {
      const paths = [];
      for (let index = 1; index < fields.length && fields[index] !== ''; index += 1) paths.push(fields[index]);
      return { kind: 'conflict', tree, paths, output: stdout };
    }
    refuse('merge-tool-failure', `merge-tree exited 1 without a valid tree: ${stderr}`);
  }
  refuse('merge-tool-failure', `merge-tree exited ${result.status}: ${stderr}`);
}
function readIdentity(repo) {
  const name = gitMaybe(repo, ['config', 'user.name']);
  const email = gitMaybe(repo, ['config', 'user.email']);
  if (!name || !email) refuse('identity-missing', 'canonical user.name/user.email are required');
  return { name, email };
}
function commitDateEnv(identity, startedAt) {
  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed)) refuse('identity-missing', `integration.started_at ${JSON.stringify(startedAt)} is not a timestamp`);
  const stamp = `@${Math.floor(parsed / 1000)} +0000`;
  return { ...process.env, GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
}
function writeConflictArtifact(recordPath, waveId, step, output) {
  const artifact = join(dirname(recordPath), `${waveId}-conflict-step-${String(step).padStart(3, '0')}.txt`);
  const tmp = `${artifact}.${process.pid}.tmp`;
  writeFileSync(tmp, output, { mode: 0o600 });
  renameSync(tmp, artifact);
  return artifact;
}
const CANDIDATE_PHASE_PURPOSE = 'candidate';
const REPAIR_LIMIT = 1;
const candidateAttemptId = waveId => `${waveId}-candidate`;
const candidatePhaseToken = (waveId, count) => `${waveId}-candidate-p${count}`;
// Coordinator-side Git is always a plain runGit, so a spawn error or timeout is
// an observation we could not make and the caller blocks rather than guessing.
function canonicalHead(workspace) {
  const result = workspace.backend === 'worktree'
    ? runGit(['-C', workspace.worktree, 'rev-parse', 'HEAD'])
    : runGit(['--git-dir', workspace.gitDir, 'rev-parse', 'HEAD']);
  return result.status !== 0 ? null : String(result.stdout).trim();
}
// Overlay objects live only in the private gitDir, so a commit that arrived by
// another route is fetched coordinator-side into that gitDir (objects only).
function fetchIntoWorkspace(workspace, source, sha) {
  if (workspace.backend !== 'overlayfs') return;
  requireSha(sha, 'fetch sha');
  const result = runGit(['-c', 'uploadpack.allowAnySHA1InWant=true', '-C', workspace.gitDir, 'fetch', '--no-tags', source, sha]);
  if (result.status !== 0) refuse('merge-tool-failure', `fetch of ${sha} into candidate failed: ${String(result.stderr ?? '').trim()}`);
}
function shellQuote(value) {
  const text = requireString(value, 'shell argument');
  if (text.includes('\0') || text.includes('\n')) refuse('materialize-invalid', 'shell argument contains a control character');
  return `'${text.split("'").join("'\\''")}'`;
}
function workspaceGitArgs(workspace) {
  return workspace.backend === 'worktree'
    ? `-C ${shellQuote(workspace.worktree)}`
    : `--git-dir ${shellQuote(workspace.gitDir)} --work-tree ${shellQuote(workspace.merged)}`;
}
// Materialization is one in-phase command so a crash leaves the whole action in
// the drain-unknown set; the ref update compares against the explicit actual
// SHA rather than the symbolic HEAD.
function materializeCommand(workspace, to, actual) {
  requireSha(to, 'materialize to');
  requireSha(actual, 'materialize from');
  const args = workspaceGitArgs(workspace);
  return `git ${args} read-tree -m -u ${shellQuote(actual)} ${shellQuote(to)} && git ${args} update-ref HEAD ${shellQuote(to)} ${shellQuote(actual)}`;
}
function trackedCleanCommand(workspace) { return `git ${workspaceGitArgs(workspace)} status --porcelain --untracked-files=no`; }
async function runOneCommand(ctx, record, command) {
  if (typeof ctx.runCommand !== 'function') throw new Error('ctx.runCommand is required');
  return ctx.runCommand(record, command, 60);
}
function readProbeOutput(reply) {
  const path = reply?.full_output_path;
  if (typeof path !== 'string' || !path || !existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}
// A phase entry journals its count and token before provisioning, then stores
// the retained workspace directly; a later entry remounts with the prior claim.
async function enterCandidatePhase(ctx) {
  const mode = ctx.workspace?.mode;
  if (mode !== 'overlayfs' && mode !== 'worktree') refuse('backend-unspecified', 'candidate workspace mode must be a concrete backend, never auto');
  const fresh = readWaveRecord(ctx.recordPath);
  const integration = fresh.target?.integration;
  if (!integration) refuse('no-integration', 'no integration state to enter a phase for');
  const backend = integration.workspace?.backend ?? integration.backend ?? mode;
  if (backend !== 'overlayfs' && backend !== 'worktree') refuse('backend-unspecified', 'candidate backend must be a concrete backend, never auto');
  await inspectPackageClaim(ctx);
  const prior = integration.phase ?? { count: 0, token: null, claim: null, capacity_claim: null };
  const count = (Number.isInteger(prior.count) ? prior.count : 0) + 1;
  const phaseToken = candidatePhaseToken(ctx.waveId, count);
  const attemptId = candidateAttemptId(ctx.waveId);
  const phase = { workspace: null, claim: null, phaseToken, revision: fresh.revision, record: null, capacityClaim: null, unknown: false };
  patchJournal(ctx, phase, current => { current.phase = { ...prior, count, token: phaseToken, capacity_claim: null }; });
  if (!integration.workspace) {
    phase.workspace = await prepareCandidateWorkspace({
      packageId: ctx.packageId, attemptId, baseCommit: ctx.baseCommit, waveRoot: ctx.workspace.waveRoot, target: ctx.target, ownership: ctx.ownership,
      coordinator: ctx.coordinator, mode: ctx.workspace.mode, capability: ctx.workspace.capability, setup: ctx.workspace.setup, env: ctx.workspace.env,
      preparationReceipt: ctx.workspace.preparationReceipt, staging: ctx.workspace.staging, phaseToken,
    });
    phase.claim = phase.workspace.claim;
  } else {
    const retained = integration.workspace.retained ?? integration.workspace;
    if (retained.backend === 'worktree' || integration.backend === 'worktree') {
      const started = await createOverlayPhases({ ownership: ctx.ownership }).startPhase({ packageId: ctx.packageId, upper: join(dirname(retained.worktree), 'upper'), work: join(dirname(retained.worktree), 'work'), phaseToken, coordinator: ctx.coordinator });
      if (started.status === 'refused') refuse('upper-held', `worktree candidate phase ${phaseToken} is held`);
      phase.claim = started.claim;
      phase.workspace = { ...retained, retained, claim: started.claim };
    } else {
      phase.workspace = await remountRetainedWorkspace({ retained, expected: retained, previous: prior.claim, phaseToken, coordinator: ctx.coordinator, ownership: ctx.ownership, request: { attemptId, waveRoot: ctx.workspace.waveRoot } });
      phase.claim = phase.workspace.claim;
    }
  }
  patchJournal(ctx, phase, current => { current.workspace = current.workspace ?? phase.workspace.retained; current.backend = phase.workspace.backend; current.phase = { ...current.phase, claim: { token: phase.claim.token, epoch: phase.claim.epoch } }; });
  return phase;
}
// Capacity is reserved after the phase claim (§B order); a queued result leaves
// the phase to the caller, who releases it without a run record.
async function reserveCapacity(ctx, phase) {
  const attempt = `${ctx.waveId}:candidate:${phase.phaseToken}`;
  const result = await ctx.ownership.reserveCapacity({ packageId: ctx.packageId, attempt, request: ctx.capacity, coordinator: ctx.coordinator });
  if (result.status === 'queued') return { queued: true, constraint: result.constraint };
  if (result.status !== 'reserved') refuse('capacity-refused', `candidate capacity reservation returned ${result.status}`);
  phase.capacityClaim = { token: result.claim.token, epoch: result.claim.epoch };
  patchJournal(ctx, phase, current => { current.phase = { ...current.phase, capacity_claim: phase.capacityClaim }; });
  return { queued: false, claim: result.claim };
}
function patchJournal(ctx, phase, mutate) {
  const committed = updateWaveRecord(ctx.recordPath, { expectedRevision: phase.revision }, draft => mutate(draft.target.integration));
  phase.revision = committed.revision;
  return committed;
}
// One run record per phase. A throw or a cancellation request marks the phase
// unknown, so the caller blocks drain-unknown and never releases the claims.
async function runInPhase(ctx, phase, command) {
  if (!phase.record) phase.record = await ctx.phaseRecord(phase.workspace, { phaseToken: phase.phaseToken, purpose: CANDIDATE_PHASE_PURPOSE, capacityClaim: phase.capacityClaim });
  try {
    const reply = await runOneCommand(ctx, phase.record, command);
    if (!reply || reply.requires_cancellation) phase.unknown = true;
    return reply;
  } catch {
    phase.unknown = true;
    return null;
  }
}
async function probeTrackedClean(ctx, phase) {
  const reply = await runInPhase(ctx, phase, trackedCleanCommand(phase.workspace));
  if (phase.unknown) return null;
  if (reply?.exit_code !== 0) return false;
  const output = readProbeOutput(reply);
  if (output === null) { phase.unknown = true; return null; }
  return output.trim() === '';
}
// A positive confirmation ends the record and releases capacity then the phase;
// anything else keeps both claims held and reports drain-unknown for recovery.
async function leaveCandidatePhase(ctx, phase, confirmed) {
  if (phase.record && typeof ctx.endPhaseRecord === 'function') await ctx.endPhaseRecord(phase.record, { drained: confirmed });
  if (!confirmed) return { drained: 'unknown', released: false };
  if (phase.capacityClaim) await ctx.ownership.releaseClaim({ token: phase.capacityClaim.token, epoch: phase.capacityClaim.epoch, drain: 'confirmed' });
  await createOverlayPhases({ ownership: ctx.ownership }).endPhase({ token: phase.claim.token, epoch: phase.claim.epoch, drain: 'confirmed' });
  phase.claim = null;
  phase.capacityClaim = null;
  return { drained: 'confirmed', released: true };
}
// Release a claim the journal still records after a stranded phase. A claim the
// registry no longer holds was already released (idempotent); a live claim at a
// different epoch is not ours to release and refuses.
async function releaseRecordedClaim(ctx, recorded) {
  const { claims } = await ctx.ownership.inspectClaims({ packageId: ctx.packageId });
  const held = claims.find(claim => claim.token === recorded.token);
  if (!held) return { released: false, absent: true };
  if (held.epoch !== recorded.epoch) refuse('phase-claim-mismatch', `phase claim ${recorded.token} is at epoch ${held.epoch}, journal records ${recorded.epoch}`);
  await ctx.ownership.releaseClaim({ token: recorded.token, epoch: recorded.epoch, drain: 'confirmed' });
  return { released: true, absent: false };
}
async function blockCandidate(ctx, phase, reason) {
  if (phase.record) await leaveCandidatePhase(ctx, phase, false);
  patchJournal(ctx, phase, current => { current.status = 'blocked'; current.blocked_reason = reason; });
  return { status: 'blocked', revision: phase.revision, reason, blocked_reason: reason, claims: 'kept' };
}
// Ready only when the probe is clean and HEAD is the target or workspace_head.
async function materialize(ctx, phase, target) {
  const workspace = phase.workspace;
  const workspaceHead = readWaveRecord(ctx.recordPath).target?.integration?.workspace_head ?? null;
  const head = canonicalHead(workspace);
  if (head === null) return blockCandidate(ctx, phase, 'candidate-workspace-unknown');
  if (head === target) {
    const alreadyClean = await probeTrackedClean(ctx, phase);
    if (phase.unknown) return blockCandidate(ctx, phase, 'drain-unknown');
    if (!alreadyClean) return blockCandidate(ctx, phase, 'candidate-workspace-unknown');
    return { status: 'ready', head: target, reconciled: false };
  }
  if (!workspaceHead || head !== workspaceHead) return blockCandidate(ctx, phase, 'candidate-workspace-unknown');
  const beforeClean = await probeTrackedClean(ctx, phase);
  if (phase.unknown) return blockCandidate(ctx, phase, 'drain-unknown');
  if (!beforeClean) return blockCandidate(ctx, phase, 'candidate-workspace-unknown');
  for (const sha of [workspaceHead, target]) fetchIntoWorkspace(workspace, ctx.target.worktree, sha);
  const reply = await runInPhase(ctx, phase, materializeCommand(workspace, target, workspaceHead));
  if (phase.unknown) return blockCandidate(ctx, phase, 'drain-unknown');
  if (reply?.exit_code !== 0) return blockCandidate(ctx, phase, 'candidate-workspace-unknown');
  if (canonicalHead(workspace) !== target) return blockCandidate(ctx, phase, 'candidate-workspace-unknown');
  const clean = await probeTrackedClean(ctx, phase);
  if (phase.unknown) return blockCandidate(ctx, phase, 'drain-unknown');
  if (!clean) return blockCandidate(ctx, phase, 'candidate-workspace-unknown');
  patchJournal(ctx, phase, current => { current.workspace_head = target; });
  return { status: 'ready', head: target, reconciled: true };
}
export async function assembleCandidate(ctx) {
  const record = validateContext(ctx);
  await inspectPackageClaim(ctx);
  const repo = ctx.target.worktree;
  verifyMembers(ctx, repo);
  const integration = record.target?.integration ?? null;
  if (integration && sameInputs(integration, ctx) && ['assembled', 'verified', 'checking', 'assembling'].includes(integration.status) && integration.merged?.length === ctx.members.length)
    return { status: 'assembled', revision: record.revision, candidate: { commit: record.target.candidate_commit, tree: record.target.candidate_tree }, replayed: true };
  if (integration && !sameInputs(integration, ctx)) {
    const next = updateWaveRecord(ctx.recordPath, { expectedRevision: ctx.revision }, draft => { draft.target = { ...(draft.target ?? {}), integration: { ...integration, status: 'blocked', blocked_reason: 'integration-input-changed' } }; });
    return { status: 'blocked', revision: next.revision, reason: 'integration-input-changed', observed: integration.base_commit };
  }
  const identity = integration?.identity ?? readIdentity(repo);
  const startedAt = integration?.started_at ?? new Date().toISOString();
  const ref = candidateRef(ctx.waveId);
  const sorted = [...ctx.members].sort((a, b) => a.step - b.step);
  let revision = ctx.revision;
  if (!integration) {
    const next = updateWaveRecord(ctx.recordPath, { expectedRevision: revision }, draft => {
      draft.target = { ...(draft.target ?? {}), integration: {
        version: 1, started_at: startedAt, identity, base_commit: ctx.baseCommit, members: sorted.map(memberKey),
        merged: [], conflict: null, repairs: [], workspace: draft.target?.integration?.workspace ?? null, backend: draft.target?.integration?.backend ?? null,
        phase: { count: 0, token: null, claim: null, capacity_claim: null }, workspace_head: ctx.baseCommit, checks: [], status: 'assembling', blocked_reason: null,
      } };
    });
    revision = next.revision;
  }
  const fresh = readWaveRecord(ctx.recordPath).target;
  const merged = [...(fresh.integration?.merged ?? [])];
  let expectedCommit = fresh.candidate_commit ?? null;
  let candidateTree = fresh.candidate_tree ?? null;
  // A repaired candidate is the accumulator: an existing merged entry for the
  // conflicting step resumes assembly instead of reverting to a skipped head.
  let accumulator = expectedCommit ?? ctx.baseCommit;
  for (const member of sorted) {
    const already = merged.find(entry => entry.step === member.step);
    if (already) { accumulator = already.commit; continue; }
    const outcome = mergeTreeOutcome({ repo, ours: accumulator, theirs: member.sealedHead });
    if (outcome.kind === 'conflict') {
      const artifact = writeConflictArtifact(ctx.recordPath, ctx.waveId, member.step, outcome.output);
      const parents = [accumulator, member.sealedHead];
      const next = updateWaveRecord(ctx.recordPath, { expectedRevision: revision }, draft => {
        const current = draft.target.integration;
        draft.target.candidate_commit = current.merged.length ? current.merged[current.merged.length - 1].commit : null;
        draft.target.integration = { ...current, status: 'conflict', conflict: { step: member.step, parents, paths: outcome.paths, output_path: artifact } };
      });
      return { status: 'conflict', revision: next.revision, conflict: { step: member.step, parents, paths: outcome.paths, output_path: artifact } };
    }
    const created = runGit(['-C', repo, 'commit-tree', '--no-gpg-sign', outcome.tree, '-p', accumulator, '-p', member.sealedHead, '-m', `wave ${ctx.waveId}: integrate step ${member.step}`, '-m', `Sealed-head: ${member.sealedHead}`], { env: commitDateEnv(identity, startedAt) });
    if (created.status !== 0) refuse('merge-tool-failure', `commit-tree failed for step ${member.step}`);
    const commit = String(created.stdout).trim();
    requireSha(commit, `step ${member.step} candidate commit`);
    const observed = gitMaybe(repo, ['rev-parse', '--verify', '--quiet', ref]);
    if (observed !== commit) {
      const old = expectedCommit ?? '0'.repeat(ctx.baseCommit.length);
      if (runGit(['-C', repo, 'update-ref', ref, commit, old]).status !== 0) {
        const next = updateWaveRecord(ctx.recordPath, { expectedRevision: revision }, draft => { draft.target.integration = { ...draft.target.integration, status: 'blocked', blocked_reason: 'candidate-ref-changed' }; });
        return { status: 'blocked', revision: next.revision, reason: 'candidate-ref-changed', observed };
      }
    }
    expectedCommit = commit; candidateTree = outcome.tree;
    merged.push({ step: member.step, parents: [accumulator, member.sealedHead], commit, tree: outcome.tree });
    accumulator = commit;
    const next = updateWaveRecord(ctx.recordPath, { expectedRevision: revision }, draft => {
      draft.target.candidate_commit = commit; draft.target.candidate_tree = outcome.tree;
      draft.target.integration = { ...draft.target.integration, merged: merged.map(entry => ({ ...entry })), status: 'assembled', conflict: null };
    });
    revision = next.revision;
  }
  return { status: 'assembled', revision, candidate: { commit: expectedCommit, tree: candidateTree }, replayed: false };
}
const REPAIR_KIND = 'integration-repair';
const REPAIR_REF = (waveId, n) => `${RETENTION_REF_PREFIX}${waveId}/repair-${n}`;
function conflictParents(integration) {
  const parents = integration?.conflict?.parents;
  if (!Array.isArray(parents) || parents.length !== 2) refuse('no-repair-pending', 'integration conflict has no parent pair');
  for (const sha of parents) requireSha(sha, 'conflict parent');
  return parents;
}
function autoRepairCount(integration, trigger, step) { return (integration?.repairs ?? []).filter(entry => entry.trigger === trigger && entry.step === step).length; }
function existingRepairPacket(integration) {
  const request = integration?.repair_request;
  return !request || request.kind !== REPAIR_KIND ? null : request;
}
function repairPacket({ ctx, integration, trigger, step, attempt, parents, failedGates, phaseClaim }) {
  const conflict = trigger === 'conflict';
  return {
    kind: REPAIR_KIND, wave_id: ctx.waveId, trigger, step, attempt, parents,
    conflict_paths: conflict ? (integration.conflict?.paths ?? []) : [], merge_output_path: conflict ? (integration.conflict?.output_path ?? null) : null,
    failed_gates: failedGates, workspace: integration.workspace ?? null, backend: integration.backend ?? null,
    phase_claim: phaseClaim, review_scope: { parents, head: null },
  };
}
export async function prepareIntegrationRepair(ctx, { explicit = false, drain } = {}) {
  let record = validateContext(ctx);
  await inspectPackageClaim(ctx);
  // A confirmed-drain retry of a stranded repair releases the recorded claims
  // and CASes the journal back to a repairable state before the ordinary
  // replay/trigger logic below sees the original conflict or failed checks.
  record = await resumeIntegrationRepair(ctx, record, { drain }, { releaseRecordedClaim, updateWaveRecord, refuse });
  ctx = { ...ctx, revision: record.revision };
  const integration = record.target?.integration;
  if (!integration) refuse('no-repair-pending', 'no integration state exists');
  const replay = existingRepairPacket(integration);
  if (replay) {
    const benign = integration.status === 'repairing' || (replay.trigger === 'conflict' && integration.status === 'conflict') || (replay.trigger === 'composition' && integration.status === 'checks-failed');
    if (!benign) refuse('no-repair-pending', `integration status ${integration.status} does not match pending repair ${replay.trigger}`);
    return { status: 'repair-ready', revision: record.revision, repair: replay, replayed: true };
  }
  let trigger; let parents; let step; let failedGates = [];
  if (explicit && integration.status === 'blocked' && integration.blocked_reason === 'repair-unresolved') {
    // An operator re-opens a spent automatic budget. The conflict trigger is
    // inferred from the retained conflict state, else it is a composition retry.
    if (integration.conflict) { trigger = 'conflict'; parents = conflictParents(integration); step = Number(integration.conflict?.step); }
    else {
      trigger = 'composition'; step = null; parents = [record.target?.candidate_commit].filter(Boolean);
      if (parents.length !== 1) refuse('no-repair-pending', 'composition repair requires a candidate commit');
      failedGates = (integration.checks ?? []).filter(entry => entry.outcome === 'fail').map(entry => entry.gate);
    }
  } else if (integration.status === 'conflict') { trigger = 'conflict'; parents = conflictParents(integration); step = Number(integration.conflict?.step); }
  else if (integration.status === 'checks-failed') {
    trigger = 'composition'; step = null; parents = [record.target?.candidate_commit].filter(Boolean);
    if (parents.length !== 1) refuse('no-repair-pending', 'composition repair requires a candidate commit');
    failedGates = (integration.checks ?? []).filter(entry => entry.outcome === 'fail').map(entry => entry.gate);
  } else refuse('no-repair-pending', `integration status ${integration.status} has no repair pending`);
  const spent = autoRepairCount(integration, trigger, step);
  if (spent >= REPAIR_LIMIT && !explicit) {
    const next = updateWaveRecord(ctx.recordPath, { expectedRevision: ctx.revision }, draft => { draft.target.integration = { ...draft.target.integration, status: 'blocked', blocked_reason: 'repair-unresolved' }; });
    return { status: 'blocked', revision: next.revision, reason: 'repair-unresolved', blocked_reason: 'repair-unresolved' };
  }
  if (spent >= REPAIR_LIMIT) {
    // Explicit re-open of a spent budget: journal the durable packet over the
    // operator's already-prepared workspace without materializing or resetting it.
    const explicitPacket = repairPacket({ ctx, integration: readWaveRecord(ctx.recordPath).target.integration, trigger, step, attempt: `repair-${spent + 1}`, parents, failedGates, phaseClaim: null });
    const next = updateWaveRecord(ctx.recordPath, { expectedRevision: ctx.revision }, draft => {
      draft.target.integration = { ...draft.target.integration, status: 'repairing', checks: [], blocked_reason: null, repair_request: explicitPacket };
    });
    return { status: 'repair-ready', revision: next.revision, repair: explicitPacket, replayed: false };
  }
  const attempt = `repair-${spent + 1}`;
  const phase = await enterCandidatePhase(ctx);
  const reserved = await reserveCapacity(ctx, phase);
  if (reserved.queued) {
    await createOverlayPhases({ ownership: ctx.ownership }).endPhase({ token: phase.claim.token, epoch: phase.claim.epoch, drain: 'confirmed' });
    return { status: 'queued', revision: readWaveRecord(ctx.recordPath).revision, constraint: reserved.constraint };
  }
  // Capture the phase claim before materialize may end/clear it, so the packet
  // still records the claim the candidate phase ran under.
  const phaseClaim = phase.claim;
  for (const parent of parents) fetchIntoWorkspace(phase.workspace, ctx.target.worktree, parent);
  const state = await materialize(ctx, phase, parents[0]);
  if (state.status === 'blocked') return state;
  await leaveCandidatePhase(ctx, phase, true);
  const packet = repairPacket({ ctx, integration: readWaveRecord(ctx.recordPath).target.integration, trigger, step, attempt, parents, failedGates, phaseClaim });
  patchJournal(ctx, phase, current => { current.status = 'repairing'; current.repair_request = packet; });
  return { status: 'repair-ready', revision: phase.revision, repair: packet, replayed: false };
}
function privateRepo(integration) {
  const workspace = integration.workspace;
  if (integration.backend === 'worktree') return workspace.worktree;
  const gitDir = workspace.gitDir ?? workspace.retained?.gitDir;
  if (!gitDir) refuse('observation-unknown', 'overlay candidate has no private gitDir');
  return gitDir;
}
async function importRepairHead(ctx, integration, head, n) {
  const target = ctx.target.worktree;
  const ref = REPAIR_REF(ctx.waveId, n);
  const source = integration.backend === 'worktree' ? target : privateRepo(integration);
  await importSealedHead({ repo: target, source, sha: head, retentionRef: ref });
  return ref;
}
export async function acceptIntegrationRepair(ctx, options = {}) {
  const record = validateContext(ctx);
  await inspectPackageClaim(ctx);
  const integration = record.target?.integration;
  if (!integration) refuse('no-repair-pending', 'no integration state exists');
  const request = existingRepairPacket(integration);
  const explicit = options.explicit === true;
  if (!request) {
    if (!explicit) refuse('no-repair-pending', 'no repair request is pending');
    // An explicit acceptance may re-open a spent automatic budget first; the
    // returned revision then drives a normal acceptance on the new packet.
    const prepared = await prepareIntegrationRepair({ ...ctx, revision: record.revision }, { explicit: true });
    if (prepared.status === 'queued') return prepared;
    if (prepared.status === 'blocked') return prepared;
    return acceptIntegrationRepair({ ...ctx, revision: prepared.revision }, options);
  }
  if (typeof options.head !== 'string' || !SHA_PATTERN.test(options.head)) refuse('repair-invalid', 'repair head must be a full commit id');
  const head = options.head;
  const review = options.review;
  if (!review || typeof review !== 'object') refuse('repair-invalid', 'review is required');
  if (review.verdict !== 'pass') refuse('repair-invalid', 'review verdict must be pass');
  if (review.head !== head) refuse('repair-invalid', 'review head must equal the repair head');
  const spent = autoRepairCount(integration, request.trigger, request.step);
  if (!explicit && spent >= REPAIR_LIMIT) {
    const next = updateWaveRecord(ctx.recordPath, { expectedRevision: ctx.revision }, draft => { draft.target.integration = { ...draft.target.integration, status: 'blocked', blocked_reason: 'repair-unresolved' }; });
    return { status: 'blocked', revision: next.revision, reason: 'repair-unresolved', blocked_reason: 'repair-unresolved' };
  }
  // Exact parentage is checked in the private repository before any import, so
  // an invalid head never lands in the canonical object store.
  const expectedParents = request.parents;
  const parentLine = gitMaybe(privateRepo(integration), ['rev-list', '--parents', '-n1', head]);
  if (!parentLine) refuse('repair-invalid', `repair head ${head} is not present in the candidate repository`);
  const observedParents = parentLine.trim().split(/\s+/).slice(1);
  if (observedParents.length !== expectedParents.length || observedParents.some((sha, index) => sha !== expectedParents[index])) refuse('repair-invalid', `repair head parents ${observedParents.join(' ')} do not match ${expectedParents.join(' ')}`);
  const n = (integration.repairs?.length ?? 0) + 1;
  const ref = await importRepairHead(ctx, integration, head, n);
  const sourceTree = gitMaybe(privateRepo(integration), ['rev-parse', `${head}^{tree}`]);
  const importedTree = gitMaybe(ctx.target.worktree, ['rev-parse', `${head}^{tree}`]);
  if (!sourceTree || importedTree !== sourceTree) refuse('repair-invalid', 'imported repair tree does not match the source tree');
  const oldCandidate = record.target?.candidate_commit ?? '0'.repeat(ctx.baseCommit.length);
  const observed = gitMaybe(ctx.target.worktree, ['rev-parse', '--verify', '--quiet', candidateRef(ctx.waveId)]);
  if (observed !== null && observed !== oldCandidate) {
    const next = updateWaveRecord(ctx.recordPath, { expectedRevision: ctx.revision }, draft => { draft.target.integration = { ...draft.target.integration, status: 'blocked', blocked_reason: 'candidate-ref-changed' }; });
    return { status: 'blocked', revision: next.revision, reason: 'candidate-ref-changed', observed };
  }
  if (runGit(['-C', ctx.target.worktree, 'update-ref', candidateRef(ctx.waveId), head, oldCandidate]).status !== 0) {
    const next = updateWaveRecord(ctx.recordPath, { expectedRevision: ctx.revision }, draft => { draft.target.integration = { ...draft.target.integration, status: 'blocked', blocked_reason: 'candidate-ref-changed' }; });
    return { status: 'blocked', revision: next.revision, reason: 'candidate-ref-changed', observed: 'unknown' };
  }
  const reviewEntry = { trigger: request.trigger, step: request.step, parents: expectedParents, head, tree: sourceTree, retention_ref: ref, review_artifact: review.artifact ?? null, explicit, reviewed: true };
  const next = updateWaveRecord(ctx.recordPath, { expectedRevision: ctx.revision }, draft => {
    const current = draft.target.integration;
    const repairs = [...(current.repairs ?? []), reviewEntry];
    draft.target.candidate_commit = head;
    draft.target.candidate_tree = sourceTree;
    const integrationNext = { ...current, repairs, workspace_head: head, checks: [], repair_request: null };
    if (request.trigger === 'conflict') {
      const merged = [...(current.merged ?? []), { step: request.step, parents: expectedParents, commit: head, tree: sourceTree }];
      const complete = merged.length >= (current.members?.length ?? 0);
      draft.target.integration = { ...integrationNext, merged, conflict: null, status: complete ? 'assembled' : 'assembling' };
    } else draft.target.integration = { ...integrationNext, status: 'assembled' };
  });
  return { status: 'accepted', revision: next.revision, repair: reviewEntry };
}
export async function runCandidateChecks(ctx, options = {}) {
  const record0 = validateContext(ctx);
  await inspectPackageClaim(ctx);
  const mode = ctx.workspace?.mode;
  if (mode !== 'overlayfs' && mode !== 'worktree') refuse('backend-unspecified', 'candidate workspace mode must be a concrete backend, never auto');
  const checks = Array.isArray(ctx.checks) ? ctx.checks : [];
  if (checks.length === 0) refuse('checks-invalid', 'candidate checks require a non-empty command list');
  for (const gate of checks) {
    if (!gate || typeof gate !== 'object' || Array.isArray(gate) || typeof gate.id !== 'string' || gate.id.length === 0) refuse('checks-invalid', 'each candidate check must have a non-empty id');
    if (typeof gate.command !== 'string' || gate.command.length === 0) refuse('checks-invalid', 'check.command must be a non-empty string');
  }
  const integration = record0.target?.integration;
  if (!integration) refuse('no-integration', 'no integration state to check');
  const candidate = record0.target?.candidate_commit;
  if (!candidate) refuse('no-candidate', 'no candidate commit has been assembled');
  // Every check run is bound to the current inputs: a mismatch means another
  // step or member changed the wave under this caller and must re-enter first.
  if (!sameInputs(integration, ctx)) refuse('integration-input-changed', 'integration inputs changed since the candidate was assembled');
  if (integration.status === 'verified' && (integration.checks ?? []).length > 0 && sameInputs(integration, ctx)) {
    const allPass = (integration.checks ?? []).every(entry => entry.outcome === 'pass' && entry.observed_commit === candidate);
    const receipts = new Set((integration.checks ?? []).map(entry => entry.receipt_id).filter(Boolean));
    const covered = checks.every(gate => (integration.checks ?? []).some(entry => entry.gate === gate.id && entry.command === gate.command && entry.outcome === 'pass' && entry.observed_commit === candidate));
    if (allPass && covered && receipts.size === (integration.checks ?? []).length) {
      return { status: 'passed', revision: record0.revision, replayed: true, checks: integration.checks, repair: null };
    }
  }
  if (integration.status !== 'assembled' && integration.status !== 'verified' && integration.status !== 'checking') {
    const blockedCandidate = integration.status === 'blocked' && integration.blocked_reason !== 'repair-unresolved'
      && !existingRepairPacket(integration) && !integration.conflict
      && (integration.merged?.length ?? 0) === ctx.members.length;
    if (!blockedCandidate) refuse('candidate-not-assembled', `integration status ${integration.status} is not an assembled candidate`);
  }
  // A stranded `checking` phase or a candidate-phase block may only be resumed
  // once the operator confirms the prior drain, then the retained phase claims
  // are released from the recorded journal entries and the candidate is reset.
  const stranded = integration.status === 'checking' || integration.status === 'blocked';
  if (stranded) {
    if (options.drain !== 'confirmed') refuse('drain-unknown', 'a stranded candidate phase needs a confirmed drain');
    verifyMembers(ctx, ctx.target.worktree);
    const realTree = gitMaybe(ctx.target.worktree, ['rev-parse', '--verify', '--quiet', `${candidate}^{tree}`]);
    const recordedTree = record0.target?.candidate_tree ?? null;
    if (!realTree || !recordedTree || recordedTree !== realTree) refuse('candidate-tree-changed', 'recorded candidate tree does not match the canonical candidate');
    const phase = integration.phase ?? {};
    const capacity = phase.capacity_claim ?? null;
    if (capacity) await releaseRecordedClaim(ctx, capacity);
    if (phase.claim) await releaseRecordedClaim(ctx, phase.claim);
    const rebound = updateWaveRecord(ctx.recordPath, { expectedRevision: record0.revision }, draft => {
      const current = draft.target.integration;
      draft.target.integration = { ...current, status: 'assembled', checks: [], blocked_reason: null };
      draft.target.integration.phase = { ...(current.phase ?? {}), capacity_claim: null, claim: null };
    });
    ctx = { ...ctx, revision: rebound.revision };
    record0.target = rebound.target;
    record0.revision = rebound.revision;
  }
  const phase = await enterCandidatePhase(ctx);
  const reserved = await reserveCapacity(ctx, phase);
  if (reserved.queued) {
    await createOverlayPhases({ ownership: ctx.ownership }).endPhase({ token: phase.claim.token, epoch: phase.claim.epoch, drain: 'confirmed' });
    return { status: 'queued', revision: readWaveRecord(ctx.recordPath).revision, constraint: reserved.constraint };
  }
  const materialized = await materialize(ctx, phase, candidate);
  if (materialized.status === 'blocked') return materialized;
  patchJournal(ctx, phase, current => { current.status = 'checking'; current.checks = []; });
  const workspace = phase.workspace;
  const entries = [];
  let failed = null;
  for (const gate of checks) {
    const beforeHead = canonicalHead(workspace);
    if (beforeHead === null || beforeHead !== candidate) return blockCandidate(ctx, phase, 'candidate-tree-changed');
    const beforeClean = await probeTrackedClean(ctx, phase);
    if (phase.unknown) return blockCandidate(ctx, phase, 'drain-unknown');
    if (!beforeClean) return blockCandidate(ctx, phase, 'candidate-tree-changed');
    const startedAt = Date.now();
    let reply = null; let threw = false;
    try { reply = await ctx.runCommand(phase.record, gate.command, 300); } catch { threw = true; }
    if (threw || !reply || reply.requires_cancellation) phase.unknown = true;
    if (phase.unknown) return blockCandidate(ctx, phase, 'drain-unknown');
    const elapsedMs = Date.now() - startedAt;
    const afterHead = canonicalHead(workspace);
    const afterClean = await probeTrackedClean(ctx, phase);
    if (phase.unknown) return blockCandidate(ctx, phase, 'drain-unknown');
    const before = { commit: beforeHead, dirty: false };
    const after = { commit: afterHead ?? beforeHead, dirty: afterClean === false };
    if (afterHead !== candidate || afterClean !== true) return blockCandidate(ctx, phase, 'candidate-tree-changed');
    const receipt = recordVerification(phase.record, gate.command, before, after, {
      exit_code: reply.exit_code ?? null, error: reply.error ?? null, full_output_path: reply.full_output_path ?? null,
    }, { started_at: new Date(startedAt).toISOString(), elapsed_ms: elapsedMs });
    const entry = { gate: gate.id, command: gate.command, receipt_id: receipt.id, exit_code: receipt.exit_code, outcome: receipt.outcome, observed_commit: afterHead, output_path: receipt.artifact };
    entries.push(entry);
    patchJournal(ctx, phase, current => { current.checks = entries.map(item => ({ ...item })); });
    if (receipt.outcome !== 'pass' && !failed) failed = entry;
  }
  if (!failed) {
    await leaveCandidatePhase(ctx, phase, true);
    const next = patchJournal(ctx, phase, current => { current.status = 'verified'; current.checks = entries.map(item => ({ ...item })); });
    return { status: 'passed', revision: next.revision, replayed: false, checks: entries, repair: null };
  }
  await leaveCandidatePhase(ctx, phase, true);
  const next = patchJournal(ctx, phase, current => { current.status = 'checks-failed'; current.checks = entries.map(item => ({ ...item })); });
  const latest = readWaveRecord(ctx.recordPath);
  const repair = await prepareIntegrationRepair({ ...ctx, revision: latest.revision });
  if (repair.status === 'repair-ready') return { status: 'failed', revision: repair.revision, checks: entries, failed_gate: failed.gate, repair: repair.repair, replayed: repair.replayed ?? false };
  if (repair.status === 'blocked') return { status: 'blocked', revision: repair.revision, reason: repair.reason, blocked_reason: repair.blocked_reason, checks: entries };
  return { status: 'queued', revision: repair.revision, checks: entries, failed_gate: failed.gate, repair: null, constraint: repair.constraint };
}
const PROMOTION_STATES = ['intent', 'ref-updated', 'synced', 'blocked'];
// The only promoted publication target is the canonical checkout named by
// ctx.target; a promotion cannot guess a gitdir, so observation failures block.
function promotionCheckout(ctx) {
  const worktree = realpathSync(ctx.target.worktree);
  const common = gitMaybe(ctx.target.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitDir = gitMaybe(ctx.target.worktree, ['rev-parse', '--path-format=absolute', '--absolute-git-dir']);
  if (typeof common !== 'string' || common.length === 0 || typeof gitDir !== 'string' || gitDir.length === 0) refuse('observation-unknown', 'promotion requires explicit git directory observations');
  let gitCommonDir; let worktreeGitDir;
  try { gitCommonDir = realpathSync(common); worktreeGitDir = realpathSync(gitDir); }
  catch { refuse('observation-unknown', 'promotion git directory observations are not real paths'); }
  if (gitCommonDir !== realpathSync(ctx.target.gitCommonDir)) refuse('observation-unknown', 'observed git-common-dir does not match ctx.target.gitCommonDir');
  return { worktree, gitCommonDir, worktreeGitDir };
}
// A single fresh observation of the four promotion signals. Any git query that
// cannot complete (spawn error, timeout, unexpected exit) is `unknown`, never a
// guessed clean value.
function observePromotion(repo, ref, oldSha, candidate) {
  const symref = runGit(['-C', repo, 'symbolic-ref', '-q', 'HEAD']);
  // symbolic-ref exits 1 when HEAD is detached: that is a wrong branch, not an
  // unknown observation. Any other non-zero exit is a failed observation.
  if (typeof symref.status !== 'number' || symref.status > 1) return { unknown: true };
  const headRef = runGit(['-C', repo, 'rev-parse', '--verify', '--quiet', ref]);
  if (headRef.status !== 0) return { unknown: true };
  const cachedOld = runGit(['-C', repo, 'diff-index', '--cached', '--quiet', oldSha]);
  const cachedCandidate = runGit(['-C', repo, 'diff-index', '--cached', '--quiet', candidate]);
  const files = runGit(['-C', repo, 'diff-files', '--quiet']);
  const untracked = runGit(['-C', repo, 'ls-files', '--others', '--exclude-standard']);
  const abnormal = result => result.status !== 0 && (typeof result.status !== 'number' || result.status > 1);
  if (abnormal(cachedOld) || abnormal(cachedCandidate) || abnormal(files) || untracked.status !== 0) return { unknown: true };
  return {
    unknown: false, headBranch: String(symref.stdout).trim(), ref: String(headRef.stdout).trim(),
    cachedOld: cachedOld.status === 0, cachedCandidate: cachedCandidate.status === 0,
    trackedClean: files.status === 0, untracked: String(untracked.stdout ?? '').length > 0,
    at: new Date().toISOString(),
  };
}
// A resume point reads the exact fresh record and observes the canonical
// checkout; no ctx value is mutated and no write happens before this returns.
function readPromotion(fresh) {
  const promotion = fresh?.target?.promotion ?? null;
  if (!promotion) return null;
  if (!PROMOTION_STATES.includes(promotion.state)) refuse('journal-corrupt', `promotion state ${promotion.state} is not recognized`);
  return promotion;
}
function promotionValidation({ promotion, fresh, ctx }) {
  const integration = fresh.target?.integration ?? null;
  const candidate = fresh.target?.candidate_commit ?? null;
  requireSha(promotion.expected_old ?? '', 'promotion.expected_old');
  requireSha(promotion.candidate ?? '', 'promotion.candidate');
  if (!integration || integration.status !== 'verified') refuse('candidate-unverified', `integration status ${integration?.status ?? 'none'} is not verified`);
  if (!sameInputs(integration, ctx)) refuse('integration-input-changed', 'promotion inputs changed since verification');
  verifyMembers(ctx, ctx.target.worktree);
  if (promotion.expected_old !== ctx.baseCommit) refuse('journal-corrupt', 'promotion expected_old does not match ctx.baseCommit');
  if (candidate !== promotion.candidate) refuse('journal-corrupt', 'promotion candidate does not match the record candidate');
  if (promotion.candidate_tree !== (fresh.target?.candidate_tree ?? null)) refuse('journal-corrupt', 'promotion candidate_tree does not match the record candidate tree');
  if (promotion.checkout !== realpathSync(ctx.target.worktree)) refuse('journal-corrupt', 'promotion checkout does not match ctx.target.worktree');
  if (promotion.branch !== `refs/heads/${ctx.target.branch}`) refuse('journal-corrupt', 'promotion branch does not match ctx.target.branch');
}
// Journal an intent and the fresh observation for a resumed/blocked journal.
function journalPromotion(ctx, mutate) {
  const fresh = readWaveRecord(ctx.recordPath);
  const next = updateWaveRecord(ctx.recordPath, { expectedRevision: fresh.revision }, draft => { draft.target.promotion = mutate(draft.target.promotion); });
  return next;
}
function blockPromotion(ctx, reason, observed) {
  const fresh = readWaveRecord(ctx.recordPath);
  const next = updateWaveRecord(ctx.recordPath, { expectedRevision: fresh.revision }, draft => {
    draft.target.promotion = { ...(draft.target.promotion ?? {}), state: 'blocked', blocked_reason: reason, observed: observed ?? draft.target.promotion?.observed ?? null };
  });
  return { status: 'blocked', revision: next.revision, reason, blocked_reason: reason, promotion: next.target.promotion };
}
// A verified candidate is promotable only when every configured gate has a
// matching pass receipt bound to the current candidate commit and command.
function requireVerifiedCandidate({ fresh, ctx }) {
  const integration = fresh.target?.integration ?? null;
  if (!integration || integration.status !== 'verified') refuse('candidate-unverified', `integration status ${integration?.status ?? 'none'} is not verified`);
  if (!sameInputs(integration, ctx)) refuse('integration-input-changed', 'promotion inputs changed since verification');
  verifyMembers(ctx, ctx.target.worktree);
  const candidate = fresh.target?.candidate_commit;
  if (!candidate) refuse('candidate-unverified', 'no candidate commit is recorded');
  if (!Array.isArray(ctx.checks) || ctx.checks.length === 0) refuse('checks-invalid', 'promotion requires a non-empty command list');
  for (const gate of ctx.checks) {
    if (!gate || typeof gate !== 'object' || Array.isArray(gate) || typeof gate.id !== 'string' || gate.id.length === 0) refuse('checks-invalid', 'each candidate check must have a non-empty id');
    if (typeof gate.command !== 'string' || gate.command.length === 0) refuse('checks-invalid', 'check.command must be a non-empty string');
    const covered = (integration.checks ?? []).some(entry => entry.gate === gate.id && entry.command === gate.command && typeof entry.receipt_id === 'string' && entry.receipt_id.length > 0 && entry.outcome === 'pass' && entry.observed_commit === candidate);
    if (!covered) refuse('candidate-unverified', `gate ${gate.id} has no passing receipt at ${candidate}`);
  }
  return { candidate, integration };
}
// Validate the whole journal shape without writing. Any mismatch is corrupt.
function validatePromotionJournal({ promotion, fresh, ctx }) {
  const keys = ['branch', 'checkout', 'expected_old', 'candidate', 'candidate_tree', 'index_before', 'started_at', 'observed', 'blocked_reason'];
  for (const key of keys) if (!(key in promotion)) refuse('journal-corrupt', `promotion is missing ${key}`);
  if (typeof promotion.branch !== 'string' || !promotion.branch.startsWith('refs/heads/')) refuse('journal-corrupt', 'promotion.branch must name a local branch');
  if (typeof promotion.checkout !== 'string' || !promotion.checkout) refuse('journal-corrupt', 'promotion.checkout is required');
  requireSha(promotion.expected_old, 'promotion.expected_old');
  requireSha(promotion.candidate, 'promotion.candidate');
  requireSha(promotion.candidate_tree, 'promotion.candidate_tree');
  requireSha(promotion.index_before, 'promotion.index_before');
  if (typeof promotion.started_at !== 'string' || !promotion.started_at) refuse('journal-corrupt', 'promotion.started_at is required');
  if (promotion.observed != null && typeof promotion.observed !== 'object') refuse('journal-corrupt', 'promotion.observed must be an object or null');
  if (promotion.blocked_reason != null && typeof promotion.blocked_reason !== 'string') refuse('journal-corrupt', 'promotion.blocked_reason must be a string or null');
  promotionValidation({ promotion, fresh, ctx });
}
// Reserve the canonical checkout under this wave's own attempt. A held claim is
// accepted only when it is exactly ours: same package, attempt, epoch and
// coordinator session; anything else means another owner holds the checkout.
async function reservePromotionCheckout(ctx, { acquire }) {
  const attempt = `${ctx.waveId}:promotion`;
  const { gitCommonDir, worktreeGitDir } = promotionCheckout(ctx);
  const result = await ctx.ownership.reserveCheckout({
    packageId: ctx.packageId, attempt, checkout: { gitCommonDir, worktreeGitDir },
    coordinator: ctx.coordinator,
  });
  const claim = result.claim ?? result;
  const status = result.status;
  if (status === 'reserved') return { acquired: true, claim };
  const mine = claim && claim.packageId === ctx.packageId && claim.attempt === attempt
    && claim.epoch === ctx.coordinator.epoch && claim.coordinator?.session === ctx.coordinator.session;
  if (status !== 'held' || !mine) refuse('checkout-held', 'the canonical checkout is held by another owner');
  return { acquired: false, claim };
}
async function releasePromotionCheckout(ctx, claim) {
  if (!claim) return;
  await ctx.ownership.releaseClaim({ token: claim.token, epoch: claim.epoch, drain: 'confirmed' });
}
// The resume engine: it runs the same ordered mutations from the current fresh
// journal state and never mutates ctx. Boundaries fire at the named seams.
async function boundary(ctx, name) { if (typeof ctx.onBoundary === 'function') await ctx.onBoundary(name); }
function promoteRef(ctx, promotion) {
  return runGit(['-C', ctx.target.worktree, 'update-ref', '-m', `wave ${ctx.waveId}: promote`, promotion.branch, promotion.candidate, promotion.expected_old]).status;
}
function readTree(ctx, promotion) {
  return runGit(['-C', ctx.target.worktree, 'read-tree', '-m', '-u', promotion.expected_old, promotion.candidate]).status === 0;
}
async function releaseConfirmed(ctx, promotion) {
  const attempt = `${ctx.waveId}:promotion`;
  const { claims } = await ctx.ownership.inspectClaims({ packageId: ctx.packageId });
  const own = (claims ?? []).find(claim => claim.kind === 'checkout' && claim.attempt === attempt
    && claim.epoch === ctx.coordinator.epoch && claim.coordinator?.session === ctx.coordinator.session);
  if (!own) return;
  await releasePromotionCheckout(ctx, own);
}
// The observed-signal projection journaled when a promotion reaches `synced`.
function promotionObserved(observed) {
  return { ref: observed.ref, head: observed.ref, index: observed.cachedCandidate, worktree: !observed.untracked, at: observed.at };
}
// Resume a promotion from its fresh journal. Every step re-observes the checkout
// so an external change blocks rather than being overwritten.
async function resumePromotion(ctx, { freshClaim }) {
  let fresh = readWaveRecord(ctx.recordPath);
  let promotion = readPromotion(fresh);
  promotionValidation({ promotion, fresh, ctx });
  const collisionReason = result => (result?.unknown ? 'observation-unknown' : 'ignored-path-collision');
  const revalidate = () => { const current = readWaveRecord(ctx.recordPath); promotionValidation({ promotion: readPromotion(current) ?? promotion, fresh: current, ctx }); };
  if (promotion.state === 'synced') {
    await releaseConfirmed(ctx, promotion);
    return { status: 'promoted', revision: fresh.revision, replayed: true, ref: promotion.branch, promotion };
  }
  const checkout = promotion.checkout;
  const guardCollision = () => { const result = promotionCollision(checkout, promotion.candidate); return result ? blockPromotion(ctx, collisionReason(result), null) : null; };
  { const blocked = guardCollision(); if (blocked) return blocked; }
  const observed = observePromotion(checkout, promotion.branch, promotion.expected_old, promotion.candidate);
  if (observed.unknown) return blockPromotion(ctx, 'observation-unknown', null);
  if (observed.headBranch !== promotion.branch) return blockPromotion(ctx, 'checkout-branch-changed', observed);
  if (observed.ref === promotion.expected_old) {
    if (observed.cachedOld && observed.trackedClean && !observed.untracked) {
      await boundary(ctx, 'before-cas');
      revalidate();
      { const blocked = guardCollision(); if (blocked) return blocked; }
      const cas = promoteRef(ctx, promotion);
      if (cas !== 0) {
        if (typeof cas !== 'number') return blockPromotion(ctx, 'observation-unknown', null);
        const after = observePromotion(checkout, promotion.branch, promotion.expected_old, promotion.candidate);
        if (after.unknown) return blockPromotion(ctx, 'observation-unknown', null);
        if (after.ref !== promotion.candidate) return blockPromotion(ctx, 'ref-changed', after);
      }
      await boundary(ctx, 'after-cas');
      fresh = readWaveRecord(ctx.recordPath);
      promotion = { ...promotion, state: 'ref-updated' };
      fresh = journalPromotion(ctx, () => ({ ...promotion, state: 'ref-updated' }));
      promotion = fresh.target.promotion;
      await boundary(ctx, 'before-read-tree');
      revalidate();
      { const blocked = guardCollision(); if (blocked) return blocked; }
      if (!readTree(ctx, promotion)) return blockPromotion(ctx, 'observation-unknown', null);
      await boundary(ctx, 'after-read-tree');
      const done = observePromotion(checkout, promotion.branch, promotion.expected_old, promotion.candidate);
      if (done.unknown) return blockPromotion(ctx, 'observation-unknown', null);
      if (done.ref === promotion.candidate && done.cachedCandidate && done.trackedClean && !done.untracked) {
        fresh = journalPromotion(ctx, current => ({ ...current, state: 'synced', observed: promotionObserved(done) }));
        await releaseConfirmed(ctx, fresh.target.promotion);
        return { status: 'promoted', revision: fresh.revision, replayed: false, ref: promotion.branch, promotion: fresh.target.promotion };
      }
      return blockPromotion(ctx, 'checkout-dirty-after-ref', done);
    }
    return blockPromotion(ctx, 'checkout-dirty', observed);
  }
  if (observed.ref === promotion.candidate) {
    if (observed.cachedCandidate && observed.trackedClean && !observed.untracked) {
      fresh = journalPromotion(ctx, current => ({ ...current, state: 'synced', observed: promotionObserved(observed) }));
      await releaseConfirmed(ctx, fresh.target.promotion);
      return { status: 'promoted', revision: fresh.revision, replayed: true, ref: promotion.branch, promotion: fresh.target.promotion };
    }
    if (!observed.cachedOld) return blockPromotion(ctx, 'index-unknown', observed);
    if (!observed.trackedClean || observed.untracked) return blockPromotion(ctx, 'checkout-dirty-after-ref', observed);
    await boundary(ctx, 'before-read-tree');
    revalidate();
    { const blocked = guardCollision(); if (blocked) return blocked; }
    if (!readTree(ctx, promotion)) return blockPromotion(ctx, 'observation-unknown', null);
    await boundary(ctx, 'after-read-tree');
    const done = observePromotion(checkout, promotion.branch, promotion.expected_old, promotion.candidate);
    if (done.unknown) return blockPromotion(ctx, 'observation-unknown', null);
    if (done.ref === promotion.candidate && done.cachedCandidate && done.trackedClean && !done.untracked) {
      fresh = journalPromotion(ctx, current => ({ ...current, state: 'synced', observed: promotionObserved(done) }));
      await releaseConfirmed(ctx, fresh.target.promotion);
      return { status: 'promoted', revision: fresh.revision, replayed: true, ref: promotion.branch, promotion: fresh.target.promotion };
    }
    return blockPromotion(ctx, 'index-unknown', done);
  }
  return blockPromotion(ctx, 'ref-external-change', observed);
}
export async function recoverPromotion(ctx) {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) throw new Error('ctx is required');
  let fresh;
  try { fresh = readWaveRecord(ctx.recordPath); } catch { return { status: 'blocked', revision: null, reason: 'journal-corrupt', blocked_reason: 'journal-corrupt' }; }
  if (fresh.wave_id !== ctx.waveId) return { status: 'blocked', revision: fresh.revision, reason: 'journal-corrupt', blocked_reason: 'journal-corrupt' };
  let promotion;
  try { promotion = readPromotion(fresh); }
  catch (error) { if (error?.reason === 'journal-corrupt') return { status: 'blocked', revision: fresh.revision, reason: 'journal-corrupt', blocked_reason: 'journal-corrupt' }; throw error; }
  if (!promotion) {
    await inspectPackageClaim(ctx);
    const attempt = `${ctx.waveId}:promotion`;
    const { claims } = await ctx.ownership.inspectClaims({ packageId: ctx.packageId });
    const orphan = (claims ?? []).find(claim => claim.kind === 'checkout' && claim.packageId === ctx.packageId && claim.attempt === attempt);
    if (!orphan) return { status: 'not-started', revision: fresh.revision, reason: 'not-started' };
    requireVerifiedCandidate({ fresh, ctx });
    const { gitCommonDir, worktreeGitDir } = promotionCheckout(ctx);
    if (orphan.epoch !== ctx.packageClaim.epoch) refuse('package-claim-mismatch', 'the retained checkout claim is not at the package claim epoch');
    const bound = await ctx.ownership.reserveCheckout({ packageId: ctx.packageId, attempt, checkout: { gitCommonDir, worktreeGitDir }, coordinator: ctx.coordinator });
    if (bound.status === 'reserved') {
      await releasePromotionCheckout(ctx, bound.claim);
      return { status: 'not-started', revision: fresh.revision, reason: 'not-started' };
    }
    if (bound.claim?.token !== orphan.token || bound.claim?.epoch !== orphan.epoch) refuse('checkout-held', 'the canonical checkout is held by another owner');
    const recovered = await ctx.ownership.recoverClaims({ token: orphan.token, epoch: orphan.epoch, coordinator: ctx.coordinator });
    if (recovered?.status !== 'recovered') refuse('checkout-held', 'the retained checkout claim could not be recovered');
    return promoteWave({ ...ctx, revision: fresh.revision });
  }
  try { validatePromotionJournal({ promotion, fresh, ctx }); }
  catch (error) {
    if (error?.reason === 'journal-corrupt' || error?.reason === 'sha-invalid') return { status: 'blocked', revision: fresh.revision, reason: 'journal-corrupt', blocked_reason: 'journal-corrupt' };
    throw error;
  }
  if (promotion.state === 'synced') {
    await inspectPackageClaim(ctx);
    await releaseConfirmed(ctx, promotion);
    return { status: 'promoted', revision: fresh.revision, replayed: true, ref: promotion.branch, promotion };
  }
  await inspectPackageClaim(ctx);
  const reserved = await reservePromotionCheckout(ctx, { acquire: false });
  if (reserved.acquired) {
    const next = journalPromotion(ctx, current => ({ ...current, checkout_claim: { token: reserved.claim.token, epoch: reserved.claim.epoch } }));
    fresh = next;
  }
  return resumePromotion(ctx, { freshClaim: reserved });
}
export async function promoteWave(ctx) {
  const record = validateContext(ctx);
  await inspectPackageClaim(ctx);
  const existing = record.target?.promotion ?? null;
  if (existing) return recoverPromotion({ ...ctx, revision: record.revision });
  const { candidate } = requireVerifiedCandidate({ fresh: record, ctx });
  const checkout = realpathSync(ctx.target.worktree);
  const baseTree = gitMaybe(checkout, ['rev-parse', `${ctx.baseCommit}^{tree}`]);
  if (!baseTree) refuse('observation-unknown', 'cannot read the base tree for the promotion intent');
  const collision = promotionCollision(checkout, candidate);
  if (collision) refuse(collision.unknown ? 'observation-unknown' : 'ignored-path-collision', 'candidate collides with an ignored path in the canonical checkout');
  const claimed = await reservePromotionCheckout(ctx, { acquire: true });
  const expectedBranch = ctx.target.branch ? `refs/heads/${ctx.target.branch}` : '';
  const beforeIntent = observePromotion(checkout, expectedBranch, ctx.baseCommit, candidate);
  if (beforeIntent.unknown) {
    if (claimed.acquired) await releasePromotionCheckout(ctx, claimed.claim);
    return { status: 'blocked', revision: record.revision, reason: 'observation-unknown', blocked_reason: 'observation-unknown' };
  }
  if (beforeIntent.headBranch !== expectedBranch) {
    if (claimed.acquired) await releasePromotionCheckout(ctx, claimed.claim);
    refuse('checkout-branch-changed', `HEAD is on ${beforeIntent.headBranch || 'a detached HEAD'}, expected ${expectedBranch}`);
  }
  if (beforeIntent.ref !== ctx.baseCommit) {
    if (claimed.acquired) await releasePromotionCheckout(ctx, claimed.claim);
    refuse('ref-changed', `branch is at ${beforeIntent.ref}, expected ${ctx.baseCommit}`);
  }
  if (!beforeIntent.cachedOld || !beforeIntent.trackedClean || beforeIntent.untracked) {
    if (claimed.acquired) await releasePromotionCheckout(ctx, claimed.claim);
    refuse('checkout-dirty', 'canonical checkout has tracked or untracked changes');
  }
  const branch = `refs/heads/${ctx.target.branch}`;
  const candidateTree = record.target.candidate_tree;
  const startedAt = new Date().toISOString();
  const intent = {
    state: 'intent', branch, checkout,
    expected_old: ctx.baseCommit, candidate, candidate_tree: candidateTree,
    index_before: baseTree, started_at: startedAt,
    observed: { ref: beforeIntent.ref, head: beforeIntent.ref, index: beforeIntent.cachedOld, worktree: !beforeIntent.untracked, at: beforeIntent.at },
    blocked_reason: null,
    checkout_claim: { token: claimed.claim.token, epoch: claimed.claim.epoch },
  };
  journalPromotion(ctx, () => intent);
  return resumePromotion(ctx, { freshClaim: claimed });
}
