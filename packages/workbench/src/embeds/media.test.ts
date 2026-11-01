import { beforeEach, describe, expect, it } from 'vitest';
import type { BinaryContent } from '../app/api';
import { forgetMedia, loadMedia, mediaLimits, mediaStats, releaseVaultMedia } from './media';

let reads: number;
let revoked: string[];
let content: Record<string, string>;

const read = (path: string) => (): Promise<BinaryContent> => {
  reads++;
  const text = content[path] ?? path;
  return Promise.resolve({ path, mime: 'image/png', data: btoa(text), size: text.length });
};

beforeEach(() => {
  releaseVaultMedia('v');
  releaseVaultMedia('w');
  reads = 0;
  revoked = [];
  content = {};
  let n = 0;
  URL.createObjectURL = () => `blob:${n++}`;
  URL.revokeObjectURL = (u: string) => void revoked.push(u);
});

describe('attachment cache', () => {
  it('serves a file whose tree stamp did not change without reading it', async () => {
    const stat = { size: 5, mtime: 't0' };
    const a = await loadMedia('v', 'a.png', read('a.png'), stat);
    const b = await loadMedia('v', 'a.png', read('a.png'), stat);
    expect(reads).toBe(1);
    expect(b.url).toBe(a.url);
    // Another vault with the same path is another file.
    await loadMedia('w', 'a.png', read('a.png'), stat);
    expect(reads).toBe(2);
  });

  it('reads again when the stamp changes, reusing the copy when the bytes are the same', async () => {
    const a = await loadMedia('v', 'a.png', read('a.png'), { size: 5, mtime: 't0' });
    const url = a.url;
    const b = await loadMedia('v', 'a.png', read('a.png'), { size: 5, mtime: 't1' });
    expect(reads).toBe(2);
    expect(b.url).toBe(url);
    content['a.png'] = 'edited';
    const c = await loadMedia('v', 'a.png', read('a.png'), { size: 6, mtime: 't2' });
    expect(c.url).not.toBe(url);
    // The old copy is still shown by a and b: revoked only once both let go.
    expect(revoked).toEqual([]);
    a.release();
    b.release();
    b.release(); // idempotent
    expect(revoked).toEqual([url]);
  });

  it('shares one read between concurrent requests', async () => {
    const [a, b] = await Promise.all([
      loadMedia('v', 'a.png', read('a.png')),
      loadMedia('v', 'a.png', read('a.png')),
    ]);
    expect(reads).toBe(1);
    expect(a.url).toBe(b.url);
  });

  it('forgets changed files and evicts the least recently used beyond the limits', async () => {
    const a = await loadMedia('v', 'dir/a.png', read('dir/a.png'), { size: 1, mtime: 0 });
    const url = a.url;
    a.release();
    forgetMedia('v', ['dir']);
    expect(revoked).toEqual([url]);
    await loadMedia('v', 'dir/a.png', read('dir/a.png'), { size: 1, mtime: 0 });
    expect(reads).toBe(2);

    const saved = mediaLimits.entries;
    mediaLimits.entries = 3;
    try {
      for (let i = 0; i < 6; i++) {
        const h = await loadMedia('v', `p${i}.png`, read(`p${i}.png`));
        void h.url;
        h.release();
      }
      expect(mediaStats().entries).toBeLessThanOrEqual(3);
    } finally {
      mediaLimits.entries = saved;
    }
  });

  it('revokes everything of a vault when it is released', async () => {
    const base = mediaStats().liveUrls; // copies still held by handles of earlier tests
    const h = await loadMedia('v', 'a.png', read('a.png'));
    void h.url;
    h.release();
    expect(mediaStats().liveUrls).toBe(base + 1);
    releaseVaultMedia('v');
    expect(mediaStats()).toMatchObject({ entries: 0, liveUrls: base });
  });
});
