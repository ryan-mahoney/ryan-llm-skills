// Session-local workspace observer for the spec sentinel.
//
// Observation is read-only: it collects bounded workspace facts and renders them
// as plain status, and never starts, stops, messages or cancels a worker. Its only
// writes are the explicit enrollment record created by /spec-sentinel add and the
// explicit native policy/authority storage created by /spec-sentinel enable (with
// /spec-sentinel disable revocation), which arms a session-local capability only.

import { watch, mkdirSync, renameSync, readdirSync, writeFileSync, readFileSync, statSync, existsSync, lstatSync, realpathSync, openSync, closeSync, fsyncSync, unlinkSync, linkSync, fstatSync, readSync, opendirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname, sep, relative, isAbsolute, basename } from 'node:path';

import { canonicalPackage } from './runtime.mjs';
import { publicHint } from './monitor.mjs';
import { createOwnedLeaf } from './scout.mjs';
import { collectFacts } from '../../../scripts/jev/core.mjs';
import { collectWorkspace, renderWorkspace, enrollmentDirectory, readEnrollments, enrollmentReasons, SENTINEL_LIMITS } from '../../../scripts/spec-observe/sentinel.mjs';

export const SENTINEL_COALESCE_MS = 250;
export const SENTINEL_RECONCILE_MS = 15000;
export const SENTINEL_WIDGET_KEY = 'spec-sentinel';

const USAGE = 'Usage: /spec-sentinel status | add /absolute/primary | inspect ID | enable /absolute/policy.json | disable | off';
const MAX_WATCHERS = 60;

export function createSentinelObserver({ pi, context, agentDir, scope = null, ownPackages = [], indexDir = join(agentDir, 'spec-runtime'),
  now = Date.now, watchDirectory = watch, setTimer = setTimeout, clearTimer = clearTimeout, repeat = setInterval, cancelRepeat = clearInterval,
  nativeRun = null, maxWatchers = MAX_WATCHERS, enablePolicy = null, disablePolicy: disableAuthority = null }) {
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
      // A replaced or shut-down observer must not retain or re-arm authority.
      if (closed && ['enable', 'disable', 'off', 'add'].includes(action)) {
        notify(ctx, 'Sentinel observer is closed; this command is refused.', 'error');
        return;
      }
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
      if (action === 'enable') {
        const policyPath = rest.join(' ');
        if (!policyPath) throw new Error(USAGE);
        if (!enablePolicy) throw new Error('Sentinel authority is unavailable in this session; only the native coordinator command can arm it.');
        const receipt = await enablePolicy(policyPath, ctx);
        if (receipt?.fenced) {
          notify(ctx, 'Sentinel authority activation completed after a later disable or reload; it was revoked again and stays disarmed. Re-run enable to arm it.', 'warning');
          return;
        }
        const kinds = receipt.actions.filter(kind => kind === 'continue' || kind === 'cancel');
        if (receipt.diagnosis) kinds.push('diagnose');
        notify(ctx, [
          'Sentinel authority armed.',
          `package: ${receipt.package}`,
          `workflow: ${receipt.workflow_id}`,
          `checkout: ${receipt.checkout}`,
          `session: ${receipt.coordinator_session}`,
          `mode: ${receipt.mode}`,
          `kinds: ${kinds.join(', ') || 'none'}`,
          `caps: effects ${receipt.max_effects}, diagnostics ${receipt.max_diagnostics}`,
          `expires: ${receipt.expires_at}`,
          `authority: ${receipt.authority_reference}`,
          `source: ${receipt.source_hash}`,
        ].join('\n'), 'info');
        return;
      }
      if (action === 'disable') {
        if (!disableAuthority) throw new Error('Sentinel authority is unavailable in this session.');
        const result = await disableAuthority(ctx);
        if (result.persisted === false) notify(ctx, `Sentinel authority revoked${result.was_armed ? '' : ' (none was armed)'}, but revocation persistence failed: ${result.error}. Observation remains available.`, 'warning');
        else notify(ctx, result.was_armed ? 'Sentinel authority revoked. Observation remains available.' : 'No live sentinel authority was armed. Observation remains available.', 'info');
        return;
      }
      if (action === 'off') {
        // Revoke the live capability first, then hide observation regardless of
        // whether the revocation persisted, and report both facts.
        let revocation = { revoked: true, persisted: true, was_armed: false };
        if (disableAuthority) {
          try { revocation = await disableAuthority(ctx); }
          catch (error) { revocation = { revoked: false, persisted: false, was_armed: true, error: error?.message ?? String(error) }; }
        }
        hidden = true;
        stopHandles();
        clearWidgets();
        const armed = revocation.was_armed ? 'Sentinel authority revoked' : 'No live sentinel authority was armed';
        const persisted = revocation.persisted === false ? `; revocation persistence failed: ${revocation.error}` : '';
        notify(ctx, `${armed}${persisted}. Sentinel observation hidden for this session; no worker was stopped, changed or messaged.`, revocation.persisted === false ? 'warning' : 'info');
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
    description: 'Sentinel: read-only status/add/inspect plus live-session authority enable/disable/off',
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

const emptySnapshot = (packagePath, workflowId = null) => ({
  version: 1,
  package: packagePath,
  // Workflow binding carried from the runtime record: a workflow-bound
  // failure retains its workflow identity and history. Unbound records stay
  // observation-only in the package-wide snapshot.
  workflow_id: workflowId,
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
  // Workflow identity binds through the runtime record when it has the
  // registered shape; anything else stays unbound legacy observation.
  const workflowId = typeof record?.workflow_id === 'string' && ID_SHAPE.test(record.workflow_id) ? record.workflow_id : null;
  return { packagePath, assignment, workflowId };
}

// Only completed spec_verify results reduce; every other decoded event leaves
// the snapshot reference untouched.
export function reduceVerificationResult(snapshot, { record, event }, now = Date.now) {
  const subject = verificationEventSubject({ record, event });
  if (!subject) return { snapshot, incident: null };
  const { packagePath, assignment, workflowId } = subject;
  const observedAt = isoNow(now);
  const state = snapshot && snapshot.version === 1 && typeof snapshot.package === 'string'
    && (workflowId == null ? snapshot.workflow_id == null : snapshot.workflow_id === workflowId)
    ? { ...snapshot, assignments: { ...snapshot.assignments } }
    : emptySnapshot(packagePath, workflowId);
  state.package = packagePath;
  const previous = state.assignments[assignment] ?? {
    assignment_id: assignment, checkout: typeof record?.checkout === 'string' ? record.checkout : null,
    workflow_id: workflowId,
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
        ...(workflowId ? { workflow_id: workflowId } : {}),
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

export function verificationIncidentsPath(packagePath, workflowId = null) {
  // Workflow-bound snapshots publish inside the workflow's sentinel directory
  // beside its checkpoint; unbound observation stays at the package-wide root.
  return workflowId
    ? join(packagePath, 'runtime', 'sentinel', workflowId, INCIDENTS_FILE)
    : join(packagePath, 'runtime', 'sentinel', INCIDENTS_FILE);
}

// Nonregular and symlinked sources are rejected before opening: a FIFO or
// socket at the snapshot path must never reach a blocking open that freezes
// the runtime event seam, and a symlink must not be followed outside the
// package. The opened descriptor is validated itself and the bytes actually
// read are bounded.
export function readVerificationIncidents(packagePath, workflowId = null) {
  let fd;
  try {
    if (workflowId != null) validateId(workflowId, 'workflow_id');
    // Resolve the state components without following a symlinked or escaping
    // component; a workflow-bound snapshot resolves its workflow directory too.
    const directory = validatedStateDirectory(packagePath, ['runtime', 'sentinel', ...(workflowId ? [workflowId] : [])]);
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
    if (!value || value.version !== 1 || value.package !== packagePath || !value.assignments
      || typeof value.assignments !== 'object') return null;
    // A workflow-scoped snapshot must carry its own binding; a package-wide
    // snapshot stays unbound legacy observation and never speaks for a workflow.
    if (workflowId ? value.workflow_id !== workflowId : value.workflow_id != null) return null;
    return value;
  } catch { return null; } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* Closing is best effort. */ } }
  }
}

export function writeVerificationIncidents(packagePath, snapshot) {
  // Workflow-bound snapshots publish inside the workflow's sentinel directory;
  // unbound observation stays at the package-wide root. Create/validate the
  // components one-by-one so publication cannot follow a symlinked ancestor
  // outside the canonical package, and refuse a nonregular destination rather
  // than replacing it.
  const workflowId = typeof snapshot?.workflow_id === 'string' && ID_SHAPE.test(snapshot.workflow_id) ? snapshot.workflow_id : null;
  const directory = ensureStateDirectory(packagePath, ['runtime', 'sentinel', ...(workflowId ? [workflowId] : [])], 'sentinel incident state directory');
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
        const subject = verificationEventSubject({ record, event });
        if (!subject) return null;
        const current = read(record.package, subject.workflowId) ?? emptySnapshot(record.package, subject.workflowId);
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
// Explicit coordinator stop states a runtime return must never erase (INV-4):
// the terminal worker state and reconcile obligation are recorded, and only a
// successful authorized coordinator checkpoint reconciles the stop. `complete`
// is included so a terminal return can never regress a reconciled checkpoint.
const RECONCILE_PRESERVED_STATES = new Set(['complete', 'user-held', 'waiting-external', 'decision-required', 'blocked']);
const INBOX_OUTCOMES = new Set(['applied', 'not-applicable', 'held', 'decision-required', 'needs-spec-correction']);
// Recognized is not resolved (AC-8): held, decision-required and
// needs-spec-correction are unresolved directions. Only applied or
// not-applicable resolve a processed original, and only `applied` on both the
// hold and its releasing direction can release a hold.
const RESOLVED_INBOX_OUTCOMES = new Set(['applied', 'not-applicable']);
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
// Enumeration is bounded by examined entries, not only selected candidates
// (mirroring the observer's directoryEntryFactor): a mailbox larger than the
// examination ceiling is reported as an incomplete blocking projection
// instead of being visited in full.
const INBOX_EXAMINE_FACTOR = 4;
const INBOX_EXAMINE_MAX = INBOX_MAX_FILES * INBOX_EXAMINE_FACTOR;

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
function publishDurable(file, value, { exclusive = false, directory, requireParentFsync = false } = {}) {
  // Checkpoint callers pass a directory already validated component-by-component
  // by ensureCheckpointDirectory so publication cannot follow a symlinked state
  // ancestor. Only an unguarded caller falls back to recursive creation.
  const target = directory ?? dirname(file);
  if (!directory) mkdirSync(target, { recursive: true, mode: 0o700 });
  // Authority/slot/intent publication refuses a symlinked or nonregular existing
  // destination before replacement; checkpoint behavior is unchanged.
  if (!exclusive && requireParentFsync) {
    try {
      const existing = lstatSync(file);
      if (existing.isSymbolicLink() || !existing.isFile()) fail(`publication destination must be a regular non-symlink file: ${file}`, 'checkpoint-storage');
    } catch (error) {
      if (error instanceof CheckpointError) throw error;
      if (error?.code !== 'ENOENT') fail(`publication destination is unreadable: ${file} (${error?.code ?? 'error'})`, 'checkpoint-storage');
    }
  }
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
  try { fsyncSync(dirFd); } catch (error) {
    if (requireParentFsync) fail(`parent directory fsync failed: ${target} (${error?.message ?? error})`, 'checkpoint-storage');
  } finally { closeSync(dirFd); }
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
      // Durably publish the new directory's name in its parent before any
      // record can be written inside it: a crash must never lose a freshly
      // created authority/reservation directory while an older durable
      // checkpoint survives and later grants fresh capacity. Fails closed.
      try {
        const parentFd = openSync(dirname(current), 'r');
        try { fsyncSync(parentFd); }
        finally { closeSync(parentFd); }
      } catch (syncError) {
        fail(`${label} could not be durably published: ${component} (${syncError?.code ?? syncError?.message ?? 'error'})`, 'checkpoint-storage');
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
  // trusted. This reads only; it never moves files. The prior observed
  // directories are supplied so a lost mailbox is missing-history even when no
  // original was ever retained.
  const guard = readInboxGuard(packagePath, { priorItems: [...retainedItems.values()], items: preparedItems,
    priorDirectories: existing?.inbox?.observed_directories ?? [], now });
  // Retain every observed original's identity/hash independently of supplied
  // coordinator outcomes, and the validly observed mailbox directories: a later
  // checkpoint must still detect a removed original or a lost mailbox through
  // missing-history even when no outcome was ever supplied for it.
  for (const item of guard.items) {
    if (!item?.id || typeof item.sha256 !== 'string' || !item.directory) continue;
    // Never overwrite a retained historical hash: a conflicting observed
    // original projects through the guard's blocking view instead.
    if (retainedItems.has(item.id)) continue;
    retainedItems.set(item.id, { id: item.id, sha256: item.sha256, kind: item.kind ?? null,
      directory: item.directory, outcome: item.outcome ?? null,
      ...(item.release_source_id ? { release_source_id: item.release_source_id } : {}) });
  }
  const observedDirectories = [...new Set([
    ...(Array.isArray(existing?.inbox?.observed_directories)
      ? existing.inbox.observed_directories.filter(name => name === 'inbox' || name === 'processed') : []),
    ...guard.directories,
  ])];
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
    inbox: { items: [...retainedItems.values()], observed_directories: observedDirectories },
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
export function readInboxGuard(packagePath, { priorItems = [], items = [], priorDirectories = [], now = Date.now } = {}) {
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
  // Mailbox directories are validated before enumeration: a symlinked,
  // non-directory or escaping component is unknown/blocking, never followed.
  // Enumeration itself is bounded by examined entries, not only selected
  // candidates: a ceiling that prevents proving completeness is reported as a
  // blocking truncation rather than silently visited in full.
  const readDir = (name) => {
    const dir = join(root, name);
    let info;
    try { info = lstatSync(dir); } catch (error) {
      if (error?.code === 'ENOENT') return { missing: true, files: [], valid: false };
      reasons.push(`${name}-unreadable`);
      return { missing: false, files: [], valid: false };
    }
    if (info.isSymbolicLink()) {
      reasons.push(`symlink:${name}-directory`);
      return { missing: false, files: [], valid: false };
    }
    if (!info.isDirectory()) {
      reasons.push(`nonregular:${name}-directory`);
      return { missing: false, files: [], valid: false };
    }
    let real;
    try { real = realpathSync(dir); } catch {
      reasons.push(`${name}-unreadable`);
      return { missing: false, files: [], valid: false };
    }
    if (real !== dir) {
      reasons.push(`escape:${name}-directory`);
      return { missing: false, files: [], valid: false };
    }
    let handle;
    try { handle = opendirSync(dir); }
    catch (error) {
      if (error?.code === 'ENOENT') return { missing: true, files: [], valid: false };
      reasons.push(`${name}-unreadable`);
      return { missing: false, files: [], valid: false };
    }
    const files = [];
    try {
      while (files.length < INBOX_EXAMINE_MAX) {
        const entry = handle.readSync();
        if (!entry) break;
        files.push(entry);
      }
      if (files.length >= INBOX_EXAMINE_MAX && handle.readSync() !== null) {
        // Completeness can no longer be proven; the projection stays blocking.
        reasons.push(`enumeration-cap:${name}`);
      }
    } catch (error) {
      reasons.push(`${name}-unreadable`);
      return { missing: false, files: [], valid: false };
    } finally {
      try { handle.closeSync(); } catch { /* best effort */ }
    }
    return { missing: false, files, valid: true };
  };

  const inbox = readDir('inbox');
  const processed = readDir('processed');
  // Directories validly observed this pass; retained by recordCheckpoint so a
  // later checkpoint detects a lost mailbox even when no original was retained.
  const directories = [];
  if (inbox.valid) directories.push('inbox');
  if (processed.valid) directories.push('processed');
  // An absent inbox is empty only for a newly initialized workflow; losing a
  // previously observed inbox/archive is unknown.
  const priorDirs = new Set((Array.isArray(priorDirectories) ? priorDirectories : [])
    .filter(name => name === 'inbox' || name === 'processed'));
  const sawPrior = priorItems.length > 0 || priorDirs.size > 0;
  if ((inbox.missing || processed.missing) && sawPrior) reasons.push('missing-history');
  if (inbox.missing && processed.missing && !sawPrior) {
    return { state: 'empty', blocking: false, sources: [], items: [], reasons: [], directories: [], observed_at: new Date(typeof now === 'function' ? now() : now).toISOString() };
  }

  const candidates = [];
  for (const [name, result] of [['inbox', inbox], ['processed', processed]]) {
    if (result.missing) continue;
    for (const entry of result.files) {
      if (entry.isFile() || entry.isSymbolicLink()) {
        if (!entry.name.endsWith('.md')) continue; // ignore temporary/non-.md files
        candidates.push({ name, entry });
        continue;
      }
      // A relevant nonregular .md entry (directory, FIFO, socket) is unknown,
      // never silently ignored; other siblings stay ignorable temporaries.
      if (entry.name.endsWith('.md')) {
        reasons.push(`nonregular:${name}/${entry.name}`);
        sources.push({ path: `${name}/${entry.name}`, state: 'unknown', reason: 'nonregular' });
      }
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
    if (!info.isFile()) {
      reasons.push(`nonregular:${name}/${entry.name}`);
      sources.push({ path: `${name}/${entry.name}`, state: 'unknown', reason: 'nonregular' });
      continue;
    }
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
      // A processed original is nonblocking only with a resolved outcome
      // (applied or not-applicable) whose supplied hash matches the observed
      // source. An unresolved recognized outcome (held, decision-required,
      // needs-spec-correction) keeps it blocking: recognized is not resolved.
      const bound = outcome && RESOLVED_INBOX_OUTCOMES.has(outcome.outcome) && outcome.sha256 === record.sha256;
      state = bound ? record.state : 'blocking';
      if (outcome && !INBOX_OUTCOMES.has(outcome.outcome)) {
        reasons.push(`outcome-mismatch:${record.id}`);
      } else if (outcome && !RESOLVED_INBOX_OUTCOMES.has(outcome.outcome)) {
        reasons.push(`outcome-unresolved:${record.id}`);
      } else if (outcome && outcome.sha256 !== record.sha256) {
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
    // The direction itself must carry an applied, hash-bound outcome: an
    // unresolved or not-applicable direction never releases a hold.
    const releaseBound = releaseOutcome && releaseOutcome.outcome === 'applied'
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
    directories,
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
// never writes `complete`, marks the matching declared worker terminal, uses
// `ready` only for a completed return (other terminal/error states stay
// blocked/unknown), and never clears an explicit coordinator stop state —
// only a successful authorized coordinator checkpoint reconciles those.
// Ordinary expected-revision checks are preserved.
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
  // returns keep a blocked/unknown stop state. An explicit coordinator stop
  // (or an already recorded `complete`) is preserved as-is: a runtime return
  // records the reconciliation obligation and terminal worker state without
  // clearing the stop; only a successful authorized coordinator checkpoint
  // reconciles it.
  const reconciled = completed ? 'ready' : (returnState === 'aborted' || returnState === 'error' || returnState === 'failed' ? 'blocked' : 'unknown');
  const state = RECONCILE_PRESERVED_STATES.has(existing.state) ? existing.state : reconciled;
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

// ---------------------------------------------------------------------------
// Scoped grants and durable intent reservations (AC-9, AC-10, AC-11, AC-17).
//
// createSentinelAuthority returns an opaque, session-local capability. Only the
// live native command handler calling activatePolicy can arm it; a fresh
// authority is disarmed and no disk state reconstructs the capability. Every
// decision re-reads and re-validates the policy source, grant, checkpoint scope
// and expiry. Reservations are fixed per-workflow slots published durably before
// any effect; unfinished, orphaned or malformed state fails closed and spent
// capacity is never reclaimed. No product/model effect lives here.
// ---------------------------------------------------------------------------

const POLICY_MODES = new Set(['shadow', 'recover']);
const POLICY_ACTIONS = new Set(['continue', 'cancel']);
const INTENT_KINDS = new Set(['continue', 'cancel', 'diagnose']);
const FINISH_STATES = new Set(['applied', 'blocked', 'failed', 'unknown']);
const POLICY_BYTES = 16 * 1024;
const AUTHORITY_MAX_EFFECTS = 2;
const AUTHORITY_MAX_DIAGNOSTICS = 2;
const SLOT_POOLS = { continue: 'effect', cancel: 'effect', diagnose: 'diagnostic' };
const POOL_DIRECTORIES = { effect: 'effect-slots', diagnostic: 'diagnostic-slots' };
const POLICY_KEYS = new Set(['version', 'package', 'workflow_id', 'checkout', 'coordinator_session', 'mode',
  'actions', 'expires_at', 'max_effects', 'max_diagnostics', 'diagnosis', 'authority_reference']);
const DIAGNOSIS_KEYS = new Set(['model']);
const AUTHORITY_STATE = Symbol('sentinel-authority-state');

// An opaque capability. The armed flag and policy live only in this private
// symbol slot; nothing exported reconstructs it from disk.
export function createSentinelAuthority() {
  const state = { armed: false, policy: null, policyHash: null, sourcePath: null,
    packagePath: null, workflowId: null, checkout: null, coordinatorSession: null,
    provenance: null, grant: null, activatedAt: null, activationId: null, activationPath: null,
    activationCommand: null, createdIntents: new Set() };
  const authority = {};
  Object.defineProperty(authority, AUTHORITY_STATE, { value: state, enumerable: false });
  return Object.freeze(authority);
}

function authorityState(authority) {
  const state = authority != null ? authority[AUTHORITY_STATE] : undefined;
  if (!state) fail('a live sentinel authority capability is required', 'authority-invalid');
  return state;
}

function readPolicyFile(policyPath) {
  if (typeof policyPath !== 'string' || !isAbsolute(policyPath)) fail('policy path must be absolute', 'policy-invalid');
  let info;
  try { info = lstatSync(policyPath); } catch (error) { fail(`policy source is unreadable: ${policyPath} (${error?.code ?? 'error'})`, 'policy-unreadable'); }
  // A symlink or any nonregular source is refused before opening so a swapped
  // FIFO/socket/symlink is never followed.
  if (!info.isFile()) fail('policy source must be a regular non-symlink file', 'policy-symlink');
  let fd;
  try {
    fd = openSync(policyPath, 'r');
    const opened = fstatSync(fd);
    // The opened descriptor must be the exact same regular file that was lstat'd.
    if (opened.dev !== info.dev || opened.ino !== info.ino) fail('policy source changed between check and open', 'policy-symlink');
    if (!opened.isFile()) fail('policy source must be a regular non-symlink file', 'policy-symlink');
    if (opened.size > POLICY_BYTES) fail(`policy source exceeds ${POLICY_BYTES} bytes`, 'policy-oversize');
    const buffer = Buffer.alloc(POLICY_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytes = readSync(fd, buffer, total, buffer.length - total, null);
      if (bytes === 0) break;
      total += bytes;
    }
    if (total > POLICY_BYTES) fail(`policy source exceeds ${POLICY_BYTES} bytes`, 'policy-oversize');
    const bytes = buffer.subarray(0, total);
    const text = bytes.toString('utf8');
    let value;
    try { value = JSON.parse(text); } catch { fail('policy source must be valid JSON', 'policy-invalid'); }
    // Hash the exact bytes read from the descriptor, not a re-encoded string.
    return { value, hash: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error instanceof CheckpointError) throw error;
    fail(`policy source is unreadable: ${policyPath} (${error?.code ?? 'error'})`, 'policy-unreadable');
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort. */ } }
  }
}

const EXACT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
function parseExactIso(value, label) {
  if (typeof value !== 'string' || !EXACT_ISO.test(value)) fail(`${label} must be an exact ISO 8601 UTC timestamp`, 'policy-invalid');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} must be an exact ISO timestamp`, 'policy-invalid');
  return parsed;
}

const SELECTOR_SHAPE = /^[^\s/]+\/[^\s:]+(?::[^\s]+)?$/;
function validateSelector(value, label) {
  if (typeof value !== 'string' || !value) fail(`${label} is required`, 'policy-invalid');
  if (/[\u0000-\u001f\u007f]/.test(value) || !SELECTOR_SHAPE.test(value)) fail(`${label} must be a provider/model[:thinking] selector with no whitespace or control characters`, 'policy-invalid');
  return value;
}

// Exact SentinelPolicy schema and exact nested diagnosis schema, plus canonical
// identity, expiry, caps and action/diagnosis agreement. Unknown keys/kinds are
// rejected rather than ignored.
function validatePolicy(value, { now } = {}) {
  if (!isPlainObject(value)) fail('policy must be an object', 'policy-invalid');
  for (const key of Object.keys(value)) if (!POLICY_KEYS.has(key)) fail(`policy has an unknown key: ${key}`, 'policy-invalid');
  if (value.version !== 1) fail('policy.version must be 1', 'policy-invalid');
  if (typeof value.package !== 'string' || !value.package) fail('policy.package is required', 'policy-invalid');
  validateId(value.workflow_id, 'policy.workflow_id');
  if (typeof value.checkout !== 'string' || !value.checkout) fail('policy.checkout is required', 'policy-invalid');
  if (typeof value.coordinator_session !== 'string' || !value.coordinator_session) fail('policy.coordinator_session is required', 'policy-invalid');
  if (!POLICY_MODES.has(value.mode)) fail(`policy.mode is unrecognized: ${value.mode}`, 'policy-invalid');
  if (!Array.isArray(value.actions)) fail('policy.actions must be an array', 'policy-invalid');
  const actions = [];
  for (const action of value.actions) {
    if (!POLICY_ACTIONS.has(action)) fail(`policy action is unrecognized: ${action}`, 'policy-invalid');
    if (actions.includes(action)) fail(`policy action is duplicated: ${action}`, 'policy-invalid');
    actions.push(action);
  }
  const nowMs = typeof now === 'function' ? now() : now;
  const expiry = parseExactIso(value.expires_at, 'policy.expires_at');
  if (expiry <= nowMs) fail('policy.expires_at must be in the future', 'policy-expired');
  if (expiry > nowMs + 8 * 60 * 60 * 1000) fail('policy.expires_at must be no later than eight hours', 'policy-invalid');
  if (!Number.isInteger(value.max_effects) || value.max_effects < 0 || value.max_effects > AUTHORITY_MAX_EFFECTS) fail('policy.max_effects must be an integer 0..2', 'policy-invalid');
  if (!Number.isInteger(value.max_diagnostics) || value.max_diagnostics < 0 || value.max_diagnostics > AUTHORITY_MAX_DIAGNOSTICS) fail('policy.max_diagnostics must be an integer 0..2', 'policy-invalid');
  if (typeof value.authority_reference !== 'string' || !value.authority_reference.trim()) fail('policy.authority_reference is required', 'policy-invalid');
  let diagnosis = null;
  if (value.diagnosis !== undefined) {
    if (!isPlainObject(value.diagnosis)) fail('policy.diagnosis must be an object', 'policy-invalid');
    for (const key of Object.keys(value.diagnosis)) if (!DIAGNOSIS_KEYS.has(key)) fail(`policy.diagnosis has an unknown key: ${key}`, 'policy-invalid');
    validateSelector(value.diagnosis.model, 'policy.diagnosis.model');
    if (value.max_diagnostics < 1) fail('a diagnosis configuration requires a nonzero diagnostic budget', 'policy-invalid');
    diagnosis = { model: value.diagnosis.model };
  }
  if (actions.includes('cancel') && !diagnosis) fail('cancel permission requires a diagnosis configuration', 'policy-invalid');
  return { ...value, actions, diagnosis };
}

// One private bounded regular-file descriptor JSON reader for sentinel state.
// lstat + open + fstat identity/type, bounded read, close; a symlinked, replaced
// or nonregular target fails closed instead of being followed.
function readBoundedJsonFile(file, maxBytes = ARTIFACT_TOTAL_BYTES) {
  let fd;
  let info;
  try { info = lstatSync(file); } catch { return null; }
  if (!info.isFile()) return null;
  try {
    fd = openSync(file, 'r');
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytes = readSync(fd, buffer, total, buffer.length - total, null);
      if (bytes === 0) break;
      total += bytes;
    }
    if (total > maxBytes) return null;
    const value = JSON.parse(buffer.toString('utf8', 0, total));
    return isPlainObject(value) ? value : null;
  } catch { return null; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort. */ } } }
}

// Read a stored sentinel JSON record without following a symlinked ancestor.
function readStateJson(packagePath, workflowId, components) {
  const directory = validatedStateDirectory(packagePath, ['runtime', 'sentinel', workflowId, ...components.slice(0, -1)]);
  if (!directory) return null;
  return readBoundedJsonFile(join(directory, components[components.length - 1]));
}

// The immutable activation receipt referenced by the current grant.
function readActivationReceipt(packagePath, workflowId, activationId) {
  if (typeof activationId !== 'string' || !ID_SHAPE.test(activationId)) return null;
  return readStateJson(packagePath, workflowId, ['authority', 'activations', `${activationId}.json`]);
}

// Arm the live capability only after provenance and current grant are durable.
// The authority is the only arming path; disk files never arm it.
export function activatePolicy(authority, {
  policy_path: policyPath,
  coordinator_session: coordinatorSession,
  command,
  now = Date.now,
} = {}) {
  const state = authorityState(authority);
  if (typeof coordinatorSession !== 'string' || !coordinatorSession) fail('coordinator_session is required', 'authority-invalid');
  // Package/workflow/checkout come only from the validated policy file, then the
  // retained checkpoint must match them; caller-supplied scope is never trusted.
  const { value, hash: sourceHash } = readPolicyFile(policyPath);
  const policy = validatePolicy(value, { now });
  const canonical = canonicalPackage(policy.package);
  const packagePath = canonical.packagePath;
  const workflowId = policy.workflow_id;
  if (policy.coordinator_session !== coordinatorSession) fail('policy.coordinator_session does not match the native coordinator session', 'policy-scope');
  const boundCheckout = resolve(policy.checkout);
  const checkpoint = readCheckpointRecord(packagePath, workflowId);
  if (!checkpoint) fail(`workflow ${workflowId} has no retained checkpoint`, 'policy-scope');
  if (checkpoint.package !== packagePath || checkpoint.workflow_id !== workflowId) fail('policy scope does not match the retained checkpoint', 'policy-scope');
  if (checkpoint.coordinator_session !== coordinatorSession) fail('native coordinator session does not match the retained checkpoint', 'policy-scope');
  if (checkpoint.checkout == null || resolve(checkpoint.checkout) !== boundCheckout) fail('policy.checkout does not match the retained checkpoint', 'policy-scope');
  // A re-activation on an already-armed capability may only narrow it: action
  // subset, no cap/expiry/mode expansion; it can never extend the live grant.
  if (state.armed) {
    if (state.packagePath !== packagePath || state.workflowId !== workflowId
      || state.checkout !== boundCheckout || state.coordinatorSession !== coordinatorSession) {
      fail('a re-activation must keep the live authority scope', 'policy-scope');
    }
    const live = state.policy;
    for (const action of policy.actions) if (!live.actions.includes(action)) fail(`a re-activation cannot add action ${action}`, 'policy-narrow');
    if (policy.max_effects > live.max_effects) fail('a re-activation cannot raise the effect cap', 'policy-narrow');
    if (policy.max_diagnostics > live.max_diagnostics) fail('a re-activation cannot raise the diagnostic cap', 'policy-narrow');
    if (parseExactIso(policy.expires_at, 'policy.expires_at') > parseExactIso(live.expires_at, 'policy.expires_at')) fail('a re-activation cannot extend expiry', 'policy-narrow');
    if (live.mode === 'shadow' && policy.mode === 'recover') fail('a re-activation cannot expand shadow observation into recover', 'policy-narrow');
  }
  const activatedAt = new Date(typeof now === 'function' ? now() : now).toISOString();
  const directory = ensureStateDirectory(packagePath, ['runtime', 'sentinel', workflowId, 'authority'], 'sentinel authority directory');
  const activationDirectory = ensureStateDirectory(packagePath, ['runtime', 'sentinel', workflowId, 'authority', 'activations'], 'sentinel activation directory');
  const activationId = randomUUID();
  const activation = { version: 1, activation_id: activationId, workflow_id: workflowId, package: packagePath,
    coordinator_session: coordinatorSession, checkout: boundCheckout, source_path: policyPath, source_hash: sourceHash,
    command: typeof command === 'string' ? command : '', mode: policy.mode, actions: policy.actions,
    max_effects: policy.max_effects, max_diagnostics: policy.max_diagnostics, diagnosis: policy.diagnosis,
    expires_at: policy.expires_at, authority_reference: policy.authority_reference, activated_at: activatedAt };
  // Immutable provenance receipt per activation, referenced by the current grant.
  publishDurable(join(activationDirectory, `${activationId}.json`), activation, { exclusive: true, directory: activationDirectory, requireParentFsync: true });
  const grant = { ...activation, revoked: false, activation_path: `activations/${activationId}.json` };
  publishDurable(join(directory, 'grant.json'), grant, { directory, requireParentFsync: true });
  // Arm only now that durable provenance and grant exist.
  state.armed = true;
  state.policy = policy;
  state.policyHash = sourceHash;
  state.sourcePath = policyPath;
  state.packagePath = packagePath;
  state.workflowId = workflowId;
  state.checkout = boundCheckout;
  state.coordinatorSession = coordinatorSession;
  state.provenance = activation;
  state.grant = grant;
  state.activatedAt = activatedAt;
  state.activationId = activationId;
  state.activationPath = grant.activation_path;
  state.activationCommand = activation.command;
  return { armed: true, activation_id: activationId, mode: policy.mode, actions: policy.actions,
    max_effects: policy.max_effects, max_diagnostics: policy.max_diagnostics, diagnosis: policy.diagnosis,
    expires_at: policy.expires_at, authority_reference: policy.authority_reference, source_hash: sourceHash,
    package: packagePath, workflow_id: workflowId, checkout: boundCheckout, coordinator_session: coordinatorSession };
}

// Revoke live authority synchronously and only then attempt storage. A storage
// failure is surfaced while the capability remains disarmed.
export function disablePolicy(authority, { now = Date.now, reason = 'disabled' } = {}) {
  const state = authorityState(authority);
  const previous = { armed: state.armed, packagePath: state.packagePath, workflowId: state.workflowId, coordinatorSession: state.coordinatorSession };
  state.armed = false;
  state.policy = null;
  state.policyHash = null;
  state.sourcePath = null;
  state.packagePath = null;
  state.workflowId = null;
  state.checkout = null;
  state.coordinatorSession = null;
  state.provenance = null;
  state.grant = null;
  state.activationId = null;
  state.activationPath = null;
  state.activationCommand = null;
  if (!previous.armed || !previous.packagePath || !previous.workflowId) return { armed: false, revoked: true, persisted: true, was_armed: previous.armed };
  try {
    const directory = ensureStateDirectory(previous.packagePath, ['runtime', 'sentinel', previous.workflowId, 'authority'], 'sentinel authority directory');
    const grant = readStateJson(previous.packagePath, previous.workflowId, ['authority', 'grant.json'])
      ?? { version: 1, workflow_id: previous.workflowId, package: previous.packagePath, coordinator_session: previous.coordinatorSession };
    publishDurable(join(directory, 'grant.json'), { ...grant, revoked: true,
      revoked_at: new Date(typeof now === 'function' ? now() : now).toISOString(), reason: String(reason) }, { directory, requireParentFsync: true });
    return { armed: false, revoked: true, persisted: true, was_armed: previous.armed };
  } catch (error) {
    return { armed: false, revoked: true, persisted: false, was_armed: previous.armed, error: error?.message ?? String(error) };
  }
}

// Re-read and re-validate the source/hash, current grant, checkpoint scope and
// expiry. It may only narrow the armed grant or block; it never extends it.
export function readPolicyGuard(authority, { workflow_id: workflowId, now = Date.now } = {}) {
  const state = authorityState(authority);
  if (!state.armed) return { armed: false, state: 'disarmed', blocking: false, allowed: [], reasons: [] };
  try {
    const scoped = workflowId ?? state.workflowId;
    if (!scoped || scoped !== state.workflowId) fail('workflow_id does not match the live authority', 'policy-scope');
    const { value, hash: sourceHash } = readPolicyFile(state.sourcePath);
    if (sourceHash !== state.policyHash) fail('policy source hash changed since activation', 'policy-scope');
    const policy = validatePolicy(value, { now });
    if (canonicalPackage(policy.package).packagePath !== state.packagePath) fail('policy source package changed', 'policy-scope');
    if (policy.workflow_id !== state.workflowId) fail('policy source workflow changed', 'policy-scope');
    if (resolve(policy.checkout) !== state.checkout) fail('policy source checkout changed', 'policy-scope');
    if (policy.coordinator_session !== state.coordinatorSession) fail('policy source session changed', 'policy-scope');
    const grant = readStateJson(state.packagePath, state.workflowId, ['authority', 'grant.json']);
    if (!grant) fail('policy grant receipt is missing', 'policy-revoked');
    if (grant.revoked) fail('policy grant is revoked', 'policy-revoked');
    // Every reread grant field must match the live capability and the source, so
    // tampering blocks rather than being ignored.
    const grantChecks = [['version', 1], ['package', state.packagePath], ['workflow_id', state.workflowId],
      ['checkout', state.checkout], ['coordinator_session', state.coordinatorSession], ['source_hash', sourceHash],
      ['source_path', state.sourcePath], ['mode', state.policy.mode], ['max_effects', state.policy.max_effects],
      ['max_diagnostics', state.policy.max_diagnostics], ['expires_at', state.policy.expires_at],
      ['authority_reference', state.policy.authority_reference], ['activation_id', state.activationId],
      ['activation_path', state.activationPath], ['command', state.activationCommand], ['activated_at', state.activatedAt]];
    for (const [field, expected] of grantChecks) if (grant[field] !== expected) fail(`policy grant ${field} no longer matches the live authority`, 'policy-scope');
    if (JSON.stringify(grant.actions) !== JSON.stringify(state.policy.actions)) fail('policy grant actions no longer match the live authority', 'policy-scope');
    if (JSON.stringify(grant.diagnosis ?? null) !== JSON.stringify(state.policy.diagnosis ?? null)) fail('policy grant diagnosis no longer matches the live authority', 'policy-scope');
    // The immutable activation receipt referenced by the grant must exist and agree.
    const activation = typeof grant.activation_id === 'string' ? readActivationReceipt(state.packagePath, state.workflowId, grant.activation_id) : null;
    if (!activation) fail('policy activation receipt is missing', 'policy-scope');
    const activationChecks = [['version', 1], ['activation_id', grant.activation_id], ['package', state.packagePath],
      ['workflow_id', state.workflowId], ['checkout', state.checkout], ['coordinator_session', state.coordinatorSession],
      ['source_hash', sourceHash], ['source_path', state.sourcePath], ['mode', state.policy.mode],
      ['max_effects', state.policy.max_effects], ['max_diagnostics', state.policy.max_diagnostics],
      ['expires_at', state.policy.expires_at], ['authority_reference', state.policy.authority_reference],
      ['command', state.activationCommand], ['activated_at', state.activatedAt]];
    for (const [field, expected] of activationChecks) if (activation[field] !== expected) fail(`policy activation ${field} no longer matches the live authority`, 'policy-scope');
    if (JSON.stringify(activation.actions) !== JSON.stringify(state.policy.actions)) fail('policy activation actions no longer match the live authority', 'policy-scope');
    if (JSON.stringify(activation.diagnosis ?? null) !== JSON.stringify(state.policy.diagnosis ?? null)) fail('policy activation diagnosis no longer matches the live authority', 'policy-scope');
    const checkpoint = readCheckpointRecord(state.packagePath, state.workflowId);
    if (!checkpoint || checkpoint.package !== state.packagePath || checkpoint.workflow_id !== state.workflowId
      || checkpoint.coordinator_session !== state.coordinatorSession
      || checkpoint.checkout == null || resolve(checkpoint.checkout) !== state.checkout) {
      fail('retained checkpoint scope no longer matches the live authority', 'policy-scope');
    }
    return { armed: true, state: 'ready', blocking: false, mode: state.policy.mode,
      allowed: policy.actions.filter(action => state.policy.actions.includes(action)),
      max_effects: Math.min(policy.max_effects, state.policy.max_effects),
      max_diagnostics: Math.min(policy.max_diagnostics, state.policy.max_diagnostics),
      diagnosis: state.policy.diagnosis, expires_at: policy.expires_at, policy_hash: sourceHash, reasons: [] };
  } catch (error) {
    return { armed: true, state: 'blocked', blocking: true, allowed: [],
      reasons: [error?.message ?? String(error)], code: error?.code ?? 'policy-invalid' };
  }
}

const INTENT_STATES = new Set(['accepted', 'requested', 'applied', 'blocked', 'failed', 'unknown']);
const INTENT_KEYS = new Set(['version', 'id', 'workflow_id', 'package', 'coordinator_session', 'kind', 'subject_key',
  'source_revision', 'policy_hash', 'reserved_at', 'state', 'reason_code', 'result_reference']);
function readIntentRecord(packagePath, workflowId, intentId) {
  const directory = validatedStateDirectory(packagePath, ['runtime', 'sentinel', workflowId, 'intents']);
  if (!directory) return null;
  const value = readBoundedJsonFile(join(directory, `${intentId}.json`));
  if (!value || value.version !== 1 || value.workflow_id !== workflowId || value.id !== intentId) return null;
  // Exact fixed Intent keys only; implementation-only fields make the record malformed.
  for (const key of Object.keys(value)) if (!INTENT_KEYS.has(key)) return null;
  for (const key of INTENT_KEYS) if (key !== 'result_reference' && !(key in value)) return null;
  if (!INTENT_KINDS.has(value.kind) || !INTENT_STATES.has(value.state)) return null;
  if (typeof value.subject_key !== 'string' || typeof value.source_revision !== 'string'
    || typeof value.policy_hash !== 'string' || typeof value.reserved_at !== 'string'
    || typeof value.reason_code !== 'string' || typeof value.coordinator_session !== 'string') return null;
  return value;
}

// Conservative reservation read: malformed/orphan slots, unreadable intents,
// unknown outcomes and retained accepted/requested intents not created by the
// live authority all block and stay spent. Never reclaims capacity.
const INTENT_ENUM_MAX = 64;
// Bounded intent-directory enumeration: completeness is never proven past the cap.
function readIntentsBounded(directory) {
  const names = [];
  let handle;
  try { handle = opendirSync(directory); } catch { return { names, truncated: true }; }
  try {
    while (names.length < INTENT_ENUM_MAX) {
      const entry = handle.readSync();
      if (!entry) break;
      names.push(entry.name);
    }
    return { names, truncated: names.length >= INTENT_ENUM_MAX && handle.readSync() !== null };
  } catch { return { names, truncated: true }; }
  finally { try { handle.closeSync(); } catch { /* best effort. */ } }
}

// Resolve one reservation state directory, distinguishing a legitimately
// absent initial directory (nothing has been retained yet) from an invalid,
// symlinked, non-directory or unreadable one: absence alone never blocks a
// first reservation, while invalid retained state blocks reservations in
// either pool (AC-11).
function resolveReservationDirectory(packagePath, workflowId, leaf) {
  let root;
  try { root = realpathSync(packagePath); } catch { return { status: 'invalid', directory: null }; }
  let current = root;
  for (const component of ['runtime', 'sentinel', workflowId, leaf]) {
    current = join(current, component);
    let info;
    try { info = lstatSync(current); } catch (error) {
      return { status: error?.code === 'ENOENT' ? 'absent' : 'invalid', directory: null };
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return { status: 'invalid', directory: null };
    try { if (realpathSync(current) !== current) return { status: 'invalid', directory: null }; }
    catch { return { status: 'invalid', directory: null }; }
  }
  return { status: 'ok', directory: current };
}

// Conservative reservation read: malformed/orphan slots, unreadable intents,
// cross-link disagreement, an unresolved unknown outcome and retained
// accepted/requested intents not created by the live authority all block and
// stay spent. The intent/slot graph is validated in both directions and
// capacity is never reclaimed.
function readReservationState(packagePath, workflowId, liveIntentIds) {
  const result = { blocking: false, reasons: [], spent: { effect: 0, diagnostic: 0 }, slotted: new Set(), intentSlots: new Map(), slotCounts: new Map(), lastDiagnosticAt: null };
  const push = reason => { if (!result.reasons.includes(reason)) result.reasons.push(reason); };
  const enumerated = new Set();
  const intents = resolveReservationDirectory(packagePath, workflowId, 'intents');
  if (intents.status === 'invalid') {
    result.blocking = true; push('intent-state-invalid');
  } else if (intents.status === 'ok') {
    const { names, truncated } = readIntentsBounded(intents.directory);
    if (truncated) { result.blocking = true; push('intent-enumeration-cap'); }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      const intent = readIntentRecord(packagePath, workflowId, id);
      if (!intent) { result.blocking = true; push(`intent-malformed:${id}`); continue; }
      const pool = SLOT_POOLS[intent.kind];
      if (!pool) { result.blocking = true; push(`intent-unrecognized:${id}`); continue; }
      result.spent[pool] += 1;
      enumerated.add(intent.id);
      if (pool === 'diagnostic') {
        const at = Date.parse(intent.reserved_at);
        if (Number.isFinite(at) && (result.lastDiagnosticAt == null || at > result.lastDiagnosticAt)) result.lastDiagnosticAt = at;
      }
      // An explicitly unknown outcome is unresolved uncertainty: it blocks
      // further automation for this workflow regardless of live ownership,
      // until an authorized reconciliation finishes it terminally (AC-11).
      if (intent.state === 'unknown') {
        result.blocking = true; push(`intent-unknown-outcome:${intent.id}`);
      } else if ((intent.state === 'accepted' || intent.state === 'requested') && !liveIntentIds.has(intent.id)) {
        result.blocking = true; push(`intent-unreconciled:${intent.id}`);
      }
    }
  }
  for (const pool of ['effect', 'diagnostic']) {
    const slots = resolveReservationDirectory(packagePath, workflowId, POOL_DIRECTORIES[pool]);
    if (slots.status === 'invalid') { result.blocking = true; push(`slot-state-invalid:${POOL_DIRECTORIES[pool]}`); continue; }
    if (slots.status !== 'ok') continue;
    for (const slot of ['0', '1']) {
      const slotFile = join(slots.directory, `${slot}.json`);
      try { lstatSync(slotFile); } catch (error) { if (error?.code === 'ENOENT') continue; }
      // Bounded descriptor read; a symlinked/replaced/nonregular slot fails closed.
      const record = readBoundedJsonFile(slotFile);
      if (!record) { result.blocking = true; push(`slot-malformed:${POOL_DIRECTORIES[pool]}/${slot}`); continue; }
      // Bounded schema plus pool/directory/index/kind agreement.
      if (!isPlainObject(record) || record.version !== 1 || record.workflow_id !== workflowId
        || record.pool !== pool || record.slot !== Number(slot) || typeof record.intent_id !== 'string'
        || SLOT_POOLS[record.kind] !== pool) {
        result.blocking = true; push(`slot-malformed:${POOL_DIRECTORIES[pool]}/${slot}`); continue;
      }
      const intent = readIntentRecord(packagePath, workflowId, record.intent_id);
      if (!intent) { result.blocking = true; push(`intent-missing:${record.intent_id}`); continue; }
      // The slot record validates pool/directory/index/kind; the linked intent
      // must agree on kind and pool (the fixed Intent has no slot field).
      if (intent.kind !== record.kind || SLOT_POOLS[intent.kind] !== pool) {
        result.blocking = true; push(`slot-crosslink:${POOL_DIRECTORIES[pool]}/${slot}`); continue;
      }
      result.slotted.add(record.intent_id);
      result.intentSlots.set(record.intent_id, Number(slot));
      result.slotCounts.set(record.intent_id, (result.slotCounts.get(record.intent_id) ?? 0) + 1);
    }
  }
  // Every enumerated intent must hold exactly one durable slot: a removed,
  // duplicated or cross-pool slot link is missing retained budget history and
  // blocks reservations in either pool (AC-11).
  for (const id of enumerated) {
    const count = result.slotCounts.get(id) ?? 0;
    if (count === 0) { result.blocking = true; push(`slot-missing:${id}`); }
    else if (count > 1) { result.blocking = true; push(`slot-duplicate:${id}`); }
  }
  return result;
}

// A subject generation is workflow+kind+subject_key. source_revision is recorded
// on the intent but cannot replenish the subject's single reservation.
const intentId = (workflowId, kind, subjectKey) => createHash('sha256')
  .update(`${workflowId}\u0000${kind}\u0000${subjectKey}`).digest('hex').slice(0, 32);

// Reserve one durable slot + immutable intent before any effect. Permission is
// enforced from the re-read guard; a subject generation reserves once. The first
// publication returns `accepted:true`; a complete duplicate returns
// `duplicate:true` with `accepted:false` so callers never repeat an effect;
// retained unfinished state from a previous authority blocks as unknown.
export function reserveIntent(authority, {
  workflow_id: workflowId,
  kind,
  subject_key: subjectKey,
  source_revision: sourceRevision,
  now = Date.now,
} = {}) {
  const state = authorityState(authority);
  const guard = readPolicyGuard(authority, { workflow_id: workflowId, now });
  if (!guard.armed || guard.blocking) return { accepted: false, state: guard.armed ? 'blocked' : 'disarmed', blocking: true, reasons: guard.reasons ?? ['no live authority'], guard };
  if (workflowId != null && workflowId !== state.workflowId) fail('workflow_id does not match the live authority', 'policy-scope');
  if (!INTENT_KINDS.has(kind)) fail(`intent kind is unrecognized: ${kind}`, 'intent-invalid');
  if (typeof subjectKey !== 'string' || !subjectKey || subjectKey.length > KEY_MAX) fail(`intent subject_key must be 1-${KEY_MAX} characters`, 'intent-invalid');
  if (typeof sourceRevision !== 'string' || !sourceRevision || sourceRevision.length > KEY_MAX) fail(`intent source_revision must be 1-${KEY_MAX} characters`, 'intent-invalid');
  const pool = SLOT_POOLS[kind];
  // Permission comes from the guarded policy, never from the caller's kind alone.
  if (pool === 'effect' && !guard.allowed.includes(kind)) return { accepted: false, state: 'denied', blocking: true, reasons: [`action ${kind} is not permitted by the guarded policy`] };
  if (kind === 'diagnose' && !guard.diagnosis) return { accepted: false, state: 'denied', blocking: true, reasons: ['diagnosis is not permitted by the guarded policy'] };
  const nowMs = typeof now === 'function' ? now() : now;
  const id = intentId(state.workflowId, kind, subjectKey);
  const reservation = readReservationState(state.packagePath, state.workflowId, state.createdIntents);
  const existing = readIntentRecord(state.packagePath, state.workflowId, id);
  if (existing) {
    // An explicitly unknown outcome never becomes duplicate permission or a
    // fresh acceptance: only an authorized reconciliation can clear it.
    if (existing.state === 'unknown') {
      return { accepted: false, state: 'unknown', blocking: true, intent: existing,
        reasons: [`intent ${id} is retained with an unknown outcome; reconcile it before further automation`] };
    }
    if (reservation.slotted.has(id) && !reservation.blocking) {
      // A complete duplicate never repeats the effect: terminal intents stay
      // idempotent across restart; unfinished live ones return the retained
      // receipt, while an unfinished intent from another authority blocks.
      if ((existing.state === 'accepted' || existing.state === 'requested') && !state.createdIntents.has(id)) {
        return { accepted: false, state: 'unknown', blocking: true, intent: existing, reasons: [`intent ${id} is retained unfinished from a previous authority`] };
      }
      return { accepted: false, duplicate: true, state: existing.state, intent: existing, slot: reservation.intentSlots.get(id) ?? null };
    }
    if (!state.createdIntents.has(id) && (existing.state === 'accepted' || existing.state === 'requested')) {
      return { accepted: false, state: 'unknown', blocking: true, intent: existing, reasons: [`intent ${id} is retained unfinished from a previous authority`] };
    }
    return { accepted: false, state: 'blocked', blocking: true, intent: existing, reasons: [`intent ${id} is retained without a complete durable slot`] };
  }
  if (reservation.blocking) return { accepted: false, state: 'blocked', blocking: true, reasons: reservation.reasons };
  // One diagnostic generation at a time: a 5-minute cooldown across generations.
  if (kind === 'diagnose' && reservation.lastDiagnosticAt != null && (nowMs - reservation.lastDiagnosticAt) < 5 * 60 * 1000) {
    return { accepted: false, state: 'cooldown', blocking: true, reasons: ['diagnostic cooldown is active'] };
  }
  const ceiling = pool === 'effect' ? AUTHORITY_MAX_EFFECTS : AUTHORITY_MAX_DIAGNOSTICS;
  const cap = Math.max(0, Math.min(guard[pool === 'effect' ? 'max_effects' : 'max_diagnostics'], ceiling));
  if (reservation.spent[pool] >= cap) return { accepted: false, state: 'exhausted', blocking: true, reasons: [`${pool} budget exhausted (${reservation.spent[pool]}/${cap})`] };
  const slotDirectory = ensureStateDirectory(state.packagePath, ['runtime', 'sentinel', state.workflowId, POOL_DIRECTORIES[pool]], 'sentinel slot directory');
  let slot = null;
  for (const index of [0, 1]) { if (!existsSync(join(slotDirectory, `${index}.json`))) { slot = index; break; } }
  if (slot === null) return { accepted: false, state: 'exhausted', blocking: true, reasons: [`${pool} slots are occupied`] };
  const reservedAt = new Date(nowMs).toISOString();
  const intent = { version: 1, id, workflow_id: state.workflowId, package: state.packagePath,
    coordinator_session: state.coordinatorSession, kind, subject_key: subjectKey, source_revision: sourceRevision,
    policy_hash: state.policyHash, reserved_at: reservedAt, state: 'accepted', reason_code: 'reserved' };
  const intentsDirectory = ensureStateDirectory(state.packagePath, ['runtime', 'sentinel', state.workflowId, 'intents'], 'sentinel intent directory');
  // Slot first: after a crash an orphan slot stays spent and blocking. Then the
  // immutable intent; only this first publication returns accepted.
  const slotRecord = { version: 1, workflow_id: state.workflowId, pool, slot, intent_id: id, kind, reserved_at: reservedAt };
  try {
    publishDurable(join(slotDirectory, `${slot}.json`), slotRecord, { exclusive: true, directory: slotDirectory, requireParentFsync: true });
  } catch (error) {
    return { accepted: false, state: 'blocked', blocking: true, reasons: [error?.message ?? String(error)] };
  }
  try {
    publishDurable(join(intentsDirectory, `${id}.json`), intent, { exclusive: true, directory: intentsDirectory, requireParentFsync: true });
  } catch (error) {
    // The slot is retained without an intent: it stays spent and blocking.
    return { accepted: false, state: 'blocked', blocking: true, reasons: [error?.message ?? String(error)] };
  }
  state.createdIntents.add(id);
  return { accepted: true, duplicate: false, intent, slot };
}

// Replace only the live authority's own validated intent with a terminal state.
// Slots are never reclaimed and no other intent is touched.
export function finishIntent(authority, {
  workflow_id: workflowId,
  intent_id: requestedIntentId,
  state: finishState,
  reason_code: reasonCode,
  result_reference: resultReference,
  now = Date.now,
} = {}) {
  const state = authorityState(authority);
  if (!state.armed) fail('a live armed sentinel authority is required to finish an intent', 'authority-invalid');
  if (workflowId != null && workflowId !== state.workflowId) fail('workflow_id does not match the live authority', 'policy-scope');
  validateId(requestedIntentId, 'intent_id');
  if (finishState !== 'requested' && !FINISH_STATES.has(finishState)) fail(`finish state is unrecognized: ${finishState}`, 'intent-invalid');
  if (typeof reasonCode !== 'string' || !reasonCode.trim()) fail('a terminal update requires a nonempty reason_code', 'intent-invalid');
  if (!state.createdIntents.has(requestedIntentId)) fail(`intent ${requestedIntentId} is not owned by the live authority`, 'intent-owner');
  const existing = readIntentRecord(state.packagePath, state.workflowId, requestedIntentId);
  if (!existing) fail(`intent ${requestedIntentId} is missing`, 'intent-missing');
  if (existing.coordinator_session !== state.coordinatorSession) fail('intent is bound to another session', 'intent-owner');
  // A terminal update requires the matching durable slot link by ID/kind/workflow.
  const reservation = readReservationState(state.packagePath, state.workflowId, state.createdIntents);
  if (!reservation.intentSlots.has(requestedIntentId)) fail(`intent ${requestedIntentId} has no matching durable slot`, 'intent-missing');
  // Lifecycle: accepted -> requested|terminal, requested -> terminal; an
  // unknown outcome may be reconciled to a definite terminal state by its
  // owning live authority; an exact same-state replay is idempotent and any
  // conflicting/backward rewrite refuses.
  const allowed = existing.state === 'accepted'
    ? (finishState === 'requested' || FINISH_STATES.has(finishState))
    : existing.state === 'requested'
      ? FINISH_STATES.has(finishState)
      : existing.state === 'unknown'
        ? ['applied', 'blocked', 'failed'].includes(finishState)
        : false;
  if (!allowed) {
    if (existing.state === finishState && (existing.reason_code ?? '') === reasonCode
      && (existing.result_reference ?? undefined) === (resultReference ?? undefined)) return existing;
    fail(`intent ${requestedIntentId} cannot transition ${existing.state} -> ${finishState}; refusing a conflicting or backward rewrite`, 'intent-owner');
  }
  const updated = { ...existing, state: finishState, reason_code: String(reasonCode),
    ...(resultReference === undefined ? {} : { result_reference: String(resultReference) }) };
  const directory = ensureStateDirectory(state.packagePath, ['runtime', 'sentinel', state.workflowId, 'intents'], 'sentinel intent directory');
  publishDurable(join(directory, `${requestedIntentId}.json`), updated, { directory, requireParentFsync: true });
  return updated;
}

// ---------------------------------------------------------------------------
// Settlement decision and synchronous continuation reservation (U2, AC-12/13).
//
// decideSettle is a pure decision table. handleBeforeSettle consumes the step-5
// owners, re-reads live guards, reserves a durable continuation intent
// synchronously, and proposes a visible continuation entry to the Pi SDK
// boundary (step 6 owns that effect). No model or product call lives here.
// ---------------------------------------------------------------------------

const SETTLE_TERMINAL_WORKER_STATES = new Set(['complete', 'failed', 'aborted', 'cancelled']);

// Pure U2 table over the current agent_before_settle event and freshly read
// guards. An initial event.context.canContinue === false is deliberately not a
// veto: Pi recomputes eligibility after applying proposed entries.
export function decideSettle({ event = {}, checkpoint = null, inputGuard = {}, inboxGuard = null, policyGuard = null, activeManaged } = {}) {
  const veto = reason => ({ allow: false, reason });
  if (event?.continue === true) return veto('another handler already requested continuation');
  if (event?.outcome !== 'completed') return veto(`settlement outcome is ${event?.outcome ?? 'unknown'}, not completed`);
  if (!Array.isArray(event?.entries)) return veto('event.entries must be an array');
  if (!checkpoint) return veto('no retained checkpoint');
  if (checkpoint.state !== 'ready') return veto(`checkpoint stop state ${checkpoint.state} is not ready`);
  if (!checkpoint.obligation || typeof checkpoint.obligation.key !== 'string' || !checkpoint.obligation.key
    || typeof checkpoint.obligation_revision !== 'string' || !checkpoint.obligation_revision) return veto('checkpoint has no valid open obligation revision');
  // Exact nonnegative integers only: missing or malformed guard data vetoes.
  if (!Number.isInteger(checkpoint.input_revision) || checkpoint.input_revision < 0) return veto('checkpoint.input_revision is missing or malformed');
  if (!Number.isInteger(inputGuard.input_revision) || inputGuard.input_revision < 0) return veto('inputGuard.input_revision is missing or malformed');
  if (!Number.isInteger(inputGuard.active_prompts) || inputGuard.active_prompts < 0) return veto('inputGuard.active_prompts is missing or malformed');
  if (inputGuard.input_revision !== checkpoint.input_revision) return veto('native input revision is not reconciled to the checkpoint');
  if (inputGuard.active_prompts !== 0) return veto('a UI prompt is active');
  // Queued work is read only from the installed BoundaryState shape.
  const pending = event?.context?.pendingMessages;
  if (!Array.isArray(pending)) return veto('event.context.pendingMessages must be an array');
  if (pending.length > 0) return veto('pending messages exist');
  if (!inboxGuard || inboxGuard.blocking !== false) return veto('inbox guard is blocking or unknown');
  if (!Array.isArray(checkpoint.workers)) return veto('checkpoint.workers is malformed');
  if (checkpoint.workers.some(worker => !isPlainObject(worker) || !WORKER_STATES.has(worker.state)
    || !SETTLE_TERMINAL_WORKER_STATES.has(worker.state))) return veto('a declared worker is malformed or still nonterminal');
  if (activeManaged !== false) return veto('active-worker status is not explicitly false');
  if (!policyGuard || policyGuard.armed !== true || policyGuard.blocking) return veto('no live healthy policy');
  if (policyGuard.mode !== 'shadow' && policyGuard.mode !== 'recover') return veto('policy mode is not shadow or recover');
  if (!Array.isArray(policyGuard.allowed) || !policyGuard.allowed.includes('continue')) return veto('current policy does not permit continue');
  return { allow: true };
}

function projectInboxGuard(packagePath, checkpoint, now) {
  const retained = checkpoint?.inbox?.items ?? [];
  return readInboxGuard(packagePath, { priorItems: retained, items: retained,
    priorDirectories: checkpoint?.inbox?.observed_directories ?? [], now });
}

function buildContinuationMessage(checkpoint, sourceDigest) {
  const artifactCount = (checkpoint.obligation?.artifacts ?? []).length;
  return {
    type: 'custom_message',
    customType: 'spec-sentinel',
    display: true,
    content: `Continue obligation "${checkpoint.obligation.key}" (${checkpoint.obligation.summary}) revision ${checkpoint.obligation_revision}. Workflow ${checkpoint.workflow_id}; checkpoint ${checkpointPath(checkpoint.package, checkpoint.workflow_id)} revision ${checkpoint.revision}; source digest ${sourceDigest}; artifacts ${artifactCount}. Reconcile these sources before acting. This is a bounded continuation request proposed to the SDK boundary, not acceptance.`,
  };
}

// Stable digest over the decisive rechecked checkpoint revision, obligation
// revision, input revision, artifact path/hash references and freshly read inbox
// source identity/hash references.
function settleSourceRevision(checkpoint, inboxGuard) {
  const artifacts = (checkpoint.obligation?.artifacts ?? []).map(artifact => `${artifact.path}\u0000${artifact.sha256}`).sort();
  const inboxSources = (inboxGuard?.sources ?? []).map(source => `${source.path ?? source.id ?? ''}\u0000${source.sha256 ?? ''}`).sort();
  return createHash('sha256').update(JSON.stringify([checkpoint.revision, checkpoint.obligation_revision,
    checkpoint.input_revision, artifacts, inboxSources])).digest('hex');
}

// Read live guards, decide, re-read and require the same checkpoint/obligation
// revision, then reserve synchronously before returning. Recover mode returns a
// visible custom message plus continue:true; shadow mode records one
// would-continue observation and returns undefined. All uncertainty abstains.
export function handleBeforeSettle(event = {}, {
  authority,
  workflow_id: workflowId,
  package: packageInput,
  coordinator_session: coordinatorSession,
  inputGuard = () => ({}),
  activeManaged = () => false,
  onRequested = () => {},
  now = Date.now,
} = {}) {
  try {
    const state = authorityState(authority);
    const scoped = workflowId ?? state.workflowId;
    if (!scoped || scoped !== state.workflowId) return undefined;
    if (coordinatorSession != null && coordinatorSession !== state.coordinatorSession) return undefined;
    const packagePath = canonicalPackage(packageInput).packagePath;
    if (packagePath !== state.packagePath) return undefined;
    const readInput = () => (typeof inputGuard === 'function' ? (inputGuard() ?? {}) : (inputGuard ?? {}));
    // Preserve the raw value: only an explicit false may reach the allowing branch.
    const readActive = () => (typeof activeManaged === 'function' ? activeManaged() : activeManaged);
    const checkpoint = readCheckpointRecord(packagePath, scoped);
    const inboxGuard = projectInboxGuard(packagePath, checkpoint, now);
    const policyGuard = readPolicyGuard(authority, { workflow_id: scoped, now });
    if (!decideSettle({ event, checkpoint, inputGuard: readInput(), inboxGuard, policyGuard, activeManaged: readActive() }).allow) return undefined;
    // Immediately re-read live state and re-run the full table; a weaker hand
    // subset is not acceptable, and the checkpoint/obligation revision must not change.
    const recheckpoint = readCheckpointRecord(packagePath, scoped);
    const reinbox = projectInboxGuard(packagePath, recheckpoint, now);
    const repolicy = readPolicyGuard(authority, { workflow_id: scoped, now });
    const reinput = readInput();
    const reactive = readActive();
    if (!recheckpoint || recheckpoint.revision !== checkpoint.revision
      || recheckpoint.obligation_revision !== checkpoint.obligation_revision) return undefined;
    if (!decideSettle({ event, checkpoint: recheckpoint, inputGuard: reinput, inboxGuard: reinbox, policyGuard: repolicy, activeManaged: reactive }).allow) return undefined;
    const sourceRevision = settleSourceRevision(recheckpoint, reinbox);
    const reservation = reserveIntent(authority, { workflow_id: scoped, kind: 'continue',
      subject_key: recheckpoint.obligation_revision, source_revision: sourceRevision, now });
    if (!reservation || reservation.accepted !== true || !reservation.intent) return undefined;
    if (repolicy.mode === 'shadow') {
      // Record one would-continue observation as terminal blocked; never a
      // model-visible entry/turn and never applied.
      finishIntent(authority, { workflow_id: scoped, intent_id: reservation.intent.id,
        state: 'blocked', reason_code: 'shadow-would-continue', now });
      return undefined;
    }
    const requested = finishIntent(authority, { workflow_id: scoped, intent_id: reservation.intent.id,
      state: 'requested', reason_code: 'requested', now });
    // An onRequested failure falls through to the outer fail-closed catch: a
    // continuation that cannot be tracked for agent_start delivery must abstain.
    onRequested(requested);
    const message = buildContinuationMessage(recheckpoint, sourceRevision);
    const entries = Array.isArray(event?.entries) ? [...event.entries, message] : [message];
    return { entries, continue: true };
  } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// Bounded incident diagnosis (step 7, AC-10/AC-11/AC-14/AC-17).
//
// buildDiagnosisPacket projects only bounded operational facts from retained
// incident/checkpoint/policy state; validateDiagnosisResult enforces the exact
// six-key text reply; diagnoseIncident reserves one diagnostic intent and runs
// one zero-tool owned leaf, retaining a bounded attempt record. No second call,
// fallback model or raw model text is ever retained.
// ---------------------------------------------------------------------------

const DIAGNOSIS_MAX_PACKET_BYTES = 16 * 1024;
const DIAGNOSIS_MAX_RESPONSE_BYTES = 8 * 1024;
const DIAGNOSIS_MAX_FACTS = 96;
const DIAGNOSIS_MAX_NOTE = 500;
const DIAGNOSIS_MAX_VALUE = 160;
const DIAGNOSIS_FILE = 'diagnoses';
const DIAGNOSIS_DECISIONS = new Set(['observe', 'cancel-candidate', 'human-decision', 'abstain']);
const DIAGNOSIS_REASON_CODES = new Set(['repeated-unchanged-failure', 'insufficient-context', 'external-dependency', 'authority-question']);
const DIAGNOSIS_RESPONSE_KEYS = ['decision', 'fact_ids', 'reason_code', 'incident_id', 'incident_generation', 'note'];

const boundedDiagnosisValue = value => {
  if (typeof value === 'string') return value.slice(0, DIAGNOSIS_MAX_VALUE);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
};

// Pure source-backed packet builder. Only identifiers, counts, digests and safe
// category names leave this function; never obligation summaries, artifact
// paths, reason strings, command/log text or process identity.
export function buildDiagnosisPacket({ incident, record = null, checkpoint = null, policy = null } = {}) {
  const base = [];
  const artifacts = [];
  const workers = [];
  const inbox = [];
  const reasons = [];
  const items = [];
  const policyFacts = [];
  const omitted = [];
  const coverageReasons = [];
  const add = (target, id, category, value) => {
    const bounded = boundedDiagnosisValue(value);
    if (bounded === undefined) return;
    // A sliced string is a bounded-value truncation: it is tracked like the
    // initial collection caps so coverage never presents partial values as
    // the complete evidence set.
    if (typeof value === 'string' && value.length > DIAGNOSIS_MAX_VALUE) {
      omitted.push('truncated-values');
      coverageReasons.push('values-truncated');
    }
    target.push({ id, category, value: bounded });
  };

  add(base, 'incident.id', 'identity', incident?.id);
  add(base, 'incident.kind', 'identity', incident?.kind);
  add(base, 'incident.generation', 'count', incident?.generation);
  add(base, 'incident.count', 'count', incident?.count);
  add(base, 'incident.command_sha256', 'hash', incident?.command_sha256);
  add(base, 'incident.summary_sha256', 'hash', incident?.summary_sha256);
  add(base, 'incident.tree_digest', 'hash', incident?.tree_digest);
  add(base, 'incident.observed_at', 'wait', incident?.observed_at);
  if (incident?.linked_from) add(base, 'incident.linked_from', 'identity', incident.linked_from);
  add(base, 'record.id', 'identity', record?.id);
  add(base, 'record.checkout', 'identity', record?.checkout);
  add(base, 'record.workflow_id', 'identity', record?.workflow_id);
  add(base, 'record.assignment_id', 'identity', record?.assignment_id);
  add(base, 'checkpoint.revision', 'count', checkpoint?.revision);
  add(base, 'checkpoint.state', 'identity', checkpoint?.state);
  add(base, 'checkpoint.obligation_revision', 'hash', checkpoint?.obligation_revision);
  add(base, 'checkpoint.obligation.key', 'identity', checkpoint?.obligation?.key);
  add(base, 'checkpoint.obligation.stage', 'identity', checkpoint?.obligation?.stage);
  add(base, 'checkpoint.input_revision', 'count', checkpoint?.input_revision);
  add(base, 'checkpoint.observed_at', 'wait', checkpoint?.observed_at);

  const artifactList = Array.isArray(checkpoint?.obligation?.artifacts) ? checkpoint.obligation.artifacts : [];
  const artifactsOmitted = artifactList.length > 16;
  artifactList.slice(0, 16).forEach((entry, index) => add(artifacts, `artifact.${index}.sha256`, 'hash', entry?.sha256));

  const workerList = Array.isArray(checkpoint?.workers) ? checkpoint.workers : [];
  const workersOmitted = workerList.length > 8;
  workerList.slice(0, 8).forEach((worker, index) => {
    add(workers, `worker.${index}.id`, 'wait', worker?.id);
    add(workers, `worker.${index}.kind`, 'wait', worker?.kind);
    add(workers, `worker.${index}.state`, 'wait', worker?.state);
  });

  const guard = checkpoint?.inbox_guard ?? {};
  add(inbox, 'inbox.state', 'identity', guard.state);
  add(inbox, 'inbox.blocking', 'hold', guard.blocking);
  const guardItems = Array.isArray(guard.items) ? guard.items : [];
  add(inbox, 'inbox.items_count', 'count', guardItems.length);
  add(inbox, 'inbox.held_count', 'count', guardItems.filter(item => item?.state === 'held').length);
  add(inbox, 'inbox.blocking_count', 'count', guardItems.filter(item => item?.state === 'blocking' || item?.state === 'unknown').length);
  const reasonCategories = new Map();
  for (const reason of Array.isArray(guard.reasons) ? guard.reasons : []) {
    const category = String(reason).split(':')[0];
    reasonCategories.set(category, (reasonCategories.get(category) ?? 0) + 1);
  }
  const reasonEntries = [...reasonCategories.entries()];
  const reasonsOmitted = reasonEntries.length > 12;
  reasonEntries.slice(0, 12).forEach(([category, count]) => add(reasons, `inbox.reason.${category}`, 'count', count));
  const heldOrBlocking = guardItems
    .filter(item => item?.state === 'held' || item?.state === 'blocking' || item?.state === 'unknown');
  const itemsOmitted = heldOrBlocking.length > 12;
  heldOrBlocking.slice(0, 12).forEach((item, index) => {
    add(items, `inbox.item.${index}.id`, 'hold', item?.id);
    add(items, `inbox.item.${index}.sha256`, 'hash', item?.sha256);
  });

  add(policyFacts, 'policy.mode', 'identity', policy?.mode);
  add(policyFacts, 'policy.policy_hash', 'hash', policy?.policy_hash);
  add(policyFacts, 'policy.max_diagnostics', 'count', policy?.max_diagnostics);
  add(policyFacts, 'policy.expires_at', 'wait', policy?.expires_at);

  // Every initial slice and bounded-value truncation is tracked independently
  // of byte/fact overflow, so a packet below the byte and fact limits can never
  // present silently truncated evidence as complete.
  if (workersOmitted) { omitted.push('workers'); coverageReasons.push('workers-omitted'); }
  if (artifactsOmitted) { omitted.push('artifact-hashes'); coverageReasons.push('artifact-hashes-omitted'); }
  if (reasonsOmitted) { omitted.push('reason-categories'); coverageReasons.push('reason-categories-omitted'); }
  if (itemsOmitted) { omitted.push('inbox-items'); coverageReasons.push('inbox-items-omitted'); }
  const groups = { base, artifacts, workers, inbox, reasons, items, policy: policyFacts };
  const assemble = () => {
    const facts = [...groups.base, ...groups.artifacts, ...groups.workers, ...groups.inbox,
      ...groups.reasons, ...groups.items, ...groups.policy];
    const coverage = omitted.length
      ? { state: 'partial', omitted: [...new Set(omitted)], reasons: [...new Set(coverageReasons)] }
      : { state: 'complete', omitted: [], reasons: [] };
    const packet = { version: 1, incident_id: incident?.id ?? null, incident_generation: incident?.generation ?? null, facts, coverage };
    const json = JSON.stringify(packet);
    return { packet, json, bytes: Buffer.byteLength(json, 'utf8') };
  };
  const over = result => result.packet.facts.length > DIAGNOSIS_MAX_FACTS || result.bytes > DIAGNOSIS_MAX_PACKET_BYTES;
  let result = assemble();
  if (over(result) && groups.reasons.length) {
    groups.reasons = []; omitted.push('reason-categories'); coverageReasons.push('reason-categories-omitted'); result = assemble();
  }
  if (over(result) && groups.workers.length > 3) {
    groups.workers = groups.workers.slice(0, 3); omitted.push('workers'); coverageReasons.push('workers-omitted'); result = assemble();
  }
  if (over(result) && groups.items.length > 2) {
    groups.items = groups.items.slice(0, 2); omitted.push('inbox-items'); coverageReasons.push('inbox-items-omitted'); result = assemble();
  }
  if (over(result) && groups.artifacts.length > 1) {
    groups.artifacts = groups.artifacts.slice(0, 1); omitted.push('artifact-hashes'); coverageReasons.push('artifact-hashes-omitted'); result = assemble();
  }
  while (over(result)) {
    const group = ['policy', 'reasons', 'items', 'workers', 'artifacts'].find(key => groups[key].length);
    if (!group) break;
    groups[group].pop();
    if (!omitted.includes('overflow')) { omitted.push('overflow'); coverageReasons.push('overflow-trimmed'); }
    result = assemble();
  }
  return result;
}

// Strict local validator for the bounded text-result contract. Checks run in a
// fixed order so a malformed reply yields one deterministic code.
export function validateDiagnosisResult(text, { incident, fact_ids: factIds = [] } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > DIAGNOSIS_MAX_RESPONSE_BYTES) return { ok: false, code: 'oversize' };
  let value;
  try { value = JSON.parse(text); } catch { return { ok: false, code: 'not-json' }; }
  if (!isPlainObject(value)) return { ok: false, code: 'not-object' };
  if (Object.keys(value).some(key => !DIAGNOSIS_RESPONSE_KEYS.includes(key))) return { ok: false, code: 'unknown-field' };
  if (DIAGNOSIS_RESPONSE_KEYS.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return { ok: false, code: 'missing-field' };
  if (!DIAGNOSIS_DECISIONS.has(value.decision) || !DIAGNOSIS_REASON_CODES.has(value.reason_code)) return { ok: false, code: 'bad-enum' };
  const ids = value.fact_ids;
  if (!Array.isArray(ids) || ids.length > DIAGNOSIS_MAX_FACTS || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    return { ok: false, code: 'bad-fact-ids' };
  }
  const allowed = new Set(Array.isArray(factIds) ? factIds : []);
  if (ids.some(id => !allowed.has(id))) return { ok: false, code: 'unknown-fact-id' };
  if (typeof value.note !== 'string' || value.note.length > DIAGNOSIS_MAX_NOTE) return { ok: false, code: 'bad-note' };
  if (value.incident_id !== incident?.id || value.incident_generation !== incident?.generation) return { ok: false, code: 'stale-incident' };
  return { ok: true, result: { decision: value.decision, fact_ids: [...ids], reason_code: value.reason_code,
    incident_id: value.incident_id, incident_generation: value.incident_generation, note: value.note, note_verified: false } };
}

// Durable attempt location; validates IDs before any path construction.
export function diagnosisAttemptPath(packagePath, workflowId, incidentId) {
  validateId(workflowId, 'workflow_id');
  validateId(incidentId, 'incident_id');
  return join(packagePath, 'runtime', 'sentinel', workflowId, DIAGNOSIS_FILE, `${incidentId}.json`);
}

// Bounded read of one retained diagnosis attempt, never following a symlinked
// state ancestor. Malformed or mismatched records are unavailable.
export function readDiagnosisAttempt(packagePath, workflowId, incidentId) {
  validateId(workflowId, 'workflow_id');
  validateId(incidentId, 'incident_id');
  const directory = validatedStateDirectory(packagePath, ['runtime', 'sentinel', workflowId, DIAGNOSIS_FILE]);
  if (!directory) return null;
  const value = readBoundedJsonFile(join(directory, `${incidentId}.json`), DIAGNOSIS_MAX_PACKET_BYTES);
  return value && value.version === 1 && value.workflow_id === workflowId && value.incident_id === incidentId ? value : null;
}

// One optional bounded diagnosis of a source-backed incident. Preconditions
// abstain before any reservation; a successful reservation launches exactly one
// zero-tool owned leaf. Missing usage never becomes zero and no retry, fallback
// model or raw model text is retained.
export async function diagnoseIncident({
  authority,
  incident,
  record = null,
  workflow_id: workflowId = null,
  events = null,
  createLeaf = createOwnedLeaf,
  readyMs = 5000,
  timeoutMs = 120000,
  ownerRunId = null,
  now = Date.now,
  signal,
} = {}) {
  const abstain = (state, error = null, extra = {}) => ({
    version: 1, launched: false, state, decision: 'abstain', fact_ids: [], reason_code: 'insufficient-context',
    note: null, note_verified: false, usage: null, usage_available: false,
    incident_id: isPlainObject(incident) && typeof incident.id === 'string' ? incident.id : null,
    incident_generation: isPlainObject(incident) && Number.isInteger(incident.generation) ? incident.generation : null,
    intent_id: null, packet_sha256: null, packet_bytes: null, attempt_path: null, model: null, error, ...extra,
  });
  if (!isPlainObject(incident) || typeof incident.id !== 'string' || !ID_SHAPE.test(incident.id)
    || !Number.isInteger(incident.generation) || incident.generation < 1) {
    return abstain('invalid', 'invalid-incident');
  }
  const scopedWorkflow = workflowId ?? record?.workflow_id ?? incident.workflow_id ?? null;
  if (typeof scopedWorkflow !== 'string' || !ID_SHAPE.test(scopedWorkflow)) return abstain('skipped', 'workflow-scope-missing');
  let guard;
  try { guard = readPolicyGuard(authority, { workflow_id: scopedWorkflow, now }); }
  catch { guard = { armed: false, state: 'disarmed', blocking: false, reasons: [] }; }
  if (!guard || guard.armed !== true) return abstain('disarmed', null);
  if (guard.blocking) return abstain('blocked', (guard.reasons ?? []).join('; ') || 'policy-blocked');
  if (!guard.diagnosis || typeof guard.diagnosis.model !== 'string' || !guard.diagnosis.model) return abstain('denied', null);
  let packagePath;
  try { packagePath = canonicalPackage(record?.package ?? incident.package).packagePath; }
  catch { return abstain('skipped', 'checkpoint-unavailable'); }
  // The record, incident and retained checkpoint must agree with the live
  // authority's complete canonical scope before any packet or reservation: a
  // workflow ID registered independently in another canonical package never
  // spends this authority's budget or sends that package's facts to the model.
  if (incident.package != null) {
    let incidentPackage;
    try { incidentPackage = canonicalPackage(incident.package).packagePath; } catch { return abstain('blocked', 'incident-package-unavailable'); }
    if (incidentPackage !== packagePath) return abstain('blocked', 'incident-package-mismatch');
  }
  const liveScope = authorityState(authority);
  if (packagePath !== liveScope.packagePath) return abstain('blocked', 'package-mismatch');
  if (record?.assignment_id != null && incident.assignment_id != null && record.assignment_id !== incident.assignment_id) {
    return abstain('blocked', 'assignment-mismatch');
  }
  const checkpoint = readCheckpointRecord(packagePath, scopedWorkflow);
  if (!checkpoint || checkpoint.workflow_id !== scopedWorkflow || checkpoint.package !== packagePath) {
    return abstain('skipped', 'checkpoint-unavailable');
  }
  if (checkpoint.checkout != null && resolve(checkpoint.checkout) !== liveScope.checkout) {
    return abstain('blocked', 'checkout-mismatch');
  }
  if (!events) return abstain('unavailable', 'delegation-unavailable');

  const built = buildDiagnosisPacket({ incident, record, checkpoint, policy: guard });
  const packetSha256 = createHash('sha256').update(built.json).digest('hex');
  const base = { packet_sha256: packetSha256, packet_bytes: built.bytes, model: guard.diagnosis.model };
  let reservation;
  try {
    reservation = reserveIntent(authority, { workflow_id: scopedWorkflow, kind: 'diagnose',
      subject_key: incident.id, source_revision: packetSha256, now });
  } catch (error) {
    return abstain('blocked', publicHint(String(error?.message ?? error)), base);
  }
  if (!reservation || reservation.accepted !== true) {
    const state = reservation?.duplicate ? 'duplicate' : (reservation?.state ?? 'blocked');
    return abstain(state, (reservation?.reasons ?? []).join('; ') || null, base);
  }
  const intentIdValue = reservation.intent?.id ?? null;
  const task = 'Return exactly one JSON object with exactly the keys decision, fact_ids, reason_code, incident_id, '
    + 'incident_generation and note. decision must be one of observe|cancel-candidate|human-decision|abstain; '
    + 'reason_code one of repeated-unchanged-failure|insufficient-context|external-dependency|authority-question; '
    + 'fact_ids must cite only ids present in the PACKET and be unique; incident_id and incident_generation must '
    + 'echo the incident; note must be a string of at most 500 characters. Abstain when the packet is insufficient.\n\nPACKET:\n'
    + built.json;
  let reply = null;
  let thrown = null;
  try {
    const leaf = createLeaf(events, {
      ownerRunId: ownerRunId ?? record?.id ?? incident.assignment_id,
      nodeId: 'diagnostician',
      agent: 'spec-sentinel-diagnostician',
      cwd: record?.checkout ?? packagePath,
      model: guard.diagnosis.model,
      timeoutMs,
      readyMs,
      toolBudget: { hard: 0, block: '*' },
      skill: false,
      artifacts: false,
      label: 'Diagnosis',
      maxTaskLength: DIAGNOSIS_MAX_PACKET_BYTES + 4096,
    });
    reply = await leaf.run(task, signal);
  } catch (error) { thrown = error; }

  const validation = thrown
    ? { ok: false, code: signal?.aborted ? 'cancelled' : 'unavailable' }
    : validateDiagnosisResult(reply?.result, { incident, fact_ids: built.packet.facts.map(fact => fact.id) });
  const applied = validation.ok === true;
  const attemptState = applied ? 'applied' : 'failed';
  const reasonCode = applied ? 'diagnosed' : (validation.code ?? (signal?.aborted ? 'cancelled' : 'unavailable'));
  const errorCode = applied ? null
    : thrown ? publicHint(String(thrown?.message ?? 'unavailable')).slice(0, 200) : validation.code;
  const usage = reply?.usage ?? null;
  const attemptPath = diagnosisAttemptPath(packagePath, scopedWorkflow, incident.id);
  const attempt = {
    version: 1,
    workflow_id: scopedWorkflow,
    package: packagePath,
    incident_id: incident.id,
    incident_generation: incident.generation,
    assignment_id: record?.assignment_id ?? incident.assignment_id ?? null,
    record_id: record?.id ?? null,
    model: guard.diagnosis.model,
    intent_id: intentIdValue,
    state: attemptState,
    validation: applied ? 'valid' : (thrown ? 'unavailable' : 'invalid'),
    decision: applied ? validation.result.decision : 'abstain',
    fact_ids: applied ? validation.result.fact_ids : [],
    reason_code: applied ? validation.result.reason_code : (validation.code ?? reasonCode),
    note: applied ? validation.result.note : null,
    note_verified: false,
    error: errorCode,
    usage,
    usage_available: usage != null,
    packet_sha256: packetSha256,
    packet_bytes: built.bytes,
    completed_at: new Date(typeof now === 'function' ? now() : now).toISOString(),
  };
  let retainedPath = attemptPath;
  let persistenceError = null;
  try {
    const directory = ensureStateDirectory(packagePath, ['runtime', 'sentinel', scopedWorkflow, DIAGNOSIS_FILE], 'sentinel diagnosis directory');
    const serialized = JSON.stringify(attempt);
    if (Buffer.byteLength(serialized, 'utf8') > DIAGNOSIS_MAX_PACKET_BYTES) {
      throw new CheckpointError('diagnosis attempt exceeds the retained bound', 'diagnosis-oversize');
    }
    publishDurable(join(directory, `${incident.id}.json`), attempt, { directory });
  } catch (error) {
    retainedPath = null;
    persistenceError = publicHint(String(error?.message ?? error));
  }
  // A diagnosis whose attempt could not be retained is never applied: the
  // intent keeps an unresolved unknown outcome so the storage failure disables
  // further automation for this workflow while the spent diagnostic slot is
  // retained, and the caller sees abstention instead of a decision (AC-11).
  const published = retainedPath != null;
  const outcomeState = published ? attemptState : 'unknown';
  const outcomeReason = published ? reasonCode : 'attempt-retention-failed';
  try {
    finishIntent(authority, { workflow_id: scopedWorkflow, intent_id: intentIdValue, state: outcomeState,
      reason_code: outcomeReason, ...(applied && published ? { result_reference: `${DIAGNOSIS_FILE}/${incident.id}.json` } : {}), now });
  } catch (error) {
    persistenceError = persistenceError ?? publicHint(String(error?.message ?? error));
  }
  return {
    version: 1,
    launched: true,
    state: outcomeState,
    decision: applied && published ? validation.result.decision : 'abstain',
    fact_ids: applied && published ? validation.result.fact_ids : [],
    reason_code: applied && published ? validation.result.reason_code : (published ? (validation.code ?? reasonCode) : outcomeReason),
    note: applied && published ? validation.result.note : null,
    note_verified: false,
    usage,
    usage_available: usage != null,
    incident_id: incident.id,
    incident_generation: incident.generation,
    intent_id: intentIdValue,
    packet_sha256: packetSha256,
    packet_bytes: built.bytes,
    attempt_path: retainedPath,
    model: guard.diagnosis.model,
    error: persistenceError ?? errorCode,
  };
}

// One serialized diagnosis per coordinator. Attempts queue behind each other so
// only one owned leaf runs at a time; cancel aborts only the active attempt and
// close refuses all later diagnoses. No retry and no fallback model.
export function createDiagnosisController({
  authority,
  workflow_id: workflowId = null,
  events,
  createLeaf = createOwnedLeaf,
  readyMs = 5000,
  timeoutMs = 120000,
  now = Date.now,
} = {}) {
  let queue = Promise.resolve();
  let active = null;
  let closed = false;
  return {
    diagnose(record, incident) {
      const previous = queue;
      const run = previous.then(async () => {
        if (closed) return null;
        const abort = new AbortController();
        active = abort;
        try {
          return await diagnoseIncident({
            authority,
            incident,
            record,
            workflow_id: incident?.workflow_id ?? workflowId ?? record?.workflow_id,
            events,
            createLeaf,
            readyMs,
            timeoutMs,
            now,
            signal: abort.signal,
          });
        } finally {
          if (active === abort) active = null;
        }
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
    cancel(reason) {
      // Only the active owned attempt is cancelled; a queued or finished
      // attempt is untouched.
      active?.abort(reason);
    },
    close() {
      closed = true;
      active?.abort('closed');
    },
    active() { return active !== null; },
  };
}

// ---------------------------------------------------------------------------
// Guarded cancellation (AC-5, AC-6, AC-15, AC-16). considerCancellation
// revalidates every live dimension, reserves one cancel intent immediately
// before the effect, and delegates revocation/termination/lease release to the
// injected original Runtime adapter. It never deletes locks, transfers owners,
// launches replacements or retries; ambiguous outcomes stay spent.
// ---------------------------------------------------------------------------

export async function considerCancellation({
  authority,
  record,
  incident,
  packet_sha256: packetSha = null,
  adapter = null,
  idleWriter = null,
  activeHandle = null,
  inputGuard = () => ({}),
  onRequested = () => {},
  onEntered = () => {},
  collect = collectFacts,
  now = Date.now,
} = {}) {
  const abstain = (state, reason, extra = {}) => ({ version: 1, launched: false, state, decision: 'abstain',
    reason_code: reason, intent_id: null, incident_id: isPlainObject(incident) ? (incident.id ?? null) : null,
    incident_generation: isPlainObject(incident) && Number.isInteger(incident.generation) ? incident.generation : null, ...extra });
  if (!isPlainObject(record) || typeof record.package !== 'string' || typeof record.id !== 'string' || !record.id) return abstain('invalid', 'record-invalid');
  if (!isPlainObject(incident) || typeof incident.id !== 'string' || !ID_SHAPE.test(incident.id)
    || !Number.isInteger(incident.generation) || incident.generation < 1) return abstain('invalid', 'incident-invalid');
  // A supplied current diagnosis packet hash is mandatory; never optional.
  if (typeof packetSha !== 'string' || !HASH_SHAPE.test(packetSha)) return abstain('blocked', 'diagnosis-packet-missing');
  let packagePath;
  try { packagePath = canonicalPackage(record.package).packagePath; } catch { return abstain('skipped', 'package-unavailable'); }
  if (incident.package != null) {
    let incidentPackage;
    try { incidentPackage = canonicalPackage(incident.package).packagePath; } catch { return abstain('blocked', 'incident-package-unavailable'); }
    if (incidentPackage !== packagePath) return abstain('blocked', 'incident-package-mismatch');
  }
  // Exact identity equality between the live record and the incident.
  if (typeof record.workflow_id !== 'string' || record.workflow_id !== incident.workflow_id) return abstain('blocked', 'workflow-mismatch');
  if (typeof record.assignment_id !== 'string' || record.assignment_id !== incident.assignment_id) return abstain('blocked', 'assignment-mismatch');
  const workflowId = record.workflow_id;
  const assignmentId = record.assignment_id;
  const checkout = typeof record.checkout === 'string' ? record.checkout : null;
  if (!checkout) return abstain('skipped', 'checkout-unavailable');
  // Asynchronous digest read first, then every effect guard is re-read synchronously below.
  let digest;
  try { digest = await collect(checkout); } catch { return abstain('unavailable', 'digest-unavailable'); }
  const treeDigest = typeof digest?.working_tree_digest === 'string' ? digest.working_tree_digest : null;
  if (!treeDigest || digest.incomplete !== false) return abstain('blocked', 'tree-unavailable');
  let guard;
  try { guard = readPolicyGuard(authority, { workflow_id: workflowId, now }); }
  catch { guard = { armed: false, state: 'disarmed', blocking: false, allowed: [], reasons: [], mode: null }; }
  if (!guard || guard.armed !== true) return abstain('disarmed', 'authority-disarmed');
  if (guard.blocking) return abstain('blocked', (guard.reasons ?? []).join('; ') || 'policy-blocked');
  if (guard.mode !== 'shadow' && guard.mode !== 'recover') return abstain('blocked', 'policy-mode-invalid');
  if (!Array.isArray(guard.allowed) || !guard.allowed.includes('cancel')) return abstain('denied', 'cancel-not-permitted');
  const checkpoint = readCheckpointRecord(packagePath, workflowId);
  if (!checkpoint || checkpoint.package !== packagePath || checkpoint.workflow_id !== workflowId) return abstain('skipped', 'checkpoint-unavailable');
  if (checkpoint.checkout != null && resolve(checkpoint.checkout) !== resolve(checkout)) return abstain('blocked', 'checkout-mismatch');
  const snapshot = readVerificationIncidents(packagePath, workflowId);
  const current = snapshot?.assignments?.[assignmentId] ?? null;
  if (!current || current.state !== 'open' || !isPlainObject(current.fingerprint)) return abstain('blocked', 'incident-not-open');
  if (current.incident_id !== incident.id || current.generation !== incident.generation) return abstain('blocked', 'stale-incident');
  const fingerprint = current.fingerprint;
  if (!Number.isInteger(current.count) || current.count < 1
    || typeof fingerprint.command_sha256 !== 'string' || !HASH_SHAPE.test(fingerprint.command_sha256)
    || typeof fingerprint.summary_sha256 !== 'string' || !HASH_SHAPE.test(fingerprint.summary_sha256)
    || typeof fingerprint.tree_digest !== 'string' || !HASH_SHAPE.test(fingerprint.tree_digest)) return abstain('blocked', 'fingerprint-malformed');
  if (current.replay_exhausted === true) return abstain('blocked', 'replay-exhausted');
  if (current.incident_fingerprint != null) {
    const retainedKey = `${current.incident_fingerprint.command_sha256}:${current.incident_fingerprint.summary_sha256}:${current.incident_fingerprint.tree_digest}`;
    const currentKey = `${fingerprint.command_sha256}:${fingerprint.summary_sha256}:${fingerprint.tree_digest}`;
    if (retainedKey !== currentKey) return abstain('blocked', 'incident-fingerprint-mismatch');
  }
  if (fingerprint.command_sha256 !== incident.command_sha256
    || fingerprint.summary_sha256 !== incident.summary_sha256 || fingerprint.tree_digest !== incident.tree_digest) return abstain('blocked', 'stale-fingerprint');
  if (treeDigest !== fingerprint.tree_digest) return abstain('blocked', 'tree-changed');
  const input = typeof inputGuard === 'function' ? (inputGuard() ?? {}) : (inputGuard ?? {});
  if (!Number.isInteger(input.input_revision) || input.input_revision !== checkpoint.input_revision) return abstain('blocked', 'input-unreconciled');
  if (input.active_prompts !== 0) return abstain('blocked', 'prompt-active');
  const inboxGuard = readInboxGuard(packagePath, { priorItems: checkpoint?.inbox?.items ?? [], items: checkpoint?.inbox?.items ?? [],
    priorDirectories: checkpoint?.inbox?.observed_directories ?? [], now });
  if (!inboxGuard || inboxGuard.blocking !== false) return abstain('blocked', 'inbox-blocking');
  if (checkpoint.state !== 'waiting-worker') return abstain('blocked', 'stop-state');
  // The declared working target is exactly as dispatch writes it: the explicit
  // assignment worker when present, otherwise the live run UUID. Other workers
  // (native reviewers, other assignments) never grant cancellation authority.
  const targetWorkerId = Array.isArray(checkpoint.workers) && checkpoint.workers.some(worker => worker.id === record.assignment_id)
    ? record.assignment_id : record.id;
  if (!Array.isArray(checkpoint.workers) || !checkpoint.workers.some(worker => worker.id === targetWorkerId && worker.state === 'working')) return abstain('blocked', 'worker-not-working');
  // Reconstruct the current incident from the retained open entry and re-derive
  // the current packet hash with the fresh inbox; any checkpoint/policy/inbox/
  // fingerprint change invalidates the retained advice.
  const currentIncident = { id: current.incident_id, kind: 'repeated-verification-failure', assignment_id: assignmentId,
    package: packagePath, workflow_id: workflowId, generation: current.generation, count: current.count, ...fingerprint,
    ...(current.linked_from ? { linked_from: current.linked_from } : {}), observed_at: current.observed_at ?? null };
  const rebuilt = buildDiagnosisPacket({ incident: currentIncident, record,
    checkpoint: { ...checkpoint, inbox_guard: inboxGuard }, policy: guard });
  const currentPacketHash = createHash('sha256').update(rebuilt.json).digest('hex');
  const retained = readDiagnosisAttempt(packagePath, workflowId, incident.id);
  if (!retained || retained.state !== 'applied' || retained.validation !== 'valid'
    || retained.decision !== 'cancel-candidate' || retained.reason_code !== 'repeated-unchanged-failure'
    || retained.incident_generation !== incident.generation || retained.assignment_id !== assignmentId
    || retained.record_id !== record.id
    || retained.packet_sha256 !== currentPacketHash
    || (packetSha != null && packetSha !== currentPacketHash)) return abstain('blocked', 'diagnosis-invalid');
  let live = null;
  try { live = typeof activeHandle === 'function' ? activeHandle(record) : activeHandle; } catch { live = null; }
  if (!live || live.record !== record) return abstain('blocked', 'no-live-handle');
  if (record.state !== 'running') return abstain('blocked', 'record-not-running');
  if (typeof idleWriter !== 'function') return abstain('blocked', 'idle-assertion-missing');
  try { idleWriter(record); } catch { return abstain('blocked', 'writer-not-idle'); }
  if (guard.mode === 'recover' && typeof adapter !== 'function') return abstain('blocked', 'adapter-missing');
  const receiptBase = { incident_id: incident.id, incident_generation: incident.generation };
  let reservation;
  try { reservation = reserveIntent(authority, { workflow_id: workflowId, kind: 'cancel', subject_key: incident.id, source_revision: currentPacketHash, now }); }
  catch (error) { return abstain('blocked', publicHint(String(error?.message ?? error)), receiptBase); }
  if (!reservation || reservation.accepted !== true) {
    return abstain(reservation?.duplicate ? 'duplicate' : (reservation?.state ?? 'blocked'),
      (reservation?.reasons ?? []).join('; ') || null, { ...receiptBase, intent_id: reservation?.intent?.id ?? null });
  }
  const intentId = reservation.intent.id;
  if (guard.mode === 'shadow') {
    try { finishIntent(authority, { workflow_id: workflowId, intent_id: intentId, state: 'blocked', reason_code: 'shadow-would-cancel', now }); }
    catch { return { ...receiptBase, version: 1, launched: false, state: 'blocked', decision: 'abstain', reason_code: 'receipt-unpersisted', intent_id: intentId }; }
    return { ...receiptBase, version: 1, launched: false, state: 'shadow', decision: 'would-cancel', reason_code: 'shadow-would-cancel', intent_id: intentId };
  }
  try { finishIntent(authority, { workflow_id: workflowId, intent_id: intentId, state: 'requested', reason_code: 'requested', now }); }
  catch { return { ...receiptBase, version: 1, launched: false, state: 'blocked', decision: 'abstain', reason_code: 'requested-unpersisted', intent_id: intentId }; }
  try { onRequested({ id: intentId, incident_id: incident.id }); } catch { /* observation only. */ }
  // Reservation/request are immediately adjacent to synchronous adapter entry.
  let pending;
  try { pending = adapter(record, { incident, intent_id: intentId }); } catch { pending = Promise.reject(new Error('adapter-threw')); }
  try { onEntered({ id: intentId, incident_id: incident.id }); } catch { /* observation only; grants no veto. */ }
  let outcome = null;
  try { outcome = await pending; } catch { outcome = null; }
  const cancelled = isPlainObject(outcome) && outcome.state === 'cancelled';
  const finishState = cancelled ? 'applied' : (outcome == null ? 'unknown' : 'blocked');
  const reason = cancelled ? 'cancelled' : (outcome == null ? 'unknown' : 'not-cancelled');
  try { finishIntent(authority, { workflow_id: workflowId, intent_id: intentId, state: finishState, reason_code: reason, now }); }
  catch { return { ...receiptBase, version: 1, launched: true, state: 'unknown', decision: 'abstain', reason_code: 'receipt-unpersisted', intent_id: intentId }; }
  return { ...receiptBase, version: 1, launched: true, state: cancelled ? 'applied' : finishState, decision: cancelled ? 'cancelled' : 'abstain', reason_code: reason, intent_id: intentId };
}
