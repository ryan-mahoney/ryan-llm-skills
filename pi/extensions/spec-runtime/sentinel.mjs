// Session-local read-only workspace observer for the spec sentinel.
//
// The observer collects bounded workspace facts and renders them as plain
// status. It never starts, stops, messages or cancels a worker and never writes
// anything except the explicit enrollment record created by /spec-sentinel add.

import { watch, mkdirSync, renameSync, readdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname, sep } from 'node:path';

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
const MAX_TOOL_CALL_IDS = 8;
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

// Only completed spec_verify results reduce; every other decoded event leaves
// the snapshot reference untouched.
export function reduceVerificationResult(snapshot, { record, event }, now = Date.now) {
  if (!event || event.type !== 'tool_execution_end' || event.toolName !== 'spec_verify'
      || typeof event.toolCallId !== 'string' || !event.toolCallId) return { snapshot, incident: null };
  const packagePath = record?.package;
  const assignment = record?.assignment_id ?? record?.id;
  if (typeof packagePath !== 'string' || typeof assignment !== 'string' || !assignment) return { snapshot, incident: null };
  const observedAt = isoNow(now);
  const state = snapshot && snapshot.version === 1 && typeof snapshot.package === 'string'
    ? { ...snapshot, assignments: { ...snapshot.assignments } }
    : emptySnapshot(packagePath);
  state.package = packagePath;
  const previous = state.assignments[assignment] ?? {
    assignment_id: assignment, checkout: typeof record?.checkout === 'string' ? record.checkout : null,
    count: 0, fingerprint: null, tool_call_ids: [], state: 'idle', generation: 0, incident_id: null, linked_from: null,
    incident_fingerprint: null, observed_at: observedAt,
  };
  if (previous.tool_call_ids.includes(event.toolCallId)) return { snapshot, incident: null };

  const entry = { ...previous, tool_call_ids: [...previous.tool_call_ids, event.toolCallId].slice(-MAX_TOOL_CALL_IDS), observed_at: observedAt };
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
    if (entry.count >= 3 && !incidentMatches) {
      // A third matching failure opens one incident for this fingerprint
      // generation; the previous incident remains linked history.
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
  return join(packagePath, 'runtime', 'sentinel', 'verification-incidents.json');
}

export function readVerificationIncidents(packagePath) {
  const file = verificationIncidentsPath(packagePath);
  try {
    if (statSync(file).size > 65536) return null;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && value.version === 1 && value.package === packagePath && value.assignments
      && typeof value.assignments === 'object' ? value : null;
  } catch { return null; }
}

export function writeVerificationIncidents(packagePath, snapshot) {
  const file = verificationIncidentsPath(packagePath);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

// The recorder is the only writer; a read/write failure degrades observation and
// never propagates into the runtime's event callback.
export function createVerificationRecorder({ now = Date.now, read = readVerificationIncidents, write = writeVerificationIncidents } = {}) {
  return {
    observe(record, event) {
      try {
        const current = read(record?.package) ?? emptySnapshot(record?.package);
        const result = reduceVerificationResult(current, { record, event }, now);
        if (result.snapshot !== current) write(record.package, result.snapshot);
        return result;
      } catch { return null; }
    },
  };
}
