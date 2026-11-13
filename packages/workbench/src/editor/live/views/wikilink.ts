// The view of `[[wikilinks]]` and `![[embeds]]` (A-W5a, A-D4). The node keeps the raw text between the
// brackets as its content (ofm/nodes.ts), so it stays editable text; what changes with the caret is only
// how it looks:
//
//   caret outside    a link shows its display text (the alias, or the whole inside) in the colour of
//                    links, dotted when the note does not resolve; an embed shows what it embeds
//   caret in or next the raw source, with the brackets (a CSS rule of views.css puts them back)
//
// The view sets the attributes the interactions read (`data-target`, `data-heading`, `data-block`) and
// the resolution state; the part of an alias that is hidden is an inline decoration (decorations.ts).
import { parseWikilinkInner } from '@clarae/markdown';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import type { NodeViewConstructor, ViewMutationRecord } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/kit/utils';
import type { EmbedDisposer, LinkSpec } from '../../context';
import { wikilinkSchema } from '../ofm/nodes';
import { release, safely, type LiveViewsHost } from './host';

/** Elements of a rendered embed that take the mouse themselves (links, players, buttons). */
export const INTERACTIVE =
  'a, button, video, audio, input, summary, canvas, [role="button"], .embed-note-title';

/** How long an embed waits after the last edit of its source before it is drawn again. */
export const EMBED_REDRAW_MS = 250;

export const specOf = (inner: string, embed: boolean): LinkSpec => {
  const p = parseWikilinkInner(inner);
  return { target: p.target, heading: p.heading, block: p.block, alias: p.alias, embed };
};

class WikilinkView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly embed: boolean;
  private readonly render: HTMLElement | null;
  private disposer: EmbedDisposer | void = undefined;
  private shown: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly off: () => void;

  constructor(
    private node: PMNode,
    private readonly host: LiveViewsHost,
  ) {
    this.embed = Boolean(node.attrs['embed']);
    this.dom = document.createElement('span');
    this.dom.dataset['ofm'] = 'wikilink';
    this.dom.dataset['embed'] = String(this.embed);
    this.dom.classList.add(this.embed ? 'ofm-embed' : 'ofm-wikilink');
    if (this.embed) {
      this.render = document.createElement('span');
      this.render.className = 'ofm-embed-render';
      this.render.contentEditable = 'false';
      this.dom.append(this.render);
    } else {
      this.render = null;
    }
    this.contentDOM = document.createElement('span');
    this.contentDOM.className = 'ofm-wl-text';
    this.dom.append(this.contentDOM);
    this.refresh();
    if (this.embed) this.draw();
    // a note that appeared, was renamed or went: the link may resolve differently now
    this.off = host.subscribe(() => this.refresh());
  }

  /** The attributes the interactions read, and whether the target is known. */
  private refresh(): void {
    if (this.embed) return;
    const spec = specOf(this.node.textContent, false);
    const { dataset } = this.dom;
    dataset['target'] = spec.target;
    dataset['heading'] = spec.heading;
    dataset['block'] = spec.block;
    let known: boolean | undefined;
    try {
      const ctx = this.host.context();
      known = spec.target ? ctx.resolved(spec.target) : true;
      if (known === undefined && spec.target) ctx.requestResolve(spec.target);
    } catch {
      known = true; // a resolver that fails says nothing against the link
    }
    this.dom.classList.toggle('ofm-unresolved', known === false);
  }

  private draw(): void {
    const render = this.render;
    if (!render) return;
    const inner = this.node.textContent;
    if (this.shown === inner) return;
    this.shown = inner;
    release(this.disposer);
    this.disposer = undefined;
    render.replaceChildren();
    this.disposer = safely(render, `![[${inner}]]`, () =>
      this.host.context().renderEmbed(specOf(inner, true), render),
    );
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type || Boolean(node.attrs['embed']) !== this.embed) return false;
    this.node = node;
    this.refresh();
    if (this.embed && node.textContent !== this.shown) {
      // while the source is being typed it is not drawn on every key
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.draw(), EMBED_REDRAW_MS);
    }
    return true;
  }

  ignoreMutation(m: ViewMutationRecord): boolean {
    // what the embed draws into its own element is not an edit of the document
    return !this.contentDOM.contains(m.target);
  }

  stopEvent(e: Event): boolean {
    const t = e.target;
    return (
      t instanceof Element &&
      this.render !== null &&
      this.render.contains(t) &&
      !!t.closest(INTERACTIVE)
    );
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.off();
    release(this.disposer);
    this.disposer = undefined;
  }
}

export const wikilinkView = (host: LiveViewsHost) =>
  $view(wikilinkSchema.node, (): NodeViewConstructor => (node) => new WikilinkView(node, host));
