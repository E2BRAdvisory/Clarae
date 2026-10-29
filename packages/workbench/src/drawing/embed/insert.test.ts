import { describe, expect, it } from 'vitest';
import {
  imagePatch,
  isImagePath,
  MAX_IMAGE_BYTES,
  noteCardPatch,
  noteExcerpt,
  noteLink,
  wrapLines,
} from './insert';

const png = { path: 'pics/a.png', mime: 'image/png', data: 'AAAA', size: 3 };

describe('imagePatch', () => {
  it('centers the image, scales it down to the max width and stores the file as a data URL', () => {
    const p = imagePatch(png, { width: 800, height: 400 }, { x: 100, y: 100 }, 400);
    const el = p.add![0]!;
    expect(el).toMatchObject({
      type: 'image',
      status: 'saved',
      width: 400,
      height: 200,
      x: -100,
      y: 0,
    });
    expect(el.customData).toEqual({ memobrain: { kind: 'image', path: 'pics/a.png' } });
    const f = Object.values(p.files!)[0]!;
    expect(f.id).toBe(el.fileId);
    expect(f.dataURL).toBe('data:image/png;base64,AAAA');
    expect(f.mimeType).toBe('image/png');
  });

  it('keeps small images at their natural size', () => {
    const el = imagePatch(png, { width: 40, height: 20 }, { x: 0, y: 0 }).add![0]!;
    expect([el.width, el.height]).toEqual([40, 20]);
  });

  it('refuses unsupported types, huge files and empty images', () => {
    expect(() =>
      imagePatch({ ...png, mime: 'application/pdf' }, { width: 1, height: 1 }, { x: 0, y: 0 }),
    ).toThrow('unsupported');
    expect(() =>
      imagePatch({ ...png, size: MAX_IMAGE_BYTES + 1 }, { width: 1, height: 1 }, { x: 0, y: 0 }),
    ).toThrow('larger');
    expect(() => imagePatch(png, { width: 0, height: 5 }, { x: 0, y: 0 })).toThrow('no size');
  });

  it('gives the same file id to the same content', () => {
    const a = imagePatch(png, { width: 1, height: 1 }, { x: 0, y: 0 });
    const b = imagePatch(png, { width: 1, height: 1 }, { x: 9, y: 9 });
    expect(a.add![0]!.fileId).toBe(b.add![0]!.fileId);
  });
});

describe('isImagePath', () => {
  it('recognises image extensions', () => {
    expect(['a.PNG', 'b.jpeg', 'c.svg', 'd.webp'].every(isImagePath)).toBe(true);
    expect(['a.md', 'b.pdf', 'c.excalidraw'].some(isImagePath)).toBe(false);
  });
});

describe('noteExcerpt', () => {
  it('turns markdown into short plain text', () => {
    const md = [
      '---',
      'tags: [x]',
      '---',
      '# Title',
      '',
      'Some **bold** text with a [[Other note|link]] and [site](https://x.example).',
      '',
      '- [ ] a task',
      '> quote',
      '```js',
      'const secret = 1;',
      '```',
      '![[image.png]]',
    ].join('\n');
    const t = noteExcerpt(md);
    expect(t).toContain('Some bold text with a link and site.');
    expect(t).toContain('a task');
    expect(t).toContain('quote');
    expect(t).not.toMatch(/tags:|secret|\*\*|\[\[|https|image\.png|^#/m);
  });

  it('cuts at a word boundary with an ellipsis', () => {
    const t = noteExcerpt('word '.repeat(100), 50);
    expect(t.length).toBeLessThanOrEqual(51);
    expect(t.endsWith('…')).toBe(true);
    expect(noteExcerpt('short')).toBe('short');
  });
});

describe('wrapLines', () => {
  it('wraps greedily and keeps paragraphs', () => {
    expect(wrapLines('aaa bbb ccc ddd', 7)).toEqual(['aaa bbb', 'ccc ddd']);
    expect(wrapLines('a\n\nb', 10)).toEqual(['a', '', 'b']);
    expect(wrapLines('supercalifragilistic x', 5)).toEqual(['supercalifragilistic', 'x']);
  });
});

describe('noteCardPatch', () => {
  it('builds a linked container with a bound text', () => {
    const p = noteCardPatch('Folder/My note.md', '# H\n\nBody **text**.', { x: 200, y: 100 });
    const [card, text] = p.add!;
    expect(card).toMatchObject({
      type: 'rectangle',
      link: '[[Folder/My note]]',
      customData: { memobrain: { kind: 'note', path: 'Folder/My note.md' } },
    });
    expect(card!.boundElements).toEqual([{ id: text!.id, type: 'text' }]);
    expect(text).toMatchObject({ type: 'text', containerId: card!.id, textAlign: 'left' });
    expect(String(text!.text)).toBe('My note\n\nBody text.');
    // Centered on the target.
    expect(Number(card!.x) + Number(card!.width) / 2).toBeCloseTo(200, 0);
    expect(Number(card!.y) + Number(card!.height) / 2).toBeCloseTo(100, 0);
  });

  it('links by path so it resolves whatever the other names', () => {
    expect(noteLink('a/b.md')).toBe('[[a/b]]');
    expect(noteLink('plain')).toBe('[[plain]]');
  });
});

describe('imagePatch kind', () => {
  it('records whether the picture came from an image or from another drawing', () => {
    const p = imagePatch(
      { path: 'Other.excalidraw', mime: 'image/svg+xml', data: 'PHN2Zy8+', size: 6 },
      { width: 100, height: 50 },
      { x: 0, y: 0 },
      400,
      'drawing',
    );
    expect(p.add![0]!.customData).toEqual({
      memobrain: { kind: 'drawing', path: 'Other.excalidraw' },
    });
  });
});
