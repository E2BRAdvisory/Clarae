import { describe, expect, it } from 'vitest';
import {
  comboFromEvent,
  comboIndex,
  effectiveCombos,
  formatCombo,
  normalizeCombo,
} from './hotkeys';

const ev = (o: Partial<KeyboardEvent> & { key: string }) => ({
  code: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...o,
});

describe('hotkeys', () => {
  it('normalizes combos', () => {
    expect(normalizeCombo('shift-mod-P')).toBe('Mod-Shift-p');
    expect(normalizeCombo('Mod-Alt-Shift-ArrowLeft')).toBe('Mod-Alt-Shift-ArrowLeft');
    expect(normalizeCombo('mod--')).toBe('Mod--');
    expect(normalizeCombo('Hyper-x')).toBe('');
    expect(normalizeCombo('')).toBe('');
  });

  it('reads combos from keyboard events per platform', () => {
    expect(
      comboFromEvent(ev({ key: 'p', code: 'KeyP', metaKey: true, shiftKey: true }), true),
    ).toBe('Mod-Shift-p');
    expect(
      comboFromEvent(ev({ key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true }), false),
    ).toBe('Mod-Shift-p');
    expect(comboFromEvent(ev({ key: 'p', code: 'KeyP', ctrlKey: true }), true)).toBe('Ctrl-p');
    // Option+letter produces a different character on macOS; the physical key wins.
    expect(comboFromEvent(ev({ key: 'ø', code: 'KeyO', altKey: true, metaKey: true }), true)).toBe(
      'Mod-Alt-o',
    );
    expect(comboFromEvent(ev({ key: '1', code: 'Digit1', ctrlKey: true }), false)).toBe('Mod-1');
    expect(comboFromEvent(ev({ key: 'Enter', ctrlKey: true }), false)).toBe('Mod-Enter');
    expect(comboFromEvent(ev({ key: 'Shift', shiftKey: true }), true)).toBeNull();
  });

  it('formats combos for display', () => {
    expect(formatCombo('Mod-Shift-p', true)).toBe('⌘⇧P');
    expect(formatCombo('Mod-Shift-p', false)).toBe('Ctrl+Shift+P');
    expect(formatCombo('Mod-Enter', true)).toBe('⌘↵');
    expect(formatCombo('Alt-ArrowLeft', false)).toBe('Alt+←');
  });

  it('applies overrides and detects conflicts', () => {
    const bindings = [
      { id: 'a', defaults: ['Mod-b'] },
      { id: 'b', defaults: ['Mod-i', 'Mod-Shift-i'] },
      { id: 'c', defaults: [] },
    ];
    const eff = effectiveCombos(bindings, { a: ['mod-I'], c: ['Mod-j'], b: [] });
    expect(eff.get('a')).toEqual(['Mod-i']);
    expect(eff.get('b')).toEqual([]);
    expect(eff.get('c')).toEqual(['Mod-j']);
    expect(comboIndex(effectiveCombos(bindings, { c: ['Mod-b'] })).get('Mod-b')).toEqual([
      'a',
      'c',
    ]);
  });
});
