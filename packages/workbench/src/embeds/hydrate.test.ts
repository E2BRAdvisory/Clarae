import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  hydrate,
  renderEmbedInto,
  MAX_EMBED_DEPTH,
  type EmbedBackend,
  type EmbedDeps,
} from './hydrate';
import { classify, parseSize, pdfPage } from './media';
import { initI18n } from '../i18n';

beforeAll(() => {
  initI18n('en');
  URL.createObjectURL = vi.fn(() => 'blob:fake');
});

const notes: Record<string, string> = {
  'A.md': '# A\n\nSee ![[B]]\n',
  'B.md': '---\nx: 1\n---\n# B\n\nBack to ![[A]]\n\n## Part\nonly this ^blk\n',
  'Deep.md': '![[Deep]]',
  'Img.md': 'x',
};

const backend: EmbedBackend = {
  resolve: (_from, target) => {
    const p = target.includes('.') ? target : target + '.md';
    return Promise.resolve(p in notes || p === 'pic.png' ? p : '');
  },
  readNote: (p) => (p in notes ? Promise.resolve(notes[p] ?? '') : Promise.reject(new Error('nf'))),
  readBinary: (p) => Promise.resolve({ path: p, mime: 'image/png', data: btoa('PNG'), size: 3 }),
};

const deps = (over: Partial<EmbedDeps> = {}): EmbedDeps => ({
  backend,
  fromPath: 'Host.md',
  depth: 0,
  visited: ['Host.md'],
  ...over,
});
const spec = (
  target: string,
  extra: Partial<{ heading: string; block: string; alias: string }> = {},
) => ({ target, heading: '', block: '', alias: '', embed: true, ...extra });
const wait = () => new Promise((r) => setTimeout(r, 20));

describe('embeds', () => {
  it('stops the query blocks it rendered when disposed', () => {
    const root = document.createElement('div');
    root.innerHTML = '<pre><code class="language-query">tag:#a</code></pre>';
    const stop = vi.fn();
    const renderQuery = vi.fn(() => stop);
    const dispose = hydrate(root, deps({ renderQuery }));
    expect(renderQuery).toHaveBeenCalledWith(expect.any(HTMLElement), 'tag:#a', 'Host.md');
    expect(stop).not.toHaveBeenCalled();
    dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('classifies files and parses hints', () => {
    expect(
      ['a.png', 'b.PDF', 'c.mp3', 'd.mov', 'e.md', 'f', 'g.excalidraw', 'h.xyz'].map(classify),
    ).toEqual(['image', 'pdf', 'audio', 'video', 'note', 'note', 'drawing', 'other']);
    expect(parseSize('300')).toEqual({ width: 300 });
    expect(parseSize('300x200')).toEqual({ width: 300, height: 200 });
    expect(parseSize('caption')).toEqual({});
    expect(pdfPage('page=4')).toBe(4);
    expect(pdfPage('')).toBe(1);
  });

  it('renders an image with its size', async () => {
    const el = document.createElement('span');
    await renderEmbedInto(el, spec('pic.png', { alias: '120x80' }), deps());
    const img = el.querySelector('img');
    expect(img?.src).toBe('blob:fake');
    expect([img?.width, img?.height]).toEqual([120, 80]);
  });

  it('fills nothing once disposed, and replaces an earlier render of the same element', async () => {
    const el = document.createElement('span');
    const first = renderEmbedInto(el, spec('pic.png'), deps());
    first.dispose();
    await first;
    expect(el.querySelector('img')).toBeNull();
    const second = renderEmbedInto(el, spec('pic.png'), deps());
    const third = renderEmbedInto(el, spec('B'), deps()); // stops the second
    await Promise.all([second, third]);
    expect(el.querySelector('img')).toBeNull();
    expect(el.className).toBe('embed-note');
    third.dispose();
    third.dispose(); // idempotent
  });

  it('renders a note without its frontmatter, hydrating nested embeds', async () => {
    const el = document.createElement('span');
    await renderEmbedInto(el, spec('B'), deps());
    await wait();
    expect(el.querySelector('.embed-note-title')?.textContent).toBe('B');
    expect(el.textContent).not.toContain('x: 1');
    expect(el.querySelector('.embed-note-body h1')?.textContent).toBe('B');
  });

  it('breaks cycles: A embeds B which embeds A', async () => {
    const el = document.createElement('span');
    await renderEmbedInto(el, spec('A'), deps({ visited: ['Host.md'] }));
    await wait();
    await wait();
    expect(el.textContent).toContain('circular embed');
  });

  it('stops at the depth limit', async () => {
    const el = document.createElement('span');
    await renderEmbedInto(el, spec('Deep'), deps({ depth: MAX_EMBED_DEPTH, visited: [] }));
    expect(el.textContent).toContain('depth limit');
  });

  it('embeds a section or a block, and reports what is missing', async () => {
    const sec = document.createElement('span');
    await renderEmbedInto(sec, spec('B', { heading: 'Part' }), deps());
    expect(sec.querySelector('h2')?.textContent).toBe('Part');
    expect(sec.querySelector('h1')).toBeNull();
    const blk = document.createElement('span');
    await renderEmbedInto(blk, spec('B', { block: 'blk' }), deps());
    expect(blk.querySelector('.embed-note-body')?.textContent?.trim()).toBe('only this');
    const none = document.createElement('span');
    await renderEmbedInto(none, spec('B', { heading: 'Nope' }), deps());
    expect(none.textContent).toContain('heading not found');
    const missing = document.createElement('span');
    await renderEmbedInto(missing, spec('Ghost'), deps());
    expect(missing.className).toContain('embed-missing');
  });

  it('renders a drawing from its preview and opens it on double click', async () => {
    const open = vi.fn();
    const el = document.createElement('span');
    const withDrawing: EmbedBackend = {
      ...backend,
      resolve: (_f, t) => Promise.resolve(t),
      drawingPreview: (p) => Promise.resolve(`blob:preview-of-${p}`),
    };
    await renderEmbedInto(el, spec('Sketch.excalidraw', { alias: '300' }), {
      ...deps({ backend: withDrawing }),
      openLink: open,
    });
    const img = el.querySelector('img.embed-drawing');
    expect(img?.getAttribute('src')).toBe('blob:preview-of-Sketch.excalidraw');
    expect(img?.getAttribute('width')).toBe('300');
    img?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'Sketch.excalidraw' }),
      false,
    );
  });

  it('falls back to the file name when a drawing has no preview support', async () => {
    const el = document.createElement('span');
    await renderEmbedInto(
      el,
      spec('Sketch.excalidraw'),
      deps({
        backend: { ...backend, resolve: (_f, t) => Promise.resolve(t) },
      }),
    );
    expect(el.textContent).toBe('Sketch.excalidraw');
  });
});
