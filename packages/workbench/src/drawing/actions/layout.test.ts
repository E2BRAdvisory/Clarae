import { describe, expect, it } from 'vitest';
import { applyPatch } from './apply';
import { actionById } from './registry';
import type { SceneElement } from './types';

const box = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Record<string, unknown> = {},
  type = 'rectangle',
): SceneElement => ({ id, type, x, y, width, height, version: 1, versionNonce: 1, ...extra });

const run = (id: string, elements: SceneElement[], selected: string[], params = {}) => {
  const patch = actionById(id)!.run({ elements, selected, params });
  return { patch, after: applyPatch(elements, patch, () => 1, 1) };
};
const pos = (els: SceneElement[], id: string) => {
  const e = els.find((x) => x.id === id)!;
  return [e.x, e.y, e.width, e.height] as number[];
};

describe('fixed spacing', () => {
  const els = [box('a', 0, 0, 100, 50), box('b', 400, 10, 60, 50), box('c', 130, 20, 80, 50)];

  it('chains elements after the first with the gap, by position', () => {
    const { after } = run('fixed-spacing-horizontal', els, ['a', 'b', 'c'], { gap: 20 });
    expect(pos(after, 'a')).toEqual([0, 0, 100, 50]);
    expect(pos(after, 'c')).toEqual([120, 20, 80, 50]);
    expect(pos(after, 'b')).toEqual([220, 10, 60, 50]);
  });

  it('works vertically', () => {
    const { after } = run('fixed-spacing-vertical', els, ['a', 'b', 'c'], { gap: 10 });
    expect(pos(after, 'a')[1]).toBe(0);
    expect(pos(after, 'b')[1]).toBe(60);
    expect(pos(after, 'c')[1]).toBe(120);
  });

  it('moves bound text with its container and ignores it as an element', () => {
    const withText = [
      box('a', 0, 0, 100, 50),
      box('b', 300, 0, 100, 50, { boundElements: [{ id: 't', type: 'text' }] }),
      box('t', 320, 15, 60, 20, { containerId: 'b' }, 'text'),
    ];
    const { after } = run('fixed-spacing-horizontal', withText, ['a', 'b', 't'], { gap: 20 });
    expect(pos(after, 'b')[0]).toBe(120);
    expect(pos(after, 't')[0]).toBe(140); // moved by the same -180
  });

  it('writes nothing when already spaced', () => {
    const ok = [box('a', 0, 0, 100, 50), box('b', 120, 0, 100, 50)];
    const { patch } = run('fixed-spacing-horizontal', ok, ['a', 'b'], { gap: 20 });
    expect(patch.update).toEqual({});
  });
});

describe('fixed distance between centers', () => {
  it('spaces centers evenly, keeping the first', () => {
    const els = [box('a', 0, 0, 100, 50), box('b', 500, 0, 40, 50)];
    const { after } = run('fixed-distance-centers-horizontal', els, ['a', 'b'], { distance: 200 });
    expect(pos(after, 'a')[0]).toBe(0);
    expect((pos(after, 'b')[0] ?? 0) + 20).toBe(250); // center at 50 + 200
  });
});

describe('expand rectangles', () => {
  const els = [
    box('a', 0, 0, 100, 40),
    box('b', 0, 100, 60, 40, { boundElements: [{ id: 't', type: 'text' }] }),
    box('t', 10, 110, 40, 20, { containerId: 'b' }, 'text'),
  ];

  it('widens to the largest and re-centers the text when asked', () => {
    const { after } = run('expand-rectangles-horizontal-centered', els, ['a', 'b', 't'], {});
    expect(pos(after, 'b')).toEqual([0, 100, 100, 40]);
    expect(pos(after, 't')[0]).toBe(30);
  });

  it('leaves the text alone otherwise', () => {
    const { after } = run('expand-rectangles-horizontal', els, ['a', 'b', 't'], {});
    expect(pos(after, 'b')[2]).toBe(100);
    expect(pos(after, 't')[0]).toBe(10);
  });

  it('expands vertically', () => {
    const tall = [box('a', 0, 0, 10, 80), box('b', 20, 0, 10, 30)];
    const { after } = run('expand-rectangles-vertical', tall, ['a', 'b'], {});
    expect(pos(after, 'b')[3]).toBe(80);
  });
});

describe('set dimensions and position', () => {
  it('applies the answers to the first selected element', () => {
    const { after } = run('set-dimensions-position', [box('a', 1, 2, 3, 4)], ['a'], {
      x: 10,
      y: 20,
      width: 300,
      height: 400,
    });
    expect(pos(after, 'a')).toEqual([10, 20, 300, 400]);
  });

  it('defaults each question to the current value', () => {
    const spec = actionById('set-dimensions-position')!.params!;
    const ctx = { elements: [box('a', 1.4, 2, 3, 4)], selected: ['a'] };
    expect(spec.map((p) => (typeof p.default === 'function' ? p.default(ctx) : p.default))).toEqual(
      [1, 2, 3, 4],
    );
  });
});

describe('golden ratio', () => {
  it('sets height to width / φ on shapes only', () => {
    const els = [box('a', 0, 0, 161.8, 10), box('b', 0, 0, 100, 100, {}, 'text')];
    const { after } = run('golden-ratio', els, ['a', 'b']);
    expect(pos(after, 'a')[3]).toBe(100);
    expect(pos(after, 'b')[3]).toBe(100);
  });
});

describe('grid images', () => {
  it('wraps into rows at the column count with row heights', () => {
    const imgs = [
      box('1', 0, 0, 100, 50, {}, 'image'),
      box('2', 300, 0, 80, 70, {}, 'image'),
      box('3', 0, 200, 60, 40, {}, 'image'),
    ];
    const { after } = run('grid-images', imgs, ['1', '2', '3'], { columns: 2, gap: 10 });
    expect(pos(after, '1').slice(0, 2)).toEqual([0, 0]);
    expect(pos(after, '2').slice(0, 2)).toEqual([110, 0]);
    expect(pos(after, '3').slice(0, 2)).toEqual([0, 80]);
  });
});

describe('bound arrows follow moved shapes', () => {
  const a = box('a', 0, 0, 100, 50);
  const b = box('b', 300, 0, 100, 50);
  const link = (extra: Record<string, unknown> = {}): SceneElement => ({
    id: 'l',
    type: 'arrow',
    x: 100,
    y: 25,
    width: 200,
    height: 0,
    points: [
      [0, 0],
      [200, 0],
    ],
    startBinding: { elementId: 'a', focus: 0, gap: 1 },
    endBinding: { elementId: 'b', focus: 0, gap: 1 },
    version: 1,
    versionNonce: 1,
    ...extra,
  });

  it('moves the bound end with the shape and leaves the other end in place', () => {
    // b moves from x=300 to x=120+... a stays first, gap 20: b goes to x=120.
    const { after } = run('fixed-spacing-horizontal', [a, b, link()], ['a', 'b'], { gap: 20 });
    const l = after.find((e) => e.id === 'l')!;
    // b moved by -180: the end point moves by -180 relative to the unchanged start.
    expect(l.x).toBe(100);
    expect(l.points).toEqual([
      [0, 0],
      [20, 0],
    ]);
    expect(l.width).toBe(20);
  });

  it('moves the arrow with its start shape and keeps the end where it was', () => {
    const second = box('a2', 250, 0, 100, 50);
    const arrowFromSecond = link({
      startBinding: { elementId: 'a2', focus: 0, gap: 1 },
      endBinding: null,
    });
    const { after } = run('fixed-spacing-horizontal', [a, second, arrowFromSecond], ['a', 'a2'], {
      gap: 0,
    });
    // a2 moves from 250 to 100 (dx = -150): start follows; the free end stays at x=300.
    const l = after.find((e) => e.id === 'l')!;
    expect(l.x).toBe(-50);
    expect(l.points).toEqual([
      [0, 0],
      [350, 0],
    ]);
  });

  it('does not arrange arrows themselves', () => {
    const { patch } = run('fixed-spacing-horizontal', [a, b, link()], ['a', 'b', 'l'], { gap: 20 });
    expect(patch.update!.l).toMatchObject({
      points: [
        [0, 0],
        [20, 0],
      ],
    });
    expect(patch.update!.l).not.toHaveProperty('startBinding');
  });
});
