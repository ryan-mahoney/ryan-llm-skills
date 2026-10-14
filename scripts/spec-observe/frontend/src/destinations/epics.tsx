import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { EmptyState, MasterDetail, RegionalSkeleton, StateNotice, StatusText } from '../primitives';
import type { WireRecord } from '../model';
import { time } from '../format';
import { formatHash, type RouteState } from '../route';
import { clearIncompatibleFields } from '../scope';
import { EpicDetail } from './epic-detail';
import { epicCoverageReasons, epicPlanningSummary, epicRecordedState, epicViewState, visibleEpics } from './epic-state';
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

function EpicRow(props: {
  epic: WireRecord;
  records: WireRecord[];
  assignments: WireRecord[];
  selected: boolean;
  route: RouteState;
  onSelect: (id: string) => void;
}) {
  const recorded = () => epicRecordedState(props.epic);
  const planning = () => epicPlanningSummary(props.epic, props.records, props.assignments);
  const stats = () => epicStats(props.epic);
  const evidenceIncomplete = () => (Array.isArray(props.epic.members) ? props.epic.members : [])
    .some(member => ['unknown', 'missing', 'unobserved'].includes(member?.status));
  const subtitle = () => {
    const workspace = text(props.epic.workspace);
    const summary = typeof props.epic.summary === 'string' ? props.epic.summary : '';
    return [workspace, summary].filter(Boolean).join(' · ') || text(props.epic.epic);
  };
  const summary = () => {
    const parts = [`${planning().prepared} of ${planning().total} prepared`];
    if (planning().planning > 0) parts.push(`${planning().planning} planning`);
    if (planning().next) parts.push(`next to plan: ${text(planning().next!.name)}`);
    if (stats().attention > 0) parts.push(`${stats().attention} need attention`);
    if (evidenceIncomplete()) parts.push('evidence incomplete');
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
        <Show
          when={planning().incomplete}
          fallback={<StatusText tone={recorded().tone}>{recorded().label}</StatusText>}
        >
          <StatusText tone="warning">Planning incomplete</StatusText>
        </Show>
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

  // Regional notice priority offline > stale > partial. The announcement
  // signature uses selection, notice state, semantic reasons and conflict
  // counts only, so advancing observation timestamps never recreate the live
  // region while timestamp-only changes update the clock in place.
  // Transport (offline/stale) keeps the primary recovery; partial keeps
  // Open spec primary with no regional action.
  const regional = () => (view().offline ? 'offline' : view().stale ? 'stale' : view().partial ? 'partial' : null);
  const transport = () => (view().offline ? 'offline' : view().stale ? 'stale' : null);
  const receivedAt = () => {
    const value = (props.payload as unknown as { generated_at?: unknown } | null)?.generated_at;
    return typeof value === 'string' && value ? value : null;
  };
  const observedAt = () => view().observedAt;
  const noticeSignature = () => {
    const kind = regional();
    if (!kind) return '';
    const epic = selected();
    const key = String((epic as { key?: unknown } | null)?.key ?? '');
    const observerState = String((epic as WireRecord | null)?.observer?.state ?? '');
    const coverageState = String((epic as WireRecord | null)?.coverage?.state ?? '');
    let reasons = '';
    try {
      reasons = epic ? epicCoverageReasons(epic).join(';') : '';
    } catch {
      reasons = '';
    }
    const conflict = epic ? String(epicRecordedState(epic).conflict) : '';
    let conflictCounts = '';
    if (epic && conflict === 'true') {
      const stats = epicStats(epic);
      conflictCounts = `${stats.landed}/${stats.total}`;
    }
    const hasObserved = view().observedAt ? '1' : '0';
    const hasReceived = receivedAt() ? '1' : '0';
    return `${kind}|${key}|${observerState}|${coverageState}|${reasons}|${conflict}|${conflictCounts}|${hasObserved}|${hasReceived}`;
  };
  const transportNotice = () => {
    const kind = regional();
    if (!kind) return undefined;
    if (kind === 'offline') {
      const action = props.live
        ? <button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryConnection}>Retry connection</button>
        : undefined;
      return (
        <StateNotice tone="warning" title="Connection unavailable" action={action}>
          <span aria-live="off">
            {receivedAt() ? `Last received at ${time(receivedAt())}.` : 'Last received time is unavailable.'}
          </span>{' '}These records may have changed on the host.
        </StateNotice>
      );
    }
    if (kind === 'stale') {
      const action = props.live
        ? <button type="button" class="ds-btn ds-btn--primary" onClick={() => void props.refresh()}>Refresh state</button>
        : undefined;
      return (
        <StateNotice
          tone="warning"
          title={<span aria-live="off">{observedAt() ? `Last checked at ${time(observedAt())}` : 'Observation time unavailable'}</span>}
          action={action}
        >
          Existing content is kept while the host revalidates it.
        </StateNotice>
      );
    }
    const epic = selected();
    if (!epic) return undefined;
    const recorded = epicRecordedState(epic);
    if (recorded.conflict) {
      const stats = epicStats(epic);
      const state = recorded.label.replace(/^Recorded /, '');
      const fact = state.charAt(0).toUpperCase() + state.slice(1);
      return (
        <StateNotice tone="warning" title="Recorded state conflicts with member evidence">
          {`The epic is recorded as ${fact}, but landing is confirmed for ${stats.landed} of ${stats.total} members in this observation. The records have not been rewritten; the conflicting evidence is preserved.`}
        </StateNotice>
      );
    }
    return (
      <StateNotice tone="warning" title="Member evidence incomplete">
        Some member evidence is unavailable in this observation. Recorded statuses and notes are kept.
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
                    {epicRow => <EpicRow epic={epicRow} records={props.records} assignments={props.assignments} selected={epicRow.key === props.route.id} route={props.route} onSelect={props.onSelect} />}
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
                  workspace={props.workspace}
                  rememberedMember={rememberedMember()}
                  onSelectPackage={rememberMember}
                  catalog={props.catalog}
                  preferredWs={props.route.ws}
                  onNavigate={props.onNavigate}
                  notice={notice}
                  transportPrimary={Boolean(transport())}
                  route={props.route}
                  assignments={props.assignments}
                  token={props.token}
                  live={props.live}
                  onOpenPackageFiles={props.onOpenPackageFiles}
                  canOpenPackageFiles={props.canOpenPackageFiles}
                />
              );
            }}
          </Show>
        </Show>
      </MasterDetail>
    </div>
  );
}
