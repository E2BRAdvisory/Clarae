// The views of images (A-W5a): the block image (`![alt](src)` alone in its paragraph: Crepe's
// `image-block`) and the inline one. Both draw through the application's `renderImage`, the way the
// application does everywhere: an image of the vault is read through the backend (a path relative to
// the note, with the `|300` or `|300x200` of its alt as the size), one of the web only when its scheme
// is one that may be opened (`isSafeExternalUrl`). Crepe's own views are replaced: they would load
// `src` as it stands (a relative path would not load), and their resize handle writes a ratio that the
// file has no place for.
//
// An image that cannot be drawn shows its alt text (or the path): the source is never lost.
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { imageSchema } from '@milkdown/kit/preset/commonmark';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import type { NodeViewConstructor } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/kit/utils';
import { isSafeExternalUrl } from '../../../util/sanitize';
import { safeDecodeURI } from '../../../util/uri';
import type { EmbedDisposer } from '../../context';
import { release, safely, type LiveViewsHost } from './host';

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

class ImageView {
  readonly dom: HTMLElement;
  private readonly body: HTMLElement;
  private disposer: EmbedDisposer | void = undefined;
  private drawn = '';

  constructor(
    private node: PMNode,
    private readonly block: boolean,
    private readonly host: LiveViewsHost,
  ) {
    this.dom = document.createElement(block ? 'div' : 'span');
    this.dom.className = block ? 'ofm-image ofm-image-block' : 'ofm-image ofm-image-inline';
    this.dom.dataset['ofm'] = block ? 'image-block' : 'image';
    this.body = document.createElement('span');
    this.body.className = 'ofm-image-body';
    this.body.contentEditable = 'false';
    this.dom.append(this.body);
    this.draw();
  }

  private draw(): void {
    const src = this.node.attrs['src'] as string;
    const alt = (this.node.attrs['alt'] as string | null) ?? '';
    const key = `${src}\n${alt}`;
    if (key === this.drawn) return;
    this.drawn = key;
    release(this.disposer);
    this.disposer = undefined;
    this.body.replaceChildren();
    this.dom.classList.remove('ofm-image-missing');
    const title = (this.node.attrs[this.block ? 'caption' : 'title'] as string | null) ?? '';
    if (title) this.dom.title = title;
    else this.dom.removeAttribute('title');
    if (!src || (SCHEME.test(src) && !isSafeExternalUrl(src))) {
      // nothing to load, or a scheme that is not opened from a note: the text stands for the image
      this.body.textContent = alt || src;
      this.dom.classList.add('ofm-image-missing');
      return;
    }
    this.disposer = safely(this.body, alt || src, () =>
      this.host.context().renderImage(safeDecodeURI(src), alt, this.body),
    );
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.draw();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('ofm-selected');
  }

  deselectNode(): void {
    this.dom.classList.remove('ofm-selected');
  }

  destroy(): void {
    release(this.disposer);
    this.disposer = undefined;
  }
}

export const imageBlockView = (host: LiveViewsHost) =>
  $view(
    imageBlockSchema.node,
    (): NodeViewConstructor => (node) => new ImageView(node, true, host),
  );

export const imageInlineView = (host: LiveViewsHost) =>
  $view(imageSchema.node, (): NodeViewConstructor => (node) => new ImageView(node, false, host));
