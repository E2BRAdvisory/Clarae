// Smart paste and drop: images and files become attachments with an embed,
// a URL pasted over a selection becomes a link, rich HTML becomes Markdown.
import { EditorView } from '@codemirror/view';
import TurndownService from 'turndown';

export interface PasteDeps {
  /** Stores bytes as an attachment and returns the vault path. */
  saveAttachment(name: string, base64: string): Promise<string>;
  enabled(): boolean;
}

const RICH = /<(p|h[1-6]|ul|ol|li|a|strong|b|em|i|table|pre|code|blockquote|img|br)\b/i;
let turndown: TurndownService | null = null;

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

async function toBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000)
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

function embedText(path: string): string {
  return `![[${path}]]`;
}

async function insertFiles(
  view: EditorView,
  files: File[],
  deps: PasteDeps,
  at: number,
): Promise<void> {
  const parts: string[] = [];
  for (const f of files) {
    const generic = /^(image|blob|unnamed)\.\w+$/i.test(f.name) || f.name === '';
    const ext = f.name.includes('.')
      ? f.name.slice(f.name.lastIndexOf('.'))
      : f.type.startsWith('image/')
        ? '.' + (f.type.split('/')[1] ?? 'png')
        : '';
    const name = generic ? `Pasted image ${stamp()}${ext}` : f.name;
    try {
      parts.push(embedText(await deps.saveAttachment(name, await toBase64(f))));
    } catch {
      /* the caller surfaces backend errors; skip this file */
    }
  }
  if (parts.length) {
    const insert = parts.join('\n');
    view.dispatch({
      changes: { from: at, insert },
      selection: { anchor: at + insert.length },
      userEvent: 'input.paste',
    });
  }
}

export function smartPaste(deps: PasteDeps) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (!deps.enabled() || !event.clipboardData) return false;
      const cd = event.clipboardData;
      const files = [...cd.files];
      if (files.length) {
        event.preventDefault();
        void insertFiles(view, files, deps, view.state.selection.main.from);
        return true;
      }
      const plain = cd.getData('text/plain');
      const sel = view.state.selection.main;
      if (!sel.empty && /^https?:\/\/\S+$/.test(plain.trim())) {
        event.preventDefault();
        const text = view.state.doc.sliceString(sel.from, sel.to);
        const insert = `[${text}](${plain.trim()})`;
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert },
          selection: { anchor: sel.from + insert.length },
          userEvent: 'input.paste',
        });
        return true;
      }
      const html = cd.getData('text/html');
      if (html && RICH.test(html)) {
        const md = htmlToMarkdown(html);
        if (md) {
          event.preventDefault();
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: md },
            selection: { anchor: sel.from + md.length },
            userEvent: 'input.paste',
          });
          return true;
        }
      }
      return false;
    },
    drop(event, view) {
      if (!deps.enabled() || !event.dataTransfer?.files.length) return false;
      event.preventDefault();
      const pos =
        view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from;
      void insertFiles(view, [...event.dataTransfer.files], deps, pos);
      return true;
    },
  });
}
