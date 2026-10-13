import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js';
import { AgentDetail, AgentList } from '../Observations';
import { EmptyState, MasterDetail, RegionalSkeleton, SectionTabs, StateNotice } from '../primitives';
import { agentCounts, agentViewState, effectiveAgentFilter, visibleAgents } from '../agent-state';
import { stale, time } from '../format';
import { authoritativeObservers } from '../model';
import type { Envelope, WireRecord } from '../model';
import { formatHash } from '../route';
import type { DestinationProps } from './index';

// Adapter-owned in-memory list offsets, keyed by the exact rendered route.
// They hold only scroll positions and never cross a scope/import context.
const agentScrollOffsets = new Map<string, number>();

// Observer assignment-coverage reasons for the partial-list notice: the
// payload is the only owner of these facts, so they are read, not inferred.
const coverageReasons = (payload: Envelope | null): string[] => {
  if (!payload) return [];
  const reasons: string[] = [];
  for (const observer of authoritativeObservers(payload.observers ?? [])) {
    const coverage: WireRecord | undefined = observer.snapshot?.assignment_coverage;
    const state = typeof coverage?.state === 'string' ? coverage.state : 'unknown';
    if (state === 'complete') continue;
    const workspace = observer.snapshot?.workspace || observer.observer_id || observer.source || 'unknown';
    const entries = Array.isArray(coverage?.reasons) ? coverage.reasons : [];
    reasons.push(`${workspace} · assignment coverage ${state}${entries.length ? `: ${entries.join('; ')}` : ''}`);
  }
  return reasons;
};

export default function AgentsDestination(props: DestinationProps) {
  // Group first (active/ended from the explicit filter or the settled
  // inference), then search, using the shared visible-row owner.
  const filter = () => effectiveAgentFilter(props.route, props.assignments);
  const visible = () => visibleAgents(props.assignments, filter(), props.route.q ?? '');
  // Detail facts come from the bounded retained row; a local find would
  // silently fall through to another assignment when the id is absent.
  const selected = () => props.agentsSelected ?? null;

  // Shared state owner decisions: source/coverage facts come from the
  // App-level agentCoverage memo, never re-derived locally.
  const sourceUnavailable = () => props.agentsCoverage?.sourceUnavailable === true;
  const listPartial = () => props.agentsCoverage?.listPartial === true;
  const listObservedAt = () => props.agentsCoverage?.listObservedAt ?? null;
  const payloadPresent = () => props.payload !== null;

  const view = () =>
    agentViewState({
      payloadPresent: payloadPresent(),
      live: props.live,
      connectionFailed: props.connectionFailed,
      sourceUnavailable: sourceUnavailable(),
      observationStale: stale(listObservedAt()),
      total: props.assignments.length,
      visible: visible().length,
      query: props.route.q ?? '',
    });

  // An unreadable read replaces the rows only when nothing is retained to
  // inspect; a retained selection keeps its rows and receives a warning.
  const errorList = () => view() === 'error' && (props.payload === null || selected() === null);
  // The detail error placeholder applies when there is no retained context
  // at all; with rows present the bounded AgentDetail contract keeps its own
  // missing-selection copy.
  const errorDetail = () => view() === 'error' && selected() === null && props.assignments.length === 0;

  const label = () => (filter() === 'ended' ? 'Ended' : 'Active');
  const caption = () => {
    if (view() === 'loading') return 'Reading agents…';
    if (sourceUnavailable() || view() === 'error') return `${label()} · counts unavailable`;
    const counts = agentCounts(props.assignments);
    const count = label() === 'Active' ? counts.active : counts.ended;
    return `${label()} · ${count} observed agent${count === 1 ? '' : 's'}`;
  };

  // Loading appears only after a bounded initial delay. A later refresh with
  // a payload present keeps the known rows and never re-enters the skeleton.
  const [initialDelayElapsed, setInitialDelayElapsed] = createSignal(false);
  createEffect(() => {
    if (payloadPresent() || props.connectionFailed) return;
    const timer = setTimeout(() => setInitialDelayElapsed(true), 300);
    onCleanup(() => clearTimeout(timer));
  });

  const listNotice = () => {
    if (view() === 'loading' || errorList()) return null;
    if (sourceUnavailable()) {
      return (
        <StateNotice
          tone="warning"
          title="Source unavailable"
          action={
            <button type="button" class="ds-btn" onClick={props.onRetryConnection}>
              Retry state
            </button>
          }
        >
          {`Assignment coverage could not be read${listObservedAt() ? ` as of ${time(listObservedAt())}` : ''}. Existing rows are kept; no process failure has been inferred.`}
        </StateNotice>
      );
    }
    if (props.connectionFailed) {
      return (
        <StateNotice
          tone="warning"
          title="Connection unavailable"
          action={
            <button type="button" class="ds-btn" onClick={props.onRetryConnection}>
              Retry connection
            </button>
          }
        >
          {`Last received at ${time(listObservedAt())}. These records may have changed on the host.`}
        </StateNotice>
      );
    }
    if (view() === 'stale') {
      return (
        <StateNotice tone="warning" title={`Last checked at ${time(listObservedAt())}`}>
          Existing content is kept while the host revalidates it.
        </StateNotice>
      );
    }
    if (listPartial()) {
      const reasons = coverageReasons(props.payload);
      return (
        <StateNotice tone="warning" title="Assignment coverage incomplete">
          {reasons.length ? reasons.join(' · ') : 'One or more observers returned an incomplete assignment read.'}
        </StateNotice>
      );
    }
    return null;
  };

  let recordsEl: HTMLDivElement | undefined;

  // Adapter-owned scroll continuity: save the outgoing offset before each
  // route change, then restore the settled route's offset (zero included).
  // A missing entry means an unvisited route and starts at the top. This
  // runs on mount as well as on route changes; only a genuine scope/import
  // context change clears the map, so ordinary refresh/polling keeps it.
  let lastAgentsRouteKey: string | null = null;
  createEffect(() => {
    const key = formatHash(props.route);
    const previous = lastAgentsRouteKey;
    lastAgentsRouteKey = key;
    if (previous !== null && previous !== key && recordsEl) {
      agentScrollOffsets.set(previous, recordsEl.scrollTop);
    }
    if (recordsEl) {
      const saved = agentScrollOffsets.get(key);
      recordsEl.scrollTop = saved ?? 0;
    }
  });
  createEffect(on(() => [props.route.ws, props.live] as const, () => {
    agentScrollOffsets.clear();
    lastAgentsRouteKey = null;
  }, { defer: true }));

  const rememberScroll = () => {
    if (recordsEl) agentScrollOffsets.set(formatHash(props.route), recordsEl.scrollTop);
  };

  // Clear both parts of the filter in one user action; App.setQuery/setFilter
  // compose synchronously and preserve ws.
  const clearFilters = () => {
    props.onQuery('');
    props.onFilter('all');
  };

  // Agents-specific search transaction: settle the visible list for the next
  // query under the preserved explicit filter, then clear or reselect the
  // identity in the same navigation so a stale id can neither hide the new
  // rows nor linger beside them. A still-visible selection is kept (so
  // clearing the query preserves it); otherwise the id is dropped and the
  // query alone settles the group, selecting the first settled row.
  const onAgentsSearch = (value: string) => {
    const next = { ...props.route };
    if (value) next.q = value;
    else delete next.q;
    const previousId = typeof next.id === 'string' && next.id ? next.id : null;
    const settled = visibleAgents(props.assignments, effectiveAgentFilter(next, props.assignments), next.q ?? '');
    if (previousId && settled.some(row => row.key === previousId)) {
      next.id = previousId;
    } else {
      delete next.id;
      const fallback = visibleAgents(props.assignments, effectiveAgentFilter(next, props.assignments), next.q ?? '');
      const first = fallback[0]?.key ?? null;
      if (first) next.id = first;
    }
    props.onNavigate(next);
  };

  return (
    <MasterDetail
      listLabel="Agents"
      list={
        <>
          <div class="list-controls">
            <label class="sr-only" for="find-record">
              Find agent
            </label>
            <input
              class="ds-input"
              id="find-record"
              type="search"
              placeholder="Find agent"
              value={props.route.q ?? ''}
              onInput={event => onAgentsSearch(event.currentTarget.value)}
            />
            <SectionTabs
              label="Agent status"
              variant="filters"
              active={filter()}
              tabs={[{ key: 'active', label: 'Active' }, { key: 'ended', label: 'Ended' }]}
              onSelect={props.onFilter}
            />
          </div>
          <div class="list-caption">{caption()}</div>
          <div class="records" ref={el => (recordsEl = el)} onScroll={rememberScroll}>
            <Show when={view() === 'loading' && initialDelayElapsed()}>
              <div class="agents-skeleton">
                <RegionalSkeleton rows={4} label="Loading agents" />
              </div>
            </Show>
            <Show when={errorList()}>
              <StateNotice
                tone="error"
                title="Agents could not be read"
                action={
                  <button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryConnection}>
                    Retry state
                  </button>
                }
              >
                The host did not return a usable result. No process failure has been inferred.
              </StateNotice>
            </Show>
            {listNotice()}
            <Show when={!errorList() && view() === 'empty'}>
              <EmptyState
                title="No agents observed"
                text="An absent assignment snapshot differs from an empty one; refresh to read the host again."
                action={
                  <button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryConnection}>
                    Refresh state
                  </button>
                }
              />
            </Show>
            <Show when={!errorList() && view() === 'no-matches'}>
              <EmptyState
                title="No matching agents"
                text={
                  props.route.q
                    ? `No item matches “${props.route.q}”. Your search and scope are kept.`
                    : `No ${label().toLowerCase()} agents match the current view. Clear the filters to restore the list.`
                }
                action={
                  <button type="button" class="ds-btn ds-btn--primary" onClick={clearFilters}>
                    Clear filters
                  </button>
                }
              />
            </Show>
            <Show
              when={
                !errorList() &&
                view() !== 'loading' &&
                view() !== 'empty' &&
                view() !== 'no-matches' &&
                visible().length > 0
              }
            >
              <div class="agents-list">
                <AgentList
                  assignments={visible()}
                  query={props.route.q ?? ''}
                  selected={props.route.id ?? null}
                  onSelect={props.onSelect}
                />
              </div>
            </Show>
          </div>
        </>
      }
    >
      <div class="detail-body">
        <Show when={view() === 'loading'}>
          <RegionalSkeleton rows={3} label="Loading agents" />
        </Show>
        <Show when={view() !== 'loading' && errorDetail()}>
          <StateNotice
            tone="error"
            title="Agent observation unavailable"
            action={
              <button type="button" class="ds-btn ds-btn--primary" onClick={props.onRetryConnection}>
                Retry state
              </button>
            }
          >
            The host could not read assignment observations. No process failure has been inferred.
          </StateNotice>
        </Show>
        <Show when={view() !== 'loading' && !errorDetail()}>
          <AgentDetail
            assignment={selected()}
            records={props.records}
            token={props.token}
            live={props.live}
            refresh={props.refresh}
            onEnded={props.onEnded}
          />
        </Show>
      </div>
    </MasterDetail>
  );
}
