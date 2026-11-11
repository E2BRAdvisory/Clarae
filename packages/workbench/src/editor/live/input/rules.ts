// What the user types that the file reads as Obsidian syntax (A-W5b): `[[Note]]`, `![[embed]]`, `#tag`,
// `==highlight==`, `%%comment%%`, a trailing `^id` and `[text](url)` become the node or mark the file
// would give them. Without that the text stays plain text, and the serializer escapes plain text that
// looks like a construct (`\[[x]]`, `\#tag`: the escape invariant of the layer), so a note typed in Live
// would lose its links and tags when it is written. Each rule is an input rule of ProseMirror: it acts
// when the last character of the construct is typed, and one Backspace takes it back.
//
// The wikilink node also has two keys of its own: `]` leaves the node (the way the closing brackets are
// typed over in a text editor), and Backspace in an empty one deletes it.
import { isValidTag } from '@memobrain/markdown';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import type { MarkType, Node as PMNode, ResolvedPos } from '@milkdown/kit/prose/model';
import {
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { $inputRule, $prose } from '@milkdown/kit/utils';
import { isUserEdit } from '../userEdit';
import {
  blockIdSchema,
  highlightSchema,
  rawInlineSchema,
  tagSchema,
  wikilinkSchema,
} from '../ofm/nodes';

/** Whether `[from, to)` is plain text (no atom, no node inside a textblock, no code) the rules can count characters in. */
export function plainText(doc: PMNode, from: number, to: number): boolean {
  let ok = true;
  doc.nodesBetween(from, to, (node) => {
    if (!ok) return false;
    if (node.isInline && !node.isText) ok = false;
    else if (node.isText && node.marks.some((m) => m.type.spec.code)) ok = false;
    return ok;
  });
  return ok;
}

/** Whether `$pos` is in a cell of a table, where neither a line end nor a bar can be written as it is. */
export function inCell($pos: ResolvedPos): boolean {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name.startsWith('table')) return true;
  }
  return false;
}

/** The text of a wikilink as a cell holds it: a bar is `\|`, as the file has it (`[[a\|b]]`). */
export const cellWikilinkText = (text: string): string => text.replace(/(?<!\\)\|/g, '\\|');

/** The character being typed at `pos` is inside a code span. */
function inCode(state: EditorState, pos: number): boolean {
  return (state.storedMarks ?? state.doc.resolve(pos).marks()).some((m) => m.type.spec.code);
}

/** What the typed text of a rule's match is: the part of the match that is not in the document yet. */
const typedOf = (match: RegExpMatchArray, start: number, end: number): string =>
  match[0].slice(end - start);

// ---- [[wikilink]] and ![[embed]] ------------------------------------------------------------------------

export const WIKILINK_TYPED = /(!?)\[\[([^[\]\n]+)\]\]$/;

export const wikilinkRule = $inputRule((ctx) => {
  const type = wikilinkSchema.type(ctx);
  return new InputRule(WIKILINK_TYPED, (state, match, start, end) => {
    // a text that came whole is longer than the construct it ends in: the match does not start in the document
    if (start > end) return null;
    if (!plainText(state.doc, start, end) || inCode(state, end)) return null;
    // a cell holds the bar of `[[a|b]]` as `\|`: written bare, it would end the cell
    const name = match[2] ?? '';
    const text = inCell(state.doc.resolve(end)) ? cellWikilinkText(name) : name;
    const node = type.create({ embed: match[1] === '!' }, state.schema.text(text));
    const tr = state.tr.replaceWith(start, end, node);
    return tr.setSelection(TextSelection.create(tr.doc, start + node.nodeSize));
  });
});

// ---- #tag and the trailing ^id ----------------------------------------------------------------------------

export const TAG_TYPED = /(?:^|[\s([{,;])#([\p{L}\p{N}_\-/]+)$/u;

export const tagRule = $inputRule((ctx) => {
  const mark = tagSchema.type(ctx);
  return new InputRule(TAG_TYPED, (state, match, start, end) => {
    // a text that came whole is longer than the construct it ends in: the match does not start in the document
    if (start > end) return null;
    if (!isValidTag(match[1] ?? '') || !plainText(state.doc, start, end) || inCode(state, end))
      return null;
    const typed = typedOf(match, start, end);
    const hash = start + match[0].indexOf('#');
    const tr = state.tr.insertText(typed, end);
    // the characters that follow are typed outside the mark: the rule extends it as long as they are tag characters
    return tr.addMark(hash, end + typed.length, mark.create());
  });
});

export const BLOCK_ID_TYPED = /\s\^([A-Za-z0-9-]+)$/;

export const blockIdRule = $inputRule((ctx) => {
  const mark = blockIdSchema.type(ctx);
  return new InputRule(BLOCK_ID_TYPED, (state, match, start, end) => {
    // a text that came whole is longer than the construct it ends in: the match does not start in the document
    if (start > end) return null;
    const $end = state.doc.resolve(end);
    // an id is the last thing of its block
    if ($end.parentOffset !== $end.parent.content.size || !$end.parent.isTextblock) return null;
    if (!plainText(state.doc, start, end) || inCode(state, end)) return null;
    const typed = typedOf(match, start, end);
    const caret = start + match[0].indexOf('^');
    const tr = state.tr.insertText(typed, end);
    return tr.addMark(caret, end + typed.length, mark.create());
  });
});

// ---- ==highlight== and %%comment%% --------------------------------------------------------------------------

export const HIGHLIGHT_TYPED = /(?<!=)==(?=[^\s=])([^=\n]*[^\s=])==$/;

export const highlightRule = $inputRule((ctx) => {
  const mark: MarkType = highlightSchema.type(ctx);
  return new InputRule(HIGHLIGHT_TYPED, (state, match, start, end) => {
    // a text that came whole is longer than the construct it ends in: the match does not start in the document
    if (start > end) return null;
    const content = match[1] ?? '';
    if (!plainText(state.doc, start, end) || inCode(state, end)) return null;
    const stored = state.storedMarks ?? [];
    const tr = state.tr.delete(end - 1, end).delete(start, start + 2);
    tr.addMark(start, start + content.length, mark.create());
    return tr.setStoredMarks(stored);
  });
});

export const COMMENT_TYPED = /%%([^%\n]+)%%$/;

export const commentRule = $inputRule((ctx) => {
  const type = rawInlineSchema.type(ctx);
  return new InputRule(COMMENT_TYPED, (state, match, start, end) => {
    // a text that came whole is longer than the construct it ends in: the match does not start in the document
    if (start > end) return null;
    if (!plainText(state.doc, start, end) || inCode(state, end)) return null;
    const node = type.create({ raw: match[0] });
    const tr = state.tr.replaceWith(start, end, node);
    return tr.setSelection(TextSelection.create(tr.doc, start + node.nodeSize));
  });
});

// ---- [text](url) ------------------------------------------------------------------------------------------

export const LINK_TYPED = /(?<!!)\[([^\][\n]+)\]\(([^)\s]+)\)$/;

/**
 * Turns the `[text](url)` that ends at `end` in the document of `tr` into the text with a link mark;
 * null when there is none, when it is not plain text, or when the text already is a link. Shared by the
 * input rule (the closing parenthesis has just been added to `tr`) and by typing over an auto-paired
 * one (autopair.ts).
 */
export function linkFromText(tr: Transaction, end: number): Transaction | null {
  const mark = tr.doc.type.schema.marks['link'];
  if (!mark) return null;
  const $end = tr.doc.resolve(end);
  const before = $end.parent.textBetween(0, $end.parentOffset, undefined, '\ufffc');
  const m = LINK_TYPED.exec(before);
  if (!m) return null;
  const start = end - m[0].length;
  const text = m[1] ?? '';
  const textEnd = start + 1 + text.length;
  if (!plainText(tr.doc, start, end)) return null;
  if (tr.doc.rangeHasMark(start + 1, textEnd, mark)) return null;
  tr.delete(textEnd, end).delete(start, start + 1);
  tr.addMark(start, start + text.length, mark.create({ href: m[2] ?? '', title: null }));
  // what is typed next is not part of the link
  const here = tr.doc.resolve(start + text.length).marks();
  return tr.setStoredMarks(here.filter((x) => x.type !== mark));
}

export const linkRule = $inputRule(
  () =>
    new InputRule(LINK_TYPED, (state, _match, start, end) => {
      if (start > end || inCode(state, end)) return null;
      return linkFromText(state.tr.insertText(')', end), end + 1);
    }),
);

/**
 * Whether the name of a wikilink takes `text` between `before` and `after`: a `[` is no part of a name
 * (`[[a[b]]` is no link for the file either), and neither is what would open a comment (`%%`) or a math
 * span (`$$`, or the pair of an inline formula) at the level of the file, where the link is then nothing.
 * The rule of the keys typed in the name (the wikilink node below) and of the text pasted in it (paste.ts).
 */
export function nameTakes(before: string, text: string, after: string): boolean {
  if (text.includes('[')) return false;
  return !/%%|\$\$|\$(?!\s)[^$]*[^\s$]\$/.test(before + text + after);
}

// ---- the keys of the wikilink node -----------------------------------------------------------------------

const wikilinkKeyKey = new PluginKey('memobrain-wikilink-keys');

/**
 * `]` in a wikilink leaves it (the second one, typed right after, is not typed either: the two closing
 * brackets are what the user types, the node has them already); in the middle of the text it is not
 * typed, since a bracket there would end the link. Backspace in an empty wikilink deletes it.
 */
export const wikilinkKeys = $prose((ctx) => {
  const type = wikilinkSchema.type(ctx);
  let exited: { doc: PMNode; pos: number } | null = null;
  return new Plugin({
    key: wikilinkKeyKey,
    props: {
      // The browser keeps the caret of a text it is typing in at the edge of a wikilink in the wrong place
      // (the end of the text in front of an empty one, which has no text node to hold it; the inside of
      // the node, for a caret just after it or just before it), so what is typed there would end up in
      // the wrong place. So the key is handled here, as ProseMirror does when the browser cannot be left
      // to it: the character goes where the editor's selection is.
      handleKeyPress(view, event) {
        const { selection } = view.state;
        const { $from } = selection;
        if (!selection.empty) return false;
        const at =
          $from.parent.type === type
            ? $from.parent.content.size === 0
            : $from.nodeBefore?.type === type || $from.nodeAfter?.type === type;
        if (!at || !event.charCode || event.ctrlKey || event.metaKey) return false;
        const text = String.fromCodePoint(event.charCode);
        if (/[\r\n]/.test(text)) return false;
        const { from, to } = selection;
        const taken = view.someProp('handleTextInput', (f) =>
          f(view, from, to, text, () => view.state.tr.insertText(text, from, to)),
        );
        if (!taken) view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
        return true;
      },
      handleTextInput(view, from, to, text) {
        // `%%` and `$$` in the name would open a comment or a math span at the file's level, where the
        // link is then nothing (the index reads the first construct that opens): the character that
        // would make them is not typed, as the `]` that would end the link is not (nor the `$` that would
        // close an inline formula: the rule of the formula would cut the node in two around it)
        if (/[%$[]/.test(text)) {
          const $at = view.state.doc.resolve(from);
          if ($at.parent.type === type) {
            const label = $at.parent;
            if (
              !nameTakes(
                label.textBetween(0, $at.parentOffset),
                text,
                label.textBetween(view.state.doc.resolve(to).parentOffset, label.content.size),
              )
            ) {
              return true;
            }
          }
        }
        if (text !== ']') return false;
        const { state } = view;
        if (!state.selection.empty) return false;
        const $from = state.doc.resolve(from);
        if ($from.parent.type === type) {
          if ($from.parentOffset === $from.parent.content.size) {
            const after = Selection.near(state.doc.resolve($from.after()), 1);
            view.dispatch(state.tr.setSelection(after));
            exited = { doc: view.state.doc, pos: view.state.selection.from };
          }
          return true;
        }
        if (exited && exited.doc === state.doc && exited.pos === from) {
          exited = null;
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        keydown(view, event) {
          if (event.key !== 'Backspace' || event.isComposing) return false;
          const { selection } = view.state;
          const { $from } = selection;
          if (!selection.empty || $from.parent.type !== type) return false;
          if ($from.parent.content.size !== 0) return false;
          event.preventDefault();
          view.dispatch(view.state.tr.delete($from.before(), $from.after()).scrollIntoView());
          return true;
        },
      },
    },
  });
});

const mathKeyKey = new PluginKey('memobrain-math-fence');

/** The ranges of the document that `trs` changed, in the coordinates of the document they left. */
function changedRanges(trs: readonly Transaction[]): [number, number][] {
  let ranges: [number, number][] = [];
  for (const tr of trs) {
    ranges = ranges.map(([a, b]) => [tr.mapping.map(a, -1), tr.mapping.map(b, 1)]);
    tr.mapping.maps.forEach((map, i) => {
      const rest = tr.mapping.slice(i + 1);
      map.forEach((_a, _b, from, to) => ranges.push([rest.map(from, -1), rest.map(to, 1)]));
    });
  }
  return ranges;
}

/**
 * A `$$` is not written in a math block: the file would write the block with a longer fence (`$$$`) that the
 * index does not read (the links after it are lost), and, in a line of its own, it ends the block. Where an
 * edit leaves the content of a math block with two `$` in a row, the ones after the first are taken away:
 * the character is not typed, as the `%` that would make the `%%` of the name of a wikilink is not. The
 * block is edited in a code editor of its own, which the text typed in it reaches the document through, so
 * the check is on the document and on the blocks the edit touched (a note is never changed by being opened).
 */
export const mathKeepsItsFence = $prose(
  () =>
    new Plugin({
      key: mathKeyKey,
      appendTransaction: (trs, _old, state) => {
        // an edit by the user only: the reload of a file that came from outside is not changed by this
        if (!trs.some(isUserEdit)) return null;
        const deletions: [number, number][] = [];
        for (const [from, to] of changedRanges(trs)) {
          const size = state.doc.content.size;
          state.doc.nodesBetween(Math.min(from, size), Math.min(to, size), (node, pos) => {
            if (node.type.name !== 'code_block' || node.attrs['form'] !== 'math') return true;
            for (const m of node.textContent.matchAll(/\${2,}/g)) {
              const at = pos + 1 + m.index + 1;
              if (!deletions.some(([a]) => a === at)) deletions.push([at, at + m[0].length - 1]);
            }
            return false;
          });
        }
        if (deletions.length === 0) return null;
        const tr = state.tr;
        // the last first: what precedes keeps its place
        for (const [a, b] of deletions.sort((x, y) => y[0] - x[0])) tr.delete(a, b);
        return tr;
      },
    }),
);

const wikilinkEnterKey = new PluginKey('memobrain-wikilink-enter');

/**
 * Enter in the name of a wikilink ends the link: the caret goes after the node. A block split there
 * (the default of the editor) would cut the node in two, or leave an empty one: `[[a]]` and `[[b]]`
 * for `[[ab]]`, or `[[]]` at its edge. Installed after the suggestions, which take the Enter that
 * chooses a candidate before this one sees it.
 */
export const wikilinkEnter = $prose((ctx) => {
  const type = wikilinkSchema.type(ctx);
  return new Plugin({
    key: wikilinkEnterKey,
    props: {
      handleDOMEvents: {
        keydown(view, event) {
          if (event.key !== 'Enter' || event.isComposing) return false;
          if (event.ctrlKey || event.metaKey || event.altKey) return false;
          const { $from, $to, empty } = view.state.selection;
          if (!empty || $from.parent.type !== type || $to.parent !== $from.parent) return false;
          event.preventDefault();
          view.dispatch(
            view.state.tr.setSelection(Selection.near(view.state.doc.resolve($from.after()), 1)),
          );
          return true;
        },
      },
    },
  });
});

export const ofmInputRules = [
  wikilinkRule,
  tagRule,
  blockIdRule,
  highlightRule,
  commentRule,
  linkRule,
  wikilinkKeys,
  mathKeepsItsFence,
].flat();
