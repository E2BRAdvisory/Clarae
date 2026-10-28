import { describe, expect, it } from 'vitest';
import { applyPatch } from './apply';
import { actionById } from './registry';
import type { SceneElement } from './types';

const el = (
  id: string,
  type: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Record<string, unknown> = {},
): SceneElement => ({ id, type, x, y, width: w, height: h, version: 1, versionNonce: 1, ...extra });

const arrow = (id: string, x: number, y: number, points: [number, number][], extra = {}) =>
  el(id, 'arrow', x, y, 0, 0, { points, ...extra });

const run = (id: string, elements: SceneElement[], selected: string[], params = {}) =>
  actionById(id)!.run({ elements, selected, params });

describe('connect-elements', () => {
  const a = el('a', 'rectangle', 0, 0, 100, 60);
  const b = el('b', 'ellipse', 300, 0, 100, 60);
  const c = el('c', 'rectangle', 600, 0, 100, 60);

  it('adds a bound arrow between two shapes, on their outlines', () => {
    const patch = run('connect-elements', [a, b], ['b', 'a']);
    const arrowEl = patch.add![0]!;
    expect(arrowEl).toMatchObject({ type: 'arrow', endArrowhead: 'arrow', startArrowhead: null });
    expect(arrowEl.startBinding).toMatchObject({ elementId: 'a' });
    expect(arrowEl.endBinding).toMatchObject({ elementId: 'b' });
    // Center line y = 30: leaves a's right edge (x=100) and reaches b's left edge (x=300).
    expect([arrowEl.x, arrowEl.y]).toEqual([100, 30]);
    expect(arrowEl.points).toEqual([
      [0, 0],
      [200, 0],
    ]);
    expect(patch.update!.a!.boundElements).toEqual([{ id: arrowEl.id, type: 'arrow' }]);
    expect(patch.update!.b!.boundElements).toEqual([{ id: arrowEl.id, type: 'arrow' }]);
  });

  it('chains three shapes in reading order and keeps existing bindings', () => {
    const withRef = el('b', 'ellipse', 300, 0, 100, 60, {
      boundElements: [{ id: 'old', type: 'text' }],
    });
    const patch = run('connect-elements', [c, withRef, a], ['a', 'b', 'c']);
    expect(patch.add).toHaveLength(2);
    expect((patch.add![0]!.startBinding as { elementId: string }).elementId).toBe('a');
    expect((patch.add![1]!.endBinding as { elementId: string }).elementId).toBe('c');
    expect((patch.update!.b!.boundElements as unknown[]).length).toBe(3); // old + two arrows
  });

  it('needs two shapes', () => {
    expect(run('connect-elements', [a], ['a'])).toEqual({});
  });
});

describe('elbow-connectors', () => {
  it('routes horizontally first when the arrow is mostly horizontal', () => {
    const els = [
      arrow('r', 0, 0, [
        [0, 0],
        [100, 40],
      ]),
    ];
    const p = applyPatch(els, run('elbow-connectors', els, ['r']), () => 1, 1)[0]!;
    expect(p.points).toEqual([
      [0, 0],
      [50, 0],
      [50, 40],
      [100, 40],
    ]);
    expect(p).toMatchObject({ width: 100, height: 40, roundness: null });
  });

  it('routes vertically first when mostly vertical', () => {
    const els = [
      arrow('r', 0, 0, [
        [0, 0],
        [20, 100],
      ]),
    ];
    const p = applyPatch(els, run('elbow-connectors', els, ['r']), () => 1, 1)[0]!;
    expect(p.points).toEqual([
      [0, 0],
      [0, 50],
      [20, 50],
      [20, 100],
    ]);
  });
});

describe('normalize-arrows', () => {
  it('straightens to the dominant axis, dropping bends', () => {
    const els = [
      arrow('h', 0, 0, [
        [0, 0],
        [50, 10],
        [100, 7],
      ]),
      arrow('v', 0, 0, [
        [0, 0],
        [5, 80],
      ]),
    ];
    const after = applyPatch(els, run('normalize-arrows', els, ['h', 'v']), () => 1, 1);
    expect(after[0]!.points).toEqual([
      [0, 0],
      [100, 0],
    ]);
    expect(after[1]!.points).toEqual([
      [0, 0],
      [0, 80],
    ]);
  });
});

describe('add-connector-point', () => {
  it('inserts a vertex in the middle of the longest segment', () => {
    const els = [
      arrow('a', 0, 0, [
        [0, 0],
        [10, 0],
        [110, 0],
      ]),
    ];
    const p = applyPatch(els, run('add-connector-point', els, ['a']), () => 1, 1)[0]!;
    expect(p.points).toEqual([
      [0, 0],
      [10, 0],
      [60, 0],
      [110, 0],
    ]);
  });
});

describe('add-next-step', () => {
  it('copies the shape to the right with a joining arrow', () => {
    const src = el('s', 'rectangle', 0, 0, 100, 60, {
      backgroundColor: '#ffc9c9',
      boundElements: [],
    });
    const patch = run('add-next-step', [src], ['s'], { gap: 50 });
    const [copy, link] = patch.add!;
    expect(copy).toMatchObject({
      type: 'rectangle',
      x: 150,
      y: 0,
      backgroundColor: '#ffc9c9',
      version: 1,
    });
    expect(copy!.id).not.toBe('s');
    expect(link).toMatchObject({ type: 'arrow' });
    expect((link!.endBinding as { elementId: string }).elementId).toBe(copy!.id);
    expect(copy!.boundElements).toEqual([{ id: link!.id, type: 'arrow' }]);
    expect(patch.update!.s!.boundElements).toEqual([{ id: link!.id, type: 'arrow' }]);
  });
});
