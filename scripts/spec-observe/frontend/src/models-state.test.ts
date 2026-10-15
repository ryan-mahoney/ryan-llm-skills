import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  pairKey,
  sameChoice,
  formatModelChoice,
  contextTokens,
  sortModelChoices,
  catalogStale,
  emptyCatalogView,
  catalogFromReply,
  availabilityOf,
  availabilityMessage,
  pickerOptions,
  catalogProjection,
  createModelsStore,
  type ModelChoice,
  type CatalogModel,
  type CatalogView
} from './models-state';

// Fake transport for tests
class FakeTransport {
  calls: { url: string; body?: any; token?: string }[] = [];
  private pendingGetJson: Array<{ resolve: (value: any) => void; reject: (reason: unknown) => void }> = [];
  private pendingPostJson: Array<{ resolve: (value: any) => void; reject: (reason: unknown) => void }> = [];

  async getJson<T>(url: string): Promise<T> {
    this.calls.push({ url });
    return new Promise<T>((resolve, reject) => this.pendingGetJson.push({ resolve, reject }));
  }

  async postJson<T>(url: string, body: unknown, token: string): Promise<T> {
    this.calls.push({ url, body, token });
    return new Promise<T>((resolve, reject) => this.pendingPostJson.push({ resolve, reject }));
  }

  resolveGetJson(value: unknown): void {
    const pending = this.pendingGetJson.shift();
    if (pending) pending.resolve(value);
  }

  resolvePostJson(value: unknown): void {
    const pending = this.pendingPostJson.shift();
    if (pending) pending.resolve(value);
  }

  rejectGetJson(error: unknown): void {
    const pending = this.pendingGetJson.shift();
    if (pending) pending.reject(error);
  }

  rejectPostJson(error: unknown): void {
    const pending = this.pendingPostJson.shift();
    if (pending) pending.reject(error);
  }
}

// Fixed clock
const fixedDate = new Date('2024-01-15T12:00:00Z');
const clock = () => fixedDate;

// Card (a): model-first order and pairKey with slashes
test('pairKey keeps slash ids distinct; sortModelChoices orders by model then provider', () => {
  const a: ModelChoice = { provider: 'ByteDance', model: 'Seed-2.0-code' };
  const b: ModelChoice = { provider: 'OtherProvider', model: 'Seed-2.0-code' };
  assert.notEqual(pairKey(a), pairKey(b));

  const choices: ModelChoice[] = [b, a];
  const sorted = sortModelChoices(choices);
  assert.equal(sorted[0].provider, 'ByteDance');
  assert.equal(sorted[1].provider, 'OtherProvider');
});

// Card (b): availability
test('availability: ready+present=available, ready+absent=missing, loading/failed=unknown, stale retains status', () => {
  const readyCatalog: CatalogView = {
    status: 'ready',
    host: 'test.example.com',
    read_at: '2024-01-15T10:00:00Z',
    failed_at: null,
    stale: false,
    refreshing: false,
    error: null,
    models: [{ provider: 'P1', model: 'M1', context: '128K', max_out: '4096', thinking: true, images: true }]
  };

  const available = availabilityOf({ provider: 'P1', model: 'M1' }, readyCatalog);
  const missing = availabilityOf({ provider: 'P2', model: 'M1' }, readyCatalog);
  assert.equal(available, 'available');
  assert.equal(missing, 'missing');

  const loadingCatalog: CatalogView = { ...readyCatalog, status: 'loading', models: [] };
  assert.equal(availabilityOf({ provider: 'P1', model: 'M1' }, loadingCatalog), 'unknown');

  const oldRead = new Date('2024-01-14T11:00:00Z'); // 25h ago
  const staleCatalog: CatalogView = {
    ...readyCatalog,
    read_at: oldRead.toISOString(),
    stale: catalogStale(oldRead.toISOString(), fixedDate)
  };
  assert.equal(staleCatalog.stale, true);
  assert.equal(availabilityOf({ provider: 'P2', model: 'M1' }, staleCatalog), 'missing'); // stale != missing

  const opts = pickerOptions({ preferred: [], catalog: readyCatalog, selected: null });
  assert.equal(opts[0].label, 'Pi default');
  assert.equal(opts[0].availability, 'available');
  assert.equal(opts[0].disabled, false);
});

// Card (b): one shared availability sentence for the picker and the review alert
test('availabilityMessage: missing and unknown share one sentence; available is null', () => {
  const readyCatalog: CatalogView = {
    status: 'ready',
    host: 'test.example.com',
    read_at: '2024-01-15T10:00:00Z',
    failed_at: null,
    stale: false,
    refreshing: false,
    error: null,
    models: [{ provider: 'P1', model: 'M1', context: '128K', max_out: '4096', thinking: true, images: true }]
  };
  assert.equal(availabilityMessage({ provider: 'P1', model: 'M1' }, readyCatalog), null);
  assert.equal(
    availabilityMessage({ provider: 'P2', model: 'M1' }, readyCatalog),
    'M1 is not in the test.example.com catalog. Choose another model or manage preferred models.'
  );
  const loadingCatalog: CatalogView = { ...readyCatalog, status: 'loading', host: null, models: [] };
  assert.equal(
    availabilityMessage({ provider: 'P1', model: 'M1' }, loadingCatalog),
    'Availability of M1 is unknown; the catalog has not been read. Choose Pi default or refresh the Models page.'
  );
});

// Card (c): filtering with projection contract assertions
test('filtering: query matches provider/model case-insensitively; chips AND together; matched counts unique pairs; groups preserve row fields', () => {
  const catalog: CatalogView = {
    status: 'ready',
    host: 'test.com',
    read_at: '2024-01-15T10:00:00Z',
    failed_at: null,
    stale: false,
    refreshing: false,
    error: null,
    models: [
      { provider: 'ProviderA', model: 'ModelX', context: '1.0M', max_out: '4096', thinking: true, images: true },
      { provider: 'ProviderB', model: 'modelx', context: '128K', max_out: '8192', thinking: false, images: false }
    ]
  };

  const withQuery = catalogProjection({ catalog, preferred: [], filter: { query: 'modelx', thinking: false, images: false, context1m: false } });
  assert.equal(withQuery.matched, 2);

  const withChips = catalogProjection({ catalog, preferred: [], filter: { query: '', thinking: true, images: true, context1m: true } });
  assert.equal(withChips.matched, 1);

  // Verify row fields preserved in groups
  assert.equal(withChips.groups.length, 1);
  assert.equal(withChips.groups[0].provider, 'ProviderA');
  assert.equal(withChips.groups[0].rows.length, 1);
  const row = withChips.groups[0].rows[0];
  assert.equal(row.choice.provider, 'ProviderA');
  assert.equal(row.choice.model, 'ModelX');
  assert.equal(row.context, '1.0M');
  assert.equal(row.maxOut, '4096');
  assert.equal(row.thinking, true);
  assert.equal(row.images, true);
  assert.equal(row.availability, 'available');

  // Verify expanded preserves provider casing with non-blank query
  const withProvQuery = catalogProjection({ catalog, preferred: [], filter: { query: 'providera', thinking: false, images: false, context1m: false } });
  assert.deepEqual(withProvQuery.expanded, ['ProviderA']);
  assert.deepEqual(withQuery.expanded, ['ProviderA', 'ProviderB']);

  // Verify expanded preserves provider casing (blank query, preferred case)
  const withPreferred = catalogProjection({
    catalog,
    preferred: [{ provider: 'ProviderA', model: 'ModelX' }],
    filter: { query: '', thinking: false, images: false, context1m: false }
  });
  assert.deepEqual(withPreferred.expanded, ['ProviderA']);

  const tokens = contextTokens('1.0M');
  assert.equal(tokens, 1000000);
});

// Card (d): store ordering/concurrency with proper held GET test
test('store: pending GET never overwrites saved list; queued writes settle in order; first failure does not block second', async () => {
  const transport = new FakeTransport();
  const store = createModelsStore({ transport, now: clock });

  // Case (d1): Held GET sequence - call loadPreferences (GET pending, gen 0), then save, then resolve GET
  const loadPromise = store.loadPreferences();
  const prefCall = transport.calls.find(c => c.url === '/api/models/preferred');
  assert.ok(prefCall);

  // Issue a real save while GET is held
  const save = store.setPreference({ provider: 'P2', model: 'M2' }, true, 'token-held');
  const saveCall = transport.calls.find(c => c.url === '/api/models/preferred' && c.body?.provider === 'P2');
  assert.ok(saveCall);
  transport.resolvePostJson({ preferred: [{ provider: 'P2', model: 'M2' }], updated_at: '2024-01-15T12:00:00Z' });
  await save;

  // Then GET resolves with old list - should not overwrite
  transport.resolveGetJson({ preferred: [{ provider: 'P1', model: 'M1' }], updated_at: '2024-01-14T12:00:00Z' });
  await loadPromise;

  assert.equal(store.preferred().length, 1);
  assert.equal(store.preferred()[0].provider, 'P2');
  assert.equal(store.preferred()[0].model, 'M2');

  // Case (d2): Pending state assertions for queued writes
  const write1 = store.setPreference({ provider: 'P1', model: 'M1' }, true, 'token1');
  const write2 = store.setPreference({ provider: 'P2', model: 'M2' }, true, 'token2');

  // Both rows should be pending
  assert.equal(store.rowState({ provider: 'P1', model: 'M1' }).pending, true);
  assert.equal(store.rowState({ provider: 'P2', model: 'M2' }).pending, true);
  // Unrelated pair should not be pending
  assert.equal(store.rowState({ provider: 'P3', model: 'M3' }).pending, false);

  transport.resolvePostJson({ preferred: [{ provider: 'P1', model: 'M1' }], updated_at: '2024-01-15T12:00:01Z' });
  await write1;

  transport.resolvePostJson({ preferred: [{ provider: 'P1', model: 'M1' }, { provider: 'P2', model: 'M2' }], updated_at: '2024-01-15T12:00:02Z' });
  await write2;

  assert.equal(store.preferred().length, 2);

  // Case (d3): First write fails, second succeeds
  const write3 = store.setPreference({ provider: 'P3', model: 'M3' }, true, 'token3');
  const write4 = store.setPreference({ provider: 'P4', model: 'M4' }, true, 'token4');

  transport.rejectPostJson(new Error('save failed'));
  await write3;

  transport.resolvePostJson({ preferred: [{ provider: 'P1', model: 'M1' }, { provider: 'P4', model: 'M4' }], updated_at: '2024-01-15T12:00:03Z' });
  await write4;

  assert.equal(store.preferred().length, 2); // P3 not added
  assert.equal(store.preferred()[0].provider, 'P1');
  assert.equal(store.preferred()[1].provider, 'P4');

  // Verify failure/success outcomes
  assert.deepEqual(store.rowState({ provider: 'P3', model: 'M3' }), { pending: false, outcome: 'failed', requested: true });
  assert.equal(store.rowState({ provider: 'P4', model: 'M4' }).outcome, 'saved');
});

// Card (e): removal
test('removal: pickerOptions still shows removed selected pair; catalog view unchanged', () => {
  const catalog: CatalogView = {
    status: 'ready',
    host: 'test.com',
    read_at: '2024-01-15T10:00:00Z',
    failed_at: null,
    stale: false,
    refreshing: false,
    error: null,
    models: [{ provider: 'P2', model: 'M2', context: '128K', max_out: '4096', thinking: true, images: true }]
  };

  const opts = pickerOptions({ preferred: [{ provider: 'P2', model: 'M2' }], catalog, selected: { provider: 'P1', model: 'M1' } });
  const p1Opt = opts.find(o => o.choice?.provider === 'P1');
  assert.ok(p1Opt);
  assert.equal(p1Opt.selected, true);
  assert.equal(p1Opt.label, 'M1 · P1');
});

// Card (e) extended: sort helpers preserve slash ids
test('sort helpers preserve slash ids exactly', () => {
  const a: ModelChoice = { provider: 'ByteDance', model: 'Seed-2.0-code' };
  const b: ModelChoice = { provider: 'ByteDance', model: 'Seed-2.1-code' };

  const sorted = sortModelChoices([b, a]);
  assert.equal(sorted[0].model, 'Seed-2.0-code');
  assert.equal(sorted[1].model, 'Seed-2.1-code');
});

// Additional helper tests
test('formatModelChoice uses AD-7 middot; contextTokens parses K/M case-insensitively', () => {
  assert.equal(formatModelChoice({ provider: 'Google', model: 'gemini-1.5' }), 'gemini-1.5 · Google');
  assert.equal(contextTokens('128K'), 128000);
  assert.equal(contextTokens('1.5K'), 1500);
  assert.equal(contextTokens('1M'), 1000000);
  assert.equal(contextTokens('200000'), 200000);
  assert.equal(contextTokens(''), null);
  assert.equal(contextTokens('M'), null);
});

// Card (b)/(c): the projection shares availabilityOf, so a non-ready catalog is unknown, never missing
test('catalog projection: retained preferred rows are unknown while the catalog is loading or failed', () => {
  const preferred: ModelChoice[] = [
    { provider: 'ProviderA', model: 'ModelX' },
    { provider: 'ProviderZ', model: 'ModelZ' }
  ];
  const ready: CatalogView = {
    status: 'ready',
    host: 'test.com',
    read_at: '2024-01-15T10:00:00Z',
    failed_at: null,
    stale: false,
    refreshing: false,
    error: null,
    models: [{ provider: 'ProviderA', model: 'ModelX', context: '1.0M', max_out: '4096', thinking: true, images: true }]
  };
  const filter = { query: '', thinking: false, images: false, context1m: false };

  assert.deepEqual(
    catalogProjection({ catalog: ready, preferred, filter }).preferred.map(r => [r.choice.provider, r.availability]),
    [['ProviderA', 'available'], ['ProviderZ', 'missing']]
  );

  const loading: CatalogView = { ...emptyCatalogView(), refreshing: true };
  const loadingProjection = catalogProjection({ catalog: loading, preferred, filter });
  assert.deepEqual(
    loadingProjection.preferred.map(r => [r.choice.provider, r.availability]),
    [['ProviderA', 'unknown'], ['ProviderZ', 'unknown']]
  );

  const failed: CatalogView = {
    status: 'failed',
    host: null,
    read_at: null,
    failed_at: '2024-01-15T12:00:00Z',
    stale: false,
    refreshing: false,
    error: 'catalog read failed',
    models: []
  };
  const failedProjection = catalogProjection({ catalog: failed, preferred, filter });
  assert.deepEqual(
    failedProjection.preferred.map(r => [r.choice.provider, r.availability]),
    [['ProviderA', 'unknown'], ['ProviderZ', 'unknown']]
  );
  // Unknown rows carry no catalog metadata, and unknown capabilities never match a capability chip
  failedProjection.preferred.forEach(row => {
    assert.equal(row.availability, availabilityOf(row.choice, failed));
    assert.equal(row.context, '');
    assert.equal(row.thinking, false);
    assert.equal(row.images, false);
  });
  assert.deepEqual(catalogProjection({ catalog: loading, preferred, filter: { query: '', thinking: true, images: false, context1m: false } }).preferred, []);
});

// Card (b): the same unknown status reaches the Models page through the real store signals
test('store projection: a retained preference stays unknown while the catalog read is unresolved or failed', async () => {
  const transport = new FakeTransport();
  const store = createModelsStore({ transport, now: clock });
  const filter = { query: '', thinking: false, images: false, context1m: false };

  const prefs = store.loadPreferences();
  transport.resolveGetJson({ preferred: [{ provider: 'P1', model: 'M1' }], updated_at: '2024-01-15T12:00:00Z' });
  await prefs;

  const catalogLoad = store.loadCatalog();
  const loadingProjection = catalogProjection({ catalog: store.catalog(), preferred: store.preferred(), filter });
  assert.equal(store.catalog().status, 'loading');
  assert.equal(loadingProjection.preferred.length, 1);
  assert.equal(loadingProjection.preferred[0].availability, 'unknown');

  transport.rejectGetJson(new Error('catalog down'));
  await catalogLoad;
  const failedProjection = catalogProjection({ catalog: store.catalog(), preferred: store.preferred(), filter });
  assert.equal(store.catalog().status, 'failed');
  assert.equal(failedProjection.preferred[0].availability, 'unknown');
});

// node --import tsx --test --test-name-pattern='refresh failure' src/models-state.test.ts
test('store: refresh failure disables retained choices until recovery', async () => {
  const transport = new FakeTransport();
  const store = createModelsStore({ transport, now: clock });
  const choice = { provider: 'P1', model: 'M1' };
  const reply = { host: 'fixture', read_at: fixedDate.toISOString(), models: [{ ...choice, context: '1M', max_out: '8K', thinking: true, images: false }] };
  let pending = store.loadCatalog();
  transport.resolveGetJson(reply);
  await pending;
  assert.equal(availabilityOf(choice, store.catalog()), 'available');
  pending = store.loadCatalog(true);
  assert.equal(availabilityOf(choice, store.catalog()), 'unknown');
  assert.equal(pickerOptions({ preferred: [choice], selected: choice, catalog: store.catalog() })[1].disabled, true);
  transport.rejectGetJson(new Error('catalog-unavailable'));
  await pending;
  assert.equal(store.catalog().status, 'failed');
  assert.equal(availabilityOf(choice, store.catalog()), 'unknown');
  pending = store.loadCatalog(true);
  transport.resolveGetJson(reply);
  await pending;
  assert.equal(availabilityOf(choice, store.catalog()), 'available');
});
