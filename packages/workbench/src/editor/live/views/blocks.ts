// Diagrams, embedded searches and display math in the Live editor (A-W5a): a ```mermaid, ```query or
// `$$` block shows what it makes (`renderMermaid`, `renderQuery`, `renderMath`) instead of its source,
// until the caret is in it (or next to it). The code
// block of Crepe stays where it is, hidden by a decoration; the drawing is a widget after it. Neither
// touches the document.
//
// A widget is drawn once per content: its key is the language and the source, so a decoration set that
// is built again (any keystroke elsewhere) keeps the element, and the render is freed when the element
// goes (`destroy`), as the CodeMirror widgets do.
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { disposeQueryBlock } from '../../../query/block';
import type { EmbedDisposer } from '../../context';
import { release, safely, type LiveViewsHost } from './host';

const DRAWN = new Set(['mermaid', 'query', 'latex']);

export const drawnLanguage = (node: PMNode): string | null => {
  if (node.type.name !== 'code_block') return null;
  const language = String(node.attrs['language'] ?? '').toLowerCase();
  return DRAWN.has(language) && node.textContent.trim() !== '' ? language : null;
};

/** What frees the drawing in an element, when the render hands one back. */
const disposers = new WeakMap<HTMLElement, EmbedDisposer>();

function widget(host: LiveViewsHost, language: string, source: string) {
  // the widget sits right after its block, so the block's end is the widget's position
  const sizeOfBlock = source.length + 2;
  return (view: EditorView, getPos: () => number | undefined): HTMLElement => {
    const el = document.createElement('div');
    el.className = `ofm-drawn ofm-${language}`;
    el.contentEditable = 'false';
    safely(el, source, () => {
      const ctx = host.context();
      if (language === 'mermaid') {
        ctx.renderMermaid(source, el);
      } else if (language === 'latex') {
        // display math: `$$` … `$$` alone, or a ```latex fence
        ctx.renderMath(source, true, el);
      } else if (ctx.renderQuery) {
        const d = ctx.renderQuery(source, el);
        if (d) disposers.set(el, d);
      } else {
        el.textContent = source;
      }
    });
    // a click that is not on a control of the drawing takes the caret into the source
    el.addEventListener('mousedown', (e) => {
      if ((e.target as Element).closest('a, button, input, select, summary, [role="button"]'))
        return;
      e.preventDefault();
      const at = getPos();
      if (at === undefined) return;
      const pos = at - sizeOfBlock;
      view.dispatch(
        view.state.tr
          .setSelection(TextSelection.near(view.state.doc.resolve(pos + 1)))
          .scrollIntoView(),
      );
      view.focus();
    });
    return el;
  };
}

function touched(state: EditorState): string {
  const { doc, selection } = state;
  const at: number[] = [];
  doc.nodesBetween(
    Math.max(0, selection.from - 1),
    Math.min(doc.content.size, selection.to + 1),
    (node, pos) => {
      if (drawnLanguage(node)) at.push(pos);
      return !node.isTextblock;
    },
  );
  return at.join(',');
}

function build(state: EditorState, host: LiveViewsHost): DecorationSet {
  const { selection } = state;
  const out: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    const language = drawnLanguage(node);
    if (!language) return !node.isTextblock;
    const end = pos + node.nodeSize;
    // the caret in the block, or next to it (the way the other constructs show their source)
    if (selection.from <= end && selection.to >= pos) return false;
    out.push(Decoration.node(pos, end, { class: 'ofm-block-drawn' }));
    out.push(
      Decoration.widget(end, widget(host, language, node.textContent), {
        side: -1,
        key: `${language}:${node.textContent}`,
        stopEvent: () => true,
        ignoreSelection: true,
        destroy: (dom) => {
          const el = dom as HTMLElement;
          release(disposers.get(el));
          disposers.delete(el);
          disposeQueryBlock(el);
        },
      }),
    );
    return false;
  });
  return DecorationSet.create(state.doc, out);
}

interface BlockState {
  touched: string;
  decorations: DecorationSet;
}

const blocksKey = new PluginKey<BlockState>('memobrain-live-blocks');

export const blocksPlugin = (host: LiveViewsHost) =>
  $prose(
    () =>
      new Plugin<BlockState>({
        key: blocksKey,
        state: {
          init: (_, state) => ({ touched: touched(state), decorations: build(state, host) }),
          apply(tr, value, _old, state) {
            if (!tr.docChanged && !tr.selectionSet) return value;
            const now = touched(state);
            // a move of the caret that leaves the same blocks under it changes nothing
            if (!tr.docChanged && now === value.touched) return value;
            return { touched: now, decorations: build(state, host) };
          },
        },
        props: { decorations: (state) => blocksKey.getState(state)?.decorations ?? null },
      }),
  );
