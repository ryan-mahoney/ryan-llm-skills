import { For, Show, createSignal, createMemo, createEffect, onMount, onCleanup, type JSX } from 'solid-js';
import type { DestinationProps } from './index';
import type {
  ModelChoice,
  CatalogView,
  CatalogProjection,
  CapabilityFilter,
  CatalogRow,
  CatalogGroup
} from '../models-state';
import {
  catalogProjection,
  pairKey,
  sameChoice,
  availabilityOf
} from '../models-state';
import {
  preferred,
  catalog,
  preferencesError,
  rowState,
  loadPreferences,
  loadCatalog,
  setPreference
} from '../models-state';
import { StateNotice, RegionalSkeleton } from '../primitives';

export default function ModelsDestination(props: DestinationProps) {
  const [query, setQuery] = createSignal<string>(props.route.q ?? '');
  const [thinking, setThinking] = createSignal(false);
  const [images, setImages] = createSignal(false);
  const [context1m, setContext1m] = createSignal(false);
  const [providerOverrides, setProviderOverrides] = createSignal<Record<string, boolean>>({});
  const [prefsLoaded, setPrefsLoaded] = createSignal(false);

  const filter = (): CapabilityFilter => ({
    query: query(),
    thinking: thinking(),
    images: images(),
    context1m: context1m()
  });

  const projection = createMemo<CatalogProjection>(() =>
    catalogProjection({ catalog: catalog(), preferred: preferred(), filter: filter() })
  );

  const providerCount = () => new Set(catalog().models.map(m => m.provider)).size;
  const matchedCount = () => projection().matched;
  const preferredRows = () => projection().preferred;
  const groups = () => projection().groups;

  const isPreferred = (choice: ModelChoice) => preferred().some(c => sameChoice(c, choice));

  const canMutate = () =>
    props.live &&
    !props.connectionFailed &&
    !!props.token &&
    preferencesError() === null &&
    prefsLoaded();

  const hasActiveFilter = () =>
    query() !== '' || thinking() || images() || context1m();

  const formatTime = (ts: string | null) => {
    if (!ts) return '--:--';
    const d = new Date(ts);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${hh}:${mm}`;
  };

  const retryFailed = (row: CatalogRow) => {
    const state = rowState(row.choice);
    if (canMutate() && props.token && state.requested !== undefined) {
      setPreference(row.choice, state.requested, props.token);
    }
  };

  const removeMissing = (row: CatalogRow) => {
    if (canMutate() && props.token) {
      setPreference(row.choice, false, props.token);
    }
  };

  const clearFilters = () => {
    setQuery('');
    props.onQuery('');
    setThinking(false);
    setImages(false);
    setContext1m(false);
  };

  const qLower = () => query().toLowerCase();

  const highlightMatch = (text: string): JSX.Element => {
    const q = qLower();
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark>{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    );
  };

  const rowKey = (row: CatalogRow) => pairKey(row.choice);

  // Failed-row scroll without focus transfer
  createEffect(() => {
    const allRows: CatalogRow[] = [...preferredRows(), ...groups().flatMap(g => g.rows)];
    const failedRow = allRows.find(r => rowState(r.choice).outcome === 'failed');
    if (failedRow) {
      const key = rowKey(failedRow);
      const frame = requestAnimationFrame(() => {
        document.querySelector(`[data-error-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
      });
      onCleanup(() => cancelAnimationFrame(frame));
    }
  });

  // Sync local query with route query
  createEffect(() => {
    setQuery(props.route.q ?? '');
  });

  // Load data on mount and when live
  createEffect(() => {
    if (props.live && !props.connectionFailed) {
      loadPreferences().finally(() => setPrefsLoaded(true));
      loadCatalog();
    }
  });

  const chipButton = (label: string, pressed: boolean, setter: (val: boolean) => void): JSX.Element => (
    <button
      type="button"
      class="chip"
      aria-pressed={pressed}
      disabled={catalog().status !== 'ready'}
      onClick={() => setter(!pressed)}
    >
      {label}
    </button>
  );

  const renderRowCells = (row: CatalogRow, providerColumn: boolean) => {
    const isPreferredNow = () => isPreferred(row.choice);
    const state = () => rowState(row.choice);
    const isMissing = row.availability === 'missing';
    // Keep the switch on the attempted value while the write is in flight and
    // fall back to the confirmed preference on completion, so a failed save
    // visibly reverts instead of leaving the browser's toggled state.
    const displayedChecked = () => {
      const s = state();
      return s.pending ? s.requested : isPreferredNow();
    };

    return (
      <>
        <td class="mname">
          {highlightMatch(row.choice.model)}
        </td>
        {providerColumn && <td class="prov">{row.choice.provider}</td>}
        <td class="numeric">{row.context || '-'}</td>
        <td class="numeric">{row.maxOut || '-'}</td>
        <td class="cap">{row.thinking ? 'Yes' : <span aria-label="No">—</span>}</td>
        <td class="cap">{row.images ? 'Yes' : <span aria-label="No">—</span>}</td>
      <td class="prefcell">
        <Show when={state().outcome === 'saved'}>
          <span class="saved">{isPreferredNow() ? 'Saved · preferred' : 'Saved · removed'}</span>
        </Show>
        <Show when={isMissing}>
          <span style="font-size:12px;color:var(--ds-muted)">Not in {catalog().host ?? 'this host'} catalog</span>
          <button
            class="ds-btn"
            type="button"
            style="margin-left:8px;font-size:12px"
            disabled={!canMutate()}
            onClick={() => removeMissing(row)}
          >
            Remove preference
          </button>
        </Show>
        <Show when={!isMissing}>
          <label class="switch-wrap">
            <input
              type="checkbox"
              role="switch"
              class="switch"
              aria-label={`Preferred: ${row.choice.model} via ${row.choice.provider}`}
              checked={displayedChecked()}
              onClick={() => { if (props.token && !state().pending && canMutate()) setPreference(row.choice, !isPreferredNow(), props.token); }}
              disabled={state().pending || !canMutate() || (!isPreferredNow() && row.availability !== 'available')}
            />
          </label>
        </Show>
      </td>
      </>
    );
  };

  const renderRow = (row: CatalogRow, providerColumn: boolean): JSX.Element => {
    const key = rowKey(row);
    const state = () => rowState(row.choice);
    return (
      <>
        <tr data-row-key={key}>
          {renderRowCells(row, providerColumn)}
        </tr>
        <Show when={state().outcome === 'failed'}>
          <tr class="row-error" data-error-key={key}>
            <td colspan={providerColumn ? 7 : 6}>
              <div class="ds-callout error" role="alert">
                <div>
                  <strong>Change reverted</strong>
                  <p>The save failed. Retry to apply the attempted change.</p>
                </div>
                <button
                  class="ds-btn"
                  type="button"
                  disabled={!canMutate()}
                  onClick={() => retryFailed(row)}
                >
                  Retry
                </button>
              </div>
            </td>
          </tr>
        </Show>
      </>
    );
  };

  const providerRows = (group: CatalogGroup): JSX.Element => (
    <div class="table-wrap">
      <table class="mtable">
        <thead>
          <tr>
            <th class="c-model">Model</th>
            <th class="c-ctx">Context</th>
            <th class="c-out">Max out</th>
            <th class="c-cap">Thinking</th>
            <th class="c-cap">Images</th>
            <th class="c-pref">Preferred</th>
          </tr>
        </thead>
        <tbody>
          <For each={group.rows}>{row => renderRow(row, false)}</For>
        </tbody>
      </table>
    </div>
  );

  const providerDetails = (group: CatalogGroup): JSX.Element => {
    const providerKey = group.provider;
    const expanded = () => hasActiveFilter() || (providerOverrides()[providerKey] ?? projection().expanded.includes(providerKey));
    const preferredCount = preferred().filter(p => p.provider === providerKey).length;

    return (
      <details open={expanded()} class="prov-group">
        <summary onClick={e => {
          e.preventDefault();
          if (!hasActiveFilter()) setProviderOverrides(prev => ({ ...prev, [providerKey]: !expanded() }));
        }}>
          <span class="pname">{group.provider}</span>
          <span class="pcount">{group.rows.length} {group.rows.length === 1 ? 'model' : 'models'}{hasActiveFilter() ? ' match' : ''}</span>
          <Show when={preferredCount > 0}>
            <span class="ppref">{preferredCount} preferred</span>
          </Show>
        </summary>
        <Show when={expanded()}>{providerRows(group)}</Show>
      </details>
    );
  };

  const renderPreferredTable = (): JSX.Element => (
    <table class="mtable">
      <thead>
        <tr>
          <th class="c-model">Model</th>
          <th class="c-prov">Provider</th>
          <th class="c-ctx">Context</th>
          <th class="c-out">Max out</th>
          <th class="c-cap">Thinking</th>
          <th class="c-cap">Images</th>
          <th class="c-pref">Preferred</th>
        </tr>
      </thead>
      <tbody>
        <For each={preferredRows()}>{row => renderRow(row, true)}</For>
      </tbody>
    </table>
  );

  return (
    <div class="full-page">
      <div class="ms">
        <Show when={catalog().status === 'failed' && preferencesError() === null}>
          <StateNotice tone="error" title="Catalog not read.">
            Availability is unknown until the catalog is read.
            <button
              class="ds-btn"
              type="button"
              onClick={() => loadCatalog(true)}
              disabled={catalog().refreshing}
              aria-busy={catalog().refreshing}
            >
              Retry catalog
            </button>
          </StateNotice>
        </Show>

        <div class="ms-toolbar">
          <input
            id="find-model"
            class="ds-input"
            type="search"
            disabled={catalog().status !== 'ready'}
            placeholder="Find model or provider"
            value={query()}
            onInput={(e) => { setQuery(e.currentTarget.value); props.onQuery(e.currentTarget.value); }}
          />
          {chipButton('Thinking', thinking(), setThinking)}
          {chipButton('Images', images(), setImages)}
          {chipButton('Context 1M+', context1m(), setContext1m)}
        </div>

        <p class="ms-meta" id="catalog-meta">
          <Show when={catalog().read_at} fallback="No catalog read in this session">
            <Show when={hasActiveFilter()} fallback={<><strong>{catalog().models.length} models</strong> from <strong>{providerCount()} providers</strong> on <strong>{catalog().host}</strong></>}>
              <strong>{matchedCount()} models</strong> in <strong>{groups().length} providers</strong> match{query() ? ` “${query()}”` : ' these filters'}
            </Show> · catalog read <strong>{formatTime(catalog().read_at)}</strong>
          </Show>
        </p>

        <Show when={preferencesError() !== null}>
          <StateNotice tone="error" title="Preferred models could not be read.">
            <button
              class="ds-btn"
              type="button"
              onClick={() => loadPreferences()}
            >
              Retry preferences
            </button>
          </StateNotice>
        </Show>

        <Show when={catalog().status === 'ready' && catalog().stale}>
          <div class="banner">
            Catalog read more than 24 hours ago
            <button
              class="ds-btn"
              type="button"
              onClick={() => loadCatalog(true)}
            >
              Refresh catalog
            </button>
          </div>
        </Show>

        <Show when={props.live && !props.connectionFailed && !props.token && preferencesError() === null && catalog().status !== 'failed'}>
          <div class="banner">
            Preferences can be viewed but not changed on this connection.
          </div>
        </Show>

        <Show when={props.connectionFailed || !props.live}>
          <StateNotice title="Connection unavailable.">
            <button
              class="ds-btn"
              type="button"
              onClick={() => props.onRetryConnection()}
            >
              Retry connection
            </button>
          </StateNotice>
        </Show>

        <Show when={hasActiveFilter() && matchedCount() === 0}>
          <div class="empty-inline">
            <div><strong>No models match this search.</strong><p>Try clearing your filters to see all available models.</p></div>
            <button class="ds-btn" type="button" onClick={clearFilters}>Clear search</button>
          </div>
        </Show>

        <Show when={!hasActiveFilter() || preferredRows().length > 0}>
          <section class="ms-section">
            <div class="section-heading">
              <h2>Preferred · {preferredRows().length}{hasActiveFilter() ? ' match' : ''}</h2>
              <span class="muted">Offered in thread and assignment pickers, A–Z</span>
            </div>
            <Show when={catalog().status !== 'ready'}>
              <div class="ds-callout" role="status">Availability unknown until the catalog is read.</div>
            </Show>
            <Show when={prefsLoaded() && preferencesError() === null && preferred().length === 0 && !hasActiveFilter()} fallback={renderPreferredTable()}>
              <div class="empty-inline">
                <div><strong>No preferred models yet</strong><p>Thread and assignment pickers offer only Pi default. Find a model to add it here.</p></div>
                <button class="ds-btn" type="button" disabled={catalog().status !== 'ready'} onClick={() => document.getElementById('find-model')?.focus()}>Find model</button>
              </div>
            </Show>
          </section>
        </Show>

        <section class="ms-section">
          <div class="section-heading">
            <h2>{hasActiveFilter() ? 'Matching providers' : 'All providers'} · {hasActiveFilter() ? groups().length : providerCount()}</h2>
            <span class="muted">Alphabetical</span>
          </div>
          <Show when={catalog().status === 'loading'}>
            <RegionalSkeleton variant="table" rows={3} />
          </Show>
          <Show when={catalog().status !== 'loading'}>
            <For each={groups()}>{group => providerDetails(group)}</For>
          </Show>
        </section>
      </div>
    </div>
  );
}
