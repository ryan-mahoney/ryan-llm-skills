import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { EmptyState, MasterDetail, RegionalSkeleton, StateNotice, StatusText } from '../primitives';
import type { WireRecord } from '../model';
import { EpicDetail } from './epic-detail';
import { epicRecordedState, epicViewState, visibleEpics } from './epic-state';
import { epicStats } from '../observation-format';
import type { DestinationProps } from './index';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function EpicRow(props: { epic: WireRecord; selected: boolean; onSelect: (id: string) => void }) {
  const recorded = () => epicRecordedState(props.epic);
  const stats = () => epicStats(props.epic);
  const subtitle = () => {
    const workspace = text(props.epic.workspace);
    const summary = typeof props.epic.summary === 'string' ? props.epic.summary : '';
    return [workspace, summary].filter(Boolean).join(' · ') || text(props.epic.epic);
  };
  return (
    <button
      type="button"
      class={props.selected ? 'record selected' : 'record'}
      data-epic={props.epic.key}
      aria-current={props.selected ? 'true' : undefined}
      onClick={() => props.onSelect(String(props.epic.key ?? ''))}
    >
      <div class="row-heading">
        <strong>{text(props.epic.title) || text(props.epic.epic) || 'Untitled epic'}</strong>
        <StatusText tone={recorded().tone}>{recorded().label}</StatusText>
      </div>
      <p>{subtitle()}</p>
      <small>{`${stats().landed} of ${stats().total} landed${text(props.epic.next) ? ` · next: ${text(props.epic.next)}` : ''}`}</small>
    </button>
  );
}

export default function EpicsDestination(props: DestinationProps) {
  const [delayed, setDelayed] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const coldFile = () => !props.live && !props.payload;
  const loading = () => props.live && !props.payload && !props.connectionFailed;
  const rows = () => visibleEpics(props.epics, props.route.q ?? '');
  const selected = () => props.epics.find(item => item.key === props.route.id) ?? null;
  const view = () => epicViewState({
    payload: props.payload,
    live: props.live,
    connectionFailed: props.connectionFailed,
    imported: !props.live,
    epicSupport: props.epicSupport,
    scoped: props.epics,
    visible: rows(),
    selected: selected(),
  });
  const read = () => (coldFile() ? 'file' : view().read);

  createEffect(() => {
    clearTimeout(timer);
    timer = undefined;
    if (loading()) {
      timer = setTimeout(() => setDelayed(true), 300);
    } else {
      setDelayed(false);
    }
  });
  onCleanup(() => clearTimeout(timer));

  const caption = () => {
    if (coldFile()) return '';
    if (read() === 'loading') return delayed() ? 'Reading epics…' : '';
    if (read() === 'error') return 'Epic records unavailable';
    switch (view().empty) {
      case 'no-snapshot':
        return 'No observer snapshots';
      case 'unsupported':
        return 'Epic data unavailable';
      case 'no-epics':
        return 'No epics recorded';
      case 'no-matches':
        return '0 matching epics';
      default:
        return `${props.epics.length} epic record${props.epics.length === 1 ? '' : 's'} · dependency order`;
    }
  };

  return (
    <div class="epics-destination">
      <MasterDetail
        listLabel="Epics"
        list={
          <>
            <div class="list-controls">
              <label class="sr-only" for="find-record">
                Find epics
              </label>
              <input
                class="ds-input"
                id="find-record"
                type="search"
                placeholder="Find epics"
                value={props.route.q ?? ''}
                onInput={event => props.onQuery(event.currentTarget.value)}
              />
            </div>
            <div class="list-caption">{caption()}</div>
            <div class="records">
              <Show when={coldFile()}>
                <EmptyState
                  title="A live dashboard is required"
                  text="Epics need the local dashboard server. Import a Sentinel snapshot to inspect epics."
                />
              </Show>
              <Show when={read() === 'loading'}>
                <Show when={delayed()}>
                  <RegionalSkeleton rows={4} label="Reading epics" />
                </Show>
              </Show>
              <Show when={read() === 'error'}>
                <StateNotice
                  announce={false}
                  tone="error"
                  title="Epics could not be read"
                  action={<button type="button" class="ds-btn" onClick={props.onRetryConnection}>Retry connection</button>}
                >
                  The host did not return a usable result. Your selection is kept.
                </StateNotice>
              </Show>
              <Show when={read() === 'ready'}>
                <Show when={view().empty === 'no-snapshot'}>
                  <EmptyState
                    title="No observer snapshots"
                    text="Connect a Sentinel observer or import a published snapshot to inspect epic records."
                  />
                </Show>
                <Show when={view().empty === 'unsupported'}>
                  <EmptyState
                    title="Epic data unavailable"
                    text="The connected observers do not report epic records. Update the observer, then refresh this view."
                  />
                </Show>
                <Show when={view().empty === 'no-epics'}>
                  <EmptyState
                    title="No epics recorded"
                    text="Epic plans appear when an operator registers their member specs."
                  />
                </Show>
                <Show when={view().empty === 'no-matches'}>
                  <EmptyState
                    title="No matching epics"
                    text={`No item matches “${props.route.q ?? ''}”. Your search and scope are kept.`}
                    action={<button type="button" class="ds-btn ds-btn--primary" onClick={() => props.onQuery('')}>Clear filters</button>}
                  />
                </Show>
                <Show when={view().empty === 'none'}>
                  <For each={rows()}>
                    {epicRow => <EpicRow epic={epicRow} selected={epicRow.key === props.route.id} onSelect={props.onSelect} />}
                  </For>
                </Show>
              </Show>
            </div>
          </>
        }
      >
        <Show when={read() === 'loading'}>
          <Show when={delayed()}>
            <div class="detail-body">
              <RegionalSkeleton rows={4} label="Reading epic details" />
            </div>
          </Show>
        </Show>
        <Show when={read() === 'error'}>
          <div class="object-head">
            <div class="object-top">
              <h2>{text(props.route.id) || 'Epic details'}</h2>
              <StatusText tone="neutral">Not confirmed</StatusText>
            </div>
            <p>{text(props.route.id) ? 'Selected epic retained while the host is unavailable.' : 'No selected epic in this route.'}</p>
          </div>
          <div class="detail-body">
            <EmptyState
              symbol="◇"
              title="Epic could not be read"
              text="Your selected epic is kept. Retry the host observation."
              action={<button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryConnection}>Retry connection</button>}
            />
          </div>
        </Show>
        <Show when={read() === 'file' || read() === 'ready'}>
          <Show
            when={read() === 'ready' ? selected() : null}
            fallback={
              <div class="detail-body">
                <EmptyState
                  symbol="◇"
                  title="Choose an epic"
                  text={view().empty === 'no-matches'
                    ? 'Clear the search to restore the available epic plans.'
                    : 'Registered epics contain member specs and their dependency order.'}
                />
              </div>
            }
          >
            {epic => <EpicDetail epic={epic()} records={props.records} onSelectPackage={props.onSelectPackage} />}
          </Show>
        </Show>
      </MasterDetail>
    </div>
  );
}
