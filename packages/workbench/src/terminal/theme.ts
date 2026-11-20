// The colours of the terminal. The ground, the text, the cursor and the selection come from the CSS
// tokens of the workbench (so the accent a user picked and the theme follow); the sixteen colours of a
// shell's output are fixed per theme, chosen to read on that ground (no token has sixteen colours).
import type { ITheme } from '@xterm/xterm';
import { DEFAULT_TERMINAL_FONT, DEFAULT_TERMINAL_FONT_SIZE } from '../state/settings';

type Ansi = Pick<
  ITheme,
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'
>;

export const ANSI_DARK: Ansi = {
  black: '#3b4754',
  red: '#f07178',
  green: '#7fd18b',
  yellow: '#e6c07b',
  blue: '#6cb2f0',
  magenta: '#c792ea',
  cyan: '#56d4c8',
  white: '#d5dde6',
  brightBlack: '#6b7b8c',
  brightRed: '#ff8b92',
  brightGreen: '#9be8a6',
  brightYellow: '#f4d38d',
  brightBlue: '#8cc6ff',
  brightMagenta: '#dcaaf5',
  brightCyan: '#7ee8dc',
  brightWhite: '#ffffff',
};

export const ANSI_LIGHT: Ansi = {
  black: '#1f2933',
  red: '#b3261e',
  green: '#1b6e3c',
  yellow: '#80570a',
  blue: '#1259a8',
  magenta: '#7b2d9b',
  cyan: '#00695f',
  white: '#5b6671',
  brightBlack: '#46515c',
  brightRed: '#c62828',
  brightGreen: '#2e7d32',
  brightYellow: '#8f6200',
  brightBlue: '#1565c0',
  brightMagenta: '#8e24aa',
  brightCyan: '#00796b',
  brightWhite: '#2b3640',
};

const token = (style: CSSStyleDeclaration, name: string, fallback: string): string =>
  style.getPropertyValue(name).trim() || fallback;

/** The xterm theme for the theme in force now (the page's CSS tokens, resolved). */
export function xtermTheme(dark: boolean, root: Element = document.documentElement): ITheme {
  const style = getComputedStyle(root);
  return {
    background: token(style, '--bg', dark ? '#0b1620' : '#ffffff'),
    foreground: token(style, '--text', dark ? '#e8eef3' : '#102a43'),
    cursor: token(style, '--accent', dark ? '#7fe0d4' : '#0b6b63'),
    cursorAccent: token(style, '--bg', dark ? '#0b1620' : '#ffffff'),
    selectionBackground: token(style, '--bg-active', dark ? '#243b4d' : '#d9e6ec'),
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  };
}

/** What stands in for the chosen font where it is not installed: the monospace fonts of the three systems. */
export const FONT_FALLBACK = 'ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace';

/** The longest family name taken: a name is a few words, not a list. */
const FAMILY_MAX = 64;

/**
 * The name of a font family, as typed in Settings: quotes and everything that is not a letter, a digit, a
 * space or one of `_ . + - ( )` are dropped (a comma would add a family, a semicolon or a bracket would leave
 * the declaration), and the spaces are collapsed. '' when nothing is left.
 */
export function cleanFamily(name: string): string {
  return name
    .replace(/[^\p{L}\p{N} _.+()-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FAMILY_MAX)
    .trim();
}

/**
 * The `fontFamily` of a screen for the font chosen in Settings: the name, quoted, then the monospace
 * fallbacks. An empty value (or one with nothing usable) is the default font.
 */
export function xtermFontFamily(setting: string): string {
  const name = cleanFamily(setting) || DEFAULT_TERMINAL_FONT;
  return `"${name}", ${FONT_FALLBACK}`;
}

/**
 * Resolves when a font the page may still be loading is ready to be measured (a screen that measures its
 * cells before that gets them wrong). A font installed on the computer needs no loading and resolves at once;
 * the wait is bounded, and a page without the Font Loading API does not wait.
 */
export async function fontReady(
  family: string,
  size = DEFAULT_TERMINAL_FONT_SIZE,
  limitMs = 1500,
): Promise<void> {
  const fonts = (document as { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fonts.load(`${size}px ${family}`).then(() => fonts.ready),
      new Promise<void>((done) => {
        timer = setTimeout(done, limitMs);
      }),
    ]);
  } catch {
    /* a font that cannot be loaded is not waited for */
  } finally {
    clearTimeout(timer);
  }
}
