// Session-local read-only workspace observer for the spec sentinel.
//
// The observer collects bounded workspace facts and renders them as plain
// status. It never starts, stops, messages or cancels a worker and never writes
// anything except the explicit enrollment record created by /spec-sentinel add.

import { watch, mkdirSync, renameSync, readdirSync, writeFileSync, readFileSync, statSync, existsSync, lstatSync, realpathSync, openSync, closeSync, fsyncSync, unlinkSync, linkSync, fstatSync, readSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname, sep, relative, isAbsolute, basename } from 'node:path';

import { canonicalPackage } from './runtime.mjs';
import { publicHint } from './monitor.mjs';
import { collectWorkspace, renderWorkspace, enrollmentDirectory, readEnrollments, enrollmentReasons, SENTINEL_LIMITS } from '../../../scripts/spec-observe/sentinel.mjs';

export const SENTINEL_COALESCE_MS = 250;
export const SENTINEL_RECONCILE_MS = 15000;
export const SENTINEL_WIDGET_KEY = 'spec-sentinel';

const USAGE = 'Usage: /spec-sentinel status | add /absolute/primary | inspect ID | off';
const MAX_WATCHERS = 60;

export function createSentinelObserver({ pi, context, agentDir, scope = null, ownPackages = [], indexDir = join(agentDir, 'spec-runtime'),
  now = Date.now, watchDirectory = watch, setTimer = setTimeout, clearTimer = clearTimeout, repeat = setInterval, cancelRepeat = clearInterval,
  nativeRun = null, maxWatchers = MAX_WATCHERS }) {
  let closed = false;
  let hidden = false;
  let latest = null;
  let inFlight = null;
  let coalesced;
  let reconcileTimer;
  let note = null;
  const watchers = new Map();

  const notify = (ctx, message, level = 'info') => {
    try { (ctx ?? context)?.ui?.notify?.(message, level); } catch { /* UI failure must not affect observation. */ }
  };

  const clearWidgets = () => {
    try { context?.ui?.setWidget?.(SENTINEL_WIDGET_KEY, []); } catch { /* UI failure must not affect observation. */ }
    try { context?.ui?.setStatus?.(SENTINEL_WIDGET_KEY, ''); } catch { /* UI failure must not affect observation. */ }
  };

  function invalidate() {
    if (closed || hidden || coalesced) return;
    // Coalesce repeated invalidation events into one bounded refresh.
    coalesced = setTimer(async () => {
      coalesced = undefined;
      await run(false);
    }, SENTINEL_COALESCE_MS);
    coalesced?.unref?.();
  }

  function syncWatchers(targets) {
    const wanted = [];
    for (const target of targets) {
      const directory = resolve(target);
      if (!wanted.includes(directory)) wanted.push(directory);
    }
    for (const [directory, watcher] of watchers) {
      if (wanted.includes(directory)) continue;
      watchers.delete(directory);
      try { watcher.close?.(); } catch { /* Closing is best effort. */ }
    }
    const selected = wanted.slice(0, maxWatchers);
    if (wanted.length > selected.length) {
      // Excluded directories keep only 15 s reconciliation; the gap stays visible.
      note = `Watcher cap reached (${selected.length} of ${wanted.length} directories); reconciliation covers the excluded ones.`;
    }
    for (const directory of selected) {
      if (watchers.has(directory)) continue;
      try {
        const watcher = watchDirectory(directory, () => invalidate());
        watcher?.on?.('error', error => {
          // A failed watch is disposed immediately and retried on the next
          // reconciliation; last known facts are kept and the coverage loss
          // is displayed, never silently swallowed.
          watchers.delete(directory);
          try { watcher.close?.(); } catch { /* Closing is best effort. */ }
          if (error?.code === 'ENOENT') return;
          note = 'Watcher unavailable; status reflects the last bounded read.';
          render();
        });
        watchers.set(directory, watcher);
      } catch (error) {
        // A directory that is absent now is an ordinary gap retried on the
        // next refresh; any other construction failure is reported.
        if (error?.code !== 'ENOENT') note = 'Watcher unavailable; status reflects the last bounded read.';
      }
    }
  }

  function snapshotTargets(snapshot) {
    const targets = [];
    for (const root of snapshot?.roots ?? []) {
      targets.push(root, join(root, '.specs'));
    }
    for (const run of snapshot?.runs ?? []) {
      if (!run?.package) continue;
      const runtimeDirectory = join(run.package, 'runtime');
      targets.push(join(runtimeDirectory, 'runs'));
      // Node directory watches are nonrecursive: every nested directory that
      // actually holds observed sources (activity roles, checkpoint
      // workflows) needs its own invalidation watch.
      for (const source of run.source_paths ?? []) {
        if (typeof source !== 'string' || !source.startsWith(`${runtimeDirectory}${sep}`)) continue;
        targets.push(dirname(source));
      }
    }
    return targets;
  }

  async function run(force = false) {
    if (closed) return latest;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (hidden && !force) return latest;
      try {
        const enrolled = await readEnrollments({ agentDir, scope });
        const enrollmentErrors = enrolled.errors ?? [];
        const roots = enrolled.roots ?? [];
        if (!roots.length && enrollmentErrors.length && latest) {
          // Unreadable enrollment retains the last known facts as stale
          // instead of replacing them with an unobserved empty workspace.
          latest = { ...latest, roots, coverage: { ...latest.coverage, state: 'stale', omitted: null,
            reasons: [...new Set([...latest.coverage.reasons, ...enrollmentReasons(enrollmentErrors)])] } };
          note = 'Enrollment unreadable; status reflects the last bounded read.';
          if (!closed && !hidden) render();
          return latest;
        }
        const snapshot = await collectWorkspace({
          roots, packages: [...ownPackages], enrollmentErrors, indexDir, agentDir, scope, now,
        });
        latest = { ...snapshot, roots };
        note = null;
        // Lifecycle fence: off or close during the asynchronous reads must
        // never install handles or render into a hidden/disposed view.
        if (!closed && !hidden) {
          syncWatchers(snapshotTargets(latest));
          render();
        }
        return latest;
      } catch (error) {
        // Last known facts are kept; the failure becomes an explicit note.
        note = `Sentinel workspace unavailable: ${publicHint(error?.message ?? String(error))}`;
        if (!closed && !hidden) render();
        return latest;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function render() {
    if (closed || hidden || !context?.hasUI) return;
    try {
      // A failed read or watch keeps the last facts but displays stale coverage.
      const shown = note && latest ? { ...latest, coverage: { ...latest.coverage, state: 'stale' } } : latest;
      const lines = shown ? renderWorkspace(shown) : [];
      const current = nativeRun?.() ?? null;
      // Only the identity/execution detail row of a run the native monitor is
      // already displaying is redundant; workspace coverage notes and
      // sentinel-only conditions always remain visible.
      if (shown?.runs?.length === 1 && current?.id && typeof current.package === 'string'
        && shown.runs[0]?.source_paths?.some(source => resolve(source)
          === resolve(join(current.package, 'runtime', 'runs', `${current.id}.json`)))) {
        lines.splice(1, 1);
      }
      if (note) lines.push(note);
      context.ui.setWidget(SENTINEL_WIDGET_KEY, lines);
      context.ui.setStatus(SENTINEL_WIDGET_KEY,
        `sentinel ${shown?.coverage?.state ?? 'unknown'} · ${shown?.runs?.length ?? 0} run(s)`);
    } catch { /* UI failure must not affect observation. */ }
  }

  function stopHandles() {
    for (const watcher of watchers.values()) {
      try { watcher.close?.(); } catch { /* Closing is best effort. */ }
    }
    watchers.clear();
    if (coalesced !== undefined) { try { clearTimer(coalesced); } catch { /* Timer may already have run. */ } coalesced = undefined; }
    if (reconcileTimer !== undefined) { try { cancelRepeat(reconcileTimer); } catch { /* Timer may already have run. */ } reconcileTimer = undefined; }
  }

  async function enroll(target) {
    const directory = enrollmentDirectory({ agentDir, scope });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const existing = await readEnrollments({ agentDir, scope });
    let canonical;
    let specs = null;
    try { canonical = canonicalPackage(resolve(target)); }
    catch {
      // Otherwise the target is a primary root: use its first canonical package.
      specs = join(resolve(target), '.specs');
      const children = readdirSync(specs, { withFileTypes: true }).slice(0, 101).filter(entry => entry.isDirectory());
      for (const entry of children) {
        try { canonical = canonicalPackage(join(specs, entry.name)); break; }
        catch { /* A linked worktree copy is never canonical. */ }
      }
    }
    if (!canonical) throw new Error('Enrollment requires a primary checkout root containing a canonical .specs package; linked worktrees are not enrolled.');
    const records = existing.records ?? [];
    const counted = records.length;
    const sameCommon = records.some(record => record.common === canonical.common);
    if (counted >= SENTINEL_LIMITS.roots && !sameCommon) throw new Error(`Enrollment limit reached (${SENTINEL_LIMITS.roots} roots).`);
    const file = join(directory, `${createHash('sha256').update(canonical.common).digest('hex')}.json`);
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: 1, root: canonical.primary, common: canonical.common, enrolled_at: new Date(now()).toISOString() }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
    return canonical;
  }

  async function handler(args = '', ctx = context) {
    try {
      const [actionRaw, ...rest] = String(args ?? '').trim().split(/\s+/).filter(Boolean);
      const action = (actionRaw ?? '').toLowerCase();
      if (!action || action === 'status') {
        const snapshot = await run(true);
        if (!snapshot) { notify(ctx, 'Sentinel workspace unavailable.', 'error'); return; }
        // Explicit status carries the retained-read uncertainty too, not only
        // the unrendered observer note.
        notify(ctx, [...renderWorkspace(snapshot), ...(note ? [note] : [])].join('\n'), 'info');
        return;
      }
      if (action === 'add') {
        const target = rest.join(' ');
        if (!target) throw new Error(USAGE);
        const canonical = await enroll(target);
        notify(ctx, `Enrolled ${canonical.primary} for read-only observation. Enrollment only grants reads; it never starts, stops or messages workers.`, 'info');
        await run(true);
        return;
      }
      if (action === 'inspect') {
        const id = rest.join(' ');
        if (!id) throw new Error(USAGE);
        const snapshot = await run(true);
        const matched = snapshot?.runs?.find(item => item.assignment_id === id || item.workflow_id === id || item.package === id
          || item.package?.split('/').pop() === id
          || item.conditions?.some(condition => condition.id === id || condition.kind === id));
        if (!matched) { notify(ctx, `No observed run or condition matches ${id}.`, 'warning'); return; }
        const condition = matched.conditions?.find(item => item.id === id || item.kind === id);
        const lines = [
          `${publicHint(matched.assignment_id)} · ${publicHint(matched.execution)}`,
          `${publicHint(matched.repository)} · ${publicHint(matched.package)} · ${matched.checkout ? publicHint(matched.checkout) : 'checkout unknown'}`,
          matched.coordinator_session ? `coordinator: ${publicHint(matched.coordinator_session)}` : 'coordinator: unknown',
          `${matched.workflow_id ? `workflow ${publicHint(matched.workflow_id)} · ` : ''}${matched.obligation ? publicHint(matched.obligation) : 'obligation unknown'}`,
          `activity: ${matched.activity ? publicHint(matched.activity) : 'activity unknown'}`,
          `observed_at: ${publicHint(matched.observed_at)} · coverage ${matched.coverage.state}${matched.coverage.reasons.length ? ` (${matched.coverage.reasons.join(', ')})` : ''}`,
          ...(matched.conditions ?? []).map(item => `${item.id} ${item.kind} [${item.severity}/${item.state}]`),
          ...(matched.source_paths ?? []).map(file => `source: ${publicHint(file)}`),
          ...(condition ? [`selected condition ${condition.id} ${condition.kind} [${condition.severity}/${condition.state}]`] : []),
        ];
        notify(ctx, lines.join('\n'), 'info');
        return;
      }
      if (action === 'off') {
        hidden = true;
        stopHandles();
        clearWidgets();
        notify(ctx, 'Sentinel observation hidden for this session; no worker was stopped, changed or messaged.', 'info');
        return;
      }
      throw new Error(USAGE);
    } catch (error) {
      notify(ctx, `Sentinel: ${error?.message ?? String(error)}`, 'error');
    }
  }

  if (context?.hasUI && !closed) {
    reconcileTimer = repeat(() => run(false), SENTINEL_RECONCILE_MS);
    reconcileTimer?.unref?.();
    run(false);
  }

  pi.registerCommand('spec-sentinel', {
    description: 'Read-only workspace observation: status | add PATH | inspect ID | off',
    handler,
  });

  return {
    refresh: () => run(false),
    close() {
      if (closed) return;
      closed = true;
      stopHandles();
      clearWidgets();
    },
  };
}

// Repeated verification failures are reduced from decoded tool events and
// retained as compact package-owned incident snapshots. Only digests, counts and
// identifiers are stored; command text, summaries and diffs are never retained.

const VERIFICATION_INCIDENT_KIND = 'repeated-verification-failure';
const INCIDENTS_FILE = 'verification-incidents.json';
const INCIDENTS_MAX_BYTES = 65536;
const MAX_TOOL_CALL_IDS = 8;
// Replay protection is assignment-wide and independent of the bounded display
// history above: IDs are retained as truncated digests so a replayed result can
// never be counted as a new distinct failure after eviction from the display
// window. The cap keeps the worst-case snapshot (20 assignments) inside the
// bounded read; overflowing it marks coverage exhausted instead.
const MAX_REPLAY_IDS = 96;
const replayDigest = id => createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
const MAX_ASSIGNMENTS = 20;
const HASH = /^[a-f0-9]{64}$/;
const isoNow = value => {
  const time = typeof value === 'function' ? value() : value;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const emptySnapshot = packagePath => ({
  version: 1,
  package: packagePath,
  updated_at: null,
  assignments: {},
});

const validHashes = fingerprint => fingerprint && fingerprint.version === 1 && fingerprint.complete === true
  && HASH.test(fingerprint.command_sha256) && HASH.test(fingerprint.summary_sha256) && HASH.test(fingerprint.tree_digest)
  && Number.isInteger(fingerprint.exit_code) && fingerprint.exit_code !== 0;

const fingerprintKey = fingerprint => `${fingerprint.command_sha256}:${fingerprint.summary_sha256}:${fingerprint.tree_digest}`;

// At most 20 assignment entries: oldest non-open work is forgotten first.
function pruneAssignments(assignments) {
  const keys = Object.keys(assignments);
  if (keys.length <= MAX_ASSIGNMENTS) return assignments;
  const oldest = list => list.sort((a, b) => String(assignments[a].observed_at ?? '').localeCompare(String(assignments[b].observed_at ?? '')));
  const removable = oldest(keys.filter(key => assignments[key].state !== 'open'));
  for (const key of removable) {
    delete assignments[key];
    if (Object.keys(assignments).length <= MAX_ASSIGNMENTS) return assignments;
  }
  for (const key of oldest(Object.keys(assignments))) {
    delete assignments[key];
    if (Object.keys(assignments).length <= MAX_ASSIGNMENTS) break;
  }
  return assignments;
}

// The recorder runs inside the runtime event seam: only a completed spec_verify
// result for a known package/assignment is ever relevant. Shared by the reducer
// and the recorder so irrelevant events are filtered before storage access.
function verificationEventSubject({ record, event } = {}) {
  if (!event || event.type !== 'tool_execution_end' || event.toolName !== 'spec_verify'
      || typeof event.toolCallId !== 'string' || !event.toolCallId) return null;
  const packagePath = record?.package;
  const assignment = record?.assignment_id ?? record?.id;
  if (typeof packagePath !== 'string' || typeof assignment !== 'string' || !assignment) return null;
  return { packagePath, assignment };
}

// Only completed spec_verify results reduce; every other decoded event leaves
// the snapshot reference untouched.
export function reduceVerificationResult(snapshot, { record, event }, now = Date.now) {
  const subject = verificationEventSubject({ record, event });
  if (!subject) return { snapshot, incident: null };
  const { packagePath, assignment } = subject;
  const observedAt = isoNow(now);
  const state = snapshot && snapshot.version === 1 && typeof snapshot.package === 'string'
    ? { ...snapshot, assignments: { ...snapshot.assignments } }
    : emptySnapshot(packagePath);
  state.package = packagePath;
  const previous = state.assignments[assignment] ?? {
    assignment_id: assignment, checkout: typeof record?.checkout === 'string' ? record.checkout : null,
    count: 0, fingerprint: null, tool_call_ids: [], replay_ids: [], replay_exhausted: false,
    state: 'idle', generation: 0, incident_id: null, linked_from: null,
    incident_fingerprint: null, observed_at: observedAt,
  };
  // Assignment-wide replay protection, seeded from the display window for
  // snapshots written before the digest set existed.
  const replayIds = Array.isArray(previous.replay_ids) ? [...previous.replay_ids]
    : previous.tool_call_ids.map(id => replayDigest(id));
  const digest = replayDigest(event.toolCallId);
  if (replayIds.includes(digest)) return { snapshot, incident: null };
  replayIds.push(digest);
  let replayExhausted = previous.replay_exhausted === true;
  if (replayIds.length > MAX_REPLAY_IDS) {
    replayIds.splice(0, replayIds.length - MAX_REPLAY_IDS);
    // Deduplication coverage is exhausted: forgotten IDs can no longer be
    // distinguished from genuinely new results, so this assignment is
    // permanently ineligible to open further incident generations.
    replayExhausted = true;
  }

  const entry = { ...previous, replay_ids: replayIds, replay_exhausted: replayExhausted,
    tool_call_ids: [...previous.tool_call_ids, event.toolCallId].slice(-MAX_TOOL_CALL_IDS), observed_at: observedAt };
  const details = event.result?.details;
  const failure = details?.sentinel_failure;
  const outcome = validHashes(failure) ? 'failure'
    : details?.exit_code === 0 && !details.error && event.isError !== true ? 'success' : 'unknown';
  let incident = null;

  if (outcome === 'success') {
    entry.count = 0;
    entry.fingerprint = null;
    if (entry.state === 'open') entry.state = 'resolved';
    else if (entry.state !== 'resolved') entry.state = 'idle';
  } else if (outcome === 'failure') {
    const fingerprint = { command_sha256: failure.command_sha256, summary_sha256: failure.summary_sha256, tree_digest: failure.tree_digest };
    const unchanged = previous.fingerprint && fingerprintKey(previous.fingerprint) === fingerprintKey(fingerprint);
    entry.fingerprint = fingerprint;
    entry.count = unchanged ? previous.count + 1 : 1;
    entry.state = entry.state === 'open' ? 'open' : 'counting';
    const incidentMatches = entry.state === 'open' && entry.incident_fingerprint
      && fingerprintKey(entry.incident_fingerprint) === fingerprintKey(fingerprint);
    if (entry.count >= 3 && !incidentMatches && !entry.replay_exhausted) {
      // A third matching failure opens one incident for this fingerprint
      // generation; the previous incident remains linked history. Exhausted
      // replay coverage never manufactures a new generation.
      const linked = entry.incident_id;
      entry.generation = previous.generation + 1;
      entry.linked_from = linked;
      entry.incident_id = createHash('sha256')
        .update(`${packagePath}\u0000${assignment}\u0000${VERIFICATION_INCIDENT_KIND}\u0000${fingerprintKey(fingerprint)}\u0000${entry.generation}`)
        .digest('hex').slice(0, 32);
      entry.state = 'open';
      entry.incident_fingerprint = fingerprint;
      incident = {
        id: entry.incident_id,
        kind: VERIFICATION_INCIDENT_KIND,
        assignment_id: assignment,
        package: packagePath,
        generation: entry.generation,
        linked_from: entry.linked_from,
        ...fingerprint,
        count: entry.count,
        tool_call_ids: [...entry.tool_call_ids],
        observed_at: observedAt,
      };
    }
  } else {
    // Incomplete evidence never resolves an open incident.
    entry.count = 0;
    entry.fingerprint = null;
    if (entry.state !== 'open' && entry.state !== 'resolved') entry.state = 'idle';
  }

  state.assignments[assignment] = entry;
  pruneAssignments(state.assignments);
  state.updated_at = observedAt;
  return { snapshot: state, incident };
}

export function verificationIncidentsPath(packagePath) {
  return join(packagePath, 'runtime', 'sentinel', INCIDENTS_FILE);
}

// Nonregular and symlinked sources are rejected before opening: a FIFO or
// socket at the snapshot path must never reach a blocking open that freezes
// the runtime event seam, and a symlink must not be followed outside the
// package. The opened descriptor is validated itself and the bytes actually
// read are bounded.
export function readVerificationIncidents(packagePath) {
  let fd;
  try {
    // Resolve runtime/sentinel without following a symlinked or escaping
    // component.
    const directory = validatedStateDirectory(packagePath, ['runtime', 'sentinel']);
    if (!directory) return null;
    const file = join(directory, INCIDENTS_FILE);
    let info;
    try { info = lstatSync(file); } catch { return null; }
    if (!info.isFile()) return null;
    fd = openSync(file, 'r');
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > INCIDENTS_MAX_BYTES) return null;
    const buffer = Buffer.alloc(INCIDENTS_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytes = readSync(fd, buffer, total, buffer.length - total, null);
      if (bytes === 0) break;
      total += bytes;
    }
    if (total > INCIDENTS_MAX_BYTES) return null;
    const value = JSON.parse(buffer.toString('utf8', 0, total));
    return value && value.version === 1 && value.package === packagePath && value.assignments
      && typeof value.assignments === 'object' ? value : null;
  } catch { return null; } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* Closing is best effort. */ } }
  }
}

export function writeVerificationIncidents(packagePath, snapshot) {
  // Create/validate runtime/sentinel component-by-component so publication
  // cannot follow a symlinked ancestor outside the canonical package, and
  // refuse a nonregular destination rather than replacing it.
  const directory = ensureStateDirectory(packagePath, ['runtime', 'sentinel'], 'sentinel incident state directory');
  const file = join(directory, INCIDENTS_FILE);
  let info;
  try { info = lstatSync(file); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (info && !info.isFile()) throw new Error(`verification incident snapshot must be a regular non-symlink file: ${file}`);
  const payload = `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(payload) > INCIDENTS_MAX_BYTES) throw new Error(`verification incident snapshot exceeds ${INCIDENTS_MAX_BYTES} bytes`);
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, payload, { mode: 0o600 });
  renameSync(temp, file);
}

// The recorder is the only writer; a read/write failure degrades observation and
// never propagates into the runtime's event callback.
export function createVerificationRecorder({ now = Date.now, read = readVerificationIncidents, write = writeVerificationIncidents } = {}) {
  return {
    observe(record, event) {
      try {
        // Irrelevant events are filtered before any storage access: the
        // recorder must not add I/O — or a hostile blocking source — to
        // ordinary decoded events.
        if (!verificationEventSubject({ record, event })) return null;
        const current = read(record.package) ?? emptySnapshot(record.package);
        const result = reduceVerificationResult(current, { record, event }, now);
        if (result.snapshot !== current) write(record.package, result.snapshot);
        return result;
      } catch { return null; }
    },
  };
}

// ---------------------------------------------------------------------------
// Coordinator checkpoint persistence and inbox guard (AC-7, AC-8).
//
// recordCheckpoint is the only writer of runtime/sentinel/<workflow-id>/checkpoint.json.
// It binds one workflow exclusively to a coordinator session + checkout, enforces
// optimistic revision concurrency, validates prepared contract artifacts and derives a
// stable obligation_revision from workflow ID + obligation key alone. readInboxGuard
// projects the existing overseer inbox/processed originals into a bounded typed view
// and never moves, edits or archives files. Neither grants recovery authority.
// ---------------------------------------------------------------------------

const CHECKPOINT_STATES = new Set([
  'ready', 'waiting-worker', 'waiting-external', 'decision-required', 'blocked', 'user-held', 'complete', 'unknown',
]);
const WORKER_STATES = new Set([
  'ready', 'working', 'waiting-external', 'decision-required', 'blocked', 'user-held', 'complete', 'failed', 'aborted', 'cancelled', 'unknown',
]);
const INBOX_OUTCOMES = new Set(['applied', 'not-applicable', 'held', 'decision-required', 'needs-spec-correction']);
const ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_SHAPE = /^[a-f0-9]{64}$/;
const KEY_MAX = 160;
const SUMMARY_MAX = 160;
const MAX_ARTIFACTS = 32;
const MAX_WORKERS = 32;
const ARTIFACT_BYTES = 64 * 1024;
const ARTIFACT_TOTAL_BYTES = 1024 * 1024;
const INBOX_MAX_FILES = 200;
const INBOX_FILE_BYTES = 32 * 1024;
const INBOX_TOTAL_BYTES = 1024 * 1024;

// Errors are plain, actionable and never swallow the reason into a vague guard.
class CheckpointError extends Error {
  constructor(message, code = 'checkpoint-invalid') {
    super(message);
    this.name = 'CheckpointError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new CheckpointError(message, code);
};

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// A bounded, non-symlink path inside a root. Rejects traversal and symlinked
// ancestors/targets; returns the real path once validated.
function containedPath(root, candidate, label) {
  const rootReal = realpathSync(root);
  const target = resolve(root, String(candidate));
  const rel = relative(rootReal, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail(`${label} must stay inside the canonical package: ${candidate}`);
  // Reject a symlink at any component of the target and its ancestors up to root.
  let cursor = target;
  while (true) {
    let info;
    try { info = lstatSync(cursor); } catch (error) { fail(`${label} is unreadable: ${candidate} (${error?.code ?? 'error'})`, 'checkpoint-unreadable'); }
    if (info.isSymbolicLink()) fail(`${label} must be a regular non-symlink file: ${candidate}`, 'checkpoint-symlink');
    const parent = dirname(cursor);
    if (resolve(parent) === resolve(rootReal)) break;
    if (resolve(parent) === resolve(cursor)) fail(`${label} escapes the canonical package: ${candidate}`);
    cursor = parent;
  }
  return target;
}

const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex');

const obligationRevision = (workflowId, key) => createHash('sha256')
  .update(`${workflowId}\u0000${String(key)}`).digest('hex').slice(0, 32);

function validateId(value, label) {
  if (typeof value !== 'string' || !ID_SHAPE.test(value)) fail(`${label} must be 1-128 ASCII letters/digits/underscore/hyphen: ${value}`);
  return value;
}

function validateHash(value, label) {
  if (typeof value !== 'string' || !HASH_SHAPE.test(value)) fail(`${label} must be a 64-hex sha256: ${value}`);
  return value;
}

function validateObligation(obligation) {
  if (!isPlainObject(obligation)) fail('obligation must be an object');
  const { key, stage, step, summary, artifacts } = obligation;
  if (typeof key !== 'string' || !key || key.length > KEY_MAX) fail(`obligation.key must be 1-${KEY_MAX} characters`);
  if (typeof stage !== 'string' || !stage) fail('obligation.stage is required');
  if (step !== undefined && (typeof step !== 'string' || !step)) fail('obligation.step must be a non-empty string when present');
  if (typeof summary !== 'string' || !summary || summary.length > SUMMARY_MAX) fail(`obligation.summary must be 1-${SUMMARY_MAX} characters`);
  const list = Array.isArray(artifacts) ? artifacts : [];
  if (list.length > MAX_ARTIFACTS) fail(`obligation.artifacts exceeds ${MAX_ARTIFACTS}`);
  return { key, stage, ...(step === undefined ? {} : { step }), summary, artifacts: list };
}

function validateWorkers(workers) {
  const list = Array.isArray(workers) ? workers : [];
  if (list.length > MAX_WORKERS) fail(`workers exceeds ${MAX_WORKERS}`);
  return list.map((worker, index) => {
    if (!isPlainObject(worker)) fail(`workers[${index}] must be an object`);
    validateId(worker.id, `workers[${index}].id`);
    if (typeof worker.kind !== 'string' || !worker.kind) fail(`workers[${index}].kind is required`);
    if (!WORKER_STATES.has(worker.state)) fail(`workers[${index}].state is unrecognized: ${worker.state}`);
    return { id: worker.id, kind: worker.kind, state: worker.state };
  });
}

function validateInboxItems(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length > INBOX_MAX_FILES) fail(`inbox.items exceeds ${INBOX_MAX_FILES}`);
  return list.map((item, index) => {
    if (!isPlainObject(item)) fail(`inbox.items[${index}] must be an object`);
    validateId(item.id, `inbox.items[${index}].id`);
    validateHash(item.sha256, `inbox.items[${index}].sha256`);
    if (!INBOX_OUTCOMES.has(item.outcome)) fail(`inbox.items[${index}].outcome is unrecognized: ${item.outcome}`);
    const entry = { id: item.id, sha256: item.sha256, outcome: item.outcome };
    if (item.release_source_id !== undefined) entry.release_source_id = validateId(item.release_source_id, `inbox.items[${index}].release_source_id`);
    return entry;
  });
}

// Validate prepared artifacts against real canonical files: package-contained,
// regular non-symlink, exact sha256, bounded per file and total. Refuses without
// claiming reconciliation.
function validateArtifacts(packagePath, artifacts) {
  let total = 0;
  return artifacts.map((artifact, index) => {
    if (!isPlainObject(artifact)) fail(`obligation.artifacts[${index}] must be an object`);
    validateHash(artifact.sha256, `obligation.artifacts[${index}].sha256`);
    const file = containedPath(packagePath, artifact.path, `obligation.artifacts[${index}].path`);
    let info;
    try { info = statSync(file); } catch (error) { fail(`obligation.artifacts[${index}].path is unreadable: ${artifact.path} (${error?.code ?? 'error'})`, 'checkpoint-unreadable'); }
    if (!info.isFile()) fail(`obligation.artifacts[${index}].path must be a regular file: ${artifact.path}`, 'checkpoint-artifact');
    if (info.size > ARTIFACT_BYTES) fail(`obligation.artifacts[${index}] exceeds ${ARTIFACT_BYTES} bytes (${info.size}); use a compact ledger excerpt or source receipt`, 'checkpoint-oversize');
    total += info.size;
    if (total > ARTIFACT_TOTAL_BYTES) fail(`obligation.artifacts total exceeds ${ARTIFACT_TOTAL_BYTES} bytes`, 'checkpoint-oversize');
    const actual = sha256File(file);
    if (actual !== artifact.sha256) fail(`obligation.artifacts[${index}] sha256 mismatch for ${artifact.path}: expected ${artifact.sha256}, got ${actual}`, 'checkpoint-hash-mismatch');
    return { path: artifact.path, sha256: artifact.sha256 };
  });
}

// Durable same-directory temporary + fsync + link/rename-no-replace publication.
// Fails closed on any storage error. Exclusive mode hard-links the temp into
// place so a concurrent first registration cannot be overwritten; update mode
// atomically replaces only the writer's own validated record.
function publishDurable(file, value, { exclusive = false, directory } = {}) {
  // Checkpoint callers pass a directory already validated component-by-component
  // by ensureCheckpointDirectory so publication cannot follow a symlinked state
  // ancestor. Only an unguarded caller falls back to recursive creation.
  const target = directory ?? dirname(file);
  if (!directory) mkdirSync(target, { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (exclusive) {
      linkSync(temp, file); // fails EEXIST if the owner record already exists
      unlinkSync(temp);
    } else {
      renameSync(temp, file);
    }
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    if (exclusive && error?.code === 'EEXIST') fail(`workflow owner record already exists: ${file}`, 'owner-conflict');
    fail(`checkpoint publication failed: ${error?.message ?? error}`, 'checkpoint-storage');
  }
  const dirFd = openSync(target, 'r');
  try { fsyncSync(dirFd); } catch { /* parent fsync is best effort on some FS */ } finally { closeSync(dirFd); }
}

// Read-side guard: resolve state components without following a symlink at
// any component. Returns the validated directory or null when a component is
// absent, non-directory, symlinked or resolves outside the package.
function validatedStateDirectory(packagePath, components) {
  let root;
  try { root = realpathSync(packagePath); } catch { return null; }
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let info;
    try { info = lstatSync(current); } catch { return null; }
    if (info.isSymbolicLink() || !info.isDirectory()) return null;
    let real;
    try { real = realpathSync(current); } catch { return null; }
    if (real !== current) return null;
  }
  return current;
}

function validatedCheckpointDirectory(packagePath, workflowId) {
  return validatedStateDirectory(packagePath, ['runtime', 'sentinel', workflowId]);
}

// Write-side guard shared by checkpoint and incident publication: create
// missing state components one at a time and refuse a symlinked,
// non-directory or escaping component before a temp file is opened. Only the
// sentinel-owned subdirectories are created 0700.
function ensureStateDirectory(packagePath, components, label = 'checkpoint state directory') {
  const root = realpathSync(packagePath);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let info = null;
    try { info = lstatSync(current); }
    catch (error) {
      if (error?.code !== 'ENOENT') fail(`${label} is unreadable: ${component} (${error?.code ?? 'error'})`, 'checkpoint-storage');
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') fail(`${label} could not be created: ${component} (${mkdirError?.code ?? 'error'})`, 'checkpoint-storage');
      }
      try { info = lstatSync(current); }
      catch (readError) { fail(`${label} is unavailable: ${component} (${readError?.code ?? 'error'})`, 'checkpoint-storage'); }
    }
    if (info.isSymbolicLink()) fail(`${label} must not be a symlink: ${component}`, 'checkpoint-symlink');
    if (!info.isDirectory()) fail(`${label} must be a directory: ${component}`, 'checkpoint-storage');
    let real;
    try { real = realpathSync(current); } catch (error) { fail(`${label} is unreadable: ${component} (${error?.code ?? 'error'})`, 'checkpoint-storage'); }
    if (real !== current) fail(`${label} escapes the canonical package: ${component}`, 'checkpoint-storage');
  }
  return current;
}

function ensureCheckpointDirectory(packagePath, workflowId) {
  return ensureStateDirectory(packagePath, ['runtime', 'sentinel', workflowId]);
}

export function checkpointPath(packagePath, workflowId) {
  // Validate before any path construction so a traversal/malformed ID cannot
  // address another workflow's stored record.
  validateId(workflowId, 'workflow_id');
  return join(packagePath, 'runtime', 'sentinel', workflowId, 'checkpoint.json');
}

function readCheckpointRecord(packagePath, workflowId) {
  const file = checkpointPath(packagePath, workflowId);
  try {
    // A symlinked or escaping state ancestor is unavailable: never follow it to
    // read another path.
    const directory = validatedCheckpointDirectory(packagePath, workflowId);
    if (!directory) return null;
    const target = join(directory, basename(file));
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    if (info.size > ARTIFACT_TOTAL_BYTES) return null;
    const value = JSON.parse(readFileSync(target, 'utf8'));
    return isPlainObject(value) && value.version === 1 && value.workflow_id === workflowId ? value : null;
  } catch { return null; }
}

// Exported for the reconcile owner (and tests) to read a stored checkpoint
// without granting any write or recovery authority.
export { readCheckpointRecord };

// The checkpoint tool contract. `package` must be a canonical package (or its
// spec.md); `coordinatorSession`/`checkout` bind one workflow exclusively.
// `reconcilesInputRevision` is the input revision being acknowledged.
export function recordCheckpoint({
  package: packageInput,
  workflow_id: workflowId,
  expected_revision: expectedRevision,
  state,
  obligation,
  workers = [],
  inbox = {},
  reconciles_input_revision: reconcilesInputRevision = 0,
  coordinator_session: coordinatorSession,
  checkout,
  now = Date.now,
} = {}) {
  const canonical = canonicalPackage(packageInput);
  const packagePath = canonical.packagePath;
  validateId(workflowId, 'workflow_id');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) fail('expected_revision must be a non-negative integer');
  if (!CHECKPOINT_STATES.has(state)) fail(`state is unrecognized: ${state}`);
  if (typeof coordinatorSession !== 'string' || !coordinatorSession) fail('coordinator_session is required');
  const checkoutPath = checkout == null ? null : resolve(checkout);
  if (!Number.isInteger(reconcilesInputRevision) || reconcilesInputRevision < 0) fail('reconciles_input_revision must be a non-negative integer');
  const reconciledInput = reconcilesInputRevision;

  const preparedObligation = validateObligation(obligation);
  const preparedWorkers = validateWorkers(workers);
  const preparedItems = validateInboxItems(inbox?.items ?? []);
  // Artifact/hash validation happens before any owner/revision mutation so a
  // refused checkpoint never touches the stored record.
  const preparedArtifacts = validateArtifacts(packagePath, preparedObligation.artifacts);

  const existing = readCheckpointRecord(packagePath, workflowId);
  const file = checkpointPath(packagePath, workflowId);

  if (existing) {
    // Exclusive owner binding: another session or checkout is an owner conflict.
    if (existing.coordinator_session !== coordinatorSession) {
      const error = new CheckpointError(
        `workflow ${workflowId} is bound to coordinator session ${existing.coordinator_session}; a second coordinator cannot overwrite workflow ownership`,
        'owner-conflict');
      throw error;
    }
    if (checkoutPath !== null && existing.checkout !== null && resolve(existing.checkout) !== checkoutPath) {
      throw new CheckpointError(
        `workflow ${workflowId} is bound to checkout ${existing.checkout}; conflicting checkout`,
        'owner-conflict');
    }
    if (existing.revision !== expectedRevision) {
      // Stale revision: fail without mutating the checkpoint.
      throw new CheckpointError(
        `stale expected_revision ${expectedRevision}; current revision is ${existing.revision}`,
        'stale-revision');
    }
  } else if (expectedRevision !== 0) {
    throw new CheckpointError(`first checkpoint for ${workflowId} requires expected_revision 0, got ${expectedRevision}`, 'stale-revision');
  }

  const revision = existing ? existing.revision + 1 : 1;
  const obligationKey = preparedObligation.key;
  const obRevision = obligationRevision(workflowId, obligationKey);
  const retainedItems = new Map();
  // Retain previously observed ID/hash references so removed history cannot
  // release a hold or erase intake evidence.
  for (const prior of existing?.inbox?.items ?? []) {
    if (isPlainObject(prior) && typeof prior.id === 'string') retainedItems.set(prior.id, prior);
  }
  for (const item of preparedItems) {
    const prior = retainedItems.get(item.id);
    // Never overwrite a retained historical hash with a newly supplied
    // conflicting one: keep the old hash as retained history and let the current
    // supplied item project the conflict through readInboxGuard's blocking view.
    if (prior && typeof prior.sha256 === 'string' && prior.sha256 !== item.sha256) continue;
    retainedItems.set(item.id, item);
  }

  // Project the inbox/processed originals against the retained references plus
  // the current supplied items BEFORE publication. A compact guard projection is
  // retained so bad/missing/unprocessed sources visibly block rather than being
  // trusted. This reads only; it never moves files.
  const guard = readInboxGuard(packagePath, { priorItems: [...retainedItems.values()], items: preparedItems, now });
  const inboxGuard = {
    state: guard.state,
    blocking: guard.blocking,
    reasons: [...guard.reasons],
    items: guard.items.map(item => ({ id: item.id, sha256: item.sha256, kind: item.kind,
      directory: item.directory, state: item.state, outcome: item.outcome,
      release_source_id: item.release_source_id, release_source_sha256: item.release_source_sha256 })),
    observed_at: guard.observed_at,
  };

  const record = {
    version: 1,
    workflow_id: workflowId,
    package: packagePath,
    checkout: checkoutPath ?? existing?.checkout ?? null,
    coordinator_session: coordinatorSession,
    revision,
    obligation_revision: obRevision,
    state,
    obligation: {
      key: obligationKey,
      stage: preparedObligation.stage,
      ...(preparedObligation.step === undefined ? {} : { step: preparedObligation.step }),
      summary: preparedObligation.summary,
      artifacts: preparedArtifacts,
    },
    workers: preparedWorkers,
    inbox: { items: [...retainedItems.values()] },
    inbox_guard: inboxGuard,
    input_revision: reconciledInput,
    observed_at: new Date(typeof now === 'function' ? now() : now).toISOString(),
  };

  // Validate/create runtime/sentinel/<workflow-id> component-by-component before
  // any temp file is opened. Exclusive first registration hard-links the record
  // into place so a concurrent writer cannot be overwritten; a stale or
  // conflicting call above never reaches this point.
  const directory = ensureCheckpointDirectory(packagePath, workflowId);
  if (!existing) {
    publishDurable(file, record, { exclusive: true, directory });
    return { ...record, receipt: 'created' };
  }
  publishDurable(file, record, { directory });
  return { ...record, receipt: 'updated' };
}

// Frontmatter identity keys parsed from an overseer original. Only the existing
// simple scalar keys are recognized; duplicate/unsupported identity shapes are
// malformed. `kind: hold` persists; `kind: direction` can reference a hold ID.
const FRONTMATTER_KEYS = new Set(['id', 'run', 'sender', 'audience', 'kind']);

function parseFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { error: 'missing-frontmatter' };
  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) return { error: 'unterminated-frontmatter' };
  const body = normalized.slice(4, end);
  const values = Object.create(null);
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) return { error: 'malformed-frontmatter' };
    const key = match[1];
    const value = match[2].trim();
    if (!FRONTMATTER_KEYS.has(key)) return { error: `unsupported-frontmatter-key:${key}` };
    if (Object.prototype.hasOwnProperty.call(values, key)) return { error: `duplicate-frontmatter-key:${key}` };
    values[key] = value;
  }
  if (!values.id) return { error: 'missing-id' };
  return { values };
}

// Bounded read of complete regular `.md` originals across inbox/processed. Never
// moves, edits or archives anything. Returns a typed guard projection that keeps
// blocking/unknown states for malformed, symlinked, unreadable, missing-history,
// conflicting ID/hash or unprocessed sources. Release requires a later
// `kind: direction` original naming the hold ID plus a coordinator outcome bound
// to both hashes (release_source_id). Verifies references/order/identity only.
export function readInboxGuard(packagePath, { priorItems = [], items = [], now = Date.now } = {}) {
  const reasons = [];
  const sources = [];
  const byId = new Map();
  const prior = new Map();
  for (const item of Array.isArray(priorItems) ? priorItems : []) {
    if (isPlainObject(item) && typeof item.id === 'string') prior.set(item.id, item);
  }
  const outcomes = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (isPlainObject(item) && typeof item.id === 'string') outcomes.set(item.id, item);
  }

  const root = realpathSync(packagePath);
  const readDir = (name) => {
    const dir = join(root, name);
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') return { missing: true, files: [] };
      reasons.push(`${name}-unreadable`);
      return { missing: false, files: [] };
    }
    return { missing: false, files: entries };
  };

  const inbox = readDir('inbox');
  const processed = readDir('processed');
  // An absent inbox is empty only for a newly initialized workflow; losing a
  // previously observed inbox/archive is unknown.
  const sawPrior = priorItems.length > 0;
  if ((inbox.missing || processed.missing) && sawPrior) reasons.push('missing-history');
  if (inbox.missing && processed.missing && !sawPrior) {
    return { state: 'empty', blocking: false, sources: [], items: [], reasons: [], observed_at: new Date(typeof now === 'function' ? now() : now).toISOString() };
  }

  const candidates = [];
  for (const [name, result] of [['inbox', inbox], ['processed', processed]]) {
    if (result.missing) continue;
    for (const entry of result.files) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue; // ignore sibling temp/dirs
      if (!entry.name.endsWith('.md')) continue; // ignore temporary/non-.md files
      candidates.push({ name, entry });
    }
  }
  // Deterministic filename order so projection and hold/release ordering are
  // stable regardless of readdir enumeration order.
  candidates.sort((a, b) => (a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1
    : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (candidates.length > INBOX_MAX_FILES) {
    reasons.push(`inbox-cap:${candidates.length}`);
    candidates.length = INBOX_MAX_FILES;
  }

  let total = 0;
  for (const { name, entry } of candidates) {
    const file = join(root, name, entry.name);
    if (entry.isSymbolicLink()) {
      reasons.push(`symlink:${name}/${entry.name}`);
      sources.push({ path: `${name}/${entry.name}`, state: 'unknown', reason: 'symlink' });
      continue;
    }
    let info;
    try { info = lstatSync(file); } catch (error) {
      reasons.push(`unreadable:${name}/${entry.name}`);
      sources.push({ path: `${name}/${entry.name}`, state: 'unknown', reason: `unreadable:${error?.code ?? 'error'}` });
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > INBOX_FILE_BYTES) {
      reasons.push(`oversize:${name}/${entry.name}`);
      sources.push({ path: `${name}/${entry.name}`, state: 'blocking', reason: 'oversize' });
      continue;
    }
    total += info.size;
    if (total > INBOX_TOTAL_BYTES) {
      reasons.push(`inbox-total-exceeded:${name}/${entry.name}`);
      sources.push({ path: `${name}/${entry.name}`, state: 'blocking', reason: 'total-exceeded' });
      continue;
    }
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (error) {
      reasons.push(`unreadable:${name}/${entry.name}`);
      sources.push({ path: `${name}/${entry.name}`, state: 'unknown', reason: `unreadable:${error?.code ?? 'error'}` });
      continue;
    }
    const parsed = parseFrontmatter(text);
    if (parsed.error) {
      reasons.push(`malformed:${name}/${entry.name}:${parsed.error}`);
      sources.push({ path: `${name}/${entry.name}`, state: 'blocking', reason: parsed.error });
      continue;
    }
    const sha = createHash('sha256').update(text).digest('hex');
    const values = parsed.values;
    // A frontmatter ID that differs from its `<id>.md` filename is malformed
    // identity: the retained reference could not be hash-bound to one original.
    if (values.id !== entry.name.slice(0, -3)) {
      reasons.push(`malformed:${name}/${entry.name}:id-filename-mismatch`);
      sources.push({ path: `${name}/${entry.name}`, state: 'blocking', reason: 'id-filename-mismatch', id: values.id, sha256: sha, kind: values.kind ?? null, directory: name, processed: name === 'processed' });
      continue;
    }
    const record = {
      path: `${name}/${entry.name}`,
      directory: name,
      id: values.id,
      sha256: sha,
      kind: values.kind ?? null,
      run: values.run ?? null,
      sender: values.sender ?? null,
      audience: values.audience ?? null,
      processed: name === 'processed',
      state: 'observed',
    };
    const seen = byId.get(values.id);
    if (seen) {
      // Identical ID/hash is a duplicate; different content under one ID is a
      // conflict. Either way keep the guard blocking/unknown, never resolving.
      if (seen.sha256 !== sha) {
        reasons.push(`conflict:${values.id}`);
        record.state = 'blocking';
        seen.state = 'blocking';
      } else {
        record.state = 'duplicate';
      }
      sources.push(record);
      continue;
    }
    // Conflict against retained history: same ID, different hash.
    const priorItem = prior.get(values.id);
    if (priorItem && priorItem.sha256 !== sha) {
      reasons.push(`conflict:${values.id}`);
      record.state = 'blocking';
    }
    byId.set(values.id, record);
    sources.push(record);
  }

  // Project intake outcomes and holds. Every current/retained source is
  // hash-bound: a supplied outcome must match the observed original's hash, and
  // every processed original needs a recognized matching outcome before it can
  // be nonblocking. Unresolved/unknown evidence fails closed.
  const projected = [];
  for (const record of sources) {
    if (!record.id || record.state === 'duplicate') continue;
    const outcome = outcomes.get(record.id);
    const priorItem = prior.get(record.id);
    let state = record.state;
    if (record.directory === 'inbox') {
      // Every unprocessed original blocks automation.
      state = 'blocking';
    } else if (record.kind === 'hold') {
      // A hold persists after archive until an ordered later direction
      // explicitly names the hold ID and the checkpoint supplies its
      // release_source_id + applied outcome, bound to both hashes.
      state = 'held';
    } else {
      // A processed original is nonblocking only with a recognized outcome whose
      // supplied hash matches the observed source. Missing/mismatched outcome
      // keeps it blocking.
      const bound = outcome && INBOX_OUTCOMES.has(outcome.outcome) && outcome.sha256 === record.sha256;
      state = bound ? record.state : 'blocking';
      if (outcome && (!INBOX_OUTCOMES.has(outcome.outcome) || outcome.sha256 !== record.sha256)) {
        reasons.push(`outcome-mismatch:${record.id}`);
      } else if (!outcome) {
        reasons.push(`outcome-missing:${record.id}`);
      }
    }
    if (outcome && !INBOX_OUTCOMES.has(outcome.outcome)) state = 'blocking';
    // A current outcome hash that disagrees with the observed original is a
    // source-hash mismatch and stays blocking/unknown.
    if (outcome && outcome.sha256 && outcome.sha256 !== record.sha256) {
      reasons.push(`conflict:${record.id}`);
      state = 'blocking';
    }
    projected.push({ ...record, state, outcome: outcome?.outcome ?? null,
      release_source_id: outcome?.release_source_id ?? null,
      release_source_sha256: outcome?.release_source_id ? (byId.get(outcome.release_source_id)?.sha256 ?? null) : null,
      prior: priorItem ?? null });
  }

  // A retained prior ID missing from both directories is unresolved history even
  // when both directories still exist; it can never become healthy.
  for (const [id, priorItem] of prior) {
    if (!byId.has(id)) {
      reasons.push(`missing-history:${id}`);
      projected.push({ id, sha256: priorItem.sha256 ?? null, kind: priorItem.kind ?? null, directory: null,
        processed: true, state: 'blocking', outcome: priorItem.outcome ?? null, release_source_id: null,
        release_source_sha256: null, prior: priorItem, reason: 'missing-history' });
    }
  }

  // Resolve holds against later direction originals and checkpoint release refs.
  // Direction originals are ordered by their timestamp identity (the existing
  // overseer ID), so "later" means a strictly greater message ID.
  const directions = sources
    .filter(record => record.kind === 'direction' && record.id)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const item of projected) {
    if (item.state !== 'held') continue;
    const outcome = outcomes.get(item.id);
    if (!outcome || outcome.outcome !== 'applied' || !outcome.release_source_id) continue;
    const releaseSource = byId.get(outcome.release_source_id);
    if (!releaseSource || releaseSource.kind !== 'direction' || releaseSource.state === 'unknown') continue;
    // The release reference must be an ordered later direction original that
    // explicitly names the held ID. The checkpoint outcome must bind both hashes:
    // the held original's hash (outcome.sha256) and the direction's own supplied
    // hash, and the direction's own supplied outcome/hash must match its observed
    // source too. This verifies references/order/identity only, never the
    // natural-language authority of the sender.
    const releaseOutcome = outcomes.get(releaseSource.id);
    const releaseBound = releaseOutcome && INBOX_OUTCOMES.has(releaseOutcome.outcome)
      && releaseOutcome.sha256 === releaseSource.sha256;
    const ordered = directions.some(direction => direction.id === releaseSource.id
      && direction.sha256 === releaseSource.sha256
      && direction.id > item.id
      && directionIncludesHold(direction, item.id, root));
    if (ordered && releaseBound && outcome.sha256 === item.sha256 && releaseSource.sha256) {
      item.state = 'released';
    }
  }

  const blocking = projected.some(item => item.state === 'blocking' || item.state === 'held')
    || sources.some(source => source.state === 'blocking' || source.state === 'unknown')
    || reasons.length > 0;
  const state = reasons.some(reason => reason.startsWith('unreadable') || reason.startsWith('missing-history') || reason.startsWith('symlink'))
    ? 'unknown'
    : blocking ? 'blocking' : 'healthy';
  return {
    state,
    blocking,
    sources,
    items: projected,
    reasons,
    observed_at: new Date(typeof now === 'function' ? now() : now).toISOString(),
  };
}

// A direction original explicitly names the hold ID in its body text. The
// sentinel checks reference/order/identity only, never natural-language authority.
function directionIncludesHold(direction, holdId, root) {
  try {
    const text = readFileSync(join(root, direction.directory, basename(direction.path)), 'utf8');
    return text.includes(holdId);
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Native input and runtime-return reducers (AC-7/AC-8).
//
// observeInput is a deterministic session-local reducer over host input/UI
// events. reconcileRuntimeReturn is the checkpoint mutation owner for a
// completion already mapped to a workflow. A runtime return is reconciliation
// work, never acceptance: it never writes `complete`.
// ---------------------------------------------------------------------------

// Interactive/RPC input increments a monotonic revision before processing;
// extension input does not. UI prompt start/end maintains a nonnegative active
// prompt depth. Pure and deterministic: state in, state out.
export function observeInput(state = { input_revision: 0, active_prompts: 0 }, event = {}) {
  const current = {
    input_revision: Number.isInteger(state.input_revision) && state.input_revision >= 0 ? state.input_revision : 0,
    active_prompts: Number.isInteger(state.active_prompts) && state.active_prompts >= 0 ? state.active_prompts : 0,
  };
  switch (event.type) {
    case 'input': {
      // Only interactive/RPC sources advance the revision before processing.
      const interactive = event.source === 'interactive' || event.source === 'rpc';
      return interactive ? { ...current, input_revision: current.input_revision + 1 } : current;
    }
    case 'prompt_start':
      return { ...current, active_prompts: current.active_prompts + 1 };
    case 'prompt_end':
      // Depth is nonnegative; an unmatched end clamps at zero rather than going
      // negative (unknown/extra end stays a visible guard, never a phantom wait).
      return { ...current, active_prompts: Math.max(0, current.active_prompts - 1) };
    default:
      return current;
  }
}

// The checkpoint mutation owner for a completion already mapped to a workflow.
// `returnState` is the owner process return already mapped to this workflow
// (e.g. 'completed' | 'failed' | 'aborted' | 'error' | 'cancelled'). Preserves
// checkpoint input/inbox sources and owner/checkout, replaces the obligation with
// a stable `reconcile:<assignment-id>` key and a review/fix-oriented summary,
// never writes `complete`, marks the matching declared worker terminal, and uses
// `ready` only for a completed return (other terminal/error states stay
// blocked/unknown). Ordinary expected-revision checks are preserved.
export function reconcileRuntimeReturn({
  package: packageInput,
  workflow_id: workflowId,
  expected_revision: expectedRevision,
  assignment_id: assignmentId,
  return_state: returnState,
  workers = [],
  reconciles_input_revision: reconcilesInputRevision,
  coordinator_session: coordinatorSession,
  checkout,
  now = Date.now,
} = {}) {
  const canonical = canonicalPackage(packageInput);
  const packagePath = canonical.packagePath;
  validateId(workflowId, 'workflow_id');
  if (typeof assignmentId !== 'string' || !assignmentId) fail('assignment_id is required');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) fail('expected_revision must be a non-negative integer');
  const existing = readCheckpointRecord(packagePath, workflowId);
  if (!existing) throw new CheckpointError(`workflow ${workflowId} has no checkpoint to reconcile`, 'checkpoint-missing');

  // Preserve owner/checkout binding and ordinary expected-revision concurrency.
  if (typeof coordinatorSession !== 'string' || !coordinatorSession || existing.coordinator_session !== coordinatorSession) {
    throw new CheckpointError(
      `workflow ${workflowId} is bound to coordinator session ${existing.coordinator_session}; a runtime return cannot overwrite workflow ownership`,
      'owner-conflict');
  }
  const checkoutPath = checkout == null ? null : resolve(checkout);
  if (checkoutPath !== null && existing.checkout !== null && resolve(existing.checkout) !== checkoutPath) {
    throw new CheckpointError(`workflow ${workflowId} is bound to checkout ${existing.checkout}; conflicting checkout`, 'owner-conflict');
  }
  if (existing.revision !== expectedRevision) {
    throw new CheckpointError(`stale expected_revision ${expectedRevision}; current revision is ${existing.revision}`, 'stale-revision');
  }

  const completed = returnState === 'completed';
  // Never `complete`: reconciliation is pending work even after a successful
  // owner return. `ready` only for a completed return; other terminal/error
  // returns keep a blocked/unknown stop state.
  const state = completed ? 'ready' : (returnState === 'aborted' || returnState === 'error' || returnState === 'failed' ? 'blocked' : 'unknown');
  const key = `reconcile:${assignmentId}`;
  const summary = `Reconcile owner return for ${assignmentId}: verify review/fix duties against the returned work before any acceptance.`;
  const obRevision = obligationRevision(workflowId, key);

  // Mark the matching declared worker terminal; preserve other declared workers.
  const preparedWorkers = validateWorkers(workers);
  const mapped = preparedWorkers.map(worker => worker.id === assignmentId
    ? { ...worker, state: completed ? 'complete' : (returnState === 'cancelled' ? 'cancelled' : 'failed') }
    : worker);

  // Preserve input/inbox sources from the checkpoint unchanged.
  const inputRevision = Number.isInteger(reconcilesInputRevision) && reconcilesInputRevision >= 0
    ? reconcilesInputRevision : (existing.input_revision ?? 0);
  const record = {
    ...existing,
    revision: existing.revision + 1,
    obligation_revision: obRevision,
    state,
    obligation: {
      key,
      stage: 'review',
      summary,
      artifacts: existing.obligation?.artifacts ?? [],
    },
    workers: mapped,
    // inbox + inbox_guard preserved as-is: a runtime return never resolves or
    // erodes intake evidence.
    input_revision: inputRevision,
    observed_at: new Date(typeof now === 'function' ? now() : now).toISOString(),
  };

  const file = checkpointPath(packagePath, workflowId);
  publishDurable(file, record, { directory: ensureCheckpointDirectory(packagePath, workflowId) });
  return { ...record, receipt: 'reconciled' };
}
