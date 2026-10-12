import { Show } from 'solid-js';
import { EpicDetail, EpicList } from '../Observations';
import { EmptyState, MasterDetail } from '../primitives';
import type { DestinationProps } from './index';

export default function EpicsDestination(props: DestinationProps) {
  const epic = () => props.epics.find(item => item.key === props.route.id) ?? null;
  return (
    <MasterDetail
      listLabel="Epics"
      list={
        <>
          <div class="list-controls">
            <label class="sr-only" for="find-record">
              Find epic
            </label>
            <input
              class="ds-input"
              id="find-record"
              type="search"
              placeholder="Find epic"
              value={props.route.q ?? ''}
              onInput={event => props.onQuery(event.currentTarget.value)}
            />
          </div>
          <div class="list-caption">{props.epics.length} recorded epics</div>
          <div class="records">
            <Show when={!props.epicSupport} fallback={<EmptyState title={props.epicSupport ?? 'Epic data unavailable'} />}>
              <EpicList
                epics={props.epics}
                query={props.route.q ?? ''}
                selected={props.route.id ?? null}
                onSelect={props.onSelect}
              />
            </Show>
          </div>
        </>
      }
    >
      <div class="detail-body">
        <EpicDetail epic={epic()} onSelectPackage={props.onSelectPackage} />
      </div>
    </MasterDetail>
  );
}
