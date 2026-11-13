import { describe, expect, it } from 'vitest';
import {
  DRAWING_WARN_BYTES,
  drawingBaseName,
  embedMarkdown,
  EMPTY_DRAWING,
  exportFileName,
  folderOf,
  elementAt,
  linkedElementAt,
  parseElementLink,
  isOverLimit,
  parseScene,
  sceneSignature,
} from './scene';

describe('drawing helpers', () => {
  it('parses the empty drawing and an empty file', () => {
    expect(parseScene(EMPTY_DRAWING).elements).toEqual([]);
    expect(parseScene('  ')).toEqual({ elements: [], appState: {}, files: {}, extra: {} });
  });

  it("keeps the other top-level keys (per-drawing settings) apart from Excalidraw's own", () => {
    const s = parseScene(
      JSON.stringify({
        type: 'excalidraw',
        version: 2,
        source: 'x',
        elements: [],
        appState: {},
        files: {},
        clarae: { autoExport: 'png' },
        other: 1,
      }),
    );
    expect(s.extra).toEqual({ clarae: { autoExport: 'png' }, other: 1 });
    expect(parseScene(EMPTY_DRAWING).extra).toEqual({});
  });

  it('reads the settings of a 1.x file and saves them under the new key only', () => {
    const base = {
      type: 'excalidraw',
      version: 2,
      source: 'x',
      elements: [],
      appState: {},
      files: {},
    };
    const s = parseScene(JSON.stringify({ ...base, memobrain: { autoExport: 'png' }, other: 1 }));
    expect(s.extra).toEqual({ clarae: { autoExport: 'png' }, other: 1 });
    // a file that went through a merge can have both: the new key wins, the rest is kept
    const both = parseScene(
      JSON.stringify({
        ...base,
        memobrain: { autoExport: 'png', slideLoop: 'true' },
        clarae: { autoExport: 'svg' },
      }),
    );
    expect(both.extra).toEqual({ clarae: { autoExport: 'svg', slideLoop: 'true' } });
  });

  it('keeps elements, app state and files', () => {
    const s = parseScene(
      JSON.stringify({
        type: 'excalidraw',
        elements: [{ id: 'a', type: 'text' }],
        appState: { zoom: 1 },
        files: { f: { id: 'f' } },
      }),
    );
    expect(s.elements).toHaveLength(1);
    expect(s.appState).toEqual({ zoom: 1 });
    expect(Object.keys(s.files)).toEqual(['f']);
  });

  it('rejects what is not an Excalidraw file', () => {
    expect(() => parseScene('{')).toThrow();
    expect(() => parseScene('[]')).toThrow(/not an Excalidraw/);
    expect(() => parseScene('{"type":"canvas","elements":[]}')).toThrow(/type "canvas"/);
    expect(() => parseScene('{"type":"excalidraw"}')).toThrow(/no elements/);
  });

  it('signs a scene by element ids and versions, so selection changes are not edits', () => {
    const a = sceneSignature([{ id: 'x', version: 1 }], 0);
    expect(sceneSignature([{ id: 'x', version: 1 }], 0)).toBe(a);
    expect(sceneSignature([{ id: 'x', version: 2 }], 0)).not.toBe(a);
    expect(sceneSignature([{ id: 'x', version: 1 }], 1)).not.toBe(a);
    expect(sceneSignature([], 0)).not.toBe(a);
  });

  it('flags drawings above 10 MB', () => {
    expect(isOverLimit('x'.repeat(DRAWING_WARN_BYTES))).toBe(false);
    expect(isOverLimit('x'.repeat(DRAWING_WARN_BYTES + 1))).toBe(true);
  });

  it('names files', () => {
    expect(drawingBaseName(new Date(2026, 9, 24, 9, 5))).toBe('Drawing 2026-10-24 09.05');
    expect(embedMarkdown('Maps/Plan.excalidraw')).toBe('![[Plan.excalidraw]]');
    expect(exportFileName('Maps/Plan.excalidraw', 'png', 1)).toBe('Plan.png');
    expect(exportFileName('Maps/Plan.excalidraw', 'png', 3)).toBe('Plan@3x.png');
    expect(exportFileName('Plan.excalidraw', 'svg', 2)).toBe('Plan.svg');
    expect(folderOf('a/b/c.excalidraw')).toBe('a/b');
    expect(folderOf('c.excalidraw')).toBe('');
  });
});

describe('parseElementLink', () => {
  it('reads wikilinks with heading, block and alias', () => {
    expect(parseElementLink('[[Note]]')).toEqual({
      kind: 'note',
      target: 'Note',
      heading: '',
      block: '',
    });
    expect(parseElementLink('[[Folder/Note#Intro|see this]]')).toEqual({
      kind: 'note',
      target: 'Folder/Note',
      heading: 'Intro',
      block: '',
    });
    expect(parseElementLink('[[Note#^abc123]]')).toEqual({
      kind: 'note',
      target: 'Note',
      heading: '',
      block: 'abc123',
    });
  });

  it('reads web URLs and rejects everything else', () => {
    expect(parseElementLink('https://example.com/a')).toEqual({
      kind: 'external',
      url: 'https://example.com/a',
    });
    expect(parseElementLink('javascript:alert(1)')).toBeNull();
    expect(parseElementLink('file:///etc/passwd')).toBeNull();
    expect(parseElementLink('[[]]')).toBeNull();
    expect(parseElementLink('  ')).toBeNull();
    expect(parseElementLink(null)).toBeNull();
  });
});

describe('embedMarkdown width', () => {
  it('adds the width only when set', () => {
    expect(embedMarkdown('a/x.excalidraw')).toBe('![[x.excalidraw]]');
    expect(embedMarkdown('a/x.excalidraw', 600)).toBe('![[x.excalidraw|600]]');
  });
});

describe('linkedElementAt', () => {
  const el = (id: string, x: number, y: number, link: string | null, extra = {}) => ({
    id,
    x,
    y,
    width: 100,
    height: 50,
    link,
    ...extra,
  });
  const els = [
    el('a', 0, 0, '[[Under]]'),
    el('b', 50, 20, '[[Over]]'),
    el('c', 300, 0, 'https://example.com'),
    el('d', 500, 0, '[[Gone]]', { isDeleted: true }),
  ];

  it('returns the topmost element with a note link', () => {
    expect(linkedElementAt(els, 10, 10)?.id).toBe('a');
    expect(linkedElementAt(els, 60, 30)?.id).toBe('b');
  });

  it('ignores web links, deleted elements and misses', () => {
    expect(linkedElementAt(els, 350, 20)).toBeNull();
    expect(linkedElementAt(els, 520, 20)).toBeNull();
    expect(linkedElementAt(els, 900, 900)).toBeNull();
  });

  it('allows a small tolerance and handles negative sizes', () => {
    expect(linkedElementAt(els, -3, 10)?.id).toBe('a');
    expect(
      linkedElementAt([el('n', 100, 100, '[[N]]', { width: -50, height: -20 })], 70, 90)?.id,
    ).toBe('n');
  });
});

describe('elementAt', () => {
  it('picks the topmost element accepted by the predicate', () => {
    const els = [
      { id: 'a', x: 0, y: 0, width: 100, height: 100 },
      { id: 'b', x: 20, y: 20, width: 100, height: 100 },
    ];
    expect(elementAt(els, 50, 50, () => true)?.id).toBe('b');
    expect(elementAt(els, 50, 50, (e) => e.id === 'a')?.id).toBe('a');
    expect(elementAt(els, 500, 500, () => true)).toBeNull();
    expect(elementAt(els, -2, 10, () => true, 0)).toBeNull();
  });
});
