import { For, Show, Switch, Match, createSignal, createMemo, createEffect, on, onMount, onCleanup } from 'solid-js';
import { getJson, postJson } from './api';
import { str, base, time, packageFilterMatches, setClock, tickClock, serverNow, stale, statusMarkdown } from './format';
import { normalizeEnvelope, authoritativeObservers, collectRecords, collectAssignments, collectEpics, type Envelope, type WireRecord } from './model';
import Shell from './Shell';
import type { StatusTone } from './primitives';
import { parseHash, subscribeRoute, navigate, routeHistoryMode, type Destination, type RouteState } from './route';
import { clearIncompatibleFields, firstUnmatchedTargetId, inWorkspaceScope, needsWorkspacePicker, requiresWorkspace, scopeLabel, withWorkspace, type CatalogEntry } from './scope';
import { destinationEntries, type DestinationProps } from './destinations';
import { WorkspacePicker } from './destinations/workspaces';
import { catalogRead, type WorkspaceCatalog } from './destinations/workspace-state';
import { getLaunchDraft, seedLaunchDraft } from './launch-state';

type Filter = 'active' | 'attention' | 'completed' | 'planned';
type Catalog = WorkspaceCatalog;
const liveBrowser = () => location.protocol !== 'file:';

const registry = destinationEntries();
const [SpecsAdapter, EpicsAdapter, AgentsAdapter, ConversationsAdapter, FilesAdapter, DesignsAdapter, WorkspacesAdapter, LaunchAdapter] = registry.map(entry => entry.render);
const primaryNav = registry.filter(entry => entry.nav === 'primary').sort((a, b) => a.order - b.order).map(entry => ({ dest: entry.dest, label: entry.label }));
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
  const [completion, setCompletion] = createSignal<WireRecord | null>(null);
  const [completionBusy, setCompletionBusy] = createSignal(false);
  const [completionError, setCompletionError] = createSignal('');
  const [endedSessions, setEndedSessions] = createSignal<string[]>([]);
  let dialog!: HTMLDialogElement;
  let stateGeneration = 0, catalogGeneration = 0, workspaceGeneration = 0;
  let workspaceBusyId: string | null = null;
  let catalogTimer: ReturnType<typeof setTimeout> | undefined;
  let workspaceTimer: ReturnType<typeof setTimeout> | undefined;

  const live = () => liveBrowser() && !imported();
  const scopeWs = () => route().ws;
  const title = () => registry.find(entry => entry.dest === route().dest)?.label ?? 'Specs';
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
    return value === 'attention' || value === 'completed' || value === 'planned' ? value : 'active';
  };
  const q = () => query().trim().toLowerCase();
  const visibleRecords = createMemo(() => scopedRecords().filter(record => (!q() || [record.workspace, record.package_ref, record.package, record.activity, record.obligation, record.execution, record.workflow_state].some(value => str(value).toLowerCase().includes(q()))) && packageFilterMatches(record, filter())).sort((a, b) => filter() === 'completed' ? Date.parse(b.completed_at) - Date.parse(a.completed_at) || str(a.package).localeCompare(str(b.package)) : 0));
  const visibleAssignments = createMemo(() => scopedAssignments().filter(assignment => !q() || [assignment.assignment_id, assignment.spec_package, assignment.workflow_id, assignment.display, assignment.nextAction, assignment.safeAction].some(value => str(value).toLowerCase().includes(q()))));
  const visibleEpics = createMemo(() => scopedEpics().filter(epic => !q() || [epic.title, epic.epic, epic.workspace, ...(epic.members ?? []).map((member: WireRecord) => member.name)].some(value => str(value).toLowerCase().includes(q()))));
  const record = createMemo(() => scopedRecords().find(item => item.key === route().id) ?? null);
  const agent = createMemo(() => scopedAssignments().find(item => item.key === route().id) ?? null);
  const epic = createMemo(() => scopedEpics().find(item => item.key === route().id) ?? null);
  const token = () => live() && !error() ? payload()?.thread_action_token || payload()?.action_token : undefined;
  const completionToken = () => live() && !error() ? payload()?.action_token : undefined;
  const observers = createMemo(() => authoritativeObservers(payload()?.observers ?? []));
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
  const crumbs = () => [scopeLabel(scopeWs(), catalogEntries(), scopeWs() ? undefined : portfolioTargetId()), title()];
  const packageFilesRoute = () => route().dest === 'files' && route().source === 'package' && Boolean(route().id);
  const pickerRequired = () => needsWorkspacePicker(route()) && !packageFilesRoute();
  const detailWorkspaceId = createMemo(() => route().dest === 'workspaces' ? route().ws : requiresWorkspace(route().dest) && !packageFilesRoute() ? route().ws : undefined);

  function go(next: RouteState) {
    navigate(next, routeHistoryMode(route(), next));
  }
  function goDestination(dest: Destination) {
    go({ dest, ...(route().ws !== undefined ? { ws: route().ws } : {}) });
  }
  function prepareAgentAssignment() {
    const ws = scopeWs();
    if (ws) {
      const context = { ws };
      const retained = getLaunchDraft(context);
      if (!retained?.pending && retained?.result?.kind === 'launched') {
        seedLaunchDraft(context, { title: '', content: '' });
      }
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
    go(withWorkspace(route(), ws));
  }
  function chooseWorkspace(id: string) {
    navigate(withWorkspace(route(), id), 'push');
  }
  function replaceId(value: string | null) {
    const next: RouteState = { ...route() };
    if (value) next.id = value;
    else delete next.id;
    navigate(next, routeHistoryMode(route(), next, { fallback: true }));
  }
  function openPackage(workspaceName: string, name: string) {
    const matches = scopedRecords().filter(item => item.workspace === workspaceName && base(item.package) === name);
    const target = matches.find(item => packageFilterMatches(item, 'active'))
      ?? matches.find(item => item.planned)
      ?? matches.find(item => !item.recent_completion) ?? matches[0];
    if (!target) return;
    const next: RouteState = { dest: 'specs', id: target.key };
    if (scopeWs() !== undefined) next.ws = scopeWs();
    if (target.recent_completion) next.filter = 'completed';
    else if (target.planned) next.filter = 'planned';
    go(next);
  }
  function canOpenPackageFiles(item: WireRecord) {
    return Boolean(str(item.package));
  }
  function openPackageFiles(item: WireRecord) {
    const pkg = str(item.package);
    if (!pkg) return;
    const next: RouteState = { dest: 'files', source: 'package', id: pkg };
    if (scopeWs()) next.ws = scopeWs();
    go(next);
  }
  function askCompletion() {
    const current = record();
    if (!current || !live() || !payload()?.action_token) return;
    setCompletion(current);
    setCompletionError('');
    dialog.showModal();
  }
  async function complete() {
    const current = completion();
    if (!current || !payload()?.action_token || completionBusy()) return;
    setCompletionBusy(true);
    try {
      await postJson('/api/package-completion', { package: current.package }, payload()!.action_token!);
      dialog.close();
      setCompletion(null);
      await refresh();
    } catch (e) {
      setCompletionError(e instanceof Error ? e.message : 'Completion could not be saved. Retry.');
    } finally {
      setCompletionBusy(false);
    }
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
    if (error() && route().dest !== 'workspaces' && !pickerRequired()) out.push(error());
    if (payload()?.truncated) out.push('Snapshot read budget reached; some observations are unavailable.');
    for (const e of payload()?.errors ?? []) out.push(`${e.source ? str(e.source) + ': ' : ''}${str(e.message)}`);
    if (!imported() && !error() && observers().length && !freshObservers().length && route().dest !== 'workspaces' && !pickerRequired()) out.push('Observer heartbeat is stale; work may have continued since this snapshot.');
    for (const observer of observers()) for (const a of observer.snapshot?.attention ?? []) if (a.kind === 'legacy-location') out.push(`Untracked .specs in ${a.repository} (${a.count} entries). Remedy: ${a.remedy}.`);
    return out;
  }

  // Follow a package across dispatches without replacing the components that own editors.
  let selectedIdentity: { workspace: string; package: string } | null = null;
  createEffect(() => {
    const currentRoute = route();
    if (!payload()) return;
    if (scopeWs() && !catalog()) return;
    const currentId = currentRoute.id ?? null;
    if (currentRoute.dest === 'specs') {
      const current = scopedRecords().find(item => item.key === currentId);
      if (current) selectedIdentity = { workspace: str(current.workspace), package: str(current.package) };
      const rows = visibleRecords();
      if (!rows.some(item => item.key === currentId)) {
        const followed = currentId && selectedIdentity ? rows.find(item => !item.recent_completion && item.is_current_assignment === true && item.workspace === selectedIdentity!.workspace && item.package === selectedIdentity!.package) : undefined;
        replaceId(followed?.key ?? rows[0]?.key ?? null);
      }
    } else if (currentRoute.dest === 'agents') {
      const rows = visibleAssignments();
      if (!rows.some(item => item.key === currentId)) replaceId(rows[0]?.key ?? null);
    } else if (currentRoute.dest === 'epics') {
      const rows = visibleEpics();
      if (!rows.some(item => item.key === currentId)) replaceId(rows[0]?.key ?? null);
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
    });
  });

  const outletProps: DestinationProps = {
    get route() { return route(); },
    get payload() { return payload(); },
    get live() { return live(); },
    get specsLive() { return live() && !error(); },
    get records() { return scopedRecords(); },
    get assignments() { return scopedAssignments(); },
    get epics() { return scopedEpics(); },
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
    onComplete: askCompletion,
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
      primaryNav={primaryNav}
      directoryNav={directoryNav}
      workspaceOptions={workspaceOptions()}
      scope={scopeWs()}
      onScopeChange={chooseScope}
      onDestination={goDestination}
      crumbs={crumbs()}
      title={title()}
      headerActions={route().dest === 'launch'
        ? <button class="ds-btn" type="button" onClick={() => goDestination('agents')}>Return to agents</button>
        : route().dest === 'workspaces'
          ? <button class="ds-btn" type="button" aria-busy={catalogPending()} onClick={() => void loadCatalog()}>Refresh workspaces</button>
          : route().dest === 'agents'
            ? <><button id="launch-agent-action" class="ds-btn ds-btn--primary" type="button" onClick={prepareAgentAssignment}>Launch agent</button><button class="ds-btn" type="button" aria-busy={fetching()} onClick={manualRefresh}>Refresh state</button></>
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
            <Match when={route().dest === 'specs'}><SpecsAdapter {...outletProps} /></Match>
            <Match when={route().dest === 'epics'}><EpicsAdapter {...outletProps} /></Match>
            <Match when={route().dest === 'agents'}><AgentsAdapter {...outletProps} /></Match>
            <Match when={route().dest === 'conversations'}><ConversationsAdapter {...outletProps} /></Match>
            <Match when={route().dest === 'files'}><FilesAdapter {...outletProps} /></Match>
            <Match when={route().dest === 'designs'}><DesignsAdapter {...outletProps} /></Match>
            <Match when={route().dest === 'workspaces'}><WorkspacesAdapter {...outletProps} /></Match>
            <Match when={route().dest === 'launch'}><LaunchAdapter {...outletProps} /></Match>
          </Switch>
        }
      >
        <WorkspacePicker {...outletProps} />
      </Show>
    </Shell>
    <dialog ref={dialog} id="completion-dialog" aria-labelledby="completion-title" onCancel={event => { if (completionBusy()) event.preventDefault(); }}>
      <form onSubmit={event => { event.preventDefault(); void complete(); }}>
        <h2 id="completion-title">Mark package complete?</h2>
        <p class="mono">{base(completion()?.package)}</p>
        <p>This saves a completion record and moves the package to Recently completed. Running workers continue; step evidence and PR status stay as recorded. Only a new dispatch makes the package current again.</p>
        <Show when={completionError()}><p class="warn" role="alert">{completionError()}</p></Show>
        <div class="flex justify-end gap-3">
          <button type="button" disabled={completionBusy()} onClick={() => dialog.close()}>Cancel</button>
          <button type="submit" disabled={completionBusy()}>{completionBusy() ? 'Saving…' : 'Mark complete'}</button>
        </div>
      </form>
    </dialog>
  </>;
}
