import { describe, expect, it } from 'vitest';
import { monthGrid, parseOutline, weekdayNames } from './generators';
import { PatchBuilder } from './geometry';
import { actionById } from './registry';
import { resample } from './scheme';
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

const text = (id: string, t: string, x = 0, y = 0, extra = {}) =>
  el(id, 'text', x, y, 100, 25, {
    text: t,
    originalText: t,
    fontSize: 20,
    containerId: null,
    ...extra,
  });

const run = (id: string, elements: SceneElement[], selected: string[], params = {}) =>
  actionById(id)!.run({ elements, selected, params });

describe('parseOutline', () => {
  it('builds the tree from indentation and strips bullets', () => {
    const t = parseOutline('Root\n  - A\n    - A1\n    - A2\n  * B\n');
    expect(t?.text).toBe('Root');
    expect(t?.children.map((c) => c.text)).toEqual(['A', 'B']);
    expect(t?.children[0]?.children.map((c) => c.text)).toEqual(['A1', 'A2']);
  });

  it('makes later unindented lines children of the first one', () => {
    const t = parseOutline('Root\nOne\nTwo');
    expect(t?.children.map((c) => c.text)).toEqual(['One', 'Two']);
  });

  it('returns null for blank input', () => {
    expect(parseOutline('  \n\n')).toBeNull();
  });
});

describe('mindmap-from-text', () => {
  const src = text('t', 'Root\n  A\n    A1\n  B', 100, 200);
  const patch = run('mindmap-from-text', [src], ['t']);

  it('replaces the text with a box and a label per node, and an arrow per edge', () => {
    expect(patch.remove).toEqual(['t']);
    const boxes = patch.add!.filter((e) => e.type === 'rectangle');
    const labels = patch.add!.filter((e) => e.type === 'text');
    const arrows = patch.add!.filter((e) => e.type === 'arrow');
    expect(boxes).toHaveLength(4);
    expect(labels.map((l) => l.text)).toEqual(['Root', 'A', 'A1', 'B']);
    expect(arrows).toHaveLength(3);
  });

  it('binds labels to their boxes and arrows to both ends', () => {
    const byId = new Map(patch.add!.map((e) => [e.id, e]));
    for (const l of patch.add!.filter((e) => e.type === 'text'))
      expect(
        (byId.get(l.containerId as string)!.boundElements as { id: string }[]).some(
          (b) => b.id === l.id,
        ),
      ).toBe(true);
    for (const a of patch.add!.filter((e) => e.type === 'arrow')) {
      const s = byId.get((a.startBinding as { elementId: string }).elementId)!;
      expect((s.boundElements as { id: string }[]).some((b) => b.id === a.id)).toBe(true);
    }
  });

  it('lays levels out left to right and centers the parent on its children', () => {
    const box = (name: string) =>
      patch.add!.find(
        (e) =>
          e.type === 'rectangle' &&
          patch.add!.some((l) => l.type === 'text' && l.text === name && l.containerId === e.id),
      )!;
    const [root, a, a1, b] = ['Root', 'A', 'A1', 'B'].map(box) as [
      SceneElement,
      SceneElement,
      SceneElement,
      SceneElement,
    ];
    expect(Number(a.x)).toBeGreaterThan(Number(root.x) + Number(root.width));
    expect(Number(a1.x)).toBeGreaterThan(Number(a.x));
    expect(Number(a.x)).toBe(Number(b.x));
    const cy = (e: SceneElement) => Number(e.y) + Number(e.height) / 2;
    expect(cy(root)).toBeCloseTo((cy(a) + cy(b)) / 2, 6);
    expect(cy(root)).toBeCloseTo(212.5, 6); // the source text's vertical center
  });

  it('does nothing for a text with no children', () => {
    expect(run('mindmap-from-text', [text('t', 'alone')], ['t'])).toEqual({});
  });
});

describe('calendars', () => {
  it('lays a month out by weekday', () => {
    // 2024-02 starts on a Thursday and has 29 days.
    const grid = monthGrid(2024, 1, 1, 'en').split('\n');
    expect(grid[0]).toBe('Mo Tu We Th Fr Sa Su');
    expect(grid[1]).toBe('          1  2  3  4');
    expect(grid.at(-1)).toBe('26 27 28 29');
    expect(weekdayNames(0, 'en')[0]).toBe('Su');
  });

  it('year calendar: twelve titled months', () => {
    const p = run('calendar-year', [], [], { year: 2024, firstDay: 1 });
    expect(p.add!.filter((e) => e.type === 'rectangle')).toHaveLength(24);
    expect(p.add!.filter((e) => e.type === 'text')).toHaveLength(24);
  });

  it('linear calendar: one cell per day of the year, weekends shaded', () => {
    const p = run('calendar-linear', [], [], { year: 2024, firstDay: 1 });
    const cells = p.add!.filter((e) => e.type === 'rectangle');
    expect(cells).toHaveLength(366);
    expect(cells.filter((c) => c.backgroundColor === '#e9ecef')).toHaveLength(104); // 2024 weekends
    expect(new Set(p.add!.map((e) => (e.groupIds as string[])[0])).size).toBe(1);
  });

  it('is placed around the screen center', () => {
    const p = actionById('comic-panels')!.run({
      elements: [],
      selected: [],
      origin: { x: 1000, y: 500 },
      params: { rows: 1, columns: 1, panelWidth: 200, panelHeight: 100 },
    });
    expect(p.add![0]).toMatchObject({ x: 900, y: 450 });
  });
});

describe('comic-panels / speech-bubble', () => {
  it('makes rows × columns panels', () => {
    expect(
      run('comic-panels', [], [], { rows: 2, columns: 3, panelWidth: 100, panelHeight: 80 }).add,
    ).toHaveLength(6);
  });

  it('puts a text in a bubble that contains it', () => {
    const t = text('t', 'hello', 100, 100);
    const p = run('speech-bubble', [t], ['t']);
    const bubble = p.add!.find((e) => e.type === 'ellipse')!;
    expect(p.update!.t).toMatchObject({ containerId: bubble.id });
    expect(Number(bubble.width)).toBeGreaterThan(100);
  });
});

describe('apply-color-scheme', () => {
  it('maps distinct colors in order and keeps equal colors equal', () => {
    const els = [
      el('a', 'rectangle', 0, 0, 1, 1, { strokeColor: '#000000', backgroundColor: '#ff0000' }),
      el('b', 'rectangle', 0, 0, 1, 1, { strokeColor: '#111111', backgroundColor: '#ff0000' }),
      el('c', 'rectangle', 0, 0, 1, 1, { strokeColor: '#000000', backgroundColor: 'transparent' }),
    ];
    const p = run('apply-color-scheme', els, ['a', 'b', 'c'], { scheme: 2 });
    expect(p.update!.a).toEqual({ strokeColor: '#1e1e1e', backgroundColor: '#f1f3f5' });
    expect(p.update!.b).toEqual({ strokeColor: '#495057', backgroundColor: '#f1f3f5' });
    expect(p.update!.c).toEqual({ strokeColor: '#1e1e1e' });
  });
});

describe('organic-line', () => {
  it('turns a line into a tapered freedraw stroke', () => {
    const line = el('l', 'line', 10, 20, 60, 0, {
      points: [
        [0, 0],
        [60, 0],
      ],
      strokeColor: '#e03131',
    });
    const p = run('organic-line', [line], ['l']);
    const s = p.add![0]!;
    expect(s).toMatchObject({ type: 'freedraw', x: 10, y: 20, strokeColor: '#e03131' });
    const pressures = s.pressures as number[];
    expect(pressures).toHaveLength((s.points as unknown[]).length);
    expect(pressures[0]).toBeLessThan(pressures[Math.floor(pressures.length / 2)]!);
    expect(p.remove).toEqual(['l']);
  });

  it('resamples a polyline with the ends kept', () => {
    expect(
      resample(
        [
          [0, 0],
          [12, 0],
        ],
        6,
      ),
    ).toEqual([
      [0, 0],
      [6, 0],
      [12, 0],
    ]);
  });
});

describe('resizing keeps bound arrows attached', () => {
  it('puts the arrow end back on the outline of the resized shape', () => {
    const box = el('b', 'rectangle', 200, 0, 100, 100);
    const arrow = el('a', 'arrow', 100, 50, 100, 0, {
      points: [
        [0, 0],
        [100, 0],
      ],
      startBinding: null,
      endBinding: { elementId: 'b', focus: 0, gap: 1 },
    });
    const pb = new PatchBuilder({ elements: [box, arrow], selected: ['b'] });
    pb.setBox(box, { x: 300, y: 0, width: 200, height: 100 });
    const upd = pb.build().update!.a as { x: number; points: [number, number][] };
    expect(upd.x).toBe(100); // the start stays
    expect(upd.points[1]![0]).toBeCloseTo(200, 6); // the end follows the new left edge (x = 300)
  });
});
