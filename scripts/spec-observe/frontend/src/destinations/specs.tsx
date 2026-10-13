import { Show } from 'solid-js';
import { base, packageFilterMatches, str } from '../format';
import Files from '../Files';
import { PackageDetail, PackageList } from '../Observations';
import { ActionBar, MasterDetail, SectionTabs, type SectionTab } from '../primitives';
import RelaunchAssignment from '../RelaunchAssignment';
import PlannedAssignment from '../PlannedAssignment';
import type { DestinationProps } from './index';

type Filter = 'active' | 'attention' | 'completed' | 'planned';

const FILTERS: SectionTab[] = [
  { key: 'active', label: 'Active' },
  { key: 'attention', label: 'Blocked' },
  { key: 'completed', label: 'Done' },
  { key: 'planned', label: 'Planned' },
];

export default function SpecsDestination(props: DestinationProps) {
  const filter = (): Filter => {
    const value = props.route.filter;
    return value === 'attention' || value === 'completed' || value === 'planned' ? value : 'active';
  };
  const record = () => props.records.find(item => item.key === props.route.id) ?? null;
  const priorAssignment = () => props.assignments.filter(item =>
    item.skill === 'spec-end-to-end' && (item.workspace === record()?.workspace || item.workspace_id === record()?.workspace) && [record()?.package, record()?.package_ref].filter(Boolean).includes(item.spec_package)
  ).sort((a,b) => (Date.parse(b.created_at || '') || 0) - (Date.parse(a.created_at || '') || 0))[0];
  const visibleCount = () => {
    const query = (props.route.q ?? '').trim().toLowerCase();
    return props.records.filter(item =>
      (filter() === 'completed' ? item.recent_completion === true : filter() === 'planned' ? item.planned === true : !item.recent_completion && !item.planned) &&
      (!query || [item.workspace, item.package_ref, item.package, item.activity, item.obligation, item.execution, item.workflow_state].some(value => str(value).toLowerCase().includes(query))) &&
      packageFilterMatches(item, filter())
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
          <div class="list-caption">{filter() === 'completed' ? 'Done' : filter() === 'attention' ? 'Blocked' : filter() === 'planned' ? 'Planned' : 'Active'} · {visibleCount()} observed specs</div>
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
            actions={<Show when={record() && !record()?.planned}>
          <Show when={priorAssignment()} keyed fallback={<details class="section"><summary>Run spec again</summary><PlannedAssignment record={record()} live={props.live && props.specsLive} token={props.token}/></details>}>
            {assignment => <RelaunchAssignment assignment={assignment} live={props.live && props.specsLive} token={props.token}/>}
          </Show>
        </Show>}
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
              class="ds-btn"
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
