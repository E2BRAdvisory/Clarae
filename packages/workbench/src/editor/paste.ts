// Smart paste and drop: images and files become attachments with an embed,
// a URL pasted over a selection becomes a link, rich HTML becomes Markdown.
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import {
  attachmentName,
  embedText,
  htmlToMarkdown,
  isPlainUrl,
  isRichHtml,
  toBase64,
  type PasteDeps,
} from './pasteCore';

// The decisions are shared with the Live editor (pasteCore.ts); re-exported so that the existing imports
// keep compiling.
export { htmlToMarkdown, type PasteDeps } from './pasteCore';

let lastMark = 0;
const markAdded = StateEffect.define<{ id: number; pos: number }>();
const markDone = StateEffect.define<number>();

/**
 * Where the embeds of files still being stored will go, by paste: each position follows the edits
 * made while the files are converted and written, so the embed lands where the paste happened.
 */
const pendingInserts = StateField.define<ReadonlyMap<number, number>>({
  create: () => new Map(),
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.size) {
      const mapped = new Map<number, number>();
      // -1: text typed at the spot afterwards goes after the embed.
      for (const [id, pos] of value) mapped.set(id, tr.changes.mapPos(pos, -1));
      next = mapped;
    }
    for (const e of tr.effects) {
      if (e.is(markAdded)) next = new Map(next).set(e.value.id, e.value.pos);
      else if (e.is(markDone) && next.has(e.value)) {
        const left = new Map(next);
        left.delete(e.value);
        next = left;
      }
    }
    return next;
  },
});

/** Editors that are gone: a paste that finishes later has nothing to insert into. */
const destroyed = new WeakSet<EditorView>();
const lifecycle = ViewPlugin.define((view) => ({ destroy: () => void destroyed.add(view) }));

/**
 * Stores the files as attachments and inserts their embeds at `at` (mapped over the edits made
 * meanwhile). A file that cannot be stored is reported through `deps.onError` (the first failure
 * of the batch) and skipped. Exported for the tests.
 */
export async function insertFiles(
  view: EditorView,
  files: File[],
  deps: PasteDeps,
  at: number,
): Promise<void> {
  if (view.state.readOnly) return;
  const id = ++lastMark;
  const tracked = view.state.field(pendingInserts, false) !== undefined;
  if (tracked) view.dispatch({ effects: markAdded.of({ id, pos: at }) });
  const parts: string[] = [];
  let failure: unknown = null;
  for (const f of files) {
    try {
      parts.push(embedText(await deps.saveAttachment(attachmentName(f), await toBase64(f))));
    } catch (e) {
      failure ??= e;
    }
  }
  if (!destroyed.has(view) && (tracked || parts.length)) {
    const state = view.state;
    const pos = Math.min(
      (tracked ? state.field(pendingInserts, false)?.get(id) : undefined) ?? at,
      state.doc.length,
    );
    const insert = parts.join('\n');
    const sel = state.selection.main;
    view.dispatch({
      ...(tracked ? { effects: markDone.of(id) } : {}),
      ...(insert
        ? {
            changes: { from: pos, insert },
            // The caret follows the embed unless the user moved it meanwhile.
            ...(sel.empty && sel.head === pos
              ? { selection: { anchor: pos + insert.length } }
              : {}),
            userEvent: 'input.paste',
          }
        : {}),
    });
  }
  if (failure !== null) deps.onError?.(failure);
}

export function smartPaste(deps: PasteDeps): Extension {
  return [pendingInserts, lifecycle, smartPasteHandlers(deps)];
}

function smartPasteHandlers(deps: PasteDeps): Extension {
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
      if (!sel.empty && isPlainUrl(plain)) {
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
      if (html && isRichHtml(html)) {
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
