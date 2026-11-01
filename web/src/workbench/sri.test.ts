import { describe, expect, it, vi } from 'vitest';
import { fetchVerified, verifiedScriptURL } from './sri';

const ok = (body: string) => Promise.resolve(new Response(body, { status: 200 }));

describe('fetchVerified', () => {
  it('fetches with the integrity and returns the checked bytes as a script', async () => {
    const fetchImpl = vi.fn(() => ok('self.onmessage = null'));
    const blob = await fetchVerified('/assets/w-1.js', 'sha384-abc', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/assets/w-1.js', {
      integrity: 'sha384-abc',
      credentials: 'same-origin',
    });
    expect(blob.type).toBe('text/javascript');
    expect(await blob.text()).toBe('self.onmessage = null');
  });

  it('refuses to load without a hash, and fails on a mismatch or an HTTP error', async () => {
    const fetchImpl = vi.fn(() => ok('x'));
    await expect(fetchVerified('/a.js', '', fetchImpl)).rejects.toThrow(/no integrity/);
    expect(fetchImpl).not.toHaveBeenCalled();
    // A failed SRI check is a rejected fetch (TypeError in browsers).
    await expect(
      fetchVerified('/a.js', 'sha384-x', () => Promise.reject(new TypeError('integrity'))),
    ).rejects.toThrow(/integrity/);
    await expect(
      fetchVerified('/a.js', 'sha384-x', () => Promise.resolve(new Response('', { status: 404 }))),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('hands out a blob: URL of the checked bytes', async () => {
    const create = vi.fn(() => 'blob:checked');
    Object.assign(URL, { createObjectURL: create });
    await expect(verifiedScriptURL('/p.mjs', 'sha384-y', () => ok('worker'))).resolves.toBe(
      'blob:checked',
    );
    expect(create).toHaveBeenCalledTimes(1);
  });
});
