import { For, Show, createEffect, createSignal } from 'solid-js';
import { stale, time } from '../format';
import type { CatalogEntry } from '../scope';
import { ActionBar, EmptyState, MasterDetail, RegionalSkeleton, StateNotice, StatusText, type StatusTone } from '../primitives';
import type { DestinationProps } from './index';

const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const statusLabel = (status: unknown): string => {
  switch (status) {
    case 'ok':
      return 'Available';
    case 'missing':
      return 'Missing';
    case 'not_git':
      return 'Not a Git checkout';
    case 'unreadable':
      return 'Unreadable';
    case 'outside_root':
      return 'Outside workspace';
    default:
      return text(status) || 'Unknown';
  }
};

const statusTone = (status: unknown): StatusTone => (status === 'ok' ? 'success' : text(status) ? 'warning' : 'neutral');

type DetailState = 'none' | 'loading' | 'error' | 'offline' | 'partial' | 'stale' | 'checking' | 'ideal';

const storageStatus = (props: DestinationProps): string => (typeof props.catalogStorage?.status === 'string' ? props.catalogStorage.status : '');
const boundaryError = (props: DestinationProps): boolean => Boolean(props.catalogError) || (Boolean(storageStatus(props)) && storageStatus(props) !== 'ok' && storageStatus(props) !== 'missing_projects');
const storageMissing = (props: DestinationProps): boolean => storageStatus(props) === 'missing_projects';
const visibleEntries = (props: DestinationProps): CatalogEntry[] => {
  const query = (props.route.q ?? '').trim().toLowerCase();
  return props.catalog.filter(entry => !query || [entry.id, entry.name, entry.directory].some(value => text(value).toLowerCase().includes(query)));
};
const directoryEmpty = (props: DestinationProps): boolean => props.catalogLoaded && (storageMissing(props) || ((storageStatus(props) === 'ok' || storageStatus(props) === 'missing_projects') && props.catalog.length === 0 && props.catalogInvalid.length === 0));
const setupRequired = (props: DestinationProps): boolean => directoryEmpty(props);
const staleCatalog = (props: DestinationProps): boolean => Boolean(props.catalogLoaded && props.catalogLoadedAt != null && stale(new Date(props.catalogLoadedAt).toISOString()) && !compatibleDetail(props));
const catalogChecking = (props: DestinationProps): boolean => Boolean(props.catalogLoaded && props.catalog.length > 0 && props.catalogDelayed && !compatibleDetail(props) && !boundaryError(props) && !props.connectionFailed && !staleCatalog(props));
const directoryPartialFacts = (props: DestinationProps): string => {
  const facts: string[] = [];
  if (props.catalogInvalid.length) facts.push(`${props.catalogInvalid.length} invalid workspace ${props.catalogInvalid.length === 1 ? 'entry' : 'entries'}`);
  if (props.storageDiagnostics.length) facts.push(`${props.storageDiagnostics.length} catalog ${props.storageDiagnostics.length === 1 ? 'diagnostic' : 'diagnostics'}`);
  return facts.join(', ');
};
const unavailableSummary = (props: DestinationProps): string => {
  const summarize = (entries: any[], noun: string): string[] => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const label = statusLabel(entry?.status);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].map(([label, count]) => `${count} ${noun} ${label.toLowerCase()}`);
  };
  const repositories = list(props.workspace?.repositories).filter(entry => entry?.status !== 'ok');
  const context = list(props.workspace?.context).filter(entry => entry?.status !== 'ok');
  const facts = [...summarize(repositories, repositories.length === 1 ? 'repository' : 'repositories'), ...summarize(context, context.length === 1 ? 'context reference' : 'context references')];
  if (list(props.workspace?.attention).length) facts.push('attention flags');
  return facts.join(' and ');
};
const emptyMainCopy = (props: DestinationProps): { title: string; text: string; refresh: boolean } => {
  if (storageMissing(props)) return { title: 'Workspace storage needs setup', text: 'The configured root has no projects directory. Run the host workspace setup command, then refresh.', refresh: true };
  if (props.catalogLoaded && props.catalog.length === 0 && props.catalogInvalid.length === 0) return { title: 'Workspace storage needs setup', text: 'No workspace kits were found. Create one on the host, then refresh this directory.', refresh: true };
  if (props.catalogLoaded && props.catalog.length > 0 && visibleEntries(props).length === 0) return { title: 'Choose a workspace', text: 'Clear the search to restore the valid workspace directory.', refresh: false };
  return { title: 'Choose a workspace', text: 'Choose a workspace to compare repositories, roles, availability and registered context.', refresh: false };
};
const directoryPartial = (props: DestinationProps): boolean => props.catalogInvalid.length > 0 || props.storageDiagnostics.length > 0;
const directoryError = (props: DestinationProps): boolean => boundaryError(props);
const compatibleDetail = (props: DestinationProps): boolean => Boolean(props.workspace && props.workspace?.id === props.route.ws);
const selectedName = (props: DestinationProps): string => {
  const entry = props.catalog.find(candidate => String(candidate.id) === String(props.route.ws));
  return text(entry?.name) || String(props.route.ws ?? 'Workspace');
};
const unavailableFacts = (props: DestinationProps): string[] => {
  if (!compatibleDetail(props)) return [];
  const rows = [...list(props.workspace?.repositories), ...list(props.workspace?.context)].filter(entry => entry?.status !== 'ok');
  const names = rows.map(entry => text(entry.id) || text(entry.path)).filter(Boolean);
  if (list(props.workspace?.attention).length) names.push('attention flags');
  return names;
};
const detailState = (props: DestinationProps): DetailState => {
  if (!props.route.ws) return 'none';
  if (!compatibleDetail(props)) return props.connectionFailed || boundaryError(props) || props.workspaceError ? 'error' : 'loading';
  if (props.connectionFailed) return 'offline';
  if (props.workspaceError || boundaryError(props)) return 'error';
  const loadedAt = props.workspaceLoadedAt != null ? new Date(props.workspaceLoadedAt).toISOString() : undefined;
  if (stale(loadedAt)) return 'stale';
  if (props.workspaceDelayed) return 'checking';
  if (unavailableFacts(props).length || directoryPartial(props)) return 'partial';
  return 'ideal';
};
const directoryAnnouncement = (props: DestinationProps): string => {
  if (!props.live) return 'A live dashboard is required for workspaces.';
  if (props.connectionFailed && !compatibleDetail(props)) return 'Connection unavailable.';
  if (directoryError(props)) return 'Workspaces could not be read.';
  if (staleCatalog(props)) return 'Workspace catalog is being revalidated.';
  if (!props.catalogLoaded) return props.catalogDelayed ? 'Reading workspaces.' : '';
  if (directoryEmpty(props)) return 'No workspaces recorded.';
  if (props.catalog.length > 0 && visibleEntries(props).length === 0) return 'No matching workspaces.';
  if (catalogChecking(props)) return 'Checking workspaces.';
  if (directoryPartial(props)) return 'Workspace coverage incomplete.';
  return 'Choose a workspace.';
};
const paneAnnouncement = (props: DestinationProps): string => {
  if (setupRequired(props)) return 'No workspaces recorded.';
  const state = detailState(props);
  const name = selectedName(props);
  if (state === 'none') return '';
  if (state === 'loading') return props.workspaceDelayed ? `Checking workspace ${name}.` : '';
  if (state === 'error') return `Workspace ${name} could not be read.`;
  if (state === 'offline') return `Connection unavailable for workspace ${name}.`;
  if (state === 'stale') return `Workspace ${name} is being revalidated.`;
  if (state === 'checking') return `Checking workspace ${name}.`;
  if (state === 'partial') return `Workspace ${name} coverage is incomplete.`;
  return `Workspace ${name} available.`;
};
type FallbackMode = 'idle' | 'loading' | 'error' | 'offline' | 'empty';
const paneFallbackMode = (props: DestinationProps): FallbackMode => {
  if (props.connectionFailed) return 'offline';
  if (boundaryError(props)) return 'error';
  if (props.catalogLoaded) return 'empty';
  if (props.catalogDelayed) return 'loading';
  return 'idle';
};

function SkeletonSection(props: { title: string; rows: number }) {
  return (
    <section class="section">
      <div class="section-heading"><h3>{props.title}</h3><span class="muted" /></div>
      <RegionalSkeleton announce={false} variant="table" rows={props.rows} label={`Reading ${props.title.toLowerCase()}`} />
    </section>
  );
}

function WorkspaceRow(props: { entry: CatalogEntry; selected: boolean; onChoose: (id: string) => void }) {
  const kit = (): Record<string, any> => (props.entry.kit && typeof props.entry.kit === 'object' ? props.entry.kit : {});
  const repositories = () => list(kit().repositories);
  const context = () => list(kit().context);
  const first = () => repositories()[0];
  const attention = () => list(props.entry.attention);
  const repositoryCount = () => `${repositories().length} ${repositories().length === 1 ? 'repository' : 'repositories'}`;
  return (
    <button
      type="button"
      class={props.selected ? 'record selected' : 'record'}
      data-workspace={props.entry.id}
      aria-pressed={props.selected}
      onClick={() => props.onChoose(String(props.entry.id))}
    >
      <div class="row-heading">
        <strong>{text(props.entry.name) || String(props.entry.id)}</strong>
        <StatusText tone="neutral">{repositoryCount()}</StatusText>
      </div>
      <p>{first() ? `${text(first().id) || 'Repository'}${text(first().role) ? ` · ${text(first().role)}` : ''}` : 'No repositories recorded'}</p>
      <small>{context().length} context {context().length === 1 ? 'reference' : 'references'}</small>
      <Show when={attention().length}>
        <small class="warn">{attention().map(item => text(item)).filter(Boolean).join(' · ')}</small>
      </Show>
    </button>
  );
}

function WorkspaceDirectory(props: DestinationProps) {
  const visible = () => visibleEntries(props);
  const partial = () => directoryPartial(props);
  const empty = () => directoryEmpty(props);
  const loading = () => props.live && !props.catalogLoaded && props.catalogDelayed;
  const noMatch = () => props.catalogLoaded && !empty() && props.catalog.length > 0 && visible().length === 0;
  const caption = () => {
    if (!props.live) return '';
    if (directoryError(props)) return props.catalogLoaded ? `Last known catalog: ${props.catalog.length} valid workspaces` : 'No workspaces recorded';
    if (!props.catalogLoaded) return loading() ? 'Reading workspaces…' : '';
    if (empty()) return 'No workspaces recorded';
    if (noMatch()) return '0 matching workspaces';
    return `${props.catalog.length} valid ${props.catalog.length === 1 ? 'workspace' : 'workspaces'}`;
  };
  return (
    <>
      <div class="list-controls">
        <label class="sr-only" for="find-record">
          Find workspaces
        </label>
        <input
          class="ds-input"
          id="find-record"
          type="search"
          placeholder="Find workspaces"
          value={props.route.q ?? ''}
          onInput={event => props.onQuery(event.currentTarget.value)}
        />
      </div>
      <div class="list-caption">{caption()}</div>
      <div class="records">
        <Show when={!props.live}>
          <EmptyState
            title="A live dashboard is required"
            text="Workspaces need the local dashboard server. Import a published snapshot to inspect other data."
          />
        </Show>
        <Show when={props.live}>
          <Show when={directoryError(props)}>
            <StateNotice
              announce={false}
              tone="error"
              title="Workspaces could not be read"
              action={<button type="button" class="ds-btn" onClick={props.onRetryCatalog}>Retry</button>}
            >
              The host did not return a usable result. Your selection is kept.
            </StateNotice>
          </Show>
          <Show when={props.connectionFailed && !compatibleDetail(props) && !directoryError(props)}>
            <StateNotice
              announce={false}
              tone="warning"
              title="Connection unavailable"
              action={<button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryConnection}>Retry connection</button>}
            >
              These workspace records may have changed on the host.
            </StateNotice>
          </Show>
          <Show when={staleCatalog(props) && !directoryError(props) && !props.connectionFailed}>
            <StateNotice
              announce={false}
              tone="warning"
              title={`Last checked at ${time(props.catalogLoadedAt != null ? new Date(props.catalogLoadedAt).toISOString() : undefined)}`}
              action={<button type="button" class="ds-btn" onClick={props.onRetryCatalog}>Refresh workspaces</button>}
            >
              Existing content is kept while the host revalidates it.
            </StateNotice>
          </Show>
          <Show when={catalogChecking(props)}>
            <p class="section-note">Checking workspaces…</p>
          </Show>
          <Show when={!props.catalogLoaded}>
            <Show when={loading() && !directoryError(props)}>
              <RegionalSkeleton announce={false} rows={4} label="Reading workspaces" />
            </Show>
          </Show>
          <Show when={props.catalogLoaded}>
            <Show when={!directoryError(props) && !props.connectionFailed}>
              <Show when={empty()}>
                <EmptyState
                  title="No workspaces recorded"
                  text="Set up workspace storage on the host, then refresh this directory."
                  action={<button type="button" class="ds-btn" onClick={props.onRetryCatalog}>Refresh workspaces</button>}
                />
              </Show>
              <Show when={noMatch()}>
                <EmptyState
                  title="No matching workspaces"
                  text={`No item matches “${props.route.q ?? ''}”. Your search and scope are kept.`}
                  action={<button type="button" class="ds-btn ds-btn--primary" onClick={() => props.onQuery('')}>Clear filters</button>}
                />
              </Show>
            </Show>
            <Show when={!empty()}>
              <For each={visible()}>
                {entry => <WorkspaceRow entry={entry} selected={props.route.ws === String(entry.id)} onChoose={props.onChooseWorkspace} />}
              </For>
              <Show when={partial() && !directoryError(props) && !props.connectionFailed}>
                <StateNotice announce={false} tone="warning" title="Workspace coverage incomplete">
                  {`${directoryPartialFacts(props)}. Valid rows and diagnostics stay visible.`}
                </StateNotice>
              </Show>
              <Show when={props.catalogInvalid.length}>
                <For each={props.catalogInvalid}>
                  {entry => (
                    <div class="info-row">
                      <p><strong>Invalid workspace</strong></p>
                      <small class="mono">{text(entry.directory)}</small>
                      <For each={list(entry.errors)}>{error => <small class="warn">{text(error) || String(error)}</small>}</For>
                    </div>
                  )}
                </For>
              </Show>
              <Show when={props.storageDiagnostics.length}>
                <For each={props.storageDiagnostics}>
                  {entry => <p class="small muted">{entry.path ? `${entry.message} (${entry.path})` : entry.message}</p>}
                </For>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </>
  );
}
function WorkspacePane(props: DestinationProps) {
  const ws = () => props.route.ws;
  const data = () => props.workspace;
  const state = () => detailState(props);
  const compatible = () => compatibleDetail(props);
  const repositories = () => list(data()?.repositories);
  const context = () => list(data()?.context);
  const briefs = () => list(data()?.briefs);
  const notes = () => list(data()?.notes);
  const artifacts = () => list(data()?.artifacts);
  const attention = () => list(data()?.attention);
  const dirBase = () => String(data()?.directory ?? '').split('/').filter(Boolean).pop() ?? text(ws());
  const loadedAtIso = () => (props.workspaceLoadedAt != null ? new Date(props.workspaceLoadedAt).toISOString() : undefined);
  const availability = (): { label: string; tone: StatusTone } | null => {
    if (!compatible()) return null;
    if (directoryPartial(props)) return { label: 'Coverage incomplete', tone: 'warning' };
    const statuses = [...repositories(), ...context()].map(entry => entry?.status);
    if (attention().length === 0 && statuses.every(status => status === 'ok')) return { label: 'Available', tone: 'success' };
    const firstIssue = statuses.find(status => status !== 'ok');
    return { label: firstIssue ? statusLabel(firstIssue) : 'Attention', tone: 'warning' };
  };
  const itemName = (item: unknown): string => (typeof item === 'string' ? item : text((item as any)?.name) || text((item as any)?.path));
  const openFiles = () => props.onNavigate({ dest: 'files', ws: ws() });
  const openPath = (path: string) => props.onNavigate({ dest: 'files', ws: ws(), source: 'workspace', path });
  const contextRoutePath = (entry: any): string | null => {
    const path = text(entry.path);
    if (!path) return null;
    const directory = text(data()?.directory);
    if (path.startsWith('/')) {
      // contextRecord resolves absolute references before containment checks.
      // Match that lexical resolution, without changing the file reader's checks.
      const segments = path.split('/').reduce<string[]>((parts, part) =>
        part === '..' ? parts.slice(0, -1) : part && part !== '.' ? [...parts, part] : parts, []);
      const normalized = `/${segments.join('/')}`;
      if (!directory || !normalized.startsWith(`${directory}/`)) return null;
      return normalized.slice(directory.length + 1);
    }
    return path;
  };
  const retryWorkspace = () => {
    if (boundaryError(props)) { props.onRetryCatalog(); return; }
    props.onRetryWorkspace(String(ws() ?? ''));
  };
  return (
    <>
      <Show
        when={ws()}
        keyed
        fallback={
          <>
            <div class="object-head"><div class="object-top"><h2>Workspace details</h2></div><p /></div>
            <Show when={paneFallbackMode(props) === 'loading'}>
              <div class="detail-body">
                <SkeletonSection title="Repositories" rows={1} />
                <SkeletonSection title="Registered context" rows={1} />
                <SkeletonSection title="Workspace material" rows={4} />
                <SkeletonSection title="Workspace kit" rows={1} />
              </div>
            </Show>
            <Show when={paneFallbackMode(props) === 'error'}>
              <div class="detail-body">
                <EmptyState
                  symbol="◇"
                  title="Workspaces could not be read"
                  text="The host did not return a usable result. Retry to read the workspace catalog."
                  action={<button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryCatalog}>Retry</button>}
                />
              </div>
            </Show>
            <Show when={paneFallbackMode(props) === 'offline'}>
              <div class="detail-body">
                <StateNotice
                  announce={false}
                  tone="warning"
                  title="Connection unavailable"
                  action={<button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryConnection}>Retry connection</button>}
                >
                  These workspace records may have changed on the host.
                </StateNotice>
              </div>
            </Show>
            <Show when={paneFallbackMode(props) === 'empty'}>
              <div class="detail-body">
                <EmptyState
                  symbol="◇"
                  title={emptyMainCopy(props).title}
                  text={emptyMainCopy(props).text}
                  action={emptyMainCopy(props).refresh ? <button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryCatalog}>Refresh workspaces</button> : undefined}
                />
              </div>
            </Show>
          </>
        }
      >
        <Show when={setupRequired(props)}>
          <div class="object-head"><div class="object-top"><h2>Workspace details</h2></div><p /></div>
          <div class="detail-body">
            <EmptyState
              symbol="◇"
              title={emptyMainCopy(props).title}
              text={emptyMainCopy(props).text}
              action={emptyMainCopy(props).refresh ? <button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryCatalog}>Refresh workspaces</button> : undefined}
            />
          </div>
        </Show>
        <Show when={!setupRequired(props)}>
        <div class="object-head">
          <div class="object-top">
            <h2>{compatible() ? (text(data()?.name) || selectedName(props)) : selectedName(props)}</h2>
            <Show when={compatible() && availability()} keyed>
              {status => <StatusText tone={status.tone}>{status.label}</StatusText>}
            </Show>
            <Show when={!compatible() && state() === 'error'}>
              <StatusText tone="neutral">Not confirmed</StatusText>
            </Show>
          </div>
          <p><Show when={compatible()}>{[dirBase(), text(data()?.kit?.description)].filter(Boolean).join(' · ')}</Show></p>
        </div>
        <Show when={!compatible() && state() === 'error'}>
          <div class="detail-body">
            <EmptyState
              symbol="◇"
              title="Workspace could not be read"
              text="The configured workspace storage is unavailable. Repair the host boundary and retry."
              action={<button type="button" class="ds-btn ds-btn--primary" onClick={retryWorkspace}>Retry workspace</button>}
            />
          </div>
        </Show>
        <Show when={!compatible() && state() === 'loading'}>
          <div class="detail-body">
            <Show when={props.workspaceDelayed}>
              <SkeletonSection title="Repositories" rows={1} />
              <SkeletonSection title="Registered context" rows={1} />
              <SkeletonSection title="Workspace material" rows={4} />
              <SkeletonSection title="Workspace kit" rows={1} />
            </Show>
          </div>
        </Show>
        <Show when={compatible()}>
          <div class="detail-body">
            <Show when={state() === 'offline'}>
              <StateNotice
                announce={false}
                tone="warning"
                title="Connection unavailable"
                action={<button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryConnection}>Retry connection</button>}
              >
                {`Last received at ${time(loadedAtIso())}. These records may have changed on the host.`}
              </StateNotice>
            </Show>
            <Show when={state() === 'error'}>
              <StateNotice
                announce={false}
                tone="error"
                title="Workspace could not be read"
                action={<button type="button" class="ds-btn" onClick={retryWorkspace}>Retry workspace</button>}
              >
                The host did not return a usable result. Your selection is kept.
              </StateNotice>
            </Show>
            <Show when={state() === 'stale'}>
              <StateNotice
                announce={false}
                tone="warning"
                title={`Last checked at ${time(loadedAtIso())}`}
                action={<button type="button" class="ds-btn ds-btn--primary" onClick={() => props.onRetryWorkspace(String(ws() ?? ''))}>Refresh workspace</button>}
              >
                Existing content is kept while the host revalidates it.
              </StateNotice>
            </Show>
            <Show when={state() === 'checking'}>
              <p class="section-note">Checking workspace…</p>
            </Show>
            <Show when={state() === 'partial'}>
              <StateNotice announce={false} tone="warning" title="Workspace coverage incomplete">
                {`Unavailable: ${unavailableSummary(props) || directoryPartialFacts(props)}. Valid rows stay visible.`}
              </StateNotice>
            </Show>
            <section class="section">
              <div class="section-heading"><h3>Repositories</h3><span class="muted">{repositories().length} recorded</span></div>
              <Show when={repositories().length} fallback={<p class="small muted">No repositories recorded.</p>}>
                <div class="table-wrap">
                  <table>
                    <thead><tr><th scope="col">Repository / role</th><th scope="col">Availability</th></tr></thead>
                    <tbody>
                      <For each={repositories()}>
                        {repo => (
                          <tr>
                            <td>
                              <strong>{text(repo.id) || 'Repository'}</strong>
                              <Show when={text(repo.path)}>{path => <span class="muted mono path">{path()}</span>}</Show>
                              <Show when={text(repo.role)}>{role => <span class="muted">{role()}</span>}</Show>
                            </td>
                            <td><StatusText tone={statusTone(repo.status)}>{statusLabel(repo.status)}</StatusText></td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </section>
            <section class="section">
              <div class="section-heading"><h3>Registered context</h3><span class="muted">{context().length} recorded</span></div>
              <Show when={context().length} fallback={<p class="small muted">No context entries recorded.</p>}>
                <div class="table-wrap">
                  <table>
                    <thead><tr><th scope="col">Reference</th><th scope="col">Availability</th></tr></thead>
                    <tbody>
                      <For each={context()}>
                        {entry => (
                          <tr>
                            <td>
                              <Show
                                when={entry.status === 'ok' ? contextRoutePath(entry) : null}
                                fallback={<span class="muted mono path">{text(entry.path) || text(entry.label) || 'Context'}</span>}
                              >
                                {path => <button type="button" class="text-link" onClick={() => openPath(path())}>{path()}</button>}
                              </Show>
                            </td>
                            <td><StatusText tone={statusTone(entry.status)}>{statusLabel(entry.status)}</StatusText></td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </section>
            <section class="section">
              <div class="section-heading"><h3>Workspace material</h3><span class="muted" /></div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th scope="col">Collection</th><th scope="col">Contents</th></tr></thead>
                  <tbody>
                    <tr>
                      <td><button type="button" class="text-link" onClick={() => openPath('briefs/')}>Briefs</button></td>
                      <td>{briefs().length} saved {briefs().length === 1 ? 'brief' : 'briefs'}</td>
                    </tr>
                    <tr>
                      <td><button type="button" class="text-link" onClick={() => openPath('notes/')}>Notes</button></td>
                      <td>{notes().length} saved {notes().length === 1 ? 'note' : 'notes'}</td>
                    </tr>
                    <tr>
                      <td><button type="button" class="text-link" onClick={() => props.onNavigate({ dest: 'designs', ws: ws() })}>Designs</button></td>
                      <td>Browse designs</td>
                    </tr>
                    <tr>
                      <td>Artifacts</td>
                      <td>{artifacts().length ? `${artifacts().length} recorded` : 'No references recorded'}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <Show when={briefs().some(item => itemName(item))}>
                <div class="section-heading"><h4>Briefs</h4><span class="muted">{briefs().length} files</span></div>
                <div class="rows">
                  <For each={briefs()}>
                    {item => {
                      const name = itemName(item);
                      return (
                        <Show when={name}>
                          <div class="info-row"><button type="button" class="text-link" onClick={() => openPath(`briefs/${name}`)}>{name}</button></div>
                        </Show>
                      );
                    }}
                  </For>
                </div>
              </Show>
              <Show when={notes().some(item => itemName(item))}>
                <div class="section-heading"><h4>Notes</h4><span class="muted">{notes().length} files</span></div>
                <div class="rows">
                  <For each={notes()}>
                    {item => {
                      const name = itemName(item);
                      return (
                        <Show when={name}>
                          <div class="info-row"><button type="button" class="text-link" onClick={() => openPath(`notes/${name}`)}>{name}</button></div>
                        </Show>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </section>
            <Show when={artifacts().length}>
              <section class="section">
                <div class="section-heading"><h3>Artifacts</h3><span class="muted">{artifacts().length} records</span></div>
                <div class="rows">
                  <For each={artifacts()}>
                    {item => (
                      <div class="info-row">
                        <p><strong>{text(item.title) || 'Artifact'}</strong> · {text(item.kind) || 'unknown'} · {text(item.status) || 'unknown'}</p>
                        <Show when={item.kind === 'url' ? text(typeof item.target === 'string' ? item.target : item.target?.url) : [text(item.target?.repository_id), text(item.target?.path)].filter(Boolean).join(' · ')}>
                          {detail => <small class="mono">{detail()}</small>}
                        </Show>
                        <Show when={text(item.note)}>{note => <small>{note()}</small>}</Show>
                        <Show when={text(item.reason)}>{reason => <small class="warn">{reason()}</small>}</Show>
                        <Show when={text(item.path)}>{path => <small class="mono">{path()}</small>}</Show>
                      </div>
                    )}
                  </For>
                </div>
              </section>
            </Show>
            <section class="section">
              <div class="section-heading"><h3>Workspace kit</h3><span class="muted" /></div>
              <p class="mono">kit.yaml · version {String(data()?.kit?.version ?? 'unknown')}</p>
              <p class="mono">{text(data()?.kit?.id)}</p>
              <p class="muted" style={{ 'margin-top': '8px' }}>Repository composition is managed by the operator on the host.</p>
            </section>
          </div>
          <ActionBar>
            <button
              type="button"
              class={state() === 'ideal' || state() === 'partial' ? 'ds-btn ds-btn--primary' : 'ds-btn'}
              onClick={() => props.onNavigate({ dest: 'conversations', ws: ws() })}
            >
              Open workspace
            </button>
            <button type="button" class="ds-btn" onClick={openFiles}>Open files</button>
          </ActionBar>
        </Show>
        </Show>
      </Show>
    </>
  );
}

export function WorkspacesDestination(props: DestinationProps) {
  const [announcement, setAnnouncement] = createSignal('');
  const announcedChecking = new Set<string>();
  let previousPane = '';
  let previousDirectory = '';
  createEffect(() => {
    const pane = paneAnnouncement(props);
    const directory = directoryAnnouncement(props);
    let next = '';
    if (pane && pane !== previousPane) next = pane;
    else if (directory && directory !== previousDirectory) next = directory;
    previousPane = pane;
    previousDirectory = directory;
    if (!next) return;
    const state = detailState(props);
    const catalogBusy = catalogChecking(props);
    if (state === 'checking' || (state === 'loading' && props.workspaceDelayed) || catalogBusy) {
      const identity = catalogBusy ? 'catalog' : String(props.route.ws ?? '');
      if (announcedChecking.has(identity)) return;
      announcedChecking.add(identity);
    }
    setAnnouncement(next);
  });
  return (
    <div class="workspace-destination">
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement()}</span>
      <MasterDetail listLabel="Workspaces" list={<WorkspaceDirectory {...props} />}>
        <WorkspacePane {...props} />
      </MasterDetail>
    </div>
  );
}

export function WorkspacePicker(props: DestinationProps) {
  const [announcement, setAnnouncement] = createSignal('');
  let previous = '';
  createEffect(() => {
    const next = directoryAnnouncement(props);
    if (next && next !== previous) {
      previous = next;
      setAnnouncement(next);
    }
  });
  return (
    <div class="full-page workspace-picker">
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement()}</span>
      <div class="detail">
        <WorkspaceDirectory {...props} />
      </div>
    </div>
  );
}
