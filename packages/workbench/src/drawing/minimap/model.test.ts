import { describe, expect, it } from 'vitest';
import { boundsOf, MAX_PATH_POINTS, shapesOf, type MiniElement } from './model';

const el = (over: Partial<MiniElement>): MiniElement => ({
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  ...over,
});

describe('the shapes of the mini-map', () => {
  it('keeps the kind, the box and the colours of an element', () => {
    const [box, ellipse, text] = shapesOf(
      [
        el({ backgroundColor: '#ffc9c9' }),
        el({ type: 'ellipse', x: 200 }),
        el({ type: 'text', y: 300, strokeColor: 'transparent' }),
      ],
      '#000000',
    );
    expect(box).toMatchObject({ kind: 'box', w: 100, h: 50, stroke: '#1e1e1e', fill: '#ffc9c9' });
    expect(ellipse).toMatchObject({ kind: 'ellipse', x: 200, fill: null });
    // nothing to draw it with: the ink of the mini-map
    expect(text).toMatchObject({ kind: 'text', y: 300, stroke: '#000000' });
  });

  it('leaves out what was deleted', () => {
    expect(shapesOf([el({ isDeleted: true }), el({ x: 5 })], '#000')).toHaveLength(1);
  });

  it('draws a line through its points, in scene coordinates', () => {
    const [line] = shapesOf(
      [
        el({
          type: 'arrow',
          x: 10,
          y: 20,
          width: 100,
          height: 0,
          points: [
            [0, 0],
            [100, 0],
          ],
        }),
      ],
      '#000',
    );
    expect(line).toMatchObject({ kind: 'path', points: [10, 20, 110, 20] });
    expect(boundsOf([line!])).toEqual({ x: 10, y: 20, w: 100, h: 0 });
  });

  it('thins out a free-hand stroke, keeping both ends', () => {
    const points = Array.from({ length: 500 }, (_, i) => [i, i % 7] as const);
    const [stroke] = shapesOf([el({ type: 'freedraw', width: 499, height: 6, points })], '#000');
    if (stroke?.kind !== 'path') throw new Error('not a path');
    expect(stroke.points.length / 2).toBeLessThanOrEqual(MAX_PATH_POINTS + 1);
    expect(stroke.points.slice(0, 2)).toEqual([0, 0]);
    expect(stroke.points.slice(-2)).toEqual([499, 499 % 7]);
  });

  it('turns a line with its element', () => {
    const [line] = shapesOf(
      [
        el({
          type: 'line',
          width: 100,
          height: 0,
          angle: Math.PI / 2,
          points: [
            [0, 0],
            [100, 0],
          ],
        }),
      ],
      '#000',
    );
    if (line?.kind !== 'path') throw new Error('not a path');
    // a horizontal line about (50, 0), turned a quarter: vertical through (50, 0)
    expect(line.points[0]).toBeCloseTo(50);
    expect(line.points[1]).toBeCloseTo(-50);
    expect(line.points[2]).toBeCloseTo(50);
    expect(line.points[3]).toBeCloseTo(50);
  });

  it('boxes the whole drawing, rotations included, and nothing for an empty one', () => {
    expect(boundsOf([])).toBeNull();
    const all = boundsOf(shapesOf([el({}), el({ x: 300, y: 100, width: 40, height: 40 })], '#000'));
    expect(all).toEqual({ x: 0, y: 0, w: 340, h: 140 });
  });
});
