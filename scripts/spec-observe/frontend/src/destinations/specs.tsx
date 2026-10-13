import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { activeRun, attention, base, esc, inlineMarkdown, runningUnconfirmed, serverNow, str, time } from '../format';
import { completionLabel, duration as observationDuration, runState, specProgress } from '../observation-format';
import { observationEnd, specViewState, visibleSpecs, type ObservationContext } from '../spec-state';
import Files from '../Files';
import { PackageDetail } from '../Observations';
import { ActionBar, EmptyState, MasterDetail, RegionalSkeleton, SectionTabs, StateNotice, StatusText, type SectionTab, type StatusTone } from '../primitives';
import PlannedAssignment from '../PlannedAssignment';
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
          <Show when={view().partial}>
            <StateNotice announce={false} tone="warning" title="Observation incomplete">
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

export default function SpecsDestination(props: DestinationProps) {
  const record = () => props.records.find(item => item.key === props.route.id) ?? null;
  return (
    <div class="specs-destination">
      <MasterDetail
        listLabel="Specs"
        list={<SpecsList {...props} />}
      >
        <div class="detail-body">
          <Show when={record()?.planned ? record() : null}>
            {item => <>
              <article class="detail planned-spec-summary">
                <div class="eyebrow">{str(item().workspace)} / Planned spec</div>
                <div class="detail-title"><div><h2>{base(item().package)}</h2><p class="subtitle mono">{str(item().package_ref)}</p></div><span class="pill muted">Planned</span></div>
                <p class="section">{str(item().activity || item().obligation || 'Resume this spec package.')}</p>
                <p class="small muted">Review the brief and agent settings, then launch.</p>
              </article>
              <PlannedAssignment record={item()} live={props.live && props.specsLive} token={props.token} />
            </>}
          </Show>
          <Show when={record()?.planned !== true}>
            <PackageDetail
              record={record()}
              records={props.records}
              live={props.specsLive}
              previewToken={props.token}
              completionToken={props.completionToken}
              completionLocalOnly={props.completionLocalOnly}
              onComplete={props.onComplete}
              onOpenFile={props.onOpenFile}
              onSelect={props.onSelect}
            />
          </Show>
          <Show when={record()?.package} keyed>
            {owner => (
              <Files
                source="package"
                owner={owner}
                live={props.live}
                initialFile={props.route.path ?? null}
                onOpen={props.onOpenFile}
                recentCompletion={record()?.recent_completion}
              />
            )}
          </Show>
        </div>
        <Show when={record()}>
          {item => (
            <ActionBar>
              <button
                class={`ds-btn ${item().planned ? '' : 'ds-btn--primary'}`}
                type="button"
                disabled={!props.canOpenPackageFiles(item())}
                onClick={() => props.onOpenPackageFiles(item())}
              >
                Open files
              </button>
            </ActionBar>
          )}
        </Show>
      </MasterDetail>
    </div>
  );
}
