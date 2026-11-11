// The views of what the editor holds as source (the `raw_inline` and `raw_block` atoms of ofm/nodes.ts):
// comments, `$$…$$` on a line, footnote references and inline footnotes, HTML. An atom is edited as text
// only in Source, so these views only decide how each kind looks:
//
//   %%comment%%        out of sight, until the caret is in or next to it (the source shows)
//   $$x$$              typeset (`renderMath`); the source shows under the caret
//   [^1]   ^[note]     footnote marks
//   <br>               a line break
//   <b>…</b>           a pair of tags that style is hidden (decorations.ts); the others stay source
//   HTML block         sanitized (DOMPurify) and shown as HTML; its source shows under the caret
//
// Every one keeps its raw text in the DOM (`.ofm-raw-text`): hidden by CSS, never absent, so the
// clipboard and the accessibility tree see what the file says.
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import type { NodeViewConstructor } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/kit/utils';
import { setSanitizedHtml } from '../../../util/sanitize';
import { rawBlockSchema, rawInlineSchema } from '../ofm/nodes';
import { htmlTag } from './decorations';
import { safely, type LiveViewsHost } from './host';
import { stripRemoteResources } from '../../../preview/service';

const COMMENT = /^%%[\s\S]*%%$/;
const MATH = /^\$\$([\s\S]+)\$\$$/;
const FOOTREF = /^\[\^[^\]\s]+\]$/;
const FOOTNOTE_INLINE = /^\^\[[\s\S]*\]$/;
const FOOTDEF = /^\[\^[^\]\s]+\]:/;
const LINKDEF = /^\[[^\]]+\]:\s/;
const HTML_BLOCK = /^\s*<[A-Za-z/!?]/;

function span(cls: string, text?: string): HTMLElement {
  const el = document.createElement('span');
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** The kind of an inline atom, from its source. */
export type InlineKind = 'comment' | 'math' | 'footref' | 'footnote' | 'br' | 'html' | 'source';

export function inlineKind(raw: string): InlineKind {
  if (COMMENT.test(raw)) return 'comment';
  if (MATH.test(raw)) return 'math';
  if (FOOTREF.test(raw)) return 'footref';
  if (FOOTNOTE_INLINE.test(raw)) return 'footnote';
  const tag = htmlTag(raw);
  if (tag) return tag.name === 'br' ? 'br' : 'html';
  return 'source';
}

class RawInlineView {
  readonly dom: HTMLElement;

  constructor(
    private readonly node: PMNode,
    private readonly host: LiveViewsHost,
  ) {
    const raw = node.attrs['raw'] as string;
    const kind = inlineKind(raw);
    this.dom = span(`ofm-raw ofm-raw-${kind}`);
    this.dom.dataset['ofm'] = 'raw-inline';
    this.dom.append(span('ofm-raw-text', raw));
    if (kind === 'math') {
      const render = span('ofm-math-render');
      render.contentEditable = 'false';
      // `$$x$$` inside a line is typeset in the line (the display style is for a block of its own)
      const tex = (MATH.exec(raw) as RegExpExecArray)[1]?.trim() ?? '';
      safely(render, tex, () => host.context().renderMath(tex, false, render));
      this.dom.prepend(render);
    }
  }

  update(node: PMNode): boolean {
    return node.type === this.node.type && node.attrs['raw'] === this.node.attrs['raw'];
  }
}

class RawBlockView {
  readonly dom: HTMLElement;

  constructor(private readonly node: PMNode) {
    const raw = node.attrs['raw'] as string;
    this.dom = document.createElement('div');
    this.dom.dataset['ofm'] = 'raw-block';
    const pre = document.createElement('pre');
    pre.className = 'ofm-raw-text';
    pre.textContent = raw;
    let kind = 'source';
    if (COMMENT.test(raw.trim()) && raw.split('%%').length === 3) kind = 'comment';
    else if (FOOTDEF.test(raw)) kind = 'footdef';
    else if (LINKDEF.test(raw)) kind = 'linkdef';
    else if (HTML_BLOCK.test(raw)) {
      const render = document.createElement('div');
      render.className = 'ofm-html-render';
      render.contentEditable = 'false';
      setSanitizedHtml(render, raw);
      // the note shows what is in the vault: nothing is fetched from anywhere else
      stripRemoteResources(render);
      // nothing to show (a comment, a tag the sanitizer takes away): the source stays what is seen
      if (render.childNodes.length > 0) {
        kind = 'htmlblock';
        this.dom.append(render);
      }
    }
    this.dom.classList.add('ofm-raw', `ofm-raw-${kind}`);
    this.dom.append(pre);
  }

  update(node: PMNode): boolean {
    return node.type === this.node.type && node.attrs['raw'] === this.node.attrs['raw'];
  }
}

export const rawInlineView = (host: LiveViewsHost) =>
  $view(rawInlineSchema.node, (): NodeViewConstructor => (node) => new RawInlineView(node, host));

export const rawBlockView = $view(
  rawBlockSchema.node,
  (): NodeViewConstructor => (node) => new RawBlockView(node),
);
