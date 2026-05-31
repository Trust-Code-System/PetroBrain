/**
 * Thin wrappers around the B7 ``/calc`` endpoints. The field never does
 * the arithmetic - the backend always rounds and returns the working.
 */
import type { CalcCatalogEntry, CalcResponse } from './types.js';
import type { CalcRequestBody } from './request.js';

export type { CalcRequestBody };

interface ReqOpts {
  baseUrl: string;
  token: string;
  signal?: AbortSignal;
}

export async function fetchCalcCatalog(opts: ReqOpts): Promise<CalcCatalogEntry[]> {
  const init: RequestInit = { headers: { Authorization: `Bearer ${opts.token}` } };
  if (opts.signal) init.signal = opts.signal;
  const resp = await fetch(new URL('/calc/catalog', opts.baseUrl).toString(), init);
  if (!resp.ok) throw await asError(resp);
  const body = (await resp.json()) as { calcs: CalcCatalogEntry[] };
  return body.calcs;
}

export async function runCalc(opts: ReqOpts & { body: CalcRequestBody }): Promise<CalcResponse> {
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(opts.body),
  };
  if (opts.signal) init.signal = opts.signal;
  const resp = await fetch(new URL('/calc', opts.baseUrl).toString(), init);
  if (!resp.ok) throw await asError(resp);
  return (await resp.json()) as CalcResponse;
}

async function asError(resp: Response): Promise<Error> {
  let detail = '';
  try {
    const body = (await resp.clone().json()) as { detail?: unknown };
    detail = typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? '');
  } catch {
    detail = await resp.text().catch(() => '');
  }
  return new Error(`/calc ${resp.status}: ${detail}`);
}
