// The handle of the blocks (ADR-0049, the chrome of the playground): a "+" and a grip that follow the pointer
// to the block it is over. The grip drags the block (what moves is ProseMirror's own drag of a node, which
// the plugin of the blocks prepares: the editor's drop handler lets a drag without files through), and
// the "+" adds an empty block below and opens the slash menu there.
//
// It is the plugin of the blocks of Milkdown (`@milkdown/kit/plugin/block`) with the markup of Crepe's
// handle, in plain DOM and with names a screen reader can read. Crepe's own feature (`blockEdit`) is not
// used: it brings its own menu, in Vue, with no translation and rules of its own, where the menu of the
// editor is the one of Source (input/suggest.ts).
//
// The handle is for the pointer: its buttons are not in the tab order. What they do has keys of its own
// (`/` for the menu, Alt+Up and Alt+Down for moving a block).
import type { Ctx } from '@milkdown/kit/ctx';
import { editorViewCtx, type Editor } from '@milkdown/kit/core';
import { BlockProvider, block, blockConfig, type ActiveNode } from '@milkdown/kit/plugin/block';
import { findParent } from '@milkdown/kit/prose';
import { Selection, type EditorState, type PluginView } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { armSlash } from '../input/suggest';
import { chromeIcon } from './icons';

export interface HandleHost {
  readOnly: () => boolean;
  /** Whether the slash menu is on (the "+" opens it): the setting `slashCommands`. */
  slashEnabled: () => boolean;
  labels: { addBlock: string; dragBlock: string };
}

/** What the handle does not attach to: the inside of a table, a quote or a callout (they move as a whole). */
const INSIDE = new Set(['table', 'blockquote', 'math_inline']);

/**
 * Adds an empty block after the one the handle is on, with the caret in it. An empty paragraph under the
 * handle is the block to write in, so no other is added. A list item gets an item beside it (a paragraph
 * would have no place in a list), the rest a paragraph. Returns the position of the caret, or null when
 * there was no place for a block.
 */
export function addBlockBelow(
  view: EditorView,
  active: Pick<ActiveNode, 'node' | '$pos'>,
): number | null {
  const { state } = view;
  const { node, $pos } = active;
  const { schema } = state;
  const here = $pos.pos;
  // the handle was put on this block by the pointer: the note may have changed since (a reload, a remote edit)
  if (here > state.doc.content.size || state.doc.nodeAt(here) !== node) return null;
  let at: number;
  const tr = state.tr;
  if (node.type === schema.nodes['paragraph'] && node.content.size === 0) {
    at = here;
  } else {
    const fresh =
      node.type.name === 'list_item'
        ? node.type.createAndFill({ ...node.attrs, checked: null })
        : schema.nodes['paragraph']?.createAndFill();
    if (!fresh) return null;
    at = here + node.nodeSize;
    tr.insert(at, fresh);
  }
  const selection = Selection.near(tr.doc.resolve(at), 1);
  view.dispatch(tr.setSelection(selection).scrollIntoView());
  return selection.from;
}

class HandleView implements PluginView {
  private readonly content: HTMLElement;
  private provider: BlockProvider | null = null;
  private frame = 0;
  private dead = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly host: HandleHost,
  ) {
    const content = document.createElement('div');
    content.className = 'milkdown-block-handle';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'operation-item';
    add.tabIndex = -1;
    add.setAttribute('aria-label', host.labels.addBlock);
    add.append(chromeIcon('add', 24));
    add.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      add.classList.add('active');
    });
    // The pointer acts on release, as Crepe's handle does. A click that no pointer made (a screen reader's, a
    // synthetic one) acts too; the click that follows a release (within half a second) is that release's, and is let go.
    let releasedAt = -Infinity;
    add.addEventListener('pointerup', (e) => {
      e.preventDefault();
      e.stopPropagation();
      add.classList.remove('active');
      releasedAt = performance.now();
      this.add();
    });
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      if (performance.now() - releasedAt > 500) this.add();
    });
    // The grip is the element a drag starts from: a button would not start it in every browser. It is the
    // pointer's alone (the keys move a block with Alt+Up/Down): a screen reader's click on it would select
    // the block, and what is typed next would replace it, so it is not shown to one. The title is the eye's.
    const grip = document.createElement('div');
    grip.className = 'operation-item';
    grip.setAttribute('aria-hidden', 'true');
    grip.title = host.labels.dragBlock;
    grip.append(chromeIcon('dragHandle', 24));
    content.append(add, grip);
    this.content = content;
    // The provider puts the handle in the DOM and binds it to the service of the blocks a frame after it
    // is made, and that cannot be taken back. The editor makes its plugin views and, when the adapter
    // adds a plugin, makes them again: a provider made for the first would leave a handle behind that
    // nothing owns. So the provider is made one frame later, by the view that is still here.
    this.frame = requestAnimationFrame(() => {
      if (this.dead) return;
      this.provider = new BlockProvider({
        ctx,
        content,
        // past the chevron of the fold, which sits in the margin of the block
        getOffset: ({ editorDom }) =>
          editorDom.closest('.live-host')?.getAttribute('data-size') === 'compact' ? 28 : 36,
        getPlacement: ({ active, blockDom }) => {
          if (active.node.type.name === 'heading') return 'left';
          let descendants = 0;
          active.node.descendants((n) => {
            descendants += n.childCount;
          });
          const style = window.getComputedStyle(active.el);
          const padding =
            (Number.parseInt(style.paddingTop, 10) || 0) +
            (Number.parseInt(style.paddingBottom, 10) || 0);
          const height = active.el.getBoundingClientRect().height - padding;
          return descendants > 2 || blockDom.getBoundingClientRect().height < height
            ? 'left-start'
            : 'left';
        },
      });
      this.provider.update();
    });
  }

  update = (view: EditorView, prev: EditorState): void => {
    this.provider?.update();
    // the block the handle is on may be another now (or gone): it comes back with the next move of the pointer
    if (!prev.doc.eq(view.state.doc)) this.provider?.hide();
  };

  destroy = (): void => {
    this.dead = true;
    cancelAnimationFrame(this.frame);
    this.provider?.destroy();
    this.content.remove();
    // the provider that was made a frame ago may not have put the handle in yet
    if (this.provider) requestAnimationFrame(() => this.content.remove());
  };

  private add(): void {
    if (this.host.readOnly()) return;
    const view = this.ctx.get(editorViewCtx);
    if (!view.hasFocus()) view.focus();
    const active = this.provider?.active;
    if (!active) return;
    if (addBlockBelow(view, active) === null) return;
    this.provider?.hide();
    if (this.host.slashEnabled()) armSlash(view);
  }
}

/** Puts the handle of the blocks on the editor (before it is created). */
export function installHandle(editor: Editor, host: HandleHost): Editor {
  return editor
    .config((ctx) => {
      ctx.set(blockConfig.key, {
        filterNodes: (pos) => !findParent((node) => INSIDE.has(node.type.name))(pos),
      });
      ctx.set(block.key, { view: () => new HandleView(ctx, host) });
    })
    .use(block);
}
