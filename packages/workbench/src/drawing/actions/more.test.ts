import { describe, expect, it } from 'vitest';
import { applyPatch } from './apply';
import { simplify } from './misc';
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

const text = (id: string, t: string, x: number, y: number, extra = {}) =>
  el(id, 'text', x, y, 100, 25 * t.split('\n').length, {
    text: t,
    originalText: t,
    fontSize: 20,
    fontFamily: 5,
    textAlign: 'left',
    containerId: null,
    strokeColor: '#e03131',
    ...extra,
  });

const run = (id: string, elements: SceneElement[], selected: string[], params = {}) =>
  actionById(id)!.run({ elements, selected, params });

describe('split-text-by-lines', () => {
  it('makes one text per non-empty line, stacked, with the same style', () => {
    const t = text('t', 'one\n\ntwo\nthree', 10, 100);
    const patch = run('split-text-by-lines', [t], ['t']);
    expect(patch.add!.map((e) => e.text)).toEqual(['one', 'two', 'three']);
    expect(patch.add!.map((e) => e.y)).toEqual([100, 150, 175]); // line height 25, blank line kept as space
    expect(patch.add![0]).toMatchObject({
      x: 10,
      strokeColor: '#e03131',
      fontSize: 20,
      containerId: null,
    });
    expect(patch.remove).toEqual(['t']);
  });

  it('leaves single-line texts and bound labels alone', () => {
    const single = text('s', 'only one line', 0, 0);
    const label = text('l', 'a\nb', 0, 0, { containerId: 'box' });
    expect(run('split-text-by-lines', [single, label], ['s', 'l'])).toEqual({});
  });
});

describe('concatenate-lines', () => {
  it('joins the texts top to bottom at the first one', () => {
    const els = [
      text('b', 'second', 50, 200),
      text('a', 'first', 10, 100),
      text('c', 'third', 0, 300),
    ];
    const patch = run('concatenate-lines', els, ['a', 'b', 'c']);
    expect(patch.add).toHaveLength(1);
    expect(patch.add![0]).toMatchObject({ text: 'first\nsecond\nthird', x: 10, y: 100 });
    expect(patch.remove).toEqual(['a', 'b', 'c']);
  });
});

describe('text-to-sticky-notes', () => {
  it('puts each text in a note: the note is its container, centered on the text', () => {
    const t = text('t', 'hi', 100, 100);
    const patch = run('text-to-sticky-notes', [t], ['t']);
    const note = patch.add![0]!;
    expect(note).toMatchObject({ type: 'rectangle', boundElements: [{ id: 't', type: 'text' }] });
    expect(patch.update!.t).toMatchObject({
      containerId: note.id,
      textAlign: 'center',
      verticalAlign: 'middle',
    });
    const cx = Number(note.x) + Number(note.width) / 2;
    expect(cx).toBeCloseTo(150, 6); // text center x = 100 + 100/2
  });
});

describe('convert-text-to-link', () => {
  it('links to the note named by the first line, without wikilink syntax characters', () => {
    const patch = run(
      'convert-text-to-link',
      [text('t', 'My [note]|x\nmore', 0, 0), text('e', '  ', 0, 0)],
      ['t', 'e'],
    );
    expect(patch.update).toEqual({ t: { link: '[[My notex]]' } });
  });
});

describe('repeat-elements', () => {
  it('adds N offset copies with new ids, keeping container and label together', () => {
    const box = el('b', 'rectangle', 0, 0, 100, 50, {
      boundElements: [
        { id: 'l', type: 'text' },
        { id: 'ar', type: 'arrow' },
      ],
      groupIds: ['g'],
    });
    const label = text('l', 'x', 10, 10, { containerId: 'b' });
    const patch = run('repeat-elements', [box, label], ['b'], { copies: 2, dx: 100, dy: 10 });
    expect(patch.add).toHaveLength(4); // 2 copies × (box + label)
    const [b1, l1, b2] = patch.add!;
    expect(b1).toMatchObject({ x: 100, y: 10, startBinding: null });
    expect(b2).toMatchObject({ x: 200, y: 20 });
    expect(l1).toMatchObject({ containerId: b1!.id, x: 110, y: 20 });
    expect(b1!.boundElements).toEqual([{ id: l1!.id, type: 'text' }]); // the arrow ref is dropped
    expect(new Set(patch.add!.map((e) => e.id)).size).toBe(4);
    expect(b1!.id).not.toBe('b');
    // copies of a group form a new group, not the original one
    expect(b1!.groupIds).not.toEqual(['g']);
    expect(b1!.groupIds).toHaveLength(1);
  });

  it('ignores arrows and caps the number of copies', () => {
    const arrow = el('a', 'arrow', 0, 0, 10, 10);
    expect(run('repeat-elements', [arrow], ['a'])).toEqual({});
    const box = el('b', 'rectangle', 0, 0, 1, 1);
    expect(run('repeat-elements', [box], ['b'], { copies: 1000 }).add).toHaveLength(100);
  });
});

describe('convert-freedraw-to-line', () => {
  it('simplifies the stroke into a line with the same style', () => {
    const pts: [number, number][] = Array.from({ length: 101 }, (_, i) => [
      i,
      i % 2 === 0 ? 0 : 0.5,
    ]);
    const f = el('f', 'freedraw', 10, 20, 100, 1, { points: pts, strokeColor: '#1971c2' });
    const patch = run('convert-freedraw-to-line', [f], ['f'], { tolerance: 2 });
    const line = patch.add![0]!;
    expect(line.type).toBe('line');
    expect(line.points).toEqual([
      [0, 0],
      [100, 0],
    ]);
    expect(line).toMatchObject({ x: 10, y: 20, strokeColor: '#1971c2' });
    expect(patch.remove).toEqual(['f']);
  });
});

describe('simplify', () => {
  it('keeps corners and drops collinear points', () => {
    expect(
      simplify(
        [
          [0, 0],
          [5, 0],
          [10, 0],
          [10, 10],
        ],
        0.1,
      ),
    ).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(
      simplify(
        [
          [0, 0],
          [1, 1],
        ],
        1,
      ),
    ).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe('view actions', () => {
  const a = el('a', 'rectangle', 0, 0, 10, 10, {
    strokeColor: '#e03131',
    backgroundColor: '#ffc9c9',
    fillStyle: 'hachure',
    strokeWidth: 4,
  });
  const t = el('t', 'text', 0, 0, 10, 10);

  it('zoom-to-fit-selected asks to bring the selection into view', () => {
    expect(run('zoom-to-fit-selected', [a, t], ['a']).view).toEqual({ zoomTo: ['a'] });
  });

  it('toggle-grid and set-grid-size only touch the view', () => {
    expect(run('toggle-grid', [a], []).view).toEqual({ toggleGrid: true });
    expect(run('set-grid-size', [a], [], { gridSize: 10.4 }).view).toEqual({
      appState: { gridSize: 10, gridModeEnabled: true },
    });
    expect(run('toggle-grid', [a], [])).not.toHaveProperty('update');
  });

  it('select-elements-of-type selects the live elements of that type', () => {
    const els = [
      a,
      el('b', 'rectangle', 0, 0, 1, 1),
      el('g', 'rectangle', 0, 0, 1, 1, { isDeleted: true }),
      t,
    ];
    expect(run('select-elements-of-type', els, [], { elementType: 0 }).view).toEqual({
      select: ['a', 'b'],
    });
    expect(run('select-elements-of-type', els, [], { elementType: 1 })).toEqual({}); // no ellipse
  });

  it('copy-styles-to-defaults maps the element style to the editor defaults', () => {
    expect(run('copy-styles-to-defaults', [a], ['a']).view?.appState).toEqual({
      currentItemStrokeColor: '#e03131',
      currentItemBackgroundColor: '#ffc9c9',
      currentItemFillStyle: 'hachure',
      currentItemStrokeWidth: 4,
    });
  });

  it('view actions need no element change to be applied', () => {
    const patch = run('toggle-grid', [a], []);
    expect(applyPatch([a], patch, () => 1, 1)[0]).toBe(a);
  });
});
