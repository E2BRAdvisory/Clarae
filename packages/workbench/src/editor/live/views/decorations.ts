// The decorations of the Live editor that follow the text and the caret (A-W5a). Never a transaction,
// never an attribute of the document: the note is exactly what it was.
//
//   base      what the text alone decides: the part of a wikilink alias that is not shown, the tags of
//             an inline HTML pair (`<b>x</b>`) that is shown as its content, styled. Computed per
//             textblock and remembered by the (immutable) node, so a keystroke recomputes the block it
//             is in and nothing else.
//   active    the atoms and links the caret is in or next to get `ofm-active`: their source shows, as
//             the source of a construct shows under the caret in Live Preview of CodeMirror.
import { parseWikilinkInner } from '@memobrain/markdown';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

/** The inline HTML a pair of tags may style: no attribute of it is read, so nothing of it can be injected. */
const STYLED: Record<string, string> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  cite: 'italic',
  u: 'underline',
  ins: 'underline',
  s: 'strike',
  del: 'strike',
  strike: 'strike',
  mark: 'mark',
  sub: 'sub',
  sup: 'sup',
  kbd: 'kbd',
  code: 'code',
  small: 'small',
};
const TAG = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*)?(\/?)>$/;

/** The name and kind of an inline HTML tag atom (`<b>`, `</b>`, `<br/>`), or null. */
export function htmlTag(raw: string): { name: string; kind: 'open' | 'close' | 'void' } | null {
  const m = TAG.exec(raw);
  if (!m) return null;
  const name = (m[2] ?? '').toLowerCase();
  if (name === 'br' || name === 'hr' || name === 'img' || m[3]) return { name, kind: 'void' };
  return { name, kind: m[1] ? 'close' : 'open' };
}

/** A decoration, relative to the start of the content of its textblock. */
interface Spec {
  node: boolean;
  from: number;
  to: number;
  attrs: Record<string, string>;
}

function specsOf(block: PMNode): Spec[] {
  const out: Spec[] = [];
  const open: { name: string; from: number; to: number }[] = [];
  block.forEach((child, offset) => {
    const end = offset + child.nodeSize;
    if (child.type.name === 'ofm_wikilink' && !child.attrs['embed']) {
      const inner = child.textContent;
      if (parseWikilinkInner(inner).alias) {
        // the target and the bar: the source of the link, which is not shown unless the caret is in it
        out.push({
          node: false,
          from: offset + 1,
          to: offset + 1 + inner.indexOf('|') + 1,
          attrs: { class: 'ofm-wl-hide' },
        });
      }
      return;
    }
    if (child.type.name !== 'raw_inline') return;
    const tag = htmlTag(child.attrs['raw'] as string);
    if (!tag || tag.kind === 'void') return;
    if (tag.kind === 'open') {
      open.push({ name: tag.name, from: offset, to: end });
      return;
    }
    // a closing tag takes the nearest open one of its name (the ones between are left unpaired)
    for (let i = open.length - 1; i >= 0; i--) {
      const o = open[i] as { name: string; from: number; to: number };
      if (o.name !== tag.name) continue;
      open.length = i;
      const style = STYLED[tag.name];
      if (!style) break;
      out.push({ node: true, from: o.from, to: o.to, attrs: { class: 'ofm-html-paired' } });
      out.push({ node: true, from: offset, to: end, attrs: { class: 'ofm-html-paired' } });
      if (o.to < offset) {
        out.push({
          node: false,
          from: o.to,
          to: offset,
          attrs: { class: `ofm-html ofm-html-${style}` },
        });
      }
      break;
    }
  });
  return out;
}

/** The decorations of one textblock, at its place in the document. */
function blockDecorations(block: PMNode, pos: number, memo: WeakMap<PMNode, Spec[]>): Decoration[] {
  if (block.type.spec.code || block.childCount === 0) return [];
  let specs = memo.get(block);
  if (!specs) {
    specs = specsOf(block);
    memo.set(block, specs);
  }
  const base = pos + 1;
  return specs.map((s) =>
    s.node
      ? Decoration.node(base + s.from, base + s.to, s.attrs)
      : Decoration.inline(base + s.from, base + s.to, s.attrs),
  );
}

export function baseDecorations(doc: PMNode, memo: WeakMap<PMNode, Spec[]>): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    decorations.push(...blockDecorations(node, pos, memo));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * The decorations after a transaction: the old ones carried over the edit, and the textblocks the edit
 * touched made again (an edit never changes a decoration of a block it did not touch). A keystroke in a
 * note of thousands of blocks costs one block.
 */
function updateDecorations(
  value: DecorationSet,
  tr: Transaction,
  memo: WeakMap<PMNode, Spec[]>,
): DecorationSet {
  let set = value.map(tr.mapping, tr.doc);
  const touched = new Set<number>();
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_from, _to, start, end) => {
      const from = rest.map(start, -1);
      const to = rest.map(end, 1);
      // one position on each side: a block that was joined to, or split from, the one edited
      tr.doc.nodesBetween(
        Math.max(0, from - 1),
        Math.min(tr.doc.content.size, to + 1),
        (node, pos) => {
          if (!node.isTextblock) return true;
          touched.add(pos);
          return false;
        },
      );
    });
  });
  for (const pos of touched) {
    const block = tr.doc.nodeAt(pos);
    if (!block?.isTextblock) continue;
    set = set.remove(set.find(pos, pos + block.nodeSize));
    set = set.add(tr.doc, blockDecorations(block, pos, memo));
  }
  return set;
}

export const baseKey = new PluginKey<DecorationSet>('memobrain-live-base');

/** The nodes whose source shows when the selection touches them. */
const REVEALED = new Set(['ofm_wikilink', 'raw_inline', 'raw_block']);

/** The nodes the selection is in or next to. */
export function touchedNodes(state: EditorState): { pos: number; node: PMNode }[] {
  const { doc, selection } = state;
  const from = Math.max(0, selection.from - 1);
  const to = Math.min(doc.content.size, selection.to + 1);
  const out: { pos: number; node: PMNode }[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (REVEALED.has(node.type.name)) {
      out.push({ pos, node });
      return false;
    }
    return true;
  });
  return out;
}

const activeKey = new PluginKey<{ at: string; set: DecorationSet }>('memobrain-live-active');

function activeSet(state: EditorState): { at: string; set: DecorationSet } {
  const nodes = touchedNodes(state);
  return {
    at: nodes.map((n) => n.pos).join(','),
    set: DecorationSet.create(
      state.doc,
      nodes.map(({ pos, node }) =>
        Decoration.node(pos, pos + node.nodeSize, { class: 'ofm-active' }),
      ),
    ),
  };
}

export const baseDecorationsPlugin = $prose(() => {
  const memo = new WeakMap<PMNode, Spec[]>();
  return new Plugin<DecorationSet>({
    key: baseKey,
    state: {
      init: (_, state) => baseDecorations(state.doc, memo),
      apply: (tr, value) => (tr.docChanged ? updateDecorations(value, tr, memo) : value),
    },
    props: { decorations: (state) => baseKey.getState(state) ?? null },
  });
});

export const activeDecorationsPlugin = $prose(
  () =>
    new Plugin<{ at: string; set: DecorationSet }>({
      key: activeKey,
      state: {
        init: (_, state) => activeSet(state),
        apply: (tr, value, _old, state) => {
          if (!tr.docChanged && !tr.selectionSet) return value;
          const next = activeSet(state);
          // the same nodes at the same places: the same decorations (no redraw)
          return !tr.docChanged && next.at === value.at ? value : next;
        },
      },
      props: { decorations: (state) => activeKey.getState(state)?.set ?? null },
    }),
);
