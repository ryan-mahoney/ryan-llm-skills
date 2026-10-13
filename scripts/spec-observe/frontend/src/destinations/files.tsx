// Source-qualified adjacent Files reader. The route owns scope, selection and
// history; this adapter only builds URLs, fetches through the shared APIs and
// composes the shared MasterDetail/reader surfaces. No App/route/scope changes.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from 'solid-js';
import { getJson } from '../api';
import {
  contextRoutePath,
  fileKindLabel,
  fileSizeLabel,
  fileSource,
  filterLoadedFiles,
  listFileUrl,
  readFileUrl,
  scopeKey,
  type FileEntry,
  type FileListing,
  type FileScope,
  type FileSource,
  type LoadedFile,
} from '../files-model';
import { packageViewUrl } from '../observation-format';
import { EmptyState, MasterDetail, RegionalSkeleton, StateNotice } from '../primitives';
import { FileReader } from '../FileReader';
import type { DestinationProps } from './index';

const textValue = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const distinct = (values: string[]): string[] => [...new Set(values)];

export default function FilesDestination(props: DestinationProps) {
  const source = (): FileSource => fileSource(props.route.source);
  const suppliedOwner = () => textValue(props.route.id);
  // Declared workspace repositories are the repository owners; observed scoped
  // package paths are the package owners. A single repository is its own owner
  // (`owner()` derives it), while every other owner is chosen explicitly. An
  // explicit unknown owner is kept exactly as supplied so it stays unavailable
  // instead of being retargeted to a valid entry.
  const repositoryOwners = () => distinct(list(props.workspace?.repositories).map(entry => textValue(entry?.id)).filter(Boolean));
  const packageOwners = () => distinct(props.records.map(record => textValue(record?.package)).filter(Boolean));
  const ownerOptions = () => (source() === 'repository' ? repositoryOwners() : source() === 'package' ? packageOwners() : []);
  const owner = (): string => {
    if (source() === 'package') return suppliedOwner();
    if (source() === 'repository') {
      if (suppliedOwner()) return suppliedOwner();
      const owners = repositoryOwners();
      return owners.length === 1 ? owners[0] : '';
    }
    return '';
  };
  const ownerValues = () => {
    const options = ownerOptions();
    const supplied = suppliedOwner();
    return supplied && !options.includes(supplied) ? [...options, supplied] : options;
  };
  const showOwner = () => {
    if (source() === 'package') return ownerOptions().length > 0 || suppliedOwner() !== '';
    if (source() === 'repository') return ownerOptions().length > 1 || (suppliedOwner() !== '' && !ownerOptions().includes(suppliedOwner()));
    return false;
  };
  const scope = (): FileScope => {
    const current = source();
    if (current === 'package') return { source: current, owner: owner(), workspace: props.route.ws };
    if (current === 'repository') return { source: current, workspace: props.route.ws, owner: owner() };
    return { source: current, workspace: props.route.ws };
  };
  const scopeId = createMemo(() => scopeKey(scope()));
  const requestedPath = () => {
    const path = props.route.path ?? '';
    return path.endsWith('/') ? '' : path;
  };
  const pathPrefix = () => {
    const path = props.route.path ?? '';
    return path.endsWith('/') ? path : undefined;
  };
  // Context rows are the registered kit entries, mapped to workspace-relative
  // paths. Only available entries become selectable rows reading through the
  // workspace-file API; unavailable entries keep their real status text.
  const contextFiles = (): FileEntry[] => {
    if (source() !== 'context' || !props.workspace) return [];
    const directory = textValue(props.workspace.directory);
    const seen = new Set<string>();
    const entries: FileEntry[] = [];
    for (const entry of list(props.workspace.context)) {
      const path = contextRoutePath(directory, textValue(entry?.path));
      if (entry?.status === 'ok' && path) {
        if (seen.has(path)) continue;
        seen.add(path);
        entries.push({ name: path, available: true });
      } else {
        entries.push({
          name: textValue(entry?.label) || textValue(entry?.name) || path || 'Context',
          available: false,
          reason: textValue(entry?.reason) || (entry?.status === 'ok' ? 'Unavailable path' : textValue(entry?.status)) || 'Unavailable',
        });
      }
    }
    return entries;
  };

  const [listing, setListing] = createSignal<FileListing | null>(null);
  const [listError, setListError] = createSignal('');
  const [loadingList, setLoadingList] = createSignal(false);
  const [cursor, setCursor] = createSignal<string | number | undefined>(undefined);
  const [refreshVersion, setRefreshVersion] = createSignal(0);
  const [fileVersion, setFileVersion] = createSignal(0);
  const [query, setQuery] = createSignal('');
  const [loaded, setLoaded] = createSignal<LoadedFile | null>(null);
  const [fileError, setFileError] = createSignal('');
  const [loadingFile, setLoadingFile] = createSignal(false);
  let listGeneration = 0;
  let fileGeneration = 0;

  const recentCompletion = () => source() === 'package' && Boolean(props.records.find(item => textValue(item?.package) === owner())?.recent_completion);
  const listNoun = () => (source() === 'package' ? 'Package' : source() === 'repository' ? 'Repository' : 'Workspace');

  const fetchListing = async (next?: string | number, refresh = false) => {
    if (!props.live || source() === 'context') return;
    const url = listFileUrl(scope(), next);
    if (!url) {
      // Missing owner/workspace is guidance, not a failure: the caller keeps
      // the chooser/empty state and no endpoint is invented.
      setListing(null);
      setListError('');
      return;
    }
    const token = ++listGeneration;
    setLoadingList(true);
    setListError('');
    try {
      const data = await getJson<FileListing>(url);
      if (token !== listGeneration) return;
      const prior = next !== undefined && !refresh ? listing()?.files ?? [] : [];
      setListing({ ...data, files: [...prior, ...(data.files ?? [])] });
      setCursor(data.next_cursor ?? undefined);
    } catch {
      if (token === listGeneration) setListError(`${listNoun()} files unavailable. Refresh to retry.`);
    } finally {
      if (token === listGeneration) setLoadingList(false);
    }
  };

  createEffect(on(scopeId, () => {
    // The file effect owns its own generation token; bumping it here would
    // strand an in-flight read as stale after a scope transition.
    listGeneration++;
    setListing(null);
    setCursor(undefined);
    setListError('');
    setQuery('');
    setLoaded(null);
    setFileError('');
    setLoadingFile(false);
    untrack(() => { void fetchListing(); });
  }));
  createEffect(on(refreshVersion, version => {
    if (version > 0) untrack(() => { void fetchListing(undefined, true); });
  }));

  createEffect(on(() => [scopeId(), requestedPath(), fileVersion()] as const, ([, path]) => {
    fileGeneration++;
    if (!path) {
      setLoaded(null);
      setFileError('');
      setLoadingFile(false);
      return;
    }
    if (!props.live) {
      setLoaded(null);
      setFileError('');
      return;
    }
    const url = readFileUrl(scope(), path);
    if (!url) {
      setLoaded(null);
      setFileError('File unavailable. Choose another file.');
      return;
    }
    const token = fileGeneration;
    const controller = new AbortController();
    setLoadingFile(true);
    setFileError('');
    void (async () => {
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('unavailable');
        const kind = response.headers.get('X-Package-File-Kind') || 'text';
        const type = response.headers.get('Content-Type') || '';
        const text = kind === 'text' || kind === 'markdown' || kind === 'json' ? await response.text() : null;
        const headerLength = Number(response.headers.get('Content-Length'));
        if (token !== fileGeneration) return;
        setLoaded({
          scopeKey: scopeKey(scope()),
          path,
          kind,
          text,
          type,
          size: Number.isFinite(headerLength) ? headerLength : 0,
          receivedAt: Date.now(),
        });
      } catch {
        if (token === fileGeneration && !controller.signal.aborted) setFileError('File unavailable or exceeds the 8 MiB limit. Choose another file.');
      } finally {
        if (token === fileGeneration) setLoadingFile(false);
      }
    })();
    onCleanup(() => controller.abort());
  }));

  const listingReady = () => (source() === 'context' ? Boolean(props.workspace) : listing() !== null);
  const contextLoading = () => source() === 'context' && !props.workspace && props.workspacePending;
  const contextError = () => (source() === 'context' && !props.workspace ? props.workspaceError : '');
  const listMessage = () => listError() || contextError();
  const listedSize = (path: string) => (listing()?.files ?? []).find(entry => entry.name === path)?.size;
  const readerFile = (): LoadedFile | null => {
    const file = loaded();
    if (!file || file.size > 0) return file;
    const size = listedSize(file.path);
    return size == null ? file : { ...file, size };
  };
  const visible = () => filterLoadedFiles(source() === 'context' ? contextFiles() : listing()?.files ?? [], query(), pathPrefix());
  const selected = (name: string) => requestedPath() === name;
  const selectFile = (name: string) => { if (name !== requestedPath()) props.onOpenFile(name); };
  const readUrl = () => (requestedPath() ? readFileUrl(scope(), requestedPath()) : null);
  const downloadUrl = () => (requestedPath() ? readFileUrl(scope(), requestedPath(), true) : null);
  const viewUrl = () => (source() === 'package' && requestedPath() && owner() ? packageViewUrl(owner(), requestedPath()) : '');
  const downloadable = () => Boolean(loaded() && loaded()!.kind !== 'download' && downloadUrl());
  const checkoutIdentity = () => {
    const checkout = listing()?.checkout;
    const repository = checkout ? textValue(checkout.repository) : '';
    const branch = checkout ? textValue(checkout.branch) : '';
    return [repository || (source() === 'repository' ? owner() : ''), branch].filter(Boolean).join(' @ ');
  };
  const sourceLine = () => {
    if (source() === 'context') return `Workspace context · ${props.route.ws ?? ''}`;
    if (source() === 'package') return `Spec package · ${owner() || 'Choose package'}`;
    if (source() === 'repository') return `Repository · ${checkoutIdentity() || owner() || 'unavailable'}`;
    return `Workspace · ${props.route.ws ?? ''}`;
  };

  // Open spec uses the observed record whose canonical package matches the
  // chosen owner. Multiple matches prefer a current non-completion, then a
  // planned one, then the most recent completion, with a stable key tie-break.
  const openSpecTarget = () => {
    if (source() !== 'package' || !owner()) return null;
    const matches = props.records.filter(record => textValue(record?.package) === owner()).sort((a, b) => textValue(a.key).localeCompare(textValue(b.key)));
    if (!matches.length) return null;
    const key = (value: unknown) => textValue(value);
    return matches.find(record => !record.recent_completion && !record.planned)
      ?? matches.find(record => record.planned)
      ?? matches.find(record => !record.recent_completion)
      ?? [...matches.filter(record => record.recent_completion)]
        .sort((a, b) => Date.parse(textValue(b.completed_at)) - Date.parse(textValue(a.completed_at)) || key(a.key).localeCompare(key(b.key)))[0]
      ?? matches[0];
  };
  const openSpec = () => {
    const target = openSpecTarget();
    if (!target) return;
    const next: DestinationProps['route'] = { dest: 'specs', id: textValue(target.key) };
    if (props.route.ws !== undefined) next.ws = props.route.ws;
    props.onNavigate(next);
  };

  const changeSource = (event: Event & { currentTarget: HTMLSelectElement }) => {
    const next = fileSource(event.currentTarget.value);
    if (next === source()) return;
    // A source change keeps only the scope workspace; owner, path and filter
    // belong to the previous source identity and are dropped deliberately.
    const route: DestinationProps['route'] = { dest: 'files' };
    if (props.route.ws !== undefined) route.ws = props.route.ws;
    if (next !== 'workspace') route.source = next;
    props.onNavigate(route);
  };
  const changeOwner = (event: Event & { currentTarget: HTMLSelectElement }) => {
    const id = event.currentTarget.value;
    if (!id || id === owner()) return;
    const route: DestinationProps['route'] = { dest: 'files', source: source(), id };
    if (props.route.ws !== undefined) route.ws = props.route.ws;
    props.onNavigate(route);
  };

  const emptyTitle = (): string => {
    if (source() === 'context') return 'No registered context';
    if (source() === 'repository') {
      if (repositoryOwners().length === 0) return 'No repositories registered';
      if (!owner()) return 'Choose a repository';
    }
    if (source() === 'package' && !owner()) return 'Choose a spec package';
    if (source() === 'workspace' && !props.route.ws) return 'Choose a workspace';
    return 'No files found';
  };
  const emptyText = (): string => {
    if (source() === 'context') return 'The workspace kit registers no context entries.';
    if (source() === 'repository') {
      if (repositoryOwners().length === 0) return 'The selected workspace declares no repositories.';
      if (!owner()) return 'Choose a declared repository to list its tracked files.';
    }
    if (source() === 'package' && !owner()) return 'Choose an observed spec package to list its files.';
    if (source() === 'workspace' && !props.route.ws) return 'Choose a workspace to list files.';
    return pathPrefix() ? `The listing has no loaded filenames under ${pathPrefix()} yet.` : 'The directory has no readable files, or the listing could not complete.';
  };
  const refreshList = () => {
    if (source() === 'context') props.onRetryWorkspace(String(props.route.ws ?? ''));
    else setRefreshVersion(version => version + 1);
  };

  const caption = () => {
    if (!props.live) return '';
    if (source() === 'context' ? contextLoading() : !listing() && loadingList()) return 'Reading files…';
    if (source() === 'context' ? !props.workspace : !listing() && !loadingList()) return '';
    const count = visible().length;
    const noun = count === 1 ? 'filename' : 'filenames';
    const identity = source() === 'repository' && checkoutIdentity() ? ` · ${checkoutIdentity()}` : '';
    return pathPrefix() ? `${count} loaded ${noun} under ${pathPrefix()}${identity} · read only` : `${count} loaded ${noun}${identity} · read only`;
  };

  return (
    <div class="files-destination">
      <MasterDetail
        listLabel="Files"
        list={<>
          <div class="list-controls">
            <div class="source-choice">
              <label for="file-source">Source</label>
              <select id="file-source" class="ds-input" value={source()} onChange={changeSource}>
                <option value="workspace">Workspace</option>
                <option value="context">Context</option>
                <option value="package">Spec package</option>
                <option value="repository">Repository</option>
              </select>
            </div>
            <Show when={showOwner()}>
              <div class="source-choice">
                <label for="file-owner">{source() === 'repository' ? 'Repository' : 'Package'}</label>
                <select id="file-owner" class="ds-input" value={owner()} onChange={changeOwner}>
                  <option value="">{source() === 'repository' ? 'Choose repository' : 'Choose package'}</option>
                  <For each={ownerValues()}>{value => <option value={value}>{value}</option>}</For>
                </select>
              </div>
            </Show>
            <label class="sr-only" for="find-record">Filter loaded filenames</label>
            <input
              class="ds-input"
              id="find-record"
              type="search"
              placeholder="Filter loaded filenames"
              value={query()}
              onInput={event => setQuery(event.currentTarget.value)}
            />
          </div>
          <div class="list-caption">{caption()}</div>
          <div class="records">
            <Show when={!props.live}>
              <StateNotice announce={false} tone="warning" title="A live dashboard is required">
                Workspace, context, spec package and repository files are read from the local dashboard server. Import a published snapshot to inspect other data.
              </StateNotice>
            </Show>
            <Show when={props.live}>
              <Show when={listMessage()}>
                <StateNotice
                  announce={false}
                  tone="error"
                  title="Files could not be listed"
                  action={<button type="button" class="ds-btn" onClick={refreshList}>Retry listing</button>}
                >
                  {listMessage()}
                </StateNotice>
              </Show>
              <Show when={!listMessage() && !listingReady() && (loadingList() || contextLoading())}>
                <RegionalSkeleton announce={false} rows={5} label="Loading files" />
              </Show>
              <Show when={!listMessage() && listingReady()}>
                <Show
                  when={visible().length > 0}
                  fallback={<EmptyState
                    symbol="▤"
                    title={pathPrefix() ? 'No loaded files in this selection' : emptyTitle()}
                    text={pathPrefix()
                      ? `The listing has no loaded filenames under ${pathPrefix()} yet.`
                      : emptyText()}
                  />}
                >
                  <For each={visible()}>{file => (
                    <button
                      type="button"
                      class={selected(file.name) ? 'record file-record selected' : 'record file-record'}
                      aria-pressed={selected(file.name)}
                      disabled={!file.available}
                      onClick={() => selectFile(file.name)}
                    >
                      <div class="row-heading">
                        <strong>{file.name}</strong>
                        <span class="file-kind">{fileKindLabel(file.name)}</span>
                      </div>
                      <small>{file.available
                        ? (source() === 'context' ? 'Registered context' : (fileSizeLabel(file.size) || 'Available'))
                        : (file.reason || 'Unavailable')}</small>
                    </button>
                  )}</For>
                </Show>
                <For each={source() === 'context' ? [] : listing()?.errors ?? []}>{error => <p class="warn" role="status">{error.name}: {error.message}</p>}</For>
                <Show when={source() === 'package' && recentCompletion() && cursor() === undefined && !(listing()?.files ?? []).some(file => file.name === 'work-tour.html')}>
                  <p class="small muted">No work-tour.html in this package.</p>
                </Show>
                <Show when={source() !== 'context' && listing()?.truncated}>
                  <p class="warn">Listing reached the 10,000 entry or 12 directory level limit.</p>
                </Show>
                <Show when={source() !== 'context' && cursor() !== undefined}>
                  <div class="list-more">
                    <button type="button" class="ds-btn" disabled={loadingList()} onClick={() => void fetchListing(cursor())}>
                      {loadingList() ? 'Loading…' : 'Load more files'}
                    </button>
                    <Show when={source() === 'package'}>
                      <p class="small muted">Showing a page of up to 500 entries.</p>
                    </Show>
                  </div>
                </Show>
              </Show>
              <Show when={!listMessage() && !listingReady() && !loadingList() && !contextLoading()}>
                <EmptyState symbol="▤" title={emptyTitle()} text={emptyText()} />
              </Show>
            </Show>
          </div>
          <div class="detail-foot">
            <button type="button" class="ds-btn" disabled={!props.live || loadingList()} onClick={refreshList}>
              Refresh files
            </button>
          </div>
        </>}
      >
        <header class="reader-head">
          <div>
            <h2 class="mono">{requestedPath() || props.route.path || 'Files'}</h2>
            <p>{sourceLine()}</p>
          </div>
          <div class="reader-actions">
            <Show when={downloadable()}>
              <a class="ds-btn ds-btn--primary" href={downloadUrl() ?? ''} download="">Download file</a>
            </Show>
            <Show when={openSpecTarget()}>
              <button type="button" class="ds-btn" onClick={openSpec}>Open spec</button>
            </Show>
          </div>
        </header>
        <div class="reader" aria-live="polite">
          <Show when={!props.live}>
            <StateNotice announce={false} tone="warning" title="Files require a live dashboard server">
              The selected file is read from the local dashboard server. Retry after it is available.
            </StateNotice>
          </Show>
          <Show when={props.live}>
            <Show
              when={requestedPath()}
              fallback={
                <Show
                  when={pathPrefix()}
                  fallback={<EmptyState symbol="▤" title="Select a file" text="Choose a filename from the list to read it here." />}
                >
                  <EmptyState symbol="▤" title="Directory listing" text={`Showing loaded filenames under ${pathPrefix()}. Choose a filename to read it.`} />
                </Show>
              }
            >
              <Show when={fileError()}>
                <StateNotice
                  announce={false}
                  tone="error"
                  title="File could not be read"
                  action={<button type="button" class="ds-btn" onClick={() => setFileVersion(version => version + 1)}>Retry file</button>}
                >
                  {fileError()}
                </StateNotice>
              </Show>
              <Show when={!fileError() && loadingFile() && !loaded()}>
                <RegionalSkeleton announce={false} rows={6} label="Loading file" />
              </Show>
              <Show when={!fileError() && readerFile()}>{file => (
                <FileReader
                  file={file()}
                  source={source()}
                  owner={owner()}
                  readUrl={readUrl() ?? ''}
                  downloadUrl={downloadUrl() ?? ''}
                  viewUrl={viewUrl()}
                />
              )}</Show>
            </Show>
          </Show>
        </div>
      </MasterDetail>
    </div>
  );
}
