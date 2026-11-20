// The colours of the terminal. The ground, the text, the cursor and the selection come from the CSS
// tokens of the workbench (so the accent a user picked and the theme follow); the sixteen colours of a
// shell's output are fixed per theme, chosen to read on that ground (no token has sixteen colours).
import type { ITheme } from '@xterm/xterm';

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

/** The font stack of the page's monospace token, for xterm (it needs the resolved string). */
export function xtermFont(root: Element = document.documentElement): string {
  return token(
    getComputedStyle(root),
    '--font-mono',
    "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  );
}
