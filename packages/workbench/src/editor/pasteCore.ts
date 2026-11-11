// What smart paste and drop decide, apart from any editor (paste.ts is the CodeMirror side, the Live
// editor's is editor/live/input/paste.ts): which clipboards it takes over, how a pasted file is named,
// and how rich HTML becomes Markdown.
import TurndownService from 'turndown';

export interface PasteDeps {
  /** Stores bytes as an attachment and returns the vault path. */
  saveAttachment(name: string, base64: string): Promise<string>;
  enabled(): boolean;
  /** Shows a file that could not be stored (read-only vault, too large, disk full…). */
  onError?(e: unknown): void;
}

const RICH = /<(p|h[1-6]|ul|ol|li|a|strong|b|em|i|table|pre|code|blockquote|img|br)\b/i;
let turndown: TurndownService | null = null;

/** Whether an HTML clipboard is rich enough to be worth converting (a bare `<span>` is not). */
export const isRichHtml = (html: string): boolean => RICH.test(html);

export function htmlToMarkdown(html: string): string {
  turndown ??= new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  // Turndown pads list markers to a tab stop ("-   a"); normalize to one space.
  return turndown
    .turndown(html)
    .replace(/^(\s*(?:[-*+]|\d+\.)) {2,}/gm, '$1 ')
    .trim();
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function toBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000)
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The name a pasted file is stored under: a generic one ("image.png") is replaced by a dated name. */
export function attachmentName(f: File): string {
  const generic = /^(image|blob|unnamed)\.\w+$/i.test(f.name) || f.name === '';
  const ext = f.name.includes('.')
    ? f.name.slice(f.name.lastIndexOf('.'))
    : f.type.startsWith('image/')
      ? '.' + (f.type.split('/')[1] ?? 'png')
      : '';
  return generic ? `Pasted image ${stamp()}${ext}` : f.name;
}

/** The embed that shows a stored attachment. */
export const embedText = (path: string): string => `![[${path}]]`;

/** The URL an attachment of the vault is written with in an image link (`![](path)`): each segment encoded, the slashes kept. */
export const attachmentUrl = (path: string): string =>
  path.split('/').map(encodeURIComponent).join('/');

/** A URL alone (what pasted over a selection makes the selection a link). */
export const isPlainUrl = (text: string): boolean => /^https?:\/\/\S+$/.test(text.trim());
