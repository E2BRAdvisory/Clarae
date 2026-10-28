import { describe, expect, it } from 'vitest';
import { applyPatch } from './apply';
import { layersOf } from './autolayout';
import { actionById } from './registry';
import type { SceneElement } from './types';

const box = (id: string, x: number, y: number, w = 100, h = 50): SceneElement => ({
  id,
  type: 'rectangle',
  x,
  y,
  width: w,
  height: h,
  version: 1,
  versionNonce: 1,
});
const link = (id: string, from: string, to: string, x = 0, y = 0): SceneElement => ({
  id,
  type: 'arrow',
  x,
  y,
  width: 10,
  height: 0,
  points: [
    [0, 0],
    [10, 0],
  ],
  startBinding: { elementId: from },
  endBinding: { elementId: to },
  version: 1,
  versionNonce: 1,
});

describe('layersOf', () => {
  it('uses the longest path from the roots', () => {
    const l = layersOf(
      ['a', 'b', 'c', 'x', 'd'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['a', 'c'],
        ['x', 'd'],
      ],
    );
    expect([l.get('a'), l.get('b'), l.get('c'), l.get('x'), l.get('d')]).toEqual([0, 1, 2, 0, 1]);
  });

  it('breaks loops instead of spinning', () => {
    const l = layersOf(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ],
    );
    expect([l.get('a'), l.get('b'), l.get('c')]).toEqual([0, 1, 2]);
  });

  it('ignores self loops', () => {
    expect(layersOf(['a'], [['a', 'a']]).get('a')).toBe(0);
  });
});

describe('auto-layout', () => {
  const run = (els: SceneElement[], selected: string[], params = { hgap: 50, vgap: 20 }) => {
    const patch = actionById('auto-layout')!.run({ elements: els, selected, params });
    return applyPatch(els, patch, () => 1, 1);
  };
  const at = (els: SceneElement[], id: string) => els.find((e) => e.id === id)!;

  it('lines a chain up in columns, left to right, with the horizontal gap', () => {
    const els = [
      box('c', 0, 0),
      box('b', 300, 300),
      box('a', 600, 100),
      link('l1', 'a', 'b'),
      link('l2', 'b', 'c'),
    ];
    const out = run(els, ['a', 'b', 'c']);
    // a → b → c: a is the root (column 0), then b, then c.
    expect(at(out, 'a').x).toBe(0);
    expect(at(out, 'b').x).toBe(150);
    expect(at(out, 'c').x).toBe(300);
  });

  it('stacks the nodes of one layer with the vertical gap, centered on the selection', () => {
    const els = [
      box('root', 0, 0),
      box('p', 500, 0),
      box('q', 500, 400),
      link('l1', 'root', 'p'),
      link('l2', 'root', 'q'),
    ];
    const out = run(els, ['root', 'p', 'q']);
    expect(at(out, 'p').x).toBe(at(out, 'q').x);
    const [top, bottom] = [at(out, 'p'), at(out, 'q')].sort((m, n) => Number(m.y) - Number(n.y));
    expect(Number(bottom!.y) - Number(top!.y)).toBe(50 + 20); // height + vgap
  });

  it('keeps arrows attached: the bound end moves by the same amount as its shape', () => {
    // The arrow ends at x = 110 while b sits at x = 500: whatever b moves by, its end follows.
    const els = [box('a', 0, 0), box('b', 500, 200), link('l', 'a', 'b', 100, 25)];
    const out = run(els, ['a', 'b']);
    const arrow = at(out, 'l');
    const moved = Number(at(out, 'b').x) - 500;
    expect(moved).not.toBe(0);
    expect(Number(arrow.x) + (arrow.points as number[][])[1]![0]!).toBeCloseTo(110 + moved, 6);
    expect(arrow.x).toBe(100); // a did not move: the start stays
  });

  it('does nothing for a single shape', () => {
    expect(
      actionById('auto-layout')!.run({ elements: [box('a', 0, 0)], selected: ['a'], params: {} }),
    ).toEqual({});
  });
});
