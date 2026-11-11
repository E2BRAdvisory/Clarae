// The Live editor's Markdown layer as a Milkdown plugin set (A-D3 to A-D5): installed on any
// editor made of the commonmark and gfm presets (the CrepeBuilder one, or the headless one of the
// tests), AFTER the presets and the Crepe features it overrides.
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import type { Editor } from '@milkdown/kit/core';
import { trailingConfig } from '@milkdown/kit/plugin/trailing';
import { remarkGFMPlugin } from '@milkdown/kit/preset/gfm';
import type { Ctx } from '@milkdown/kit/ctx';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { liveTextHandler } from './ofm/escape';
import { ofmSchemas, MDAST } from './ofm/nodes';
import { liveOptions } from './ofm/options';
import { remarkLivePlugin } from './ofm/remark';
import {
  codeBlockKeepsInfo,
  emphasisUsesFileStyle,
  imageBlockKeepsAlt,
  paragraphWithoutBr,
  strongUsesFileStyle,
  taskWithoutTextHasNoBox,
} from './overrides';

/** The settings that keep the serializer from rewriting what the user did not touch. */
export function liveConfig(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, (o) => {
    const handlers = o.handlers ?? {};
    return {
      ...o,
      join: [...(o.join ?? []), narrowJoin as never],
      handlers: {
        ...handlers,
        thematicBreak: ruleHandler as never,
        text: liveTextHandler as never,
        emphasis: markHandler('emphasis') as never,
        strong: markHandler('strong') as never,
        listItem: listItemHandler() as never,
        [MDAST.verbatim]: verbatimHandler as never,
        [MDAST.highlight]: ((
          node: unknown,
          _p: unknown,
          state: HighlightState,
          info: HighlightInfo,
        ) => {
          const exit = state.enter(MDAST.highlight);
          const tracker = state.createTracker(info);
          let value = tracker.move('==');
          value += tracker.move(
            state.containerPhrasing(node, { before: value, after: '=', ...tracker.current() }),
          );
          value += tracker.move('==');
          exit();
          return value;
        }) as never,
      },
    };
  });
  // the trailing plugin appends an empty paragraph on the first transaction, even a selection
  if (ctx.isInjected(trailingConfig.key)) {
    ctx.update(trailingConfig.key, (p) => ({ ...p, shouldAppend: () => false }));
  }
  // no padding of the cells: a changed cell must not reflow the whole table
  if (ctx.isInjected(remarkGFMPlugin.options.key)) {
    ctx.update(remarkGFMPlugin.options.key, (o) => ({ ...o, tablePipeAlign: false }));
  }
}

interface ListItemNode {
  checked?: boolean | null;
  children?: { type: string }[];
}
interface ListItemState {
  bulletCurrent?: string;
}
type ListItemHandler = (
  node: ListItemNode,
  parent: { ordered?: boolean | null } | undefined,
  state: ListItemState,
  info: unknown,
) => string;

/** The handler of a list item that remark-gfm brings (the one that writes the box of a task). */
function gfmListItem(): ListItemHandler {
  const data: Record<string, unknown> = {};
  (remarkGfm as (this: { data(): Record<string, unknown> }) => void).call({ data: () => data });
  const find = (ext: unknown): ListItemHandler | undefined => {
    if (!ext || typeof ext !== 'object') return undefined;
    const { handlers, extensions } = ext as {
      handlers?: { listItem?: ListItemHandler };
      extensions?: unknown[];
    };
    return handlers?.listItem ?? extensions?.map(find).find((h) => h !== undefined);
  };
  const found = ((data['toMarkdownExtensions'] as unknown[] | undefined) ?? [])
    .map(find)
    .find((h) => h !== undefined);
  if (!found) throw new Error('remark-gfm has no handler of a list item');
  return found;
}

/**
 * A list item, as remark-gfm writes it, but the box of a task is written whatever the delimiter of its list
 * is. Two ordered lists one after the other (a list pasted before a nested one) take turns in the delimiter,
 * `1.` and `1)`, to stay two lists; the handler of the box only looks for `1.` after the marker, and the
 * tasks of the list that has `)` lost their box (the note says other tasks than the editor shows).
 */
function listItemHandler(): ListItemHandler {
  const gfm = gfmListItem();
  return (node, parent, state, info) => {
    const boxed =
      typeof node.checked === 'boolean' &&
      node.children?.[0]?.type === 'paragraph' &&
      parent?.ordered === true &&
      state.bulletCurrent === ')';
    if (!boxed) return gfm(node, parent, state, info);
    // the item is written as for `.` (the width of the marker is the same) and the delimiter is put back
    state.bulletCurrent = '.';
    try {
      return gfm(node, parent, state, info).replace(/^(\d+)\./, '$1)');
    } finally {
      state.bulletCurrent = ')';
    }
  };
}

interface MarkState {
  options: { emphasis?: string; strong?: string };
  enter(name: string): () => void;
  containerPhrasing(node: unknown, info: unknown): string;
}

/**
 * Emphasis and strong, written with the delimiter the node was read with (`_a_` stays `_a_`) or, for
 * a mark made by editing, with the one the file uses (the `marker` of such a mark is empty: see
 * overrides.ts). They are attention for the serializer, as its own handlers are: the delimiters are
 * the ones that can be chosen (`_` does not work inside a word, `a_b_c` is no emphasis, so `*` is used
 * there), and a delimiter that would not read as one where the mark is (`*u[^1]*Roadmap`: a closing
 * delimiter that follows punctuation and precedes a letter is no closing one) is made to work by writing
 * the letter outside it as a character reference (`*u[^1]*&#x52;oadmap`), as the file would have it.
 */
function markHandler(type: 'emphasis' | 'strong') {
  const marker = (node: { marker?: string }, state: MarkState): string =>
    node.marker || state.options[type] || '*';
  const handler = (
    node: { marker?: string },
    _parent: unknown,
    state: MarkState,
    info: HighlightInfo,
  ): string => {
    const exit = state.enter('phrasing');
    const value = state.containerPhrasing({ type: 'root', children: [node] }, info);
    exit();
    return value;
  };
  return Object.assign(handler, {
    attention: (node: { marker?: string }, state: MarkState) => ({
      construct: type,
      markers: marker(node, state) === '_' ? ['_', '*'] : ['*', '_'],
      sizes: [type === 'strong' ? 2 : 1],
    }),
    peek: (node: { marker?: string }, _parent: unknown, state: MarkState) => marker(node, state),
  });
}

interface FlowNode {
  type: string;
  value?: string;
}
interface FlowParent {
  spread?: boolean | null;
  children?: FlowNode[];
}
interface RuleState {
  options: { rule?: string; ruleRepetition?: number; ruleSpaces?: boolean };
}

/** The blocks a paragraph that follows them with no blank line is a line of (a lazy line, a row). */
const TAKE_A_LINE = new Set(['list', 'blockquote', 'table']);

/** A block of each kind, as the text the reading of two blocks one under the other is tried with. */
const SAMPLE: Record<string, string> = {
  paragraph: 'x',
  list: '- x',
  blockquote: '> x',
  table: '| x |\n| - |',
  heading: '# x',
  code: '```\nx\n```',
  math: '$$\nx\n$$',
  thematicBreak: '***',
};

const blockReader = unified().use(remarkParse).use(remarkGfm);
const apartMemo = new Map<string, boolean>();

/** Whether `a` then `b` on the next line are read as the blocks of each, none taking a line of the other. */
function readApart(a: string, b: string): boolean {
  const key = a + '\u0000' + b;
  let apart = apartMemo.get(key);
  if (apart === undefined) {
    const count = (md: string): number => blockReader.parse(md).children.length;
    apart = count(a) + count(b) === count(a + '\n' + b);
    if (apartMemo.size > 500) apartMemo.clear();
    apartMemo.set(key, apart);
  }
  return apart;
}

const sampleOf = (node: FlowNode): string | undefined =>
  node.type === MDAST.verbatim ? (node.value ?? '') : SAMPLE[node.type];

/**
 * The blocks of a narrow item (or list) are written one under the other, and the serializer's own rule
 * (`joinDefaults`) knows of paragraphs and HTML only: a paragraph right under a list, a quote or a table
 * is a line of it (`- y`, then `line` is `y line`; under a table, a row), what the editor shows as two
 * blocks would be one for the file. A blank line keeps them two (the item is a wide one for the file,
 * as it is the only way to say it). A raw block is the text it holds, which may take the line of what
 * follows it or be one of what precedes it: the two are tried. A file that is read never has such a
 * pair with no blank line between (it would have been read as one block), so the files the user did not
 * edit are written as they were.
 */
export function narrowJoin(
  left: FlowNode,
  right: FlowNode,
  parent: FlowParent,
): number | undefined {
  if (parent.spread !== false) return undefined;
  if (right.type === 'paragraph' && TAKE_A_LINE.has(left.type)) return 1;
  if (left.type !== MDAST.verbatim && right.type !== MDAST.verbatim) return undefined;
  const a = sampleOf(left);
  const b = sampleOf(right);
  if (a === undefined || b === undefined) return undefined;
  return readApart(a, b) ? undefined : 1;
}

/** Whether a `---` that comes right under `node` would be read as its underline (a setext heading). */
const underlined = (node: FlowNode | undefined): boolean =>
  node !== undefined &&
  (node.type === 'paragraph' ||
    (node.type === MDAST.verbatim && !readApart(node.value ?? '', '---')));

/**
 * A rule, with the marker the file uses; but in a narrow item a rule right under its text is written
 * `***`: a `---` there is the underline of a heading (the text becomes a heading, a task is lost), and
 * a blank line would make the whole list a wide one, which is not what the editor shows.
 */
export function ruleHandler(
  node: FlowNode,
  parent: FlowParent | undefined,
  state: RuleState,
): string {
  const { rule = '*', ruleRepetition = 3, ruleSpaces = false } = state.options;
  const kids = parent?.children ?? [];
  const before = kids[kids.indexOf(node) - 1];
  const marker = rule === '-' && parent?.spread === false && underlined(before) ? '*' : rule;
  return Array.from({ length: ruleRepetition }, () => marker).join(ruleSpaces ? ' ' : '');
}

/**
 * Written as the value. `peek` tells the neighbours the first character that will really be there
 * (the default of an unknown node is none), so that a `!` before a raw `[ref]` is still escaped.
 */
const verbatimHandler = Object.assign((node: { value?: string }) => node.value ?? '', {
  peek: (node: { value?: string }) => (node.value ?? '').charAt(0),
});

interface HighlightInfo {
  before: string;
  after: string;
}
interface HighlightState {
  enter(name: string): () => void;
  createTracker(info: HighlightInfo): {
    move(s: string): string;
    current(): { now: { line: number; column: number }; lineShift: number };
  };
  containerPhrasing(node: unknown, info: unknown): string;
}

/**
 * Installs the layer: config, the first remark plugin, the OFM nodes, the overrides. The emoji plugins
 * are a chunk of their own (chunks/emoji.ts) and are added after it, in the same place of the chain.
 */
export function installLive(editor: Editor): Editor {
  return editor
    .config(liveConfig)
    .use(liveOptions)
    .use(remarkLivePlugin)
    .use(ofmSchemas)
    .use(imageBlockKeepsAlt)
    .use(codeBlockKeepsInfo)
    .use(paragraphWithoutBr)
    .use(emphasisUsesFileStyle)
    .use(strongUsesFileStyle)
    .use(taskWithoutTextHasNoBox);
}
