// The ProseMirror side of the Markdown layer (A-D3, A-D4): what has no schema of its own, and the
// Obsidian constructs.
//
//   raw_block, raw_inline   atoms that hold the SOURCE text of whatever the editor cannot project
//                           (comments, link definitions, HTML, setext headings, indented code,
//                           entities, autolinks, ...) and put it back as it was.
//   ofm_wikilink            [[Note|alias]] and ![[embed]]: an inline node whose content is the raw
//                           text between the brackets (revealed for editing when the caret is in it).
//   ofm_tag, ofm_blockid    #tag and ^id: marks over the text, which keeps its `#`/`^`.
//   ofm_highlight           ==highlight==: a mark that wraps its content.
//
// Every one of them is written back letter for letter: the Markdown serializer never gets to escape
// or rewrite them (what it would do to `[[x]]` and `#tag` is the first thing the spike measured).
//
// The mdast node types (`ofmRawBlock`, ...) are produced by the remark plugin of remark.ts.
import { $markSchema, $nodeSchema } from '@milkdown/kit/utils';
import type { Node as PMNode } from '@milkdown/kit/prose/model';

export const MDAST = {
  rawBlock: 'ofmRawBlock',
  rawInline: 'ofmRawInline',
  wikilink: 'ofmWikilink',
  tag: 'ofmTag',
  blockId: 'ofmBlockId',
  highlight: 'ofmHighlight',
  /** A node of the output tree that is written as its value, whatever the value (no escaping). */
  verbatim: 'ofmVerbatim',
} as const;

interface RawNode {
  type: string;
  value?: string;
  embed?: boolean;
}

export const rawBlockSchema = $nodeSchema('raw_block', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  isolating: true,
  attrs: { raw: { default: '', validate: 'string' } },
  parseDOM: [
    {
      tag: 'pre[data-ofm="raw-block"]',
      preserveWhitespace: 'full' as const,
      getAttrs: (dom) => ({ raw: dom.textContent ?? '' }),
    },
  ],
  toDOM: (node: PMNode) => ['pre', { 'data-ofm': 'raw-block' }, node.attrs['raw'] as string],
  parseMarkdown: {
    match: (n: RawNode) => n.type === MDAST.rawBlock,
    runner: (state, node, type) => {
      state.addNode(type, { raw: (node as RawNode).value ?? '' });
    },
  },
  toMarkdown: {
    match: (n: PMNode) => n.type.name === 'raw_block',
    runner: (state, node) => {
      state.addNode(MDAST.verbatim, undefined, node.attrs['raw'] as string);
    },
  },
}));

export const rawInlineSchema = $nodeSchema('raw_inline', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  marks: '',
  attrs: { raw: { default: '', validate: 'string' } },
  parseDOM: [
    {
      tag: 'span[data-ofm="raw-inline"]',
      getAttrs: (dom) => ({ raw: dom.textContent ?? '' }),
    },
  ],
  toDOM: (node: PMNode) => ['span', { 'data-ofm': 'raw-inline' }, node.attrs['raw'] as string],
  parseMarkdown: {
    match: (n: RawNode) => n.type === MDAST.rawInline,
    runner: (state, node, type) => {
      state.addNode(type, { raw: (node as RawNode).value ?? '' });
    },
  },
  toMarkdown: {
    match: (n: PMNode) => n.type.name === 'raw_inline',
    runner: (state, node) => {
      state.addNode(MDAST.verbatim, undefined, node.attrs['raw'] as string);
    },
  },
}));

export const wikilinkSchema = $nodeSchema('ofm_wikilink', () => ({
  group: 'inline',
  inline: true,
  content: 'text*',
  marks: '',
  selectable: true,
  attrs: { embed: { default: false, validate: 'boolean' } },
  parseDOM: [
    {
      tag: 'span[data-ofm="wikilink"]',
      getAttrs: (dom) => ({ embed: dom.dataset['embed'] === 'true' }),
    },
  ],
  toDOM: (node: PMNode) => [
    'span',
    { 'data-ofm': 'wikilink', 'data-embed': String(node.attrs['embed']) },
    0,
  ],
  parseMarkdown: {
    match: (n: RawNode) => n.type === MDAST.wikilink,
    // addNode with the content: openNode/closeNode would drop the marks of the surroundings.
    runner: (state, node, type) => {
      const inner = (node as RawNode).value ?? '';
      state.addNode(type, { embed: Boolean((node as RawNode).embed) }, [state.schema.text(inner)]);
    },
  },
  toMarkdown: {
    match: (n: PMNode) => n.type.name === 'ofm_wikilink',
    runner: (state, node) => {
      const bang = node.attrs['embed'] ? '!' : '';
      state.addNode(MDAST.verbatim, undefined, `${bang}[[${node.textContent}]]`);
    },
  },
}));

/** A mark whose text is written as it is (the way `inlineCode` is), never escaped. */
function verbatimMark(id: string, mdastType: string, dom: string) {
  return $markSchema(id, () => ({
    priority: 100,
    inclusive: false,
    parseDOM: [{ tag: `span[data-ofm="${dom}"]` }],
    toDOM: () => ['span', { 'data-ofm': dom }],
    parseMarkdown: {
      match: (n: RawNode) => n.type === mdastType,
      runner: (state, node, markType) => {
        state.openMark(markType);
        state.addText((node as RawNode).value ?? '');
        state.closeMark(markType);
      },
    },
    toMarkdown: {
      match: (mark) => mark.type.name === id,
      runner: (state, mark, node) => {
        state.withMark(mark, MDAST.verbatim, node.text ?? '');
        return true;
      },
    },
  }));
}

export const tagSchema = verbatimMark('ofm_tag', MDAST.tag, 'tag');
export const blockIdSchema = verbatimMark('ofm_blockid', MDAST.blockId, 'blockid');

export const highlightSchema = $markSchema('ofm_highlight', () => ({
  parseDOM: [{ tag: 'mark[data-ofm="highlight"]' }],
  toDOM: () => ['mark', { 'data-ofm': 'highlight' }],
  parseMarkdown: {
    match: (n: RawNode) => n.type === MDAST.highlight,
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.next((node as unknown as { children: never[] }).children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'ofm_highlight',
    runner: (state, mark) => {
      state.withMark(mark, MDAST.highlight);
    },
  },
}));

export const ofmSchemas = [
  rawBlockSchema,
  rawInlineSchema,
  wikilinkSchema,
  tagSchema,
  blockIdSchema,
  highlightSchema,
].flat();
