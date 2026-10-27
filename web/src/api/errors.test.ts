import { describe, expect, it } from 'vitest';
import { ApiError, unwrap } from '@memobrain/api-client';

describe('unwrap', () => {
  it('returns the data of a successful call', async () => {
    const data = await unwrap(Promise.resolve({ data: { a: 1 }, response: new Response('{}') }));
    expect(data).toEqual({ a: 1 });
  });

  it('throws an ApiError carrying the RFC 9457 code', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Quota',
      status: 413,
      code: 'QUOTA_EXCEEDED',
      detail: 'full',
      request_id: 'r1',
    };
    const err = await unwrap(
      Promise.resolve({ error: problem, response: new Response('', { status: 413 }) }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 413,
      code: 'QUOTA_EXCEEDED',
      requestId: 'r1',
      message: 'full',
    });
  });

  it('degrades to UNKNOWN for non-problem bodies', async () => {
    const err = await unwrap(
      Promise.resolve({
        error: '<html>',
        response: new Response('', { status: 502, statusText: 'Bad Gateway' }),
      }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'UNKNOWN', message: '502 Bad Gateway' });
  });
});
