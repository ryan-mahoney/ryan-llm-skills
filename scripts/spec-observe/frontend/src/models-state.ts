import { createSignal } from 'solid-js';
import { getJson, postJson } from './api';

// Types
export type ModelChoice = { provider: string; model: string };
export type CatalogModel = { provider: string; model: string; context: string; max_out: string; thinking: boolean; images: boolean };
export type Availability = 'available' | 'missing' | 'unknown';
export type CatalogView = {
  status: 'loading' | 'ready' | 'failed';
  host: string | null;
  read_at: string | null;
  failed_at: string | null;
  stale: boolean;
  refreshing: boolean;
  error: string | null;
  models: readonly CatalogModel[];
};
export type CatalogReply = { host: string; read_at: string; providers: number; models: CatalogModel[] };
export type PreferredReply = { preferred: ModelChoice[]; updated_at: string | null };
export type CapabilityFilter = { query: string; thinking: boolean; images: boolean; context1m: boolean };
export type CatalogRow = { choice: ModelChoice; context: string; maxOut: string; thinking: boolean; images: boolean; availability: Availability };
export type CatalogGroup = { provider: string; rows: CatalogRow[] };
export type CatalogProjection = { preferred: CatalogRow[]; groups: CatalogGroup[]; matched: number; expanded: string[] };
export type PickerOption = { choice: ModelChoice | null; label: string; provider: string | null; availability: Availability; disabled: boolean; selected: boolean; preferred: boolean };
export type RowOutcome = 'saved' | 'failed';
export type RowState = { pending: boolean; outcome: RowOutcome | null; requested: boolean };
export type ModelsTransport = { getJson<T>(url: string): Promise<T>; postJson<T>(url: string, body: unknown, token: string): Promise<T> };
export type ModelsStore = {
  preferred(): ModelChoice[];
  catalog(): CatalogView;
  preferencesError(): string | null;
  rowState(choice: ModelChoice): RowState;
  loadPreferences(): Promise<void>;
  loadCatalog(refresh?: boolean): Promise<void>;
  setPreference(choice: ModelChoice, preferred: boolean, token: string): Promise<void>;
};

// Pure helpers
export function pairKey(choice: ModelChoice): string {
  return JSON.stringify([choice.provider, choice.model]);
}

export function sameChoice(a: ModelChoice | null | undefined, b: ModelChoice | null | undefined): boolean {
  if (!a || !b) return false;
  return a.provider === b.provider && a.model === b.model;
}

export function formatModelChoice(choice: ModelChoice | null | undefined, empty = 'Pi default'): string {
  if (!choice) return empty;
  return `${choice.model} · ${choice.provider}`;
}

export function contextTokens(value: string): number | null {
  if (!value) return null;
  const str = value.trim();
  const match = /^(\d+(\.\d+)?|(\d+\.\d+))(K|M)?$/i.exec(str);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const suffix = match[4];
  if (suffix === 'K') return Math.round(num * 1000);
  if (suffix === 'M') return Math.round(num * 1000000);
  if (isNaN(num)) return null;
  return Math.round(num);
}

export function compareChoices(a: ModelChoice, b: ModelChoice): number {
  const modelCmp = a.model.toLowerCase().localeCompare(b.model.toLowerCase());
  if (modelCmp !== 0) return modelCmp;
  const providerCmp = a.provider.toLowerCase().localeCompare(b.provider.toLowerCase());
  if (providerCmp !== 0) return providerCmp;
  return a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider);
}

export function sortModelChoices<T extends ModelChoice>(choices: readonly T[]): T[] {
  return [...choices].sort(compareChoices);
}

export function catalogStale(read_at: string | null, now: Date): boolean {
  if (!read_at) return false;
  const readTime = new Date(read_at).getTime();
  if (isNaN(readTime)) return false;
  const diff = now.getTime() - readTime;
  return diff > 24 * 60 * 60 * 1000;
}

export function emptyCatalogView(): CatalogView {
  return {
    status: 'loading',
    host: null,
    read_at: null,
    failed_at: null,
    stale: false,
    refreshing: true,
    error: null,
    models: []
  };
}

export function catalogFromReply(reply: CatalogReply, now: Date): CatalogView {
  const stale = catalogStale(reply.read_at, now);
  return {
    status: 'ready',
    host: reply.host,
    read_at: reply.read_at,
    failed_at: null,
    stale: stale,
    refreshing: false,
    error: null,
    models: reply.models
  };
}

export function availabilityOf(choice: ModelChoice, catalog: CatalogView): Availability {
  if (catalog.status !== 'ready') return 'unknown';
  const key = pairKey(choice);
  const found = catalog.models.some(m => pairKey(m) === key);
  return found ? 'available' : 'missing';
}

// Single owner for the user-facing availability explanation, shared by the
// picker's inline error and the launch review's model alert so one condition
// cannot render two different sentences. Null means the pair is usable.
export function availabilityMessage(choice: ModelChoice, catalog: CatalogView): string | null {
  const state = availabilityOf(choice, catalog);
  if (state === 'missing') {
    return `${choice.model} is not in the ${catalog.host ?? 'catalog'} catalog. Choose another model or manage preferred models.`;
  }
  if (state === 'unknown') {
    return `Availability of ${choice.model} is unknown; the catalog has not been read. Choose Pi default or refresh the Models page.`;
  }
  return null;
}

export function pickerOptions(params: { preferred: ModelChoice[]; catalog: CatalogView; selected: ModelChoice | null }): PickerOption[] {
  const { preferred, catalog, selected } = params;
  const options: PickerOption[] = [];

  // Pi default first
  options.push({
    choice: null,
    label: 'Pi default',
    provider: null,
    availability: 'available',
    disabled: false,
    selected: selected === null,
    preferred: false
  });

  // Collect unique pairs from preferred plus selected if not in preferred
  const seen = new Set<string>();
  const collected: ModelChoice[] = [];

  preferred.forEach(p => {
    const key = pairKey(p);
    if (!seen.has(key)) {
      seen.add(key);
      collected.push(p);
    }
  });

  if (selected && !preferred.some(p => sameChoice(p, selected))) {
    const key = pairKey(selected);
    if (!seen.has(key)) {
      seen.add(key);
      collected.push(selected);
    }
  }

  // Sort
  const sorted = sortModelChoices(collected);

  // Build options
  sorted.forEach(choice => {
    const avail = availabilityOf(choice, catalog);
    options.push({
      choice: choice,
      label: formatModelChoice(choice),
      provider: choice.provider,
      availability: avail,
      disabled: avail !== 'available',
      selected: sameChoice(choice, selected),
      preferred: preferred.some(p => sameChoice(p, choice))
    });
  });

  return options;
}

export function catalogProjection(params: { catalog: CatalogView; preferred: ModelChoice[]; filter: CapabilityFilter }): CatalogProjection {
  const { catalog, preferred, filter } = params;
  const { query, thinking, images, context1m } = filter;

  // Filter helper
  function matchesRow(row: CatalogModel): boolean {
    const q = query.toLowerCase();
    const matchesQuery = !q || row.provider.toLowerCase().includes(q) || row.model.toLowerCase().includes(q);
    if (!matchesQuery) return false;

    if (thinking && !row.thinking) return false;
    if (images && !row.images) return false;
    if (context1m) {
      const tokens = contextTokens(row.context);
      if (tokens === null || tokens < 1_000_000) return false;
    }
    return true;
  }

  // Catalog groups
  const catalogPairs = new Set<string>();
  const grouped: Record<string, CatalogRow[]> = {};
  catalog.models.forEach(m => {
    if (matchesRow(m)) {
      const key = pairKey(m);
      catalogPairs.add(key);
      if (!grouped[m.provider]) {
        grouped[m.provider] = [];
      }
      grouped[m.provider].push({
        choice: { provider: m.provider, model: m.model },
        context: m.context,
        maxOut: m.max_out,
        thinking: m.thinking,
        images: m.images,
        availability: 'available'
      });
    }
  });

  const groups: CatalogGroup[] = Object.entries(grouped)
    .map(([provider, rows]) => ({ provider, rows: [...rows].sort((a, b) => compareChoices(a.choice, b.choice)) }))
    .sort((a, b) => a.provider.toLowerCase().localeCompare(b.provider.toLowerCase()));

  // Preferred section
  const preferredRows: CatalogRow[] = [];
  preferred.forEach(p => {
    const key = pairKey(p);
    const found = catalog.models.find(m => pairKey(m) === key);
    const availability = availabilityOf(p, catalog);
    if (found) {
      if (matchesRow(found)) {
        preferredRows.push({
          choice: p,
          context: found.context,
          maxOut: found.max_out,
          thinking: found.thinking,
          images: found.images,
          availability: availability
        });
      }
    } else {
      // Not found in a successful read: 'missing' when the catalog is ready,
      // 'unknown' while it is pending or has no successful read
      const q = query.toLowerCase();
      const qMatches = !q || p.provider.toLowerCase().includes(q) || p.model.toLowerCase().includes(q);
      if (qMatches && !thinking && !images && !context1m) {
        preferredRows.push({
          choice: p,
          context: '',
          maxOut: '',
          thinking: false,
          images: false,
          availability: availability
        });
      }
    }
  });

  const sortedPreferred = sortModelChoices(preferredRows.map(r => r.choice))
    .map((choice): CatalogRow => {
      const found = catalog.models.find(m => pairKey(m) === pairKey(choice));
      const availability = availabilityOf(choice, catalog);
      if (found) {
        return {
          choice,
          context: found.context,
          maxOut: found.max_out,
          thinking: found.thinking,
          images: found.images,
          availability: availability
        };
      } else {
        return {
          choice,
          context: '',
          maxOut: '',
          thinking: false,
          images: false,
          availability: availability
        };
      }
    });

  // Expanded providers
  const expandedSet = new Set<string>();
  if (query.trim()) {
    groups.forEach(g => {
      if (g.rows.length > 0) {
        expandedSet.add(g.provider);
      }
    });
  } else {
    preferred.forEach(p => {
      expandedSet.add(p.provider);
    });
  }
  const expanded = sortModelChoices(Array.from(expandedSet).map(p => ({ provider: p, model: '' })))
    .map(r => r.provider);

  return {
    preferred: sortedPreferred,
    groups: groups.filter(g => g.rows.length > 0),
    matched: catalogPairs.size,
    expanded: expanded
  };
}

// Store factory
export function createModelsStore(options?: { transport?: ModelsTransport; now?: () => Date }): ModelsStore {
  const transport = options?.transport ?? { getJson, postJson };
  const now = options?.now ?? (() => new Date());

  const [preferred, setPreferred] = createSignal<ModelChoice[]>([]);
  const [catalog, setCatalog] = createSignal<CatalogView>(emptyCatalogView());
  const [preferencesError, setPreferencesError] = createSignal<string | null>(null);
  const [rowStates, setRowStates] = createSignal<Map<string, RowState>>(new Map());

  let loadPrefsPromise: Promise<void> | null = null;
  let loadCatalogPromise: Promise<void> | null = null;
  let preferenceGen = 0;
  let saveQueue: Array<{ choice: ModelChoice; preferred: boolean; token: string; resolve: (value: void) => void }> = [];
  let saveProcessing = false;

  function processSaveQueue() {
    if (saveProcessing || saveQueue.length === 0) return;
    saveProcessing = true;

    const next = saveQueue.shift()!;
    const { choice, preferred: pref, token } = next;

    const key = pairKey(choice);
    setRowStates(prev => {
      const m = new Map(prev);
      m.set(key, { pending: true, outcome: null, requested: pref });
      return m;
    });

    transport.postJson<{ preferred: ModelChoice[]; updated_at: string | null }>(
      '/api/models/preferred',
      { provider: choice.provider, model: choice.model, preferred: pref },
      token
    ).then(result => {
      preferenceGen++;
      setPreferred(result.preferred);
      setRowStates(prev => {
        const m = new Map(prev);
        m.set(key, { pending: false, outcome: 'saved', requested: pref });
        return m;
      });
      next.resolve();
      saveProcessing = false;
      processSaveQueue();
    }).catch(() => {
      setRowStates(prev => {
        const m = new Map(prev);
        m.set(key, { pending: false, outcome: 'failed', requested: pref });
        return m;
      });
      next.resolve();
      saveProcessing = false;
      processSaveQueue();
    });
  }

  function loadPreferences(): Promise<void> {
    if (loadPrefsPromise) return loadPrefsPromise;

    const genBefore = preferenceGen;
    loadPrefsPromise = transport.getJson<{ preferred: ModelChoice[]; updated_at: string | null }>('/api/models/preferred')
      .then(result => {
        if (preferenceGen === genBefore) {
          setPreferred(result.preferred);
          setPreferencesError(null);
        }
      })
      .catch(err => {
        setPreferencesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        loadPrefsPromise = null;
      });

    return loadPrefsPromise;
  }

  function loadCatalog(refresh = false): Promise<void> {
    if (loadCatalogPromise) return loadCatalogPromise;

    const currentCatalog = catalog();
    setCatalog({ ...currentCatalog, status: 'loading', refreshing: true, error: null });

    const url = refresh ? '/api/models/catalog?refresh=1' : '/api/models/catalog';
    loadCatalogPromise = transport.getJson<CatalogReply>(url)
      .then(result => {
        setCatalog(catalogFromReply(result, now()));
      })
      .catch(err => {
        setCatalog(prev => ({
          ...prev,
          status: 'failed',
          failed_at: now().toISOString(),
          refreshing: false,
          error: err instanceof Error ? err.message : String(err)
        }));
      })
      .finally(() => {
        loadCatalogPromise = null;
      });

    return loadCatalogPromise;
  }

  function setPreference(choice: ModelChoice, pref: boolean, token: string): Promise<void> {
    return new Promise(resolve => {
      const key = pairKey(choice);
      setRowStates(prev => {
        const m = new Map(prev);
        m.set(key, { pending: true, outcome: null, requested: pref });
        return m;
      });
      saveQueue.push({ choice, preferred: pref, token, resolve });
      processSaveQueue();
    });
  }

  function rowState(choice: ModelChoice): RowState {
    const key = pairKey(choice);
    const state = rowStates().get(key);
    return state ?? { pending: false, outcome: null, requested: false };
  }

  return {
    preferred,
    catalog,
    preferencesError,
    rowState,
    loadPreferences,
    loadCatalog,
    setPreference
  };
}

// Default instance
const modelsStore = createModelsStore();

export const {
  preferred,
  catalog,
  preferencesError,
  rowState,
  loadPreferences,
  loadCatalog,
  setPreference
} = modelsStore;

export default modelsStore;
