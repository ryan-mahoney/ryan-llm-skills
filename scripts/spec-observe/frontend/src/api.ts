import type { TerminalConnection } from './terminal-state';

// Fixed refusal metadata crosses HTTP only as a static reason and, for
// target-busy, one validated assignment UUID. Unrecognized reasons and
// malformed identifiers are ignored so arbitrary server text stays private.
const REFUSAL_REASONS = new Set(['stale-preview', 'request-conflict', 'target-busy', 'run-active', 'service-unavailable']);
// Request-route refusals cross HTTP as {error:<code>,reason:<static sentence>};
// when the sentence is not already a recognized launch code the fixed card code
// is surfaced as the reason so request panels can map refusals without echoing
// server text.
const REQUEST_REASONS = new Set(['locality', 'token', 'origin', 'mime', 'invalid-request', 'input-too-long', 'oversize', 'workspace-unavailable', 'superseded', 'request-conflict', 'interpretation-failed', 'transcription-failed', 'no-speech', 'unavailable']);
const ASSIGNMENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Terminal failures cross HTTP as one fixed state; anything else is discarded
// so arbitrary server text never reaches the panel.
const TERMINAL_STATES = new Set<string>(['not-live', 'changed', 'not-installed', 'failed', 'busy', 'not-running']);
const isTerminalState = (value: unknown): value is TerminalConnection => typeof value === 'string' && TERMINAL_STATES.has(value);
export class HttpError extends Error {
  constructor(public status: number, message: string, public reason?: string, public assignmentId?: string, public terminalState?: TerminalConnection) { super(message); this.name = 'HttpError'; }
}
async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = typeof body?.reason === 'string' && REFUSAL_REASONS.has(body.reason) ? body.reason
      : typeof body?.error === 'string' && REQUEST_REASONS.has(body.error) ? body.error : undefined;
    const assignmentId = typeof body?.assignment_id === 'string' && ASSIGNMENT_UUID.test(body.assignment_id) ? body.assignment_id : undefined;
    const terminalState = isTerminalState(body?.state) ? body.state : undefined;
    throw new HttpError(response.status, typeof body?.error === 'string' ? body.error : `Request failed (${response.status}).`, reason, assignmentId, terminalState);
  }
  return body as T;
}
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return readJson<T>(await fetch(url, {cache:'no-store',signal:signal ?? AbortSignal.timeout(30000)}));
}
export async function postJson<T>(url: string, body: unknown, token: string, signal?: AbortSignal): Promise<T> {
  return readJson<T>(await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Sentinel-Token':token},body:JSON.stringify(body),signal:signal ?? AbortSignal.timeout(30000)}));
}
export async function postAudio<T>(url: string, body: ArrayBuffer | Float32Array, token: string, signal?: AbortSignal): Promise<T> {
  // The wire body is the exact sample bytes; fetch BodyInit takes an
  // ArrayBuffer-backed payload, so a typed-array view is copied byte-for-byte.
  const payload = body instanceof Float32Array ? body.slice().buffer : body;
  return readJson<T>(await fetch(url,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Sentinel-Token':token},body:payload,signal:signal ?? AbortSignal.timeout(70000)}));
}
