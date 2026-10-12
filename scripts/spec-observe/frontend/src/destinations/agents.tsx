import { AgentDetail, AgentList } from '../Observations';
import { MasterDetail } from '../primitives';
import type { DestinationProps } from './index';

export default function AgentsDestination(props: DestinationProps) {
  const assignment = () => props.assignments.find(item => item.key === props.route.id) ?? null;
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
          <div class="records">
            <AgentList
              assignments={props.assignments}
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
          assignment={assignment()}
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
