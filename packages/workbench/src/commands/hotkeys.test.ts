import { describe, expect, it } from 'vitest';
import {
  comboFromEvent,
  combosFromEvent,
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

  it('reads the combo of the character, as it always did, whatever key makes it', () => {
    // the key left of 1: "`" on a US layout, "~" with Shift, "\\" on an Italian one
    expect(comboFromEvent(ev({ key: '`', code: 'Backquote', ctrlKey: true }), false)).toBe('Mod-`');
    expect(
      comboFromEvent(ev({ key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true }), false),
    ).toBe('Mod-Shift-~');
    expect(comboFromEvent(ev({ key: '\\', code: 'Backquote', ctrlKey: true }), false)).toBe(
      'Mod-\\',
    );
    expect(comboFromEvent(ev({ key: '\\', code: 'Backslash', ctrlKey: true }), false)).toBe(
      'Mod-\\',
    );
    expect(comboFromEvent(ev({ key: 'Dead', code: 'Backquote' }), false)).toBeNull();
    expect(comboFromEvent(ev({ key: 'Dead', code: 'KeyE' }), false)).toBeNull();
  });

  it('adds the key left of 1 as "`" after the combo of its character', () => {
    const combos = (o: Partial<KeyboardEvent> & { key: string }, mac: boolean) =>
      combosFromEvent(ev({ code: 'Backquote', ...o }), mac);
    expect(combos({ key: '`', ctrlKey: true }, false)).toEqual(['Mod-`']); // the same: once
    expect(combos({ key: '~', ctrlKey: true, shiftKey: true }, false)).toEqual([
      'Mod-Shift-~',
      'Mod-Shift-`',
    ]);
    expect(combos({ key: '\\', ctrlKey: true }, true)).toEqual(['Ctrl-\\', 'Ctrl-`']);
    expect(combos({ key: '\\', metaKey: true }, true)).toEqual(['Mod-\\', 'Mod-`']);
    // an ISO keyboard on macOS: the top-left key is IntlBackslash and the "<>" key is Backquote, both count
    const iso = { key: '§', code: 'IntlBackslash', ctrlKey: true };
    expect(combosFromEvent(ev(iso), true)).toEqual(['Ctrl-§', 'Ctrl-`']);
    expect(combosFromEvent(ev({ ...iso, key: '±', shiftKey: true }), true)).toEqual([
      'Ctrl-Shift-±',
      'Ctrl-Shift-`',
    ]);
    // elsewhere IntlBackslash is another key (the "<>" key of an ISO keyboard): no alias
    expect(combosFromEvent(ev(iso), false)).toEqual(['Mod-§']);
    // a dead key has no character: only the place is left
    expect(combos({ key: 'Dead', ctrlKey: true }, false)).toEqual(['Mod-`']);
    // any other key has one combo, and a bare modifier none
    expect(combosFromEvent(ev({ key: 'p', code: 'KeyP', ctrlKey: true }), false)).toEqual([
      'Mod-p',
    ]);
    expect(combosFromEvent(ev({ key: '\\', code: 'Backslash', ctrlKey: true }), false)).toEqual([
      'Mod-\\',
    ]);
    expect(combosFromEvent(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), false)).toEqual(
      [],
    );
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
