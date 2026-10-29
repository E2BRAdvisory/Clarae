import { describe, expect, it, vi } from 'vitest';
import type { SceneElement } from '../actions/types';
import { mermaidPatch, parseMermaid, placeDiagram } from './insert';

const el = (id: string, x: number, y: number, w: number, h: number, extra = {}): SceneElement => ({
  id,
  type: 'rectangle',
  x,
  y,
  width: w,
  height: h,
  version: 1,
  versionNonce: 1,
  ...extra,
});

describe('placeDiagram', () => {
  it('centers the diagram on the target and groups every element', () => {
    const els = [el('a', 0, 0, 100, 50), el('b', 200, 100, 100, 100, { groupIds: ['old'] })];
    const { add } = placeDiagram(els, undefined, { x: 1000, y: 500 }, 'g1');
    // bbox 0..300 × 0..200 → center (150,100) moves to (1000,500)
    expect(add?.[0]).toMatchObject({ x: 850, y: 400, groupIds: ['g1'] });
    expect(add?.[1]).toMatchObject({ x: 1050, y: 500, groupIds: ['old', 'g1'] });
  });

  it('keeps relative positions (arrows, bound text) and passes files through', () => {
    const els = [el('a', 10, 10, 10, 10), el('t', 12, 12, 4, 4, { containerId: 'a' })];
    const files = { f1: { id: 'f1', mimeType: 'image/svg+xml', dataURL: 'data:x', created: 1 } };
    const patch = placeDiagram(els, files, { x: 0, y: 0 }, 'g');
    const [a, t] = patch.add!;
    expect(Number(t!.x) - Number(a!.x)).toBe(2);
    expect(t!.containerId).toBe('a');
    expect(patch.files).toBe(files);
  });

  it('omits empty files and rejects an empty diagram', () => {
    expect(placeDiagram([el('a', 0, 0, 1, 1)], {}, { x: 0, y: 0 }, 'g').files).toBeUndefined();
    expect(() => placeDiagram([], undefined, { x: 0, y: 0 }, 'g')).toThrow('empty');
  });

  it('does not mutate the converted elements', () => {
    const a = el('a', 5, 5, 10, 10);
    placeDiagram([a], undefined, { x: 100, y: 100 }, 'g');
    expect(a.x).toBe(5);
    expect(a.groupIds).toBeUndefined();
  });
});

describe('mermaidPatch', () => {
  it('parses, converts and places', async () => {
    const parse = vi.fn().mockResolvedValue({ elements: [{ s: 1 }] });
    const convert = vi.fn().mockReturnValue([el('n', 0, 0, 20, 20)]);
    const patch = await mermaidPatch(
      'graph TD; A-->B',
      { x: 10, y: 10 },
      { parse, convert },
      'gid',
    );
    expect(parse).toHaveBeenCalledWith('graph TD; A-->B');
    expect(convert).toHaveBeenCalledWith([{ s: 1 }]);
    expect(patch.add?.[0]).toMatchObject({ x: 0, y: 0, groupIds: ['gid'] });
  });

  it('propagates converter errors and rejects empty input without parsing', async () => {
    const parse = vi.fn().mockRejectedValue(new Error('Parse error on line 1'));
    const convert = vi.fn();
    await expect(mermaidPatch('graph', { x: 0, y: 0 }, { parse, convert })).rejects.toThrow(
      'Parse error',
    );
    parse.mockClear();
    await expect(mermaidPatch('  ', { x: 0, y: 0 }, { parse, convert })).rejects.toThrow('empty');
    expect(parse).not.toHaveBeenCalled();
  });
});

describe('parseMermaid', () => {
  it('exports the real converter entry point', () => {
    expect(typeof parseMermaid).toBe('function');
  });
});
