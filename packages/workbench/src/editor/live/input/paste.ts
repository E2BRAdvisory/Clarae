// Smart paste and drop in the Live editor (A-W5b), what paste.ts does in Source:
//
//   files and images          stored as attachments (`saveAttachment`), and their embeds `![[…]]` go in
//   a URL over a selection    the selection becomes a link
//   rich HTML                 converted to Markdown, which becomes the nodes it describes
//   plain text                its parse goes straight into the document (as Source inserts it as written)
//
// The plugin takes the events as DOM handlers, which ProseMirror runs before the `handlePaste` and
// `handleDrop` of every plugin: it has precedence over the clipboard plugin of Milkdown, which keeps
// whatever this one lets go (what the editor itself copied: the clipboard of a copy in the editor carries
// `data-pm-slice`, and its nodes would not survive a trip through HTML and Markdown; code of an editor
// of code). Plain text does not go through that plugin: it makes the DOM of the text and parses it
// again, and the nodes of Obsidian's syntax (`[[x]]`, `$$`, `%%`, footnotes) do not survive.
//
// An embed does not go in when the paste happens: the files are written first. The place it will take is
// a position that follows the edits made meanwhile (as in Source), so the embed lands where the paste or
// the drop was, wherever the text is by then; if the editor is gone, or became read-only, nothing is inserted.
import { parserCtx } from '@milkdown/kit/core';
import {
  Fragment,
  Slice,
  type Node as PMNode,
  type ResolvedPos,
  type Schema,
} from '@milkdown/kit/prose/model';
import {
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import {
  attachmentName,
  htmlToMarkdown,
  isPlainUrl,
  isRichHtml,
  toBase64,
  type PasteDeps,
} from '../../pasteCore';
import { liveOptions } from '../ofm/options';
import { definedLabels, escapedIn, rawRefs } from './refs';
import { cellWikilinkText, inCell, nameTakes } from './rules';

export interface PasteHost {
  deps: PasteDeps;
  readOnly(): boolean;
}

interface Meta {
  add?: { id: number; pos: number };
  done?: number;
}

const key = new PluginKey<ReadonlyMap<number, number>>('memobrain-pending-inserts');
let lastId = 0;

/**
 * Stores the files and inserts their embeds at `at` (mapped over the edits made meanwhile). A file that
 * cannot be stored is reported through `deps.onError` (the first failure of the batch) and skipped.
 */
export async function insertFiles(
  view: EditorView,
  files: File[],
  host: PasteHost,
  at: number,
): Promise<void> {
  if (host.readOnly()) return;
  const id = ++lastId;
  view.dispatch(view.state.tr.setMeta(key, { add: { id, pos: at } } satisfies Meta));
  const paths: string[] = [];
  let failure: unknown = null;
  for (const f of files) {
    try {
      paths.push(await host.deps.saveAttachment(attachmentName(f), await toBase64(f)));
    } catch (e) {
      failure ??= e;
    }
  }
  if (!view.isDestroyed) {
    const { state } = view;
    const pos = Math.min(key.getState(state)?.get(id) ?? at, state.doc.content.size);
    const tr = state.tr.setMeta(key, { done: id } satisfies Meta);
    if (paths.length && !host.readOnly()) {
      const sel = state.selection;
      // The caret follows the embeds unless the user moved it meanwhile.
      insertEmbeds(tr, pos, paths, sel.empty && sel.head === pos);
      tr.setMeta('uiEvent', 'paste');
    }
    view.dispatch(tr.scrollIntoView());
  }
  if (failure !== null) host.deps.onError?.(failure);
}

/**
 * The embeds of `paths` at `pos`: the first one in the text there, the others as paragraphs of their
 * own after the block (a document that has no text at `pos` takes all of them as paragraphs there).
 */
function insertEmbeds(tr: Transaction, pos: number, paths: string[], follow: boolean): void {
  const { schema } = tr.doc.type;
  const wikilink = schema.nodes['ofm_wikilink'];
  const paragraph = schema.nodes['paragraph'];
  if (!wikilink || !paragraph) return;
  const embeds = paths.map((p) => wikilink.create({ embed: true }, schema.text(p)));
  const $pos = tr.doc.resolve(pos);
  const inline =
    $pos.parent.inlineContent &&
    !$pos.parent.type.spec.code &&
    $pos.parent.canReplaceWith($pos.index(), $pos.index(), wikilink);
  let end = pos;
  let rest = embeds;
  if (inline) {
    tr.insert(pos, embeds[0] as PMNode);
    end = pos + (embeds[0] as PMNode).nodeSize;
    rest = embeds.slice(1);
  }
  if (rest.length) {
    const at = $pos.parent.isTextblock ? tr.mapping.map($pos.after()) : tr.mapping.map(pos);
    const blocks = rest.map((e) => paragraph.create(null, e));
    tr.insert(at, Fragment.from(blocks));
    end = at + blocks.reduce((n, b) => n + b.nodeSize, 0) - 1;
  }
  if (follow) tr.setSelection(Selection.near(tr.doc.resolve(end), -1));
}

/** Rich HTML as the nodes of its Markdown, at the selection; false when it came to nothing. */
function pasteMarkdown(view: EditorView, parse: (md: string) => PMNode, md: string): boolean {
  let doc: PMNode;
  try {
    doc = parse(md);
  } catch {
    return false; // what cannot be read goes the way of every paste
  }
  if (doc.childCount === 0) return false;
  const first = doc.firstChild as PMNode;
  // one paragraph goes into the text where the caret is, more than one are blocks
  const slice =
    doc.childCount === 1 && first.type.name === 'paragraph'
      ? new Slice(first.content, 0, 0)
      : new Slice(doc.content, 0, 0);
  view.dispatch(
    replaceWithBlocks(view.state.tr, slice).setMeta('uiEvent', 'paste').scrollIntoView(),
  );
  return true;
}

/**
 * The selection replaced by `slice`. Blocks pasted in the middle of a line split it, and the text after
 * them starts a block of its own: the blanks it starts with go (` line` after a list), as a line of
 * Markdown has none at its start (the file would hold them as `&#x20;`, a text the user did not write).
 */
function replaceWithBlocks(tr: Transaction, slice: Slice): Transaction {
  const { $to } = tr.selection;
  const rest = $to.parent.isTextblock && $to.parentOffset < $to.parent.content.size;
  tr.replaceSelection(slice);
  if (!rest || slice.content.firstChild?.isInline !== false) return tr;
  const $at = tr.doc.resolve(tr.mapping.map($to.pos, 1));
  if (!$at.parent.isTextblock || $at.parentOffset !== 0) return tr;
  const blanks = /^[ \t]+/.exec($at.parent.firstChild?.text ?? '')?.[0].length ?? 0;
  return blanks > 0 ? tr.delete($at.pos, $at.pos + blanks) : tr;
}

const EDGE = /^([ \t]*)([\s\S]*?)([ \t]*)$/;

/** Whether the caret is at the start of a line of its block: a blank there is none for Markdown. */
function atLineStart($pos: ResolvedPos): boolean {
  return $pos.parentOffset === 0 || $pos.nodeBefore?.type.name === 'hardbreak';
}

/**
 * A line of text as the content of the paragraph it is in, when the line reads as the start of a block
 * (`- 5 degrees`, `# x`, `1. x`, `> x`): its first character is escaped, so it is the text it says and
 * the rest of it (`[[x]]`, `#tag`) is still read. Null when it does not come to one paragraph.
 */
function inlineOfLine(parse: (md: string) => PMNode, line: string): PMNode | null {
  const escaped = line.replace(/^(\d{1,9})([.)])/, '$1\\$2').replace(/^([#>*+\-_`~=])/, '\\$1');
  try {
    const doc = parse(escaped);
    return doc.childCount === 1 && doc.firstChild?.type.name === 'paragraph' ? doc : null;
  } catch {
    return null;
  }
}

/** A wikilink in a cell holds its bar as `\|`. */
function barsInWikilinks(content: Fragment, schema: Schema): Fragment {
  const link = schema.nodes['ofm_wikilink'];
  const out: PMNode[] = [];
  content.forEach((n) => {
    out.push(
      link && n.type === link && n.textContent.includes('|')
        ? link.create(n.attrs, schema.text(cellWikilinkText(n.textContent)))
        : n,
    );
  });
  return Fragment.fromArray(out);
}

/**
 * Plain text as the Markdown it is, at the selection (what Source does by inserting it as it is): its
 * parse goes straight into the document, so `[[x]]`, `![[x]]`, `$$…$$`, `%%…%%` and footnote definitions
 * stay what they were written as, and so do the references to a footnote or to a link definition of the
 * note (refs.ts). The clipboard plugin of Milkdown would take it through the DOM, where the nodes of
 * Obsidian's syntax are lost. A line of text keeps the blanks at its edges (but not at the start of a
 * line, where Markdown has none), and a line that reads as a block's start goes in as text in the middle of a block. A table cell and a heading take it in one line (a line end would break the table, or make the
 * heading a setext one). False when it came to nothing.
 */
function pastePlainText(view: EditorView, parse: (md: string) => PMNode, text: string): boolean {
  const { $from } = view.state.selection;
  const flat = inCell($from) || $from.parent.type.name === 'heading';
  const src = (flat ? text.replace(/\s*\r?\n\s*/g, ' ') : text).replace(/\r\n?/g, '\n');
  const oneLine = !src.includes('\n');
  const [, blank = '', whole = '', trail = ''] = EDGE.exec(src) ?? [];
  const core = oneLine ? whole : whole.replace(/\n+$/, '');
  if (core.trim() === '') return false;
  const lead = atLineStart($from) ? '' : blank;
  let doc: PMNode;
  try {
    doc = parse(core);
    // a line that starts like a block, after text of a block (in the middle or at its end): no block (it would split it)
    // (at the end of it, a block of Obsidian's syntax, a footnote definition say, is still the block it is)
    const atEnd = view.state.selection.to === $from.end();
    if (oneLine && $from.parent.isTextblock && $from.parentOffset > 0) {
      const own = atEnd && doc.firstChild?.type.name === 'raw_block';
      if (!own && !(doc.childCount === 1 && doc.firstChild?.type.name === 'paragraph')) {
        const inline = inlineOfLine(parse, core);
        if (!inline) {
          view.dispatch(
            view.state.tr
              .insertText(src, $from.pos, view.state.selection.to)
              .setMeta('uiEvent', 'paste'),
          );
          return true;
        }
        doc = inline;
      }
    }
  } catch {
    return false;
  }
  // references that stayed text (not the ones the source escapes: that is the text it says)
  doc = rawRefs(doc, definedLabels(doc, definedLabels(view.state.doc)), (raw) =>
    escapedIn(src, raw),
  );
  const first = doc.firstChild;
  const { schema } = view.state;
  let slice: Slice;
  if (doc.childCount === 1 && first?.type.name === 'paragraph') {
    const parts: PMNode[] = [];
    if (lead) parts.push(schema.text(lead));
    const content = flat ? barsInWikilinks(first.content, schema) : first.content;
    content.forEach((n) => parts.push(n));
    if (trail) parts.push(schema.text(trail));
    slice = new Slice(Fragment.fromArray(parts), 0, 0);
  } else if (flat) {
    // blocks do not go into a cell: the text is what it was typed
    view.dispatch(view.state.tr.insertText(src).setMeta('uiEvent', 'paste').scrollIntoView());
    return true;
  } else if (doc.childCount === 0) {
    return false;
  } else {
    slice = new Slice(doc.content, 0, 0);
  }
  view.dispatch(
    replaceWithBlocks(view.state.tr, slice).setMeta('uiEvent', 'paste').scrollIntoView(),
  );
  return true;
}

/**
 * The text of a piece of HTML, for a place that takes text only: the blocks and the line breaks end a line
 * (`<p>a</p><p>b</p>` is `a`, `b`), what the page does not show (`script`, `style`) is not text.
 */
function textOfHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, template, head').forEach((e) => e.remove());
  doc.querySelectorAll('br, hr').forEach((e) => e.replaceWith('\n'));
  doc
    .querySelectorAll(
      'p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, ul, ol, table, section',
    )
    .forEach((e) => e.append('\n'));
  return (doc.body.textContent ?? '').replace(/\n+$/, '');
}

/**
 * Plain text pasted in the name of a wikilink: what the name takes, character by character, as typed (the
 * rules of the keys, rules.ts): a name is one line, holds no bracket (`[^1]`, `[x]: url`, `[a](b)` lose
 * theirs), and no character that would open a comment or a math span at the level of the file (`%%`,
 * `$$`) is taken. The paste is made here and no other handler sees it: the clipboard plugin would put
 * the text in as it is, line ends and all. False when the selection is not inside one name; inside one,
 * the paste is never left to the others, whatever the text (none: nothing is put in).
 */
function pasteInName(view: EditorView, text: string): boolean {
  const { $from, $to } = view.state.selection;
  const label = $from.parent;
  if (label.type.name !== 'ofm_wikilink' || $to.parent !== label) return false;
  const after = label.textBetween($to.parentOffset, label.content.size);
  let taken = label.textBetween(0, $from.parentOffset);
  const head = taken.length;
  for (const ch of text.replace(/\s*\r?\n\s*/g, ' ')) {
    if (ch === ']' || (/[%$[]/.test(ch) && !nameTakes(taken, ch, after))) continue;
    taken += ch;
  }
  const added = taken.slice(head);
  if (added !== '') {
    const inserted = inCell($from) ? cellWikilinkText(added) : added;
    view.dispatch(
      view.state.tr
        .insertText(inserted, $from.pos, $to.pos)
        .setMeta('uiEvent', 'paste')
        .scrollIntoView(),
    );
  }
  return true;
}

/** The selection becomes a link to the URL that was pasted over it. */
function linkSelection(view: EditorView, url: string): boolean {
  const { state } = view;
  const { selection } = state;
  const mark = state.schema.marks['link'];
  if (!mark || !(selection instanceof TextSelection)) return false;
  if (!selection.$from.sameParent(selection.$to) || selection.$from.parent.type.spec.code)
    return false;
  view.dispatch(
    state.tr
      .addMark(selection.from, selection.to, mark.create({ href: url.trim(), title: null }))
      .setMeta('uiEvent', 'paste'),
  );
  return true;
}

export const smartPaste = (host: PasteHost) =>
  $prose((ctx) => {
    const parse = (md: string): PMNode => {
      ctx.set(liveOptions.key, { forceRaw: new Set<number>() });
      return ctx.get(parserCtx)(md);
    };
    return new Plugin<ReadonlyMap<number, number>>({
      key,
      state: {
        init: () => new Map(),
        apply(tr, value) {
          let next = value;
          if (tr.docChanged && value.size) {
            // -1: text typed at the spot afterwards goes after the embed
            next = new Map([...value].map(([id, pos]) => [id, tr.mapping.map(pos, -1)]));
          }
          const meta = tr.getMeta(key) as Meta | undefined;
          if (meta?.add) next = new Map(next).set(meta.add.id, meta.add.pos);
          if (meta?.done !== undefined && next.has(meta.done)) {
            next = new Map(next);
            (next as Map<number, number>).delete(meta.done);
          }
          return next;
        },
      },
      props: {
        handleDOMEvents: {
          paste(view, event) {
            if (host.readOnly() || !event.clipboardData) return false;
            const cd = event.clipboardData;
            const smart = host.deps.enabled();
            const files = smart ? [...cd.files] : [];
            if (files.length) {
              event.preventDefault();
              void insertFiles(view, files, host, view.state.selection.from);
              return true;
            }
            const plain = cd.getData('text/plain');
            // in the name of a wikilink the text is a name, whatever the clipboard holds besides it: the text
            // of the HTML when that is all there is (its blocks would split the link)
            const named = plain !== '' ? plain : textOfHtml(cd.getData('text/html'));
            if (pasteInName(view, named)) {
              event.preventDefault();
              return true;
            }
            if (smart && !view.state.selection.empty && isPlainUrl(plain)) {
              if (!linkSelection(view, plain)) return false;
              event.preventDefault();
              return true;
            }
            const html = cd.getData('text/html');
            const rich = html !== '' && isRichHtml(html);
            if (smart && rich && !html.includes('data-pm-slice')) {
              let md = '';
              try {
                md = htmlToMarkdown(html);
              } catch {
                /* HTML the converter cannot read goes the way of every paste */
              }
              if (md && pasteMarkdown(view, parse, md)) {
                event.preventDefault();
                return true;
              }
            }
            // Plain text (the clipboard of a copy in the editor carries `data-pm-slice`, and the one of an
            // editor of code its own data: both keep going the clipboard plugin's way).
            if (
              plain !== '' &&
              !rich &&
              !html.includes('data-pm-slice') &&
              !cd.getData('vscode-editor-data') &&
              !view.state.selection.$from.node().type.spec.code &&
              // the text of a wikilink is a name, which no node of the text can be put in
              view.state.selection.$from.node().type.name !== 'ofm_wikilink' &&
              pastePlainText(view, parse, plain)
            ) {
              event.preventDefault();
              return true;
            }
            return false;
          },
          drop(view, event) {
            const files = event.dataTransfer?.files;
            if (!host.deps.enabled() || host.readOnly() || !files?.length) return false;
            event.preventDefault();
            const at =
              view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ??
              view.state.selection.from;
            void insertFiles(view, [...files], host, at);
            return true;
          },
        },
      },
    });
  });
