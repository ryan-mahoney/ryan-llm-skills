// Source-qualified adjacent Files reader. The route owns scope, selection and
// history; this adapter only builds URLs, fetches through the shared APIs and
// composes the shared MasterDetail/reader surfaces. No App/route/scope changes.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from 'solid-js';
import { getJson } from '../api';
import {
  fileKindLabel,
  fileSizeLabel,
  filterLoadedFiles,
  listFileUrl,
  readFileUrl,
  scopeKey,
  type FileListing,
  type FileScope,
  type LoadedFile,
} from '../files-model';
import { packageViewUrl } from '../observation-format';
import { EmptyState, MasterDetail, RegionalSkeleton, StateNotice } from '../primitives';
import { FileReader } from '../FileReader';
import type { DestinationProps } from './index';

type FileKindSource = 'workspace' | 'package';
const sourceOf = (route: DestinationProps['route']): FileKindSource => (route.source === 'package' ? 'package' : 'workspace');
const textValue = (value: unknown): string => (typeof value === 'string' ? value : '');

export default function FilesDestination(props: DestinationProps) {
  const source = (): FileKindSource => sourceOf(props.route);
  const owner = () => (source() === 'package' ? props.route.id ?? '' : props.route.ws ?? '');
  const scope = (): FileScope => (source() === 'package'
    ? { source: 'package', owner: props.route.id, workspace: props.route.ws }
    : { source: 'workspace', workspace: props.route.ws });
  const scopeId = createMemo(() => scopeKey(scope()));
  const requestedPath = () => {
    const path = props.route.path ?? '';
    return path.endsWith('/') ? '' : path;
  };
  const pathPrefix = () => {
    const path = props.route.path ?? '';
    return path.endsWith('/') ? path : undefined;
  };
  // A package select option needs a canonical package id. Cold links carry it
  // in the route; otherwise the scoped record set supplies a published package.
  const candidatePackage = () => props.route.id
    || props.records.map(item => textValue(item?.package)).find(Boolean)
    || '';

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

  const recentCompletion = () => {
    if (source() !== 'package') return false;
    return Boolean(props.records.find(item => item.package === owner())?.recent_completion);
  };

  const fetchListing = async (next?: string | number, refresh = false) => {
    if (!props.live) return;
    const url = listFileUrl(scope(), next);
    if (!url) {
      setListError('Choose a workspace or spec package to list files.');
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
      if (token === listGeneration) setListError(`${source() === 'package' ? 'Package' : 'Workspace'} files unavailable. Refresh to retry.`);
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

  const listedSize = (path: string) => (listing()?.files ?? []).find(entry => entry.name === path)?.size;
  const readerFile = (): LoadedFile | null => {
    const file = loaded();
    if (!file || file.size > 0) return file;
    const size = listedSize(file.path);
    return size == null ? file : { ...file, size };
  };
  const visible = () => filterLoadedFiles(listing()?.files ?? [], query(), pathPrefix());
  const selected = (name: string) => requestedPath() === name;
  const selectFile = (name: string) => { if (name !== requestedPath()) props.onOpenFile(name); };
  const readUrl = () => (requestedPath() ? readFileUrl(scope(), requestedPath()) : null);
  const downloadUrl = () => (requestedPath() ? readFileUrl(scope(), requestedPath(), true) : null);
  const viewUrl = () => (source() === 'package' && requestedPath() && owner() ? packageViewUrl(owner(), requestedPath()) : '');
  const downloadable = () => Boolean(loaded() && loaded()!.kind !== 'download' && downloadUrl());
  const sourceLine = () => (source() === 'package' ? `Spec package · ${owner()}` : `Workspace · ${props.route.ws ?? ''}`);

  const changeSource = (event: Event & { currentTarget: HTMLSelectElement }) => {
    const next: FileKindSource = event.currentTarget.value === 'package' ? 'package' : 'workspace';
    if (next === source()) return;
    if (next === 'package') {
      const id = candidatePackage();
      if (!id) return;
      props.onNavigate({ dest: 'files', ws: props.route.ws, source: 'package', id });
    } else {
      props.onNavigate({ dest: 'files', ws: props.route.ws });
    }
  };

  const caption = () => {
    if (!props.live) return '';
    if (!listing()) return loadingList() ? 'Reading files…' : '';
    const count = visible().length;
    const noun = count === 1 ? 'filename' : 'filenames';
    return pathPrefix() ? `${count} loaded ${noun} under ${pathPrefix()} · read only` : `${count} loaded ${noun} · read only`;
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
                <option value="package" disabled={!candidatePackage()}>Spec package</option>
              </select>
            </div>
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
                Workspace and spec package files are read from the local dashboard server. Import a published snapshot to inspect other data.
              </StateNotice>
            </Show>
            <Show when={props.live}>
              <Show when={listError()}>
                <StateNotice
                  announce={false}
                  tone="error"
                  title="Files could not be listed"
                  action={<button type="button" class="ds-btn" onClick={() => setRefreshVersion(version => version + 1)}>Retry listing</button>}
                >
                  {listError()}
                </StateNotice>
              </Show>
              <Show when={!listing() && loadingList()}>
                <RegionalSkeleton announce={false} rows={5} label="Loading files" />
              </Show>
              <Show when={listing()}>
                <Show
                  when={visible().length > 0}
                  fallback={<EmptyState
                    symbol="▤"
                    title={pathPrefix() ? 'No loaded files in this selection' : 'No files found'}
                    text={pathPrefix()
                      ? `The listing has no loaded filenames under ${pathPrefix()} yet.`
                      : 'The directory has no readable files, or the listing could not complete.'}
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
                      <small>{file.available ? (fileSizeLabel(file.size) || 'Available') : (file.reason || 'Unavailable')}</small>
                    </button>
                  )}</For>
                </Show>
                <For each={listing()?.errors ?? []}>{error => <p class="warn" role="status">{error.name}: {error.message}</p>}</For>
                <Show when={source() === 'package' && recentCompletion() && cursor() === undefined && !(listing()?.files ?? []).some(file => file.name === 'work-tour.html')}>
                  <p class="small muted">No work-tour.html in this package.</p>
                </Show>
                <Show when={listing()?.truncated}>
                  <p class="warn">Listing reached the 10,000 entry or 12 directory level limit.</p>
                </Show>
                <Show when={cursor() !== undefined}>
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
            </Show>
          </div>
          <div class="detail-foot">
            <button type="button" class="ds-btn" disabled={!props.live || loadingList()} onClick={() => setRefreshVersion(version => version + 1)}>
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
