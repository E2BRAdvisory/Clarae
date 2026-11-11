// The formatting commands of the handle (`exec`) on a Live document: what each one does to the
// document, with the ProseMirror primitives (a mark toggled, a block turned into another, a list made).
// There is no Markdown text to wrap here: `**hello**` is a strong mark on `hello`, and the file gets its
// markers from the layer when the note is written.
import { insertTableCommand } from '@milkdown/kit/preset/gfm';
import { commandsCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { lift, setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands';
import { redo, undo } from '@milkdown/kit/prose/history';
import type { MarkType, Node as PMNode, NodeType, Schema } from '@milkdown/kit/prose/model';
import { liftListItem, wrapInList } from '@milkdown/kit/prose/schema-list';
import { type Command, NodeSelection, Selection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { EditorCommand } from '../handle';
import { moveBlock } from './input/lists';
import { cycleTask } from './input/tasks';

export interface CommandHost {
  view: EditorView;
  schema: Schema;
  /** The editor's context, for the commands of the presets that need it. */
  ctx(): Ctx;
}

const run = (host: CommandHost, command: Command): boolean => {
  const { view } = host;
  return command(view.state, view.dispatch.bind(view), view);
};

const node = (schema: Schema, name: string): NodeType => {
  const type = schema.nodes[name];
  if (!type) throw new Error(`the Live schema has no ${name}`);
  return type;
};
const mark = (schema: Schema, name: string): MarkType => {
  const type = schema.marks[name];
  if (!type) throw new Error(`the Live schema has no ${name}`);
  return type;
};

const toggle =
  (name: string, attrs?: Record<string, unknown>) =>
  (host: CommandHost): boolean =>
    run(host, toggleMark(mark(host.schema, name), attrs));

/** The nearest ancestor of the selection that is of a type, or null. */
function ancestor(view: EditorView, types: readonly NodeType[]): PMNode | null {
  const { $from } = view.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (types.includes(n.type)) return n;
  }
  return null;
}

/** Wraps the selection in two atoms that hold HTML (`<u>` and `</u>`); takes them away when they are there. */
function wrapHtml(open: string, close: string) {
  return (host: CommandHost): boolean => {
    const { view, schema } = host;
    const raw = node(schema, 'raw_inline');
    const { from, to, empty } = view.state.selection;
    const before = view.state.doc.resolve(from).nodeBefore;
    const after = view.state.doc.resolve(to).nodeAfter;
    const is = (n: PMNode | null | undefined, text: string): boolean =>
      n?.type === raw && n.attrs['raw'] === text;
    const tr = view.state.tr;
    if (is(before, open) && is(after, close)) {
      tr.delete(to, to + after!.nodeSize).delete(from - before!.nodeSize, from);
    } else {
      tr.insert(to, raw.create({ raw: close })).insert(from, raw.create({ raw: open }));
      const inside = from + 1;
      tr.setSelection(TextSelection.create(tr.doc, inside, empty ? inside : to + 1));
    }
    view.dispatch(tr.scrollIntoView());
    return true;
  };
}

/** `%%text%%`: the selected text becomes a comment (an atom, as a comment is when a file is read), or back to text. */
function toggleComment(host: CommandHost): boolean {
  const { view, schema } = host;
  const raw = node(schema, 'raw_inline');
  const { selection, doc } = view.state;
  const picked = selection instanceof NodeSelection ? selection.node : undefined;
  if (picked?.type === raw && /^%%[\s\S]*%%$/.test(picked.attrs['raw'] as string)) {
    const inner = (picked.attrs['raw'] as string).slice(2, -2);
    const tr = view.state.tr.replaceSelectionWith(schema.text(inner || ' '), false);
    view.dispatch(tr.scrollIntoView());
    return true;
  }
  const text = doc.textBetween(selection.from, selection.to, '\n');
  const comment = raw.create({ raw: `%%${text}%%` });
  const from = selection.from;
  const tr = view.state.tr.replaceSelectionWith(comment, false);
  // the comment stays selected: the same command takes it back to text
  tr.setSelection(NodeSelection.create(tr.doc, from));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** A wikilink (or embed) with the selected text in it, ready to be typed into. */
function insertWikilink(embed: boolean) {
  return (host: CommandHost): boolean => {
    const { view, schema } = host;
    const type = node(schema, 'ofm_wikilink');
    const { from, to } = view.state.selection;
    const text = view.state.doc.textBetween(from, to, ' ');
    const link = type.create({ embed }, text ? schema.text(text) : undefined);
    const tr = view.state.tr.replaceRangeWith(from, to, link);
    // the caret goes inside the brackets, after what was selected
    tr.setSelection(TextSelection.create(tr.doc, from + 1 + text.length));
    view.dispatch(tr.scrollIntoView());
    return true;
  };
}

function setHeading(level: number) {
  return (host: CommandHost): boolean => {
    const { view, schema } = host;
    const heading = node(schema, 'heading');
    const current = view.state.selection.$from.parent;
    if (current.type === heading && current.attrs['level'] === level) {
      return run(host, setBlockType(node(schema, 'paragraph')));
    }
    return run(host, setBlockType(heading, { level }));
  };
}

function toggleList(name: 'bullet_list' | 'ordered_list') {
  return (host: CommandHost): boolean => {
    const { view, schema } = host;
    const list = node(schema, name);
    const item = node(schema, 'list_item');
    const inside = ancestor(view, [list]);
    if (inside) return run(host, liftListItem(item));
    return run(host, wrapInList(list));
  };
}

/**
 * The cycle of `editor:task`, per list item the selection touches (as the lines are in Source): a plain
 * item becomes an open task, an open task a done one, and a done task, or a custom state (`[/]`), a plain
 * item again. Outside a list the lines become a list first.
 */
function toggleTask(host: CommandHost): boolean {
  const { view, schema } = host;
  const item = node(schema, 'list_item');
  const bullet = node(schema, 'bullet_list');
  const ordered = node(schema, 'ordered_list');
  if (!ancestor(view, [bullet, ordered])) run(host, wrapInList(bullet));
  const { from, to } = view.state.selection;
  const items: number[] = [];
  view.state.doc.nodesBetween(from, to, (n, pos) => {
    if (n.type === item) items.push(pos);
    return true;
  });
  if (items.length === 0) return false;
  const tr = view.state.tr;
  // from the last one: a task that loses its `[/] ` shifts the ones after it, not the ones before
  for (const pos of items.reverse()) cycleTask(tr, pos);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function toggleQuote(host: CommandHost): boolean {
  const { view, schema } = host;
  const quote = node(schema, 'blockquote');
  if (ancestor(view, [quote])) return run(host, lift);
  return run(host, wrapIn(quote));
}

/** A block of its own after the one the caret is in; it takes the place of an empty paragraph. */
function insertBlock(host: CommandHost, block: PMNode, caretInside: number): boolean {
  const { view } = host;
  const { $from } = view.state.selection;
  const top = $from.depth > 0 ? $from.before(1) : $from.pos;
  const parent = $from.depth > 0 ? $from.node(1) : null;
  const emptyParagraph = parent?.isTextblock && parent.content.size === 0;
  const tr = view.state.tr;
  const at = emptyParagraph ? top : top + (parent?.nodeSize ?? 0);
  if (emptyParagraph && parent) tr.replaceWith(top, top + parent.nodeSize, block);
  else tr.insert(at, block);
  tr.setSelection(TextSelection.create(tr.doc, at + 1 + caretInside));
  view.dispatch(tr.scrollIntoView());
  return true;
}

function insertCallout(host: CommandHost): boolean {
  const { schema } = host;
  // with the blank before the caret, as Source writes it (`> [!note] |`): the title is typed after it
  const head = '[!note] ';
  const quote = node(schema, 'blockquote').create(
    null,
    node(schema, 'paragraph').create(null, schema.text(head)),
  );
  // the caret is in the paragraph of the quote, after the head and its blank
  return insertBlock(host, quote, 1 + head.length);
}

function insertCodeBlock(host: CommandHost): boolean {
  const { schema } = host;
  return insertBlock(host, node(schema, 'code_block').create(), 0);
}

function insertMath(host: CommandHost): boolean {
  const { schema } = host;
  return insertBlock(
    host,
    node(schema, 'code_block').create({ language: 'LaTeX', form: 'math' }),
    0,
  );
}

/** A rule below the block the caret is in; the caret goes below the rule. */
function insertRule(host: CommandHost): boolean {
  const { view, schema } = host;
  const { $from } = view.state.selection;
  const top = $from.depth > 0 ? $from.before(1) : $from.pos;
  const parent = $from.depth > 0 ? $from.node(1) : null;
  const empty = parent?.isTextblock && parent.content.size === 0;
  const rule = node(schema, 'hr').create();
  const tr = view.state.tr;
  const at = empty ? top : top + (parent?.nodeSize ?? 0);
  if (empty && parent) tr.replaceWith(top, top + parent.nodeSize, rule);
  else tr.insert(at, rule);
  const after = at + rule.nodeSize;
  // below the rule there is always a paragraph to type in
  if (after >= tr.doc.content.size || tr.doc.resolve(after).nodeAfter?.isTextblock !== true) {
    tr.insert(after, node(schema, 'paragraph').create());
  }
  tr.setSelection(Selection.near(tr.doc.resolve(after), 1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

function clearFormatting(host: CommandHost): boolean {
  const { view, schema } = host;
  const { $from, $to } = view.state.selection;
  const from = $from.start();
  const to = $to.end();
  const tr = view.state.tr.removeMark(from, to);
  view.dispatch(tr);
  const { $from: now } = view.state.selection;
  if (
    now.parent.type !== node(schema, 'paragraph') &&
    now.parent.isTextblock &&
    now.parent.type !== node(schema, 'code_block')
  ) {
    run(host, setBlockType(node(schema, 'paragraph')));
  }
  return true;
}

export const COMMANDS: Record<EditorCommand, (host: CommandHost) => boolean> = {
  bold: toggle('strong'),
  italic: toggle('emphasis'),
  strike: toggle('strike_through'),
  code: toggle('inlineCode'),
  highlight: toggle('ofm_highlight'),
  underline: wrapHtml('<u>', '</u>'),
  sub: wrapHtml('<sub>', '</sub>'),
  sup: wrapHtml('<sup>', '</sup>'),
  comment: toggleComment,
  link: (host) => {
    const { from, to } = host.view.state.selection;
    // an empty selection has nothing to link: a wikilink is what the Source mode makes there too
    if (from === to) return insertWikilink(false)(host);
    return toggle('link', { href: 'url', title: '' })(host);
  },
  wikilink: insertWikilink(false),
  embed: insertWikilink(true),
  'heading-1': setHeading(1),
  'heading-2': setHeading(2),
  'heading-3': setHeading(3),
  'heading-4': setHeading(4),
  'heading-5': setHeading(5),
  'heading-6': setHeading(6),
  bullet: toggleList('bullet_list'),
  numbered: toggleList('ordered_list'),
  quote: toggleQuote,
  task: toggleTask,
  callout: insertCallout,
  'code-block': insertCodeBlock,
  table: (host) => host.ctx().get(commandsCtx).call(insertTableCommand.key, { row: 2, col: 2 }),
  math: insertMath,
  separator: insertRule,
  clear: clearFormatting,
  'move-up': (host) => run(host, moveBlock(-1)),
  'move-down': (host) => run(host, moveBlock(1)),
  undo: (host) => run(host, undo),
  redo: (host) => run(host, redo),
};
