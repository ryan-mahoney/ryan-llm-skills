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
import { designBriefRoute, selectDesign, type Design, type DesignsResponse, type Screen } from './destinations/designs-state';
import { catalogRead } from './destinations/workspace-state';
import { resolveCatalogEntry } from './scope';
import type { DestinationProps } from './destinations';

const INDEX_READ_DEADLINE_MS = 30000;
const INDEX_POLL_MS = 5000;
const LOADING_DELAY_MS = 300;

const productionStatus = (design: Design): { label: string; tone: StatusTone } => {
  const total = design.summary?.total ?? design.screens.length;
  const produced = design.summary?.produced ?? 0;
  if (total === 0 || produced === 0) return { label: 'Planned', tone: 'neutral' };
  if (produced >= total) return { label: 'Produced', tone: 'success' };
  return { label: 'In progress', tone: 'info' };
};

const modifiedClick = (event: MouseEvent) => event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;

// Footprint-only placeholder rows used before the regional 300ms delay elapses;
// they reserve the filled RegionalSkeleton row geometry without rendering bars.
const SkeletonReserve = (props: { rows: number }) => (
  <div class="skeletons" aria-hidden="true">
    <For each={Array.from({ length: props.rows })}>
      {() => <div class="skeleton" style={{ 'min-height': '100px' }} />}
    </For>
  </div>
);

export default function Designs(props: DestinationProps) {
  const [indexResult, setIndexResult] = createSignal<{ scope: string; body: DesignsResponse } | null>(null);
  const [indexError, setIndexError] = createSignal('');
  const [loadedAt, setLoadedAt] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [probe, setProbe] = createSignal<{ key: string; state: 'checking' | 'ok' | 'failed' } | null>(null);
  const [retryNonce, setRetryNonce] = createSignal(0);
  const [probeRetry, setProbeRetry] = createSignal(0);
  const [initialDelayed, setInitialDelayed] = createSignal(false);
  const [headDelayed, setHeadDelayed] = createSignal(false);

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
  let explicitProbe = false;

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
    const requestScope = JSON.stringify([ws, true]);
    void getJson<DesignsResponse>(`/api/workspace-designs?${new URLSearchParams({ id: ws }).toString()}`, controller.signal)
      .then(result => {
        if (generation !== indexGeneration || controller.signal.aborted) return;
        setIndexResult({ scope: requestScope, body: result });
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

  // Scope-tagged index data: retained results are consumed only while their
  // originating scope still matches the current scalar key.
  const data = createMemo(() => {
    const stored = indexResult();
    return stored && stored.scope === scopeKey() ? stored.body : null;
  });

  // Scope changes and disposal invalidate every read and reset retained data.
  // The key is parsed inside the untracked on callback so the effect uses the
  // exact ws/live pair that triggered it.
  createEffect(on(scopeKey, key => {
    const [ws, live] = JSON.parse(key) as [string, boolean];
    indexGeneration++;
    stopIndex();
    stopProbe();
    setIndexResult(null);
    setIndexError('');
    setLoadedAt(null);
    setBusy(false);
    setPending(false);
    setProbe(null);
    setRetryNonce(0);
    setProbeRetry(0);
    explicitProbe = false;
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
  const indexDiagnostics = () => data()?.errors ?? [];
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
  const successfulEmpty = () => Boolean(data()) && designs().length === 0 && (data()!.errors?.length ?? 0) === 0;
  const allInvalid = () => Boolean(data()) && designs().length === 0 && (data()!.errors?.length ?? 0) > 0;
  const unavailableSelection = () => selection().unavailable && (props.route.id ?? '') !== '';
  const filesRoute = (): RouteState => ({ dest: 'files', ws: props.route.ws, source: 'workspace' });

  // Complete catalog read semantics: a workspace is only declared removed after a
  // successful whole-catalog read omits it; degraded reads and invalid entries
  // never remove, and missing_projects remains a valid complete read.
  const catalogDegraded = () => {
    const read = catalogRead({
      valid: props.catalog,
      invalid: props.catalogInvalid,
      storage: props.catalogStorage,
      errors: props.catalogError ? [{ message: props.catalogError }] : [],
    } as any, null);
    return read.degraded || props.storageDiagnostics.length > 0;
  };
  const invalidCatalogEntry = () => (props.catalogInvalid ?? []).some(entry => String((entry as any)?.id ?? '') === String(props.route.ws ?? ''));
  const removedWorkspace = () => props.live && (props.route.ws ?? '') !== '' && props.catalogLoaded
    && !catalogDegraded() && !invalidCatalogEntry() && !resolveCatalogEntry(props.catalog, props.route.ws ?? '');
  const explicitSlugErrors = () => {
    const id = props.route.id ?? '';
    return id ? indexDiagnostics().filter(item => item.name === `designs/${id}/design.json`) : [];
  };
  // An explicit slug is unavailable only after a successful current-scope read
  // omits it or names its index in errors; a generic HTTP failure stays an error.
  const explicitUnavailable = () => {
    const id = props.route.id ?? '';
    if (!id || removedWorkspace() || !data()) return false;
    if (explicitSlugErrors().length > 0) return true;
    return !designs().some(item => item.slug === id);
  };
  const blockedSelection = () => removedWorkspace() || explicitUnavailable();

  // Last successful selected metadata, cached for the exact ws/slug only and used
  // for the unavailable explanation, header and disclosure; never to grant access.
  const [lastKnown, setLastKnown] = createSignal<{ ws: string; slug: string; design: Design; screen: Screen | null; width: number | null } | null>(null);
  createEffect(() => {
    const item = design();
    const ws = props.route.ws ?? '';
    if (!item || !ws) return;
    setLastKnown({ ws, slug: item.slug, design: item, screen: screen(), width: selection().width });
  });
  const cachedSelection = () => {
    const cached = lastKnown();
    if (!cached) return null;
    return cached.ws === (props.route.ws ?? '') && cached.slug === (props.route.id ?? '') ? cached : null;
  };
  const unavailableTitle = () => cachedSelection()?.design.title ?? 'Design screen';
  const unavailableSubtitle = () => {
    const cached = cachedSelection();
    return cached?.screen ? `Screen ${cached.screen.step} · ${cached.screen.title}` : 'Screen unavailable';
  };
  const unavailablePosture = () => cachedSelection()?.design.viewport?.posture || 'Viewport unknown';
  const unavailableBoundary = 'The workspace or selected file is no longer available through the current reader boundary.';
  const unavailableText = () => {
    const cached = cachedSelection();
    const identity = cached
      ? `${cached.design.title}${cached.screen ? ` · Screen ${cached.screen.step} ${cached.screen.file}` : ''}`
      : (props.route.id ?? '');
    return identity ? `${unavailableBoundary} Last known selection: ${identity}.` : unavailableBoundary;
  };
  const unavailableWidths = () => cachedSelection()?.design.viewport?.widths ?? [];
  const unavailableScreenCount = () => cachedSelection()?.design.screens.length ?? 0;
  const unavailableCaptureText = () => {
    const cached = cachedSelection();
    if (!cached?.screen) return '';
    return widthList((cached.design.viewport?.widths ?? []).filter(width => cached.screen!.captured?.[String(width)] === true));
  };
  const chooseDesign = () => {
    if (removedWorkspace()) {
      props.onNavigate({ dest: 'designs' });
      return;
    }
    props.onNavigate({ dest: 'designs', ws: props.route.ws, q: props.route.q });
    requestAnimationFrame(() => {
      const input = document.getElementById('find-record') as HTMLInputElement | null;
      input?.focus();
    });
  };

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
    if (!item || !current || blockedSelection()) return '';
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
    return `${props.live ? 'live' : 'imported'}\u0000${props.route.ws ?? ''}\u0000${item?.slug ?? ''}\u0000${screenPath()}\u0000${current?.produced ? 'produced' : 'planned'}\u0000${blockedSelection() ? 'blocked' : 'open'}\u0000${probeRetry()}`;
  });
  const openScreenTitle = () => {
    const current = screen();
    if (!current) return 'This design package records no screens yet.';
    if (!current.produced) return `Screen ${current.step} has not been produced.`;
    if (probeState() === 'failed') return 'The recorded screen file could not be read.';
    if (probeState() !== 'ok') return 'Checking that the recorded screen file is available…';
    return 'The recorded screen file could not be read.';
  };
  const briefRoute = createMemo(() => {
    const item = design();
    return item ? designBriefRoute(props.route.ws ?? '', item) : null;
  });

  // Explicit screen retry: re-probe without touching the frame identity; only a
  // confirmed successful retry advances the frame nonce so the iframe reloads once.
  const retryScreen = () => {
    explicitProbe = true;
    setProbeRetry(value => value + 1);
  };

  // Scalar pending-scope key: route-only changes (id/path/tab/q) keep the same
  // string, so a pending index keeps its single 300ms delay instead of restarting.
  const pendingScopeKey = createMemo(() => (
    props.live && busy() && !data() && !indexError() ? scopeKey() : ''
  ));

  // Initial catalog read: reserve the screen-77 footprints immediately and
  // reveal skeleton bars only after 300ms, so a fast response never flashes.
  createEffect(on(pendingScopeKey, key => {
    setInitialDelayed(false);
    if (!key) return;
    const timer = setTimeout(() => setInitialDelayed(true), LOADING_DELAY_MS);
    onCleanup(() => clearTimeout(timer));
  }));

  // Produced-screen HEAD: reveal the checking footprint only when the current
  // viewer identity is still checking after the same delay.
  createEffect(on(
    () => [props.live, viewerKey(), probeState()] as const,
    () => {
      setHeadDelayed(false);
      if (!props.live || probeState() !== 'checking') return;
      const timer = setTimeout(() => {
        if (props.live && probeState() === 'checking') setHeadDelayed(true);
      }, LOADING_DELAY_MS);
      onCleanup(() => clearTimeout(timer));
    },
  ));

  // Produced identity HEAD: one read per ws/slug/file/retry identity with its
  // own generation, controller and 30s deadline; width changes never re-probe.
  createEffect(on(probeIdentity, () => {
    const explicit = explicitProbe;
    explicitProbe = false;
    stopProbe();
    setProbe(null);
    const url = screenUrl();
    if (!props.live || !screen()?.produced || !url || blockedSelection()) return;
    const generation = probeGeneration;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), INDEX_READ_DEADLINE_MS);
    probeController = controller;
    probeDeadline = deadline;
    const key = viewerKey();
    setProbe({ key, state: 'checking' });
    void fetch(url, { method: 'HEAD', cache: 'no-store', signal: controller.signal })
      .then(response => {
        if (generation !== probeGeneration) return;
        if (response.ok && explicit) setRetryNonce(value => value + 1);
        setProbe({ key: viewerKey(), state: response.ok ? 'ok' : 'failed' });
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

  const widthList = (widths: number[]) => {
    const ordered = [...widths].sort((a, b) => a - b).map(width => `${width}px`);
    if (ordered.length === 0) return '';
    if (ordered.length === 1) return ordered[0];
    return `${ordered.slice(0, -1).join(', ')} and ${ordered[ordered.length - 1]}`;
  };
  const capturedWidths = () => {
    const current = screen();
    return (design()?.viewport?.widths ?? []).filter(width => current?.captured?.[String(width)] === true);
  };
  const missingWidths = () => {
    const current = screen();
    if (!current?.produced) return [];
    return (design()?.viewport?.widths ?? []).filter(width => current.captured?.[String(width)] !== true);
  };
  const captureText = () => widthList(capturedWidths());
  const missingText = () => widthList(missingWidths());
  const captureGap = () => Boolean(screen()?.produced) && missingWidths().length > 0;
  const partialEvidence = () => Boolean(design()) && (captureGap() || indexDiagnostics().length > 0);
  const showCaptureCallout = () => Boolean(design()) && Boolean(screen()?.produced) && partialEvidence()
    && !indexError() && !staleIndex() && probeState() !== 'failed';
  const unreadableIndexText = () => {
    const count = indexDiagnostics().length;
    return `${count} design ${count === 1 ? 'index' : 'indexes'} could not be read.`;
  };
  const captureEvidenceText = () => {
    const current = screen();
    if (!current) return '';
    const captured = capturedWidths();
    const missing = missingWidths();
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(captured.length === 0
        ? `Screen ${current.step} has no captures recorded.`
        : captured.length === 1
          ? `Screen ${current.step} has a ${widthList(captured)} capture.`
          : `Screen ${current.step} has ${widthList(captured)} captures.`);
      parts.push(missing.length === 1 ? `Its ${widthList(missing)} capture is missing.` : `Its ${widthList(missing)} captures are missing.`);
    } else {
      parts.push('Capture coverage is complete for this screen.');
    }
    if (indexDiagnostics().length > 0) parts.push(unreadableIndexText());
    return parts.join(' ');
  };
  const deviations = () => {
    const current = screen();
    return (design()?.deviations ?? []).filter(item => item.screen === current?.step);
  };
  const countText = () => {
    const total = designs().length;
    if (total === 0) return successfulEmpty() ? 'No designs recorded' : allInvalid() ? 'Design indexes could not be read' : '';
    const visible = visibleDesigns().length;
    return query() && visible !== total ? `${visible} of ${total} design packages` : `${total} ${total === 1 ? 'design package' : 'design packages'}`;
  };
  const caption = () => {
    if (!props.live) return '';
    if (!data()) return indexError() ? 'Designs unavailable' : 'Reading designs…';
    const text = countText();
    if (!indexError()) return text;
    const retained = text === 'No designs recorded' ? 'no designs recorded' : text === 'Design indexes could not be read' ? 'no readable design packages' : text || 'no readable design packages';
    return `Last known catalog: ${retained}`;
  };
  const emptyDetailTitle = () => {
    if (unavailableSelection()) return 'Design not found';
    if (allInvalid()) return 'Design indexes could not be read';
    return 'Choose a design';
  };
  const emptyDetailText = () => {
    if (unavailableSelection()) return 'The selected design package is not in this workspace. Choose another package from the list.';
    if (allInvalid()) {
      const count = indexDiagnostics().length;
      return `${count} design ${count === 1 ? 'index' : 'indexes'} could not be read. Fix them in the workspace, then refresh.`;
    }
    return 'Choose a design package to inspect its planned screens, widths and captures.';
  };
  const announcement = createMemo(() => {
    if (!props.live) return 'Designs require a live dashboard server.';
    if (removedWorkspace() || explicitUnavailable()) return 'Design screen unavailable. Choose a design.';
    if (!data()) {
      if (indexError()) return 'Designs could not be read.';
      return initialDelayed() ? 'Reading designs.' : '';
    }
    const current = selection();
    if (current.unavailable && (props.route.id ?? '') !== '') return 'Design not found.';
    const failures = [indexError() ? 'Designs could not be read.' : '', probeState() === 'failed' ? 'Screen could not be read.' : ''].filter(Boolean).join(' ');
    if (failures) return failures;
    if (allInvalid()) return unreadableIndexText();
    if (successfulEmpty()) return 'No designs recorded.';
    if (designs().length > 0 && visibleDesigns().length === 0) return 'No designs match. Clear search to restore the design list.';
    if (!current.design) return 'Choose a design package.';
    if (!current.screen) return `${current.design.title} has no planned screens.`;
    if (headDelayed() && current.screen.produced && probeState() === 'checking') return 'Checking screen.';
    const base = `Screen ${current.screen.step} of ${current.design.screens.length} · ${current.design.title} · ${current.screen.title}`;
    const evidence = [captureGap() ? `Missing captures: ${widthList(missingWidths())}.` : '', indexDiagnostics().length > 0 ? unreadableIndexText() : ''].filter(Boolean).join(' ');
    return evidence ? `${base} ${evidence}` : base;
  });

  // Shared route link handler: modified clicks keep the native anchor, ordinary
  // clicks push the explicit route through the App navigation owner.
  const routeClick = (route: RouteState) => (event: MouseEvent) => {
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
                  <div class="designs-index-error">
                    <StateNotice
                      announce={false}
                      tone="error"
                      title="Designs could not be read"
                      action={<button type="button" class="ds-btn" onClick={refreshIndex}>Refresh designs</button>}
                    >
                      The host did not return a usable result. Your selection is kept.
                    </StateNotice>
                  </div>
                </Show>
                <Show when={!data() && !indexError()}>
                  <div role="region" aria-busy="true" aria-label="Reading designs">
                    <Show when={initialDelayed()} fallback={<SkeletonReserve rows={4} />}>
                      <RegionalSkeleton announce={false} rows={4} label="Reading designs" />
                    </Show>
                  </div>
                </Show>
                <Show when={Boolean(data()) && Boolean(indexError())}>
                  <div class="designs-index-error">
                    <StateNotice
                      announce={false}
                      tone="error"
                      title="Designs could not be read"
                      action={<button type="button" class="ds-btn" onClick={refreshIndex}>Refresh designs</button>}
                    >
                      The host did not return a usable result. Your selection is kept.
                    </StateNotice>
                  </div>
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
                <Show when={successfulEmpty() && !indexError()}>
                  <EmptyState
                    symbol="◇"
                    title="No designs recorded"
                    text="Create a design plan in this workspace to begin."
                    action={
                      <>
                        <a class="ds-btn" href={formatHash(filesRoute())} onClick={routeClick(filesRoute())}>Open files</a>
                        <button type="button" class="ds-btn" onClick={refreshIndex}>Refresh designs</button>
                      </>
                    }
                  />
                </Show>
                <Show when={Boolean(data()) && designs().length > 0 && visibleDesigns().length === 0}>
                  <EmptyState
                    symbol="◇"
                    title="No designs match"
                    text="Clear the search to restore the design list."
                    action={<button type="button" class="ds-btn" onClick={() => props.onQuery('')}>Clear search</button>}
                  />
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
          <Match when={removedWorkspace() || explicitUnavailable()}>
            <>
              <div class="object-head">
                <div class="object-top">
                  <h2 id="design-detail-heading" tabIndex={-1}>{unavailableTitle()}</h2>
                  <StatusText tone="neutral">{unavailablePosture()}</StatusText>
                </div>
                <p>{unavailableSubtitle()}</p>
              </div>
              <div class="design-toolbar">
                <ActionBar variant="inline">
                  <button type="button" class="ds-btn" disabled>Previous screen</button>
                  <StatusText tone="neutral">{cachedSelection()?.screen ? `${cachedSelection()!.screen!.step} of ${unavailableScreenCount()}` : 'No screens'}</StatusText>
                  <button type="button" class="ds-btn" disabled>Next screen</button>
                </ActionBar>
                <div style={{ display: 'flex', gap: '12px', 'align-items': 'center' }}>
                  <label class="muted" for="design-width">Width</label>
                  <select
                    id="design-width"
                    class="ds-input"
                    style={{ width: '120px' }}
                    disabled
                    value={cachedSelection()?.width === null || cachedSelection()?.width === undefined ? '' : String(cachedSelection()!.width)}
                  >
                    <For each={unavailableWidths()}>{width => <option value={String(width)}>{width}px</option>}</For>
                  </select>
                  <button type="button" class="ds-btn" disabled title={unavailableBoundary}>Open screen</button>
                </div>
              </div>
              <div class="design-canvas">
                <EmptyState
                  symbol="◇"
                  title="Design screen unavailable"
                  text={unavailableText()}
                  action={<button type="button" class="ds-btn ds-btn--primary" onClick={chooseDesign}>Choose design</button>}
                />
                <Show when={cachedSelection()?.screen}>
                  <details style={{ 'margin-top': '20px' }}>
                    <summary>Screen details and deviations</summary>
                    <p>
                      {cachedSelection()!.screen!.person || 'Person not recorded'} · {cachedSelection()!.screen!.job || 'Job not recorded'}<br />
                      Primary action: {cachedSelection()!.screen!.primary_action || 'Not recorded'}<br />
                      Capture: {unavailableCaptureText() || 'none'}
                      <Show when={cachedSelection()!.screen!.notes}><br />Note: {cachedSelection()!.screen!.notes}</Show>
                    </p>
                  </details>
                </Show>
              </div>
              <footer class="detail-foot">Produced and captured status comes from files · Screen content is read only</footer>
            </>
          </Match>
          <Match when={!data()}>
            <Show
              when={indexError()}
              fallback={
                <>
                  <div class="object-head">
                    <div class="object-top">
                      <h2 id="design-detail-heading" tabIndex={-1}>Design screen</h2>
                    </div>
                    <p />
                  </div>
                  <div class="design-canvas">
                    <div role="region" aria-busy="true" aria-label="Reading design index and screen">
                      <div class="skeleton" style={{ padding: '0 0 20px', border: '0', 'min-height': '64px' }}>
                        <Show when={initialDelayed()}><span style={{ width: '38%', height: '44px' }} /></Show>
                      </div>
                      <div style={{ height: '480px', background: 'var(--ds-panel)', border: '1px solid var(--ds-line-2)', display: 'grid', 'grid-template-columns': '18% 27% 1fr', gap: '16px', padding: '20px' }}>
                        <Show when={initialDelayed()} fallback={<SkeletonReserve rows={4} />}>
                          <RegionalSkeleton announce={false} rows={4} label="Reading designs" />
                        </Show>
                        <Show when={initialDelayed()} fallback={<SkeletonReserve rows={3} />}>
                          <RegionalSkeleton announce={false} rows={3} label="Reading designs" />
                        </Show>
                        <Show when={initialDelayed()} fallback={<SkeletonReserve rows={4} />}>
                          <RegionalSkeleton announce={false} rows={4} label="Reading designs" />
                        </Show>
                      </div>
                    </div>
                  </div>
                  <footer class="detail-foot">Produced and captured status comes from files · Screen content is read only</footer>
                </>
              }
            >
              <>
                <div class="object-head">
                  <div class="object-top">
                    <h2 id="design-detail-heading" tabIndex={-1}>Design screen</h2>
                  </div>
                  <p />
                </div>
                <div class="design-canvas">
                  <EmptyState
                    symbol="◇"
                    title="Designs could not be read"
                    text="The host did not return a usable result. Refresh the design catalog to try again."
                    action={<button type="button" class="ds-btn ds-btn--primary" onClick={refreshIndex}>Refresh designs</button>}
                  />
                </div>
                <footer class="detail-foot">Produced and captured status comes from files · Screen content is read only</footer>
              </>
            </Show>
          </Match>
          <Match when={!design()}>
            <Switch>
              <Match when={unavailableSelection()}>
                <div class="detail-body">
                  <EmptyState symbol="◇" title={emptyDetailTitle()} text={emptyDetailText()} />
                </div>
              </Match>
              <Match when={allInvalid()}>
                <div class="detail-body">
                  <EmptyState
                    symbol="◇"
                    title="Design indexes could not be read"
                    text={emptyDetailText()}
                    action={
                      <>
                        <button type="button" class="ds-btn ds-btn--primary" onClick={refreshIndex}>Refresh designs</button>
                        <a class="ds-btn" href={formatHash(filesRoute())} onClick={routeClick(filesRoute())}>Open files</a>
                      </>
                    }
                  />
                  <ul class="small">
                    <For each={indexDiagnostics()}>{item => <li>{item.name}: {item.message}</li>}</For>
                  </ul>
                </div>
              </Match>
              <Match when={Boolean(indexError())}>
                <>
                  <div class="object-head">
                    <div class="object-top">
                      <h2 id="design-detail-heading" tabIndex={-1}>Design screen</h2>
                    </div>
                    <p />
                  </div>
                  <div class="design-canvas">
                    <EmptyState
                      symbol="◇"
                      title="Designs could not be read"
                      text="The host did not return a usable result. Refresh the design catalog to try again."
                      action={<button type="button" class="ds-btn ds-btn--primary" onClick={refreshIndex}>Refresh designs</button>}
                    />
                  </div>
                  <footer class="detail-foot">Produced and captured status comes from files · Screen content is read only</footer>
                </>
              </Match>
              <Match when={successfulEmpty() && !indexError()}>
                <>
                  <div class="object-head">
                    <div class="object-top">
                      <h2 id="design-detail-heading" tabIndex={-1}>Design screen</h2>
                    </div>
                    <p />
                  </div>
                  <div class="design-canvas">
                    <EmptyState
                      symbol="◇"
                      title="No design selected"
                      text="Open Files to read the planning material for this workspace."
                      action={<a class="ds-btn ds-btn--primary" href={formatHash(filesRoute())} onClick={routeClick(filesRoute())}>Open files</a>}
                    />
                  </div>
                  <footer class="detail-foot">Produced and captured status comes from files · Screen content is read only</footer>
                </>
              </Match>
              <Match when={true}>
                <div class="detail-body">
                  <EmptyState symbol="◇" title={emptyDetailTitle()} text={emptyDetailText()} />
                </div>
              </Match>
            </Switch>
          </Match>
          <Match when={design()}>
            <>
              <div class="object-head">
                <div class="object-top">
                  <h2 id="design-detail-heading" tabIndex={-1} ref={el => (detailHeading = el)}>{design()!.title}</h2>
                  <Show
                    when={indexError() || probeState() === 'failed'}
                    fallback={<StatusText tone="neutral">{design()!.viewport?.posture || 'Viewport unknown'}</StatusText>}
                  >
                    <StatusText tone="neutral">Not confirmed</StatusText>
                  </Show>
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
                    when={screen()?.produced && Boolean(screenUrl()) && probeState() === 'ok'}
                    fallback={<button type="button" class="ds-btn" disabled title={openScreenTitle()}>Open screen</button>}
                  >
                    <a class={showCaptureCallout() ? 'ds-btn' : 'ds-btn ds-btn--primary'} href={screenUrl()} target="_blank" rel="noopener">Open screen</a>
                  </Show>
                </div>
              </div>
              <div class="design-canvas">
                <Show when={screen()} fallback={<EmptyState symbol="◇" title="No screens planned" text="This design package records no screens yet." />}>
                  <Show when={showCaptureCallout()}>
                    <StateNotice
                      announce={false}
                      tone="warning"
                      title="Capture evidence incomplete"
                      action={
                        <Show
                          when={briefRoute()}
                          fallback={<p class="small muted">No safe relative brief is recorded, so there is no brief link to open.</p>}
                        >
                          {route => <a class="ds-btn ds-btn--primary" href={formatHash(route())} onClick={routeClick(route())}>Open brief</a>}
                        </Show>
                      }
                    >
                      {captureEvidenceText()}
                    </StateNotice>
                  </Show>
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
                              <Show
                                when={briefRoute()}
                                fallback={<p class="small muted">No safe relative brief is recorded, so there is no brief link to open.</p>}
                              >
                                {route => <a class="ds-btn ds-btn--primary" href={formatHash(route())} onClick={routeClick(route())}>Open brief</a>}
                              </Show>
                            }
                          />
                        </Match>
                        <Match when={probeState() === 'failed'}>
                          <EmptyState
                            symbol="◇"
                            title="Screen could not be read"
                            text="The design index and selected step are kept. Retry the screen file."
                            action={<button type="button" class="ds-btn ds-btn--primary" onClick={retryScreen}>Retry screen</button>}
                          />
                        </Match>
                        <Match when={true}>
                          <div
                            aria-busy="true"
                            aria-label="Checking screen"
                            role="region"
                            style={{ height: '480px', background: 'var(--ds-panel)', border: '1px solid var(--ds-line-2)', display: 'grid', 'grid-template-columns': '18% 27% 1fr', gap: '16px', padding: '20px' }}
                          >
                            <Show when={headDelayed()} fallback={<SkeletonReserve rows={4} />}>
                              <RegionalSkeleton announce={false} rows={4} label="Checking screen" />
                            </Show>
                            <Show when={headDelayed()} fallback={<SkeletonReserve rows={3} />}>
                              <RegionalSkeleton announce={false} rows={3} label="Checking screen" />
                            </Show>
                            <Show when={headDelayed()} fallback={<SkeletonReserve rows={4} />}>
                              <RegionalSkeleton announce={false} rows={4} label="Checking screen" />
                            </Show>
                          </div>
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
                      <Show when={screen()!.produced} fallback={<>Produced: No · Captured: {captureText() || 'No'}</>}>
                        Capture: {captureText() || 'none'} · Missing: {missingText() || 'none'}
                      </Show>
                      <Show when={screen()!.notes}><br />Note: {screen()!.notes}</Show>
                    </p>
                    <Show when={indexDiagnostics().length}>
                      <p>
                        <strong>Unreadable design indexes</strong>
                      </p>
                      <ul class="small">
                        <For each={indexDiagnostics()}>{item => <li>{item.name}: {item.message}</li>}</For>
                      </ul>
                    </Show>
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
