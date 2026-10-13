import { createEffect, createMemo, createSignal, on, onCleanup, Show } from 'solid-js';
import { getJson, postJson } from './api';
import { StatusText } from './primitives';

type Preview = { configured: boolean; state?: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'; url?: string | null; error?: string | null; can_start?: boolean; can_stop?: boolean };

export function PackagePreview(props: { package: string; live: boolean; token?: string }) {
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal<'start' | 'stop' | null>(null);
  let generation = 0;
  let actionVersion = 0;
  let refresh: (() => Promise<void>) | undefined;
  const livePackage = createMemo(() => props.live ? props.package : null);
  createEffect(on(livePackage, pkg => {
    const current = ++generation;
    setPreview(null); setError(''); setBusy(null);
    if (!pkg) return;
    const controller = new AbortController();
    let reading = false;
    const load = async () => {
      if (reading || busy() || document.hidden) return;
      reading = true;
      const version = actionVersion;
      try {
        const value = await getJson<Preview>(`/api/package-preview?package=${encodeURIComponent(pkg)}`, controller.signal);
        if (generation === current && version === actionVersion && !busy()) { setPreview(value); setError(''); }
      } catch (e) {
        if (generation === current && version === actionVersion && !controller.signal.aborted) setError(e instanceof Error ? e.message : 'Dev server status could not be loaded. Retry.');
      } finally { reading = false; }
    };
    refresh = load;
    void load();
    const timer = setInterval(() => void load(), 2000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    onCleanup(() => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); if (generation === current) { generation++; refresh = undefined; } });
  }));
  async function act(action: 'start' | 'stop') {
    if (busy() || !props.live || !props.token) return;
    const current = generation, pkg = props.package, token = props.token;
    actionVersion++;
    setBusy(action); setError('');
    try {
      const value = await postJson<Preview>('/api/package-preview', { package: pkg, action }, token);
      if (generation === current) setPreview(value);
    } catch (e) {
      if (generation === current) setError(e instanceof Error ? e.message : 'Dev server action failed. Retry.');
    } finally { if (generation === current) setBusy(null); }
  }
  const safeUrl = () => {
    if (preview()?.state !== 'running' || !preview()?.url) return null;
    try { const url = new URL(preview()!.url!); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
  };
  const status = () => busy() === 'start' ? 'Starting…' : busy() === 'stop' ? 'Stopping…' : ({ stopped: 'Stopped', starting: 'Starting…', running: 'Running', stopping: 'Stopping…', error: 'Needs attention' }[preview()?.state ?? 'error']);
  return <Show when={props.live && (preview()?.configured || error())}>
    <div class="preview-group" id="package-preview" role="group" aria-label="Dev server">
      <StatusText tone={error() || preview()?.error ? 'warning' : preview()?.state === 'running' ? 'success' : 'neutral'}>{error() ? 'Status unavailable' : status()}</StatusText>
      <Show when={preview()?.configured}>
        <Show when={preview()?.can_start || busy() === 'start' || preview()?.state === 'starting'}><button type="button" class="ds-btn" disabled={!!busy() || !props.token || !preview()?.can_start} aria-describedby={!props.token ? 'preview-token-reason' : undefined} onClick={() => void act('start')}>{busy() === 'start' || preview()?.state === 'starting' ? 'Starting dev server…' : 'Start dev server'}</button></Show>
        <Show when={preview()?.can_stop || busy() === 'stop' || preview()?.state === 'stopping'}><button type="button" class="ds-btn" disabled={!!busy() || !props.token || !preview()?.can_stop} aria-describedby={!props.token ? 'preview-token-reason' : undefined} onClick={() => void act('stop')}>{busy() === 'stop' || preview()?.state === 'stopping' ? 'Stopping dev server…' : 'Stop dev server'}</button></Show>
        <Show when={safeUrl()}>{url => <a class="ds-btn" href={url()} target="_blank" rel="noopener noreferrer">Open dev server</a>}</Show>
      </Show>
      <Show when={error()}><button type="button" class="ds-btn" onClick={() => void refresh?.()}>Retry status</button></Show>
      <Show when={error() || preview()?.error}><span class="preview-note small warn" role="alert">{error() || preview()?.error}</span></Show>
      <Show when={preview()?.configured && !props.token}><span class="preview-note small muted" id="preview-token-reason">Reconnect to the live dashboard to control the dev server.</span></Show>
    </div>
  </Show>;
}
