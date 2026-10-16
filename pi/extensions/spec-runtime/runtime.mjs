import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, realpathSync, rmSync, readdirSync, statSync, openSync, closeSync } from 'node:fs';
import { dirname, basename, join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { activityRecorder } from './monitor.mjs';
import { SCOUT_MODEL } from './scout.mjs';
import { createLogSummary } from '../../../scripts/spec-facts/core.mjs';
import { checkPackage, locatePackage } from '../../../scripts/spec-location/index.mjs';
import { artifactEnvironment } from '../../../scripts/spec-location/artifact-environment.mjs';
import { prepareSpecWorktree } from '../../../scripts/spec-location/worktree.mjs';
import { decide, collectFacts } from '../../../scripts/jev/core.mjs';
import { preparedEntry } from './startup.mjs';
import { splitModelSelector, assertModelSelector, configurationFailure, configurationAction } from './model-selector.mjs';
import { submitCompletion, completionStatus, refreshProgress, revision, recordVerification, invalidateCompletion, completeOutcomes } from './completion.mjs';
import { createOwnership } from './ownership.mjs';
import { createPacketWorkspaces } from './editor-workspaces.mjs';
import { createSystemdServiceAdapter, createWaveDeadline, deadlineRemainingMs } from './linux-resources.mjs';
import { createWaveLifecycle, environmentFacts } from './wave-lifecycle.mjs';
export { environmentFacts } from './wave-lifecycle.mjs';
import { createWaveReviewRuntime } from './wave-review-runtime.mjs';
import { stagePrompt } from './wave-review-state.mjs';
import { observedRuns, buildDependencyHandoff } from './dependency-handoff.mjs';
export { buildDependencyHandoff };
import { PROVIDER_RECOVERY } from './provider-recovery.mjs';
import { inspectProcess } from '../../../scripts/spec-observe/process-identity.mjs';
import { selectWaveSubject, candidateLeaseSubject, candidateCapacityAttempt } from './wave-candidate-binding.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME_MODULE_PATH = resolve(fileURLToPath(import.meta.url));
const terminal = new Set(['completed', 'failed', 'cancelled', 'stale']);
const timestamp = () => new Date().toISOString();
const read = file => JSON.parse(readFileSync(file, 'utf8'));
// CURRENT revision identity for the launch prompt. The prompt is built before any
// contained service exists, and a wave member's merged overlay is not mounted in the
// coordinator, so a wave never runs git status/rev-parse against that external empty
// mountpoint. Its durable frozen base is the revision identity; the private git
// object store is only queried if a caller needs it. Serial runs are unchanged.
function promptRevision(record) {
  const binding = record.wave_bindings;
  if (!binding) return revision(record);
  return { commit: binding.base_commit, dirty: null };
}
// The card determines relevance; the latest attempt supplies observations. Do not
// infer prerequisite acceptance or carry every historical blocker into a new step.
function currentHandoff(record, { sameStepOnly = false } = {}) {
  const card = readFileSync(record.step, 'utf8');
  const currentNumber = Number(basename(record.step).match(/step-(\d+)/)?.[1]);
  const steps = sameStepOnly
    ? (Number.isFinite(currentNumber) ? [String(currentNumber).padStart(3, '0')] : [])
    : [...new Set([basename(record.step).match(/step-(\d+)/)?.[1],
      ...[...card.matchAll(/step-(\d+)/g)].map(match => match[1])].filter(Boolean))];
  const runsDir = join(record.package, 'runtime/runs');
  const coverageGaps = [];
  const runs = observedRuns(record.package, coverageGaps);
  // Cards also use prose such as "Prerequisites: steps 1–2". Supplement exact
  // references with bounded earlier results, clearly labelled as context only.
  const earlier = sameStepOnly ? [] : [...new Set(runs.map(run => basename(run.step).match(/step-(\d+)/)?.[1])
    .filter(step => step && Number(step) < currentNumber))].sort((a, b) => Number(b) - Number(a));
  for (const step of earlier.slice(0, 7)) if (!steps.includes(step)) steps.push(step);
  const latest = new Map();
  for (const run of runs) {
    const step = basename(run.step || '').match(/step-(\d+)/)?.[1];
    if (!steps.includes(step) || run.id === record.id || !run.state) continue;
    const prior = latest.get(step);
    if (!prior || (run.started_at || '') >= (prior.started_at || '')) latest.set(step, run);
  }
  const observations = steps.slice(0, 8).map(step => {
    const run = latest.get(step);
    const file = run && join(runsDir, `${run.id}-completion.json`);
    let completion;
    try {
      if (file && existsSync(file)) {
        completion = read(file);
        if (!completion || typeof completion !== 'object') throw new Error('Invalid observation');
      }
    } catch { coverageGaps.push(`Unreadable completion observation: ${file}`); completion = undefined; }
    const learningPath = [join(record.package, 'learnings', `step-${step}-learning.md`),
      join(record.package, `step-${step}-learning.md`)].find(existsSync);
    let canonical = '';
    try { if (!completion && learningPath) canonical = readFileSync(learningPath, 'utf8').split(/(?=^##\s)/m)
      .filter(part => /^##\s+(Decisions|Unresolved|Findings)/.test(part)).join('\n'); }
    catch { coverageGaps.push(`Unreadable canonical learning: ${learningPath}`); }
    const values = value => Array.isArray(value) ? value : [];
    const scalar = value => value == null ? null : String(value).slice(0, 300);
    const bounded = values => Array.isArray(values) ? values.slice(0, 4).map(value => String(value).slice(0, 300)) : [];
    return { step, relevance: earlier.includes(step) && !card.includes(`step-${step}`) ? 'earlier result context; dependency not inferred' : 'same step or card reference',
      run_id: scalar(run?.id), execution: scalar(run?.state) ?? 'no runtime result',
      completion_path: completion ? file : null, commit: scalar(completion?.learning?.commit),
      outcome: scalar(completion?.learning?.outcome), invalidated_at: scalar(completion?.invalidated_at),
      checkpoint_reason: scalar(completion?.learning?.checkpoint_reason),
      remaining_work: bounded(completion?.learning?.remaining_work),
      decisions: bounded(completion?.decisions), unresolved_obligations: bounded(completion?.gaps),
      findings: bounded(completion?.findings), evidence: values(completion?.learning?.evidence).filter(entry => entry && typeof entry === 'object').slice(0, 6).map(entry => ({
        id: scalar(entry.id), status: scalar(entry.status), observedCommit: scalar(entry.observedCommit),
        artifact: scalar(entry.artifact), proof_boundary: scalar(entry.proof_boundary),
        applicability: scalar(entry.applicability) })),
      learning_path: learningPath ?? null, canonical_observations: canonical.slice(0, 1200),
      truncated: canonical.length > 1200 || ['decisions', 'gaps', 'findings'].some(key =>
        values(completion?.[key]).length > 4 || values(completion?.[key]).some(value => String(value).length > 300))
        || values(completion?.learning?.remaining_work).length > 4
        || values(completion?.learning?.remaining_work).some(value => String(value).length > 300)
        || values(completion?.learning?.evidence).length > 6
        || values(completion?.learning?.evidence).some(entry => entry && Object.values(entry).some(value => String(value).length > 300))
        || [completion?.learning?.commit, completion?.learning?.outcome, completion?.invalidated_at,
          completion?.learning?.checkpoint_reason].some(value => value != null && String(value).length > 300),
      assessment: 'Observation only; inspect the full handoff and latest review/fix evidence for applicability.' };
  });
  while (JSON.stringify(observations).length > 10000 && observations.length) observations.pop();
  return `CURRENT: ${JSON.stringify({ step: record.step, checkout: record.checkout, revision: promptRevision(record), observations,
    omitted_steps: Math.max(0, steps.length - observations.length), coverage_gaps: coverageGaps.slice(0, 8).map(gap => gap.slice(0, 300)),
    sources: [join(record.package, 'runtime/progress.json'), join(record.package, 'history-index.json')],
    obligations: 'Read all card prerequisites. Reconcile historical gaps against latest evidence; worker exit and handoff outcome do not establish acceptance. Preserve original evidence revisions.' })}\n`;
}
export function atomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
// The serial latest-run predicate: run.json names an active state whose
// coordinator is still alive. Extracted so the serial admission path and the
// wave-eligibility probe share one definition.
export function serialRunActive(packagePath) {
  const latest = join(packagePath, 'runtime/run.json');
  if (!existsSync(latest)) return false;
  let prior;
  try { prior = read(latest); } catch { return false; }
  if (!['running', 'cancelling', 'blocked'].includes(prior.state)) return false;
  return processAlive(prior.coordinator_pid ?? prior.pid);
}
// Nonterminal wave records durably persisted under runtime/waves. A record is
// live while its state is neither integrated nor cancelled. An unreadable file
// cannot be shown terminal, so it fails closed as `unknown`.
const WAVE_RECORD_NAME = /^[A-Za-z0-9_-]{1,128}\.json$/;
export function activeWaveRecords(packagePath) {
  const dir = join(packagePath, 'runtime', 'waves');
  if (!existsSync(dir)) return [];
  const records = [];
  for (const name of readdirSync(dir)) {
    if (!WAVE_RECORD_NAME.test(name)) continue;
    const recordPath = join(dir, name);
    let record;
    try { record = read(recordPath); } catch {
      records.push({ wave_id: name.slice(0, -'.json'.length), state: 'unknown', generation: null, record_path: recordPath });
      continue;
    }
    const state = record?.state;
    if (state === 'integrated' || state === 'cancelled') continue;
    records.push({ wave_id: record?.wave_id ?? name.slice(0, -'.json'.length), state: state ?? 'unknown',
      generation: record?.generation ?? record?.expected_generation ?? null, record_path: recordPath });
  }
  return records;
}
function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel);
}
// D10: accepted prerequisites come from the requires graph; the same-step CURRENT
// observations still carry this step's retry state.
function dependencyContext(record, targetIds) {
  const step = Number(basename(record.step).match(/step-(\d+)/)?.[1]);
  const targets = targetIds ?? [record.target];
  const handoff = buildDependencyHandoff({ packageDir: record.package, step, targets });
  if (!handoff) return currentHandoff(record);
  return `DEPENDENCIES: ${JSON.stringify(handoff)}\n${currentHandoff(record, { sameStepOnly: true })}`;
}

// ---------------------------------------------------------------------------
// Wave-member provenance binding.
//
// A wave run takes its checkout authority from the durable wave record under
// runtime/waves, never from the caller. The caller supplies only the membership
// identity (wave id, generation, step, attempt, phase, package claim token and
// coordinator epoch); the retained step-workspaces object supplies the
// workspace and the ownership registry confirms the package and checkout
// claims. This is input binding only: it neither schedules phases nor changes
// serial launch behavior.
// ---------------------------------------------------------------------------

const WAVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const WAVE_VERSION_FIELDS = ['version', 'schema_version'];
const WAVE_INPUT_FIELDS = ['wave_id', 'expected_generation', 'step_number', 'attempt_id', 'phase', 'claim_token', 'coordinator_epoch'];

const waveInvalid = (code, message, remedy) => refusalError({ code, message, remedy });

function realOrNull(path) {
  if (typeof path !== 'string' || !path) return null;
  try { return realpathSync(path); } catch { return null; }
}

function readWaveRecord(packagePath, waveId) {
  if (typeof waveId !== 'string' || !WAVE_ID_PATTERN.test(waveId))
    throw waveInvalid('wave-id-invalid', 'wave_id must be 1-128 ASCII letters/digits/underscore/hyphen.', 'Pass the wave id recorded under runtime/waves.');
  const file = join(packagePath, 'runtime', 'waves', `${waveId}.json`);
  if (!existsSync(file)) throw waveInvalid('wave-record-missing', `No wave record at runtime/waves/${waveId}.json.`, 'Prepare the wave record before binding a run to it.');
  let record;
  try { record = read(file); } catch { throw waveInvalid('wave-record-unreadable', `Wave record runtime/waves/${waveId}.json is not valid JSON.`, 'Repair the wave record.'); }
  const declared = WAVE_VERSION_FIELDS.filter(key => record[key] !== undefined).map(key => record[key]);
  if (!declared.length || declared.some(value => value !== 1) || new Set(declared).size > 1)
    throw waveInvalid('wave-record-version', 'Wave record version must be 1.', 'Rewrite the wave record at version 1.');
  return record;
}

// One canonical claim token: a top-level claim_token or coordinator.claim_token,
// never both with conflicting values.
function waveClaimToken(record) {
  const top = record.claim_token;
  const nested = record.coordinator?.claim_token;
  if (top !== undefined && nested !== undefined && top !== nested)
    throw waveInvalid('wave-claim-conflict', 'Wave record declares two different claim tokens.', 'Keep one canonical claim_token.');
  const token = top ?? nested;
  if (typeof token !== 'string' || token.length === 0)
    throw waveInvalid('wave-claim-missing', 'Wave record declares no claim_token.', 'Record the package claim token on the wave.');
  return token;
}

function requireMemberPath(value, label) {
  if (typeof value !== 'string' || !value) throw waveInvalid('wave-workspace-malformed', `Wave member workspace ${label} is missing.`, 'Record the retained step-workspaces object.');
  return value;
}

// The retained step-workspaces object is the sole checkout authority: its
// backend selects the editable path and its phase claim is keyed on the attempt
// upper. Public run provenance is normalised to snake_case while the full
// workspace object is retained on the wave record for a later remount.
function workspaceIdentity(workspace) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace))
    throw waveInvalid('wave-workspace-malformed', 'Wave member workspace is not the retained step-workspaces object.', 'Record the retained object.');
  const isOverlay = workspace.backend === 'overlayfs';
  if (!isOverlay && workspace.backend !== 'worktree')
    throw waveInvalid('wave-workspace-backend', 'Wave member workspace has an unknown backend.', 'Provision an overlayfs or worktree workspace.');
  const attemptRoot = isOverlay
    ? dirname(requireMemberPath(workspace.upper, 'workspace.upper'))
    : dirname(requireMemberPath(workspace.worktree, 'workspace.worktree'));
  const checkout = isOverlay ? requireMemberPath(workspace.merged, 'workspace.merged') : requireMemberPath(workspace.worktree, 'workspace.worktree');
  const gitDir = isOverlay ? requireMemberPath(workspace.gitDir, 'workspace.gitDir') : git(workspace.worktree, 'rev-parse', '--absolute-git-dir');
  const upper = isOverlay ? requireMemberPath(workspace.upper, 'workspace.upper') : join(attemptRoot, 'upper');
  const work = isOverlay ? requireMemberPath(workspace.work, 'workspace.work') : join(attemptRoot, 'work');
  const lower = isOverlay ? requireMemberPath(workspace.lower, 'workspace.lower') : null;
  const claim = workspace.claim;
  if (!claim || typeof claim !== 'object' || typeof claim.token !== 'string' || !claim.token || claim.epoch === undefined || claim.epoch === null || claim.epoch === '')
    throw waveInvalid('wave-workspace-claim', 'Wave member workspace carries no phase claim.', 'Record the retained claim token and epoch.');
  return { backend: workspace.backend, attemptRoot, checkout, gitDir, upper, work, lower,
    baseCommit: workspace.baseCommit ?? null, packageId: workspace.packageId ?? null, claim: { token: claim.token, epoch: claim.epoch } };
}

// All wave phase reservations reuse the coordinator identity normalized from the
// live package claim: the ownership registry requires a complete
// { session, epoch, pid, started_at } identity and a wave never invents a pid or
// start time. The claim coordinator must still match the durable wave record.
function waveCoordinator(record, packageClaim) {
  const coordinator = packageClaim?.coordinator;
  if (!coordinator || typeof coordinator !== 'object')
    throw waveInvalid('wave-coordinator-missing', 'The live package claim carries no validated coordinator identity.', 'Reacquire the package claim with its full coordinator identity before binding.');
  if (String(coordinator.epoch) !== String(record.coordinator?.epoch) || coordinator.session !== record.coordinator?.session)
    throw waveInvalid('wave-coordinator-mismatch', 'The live package claim coordinator does not match the durable wave coordinator.', 'Reacquire the package claim under the wave coordinator.');
  return { session: coordinator.session, epoch: coordinator.epoch, pid: coordinator.pid, started_at: coordinator.started_at };
}

async function resolveWaveBinding(input, { packagePath, packageRef, target }, ownershipRoot) {
  for (const field of WAVE_INPUT_FIELDS) {
    if (input[field] === undefined || input[field] === null || input[field] === '')
      throw waveInvalid('wave-input-incomplete', `Wave run requires ${field}.`, 'Pass the validated wave membership identity.');
  }
  if (typeof ownershipRoot !== 'string' || !ownershipRoot)
    throw waveInvalid('wave-ownership-unavailable', 'Wave binding requires the ownership registry root.', 'Construct Runtime with an ownership registry or ownership root.');
  const record = readWaveRecord(packagePath, input.wave_id);
  const claimToken = waveClaimToken(record);
  if (input.claim_token !== claimToken) throw waveInvalid('wave-claim-mismatch', 'Supplied claim_token does not match the wave record.', 'Pass the canonical wave claim token.');
  const epoch = record.coordinator?.epoch;
  if (epoch === undefined || epoch === null || epoch === '' || String(input.coordinator_epoch) !== String(epoch))
    throw waveInvalid('wave-epoch-mismatch', 'Supplied coordinator_epoch does not match the wave record.', 'Pass the wave coordinator epoch.');
  if (record.package_ref !== packageRef)
    throw waveInvalid('wave-package-mismatch', 'Wave record package_ref does not match the located package.', 'Bind the wave to the located package.');
  if (!record.target || record.target.id !== target.id)
    throw waveInvalid('wave-target-mismatch', 'Wave record target does not match the step target.', 'Record the wave target for this step.');
  if (typeof record.target.base_commit !== 'string' || !record.target.base_commit)
    throw waveInvalid('wave-base-missing', 'Wave target records no base commit.', 'Record the wave target base commit.');
  if (typeof record.generation !== 'number' || !Number.isInteger(record.generation) || record.generation !== input.expected_generation)
    throw waveInvalid('wave-generation-mismatch', 'Supplied expected_generation does not match the wave record.', 'Pass the current wave generation.');
  const cardStep = Number(basename(input.step).match(/^step-(\d+)-subspec\.md$/)?.[1]);
  if (!Number.isInteger(cardStep) || input.step_number !== cardStep)
    throw waveInvalid('wave-step-mismatch', 'Supplied step_number does not match the step card.', 'Pass the card step number.');
  let selected;
  try {
    selected = selectWaveSubject(record, { step_number: input.step_number, candidate: input.candidate,
      attempt_id: input.attempt_id, phase: input.phase });
  } catch (error) {
    throw waveInvalid(error?.code || 'wave-member-mismatch', error?.message || 'Wave member attempt or phase does not match the supplied identity.', 'Pass the recorded member attempt and phase.');
  }
  const member = selected.subject;
  const candidate = selected.candidate;
  if (!candidate && (!member || typeof member !== 'object'))
    throw waveInvalid('wave-member-missing', `Wave record has no member for step ${input.step_number}.`, 'Record the member before binding a run.');
  if (!candidate && (Number(member.step) !== input.step_number || member.attempt_id !== input.attempt_id || member.phase !== input.phase))
    throw waveInvalid('wave-member-mismatch', 'Wave member attempt or phase does not match the supplied identity.', 'Pass the recorded member attempt and phase.');
  const identity = workspaceIdentity(member.workspace);
  if (identity.baseCommit !== record.target.base_commit)
    throw waveInvalid('wave-base-mismatch', 'Wave member workspace base commit does not match the target base.', 'Provision the member at the wave target base.');
  if (identity.packageId !== null && identity.packageId !== packageRef)
    throw waveInvalid('wave-workspace-package', 'Wave member workspace package does not match the wave package.', 'Bind the member workspace to this package.');
  const sourceCommon = realOrNull(record.target.common);
  if (!sourceCommon) throw waveInvalid('wave-source-missing', 'Wave target records no canonical source common dir.', 'Record target.common.');
  const targetCommon = realOrNull(target.common);
  if (targetCommon && targetCommon !== sourceCommon)
    throw waveInvalid('wave-source-mismatch', 'Wave target common dir does not match the located target.', 'Record the canonical target common dir.');
  const integration = realOrNull(record.target.integration_checkout);
  // The recorded integration checkout must be the located target's canonical
  // checkout: its worktree when one exists, otherwise its primary checkout. A
  // wave cannot name an arbitrary checkout as its integration identity.
  const locatedIntegration = realOrNull(target.worktree) || realOrNull(target.primary);
  if (integration && locatedIntegration && integration !== locatedIntegration)
    throw waveInvalid('wave-integration-mismatch', 'Wave target integration checkout does not match the located target.', 'Record the canonical integration checkout for this target.');
  const checkoutReal = realpathSync(identity.checkout);
  const gitDirReal = realpathSync(identity.gitDir);
  if (integration && (checkoutReal === integration || inside(integration, checkoutReal)))
    throw waveInvalid('wave-checkout-integration', 'Wave member workspace reuses the integration checkout.', 'Provision a retained attempt workspace.');
  // A linked worktree keeps private metadata at .git/worktrees/<name> inside the
  // canonical source common dir, which may itself live under the integration
  // checkout. That is legitimate: the member edits its own worktree and the
  // integration checkout keeps its own gitdir. A blanket containment rejection
  // is relaxed only when the private git dir is narrowly validated as belonging
  // to this attempt worktree, not to the integration checkout itself.
  if (integration && (gitDirReal === integration || inside(integration, gitDirReal))) {
    let linkedPrivate = false;
    if (identity.backend === 'worktree') {
      try {
        const worktreesRoot = join(sourceCommon, 'worktrees');
        const immediateChild = dirname(gitDirReal) === worktreesRoot && basename(gitDirReal) !== '' && basename(gitDirReal) !== '.';
        // The private git dir backlink names the worktree it belongs to.
        const backlink = immediateChild ? realpathSync(readFileSync(join(gitDirReal, 'gitdir'), 'utf8').trim()) : null;
        const expectedCheckoutGit = join(checkoutReal, '.git');
        const commonDirRaw = git(identity.checkout, 'rev-parse', '--git-common-dir');
        const commonDirReal = realOrNull(isAbsolute(commonDirRaw) ? commonDirRaw : resolve(identity.checkout, commonDirRaw));
        const integrationGitDir = realOrNull(target.worktree || target.primary)
          ? realpathSync(git(target.worktree || target.primary, 'rev-parse', '--absolute-git-dir'))
          : null;
        linkedPrivate = immediateChild
          && backlink === expectedCheckoutGit
          && commonDirReal === sourceCommon
          && gitDirReal !== integrationGitDir;
      } catch { linkedPrivate = false; }
    }
    if (!linkedPrivate)
      throw waveInvalid('wave-gitdir-integration', 'Wave member workspace private git dir reuses the integration checkout.', 'Provision a retained attempt workspace.');
  }
  if (!inside(identity.attemptRoot, checkoutReal))
    throw waveInvalid('wave-checkout-outside-attempt', 'Wave member checkout is outside its retained attempt root.', 'Provision the member under the wave attempt root.');
  for (const [step, other] of Object.entries(record.members || {})) {
    if ((!candidate && Number(step) === input.step_number) || !other || typeof other !== 'object' || !other.workspace) continue;
    let otherIdentity;
    try { otherIdentity = workspaceIdentity(other.workspace); } catch { continue; }
    const otherCheckout = realOrNull(otherIdentity.checkout);
    const otherGitDir = realOrNull(otherIdentity.gitDir);
    if ((otherCheckout && otherCheckout === checkoutReal) || (otherGitDir && otherGitDir === gitDirReal))
      throw waveInvalid('wave-workspace-alias', 'Two wave members reuse the same checkout or private git dir.', 'Give each member a distinct retained workspace.');
  }
  // Raw registry claims carry the checkout identity keys that projected claims omit.
  const claims = readOwnershipClaimsSync(ownershipRoot);
  const packageClaim = claims.find(claim => claim.kind === 'package' && claim.token === claimToken && String(claim.epoch) === String(epoch));
  if (!packageClaim)
    throw waveInvalid('wave-package-claim', 'No live package claim matches the wave token and epoch.', 'Recover or reacquire the package claim before binding.');
  const coordinator = waveCoordinator(record, packageClaim);
  const checkoutClaim = claims.find(claim => claim.kind === 'checkout' && claim.token === identity.claim.token);
  if (!checkoutClaim || String(checkoutClaim.epoch) !== String(identity.claim.epoch) || checkoutClaim.packageId !== packageRef)
    throw waveInvalid('wave-checkout-claim', 'No live checkout claim matches the retained workspace.', 'Re-provision or recover the member workspace claim.');
  const claimed = checkoutClaim.checkout || {};
  if (identity.backend === 'overlayfs') {
    const upperReal = realpathSync(identity.upper);
    if (realOrNull(claimed.gitCommonDir) !== upperReal || realOrNull(claimed.worktreeGitDir) !== upperReal)
      throw waveInvalid('wave-checkout-mismatch', 'Checkout claim does not cover the retained attempt upper.', 'Re-provision the member workspace.');
  } else {
    // Worktree fallback reserves this same ownership key without creating an
    // overlay upper directory. Compare the canonical key, not its realpath.
    const upperKey = join(realpathSync(identity.attemptRoot), 'upper');
    if (claimed.gitCommonDir !== upperKey || claimed.worktreeGitDir !== upperKey)
      throw waveInvalid('wave-checkout-mismatch', 'Checkout claim does not cover the retained attempt upper.', 'Re-provision the member workspace.');
  }
  return { checkout: identity.checkout, primary: target.primary, target: target.id,
    wave: { wave_id: input.wave_id, generation: record.generation, step_number: input.step_number, attempt_id: input.attempt_id,
      phase: input.phase, claim_token: claimToken, coordinator_epoch: epoch, coordinator, package_ref: packageRef, target: target.id,
      base_commit: record.target.base_commit, backend: identity.backend, source_common: sourceCommon, git_dir: gitDirReal,
      integration_checkout: integration,
      upper_id: member.workspace.upperId ?? null, checkout_claim: identity.claim.token,
      checkout_claim_epoch: checkoutClaim.epoch, checkout_claim_attempt: checkoutClaim.attempt ?? null,
      layers: identity.backend === 'overlayfs' ? { lower: identity.lower, upper: identity.upper, work: identity.work, merged: identity.checkout, gitDir: identity.gitDir } : null,
      worktree: identity.backend === 'worktree' ? identity.checkout : null,
      ...(candidate === null ? {} : { candidate }) } };
}

async function bindWaveMemberRun(config, runId) {
  const result = await runLockedMutation(`${config.wave_path}.lock`, 'bind-wave-member', {
    file: config.wave_path, generation: config.wave_bindings.generation, claimToken: config.wave_bindings.claim_token,
    coordinatorEpoch: config.wave_bindings.coordinator_epoch, stepNumber: config.wave_bindings.step_number,
    attemptId: config.wave_bindings.attempt_id, phase: config.wave_bindings.phase,
    candidate: config.wave_bindings.candidate,
    checkoutClaim: config.wave_bindings.checkout_claim, runId,
  });
  if (!result || result.ok !== true)
    throw waveInvalid(result?.code || 'wave-bind-failed', result?.message || 'Could not bind the wave member run.', 'Repair the wave record and retry.');
}

export function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return true;
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}
export function event(record, name, detail = {}) {
  const line = `${JSON.stringify({ timestamp: timestamp(), event: name, run_id: record.id, ...detail })}\n`;
  const file = join(record.package, 'runtime/events.jsonl');
  // Every writer, serial or wave, appends through the same flock: no data is
  // interpolated into a shell, a serial writer cannot interleave with a
  // concurrent wave member, and a failed append is surfaced rather than lost.
  // `${file}.lock` is a permanent synchronization anchor: it is intentionally
  // never unlinked, since a waiter can hold the old inode after an unlink and a
  // fresh lock file would then let two writers proceed concurrently.
  const appended = spawnSync('flock', ['-x', `${file}.lock`, process.execPath, RUNTIME_MODULE_PATH, 'append-event'],
    { input: JSON.stringify({ file, line }), encoding: 'utf8' });
  if (appended.error || appended.status !== 0)
    throw new Error(`Cannot append runtime event ${name}: ${appended.error?.message || `flock exited ${appended.status}`}${appended.stderr ? `; ${String(appended.stderr).trim().slice(0, 200)}` : ''}`);
}
function save(record) {
  atomic(join(record.package, 'runtime/runs', `${record.id}.json`), record);
  // A wave run or a run-only command phase never replaces the serial latest
  // pointer; only its own durable run record is written.
  if (record.wave_bindings || record.command_phase) return;
  atomic(join(record.package, 'runtime/run.json'), record);
}
// A spec-location refusal as an Error that keeps the machine-readable code and remedy.
export function refusalError({ code, message, remedy }) {
  return Object.assign(new Error(`${code}: ${message}${remedy ? ` ${remedy}` : ''}`), { code, remedy });
}
// One shared role contract: native argv and the in-process guards read the same
// table, so a role's tools, profile, model and session can never disagree.
// `tools` are the names the runtime registers; `providerTools` are inert for
// native Pi (1.2.0 treats --tools as an allowlist matcher) and only bind when
// an adapter replaces tools.
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
};
export const ROLE_CONTRACT = deepFreeze({
  owner: {
    profile: 'spec-step-owner.md',
    tools: ['read', 'grep', 'find', 'ls', 'spec_editor', 'spec_answer', 'spec_verify', 'spec_scout', 'spec_search', 'spec_advice', 'spec_complete'],
    providerTools: [],
    modelKey: 'owner_model',
    sessionKey: 'owner_session',
    subagents: true
  },
  editor: {
    profile: 'spec-step-editor.md',
    tools: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'spec_question'],
    providerTools: [],
    modelKey: 'editor_model',
    sessionKey: 'editor_session',
    subagents: false
  },
  reviewer: {
    profile: 'spec-stage-reviewer.md',
    tools: ['read', 'grep', 'find', 'ls', 'bash', 'spec_stage_complete'],
    providerTools: ['exec_command', 'write_stdin'],
    modelKey: 'review_model',
    sessionKey: 'reviewer_session',
    subagents: false
  },
  fixer: {
    profile: 'spec-step-fixer.md',
    tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'spec_stage_complete'],
    providerTools: ['exec_command', 'write_stdin', 'apply_patch'],
    modelKey: 'fix_model',
    sessionKey: 'fixer_session',
    subagents: false
  }
});

// A parallel packet's editor keeps the editor contract minus its shell and owner channel.
export const FENCED_EDITOR_TOOLS = Object.freeze(ROLE_CONTRACT.editor.tools.filter(name => !['bash', 'spec_question'].includes(name)));

// The real package folder for a `workspace/slug` ref, the folder, or a file inside it.
export async function packageDirOf(ref, location = {}) {
  const found = await locatePackage(ref, location);
  if (!found.ok) throw refusalError(found);
  return realpathSync(found.packageDir);
}
// loadRun takes an already located package folder (or a file inside it).
const packageFolder = path => { const real = realpathSync(path); return statSync(real).isFile() ? dirname(real) : real; };
export function loadRun(packagePath, id) {
  if (id && !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid run_id');
  return read(join(packageFolder(packagePath), 'runtime', id ? `runs/${id}.json` : 'run.json'));
}
export function summary(record) {
  return { run_id: record.id, assignment_id: record.assignment_id, workflow_id: record.workflow_id ?? null, wave: record.wave_bindings ?? null,
    attempt_kind: record.attempt_kind ?? null, session_scope: record.session_scope ?? 'package', state: record.state, package: record.package, package_ref: record.package_ref ?? null, step: record.step,
    target: record.target ?? null, checkout: record.checkout, owner_session: record.owner_session, editor_session: record.editor_session,
    ledger: join(record.package, 'runtime/progress.json'), run_receipt: runFileOf(record), events: join(record.package, 'runtime/events.jsonl'),
    checks: ['canonical package', 'checkout repository and target branch', 'no live coordinator already running this package'],
    owner_model: record.owner_model, editor_model: record.editor_model, routing_reason: record.routing_reason,
    environment: record.environment,
    handoff: record.handoff || completionStatus(record), progress: join(record.package, 'runtime/progress.json'),
    result: record.result, stop_reason: record.stop_reason, shutdown_cleanup: record.shutdown_cleanup === true,
    result_truncated: record.result_truncated, full_result_path: record.full_result_path, error: record.error,
    next: record.state === 'failed' && record.stop_reason === 'length' ? 'Inspect preserved partial work and assign a bounded continuation; the packet did not complete. Do not repeat the same assignment unchanged.' : record.handoff?.status === 'handoff_incomplete' ? 'Repair the structured handoff only; preserve code and prior checks. Review/fix remains required.' : record.state === 'running' ? 'await completion event; do not poll' : record.state === 'blocked' ? 'resolve worker termination before another writer' : 'evaluate result; independent step review remains required' };
}
// A run holds the writer role while its own record is running (or blocked on a live
// process group) and nothing has revoked it. Revocation is a marker file so a worker
// process can revoke without rewriting the coordinator's run record.
const runFileOf = record => join(record.package, 'runtime/runs', `${record.id}.json`);
const waveFileOf = record => record.wave_path || join(record.package, 'runtime', 'waves', `${record.wave_bindings?.wave_id}.json`);
const revokedFile = record => join(record.package, 'runtime/runs', `${record.id}-revoked.json`);
export const editorSlot = record => join(record.package, 'runtime/runs', `${record.id}-editor-slot`);
export function assertLease(record) {
  let current;
  try { current = read(runFileOf(record)); } catch { /* absent */ }
  if (!['running', 'blocked'].includes(current?.state) || existsSync(revokedFile(record))) throw new Error('Writer lease is absent, replaced, or revoked; stop this assignment.');
  if (current.wave_bindings) assertWaveLease(current);
}

function readOwnershipClaimsSync(root) {
  if (typeof root !== 'string' || !root) return [];
  try { const state = read(join(root, 'claims.json')); return Array.isArray(state.claims) ? state.claims : []; } catch { return []; }
}

// Synchronously revalidate the durable wave generation, member and run binding
// plus the registry token/epoch and the recorded model (an explicit
// provider_recovery fallback is an accepted recorded model). run.json is never
// consulted for wave authority.
function assertWaveLease(record) {
  // A candidate command phase carries no wave member binding; the run's own
  // running/blocked state and revocation marker are its only lease. Validate
  // those explicitly and stop before the member/claim checks that require
  // wave_bindings.
  if (!record.wave_bindings && record.command_phase?.subject?.kind === 'candidate') {
    assertLease(record);
    return;
  }
  const binding = record.wave_bindings;
  const wavePath = record.wave_path || join(record.package, 'runtime', 'waves', `${binding.wave_id}.json`);
  let wave;
  try { wave = read(wavePath); } catch { throw new Error('Wave lease is absent: the durable wave record cannot be read; stop this assignment.'); }
  const declared = WAVE_VERSION_FIELDS.filter(key => wave[key] !== undefined).map(key => wave[key]);
  if (!declared.length || declared.some(value => value !== 1) || new Set(declared).size > 1
    || wave.generation !== binding.generation || waveClaimToken(wave) !== binding.claim_token
    || wave.coordinator?.epoch !== binding.coordinator_epoch || wave.coordinator?.session !== binding.coordinator?.session || wave.package_ref !== binding.package_ref
    || wave.target?.id !== binding.target || wave.target?.base_commit !== binding.base_commit)
    throw new Error('Wave lease is absent or replaced; stop this assignment.');
  if (binding.candidate !== undefined && binding.candidate !== null) {
    // A candidate binding leases the target.repair subject selected by the
    // shared helper; the ordinary member check does not apply.
    candidateLeaseSubject(wave, binding, record.id);
  } else {
    const member = wave.members?.[String(binding.step_number)];
    if (!member || member.attempt_id !== binding.attempt_id || member.phase !== binding.phase || member.run_id !== record.id)
      throw new Error('Wave member binding is absent or replaced; stop this assignment.');
  }
  const claims = readOwnershipClaimsSync(binding.ownership_root);
  if (!claims.some(claim => claim.kind === 'package' && claim.token === binding.claim_token && String(claim.epoch) === String(binding.coordinator_epoch) && claim.packageId === binding.package_ref))
    throw new Error('Wave package claim is absent or replaced; stop this assignment.');
  if (!claims.some(claim => claim.kind === 'checkout' && claim.token === binding.checkout_claim && claim.packageId === binding.package_ref
    && String(claim.epoch) === String(binding.checkout_claim_epoch) && claim.attempt === binding.checkout_claim_attempt))
    throw new Error('Wave checkout claim is absent or replaced; stop this assignment.');
  // Capacity is reserved before the root launches; its token/epoch/attempt must
  // still match this run's reservation and the wave membership attempt.
  const capacityKey = candidateCapacityAttempt(binding, record.command_phase?.purpose ?? binding.phase);
  const capacity = record.capacity_claim;
  if (!capacity || typeof capacity.token !== 'string' || capacity.epoch === undefined || capacity.attempt !== capacityKey)
    throw new Error('Wave capacity claim is absent or replaced; stop this assignment.');
  if (!claims.some(claim => claim.kind === 'capacity' && claim.token === capacity.token && String(claim.epoch) === String(capacity.epoch)
    && claim.attempt === capacity.attempt && claim.packageId === binding.package_ref))
    throw new Error('Wave capacity claim is absent or replaced; stop this assignment.');
  if (!record.deadline || !wave.deadline || record.deadline.expires_at !== wave.deadline.expires_at || record.deadline.started_at !== wave.deadline.started_at)
    throw new Error('Wave deadline is absent or replaced; stop this assignment.');
  // A command phase has no worker model, so only a launched run checks recorded
  // models. The wave/member/checkout/capacity/deadline checks above apply to
  // every record, including commands.
  if (!record.command_phase) {
    // Each role's recorded model must match that role's own original model. The
    // provider fallback is accepted only for a role whose recovery event was
    // actually recorded; there is no cross-role or unconditional fallback.
    const fallback = `${PROVIDER_RECOVERY.fallback.provider}/${PROVIDER_RECOVERY.fallback.model}`;
    const recordedModel = (value, expected, role) => typeof value === 'string' && value.length > 0
      && (value === expected || (value === fallback && providerRecoveryRecorded(record, role, expected)));
    if (!recordedModel(record.owner_model, binding.owner_model, 'owner') || !recordedModel(record.editor_model, binding.editor_model, 'editor'))
      throw new Error('Wave recorded model is absent or replaced; stop this assignment.');
  }
}

// The only admissible evidence for a role's provider fallback is a recorded
// recovery event for this run, role and original model. The current event keeps
// the wrapper name provider_recovery and nests the recovery detail under
// `recovery`; historical lines spread the detail at the top level and overwrote
// `event`, so both shapes count.
function providerRecoveryRecorded(record, role, requestedModel) {
  let text;
  try { text = readFileSync(join(record.package, 'runtime/events.jsonl'), 'utf8'); } catch { return false; }
  const fallback = `${PROVIDER_RECOVERY.fallback.provider}/${PROVIDER_RECOVERY.fallback.model}`;
  return text.split('\n').some(line => {
    if (!line) return false;
    try {
      const value = JSON.parse(line);
      const detail = value?.recovery && typeof value.recovery === 'object' ? value.recovery : value;
      return detail.version === 1 && ['fallback_selected', 'fallback_restored'].includes(detail.event)
        && value.run_id === record.id && value.role === role
        && detail.requested_model === requestedModel && detail.effective_model === fallback;
    } catch { return false; }
  });
}

// The provider fallback is admissible only as the fixed recovery model backed by
// a recorded recovery entry for this run's exact role selector. Any other
// selected model must match the requested selector exactly; there is no
// arbitrary swap or cross-role substitution.
export function assertManagedModel(record, role, model, branchEntries = []) {
  const selector = record[`${role}_model`];
  const fallback = `${PROVIDER_RECOVERY.fallback.provider}/${PROVIDER_RECOVERY.fallback.model}`;
  if (model?.provider === PROVIDER_RECOVERY.fallback.provider && model?.id === PROVIDER_RECOVERY.fallback.model) {
    const requested = splitModelSelector(selector);
    const recorded = requested.provider === 'primalabs' && Array.isArray(branchEntries) && branchEntries.some(entry =>
      entry?.type === 'custom' && entry.customType === 'spec-provider-recovery'
      && entry.data?.version === 1 && entry.data?.requested_model === selector
      && ['fallback_selected', 'fallback_restored'].includes(entry.data?.event)
      && entry.data?.effective_model === fallback);
    if (recorded) return;
  }
  assertModelSelector(selector, model);
}

// A wave dispatch may run concurrently with its own durable siblings. Only a
// distinct member of the same wave generation, package, coordinator epoch and
// target qualifies; a serial, unknown or same-member assignment never does.
export function waveSiblingMatches(validated, sibling) {
  return Boolean(validated && sibling
    && sibling.wave_id === validated.wave_id && sibling.package_ref === validated.package_ref
    && sibling.generation === validated.generation
    && String(sibling.coordinator_epoch) === String(validated.coordinator_epoch)
    && sibling.target === validated.target
    && sibling.step_number !== validated.step_number);
}

// The conflict is waived only when the durable sibling record belongs to the
// same wave and still holds a valid current lease; a stale, unresolved or serial
// conflict is never waived.
export function waveSiblingConflict(packagePath, conflict, waveBinding) {
  const validated = waveBinding?.wave_bindings ?? waveBinding?.wave ?? null;
  if (!validated || !conflict?.runId) return false;
  let run;
  try { run = loadRun(packagePath, conflict.runId); } catch { return false; }
  if (!waveSiblingMatches(validated, run?.wave_bindings)) return false;
  try { assertLease(run); } catch { return false; }
  return true;
}
export function revoke(record) {
  atomic(revokedFile(record), { revoked_at: timestamp() });
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
const processDir = record => join(record.package, 'runtime/runs', `${record.id}-processes`);
export function trackGroup(record, pid, role) {
  if (!pid) return;
  atomic(join(processDir(record), `${pid}.json`), { pid, role, active: true, started_at: timestamp() });
}
export function activeGroups(record) {
  if (!existsSync(processDir(record))) return [];
  return readdirSync(processDir(record)).filter(name => name.endsWith('.json')).map(name => read(join(processDir(record), name))).filter(entry => entry.active);
}
export function settleGroup(record, pid) {
  if (!pid || groupAlive(pid)) return false;
  const file = join(processDir(record), `${pid}.json`);
  if (existsSync(file)) atomic(file, { ...read(file), active: false, finished_at: timestamp() });
  return true;
}
async function waitGroupsGone(record, pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const alive = pids.filter(pid => !settleGroup(record, pid));
    if (!alive.length) return true;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  } while (Date.now() < deadline);
  return false;
}
function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
// Only call for a group created and tracked by this live invocation, never an
// arbitrary PID recovered from disk. Failure leaves the run blocked and still active.
export async function terminateGroup(record, pid) {
  if (settleGroup(record, pid)) return true;
  signalGroup(pid, 'SIGTERM');
  if (await waitGroupsGone(record, [pid], 1000)) return true;
  signalGroup(pid, 'SIGKILL');
  return waitGroupsGone(record, [pid], 1000);
}
// Register every detached group before it can execute useful work. If its launcher
// dies before releasing stdin, the wrapper sees EOF and exits without running a worker.
export function spawnManaged(record, role, command, args, onRegistered = () => {}, env = {}) {
  const child = spawn('/bin/bash', ['-c', 'IFS= read -r gate && [ "$gate" = start ] && exec "$@"', 'spec-runtime', command, ...args], {
    cwd: record.checkout, detached: true,
    env: { ...process.env, ...artifactEnvironment(record.package), SPEC_RUNTIME_ROLE: role, SPEC_RUNTIME_RECORD: join(record.package, 'runtime/runs', `${record.id}.json`),
      PI_INTERCOM_SCOPE_ID: record.id, PI_INTERCOM_STABLE_ID: `spec-${role}-${record.id}`, ...env },
    stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  trackGroup(record, child.pid, role);
  try {
    onRegistered(child);
    assertLease(record);
    child.stdin.end('start\n');
  } catch (error) {
    child.launchError = error.message;
    child.stdin.end();
  }
  return child;
}
// The target a step changes: its spec-steps.json `repository`, or the package's only target.
function stepTarget(locations, packagePath, step) {
  const number = /^step-(\d+)-subspec\.md$/.exec(basename(step))?.[1];
  let declared;
  try { declared = read(join(packagePath, 'spec-steps.json')).steps.find(entry => entry.step === Number(number))?.repository; } catch { /* no step list */ }
  const ids = locations.targets.map(entry => entry.id).join(', ');
  if (declared === undefined && locations.targets.length === 1) return locations.targets[0];
  if (declared === undefined) throw refusalError({ code: 'step-repository-missing', message: `${basename(step)} names no repository and ${locations.package_ref} has ${locations.targets.length} targets (${ids}).`,
    remedy: 'Set `repository` on the step in spec-steps.json.' });
  const target = locations.targets.find(entry => entry.id === declared);
  if (!target) throw refusalError({ code: 'step-repository-unknown', message: `${basename(step)} names repository ${JSON.stringify(declared)}, which is not a target of ${locations.package_ref} (${ids}).`,
    remedy: 'Set `repository` on the step in spec-steps.json to one of the package targets.' });
  return target;
}

// ---------------------------------------------------------------------------
// Contained snapshot preparation for one wave member.
//
// The caller supplies only the membership identity already used by start():
// wave id, generation, step, attempt, phase, package claim token and
// coordinator epoch. Backend, capability, setup command, layers and target come
// from the durable wave record and the prepared step card, never from the
// caller. prepareWaveMember provisions a retained step-workspaces attempt and
// returns a preparation receipt; it neither accepts a step nor advances a phase.
// ---------------------------------------------------------------------------

// The same pre-worktree identity checks resolveWaveBinding performs, without
// requiring the member workspace the preparation is about to create.
function resolveWaveMemberRequest(input, { packagePath, packageRef, target }, ownershipRoot) {
  for (const field of WAVE_INPUT_FIELDS) {
    if (input[field] === undefined || input[field] === null || input[field] === '')
      throw waveInvalid('wave-input-incomplete', `Wave preparation requires ${field}.`, 'Pass the validated wave membership identity.');
  }
  if (typeof ownershipRoot !== 'string' || !ownershipRoot)
    throw waveInvalid('wave-ownership-unavailable', 'Wave preparation requires the ownership registry root.', 'Construct Runtime with an ownership registry or ownership root.');
  const record = readWaveRecord(packagePath, input.wave_id);
  const claimToken = waveClaimToken(record);
  if (input.claim_token !== claimToken) throw waveInvalid('wave-claim-mismatch', 'Supplied claim_token does not match the wave record.', 'Pass the canonical wave claim token.');
  const epoch = record.coordinator?.epoch;
  if (epoch === undefined || epoch === null || epoch === '' || String(input.coordinator_epoch) !== String(epoch))
    throw waveInvalid('wave-epoch-mismatch', 'Supplied coordinator_epoch does not match the wave record.', 'Pass the wave coordinator epoch.');
  if (record.package_ref !== packageRef)
    throw waveInvalid('wave-package-mismatch', 'Wave record package_ref does not match the located package.', 'Bind the wave to the located package.');
  if (!record.target || record.target.id !== target.id)
    throw waveInvalid('wave-target-mismatch', 'Wave record target does not match the step target.', 'Record the wave target for this step.');
  if (typeof record.target.base_commit !== 'string' || !record.target.base_commit)
    throw waveInvalid('wave-base-missing', 'Wave target records no base commit.', 'Record the wave target base commit.');
  if (typeof record.generation !== 'number' || !Number.isInteger(record.generation) || record.generation !== input.expected_generation)
    throw waveInvalid('wave-generation-mismatch', 'Supplied expected_generation does not match the wave record.', 'Pass the current wave generation.');
  const cardStep = Number(basename(input.step).match(/^step-(\d+)-subspec\.md$/)?.[1]);
  if (!Number.isInteger(cardStep) || input.step_number !== cardStep)
    throw waveInvalid('wave-step-mismatch', 'Supplied step_number does not match the step card.', 'Pass the card step number.');
  let selected;
  try {
    selected = selectWaveSubject(record, { step_number: input.step_number, candidate: input.candidate,
      attempt_id: input.attempt_id, phase: input.phase });
  } catch (error) {
    throw waveInvalid(error?.code || 'wave-member-mismatch', error?.message || 'Wave member attempt or phase does not match the supplied identity.', 'Pass the recorded member attempt and phase.');
  }
  const member = selected.subject;
  const candidate = selected.candidate;
  if (!candidate && (!member || typeof member !== 'object'))
    throw waveInvalid('wave-member-missing', `Wave record has no member for step ${input.step_number}.`, 'Record the member before preparing its workspace.');
  if (!candidate && (Number(member.step) !== input.step_number || member.attempt_id !== input.attempt_id || member.phase !== input.phase))
    throw waveInvalid('wave-member-mismatch', 'Wave member attempt or phase does not match the supplied identity.', 'Pass the recorded member attempt and phase.');
  // The phase's coordinator identity is the validated package-claim coordinator,
  // revalidated against the durable wave record session/epoch.
  const packageClaim = readOwnershipClaimsSync(ownershipRoot).find(claim => claim.kind === 'package'
    && claim.token === claimToken && String(claim.epoch) === String(epoch));
  if (!packageClaim)
    throw waveInvalid('wave-package-claim', 'No live package claim matches the wave token and epoch.', 'Recover or reacquire the package claim before preparing.');
  return { record, claimToken, epoch, member, candidate, coordinator: waveCoordinator(record, packageClaim) };
}

export async function resolveInput(input, location = {}, { ownership, ownershipRoot } = {}) {
  if (input.attempt_kind !== undefined && !['implementation', 'verification-continuation', 'implementation-repair', 'review-repair', 'launch-retry'].includes(input.attempt_kind))
    throw new Error('Unknown attempt_kind');
  if (input.session_scope !== undefined && !['package', 'step'].includes(input.session_scope))
    throw new Error('session_scope must be package or step');
  input = { ...input, owner_model: input.owner_override || input.owner_model,
    routing_reason: input.owner_override ? 'explicit step override' : input.routing_reason };
  const checked = await checkPackage(input.package, location);
  if (!checked.ok) throw refusalError(checked);
  const locations = checked.locations;
  const packagePath = realpathSync(locations.package_dir);
  for (const key of ['owner_model', 'editor_model']) splitModelSelector(input[key]);
  const step = realpathSync(input.step);
  if (!inside(packagePath, step)) throw new Error('step must be inside the package');
  const target = stepTarget(locations, packagePath, step);
  if (input.wave_id !== undefined && input.wave_id !== null) {
    const bound = await resolveWaveBinding(input, { packagePath, packageRef: locations.package_ref, target }, ownershipRoot);
    return { ...input, scout_model: input.scout_model || SCOUT_MODEL, package: packagePath, package_ref: locations.package_ref,
      target: bound.target, primary: bound.primary, step, checkout: bound.checkout, other_targets: [], wave_bindings: bound.wave,
      target_ids: locations.targets.map(entry => entry.id),
      wave_path: join(packagePath, 'runtime', 'waves', `${input.wave_id}.json`) };
  }
  const { primary, worktree: actual } = await prepareSpecWorktree(locations, target, { ...location, base: input.base || 'HEAD' });
  // Other targets' recorded worktrees are read-only context for the owner and editor.
  const others = locations.targets.filter(entry => entry.id !== target.id && entry.worktree).map(({ id, worktree }) => ({ id, worktree }));
  return { ...input, scout_model: input.scout_model || SCOUT_MODEL, package: packagePath, package_ref: locations.package_ref, target: target.id, primary, step, checkout: actual, other_targets: others, target_ids: locations.targets.map(entry => entry.id) };
}

// Prompt lines naming the step's target and, read-only, the package's other worktrees.
const targetFacts = record => record.target ? `TARGET: ${record.target}\n${record.other_targets?.length ? `OTHER TARGETS (read-only context, never edit): ${record.other_targets.map(entry => `${entry.id}=${entry.worktree}`).join('; ')}\n` : ''}` : '';

// Owners retain step state. Each editor packet has its own native session; its
// questions continue in that same process, never in a competing writer.
// Discovery stays disabled: no goal continuation, subagent fanout, or unrelated extension tools.
function nativeCommand(record, role, prompt, options = {}) {
  const contract = ROLE_CONTRACT[role];
  if (!contract) throw refusalError({ code: 'role-unknown', message: `Native role ${JSON.stringify(role)} is not in the role contract.`,
    remedy: `Use one of ${Object.keys(ROLE_CONTRACT).join(', ')}.` });
  const model = record[contract.modelKey];
  if (model === undefined || model === null || model === '') throw refusalError({ code: 'role-model-missing', message: `Role ${role} has no ${contract.modelKey} selector.`,
    remedy: 'Resolve the stage model before launching.' });
  const session = record[contract.sessionKey];
  const stream = join(record.package, 'runtime/runs', `${record.id}-${role}-${randomUUID()}.jsonl`);
  const errors = `${stream}.stderr`;
  const profile = resolve(here, '../../agents', contract.profile);
  const selector = splitModelSelector(model);
  const args = [ ...(options.prefix || []), '--print', '--mode', 'json', '--session', session,
    '--provider', selector.provider, '--model', selector.model,
    ...(selector.thinking ? ['--thinking', selector.thinking] : []), '--no-extensions', '--no-skills', '--no-prompt-templates',
    ...((record.child_extensions || []).flatMap(path => ['--extension', path])),
    ...(contract.subagents ? ['--extension', join(homedir(), '.pi/agent/npm/node_modules/pi-subagents/index.js')] : []),
    '--extension', join(here, 'index.ts'), '--tools', options.tools || contract.tools.concat(contract.providerTools).join(','),
    '--append-system-prompt', profile, '--', prompt ];
  return { command: options.command || 'pi', args, stream, errors };
}

function streamTask(record, role, child, options, paths) {
  const { stream, errors } = paths;
  const activity = activityRecorder(record, role);
  let reportLifecycleFailure;
  const lifecycleFailure = new Promise(resolveFailure => { reportLifecycleFailure = resolveFailure; });
  let pending = '', finalText = '', lastStop, failure, stderr = '', shutdownTimer, shutdownCleanup = false, shutdownAttempt;
  const clearShutdown = () => { clearTimeout(shutdownTimer); shutdownTimer = undefined; };
  child.stdout.on('data', chunk => {
    appendFileSync(stream, chunk, { mode: 0o600 });
    pending += chunk.toString();
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        activity.event(value);
        if (['agent_start', 'turn_start', 'tool_execution_start', 'message_start'].includes(value.type)) clearShutdown();
        if (value.type === 'agent_start') { finalText = ''; lastStop = undefined; failure = undefined; }
        // Fatal lifecycle handling is independent of observation: the cleanup
        // receipt is reported before any observer seam runs, so a hostile or
        // blocking observer can never delay mandatory cancellation.
        if (value.type === 'tool_execution_end' && value.result?.details?.requires_cancellation)
          reportLifecycleFailure(value.result.details.error);
        // A narrow observation seam: a bad observer degrades observation only.
        try { options.onEvent?.(record, value); } catch { /* Observer failure must never affect the run. */ }
        if (value.type === 'message_end' && value.message?.role === 'assistant') {
          lastStop = value.message.stopReason;
          finalText = (value.message.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
          // A later successful final response can recover a transient provider error.
          // Keep every event in the stream, but classify the final attempt's outcome.
          failure = lastStop === 'length'
            ? 'Model response reached its length limit; packet is incomplete. Preserve changes, inspect the partial result, and assign a bounded continuation. Do not treat partial text as completion or retry unchanged.'
            : lastStop === 'error' || lastStop === 'aborted' ? value.message.errorMessage || lastStop : undefined;
        }
        // Some extension resources survive native print-mode settlement. Give
        // normal disposal time to finish, then stop only this invocation's live
        // process group. A settled event alone never releases ownership.
        if (value.type === 'agent_settled' && value.aborted === false && finalText.trim() && lastStop === 'stop' && !failure) {
          clearShutdown();
          shutdownTimer = setTimeout(async () => {
            try {
              if (child.exitCode !== null || child.signalCode !== null) return;
              // Sibling editors of a parallel batch are expected; they have no shell to leave descendants.
              if (activeGroups(record).some(group => group.pid !== child.pid && !(role === 'editor' && (group.role === 'owner' || (options.parallel && group.role === 'editor'))))) {
                reportLifecycleFailure('Settled worker has active managed descendants; cancel the run before replacing it.');
                return;
              }
              event(record, 'worker_shutdown_cleanup', { role, pid: child.pid, reason: 'settled print process did not exit' });
              // Confirmed cleanup is the only authority to classify the eventual
              // exit as cleanup; a failed or unconfirmed stop leaves it a real crash.
              shutdownAttempt = Promise.resolve().then(() => (options.stopSettledGroup || terminateGroup)(record, child.pid));
              if (!await shutdownAttempt)
                reportLifecycleFailure('Settled worker termination unconfirmed; retain process ownership.');
              else shutdownCleanup = true;
            } catch (error) { reportLifecycleFailure(`Settled worker cleanup failed: ${error.message}`); }
          }, options.shutdownGraceMs ?? 15000);
        }
      } catch { /* preserve non-JSON diagnostics on disk */ }
    }
  });
  child.stderr.on('data', chunk => { appendFileSync(errors, chunk, { mode: 0o600 }); stderr = (stderr + chunk.toString()).slice(-8000); });
  const done = new Promise(resolveDone => {
    child.on('error', error => { failure = error.message; });
    const settle = async (code, signal) => {
      clearShutdown();
      // Wait for any in-flight confirmed-cleanup decision before classifying the
      // exit; a real crash must never be masked by a later cleanup confirmation.
      if (shutdownAttempt) { try { await shutdownAttempt; } catch { /* classified below */ } }
      const cleanupExit = shutdownCleanup && (['SIGTERM', 'SIGKILL'].includes(signal) || code === 143 || code === 137);
      const error = child.launchError || failure || (code !== 0 && !cleanupExit ? `Pi exited ${code ?? signal}` : !finalText || lastStop === 'toolUse' ? 'Pi exited without a final assistant result' : undefined);
      activity.finish(error);
      const fullResultPath = `${stream}.result.txt`;
      try {
        writeFileSync(fullResultPath, finalText, { mode: 0o600 });
        const truncated = finalText.length > 8000;
        const notice = `\n[Result truncated. Read the needed portion of ${fullResultPath}; do not repeat the assignment.]`;
        resolveDone({ code, signal, result: truncated ? finalText.slice(0, Math.max(0, 8000 - notice.length)) + notice : finalText,
          result_truncated: truncated, stop_reason: lastStop, shutdown_cleanup: shutdownCleanup, full_result_path: fullResultPath, stream, errors, error, configuration_failure: configurationFailure(error) || (error ? configurationFailure(stderr) : undefined) });
      } catch (cause) {
        resolveDone({ code, signal, stream, errors, error: `Cannot preserve full result: ${cause.message}${error ? `; ${error}` : ''}` });
      }
    };
    child.on('close', settle);
    // A transport that already exited before this handler attached never emits
    // close again; settle it once so done always resolves.
    if (child.exitCode !== null || child.signalCode !== null) queueMicrotask(() => settle(child.exitCode, child.signalCode));
  });
  return { child, done, lifecycleFailure };
}

export function launch(record, role, prompt, options = {}) {
  const { command, args, stream, errors } = nativeCommand(record, role, prompt, options);
  const child = spawnManaged(record, role, command, args, undefined, options.env);
  return streamTask(record, role, child, options, { stream, errors });
}

const waveLifecycle = createWaveLifecycle({
  read, timestamp, atomic, inside, refusalError, stepTarget,
  waveInvalid, realOrNull, workspaceIdentity, readWaveRecord, waveClaimToken,
  readOwnershipClaimsSync, resolveWaveMemberRequest, assertWaveLease,
  runFileOf, waveFileOf, runLockedMutation, save, nativeCommand, streamTask
});

export class Runtime {
  constructor({ launchProcess = launch, isAlive = groupAlive, kill = (pid, signal) => process.kill(-pid, signal), notify = () => {}, indexDir = join(homedir(), '.pi/agent/spec-runtime'), ownership, ownershipRoot, serviceAdapter, onWorkerEvent = () => {}, location = {} } = {}) {
    // `location` carries spec-location options (root, env, home, hostname); tests inject them.
    this.location = location;
    this.launchProcess = launchProcess; this.isAlive = isAlive; this.kill = kill; this.notify = notify; this.indexDir = indexDir; this.active = new Map(); this.cancellations = new Map();
    // The ownership registry confirms wave package/checkout claims; it defaults
    // under the runtime index ownership root and is injectable for fixtures.
    this.ownershipRoot = ownershipRoot || join(indexDir, 'ownership');
    this.ownership = ownership || createOwnership({ registryRoot: this.ownershipRoot });
    this.onWorkerEvent = onWorkerEvent;
    // Wave roots always launch through the containment adapter; the production
    // adapter is the default and a test may inject a seam. Serial runs keep
    // launchProcess unchanged.
    this.serviceAdapter = serviceAdapter || createSystemdServiceAdapter();
    // Stage launch and contained command primitives run with the Runtime
    // receiver, sharing this instance's adapters, persistence and claims.
    this.waveReviewRuntime = createWaveReviewRuntime({
      nativeCommand, streamTask, save, read, runFileOf, assertWaveLease,
      loadRun, runCommand, readOwnershipClaimsSync, waveInvalid, timestamp,
      runLockedMutation, waveClaimToken
    });
  }

  async containedRoot(record, prompt) {
    // A stage record selects the role-aware contained launch; serial and
    // implementation wave runs keep the immutable waveLifecycle route.
    if (record.stage) return this.waveReviewRuntime.containedStage.call(this, record, prompt);
    return waveLifecycle.containedRoot.call(this, record, prompt);
  }

  async ensureWaveDeadline(record) {
    return waveLifecycle.ensureWaveDeadline.call(this, record);
  }

  async drainContainedService(record, options = {}) {
    return waveLifecycle.drainContainedService.call(this, record, options);
  }

  async prepareWaveMember(input) {
    return waveLifecycle.prepareWaveMember.call(this, input);
  }

  async remountWaveMember(input) {
    return waveLifecycle.remountWaveMember.call(this, input);
  }

  // Stage launch and command-phase primitives are thin delegates so the Runtime
  // keeps one persistence and process surface while their bodies live in the
  // review-runtime module.
  async startStage(input) {
    return this.waveReviewRuntime.startStage.call(this, input);
  }

  async commandPhase(input) {
    return this.waveReviewRuntime.commandPhase.call(this, input);
  }

  async runPhaseCommand(record, command, timeoutSeconds, signal) {
    return this.waveReviewRuntime.runPhaseCommand.call(this, record, command, timeoutSeconds, signal);
  }

  async endCommandPhase(record, options = {}) {
    return this.waveReviewRuntime.endCommandPhase.call(this, record, options);
  }

  // Side-effect-free validation of an explicit wave member assignment before any
  // dispatch bookkeeping. It resolves the wave binding only; serial inputs are
  // left to the normal start path.
  async validateWaveAssignment(input) {
    if (!input || input.wave_id === undefined || input.wave_id === null) return null;
    return resolveInput(input, this.location, { ownership: this.ownership, ownershipRoot: this.ownershipRoot });
  }
  async startup(input, parentSession) {
    const requestedAt = timestamp();
    const checked = await checkPackage(input.package, this.location);
    if (!checked.ok) throw refusalError(checked);
    const packagePath = realpathSync(checked.locations.package_dir);
    const entry = await preparedEntry(packagePath, input, checked.locations);
    if (entry.state) return entry.run_id ? { ...summary(loadRun(packagePath, entry.run_id)), ...entry } : entry;
    return this.start({ ...input, ...entry, dispatch_requested_at: requestedAt }, parentSession);
  }
  async start(input, parentSession) {
    const requestedAt = input.dispatch_requested_at || timestamp();
    // Overlap admission compares this request against a prior run's own clock.
    // A caller may supply a historical dispatch_requested_at, so the overlap
    // window is measured from the moment this process actually entered start(),
    // never from the (possibly backdated) caller timestamp recorded on the run.
    const enteredAt = timestamp();
    if (process.platform === 'win32') throw new Error('spec-runtime requires POSIX process groups');
    // Internal, validated run provenance is never accepted from a caller spread.
    for (const field of ['wave_bindings', 'wave_path']) {
      if (input[field] !== undefined) throw new Error(`internal run field ${field} is not accepted from callers`);
    }
    // A supplied workflow_id is carried, never inferred; reject a malformed one
    // before any package or run side effect.
    if (input.workflow_id !== undefined
      && (typeof input.workflow_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.workflow_id)))
      throw new Error('workflow_id must be 1-128 ASCII letters/digits/underscore/hyphen');
    // Everything after this await is synchronous, so the check-then-write below cannot interleave in this process.
    const config = await resolveInput(input, this.location, { ownership: this.ownership, ownershipRoot: this.ownershipRoot });
    if (config.wave_bindings) {
      config.wave_bindings.owner_model = config.owner_model;
      config.wave_bindings.editor_model = config.editor_model;
      config.wave_bindings.ownership_root = this.ownershipRoot;
    }
    const key = input.assignment_id || config.step;
    const runtimeDir = join(config.package, 'runtime');
    mkdirSync(join(runtimeDir, 'runs'), { recursive: true });
    const assignmentFile = join(runtimeDir, 'assignments', `${createHash('sha256').update(key).digest('hex')}.json`);
    const previousAssignment = existsSync(assignmentFile) ? read(assignmentFile) : null;
    const retained = previousAssignment ? loadRun(config.package, previousAssignment.run_id)
      : observedRuns(config.package).filter(run => run.step === config.step)
        .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))[0];
    const scope = config.session_scope ?? (retained ? retained.session_scope ?? 'package' : 'step');
    const legacyParts = [config.step, config.target, config.checkout, config.owner_model, config.editor_model, config.scout_model, config.child_extensions || [], config.instructions || ''];
    const contractParts = [...legacyParts, { attempt_kind: config.attempt_kind ?? null, session_scope: scope }];
    // A supplied workflow_id joins the launch contract so an existing assignment
    // cannot be reused under another workflow; the legacy/no-workflow shape is
    // preserved exactly.
    const contractBase = config.workflow_id == null ? contractParts : [...contractParts, config.workflow_id];
    // A stage joins the launch contract so a stale review/fix label or model can
    // never reuse another stage's assignment; the no-stage shape is unchanged.
    const stageContract = config.stage ? [{ stage: config.stage, review_model: config.review_model ?? null, fix_model: config.fix_model ?? null }] : [];
    const contract = JSON.stringify(config.wave_bindings ? [...contractBase, { wave: config.wave_bindings }, ...stageContract] : [...contractBase, ...stageContract]);
    if (existsSync(assignmentFile)) {
      const previous = previousAssignment;
      const legacy = [...legacyParts];
      if (config.attempt_kind !== undefined) legacy.push({ attempt_kind: config.attempt_kind ?? null, session_scope: 'package' });
      const legacyContract = JSON.stringify(config.workflow_id == null ? legacy : [...legacy, config.workflow_id]);
      const compatibleLegacy = config.session_scope !== 'step' && previous.contract === legacyContract
        && (loadRun(config.package, previous.run_id).session_scope ?? 'package') === 'package';
      if (previous.contract !== contract && !compatibleLegacy) throw new Error('assignment_id already identifies a different launch contract; use a new explicit attempt ID for an intentional change.');
      return summary(loadRun(config.package, previous.run_id));
    }
    // A serial run cannot start while a nonterminal wave record is persisted: the
    // wave owns the package and a serial launch would fork the work. Wave runs
    // carry wave_bindings and are admitted by their own validation.
    if (!config.wave_bindings) {
      const waves = activeWaveRecords(config.package);
      if (waves.length) throw refusalError({ code: 'wave-active', message: `Package ${config.package_ref} has an active wave claim(s) represented by record(s) ${waves.map(record => record.wave_id).join(', ')}; a serial run cannot start while a wave is running.`,
        remedy: 'Resume through spec_dispatch startup with execution auto or waves; serial cannot bypass an active wave.' });
    }
    // No lock folders: a live coordinator pid in run.json is the writer claim. A dead
    // coordinator's run is marked stale. Two processes starting in the same instant can both pass.
    // A serial run refuses any live package wave claim even when run.json looks
    // terminal; a wave run bypasses only the serial latest-run exclusion.
    if (!config.wave_bindings) {
      const { claims } = await this.ownership.inspectClaims({ packageId: config.package_ref });
      if (claims.some(claim => claim.kind === 'package'))
        throw refusalError({ code: 'wave-active', message: `Package ${config.package_ref} holds an active wave claim; a serial run cannot replace it.`,
          remedy: 'Finish or recover the wave before starting a serial run.' });
    }
    // Request-time admission: validation is async, so a prior run can reach a
    // terminal state while this request is being resolved. A terminal prior whose
    // lifetime overlaps this request's entry still occupied the package during
    // admission and must refuse a different assignment. Overlap is decided between
    // two local intervals: the prior's [priorStarted, priorFinished] and this
    // request's [enteredAt, inspectedAt]. inspectedAt is captured once, at the
    // moment the prior record is inspected, and this request is treated as still
    // running through it. Interval comparison table:
    //   prior started    | prior finished    | outcome
    //   before-entry     | before-entry      | admit
    //   before-entry     | during-admission  | refuse
    //   before-entry     | still-active      | refuse
    //   during-admission | during-admission  | refuse
    //   during-admission | still-active      | refuse
    // Equality counts as overlap: a prior with priorFinished == enteredAt has a
    // lifetime that reaches this request's entry, so it is treated as an overlap.
    // Missing, null or unparseable prior timestamps are unknown, and an unknown
    // terminal lifetime fails closed (refuse), since it cannot be shown to be
    // disjoint from this request's interval.
    const inspectedAt = timestamp();
    const latest = join(runtimeDir, 'run.json');
    if (!config.wave_bindings && existsSync(latest)) {
      const prior = read(latest);
      const active = ['running', 'cancelling', 'blocked'].includes(prior.state);
      const priorStarted = Number.isFinite(Date.parse(prior.started_at)) ? Date.parse(prior.started_at) : null;
      const priorFinished = Number.isFinite(Date.parse(prior.finished_at)) ? Date.parse(prior.finished_at) : null;
      // Fail-closed for terminal/non-active records: an unknown start or finish, or
      // a prior lifetime that reaches this request's entry, refuses the assignment.
      const unknownLifetime = priorStarted === null || priorFinished === null;
      const overlappedThisRequest = priorStarted !== null && priorFinished !== null
        && priorStarted <= Date.parse(inspectedAt) && priorFinished >= Date.parse(enteredAt);
      if (active) {
        const pid = prior.coordinator_pid ?? prior.pid;
        if (serialRunActive(config.package)) throw refusalError({ code: 'run-active', message: `Run ${prior.id} is ${prior.state} and its coordinator (pid ${pid}) is alive.`,
          remedy: 'Await its completion or confirmed cancellation; start a new run only after it ends.' });
        // A dead coordinator is recoverable only when the active record carries a
        // truthful known lifetime. An active-shaped record with an unknown start or
        // finish cannot be safely cleared or admitted, so it stays fail-closed.
        if (unknownLifetime) throw refusalError({ code: 'run-active', message: `Run ${prior.id} is ${prior.state} and its coordinator (pid ${pid}) is dead, but its lifetime is unknown.`,
          remedy: 'Inspect the run record and clear it explicitly before starting a new run.' });
        // Only an active run with a dead coordinator and a known lifetime is marked
        // stale; a run that completed during admission keeps its truthful terminal state.
        prior.state = 'stale'; prior.finished_at = timestamp();
        save(prior); event(prior, 'run_stale', { coordinator_pid: pid });
      }
      else if (unknownLifetime || overlappedThisRequest) {
        throw refusalError({ code: 'run-active', message: `Run ${prior.id} has an overlapping or unknown lifetime relative to this request's entry.`,
          remedy: 'Await its completion or confirmed cancellation; start a new run only after it ends.' });
      }
    }
    const id = randomUUID();
    const sessionKey = [config.target, config.checkout, config.owner_model, config.editor_model, config.child_extensions || []];
    if (scope === 'step') sessionKey.push(config.step);
    const pair = createHash('sha256').update(JSON.stringify(sessionKey)).digest('hex').slice(0, 16);
    const sessionDir = join(runtimeDir, 'sessions', pair);
    mkdirSync(sessionDir, { recursive: true });
    if (config.stage) mkdirSync(join(sessionDir, 'stages'), { recursive: true });
    const record = { schema_version: 1, completion_contract: 1, id, assignment_id: key, workflow_id: config.workflow_id ?? null, wave_bindings: config.wave_bindings ?? null, wave_path: config.wave_path ?? null, package: config.package, package_ref: config.package_ref, target: config.target, primary: config.primary, other_targets: config.other_targets,
      step: config.step, checkout: config.checkout, owner_model: config.owner_model, editor_model: config.editor_model, scout_model: config.scout_model,
      dispatch_requested_at: requestedAt, routing_reason: config.routing_reason,
      attempt_kind: config.attempt_kind ?? null, session_scope: scope,
      environment: environmentFacts(config.checkout, config.primary),
      child_extensions: config.child_extensions || [], owner_session: join(sessionDir, 'owner.jsonl'), editor_session: join(sessionDir, 'editor.jsonl'),
      stage: config.stage ?? null, review_model: config.review_model ?? null, fix_model: config.fix_model ?? null,
      ...(config.stage ? { [`${config.stage.role}_session`]: join(sessionDir, 'stages', `${id}-${config.stage.role}.jsonl`) } : {}),
      parent_session: parentSession, coordinator_pid: process.pid, state: 'running', started_at: timestamp(), timeout_ms: input.timeout_ms || 7200000 };
    save(record);
    atomic(assignmentFile, { assignment_id: key, run_id: record.id, contract });
    mkdirSync(this.indexDir, { recursive: true });
    atomic(join(this.indexDir, `${id}.json`), { run_id: id, package: config.package, package_ref: config.package_ref, manifest: join(runtimeDir, 'runs', `${id}.json`), parent_session: parentSession });
    let task;
    try {
      // Bind the member run id under flock before the launch gate can release; a
      // failed bind or launch keeps the run blocked with its truthful error and
      // every ownership claim, never an unbound orphan.
      if (config.wave_bindings) await bindWaveMemberRun(config, record.id);
      const prompt = config.stage ? stagePrompt(record) : `Implement this prepared step as its architect/owner using spec_editor.\nPACKAGE: ${record.package}\nSTEP: ${record.step}\nCHECKOUT: ${record.checkout}\nPRIMARY: ${record.primary}\n${targetFacts(record)}${dependencyContext(record, config.target_ids)}Read the card and required policy. Choose the implementation approach yourself, then send a short Change/Edits/Preserve/Return packet for a bounded transformation. Name affected symbols, the chosen approach and preservation constraints; let the editor choose local implementation details and batch related edits. The editor does not run tests, compile/lint checks or other executable verification. After it returns, use spec_verify for necessary focused checks and diagnose failures before assigning bounded corrections. Do not check every packet automatically; reuse valid evidence. Read/search missing source facts directly. The editor normally reads and edits in one assignment; reserve facts-only requests for a specific blocking fact unavailable through your tools. Request compact results with artifact paths, not source inventories. Do not delegate architecture, whole-step restoration, or an entire acceptance suite with open-ended repairs. Keep owner context bounded. Every editor call starts a fresh session: include the chosen decisions, relevant files and preservation constraints in each packet; never refer to prior chat. Assess each returned diff/result before the next packet; commit is a separate assignment after acceptance of the completed changes and required evidence. Use spec_scout only for a bounded discovery gap worth delegating; direct reads remain the default. Do not discover models, run startup suites, poll, or start other agents outside that scout tool. The runtime retains the owner session and records each fresh editor session. Before ending, call spec_complete with decisions, introduced symbols, gaps and step-owned evidence assessments. It writes the canonical learning from verification receipts; an evidence log is not a learning. Commit via the editor first when complete. Missing handoffs remain unfinished obligations. This owner assignment ends after this step; independent review belongs to the coordinator.\n${input.instructions || ''}`;
      task = config.wave_bindings
        ? await this.containedRoot(record, prompt)
        : this.launchProcess(record, 'owner', `${prompt}\nEnvironment paths (observations, not setup approval): ${JSON.stringify(record.environment)}`, { onEvent: this.onWorkerEvent });
    }
    catch (error) {
      record.state = config.wave_bindings ? 'blocked' : 'failed';
      record.finished_at = timestamp(); record.error = error.message; save(record); throw error;
    }
    // A wave service's identity is its recorded MainPID only; the systemd-run
    // launcher pid is never signalled, liveness-tested or recorded as the run pid.
    record.pid = config.wave_bindings ? (task.workerPid ?? null) : (task.workerPid ?? task.child.pid);
    // Positively identify a wave-bound service process so a later drain
    // classification can validate liveness without inferring it from a
    // possibly-exited pid. A safe pid observed alive records its opaque start
    // text; an absent pid or non-alive observation leaves no identity.
    if (config.wave_bindings && Number.isSafeInteger(record.pid) && record.pid > 0) {
      const observed = inspectProcess(record.pid);
      if (observed.state === 'alive') record.worker_identity = { pid: observed.pid, started_at: observed.started_at };
    }
    save(record); refreshProgress(record.package).catch(error => { record.progress_error = error.message; }); event(record, 'run_started', { dispatch_requested_at: requestedAt, owner_session: record.owner_session, editor_session: record.editor_session, parent_session: parentSession, pid: record.pid });
    // A wave run shares one original deadline: the timer fires at the retained
    // expiry, never a renewed full timeout measured from the launch moment.
    // The shared wave deadline persists a validated safe-integer millisecond
    // expiry (createWaveDeadline), never an ISO string; remaining time is
    // numeric arithmetic that revalidates the record before scheduling.
    const remainingMs = config.wave_bindings && record.deadline
      ? Math.max(0, deadlineRemainingMs(record.deadline))
      : record.timeout_ms;
    const timer = setTimeout(() => { event(record, 'deadline_reached'); this.cancel(record.package, id).then(value => this.notify(value)).catch(error => this.notify({ ...summary(record), error: error.message })); }, remainingMs);
    timer.unref();
    this.active.set(id, { record, task, timer });
    task.lifecycleFailure?.then(error => {
      if (terminal.has(record.state) || record.state === 'cancelling') return;
      this.notify({ ...summary(record), error, next: 'runtime is cancelling its managed processes; do not launch another writer' });
      this.cancel(record.package, id).then(value => this.notify(value)).catch(cause => this.notify({ ...summary(record), error: cause.message }));
    });
    task.done.then(result => this.finish(record, result)).catch(error => {
      record.state = 'blocked'; record.error = error.message; save(record); this.notify(summary(record));
    });
    return summary(record);
  }
  async finish(record, result) {
    if (record.state === 'cancelling' || terminal.has(record.state)) return;
    // A contained wave root releases only on a positively confirmed service
    // drain. An unknown or still-populated service blocks the run and retains
    // its capacity and checkout claims for a later recovery.
    if (record.wave_bindings) {
      let drained;
      try { drained = await this.drainContainedService(record, { cancel: false }); }
      catch (error) { drained = { status: 'unknown', reason: error.message }; }
      if (drained?.status !== 'confirmed') {
        record.state = 'blocked';
        record.error = `Contained service drain unconfirmed (${drained?.reason || drained?.status || 'unknown'}); the run stays blocked and its claims are retained.`;
        record.finished_at = timestamp();
        save(record); event(record, 'run_finished', { state: record.state, error: record.error });
        try { await refreshProgress(record.package); } catch (error) { record.progress_error = error.message; save(record); }
        this.notify({ ...summary(record), progress_error: record.progress_error });
        return;
      }
    }
    for (const group of activeGroups(record)) settleGroup(record, group.pid);
    // A wave run's recorded pid is a contained service identity, never a
    // launcher pid to liveness-test after drain.
    if (activeGroups(record).length || (!record.wave_bindings && record.pid && this.isAlive(record.pid))) {
      record.state = 'blocked'; record.error = 'A managed process group is still alive; the run stays active.';
    } else {
      record.state = result.error ? 'failed' : 'completed'; record.error = result.error; record.result = result.result; record.stop_reason = result.stop_reason;
      // A wave checkout is an overlay tree: its completion receipt is checked
      // against the retained identity, not by running git outside the overlay.
      record.handoff = completionStatus(record, { checkHead: true });
      record.result_truncated = result.result_truncated; record.full_result_path = result.full_result_path; record.finished_at = timestamp();
      record.shutdown_cleanup = result.shutdown_cleanup === true;
    }
    save(record); event(record, 'run_finished', { state: record.state, error: record.error });
    if (record.state !== 'blocked') { clearTimeout(this.active.get(record.id)?.timer); this.active.delete(record.id); }
    try { await refreshProgress(record.package); } catch (error) { record.progress_error = error.message; save(record); }
    this.notify({ ...summary(record), progress_error: record.progress_error });
  }
  cancel(packagePath, id, timeoutMs = 5000) {
    const record = loadRun(packagePath, id);
    if (this.cancellations.has(record.id)) return this.cancellations.get(record.id);
    const pending = this.cancelRun(packagePath, record.id, timeoutMs).finally(() => this.cancellations.delete(record.id));
    this.cancellations.set(record.id, pending);
    return pending;
  }
  async cancelRun(packagePath, id, timeoutMs) {
    const disk = loadRun(packagePath, id);
    const active = this.active.get(disk.id);
    const record = active?.record || disk;
    if (terminal.has(record.state)) return summary(record);
    // A PID read from a previous coordinator cannot safely identify an OS process after PID reuse.
    if (!active) throw new Error('This runtime does not own the live process handle. The run stays active; recover the original coordinator or confirm termination manually.');
    revoke(record); record.state = 'cancelling'; save(record); event(record, 'cancel_requested');
    try {
      if (record.wave_bindings) {
        // A wave run cancels exclusively through its contained service: stop
        // then drain under the ownership-verified request. No POSIX kill branch
        // and the launcher pid is never signalled or liveness-tested.
        const stopped = await this.drainContainedService(record, { cancel: true });
        if (stopped?.status !== 'confirmed')
          throw new Error(`Contained service cancellation was not confirmed (${stopped?.reason || stopped?.status || 'unknown'})`);
      } else {
        let groups = activeGroups(record).map(group => group.pid);
        for (const pid of groups.reverse()) { try { this.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
        if (!(await waitGroupsGone(record, groups, timeoutMs))) {
          groups = activeGroups(record).map(group => group.pid);
          for (const pid of groups.reverse()) { try { this.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
          if (!(await waitGroupsGone(record, groups, timeoutMs))) throw new Error('Process group still alive after cancellation');
        }
        // A child launcher may have registered a gated group during the first snapshot.
        // Revocation prevents that gate opening; still join every newly registered group.
        groups = activeGroups(record).map(group => group.pid);
        for (const pid of groups) { try { this.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
        if (!(await waitGroupsGone(record, groups, timeoutMs))) throw new Error('A newly registered process group has not stopped');
      }
      record.state = 'cancelled'; record.finished_at = timestamp(); save(record); event(record, 'run_finished', { state: 'cancelled' });
      clearTimeout(active.timer); this.active.delete(record.id);
      try { await refreshProgress(record.package); } catch (error) { record.progress_error = error.message; }
      return summary(record);
    } catch (error) {
      record.state = 'blocked'; record.error = `Cancellation unconfirmed: ${error.message}`; save(record); event(record, 'cancellation_failed', { error: record.error });
      throw new Error(record.error);
    }
  }
}

const THINKING = /^(off|minimal|low|medium|high|xhigh|max)$/;
const EXCERPT_LINES = 600;
const PARALLEL_EDITORS = 4;
const EXCERPT_CHARS = 120000;

// Attach the owner's chosen source ranges so a fresh editor edits immediately
// instead of rediscovering them; only checkout and package files are readable.
export function contextExcerpts(record, context = []) {
  if (!Array.isArray(context) || !context.length) return '';
  const roots = [record.checkout, record.package].filter(Boolean).map(root => resolve(root));
  let total = 0;
  const blocks = context.map(({ path, start = 1, end }) => {
    const full = resolve(isAbsolute(path) ? path : join(record.checkout, path));
    if (!roots.some(root => full === root || full.startsWith(`${root}/`))) throw new Error(`context path ${path} is outside the checkout and package`);
    const lines = readFileSync(full, 'utf8').split('\n');
    const first = Math.max(1, Math.floor(start));
    const last = Math.min(lines.length, Math.floor(end ?? lines.length), first + EXCERPT_LINES - 1);
    const body = lines.slice(first - 1, last).join('\n');
    total += body.length;
    if (total > EXCERPT_CHARS) throw new Error(`context excerpts exceed ${EXCERPT_CHARS} characters; send narrower ranges`);
    return `--- ${relative(record.checkout, full) || path}:${first}-${last}\n${body}`;
  });
  return `CONTEXT EXCERPTS (exact current bytes chosen by the owner; edit against them and read further only when an edit anchor does not match):\n${blocks.join('\n')}\n--- end of excerpts\n`;
}

export async function runEditor(record, assignment, signal, launchProcess = launch, { stopGroup = terminateGroup, context = [], reasoning, paths, member, workspace } = {}) {
  assertLease(record);
  if (reasoning !== undefined && !THINKING.test(reasoning)) throw new Error(`reasoning must be one of off, minimal, low, medium, high, xhigh, max`);
  const excerpts = contextExcerpts(record, context);
  const editorModel = reasoning ? (({ provider, model }) => `${provider}/${model}:${reasoning}`)(splitModelSelector(record.editor_model)) : record.editor_model;
  const configFile = join(record.package, 'runtime/runs', `${record.id}-editor-configuration.json`);
  if (existsSync(configFile)) {
    const failure = read(configFile);
    if (failure.selector === record.editor_model) return { error: configurationAction(failure.selector, failure.cause), configuration_failure: failure, coordinator_action_required: true };
  }
  // A batch member runs under the batch's writer slot; runEditorBatch checks survivors.
  const editorLock = editorSlot(record);
  if (!member) try { mkdirSync(editorLock); } catch { throw new Error('An editor assignment is already active; await its result.'); }
  let task;
  try {
    invalidateCompletion(record);
    const session = join(dirname(record.editor_session), 'editors', `${randomUUID()}.jsonl`);
    mkdirSync(dirname(session), { recursive: true });
    // A separate receipt avoids stale owner/coordinator manifest writes losing
    // invocation history. Keep the legacy editor_session as a directory anchor.
    const sessionsFile = join(record.package, 'runtime/runs', `${record.id}-editor-sessions.json`);
    const sessions = existsSync(sessionsFile) ? read(sessionsFile) : [];
    sessions.push(session);
    atomic(sessionsFile, sessions);
    const orientation = excerpts
      ? 'The owner attached the exact source you need below; start editing from it. Ask the owner for a missing decision.'
      : 'Read the relevant card contracts and current named source; ask the owner for a missing decision.';
    // D12: a failed or length-stopped packet leaves partial changes behind. Carry
    // the previous stop reason and the current dirty state, never the packet or
    // its transcript; the owner's new assignment names the remaining obligation.
    const outcomeFile = join(record.package, 'runtime/runs', `${record.id}-editor-outcome.json`);
    const previous = existsSync(outcomeFile) ? read(outcomeFile) : null;
    let continuation = '';
    if (previous?.state === 'incomplete') {
      let dirty_paths = null, dirty_count = null;
      try {
        const status = git(record.checkout, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
        const records = status.split('\0');
        const entries = [];
        for (let index = 0; index < records.length; index++) {
          const entry = records[index];
          if (!entry) continue;
          // The shared git helper trims its output, which can drop the leading
          // status space of the first record. Read the two status characters
          // and the following space positionally so trimming never shifts the
          // path, and skip the source entry that follows an R or C record.
          const match = /^([ MADRCU?!]{1,2}) (.*)$/s.exec(entry);
          if (!match) continue;
          if (match[1].includes('R') || match[1].includes('C')) index++;
          entries.push(match[2]);
        }
        dirty_paths = entries.slice(0, 50);
        dirty_count = entries.length;
      } catch { dirty_paths = null; dirty_count = null; }
      continuation = `PREVIOUS PACKET INCOMPLETE: ${JSON.stringify({ session: previous.session ?? null, stop_reason: previous.stop_reason ?? null, error: previous.error ?? null, full_result_path: previous.full_result_path ?? null, dirty_paths, dirty_count })}\nThe previous editor packet stopped before completion and its partial changes remain in the checkout. Keep them; do not redo or revert completed edits. Complete only the remaining obligation in this packet.\n`;
    }
    const fence = member ? `PARALLEL PACKET: other editors are writing other files now. You may edit or write only: ${paths.join(', ')}. You have no shell and cannot ask the owner; if a decision or anchor is missing, stop and return the exact question, the paths you checked and the facts found.\n` : '';
    task = launchProcess({ ...record, checkout: workspace ?? record.checkout, editor_session: session, editor_model: editorModel }, 'editor', `PACKAGE: ${record.package}\nSTEP: ${record.step}\nCHECKOUT: ${workspace ?? record.checkout}\nPRIMARY: ${record.primary}\n${targetFacts(record)}FRESH EDITOR: This packet is your complete assignment, not a continuation of prior editor chat. Preserve existing working-tree changes. ${orientation} Do not repeat prior work or verification.\n${continuation}${fence}${assignment}\n${excerpts}`,
      member ? { parallel: true, tools: FENCED_EDITOR_TOOLS.join(','), env: { SPEC_EDITOR_PATHS: JSON.stringify(paths), PI_INTERCOM_STABLE_ID: `spec-editor-${record.id}-${member}` } } : undefined);
    event(record, 'editor_started', { pid: task.child.pid, editor_session: session, ...(reasoning ? { reasoning } : {}), ...(context?.length ? { context_ranges: context.length } : {}) });
    let stopping;
    let reportUnconfirmed;
    const unconfirmed = new Promise(resolveFailure => { reportUnconfirmed = resolveFailure; });
    const abort = () => {
      revoke(record);
      stopping ||= stopGroup(record, task.child.pid).then(stopped => {
        if (!stopped) reportUnconfirmed({ error: 'Editor termination unconfirmed', requires_cancellation: true });
      }).catch(() => reportUnconfirmed({ error: 'Editor termination unconfirmed', requires_cancellation: true }));
    };
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const fatal = task.lifecycleFailure?.then(error => ({ error, requires_cancellation: true }));
    const result = await Promise.race([task.done, unconfirmed, ...(fatal ? [fatal] : [])]);
    signal?.removeEventListener('abort', abort);
    await stopping;
    if (signal?.aborted) {
      result.error ||= 'Editor interrupted; lease revoked pending coordinator cancellation.';
      result.requires_cancellation = true;
    }
    settleGroup(record, task.child.pid);
    const surviving = member ? [] : activeGroups(record).filter(group => group.role !== 'owner');
    if (surviving.length) {
      revoke(record);
      result.error = 'Editor or command descendants remain alive. Lease revoked; coordinator must cancel this run before replacing the editor.';
      result.requires_cancellation = true;
    }
    const configFailure = !result.requires_cancellation && (result.configuration_failure || configurationFailure(result.error));
    if (configFailure) {
      const failure = { ...configFailure, selector: record.editor_model, run_id: record.id, timestamp: timestamp() };
      atomic(configFile, failure);
      result.configuration_failure = failure;
      result.error = configurationAction(failure.selector, failure.cause);
      result.coordinator_action_required = true;
      event(record, 'editor_configuration_failed', failure);
    }
    // D11: an atomic per-run receipt, written immediately before editor_finished,
    // so a later packet and the completion guard observe this packet's outcome.
    // Calls that throw or latch on configuration write nothing. A batch member
    // writes its own receipt; runEditorBatch folds the members into the per-run one.
    atomic(member ? memberOutcomeFile(record, member) : outcomeFile, {
      version: 1, session, state: (result.error || result.stop_reason === 'length') ? 'incomplete' : 'completed',
      stop_reason: result.stop_reason ?? null, error: result.error ? String(result.error).slice(0, 300) : null,
      full_result_path: result.full_result_path ?? null, recorded_at: timestamp() });
    event(record, 'editor_finished', { state: result.error ? 'failed' : 'completed', error: result.error, ...(member ? { member } : {}) });
    return { ...result, editor_session: session, ...(member ? { paths } : {}) };
  } finally { if (!member && (!task || !activeGroups(record).some(group => group.role !== 'owner'))) rmSync(editorLock, { recursive: true, force: true }); }
}

// Each parallel batch member's outcome receipt, keyed by run and member number so
// siblings never overwrite one another or the per-run receipt.
const memberOutcomeFile = (record, member) => join(record.package, 'runtime/runs', `${record.id}-editor-outcome-${member}.json`);

// AC23: a nonempty integration patch from a packet is persisted under the run's
// runtime directory so the owner can inspect exactly what a member produced. The
// name embeds the batch identifier and packet index so sibling batches never
// overwrite one another. An empty patch (nothing to merge) writes nothing.
function persistConflictPatch(record, batch, index, patch) {
  if (typeof patch !== 'string' || !patch.length) return null;
  const file = join(record.package, 'runtime/runs', `${record.id}-batch-${batch}-packet-${index + 1}.patch`);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, patch, { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

// True when an editor write targets one of its fenced checkout-relative paths or lies under one.
export function fencedPath(checkout, path, fence) {
  if (typeof path !== 'string' || !path) return false;
  const root = resolve(checkout), full = resolve(root, path);
  return fence.some(entry => { const allowed = resolve(root, entry); return full === allowed || full.startsWith(`${allowed}/`); });
}

// Checkout-relative write sets for parallel packets: each must be non-empty and
// inside the checkout. Cross-packet overlap is refused by default; a batch that
// runs packets in isolated packet workspaces may pass `allowOverlap` and rely on
// the integration merge instead, while per-packet validation is unchanged.
export function packetPaths(record, packets, { allowOverlap = false } = {}) {
  const root = resolve(record.checkout);
  const sets = packets.map((packet, index) => {
    if (!Array.isArray(packet.paths) || !packet.paths.length) throw new Error(`packet ${index + 1} needs paths: the files it may write`);
    return packet.paths.map(path => {
      const full = resolve(root, path);
      if (full === root || !full.startsWith(`${root}/`)) throw new Error(`packet ${index + 1} path ${path} is outside the checkout`);
      return relative(root, full);
    });
  });
  if (allowOverlap) return sets;
  const covers = (a, b) => a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
  sets.forEach((set, i) => sets.slice(i + 1).forEach((other, offset) => {
    const clash = set.find(a => other.some(b => covers(a, b)));
    if (clash) throw new Error(`packets ${i + 1} and ${i + offset + 2} overlap at ${clash}; parallel packets must write disjoint files`);
  }));
  return sets;
}

// The run's selected backend bounds an isolated batch. Only explicit overlayfs
// or worktree selections are meaningful here; anything else defaults truthful
// to worktree rather than an insinuated overlay capability.
function normalizeWorkspaceBackend(value) {
  if (value === 'overlayfs' || value === 'overlay') return 'overlayfs';
  return 'worktree';
}

function packetSetsOverlap(sets) {
  const covers = (a, b) => a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      if (sets[i].some(a => sets[j].some(b => covers(a, b)))) return true;
    }
  }
  return false;
}

// Disjoint packets share the owner checkout without provisioning. The runtime
// builds this minimal view directly so a disjoint batch never calls the
// workspace provider.
function sharedPacketWorkspaces(record, sets, backend) {
  let expected = 0;
  return {
    isolated: false,
    mode: 'shared',
    backend,
    snapshot: null,
    members: sets.map((paths, k) => ({ k, checkout: record.checkout, paths })),
    workspaces: sets.map(() => record.checkout),
    integrate(index, { skip = false } = {}) {
      if (index !== expected) throw new Error(`packet ${expected} must integrate before packet ${index}`);
      expected += 1;
      return skip ? { status: 'not-run', conflicting_paths: [], patch: '' } : { status: 'applied', conflicting_paths: [], patch: '' };
    },
    cleanup() {},
  };
}

// Closed packets run concurrently while holding the writer slot, so no check or
// other editor overlaps the batch. Disjoint packets share the owner checkout in
// place. Packets that declare overlapping paths run in isolated packet
// workspaces snapshotted from the current working tree and are merged back in
// order by the integration step. Either way each editor is fenced to its paths,
// has no shell and cannot ask questions.
export async function runEditorBatch(record, packets, signal, launchProcess = launch, {
  stopGroup = terminateGroup,
  workspaceProvider = createPacketWorkspaces,
  ownership,
  coordinator,
  capability,
  mountTransport,
} = {}) {
  assertLease(record);
  if (!Array.isArray(packets) || packets.length < 2 || packets.length > PARALLEL_EDITORS) throw new Error(`a parallel batch takes 2 to ${PARALLEL_EDITORS} packets`);
  const sets = packetPaths(record, packets, { allowOverlap: true });
  const selectedBackend = packets.map(packet => packet.backend ?? packet.selected_backend ?? packet.launch ?? null).find(value => value != null) ?? null;
  // The run's backend selection bounds which backend an isolated batch may use;
  // a disjoint batch shares the owner checkout and never provisions.
  const runBackend = normalizeWorkspaceBackend(record.wave_bindings?.backend ?? record.backend ?? selectedBackend ?? 'worktree');
  const overlap = packetSetsOverlap(sets);
  let replyMode = 'shared';
  const editorLock = editorSlot(record);
  try { mkdirSync(editorLock); } catch { throw new Error('An editor assignment is already active; await its result.'); }
  let workspaces;
  const batch = randomUUID();
  let actualBackend = runBackend;
  try {
    // Provisioning decides the actual isolation and backend; the started event
    // is emitted only once that selection is known. Snapshot the CURRENT
    // working tree before any member launches so every packet workspace starts
    // from the same bytes and never from a sibling's partial writes. A disjoint
    // batch shares the checkout and never calls the provider.
    if (overlap) {
      workspaces = await workspaceProvider({
        record,
        checkout: record.checkout,
        packets: packets.map((packet, index) => ({ ...packet, paths: sets[index] })),
        batch,
        mode: runBackend,
        ownership,
        coordinator,
        capability,
        mountTransport,
      });
      replyMode = workspaces.isolated ? 'isolated' : 'shared';
    } else {
      workspaces = sharedPacketWorkspaces(record, sets, runBackend);
      replyMode = 'shared';
    }
    actualBackend = workspaces.backend ?? runBackend;
    event(record, 'editor_batch_started', { packets: packets.length, batch, mode: replyMode, selected_backend: actualBackend });
    const results = await Promise.all(packets.map((packet, index) => runEditor(record, packet.assignment, signal, launchProcess,
      { stopGroup, context: packet.context, reasoning: packet.reasoning, paths: sets[index], member: index + 1, workspace: workspaces.workspaces[index] })
      .catch(error => ({ error: error.message, paths: sets[index] }))));
    // Fold this batch's member receipts into the per-run receipt that the next
    // packet and the completion guard read: one incomplete member makes the batch
    // incomplete. As for a single packet, a member that threw or latched on
    // configuration wrote no receipt and contributes none.
    const members = results.flatMap((item, index) => {
      if (!item.editor_session) return [];
      const file = memberOutcomeFile(record, index + 1);
      const receipt = existsSync(file) ? read(file) : null;
      return receipt?.session === item.editor_session ? [{ member: index + 1, receipt_path: file, ...receipt }] : [];
    });
    if (members.length) {
      const incomplete = members.find(item => item.state === 'incomplete');
      atomic(join(record.package, 'runtime/runs', `${record.id}-editor-outcome.json`), {
        version: 1, session: incomplete?.session ?? null, state: incomplete ? 'incomplete' : 'completed',
        stop_reason: incomplete?.stop_reason ?? null, error: incomplete?.error ?? null,
        full_result_path: incomplete?.full_result_path ?? null,
        members: members.map(({ member, receipt_path, state }) => ({ member, receipt_path, state })), recorded_at: timestamp() });
    }
    const reply = { results, batch, mode: replyMode, selected_backend: actualBackend };
    // Verify every member group settled before touching the working tree: a live
    // descendant could still be writing into the checkout or its workspace.
    let survivors = activeGroups(record).filter(group => group.role !== 'owner');
    for (const group of survivors) {
      revoke(record);
      try { await stopGroup(record, group.pid); } catch { /* keep the group visible below */ }
    }
    if (survivors.length) survivors = activeGroups(record).filter(group => group.role !== 'owner');
    if (survivors.length) {
      revoke(record);
      Object.assign(reply, {
        error: 'Editor or command descendants remain alive. Lease revoked; coordinator must cancel this run before replacing the editor.',
        requires_cancellation: true, retained_workspaces: workspaces.workspaces,
        mode: replyMode, selected_backend: actualBackend,
      });
      event(record, 'editor_batch_finished', { packets: packets.length, batch, mode: replyMode, selected_backend: actualBackend, failed: results.filter(item => item.error).length, requires_cancellation: true });
      return reply;
    }
    if (workspaces.isolated) {
      const integration = [];
      for (let index = 0; index < packets.length; index += 1) {
        // AC23: a failed editor never integrates. Skip its workspace entirely;
        // the conflict patch rule also applies to a nonempty patch from a failed
        // member so the owner can inspect what it tried to write.
        const failed = Boolean(results[index]?.error);
        const merged = workspaces.integrate(index, { skip: failed });
        if (failed) {
          const notRun = { ...merged, status: 'not-run', reason: 'editor-failed' };
          integration.push(notRun);
          reply.results[index] = { ...reply.results[index], integration: notRun };
          if (merged.patch) {
            const patchPath = persistConflictPatch(record, batch, index, merged.patch);
            if (patchPath) reply.results[index] = { ...reply.results[index], patch_path: patchPath };
          }
          continue;
        }
        integration.push(merged);
        reply.results[index] = { ...reply.results[index], integration: merged };
        if (merged.status === 'conflict') {
          const detail = `packet ${index + 1} integration conflict at ${merged.conflicting_paths.join(', ')}`;
          reply.error = reply.error ? `${reply.error}; ${detail}` : detail;
          reply.results[index] = { ...reply.results[index], error: reply.results[index]?.error || detail, integration_conflict: merged.conflicting_paths };
          const file = memberOutcomeFile(record, index + 1);
          if (existsSync(file)) atomic(file, { ...read(file), state: 'incomplete', error: detail, integration_conflict: merged.conflicting_paths });
        }
        if (merged.patch) {
          const patchPath = persistConflictPatch(record, batch, index, merged.patch);
          if (patchPath) reply.results[index] = { ...reply.results[index], patch_path: patchPath };
        }
      }
      reply.integration = integration;
      // The per-run receipt is folded after integration so a conflict marks the
      // batch incomplete for the next packet and the completion guard.
      const members = results.flatMap((item, index) => {
        if (!item.editor_session) return [];
        const file = memberOutcomeFile(record, index + 1);
        const receipt = existsSync(file) ? read(file) : null;
        return receipt?.session === item.editor_session ? [{ member: index + 1, receipt_path: file, ...receipt }] : [];
      });
      if (members.length) {
        const incomplete = members.find(item => item.state === 'incomplete');
        atomic(join(record.package, 'runtime/runs', `${record.id}-editor-outcome.json`), {
          version: 1, session: incomplete?.session ?? null, state: incomplete ? 'incomplete' : 'completed',
          stop_reason: incomplete?.stop_reason ?? null, error: incomplete?.error ?? null,
          full_result_path: incomplete?.full_result_path ?? null,
          members: members.map(({ member, receipt_path, state }) => ({ member, receipt_path, state })), recorded_at: timestamp() });
      }
    }
    event(record, 'editor_batch_finished', {
      packets: packets.length, batch, mode: replyMode, selected_backend: actualBackend,
      failed: results.filter(item => item.error).length,
      integrated: reply.results.map(item => item?.integration?.status ?? null),
      integrated_packets: reply.results
        .map((item, index) => (item?.integration?.status === 'applied' ? index + 1 : null))
        .filter(index => index !== null),
    });
    return reply;
  } finally {
    // Cleanup only after a confirmed drain; a surviving process still owns its
    // workspace, so leave every path on disk and keep the slot locked instead.
    if (!activeGroups(record).some(group => group.role !== 'owner')) {
      await workspaces?.cleanup();
      rmSync(editorLock, { recursive: true, force: true });
    }
  }
}

// Share the editor slot so checks cannot race writes, even during a question pause.
export async function runCompletion(record, input) {
  return withIdleWriter(record, async () => {
    // D13: a length stop or error cannot complete the step; partial work stays
    // recoverable behind a bounded continuation or a checkpoint handoff.
    const outcomeFile = join(record.package, 'runtime/runs', `${record.id}-editor-outcome.json`);
    if (completeOutcomes.has(input.outcome) && existsSync(outcomeFile)) {
      const outcome = read(outcomeFile);
      if (outcome.state === 'incomplete') throw new Error(`Latest editor packet stopped incomplete (${outcome.stop_reason ?? 'error'}); assign a bounded continuation or submit a checkpoint with remaining_work.`);
    }
    const receipt = submitCompletion(record, input);
    event(record, 'handoff_recorded', { outcome: receipt.outcome, learning_path: receipt.learning_path });
    try { await refreshProgress(record.package); }
    catch (error) { return { ...receipt, progress_error: error.message, next: 'Handoff saved; refresh derived progress, not verification.' }; }
    return receipt;
  });
}

// Fingerprints record what was verified and how complete that evidence is; the
// command and summary text themselves are never retained here.
const normalizeCommand = command => String(command).replace(/\r\n/g, '\n').trim();
const normalizeSummary = text => String(text ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n');
const sha256Hex = value => createHash('sha256').update(value).digest('hex');

async function checkoutDigest(checkout) {
  if (typeof checkout !== 'string') return { tree_digest: null, complete: false };
  try {
    const facts = await collectFacts(checkout);
    return { tree_digest: typeof facts.working_tree_digest === 'string' ? facts.working_tree_digest : null,
      complete: Boolean(facts.working_tree_digest) && facts.incomplete !== true };
  } catch { return { tree_digest: null, complete: false }; }
}

async function verificationFingerprint(record, command, reply) {
  const digest = await checkoutDigest(record?.checkout);
  const exitCode = typeof reply?.exit_code === 'number' && Number.isFinite(reply.exit_code) ? reply.exit_code : null;
  return {
    version: 1,
    command_sha256: sha256Hex(normalizeCommand(command)),
    summary_sha256: sha256Hex(normalizeSummary(reply?.output)),
    tree_digest: digest.tree_digest,
    complete: reply?.output_truncated !== true && !reply?.error && !reply?.requires_cancellation
      && digest.complete && exitCode !== null && exitCode !== 0,
    exit_code: exitCode,
  };
}

export async function runVerification(record, command, timeout = 120, signal, server) {
  return withIdleWriter(record, async () => {
    invalidateCompletion(record);
    const before = revision(record);
    const started_at = timestamp(), started = performance.now();
    const timing = () => ({ started_at, elapsed_ms: Math.round(performance.now() - started) });
    let reply;
    try {
      reply = await (server
        ? withVerificationServer(record, server, () => runCommand(record, command, timeout, signal), signal)
        : runCommand(record, command, timeout, signal));
    } catch (error) {
      const receipt = recordVerification(record, command, before, revision(record), { error: error.message, exit_code: null }, timing());
      event(record, 'verification_finished', { receipt_id: receipt.id, outcome: receipt.outcome });
      error.receipt_id = receipt.id;
      throw error;
    }
    const receipt = recordVerification(record, command, before, revision(record), reply, timing());
    event(record, 'verification_finished', { receipt_id: receipt.id, outcome: receipt.outcome });
    const facts = { receipt_id: receipt.id, observed_revision: receipt.before, verification_artifact: receipt.summary_artifact,
      started_at: receipt.started_at, observed_at: receipt.observed_at, elapsed_ms: receipt.elapsed_ms };
    if (typeof reply?.exit_code !== 'number' || reply.exit_code === 0) return { ...reply, ...facts };
    return { ...reply, ...facts, sentinel_failure: await verificationFingerprint(record, command, reply) };
  });
}

// A server belongs to one verification operation, including its readiness wait,
// capture, and cleanup. It never survives a handoff to an editor.
export async function withVerificationServer(record, server, verify, signal) {
  const url = new URL(server.ready_url);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password)
    throw new Error('Verification server readiness URL must be loopback HTTP(S) without credentials');
  if (typeof server.command !== 'string' || !server.command.trim()) throw new Error('Verification server command is required');
  const ready = async () => {
    try {
      const response = await fetch(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(500)]) : AbortSignal.timeout(500) });
      await response.body?.cancel();
      return response.ok;
    } catch { return false; }
  };
  if (signal?.aborted) throw new Error('Verification interrupted before server start');
  if (await ready()) throw new Error('Readiness URL already responds; choose an owned free port. Existing server left untouched.');
  assertLease(record);
  const output = join(record.package, 'runtime/runs', `${record.id}-server-${randomUUID()}.log`);
  writeFileSync(output, '', { mode: 0o600, flag: 'wx' });
  const child = spawnManaged(record, 'server', '/bin/bash', ['-o', 'pipefail', '-c', `export SHELLOPTS\n${server.command}`]);
  let exited = false, serverError, result;
  child.on('error', error => { serverError = error.message; exited = true; });
  child.on('exit', () => { exited = true; });
  child.stdout.on('data', chunk => appendFileSync(output, chunk));
  child.stderr.on('data', chunk => appendFileSync(output, chunk));
  event(record, 'verification_server_started', { pid: child.pid });
  try {
    const deadline = Date.now() + Math.min(600, Math.max(1, server.readiness_timeout ?? 60)) * 1000;
    while (true) {
      if (signal?.aborted) throw new Error('Verification interrupted during server readiness');
      if (exited || child.launchError) throw new Error(`Verification server exited before capture: ${serverError || child.launchError || 'inspect server log'}`);
      if (await ready()) break;
      if (Date.now() >= deadline) throw new Error('Verification server readiness timed out');
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    if (exited) throw new Error('Verification server exited at readiness');
    assertLease(record);
    result = await verify();
    if (exited && !result.error) result.error = 'Verification server exited during capture; inspect server log';
  } catch (error) { result = { exit_code: null, error: error.message }; }
  finally {
    let stopped = false;
    try { stopped = await terminateGroup(record, child.pid); } catch { /* preserve the lease below */ }
    event(record, 'verification_server_finished', { stopped });
    if (!stopped) {
      revoke(record);
      result = { ...result, error: 'Server cleanup unconfirmed; lease revoked pending coordinator cancellation.', requires_cancellation: true };
    }
  }
  return { ...result, server_output_path: output };
}

export async function runAdvice(record, task, input, { offline = false, signal, decideTask = decide } = {}) {
  return withIdleWriter(record, async () => {
    if (signal?.aborted) throw new Error('Jev request aborted');
    const reply = await decideTask(task, { repo: record.checkout, input, offline });
    assertLease(record);
    if (signal?.aborted) throw new Error('Jev request aborted; do not use its recommendation');
    return reply;
  });
}

// The smallest synchronous idle-writer assertion owned by Runtime: a valid
// run, an unclaimed editor/verification slot, and no tracked non-owner managed
// group. withIdleWriter still performs the atomic slot claim via mkdir.
export function assertIdleWriter(record) {
  assertLease(record);
  if (existsSync(editorSlot(record))) throw new Error('An editor or verification command holds the writer slot.');
  if (activeGroups(record).some(group => group.role !== 'owner')) throw new Error('Managed work remains active; resolve it before another writer.');
}

async function withIdleWriter(record, action) {
  assertIdleWriter(record);
  const slot = editorSlot(record);
  try { mkdirSync(slot); } catch { throw new Error('Wait for the active editor or verification command to finish before verifying.'); }
  try {
    return await action();
  } finally { rmSync(slot, { recursive: true, force: true }); }
}

export async function runCommand(record, command, timeout = 120, signal, { stopGroup = terminateGroup } = {}) {
  assertLease(record);
  const output = join(record.package, 'runtime/runs', `${record.id}-command-${randomUUID()}.log`);
  writeFileSync(output, '', { mode: 0o600, flag: 'wx' });
  const logSummary = createLogSummary();
  const child = spawnManaged(record, 'command', '/bin/bash', ['-o', 'pipefail', '-c', `export SHELLOPTS\n${command}`]);
  let error, stopping;
  let reportUnconfirmed;
  const unconfirmed = new Promise(resolveFailure => { reportUnconfirmed = resolveFailure; });
  const consume = chunk => { appendFileSync(output, chunk); logSummary.write(chunk); };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  const stop = () => {
    error = 'Command interrupted or timed out';
    stopping ||= stopGroup(record, child.pid).then(stopped => {
      if (!stopped) reportUnconfirmed({ exit_code: null, signal: null });
    }).catch(cause => { error = cause.message; reportUnconfirmed({ exit_code: null, signal: null }); });
  };
  const timer = setTimeout(stop, timeout * 1000);
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop, { once: true });
  const closed = new Promise(resolveDone => {
    child.on('error', cause => { error = cause.message; });
    child.on('close', (code, sig) => resolveDone({ exit_code: code, signal: sig }));
  });
  // Failed termination must return a fatal receipt even if a descendant still
  // holds stdout open; otherwise the coordinator cannot begin cancellation.
  const outcome = await Promise.race([closed, unconfirmed]);
  clearTimeout(timer); signal?.removeEventListener('abort', stop); await stopping;
  let requiresCancellation = false;
  if (!(await waitGroupsGone(record, [child.pid], 1000))) {
    let stopped = false;
    try { stopped = await stopGroup(record, child.pid); } catch { /* retain the lease if cleanup is unconfirmed */ }
    if (stopped) error ||= 'Command left background descendants; runtime stopped them. Use the managed verification server option for capture.';
    else { revoke(record); requiresCancellation = true; error = 'Command cleanup unconfirmed; lease revoked pending coordinator cancellation.'; }
    event(record, 'command_cleanup', { stopped });
  }
  return { ...outcome, ...logSummary.finish(), full_output_path: output, error: child.launchError || error,
    ...(requiresCancellation ? { requires_cancellation: true } : {}) };
}

// ---------------------------------------------------------------------------
// Direct-execution entry point: the fixed, flock-guarded runtime mutation child.
// There is exactly one implementation behind flock for the short wave-member
// bind transaction and for concurrent event appends. No caller data reaches a
// shell; requests travel as JSON on stdin.
// ---------------------------------------------------------------------------

function runLockedMutation(lockPath, operation, request) {
  mkdirSync(dirname(lockPath), { recursive: true });
  closeSync(openSync(lockPath, 'a', 0o600));
  return new Promise((resolvePromise, reject) => {
    const child = spawn('flock', ['-x', lockPath, process.execPath, RUNTIME_MODULE_PATH, operation], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) { reject(new Error(`runtime mutation ${operation} failed (exit ${code}): ${stderr.trim() || 'no diagnostics'}`)); return; }
      try { resolvePromise(JSON.parse(stdout)); } catch (error) { reject(new Error(`runtime mutation ${operation} returned invalid JSON: ${stdout.trim().slice(0, 200)}`, { cause: error })); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

const RUNTIME_MUTATIONS = {
  'bind-wave-member': request => {
    const record = read(request.file);
    if (record.generation !== request.generation) return { ok: false, code: 'wave-generation-mismatch', message: 'Wave generation moved before the run bound.' };
    if (waveClaimToken(record) !== request.claimToken) return { ok: false, code: 'wave-claim-mismatch', message: 'Wave claim token changed before the run bound.' };
    const epoch = record.coordinator?.epoch;
    if (epoch === undefined || epoch === null || String(epoch) !== String(request.coordinatorEpoch))
      return { ok: false, code: 'wave-epoch-mismatch', message: 'Wave coordinator epoch changed before the run bound.' };
    let selected;
    try {
      selected = selectWaveSubject(record, { step_number: request.stepNumber, candidate: request.candidate,
        attempt_id: request.attemptId, phase: request.phase });
    } catch (error) {
      return { ok: false, code: error?.code || 'wave-member-mismatch', message: error?.message || 'Wave member identity changed before the run bound.' };
    }
    const member = selected.subject;
    if (!member || typeof member !== 'object') return { ok: false, code: 'wave-member-missing', message: 'Wave member disappeared before the run bound.' };
    if (Number(member.step) !== request.stepNumber || member.attempt_id !== request.attemptId || member.phase !== request.phase)
      return { ok: false, code: 'wave-member-mismatch', message: 'Wave member identity changed before the run bound.' };
    const workspace = member.workspace;
    if (!workspace || typeof workspace !== 'object' || workspace.claim?.token !== request.checkoutClaim)
      return { ok: false, code: 'wave-checkout-claim', message: 'Wave member checkout claim changed before the run bound.' };
    const occupied = selected.candidate ? record.target.repair : member;
    if (occupied.run_id !== undefined && occupied.run_id !== null && occupied.run_id !== request.runId)
      return { ok: false, code: 'wave-member-occupied', message: 'Wave member is already bound to another run.' };
    if (occupied.run_id === request.runId) return { ok: true, status: 'bound', idempotent: true };
    occupied.run_id = request.runId;
    atomic(request.file, record);
    return { ok: true, status: 'bound', idempotent: false };
  },
  'ensure-wave-deadline': request => {
    const record = read(request.file);
    if (record.generation !== request.generation) return { ok: false, code: 'wave-generation-mismatch', message: 'Wave generation moved before the deadline bound.' };
    if (waveClaimToken(record) !== request.claimToken) return { ok: false, code: 'wave-claim-mismatch', message: 'Wave claim token changed before the deadline bound.' };
    const epoch = record.coordinator?.epoch;
    if (epoch === undefined || epoch === null || String(epoch) !== String(request.coordinatorEpoch))
      return { ok: false, code: 'wave-epoch-mismatch', message: 'Wave coordinator epoch changed before the deadline bound.' };
    if (!record.deadline || typeof record.deadline !== 'object') {
      // The original shared deadline uses the validated requested timeout when
      // present; it is written once and never replaced on replay.
      const timeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs >= 1000 && request.timeoutMs <= 86400000
        ? request.timeoutMs : undefined;
      record.deadline = timeoutMs === undefined ? createWaveDeadline({}) : createWaveDeadline({ timeoutMs });
      atomic(request.file, record);
    }
    return { ok: true, deadline: record.deadline };
  },
  // Project the prepared step-workspaces object onto the wave member under the
  // flock-guarded generation/claim/epoch/attempt/phase check. A competing or
  // moved member refuses instead of overwriting a retained workspace.
  'persist-wave-member-workspace': request => {
    const record = read(request.file);
    if (record.generation !== request.generation) return { ok: false, code: 'wave-generation-mismatch', message: 'Wave generation moved before the workspace persisted.' };
    if (waveClaimToken(record) !== request.claimToken) return { ok: false, code: 'wave-claim-mismatch', message: 'Wave claim token changed before the workspace persisted.' };
    const epoch = record.coordinator?.epoch;
    if (epoch === undefined || epoch === null || String(epoch) !== String(request.coordinatorEpoch))
      return { ok: false, code: 'wave-epoch-mismatch', message: 'Wave coordinator epoch changed before the workspace persisted.' };
    const member = record.members?.[String(request.stepNumber)];
    if (!member || typeof member !== 'object') return { ok: false, code: 'wave-member-missing', message: 'Wave member disappeared before the workspace persisted.' };
    if (Number(member.step) !== request.stepNumber || member.attempt_id !== request.attemptId || member.phase !== request.phase)
      return { ok: false, code: 'wave-member-mismatch', message: 'Wave member identity changed before the workspace persisted.' };
    if (member.workspace !== undefined && member.workspace !== null) {
      if (JSON.stringify(member.workspace) !== JSON.stringify(request.workspace))
        return { ok: false, code: 'wave-workspace-occupied', message: 'Wave member already retains a different workspace.' };
      return { ok: true, status: 'persisted', idempotent: true };
    }
    member.workspace = request.workspace;
    if (request.receipt !== undefined) member.preparation_receipt = request.receipt;
    atomic(request.file, record);
    return { ok: true, status: 'persisted', idempotent: false };
  },
  // Revalidate the exact wave identity for the remount under the wave lock,
  // then swap the member workspace for the re-claimed one and clear the
  // previous run binding so the current phase can start normally.
  'remount-wave-member': request => {
    const record = read(request.file);
    if (record.generation !== request.generation) return { ok: false, code: 'wave-generation-mismatch', message: 'Wave generation moved before the remount persisted.' };
    if (waveClaimToken(record) !== request.claimToken) return { ok: false, code: 'wave-claim-mismatch', message: 'Wave claim token changed before the remount persisted.' };
    const epoch = record.coordinator?.epoch;
    if (epoch === undefined || epoch === null || String(epoch) !== String(request.coordinatorEpoch))
      return { ok: false, code: 'wave-epoch-mismatch', message: 'Wave coordinator epoch changed before the remount persisted.' };
    let selected;
    try {
      selected = selectWaveSubject(record, { step_number: request.stepNumber, candidate: request.candidate, attempt_id: request.attemptId, phase: request.phase });
    } catch (error) {
      return { ok: false, code: error?.code || 'wave-member-mismatch', message: error?.message || 'Wave member identity changed before the remount persisted.' };
    }
    if (selected.candidate !== (request.candidate ?? null))
      return { ok: false, code: 'wave-member-mismatch', message: 'Wave member identity changed before the remount persisted.' };
    const subject = selected.subject;
    if (!subject || typeof subject !== 'object') return { ok: false, code: 'wave-member-missing', message: 'Wave member disappeared before the remount persisted.' };
    if (Number(subject.step) !== request.stepNumber || subject.attempt_id !== request.attemptId || subject.phase !== request.phase)
      return { ok: false, code: 'wave-member-mismatch', message: 'Wave member identity changed before the remount persisted.' };
    const prior = subject.workspace;
    if (!prior || typeof prior !== 'object' || !prior.retained) return { ok: false, code: 'wave-remount-unprepared', message: 'Wave member lost its retained workspace before the remount persisted.' };
    if (JSON.stringify(prior.retained) !== JSON.stringify(request.retained)) return { ok: false, code: 'wave-remount-identity', message: 'Wave member retained identity moved before the remount persisted.' };
    if (subject.run_id !== null && subject.run_id !== undefined && subject.run_id !== request.previousRunId)
      return { ok: false, code: 'wave-remount-run', message: 'Wave member run binding changed before the remount persisted.' };
    if ((subject.run_id === null || subject.run_id === undefined) && JSON.stringify(prior.claim) === JSON.stringify(request.workspace.claim))
      return { ok: true, status: 'remounted', idempotent: true };
    if (selected.candidate !== null) {
      if (!record.target || typeof record.target !== 'object') return { ok: false, code: 'wave-member-mismatch', message: 'Wave target disappeared before the remount persisted.' };
      if (!record.target.integration || typeof record.target.integration !== 'object') record.target.integration = {};
      record.target.integration.workspace = request.workspace;
      if (record.target.repair && typeof record.target.repair === 'object') record.target.repair.run_id = null;
    } else {
      subject.workspace = request.workspace;
      subject.run_id = null;
    }
    atomic(request.file, record);
    return { ok: true, status: 'remounted', idempotent: false };
  },
  'append-event': request => {
    appendFileSync(request.file, Buffer.from(request.line), { mode: 0o600 });
    return { ok: true };
  },
};

if (process.argv[1] && resolve(process.argv[1]) === RUNTIME_MODULE_PATH && RUNTIME_MUTATIONS[process.argv[2]]) {
  try {
    process.stdout.write(`${JSON.stringify(RUNTIME_MUTATIONS[process.argv[2]](JSON.parse(readFileSync(0, 'utf8'))))}\n`);
  } catch (error) {
    process.stderr.write(`${(error && error.stack) || String(error)}\n`);
    process.exitCode = 1;
  }
}
