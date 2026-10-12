import { For, Show, Switch, Match, createSignal, createMemo, createEffect, on, onMount, onCleanup } from 'solid-js';
import { getJson, postJson } from './api';
import { str, base, time, activeRun, attention, setClock, tickClock, stale, statusMarkdown } from './format';
import { normalizeEnvelope, authoritativeObservers, collectRecords, collectAssignments, collectEpics, type Envelope, type WireRecord } from './model';
import Threads from './Threads';
import Files from './Files';
import Designs from './Designs';
import Shell from './Shell';
import { EmptyState, MasterDetail, type StatusTone } from './primitives';
import { parseHash, subscribeRoute, navigate, routeHistoryMode, type Destination, type RouteState } from './route';
import { clearIncompatibleFields, inWorkspaceScope, needsWorkspacePicker, requiresWorkspace, scopeLabel, withWorkspace, type CatalogEntry } from './scope';
import { destinationEntries, type DestinationProps } from './destinations';

type Filter = 'active' | 'attention' | 'completed';
type Catalog = { storage?: WireRecord; valid: CatalogEntry[]; invalid?: WireRecord[]; errors?: WireRecord[] };
const liveBrowser = () => location.protocol !== 'file:';

const registry = destinationEntries(WorkspacesCompat);
const [SpecsAdapter, EpicsAdapter, AgentsAdapter, ConversationsAdapter, FilesAdapter, DesignsAdapter, WorkspacesAdapter] = registry.map(entry => entry.render);
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
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [completion, setCompletion] = createSignal<WireRecord | null>(null);
  const [completionBusy, setCompletionBusy] = createSignal(false);
  const [completionError, setCompletionError] = createSignal('');
  const [endedSessions, setEndedSessions] = createSignal<string[]>([]);
  let dialog!: HTMLDialogElement;
  let stateGeneration = 0, catalogGeneration = 0, workspaceGeneration = 0;
  let catalogBusy = false;
  let workspaceBusyId: string | null = null;

  const live = () => liveBrowser() && !imported();
  const scopeWs = () => route().ws;
  const title = () => registry.find(entry => entry.dest === route().dest)?.label ?? 'Specs';
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
    return value === 'attention' || value === 'completed' ? value : 'active';
  };
  const q = () => query().trim().toLowerCase();
  const visibleRecords = createMemo(() => scopedRecords().filter(record => (!q() || [record.workspace, record.package_ref, record.package, record.activity, record.obligation, record.execution].some(value => str(value).toLowerCase().includes(q()))) && (filter() === 'completed' ? record.recent_completion : filter() === 'attention' ? attention(record) : activeRun(record))).sort((a, b) => filter() === 'completed' ? Date.parse(b.completed_at) - Date.parse(a.completed_at) || str(a.package).localeCompare(str(b.package)) : 0));
  const visibleAssignments = createMemo(() => scopedAssignments().filter(assignment => !q() || [assignment.assignment_id, assignment.spec_package, assignment.workflow_id, assignment.display, assignment.nextAction || assignment.safeAction].some(value => str(value).toLowerCase().includes(q()))));
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
  const crumbs = () => [scopeLabel(scopeWs(), catalogEntries()), title()];
  const packageFilesRoute = () => route().dest === 'files' && route().source === 'package' && Boolean(route().id);
  const pickerRequired = () => needsWorkspacePicker(route()) && !packageFilesRoute();
  const detailWorkspaceId = () => route().dest === 'workspaces' ? route().id : requiresWorkspace(route().dest) && !packageFilesRoute() ? route().ws : undefined;

  function go(next: RouteState) {
    navigate(next, routeHistoryMode(route(), next));
  }
  function goDestination(dest: Destination) {
    go({ ...clearIncompatibleFields(route()), dest });
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
  function choosePickerWorkspace(id: string) {
    navigate(withWorkspace(route(), id), 'push');
  }
  function replaceId(value: string | null) {
    const next: RouteState = { ...route() };
    if (value) next.id = value;
    else delete next.id;
    navigate(next, routeHistoryMode(route(), next, { fallback: true }));
  }
  function openPackage(workspaceName: string, name: string) {
    const target = scopedRecords().find(item => item.workspace === workspaceName && base(item.package) === name);
    if (!target) return;
    go({ ...clearIncompatibleFields(route()), dest: 'specs', id: target.key });
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
    if (!live() || catalogBusy) return;
    catalogBusy = true;
    const request = ++catalogGeneration;
    try {
      const value = await getJson<Catalog>('/api/workspaces');
      if (request !== catalogGeneration || !live()) return;
      setCatalog(value);
      setCatalogError('');
      const detailId = detailWorkspaceId();
      if (detailId && !value.valid.some(workspaceEntry => workspaceEntry.id === detailId)) {
        setWorkspace(undefined);
        setWorkspaceError('Selected workspace is no longer in the catalog.');
      } else if (detailId) {
        void loadWorkspace(detailId);
      }
    } catch {
      if (request === catalogGeneration) setCatalogError('Could not load workspaces.');
    } finally {
      if (request === catalogGeneration) catalogBusy = false;
    }
  }
  async function loadWorkspace(id: string) {
    if (!live() || !id || workspaceBusyId === id) return;
    workspaceBusyId = id;
    const request = ++workspaceGeneration;
    try {
      const value = await getJson<WireRecord>('/api/workspace?' + new URLSearchParams({ id }));
      if (request !== workspaceGeneration || detailWorkspaceId() !== id || !live()) return;
      setWorkspace(value);
      setWorkspaceError('');
    } catch {
      if (request === workspaceGeneration && detailWorkspaceId() === id) setWorkspaceError('Could not load workspace. Retry to reconnect.');
    } finally {
      if (request === workspaceGeneration && workspaceBusyId === id) workspaceBusyId = null;
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
      catalogBusy = false;
      workspaceBusyId = null;
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
    if (!storage) return [];
    const seen = new Set<string>();
    return [...(storage.errors ?? []), ...(current?.errors ?? [])].map(errorEntry => typeof errorEntry === 'object' ? errorEntry : { message: errorEntry }).filter(errorEntry => {
      const key = JSON.stringify([errorEntry.path, errorEntry.message]);
      if (errorEntry.message === storage.status || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function notes() {
    const out: string[] = [];
    if (error()) out.push(error());
    if (payload()?.truncated) out.push('Snapshot read budget reached; some observations are unavailable.');
    for (const e of payload()?.errors ?? []) out.push(`${e.source ? str(e.source) + ': ' : ''}${str(e.message)}`);
    if (!imported() && !error() && observers().length && !freshObservers().length) out.push('Observer heartbeat is stale; work may have continued since this snapshot.');
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
    get token() { return token(); },
    get completionToken() { return completionToken(); },
    get completionLocalOnly() { return payload()?.completion === 'local-only'; },
    get refreshKey() { return refreshKey(); },
    refresh: () => refresh(),
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
    onChooseWorkspace: choosePickerWorkspace,
  };

  return <>
    <Shell
      route={route()}
      primaryNav={primaryNav}
      directoryNav={directoryNav}
      workspaceOptions={workspaceOptions()}
      scope={scopeWs()}
      onScopeChange={chooseScope}
      onDestination={goDestination}
      crumbs={crumbs()}
      title={title()}
      headerActions={<button class="ds-btn" type="button" aria-busy={fetching()} onClick={manualRefresh}>Refresh state</button>}
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

function WorkspacePicker(props: DestinationProps) {
  return (
    <div class="full-page">
      <div class="flow">
        <Show
          when={!props.live}
          fallback={
            <>
              <h2>Choose a workspace</h2>
              <p class="section-note">This destination needs a workspace before it can load.</p>
              <Show when={props.catalogError}>
                <div class="empty" role="alert">
                  <h3>Workspaces unavailable</h3>
                  <p>{props.catalogError}</p>
                  <button type="button" onClick={props.onRetryCatalog}>Retry</button>
                </div>
              </Show>
              <div class="records">
                <For each={props.catalog} fallback={<EmptyState title="No workspaces available" text="The catalog returned no workspaces to choose from." />}>
                  {workspaceEntry => (
                    <button type="button" class="run-row" data-workspace={workspaceEntry.id} onClick={() => props.onChooseWorkspace(String(workspaceEntry.id))}>
                      <div class="flex justify-between gap-3"><span class="run-title">{workspaceEntry.name || workspaceEntry.id}</span><span class="pill muted">Workspace</span></div>
                      <p class="summary mono">{workspaceEntry.directory}</p>
                    </button>
                  )}
                </For>
              </div>
            </>
          }
        >
          <EmptyState title="A live dashboard is required" text="Workspace destinations need the local dashboard server. Import a published snapshot to inspect other data." />
        </Show>
      </div>
    </div>
  );
}

function WorkspacesCompat(props: DestinationProps) {
  const storage = () => props.catalogStorage;
  const q = () => (props.route.q ?? '').trim().toLowerCase();
  const rows = () => props.catalog.filter(workspaceEntry => !q() || [workspaceEntry.id, workspaceEntry.name, workspaceEntry.directory].some(value => str(value).toLowerCase().includes(q())));
  return (
    <MasterDetail
      listLabel="Workspaces"
      list={
        <>
          <div class="list-controls">
            <label class="sr-only" for="find-record">Find workspace</label>
            <input
              class="ds-input"
              id="find-record"
              type="search"
              placeholder="Find workspace"
              value={props.route.q ?? ''}
              onInput={event => props.onQuery(event.currentTarget.value)}
            />
          </div>
          <div class="list-caption">{props.catalog.length} observed workspaces</div>
          <div class="records">
            <Show when={!props.live}>
              <EmptyState title="Workspaces require a live dashboard" text="Start the local dashboard server or import a published snapshot to inspect other data." />
            </Show>
            <Show when={props.live}>
              <Show when={storage()?.status && storage()?.status !== 'ok' || props.storageDiagnostics.length}>
                <div class="empty warn" role="status">
                  <h3>{storage()?.status !== 'ok' ? 'Workspace storage unavailable' : 'Workspace catalog incomplete'}</h3>
                  <p class="small">Configured root: <span class="mono">{storage()?.root}</span></p>
                  <p class="small">Storage status: {storage()?.status}</p>
                  <For each={props.storageDiagnostics}>{entry => <p class="small">{entry.message}<Show when={entry.path}><br />{entry.path}</Show></p>}</For>
                  <button type="button" onClick={props.onRetryCatalog}>Retry</button>
                </div>
              </Show>
              <Show when={props.catalogError}>
                <div class="empty" role="alert">
                  <h3>Workspaces unavailable</h3>
                  <p>{props.catalogError}</p>
                  <button type="button" onClick={props.onRetryCatalog}>Retry</button>
                </div>
              </Show>
              <For each={rows()} fallback={<EmptyState title={props.catalog.length ? 'No matching workspaces' : 'No workspaces'} text={props.catalog.length ? 'Change the search or clear it to see every workspace.' : 'No workspace records were returned by the catalog.'} />}>
                {workspaceEntry => (
                  <button type="button" class="run-row" data-workspace={workspaceEntry.id} aria-pressed={props.route.id === String(workspaceEntry.id)} onClick={() => props.onSelect(String(workspaceEntry.id))}>
                    <div class="flex justify-between gap-3"><span class="run-title">{workspaceEntry.name || workspaceEntry.id}</span><span class="pill muted">Workspace</span></div>
                    <p class="summary mono">{workspaceEntry.directory}</p>
                    <For each={Array.isArray(workspaceEntry.attention) ? workspaceEntry.attention : []}>{a => <p class="small warn">{str(a)}</p>}</For>
                  </button>
                )}
              </For>
              <For each={props.catalogInvalid}>{invalidEntry => (
                <div class="info-row">
                  <p><strong>Invalid workspace</strong></p>
                  <small class="mono">{str(invalidEntry.directory)}</small>
                  <For each={Array.isArray(invalidEntry.errors) ? invalidEntry.errors : []}>{e => <small class="warn">{str(e)}</small>}</For>
                </div>
              )}</For>
            </Show>
          </div>
        </>
      }
    >
      <div class="detail-body">
        <Show
          when={props.route.id}
          keyed
          fallback={<EmptyState title={storage()?.status && storage()?.status !== 'ok' ? 'Workspace storage unavailable' : 'Select a workspace'} text="Choose a workspace to browse repositories, designs, files and discussions." />}
        >
          {id => <WorkspaceDetail id={id} data={props.workspace} error={props.workspaceError} retry={() => props.onRetryWorkspace(id)} token={props.token} live={props.live} refreshKey={props.refreshKey} />}
        </Show>
      </div>
    </MasterDetail>
  );
}

function Empty(props: { title: string; text?: string }) {
  return <div class="empty"><h2>{props.title}</h2><Show when={props.text}><p>{props.text}</p></Show></div>;
}

function WorkspaceDetail(props: { id: string; data: WireRecord | undefined; error: string; retry: () => void; token?: string; live: boolean; refreshKey: number }) {
  const [file, setFile] = createSignal<string | null>(null);
  const material = (name: string, path: string) => <section class="section"><div class="section-head"><h3>{name}</h3><span class="small muted">{props.data?.[path]?.length ?? 0} files</span></div><For each={props.data?.[path] ?? []} fallback={<p class="small muted">No {name.toLowerCase()} recorded.</p>}>{item => <p><button onClick={() => setFile(path + '/' + (typeof item === 'string' ? item : item.name))}>{typeof item === 'string' ? item : item.name}</button></p>}</For></section>;
  return <article class="detail"><Show when={props.error}><div class="empty warn" role="alert"><h3>Workspace unavailable</h3><p>{props.error}</p><button onClick={props.retry}>Retry workspace</button></div></Show><Show when={props.data} fallback={<Empty title="Loading workspace…" />}>
    <div class="eyebrow">{props.id} / Workspace</div><div class="detail-title"><div><h2>{props.data?.name || props.id}</h2><p class="subtitle mono">{props.id} · {props.data?.directory}</p></div><span class="pill muted">Workspace</span></div><For each={props.data?.attention ?? []}>{a => <p class="warn">{str(a)}</p>}</For>
    <section class="section"><div class="section-head"><h3>Repositories</h3><span class="small muted">{props.data?.repositories?.length ?? 0} recorded</span></div><For each={props.data?.repositories ?? []} fallback={<p class="small muted">No repositories recorded.</p>}>{repo => <div class="info-row"><p><strong>{repo.id}</strong> · {repo.status}</p><small class="mono">{repo.path}</small><Show when={repo.remote}><small class="mono">{repo.remote}</small></Show><Show when={repo.role}><small>Role {repo.role}</small></Show><For each={repo.attention ?? []}>{a => <small class="warn">{str(a)}</small>}</For></div>}</For></section>
    <section class="section"><div class="section-head"><h3>Context</h3><span class="small muted">{props.data?.context?.length ?? 0} recorded</span></div><For each={props.data?.context ?? []} fallback={<p class="small muted">No context entries recorded.</p>}>{item => <div class="info-row"><p>{typeof item === 'string' ? item : item.label || item.path}</p><Show when={typeof item === 'object'}><small class="mono">{item.path} · {item.status}</small></Show></div>}</For></section>
    {material('Briefs', 'briefs')}{material('Notes', 'notes')}
    <section class="section"><div class="section-head"><h3>Artifacts</h3><span class="small muted">{props.data?.artifacts?.length ?? 0} records</span></div><For each={props.data?.artifacts ?? []} fallback={<p class="small muted">No artifacts recorded.</p>}>{item => <div class="info-row"><p><strong>{item.title || 'Artifact'}</strong> · {item.kind || 'unknown'} · {item.status || 'unknown'}</p><small class="mono">{item.kind === 'url' ? str(typeof item.target === 'string' ? item.target : item.target?.url) : [item.target?.repository_id, item.target?.path].filter(Boolean).join(' · ')}</small><Show when={item.note}><small>{item.note}</small></Show><Show when={item.reason}><small class="warn">{item.reason}</small></Show><Show when={item.path}><small class="mono">{item.path}</small></Show></div>}</For></section>
    <Designs workspaceId={props.id} live={props.live} />
    <section class="section"><h3>Kit</h3><p class="small muted mono">{props.data?.kit?.id} · {props.data?.kit?.name}</p></section>
    <Threads workspaceId={props.id} repositories={props.data?.repositories ?? []} token={props.token} live={props.live} refreshKey={props.refreshKey} />
    <Files source="workspace" owner={props.id} live={props.live} initialFile={file()} />
  </Show></article>;
}
