import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@memobrain/api-client';
import { problem, mockApi } from '../test/utils';
import {
  ExportJobError,
  exportShared,
  fetchDownload,
  filenameFromDisposition,
  isAbort,
  sanitizeName,
  type SharedExportEvent,
} from './sharedExport';

const V = '0190a3b4-1111-7222-8333-444455556666';
const vault = { id: V, name: 'My Notes' };
const zip = (name?: string) =>
  new Response('PK-data', {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      ...(name ? { 'Content-Disposition': name } : {}),
    },
  });
const job = (status: string, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({ id: 'j1', vault_id: V, status, created_at: '2026-01-01T00:00:00Z', ...extra }),
    {
      status: status === 'queued' ? 202 : 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );

afterEach(() => vi.useRealTimers());

describe('filenameFromDisposition', () => {
  it.each([
    ['attachment; filename="notes.zip"', 'notes.zip'],
    ['attachment; filename=notes.zip', 'notes.zip'],
    ["attachment; filename*=UTF-8''caff%C3%A8.zip", 'caffè.zip'],
    ['attachment; filename="a.zip"; filename*=UTF-8\'\'b%20c.zip', 'b c.zip'],
    ['attachment; filename="../../etc/passwd"', 'passwd'],
    ['attachment', undefined],
    [null, undefined],
  ])('%j -> %j', (header, want) => {
    expect(filenameFromDisposition(header)).toBe(want);
  });
  it('sanitizes names', () => {
    expect(sanitizeName('a/b\\c:d.zip')).toBe('c_d.zip');
    expect(sanitizeName('..')).toBeUndefined();
  });
});

describe('exportShared: direct stream', () => {
  it('returns the blob with the Content-Disposition name', async () => {
    const api = mockApi({
      [`GET /vaults/${V}/export.zip`]: () => zip('attachment; filename="notes-2026.zip"'),
    });
    const events: SharedExportEvent[] = [];
    const r = await exportShared({ api: api.client, getToken: () => 't' }, vault, {
      onEvent: (e) => events.push(e),
    });
    expect(r.kind).toBe('blob');
    if (r.kind !== 'blob') return;
    expect(r.filename).toBe('notes-2026.zip');
    expect(await r.blob.text()).toBe('PK-data');
    expect(events).toEqual([{ kind: 'direct' }]);
    expect(api.called('POST', `/vaults/${V}/exports`)).toHaveLength(0);
  });

  it('falls back to "<vault name>.zip" without a header', async () => {
    const api = mockApi({ [`GET /vaults/${V}/export.zip`]: () => zip() });
    const r = await exportShared({ api: api.client, getToken: () => 't' }, vault);
    expect(r.filename).toBe('My Notes.zip');
  });

  it('reports other errors (including VAULT_ENCRYPTED) without starting a job', async () => {
    const api = mockApi({ [`GET /vaults/${V}/export.zip`]: () => problem(409, 'VAULT_ENCRYPTED') });
    await expect(
      exportShared({ api: api.client, getToken: () => 't' }, vault),
    ).rejects.toMatchObject({
      code: 'VAULT_ENCRYPTED',
    });
    expect(api.called('POST', `/vaults/${V}/exports`)).toHaveLength(0);
  });
});

describe('exportShared: job fallback', () => {
  it('polls every 2 s through queued, running and ready, then downloads with the token', async () => {
    vi.useFakeTimers();
    const states = ['running', 'running', 'ready'];
    const fetchFn = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(zip('attachment; filename="big.zip"')),
    );
    const api = mockApi({
      [`GET /vaults/${V}/export.zip`]: () => problem(409, 'INVALID_STATE', 'too large'),
      [`POST /vaults/${V}/exports`]: () => job('queued'),
      [`GET /vaults/${V}/exports/j1`]: () => {
        const s = states.shift() as string;
        return job(
          s,
          s === 'ready' ? { download_url: `/api/v1/vaults/${V}/exports/j1/download` } : {},
        );
      },
    });
    const events: string[] = [];
    const p = exportShared(
      { api: api.client, getToken: () => 'secret', fetchFn: fetchFn as unknown as typeof fetch },
      vault,
      { onEvent: (e) => events.push(e.kind === 'job' ? e.status : e.kind) },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['direct', 'queued']);
    expect(api.called('GET', `/vaults/${V}/exports/j1`)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1999);
    expect(api.called('GET', `/vaults/${V}/exports/j1`)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.called('GET', `/vaults/${V}/exports/j1`)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    const r = await p;
    expect(events).toEqual(['direct', 'queued', 'running', 'running', 'ready']);
    expect(r.kind).toBe('blob');
    expect(r.filename).toBe('big.zip');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${location.origin}/api/v1/vaults/${V}/exports/j1/download`);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret');
  });

  it('hands a presigned cross-origin URL to the browser without sending the token', async () => {
    const fetchFn = vi.fn();
    const r = await fetchDownload(
      {
        api: mockApi({}).client,
        getToken: () => 'secret',
        fetchFn,
      },
      'https://s3.example.com/bucket/exp.zip?X-Amz-Signature=abc',
      'My Notes.zip',
    );
    expect(r).toEqual({
      kind: 'redirect',
      url: 'https://s3.example.com/bucket/exp.zip?X-Amz-Signature=abc',
      filename: 'My Notes.zip',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws a typed error when the job fails or expires', async () => {
    for (const status of ['failed', 'expired'] as const) {
      const api = mockApi({
        [`GET /vaults/${V}/export.zip`]: () => problem(409, 'INVALID_STATE'),
        [`POST /vaults/${V}/exports`]: () => job(status, { error: 'disk full' }),
      });
      await expect(
        exportShared({ api: api.client, getToken: () => 't' }, vault),
      ).rejects.toMatchObject({
        name: 'ExportJobError',
        status,
      });
    }
    expect(new ExportJobError('failed', 'x')).toBeInstanceOf(Error);
  });

  it('stops polling when aborted', async () => {
    vi.useFakeTimers();
    const api = mockApi({
      [`GET /vaults/${V}/export.zip`]: () => problem(409, 'INVALID_STATE'),
      [`POST /vaults/${V}/exports`]: () => job('queued'),
      [`GET /vaults/${V}/exports/j1`]: () => job('running'),
    });
    const ac = new AbortController();
    const p = exportShared({ api: api.client, getToken: () => 't' }, vault, { signal: ac.signal });
    const settled = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.called('GET', `/vaults/${V}/exports/j1`)).toHaveLength(1);
    ac.abort();
    const err = await settled;
    expect(isAbort(err)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.called('GET', `/vaults/${V}/exports/j1`)).toHaveLength(1);
  });

  it('surfaces API errors of the job endpoints as ApiError', async () => {
    const api = mockApi({
      [`GET /vaults/${V}/export.zip`]: () => problem(409, 'INVALID_STATE'),
      [`POST /vaults/${V}/exports`]: () => problem(403, 'FORBIDDEN'),
    });
    await expect(
      exportShared({ api: api.client, getToken: () => 't' }, vault),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
