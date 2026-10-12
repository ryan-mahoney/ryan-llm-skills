import { For, Show } from 'solid-js';
import type { CatalogEntry } from '../scope';
import { ActionBar, EmptyState, MasterDetail, StateNotice, StatusText, type StatusTone } from '../primitives';
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
  const query = () => (props.route.q ?? '').trim().toLowerCase();
  const visible = () => props.catalog.filter(entry => !query() || [entry.id, entry.name, entry.directory].some(value => text(value).toLowerCase().includes(query())));
  const storageIssue = () => Boolean(text(props.catalogStorage?.status) && props.catalogStorage?.status !== 'ok');
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
      <div class="list-caption">{props.catalog.length} valid workspaces</div>
      <div class="records">
        <Show
          when={props.live}
          fallback={
            <EmptyState
              title="A live dashboard is required"
              text="Workspaces need the local dashboard server. Import a published snapshot to inspect other data."
            />
          }
        >
          <Show when={props.catalogError}>
            <StateNotice
              tone="warning"
              title="Workspaces unavailable"
              action={<button type="button" class="ds-btn" onClick={props.onRetryCatalog}>Retry</button>}
            >
              {props.catalogError}
            </StateNotice>
          </Show>
          <Show when={storageIssue() || props.storageDiagnostics.length}>
            <StateNotice tone="warning" title={storageIssue() ? 'Workspace storage unavailable' : 'Workspace catalog incomplete'}>
              {[
                storageIssue() ? `Storage status: ${text(props.catalogStorage?.status)}` : '',
                text(props.catalogStorage?.root) ? `Configured root: ${text(props.catalogStorage?.root)}` : '',
                ...props.storageDiagnostics.map(entry => (entry.path ? `${entry.message} (${entry.path})` : entry.message)),
              ].filter(Boolean).join(' · ')}
            </StateNotice>
          </Show>
          <Show when={!props.catalogLoaded && props.catalogPending}>
            <EmptyState title="Loading workspaces…" text="Reading the workspace catalog." />
          </Show>
          <Show when={props.catalogLoaded}>
            <For
              each={visible()}
              fallback={
                <EmptyState
                  title={props.catalog.length ? 'No matching workspaces' : 'No workspaces'}
                  text={props.catalog.length ? 'Change the search or clear it to see every workspace.' : 'No workspace records were returned by the catalog.'}
                />
              }
            >
              {entry => <WorkspaceRow entry={entry} selected={props.route.ws === String(entry.id)} onChoose={props.onChooseWorkspace} />}
            </For>
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
        </Show>
      </div>
    </>
  );
}

function WorkspacePane(props: DestinationProps) {
  const ws = () => props.route.ws;
  const data = () => props.workspace;
  const repositories = () => list(data()?.repositories);
  const context = () => list(data()?.context);
  const briefs = () => list(data()?.briefs);
  const notes = () => list(data()?.notes);
  const artifacts = () => list(data()?.artifacts);
  const attention = () => list(data()?.attention);
  const dirBase = () => String(data()?.directory ?? '').split('/').filter(Boolean).pop() ?? text(ws());
  const headName = () => text(data()?.name) || String(ws() ?? 'Workspace');
  const compatible = () => Boolean(data() && data()?.id === ws());
  const availability = (): { label: string; tone: StatusTone } | null => {
    if (!compatible()) return null;
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
  return (
    <>
      <Show
        when={compatible()}
        fallback={
          <div class="detail-body">
            <Show
              when={props.workspaceError}
              fallback={<EmptyState title="Loading workspace…" text="Reading repository and context records." />}
            >
              <EmptyState
                title="Workspace unavailable"
                text={props.workspaceError}
                action={<button type="button" class="ds-btn" onClick={() => props.onRetryWorkspace(String(ws() ?? ''))}>Retry workspace</button>}
              />
            </Show>
          </div>
        }
      >
        <div class="object-head">
          <div class="object-top">
            <h2>{headName()}</h2>
            <Show when={availability()} keyed>
              {status => <StatusText tone={status.tone}>{status.label}</StatusText>}
            </Show>
          </div>
          <p>{[dirBase(), text(data()?.kit?.description)].filter(Boolean).join(' · ')}</p>
        </div>
        <div class="detail-body">
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
      </Show>
      <ActionBar>
        <button type="button" class="ds-btn ds-btn--primary" onClick={() => props.onNavigate({ dest: 'conversations', ws: ws() })}>Open workspace</button>
        <button type="button" class="ds-btn" onClick={openFiles}>Open files</button>
      </ActionBar>
    </>
  );
}

export function WorkspacesDestination(props: DestinationProps) {
  return (
    <div class="workspace-destination">
      <MasterDetail listLabel="Workspaces" list={<WorkspaceDirectory {...props} />}>
        <Show
          when={props.route.ws}
          keyed
          fallback={
            <div class="detail-body">
              <EmptyState title="Select a workspace" text="Choose a workspace to compare repositories, roles, availability and registered context." />
            </div>
          }
        >
          <WorkspacePane {...props} />
        </Show>
      </MasterDetail>
    </div>
  );
}

export function WorkspacePicker(props: DestinationProps) {
  return (
    <div class="full-page workspace-picker">
      <div class="detail">
        <WorkspaceDirectory {...props} />
      </div>
    </div>
  );
}
