// Source-qualified adjacent Files reader. The route owns scope, selection and
// history; this adapter only builds URLs, fetches through the shared APIs and
// composes the shared MasterDetail/reader surfaces. No App/route/scope changes.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from 'solid-js';
import { getJson } from '../api';
import { time } from '../format';
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

// Feature-local continuity metadata, deliberately not persisted. It remembers
// the last selected path, the listing scroll and each path's reader scroll in
// the [workspace,source,owner] scope key so a source switch or destination
// return restores where the operator was reading.
type FilesMemory = {
  path?: string;
  listScroll: number;
  readerScroll: Record<string, number>;
};
const filesMemory = new Map<string, FilesMemory>();
// Multiselect owner memory answers the chooser's workspace+source question.
const sourceOwnerMemory = new Map<string, string>();

function memoryFor(key: string): FilesMemory {
  let entry = filesMemory.get(key);
  if (!entry) {
    entry = { listScroll: 0, readerScroll: {} };
    filesMemory.set(key, entry);
  }
  return entry;
}

const ownerMemoryKey = (workspace: string | undefined, source: FileSource): string => `${workspace ?? ''}|${source}`;

export default function FilesDestination(props: DestinationProps) {
  const source = createMemo((): FileSource => fileSource(props.route.source));
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
  const requestedPath = createMemo(() => {
    const path = props.route.path ?? '';
    return path.endsWith('/') ? '' : path;
  });
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
  const [listVersion, setListVersion] = createSignal(0);
  const [readVersion, setReadVersion] = createSignal(0);
  const [query, setQuery] = createSignal(props.route.q ?? '');
  const [announcement, setAnnouncement] = createSignal('');
  const [loaded, setLoaded] = createSignal<LoadedFile | null>(null);
  const [readError, setReadError] = createSignal('');
  const [recheckError, setRecheckError] = createSignal('');
  const [resourceError, setResourceError] = createSignal('');
  const [pendingRead, setPendingRead] = createSignal(false);
  const [slowRead, setSlowRead] = createSignal(false);
  const [resourceReady, setResourceReady] = createSignal(false);
  const [resourceRetryVersion, setResourceRetryVersion] = createSignal(0);
  let listGeneration = 0;
  let listController: AbortController | null = null;
  let fileGeneration = 0;
  let readController: AbortController | null = null;
  let skeletonTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshKeySeen = props.refreshKey;
  let recordsRef: HTMLDivElement | undefined;
  let readerRef: HTMLDivElement | undefined;
  let suppressScrollSave = 0;
  let renderedListKey = '';
  let renderedReaderKey = '';
  let renderedReaderPath = '';
  let listRestoreFrame: number | undefined;
  let readerRestoreFrame: number | undefined;
  let listRestoreToken = 0;
  let readerRestoreToken = 0;
  let restoreReaderOnPublish = false;

  // Scroll is saved under the identity whose content is actually rendered: an
  // in-flight route change must never write its clamped scroll into the
  // incoming scope or path entry.
  function saveScroll(key: string, path: string) {
    if (renderedListKey === key && recordsRef) memoryFor(key).listScroll = recordsRef.scrollTop;
    if (path && renderedReaderKey === key && renderedReaderPath === path && readerRef) {
      memoryFor(key).readerScroll[path] = readerRef.scrollTop;
    }
  }
  function saveRenderedScroll() {
    // Unmount safety net: only the identity whose content belongs to the
    // current route is written, never clamped post-route geometry.
    if (renderedListKey && renderedListKey === scopeId() && recordsRef) memoryFor(renderedListKey).listScroll = recordsRef.scrollTop;
    if (renderedReaderKey && renderedReaderKey === scopeId() && renderedReaderPath === requestedPath() && readerRef) {
      memoryFor(renderedReaderKey).readerScroll[renderedReaderPath] = readerRef.scrollTop;
    }
  }
  const onRecordsScroll = () => {
    if (suppressScrollSave > 0 || !renderedListKey || !recordsRef) return;
    memoryFor(renderedListKey).listScroll = recordsRef.scrollTop;
  };
  const onReaderScroll = () => {
    if (suppressScrollSave > 0 || !renderedReaderKey || !renderedReaderPath || !readerRef) return;
    memoryFor(renderedReaderKey).readerScroll[renderedReaderPath] = readerRef.scrollTop;
  };

  const recentCompletion = () => source() === 'package' && Boolean(props.records.find(item => textValue(item?.package) === owner())?.recent_completion);
  const listNoun = () => (source() === 'package' ? 'Package' : source() === 'repository' ? 'Repository' : 'Workspace');

  const fetchListing = async (next?: string | number, refresh = false) => {
    if (!props.live || source() === 'context') return;
    const requestedScope = scope();
    const key = scopeKey(requestedScope);
    const url = listFileUrl(requestedScope, next);
    if (!url) {
      // Missing owner/workspace is guidance, not a failure: the caller keeps
      // the chooser/empty state and no endpoint is invented.
      setListing(null);
      renderedListKey = '';
      setListError('');
      return;
    }
    listController?.abort();
    const controller = new AbortController();
    listController = controller;
    const token = ++listGeneration;
    setLoadingList(true);
    setListError('');
    try {
      const data = await getJson<FileListing>(url, controller.signal);
      if (token !== listGeneration || key !== scopeId()) return;
      const prior = next !== undefined && !refresh ? listing()?.files ?? [] : [];
      renderedListKey = key;
      setListing({ ...data, files: [...prior, ...(data.files ?? [])] });
      setCursor(data.next_cursor ?? undefined);
    } catch {
      // A failed listing keeps the published rows (including prior append
      // pages) and only surfaces the regional list error.
      if (token === listGeneration && !controller.signal.aborted && key === scopeId()) {
        setListError(`${listNoun()} files unavailable. Refresh to retry.`);
      }
    } finally {
      if (token === listGeneration) setLoadingList(false);
    }
  };

  const revalidateRead = () => {
    // Only an explicit failed-resource retry changes the browser-owned
    // resource URL; healthy same-file rechecks keep the exact src/node.
    if (resourceError()) setResourceRetryVersion(version => version + 1);
    setReadError('');
    setRecheckError('');
    setResourceError('');
    setReadVersion(version => version + 1);
  };
  const revalidateFiles = () => {
    saveScroll(scopeId(), requestedPath());
    if (source() === 'context') props.onRetryWorkspace(String(props.route.ws ?? ''));
    else setListVersion(version => version + 1);
    setReadVersion(version => version + 1);
  };

  createEffect(on(scopeId, () => {
    // A scope change owns a fresh listing lifetime; the read effect below
    // clears its own controller, retained bytes and readiness on the same
    // identity change.
    listController?.abort();
    listGeneration++;
    setListing(null);
    setCursor(undefined);
    setListError('');
    renderedListKey = '';
    untrack(() => { void fetchListing(); });
  }));
  createEffect(on(listVersion, version => {
    if (version > 0) untrack(() => { void fetchListing(undefined, true); });
  }));
  createEffect(() => {
    // The App header refresh revalidates the listing and the selected read.
    const key = props.refreshKey;
    if (key === refreshKeySeen) return;
    refreshKeySeen = key;
    untrack(revalidateFiles);
  });
  createEffect(() => {
    // Remember a valid resolved owner observed in any source-qualified scope
    // (route, history or chooser) so a later source switch can select it
    // without a manual chooser step. Authoritative options decide validity:
    // an explicit unknown owner is never remembered and no other entry is
    // guessed.
    const current = source();
    if (current !== 'repository' && current !== 'package') return;
    const resolved = owner();
    if (!resolved) return;
    const options = current === 'package' ? packageOwners() : repositoryOwners();
    if (!options.includes(resolved)) return;
    sourceOwnerMemory.set(ownerMemoryKey(props.route.ws, current), resolved);
  });

  createEffect(on(() => [scopeId(), requestedPath(), readVersion()] as const, ([, requested]) => {
    // The read owns its controller and generation. The concrete scope and path
    // are captured before the await so a late response can never publish into
    // a newer selection, and a same-identity recheck retains the current
    // object. The outgoing rendered identity's scroll is saved first.
    const requestedScope = scope();
    const requestedKey = scopeKey(requestedScope);
    fileGeneration++;
    const token = fileGeneration;
    readController?.abort();
    readController = null;
    if (skeletonTimer !== undefined) {
      clearTimeout(skeletonTimer);
      skeletonTimer = undefined;
    }
    setSlowRead(false);
    setAnnouncement('');

    const prior = untrack(loaded);
    const sameIdentity = Boolean(requested && prior && prior.scopeKey === requestedKey && prior.path === requested);
    // A same-identity recheck keeps retained content, so capture its current
    // position before the refresh. Identity changes were already saved by the
    // chooser/select and native scroll handlers, never from post-route DOM.
    if (sameIdentity) saveScroll(requestedKey, requested);

    if (!requested || !props.live) {
      setLoaded(null);
      renderedReaderKey = '';
      renderedReaderPath = '';
      setReadError('');
      setRecheckError('');
      setResourceError('');
      setPendingRead(false);
      setResourceReady(false);
      return;
    }
    const url = readFileUrl(requestedScope, requested);
    if (!url) {
      setLoaded(null);
      renderedReaderKey = '';
      renderedReaderPath = '';
      setReadError('File unavailable. Choose another file.');
      setRecheckError('');
      setResourceError('');
      setPendingRead(false);
      setResourceReady(false);
      return;
    }
    setReadError('');
    setRecheckError('');
    setResourceError('');
    if (!sameIdentity) {
      // A changed identity clears old bytes immediately; the 300 ms skeleton
      // timer runs only for this first load, never for a retained recheck.
      setLoaded(null);
      renderedReaderKey = '';
      renderedReaderPath = '';
      setResourceReady(false);
      skeletonTimer = setTimeout(() => {
        skeletonTimer = undefined;
        if (token === fileGeneration) setSlowRead(true);
      }, 300);
    }
    setPendingRead(true);

    const controller = new AbortController();
    readController = controller;
    void (async () => {
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('unavailable');
        const kind = response.headers.get('X-Package-File-Kind') || 'text';
        const type = response.headers.get('Content-Type') || '';
        const text = kind === 'text' || kind === 'markdown' || kind === 'json' ? await response.text() : null;
        if (token !== fileGeneration) return;
        const headerLength = Number(response.headers.get('Content-Length'));
        renderedReaderKey = requestedKey;
        renderedReaderPath = requested;
        restoreReaderOnPublish = !sameIdentity;
        setLoaded({
          scopeKey: requestedKey,
          path: requested,
          kind,
          text,
          type,
          size: Number.isFinite(headerLength) ? headerLength : 0,
          receivedAt: Date.now(),
        });
        memoryFor(requestedKey).path = requested;
        const resourceKind = kind === 'image' || kind === 'html';
        if (resourceKind) {
          // A same-identity same-kind recheck keeps the exact image/iframe
          // node and src, so no new load fires: retain the actual prior state
          // instead of disabling Download forever.
          setResourceReady(sameIdentity && prior?.kind === kind ? untrack(resourceReady) : false);
        } else {
          setResourceReady(true);
        }
        setAnnouncement(`Read ${requested}`);
      } catch {
        if (token === fileGeneration && !controller.signal.aborted) {
          if (sameIdentity) setRecheckError('The file could not be rechecked. The last received copy is still shown.');
          else setReadError('File unavailable or exceeds the 8 MiB limit. Choose another file.');
        }
      } finally {
        if (token === fileGeneration) {
          setPendingRead(false);
          setSlowRead(false);
          if (skeletonTimer !== undefined) {
            clearTimeout(skeletonTimer);
            skeletonTimer = undefined;
          }
        }
      }
    })();
    onCleanup(() => {
      controller.abort();
      if (skeletonTimer !== undefined) {
        clearTimeout(skeletonTimer);
        skeletonTimer = undefined;
      }
    });
  }));

  onCleanup(() => {
    if (listRestoreFrame !== undefined) cancelAnimationFrame(listRestoreFrame);
    if (readerRestoreFrame !== undefined) cancelAnimationFrame(readerRestoreFrame);
    saveRenderedScroll();
    listController?.abort();
    readController?.abort();
  });

  createEffect(() => {
    // The route owns the filter value; local typing only mirrors it and never
    // refetches a listing or a read.
    const value = props.route.q ?? '';
    setQuery(current => (current === value ? current : value));
  });
  // Context rows render from the workspace detail, not a listing response.
  const listRendered = () => (source() === 'context' ? (props.workspace ? contextFiles() : null) : listing());
  createEffect(on(() => [scopeId(), listRendered()] as const, ([key, rendered]) => {
    // Any dependency change cancels a scheduled restore frame.
    const token = ++listRestoreToken;
    if (listRestoreFrame !== undefined) {
      cancelAnimationFrame(listRestoreFrame);
      listRestoreFrame = undefined;
    }
    if (!rendered) return;
    listRestoreFrame = requestAnimationFrame(() => {
      listRestoreFrame = undefined;
      // The captured identity must still be the current rendering target.
      if (token !== listRestoreToken || !recordsRef) return;
      if (untrack(scopeId) !== key) return;
      const target = filesMemory.get(key)?.listScroll;
      if (target == null) return;
      renderedListKey = key;
      suppressScrollSave += 1;
      recordsRef.scrollTop = target;
      requestAnimationFrame(() => { suppressScrollSave = Math.max(0, suppressScrollSave - 1); });
    });
  }));
  createEffect(on(() => [scopeId(), requestedPath(), loaded()] as const, ([key, path, file]) => {
    // Any identity change (including pending/null) cancels a scheduled frame.
    const token = ++readerRestoreToken;
    if (readerRestoreFrame !== undefined) {
      cancelAnimationFrame(readerRestoreFrame);
      readerRestoreFrame = undefined;
    }
    // Only a fresh identity restore consumes memory. A same-identity recheck
    // republishes while the content stays visible, so keep the current scroll.
    if (!file || file.scopeKey !== key || file.path !== path) return;
    if (!restoreReaderOnPublish) return;
    restoreReaderOnPublish = false;
    readerRestoreFrame = requestAnimationFrame(() => {
      readerRestoreFrame = undefined;
      if (token !== readerRestoreToken || !readerRef) return;
      const current = untrack(loaded);
      if (untrack(scopeId) !== key || untrack(requestedPath) !== path) return;
      if (!current || current.scopeKey !== key || current.path !== path) return;
      const target = filesMemory.get(key)?.readerScroll?.[path];
      if (target == null) return;
      renderedReaderKey = key;
      renderedReaderPath = path;
      suppressScrollSave += 1;
      readerRef.scrollTop = target;
      requestAnimationFrame(() => { suppressScrollSave = Math.max(0, suppressScrollSave - 1); });
    });
  }));

  const listingReady = () => (source() === 'context' ? Boolean(props.workspace) : listing() !== null);
  const contextLoading = () => source() === 'context' && !props.workspace && props.workspacePending;
  const contextError = () => (source() === 'context' && !props.workspace ? props.workspaceError : '');
  const listMessage = () => listError() || contextError();
  const listedSize = (path: string) => (listing()?.files ?? []).find(entry => entry.name === path)?.size;
  const currentLoaded = () => {
    const file = loaded();
    const path = requestedPath();
    return Boolean(file && path && file.scopeKey === scopeId() && file.path === path);
  };
  const readerFile = (): LoadedFile | null => {
    const file = loaded();
    const path = requestedPath();
    if (!file || !path || file.scopeKey !== scopeId() || file.path !== path) return null;
    if (file.size > 0) return file;
    const size = listedSize(file.path);
    return size == null ? file : { ...file, size };
  };
  const rechecking = () => pendingRead() && currentLoaded();
  const firstLoading = () => pendingRead() && !currentLoaded();
  const readNotice = () => recheckError() || readError() || resourceError();
  const noticeTitle = () => (recheckError() ? 'File could not be rechecked' : readError() ? 'File could not be read' : 'File could not be displayed');
  const noticeText = () => (recheckError()
    ? `${recheckError()} Last received at ${currentLoaded() ? time(loaded()!.receivedAt) : 'an earlier read'}.`
    : readError() || resourceError());
  const visible = () => filterLoadedFiles(source() === 'context' ? contextFiles() : listing()?.files ?? [], query(), pathPrefix());
  const selected = (name: string) => requestedPath() === name;
  const selectFile = (name: string) => {
    if (name === requestedPath()) return;
    saveScroll(scopeId(), requestedPath());
    memoryFor(scopeId()).path = name;
    props.onOpenFile(name);
  };
  const readUrl = () => (requestedPath() ? readFileUrl(scope(), requestedPath()) : null);
  const downloadUrl = () => (requestedPath() ? readFileUrl(scope(), requestedPath(), true) : null);
  const viewUrl = () => (source() === 'package' && requestedPath() && owner() ? packageViewUrl(owner(), requestedPath()) : '');
  const downloadEnabled = () => Boolean(downloadUrl())
    && currentLoaded()
    && !pendingRead()
    && !readError()
    && !recheckError()
    && !resourceError()
    && !props.connectionFailed
    && resourceReady();
  const headDownloadVisible = () => Boolean(requestedPath()) && loaded()?.kind !== 'download';
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

  // Concrete scope for a chooser target that has not become the route yet.
  const targetScope = (sourceValue: FileSource, ownerValue: string): FileScope => {
    if (sourceValue === 'package') return { source: sourceValue, owner: ownerValue, workspace: props.route.ws };
    if (sourceValue === 'repository') return { source: sourceValue, workspace: props.route.ws, owner: ownerValue };
    return { source: sourceValue, workspace: props.route.ws };
  };
  const explicitlyRememberedOwner = (sourceValue: FileSource): string => {
    if (sourceValue !== 'package' && sourceValue !== 'repository') return '';
    const remembered = sourceOwnerMemory.get(ownerMemoryKey(props.route.ws, sourceValue)) ?? '';
    const options = sourceValue === 'package' ? packageOwners() : repositoryOwners();
    return remembered && options.includes(remembered) ? remembered : '';
  };
  const rememberedPath = (sourceValue: FileSource, ownerValue: string): string =>
    filesMemory.get(scopeKey(targetScope(sourceValue, ownerValue)))?.path ?? '';

  const changeSource = (event: Event & { currentTarget: HTMLSelectElement }) => {
    const next = fileSource(event.currentTarget.value);
    if (next === source()) return;
    // A source change is a user transition: the target route carries the
    // remembered owner and last selected path for that scope. An external or
    // history route never triggers this navigation itself.
    saveScroll(scopeId(), requestedPath());
    const route: DestinationProps['route'] = { dest: 'files' };
    if (props.route.ws !== undefined) route.ws = props.route.ws;
    if (next !== 'workspace') route.source = next;
    const explicitOwner = explicitlyRememberedOwner(next);
    if (explicitOwner) route.id = explicitOwner;
    const ownerValue = explicitOwner || (next === 'repository' && repositoryOwners().length === 1 ? repositoryOwners()[0] : '');
    const nextPath = rememberedPath(next, ownerValue);
    if (nextPath) route.path = nextPath;
    props.onNavigate(route);
  };
  const changeOwner = (event: Event & { currentTarget: HTMLSelectElement }) => {
    const id = event.currentTarget.value;
    if (!id || id === owner()) return;
    saveScroll(scopeId(), requestedPath());
    sourceOwnerMemory.set(ownerMemoryKey(props.route.ws, source()), id);
    const route: DestinationProps['route'] = { dest: 'files', source: source(), id };
    if (props.route.ws !== undefined) route.ws = props.route.ws;
    const nextPath = rememberedPath(source(), id);
    if (nextPath) route.path = nextPath;
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
                  <option value="" selected={owner() === ''}>{source() === 'repository' ? 'Choose repository' : 'Choose package'}</option>
                  <For each={ownerValues()}>{value => <option value={value} selected={value === owner()}>{value}</option>}</For>
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
              onInput={event => { setQuery(event.currentTarget.value); props.onQuery(event.currentTarget.value); }}
            />
          </div>
          <div class="list-caption">{caption()}</div>
          <div class="records" ref={recordsRef} onScroll={onRecordsScroll}>
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
                  action={<button type="button" class="ds-btn" onClick={revalidateFiles}>Retry listing</button>}
                >
                  {listMessage()}
                </StateNotice>
              </Show>
              <Show when={!listMessage() && !listingReady() && (loadingList() || contextLoading())}>
                <RegionalSkeleton announce={false} rows={5} label="Loading files" />
              </Show>
              <Show when={listingReady()}>
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
            <button type="button" class="ds-btn" disabled={!props.live || loadingList()} onClick={revalidateFiles}>
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
            <Show when={headDownloadVisible()}>
              <Show
                when={downloadEnabled()}
                fallback={<button type="button" class="ds-btn ds-btn--primary" disabled>Download file</button>}
              >
                <a class="ds-btn ds-btn--primary" href={downloadUrl() ?? ''} download="">Download file</a>
              </Show>
            </Show>
            <Show when={Boolean(requestedPath())}>
              <button type="button" class="ds-btn" disabled={!props.live || pendingRead()} onClick={revalidateRead}>Refresh file</button>
            </Show>
            <Show when={openSpecTarget()}>
              <button type="button" class="ds-btn" onClick={openSpec}>Open spec</button>
            </Show>
          </div>
        </header>
        <div class="reader" ref={readerRef} onScroll={onReaderScroll}>
          <p class="sr-only" role="status">{announcement()}</p>
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
              <Show when={props.connectionFailed}>
                <StateNotice
                  tone="warning"
                  title="Reading a retained copy"
                  action={<button type="button" class="ds-btn" onClick={props.onRetryConnection}>Retry connection</button>}
                >
                  {currentLoaded()
                    ? `Last received at ${time(loaded()!.receivedAt)}. A fresh download is unavailable while disconnected.`
                    : 'The dashboard connection failed. Retry the connection to read this file.'}
                </StateNotice>
              </Show>
              <Show when={firstLoading()}>
                <p class="muted" role="status">Reading {requestedPath()}…</p>
              </Show>
              <Show when={rechecking()}>
                <StateNotice
                  tone="info"
                  title="Rechecking this file"
                  action={<button type="button" class="ds-btn" onClick={revalidateRead}>Refresh file</button>}
                >
                  The existing document stays visible until its latest content can be read.
                </StateNotice>
              </Show>
              <Show when={readNotice()}>
                <StateNotice
                  tone="error"
                  title={noticeTitle()}
                  action={<button type="button" class="ds-btn" onClick={revalidateRead}>Retry file</button>}
                >
                  {noticeText()}
                </StateNotice>
              </Show>
              <Show when={firstLoading() && slowRead()}>
                <RegionalSkeleton announce={false} rows={6} label="Loading file" />
              </Show>
              <Show when={readerFile()}>{file => {
                // Readiness callbacks belong to the mounted selection, not to
                // an object identity: a size-fallback clone must not disable
                // the current selection's resource state.
                const mountedScope = untrack(scopeId);
                const mountedPath = untrack(requestedPath);
                const stillSelected = () => untrack(scopeId) === mountedScope && untrack(requestedPath) === mountedPath;
                return (
                  <FileReader
                    file={file()}
                    source={source()}
                    owner={owner()}
                    readUrl={readUrl() ?? ''}
                    downloadUrl={downloadUrl() ?? ''}
                    viewUrl={viewUrl()}
                    offline={props.connectionFailed}
                    downloadEnabled={downloadEnabled()}
                    resourceRetryVersion={resourceRetryVersion()}
                    onResourceReady={() => { if (stillSelected()) setResourceReady(true); }}
                    onResourceError={message => { if (stillSelected()) { setResourceReady(false); setResourceError(message); } }}
                  />
                );
              }}</Show>
            </Show>
          </Show>
        </div>
        <Show when={props.live && currentLoaded()}>
          <footer class="detail-foot">
            {sourceLine()} · {time(loaded()!.receivedAt)} last received{props.connectionFailed ? ' · disconnected' : ''}
          </footer>
        </Show>
      </MasterDetail>
    </div>
  );
}
