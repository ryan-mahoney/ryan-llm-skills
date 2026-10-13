// Fixed refusal metadata crosses HTTP only as a static reason and, for
// target-busy, one validated assignment UUID. Unrecognized reasons and
// malformed identifiers are ignored so arbitrary server text stays private.
const REFUSAL_REASONS = new Set(['stale-preview', 'request-conflict', 'target-busy', 'run-active', 'service-unavailable']);
const ASSIGNMENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class HttpError extends Error {
  constructor(public status: number, message: string, public reason?: string, public assignmentId?: string) { super(message); this.name = 'HttpError'; }
}
async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = typeof body?.reason === 'string' && REFUSAL_REASONS.has(body.reason) ? body.reason : undefined;
    const assignmentId = typeof body?.assignment_id === 'string' && ASSIGNMENT_UUID.test(body.assignment_id) ? body.assignment_id : undefined;
    throw new HttpError(response.status, typeof body?.error === 'string' ? body.error : `Request failed (${response.status}).`, reason, assignmentId);
  }
  return body as T;
}
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return readJson<T>(await fetch(url, {cache:'no-store',signal:signal ?? AbortSignal.timeout(30000)}));
}
export async function postJson<T>(url: string, body: unknown, token: string, signal?: AbortSignal): Promise<T> {
  return readJson<T>(await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Sentinel-Token':token},body:JSON.stringify(body),signal:signal ?? AbortSignal.timeout(30000)}));
}
