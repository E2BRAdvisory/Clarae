import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TERMINAL_FONT } from '../state/settings';
import { cleanFamily, FONT_FALLBACK, fontReady, xtermFontFamily } from './theme';

afterEach(() => vi.restoreAllMocks());

describe('the font of the terminal', () => {
  it('is MesloLGS NF by default, quoted, with monospace fallbacks', () => {
    expect(DEFAULT_TERMINAL_FONT).toBe('MesloLGS NF');
    expect(xtermFontFamily(DEFAULT_TERMINAL_FONT)).toBe(`"MesloLGS NF", ${FONT_FALLBACK}`);
    expect(FONT_FALLBACK).toBe('ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace');
  });

  it('is the default when the value is empty or has nothing usable in it', () => {
    for (const v of ['', '   ', '"', '",;{}', "''"])
      expect(xtermFontFamily(v), JSON.stringify(v)).toBe(xtermFontFamily(DEFAULT_TERMINAL_FONT));
  });

  it('takes a name with spaces, and quotes it', () => {
    expect(xtermFontFamily('Fira Code')).toBe(`"Fira Code", ${FONT_FALLBACK}`);
    expect(xtermFontFamily('  JetBrains   Mono NL ')).toBe(`"JetBrains Mono NL", ${FONT_FALLBACK}`);
    expect(xtermFontFamily('Cascadia Code PL (v2.3)')).toBe(
      `"Cascadia Code PL (v2.3)", ${FONT_FALLBACK}`,
    );
    expect(cleanFamily('Iosevka-Term_Slab+1.0')).toBe('Iosevka-Term_Slab+1.0');
    expect(cleanFamily('Source Code Pro für Ünï')).toBe('Source Code Pro für Ünï');
  });

  it('drops quotes the user typed', () => {
    expect(xtermFontFamily('"Fira Code"')).toBe(`"Fira Code", ${FONT_FALLBACK}`);
    expect(xtermFontFamily("'Fira Code'")).toBe(`"Fira Code", ${FONT_FALLBACK}`);
    expect(xtermFontFamily('Fira "Code')).toBe(`"Fira Code", ${FONT_FALLBACK}`);
  });

  it('cannot be made to add a family or another declaration', () => {
    // only letters, digits, spaces and _ . + - ( ) stay: one quoted name, then the fixed fallbacks
    expect(xtermFontFamily('Evil", fantasy; } body { color: red; /* \\ */ url(x)')).toBe(
      `"Evil fantasy body color red url(x)", ${FONT_FALLBACK}`,
    );
    expect(xtermFontFamily('Mono, serif')).toBe(`"Mono serif", ${FONT_FALLBACK}`);
  });

  it('is a name, not a paragraph', () => {
    const long = 'A'.repeat(500);
    expect(cleanFamily(long)).toHaveLength(64);
  });
});

describe('waiting for the font', () => {
  const fonts = (load: () => Promise<unknown>) =>
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load, ready: Promise.resolve() },
    });
  afterEach(() => Reflect.deleteProperty(document, 'fonts'));

  it('does not wait where the page has no Font Loading API', async () => {
    await expect(fontReady('"X", monospace')).resolves.toBeUndefined();
  });

  it('loads the family and waits for the page’s fonts', async () => {
    const load = vi.fn(() => Promise.resolve([]));
    fonts(load);
    await fontReady('"Fira Code", monospace');
    expect(load).toHaveBeenCalledWith('13px "Fira Code", monospace');
    await fontReady('"Fira Code", monospace', 18);
    expect(load).toHaveBeenCalledWith('18px "Fira Code", monospace');
  });

  it('is bounded, and a font that cannot be loaded is not waited for', async () => {
    fonts(() => new Promise(() => undefined)); // never settles
    const t0 = Date.now();
    await fontReady('"X", monospace', 13, 30);
    expect(Date.now() - t0).toBeLessThan(500);
    fonts(() => Promise.reject(new Error('network')));
    await expect(fontReady('"X", monospace')).resolves.toBeUndefined();
  });
});
