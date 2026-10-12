import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from 'solid-js';
import { getJson } from './api';

type Screen = { step: number; file: string; title: string; produced: boolean; person?: string; job?: string; kind?: string; state?: string; primary_action?: string; shell_from?: number; notes?: string; captured?: Record<string, boolean> };
type Design = { slug: string; title: string; path: string; summary: { produced: number; total: number; captured: number }; viewport: { posture: string; widths: number[] }; design_system?: { repository?: string; paths?: string[]; path?: string }; screens: Screen[]; deviations?: { screen: number; token: string; from: string; to: string; reason: string }[] };
type DesignsResponse = { designs: Design[]; errors?: { name: string; message: string }[] };
type Props = { workspaceId: string; live: boolean; onOpenFile?: (file: string) => void };
const query = (values: Record<string, string>) => new URLSearchParams(values);
const workspaceFile = (id: string, file: string, download = false) => `/api/workspace-file?${query({ id, file, ...(download ? { download: '1' } : {}) })}`;

export default function Designs(props: Props) {
  const [data, setData] = createSignal<DesignsResponse | null>(null);
  const [error, setError] = createSignal('');
  const [view, setView] = createSignal<{ slug: string; step: number; width: number } | null>(null);
  const [refresh, setRefresh] = createSignal(0);
  let request = 0;
  const loadDesigns = (id: string, live: boolean) => {
    const current = ++request; const controller = new AbortController();
    setError('');
    if (!live) { setError('Designs require a live dashboard server.'); return () => {}; }
    void getJson<DesignsResponse>(`/api/workspace-designs?${query({ id })}`, controller.signal)
      .then(result => { if (current === request) { setData(result); setError(''); } })
      .catch(() => { if (current === request && !controller.signal.aborted) setError('Could not load designs. Refresh to retry.'); });
    return () => { controller.abort(); };
  };
  createEffect(on(() => [props.workspaceId, props.live] as const, ([id, live]) => {
    setData(null); setError(''); setView(null);
    const abort = loadDesigns(id, live);
    onCleanup(() => { abort(); request++; });
  }));
  createEffect(on(refresh, version => {
    if (version > 0) untrack(() => loadDesigns(props.workspaceId, props.live));
  }));
  const selected = createMemo(() => {
    const state = view(); return data()?.designs?.find(d => d.slug === state?.slug) ?? null;
  });
  const screen = createMemo(() => {
    const d = selected(); const state = view(); if (!d || !state) return null;
    return d.screens.find(s => s.step === state.step) ?? d.screens[0] ?? null;
  });
  const open = (design: Design) => {
    const first = design.screens.find(s => s.produced) ?? design.screens[0]; if (!first) return;
    setView({ slug: design.slug, step: first.step, width: design.viewport.widths?.[0] ?? 1280 });
  };
  const move = (delta: number) => {
    const d = selected(); const state = view(); if (!d || !state) return;
    const index = d.screens.findIndex(s => s.step === state.step);
    const next = d.screens[index + delta]; if (next) setView({ ...state, step: next.step });
  };
  const designSystemText = (design: Design) => {
    const ref = design.design_system; if (!ref) return '';
    return ref.repository ? `${ref.repository}: ${(ref.paths ?? []).join(', ')}` : ref.path ?? '';
  };
  const captures = createMemo(() => {
    const s = screen(); return Object.entries(s?.captured ?? {}).filter(([, value]) => value).map(([width]) => `${width}px`).join(', ');
  });
  const deviations = createMemo(() => {
    const s = screen(); return (selected()?.deviations ?? []).filter(item => item.screen === s?.step);
  });
  const fileName = createMemo(() => selected() && screen() ? `${selected()!.path}/${screen()!.file}` : '');

  return <section class="section" aria-labelledby="designs-heading">
    <div class="section-head"><h3 id="designs-heading">Designs</h3><span class="small muted">Screen prototypes · read-only</span><button type="button" onClick={() => setRefresh(v => v + 1)}>Refresh designs</button></div>
    <Show when={error()}><p class="warn" role="status">{error()}</p></Show>
    <Show when={!error() && !data()}><p class="small muted">Loading designs…</p></Show>
    <Show when={data()} keyed>{result => <>
      <Show when={(result.designs ?? []).length > 0} fallback={<p class="small muted">No designs recorded. design-plan writes designs/&lt;slug&gt;/design.json; see docs/design-packages.md.</p>}>
        <For each={result.designs}>{design => <div class="info-row">
          <p><button type="button" aria-pressed={view()?.slug === design.slug} onClick={() => open(design)}>{design.title}</button> <span class="pill muted">{design.viewport?.posture ?? 'Viewport unknown'}</span></p>
          <small>{design.summary?.produced ?? 0}/{design.summary?.total ?? design.screens.length} screens produced · {design.summary?.captured ?? 0} captured<Show when={designSystemText(design)}>{` · ${designSystemText(design)}`}</Show></small>
        </div>}</For>
      </Show>
      <For each={result.errors ?? []}>{item => <p class="warn">{item.name}: {item.message}</p>}</For>
    </>}</Show>
    <Show when={selected() && screen() && view()} keyed>
      {design => { const s = screen()!; const d = selected()!; const state = view()!; const idx = d.screens.findIndex(item => item.step === s.step);
        return <section class="section design-viewer" aria-live="polite">
          <h4>{d.title} · {s.title}</h4>
          <p class="small design-controls">
            <button type="button" disabled={idx <= 0} onClick={() => move(-1)}>Previous</button> <span class="mono">step {s.step} of {d.screens.length}</span> <button type="button" disabled={idx < 0 || idx >= d.screens.length - 1} onClick={() => move(1)}>Next</button>
            <For each={d.viewport.widths ?? []}>{width => <button type="button" aria-pressed={width === state.width} onClick={() => setView({ ...state, width })}>{width}px</button>}</For>
            <Show when={s.produced}><a href={workspaceFile(props.workspaceId, fileName(), true)} download="">Download screen</a></Show>
          </p>
          <Show when={s.produced} fallback={<div class="empty"><h3>Screen {s.step} not produced</h3><p class="small">Run design-run to produce <span class="mono">{s.file}</span>.</p></div>}>
            <div style={{ overflow: 'auto', border: '1px solid var(--line)' }}><iframe title={s.title} sandbox="allow-scripts" src={workspaceFile(props.workspaceId, fileName())} style={{ width: `${state.width}px`, 'max-width': '100%', height: '720px', border: 0, display: 'block' }} /></div>
            <p class="small muted">Screen is isolated: no network, no forms. Rendered at {state.width}px.</p>
          </Show>
          <dl class="paths">
            <dt class="small muted">Person</dt><dd style={{ margin: 0 }}>{s.person || 'Not recorded'}</dd>
            <dt class="small muted">Job</dt><dd style={{ margin: 0 }}>{s.job || 'Not recorded'}</dd>
            <dt class="small muted">Kind · state</dt><dd style={{ margin: 0 }}>{s.kind || 'Unknown'} · {s.state || 'Unknown'}</dd>
            <Show when={s.primary_action}><dt class="small muted">Primary action</dt><dd style={{ margin: 0 }}>{s.primary_action}</dd></Show>
            <Show when={s.shell_from}><dt class="small muted">Shell from</dt><dd style={{ margin: 0 }}>step {s.shell_from}</dd></Show>
            <dt class="small muted">Captured</dt><dd style={{ margin: 0 }}>{captures() || <span class="muted">not captured</span>}</dd>
          </dl>
          <Show when={s.notes}><p class="small" style={{ 'margin-top': '8px' }}>{s.notes}</p></Show>
          <Show when={deviations().length}><p class="small muted" style={{ 'margin-top': '8px' }}>Deviations</p><ul class="small"><For each={deviations()}>{item => <li>{item.token}: {item.from} → {item.to}. {item.reason}</li>}</For></ul></Show>
        </section>;
      }}
    </Show>
  </section>;
}
