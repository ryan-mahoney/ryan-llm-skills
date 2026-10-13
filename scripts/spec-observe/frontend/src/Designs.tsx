// Designs destination body: ideal master-detail list, toolbar, scaled frame and
// compact disclosure from app-ui screen 8. The route is the single source of the
// selected design/screen/width (destinations/designs-state.ts), the index read is
// coalesced with one in-flight request, and the viewer mounts once per
// workspace/slug/file identity so index polls and width changes never restart it.
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from 'solid-js';
import { getJson, HttpError } from './api';
import { serverNow, stale, time } from './format';
import { fileViewUrl } from './observation-format';
import { formatHash, navigate, type RouteState } from './route';
import { ActionBar, EmptyState, MasterDetail, RegionalSkeleton, StateNotice, StatusText, type StatusTone } from './primitives';
import { designBriefRoute, selectDesign, type Design, type DesignsResponse } from './destinations/designs-state';
import type { DestinationProps } from './destinations';

const INDEX_READ_DEADLINE_MS = 30000;
const INDEX_POLL_MS = 5000;

const productionStatus = (design: Design): { label: string; tone: StatusTone } => {
  const total = design.summary?.total ?? design.screens.length;
  const produced = design.summary?.produced ?? 0;
  if (total === 0 || produced === 0) return { label: 'Planned', tone: 'neutral' };
  if (produced >= total) return { label: 'Produced', tone: 'success' };
  return { label: 'In progress', tone: 'info' };
};

const modifiedClick = (event: MouseEvent) => event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;

export default function Designs(props: DestinationProps) {
  const [data, setData] = createSignal<DesignsResponse | null>(null);
  const [indexError, setIndexError] = createSignal('');
  const [loadedAt, setLoadedAt] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [probe, setProbe] = createSignal<{ key: string; state: 'checking' | 'ok' | 'failed' } | null>(null);
  const [retryNonce, setRetryNonce] = createSignal(0);

  let indexGeneration = 0;
  let indexController: AbortController | null = null;
  let indexDeadline: ReturnType<typeof setTimeout> | undefined;
  let probeGeneration = 0;
  let probeController: AbortController | null = null;
  let probeDeadline: ReturnType<typeof setTimeout> | undefined;
  let observer: ResizeObserver | undefined;
  let detailHeading: HTMLHeadingElement | undefined;
  let frameWrap: HTMLDivElement | undefined;
  let frame: HTMLIFrameElement | undefined;

  const stopIndex = () => {
    if (indexController) {
      indexController.abort();
      indexController = null;
    }
    if (indexDeadline !== undefined) {
      clearTimeout(indexDeadline);
      indexDeadline = undefined;
    }
  };

  const stopProbe = () => {
    probeGeneration++;
    if (probeController) {
      probeController.abort();
      probeController = null;
    }
    if (probeDeadline !== undefined) {
      clearTimeout(probeDeadline);
      probeDeadline = undefined;
    }
  };

  // One index request in flight; refresh requests during a read coalesce into a
  // single follow-up read for the same scope generation.
  const readIndex = (ws: string, generation: number) => {
    if (!ws || !props.live || busy()) {
      if (busy()) setPending(true);
      return;
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), INDEX_READ_DEADLINE_MS);
    indexController = controller;
    indexDeadline = deadline;
    setBusy(true);
    void getJson<DesignsResponse>(`/api/workspace-designs?${new URLSearchParams({ id: ws }).toString()}`, controller.signal)
      .then(result => {
        if (generation !== indexGeneration || controller.signal.aborted) return;
        setData(result);
        setLoadedAt(new Date(serverNow() ?? Date.now()).toISOString());
        setIndexError('');
      })
      .catch(error => {
        if (generation !== indexGeneration) return;
        setIndexError(error instanceof HttpError && error.message ? error.message : 'Could not load designs. Refresh to retry.');
      })
      .finally(() => {
        clearTimeout(deadline);
        if (indexController !== controller) return;
        indexController = null;
        indexDeadline = undefined;
        setBusy(false);
        if (generation === indexGeneration && pending()) {
          setPending(false);
          readIndex(ws, generation);
        }
      });
  };

  const refreshIndex = () => readIndex(props.route.ws ?? '', indexGeneration);

  // Manual refresh state changes reuse the coalesced index read; the initial
  // value is deferred so mount keeps its single scope read.
  createEffect(on(() => props.refreshKey, () => refreshIndex(), { defer: true }));

  // Scalar scope key: any route navigation recomputes it, but a same-workspace
  // push (id/path/tab/q) yields the same string, so the effect below does not
  // reset data, busy state, probes or the frame for an unchanged scope.
  const scopeKey = createMemo(() => JSON.stringify([props.route.ws ?? '', props.live]));

  // Scope changes and disposal invalidate every read and reset retained data.
  // The key is parsed inside the untracked on callback so the effect uses the
  // exact ws/live pair that triggered it.
  createEffect(on(scopeKey, key => {
    const [ws, live] = JSON.parse(key) as [string, boolean];
    indexGeneration++;
    stopIndex();
    stopProbe();
    setData(null);
    setIndexError('');
    setLoadedAt(null);
    setBusy(false);
    setPending(false);
    setProbe(null);
    setRetryNonce(0);
    if (live && ws) readIndex(ws, indexGeneration);
    const poll = setInterval(() => {
      if (live) readIndex(ws, indexGeneration);
    }, INDEX_POLL_MS);
    onCleanup(() => {
      indexGeneration++;
      stopIndex();
      stopProbe();
      clearInterval(poll);
    });
  }));

  const selection = createMemo(() => selectDesign(props.route, data()?.designs ?? []));
  const designs = () => data()?.designs ?? [];
  const design = () => selection().design;
  const screen = () => selection().screen;
  const query = () => (props.route.q ?? '').trim().toLowerCase();
  const visibleDesigns = () => {
    const needle = query();
    return needle
      ? designs().filter(item => [item.title, item.slug, item.path].some(value => value.toLowerCase().includes(needle)))
      : designs();
  };
  const widths = () => design()?.viewport?.widths ?? [];
  const staleIndex = () => Boolean(data() && loadedAt() !== null && stale(loadedAt()));

  // Invalid route parameters normalize once, without adding history entries.
  createEffect(() => {
    const next = selection().normalized;
    if (next && data()) navigate(next, 'replace');
  });

  const rowRoute = (item: Design): RouteState => ({ dest: 'designs', ws: props.route.ws, q: props.route.q, id: item.slug });
  const stepIndex = () => {
    const item = design();
    const current = screen();
    return item && current ? item.screens.findIndex(entry => entry.step === current.step) : -1;
  };
  const canPrevious = () => stepIndex() > 0;
  const canNext = () => {
    const item = design();
    const index = stepIndex();
    return item !== null && index >= 0 && index < item.screens.length - 1;
  };
  const goPrevious = () => {
    if (canPrevious()) chooseScreen(stepIndex() - 1);
  };
  const goNext = () => {
    if (canNext()) chooseScreen(stepIndex() + 1);
  };
  const chooseScreen = (index: number) => {
    const item = design();
    const next = item?.screens[index];
    const ws = props.route.ws;
    if (!item || !next || !ws) return;
    props.onNavigate({ dest: 'designs', ws, q: props.route.q, id: item.slug, path: next.file, tab: selection().width === null ? undefined : String(selection().width) });
  };
  const chooseWidth = (value: string) => {
    const item = design();
    const current = screen();
    const ws = props.route.ws;
    if (!item || !current || !ws) return;
    props.onNavigate({ dest: 'designs', ws, q: props.route.q, id: item.slug, path: current.file, tab: value });
  };
  const selectRow = (item: Design, event: MouseEvent) => {
    if (modifiedClick(event)) return;
    event.preventDefault();
    props.onNavigate(rowRoute(item));
    requestAnimationFrame(() => detailHeading?.focus());
  };

  const screenPath = createMemo(() => {
    const item = design();
    const current = screen();
    return item && current ? `${item.path}/${current.file}` : '';
  });
  const screenUrl = createMemo(() => {
    const ws = props.route.ws ?? '';
    const path = screenPath();
    return ws && path ? fileViewUrl('workspace', ws, path) : '';
  });
  const viewerKey = createMemo(() => {
    const item = design();
    const current = screen();
    if (!item || !current) return '';
    return `${props.route.ws ?? ''}\u0000${item.slug}\u0000${item.path}/${current.file}\u0000${retryNonce()}`;
  });
  const probeState = () => {
    const current = probe();
    return current && current.key === viewerKey() ? current.state : null;
  };
  const viewerMount = createMemo(() => (probeState() === 'ok' ? viewerKey() : ''));
  const probeIdentity = createMemo(() => {
    const item = design();
    const current = screen();
    return `${props.live ? 'live' : 'imported'}\u0000${props.route.ws ?? ''}\u0000${item?.slug ?? ''}\u0000${screenPath()}\u0000${current?.produced ? 'produced' : 'planned'}\u0000${retryNonce()}`;
  });
  const openScreenTitle = () => {
    const current = screen();
    if (!current) return 'This design package records no screens yet.';
    return current.produced ? 'The recorded screen file could not be read.' : `Screen ${current.step} has not been produced.`;
  };
  const briefRoute = createMemo(() => {
    const item = design();
    return item ? designBriefRoute(props.route.ws ?? '', item) : null;
  });

  // Produced identity HEAD: one read per ws/slug/file/retry identity with its
  // own generation, controller and 30s deadline; width changes never re-probe.
  createEffect(on(probeIdentity, () => {
    stopProbe();
    setProbe(null);
    const url = screenUrl();
    if (!props.live || !screen()?.produced || !url) return;
    const generation = probeGeneration;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), INDEX_READ_DEADLINE_MS);
    probeController = controller;
    probeDeadline = deadline;
    const key = viewerKey();
    setProbe({ key, state: 'checking' });
    void fetch(url, { method: 'HEAD', cache: 'no-store', signal: controller.signal })
      .then(response => {
        if (generation === probeGeneration) setProbe({ key, state: response.ok ? 'ok' : 'failed' });
      })
      .catch(() => {
        if (generation === probeGeneration) setProbe({ key, state: 'failed' });
      })
      .finally(() => {
        clearTimeout(deadline);
        if (probeController === controller) {
          probeController = null;
          probeDeadline = undefined;
        }
      });
  }));

  const fitFrame = () => {
    const wrap = frameWrap;
    const el = frame;
    const declared = selection().width;
    if (!wrap || !el || !declared) return;
    const scale = Math.min(1, wrap.clientWidth / declared);
    el.style.width = `${declared}px`;
    el.style.height = '900px';
    el.style.transformOrigin = 'top left';
    el.style.transform = `scale(${scale})`;
    wrap.style.height = `${900 * scale}px`;
  };

  createEffect(on(viewerMount, () => {
    observer?.disconnect();
    observer = undefined;
    const wrap = frameWrap;
    if (!wrap) return;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => fitFrame());
      observer.observe(wrap);
    }
    fitFrame();
  }));

  createEffect(() => {
    selection().width;
    fitFrame();
  });

  onCleanup(() => {
    observer?.disconnect();
    observer = undefined;
  });

  const captureText = () => {
    const current = screen();
    if (!current) return '';
    return Object.entries(current.captured ?? {})
      .filter(([, captured]) => captured)
      .map(([width]) => `${width}px`)
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
      .join(' and ');
  };
  const deviations = () => {
    const current = screen();
    return (design()?.deviations ?? []).filter(item => item.screen === current?.step);
  };
  const caption = () => {
    if (!props.live) return '';
    if (!data()) return indexError() ? 'Designs unavailable' : 'Reading design packages…';
    const total = designs().length;
    if (total === 0) return 'No design packages recorded';
    const visible = visibleDesigns().length;
    if (query() && visible !== total) return `${visible} of ${total} design packages`;
    return `${total} ${total === 1 ? 'design package' : 'design packages'}`;
  };
  const emptyDetailTitle = () => {
    if (designs().length === 0) return 'No design packages recorded';
    if (selection().unavailable && (props.route.id ?? '') !== '') return 'Design not found';
    return 'Choose a design';
  };
  const emptyDetailText = () => {
    if (designs().length === 0) return 'design-plan writes designs/<slug>/design.json; see docs/design-packages.md.';
    if (selection().unavailable && (props.route.id ?? '') !== '') return 'The selected design package is not in this workspace. Choose another package from the list.';
    return 'Choose a design package to inspect its planned screens, widths and captures.';
  };
  const announcement = createMemo(() => {
    if (!props.live) return 'Designs require a live dashboard server.';
    if (!data()) return indexError() ? 'Designs could not be read.' : 'Reading design packages.';
    if (designs().length === 0) return 'No design packages recorded.';
    const current = selection();
    if (current.unavailable && (props.route.id ?? '') !== '') return 'Design not found.';
    if (!current.design) return 'Choose a design package.';
    if (!current.screen) return `${current.design.title} has no planned screens.`;
    return `Screen ${current.screen.step} of ${current.design.screens.length} · ${current.design.title} · ${current.screen.title}`;
  });

  const openBrief = (route: RouteState) => (event: MouseEvent) => {
    if (modifiedClick(event)) return;
    event.preventDefault();
    props.onNavigate(route);
  };

  return (
    <>
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement()}</span>
      <MasterDetail
        listLabel="Designs"
        list={
          <>
            <div class="list-controls">
              <label class="sr-only" for="find-record">Find designs</label>
              <input
                class="ds-input"
                id="find-record"
                type="search"
                placeholder="Find designs"
                value={props.route.q ?? ''}
                onInput={event => props.onQuery(event.currentTarget.value)}
              />
            </div>
            <div class="list-caption">{caption()}</div>
            <div class="records">
              <Show when={!props.live}>
                <EmptyState title="A live dashboard is required" text="Designs need the local dashboard server. Import a published snapshot to inspect other data." />
              </Show>
              <Show when={props.live}>
                <Show when={!data() && Boolean(indexError())}>
                  <StateNotice
                    announce={false}
                    tone="error"
                    title="Designs could not be read"
                    action={<button type="button" class="ds-btn" onClick={refreshIndex}>Retry</button>}
                  >
                    The host did not return a usable result. Your selection is kept.
                  </StateNotice>
                </Show>
                <Show when={!data() && !indexError()}>
                  <RegionalSkeleton announce={false} rows={4} label="Reading designs" />
                </Show>
                <Show when={Boolean(data()) && Boolean(indexError())}>
                  <StateNotice
                    announce={false}
                    tone="warning"
                    title="Designs could not be refreshed"
                    action={<button type="button" class="ds-btn" onClick={refreshIndex}>Retry</button>}
                  >
                    Showing the last loaded design packages.
                  </StateNotice>
                </Show>
                <Show when={staleIndex() && !indexError()}>
                  <StateNotice
                    announce={false}
                    tone="warning"
                    title={`Last checked at ${time(loadedAt())}`}
                    action={<button type="button" class="ds-btn" onClick={refreshIndex}>Refresh designs</button>}
                  >
                    Existing content is kept while the host revalidates it.
                  </StateNotice>
                </Show>
                <Show when={Boolean(data()) && designs().length === 0}>
                  <EmptyState title="No design packages recorded" text="design-plan writes designs/<slug>/design.json; see docs/design-packages.md." />
                </Show>
                <Show when={Boolean(data()) && designs().length > 0 && visibleDesigns().length === 0}>
                  <EmptyState title="No matching designs" text="Clear the search to restore the design list." />
                </Show>
                <For each={visibleDesigns()}>
                  {item => {
                    const selected = () => design()?.slug === item.slug;
                    const status = () => productionStatus(item);
                    const total = () => item.summary?.total ?? item.screens.length;
                    const produced = () => item.summary?.produced ?? 0;
                    const captured = () => item.summary?.captured ?? 0;
                    return (
                      <a
                        class={selected() ? 'record selected' : 'record'}
                        href={formatHash(rowRoute(item))}
                        aria-current={selected() ? 'page' : undefined}
                        onClick={event => selectRow(item, event)}
                      >
                        <div class="row-heading">
                          <strong>{item.title}</strong>
                          <StatusText tone={status().tone}>{status().label}</StatusText>
                        </div>
                        <p>{item.slug} · {item.viewport?.posture || 'Viewport unknown'}</p>
                        <small>{produced()} of {total()} screens produced{captured() ? ` · ${captured()} captured` : ''}</small>
                      </a>
                    );
                  }}
                </For>
                <For each={data()?.errors ?? []}>{item => <p class="warn">{item.name}: {item.message}</p>}</For>
              </Show>
            </div>
          </>
        }
      >
        <Switch>
          <Match when={!props.live}>
            <div class="detail-body">
              <EmptyState symbol="◇" title="A live dashboard is required" text="Designs need the local dashboard server. Import a published snapshot to inspect other data." />
            </div>
          </Match>
          <Match when={!data()}>
            <Show when={indexError()} fallback={<div class="detail-body"><RegionalSkeleton announce={false} rows={4} label="Reading designs" /></div>}>
              <div class="detail-body">
                <EmptyState
                  symbol="◇"
                  title="Designs could not be read"
                  text={indexError()}
                  action={<button type="button" class="ds-btn ds-btn--primary" onClick={refreshIndex}>Retry</button>}
                />
              </div>
            </Show>
          </Match>
          <Match when={!design()}>
            <div class="detail-body">
              <EmptyState symbol="◇" title={emptyDetailTitle()} text={emptyDetailText()} />
            </div>
          </Match>
          <Match when={design()}>
            <>
              <div class="object-head">
                <div class="object-top">
                  <h2 id="design-detail-heading" tabIndex={-1} ref={el => (detailHeading = el)}>{design()!.title}</h2>
                  <StatusText tone="neutral">{design()!.viewport?.posture || 'Viewport unknown'}</StatusText>
                </div>
                <Show when={screen()}>
                  <p>Screen {screen()!.step} · {screen()!.title}</p>
                </Show>
              </div>
              <div class="design-toolbar">
                <ActionBar variant="inline">
                  <button
                    type="button"
                    class="ds-btn"
                    aria-disabled={canPrevious() ? 'false' : 'true'}
                    onClick={goPrevious}
                  >
                    Previous screen
                  </button>
                  <Show when={screen()} fallback={<StatusText tone="neutral">No screens</StatusText>}>
                    <StatusText tone="neutral">{screen()!.step} of {design()!.screens.length}</StatusText>
                  </Show>
                  <button
                    type="button"
                    class="ds-btn"
                    aria-disabled={canNext() ? 'false' : 'true'}
                    onClick={goNext}
                  >
                    Next screen
                  </button>
                </ActionBar>
                <div style={{ display: 'flex', gap: '12px', 'align-items': 'center' }}>
                  <label class="muted" for="design-width">Width</label>
                  <select
                    id="design-width"
                    class="ds-input"
                    style={{ width: '120px' }}
                    value={selection().width === null ? '' : String(selection().width)}
                    disabled={widths().length === 0}
                    onChange={event => chooseWidth(event.currentTarget.value)}
                  >
                    <For each={widths()}>{width => <option value={String(width)}>{width}px</option>}</For>
                  </select>
                  <Show
                    when={screen()?.produced && Boolean(screenUrl()) && probeState() !== 'failed'}
                    fallback={<button type="button" class="ds-btn" disabled title={openScreenTitle()}>Open screen</button>}
                  >
                    <a class="ds-btn ds-btn--primary" href={screenUrl()} target="_blank" rel="noopener">Open screen</a>
                  </Show>
                </div>
              </div>
              <div class="design-canvas">
                <Show when={screen()} fallback={<EmptyState symbol="◇" title="No screens planned" text="This design package records no screens yet." />}>
                  <Show
                    when={viewerMount()}
                    keyed
                    fallback={
                      <Switch>
                        <Match when={!screen()!.produced}>
                          <EmptyState
                            symbol="◇"
                            title={`Screen ${screen()!.step} has not been produced`}
                            text={`${[screen()!.title, screen()!.job].filter(Boolean).join(' · ')}. The planned screen is recorded; its HTML file does not exist yet.`}
                            action={
                              <Show when={briefRoute()}>
                                {route => <a class="ds-btn ds-btn--primary" href={formatHash(route())} onClick={openBrief(route())}>Open brief</a>}
                              </Show>
                            }
                          />
                        </Match>
                        <Match when={probeState() === 'failed'}>
                          <EmptyState
                            symbol="◇"
                            title={`Screen ${screen()!.step} could not be read`}
                            text="The recorded screen file did not respond. Retry the check or open the brief."
                            action={
                              <>
                                <button type="button" class="ds-btn ds-btn--primary" onClick={() => setRetryNonce(value => value + 1)}>Retry check</button>
                                <Show when={briefRoute()}>
                                  {route => <a class="ds-btn" href={formatHash(route())} onClick={openBrief(route())}>Open brief</a>}
                                </Show>
                              </>
                            }
                          />
                        </Match>
                        <Match when={true}>
                          <RegionalSkeleton announce={false} rows={3} label="Checking screen" />
                        </Match>
                      </Switch>
                    }
                  >
                    {key => (
                      <div
                        id="design-frame-wrap"
                        data-viewer-identity={key}
                        ref={el => (frameWrap = el)}
                        style={{ position: 'relative', width: '100%', overflow: 'hidden', border: '1px solid var(--ds-line-2)' }}
                      >
                        <iframe
                          id="design-frame"
                          ref={el => (frame = el)}
                          title={screen()!.title}
                          sandbox="allow-scripts"
                          src={screenUrl()}
                          style={{ border: '0', width: `${selection().width ?? 1280}px`, height: '900px', 'transform-origin': 'top left' }}
                        />
                      </div>
                    )}
                  </Show>
                  <details style={{ 'margin-top': '20px' }}>
                    <summary>{screen()!.produced ? 'Screen details and deviations' : 'Planned screen details'}</summary>
                    <p>
                      {screen()!.person || 'Person not recorded'} · {screen()!.job || 'Job not recorded'}<br />
                      Primary action: {screen()!.primary_action || 'Not recorded'}<br />
                      Capture: {captureText() || 'Not captured'}
                      <Show when={screen()!.notes}><br />Note: {screen()!.notes}</Show>
                    </p>
                    <Show when={deviations().length}>
                      <p>
                        <strong>Deviations</strong><br />
                        {deviations().map(item => `${item.token}: ${item.from} → ${item.to}. ${item.reason}`).join(' ')}
                      </p>
                    </Show>
                  </details>
                </Show>
              </div>
              <footer class="detail-foot">Produced and captured status comes from files · Screen content is read only</footer>
            </>
          </Match>
        </Switch>
      </MasterDetail>
    </>
  );
}
