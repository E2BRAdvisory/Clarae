import { beforeEach, describe, expect, it } from 'vitest';
import type { BinaryContent } from '../app/api';
import {
  classify,
  displayName,
  displayPath,
  forgetMedia,
  KIND_ICON,
  loadMedia,
  mediaLimits,
  mediaStats,
  openTarget,
  pickItems,
  releaseVaultMedia,
  splitName,
} from './media';

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

describe('applications', () => {
  it('are a kind of file of their own, shown in a tab of the application', () => {
    expect(classify('Tools/GitHub.webapp')).toBe('webapp');
    expect(classify('Tools/GitHub.WEBAPP')).toBe('webapp');
    expect(openTarget('Tools/GitHub.webapp')).toBe('in-app');
    expect(KIND_ICON.webapp).toBe('webapp');
    // a name that only contains the word is not one
    expect(classify('webapp.txt')).toBe('other');
    expect(classify('webapp')).toBe('note');
    expect(openTarget('.webapp')).toBe('external');
  });
});

describe('file names without the extension', () => {
  it('hides it for the files that open in a tab of the application, and keeps its case', () => {
    expect(splitName('Plan.md')).toEqual({ stem: 'Plan', ext: '.md' });
    expect(splitName('Plan.MD')).toEqual({ stem: 'Plan', ext: '.MD' });
    expect(splitName('Map.canvas')).toEqual({ stem: 'Map', ext: '.canvas' });
    expect(splitName('Sketch.excalidraw')).toEqual({ stem: 'Sketch', ext: '.excalidraw' });
    expect(splitName('Review.marp')).toEqual({ stem: 'Review', ext: '.marp' });
    expect(splitName('Tasks.base')).toEqual({ stem: 'Tasks', ext: '.base' });
    expect(splitName('GitHub.webapp')).toEqual({ stem: 'GitHub', ext: '.webapp' });
    expect(splitName('photo.png')).toEqual({ stem: 'photo', ext: '.png' });
    expect(splitName('Talk.pdf')).toEqual({ stem: 'Talk', ext: '.pdf' });
    expect(splitName('take.mp3')).toEqual({ stem: 'take', ext: '.mp3' });
    expect(splitName('clip.mp4')).toEqual({ stem: 'clip', ext: '.mp4' });
    expect(splitName('clip.webm')).toEqual({ stem: 'clip', ext: '.webm' });
  });

  it('cuts only the last extension, and the legacy drawing in notes as one', () => {
    expect(splitName('a.b.canvas')).toEqual({ stem: 'a.b', ext: '.canvas' });
    expect(splitName('v1.2 notes.md')).toEqual({ stem: 'v1.2 notes', ext: '.md' });
    expect(splitName('Old.excalidraw.md')).toEqual({ stem: 'Old', ext: '.excalidraw.md' });
    expect(splitName('Old.Excalidraw.MD')).toEqual({ stem: 'Old', ext: '.Excalidraw.MD' });
  });

  it('keeps the whole name of a file that opens outside the application', () => {
    for (const name of [
      'Report.docx',
      'data.zip',
      'LICENSE',
      '.gitignore',
      'Makefile',
      '.md',
      'a.',
    ]) {
      expect(splitName(name)).toEqual({ stem: name, ext: '' });
    }
  });

  it('works on the last segment of a path', () => {
    expect(splitName('Projects/2026/Plan.md')).toEqual({ stem: 'Plan', ext: '.md' });
    expect(displayName('Projects/2026/Plan.md')).toBe('Plan');
    expect(displayName('Docs/Report.docx')).toBe('Report.docx');
    expect(displayName('Docs/Old.excalidraw.md')).toBe('Old');
    expect(displayPath('Projects/2026/Plan.md')).toBe('Projects/2026/Plan');
    expect(displayPath('Docs/Report.docx')).toBe('Docs/Report.docx');
    expect(displayPath('Sketch.excalidraw')).toBe('Sketch');
  });
});

describe('pick lists of files', () => {
  it('label the files without their extension', () => {
    expect(pickItems(['A/Plan.md', 'Map.canvas', 'Docs/Report.docx'])).toEqual([
      { value: 'A/Plan.md', label: 'A/Plan' },
      { value: 'Map.canvas', label: 'Map' },
      { value: 'Docs/Report.docx', label: 'Docs/Report.docx' },
    ]);
  });

  it('show the whole path of files that would look alike', () => {
    expect(
      pickItems(['Plan.excalidraw', 'Plan.marp', 'Plan.pdf', 'Plan.png', 'Other.png']),
    ).toEqual([
      { value: 'Plan.excalidraw', label: 'Plan.excalidraw' },
      { value: 'Plan.marp', label: 'Plan.marp' },
      { value: 'Plan.pdf', label: 'Plan.pdf' },
      { value: 'Plan.png', label: 'Plan.png' },
      { value: 'Other.png', label: 'Other' },
    ]);
    expect(pickItems(['pics/dot.png', 'pics/DOT.svg', 'dot.png'])).toEqual([
      { value: 'pics/dot.png', label: 'pics/dot.png' },
      { value: 'pics/DOT.svg', label: 'pics/DOT.svg' },
      { value: 'dot.png', label: 'dot' },
    ]);
  });
});
