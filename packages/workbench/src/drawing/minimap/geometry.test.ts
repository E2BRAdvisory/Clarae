import { describe, expect, it } from 'vitest';
import {
  fitTransform,
  miniBox,
  panBy,
  rotatedBox,
  scrollForCenter,
  toMini,
  toScene,
  union,
  visibleBox,
  worldBounds,
  type View,
} from './geometry';

const view: View = { scrollX: -100, scrollY: 50, zoom: 2, width: 800, height: 600 };

describe('the geometry of the mini-map', () => {
  it('reads the part of the scene on screen from scroll, zoom and canvas size', () => {
    expect(visibleBox(view)).toEqual({ x: 100, y: -50, w: 400, h: 300 });
  });

  it('boxes a rotated rectangle', () => {
    expect(rotatedBox(0, 0, 100, 40, 0)).toEqual({ x: 0, y: 0, w: 100, h: 40 });
    const quarter = rotatedBox(0, 0, 100, 40, Math.PI / 2);
    expect(quarter.w).toBeCloseTo(40);
    expect(quarter.h).toBeCloseTo(100);
    expect(quarter.x).toBeCloseTo(30);
    expect(quarter.y).toBeCloseTo(-30);
  });

  it('shows the drawing and the view together, with a margin', () => {
    const content = { x: 0, y: 0, w: 200, h: 100 };
    const far = { x: 1000, y: 0, w: 400, h: 300 };
    expect(union(content, far)).toEqual({ x: 0, y: 0, w: 1400, h: 300 });
    const world = worldBounds(content, far, 0.1);
    expect(world).toEqual({ x: -140, y: -140, w: 1680, h: 580 });
    // an empty drawing: the view alone
    expect(worldBounds(null, far, 0)).toEqual(far);
  });

  it('fits the world in the picture, centred, and maps there and back', () => {
    const t = fitTransform({ x: -100, y: -100, w: 400, h: 200 }, { w: 220, h: 150 });
    expect(t.scale).toBeCloseTo(0.55);
    // the world is as wide as the picture and centred in its height
    expect(toMini(t, { x: -100, y: -100 }).x).toBeCloseTo(0);
    expect(toMini(t, { x: -100, y: -100 }).y).toBeCloseTo(20);
    expect(toMini(t, { x: 300, y: 100 }).x).toBeCloseTo(220);
    expect(toMini(t, { x: 300, y: 100 }).y).toBeCloseTo(130);
    const p = { x: 37.5, y: -12.25 };
    const back = toScene(t, toMini(t, p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
    const b = miniBox(t, { x: 0, y: 0, w: 100, h: 50 });
    expect(b.w).toBeCloseTo(55);
    expect(b.h).toBeCloseTo(27.5);
  });

  it('centres the view on a point of the scene, at the zoom it has', () => {
    const scroll = scrollForCenter({ x: 500, y: 300 }, view);
    const box = visibleBox({ ...view, ...scroll });
    expect(box.x + box.w / 2).toBeCloseTo(500);
    expect(box.y + box.h / 2).toBeCloseTo(300);
  });

  it('pans by a share of the screen', () => {
    const next = visibleBox({ ...view, ...panBy(view, 0.5, -0.1) });
    expect(next.x).toBeCloseTo(100 + 200);
    expect(next.y).toBeCloseTo(-50 - 30);
  });
});
