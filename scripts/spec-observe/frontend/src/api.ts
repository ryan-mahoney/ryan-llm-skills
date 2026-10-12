export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'HttpError'; }
}
async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new HttpError(response.status, typeof body?.error === 'string' ? body.error : `Request failed (${response.status}).`);
  return body as T;
}
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return readJson<T>(await fetch(url, {cache:'no-store',signal:signal ?? AbortSignal.timeout(30000)}));
}
export async function postJson<T>(url: string, body: unknown, token: string, signal?: AbortSignal): Promise<T> {
  return readJson<T>(await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Sentinel-Token':token},body:JSON.stringify(body),signal:signal ?? AbortSignal.timeout(30000)}));
}
