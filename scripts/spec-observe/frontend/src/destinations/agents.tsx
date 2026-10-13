import { createEffect, on } from 'solid-js';
import { AgentDetail, AgentList } from '../Observations';
import { MasterDetail } from '../primitives';
import { effectiveAgentFilter, visibleAgents } from '../agent-state';
import { formatHash } from '../route';
import type { DestinationProps } from './index';

// Adapter-owned in-memory list offsets, keyed by the exact rendered route.
// They hold only scroll positions and never cross a scope/import context.
const agentScrollOffsets = new Map<string, number>();

export default function AgentsDestination(props: DestinationProps) {
  // Group first (active/ended from the explicit filter or the settled
  // inference), then search, using the shared visible-row owner.
  const filter = () => effectiveAgentFilter(props.route, props.assignments);
  const visible = () => visibleAgents(props.assignments, filter(), props.route.q ?? '');
  // Detail facts come from the bounded retained row; a local find would
  // silently fall through to another assignment when the id is absent.
  const selected = () => props.agentsSelected ?? null;
  let recordsEl: HTMLDivElement | undefined;

  createEffect(on(() => [props.route.ws, props.refreshKey, props.live] as const, () => agentScrollOffsets.clear(), { defer: true }));
  createEffect(on(() => formatHash(props.route), key => {
    const top = agentScrollOffsets.get(key);
    if (recordsEl && top) recordsEl.scrollTop = top;
  }, { defer: true }));

  const rememberScroll = () => {
    if (recordsEl) agentScrollOffsets.set(formatHash(props.route), recordsEl.scrollTop);
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
              onInput={event => props.onQuery(event.currentTarget.value)}
            />
          </div>
          <div class="list-caption">{props.assignments.length} observed agents</div>
          <div class="records" ref={el => (recordsEl = el)} onScroll={rememberScroll}>
            <AgentList
              assignments={visible()}
              query={props.route.q ?? ''}
              selected={props.route.id ?? null}
              onSelect={props.onSelect}
            />
          </div>
        </>
      }
    >
      <div class="detail-body">
        <AgentDetail
          assignment={selected()}
          records={props.records}
          token={props.token}
          live={props.live}
          refresh={props.refresh}
          onEnded={props.onEnded}
        />
      </div>
    </MasterDetail>
  );
}
