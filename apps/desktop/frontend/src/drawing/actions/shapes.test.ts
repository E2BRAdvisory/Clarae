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

const run = (id: string, elements: SceneElement[], selected: string[], params = {}) =>
  actionById(id)!.run({ elements, selected, params });

describe('box-selected-elements', () => {
  it('adds one rectangle around the selection with the padding', () => {
    const els = [el('a', 'rectangle', 0, 0, 100, 50), el('b', 'ellipse', 200, 100, 50, 50)];
    const patch = run('box-selected-elements', els, ['a', 'b'], { padding: 10 });
    expect(patch.add).toHaveLength(1);
    expect(patch.add?.[0]).toMatchObject({
      type: 'rectangle',
      x: -10,
      y: -10,
      width: 270,
      height: 170,
      version: 1,
      isDeleted: false,
    });
    expect(patch.add?.[0]?.id).toMatch(/^[A-Za-z0-9]{21}$/);
  });

  it('ignores labels bound to a container and arrows', () => {
    const els = [
      el('a', 'rectangle', 0, 0, 100, 50),
      el('t', 'text', 500, 500, 10, 10, { containerId: 'a' }),
      el('r', 'arrow', 900, 900, 10, 10),
    ];
    const { add } = run('box-selected-elements', els, ['a', 't', 'r'], { padding: 0 });
    expect(add?.[0]).toMatchObject({ x: 0, y: 0, width: 100, height: 50 });
  });

  it('does nothing for an empty selection', () => {
    expect(run('box-selected-elements', [el('a', 'rectangle', 0, 0, 1, 1)], [])).toEqual({});
  });
});

describe('box-each-selected-group', () => {
  it('boxes each top-level group and skips ungrouped elements', () => {
    const els = [
      el('a', 'rectangle', 0, 0, 10, 10, { groupIds: ['g1'] }),
      el('b', 'rectangle', 20, 0, 10, 10, { groupIds: ['g1'] }),
      el('c', 'rectangle', 100, 100, 10, 10, { groupIds: ['inner', 'g2'] }),
      el('d', 'rectangle', 500, 500, 10, 10),
    ];
    const { add } = run('box-each-selected-group', els, ['a', 'b', 'c', 'd'], { padding: 5 });
    expect(add).toHaveLength(2);
    expect(add?.[0]).toMatchObject({ x: -5, y: -5, width: 40, height: 20 });
    expect(add?.[1]).toMatchObject({ x: 95, y: 95, width: 20, height: 20 });
  });
});

describe('ellipse-selected-elements', () => {
  it('circumscribes the box: both corners lie on (or inside) the ellipse', () => {
    const els = [el('a', 'rectangle', 0, 0, 200, 100)];
    const e = run('ellipse-selected-elements', els, ['a'], { padding: 0 }).add![0]!;
    const a = Number(e.width) / 2;
    const b = Number(e.height) / 2;
    const cx = Number(e.x) + a;
    const cy = Number(e.y) + b;
    for (const [px, py] of [
      [0, 0],
      [200, 0],
      [0, 100],
      [200, 100],
    ] as const)
      expect(((px - cx) / a) ** 2 + ((py - cy) / b) ** 2).toBeCloseTo(1, 5);
    expect([cx, cy]).toEqual([100, 50]);
  });
});

describe('change-shape', () => {
  it('turns shapes into the chosen one and ignores the rest', () => {
    const els = [
      el('r', 'rectangle', 0, 0, 1, 1),
      el('e', 'ellipse', 0, 0, 1, 1),
      el('t', 'text', 0, 0, 1, 1),
    ];
    const patch = run('change-shape', els, ['r', 'e', 't'], { shape: 1 });
    expect(Object.keys(patch.update!)).toEqual(['r']);
    const after = applyPatch(els, patch, () => 1, 1);
    expect(after[0]).toMatchObject({ type: 'ellipse', roundness: null });
    const back = applyPatch(after, run('change-shape', after, ['r'], { shape: 0 }), () => 1, 1);
    expect(back[0]).toMatchObject({ type: 'rectangle', roundness: { type: 3 } });
  });
});
