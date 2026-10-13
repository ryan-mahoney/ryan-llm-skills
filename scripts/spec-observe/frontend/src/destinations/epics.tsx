import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { EmptyState, MasterDetail, RegionalSkeleton, StateNotice, StatusText } from '../primitives';
import type { WireRecord } from '../model';
import { time } from '../format';
import { formatHash, type RouteState } from '../route';
import { clearIncompatibleFields } from '../scope';
import { EpicDetail } from './epic-detail';
import { epicRecordedState, epicViewState, visibleEpics } from './epic-state';
import { epicStats } from '../observation-format';
import type { DestinationProps } from './index';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

// One-use in-session return token for member navigation. It stays module-local
// (no route field, store or persistence) and is consumed by the same epic's
// remount so unchanged polls never reapply focus or pane scroll.
type MemberReturn = {
  epicKey: string | null;
  memberSlug: string;
  ws: string | undefined;
  q: string;
  id: string | null;
  listScroll: number;
  detailScroll: number;
};
let memberReturn: MemberReturn | null = null;

// Route identity is a serialized [workspace, epic] tuple. Decode it for display
// only: a valid tuple shows its epic slug, anything else is not a selection.
const epicSlug = (id: unknown): string | null => {
  if (typeof id !== 'string' || !id) return null;
  try {
    const parsed: unknown = JSON.parse(id);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    if (typeof parsed[0] !== 'string' || !parsed[0]) return null;
    if (typeof parsed[1] !== 'string' || !parsed[1]) return null;
    return parsed[1];
  } catch {
    return null;
  }
};

function EpicRow(props: { epic: WireRecord; selected: boolean; route: RouteState; onSelect: (id: string) => void }) {
  const recorded = () => epicRecordedState(props.epic);
  const stats = () => epicStats(props.epic);
  const incomplete = () => (Array.isArray(props.epic.members) ? props.epic.members : [])
    .some(member => ['unknown', 'missing', 'unobserved'].includes(member?.status));
  const subtitle = () => {
    const workspace = text(props.epic.workspace);
    const summary = typeof props.epic.summary === 'string' ? props.epic.summary : '';
    return [workspace, summary].filter(Boolean).join(' · ') || text(props.epic.epic);
  };
  const summary = () => {
    const parts = [`${stats().landed} of ${stats().total} landed`];
    if (text(props.epic.next)) parts.push(`next: ${text(props.epic.next)}`);
    if (stats().attention > 0) parts.push(`${stats().attention} need attention`);
    if (incomplete()) parts.push('evidence incomplete');
    return parts.join(' · ');
  };
  const href = () => formatHash({ ...clearIncompatibleFields(props.route), id: String(props.epic.key ?? '') });
  const select = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    props.onSelect(String(props.epic.key ?? ''));
  };
  return (
    <a
      class={props.selected ? 'record selected' : 'record'}
      data-epic={props.epic.key}
      aria-current={props.selected ? 'page' : undefined}
      href={href()}
      onClick={select}
    >
      <div class="row-heading">
        <strong>{text(props.epic.title) || text(props.epic.epic) || 'Untitled epic'}</strong>
        <StatusText tone={recorded().tone}>{recorded().label}</StatusText>
      </div>
      <p>{subtitle()}</p>
      <small>{summary()}</small>
    </a>
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

  let returnRestored = false;
  // The marker is only valid for the epic/scope the token was saved from; any
  // other mounted epic keeps the row unmarked so it cannot receive focus.
  const rememberedMember = () => {
    const token = memberReturn;
    if (!token) return null;
    if ((props.route.id ?? null) !== token.id || (props.route.ws ?? null) !== (token.ws ?? null)) return null;
    return token.memberSlug;
  };
  const rememberMember = (workspace: string, name: string) => {
    const list = document.querySelector<HTMLElement>('.list-pane .records');
    const detail = document.querySelector<HTMLElement>('.detail-pane .detail-body');
    memberReturn = {
      epicKey: props.route.id ?? null,
      memberSlug: name,
      ws: props.route.ws,
      q: props.route.q ?? '',
      id: props.route.id ?? null,
      listScroll: list?.scrollTop ?? 0,
      detailScroll: detail?.scrollTop ?? 0,
    };
    props.onSelectPackage(workspace, name);
  };
  createEffect(() => {
    const token = memberReturn;
    if (!token) return;
    // A deliberate different epic or scope drops the token.
    if ((props.route.id ?? null) !== token.id || (props.route.ws ?? null) !== (token.ws ?? null)) {
      memberReturn = null;
      return;
    }
    if (returnRestored) return;
    returnRestored = true;
    // Consume before the asynchronous restore so a poll in between cannot
    // replay it. A missing remembered member never focuses a sibling row.
    memberReturn = null;
    const button = document.querySelector<HTMLButtonElement>('table.epic-members [data-remembered-member="true"] button');
    if (!button) return;
    requestAnimationFrame(() => {
      const list = document.querySelector<HTMLElement>('.list-pane .records');
      const detail = document.querySelector<HTMLElement>('.detail-pane .detail-body');
      if (list) list.scrollTop = token.listScroll;
      if (detail) detail.scrollTop = token.detailScroll;
      button.focus({ preventScroll: true });
    });
  });

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
      default: {
        const query = (props.route.q ?? '').trim();
        if (query && rows().length !== props.epics.length) return `${rows().length} shown of ${props.epics.length} epics`;
        return `${props.epics.length} epic record${props.epics.length === 1 ? '' : 's'} · dependency order`;
      }
    }
  };
  // Regional primary for live empty regions. Cold file mode keeps no retry.
  const refreshAction = () => (props.live
    ? <button type="button" class="ds-btn ds-btn--primary" onClick={() => void props.refresh()}>Refresh state</button>
    : undefined);

  // Regional transport notice: offline wins over stale, and the notice is
  // rebuilt only when its semantic signature changes so repeated polls keep
  // identical text without re-announcing an unchanged live region.
  const transport = () => (view().offline ? 'offline' : view().stale ? 'stale' : null);
  const noticeSignature = () => {
    const kind = transport();
    if (!kind) return '';
    return `${kind}|${view().observedAt ?? ''}|${String(selected()?.key ?? '')}`;
  };
  const transportNotice = () => {
    const kind = transport();
    if (!kind) return undefined;
    const observedAt = view().observedAt;
    const action = props.live
      ? (kind === 'offline'
        ? <button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryConnection}>Retry connection</button>
        : <button type="button" class="ds-btn ds-btn--primary" onClick={() => void props.refresh()}>Refresh state</button>)
      : undefined;
    if (kind === 'offline') {
      return (
        <StateNotice tone="warning" title="Connection unavailable" action={action}>
          {observedAt
            ? `Last received at ${time(observedAt)}. These records may have changed on the host.`
            : 'Last received time is unavailable. These records may have changed on the host.'}
        </StateNotice>
      );
    }
    return (
      <StateNotice
        tone="warning"
        title={observedAt ? `Last checked at ${time(observedAt)}` : 'Observation time unavailable'}
        action={action}
      >
        Existing content is kept while the host revalidates it.
      </StateNotice>
    );
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
                    action={refreshAction()}
                  />
                </Show>
                <Show when={view().empty === 'unsupported'}>
                  <EmptyState
                    title="Epic data unavailable"
                    text="The connected observers do not report epic records. Update the observer, then refresh this view."
                    action={refreshAction()}
                  />
                </Show>
                <Show when={view().empty === 'no-epics'}>
                  <EmptyState
                    title="No epics recorded"
                    text="Epic plans appear when an operator registers their member specs."
                    action={refreshAction()}
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
                    {epicRow => <EpicRow epic={epicRow} selected={epicRow.key === props.route.id} route={props.route} onSelect={props.onSelect} />}
                  </For>
                </Show>
              </Show>
            </div>
          </>
        }
      >
        <Show when={read() === 'loading'}>
          <Show when={delayed()}>
            <div class="object-head">
              <div class="object-top">
                <h2>Epic details</h2>
              </div>
              <p />
            </div>
            <div class="detail-body">
              <div class="facts">
                <RegionalSkeleton rows={1} label="Reading epic facts" />
                <RegionalSkeleton rows={1} label="Reading epic facts" />
                <RegionalSkeleton rows={1} label="Reading epic facts" />
              </div>
              <section class="section">
                <div class="section-heading"><h3>Dependency order</h3><span class="muted" /></div>
                <RegionalSkeleton variant="table" rows={3} label="Reading epic members" />
              </section>
            </div>
          </Show>
        </Show>
        <Show when={read() === 'error'}>
          <div class="object-head">
            <div class="object-top">
              <h2>{epicSlug(props.route.id) ?? 'Epic details'}</h2>
              <StatusText tone="neutral">Not confirmed</StatusText>
            </div>
            <p>{epicSlug(props.route.id) ? 'Selected epic retained while the host is unavailable.' : 'No selected epic in this route.'}</p>
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
              <>
                <div class="object-head">
                  <div class="object-top">
                    <h2>Epic details</h2>
                  </div>
                  <p />
                </div>
                <div class="detail-body">
                  <EmptyState
                    symbol="◇"
                    title="Choose an epic"
                    text={view().empty === 'no-matches'
                      ? 'Clear the search to restore the available epic plans.'
                      : 'Registered epics contain member specs and their dependency order.'}
                  />
                </div>
              </>
            }
          >
            {epic => {
              const notice = (
                <Show keyed when={noticeSignature()}>
                  {signature => (signature ? transportNotice() : undefined)}
                </Show>
              );
              return (
                <EpicDetail
                  epic={epic()}
                  records={props.records}
                  rememberedMember={rememberedMember()}
                  onSelectPackage={rememberMember}
                  notice={notice}
                  transportPrimary={Boolean(transport())}
                />
              );
            }}
          </Show>
        </Show>
      </MasterDetail>
    </div>
  );
}
