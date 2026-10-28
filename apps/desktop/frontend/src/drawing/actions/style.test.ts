import { describe, expect, it } from 'vitest';
import { applyPatch } from './apply';
import { formatColor, invertColor, parseColor, shiftLightness, withAlpha } from './color';
import { actionById } from './registry';
import type { SceneElement } from './types';

const el = (id: string, type: string, extra: Record<string, unknown> = {}): SceneElement => ({
  id,
  type,
  version: 1,
  versionNonce: 1,
  ...extra,
});
const run = (id: string, elements: SceneElement[], selected: string[], params = {}) => {
  const patch = actionById(id)!.run({ elements, selected, params });
  return { patch, after: applyPatch(elements, patch, () => 1, 1) };
};

describe('color helpers', () => {
  it('parses and formats hex colors', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#ff000080')?.a).toBeCloseTo(0.5, 2);
    expect(parseColor('transparent')).toBeNull();
    expect(parseColor('red')).toBeNull();
    expect(parseColor(undefined)).toBeNull();
    expect(formatColor({ r: 255, g: 0, b: 16, a: 1 })).toBe('#ff0010');
    expect(formatColor({ r: 0, g: 0, b: 0, a: 0.5 })).toBe('#00000080');
  });

  it('shifts lightness keeping hue and alpha', () => {
    expect(shiftLightness('#ff0000', 0.2)).toBe('#ff6666');
    expect(shiftLightness('#ff0000', -0.2)).toBe('#990000');
    expect(shiftLightness('#ffffff', 0.3)).toBe('#ffffff');
    expect(shiftLightness('#00000080', 0.5)).toBe('#80808080');
    expect(shiftLightness('transparent', 0.1)).toBeNull();
  });

  it('sets alpha and inverts', () => {
    expect(withAlpha('#336699', 0.5)).toBe('#33669980');
    expect(withAlpha('#33669980', 1)).toBe('#336699');
    expect(invertColor('#ffffff')).toBe('#000000');
    expect(invertColor('#1e1e1e80')).toBe('#e1e1e180');
  });
});

describe('style actions', () => {
  it('darken/lighten move the background and skip transparent ones', () => {
    const els = [
      el('a', 'rectangle', { backgroundColor: '#ff0000' }),
      el('b', 'rectangle', { backgroundColor: 'transparent' }),
    ];
    const dark = run('darken-background', els, ['a', 'b'], { percent: 20 });
    expect(Object.keys(dark.patch.update!)).toEqual(['a']);
    expect(dark.after[0]?.backgroundColor).toBe('#990000');
    expect(run('lighten-background', els, ['a'], { percent: 20 }).after[0]?.backgroundColor).toBe(
      '#ff6666',
    );
  });

  it('background-opacity writes the alpha channel', () => {
    const { after } = run(
      'background-opacity',
      [el('a', 'rectangle', { backgroundColor: '#336699' })],
      ['a'],
      {
        opacityPercent: 50,
      },
    );
    expect(after[0]?.backgroundColor).toBe('#33669980');
  });

  it('invert-colors changes both colors and is its own inverse', () => {
    const els = [el('a', 'rectangle', { strokeColor: '#1e1e1e', backgroundColor: 'transparent' })];
    const once = run('invert-colors', els, ['a']);
    expect(once.after[0]).toMatchObject({ strokeColor: '#e1e1e1', backgroundColor: 'transparent' });
    const twice = run('invert-colors', once.after, ['a']);
    expect(twice.after[0]?.strokeColor).toBe('#1e1e1e');
  });

  it('writes nothing when nothing changes', () => {
    const els = [
      el('a', 'rectangle', { strokeColor: 'transparent', backgroundColor: 'transparent' }),
    ];
    expect(run('invert-colors', els, ['a']).patch.update).toEqual({});
    expect(
      run('set-stroke-width', [el('s', 'rectangle', { strokeWidth: 2 })], ['s'], { strokeWidth: 2 })
        .patch.update,
    ).toEqual({});
  });

  it('set-stroke-width sets the asked width', () => {
    const { after } = run('set-stroke-width', [el('s', 'line', { strokeWidth: 1 })], ['s'], {
      strokeWidth: 4,
    });
    expect(after[0]?.strokeWidth).toBe(4);
  });

  it('font and alignment only touch text', () => {
    const els = [el('t', 'text', { fontFamily: 1, textAlign: 'left' }), el('r', 'rectangle')];
    expect(run('set-font-family', els, ['t', 'r'], { fontFamily: 6 }).after[0]?.fontFamily).toBe(6);
    const aligned = run('set-text-alignment', els, ['t', 'r'], { textAlign: 2 });
    expect(aligned.after[0]?.textAlign).toBe('right');
    expect(Object.keys(aligned.patch.update!)).toEqual(['t']);
  });

  it('every action with options declares unique values', () => {
    for (const id of ['set-font-family', 'set-text-alignment']) {
      const opts = actionById(id)!.params![0]!.options!;
      expect(new Set(opts.map((o) => o.value)).size).toBe(opts.length);
    }
  });
});
