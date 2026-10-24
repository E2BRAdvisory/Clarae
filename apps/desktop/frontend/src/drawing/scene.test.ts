import { describe, expect, it } from 'vitest';
import {
  DRAWING_WARN_BYTES,
  drawingBaseName,
  embedMarkdown,
  EMPTY_DRAWING,
  exportFileName,
  folderOf,
  isOverLimit,
  parseScene,
  sceneSignature,
} from './scene';

describe('drawing helpers', () => {
  it('parses the empty drawing and an empty file', () => {
    expect(parseScene(EMPTY_DRAWING).elements).toEqual([]);
    expect(parseScene('  ')).toEqual({ elements: [], appState: {}, files: {} });
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
