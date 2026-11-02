import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewUrls } from './previewUrls';

let n = 0;
let revoked: string[] = [];

beforeEach(() => {
  n = 0;
  revoked = [];
  URL.createObjectURL = () => `blob:${n++}`;
  URL.revokeObjectURL = (u: string) => void revoked.push(u);
});

describe('PreviewUrls', () => {
  it('reuses the URL of a version already made', () => {
    const urls = new PreviewUrls();
    const u = urls.put('v', 'a.excalidraw', 'h1', '<svg/>');
    expect(urls.get('v', 'h1')).toBe(u);
    expect(urls.put('v', 'a.excalidraw', 'h1', '<svg/>')).toBe(u);
    expect(urls.get('w', 'h1')).toBeUndefined(); // another vault
    expect(revoked).toEqual([]);
  });

  it('revokes the older version of the same file when a newer one is made', () => {
    const urls = new PreviewUrls();
    const old = urls.put('v', 'a.excalidraw', 'h1', '<svg/>');
    const other = urls.put('v', 'b.excalidraw', 'h9', '<svg/>');
    const fresh = urls.put('v', 'a.excalidraw', 'h2', '<svg/>');
    expect(revoked).toEqual([old]);
    expect(urls.get('v', 'h1')).toBeUndefined();
    expect(urls.get('v', 'h2')).toBe(fresh);
    expect(urls.get('v', 'h9')).toBe(other);
  });

  it('keeps at most `limit` previews, dropping the least recently used', () => {
    const urls = new PreviewUrls(2);
    const a = urls.put('v', 'a', 'ha', '<svg/>');
    urls.put('v', 'b', 'hb', '<svg/>');
    urls.get('v', 'ha'); // a is used again: b is now the oldest
    urls.put('v', 'c', 'hc', '<svg/>');
    expect(urls.size).toBe(2);
    expect(revoked).toEqual(['blob:1']);
    expect(urls.get('v', 'ha')).toBe(a);
  });

  it('revokes the previews of a vault that was closed', () => {
    const urls = new PreviewUrls();
    const a = urls.put('v', 'a', 'ha', '<svg/>');
    const b = urls.put('w', 'b', 'hb', '<svg/>');
    urls.releaseVault('v');
    expect(revoked).toEqual([a]);
    expect(urls.get('w', 'hb')).toBe(b);
    expect(urls.size).toBe(1);
  });
});
