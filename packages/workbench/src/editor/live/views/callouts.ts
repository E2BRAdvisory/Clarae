// Callouts in the Live editor (A-W5a): `> [!note]- Title` and the lines after it. A callout is a plain
// blockquote of the document, so it is edited and written as one; what makes it a callout is only
// decoration: the box (type, colour), the head line shown as an icon and a title, and the fold.
//
//   head      `[!type]±` and the blanks after it are not shown (an inline decoration); an icon and, when
//             the title is empty, the name of the type take their place. The caret on the head line
//             shows the source of the head.
//   fold      `-` is folded and `+` open to begin with; the user flips it from the chevron. The state is
//             the plugin's own (positions mapped through the edits), never an attribute of the
//             document: flipping it is not an edit and never makes the note dirty (A4 of the critique).
//             A folded callout shows its body while the caret is in it.
import { parseCalloutHead } from '@memobrain/markdown';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { i18next } from '../../../i18n';
import { iconElement } from '../../../shell/icons';
import { calloutIcon } from '../../calloutIcon';

interface CalloutState {
  /** Blockquotes (by the position before them) whose fold the user flipped from its default. */
  flipped: ReadonlySet<number>;
  /** The blockquotes the selection is in, so that moving inside one redraws nothing. */
  touched: string;
  decorations: DecorationSet;
}

interface Meta {
  flip: number;
}

export const calloutKey = new PluginKey<CalloutState>('memobrain-live-callouts');

/** The head of the callout a blockquote is, with where its title line is in the document. */
export interface CalloutAt {
  /** Position before the blockquote. */
  pos: number;
  type: string;
  marker: string;
  title: string;
  /** Start of the first paragraph's content, and the end of the head (`[!type]±` and the blanks). */
  headFrom: number;
  headTo: number;
  /** End of the title line: the first line break of the paragraph, or its end. */
  titleEnd: number;
  /** Where the body starts when the first paragraph holds some of it (the line break), or null. */
  breakAt: number | null;
  /** End of the first paragraph's content. */
  paragraphEnd: number;
  /** The blockquote is a callout whose first paragraph is followed by other blocks or has a break. */
  hasBody: boolean;
}

const HEAD = /^\[![A-Za-z0-9_-]+\][+-]?[ \t]*/;

/** The callout a blockquote is, or null: its first paragraph starts with `[!type]`. */
export function calloutOf(node: PMNode, pos: number): CalloutAt | null {
  const first = node.firstChild;
  if (!first || first.type.name !== 'paragraph') return null;
  const lead = first.firstChild;
  if (!lead?.isText) return null;
  let line = '';
  let breakAt: number | null = null;
  let offset = 0;
  for (let i = 0; i < first.childCount; i++) {
    const child = first.child(i);
    if (child.type.name === 'hardbreak') {
      breakAt = pos + 2 + offset;
      break;
    }
    line += child.textContent;
    offset += child.nodeSize;
  }
  const titleEnd = pos + 2 + offset;
  const head = HEAD.exec(line);
  const parsed = parseCalloutHead(`> ${line}`);
  if (!head || !parsed) return null;
  // the head is one piece of text: a mark that starts inside it would be written over
  if (head[0].length > (lead.text ?? '').length) return null;
  const headFrom = pos + 2;
  return {
    pos,
    type: parsed.type,
    marker: parsed.marker,
    title: parsed.title,
    headFrom,
    headTo: headFrom + head[0].length,
    titleEnd,
    breakAt,
    paragraphEnd: headFrom + first.content.size,
    hasBody: breakAt !== null || node.childCount > 1,
  };
}

/** Whether a callout shows folded (the marker decides, the user flips). */
export const isFolded = (marker: string, flipped: boolean): boolean =>
  marker !== '' && (marker === '-') !== flipped;

const touches = (state: EditorState, from: number, to: number): boolean =>
  state.selection.from <= to && state.selection.to >= from;

/** Position before the blockquote that holds `pos`. */
function quoteBefore(view: EditorView, pos: number): number | null {
  const $pos = view.state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--)
    if ($pos.node(d).type.name === 'blockquote') return $pos.before(d);
  return null;
}

function titleWidget(c: CalloutAt, folded: boolean, label: string) {
  return (view: EditorView, getPos: () => number | undefined): HTMLElement => {
    const el = document.createElement('span');
    el.className = 'ofm-callout-title';
    el.contentEditable = 'false';
    const icon = document.createElement('span');
    icon.className = 'ofm-callout-icon';
    icon.append(iconElement(calloutIcon(c.type), 16));
    el.append(icon);
    if (!c.title) {
      const name = document.createElement('span');
      name.className = 'ofm-callout-name';
      name.textContent = c.type.charAt(0).toUpperCase() + c.type.slice(1);
      el.append(name);
    }
    if (c.marker !== '' && c.hasBody) {
      const chevron = document.createElement('span');
      chevron.className = 'ofm-callout-chevron';
      chevron.setAttribute('role', 'button');
      chevron.tabIndex = 0;
      chevron.setAttribute('aria-label', label);
      chevron.setAttribute('aria-expanded', String(!folded));
      chevron.append(iconElement(folded ? 'chevronRight' : 'chevronDown', 16));
      const flip = (): void => {
        const at = getPos();
        const quote = at === undefined ? null : quoteBefore(view, at);
        if (quote !== null)
          view.dispatch(view.state.tr.setMeta(calloutKey, { flip: quote } satisfies Meta));
      };
      chevron.addEventListener('mousedown', (e) => {
        e.preventDefault();
        flip();
      });
      chevron.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        flip();
      });
      el.append(chevron);
    }
    return el;
  };
}

function build(state: EditorState, flipped: ReadonlySet<number>): DecorationSet {
  const out: Decoration[] = [];
  const label = i18next.t('editor.calloutToggle');
  state.doc.descendants((node, pos, parent) => {
    if (node.isTextblock) return false;
    if (node.type.name !== 'blockquote') return true;
    // a quote inside a quote is no callout
    const c = parent?.type.name === 'blockquote' ? null : calloutOf(node, pos);
    if (!c) return true;
    const foldable = c.marker !== '' && c.hasBody;
    const folded = foldable && isFolded(c.marker, flipped.has(pos));
    const editingHead = touches(state, c.headFrom - 1, c.titleEnd);
    const editingBody =
      c.hasBody && touches(state, c.breakAt ?? c.paragraphEnd, pos + node.nodeSize);
    const hidden = folded && !editingBody;
    out.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: `ofm-callout ofm-callout-${c.type}${foldable ? ' ofm-callout-foldable' : ''}${hidden ? ' ofm-callout-folded' : ''}`,
        'data-callout': c.type,
      }),
    );
    if (!editingHead) {
      if (c.headTo > c.headFrom) {
        out.push(Decoration.inline(c.headFrom, c.headTo, { class: 'ofm-callout-head' }));
      }
      if (c.titleEnd > c.headTo) {
        out.push(Decoration.inline(c.headTo, c.titleEnd, { class: 'ofm-callout-title-text' }));
      }
      out.push(
        Decoration.widget(c.headFrom, titleWidget(c, hidden, label), {
          side: -1,
          key: `callout:${c.type}:${c.title === ''}:${foldable}:${hidden}`,
          stopEvent: () => true,
          ignoreSelection: true,
        }),
      );
    }
    if (hidden) {
      if (c.breakAt !== null) {
        out.push(Decoration.inline(c.breakAt, c.paragraphEnd, { class: 'ofm-callout-hidden' }));
      }
      let at = pos + 1 + (node.firstChild?.nodeSize ?? 0);
      for (let i = 1; i < node.childCount; i++) {
        const child = node.child(i);
        out.push(Decoration.node(at, at + child.nodeSize, { class: 'ofm-callout-hidden' }));
        at += child.nodeSize;
      }
    }
    return true;
  });
  return DecorationSet.create(state.doc, out);
}

/** The blockquotes the selection is in or next to (their positions, as a key). */
function touchedQuotes(state: EditorState): string {
  const { doc, selection } = state;
  const at: number[] = [];
  doc.nodesBetween(
    Math.max(0, selection.from - 1),
    Math.min(doc.content.size, selection.to + 1),
    (node, pos) => {
      if (node.type.name === 'blockquote') at.push(pos);
      return !node.isTextblock;
    },
  );
  return at.join(',');
}

function flipOf(tr: Transaction): number | undefined {
  return (tr.getMeta(calloutKey) as Meta | undefined)?.flip;
}

export const calloutsPlugin = $prose(
  () =>
    new Plugin<CalloutState>({
      key: calloutKey,
      state: {
        init: (_, state) => ({
          flipped: new Set(),
          touched: touchedQuotes(state),
          decorations: build(state, new Set()),
        }),
        apply(tr, value, _old, state) {
          let flipped = value.flipped;
          if (tr.docChanged) {
            flipped = new Set([...flipped].map((p) => tr.mapping.map(p, -1)));
          }
          const flip = flipOf(tr);
          if (flip !== undefined) {
            const next = new Set(flipped);
            if (next.has(flip)) next.delete(flip);
            else next.add(flip);
            flipped = next;
          }
          if (!tr.docChanged && flip === undefined) {
            if (!tr.selectionSet) return value;
            // only the selection moved: what depends on it (the source of a head, a folded body that the
            // caret is in) matters only in the callouts it is in or was in
            const touched = touchedQuotes(state);
            if (touched === '' && value.touched === '') return value;
            return { flipped, touched, decorations: build(state, flipped) };
          }
          return { flipped, touched: touchedQuotes(state), decorations: build(state, flipped) };
        },
      },
      props: { decorations: (state) => calloutKey.getState(state)?.decorations ?? null },
    }),
);
