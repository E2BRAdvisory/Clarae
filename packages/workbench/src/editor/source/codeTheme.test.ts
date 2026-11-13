// The theme of the code blocks of Live (A-W5c): a palette per theme that reads on the surface of the
// block, and the tab width that reaches the blocks.
import { highlightingFor, indentUnit } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { tags } from '@lezer/highlight';
import { describe, expect, it } from 'vitest';
import { codeExtensions, codeTheme, DARK, LIGHT, type Palette } from './codeTheme';

/** WCAG relative luminance and contrast ratio of two #rrggbb colours. */
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

// the surfaces of a code block: the page and the secondary background of tokens.css, per theme
const SURFACES = { light: ['#ffffff', '#e9f0ef'], dark: ['#0b1f2a', '#102b3a'] } as const;

describe('the syntax colours of a code block', () => {
  const check = (palette: Palette, surfaces: readonly string[]) => {
    for (const [name, color] of Object.entries(palette as unknown as Record<string, string>)) {
      for (const surface of surfaces) {
        expect(contrast(color, surface), `${name} ${color} on ${surface}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  };
  it('read on the light surfaces (WCAG AA)', () => check(LIGHT, SURFACES.light));
  it('read on the dark surfaces (WCAG AA)', () => check(DARK, SURFACES.dark));

  it('are one style per theme', () => {
    const light = EditorState.create({ extensions: codeTheme(false) });
    const dark = EditorState.create({ extensions: codeTheme(true) });
    const lightKeyword = highlightingFor(light, [tags.keyword]);
    const darkKeyword = highlightingFor(dark, [tags.keyword]);
    expect(lightKeyword).toBeTruthy();
    expect(darkKeyword).toBeTruthy();
    expect(lightKeyword).not.toBe(darkKeyword);
  });
});

describe('the settings that reach the code blocks', () => {
  it('give them the tab width as the width of a tab and as an indent', () => {
    const state = EditorState.create({ extensions: codeExtensions({ dark: false, tabSize: 2 }) });
    expect(state.tabSize).toBe(2);
    expect(state.facet(indentUnit)).toBe('  ');
    const wide = EditorState.create({ extensions: codeExtensions({ dark: true, tabSize: 8 }) });
    expect(wide.tabSize).toBe(8);
    expect(wide.facet(indentUnit)).toBe(' '.repeat(8));
  });
});
