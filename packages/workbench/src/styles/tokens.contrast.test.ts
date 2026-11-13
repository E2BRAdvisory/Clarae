import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The colour tokens of the two palettes (the console's --nd-* in @clarae/ui, the workbench's here)
// are checked against WCAG 1.4.3 where a token is used as text on another: 4.5:1. The pairs are the
// ones the style sheets actually combine; a new surface or text token belongs in the lists below.

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const UI = read('../../../ui/src/tokens.css');
const WORKBENCH = read('./tokens.css');

/** The custom properties declared in the block that starts with `selector {`. */
function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out = new Map<string, string>();
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1] as string, (m[2] as string).trim());
  }
  return out;
}

const DARK = ":root[data-theme='dark']";
const themes = {
  light: new Map([...block(UI, ':root'), ...block(WORKBENCH, ':root')]),
  dark: new Map([
    ...block(UI, ':root'),
    ...block(WORKBENCH, ':root'),
    ...block(UI, DARK),
    ...block(WORKBENCH, DARK),
  ]),
};

function resolve(theme: Map<string, string>, name: string): string {
  let value = theme.get(name);
  for (let i = 0; value && i < 8; i++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (!ref) break;
    value = theme.get(ref[1] as string);
  }
  if (!value || !/^#[0-9a-f]{6}$/i.test(value))
    throw new Error(`${name} is not a colour: ${value}`);
  return value;
}

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

/** [text tokens, surface tokens, minimum ratio] */
const PAIRS: [string[], string[], number][] = [
  // workbench: text on every surface a list row or a panel can have
  [
    ['--text', '--text-muted', '--text-faint', '--accent', '--accent-text'],
    ['--bg', '--bg-secondary', '--bg-hover', '--bg-active'],
    4.5,
  ],
  [['--accent-contrast'], ['--accent'], 4.5],
  [['--text'], ['--mark'], 4.5],
  // marks that are not text (WCAG 1.4.11)
  [['--accent-bright'], ['--bg', '--bg-secondary'], 3],
  // console
  [
    ['--nd-text', '--nd-text-muted', '--nd-accent', '--nd-danger', '--nd-ok', '--nd-warn'],
    ['--nd-bg', '--nd-surface', '--nd-surface-2'],
    4.5,
  ],
  [['--nd-accent-text'], ['--nd-accent'], 4.5],
  [['--nd-danger'], ['--nd-danger-bg'], 4.5],
  [['--nd-ok'], ['--nd-ok-bg'], 4.5],
  [['--nd-warn'], ['--nd-warn-bg'], 4.5],
  // the mark on the page and on a card
  [['--nd-mark-1', '--nd-mark-3'], ['--nd-surface'], 1.5],
];

describe.each(Object.entries(themes))('the colour tokens of the %s theme', (_, theme) => {
  it.each(PAIRS)('%j read on %j (at least %d:1)', (texts, surfaces, min) => {
    for (const text of texts) {
      for (const surface of surfaces) {
        const ratio = contrast(resolve(theme, text), resolve(theme, surface));
        expect(ratio, `${text} on ${surface}`).toBeGreaterThanOrEqual(min);
      }
    }
  });
});

describe('the brand palette', () => {
  it('is the one of the brand board', () => {
    const root = block(UI, ':root');
    expect(root.get('--brand-navy')).toBe('#102b3a');
    expect(root.get('--brand-teal')).toBe('#159992');
    expect(root.get('--brand-mint')).toBe('#72c9bd');
    expect(root.get('--brand-mist')).toBe('#e9f0ef');
    expect(root.get('--brand-white')).toBe('#ffffff');
  });
});
