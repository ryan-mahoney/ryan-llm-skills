import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from 'solid-js';
import { getJson } from './api';
import { esc, statusMarkdown } from './format';

type FileEntry = { name: string; available: boolean; size?: number; reason?: string };
type Listing = { files: FileEntry[]; next_cursor?: string | number | null; truncated?: boolean; errors?: { name: string; message: string }[] };
type LoadedFile = { kind: string; text: string | null };
type Props = { source: 'workspace' | 'package'; owner: string; live: boolean; initialFile?: string | null; pathPrefix?: string; recentCompletion?: boolean; onOpen?: (name: string) => void };

const params = (values: Record<string, string | number | undefined>) => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
const fileApi = (source: Props['source'], owner: string, name: string, download = false) => source === 'workspace'
  ? `/api/workspace-file?${params({ id: owner, file: name, ...(download ? { download: '1' } : {}) })}`
  : `/api/package-file?${params({ package: owner, file: name, ...(download ? { download: '1' } : {}) })}`;
const listApi = (source: Props['source'], owner: string, cursor?: string | number) => source === 'workspace'
  ? `/api/workspace-files?${params({ id: owner, cursor })}`
  : `/api/package-files?${params({ package: owner, cursor })}`;
const b64url = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};
const packageView = (owner: string, name: string) => `/package-view/${b64url(owner)}/${name.split('/').map(encodeURIComponent).join('/')}`;
const relativePackagePath = (path: string, current: string) => {
  if (!path || /^(?:[a-z]+:|\/|#|\?)/i.test(path)) return null;
  const parts = (current.includes('/') ? current.slice(0, current.lastIndexOf('/')).split('/') : []).filter(Boolean);
  let decoded = '';
  try { decoded = decodeURIComponent(path.split(/[?#]/)[0]); } catch { return null; }
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
};

export default function Files(props: Props) {
  const [listing, setListing] = createSignal<Listing | null>(null);
  const [listError, setListError] = createSignal('');
  const [loadingList, setLoadingList] = createSignal(false);
  const [selected, setSelected] = createSignal('');
  const [loaded, setLoaded] = createSignal<LoadedFile | null>(null);
  const [fileError, setFileError] = createSignal('');
  const [loadingFile, setLoadingFile] = createSignal(false);
  const [refreshVersion, setRefreshVersion] = createSignal(0);
  const [cursor, setCursor] = createSignal<string | number | undefined>(undefined);
  let generation = 0;
  const ownerKey = createMemo(() => `${props.source}:${props.owner}`);

  const fetchListing = async (next?: string | number, refresh = false) => {
    if (!props.live) { setListError(props.source === 'workspace' ? 'Workspace files require a live local dashboard server.' : 'Package files require a live published package on the local dashboard server.'); return; }
    const token = ++generation; setLoadingList(true); setListError('');
    try {
      const data = await getJson<Listing>(listApi(props.source, props.owner, next));
      if (token !== generation) return;
      const prior = next && !refresh ? listing()?.files ?? [] : [];
      setListing({ ...data, files: [...prior, ...(data.files ?? [])] }); setCursor(data.next_cursor ?? undefined);
    } catch { if (token === generation) setListError(`${props.source === 'workspace' ? 'Workspace' : 'Package'} files unavailable. Refresh to retry.`); }
    finally { if (token === generation) setLoadingList(false); }
  };
  createEffect(on(() => [ownerKey(), props.live] as const, () => {
    setListing(null); setCursor(undefined); setListError(''); setSelected(props.initialFile ?? ''); setLoaded(null); setFileError('');
    untrack(() => { void fetchListing(); });
    onCleanup(() => { generation++; });
  }));
  createEffect(on(refreshVersion, version => {
    if (version > 0) untrack(() => { void fetchListing(undefined, true); });
  }));
  createEffect(on(() => [props.source, props.owner, props.initialFile] as const, ([, , requested]) => {
    if ((requested ?? '') !== untrack(selected)) { setSelected(requested ?? ''); setLoaded(null); setFileError(''); }
  }));
  createEffect(on(() => props.pathPrefix, (prefix, previous) => {
    if (prefix && prefix !== previous) { setSelected(''); setLoaded(null); setFileError(''); }
  }));
  createEffect(() => {
    const name = selected(); const owner = ownerKey();
    if (!name) return;
    if (!props.live) { setFileError('Files require a live local dashboard server.'); return; }
    let active = true; const controller = new AbortController(); setLoadingFile(true); setFileError('');
    void (async () => {
      try {
        const response = await fetch(fileApi(props.source, props.owner, name), { signal: controller.signal });
        if (!response.ok) throw new Error('unavailable');
        const kind = response.headers.get('X-Package-File-Kind') || 'text';
        const text = ['text', 'markdown', 'json'].includes(kind) ? await response.text() : null;
        if (active && owner === ownerKey()) setLoaded({ kind, text });
      } catch { if (active && !controller.signal.aborted) setFileError('File unavailable or exceeds the 8 MiB limit. Choose another file.'); }
      finally { if (active) setLoadingFile(false); }
    })();
    onCleanup(() => { active = false; controller.abort(); });
  });
  const markdownHtml = createMemo(() => {
    const file = loaded(); if (!file || file.kind !== 'markdown' || !file.text) return '';
    if (props.source === 'workspace') return statusMarkdown(file.text);
    // Keep markdown rendering in the shared safe renderer; rewrite only relative package assets.
    const images: string[] = [];
    const withImages = file.text.replace(/!\[([^\]\n]*)\]\(([^\s)]+)\)/g, (match, alt: string, target: string) => {
      const path = relativePackagePath(target, selected()); if (!path) return match;
      const token = `PACKAGEIMAGE${images.length}TOKEN`;
      images.push(`<img src="${esc(packageView(props.owner, path))}" alt="${esc(alt)}" style="max-width:100%">`);
      return token;
    });
    const rewritten = withImages.replace(/(?<!!)\[([^\]\n]*)\]\(([^\s)]+)\)/g, (match, label: string, target: string) => {
      const path = relativePackagePath(target, selected()); if (!path) return match;
      return `[${label}](${packageView(props.owner, path)})`;
    });
    return statusMarkdown(rewritten, path => path.startsWith(packageView(props.owner, '')) ? path : null).replace(/PACKAGEIMAGE(\d+)TOKEN/g, (match, index: string) => images[Number(index)] ?? match);
  });
  const renderedContent = createMemo(() => {
    const file = loaded(); if (!file) return null;
    if (file.kind === 'html') return <><iframe title={selected()} sandbox="allow-scripts" src={props.source === 'package' ? packageView(props.owner, selected()) : fileApi(props.source, props.owner, selected())} style={{ width: '100%', height: '650px', border: '1px solid var(--line)' }} /><p class="small muted">HTML is isolated. Network access and forms are disabled; external resources are unavailable.</p></>;
    if (file.kind === 'image') return <img src={fileApi(props.source, props.owner, selected())} alt={selected()} style={{ 'max-width': '100%' }} />;
    if (file.kind === 'markdown') return <div id="file-content" class="status-markdown" innerHTML={markdownHtml()} />;
    if (file.kind === 'download') return <p class="small muted">Binary file available to download.</p>;
    let value = file.text ?? '';
    if (file.kind === 'json') { try { value = JSON.stringify(JSON.parse(value), null, 2); } catch { /* Keep malformed JSON readable as text. */ } }
    return <pre style={{ 'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere' }}>{value}</pre>;
  });

  const visibleFiles = (files: FileEntry[]) => {
    const prefix = props.pathPrefix ?? '';
    return prefix ? files.filter(file => file.name.startsWith(prefix)) : files;
  };

  return <section class="section" aria-labelledby="files-heading">
    <div class="section-head"><h3 id="files-heading">Files</h3><span class="small muted">Read-only</span><button type="button" onClick={() => { setRefreshVersion(v => v + 1); }}>Refresh files</button></div>
    <Show when={!props.live}><p class="small muted">{props.source === 'workspace' ? 'Workspace files require a live local dashboard server.' : 'Package files require a live published package on the local dashboard server.'}</p></Show>
    <Show when={listError()}><p class="warn" role="status">{listError()}</p></Show>
    <Show when={loadingList() && !listing()}><p class="small muted">Loading files…</p></Show>
    <Show when={listing()} keyed>{data => <div class="files-list">
      <Show when={visibleFiles(data.files).length > 0} fallback={<p class="small muted">{props.pathPrefix ? 'No loaded files in this selection.' : `No ${props.source} files found.`}</p>}>
        <For each={visibleFiles(data.files)}>{file => <p class="info-row">{file.available
          ? <><button type="button" aria-pressed={selected() === file.name} onClick={() => { setSelected(file.name); setLoaded(null); setFileError(''); props.onOpen?.(file.name); }}>{file.name}</button> <span class="small muted">{file.size ?? 0} bytes</span></>
          : <>{file.name} · {file.reason || 'Unavailable'}</>}</p>}</For>
      </Show>
      <For each={data.errors ?? []}>{error => <p class="warn">{error.name}: {error.message}</p>}</For>
      <Show when={props.source === 'package' && props.recentCompletion && !data.next_cursor && !data.files.some(f => f.name === 'work-tour.html')}><p class="small muted">No work-tour.html in this package.</p></Show>
      <Show when={data.truncated}><p class="warn">Listing reached the 10,000 entry or 12 directory level limit.</p></Show>
      <Show when={cursor() !== undefined}><button type="button" disabled={loadingList()} onClick={() => void fetchListing(cursor())}>{loadingList() ? 'Loading…' : 'Load more files'}</button><Show when={props.source === 'package'}><p class="small muted">Showing a page of up to 500 entries.</p></Show></Show>
    </div>}</Show>
    <Show when={selected()}><section class="section file-viewer" aria-live="polite"><h4>{selected()}</h4><p><a href={fileApi(props.source, props.owner, selected(), true)} download="">Download file</a></p>
      <Show when={loadingFile() && !loaded()}><p class="small muted">Loading file…</p></Show><Show when={fileError()}><p class="warn" role="status">{fileError()}</p></Show><Show when={loaded()}>{renderedContent()}</Show>
    </section></Show>
  </section>;
}
