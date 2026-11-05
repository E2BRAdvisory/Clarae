import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { renderDeck } from './engine';
import { deckToPptx, imageSize } from './pptx';
import { includedDeck } from './slides';

// A 3 x 2 PNG (a real, tiny file).
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEklEQVR4nGP4z8Dwn4EBiAEAEAAD/16o2sQAAAAASUVORK5CYII=';

const DECK = `---
marp: true
theme: gaia
paginate: true
---

<!-- _class: lead -->

# Quarterly **review**

First note of the presenter

<!-- Remember to greet -->

---

<!-- memobrain: hidden -->

## Secret slide

---

## Plan

- Alpha item with \`code\`
  - Nested beta
- Gamma [site](https://example.org)

1. One
2. Two

> A wise quote

| Name | Value |
|------|-------|
| a    | 1     |

\`\`\`ts
const x = 1;
\`\`\`

![w:300](<${PNG}>)

<!-- Plan notes here -->
`;

async function build(): Promise<JSZip> {
  const deck = await renderDeck(DECK, (ref) => Promise.resolve({ url: ref }));
  const kept = includedDeck(deck);
  const { data: b64 } = await deckToPptx({
    html: kept.html,
    notes: kept.notes,
    title: 'Demo',
    lang: 'en',
  });
  return JSZip.loadAsync(b64, { base64: true });
}

describe('pptx export', () => {
  it('writes the included slides only, with texts, notes, table, code and picture', async () => {
    const zip = await build();
    const names = Object.keys(zip.files);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('ppt/presentation.xml');
    const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    expect(slides).toHaveLength(2);

    const one = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const two = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(one).toContain('Quarterly');
    expect(one).toContain('review');
    expect(one).not.toContain('Secret slide');
    expect(two).not.toContain('Secret slide');
    expect(two).toContain('Plan');
    expect(two).toContain('Alpha item with');
    expect(two).toContain('Nested beta');
    expect(two).toContain('Gamma');
    expect(two).toContain('A wise quote');
    expect(two).toContain('<a:tbl>');
    expect(two).toContain('const x = 1;');
    expect(two).toContain('Courier New');
    expect(two).toContain('<a:buAutoNum'); // numbered list
    expect(two).toContain('lvl="1"'); // nested bullet
    expect(two).toContain('<p:pic>'); // the picture
    expect(two).toContain('>2<'); // the pages are numbered 1..n: the hidden slide leaves no gap
    expect(two).not.toContain('>3<');
    expect(two).not.toMatch(/<\/a:r><a:pPr/); // PowerPoint rejects a paragraph property after a run
    // Presenter notes land in the notes slides.
    const notes = await Promise.all(
      names
        .filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
        .map((n) => zip.file(n)!.async('string')),
    );
    expect(notes.join(' ')).toContain('Remember to greet');
    expect(notes.join(' ')).toContain('Plan notes here');
    // The picture is a media part.
    expect(names.some((n) => /^ppt\/media\/.+\.png$/.test(n))).toBe(true);
    // The theme of the slide: a hyperlink for the link.
    expect(await zip.file('ppt/slides/_rels/slide2.xml.rels')!.async('string')).toContain(
      'https://example.org',
    );
  });

  it('draws ![bg] backgrounds and SVG pictures as pictures', async () => {
    const svg = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20"/></svg>')}`;
    const src = `---\nmarp: true\n---\n\n![bg left](<${PNG}>)\n\n# With picture\n\n![](pic.svg)\n`;
    const deck = await renderDeck(src, (ref) =>
      Promise.resolve({ url: ref === 'pic.svg' ? svg : ref }),
    );
    const { data: b64 } = await deckToPptx({
      ...includedDeck(deck),
      title: 'Bg',
      lang: 'en',
      rasterize: () => Promise.resolve(PNG), // jsdom cannot draw an SVG
    });
    const zip = await JSZip.loadAsync(b64, { base64: true });
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml.match(/<p:pic>/g)!.length).toBeGreaterThanOrEqual(2);
    expect(xml).toContain('With picture');
  });

  const SVG = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20"/></svg>')}`;
  const svgDeck = async () =>
    renderDeck('---\nmarp: true\n---\n\n# Pics\n\n![Chart of sales](pic.svg)\n', () =>
      Promise.resolve({ url: SVG }),
    );

  it('draws an SVG picture into a PNG itself, so pptxgenjs never has to', async () => {
    const seen: string[] = [];
    const { data, skipped } = await deckToPptx({
      ...includedDeck(await svgDeck()),
      title: 'Svg',
      lang: 'en',
      rasterize: (url) => {
        seen.push(url);
        return Promise.resolve(PNG);
      },
    });
    expect(seen).toEqual([SVG]);
    expect(skipped).toEqual([]);
    const zip = await JSZip.loadAsync(data, { base64: true });
    expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain('<p:pic>');
    expect(Object.keys(zip.files).some((n) => /\.svg$/.test(n))).toBe(false);
  });

  it('leaves out a picture the web view cannot draw, and says which', async () => {
    const { data, skipped } = await deckToPptx({
      ...includedDeck(await svgDeck()),
      title: 'Svg',
      lang: 'en',
      rasterize: () => Promise.reject(new Error('Tainted canvas')),
    });
    expect(skipped).toEqual(['Chart of sales']);
    const zip = await JSZip.loadAsync(data, { base64: true });
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('Pics'); // the file is written all the same
    expect(xml).not.toContain('<p:pic>');
  });

  it('keeps the pictures of one export apart from those of another running at the same time', async () => {
    const mk = (name: string) =>
      `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><title>${name}</title><rect width="40" height="20"/></svg>`)}`;
    const urls: Record<string, string> = { 'one.svg': mk('one'), 'two.svg': mk('two') };
    const a = await renderDeck(
      '---\nmarp: true\n---\n\n# A\n\n![](one.svg)\n\n![](two.svg)\n',
      (ref) => Promise.resolve({ url: urls[ref] ?? ref }),
    );
    const b = await svgDeck();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const [ra] = await Promise.all([
      deckToPptx({
        ...includedDeck(a),
        title: 'A',
        lang: 'en',
        rasterize: async (url) => {
          if (url.includes('two')) await sleep(60);
          return PNG;
        },
      }),
      (async () => {
        await sleep(20); // starts while A waits for its second picture
        return deckToPptx({
          ...includedDeck(b),
          title: 'B',
          lang: 'en',
          rasterize: () => Promise.resolve(PNG),
        });
      })(),
    ]);
    const zip = await JSZip.loadAsync(ra.data, { base64: true });
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml.match(/<p:pic>/g)).toHaveLength(2);
    expect(ra.skipped).toEqual([]);
  });

  it('writes the presenter notes without the invisible character that guards a directive', async () => {
    const { data } = await deckToPptx({
      html: '<div class="marpit"><svg><foreignObject><section>x</section></foreignObject></svg></div>',
      notes: ['theme\u200b: dark'],
      title: 'N',
      lang: 'en',
    });
    const zip = await JSZip.loadAsync(data, { base64: true });
    const notes = Object.keys(zip.files).find((n) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n),
    );
    const xml = await zip.file(notes!)!.async('string');
    expect(xml).toContain('theme: dark');
    expect(xml).not.toContain('\u200b');
  });

  it('reads the size of a picture from its header', () => {
    expect(imageSize(PNG)).toEqual({ w: 3, h: 2 });
    expect(
      imageSize(`data:image/svg+xml;utf8,${encodeURIComponent('<svg viewBox="0 0 40 20"></svg>')}`),
    ).toEqual({ w: 40, h: 20 });
  });
});

describe('includedDeck', () => {
  it('drops the hidden slides and their notes', async () => {
    const deck = await renderDeck(DECK, (ref) => Promise.resolve({ url: ref }));
    expect(deck.hidden).toEqual([false, true, false]);
    const kept = includedDeck(deck);
    expect(kept.indices).toEqual([0, 2]);
    expect(kept.notes).toHaveLength(2);
    expect(kept.html).not.toContain('Secret slide');
    expect(kept.html.match(/<svg/g)).toHaveLength(2);
    expect(kept.html).toContain('Quarterly');
  });

  it('numbers the pages of the slides that stay 1..n, and their total', async () => {
    const src =
      '---\nmarp: true\npaginate: true\n---\n\n# One\n\n---\n\n<!-- memobrain: hidden -->\n# Two\n\n---\n\n# Three\n\n---\n\n# Four\n';
    const deck = await renderDeck(src, () => Promise.resolve(null));
    const raw = deck.html.match(/data-marpit-pagination="(\d+)"/g);
    expect(raw).toEqual([
      'data-marpit-pagination="1"',
      'data-marpit-pagination="2"',
      'data-marpit-pagination="3"',
      'data-marpit-pagination="4"',
    ]);
    const kept = includedDeck(deck);
    expect(kept.html.match(/data-marpit-pagination="(\d+)"/g)).toEqual([
      'data-marpit-pagination="1"',
      'data-marpit-pagination="2"',
      'data-marpit-pagination="3"',
    ]);
    expect(new Set(kept.html.match(/data-marpit-pagination-total="\d+"/g))).toEqual(
      new Set(['data-marpit-pagination-total="3"']),
    );
  });

  it('keeps everything when no slide is hidden', () => {
    const html = '<div class="marpit"><svg>a</svg><svg>b</svg></div>';
    const kept = includedDeck({ html, notes: ['x', 'y'], hidden: [false, false] });
    expect(kept.indices).toEqual([0, 1]);
    expect(kept.notes).toEqual(['x', 'y']);
  });
});
