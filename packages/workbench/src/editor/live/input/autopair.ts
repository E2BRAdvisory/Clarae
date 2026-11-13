// The `autoPair` setting in Live: an opening bracket or quote is typed with its closing one, a closing
// character typed in front of the one that was added is typed over, a selection is wrapped, and
// Backspace between a pair takes both. It is what CodeMirror's `closeBrackets` does in Source, with
// the two differences the document makes: a code block (an editor of its own) and inline code are left
// alone, and a second `[` in front of an added `]` makes an empty wikilink node, with the caret in it
// (the node has its own closing brackets: `rules.ts`).
import type { ResolvedPos } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';
import { wikilinkSchema } from '../ofm/nodes';
import { bulk } from './bulk';
import { refFromText } from './refs';
import { linkFromText } from './rules';

/** The pairs (the backtick is left to the input rule of inline code, which needs to see the closing one typed). */
const PAIRS: Readonly<Record<string, string>> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
};
const CLOSERS = new Set(Object.values(PAIRS));
/** A closing character is added in front of these (and the end, and whitespace), as CodeMirror does. */
const BEFORE = ')]}:;>';
const WORD = /[\p{L}\p{N}]/u;
const MAX_TRACKED = 64;

interface Meta {
  add?: number;
  remove?: number;
}

const key = new PluginKey<number[]>('clarae-autopair');

const charBefore = ($pos: ResolvedPos): string =>
  $pos.parent.textBetween(Math.max(0, $pos.parentOffset - 1), $pos.parentOffset, undefined, '￼');
const charAfter = ($pos: ResolvedPos): string =>
  $pos.parent.textBetween(
    $pos.parentOffset,
    Math.min($pos.parent.content.size, $pos.parentOffset + 1),
    undefined,
    '￼',
  );

/** Where a pair is not added: a code block, inline code, and what is not text. */
function plain(state: EditorState, $pos: ResolvedPos): boolean {
  if (!$pos.parent.inlineContent || $pos.parent.type.spec.code) return false;
  if ($pos.parent.type.name === 'ofm_wikilink') return false;
  return !(state.storedMarks ?? $pos.marks()).some((m) => m.type.spec.code);
}

export interface AutoPairOptions {
  /** The `autoPair` setting of the editor, read at every key. */
  enabled(): boolean;
  readOnly(): boolean;
}

export const autoPair = (o: AutoPairOptions) =>
  $prose((ctx) => {
    const wikilink = wikilinkSchema.type(ctx);
    return new Plugin<number[]>({
      key,
      state: {
        init: () => [],
        apply(tr, value) {
          let next = value;
          if (tr.docChanged) {
            next = next.flatMap((p) => {
              const r = tr.mapping.mapResult(p, 1);
              return r.deletedAfter ? [] : [r.pos];
            });
          }
          const meta = tr.getMeta(key) as Meta | undefined;
          if (meta?.remove !== undefined) next = next.filter((p) => p !== meta.remove);
          if (meta?.add !== undefined) next = [...next, meta.add].slice(-MAX_TRACKED);
          return next;
        },
      },
      props: {
        handleTextInput(view, from, to, text) {
          if (text.length !== 1 || bulk.active || !o.enabled() || o.readOnly()) return false;
          const { state } = view;
          const tracked = key.getState(state) ?? [];
          const $from = state.doc.resolve(from);
          if (!plain(state, $from)) return false;

          // a closing character in front of the one that was added: typed over
          if (
            CLOSERS.has(text) &&
            from === to &&
            charAfter($from) === text &&
            tracked.includes(from)
          ) {
            const tr = state.tr
              .setSelection(TextSelection.create(state.doc, from + 1))
              .setMeta(key, { remove: from } satisfies Meta);
            // `[text](url)` completed by typing over its closing parenthesis becomes the link
            const linked = text === ')' ? linkFromText(tr, from + 1) : null;
            // `[^1]` and `[text][ref]` completed by typing over their last bracket are the reference
            const ref = text === ']' ? refFromText(tr, from + 1) : null;
            view.dispatch((linked ?? ref ?? tr).scrollIntoView());
            return true;
          }

          const close = PAIRS[text];
          if (close === undefined) return false;

          // a selection is wrapped, and stays selected
          if (from !== to) {
            if (!$from.sameParent(state.doc.resolve(to))) return false;
            const tr = state.tr.insertText(close, to).insertText(text, from);
            view.dispatch(
              tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1)).scrollIntoView(),
            );
            return true;
          }

          // `[[`: the second one turns the pair `[]` into an empty wikilink, the caret inside
          if (
            text === '[' &&
            charBefore($from) === '[' &&
            charAfter($from) === ']' &&
            tracked.includes(from)
          ) {
            const embed =
              $from.parent.textBetween(
                Math.max(0, $from.parentOffset - 2),
                $from.parentOffset - 1,
                undefined,
                '￼',
              ) === '!';
            const start = from - 1 - (embed ? 1 : 0);
            const tr = state.tr
              .replaceWith(start, from + 1, wikilink.create({ embed }))
              .setMeta(key, { remove: from } satisfies Meta);
            view.dispatch(
              tr.setSelection(TextSelection.create(tr.doc, start + 1)).scrollIntoView(),
            );
            return true;
          }

          const next = charAfter($from);
          if (next !== '' && !/\s/.test(next) && !BEFORE.includes(next)) return false;
          if (close === text) {
            // quotes: not after a word (an apostrophe), not a third one
            const prev = charBefore($from);
            if (WORD.test(prev) || prev === text) return false;
          }
          const tr = state.tr.insertText(text + close, from, to);
          tr.setSelection(TextSelection.create(tr.doc, from + 1));
          tr.setMeta(key, { add: from + 1 } satisfies Meta);
          view.dispatch(tr.scrollIntoView());
          return true;
        },
        handleDOMEvents: {
          keydown(view, event) {
            if (event.key !== 'Backspace' || event.isComposing || event.ctrlKey || event.metaKey)
              return false;
            if (event.altKey || !o.enabled() || o.readOnly()) return false;
            const { state } = view;
            const { selection } = state;
            if (!selection.empty) return false;
            const $from = selection.$from;
            if (!plain(state, $from)) return false;
            const prev = charBefore($from);
            if (PAIRS[prev] === undefined || charAfter($from) !== PAIRS[prev]) return false;
            event.preventDefault();
            view.dispatch(state.tr.delete(selection.from - 1, selection.from + 1).scrollIntoView());
            return true;
          },
        },
      },
    });
  });
