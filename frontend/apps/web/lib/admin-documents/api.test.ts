import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  listAdminDocuments,
  requeueAdminDocument,
  requeueStuckAdminDocuments,
} from './api';

/** Minimal Response stand-in covering the fields api.ts touches. */
function fakeResponse(opts: { ok: boolean; status?: number; body?: unknown; text?: string }) {
  const payload = opts.body;
  const resp = {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    clone() {
      return resp;
    },
    async json() {
      if (payload === undefined) throw new Error('no json');
      return payload;
    },
    async text() {
      return opts.text ?? '';
    },
  };
  return resp as unknown as Response;
}

function mockFetchOnce(resp: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp));
}

const OPTS = { baseUrl: 'https://api.test', token: 'tok' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('admin-documents api error handling', () => {
  it('rejects requeue with a real Error message, not "[object Promise]"', async () => {
    mockFetchOnce(
      fakeResponse({ ok: false, status: 409, body: { detail: "cannot requeue a document in 'done' state" } }),
    );

    const err = await requeueAdminDocument({ ...OPTS, ingestId: 'ing-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('[object Promise]');
    expect((err as Error).message).toContain('409');
    expect((err as Error).message).toContain("cannot requeue a document in 'done' state");
  });

  it('serializes a non-string detail (e.g. validation array) instead of [object Object]', async () => {
    mockFetchOnce(
      fakeResponse({ ok: false, status: 422, body: { detail: [{ msg: 'bad', loc: ['x'] }] } }),
    );

    const err = await listAdminDocuments(OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('422');
    expect((err as Error).message).toContain('bad');
  });

  it('falls back to response text when the error body is not JSON', async () => {
    mockFetchOnce(fakeResponse({ ok: false, status: 502, text: 'upstream down' }));

    const err = await requeueStuckAdminDocuments(OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('502');
    expect((err as Error).message).toContain('upstream down');
  });

  it('returns parsed data on success', async () => {
    mockFetchOnce(fakeResponse({ ok: true, body: { requeued: 2, results: [] } }));
    await expect(requeueStuckAdminDocuments(OPTS)).resolves.toEqual({ requeued: 2, results: [] });
  });
});
