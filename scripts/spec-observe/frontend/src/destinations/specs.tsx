import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { activeRun, attention, base, esc, inlineMarkdown, runningUnconfirmed, serverNow, str, time } from '../format';
import { completionLabel, duration as observationDuration, runState, specProgress } from '../observation-format';
import { linkedAssignmentKey, observationEnd, packageFromKey, packageRelative, specViewState, visibleSpecs, type ObservationContext } from '../spec-state';
import SpecActivity, { hasActivityFacts } from '../SpecActivity';
import { ActionBar, EmptyState, MasterDetail, RegionalSkeleton, SectionTabs, StateNotice, StatusText, type SectionTab, type StatusTone } from '../primitives';
import PlannedAssignment from '../PlannedAssignment';
import SpecOverview from '../SpecOverview';
import type { WireRecord } from '../model';
import type { RouteState } from '../route';
import type { DestinationProps } from './index';

type Filter = 'active' | 'attention' | 'completed' | 'planned';

const FILTERS: SectionTab[] = [
  { key: 'active', label: 'Active' },
  { key: 'attention', label: 'Blocked' },
  { key: 'completed', label: 'Done' },
  { key: 'planned', label: 'Planned' },
];

const FILTER_LABELS: Record<Filter, string> = { active: 'Active', attention: 'Blocked', completed: 'Done', planned: 'Planned' };

const filterOf = (route: RouteState): Filter => {
  const value = route.filter;
  return value === 'attention' || value === 'completed' || value === 'planned' ? value : 'active';
};

function SpecsRow(props: { record: WireRecord; selected: boolean; context: ObservationContext; onSelect: (key: string) => void }) {
  const tone = (): StatusTone => props.record.recent_completion ? 'success' : props.record.planned ? 'neutral' : attention(props.record) ? 'warning' : activeRun(props.record) && str(props.record.execution) && props.record.execution !== 'unknown' ? 'info' : 'neutral';
  const summary = () => props.record.recent_completion ? completionLabel(props.record) : str(props.record.activity || props.record.obligation || 'No activity hint observed');
  const age = (): string => {
    const end = observationEnd(props.record, props.context);
    const span = observationDuration(props.record.observed_at, end);
    if (span === 'Unknown') return 'Age unknown';
    const live = props.context.live && !props.context.connectionFailed
      && props.context.now !== null && end === new Date(props.context.now).toISOString();
    return `${span} ${live ? 'since activity' : 'before observation'}`;
  };
  return (
    <button
      type="button"
      class={props.selected ? 'record selected' : 'record'}
      data-key={props.record.key}
      aria-pressed={props.selected}
      onClick={() => props.onSelect(props.record.key)}
    >
      <div class="row-heading">
        <strong class="run-title">{base(props.record.package)}</strong>
        <StatusText tone={tone()}>{runState(props.record, runningUnconfirmed)}</StatusText>
      </div>
      <p>
        {str(props.record.workspace)} · <span innerHTML={props.record.recent_completion ? esc(summary()) : inlineMarkdown(summary(), false)} />
      </p>
      <small>{specProgress(props.record).label} · {age()}</small>
    </button>
  );
}

function SpecsList(props: DestinationProps) {
  const [loadingDelayed, setLoadingDelayed] = createSignal(false);
  let loadingTimer: ReturnType<typeof setTimeout> | undefined;
  const filter = () => filterOf(props.route);
  const context = (): ObservationContext => ({ live: props.live, connectionFailed: props.connectionFailed, now: serverNow() });
  const view = () => specViewState(props.payload, null, props.scopedObservers, context());
  const rows = () => visibleSpecs(props.records, filter(), props.route.q ?? '');
  const query = () => (props.route.q ?? '').trim();
  createEffect(() => {
    if (view().read === 'loading') {
      if (loadingTimer === undefined) loadingTimer = setTimeout(() => setLoadingDelayed(true), 300);
    } else {
      if (loadingTimer !== undefined) {
        clearTimeout(loadingTimer);
        loadingTimer = undefined;
      }
      setLoadingDelayed(false);
    }
  });
  onCleanup(() => {
    if (loadingTimer !== undefined) clearTimeout(loadingTimer);
  });
  const clearFilters = () => {
    const next: RouteState = { ...props.route };
    delete next.q;
    delete next.filter;
    props.onNavigate(next);
  };
  const caption = (): string => {
    if (view().read === 'loading') return 'Reading specs…';
    if (view().read === 'error') return 'Last known catalog: Observations unavailable';
    if (!rows().length) return query() ? '0 matching specs' : 'No specs recorded';
    return `${FILTER_LABELS[filter()]} · ${rows().length} observed specs`;
  };
  const emptyCopy = (): { title: string; text: string } => {
    if (query()) return { title: 'No matching specs', text: `No spec matches “${props.route.q ?? ''}” in this scope.` };
    if (filter() === 'attention') return { title: 'No blocked specs', text: 'Blocked specs appear when an observation reports attention.' };
    if (filter() === 'completed') return { title: 'No recently completed specs', text: 'Recent completion history appears here when the snapshot includes it.' };
    if (filter() === 'planned') return { title: 'No planned specs', text: 'Planned packages appear here when the snapshot includes their inventory.' };
    return { title: 'No observed specs', text: 'Specs appear after the host publishes an observation.' };
  };
  const emptyAction = () => {
    if (query()) return <button type="button" class="ds-btn ds-btn--primary" onClick={clearFilters}>Clear filters</button>;
    if (filter() === 'active') return <button type="button" class="ds-btn" onClick={() => void props.refresh()}>Refresh state</button>;
    return undefined;
  };
  return (
    <>
      <div class="list-controls">
        <label class="sr-only" for="find-record">
          Find spec
        </label>
        <input
          class="ds-input"
          id="find-record"
          type="search"
          placeholder="Find spec or repository"
          value={props.route.q ?? ''}
          onInput={event => props.onQuery(event.currentTarget.value)}
        />
        <SectionTabs label="Package filters" variant="filters" active={filter()} tabs={FILTERS} onSelect={props.onFilter} />
      </div>
      <div class="list-caption">{caption()}</div>
      <div class="records">
        <Show when={view().read === 'loading' && loadingDelayed()}>
          <RegionalSkeleton announce={false} rows={5} label="Reading specs" />
        </Show>
        <Show when={view().read === 'error'}>
          <StateNotice tone="error" title="Specs unavailable" action={<button type="button" class="ds-btn" onClick={props.onRetryConnection}>Retry state</button>}>
            Could not read observations from the host.
          </StateNotice>
        </Show>
        <Show when={view().read === 'ready'}>
          <Show when={view().offline}>
            <StateNotice announce={false} tone="warning" title="Connection lost" action={<button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryConnection}>Retry connection</button>}>
              Last received at {time(view().observedAt ?? undefined)}. Work may have continued; existing rows are retained.
            </StateNotice>
          </Show>
          <Show when={view().stale && view().observedAt !== null}>
            <StateNotice announce={false} tone="warning" title="Observation needs refreshing" action={<button type="button" class="ds-btn" onClick={() => void props.refresh()}>Refresh state</button>}>
              {props.live
                ? `The dashboard is connected; these retained records were last observed at ${time(view().observedAt ?? undefined)}.`
                : `This imported snapshot contains retained records last observed at ${time(view().observedAt ?? undefined)}.`}
            </StateNotice>
          </Show>
          <Show when={view().partial || view().reasons.length}>
            <StateNotice announce={false} tone="warning" title={view().partial ? 'Observation incomplete' : 'Observation diagnostics'} action={!view().partial ? <button type="button" class="ds-btn" onClick={() => void props.refresh()}>Refresh state</button> : undefined}>
              <Show when={view().reasons.length} fallback="Coverage is incomplete; valid rows stay visible.">
                <For each={view().reasons}>{(reason, index) => <>{index() ? <br /> : null}{reason}</>}</For>
              </Show>
            </StateNotice>
          </Show>
          <Show
            when={rows().length}
            fallback={
              <EmptyState
                symbol="◇"
                title={emptyCopy().title}
                text={emptyCopy().text}
                action={emptyAction()}
              />
            }
          >
            <For each={rows()}>{record => <SpecsRow record={record} selected={record.key === props.route.id} context={context()} onSelect={props.onSelect} />}</For>
          </Show>
        </Show>
      </div>
    </>
  );
}

const SPEC_TABS: SectionTab[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'activity', label: 'Activity' },
  { key: 'files', label: 'Files' },
];

const tabOf = (route: RouteState): 'overview' | 'activity' => route.tab === 'activity' ? 'activity' : 'overview';

const headTone = (record: WireRecord): StatusTone =>
  record.recent_completion ? 'success' : record.planned ? 'neutral' : attention(record) ? 'warning' : activeRun(record) && str(record.execution) && record.execution !== 'unknown' ? 'info' : 'neutral';

export default function SpecsDestination(props: DestinationProps) {
  const record = () => props.records.find(item => item.key === props.route.id) ?? null;
  const context = (): ObservationContext => ({ live: props.live, connectionFailed: props.connectionFailed, now: serverNow() });
  const view = () => specViewState(props.payload, record(), props.scopedObservers, context());
  const activityTab = () => tabOf(props.route) === 'activity';
  const [coverageIntent, setCoverageIntent] = createSignal(false);
  const [activityLoadingDelayed, setActivityLoadingDelayed] = createSignal(false);
  let activityLoadingTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (!activityTab() || view().read !== 'loading') {
      if (activityLoadingTimer !== undefined) {
        clearTimeout(activityLoadingTimer);
        activityLoadingTimer = undefined;
      }
      setActivityLoadingDelayed(false);
      return;
    }
    if (activityLoadingTimer === undefined) activityLoadingTimer = setTimeout(() => setActivityLoadingDelayed(true), 300);
  });
  onCleanup(() => {
    if (activityLoadingTimer !== undefined) clearTimeout(activityLoadingTimer);
  });
  const recovery = (): 'offline' | 'stale' | 'partial' | null => {
    const state = view();
    if (state.offline) return 'offline';
    if (state.stale && state.observedAt !== null) return 'stale';
    if (state.partial || state.reasons.length) return 'partial';
    return null;
  };
  const inspectCoverage = () => {
    if (!activityTab()) {
      const next: RouteState = { ...props.route };
      delete next.path;
      delete next.source;
      next.tab = 'activity';
      props.onNavigate(next);
    }
    setCoverageIntent(true);
  };
  createEffect(() => {
    if (!coverageIntent()) return;
    const active = activityTab();
    const frame = requestAnimationFrame(() => {
      if (!active) return;
      const target = document.getElementById('spec-coverage');
      if (!(target instanceof HTMLDetailsElement)) return;
      target.open = true;
      target.tabIndex = -1;
      target.scrollIntoView({ block: 'start' });
      target.focus({ preventScroll: true });
      setCoverageIntent(false);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  const headTitle = () => {
    const item = record();
    if (item) return base(item.package);
    const fromKey = packageFromKey(props.route.id);
    return fromKey ? base(fromKey) : 'Spec overview';
  };
  const assignmentKey = () => {
    const item = record();
    return item ? linkedAssignmentKey(item, props.assignments) : null;
  };
  const openFile = (path: string) => {
    const item = record();
    if (!item || !path) return;
    const relative = packageRelative(item, path);
    if (relative) {
      props.onOpenPackageFiles(item, relative);
      return;
    }
    if (!path.startsWith('/') && !path.split('/').includes('..')) props.onOpenPackageFiles(item, path);
  };
  // Done work-tour action gates on recorded evidence but opens the rendered
  // package tour through the shared Files address; the evidence source names
  // the assessed work-tour.json manifest, which Files renders as raw JSON.
  // A missing source leaves the action disabled with a named reason, and a
  // missing work-tour.html then surfaces the honest Files recovery.
  const workTourPath = (item: WireRecord): string => {
    if (str(item.evidence?.state) !== 'recorded') return '';
    if (!str(item.evidence?.source).trim()) return '';
    return 'work-tour.html';
  };
  const workTourReason = (item: WireRecord): string => str(item.evidence?.state) !== 'recorded'
    ? 'Open work tour is unavailable because this completion has no recorded evidence.'
    : 'Open work tour is unavailable because the recorded evidence has no package-relative source path.';
  const selectTab = (key: string) => {
    const item = record();
    if (key === 'files') {
      if (item) props.onOpenPackageFiles(item);
      return;
    }
    const next: RouteState = { ...props.route };
    delete next.path;
    delete next.source;
    if (key === 'activity') next.tab = 'activity';
    else delete next.tab;
    props.onNavigate(next);
  };
  const openAgent = () => {
    const key = assignmentKey();
    if (!key) return;
    const next: RouteState = { dest: 'agents', id: key };
    if (props.route.ws !== undefined) next.ws = props.route.ws;
    props.onNavigate(next);
  };
  const openEpic = (key: string) => {
    const next: RouteState = { dest: 'epics', id: key };
    if (props.route.ws !== undefined) next.ws = props.route.ws;
    props.onNavigate(next);
  };
  const recoveryActions = () => <>
    <Show when={recovery() === 'offline'}>
      <button class="ds-btn ds-btn--primary" type="button" onClick={props.onRetryConnection}>Retry connection</button>
    </Show>
    <Show when={recovery() === 'stale'}>
      <button class="ds-btn ds-btn--primary" type="button" onClick={() => void props.refresh()}>{activityTab() ? 'Refresh activity' : 'Refresh state'}</button>
    </Show>
    <Show when={recovery() === 'partial'}>
      <button class="ds-btn ds-btn--primary" type="button" onClick={inspectCoverage}>Inspect coverage</button>
    </Show>
  </>;
  return (
    <div class="specs-destination">
      <MasterDetail
        listLabel="Specs"
        list={<SpecsList {...props} />}
      >
        <div class="object-head">
          <div class="object-top">
            <h2>{headTitle()}</h2>
            <Show when={record()}>{item => <StatusText tone={headTone(item())}>{runState(item(), runningUnconfirmed)}</StatusText>}</Show>
          </div>
          <p>{record() ? `${str(record()!.workspace)} / ${str(record()!.package_ref)}` : 'No observed record for this selection'}</p>
        </div>
        <SectionTabs label="Spec sections" tabs={SPEC_TABS} active={tabOf(props.route)} onSelect={selectTab} />
        <div class="detail-body">
          <Show when={record()}>
            {item => <>
              <Show when={item().planned}>
                <Show when={!activityTab()}>
                  <article class="detail planned-spec-summary">
                    <div class="eyebrow">{str(item().workspace)} / Planned spec</div>
                    <div class="detail-title"><div><h2>{base(item().package)}</h2><p class="subtitle mono">{str(item().package_ref)}</p></div><span class="pill muted">Planned</span></div>
                    <p class="section">{str(item().activity || item().obligation || 'Resume this spec package.')}</p>
                    <p class="small muted">Review the brief and agent settings, then launch.</p>
                  </article>
                  <SpecOverview record={item()} assignments={props.assignments} context={context()} onOpenAgent={openAgent} onOpenEpic={openEpic} />
                  <PlannedAssignment record={item()} live={props.live && props.specsLive} token={props.token} />
                </Show>
              </Show>
              <Show when={!item().planned}>
                <Show when={!activityTab()}>
                  <SpecOverview record={item()} assignments={props.assignments} context={context()} onOpenAgent={openAgent} onOpenEpic={openEpic} />
                </Show>
              </Show>
              <Show when={activityTab()}>
                <Show when={view().offline}>
                  <StateNotice announce={false} tone="warning" title="Connection unavailable">
                    Last received at {time(view().observedAt ?? undefined)}. These records may have changed on the host; existing activity is retained.
                  </StateNotice>
                </Show>
                <Show when={view().stale && view().observedAt !== null}>
                  <StateNotice announce={false} tone="warning" title={`Last checked at ${time(view().observedAt ?? undefined)}`}>
                    {props.live
                      ? 'Existing content is retained until a fresh observation is received.'
                      : 'This imported snapshot contains records retained at observation; Refresh activity reconnects to read observations.'}
                  </StateNotice>
                </Show>
                <Show when={view().partial || view().reasons.length}>
                  <StateNotice announce={false} tone="warning" title={view().partial ? 'Evidence coverage incomplete' : 'Observation diagnostics'}>
                    <Show when={view().reasons.length} fallback="Coverage is incomplete; recorded activity stays visible.">
                      <For each={view().reasons}>{(reason, index) => <>{index() ? <br /> : null}{reason}</>}</For>
                    </Show>
                  </StateNotice>
                </Show>
                <SpecActivity record={item()} context={context()} onOpenFile={openFile} recoveryPrimary={recovery() !== null} />
              </Show>
            </>}
          </Show>
          <Show when={!record()}>
            <Show when={activityTab()}>
              <Show when={view().read === 'loading' && activityLoadingDelayed()}>
                <section class="section">
                  <div class="section-heading"><h3>Step attempts</h3></div>
                  <RegionalSkeleton variant="table" rows={3} label="Reading step attempts" />
                </section>
                <section class="section">
                  <div class="section-heading"><h3>Unfinished worker</h3></div>
                  <RegionalSkeleton rows={1} label="Reading unfinished worker" />
                </section>
                <section class="section">
                  <div class="section-heading"><h3>Evidence</h3></div>
                  <RegionalSkeleton rows={1} label="Reading evidence" />
                </section>
              </Show>
              <Show when={view().read === 'error'}>
                <EmptyState
                  symbol="◇"
                  title="Activity could not be read"
                  text="This read failed. It does not establish that the worker failed."
                  action={<button type="button" class="ds-btn ds-btn--primary" onClick={() => void props.refresh()}>Retry activity</button>}
                />
              </Show>
              <Show when={view().read === 'ready'}>
                <EmptyState symbol="◇" title="Select an observed spec" text="Choose a package to inspect its obligation, activity and files." />
              </Show>
            </Show>
            <Show when={!activityTab()}>
              <EmptyState symbol="◇" title="Select an observed spec" text="Choose a package to inspect its obligation, activity and files." />
            </Show>
          </Show>
        </div>
        <Show when={record()}>
          {item => (
            <ActionBar>
              <Show when={item().recent_completion} fallback={
                <Show when={item().planned} fallback={<>
                  {recoveryActions()}
                  <Show when={activityTab()} fallback={
                    <button class={recovery() === null ? 'ds-btn ds-btn--primary' : 'ds-btn'} type="button" onClick={() => selectTab('activity')}>Open spec</button>
                  }>
                    <Show when={workTourPath(item())} fallback={<>
                      <Show when={!props.canOpenPackageFiles(item())}>
                        <span class="sr-only" id="activity-file-reason">Package files are unavailable for this selection.</span>
                      </Show>
                      <button
                        class={recovery() === null && hasActivityFacts(item()) ? 'ds-btn ds-btn--primary' : 'ds-btn'}
                        type="button"
                        disabled={!props.canOpenPackageFiles(item())}
                        aria-describedby={!props.canOpenPackageFiles(item()) ? 'activity-file-reason' : undefined}
                        onClick={() => props.onOpenPackageFiles(item(), 'spec.md')}
                      >Open spec file</button>
                    </>}>
                      {path => <button class={recovery() === null ? 'ds-btn ds-btn--primary' : 'ds-btn'} type="button" onClick={() => props.onOpenPackageFiles(item(), path())}>Open work tour</button>}
                    </Show>
                  </Show>
                  <Show when={assignmentKey()}>
                    <button class="ds-btn" type="button" onClick={openAgent}>Open agent</button>
                  </Show>
                </>}>
                  <Show when={activityTab()} fallback={
                    <button class="ds-btn" type="button" disabled={!props.canOpenPackageFiles(item())} onClick={() => props.onOpenPackageFiles(item())}>Open files</button>
                  }>
                    {recoveryActions()}
                    <button class="ds-btn" type="button" disabled={!props.canOpenPackageFiles(item())} onClick={() => props.onOpenPackageFiles(item())}>Open files</button>
                  </Show>
                </Show>
              }>
                <Show when={activityTab()} fallback={<>
                  <Show when={!workTourPath(item())}>
                    <span class="sr-only" id="work-tour-reason">{workTourReason(item())}</span>
                  </Show>
                  <button
                    class="ds-btn ds-btn--primary"
                    type="button"
                    disabled={!workTourPath(item())}
                    aria-describedby={!workTourPath(item()) ? 'work-tour-reason' : undefined}
                    onClick={() => {
                      const path = workTourPath(item());
                      if (path) props.onOpenPackageFiles(item(), path);
                    }}
                  >Open work tour</button>
                  <button class="ds-btn" type="button" disabled={!props.canOpenPackageFiles(item())} onClick={() => props.onOpenPackageFiles(item())}>Open package files</button>
                </>}>
                  {recoveryActions()}
                  <Show when={!workTourPath(item())}>
                    <span class="sr-only" id="work-tour-reason">{workTourReason(item())}</span>
                  </Show>
                  <button
                    class={recovery() === null ? 'ds-btn ds-btn--primary' : 'ds-btn'}
                    type="button"
                    disabled={!workTourPath(item())}
                    aria-describedby={!workTourPath(item()) ? 'work-tour-reason' : undefined}
                    onClick={() => {
                      const path = workTourPath(item());
                      if (path) props.onOpenPackageFiles(item(), path);
                    }}
                  >Open work tour</button>
                  <button class="ds-btn" type="button" disabled={!props.canOpenPackageFiles(item())} onClick={() => props.onOpenPackageFiles(item())}>Open package files</button>
                </Show>
              </Show>
            </ActionBar>
          )}
        </Show>
        <Show when={record()}>
          {item => (
            <footer class="detail-foot">
              Snapshot observed {time(item().observer?.snapshot?.coverage?.observed_at)} · Activity observed {time(item().observed_at)} · {str(item().workspace)}
            </footer>
          )}
        </Show>
      </MasterDetail>
    </div>
  );
}
