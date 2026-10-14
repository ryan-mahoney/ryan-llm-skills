// Sole Next steps scan transport and lifetime owner. api.ts:getJson is the
// only transport; this module owns the request generation, abort controller,
// deadline and polling interval. A failed or invalid load retains the last
// successful scan; late or stopped generations never settle shared signals
// and no other module may fetch or poll the scan route.
import { createSignal } from 'solid-js';
import { getJson } from './api';
import type { NextStepsFileRow, NextStepsScan } from './destinations/next-steps-state';

const URL = '/api/next-steps';
const POLL_MS = 30000;
const DEADLINE_MS = 10000;

const [scan, setScan] = createSignal<NextStepsScan | null>(null);
const [scanError, setScanError] = createSignal('');
const [pending, setPending] = createSignal(false);

export { pending, scan, scanError };

// One owned lifetime: active flag, request generation, in-flight controller,
// polling interval and request deadline.
let active = false;
let generation = 0;
let controller: AbortController | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let deadline: ReturnType<typeof setTimeout> | null = null;

// Conservative wire guard: only the schema the destination understands is
// accepted, and anything else keeps the previous successful scan.
function isNextStepsScan(value: unknown): value is NextStepsScan {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const coverage = candidate.coverage;
  return candidate.schema_version === 1
    && typeof candidate.scanned_at === 'string'
    && Array.isArray(candidate.rows)
    && typeof candidate.window_ms === 'number'
    && Boolean(coverage)
    && typeof coverage === 'object'
    && typeof (coverage as Record<string, unknown>).state === 'string';
}

export async function loadNextSteps(): Promise<void> {
  if (!active) return;
  const request = ++generation;
  // A new active load aborts and replaces the older owned generation.
  if (controller) controller.abort();
  const current = new AbortController();
  controller = current;
  if (deadline !== null) clearTimeout(deadline);
  deadline = setTimeout(() => current.abort(), DEADLINE_MS);
  setPending(true);
  try {
    const value = await getJson<unknown>(URL, current.signal);
    if (request !== generation || !active) return;
    if (!isNextStepsScan(value)) {
      setScanError('Next steps scan could not be read.');
      return;
    }
    setScan(value);
    setScanError('');
  } catch {
    // Failure retains the last successful scan; superseded or stopped
    // rejections stay silent.
    if (request === generation && active) setScanError('Could not refresh next steps. Retry to reconnect.');
  } finally {
    if (request === generation) {
      if (deadline !== null) {
        clearTimeout(deadline);
        deadline = null;
      }
      setPending(false);
    }
  }
}

export function startNextStepsPolling(): void {
  if (active) return;
  active = true;
  void loadNextSteps();
  interval = setInterval(() => { void loadNextSteps(); }, POLL_MS);
}

export function stopNextStepsPolling(): void {
  active = false;
  generation += 1;
  if (controller) {
    controller.abort();
    controller = null;
  }
  if (interval !== null) {
    clearInterval(interval);
    interval = null;
  }
  if (deadline !== null) {
    clearTimeout(deadline);
    deadline = null;
  }
  setPending(false);
}

// Exact package lookup over the current scan; step 6 consumes this as the
// Inputs observation lookup.
export function nextStepsRowForPackage(packagePath: string): NextStepsFileRow | null {
  if (!packagePath) return null;
  return scan()?.rows.find(row => row.package === packagePath) ?? null;
}
