// Bubblewrap OverlayFS adapter for waves.
//
// This module owns the fixed unprivileged launch argv, owned layer identity
// validation, retained layer records and exclusive per-upper phase claims. It
// never mounts, unmounts or clears anything itself: upper/work directories and
// failed attempt storage are retained across phase exit, and a later phase may
// only re-claim the same upper after a positive drain.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

const LAUNCH_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const OPTION_KEYS = new Set(['token', 'lower', 'upper', 'work', 'merged', 'chdir', 'command', 'stat']);
const LAYER_KEYS = ['lower', 'upper', 'work', 'merged'];

// Fixed C.1 launch: a user namespace gives unprivileged mounts, --die-with-parent
// covers parent death, host PIDs/network stay shared, the merged cwd is entered
// explicitly and the command is passed as argv after '--' (no shell).
export function buildOverlayArgv(options) {
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw refusal('option-unknown', `unknown option: ${key}`);
  }
  if (typeof options.token !== 'string' || !LAUNCH_TOKEN_PATTERN.test(options.token)) {
    throw refusal('token-invalid', 'token must match the launch token pattern');
  }
  if (!isCommand(options.command)) {
    throw refusal('command-invalid', 'command must be a non-empty array of non-empty strings');
  }
  if (options.chdir !== undefined && !isAbsolutePath(options.chdir)) {
    throw refusal('chdir-invalid', 'chdir must be an absolute path');
  }
  const inspected = inspectLayers(options);
  if (!inspected.ok) throw refusal(inspected.reason, inspected.detail);

  const { token, lower, upper, work, merged, command } = options;
  return {
    token,
    argv: [
      'bwrap', '--unshare-user', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
      '--overlay-src', lower, '--overlay', upper, work, merged, '--chdir', options.chdir ?? merged, '--', ...command,
    ],
  };
}

// Validation for consumers that report rather than throw; the layer identity
// pipeline is shared with buildOverlayArgv so both refuse the same inputs.
export function validateLayers({ lower, upper, work, merged, gitDir, stat = statSync } = {}) {
  const inspected = inspectLayers({ lower, upper, work, merged, stat });
  if (!inspected.ok) return inspected;
  const git = inspectGitDir(gitDir, merged);
  if (!git.ok) return git;
  return {
    ok: true,
    identities: { lower, upper, work, merged, gitDir: git.gitDir },
    devices: inspected.devices,
  };
}

// A retained record is immutable identity only: nothing here removes or
// re-registers upper/work content, so interrupted attempts keep their storage.
export function retainLayer({ lower, upper, work, merged, gitDir = null, baseCommit = null, snapshotId = null, upperId = null }) {
  return Object.freeze({ lower, upper, work, merged, gitDir, baseCommit, snapshotId, upperId });
}

// Phase claims are keyed by the upper/work pair (the checkout identity), so at
// most one phase can mount a given upper. Held claims refuse regardless of
// coordinator liveness: liveness is never authority to mount, only a positive
// drain (via endPhase) releases the claim for remount.
export function createOverlayPhases({ ownership }) {
  async function startPhase({ packageId, upper, work, phaseToken, coordinator }) {
    requirePhaseToken(phaseToken);
    const result = await ownership.reserveCheckout({
      packageId,
      attempt: phaseToken,
      checkout: { gitCommonDir: upper, worktreeGitDir: work },
      coordinator,
    });
    if (result.status === 'reserved') return { status: 'permitted', claim: result.claim };
    if (result.status === 'held' && result.claim.attempt === phaseToken) {
      return { status: 'replayed', claim: result.claim };
    }
    return { status: 'refused', reason: 'upper-held', claim: result.claim };
  }

  async function endPhase({ token, epoch, drain }) {
    return ownership.releaseClaim({ token, epoch, drain });
  }

  return { startPhase, endPhase };
}

// ---------------------------------------------------------------------------
// Shared validation internals
// ---------------------------------------------------------------------------

function inspectLayers({ lower, upper, work, merged, stat = statSync }) {
  const identities = { lower, upper, work, merged };
  for (const key of LAYER_KEYS) {
    if (!isNormalizedAbsolutePath(identities[key])) {
      return failure('identity-invalid', `${key} must be an absolute normalized path`);
    }
  }
  const seen = new Set();
  for (const key of LAYER_KEYS) {
    if (seen.has(identities[key])) return failure('identity-not-distinct', `duplicate layer identity at ${key}`);
    seen.add(identities[key]);
  }
  const devices = {};
  for (const key of LAYER_KEYS) {
    const stats = statOrNull(stat, identities[key]);
    if (!stats) return failure('identity-missing', `${key} does not exist`);
    if (key === 'upper' || key === 'work') devices[key] = stats.dev;
  }
  if (devices.upper !== devices.work) {
    return failure('upper-work-filesystem-mismatch', 'upper and work must share one filesystem');
  }
  return { ok: true, identities, devices };
}

function inspectGitDir(gitDir, merged) {
  if (gitDir === undefined || gitDir === null) return { ok: true, gitDir: null };
  if (!isAbsolutePath(gitDir)) return failure('git-invalid', 'gitDir must be an absolute path');
  const candidate = normalize(gitDir);
  const prefix = merged.endsWith('/') ? merged : `${merged}/`;
  if (candidate === merged || candidate.startsWith(prefix)) {
    return failure('git-inside-merged', 'gitDir must stay outside the merged tree');
  }
  return { ok: true, gitDir };
}

function failure(reason, detail) {
  return { ok: false, reason, detail };
}

function statOrNull(stat, path) {
  try {
    return stat(path);
  } catch {
    return null;
  }
}

function isCommand(command) {
  return Array.isArray(command) && command.length > 0 && command.every(entry => typeof entry === 'string' && entry.length > 0);
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value);
}

function isNormalizedAbsolutePath(value) {
  return isAbsolutePath(value) && normalize(value) === value;
}

function requirePhaseToken(phaseToken) {
  if (typeof phaseToken !== 'string' || phaseToken.length === 0) {
    throw refusal('token-invalid', 'phaseToken must be a non-empty string');
  }
}

function refusal(reason, detail) {
  const error = new Error(`overlay refusal: ${reason}${detail ? ` (${detail})` : ''}`);
  error.code = 'overlay-refusal';
  error.reason = reason;
  return error;
}

// ---------------------------------------------------------------------------
// C.1 capability probe
//
// The probe performs the fixed unprivileged overlay launch twice: the collect
// phase proves the mount options and copy-up/whiteout semantics through the
// merged view, and the verify phase remounts the retained upper/work to prove
// the copy-up edit and the whiteout survived phase exit. Only observed,
// enumerated pre-write unavailability authorizes fallback; corruption and
// unknown kernel effects stay blocked (INV-4).
// ---------------------------------------------------------------------------

export async function runCapabilityProbe({ runner, fixtureRoot } = {}) {
  const boundary = typeof runner === 'function' ? 'substituted' : 'kernel';
  const runProbe = typeof runner === 'function' ? runner : defaultProbeRunner;
  const fixture = createProbeFixture(fixtureRoot);
  const token = nextProbeToken();
  const phases = { collect: null, verify: null };
  let spawnError = null;
  let collectThrew = false;

  try {
    phases.collect = await runProbe({ argv: probeArgv(token, fixture, 'collect'), phase: 'collect' });
  } catch (error) {
    collectThrew = true;
    if (error && error.code === 'ENOENT') spawnError = error;
    else phases.collect = failedPhase(error);
  }
  if (!collectThrew) {
    try {
      phases.verify = await runProbe({ argv: probeArgv(token, fixture, 'verify'), phase: 'verify' });
    } catch (error) {
      phases.verify = failedPhase(error);
    }
  }

  const result = spawnError
    ? interpretProbeResult({ spawnError })
    : interpretProbeResult({ collect: phases.collect, verify: phases.verify });
  return { boundary, fixtureDir: fixture.fixtureDir, phases, result };
}

export function interpretProbeResult({ spawnError = null, collect = null, verify = null } = {}) {
  if (spawnError && spawnError.code === 'ENOENT') {
    return capability('unavailable', 'bwrap-absent', PROBE_REMEDIES['bwrap-absent'], true);
  }
  if (!collect || collect.exitCode !== 0) {
    const stderr = typeof collect?.stderr === 'string' ? collect.stderr : '';
    if (PROBE_OPTION_PATTERN.test(stderr)) {
      return capability('unavailable', 'overlay-options-absent', PROBE_REMEDIES['overlay-options-absent'], true);
    }
    if (PROBE_PERMISSION_PATTERN.test(stderr) && PROBE_USERNS_PATTERN.test(stderr)) {
      return capability('unavailable', 'userns-denied', PROBE_REMEDIES.userns, true);
    }
    if (PROBE_PERMISSION_PATTERN.test(stderr) && PROBE_MOUNT_PATTERN.test(stderr)) {
      return capability('unavailable', 'mount-denied', PROBE_REMEDIES.userns, true);
    }
    return capability('blocked', 'unknown-effect', null, false);
  }

  const collected = parseProbeJson(collect.stdout);
  if (!hasProbeFields(collected, ['fstype', 'options', 'copyUp', 'deletion'])) {
    return capability('blocked', 'corrupt-output', null, false);
  }
  if (!verify || verify.exitCode !== 0) {
    return capability('unavailable', 'semantics-failed', PROBE_REMEDIES['semantics-failed'], true);
  }

  const verified = parseProbeJson(verify.stdout);
  if (!hasProbeFields(verified, ['fstype', 'options', 'retainedWrite', 'retainedDeletion'])) {
    return capability('blocked', 'corrupt-output', null, false);
  }
  if (collected.fstype !== 'overlay') {
    return capability('unavailable', 'filesystem-unsupported', PROBE_REMEDIES['filesystem-unsupported'], true);
  }
  if (collected.copyUp !== true || collected.deletion !== true || verified.retainedWrite !== true || verified.retainedDeletion !== true) {
    return capability('unavailable', 'semantics-failed', PROBE_REMEDIES['semantics-failed'], true);
  }

  return {
    status: 'supported',
    reason: 'overlay-supported',
    remedy: null,
    fallbackEligible: false,
    observed: {
      fstype: collected.fstype,
      options: collected.options,
      copyUp: collected.copyUp,
      deletion: collected.deletion,
      retainedWrite: verified.retainedWrite,
      retainedDeletion: verified.retainedDeletion,
    },
  };
}

// ---------------------------------------------------------------------------
// Probe internals
// ---------------------------------------------------------------------------

const PROBE_REMEDIES = Object.freeze({
  'bwrap-absent': 'install supported bubblewrap (>= 0.11.0, non-setuid) with overlay options',
  'overlay-options-absent': 'install bubblewrap >= 0.11.0 (overlay options)',
  userns: 'administrator installs the OS-approved AppArmor user-namespace profile or enables unprivileged user namespaces',
  'semantics-failed': 'kernel overlay semantics failed the disposable probe; select worktree fallback or repair the kernel/filesystem',
  'filesystem-unsupported': 'place retained overlay layers on a local filesystem supporting kernel OverlayFS',
});

const PROBE_OPTION_PATTERN = /unknown option|unrecognized option|--overlay/i;
const PROBE_PERMISSION_PATTERN = /permission denied|operation not permitted/i;
const PROBE_USERNS_PATTERN = /unshare|user.?namespace/i;
const PROBE_MOUNT_PATTERN = /mount|overlay/i;

let probeSequence = 0;

function nextProbeToken() {
  probeSequence += 1;
  return `wave-overlay-probe-${process.pid}-${probeSequence}`;
}

// Disposable fixtures only: the seeded lower files give the probe copy-up and
// whiteout content, and the directory is never removed here.
function createProbeFixture(fixtureRoot) {
  const fixtureDir = mkdtempSync(join(fixtureRoot ?? tmpdir(), 'wave-overlay-probe-'));
  const fixture = {
    fixtureDir,
    lower: join(fixtureDir, 'lower'),
    upper: join(fixtureDir, 'upper'),
    work: join(fixtureDir, 'work'),
    merged: join(fixtureDir, 'merged'),
  };
  for (const dir of [fixture.lower, fixture.upper, fixture.work, fixture.merged]) mkdirSync(dir);
  writeFileSync(join(fixture.lower, 'wave-probe-copy-up.txt'), 'wave-probe-base\n');
  writeFileSync(join(fixture.lower, 'wave-probe-delete.txt'), 'wave-probe-base\n');
  return fixture;
}

function probeArgv(token, fixture, mode) {
  const { lower, upper, work, merged } = fixture;
  return buildOverlayArgv({
    token,
    lower,
    upper,
    work,
    merged,
    command: ['sh', '-c', PROBE_SCRIPT, 'wave-overlay-probe', mode, merged, upper],
  }).argv;
}

// Real default boundary: fixed argv array with no shell anywhere. A missing
// executable surfaces as a thrown ENOENT so the probe reports bwrap-absent.
function defaultProbeRunner({ argv }) {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', shell: false });
  if (result.error) throw result.error;
  return {
    exitCode: typeof result.status === 'number' ? result.status : 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function failedPhase(error) {
  const detail = error && typeof error.message === 'string' ? error.message : String(error);
  return { exitCode: 1, stdout: '', stderr: detail };
}

function parseProbeJson(stdout) {
  if (typeof stdout !== 'string') return null;
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasProbeFields(value, fields) {
  return value !== null && fields.every(field => Object.hasOwn(value, field));
}

function capability(status, reason, remedy, fallbackEligible) {
  return { status, reason, remedy, fallbackEligible, observed: null };
}

// Fixed two-mode POSIX sh probe. Paths arrive only as quoted positional
// arguments; nothing from caller options is embedded in the script text. Each
// mode prints its single JSON line with one printf.
const PROBE_SCRIPT = String.raw`set -eu
mode=$1
merged=$2
upper=$3

# Field 1 after the " - " separator is the filesystem type and field 3 is the
# mount's super options; only the line whose mount point ($5) is the merged
# directory is read.
mount_field() {
  awk -v target="$merged" -v want="$1" '
    $5 == target {
      rest = substr($0, index($0, " - ") + 3)
      count = split(rest, parts, " ")
      if (count >= want) print parts[want]
      exit
    }
  ' /proc/self/mountinfo
}

fstype=$(mount_field 1)
options=$(mount_field 3)
copy_up=false
deletion=false
retained_write=false
retained_deletion=false

if [ "$mode" = collect ]; then
  printf 'wave-probe-modified\n' >> "$merged/wave-probe-copy-up.txt"
  if grep -q wave-probe-modified "$upper/wave-probe-copy-up.txt" 2>/dev/null; then
    copy_up=true
  fi
  rm -f "$merged/wave-probe-delete.txt"
  if [ ! -e "$merged/wave-probe-delete.txt" ] && [ -e "$upper/wave-probe-delete.txt" ]; then
    deletion=true
  fi
  printf '{"fstype":"%s","options":"%s","copyUp":%s,"deletion":%s}\n' "$fstype" "$options" "$copy_up" "$deletion"
elif [ "$mode" = verify ]; then
  if grep -q wave-probe-modified "$merged/wave-probe-copy-up.txt" 2>/dev/null; then
    retained_write=true
  fi
  if [ ! -e "$merged/wave-probe-delete.txt" ] && [ -e "$upper/wave-probe-delete.txt" ]; then
    retained_deletion=true
  fi
  printf '{"fstype":"%s","options":"%s","retainedWrite":%s,"retainedDeletion":%s}\n' "$fstype" "$options" "$retained_write" "$retained_deletion"
else
  echo "unknown probe mode: $mode" >&2
  exit 1
fi`;
