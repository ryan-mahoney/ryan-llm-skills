// Step 4 focused lifecycle cases for the Next steps scan store. Every case
// runs the real api.ts decoding over a scoped fake fetch returning real
// Response objects, and hand-recorded global scheduling so the cadence and the
// 10-second deadline fire without real waits. Cases share one module instance,
// arrange their own prior state through public calls, and leave the store
// stopped; fetch and timer fakes are restored by the case-owned cleanup.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import type { NextStepsFileRow, NextStepsScan } from './destinations/next-steps-state';
import {
  loadNextSteps,
  nextStepsRowForPackage,
  pending,
  scan,
  scanError,
  startNextStepsPolling,
  stopNextStepsPolling,
} from './next-steps-store';

const ISO_A = '2026-02-01T00:00:00.000Z';
const ISO_B = '2026-02-01T00:01:00.000Z';
const ISO_LATE = '2026-02-01T00:02:00.000Z';
const PACKAGE_A = '/store/alpha/specs/shared';
const PACKAGE_B = '/store/alpha/specs/fresh';

const row = (packagePath: string, writtenAt: string): NextStepsFileRow => ({
  key: `${packagePath}:${writtenAt}`,
  kind: 'package',
  workspace_id: 'ws-alpha',
  workspace: 'alpha-dir',
  workspace_name: 'Alpha',
  slug: 'shared',
  package: packagePath,
  stage: 'proposal',
  file: 'proposal.md',
  path: 'specs/shared/proposal.md',
  written_at: writtenAt,
  observed_files: [{ name: 'proposal.md', stage: 'proposal', written_at: writtenAt }],
  signal: { state: 'ok' },
});

const scanOf = (scannedAt: string, packagePath: string): NextStepsScan => ({
  schema_version: 1,
  scanned_at: scannedAt,
  window_ms: 604800000,
  coverage: { state: 'complete', reasons: [], workspaces: { read: 1, total: 1 }, unread: [] },
  rows: [row(packagePath, scannedAt)],
});

const SCAN_A = scanOf(ISO_A, PACKAGE_A);
const SCAN_B = scanOf(ISO_B, PACKAGE_B);
const SCAN_LATE = scanOf(ISO_LATE, PACKAGE_A);

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

// Deterministic microtask drain: fetch resolution, real Response.json()
// decoding and the store continuation settle without touching timers.
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
};

type FetchCall = {
  url: string;
  init: RequestInit;
  signal: AbortSignal | undefined;
  respond: (response: Response) => void;
};

type FetchHarness = { calls: FetchCall[]; rejectOnAbort: boolean };

// Scoped fetch capture: each call stays pending until the case responds, so a
// superseded request can be resolved late; when rejectOnAbort is set the
// pending promise rejects on the request signal abort like real fetch.
function installFetchCapture(rejectOnAbort: boolean): FetchHarness {
  const harness: FetchHarness = { calls: [], rejectOnAbort };
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
    const signal = init.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        action();
      };
      if (signal) {
        signal.addEventListener('abort', () => {
          if (harness.rejectOnAbort) settle(() => reject(new DOMException('The operation was aborted.', 'AbortError')));
        });
      }
      harness.calls.push({
        url: String(input),
        init,
        signal,
        respond: response => settle(() => resolve(response)),
      });
    });
  }) as typeof fetch;
  return harness;
}

type CapturedTimer = {
  id: number;
  delay: number;
  repeat: boolean;
  callback: () => void;
  cancelled: boolean;
};

type TimerHarness = {
  timers: CapturedTimer[];
  pending: (repeat?: boolean) => CapturedTimer[];
  fire: (timer: CapturedTimer) => void;
};

// Hand-recorded scheduling: deadlines and cadence are observed by inspecting
// and firing the store's own timers, never by waiting.
function installTimerCapture(): TimerHarness {
  let nextId = 1;
  const timers: CapturedTimer[] = [];
  const record = (callback: unknown, delay: unknown, repeat: boolean): number => {
    const id = nextId;
    nextId += 1;
    timers.push({
      id,
      delay: Number(delay) || 0,
      repeat,
      callback: typeof callback === 'function' ? callback as () => void : () => {},
      cancelled: false,
    });
    return id;
  };
  const cancel = (handle: unknown): void => {
    const id = typeof handle === 'number' ? handle : Number(handle);
    const found = timers.find(timer => timer.id === id);
    if (found) found.cancelled = true;
  };
  globalThis.setTimeout = ((callback: unknown, delay?: number) => record(callback, delay, false)) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: unknown) => cancel(handle)) as unknown as typeof clearTimeout;
  globalThis.setInterval = ((callback: unknown, delay?: number) => record(callback, delay, true)) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle?: unknown) => cancel(handle)) as unknown as typeof clearInterval;
  return {
    timers,
    pending: repeat => timers.filter(timer => !timer.cancelled && (repeat === undefined || timer.repeat === repeat)),
    fire: timer => { if (!timer.cancelled) timer.callback(); },
  };
}

type RuntimeHarness = { fetch: FetchHarness; timers: TimerHarness };

function scopeRuntime(t: TestContext, options: { rejectOnAbort?: boolean } = {}): RuntimeHarness {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const fetcher = installFetchCapture(options.rejectOnAbort === true);
  const timers = installTimerCapture();
  t.after(() => {
    stopNextStepsPolling();
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });
  return { fetch: fetcher, timers };
}

test('loadNextSteps accepts a valid scan through the real decoder and rejects a superseded older response', async (t) => {
  const { fetch: fetcher } = scopeRuntime(t);
  startNextStepsPolling();
  assert.equal(fetcher.calls.length, 1);
  const first = fetcher.calls[0];
  const secondLoad = loadNextSteps();
  assert.equal(fetcher.calls.length, 2);
  const second = fetcher.calls[1];
  assert.equal(first.signal?.aborted, true, 'the newer load aborts the older owned request');
  second.respond(jsonResponse(200, SCAN_B));
  await secondLoad;
  assert.deepEqual(scan(), SCAN_B);
  assert.equal(nextStepsRowForPackage(PACKAGE_B)?.key, SCAN_B.rows[0].key, 'the current scan resolves its package row');
  assert.equal(nextStepsRowForPackage('/store/missing/specs/pkg'), null);
  assert.equal(nextStepsRowForPackage(''), null);
  first.respond(jsonResponse(200, SCAN_A));
  await flush();
  assert.deepEqual(scan(), SCAN_B, 'a superseded response after abort never replaces the newer scan');
  stopNextStepsPolling();
  const called = fetcher.calls.length;
  await loadNextSteps();
  assert.equal(fetcher.calls.length, called, 'a stopped store performs no fetch');
});

test('repeated start owns one timer and stop aborts and invalidates the pending request', async (t) => {
  const { fetch: fetcher, timers } = scopeRuntime(t);
  startNextStepsPolling();
  startNextStepsPolling();
  const intervals = timers.pending(true);
  assert.equal(intervals.length, 1, 'repeated start owns exactly one interval');
  assert.equal(intervals[0].delay, 30000);
  assert.equal(fetcher.calls.length, 1, 'start fetches immediately');
  const inFlight = fetcher.calls[0];
  stopNextStepsPolling();
  assert.equal(intervals[0].cancelled, true, 'stop clears the owned interval');
  assert.equal(inFlight.signal?.aborted, true, 'stop aborts the in-flight request');
  assert.equal(pending(), false);
  const before = { scan: scan(), error: scanError(), pending: pending() };
  inFlight.respond(jsonResponse(200, SCAN_LATE));
  await flush();
  assert.deepEqual(scan(), before.scan, 'a response after stop never settles the scan');
  assert.equal(scanError(), before.error);
  assert.equal(pending(), before.pending);
});

test('App live/import/unmount ownership invokes the scan store and keeps its state refresh cadence', (t) => {
  t.after(() => stopNextStepsPolling());
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
  assert.match(source, /import \{ startNextStepsPolling, stopNextStepsPolling \} from '\.\/next-steps-store';/);
  assert.match(source, /createEffect\(\(\) => \{\s*if \(live\(\)\) startNextStepsPolling\(\);\s*else stopNextStepsPolling\(\);\s*\}\);/);
  assert.match(source, /async function importSnapshot[\s\S]*?workspaceGeneration\+\+;\s*stopNextStepsPolling\(\);/, 'import stops the live scan owner');
  assert.match(source, /onMount\(\(\) => \{[\s\S]*?stateGeneration\+\+;\s*catalogGeneration\+\+;\s*workspaceGeneration\+\+;\s*stopNextStepsPolling\(\);/, 'unmount cleanup stops the live scan owner');
  assert.match(source, /let stateGeneration = 0, catalogGeneration = 0, workspaceGeneration = 0;/);
  assert.match(source, /const poll = setInterval\(\(\) => \{\s*void refresh\(\);\s*if \(live\(\)\) void loadCatalog\(\);\s*\}, 5000\);/);
});

test('failure retains the last successful scan, invalid schema is an error, and the 10-second deadline aborts without a real wait', async (t) => {
  const { fetch: fetcher, timers } = scopeRuntime(t, { rejectOnAbort: true });
  startNextStepsPolling();
  fetcher.calls[0].respond(jsonResponse(200, SCAN_A));
  await flush();
  assert.deepEqual(scan(), SCAN_A);

  const failed = loadNextSteps();
  fetcher.calls[fetcher.calls.length - 1].respond(jsonResponse(500, { error: 'No scan' }));
  await failed;
  assert.deepEqual(scan(), SCAN_A, 'a failed fetch retains the last successful scan');
  assert.notEqual(scanError(), '');
  assert.equal(pending(), false);

  const invalid = loadNextSteps();
  fetcher.calls[fetcher.calls.length - 1].respond(jsonResponse(200, { schema_version: 2, scanned_at: ISO_LATE, window_ms: 1, coverage: { state: 'complete' }, rows: [] }));
  await invalid;
  assert.deepEqual(scan(), SCAN_A, 'an invalid schema retains the last successful scan');
  assert.notEqual(scanError(), '');

  const aborted = loadNextSteps();
  const abortCall = fetcher.calls[fetcher.calls.length - 1];
  const deadline = timers.pending(false).find(timer => timer.delay === 10000);
  assert.ok(deadline, 'each load owns a 10000 ms deadline');
  deadline.callback();
  await aborted;
  assert.equal(abortCall.signal?.aborted, true, 'the deadline aborts the owned request');
  assert.deepEqual(scan(), SCAN_A);
  assert.notEqual(scanError(), '');
  assert.equal(pending(), false);
});

test('live start fetches immediately and on cadence while stopped ownership neither fetches nor settles late data', async (t) => {
  const { fetch: fetcher, timers } = scopeRuntime(t);
  startNextStepsPolling();
  assert.equal(fetcher.calls.length, 1, 'start fetches immediately');
  const interval = timers.pending(true)[0];
  assert.ok(interval, 'start owns one interval');
  assert.equal(interval.delay, 30000);
  timers.fire(interval);
  await flush();
  assert.equal(fetcher.calls.length, 2, 'the owned interval fetches again on cadence');
  const inFlight = fetcher.calls[1];
  stopNextStepsPolling();
  assert.equal(timers.pending(true).length, 0, 'stop clears the owned interval');
  const before = { scan: scan(), error: scanError(), pending: pending() };
  inFlight.respond(jsonResponse(200, SCAN_LATE));
  await flush();
  assert.deepEqual(scan(), before.scan);
  assert.equal(scanError(), before.error);
  assert.equal(pending(), before.pending);
  await loadNextSteps();
  assert.equal(fetcher.calls.length, 2, 'a stopped store performs no fetch');
});
