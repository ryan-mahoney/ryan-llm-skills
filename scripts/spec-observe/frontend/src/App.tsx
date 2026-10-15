import { For, Show, Switch, Match, createSignal, createMemo, createEffect, on, onMount, onCleanup } from 'solid-js';
import { getJson } from './api';
import { scan, scanError, startNextStepsPolling, stopNextStepsPolling } from './next-steps-store';
import { str, base, time, packageFilterMatches, setClock, tickClock, serverNow, stale, statusMarkdown } from './format';
import { catalog as modelsCatalog, loadCatalog as loadModelsCatalog } from './models-state';
import { normalizeEnvelope, authoritativeObservers, collectRecords, packageSummaries, collectAssignments, collectEpics, type Envelope, type WireRecord } from './model';
import Shell, { type ShellNavEntry } from './Shell';
import type { StatusTone } from './primitives';
import { parseHash, subscribeRoute, navigate, routeHistoryMode, type Destination, type RouteState } from './route';
import { clearIncompatibleFields, firstUnmatchedTargetId, inWorkspaceScope, needsWorkspacePicker, requiresWorkspace, scopeLabel, withWorkspace, type CatalogEntry } from './scope';
import { visibleSpecs } from './spec-state';
import { destinationEntries, type DestinationProps } from './destinations';
import { nextStepRows, railCount } from './destinations/next-steps-state';
import { WorkspacePicker } from './destinations/workspaces';
import { catalogRead, type WorkspaceCatalog } from './destinations/workspace-state';
import { memberRecords, visibleEpics as sharedVisibleEpics } from './destinations/epic-state';
import { getLaunchDraft, seedLaunchDraft } from './launch-state';
import { getConversationReturnId } from './conversations-state';
import { armLaunchPickerIntent, cancelLaunchPickerIntent, createLaunchPickerIntent, shouldApplyPickerReset, shouldResetAcknowledgedDraft } from './launch-picker-intent';
import { agentCoverage, effectiveAgentFilter, retainSelectedAgent, visibleAgents } from './agent-state';

type Filter = 'active' | 'attention' | 'completed' | 'ready';
type Catalog = WorkspaceCatalog;
const liveBrowser = () => location.protocol !== 'file:';

const registry = destinationEntries();
// Destinations render by registry lookup so adding a rail entry can never
// shift a positional binding onto a sibling adapter.
function DestinationOutlet(props: DestinationProps & { dest: Destination }) {
  const entry = registry.find(candidate => candidate.dest === props.dest);
  if (!entry) return null;
  const Render = entry.render;
  return <Render {...props} />;
}
const primaryNavEntries: ShellNavEntry[] = registry.filter(entry => entry.nav === 'primary').sort((a, b) => a.order - b.order).map(entry => ({ dest: entry.dest, label: entry.label }));
const directoryNav = registry.filter(entry => entry.nav === 'directory').sort((a, b) => a.order - b.order).map(entry => ({ dest: entry.dest, label: entry.label }));

export default function App() {
  const [route, setRoute] = createSignal<RouteState>(parseHash(location.hash));
  const [payload, setPayload] = createSignal<Envelope | null>(null);
  const [imported, setImported] = createSignal(false);
  const [error, setError] = createSignal('');
  const [fetching, setFetching] = createSignal(false);
  const [catalog, setCatalog] = createSignal<Catalog | null>(null);
  const [catalogError, setCatalogError] = createSignal('');
  const [workspace, setWorkspace] = createSignal<WireRecord | undefined>();
  const [workspaceError, setWorkspaceError] = createSignal('');
  const [catalogPending, setCatalogPending] = createSignal(false);
  const [workspacePending, setWorkspacePending] = createSignal(false);
  const [catalogLoadedAt, setCatalogLoadedAt] = createSignal<number | null>(null);
  const [workspaceLoadedAt, setWorkspaceLoadedAt] = createSignal<number | null>(null);
  const [catalogDelayed, setCatalogDelayed] = createSignal(false);
  const [workspaceDelayed, setWorkspaceDelayed] = createSignal(false);
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [expectedCompletionKey, setExpectedCompletionKey] = createSignal<string | null>(null);
  const [expectedCompletionRoute, setExpectedCompletionRoute] = createSignal<RouteState | null>(null);
  const [endedSessions, setEndedSessions] = createSignal<string[]>([]);
  // Bounded Agents retained selection: the last row resolved for an explicit
  // route id, tagged with the scope/import context it was read under.
  const [retainedAgent, setRetainedAgent] = createSignal<{ row: WireRecord | null; id: string; ws: string | undefined; imported: boolean } | null>(null);
  let stateGeneration = 0, catalogGeneration = 0, workspaceGeneration = 0;
  let workspaceBusyId: string | null = null;
  let catalogTimer: ReturnType<typeof setTimeout> | undefined;
  let workspaceTimer: ReturnType<typeof setTimeout> | undefined;
  // Explicit new-assignment intent for Agents -> All workspaces -> Launch
  // agent -> picker choice. Armed only by prepareAgentAssignment without a
  // concrete workspace; consumed only by the picker choice that completes
  // that entry. Generic scope/history navigation abandons it without
  // resetting any draft.
  const launchPickerIntent = createLaunchPickerIntent();

  const live = () => liveBrowser() && !imported();
  const scopeWs = () => route().ws;
  const routeTitle = () => registry.find(entry => entry.dest === route().dest)?.label ?? 'Specs';
  // The shell h1 follows the reference for Next steps while the rail and
  // breadcrumb keep the registry label.
  const title = () => route().dest === 'next-steps' ? 'New files waiting for a next step' : routeTitle();
  const currentDestination = () => registry.find(entry => entry.dest === route().dest)?.parent ?? route().dest;
  const catalogEntries = () => catalog()?.valid ?? [];
  const records = createMemo(() => collectRecords(payload()));
  const scopedRecords = createMemo(() => records().filter(record => inWorkspaceScope(record, 'run', scopeWs(), catalogEntries())));
  const assignments = createMemo(() => collectAssignments(payload()).map(a => !imported() && endedSessions().includes(String(a.assignment_id)) ? { ...a, display: 'ended', recordedState: 'ended', observedState: 'ended', task_activity: undefined, quiet: false, nextAction: 'History', safeAction: 'History' } : a));
  const scopedAssignments = createMemo(() => assignments().filter(assignment => inWorkspaceScope(assignment, 'assignment', scopeWs(), catalogEntries())));
  const epics = createMemo(() => collectEpics(payload()));
  const scopedEpics = createMemo(() => epics().filter(epic => inWorkspaceScope(epic, 'epic', scopeWs(), catalogEntries())));
  const query = () => route().q ?? '';
  const filter = (): Filter => {
    const value = route().filter;
    if (value === 'attention' || value === 'completed') return value;
    if (value === 'ready' || value === 'planned') return 'ready';
    return 'active';
  };
  const q = () => query().trim().toLowerCase();
  const visibleRecords = createMemo(() => visibleSpecs(scopedRecords(), filter(), query()));
  const visibleAssignments = createMemo(() => scopedAssignments().filter(assignment => !q() || [assignment.assignment_id, assignment.spec_package, assignment.workflow_id, assignment.display, assignment.nextAction, assignment.safeAction].some(value => str(value).toLowerCase().includes(q()))));
  const visibleEpics = createMemo(() => sharedVisibleEpics(scopedEpics(), route().q ?? ''));
  const record = createMemo(() => scopedRecords().find(item => item.key === route().id) ?? null);
  const agent = createMemo(() => scopedAssignments().find(item => item.key === route().id) ?? null);
  const epic = createMemo(() => scopedEpics().find(item => item.key === route().id) ?? null);
  const agentsFilter = createMemo(() => effectiveAgentFilter(route(), scopedAssignments()));
  const visibleAgentRows = createMemo(() => visibleAgents(scopedAssignments(), agentsFilter(), route().q ?? ''));
  // The stored pin feeds coverage only while it still matches the requested
  // id/scope/import context; an unrelated previous row must not contaminate
  // the selected-source facts.
  const retainedCandidate = createMemo(() => {
    const stored = retainedAgent();
    if (!stored || stored.ws !== scopeWs() || stored.imported !== imported()) return null;
    if (stored.id !== (route().id ?? '')) return null;
    return stored.row;
  });
  // A retained row missing from this read still names its owning workspace so
  // that an incomplete owning source qualifies the list; it is never added to
  // the rendered rows or counts themselves.
  const agentsCoverageRows = createMemo(() => {
    const rows = scopedAssignments();
    const retained = retainedCandidate();
    if (!retained || rows.length === 0 || rows.some(row => row.key === retained.key)) return rows;
    return [...rows, retained];
  });
  const agentsCoverage = createMemo(() => agentCoverage(payload(), agentsCoverageRows(), agent() ?? retainedCandidate()));
  const agentsSelected = createMemo(() => {
    const coverage = agentsCoverage();
    const sourceComplete = payload() !== null && coverage.selectedSourceComplete;
    return retainSelectedAgent(agent(), retainedCandidate(), true, sourceComplete);
  });
  const agentsSelectionRetained = createMemo(() => agent() === null && agentsSelected() !== null);
  const token = () => live() && !error() ? payload()?.thread_action_token || payload()?.action_token : undefined;
  const newThreadUnavailableReason = () => !live()
    ? 'New thread is available on the live dashboard.'
    : !token()
      ? 'Reconnect to the live dashboard before starting a conversation.'
      : '';
  const completionToken = () => live() && !error() ? payload()?.action_token : undefined;
  // Rail waiting badge: only a trustworthy live scan in the current scope with
  // a positive count shows one; imported, offline, errored or unread scans
  // show none, and query/stage filters never change the count.
  const nextStepsWaitingCount = createMemo<number | undefined>(() => {
    if (!live() || imported() || scanError() !== '' || scan() === null) return undefined;
    const rows = nextStepRows(scan(), {
      records: records(),
      assignments: assignments(),
      epics: epics(),
      catalog: catalogEntries(),
      scope: scopeWs(),
      token: completionToken() ?? null,
      live: live(),
      connectionFailed: Boolean(error()),
      now: serverNow(),
    });
    const count = railCount(rows);
    return count > 0 ? count : undefined;
  });
  const primaryNav = createMemo<ShellNavEntry[]>(() => {
    const count = nextStepsWaitingCount();
    return primaryNavEntries.map(entry => entry.dest === 'next-steps' && count !== undefined ? { ...entry, count } : entry);
  });
  const observers = createMemo(() => authoritativeObservers(payload()?.observers ?? []));
  const scopedObservers = createMemo(() => observers().filter(observer => inWorkspaceScope({ workspace: str(observer.snapshot?.workspace) || str(observer.observer_id) || str(observer.source) || 'unknown' }, 'run', scopeWs(), catalogEntries())));
  const freshObservers = () => observers().filter(observer => observer.state === 'observing' && !stale(observer.published_at));
  const epicSupport = () => !observers().length ? 'No observer snapshots' : !observers().some(observer => Array.isArray(observer.snapshot?.epics)) ? 'Epic data unavailable' : null;
  const connectionLabel = () => imported() ? 'Imported snapshot' : error() ? 'Connection unavailable' : freshObservers().length ? 'Monitor connected' : observers().length ? 'Monitor stale' : 'Waiting for monitor';
  const connectionTone = (): StatusTone => imported() ? 'info' : error() ? 'error' : freshObservers().length ? 'success' : observers().length ? 'warning' : 'neutral';
  const observedAt = () => {
    const value = payload()?.generated_at;
    return typeof value === 'string' && value ? time(value) : undefined;
  };
  const workspaceOptions = () => catalogEntries().map(entry => ({ id: String(entry.id), label: String(entry.name || entry.id || entry.directory || 'unknown') }));
  const portfolioTargetId = () => firstUnmatchedTargetId(records(), 'run', catalogEntries())
    ?? firstUnmatchedTargetId(assignments(), 'assignment', catalogEntries())
    ?? firstUnmatchedTargetId(epics(), 'epic', catalogEntries());
  const crumbs = () => [scopeLabel(scopeWs(), catalogEntries(), scopeWs() ? undefined : portfolioTargetId()), routeTitle()];
  const packageFilesRoute = () => route().dest === 'files' && route().source === 'package' && Boolean(route().id);
  const pickerRequired = () => needsWorkspacePicker(route()) && !packageFilesRoute();
  // Workspaces, the workspace-required destinations and Epics keep the current
  // workspace detail. Epics resolves a decision's canonical package target to
  // its repository alias from that record before seeding a conversation; the
  // record stays optional there and never gates the route or its picker.
  const detailWorkspaceId = createMemo(() => route().dest === 'workspaces' || route().dest === 'epics'
    ? route().ws
    : requiresWorkspace(route().dest) && !packageFilesRoute() ? route().ws : undefined);

  function go(next: RouteState, options: { keepExpected?: boolean } = {}) {
    if (!options.keepExpected) { setExpectedCompletionKey(null); setExpectedCompletionRoute(null); expectedSeen = false; }
    navigate(next, routeHistoryMode(route(), next));
  }
  function goDestination(dest: Destination) {
    const ws = route().ws;
    const next: RouteState = { dest, ...(ws !== undefined ? { ws } : {}) };
    // Conversations is the only destination that restores its last explicitly
    // selected thread on rail return; every other destination keeps its
    // existing scope-only navigation.
    if (dest === 'conversations' && ws !== undefined) {
      const remembered = getConversationReturnId(ws);
      if (remembered) next.id = remembered;
    }
    go(next);
  }
  function prepareAgentAssignment() {
    const ws = scopeWs();
    if (ws) {
      const context = { ws };
      if (shouldResetAcknowledgedDraft(getLaunchDraft(context))) {
        seedLaunchDraft(context, { title: '', content: '' });
      }
    } else {
      // All workspaces: no concrete draft exists yet. Arm the explicit
      // new-assignment intent so the picker choice can apply the
      // acknowledged-success reset once the workspace is known.
      armLaunchPickerIntent(launchPickerIntent);
    }
    goDestination('launch');
  }
  function selectId(id: string) {
    go({ ...clearIncompatibleFields(route()), id });
  }
  function setQuery(value: string) {
    const next: RouteState = { ...route() };
    if (value) next.q = value;
    else delete next.q;
    go(next);
  }
  function setFilter(value: string) {
    const next: RouteState = { ...route() };
    if (value === 'active') delete next.filter;
    else next.filter = value;
    go(next);
  }
  function setOpenFile(path: string) {
    go({ ...route(), path });
  }
  function chooseScope(ws: string | undefined) {
    // Generic scope navigation never applies the acknowledged-success
    // reset; abandon any armed picker intent without touching drafts.
    cancelLaunchPickerIntent(launchPickerIntent);
    go(withWorkspace(route(), ws));
  }
  function chooseWorkspace(id: string) {
    // Explicit picker completion of an armed All-workspaces entry: apply
    // the acknowledged-success reset for the concrete workspace, then
    // disarm. Generic picker visits without an armed intent navigate
    // unchanged, and pending/failed/unconfirmed entries are preserved.
    if (shouldApplyPickerReset(launchPickerIntent, route().dest)) {
      const context = { ws: id };
      if (shouldResetAcknowledgedDraft(getLaunchDraft(context))) {
        seedLaunchDraft(context, { title: '', content: '' });
      }
      cancelLaunchPickerIntent(launchPickerIntent);
    }
    // Choosing a workspace also abandons the in-flight completion exception:
    // the recorded Done route and its one-shot focus guard no longer apply.
    setExpectedCompletionKey(null);
    setExpectedCompletionRoute(null);
    expectedSeen = false;
    navigate(withWorkspace(route(), id), 'push');
  }
  function replaceId(value: string | null) {
    const next: RouteState = { ...route() };
    if (value) next.id = value;
    else delete next.id;
    navigate(next, routeHistoryMode(route(), next, { fallback: true }));
  }
  function openPackage(workspaceName: string, name: string) {
    const matches = memberRecords(packageSummaries(scopedRecords()), workspaceName, name);
    const target = matches.find(item => packageFilterMatches(item, 'active'))
      ?? matches.find(item => item.planned)
      ?? matches.find(item => !item.recent_completion) ?? matches[0];
    if (!target) return;
    const next: RouteState = { dest: 'specs', id: target.key };
    if (scopeWs() !== undefined) next.ws = scopeWs();
    if (target.recent_completion) next.filter = 'completed';
    else if (target.planned) next.filter = 'ready';
    go(next);
  }
  function canOpenPackageFiles(item: WireRecord) {
    return Boolean(str(item.package));
  }
  function openPackageFiles(item: WireRecord, path?: string) {
    const pkg = str(item.package);
    if (!pkg) return;
    const next: RouteState = { dest: 'files', source: 'package', id: pkg };
    if (scopeWs()) next.ws = scopeWs();
    if (path) next.path = path;
    go(next);
  }
  // Completion navigates to the recorded row's own Done key. The expected key
  // keeps the fallback from selecting an unrelated Done row while the next
  // observation catches up; explicit navigation releases it, including native
  // Specs history/hash navigation that bypasses go().
  function onCompletionRecorded(item: WireRecord) {
    const key = JSON.stringify([str(item.workspace), str(item.package), 'recent-completion']);
    const next: RouteState = { dest: 'specs', id: key, filter: 'completed' };
    if (scopeWs() !== undefined) next.ws = scopeWs();
    setExpectedCompletionKey(key);
    setExpectedCompletionRoute(next);
    expectedSeen = false;
    go(next, { keepExpected: true });
  }
  function manualRefresh() {
    void refresh(true);
    if (live()) void loadCatalog();
  }
  async function refresh(manual = false) {
    if (fetching()) return;
    if (manual) { setImported(false); setRefreshKey(k => k + 1); }
    if (imported()) return;
    if (!liveBrowser()) { setError('Import a published snapshot to inspect it offline.'); return; }
    const request = ++stateGeneration;
    setFetching(true);
    try {
      const value = normalizeEnvelope(await getJson<unknown>('/api/state', AbortSignal.timeout(10000)));
      if (request !== stateGeneration || imported()) return;
      setClock(value.generated_at);
      setPayload(value);
      setError('');
    } catch {
      if (request === stateGeneration && !imported()) setError('Could not refresh workspace state. Retry to reconnect.');
    } finally {
      if (request === stateGeneration) setFetching(false);
    }
  }
  async function loadCatalog() {
    if (!live() || catalogPending()) return;
    setCatalogPending(true);
    clearTimeout(catalogTimer);
    catalogTimer = setTimeout(() => setCatalogDelayed(true), 300);
    const request = ++catalogGeneration;
    try {
      const value = await getJson<Catalog>('/api/workspaces');
      if (request !== catalogGeneration || !live()) return;
      const read = catalogRead(value, catalog());
      setCatalog(read.catalog);
      setCatalogError(read.degraded ? 'Workspaces could not be read completely. Your selection is kept. Retry.' : '');
      if (read.degraded) return;
      setCatalogLoadedAt(serverNow() ?? Date.now());
      const detailId = detailWorkspaceId();
      if (detailId && !value.valid.some(workspaceEntry => workspaceEntry.id === detailId)) {
        workspaceGeneration++;
        workspaceBusyId = null;
        clearTimeout(workspaceTimer);
        workspaceTimer = undefined;
        setWorkspacePending(false);
        setWorkspaceDelayed(false);
        setWorkspaceLoadedAt(null);
        setWorkspace(undefined);
        setWorkspaceError('Selected workspace is no longer in the catalog.');
      } else if (detailId) {
        void loadWorkspace(detailId);
      }
    } catch {
      if (request === catalogGeneration) setCatalogError('Could not load workspaces.');
    } finally {
      if (request === catalogGeneration) {
        clearTimeout(catalogTimer);
        catalogTimer = undefined;
        setCatalogPending(false);
        setCatalogDelayed(false);
      }
    }
  }
  async function loadWorkspace(id: string) {
    if (!live() || !id || workspaceBusyId === id) return;
    workspaceBusyId = id;
    setWorkspacePending(true);
    clearTimeout(workspaceTimer);
    workspaceTimer = setTimeout(() => setWorkspaceDelayed(true), 300);
    const request = ++workspaceGeneration;
    try {
      const value = await getJson<WireRecord>('/api/workspace?' + new URLSearchParams({ id }));
      if (request !== workspaceGeneration || detailWorkspaceId() !== id || !live()) return;
      setWorkspace(value);
      setWorkspaceError('');
      setWorkspaceLoadedAt(serverNow() ?? Date.now());
    } catch {
      if (request === workspaceGeneration && detailWorkspaceId() === id) setWorkspaceError('Workspace details could not be loaded. Retry.');
    } finally {
      if (request === workspaceGeneration && workspaceBusyId === id) workspaceBusyId = null;
      if (request === workspaceGeneration) {
        clearTimeout(workspaceTimer);
        workspaceTimer = undefined;
        setWorkspacePending(false);
        setWorkspaceDelayed(false);
      }
    }
  }
  async function importSnapshot(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 12 * 1024 * 1024) throw Error('File too large.');
      const value = normalizeEnvelope(JSON.parse(await file.text()));
      stateGeneration++;
      catalogGeneration++;
      workspaceGeneration++;
      stopNextStepsPolling();
      workspaceBusyId = null;
      clearTimeout(catalogTimer);
      clearTimeout(workspaceTimer);
      catalogTimer = undefined;
      workspaceTimer = undefined;
      setCatalogPending(false);
      setWorkspacePending(false);
      setCatalogDelayed(false);
      setWorkspaceDelayed(false);
      setCatalogLoadedAt(null);
      setWorkspaceLoadedAt(null);
      setFetching(false);
      setClock(undefined);
      setPayload(value);
      setImported(true);
      setError('');
      setCatalog(null);
      setCatalogError('');
      setWorkspace(undefined);
      setWorkspaceError('');
      setExpectedCompletionKey(null);
      setExpectedCompletionRoute(null);
      expectedSeen = false;
      navigate({ dest: 'specs' }, 'replace');
    } catch {
      setError('Choose a valid Sentinel JSON snapshot smaller than 12 MB.');
    }
  }
  function storageDiagnostics() {
    const current = catalog(), storage = current?.storage;
    if (!current) return [];
    const seen = new Set<string>();
    return [...(storage?.errors ?? []), ...(current.errors ?? [])].map(errorEntry => typeof errorEntry === 'object' ? errorEntry : { message: errorEntry }).filter(errorEntry => {
      const key = JSON.stringify([errorEntry.path, errorEntry.message]);
      if (errorEntry.message === storage?.status || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function notes() {
    const out: string[] = [];
    // Workspaces, Epics, Specs and Agents own their connection/coverage and freshness
    // recovery in the destination, so the global strip must not duplicate or shift it.
    const destinationNotes = ['workspaces', 'epics', 'specs', 'agents', 'next-steps'].includes(route().dest) || pickerRequired();
    if (error() && !destinationNotes) out.push(error());
    if (payload()?.truncated) out.push('Snapshot read budget reached; some observations are unavailable.');
    for (const e of payload()?.errors ?? []) out.push(`${e.source ? str(e.source) + ': ' : ''}${str(e.message)}`);
    if (!imported() && !error() && observers().length && !freshObservers().length && !destinationNotes) out.push('Observer heartbeat is stale; work may have continued since this snapshot.');
    for (const observer of observers()) for (const a of observer.snapshot?.attention ?? []) if (a.kind === 'legacy-location') out.push(`Untracked .specs in ${a.repository} (${a.count} entries). Remedy: ${a.remedy}.`);
    return out;
  }

  // Follow a package across dispatches without replacing the components that own editors.
  let selectedIdentity: { workspace: string; package: string } | null = null;
  let expectedSeen = false;
  createEffect(() => {
    const currentRoute = route();
    if (!payload()) return;
    if (scopeWs() && !catalog()) return;
    const currentId = currentRoute.id ?? null;
    if (currentRoute.dest !== 'specs' && expectedCompletionKey() !== null) { setExpectedCompletionKey(null); setExpectedCompletionRoute(null); expectedSeen = false; }
    if (currentRoute.dest === 'specs') {
      const current = scopedRecords().find(item => item.key === currentId);
      if (current) selectedIdentity = { workspace: str(current.workspace), package: str(current.package) };
      const rows = visibleRecords();
      const expected = expectedCompletionKey();
      const expectedRoute = expectedCompletionRoute();
      if (expected !== null && expectedRoute !== null) {
        // Native Specs history/hash navigation bypasses go(), so release here
        // when the Specs context (scope/filter/query/selection/tab) leaves the
        // recorded completion navigation. Delayed-target no-steal applies only
        // while the route still matches that navigation.
        const diverged = currentRoute.ws !== expectedRoute.ws
          || currentRoute.id !== expectedRoute.id
          || currentRoute.filter !== expectedRoute.filter
          || (currentRoute.q ?? '') !== (expectedRoute.q ?? '')
          || (currentRoute.tab ?? '') !== (expectedRoute.tab ?? '');
        if (!diverged) expectedSeen = true;
        if (diverged) {
          // The route signal can still hold the pre-completion value when this
          // effect first observes the newly armed exception; wait for the
          // recorded navigation instead of releasing to an unrelated fallback.
          if (!expectedSeen) {
            if (!rows.some(item => item.key === expected)) return;
          } else {
            setExpectedCompletionKey(null);
            setExpectedCompletionRoute(null);
            expectedSeen = false;
          }
        } else if (!rows.some(item => item.key === expected)) {
          // The recorded completion is not in observed rows yet; keep the pending
          // key instead of falling back to an unrelated Done row.
          return;
        }
      } else if (expected !== null && !rows.some(item => item.key === expected)) {
        // Armed without a recorded route; preserve no-steal.
        return;
      }
      if (!rows.some(item => item.key === currentId)) {
        const followed = currentId && selectedIdentity ? rows.find(item => !item.recent_completion && item.is_current_assignment === true && item.workspace === selectedIdentity!.workspace && item.package === selectedIdentity!.package) : undefined;
        replaceId(followed?.key ?? rows[0]?.key ?? null);
      }
    } else if (currentRoute.dest === 'agents') {
      const current = currentId ? scopedAssignments().find(item => item.key === currentId) ?? null : null;
      if (current) {
        // A resolved selection pins the retained row and keeps the URL
        // identity; polling never swaps it for a sibling row.
        setRetainedAgent({ row: current, id: currentId ?? '', ws: scopeWs(), imported: imported() });
      } else if (!currentId) {
        const first = visibleAgentRows()[0]?.key ?? null;
        if (first) replaceId(first);
      } else {
        // An explicit id absent from this read keeps its URL verbatim, but
        // the stored pin must not survive invalidation: a complete
        // owning-source absence drops it so a later partial read cannot
        // resurrect it, and moving to another id drops the previous pin.
        // Same-id incomplete reads keep their pin via the retained memo.
        const stored = retainedAgent();
        if (stored && stored.id !== currentId) {
          setRetainedAgent(null);
        } else if (stored) {
          const coverage = agentsCoverage();
          if (payload() !== null && coverage.selectedSourceComplete) setRetainedAgent(null);
        }
      }
      // polling never swaps a resolved selection for a sibling row.
    } else if (currentRoute.dest === 'epics') {
      const rows = visibleEpics();
      if (!rows.some(item => item.key === currentId)) replaceId(rows[0]?.key ?? null);
    }
  });

  // Move focus to the observed completion row once per appearance and restore it
  // when snapshot re-renders detach the focused row; focus is never taken from a
  // live explicit element. The expected key is released by explicit go()
  // navigation or by native Specs navigation away from the recorded completion
  // route, so a transient row appearance cannot let the fallback select an
  // unrelated Done row.
  let focusedCompletionKey: string | null = null;
  createEffect(() => {
    const key = expectedCompletionKey();
    if (focusedCompletionKey !== key) focusedCompletionKey = null;
    if (!key) return;
    if (route().dest !== 'specs' || route().id !== key) return;
    if (!scopedRecords().some(item => item.key === key)) {
      // Re-arm once the row leaves observations so its next appearance focuses.
      focusedCompletionKey = null;
      return;
    }
    const detached = document.activeElement === null || document.activeElement === document.body || document.activeElement === document.documentElement;
    if (focusedCompletionKey === key && !detached) return;
    focusedCompletionKey = key;
    const frame = requestAnimationFrame(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('.records [data-key]')).find(element => element.dataset.key === key);
      row?.focus({ preventScroll: true });
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  // Retained Agents facts belong to one scope/import context; a genuine
  // scope/import change drops the stored row, while same-context navigation
  // (selection, query, refresh) preserves the pin.
  createEffect(on(() => [scopeWs(), imported()] as const, ([ws, imp]) => {
    const stored = retainedAgent();
    if (stored && (stored.ws !== ws || stored.imported !== imp)) setRetainedAgent(null);
  }, { defer: true }));

  // An armed All-workspaces launch intent survives only inside the launch
  // picker (launch without a workspace). Any other arrival abandons it
  // without resetting drafts. The picker choice consumes synchronously
  // before navigating, so this branch runs only for non-picker arrivals.
  createEffect(() => {
    const current = route();
    if (launchPickerIntent.armed && (current.dest !== 'launch' || current.ws !== undefined)) {
      cancelLaunchPickerIntent(launchPickerIntent);
    }
  });

  // Scope and workspace selection changes clear retained detail before loading,
  // including history navigation back to a previous scope.
  createEffect(on(detailWorkspaceId, (id, previous) => {
    workspaceGeneration++;
    workspaceBusyId = null;
    clearTimeout(workspaceTimer);
    workspaceTimer = undefined;
    setWorkspacePending(false);
    setWorkspaceDelayed(false);
    setWorkspaceLoadedAt(null);
    setWorkspace(undefined);
    setWorkspaceError('');
    if (id && id !== previous && live()) void loadWorkspace(id);
  }));

  // The scan store owns the single /api/next-steps transport and lifetime;
  // live transitions start it and import/offline transitions stop it.
  createEffect(() => {
    if (live()) startNextStepsPolling();
    else stopNextStepsPolling();
  });

  onMount(() => {
    const unsubscribe = subscribeRoute(setRoute);
    navigate(parseHash(location.hash), 'replace');
    void refresh();
    if (live()) void loadCatalog();
    const poll = setInterval(() => {
      void refresh();
      if (live()) void loadCatalog();
    }, 5000);
    const clock = setInterval(tickClock, 1000);
    onCleanup(() => {
      unsubscribe();
      clearInterval(poll);
      clearInterval(clock);
      clearTimeout(catalogTimer);
      clearTimeout(workspaceTimer);
      catalogTimer = undefined;
      workspaceTimer = undefined;
      stateGeneration++;
      catalogGeneration++;
      workspaceGeneration++;
      stopNextStepsPolling();
    });
  });

  const outletProps: DestinationProps = {
    get route() { return route(); },
    get payload() { return payload(); },
    get live() { return live(); },
    get specsLive() { return live() && !error(); },
    get records() { return scopedRecords(); },
    get assignments() { return scopedAssignments(); },
    get agentsSelected() { return agentsSelected(); },
    get agentsSelectionRetained() { return agentsSelectionRetained(); },
    get agentsCoverage() { return agentsCoverage(); },
    get epics() { return scopedEpics(); },
    get scopedObservers() { return scopedObservers(); },
    get epicSupport() { return epicSupport(); },
    get catalog() { return catalogEntries(); },
    get catalogInvalid() { return catalog()?.invalid ?? []; },
    get catalogStorage() { return catalog()?.storage; },
    get catalogError() { return catalogError(); },
    get storageDiagnostics() { return storageDiagnostics(); },
    get workspace() { return workspace(); },
    get workspaceError() { return workspaceError(); },
    get catalogLoaded() { return catalog() !== null; },
    get catalogPending() { return catalogPending(); },
    get workspacePending() { return workspacePending(); },
    get catalogDelayed() { return catalogDelayed(); },
    get workspaceDelayed() { return workspaceDelayed(); },
    get connectionFailed() { return Boolean(error()); },
    get catalogLoadedAt() { return catalogLoadedAt(); },
    get workspaceLoadedAt() { return workspaceLoadedAt(); },
    get token() { return token(); },
    get completionToken() { return completionToken(); },
    get completionLocalOnly() { return payload()?.completion === 'local-only'; },
    get refreshKey() { return refreshKey(); },
    refresh: () => refresh(),
    onNavigate: go,
    onSelect: selectId,
    onQuery: setQuery,
    onFilter: setFilter,
    onOpenFile: setOpenFile,
    onCompletionRecorded,
    onEnded: id => setEndedSessions(prev => prev.includes(id) ? prev : [...prev, id]),
    onSelectPackage: openPackage,
    onOpenPackageFiles: openPackageFiles,
    canOpenPackageFiles,
    onRetryWorkspace: id => void loadWorkspace(id),
    onRetryCatalog: () => void loadCatalog(),
    onRetryConnection: () => void refresh(),
    onChooseWorkspace: chooseWorkspace,
  };

  return <>
    <Shell
      route={route()}
      currentDestination={currentDestination()}
      primaryNav={primaryNav()}
      directoryNav={directoryNav}
      workspaceOptions={workspaceOptions()}
      scope={scopeWs()}
      onScopeChange={chooseScope}
      onDestination={goDestination}
      home={!imported() && scopeWs() === undefined ? 'next-steps' : 'specs'}
      crumbs={crumbs()}
      title={title()}
      headerActions={route().dest === 'launch'
        ? <button class="ds-btn" type="button" onClick={() => goDestination('agents')}>Return to agents</button>
        : route().dest === 'workspaces'
          ? <button class="ds-btn" type="button" aria-busy={catalogPending()} onClick={() => void loadCatalog()}>Refresh workspaces</button>
          : route().dest === 'models'
            ? <Show when={live() && !error() && token() && modelsCatalog().status === 'ready' && !modelsCatalog().stale}><button class="ds-btn" type="button" aria-busy={modelsCatalog().refreshing} disabled={modelsCatalog().refreshing} onClick={() => loadModelsCatalog(true)}>Refresh catalog</button></Show>
            : route().dest === 'agents'
              ? <><button id="launch-agent-action" class="ds-btn ds-btn--primary" type="button" onClick={prepareAgentAssignment}>Launch agent</button><button class="ds-btn" type="button" aria-busy={fetching()} onClick={manualRefresh}>Refresh state</button></>
              : route().dest === 'conversations'
                ? <><button id="thread-new-action" class="ds-btn ds-btn--primary" type="button" disabled={!live() || !token()} title={newThreadUnavailableReason()} aria-describedby={!live() || !token() ? 'thread-new-action-reason' : undefined} onClick={() => go({ ...route(), tab: 'new' })}>New thread</button><Show when={!live() || !token()}><span id="thread-new-action-reason" class="sr-only">{newThreadUnavailableReason()}</span></Show><button class="ds-btn" type="button" aria-busy={fetching()} onClick={manualRefresh}>Refresh state</button></>
                : route().dest === 'next-steps'
                  ? undefined
                : <button class="ds-btn" type="button" aria-busy={fetching()} onClick={manualRefresh}>Refresh state</button>}
      connection={{ label: connectionLabel(), tone: connectionTone() }}
      observedAt={observedAt()}
      onRefresh={manualRefresh}
      onImport={file => void importSnapshot(file)}
    >
      <Show when={notes().length}>
        <div id="notice" class="notice" role="status"><For each={notes()}>{note => <p innerHTML={statusMarkdown(note)} />}</For></div>
      </Show>
      <Show
        when={pickerRequired()}
        fallback={
          <Switch>
            <Match when={route().dest === 'next-steps'}><DestinationOutlet dest="next-steps" {...outletProps} /></Match>
            <Match when={route().dest === 'specs'}><DestinationOutlet dest="specs" {...outletProps} /></Match>
            <Match when={route().dest === 'epics'}><DestinationOutlet dest="epics" {...outletProps} /></Match>
            <Match when={route().dest === 'agents'}><DestinationOutlet dest="agents" {...outletProps} /></Match>
            <Match when={route().dest === 'conversations'}><DestinationOutlet dest="conversations" {...outletProps} /></Match>
            <Match when={route().dest === 'files'}><DestinationOutlet dest="files" {...outletProps} /></Match>
            <Match when={route().dest === 'designs'}><DestinationOutlet dest="designs" {...outletProps} /></Match>
            <Match when={route().dest === 'workspaces'}><DestinationOutlet dest="workspaces" {...outletProps} /></Match>
            <Match when={route().dest === 'launch'}><DestinationOutlet dest="launch" {...outletProps} /></Match>
            <Match when={route().dest === 'models'}><DestinationOutlet dest="models" {...outletProps} /></Match>
          </Switch>
        }
      >
        <WorkspacePicker {...outletProps} />
      </Show>
    </Shell>
  </>;
}
