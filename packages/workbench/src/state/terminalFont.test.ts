import { describe, expect, it } from 'vitest';
import { unmanaged } from './managed';
import {
  DEFAULT_TERMINAL_FONT,
  DEFAULT_TERMINAL_FONT_SIZE,
  defaultAppearance,
  parseSettings,
  resolveSettings,
  terminalFontSizeOf,
} from './settings';

const resolved = (stored: unknown) =>
  resolveSettings(
    {
      editor: {},
      appearance: parseSettings(JSON.stringify(stored), defaultAppearance),
      hotkeys: {},
    },
    unmanaged,
  ).appearance;

describe('the terminal font settings', () => {
  it('default to MesloLGS NF at 13', () => {
    expect(DEFAULT_TERMINAL_FONT).toBe('MesloLGS NF');
    expect(DEFAULT_TERMINAL_FONT_SIZE).toBe(13);
    expect(defaultAppearance.terminalFontSize).toBe(13);
    expect(resolved({})).toMatchObject({ terminalFont: 'MesloLGS NF', terminalFontSize: 13 });
  });

  it('keep a size in range, rounded', () => {
    expect(terminalFontSizeOf(8)).toBe(8);
    expect(terminalFontSizeOf(32)).toBe(32);
    expect(terminalFontSizeOf(16.4)).toBe(16);
    expect(resolved({ terminalFontSize: 20 }).terminalFontSize).toBe(20);
  });

  it('fall back to the default for a size that is out of range or not a number', () => {
    for (const v of [7, 33, 0, -5, 1e9, Number.NaN, Infinity, '18', null, undefined, {}])
      expect(terminalFontSizeOf(v), JSON.stringify(v) ?? 'undefined').toBe(13);
    expect(resolved({ terminalFontSize: 99 }).terminalFontSize).toBe(13);
    expect(resolved({ terminalFontSize: '18' }).terminalFontSize).toBe(13); // wrong type: not read
  });
});
