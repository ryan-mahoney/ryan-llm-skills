import { Show } from 'solid-js';
import { activeRun, attention, str } from '../format';
import Files from '../Files';
import { PackageDetail, PackageList } from '../Observations';
import { ActionBar, MasterDetail, SectionTabs, type SectionTab } from '../primitives';
import type { DestinationProps } from './index';

type Filter = 'active' | 'attention' | 'completed';

const FILTERS: SectionTab[] = [
  { key: 'active', label: 'Active' },
  { key: 'attention', label: 'Attention' },
  { key: 'completed', label: 'Completed' },
];

export default function SpecsDestination(props: DestinationProps) {
  const filter = (): Filter => {
    const value = props.route.filter;
    return value === 'attention' || value === 'completed' ? value : 'active';
  };
  const record = () => props.records.find(item => item.key === props.route.id) ?? null;
  const visibleCount = () => {
    const query = (props.route.q ?? '').trim().toLowerCase();
    return props.records.filter(item =>
      (filter() === 'completed' ? item.recent_completion === true : !item.recent_completion) &&
      (!query || [item.workspace, item.package_ref, item.package, item.activity, item.obligation, item.execution, item.workflow_state].some(value => str(value).toLowerCase().includes(query))) &&
      (filter() === 'completed' || filter() === 'active' && activeRun(item) || filter() === 'attention' && attention(item))
    ).length;
  };
  return (
    <MasterDetail
      listLabel="Specs"
      list={
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
          <div class="list-caption">{filter() === 'completed' ? 'Recently completed' : filter() === 'attention' ? 'Attention first' : 'Active'} · {visibleCount()} observed specs</div>
          <div class="records">
            <PackageList
              records={props.records}
              filter={filter()}
              query={props.route.q ?? ''}
              selected={props.route.id ?? null}
              onSelect={props.onSelect}
            />
          </div>
        </>
      }
    >
      <div class="detail-body">
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
        <Show when={record()?.package} keyed>
          {owner => (
            <Files
              source="package"
              owner={owner}
              live={props.live}
              initialFile={props.route.path ?? null}
              recentCompletion={record()?.recent_completion}
            />
          )}
        </Show>
      </div>
      <Show when={record()}>
        {item => (
          <ActionBar>
            <button
              class="ds-btn ds-btn--primary"
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
  );
}
